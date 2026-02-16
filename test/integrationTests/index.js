const dashboard_tests = require("./dashboard_tests");
const version_fetch_tests = require("./version_fetch_tests");

exports.runTests = function (suite) {
  dashboard_tests.runTests(suite);
  version_fetch_tests.runTests(suite);
};
