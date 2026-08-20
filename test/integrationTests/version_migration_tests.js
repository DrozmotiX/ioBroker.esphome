/**
 * Pinned Version Migration Integration Test
 *
 * Covers the one-time migration in main.js migratePinnedVersions(): installations still set to
 * "Always last available" are rewritten once to the versions known to work (#463), while a
 * deliberate switch back afterwards is never overridden again.
 *
 * The dashboard integration stays disabled, so no Python environment is built and these suites are
 * cheap enough for the regular CI matrix.
 *
 * Each scenario is its own suite on purpose: the harness resets the database and creates a fresh
 * adapter process per suite, and it refuses a second start once the process has exited - which is
 * exactly what the migration causes when it writes the configuration.
 */

const { expect } = require('chai');

// Keep in sync with defaultDashboardVersion / defaultPillowVersion in main.js
const PINNED_DASHBOARD_VERSION = '2026.6.5';
const PINNED_PILLOW_VERSION = '12.2.0';
const UNPINNED = 'Always last available';

const MIGRATION_STATE = 'esphome.0._ESPHomeDashboard.versionPinMigrationDone';
const INSTANCE_OBJECT = 'system.adapter.esphome.0';

/**
 * Waits until the adapter has written the migration marker
 *
 * @param {object} harness - Integration test harness
 * @param {number} timeoutMs - How long to wait before giving up
 * @returns {Promise<ioBroker.State>} The marker state once it is true
 * @throws {Error} When the marker was not written within the timeout
 */
async function waitForMigrationMarker(harness, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    do {
        const marker = await harness.states.getStateAsync(MIGRATION_STATE);
        if (marker && marker.val === true) {
            return marker;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    throw new Error(`Migration marker ${MIGRATION_STATE} was not set within ${timeoutMs}ms`);
}

/**
 * Reads the current native configuration of the adapter instance
 *
 * @param {object} harness - Integration test harness
 * @returns {Promise<Record<string, unknown>>} The instance "native" configuration
 */
async function readNativeConfig(harness) {
    const instance = await harness.objects.getObjectAsync(INSTANCE_OBJECT);
    if (!instance || !instance.native) {
        throw new Error(`Could not read ${INSTANCE_OBJECT}`);
    }
    return instance.native;
}

/**
 * Stops the adapter without letting a teardown error mask the actual test result
 *
 * @param {object} harness - Integration test harness
 * @returns {Promise<void>}
 */
async function stopAdapterQuietly(harness) {
    try {
        if (harness && harness.isAdapterRunning()) {
            await harness.stopAdapter();
        }
    } catch (cleanupError) {
        const reason =
            cleanupError instanceof Error && cleanupError.message ? cleanupError.message : String(cleanupError);
        console.error(`Failed to stop adapter during migration test cleanup: ${reason}`);
    }
}

exports.runTests = function (suite) {
    suite('Pinned Version Migration - unpinned installation', getHarness => {
        it('rewrites "Always last available" to the versions known to work', async function () {
            this.timeout(120000);

            const harness = getHarness();

            try {
                // An installation as it looked before the pinned defaults were introduced
                await harness.changeAdapterConfig('esphome', {
                    native: {
                        ESPHomeDashboardEnabled: false,
                        ESPHomeDashboardVersion: UNPINNED,
                        PillowVersion: UNPINNED,
                    },
                });

                await harness.startAdapterAndWait();

                const marker = await waitForMigrationMarker(harness, 60000);
                expect(marker.val).to.equal(true);

                const native = await readNativeConfig(harness);
                expect(native.ESPHomeDashboardVersion).to.equal(PINNED_DASHBOARD_VERSION);
                expect(native.PillowVersion).to.equal(PINNED_PILLOW_VERSION);
                console.log(
                    `✓ migrated to dashboard ${native.ESPHomeDashboardVersion} / pillow ${native.PillowVersion}`,
                );
            } finally {
                await stopAdapterQuietly(harness);
            }
        });
    });

    suite('Pinned Version Migration - already pinned installation', getHarness => {
        it('keeps hand picked versions and only records the marker', async function () {
            this.timeout(120000);

            const harness = getHarness();

            try {
                // A user who already selected fixed versions themselves
                await harness.changeAdapterConfig('esphome', {
                    native: {
                        ESPHomeDashboardEnabled: false,
                        ESPHomeDashboardVersion: '2026.6.4',
                        PillowVersion: '12.1.1',
                    },
                });

                await harness.startAdapterAndWait();

                const marker = await waitForMigrationMarker(harness, 60000);
                expect(marker.val).to.equal(true);

                const native = await readNativeConfig(harness);
                expect(native.ESPHomeDashboardVersion).to.equal('2026.6.4');
                expect(native.PillowVersion).to.equal('12.1.1');
                console.log('✓ hand picked versions were not changed');
            } finally {
                await stopAdapterQuietly(harness);
            }
        });
    });

    suite('Pinned Version Migration - deliberate opt in', getHarness => {
        it('never overrides "Always last available" once the migration has run', async function () {
            this.timeout(120000);

            const harness = getHarness();

            try {
                // Simulate the state after the migration: the marker is set and the user has
                // deliberately selected "Always last available" again
                await harness.objects.setObjectAsync(MIGRATION_STATE, {
                    type: 'state',
                    common: {
                        name: 'Migration to pinned dashboard versions applied',
                        type: 'boolean',
                        role: 'indicator',
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                await harness.states.setStateAsync(MIGRATION_STATE, { val: true, ack: true });

                await harness.changeAdapterConfig('esphome', {
                    native: {
                        ESPHomeDashboardEnabled: false,
                        ESPHomeDashboardVersion: UNPINNED,
                        PillowVersion: UNPINNED,
                    },
                });

                await harness.startAdapterAndWait();

                // Give the adapter more than enough time to write the configuration, it would do so
                // in onReady before anything else
                await new Promise(resolve => setTimeout(resolve, 10000));

                const native = await readNativeConfig(harness);
                expect(
                    native.ESPHomeDashboardVersion,
                    'a deliberate "Always last available" was migrated a second time',
                ).to.equal(UNPINNED);
                expect(native.PillowVersion).to.equal(UNPINNED);
                console.log('✓ deliberate "Always last available" survives once the marker is set');
            } finally {
                await stopAdapterQuietly(harness);
            }
        });
    });
};
