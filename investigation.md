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
- `CHK` - two different rules, depending on the command family:
  - Power / WAKE -> `(SEQ + 0x26) & 0xFF`
  - RGB / Effects / Candle -> `(SEQ + 0x38) & 0xFF`
  - **RTC, timer tables and read requests -> `sum(payload) & 0xFF`** (verified against every captured table packet)

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

| Header (after 80 00 00) | Purpose            | Payload format                             | CHK bias    |
| ----------------------- | ------------------ | ------------------------------------------ | ----------- |
| **`0D 0E 0B 3B`**       | Power ON / OFF     | `23/24 [10x00]` (21 B total)               | `0x26`      |
| **`08 09 0B 31`**       | Static RGB         | `R G B 00 00 0F` (16 B)                    | `0x38`      |
| **`05 06 0B 38`**       | Built-in Effect    | `effectID timeout brightness`              | `0x38`      |
| **`09 0A 0B 39 D1`**    | Candle             | `R G B invertedSpeed brightness amplitude` | `0x38`      |
| **`04 05 0A`**          | State query        | `81 8A 8B`                                 | payload sum |
| **`05 06 0A`**          | Read table / clock | `22 2A 2B 0F` / `11 1A 1B 0F`              | payload sum |
| **`0C 0D 0B`**          | RTC set            | `10 14 YY MM DD HH MM SS DOW 00 0F`        | payload sum |
| **`58 59 0B`**          | Timer table        | 87 B table (see below)                     | payload sum |

Candle speed is inverted like the effect speed, but its usable range is the
full `0x01-0x64` (verified on hardware: `0x01` very fast, `0x1F` and `0x23`
indistinguishable, `0x50` clearly slower, `0x64` very slow, all still a proper
candle flicker). Unlike effects, candle does **not** break above `0x23`.

### Effect Protocol Update

**Payload Structure:** `[effectID] [speed] [brightness]` (3 bytes)

- `effectID`: effect identifier (0x25 = seven-color cross-fade)
- `speed`: **0x01-0x23 only**, inverted (0x01 = fastest, 0x23 = slowest)
- `brightness`: 0x00-0x64 (0-100%)

**Speed range verified on hardware (2026-09-01), fade7 / 0x25:**

| Byte   | Observed behaviour                                 |
| ------ | -------------------------------------------------- |
| `0x01` | very fast fade                                     |
| `0x10` | smooth fade (matches the app's captured packets)   |
| `0x12` | smooth fade                                        |
| `0x1F` | slow fade, close to the app's minimum speed slider |
| `0x20` | smooth, slow                                       |
| `0x21` | smooth                                             |
| `0x22` | smooth                                             |
| `0x23` | smooth — **slowest usable value**                  |
| `0x24` | **breaks**: fast strobe flashing through white     |
| `0x30` | strobe-like jumps                                  |
| `0xF2` | strobe-like jumps                                  |

Anything above `0x23` is not a slower fade — the firmware switches to a fast
strobe through white, i.e. a different animation entirely. The previous
implementation scaled speed into 0x00-0x32 and printed a percentage computed
against 0xFF, so both the emitted byte and the reported speed were wrong.

Caveat on observation: a fresh EFFECT packet makes the strip snap to a new
color on arrival. That snap is easy to mistake for the effect itself being
choppy — judge the animation about 10 s after the write, not during it.

_(Effect IDs listed in Appendix A for reference.)_

## Timer record layouts

### Basic ON/OFF (header `0C 0D 0B`)

```
[0x14] [dowMask] [HH] [MM] [brightness] [speed] 00 0F
```

- `dowMask` - bit 0 = Mon, bit 6 = Sun; `0x00` = disabled; `0x80` = one-shot.
- Brightness & speed - 0-100 (0-0x64).

### RGB/Effect timer table (header `58 59 0B`) - verified 2026-09-02

The payload is a fixed 87-byte table, **not** a single record:

```
[0x21] [6 slots x 14 B] [0x00 0xF0]
```

Slot layout:

```
[0]      F0 = enabled, 0F = disabled   (toggling the alarm off in the app flips this byte)
[1..3]   YY MM DD   (all zero = repeating alarm; set = one-shot on that date)
[4..6]   HH MM SS
[7]      repeat mask SHIFTED LEFT BY ONE BIT (0xFE = daily)
[8..12]  action payload
[13]     F0 = power ON, 0F = power OFF
```

Action payload - byte 8 is the **mode**, the same value the device reports in its
state dump, and bytes 9..12 are its parameters:

| Bytes 8..12       | Meaning                                        | Tested        |
| ----------------- | ---------------------------------------------- | ------------- |
| `00 00 00 00 00`  | plain power on/off, keeps the last look        | ✅ 2026-09-02 |
| `61 R G B 00`     | static RGB (`0x61` = static colour mode)       | ✅ 2026-09-03 |
| `ID SPD 00 00 00` | built-in effect, SPD in the `0x01..0x23` scale | ✅ 2026-09-03 |

Brightness is not part of an RGB slot; the strip keeps its current brightness.
An earlier guess had byte 8 as brightness, which silently degraded to "just
switch on with the previous colour" because `0x00`-`0x64` are not valid modes.

Both ON and OFF slots carry an all-zero action payload; only byte 13 tells them
apart. Read back from the device 2026-09-02: an OFF alarm created in the app
came back as `F0 000000 1205 00 56 0000000000 0F`.

Repeat mask, same read: the app slot for Mon/Tue/Thu/Sat is `0x56`, and
`0x56 >> 1 = 0b0101011` = bits 0,1,3,5. So bit 0 is **Monday** and the whole
mask is stored shifted one bit left - even though the app's own UI starts the
week on Sunday. Writing `0x7F` unshifted, as the code used to, is a different
day set entirely, which is what the old "weekly alarms show wrong days" note was
really about.

**Alarms do execute.** Verified 2026-09-02: a daily ON alarm written by this
tool fired at the scheduled minute on a strip that was powered off. The old
"alarms never execute" note was wrong; the real causes were all on our side —
wrong checksum, a "time sync" that queried state instead of setting the RTC,
and a table written without the `0x21` prefix (shifting every field by one byte)
with an unshifted repeat mask.

### Reading state back from the device (no packet capture needed)

The packets previously labelled "vendor prelude" are in fact **read requests**.
Enable notifications on FF02, write the request, and the device answers on FF02
with a JSON envelope whose `payload` field holds the raw hex:

| Request (header + payload) | Answers with                                 |
| -------------------------- | -------------------------------------------- |
| `04 05 0A` + `81 8A 8B`    | current state (power, mode, brightness, RGB) |
| `05 06 0A` + `22 2A 2B 0F` | **the whole timer table**, prefixed `0F 22`  |
| `05 06 0A` + `11 1A 1B 0F` | **the RTC clock**, prefixed `0F 11`          |

Clock answer: `0F 11 14 YY MM DD HH MM SS DOW`.

This is the fastest way to verify a write: set an alarm, read the table back,
compare bytes. It also reads what the official app wrote, which removes the
need for a Bluetooth capture in most cases.

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

## Response Data (Notifications)

After enabling notifications (write `0x01 0x00` to CCCD 0x2902), the device sends state updates on every command.

**Format**: 8-byte BLE header + hex-encoded JSON string

Example response:

```
{"code":0,"payload":"811D24610F313232FF640200305C"}
```

**Payload decoding** (14 bytes hex string):

```
  fixed (0x81)
  |  firmware/device (0x1D)
  |  |  power (0x23=ON, 0x24=OFF)
  |  |  |  mode (0x61=HSV, 0x25-0x71=effects, 0xF0=RGB)
  |  |  |  |  brightness (0-100 hex)
  |  |  |  |  |  red (0-255)
  |  |  |  |  |  |  green (0-255)
  |  |  |  |  |  |  |  blue (0-255)
  |  |  |  |  |  |  |  |  white_temp (0-100)
  |  |  |  |  |  |  |  |  |  unknown
  |  |  |  |  |  |  |  |  |  |  unknown
  |  |  |  |  |  |  |  |  |  |  |  unknown
  |  |  |  |  |  |  |  |  |  |  |  |  unknown
  |  |  |  |  |  |  |  |  |  |  |  |  |  checksum (sum AND 0xFF)
  |  |  |  |  |  |  |  |  |  |  |  |  |  |
  81 1D 23 61 0F 31 64 32 FF 64 02 00 30 5C
```

**Current implementation**: Notifications enabled but not monitored. Could be useful for:

- Command confirmation (especially for alarm debugging)
- Automatic firmware detection
- State verification

## Advertising Data

The device broadcasts current state in BLE advertising packets **before connection**.

Example (power ON, HSV mode):

```
                   manufacturer_data
                   |  company_id
                   |  |  firmware (0x53)
                   |  |  |  power (0x23=ON, 0x24=OFF)
                   |  |  |  |  mode
                   |  |  |  |  |  brightness
                   |  |  |  |  |  |  RGB values
                   |  |  |  |  |  |  |  |  |  color_temp
                   |  |  |  |  |  |  |  |  |  |  LED_count
                   |  |  |  |  |  |  |  |  |  |  |
1E FF 02 5A 53 ... 23 61 0F 64 32 51 00 32 02 00 1C 00 00
```

**Use case**: Quick state polling without connecting (not implemented).

## Open questions

- Absolute maximum packet size before fragmentation? (Telink 825x spec says 244 B).
- Custom animations (`0x59` header) - encoding details for gradient stops.
- Music mode format - partially decoded (`0D 0E 0B 73`): `[on/off] [0x26] [type 0x01-0x10] [RGB RGB] [sensitivity] [brightness]`.
- Should notifications be monitored for command confirmation? Especially useful for alarm debugging since alarms don't execute.
- Checksum validation discrepancy - external projects report checksums **completely ignored** after MTU/notification setup, but testing suggests bad checksums disable timers. Needs verification.

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
