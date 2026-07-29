import * as assert from 'assert';
import { ELayerType } from '../src/planner/types';
import { planWind, planWindDetailed } from '../src/planner';
import { plotGCode } from '../src/plotter';
import {
    calculateHelicalCircuitCount,
    choosePatternNumber,
    generateTubeRecipe,
    ITubeRecipeInput,
    validateTubeRecipeInput
} from '../src/recipe';

const baseInput: ITubeRecipeInput = {
    diameter: 70,
    windLength: 900,
    windAngle: 45,
    strengthPreset: 'medium',
    layerMode: 'count',
    layerCount: 4,
    towWidth: 7,
    towThickness: 0.5,
    defaultFeedRate: 9000,
    lockDegrees: 720,
    leadInMM: 30,
    leadOutDegrees: 90
};

const mediumRecipe = generateTubeRecipe(baseInput);
assert.strictEqual(mediumRecipe.summary.requestedLayerCount, 4);
assert.strictEqual(mediumRecipe.summary.layerMode, 'count');
assert.strictEqual(mediumRecipe.summary.achievedThickness, 4);
assert.strictEqual(mediumRecipe.summary.helicalLayerCount, 3);
assert.strictEqual(mediumRecipe.summary.hoopLayerCount, 1);
assert.deepStrictEqual(mediumRecipe.windParameters.layers.map((layer) => layer.windType), [
    ELayerType.HELICAL,
    ELayerType.HELICAL,
    ELayerType.HELICAL,
    ELayerType.HOOP
]);
assert.strictEqual(mediumRecipe.windParameters.deliveryHead, undefined);
assert.strictEqual(mediumRecipe.windParameters.disableSoftEndstops, undefined);

const fixedDeliveryHeadRecipe = generateTubeRecipe({
    ...baseInput,
    fixedDeliveryHead: true,
    fixedDeliveryHeadPosition: 12.5
});
assert.deepStrictEqual(fixedDeliveryHeadRecipe.windParameters.deliveryHead, {
    mode: 'fixed',
    positionDegrees: 12.5
});

const disabledSoftEndstopsRecipe = generateTubeRecipe({
    ...baseInput,
    disableSoftEndstops: true
});
assert.strictEqual(disabledSoftEndstopsRecipe.windParameters.disableSoftEndstops, true);

const heavyOverrideRecipe = generateTubeRecipe({
    ...baseInput,
    strengthPreset: 'heavy',
    layerCount: 5
});
assert.strictEqual(heavyOverrideRecipe.summary.requestedLayerCount, 5);
assert.strictEqual(heavyOverrideRecipe.summary.helicalLayerCount, 3);
assert.strictEqual(heavyOverrideRecipe.summary.hoopLayerCount, 2);

const countModeIgnoresTargetThickness = generateTubeRecipe({
    ...baseInput,
    targetThickness: 1.3
});
assert.strictEqual(countModeIgnoresTargetThickness.summary.requestedLayerCount, 4);
assert.strictEqual(countModeIgnoresTargetThickness.summary.targetThickness, undefined);

const thicknessRecipe = generateTubeRecipe({
    ...baseInput,
    layerMode: 'thickness',
    layerCount: undefined,
    targetThickness: 2
});
assert.strictEqual(thicknessRecipe.summary.layerMode, 'thickness');
assert.strictEqual(thicknessRecipe.summary.requestedLayerCount, 2);
assert.strictEqual(thicknessRecipe.summary.helicalLayerCount, 1);
assert.strictEqual(thicknessRecipe.summary.hoopLayerCount, 1);
assert.strictEqual(thicknessRecipe.summary.targetThickness, 2);
assert.strictEqual(thicknessRecipe.summary.achievedThickness, 2);
assert.deepStrictEqual(thicknessRecipe.windParameters.layers.map((layer) => layer.windType), [
    ELayerType.HELICAL,
    ELayerType.HOOP
]);

const lightThicknessRecipe = generateTubeRecipe({
    ...baseInput,
    strengthPreset: 'light',
    layerMode: 'thickness',
    layerCount: undefined,
    targetThickness: 4
});
assert.strictEqual(lightThicknessRecipe.summary.helicalLayerCount, 4);
assert.strictEqual(lightThicknessRecipe.summary.hoopLayerCount, 0);

const heavyThicknessRecipe = generateTubeRecipe({
    ...baseInput,
    strengthPreset: 'heavy',
    layerMode: 'thickness',
    layerCount: undefined,
    targetThickness: 5
});
assert.strictEqual(heavyThicknessRecipe.summary.helicalLayerCount, 3);
assert.strictEqual(heavyThicknessRecipe.summary.hoopLayerCount, 2);

const oneLayerThicknessRecipe = validateTubeRecipeInput({
    ...baseInput,
    layerMode: 'thickness',
    layerCount: undefined,
    targetThickness: 1
});
assert.strictEqual(oneLayerThicknessRecipe.valid, false);
assert.ok(oneLayerThicknessRecipe.errors.some((error) => error.includes('at least 2 layers')));

const inexactThicknessRecipe = validateTubeRecipeInput({
    ...baseInput,
    layerMode: 'thickness',
    layerCount: undefined,
    targetThickness: 1.3
});
assert.strictEqual(inexactThicknessRecipe.valid, false);
assert.ok(inexactThicknessRecipe.errors.some((error) => error.includes('exact multiple')));

assert.strictEqual(choosePatternNumber(24), 4);
assert.strictEqual(choosePatternNumber(21), 3);
assert.strictEqual(choosePatternNumber(23), 1);
assert.strictEqual(calculateHelicalCircuitCount(70, 7, 45), 23);

const invalidRecipe = validateTubeRecipeInput({
    ...baseInput,
    diameter: 0,
    windAngle: 89,
    leadInMM: 900
});
assert.strictEqual(invalidRecipe.valid, false);
assert.ok(invalidRecipe.errors.length >= 3);

const invalidFixedDeliveryHeadRecipe = validateTubeRecipeInput({
    ...baseInput,
    fixedDeliveryHead: true,
    fixedDeliveryHeadPosition: Number.NaN
});
assert.strictEqual(invalidFixedDeliveryHeadRecipe.valid, false);
assert.ok(invalidFixedDeliveryHeadRecipe.errors.some((error) => error.includes('Fixed delivery head position')));

const plannedRecipe = planWindDetailed(mediumRecipe.windParameters, false, false);
assert.ok(plannedRecipe.gcode.length > 0);
assert.ok(plannedRecipe.totalTowUseM > 0);
assert.ok(plotGCode(plannedRecipe.gcode));
assert.deepStrictEqual(plannedRecipe.gcode, planWind(mediumRecipe.windParameters, false));
assert.ok(plannedRecipe.gcode.filter((command) => /^G0\b.*\bZ/.test(command)).length > 1);
assert.ok(!plannedRecipe.gcode.includes('M211 S0'));
assert.ok(plannedRecipe.previewSegments.length > 0);
assert.ok(plannedRecipe.previewSegments.every((segment) => segment.start.x !== segment.end.x || segment.start.y !== segment.end.y));
assert.ok(plannedRecipe.previewSegments.some((segment) => segment.groupKind === 'helical-pass' && segment.passDirection === 'there'));
assert.ok(plannedRecipe.previewSegments.some((segment) => segment.groupKind === 'helical-pass' && segment.passDirection === 'back'));
assert.ok(plannedRecipe.previewSegments.some((segment) => segment.groupKind === 'lock'));
assert.ok(plannedRecipe.previewSegments.some((segment) => segment.layerIndex === 3 && segment.groupKind === 'hoop-pass'));

const fixedDeliveryHeadPlan = planWindDetailed(fixedDeliveryHeadRecipe.windParameters, false, false);
const fixedDeliveryHeadZCommands = fixedDeliveryHeadPlan.gcode.filter((command) => /^G0\b.*\bZ/.test(command));
assert.deepStrictEqual(fixedDeliveryHeadZCommands, ['G0 X0 Y0 Z12.5']);
assert.ok(!fixedDeliveryHeadPlan.gcode.some((command) => command === 'G0'));

const disabledSoftEndstopsPlan = planWindDetailed(disabledSoftEndstopsRecipe.windParameters, false, false);
const feedRateIndex = disabledSoftEndstopsPlan.gcode.findIndex((command) => command === 'G0 F9000');
assert.ok(feedRateIndex >= 0);
assert.strictEqual(disabledSoftEndstopsPlan.gcode[feedRateIndex + 1], 'M211 S0');

console.log('Recipe tests passed');
