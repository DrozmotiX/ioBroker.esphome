// esphome.0.info.connection says whether the adapter itself runs: a boolean, as up to 1.0.1. Programs that read it as
// the online state of the adapter only accept true, the list of connected devices 2.0.0-beta.0/1 kept in it showed the
// adapter as disconnected there. The names of the connected devices are in info.connectedDevices, whether a single
// device is connected stays in <device>.info._online.

import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** An object or state write recorded by the stand-in adapter */
interface Recorded {
    kind: 'object' | 'state';
    id: string;
    type?: string;
    common?: Partial<ioBroker.StateCommon>;
    val?: ioBroker.StateValue;
    ack?: boolean;
}

/** The part of the adapter these tests call */
interface ConnectionAdapter {
    initConnectionStates(): Promise<void>;
    updateConnectionState(): Promise<void>;
    onUnload(callback: () => void): void;
}

/** One entry of instanceObjects in io-package.json */
interface InstanceObject {
    _id: string;
    type: string;
    common: Partial<ioBroker.StateCommon>;
}

const ioPackage = JSON.parse(readFileSync(join(__dirname, '../../io-package.json'), 'utf8')) as {
    instanceObjects: InstanceObject[];
};

describe('io-package.json: instance objects', () => {
    it('info.connection is the boolean online state of the adapter (indicator.connected)', () => {
        const connection = ioPackage.instanceObjects.find(entry => entry._id === 'info.connection');

        expect(connection, 'info.connection').to.be.ok;
        expect(connection!.type).to.equal('state');
        expect(connection!.common).to.include({
            type: 'boolean',
            role: 'indicator.connected',
            read: true,
            write: false,
            def: false,
        });
    });

    it('info.connectedDevices holds the names of the connected devices', () => {
        const connectedDevices = ioPackage.instanceObjects.find(entry => entry._id === 'info.connectedDevices');

        expect(connectedDevices, 'info.connectedDevices').to.be.ok;
        expect(connectedDevices!.type).to.equal('state');
        expect(connectedDevices!.common).to.include({
            type: 'string',
            role: 'info.status',
            read: true,
            write: false,
            def: '',
        });
    });
});

describe('adapter: info.connection and info.connectedDevices', () => {
    const corePath = require.resolve('@iobroker/adapter-core');
    const mainPath = require.resolve('../main');
    let savedCore: NodeJS.Module | undefined;
    let createAdapter: (options: object) => ConnectionAdapter;
    let adapter: ConnectionAdapter;
    let recorded: Recorded[] = [];

    /** Stands in for utils.Adapter: records object and state writes, no databases */
    class FakeAdapter extends EventEmitter {
        public log = { debug(): void {}, info(): void {}, warn(): void {}, error(): void {} };
        public namespace = 'esphome.0';
        public config = {};

        public extendObjectAsync(
            id: string,
            obj: { type?: string; common: Partial<ioBroker.StateCommon> },
        ): Promise<void> {
            recorded.push({ kind: 'object', id, type: obj.type, common: { ...obj.common } });
            return Promise.resolve();
        }

        public setStateAsync(id: string, state: { val: ioBroker.StateValue; ack: boolean }): Promise<void> {
            recorded.push({ kind: 'state', id, val: state.val, ack: state.ack });
            return Promise.resolve();
        }

        public setState(id: string, state: { val: ioBroker.StateValue; ack: boolean }): Promise<void> {
            return this.setStateAsync(id, state);
        }

        public clearTimeout(): undefined {
            return undefined;
        }

        public subscribeStates(): void {}
    }

    /**
     * The values written to one state, in order
     *
     * @param id - state id without the namespace
     */
    function valuesOf(id: string): [ioBroker.StateValue | undefined, boolean | undefined][] {
        return recorded.filter(entry => entry.kind === 'state' && entry.id === id).map(entry => [entry.val, entry.ack]);
    }

    before(() => {
        savedCore = require.cache[corePath];
        require.cache[corePath] = {
            id: corePath,
            filename: corePath,
            loaded: true,
            exports: { Adapter: FakeAdapter },
        } as unknown as NodeJS.Module;
        delete require.cache[mainPath];
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        createAdapter = require('../main') as (options: object) => ConnectionAdapter;
    });

    after(() => {
        delete require.cache[mainPath];
        if (savedCore) {
            require.cache[corePath] = savedCore;
        } else {
            delete require.cache[corePath];
        }
    });

    beforeEach(() => {
        recorded = [];
        adapter = createAdapter({});
    });

    it('the start turns info.connection into a boolean again and sets it to true', async () => {
        await adapter.initConnectionStates();

        const connection = recorded.find(entry => entry.kind === 'object' && entry.id === 'info.connection');
        expect(connection, 'object info.connection').to.be.ok;
        expect(connection!.common).to.include({
            type: 'boolean',
            role: 'indicator.connected',
            name: 'Device or service connected',
            def: false,
        });
        expect(valuesOf('info.connection')).to.deep.equal([[true, true]]);
    });

    it('the start creates info.connectedDevices and writes the device list there', async () => {
        await adapter.initConnectionStates();

        const connectedDevices = recorded.find(
            entry => entry.kind === 'object' && entry.id === 'info.connectedDevices',
        );
        expect(connectedDevices, 'object info.connectedDevices').to.be.ok;
        expect(connectedDevices!.type).to.equal('state');
        expect(connectedDevices!.common).to.include({ type: 'string', role: 'info.status', def: '' });
        expect(valuesOf('info.connectedDevices')).to.deep.equal([['', true]]);
    });

    it('an update of the device list never writes info.connection', async () => {
        await adapter.updateConnectionState();

        expect(valuesOf('info.connectedDevices')).to.deep.equal([['', true]]);
        expect(valuesOf('info.connection')).to.deep.equal([]);
    });

    it('the stop sets info.connection to false and empties info.connectedDevices', async () => {
        await new Promise<void>(resolve => adapter.onUnload(resolve));

        expect(valuesOf('info.connection')).to.deep.equal([[false, true]]);
        expect(valuesOf('info.connectedDevices')).to.deep.equal([['', true]]);
    });
});
