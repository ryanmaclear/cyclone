import * as assert from 'assert';
import { parseResponse, safeParseEnvelope } from '../src/web-api-client';

async function run(): Promise<void> {
    const okResponse = {
        ok: true,
        statusText: 'OK',
        json: async () => ({ value: 42 })
    } as Response;
    const okPayload = await parseResponse<{ value: number }>(okResponse);
    assert.strictEqual(okPayload.value, 42);

    const failResponse = {
        ok: false,
        statusText: 'Bad Request',
        json: async () => ({ error: 'Boom' })
    } as Response;

    let threw = false;
    try {
        await parseResponse(failResponse);
    } catch (error) {
        threw = true;
        assert.strictEqual((error as Error).message, 'Boom');
    }
    assert.strictEqual(threw, true);

    const parsed = safeParseEnvelope('{"event":"serial:status","payload":{"connected":true}}');
    assert.ok(parsed);
    assert.strictEqual(parsed?.event, 'serial:status');

    assert.strictEqual(safeParseEnvelope('not-json'), null);
    assert.strictEqual(safeParseEnvelope('{"payload":1}'), null);
    assert.strictEqual(safeParseEnvelope(123), null);

    console.log('Web API client tests passed');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});

