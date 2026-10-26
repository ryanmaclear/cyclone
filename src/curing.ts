import { stripPrecision } from './helpers';

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
export const MAX_CURING_DURATION_MINUTES = 168 * 60;
export const CURING_SECTION_START = '; Curing cycle start';
export const CURING_WARNINGS = [
    'Appended curing uses nominal RPM and duration; controller motion limits may extend the actual runtime.',
    'Curing disables software endstops and leaves them disabled after completion.'
];

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
        errors.push('Curing duration cannot exceed 168 hours.');
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

export function generateCuringPlan(value: unknown): ICuringPlan {
    const parameters = parseCuringParameters(value);
    const feedRateDegreesPerMinute = parameters.rpm * 360;
    const chunkDegrees = parameters.rpm * 360 * CURING_CHUNK_SECONDS / 60;
    const chunkCount = parameters.durationMinutes * 60 / CURING_CHUNK_SECONDS;
    const directionMultiplier = parameters.direction === 'positive' ? 1 : -1;
    const gcode = [
        CURING_SECTION_START,
        `; Requested ${stripPrecision(parameters.rpm)} RPM for ${parameters.durationMinutes} minute${parameters.durationMinutes === 1 ? '' : 's'} in ${parameters.direction} Y`,
        'G21',
        'G90',
        'M211 S0'
    ];

    for (let index = 0; index < chunkCount; index++) {
        gcode.push('G92 Y0');
        gcode.push(`G1 Y${stripPrecision(directionMultiplier * chunkDegrees)} F${stripPrecision(feedRateDegreesPerMinute)}`);
        gcode.push('M400');
    }

    gcode.push('G92 Y0');
    gcode.push('; Curing cycle complete');

    return {
        gcode,
        totalTimeS: parameters.durationMinutes * 60,
        totalRotations: parameters.rpm * parameters.durationMinutes,
        feedRateDegreesPerMinute,
        chunkCount
    };
}
