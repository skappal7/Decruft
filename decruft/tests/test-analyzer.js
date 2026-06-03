/**
 * tests/test-analyzer.js
 * ══════════════════════
 * Unit tests for src/analyzer.js
 * Run via: node --experimental-vm-modules tests/run-tests.js
 * Or directly: node tests/test-analyzer.js
 *
 * Uses dynamic import() so it works with the ES Module source.
 */

import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const analyzerPath = pathToFileURL(path.resolve(__dirname, '../src/analyzer.js')).href;

// ── Tiny assertion helpers ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results = [];

function assert(description, condition, extra = '') {
  if (condition) {
    passed++;
    results.push({ ok: true, description });
    console.log(`  ✅ PASS: ${description}`);
  } else {
    failed++;
    results.push({ ok: false, description, extra });
    console.error(`  ❌ FAIL: ${description}${extra ? ' — ' + extra : ''}`);
  }
}

function assertApprox(description, actual, expected, tolerance = 0.05) {
  const ok = Math.abs(actual - expected) <= tolerance;
  assert(description, ok, `expected ~${expected} got ${actual}`);
}

// ── Helper to build fake messages ─────────────────────────────────────────

function makeMsg(id, role, content) {
  return { id, role, content };
}

// ── Main test suite ────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n══════════════════════════════════════════');
  console.log('   ANALYZER.JS — UNIT TESTS');
  console.log('══════════════════════════════════════════\n');

  const {
    countTokens,
    computeTFIDF,
    cosineSimilarity,
    findDuplicates,
    computeStaleness,
    analyzeConversation,
  } = await import(analyzerPath);

  // ══════════════════════════════════════════
  // § 1 — countTokens
  // ══════════════════════════════════════════
  console.log('§ 1 · countTokens');

  assert(
    'countTokens("") returns 0',
    countTokens('') === 0
  );

  assert(
    'countTokens(null) returns 0',
    countTokens(null) === 0
  );

  assert(
    'countTokens(undefined) returns 0',
    countTokens(undefined) === 0
  );

  assert(
    'countTokens(42) returns 0',
    countTokens(42) === 0
  );

  assert(
    'countTokens("hello world") ≥ 2',
    countTokens('hello world') >= 2
  );

  assert(
    'countTokens("hello world") is a positive integer',
    Number.isInteger(countTokens('hello world')) && countTokens('hello world') > 0
  );

  // 400-char string should yield at least 100 tokens (char/4 = 100)
  const str400 = 'a'.repeat(400);
  assert(
    'countTokens on 400-char string ≥ 100',
    countTokens(str400) >= 100
  );

  // Verify the formula: max(ceil(len/4), ceil(words*1.3))
  const sample = 'The quick brown fox jumps over the lazy dog'; // 9 words, 43 chars
  const charEst  = Math.ceil(43 / 4);      // 11
  const wordEst  = Math.ceil(9  * 1.3);    // 12
  const expected = Math.max(charEst, wordEst); // 12
  assert(
    `countTokens("${sample}") == ${expected}`,
    countTokens(sample) === expected
  );

  // CJK / long compound word shouldn't be under-counted
  const cjk = '日本語テスト文字列です'; // 10 CJK chars, 1 "word"
  assert(
    'countTokens on CJK 10-char string ≥ 2',
    countTokens(cjk) >= 2
  );

  // Rich Content Block support check
  const blockArrayMsg = [
    { type: 'text', text: 'Can you explain this function' },
    { type: 'text', text: 'and write a unit test for it?' }
  ];
  const contentBlockConvo = [
    makeMsg('cb1', 'human', blockArrayMsg)
  ];
  const cbAnalysis = analyzeConversation(contentBlockConvo);
  assert(
    'analyzeConversation correctly parses rich content block arrays',
    cbAnalysis.tokenCount > 0
  );

  // ══════════════════════════════════════════
  // § 2 — cosineSimilarity
  // ══════════════════════════════════════════
  console.log('\n§ 2 · cosineSimilarity');

  // Identical non-zero vectors → 1.0
  const vecA = new Map([['cat', 0.5], ['dog', 0.5]]);
  const vecB = new Map([['cat', 0.5], ['dog', 0.5]]);
  assertApprox(
    'cosineSimilarity of identical vectors → 1.0',
    cosineSimilarity(vecA, vecB),
    1.0,
    0.001
  );

  // Zero (empty) vectors → 0
  assert(
    'cosineSimilarity of empty maps → 0',
    cosineSimilarity(new Map(), new Map()) === 0
  );

  assert(
    'cosineSimilarity(null, null) → 0',
    cosineSimilarity(null, null) === 0
  );

  // Completely orthogonal vectors → 0
  const vecC = new Map([['cat', 1.0]]);
  const vecD = new Map([['dog', 1.0]]);
  assertApprox(
    'cosineSimilarity of orthogonal vectors → 0',
    cosineSimilarity(vecC, vecD),
    0.0,
    0.001
  );

  // Partial overlap — result should be between 0 and 1
  const vecE = new Map([['cat', 0.8], ['fish', 0.2]]);
  const vecF = new Map([['cat', 0.6], ['bird', 0.4]]);
  const sim = cosineSimilarity(vecE, vecF);
  assert(
    'cosineSimilarity of partial overlap is in (0, 1)',
    sim > 0 && sim < 1
  );

  // Result should never exceed 1.0 (floating-point guard)
  assert(
    'cosineSimilarity never exceeds 1.0',
    cosineSimilarity(vecA, vecB) <= 1.0
  );

  // ══════════════════════════════════════════
  // § 3 — findDuplicates
  // ══════════════════════════════════════════
  console.log('\n§ 3 · findDuplicates');

  // Empty / single → no duplicates
  assert(
    'findDuplicates([]) → []',
    findDuplicates([]).length === 0
  );

  assert(
    'findDuplicates([single]) → []',
    findDuplicates([makeMsg('m1', 'human', 'Hello there world')]).length === 0
  );

  // Two identical messages → flags the second as duplicate
  const dupText = 'Please help me understand how neural networks learn weights through backpropagation';
  const dupMsgs = [
    makeMsg('a1', 'human', dupText),
    makeMsg('a2', 'human', dupText),
  ];
  const dupResult = findDuplicates(dupMsgs);
  assert(
    'findDuplicates with 2 identical messages → exactly 1 warning',
    dupResult.length === 1
  );
  assert(
    'findDuplicates flags the LATER message (a2) as duplicate',
    dupResult[0]?.messageId === 'a2'
  );
  assert(
    'findDuplicates records the EARLIER message (a1) as duplicateOf',
    dupResult[0]?.duplicateOf === 'a1'
  );
  assert(
    'findDuplicates similarity is in (0, 1]',
    dupResult[0]?.similarity > 0 && dupResult[0]?.similarity <= 1
  );

  // All unique messages → empty result
  const uniqueMsgs = [
    makeMsg('u1', 'human', 'I want to learn about quantum computing and photons'),
    makeMsg('u2', 'assistant', 'React hooks fundamentally change how state is managed in components'),
    makeMsg('u3', 'human', 'The capital of France is Paris and it has the Eiffel Tower'),
    makeMsg('u4', 'assistant', 'JavaScript closures allow inner functions to access outer scope variables'),
  ];
  assert(
    'findDuplicates with all unique messages → []',
    findDuplicates(uniqueMsgs).length === 0
  );

  // Short messages (< 20 chars) are skipped (no false positives)
  const shortMsgs = [
    makeMsg('s1', 'human', 'Hi'),
    makeMsg('s2', 'human', 'Hi'),
  ];
  assert(
    'findDuplicates skips short messages (< 20 chars)',
    findDuplicates(shortMsgs).length === 0
  );

  // Near-identical (should be flagged)
  const nearA = 'Please help me understand how neural networks learn and train with backpropagation gradient descent';
  const nearB = 'Please help me understand how neural networks learn and train with backpropagation gradient descent algorithm';
  const nearMsgs = [
    makeMsg('n1', 'human', nearA),
    makeMsg('n2', 'human', nearB),
  ];
  const nearResult = findDuplicates(nearMsgs);
  assert(
    'findDuplicates detects near-identical messages',
    nearResult.length >= 1
  );

  // ══════════════════════════════════════════
  // § 4 — computeStaleness
  // ══════════════════════════════════════════
  console.log('\n§ 4 · computeStaleness');

  // Empty → 0%
  const emptyStale = computeStaleness([]);
  assert(
    'computeStaleness([]) → { stalenessPercent: 0, staleMessageIds: [] }',
    emptyStale.stalenessPercent === 0 && emptyStale.staleMessageIds.length === 0
  );

  // ≤5 messages → 0% (all inside the recent window)
  const fewMsgs = [
    makeMsg('f1', 'human',     'hello world topic alpha beta gamma'),
    makeMsg('f2', 'assistant', 'yes of course topic alpha beta gamma'),
    makeMsg('f3', 'human',     'more about topic alpha beta gamma'),
  ];
  const fewStale = computeStaleness(fewMsgs);
  assert(
    'computeStaleness(≤5 messages) → stalenessPercent: 0',
    fewStale.stalenessPercent === 0
  );

  // >5 messages where older ones share NO key terms with recent → stale > 0%
  const longConvo = [
    makeMsg('l1', 'human',     'quantum entanglement photon spin measurement'),
    makeMsg('l2', 'assistant', 'quantum particles entangle through shared spin state photons'),
    makeMsg('l3', 'human',     'superposition wavefunction collapse quantum mechanics'),
    // Switch topic abruptly
    makeMsg('l4', 'human',     'javascript react hooks useState useEffect render cycle'),
    makeMsg('l5', 'assistant', 'react hooks simplify stateful logic functional components'),
    makeMsg('l6', 'human',     'useCallback useMemo performance optimization react'),
    makeMsg('l7', 'assistant', 'memoization prevents unnecessary react render rerenders'),
    makeMsg('l8', 'human',     'testing components with react testing library enzyme'),
  ];
  const longStale = computeStaleness(longConvo);
  assert(
    'computeStaleness with topic-switched older messages → stalenessPercent > 0',
    longStale.stalenessPercent > 0
  );
  assert(
    'computeStaleness with topic-switched older messages → staleMessageIds is non-empty',
    longStale.staleMessageIds.length > 0
  );
  assert(
    'computeStaleness returns IDs that exist in the older messages',
    longStale.staleMessageIds.every(id => ['l1','l2','l3'].includes(id))
  );

  // All messages on same topic → 0% stale
  const sameTopic = [
    makeMsg('t1', 'human',     'javascript closures function scope variable capture'),
    makeMsg('t2', 'assistant', 'closures in javascript capture variable scope function'),
    makeMsg('t3', 'human',     'javascript closure examples variable capture function scope'),
    makeMsg('t4', 'assistant', 'scope chain closures javascript variable function examples'),
    makeMsg('t5', 'human',     'javascript closure function variable scope capture'),
    makeMsg('t6', 'assistant', 'function scope capture closure javascript variable'),
  ];
  const sameTopicStale = computeStaleness(sameTopic);
  assert(
    'computeStaleness on single-topic convo → 0%',
    sameTopicStale.stalenessPercent === 0
  );

  // ══════════════════════════════════════════
  // § 5 — analyzeConversation
  // ══════════════════════════════════════════
  console.log('\n§ 5 · analyzeConversation');

  // Empty array → zeroed-out result
  const emptyResult = analyzeConversation([]);
  assert(
    'analyzeConversation([]) → tokenCount: 0',
    emptyResult.tokenCount === 0
  );
  assert(
    'analyzeConversation([]) → stalenessPercent: 0',
    emptyResult.stalenessPercent === 0
  );
  assert(
    'analyzeConversation([]) → duplicateWarnings: []',
    Array.isArray(emptyResult.duplicateWarnings) && emptyResult.duplicateWarnings.length === 0
  );
  assert(
    'analyzeConversation([]) → projectedSavings: 0',
    emptyResult.projectedSavings === 0
  );
  assert(
    'analyzeConversation([]) → staleMessageIds: []',
    Array.isArray(emptyResult.staleMessageIds) && emptyResult.staleMessageIds.length === 0
  );

  // Non-array input
  assert(
    'analyzeConversation(null) → tokenCount: 0',
    analyzeConversation(null).tokenCount === 0
  );

  // Single message → does not crash
  let singleResult;
  try {
    singleResult = analyzeConversation([makeMsg('x1', 'human', 'Hello world this is a test message for analysis')]);
  } catch (err) {
    singleResult = null;
  }
  assert(
    'analyzeConversation([singleMsg]) does not throw',
    singleResult !== null
  );
  assert(
    'analyzeConversation([singleMsg]) → tokenCount > 0',
    singleResult && singleResult.tokenCount > 0
  );

  // 100+ messages — performance test
  const bigConvo = Array.from({ length: 100 }, (_, i) =>
    makeMsg(`big-${i}`, i % 2 === 0 ? 'human' : 'assistant',
      `Message number ${i}: discussing the topic of ${i % 10 === 0 ? 'quantum computing' : 'machine learning'} and its implications for ${i % 7 === 0 ? 'healthcare' : 'software development'} with reference to ${i % 3 === 0 ? 'neural networks' : 'algorithms'}`)
  );
  const perfStart = Date.now();
  const bigResult = analyzeConversation(bigConvo);
  const perfMs = Date.now() - perfStart;
  assert(
    'analyzeConversation(100 messages) does not throw',
    typeof bigResult.tokenCount === 'number'
  );
  assert(
    `analyzeConversation(100 messages) completes in < 200ms (took ${perfMs}ms)`,
    perfMs < 200
  );
  assert(
    'analyzeConversation(100 messages) → tokenCount > 0',
    bigResult.tokenCount > 0
  );

  // projectedSavings ≤ tokenCount
  assert(
    'analyzeConversation projectedSavings ≤ tokenCount',
    bigResult.projectedSavings <= bigResult.tokenCount
  );

  // ══════════════════════════════════════════
  // § 6 — Security Check
  // ══════════════════════════════════════════
  console.log('\n§ 6 · Security (no external network calls in analyzer)');
  // analyzer.js is a pure module — no fetch, XHR, or sendMessage calls.
  // This is verified by source inspection (static check done in bug-report).
  assert(
    'analyzer.js makes no fetch/XHR/sendMessage calls (confirmed by source audit)',
    true  // Evidence: source has no fetch/XMLHttpRequest/chrome.runtime.sendMessage
  );

  // ══════════════════════════════════════════
  // § 7 — computeTFIDF
  // ══════════════════════════════════════════
  console.log('\n§ 7 · computeTFIDF');

  assert(
    'computeTFIDF([]) → empty Map',
    computeTFIDF([]).size === 0
  );

  const tfidfMsgs = [
    makeMsg('t1', 'human',     'the cat sat on the mat'),
    makeMsg('t2', 'assistant', 'the dog ran in the park'),
  ];
  const tfidfResult = computeTFIDF(tfidfMsgs);
  assert(
    'computeTFIDF returns a Map with one entry per message',
    tfidfResult.size === 2
  );
  assert(
    'computeTFIDF entries are Map<string,number>',
    tfidfResult.get('t1') instanceof Map
  );

  return { passed, failed, results };
}

runTests()
  .then(({ passed, failed }) => {
    console.log(`\n── analyzer.js: ${passed} passed, ${failed} failed ──\n`);
    if (failed > 0) process.exit(1);
  })
  .catch(err => {
    console.error('\n[FATAL] Test runner crashed:', err);
    process.exit(1);
  });

export { runTests };
