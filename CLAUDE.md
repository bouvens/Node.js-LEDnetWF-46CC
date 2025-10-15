# Project Description

## Project Overview

This is a Node.js CLI tool for controlling LEDnetWF V5 Bluetooth LE LED strip controllers. The project implements a reverse-engineered protocol to provide comprehensive control over LED strips, including power management, RGB colors, effects, candle mode, and alarm scheduling.

## Common Development Commands

### Running the Application

- `npm run led` - Basic LED control (requires config.json)
- `npm run led:scan` - Discover all available BLE devices
- `npm run led:on` / `npm run led:off` - Power control
- `npm run led:rgb` - Set RGB color using config defaults
- `npm run led:effect` - Run effects with speed/brightness control
- `npm run led:candle` - Candle flickering mode
- `npm run led:sync` - Sync device time and apply config alarms

### Code Quality

- `npm run format` - Format code with Prettier
- `npm run format:check` - Check if code is properly formatted
- `npm run format:staged` - Format only staged files

### Direct CLI Usage

The main entry point is `lednet.js` which accepts extensive command-line options:

```bash
node lednet.js --name LEDnetWF --rgb 255,0,0 --effect strobe7 --speed 80
```

## Architecture

### Single-File Architecture

The entire application is contained in [lednet.js](lednet.js):

1. **Protocol Definitions**
   - `PROTOCOL_HEADERS` - BLE packet headers for different command types
   - `PROTOCOL` object - Effect IDs, alarm actions, checksum bases, constants
   - `EFFECT_ALIASES` - User-friendly effect names mapped to protocol IDs

2. **Configuration System**
   - `loadConfig()` - Loads config.json with device settings and defaults
   - Merges user config with sensible defaults

3. **Command Parsing**
   - `parseConfig()` - Converts CLI arguments to operation objects
   - Handles complex alarm scheduling syntax with day masks and parameters
   - Supports multiple operations per invocation

4. **BLE Communication**
   - Noble.js integration for Bluetooth LE
   - `main()` - Event-driven device discovery with ID/name matching
   - `connectAndExecute()` - Connection management and command execution
   - `sendPacket()` - Writes packets to BLE characteristic

5. **Packet Construction**
   - `buildPacket()` - Dispatches to specific builders based on operation type
   - Builders for power, RGB, effects, time sync, candle mode, alarms
   - Proper checksum calculation and sequence numbering

### Key Protocol Details

- Uses characteristic FF01 (write) and FF02 (notifications)
- Packets follow format: `00 SEQ HEADER PAYLOAD CHK`
- Two checksum bases: 0x26 (power/timers) and 0x38 (RGB/effects)
- Sequence counter wraps 0-255 and persists between sessions

### Configuration File

- `config.json` contains device identification and default parameters
- `config.example.json` shows all available configuration options
- Supports default alarms that apply during time sync operations

## Dependencies

### Runtime Dependencies

- `@abandonware/noble@1.9.2-20` - Bluetooth LE communication (macOS compatible)
- `minimist@^1.2.8` - Command-line argument parsing

### Development Dependencies

- `prettier@^3.4.2` - Code formatting
- `@types/node@^22.15.3` - TypeScript definitions for Node.js

## Important Notes

### Platform Requirements

- Developed for macOS with Intel architecture
- Requires Bluetooth LE capability
- Uses ES modules (`"type": "module"` in package.json)
- Node.js v18+ required

### Protocol Implementation

The protocol was reverse-engineered from packet captures (see `investigation.md` and `raw-packets.json`). The implementation handles:

- Complete command set for LEDnetWF V5 controllers
- Alarm scheduling with complex day/time patterns (**WARNING: Alarms program successfully but do not execute - see Alarm Limitations below**)
- Effect control with speed and brightness parameters
- Candle mode with amplitude control

#### Response Data (Notifications)

The device sends state updates via notifications (characteristic FF02) after every command. Currently these are **not monitored** by the implementation, but could be useful for:

- **Alarm debugging**: Confirm alarm table writes and detect firmware responses
- **Command verification**: Ensure device accepted and applied the command
- **State tracking**: Monitor current power/color/mode without re-querying

Format: JSON payload with hex-encoded device state (14 bytes). See [investigation.md](investigation.md) for decoding details.

#### Alarm System Status and Limitations

**Current Status:**

- ✅ Alarm **programming** works - alarms are written to device memory
- ✅ Alarms appear in Zengge app
- ✅ RTC (real-time clock) synchronization is reliable
- ✅ Device acknowledges alarm table updates (confirmed via `0F22` response dumps in notifications)
- ❌ Alarms **do not execute** at the scheduled time (device does not trigger actions)

**What Works:**

- Writing BASIC_TIMER (8-byte entries) for simple power on/off
- Time synchronization via RTC packets

**Known Issues:**

- **Only OFF alarms tested** - ON/RGB/effect alarms not verified
- Device accepts alarm table updates but **does not execute them**
- **Repeat masks (days) may be incorrect** - weekly alarms show wrong days in app UI
- Commit "nudges" (additional preludes after EFFECT_TIMER) do not trigger execution

**Implementation Uncertainty:**

The current implementation includes prelude sequences (A/B) and commit nudges copied from [test-alarm-formats.js](test-alarm-formats.js), but **we cannot confirm which packets are actually necessary** since we haven't achieved a working alarm configuration yet. Until we reproduce successful alarm execution, we cannot determine:

- Whether both PRELUDE A and B are required
- If the timing delays (180ms/120ms) are necessary
- Which packet sequences are essential vs. cargo-cult from captures

The code includes these elements defensively until a working configuration is identified.

### Testing Device Communication

Always test BLE operations with actual hardware as the protocol is hardware-specific and timing-sensitive. The `--discover-all` flag helps identify available devices during development.

### Protocol Debugging Approach

**Critical Rule: Only User Testing Confirms Correctness**

We can only be confident in implementation correctness after testing on real hardware. Successful packet transmission does NOT mean the code is correct. Only the user can confirm that the device responded as expected by observing actual device behavior.

**Reverse Engineering Workflow:**

1. **Capture packets** - Use Bluetooth packet capture tools (e.g., Wireshark, nRF Sniffer)
2. **Save to JSON** - Store captured packets in structured JSON format
3. **Transfer key packets to [raw-packets.json](raw-packets.json)** - Add important packets with hypothesized field meanings
4. **Update [lednet.js](lednet.js)** - Modify packet building functions to test hypotheses
5. **Test on real hardware** - User validates device behavior matches expectations
6. **Document working protocol in [investigation.md](investigation.md)** - Only after confirmed success

**Debugging Non-Working Commands:**

1. **Compare with raw-packets.json**: Use actual captured packets as reference
2. **Reproduce exact packets**: Modify packet building functions to match captured data byte-for-byte
3. **Identify missing parameters**: Look for extra bytes in working packets that aren't in your implementation
4. **Test incrementally**: Start with a known working packet format, then modify parameters one by one
5. **Clean up after success**: Once functionality works, identify and remove unnecessary steps (e.g., redundant preludes, excessive delays) to determine minimal working sequence

Example: Effect commands were failing because the payload needed format `[effectId, speed, 0x10, brightness]` instead of `[effectId, speed, brightness]`. The missing `0x10` byte was discovered by comparing generated packets with raw-packets.json.

### Code Style

The project uses Prettier with single quotes, trailing commas, and LF line endings. Run `npm run format` before committing changes.

### Important Protocol Behavior

- Successful packet transmission doesn't confirm correct protocol usage. The device doesn't return errors, so only user testing confirms if commands work.
- "Timeout: device not found" errors may be transient - retry the command before investigating further.
- **Checksum validation**: External projects (e.g., @8none1/zengge_lednetwf) report that checksums are **completely ignored** by the device after MTU/notification setup. However, initial testing suggested bad checksums disable timers. This discrepancy needs verification - the current implementation maintains correct checksums defensively.
