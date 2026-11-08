'use strict';

// <device>.info._online carries the role indicator.reachable, so other adapters can tell from the role
// alone whether an ESPHome device is reachable.

const { expect } = require('chai');
const { EventEmitter } = require('node:events');
const stateAttr = require('./stateAttr.js');

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
    const mainPath = require.resolve('../main.js');
    /** @type {NodeJS.Module | undefined} */
    let savedCore;
    /** @type {ReturnType<typeof import('../main.js')>} */
    let adapter;
    /** @type {Array<{id: string, common: Record<string, unknown>}>} */
    let extended = [];

    /** Stands in for utils.Adapter: records object writes, no databases. */
    class FakeAdapter extends EventEmitter {
        constructor() {
            super();
            this.log = { debug() {}, info() {}, warn() {}, error() {} };
        }
        /**
         * @param {string} id - object id
         * @param {{common: Record<string, unknown>}} obj - partial object
         */
        async extendObjectAsync(id, obj) {
            extended.push({ id, common: { ...obj.common } });
        }
        async setStateAsync() {}
        subscribeStates() {}
    }

    before(() => {
        savedCore = require.cache[corePath];
        require.cache[corePath] = /** @type {NodeJS.Module} */ (
            /** @type {unknown} */ ({
                id: corePath,
                filename: corePath,
                loaded: true,
                exports: { Adapter: FakeAdapter },
            })
        );
        delete require.cache[mainPath];
        adapter = require('../main.js')({});
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
