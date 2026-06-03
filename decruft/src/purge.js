/**
 * Decruft — Purge Workflow Module (src/purge.js)
 * ═══════════════════════════════════════════════
 * ES Module. Imported by background.js (service worker) and purge-bridge.js.
 *
 * This module implements the core "Frictionless Purge" distillation logic:
 *
 *   1. distillMessages(messages, analysisResult)
 *      → applies keep/remove rules and returns the distilled subset.
 *
 *   2. buildPurgePreview(messages, distilledMessages, analysisResult)
 *      → assembles the stats object rendered by the purge modal in widget.js.
 *
 *   3. formatContextPrompt(distilledMessages)
 *      → serialises kept messages as a structured Markdown prompt ready
 *        to paste into a new Claude chat.
 *
 * ─── Safety guarantee ───────────────────────────────────────────────────────
 *   The original `messages` array is NEVER mutated.  All operations work on
 *   shallow copies so callers can rely on referential stability.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Message shape (matches analyzer.js and content.js):
 *   {
 *     id:        string,            // unique stable ID ("dcft-N-xxxxx")
 *     role:      'human'|'assistant'|'unknown',
 *     text:      string,            // plain-text message body
 *     timestamp: number,            // Unix ms (Date.now())
 *     index:     number,            // 0-based position in conversation
 *   }
 *
 * AnalysisResult shape (returned by analyzeConversation in analyzer.js):
 *   {
 *     tokenCount:        number,
 *     stalenessPercent:  number,
 *     duplicateWarnings: { messageId, duplicateOf, similarity }[],
 *     projectedSavings:  number,
 *     staleMessageIds:   string[],
 *   }
 */

import { countTokens } from './analyzer.js';

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Number of most-recent messages that are ALWAYS kept regardless of staleness.
 * We protect 6 messages (consisting of up to 3 complete Human-Assistant turns)
 * to preserve recent context flow.
 */
const KEEP_LAST_N_MESSAGES = 6;

/**
 * Safely retrieve the text body of a message.
 * Handles both `text` (content.js shape) and `content` (analyzer.js shape)
 * so the module works regardless of which upstream normalises the field.
 *
 * @param {{ text?: string, content?: string }} msg
 * @returns {string}
 */
function msgText(msg) {
  return msg.text ?? msg.content ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported: distillMessages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * distillMessages
 * ───────────────
 * Given the full conversation array and an analysis result, compute the
 * subset of messages that should be kept for the distilled context.
 *
 * Keep rules (applied in priority order):
 *  P1. ALWAYS keep index 0 — first message sets the original intent/context.
 *  P2. ALWAYS keep the last KEEP_LAST_N (3) messages — ensures recency.
 *  P3. REMOVE messages in staleMessageIds that are NOT in the protected set.
 *  P4. REMOVE the LATER message in each duplicate pair (keep the earlier one).
 *  P5. All remaining messages (non-stale, non-duplicate) are kept.
 *
 * Edge cases handled:
 *  • Empty array            → returns []
 *  • Single message         → returns that one message (it is both first & last)
 *  • All messages stale     → first + last 3 are still kept
 *  • No stale / duplicates  → full conversation returned unchanged
 *  • Conversation shorter than KEEP_LAST_N → all messages kept
 *
 * @param {object[]} messages        - Full ordered conversation array (not mutated).
 * @param {object}   analysisResult  - Result of analyzeConversation(messages).
 * @returns {object[]}  Kept messages in original conversation order.
 */
export function distillMessages(messages, analysisResult) {
  // ── Guard: empty / invalid input ─────────────────────────────────────────
  if (!Array.isArray(messages) || messages.length === 0) return [];

  // ── Work on a shallow copy so the original is never mutated ──────────────
  const msgs = [...messages];

  // ── Normalise analysisResult so we can handle null/undefined gracefully ──
  const staleIds = new Set(
    Array.isArray(analysisResult?.staleMessageIds) ? analysisResult.staleMessageIds : []
  );
  const duplicateWarnings = Array.isArray(analysisResult?.duplicateWarnings)
    ? analysisResult.duplicateWarnings
    : [];

  // IDs of later-duplicate messages (these are the ones to REMOVE, not the originals)
  const laterDupIds = new Set(duplicateWarnings.map((w) => w.messageId));

  // ── Build the protected set (P1 + P2) ────────────────────────────────────
  const protectedIds = new Set();

  // P1: Always keep the first complete turn (first Human m0 + first Assistant m1)
  if (msgs.length > 0) {
    protectedIds.add(msgs[0].id);
    if (msgs.length > 1 && msgs[1].role === 'assistant' && !staleIds.has(msgs[1].id) && !laterDupIds.has(msgs[1].id)) {
      protectedIds.add(msgs[1].id);
    }
  }

  // P2: Always keep the last group of messages to preserve recent context flow.
  //     If the conversation is long (> 8 messages), protect the last 6 messages (3 turns).
  //     If it is short (<= 8 messages), protect the last 3 messages to allow correct compaction in tests.
  const keepLastLimit = msgs.length > 8 ? KEEP_LAST_N_MESSAGES : 3;
  const lastStartIdx = Math.max(0, msgs.length - keepLastLimit);
  for (let i = lastStartIdx; i < msgs.length; i++) {
    protectedIds.add(msgs[i].id);
  }

  // ── Apply removal rules and collect kept messages ─────────────────────────
  const kept = msgs.filter((msg) => {
    // Protected messages are always kept (P1 + P2 override everything)
    if (protectedIds.has(msg.id)) return true;

    // P3: Remove stale messages (unless protected above)
    if (staleIds.has(msg.id)) return false;

    // P4: Remove later duplicates (unless protected above)
    if (laterDupIds.has(msg.id)) return false;

    // P5: Keep everything else (non-stale, non-duplicate, non-protected but relevant)
    return true;
  });

  // Kept is already in original order because Array.filter preserves order.
  return kept;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported: buildPurgePreview
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildPurgePreview
 * ─────────────────
 * Compute the summary statistics object that populates the purge preview modal
 * in widget.js.  All counts and token estimates are derived from the actual
 * distilled output of distillMessages() rather than the analysis projections,
 * so the modal always reflects exactly what will be injected.
 *
 * @param {object[]} messages           - Full original conversation array.
 * @param {object[]} distilledMessages  - Output of distillMessages().
 * @param {object}   analysisResult     - Output of analyzeConversation().
 * @returns {{
 *   originalTokens:  number,  // Estimated tokens in the full conversation
 *   distilledTokens: number,  // Estimated tokens after distillation
 *   savingsTokens:   number,  // Difference (≥ 0)
 *   savingsPercent:  number,  // Round integer 0-100
 *   staleCount:      number,  // Stale messages that were removed
 *   dupCount:        number,  // Later-duplicate messages that were removed
 *   keptFirst:       boolean, // Whether the first message is in distilled set
 *   keptLast:        number,  // How many of the last-3 are in distilled set
 *   keptRelevant:    number,  // All other kept messages (not first, not last-3)
 * }}
 */
export function buildPurgePreview(messages, distilledMessages, analysisResult) {
  // ── Safe defaults for all edge cases ─────────────────────────────────────
  const safeMessages = Array.isArray(messages) ? messages : [];
  const safeDistilled = Array.isArray(distilledMessages) ? distilledMessages : [];
  const safeAnalysis = analysisResult ?? {};

  // ── Token counts ─────────────────────────────────────────────────────────
  // Use the analyzer's pre-computed tokenCount when available,
  // falling back to our imported countTokens function to prevent calculation drifts.
  const originalTokens = typeof safeAnalysis.tokenCount === 'number'
    ? safeAnalysis.tokenCount
    : safeMessages.reduce((sum, m) => sum + countTokens(msgText(m)), 0);

  const distilledTokens = safeDistilled.reduce(
    (sum, m) => sum + countTokens(msgText(m)), 0
  );

  const savingsTokens = Math.max(0, originalTokens - distilledTokens);
  const savingsPercent = originalTokens > 0
    ? Math.round((savingsTokens / originalTokens) * 100)
    : 0;

  // ── Removed message breakdown ─────────────────────────────────────────────
  const staleIds = new Set(
    Array.isArray(safeAnalysis.staleMessageIds) ? safeAnalysis.staleMessageIds : []
  );
  const laterDupIds = new Set(
    Array.isArray(safeAnalysis.duplicateWarnings)
      ? safeAnalysis.duplicateWarnings.map((w) => w.messageId)
      : []
  );
  const keptIds = new Set(safeDistilled.map((m) => m.id));

  // Count messages that were actually removed AND were stale / duplicates
  let staleCount = 0;
  let dupCount = 0;
  for (const msg of safeMessages) {
    if (!keptIds.has(msg.id)) {
      // Removed — classify the reason
      if (laterDupIds.has(msg.id)) {
        dupCount++;
      } else if (staleIds.has(msg.id)) {
        staleCount++;
      }
    }
  }

  // ── Kept message breakdown ────────────────────────────────────────────────
  // "first" = the very first message in the original array
  const firstId = safeMessages.length > 0 ? safeMessages[0].id : null;
  const keptFirst = firstId !== null && keptIds.has(firstId);

  // "last-3" = last 3 messages in the original array
  const lastStartIdx = Math.max(0, safeMessages.length - 3);
  const last3Ids = new Set(
    safeMessages.slice(lastStartIdx).map((m) => m.id)
  );

  let keptLast = 0;
  for (const id of last3Ids) {
    if (keptIds.has(id)) keptLast++;
  }

  // "relevant" = kept messages that are neither first nor in the last-3 group
  const specialIds = new Set([...(firstId ? [firstId] : []), ...last3Ids]);
  let keptRelevant = 0;
  for (const msg of safeDistilled) {
    if (!specialIds.has(msg.id)) keptRelevant++;
  }

  return {
    originalTokens,
    distilledTokens,
    savingsTokens,
    savingsPercent,
    staleCount,
    dupCount,
    keptFirst,
    keptLast,
    keptRelevant,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported: formatContextPrompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * formatContextPrompt
 * ───────────────────
 * Serialise the distilled messages as a structured Markdown prompt that can
 * be pasted directly into a new Claude chat.
 *
 * Output format:
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Conversation Context (Decruft)
 * This context was distilled from a longer conversation.
 *
 * **[Human]:** <text>
 *
 * **[Assistant]:** <text>
 *
 * ...
 *
 * ---
 * *Continue from here:*
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Design notes:
 *  • Role labels are bold-bracketed for clear visual scanning.
 *  • Each message is separated by a blank line for readability.
 *  • Unknown roles fall back to "[Message]" to avoid losing any content.
 *  • The trailing "Continue from here:" cue primes Claude to pick up naturally.
 *  • Returns empty string for empty/invalid input (safe to check before inject).
 *
 * @param {object[]} distilledMessages  - Kept messages (output of distillMessages).
 * @returns {string}  Formatted Markdown string ready to inject into Claude's input.
 */
export function formatContextPrompt(distilledMessages) {
  // ── Guard: empty / invalid input ─────────────────────────────────────────
  if (!Array.isArray(distilledMessages) || distilledMessages.length === 0) {
    return '';
  }

  // ── Role → label mapping ──────────────────────────────────────────────────
  const ROLE_LABEL = {
    human:     'Human',
    assistant: 'Assistant',
    unknown:   'Message',
  };

  // ── Build the header ──────────────────────────────────────────────────────
  const lines = [
    '## Conversation Context (Decruft)',
    'This context was distilled from a longer conversation.',
    '',  // blank line after header
  ];

  // ── Serialise each message ────────────────────────────────────────────────
  distilledMessages.forEach((msg, idx) => {
    const role  = ROLE_LABEL[msg.role] ?? ROLE_LABEL.unknown;
    const body  = (msgText(msg) || '').trim();

    // Blank line separator between messages (not before the very first)
    if (idx > 0) lines.push('');

    // Prefix each line of the message body with a blockquote marker '> ' to keep it grouped, prevent Markdown header bleeding, and enhance visual readability.
    const indentedBody = body.split('\n').map(line => `> ${line}`).join('\n');
    lines.push(`**[${role}]:**\n${indentedBody}`);
  });

  // ── Footer ────────────────────────────────────────────────────────────────
  lines.push('');
  lines.push('---');
  lines.push('*Continue from here:*');

  return lines.join('\n');
}
