import { ECoordinateAxes, TCoordinateAxes } from './planner/types';

export type TGCodeDialect = 'marlin' | 'klipper';

export const DEFAULT_GCODE_DIALECT: TGCodeDialect = 'marlin';

const GCODE_AXIS_LOOKUPS: Record<TGCodeDialect, Record<keyof TCoordinateAxes, string>> = {
    marlin: {
        [ECoordinateAxes.CARRIAGE]: 'X',
        [ECoordinateAxes.MANDREL]: 'Y',
        [ECoordinateAxes.DELIVERY_HEAD]: 'Z'
    },
    klipper: {
        [ECoordinateAxes.CARRIAGE]: 'X',
        [ECoordinateAxes.MANDREL]: 'R',
        [ECoordinateAxes.DELIVERY_HEAD]: 'Z'
    }
};

export function isGCodeDialect(value: unknown): value is TGCodeDialect {
    return value === 'marlin' || value === 'klipper';
}

export function normalizeGCodeDialect(value: unknown): TGCodeDialect {
    return isGCodeDialect(value) ? value : DEFAULT_GCODE_DIALECT;
}

export function getGCodeAxisLookup(dialect: TGCodeDialect): Record<keyof TCoordinateAxes, string> {
    return GCODE_AXIS_LOOKUPS[dialect];
}

export function getMandrelGCodeAxis(dialect: TGCodeDialect): string {
    return getGCodeAxisLookup(dialect)[ECoordinateAxes.MANDREL];
}
