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
| `src/lib/dashboardRequirements.ts` | Pillow / ESPHome Device Builder versions installed next to ESPHome (PyPI)          |
| `src/lib/deviceManagement.ts`      | ioBroker device manager (`@iobroker/dm-utils`): list / add / edit / delete devices |

**Two optional subsystems run in-process alongside device connections:**

1. **MDNS auto-discovery** – `Discovery` from `@2colors/esphome-native-api`, started 5 s after `onReady`.
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

Unit tests live next to the code they test as `src/**/*.test.ts` (e.g. `src/lib/dashboardApi.test.ts`) and run via `npm run test:unit`. The integration test suite lives in `test/integrationTests/` (index, dashboard_tests, version_fetch_tests, version_migration_tests, e2e_device_tests, known_device_tests, settings_cleanup_tests) and is imported by `test/integration.js`.

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

The first tab ("Main settings") ends with the panel "Discovery & connection" (auto discovery, config states,
listening address, reconnect / ping settings). The second tab ("Devices") embeds the device manager (`"type": "deviceManager"`), the same view admin shows in its
"Devices" tab. Devices are only added / edited / deleted there, see `src/lib/deviceManagement.ts`
(`@iobroker/dm-utils`, needs admin >= 7.8.20 for its v3 API). Texts of the device manager live in
`src/i18n/{locale}.json` (English text as key, all 11 languages, same layout as ioBroker.shelly), are loaded with
adapter-core's `I18n` and copied to `build/i18n` by `scripts/postbuild.js` after `npm run build`. Add every new text to all 11 files,
the unit test checks they have the same keys. `npm run translate` only covers `admin/i18n`.
Use `I18n.getTranslatedObject('English text')` directly (like ioBroker.miner / ioBroker.shelly), and
`translateWithArgs()` for texts with `%s`: adapter-core fills only the first `%s` and returns `{}` for a `%s` text
without arguments. Results and errors `main.ts` passes to the device manager (`DeviceActionResult`) are English
texts of `src/i18n` with their `%s` values in `args`; a unit test checks every such text has a translation.

## GITHUB_TOKEN Usage

The adapter itself calls `https://api.github.com/repos/esphome/esphome/releases` at startup when the Dashboard is enabled. Set `GITHUB_TOKEN` in the environment (or CI `env:`) to avoid 60 req/h rate limits — both in CI jobs and locally when running integration tests.

## ESPHome Dashboard Specifics

- Managed via `autopy` (Python venv); cache at `~/.cache/autopy`.
- `autopy` is intentionally pinned to a commit of `github:SimonFischer04/autopy` — the fork is not published
  to npm, and the commit pin is deliberate. The repo checker flags this as S0047; it is a known won't-fix.
- Pillow versions fetched from PyPI; cached in state `_ESPHomeDashboard.pillowVersionCache`.
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
  dist-tag, trusted publishing (OIDC provenance) and the GitHub release. Only `node-version`,
  `build*` and `sentry*` are meant to be set here. In particular its `tag` input is **not** the npm
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
