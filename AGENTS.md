# AGENTS.md – ioBroker.esphome

Guide for AI coding agents working in this repository.

## Architecture Overview

Single-file adapter (`main.js`, ~2500 lines) extending `@iobroker/adapter-core`'s `utils.Adapter`. Three supporting modules in `lib/`:

| File                     | Purpose                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `lib/helpers.js`         | `DeviceInfo` / `ClientDetails` classes – one instance per ESP device  |
| `lib/stateAttr.js`       | Human-readable metadata for ioBroker state objects (name, role, type) |
| `lib/yamlFileManager.js` | Upload/download/delete YAML config files for the ESPHome directory    |
| `lib/dashboardApi.js`    | Dashboard API helpers                                                 |

**Two optional subsystems run in-process alongside device connections:**

1. **MDNS auto-discovery** – `Discovery` from `@2colors/esphome-native-api`, started 5 s after `onReady`.
2. **ESPHome Dashboard** – spawned Python process via `autopy` (virtual-env wrapper); only active when `config.ESPHomeDashboardEnabled`.

## Key Data Structures

```js
// Keyed by IP address – source of truth for every connected device
clientDetails[ip]  // instanceof ClientDetails (lib/helpers.js)
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
// `name` is looked up in lib/stateAttr.js for role/type metadata
// `writable=true` auto-subscribes the state
```

When adding a new ESP entity type, add a matching entry to `lib/stateAttr.js`.

## Adding a New ESP Entity Type

1. Handle the `entity.on('state', ...)` case in the large `switch(entity.type)` block (~line 700 in `main.js`).
2. Handle the write command in `onStateChange()` (the second large switch/else-if chain, ~line 2100).
3. For entities with no state events (e.g., Button), override `createNonStateDevices()`.
4. Add attribute entries to `lib/stateAttr.js`.

## Developer Workflow

```bash
npm ci                                        # install deps (use ci, not install)
./node_modules/.bin/eslint --max-warnings 0 . # must pass clean before any commit
npm run check                                 # TS type check – errors are non-blocking
npm test                                      # test:js + test:package + test:integration
```

> `npm run lint` locally does NOT enforce `--max-warnings 0` but CI does — always run the eslint command above directly.

`npm test` does **not** include `test:unit` (deprecated). The integration test suite lives in `test/integrationTests/` (index, dashboard_tests, version_fetch_tests) and is imported by `test/integration.js`.

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

Config schema: `admin/jsonConfig.json5` (JSON5, supports comments). Translations: `admin/i18n/{locale}/translations.json`. Run `npm run translate` after any translation key changes. Labels must reference translation keys (`"i18n": true` is set globally).

## GITHUB_TOKEN Usage

The adapter itself calls `https://api.github.com/repos/esphome/esphome/releases` at startup when the Dashboard is enabled. Set `GITHUB_TOKEN` in the environment (or CI `env:`) to avoid 60 req/h rate limits — both in CI jobs and locally when running integration tests.

## ESPHome Dashboard Specifics

- Managed via `autopy` (Python venv); cache at `~/.cache/autopy`.
- `autopy` is intentionally pinned to a commit of `github:SimonFischer04/autopy` — the fork is not published
  to npm, and the commit pin is deliberate. The repo checker flags this as S0047; it is a known won't-fix.
- Pillow versions fetched from PyPI; cached in state `_ESPHomeDashboard.pillowVersionCache`.
- "Clear Autopy Cache" button triggers `clearAutopyCache()` → `fs.rmSync(~/.cache/autopy, recursive)`.
- Config migration: `migrateConfig()` converts legacy `ESPHomeDashboardIP` + port → `ESPHomeDashboardUrl`.

## CI/CD Notes

- Workflow: `.github/workflows/test-and-release.yml` using `ioBroker/testing-action-*` official actions.
- **Always include `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`** in the `adapter-tests` job.
- The dashboard integration suites build a real Python venv and are therefore **skipped by default**.
  They run in `.github/workflows/dashboard-integration.yml` (manual/weekly) or locally with
  `ESPHOME_RUN_DASHBOARD_TESTS=true npm run test:integration`.
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
  dist-tag - it overrides the *version to publish*, and the action only appends `--tag next` when
  that version contains a `-`. Setting `tag: next` therefore breaks pre-release publishing with
  `npm error You must specify a tag using --tag`.
- **Pre-releases automatically go to the `next` dist-tag**, `latest` is only moved by a stable
  release. No configuration needed.
- **A failed `deploy` cannot be fixed by re-running the job.** A tag-triggered run always loads the
  workflow from the tagged commit, so a re-run executes the same broken file. Fix `main`, then move
  the tag onto the fixed commit (`git tag -f -a vX.Y.Z <commit>` + `git push --force origin
  refs/tags/vX.Y.Z`), which re-triggers the build. Only safe while nothing was published under that
  version - check `npm view iobroker.esphome@X.Y.Z` and the GitHub releases first.
- `deploy` needs the full six-way `adapter-tests` matrix to pass, so a flaky leg leaves a pushed tag
  with nothing published. That is the normal recovery case for the point above.
- The ioBroker translator service behind the `iobroker` plugin regularly answers 501/503 and then
  **rolls the whole release back**. Prepare the news entry as a `NEXT` key in `io-package.json` with
  all languages already filled in (`npx translate-adapter translate`); the plugin then just renames
  `NEXT` to the new version and never calls the translator.
- `release-script` needs an interactive TTY for its prompts, and its `cleanup` stage deletes the
  tracked `.commitmessage` file - restore it with `git checkout -- .commitmessage` afterwards.
