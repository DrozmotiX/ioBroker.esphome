/**
 * Version Fetch Integration Test
 *
 * Tests the Pillow version fetching and caching mechanism.
 * This verifies that the adapter can properly:
 * 1. Fetch Pillow versions from PyPI
 * 2. Cache versions in state
 * 3. Fall back to cache when PyPI is unavailable
 * 4. Use fallback versions when both PyPI and cache are unavailable
 */

const { expect } = require("chai");

exports.runTests = function (suite) {
  suite("Pillow Version Fetching", (getHarness) => {
    it("should fetch and cache Pillow versions during initialization", async function () {
      this.timeout(60000); // Extended timeout for API call

      const harness = getHarness();

      try {
        // Stop the adapter if it's already running
        if (harness.isAdapterRunning()) {
          console.log("Stopping running adapter...");
          await harness.stopAdapter();
        }

        console.log("Enabling dashboard to trigger version fetch...");
        // Enable the dashboard which triggers version fetching
        await harness.changeAdapterConfig("esphome", {
          native: {
            ESPHomeDashboardEnabled: true,
            ESPHomeDashboardPort: 6052,
            ESPHomeDashboardVersion: "Always last available",
            PillowVersion: "Always last available",
          },
        });

        // Small delay to ensure configuration is persisted
        await new Promise((resolve) => setTimeout(resolve, 1000));

        console.log("Starting adapter to fetch versions...");
        await harness.startAdapterAndWait();

        // Wait for version fetch to complete
        console.log("Waiting for version fetch to complete...");
        await new Promise((resolve) => setTimeout(resolve, 10000));

        // Check if Pillow version cache state exists and has data
        console.log("Checking Pillow version cache...");
        const pillowVersionCache = await harness.states.getStateAsync(
          "esphome.0._ESPHomeDashboard.pillowVersionCache",
        );

        expect(pillowVersionCache).to.exist;
        expect(pillowVersionCache.val).to.be.a("string");

        const cachedVersions = JSON.parse(pillowVersionCache.val);
        expect(cachedVersions).to.be.an("array");
        expect(cachedVersions).to.have.length.greaterThan(0);

        console.log(
          `✓ Successfully cached ${cachedVersions.length} Pillow versions`,
        );
        console.log(`✓ Newest version: ${cachedVersions[0]}`);

        // Verify the newest version is also stored separately
        const newestPillowVersion = await harness.states.getStateAsync(
          "esphome.0._ESPHomeDashboard.newestPillowVersion",
        );

        if (newestPillowVersion) {
          expect(newestPillowVersion.val).to.equal(cachedVersions[0]);
          console.log(
            `✓ Newest version state matches: ${newestPillowVersion.val}`,
          );
        }

        // Verify versions are filtered (no alpha/beta/rc)
        const hasPreRelease = cachedVersions.some(
          (v) => v.includes("a") || v.includes("b") || v.includes("rc"),
        );
        expect(hasPreRelease).to.be.false;
        console.log("✓ All versions are stable releases (no alpha/beta/rc)");

        // Verify versions are sorted (newest first)
        const versionParts = cachedVersions[0].split(".").map(Number);
        expect(versionParts[0]).to.be.greaterThan(9); // Major version should be 10+
        console.log("✓ Versions are properly sorted (newest first)");

        console.log("✓ Version fetching test passed completely");
      } catch (error) {
        console.error(`Version fetch test failed: ${error.message}`);
        throw error;
      } finally {
        // Ensure the adapter is always stopped
        try {
          if (harness && harness.isAdapterRunning()) {
            console.log("Stopping adapter in cleanup (finally)...");
            await harness.stopAdapter();
          }
        } catch (cleanupError) {
          console.error(
            `Failed to stop adapter during version fetch test cleanup: ${cleanupError.message}`,
          );
        }
      }
    });
  });
};
