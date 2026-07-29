import {
    ELayerType,
    IWindParameters,
    TDeliveryHeadParameters,
    TLayerParameters
} from './planner/types';
import {
    calculateHelicalCircuitCount,
    IGeneratedRecipe,
    MAX_WIND_ANGLE_DEGREES,
    MIN_WIND_ANGLE_DEGREES,
    TOW_COVERAGES_PER_RECIPE_LAYER
} from './recipe';

type TUnknownRecord = Record<string, unknown>;

export function createArtifactRecipe(value: unknown): IGeneratedRecipe {
    const windParameters = validateWindArtifact(value);
    const helicalLayerCount = windParameters.layers.filter((layer) => layer.windType === ELayerType.HELICAL).length;
    const hoopLayers = windParameters.layers.filter((layer) => layer.windType === ELayerType.HOOP);
    const hoopLayerCount = hoopLayers.length;
    const skipLayerCount = windParameters.layers.filter((layer) => layer.windType === ELayerType.SKIP).length;
    const terminalLayerCount = hoopLayers.filter((layer) => layer.windType === ELayerType.HOOP && layer.terminal).length;
    const coverageCount = (helicalLayerCount + hoopLayerCount) * TOW_COVERAGES_PER_RECIPE_LAYER - terminalLayerCount;

    return {
        windParameters,
        summary: {
            layerMode: 'artifact',
            requestedLayerCount: windParameters.layers.length,
            helicalLayerCount,
            hoopLayerCount,
            skipLayerCount,
            achievedThickness: coverageCount * windParameters.towParameters.thickness
        },
        warnings: [
            'Uploaded artifact parameters were validated before planning.',
            'Thickness assumes each there-and-back layer deposits two complete tow coverages.',
            ...(terminalLayerCount > 0 ? ['A final single-pass hoop contributes one tow coverage.'] : []),
            'Tow thickness is recorded but the current planner does not increase mandrel diameter between layers.',
            'Hoop and helical locks create trim regions at the ends of the part.'
        ]
    };
}

export function validateWindArtifact(value: unknown): IWindParameters {
    const errors: string[] = [];
    const artifact = readRecord(value, 'Artifact', errors);
    const mandrel = readRecord(artifact.mandrelParameters, 'Mandrel parameters', errors);
    const tow = readRecord(artifact.towParameters, 'Tow parameters', errors);
    const diameter = readPositiveNumber(mandrel.diameter, 'Mandrel diameter', errors);
    const windLength = readPositiveNumber(mandrel.windLength, 'Wind length', errors);
    const towWidth = readPositiveNumber(tow.width, 'Tow width', errors);
    const towThickness = readPositiveNumber(tow.thickness, 'Tow thickness', errors);
    const defaultFeedRate = readPositiveNumber(artifact.defaultFeedRate, 'Default feed rate', errors);
    const deliveryHead = readDeliveryHead(artifact.deliveryHead, errors);
    const disableSoftEndstops = readOptionalBoolean(artifact.disableSoftEndstops, 'Disable soft endstops', errors);
    const layers = readLayers(artifact.layers, diameter, windLength, towWidth, errors);

    if (errors.length > 0) {
        throw new Error(`Invalid artifact: ${errors.join(' ')}`);
    }

    return {
        layers,
        mandrelParameters: {
            diameter,
            windLength
        },
        towParameters: {
            width: towWidth,
            thickness: towThickness
        },
        defaultFeedRate,
        deliveryHead,
        disableSoftEndstops
    };
}

function readLayers(
    value: unknown,
    diameter: number,
    windLength: number,
    towWidth: number,
    errors: string[]
): TLayerParameters[] {
    if (!Array.isArray(value) || value.length === 0) {
        errors.push('Layers must be a non-empty array.');
        return [];
    }

    const layers: TLayerParameters[] = [];
    value.forEach((rawLayer, index) => {
        const label = `Layer ${index + 1}`;
        const layer = readRecord(rawLayer, label, errors);
        if (layer.windType === ELayerType.HOOP) {
            if (typeof layer.terminal !== 'boolean') {
                errors.push(`${label} terminal must be true or false.`);
            }
            const terminal = layer.terminal === true;
            if (terminal && index !== value.length - 1) {
                errors.push(`${label} is terminal and must be the final layer.`);
            }
            layers.push({
                windType: ELayerType.HOOP,
                terminal
            });
            return;
        }

        if (layer.windType === ELayerType.HELICAL) {
            const windAngle = readNumberInRange(
                layer.windAngle,
                `${label} winding angle`,
                MIN_WIND_ANGLE_DEGREES,
                MAX_WIND_ANGLE_DEGREES,
                errors
            );
            const patternNumber = readPositiveInteger(layer.patternNumber, `${label} pattern number`, errors);
            const skipIndex = readPositiveInteger(layer.skipIndex, `${label} skip index`, errors);
            const lockDegrees = readPositiveNumber(layer.lockDegrees, `${label} lock degrees`, errors);
            const leadInMM = readNonNegativeNumber(layer.leadInMM, `${label} lead-in`, errors);
            const leadOutDegrees = readNonNegativeNumber(layer.leadOutDegrees, `${label} lead-out`, errors);
            const skipInitialNearLock = readOptionalBoolean(
                layer.skipInitialNearLock,
                `${label} skip initial near lock`,
                errors
            );

            if (Number.isFinite(leadInMM) && Number.isFinite(windLength) && leadInMM >= windLength) {
                errors.push(`${label} lead-in must be shorter than the wind length.`);
            }
            if (Number.isFinite(leadOutDegrees) && Number.isFinite(lockDegrees) && leadOutDegrees > lockDegrees) {
                errors.push(`${label} lead-out cannot be greater than lock degrees.`);
            }
            if (
                Number.isFinite(diameter)
                && Number.isFinite(towWidth)
                && Number.isFinite(windAngle)
                && Number.isInteger(patternNumber)
                && patternNumber > 0
            ) {
                const circuitCount = calculateHelicalCircuitCount(diameter, towWidth, windAngle);
                if (circuitCount % patternNumber !== 0) {
                    errors.push(`${label} pattern number must divide its ${circuitCount} calculated circuits.`);
                }
            }

            layers.push({
                windType: ELayerType.HELICAL,
                windAngle,
                patternNumber,
                skipIndex,
                lockDegrees,
                leadInMM,
                leadOutDegrees,
                skipInitialNearLock
            });
            return;
        }

        if (layer.windType === ELayerType.SKIP) {
            layers.push({
                windType: ELayerType.SKIP,
                mandrelRotation: readFiniteNumber(layer.mandrelRotation, `${label} mandrel rotation`, errors)
            });
            return;
        }

        errors.push(`${label} wind type must be helical, hoop, or skip.`);
    });
    return layers;
}

function readDeliveryHead(value: unknown, errors: string[]): TDeliveryHeadParameters | undefined {
    if (typeof value === 'undefined') {
        return undefined;
    }
    const deliveryHead = readRecord(value, 'Delivery head', errors);
    if (deliveryHead.mode === 'automatic') {
        return {mode: 'automatic'};
    }
    if (deliveryHead.mode === 'fixed') {
        return {
            mode: 'fixed',
            positionDegrees: readFiniteNumber(deliveryHead.positionDegrees, 'Fixed delivery head position', errors)
        };
    }
    errors.push('Delivery head mode must be automatic or fixed.');
    return undefined;
}

function readRecord(value: unknown, label: string, errors: string[]): TUnknownRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${label} must be an object.`);
        return {};
    }
    return value as TUnknownRecord;
}

function readPositiveInteger(value: unknown, label: string, errors: string[]): number {
    if (!Number.isInteger(value) || (value as number) < 1) {
        errors.push(`${label} must be a positive whole number.`);
        return Number.NaN;
    }
    return value as number;
}

function readPositiveNumber(value: unknown, label: string, errors: string[]): number {
    const numberValue = readFiniteNumber(value, label, errors);
    if (Number.isFinite(numberValue) && numberValue <= 0) {
        errors.push(`${label} must be greater than zero.`);
    }
    return numberValue;
}

function readNonNegativeNumber(value: unknown, label: string, errors: string[]): number {
    const numberValue = readFiniteNumber(value, label, errors);
    if (Number.isFinite(numberValue) && numberValue < 0) {
        errors.push(`${label} must be zero or greater.`);
    }
    return numberValue;
}

function readNumberInRange(
    value: unknown,
    label: string,
    minimum: number,
    maximum: number,
    errors: string[]
): number {
    const numberValue = readFiniteNumber(value, label, errors);
    if (Number.isFinite(numberValue) && (numberValue < minimum || numberValue > maximum)) {
        errors.push(`${label} must be between ${minimum} and ${maximum}.`);
    }
    return numberValue;
}

function readFiniteNumber(value: unknown, label: string, errors: string[]): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${label} must be a finite number.`);
        return Number.NaN;
    }
    return value;
}

function readOptionalBoolean(value: unknown, label: string, errors: string[]): boolean | undefined {
    if (typeof value === 'undefined') {
        return undefined;
    }
    if (typeof value !== 'boolean') {
        errors.push(`${label} must be true or false.`);
        return undefined;
    }
    return value;
}
