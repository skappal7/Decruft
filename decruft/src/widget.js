/**
 * Decruft — In-page Widget Script (src/widget.js)
 * ═════════════════════════════════════════════════
 * Injected into claude.ai as a web-accessible resource by content.js.
 * Runs inside a Shadow DOM to keep styles and DOM isolated from Claude's UI.
 *
 * Responsibilities:
 *  1. Mount a floating pill widget (bottom-right, collapsed by default)
 *  2. Listen for postMessage { source:'decruft', type:'UPDATE_STATS' }
 *  3. Animate staleness colour + pulse when >40%
 *  4. Open Purge Preview Modal on CTA click
 *  5. Dispatch EXECUTE_PURGE back to window on "Accept & Branch"
 *  6. Show 2-slide Onboarding overlay on first visit (localStorage gate)
 *
 * Message protocol (incoming):
 *   window.postMessage({
 *     source: 'decruft',
 *     type:   'UPDATE_STATS',
 *     data: {
 *       tokens:     number,   // current estimated tokens
 *       staleness:  number,   // 0-100 (%)
 *       duplicates: number,   // duplicate topic count
 *       purgeData: {          // payload for the modal
 *         afterTokens:    number,
 *         staleMessages:  number,
 *         dupTopics:      number,
 *         keptFirst:      boolean,
 *         keptLast:       number,
 *         keptRelevant:   number,
 *         distilledMessages: any[]
 *       }
 *     }
 *   })
 *
 * Message protocol (outgoing on Accept):
 *   window.postMessage({
 *     source: 'decruft-widget',
 *     type:   'EXECUTE_PURGE',
 *     data:   { distilledMessages: any[] }
 *   })
 */

(function decruftWidget() {
  'use strict';

  /* ── Guard: only mount once per page load ────────────────────────────────── */
  let host = document.getElementById('decruft-widget-host');
  let isNewHost = false;

  if (host && host.shadowRoot) {
    console.debug('[Decruft Widget] Already mounted — skipping.');
    return;
  }

  // Reuse or create the host element
  if (!host) {
    host = document.createElement('div');
    host.id = 'decruft-widget-host';
    // style properties set via CSSOM setProperty are fully CSP-compliant (unlike raw cssText string injections)
    host.style.setProperty('all', 'unset');
    host.style.setProperty('position', 'fixed');
    host.style.setProperty('bottom', '24px');
    host.style.setProperty('right', '24px');
    host.style.setProperty('z-index', '2147483647');
    isNewHost = true;
  }

  const shadow = host.attachShadow({ mode: 'open' });

  // Inject the widget stylesheet (already a web-accessible resource)
  const styleLink = document.createElement('link');
  styleLink.rel  = 'stylesheet';
  // Use direct chrome.runtime.getURL since we run in the isolated content script world,
  // bypassing the page Content Security Policy (CSP).
  styleLink.href = typeof chrome !== 'undefined' && chrome.runtime
    ? chrome.runtime.getURL('src/widget.css')
    : (host.dataset.cssUrl || '');

  /* ── Append CSS stylesheet inside Shadow DOM ──────────────────────────────── */
  // The link stylesheet pointing to src/widget.css is a web-accessible resource
  // which is fully permitted by standard CSP rules.
  shadow.appendChild(styleLink);

  /* ══════════════════════════════════════════════════════════════════════════
     STATE
     ══════════════════════════════════════════════════════════════════════════ */

  /** @type {{ tokens:number, staleness:number, duplicates:number, purgeData:object, pulseEnabled:boolean }} */
  let state = {
    tokens:     0,
    staleness:  0,
    duplicates: 0,
    purgeData:  null,
    pulseEnabled: true,
  };

  /* ══════════════════════════════════════════════════════════════════════════
     HTML TEMPLATES
     ══════════════════════════════════════════════════════════════════════════ */

  /* ── Floating widget ──────────────────────────────────────────────────────── */
  const widgetEl = document.createElement('div');
  widgetEl.className = 'dw-widget';
  widgetEl.setAttribute('role', 'button');
  widgetEl.setAttribute('aria-label', 'Decruft context monitor');
  widgetEl.innerHTML = `
    <!-- Collapsed pill row -->
    <div class="dw-pill">
      <span class="dw-dot"  aria-hidden="true"></span>
      <span class="dw-brand">Decruft</span>
      <span class="dw-pct"  id="dw-pct">0%</span>
    </div>

    <!-- Expanded stats body -->
    <div class="dw-body">
      <div class="dw-row">
        <span class="dw-row-icon" aria-hidden="true">🔢</span>
        <span>Tokens:</span>
        <span class="dw-row-val" id="dw-tokens">—</span>
      </div>

      <!-- Duplicate warning — hidden when duplicates === 0 -->
      <div class="dw-row dw-dup-row" id="dw-dup-row" aria-live="polite">
        <span class="dw-row-icon" aria-hidden="true">⚠</span>
        <span id="dw-dup-text">0 duplicates</span>
      </div>

      <!-- CTA — only shown when staleness > 40% -->
      <button class="dw-cta" id="dw-cta" type="button">
        🧹 Purge &amp; Branch
      </button>
    </div>
  `;

  /* ── Purge Preview Modal ──────────────────────────────────────────────────── */
  const backdropEl = document.createElement('div');
  backdropEl.className = 'dw-backdrop';
  backdropEl.setAttribute('role', 'dialog');
  backdropEl.setAttribute('aria-modal', 'true');
  backdropEl.setAttribute('aria-labelledby', 'dw-modal-title');
  backdropEl.innerHTML = `
    <div class="dw-modal">
      <div class="dw-modal-header">
        <span class="dw-modal-icon" aria-hidden="true">🧹</span>
        <h2 class="dw-modal-title" id="dw-modal-title">Decruft — Context Preview</h2>
      </div>

      <!-- Token summary -->
      <div class="dw-token-summary">
        <div class="dw-token-row">
          <span class="label">Before</span>
          <span class="val" id="dw-m-before">—</span>
        </div>

        <!-- Progress bar: After / Before ratio -->
        <div class="dw-progress-wrap">
          <div class="dw-progress-label">
            <span>After</span>
            <span id="dw-m-after-label">—</span>
          </div>
          <div class="dw-progress-track" aria-hidden="true">
            <div class="dw-progress-fill" id="dw-m-progress"></div>
          </div>
        </div>

        <div class="dw-token-row saving">
          <span class="label">Saving</span>
          <span class="val" id="dw-m-saving">—</span>
        </div>
      </div>

      <!-- What's removed -->
      <p class="dw-section-label">What's being removed</p>
      <ul class="dw-list" id="dw-removed-list"></ul>

      <div class="dw-divider" aria-hidden="true"></div>

      <!-- What's kept -->
      <p class="dw-section-label">What's kept</p>
      <ul class="dw-list kept" id="dw-kept-list"></ul>

      <!-- Error alert container (hidden by default) -->
      <div class="dw-error-alert dw-hidden" id="dw-modal-error" aria-live="assertive"></div>

      <!-- Action buttons -->
      <div class="dw-modal-actions">
        <button class="dw-btn dw-btn-cancel" id="dw-cancel" type="button">Cancel</button>
        <button class="dw-btn dw-btn-accept" id="dw-accept" type="button">Accept &amp; Branch</button>
      </div>
    </div>
  `;

  /* ── Onboarding Overlay ───────────────────────────────────────────────────── */
  const onboardEl = document.createElement('div');
  onboardEl.className = 'dw-onboard';
  onboardEl.setAttribute('role', 'dialog');
  onboardEl.setAttribute('aria-modal', 'true');
  onboardEl.setAttribute('aria-labelledby', 'dw-ob-title');
  onboardEl.innerHTML = `
    <div class="dw-onboard-card">
      <!-- Dynamic slide content rendered by JS -->
      <span class="dw-onboard-icon" id="dw-ob-icon" aria-hidden="true"></span>
      <h2 class="dw-onboard-title" id="dw-ob-title"></h2>
      <div class="dw-onboard-body" id="dw-ob-body"></div>

      <!-- Slide 2 step visuals — hidden on slide 1 -->
      <div class="dw-steps" id="dw-ob-steps">
        <div class="dw-step">
          <div class="dw-step-icon" aria-hidden="true">📊</div>
          <div class="dw-step-label">Monitor</div>
        </div>
        <div class="dw-step-arrow" aria-hidden="true">→</div>
        <div class="dw-step">
          <div class="dw-step-icon" aria-hidden="true">🔍</div>
          <div class="dw-step-label">Review</div>
        </div>
        <div class="dw-step-arrow" aria-hidden="true">→</div>
        <div class="dw-step">
          <div class="dw-step-icon" aria-hidden="true">🌿</div>
          <div class="dw-step-label">Branch</div>
        </div>
      </div>

      <!-- Pagination dots -->
      <div class="dw-onboard-dots" aria-label="Slide navigation" role="list">
        <div class="dw-dot-ind active" role="listitem" aria-label="Slide 1"></div>
        <div class="dw-dot-ind"        role="listitem" aria-label="Slide 2"></div>
      </div>

      <button class="dw-onboard-btn" id="dw-ob-btn" type="button">Next</button>
    </div>
  `;

  widgetEl.setAttribute('tabindex', '0');
  widgetEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      widgetEl.click();
    }
  });

  /* ── Append everything to shadow root ────────────────────────────────────── */
  shadow.appendChild(backdropEl);
  shadow.appendChild(onboardEl);
  shadow.appendChild(widgetEl);

  /* Append host to page if new */
  if (isNewHost) {
    document.body.appendChild(host);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     HELPERS
     ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Format a raw token count as "4,200 tokens"
   * @param {number} n
   * @returns {string}
   */
  function fmtTokens(n) {
    return `${n.toLocaleString()} tokens`;
  }

  /**
   * Derive the staleness class from a 0-100 percentage.
   * @param {number} pct
   * @returns {'stale-green'|'stale-yellow'|'stale-orange'|'stale-red'}
   */
  function stalenessClass(pct) {
    if (pct <= 25) return 'stale-green';
    if (pct <= 50) return 'stale-yellow';
    if (pct <= 75) return 'stale-orange';
    return 'stale-red';
  }

  /**
   * Clamp and round a number to [0, 100].
   * @param {number} n
   * @returns {number}
   */
  function clamp100(n) {
    return Math.min(100, Math.max(0, Math.round(n)));
  }

  let activeFocusTrapCleanup = null;

  /**
   * Sets up a focus trap inside a container element.
   * Returns a function to remove/clean up the listeners.
   *
   * @param {HTMLElement} container
   * @returns {function}
   */
  function trapFocus(container) {
    const focusableEls = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex="0"]'
    );
    if (focusableEls.length === 0) return () => {};
    
    const firstFocusable = focusableEls[0];
    const lastFocusable = focusableEls[focusableEls.length - 1];

    function handleTab(e) {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (shadow.activeElement === firstFocusable) {
          lastFocusable.focus();
          e.preventDefault();
        }
      } else {
        if (shadow.activeElement === lastFocusable) {
          firstFocusable.focus();
          e.preventDefault();
        }
      }
    }

    container.addEventListener('keydown', handleTab);
    return () => container.removeEventListener('keydown', handleTab);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     WIDGET RENDERING
     ══════════════════════════════════════════════════════════════════════════ */

  const STALENESS_CLASSES = ['stale-green', 'stale-yellow', 'stale-orange', 'stale-red'];

  /**
   * Re-render the widget with the current state.
   */
  function renderWidget() {
    const { tokens, staleness, duplicates } = state;
    const pct = clamp100(staleness);

    /* -- Percentage label -- */
    shadow.getElementById('dw-pct').textContent = `${pct}%`;

    /* -- Token count -- */
    shadow.getElementById('dw-tokens').textContent = `~${tokens.toLocaleString()}`;

    /* -- Colour dot class -- */
    const cls = stalenessClass(pct);
    STALENESS_CLASSES.forEach(c => widgetEl.classList.remove(c));
    widgetEl.classList.add(cls);

    /* -- Pulse when > 40% and pulseEnabled is true -- */
    widgetEl.classList.toggle('pulsing', pct > 40 && state.pulseEnabled !== false);

    /* -- CTA button -- */
    widgetEl.classList.toggle('show-cta', pct > 40);

    /* -- Duplicate row -- */
    const dupRow  = shadow.getElementById('dw-dup-row');
    const dupText = shadow.getElementById('dw-dup-text');
    if (duplicates > 0) {
      dupRow.classList.add('visible');
      dupText.textContent = `${duplicates} duplicate${duplicates !== 1 ? 's' : ''}`;
    } else {
      dupRow.classList.remove('visible');
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     MODAL RENDERING & INTERACTION
     ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Populate the modal with purge preview data and open it.
   */
  function openModal() {
    const { tokens, purgeData } = state;

    /* Hide any error banner from previous attempts */
    const errEl = shadow.getElementById('dw-modal-error');
    if (errEl) {
      errEl.textContent = '';
      errEl.classList.add('dw-hidden');
    }

    /* Provide sensible defaults when purgeData hasn't arrived yet */
    const pd = purgeData ? {
      afterTokens:   purgeData.afterTokens ?? purgeData.distilledTokens ?? Math.round(tokens * 0.28),
      staleMessages: purgeData.staleMessages ?? purgeData.staleCount ?? 8,
      dupTopics:     purgeData.dupTopics ?? purgeData.dupCount ?? state.duplicates,
      keptFirst:     purgeData.keptFirst !== false,
      keptLast:      typeof purgeData.keptLast === 'number' ? purgeData.keptLast : 3,
      keptRelevant:  typeof purgeData.keptRelevant === 'number' ? purgeData.keptRelevant : 4,
      distilledMessages: purgeData.distilledMessages ?? [],
    } : {
      afterTokens:   Math.round(tokens * 0.28),
      staleMessages: 8,
      dupTopics:     state.duplicates,
      keptFirst:     true,
      keptLast:      3,
      keptRelevant:  4,
      distilledMessages: [],
    };

    const saving    = tokens - pd.afterTokens;
    const savingPct = tokens > 0 ? Math.round((saving / tokens) * 100) : 0;
    // After-bar width = afterTokens / tokens * 100 (what remains)
    const afterPct  = tokens > 0 ? Math.round((pd.afterTokens / tokens) * 100) : 0;

    /* -- Token summary -- */
    shadow.getElementById('dw-m-before').textContent       = fmtTokens(tokens);
    shadow.getElementById('dw-m-after-label').textContent  = fmtTokens(pd.afterTokens);
    shadow.getElementById('dw-m-saving').textContent       = `${fmtTokens(saving)} (${savingPct}%)`;

    /* -- Progress bar -- */
    // Animate on next frame so CSS transition fires
    requestAnimationFrame(() => {
      shadow.getElementById('dw-m-progress').style.width = `${afterPct}%`;
    });

    /* -- Removed list -- */
    const removedList = shadow.getElementById('dw-removed-list');
    removedList.innerHTML = '';
    if (pd.staleMessages > 0) {
      removedList.appendChild(makeListItem(`${pd.staleMessages} stale message${pd.staleMessages !== 1 ? 's' : ''}`));
    }
    if (pd.dupTopics > 0) {
      removedList.appendChild(makeListItem(`${pd.dupTopics} duplicate topic${pd.dupTopics !== 1 ? 's' : ''}`));
    }
    if (removedList.childElementCount === 0) {
      removedList.appendChild(makeListItem('Low-signal filler turns'));
    }

    /* -- Kept list -- */
    const keptList = shadow.getElementById('dw-kept-list');
    keptList.innerHTML = '';
    if (pd.keptFirst) {
      keptList.appendChild(makeListItem('First message (original context)'));
    }
    if (pd.keptLast > 0) {
      keptList.appendChild(makeListItem(`Last ${pd.keptLast} message${pd.keptLast !== 1 ? 's' : ''} (recency)`));
    }
    if (pd.keptRelevant > 0) {
      keptList.appendChild(makeListItem(`${pd.keptRelevant} relevant message${pd.keptRelevant !== 1 ? 's' : ''}`));
    }

    /* -- Open -- */
    backdropEl.classList.add('open');
    
    // Set up focus trap
    if (activeFocusTrapCleanup) {
      activeFocusTrapCleanup();
    }
    activeFocusTrapCleanup = trapFocus(backdropEl);

    // Trap focus inside modal
    shadow.getElementById('dw-cancel').focus();
  }

  /**
   * Close the modal.
   */
  function closeModal() {
    backdropEl.classList.remove('open');

    // Clean up focus trap
    if (activeFocusTrapCleanup) {
      activeFocusTrapCleanup();
      activeFocusTrapCleanup = null;
    }

    // Hide any active error banner
    const errEl = shadow.getElementById('dw-modal-error');
    if (errEl) {
      errEl.textContent = '';
      errEl.classList.add('dw-hidden');
    }

    // Return focus to the widget element
    widgetEl.focus();

    // Reset progress bar for next open
    requestAnimationFrame(() => {
      const fill = shadow.getElementById('dw-m-progress');
      if (fill) fill.style.width = '0%';
    });
  }

  /**
   * Build a <li> element with text.
   * @param {string} text
   * @returns {HTMLLIElement}
   */
  function makeListItem(text) {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }

  /* ── Modal button handlers ────────────────────────────────────────────────── */

  shadow.getElementById('dw-cancel').addEventListener('click', closeModal);

  shadow.getElementById('dw-accept').addEventListener('click', () => {
    const distilled = state.purgeData?.distilledMessages ?? [];

    // Notify content.js / background that the user accepted the purge
    window.postMessage(
      {
        source: 'decruft-widget',
        type:   'EXECUTE_PURGE',
        data:   { distilledMessages: distilled },
      },
      '*'
    );

    closeModal();
  });

  /* Close on backdrop click (outside modal card) */
  backdropEl.addEventListener('click', (e) => {
    if (e.target === backdropEl) closeModal();
  });

  /* Close on Escape */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdropEl.classList.contains('open')) {
      closeModal();
    }
  });

  /* ── Widget click → open modal ───────────────────────────────────────────── */
  widgetEl.addEventListener('click', () => {
    // Only open modal if CTA is visible (staleness > 40%), otherwise just expand
    if (widgetEl.classList.contains('show-cta')) {
      openModal();
    } else {
      // Toggle expanded on click so mobile/keyboard users can see stats
      widgetEl.classList.toggle('expanded');
    }
  });

  /* The CTA button inside the expanded body */
  shadow.getElementById('dw-cta').addEventListener('click', (e) => {
    e.stopPropagation(); // don't re-trigger the widget click
    openModal();
  });

  /* ══════════════════════════════════════════════════════════════════════════
     ONBOARDING OVERLAY
     ══════════════════════════════════════════════════════════════════════════ */

  const ONBOARDING_KEY = 'decruft_onboardingDone';

  const SLIDES = [
    {
      icon:  '📈',
      title: 'What is Context Staleness?',
      body:  "Every Claude conversation has a context window. As you chat, older messages "
           + "become less useful — they're either repeated, off-topic, or just padding. "
           + "<strong>Staleness %</strong> tells you how much of your context is wasted space. "
           + "The higher the number, the more tokens are being wasted on noise.",
      showSteps: false,
    },
    {
      icon:  '🌿',
      title: 'How Purge Works',
      body:  'Decruft keeps only what matters: your first message, the most recent turns, '
           + 'and the most relevant exchanges. Everything else is pruned. Then a fresh '
           + '<strong>branch conversation</strong> is created — clean slate, full context preserved.',
      showSteps: true,
    },
  ];

  let currentSlide = 0;

  /**
   * Render the onboarding slide at index `idx`.
   * @param {number} idx
   */
  function renderSlide(idx) {
    const slide = SLIDES[idx];

    shadow.getElementById('dw-ob-icon').textContent   = slide.icon;
    shadow.getElementById('dw-ob-title').textContent  = slide.title;
    shadow.getElementById('dw-ob-body').innerHTML     = slide.body;

    // Step visuals only on slide 2
    const stepsEl = shadow.getElementById('dw-ob-steps');
    stepsEl.style.display = slide.showSteps ? 'flex' : 'none';

    // Pagination dots
    const dots = onboardEl.querySelectorAll('.dw-dot-ind');
    dots.forEach((d, i) => d.classList.toggle('active', i === idx));

    // Button label
    const btn = shadow.getElementById('dw-ob-btn');
    btn.textContent = idx === SLIDES.length - 1 ? 'Got it! 🎉' : 'Next →';
  }

  /** Show the onboarding overlay (with entrance animation). */
  function showOnboarding() {
    currentSlide = 0;
    renderSlide(0);
    // Delay so the CSS transition fires after display change
    requestAnimationFrame(() => onboardEl.classList.add('open'));
  }

  /** Hide and mark onboarding as done. */
  function finishOnboarding() {
    onboardEl.classList.remove('open');
    try {
      localStorage.setItem(ONBOARDING_KEY, 'true');
    } catch (_) {
      // localStorage may be unavailable in some contexts — fail silently
    }
  }

  /* Onboarding button: Next / Got it */
  shadow.getElementById('dw-ob-btn').addEventListener('click', () => {
    if (currentSlide < SLIDES.length - 1) {
      currentSlide++;
      renderSlide(currentSlide);
    } else {
      finishOnboarding();
    }
  });

  /* Check localStorage before showing */
  function maybeShowOnboarding() {
    try {
      if (!localStorage.getItem(ONBOARDING_KEY)) {
        // Small delay so the page has settled before the overlay pops in
        setTimeout(showOnboarding, 800);
      }
    } catch (_) {
      // If localStorage is blocked, skip onboarding silently
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     postMessage LISTENER — receive stat updates from content.js
     ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Handle incoming postMessage events.
   * Expected shape:
   *   { source: 'decruft', type: 'UPDATE_STATS', data: { ... } }
   *
   * Security: we check source and type before touching state.
   * We do NOT check event.origin against a hardcoded value because the widget
   * is injected into claude.ai but content.js also originates from there.
   */
  window.addEventListener('message', (event) => {
    // Only handle messages from our own content script
    if (!event.data || event.data.source !== 'decruft') return;

    if (event.data.type === 'UPDATE_STATS') {
      const d = event.data.data || {};
      state.tokens     = typeof d.tokenCount === 'number' ? d.tokenCount : (typeof d.tokens === 'number' ? d.tokens : state.tokens);
      state.staleness  = typeof d.stalenessPercent === 'number' ? d.stalenessPercent : (typeof d.staleness === 'number' ? d.staleness : state.staleness);
      state.duplicates = Array.isArray(d.duplicateWarnings) ? d.duplicateWarnings.length : (typeof d.duplicates === 'number' ? d.duplicates : state.duplicates);
      state.purgeData  = d.purgeData ?? state.purgeData;

      renderWidget();
    } else if (event.data.type === 'RESET_STATS') {
      state.tokens     = 0;
      state.staleness  = 0;
      state.duplicates = 0;
      state.purgeData  = null;
      renderWidget();
    } else if (event.data.type === 'SET_PULSE_ENABLED') {
      state.pulseEnabled = event.data.enabled !== false;
      renderWidget();
    } else if (event.data.type === 'PURGE_ERROR') {
      const errEl = shadow.getElementById('dw-modal-error');
      if (errEl) {
        errEl.textContent = event.data.error || 'An unexpected error occurred during purge.';
        errEl.classList.remove('dw-hidden');
      }
    }
  });

  /* ══════════════════════════════════════════════════════════════════════════
     INIT
     ══════════════════════════════════════════════════════════════════════════ */

  // Read initial settings from storage to respect user preferences on fresh loads
  if (typeof chrome !== 'undefined' && chrome.storage) {
    try {
      chrome.storage.local.get({ pulseEnabled: true }, (result) => {
        if (chrome.runtime.lastError) return;
        state.pulseEnabled = result.pulseEnabled !== false;
        renderWidget();
      });
    } catch (_) {
      // safe fallback if storage is blocked/unavailable
    }
  }

  // Initial render with zeroed-out state
  renderWidget();

  // Possibly show onboarding
  maybeShowOnboarding();

  console.debug('[Decruft] Widget mounted. Shadow DOM ready.');

})();
