# ESPHome Dashboard Testing

⚠️ **Note**: These tests verify ESPHome dashboard functionality in **isolation**, not the adapter integration.  
For testing the **adapter's dashboard integration** (as requested in [#227](https://github.com/DrozmotiX/ioBroker.esphome/issues/227)), see `test/integration-dashboard.js` and `test/DASHBOARD_INTEGRATION_TEST.md`.

This directory contains automated tests for ESPHome Dashboard functionality that can be useful for debugging dashboard-specific issues.

## Test Files

### `test-dashboard-startup.js`
Tests direct ESPHome dashboard startup using command-line invocation:
- Creates temporary ESPHome configuration directory
- Starts dashboard process on port 6052 directly (not through adapter)
- Verifies HTTP accessibility
- Includes proper cleanup and timeout handling
- **Use case**: Debugging ESPHome dashboard issues independently of the adapter

### `test-adapter-dashboard.js`
Tests autopy virtual environment functionality:
- Creates Python virtual environment via autopy
- Installs ESPHome dependencies
- Verifies autopy integration works correctly
- Handles network restrictions gracefully
- **Use case**: Debugging Python environment and autopy-specific issues

### `../dashboard.test.js`
Mocha test wrapper that:
- Runs both dashboard tests with appropriate timeouts
- Gracefully skips tests when dependencies are unavailable
- Provides clear logging for debugging issues
- **Note**: These tests are NOT run in the main CI workflow

## Adapter Integration Test (Recommended)

For testing the **actual adapter dashboard integration** (enabling dashboard in adapter settings and verifying it works), use:

**File**: `../integration-dashboard.js`  
**Script**: `npm run test:integration-dashboard`  
**Documentation**: `../DASHBOARD_INTEGRATION_TEST.md`

This is what was requested in [issue #227](https://github.com/DrozmotiX/ioBroker.esphome/issues/227):
> "Test should: enable dashboard in adapter settings, restart the adapter and check if the dashboard is reachable."

## Running Tests Locally

### Isolation Tests (this directory)
```bash
# Run dashboard isolation tests
npx mocha test/dashboard.test.js --timeout 15000

# Run specific test file directly
node test/dashboard/test-dashboard-startup.js
```

### Adapter Integration Test (recommended)
```bash
# Test actual adapter dashboard integration
npm run test:integration-dashboard
```

## Issues These Address

These isolation tests can help debug:
- #220: Dashboard fails to start
- #199: ESPHome Dashboard integration problems  
- #209: Dashboard startup errors
- #118: Version selection and management

However, for verifying the adapter correctly integrates the dashboard (the main issue), use the **adapter integration test**.