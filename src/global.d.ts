import type { ICycloneApi } from './app-types';

declare global {
    interface Window {
        cyclone: ICycloneApi;
    }
}

export {};
