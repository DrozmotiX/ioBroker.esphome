# ESPHome Dashboard Testing

This directory contains automated tests for ESPHome Dashboard functionality to prevent recurring dashboard startup issues.

## Test Files

### `test-dashboard-startup.js`
Tests direct ESPHome dashboard startup using the same command-line approach as the adapter:
- Creates temporary ESPHome configuration directory
- Starts dashboard process on port 6052
- Verifies HTTP accessibility
- Includes proper cleanup and timeout handling

### `test-adapter-dashboard.js`
Tests the adapter's autopy virtual environment approach:
- Creates Python virtual environment via autopy
- Installs ESPHome dependencies
- Verifies integration works correctly
- Handles network restrictions gracefully

### `../dashboard.test.js`
Mocha test wrapper that:
- Runs both dashboard tests with appropriate timeouts
- Gracefully skips tests when dependencies are unavailable
- Provides clear logging for debugging issues

## GitHub Actions Integration

### Dedicated Dashboard Workflow (`.github/workflows/test-dashboard.yml`)
- Runs on all pushes and pull requests
- Ubuntu environment with Python 3.13 and Node.js 20.x
- Installs ESPHome and dependencies
- Executes dashboard tests with timeouts

### Main CI Integration
- Enhanced existing workflow to include Python/ESPHome setup on Ubuntu
- Dashboard tests run as part of standard test suite
- No impact on Windows/macOS testing

## Environment Handling

The tests are designed to work in various environments:

**Full Environment (with ESPHome installed):**
- Tests run completely and verify dashboard functionality
- HTTP accessibility is confirmed

**Restricted Environment (CI/network limitations):**
- Tests detect missing dependencies and skip gracefully
- Network errors are handled without failing the build
- Clear logging explains why tests were skipped

**Development Environment:**
- Tests can be run locally for debugging
- Temporary files are properly cleaned up
- Error messages provide actionable feedback

## Running Tests Locally

```bash
# Run all dashboard tests
npx mocha test/dashboard.test.js --timeout 15000

# Run specific test file
node test/dashboard/test-dashboard-startup.js

# Run as part of full test suite
npm test
```

## Issues This Addresses

This testing framework addresses the recurring dashboard startup issues:
- #220: Dashboard fails to start
- #199: ESPHome Dashboard integration problems  
- #209: Dashboard startup errors
- #118: Version selection and management

By automatically testing dashboard functionality in CI, these issues can be caught before release.