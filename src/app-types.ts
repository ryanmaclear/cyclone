import type { IPlanWindResult } from './planner';
import type { IGeneratedRecipe, ITubeRecipeInput } from './recipe';
import type { IWindParameters } from './planner/types';

export interface IPreviewRequest {
    recipeInput: ITubeRecipeInput;
}

export interface IPreviewResult {
    recipe: IGeneratedRecipe;
    plan: IPlanWindResult;
    plotDataUrl: string | null;
}

export interface ISaveArtifactsRequest {
    basePath: string;
    windParameters: IWindParameters;
    gcode: string[];
    plotPngBase64?: string | null;
}

export interface ISaveArtifactsResult {
    windPath: string;
    gcodePath: string;
    plotPath?: string;
}

export interface ISerialPortOption {
    path: string;
    manufacturer?: string;
    serialNumber?: string;
}

export interface ISerialConnectRequest {
    path: string;
    baudRate: number;
}

export interface IMarlinStatus {
    connected: boolean;
    paused: boolean;
    pausing: boolean;
    resuming: boolean;
    stopping: boolean;
    queuedCommands: number;
    totalCommands: number;
    sentCommands: number;
    portPath: string | null;
}

export interface ICycloneApi {
    generatePreview(request: IPreviewRequest): Promise<IPreviewResult>;
    chooseBasePath(): Promise<string | null>;
    saveArtifacts(request: ISaveArtifactsRequest): Promise<ISaveArtifactsResult>;
    listSerialPorts(): Promise<ISerialPortOption[]>;
    connectSerial(request: ISerialConnectRequest): Promise<IMarlinStatus>;
    disconnectSerial(): Promise<IMarlinStatus>;
    runGCode(commands: string[]): Promise<IMarlinStatus>;
    pauseMachine(): Promise<IMarlinStatus>;
    resumeMachine(): Promise<IMarlinStatus>;
    clearMachineQueue(): Promise<IMarlinStatus>;
    onSerialStatus(callback: (status: IMarlinStatus) => void): () => void;
    onSerialLog(callback: (message: string) => void): () => void;
}
