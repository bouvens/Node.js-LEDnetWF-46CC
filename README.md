# LED Strip Controller

Control LEDnetWF LED strip controller via Bluetooth LE using Node.js with full protocol support including effects, timers, and candle mode.

## Requirements

- [Node.js](https://nodejs.org/) (v18 or later)
- macOS (tested on Intel)
- Bluetooth LE LEDnetWF LED strip showed in Zengge app as "Controller 46CC"

## Installation

```bash
# Clone repository
git clone https://github.com/your-username/led-strip.git
cd led-strip

# Install dependencies
npm install
```

## Finding Your Device

First, scan for available devices to find your device ID:

```bash
npm run led:scan
```

This will list all BLE devices. Look for your LED controller and copy its ID to the config file on the next step.

## Configuration

1. Copy the example configuration file:

```bash
cp config.example.json config.json
```

2. Edit `config.json` with your device settings and optional default alarms.

All settings are optional.

**Important:** The `config.json` file is ignored by git.

## Usage

### Basic Commands

```bash
# Device scanning
npm run led:scan

# Power control
npm run led:on
npm run led:off

# RGB colors (automatically turns device on)
npm run led:rgb                    # Uses config.json default
npm run led:rgb -- 255,128,0       # Custom color
node lednet.js --name LEDnetWF --rgb 255,0,0 --off  # Set color then turn off
```

### Effects

Built-in effects with configurable speed and brightness (automatically turns device on):

```bash
# Using npm scripts
npm run led:effect -- fade7 --speed 80 --brightness 70
npm run led:effect -- strobe7 --speed 30 --brightness 100

# Direct command line
node lednet.js --name LEDnetWF --effect redgreen --brightness 60
```

**Available effects:**

- **Cross fade:** `fade7`, `red`, `green`, `blue`, `yellow`, `cyan`, `purple`, `white`
- **Cross fade colors:** `redgreen`, `redblue`, `greenblue`
- **Strobe:** `strobe7`, `redstrobe`, `greenstrobe`, `bluestrobe`, `yellowstrobe`, `cyanstrobe`, `purplestrobe`, `whitestrobe`
- **Jump:** `jump7`
- **Custom colors:** Any effect can use custom colors with `effect:R,G,B` format

### Candle Mode

Simulate flickering candle effect:

```bash
npm run led:candle -- --rgb 255,100,0 --amplitude 3 --speed 60 --brightness 80
node lednet.js --name LEDnetWF --candle --amplitude 2 --speed 50 --brightness 70
```

Parameters:

- `--rgb R,G,B` - Base candle color (optional, uses config default if not specified)
- `--amplitude 1-3` - Flicker intensity (1=low, 2=medium, 3=high)
- `--speed 1-100` - Flicker speed percentage
- `--brightness 1-100` - Overall brightness percentage

### Alarm System

⚠️ **KNOWN LIMITATION:** Only OFF alarms have been tested. Alarms write successfully to device memory and appear in the Zengge app, but **do NOT execute** at scheduled times. Repeat masks (days) may not work correctly. Root cause under investigation.

Set scheduled actions with format: `HH:MM[,params][/days][#brightness][%speed]`

```bash
# Basic power alarms
npm run led:alarm-on -- "21:00"                    # Daily at 21:00
npm run led:alarm-off -- "23:30/0011111"           # Weekdays at 23:30

# RGB alarms (automatically turns device on)
npm run led:alarm-rgb -- "20:00,255,128,0#80"      # Orange at 20:00, 80% brightness

# Effect alarms (automatically turns device on)
npm run led:alarm-effect -- "19:00,strobe7%30#90"   # Strobe at 30% speed, 90% brightness
npm run led:alarm-effect -- "19:30,fade7:0,255,0%40#90"     # Green fade effect, 40% speed, 90% brightness

# Multiple alarms
node lednet.js --name LEDnetWF --alarm-on "07:00/0011111#100;09:00/1100000#60"
node lednet.js --name LEDnetWF --alarm-rgb "20:00,255,0,0;21:00,0,255,0;22:00,0,0,255"

# One-time alarms (auto-delete after trigger)
node lednet.js --name LEDnetWF --alarm-on "08:00/once"

# Clear alarms
npm run led:alarm-clear -- all
npm run led:alarm-clear -- basic     # Clear only power on/off alarms
npm run led:alarm-clear -- effect    # Clear only RGB/effect alarms
```

**Days mask formats:**

- `/0011111` - Binary: weekdays (Mon-Fri)
- `/1100000` - Binary: weekends (Sat-Sun)
- `/1111111` - Binary: daily (default)
- `/once` - One-time only

Binary mask bit order: `[Once][Sun][Sat][Fri][Thu][Wed][Tue][Mon]`

### Time Synchronization

```bash
# Sync device clock and apply config alarms
npm run led:sync
node lednet.js --name LEDnetWF --time-sync
```

**Note:** Time sync automatically applies default alarms from `config.json` if present. Alarm operations automatically sync time before setting schedule.

## Command Line Options

```bash
node lednet.js [options]

Power:
  --on                    Turn device on
  --off                   Turn device off

Colors & Effects:
  --rgb R,G,B             Set RGB color (0-255, auto-turns on)
  --effect <name>         Set effect (see available effects above)
  --candle                Enable candle mode
  --speed N               Effect/candle speed 1-100% (default: 50)
  --brightness N          Effect/candle brightness 1-100% (default: 100)
  --amplitude N           Candle amplitude 1-3 (default: 2)

Alarms (format: HH:MM[,params][/days][#brightness][%speed]):
  --alarm-on <format>     Power ON alarm(s)
  --alarm-off <format>    Power OFF alarm(s)
  --alarm-rgb <format>    RGB color alarm(s)
  --alarm-effect <format> Effect alarm(s) - available: fade7, strobe7, jump7, red, green, blue,
                          yellow, cyan, purple, white, redgreen, redblue, greenblue, redstrobe,
                          greenstrobe, bluestrobe, yellowstrobe, cyanstrobe, purplestrobe,
                          whitestrobe. Any effect supports custom colors with effect:R,G,B format
  --alarm-clear <type>    Clear alarms (basic/effect/all, default: all)

Time & Device:
  --time-sync             Sync device clock (applies config alarms)
  --id <device-id>        Exact device ID
  --name <substring>      Device name match (case-insensitive)
  --discover-all, -d      Scan all devices

Help:
  --help, -h              Show help
```

## Protocol

The project implements the communication protocol for LEDnetWF V5 LED strip controllers based on reverse engineering:

- Basic control: Power ON/OFF, static RGB colors
- Effects: 20+ built-in dynamic effects with speed/brightness control
- Candle mode: Realistic candle flickering simulation
- Alarms: Automatic daily/weekly ON/OFF scheduling with RGB and effects
- Time sync: Device clock synchronization
- All packets use proper checksums and sequence numbering

### Not Yet Implemented

- **Microphone mode (MIC)**: Built-in microphone for music-reactive lighting effects
- **Music integration**: Bluetooth audio streaming and music synchronization
- **Custom patterns**: User-defined color sequences and animations
- **LED strip configuration**: Setting the number of LEDs and segments

## Troubleshooting

If you experience connection problems:

1. Make sure Bluetooth is enabled and device is in range
2. Verify device ID/name in `config.json` or use `npm run led:scan`
3. Some platforms may require administrator privileges
4. Use `--discover-all` to view all available services if needed

## References

| Model / Brand                                    | Notes                                                        | Source                              |
| ------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------- |
| **YBCRG-RGBWW "Ring Light"**                     | Same headers & effect IDs; community RE effort.              | ([github.com][1])                   |
| **Magic Home / Magic Hue Bluetooth controllers** | Use identical command set (apps in Play Store/App Store).    | ([play.google.com][2])              |
| **HappyLighting / Triones bulbs**                | Confirmed compatible packets, discussed in IoT forums.       | ([discourse.mozilla.org][3])        |
| **Generic Magic Home Wi-Fi+BLE RGBW boxes**      | Sold on Amazon/Walmart/eBay, fall back to the same BLE spec. | ([amazon.com][4], [walmart.com][5]) |

[1]: https://github.com/8none1/zengge_lednetwf '8none1/zengge_lednetwf - GitHub'
[2]: https://play.google.com/store/apps/details?hl=en_US&id=com.zengge.blev2 'ZENGGE - Apps on Google Play'

[3]: https://discourse.mozilla.org/t/wip-adapter-for-bluetooth-happylighting-triones-bulbs/49477 "[WIP] Adapter for Bluetooth \"HappyLighting\" / \"Triones\" bulbs"
[4]: https://www.amazon.com/magic-home-led-controller/s?k=magic+home+led+controller "Magic Home Led Controller - Amazon.com"
[5]: https://www.walmart.com/c/kp/magic-home-wifi-led-controller "Magic Home Wifi Led Controller - Walmart"

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

Copyright (C) 2025 Alexander Demin

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

**Author:** Alexander Demin
**Email:** bouvens@gmail.com
**Website:** https://bouvens.github.io/
