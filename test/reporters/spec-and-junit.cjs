/**
 * Mocha reporter used in CI: prints the usual `spec` output to the console and writes a JUnit-style XML
 * report to `test-results.xml` (picked up by the Codecov test results upload).
 *
 * Mocha 12 only honors a single `--reporter` flag, and `mocha-junit-reporter` is not compatible with
 * Mocha 12 (its reporter class calls the ES-class `Base` reporter as a function), hence this small combo.
 */
const { reporters } = require('mocha');

class SpecAndJUnit extends reporters.Base {
  constructor(runner, options = {}) {
    super(runner, options);
    this.spec = new reporters.Spec(runner, options);
    this.xunit = new reporters.XUnit(runner, { ...options, reporterOptions: { output: 'test-results.xml' } });
  }

  // Mocha waits for `done` before exiting; XUnit uses it to flush and close the output file
  done(failures, fn) {
    this.xunit.done(failures, fn);
  }
}

module.exports = SpecAndJUnit;
