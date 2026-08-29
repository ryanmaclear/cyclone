import { SerialPort, ReadlineParser } from 'serialport';
import { isObject } from './helpers';
import { IMarlinStatus } from './app-types';

export interface IMarlinPortEvents {
    onStatus?: (status: IMarlinStatus) => void;
    onLog?: (message: string) => void;
}

export interface IMarlinConnection {
    initialize(): Promise<void>;
    disconnect(): Promise<void>;
    queueCommand(line: string): void;
    queueCommands(lines: string[]): void;
    clearQueue(): void;
    pause(): void;
    resume(): void;
    getStatus(): IMarlinStatus;
}

export class MarlinPort implements IMarlinConnection {
    
    private isInitialized = false;
    private disconnecting = false;
    private port: SerialPort;
    private parser: ReadlineParser;

    private commandQueue: string[] = [];
    private hasCommandWaiting = false;

    private pausing = false;
    private paused = false;
    private resuming = false;
    private stopping = false;
    private totalCommands = 0;
    private sentCommands = 0;

    constructor( private portPath: string, private verbose = false, private baudRate = 250000, private events: IMarlinPortEvents = {} ) {

    }

    public async initialize(): Promise<void> {
        if (this.isInitialized) {
            return void 0;
        }

        this.hasCommandWaiting = false;

        this.port = new SerialPort({
          path: this.portPath,
          baudRate: this.baudRate,
          autoOpen: false
        });
        this.port.on('close', (error: Error | null) => this.handlePortClose(error));
        this.port.on('error', (error: Error) => this.log(`Serial port error: ${error.message}`));

        // TODO: .off this in reset
        this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\n' }))
        this.parser.on('data', (line) => {
            this.processSerialResponseLine(line)
        });

        return new Promise((resolve, reject) => {
            this.log(`Opening "${this.portPath}" at ${this.baudRate} baud`);
            this.port.open((error) => {
              if (isObject(error)) {
                return reject(`Error opening port: ${error.message}`);
              }
              this.log('Port opened.');
              this.isInitialized = true;
              this.tryNextCommand();
              this.emitStatus();
              resolve();
            })
        });
    }

    public reset(): void {
        this.hasCommandWaiting = false;
        this.commandQueue = [];
        this.pausing = false;
        this.paused = false;
        this.resuming = false;
        this.stopping = false;
        this.totalCommands = 0;
        this.sentCommands = 0;

        this.isInitialized = false;
        this.emitStatus();
        return void 0;
    }

    public async disconnect(): Promise<void> {
        this.hasCommandWaiting = false;
        this.commandQueue = [];
        this.pausing = false;
        this.paused = false;
        this.resuming = false;
        this.stopping = false;

        if (!this.port || !this.port.isOpen) {
            this.reset();
            return void 0;
        }

        this.disconnecting = true;
        try {
            await new Promise<void>((resolve, reject) => {
                this.port.close((error) => {
                    if (isObject(error)) {
                        reject(`Error closing port: ${error.message}`);
                        return;
                    }
                    resolve();
                });
            });
        } finally {
            this.disconnecting = false;
        }
        this.reset();
    }

    private handlePortClose(error: Error | null): void {
        if (this.disconnecting || !this.isInitialized) {
            return;
        }
        this.log(error ? `Serial port disconnected: ${error.message}` : 'Serial port disconnected.');
        this.reset();
    }

    public queueCommand(line: string): void {
        if (this.isMachineCommand(line)) {
            this.totalCommands += 1;
        }
        this.commandQueue.push(line);
        this.tryNextCommand();
        this.emitStatus();
    }

    public queueCommands(lines: string[]): void {
        this.commandQueue = [];
        this.totalCommands = 0;
        this.sentCommands = 0;
        for (const line of lines) {
            this.queueCommand(line);
        }
    }

    public clearQueue(): void {
        this.commandQueue = [];
        if (this.paused || this.pausing) {
            this.stopping = true;
            this.pausing = false;
            this.paused = false;
            this.resuming = true;
            this.log('Stopping run.');
            this.writeCommand('M108');
            this.emitStatus();
            return void 0;
        }
        if (this.resuming) {
            this.stopping = true;
            this.log('Stopping run.');
            this.emitStatus();
            return void 0;
        }
        if (this.hasCommandWaiting) {
            this.stopping = true;
            this.log('Stopping run after the active command completes.');
            this.emitStatus();
            return void 0;
        }
        this.completeStop();
    }

    private completeStop(): void {
        this.commandQueue = [];
        this.hasCommandWaiting = false;
        this.pausing = false;
        this.paused = false;
        this.resuming = false;
        this.stopping = false;
        this.totalCommands = 0;
        this.sentCommands = 0;
        this.emitStatus();
    }

    public pause(): void {
        if (this.paused || this.pausing || this.resuming) {
            this.log('Cannot pause when already paused or resuming!');
            return void 0;
        }
        if (!this.hasCommandWaiting && this.commandQueue.length === 0) {
            this.log('Cannot pause when no run is active!');
            return void 0;
        }
        this.pausing = true;
        this.writeCommand('M0');
        this.emitStatus();
    }

    public completePause(): void {
        this.pausing = false;
        this.paused = true;
        this.log('Machine paused.');
        this.emitStatus();
    }

    public isPaused(): boolean {
        return this.paused || this.pausing;
    }

    public resume(): void {
        if (!this.paused || this.resuming) {
            this.log('Cannot resume when already resuming or not paused!');
            return void 0;
        }
        this.resuming = true;
        this.log('Resuming machine.');
        this.writeCommand('M108');
        this.emitStatus();
    }

    public completeResume(): void {
        if (!this.paused || !this.resuming) {
            console.log('Cannot complete resume while not paused or resuming!');
            return void 0;
        }
        this.pausing = false;
        this.paused = false;
        this.resuming = false;
        this.tryNextCommand();
        this.emitStatus();
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
            portPath: this.isInitialized ? this.portPath : null
        };
    }

    private processSerialResponseLine(rawLine: string): void {
        const line = rawLine.trim();

        if ( line === 'ok' ) {
            if (this.stopping) {
                this.completeStop();
                return void 0;
            }
            if (this.resuming) {
                this.completeResume();
                return void 0;
            }
            this.hasCommandWaiting = false; 
            this.tryNextCommand();
            this.emitStatus();
            return void 0;
        }

        if ( line === 'echo:busy: processing' ) {
            return void 0;
        }

        if (this.isPauseResponse(line)) {
            if (this.pausing) {
                this.completePause();
            }
            return void 0;
        }

        if ( line === '//action:notification 3D Printer Ready.') {
            if (this.stopping) {
                this.completeStop();
                return void 0;
            }
            if (!this.resuming) {
                this.log('Saw resume response while not resuming!');
                return void 0;
            }
            this.completeResume();
            return void 0;
        }

        this.log(line);
        return void 0;
    }

    private isPauseResponse(line: string): boolean {
        return line === 'echo:busy: paused for user'
            || line === '//action:notification Click to Resume...'
            || line === 'Machine paused.';
    }

    private tryNextCommand(): void {
        if (this.hasCommandWaiting || this.commandQueue.length === 0 || this.paused || this.pausing || this.resuming || this.stopping) {
            return void 0;
        }
        const commandToSend = this.commandQueue.shift();
        // Check for comments
        if (commandToSend.slice(0, 1) === ';') {
            this.log(commandToSend.slice(1).trim())
            return this.tryNextCommand();
        }
        if (this.verbose) {
            this.log(`Sending "${commandToSend}"`);
        }
        this.hasCommandWaiting = true;
        this.sentCommands += 1;
        this.emitStatus();
        this.writeCommand(commandToSend);
    }

    private writeCommand(command: string): void {
        this.port.write(`${command}\n`);
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
