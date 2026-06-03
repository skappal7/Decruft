/**
 * Decruft — Popup Script (src/popup.js)
 * ══════════════════════════════════════
 * Bootstraps the full popup UI inside #popup-root.
 *
 * Architecture:
 *  1. Render HTML skeleton immediately (no flicker)
 *  2. Query active tab for live staleness stats via chrome.tabs.sendMessage
 *  3. Read lifetime stats from chrome.storage.local
 *  4. Render the ring meter, stat cards, and settings toggles
 *  5. Persist toggle preferences via chrome.storage.local
 *
 * Storage schema (chrome.storage.local):
 *  {
 *    totalTokensSaved : number,   // lifetime tokens saved across all purges
 *    purgeCount       : number,   // total purges performed
 *    lastPurgeDate    : string|null, // ISO date string or null
 *    widgetEnabled    : boolean,  // show floating widget on claude.ai
 *    pulseEnabled     : boolean,  // allow pulse animation
 *  }
 *
 * Messages (to content.js):
 *  { type: 'GET_METRICS' } → { tokens, staleness, duplicates }
 */

'use strict';

/* ══════════════════════════════════════════════════════════════════════════════
   CONSTANTS
   ══════════════════════════════════════════════════════════════════════════════ */

/** SVG ring circumference: 2π × r where r = 24 */
const RING_CIRCUMFERENCE = 2 * Math.PI * 24; // ≈ 150.796

/** Storage defaults */
const STORAGE_DEFAULTS = {
  totalTokensSaved: 0,
  purgeCount:       0,
  lastPurgeDate:    null,
  widgetEnabled:    true,
  pulseEnabled:     true,
};

/* ══════════════════════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Format a number with locale-aware commas.
 * @param {number} n
 * @returns {string}
 */
function fmt(n) {
  return n.toLocaleString();
}

/**
 * Format a token count as "4,200" (no unit; unit is in the label).
 * @param {number} n
 * @returns {string}
 */
function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Return a human-readable relative date, e.g. "Today", "Yesterday", "3 days ago".
 * @param {string|null} isoDate
 * @returns {string}
 */
function relativeDate(isoDate) {
  if (!isoDate) return 'Never';
  const then = new Date(isoDate);
  const now  = new Date();
  const diffMs   = now - then;
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays <  7)  return `${diffDays} days ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Map staleness percentage to a CSS class suffix.
 * @param {number} pct  0-100
 * @returns {'green'|'yellow'|'orange'|'red'}
 */
function stalenessTheme(pct) {
  if (pct <= 25) return 'green';
  if (pct <= 50) return 'yellow';
  if (pct <= 75) return 'orange';
  return 'red';
}

/**
 * Map staleness theme to a CSS stroke colour.
 * @param {'green'|'yellow'|'orange'|'red'} theme
 * @returns {string} hex colour
 */
function themeToStroke(theme) {
  return { green: '#22c55e', yellow: '#eab308', orange: '#f97316', red: '#ef4444' }[theme];
}

/**
 * Safe chrome.storage.local.get with defaults.
 * @returns {Promise<object>}
 */
function getStorage() {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.get(STORAGE_DEFAULTS, resolve);
    } else {
      // Fallback for development outside extension context
      resolve({ ...STORAGE_DEFAULTS });
    }
  });
}

/**
 * Safe chrome.storage.local.set.
 * @param {object} data
 * @returns {Promise<void>}
 */
function setStorage(data) {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set(data, resolve);
    } else {
      resolve();
    }
  });
}

/**
 * Query the active claude.ai tab for live metrics.
 * Resolves with null if the active tab is not claude.ai or content script
 * hasn't responded.
 * @returns {Promise<{tokens:number, staleness:number, duplicates:number}|null>}
 */
function getLiveMetrics() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs) {
      resolve(null);
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab || !tab.url || !tab.url.includes('claude.ai')) {
        resolve(null);
        return;
      }
      try {
        chrome.tabs.sendMessage(tab.id, { type: 'GET_METRICS' }, (response) => {
          if (chrome.runtime.lastError || !response) {
            resolve(null);
          } else {
            resolve(response);
          }
        });
      } catch (_) {
        resolve(null);
      }
    });
  });
}

/* ══════════════════════════════════════════════════════════════════════════════
   HTML BUILDER
   ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Build and return the full popup HTML string.
 * Elements use IDs prefixed with `dp-` (decruft popup).
 * @returns {string}
 */
function buildPopupHTML() {
  return `
    <!-- ── Header ─────────────────────────────────────────────────────────── -->
    <header class="dp-header">
      <div class="dp-logo">
        <span class="dp-logo-icon" aria-hidden="true">🧹</span>
        <span class="dp-logo-text">Decruft</span>
      </div>
      <span class="dp-version">v1.0.0</span>
    </header>

    <!-- ── Live staleness banner ──────────────────────────────────────────── -->
    <section class="dp-live" id="dp-live" aria-label="Live context stats">
      <div class="dp-ring-wrap" aria-hidden="true">
        <svg class="dp-ring" viewBox="0 0 60 60">
          <circle class="dp-ring-bg"   cx="30" cy="30" r="24"/>
          <circle class="dp-ring-fill" cx="30" cy="30" r="24" id="dp-ring-fill"/>
        </svg>
        <div class="dp-ring-pct" id="dp-ring-pct">—</div>
      </div>
      <div class="dp-live-info">
        <div class="dp-live-label">Context staleness</div>
        <div class="dp-live-tokens" id="dp-live-tokens">—</div>
        <div class="dp-live-sub"    id="dp-live-sub">tokens in context</div>
        <div class="dp-status-pill" id="dp-status-pill">
          <span class="dp-status-dot"></span>
          <span id="dp-status-text">Loading…</span>
        </div>
      </div>
    </section>

    <!-- Shown instead of live banner when not on claude.ai -->
    <div class="dp-no-tab" id="dp-no-tab" role="status">
      <span aria-hidden="true">🌐</span>
      Open claude.ai to see live stats
    </div>

    <!-- ── Lifetime stats grid ─────────────────────────────────────────────── -->
    <section class="dp-stats-grid" aria-label="Lifetime statistics">

      <div class="dp-stat-card">
        <span class="dp-stat-icon" aria-hidden="true">✨</span>
        <div class="dp-stat-val success" id="dp-tokens-saved">0</div>
        <div class="dp-stat-label">Tokens Saved</div>
      </div>

      <div class="dp-stat-card">
        <span class="dp-stat-icon" aria-hidden="true">🔁</span>
        <div class="dp-stat-val" id="dp-purge-count">0</div>
        <div class="dp-stat-label">Purges Done</div>
      </div>

      <div class="dp-stat-card full-width">
        <span class="dp-stat-icon" aria-hidden="true">🗓</span>
        <div class="dp-stat-val muted" id="dp-last-purge">Never</div>
        <div class="dp-stat-label">Last Purge</div>
      </div>

    </section>

    <!-- ── Settings ────────────────────────────────────────────────────────── -->
    <section class="dp-settings" aria-label="Settings">
      <div class="dp-settings-title">Settings</div>

      <!-- Toggle: Widget enabled -->
      <div class="dp-setting-row">
        <div class="dp-setting-info">
          <div class="dp-setting-label">Show Widget</div>
          <div class="dp-setting-desc">Floating badge on claude.ai</div>
        </div>
        <label class="dp-toggle" aria-label="Show floating widget">
          <input type="checkbox" id="dp-toggle-widget" />
          <span class="dp-toggle-track"></span>
        </label>
      </div>

      <!-- Toggle: Pulse animation -->
      <div class="dp-setting-row">
        <div class="dp-setting-info">
          <div class="dp-setting-label">Pulse Animation</div>
          <div class="dp-setting-desc">Gentle glow when stale &gt; 40%</div>
        </div>
        <label class="dp-toggle" aria-label="Enable pulse animation">
          <input type="checkbox" id="dp-toggle-pulse" />
          <span class="dp-toggle-track"></span>
        </label>
      </div>

    </section>

    <!-- ── Footer ─────────────────────────────────────────────────────────── -->
    <footer class="dp-footer">
      <span class="dp-footer-tagline">100% private — no telemetry</span>
      <a class="dp-footer-link"
         href="https://github.com/your-repo/decruft"
         target="_blank"
         rel="noopener noreferrer">GitHub ↗</a>
    </footer>
  `;
}

/* ══════════════════════════════════════════════════════════════════════════════
   RENDER FUNCTIONS
   ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Apply the SVG ring animation for a given staleness percentage.
 * @param {number} pct  0-100
 */
function animateRing(pct) {
  const ringFill = document.getElementById('dp-ring-fill');
  const ringPct  = document.getElementById('dp-ring-pct');
  if (!ringFill || !ringPct) return;

  // stroke-dashoffset = circumference × (1 - pct/100)
  const offset = RING_CIRCUMFERENCE * (1 - pct / 100);
  ringFill.style.strokeDashoffset = offset;

  const theme = stalenessTheme(pct);
  ringFill.style.stroke = themeToStroke(theme);
  ringPct.textContent   = `${pct}%`;
}

/**
 * Render live metrics into the live stats banner.
 * @param {{ tokens:number, staleness:number, duplicates:number }|null} metrics
 */
function renderLive(metrics) {
  const liveEl  = document.getElementById('dp-live');
  const noTabEl = document.getElementById('dp-no-tab');

  if (!metrics) {
    // Not on claude.ai or content script not responding
    liveEl.style.display  = 'none';
    noTabEl.style.display = '';
    return;
  }

  liveEl.style.display  = '';
  noTabEl.style.display = 'none';

  const { tokens, staleness, duplicates } = metrics;
  const pct   = Math.min(100, Math.max(0, Math.round(staleness)));
  const theme = stalenessTheme(pct);

  // Ring
  animateRing(pct);

  // Token display
  const tokensEl = document.getElementById('dp-live-tokens');
  const subEl    = document.getElementById('dp-live-sub');
  if (tokensEl) tokensEl.textContent = `~${fmtTokens(tokens)}`;
  if (subEl)    subEl.textContent    = duplicates > 0
    ? `tokens · ${duplicates} duplicate${duplicates !== 1 ? 's' : ''}`
    : 'tokens in context';

  // Status pill
  const pill     = document.getElementById('dp-status-pill');
  const pillText = document.getElementById('dp-status-text');
  if (pill && pillText) {
    // Remove old colour classes
    ['yellow', 'orange', 'red'].forEach(c => pill.classList.remove(c));
    if (theme !== 'green') pill.classList.add(theme);

    const labels = {
      green:  'Fresh',
      yellow: 'Slightly stale',
      orange: 'Getting stale',
      red:    'Purge recommended',
    };
    pillText.textContent = labels[theme];
  }
}

/**
 * Render lifetime stats from storage.
 * @param {object} store
 */
function renderStats(store) {
  const savedEl = document.getElementById('dp-tokens-saved');
  const countEl = document.getElementById('dp-purge-count');
  const lastEl  = document.getElementById('dp-last-purge');

  if (savedEl) savedEl.textContent = fmtTokens(store.totalTokensSaved || 0);
  if (countEl) countEl.textContent = fmt(store.purgeCount || 0);
  if (lastEl)  lastEl.textContent  = relativeDate(store.lastPurgeDate || null);
}

/**
 * Bind settings toggles to chrome.storage.
 * @param {object} store
 */
function bindSettings(store) {
  /* Widget toggle */
  const widgetToggle = document.getElementById('dp-toggle-widget');
  if (widgetToggle) {
    widgetToggle.checked = store.widgetEnabled !== false;
    widgetToggle.addEventListener('change', () => {
      setStorage({ widgetEnabled: widgetToggle.checked });
      // Notify content script so it can show/hide the widget in real time
      if (typeof chrome !== 'undefined' && chrome.tabs) {
        chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
          if (!tab) return;
          chrome.tabs.sendMessage(tab.id, {
            type:    'SET_WIDGET_ENABLED',
            enabled: widgetToggle.checked,
          }).catch(() => {/* tab may not have content script */});
        });
      }
    });
  }

  /* Pulse toggle */
  const pulseToggle = document.getElementById('dp-toggle-pulse');
  if (pulseToggle) {
    pulseToggle.checked = store.pulseEnabled !== false;
    pulseToggle.addEventListener('change', () => {
      setStorage({ pulseEnabled: pulseToggle.checked });
      if (typeof chrome !== 'undefined' && chrome.tabs) {
        chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
          if (!tab) return;
          chrome.tabs.sendMessage(tab.id, {
            type:    'SET_PULSE_ENABLED',
            enabled: pulseToggle.checked,
          }).catch(() => {});
        });
      }
    });
  }
}

/**
 * Add skeleton shimmer to elements that are loading.
 */
function applySkeletons() {
  ['dp-ring-pct', 'dp-live-tokens', 'dp-tokens-saved', 'dp-purge-count', 'dp-last-purge']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('dp-skeleton');
    });
}

/**
 * Remove all skeleton shimmers.
 */
function removeSkeletons() {
  document.querySelectorAll('.dp-skeleton').forEach(el => el.classList.remove('dp-skeleton'));
}

/* ══════════════════════════════════════════════════════════════════════════════
   MAIN ENTRY POINT
   ══════════════════════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', async () => {
  const root = document.getElementById('popup-root');
  if (!root) return;

  /* 1. Render HTML structure immediately */
  root.innerHTML = buildPopupHTML();

  /* 2. Apply skeleton shimmers while data loads */
  applySkeletons();

  /* 3. Fetch data in parallel */
  const [store, metrics] = await Promise.all([
    getStorage(),
    getLiveMetrics(),
  ]);

  /* 4. Populate UI */
  removeSkeletons();
  renderLive(metrics);
  renderStats(store);
  bindSettings(store);
});
