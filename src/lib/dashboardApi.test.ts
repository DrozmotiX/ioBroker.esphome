/**
 * Unit tests for dashboardApi
 *
 * The HTTP tests replace globalThis.fetch to verify the module's HTTP logic, URL construction and
 * error handling without needing a real ESPHome Dashboard to be running. The streaming tests run a
 * local WebSocket server that speaks the dashboard's spawn / line / exit protocol.
 */

import { expect } from 'chai';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import * as dashboardApi from './dashboardApi';

/**
 * Helper – create a minimal mock fetch that returns a given status/body.
 *
 * @param status - HTTP status code to simulate
 * @param body - Response body to return from .json()
 * @returns Mock fetch resolving to a Response with the given status/body
 */
function mockFetch(status: number, body: unknown): typeof globalThis.fetch {
    const ok = status >= 200 && status < 300;
    return () =>
        Promise.resolve(
            new Response(JSON.stringify(body), {
                status,
                statusText: ok ? 'OK' : status === 404 ? 'Not Found' : 'Error',
                headers: { 'content-type': 'application/json' },
            }),
        );
}

/**
 * Helper – create a mock fetch that records the requested URL and answers with an empty body.
 *
 * @param onRequest - Called with the URL the client requested
 * @returns Mock fetch recording the requested URL
 */
function capturingFetch(onRequest: (url: string) => void): typeof globalThis.fetch {
    return url => {
        onRequest(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    };
}

/** Replaces globalThis.fetch for each test of the surrounding suite and restores it afterwards */
function restoreFetchAfterEach(): void {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });
}

describe('Dashboard API – request()', () => {
    restoreFetchAfterEach();

    it('should build correct URL from dashboardUrl and path', async () => {
        let capturedUrl: string | undefined;
        globalThis.fetch = capturingFetch(url => (capturedUrl = url));

        await dashboardApi.request('GET', 'http://localhost:6052', 'devices');
        expect(capturedUrl).to.equal('http://localhost:6052/devices');
    });

    it('should strip a trailing slash from dashboardUrl', async () => {
        let capturedUrl: string | undefined;
        globalThis.fetch = capturingFetch(url => (capturedUrl = url));

        await dashboardApi.request('GET', 'http://localhost:6052/', 'devices');
        expect(capturedUrl).to.equal('http://localhost:6052/devices');
    });

    it('should append query parameters to the URL', async () => {
        let capturedUrl: string | undefined;
        globalThis.fetch = capturingFetch(url => (capturedUrl = url));

        await dashboardApi.request('GET', 'http://localhost:6052', 'json-config', {
            configuration: 'my-device.yaml',
        });
        expect(capturedUrl).to.include('configuration=my-device.yaml');
    });

    it('should return the parsed JSON body on success', async () => {
        const expected = { configured: [], importable: [] };
        globalThis.fetch = mockFetch(200, expected);

        const result = await dashboardApi.request('GET', 'http://localhost:6052', 'devices');
        expect(result).to.deep.equal(expected);
    });

    it('should throw an error with a .status property on non-OK responses', async () => {
        globalThis.fetch = mockFetch(500, null);

        try {
            await dashboardApi.request('GET', 'http://localhost:6052', 'devices');
            expect.fail('Expected an error to be thrown');
        } catch (err) {
            // Asserted through chai so the caught value stays "unknown" for the type checker
            expect(err).to.have.property('message').that.includes('500');
            expect(err).to.have.property('status', 500);
        }
    });
});

describe('Dashboard API – getDevices()', () => {
    restoreFetchAfterEach();

    it('should return the devices object from the dashboard', async () => {
        const mockDevices = {
            configured: [{ name: 'my-device', address: '192.168.1.100', configuration: 'my-device.yaml' }],
            importable: [],
        };
        globalThis.fetch = mockFetch(200, mockDevices);

        const result = await dashboardApi.getDevices('http://localhost:6052');
        expect(result).to.deep.equal(mockDevices);
    });
});

describe('Dashboard API – getConfig()', () => {
    restoreFetchAfterEach();

    it('should return null when the configuration does not exist (404)', async () => {
        globalThis.fetch = mockFetch(404, null);

        const result = await dashboardApi.getConfig('http://localhost:6052', 'missing.yaml');
        expect(result).to.be.null;
    });

    it('should return the parsed configuration on success', async () => {
        const mockConfig = { api: { encryption: { key: 'abc123==' } } };
        globalThis.fetch = mockFetch(200, mockConfig);

        const result = await dashboardApi.getConfig('http://localhost:6052', 'device.yaml');
        expect(result).to.deep.equal(mockConfig);
    });

    it('should re-throw errors that are not 404', async () => {
        globalThis.fetch = mockFetch(503, null);

        try {
            await dashboardApi.getConfig('http://localhost:6052', 'device.yaml');
            expect.fail('Expected an error to be thrown');
        } catch (err) {
            expect(err).to.have.property('status', 503);
        }
    });
});

describe('Dashboard API – getEncryptionKey()', () => {
    restoreFetchAfterEach();

    it('should return null when the configuration file does not exist (404)', async () => {
        globalThis.fetch = mockFetch(404, null);

        const key = await dashboardApi.getEncryptionKey('http://localhost:6052', 'missing.yaml');
        expect(key).to.be.null;
    });

    it('should return null when the config has no api section', async () => {
        globalThis.fetch = mockFetch(200, { esphome: { name: 'test' } });

        const key = await dashboardApi.getEncryptionKey('http://localhost:6052', 'device.yaml');
        expect(key).to.be.null;
    });

    it('should return null when the api section is explicitly null', async () => {
        globalThis.fetch = mockFetch(200, { api: null });

        const key = await dashboardApi.getEncryptionKey('http://localhost:6052', 'device.yaml');
        expect(key).to.be.null;
    });

    it('should return null when api section has no encryption block', async () => {
        globalThis.fetch = mockFetch(200, { api: {} });

        const key = await dashboardApi.getEncryptionKey('http://localhost:6052', 'device.yaml');
        expect(key).to.be.null;
    });

    it('should return null when the encryption block has no key', async () => {
        globalThis.fetch = mockFetch(200, { api: { encryption: {} } });

        const key = await dashboardApi.getEncryptionKey('http://localhost:6052', 'device.yaml');
        expect(key).to.be.null;
    });

    it('should return the encryption key when all sections are present', async () => {
        const expectedKey = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=';
        globalThis.fetch = mockFetch(200, { api: { encryption: { key: expectedKey } } });

        const key = await dashboardApi.getEncryptionKey('http://localhost:6052', 'device.yaml');
        expect(key).to.equal(expectedKey);
    });
});

describe('Dashboard API – streamLogs() / compile() / upload()', () => {
    let server: WebSocketServer;
    let dashboardUrl: string;
    /** Path and spawn message of each connection the server received */
    let received: { path: string | undefined; spawn: unknown }[];
    /** Frames the server answers a spawn message with, a raw string is sent as is */
    let reply: (string | object)[];

    beforeEach(async () => {
        received = [];
        reply = [];
        server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
        server.on('connection', (socket, req) => {
            socket.on('message', message => {
                received.push({ path: req.url, spawn: JSON.parse((message as Buffer).toString()) });
                for (const frame of reply) {
                    socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
                }
            });
        });
        await new Promise(resolve => server.once('listening', resolve));
        dashboardUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    it('sends the spawn message, streams the lines and resolves true on exit code 0', async () => {
        reply = [{ event: 'line', data: 'INFO Compiling' }, 'not json', { event: 'line', data: 'INFO Done' }];
        reply.push({ event: 'exit', code: 0 });
        const lines: string[] = [];

        const result = await dashboardApi.compile(`${dashboardUrl}/`, 'device.yaml', line => lines.push(line));

        expect(result).to.be.true;
        expect(lines).to.deep.equal(['INFO Compiling', 'INFO Done']);
        expect(received).to.deep.equal([{ path: '/compile', spawn: { type: 'spawn', configuration: 'device.yaml' } }]);
    });

    it('resolves false on a non-zero exit code and works without a line callback', async () => {
        reply = [
            { event: 'line', data: 'ERROR' },
            { event: 'exit', code: 2 },
        ];

        const result = await dashboardApi.upload(dashboardUrl, 'device.yaml', '/dev/ttyUSB0');

        expect(result).to.be.false;
        expect(received).to.deep.equal([
            { path: '/upload', spawn: { type: 'spawn', configuration: 'device.yaml', port: '/dev/ttyUSB0' } },
        ]);
    });

    it('rejects when the connection is closed without an exit frame', async () => {
        server.removeAllListeners('connection');
        server.on('connection', socket => socket.on('message', () => socket.terminate()));

        try {
            await dashboardApi.streamLogs(dashboardUrl, 'compile', { configuration: 'device.yaml' });
            expect.fail('Expected an error to be thrown');
        } catch (err) {
            expect(err).to.have.property('message').that.includes('/compile');
        }
    });
});
