'use strict';

/**
 * ESPHome Dashboard API client
 * Inspired by https://github.com/esphome/dashboard-api
 *
 * Wraps all endpoints exposed by the ESPHome Dashboard HTTP/WebSocket API.
 * The dashboard URL is taken from adapter settings (ESPHomeDashboardUrl).
 *
 * HTTP endpoints use the native fetch API (Node >= 18).
 * WebSocket streaming endpoints (compile, upload) use the native WebSocket API on Node >= 22,
 * or fall back to the `ws` npm package on Node 20 if it is installed.
 */

/**
 * Make an HTTP request to the ESPHome Dashboard and return the parsed JSON body.
 *
 * @param {string} method - HTTP method (e.g. 'GET', 'POST')
 * @param {string} dashboardUrl - Base URL of the ESPHome Dashboard (e.g. http://192.168.1.100:6052)
 * @param {string} path - API path (e.g. 'devices')
 * @param {object} [params] - Optional query parameters
 * @returns {Promise<object>} Parsed JSON response
 */
async function request(method, dashboardUrl, path, params) {
    const base = dashboardUrl.replace(/\/+$/, '');
    const url = new URL(`${base}/${path}`);
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }
    }
    const response = await fetch(url.toString(), { method });
    if (!response.ok) {
        const error = new Error(`Dashboard API ${method} /${path} failed: ${response.status} ${response.statusText}`);
        // @ts-expect-error custom property not in Error type
        error.status = response.status;
        throw error;
    }
    return await response.json();
}

/**
 * Stream output from a long-running ESPHome Dashboard command over a WebSocket.
 *
 * The dashboard sends JSON frames with an `event` field:
 *   - `{ event: 'line', data: '<text>' }` – a line of log output
 *   - `{ event: 'exit', code: <number> }` – the command finished
 *
 * Uses the native WebSocket API on Node >= 22, or falls back to the `ws` npm
 * package on Node 20. If neither is available, an error is thrown.
 *
 * @param {string} dashboardUrl - Base URL of the ESPHome Dashboard
 * @param {string} path - WebSocket endpoint path (e.g. 'compile', 'upload')
 * @param {object} spawnParams - Parameters forwarded as `{ type: 'spawn', ...spawnParams }`
 * @param {((line: string) => void) | null} [lineReceivedCb] - Optional callback invoked for each log line
 * @returns {Promise<boolean>} Resolves to true when the command exits with code 0, false otherwise
 */
async function streamLogs(dashboardUrl, path, spawnParams, lineReceivedCb) {
    const wsUrl = `${dashboardUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/${path}`;

    // Prefer native WebSocket (Node >= 22), but fall back to "ws" package on older Node versions
    const hasNativeWebSocket = typeof WebSocket !== 'undefined';
    let WebSocketImpl = hasNativeWebSocket ? WebSocket : null;

    if (!WebSocketImpl) {
        try {
            WebSocketImpl = require('ws');
        } catch {
            throw new Error(
                'WebSocket streaming requires either Node.js >= 22 with native WebSocket support ' +
                    'or the "ws" package installed. Please upgrade Node.js or install "ws" to use compile/upload functionality.',
            );
        }
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocketImpl(wsUrl);

        const settle = fn => {
            if (!settled) {
                settled = true;
                fn();
            }
        };

        if (hasNativeWebSocket) {
            // Native WebSocket (Node >= 22 / browser-like API)
            ws.addEventListener('open', () => {
                ws.send(JSON.stringify({ type: 'spawn', ...spawnParams }));
            });

            ws.addEventListener('message', event => {
                let data;
                try {
                    data = JSON.parse(event.data);
                } catch (error) {
                    // Log at debug level to help diagnose malformed or unexpected messages
                    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
                        console.debug(
                            `Failed to parse WebSocket message from /${path}:`,
                            error,
                            'raw message:',
                            event.data,
                        );
                    }
                    return;
                }

                const wsEvent = data.event;

                if (wsEvent === 'exit') {
                    ws.close();
                    settle(() => resolve(data.code === 0));
                    return;
                }

                if (wsEvent === 'line') {
                    if (lineReceivedCb) {
                        lineReceivedCb(data.data);
                    }
                }
            });

            ws.addEventListener('error', err => {
                const message =
                    err && typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err);
                settle(() => reject(new Error(`WebSocket error on /${path}: ${message}`)));
            });

            ws.addEventListener('close', event => {
                if (!event.wasClean) {
                    settle(() => reject(new Error(`WebSocket closed unexpectedly on /${path}: code ${event.code}`)));
                }
            });
        } else {
            // "ws" package (Node >= 20 without native WebSocket)
            ws.on('open', () => {
                ws.send(JSON.stringify({ type: 'spawn', ...spawnParams }));
            });

            ws.on('message', message => {
                let data;
                try {
                    data = JSON.parse(message);
                } catch (error) {
                    // Log at debug level to help diagnose malformed or unexpected messages
                    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
                        console.debug(
                            `Failed to parse WebSocket message from /${path}:`,
                            error,
                            'raw message:',
                            message,
                        );
                    }
                    return;
                }

                const wsEvent = data.event;

                if (wsEvent === 'exit') {
                    ws.close();
                    settle(() => resolve(data.code === 0));
                    return;
                }

                if (wsEvent === 'line') {
                    if (lineReceivedCb) {
                        lineReceivedCb(data.data);
                    }
                }
            });

            ws.on('error', err => {
                const message = err && err.message ? err.message : String(err);
                settle(() => reject(new Error(`WebSocket error on /${path}: ${message}`)));
            });

            ws.on('close', (code, reason) => {
                // "ws" does not provide wasClean flag by default; treat non-normal close as unexpected
                if (code !== 1000) {
                    settle(() =>
                        reject(
                            new Error(
                                `WebSocket closed unexpectedly on /${path}: code ${code}${
                                    reason ? `, reason: ${reason.toString()}` : ''
                                }`,
                            ),
                        ),
                    );
                }
            });
        }
    });
}

/**
 * Fetch all configured and importable devices from the ESPHome Dashboard.
 *
 * Response shape:
 * ```
 * {
 *   configured: [{
 *     address: string,         // IP / hostname used for communication
 *     comment: string | null,
 *     configuration: string,   // YAML filename (used for other API calls)
 *     current_version: string,
 *     deployed_version: string,
 *     loaded_integrations: string[],
 *     name: string,
 *     path: string,
 *     target_platform: string,
 *     web_port: string | null,
 *   }],
 *   importable: [{
 *     name: string,
 *     network: string,
 *     package_import_url: string,
 *     project_name: string,
 *     project_version: string,
 *   }]
 * }
 * ```
 *
 * @param {string} dashboardUrl - Base URL of the ESPHome Dashboard
 * @returns {Promise<{configured: Array<object>, importable: Array<object>}>} Devices list
 */
async function getDevices(dashboardUrl) {
    return request('GET', dashboardUrl, 'devices');
}

/**
 * Fetch the JSON representation of a device configuration from the ESPHome Dashboard.
 *
 * @param {string} dashboardUrl - Base URL of the ESPHome Dashboard
 * @param {string} configuration - Configuration filename (e.g. my-device.yaml)
 * @returns {Promise<object|null>} Parsed configuration object, or null when not found (404)
 */
async function getConfig(dashboardUrl, configuration) {
    try {
        return await request('GET', dashboardUrl, 'json-config', { configuration });
    } catch (error) {
        // @ts-expect-error custom property not in Error type
        if (error.status === 404) {
            return null;
        }
        throw error;
    }
}

/**
 * Extract the native API encryption key for a device configuration.
 *
 * Returns null when:
 *   - the configuration file does not exist
 *   - the YAML has no `api:` section
 *   - the `api:` section has no `encryption:` block
 *
 * @param {string} dashboardUrl - Base URL of the ESPHome Dashboard
 * @param {string} configuration - Configuration filename (e.g. my-device.yaml)
 * @returns {Promise<string|null>} Base64-encoded encryption key, or null
 */
async function getEncryptionKey(dashboardUrl, configuration) {
    const config = await getConfig(dashboardUrl, configuration);
    if (!config) {
        return null;
    }
    // An empty `api:` section in YAML becomes null in JSON
    const api = config.api;
    if (!api) {
        return null;
    }
    const encryption = api.encryption;
    if (!encryption) {
        return null;
    }
    return encryption.key || null;
}

/**
 * Compile the firmware for a device configuration.
 *
 * Uses the native WebSocket API (Node >= 22) or falls back to the `ws` npm package (Node 20).
 *
 * @param {string} dashboardUrl - Base URL of the ESPHome Dashboard
 * @param {string} configuration - Configuration filename (e.g. my-device.yaml)
 * @param {((line: string) => void) | null} [lineReceivedCb] - Optional callback invoked for each log line
 * @returns {Promise<boolean>} Resolves to true on success, false on failure
 */
async function compile(dashboardUrl, configuration, lineReceivedCb) {
    return streamLogs(dashboardUrl, 'compile', { configuration }, lineReceivedCb);
}

/**
 * Upload (flash) firmware to a device.
 *
 * Uses the native WebSocket API (Node >= 22) or falls back to the `ws` npm package (Node 20).
 *
 * @param {string} dashboardUrl - Base URL of the ESPHome Dashboard
 * @param {string} configuration - Configuration filename (e.g. my-device.yaml)
 * @param {string} port - Serial port or OTA target (e.g. '/dev/ttyUSB0' or device IP)
 * @param {((line: string) => void) | null} [lineReceivedCb] - Optional callback invoked for each log line
 * @returns {Promise<boolean>} Resolves to true on success, false on failure
 */
async function upload(dashboardUrl, configuration, port, lineReceivedCb) {
    return streamLogs(dashboardUrl, 'upload', { configuration, port }, lineReceivedCb);
}

module.exports = {
    request,
    streamLogs,
    getDevices,
    getConfig,
    getEncryptionKey,
    compile,
    upload,
};
