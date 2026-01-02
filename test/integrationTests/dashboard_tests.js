/**
 * Dashboard Integration Test
 *
 * Tests the ESPHome Dashboard integration within the ioBroker adapter.
 * This verifies that the adapter can properly:
 * 1. Process dashboard configuration
 * 2. Initialize the dashboard via autopy
 * 3. Make the dashboard accessible on the configured port
 *
 */

const http = require('http');
const { expect } = require('chai');

// Test configuration constants
const DASHBOARD_PORT = 6052;
const DASHBOARD_VERSION = 'Always last available';
const DASHBOARD_INITIALIZATION_DELAY_MS = 30000; // 30 seconds for dashboard to initialize
const REACHABILITY_CHECK_DELAY_MS = 3000; // 3 seconds between reachability checks
const MAX_REACHABILITY_ATTEMPTS = 25; // Maximum attempts to check if dashboard is reachable
const TEST_TIMEOUT_MS = 300000; // 5 minutes total test timeout

/**
 * Checks if the dashboard is reachable via HTTP
 * @param {number} port - Port number to check
 * @param {number} maxAttempts - Maximum number of attempts
 * @param {number} delayMs - Delay between attempts in milliseconds
 * @returns {Promise<boolean>} - True if dashboard is reachable
 */
async function isDashboardReachable(port, maxAttempts, delayMs) {
	console.log(`Checking if dashboard is reachable on port ${port}...`);

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const accessible = await new Promise((resolve) => {
				const req = http.get(`http://localhost:${port}/`, (res) => {
					console.log(`Dashboard check attempt ${attempt}: HTTP ${res.statusCode}`);
					// Dashboard is reachable if we get a successful response (2xx) or redirect (3xx)
					// This indicates the dashboard server is running and responding properly
					resolve(res.statusCode >= 200 && res.statusCode < 400);
				});

				req.on('error', (err) => {
					console.log(`Dashboard check attempt ${attempt}: ${err.code || err.message}`);
					resolve(false);
				});

				req.setTimeout(5000, () => {
					req.destroy();
					resolve(false);
				});
			});

			if (accessible) {
				console.log(`✓ Dashboard is reachable on port ${port}`);
				return true;
			}
		} catch (err) {
			console.log(`Dashboard check attempt ${attempt} error: ${err.message}`);
		}

		if (attempt < maxAttempts) {
			await new Promise(resolve => setTimeout(resolve, delayMs));
		}
	}

	return false;
}

exports.runTests = function (suite) {
	suite('ESPHome Dashboard Integration', (getHarness) => {

		it('should enable dashboard in adapter settings and verify it becomes reachable', async function() {
			// Extended timeout for dashboard initialization
			this.timeout(TEST_TIMEOUT_MS);

			const harness = getHarness();

			try {
				// Stop the adapter if it's already running
				if (harness.isAdapterRunning()) {
					console.log('Stopping running adapter...');
					await harness.stopAdapter();
				}

				console.log('Configuring adapter to enable dashboard...');
				// Enable the dashboard in adapter configuration
				await harness.changeAdapterConfig('esphome', {
					native: {
						ESPHomeDashboardEnabled: true,
						ESPHomeDashboardPort: DASHBOARD_PORT,
						ESPHomeDashboardVersion: DASHBOARD_VERSION
					}
				});

				console.log('Starting adapter with dashboard enabled...');
				await harness.startAdapterAndWait(false);

				// Wait for dashboard to initialize after adapter starts
				console.log(`Waiting ${DASHBOARD_INITIALIZATION_DELAY_MS / 1000}s for dashboard initialization...`);
				await new Promise(resolve => setTimeout(resolve, DASHBOARD_INITIALIZATION_DELAY_MS));

				// Check if dashboard is reachable
				console.log('Checking dashboard accessibility...');
				const isReachable = await isDashboardReachable(
					DASHBOARD_PORT,
					MAX_REACHABILITY_ATTEMPTS,
					REACHABILITY_CHECK_DELAY_MS
				);

				if (!isReachable) {
					const errorMessage = 'Dashboard is not reachable.\nPossible causes:\n- Fatal error in dashboard startup code\n- Python environment setup failure\nCheck the adapter logs above for more details';
					console.error(errorMessage);
					throw new Error(errorMessage);
				}

				// If we reach here, dashboard is reachable
				console.log('✓ Dashboard is successfully reachable!');
				console.log('✓ Dashboard integration test passed completely');
				expect(isReachable).to.be.true;
			} catch (error) {
				console.error(`Dashboard integration test failed: ${error.message}`);
				throw error;
			}
		});
	});
};
