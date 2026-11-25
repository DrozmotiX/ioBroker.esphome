import type { Client, DeviceInfoResponse } from '@2colors/esphome-native-api';
import { pb } from '@2colors/esphome-native-api/lib/utils/messages';
import { macFromAddress, type BleForwarder } from './bleForwarder';

// Connections to BLE devices through Bluetooth proxies, for ioBroker.ble.
//
// ioBroker.ble decides which device to connect to through which gateway and sends the "gatt:*" commands of
// its gateway interface "ble-gateway/1" to this adapter, which owns the API connection to the proxies.
// This file only translates between those commands and the native API: it knows nothing about devices.
// The protocol is specified in docs/spec-phase-2-gatt.md of ioBroker.ble, part A.

/** Protocol of the gateway interface of ioBroker.ble */
export const GATEWAY_PROTOCOL = 'ble-gateway/1';

/** Bit of bluetoothProxyFeatureFlags: the proxy can connect to BLE devices (bluetooth_proxy: active: true) */
const FEATURE_ACTIVE_CONNECTIONS = 1 << 1;

/** Client Characteristic Configuration Descriptor, switches notifications and indications on */
const CCCD_UUID = '00002902-0000-1000-8000-00805f9b34fb';

/** 16 and 32 bit UUIDs are short forms of xxxxxxxx-0000-1000-8000-00805f9b34fb */
const BASE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';

/** The proxies are announced again in this interval, so ioBroker.ble keeps them online */
export const ANNOUNCE_INTERVAL_MS = 30000;

/** How long to wait for the proxy. Shorter than the timeouts in ioBroker.ble, so it gets the more precise error. */
export const TIMEOUTS_MS = {
    connect: 20000,
    disconnect: 5000,
    getServices: 10000,
    read: 8000,
    write: 8000,
    notify: 8000,
} as const;

/** Most entries in one "gatt:writeSequence" */
export const MAX_WRITE_SEQUENCE_LENGTH = 64;
/** Largest value of one write in "gatt:writeSequence", in bytes */
const MAX_WRITE_SEQUENCE_ENTRY = 512;
/**
 * Pause between two writes without response in "gatt:writeSequence". 0 = none. To be set after a test with
 * real hardware, see docs/spec-phase-4-pvvx-ota.md (H3) in ioBroker.ble.
 */
export const WRITE_SEQUENCE_GAP_MS = 0;

/** How long ioBroker.ble may take to answer "gateway:announce" */
const ANNOUNCE_ANSWER_TIMEOUT_MS = 10000;

const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

/** Error codes of the gateway interface */
export type GatewayErrorCode =
    | 'INVALID_PAYLOAD'
    | 'UNKNOWN_GATEWAY'
    | 'NO_FREE_SLOT'
    | 'CONNECT_FAILED'
    | 'NOT_CONNECTED'
    | 'GATT_ERROR'
    | 'TIMEOUT';

/** An error to answer a gatt:* command with */
export class GatewayError extends Error {
    /**
     * @param code - Code of the gateway interface
     * @param message - Text for the log of ioBroker.ble
     */
    public constructor(
        public readonly code: GatewayErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'GatewayError';
    }
}

/** A descriptor as ioBroker.ble expects it */
export interface GattDescriptorInfo {
    /** 128 bit, lowercase, with dashes */
    uuid: string;
    /** Handle on the device */
    handle: number;
}

/** A characteristic as ioBroker.ble expects it */
export interface GattCharacteristicInfo {
    /** 128 bit, lowercase, with dashes */
    uuid: string;
    /** Handle on the device */
    handle: number;
    /** Bit mask: 0x02 read, 0x04 write without response, 0x08 write, 0x10 notify, 0x20 indicate */
    properties: number;
    /** Descriptors of the characteristic */
    descriptors: GattDescriptorInfo[];
}

/** A service as ioBroker.ble expects it */
export interface GattServiceInfo {
    /** 128 bit, lowercase, with dashes */
    uuid: string;
    /** Handle on the device */
    handle: number;
    /** Characteristics of the service */
    characteristics: GattCharacteristicInfo[];
}

/** What the bridge needs from the adapter */
export interface BleGattBridgeAdapter {
    /** Log of the adapter */
    log: Pick<ioBroker.Logger, 'debug' | 'info' | 'warn'>;
    /** Sends a message to another instance, with a callback for the answer if one is wanted */
    sendTo(
        instance: string,
        command: string,
        message: unknown,
        callback?: ((response?: unknown) => void) | ioBroker.MessageCallbackInfo,
        options?: { timeout?: number },
    ): unknown;
    /** Timers managed by the adapter, js-controller clears them on unload */
    setTimeout(callback: () => void, ms: number): unknown;
    /** Counterpart of setTimeout() */
    clearTimeout(timer: unknown): void;
    /** Timers managed by the adapter, js-controller clears them on unload */
    setInterval(callback: () => void, ms: number): unknown;
    /** Counterpart of setInterval() */
    clearInterval(timer: unknown): void;
    /** Subscribes to states of other instances */
    subscribeForeignStates(pattern: string): unknown;
}

/** A message as the client library emits it after mapping (lib/utils/mapMessageByType.js) */
type ApiMessage = Record<string, unknown>;

interface RawDescriptor {
    uuid?: string;
    shortUuid?: number;
    handle?: number;
}

interface RawCharacteristic extends RawDescriptor {
    properties?: number;
    descriptorsList?: RawDescriptor[];
}

interface RawService extends RawDescriptor {
    characteristicsList?: RawCharacteristic[];
}

/** An open connection to a BLE device */
interface BleConnection {
    /** MAC address in lowercase with colons */
    mac: string;
    /** The services, once fetched */
    services?: GattServiceInfo[];
    /** Requests waiting for the proxy: called when the connection ends */
    pending: Set<(error: GatewayError) => void>;
}

/** A proxy that can connect */
interface ProxyState {
    host: string;
    client: Client;
    gatewayId: string;
    freeSlots?: number;
    slotLimit?: number;
    /** Open connections by address (48 bit number) */
    connections: Map<number, BleConnection>;
    /** Addresses a disconnect was sent for and whose confirmation has not arrived yet */
    disconnecting: Set<number>;
}

/** A validated gatt:* command */
interface GattCommand {
    gatewayId: string;
    mac: string;
    address: number;
    handle: number;
    data: Buffer;
    withResponse: boolean;
    addressType: number;
    epoch: number;
    /** The values of gatt:writeSequence */
    sequence: Buffer[];
    /** gatt:writeSequence: read the handle after the last write */
    readAfter: boolean;
}

/**
 * The address of a BLE device as the native API transmits it
 *
 * @param mac - MAC address in lowercase with colons
 */
function addressFromMac(mac: string): number {
    return parseInt(mac.replace(/:/g, ''), 16);
}

/**
 * The canonical UUID of a service, characteristic or descriptor of a GetServices answer
 *
 * @param entry - The entry, with uuid or shortUuid
 */
export function canonicalUuid(entry: RawDescriptor): string {
    if (entry.uuid) {
        return entry.uuid.toLowerCase();
    }
    return `${(entry.shortUuid ?? 0).toString(16).padStart(8, '0')}${BASE_UUID_SUFFIX}`;
}

/**
 * Converts the services of a GetServices answer into the form of the gateway interface
 *
 * @param services - servicesList of the answers
 */
export function toServiceInfo(services: RawService[]): GattServiceInfo[] {
    return services.map(service => ({
        uuid: canonicalUuid(service),
        handle: service.handle ?? 0,
        characteristics: (service.characteristicsList ?? []).map(characteristic => ({
            uuid: canonicalUuid(characteristic),
            handle: characteristic.handle ?? 0,
            properties: characteristic.properties ?? 0,
            descriptors: (characteristic.descriptorsList ?? []).map(descriptor => ({
                uuid: canonicalUuid(descriptor),
                handle: descriptor.handle ?? 0,
            })),
        })),
    }));
}

/**
 * Answers the gatt:* commands of ioBroker.ble with the Bluetooth proxies that can connect, and announces them
 */
export class BleGattBridge {
    private readonly adapter: BleGattBridgeAdapter;
    private readonly forwarder: BleForwarder;
    /** Proxies that can connect, by host */
    private readonly proxies = new Map<string, ProxyState>();
    /** Clients the listeners are registered on */
    private readonly listening = new WeakSet<Client>();
    private announceTimer: unknown;
    /** Start time of ioBroker.ble as last seen, see the specification, A2 rule 6 */
    private epoch: number | undefined;
    private warnedProtocol = false;

    /**
     * @param adapter - The adapter instance
     * @param forwarder - The forwarder of advertisements, it knows the proxies and the target instance
     */
    public constructor(adapter: BleGattBridgeAdapter, forwarder: BleForwarder) {
        this.adapter = adapter;
        this.forwarder = forwarder;
        if (this.target) {
            // When ioBroker.ble stops, the connections it opened are of no use any more
            adapter.subscribeForeignStates(`system.adapter.${this.target}.alive`);
        }
    }

    /** The instance of ioBroker.ble, null when forwarding is disabled */
    private get target(): string | null {
        return this.forwarder.enabled ? this.forwarder.target : null;
    }

    /**
     * To be called every time the connection to a device is initialized, after BleForwarder.initialized()
     *
     * @param host - IP address of the device
     * @param deviceInfo - Device information the device reported
     */
    public initialized(host: string, deviceInfo: DeviceInfoResponse | null | undefined): void {
        if (!this.target) {
            return;
        }
        this.proxies.delete(host);
        if (((deviceInfo?.bluetoothProxyFeatureFlags ?? 0) & FEATURE_ACTIVE_CONNECTIONS) === 0) {
            return;
        }
        const gateway = this.forwarder.listGateways().find(g => g.host === host);
        if (!gateway) {
            return;
        }

        this.proxies.set(host, {
            host,
            client: gateway.client,
            gatewayId: gateway.gatewayId,
            connections: new Map(),
            disconnecting: new Set(),
        });
        this.listen(gateway.client, host);
        try {
            gateway.client.connection.sendMessage(new pb.SubscribeBluetoothConnectionsFreeRequest());
        } catch (error) {
            this.adapter.log.debug(
                `Could not ask ${gateway.gatewayId} for its free connection slots: ${String(error)}`,
            );
        }
        this.adapter.log.info(`The Bluetooth proxy ${gateway.gatewayId} can connect to BLE devices for ${this.target}`);

        if (this.announceTimer === undefined) {
            this.announceTimer = this.adapter.setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS);
        }
        this.announce();
    }

    /**
     * To be called when the connection to a device is lost, after BleForwarder.disconnected()
     *
     * @param host - IP address of the device
     */
    public disconnected(host: string): void {
        const proxy = this.proxies.get(host);
        if (!proxy) {
            return;
        }
        this.proxies.delete(host);
        for (const connection of proxy.connections.values()) {
            this.reportEnded(proxy, connection);
            this.abortPending(connection, `The connection to the Bluetooth proxy ${proxy.gatewayId} was lost`);
        }
        proxy.connections.clear();
        proxy.disconnecting.clear();
    }

    /**
     * Handles the state alive of ioBroker.ble. Returns true if the state belongs to the bridge.
     *
     * @param id - ID of the state
     * @param state - The state
     */
    public handleStateChange(id: string, state: ioBroker.State | null | undefined): boolean {
        if (!this.target || id !== `system.adapter.${this.target}.alive`) {
            return false;
        }
        if (state?.val === false) {
            this.adapter.log.debug(`${this.target} stopped, closing its BLE connections`);
            this.disconnectAll();
        }
        return true;
    }

    /** Stops announcing and closes all connections. To be called before the clients are disconnected. */
    public stop(): void {
        if (this.announceTimer !== undefined) {
            this.adapter.clearInterval(this.announceTimer);
            this.announceTimer = undefined;
        }
        this.disconnectAll();
    }

    /**
     * Handles a gatt:* command of ioBroker.ble and answers it
     *
     * @param obj - The message
     */
    public async handleMessage(obj: ioBroker.Message): Promise<void> {
        let answer: unknown;
        try {
            answer = { error: null, result: await this.execute(obj) };
        } catch (error) {
            const known = error instanceof GatewayError;
            answer = {
                error: {
                    code: known ? error.code : 'GATT_ERROR',
                    message: error instanceof Error ? error.message : String(error),
                },
            };
        }
        if (obj.callback) {
            this.adapter.sendTo(obj.from, obj.command, answer, obj.callback);
        }
    }

    /**
     * Sends "gateway:announce" with all proxies that forward advertisements
     */
    private announce(): void {
        const target = this.target;
        if (!target) {
            return;
        }
        const gateways = this.forwarder.listGateways();
        if (gateways.length === 0) {
            return;
        }
        const message = {
            protocol: GATEWAY_PROTOCOL,
            gateways: gateways.map(gateway => {
                const proxy = this.proxies.get(gateway.host);
                return {
                    gatewayId: gateway.gatewayId,
                    connect: proxy !== undefined,
                    ...(proxy?.freeSlots !== undefined ? { freeSlots: proxy.freeSlots } : {}),
                    ...(proxy?.slotLimit !== undefined ? { slotLimit: proxy.slotLimit } : {}),
                    // Optional commands, only for proxies that can connect
                    ...(proxy !== undefined ? { features: ['writeSequence'] } : {}),
                };
            }),
        };
        try {
            this.adapter.sendTo(
                target,
                'gateway:announce',
                message,
                (response?: unknown) => this.onAnnounceAnswer(response),
                { timeout: ANNOUNCE_ANSWER_TIMEOUT_MS },
            );
        } catch (error) {
            this.adapter.log.debug(`Could not announce the Bluetooth proxies to ${target}: ${String(error)}`);
        }
    }

    /**
     * @param response - Answer of ioBroker.ble to "gateway:announce", an Error if it did not answer
     */
    private onAnnounceAnswer(response: unknown): void {
        if (response == null || typeof response !== 'object' || response instanceof Error) {
            return;
        }
        const { error, result } = response as { error?: { code?: unknown } | null; result?: { epoch?: unknown } };
        if (error === null && typeof result?.epoch === 'number') {
            this.seenEpoch(result.epoch);
        } else if (error?.code === 'UNSUPPORTED_PROTOCOL' && !this.warnedProtocol) {
            this.warnedProtocol = true;
            this.adapter.log.warn(
                `${this.target} does not support the protocol ${GATEWAY_PROTOCOL}: connections to BLE devices are not possible. Update ioBroker.ble.`,
            );
        }
    }

    /**
     * A new start time means ioBroker.ble was restarted: the connections it had opened are gone for it
     *
     * @param epoch - Start time of ioBroker.ble
     */
    private seenEpoch(epoch: number): void {
        if (this.epoch !== undefined && epoch !== this.epoch) {
            this.adapter.log.debug(`${this.target} was restarted, closing its BLE connections`);
            this.disconnectAll();
        }
        this.epoch = epoch;
    }

    /** Closes all connections without waiting and without reporting them */
    private disconnectAll(): void {
        for (const proxy of this.proxies.values()) {
            for (const [address, connection] of proxy.connections) {
                this.sendDisconnect(proxy, address);
                this.abortPending(connection, `The connection to ${connection.mac} was closed`);
            }
            proxy.connections.clear();
        }
    }

    /**
     * Sends the request to disconnect, without waiting for the confirmation
     *
     * @param proxy - The proxy
     * @param address - Address of the BLE device
     */
    private sendDisconnect(proxy: ProxyState, address: number): void {
        proxy.disconnecting.add(address);
        try {
            proxy.client.connection.sendMessage(
                new pb.BluetoothDeviceRequest([
                    address,
                    pb.BluetoothDeviceRequestType.BLUETOOTH_DEVICE_REQUEST_TYPE_DISCONNECT,
                ]),
            );
        } catch (error) {
            this.adapter.log.debug(`Could not send the disconnect to ${proxy.gatewayId}: ${String(error)}`);
        }
    }

    /**
     * Rejects the requests that wait for the proxy
     *
     * @param connection - The connection that ended
     * @param message - Why
     */
    private abortPending(connection: BleConnection, message: string): void {
        const error = new GatewayError('NOT_CONNECTED', message);
        for (const abort of [...connection.pending]) {
            abort(error);
        }
        connection.pending.clear();
    }

    /**
     * Tells ioBroker.ble that a connection ended without being asked to
     *
     * @param proxy - The proxy
     * @param connection - The connection
     * @param errorCode - Error code the proxy reported
     */
    private reportEnded(proxy: ProxyState, connection: BleConnection, errorCode?: number): void {
        if (!this.target) {
            return;
        }
        this.adapter.sendTo(this.target, 'gateway:connectionState', {
            gatewayId: proxy.gatewayId,
            address: connection.mac,
            connected: false,
            ...(errorCode ? { error: errorCode } : {}),
        });
    }

    /**
     * Registers the listeners for the messages of a proxy that are not answers to a request. Once per client.
     *
     * @param client - Client of the proxy
     * @param host - IP address of the proxy
     */
    private listen(client: Client, host: string): void {
        if (this.listening.has(client)) {
            return;
        }
        this.listening.add(client);
        const connection = client.connection;

        connection.on('message.BluetoothConnectionsFreeResponse', (message: ApiMessage) => {
            const proxy = this.proxies.get(host);
            if (!proxy || proxy.client !== client) {
                return;
            }
            const free = typeof message.free === 'number' ? message.free : undefined;
            const limit = typeof message.limit === 'number' ? message.limit : undefined;
            if (free !== proxy.freeSlots || limit !== proxy.slotLimit) {
                proxy.freeSlots = free;
                proxy.slotLimit = limit;
                this.announce();
            }
        });

        connection.on('message.BluetoothDeviceConnectionResponse', (message: ApiMessage) => {
            const proxy = this.proxies.get(host);
            if (!proxy || proxy.client !== client || message.connected === true) {
                return;
            }
            const address = Number(message.address);
            const bleConnection = proxy.connections.get(address);
            if (!bleConnection) {
                return;
            }
            // The device or the proxy ended the connection
            proxy.connections.delete(address);
            this.adapter.log.debug(`${proxy.gatewayId} lost the connection to ${bleConnection.mac}`);
            this.reportEnded(proxy, bleConnection, typeof message.error === 'number' ? message.error : undefined);
            this.abortPending(bleConnection, `The connection to ${bleConnection.mac} ended`);
        });

        connection.on('message.BluetoothGATTNotifyDataResponse', (message: ApiMessage) => {
            const proxy = this.proxies.get(host);
            const target = this.target;
            if (!proxy || proxy.client !== client || !target) {
                return;
            }
            const bleConnection = proxy.connections.get(Number(message.address));
            if (!bleConnection || typeof message.data !== 'string') {
                return;
            }
            this.adapter.sendTo(target, 'gateway:notification', {
                gatewayId: proxy.gatewayId,
                address: bleConnection.mac,
                handle: message.handle,
                data: message.data,
            });
        });
    }

    /**
     * Sends a message to the proxy and waits for the answer that belongs to it.
     * Rejects with GATT_ERROR when the proxy reports an error for this address (and handle),
     * with NOT_CONNECTED when the connection to the BLE device ends, with TIMEOUT otherwise.
     *
     * @param client - Client of the proxy
     * @param message - The request
     * @param responseType - Type of the answer, e.g. "BluetoothGATTReadResponse"
     * @param matches - Whether an answer of that type belongs to this request
     * @param errorMatches - Whether an error the proxy reports belongs to this request
     * @param timeoutMs - How long to wait
     * @param connection - The connection the request is about, it rejects the request when it ends
     */
    private request<T>(
        client: Client,
        message: unknown,
        responseType: string,
        matches: (response: ApiMessage) => boolean,
        errorMatches: (error: { address: number; handle: number }) => boolean,
        timeoutMs: number,
        connection?: BleConnection,
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const handlers: {
                response: (response: ApiMessage) => void;
                error: (response: ApiMessage) => void;
                abort: (error: GatewayError) => void;
                timer?: unknown;
            } = {
                response: () => undefined,
                error: () => undefined,
                abort: () => undefined,
            };
            const finish = (settle: () => void): void => {
                client.connection.off(`message.${responseType}`, handlers.response);
                client.connection.off('message.BluetoothGATTErrorResponse', handlers.error);
                this.adapter.clearTimeout(handlers.timer);
                connection?.pending.delete(handlers.abort);
                settle();
            };
            handlers.response = response => {
                if (matches(response)) {
                    finish(() => resolve(response as T));
                }
            };
            handlers.error = response => {
                const error = { address: Number(response.address), handle: Number(response.handle) };
                if (errorMatches(error)) {
                    finish(() =>
                        reject(
                            new GatewayError(
                                'GATT_ERROR',
                                `The Bluetooth proxy reported error ${String(response.error)}`,
                            ),
                        ),
                    );
                }
            };
            handlers.abort = error => finish(() => reject(error));

            client.connection.on(`message.${responseType}`, handlers.response);
            client.connection.on('message.BluetoothGATTErrorResponse', handlers.error);
            connection?.pending.add(handlers.abort);
            handlers.timer = this.adapter.setTimeout(() => {
                finish(() =>
                    reject(new GatewayError('TIMEOUT', `The Bluetooth proxy did not answer within ${timeoutMs} ms`)),
                );
            }, timeoutMs);

            try {
                client.connection.sendMessage(message);
            } catch (error) {
                finish(() =>
                    reject(new GatewayError('NOT_CONNECTED', `Could not reach the Bluetooth proxy: ${String(error)}`)),
                );
            }
        });
    }

    /**
     * Validates a gatt:* command
     *
     * @param obj - The message
     */
    private parse(obj: ioBroker.Message): GattCommand {
        const invalid = (message: string): GatewayError => new GatewayError('INVALID_PAYLOAD', message);
        if (!this.target || obj.from !== `system.adapter.${this.target}`) {
            throw invalid(
                `Only ${this.target ?? 'the configured instance of ioBroker.ble'} may use the Bluetooth proxies`,
            );
        }
        const payload: unknown = obj.message;
        if (payload == null || typeof payload !== 'object') {
            throw invalid('The message must be an object');
        }
        const { gatewayId, address, handle, data, withResponse, addressType, epoch, readAfter } = payload as Record<
            string,
            unknown
        >;
        if (typeof gatewayId !== 'string') {
            throw invalid('"gatewayId" must be a string');
        }
        if (typeof address !== 'string' || !MAC_REGEX.test(address)) {
            throw invalid('"address" must be a MAC address in lowercase with colons');
        }
        const command: GattCommand = {
            gatewayId,
            mac: address,
            address: addressFromMac(address),
            handle: 0,
            data: Buffer.alloc(0),
            withResponse: true,
            addressType: 0,
            epoch: 0,
            sequence: [],
            readAfter: false,
        };
        if (['gatt:read', 'gatt:write', 'gatt:subscribe', 'gatt:writeSequence'].includes(obj.command)) {
            if (typeof handle !== 'number' || !Number.isInteger(handle) || handle < 0) {
                throw invalid('"handle" must be a whole number from 0');
            }
            command.handle = handle;
        }
        if (obj.command === 'gatt:write') {
            if (typeof data !== 'string' || !BASE64_REGEX.test(data)) {
                throw invalid('"data" must be base64 encoded');
            }
            if (typeof withResponse !== 'boolean') {
                throw invalid('"withResponse" must be true or false');
            }
            command.data = Buffer.from(data, 'base64');
            command.withResponse = withResponse;
        }
        if (obj.command === 'gatt:writeSequence') {
            if (
                !Array.isArray(data) ||
                data.length === 0 ||
                data.length > MAX_WRITE_SEQUENCE_LENGTH ||
                data.some(
                    entry =>
                        typeof entry !== 'string' ||
                        entry === '' ||
                        !BASE64_REGEX.test(entry) ||
                        Buffer.from(entry, 'base64').length > MAX_WRITE_SEQUENCE_ENTRY,
                )
            ) {
                throw invalid(
                    `"data" must be a list of 1 to ${MAX_WRITE_SEQUENCE_LENGTH} base64 encoded values of 1 to ${MAX_WRITE_SEQUENCE_ENTRY} bytes`,
                );
            }
            if (typeof withResponse !== 'boolean') {
                throw invalid('"withResponse" must be true or false');
            }
            if (typeof readAfter !== 'boolean') {
                throw invalid('"readAfter" must be true or false');
            }
            command.sequence = (data as string[]).map(entry => Buffer.from(entry, 'base64'));
            command.withResponse = withResponse;
            command.readAfter = readAfter;
        }
        if (obj.command === 'gatt:connect') {
            if (addressType !== 'public' && addressType !== 'random') {
                throw invalid('"addressType" must be "public" or "random"');
            }
            if (typeof epoch !== 'number') {
                throw invalid('"epoch" must be a number');
            }
            command.addressType = addressType === 'random' ? 1 : 0;
            command.epoch = epoch;
        }
        return command;
    }

    /**
     * Executes a gatt:* command
     *
     * @param obj - The message
     * @returns The result of the answer
     */
    private async execute(obj: ioBroker.Message): Promise<unknown> {
        const command = this.parse(obj);
        const gateway = this.forwarder.findGateway(command.gatewayId);
        const proxy = gateway && this.proxies.get(gateway.host);
        if (!gateway || !proxy || proxy.client !== gateway.client) {
            throw new GatewayError(
                'UNKNOWN_GATEWAY',
                `${command.gatewayId} is not a Bluetooth proxy that can connect to BLE devices`,
            );
        }

        if (obj.command === 'gatt:connect') {
            return this.connect(proxy, command);
        }
        const connection = proxy.connections.get(command.address);
        if (!connection) {
            throw new GatewayError('NOT_CONNECTED', `${proxy.gatewayId} has no connection to ${command.mac}`);
        }
        switch (obj.command) {
            case 'gatt:disconnect':
                return this.disconnect(proxy, command, connection);
            case 'gatt:getServices':
                return { services: await this.getServices(proxy, command, connection) };
            case 'gatt:read':
                return this.read(proxy, command, connection);
            case 'gatt:write':
                return this.write(proxy, command, connection);
            case 'gatt:subscribe':
                return this.subscribe(proxy, command, connection);
            case 'gatt:writeSequence':
                return this.writeSequence(proxy, command, connection);
            default:
                throw new GatewayError('INVALID_PAYLOAD', `Unknown command ${obj.command}`);
        }
    }

    /**
     * @param proxy - The proxy
     * @param command - The command
     */
    private async connect(proxy: ProxyState, command: GattCommand): Promise<{ mtu: number }> {
        this.seenEpoch(command.epoch);

        const stale = proxy.connections.get(command.address);
        if (stale) {
            // ioBroker.ble does not know this connection any more
            proxy.connections.delete(command.address);
            this.sendDisconnect(proxy, command.address);
            this.abortPending(stale, `The connection to ${stale.mac} was replaced`);
        }
        if (proxy.freeSlots === 0) {
            throw new GatewayError('NO_FREE_SLOT', `${proxy.gatewayId} has no free connection slot`);
        }

        const request = new pb.BluetoothDeviceRequest([
            command.address,
            pb.BluetoothDeviceRequestType.BLUETOOTH_DEVICE_REQUEST_TYPE_CONNECT_V3_WITHOUT_CACHE,
        ]);
        request.setHasAddressType(true);
        request.setAddressType(command.addressType);

        let response: ApiMessage;
        try {
            response = await this.request<ApiMessage>(
                proxy.client,
                request,
                'BluetoothDeviceConnectionResponse',
                r => {
                    if (Number(r.address) !== command.address) {
                        return false;
                    }
                    // The confirmation of the disconnect sent for a stale connection does not answer this request
                    if (r.connected !== true && proxy.disconnecting.delete(command.address)) {
                        return false;
                    }
                    return true;
                },
                () => false,
                TIMEOUTS_MS.connect,
            );
        } catch (error) {
            if (error instanceof GatewayError && error.code === 'TIMEOUT') {
                // Do not leave a half open connection behind
                this.sendDisconnect(proxy, command.address);
            }
            throw error;
        }

        if (response.connected !== true) {
            throw new GatewayError(
                'CONNECT_FAILED',
                `${proxy.gatewayId} could not connect to ${command.mac} (error ${String(response.error)})`,
            );
        }
        proxy.disconnecting.delete(command.address);
        proxy.connections.set(command.address, { mac: command.mac, pending: new Set() });
        const mtu = typeof response.mtu === 'number' && response.mtu > 0 ? response.mtu : 23;
        return { mtu };
    }

    /**
     * @param proxy - The proxy
     * @param command - The command
     * @param connection - The connection
     */
    private async disconnect(
        proxy: ProxyState,
        command: GattCommand,
        connection: BleConnection,
    ): Promise<Record<string, never>> {
        proxy.connections.delete(command.address);
        this.abortPending(connection, `The connection to ${connection.mac} was closed`);
        proxy.disconnecting.add(command.address);
        try {
            await this.request(
                proxy.client,
                new pb.BluetoothDeviceRequest([
                    command.address,
                    pb.BluetoothDeviceRequestType.BLUETOOTH_DEVICE_REQUEST_TYPE_DISCONNECT,
                ]),
                'BluetoothDeviceConnectionResponse',
                r => Number(r.address) === command.address && r.connected !== true,
                () => false,
                TIMEOUTS_MS.disconnect,
            );
        } catch (error) {
            this.adapter.log.debug(
                `${proxy.gatewayId} did not confirm the disconnect of ${connection.mac}: ${String(error)}`,
            );
        } finally {
            proxy.disconnecting.delete(command.address);
        }
        return {};
    }

    /**
     * Fetches the services and remembers them at the connection
     *
     * @param proxy - The proxy
     * @param command - The command
     * @param connection - The connection
     */
    private async getServices(
        proxy: ProxyState,
        command: GattCommand,
        connection: BleConnection,
    ): Promise<GattServiceInfo[]> {
        const collected: RawService[] = [];
        const collect = (message: ApiMessage): void => {
            if (Number(message.address) === command.address && Array.isArray(message.servicesList)) {
                collected.push(...(message.servicesList as RawService[]));
            }
        };
        proxy.client.connection.on('message.BluetoothGATTGetServicesResponse', collect);
        try {
            await this.request(
                proxy.client,
                new pb.BluetoothGATTGetServicesRequest([command.address]),
                'BluetoothGATTGetServicesDoneResponse',
                r => Number(r.address) === command.address,
                error => error.address === command.address,
                TIMEOUTS_MS.getServices,
                connection,
            );
        } finally {
            proxy.client.connection.off('message.BluetoothGATTGetServicesResponse', collect);
        }
        connection.services = toServiceInfo(collected);
        return connection.services;
    }

    /**
     * @param proxy - The proxy
     * @param command - The command
     * @param connection - The connection
     */
    private async read(proxy: ProxyState, command: GattCommand, connection: BleConnection): Promise<{ data: string }> {
        const response = await this.request<ApiMessage>(
            proxy.client,
            new pb.BluetoothGATTReadRequest([command.address, command.handle]),
            'BluetoothGATTReadResponse',
            r => Number(r.address) === command.address && r.handle === command.handle,
            error => error.address === command.address && error.handle === command.handle,
            TIMEOUTS_MS.read,
            connection,
        );
        return { data: typeof response.data === 'string' ? response.data : '' };
    }

    /**
     * @param proxy - The proxy
     * @param command - The command
     * @param connection - The connection
     */
    private async write(
        proxy: ProxyState,
        command: GattCommand,
        connection: BleConnection,
    ): Promise<Record<string, never>> {
        const message = new pb.BluetoothGATTWriteRequest([
            command.address,
            command.handle,
            command.withResponse,
            new Uint8Array(command.data),
        ]);
        if (!command.withResponse) {
            try {
                proxy.client.connection.sendMessage(message);
            } catch (error) {
                throw new GatewayError('NOT_CONNECTED', `Could not reach the Bluetooth proxy: ${String(error)}`);
            }
            return {};
        }
        await this.request(
            proxy.client,
            message,
            'BluetoothGATTWriteResponse',
            r => Number(r.address) === command.address && r.handle === command.handle,
            error => error.address === command.address && error.handle === command.handle,
            TIMEOUTS_MS.write,
            connection,
        );
        return {};
    }

    /**
     * Writes the values one after the other and reads the handle afterwards if asked to
     *
     * @param proxy - The proxy
     * @param command - The command
     * @param connection - The connection
     */
    private async writeSequence(
        proxy: ProxyState,
        command: GattCommand,
        connection: BleConnection,
    ): Promise<{ written: number; data?: string }> {
        const total = command.sequence.length;
        const ended = (written: number): GatewayError =>
            new GatewayError(
                'NOT_CONNECTED',
                `The connection to ${command.mac} ended after ${written} of ${total} writes`,
            );
        for (const [written, data] of command.sequence.entries()) {
            if (proxy.connections.get(command.address) !== connection) {
                throw ended(written);
            }
            try {
                await this.write(proxy, { ...command, data }, connection);
            } catch (error) {
                if (error instanceof GatewayError) {
                    throw new GatewayError(error.code, `${error.message} after ${written} of ${total} writes`);
                }
                throw error;
            }
            if (!command.withResponse && WRITE_SEQUENCE_GAP_MS > 0) {
                await new Promise<void>(resolve => this.adapter.setTimeout(resolve, WRITE_SEQUENCE_GAP_MS));
            }
        }
        if (proxy.connections.get(command.address) !== connection) {
            throw ended(total);
        }
        if (!command.readAfter) {
            return { written: total };
        }
        const { data } = await this.read(proxy, command, connection);
        return { written: total, data };
    }

    /**
     * Switches notifications (or indications) on, including the CCCD descriptor
     *
     * @param proxy - The proxy
     * @param command - The command
     * @param connection - The connection
     */
    private async subscribe(
        proxy: ProxyState,
        command: GattCommand,
        connection: BleConnection,
    ): Promise<Record<string, never>> {
        const services = connection.services ?? (await this.getServices(proxy, command, connection));
        await this.request(
            proxy.client,
            new pb.BluetoothGATTNotifyRequest([command.address, command.handle, true]),
            'BluetoothGATTNotifyResponse',
            r => Number(r.address) === command.address && r.handle === command.handle,
            error => error.address === command.address && error.handle === command.handle,
            TIMEOUTS_MS.notify,
            connection,
        );

        // With V3 connections the client writes the CCCD itself (bleak-esphome, start_notify). Not checked on hardware.
        const characteristic = services.flatMap(s => s.characteristics).find(c => c.handle === command.handle);
        const cccd = characteristic?.descriptors.find(d => d.uuid === CCCD_UUID);
        if (characteristic && cccd) {
            const value = characteristic.properties & 0x10 ? [1, 0] : [2, 0];
            try {
                proxy.client.connection.sendMessage(
                    new pb.BluetoothGATTWriteDescriptorRequest([command.address, cccd.handle, new Uint8Array(value)]),
                );
            } catch (error) {
                throw new GatewayError('NOT_CONNECTED', `Could not reach the Bluetooth proxy: ${String(error)}`);
            }
        }
        return {};
    }
}

// Exported for the tests
export { addressFromMac, macFromAddress };
