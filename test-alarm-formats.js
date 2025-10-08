#!/usr/bin/env node
// Fast OFF alarm: set RTC = now, write EFFECT_TIMER table with an OFF at the next minute,
// wait until next minute + 10s. Single connection, correct ATT modes.

import noble from '@abandonware/noble';
import minimist from 'minimist';
import fs from 'fs';

const argv = minimist(process.argv.slice(2));

// How many minutes ahead to schedule the OFF alarm.
// Default is 2 to ensure we finish writes/commits before the boundary.
const offsetMin = Number.isFinite(Number(argv['offset-min']))
  ? Number(argv['offset-min'])
  : 2;

const rrArg = argv.rr; // e.g. --rr 0xFE or --rr 0x86
import { setTimeout as delay } from 'timers/promises';

// ---- Extra headers for power/status helpers (same family as lednet.js)
const h = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const dryRun = !!argv['dry-run'];
const replayArg = argv.replay; // e.g. --replay all  or  --replay effect_table_06_seq06,effect_table_07_seq07
const seriesArg = argv.series; // e.g. --series 06-09 | 09
const patchHHMM = argv['patch-hhmm']; // e.g. --patch-hhmm 16:09
const patchRR = argv['patch-rr']; // e.g. --patch-rr 0xFE
const rawPath = argv.raw || './raw-packets.json'; // <-- use local path by default
const reseq = argv.reseq !== '0'; // normalize seq + fix checksum on replay (default: on)
let seq = 1;

const HEADERS = {
  EFFECT_TIMER: h('80000058590B'),
  BASIC_TIMER: h('8000000C0D0B'), // RTC set
  PRELUDE: h('80000005060A'), // vendor prelude (send as REQ!)
  INFO: h('80000004050A'), // request settings/status (REQ)
  POWER: h('8000000D0E0B3B'), // power command family
  RGB: h('80000008090B31'), // rgb command family (optional)
};

// Always use Write With Response on FF01.
function attMode() {
  return 'req';
} // force with-response for all app frames

function pkt(header, payload) {
  // For timer blobs: device expects CHK = sum(payload) & 0xFF
  const chk = payload.reduce((a, b) => (a + b) & 0xff, 0);
  return Buffer.concat([
    Buffer.from([0, seq & 0xff]),
    header,
    payload,
    Buffer.from([chk]),
  ]);
}

function sum8(buf) {
  return buf.reduce((a, b) => (a + b) & 0xff, 0);
}

function sendRawFrame(tx, rawBuf) {
  // Optionally re-sequence and fix checksum (payload-sum) so seq is monotonic in this session.
  let frame = Buffer.from(rawBuf);
  if (reseq) {
    const seqByte = seq & 0xff;
    frame[1] = seqByte; // set new seq
    const payload = frame.slice(2 + 6, frame.length - 1);
    const chk = sum8(payload);
    frame[frame.length - 1] = chk;
  }
  // Always write with response (false)
  return tx.writeAsync(frame, false);
}

function rtcPayload(d) {
  const YY = d.getFullYear() - 2000,
    MM = d.getMonth() + 1,
    DD = d.getDate();
  const HH = d.getHours(),
    MI = d.getMinutes(),
    SS = d.getSeconds();
  const DOW = (d.getDay() || 7) & 0xff; // 1..7
  return Buffer.from([0x10, 0x14, YY, MM, DD, HH, MI, SS, DOW, 0x00, 0x0f]);
}

function whenPoweredOn() {
  return new Promise((resolve) => {
    if (noble.state === 'poweredOn') return resolve();
    noble.once('stateChange', (s) => {
      if (s === 'poweredOn') resolve();
    });
  });
}

async function findDevice(deviceId) {
  return new Promise((resolve, reject) => {
    let found = false;
    const timeout = setTimeout(() => {
      if (!found) {
        noble.stopScanning();
        reject(new Error('Device not found after 15 seconds'));
      }
    }, 15000);

    const onDiscover = (peripheral) => {
      if (found) return;
      const id = peripheral.id.toLowerCase();
      const targetId = deviceId.toLowerCase().replace(/:/g, '');
      if (id === targetId) {
        found = true;
        clearTimeout(timeout);
        noble.stopScanning();
        noble.removeListener('discover', onDiscover);
        resolve(peripheral);
      }
    };

    noble.on('discover', onDiscover);
    (async () => {
      await whenPoweredOn();
      noble.stopScanning();
      setTimeout(() => noble.startScanning([], false), 200);
    })().catch(() => {});
  });
}

async function connectAndSubscribe(peripheral) {
  console.log(
    `🔗 Connecting to ${peripheral.advertisement.localName || peripheral.id}…`,
  );
  await peripheral.connectAsync();
  const services = await peripheral.discoverServicesAsync([]);
  let txChar = null;
  let rxChar = null;
  for (const service of services) {
    const characteristics = await service.discoverCharacteristicsAsync([]);
    if (!txChar)
      txChar = characteristics.find(
        (c) => c.uuid.toLowerCase().replace(/-/g, '') === 'ff01',
      );
    if (!rxChar)
      rxChar = characteristics.find(
        (c) =>
          c.uuid.toLowerCase().replace(/-/g, '') === 'ff02' &&
          c.properties.includes('notify'),
      );
    if (txChar && rxChar) break;
  }
  if (!txChar) {
    await peripheral.disconnectAsync();
    throw new Error('TX characteristic FF01 not found');
  }
  return { tx: txChar, rx: rxChar };
}

async function connectOnce(id) {
  console.log('🔍 Scanning…');
  const peripheral = await findDevice(id);
  const { tx, rx } = await connectAndSubscribe(peripheral);
  if (rx) {
    await rx.subscribeAsync();
    rx.on('data', onRxData);
  }
  return { peripheral, tx };
}

// --- REPLAY MODE (from raw-packets.json) ---
function loadRawSteps() {
  const j = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  return Array.isArray(j.steps) ? j.steps : [];
}

function selectReplaySteps(steps) {
  if (replayArg === 'all') {
    // best-effort order similar to capture
    const order = [
      'device_info_query_seq01',
      'rtc_set_2025-10-04_16-55-33_seq02',
      'vendor_prelude_A_seq04',
      'vendor_prelude_B_seq05',
      'effect_table_06_seq06',
      'effect_table_07_seq07',
      'effect_table_08_seq08',
      'effect_table_09_seq09',
    ];
    return steps
      .filter((s) => order.includes(s.name))
      .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }
  if (seriesArg === '06-09') {
    return steps
      .filter((s) => /^effect_table_0[6-9]_seq0[6-9]$/.test(s.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  if (seriesArg === '09' || seriesArg === '09-only' || replayArg === '09') {
    return steps.filter((s) => s.name === 'effect_table_09_seq09');
  }
  if (typeof replayArg === 'string') {
    const want = replayArg.split(',').map((s) => s.trim());
    // allow both exact names and the new aliases from raw-packets.json
    // e.g. "alarm_off_18_58_su_mo_tu", "alarm_effect_yellow_strobe_19_05_tu_we_th_fr_sa"
    return steps.filter((s) => want.includes(s.name));
  }
  return [];
}

function maybePatchEffectPacket(rawHex, hh, mm, rr) {
  // rawHex format: "00:SEQ:HEADER(6B):payload...:CHK" (with colons)
  const bytes = hexToBuf(rawHex.replace(/:/g, ''));
  const headerHex = bytes.slice(2, 2 + 6).toString('hex');
  if (!headerHex.startsWith('80000058590b')) return bytes; // not an EFFECT packet
  // split: [00][seq][header][payload][chk]
  const payload = bytes.slice(2 + 6, bytes.length - 1);
  if (payload[0] !== 0x21) return bytes; // expect 0x21 prefix
  const stream = payload.slice(1);
  const patched = patchFirstOffInStream(stream, hh, mm, rr);
  if (!patched) return bytes;
  const newPayload = Buffer.concat([Buffer.from([0x21]), patched]);
  const newChk = sum8(newPayload);
  // rebuild: 00 seq | header | newPayload | chk
  return Buffer.concat([
    bytes.slice(0, 2),
    bytes.slice(2, 2 + 6),
    newPayload,
    Buffer.from([newChk]),
  ]);
}

async function runReplay(deviceId) {
  const { tx } = await connectOnce(deviceId);
  const steps = loadRawSteps();
  const chosen = selectReplaySteps(steps);
  if (!chosen.length) {
    console.log(
      '⚠️  No steps selected for replay. Use --replay all | --series 06-09 | --replay name1,name2',
    );
    return;
  }
  const hhmm =
    typeof patchHHMM === 'string' && /^\d{1,2}:\d{2}$/.test(patchHHMM)
      ? patchHHMM.split(':').map((n) => parseInt(n, 10))
      : null;
  const rrNum =
    typeof patchRR === 'string' && patchRR.startsWith('0x')
      ? parseInt(patchRR, 16)
      : typeof patchRR === 'number'
        ? patchRR
        : undefined;
  const targetHHMM = hhmm ? { hh: hhmm[0], mm: hhmm[1] } : null;

  for (const s of chosen) {
    const rawHex = s.packet.replace(/[^0-9a-f:]/gi, '');
    let buf = hexToBuf(rawHex.replace(/:/g, ''));
    if (hhmm && /^effect_table_0[6-9]_seq0[6-9]$/.test(s.name)) {
      buf = maybePatchEffectPacket(rawHex, hhmm[0], hhmm[1], rrNum);
    }
    const headerHex = buf.slice(2, 2 + 6).toString('hex');
    const mode = headerHex.startsWith('8000000c0d0b') ? 'REQ' : 'CMD';
    // If reseq is on, print the to-be-sent frame (after seq/chk adjust) for transparency
    let frameToSend = Buffer.from(buf);
    if (reseq) {
      const seqByte = seq & 0xff;
      frameToSend[1] = seqByte;
      const payload = frameToSend.slice(2 + 6, frameToSend.length - 1);
      frameToSend[frameToSend.length - 1] = sum8(payload);
    }
    console.log(
      `📦 ${mode} ${frameToSend.length}B [${s.name}]: ${frameToSend.toString('hex')}`,
    );
    if (!dryRun) await sendRawFrame(tx, frameToSend);
    seq = (seq + 1) & 0xff;
    // After any EFFECT write, wait for a fresh 0F22 dump and print acceptance vs target
    if (headerHex.startsWith('80000058590b')) {
      lastEffectDump = null;
      await waitForEffectDump(800);
      if (targetHHMM && lastEffectDump) {
        const f = parseFirstOffFromDumpHex(lastEffectDump);
        if (f) {
          const ok =
            f.hh === (targetHHMM.hh & 0xff) && f.mm === (targetHHMM.mm & 0xff);
          console.log(
            ok
              ? '✅ ACCEPTED (first OFF matches target HH:MM)'
              : '❌ NOT APPLIED (first OFF differs)',
          );
        }
      }
    }
  }
  // Optional wait: if we patched HH:MM, wait until that minute +10s to verify behavior
  if (targetHHMM) {
    const now = new Date();
    let target = new Date(now);
    target.setHours(targetHHMM.hh, targetHHMM.mm, 0, 0);
    if (target.getTime() - now.getTime() < 20000)
      target = new Date(target.getTime() + 60000);
    const waitMs = Math.max(target.getTime() + 10000 - Date.now(), 12000);
    console.log(
      `⏳ waiting ${(waitMs / 1000).toFixed(1)}s (until ${String(targetHHMM.hh).padStart(2, '0')}:${String(targetHHMM.mm).padStart(2, '0')}+10s)…`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
  }
  console.log('✅ Replay finished.');
}

// --- RX parser and EFFECT dump capture ---
let lastEffectDump = null; // hex string of stream that follows 0F22 (without 0F22)
function parseFirstOffFromDumpHex(hexStr) {
  try {
    const b = hexToBuf(hexStr);
    const i = b.indexOf(0xf0);
    if (i >= 0 && i + 8 < b.length) {
      return { hh: b[i + 4], mm: b[i + 5], rr: b[i + 7] };
    }
  } catch {}
  return null;
}
function onRxData(d) {
  try {
    const start = d.indexOf(0x7b); // '{'
    const end = d.lastIndexOf(0x7d); // '}'
    if (start !== -1 && end !== -1 && end > start) {
      const json = JSON.parse(d.slice(start, end + 1).toString('utf8'));
      const p = typeof json.payload === 'string' ? json.payload : '';
      console.log(`📥 RX JSON code=${json.code} payload=${p}`);
      // Capture EFFECT dump stream: payload begins with "0F22"
      if (p.startsWith('0F22') || p.startsWith('0f22')) {
        // strip "0F22", keep the rest as hex (no spaces)
        lastEffectDump = p.slice(4);
        const f = parseFirstOffFromDumpHex(lastEffectDump);
        if (f)
          console.log(
            `🧩 EFFECT dump first OFF hh=${f.hh} mm=${f.mm} rr=0x${f.rr.toString(16)}`,
          );
      }
      return;
    }
  } catch {}
  console.log(`📥 RX ${d.length}B ${d.toString('hex')}`);
}

async function waitForEffectDump(ms) {
  const until = Date.now() + ms;
  while (!lastEffectDump && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return lastEffectDump;
}

function patchFirstOffInStream(streamBuf, hh, mm, rr) {
  // find first 0xF0 record with HH at +4, MM at +5, RR at +7 (as in captures)
  const i = streamBuf.indexOf(0xf0);
  if (i < 0 || i + 8 >= streamBuf.length) return null;
  const s = Buffer.from(streamBuf);
  s[i + 4] = hh & 0xff;
  s[i + 5] = mm & 0xff;
  if (typeof rr === 'number') s[i + 7] = rr & 0xff;
  return s;
}

async function send(tx, header, payload) {
  const mode = attMode(header);
  const frame = pkt(header, payload);
  console.log(
    `📦 ${mode.toUpperCase()} ${frame.length}B: ${frame.toString('hex')}`,
  );
  if (!dryRun) await tx.writeAsync(frame, false);
  seq = (seq + 1) & 0xff;
}

// Returns the target minute boundary "offsetMin" minutes in the future.
function pickMinuteOffset(now, offsetMin) {
  // Add offset first, then snap to minute boundary: gives ~60..120s headroom at offset=2.
  const t = new Date(now.getTime() + offsetMin * 60_000);
  t.setSeconds(0, 0);
  return t;
}

// --- Build a single-slot EFFECT payload: absolute one-shot "OFF" via ABS-RGB with BR=0 ---
// Format per captures: F0 YY MM DD HH mm 00 00 BR R G B 00, then zeros to 87 bytes total.
function buildEffectPayload_absOffOneShot(date) {
  const YY = date.getFullYear() - 2000; // 00..99
  const MM = date.getMonth() + 1; // 1..12
  const DD = date.getDate(); // 1..31
  const HH = date.getHours();
  const mm = date.getMinutes();
  const slot = Buffer.from([
    0xf0,
    YY & 0xff,
    MM & 0xff,
    DD & 0xff,
    HH & 0xff,
    mm & 0xff,
    0x00,
    0x00, // reserved / flags as seen in ABS-RGB entries
    0x00, // BR = 0 (dark = OFF)
    0x00,
    0x00,
    0x00, // R,G,B = 0
    0x00, // tail as in captures
  ]);
  const out = Buffer.alloc(87, 0x00);
  slot.copy(out, 0);
  return out;
}

// Weekly OFF slot builder (existing simple_off_87 but with RR value we pass in)
function buildEffectPayload_weeklyOff(hh, mm, rr) {
  const out = Buffer.alloc(87, 0x00);
  out[0] = 0xf0;
  out[1] = 0x00; // YY=00 => weekly/relative form
  out[2] = 0x00; // MM=00
  out[3] = 0x00; // DD=00
  out[4] = hh & 0xff;
  out[5] = mm & 0xff;
  out[6] = 0x00; // seconds/reserved
  out[7] = rr & 0xff; // repeat code (use 0xFE to mimic "every day" as in capture)
  // remaining bytes stay zero
  return out;
}

function hexToBuf(hex) {
  return Buffer.from(hex.replace(/[^0-9a-f]/gi, ''), 'hex');
}

async function mainNextMinute(deviceId) {
  const { tx } = await connectOnce(deviceId);
  const now = new Date();
  now.setMilliseconds(0);
  const target = pickMinuteOffset(now, offsetMin); // HH:MM for the alarm (+offsetMin)
  const rr =
    typeof rrArg === 'string' && rrArg.startsWith('0x')
      ? parseInt(rrArg, 16)
      : typeof rrArg === 'number'
        ? rrArg
        : 0xfe; // default seen in capture

  console.log(
    `⏱ RTC = ${now.toTimeString().slice(0, 8)} → alarm at ${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')} (+${offsetMin}m, RR=${rr.toString(16)})`,
  );

  // 1) Sync RTC (REQ)
  await send(tx, HEADERS.BASIC_TIMER, rtcPayload(now));

  // 2) Prelude A + B (also as REQ)
  await send(tx, HEADERS.PRELUDE, h('222a2b0f'));
  await send(tx, HEADERS.PRELUDE, h('111a1b0f'));

  const hh = target.getHours();
  const mm = target.getMinutes();

  // 4) Write two slots: absolute one-shot OFF (+2m) and weekly OFF (RR=0xFE).
  const candidates = [];
  candidates.push([
    'abs_off_one_shot',
    buildEffectPayload_absOffOneShot(target),
  ]);
  const rrWeekly = 0xfe; // safer preset from captures ("every day") vs ambiguous 0x7F
  candidates.push([
    'weekly_off_rr_fe',
    buildEffectPayload_weeklyOff(hh, mm, rrWeekly),
  ]);

  for (const [name, payload] of candidates) {
    if (!payload) continue;
    const frame = pkt(HEADERS.EFFECT_TIMER, payload);
    console.log(`📦 REQ ${frame.length}B [${name}]: ${frame.toString('hex')}`);
    if (!dryRun) await tx.writeAsync(frame, false);
    seq = (seq + 1) & 0xff;
    // Commit nudge: Prelude B, then status
    await delay(180);
    await send(tx, HEADERS.PRELUDE, h('111a1b0f'));
    await delay(120);
  }

  // 5) Wait until the boundary + 10s
  const waitMs = target.getTime() + 10_000 - Date.now();
  const ms = Math.max(waitMs, 12_000);
  console.log(`⏳ waiting ${(ms / 1000).toFixed(1)}s (until target+10s)…`);
  await new Promise((r) => setTimeout(r, ms));
  console.log('⏱ done waiting.');
}

(async () => {
  process.on('unhandledRejection', (e) => {
    console.error('UnhandledRejection:', e?.stack || e);
    process.exit(1);
  });
  process.on('uncaughtException', (e) => {
    console.error('UncaughtException:', e?.stack || e);
    process.exit(1);
  });
  const id = argv.id || process.env.ID || 'bac743d03f1bf8a278a0f4e472f1771e';
  if (replayArg || seriesArg) await runReplay(id);
  else await mainNextMinute(id);
  process.exit(0);
})();
