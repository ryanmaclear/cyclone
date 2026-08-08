import { IMarlinStatus } from './app-types';
import { IMarlinConnection, IMarlinPortEvents } from './marlin-port';

export const SERIAL_EMULATOR_PATH = 'cyclone://marlin-emulator';
export const SERIAL_EMULATOR_NAME = 'Marlin Serial Emulator';

export class MarlinEmulator implements IMarlinConnection {
    private isInitialized = false;
    private commandQueue: string[] = [];
    private hasCommandWaiting = false;
    private pausing = false;
    private paused = false;
    private resuming = false;
    private stopping = false;
    private totalCommands = 0;
    private sentCommands = 0;
    private generation = 0;

    constructor(private events: IMarlinPortEvents = {}) {
    }

    public async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }
        this.isInitialized = true;
        this.log('[Emulator] Marlin serial connection opened.');
        this.emitStatus();
        this.tryNextCommand();
    }

    public async disconnect(): Promise<void> {
        this.generation += 1;
        this.isInitialized = false;
        this.commandQueue = [];
        this.hasCommandWaiting = false;
        this.pausing = false;
        this.paused = false;
        this.resuming = false;
        this.stopping = false;
        this.totalCommands = 0;
        this.sentCommands = 0;
        this.log('[Emulator] Marlin serial connection closed.');
        this.emitStatus();
    }

    public queueCommand(line: string): void {
        this.assertConnected();
        if (this.isMachineCommand(line)) {
            this.totalCommands += 1;
        }
        this.commandQueue.push(line);
        this.tryNextCommand();
        this.emitStatus();
    }

    public queueCommands(lines: string[]): void {
        this.assertConnected();
        this.commandQueue = [];
        this.totalCommands = 0;
        this.sentCommands = 0;
        for (const line of lines) {
            this.queueCommand(line);
        }
    }

    public clearQueue(): void {
        this.commandQueue = [];
        if (this.hasCommandWaiting) {
            this.stopping = true;
            this.log('[Emulator] Stopping after the active command completes.');
            this.emitStatus();
            return;
        }
        this.completeStop();
    }

    public pause(): void {
        if (this.paused || this.pausing || this.resuming) {
            this.log('[Emulator] Cannot pause when already paused or resuming.');
            return;
        }
        if (!this.hasCommandWaiting && this.commandQueue.length === 0) {
            this.log('[Emulator] Cannot pause when no run is active.');
            return;
        }
        this.pausing = true;
        this.log('[Emulator] > M0');
        this.emitStatus();
        this.schedule(() => {
            this.pausing = false;
            this.paused = true;
            this.log('echo:busy: paused for user');
            this.log('[Emulator] Machine paused.');
            this.emitStatus();
        });
    }

    public resume(): void {
        if (!this.paused || this.resuming) {
            this.log('[Emulator] Cannot resume when already resuming or not paused.');
            return;
        }
        this.resuming = true;
        this.log('[Emulator] > M108');
        this.emitStatus();
        this.schedule(() => {
            this.paused = false;
            this.resuming = false;
            this.log('//action:notification 3D Printer Ready.');
            this.tryNextCommand();
            this.emitStatus();
        });
    }

    public getStatus(): IMarlinStatus {
        return {
            connected: this.isInitialized,
            paused: this.paused,
            pausing: this.pausing,
            resuming: this.resuming,
            stopping: this.stopping,
            queuedCommands: this.commandQueue.length,
            totalCommands: this.totalCommands,
            sentCommands: this.sentCommands,
            portPath: this.isInitialized ? SERIAL_EMULATOR_NAME : null
        };
    }

    private tryNextCommand(): void {
        if (!this.isInitialized || this.hasCommandWaiting || this.commandQueue.length === 0
            || this.paused || this.pausing || this.resuming || this.stopping) {
            return;
        }

        const command = this.commandQueue.shift();
        if (command.slice(0, 1) === ';') {
            this.log(command.slice(1).trim());
            this.tryNextCommand();
            return;
        }

        this.hasCommandWaiting = true;
        this.sentCommands += 1;
        this.log(`[Emulator] > ${command}`);
        this.emitStatus();
        this.schedule(() => {
            this.log('ok');
            this.hasCommandWaiting = false;
            if (this.stopping) {
                this.completeStop();
                return;
            }
            this.tryNextCommand();
            this.emitStatus();
        });
    }

    private completeStop(): void {
        this.generation += 1;
        this.commandQueue = [];
        this.hasCommandWaiting = false;
        this.pausing = false;
        this.paused = false;
        this.resuming = false;
        this.stopping = false;
        this.totalCommands = 0;
        this.sentCommands = 0;
        this.log('[Emulator] Run stopped.');
        this.emitStatus();
    }

    private schedule(callback: () => void): void {
        const scheduledGeneration = this.generation;
        setImmediate(() => {
            if (this.isInitialized && scheduledGeneration === this.generation) {
                callback();
            }
        });
    }

    private assertConnected(): void {
        if (!this.isInitialized) {
            throw new Error('Connect to the serial emulator before sending G-code.');
        }
    }

    private isMachineCommand(line: string): boolean {
        return line.trim().length > 0 && line.trim().slice(0, 1) !== ';';
    }

    private emitStatus(): void {
        if (this.events.onStatus) {
            this.events.onStatus(this.getStatus());
        }
    }

    private log(message: string): void {
        if (this.events.onLog) {
            this.events.onLog(message);
            return;
        }
        console.log(message);
    }
}
