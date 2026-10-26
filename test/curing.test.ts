import * as assert from 'assert';
import {
    CURING_CHUNK_SECONDS,
    generateCuringPlan,
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
assert.strictEqual(positivePlan.gcode.filter((command) => command === 'G1 Y60 F360').length, 6);
assert.strictEqual(positivePlan.gcode.filter((command) => command === 'M400').length, 6);
assert.strictEqual(positivePlan.gcode.filter((command) => command === 'G92 Y0').length, 7);
for (let index = 5; index < 5 + positivePlan.chunkCount * 3; index += 3) {
    assert.deepStrictEqual(positivePlan.gcode.slice(index, index + 3), ['G92 Y0', 'G1 Y60 F360', 'M400']);
}
assert.deepStrictEqual(positivePlan.gcode.slice(-2), ['G92 Y0', '; Curing cycle complete']);
assert.ok(!positivePlan.gcode.some((command) => /\b[ZX]/.test(command)));

const negativePlan = generateCuringPlan({
    rpm: 2.5,
    durationMinutes: 2,
    direction: 'negative'
});
assert.strictEqual(negativePlan.totalRotations, 5);
assert.strictEqual(negativePlan.feedRateDegreesPerMinute, 900);
assert.strictEqual(negativePlan.chunkCount, 12);
assert.strictEqual(negativePlan.gcode.filter((command) => command === 'G1 Y-150 F900').length, 12);

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
assertInvalid({rpm: 1, durationMinutes: MAX_CURING_DURATION_MINUTES + 1, direction: 'positive'}, '168 hours');
assertInvalid({rpm: 1, durationMinutes: 1, direction: 'clockwise'}, 'positive or negative');

function assertInvalid(value: unknown, expectedMessage: string): void {
    const result = validateCuringParameters(value);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes(expectedMessage)));
    assert.throws(() => generateCuringPlan(value), (error: Error) => error.message.includes(expectedMessage));
}

console.log('Curing tests passed');
