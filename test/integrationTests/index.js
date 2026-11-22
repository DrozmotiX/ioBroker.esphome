const dashboard_tests = require('./dashboard_tests');
const docker_dashboard_tests = require('./docker_dashboard_tests');
const e2e_device_tests = require('./e2e_device_tests');
const known_device_tests = require('./known_device_tests');
const settings_cleanup_tests = require('./settings_cleanup_tests');
const version_fetch_tests = require('./version_fetch_tests');
const version_migration_tests = require('./version_migration_tests');
const yaml_file_tests = require('./yaml_file_tests');

// The dashboard suites enable the ESPHome dashboard, which makes the adapter build a real Python 3.13
// virtual environment via autopy and pip-install esphome + pillow from PyPI. That is far too slow
// and too network dependent for the regular CI matrix (it wedges shared GitHub runners and is
// subject to GitHub API rate limiting). They are executed by the dedicated
// "Dashboard Integration" workflow (every pull request, outside the release pipeline), or locally via:
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

    // The dashboard in Docker ("Use Docker Integration", beta) needs a Docker daemon and pulls the ESPHome
    // image (about 1 GB). Executed by the "Dashboard Integration" workflow as its own job, or locally via:
    //   ESPHOME_RUN_DOCKER_TESTS=true npm run test:integration -- --grep "Docker"
    const runDockerTests = process.env.ESPHOME_RUN_DOCKER_TESTS === 'true';
    if (!runDockerTests) {
        console.log('Skipping ESPHome dashboard Docker suites, set ESPHOME_RUN_DOCKER_TESTS=true to run them');
    }
    docker_dashboard_tests.runTests(runDockerTests ? suite : suite.skip);

    // The end-to-end suite needs a compiled ESPHome host-platform device (Python, ESPHome and a C++
    // toolchain), see test/integrationTests/e2e_device_tests.js. Executed by the "E2E" workflow.
    const runE2eTests = !!process.env.ESPHOME_E2E_DEVICE_BINARY;
    if (!runE2eTests) {
        console.log('Skipping ESPHome end-to-end device suite, set ESPHOME_E2E_DEVICE_BINARY to run it');
    }
    e2e_device_tests.runTests(runE2eTests ? suite : suite.skip);

    // Runs always: the migration keeps the dashboard integration disabled, so it needs no Python
    version_migration_tests.runTests(suite);

    // Runs always: the known device is never reachable, so it needs neither Python nor a device
    known_device_tests.runTests(suite);

    // Runs always: the dashboard integration stays disabled and no device is involved
    settings_cleanup_tests.runTests(suite);

    // Runs always: YAML files are written to the instance data directory, no Python
    yaml_file_tests.runTests(suite);
};
