const dashboard_tests = require('./dashboard_tests');
const version_fetch_tests = require('./version_fetch_tests');
const version_migration_tests = require('./version_migration_tests');

// The two dashboard suites enable the ESPHome dashboard, which makes the adapter build a real Python 3.13
// virtual environment via autopy and pip-install esphome + pillow from PyPI. That is far too slow
// and too network dependent for the regular CI matrix (it wedges shared GitHub runners and is
// subject to GitHub API rate limiting). They are executed by the dedicated
// "Dashboard Integration" workflow, or locally via:
//   ESPHOME_RUN_DASHBOARD_TESTS=true npm run test:integration
const runDashboardTests = process.env.ESPHOME_RUN_DASHBOARD_TESTS === 'true';

exports.runTests = function (suite) {
    // suite.skip registers the suite as pending, so neither the tests nor the harness
    // before/after hooks run - see @iobroker/testing build/tests/integration/index.js
    const dashboardSuite = runDashboardTests ? suite : suite.skip;

    if (!runDashboardTests) {
        console.log('Skipping ESPHome dashboard integration suites, set ESPHOME_RUN_DASHBOARD_TESTS=true to run them');
    }

    dashboard_tests.runTests(dashboardSuite);
    version_fetch_tests.runTests(dashboardSuite);

    // Runs always: the migration keeps the dashboard integration disabled, so it needs no Python
    version_migration_tests.runTests(suite);
};
