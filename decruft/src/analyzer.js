/**
 * Decruft — Core NLP Analysis Module (src/analyzer.js)
 * ═══════════════════════════════════════════════════════
 * 100% local, zero network calls. Pure JavaScript TF-IDF implementation.
 * Designed for use as an ES Module imported by background.js.
 *
 * Exported API:
 *  - countTokens(text)           → number
 *  - computeTFIDF(messages)      → Map<messageId, Map<term, tfidfScore>>
 *  - cosineSimilarity(vecA, vecB) → number  [0..1]
 *  - findDuplicates(messages)    → Array<{messageId, duplicateOf, similarity}>
 *  - computeStaleness(messages)  → number   [0..100]
 *  - analyzeConversation(messages) → AnalysisResult
 *
 * Message shape expected throughout:
 *  { id: string, role: 'human'|'assistant', content: string }
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Similarity threshold above which two messages are flagged as duplicates. */
const DUPLICATE_THRESHOLD = 0.75;

/**
 * How many of the most recent messages constitute the "recent window"
 * for staleness detection.
 */
const STALENESS_WINDOW = 5;

/**
 * Common English stop-words to ignore during TF-IDF / staleness scoring.
 * Keeping the set minimal avoids stripping potentially meaningful terms.
 */
const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','it','its','this','that','these','those','was','are',
  'were','be','been','being','have','has','had','do','does','did','will',
  'would','could','should','may','might','shall','can','need','dare',
  'ought','used','not','no','so','if','as','up','out','about','into',
  'then','than','there','their','they','he','she','we','i','you','me',
  'him','her','us','my','your','our','his','its','what','which','who',
  'whom','how','when','where','why','all','any','each','every','both',
  'few','more','most','other','some','such','also','just','even','well',
  'get','got','let','like','know','think','want','make','go','see','one',
  'new','good','time','very','still','own','same','back','after','only',
  'now','first','last','long','great','little','own','right','old','big',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safely extracts plain text from a message object.
 * Handles both `text` (content.js shape) and `content` (mock/standard shape).
 *
 * @param {object} msg
 * @returns {string}
 */
function getMessageText(msg) {
  if (!msg) return '';
  const raw = msg.content ?? msg.text ?? '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((block) => {
        if (!block) return '';
        if (typeof block === 'string') return block;
        if (typeof block === 'object') {
          return block.text ?? block.content ?? '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof raw === 'object') {
    return raw.text ?? raw.content ?? '';
  }
  return String(raw);
}

/**
 * Normalise and tokenise text into an array of meaningful terms.
 * - Lowercases
 * - Strips punctuation (keeps apostrophes within words so "don't" → "dont")
 * - Removes stop-words
 * - Ignores tokens shorter than 2 characters
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];

  // Lowercase and remove apostrophes within words to keep contractions as single tokens
  const cleaned = text.toLowerCase().replace(/(\w)'(\w)/g, '$1$2');
  
  // Match letters (\p{L}) and numbers (\p{N}) across all languages to prevent stripping accents/foreign alphabets
  const tokens = cleaned.match(/[\p{L}\p{N}]+/gu) || [];
  
  return tokens.filter(token => token.length >= 2 && !STOP_WORDS.has(token));
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported: Token Counting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimate the number of LLM tokens in a string.
 *
 * Primary method : charCount / 4  (standard GPT/Claude rule-of-thumb).
 * Refinement     : also count whitespace-delimited words and CJK characters
 *                  to ensure logographic or space-less scripts are weighted correctly.
 *
 * @param {string} text
 * @returns {number}  Integer token estimate
 */
export function countTokens(text) {
  if (!text || typeof text !== 'string') return 0;

  const charEstimate = Math.ceil(text.length / 4);

  // Word-boundary refinement: each word ≈ 1.3 tokens on average
  const words = text.trim().split(/\s+/).filter(Boolean);
  const wordEstimate = Math.ceil(words.length * 1.3);

  // CJK-specific multiplier: CJK characters often encode to ~1.5 - 2.0 tokens each in Tiktoken / Llama.
  // Chinese: \u4e00-\u9fa5, Japanese Hiragana/Katakana: \u3040-\u30ff, Japanese Hangul: \u31f0-\u31ff, Korean: \uac00-\ud7af
  const cjkRegex = /[\u4e00-\u9fa5\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af]/g;
  const cjkMatches = text.match(cjkRegex);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const cjkEstimate = Math.ceil(cjkCount * 1.5);

  return Math.max(charEstimate, wordEstimate, cjkEstimate);
}

/**
 * Build a term-frequency (TF) map for a list of tokens.
 * TF is normalised: count / totalTokens  (avoids length bias).
 *
 * @param {string[]} tokens
 * @returns {Map<string, number>}
 */
function buildTFMap(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  const total = tokens.length || 1; // guard against division by zero
  const tf = new Map();
  for (const [term, count] of counts) {
    tf.set(term, count / total);
  }
  return tf;
}

/**
 * Build an inverse-document-frequency (IDF) map across all documents.
 * Uses smoothed IDF:  log(1 + N / (1 + df))  to prevent zero-division.
 *
 * @param {Map<string, number>[]} tfMaps  - one TF map per document
 * @returns {Map<string, number>}
 */
function buildIDFMap(tfMaps) {
  const N = tfMaps.length;
  const df = new Map(); // document-frequency per term

  for (const tfMap of tfMaps) {
    for (const term of tfMap.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map();
  for (const [term, docFreq] of df) {
    idf.set(term, Math.log(1 + N / (1 + docFreq)));
  }
  return idf;
}


/**
 * Compute TF-IDF vectors for an array of messages.
 * Each message gets a sparse vector represented as  Map<term, tfidfScore>.
 *
 * @param {{ id: string, content: string }[]} messages
 * @param {Map<string, string[]>} [tokenizedMap] - Pre-tokenized message term arrays
 * @returns {Map<string, Map<string, number>>}  messageId → tfidf vector
 */
export function computeTFIDF(messages, tokenizedMap = null) {
  if (!messages || messages.length === 0) return new Map();

  // Build per-message TF maps using tokenizedMap cache if available
  const tfMaps = messages.map(msg => {
    const tokens = tokenizedMap
      ? (tokenizedMap.get(msg.id) ?? tokenize(getMessageText(msg)))
      : tokenize(getMessageText(msg));
    return buildTFMap(tokens);
  });

  // Build corpus-wide IDF
  const idf = buildIDFMap(tfMaps);

  // Multiply TF × IDF to get final vectors
  const result = new Map();
  messages.forEach((msg, idx) => {
    const tfidfVec = new Map();
    for (const [term, tfScore] of tfMaps[idx]) {
      tfidfVec.set(term, tfScore * (idf.get(term) ?? 0));
    }
    result.set(msg.id, tfidfVec);
  });

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported: Cosine Similarity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two sparse TF-IDF vectors.
 * Returns a value in [0, 1]:  0 = completely dissimilar, 1 = identical.
 *
 * @param {Map<string, number>} vecA
 * @param {Map<string, number>} vecB
 * @returns {number}
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.size === 0 || vecB.size === 0) return 0;

  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  // Dot product — iterate over the smaller vector for efficiency
  const [smaller, larger] = vecA.size <= vecB.size
    ? [vecA, vecB]
    : [vecB, vecA];

  for (const [term, scoreA] of smaller) {
    const scoreB = larger.get(term);
    if (scoreB !== undefined) {
      dotProduct += scoreA * scoreB;
    }
  }

  // Magnitudes
  for (const score of vecA.values()) magA += score * score;
  for (const score of vecB.values()) magB += score * score;

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;

  // Clamp to [0, 1] to handle floating-point rounding
  return Math.min(1, Math.max(0, dotProduct / denom));
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported: Duplicate Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find messages that are semantically near-duplicate (similarity > 0.75).
 * Only flags the *later* message as a duplicate of the earlier one.
 * Skips very short messages (< 20 chars) that would produce noisy results.
 *
 * @param {{ id: string, role: string, content: string }[]} messages
 * @param {Map<string, string[]>} [tokenizedMap] - Pre-tokenized message term arrays
 * @returns {{ messageId: string, duplicateOf: string, similarity: number }[]}
 */
export function findDuplicates(messages, tokenizedMap = null) {
  if (!messages || messages.length < 2) return [];

  // Filter out trivially short messages before expensive pairwise comparison
  const candidates = messages.filter(m => getMessageText(m).length >= 20);
  if (candidates.length < 2) return [];

  const tfidfVectors = computeTFIDF(candidates, tokenizedMap);
  const warnings = [];

  // Magnitude caching optimization (Issue 2A): Compute magnitudes once before the O(N^2) comparison loop
  const magnitudes = new Map();
  for (const msg of candidates) {
    const vec = tfidfVectors.get(msg.id);
    let mag = 0;
    if (vec) {
      for (const score of vec.values()) {
        mag += score * score;
      }
    }
    magnitudes.set(msg.id, Math.sqrt(mag));
  }

  // O(n²) pairwise comparison — optimized magnitude lookups
  for (let i = 0; i < candidates.length; i++) {
    const msgA = candidates[i];
    const vecA = tfidfVectors.get(msgA.id);
    const magA = magnitudes.get(msgA.id);
    if (!vecA || magA === 0) continue;

    for (let j = i + 1; j < candidates.length; j++) {
      const msgB = candidates[j];
      const vecB = tfidfVectors.get(msgB.id);
      const magB = magnitudes.get(msgB.id);
      if (!vecB || magB === 0) continue;

      // Dot product calculation
      let dotProduct = 0;
      const [smaller, larger] = vecA.size <= vecB.size
        ? [vecA, vecB]
        : [vecB, vecA];

      for (const [term, scoreA] of smaller) {
        const scoreB = larger.get(term);
        if (scoreB !== undefined) {
          dotProduct += scoreA * scoreB;
        }
      }

      const denom = magA * magB;
      const similarity = denom > 0 ? dotProduct / denom : 0;
      const clampedSim = Math.min(1, Math.max(0, similarity));

      if (clampedSim > DUPLICATE_THRESHOLD) {
        // Flag the later message (j) as a duplicate of the earlier (i)
        warnings.push({
          messageId:   msgB.id,
          duplicateOf: msgA.id,
          similarity:  Math.round(clampedSim * 1000) / 1000, // 3 decimal places
        });
      }
    }
  }

  return warnings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported: Staleness Scoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine which messages are "stale" — i.e., their key terms have not
 * appeared in the last STALENESS_WINDOW (5) messages.
 *
 * A message's key terms are its top-5 TF-IDF-weighted tokens.
 * A message is stale when NONE of its key terms appear in the combined
 * text of the recent window.
 *
 * @param {{ id: string, role: string, content: string }[]} messages
 * @param {Map<string, string[]>} [tokenizedMap] - Pre-tokenized message term arrays
 * @returns {{ stalenessPercent: number, staleMessageIds: string[] }}
 */
export function computeStaleness(messages, tokenizedMap = null) {
  if (!messages || messages.length === 0) {
    return { stalenessPercent: 0, staleMessageIds: [] };
  }

  // If the whole conversation fits inside the window, nothing can be stale
  if (messages.length <= STALENESS_WINDOW) {
    return { stalenessPercent: 0, staleMessageIds: [] };
  }

  // Split into "older" (candidates for staleness) and "recent window"
  const recentMessages = messages.slice(-STALENESS_WINDOW);
  const olderMessages  = messages.slice(0, -STALENESS_WINDOW);

  // Build a Set of all individual tokens appearing in the recent window (using pre-tokenized maps)
  const recentTokenSet = new Set(
    recentMessages.flatMap(m => {
      return tokenizedMap
        ? (tokenizedMap.get(m.id) ?? tokenize(getMessageText(m)))
        : tokenize(getMessageText(m));
    })
  );

  // Compute TF-IDF vectors for the older messages to find their key terms
  const tfidfVectors = computeTFIDF(olderMessages, tokenizedMap);

  const staleMessageIds = [];

  for (const msg of olderMessages) {
    const vec = tfidfVectors.get(msg.id);
    if (!vec || vec.size === 0) {
      // Empty or un-vectorisable message → treat as stale
      staleMessageIds.push(msg.id);
      continue;
    }

    // Select top-5 terms by TF-IDF score as key terms
    const keyTerms = [...vec.entries()]
      .sort((a, b) => b[1] - a[1])  // descending by score
      .slice(0, 5)
      .map(([term]) => term);

    // Message is stale if NONE of its key terms appear in the recent window
    const isReferenced = keyTerms.some(term => recentTokenSet.has(term));
    if (!isReferenced) {
      staleMessageIds.push(msg.id);
    }
  }

  const stalenessPercent = olderMessages.length > 0
    ? Math.round((staleMessageIds.length / olderMessages.length) * 100)
    : 0;

  return { stalenessPercent, staleMessageIds };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported: Full Conversation Analysis (main entry point)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all analyses on a conversation and return a unified result object.
 *
 * @param {{ id: string, role: 'human'|'assistant', content: string }[]} messages
 * @returns {{
 *   tokenCount:        number,   // Total estimated tokens across all messages
 *   stalenessPercent:  number,   // % of older messages deemed stale (0-100)
 *   duplicateWarnings: { messageId: string, duplicateOf: string, similarity: number }[],
 *   projectedSavings:  number,   // Tokens saved by purging stale + duplicate messages
 *   staleMessageIds:   string[], // IDs of stale messages
 * }}
 */
export function analyzeConversation(messages) {
  // ── Guard: empty or invalid input ──────────────────────────────────────────
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      tokenCount:        0,
      stalenessPercent:  0,
      duplicateWarnings: [],
      projectedSavings:  0,
      staleMessageIds:   [],
    };
  }

  // Pre-tokenize all messages exactly once (Issue 2B) to avoid expensive duplicate tokenization passes
  const tokenizedMap = new Map();
  for (const msg of messages) {
    tokenizedMap.set(msg.id, tokenize(getMessageText(msg)));
  }

  // ── 1. Token count (total across all messages) ─────────────────────────────
  const tokenCount = messages.reduce(
    (sum, msg) => sum + countTokens(getMessageText(msg)),
    0
  );

  // ── 2. Staleness detection (consuming pre-tokenized maps) ──────────────────
  const { stalenessPercent, staleMessageIds } = computeStaleness(messages, tokenizedMap);

  // ── 3. Duplicate detection (consuming pre-tokenized maps) ──────────────────
  const duplicateWarnings = findDuplicates(messages, tokenizedMap);

  // ── 4. Projected savings ───────────────────────────────────────────────────
  // Collect unique message IDs that should be purged
  // (stale OR flagged as a duplicate of an earlier message)
  const duplicateIds = new Set(duplicateWarnings.map(w => w.messageId));
  const staleSet     = new Set(staleMessageIds);
  const purgeSet     = new Set([...staleSet, ...duplicateIds]);

  const projectedSavings = messages.reduce((sum, msg) => {
    if (purgeSet.has(msg.id)) {
      return sum + countTokens(getMessageText(msg));
    }
    return sum;
  }, 0);

  return {
    tokenCount,
    stalenessPercent,
    duplicateWarnings,
    projectedSavings,
    staleMessageIds,
  };
}
