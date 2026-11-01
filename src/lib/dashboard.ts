/**
 * ESPHome Dashboard Module
 * Handles everything around the ESPHome Dashboard integrated in the adapter: migration of the
 * dashboard configuration, lookup of the available ESPHome, Pillow and ESPHome Device Builder
 * versions, the version dropDowns of the adapter configuration and the dashboard process started
 * through autopy.
 */

import * as utils from '@iobroker/adapter-core';
import type { getVenv } from 'autopy' with { 'resolution-mode': 'import' };
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { autoDetect, buildRequirements, compareVersions, usesDeviceBuilder } from './dashboardRequirements';

/** The ESPHome dashboard process started through autopy */
type DashboardProcess = ReturnType<Awaited<ReturnType<typeof getVenv>>>;

/** One entry of a version dropDown in the adapter configuration */
type VersionDropDownEntry = string | { label: string; value: string };

/** Adapter functions used by the dashboard, implemented by the Esphome adapter class in main.ts */
export interface DashboardAdapter extends ioBroker.Adapter {
    /** Create or update a state, see Esphome.stateSetCreate() */
    stateSetCreate(
        objName: string,
        name: string,
        value?: boolean | string | number | null,
        unit?: string,
        writable?: boolean,
        initialStateCommon?: Partial<ioBroker.StateCommon>,
    ): Promise<void>;
    /** Log an error and send it to Sentry, see Esphome.errorHandler() */
    errorHandler(codepart: string, error: unknown): void;
}

// ESPHome version installations are pinned to. ESPHome 2026.7.x failed to install for a part of our
// users (#463): the Pillow version selected here conflicted with the one ESPHome pins, and 2026.7.0
// removed the built-in dashboard, both handled since (#479, see dashboardRequirements.ts). Both the
// default for new installations and the one-time migration in migratePinnedVersions() point at the
// last version known to work instead of "Always last available". Keep in sync with the "native"
// defaults in io-package.json.
const defaultDashboardVersion = '2026.6.5';

// States holding whether the one-time migrations already ran: away from "Always last available" for
// the ESPHome version, and to "Auto Detect" for the Pillow version.
const versionMigrationState = '_ESPHomeDashboard.versionPinMigrationDone';
const pillowMigrationState = '_ESPHomeDashboard.pillowAutoDetectMigrationDone';

/**
 * ESPHome Dashboard class, one instance per adapter instance
 */
class Dashboard {
    private readonly adapter: DashboardAdapter;
    /** The running dashboard process, if started */
    private dashboardProcess: DashboardProcess | undefined;
    /** Memory cache of all available ESPHome Dashboard versions */
    private readonly dashboardVersions: string[] = [];
    /** Memory cache for available Pillow versions */
    private readonly pillowVersions: string[] = [];
    /** Memory cache for available ESPHome Device Builder versions */
    private readonly deviceBuilderVersions: string[] = [];

    /**
     * Constructor for Dashboard
     *
     * @param adapter - The ioBroker adapter instance
     */
    constructor(adapter: DashboardAdapter) {
        this.adapter = adapter;
    }

    /**
     * Migrate configuration from older adapter versions
     * Automatically set ESPHomeDashboardUrl if ESPHomeDashboardIP is set but URL is empty
     */
    async migrateConfig(): Promise<void> {
        try {
            // Check if migration is needed:
            // ESPHomeDashboardIP is not empty AND ESPHomeDashboardUrl is empty
            if (this.adapter.config.ESPHomeDashboardIP && !this.adapter.config.ESPHomeDashboardUrl) {
                const calculatedUrl = `http://${this.adapter.config.ESPHomeDashboardIP}:${this.adapter.config.ESPHomeDashboardPort}`;

                this.adapter.log.info(`Migrating configuration: Setting ESPHomeDashboardUrl to ${calculatedUrl}`);

                const adapterObj = await this.adapter.getForeignObjectAsync(`system.adapter.${this.adapter.namespace}`);
                if (!adapterObj) {
                    this.adapter.log.error(
                        `Configuration migration failed: Could not retrieve adapter configuration object for ${this.adapter.namespace}`,
                    );
                    return;
                }
                if (!adapterObj.native) {
                    this.adapter.log.error(
                        `Configuration migration failed: Adapter configuration object has no native property`,
                    );
                    return;
                }
                adapterObj.native.ESPHomeDashboardUrl = calculatedUrl;
                await this.adapter.setForeignObject(adapterObj._id, adapterObj);

                this.adapter.log.info(
                    `Configuration migrated successfully. ESPHomeDashboardUrl set to: ${calculatedUrl}`,
                );

                // adapter will restart
            }
        } catch (error) {
            const reason = error instanceof Error && error.message ? error.message : String(error);
            this.adapter.log.error(
                `Error during configuration migration from ESPHomeDashboardIP to ESPHomeDashboardUrl: ${reason}`,
            );
        }
    }

    /**
     * One-time migrations of the version settings:
     * - an ESPHome version still on "Always last available" is pinned to the last version known to
     *   work. The pinned default in io-package.json only applies to new installations, so without this
     *   every existing installation would stay on a release line that could not be installed (#463).
     * - the Pillow version is set to "Auto Detect". Every ESPHome release since 2024.12 pins the Pillow
     *   version it needs, any other selected version makes the installation fail (#479). Until now a
     *   Pillow version had to be selected, so a selected version tells nothing about the user's intent.
     *
     * Whether a migration already ran is stored in a state, not in "native": a new installation
     * already ships the defaults, and a "native" marker would be seeded into every existing instance
     * on upgrade, so neither could tell "not migrated yet" from "nothing to migrate". Once a marker is
     * set, a deliberate change of the setting is never touched again.
     */
    async migratePinnedVersions(): Promise<void> {
        try {
            await this.adapter.extendObjectAsync('_ESPHomeDashboard', {
                type: 'channel',
                common: {
                    name: 'ESPHome Dashboard details',
                },
                native: {},
            });

            const versionMigrationDone = (await this.adapter.getStateAsync(versionMigrationState))?.val === true;
            const pillowMigrationDone = (await this.adapter.getStateAsync(pillowMigrationState))?.val === true;
            if (versionMigrationDone && pillowMigrationDone) {
                return;
            }

            const migrated: Record<string, string> = {};
            if (!versionMigrationDone && this.adapter.config.ESPHomeDashboardVersion === 'Always last available') {
                migrated.ESPHomeDashboardVersion = defaultDashboardVersion;
            }
            if (!pillowMigrationDone && this.adapter.config.PillowVersion !== autoDetect) {
                migrated.PillowVersion = autoDetect;
            }

            if (Object.keys(migrated).length) {
                const adapterObj = await this.adapter.getForeignObjectAsync(`system.adapter.${this.adapter.namespace}`);
                if (!adapterObj || !adapterObj.native) {
                    this.adapter.log.error(
                        `Migration of the dashboard versions failed: could not read the configuration object of ${this.adapter.namespace}. Please select a fixed ESPHome Dashboard version and "${autoDetect}" as Pillow version in the adapter configuration.`,
                    );
                    return;
                }

                if (migrated.ESPHomeDashboardVersion) {
                    this.adapter.log.info(
                        `Not every ESPHome release can be installed on every system, so your configuration has been migrated once from "Always last available" to the last version known to work: ESPHomeDashboardVersion = ${migrated.ESPHomeDashboardVersion}. Select "Always last available" again in the adapter configuration if you prefer to follow the newest release, this migration only runs once.`,
                    );
                }
                if (migrated.PillowVersion) {
                    this.adapter.log.info(
                        `ESPHome installs the Pillow version it needs itself, so the Pillow version has been changed once from ${this.adapter.config.PillowVersion || 'none'} to "${autoDetect}". A different version makes the installation fail. You can still select one in the advanced dashboard settings, this migration only runs once.`,
                    );
                }

                Object.assign(adapterObj.native, migrated);
                // Keep this run consistent until the restart caused by the write below kicks in
                Object.assign(this.adapter.config, migrated);

                await this.adapter.setForeignObject(adapterObj._id, adapterObj);
                // adapter will restart
            }

            // Written after the configuration: should the write above fail, the migration is retried
            // on the next start instead of being silently skipped forever. Without changes (new
            // installation, versions already pinned) only the markers are written, so a later
            // deliberate change of the settings is respected.
            await this.adapter.stateSetCreate(versionMigrationState, 'versionPinMigrationDone', true);
            await this.adapter.stateSetCreate(pillowMigrationState, 'pillowAutoDetectMigrationDone', true);
        } catch (error) {
            this.adapter.errorHandler(`[migratePinnedVersions]`, error);
        }
    }

    /**
     * Warn when a version is left at "Always last available". Such a setup can break without any
     * change on the user side as soon as an ESPHome release cannot be installed (#463). Reached only
     * when the user selected it deliberately, migratePinnedVersions() moves existing installations
     * off that setting once.
     *
     * @param useDashBoardVersion - ESPHome Dashboard version which will be installed
     */
    warnUnpinnedVersions(useDashBoardVersion: string): void {
        if (this.adapter.config.ESPHomeDashboardVersion === 'Always last available') {
            this.adapter.log.warn(
                `ESPHome Dashboard version is set to "Always last available" and resolves to ${useDashBoardVersion || 'the newest release'}. Not every ESPHome release can be installed on every system. If the dashboard does not start, select a fixed version in the adapter configuration, ${defaultDashboardVersion} is known to work.`,
            );
        }
    }

    /**
     * Get the available versions and start the ESPHome Dashboard process (if enabled)
     */
    async start(): Promise<void> {
        try {
            // Create Channel to store ESPHomeDashboard related Data
            await this.adapter.extendObjectAsync('_ESPHomeDashboard', {
                type: 'channel',
                common: {
                    name: 'ESPHome Dashboard details',
                },
                native: {},
            });

            // Get all current available ESPHome Dashboard versions
            /** GitHub releases by index, only the name is used */
            let content: Record<string, { name: string }> | undefined;
            let lastUsed: string | undefined;
            let useDashBoardVersion = '';

            // Get data from state which version was used previous Time
            try {
                const lastUsedState = await this.adapter.getStateAsync(`_ESPHomeDashboard.selectedVersion`);
                if (lastUsedState && lastUsedState.val) {
                    // string or number depending on adapter version
                    lastUsed = String(lastUsedState.val);
                }
            } catch {
                // State does not exist
            }

            try {
                const response = await fetch('https://api.github.com/repos/esphome/esphome/releases');
                if (!response.ok) {
                    throw new Error(
                        `GitHub releases request failed with status ${response.status}: ${response.statusText}`,
                    );
                }
                content = (await response.json()) as Record<string, { name: string }>;
            } catch (error) {
                this.adapter.errorHandler(`[espHomeDashboard-VersionCall]`, error);
            }

            // If the response was successful, write versions names to a memory array
            if (content) {
                await this.adapter.stateSetCreate(
                    `_ESPHomeDashboard.versionCache`,
                    'versionCache',
                    JSON.stringify(content),
                );
                for (const version in content) {
                    this.dashboardVersions.push(content[version].name);
                }
                await this.adapter.stateSetCreate(`_ESPHomeDashboard.newestVersion`, 'newestVersion', content[0].name);
            } else {
                // Not possible to load latest versions, use fallback
                this.adapter.log.warn(
                    `Unable to retrieve current Dashboard release versions, using cached values. Check your internet connection`,
                );
                const cachedState = await this.adapter.getStateAsync(`_ESPHomeDashboard.versionCache`);
                if (cachedState && cachedState.val) {
                    const cachedVersions = JSON.parse(String(cachedState.val)) as Record<string, { name: string }>;
                    for (const version in cachedVersions) {
                        this.dashboardVersions.push(cachedVersions[version].name);
                    }
                }
            }

            // Use latest available version
            if (
                this.adapter.config.ESPHomeDashboardVersion &&
                this.adapter.config.ESPHomeDashboardVersion !== '' &&
                this.adapter.config.ESPHomeDashboardVersion !== 'Always last available'
            ) {
                useDashBoardVersion = this.adapter.config.ESPHomeDashboardVersion;
            } else if (this.adapter.config.ESPHomeDashboardVersion === 'Always last available') {
                if (content) {
                    useDashBoardVersion = content[0].name;
                } else if (this.dashboardVersions.length > 0) {
                    // Use first cached version if available
                    useDashBoardVersion = this.dashboardVersions[0];
                }
            }

            if (useDashBoardVersion !== '') {
                await this.adapter.stateSetCreate(
                    `_ESPHomeDashboard.selectedVersion`,
                    'selectedVersion',
                    useDashBoardVersion,
                );
            } else if (lastUsed != null) {
                useDashBoardVersion = lastUsed;
            }

            // Versions for the dropDowns of the adapter configuration
            this.pillowVersions.length = 0;
            this.pillowVersions.push(...(await this.fetchAndCachePillowVersions()));
            this.deviceBuilderVersions.length = 0;
            this.deviceBuilderVersions.push(...(await this.fetchAndCacheDeviceBuilderVersions()));

            // Start Dashboard Process
            if (this.adapter.config.ESPHomeDashboardEnabled) {
                this.adapter.log.info(`Native Integration of ESPHome Dashboard enabled, making environment ready`);

                this.warnUnpinnedVersions(useDashBoardVersion);

                const useDeviceBuilder = usesDeviceBuilder(useDashBoardVersion);

                try {
                    const { getVenv } = await import('autopy');
                    let python;
                    try {
                        if (!useDashBoardVersion) {
                            this.adapter.log.warn(
                                `Unable to determine a specific ESPHome dashboard version. Falling back to latest available version from PyPI`,
                            );
                        }
                        // Pillow comes with ESPHome, the matching Device Builder is chosen by pip, unless
                        // a version is selected in the advanced settings (#479)
                        const requirements = buildRequirements(
                            useDashBoardVersion,
                            this.adapter.config.PillowVersion,
                            this.adapter.config.DeviceBuilderVersion,
                        );
                        this.adapter.log.debug(`Python requirements: ${JSON.stringify(requirements)}`);
                        // Create a virtual environment with esphome installed. upgrade: as soon as something
                        // has to be installed (e.g. another ESPHome version), pip may also upgrade the
                        // installed packages, otherwise it keeps the Device Builder installed for the
                        // previous ESPHome version.
                        python = await getVenv({
                            name: 'esphome',
                            pythonVersion: '3.13.2', // Use any Python 3.13.x version.
                            requirements,
                            upgrade: true,
                        });
                    } catch (error) {
                        const stack = error instanceof Error ? error.stack : undefined;
                        this.adapter.log.error(`Fatal error starting ESPHomeDashboard | ${String(error)} | ${stack}`);
                        return;
                    }

                    // Define directory to store configuration files
                    const dataDir = utils.getAbsoluteDefaultDataDir();

                    try {
                        fs.mkdir(`${dataDir}esphome.${this.adapter.instance}`, err => {
                            if (err) {
                                return console.log(`ESPHome directory exists`);
                            }
                            console.log(`ESPHome directory created`);
                        });
                        // );
                    } catch (error) {
                        // Directory has issues reading/writing data, iob fix should be executed
                        this.adapter.log.warn(
                            `ESPHome DDashboard is unable to access directory to store YAML configuration data, please run ioBroker fix: ${String(error)}`,
                        );
                    }

                    const configDir = `${dataDir}esphome.${this.adapter.instance}`;
                    const port = String(this.adapter.config.ESPHomeDashboardPort);
                    // From ESPHome 2026.7.0 on `esphome dashboard` only exits with an error, ESPHome Device
                    // Builder takes the same port and configuration directory
                    const command = useDeviceBuilder ? 'esphome-device-builder' : 'esphome';
                    const args = useDeviceBuilder
                        ? ['--port', port, configDir]
                        : ['dashboard', '--port', port, configDir];

                    // The versions pip installed, Pillow and the Device Builder are not configured by default
                    const installed = await this.getInstalledVersions(python);
                    const deviceBuilderInfo = useDeviceBuilder
                        ? `, ESPHome Device Builder version: ${installed['esphome-device-builder'] || 'unknown'}`
                        : '';
                    this.adapter.log.info(
                        `Starting ESPHome Dashboard. ESPHome version: ${installed.esphome || useDashBoardVersion || 'latest'}, Pillow version: ${installed.pillow || 'unknown'}${deviceBuilderInfo}`,
                    );
                    // buffer: false, the output is only logged below and would otherwise be kept in memory
                    // for as long as the dashboard runs. NO_COLOR keeps color codes out of the log.
                    this.dashboardProcess = python(command, args, { buffer: false, env: { NO_COLOR: '1' } });

                    this.adapter.log.debug(`espHomeDashboard_Process ${JSON.stringify(this.dashboardProcess)}`);

                    this.dashboardProcess.stdout?.on('data', data => {
                        this.adapter.log.info(`[this.dashboardProcess - Data] ${data}`);
                    });

                    this.dashboardProcess.stderr?.on('data', data => {
                        if (data.includes('ERROR')) {
                            // e.g. the reason why the dashboard stops right after the start
                            this.adapter.log.error(`[ESPHome - Console] ${data}`);
                        } else if (data.includes('INFO')) {
                            if (data.includes('Starting') || data.includes('Device Builder ready')) {
                                this.adapter.log.info(`[ESPHome - Console] ${data}`);
                            } else {
                                this.adapter.log.debug(`[ESPHome - Console] ${data}`);
                            }
                        }
                    });

                    void this.dashboardProcess.on('exit', (code, signal) => {
                        this.adapter.log.warn(`ESPHome Dashboard stopped (exit code ${code}, signal ${signal})`);
                    });

                    // The process is also a promise, which rejects when it cannot be started, exits with an
                    // error or is stopped. Unhandled, that rejection terminates the whole adapter (#479).
                    this.dashboardProcess.catch((error: unknown) => {
                        const { code, exitCode, signal } = error as {
                            code?: string;
                            exitCode?: number;
                            signal?: string;
                        };
                        if (exitCode != null || signal != null) {
                            // Exited or stopped, already logged by the exit handler
                            return;
                        }
                        const reason = error instanceof Error && error.message ? error.message : String(error);
                        if (code === 'ENOENT') {
                            this.adapter.log.error(
                                `ESPHome Dashboard could not be started, "${command}" is missing in the Python environment. Clear the autopy cache in the adapter configuration and restart the adapter to install it again: ${reason}`,
                            );
                        } else {
                            this.adapter.log.error(`ESPHome Dashboard could not be started: ${reason}`);
                        }
                    });
                } catch (error) {
                    this.adapter.errorHandler(`[espHomeDashboard-Process]`, error);
                }
            } else {
                this.adapter.log.info(`Native Integration of ESPHome Dashboard disabled `);
            }
        } catch (error) {
            this.adapter.errorHandler(`[espHomeDashboard-Function]`, error);
        }
    }

    /**
     * Add a version to a dropDown when it is not part of it yet, so a configured version can never
     * silently disappear from the selection when the release list is unavailable or outdated
     *
     * @param dropDownEntry - dropDown entries to extend
     * @param version - version which must be selectable
     */
    ensureVersionInDropDown(dropDownEntry: (string | { label: string; value: string })[], version: string): void {
        const known = dropDownEntry.some(entry => (typeof entry === 'string' ? entry : entry.value) === version);
        if (!known) {
            dropDownEntry.push({ label: version, value: version });
        }
    }

    /**
     * Fetch Pillow versions from PyPI and cache them
     *
     * @returns Array of available Pillow versions
     */
    async fetchAndCachePillowVersions(): Promise<string[]> {
        const fallbackVersions = ['12.2.0', '12.1.1', '12.0.0', '11.3.0', '11.2.0', '11.1.0'];

        try {
            const response = await fetch('https://pypi.org/pypi/pillow/json');
            if (response.ok) {
                const data = (await response.json()) as { releases: Record<string, unknown> };
                const versions = Object.keys(data.releases)
                    .filter(v => !v.includes('a') && !v.includes('b') && !v.includes('rc')) // Filter out alpha/beta/rc versions
                    .sort((a, b) => compareVersions(b, a)) // Sort versions in descending order (newest first)
                    .slice(0, 20); // Limit to 20 most recent versions

                if (versions.length > 0) {
                    // Cache the versions
                    await this.adapter.stateSetCreate(
                        `_ESPHomeDashboard.pillowVersionCache`,
                        'pillowVersionCache',
                        JSON.stringify(versions),
                    );
                    await this.adapter.stateSetCreate(
                        `_ESPHomeDashboard.newestPillowVersion`,
                        'newestPillowVersion',
                        versions[0],
                    );
                    this.adapter.log.debug(
                        `Fetched ${versions.length} Pillow versions from PyPI, newest: ${versions[0]}`,
                    );
                    return versions;
                }
                this.adapter.log.warn('No stable Pillow versions found on PyPI, using cached or fallback versions');
            } else {
                this.adapter.log.warn(
                    `Unable to fetch Pillow versions from PyPI: ${response.status}, using cached values`,
                );
            }
        } catch (error) {
            const reason = error instanceof Error && error.message ? error.message : String(error);
            this.adapter.log.warn(
                `Error fetching Pillow versions from PyPI: ${reason}, using cached or fallback versions`,
            );
        }

        // Try to load from cache
        try {
            const cachedPillowVersions = await this.adapter.getStateAsync(`_ESPHomeDashboard.pillowVersionCache`);
            if (cachedPillowVersions && cachedPillowVersions.val) {
                const versions = JSON.parse(String(cachedPillowVersions.val));
                this.adapter.log.info(`Loaded ${versions.length} Pillow versions from cache`);
                return versions;
            }
        } catch {
            // Cache read failed, will use fallback
        }

        // Use fallback versions
        this.adapter.log.info(`Using ${fallbackVersions.length} fallback Pillow versions`);
        return fallbackVersions;
    }

    /**
     * Fetch the ESPHome Device Builder versions from PyPI for the version dropDown and cache them
     *
     * @returns the newest 20 releases, newest first, the cached ones when PyPI cannot be reached
     */
    async fetchAndCacheDeviceBuilderVersions(): Promise<string[]> {
        const cacheState = `_ESPHomeDashboard.deviceBuilderVersionCache`;
        try {
            const response = await fetch('https://pypi.org/pypi/esphome-device-builder/json');
            if (!response.ok) {
                throw new Error(`status ${response.status}`);
            }
            const data = (await response.json()) as { releases: Record<string, { yanked?: boolean }[]> };
            const versions = Object.entries(data.releases)
                // Without pre-releases and releases which were removed or yanked
                .filter(([version, files]) => /^\d+(\.\d+)*$/.test(version) && files.some(file => !file.yanked))
                .map(([version]) => version)
                .sort((a, b) => compareVersions(b, a))
                .slice(0, 20);
            await this.adapter.stateSetCreate(cacheState, 'deviceBuilderVersionCache', JSON.stringify(versions));
            return versions;
        } catch (error) {
            const reason = error instanceof Error && error.message ? error.message : String(error);
            this.adapter.log.debug(`Unable to fetch ESPHome Device Builder versions from PyPI: ${reason}`);
        }

        try {
            const cached = await this.adapter.getStateAsync(cacheState);
            if (cached && cached.val) {
                return JSON.parse(String(cached.val)) as string[];
            }
        } catch {
            // No usable cache, only "Auto Detect" can be selected
        }
        return [];
    }

    /**
     * Versions of ESPHome, Pillow and ESPHome Device Builder installed in the Python environment
     *
     * @param python - runs a command in the Python environment, returned by autopy's getVenv()
     * @returns installed versions by package name, empty when pip could not be asked
     */
    private async getInstalledVersions(
        python: Awaited<ReturnType<typeof getVenv>>,
    ): Promise<Record<string, string | undefined>> {
        try {
            const { stdout } = await python('python', ['-m', 'pip', 'list', '--format', 'json']);
            const packages = JSON.parse(String(stdout)) as { name: string; version: string }[];
            return Object.fromEntries(packages.map(({ name, version }) => [name.toLowerCase(), version]));
        } catch (error) {
            const reason = error instanceof Error && error.message ? error.message : String(error);
            this.adapter.log.debug(`Unable to list the installed Python packages: ${reason}`);
            return {};
        }
    }

    /**
     * Clear the autopy cache directory
     */
    // eslint-disable-next-line @typescript-eslint/require-await -- async kept: a throw stays a rejected promise as before
    async clearAutopyCache(): Promise<void> {
        try {
            const homeDir = os.homedir();
            const autopyCache = path.join(homeDir, '.cache', 'autopy');

            this.adapter.log.info(`Attempting to clear autopy cache at: ${autopyCache}`);

            // Check if directory exists
            if (fs.existsSync(autopyCache)) {
                // Use recursive removal
                fs.rmSync(autopyCache, { recursive: true, force: true });
                this.adapter.log.info('Autopy cache cleared successfully');
            } else {
                this.adapter.log.info('Autopy cache directory does not exist');
            }
        } catch (error) {
            const reason = error instanceof Error && error.message ? error.message : String(error);
            this.adapter.log.error(`Error clearing autopy cache: ${reason}`);
            throw error;
        }
    }
    /**
     * Stop the dashboard process, if running
     */
    stop(): void {
        try {
            if (this.dashboardProcess) {
                this.dashboardProcess.kill('SIGTERM', {
                    forceKillAfterTimeout: 2000,
                });
            }
        } catch (e) {
            this.adapter.log.error(`[onUnload - dashboardProcess] ${JSON.stringify(e)}`);
        }
    }

    /**
     * Entries of the ESPHome Dashboard version dropDown in the adapter configuration
     *
     * @returns dropDown entries, "Always last available" first
     */
    getDashboardVersionDropDown(): VersionDropDownEntry[] {
        const dropDownEntry: VersionDropDownEntry[] = [];
        dropDownEntry.push('Always last available');
        // eslint-disable-next-line @typescript-eslint/no-for-in-array -- for...in kept: it also tolerates a missing (undefined) value
        for (const versions in this.dashboardVersions) {
            dropDownEntry.push({
                label: this.dashboardVersions[versions],
                value: this.dashboardVersions[versions],
            });
        }
        // The version new installations default to must always be selectable, also
        // when the release list could not be retrieved from GitHub
        this.ensureVersionInDropDown(dropDownEntry, defaultDashboardVersion);
        return dropDownEntry;
    }

    /**
     * Entries of the Pillow version dropDown in the adapter configuration
     *
     * @returns dropDown entries, "Auto Detect" first
     */
    getPillowVersionDropDown(): VersionDropDownEntry[] {
        const dropDownEntry: VersionDropDownEntry[] = [];
        // "Always last available" is not offered: the newest Pillow conflicts with the version ESPHome pins
        dropDownEntry.push(autoDetect);

        // Use cached versions from memory
        if (this.pillowVersions.length > 0) {
            for (const version of this.pillowVersions) {
                dropDownEntry.push({
                    label: version,
                    value: version,
                });
            }
        } else {
            // Fallback versions if cache is empty
            this.adapter.log.info('No cached Pillow versions available, using fallback versions');
            const fallbackVersions = ['12.2.0', '12.1.1', '12.0.0', '11.3.0', '11.2.0', '11.1.0'];
            for (const version of fallbackVersions) {
                dropDownEntry.push({
                    label: version,
                    value: version,
                });
            }
        }
        return dropDownEntry;
    }

    /**
     * Entries of the ESPHome Device Builder version dropDown in the adapter configuration
     *
     * @returns dropDown entries, "Auto Detect" first
     */
    getDeviceBuilderVersionDropDown(): VersionDropDownEntry[] {
        const dropDownEntry: VersionDropDownEntry[] = [autoDetect];
        for (const version of this.deviceBuilderVersions) {
            dropDownEntry.push({ label: version, value: version });
        }
        // A selected version must stay selectable, also when the release list could not be retrieved
        const configured = this.adapter.config.DeviceBuilderVersion;
        if (configured && configured !== autoDetect) {
            this.ensureVersionInDropDown(dropDownEntry, configured);
        }
        return dropDownEntry;
    }
}

export default Dashboard;
