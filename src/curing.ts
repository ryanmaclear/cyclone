import { stripPrecision } from './helpers';
import {
    DEFAULT_GCODE_DIALECT,
    getMandrelGCodeAxis,
    normalizeGCodeDialect,
    TGCodeDialect
} from './gcode-dialect';

export type TCuringDirection = 'positive' | 'negative';

export interface ICuringParameters {
    rpm: number;
    durationMinutes: number;
    direction: TCuringDirection;
}

export interface ICuringPlan {
    gcode: string[];
    totalTimeS: number;
    totalRotations: number;
    feedRateDegreesPerMinute: number;
    chunkCount: number;
}

export interface ICuringValidationResult {
    valid: boolean;
    errors: string[];
}

export const CURING_CHUNK_SECONDS = 10;
export const MAX_CURING_DURATION_MINUTES = 72 * 60;
export const CURING_SECTION_START = '; Curing cycle start';
export function getCuringWarnings(value: unknown): string[] {
    const dialect = normalizeGCodeDialect(value);
    return [
        'Appended curing uses nominal RPM and duration; controller motion limits may extend the actual runtime.',
        dialect === 'marlin'
            ? 'Curing disables software endstops and leaves them disabled after completion.'
            : 'Klipper curing does not emit Marlin software-endstop commands; configure axis limits in Klipper.'
    ];
}

export const CURING_WARNINGS = getCuringWarnings(DEFAULT_GCODE_DIALECT);

export function validateCuringParameters(value: unknown): ICuringValidationResult {
    const errors: string[] = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {
            valid: false,
            errors: ['Curing parameters must be an object.']
        };
    }

    const parameters = value as Record<string, unknown>;
    if (typeof parameters.rpm !== 'number' || !Number.isFinite(parameters.rpm) || parameters.rpm <= 0) {
        errors.push('Curing RPM must be greater than zero.');
    }
    if (!Number.isInteger(parameters.durationMinutes) || (parameters.durationMinutes as number) < 1) {
        errors.push('Curing duration must be a positive whole number of minutes.');
    } else if ((parameters.durationMinutes as number) > MAX_CURING_DURATION_MINUTES) {
        errors.push('Curing duration cannot exceed 72 hours.');
    }
    if (parameters.direction !== 'positive' && parameters.direction !== 'negative') {
        errors.push('Curing direction must be positive or negative.');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

export function parseCuringParameters(value: unknown): ICuringParameters {
    const validation = validateCuringParameters(value);
    if (!validation.valid) {
        throw new Error(validation.errors.join(' '));
    }
    const parameters = value as ICuringParameters;
    return {
        rpm: parameters.rpm,
        durationMinutes: parameters.durationMinutes,
        direction: parameters.direction
    };
}

export function generateCuringPlan(
    value: unknown,
    gcodeDialect: TGCodeDialect = DEFAULT_GCODE_DIALECT
): ICuringPlan {
    const parameters = parseCuringParameters(value);
    const dialect = normalizeGCodeDialect(gcodeDialect);
    const mandrelAxis = getMandrelGCodeAxis(dialect);
    const feedRateDegreesPerMinute = parameters.rpm * 360;
    const chunkDegrees = parameters.rpm * 360 * CURING_CHUNK_SECONDS / 60;
    const chunkCount = parameters.durationMinutes * 60 / CURING_CHUNK_SECONDS;
    const directionMultiplier = parameters.direction === 'positive' ? 1 : -1;
    const gcode = [
        CURING_SECTION_START,
        `; Requested ${stripPrecision(parameters.rpm)} RPM for ${parameters.durationMinutes} minute${parameters.durationMinutes === 1 ? '' : 's'} in ${parameters.direction} ${mandrelAxis}`,
        ...(dialect === 'marlin' ? ['G21'] : []),
        'G90',
        ...(dialect === 'marlin' ? ['M211 S0'] : []),
        `G92 ${mandrelAxis}0`
    ];

    for (let index = 0; index < chunkCount; index++) {
        const targetDegrees = directionMultiplier * chunkDegrees * (index + 1);
        gcode.push(`G1 ${mandrelAxis}${stripPrecision(targetDegrees)} F${stripPrecision(feedRateDegreesPerMinute)}`);
    }

    gcode.push('M400');
    gcode.push(`G92 ${mandrelAxis}0`);
    gcode.push('; Curing cycle complete');

    return {
        gcode,
        totalTimeS: parameters.durationMinutes * 60,
        totalRotations: parameters.rpm * parameters.durationMinutes,
        feedRateDegreesPerMinute,
        chunkCount
    };
}
