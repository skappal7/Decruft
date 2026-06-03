/**
 * Decruft — Pure Node.js Icon Generator
 * ═════════════════════════════════════
 * Generates valid PNG icons at 16, 32, 48, and 128px in pure JS.
 * Zero external dependencies (no npm 'canvas' package required!).
 * Uses built-in 'zlib' and CRC-32 calculation.
 *
 * Design: Dark background (#1a1a2e), white letter "D" lettermark, and a
 * bright orange status dot (#f97316) representing optimized context.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Sizes required by manifest.json
const SIZES = [16, 32, 48, 128];

// CRC-32 table and helper
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let k = n;
  for (let j = 0; j < 8; j++) {
    if (k & 1) k = 0xedb88320 ^ (k >>> 1);
    else k = k >>> 1;
  }
  crcTable[n] = k;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const typeAndData = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crcBuf]);
}

/**
 * Generate a PNG image in buffer format using mathematical styling.
 */
function generateDecruftIcon(size) {
  const signature = Buffer.from('\x89PNG\r\n\x1a\n', 'binary');
  
  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0); // Width
  ihdrData.writeUInt32BE(size, 4); // Height
  ihdrData[8] = 8; // 8 bits per channel
  ihdrData[9] = 6; // RGBA color type (6)
  ihdrData[10] = 0; // deflate
  ihdrData[11] = 0; // filter method 0
  ihdrData[12] = 0; // no interlace
  
  const ihdr = makeChunk('IHDR', ihdrData);
  
  // Prepare scanlines. PNG scanlines begin with a filter byte (0 for none)
  const rowSize = size * 4 + 1;
  const rawData = Buffer.alloc(rowSize * size);
  
  // Math styling coordinates (0 to 1 range)
  for (let y = 0; y < size; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter byte: None (0)
    
    const v = y / size;
    
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const pixelOffset = rowOffset + 1 + x * 4;
      
      // Default: transparent/none
      let r = 0, g = 0, b = 0, a = 0;
      
      // Rounded corner check (rounded rect background)
      const radius = 0.15;
      let drawBg = true;
      
      // Top-Left corner rounded corner
      if (u < radius && v < radius) {
        const dx = u - radius;
        const dy = v - radius;
        if (dx*dx + dy*dy > radius*radius) drawBg = false;
      }
      // Top-Right
      else if (u > 1 - radius && v < radius) {
        const dx = u - (1 - radius);
        const dy = v - radius;
        if (dx*dx + dy*dy > radius*radius) drawBg = false;
      }
      // Bottom-Left
      else if (u < radius && v > 1 - radius) {
        const dx = u - radius;
        const dy = v - (1 - radius);
        if (dx*dx + dy*dy > radius*radius) drawBg = false;
      }
      // Bottom-Right
      else if (u > 1 - radius && v > 1 - radius) {
        const dx = u - (1 - radius);
        const dy = v - (1 - radius);
        if (dx*dx + dy*dy > radius*radius) drawBg = false;
      }
      
      if (drawBg) {
        // Background color: #1a1a2e (26, 26, 46)
        r = 26;
        g = 26;
        b = 46;
        a = 255;
        
        // Orange status dot: center at (0.78, 0.22), radius 0.12
        const dotCenterX = 0.78;
        const dotCenterY = 0.22;
        const dotRadius  = 0.12;
        const dotDx = u - dotCenterX;
        const dotDy = v - dotCenterY;
        const dotDist = Math.sqrt(dotDx*dotDx + dotDy*dotDy);
        
        if (size >= 32 && dotDist < dotRadius) {
          // Orange color: #f97316 (249, 115, 22)
          r = 249;
          g = 115;
          b = 22;
          a = 255;
        } else {
          // Draw "D" lettermark in white inside the background
          // Left stem
          const inStem = (u >= 0.28 && u <= 0.36 && v >= 0.25 && v <= 0.75);
          // Top bar
          const inTop = (u >= 0.28 && u <= 0.52 && v >= 0.25 && v <= 0.33);
          // Bottom bar
          const inBottom = (u >= 0.28 && u <= 0.52 && v >= 0.67 && v <= 0.75);
          // Curved right side
          const curveCenterX = 0.42;
          const curveCenterY = 0.50;
          const curveDx = u - curveCenterX;
          const curveDy = v - curveCenterY;
          const curveDist = Math.sqrt(curveDx*curveDx + curveDy*curveDy);
          const inCurve = (u >= curveCenterX && curveDist >= 0.20 && curveDist <= 0.28);
          
          if (inStem || inTop || inBottom || inCurve) {
            r = 255;
            g = 255;
            b = 255;
            a = 255;
          }
        }
      }
      
      rawData[pixelOffset] = r;
      rawData[pixelOffset + 1] = g;
      rawData[pixelOffset + 2] = b;
      rawData[pixelOffset + 3] = a;
    }
  }
  
  const compressed = zlib.deflateSync(rawData);
  const idat = makeChunk('IDAT', compressed);
  const iend = makeChunk('IEND', Buffer.alloc(0));
  
  return Buffer.concat([signature, ihdr, idat, iend]);
}

// Write the icons
const iconsDir = __dirname;
SIZES.forEach((size) => {
  const fileBuffer = generateDecruftIcon(size);
  const outPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(outPath, fileBuffer);
  console.log(`✔ Created pure PNG: ${outPath} (${size}x${size})`);
});

console.log('\n✅ All icons generated successfully in pure JavaScript!');
