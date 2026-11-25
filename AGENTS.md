# AGENTS.md – ioBroker.esphome

Guide for AI coding agents working in this repository.

## Architecture Overview

Single-file adapter (`src/main.ts`, ~2700 lines) extending `@iobroker/adapter-core`'s `utils.Adapter`, compiled to `build/` by `npm run build`. Supporting modules in `src/lib/`:

> All sources are TypeScript and fully type checked; there is no `// @ts-nocheck` and no per-file lint exception. Keep it that way: type new code properly instead of adding `any`, `@ts-nocheck` or broad eslint overrides. The types of `@2colors/esphome-native-api` are completed in `src/lib/esphome-native-api.d.ts`.

| File                               | Purpose                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `src/lib/helpers.ts`               | `DeviceInfo` / `ClientDetails` classes – one instance per ESP device               |
| `src/lib/stateAttr.ts`             | Human-readable metadata for ioBroker state objects (name, role, type)              |
| `src/lib/yamlFileManager.ts`       | Upload/download/delete YAML config files for the ESPHome directory                 |
| `src/lib/dashboardApi.ts`          | Dashboard API helpers                                                              |
| `src/lib/dashboard.ts`             | ESPHome Dashboard: versions, config migration, process start / stop                |
| `src/lib/dashboardRequirements.ts` | Python requirements of the dashboard (ESPHome, Pillow, ESPHome Device Builder)     |
| `src/lib/deviceManagement.ts`      | ioBroker device manager (`@iobroker/dm-utils`): list / add / edit / delete devices |
| `src/lib/discoveryOptions.ts`      | Options of the MDNS discovery for the listening address (IPv4 or IPv6 interface)   |
| `src/lib/bleForwarder.ts`          | Forwards the BLE advertisements of Bluetooth proxies to ioBroker.ble               |
| `src/lib/bleGattBridge.ts`         | Connections to BLE devices through Bluetooth proxies for ioBroker.ble (`gatt:*`)   |

**Two optional subsystems run in-process alongside device connections:**

1. **MDNS auto-discovery** – `Discovery` from `@2colors/esphome-native-api`, started 5 s after `onReady`. The listening
   address may be IPv6: `discoveryOptions()` then joins the IPv6 mDNS group on the interface of that address.
2. **ESPHome Dashboard** – spawned Python process via `autopy` (virtual-env wrapper); only active when `config.ESPHomeDashboardEnabled`. All of it lives in `src/lib/dashboard.ts`.

## Key Data Structures

```js
// Keyed by IP address – source of truth for every connected device
clientDetails[ip]  // instanceof ClientDetails (src/lib/helpers.ts)
  .client          // @2colors/esphome-native-api Client instance
  .connected / .connecting / .connectionError
  .deviceName      // MAC without colons, e.g. "004B1296140C"
  .deviceFriendlyName
  .encryptionKeyUsed / .encryptionKey / .apiPassword

// Keyed by deviceName – reverse-lookup from state ID back to IP
this.deviceStateRelation[deviceName].ip

// In-memory cache of every ioBroker object created this session
this.createdStatesDetails[objName]  // avoids redundant extendObjectAsync calls

// Global timer map – always clear before re-setting.
// Use the adapter-managed timers (never the global ones) so js-controller
// cleans them up on unload – plain setTimeout() is flagged by the repo checker.
resetTimers[key] = this.clearTimeout(resetTimers[key]);
resetTimers[key] = this.setTimeout(fn, ms);
```

## State ID Scheme

```
{deviceName}.{entityType}.{entityKey}.{stateName}
// e.g.  004B1296140C.Switch.123456789.state
```

`deviceName` = MAC address with colons stripped. `entityType` comes directly from the ESPHome API (Switch, Sensor, Fan, Light, Cover, Climate, Number, Text, Select, Lock, Button…).

## Central State-Creation Function

**Always use `stateSetCreate()` to create/update states**, never call `setObjectAsync` + `setStateAsync` directly:

```js
await this.stateSetCreate(objName, name, value, unit, writable, initialStateCommon);
// `name` is looked up in src/lib/stateAttr.ts for role/type metadata
// `writable=true` auto-subscribes the state
```

When adding a new ESP entity type, add a matching entry to `src/lib/stateAttr.ts`.

## Adding a New ESP Entity Type

1. Handle the `entity.on('state', ...)` case in the large `switch(entity.type)` block (~line 700 in `src/main.ts`).
2. Handle the write command in `onStateChange()` (the second large switch/else-if chain, ~line 2100).
3. For entities with no state events (e.g., Button), override `createNonStateDevices()`.
4. Add attribute entries to `src/lib/stateAttr.ts`.

## Developer Workflow

```bash
npm ci                                        # install deps (use ci, not install)
./node_modules/.bin/eslint --max-warnings 0 . # must pass clean before any commit
npm run check                                 # TS type check – currently 0 errors, keep it that way
npm run build                                 # compile src/ to build/ (the integration test starts build/main.js)
npm test                                      # test:unit + test:package
npm run test:integration                      # starts the adapter in a test ioBroker installation
```

> `npm run lint` locally does NOT enforce `--max-warnings 0` but CI does — always run the eslint command above directly.

Unit tests live next to the code they test as `src/**/*.test.ts` (e.g. `src/lib/dashboardApi.test.ts`) and run via `npm run test:unit`. The integration test suite lives in `test/integrationTests/` (index, dashboard_tests, docker_dashboard_tests, version_fetch_tests, version_migration_tests, e2e_device_tests, known_device_tests, settings_cleanup_tests, ble_forwarding_tests, ble_gatt_tests) and is imported by `test/integration.js`.

### End-to-end test with a real ESPHome device

`test/e2e/esphome-device.yaml` is compiled with the ESPHome **host** platform into a native executable (real firmware, real encrypted native API on `127.0.0.1:6053`, no hardware). `test/integrationTests/e2e_device_tests.js` starts it, adds it with the "Add device" dialog of the device manager (`dm:` messages) and checks every entity type in both directions plus reconnect. A second suite starts from a device object as version 1.0.0 wrote it (encrypted key) and checks the upgrade. A harness cannot start the adapter again after `stopAdapter()` (`startAdapterAndWait` then hangs), so a scenario that needs a restart gets its own `suite`. It is skipped unless `ESPHOME_E2E_DEVICE_BINARY` is set:

```bash
pip install -r test/e2e/requirements.txt          # pinned ESPHome version
esphome compile test/e2e/esphome-device.yaml
npm run build
ESPHOME_E2E_DEVICE_BINARY=test/e2e/.esphome/build/iobroker-e2e/.pioenvs/iobroker-e2e/program \
    npm run test:integration -- --grep "E2E"
```

When adding a new entity type, add a template entity of that type to the YAML and a test that writes and reads it back.

## Integration Test Pattern

Tests use `@iobroker/testing` harness. All integration test suites must export `runTests(suite)` and be registered in `test/integrationTests/index.js`.

```js
exports.runTests = function (suite) {
    suite('My Feature', getHarness => {
        it('should ...', async function () {
            this.timeout(60000);
            const harness = getHarness();
            if (harness.isAdapterRunning()) await harness.stopAdapter();
            await harness.changeAdapterConfig('esphome', { native: { ... } });
            await harness.startAdapterAndWait();
            // verify states via harness.states.getStateAsync(...)
            await harness.stopAdapter();
        });
    });
};
```

Always call `harness.stopAdapter()` in a `finally` block to avoid test leaks.

## Admin UI

Config schema: `admin/jsonConfig.json5` (JSON5, supports comments). Translations: `admin/i18n/{locale}.json` (short format, migrated from the old `{locale}/translations.json` layout). Run `npm run translate` after any translation key changes. Labels must reference translation keys (`"i18n": true` is set globally).

The first tab ("Main settings") ends with the sections "Discovery" (auto discovery, mDNS listening address,
ignore list) and "Connection behavior for known devices" (config states, reconnect / ping settings). The second tab ("Devices") embeds the device manager (`"type": "deviceManager"`), the same view admin shows in its
"Devices" tab. Devices are only added / edited / deleted there, see `src/lib/deviceManagement.ts`
(`@iobroker/dm-utils`, needs admin >= 7.8.20 for its v3 API). Texts of the device manager live in
`src/i18n/{locale}.json` (English text as key, all 11 languages, same layout as ioBroker.shelly), are loaded with
adapter-core's `I18n` and copied to `build/i18n` by `scripts/postbuild.js` after `npm run build`. Add every new text to all 11 files,
the unit test checks they have the same keys. `npm run translate` only covers `admin/i18n`.
Use `I18n.getTranslatedObject('English text')` directly (like ioBroker.miner / ioBroker.shelly), and
`translateWithArgs()` for texts with `%s`: adapter-core fills only the first `%s` and returns `{}` for a `%s` text
without arguments. Results and errors `main.ts` passes to the device manager (`DeviceActionResult`) are English
texts of `src/i18n` with their `%s` values in `args`; a unit test checks every such text has a translation.

## Bluetooth proxies (BLE forwarding)

`BleForwarder` (`src/lib/bleForwarder.ts`) delivers the advertisements devices with `bluetooth_proxy` receive to
ioBroker.ble over its gateway interface "ble-gateway/1" (types in `src/lib/gateway-protocol.ts` of ioBroker.ble):
`sendTo('ble.0', 'gateway:advertisements', { gatewayId, items: [{ address, addressType, rssi, data }] })`, no callback.
Enabled by the setting `bleForwardInstance` (`"ble.0"`, empty = off, `bleTargetInstance()`).

- The dependency points one way: this adapter knows ioBroker.ble, not the other way round. It passes the raw payload
  (`data`, base64) on without parsing it; decoding, deduplication across proxies and "which devices are recorded" are
  ioBroker.ble's business. Do not add Bluetooth knowledge here.
- `attach()` after `new Client()`, `initialized()` in the `initialized` event (subscribes with
  `connection.subscribeBluetoothAdvertisementService()`, every time: the subscription ends with the connection),
  `disconnected()` / `detach()` / `stop()` on disconnect, device removal and unload.
- Only devices with the raw advertisement bit (`1 << 5`) in `deviceInfo.bluetoothProxyFeatureFlags` are subscribed
  (ESPHome >= 2023.6.0). The client option `initializeSubscribeBLEAdvertisements` is not used, it would subscribe at
  every device.
- The raw payload is read from `client.connection.frameHelper.on('message')`: the mapped events of the library
  (`ble`, `message.BluetoothLERawAdvertisementsResponse`) have the payload parsed and removed.
- Advertisements are collected for 250 ms per proxy, the same payload of the same BLE device is sent once per batch, at
  most 500 per message. The gateway ID is the ESPHome name (`gatewayId()`). An empty batch announces a proxy and is
  repeated every 30 s while it receives nothing: ioBroker.ble takes a gateway offline after 60 s of silence.
- Tests: `src/lib/bleForwarder.test.ts` builds the messages with the protobuf classes of the library.
  `test/integrationTests/ble_forwarding_tests.js` runs the adapter against `fakeBluetoothProxy.js` (plaintext native
  API on `127.0.0.1:6053`, the host platform of the E2E device has no Bluetooth) and reads the messages sent to `ble.0`.

### GATT connections (`BleGattBridge`, stage 2 of the gateway interface)

`BleGattBridge` (`src/lib/bleGattBridge.ts`) lets ioBroker.ble connect to BLE devices through proxies whose feature
flags have bit 1 (active connections). The binding specification is `docs/spec-phase-2-gatt.md` in the ioBroker.ble
repository (`SimonFischer04/ioBroker.ble`), part C is this adapter.

- It uses the proxies `BleForwarder` subscribed (`listGateways()`, `findGateway()`), same target instance. It
  announces them with `gateway:announce` (with callback, payload `{ protocol, gateways }`, each gateway with
  `gatewayId`, `connect`, `freeSlots`, `slotLimit`) every 30 s and whenever the free slots change
  (`SubscribeBluetoothConnectionsFreeRequest`).
  The answer carries the `epoch` (start time) of ioBroker.ble: a new epoch, `gatt:connect` with a new epoch or
  `system.adapter.<target>.alive` = false close all connections ioBroker.ble opened.
- It answers `gatt:connect|disconnect|getServices|read|write|subscribe` (only from the target instance, else
  `INVALID_PAYLOAD`) with `{ error: null, result }` or `{ error: { code, message } }`, and sends
  `gateway:connectionState` (connection ended without being asked) and `gateway:notification` without callback.
- **The GATT methods of the client library must not be used**: they match answers by message type only, not by
  address and handle, so two BLE devices at one proxy would get each other's answers. The bridge sends with
  `client.connection.sendMessage(new pb.…)` (classes from `@2colors/esphome-native-api/lib/utils/messages`, typed in
  `src/lib/esphome-native-api-messages.d.ts`) and matches `message.<Type>` events by address (and handle).
- Answers after the mapping of the library: `uuid` is a UUID with dashes **or an empty string** when the device set
  `shortUuid` instead (canonical UUID = `shortUuid` as 8 hex digits + `-0000-1000-8000-00805f9b34fb`), `data` is
  base64, `address` a number (`macFromAddress()` for the MAC).
- `gatt:writeSequence` (phase 4, `docs/spec-phase-4-pvvx-ota.md` in ioBroker.ble): up to
  `MAX_WRITE_SEQUENCE_LENGTH` (64) writes to one handle in order, then optionally one read. Announced as
  `features: ['writeSequence']` for proxies that can connect. Writes with response wait for each confirmation, writes
  without response go out directly; `WRITE_SEQUENCE_GAP_MS` (0) adds a pause between them if real hardware needs it.
  The first failed write ends the sequence, the message says after how many writes.
- **Not verified on hardware**: with V3 connections the client writes the CCCD (`00002902-…`) itself after
  `BluetoothGATTNotifyRequest` (`[1, 0]` for notify, `[2, 0]` for indicate), as `bleak-esphome` does. Check with a
  real ESP32 before relying on it.
- Tests: `src/lib/bleGattBridge.test.ts` (fake connection, answers built with the `pb` classes).
  `test/integrationTests/ble_gatt_tests.js` plays ble.0 against `fakeBluetoothProxy.js`, which answers the GATT
  requests (one pvvx-like service 0x1f10 / characteristic 0x1f1f, 3 slots). Its services response is encoded by hand:
  google-protobuf 4 cannot read the packed UUID list `setUuidList()` would write.

## GITHUB_TOKEN Usage

The adapter itself calls `https://api.github.com/repos/esphome/esphome/releases` at startup when the Dashboard is enabled. Set `GITHUB_TOKEN` in the environment (or CI `env:`) to avoid 60 req/h rate limits — both in CI jobs and locally when running integration tests.

## ESPHome Dashboard Specifics

- Managed via `autopy` (Python venv); cache at `~/.cache/autopy`.
- `autopy` is the fork `@simonfischer04/autopy` from npm, installed under the alias `autopy`
  (`npm:@simonfischer04/autopy@^1.3.1`, source: github.com/SimonFischer04/autopy). 1.3.0 added the `upgrade`
  option of `getVenv()` and checks the extras of installed requirements.
- From ESPHome 2026.7.0 on the dashboard is ESPHome Device Builder (`esphome dashboard` only exits with an error).
  `buildRequirements()` (`src/lib/dashboardRequirements.ts`) installs it as `esphome-device-builder[esphome]`: its
  `esphome` extra holds the minimum ESPHome version, so pip picks the matching release. `getVenv()` runs with
  `upgrade: true`, otherwise pip keeps the Device Builder of a previously selected ESPHome version.
- Python version: advanced setting `PythonVersion` (semver version or range, default `3.13.2` =
  `DEFAULT_PYTHON_VERSION`), validated by `pythonVersion()` in `src/lib/dashboard.ts` and passed to `getVenv()`; autopy
  recreates an environment with a non-matching Python. autopy 1.3.1 reads the `SHA256SUMS` file newer
  python-build-standalone releases ship instead of one `.sha256` per asset (needed for newer Python versions).
- Pillow is not installed separately by default ("Auto Detect"): ESPHome pins the version it needs since 2024.12,
  any other version makes pip fail. Pillow / Device Builder versions for the dropDowns are fetched from PyPI and
  cached in `_ESPHomeDashboard.pillowVersionCache` / `deviceBuilderVersionCache`.
- `info.connection` is a boolean (`indicator.connected`, as up to 1.0.1): `true` while the adapter runs, `false`
  on unload (`initConnectionStates()` / `onUnload()` in `src/main.ts`). Programs reading it as the online state of
  the adapter only accept `true`, never put a device list there. Whether a device is connected is
  `<device>.info._online`.
- `info.connectedDevices` lists the connected devices (`updateConnectionState()` in `src/main.ts`). With the
  dashboard enabled it stays empty until `Dashboard.scheduleReadyCheck()` gets an HTTP 2xx/3xx from
  `http://localhost:<port>/` (`Dashboard.isReady()`), and again when the dashboard process exits or cannot be started.
- With `config.ESPHomeDashboardDocker` ("Use Docker Integration", beta: `expertMode: true` in `jsonConfig.json5`) it runs as the official `ghcr.io/esphome/esphome` container
  instead: `docker-compose.yaml` (shipped in `files` of package.json) is managed by `@iobroker/plugin-docker`
  (`common.plugins.docker` in `io-package.json`). The service has `iobWaitForReady`, so the plugin starts nothing by itself;
  `startDockerContainer()` in `src/lib/dashboard.ts` sets the image tag and the `/config` bind mount on `plugin.configurations`
  and calls `instanceIsReady()`, only when the dashboard is enabled. That also resolves when the pull or start failed (the plugin
  only warns), so the container state is checked with `containerList()` afterwards; the ready check keeps polling the container.
  The image entrypoint runs ESPHome Device Builder for `dashboard` since 2026.6.0. Toolchains go to the named volume `/cache`.
  `containerHostEnvironment()` adds `IOBROKER_UID` / `IOBROKER_GID` (user of the instance) and `TZ` (ESPHome compiles the time zone
  of its system into devices; mounting `/etc/localtime` does not work, tzlocal reads `TZ`) to the environment. The script in
  `command` of `docker-compose.yaml` starts as root, chowns the new `/cache` volume and leftover root files in `/config` to that
  user and runs `/entrypoint.sh` with `setpriv` as that user: `/config` is shared with the dashboard process and the YAML file
  management (plain `user:` leaves the volume unwritable). It stays root without `IOBROKER_UID` (Windows, ioBroker as root) and in a
  user namespace (rootless Docker). Keep `entrypoint` at one element and no `${` in the script (CLI driver / templates of the plugin).
  Every field has to survive the comparison of the plugin with `docker inspect`, otherwise the container is created again on each start.
  The container name (`ownContainerName()`, the name the plugin gives it) is kept in `_ESPHomeDashboard.dockerContainer` before
  `instanceIsReady()`; a start without Docker mode removes that container
  (`removeLeftoverContainer()`, own `DockerManager`, as the plugin manages nothing then). `stop()` waits up to 4 s for a pending
  container start during unload (adapter timers do not work while unloading). Unit tests: `src/lib/dashboard.test.ts`.
- The dashboard port is registered with js-controller >= 8 (`registerDashboardPort()`, `common.declareUsedResources: true`),
  duck-typed like ioBroker.influxdb, as the adapter types of js-controller 7 do not have `registerUsedResource()`.
- The admin tab of the instance (`adminTab.link` / `adminUI.tab: "json"` in `io-package.json`) is `admin/jsonTab.json5`, not
  a plain link to the dashboard: users took the empty page of a dashboard still installing for a broken one. Its items
  watch `_ESPHomeDashboard.status` (`DashboardStatus`: disabled / starting / running / failed / stopped, `setStatus()`) with
  `dependsOnStates` and show a hint plus `_ESPHomeDashboard.startLog` (last 60 lines, `appendStartLog()`, not written while
  running) until the dashboard answers, then only the `iframe` with the URL from the `getDashboardTab` command (`getTabData()`).
  The ready check polls every 5 s until the dashboard answers, then every 60 s. `_states` needs admin >= 8.0.12, so every
  `hidden` checks `typeof _states` and older admins get the iframe with a hint. Texts: `tab*` keys in `admin/i18n`.
  Inside `Dashboard`, log with `this.log` / `this.errorHandler()`, not `this.adapter.log` / `this.adapter.errorHandler()`:
  info, warn and error then also land in the start log (debug only in the instance log). Only the raw output of the
  dashboard process calls `appendStartLog()` directly.
- Optional login (advanced settings `ESPHomeDashboardUsername` / `ESPHomeDashboardPassword`, password in
  `encryptedNative`): `dashboardCredentials()` in `src/lib/dashboard.ts` passes it as environment variables to the process
  and the container, `ESPHOME_USERNAME` / `ESPHOME_PASSWORD` for Device Builder, `USERNAME` / `PASSWORD` for older ESPHome.
  Only applied with both set, the dashboard is unprotected by default.
- "Clear Autopy Cache" button triggers `clearAutopyCache()` → `fs.rmSync(~/.cache/autopy, recursive)`.
- Config migration: `migrateConfig()` converts legacy `ESPHomeDashboardIP` + port → `ESPHomeDashboardUrl`.

## Removed settings

`removeObsoleteSettings()` (first thing in `onReady`) deletes settings nothing reads any more from the instance
configuration once (`OBSOLETE_SETTINGS` in `src/main.ts`), the adapter restarts after that. When removing a
setting from `io-package.json` / `jsonConfig.json5`, add its key there and to `test/integrationTests/settings_cleanup_tests.js`.
The integration tests reuse the test installation in `/tmp/test-iobroker.esphome` between runs, and its instance
object keeps the `native` defaults of the `io-package.json` it was created from. After changing those defaults,
delete that directory, otherwise the cleanup restarts the adapter in every suite and they fail (CI always starts fresh).

## CI/CD Notes

- Workflow: `.github/workflows/test-and-release.yml` using `ioBroker/testing-action-*` official actions.
- **Always include `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`** in the `adapter-tests` job.
- The dashboard integration suites build a real Python venv and are therefore **skipped by default**.
  They run in `.github/workflows/dashboard-integration.yml` (every PR, pushes to main/v2 and manual;
  not part of the release pipeline) or locally with
  `ESPHOME_RUN_DASHBOARD_TESTS=true npm run test:integration`.
- The same workflow has a second job (matrix `mode: [native, docker]`) for the dashboard in Docker:
  `test/integrationTests/docker_dashboard_tests.js` runs the real container through the docker plugin against the Docker
  daemon of the runner (image pulled, dashboard reachable on the host port, stopped with the instance, leftover container
  removed). Skipped by default, locally: `ESPHOME_RUN_DOCKER_TESTS=true npm run test:integration -- --grep "Docker"`.
- `.github/workflows/e2e.yml` runs the end-to-end device test for PRs and pushes to main/v2 with the pinned ESPHome
  version (`test/e2e/requirements.txt`). Dependabot bumps that version, so new ESPHome releases are tested in its PRs.
- Releases via `@alcalzone/release-script`; changelog placeholder: `## **WORK IN PROGRESS**`.

## Releasing

**`release-script` does not publish to npm.** It has five stages - `check`, `edit`, `commit`, `push`,
`cleanup` - and no publish step. It bumps `package.json` / `package-lock.json` / `io-package.json`,
turns the changelog into an `io-package.json` news entry, commits, creates the annotated tag and
pushes. Pushing the tag is what triggers the `deploy` job, and **that** runs `npm publish` plus the
GitHub release. A green `release-script` run therefore does not mean anything was published.

- **Do not hand-edit the `deploy` job.** `ioBroker/testing-action-deploy` already handles the npm
  dist-tag, trusted publishing (OIDC provenance) and the GitHub release. Only `node-version` and
  `build*` are meant to be set here. The one exception is the Sentry release: `sentry` stays `false`
  in the action, and the job's own "Create Sentry release" step runs it with 3 tries per call and
  `continue-on-error`. sentry.iobroker.net refuses connections at times, and inside the action that
  turned every release red after npm and GitHub had already gone through (2.0.0-beta.1, beta.2).
  In particular the action's `tag` input is **not** the npm
  dist-tag - it overrides the _version to publish_, and the action only appends `--tag next` when
  that version contains a `-`. Setting `tag: next` therefore breaks pre-release publishing with
  `npm error You must specify a tag using --tag`.
- **Pre-releases automatically go to the `next` dist-tag**, `latest` is only moved by a stable
  release. No configuration needed.
- **A failed `deploy` cannot be fixed by re-running the job.** A tag-triggered run always loads the
  workflow from the tagged commit, so a re-run executes the same broken file. Fix `main`, then move
  the tag onto the fixed commit (`git tag -f -a vX.Y.Z <commit>` + `git push --force origin
refs/tags/vX.Y.Z`), which re-triggers the build. Only safe while nothing was published under that
  version - check `npm view iobroker.esphome@X.Y.Z` and the GitHub releases first.
- `deploy` needs the full `adapter-tests` matrix (3 Node versions × Ubuntu and macOS) to pass, so a flaky leg leaves a pushed tag
  with nothing published. That is the normal recovery case for the point above.
- The ioBroker translator service behind the `iobroker` plugin regularly answers 501/503 and then
  **rolls the whole release back**. Prepare the news entry in `io-package.json` under the **exact
  version you are about to release** (e.g. `"1.0.0"`) with all languages already filled in
  (`npx translate-adapter translate`); the plugin keeps an entry that already exists for the new
  version and never calls the translator. Do not use a `NEXT` key: since `@iobroker/testing` 6 the
  package tests validate `io-package.json` against the schema, which rejects `NEXT`, so CI fails.
- `release-script` needs an interactive TTY for its prompts, and its `cleanup` stage deletes the
  tracked `.commitmessage` file - restore it with `git checkout -- .commitmessage` afterwards.
