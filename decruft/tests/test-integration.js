/**
 * tests/test-integration.js
 * ═════════════════════════
 * Integration tests simulating the full end-to-end flow of the Decruft pipeline.
 *
 * Flow under test:
 *   content.js scrapes messages
 *     → background.js ANALYZE_MESSAGES (calls analyzeConversation)
 *     → content.js receives ANALYSIS_RESULT, sets window.__decruft_state
 *     → purge-bridge.js reads state, calls EXECUTE_PURGE
 *     → background.js PURGE_CONTEXT (calls distillMessages + formatContextPrompt)
 *     → content.js gets OPEN_NEW_CHAT with contextText
 *
 * Since we cannot run a real Chrome extension in Node, we simulate each stage
 * by calling the underlying library functions directly, verifying the full data
 * transformation chain end-to-end.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const analyzerPath = pathToFileURL(path.resolve(__dirname, '../src/analyzer.js')).href;
const purgePath    = pathToFileURL(path.resolve(__dirname, '../src/purge.js')).href;

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

// ── Fake conversation builders ─────────────────────────────────────────────

/**
 * Build a realistic conversation.
 * Messages in content.js shape: { id, role, text, timestamp, index }
 * Messages in analyzer.js shape: { id, role, content }
 *
 * purge.js works with EITHER `text` or `content` via its msgText() helper.
 */
function buildConversation(turns) {
  const now = Date.now();
  return turns.map(({ role, text }, i) => ({
    id:        `dcft-${i + 1}-abc${i}`,
    role,
    text,            // content.js field
    content: text,   // analyzer.js field (both present for compatibility)
    timestamp: now - (turns.length - i) * 60000,
    index:     i,
  }));
}

// ── Main test suite ────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n══════════════════════════════════════════');
  console.log('   INTEGRATION TESTS — Full Pipeline');
  console.log('══════════════════════════════════════════\n');

  const {
    countTokens,
    analyzeConversation,
    findDuplicates,
    computeStaleness,
  } = await import(analyzerPath);

  const {
    distillMessages,
    buildPurgePreview,
    formatContextPrompt,
  } = await import(purgePath);

  // ══════════════════════════════════════════
  // § 1 — Full pipeline: typical conversation
  // ══════════════════════════════════════════
  console.log('§ 1 · Full pipeline — typical 12-message conversation');

  const typicalConvo = buildConversation([
    { role: 'human',     text: 'I want to build a Chrome extension that monitors context window usage in Claude conversations.' },
    { role: 'assistant', text: 'Great idea! You will need a manifest.json, content script, background service worker, and a widget UI.' },
    { role: 'human',     text: 'How do I inject a floating widget into the page without it being affected by Claude\'s styles?' },
    { role: 'assistant', text: 'Use a Shadow DOM attached to a host element. This creates style isolation. Content.js injects the widget JS as a web-accessible resource.' },
    { role: 'human',     text: 'Can you explain Shadow DOM again? I want to build a widget using Shadow DOM for style isolation.' },
    { role: 'assistant', text: 'Shadow DOM is a scoped DOM tree attached to a host element. Styles inside don\'t leak out, and page styles don\'t leak in.' },
    { role: 'human',     text: 'How do I detect when Claude finishes streaming a response so I can trigger re-analysis?' },
    { role: 'assistant', text: 'Use a MutationObserver watching the message container. Debounce the handler by 500ms to avoid hammering analysis on every token.' },
    { role: 'human',     text: 'What NLP approach works best for detecting duplicate messages without an API?' },
    { role: 'assistant', text: 'TF-IDF with cosine similarity works well for this use case. It is fully local, fast, and handles near-duplicates above a threshold.' },
    { role: 'human',     text: 'How do I count tokens accurately for Claude without calling the API?' },
    { role: 'assistant', text: 'Use character_count / 4 as the primary estimate, refined by word_count * 1.3. Take the max of both estimates for accuracy.' },
  ]);

  // Stage 1: analyzeConversation (background.js ANALYZE_MESSAGES handler)
  const analysisResult = analyzeConversation(typicalConvo);

  assert(
    'Stage 1: analyzeConversation returns tokenCount > 0',
    analysisResult.tokenCount > 0
  );
  assert(
    'Stage 1: analyzeConversation returns all required fields',
    'tokenCount' in analysisResult &&
    'stalenessPercent' in analysisResult &&
    'duplicateWarnings' in analysisResult &&
    'projectedSavings' in analysisResult &&
    'staleMessageIds' in analysisResult
  );
  assert(
    'Stage 1: stalenessPercent in [0, 100]',
    analysisResult.stalenessPercent >= 0 && analysisResult.stalenessPercent <= 100
  );
  assert(
    'Stage 1: projectedSavings ≤ tokenCount',
    analysisResult.projectedSavings <= analysisResult.tokenCount
  );

  // Stage 2: content.js sets window.__decruft_state (simulated)
  const simulatedState = {
    messages:       typicalConvo,
    analysisResult: analysisResult,
  };
  assert(
    'Stage 2: __decruft_state.messages equals the conversation array',
    simulatedState.messages === typicalConvo
  );
  assert(
    'Stage 2: __decruft_state.analysisResult equals the analysis output',
    simulatedState.analysisResult === analysisResult
  );

  // Stage 3: purge-bridge.js calls distillMessages (simulated)
  const distilled = distillMessages(typicalConvo, analysisResult);
  assert(
    'Stage 3: distillMessages returns a non-empty array',
    distilled.length > 0
  );
  assert(
    'Stage 3: first message always preserved',
    distilled[0].id === typicalConvo[0].id
  );
  assert(
    'Stage 3: last message always preserved',
    distilled[distilled.length - 1].id === typicalConvo[typicalConvo.length - 1].id
  );
  assert(
    'Stage 3: distilled ≤ original length',
    distilled.length <= typicalConvo.length
  );

  // Stage 4: background.js builds context prompt (simulated)
  const contextText = formatContextPrompt(distilled);
  assert(
    'Stage 4: contextText is a non-empty string',
    typeof contextText === 'string' && contextText.length > 0
  );
  assert(
    'Stage 4: contextText contains the header',
    contextText.includes('## Conversation Context (Decruft)')
  );
  assert(
    'Stage 4: contextText contains human role label',
    contextText.includes('**[Human]:**')
  );
  assert(
    'Stage 4: contextText contains assistant role label',
    contextText.includes('**[Assistant]:**')
  );
  assert(
    'Stage 4: contextText ends with continue footer',
    contextText.endsWith('*Continue from here:*')
  );

  // Stage 5: buildPurgePreview for widget modal
  const preview = buildPurgePreview(typicalConvo, distilled, analysisResult);
  assert(
    'Stage 5: preview.distilledTokens ≤ preview.originalTokens',
    preview.distilledTokens <= preview.originalTokens
  );
  assert(
    'Stage 5: preview.savingsPercent in [0, 100]',
    preview.savingsPercent >= 0 && preview.savingsPercent <= 100
  );

  // ══════════════════════════════════════════
  // § 2 — Empty conversation
  // ══════════════════════════════════════════
  console.log('\n§ 2 · Empty conversation end-to-end');

  const emptyConvo = [];
  const emptyAnalysis = analyzeConversation(emptyConvo);
  const emptyDistilled = distillMessages(emptyConvo, emptyAnalysis);
  const emptyContextText = formatContextPrompt(emptyDistilled);
  const emptyPreview = buildPurgePreview(emptyConvo, emptyDistilled, emptyAnalysis);

  assert(
    'Empty: analyzeConversation returns tokenCount=0',
    emptyAnalysis.tokenCount === 0
  );
  assert(
    'Empty: distillMessages returns []',
    emptyDistilled.length === 0
  );
  assert(
    'Empty: formatContextPrompt returns ""',
    emptyContextText === ''
  );
  assert(
    'Empty: buildPurgePreview returns savingsPercent=0',
    emptyPreview.savingsPercent === 0
  );

  // ══════════════════════════════════════════
  // § 3 — Single message conversation
  // ══════════════════════════════════════════
  console.log('\n§ 3 · Single message conversation');

  const singleConvo = buildConversation([
    { role: 'human', text: 'What is the meaning of life?' },
  ]);
  const singleAnalysis  = analyzeConversation(singleConvo);
  const singleDistilled = distillMessages(singleConvo, singleAnalysis);
  const singleContext   = formatContextPrompt(singleDistilled);

  assert(
    'Single: analysis does not throw and tokenCount > 0',
    singleAnalysis.tokenCount > 0
  );
  assert(
    'Single: distilled keeps the one message',
    singleDistilled.length === 1
  );
  assert(
    'Single: context text is generated',
    singleContext.includes('What is the meaning of life?')
  );

  // ══════════════════════════════════════════
  // § 4 — Maximum purge scenario (all duplicates)
  // ══════════════════════════════════════════
  console.log('\n§ 4 · Maximum purge — all-identical messages');

  const dupText = 'Please help me understand how transformer models process token sequences with attention mechanisms';
  const allDupConvo = Array.from({ length: 8 }, (_, i) =>
    buildConversation([{ role: 'human', text: dupText }])[0]
  ).map((m, i) => ({ ...m, id: `dup${i}`, index: i }));

  // Run the full pipeline
  const dupAnalysis  = analyzeConversation(allDupConvo);
  const dupDistilled = distillMessages(allDupConvo, dupAnalysis);
  const dupPreview   = buildPurgePreview(allDupConvo, dupDistilled, dupAnalysis);

  assert(
    'MaxDup: duplicate warnings detected by analyzeConversation',
    dupAnalysis.duplicateWarnings.length > 0
  );
  assert(
    'MaxDup: distillMessages reduces the conversation',
    dupDistilled.length < allDupConvo.length
  );
  assert(
    'MaxDup: first message still present after max purge',
    dupDistilled[0].id === 'dup0'
  );
  assert(
    'MaxDup: preview shows savings > 0',
    dupPreview.savingsTokens > 0
  );

  // ══════════════════════════════════════════
  // § 5 — All unique messages (no purge needed)
  // ══════════════════════════════════════════
  console.log('\n§ 5 · All unique messages — no purge needed');

  const uniqueConvo = buildConversation([
    { role: 'human',     text: 'Tell me about photosynthesis and how plants convert sunlight into chemical energy stored as glucose' },
    { role: 'assistant', text: 'Photosynthesis occurs in chloroplasts where light reactions and the Calvin cycle convert CO2 and H2O into glucose' },
    { role: 'human',     text: 'How do JavaScript promises work and what is the difference between then and async await syntax' },
    { role: 'assistant', text: 'Promises represent eventual values. Async await is syntactic sugar over promises making asynchronous code read synchronously' },
    { role: 'human',     text: 'What are the key differences between TCP and UDP network protocols for data transmission' },
  ]);
  const uniqueAnalysis  = analyzeConversation(uniqueConvo);
  const uniqueDistilled = distillMessages(uniqueConvo, uniqueAnalysis);

  assert(
    'AllUnique: no duplicates detected',
    uniqueAnalysis.duplicateWarnings.length === 0
  );
  assert(
    'AllUnique: conversation within staleness window, so 0% stale',
    uniqueAnalysis.stalenessPercent === 0
  );
  assert(
    'AllUnique: distillMessages keeps all messages (no purge)',
    uniqueDistilled.length === uniqueConvo.length
  );

  // ══════════════════════════════════════════
  // § 6 — Security: no external network calls in pipeline
  // ══════════════════════════════════════════
  console.log('\n§ 6 · Security — no external network calls');

  // We mock fetch to detect if any call is made during the pipeline
  let fetchCallCount = 0;
  const originalFetch = global.fetch;
  global.fetch = (...args) => {
    fetchCallCount++;
    console.error('    ⚠️  fetch() called with:', args[0]);
    return Promise.resolve({ ok: false, status: 403, json: () => ({}) });
  };

  // Run the full pipeline with the mock
  const secConvo = buildConversation([
    { role: 'human',     text: 'Test security check message with sensitive user content' },
    { role: 'assistant', text: 'Assistant response with private data that must not be transmitted' },
    { role: 'human',     text: 'Another message containing confidential user information' },
  ]);
  analyzeConversation(secConvo);
  distillMessages(secConvo, makeBasicAnalysis(secConvo));
  formatContextPrompt(secConvo);

  global.fetch = originalFetch;

  assert(
    'Security: no fetch() calls made during analysis+distill+format pipeline',
    fetchCallCount === 0,
    `fetch was called ${fetchCallCount} times`
  );

  // ══════════════════════════════════════════
  // § 7 — Data integrity: conversation order preserved
  // ══════════════════════════════════════════
  console.log('\n§ 7 · Data integrity — conversation order preserved');

  const orderedConvo = buildConversation([
    { role: 'human',     text: 'First message sets the original intent of this conversation about databases' },
    { role: 'assistant', text: 'I understand. You are asking about database systems SQL NoSQL relational design' },
    { role: 'human',     text: 'Lets pivot to discuss completely different topic about painting and art history' },
    { role: 'assistant', text: 'Art history covers many periods from Renaissance Baroque Impressionism Modern art' },
    { role: 'human',     text: 'Now back to databases specifically PostgreSQL performance tuning indexes queries' },
    { role: 'assistant', text: 'PostgreSQL performance depends on proper indexing query planning statistics vacuum' },
    { role: 'human',     text: 'What about Redis and when to use it instead of PostgreSQL for caching' },
  ]);

  const orderedAnalysis  = analyzeConversation(orderedConvo);
  const orderedDistilled = distillMessages(orderedConvo, orderedAnalysis);

  // Verify distilled is in original order (not re-ordered)
  let isOrdered = true;
  for (let i = 1; i < orderedDistilled.length; i++) {
    const prevIdx = orderedConvo.findIndex(m => m.id === orderedDistilled[i-1].id);
    const currIdx = orderedConvo.findIndex(m => m.id === orderedDistilled[i].id);
    if (prevIdx > currIdx) { isOrdered = false; break; }
  }
  assert(
    'distillMessages preserves original conversation order',
    isOrdered
  );

  // ══════════════════════════════════════════
  // § 8 — Token count pipeline consistency
  // ══════════════════════════════════════════
  console.log('\n§ 8 · Token count pipeline consistency');

  const tokenConvo = buildConversation([
    { role: 'human',     text: 'Hello world.' },
    { role: 'assistant', text: 'Hi there! How can I assist you today?' },
    { role: 'human',     text: 'I need help with JavaScript promises and async await patterns.' },
  ]);
  const tokenAnalysis = analyzeConversation(tokenConvo);

  // Manual count for verification
  const manualTotal = tokenConvo.reduce((s, m) => s + countTokens(m.content), 0);
  assert(
    'analyzeConversation.tokenCount matches sum of individual countTokens()',
    tokenAnalysis.tokenCount === manualTotal
  );

  const tokenDistilled  = distillMessages(tokenConvo, tokenAnalysis);
  const tokenPreview    = buildPurgePreview(tokenConvo, tokenDistilled, tokenAnalysis);
  assert(
    'buildPurgePreview.distilledTokens > 0 for non-empty distilled set',
    tokenPreview.distilledTokens > 0
  );

  return { passed, failed, results };
}

/**
 * Helper to build a minimal analysisResult for security check section.
 */
function makeBasicAnalysis(msgs) {
  return {
    tokenCount: 100,
    stalenessPercent: 0,
    staleMessageIds: [],
    duplicateWarnings: [],
    projectedSavings: 0,
  };
}

runTests()
  .then(({ passed, failed }) => {
    console.log(`\n── integration: ${passed} passed, ${failed} failed ──\n`);
    if (failed > 0) process.exit(1);
  })
  .catch(err => {
    console.error('\n[FATAL] Integration test runner crashed:', err);
    process.exit(1);
  });

export { runTests };
