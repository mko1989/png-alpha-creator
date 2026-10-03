// Dependency-free PNG encoder (8-bit, non-interlaced). Compression uses the platform's
// CompressionStream('deflate'), which emits the zlib stream PNG expects. Works in browsers,
// workers and Node 18+.

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Residual cost of a filtered byte (minimum-sum-of-absolute-differences heuristic).
const cost = (v) => (v < 128 ? v : 256 - v);

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const COLOR_TYPE = { 1: 0, 2: 4, 3: 2, 4: 6 }; // channels -> PNG color type

/**
 * @param pixels Uint8Array, row-major, `channels` bytes per pixel
 * @param channels 1 (gray), 2 (gray+alpha), 3 (RGB), 4 (RGBA)
 * @returns Promise<Uint8Array> PNG file bytes
 */
export async function encodePNG(pixels, width, height, channels) {
  const bpp = channels, stride = width * bpp;
  const raw = new Uint8Array((stride + 1) * height);
  const zero = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : zero;
    // Adaptive filtering: Sub / Up / Paeth cover smooth masks well; pick the cheapest per row.
    let sSub = 0, sUp = 0, sPaeth = 0;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0, x = row[i];
      sSub += cost((x - a) & 0xff);
      sUp += cost((x - b) & 0xff);
      sPaeth += cost((x - paeth(a, b, c)) & 0xff);
    }
    const f = sUp <= sSub && sUp <= sPaeth ? 2 : sSub <= sPaeth ? 1 : 4;
    const o = y * (stride + 1);
    raw[o] = f;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const pred = f === 1 ? a : f === 2 ? prev[i] : paeth(a, prev[i], i >= bpp ? prev[i - bpp] : 0);
      raw[o + 1 + i] = row[i] - pred;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = COLOR_TYPE[channels];
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}
