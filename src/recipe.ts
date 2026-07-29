import { degToRad } from './helpers';
import { ELayerType, IWindParameters, TLayerParameters } from './planner/types';

export type TStrengthPreset = 'light' | 'medium' | 'heavy';
export type TLayerMode = 'count' | 'thickness';

export interface ITubeRecipeInput {
    diameter: number;
    windLength: number;
    windAngle: number;
    strengthPreset: TStrengthPreset;
    layerMode: TLayerMode;
    layerCount?: number;
    targetThickness?: number;
    towWidth: number;
    towThickness: number;
    defaultFeedRate: number;
    lockDegrees: number;
    leadInMM: number;
    leadOutDegrees: number;
    fixedDeliveryHead?: boolean;
    fixedDeliveryHeadPosition?: number;
    disableSoftEndstops?: boolean;
}

export interface IGeneratedRecipe {
    windParameters: IWindParameters;
    summary: IRecipeSummary;
    warnings: string[];
}

export interface IRecipeSummary {
    layerMode: TLayerMode;
    requestedLayerCount: number;
    helicalLayerCount: number;
    hoopLayerCount: number;
    numCircuits: number;
    patternNumber: number;
    targetThickness?: number;
    achievedThickness: number;
}

export interface IRecipeValidationResult {
    valid: boolean;
    errors: string[];
}

const PRESET_LAYER_COUNTS: Record<TStrengthPreset, number> = {
    light: 2,
    medium: 4,
    heavy: 6
};

const HOOP_RATIOS: Record<TStrengthPreset, number> = {
    light: 0,
    medium: 0.25,
    heavy: 0.4
};

export const MAX_AUTO_PATTERN_NUMBER = 4;
export const MIN_WIND_ANGLE_DEGREES = 10;
export const MAX_WIND_ANGLE_DEGREES = 80;
export const TOW_COVERAGES_PER_RECIPE_LAYER = 2;
const THICKNESS_LAYER_TOLERANCE = 0.000001;

export function validateTubeRecipeInput(input: ITubeRecipeInput): IRecipeValidationResult {
    const errors: string[] = [];

    requirePositive(input.diameter, 'Diameter', errors);
    requirePositive(input.windLength, 'Wind length', errors);
    requirePositive(input.towWidth, 'Tow width', errors);
    requirePositive(input.towThickness, 'Tow thickness', errors);
    requirePositive(input.defaultFeedRate, 'Feed rate', errors);
    requirePositive(input.lockDegrees, 'Lock degrees', errors);

    if (!Number.isFinite(input.windAngle) || input.windAngle < MIN_WIND_ANGLE_DEGREES || input.windAngle > MAX_WIND_ANGLE_DEGREES) {
        errors.push(`Winding angle must be between ${MIN_WIND_ANGLE_DEGREES} and ${MAX_WIND_ANGLE_DEGREES} degrees.`);
    }

    if (input.layerMode !== 'count' && input.layerMode !== 'thickness') {
        errors.push('Layer mode must be count or thickness.');
    }

    if (input.layerMode === 'count') {
        if (!Number.isInteger(input.layerCount) || input.layerCount < 1) {
            errors.push('Layer count must be a whole number of at least 1.');
        }
    }

    if (input.layerMode === 'thickness') {
        requirePositive(input.targetThickness, 'Target thickness', errors);

        if (Number.isFinite(input.targetThickness) && Number.isFinite(input.towThickness) && input.towThickness > 0) {
            const layerThickness = input.towThickness * TOW_COVERAGES_PER_RECIPE_LAYER;
            const calculatedLayerCount = input.targetThickness / layerThickness;
            const roundedLayerCount = Math.round(calculatedLayerCount);

            if (Math.abs(calculatedLayerCount - roundedLayerCount) > THICKNESS_LAYER_TOLERANCE) {
                errors.push('Target thickness must be an exact multiple of one there-and-back layer thickness.');
            }

            if (roundedLayerCount < 2) {
                errors.push('Target thickness must produce at least 2 layers so the final layer can be hoop.');
            }
        }
    }

    if (!Number.isFinite(input.leadInMM) || input.leadInMM < 0) {
        errors.push('Lead-in must be zero or greater.');
    }

    if (Number.isFinite(input.leadInMM) && Number.isFinite(input.windLength) && input.leadInMM >= input.windLength) {
        errors.push('Lead-in must be shorter than the wind length.');
    }

    if (!Number.isFinite(input.leadOutDegrees) || input.leadOutDegrees < 0) {
        errors.push('Lead-out must be zero or greater.');
    }

    if (Number.isFinite(input.leadOutDegrees) && Number.isFinite(input.lockDegrees) && input.leadOutDegrees > input.lockDegrees) {
        errors.push('Lead-out cannot be greater than lock degrees.');
    }

    if (!Object.prototype.hasOwnProperty.call(PRESET_LAYER_COUNTS, input.strengthPreset)) {
        errors.push('Layer distribution preset must be light, medium, or heavy.');
    }

    if (input.fixedDeliveryHead && !Number.isFinite(input.fixedDeliveryHeadPosition)) {
        errors.push('Fixed delivery head position must be a finite number.');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

export function generateTubeRecipe(input: ITubeRecipeInput): IGeneratedRecipe {
    const validation = validateTubeRecipeInput(input);
    if (!validation.valid) {
        throw new Error(validation.errors.join(' '));
    }

    const layerCounts = getLayerCounts(input);
    const requestedLayerCount = layerCounts.requestedLayerCount;
    const helicalLayerCount = layerCounts.helicalLayerCount;
    const hoopLayerCount = layerCounts.hoopLayerCount;
    const numCircuits = calculateHelicalCircuitCount(input.diameter, input.towWidth, input.windAngle);
    const patternNumber = choosePatternNumber(numCircuits);
    const achievedThickness = requestedLayerCount * input.towThickness * TOW_COVERAGES_PER_RECIPE_LAYER;
    const layers: TLayerParameters[] = [];

    for (let index = 0; index < helicalLayerCount; index++) {
        layers.push({
            windType: ELayerType.HELICAL,
            windAngle: input.windAngle,
            patternNumber,
            skipIndex: 1,
            lockDegrees: input.lockDegrees,
            leadInMM: input.leadInMM,
            leadOutDegrees: input.leadOutDegrees,
            skipInitialNearLock: index > 0
        });
    }

    for (let index = 0; index < hoopLayerCount; index++) {
        layers.push({
            windType: ELayerType.HOOP,
            terminal: false
        });
    }

    return {
        windParameters: {
            layers,
            mandrelParameters: {
                diameter: input.diameter,
                windLength: input.windLength
            },
            towParameters: {
                width: input.towWidth,
                thickness: input.towThickness
            },
            defaultFeedRate: input.defaultFeedRate,
            deliveryHead: input.fixedDeliveryHead ? {
                mode: 'fixed',
                positionDegrees: input.fixedDeliveryHeadPosition as number
            } : undefined,
            disableSoftEndstops: input.disableSoftEndstops || undefined
        },
        summary: {
            layerMode: input.layerMode,
            requestedLayerCount,
            helicalLayerCount,
            hoopLayerCount,
            numCircuits,
            patternNumber,
            targetThickness: input.layerMode === 'thickness' ? input.targetThickness : undefined,
            achievedThickness
        },
        warnings: [
            'Layer distribution is a recipe preset, not a certified load rating.',
            'Thickness assumes each there-and-back layer deposits two complete tow coverages.',
            'Tow thickness is recorded but the current planner does not increase mandrel diameter between layers.',
            'Hoop and helical locks create trim regions at the ends of the part.'
        ]
    };
}

export function calculateHelicalCircuitCount(diameter: number, towWidth: number, windAngle: number): number {
    const mandrelCircumference = Math.PI * diameter;
    const towArcLength = towWidth / Math.cos(degToRad(windAngle));
    return Math.ceil(mandrelCircumference / towArcLength);
}

export function choosePatternNumber(numCircuits: number, maxPatternNumber = MAX_AUTO_PATTERN_NUMBER): number {
    const highestCandidate = Math.min(numCircuits, maxPatternNumber);
    for (let candidate = highestCandidate; candidate >= 1; candidate--) {
        if (numCircuits % candidate === 0) {
            return candidate;
        }
    }
    return 1;
}

function getHoopLayerCount(layerCount: number, strengthPreset: TStrengthPreset): number {
    const ratio = HOOP_RATIOS[strengthPreset];
    if (ratio === 0 || layerCount <= 1) {
        return 0;
    }

    const roundedHoopCount = Math.round(layerCount * ratio);
    return Math.max(1, Math.min(layerCount - 1, roundedHoopCount));
}

function getLayerCounts(input: ITubeRecipeInput): {requestedLayerCount: number; helicalLayerCount: number; hoopLayerCount: number} {
    let requestedLayerCount: number;
    if (input.layerMode === 'thickness') {
        const layerThickness = input.towThickness * TOW_COVERAGES_PER_RECIPE_LAYER;
        requestedLayerCount = Math.round((input.targetThickness || 0) / layerThickness);
    } else {
        requestedLayerCount = input.layerCount || PRESET_LAYER_COUNTS[input.strengthPreset];
    }

    const hoopLayerCount = getHoopLayerCount(requestedLayerCount, input.strengthPreset);
    return {
        requestedLayerCount,
        helicalLayerCount: requestedLayerCount - hoopLayerCount,
        hoopLayerCount
    };
}

function requirePositive(value: number | undefined, label: string, errors: string[]): void {
    if (!Number.isFinite(value) || value <= 0) {
        errors.push(`${label} must be greater than zero.`);
    }
}
