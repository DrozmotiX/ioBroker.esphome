const path = require('path');
const { tests } = require('@iobroker/testing');
const integrationTests = require('./integrationTests');

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    // Pinned: from alpha.23 on, adapters ignore the sigKill the harness sends as "system.host.testing"
    // (js-controller #3568), so stopAdapter() hangs. Back to the default (dev) once @iobroker/testing is fixed.
    controllerVersion: '8.0.0-alpha.22-20261120-86a16c878',
    // Define your own tests inside defineAdditionalTests
    defineAdditionalTests({ suite }) {
        integrationTests.runTests(suite);
    },
});
