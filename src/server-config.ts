import * as path from 'path';

export interface IServerConfig {
    host: string;
    port: number;
    staticRoot: string;
    indexFile: string;
}

export function getServerConfig(): IServerConfig {
    const portValue = Number.parseInt(process.env.CYCLONE_PORT ?? '8080', 10);
    return {
        host: process.env.CYCLONE_HOST ?? '0.0.0.0',
        port: Number.isFinite(portValue) ? portValue : 8080,
        staticRoot: path.join(__dirname, '../..'),
        indexFile: 'index.html'
    };
}

