// Renders the built-in presets and compares them with the reference masks in reference/,
// then round-trips every export format through the browser PNG encoder.
// Usage: npm test   (Node 18+, which provides the same CompressionStream the browser uses)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { renderAlpha, normalizeDoc, alphaToFormat } from '../public/js/core.js';
import { BUILTIN_PRESETS } from '../public/js/presets.js';
import { encodePNG } from '../public/js/png.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'reference');

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Minimal 8-bit non-interlaced PNG decoder (test-only).
function decodePNG(buf) {
  buf = Buffer.from(buf);
  let pos = 8, width = 0, height = 0, channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = { 0: 1, 4: 2, 2: 3, 6: 4 }[data[9]];
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels, out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[dst + i - channels] : 0, b = y ? out[dst - stride + i] : 0;
      const c = y && i >= channels ? out[dst - stride + i - channels] : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      out[dst + i] = (raw[src + i] + pred) & 0xff;
    }
  }
  return { width, height, channels, data: out };
}
const cases = [
  ['edge_fade_alpha.png', 'Edge fade (all sides)'],
  ['edge_fade_leftright_alpha.png', 'Edge fade (left/right)'],
  ['edge_fade_topbottom_alpha.png', 'Edge fade (top/bottom)'],
  ['soft_vignette_alpha.png', 'Soft vignette'],
  ['edge_fade_key.png', 'Edge fade (all sides)'],
];

let failed = 0, ran = 0;
for (const [file, preset] of cases) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) continue;
  ran++;
  const ref = decodePNG(fs.readFileSync(p));
  const doc = normalizeDoc({ ...BUILTIN_PRESETS[preset](), width: ref.width, height: ref.height, dither: false });
  const t0 = performance.now();
  const alpha = renderAlpha(doc);
  const ms = performance.now() - t0;
  const refA = new Uint8Array(ref.width * ref.height);
  for (let i = 0; i < refA.length; i++) refA[i] = ref.data[i * ref.channels + (ref.channels === 4 ? 3 : 0)];
  let maxDiff = 0, sum = 0;
  for (let i = 0; i < refA.length; i++) {
    const d = Math.abs(refA[i] - alpha[i]);
    sum += d;
    if (d > maxDiff) maxDiff = d;
  }
  const mean = sum / refA.length;
  const ok = mean < 1 && maxDiff <= 4;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file.padEnd(32)} preset="${preset}"  mean|Δ|=${mean.toFixed(3)}  max|Δ|=${maxDiff}  render=${ms.toFixed(0)}ms`);
}

// Encoder round-trip for every channel layout.
const doc = normalizeDoc({ ...BUILTIN_PRESETS['Soft vignette'](), width: 257, height: 131 });
const alpha = renderAlpha(doc);
for (const fmt of ['alpha', 'key', 'alpha-black', 'gray']) {
  const px = alphaToFormat(alpha, fmt);
  const ch = px.length / alpha.length;
  const back = decodePNG(await encodePNG(px, 257, 131, ch));
  const same = back.channels === ch && Buffer.compare(Buffer.from(back.data), Buffer.from(px)) === 0;
  if (!same) failed++;
  console.log(`${same ? 'PASS' : 'FAIL'}  PNG round-trip ${fmt}`);
}

console.log(ran ? '' : '(reference PNGs not found, skipped image comparisons)');
process.exit(failed ? 1 : 0);
