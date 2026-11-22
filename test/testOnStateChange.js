'use strict';

// A command for a device that is not connected stays at ack:false (issue #541, point 1).
// The 'disconnected' handler removes the device from deviceStateRelation, so onStateChange cannot send
// the command. An ack would tell callers that wait for it (retries, failure handling) that it arrived.

const { expect } = require('chai');
const { EventEmitter } = require('node:events');

describe('onStateChange: command for a device that is not connected', () => {
    const corePath = require.resolve('@iobroker/adapter-core');
    const mainPath = require.resolve('../main.js');
    /** @type {NodeJS.Module | undefined} */
    let savedCore;
    /** @type {ReturnType<typeof import('../main.js')>} */
    let adapter;
    /** @type {Array<{id: string, state: unknown}>} */
    let stateWrites = [];
    /** @type {Array<{level: string, msg: string}>} */
    let logs = [];

    /** Stands in for utils.Adapter: records state writes and log lines, no databases. */
    class FakeAdapter extends EventEmitter {
        constructor() {
            super();
            this.log = {
                /** @param {string} msg - log line */
                debug: msg => logs.push({ level: 'debug', msg }),
                /** @param {string} msg - log line */
                info: msg => logs.push({ level: 'info', msg }),
                /** @param {string} msg - log line */
                warn: msg => logs.push({ level: 'warn', msg }),
                /** @param {string} msg - log line */
                error: msg => logs.push({ level: 'error', msg }),
            };
        }
        /**
         * @param {string} id - state id
         * @param {unknown} state - value or state object
         */
        async setStateAsync(id, state) {
            stateWrites.push({ id, state });
        }
        /**
         * @param {string} id - state id
         * @param {unknown} state - value or state object
         */
        setState(id, state) {
            stateWrites.push({ id, state });
        }
        async extendObjectAsync() {}
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
        stateWrites = [];
        logs = [];
        // As after the 'disconnected' handler ran: the device is no longer in deviceStateRelation.
        adapter.deviceStateRelation = {};
    });

    const id = 'esphome.0.004B1296140C.Switch.123456789.state';
    /** @type {ioBroker.State} */
    const command = { val: true, ack: false, ts: 1, lc: 1, from: 'system.adapter.javascript.0', q: 0 };

    it('writes nothing back, so the command stays at ack:false', async () => {
        await adapter.onStateChange(id, command);

        expect(stateWrites).to.deep.equal([]);
    });

    it('logs one warning naming the device and the state', async () => {
        await adapter.onStateChange(id, command);

        const warnings = logs.filter(line => line.level === 'warn');
        expect(warnings).to.have.length(1);
        expect(warnings[0].msg).to.include('004B1296140C').and.to.include(id);
    });

    it('stops before the command path, so nothing reaches the error log', async () => {
        await adapter.onStateChange(id, command);

        expect(logs.filter(line => line.level === 'error')).to.deep.equal([]);
    });
});
