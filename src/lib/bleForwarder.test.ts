import type { Client, DeviceInfoResponse } from '@2colors/esphome-native-api';
import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import {
    BLE_GATEWAY_COMMAND,
    BleForwarder,
    MAX_ADVERTISEMENTS_PER_MESSAGE,
    bleTargetInstance,
    gatewayId,
    isBluetoothProxy,
    macFromAddress,
    supportsRawAdvertisements,
    toGatewayAdvertisement,
    type BleForwarderAdapter,
    type GatewayAdvertisementsMessage,
    type RawAdvertisement,
} from './bleForwarder';

// The protobuf classes of the client library, to build messages exactly as a device sends them
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the library has no types for this file
const { pb } = require('@2colors/esphome-native-api/lib/utils/messages') as {
    pb: Record<string, { new (): any; deserializeBinary(bytes: Uint8Array): unknown }>;
};

/** BTHome v2 thermometer: battery 100 %, 25.00 °C, 50.55 % */
const BTHOME_HEX = '0201060e16d2fc4000a5016402c40903bf13';
const BTHOME_BASE64 = Buffer.from(BTHOME_HEX, 'hex').toString('base64');

/** bluetoothProxyFeatureFlags of a current Bluetooth proxy: passive scan, active connections, ..., raw advertisements */
const PROXY_FLAGS = 0b1111111;
/** Flags of a proxy built before ESPHome 2023.6.0: no raw advertisements */
const OLD_PROXY_FLAGS = 0b0011111;

const HOST = '192.0.2.20';

function deviceInfo(name: string, bluetoothProxyFeatureFlags: number): DeviceInfoResponse {
    return { name, bluetoothProxyFeatureFlags } as DeviceInfoResponse;
}

/**
 * A batch of raw advertisements as it arrives from a device: built with the protobuf classes of the
 * client library, serialized and parsed again
 *
 * @param advertisements - The advertisements, data as hex string
 */
function rawAdvertisementsMessage(
    advertisements: { address: number; rssi: number; addressType?: number; hex: string }[],
): unknown {
    const message = new pb.BluetoothLERawAdvertisementsResponse();
    for (const { address, rssi, addressType = 0, hex } of advertisements) {
        const advertisement = new pb.BluetoothLERawAdvertisement();
        advertisement.setAddress(address);
        advertisement.setRssi(rssi);
        advertisement.setAddressType(addressType);
        advertisement.setData(Buffer.from(hex, 'hex'));
        message.addAdvertisements(advertisement);
    }
    return pb.BluetoothLERawAdvertisementsResponse.deserializeBinary(message.serializeBinary());
}

/** Stands in for the client of a device */
class FakeClient {
    public readonly connection = {
        frameHelper: new EventEmitter(),
        subscribed: 0,
        unsubscribed: 0,
        failSubscribe: false,
        subscribeBluetoothAdvertisementService(): void {
            if (this.failSubscribe) {
                throw new Error('Not connected');
            }
            this.subscribed++;
        },
        unsubscribeBluetoothAdvertisementService(): void {
            this.unsubscribed++;
        },
    };

    /**
     * The device sends a message
     *
     * @param message - The message as the frame helper emits it
     */
    public receive(message: unknown): void {
        this.connection.frameHelper.emit('message', message);
    }

    public asClient(): Client {
        return this as unknown as Client;
    }
}

/** Stands in for the adapter: records what is sent and runs timers when the test says so */
class FakeAdapter implements BleForwarderAdapter {
    public readonly sent: { instance: string; command: string; message: GatewayAdvertisementsMessage }[] = [];
    public readonly warnings: string[] = [];
    public readonly infos: string[] = [];
    public readonly timeouts = new Map<number, { callback: () => void; ms: number }>();
    public readonly intervals = new Map<number, { callback: () => void; ms: number }>();
    public failSendTo = false;
    private nextTimer = 1;

    public readonly log = {
        debug: (): void => {},
        info: (message: string): void => {
            this.infos.push(message);
        },
        warn: (message: string): void => {
            this.warnings.push(message);
        },
    };

    public sendTo(instance: string, command: string, message: GatewayAdvertisementsMessage): void {
        if (this.failSendTo) {
            throw new Error('States DB is not connected');
        }
        this.sent.push({ instance, command, message });
    }

    public setTimeout(callback: () => void, ms: number): number {
        this.timeouts.set(this.nextTimer, { callback, ms });
        return this.nextTimer++;
    }

    public clearTimeout(timer: number): void {
        this.timeouts.delete(timer);
    }

    public setInterval(callback: () => void, ms: number): number {
        this.intervals.set(this.nextTimer, { callback, ms });
        return this.nextTimer++;
    }

    public clearInterval(timer: number): void {
        this.intervals.delete(timer);
    }

    /** Lets all pending timeouts expire */
    public runTimeouts(): void {
        for (const [id, { callback }] of [...this.timeouts]) {
            this.timeouts.delete(id);
            callback();
        }
    }

    /** Lets all intervals fire once */
    public runIntervals(): void {
        for (const { callback } of [...this.intervals.values()]) {
            callback();
        }
    }

    /** The batches sent so far, without the empty ones that only announce a gateway */
    public get batches(): GatewayAdvertisementsMessage[] {
        return this.sent.map(entry => entry.message).filter(message => message.items.length > 0);
    }
}

describe('lib/bleForwarder', () => {
    describe('bleTargetInstance()', () => {
        it('accepts an instance of ioBroker.ble', () => {
            expect(bleTargetInstance('ble.0')).to.equal('ble.0');
            expect(bleTargetInstance(' ble.12 ')).to.equal('ble.12');
            expect(bleTargetInstance('system.adapter.ble.1')).to.equal('ble.1');
        });

        it('treats everything else as "do not forward"', () => {
            for (const setting of ['', '_none', 'ble', 'ble.x', 'esphome.0', 'ble.0.1', undefined, null, 0, {}]) {
                expect(bleTargetInstance(setting), JSON.stringify(setting)).to.equal(null);
            }
        });
    });

    describe('supportsRawAdvertisements() / isBluetoothProxy()', () => {
        it('recognizes a current Bluetooth proxy', () => {
            expect(supportsRawAdvertisements({ bluetoothProxyFeatureFlags: PROXY_FLAGS })).to.equal(true);
            expect(isBluetoothProxy({ bluetoothProxyFeatureFlags: PROXY_FLAGS })).to.equal(true);
        });

        it('recognizes a proxy with a firmware too old for raw advertisements', () => {
            expect(supportsRawAdvertisements({ bluetoothProxyFeatureFlags: OLD_PROXY_FLAGS })).to.equal(false);
            expect(isBluetoothProxy({ bluetoothProxyFeatureFlags: OLD_PROXY_FLAGS })).to.equal(true);
            expect(isBluetoothProxy({ bluetoothProxyFeatureFlags: 0, legacyBluetoothProxyVersion: 5 })).to.equal(true);
        });

        it('recognizes a device without bluetooth_proxy', () => {
            expect(supportsRawAdvertisements({ bluetoothProxyFeatureFlags: 0 })).to.equal(false);
            expect(isBluetoothProxy({ bluetoothProxyFeatureFlags: 0, legacyBluetoothProxyVersion: 0 })).to.equal(false);
            expect(supportsRawAdvertisements(null)).to.equal(false);
            expect(isBluetoothProxy(undefined)).to.equal(false);
        });
    });

    describe('macFromAddress()', () => {
        it('returns the address in lowercase with colons', () => {
            expect(macFromAddress(0xa4c138123456)).to.equal('a4:c1:38:12:34:56');
            expect(macFromAddress(0xffffffffffff)).to.equal('ff:ff:ff:ff:ff:ff');
            // Leading zeros are kept
            expect(macFromAddress(0x0001020a0b0c)).to.equal('00:01:02:0a:0b:0c');
            expect(macFromAddress(0)).to.equal('00:00:00:00:00:00');
            // Large numbers may arrive as decimal string
            expect(macFromAddress('181149776360534')).to.equal('a4:c1:38:12:34:56');
        });

        it('rejects what is not a 48 bit address', () => {
            for (const address of [-1, 2 ** 48, 1.5, NaN, 'a4:c1:38:12:34:56', '', undefined, null, {}]) {
                expect(macFromAddress(address), JSON.stringify(address)).to.equal(null);
            }
        });
    });

    describe('toGatewayAdvertisement()', () => {
        const raw: RawAdvertisement = { address: 0xa4c138123456, rssi: -67, addressType: 0, data: BTHOME_BASE64 };

        it('keeps the payload untouched', () => {
            expect(toGatewayAdvertisement(raw)).to.deep.equal({
                address: 'a4:c1:38:12:34:56',
                addressType: 'public',
                rssi: -67,
                data: BTHOME_BASE64,
            });
        });

        it('maps the address types of the ESP32 Bluetooth stack', () => {
            const typeOf = (addressType: number | undefined): string | undefined =>
                toGatewayAdvertisement({ ...raw, addressType })?.addressType;
            expect(typeOf(0)).to.equal('public');
            expect(typeOf(1)).to.equal('random');
            // Resolvable private addresses with a public / random identity address
            expect(typeOf(2)).to.equal('public');
            expect(typeOf(3)).to.equal('random');
            expect(typeOf(7)).to.equal('unknown');
            expect(typeOf(undefined)).to.equal('unknown');
        });

        it('accepts an empty payload', () => {
            expect(toGatewayAdvertisement({ ...raw, data: '' })?.data).to.equal('');
        });

        it('drops advertisements that are not usable', () => {
            expect(toGatewayAdvertisement({ ...raw, address: undefined })).to.equal(null);
            expect(toGatewayAdvertisement({ ...raw, rssi: undefined })).to.equal(null);
            expect(toGatewayAdvertisement({ ...raw, data: undefined })).to.equal(null);
        });
    });

    describe('gatewayId()', () => {
        it('uses the ESPHome name', () => {
            expect(gatewayId('proxy-og', HOST)).to.equal('proxy-og');
        });

        it('only returns characters ioBroker.ble accepts', () => {
            expect(gatewayId('Wohnzimmer Proxy (OG)', HOST)).to.equal('Wohnzimmer_Proxy__OG_');
            expect(gatewayId('küche', HOST)).to.equal('k_che');
            expect(gatewayId('a'.repeat(80), HOST)).to.have.length(64);
        });

        it('falls back to the host for a device without name', () => {
            expect(gatewayId('', HOST)).to.equal(HOST);
            expect(gatewayId(null, 'fd00::2')).to.equal('fd00__2');
            expect(gatewayId(undefined, '')).to.equal('esphome');
        });
    });

    describe('BleForwarder', () => {
        let adapter: FakeAdapter;
        let client: FakeClient;
        let forwarder: BleForwarder;

        /** A proxy that is connected and was asked for its advertisements */
        function connectProxy(): void {
            forwarder.attach(HOST, client.asClient());
            forwarder.initialized(HOST, deviceInfo('proxy-og', PROXY_FLAGS));
            adapter.sent.length = 0;
        }

        beforeEach(() => {
            adapter = new FakeAdapter();
            client = new FakeClient();
            forwarder = new BleForwarder(adapter, 'ble.0', { now: () => 1000 });
        });

        it('does nothing while forwarding is disabled', () => {
            forwarder = new BleForwarder(adapter, null);
            expect(forwarder.enabled).to.equal(false);

            forwarder.attach(HOST, client.asClient());
            forwarder.initialized(HOST, deviceInfo('proxy-og', PROXY_FLAGS));
            client.receive(rawAdvertisementsMessage([{ address: 0xa4c138123456, rssi: -67, hex: BTHOME_HEX }]));
            adapter.runTimeouts();
            forwarder.stop();

            expect(client.connection.frameHelper.listenerCount('message')).to.equal(0);
            expect(client.connection.subscribed).to.equal(0);
            expect(client.connection.unsubscribed).to.equal(0);
            expect(adapter.sent).to.deep.equal([]);
            expect(adapter.timeouts.size + adapter.intervals.size).to.equal(0);
        });

        it('asks a Bluetooth proxy for its advertisements and announces it as gateway', () => {
            forwarder.attach(HOST, client.asClient());
            expect(client.connection.subscribed, 'before the connection is initialized').to.equal(0);

            forwarder.initialized(HOST, deviceInfo('proxy-og', PROXY_FLAGS));

            expect(client.connection.subscribed).to.equal(1);
            // An empty batch: ioBroker.ble knows the gateway, even if no BLE device is in range
            expect(adapter.sent).to.deep.equal([
                { instance: 'ble.0', command: BLE_GATEWAY_COMMAND, message: { gatewayId: 'proxy-og', items: [] } },
            ]);
            expect(adapter.infos.join('\n')).to.include('proxy-og').and.to.include('ble.0');
        });

        it('leaves devices without bluetooth_proxy alone', () => {
            forwarder.attach(HOST, client.asClient());
            forwarder.initialized(HOST, deviceInfo('kitchen-light', 0));
            client.receive(rawAdvertisementsMessage([{ address: 0xa4c138123456, rssi: -67, hex: BTHOME_HEX }]));
            adapter.runTimeouts();

            expect(client.connection.subscribed).to.equal(0);
            expect(adapter.sent).to.deep.equal([]);
            expect(adapter.warnings).to.deep.equal([]);
        });

        it('tells the user when the firmware of a proxy is too old', () => {
            forwarder.attach(HOST, client.asClient());
            forwarder.initialized(HOST, deviceInfo('old-proxy', OLD_PROXY_FLAGS));

            expect(client.connection.subscribed).to.equal(0);
            expect(adapter.sent).to.deep.equal([]);
            expect(adapter.warnings).to.have.length(1);
            expect(adapter.warnings[0]).to.include('old-proxy').and.to.include('2023.6.0');
        });

        it('collects the advertisements and sends them in one message', () => {
            connectProxy();

            client.receive(
                rawAdvertisementsMessage([
                    { address: 0xa4c138123456, rssi: -67, addressType: 0, hex: BTHOME_HEX },
                    { address: 0xc0cd266001a0, rssi: -91, addressType: 1, hex: '020106' },
                ]),
            );
            client.receive(rawAdvertisementsMessage([{ address: 0xa4c138000001, rssi: -70, hex: '0201061aff4c00' }]));

            expect(adapter.sent, 'before the batch interval is over').to.deep.equal([]);
            expect([...adapter.timeouts.values()].map(timer => timer.ms)).to.deep.equal([250]);

            adapter.runTimeouts();

            expect(adapter.sent).to.deep.equal([
                {
                    instance: 'ble.0',
                    command: BLE_GATEWAY_COMMAND,
                    message: {
                        gatewayId: 'proxy-og',
                        items: [
                            { address: 'a4:c1:38:12:34:56', addressType: 'public', rssi: -67, data: BTHOME_BASE64 },
                            { address: 'c0:cd:26:60:01:a0', addressType: 'random', rssi: -91, data: 'AgEG' },
                            {
                                address: 'a4:c1:38:00:00:01',
                                addressType: 'public',
                                rssi: -70,
                                data: Buffer.from('0201061aff4c00', 'hex').toString('base64'),
                            },
                        ],
                    },
                },
            ]);

            // The next advertisement starts a new batch
            client.receive(rawAdvertisementsMessage([{ address: 0xa4c138123456, rssi: -68, hex: BTHOME_HEX }]));
            adapter.runTimeouts();
            expect(adapter.batches).to.have.length(2);
        });

        it('sends a repeated advertisement once per batch, with the signal strength measured last', () => {
            connectProxy();

            for (const rssi of [-70, -68, -66]) {
                client.receive(rawAdvertisementsMessage([{ address: 0xa4c138123456, rssi, hex: BTHOME_HEX }]));
            }
            // Other content of the same BLE device and the same content of another one are kept
            client.receive(rawAdvertisementsMessage([{ address: 0xa4c138123456, rssi: -66, hex: '020106' }]));
            client.receive(rawAdvertisementsMessage([{ address: 0xa4c138000001, rssi: -80, hex: BTHOME_HEX }]));
            adapter.runTimeouts();

            expect(adapter.batches).to.have.length(1);
            expect(adapter.batches[0].items.map(item => `${item.address} ${item.rssi} ${item.data}`)).to.deep.equal([
                `a4:c1:38:12:34:56 -66 ${BTHOME_BASE64}`,
                'a4:c1:38:12:34:56 -66 AgEG',
                `a4:c1:38:00:00:01 -80 ${BTHOME_BASE64}`,
            ]);
        });

        it('never sends more advertisements in a message than ioBroker.ble accepts', () => {
            connectProxy();

            const advertisements = [];
            for (let i = 0; i < MAX_ADVERTISEMENTS_PER_MESSAGE + 20; i++) {
                advertisements.push({ address: 0xa4c138000000 + i, rssi: -70, hex: BTHOME_HEX });
            }
            // Devices send small batches
            for (let i = 0; i < advertisements.length; i += 16) {
                client.receive(rawAdvertisementsMessage(advertisements.slice(i, i + 16)));
            }
            adapter.runTimeouts();

            const sizes = adapter.batches.map(batch => batch.items.length);
            expect(Math.max(...sizes)).to.be.at.most(MAX_ADVERTISEMENTS_PER_MESSAGE);
            expect(sizes.reduce((sum, size) => sum + size, 0)).to.equal(advertisements.length);
        });

        it('ignores other messages of the device', () => {
            connectProxy();

            client.receive(new pb.PingResponse());
            client.receive(undefined);
            client.receive({});
            adapter.runTimeouts();

            expect(adapter.sent).to.deep.equal([]);
            expect(adapter.timeouts.size).to.equal(0);
        });

        it('drops what was collected when the connection is lost and subscribes again after reconnecting', () => {
            connectProxy();
            client.receive(rawAdvertisementsMessage([{ address: 0xa4c138123456, rssi: -67, hex: BTHOME_HEX }]));

            forwarder.disconnected(HOST);
            adapter.runTimeouts();
            expect(adapter.sent, 'after the connection was lost').to.deep.equal([]);
            expect(adapter.timeouts.size).to.equal(0);

            // Reconnected: the subscription ended with the old connection
            forwarder.initialized(HOST, deviceInfo('proxy-og', PROXY_FLAGS));
            expect(client.connection.subscribed).to.equal(2);

            client.receive(rawAdvertisementsMessage([{ address: 0xa4c138123456, rssi: -67, hex: BTHOME_HEX }]));
            adapter.runTimeouts();
            expect(adapter.batches).to.have.length(1);
        });

        it('keeps a gateway that receives nothing known to ioBroker.ble', () => {
            let now = 1000;
            forwarder = new BleForwarder(adapter, 'ble.0', { now: () => now });
            connectProxy();
            expect([...adapter.intervals.values()].map(timer => timer.ms)).to.deep.equal([30000]);

            // Something was sent recently: nothing to do
            now += 20000;
            adapter.runIntervals();
            expect(adapter.sent).to.deep.equal([]);

            now += 10000;
            adapter.runIntervals();
            expect(adapter.sent.map(entry => entry.message)).to.deep.equal([{ gatewayId: 'proxy-og', items: [] }]);

            // Not for a proxy that is offline
            forwarder.disconnected(HOST);
            now += 60000;
            adapter.runIntervals();
            expect(adapter.sent).to.have.length(1);
        });

        it('keeps the devices apart', () => {
            const other = new FakeClient();
            forwarder.attach(HOST, client.asClient());
            forwarder.attach('192.0.2.21', other.asClient());
            forwarder.initialized(HOST, deviceInfo('proxy-og', PROXY_FLAGS));
            forwarder.initialized('192.0.2.21', deviceInfo('proxy-keller', PROXY_FLAGS));
            adapter.sent.length = 0;

            // Both receive the same packet
            client.receive(rawAdvertisementsMessage([{ address: 0xa4c138123456, rssi: -55, hex: BTHOME_HEX }]));
            other.receive(rawAdvertisementsMessage([{ address: 0xa4c138123456, rssi: -85, hex: BTHOME_HEX }]));
            adapter.runTimeouts();

            expect(adapter.batches.map(batch => `${batch.gatewayId} ${batch.items[0].rssi}`).sort()).to.deep.equal([
                'proxy-keller -85',
                'proxy-og -55',
            ]);
        });

        it('listens to the new client when a device is connected again from scratch', () => {
            connectProxy();
            const replacement = new FakeClient();
            forwarder.attach(HOST, replacement.asClient());
            forwarder.initialized(HOST, deviceInfo('proxy-og', PROXY_FLAGS));
            adapter.sent.length = 0;

            client.receive(rawAdvertisementsMessage([{ address: 0xa4c138123456, rssi: -67, hex: BTHOME_HEX }]));
            adapter.runTimeouts();
            expect(adapter.sent, 'from the old client').to.deep.equal([]);

            replacement.receive(rawAdvertisementsMessage([{ address: 0xa4c138123456, rssi: -67, hex: BTHOME_HEX }]));
            adapter.runTimeouts();
            expect(adapter.batches).to.have.length(1);
        });

        it('forgets a deleted device', () => {
            connectProxy();
            client.receive(rawAdvertisementsMessage([{ address: 0xa4c138123456, rssi: -67, hex: BTHOME_HEX }]));

            forwarder.detach(HOST);
            adapter.runTimeouts();
            client.receive(rawAdvertisementsMessage([{ address: 0xa4c138123456, rssi: -67, hex: BTHOME_HEX }]));
            adapter.runTimeouts();
            adapter.runIntervals();

            expect(adapter.sent).to.deep.equal([]);
        });

        it('survives a device that cannot be subscribed and a message that cannot be delivered', () => {
            forwarder.attach(HOST, client.asClient());
            client.connection.failSubscribe = true;
            forwarder.initialized(HOST, deviceInfo('proxy-og', PROXY_FLAGS));
            expect(adapter.warnings).to.have.length(1);
            expect(adapter.sent).to.deep.equal([]);

            client.connection.failSubscribe = false;
            forwarder.initialized(HOST, deviceInfo('proxy-og', PROXY_FLAGS));
            adapter.failSendTo = true;
            client.receive(rawAdvertisementsMessage([{ address: 0xa4c138123456, rssi: -67, hex: BTHOME_HEX }]));
            expect(() => adapter.runTimeouts()).not.to.throw();
        });

        it('lists the proxies that forward advertisements', () => {
            const other = new FakeClient();
            const passive = new FakeClient();
            forwarder.attach(HOST, client.asClient());
            forwarder.attach('192.0.2.21', other.asClient());
            forwarder.attach('192.0.2.22', passive.asClient());
            forwarder.initialized(HOST, deviceInfo('proxy-og', PROXY_FLAGS));
            forwarder.initialized('192.0.2.21', deviceInfo('proxy-keller', PROXY_FLAGS));
            // A device without bluetooth_proxy is not subscribed, so it is no gateway
            forwarder.initialized('192.0.2.22', deviceInfo('kitchen-light', 0));

            expect(forwarder.listGateways()).to.deep.equal([
                { gatewayId: 'proxy-og', host: HOST, client: client.asClient() },
                { gatewayId: 'proxy-keller', host: '192.0.2.21', client: other.asClient() },
            ]);
            expect(forwarder.findGateway('proxy-keller')?.host).to.equal('192.0.2.21');
            expect(forwarder.findGateway('kitchen-light')).to.equal(undefined);
            expect(forwarder.findGateway('unknown')).to.equal(undefined);

            // Not while the connection to the proxy is lost
            forwarder.disconnected('192.0.2.21');
            expect(forwarder.findGateway('proxy-keller')).to.equal(undefined);
            expect(forwarder.listGateways().map(gateway => gateway.gatewayId)).to.deep.equal(['proxy-og']);
        });

        it('tells the proxies to stop and sends nothing more when the adapter stops', () => {
            connectProxy();
            client.receive(rawAdvertisementsMessage([{ address: 0xa4c138123456, rssi: -67, hex: BTHOME_HEX }]));

            forwarder.stop();

            expect(client.connection.unsubscribed).to.equal(1);
            expect(adapter.timeouts.size + adapter.intervals.size, 'pending timers').to.equal(0);
            client.receive(rawAdvertisementsMessage([{ address: 0xa4c138123456, rssi: -67, hex: BTHOME_HEX }]));
            adapter.runTimeouts();
            expect(adapter.sent).to.deep.equal([]);
        });
    });
});
