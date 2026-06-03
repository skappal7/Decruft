# 🧹 Decruft — Local Claude.ai Context Monitor & Purger

[![Developed by Data Dojo AI Studio](https://img.shields.io/badge/Developed%20By-Data%20Dojo%20AI%20Studio-orange?style=for-the-badge&logo=ai)](https://github.com/Data-Dojo-AI-Studio)
[![100% Private](https://img.shields.io/badge/Privacy-100%25%20Local-green?style=for-the-badge)](https://github.com/Data-Dojo-AI-Studio/decruft)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

**Decruft** is a privacy-first Chrome Extension that monitors your active Claude.ai conversations in real-time, estimates token usage, detects semantic duplicates, and enables one-click context purging to keep your chats fast, focused, and rate-limit friendly.

---

## 🌟 Why Decruft?

As chats with Claude grow longer, the underlying context window gets bloated. This leads to:
* **Rate Limits:** Reaching your message tally limit rapidly.
* **Performance Drop:** Claude responding slower or starting to forget instructions/code details.
* **Clutter:** Repeating code fragments or topics that are no longer active.

**Decruft solves this** by dynamically analyzing conversation turns locally. When staleness increases, a single click summarizes and branches the active context into a clean, new conversation.

---

## ✨ Features

* **🔢 Token Estimation:** Local, zero-latency tokenizer that estimates token usage dynamically.
* **⚠️ Duplicate Detector:** TF-IDF similarity engine that flags identical/near-identical code blocks or text turns (>75% similarity).
* **📉 Staleness Index:** Tracks when historical messages are no longer relevant to your recent discussion turns.
* **🧹 One-Click Purge & Branch:** Distills the conversation (keeping the first prompt, last few turns, and unique key turns) and automatically branches into a clean new chat window.
* **🔒 100% Private:** Run entirely inside your browser. No external API calls, tracking, or telemetry.

---

## 🛠️ How to Install & Use (Unpacked Developer Mode)

Yes! You can load and run the extension directly from the files in this repository:

### 1. Download or Clone the Repository
Clone the repository to your local machine:
```bash
git clone https://github.com/Data-Dojo-AI-Studio/decruft.git
```
*(Make sure the folder contains `manifest.json`, `src/`, `config/`, and `icons/`)*

### 2. Generate the Extension Icons
Ensure you have the icon assets. Run the automated icon generator:
```bash
cd decruft
npm install canvas
node icons/generate-icons.js
```

### 3. Load Into Chrome
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click the **Load unpacked** button in the top-left corner.
4. Select the `decruft` directory from your computer.

### 4. Start Chatting on Claude
Navigate to [claude.ai](https://claude.ai). The **Decruft** pill will float in the bottom-right corner, updating dynamically as you chat.

---

## 🏗️ Architecture

Decruft runs in sandboxed environments to keep your Claude experience completely safe and responsive:

```
claude.ai Tab (DOM Viewport)
   └── content.js        ← Injected script (tracks message turns & resolves container shifts)
         ↕ (chrome.runtime.sendMessage)
   background.js         ← Service Worker (manages storage states, persistence, routes)
         ↕ (chrome.runtime.sendMessage)
   popup.js / widget.js  ← Isolated Shadow DOM UI (renders metrics & handles user options)
```

---

## 💬 Frequently Asked Questions (FAQs)

#### Q: How does the "Staleness" percentage work?
**A:** Decruft compares older messages against the most recent 5 messages. If key terms from an older message are no longer referenced in the recent window, it is considered "stale." 

#### Q: Why did my staleness percentage drop on its own?
**A:** If you type new messages that re-reference older topics or code blocks, those older messages are marked active again. Adding more relevant messages also dilutes the proportion of stale ones, lowering the overall score.

#### Q: Does Decruft modify or affect Claude's responses?
**A:** **No.** Decruft runs locally in read-only mode on your active DOM. It does not alter your inputs or intercept Claude's responses. It only interacts when you manually click "Purge & Branch" to start a new chat.

#### Q: Where is the "Purge & Branch" button?
**A:** The Purge button only displays when your context staleness exceeds **40%**. Below that threshold, your chat is clean enough that purging is unnecessary.

#### Q: Is my conversation data sent to any servers?
**A:** **Never.** All token counting, duplicate detection, and text parsing are done locally using javascript vectors on your machine. Decruft uses zero telemetry.

---

## 🛡️ License

Distributed under the MIT License. See `LICENSE` for details.

Developed with ❤️ by **[Data Dojo AI Studio](https://github.com/Data-Dojo-AI-Studio)**.
