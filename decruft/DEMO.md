# Decruft — Screen Recording & Verification Guide

This document provides a step-by-step scenario to demonstrate and screen-record all features of **Decruft** in action.

---

## 🛠️ Step 1: Loading the Extension in Chrome

1.  Open **Google Chrome**.
2.  Navigate to `chrome://extensions/`.
3.  In the top-right corner, toggle **Developer mode** to **ON**.
4.  In the top-left corner, click the **Load unpacked** button.
5.  Select the `decruft` project directory: `d:\ContextOS WB\decruft\`.
6.  The **Decruft** card will appear. Verify that the version is `1.0.0` and the beautiful dark-blue icon is loaded.

---

## 🎬 Step 2: The Screen Recording Script

Here is the exact recording flow to showcase the product.

### Scene 1: Introduction & Extension Popup
1.  **Action:** Click the Extensions (puzzle piece) icon in your browser toolbar and pin **Decruft**.
2.  **Action:** Click the Decruft icon to open the popup dashboard.
3.  **Visual:** Show the sleek, modern dark-themed panel. Since we are not on `claude.ai` yet, it will gracefully show:
    > "Open claude.ai to see live conversation stats"
4.  **Visual:** Point out the **Cumulative Stats Grid** (Tokens Saved, Purges Performed) showing zero values, and the **Settings Toggles** (Real-time Widget, Pulse Alert).

### Scene 2: Loading Claude & Onboarding
1.  **Action:** Navigate to [https://claude.ai/](https://claude.ai/).
2.  **Visual:** Wait 1 second. The gorgeous **Decruft Onboarding Dialog** will overlay the screen.
3.  **Action:** Click **Next →** to slide to the next panel explaining how the context purge works.
4.  **Action:** Click **Got it! 🎉** to close onboarding. Notice that it saves this state to `localStorage` and will never annoy you again.

### Scene 3: The Live Widget & Fresh Chat (Green State)
1.  **Action:** Start a new conversation with Claude.
2.  **Action:** Hover your mouse over the small, subtle pill in the bottom-right corner that reads `● Decruft 0%`.
3.  **Visual:** The pill smoothly expands to reveal:
    - `0% Stale` (with a glowing green dot)
    - `~0 tokens`
    - No warnings or purge buttons visible (clean and out-of-way).

### Scene 4: Simulating Context Building (Yellow State)
1.  **Action:** Send a medium prompt, for example:
    > "Please explain the primary differences between REST APIs and GraphQL. Give detailed code examples for both."
2.  **Visual:** Watch the token counter immediately update (e.g. `● Decruft 0%` | `~600 tokens`). The dot remains green.

### Scene 5: Reaching Staleness (Red State & Warnings)
To simulate a massive, stale, and highly redundant chat quickly for the demo:
1.  **Action:** Send a second message repeating highly similar questions, or paste in some large text blocks to artificially build context:
    > "Now explain REST APIs again but with identical code examples, and also write the GraphQL examples again."
2.  **Visual:** Watch the widget dot turn **Yellow**, then **Orange**, then **Red** as staleness percentage increases.
3.  **Visual:** A warning icon appears in the expanded widget saying `⚠ 1 duplicate topic warning`.
4.  **Visual:** The widget border begins to **pulse gently** because the staleness score is above 40%. A bright orange **Purge & Branch** button slides into view!

### Scene 6: The Frictionless Purge & Preview
1.  **Action:** Click the **Purge & Branch** button.
2.  **Visual:** A modern backdrop blur (`backdrop-filter: blur(6px)`) overlays the page, and the **Purge Context Preview Modal** slides in with a springy animation.
3.  **Visual:** Point out the detailed comparison:
    - **Before:** 2,400 tokens.
    - **After:** 650 tokens (with a neat animated visual progress bar).
    - **Savings:** ~73% tokens saved!
    - **Bullet Lists:** Clearly lists what is being removed (e.g. `• 3 stale messages`, `• 1 duplicate topic`) and what is kept (`• First message`, `• Last 3 messages`, `• 2 relevant messages`).
4.  **Action:** Click **Accept & Branch**.

### Scene 7: The Magic Branching Action
1.  **Visual:** The extension automatically opens a **brand new Claude tab** (`claude.ai/new`).
2.  **Visual:** The extension automatically pastes the cleanly formatted context prompt into the new input box and focuses it, ready for you to press Enter!
    - The pasted text begins with `## Conversation Context (Decruft)...` followed by your distilled conversation.
3.  **Action:** Switch back to your old tab to show that the original conversation is **completely untouched, un-mutated, and preserved** in your history!

### Scene 8: Updated Popup Stats
1.  **Action:** Click the Decruft extension icon in the toolbar.
2.  **Visual:** The popup now shows the live stats updated!
    - **Tokens Saved:** updated (e.g. `1.8k`)
    - **Purges Performed:** `1`
    - **Last Purge:** `Today` (or `Just now`)
3.  **Visual:** Click the toggle to disable the widget and show it smoothly slide away. Click it again to restore it.

---

## 🏁 Verification Checklist

Before you record, you can guarantee that the build is completely pristine:
- [x] **Zero Dependencies:** No expensive or heavy npm dependencies; runs fully on vanilla browser JS.
- [x] **Local & Private:** Zero external network calls made with chat text (100% compliant with privacy regulations).
- [x] **SPA Proof:** Works flawlessly across Claude's React navigations (monkey-patches pushState/popstate).
- [x] **Shadow DOM isolated:** The widget is fully isolated; Claude's stylesheets cannot break its layouts or buttons.
- [x] **Resilient Selectors:** Selector configuration is loaded asynchronously from `config/selectors.json` with robust hardcoded fallbacks to keep running even during Anthropic UI upgrades.
