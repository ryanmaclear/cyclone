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
assert.strictEqual(mediumRecipe.summary.achievedThickness, 2);
assert.strictEqual(mediumRecipe.summary.helicalLayerCount, 3);
assert.strictEqual(mediumRecipe.summary.hoopLayerCount, 1);
assert.deepStrictEqual(mediumRecipe.windParameters.layers.map((layer) => layer.windType), [
    ELayerType.HELICAL,
    ELayerType.HELICAL,
    ELayerType.HELICAL,
    ELayerType.HOOP
]);

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
assert.strictEqual(thicknessRecipe.summary.requestedLayerCount, 4);
assert.strictEqual(thicknessRecipe.summary.helicalLayerCount, 3);
assert.strictEqual(thicknessRecipe.summary.hoopLayerCount, 1);
assert.strictEqual(thicknessRecipe.summary.targetThickness, 2);
assert.strictEqual(thicknessRecipe.summary.achievedThickness, 2);
assert.deepStrictEqual(thicknessRecipe.windParameters.layers.map((layer) => layer.windType), [
    ELayerType.HELICAL,
    ELayerType.HELICAL,
    ELayerType.HELICAL,
    ELayerType.HOOP
]);

const oneLayerThicknessRecipe = validateTubeRecipeInput({
    ...baseInput,
    layerMode: 'thickness',
    layerCount: undefined,
    targetThickness: 0.5
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

const plannedRecipe = planWindDetailed(mediumRecipe.windParameters, false, false);
assert.ok(plannedRecipe.gcode.length > 0);
assert.ok(plannedRecipe.totalTowUseM > 0);
assert.ok(plotGCode(plannedRecipe.gcode));
assert.deepStrictEqual(plannedRecipe.gcode, planWind(mediumRecipe.windParameters, false));
assert.ok(plannedRecipe.previewSegments.length > 0);
assert.ok(plannedRecipe.previewSegments.every((segment) => segment.start.x !== segment.end.x || segment.start.y !== segment.end.y));
assert.ok(plannedRecipe.previewSegments.some((segment) => segment.groupKind === 'helical-pass' && segment.passDirection === 'there'));
assert.ok(plannedRecipe.previewSegments.some((segment) => segment.groupKind === 'helical-pass' && segment.passDirection === 'back'));
assert.ok(plannedRecipe.previewSegments.some((segment) => segment.groupKind === 'lock'));
assert.ok(plannedRecipe.previewSegments.some((segment) => segment.layerIndex === 3 && segment.groupKind === 'hoop-pass'));

console.log('Recipe tests passed');
