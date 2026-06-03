/**
 * tests/test-purge.js
 * ═══════════════════
 * Unit tests for src/purge.js
 * Run via: node tests/run-tests.js
 * Or directly: node tests/test-purge.js
 *
 * Covers:
 *  - distillMessages: keep/remove rules, mutation safety, edge cases
 *  - buildPurgePreview: token savings accuracy
 *  - formatContextPrompt: header, role labels, footer
 */

import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const purgePath  = pathToFileURL(path.resolve(__dirname, '../src/purge.js')).href;

// ── Assertion helpers ──────────────────────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a fake message in the content.js shape (has `text`, not `content`).
 * @param {string} id
 * @param {'human'|'assistant'} role
 * @param {string} text
 * @returns {object}
 */
function makeMsg(id, role, text) {
  return {
    id,
    role,
    text,
    timestamp: Date.now(),
    index: parseInt(id.replace(/\D/g, ''), 10) || 0,
  };
}

/**
 * Build a mock analysisResult with given stale IDs and duplicate warnings.
 */
function makeAnalysis({ staleIds = [], dupWarnings = [], tokenCount = 100, projectedSavings = 0 } = {}) {
  return {
    tokenCount,
    stalenessPercent: staleIds.length > 0 ? 50 : 0,
    staleMessageIds: staleIds,
    duplicateWarnings: dupWarnings,
    projectedSavings,
  };
}

// ── Main test suite ────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n══════════════════════════════════════════');
  console.log('   PURGE.JS — UNIT TESTS');
  console.log('══════════════════════════════════════════\n');

  const {
    distillMessages,
    buildPurgePreview,
    formatContextPrompt,
  } = await import(purgePath);

  // ══════════════════════════════════════════
  // § 1 — distillMessages: edge cases
  // ══════════════════════════════════════════
  console.log('§ 1 · distillMessages — edge cases');

  // Empty array → []
  assert(
    'distillMessages([], mockResult) → []',
    distillMessages([], makeAnalysis()).length === 0
  );

  assert(
    'distillMessages(null, mockResult) → []',
    distillMessages(null, makeAnalysis()).length === 0
  );

  // Single message → returned (it is BOTH first AND last)
  const singleMsg = [makeMsg('1', 'human', 'Hello world this is my first message to the assistant')];
  const singleResult = distillMessages(singleMsg, makeAnalysis());
  assert(
    'distillMessages([singleMsg], mockResult) → [singleMsg]',
    singleResult.length === 1 && singleResult[0].id === '1'
  );

  // ══════════════════════════════════════════
  // § 2 — distillMessages: keep rules
  // ══════════════════════════════════════════
  console.log('\n§ 2 · distillMessages — keep rules (P1+P2)');

  // Build a conversation with 10 messages
  const convo10 = Array.from({ length: 10 }, (_, i) =>
    makeMsg(`m${i}`, i % 2 === 0 ? 'human' : 'assistant', `Message content for turn ${i} in the conversation`)
  );

  // P1: first message always kept
  const result10 = distillMessages(convo10, makeAnalysis({ staleIds: convo10.map(m => m.id) }));
  assert(
    'P1: first message (m0) always kept even if marked stale',
    result10.some(m => m.id === 'm0')
  );

  // P2: last 3 messages always kept
  assert(
    'P2: last message (m9) always kept',
    result10.some(m => m.id === 'm9')
  );
  assert(
    'P2: second-to-last message (m8) always kept',
    result10.some(m => m.id === 'm8')
  );
  assert(
    'P2: third-to-last message (m7) always kept',
    result10.some(m => m.id === 'm7')
  );

  // Always keeps index 0
  const result10First = distillMessages(convo10, makeAnalysis());
  assert(
    'distillMessages always keeps index-0 message',
    result10First[0].id === 'm0'
  );

  // Short conversation (< 3 messages) — all kept
  const convo2 = [makeMsg('x0', 'human', 'hi'), makeMsg('x1', 'assistant', 'hello')];
  const result2 = distillMessages(convo2, makeAnalysis({ staleIds: ['x0', 'x1'] }));
  assert(
    'distillMessages: short conversation (2 msgs) — both kept despite being stale',
    result2.length === 2
  );

  // ══════════════════════════════════════════
  // § 3 — distillMessages: mutation safety
  // ══════════════════════════════════════════
  console.log('\n§ 3 · distillMessages — mutation safety');

  const originalConvo = Array.from({ length: 8 }, (_, i) =>
    makeMsg(`o${i}`, i % 2 === 0 ? 'human' : 'assistant', `Original message ${i} content for the test suite check`)
  );
  const originalRef = [...originalConvo];
  const originalLength = originalConvo.length;
  const originalIds = originalConvo.map(m => m.id);

  distillMessages(originalConvo, makeAnalysis({ staleIds: ['o1', 'o2', 'o3'] }));

  assert(
    'Original array length unchanged after distillMessages',
    originalConvo.length === originalLength
  );
  assert(
    'Original array element IDs unchanged after distillMessages',
    originalConvo.map(m => m.id).join(',') === originalIds.join(',')
  );
  assert(
    'Original array references unchanged (no mutation of elements)',
    originalConvo.every((m, i) => m === originalRef[i])
  );

  // ══════════════════════════════════════════
  // § 4 — distillMessages: stale removal
  // ══════════════════════════════════════════
  console.log('\n§ 4 · distillMessages — stale removal (P3)');

  const convoStale = Array.from({ length: 8 }, (_, i) =>
    makeMsg(`s${i}`, i % 2 === 0 ? 'human' : 'assistant', `Message ${i} about specific topic`)
  );
  // Mark m1..m4 as stale (not first/last-3)
  const staleResult = distillMessages(convoStale, makeAnalysis({ staleIds: ['s1', 's2', 's3', 's4'] }));

  assert(
    'P3: stale messages (s1,s2,s3,s4) removed from middle',
    !staleResult.some(m => ['s1','s2','s3','s4'].includes(m.id))
  );
  assert(
    'P3: non-stale messages retained',
    staleResult.some(m => m.id === 's0')
  );
  assert(
    'P3: last-3 kept even if marked stale in analysisResult',
    staleResult.some(m => m.id === 's7')
  );

  // ══════════════════════════════════════════
  // § 5 — distillMessages: duplicate removal
  // ══════════════════════════════════════════
  console.log('\n§ 5 · distillMessages — duplicate removal (P4)');

  const convoDup = Array.from({ length: 8 }, (_, i) =>
    makeMsg(`d${i}`, i % 2 === 0 ? 'human' : 'assistant', `Message ${i}`)
  );
  // d3 is a later duplicate of d1 (earlier one d1 is kept, later d3 is removed)
  const dupWarnings = [{ messageId: 'd3', duplicateOf: 'd1', similarity: 0.95 }];
  const dupResult = distillMessages(convoDup, makeAnalysis({ dupWarnings }));

  assert(
    'P4: later duplicate (d3) is removed',
    !dupResult.some(m => m.id === 'd3')
  );
  assert(
    'P4: earlier message (d1) is kept',
    dupResult.some(m => m.id === 'd1')
  );

  // ══════════════════════════════════════════
  // § 6 — distillMessages: all unique (no purge)
  // ══════════════════════════════════════════
  console.log('\n§ 6 · distillMessages — all unique messages');

  const uniqueConvo = Array.from({ length: 5 }, (_, i) =>
    makeMsg(`u${i}`, i % 2 === 0 ? 'human' : 'assistant', `Unique content about topic ${i}`)
  );
  const uniqueResult = distillMessages(uniqueConvo, makeAnalysis());
  assert(
    'distillMessages with no stale/dup: all messages kept',
    uniqueResult.length === uniqueConvo.length
  );

  // ══════════════════════════════════════════
  // § 7 — distillMessages: 100+ messages
  // ══════════════════════════════════════════
  console.log('\n§ 7 · distillMessages — 100 messages performance');

  const bigConvo = Array.from({ length: 100 }, (_, i) =>
    makeMsg(`big${i}`, i % 2 === 0 ? 'human' : 'assistant', `Message content for conversation turn number ${i} in this large test`)
  );
  const bigStaleIds = bigConvo.slice(1, 80).map(m => m.id);
  const t0 = Date.now();
  const bigResult = distillMessages(bigConvo, makeAnalysis({ staleIds: bigStaleIds }));
  const tMs = Date.now() - t0;

  assert(
    `distillMessages(100 msgs) completes in < 50ms (took ${tMs}ms)`,
    tMs < 50
  );
  assert(
    'distillMessages(100 msgs) always keeps first message',
    bigResult[0].id === 'big0'
  );
  assert(
    'distillMessages(100 msgs) always keeps last message',
    bigResult[bigResult.length - 1].id === 'big99'
  );
  assert(
    'distillMessages(100 msgs): result length ≤ original',
    bigResult.length <= bigConvo.length
  );
  // last 3 should all be present
  assert(
    'distillMessages(100 msgs): big97, big98, big99 all kept',
    ['big97','big98','big99'].every(id => bigResult.some(m => m.id === id))
  );

  // ══════════════════════════════════════════
  // § 8 — distillMessages: all identical (maximum purge)
  // ══════════════════════════════════════════
  console.log('\n§ 8 · distillMessages — all stale/duplicate scenario');

  // Simulate: all middle messages stale AND duplicated
  const allSame = Array.from({ length: 7 }, (_, i) =>
    makeMsg(`same${i}`, 'human', 'Exactly the same text content repeated over and over again in this conversation')
  );
  const allStaleIds = allSame.slice(1, 4).map(m => m.id); // stale: same1..same3
  const allDupWarnings = [
    { messageId: 'same1', duplicateOf: 'same0', similarity: 1.0 },
    { messageId: 'same2', duplicateOf: 'same0', similarity: 1.0 },
    { messageId: 'same3', duplicateOf: 'same0', similarity: 1.0 },
  ];
  const maxPurgeResult = distillMessages(allSame, makeAnalysis({ staleIds: allStaleIds, dupWarnings: allDupWarnings }));

  assert(
    'Max purge: first message still kept',
    maxPurgeResult.some(m => m.id === 'same0')
  );
  assert(
    'Max purge: last 3 messages still kept',
    ['same4','same5','same6'].every(id => maxPurgeResult.some(m => m.id === id))
  );
  assert(
    'Max purge: result smaller than original',
    maxPurgeResult.length < allSame.length
  );

  // ══════════════════════════════════════════
  // § 9 — buildPurgePreview
  // ══════════════════════════════════════════
  console.log('\n§ 9 · buildPurgePreview');

  const previewMsgs = Array.from({ length: 10 }, (_, i) =>
    makeMsg(`p${i}`, i % 2 === 0 ? 'human' : 'assistant',
      'This is a preview test message with some content to check token counting accuracy')
  );
  const previewAnalysis = makeAnalysis({ tokenCount: 500, projectedSavings: 200 });
  const previewDistilled = previewMsgs.slice(0, 5); // keep first 5

  const preview = buildPurgePreview(previewMsgs, previewDistilled, previewAnalysis);

  assert(
    'buildPurgePreview returns an object',
    preview && typeof preview === 'object'
  );
  assert(
    'buildPurgePreview: originalTokens > 0',
    preview.originalTokens > 0
  );
  assert(
    'buildPurgePreview: distilledTokens ≤ originalTokens',
    preview.distilledTokens <= preview.originalTokens
  );
  assert(
    'buildPurgePreview: savingsTokens ≥ 0',
    preview.savingsTokens >= 0
  );
  assert(
    'buildPurgePreview: savingsPercent in [0, 100]',
    preview.savingsPercent >= 0 && preview.savingsPercent <= 100
  );
  assert(
    'buildPurgePreview: savingsPercent is an integer',
    Number.isInteger(preview.savingsPercent)
  );

  // Verify savingsPercent is correct (rounded)
  const expectedPct = Math.round((preview.savingsTokens / preview.originalTokens) * 100);
  assert(
    `buildPurgePreview: savingsPercent == ${expectedPct} (calculated correctly)`,
    preview.savingsPercent === expectedPct
  );

  // Empty inputs
  const emptyPreview = buildPurgePreview([], [], null);
  assert(
    'buildPurgePreview([], [], null): originalTokens = 0',
    emptyPreview.originalTokens === 0
  );
  assert(
    'buildPurgePreview([], [], null): savingsPercent = 0',
    emptyPreview.savingsPercent === 0
  );

  // keptFirst should be true when first message is in distilled set
  assert(
    'buildPurgePreview keptFirst=true when first msg in distilled',
    preview.keptFirst === true
  );

  // ══════════════════════════════════════════
  // § 10 — formatContextPrompt
  // ══════════════════════════════════════════
  console.log('\n§ 10 · formatContextPrompt');

  // Empty → empty string (NOT the full header)
  const emptyPrompt = formatContextPrompt([]);
  assert(
    'formatContextPrompt([]) → "" (empty string)',
    emptyPrompt === ''
  );

  assert(
    'formatContextPrompt(null) → ""',
    formatContextPrompt(null) === ''
  );

  // Normal messages
  const promptMsgs = [
    makeMsg('h1', 'human',     'Hello, can you help me with my code?'),
    makeMsg('a1', 'assistant', 'Of course! What are you working on?'),
    makeMsg('h2', 'human',     'I am building a Chrome extension.'),
  ];
  const prompt = formatContextPrompt(promptMsgs);

  assert(
    'formatContextPrompt includes "## Conversation Context (Decruft)"',
    prompt.includes('## Conversation Context (Decruft)')
  );
  assert(
    'formatContextPrompt includes "**[Human]:**" for human messages',
    prompt.includes('**[Human]:**')
  );
  assert(
    'formatContextPrompt includes "**[Assistant]:**" for assistant messages',
    prompt.includes('**[Assistant]:**')
  );
  assert(
    'formatContextPrompt includes "*Continue from here:*"',
    prompt.includes('*Continue from here:*')
  );
  assert(
    'formatContextPrompt includes "---" divider before footer',
    prompt.includes('---')
  );
  assert(
    'formatContextPrompt includes the human message text',
    prompt.includes('Hello, can you help me with my code?')
  );
  assert(
    'formatContextPrompt includes the assistant message text',
    prompt.includes('Of course! What are you working on?')
  );

  // Unknown role → "Message"
  const unknownMsg = [makeMsg('u1', 'unknown', 'This is a system message of unknown role')];
  const unknownPrompt = formatContextPrompt(unknownMsg);
  assert(
    'formatContextPrompt uses "[Message]" for unknown role',
    unknownPrompt.includes('**[Message]:**')
  );

  // Single message
  const singlePrompt = formatContextPrompt([makeMsg('s1', 'human', 'Single message test content')]);
  assert(
    'formatContextPrompt on single message: includes header',
    singlePrompt.includes('## Conversation Context (Decruft)')
  );
  assert(
    'formatContextPrompt on single message: includes footer',
    singlePrompt.includes('*Continue from here:*')
  );

  // Header at start
  assert(
    'formatContextPrompt: header is at the start of the string',
    prompt.startsWith('## Conversation Context (Decruft)')
  );

  // Footer at end
  assert(
    'formatContextPrompt: "*Continue from here:*" is at the end',
    prompt.endsWith('*Continue from here:*')
  );

  return { passed, failed, results };
}

runTests()
  .then(({ passed, failed }) => {
    console.log(`\n── purge.js: ${passed} passed, ${failed} failed ──\n`);
    if (failed > 0) process.exit(1);
  })
  .catch(err => {
    console.error('\n[FATAL] Test runner crashed:', err);
    process.exit(1);
  });

export { runTests };
