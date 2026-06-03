/**
 * Decruft — Purge Bridge Script (src/purge-bridge.js)
 * ═════════════════════════════════════════════════════
 * NON-MODULE content-script glue layer.
 *
 * Problem this file solves:
 *   content.js is a plain IIFE (non-module) script injected at document_idle.
 *   It cannot `import` ES modules, but it CAN load additional plain scripts.
 *   purge.js is an ES Module with the critical distillation logic.
 *   background.js CAN import ES modules (it is declared type:module in manifest).
 *
 *   This bridge sits between the widget's postMessage events and background.js:
 *
 *     widget.js ──postMessage──► purge-bridge.js ──chrome.runtime.sendMessage──► background.js
 *
 * Responsibilities:
 *   1. Listen for { source: 'decruft-widget', type: 'EXECUTE_PURGE' } on window.
 *   2. Read the current conversation state from the content script (via
 *      window.__decruft_state which content.js populates).
 *   3. Call distillMessages + formatContextPrompt (loaded via the module
 *      worker approach — see note below).
 *   4. Send { type: 'PURGE_CONTEXT', payload: { distilledMessages, contextText,
 *      tokensSaved } } to background.js via chrome.runtime.sendMessage.
 *   5. On error, post an error event back to the widget so it can surface
 *      a user-friendly message in the modal without touching the original chat.
 *
 * Module access strategy:
 *   Because this script is injected as a plain <script> tag (not type=module),
 *   it cannot use top-level `import`. Instead it delegates all ES Module work
 *   to background.js, which already imports purge.js. The bridge sends the
 *   raw messages + analysisResult to the background, which calls distill/format
 *   and returns the result. See PURGE_CONTEXT handler in background.js.
 *
 *   If you prefer to run purge logic in the content world instead of the
 *   background, swap this to a dynamic import('<extension-url>/src/purge.js')
 *   and call the functions directly — the trade-off is an extra module fetch on
 *   first use versus one extra IPC round-trip per purge.
 *
 * ─── Safety guarantee ──────────────────────────────────────────────────────
 *   This script NEVER reads, writes, or dispatches events that could alter
 *   the existing Claude conversation DOM.  It is purely a messaging relay.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * State contract with content.js:
 *   content.js must keep `window.__decruft_state` current after every analysis:
 *
 *   window.__decruft_state = {
 *     messages:       object[],  // latest snapshotted messages array
 *     analysisResult: object,    // latest output of analyzeConversation()
 *   };
 *
 *   If the property is absent (e.g. analysis hasn't run yet) the bridge falls
 *   back gracefully by sending an empty distilled set and surfacing an error.
 */

(function decruftPurgeBridge() {
  'use strict';

  // ── 0. DUPLICATE-LOAD GUARD ───────────────────────────────────────────────
  // Prevent double-registration if content.js re-injects this script on
  // SPA navigation (same window lifetime, new conversation).
  if (window.__decruft_bridge_loaded) {
    console.debug('[Decruft Bridge] Already loaded — skipping re-init.');
    return;
  }
  window.__decruft_bridge_loaded = true;

  console.debug('[Decruft Bridge] Purge bridge initialised.');

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Attempt to read the current Decruft state that content.js maintains.
   * Returns a best-effort object; callers must handle missing fields.
   *
   * @returns {{ messages: object[], analysisResult: object }}
   */
  function readContentState() {
    const state = window.__decruft_state;
    if (!state || typeof state !== 'object') {
      console.warn('[Decruft Bridge] window.__decruft_state not found — analysis may not have run yet.');
      return { messages: [], analysisResult: null };
    }
    return {
      messages:       Array.isArray(state.messages)       ? state.messages       : [],
      analysisResult: state.analysisResult != null        ? state.analysisResult : null,
    };
  }

  /**
   * Post a PURGE_ERROR event back to the widget via window.postMessage.
   * The widget can listen for this to surface a non-destructive error message.
   *
   * @param {string} errorMessage
   */
  function notifyWidgetOfError(errorMessage) {
    window.postMessage(
      {
        source: 'decruft',
        type:   'PURGE_ERROR',
        error:  errorMessage,
      },
      '*' // Same-origin, widget is on the same tab page
    );
  }

  /**
   * Send the distilled messages and formatted context to background.js.
   * The background.js handlePurgeContext() will:
   *   1. Persist the distilled context.
   *   2. Increment stats.
   *   3. Send OPEN_NEW_CHAT to content.js with contextText.
   *
   * @param {object[]} distilledMessages  - Kept messages (from distillMessages).
   * @param {string}   contextText        - Formatted prompt (from formatContextPrompt).
   * @param {number}   tokensSaved        - Estimated token savings.
   */
  function dispatchToPurgeContext(distilledMessages, contextText, tokensSaved) {
    try {
      chrome.runtime.sendMessage(
        {
          type:    'PURGE_CONTEXT',
          payload: {
            distilledMessages,
            contextText,
            tokensSaved,
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message;
            console.error('[Decruft Bridge] PURGE_CONTEXT sendMessage error:', msg);
            notifyWidgetOfError(
              `Failed to communicate with background service worker: ${msg}. ` +
              'Please try again or reload the page.'
            );
            return;
          }

          if (response?.status === 'error') {
            console.error('[Decruft Bridge] Background reported PURGE_CONTEXT error:', response.error);
            notifyWidgetOfError(
              `Purge failed in background: ${response.error}. ` +
              'Your original chat has NOT been modified.'
            );
            return;
          }

          console.debug('[Decruft Bridge] PURGE_CONTEXT acknowledged. Status:', response?.status);
          // Success — background will send OPEN_NEW_CHAT to content.js
          // which handles the actual DOM interaction (clicking New Chat,
          // injecting text). This bridge's job is done.
        }
      );
    } catch (err) {
      // chrome.runtime.sendMessage can throw synchronously if the extension
      // context has been invalidated (e.g. extension update mid-session).
      console.error('[Decruft Bridge] chrome.runtime.sendMessage threw:', err);
      notifyWidgetOfError(
        'Extension context error — please reload the page and try again. ' +
        'Your original chat has NOT been modified.'
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Purge execution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * executePurge
   * ────────────
   * Orchestrates the full purge flow when the user clicks "Accept & Branch":
   *
   *   1. Read current messages + analysisResult from window.__decruft_state.
   *   2. Request the background to distill + format (via PURGE_CONTEXT message
   *      which background.js handles using its imported purge.js functions).
   *   3. Background.js will respond with OPEN_NEW_CHAT once it has persisted
   *      the context — content.js then handles the DOM navigation.
   *
   * If distilledMessages are already provided by the widget (widget.js sends
   * them in the EXECUTE_PURGE payload), we skip re-distilling and send them
   * directly.  This means the modal preview and the actual inject are exactly
   * consistent.
   *
   * @param {object[]} [widgetDistilledMessages]  - Pre-distilled from widget, if any.
   */
  function executePurge(widgetDistilledMessages) {
    // ── Read content state ──────────────────────────────────────────────────
    const { messages, analysisResult } = readContentState();

    // ── Determine which messages to keep ───────────────────────────────────
    //
    //  Preference chain (most reliable → fallback):
    //   A) widgetDistilledMessages provided → use them (already computed for modal)
    //   B) Re-distill locally using content state
    //
    // We always prefer (A) because the widget computed the distilled set when
    // building the preview, so what the user saw in the modal matches what we inject.
    let distilledMessages = widgetDistilledMessages;
    let tokensSaved = 0;

    // Try to retrieve pre-calculated purgeData from the background's analysis result
    const purgeData = analysisResult?.purgeData;

    if (Array.isArray(distilledMessages) && distilledMessages.length > 0) {
      console.debug(
        '[Decruft Bridge] Using widget-supplied distilled messages:',
        distilledMessages.length, '/', messages.length
      );
      tokensSaved = typeof purgeData?.savingsTokens === 'number'
        ? purgeData.savingsTokens
        : (typeof analysisResult?.projectedSavings === 'number' ? analysisResult.projectedSavings : 0);
    } else if (purgeData?.distilledMessages) {
      console.debug(
        '[Decruft Bridge] Using pre-distilled messages from background analysis:',
        purgeData.distilledMessages.length, '/', messages.length
      );
      distilledMessages = purgeData.distilledMessages;
      tokensSaved = purgeData.savingsTokens ?? 0;
    } else {
      console.debug(
        '[Decruft Bridge] Falling back to all messages, letting background distill.',
        messages.length, 'messages'
      );
      distilledMessages = messages;
      tokensSaved = typeof analysisResult?.projectedSavings === 'number'
        ? analysisResult.projectedSavings
        : 0;
    }

    // ── Validate: prevent sending if there's nothing to work with ──────────
    if (!distilledMessages || distilledMessages.length === 0) {
      console.warn('[Decruft Bridge] No messages to purge — aborting.');
      notifyWidgetOfError(
        'No conversation messages found. Please wait for the page to fully load.'
      );
      return;
    }

    // ── Dispatch to background ─────────────────────────────────────────────
    // Let background.js handle the formatting using the canonical formatContextPrompt ES module function
    dispatchToPurgeContext(distilledMessages, '', tokensSaved);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // postMessage listener
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Window message listener.
   * Responds to EXECUTE_PURGE sent by widget.js when user clicks "Accept & Branch".
   *
   * Expected shape:
   *   {
   *     source: 'decruft-widget',
   *     type:   'EXECUTE_PURGE',
   *     data:   { distilledMessages: object[] }
   *   }
   *
   * Security: we validate both `source` and `event.source === window` to prevent
   * cross-origin frames from triggering a purge.
   */
  window.addEventListener('message', (event) => {
    // Ensure the message is from THIS window (not an iframe or foreign origin)
    if (event.source !== window) return;

    // Validate Decruft widget identity
    if (!event.data || event.data.source !== 'decruft-widget') return;

    const { type, data } = event.data;

    if (type !== 'EXECUTE_PURGE') return;

    console.debug('[Decruft Bridge] EXECUTE_PURGE received from widget.', {
      distilledCount: data?.distilledMessages?.length ?? 0,
    });

    // Extract the pre-distilled messages the widget computed for modal preview.
    // These are guaranteed to be the same set the user saw in the modal.
    const widgetDistilledMessages = Array.isArray(data?.distilledMessages)
      ? data.distilledMessages
      : [];

    // Run the purge — fully async, non-blocking, never touches original DOM
    executePurge(widgetDistilledMessages);
  });

  console.debug('[Decruft Bridge] postMessage listener registered.');

})(); // end decruftPurgeBridge IIFE
