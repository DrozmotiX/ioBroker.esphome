// <device>.info._online carries the role indicator.reachable, so other adapters can tell from the role
// alone whether an ESPHome device is reachable (1.0.1). The TypeScript rework had lost this entry once.

import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import stateAttr from './stateAttr';

/** An object write recorded by the stand-in adapter */
interface ExtendedObject {
    id: string;
    common: Partial<ioBroker.StateCommon>;
}

/** The part of the adapter these tests call */
interface StateSetCreateAdapter {
    stateSetCreate(objName: string, name: string, value?: boolean | string | number | null): Promise<void>;
    createdStatesDetails: Record<string, Partial<ioBroker.StateCommon>>;
}

describe('stateAttr', () => {
    it('Online state is a read-only boolean with the role indicator.reachable', () => {
        expect(stateAttr['Online state']).to.include({
            name: 'Online state',
            type: 'boolean',
            read: true,
            write: false,
            role: 'indicator.reachable',
        });
    });
});

describe('stateSetCreate: <device>.info._online', () => {
    const corePath = require.resolve('@iobroker/adapter-core');
    const mainPath = require.resolve('../main');
    let savedCore: NodeJS.Module | undefined;
    let adapter: StateSetCreateAdapter;
    let extended: ExtendedObject[] = [];

    /** Stands in for utils.Adapter: records object writes, no databases */
    class FakeAdapter extends EventEmitter {
        public log = { debug(): void {}, info(): void {}, warn(): void {}, error(): void {} };
        public namespace = 'esphome.0';
        public config = {};

        public extendObjectAsync(id: string, obj: { common: Partial<ioBroker.StateCommon> }): Promise<void> {
            extended.push({ id, common: { ...obj.common } });
            return Promise.resolve();
        }

        public setStateAsync(): Promise<void> {
            return Promise.resolve();
        }

        public subscribeStates(): void {}
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
        const createAdapter = require('../main') as (options: object) => StateSetCreateAdapter;
        adapter = createAdapter({});
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
        extended = [];
    });

    it('creates the state with the role indicator.reachable', async () => {
        await adapter.stateSetCreate('004B1296140C.info._online', 'Online state', false);

        expect(extended).to.have.length(1);
        expect(extended[0].id).to.equal('004B1296140C.info._online');
        expect(extended[0].common).to.include({
            name: 'Online state',
            type: 'boolean',
            write: false,
            role: 'indicator.reachable',
        });
    });

    it('an object known with the old role "state" is updated once, then left alone', async () => {
        adapter.createdStatesDetails['AABBCCDDEEFF.info._online'] = {
            name: 'Online state',
            type: 'boolean',
            role: 'state',
            read: true,
            unit: '',
            write: false,
        };

        await adapter.stateSetCreate('AABBCCDDEEFF.info._online', 'Online state', true);
        await adapter.stateSetCreate('AABBCCDDEEFF.info._online', 'Online state', false);

        expect(extended.map(entry => entry.common.role)).to.deep.equal(['indicator.reachable']);
    });
});
