import type {
    ICycloneApi,
    IMarlinStatus,
    IPreviewRequest,
    IPreviewResult,
    ISaveArtifactsRequest,
    ISaveArtifactsResult,
    ISerialConnectRequest,
    ISerialPortOption
} from './app-types';

type TEventHandler = (payload: unknown) => void;

export interface IEventEnvelope {
    event: string;
    payload: unknown;
}

export function createWebCycloneApi(): ICycloneApi {
    const eventHandlers = new Map<string, Set<TEventHandler>>();
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/api/events`);

    socket.addEventListener('message', (message) => {
        const data = safeParseEnvelope(message.data);
        if (!data) {
            return;
        }
        const handlers = eventHandlers.get(data.event);
        if (!handlers) {
            return;
        }
        handlers.forEach((handler) => {
            handler(data.payload);
        });
    });

    function onEvent(event: string, callback: TEventHandler): () => void {
        const handlers = eventHandlers.get(event) ?? new Set<TEventHandler>();
        handlers.add(callback);
        eventHandlers.set(event, handlers);
        return () => {
            handlers.delete(callback);
        };
    }

    return {
        generatePreview: (request: IPreviewRequest) => postJson<IPreviewResult>('/api/recipe/preview', request),
        chooseBasePath: async () => window.prompt('Enter output base path on server (example: /home/pi/jobs/tube1)') ?? null,
        saveArtifacts: (request: ISaveArtifactsRequest) => postJson<ISaveArtifactsResult>('/api/recipe/artifacts', request),
        listSerialPorts: () => getJson<ISerialPortOption[]>('/api/serial/ports'),
        connectSerial: (request: ISerialConnectRequest) => postJson<IMarlinStatus>('/api/serial/connect', request),
        disconnectSerial: () => postJson<IMarlinStatus>('/api/serial/disconnect', {}),
        runGCode: (commands: string[]) => postJson<IMarlinStatus>('/api/serial/run', { commands }),
        pauseMachine: () => postJson<IMarlinStatus>('/api/serial/pause', {}),
        resumeMachine: () => postJson<IMarlinStatus>('/api/serial/resume', {}),
        clearMachineQueue: () => postJson<IMarlinStatus>('/api/serial/clear', {}),
        onSerialStatus: (callback: (status: IMarlinStatus) => void) => onEvent('serial:status', (payload) => callback(payload as IMarlinStatus)),
        onSerialLog: (callback: (message: string) => void) => onEvent('serial:log', (payload) => callback(String(payload)))
    };
}

async function getJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    return parseResponse<T>(response);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return parseResponse<T>(response);
}

export async function parseResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error((payload as { error?: string }).error ?? response.statusText);
    }
    return response.json() as Promise<T>;
}

export function safeParseEnvelope(rawData: unknown): IEventEnvelope | null {
    if (typeof rawData !== 'string') {
        return null;
    }
    try {
        const parsed = JSON.parse(rawData) as IEventEnvelope;
        if (!parsed || typeof parsed.event !== 'string') {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}
