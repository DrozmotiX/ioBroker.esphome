'use strict';

/**
 * Unit tests for lib/dashboardApi.js
 *
 * These tests use fetch mocking (replacing globalThis.fetch) to verify the
 * module's HTTP logic, URL construction, and error handling without needing
 * a real ESPHome Dashboard to be running.
 */

const { expect } = require('chai');
const dashboardApi = require('../lib/dashboardApi');

/**
 * Helper – create a minimal mock fetch that returns a given status/body.
 *
 * @param {number} status - HTTP status code to simulate
 * @param {object|null} body - Response body to return from .json()
 * @returns {Function} Async function that returns a mock Response-like object
 */
function mockFetch(status, body) {
    const ok = status >= 200 && status < 300;
    return async () => ({
        ok,
        status,
        statusText: ok ? 'OK' : status === 404 ? 'Not Found' : 'Error',
        json: async () => body,
    });
}

describe('Dashboard API – request()', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('should build correct URL from dashboardUrl and path', async () => {
        let capturedUrl;
        globalThis.fetch = async url => {
            capturedUrl = url;
            return { ok: true, status: 200, json: async () => ({}) };
        };

        await dashboardApi.request('GET', 'http://localhost:6052', 'devices');
        expect(capturedUrl).to.equal('http://localhost:6052/devices');
    });

    it('should strip a trailing slash from dashboardUrl', async () => {
        let capturedUrl;
        globalThis.fetch = async url => {
            capturedUrl = url;
            return { ok: true, status: 200, json: async () => ({}) };
        };

        await dashboardApi.request('GET', 'http://localhost:6052/', 'devices');
        expect(capturedUrl).to.equal('http://localhost:6052/devices');
    });

    it('should append query parameters to the URL', async () => {
        let capturedUrl;
        globalThis.fetch = async url => {
            capturedUrl = url;
            return { ok: true, status: 200, json: async () => ({}) };
        };

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
            expect(err.message).to.include('500');
            expect(err.status).to.equal(500);
        }
    });
});

describe('Dashboard API – getDevices()', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

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
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

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
            expect(err.status).to.equal(503);
        }
    });
});

describe('Dashboard API – getEncryptionKey()', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

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
