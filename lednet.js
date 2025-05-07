#!/usr/bin/env node
/**
 * lednet.js – Control utility for the LEDnetWF V5 Bluetooth controller
 * Hardware batch 2023‑24, board label "46 CC", short‑packet firmware.
 *
 * Packet format (maximum length 21 bytes)
 * ---------------------------------------
 *   00 | SEQ | HEADER | PAYLOAD | CHK
 *
 *   SEQ – monotonic counter (second byte, wraps 0‑255).
 *   CHK – checksum value, calculated as:
 *          • Power ON/OFF frame (21 B):  CHK = (SEQ + 0x26) & 0xFF
 *          • RGB frame          (16 B):  CHK = (SEQ + 0x38) & 0xFF
 *
 * Headers
 * -------
 *   Power (ON 0x23 / OFF 0x24): 80 00 00 0D 0E 0B 3B <23|24>
 *   RGB:                        80 00 00 08 09 0B 31 <R> <G> <B> 00 00 0F
 *
 * All writes must be performed with **Write Request** semantics
 * (`writeAsync(buffer, false)`). CoreBluetooth silently drops Write Commands
 * longer than 20 bytes.
 *
 * Notifications on characteristic FF02 are optional. On macOS they need to be
 * enabled via `subscribeAsync()` (internally calls `setNotifyValue:`).
 *
 * Command‑line interface
 * ----------------------
 *   --on / --off                turn the strip on or off
 *   --rgb R,G,B                 set a solid RGB colour (0‑255)
 *   --id <peripheralId>         exact UUID reported by scan‑once.js
 *   --name <substring>          substring of the advertised localName (case‑insensitive)
 *   --discover-all              scan only and list every detected device
 *
 * Configuration is read from config.json when available.
 *
 * Tested with Node 20, macOS 15.5, noble @abandonware 1.9.2‑20.
 */

import noble from '@abandonware/noble';
import minimist from 'minimist';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const PROTOCOL = {
  POWER_HEADER: '80 00 00 0D 0E 0B 3B',
  RGB_HEADER: '80 00 00 08 09 0B 31',
  
  POWER_ON: 0x23,
  POWER_OFF: 0x24,
  
  POWER_CHECKSUM_BASE: 0x26,
  RGB_CHECKSUM_BASE: 0x38,
  
  RGB_TERMINATOR: [0x00, 0x00, 0x0f],
  POWER_PADDING_SIZE: 10,
  SEQUENCE_MASK: 0xff,
};

const BLE = {
  DEFAULT_TX_CHAR: 'ff01',
  DEFAULT_RX_CHAR: 'ff02',
  SERVICE_PATTERN: 'ffff', // Pattern for auto-discovery when service UUID not specified
};

const TIMING = {
  DISCOVER_TIMEOUT: 10_000,
  CONNECTION_TIMEOUT: 20_000,
};

const DEFAULT_CONFIG = {
  defaults: {
    rgb: '255,0,0',
  },
  ble: {
    service_uuid: null,
    tx_char_uuid: BLE.DEFAULT_TX_CHAR,
    rx_char_uuid: BLE.DEFAULT_RX_CHAR,
  },
  device: {
    id: null,
    name: null,
  },
};

// Configuration and setup functions
function loadConfig() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const configPath = join(__dirname, 'config.json');

  try {
    const userConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    return {
      defaults: { ...DEFAULT_CONFIG.defaults, ...userConfig.defaults },
      ble: { ...DEFAULT_CONFIG.ble, ...userConfig.ble },
      device: { ...DEFAULT_CONFIG.device, ...userConfig.device },
    };
  } catch (error) {
    return DEFAULT_CONFIG;
  }
}

function parseConfig(argv, config) {
  const wantedId = (argv.id || config.device?.id)?.toLowerCase();
  const wantedName = (argv.name || config.device?.name)?.toLowerCase();
  const mode = argv.off ? 'off' : argv.rgb !== undefined ? 'rgb' : 'on';

  const defaultRgb = config.defaults?.rgb || DEFAULT_CONFIG.defaults.rgb;
  const [red, green, blue] = (argv.rgb || defaultRgb)
    .split(',')
    .map((value) => Number(value) & PROTOCOL.SEQUENCE_MASK);

  return { wantedId, wantedName, mode, red, green, blue };
}

function validateDevice(wantedId, wantedName, discoverAll) {
  if (!wantedId && !wantedName && !discoverAll) {
    console.error('❌ No device specified. Either provide config.json or use --discover-all to scan.');
    process.exit(1);
  }

  if (!discoverAll) {
    console.log(`🎯 Looking for device: ${wantedId ? `ID="${wantedId}"` : ''}${wantedId && wantedName ? ' or ' : ''}${wantedName ? `Name="${wantedName}"` : ''}`);
  }
}

// Bluetooth functions
const findService = (services, serviceUuid) => (serviceUuid 
    ? services.find((s) => s.uuid === serviceUuid)
    : services.find((s) => s.uuid.startsWith(BLE.SERVICE_PATTERN)) || services[0]);

function findCharacteristics(characteristics, config) {
  const txUuid = config.ble?.tx_char_uuid || BLE.DEFAULT_TX_CHAR;
  const rxUuid = config.ble?.rx_char_uuid || BLE.DEFAULT_RX_CHAR;
  
  return {
    tx: characteristics.find((c) => c.uuid === txUuid),
    rx: characteristics.find((c) => c.uuid === rxUuid),
    txUuid,
    rxUuid
  };
}

async function enableNotifications(rxCharacteristic) {
  if (rxCharacteristic) {
    try {
      await rxCharacteristic.subscribeAsync();
      console.log('📢 Notifications enabled');
    } catch (error) {
      console.warn('⚠️ subscribeAsync error:', error?.message || error);
    }
  }
}

// Packet building functions
let sequence = 0;
const nextSequence = () => {
  const current = sequence;
  sequence = (sequence + 1) & PROTOCOL.SEQUENCE_MASK;
  return current;
};

const toBuffer = (hexString) => Buffer.from(hexString.replace(/\s+/g, ''), 'hex');
const powerPadding = Buffer.alloc(PROTOCOL.POWER_PADDING_SIZE, 0);
const POWER_HEADER = toBuffer(PROTOCOL.POWER_HEADER);
const RGB_HEADER = toBuffer(PROTOCOL.RGB_HEADER);

function buildPacketBase(header, payload, checksumBase) {
  const seqByte = nextSequence();
  const checksum = (seqByte + checksumBase) & PROTOCOL.SEQUENCE_MASK;
  return Buffer.concat([
    Buffer.from([0, seqByte]),
    header,
    payload,
    Buffer.from([checksum]),
  ]);
}

const buildPowerPacket = (turnOn) =>
  buildPacketBase(
    POWER_HEADER,
    Buffer.concat([
      Buffer.from([turnOn ? PROTOCOL.POWER_ON : PROTOCOL.POWER_OFF]), 
      powerPadding
    ]),
    PROTOCOL.POWER_CHECKSUM_BASE,
  );

const buildRgbPacket = (r, g, b) =>
  buildPacketBase(
    RGB_HEADER, 
    Buffer.from([r, g, b, ...PROTOCOL.RGB_TERMINATOR]), 
    PROTOCOL.RGB_CHECKSUM_BASE
  );

function buildPacket(mode, red, green, blue) {
  if (mode === 'off') {
    return buildPowerPacket(false);
  }
  if (mode === 'rgb') {
    return buildRgbPacket(red, green, blue);
  }
  return buildPowerPacket(true);
}

async function sendPacket(characteristic, mode, red, green, blue) {
  const packet = buildPacket(mode, red, green, blue);
  await characteristic.writeAsync(packet, false);
  console.log(`📤 Sent ${mode.toUpperCase()} (${packet.toString('hex')})`);
}

async function connectAndExecute(peripheral, config, mode, red, green, blue) {
  console.log(`🔗 Connecting to ${peripheral.advertisement.localName || peripheral.id}…`);
  
  try {
    await peripheral.connectAsync();
  } catch (error) {
    console.error('❌ Connection error:', error?.message || error);
    process.exit(1);
  }

  const services = await peripheral.discoverServicesAsync([]);
  const primaryService = findService(services, config.ble?.service_uuid);
    
  const characteristics = primaryService
    ? await primaryService.discoverCharacteristicsAsync([])
    : [];
    
  const { tx: txCharacteristic, rx: rxCharacteristic, txUuid } = findCharacteristics(characteristics, config);

  if (!txCharacteristic) {
    console.error(`❌ Characteristic ${txUuid.toUpperCase()} not found`);
    process.exit(1);
  }

  await enableNotifications(rxCharacteristic);
  await sendPacket(txCharacteristic, mode, red, green, blue);

  await peripheral.disconnectAsync();
  console.log('✅ Done');
  process.exit(0);
}

// Main function
function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['id', 'name', 'rgb'],
    boolean: ['on', 'off', 'help', 'discover-all'],
    alias: { h: 'help' },
  });

  if (argv.help) {
    console.log(`Usage:
  node lednet.js --on | --off | --rgb R,G,B
  node lednet.js --discover-all      (scan all devices)
  
  Device can be specified via command line or config.json:
    --id <device-id>     Exact device ID (from scan)
    --name <substring>   Device name substring (case-insensitive)
  
  Examples:
    node lednet.js --name LEDnetWF --on
    node lednet.js --id abc123...def --rgb 255,0,0
    
  Device configuration is read from config.json file if present.`);
    process.exit(0);
  }

  const config = loadConfig();
  const { wantedId, wantedName, mode, red, green, blue } = parseConfig(argv, config);
  validateDevice(wantedId, wantedName, argv['discover-all']);

  console.log('🔍 Scanning for Bluetooth Low Energy devices…');

  const bailout = argv['discover-all']
    ? setTimeout(() => {
        console.log('\n✅ Scan complete');
        process.exit(0);
      }, TIMING.DISCOVER_TIMEOUT)
    : setTimeout(() => {
        console.error('⌛ Timeout: device not found');
        process.exit(1);
      }, TIMING.CONNECTION_TIMEOUT);

  noble.on('stateChange', (state) => {
    if (state === 'poweredOn') {
      noble.startScanning([], false);
    }
  });

  const discoveredDevices = new Set();
  
  noble.on('discover', async (peripheral) => {
    const localName = (peripheral.advertisement.localName || '').toLowerCase();

    if (argv['discover-all']) {
      if (!discoveredDevices.has(peripheral.id)) {
        discoveredDevices.add(peripheral.id);
        console.log(`• ${peripheral.advertisement.localName || 'unnamed'}  (id: ${peripheral.id})`);
      }
      return;
    }

    const idMatches = wantedId && peripheral.id.toLowerCase() === wantedId;
    const nameMatches = wantedName && localName.includes(wantedName);

    if (!idMatches && !nameMatches) {
      return;
    }

    clearTimeout(bailout);
    noble.stopScanning();

    await connectAndExecute(peripheral, config, mode, red, green, blue);
  });

  if (argv['discover-all']) {
    clearTimeout(bailout);
    setTimeout(() => {
      console.log(`\n✅ Scan complete - found ${discoveredDevices.size} device(s)`);
      process.exit(0);
    }, TIMING.DISCOVER_TIMEOUT);
  }

  process.on('SIGINT', () => process.exit(0));
}

// Start the application
main();
