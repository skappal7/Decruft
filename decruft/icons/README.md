# Decruft — Icons

## Required files
The extension manifest references four PNG icons:

| File          | Size    |
|---------------|---------|
| `icon16.png`  | 16×16   |
| `icon32.png`  | 32×32   |
| `icon48.png`  | 48×48   |
| `icon128.png` | 128×128 |

## Generating the icons

A Node.js generator script is included. It uses the `canvas` package (native
bindings — no browser required).

```bash
# 1. Install the canvas package (one-time setup)
npm install canvas

# 2. Run the generator from the repo root
node icons/generate-icons.js
```

The script will create all four PNG files in this directory.

## Design

- **Background**: deep navy `#1a1a2e` with a rounded-rectangle crop
- **Lettermark**: white bold "D"
- **Accent dot**: orange `#f97316` in the top-right corner (represents a
  staleness indicator / notification badge)

## Replacing with production artwork

Drop replacement PNGs here with the exact filenames above and they will be
picked up by the extension automatically. No changes to `manifest.json` needed.
