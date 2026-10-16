const path = require('path');
const { tests } = require('@iobroker/testing');
const integrationTests = require('./integrationTests');

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    // Define your own tests inside defineAdditionalTests
    defineAdditionalTests({ suite }) {
        integrationTests.runTests(suite);
    },
});
