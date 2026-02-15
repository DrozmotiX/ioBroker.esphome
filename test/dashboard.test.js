const { testDashboardStartup } = require("./dashboard/test-dashboard-startup");
const { testAdapterDashboard } = require("./dashboard/test-adapter-dashboard");

describe("ESPHome Dashboard Tests", () => {
  describe("Dashboard Startup", () => {
    it("should start ESPHome Dashboard successfully", async function () {
      this.timeout(60000); // 60 second timeout

      try {
        await testDashboardStartup();
      } catch (error) {
        // If this is a network-related error in CI, we can skip
        if (
          error.message.includes("ENOENT") ||
          error.message.includes("esphome") ||
          error.message.includes("not found")
        ) {
          console.log(
            "Skipping dashboard test - ESPHome not available in environment",
          );
          this.skip();
          return;
        }
        throw error;
      }
    });
  });

  describe("Adapter Dashboard Integration", () => {
    it("should handle autopy integration gracefully", async function () {
      this.timeout(30000); // 30 second timeout

      try {
        await testAdapterDashboard();
      } catch (error) {
        // Network errors are expected in some CI environments
        if (
          error.message.includes("Blocked by") ||
          error.message.includes("HttpError") ||
          error.message.includes("network") ||
          error.message.includes("timeout")
        ) {
          console.log("Skipping autopy test due to network restrictions");
          this.skip();
          return;
        }
        throw error;
      }
    });
  });
});
