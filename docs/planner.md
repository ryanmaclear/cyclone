# Planner and G-code generation

This document explains how Cyclone turns a `.wind` file into Marlin-flavored G-code. It describes the current implementation in `src/planner/`, including a few parameters that exist in the file format but are not fully used yet.

Cyclone is safety-sensitive software: the generated commands can move real hardware. Treat changes to winding geometry, feed rates, axis mapping, locks, lead-in/lead-out behavior, and terminal layers as behavioral changes to machine motion.

## Files involved

- `src/cli-entry.ts` reads a `.wind` JSON file for the `plan` command, calls `planWind`, and writes the returned G-code lines to the output file.
- `src/planner/types.ts` defines the `.wind` shape, layer types, logical axes, and the hardcoded logical-to-G-code axis mapping.
- `src/planner/planner.ts` contains the layer planning algorithms.
- `src/planner/machine.ts` contains `WinderMachine`, the G-code emitter, axis state tracker, segmentation logic, and time/tow usage estimates.
- `src/planner/helpers.ts` contains interpolation and debug formatting helpers.
- `src/helpers.ts` contains angle conversion and numeric precision helpers.
- `src/plotter/` can render generated G-code into a 2D plot by reading the planner's header comment.

## Machine coordinate model

Cyclone uses three logical axes:

| Logical axis | G-code axis | Units in generated G-code | Meaning |
| --- | --- | --- | --- |
| `carriage` | `X` | millimeters | Linear carriage position along the mandrel. `X0` is the near end and `X windLength` is the far end. |
| `mandrel` | `Y` | degrees | Mandrel rotation. `Y360` is one full mandrel revolution. |
| `deliveryHead` | `Z` | degrees | Delivery-head rotation/tilt. |

This mapping is defined by `AxisLookup` in `src/planner/types.ts` and is currently hardcoded. Marlin normally treats all axes as linear units, so the machine firmware must be configured so the `Y` and `Z` steps-per-mm values actually mean steps per degree.

The planner generally works in absolute positions. `WinderMachine` stores the last known logical position and emits absolute `G0` commands. When the planner needs to redefine the controller coordinate system, it emits `G92`.

## Planner entry point

The CLI command:

```sh
npm run cli -- plan -o output.gcode input.wind
```

does the following:

1. Reads the `.wind` file as text.
2. Parses it with `JSON.parse`.
3. Passes the result to `planWind`.
4. Writes the returned command list joined by newlines.

There is currently no runtime validation of the `.wind` contents. A malformed file may fail at runtime or generate unsafe/invalid motion.

`planWind` performs the top-level planning:

1. Creates a `WinderMachine` using `mandrelParameters.diameter`.
2. Adds a first-line header comment containing the mandrel and tow parameters:

   ```gcode
   ; Parameters {"mandrel":{"diameter":...,"windLength":...},"tow":{"width":...,"thickness":...}}
   ```

   The plotter expects this header on the first line.

3. Adds an initial move:

   ```gcode
   G0 X0 Y0 Z0
   ```

4. Sets the feed rate:

   ```gcode
   G0 F<defaultFeedRate>
   ```

5. Iterates through `layers` in order.
6. Dispatches each layer to `planHoopLayer`, `planHelicalLayer`, or `planSkipLayer`.
7. Logs estimated layer time, layer tow use, total time, and total tow use to the terminal.
8. Returns the generated G-code lines.

If a hoop layer is marked `terminal`, planning stops after that layer. If later layers are present, `planWind` prints a warning and aborts before planning them.

## How `WinderMachine` creates G-code

`WinderMachine` is a thin machine abstraction around a growing `string[]` of G-code lines.

### Raw commands and comments

- `addRawGCode(command)` appends a command exactly as provided.
- `insertComment(text)` emits `; ${text}`.
- `setFeedRate(feedRateMMpM)` stores the feed rate and emits `G0 F...`.

The planner only emits rapid-positioning `G0` commands. It does not emit `G1`, acceleration settings, unit mode commands, homing, spindle commands, or controller setup/teardown.

### Moves

Layer planners call:

```ts
machine.move({
    carriage: ...,
    mandrel: ...,
    deliveryHead: ...
});
```

The position object may include one, two, or all three logical axes. `WinderMachine` fills in unspecified axes from its `lastPosition`, so a move that specifies only `mandrel` keeps the current carriage and delivery-head positions.

For each emitted axis, `moveSegment`:

1. Converts the logical axis name to `X`, `Y`, or `Z`.
2. Rounds the value with `stripPrecision`, currently six decimal places.
3. Appends it to a `G0` command.
4. Updates `lastPosition`.
5. Updates profiler estimates for elapsed time and tow length.

Example:

```ts
machine.move({
    carriage: 100,
    mandrel: 720,
    deliveryHead: -35
});
```

may emit commands shaped like:

```gcode
G0 X0 Y0 Z0
G0 X1 Y7.2 Z-0.35
...
G0 X100 Y720 Z-35
```

when segmentation is required.

### Carriage move segmentation

If a move changes the carriage position, `WinderMachine.move` splits it into many smaller moves. The number of segments is:

```ts
Math.round(abs(startX - endX)) + 1
```

This makes the carriage advance roughly 1 mm per command. The reason is operational: Marlin can only pause after the current command completes, so smaller commands make pause/resume more responsive.

If a move does not change `carriage`, it is emitted as a single command. Mandrel-only locks and delivery-head-only tilts are therefore not segmented.

### Coordinate resets

`setPosition(position)` emits `G92` and updates `lastPosition` without moving the machine. For example:

```gcode
G92 Y0
```

tells the controller that the current mandrel position is now `Y0`.

`zeroAxes(currentAngleDegrees)` is used at the end of non-terminal hoop and helical layers. It:

1. Emits `G92 X0 Y<currentAngleDegrees % 360> Z0`.
2. Moves the mandrel to `Y360`, which advances it to the next full-revolution zero.
3. Emits `G92 Y0`.

In other words, it normalizes the mandrel coordinate back to zero while keeping the physical mandrel rotation continuous.

### Time estimate

The profiler treats the command distance as Marlin sees it:

```ts
sqrt(deltaX^2 + deltaY^2 + deltaZ^2)
```

where `deltaY` and `deltaZ` are in degrees but are still treated as Marlin units. It then estimates:

```ts
seconds = distance / feedRateMMpM * 60
```

This is an approximation. It assumes instantaneous acceleration and uses controller units, not true physical tool speed.

### Tow length estimate

Tow usage is estimated from physical carriage motion plus mandrel surface motion:

```ts
mandrelArcLengthMM = deltaMandrelDegrees / 360 * mandrelDiameter * PI
towSegmentLengthMM = sqrt(deltaCarriageMM^2 + mandrelArcLengthMM^2)
```

Delivery-head movement is ignored for tow length because tilting the head does not by itself unspool tow.

### Preview metadata

`planWindDetailed` also returns `previewSegments` for the Electron preview. These segments are recorded by `WinderMachine` while the same moves are emitted as G-code, so the preview observes the same carriage and mandrel coordinates as the generated motion.

Preview metadata does not change the generated G-code. It records only surface-relevant X/Y motion, including winding passes, locks, skips, and positioning moves. Pure delivery-head-only movement and `G92` coordinate resets are not represented as drawable preview segments.

Each segment includes its start/end X/Y coordinates plus layer and grouping metadata, such as layer type, group kind, pattern index, circuit index, and pass direction when those values apply. The renderer uses this metadata for pan/zoom display, colour modes, layer visibility, highlighting, and tooltips.

## The `.wind` file

A `.wind` file is JSON. The top-level structure is:

```json
{
  "layers": [],
  "mandrelParameters": {
    "diameter": 69.75,
    "windLength": 940
  },
  "towParameters": {
    "width": 7,
    "thickness": 0.5
  },
  "defaultFeedRate": 9000
}
```

All dimensions are metric unless otherwise noted. Rotational quantities are in degrees.

## Top-level parameters

### `layers`

Array of layer definitions, planned in order. Each layer must have a `windType` of:

- `"hoop"`
- `"helical"`
- `"skip"`

Each layer planner is responsible for leaving the machine in a useful state for the next layer. Non-terminal hoop and helical layers end by zeroing the mandrel coordinate. Skip layers end by redefining the mandrel coordinate to zero. Terminal hoop layers intentionally stop at the far end and do not reset axes.

### `mandrelParameters.diameter`

The mandrel diameter in millimeters.

Used by:

- `WinderMachine` to estimate tow length.
- Helical planning to compute mandrel circumference:

  ```ts
  mandrelCircumference = PI * diameter
  ```

- Hoop planning to compute the delivery-head tilt used during hoop passes.

The current planner does not automatically increase the mandrel diameter as layers are added, even though `WinderMachine` has a `setMandrelDiameter` method for that future behavior. All layers are planned using the original mandrel diameter.

### `mandrelParameters.windLength`

The axial winding length in millimeters. This is the carriage travel range used by the planner:

- Near end: `X0`
- Far end: `X windLength`

Locks at the ends create extra material buildup that is usually trimmed off later, so the usable part length may be shorter than `windLength`.

### `towParameters.width`

The tow width in millimeters.

Used by:

- Hoop planning to choose how many mandrel revolutions are needed to traverse the winding length:

  ```ts
  mandrelRotations = windLength / towWidth
  ```

- Hoop planning to compute delivery-head tilt.
- Helical planning to estimate the surface width occupied by one pass and therefore the number of circuits needed to cover the mandrel.
- The plotter to choose stroke width.

### `towParameters.thickness`

The tow thickness in millimeters.

Currently included in the file format and header comment, but not used by the planner. In a more complete laminate model, this would likely be used to update the effective mandrel diameter after each layer.

### `defaultFeedRate`

The feed rate passed to Marlin as:

```gcode
G0 F<defaultFeedRate>
```

The value is in Marlin feed-rate units, normally units per minute. Because this machine maps `Y` and `Z` to degrees, Marlin's motion planner treats degree changes as axis-unit changes when coordinating multi-axis moves. Cyclone does not currently vary feed rate by layer, pass, lock, or axis.

## Hoop layers

Example:

```json
{
  "windType": "hoop",
  "terminal": false
}
```

A hoop layer winds almost circumferentially around the mandrel while slowly advancing the carriage by approximately one tow width per mandrel revolution. In this planner, a hoop layer uses a fixed 180 degree lock at each turnaround.

### `windType`

Must be `"hoop"` for hoop layers.

### `terminal`

Boolean.

- `false`: wind from near to far, lock, wind back from far to near, lock, then normalize axes for the next layer.
- `true`: wind from near to far, lock, and stop at the far end. This is useful for operations such as applying heat-shrink tape where the machine should not return to the near end.

If any layers follow a terminal hoop layer, `planWind` warns and stops before planning them.

### Hoop calculations

The hoop planner currently assumes an overlap factor of 1.0, meaning one tow width of carriage advance per mandrel revolution.

Constants and derived values:

```ts
lockDegrees = 180
deliveryHeadWindAngle = 90 - atan(diameter / towWidth) converted to degrees
mandrelRotations = windLength / towWidth
farMandrelPositionDegrees = lockDegrees + mandrelRotations * 360
farLockPositionDegrees = farMandrelPositionDegrees + lockDegrees
nearMandrelPositionDegrees = farLockPositionDegrees + mandrelRotations * 360
nearLockPositionDegrees = nearMandrelPositionDegrees + lockDegrees
```

The delivery-head angle here is the `Z` tilt used by Cyclone during the axial traverse. The actual path geometry is set by the `X` and `Y` motion: one full mandrel revolution per tow width of carriage motion.

### Hoop G-code sequence

A non-terminal hoop layer emits this sequence conceptually:

1. Near lock:

   ```gcode
   G0 X0 Y180 Z0
   ```

2. Tilt delivery head for the outward pass:

   ```gcode
   G0 Z-<deliveryHeadWindAngle>
   ```

3. Wind to the far end with segmented carriage and mandrel motion:

   ```gcode
   G0 X... Y...
   ...
   G0 X<windLength> Y<farMandrelPositionDegrees>
   ```

4. Far lock while returning delivery head to level:

   ```gcode
   G0 Y<farLockPositionDegrees> Z0
   ```

5. Tilt delivery head for the return pass:

   ```gcode
   G0 Z<deliveryHeadWindAngle>
   ```

6. Wind back to the near end:

   ```gcode
   G0 X... Y...
   ...
   G0 X0 Y<nearMandrelPositionDegrees>
   ```

7. Near lock while returning delivery head to level:

   ```gcode
   G0 Y<nearLockPositionDegrees> Z0
   ```

8. Normalize axes with `zeroAxes`.

A terminal hoop layer performs steps 1 through 4 only, then returns without zeroing axes.

## Helical layers

Example:

```json
{
  "windType": "helical",
  "windAngle": 55,
  "patternNumber": 2,
  "skipIndex": 1,
  "lockDegrees": 720,
  "leadInMM": 30,
  "leadOutDegrees": 90,
  "skipInitialNearLock": true
}
```

A helical layer winds diagonal paths along the mandrel. Each circuit consists of a "there" pass from near to far and a "back" pass from far to near. The planner repeats circuits around the mandrel until the surface is covered according to the tow width and requested angle.

### `windType`

Must be `"helical"` for helical layers.

### `windAngle`

The winding angle in degrees used by the helical geometry formulas.

The current implementation uses `windAngle` as the angle between the tow path and the mandrel axis on the unwrapped cylinder surface:

```ts
circumferentialTravel = windLength * tan(windAngle)
```

Higher values produce more mandrel rotation per carriage pass and a more circumferential wrap. Lower values produce less mandrel rotation per pass and a more axial wrap.

The delivery head is commanded to:

```ts
deliveryHeadAngleDegrees = -(90 - windAngle)
```

for the outward pass, with the opposite sign for the return pass. The sign is also affected by the pass direction.

### `patternNumber`

The number of evenly spaced start positions around the mandrel in one pattern repeat.

The planner first estimates how many complete circuits are needed to cover the mandrel. It then requires:

```ts
numCircuits % patternNumber === 0
```

If `numCircuits` is not divisible by `patternNumber`, the planner prints a warning and returns without emitting the helical layer.

Practical meaning:

- `patternNumber: 1` creates one start position per pattern.
- `patternNumber: 2` creates two start positions per pattern, spaced around the mandrel.
- Larger values distribute the starts across more angular positions, but only work when the computed circuit count is divisible by the pattern number.

### `skipIndex`

The type and README describe this as the increment used to choose the next start position in a traditional filament winding pattern.

Current implementation note: `skipIndex` is not used by `planHelicalLayer`. The current planner advances start positions with fixed angular formulas based on `numCircuits` and `patternNumber`, regardless of the `skipIndex` value. Changing `skipIndex` in a `.wind` file currently has no effect on generated G-code.

### `lockDegrees`

The number of mandrel degrees used for each end lock in a helical layer.

Locks are extra mandrel rotation at the end of a pass, with little or no carriage movement, intended to anchor the tow at the end of the mandrel before reversing direction. Material in lock regions is commonly trimmed from the final part.

The planner uses `lockDegrees`:

- At the optional initial near lock.
- At every pass turnaround.
- At the final layer-ending lock before zeroing axes.

For each pass turnaround, the planner accounts for the pass's fractional mandrel rotation so the next pass starts on the intended angular position:

```ts
mandrelPositionDegrees += lockDegrees - leadOutDegrees - (passRotationDegrees % 360)
```

### `leadInMM`

The axial distance at the start of each helical pass over which the delivery head rotates into its full winding angle.

For an outward pass, the lead-in ends at:

```ts
X = leadInMM
```

For a return pass, the lead-in ends at:

```ts
X = windLength - leadInMM
```

During lead-in, carriage, mandrel, and delivery head move together. The mandrel rotation during lead-in is:

```ts
leadInDegrees = passDegreesPerMM * leadInMM
```

The remaining carriage distance is treated as the main pass.

### `leadOutDegrees`

The number of mandrel degrees at the start of the end lock over which the delivery head rotates back toward the pass-start angle.

After reaching the far or near end of a pass, the planner:

1. Adds `leadOutDegrees` to the mandrel position.
2. Moves the delivery head back to the pass-start angle while the mandrel rotates.
3. Adds the remainder of the lock rotation internally before the next positioning move.

This means `leadOutDegrees` is part of the lock behavior, not an axial distance.

### `skipInitialNearLock`

Optional boolean.

- `false` or omitted: start the layer with a near-end lock of `lockDegrees`, then reset the mandrel coordinate to zero with `G92 Y0`.
- `true`: skip that initial near-end lock.

This is useful for sequences where the previous layer already ended with a near lock or where an extra lock would create unwanted buildup.

### Helical calculations

The helical planner derives the layer geometry from mandrel diameter, wind length, tow width, and winding angle.

Mandrel circumference:

```ts
mandrelCircumference = PI * diameter
```

Effective tow width around the circumference for one pass:

```ts
towArcLength = towWidth / cos(windAngle)
```

Number of circuits needed to cover the circumference:

```ts
numCircuits = ceil(mandrelCircumference / towArcLength)
```

Each circuit includes an outward and return pass. The code comment notes that running all circuits therefore covers the mandrel twice.

Angular spacing unit:

```ts
patternStepDegrees = 360 / numCircuits
```

Mandrel surface travel for one full-length pass:

```ts
passRotationMM = windLength * tan(windAngle)
```

Mandrel rotation for one full-length pass:

```ts
passRotationDegrees = 360 * passRotationMM / mandrelCircumference
```

Mandrel degrees per millimeter of carriage travel:

```ts
passDegreesPerMM = passRotationDegrees / windLength
```

Number of pattern repeats:

```ts
numberOfPatterns = numCircuits / patternNumber
```

Lead-in and main-pass mandrel rotation:

```ts
leadInDegrees = passDegreesPerMM * leadInMM
mainPassDegrees = passDegreesPerMM * (windLength - leadInMM)
```

The planner uses two pass definitions:

| Pass | Delivery-head sign | Lead-in end | Full-pass end |
| --- | --- | --- | --- |
| There | `1` | `leadInMM` | `windLength` |
| Back | `-1` | `windLength - leadInMM` | `0` |

### Helical G-code sequence

If `skipInitialNearLock` is omitted or false, the layer starts with:

```gcode
G0 X0 Y<lockDegrees> Z0
G92 Y0
```

The planner then tracks a local `mandrelPositionDegrees`, initially zero.

For each pattern repeat and each start position within that pattern, the planner emits a there pass and a back pass. Each pass conceptually does this:

1. Position mandrel at the current computed angular start and level the delivery head:

   ```gcode
   G0 Y<mandrelPositionDegrees> Z0
   ```

2. Tilt delivery head to a fixed pass-start angle:

   ```gcode
   G0 Z<signed deliveryHeadPassStartAngle>
   ```

   `deliveryHeadPassStartAngle` is currently a hardcoded `-10` degrees before pass direction sign is applied.

3. Move through axial lead-in while rotating mandrel and tilting delivery head to the full winding angle:

   ```gcode
   G0 X<leadInEnd> Y<mandrelPositionDegrees + leadInDegrees> Z<signed full delivery angle>
   ```

   This move changes `X`, so it is segmented.

4. Move through the main pass to the opposite end:

   ```gcode
   G0 X<fullPassEnd> Y<... + mainPassDegrees>
   ```

   This move also changes `X`, so it is segmented.

5. Rotate through lead-out while returning the delivery head toward the pass-start angle:

   ```gcode
   G0 Y<... + leadOutDegrees> Z<signed deliveryHeadPassStartAngle>
   ```

6. Internally advance `mandrelPositionDegrees` by the rest of the lock and by a correction for the pass rotation modulo one revolution.

After completing both passes for a start position, the planner advances to the next start position in the current pattern:

```ts
mandrelPositionDegrees += patternStepDegrees * numCircuits / patternNumber
```

Because `patternStepDegrees` is `360 / numCircuits`, this simplifies to:

```ts
mandrelPositionDegrees += 360 / patternNumber
```

After completing a full pattern, it advances to the next pattern start:

```ts
mandrelPositionDegrees += patternStepDegrees
```

At the end of the layer, the planner adds a final `lockDegrees`, levels the delivery head, emits that move, and calls `zeroAxes`.

## Skip layers

Example:

```json
{
  "windType": "skip",
  "mandrelRotation": 90
}
```

A skip layer rotates the mandrel without winding a full hoop or helical layer. It can be used to offset the angular start point of the next layer.

### `windType`

Must be `"skip"` for skip layers.

### `mandrelRotation`

Mandrel rotation in degrees.

The planner emits:

```gcode
G0 X0 Y<mandrelRotation> Z0
G92 Y0
```

So after the physical mandrel rotation, the current mandrel angle becomes the new zero position for following layers.

## Generated G-code characteristics

Cyclone's planner currently generates a compact subset of G-code:

- `; ...` comments
- `G0` moves and feed-rate setting
- `G92` coordinate resets

It does not currently emit:

- `G90` absolute positioning mode
- `G21` millimeter units mode
- homing commands
- acceleration/jerk/velocity configuration
- spindle/extruder commands
- dwell commands
- end-of-program commands

The machine or sender must already be in the expected mode before running the generated file.

## Important current limitations

- `.wind` input is not validated.
- Only cylindrical mandrels are supported.
- Axis mapping is hardcoded to `X` carriage, `Y` mandrel, `Z` delivery head.
- `towParameters.thickness` is not used.
- Mandrel diameter is not updated between layers.
- `skipIndex` is not used by the helical planner.
- Helical `numCircuits` must be divisible by `patternNumber`; otherwise that layer is skipped after a warning.
- All planned commands use one feed rate.
- Time estimates ignore acceleration.
- The planner assumes the controller interprets the generated `G0` and `G92` commands in the intended absolute coordinate mode.
- Only non-terminal hoop layers can be terminal; helical and skip layers do not have a terminal mode.

## A small worked helical example

Given:

```json
{
  "mandrelParameters": {
    "diameter": 70,
    "windLength": 900
  },
  "towParameters": {
    "width": 7,
    "thickness": 0.5
  },
  "defaultFeedRate": 9000,
  "layers": [
    {
      "windType": "helical",
      "windAngle": 45,
      "patternNumber": 2,
      "skipIndex": 1,
      "lockDegrees": 720,
      "leadInMM": 30,
      "leadOutDegrees": 90
    }
  ]
}
```

The planner computes approximately:

```text
mandrelCircumference = PI * 70 = 219.91 mm
towArcLength = 7 / cos(45 degrees) = 9.90 mm
numCircuits = ceil(219.91 / 9.90) = 23
```

Because `23 % 2 !== 0`, this layer will not be emitted. To make the current planner accept this layer, choose a `patternNumber` that divides the computed circuit count, or adjust diameter, tow width, or wind angle so the computed circuit count is divisible by the desired pattern number.

This divisibility check is one of the most important practical constraints when authoring `.wind` files for the current implementation.
