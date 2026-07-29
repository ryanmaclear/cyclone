import * as assert from 'assert';
import { createArtifactRecipe, validateWindArtifact } from '../src/artifact';
import { planWindDetailed } from '../src/planner';
import { ELayerType, IWindParameters } from '../src/planner/types';

const validArtifact: IWindParameters = {
    layers: [
        {
            windType: ELayerType.HELICAL,
            windAngle: 45,
            patternNumber: 1,
            skipIndex: 1,
            lockDegrees: 720,
            leadInMM: 30,
            leadOutDegrees: 90,
            skipInitialNearLock: false
        },
        {
            windType: ELayerType.HOOP,
            terminal: false
        },
        {
            windType: ELayerType.SKIP,
            mandrelRotation: 45
        },
        {
            windType: ELayerType.HOOP,
            terminal: true
        }
    ],
    mandrelParameters: {
        diameter: 70,
        windLength: 900
    },
    towParameters: {
        width: 7,
        thickness: 0.5
    },
    defaultFeedRate: 9000,
    deliveryHead: {
        mode: 'fixed',
        positionDegrees: 0
    },
    disableSoftEndstops: true
};

const validated = validateWindArtifact(validArtifact);
assert.deepStrictEqual(validated, validArtifact);

const recipe = createArtifactRecipe(validArtifact);
assert.strictEqual(recipe.summary.layerMode, 'artifact');
assert.strictEqual(recipe.summary.requestedLayerCount, 4);
assert.strictEqual(recipe.summary.helicalLayerCount, 1);
assert.strictEqual(recipe.summary.hoopLayerCount, 2);
assert.strictEqual(recipe.summary.skipLayerCount, 1);
assert.strictEqual(recipe.summary.achievedThickness, 2.5);

const plan = planWindDetailed(recipe.windParameters, false, false);
assert.strictEqual(plan.layers.length, validArtifact.layers.length);
assert.ok(plan.gcode.length > 0);
const terminalSegments = plan.previewSegments.filter(
    (segment) => segment.layerIndex === 3 && segment.groupKind === 'hoop-pass'
);
assert.ok(terminalSegments.some((segment) => segment.passDirection === 'there'));
assert.ok(!terminalSegments.some((segment) => segment.passDirection === 'back'));

assertInvalid({}, 'Mandrel parameters must be an object');
assertInvalid({...validArtifact, layers: []}, 'Layers must be a non-empty array');
assertInvalid({
    ...validArtifact,
    layers: [
        {windType: ELayerType.HOOP, terminal: true},
        {windType: ELayerType.HOOP, terminal: false}
    ]
}, 'must be the final layer');
assertInvalid({
    ...validArtifact,
    layers: [{
        ...validArtifact.layers[0],
        windAngle: 81
    }]
}, 'winding angle must be between 10 and 80');
assertInvalid({
    ...validArtifact,
    layers: [{
        ...validArtifact.layers[0],
        patternNumber: 2
    }]
}, 'pattern number must divide its 23 calculated circuits');
assertInvalid({
    ...validArtifact,
    layers: [{
        ...validArtifact.layers[0],
        leadInMM: 900,
        leadOutDegrees: 721
    }]
}, 'lead-in must be shorter than the wind length');
assertInvalid({
    ...validArtifact,
    deliveryHead: {
        mode: 'fixed',
        positionDegrees: 'level'
    }
}, 'Fixed delivery head position must be a finite number');
assertInvalid({
    ...validArtifact,
    disableSoftEndstops: 'yes'
}, 'Disable soft endstops must be true or false');

function assertInvalid(value: unknown, expectedMessage: string): void {
    assert.throws(
        () => validateWindArtifact(value),
        (error: Error) => error.message.includes(expectedMessage)
    );
}

console.log('Artifact tests passed');
