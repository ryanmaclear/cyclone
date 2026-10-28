import * as assert from 'assert';
import {
    CURING_CHUNK_SECONDS,
    generateCuringPlan,
    getCuringWarnings,
    MAX_CURING_DURATION_MINUTES,
    parseCuringParameters,
    validateCuringParameters
} from '../src/curing';

const positivePlan = generateCuringPlan({
    rpm: 1,
    durationMinutes: 1,
    direction: 'positive'
});

assert.strictEqual(CURING_CHUNK_SECONDS, 10);
assert.strictEqual(MAX_CURING_DURATION_MINUTES, 72 * 60);
assert.strictEqual(positivePlan.totalTimeS, 60);
assert.strictEqual(positivePlan.totalRotations, 1);
assert.strictEqual(positivePlan.feedRateDegreesPerMinute, 360);
assert.strictEqual(positivePlan.chunkCount, 6);
assert.deepStrictEqual(positivePlan.gcode.slice(0, 5), [
    '; Curing cycle start',
    '; Requested 1 RPM for 1 minute in positive Y',
    'G21',
    'G90',
    'M211 S0'
]);
assert.deepStrictEqual(positivePlan.gcode.slice(5, 12), [
    'G92 Y0',
    'G1 Y60 F360',
    'G1 Y120 F360',
    'G1 Y180 F360',
    'G1 Y240 F360',
    'G1 Y300 F360',
    'G1 Y360 F360'
]);
assert.strictEqual(positivePlan.gcode.filter((command) => command === 'M400').length, 1);
assert.strictEqual(positivePlan.gcode.filter((command) => command === 'G92 Y0').length, 2);
assert.deepStrictEqual(positivePlan.gcode.slice(-3), ['M400', 'G92 Y0', '; Curing cycle complete']);
assert.ok(!positivePlan.gcode.some((command) => /\b[ZX]/.test(command)));

const negativePlan = generateCuringPlan({
    rpm: 2.5,
    durationMinutes: 2,
    direction: 'negative'
});
assert.strictEqual(negativePlan.totalRotations, 5);
assert.strictEqual(negativePlan.feedRateDegreesPerMinute, 900);
assert.strictEqual(negativePlan.chunkCount, 12);
assert.strictEqual(negativePlan.gcode[6], 'G1 Y-150 F900');
assert.strictEqual(negativePlan.gcode[17], 'G1 Y-1800 F900');

const klipperPlan = generateCuringPlan({
    rpm: 1,
    durationMinutes: 1,
    direction: 'positive'
}, 'klipper');
assert.deepStrictEqual(klipperPlan.gcode.slice(0, 4), [
    '; Curing cycle start',
    '; Requested 1 RPM for 1 minute in positive R',
    'G90',
    'G92 R0'
]);
assert.strictEqual(klipperPlan.gcode[4], 'G1 R60 F360');
assert.deepStrictEqual(klipperPlan.gcode.slice(-3), ['M400', 'G92 R0', '; Curing cycle complete']);
assert.ok(!klipperPlan.gcode.includes('G21'));
assert.ok(!klipperPlan.gcode.includes('M211 S0'));
assert.ok(!klipperPlan.gcode.some((command) => /\bY-?\d/.test(command)));
assert.ok(getCuringWarnings('klipper').some((warning) => warning.includes('Klipper curing')));

assert.strictEqual(validateCuringParameters({rpm: 1, durationMinutes: 1, direction: 'positive'}).valid, true);
assert.deepStrictEqual(parseCuringParameters({rpm: 0.25, durationMinutes: 90, direction: 'negative'}), {
    rpm: 0.25,
    durationMinutes: 90,
    direction: 'negative'
});

assertInvalid(null, 'must be an object');
assertInvalid({rpm: 0, durationMinutes: 1, direction: 'positive'}, 'RPM must be greater than zero');
assertInvalid({rpm: Number.NaN, durationMinutes: 1, direction: 'positive'}, 'RPM must be greater than zero');
assertInvalid({rpm: Number.POSITIVE_INFINITY, durationMinutes: 1, direction: 'positive'}, 'RPM must be greater than zero');
assertInvalid({rpm: 1, durationMinutes: 0, direction: 'positive'}, 'positive whole number');
assertInvalid({rpm: 1, durationMinutes: 1.5, direction: 'positive'}, 'positive whole number');
assert.strictEqual(validateCuringParameters({rpm: 1, durationMinutes: MAX_CURING_DURATION_MINUTES, direction: 'positive'}).valid, true);
assertInvalid({rpm: 1, durationMinutes: MAX_CURING_DURATION_MINUTES + 1, direction: 'positive'}, '72 hours');
assertInvalid({rpm: 1, durationMinutes: 1, direction: 'clockwise'}, 'positive or negative');

function assertInvalid(value: unknown, expectedMessage: string): void {
    const result = validateCuringParameters(value);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes(expectedMessage)));
    assert.throws(() => generateCuringPlan(value), (error: Error) => error.message.includes(expectedMessage));
}

console.log('Curing tests passed');
