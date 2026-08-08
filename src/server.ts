import * as express from 'express';
import { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Readable } from 'stream';
import { SerialPort } from 'serialport';
import { IMarlinConnection } from './marlin-port';
import { createMarlinConnection, getSerialEmulatorPortOption } from './serial-connection';
import { planWindDetailed } from './planner';
import { plotGCode } from './plotter';
import { generateTubeRecipe } from './recipe';
import { createArtifactRecipe } from './artifact';
import { getServerConfig } from './server-config';
import {
    IArtifactPreviewRequest,
    IMarlinStatus,
    IPreviewRequest,
    ISaveArtifactsRequest,
    ISerialConnectRequest
} from './app-types';

const disconnectedStatus: IMarlinStatus = {
    connected: false,
    paused: false,
    pausing: false,
    resuming: false,
    stopping: false,
    queuedCommands: 0,
    totalCommands: 0,
    sentCommands: 0,
    portPath: null
};

const config = getServerConfig();
const app = express();
const server = http.createServer(app);
const wsServer = new WebSocketServer({ server, path: '/api/events' });

app.use(express.json({ limit: '2mb' }));
app.use('/', express.static(config.staticRoot));

let marlin: IMarlinConnection | null = null;
let serialEmulatorEnabled = false;
const sockets = new Set<WebSocket>();
type TEmptyParams = Record<string, never>;

function broadcast(event: string, payload: unknown): void {
    const message = JSON.stringify({ event, payload });
    sockets.forEach((socket) => {
        socket.send(message);
    });
}

function sendSerialStatus(status: IMarlinStatus): void {
    broadcast('serial:status', status);
}

function sendSerialLog(message: string): void {
    broadcast('serial:log', message);
}

app.get('/api/health', (_request: Request, response: Response) => {
    response.json({ ok: true });
});

app.post('/api/recipe/preview', async (request: Request<TEmptyParams, unknown, IPreviewRequest>, response: Response) => {
    try {
        const recipe = generateTubeRecipe(request.body.recipeInput);
        const plan = planWindDetailed(recipe.windParameters, false, false);
        const plotStream = plotGCode(plan.gcode);
        const plotDataUrl = plotStream ? `data:image/png;base64,${(await streamToBuffer(plotStream)).toString('base64')}` : null;
        response.json({ recipe, plan, plotDataUrl });
    } catch (error) {
        response.status(400).json({ error: getErrorMessage(error) });
    }
});

app.post('/api/artifact/preview', async (request: Request<TEmptyParams, unknown, IArtifactPreviewRequest>, response: Response) => {
    try {
        const recipe = createArtifactRecipe(request.body.windParameters);
        const plan = planWindDetailed(recipe.windParameters, false, false);
        if (plan.layers.length !== recipe.windParameters.layers.length) {
            throw new Error('Artifact could not be fully planned.');
        }
        const plotStream = plotGCode(plan.gcode);
        const plotDataUrl = plotStream ? `data:image/png;base64,${(await streamToBuffer(plotStream)).toString('base64')}` : null;
        response.json({ recipe, plan, plotDataUrl });
    } catch (error) {
        response.status(400).json({ error: getErrorMessage(error) });
    }
});

app.post('/api/recipe/artifacts', async (request: Request<TEmptyParams, unknown, ISaveArtifactsRequest>, response: Response) => {
    try {
        const basePath = getArtifactBasePath(request.body.basePath);
        const windPath = `${basePath}.wind`;
        const gcodePath = `${basePath}.gcode`;
        const plotPath = request.body.plotPngBase64 ? `${basePath}.png` : undefined;

        await fs.writeFile(windPath, JSON.stringify(request.body.windParameters, null, 2));
        await fs.writeFile(gcodePath, request.body.gcode.join('\n'));
        if (plotPath && request.body.plotPngBase64) {
            await fs.writeFile(plotPath, new Uint8Array(Buffer.from(request.body.plotPngBase64, 'base64')));
        }
        response.json({ windPath, gcodePath, plotPath });
    } catch (error) {
        response.status(400).json({ error: getErrorMessage(error) });
    }
});

app.get('/api/serial/ports', async (_request: Request, response: Response) => {
    try {
        const ports = await SerialPort.list();
        const options = ports.map((port) => ({
            path: port.path,
            manufacturer: port.manufacturer,
            serialNumber: port.serialNumber
        }));
        response.json(serialEmulatorEnabled ? [...options, getSerialEmulatorPortOption()] : options);
    } catch (error) {
        response.status(400).json({ error: getErrorMessage(error) });
    }
});

app.post('/api/serial/emulator', (request: Request<TEmptyParams, unknown, { enabled: boolean }>, response: Response) => {
    try {
        if (marlin && marlin.getStatus().connected) {
            throw new Error('Disconnect from the serial port before changing the emulator.');
        }
        serialEmulatorEnabled = request.body.enabled === true;
        response.json(serialEmulatorEnabled);
    } catch (error) {
        response.status(400).json({ error: getErrorMessage(error) });
    }
});

app.post('/api/serial/connect', async (request: Request<TEmptyParams, unknown, ISerialConnectRequest>, response: Response) => {
    try {
        if (marlin) {
            await marlin.disconnect();
        }
        marlin = createMarlinConnection(request.body.path, request.body.baudRate, serialEmulatorEnabled, {
            onStatus: sendSerialStatus,
            onLog: sendSerialLog
        });
        await marlin.initialize();
        response.json(marlin.getStatus());
    } catch (error) {
        response.status(400).json({ error: getErrorMessage(error) });
    }
});

app.post('/api/serial/disconnect', async (_request: Request, response: Response) => {
    try {
        if (!marlin) {
            response.json(disconnectedStatus);
            return;
        }
        await marlin.disconnect();
        marlin = null;
        sendSerialStatus(disconnectedStatus);
        response.json(disconnectedStatus);
    } catch (error) {
        response.status(400).json({ error: getErrorMessage(error) });
    }
});

app.post('/api/serial/run', async (request: Request<TEmptyParams, unknown, { commands: string[] }>, response: Response) => {
    try {
        if (!marlin) {
            throw new Error('Connect to a serial port before running G-code.');
        }
        marlin.queueCommands(request.body.commands);
        response.json(marlin.getStatus());
    } catch (error) {
        response.status(400).json({ error: getErrorMessage(error) });
    }
});

app.post('/api/serial/manual', (request: Request<TEmptyParams, unknown, { command: string }>, response: Response) => {
    try {
        if (!marlin || !marlin.getStatus().connected) {
            throw new Error('Connect to a serial port before sending G-code.');
        }
        const command = typeof request.body.command === 'string' ? request.body.command.trim() : '';
        if (!command) {
            throw new Error('Enter a G-code command to send.');
        }
        marlin.queueCommand(command);
        response.json(marlin.getStatus());
    } catch (error) {
        response.status(400).json({ error: getErrorMessage(error) });
    }
});

app.post('/api/serial/pause', (_request: Request, response: Response) => {
    try {
        if (!marlin) {
            throw new Error('Connect to a serial port before pausing.');
        }
        marlin.pause();
        response.json(marlin.getStatus());
    } catch (error) {
        response.status(400).json({ error: getErrorMessage(error) });
    }
});

app.post('/api/serial/resume', (_request: Request, response: Response) => {
    try {
        if (!marlin) {
            throw new Error('Connect to a serial port before resuming.');
        }
        marlin.resume();
        response.json(marlin.getStatus());
    } catch (error) {
        response.status(400).json({ error: getErrorMessage(error) });
    }
});

app.post('/api/serial/clear', (_request: Request, response: Response) => {
    if (!marlin) {
        response.json(disconnectedStatus);
        return;
    }
    marlin.clearQueue();
    response.json(marlin.getStatus());
});

wsServer.on('connection', (socket: WebSocket) => {
    sockets.add(socket);
    socket.send(JSON.stringify({ event: 'serial:status', payload: marlin ? marlin.getStatus() : disconnectedStatus }));
    (socket as unknown as { on(event: 'close', callback: () => void): void }).on('close', () => sockets.delete(socket));
});

app.get('/', (_request: Request, response: Response) => {
    response.sendFile(path.join(config.staticRoot, config.indexFile));
});

app.use((error: Error, _request: Request, response: Response, _next: () => void) => {
    response.status(400).json({ error: error.message });
});

server.listen(config.port, config.host, () => {
    console.log(`Cyclone server listening on http://${config.host}:${config.port}`);
});

function getArtifactBasePath(filePath: string): string {
    const parsedPath = path.parse(filePath);
    const extension = parsedPath.ext.toLowerCase();
    if (extension === '.wind' || extension === '.gcode' || extension === '.png') {
        return path.join(parsedPath.dir, parsedPath.name);
    }
    return filePath;
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        stream.on('data', (chunk: Buffer | string | Uint8Array) => {
            chunks.push(Buffer.isBuffer(chunk) ? new Uint8Array(chunk) : new Uint8Array(Buffer.from(chunk)));
        });
        stream.on('end', () => {
            const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
            const combined = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                combined.set(chunk, offset);
                offset += chunk.length;
            }
            resolve(Buffer.from(combined));
        });
        stream.on('error', reject);
    });
}
