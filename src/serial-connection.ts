import { ISerialPortOption } from './app-types';
import { MarlinEmulator, SERIAL_EMULATOR_NAME, SERIAL_EMULATOR_PATH } from './marlin-emulator';
import { IMarlinConnection, IMarlinPortEvents, MarlinPort } from './marlin-port';

export function getSerialEmulatorPortOption(): ISerialPortOption {
    return {
        path: SERIAL_EMULATOR_PATH,
        manufacturer: 'Cyclone',
        emulator: true
    };
}

export function createMarlinConnection(
    path: string,
    baudRate: number,
    emulatorEnabled: boolean,
    events: IMarlinPortEvents
): IMarlinConnection {
    if (path === SERIAL_EMULATOR_PATH) {
        if (!emulatorEnabled) {
            throw new Error(`${SERIAL_EMULATOR_NAME} is not enabled.`);
        }
        return new MarlinEmulator(events);
    }
    return new MarlinPort(path, false, baudRate, events);
}
