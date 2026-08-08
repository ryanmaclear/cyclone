import * as assert from 'assert';
import { IMarlinStatus } from '../src/app-types';
import { MarlinEmulator, SERIAL_EMULATOR_PATH } from '../src/marlin-emulator';
import { createMarlinConnection, getSerialEmulatorPortOption } from '../src/serial-connection';

async function run(): Promise<void> {
    const logs: string[] = [];
    const statuses: IMarlinStatus[] = [];
    const emulator = new MarlinEmulator({
        onLog: (message) => logs.push(message),
        onStatus: (status) => statuses.push(status)
    });

    await emulator.initialize();
    assert.strictEqual(emulator.getStatus().connected, true);
    assert.strictEqual(emulator.getStatus().portPath, 'Marlin Serial Emulator');

    emulator.queueCommands(['G0 X1', '; test comment', 'M114', 'G0 X2']);
    emulator.pause();
    await waitFor(() => emulator.getStatus().paused);
    assert.strictEqual(emulator.getStatus().sentCommands, 1);
    assert.ok(logs.includes('echo:busy: paused for user'));

    emulator.resume();
    await waitFor(() => {
        const status = emulator.getStatus();
        return !status.paused && status.queuedCommands === 0 && status.sentCommands === 3
            && logs.filter((message) => message === 'ok').length >= 3;
    });
    assert.ok(logs.includes('[Emulator] > G0 X1'));
    assert.ok(logs.includes('[Emulator] > M114'));
    assert.ok(logs.includes('test comment'));
    assert.ok(logs.filter((message) => message === 'ok').length >= 3);

    emulator.clearQueue();
    assert.strictEqual(emulator.getStatus().totalCommands, 0);
    assert.strictEqual(emulator.getStatus().sentCommands, 0);

    await emulator.disconnect();
    assert.strictEqual(emulator.getStatus().connected, false);
    assert.ok(statuses.some((status) => status.connected));
    assert.strictEqual(statuses[statuses.length - 1].connected, false);

    assert.throws(
        () => createMarlinConnection(SERIAL_EMULATOR_PATH, 250000, false, {}),
        /not enabled/
    );
    assert.ok(createMarlinConnection(SERIAL_EMULATOR_PATH, 250000, true, {}) instanceof MarlinEmulator);
    assert.strictEqual(getSerialEmulatorPortOption().emulator, true);

    console.log('Marlin emulator tests passed');
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for emulator state.');
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
