# LEDnetWF / ZENGGE BLE Protocol - Reverse Engineering Notes

## Device snapshot

| Field                       | Value                                                                   |
| --------------------------- | ----------------------------------------------------------------------- |
| **HW revision**             | LEDnetWF V5 "short-packet" batch (2023-2024)                            |
| **Chipset**                 | TLSR 8253 (Telink Semiconductor)                                        |
| **Advertising name**        | `LEDnetWF0200084346CC`                                                  |
| **Writable characteristic** | **UUID FF01** (handle 0x0017) - _Write With Response_ only              |
| **Notify characteristic**   | **UUID FF02** (handle 0x0016) + **CCCD 0x2902** (enable with `0x01 00`) |

## Packet anatomy

```
00 SEQ 80 00 00  <CMD-3B>  <LEN>  <PAYLOAD...>  CHK
```

- `SEQ` - monotonic 8-bit counter, persisted between sessions.
- `LEN` - payload length (1 byte).
- `CHK` - simple checksum calculated as **`(SEQ + bias) & 0xFF`** where bias depends on the command family:
  - Power / WAKE / timers -> `bias = 0x26`
  - RGB / Effects / Candle / Time -> `bias = 0x38`

**Checksum Examples:**

- Power ON seq 0x38: `(0x38 + 0x26) & 0xFF = 0x5E` ✅
- RGB Green seq 0x1B: `(0x1B + 0x38) & 0xFF = 0x53` ✅
- RGB Red seq 0x23: `(0x23 + 0x38) & 0xFF = 0x5B` (but packet shows 0x3F - needs verification)

- The controller silently accepts wrong checksums, but we keep them valid for sanity.

## What the ZENGGE app pushes right after connect (all **optional**)

When the official Android app attaches it fires a **burst of state-sync packets**-_not_ a handshake. They merely push the phone's clock and alarm tables to the controller:

| Seq     | Header (after `80 00 00`)    | Purpose               | Bytes        | Reference                  |
| ------- | ---------------------------- | --------------------- | ------------ | -------------------------- |
| `00 01` | `04 05 0A`                   | **Time sync**         | 12 B         | raw-packets.json sync_time |
| `00 02` | `0C 0D 0B`                   | **Basic timer blob**  | 20 B         | raw-packets.json alarm_on  |
| -       | write `01 00` to CCCD 0x2902 | enable notifications  | 2 B          | BLE standard procedure     |
| `00 03` | `0D 0E 0B 3B 25`             | **WAKE / keep-alive** | 22 B         | raw-packets.json wake      |
| ...     | RGB / Power / Effect         | 16-21 B               | user command | raw-packets.json commands  |

### Are they required?

- **No.** Sending a color or power packet alone is enough; the firmware does **not** depend on the earlier writes.
- CCCD is optional unless you need notifications.
- WAKE frames only matter if the strip sits idle for minutes; for interactive control you can skip them.

Info: Treat these packets as **state synchronisation** performed by the mobile app, not as a protocol prerequisite.

## Command families

| Header (after 80 00 00) | Purpose              | Payload format                             | CHK bias |
| ----------------------- | -------------------- | ------------------------------------------ | -------- |
| **`0D 0E 0B 3B`**       | Power ON / OFF       | `23/24 [10x00]` (21 B total)               | `0x26`   |
| **`08 09 0B 31`**       | Static RGB           | `R G B 00 00 0F` (16 B)                    | `0x38`   |
| **`05 06 0B 38`**       | Built-in Effect      | `effectID timeout brightness`              | `0x38`   |
| **`09 0A 0B 39 D1`**    | Candle               | `R G B invertedSpeed brightness amplitude` | `0x38`   |
| **`04 05 0A`**          | Time sync            | `hh mm ss` (BCD)                           | `0x38`   |
| **`0C 0D 0B`**          | Basic timer (ON/OFF) | 8 B record x N                             | `0x26`   |
| **`58 59 0B`**          | RGB/Effect timer     | 16 B record x N                            | `0x26`   |

### Effect Protocol Update

**Payload Structure:** `[effectID] [timeout] [brightness]` (3 bytes)

- `effectID`: effect identifier (0x25 = seven-color cross-fade)
- `timeout`: animation speed control (0x00-0xFF, higher values = slower animation)
- `brightness`: 0x00-0x64 (0-100%)

_(Effect IDs listed in Appendix A for reference.)_

## Timer record layouts

### Basic ON/OFF (header `0C 0D 0B`)

```
[0x14] [dowMask] [HH] [MM] [brightness] [speed] 00 0F
```

- `dowMask` - bit 0 = Mon, bit 6 = Sun; `0x00` = disabled; `0x80` = one-shot.
- Brightness & speed - 0-100 (0-0x64).

### RGB/Effect (header `58 59 0B`)

```
[dowMask] [HH] [MM] [type] ...rest... 00 F0
```

- `type` - `0x0F` = static RGB, `0xF0` = power OFF, `0x22-0x4C` = effect ID.
- For RGB -> `R G B brightness`.
- For effect -> `ID speed brightness`.

The controller stores **16 slots per table** and overwrites the oldest one when full.

## Edge cases & gotchas

1. **Bonding lock-up** - If the strip is still bonded to the Android app, it will ignore new centrals. Kill the app or toggle phone BT.
2. **Write Command vs Write Request** - CoreBluetooth (macOS) silently drops Write Command frames > 20 B. Always use _With Response_.
3. **Advertising window** - after power-up the strip advertises for ~30 s. Connect before it stops or send a BLE scan request to reopen the window.
4. **Checksum tolerance** - bad CHK is accepted but disables timers until the next valid packet.

## Related hardware

| Brand / Model                    | Status     | Notes                         |
| -------------------------------- | ---------- | ----------------------------- |
| **YBCRG-RGBWW ring light**       | ✅ Tested  | Shares headers & IDs          |
| Magic Home / Magic Hue BLE boxes | ✅         | Same command set              |
| HappyLighting / Triones bulbs    | ✅         | Confirmed on forums           |
| SP110E / SP105E BT controllers   | ⚠️ Partial | Need custom LED-count command |

## Open questions

- Absolute maximum packet size before fragmentation? (Telink 825x spec says 244 B).
- "Smear" custom animations (`0x59` header) - encoding details for gradient stops.
- Music mode - only partially decoded (`0D 0E 0B 73`).

## Appendix A - Effect ID map

| ID   | Label in ZENGGE app        | Family          | Alias in lednet.js |
| ---- | -------------------------- | --------------- | ------------------ |
| 0x25 | Seven-color cross fade     | Cross-fade      | fade7              |
| 0x26 | Red gradual                | Cross-fade      | red                |
| 0x27 | Green gradual              | Cross-fade      | green              |
| 0x28 | Blue gradual               | Cross-fade      | blue               |
| 0x29 | Yellow gradual             | Cross-fade      | yellow             |
| 0x2A | Purple gradual             | Cross-fade      | purple             |
| 0x2B | Cyan gradual               | Cross-fade      | cyan               |
| 0x2C | White gradual              | Cross-fade      | white              |
| 0x2D | Red/Green                  | Two-color cross | redgreen           |
| 0x2E | Red/Blue                   | Two-color cross | redblue            |
| 0x2F | Green/Blue                 | Two-color cross | greenblue          |
| 0x30 | Seven-color strobe         | Strobe          | strobe7            |
| 0x31 | Red strobe                 | Strobe          | redstrobe          |
| 0x32 | Green strobe               | Strobe          | greenstrobe        |
| 0x33 | Blue strobe                | Strobe          | bluestrobe         |
| 0x34 | Yellow strobe              | Strobe          | yellowstrobe       |
| 0x35 | Cyan strobe                | Strobe          | cyanstrobe         |
| 0x36 | Purple strobe              | Strobe          | purplestrobe       |
| 0x37 | White strobe               | Strobe          | whitestrobe        |
| 0x38 | Seven-color jumping change | Jump            | jump7              |
