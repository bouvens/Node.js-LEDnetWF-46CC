# Hardware findings log

Chronological record of what was tried on the actual strip, what it did, and what
that ruled in or out. `investigation.md` holds the resulting protocol description;
this file holds the evidence behind it.

Rule of the project: a packet leaving the host proves nothing. Only observed strip
behaviour, or a table read back from the device, counts as evidence.

The same rule applies to `raw-packets.json`: its captured bytes are ground truth,
but the names and field guesses attached to them are hypotheses until reproduced.
Two entries there described RTC writes as daily alarms, and the two "vendor
preludes" turned out to be read requests - both mistakes cost real debugging time.

## 2026-09-01 - Effect speed byte

**Symptom.** `fade7` looked like a strobe at every speed. The docs blamed the
firmware; the CLI reported "speed 81%" for `--speed 5`.

**What was found.** Two independent bugs pointing the same way: speed was scaled
into `0x00-0x32` but the log computed a percentage against `0xFF`. The captured
app packets use `0x10` for the same effect.

**Observations** (byte sent -> what the strip did):

| Byte   | Behaviour                              |
| ------ | -------------------------------------- |
| `0x01` | very fast fade                         |
| `0x10` | smooth fade, matches the app           |
| `0x12` | smooth fade                            |
| `0x1F` | slow, close to the app's minimum speed |
| `0x20` | smooth, slow                           |
| `0x21` | smooth                                 |
| `0x22` | smooth                                 |
| `0x23` | smooth, slowest usable                 |
| `0x24` | **fast strobe flashing through white** |
| `0x30` | strobe-like jumps                      |
| `0xF2` | strobe-like jumps                      |

**Conclusion.** Usable range is `0x01-0x23`, inverted. Above it the firmware
switches to a different animation instead of slowing down.

**Trap hit during this session.** A fresh EFFECT packet makes the strip snap to a
new color on arrival, and that snap reads as "choppy". One observation was
recorded as broken and later retracted. Judge an effect ~10 s after the write.

**Candle**, checked the same way: range is the full `0x01-0x64`, also inverted,
and it does _not_ break above `0x23`. `0x1F` and `0x23` are indistinguishable;
`0x50` is clearly slower; `0x64` is very slow but still a proper flicker.
Settled defaults: candle speed 10-40%, amplitude 3; effect speed 10%.

## 2026-09-02 - Why alarms never fired

Prior state of the docs: "alarms are written, appear in the app, but never
execute; root cause unknown". That was wrong on the cause. Three bugs, all ours.

**1. Checksum.** The table families do not use `seq + bias`. Verified against
every captured table packet - 8 of 8 matched `sum(payload) & 0xFF`:

```
rtc_set    payload 10 14 19 0a 04 10 37 21 06 00 0f = 0xC8, captured chk 0xC8
prelude A  payload 22 2a 2b 0f                      = 0x86, captured chk 0x86
effect_table_06..09                                  all matched
```

The docs already warned that a bad checksum disables timers, so every alarm we
had ever written was rejected.

**2. "Time sync" never set the clock.** It sent `04 05 0A | hh|80 mm|80 ss|80`.
That header, with payload `81 8A 8B`, is a _state query_ - `raw-packets.json`
even labelled it "NOT time-sync". The real RTC set is `0C 0D 0B | 10 14 YY MM DD
HH MM SS DOW 00 0F`. So the strip's clock was never being set by this tool.

**3. Table layout.** The payload is a 6-slot table with a `0x21` prefix, not a
single record. Writing the record without the prefix shifted every field one byte
left. The repeat mask is additionally stored shifted one bit left.

**Breakthrough: the device can be read.** The packets we called "vendor preludes"
are read requests. With notifications enabled on FF02:

```
05 06 0A | 22 2A 2B 0F  -> whole timer table   (0F 22 ...)
05 06 0A | 11 1A 1B 0F  -> RTC clock           (0F 11 14 YY MM DD HH MM SS DOW)
04 05 0A | 81 8A 8B     -> power / mode / brightness / RGB
```

This removes the need for BLE capture: write something, read it back, compare.
It also reads what the official app wrote, so the app doubles as a reference
implementation.

**Verification on hardware.**

| Time  | Action                                             | Result                    |
| ----- | -------------------------------------------------- | ------------------------- |
| 13:16 | ON alarm via BASIC_TIMER, old code                 | did not fire              |
| 13:28 | ON alarm via fixed EFFECT table, strip already lit | inconclusive (already on) |
| 18:19 | ON alarm, strip off                                | **fired**                 |
| 18:37 | ON alarm, strip verified off beforehand            | **fired**, observed       |
| 18:45 | OFF alarm, strip lit                               | **fired**, observed       |

**Action encoding**, from a slot the app wrote and we read back:

```
F0 000000 1205 00 56 0000000000 0F   <- app's OFF alarm, 18:05, Mon/Tue/Thu/Sat
                                  ^^ byte 13: F0 = power on, 0F = power off
```

Both ON and OFF carry an all-zero action payload; only byte 13 distinguishes
them. `0x56 >> 1` = bits 0,1,3,5 = Mon,Tue,Thu,Sat, confirming bit 0 = Monday
and the one-bit left shift - even though the app's UI starts the week on Sunday.

## 2026-09-03 - RGB and effect alarm actions

**Attempt 1** - byte 8 treated as brightness, `64 00 FF 00 00` for green at 100%.
Alarm did not fire at all. Table read back unchanged, clock correct, so the slot
was stored but the action was rejected.

**Attempt 2** - reordered to `R G B BR` (`00 FF 00 64 00`). The strip **switched
on but kept its previous colour** (purple, left over from the last candle run).
So byte 8 was being read as something that made the slot mean "just power on".

**Attempt 3** - byte 8 is the **mode**, matching the state dump: `0x61` is static
colour. Sent `61 00 FF 00 00`; strip came on green, no candle. Confirmed.

The same reading explains the effect slot from the old capture, `34 0B 00 00 00`:
byte 8 is the effect ID, byte 9 its speed. Verified with `25 20 00 00 00` -
fade7 at speed byte `0x20`, observed fading on a strip that was off.

Brightness is not carried in an RGB slot at all; the strip keeps whatever it had.

`--alarm-clear all` verified: the table reads back as six empty `0F` slots.

**BASIC_TIMER was a phantom.** `0C 0D 0B` with a `0x14` marker never worked, had
no capture behind it, and its "format" was most likely derived from the two
RTC-set packets that `raw-packets.json` mislabelled as daily alarms. Removed;
that header is the clock and nothing else.

**Alarms are not the app's timers.** The app also offers gradual on/off over a
duration (10 s - 30 min) and delayed switching. A pending 10-minute gradual
switch-on was **not** present in an alarm-table read taken before it completed,
so timers are stored elsewhere or not stored at all. Keep the two apart in code
and docs.

**Testing tip.** Use a fast effect speed when checking alarms in daylight - a
slow fade is hard to tell from a static colour.
