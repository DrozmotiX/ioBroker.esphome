# ioBroker.esphome Adapter
ioBroker.esphome is a Node.js adapter for ioBroker that integrates ESP8266/ESP32 devices managed by ESPHome. The adapter communicates with devices via ESPHome's native API and optionally provides an integrated ESPHome Dashboard using Python.

Always reference these instructions first and fallback to search or bash commands only when you encounter unexpected information that does not match the info here.

## Working Effectively
- Bootstrap, build, and test the repository:
  - `npm ci` -- installs dependencies. Takes 40 seconds. NEVER CANCEL. Set timeout to 90+ seconds.
  - `npm run lint` -- ESLint check. Takes <5 seconds.
  - `npm run check` -- TypeScript check. Takes <5 seconds. May show type errors that are non-blocking.
  - `npm test` -- runs all tests. Takes 30 seconds. NEVER CANCEL. Set timeout to 60+ minutes.
- Development server for local testing:
  - `npm run dev-server setup` -- one-time setup. Takes 90 seconds. NEVER CANCEL. Set timeout to 180+ seconds.
  - `npm run dev-server run default` -- starts full ioBroker instance with admin UI on http://127.0.0.1:8081/
  - `npm run startDev` -- alternative development mode (requires setup first)
- Translation management:
  - `npm run translate` -- updates translations using Gulp. Takes <1 second.

## Validation
- Always run the full test suite after making changes: `npm test`
- ALWAYS run `npm run lint` before you are done or the CI (.github/workflows/test-and-release.yml) will fail.
- The TypeScript check (`npm run check`) may show errors but they are non-blocking and do not prevent the adapter from functioning.
- Always test actual ESPHome device integration scenarios when making changes to device communication or API handling.
- Test the admin UI configuration when making changes to adapter settings or device management.
- For functional testing, use `npm run dev-server run default` to start a full ioBroker instance with admin UI at http://127.0.0.1:8081/
- When testing device integration, ensure ESPHome API is enabled in device YAML with either encryption key or password authentication.
- Test translation changes with `npm run translate` to ensure all language files are properly updated.

## Common Tasks
The following are outputs from frequently run commands. Reference them instead of viewing, searching, or running bash commands to save time.

### Node.js and npm versions
node --version: v20.19.5
npm --version: 10.8.2

### Key dependencies
- @2colors/esphome-native-api: ESPHome device communication
- @iobroker/adapter-core: ioBroker adapter framework
- autopy: Python virtual environment for ESPHome Dashboard
- node-fetch: HTTP requests for API communication

### Repository structure
```
ls -la [repo-root]:
.eslintrc.json          -- ESLint configuration
.github/                -- GitHub workflows and templates
.gitignore
admin/                  -- Admin UI files (HTML, CSS, translations)
gulpfile.js            -- Gulp build tasks (translation management)
io-package.json        -- ioBroker adapter configuration
lib/                   -- Helper modules
  helpers.js           -- Device client management (113 lines)
  stateAttr.js         -- State attribute definitions (47 lines) 
  tools.js             -- Utility functions and translation (99 lines)
main.js                -- Main adapter code (1737 lines)
package.json           -- Node.js project configuration
test/                  -- Test files
  integration.js       -- Adapter startup tests
  package.js           -- Package validation tests
  unit.js              -- Unit tests (minimal)
tsconfig.json          -- TypeScript configuration
```

### Test structure
- **test:package** -- validates package.json and io-package.json structure (~instant)
- **test:unit** -- minimal unit tests (deprecated, ~instant)
- **test:integration** -- starts adapter in test environment (~28 seconds)
- **test:js** -- runs basic JavaScript tests (~instant)

### Key scripts (package.json)
- `npm run lint` -- ESLint code quality check
- `npm run check` -- TypeScript type checking  
- `npm test` -- run full test suite (package + unit + integration + js)
- `npm run startDev` -- development server (requires setup)
- `npm run dev-server setup` -- one-time development environment setup
- `npm run translate` -- update translations via Gulp

### Development workflow
1. Make code changes to main.js or lib/ files
2. `npm run lint` -- verify code style (<5 seconds)
3. `npm run check` -- TypeScript check (<5 seconds, may show non-blocking errors)
4. `npm test` -- run full test suite (30 seconds)
5. For local testing: `npm run dev-server run default` (after initial setup) - opens admin UI on http://127.0.0.1:8081/
6. For translation updates: `npm run translate` (<1 second)
7. Always lint before committing or CI will fail

### Manual Testing Scenarios
- **Admin UI Testing**: Use `npm run dev-server run default` and navigate to http://127.0.0.1:8081/ to test configuration interface
- **Device Management**: Test adding/removing ESPHome devices through admin interface
- **API Integration**: Verify communication with actual ESP devices when available
- **Dashboard Integration**: Test optional ESPHome Dashboard functionality if enabled

### ESPHome integration details
- Communicates with ESP devices via native API (not HTTP polling)
- Supports both encryption key and password authentication
- Can run integrated ESPHome Dashboard using Python virtual environment
- Devices must have ESPHome API enabled in their YAML configuration
- Adapter automatically manages device states and attributes

### Python Dependencies (for ESPHome Dashboard)
- Python 3.13.x managed via autopy virtual environment
- ESPHome package installed automatically when Dashboard is enabled
- Pillow 10.4.0 for image processing
- Dashboard runs on configurable port (default 6052)

### Known Issues
- TypeScript check shows type errors but they are non-blocking
- Some npm audit warnings for deprecated packages (non-critical)
- ESPHome Dashboard requires internet connection for initial setup
- Integration tests may show Sentry errors which are expected during testing

### Admin Interface
- Located in `admin/` directory
- Uses JSON5 configuration (`jsonConfig.json5`)
- Multilingual support (translations in `admin/i18n/`)
- Device management interface for adding/removing ESP devices
- Optional ESPHome Dashboard integration via iframe

### CI/CD Pipeline (.github/workflows/test-and-release.yml)
- Runs on Node.js 18.x, 20.x, 22.x, 24.x
- Tests on Ubuntu, Windows, macOS
- Requires passing lint, package tests, and integration tests
- Automated release to npm on version tags