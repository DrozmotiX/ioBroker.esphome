import type { Client, DeviceInfoResponse } from '@2colors/esphome-native-api';

// Forwards the BLE advertisements ESPHome Bluetooth proxies receive to the ioBroker.ble adapter.
//
// ioBroker.ble decodes advertisements (BTHome, Xiaomi, ...) and accepts them from other adapters over its
// gateway interface "ble-gateway/1": sendTo('ble.0', 'gateway:advertisements', { gatewayId, items }).
// This adapter owns the API connection to the device, so it is the one that can deliver them. It passes the
// raw payload on without looking into it; everything that is Bluetooth knowledge stays in ioBroker.ble.

/** Command of the gateway interface of ioBroker.ble that takes a batch of advertisements */
export const BLE_GATEWAY_COMMAND = 'gateway:advertisements';

/** ioBroker.ble accepts at most this many advertisements per message */
export const MAX_ADVERTISEMENTS_PER_MESSAGE = 500;

/** Bit of bluetoothProxyFeatureFlags: the device sends advertisements as raw payload (ESPHome 2023.6.0 and newer) */
const FEATURE_RAW_ADVERTISEMENTS = 1 << 5;

/** Type of the API message with a batch of raw advertisements */
const RAW_ADVERTISEMENTS_MESSAGE = 'BluetoothLERawAdvertisementsResponse';

/** An advertisement as the gateway interface of ioBroker.ble expects it */
export interface GatewayAdvertisement {
    /** MAC address of the sending BLE device in lowercase with colons */
    address: string;
    /** Kind of the address, as far as the proxy knows it */
    addressType: 'public' | 'random' | 'unknown';
    /** Signal strength in dBm */
    rssi: number;
    /** Raw payload of the advertisement (AD structures), base64 encoded */
    data: string;
}

/** Payload of the "gateway:advertisements" message */
export interface GatewayAdvertisementsMessage {
    /** Identifies the proxy within this instance, see gatewayId() */
    gatewayId: string;
    /** The advertisements, an empty list only tells that the gateway is there */
    items: GatewayAdvertisement[];
}

/** A raw advertisement as the device sends it (BluetoothLERawAdvertisement of api.proto, after toObject()) */
export interface RawAdvertisement {
    /** MAC address as 48 bit number */
    address?: number | string;
    /** Signal strength in dBm */
    rssi?: number;
    /** 0 = public, 1 = random, 2 / 3 = resolvable private address with a public / random identity */
    addressType?: number;
    /** Payload, base64 encoded */
    data?: string;
}

/** What the forwarder needs from the adapter */
export interface BleForwarderAdapter {
    /** Log of the adapter */
    log: Pick<ioBroker.Logger, 'debug' | 'info' | 'warn'>;
    /** Sends a message to another instance, no answer is awaited */
    sendTo(instance: string, command: string, message: GatewayAdvertisementsMessage): unknown;
    /** Timers managed by the adapter, js-controller clears them on unload */
    setTimeout(callback: () => void, ms: number): unknown;
    /** Counterpart of setTimeout() */
    clearTimeout(timer: any): void;
    /** Timers managed by the adapter, js-controller clears them on unload */
    setInterval(callback: () => void, ms: number): unknown;
    /** Counterpart of setInterval() */
    clearInterval(timer: any): void;
}

/** Timing of the forwarder */
export interface BleForwarderOptions {
    /** Advertisements are collected for this long and then sent in one message */
    flushIntervalMs: number;
    /**
     * A gateway that received nothing for this long sends an empty batch, so ioBroker.ble knows it is still
     * there. ioBroker.ble considers a gateway offline after 60 seconds without a message.
     */
    heartbeatIntervalMs: number;
    /** Current time in ms, replaced in tests */
    now: () => number;
}

const defaultOptions: BleForwarderOptions = {
    flushIntervalMs: 250,
    heartbeatIntervalMs: 30000,
    now: () => Date.now(),
};

/**
 * The instance of ioBroker.ble the advertisements are forwarded to
 *
 * @param setting - Value of the setting "bleForwardInstance", e.g. "ble.0"
 * @returns The instance, null when forwarding is disabled
 */
export function bleTargetInstance(setting: unknown): string | null {
    if (typeof setting !== 'string') {
        return null;
    }
    const instance = setting.trim().replace(/^system\.adapter\./, '');
    return /^ble\.\d+$/.test(instance) ? instance : null;
}

/**
 * Whether the device is a Bluetooth proxy that sends the advertisements it receives as raw payload
 *
 * @param deviceInfo - Device information the device reported after connecting
 */
export function supportsRawAdvertisements(
    deviceInfo: Pick<DeviceInfoResponse, 'bluetoothProxyFeatureFlags'> | null | undefined,
): boolean {
    return ((deviceInfo?.bluetoothProxyFeatureFlags ?? 0) & FEATURE_RAW_ADVERTISEMENTS) !== 0;
}

/**
 * Whether the device is a Bluetooth proxy at all, including firmware too old for raw advertisements
 *
 * @param deviceInfo - Device information the device reported after connecting
 */
export function isBluetoothProxy(
    deviceInfo:
        | Partial<Pick<DeviceInfoResponse, 'bluetoothProxyFeatureFlags' | 'legacyBluetoothProxyVersion'>>
        | null
        | undefined,
): boolean {
    return (deviceInfo?.bluetoothProxyFeatureFlags ?? 0) !== 0 || (deviceInfo?.legacyBluetoothProxyVersion ?? 0) !== 0;
}

/**
 * Converts the address of a BLE device as the ESPHome API transmits it into the usual notation
 *
 * @param address - MAC address as 48 bit number, e.g. 0xa4c138123456
 * @returns The address in lowercase with colons ("a4:c1:38:12:34:56"), null if it is not a valid address
 */
export function macFromAddress(address: unknown): string | null {
    let value: bigint;
    try {
        if (typeof address === 'number' && Number.isSafeInteger(address)) {
            value = BigInt(address);
        } else if (typeof address === 'string' && /^\d+$/.test(address)) {
            value = BigInt(address);
        } else {
            return null;
        }
    } catch {
        return null;
    }
    if (value < 0n || value > 0xffffffffffffn) {
        return null;
    }
    return value.toString(16).padStart(12, '0').match(/.{2}/g)!.join(':');
}

/**
 * Converts a raw advertisement of the ESPHome API into the form of the gateway interface
 *
 * @param advertisement - Advertisement as the device sent it
 * @returns null if the advertisement is not usable
 */
export function toGatewayAdvertisement(advertisement: RawAdvertisement): GatewayAdvertisement | null {
    const address = macFromAddress(advertisement.address);
    if (!address || typeof advertisement.rssi !== 'number' || typeof advertisement.data !== 'string') {
        return null;
    }
    let addressType: GatewayAdvertisement['addressType'] = 'unknown';
    if (advertisement.addressType === 0 || advertisement.addressType === 2) {
        addressType = 'public';
    } else if (advertisement.addressType === 1 || advertisement.addressType === 3) {
        addressType = 'random';
    }
    return { address, addressType, rssi: advertisement.rssi, data: advertisement.data };
}

/**
 * ID of a device as gateway. ioBroker.ble prefixes it with the instance: "esphome.0:proxy-og".
 * The ESPHome name is used, as that is what people know their proxies by.
 *
 * @param name - Name of the device (ESPHome node name)
 * @param fallback - Used when the device has no name, e.g. its IP address
 * @returns 1 to 64 characters of letters, digits, "_", "-" and "."
 */
export function gatewayId(name: string | null | undefined, fallback: string): string {
    const id = (name || fallback || 'esphome').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
    return id || 'esphome';
}

/** Message of the API as the frame helper of the client library emits it, before the library maps it */
interface ApiMessage {
    constructor: { type?: string };
    toObject(): unknown;
}

/** A device the forwarder knows */
interface Gateway {
    host: string;
    client: Client;
    /** ID as gateway, known once the device reported its name */
    id: string | null;
    /** Whether the device was asked to send the advertisements it receives */
    subscribed: boolean;
    /** Advertisements waiting to be sent, by BLE device and payload */
    queue: Map<string, GatewayAdvertisement>;
    flushTimer: unknown;
    /** When the last message for this gateway was sent */
    lastSent: number;
    /** Set when the device was replaced by a new connection or removed */
    detached: boolean;
}

/**
 * Collects the advertisements of all Bluetooth proxies and delivers them to ioBroker.ble in batches
 */
export class BleForwarder {
    private readonly adapter: BleForwarderAdapter;
    private readonly options: BleForwarderOptions;
    /** Devices by host (IP address) */
    private readonly gateways = new Map<string, Gateway>();
    private heartbeatTimer: unknown;

    /** Instance of ioBroker.ble the advertisements go to, null when forwarding is disabled */
    public readonly target: string | null;

    /**
     * @param adapter - The adapter instance
     * @param target - Instance of ioBroker.ble to forward to, see bleTargetInstance(); null disables forwarding
     * @param options - Timing, only set in tests
     */
    public constructor(
        adapter: BleForwarderAdapter,
        target: string | null,
        options: Partial<BleForwarderOptions> = {},
    ) {
        this.adapter = adapter;
        this.target = target;
        this.options = { ...defaultOptions, ...options };
    }

    /** Whether advertisements are forwarded at all */
    public get enabled(): boolean {
        return this.target !== null;
    }

    /**
     * Starts listening to a device. To be called once for every client, before it connects.
     *
     * @param host - IP address of the device
     * @param client - Client of the device
     */
    public attach(host: string, client: Client): void {
        if (!this.enabled) {
            return;
        }
        this.detach(host);

        const gateway: Gateway = {
            host,
            client,
            id: null,
            subscribed: false,
            queue: new Map(),
            flushTimer: undefined,
            lastSent: 0,
            detached: false,
        };
        this.gateways.set(host, gateway);

        // The client library parses raw advertisements itself and drops the payload while doing so
        // (mapRawAdvertisement in lib/utils/mapMessageByType.js). ioBroker.ble needs exactly that payload, so
        // the message is taken from the frame helper, which emits it as received.
        client.connection.frameHelper.on('message', (message: ApiMessage) => this.onApiMessage(gateway, message));

        if (this.heartbeatTimer === undefined) {
            this.heartbeatTimer = this.adapter.setInterval(() => this.heartbeat(), this.options.heartbeatIntervalMs);
        }
    }

    /**
     * Asks a device to send the advertisements it receives, if it is a Bluetooth proxy. To be called every
     * time the connection is initialized: the subscription ends with the connection.
     *
     * @param host - IP address of the device
     * @param deviceInfo - Device information the device reported
     */
    public initialized(host: string, deviceInfo: DeviceInfoResponse | null | undefined): void {
        const gateway = this.gateways.get(host);
        if (!gateway) {
            return;
        }
        gateway.subscribed = false;

        if (!supportsRawAdvertisements(deviceInfo)) {
            if (isBluetoothProxy(deviceInfo)) {
                this.adapter.log.warn(
                    `The Bluetooth proxy ${deviceInfo?.name || host} cannot send raw advertisements, they are not forwarded to ${this.target}. Update its firmware to ESPHome 2023.6.0 or newer.`,
                );
            }
            return;
        }

        gateway.id = gatewayId(deviceInfo?.name, host);
        try {
            gateway.client.connection.subscribeBluetoothAdvertisementService();
        } catch (error) {
            this.adapter.log.warn(
                `Could not subscribe to the BLE advertisements of ${gateway.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
        }
        gateway.subscribed = true;
        this.adapter.log.info(
            `Forwarding the BLE advertisements of ${gateway.id} (${host}) to ${this.target} as gateway "${gateway.id}"`,
        );
        // Tell ioBroker.ble right away that this gateway exists, even if no BLE device is in range
        this.send(gateway, []);
    }

    /**
     * To be called when the connection to a device is lost: what it had collected is not sent any more
     *
     * @param host - IP address of the device
     */
    public disconnected(host: string): void {
        const gateway = this.gateways.get(host);
        if (!gateway) {
            return;
        }
        gateway.subscribed = false;
        this.clearQueue(gateway);
    }

    /**
     * Forgets a device, e.g. because it was deleted
     *
     * @param host - IP address of the device
     */
    public detach(host: string): void {
        const gateway = this.gateways.get(host);
        if (!gateway) {
            return;
        }
        gateway.detached = true;
        gateway.subscribed = false;
        this.clearQueue(gateway);
        this.gateways.delete(host);
    }

    /** Stops forwarding. To be called before the clients are disconnected. */
    public stop(): void {
        if (this.heartbeatTimer !== undefined) {
            this.adapter.clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        for (const gateway of [...this.gateways.values()]) {
            if (gateway.subscribed) {
                try {
                    gateway.client.connection.unsubscribeBluetoothAdvertisementService();
                } catch {
                    // Not connected any more, the subscription is gone with the connection
                }
            }
            this.detach(gateway.host);
        }
    }

    /**
     * Handles a message of the API of a device
     *
     * @param gateway - The device that sent it
     * @param message - The message as received
     */
    private onApiMessage(gateway: Gateway, message: ApiMessage): void {
        if (gateway.detached || !gateway.subscribed || message?.constructor?.type !== RAW_ADVERTISEMENTS_MESSAGE) {
            return;
        }
        const { advertisementsList } = message.toObject() as { advertisementsList?: RawAdvertisement[] };
        for (const advertisement of advertisementsList ?? []) {
            const item = toGatewayAdvertisement(advertisement);
            if (item) {
                // BLE devices repeat their advertisement several times a second. Within one batch the same
                // payload of the same device is sent once, with the signal strength measured last.
                gateway.queue.set(`${item.address}|${item.data}`, item);
            }
        }

        if (gateway.queue.size >= MAX_ADVERTISEMENTS_PER_MESSAGE) {
            this.flush(gateway);
        } else if (gateway.queue.size > 0 && gateway.flushTimer === undefined) {
            gateway.flushTimer = this.adapter.setTimeout(() => {
                gateway.flushTimer = undefined;
                this.flush(gateway);
            }, this.options.flushIntervalMs);
        }
    }

    /**
     * Sends the collected advertisements of a device
     *
     * @param gateway - The device
     */
    private flush(gateway: Gateway): void {
        const items = [...gateway.queue.values()];
        this.clearQueue(gateway);
        if (gateway.detached || !gateway.subscribed) {
            return;
        }
        for (let i = 0; i < items.length; i += MAX_ADVERTISEMENTS_PER_MESSAGE) {
            this.send(gateway, items.slice(i, i + MAX_ADVERTISEMENTS_PER_MESSAGE));
        }
    }

    /**
     * Keeps gateways that currently receive nothing known to ioBroker.ble
     */
    private heartbeat(): void {
        const now = this.options.now();
        for (const gateway of this.gateways.values()) {
            if (gateway.subscribed && now - gateway.lastSent >= this.options.heartbeatIntervalMs) {
                this.send(gateway, []);
            }
        }
    }

    /**
     * Delivers a batch to ioBroker.ble. No answer is awaited: a lost batch does no harm, the BLE devices
     * send again within seconds.
     *
     * @param gateway - The device that received the advertisements
     * @param items - The advertisements, may be empty
     */
    private send(gateway: Gateway, items: GatewayAdvertisement[]): void {
        if (!this.target || !gateway.id) {
            return;
        }
        gateway.lastSent = this.options.now();
        try {
            this.adapter.sendTo(this.target, BLE_GATEWAY_COMMAND, { gatewayId: gateway.id, items });
        } catch (error) {
            this.adapter.log.debug(
                `Could not forward BLE advertisements to ${this.target}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /**
     * Drops what a device has collected and stops its pending delivery
     *
     * @param gateway - The device
     */
    private clearQueue(gateway: Gateway): void {
        gateway.queue.clear();
        if (gateway.flushTimer !== undefined) {
            this.adapter.clearTimeout(gateway.flushTimer);
            gateway.flushTimer = undefined;
        }
    }
}
