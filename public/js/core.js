// Shared mask renderer. Runs unchanged in the browser (main thread + worker) and in Node (export API).
//
// Geometry is stored resolution-independent:
//   unit 'x'  -> fraction of document width
//   unit 'y'  -> fraction of document height
//   unit 's'  -> fraction of the shorter side (isotropic distances: feathers, fades, radii)
// so a mask keeps its look when the output resolution changes.

export const MAX_SIDE = 16384;

export const CURVES = [
  ['smooth', 'Smooth'],
  ['linear', 'Linear'],
  ['smoother', 'Smoother'],
  ['easeIn', 'Ease in'],
  ['easeOut', 'Ease out'],
  ['sine', 'Sine'],
  ['gaussian', 'Gaussian'],
];

const CURVE_FNS = {
  linear: (t) => t,
  smooth: (t) => t * t * (3 - 2 * t),
  smoother: (t) => t * t * t * (t * (t * 6 - 15) + 10),
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  sine: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),
  gaussian: (t) => (Math.exp(-4.5 * (1 - t) * (1 - t)) - Math.exp(-4.5)) / (1 - Math.exp(-4.5)),
};

export const BLENDS = [
  ['add', 'Add'],
  ['subtract', 'Subtract'],
  ['multiply', 'Multiply (intersect)'],
  ['lighten', 'Lighten (max)'],
  ['darken', 'Darken (min)'],
  ['difference', 'Difference'],
];

const ALIGNS = [
  ['inside', 'Inside edge'],
  ['center', 'Centered on edge'],
  ['outside', 'Outside edge'],
];

const CURVE_PARAM = { key: 'curve', label: 'Curve', type: 'select', options: CURVES, def: 'smooth' };
const POWER_PARAM = { key: 'power', label: 'Falloff power', unit: 'num', min: 0.1, max: 10, def: 1, log: true };
const CX = { key: 'cx', label: 'Center X', unit: 'x', min: 0, max: 1, def: 0.5 };
const CY = { key: 'cy', label: 'Center Y', unit: 'y', min: 0, max: 1, def: 0.5 };
const ROT = { key: 'rotation', label: 'Rotation', unit: 'deg', min: -180, max: 180, def: 0 };

// Edge fade default = 150 px on a 1080 px short side (matches the reference masks).
const EDGE_DEF = 150 / 1080;

export const SHAPES = {
  edge: {
    label: 'Edge fade',
    params: [
      { key: 'all', label: 'All sides', unit: 's', min: 0, max: 0.5, def: EDGE_DEF, virtual: true,
        get: (l) => Math.max(l.left, l.right, l.top, l.bottom),
        set: (l, v) => { l.left = l.right = l.top = l.bottom = v; } },
      { key: 'left', label: 'Left', unit: 's', min: 0, max: 0.5, def: EDGE_DEF },
      { key: 'right', label: 'Right', unit: 's', min: 0, max: 0.5, def: EDGE_DEF },
      { key: 'top', label: 'Top', unit: 's', min: 0, max: 0.5, def: EDGE_DEF },
      { key: 'bottom', label: 'Bottom', unit: 's', min: 0, max: 0.5, def: EDGE_DEF },
      { key: 'inset', label: 'Inset', unit: 's', min: 0, max: 0.5, def: 0 },
      { key: 'corner', label: 'Corners', type: 'select', def: 'miter',
        options: [['miter', 'Miter'], ['round', 'Round'], ['multiply', 'Multiply']] },
      CURVE_PARAM, POWER_PARAM,
    ],
  },
  rect: {
    label: 'Rectangle',
    params: [
      CX, CY,
      { key: 'w', label: 'Width', unit: 'x', min: 0, max: 1.5, def: 0.6 },
      { key: 'h', label: 'Height', unit: 'y', min: 0, max: 1.5, def: 0.6 },
      { key: 'radius', label: 'Corner radius', unit: 's', min: 0, max: 0.5, def: 0.04 },
      ROT,
      { key: 'feather', label: 'Feather', unit: 's', min: 0, max: 0.5, def: 0.08 },
      { key: 'align', label: 'Feather align', type: 'select', options: ALIGNS, def: 'inside' },
      CURVE_PARAM, POWER_PARAM,
    ],
  },
  ellipse: {
    label: 'Ellipse',
    params: [
      CX, CY,
      { key: 'w', label: 'Width', unit: 'x', min: 0, max: 1.5, def: 0.5 },
      { key: 'h', label: 'Height', unit: 'y', min: 0, max: 1.5, def: 0.6 },
      ROT,
      { key: 'feather', label: 'Feather', unit: 's', min: 0, max: 0.5, def: 0.08 },
      { key: 'align', label: 'Feather align', type: 'select', options: ALIGNS, def: 'inside' },
      CURVE_PARAM, POWER_PARAM,
    ],
  },
  radial: {
    label: 'Vignette',
    params: [
      CX, CY,
      { key: 'w', label: 'Width', unit: 'x', min: 0, max: 3, def: 1.15 },
      { key: 'h', label: 'Height', unit: 'y', min: 0, max: 3, def: 1.15 },
      { key: 'inner', label: 'Solid core', unit: 'pct', min: 0, max: 1, def: 0.35 },
      ROT,
      CURVE_PARAM, POWER_PARAM,
    ],
  },
  linear: {
    label: 'Gradient',
    params: [
      CX, CY,
      { key: 'angle', label: 'Angle', unit: 'deg', min: -180, max: 180, def: 0 },
      { key: 'mode', label: 'Mode', type: 'select', def: 'ramp',
        options: [['ramp', 'Ramp (0 → 1)'], ['band', 'Band (stripe)']] },
      { key: 'width', label: 'Band width', unit: 's', min: 0, max: 2, def: 0.2, showIf: (l) => l.mode === 'band' },
      { key: 'fade', label: 'Fade length', unit: 's', min: 0, max: 2, def: 0.6 },
      CURVE_PARAM, POWER_PARAM,
    ],
  },
};

export const SHAPE_ORDER = ['edge', 'rect', 'ellipse', 'radial', 'linear'];

let idCounter = 0;
export function uid() {
  idCounter = (idCounter + 1) % 1e6;
  return Date.now().toString(36).slice(-5) + idCounter.toString(36) + Math.random().toString(36).slice(2, 5);
}

export function createLayer(type, overrides = {}) {
  const shape = SHAPES[type];
  const layer = { id: uid(), type, name: shape.label, enabled: true, blend: 'add', opacity: 1, invert: false };
  for (const p of shape.params) if (!p.virtual) layer[p.key] = p.def;
  return Object.assign(layer, overrides);
}

export function defaultDoc() {
  return {
    version: 1, width: 1920, height: 1080,
    background: 0, gamma: 1, invert: false, dither: true,
    layers: [createLayer('edge')],
  };
}

const num = (v, d, lo = -1e6, hi = 1e6) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const pick = (v, options, d) => (options.some((o) => o[0] === v) ? v : d);

// Validate/sanitize a document (untrusted input on the server, old autosaves in the browser).
export function normalizeDoc(input) {
  const src = input && typeof input === 'object' ? input : {};
  const doc = {
    version: 1,
    width: Math.round(num(src.width, 1920, 1, MAX_SIDE)),
    height: Math.round(num(src.height, 1080, 1, MAX_SIDE)),
    background: num(src.background, 0, 0, 1),
    gamma: num(src.gamma, 1, 0.05, 20),
    invert: !!src.invert,
    dither: src.dither === undefined ? true : !!src.dither,
    layers: [],
  };
  const layers = Array.isArray(src.layers) ? src.layers.slice(0, 200) : [];
  for (const l of layers) {
    if (!l || !SHAPES[l.type]) continue;
    const out = {
      id: typeof l.id === 'string' && l.id ? l.id.slice(0, 40) : uid(),
      type: l.type,
      name: typeof l.name === 'string' ? l.name.slice(0, 60) : SHAPES[l.type].label,
      enabled: l.enabled === undefined ? true : !!l.enabled,
      blend: pick(l.blend, BLENDS, 'add'),
      opacity: num(l.opacity, 1, 0, 1),
      invert: !!l.invert,
    };
    for (const p of SHAPES[l.type].params) {
      if (p.virtual) continue;
      out[p.key] = p.type === 'select' ? pick(l[p.key], p.options, p.def) : num(l[p.key], p.def);
    }
    out.power = Math.min(10, Math.max(0.1, out.power));
    doc.layers.push(out);
  }
  return doc;
}

// ---------------------------------------------------------------------------------------------
// Rendering

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const LUT_N = 1024;

function makeLut(curve, power) {
  const fn = CURVE_FNS[curve] || CURVE_FNS.smooth;
  const lut = new Float32Array(LUT_N + 2);
  for (let i = 0; i <= LUT_N; i++) lut[i] = clamp01(fn(Math.pow(i / LUT_N, power)));
  lut[LUT_N + 1] = lut[LUT_N];
  return lut;
}

// Each preparer returns fill(tmp, y0, rows) writing the raw ramp parameter t (0..1, 1 = fully inside).
// The curve LUT, layer invert and blending are applied afterwards by the common code.
const PREPARE = {
  edge(l, c) {
    const half = 0.5 * Math.min(c.sx, c.sy);
    const L = Math.max(l.left * c.S, half), R = Math.max(l.right * c.S, half);
    const T = Math.max(l.top * c.S, half), B = Math.max(l.bottom * c.S, half);
    const ins = l.inset * c.S;
    const tx = new Float32Array(c.rw);
    for (let x = 0; x < c.rw; x++) {
      const X = (x + 0.5) * c.sx;
      tx[x] = Math.min(clamp01((X - ins) / L), clamp01((c.W - X - ins) / R));
    }
    const lut = makeLut(l.curve, l.power);
    const mode = l.corner;
    // Edge needs the curve per axis for 'multiply', so it writes final values and flags it.
    const fill = (tmp, y0, rows) => {
      for (let r = 0; r < rows; r++) {
        const Y = (y0 + r + 0.5) * c.sy;
        const ty = Math.min(clamp01((Y - ins) / T), clamp01((c.H - Y - ins) / B));
        const o = r * c.rw;
        if (mode === 'multiply') {
          const vy = lookup(lut, ty);
          for (let x = 0; x < c.rw; x++) tmp[o + x] = lookup(lut, tx[x]) * vy;
        } else if (mode === 'round') {
          const uy = 1 - ty;
          for (let x = 0; x < c.rw; x++) {
            const ux = 1 - tx[x];
            const d = Math.sqrt(ux * ux + uy * uy);
            tmp[o + x] = lookup(lut, d >= 1 ? 0 : 1 - d);
          }
        } else {
          for (let x = 0; x < c.rw; x++) tmp[o + x] = lookup(lut, tx[x] < ty ? tx[x] : ty);
        }
      }
    };
    fill.final = true;
    return fill;
  },

  rect(l, c) {
    const cx = l.cx * c.W, cy = l.cy * c.H;
    const hw = Math.abs(l.w) * c.W / 2, hh = Math.abs(l.h) * c.H / 2;
    const rad = Math.min(Math.max(0, l.radius * c.S), hw, hh);
    const { cos, sin } = rot(l.rotation);
    const f = Math.max(l.feather * c.S, Math.max(c.sx, c.sy));
    const off = alignOffset(l.align, f);
    const ex = hw - rad, ey = hh - rad;
    const bb = bounds(c, cx, cy, Math.hypot(hw, hh) + off);
    const fill = (tmp, y0, rows) => {
      for (let r = 0; r < rows; r++) {
        const y = y0 + r, o = r * c.rw;
        if (!rowSpan(tmp, o, y, bb, c.rw)) continue;
        const dy = (y + 0.5) * c.sy - cy;
        for (let x = bb.x0; x < bb.x1; x++) {
          const dx = (x + 0.5) * c.sx - cx;
          const qx = Math.abs(dx * cos + dy * sin) - ex;
          const qy = Math.abs(-dx * sin + dy * cos) - ey;
          const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0;
          const inner = qx > qy ? qx : qy;
          const d = Math.sqrt(mx * mx + my * my) + (inner < 0 ? inner : 0) - rad;
          tmp[o + x] = clamp01((off - d) / f);
        }
      }
    };
    fill.bb = bb;
    return fill;
  },

  ellipse(l, c) {
    const cx = l.cx * c.W, cy = l.cy * c.H;
    const rx = Math.max(Math.abs(l.w) * c.W / 2, 1e-3), ry = Math.max(Math.abs(l.h) * c.H / 2, 1e-3);
    const { cos, sin } = rot(l.rotation);
    const f = Math.max(l.feather * c.S, Math.max(c.sx, c.sy));
    const off = alignOffset(l.align, f);
    const bb = bounds(c, cx, cy, Math.max(rx, ry) + off);
    // With k = normalized radius, the true distance is at least |k - 1| * min(rx, ry) (the
    // ellipse contains a disk of that radius), which settles most pixels without the solver.
    const irx = 1 / rx, iry = 1 / ry, rmin = Math.min(rx, ry);
    const kOut = 1 + off / rmin, kIn = 1 - (f - off) / rmin;
    const kOut2 = kOut * kOut, kIn2 = kIn > 0 ? kIn * kIn : -1;
    const fill = (tmp, y0, rows) => {
      for (let r = 0; r < rows; r++) {
        const y = y0 + r, o = r * c.rw;
        if (!rowSpan(tmp, o, y, bb, c.rw)) continue;
        const dy = (y + 0.5) * c.sy - cy;
        for (let x = bb.x0; x < bb.x1; x++) {
          const dx = (x + 0.5) * c.sx - cx;
          const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
          const nx = lx * irx, ny = ly * iry, k2 = nx * nx + ny * ny;
          if (k2 >= kOut2) tmp[o + x] = 0;
          else if (k2 <= kIn2) tmp[o + x] = 1;
          else tmp[o + x] = clamp01((off - sdEllipse(lx, ly, rx, ry)) / f);
        }
      }
    };
    fill.bb = bb;
    return fill;
  },

  radial(l, c) {
    const cx = l.cx * c.W, cy = l.cy * c.H;
    const rx = Math.max(Math.abs(l.w) * c.W / 2, 1e-3), ry = Math.max(Math.abs(l.h) * c.H / 2, 1e-3);
    const { cos, sin } = rot(l.rotation);
    // Keep at least ~1 px of transition so a 100% core still anti-aliases.
    const maxInner = 1 - Math.max(c.sx, c.sy) / Math.min(rx, ry);
    const inner = Math.min(clamp01(l.inner), Math.max(0, maxInner));
    const span = 1 - inner;
    const irx = 1 / rx, iry = 1 / ry;
    const bb = bounds(c, cx, cy, Math.max(rx, ry));
    const fill = (tmp, y0, rows) => {
      for (let r = 0; r < rows; r++) {
        const y = y0 + r, o = r * c.rw;
        if (!rowSpan(tmp, o, y, bb, c.rw)) continue;
        const dy = (y + 0.5) * c.sy - cy;
        for (let x = bb.x0; x < bb.x1; x++) {
          const dx = (x + 0.5) * c.sx - cx;
          const lx = (dx * cos + dy * sin) * irx, ly = (-dx * sin + dy * cos) * iry;
          tmp[o + x] = clamp01((1 - Math.sqrt(lx * lx + ly * ly)) / span);
        }
      }
    };
    fill.bb = bb;
    return fill;
  },

  linear(l, c) {
    const cx = l.cx * c.W, cy = l.cy * c.H;
    const a = (l.angle * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
    const f = Math.max(l.fade * c.S, Math.max(c.sx, c.sy));
    const band = l.mode === 'band', hwid = Math.max(0, l.width * c.S) / 2;
    return (tmp, y0, rows) => {
      for (let r = 0; r < rows; r++) {
        const pyy = ((y0 + r + 0.5) * c.sy - cy) * uy;
        const o = r * c.rw;
        for (let x = 0; x < c.rw; x++) {
          const p = ((x + 0.5) * c.sx - cx) * ux + pyy;
          tmp[o + x] = band ? clamp01(1 - (Math.abs(p) - hwid) / f) : clamp01(p / f + 0.5);
        }
      }
    };
  },
};

// Signed distance to an axis-aligned ellipse with semi-axes a, b (negative inside).
// Closest point by 3 fixed-point iterations of the evolute method; accurate far from the
// boundary too, so wide feathers stay evenly spaced even on very elongated ellipses.
function sdEllipse(px, py, a, b) {
  px = Math.abs(px);
  py = Math.abs(py);
  if (px + py < 1e-9) return -Math.min(a, b);
  const k = (a * a - b * b);
  let tx = 0.70710678, ty = 0.70710678;
  for (let i = 0; i < 3; i++) {
    const ex = (k * tx * tx * tx) / a, ey = (-k * ty * ty * ty) / b;
    const rx = a * tx - ex, ry = b * ty - ey;
    const qx = px - ex, qy = py - ey;
    const rq = Math.sqrt(rx * rx + ry * ry) / (Math.sqrt(qx * qx + qy * qy) || 1e-12);
    tx = Math.min(1, Math.max(0, (qx * rq + ex) / a));
    ty = Math.min(1, Math.max(0, (qy * rq + ey) / b));
    const t = Math.sqrt(tx * tx + ty * ty) || 1;
    tx /= t;
    ty /= t;
  }
  const dx = px - a * tx, dy = py - b * ty;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return (px * px) / (a * a) + (py * py) / (b * b) < 1 ? -dist : dist;
}

// Render-pixel box outside of which a centered shape of reach R (doc px) is exactly 0.
function bounds(c, cx, cy, R) {
  R += Math.max(c.sx, c.sy);
  const cl = (v, hi) => Math.min(hi, Math.max(0, v));
  return {
    x0: cl(Math.floor((cx - R) / c.sx), c.rw), x1: cl(Math.ceil((cx + R) / c.sx), c.rw),
    y0: cl(Math.floor((cy - R) / c.sy), c.rh), y1: cl(Math.ceil((cy + R) / c.sy), c.rh),
  };
}

// Zero the parts of row y outside the box; returns false when the whole row is outside.
function rowSpan(tmp, o, y, bb, rw) {
  if (y < bb.y0 || y >= bb.y1 || bb.x0 >= bb.x1) { tmp.fill(0, o, o + rw); return false; }
  if (bb.x0 > 0) tmp.fill(0, o, o + bb.x0);
  if (bb.x1 < rw) tmp.fill(0, o + bb.x1, o + rw);
  return true;
}

function lookup(lut, t) {
  const p = t * LUT_N, i = p | 0;
  return lut[i] + (lut[i + 1] - lut[i]) * (p - i);
}

function rot(deg) {
  const a = (deg * Math.PI) / 180;
  return { cos: Math.cos(a), sin: Math.sin(a) };
}

function alignOffset(align, f) {
  return align === 'outside' ? f : align === 'center' ? f / 2 : 0;
}

function hash01(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Render the mask as 8-bit alpha values.
 * @param doc normalized document
 * @param rw,rh render size (the document size for full quality; smaller for fast previews)
 * @param opts.layers optional override of the layer list (used for thumbnails)
 * @returns Uint8Array of rw*rh alpha values
 */
export function renderAlpha(doc, rw = doc.width, rh = doc.height, opts = {}) {
  rw = Math.max(1, rw | 0);
  rh = Math.max(1, rh | 0);
  const W = doc.width, H = doc.height;
  const c = { W, H, S: Math.min(W, H), sx: W / rw, sy: H / rh, rw, rh };
  const srcLayers = opts.layers || doc.layers;
  const layers = [];
  for (const l of srcLayers) {
    if (!l.enabled || !PREPARE[l.type] || l.opacity <= 0) continue;
    const fill = PREPARE[l.type](l, c);
    layers.push({ fill, final: !!fill.final, lut: fill.final ? null : makeLut(l.curve, l.power), l });
  }

  const out = new Uint8Array(rw * rh);
  const BAND = Math.max(1, Math.min(rh, Math.floor(131072 / rw)));
  const acc = new Float32Array(rw * BAND);
  const tmp = new Float32Array(rw * BAND);
  const bg = opts.background ?? doc.background;
  const gamma = opts.gamma ?? doc.gamma;
  const invG = gamma !== 1 ? 1 / gamma : 0;
  const invert = opts.invert ?? doc.invert;
  const dither = opts.dither ?? doc.dither;

  for (let y0 = 0; y0 < rh; y0 += BAND) {
    const rows = Math.min(BAND, rh - y0), n = rows * rw;
    acc.fill(bg, 0, n);
    for (const { fill, final, lut, l } of layers) {
      fill(tmp, y0, rows);
      // Shapes with a bounding box are exactly 0 outside it, and every curve maps 0 -> 0,
      // so the curve (and identity-at-zero blends) only need to touch the box.
      const bb = fill.bb;
      const r0 = bb ? Math.max(0, bb.y0 - y0) : 0, r1 = bb ? Math.min(rows, bb.y1 - y0) : rows;
      const xa = bb ? bb.x0 : 0, xb = bb ? bb.x1 : rw;
      if (!final) {
        for (let r = r0; r < r1; r++) {
          for (let i = r * rw + xa, e = r * rw + xb; i < e; i++) tmp[i] = lookup(lut, tmp[i]);
        }
      }
      if (l.invert) for (let i = 0; i < n; i++) tmp[i] = 1 - tmp[i];
      if (bb && !l.invert && ZERO_IDENTITY.has(l.blend)) {
        for (let r = r0; r < r1; r++) blend(l.blend, l.opacity, acc, tmp, r * rw + xa, r * rw + xb);
      } else blend(l.blend, l.opacity, acc, tmp, 0, n);
    }
    let i = 0;
    const base = y0 * rw;
    for (let r = 0; r < rows; r++) {
      const y = y0 + r;
      for (let x = 0; x < rw; x++, i++) {
        let a = acc[i];
        a = a < 0 ? 0 : a > 1 ? 1 : a;
        if (invG) a = Math.pow(a, invG);
        if (invert) a = 1 - a;
        const v = a * 255 + (dither ? hash01(x, y) : 0.5);
        out[base + i] = v >= 255 ? 255 : v <= 0 ? 0 : v | 0;
      }
    }
  }
  return out;
}

// Blend modes for which a layer value of 0 leaves the accumulator unchanged.
const ZERO_IDENTITY = new Set(['add', 'subtract', 'lighten', 'difference']);

function blend(mode, o, acc, v, s, e) {
  switch (mode) {
    case 'subtract':
      for (let i = s; i < e; i++) acc[i] *= 1 - v[i] * o;
      break;
    case 'multiply':
      for (let i = s; i < e; i++) acc[i] *= 1 - o * (1 - v[i]);
      break;
    case 'lighten':
      for (let i = s; i < e; i++) { const c = v[i] * o; if (c > acc[i]) acc[i] = c; }
      break;
    case 'darken':
      for (let i = s; i < e; i++) { const c = 1 - o * (1 - v[i]); if (c < acc[i]) acc[i] = c; }
      break;
    case 'difference':
      for (let i = s; i < e; i++) acc[i] = Math.abs(acc[i] - v[i] * o);
      break;
    default: // add (screen-style: never exceeds white, overlapping fades combine smoothly)
      for (let i = s; i < e; i++) acc[i] += (1 - acc[i]) * v[i] * o;
  }
}

/** Alpha -> RGBA (white + alpha) for canvas display. */
export function alphaToRGBA(alpha, rgba = new Uint8ClampedArray(alpha.length * 4)) {
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, alpha.length);
  for (let i = 0; i < alpha.length; i++) u32[i] = (alpha[i] << 24) | 0x00ffffff; // little-endian RGBA
  return rgba;
}

export const EXPORT_FORMATS = {
  alpha: { label: 'Alpha (white + α)', suffix: '_alpha', channels: 4 },
  key: { label: 'Key (B/W matte, RGB)', suffix: '_key', channels: 3 },
  'alpha-black': { label: 'Alpha (black + α)', suffix: '_alpha_black', channels: 4 },
  gray: { label: 'Grayscale (8-bit)', suffix: '_gray', channels: 1 },
};

/** Expand alpha into the pixel layout of an export format. */
export function alphaToFormat(alpha, format) {
  const n = alpha.length;
  switch (format) {
    case 'key': {
      const out = new Uint8Array(n * 3);
      for (let i = 0, j = 0; i < n; i++, j += 3) out[j] = out[j + 1] = out[j + 2] = alpha[i];
      return out;
    }
    case 'gray':
      return alpha;
    case 'alpha-black': {
      const out = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) out[i * 4 + 3] = alpha[i];
      return out;
    }
    default: {
      const out = new Uint8Array(n * 4).fill(255);
      for (let i = 0; i < n; i++) out[i * 4 + 3] = alpha[i];
      return out;
    }
  }
}
