/**
 * Decruft — Content Script (src/content.js)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Injected into every claude.ai page at document_idle (MV3, non-module).
 *
 * Architecture overview:
 *  ┌─────────────────────────────────────────────────────────────────────────┐
 *  │  claude.ai page                                                         │
 *  │  ┌──────────────────────────────────────────────────────────────────┐  │
 *  │  │  content.js  (this file)                                         │  │
 *  │  │   • Loads selectors from background via GET_SELECTORS            │  │
 *  │  │   • MutationObserver watches message container                   │  │
 *  │  │   • Extracts {id,role,text,timestamp,index} per message          │  │
 *  │  │   • Debounced ANALYZE_MESSAGES → background                      │  │
 *  │  │   • Injects widget.js + widget.css as <script>/<link>            │  │
 *  │  │   • Bridges widget ↔ background via postMessage / sendMessage    │  │
 *  │  └──────────────────────────────────────────────────────────────────┘  │
 *  │         ↕ chrome.runtime.sendMessage / onMessage                       │
 *  │  ┌──────────────────────────────────────────────────────────────────┐  │
 *  │  │  background.js  (service worker)                                 │  │
 *  │  │   • GET_SELECTORS → responds with selectors.json contents        │  │
 *  │  │   • ANALYZE_MESSAGES → computes metrics, responds ANALYSIS_RESULT│  │
 *  │  │   • PURGE_CONTEXT → orchestrates /new navigation                 │  │
 *  │  └──────────────────────────────────────────────────────────────────┘  │
 *  └─────────────────────────────────────────────────────────────────────────┘
 *
 * @module decruft/content
 */

/* ─────────────────────────────────────────────────────────────────────────────
 * IIFE wrapper keeps everything out of the global scope and prevents collisions
 * on SPA re-renders that may re-inject this script.
 * ───────────────────────────────────────────────────────────────────────────── */
(function decruftContent() {
  'use strict';

  // ── 0. HOSTNAME GUARD ────────────────────────────────────────────────────────
  // Only execute on claude.ai. This is the authoritative runtime check;
  // manifest.json host_permissions acts as the first layer of defence.
  if (window.location.hostname !== 'claude.ai') return;

  // ── 0a. DUPLICATE-INJECTION GUARD ───────────────────────────────────────────
  // SPA navigations (pushState/replaceState) can cause the content script to
  // fire more than once within a single tab lifetime.  The flag persists
  // across navigations because it lives on `window`, which survives soft-navs.
  // In unpacked extension reload scenario, we run teardown to discard zombie script elements.
  if (typeof window.__decruft_destroy === 'function') {
    try {
      window.__decruft_destroy();
    } catch (err) {
      console.warn('[Decruft] Error during teardown of previous content script instance:', err);
    }
  }
  window.__decruft_loaded = true;

  console.debug('[Decruft] Content script initialised on', location.href);

  // ── 1. MODULE-LEVEL STATE ────────────────────────────────────────────────────

  /**
   * Cached copy of the selectors from config/selectors.json, populated on init.
   * Shape mirrors the "claude" key from selectors.json.
   * @type {Object|null}
   */
  let selectors = null;

  /**
   * Ordered array of all extracted messages in the current conversation.
   * Each element: { id: string, role: 'human'|'assistant', text: string,
   *                 timestamp: number, index: number }
   * @type {Array}
   */
  let messages = [];

  /**
   * The active MutationObserver instance for message container. Kept in module scope so it can
   * be disconnected cleanly during teardown / SPA re-routing.
   * @type {MutationObserver|null}
   */
  let observer = null;

  /**
   * Permanent body mutation observer that auto-detects container existence.
   * @type {MutationObserver|null}
   */
  let bodyObserver = null;

  /**
   * The active, observed message container element.
   * @type {Element|null}
   */
  let observedContainer = null;

  /**
   * Timer ID for the debounced ANALYZE_MESSAGES dispatch.
   * @type {number|null}
   */
  let analyzeDebounceTimer = null;

  /**
   * Timer ID for the new chat input polling loop.
   * @type {number|null}
   */
  let inputPollTimer = null;

  /**
   * Monotonically-increasing counter for stable message IDs within a session.
   * @type {number}
   */
  let messageCounter = 0;

  /**
   * The most recent analysis result from the background.
   * @type {Object|null}
   */
  let lastAnalysisResult = null;

  // Save references to original history functions so we can restore them in teardown
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  // ── 2. UTILITY HELPERS ───────────────────────────────────────────────────────

  /**
   * queryWithFallback
   * ─────────────────
   * Tries each CSS selector in `selectorArray` in order and returns the FIRST
   * non-null result.  This is the primary defence against Claude DOM churn —
   * when Anthropic ship a class-name update, the next selector in the list
   * catches it without requiring an extension update.
   *
   * @param {string[]} selectorArray  - Ordered list of CSS selectors to try.
   * @param {Element}  [root=document] - Scope the query to a sub-tree.
   * @returns {Element|null}  First matching element, or null if none match.
   */
  function queryWithFallback(selectorArray, root = document) {
    if (!Array.isArray(selectorArray)) return null;
    for (const selector of selectorArray) {
      try {
        const el = root.querySelector(selector);
        if (el) return el;
      } catch (err) {
        // Guard against malformed/unknown pseudo-classes in older Chromium builds
        console.warn('[Decruft] queryWithFallback: invalid selector:', selector, err);
      }
    }
    return null;
  }

  /**
   * queryAllWithFallback
   * ────────────────────
   * Like queryWithFallback but returns a NodeList/Array of ALL matches from
   * the first selector that yields results.
   *
   * @param {string[]} selectorArray
   * @param {Element}  [root=document]
   * @returns {Element[]}
   */
  function queryAllWithFallback(selectorArray, root = document) {
    if (!Array.isArray(selectorArray)) return [];
    for (const selector of selectorArray) {
      try {
        const els = Array.from(root.querySelectorAll(selector));
        if (els.length > 0) return els;
      } catch (err) {
        console.warn('[Decruft] queryAllWithFallback: invalid selector:', selector, err);
      }
    }
    return [];
  }

  /**
   * findMessageContainer
   * ────────────────────
   * Attempts to locate the message list scrolling viewport.
   * Leverages selector fallbacks, but actively prioritises dynamic contextual resolution:
   * if any user or assistant message bubble is found in the DOM, it finds its closest
   * scrolling ancestor containing `scrollbar-gutter` or `overflow-y-auto`.
   * This handles container selector shifts gracefully without updates.
   *
   * @param {Object} sel - The selectors configuration.
   * @returns {Element|null}
   */
  function findMessageContainer(sel) {
    if (!sel) return null;

    // 1. Dynamic Turn-Based Ancestor Resolution (Highest Accuracy)
    // We look for any visible user message or assistant message turn.
    const turnSelectors = [
      "[data-testid='user-message']",
      ".font-user-message",
      "[data-testid='message-human']",
      "[data-testid='human-turn']",
      ".human-turn",
      "[class*='human']",
      "[class*='user-message']",
      ".font-claude-response",
      ".font-claude-message",
      "[data-testid='message-assistant']",
      "[data-testid='ai-turn']",
      ".assistant-turn",
      "[class*='assistant']",
      "[class*='claude-message']"
    ];

    for (const ts of turnSelectors) {
      try {
        const turn = document.querySelector(ts);
        if (turn) {
          // Find the closest scrolling container
          // Specifically, look for scrollbar-gutter first, then overflow-y-auto, then falling back to generic containers.
          const container = turn.closest("div[class*='scrollbar-gutter']") ||
                            turn.closest("div.overflow-y-auto") ||
                            turn.closest("div[class*='overflow-y-auto']") ||
                            turn.closest("main .flex-col");
          if (container) {
            console.debug('[Decruft] Dynamic container resolution succeeded via turn:', ts);
            return container;
          }
        }
      } catch (err) {
        // Skip invalid/unsupported selectors
      }
    }

    // 2. Fall back to static CSS selector queries
    return queryWithFallback(sel.messageContainer);
  }

  /**
   * extractPlainText
   * ────────────────
   * Given a DOM element, returns its inner text with HTML stripped and
   * consecutive whitespace collapsed.  Preserves paragraph breaks as newlines.
   *
   * @param {Element} el
   * @returns {string}
   */
  function extractPlainText(el) {
    if (!el) return '';
    // innerText respects CSS visibility and block elements → natural newlines
    const raw = el.innerText || el.textContent || '';
    // Collapse runs of 3+ newlines to 2, trim outer whitespace
    return raw.replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * generateMessageId
   * ─────────────────
   * Produces a lightweight, collision-resistant ID for each scraped message.
   * Format: `dcft-<counter>-<timestamp-fragment>`
   *
   * @returns {string}
   */
  function generateMessageId() {
    return `dcft-${++messageCounter}-${Date.now().toString(36)}`;
  }

  // ── 3. SELECTOR LOADING ──────────────────────────────────────────────────────

  /**
   * loadSelectors
   * ─────────────
   * Requests the selectors config from the background service worker.
   * The background owns the canonical copy (loaded from config/selectors.json)
   * so it can be refreshed without reloading the content script.
   *
   * Calls `onReady` with the selectors object when successful.
   * Falls back to a hardcoded minimal set if the background returns nothing,
   * ensuring the extension degrades gracefully rather than going silent.
   *
   * @param {Function} onReady - Called with the `claude` selectors sub-object.
   */
  function loadSelectors(onReady) {
    // Minimal hardcoded fallback — keeps things working even if the background
    // service worker hasn't fully initialised yet (cold-start race condition).
    const FALLBACK_SELECTORS = {
      messageContainer: [
        "div[class*='scrollbar-gutter']:not(nav *)",
        "div.overflow-y-auto.overflow-x-hidden:not(nav *)",
        "div[class*='scrollbar-gutter']",
        "div.overflow-y-auto.overflow-x-hidden",
        "[data-testid='chat-messages']",
        '.conversation-content',
        'main .flex-col',
      ],
      humanMessage: [
        "[data-testid='user-message']",
        '.font-user-message',
        "[data-testid='message-human']",
        "[data-testid='human-turn']",
        '.human-turn',
        "[class*='human']",
        "[class*='user-message']",
      ],
      assistantMessage: [
        '.font-claude-message',
        '.font-claude-response',
        "[data-testid='message-assistant']",
        "[data-testid='ai-turn']",
        '.assistant-turn',
        "[class*='assistant']",
        "[class*='claude-message']",
      ],
      newChatButton: [
        "[data-testid='new-chat-button']",
        "a[href='/new']",
        "button[aria-label*='New chat']",
      ],
      inputBox: [
        "[data-testid='chat-input']",
        '.ProseMirror',
        "div[contenteditable='true']",
      ],
      sendButton: [
        "[data-testid='send-button']",
        "button[aria-label*='Send']",
        "button[type='submit']",
      ],
    };

    try {
      chrome.runtime.sendMessage({ type: 'GET_SELECTORS' }, (response) => {
        // chrome.runtime.lastError is set when the background isn't reachable
        if (chrome.runtime.lastError) {
          console.warn(
            '[Decruft] GET_SELECTORS failed (background unreachable):',
            chrome.runtime.lastError.message,
            '— using fallback selectors.'
          );
          onReady(FALLBACK_SELECTORS);
          return;
        }

        const claudeSelectors = response?.selectors?.claude;
        if (claudeSelectors) {
          console.debug('[Decruft] Selectors loaded from background.');
          onReady(claudeSelectors);
        } else {
          console.warn('[Decruft] Background returned empty selectors — using fallback.');
          onReady(FALLBACK_SELECTORS);
        }
      });
    } catch (err) {
      // chrome.runtime.sendMessage can throw synchronously if the extension
      // context has been invalidated (e.g. extension update during page session).
      console.error('[Decruft] chrome.runtime.sendMessage threw:', err, '— using fallback.');
      onReady(FALLBACK_SELECTORS);
    }
  }

  // ── 4. MESSAGE EXTRACTION ────────────────────────────────────────────────────

  /**
   * determineRole
   * ─────────────
   * Inspect `el` and classify it as 'human' or 'assistant' by testing it
   * against both selector lists.  Returns 'unknown' if neither matches.
   *
   * We test each element against both sets rather than relying solely on
   * which container it was found in — this handles edge cases where Claude
   * nests turns inside each other during streaming.
   *
   * @param {Element}  el
   * @param {Object}   sel  - The claude selectors object.
   * @returns {'human'|'assistant'|'unknown'}
   */
  function determineRole(el, sel) {
    // Test human selectors first (more specific)
    for (const selector of sel.humanMessage) {
      try {
        if (el.matches(selector)) return 'human';
      } catch (_) { /* invalid selector — skip */ }
    }
    for (const selector of sel.assistantMessage) {
      try {
        if (el.matches(selector)) return 'assistant';
      } catch (_) { /* invalid selector — skip */ }
    }
    return 'unknown';
  }

  /**
   * snapshotAllMessages
   * ───────────────────
   * Re-scans the full conversation DOM and rebuilds the `messages` array
   * from scratch.  Called on observer fire (after debounce) to ensure the
   * index/order stays accurate even when Claude re-renders the whole list.
   *
   * @returns {Array} Updated messages array (also sets the module-level var).
   */
  function snapshotAllMessages() {
    if (!selectors || !observedContainer) return [];

    // Collect human and assistant nodes strictly within the message container
    const humanNodes = queryAllWithFallback(selectors.humanMessage, observedContainer);
    const assistantNodes = queryAllWithFallback(selectors.assistantMessage, observedContainer);

    // Build a combined, document-order list by comparing node positions
    const allNodes = [...humanNodes, ...assistantNodes].sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const scraped = allNodes.map((el) => {
      const role = determineRole(el, selectors);
      const text = extractPlainText(el);
      return { role, text };
    });

    if (scraped.length === 0) return messages;

    // Use an accumulative merge strategy to protect against DOM virtualization
    const accumulated = [...messages];

    scraped.forEach((msg, idx) => {
      // Rule A: Match by identical role and near-exact text slice (checks top 100 chars to handle formatting drifts)
      let matchIdx = accumulated.findIndex((m) => {
        return m.role === msg.role && m.text.slice(0, 100) === msg.text.slice(0, 100);
      });

      // Rule B: Match the last scraped assistant turn to the last accumulated assistant turn if it is active/streaming
      if (matchIdx === -1 && idx === scraped.length - 1 && msg.role === 'assistant' && accumulated.length > 0) {
        const lastAcc = accumulated[accumulated.length - 1];
        if (lastAcc.role === 'assistant') {
          matchIdx = accumulated.length - 1;
        }
      }

      if (matchIdx !== -1) {
        // Update the cached text (crucial for streaming updates)
        accumulated[matchIdx].text = msg.text;
      } else {
        // No match found - this is a brand new message, append to cache
        accumulated.push({
          id: generateMessageId(),
          role: msg.role,
          text: msg.text,
          timestamp: Date.now(),
          index: accumulated.length,
        });
      }
    });

    // Re-index contiguous positions to preserve absolute chronological ordering
    accumulated.forEach((m, idx) => {
      m.index = idx;
    });

    messages = accumulated;
    return messages;
  }

  // ── 5. DEBOUNCED ANALYSIS TRIGGER ───────────────────────────────────────────

  /**
   * scheduleAnalysis
   * ────────────────
   * Debounces calls to ANALYZE_MESSAGES so that rapid DOM mutations
   * (e.g. streaming token-by-token assistant responses) collapse into a
   * single batch dispatch every 500 ms.
   *
   * The background responds asynchronously with an ANALYSIS_RESULT message
   * (handled in the onMessage listener below).
   */
  function scheduleAnalysis() {
    if (analyzeDebounceTimer !== null) {
      clearTimeout(analyzeDebounceTimer);
    }

    analyzeDebounceTimer = setTimeout(() => {
      analyzeDebounceTimer = null;

      const currentMessages = snapshotAllMessages();
      if (currentMessages.length === 0) return;

      try {
        chrome.runtime.sendMessage(
          { type: 'ANALYZE_MESSAGES', payload: { messages: currentMessages } },
          (response) => {
            if (chrome.runtime.lastError) {
              // Background may not be listening for this yet — non-fatal
              console.warn(
                '[Decruft] ANALYZE_MESSAGES error:',
                chrome.runtime.lastError.message
              );
            }
            // If the background chose to reply inline (synchronous path),
            // handle it here.  The primary path goes through the onMessage
            // listener below to support async analysis pipelines.
            if (response?.type === 'ANALYSIS_RESULT') {
              forwardAnalysisResultToWidget(response.data);
            }
          }
        );
      } catch (err) {
        console.error('[Decruft] scheduleAnalysis sendMessage threw:', err);
      }
    }, 500);
  }

  // ── 6. WIDGET ↔ BACKGROUND BRIDGE ───────────────────────────────────────────

  /**
   * forwardAnalysisResultToWidget
   * ─────────────────────────────
   * Broadcasts the analysis result from the background to the in-page widget
   * via window.postMessage.  The widget (widget.js, running in the same origin)
   * listens for `source === 'decruft'` messages.
   *
   * Data shape: { tokenCount, stalenessPercent, duplicateWarnings, projectedSavings }
   *
   * @param {Object} result
   */
  function forwardAnalysisResultToWidget(result) {
    if (!result) return;

    // FIX 2: expose current state on window for purge-bridge.js to read.
    // purge-bridge.js reads window.__decruft_state to get messages + result
    // before dispatching PURGE_CONTEXT to background.js.
    window.__decruft_state = { messages: messages, analysisResult: result };
    lastAnalysisResult = result;

    window.postMessage(
      { source: 'decruft', type: 'UPDATE_STATS', data: result },
      '*'  // Target origin is '*' because the widget runs on the same tab page
    );
  }

  // ── 7. MUTATION OBSERVER ─────────────────────────────────────────────────────

  /**
   * attachObserver
   * ──────────────
   * Sets up a MutationObserver on the message container element.
   * Watches for:
   *  - childList: new message turn elements added/removed
   *  - subtree:   text changes inside streaming assistant responses
   *  - characterData: inline text node mutations during streaming
   *
   * The observer fires scheduleAnalysis() on every relevant mutation batch,
   * which is then debounced to avoid hammering the background worker.
   *
   * @param {Element} container - The top-level message list element.
   */
  function attachObserver(container) {
    // Tear down any existing observer before re-attaching (SPA navigation)
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    observer = new MutationObserver((mutationsList) => {
      // Quick relevance filter — only act on structural changes (new nodes)
      // or character data changes deep in the tree (streaming text).
      const isRelevant = mutationsList.some(
        (m) => m.type === 'childList' || m.type === 'characterData'
      );
      if (!isRelevant) return;

      scheduleAnalysis();
    });

    observer.observe(container, {
      childList: true,       // Detect added/removed message turn elements
      subtree: true,         // Observe all descendants (nested content divs)
      characterData: true,   // Detect streaming text node updates
    });

    console.debug('[Decruft] MutationObserver attached to', container);
  }

  /**
   * initBodyObserver
   * ────────────────
   * Sets up a permanent MutationObserver on document.body.
   * As a single-page application (SPA), Claude dynamically renders the
   * message container depending on routing (e.g. blank screen vs conversation).
   *
   * By observing document.body, we detect the instant selectors.messageContainer
   * is added to the DOM and attach our turn observer, avoiding polling loops.
   */
  function initBodyObserver() {
    if (bodyObserver) {
      bodyObserver.disconnect();
      bodyObserver = null;
    }

    bodyObserver = new MutationObserver(() => {
      const container = findMessageContainer(selectors);
      if (container && container !== observedContainer) {
        console.debug('[Decruft] Message container detected in DOM.');
        observedContainer = container;
        attachObserver(container);
        snapshotAllMessages();
        scheduleAnalysis();
      } else if (!container && observedContainer) {
        console.debug('[Decruft] Message container removed from DOM.');
        observedContainer = null;
        if (observer) {
          observer.disconnect();
          observer = null;
        }
      }
    });

    bodyObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Run once immediately to bind to any pre-existing container
    const container = findMessageContainer(selectors);
    if (container) {
      observedContainer = container;
      attachObserver(container);
      snapshotAllMessages();
      scheduleAnalysis();
    }
  }

  // ── 8. WIDGET INJECTION ──────────────────────────────────────────────────────

  /**
   * injectWidget
   * ────────────
   * Programmatically inserts the widget CSS and JS into the page.
   *
   * CSS is injected as a <link rel="stylesheet"> (non-blocking, FOUC-safe for
   * a floating widget).  JS is injected as a <script defer> so it executes
   * after the DOM is ready without blocking parse.
   *
   * Both files are referenced via chrome.runtime.getURL() so the browser
   * uses the extension package paths rather than page-origin paths, and
   * the extension's web_accessible_resources declaration in manifest.json
   * whitelists them.
   *
   * Guard: no-op if already injected (idempotent for SPA navigations).
   */
  function injectWidget() {
    // Shadow DOM host — widget.js reads host.dataset.cssUrl to load its CSS
    // inside the shadow root. We must create and configure the host.
    if (!document.getElementById('decruft-widget-host')) {
      const host = document.createElement('div');
      host.id = 'decruft-widget-host';
      // FIX 1: provide the CSS URL so widget.js can inject it into Shadow DOM
      host.dataset.cssUrl = chrome.runtime.getURL('src/widget.css');
      document.body.appendChild(host);
      console.debug('[Decruft] Widget host created with cssUrl:', host.dataset.cssUrl);
    }
  }

  // ── 9. NEW CHAT NAVIGATION HANDLER ──────────────────────────────────────────

  /**
   * handleOpenNewChat
   * ─────────────────
   * Responds to an OPEN_NEW_CHAT instruction from the background.
   * Steps:
   *   1. Click the "New chat" button using the fallback-selector helper.
   *   2. Wait for the input box to appear (the new conversation page).
   *   3. Inject `contextText` into the input and optionally trigger send.
   *
   * @param {string} contextText  - Pre-distilled context to paste into new chat.
   */
  function handleOpenNewChat(contextText) {
    const newChatBtn = queryWithFallback(selectors.newChatButton);

    if (!newChatBtn) {
      console.warn('[Decruft] OPEN_NEW_CHAT: newChatButton not found — aborting.');
      return;
    }

    console.debug('[Decruft] Clicking New Chat button…');
    newChatBtn.click();

    // Poll for the input box to appear after navigation (Claude SPA transition)
    let pollAttempts = 0;
    const MAX_POLL   = 20;
    const POLL_MS    = 300;

    if (inputPollTimer !== null) {
      clearInterval(inputPollTimer);
    }

    inputPollTimer = setInterval(() => {
      pollAttempts++;
      const inputEl = queryWithFallback(selectors.inputBox);

      if (inputEl) {
        clearInterval(inputPollTimer);
        inputPollTimer = null;
        injectContextIntoInput(inputEl, contextText);
        return;
      }

      if (pollAttempts >= MAX_POLL) {
        clearInterval(inputPollTimer);
        inputPollTimer = null;
        console.warn(
          '[Decruft] OPEN_NEW_CHAT: input box not found after',
          MAX_POLL * POLL_MS,
          'ms.'
        );
      }
    }, POLL_MS);
  }

  /**
   * injectContextIntoInput
   * ──────────────────────
   * Inserts `text` into a contenteditable or <textarea> input element in a
   * way that triggers Claude's React synthetic-event system (plain `.value =`
   * assignment is swallowed by controlled inputs).
   *
   * Dispatches both an `input` and a `change` event to ensure React picks up
   * the programmatic change.
   *
   * @param {Element} inputEl   - The target input/contenteditable element.
   * @param {string}  text      - The text to inject.
   */
  function injectContextIntoInput(inputEl, text) {
    if (!text) return;

    inputEl.focus();

    if (inputEl.isContentEditable) {
      // ProseMirror / contenteditable path
      // execCommand is deprecated but remains the most reliable cross-browser
      // way to trigger React's synthetic onChange inside a contenteditable.
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);

      // ProseMirror/React state update triggers
      const beforeInputEvent = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      });
      inputEl.dispatchEvent(beforeInputEvent);

      const inputEvent = new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      });
      inputEl.dispatchEvent(inputEvent);

      const changeEvent = new Event('change', { bubbles: true });
      inputEl.dispatchEvent(changeEvent);
    } else {
      // <textarea> fallback path — use native input value setter to pierce
      // React's controlled-component wrapping.
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(inputEl, text);
      } else {
        inputEl.value = text;
      }

      inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    console.debug('[Decruft] Context text injected into input (', text.length, 'chars).');
  }

  // ── 10. INCOMING MESSAGE LISTENERS ───────────────────────────────────────────

  /**
   * CENTRAL MESSAGE LISTENERS
   * Handles all communications from background (runtime) and widget (window postMessage).
   */

  // 10a. Background → Content
  function handleRuntimeMessage(message, _sender, sendResponse) {
    switch (message.type) {
      case 'ANALYSIS_RESULT':
        window.__decruft_state = { messages: messages, analysisResult: message.data };
        forwardAnalysisResultToWidget(message.data);
        sendResponse({ status: 'ok' });
        break;

      case 'OPEN_NEW_CHAT':
        handleOpenNewChat(message.payload?.contextText ?? '');
        sendResponse({ status: 'ok' });
        break;

      case 'GET_METRICS':
        if (lastAnalysisResult) {
          sendResponse({
            tokens: lastAnalysisResult.tokenCount,
            staleness: lastAnalysisResult.stalenessPercent,
            duplicates: lastAnalysisResult.duplicateWarnings ? lastAnalysisResult.duplicateWarnings.length : 0
          });
        } else {
          sendResponse({ tokens: 0, staleness: 0, duplicates: 0 });
        }
        break;

      case 'SET_WIDGET_ENABLED':
        const hostEl = document.getElementById('decruft-widget-host');
        if (hostEl) {
          hostEl.style.display = message.enabled ? 'block' : 'none';
        }
        sendResponse({ status: 'ok' });
        break;

      case 'SET_PULSE_ENABLED':
        window.postMessage({ source: 'decruft', type: 'SET_PULSE_ENABLED', enabled: message.enabled }, '*');
        sendResponse({ status: 'ok' });
        break;

      default:
        break;
    }
    return false;
  }

  // 10b. Widget → Content
  function handleWidgetMessage(event) {
    if (event.source !== window) return;
    if (event.data?.source !== 'decruft-widget') return;

    const { type, data } = event.data;

    switch (type) {
      case 'EXECUTE_PURGE':
        console.debug('[Decruft] EXECUTE_PURGE received from widget.');
        try {
          chrome.runtime.sendMessage(
            {
              type: 'PURGE_CONTEXT',
              payload: { distilledMessages: data?.distilledMessages ?? [] },
            },
            (response) => {
              if (chrome.runtime.lastError) {
                console.warn('[Decruft] PURGE_CONTEXT error:', chrome.runtime.lastError.message);
              } else {
                console.debug('[Decruft] PURGE_CONTEXT acknowledged:', response?.status);
              }
            }
          );
        } catch (err) {
          console.error('[Decruft] EXECUTE_PURGE sendMessage threw:', err);
        }
        break;

      case 'REQUEST_STATS':
        scheduleAnalysis();
        break;

      default:
        break;
    }
  }

  // Register listeners
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  window.addEventListener('message', handleWidgetMessage);

  // ── 11. SPA NAVIGATION WATCHER ───────────────────────────────────────────────

  /**
   * onNavigation
   * ────────────
   * Resets message extraction indices and clears conversation-specific observers on route change.
   */
  function onNavigation() {
    console.debug('[Decruft] Navigation detected. Resetting state…');

    messages           = [];
    messageCounter     = 0;
    lastAnalysisResult = null;
    delete window.__decruft_state;

    // Reset stats in the in-page widget UI
    window.postMessage({ source: 'decruft', type: 'RESET_STATS' }, '*');

    if (observer) {
      observer.disconnect();
      observer = null;
    }
    observedContainer = null;

    // Poll robustly to re-attach the MutationObserver when the new chat loads
    let attempts = 0;
    const maxAttempts = 15;
    const pollInterval = setInterval(() => {
      attempts++;
      const container = findMessageContainer(selectors);
      if (container) {
        clearInterval(pollInterval);
        console.debug('[Decruft] Message container found post-navigation.');
        observedContainer = container;
        attachObserver(container);
        snapshotAllMessages();
        scheduleAnalysis();
      } else if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
        console.debug('[Decruft] Message container search timed out post-navigation.');
      }
    }, 400);
  }

  // Monkey-patch history methods to track dynamic client-side transitions
  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    onNavigation();
  };

  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    onNavigation();
  };

  window.addEventListener('popstate', onNavigation);

  // ── 12. CLEANUP & TEARDOWN SEQUENCE (ZOMBIE DEFENCE) ──────────────────────────

  /**
   * window.__decruft_destroy
   * ────────────────────────
   * Authoritative cleanup function.  Invoked by subsequent injections to clean
   * up dead observers, timers, hooks, and hosts from the page during development
   * or extension reloads.
   */
  window.__decruft_destroy = function () {
    console.debug('[Decruft] Disconnecting observers and cleaning up zombie context...');

    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (bodyObserver) {
      bodyObserver.disconnect();
      bodyObserver = null;
    }

    if (analyzeDebounceTimer !== null) {
      clearTimeout(analyzeDebounceTimer);
      analyzeDebounceTimer = null;
    }
    if (inputPollTimer !== null) {
      clearInterval(inputPollTimer);
      inputPollTimer = null;
    }

    window.removeEventListener('popstate', onNavigation);
    window.removeEventListener('message', handleWidgetMessage);
    try {
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    } catch (_) {}

    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;

    const host = document.getElementById('decruft-widget-host');
    if (host) {
      host.remove();
    }

    delete window.__decruft_loaded;
    delete window.__decruft_state;
    delete window.__decruft_destroy;
  };

  // ── 13. INITIALISATION SEQUENCE ──────────────────────────────────────────────

  function init() {
    loadSelectors((claudeSelectors) => {
      selectors = claudeSelectors;
      injectWidget();
      initBodyObserver();

      // Read initial settings from storage to respect user preferences on fresh loads
      try {
        if (typeof chrome !== 'undefined' && chrome.storage) {
          chrome.storage.local.get({ widgetEnabled: true }, (result) => {
            if (chrome.runtime.lastError) return;
            const hostEl = document.getElementById('decruft-widget-host');
            if (hostEl) {
              hostEl.style.display = result.widgetEnabled ? 'block' : 'none';
            }
          });
        }
      } catch (err) {
        console.warn('[Decruft] Failed to load initial settings from storage:', err);
      }
    });
  }

  init();

})(); // end decruftContent IIFE
