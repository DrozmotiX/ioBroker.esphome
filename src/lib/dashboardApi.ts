/**
 * ESPHome Dashboard API client
 * Inspired by https://github.com/esphome/dashboard-api
 *
 * Wraps all endpoints exposed by the ESPHome Dashboard HTTP/WebSocket API.
 * The dashboard URL is taken from adapter settings (ESPHomeDashboardUrl).
 *
 * HTTP endpoints use the native fetch API, WebSocket streaming endpoints (compile, upload) use the
 * native WebSocket API of Node.js.
 */

/** Error thrown by request() for a non-OK HTTP response */
export interface DashboardApiError extends Error {
    /** HTTP status code of the response */
    status: number;
}

/** Device configured in the ESPHome Dashboard */
export interface ConfiguredDevice {
    /** IP / hostname used for communication */
    address: string;
    /** Comment from the YAML configuration */
    comment: string | null;
    /** YAML filename (used for other API calls) */
    configuration: string;
    /** ESPHome version of the dashboard */
    current_version: string;
    /** ESPHome version the firmware on the device was built with */
    deployed_version: string;
    /** Components used by the configuration */
    loaded_integrations: string[];
    /** Device name */
    name: string;
    /** Path of the YAML file on the dashboard host */
    path: string;
    /** Platform, e.g. ESP32 or ESP8266 */
    target_platform: string;
    /** Port of the device's web server, if enabled */
    web_port: string | null;
}

/** Device discovered on the network that can be imported into the ESPHome Dashboard */
export interface ImportableDevice {
    /** Device name */
    name: string;
    /** Network type, e.g. wifi */
    network: string;
    /** URL of the package the device can be adopted from */
    package_import_url: string;
    /** Project name announced by the device */
    project_name: string;
    /** Project version announced by the device */
    project_version: string;
}

/** Response of the devices endpoint */
export interface DevicesResponse {
    /** Devices with a configuration in the dashboard */
    configured: ConfiguredDevice[];
    /** Devices discovered on the network that are not adopted yet */
    importable: ImportableDevice[];
}

/** JSON representation of a device configuration, only the parts this module reads are typed */
export interface DeviceConfig {
    /** An empty `api:` section in YAML becomes null in JSON */
    api?: { encryption?: { key?: string } | null } | null;
    [section: string]: unknown;
}

/** Callback invoked for each log line streamed by the dashboard */
export type LineReceivedCallback = (line: string) => void;

/** JSON frame sent by the dashboard over the WebSocket */
interface StreamFrame {
    /** Frame type, 'line' or 'exit' */
    event?: string;
    /** Log line of a 'line' frame */
    data?: string;
    /** Exit code of an 'exit' frame */
    code?: number;
}

/**
 * Checks whether a caught value is the error request() throws for a non-OK response
 *
 * @param error - The caught value
 */
function isDashboardApiError(error: unknown): error is DashboardApiError {
    return error instanceof Error && typeof (error as Partial<DashboardApiError>).status === 'number';
}

/**
 * Make an HTTP request to the ESPHome Dashboard and return the parsed JSON body.
 *
 * @param method - HTTP method (e.g. 'GET', 'POST')
 * @param dashboardUrl - Base URL of the ESPHome Dashboard (e.g. http://192.168.1.100:6052)
 * @param path - API path (e.g. 'devices')
 * @param [params] - Optional query parameters
 * @returns Parsed JSON response
 */
export async function request<T = unknown>(
    method: string,
    dashboardUrl: string,
    path: string,
    params?: Record<string, string>,
): Promise<T> {
    const base = dashboardUrl.replace(/\/+$/, '');
    const url = new URL(`${base}/${path}`);
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }
    }
    const response = await fetch(url.toString(), { method });
    if (!response.ok) {
        const error = new Error(
            `Dashboard API ${method} /${path} failed: ${response.status} ${response.statusText}`,
        ) as DashboardApiError;
        error.status = response.status;
        throw error;
    }
    return (await response.json()) as T;
}

/**
 * Stream output from a long-running ESPHome Dashboard command over a WebSocket.
 *
 * The dashboard sends JSON frames with an `event` field:
 *   - `{ event: 'line', data: '<text>' }` – a line of log output
 *   - `{ event: 'exit', code: <number> }` – the command finished
 *
 * @param dashboardUrl - Base URL of the ESPHome Dashboard
 * @param path - WebSocket endpoint path (e.g. 'compile', 'upload')
 * @param spawnParams - Parameters forwarded as `{ type: 'spawn', ...spawnParams }`
 * @param [lineReceivedCb] - Optional callback invoked for each log line
 * @returns Resolves to true when the command exits with code 0, false otherwise
 */
export async function streamLogs(
    dashboardUrl: string,
    path: string,
    spawnParams: Record<string, unknown>,
    lineReceivedCb?: LineReceivedCallback | null,
): Promise<boolean> {
    const wsUrl = `${dashboardUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/${path}`;

    return new Promise<boolean>((resolve, reject) => {
        let settled = false;

        const settle = (fn: () => void): void => {
            if (!settled) {
                settled = true;
                fn();
            }
        };

        const ws = new WebSocket(wsUrl);

        ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ type: 'spawn', ...spawnParams }));
        });

        ws.addEventListener('message', event => {
            const raw: unknown = event.data;
            let data: StreamFrame;
            try {
                data = JSON.parse(String(raw)) as StreamFrame;
            } catch (error) {
                // Log at debug level to help diagnose malformed or unexpected messages
                if (typeof console !== 'undefined' && typeof console.debug === 'function') {
                    console.debug(`Failed to parse WebSocket message from /${path}:`, error, 'raw message:', raw);
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
                    lineReceivedCb(data.data as string);
                }
            }
        });

        ws.addEventListener('error', err => {
            const errorMessage = (err as unknown as { message?: unknown }).message;
            // Same fallback as before the TypeScript migration, an Event without message prints "[object Event]"
            // eslint-disable-next-line @typescript-eslint/no-base-to-string
            const message = typeof errorMessage === 'string' ? errorMessage : String(err);
            settle(() => reject(new Error(`WebSocket error on /${path}: ${message}`)));
        });

        ws.addEventListener('close', event => {
            if (!event.wasClean) {
                settle(() => reject(new Error(`WebSocket closed unexpectedly on /${path}: code ${event.code}`)));
            }
        });
    });
}

/**
 * Fetch all configured and importable devices from the ESPHome Dashboard.
 *
 * @param dashboardUrl - Base URL of the ESPHome Dashboard
 * @returns Devices list
 */
export async function getDevices(dashboardUrl: string): Promise<DevicesResponse> {
    return request<DevicesResponse>('GET', dashboardUrl, 'devices');
}

/**
 * Fetch the JSON representation of a device configuration from the ESPHome Dashboard.
 *
 * @param dashboardUrl - Base URL of the ESPHome Dashboard
 * @param configuration - Configuration filename (e.g. my-device.yaml)
 * @returns Parsed configuration object, or null when not found (404)
 */
export async function getConfig(dashboardUrl: string, configuration: string): Promise<DeviceConfig | null> {
    try {
        return await request<DeviceConfig>('GET', dashboardUrl, 'json-config', { configuration });
    } catch (error) {
        if (isDashboardApiError(error) && error.status === 404) {
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
 * @param dashboardUrl - Base URL of the ESPHome Dashboard
 * @param configuration - Configuration filename (e.g. my-device.yaml)
 * @returns Base64-encoded encryption key, or null
 */
export async function getEncryptionKey(dashboardUrl: string, configuration: string): Promise<string | null> {
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
 * @param dashboardUrl - Base URL of the ESPHome Dashboard
 * @param configuration - Configuration filename (e.g. my-device.yaml)
 * @param [lineReceivedCb] - Optional callback invoked for each log line
 * @returns Resolves to true on success, false on failure
 */
export async function compile(
    dashboardUrl: string,
    configuration: string,
    lineReceivedCb?: LineReceivedCallback | null,
): Promise<boolean> {
    return streamLogs(dashboardUrl, 'compile', { configuration }, lineReceivedCb);
}

/**
 * Upload (flash) firmware to a device.
 *
 * @param dashboardUrl - Base URL of the ESPHome Dashboard
 * @param configuration - Configuration filename (e.g. my-device.yaml)
 * @param port - Serial port or OTA target (e.g. '/dev/ttyUSB0' or device IP)
 * @param [lineReceivedCb] - Optional callback invoked for each log line
 * @returns Resolves to true on success, false on failure
 */
export async function upload(
    dashboardUrl: string,
    configuration: string,
    port: string,
    lineReceivedCb?: LineReceivedCallback | null,
): Promise<boolean> {
    return streamLogs(dashboardUrl, 'upload', { configuration, port }, lineReceivedCb);
}
