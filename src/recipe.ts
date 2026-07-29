import { degToRad } from './helpers';
import { ELayerType, IWindParameters, TLayerParameters } from './planner/types';

export type TStrengthPreset = 'light' | 'medium' | 'heavy';
export type TLayerMode = 'count' | 'thickness' | 'custom';
export type TRecipeSummaryMode = TLayerMode | 'artifact';
export type TCustomRecipeLayer =
    | {windType: 'helical'; windAngle: number}
    | {windType: 'hoop'};

export interface ITubeRecipeInput {
    diameter: number;
    windLength: number;
    windAngle: number;
    strengthPreset: TStrengthPreset;
    layerMode: TLayerMode;
    layerCount?: number;
    targetThickness?: number;
    customLayers?: TCustomRecipeLayer[];
    includeTerminalHoop?: boolean;
    terminalFinalHoop?: boolean;
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
    layerMode: TRecipeSummaryMode;
    requestedLayerCount: number;
    helicalLayerCount: number;
    hoopLayerCount: number;
    skipLayerCount?: number;
    numCircuits?: number;
    patternNumber?: number;
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

    if (input.layerMode !== 'count' && input.layerMode !== 'thickness' && input.layerMode !== 'custom') {
        errors.push('Recipe method must be layer count, total thickness, or custom layers.');
    }

    if (input.layerMode !== 'custom') {
        validateWindAngle(input.windAngle, 'Winding angle', errors);
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

    if (input.layerMode === 'custom') {
        const customLayers = Array.isArray(input.customLayers) ? input.customLayers : [];
        if (!Array.isArray(input.customLayers)) {
            errors.push('Custom layers must be an array.');
        }
        if (typeof input.includeTerminalHoop !== 'undefined' && typeof input.includeTerminalHoop !== 'boolean') {
            errors.push('Final single-pass hoop selection must be true or false.');
        }
        if (customLayers.length === 0 && !input.includeTerminalHoop) {
            errors.push('Custom layers must include at least one layer or a final single-pass hoop.');
        }

        customLayers.forEach((layer, index) => {
            if (!layer || (layer.windType !== ELayerType.HELICAL && layer.windType !== ELayerType.HOOP)) {
                errors.push(`Custom layer ${index + 1} must be helical or hoop.`);
                return;
            }
            if (layer.windType === ELayerType.HELICAL) {
                validateWindAngle(layer.windAngle, `Custom layer ${index + 1} angle`, errors);
            }
        });
    }

    if (typeof input.terminalFinalHoop !== 'undefined' && typeof input.terminalFinalHoop !== 'boolean') {
        errors.push('Terminal final hoop selection must be true or false.');
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

    if (input.layerMode !== 'custom' && !Object.prototype.hasOwnProperty.call(PRESET_LAYER_COUNTS, input.strengthPreset)) {
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

    const customMode = input.layerMode === 'custom';
    const layers = customMode ? buildCustomLayers(input) : buildStandardLayers(input);
    const requestedLayerCount = layers.length;
    const helicalLayerCount = layers.filter((layer) => layer.windType === ELayerType.HELICAL).length;
    const hoopLayerCount = layers.filter((layer) => layer.windType === ELayerType.HOOP).length;
    const numCircuits = customMode ? undefined : calculateHelicalCircuitCount(input.diameter, input.towWidth, input.windAngle);
    const patternNumber = typeof numCircuits === 'number' ? choosePatternNumber(numCircuits) : undefined;
    const terminalLayerCount = layers.filter((layer) => layer.windType === ELayerType.HOOP && layer.terminal).length;
    const coverageCount = requestedLayerCount * TOW_COVERAGES_PER_RECIPE_LAYER - terminalLayerCount;
    const achievedThickness = coverageCount * input.towThickness;

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
            ...(customMode ? [] : ['Layer distribution is a recipe preset, not a certified load rating.']),
            'Thickness assumes each there-and-back layer deposits two complete tow coverages.',
            ...(terminalLayerCount > 0 ? ['The final single-pass hoop contributes one tow coverage.'] : []),
            'Tow thickness is recorded but the current planner does not increase mandrel diameter between layers.',
            'Hoop and helical locks create trim regions at the ends of the part.'
        ]
    };
}

function buildStandardLayers(input: ITubeRecipeInput): TLayerParameters[] {
    const layerCounts = getLayerCounts(input);
    const numCircuits = calculateHelicalCircuitCount(input.diameter, input.towWidth, input.windAngle);
    const patternNumber = choosePatternNumber(numCircuits);
    const layers: TLayerParameters[] = [];

    for (let index = 0; index < layerCounts.helicalLayerCount; index++) {
        layers.push(createHelicalLayer(input, input.windAngle, patternNumber, index > 0));
    }

    for (let index = 0; index < layerCounts.hoopLayerCount; index++) {
        layers.push({
            windType: ELayerType.HOOP,
            terminal: input.layerMode === 'count'
                && input.terminalFinalHoop === true
                && index === layerCounts.hoopLayerCount - 1
        });
    }

    return layers;
}

function buildCustomLayers(input: ITubeRecipeInput): TLayerParameters[] {
    const layers: TLayerParameters[] = (input.customLayers || []).map((layer, index) => {
        if (layer.windType === ELayerType.HOOP) {
            return {
                windType: ELayerType.HOOP,
                terminal: false
            };
        }

        const numCircuits = calculateHelicalCircuitCount(input.diameter, input.towWidth, layer.windAngle);
        return createHelicalLayer(input, layer.windAngle, choosePatternNumber(numCircuits), index > 0);
    });

    if (input.includeTerminalHoop) {
        layers.push({
            windType: ELayerType.HOOP,
            terminal: true
        });
    }

    return layers;
}

function createHelicalLayer(
    input: ITubeRecipeInput,
    windAngle: number,
    patternNumber: number,
    skipInitialNearLock: boolean
): TLayerParameters {
    return {
        windType: ELayerType.HELICAL,
        windAngle,
        patternNumber,
        skipIndex: 1,
        lockDegrees: input.lockDegrees,
        leadInMM: input.leadInMM,
        leadOutDegrees: input.leadOutDegrees,
        skipInitialNearLock
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

function validateWindAngle(value: number, label: string, errors: string[]): void {
    if (!Number.isFinite(value) || value < MIN_WIND_ANGLE_DEGREES || value > MAX_WIND_ANGLE_DEGREES) {
        errors.push(`${label} must be between ${MIN_WIND_ANGLE_DEGREES} and ${MAX_WIND_ANGLE_DEGREES} degrees.`);
    }
}
