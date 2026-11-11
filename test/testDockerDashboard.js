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
    /** a YAML directory chosen in the admin, outside of the data directory of the instance */
    /** @type {string} */
    let customDir;
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
        customDir = path.resolve(`${dataDir}yaml`);

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
        fs.rmSync(customDir, { recursive: true, force: true });
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

        it('keeps a directory chosen in the admin', async () => {
            adapter.config.dockerEsphome.configDir = customDir;

            expect(await adapter.prepareDockerDashboard()).to.equal(false);
            expect(writtenObjects).to.have.length(0);
        });

        it('stores a chosen directory normalized', async () => {
            adapter.config.dockerEsphome.configDir = `${path.join(customDir, '..', 'yaml')}${path.sep}`;

            expect(await adapter.prepareDockerDashboard()).to.equal(true);
            expect(writtenObjects[0].native.dockerEsphome).to.have.property('configDir', customDir);
        });

        it('resolves a relative directory against the ioBroker data directory', async () => {
            adapter.config.dockerEsphome.configDir = 'yaml';

            expect(await adapter.prepareDockerDashboard()).to.equal(true);
            expect(writtenObjects[0].native.dockerEsphome).to.have.property('configDir', customDir);
        });

        it('does not store a directory that cannot be used', async () => {
            adapter.config.dockerEsphome.configDir = `${path.dirname(path.resolve(dataDir))}${path.sep}`;

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

        it('creates and mounts a directory chosen in the admin', async () => {
            adapter.config.dockerEsphome.configDir = customDir;

            await adapter.startDockerDashboard();

            expect(fs.existsSync(customDir)).to.equal(true);
            expect(fs.existsSync(configDir)).to.equal(false);
            expect(instanceIsReadyCalls).to.equal(1);
            expect(errors).to.deep.equal([]);
        });

        it('does not start a container that would mount another directory', async () => {
            // not stored normalized yet, prepareDockerDashboard() failed
            adapter.config.dockerEsphome.configDir = 'yaml';

            await adapter.startDockerDashboard();

            expect(instanceIsReadyCalls).to.equal(0);
            expect(errors).to.have.length(1);
        });

        for (const [what, dir] of /** @type {Array<[string, () => string]>} */ ([
            ['the ioBroker data directory', () => path.resolve(dataDir)],
            ['a folder above the ioBroker data directory', () => path.dirname(path.resolve(dataDir))],
            ['the root of the file system', () => path.parse(path.resolve(dataDir)).root],
        ])) {
            it(`refuses to mount ${what}`, async () => {
                adapter.config.dockerEsphome.configDir = dir();

                await adapter.startDockerDashboard();

                expect(instanceIsReadyCalls).to.equal(0);
                expect(errors).to.have.length(1);
                expect(errors[0]).to.include('cannot be used');
            });
        }
    });

    describe('YAML file management', () => {
        it('uses the directory of the container while Docker is enabled', () => {
            adapter.config.dockerEsphome.configDir = customDir;

            expect(path.resolve(adapter.yamlFileManager.getESPHomeDirectory())).to.equal(customDir);
        });

        it('uses the data directory of the instance without Docker', () => {
            adapter.config.dockerEsphome.configDir = customDir;
            adapter.config.dockerEsphome.enabled = false;

            expect(path.resolve(adapter.yamlFileManager.getESPHomeDirectory())).to.equal(configDir);
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
