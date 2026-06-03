/**
 * tests/run-tests.js
 * ══════════════════
 * Unified test runner for all Decruft test suites.
 *
 * Usage:
 *   node tests/run-tests.js
 *
 * Exit codes:
 *   0 — all tests passed
 *   1 — one or more tests failed
 */

import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── ANSI colour helpers ───────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
};

function green(s)  { return `${C.green}${s}${C.reset}`; }
function red(s)    { return `${C.red}${s}${C.reset}`; }
function bold(s)   { return `${C.bold}${s}${C.reset}`; }
function cyan(s)   { return `${C.cyan}${s}${C.reset}`; }
function yellow(s) { return `${C.yellow}${s}${C.reset}`; }

// ── Load and run each suite ───────────────────────────────────────────────

const suites = [
  { name: 'Analyzer',     file: 'test-analyzer.js' },
  { name: 'Purge',        file: 'test-purge.js' },
  { name: 'Integration',  file: 'test-integration.js' },
];

async function main() {
  console.log(bold(cyan('\n╔══════════════════════════════════════════════════╗')));
  console.log(bold(cyan('║         DECRUFT — TEST RUNNER                   ║')));
  console.log(bold(cyan('╚══════════════════════════════════════════════════╝')));
  console.log(`  Node ${process.version} | ${new Date().toISOString()}\n`);

  let totalPassed = 0;
  let totalFailed = 0;
  const suiteResults = [];

  for (const suite of suites) {
    const suitePath = pathToFileURL(path.resolve(__dirname, suite.file)).href;
    console.log(bold(`\n▶ Running suite: ${suite.name}`));
    console.log('─'.repeat(50));

    try {
      // Each suite module exports a `runTests` function that returns { passed, failed }
      const mod = await import(suitePath);

      if (typeof mod.runTests !== 'function') {
        throw new Error(`Suite ${suite.file} does not export runTests()`);
      }

      const { passed, failed } = await mod.runTests();
      totalPassed += passed;
      totalFailed += failed;
      suiteResults.push({ name: suite.name, passed, failed, error: null });

    } catch (err) {
      console.error(red(`\n[ERROR] Suite "${suite.name}" crashed: ${err.message}`));
      console.error(err.stack);
      totalFailed++;
      suiteResults.push({ name: suite.name, passed: 0, failed: 1, error: err.message });
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(50));
  console.log(bold('  TEST RESULTS SUMMARY'));
  console.log('═'.repeat(50));

  for (const r of suiteResults) {
    const status = r.failed === 0 ? green('PASS') : red('FAIL');
    const detail = r.error
      ? red(`ERROR: ${r.error}`)
      : `${green(r.passed + ' ✅')}  ${r.failed > 0 ? red(r.failed + ' ❌') : '0 ❌'}`;
    console.log(`  [${status}] ${r.name.padEnd(15)} ${detail}`);
  }

  console.log('─'.repeat(50));

  const totalTests = totalPassed + totalFailed;
  const allPassed  = totalFailed === 0;

  console.log(`\n  Total: ${totalTests} tests  |  ${green(totalPassed + ' passed')}  |  ${totalFailed > 0 ? red(totalFailed + ' failed') : '0 failed'}`);
  console.log('\n' + (allPassed
    ? green(bold('  ✅ ALL TESTS PASSED — SHIP-READY'))
    : red(bold('  ❌ SOME TESTS FAILED — BLOCKED')))
  );
  console.log('');

  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error(red('\n[FATAL] Test runner crashed unexpectedly:'), err);
  process.exit(1);
});
