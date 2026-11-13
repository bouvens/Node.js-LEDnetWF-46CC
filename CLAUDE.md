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
   - `PROTOCOL` object - Effect IDs, alarm actions, constants
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
- Checksum of every packet: sum of the bytes after the `80 00 00 LEN LEN+1 0A|0B` prefix (command bytes + payload), `& 0xFF`
- Sequence counter wraps 0-255 and restarts at 0 on every run

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

**Alarms are not timers.** In the app, an _alarm_ switches the strip at a
wall-clock time on chosen weekdays and lives in the `58 59 0B` table. A _timer_ is
the gradual fade on/off over a duration plus delayed switching - it does not
appear in that table and is not implemented here. Keep the terms apart.

**Current Status (verified 2026-09-02 on hardware):**

- ✅ Alarms **execute** - a daily ON alarm fired at the scheduled minute on a powered-off strip
- ✅ Alarm table format decoded and confirmed by reading it back from the device
- ✅ RTC set packet corrected (the old one queried state instead of setting the clock)
- ✅ Checksums of all packets are the **sum of the command bytes and payload**, not `seq + bias`
- ❌ Power OFF action encoding still unknown

**Root cause of the old "alarms never execute" report** - three bugs, all ours:

1. Table checksum used `seq + 0x38`; the device wants the payload sum.
2. `--time-sync` sent `04 05 0A | 81 8A 8B`, which is a **state query**, so the RTC was never set.
3. The table was written without its `0x21` prefix, shifting every field one byte, and the repeat mask was not shifted left by one bit.

**Reading state back (use this instead of packet capture):**

Enable notifications on FF02, then write a read request and the device answers:

- `05 06 0A | 22 2A 2B 0F` -> the whole timer table (`0F 22` prefix)
- `05 06 0A | 11 1A 1B 0F` -> the RTC clock (`0F 11` prefix)
- `04 05 0A | 81 8A 8B` -> current power/mode/brightness/RGB

The packets formerly labelled "vendor preludes" are these read requests, not an
initialization handshake. This also reads back what the official app wrote, so
the app itself can be used as a reference implementation without sniffing BLE.

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
- **Checksum validation**: External projects (e.g., @8none1/zengge_lednetwf) report that checksums are **completely ignored** by the device after MTU/notification setup. However, a wrong table checksum did break alarms. RGB packets with a wrong checksum were accepted (2026-11-13). The implementation keeps every checksum correct.
