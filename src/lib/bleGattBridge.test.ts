import type { Client, DeviceInfoResponse } from '@2colors/esphome-native-api';
import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import { BleForwarder } from './bleForwarder';
import { ANNOUNCE_INTERVAL_MS, BleGattBridge, type BleGattBridgeAdapter } from './bleGattBridge';

// The protobuf classes and the message mapping of the client library, to build messages as the library emits them
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the library has no types for these files
const { pb } = require('@2colors/esphome-native-api/lib/utils/messages') as {
    pb: Record<string, any>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the library has no types for these files
const { mapMessageByType } = require('@2colors/esphome-native-api/lib/utils/mapMessageByType') as {
    mapMessageByType: (type: string, obj: unknown) => Record<string, unknown>;
};

const HOST = '192.0.2.20';
const DEVICE = 'a4:c1:38:12:34:56';
const DEVICE_ADDRESS = 0xa4c138123456;
const OTHER = 'a4:c1:38:00:00:01';
const OTHER_ADDRESS = 0xa4c138000001;
const BLE = 'system.adapter.ble.0';

/** Passive scan, active connections, ..., raw advertisements */
const ACTIVE_PROXY_FLAGS = 0b1111111;
/** Like above, but without active connections (bit 1) */
const PASSIVE_PROXY_FLAGS = ACTIVE_PROXY_FLAGS & ~(1 << 1);

function deviceInfo(name: string, bluetoothProxyFeatureFlags: number): DeviceInfoResponse {
    return { name, bluetoothProxyFeatureFlags } as DeviceInfoResponse;
}

/**
 * A message of the native API as the library emits it: built with the protobuf classes and mapped
 *
 * @param type - Name of the message type, e.g. "BluetoothGATTReadResponse"
 * @param fill - Sets the fields of the message
 */
function apiMessage(type: string, fill: (message: any) => void): Record<string, unknown> {
    const message = new pb[type]();
    fill(message);
    const parsed = pb[type].deserializeBinary(message.serializeBinary());
    return mapMessageByType(type, parsed.toObject());
}

/** Stands in for the client of a Bluetooth proxy */
class FakeProxyClient {
    public readonly sent: any[] = [];
    public readonly connection = Object.assign(new EventEmitter(), {
        frameHelper: new EventEmitter(),
        sendMessage: (message: unknown): void => {
            this.sent.push(message);
        },
        subscribeBluetoothAdvertisementService: (): void => {},
        unsubscribeBluetoothAdvertisementService: (): void => {},
    });

    public asClient(): Client {
        return this as unknown as Client;
    }

    /**
     * The proxy sends a message
     *
     * @param type - Name of the message type, e.g. "BluetoothGATTReadResponse"
     * @param fill - Sets the fields of the message
     */
    public receive(type: string, fill: (message: any) => void): void {
        this.connection.emit(`message.${type}`, apiMessage(type, fill));
    }

    public connectionResponse(address: number, connected: boolean, mtu = 0, error = 0): void {
        this.receive('BluetoothDeviceConnectionResponse', m => {
            m.setAddress(address);
            m.setConnected(connected);
            m.setMtu(mtu);
            m.setError(error);
        });
    }

    /** The messages sent to the proxy as "<type> <fields as JSON>" */
    public get log(): string[] {
        return this.sent.map(m => `${m.constructor.type} ${JSON.stringify(m.toObject())}`);
    }

    /**
     * The messages of one type, as objects
     *
     * @param type - Name of the message type, e.g. "BluetoothGATTReadResponse"
     */
    public sentOf(type: string): Record<string, unknown>[] {
        return this.sent.filter(m => m.constructor.type === type).map(m => m.toObject());
    }
}

interface SentMessage {
    instance: string;
    command: string;
    message: any;
    callback?: unknown;
    options?: { timeout?: number };
}

/** Stands in for the adapter */
class FakeAdapter implements BleGattBridgeAdapter {
    public readonly sent: SentMessage[] = [];
    public readonly timeouts = new Map<number, () => void>();
    public readonly intervals = new Map<number, { callback: () => void; ms: number }>();
    public readonly subscriptions: string[] = [];
    private nextTimer = 1;
    public readonly warnings: string[] = [];
    public readonly log = {
        debug: (): void => {},
        info: (): void => {},
        warn: (message: string): void => {
            this.warnings.push(message);
        },
    };

    public sendTo(
        instance: string,
        command: string,
        message: unknown,
        callback?: unknown,
        options?: { timeout?: number },
    ): void {
        this.sent.push({ instance, command, message, callback, options });
    }

    public setTimeout(callback: () => void): number {
        const id = this.nextTimer++;
        this.timeouts.set(id, callback);
        return id;
    }

    public clearTimeout(timer: unknown): void {
        this.timeouts.delete(timer as number);
    }

    public setInterval(callback: () => void, ms: number): number {
        const id = this.nextTimer++;
        this.intervals.set(id, { callback, ms });
        return id;
    }

    public clearInterval(timer: unknown): void {
        this.intervals.delete(timer as number);
    }

    public subscribeForeignStates(pattern: string): void {
        this.subscriptions.push(pattern);
    }

    public expireTimeouts(): void {
        for (const [id, callback] of [...this.timeouts]) {
            this.timeouts.delete(id);
            callback();
        }
    }

    /**
     * The messages sent with this command
     *
     * @param command - The command, e.g. "gateway:announce"
     */
    public sentWith(command: string): SentMessage[] {
        return this.sent.filter(m => m.command === command);
    }

    /**
     * ioBroker.ble answers the last "gateway:announce"
     *
     * @param answer - The answer of ioBroker.ble
     */
    public answerAnnounce(answer: unknown): void {
        const announce = this.sentWith('gateway:announce').at(-1);
        (announce?.callback as (response: unknown) => void)(answer);
    }
}

/** Lets pending promise callbacks run */
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('lib/bleGattBridge => BleGattBridge', () => {
    let adapter: FakeAdapter;
    let client: FakeProxyClient;
    let forwarder: BleForwarder;
    let bridge: BleGattBridge;

    /**
     * Sends a gatt:* command like ioBroker.ble and returns the promise of the answer
     *
     * @param name - The gatt:* command
     * @param message - Its payload
     * @param from - The sending instance
     */
    function command(name: string, message: unknown, from = BLE): Promise<any> {
        const callback = { message, id: 7, ack: false, time: 0 };
        const done = bridge.handleMessage({ command: name, message, from, callback } as unknown as ioBroker.Message);
        return done.then(() => {
            // The answer goes back to the sender, with the callback of the request
            const answer = adapter.sent.find(m => m.callback === callback);
            expect(answer?.instance, 'the answer of the request').to.equal(from);
            return answer?.message;
        });
    }

    async function connect(address = DEVICE, numeric = DEVICE_ADDRESS, epoch = 1000): Promise<any> {
        const answer = command('gatt:connect', { gatewayId: 'proxy-og', address, addressType: 'public', epoch });
        client.connectionResponse(numeric, true, 185);
        return answer;
    }

    function addProxy(host: string, proxy: FakeProxyClient, name: string, flags: number): void {
        forwarder.attach(host, proxy.asClient());
        forwarder.initialized(host, deviceInfo(name, flags));
        bridge.initialized(host, deviceInfo(name, flags));
    }

    beforeEach(() => {
        adapter = new FakeAdapter();
        client = new FakeProxyClient();
        forwarder = new BleForwarder(adapter, 'ble.0');
        bridge = new BleGattBridge(adapter, forwarder);
        addProxy(HOST, client, 'proxy-og', ACTIVE_PROXY_FLAGS);
    });

    afterEach(() => bridge.stop());

    it('does nothing while forwarding is disabled', async () => {
        const disabledAdapter = new FakeAdapter();
        const disabled = new BleGattBridge(disabledAdapter, new BleForwarder(disabledAdapter, null));
        disabled.initialized(HOST, deviceInfo('proxy-og', ACTIVE_PROXY_FLAGS));
        expect(disabled.handleStateChange('system.adapter.ble.0.alive', { val: false } as ioBroker.State)).to.equal(
            false,
        );
        await disabled.handleMessage({ command: 'gatt:connect', message: {}, from: BLE } as ioBroker.Message);
        expect(disabledAdapter.sent).to.deep.equal([]);
        expect(disabledAdapter.subscriptions).to.deep.equal([]);
    });

    it('watches whether ioBroker.ble is alive', () => {
        expect(adapter.subscriptions).to.deep.equal(['system.adapter.ble.0.alive']);
    });

    it('announces the proxies, the ones that can connect with connect: true', () => {
        const passive = new FakeProxyClient();
        addProxy('192.0.2.21', passive, 'proxy-passive', PASSIVE_PROXY_FLAGS);
        // A passive proxy is not asked for its free slots
        expect(passive.sent).to.deep.equal([]);
        expect(client.log).to.deep.equal(['SubscribeBluetoothConnectionsFreeRequest {}']);

        // Announced again with the active proxy once more information is known
        client.receive('BluetoothConnectionsFreeResponse', m => {
            m.setFree(3);
            m.setLimit(3);
        });
        const announce = adapter.sentWith('gateway:announce').at(-1)!;
        expect(announce.instance).to.equal('ble.0');
        expect(announce.options).to.deep.equal({ timeout: 10000 });
        expect(announce.message).to.deep.equal({
            protocol: 'ble-gateway/1',
            gateways: [
                { gatewayId: 'proxy-og', connect: true, freeSlots: 3, slotLimit: 3 },
                { gatewayId: 'proxy-passive', connect: false },
            ],
        });
    });

    it('announces changed free slots at once, the same values not', () => {
        const before = adapter.sentWith('gateway:announce').length;
        client.receive('BluetoothConnectionsFreeResponse', m => {
            m.setFree(3);
            m.setLimit(3);
        });
        expect(adapter.sentWith('gateway:announce')).to.have.length(before + 1);
        client.receive('BluetoothConnectionsFreeResponse', m => {
            m.setFree(3);
            m.setLimit(3);
        });
        expect(adapter.sentWith('gateway:announce')).to.have.length(before + 1);
        client.receive('BluetoothConnectionsFreeResponse', m => {
            m.setFree(2);
            m.setLimit(3);
        });
        expect(adapter.sentWith('gateway:announce')).to.have.length(before + 2);
        expect(adapter.sentWith('gateway:announce').at(-1)!.message.gateways[0]).to.include({
            freeSlots: 2,
            slotLimit: 3,
        });
    });

    /** Lets every interval fire once and returns how many announcements that sent */
    function fireIntervals(): number {
        const before = adapter.sentWith('gateway:announce').length;
        for (const { callback } of [...adapter.intervals.values()]) {
            callback();
        }
        return adapter.sentWith('gateway:announce').length - before;
    }

    it('announces again in an interval', () => {
        expect([...adapter.intervals.values()].map(i => i.ms)).to.include(ANNOUNCE_INTERVAL_MS);
        expect(fireIntervals()).to.equal(1);
    });

    it('warns once when ioBroker.ble does not know the protocol', () => {
        const unsupported = { error: { code: 'UNSUPPORTED_PROTOCOL', message: 'no' } };
        adapter.answerAnnounce(unsupported);
        adapter.answerAnnounce(unsupported);
        expect(adapter.warnings).to.have.length(1);
        expect(adapter.warnings[0]).to.include('ble-gateway/1');
    });

    it('connects to a BLE device', async () => {
        client.sent.length = 0;
        const answer = command('gatt:connect', {
            gatewayId: 'proxy-og',
            address: DEVICE,
            addressType: 'random',
            epoch: 1000,
        });
        expect(client.sent[0].constructor.type).to.equal('BluetoothDeviceRequest');
        expect(client.sent[0].toObject()).to.deep.equal({
            address: DEVICE_ADDRESS,
            requestType: pb.BluetoothDeviceRequestType.BLUETOOTH_DEVICE_REQUEST_TYPE_CONNECT_V3_WITHOUT_CACHE,
            hasAddressType: true,
            addressType: 1,
        });
        // An answer for another device does not belong to this request
        client.connectionResponse(OTHER_ADDRESS, true, 100);
        client.connectionResponse(DEVICE_ADDRESS, true, 185);
        expect(await answer).to.deep.equal({ error: null, result: { mtu: 185 } });
    });

    it('reports a failed connection', async () => {
        const answer = command('gatt:connect', {
            gatewayId: 'proxy-og',
            address: DEVICE,
            addressType: 'public',
            epoch: 1000,
        });
        client.connectionResponse(DEVICE_ADDRESS, false, 0, 133);
        const { error } = await answer;
        expect(error.code).to.equal('CONNECT_FAILED');
        expect(error.message).to.include('133');
    });

    it('gives up connecting after the timeout and does not leave a half open connection', async () => {
        client.sent.length = 0;
        const answer = command('gatt:connect', {
            gatewayId: 'proxy-og',
            address: DEVICE,
            addressType: 'public',
            epoch: 1000,
        });
        adapter.expireTimeouts();
        expect((await answer).error.code).to.equal('TIMEOUT');
        expect(client.sentOf('BluetoothDeviceRequest').map(r => r.requestType)).to.deep.equal([
            pb.BluetoothDeviceRequestType.BLUETOOTH_DEVICE_REQUEST_TYPE_CONNECT_V3_WITHOUT_CACHE,
            pb.BluetoothDeviceRequestType.BLUETOOTH_DEVICE_REQUEST_TYPE_DISCONNECT,
        ]);
    });

    it('refuses to connect without a free slot', async () => {
        client.receive('BluetoothConnectionsFreeResponse', m => {
            m.setFree(0);
            m.setLimit(3);
        });
        client.sent.length = 0;
        const answer = await command('gatt:connect', {
            gatewayId: 'proxy-og',
            address: DEVICE,
            addressType: 'public',
            epoch: 1000,
        });
        expect(answer.error.code).to.equal('NO_FREE_SLOT');
        expect(client.sent).to.deep.equal([]);
    });

    it('gives every request the answer of its own device', async () => {
        await connect(DEVICE, DEVICE_ADDRESS);
        await connect(OTHER, OTHER_ADDRESS);

        const first = command('gatt:read', { gatewayId: 'proxy-og', address: DEVICE, handle: 32 });
        const second = command('gatt:read', { gatewayId: 'proxy-og', address: OTHER, handle: 32 });
        // The answers come in the opposite order
        client.receive('BluetoothGATTReadResponse', m => {
            m.setAddress(OTHER_ADDRESS);
            m.setHandle(32);
            m.setData(Buffer.from('0202', 'hex'));
        });
        client.receive('BluetoothGATTReadResponse', m => {
            m.setAddress(DEVICE_ADDRESS);
            m.setHandle(32);
            m.setData(Buffer.from('0101', 'hex'));
        });
        expect(await first).to.deep.equal({ error: null, result: { data: 'AQE=' } });
        expect(await second).to.deep.equal({ error: null, result: { data: 'AgI=' } });
    });

    it('fails a read at once when the proxy reports an error for it', async () => {
        await connect();
        const answer = command('gatt:read', { gatewayId: 'proxy-og', address: DEVICE, handle: 32 });
        // An error for another handle does not belong to this request
        client.receive('BluetoothGATTErrorResponse', m => {
            m.setAddress(DEVICE_ADDRESS);
            m.setHandle(40);
            m.setError(5);
        });
        client.receive('BluetoothGATTErrorResponse', m => {
            m.setAddress(DEVICE_ADDRESS);
            m.setHandle(32);
            m.setError(5);
        });
        const { error } = await answer;
        expect(error.code).to.equal('GATT_ERROR');
        expect(error.message).to.include('5');
        expect(adapter.timeouts.size, 'no timer left').to.equal(0);
    });

    it('waits for the confirmation of a write with response only', async () => {
        await connect();
        client.sent.length = 0;
        const withResponse = command('gatt:write', {
            gatewayId: 'proxy-og',
            address: DEVICE,
            handle: 32,
            data: 'VQE=',
            withResponse: true,
        });
        let answered = false;
        void withResponse.then(() => (answered = true));
        await tick();
        expect(answered).to.equal(false);
        client.receive('BluetoothGATTWriteResponse', m => {
            m.setAddress(DEVICE_ADDRESS);
            m.setHandle(32);
        });
        expect(await withResponse).to.deep.equal({ error: null, result: {} });

        const withoutResponse = await command('gatt:write', {
            gatewayId: 'proxy-og',
            address: DEVICE,
            handle: 32,
            data: 'Iw==',
            withResponse: false,
        });
        expect(withoutResponse).to.deep.equal({ error: null, result: {} });
        expect(client.sentOf('BluetoothGATTWriteRequest')).to.deep.equal([
            { address: DEVICE_ADDRESS, handle: 32, response: true, data: 'VQE=' },
            { address: DEVICE_ADDRESS, handle: 32, response: false, data: 'Iw==' },
        ]);
    });

    it('collects the services of several answers', async () => {
        await connect();
        const answer = command('gatt:getServices', { gatewayId: 'proxy-og', address: DEVICE });
        client.receive('BluetoothGATTGetServicesResponse', m => {
            m.setAddress(DEVICE_ADDRESS);
            const service = new pb.BluetoothGATTService();
            service.setShortUuid(0x1f10);
            service.setHandle(30);
            const characteristic = new pb.BluetoothGATTCharacteristic();
            characteristic.setShortUuid(0x1f1f);
            characteristic.setHandle(32);
            characteristic.setProperties(0x16);
            const descriptor = new pb.BluetoothGATTDescriptor();
            descriptor.setShortUuid(0x2902);
            descriptor.setHandle(33);
            characteristic.addDescriptors(descriptor);
            service.addCharacteristics(characteristic);
            m.addServices(service);
        });
        // Another device: not part of the answer
        client.receive('BluetoothGATTGetServicesResponse', m => {
            m.setAddress(OTHER_ADDRESS);
            const service = new pb.BluetoothGATTService();
            service.setShortUuid(0x180f);
            m.addServices(service);
        });
        client.receive('BluetoothGATTGetServicesResponse', m => {
            m.setAddress(DEVICE_ADDRESS);
            const service = new pb.BluetoothGATTService();
            service.setShortUuid(0x180a);
            service.setHandle(1);
            m.addServices(service);
        });
        client.receive('BluetoothGATTGetServicesDoneResponse', m => m.setAddress(DEVICE_ADDRESS));

        expect(await answer).to.deep.equal({
            error: null,
            result: {
                services: [
                    {
                        uuid: '00001f10-0000-1000-8000-00805f9b34fb',
                        handle: 30,
                        characteristics: [
                            {
                                uuid: '00001f1f-0000-1000-8000-00805f9b34fb',
                                handle: 32,
                                properties: 0x16,
                                descriptors: [{ uuid: '00002902-0000-1000-8000-00805f9b34fb', handle: 33 }],
                            },
                        ],
                    },
                    { uuid: '0000180a-0000-1000-8000-00805f9b34fb', handle: 1, characteristics: [] },
                ],
            },
        });
    });

    /**
     * Answers gatt:getServices with one characteristic at handle 32
     *
     * @param properties - Properties of the characteristic
     * @param withCccd - Whether the characteristic has a CCCD descriptor
     */
    async function subscribeWith(properties: number, withCccd: boolean): Promise<any> {
        await connect();
        client.sent.length = 0;
        const answer = command('gatt:subscribe', { gatewayId: 'proxy-og', address: DEVICE, handle: 32 });
        client.receive('BluetoothGATTGetServicesResponse', m => {
            m.setAddress(DEVICE_ADDRESS);
            const service = new pb.BluetoothGATTService();
            service.setShortUuid(0x1f10);
            service.setHandle(30);
            const characteristic = new pb.BluetoothGATTCharacteristic();
            characteristic.setShortUuid(0x1f1f);
            characteristic.setHandle(32);
            characteristic.setProperties(properties);
            if (withCccd) {
                const descriptor = new pb.BluetoothGATTDescriptor();
                descriptor.setShortUuid(0x2902);
                descriptor.setHandle(33);
                characteristic.addDescriptors(descriptor);
            }
            service.addCharacteristics(characteristic);
            m.addServices(service);
        });
        client.receive('BluetoothGATTGetServicesDoneResponse', m => m.setAddress(DEVICE_ADDRESS));
        await tick();
        client.receive('BluetoothGATTNotifyResponse', m => {
            m.setAddress(DEVICE_ADDRESS);
            m.setHandle(32);
        });
        return answer;
    }

    it('switches notifications on and writes the CCCD descriptor', async () => {
        expect(await subscribeWith(0x1a, true)).to.deep.equal({ error: null, result: {} });
        expect(client.sentOf('BluetoothGATTNotifyRequest')).to.deep.equal([
            { address: DEVICE_ADDRESS, handle: 32, enable: true },
        ]);
        expect(client.sentOf('BluetoothGATTWriteDescriptorRequest')).to.deep.equal([
            { address: DEVICE_ADDRESS, handle: 33, data: 'AQA=' },
        ]);
    });

    it('switches indications on for a characteristic without notify', async () => {
        await subscribeWith(0x22, true);
        expect(client.sentOf('BluetoothGATTWriteDescriptorRequest')).to.deep.equal([
            { address: DEVICE_ADDRESS, handle: 33, data: 'AgA=' },
        ]);
    });

    it('writes no descriptor when the characteristic has none', async () => {
        expect(await subscribeWith(0x1a, false)).to.deep.equal({ error: null, result: {} });
        expect(client.sentOf('BluetoothGATTWriteDescriptorRequest')).to.deep.equal([]);
    });

    it('passes notifications of connected devices on', async () => {
        await connect();
        client.receive('BluetoothGATTNotifyDataResponse', m => {
            m.setAddress(DEVICE_ADDRESS);
            m.setHandle(32);
            m.setData(Buffer.from('5501', 'hex'));
        });
        client.receive('BluetoothGATTNotifyDataResponse', m => {
            m.setAddress(OTHER_ADDRESS);
            m.setHandle(32);
            m.setData(Buffer.from('01', 'hex'));
        });
        expect(adapter.sentWith('gateway:notification').map(m => [m.instance, m.message, m.callback])).to.deep.equal([
            ['ble.0', { gatewayId: 'proxy-og', address: DEVICE, handle: 32, data: 'VQE=' }, undefined],
        ]);
    });

    it('reports a connection the device ended and fails its waiting requests', async () => {
        await connect();
        const pending = command('gatt:read', { gatewayId: 'proxy-og', address: DEVICE, handle: 32 });
        client.connectionResponse(DEVICE_ADDRESS, false, 0, 19);

        expect((await pending).error.code).to.equal('NOT_CONNECTED');
        expect(adapter.sentWith('gateway:connectionState').map(m => m.message)).to.deep.equal([
            { gatewayId: 'proxy-og', address: DEVICE, connected: false, error: 19 },
        ]);
        expect(
            (await command('gatt:read', { gatewayId: 'proxy-og', address: DEVICE, handle: 32 })).error.code,
        ).to.equal('NOT_CONNECTED');
    });

    it('does not report a connection ioBroker.ble closed itself', async () => {
        await connect();
        const answer = command('gatt:disconnect', { gatewayId: 'proxy-og', address: DEVICE });
        client.connectionResponse(DEVICE_ADDRESS, false);
        expect(await answer).to.deep.equal({ error: null, result: {} });
        expect(adapter.sentWith('gateway:connectionState')).to.deep.equal([]);
        expect(client.sentOf('BluetoothDeviceRequest').at(-1)!.requestType).to.equal(
            pb.BluetoothDeviceRequestType.BLUETOOTH_DEVICE_REQUEST_TYPE_DISCONNECT,
        );
    });

    it('answers a disconnect even without confirmation', async () => {
        await connect();
        const answer = command('gatt:disconnect', { gatewayId: 'proxy-og', address: DEVICE });
        adapter.expireTimeouts();
        expect(await answer).to.deep.equal({ error: null, result: {} });
    });

    it('refuses commands of other instances', async () => {
        client.sent.length = 0;
        const answer = await command(
            'gatt:connect',
            { gatewayId: 'proxy-og', address: DEVICE, addressType: 'public', epoch: 1 },
            'system.adapter.test.0',
        );
        expect(answer.error.code).to.equal('INVALID_PAYLOAD');
        expect(answer.error.message).to.include('ble.0');
        expect(client.sent).to.deep.equal([]);
    });

    it('rejects unknown gateways, missing connections and invalid payloads', async () => {
        expect(
            (await command('gatt:connect', { gatewayId: 'proxy-x', address: DEVICE, addressType: 'public', epoch: 1 }))
                .error.code,
        ).to.equal('UNKNOWN_GATEWAY');
        expect(
            (await command('gatt:read', { gatewayId: 'proxy-og', address: DEVICE, handle: 32 })).error.code,
        ).to.equal('NOT_CONNECTED');

        const valid = { gatewayId: 'proxy-og', address: DEVICE, addressType: 'public', epoch: 1 };
        for (const [name, message] of [
            ['gatt:connect', 'a4:c1:38:12:34:56'],
            ['gatt:connect', { ...valid, gatewayId: 1 }],
            ['gatt:connect', { ...valid, address: 'A4:C1:38:12:34:56' }],
            ['gatt:connect', { ...valid, addressType: 'unknown' }],
            ['gatt:connect', { ...valid, epoch: '1' }],
            ['gatt:read', { gatewayId: 'proxy-og', address: DEVICE, handle: -1 }],
            [
                'gatt:write',
                { gatewayId: 'proxy-og', address: DEVICE, handle: 32, data: 'not base64!', withResponse: true },
            ],
            ['gatt:write', { gatewayId: 'proxy-og', address: DEVICE, handle: 32, data: 'AQ==', withResponse: 'yes' }],
        ] as const) {
            expect((await command(name, message)).error.code, JSON.stringify(message)).to.equal('INVALID_PAYLOAD');
        }
    });

    it('closes the connections first when ioBroker.ble was restarted', async () => {
        await connect(DEVICE, DEVICE_ADDRESS, 1000);
        client.sent.length = 0;

        // Same start time: nothing is closed
        await connect(OTHER, OTHER_ADDRESS, 1000);
        expect(client.sentOf('BluetoothDeviceRequest').map(r => r.requestType)).to.deep.equal([
            pb.BluetoothDeviceRequestType.BLUETOOTH_DEVICE_REQUEST_TYPE_CONNECT_V3_WITHOUT_CACHE,
        ]);

        client.sent.length = 0;
        const answer = command('gatt:connect', {
            gatewayId: 'proxy-og',
            address: DEVICE,
            addressType: 'public',
            epoch: 2000,
        });
        expect(client.sentOf('BluetoothDeviceRequest').map(r => [r.address, r.requestType])).to.deep.equal([
            [DEVICE_ADDRESS, pb.BluetoothDeviceRequestType.BLUETOOTH_DEVICE_REQUEST_TYPE_DISCONNECT],
            [OTHER_ADDRESS, pb.BluetoothDeviceRequestType.BLUETOOTH_DEVICE_REQUEST_TYPE_DISCONNECT],
            [DEVICE_ADDRESS, pb.BluetoothDeviceRequestType.BLUETOOTH_DEVICE_REQUEST_TYPE_CONNECT_V3_WITHOUT_CACHE],
        ]);
        // The confirmation of the disconnect is not the answer to the new connect
        client.connectionResponse(DEVICE_ADDRESS, false);
        client.connectionResponse(DEVICE_ADDRESS, true, 185);
        expect(await answer).to.deep.equal({ error: null, result: { mtu: 185 } });
        // Closed on purpose: not reported
        expect(adapter.sentWith('gateway:connectionState')).to.deep.equal([]);
    });

    it('takes the start time from the answer to gateway:announce as well', async () => {
        adapter.answerAnnounce({ error: null, result: { protocol: 'ble-gateway/1', epoch: 1000 } });
        await connect(DEVICE, DEVICE_ADDRESS, 1000);
        client.sent.length = 0;
        adapter.answerAnnounce({ error: null, result: { protocol: 'ble-gateway/1', epoch: 3000 } });
        expect(client.sentOf('BluetoothDeviceRequest')).to.deep.equal([
            {
                address: DEVICE_ADDRESS,
                requestType: pb.BluetoothDeviceRequestType.BLUETOOTH_DEVICE_REQUEST_TYPE_DISCONNECT,
                hasAddressType: false,
                addressType: 0,
            },
        ]);
    });

    it('closes all connections when ioBroker.ble stops', async () => {
        await connect();
        client.sent.length = 0;
        expect(bridge.handleStateChange('system.adapter.ble.0.alive', { val: true } as ioBroker.State)).to.equal(true);
        expect(client.sent).to.deep.equal([]);
        expect(bridge.handleStateChange('system.adapter.ble.0.alive', { val: false } as ioBroker.State)).to.equal(true);
        expect(client.sentOf('BluetoothDeviceRequest').map(r => r.requestType)).to.deep.equal([
            pb.BluetoothDeviceRequestType.BLUETOOTH_DEVICE_REQUEST_TYPE_DISCONNECT,
        ]);
        expect(bridge.handleStateChange('system.adapter.other.0.alive', { val: false } as ioBroker.State)).to.equal(
            false,
        );
    });

    it('reports every open connection when the proxy is lost', async () => {
        await connect(DEVICE, DEVICE_ADDRESS);
        await connect(OTHER, OTHER_ADDRESS);
        const pending = command('gatt:read', { gatewayId: 'proxy-og', address: DEVICE, handle: 32 });

        forwarder.disconnected(HOST);
        bridge.disconnected(HOST);

        expect((await pending).error.code).to.equal('NOT_CONNECTED');
        expect(adapter.sentWith('gateway:connectionState').map(m => m.message.address)).to.deep.equal([DEVICE, OTHER]);
        // Without the proxy the gateway is unknown
        expect(
            (await command('gatt:read', { gatewayId: 'proxy-og', address: DEVICE, handle: 32 })).error.code,
        ).to.equal('UNKNOWN_GATEWAY');
    });

    it('closes everything and stops announcing on stop()', async () => {
        await connect();
        client.sent.length = 0;
        bridge.stop();
        expect(client.sentOf('BluetoothDeviceRequest').map(r => r.requestType)).to.deep.equal([
            pb.BluetoothDeviceRequestType.BLUETOOTH_DEVICE_REQUEST_TYPE_DISCONNECT,
        ]);
        expect(fireIntervals()).to.equal(0);
    });
});
