/**
 * Decruft — Service Worker (src/background.js)
 * ══════════════════════════════════════════════
 * Manifest V3 background service worker — the coordination hub of Decruft.
 *
 * Responsibilities:
 *  1. Load and cache config/selectors.json (web-accessible resource)
 *  2. Respond to GET_SELECTORS messages from content scripts
 *  3. Run NLP analysis via analyzer.js on ANALYZE_MESSAGES requests
 *  4. Update the extension badge to reflect staleness state
 *  5. Persist cumulative stats (tokens saved, purge count) in chrome.storage
 *  6. Handle PURGE_CONTEXT — store distilled messages and open a new chat
 *
 * This is a type:module service worker; ES-import syntax is fully supported.
 *
 * ⚠ Zero user-data network calls — all analysis is done locally.
 */

import {
  analyzeConversation,
} from './analyzer.js';

import {
  distillMessages,
  buildPurgePreview,
  formatContextPrompt,
} from './purge.js';

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default stats shape written on first install. */
const DEFAULT_STATS = {
  totalTokensSaved: 0,
  purgeCount:       0,
  lastPurgeDate:    null,  // ISO-8601 string or null
};

/** Badge colour thresholds (staleness %). */
const BADGE_COLOURS = [
  { max: 25,  colour: '#22c55e' },  // green
  { max: 50,  colour: '#eab308' },  // yellow
  { max: 75,  colour: '#f97316' },  // orange
  { max: 100, colour: '#ef4444' },  // red
];

// ─────────────────────────────────────────────────────────────────────────────
// In-memory selector cache
// Populated on first GET_SELECTORS; cleared when the service worker restarts
// (which is fine — it will just re-fetch from the bundled JSON).
// ─────────────────────────────────────────────────────────────────────────────
let _selectorsCache = null;

/** Promise-based lock to serialize stats read-modify-write operations. */
let _statsLockPromise = Promise.resolve();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the staleness percentage to a badge background colour.
 *
 * @param {number} stalenessPercent  0-100
 * @returns {string}  Hex colour string
 */
function getBadgeColour(stalenessPercent) {
  for (const { max, colour } of BADGE_COLOURS) {
    if (stalenessPercent <= max) return colour;
  }
  return BADGE_COLOURS[BADGE_COLOURS.length - 1].colour; // fallback: red
}

/**
 * Read (and cache) config/selectors.json from the extension bundle.
 * Uses fetch with chrome.runtime.getURL so we never hit the network.
 *
 * @returns {Promise<object>}  Parsed selectors object
 */
async function loadSelectors() {
  if (_selectorsCache) return _selectorsCache;

  const url = chrome.runtime.getURL('config/selectors.json');
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`[Decruft BG] Failed to load selectors.json — HTTP ${response.status}`);
  }

  _selectorsCache = await response.json();
  console.debug('[Decruft BG] Selectors loaded and cached:', _selectorsCache);
  return _selectorsCache;
}

/**
 * Read the flat persisted stats from chrome.storage.local.
 * Falls back to DEFAULT_STATS values if nothing is stored yet.
 *
 * @returns {Promise<object>}
 */
async function readStats() {
  const keys = ['totalTokensSaved', 'purgeCount', 'lastPurgeDate'];
  const result = await chrome.storage.local.get(keys);
  return {
    totalTokensSaved: result.totalTokensSaved ?? DEFAULT_STATS.totalTokensSaved,
    purgeCount:       result.purgeCount ?? DEFAULT_STATS.purgeCount,
    lastPurgeDate:    result.lastPurgeDate ?? DEFAULT_STATS.lastPurgeDate,
  };
}

/**
 * Write updated flat stats back to chrome.storage.local.
 *
 * @param {object} stats
 * @returns {Promise<void>}
 */
async function writeStats(stats) {
  await chrome.storage.local.set({
    totalTokensSaved: stats.totalTokensSaved,
    purgeCount:       stats.purgeCount,
    lastPurgeDate:    stats.lastPurgeDate,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle GET_SELECTORS — returns the full parsed selectors.json to the caller.
 *
 * @returns {Promise<{ status: string, selectors: object }>}
 */
async function handleGetSelectors() {
  try {
    const selectors = await loadSelectors();
    return { status: 'ok', selectors };
  } catch (err) {
    console.error('[Decruft BG] GET_SELECTORS error:', err);
    return { status: 'error', error: err.message, selectors: null };
  }
}

/**
 * Handle ANALYZE_MESSAGES — run the full NLP pipeline on the provided messages
 * and return the analysis result to the originating content-script tab.
 *
 * @param {{ messages: object[] }}  payload
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<{ type: string, data: object }>}
 */
async function handleAnalyzeMessages(message, sender) {
  const messages = message?.payload?.messages ?? [];

  try {
    const result = analyzeConversation(messages);

    // Calculate pre-distilled messages and preview stats for the widget
    let purgeData = null;
    if (messages.length > 0) {
      try {
        const distilled = distillMessages(messages, result);
        const preview = buildPurgePreview(messages, distilled, result);
        purgeData = {
          ...preview,
          distilledMessages: distilled
        };
      } catch (purgeErr) {
        console.warn('[Decruft BG] Failed to pre-calculate purgeData (non-fatal):', purgeErr);
      }
    }

    const dataWithPurge = {
      ...result,
      purgeData
    };

    console.debug(
      '[Decruft BG] Analysis complete — tokens:', result.tokenCount,
      '| staleness:', result.stalenessPercent + '%',
      '| duplicates:', result.duplicateWarnings.length,
      '| savings:', result.projectedSavings
    );

    // Automatically update the badge for the originating tab
    if (sender.tab?.id) {
      try {
        await updateBadgeForTab(sender.tab.id, result.stalenessPercent);
      } catch (badgeErr) {
        console.warn('[Decruft BG] Failed to update badge for tab (non-fatal):', badgeErr);
      }
    }

    return { type: 'ANALYSIS_RESULT', data: dataWithPurge };
  } catch (err) {
    console.error('[Decruft BG] ANALYZE_MESSAGES error:', err);
    return { type: 'ANALYSIS_ERROR', error: err.message };
  }
}

/**
 * Update the action badge for a specific tab.
 *
 * @param {number} tabId
 * @param {number} stalenessPercent  0-100
 * @returns {Promise<void>}
 */
async function updateBadgeForTab(tabId, stalenessPercent) {
  const text   = stalenessPercent > 0 ? `${stalenessPercent}%` : '';
  const colour = getBadgeColour(stalenessPercent);

  await Promise.all([
    chrome.action.setBadgeText({ text, tabId }),
    chrome.action.setBadgeBackgroundColor({ color: colour, tabId }),
  ]);
}

/**
 * Handle UPDATE_BADGE — explicit badge update request from the content script.
 * Useful when the popup or widget wants to refresh the badge independently.
 *
 * @param {object} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<{ status: string }>}
 */
async function handleUpdateBadge(message, sender) {
  const payload = message?.payload ?? message ?? {};
  const { stalenessPercent = 0 } = payload;

  try {
    if (sender.tab?.id) {
      await updateBadgeForTab(sender.tab.id, stalenessPercent);
    } else {
      // Fallback: update badge globally (no tab-specific scoping)
      const text   = stalenessPercent > 0 ? `${stalenessPercent}%` : '';
      const colour = getBadgeColour(stalenessPercent);
      await chrome.action.setBadgeText({ text });
      await chrome.action.setBadgeBackgroundColor({ color: colour });
    }
    return { status: 'ok' };
  } catch (err) {
    console.error('[Decruft BG] UPDATE_BADGE error:', err);
    return { status: 'error', error: err.message };
  }
}

/**
 * Handle PURGE_CONTEXT:
 *  1. Persist the distilled / summarised messages in chrome.storage.local
 *     so the content script can pre-seed the new chat if needed.
 *  2. Increment purge stats (totalTokensSaved, purgeCount, lastPurgeDate).
 *  3. Send OPEN_NEW_CHAT back to the content script in the originating tab.
 *
 * @param {object} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<{ status: string }>}
 */
async function handlePurgeContext(message, sender) {
  const payload = message?.payload ?? message ?? {};
  const {
    distilledMessages: rawDistilled = [],
    contextText: preFormattedContext = '',
    tokensSaved = 0,
  } = payload;

  try {
    let distilledMessages = rawDistilled;
    let contextText = preFormattedContext;

    // Fallback: If no pre-distilled prompt is provided but raw messages are sent,
    // execute context distillation on the background service worker context.
    const rawMessages = payload.messages ?? payload.payload?.messages ?? [];
    if (!contextText && distilledMessages.length === 0 && rawMessages.length > 0) {
      console.debug('[Decruft BG] Fallback: distilling raw messages on the background side...');
      const rawAnalysis = payload.analysisResult ?? payload.payload?.analysisResult ?? analyzeConversation(rawMessages);
      distilledMessages = distillMessages(rawMessages, rawAnalysis);
      contextText = formatContextPrompt(distilledMessages);
    } else if (!contextText && distilledMessages.length > 0) {
      contextText = formatContextPrompt(distilledMessages);
    }

    // ── Persist distilled context ───────────────────────────────────────
    await chrome.storage.local.set({
      decruft_distilled: {
        messages:  distilledMessages,
        savedAt:   new Date().toISOString(),
        tokensSaved,
      },
    });

    // ── Update cumulative stats atomically via serialization lock ──────────
    let stats;
    await (_statsLockPromise = (async () => {
      await _statsLockPromise.catch(() => {}); // Wait for any active write to finish
      stats = await readStats();
      stats.totalTokensSaved += tokensSaved;
      stats.purgeCount       += 1;
      stats.lastPurgeDate     = new Date().toISOString();
      await writeStats(stats);
    })());

    console.debug(
      '[Decruft BG] Purge complete — lifetime savings:',
      stats.totalTokensSaved, 'tokens |',
      stats.purgeCount, 'purge(s)'
    );

    // ── Instruct the content script to open a new chat ─────────────────────
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      chrome.tabs.sendMessage(
        tabId,
        { type: 'OPEN_NEW_CHAT', payload: { contextText } },
        () => {
          // Ignore "no listener" errors that can occur if the content script
          // has navigated away before this message lands.
          void chrome.runtime.lastError;
        }
      );
    }

    return { status: 'ok', stats };
  } catch (err) {
    console.error('[Decruft BG] PURGE_CONTEXT error:', err);
    return { status: 'error', error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Router
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Central message listener. All messages from content scripts, the popup,
 * or other extension pages arrive here.
 *
 * Returning `true` from the listener tells Chrome to keep the message channel
 * open while we resolve the async handler; this is required for MV3.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.debug(
    '[Decruft BG] Message received:', message.type,
    '| tab:', sender.tab?.id ?? 'popup/extension'
  );

  // Dispatch to the appropriate async handler and pipe its return value
  // back through sendResponse once the Promise resolves.
  let handlerPromise;

  switch (message.type) {
    case 'GET_SELECTORS':
      handlerPromise = handleGetSelectors();
      break;

    case 'ANALYZE_MESSAGES':
      handlerPromise = handleAnalyzeMessages(message, sender);
      break;

    case 'UPDATE_BADGE':
      handlerPromise = handleUpdateBadge(message, sender);
      break;

    case 'PURGE_CONTEXT':
      handlerPromise = handlePurgeContext(message, sender);
      break;

    default:
      // Unknown message type — respond immediately, no async needed
      sendResponse({ status: 'unknown_message_type', type: message.type });
      return false;
  }

  // Resolve the promise and relay the result
  handlerPromise
    .then(sendResponse)
    .catch(err => {
      console.error('[Decruft BG] Unhandled handler error:', err);
      sendResponse({ status: 'error', error: String(err) });
    });

  // Return true to signal async sendResponse
  return true;
});

// ─────────────────────────────────────────────────────────────────────────────
// Install / Update Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  console.debug('[Decruft BG] onInstalled — reason:', reason);

  if (reason === 'install') {
    // First install: write default stats so popup.js always has something to read
    await writeStats({ ...DEFAULT_STATS });
    console.debug('[Decruft BG] Default stats initialised.');

    // Pre-warm the selector cache to speed up the first content-script call
    try {
      await loadSelectors();
    } catch (err) {
      console.warn('[Decruft BG] Selector pre-warm failed (non-fatal):', err);
    }
  }

  if (reason === 'update') {
    // Preserve existing stats across extension updates — only add missing keys
    const existing = await readStats();
    const merged   = { ...DEFAULT_STATS, ...existing };
    await writeStats(merged);
    console.debug('[Decruft BG] Stats migrated after update.');
  }
});
