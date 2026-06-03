/**
 * Decruft — Icon Generator
 * ════════════════════════
 * Generates PNG icons at 16, 32, 48, and 128px using the HTML5 Canvas API
 * via the `canvas` npm package.
 *
 * Usage:
 *   npm install canvas
 *   node icons/generate-icons.js
 *
 * Output: icons/icon16.png, icon32.png, icon48.png, icon128.png
 *
 * Design: Dark background (#1a1a2e) with a stylised "D" lettermark and a
 * small orange broom/sweep accent to represent "decluttering" context.
 */

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

// Icon sizes required by manifest.json
const SIZES = [16, 32, 48, 128];

// Brand palette
const BG_COLOR      = '#1a1a2e';   // deep navy
const ACCENT_COLOR  = '#f97316';   // vibrant orange  (Tailwind orange-500)
const TEXT_COLOR    = '#ffffff';   // white lettermark

/**
 * Draw a single Decruft icon onto a canvas context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} size  - canvas width/height in pixels
 */
function drawIcon(ctx, size) {
  const r = size * 0.15;   // rounded-rect corner radius

  // ── Background (rounded rectangle) ──────────────────────────────────────
  ctx.fillStyle = BG_COLOR;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();

  // ── Orange accent circle (top-right) — staleness indicator metaphor ─────
  if (size >= 32) {
    const dotR  = size * 0.12;
    const dotX  = size * 0.78;
    const dotY  = size * 0.22;
    ctx.fillStyle = ACCENT_COLOR;
    ctx.beginPath();
    ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── "D" lettermark ──────────────────────────────────────────────────────
  ctx.fillStyle = TEXT_COLOR;
  const fontSize  = Math.round(size * 0.52);
  const fontWeight = size >= 48 ? '700' : '800';
  ctx.font = `${fontWeight} ${fontSize}px sans-serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  // Nudge the letter slightly left to leave room for the dot at larger sizes
  const nudge = size >= 32 ? -size * 0.06 : 0;
  ctx.fillText('D', size / 2 + nudge, size / 2 + size * 0.04);
}

// ── Main ─────────────────────────────────────────────────────────────────────
const iconsDir = path.join(__dirname);  // script lives in icons/

SIZES.forEach((size) => {
  const canvas = createCanvas(size, size);
  const ctx    = canvas.getContext('2d');

  drawIcon(ctx, size);

  const outPath = path.join(iconsDir, `icon${size}.png`);
  const buffer  = canvas.toBuffer('image/png');
  fs.writeFileSync(outPath, buffer);
  console.log(`✔  Created ${outPath}  (${size}×${size})`);
});

console.log('\n✅  All icons generated successfully.');
