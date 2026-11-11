'use strict';

/**
 * ESPHome Dashboard in Docker, the part of the adapter: it stores the YAML directory for docker-compose.yaml,
 * creates it and then lets `@iobroker/plugin-docker` start the container. See test/testDockerCompose.js for
 * the container itself.
 */

const { expect } = require('chai');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('ESPHome Dashboard in Docker', () => {
    const corePath = require.resolve('@iobroker/adapter-core');
    const mainPath = require.resolve('../main.js');
    /** @type {NodeJS.Module | undefined} */
    let savedCore;
    /** @type {string} */
    let dataDir;
    /** @type {string} */
    let configDir;
    /** @type {ReturnType<typeof import('../main.js')>} */
    let adapter;
    /** @type {Array<{native: Record<string, unknown>}>} */
    let writtenObjects;
    /** @type {string[]} */
    let errors;
    let instanceIsReadyCalls = 0;

    /** Stands in for utils.Adapter: no databases, records configuration writes and errors. */
    class FakeAdapter extends EventEmitter {
        constructor() {
            super();
            this.instance = 0;
            this.namespace = 'esphome.0';
            this.log = {
                debug() {},
                info() {},
                warn() {},
                error: (/** @type {string} */ msg) => errors.push(msg),
            };
            /** @type {Record<string, unknown>} */
            this.config = {};
        }
        async getForeignObjectAsync(/** @type {string} */ id) {
            return {
                _id: id,
                type: 'instance',
                common: {},
                native: JSON.parse(JSON.stringify(this.config)),
            };
        }
        async setForeignObject(/** @type {string} */ _id, /** @type {{native: Record<string, unknown>}} */ obj) {
            writtenObjects.push(obj);
        }
        getPluginInstance(/** @type {string} */ name) {
            if (name !== 'docker') {
                return null;
            }
            return {
                instanceIsReady: async () => {
                    instanceIsReadyCalls++;
                },
                getDockerManager: () => ({
                    getDockerDaemonInfo: async () => ({ daemonRunning: true, driver: 'socket' }),
                }),
            };
        }
        // used by errorHandler(), which reports to Sentry
        supportsFeature() {
            return false;
        }
    }

    before(() => {
        dataDir = `${fs.mkdtempSync(path.join(os.tmpdir(), 'esphome-docker-'))}${path.sep}`;
        configDir = path.resolve(`${dataDir}esphome.0`);

        savedCore = require.cache[corePath];
        require.cache[corePath] = /** @type {NodeJS.Module} */ (
            /** @type {unknown} */ ({
                id: corePath,
                filename: corePath,
                loaded: true,
                exports: { Adapter: FakeAdapter, getAbsoluteDefaultDataDir: () => dataDir },
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
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        writtenObjects = [];
        errors = [];
        instanceIsReadyCalls = 0;
        fs.rmSync(configDir, { recursive: true, force: true });
        // only what the Docker part reads
        adapter.config = /** @type {ioBroker.AdapterConfig} */ (
            /** @type {unknown} */ ({
                ESPHomeDashboardPort: 6052,
                dockerEsphome: {
                    enabled: true,
                    version: 'stable',
                    stopIfInstanceStopped: false,
                    autoImageUpdate: true,
                    configDir: '',
                },
            })
        );
    });

    describe('prepareDockerDashboard()', () => {
        it('stores the YAML directory of the instance and asks for the restart', async () => {
            expect(await adapter.prepareDockerDashboard()).to.equal(true);

            expect(writtenObjects).to.have.length(1);
            expect(writtenObjects[0].native.dockerEsphome).to.deep.equal({
                ...adapter.config.dockerEsphome,
                configDir,
            });
        });

        it('leaves the configuration alone once the directory is stored', async () => {
            adapter.config.dockerEsphome.configDir = configDir;

            expect(await adapter.prepareDockerDashboard()).to.equal(false);
            expect(writtenObjects).to.have.length(0);
        });

        it('does nothing while Docker is not used', async () => {
            adapter.config.dockerEsphome.enabled = false;

            expect(await adapter.prepareDockerDashboard()).to.equal(false);
            expect(writtenObjects).to.have.length(0);
        });

        it('does nothing for an instance without Docker settings', async () => {
            delete (/** @type {Partial<ioBroker.AdapterConfig>} */ (adapter.config).dockerEsphome);

            expect(await adapter.prepareDockerDashboard()).to.equal(false);
            expect(writtenObjects).to.have.length(0);
        });
    });

    describe('startDockerDashboard()', () => {
        it('creates the YAML directory before the container is started', async () => {
            adapter.config.dockerEsphome.configDir = configDir;

            await adapter.startDockerDashboard();

            expect(fs.existsSync(configDir)).to.equal(true);
            expect(instanceIsReadyCalls).to.equal(1);
            expect(errors).to.deep.equal([]);
        });

        it('does not start a container that would mount another directory', async () => {
            adapter.config.dockerEsphome.configDir = '/somewhere/else';

            await adapter.startDockerDashboard();

            expect(instanceIsReadyCalls).to.equal(0);
            expect(errors).to.have.length(1);
        });
    });

    it('offers the release channels and keeps a version typed in by hand', async () => {
        adapter.config.dockerEsphome.version = '2025.12.7';
        /** @type {unknown[]} */
        let answer = [];
        adapter.sendTo = /** @type {typeof adapter.sendTo} */ (
            /** @type {unknown} */ (
                (/** @type {string} */ _to, /** @type {string} */ _command, /** @type {unknown[]} */ message) => {
                    answer = message;
                }
            )
        );

        await adapter.onMessage(
            /** @type {ioBroker.Message} */ (
                /** @type {unknown} */ ({
                    command: 'getESPHomeDockerVersion',
                    from: 'admin.0',
                    callback: {},
                    message: {},
                })
            ),
        );

        expect(answer.slice(0, 3)).to.deep.equal(['stable', 'beta', 'dev']);
        expect(answer).to.deep.include({ label: '2025.12.7', value: '2025.12.7' });
    });
});
