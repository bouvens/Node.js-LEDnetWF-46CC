#!/usr/bin/env node
/*
 * LED Strip Controller - Control LEDnetWF LED strip controller via Bluetooth LE
 * Copyright (C) 2025  Alexander Demin
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Author: Alexander Demin <bouvens@gmail.com>
 * Website: https://bouvens.github.io/
 */

/**
 * lednet.js – Control utility for the LEDnetWF V5 Bluetooth controller
 * Board label "46 CC", short-packet firmware.
 *
 * Packet format (maximum length 21 bytes)
 * ---------------------------------------
 *   00 | SEQ | HEADER | PAYLOAD | CHK
 *
 *   SEQ – monotonic counter (second byte, wraps 0-255).
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
 * Configuration is read from config.json when available.
 *
 * Tested with Node 20, macOS 15.5, noble @abandonware 1.9.2-20.
 */

const USAGE_HELP = `Usage:
  node lednet.js --on | --off | --rgb R,G,B
  node lednet.js --effect <name> [--speed N] [--brightness N]
  node lednet.js --candle [--amplitude N] [--speed N] [--brightness N]
  node lednet.js --alarm-on <format>
  node lednet.js --alarm-off <format>
  node lednet.js --alarm-rgb <format>
  node lednet.js --alarm-effect <format>
  node lednet.js --alarm-clear <type>
  node lednet.js --time-sync
  node lednet.js -d | --discover-all   (scan all devices)
  
  Basic Commands:
    --on                 Turn the LED strip on
    --off                Turn the LED strip off
    --rgb R,G,B          Set RGB color (0-255, device turns on automatically)
    --rgb R,G,B --off    Set RGB color, then turn off (color persists)
  
  Effects (automatically turns device on):
    --effect <name>      Effect name or alias (see Available Effects below)
    --speed N            Effect speed 1-100% (default: 50)
    --brightness N       Effect brightness 1-100% (default: 100)
  
  Available Effects:
    Cross fade: fade7, red, green, blue, yellow, cyan, purple, white
    Cross fade colors: redgreen, redblue, greenblue  
    Strobe: strobe7, redstrobe, greenstrobe, bluestrobe, yellowstrobe, cyanstrobe, purplestrobe, whitestrobe
    Jump: jump7
    
  Candle mode:
    --candle             Enable candle effect (uses default RGB color from config)
    --rgb R,G,B          Set custom RGB color for candle mode (0-255)
    --amplitude N        Candle amplitude 1-3 (default: 2, 1=low, 2=medium, 3=high)
    --speed N            Candle speed 1-100% (default: 50)
    --brightness N       Candle brightness 1-100% (default: 100)
  
  Alarm System (based on protocol investigation):
    --alarm-on <format>      Set power ON alarm(s)
    --alarm-off <format>     Set power OFF alarm(s)
    --alarm-rgb <format>     Set RGB color alarm(s)
    --alarm-effect <format>  Set effect alarm(s)
    --alarm-clear <type>     Clear alarms (basic/effect/all)
    
    Alarm Format: HH:MM[,param][/days][#brightness][%speed][;next_alarm]
    
    Basic examples:
      --alarm-on "21:00"                    Daily power on at 21:00
      --alarm-off "23:30/0011111"          Power off at 23:30, weekdays only
      --alarm-rgb "20:00,255,128,0#80"     Orange color at 20:00, 80% brightness
      --alarm-effect "19:00,strobe7%30#90" Strobe effect, 30% speed, 90% brightness
      --alarm-on "08:00/once"              One-time alarm (deletes after trigger)
    
    Multiple alarms:
      --alarm-on "07:00/0011111#100;09:00/1100000#60"  # Work 07:00, weekend 09:00
      --alarm-rgb "20:00,255,0,0;21:00,0,255,0;22:00,0,0,255"  # RGB sequence
    
    Days mask formats (all equivalent):
      /0011111    - Binary: weekdays (bits for Mon-Fri set)
      /0x1F       - Hex: weekdays (0x01+0x02+0x04+0x08+0x10 = 0x1F)  
      /31         - Decimal: weekdays (same as 0x1F)
      /1100000    - Binary: weekends (bits for Sat-Sun set)
      /0x60       - Hex: weekends (0x20+0x40 = 0x60)
      /96         - Decimal: weekends (same as 0x60)
      /1111111    - Binary: daily (all 7 days set = 0x7F)
      /once       - One-time only (auto-deletes after trigger)
    
    Binary mask bit order (left to right): [Once][Sun][Sat][Fri][Thu][Wed][Tue][Mon]
    Bit mapping: Mon(0x01) Tue(0x02) Wed(0x04) Thu(0x08) Fri(0x10) Sat(0x20) Sun(0x40) Once(0x80)
    Example: "0011111" = 0011111₂ = bits 0-4 set = Mon+Tue+Wed+Thu+Fri = weekdays
    
    Parameters:
      #N        - Brightness 1-100% (default: 100)
      %N        - Speed 1-100% for effects (default: 50)
      ;         - Separator for multiple alarms
    
    Clear alarms:
      --alarm-clear basic   Clear only basic (power on) alarms  
      --alarm-clear effect  Clear only effect (power off/RGB/effect) alarms
      --alarm-clear all     Clear all alarms
    
    Note: Alarm operations automatically sync time before setting schedule.
    Default alarms can be configured in config.json under defaults.alarms section.
  
  Time sync:
    --time-sync          Sync device clock with current time
  
  Device selection (via command line or config.json):
    --id <device-id>     Exact device ID (from scan)
    --name <substring>   Device name substring (case-insensitive)
  
  Examples:
    # Basic usage
    node lednet.js --name LEDnetWF --on
    node lednet.js --name LEDnetWF --effect strobe7 --speed 80 --brightness 70
    node lednet.js --name LEDnetWF --candle --amplitude 3 --speed 50 --brightness 100
    node lednet.js --name LEDnetWF --candle --rgb 255,100,0 --amplitude 1 --speed 80
    
    # Simple alarms
    node lednet.js --name LEDnetWF --alarm-on "21:00"
    node lednet.js --name LEDnetWF --alarm-off "23:30"  
    node lednet.js --name LEDnetWF --alarm-rgb "20:00,255,128,0"
    
    # Alarms with custom parameters
    node lednet.js --name LEDnetWF --alarm-on "21:00/0x1F#80"       # Weekdays (hex), 80% brightness
    node lednet.js --name LEDnetWF --alarm-on "08:00/once"          # One-time alarm  
    node lednet.js --name LEDnetWF --alarm-effect "19:00,strobe7%30#90"  # Strobe, 30% speed, 90% brightness
    
    # Multiple alarms  
    node lednet.js --name LEDnetWF --alarm-on "07:00/31;09:00/96"   # Work+weekend (decimal format)
    node lednet.js --name LEDnetWF --alarm-rgb "20:00,255,0,0;21:00,0,255,0;22:00,0,0,255"  # RGB sequence
    
    # Clear alarms
    node lednet.js --name LEDnetWF --alarm-clear all
    node lednet.js --name LEDnetWF --alarm-clear basic
    
    # Manual time sync
    node lednet.js --name LEDnetWF --time-sync  # Applies config alarms if present
    
  Note: RGB, effect, candle and alarm commands automatically turn on the device.
  Alarm operations automatically sync time before setting schedule.
  Device configuration is read from config.json file if present.
  
  Not yet implemented: microphone mode (MIC), music integration, custom patterns.`;

import noble from '@abandonware/noble';
import minimist from 'minimist';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const PROTOCOL_HEADERS = {
  POWER: '80 00 00 0D 0E 0B 3B',
  RGB: '80 00 00 08 09 0B 31',
  TIME: '80 00 00 04 05 0A',

  EFFECT: '80 00 00 05 06 0B 38',
  CANDLE: '80 00 00 09 0A 0B 39 D1',
  BASIC_TIMER: '80 00 00 0C 0D 0B',
  EFFECT_TIMER: '80 00 00 58 59 0B',
};

const PROTOCOL = {
  POWER_ON: 0x23,
  POWER_OFF: 0x24,

  POWER_CHECKSUM_BASE: 0x26,
  RGB_CHECKSUM_BASE: 0x38,

  RGB_TERMINATOR: [0x00, 0x00, 0x0f],
  POWER_PADDING_SIZE: 10,
  SEQUENCE_MASK: 0xff,

  EFFECTS: {
    SEVEN_COLOR_CROSS_FADE: 0x25,
    RED_GRADUAL: 0x26,
    GREEN_GRADUAL: 0x27,
    BLUE_GRADUAL: 0x28,
    YELLOW_GRADUAL: 0x29,
    PURPLE_GRADUAL: 0x2a,
    CYAN_GRADUAL: 0x2b,
    WHITE_GRADUAL: 0x2c,
    RED_GREEN_CROSS_FADE: 0x2d,
    RED_BLUE_CROSS_FADE: 0x2e,
    GREEN_BLUE_CROSS_FADE: 0x2f,
    SEVEN_COLOR_STROBE: 0x30,
    RED_STROBE: 0x31,
    GREEN_STROBE: 0x32,
    BLUE_STROBE: 0x33,
    YELLOW_STROBE: 0x34,
    CYAN_STROBE: 0x35,
    PURPLE_STROBE: 0x36,
    WHITE_STROBE: 0x37,
    SEVEN_COLOR_JUMPING: 0x38,
  },

  ALARM_ACTIONS: {
    POWER_ON: 0x01,
    POWER_OFF: 0xf0,
    RGB: 0x0f,
  },
};

// Effect aliases for easier CLI usage - separate from protocol
const EFFECT_ALIASES = {
  // Short aliases
  fade7: PROTOCOL.EFFECTS.SEVEN_COLOR_CROSS_FADE,
  strobe7: PROTOCOL.EFFECTS.SEVEN_COLOR_STROBE,
  jump7: PROTOCOL.EFFECTS.SEVEN_COLOR_JUMPING,

  // Color gradual aliases
  red: PROTOCOL.EFFECTS.RED_GRADUAL,
  green: PROTOCOL.EFFECTS.GREEN_GRADUAL,
  blue: PROTOCOL.EFFECTS.BLUE_GRADUAL,
  yellow: PROTOCOL.EFFECTS.YELLOW_GRADUAL,
  cyan: PROTOCOL.EFFECTS.CYAN_GRADUAL,
  purple: PROTOCOL.EFFECTS.PURPLE_GRADUAL,
  white: PROTOCOL.EFFECTS.WHITE_GRADUAL,

  // Cross fade aliases
  redgreen: PROTOCOL.EFFECTS.RED_GREEN_CROSS_FADE,
  redblue: PROTOCOL.EFFECTS.RED_BLUE_CROSS_FADE,
  greenblue: PROTOCOL.EFFECTS.GREEN_BLUE_CROSS_FADE,

  // Strobe aliases
  redstrobe: PROTOCOL.EFFECTS.RED_STROBE,
  greenstrobe: PROTOCOL.EFFECTS.GREEN_STROBE,
  bluestrobe: PROTOCOL.EFFECTS.BLUE_STROBE,
  yellowstrobe: PROTOCOL.EFFECTS.YELLOW_STROBE,
  cyanstrobe: PROTOCOL.EFFECTS.CYAN_STROBE,
  purplestrobe: PROTOCOL.EFFECTS.PURPLE_STROBE,
  whitestrobe: PROTOCOL.EFFECTS.WHITE_STROBE,
};

const clamp = (value, min, max, defaultValue) => {
  if (value === undefined || value === null) {
    return defaultValue !== undefined ? defaultValue : min;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    return defaultValue !== undefined ? defaultValue : min;
  }
  return Math.max(min, Math.min(max, parsed));
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
    alarms: {},
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
      device: { ...DEFAULT_CONFIG.device, ...userConfig.device },
      defaults: { ...DEFAULT_CONFIG.defaults, ...userConfig.defaults },
    };
  } catch (error) {
    return DEFAULT_CONFIG;
  }
}

function parseRgbColor(rgbString, config) {
  const defaultRgb = config.defaults?.rgb || DEFAULT_CONFIG.defaults.rgb;
  const colorString = rgbString || defaultRgb;
  return colorString
    .split(',')
    .map((value) => Number(value) & PROTOCOL.SEQUENCE_MASK);
}

function parseConfig(argv, config) {
  const wantedId = (argv.id || config.device?.id)?.toLowerCase();
  const wantedName = (argv.name || config.device?.name)?.toLowerCase();

  const operations = [];

  // Handle time synchronization (direct call)
  if (argv['time-sync']) {
    operations.push({ type: 'time', date: new Date() });
  }

  // Parse individual alarm entry with format: HH:MM[,param][/days][#brightness][%speed]
  function parseAlarmEntry(entryStr) {
    // Support multiple alarms separated by semicolon
    return entryStr.split(';').map((entry) => {
      // First parse brightness and speed from the entire entry (before splitting by /)
      let brightness = 100;
      let speed = 50;

      // Extract #brightness and %speed from anywhere in the entry
      const brightnessMatch = entry.match(/#(\d+)/);
      if (brightnessMatch) {
        brightness = clamp(parseInt(brightnessMatch[1]), 1, 100, 100);
        entry = entry.replace(/#\d+/, ''); // Remove from entry
      }

      const speedMatch = entry.match(/%(\d+)/);
      if (speedMatch) {
        speed = clamp(parseInt(speedMatch[1]), 1, 100, 50);
        entry = entry.replace(/%\d+/, ''); // Remove from entry
      }

      const [timeAndParams, ...modifiers] = entry.trim().split('/');
      const [time, ...params] = timeAndParams.split(',');

      // Parse time
      const timeMatch = time.match(/^(\d{1,2}):(\d{2})$/);
      if (!timeMatch) {
        console.error(
          `❌ Alarm time format should be HH:MM in entry: ${entry}`,
        );
        process.exit(1);
      }
      const [, hour, minute] = timeMatch.map((x) => parseInt(x, 10));

      // Parse modifiers: days
      let days = '1111111'; // Default: daily (0x7F)
      let isOnce = false;

      modifiers.forEach((mod) => {
        if (mod.toLowerCase() === 'once') {
          isOnce = true;
        } else if (/^[01]{7}$/.test(mod)) {
          // Binary format (e.g., 0011111 for weekdays)
          days = mod;
        }
      });

      // Calculate repeat mask: set bit 7 (0x80) for once mode
      let repeatMask = parseInt(days, 2);
      if (isOnce) {
        repeatMask = 0x80; // Once mode: only bit 7 set, others clear
      }

      return { hour, minute, repeatMask, brightness, speed, params, isOnce };
    });
  }

  // Merge default alarms from config only for time-sync command
  const hasCliAlarms =
    argv['alarm-on'] ||
    argv['alarm-off'] ||
    argv['alarm-rgb'] ||
    argv['alarm-effect'];
  if (!hasCliAlarms && argv['time-sync'] && config.defaults?.alarms) {
    const configAlarms = config.defaults.alarms;
    argv['alarm-on'] = argv['alarm-on'] || configAlarms['alarm-on'];
    argv['alarm-off'] = argv['alarm-off'] || configAlarms['alarm-off'];
    argv['alarm-rgb'] = argv['alarm-rgb'] || configAlarms['alarm-rgb'];
    argv['alarm-effect'] = argv['alarm-effect'] || configAlarms['alarm-effect'];
  }

  const hasAlarms =
    argv['alarm-on'] ||
    argv['alarm-off'] ||
    argv['alarm-rgb'] ||
    argv['alarm-effect'] ||
    argv['alarm-clear'];

  if (hasAlarms) {
    // Auto-sync time before setting alarms (except for clear-only operations)
    if (!argv['time-sync'] && !argv['alarm-clear']) {
      operations.push({ type: 'time', date: new Date() });
    }

    const basicAlarms = [];
    const effectAlarms = [];

    // Clear alarms if requested
    if (argv['alarm-clear']) {
      const clearType =
        argv['alarm-clear'] === true ? 'all' : argv['alarm-clear']; // Default to 'all' if just --alarm-clear flag
      if (clearType === 'basic' || clearType === 'all') {
        operations.push({ type: 'basic-alarm', entries: [] });
      }
      if (clearType === 'effect' || clearType === 'all') {
        operations.push({ type: 'effect-alarm', entries: [] });
      }
    }

    // Only process individual alarms if not clearing all
    const clearType =
      argv['alarm-clear'] === true ? 'all' : argv['alarm-clear'];
    if (!argv['alarm-clear'] || clearType !== 'all') {
      // Power ON alarms
      if (argv['alarm-on']) {
        const entries = parseAlarmEntry(argv['alarm-on']);
        entries.forEach((entry) => {
          basicAlarms.push(
            buildBasicAlarmEntry(
              entry.repeatMask,
              entry.hour,
              entry.minute,
              entry.brightness,
              0,
            ),
          );
        });
      }

      // Power OFF alarms
      if (argv['alarm-off']) {
        const entries = parseAlarmEntry(argv['alarm-off']);
        entries.forEach((entry) => {
          effectAlarms.push(
            buildEffectAlarmEntry(
              entry.repeatMask,
              entry.hour,
              entry.minute,
              PROTOCOL.ALARM_ACTIONS.POWER_OFF,
            ),
          );
        });
      }

      // RGB alarms
      if (argv['alarm-rgb']) {
        const entries = parseAlarmEntry(argv['alarm-rgb']);
        entries.forEach((entry) => {
          if (entry.params.length !== 3) {
            console.error(
              `❌ RGB alarm needs R,G,B parameters: ${argv['alarm-rgb']}`,
            );
            process.exit(1);
          }
          const [r, g, b] = entry.params.map((x) =>
            clamp(parseInt(x, 10), 0, 255),
          );
          effectAlarms.push(
            buildEffectAlarmEntry(
              entry.repeatMask,
              entry.hour,
              entry.minute,
              PROTOCOL.ALARM_ACTIONS.RGB,
              r,
              g,
              b,
              entry.brightness,
            ),
          );
        });
      }

      // Effect alarms
      if (argv['alarm-effect']) {
        const entries = parseAlarmEntry(argv['alarm-effect']);
        entries.forEach((entry) => {
          // Reconstruct effect parameter from potentially split parts
          const effectParam = entry.params.join(',').toLowerCase();
          const effectName = effectParam.split(':')[0]; // Split on colon for effect:params

          if (!effectName) {
            console.error(
              `❌ Effect alarm needs effect_name parameter: ${argv['alarm-effect']}`,
            );
            process.exit(1);
          }

          // Check if custom colors are specified and valid (effect:R,G,B format)
          if (effectParam.includes(':')) {
            const customParams = effectParam.split(':')[1].split(',');

            if (customParams.length >= 3) {
              const red = clamp(parseInt(customParams[0], 10), 0, 255, 255);
              const green = clamp(parseInt(customParams[1], 10), 0, 255, 255);
              const blue = clamp(parseInt(customParams[2], 10), 0, 255, 255);

              effectAlarms.push(
                buildEffectAlarmEntry(
                  entry.repeatMask,
                  entry.hour,
                  entry.minute,
                  PROTOCOL.ALARM_ACTIONS.RGB,
                  red,
                  green,
                  blue,
                  entry.brightness,
                ),
              );
              return; // Skip standard effect processing
            }
          }

          // Standard effect alarm processing (no custom colors or invalid format)
          let effectId;
          if (EFFECT_ALIASES[effectName]) {
            effectId = EFFECT_ALIASES[effectName];
          } else {
            console.error(`❌ Unknown effect: ${effectName}`);
            console.error(
              'Available effects:',
              Object.keys(EFFECT_ALIASES).join(', '),
            );
            process.exit(1);
          }

          effectAlarms.push(
            buildEffectAlarmEntry(
              entry.repeatMask,
              entry.hour,
              entry.minute,
              effectId,
              entry.speed,
              entry.brightness,
            ),
          );
        });
      }

      // Add alarm operations
      if (basicAlarms.length > 0) {
        operations.push({ type: 'basic-alarm', entries: basicAlarms });
      }
      if (effectAlarms.length > 0) {
        operations.push({ type: 'effect-alarm', entries: effectAlarms });
      }
    } // Close if for (!argv['alarm-clear'] || argv['alarm-clear'] !== 'all')
  } // Close if (hasAlarms)

  // Handle effect
  if (argv.effect) {
    let effectId;
    const effectName = argv.effect.toLowerCase();

    // Check aliases first
    if (EFFECT_ALIASES[effectName]) {
      effectId = EFFECT_ALIASES[effectName];
    } else {
      // Try to find by name in EFFECTS object
      const effectKey = Object.keys(PROTOCOL.EFFECTS).find(
        (key) =>
          key.toLowerCase().includes(effectName) ||
          key
            .toLowerCase()
            .replace(/_/g, '')
            .includes(effectName.replace(/[_-]/g, '')),
      );
      effectId = effectKey ? PROTOCOL.EFFECTS[effectKey] : null;
    }

    if (effectId === undefined) {
      console.error(
        `❌ Effect not recognised or not yet mapped: ${argv.effect}`,
      );
      console.error(
        'Available effects:',
        Object.keys(EFFECT_ALIASES).join(', '),
      );
      process.exit(1);
    }

    const speed = clamp(argv.speed, 1, 100, 50);
    const brightness = clamp(argv.brightness, 1, 100, 100);

    operations.push({ type: 'effect', effectId, speed, brightness });
  }

  // Handle candle mode
  if (argv.candle) {
    const amplitude = clamp(argv.amplitude, 1, 3, 2);
    const speed = clamp(argv.speed, 1, 100, 50);
    const brightness = clamp(argv.brightness, 1, 100, 100);

    const [red, green, blue] = parseRgbColor(argv.rgb, config);

    operations.push({
      type: 'candle',
      amplitude,
      speed,
      brightness,
      red,
      green,
      blue,
    });
  }

  // Handle RGB color setting (device auto-turns on when color is set)
  // Skip RGB operation if --candle is specified (RGB color already handled for candle)
  if (argv.rgb !== undefined && !argv.candle) {
    const [red, green, blue] = parseRgbColor(argv.rgb, config);
    operations.push({ type: 'rgb', red, green, blue });
  } else if (argv.on) {
    // Just turn on if only --on specified
    operations.push({ type: 'power', on: true });
  }

  // Handle power off (comes after RGB/effect/candle if both specified)
  if (argv.off) {
    operations.push({ type: 'power', on: false });
  }

  // If no operations specified, default to power on
  if (operations.length === 0) {
    operations.push({ type: 'power', on: true });
  }

  return { wantedId, wantedName, operations };
}

function validateDevice(wantedId, wantedName, discoverAll) {
  if (!wantedId && !wantedName && !discoverAll) {
    console.error(
      '❌ No device specified. Either provide config.json or use --discover-all to scan.',
    );
    process.exit(1);
  }

  if (!discoverAll) {
    console.log(
      `🎯 Looking for device: ${wantedId ? `ID="${wantedId}"` : ''}${
        wantedId && wantedName ? ' or ' : ''
      }${wantedName ? `Name="${wantedName}"` : ''}`,
    );
  }
}

// Bluetooth functions
const findService = (services) =>
  services.find((s) => s.uuid.startsWith(BLE.SERVICE_PATTERN)) || services[0];

function findCharacteristics(characteristics) {
  const txUuid = BLE.DEFAULT_TX_CHAR;
  const rxUuid = BLE.DEFAULT_RX_CHAR;

  return {
    tx: characteristics.find((c) => c.uuid === txUuid),
    rx: characteristics.find((c) => c.uuid === rxUuid),
    txUuid,
    rxUuid,
  };
}

async function enableNotifications(rxCharacteristic) {
  if (rxCharacteristic) {
    try {
      await rxCharacteristic.subscribeAsync();
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

const toBuffer = (hexString) =>
  Buffer.from(hexString.replace(/\s+/g, ''), 'hex');
const powerPadding = Buffer.alloc(PROTOCOL.POWER_PADDING_SIZE, 0);

// Convert all protocol headers to buffers
const HEADERS = Object.fromEntries(
  Object.entries(PROTOCOL_HEADERS).map(([key, value]) => [
    key,
    toBuffer(value),
  ]),
);

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
    HEADERS.POWER,
    Buffer.concat([
      Buffer.from([turnOn ? PROTOCOL.POWER_ON : PROTOCOL.POWER_OFF]),
      powerPadding,
    ]),
    PROTOCOL.POWER_CHECKSUM_BASE,
  );

const buildRgbPacket = (r, g, b) =>
  buildPacketBase(
    HEADERS.RGB,
    Buffer.from([r, g, b, ...PROTOCOL.RGB_TERMINATOR]),
    PROTOCOL.RGB_CHECKSUM_BASE,
  );

// Build effect packet with effect ID, timeout and brightness
const buildEffectPacket = (effectId, timeout, brightness) => {
  const payload = Buffer.from([
    effectId,
    timeout,
    brightness,
  ]);
  return buildPacketBase(HEADERS.EFFECT, payload, PROTOCOL.RGB_CHECKSUM_BASE);
};

// Build time synchronization packet
const buildTimePacket = (date = new Date()) => {
  const hh = date.getHours();
  const mm = date.getMinutes();
  const ss = date.getSeconds();
  const payload = Buffer.from([hh | 0x80, mm | 0x80, ss | 0x80]);
  return buildPacketBase(HEADERS.TIME, payload, PROTOCOL.RGB_CHECKSUM_BASE);
};

const buildCandlePacket = (
  amplitude = 2,
  speed = 50,
  brightness = 100,
  r = 255,
  g = 128,
  b = 0,
) => {
  const clampedAmplitude = clamp(amplitude, 1, 3);
  const clampedSpeed = clamp(speed, 1, 100);
  const clampedBrightness = clamp(brightness, 1, 100);
  const clampedR = clamp(r, 0, 255);
  const clampedG = clamp(g, 0, 255);
  const clampedB = clamp(b, 0, 255);

  const header = HEADERS.CANDLE;

  const speedByte = 101 - clampedSpeed;
  const brightnessByte = clampedBrightness;

  const payload = Buffer.from([
    clampedR,
    clampedG,
    clampedB,
    speedByte,
    brightnessByte,
    clampedAmplitude,
  ]);

  return buildPacketBase(header, payload, PROTOCOL.RGB_CHECKSUM_BASE);
};

// Build basic alarm entry (8 bytes) - for simple power on/off actions
const buildBasicAlarmEntry = (
  dowMask,
  hour,
  minute,
  brightness = 100,
  speed = 0,
) => {
  return Buffer.from([
    dowMask, // Days of week mask
    hour,
    minute, // Time (24h format)
    clamp(brightness, 0, 100, 100), // Brightness 0-100%
    clamp(speed, 0, 100, 50), // Speed 0-100%
    0x00,
    0x0f,
    0x00, // Reserved bytes (to make 8 bytes total)
  ]);
};

// Build effect alarm entry (16 bytes) - for RGB colors and effects
const buildEffectAlarmEntry = (
  dowMask,
  hour,
  minute,
  actionType,
  ...params
) => {
  const entry = Buffer.alloc(16, 0);
  entry[0] = dowMask; // Days of week mask
  entry[1] = hour; // Hour
  entry[2] = minute; // Minute
  entry[3] = actionType; // Action type (RGB=0x0F, POWER_OFF=0xF0, effects=0x38-0x4C)

  // Fill parameters based on action type
  if (actionType === PROTOCOL.ALARM_ACTIONS.RGB) {
    // RGB format: type=0x0F, R, G, B, brightness
    entry[4] = clamp(params[0], 0, 255); // R
    entry[5] = clamp(params[1], 0, 255); // G
    entry[6] = clamp(params[2], 0, 255); // B
    entry[7] = clamp(params[3], 1, 100, 100); // brightness
  } else if (actionType >= 0x38 && actionType <= 0x4c) {
    // Effect format: effectId, speed, brightness (no custom colors)
    entry[4] = clamp(params[0], 1, 100, 50); // speed
    entry[5] = clamp(params[1], 1, 100, 100); // brightness
  }

  entry[15] = 0xf0; // End marker
  return entry;
};

// Build complete basic alarm table packet
const buildBasicAlarmPacket = (alarmEntries) => {
  const tableMarker = Buffer.from([0x14]);
  const entries = Buffer.concat(
    alarmEntries.length > 0 ? alarmEntries : [Buffer.alloc(8, 0)],
  );
  const payload = Buffer.concat([tableMarker, entries]);
  return buildPacketBase(
    HEADERS.BASIC_TIMER,
    payload,
    PROTOCOL.RGB_CHECKSUM_BASE,
  );
};

// Build complete effect alarm table packet
const buildEffectAlarmPacket = (alarmEntries) => {
  const entries = Buffer.concat(
    alarmEntries.length > 0 ? alarmEntries : [Buffer.alloc(16, 0)],
  );
  return buildPacketBase(
    HEADERS.EFFECT_TIMER,
    entries,
    PROTOCOL.RGB_CHECKSUM_BASE,
  );
};

function buildPacket(operation) {
  if (operation.type === 'power') {
    return buildPowerPacket(operation.on);
  }
  if (operation.type === 'rgb') {
    return buildRgbPacket(operation.red, operation.green, operation.blue);
  }
  if (operation.type === 'effect') {
    return buildEffectPacket(
      operation.effectId,
      operation.speed,
      operation.brightness,
    );
  }
  if (operation.type === 'time') {
    return buildTimePacket(operation.date);
  }
  if (operation.type === 'candle') {
    return buildCandlePacket(
      operation.amplitude,
      operation.speed,
      operation.brightness,
      operation.red,
      operation.green,
      operation.blue,
    );
  }
  if (operation.type === 'basic-alarm') {
    return buildBasicAlarmPacket(operation.entries);
  }
  if (operation.type === 'effect-alarm') {
    return buildEffectAlarmPacket(operation.entries);
  }
  throw new Error(`Unknown operation type: ${operation.type}`);
}

async function sendPacket(characteristic, operation) {
  const packet = buildPacket(operation);
  await characteristic.writeAsync(packet, false);

  if (operation.type === 'power') {
    console.log(
      `📤 Sent POWER ${operation.on ? 'ON' : 'OFF'} (${packet.toString(
        'hex',
      )})`,
    );
  } else if (operation.type === 'rgb') {
    console.log(
      `📤 Sent RGB (${operation.red},${operation.green},${
        operation.blue
      }) (${packet.toString('hex')})`,
    );
  } else if (operation.type === 'effect') {
    console.log(
      `📤 Sent EFFECT ${operation.effectId} speed:${
        operation.speed
      }% brightness:${operation.brightness}% (${packet.toString('hex')})`,
    );
  } else if (operation.type === 'time') {
    const date = operation.date || new Date();
    console.log(
      `📤 Sent TIME SYNC ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()} (${packet.toString(
        'hex',
      )})`,
    );
  } else if (operation.type === 'candle') {
    console.log(
      `📤 Sent CANDLE amp:${operation.amplitude} speed:${
        operation.speed
      }% brightness:${operation.brightness}% color:(${operation.red},${operation.green},${operation.blue}) (${packet.toString('hex')})`,
    );
  } else if (operation.type === 'basic-alarm') {
    console.log(
      `📤 Sent BASIC ALARM table with ${
        operation.entries.length
      } entries (${packet.toString('hex')})`,
    );
  } else if (operation.type === 'effect-alarm') {
    console.log(
      `📤 Sent EFFECT ALARM table with ${
        operation.entries.length
      } entries (${packet.toString('hex')})`,
    );
  }
}

async function connectAndExecute(peripheral, operations) {
  console.log(
    `🔗 Connecting to ${peripheral.advertisement.localName || peripheral.id}…`,
  );

  try {
    await peripheral.connectAsync();
  } catch (error) {
    console.error('❌ Connection error:', error?.message || error);
    process.exit(1);
  }

  const services = await peripheral.discoverServicesAsync([]);
  const primaryService = findService(services);

  const characteristics = primaryService
    ? await primaryService.discoverCharacteristicsAsync([])
    : [];

  const {
    tx: txCharacteristic,
    rx: rxCharacteristic,
    txUuid,
  } = findCharacteristics(characteristics);

  if (!txCharacteristic) {
    console.error(`❌ Characteristic ${txUuid.toUpperCase()} not found`);
    process.exit(1);
  }

  await enableNotifications(rxCharacteristic);

  for (const operation of operations) {
    await sendPacket(txCharacteristic, operation);
  }

  await peripheral.disconnectAsync();
  console.log('✅ Done');
  process.exit(0);
}

// Main function
function main() {
  const argv = minimist(process.argv.slice(2), {
    string: [
      'id',
      'name',
      'rgb',
      'effect',
      'speed',
      'brightness',
      'amplitude',
      'alarm-on',
      'alarm-off',
      'alarm-rgb',
      'alarm-effect',
      'alarm-clear',
    ],
    boolean: ['on', 'off', 'help', 'discover-all', 'candle', 'time-sync'],
    alias: { h: 'help', d: 'discover-all' },
  });

  if (argv.help) {
    console.log(USAGE_HELP);
    process.exit(0);
  }

  const config = loadConfig();
  const { wantedId, wantedName, operations } = parseConfig(argv, config);
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
        console.log(
          `• ${peripheral.advertisement.localName || 'unnamed'}  (id: ${
            peripheral.id
          })`,
        );
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

    await connectAndExecute(peripheral, operations);
  });

  if (argv['discover-all']) {
    clearTimeout(bailout);
    setTimeout(() => {
      console.log(
        `\n✅ Scan complete - found ${discoveredDevices.size} device(s)`,
      );
      process.exit(0);
    }, TIMING.DISCOVER_TIMEOUT);
  }

  process.on('SIGINT', () => process.exit(0));
}

main();
