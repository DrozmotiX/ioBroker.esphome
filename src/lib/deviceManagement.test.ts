import type { ActionContext, DeviceInfo, DeviceLoadContext, JsonFormData } from '@iobroker/dm-utils';
import { expect } from 'chai';
import EsphomeDeviceManagement, { type DeviceActionResult, type DiscoveredDevice } from './deviceManagement';
import ClientDetails from './helpers';

/** Exposes the protected methods of the device management */
class TestDeviceManagement extends EsphomeDeviceManagement {
    load(): DeviceInfo<string>[] {
        const devices: DeviceInfo<string>[] = [];
        const context: DeviceLoadContext<string> = {
            addDevice: device => devices.push(device),
            setTotalDevices: () => {},
        };
        this.loadDevices(context);
        return devices;
    }

    detailsOf(ip: string): ReturnType<EsphomeDeviceManagement['getDeviceDetails']> {
        return this.getDeviceDetails(ip);
    }
}

/** Fake adapter with the devices and calls the device management uses */
function createAdapter(): {
    adapter: ConstructorParameters<typeof EsphomeDeviceManagement>[0];
    known: Record<string, ClientDetails>;
    discovered: Record<string, DiscoveredDevice>;
    added: { ip: string; apiPassword?: string; encryptionKey?: string }[];
    removed: string[];
    states: Record<string, unknown>;
} {
    const noop = (): void => {};
    const known: Record<string, ClientDetails> = {};
    const discovered: Record<string, DiscoveredDevice> = {};
    const added: { ip: string; apiPassword?: string; encryptionKey?: string }[] = [];
    const removed: string[] = [];
    const states: Record<string, unknown> = {};

    const adapter = {
        namespace: 'esphome.0',
        log: { info: noop, warn: noop, error: noop, debug: noop },
        on: noop,
        getObjectAsync: () => Promise.resolve({}),
        setObjectAsync: () => Promise.resolve(),
        setState: (id: string, val: unknown) => {
            states[id] = val;
            return Promise.resolve();
        },
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: (timer: NodeJS.Timeout) => clearTimeout(timer),
        decrypt: (value: string) => value.replace(/^enc:/, ''),
        knownDevices: () => known,
        discoveredDevices: () => discovered,
        addOrUpdateDevice: (
            ip: string,
            apiPassword: string | undefined,
            encryptionKey: string | undefined,
            respond: (response: DeviceActionResult) => void,
        ) => {
            added.push({ ip, apiPassword, encryptionKey });
            const device = new ClientDetails();
            device.storeConnectDetails(ip, !!encryptionKey);
            known[ip] = device;
            respond({ result: 'OK' });
            return Promise.resolve();
        },
        removeDevice: (ip: string) => {
            removed.push(ip);
            delete known[ip];
            return Promise.resolve({ result: 'OK' });
        },
    } as unknown as ConstructorParameters<typeof EsphomeDeviceManagement>[0];

    return { adapter, known, discovered, added, removed, states };
}

/**
 * Fake action context answering forms and confirmations with the given values
 *
 * @param form - Answer of showForm(), undefined for cancel
 * @param confirm - Answer of showConfirmation()
 */
function createContext(
    form: JsonFormData | undefined,
    confirm = true,
): { context: ActionContext; messages: unknown[] } {
    const messages: unknown[] = [];
    const context = {
        showMessage: (text: unknown) => {
            messages.push(text);
            return Promise.resolve();
        },
        showConfirmation: () => Promise.resolve(confirm),
        showForm: () => Promise.resolve(form),
        openProgress: () => Promise.resolve({ update: () => Promise.resolve(), close: () => Promise.resolve() }),
    } as unknown as ActionContext;
    return { context, messages };
}

/**
 * Known, connected device as stored by main.ts
 *
 * @param ip - IP address of the device
 */
function knownDevice(ip: string): ClientDetails {
    const device = new ClientDetails();
    device.storeExistingDetails(ip, true, 'AA:BB:CC:DD:EE:FF', 'AABBCCDDEEFF', 'kitchen', undefined, 'enc:secret');
    device.connectStatus = 'connected';
    return device;
}

describe('Device Management', () => {
    describe('loadDevices()', () => {
        it('lists known and discovered devices, known ones only once', () => {
            const { adapter, known, discovered } = createAdapter();
            known['192.168.0.10'] = knownDevice('192.168.0.10');
            discovered['192.168.0.11'] = { ip: '192.168.0.11', mac: '11:22:33:44:55:66', deviceFriendlyName: 'garage' };
            // Adopted in the meantime, must not show up twice
            discovered['192.168.0.10'] = {
                ip: '192.168.0.10',
                mac: 'AA:BB:CC:DD:EE:FF',
                deviceFriendlyName: 'kitchen',
            };

            const devices = new TestDeviceManagement(adapter).load();

            expect(devices.map(device => device.id)).to.deep.equal(['192.168.0.10', '192.168.0.11']);
            const [kitchen, garage] = devices;
            expect(kitchen.name).to.equal('kitchen');
            expect(kitchen.group?.key).to.equal('known');
            expect(kitchen.status).to.deep.include({
                connection: {
                    stateId: 'esphome.0.AABBCCDDEEFF.info._online',
                    mapping: { true: 'connected', false: 'disconnected' },
                },
            });
            expect(kitchen.actions?.map(action => action.id)).to.deep.equal(['edit', 'delete']);
            expect(garage.name).to.equal('garage');
            expect(garage.group?.key).to.equal('discovered');
            // Must not look like an added device that is offline
            expect(garage).to.not.have.property('status');
            expect(garage.backgroundColor).to.be.a('string');
            expect(garage.indicators?.map(indicator => indicator.id)).to.deep.equal(['discovered']);
            expect(kitchen).to.not.have.property('backgroundColor');
            expect(kitchen).to.not.have.property('indicators');
            expect(garage.actions?.map(action => action.id)).to.deep.equal(['adopt']);
        });

        it('shows a device without device information by its IP address', () => {
            const { adapter, known } = createAdapter();
            const device = new ClientDetails();
            device.storeConnectDetails('192.168.0.12', false);
            known['192.168.0.12'] = device;

            const [entry] = new TestDeviceManagement(adapter).load();

            expect(entry.name).to.equal('192.168.0.12');
            expect(entry.status).to.equal('disconnected');
        });

        it('offers the web server of the device when it has one', () => {
            const { adapter, known } = createAdapter();
            known['192.168.0.10'] = knownDevice('192.168.0.10');
            known['192.168.0.10'].deviceInfo = { webserverPort: 80 } as ClientDetails['deviceInfo'];

            const [entry] = new TestDeviceManagement(adapter).load();

            expect(entry.actions?.find(action => action.id === 'web')).to.deep.include({
                url: 'http://192.168.0.10:80',
            });
        });
    });

    describe('getDeviceDetails()', () => {
        it('returns the details of known and discovered devices', () => {
            const { adapter, known, discovered } = createAdapter();
            known['192.168.0.10'] = knownDevice('192.168.0.10');
            discovered['192.168.0.11'] = { ip: '192.168.0.11', mac: '11:22:33:44:55:66', deviceFriendlyName: 'garage' };
            const dm = new TestDeviceManagement(adapter);

            expect(dm.detailsOf('192.168.0.10')).to.deep.include({
                id: '192.168.0.10',
                data: {
                    name: 'kitchen',
                    ip: '192.168.0.10',
                    mac: 'AA:BB:CC:DD:EE:FF',
                    connectionStatus: 'connected',
                },
            });
            expect(dm.detailsOf('192.168.0.11')).to.deep.include({
                data: { name: 'garage', ip: '192.168.0.11', mac: '11:22:33:44:55:66' },
            });
            expect(dm.detailsOf('192.168.0.99')).to.have.property('error');
        });
    });

    describe('actions', () => {
        it('adds a device with the entered credentials', async () => {
            const { adapter, added } = createAdapter();
            const { context, messages } = createContext({
                ip: ' 192.168.0.20 ',
                encryptionKey: 'key',
                apiPassword: '',
            });

            const result = await new TestDeviceManagement(adapter).addDevice(context);

            expect(result).to.be.true;
            expect(added).to.deep.equal([{ ip: '192.168.0.20', apiPassword: undefined, encryptionKey: 'key' }]);
            expect(messages).to.deep.equal(['OK']);
        });

        it('adopts a discovered device under its IP address', async () => {
            const { adapter, added } = createAdapter();
            const { context } = createContext({ ip: 'ignored', encryptionKey: 'key' });

            await new TestDeviceManagement(adapter).addDevice(context, '192.168.0.11');

            expect(added[0].ip).to.equal('192.168.0.11');
        });

        it('does nothing when the form is cancelled', async () => {
            const { adapter, added } = createAdapter();
            const { context } = createContext(undefined);

            expect(await new TestDeviceManagement(adapter).addDevice(context)).to.be.false;
            expect(added).to.be.empty;
        });

        it('keeps the current credentials when editing without entering new ones', async () => {
            const { adapter, known, added } = createAdapter();
            known['192.168.0.10'] = knownDevice('192.168.0.10');
            const { context } = createContext({ ip: '192.168.0.10', encryptionKey: '', apiPassword: '' });

            await new TestDeviceManagement(adapter).editDevice('192.168.0.10', context);

            expect(added).to.deep.equal([{ ip: '192.168.0.10', apiPassword: undefined, encryptionKey: 'secret' }]);
        });

        it('deletes a device only after confirmation', async () => {
            const { adapter, known, removed } = createAdapter();
            known['192.168.0.10'] = knownDevice('192.168.0.10');
            const dm = new TestDeviceManagement(adapter);

            expect(await dm.confirmRemoveDevice('192.168.0.10', createContext(undefined, false).context)).to.be.false;
            expect(removed).to.be.empty;

            expect(await dm.confirmRemoveDevice('192.168.0.10', createContext(undefined, true).context)).to.be.true;
            expect(removed).to.deep.equal(['192.168.0.10']);
        });

        it('asks an open device manager to reload the list', async () => {
            const { adapter, states } = createAdapter();

            await new TestDeviceManagement(adapter).refreshDeviceList();

            expect(states['info.deviceManager']).to.equal(JSON.stringify({ command: 'all' }));
        });
    });
});
