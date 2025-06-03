# LED Strip Controller

Control LEDnetWF LED strip controller via Bluetooth LE using Node.js.

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

## Configuration

1. Copy the example configuration file:
```bash
cp config.example.json config.json
```

2. Edit `config.json` with your device settings:
```json
{
  "device": {
    "id": "your-device-id-here",    // Device ID from scan
    "name": "LEDnetWF"              // Device name (or part of it)
  },
  "ble": {
    "service_uuid": "ffe5",         // BLE service UUID (optional)
    "tx_char_uuid": "ff01",         // TX characteristic UUID (optional)
    "rx_char_uuid": "ff02"          // RX characteristic UUID (optional)
  },
  "defaults": {
    "rgb": "255,0,0"                // Default color (red,green,blue 0-255)
  }
}
```

**Important:** The `config.json` file is ignored by git. Make sure to configure it locally on each system.

## Finding Your Device

First, scan for available devices to find your device ID:

```bash
npm run scan
```

This will list all BLE devices. Look for your LED controller and copy its ID to the config file.

## Usage

### Basic Commands

```bash
# Turn on LED strip
npm run led:on

# Turn off LED strip  
npm run led:off

# Set RGB color (uses values from config or command line)
npm run led:rgb

# Set custom RGB color
npm run led:rgb -- 255,128,0

# Scan for devices
npm run scan
```

### Manual Control

You can still override config values via command line:

```bash
# Override device ID
node lednet.js --id DEVICE_ID --on

# Override device name
node lednet.js --name "My LED" --off

# Set custom RGB color
node lednet.js --rgb 255,0,0
```

## Help

```bash
node lednet.js --help
```

## Protocol

The project implements a communication protocol for LEDnetWF V5 type LED strip controllers:

- Initialization: INIT-A (12B), INIT-B (20B)
- Subscribe to notifications (FF02)
- Send WAKE packets (2 × 22B)
- Commands: ON/OFF (21B) or RGB (16B)

## Notes

- Device ID can be found by running `npm run scan`
- Configuration is read from `config.json` if present
- Command line arguments override config file values
- Stable operation requires direct Bluetooth visibility

## Troubleshooting

If you experience connection problems:

1. Make sure Bluetooth is enabled on your computer
2. Check that the device is turned on and within range
3. Verify the device ID or name is correct in `config.json`
4. Run `npm run scan` to find available devices
5. Some platforms may require running with administrator privileges
6. If the code can't find the needed services, run with the `--discover-all` option to view all available services

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

Copyright (C) 2025 Alexander Demin

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

**Author:** Alexander Demin  
**Email:** bouvens@gmail.com  
**Website:** https://bouvens.github.io/
