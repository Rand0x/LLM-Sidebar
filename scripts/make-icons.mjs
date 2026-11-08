#!/usr/bin/env node
// Procedurally renders the extension icons (src/icons/icon-{16,32,48,128}.png) without any
// dependencies: signed-distance shapes, supersampled for anti-aliasing, PNG written by hand.
//
//   node scripts/make-icons.mjs [outDir]

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

export const ICON_SIZES = [16, 32, 48, 128];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'src', 'icons');

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Encodes 8-bit RGBA pixels (row-major, length width*height*4) as a PNG Buffer.
 * Each scanline uses the filter with the smallest sum of absolute values (standard heuristic).
 */
export function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('encodePng: ungültige Bildgröße.');
  }
  if (!rgba || rgba.length !== width * height * 4) throw new RangeError('encodePng: Pixelpuffer hat die falsche Länge.');
  const bpp = 4;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  const best = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = y > 0 ? row - stride : -1;
    let bestFilter = 0;
    let bestScore = Infinity;
    for (let filter = 0; filter < 5; filter++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const cur = rgba[row + x];
        const left = x >= bpp ? rgba[row + x - bpp] : 0;
        const up = prev >= 0 ? rgba[prev + x] : 0;
        const upLeft = prev >= 0 && x >= bpp ? rgba[prev + x - bpp] : 0;
        let value;
        if (filter === 0) value = cur;
        else if (filter === 1) value = cur - left;
        else if (filter === 2) value = cur - up;
        else if (filter === 3) value = cur - ((left + up) >> 1);
        else value = cur - paeth(left, up, upLeft);
        value &= 0xff;
        candidate[x] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
        candidate.copy(best);
      }
    }
    const out = y * (stride + 1);
    raw[out] = bestFilter;
    best.copy(raw, out + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Signed-distance helpers (coordinates normalised to 0..1, y pointing down)
// ---------------------------------------------------------------------------

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

function sdRoundBox(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const e0x = bx - ax, e0y = by - ay;
  const e1x = cx - bx, e1y = cy - by;
  const e2x = ax - cx, e2y = ay - cy;
  const v0x = px - ax, v0y = py - ay;
  const v1x = px - bx, v1y = py - by;
  const v2x = px - cx, v2y = py - cy;
  const t0 = clamp01((v0x * e0x + v0y * e0y) / (e0x * e0x + e0y * e0y));
  const t1 = clamp01((v1x * e1x + v1y * e1y) / (e1x * e1x + e1y * e1y));
  const t2 = clamp01((v2x * e2x + v2y * e2y) / (e2x * e2x + e2y * e2y));
  const q0x = v0x - e0x * t0, q0y = v0y - e0y * t0;
  const q1x = v1x - e1x * t1, q1y = v1y - e1y * t1;
  const q2x = v2x - e2x * t2, q2y = v2y - e2y * t2;
  const s = Math.sign(e0x * e2y - e0y * e2x);
  const d = Math.min(q0x * q0x + q0y * q0y, q1x * q1x + q1y * q1y, q2x * q2x + q2y * q2y);
  const w = Math.min(s * (v0x * e0y - v0y * e0x), s * (v1x * e1y - v1y * e1x), s * (v2x * e2y - v2y * e2x));
  return -Math.sqrt(d) * Math.sign(w);
}

function smoothUnion(a, b, k) {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return mix(b, a, h) - k * h * (1 - h);
}

// 4-point sparkle: superellipse |x/sx|^k + |y/sy|^k <= 1 with k < 1 gives concave sides.
function insideSparkle(px, py, s) {
  if (!s) return false;
  const x = Math.abs(px - s.cx) / s.sx;
  const y = Math.abs(py - s.cy) / s.sy;
  if (x > 1 || y > 1) return false;
  return x ** s.k + y ** s.k <= 1;
}

// ---------------------------------------------------------------------------
// Icon design
// ---------------------------------------------------------------------------

const TOP_LEFT = [0x7c, 0x6c, 0xff]; // #7c6cff
const BOTTOM_RIGHT = [0x4f, 0x46, 0xe5]; // #4f46e5
const BUBBLE_TOP = [0xff, 0xff, 0xff];
const BUBBLE_BOTTOM = [0xee, 0xec, 0xff];

/** Size-dependent geometry: small icons get a bigger, simpler glyph. */
export function iconLayout(size) {
  if (size <= 16) {
    return {
      inset: 0, radius: 0.25,
      body: { cx: 0.5, cy: 0.45, hx: 0.375, hy: 0.285, r: 0.16 },
      tail: [[0.2, 0.6], [0.47, 0.66], [0.17, 0.9]], tailBlend: 0.04,
      sparkle: { cx: 7.5 / 16, cy: 7.5 / 16, sx: 0.17, sy: 0.205, k: 0.72 },
      mini: null, shadow: 0, highlight: 0.06,
    };
  }
  if (size <= 32) {
    return {
      inset: 0.03, radius: 0.24,
      body: { cx: 0.5, cy: 0.455, hx: 0.335, hy: 0.25, r: 0.14 },
      tail: [[0.24, 0.6], [0.45, 0.65], [0.2, 0.84]], tailBlend: 0.035,
      sparkle: { cx: 0.5, cy: 0.455, sx: 0.155, sy: 0.18, k: 0.72 },
      mini: null, shadow: 0.12, highlight: 0.08,
    };
  }
  const large = size >= 96;
  return {
    inset: large ? 0.0625 : 0.04, radius: 0.23,
    body: { cx: 0.5, cy: 0.46, hx: 0.3, hy: 0.225, r: 0.13 },
    tail: [[0.27, 0.6], [0.45, 0.64], [0.235, 0.795]], tailBlend: 0.03,
    sparkle: { cx: 0.47, cy: 0.47, sx: 0.12, sy: 0.15, k: 0.62 },
    mini: { cx: 0.635, cy: 0.355, sx: 0.045, sy: 0.055, k: 0.62 },
    shadow: 0.2, highlight: 0.1,
  };
}

function sampleIcon(u, v, L) {
  // Rounded app square
  const half = 0.5 - L.inset;
  const sdSquare = sdRoundBox(u - 0.5, v - 0.5, half, half, L.radius * (half * 2));
  if (sdSquare > 0) return null;

  // Diagonal gradient across the square + soft highlight in the upper left
  const t = clamp01(((u - L.inset) + (v - L.inset)) / (2 * half * 2));
  let r = mix(TOP_LEFT[0], BOTTOM_RIGHT[0], t);
  let g = mix(TOP_LEFT[1], BOTTOM_RIGHT[1], t);
  let b = mix(TOP_LEFT[2], BOTTOM_RIGHT[2], t);
  const hl = L.highlight * (1 - smoothstep(0, 0.75, Math.hypot(u - 0.22, v - 0.12)));
  r = mix(r, 255, hl);
  g = mix(g, 255, hl);
  b = mix(b, 255, hl);

  const { body } = L;
  const bubbleAt = (x, y) => smoothUnion(
    sdRoundBox(x - body.cx, y - body.cy, body.hx, body.hy, body.r),
    sdTriangle(x, y, ...L.tail),
    L.tailBlend,
  );
  const sdBubble = bubbleAt(u, v);
  const inSparkle = insideSparkle(u, v, L.sparkle) || insideSparkle(u, v, L.mini);

  if (sdBubble <= 0 && !inSparkle) {
    const bt = clamp01((v - (body.cy - body.hy)) / (2 * body.hy + 0.15));
    return [mix(BUBBLE_TOP[0], BUBBLE_BOTTOM[0], bt), mix(BUBBLE_TOP[1], BUBBLE_BOTTOM[1], bt), mix(BUBBLE_TOP[2], BUBBLE_BOTTOM[2], bt)];
  }
  if (sdBubble > 0 && L.shadow > 0) {
    // Soft drop shadow below the bubble
    const sd = bubbleAt(u, v - 0.03);
    const shade = L.shadow * (1 - smoothstep(-0.02, 0.07, sd));
    r *= 1 - shade;
    g *= 1 - shade;
    b *= 1 - shade;
  }
  return [r, g, b];
}

/** Renders one icon as RGBA (Uint8Array, size*size*4) with ss×ss supersampling. */
export function renderIcon(size, { ss = 8 } = {}) {
  const L = iconLayout(size);
  const out = new Uint8Array(size * size * 4);
  const samples = ss * ss;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let ar = 0, ag = 0, ab = 0, coverage = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (px + (sx + 0.5) / ss) / size;
          const v = (py + (sy + 0.5) / ss) / size;
          const c = sampleIcon(u, v, L);
          if (!c) continue;
          ar += c[0];
          ag += c[1];
          ab += c[2];
          coverage++;
        }
      }
      const i = (py * size + px) * 4;
      if (coverage) {
        out[i] = Math.round(ar / coverage);
        out[i + 1] = Math.round(ag / coverage);
        out[i + 2] = Math.round(ab / coverage);
        out[i + 3] = Math.round((coverage / samples) * 255);
      }
    }
  }
  return out;
}

export function renderIconPng(size) {
  return encodePng(size, size, renderIcon(size));
}

function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  if (metaUrl === pathToFileURL(path.resolve(entry)).href) return true;
  try {
    const a = realpathSync(fileURLToPath(metaUrl));
    const b = realpathSync(path.resolve(entry));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

function main() {
  const outDir = path.resolve(process.argv[2] ?? DEFAULT_OUT_DIR);
  mkdirSync(outDir, { recursive: true });
  for (const size of ICON_SIZES) {
    const file = path.join(outDir, `icon-${size}.png`);
    const png = renderIconPng(size);
    writeFileSync(file, png);
    console.log(`Icon geschrieben: ${file} (${png.length} Bytes)`);
  }
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`Icons konnten nicht erzeugt werden: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}
