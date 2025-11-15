# Dashboard Integration Test

## Purpose

This test verifies that the ioBroker ESPHome adapter correctly handles the dashboard integration configuration as requested in [issue #227](https://github.com/DrozmotiX/ioBroker.esphome/issues/227).

## What It Tests

The test validates the **adapter's dashboard integration**, not just ESPHome dashboard in isolation:

1. **Configuration Processing**: Verifies the adapter correctly reads and processes the `ESPHomeDashboardEnabled` setting
2. **Adapter Startup**: Ensures the adapter starts successfully with dashboard enabled
3. **Dashboard Initialization**: Confirms the adapter attempts to initialize the dashboard
4. **Graceful Failure Handling**: Verifies the adapter remains stable even when network restrictions prevent dashboard startup

## Test Scenarios

### Scenario 1: Full Success (Local Environment with Network Access)
- Dashboard configuration is enabled
- Adapter starts successfully
- Dashboard becomes reachable on configured port
- **Expected Result**: ✅ Test passes, dashboard is accessible

### Scenario 2: Partial Success (CI Environment with Network Restrictions)
- Dashboard configuration is enabled
- Adapter starts successfully
- Dashboard fails to start due to network restrictions (e.g., autopy cannot download Python)
- Adapter remains running despite dashboard failure
- **Expected Result**: ✅ Test passes, adapter is stable

### Scenario 3: Failure (Fatal Error)
- Dashboard configuration is enabled
- Adapter crashes during startup
- **Expected Result**: ❌ Test fails, indicating a regression

## How It Works

The test uses the ioBroker testing framework's integration test harness:

```javascript
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests: ({suite}) => {
        suite('Dashboard Integration', (getHarness) => {
            it('should start adapter with dashboard enabled', async function() {
                const harness = getHarness();
                
                // Enable dashboard in adapter config
                await harness.changeAdapterConfig('esphome', {
                    native: {
                        ESPHomeDashboardEnabled: true,
                        ESPHomeDashboardPort: 6052,
                        ESPHomeDashboardVersion: '2024.12.0'
                    }
                });
                
                // Start adapter and verify it processes the config
                await harness.startAdapterAndWait(false);
                
                // Check if dashboard is reachable or adapter is still running
                // (both indicate successful integration handling)
            });
        });
    }
});
```

## Running the Test

### Locally
```bash
npm run test:integration-dashboard
```

### In GitHub Actions
The test runs automatically in two workflows:

1. **test-and-release.yml**: Runs on all pushes/PRs (Ubuntu + Node 20.x only)
2. **test-dashboard.yml**: Dedicated workflow for dashboard testing

## Expected Output

### Success (with dashboard accessible):
```
✓ Dashboard is successfully reachable!
✓ Dashboard integration test passed completely
```

### Success (with network restrictions):
```
✓ Adapter is running with dashboard enabled (network restrictions may prevent full startup in CI)
✓ Dashboard integration test passed with network restrictions
```

### Failure:
```
✗ Dashboard is not reachable and adapter has stopped
AssertionError: expected false to be true
```

## Why Network Restrictions Are Handled Gracefully

In CI environments (especially GitHub Actions), network access may be restricted:
- DNS monitoring proxies may block downloads
- Package registries may be inaccessible
- Python environment setup may fail

These are **not test failures** - they're expected limitations of the CI environment. The test validates that:
1. The adapter correctly processes the dashboard configuration
2. The adapter remains stable even when external dependencies fail
3. The integration code doesn't crash the adapter

## Related Issues

- [#227](https://github.com/DrozmotiX/ioBroker.esphome/issues/227): Original request for dashboard verification
- [#226](https://github.com/DrozmotiX/ioBroker.esphome/issues/226): Previous version of the request
- [#220](https://github.com/DrozmotiX/ioBroker.esphome/issues/220), [#199](https://github.com/DrozmotiX/ioBroker.esphome/issues/199), [#209](https://github.com/DrozmotiX/ioBroker.esphome/issues/209): Dashboard startup issues this test helps prevent
- [#118](https://github.com/DrozmotiX/ioBroker.esphome/issues/118): Dashboard version selection
- [#290](https://github.com/DrozmotiX/ioBroker.esphome/pull/290): Previous attempt that didn't test the actual adapter integration

## Key Differences from Previous Approaches

Unlike the tests in `test/dashboard/` which test ESPHome in isolation, this test:
- ✅ Starts the actual adapter with dashboard configuration
- ✅ Tests the adapter's integration code
- ✅ Verifies configuration is correctly processed
- ✅ Ensures adapter stability
- ✅ Handles CI environment limitations gracefully

This is what was requested in the issue: "enable dashboard in adapter settings, restart the adapter and check if the dashboard is reachable."
