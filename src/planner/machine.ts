import { TCoordinate, ECoordinateAxes, AxisLookup, TCoordinateAxes, IPreviewContext, IPreviewSegment, TDeliveryHeadParameters } from './types';
import { stripPrecision } from '../helpers';
import { interpolateCoordinates, serializeCoordinate } from './helpers';

// Abstracts generating GCode while performing boundary checking, etc
export class WinderMachine {

    private verboseOutput: boolean;
    private gcode: string[] = [];
    private previewSegments: IPreviewSegment[] = [];
    private previewContext: IPreviewContext | null = null;

    // Profiler state
    private feedRateMMpM = 0;
    private totalTimeS = 0;
    private totalTowLengthMM = 0;
    private lastPosition: TCoordinateAxes;
    private mandrelDiameter: number;
    private deliveryHeadParameters: TDeliveryHeadParameters;

    constructor(mandrelDiameter: number, verboseOutput = false, deliveryHeadParameters: TDeliveryHeadParameters = {mode: 'automatic'}) {
        this.lastPosition = {
            [ECoordinateAxes.CARRIAGE]: 0,
            [ECoordinateAxes.MANDREL]: 0,
            [ECoordinateAxes.DELIVERY_HEAD]: deliveryHeadParameters.mode === 'fixed' ? deliveryHeadParameters.positionDegrees : 0
        }
        this.mandrelDiameter = mandrelDiameter;
        this.verboseOutput = verboseOutput;
        this.deliveryHeadParameters = deliveryHeadParameters;
    }

    public getGCode(): string[] {
        return this.gcode;
    }

    public getPreviewSegments(): IPreviewSegment[] {
        return this.previewSegments;
    }

    public setPreviewContext(previewContext: IPreviewContext): void {
        this.previewContext = previewContext;
    }

    public addRawGCode(command: string): void {
        this.gcode.push(command);
    }

    public setFeedRate(feedRateMMpM: number): void {
        this.feedRateMMpM = feedRateMMpM;
        this.gcode.push(`G0 F${stripPrecision(feedRateMMpM)}`);
    }

    public move(position: TCoordinate): void {
        const filteredPosition = this.filterDeliveryHeadPosition(position);
        if (Object.keys(filteredPosition).length === 0) {
            return;
        }
        // Construct a fully-specified destination coordinate
        // Start with the old position, and replace any values specified in the new one
        const completeEndPosition = {...this.lastPosition, ...filteredPosition};
        const doSegmentMove = this.lastPosition[ECoordinateAxes.CARRIAGE] !== completeEndPosition[ECoordinateAxes.CARRIAGE];
        // If we don't need to divide the move into multiple segments, run it as just one.
        if (!doSegmentMove) {
            if (this.verboseOutput) {
                this.insertComment(`Move from ${serializeCoordinate(this.lastPosition)} to ${serializeCoordinate(completeEndPosition)} as a simple move`);
            }
            return this.moveSegment(filteredPosition as TCoordinate);
        }
        // For segmented moves, divide the total move so each piece has ~1mm of carriage movement
        const numSegments = Math.round(Math.abs(this.lastPosition[ECoordinateAxes.CARRIAGE] - completeEndPosition[ECoordinateAxes.CARRIAGE])) + 1;
        if (this.verboseOutput) {
            this.insertComment(`Move from ${serializeCoordinate(this.lastPosition)} to ${serializeCoordinate(completeEndPosition)} in ${numSegments} segments`);
        }
        for (const intermediatePosition of interpolateCoordinates(this.lastPosition, completeEndPosition, numSegments)) {
            this.moveSegment(this.filterDeliveryHeadPosition(intermediatePosition) as TCoordinate);
        }
    }

    public setPosition(position: TCoordinate): void {
        const filteredPosition = this.filterDeliveryHeadPosition(position);
        if (Object.keys(filteredPosition).length === 0) {
            return;
        }
        let command = 'G92';
        for (const axis of Object.keys(filteredPosition)) {
            const rawAxis = AxisLookup[axis as ECoordinateAxes];
            command += ` ${rawAxis}${stripPrecision(filteredPosition[axis as ECoordinateAxes])}`;

            this.lastPosition[axis as ECoordinateAxes] = filteredPosition[axis as ECoordinateAxes] as number;
        }
        this.gcode.push(command);
    }

    // Moves carriage and delivery head to 0, advances the mandrel to the next 0 position and zeros all axes
    public zeroAxes(currentAngleDegrees: number): void {
        this.setPosition({
            [ECoordinateAxes.CARRIAGE]: 0,
            [ECoordinateAxes.MANDREL]: currentAngleDegrees % 360,
            [ECoordinateAxes.DELIVERY_HEAD]: 0
        });

        this.move({
            [ECoordinateAxes.MANDREL]: 360
        });

        this.setPosition({
            [ECoordinateAxes.MANDREL]: 0,
        });
    }

    public insertComment(text: string): void {
        this.gcode.push(`; ${text}`)
    }

    public getGCodeTimeS(): number {
        return this.totalTimeS;
    }

    public getTowLengthM(): number {
        return this.totalTowLengthMM / 1000;
    }

    // Update the mandrel diameter to a new value, useful for incrementing it to account for previous layers
    public setMandrelDiameter(mandrelDiameter: number): void {
        this.mandrelDiameter = mandrelDiameter;
    }

    // We have to split up moves into many tiny chunks, because marlin only allows pausing after a command completes
    private moveSegment(position: TCoordinate): void {
        const startPosition = {...this.lastPosition};
        const completeEndPosition = {...this.lastPosition, ...position};
        this.recordPreviewSegment(startPosition, completeEndPosition);

        // Distance of the move in "Marlin Units", used for time profiling
        //  Treats mandrel degrees as MM and accounts for delivery head movements, because that's what marlin does
        let totalDistanceMarlinUnitsSq = 0;
        // Total distance of the move in actual MM, taking into account mandrel diameter and ignoring delivery head
        let towLengthMMSq = 0;
        let command = 'G0';
        for (const axis in position) {
            const rawAxis = AxisLookup[axis as ECoordinateAxes];
            command += ` ${rawAxis}${stripPrecision(position[axis as ECoordinateAxes])}`;

            // Everything in this loop below here is just for the profiler

            // Get the amount this axis moved
            const moveComponent = position[axis as ECoordinateAxes] - this.lastPosition[axis as ECoordinateAxes];

            // Add this onto the tally of "marlin units" that we will use to estimate time
            totalDistanceMarlinUnitsSq += moveComponent ** 2;

            // Handles incrementing tow length
            switch (axis) {
                case ECoordinateAxes.MANDREL: {
                    // Mandrel units are actually degrees, so convert them to arc length
                    const arcLengthMM = moveComponent / 360 * this.mandrelDiameter * Math.PI;
                    towLengthMMSq += arcLengthMM ** 2;
                    break;
                }
                case ECoordinateAxes.CARRIAGE: {
                    // Carriage units are just MM
                    towLengthMMSq += moveComponent ** 2;
                    break;
                }
                case ECoordinateAxes.DELIVERY_HEAD:
                default: {
                    // Do not add delivery head movement onto the tow length because moving it doesn't unspool more
                    break;
                }
            }

            this.lastPosition[axis as ECoordinateAxes] = position[axis as ECoordinateAxes];
        }

        // Assumes instantaneous acceleration
        this.totalTimeS += totalDistanceMarlinUnitsSq ** 0.5 / this.feedRateMMpM * 60;
        this.totalTowLengthMM += towLengthMMSq ** 0.5;

        this.gcode.push(command);
    }

    private filterDeliveryHeadPosition(position: TCoordinateAxes | TCoordinate): Partial<TCoordinateAxes> {
        if (this.deliveryHeadParameters.mode !== 'fixed') {
            return position;
        }

        const filteredPosition = {...position};
        delete filteredPosition[ECoordinateAxes.DELIVERY_HEAD];
        return filteredPosition;
    }

    private recordPreviewSegment(startPosition: TCoordinateAxes, endPosition: TCoordinateAxes): void {
        if (!this.previewContext) {
            return;
        }

        const startX = startPosition[ECoordinateAxes.CARRIAGE];
        const startY = startPosition[ECoordinateAxes.MANDREL];
        const endX = endPosition[ECoordinateAxes.CARRIAGE];
        const endY = endPosition[ECoordinateAxes.MANDREL];

        if (startX === endX && startY === endY) {
            return;
        }

        this.previewSegments.push({
            ...this.previewContext,
            start: {
                x: startX,
                y: startY
            },
            end: {
                x: endX,
                y: endY
            }
        });
    }

}
