# Decruft — Test Suite

This directory is reserved for QA agent-authored tests.

## Planned test files

| File | Purpose |
|------|---------|
| `unit/selectors.test.js` | Validate each selector in `config/selectors.json` resolves on a live claude.ai snapshot |
| `unit/background.test.js` | Unit tests for background service worker message handling |
| `unit/content.test.js` | Unit tests for content script DOM observation logic |
| `integration/popup.test.js` | Puppeteer/Playwright E2E popup tests |
| `integration/widget.test.js` | Widget mount/unmount lifecycle tests |

## Test runner

The project will use [Jest](https://jestjs.io/) with [jest-chrome](https://github.com/extend-chrome/jest-chrome)
for mocking Chrome extension APIs.

```bash
npm install --save-dev jest jest-chrome
npm test
```
