import {
  SHAPES, SHAPE_ORDER, BLENDS, EXPORT_FORMATS,
  createLayer, defaultDoc, normalizeDoc, renderAlpha, alphaToRGBA, uid,
} from './core.js';
import { BUILTIN_PRESETS } from './presets.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

// Browser storage is a per-viewer convenience only (autosave, last view); everything works without it.
const local = {
  get(k) { try { return JSON.parse(localStorage.getItem('pac.' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('pac.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------------------------------------
// State

let doc = normalizeDoc(local.get('doc') || defaultDoc());
let selectedId = doc.layers.at(-1)?.id ?? null;
let docVersion = 0;
const ui = { view: local.get('view') || 'matte', image: null };
const view = { zoom: 1, x: 0, y: 0, fit: true };

const selected = () => doc.layers.find((l) => l.id === selectedId) || null;

// ---------------------------------------------------------------------------------------------
// History (snapshots on commit: slider release, drag end, structural edits)

const history = { stack: [], index: -1 };

function commit() {
  const snap = JSON.stringify(doc);
  if (history.stack[history.index] === snap) return;
  history.stack.splice(history.index + 1);
  history.stack.push(snap);
  if (history.stack.length > 200) history.stack.shift();
  history.index = history.stack.length - 1;
  local.set('doc', doc);
  updateUndo();
}

function restore(snap) {
  const prevSize = `${doc.width}x${doc.height}`;
  doc = JSON.parse(snap);
  if (!selected()) selectedId = doc.layers.at(-1)?.id ?? null;
  local.set('doc', doc);
  rebuildAll();
  if (`${doc.width}x${doc.height}` !== prevSize) fitView();
  invalidate();
  updateUndo();
}

const undo = () => { if (history.index > 0) restore(history.stack[--history.index]); };
const redo = () => { if (history.index < history.stack.length - 1) restore(history.stack[++history.index]); };

function updateUndo() {
  $('undoBtn').disabled = history.index <= 0;
  $('redoBtn').disabled = history.index >= history.stack.length - 1;
}

// ---------------------------------------------------------------------------------------------
// Controls

function unitInfo(unit) {
  const S = Math.min(doc.width, doc.height);
  switch (unit) {
    case 'x': return { f: doc.width, suf: 'px', dec: 0, step: 1 };
    case 'y': return { f: doc.height, suf: 'px', dec: 0, step: 1 };
    case 's': return { f: S, suf: 'px', dec: 0, step: 1 };
    case 'pct': return { f: 100, suf: '%', dec: 1, step: 1 };
    case 'deg': return { f: 1, suf: '°', dec: 1, step: 1 };
    default: return { f: 1, suf: '', dec: 2, step: 0.05 };
  }
}

const fmtNum = (v, dec) => String(Number(v.toFixed(dec)));

/** Slider + numeric field. Numbers are shown in pixels/%/° but stored normalized. */
function sliderCtrl(spec, get, set) {
  const range = el('input', { type: 'range', min: 0, max: 1000, step: 1 });
  const num = el('input', { type: 'number' });
  const unit = el('span', { className: 'unit' });
  const label = el('label', { textContent: spec.label, title: `Double-click to reset (${spec.label})` });
  const node = el('div', { className: 'ctrl' }, label, range, el('div', { className: 'num' }, num, unit));
  const lo = spec.min, hi = spec.max;
  const toPos = (v) => (spec.log ? (Math.log(v / lo) / Math.log(hi / lo)) * 1000 : ((v - lo) / (hi - lo)) * 1000);
  const fromPos = (p) => (spec.log ? lo * Math.pow(hi / lo, p / 1000) : lo + ((hi - lo) * p) / 1000);

  function sync() {
    const v = get(), u = unitInfo(spec.unit);
    const pos = clamp(toPos(v), 0, 1000);
    range.value = pos;
    range.style.setProperty('--p', pos / 10 + '%');
    if (document.activeElement !== num) num.value = fmtNum(v * u.f, u.dec);
    num.step = u.step;
    unit.textContent = u.suf;
  }
  function apply(v) {
    set(v);
    onEdit();
    sync();
  }
  range.addEventListener('input', () => {
    const u = unitInfo(spec.unit);
    let v = fromPos(+range.value);
    if (u.dec === 0) v = Math.round(v * u.f) / u.f; // snap to whole pixels
    else if (spec.unit === 'deg') v = Math.round(v * 2) / 2;
    apply(v);
  });
  range.addEventListener('change', commit);
  num.addEventListener('input', () => {
    const v = parseFloat(num.value);
    if (Number.isFinite(v)) apply(v / unitInfo(spec.unit).f);
  });
  num.addEventListener('change', () => { commit(); sync(); });
  num.addEventListener('keydown', (e) => { if (e.key === 'Enter') num.blur(); });
  label.addEventListener('dblclick', () => { apply(spec.def); commit(); });
  sync();
  return { node, sync };
}

function selectCtrl(spec, get, set, { rebuild = false } = {}) {
  const sel = el('select');
  for (const [v, t] of spec.options) sel.append(el('option', { value: v, textContent: t }));
  const node = el('div', { className: 'ctrl wide' }, el('label', { textContent: spec.label }), sel);
  const sync = () => { sel.value = get(); };
  sel.addEventListener('change', () => {
    set(sel.value);
    onEdit();
    commit();
    if (rebuild) buildProps();
  });
  sync();
  return { node, sync };
}

function checkCtrl(label, get, set, title = '') {
  const box = el('input', { type: 'checkbox' });
  const node = el('label', { title }, box, label);
  const sync = () => { box.checked = !!get(); };
  box.addEventListener('change', () => { set(box.checked); onEdit(); commit(); });
  sync();
  return { node, sync };
}

// Called after any live edit of the document.
function onEdit() {
  invalidate();
  updateLayerMeta();
}

// ---------------------------------------------------------------------------------------------
// Document panel

const SIZES = [
  ['HD · 1280×720', 1280, 720],
  ['Full HD · 1920×1080', 1920, 1080],
  ['QHD · 2560×1440', 2560, 1440],
  ['4K UHD · 3840×2160', 3840, 2160],
  ['DCI 4K · 4096×2160', 4096, 2160],
  ['8K · 7680×4320', 7680, 4320],
  ['Vertical · 1080×1920', 1080, 1920],
  ['Vertical 4K · 2160×3840', 2160, 3840],
  ['Portrait · 1080×1350', 1080, 1350],
  ['Square · 1080×1080', 1080, 1080],
  ['Square · 2048×2048', 2048, 2048],
  ['Square · 4096×4096', 4096, 4096],
];

let docSyncs = [];

function buildDocPanel() {
  const sp = $('sizePreset');
  sp.append(el('option', { value: '', textContent: 'Custom size' }));
  for (const [t, w, h] of SIZES) sp.append(el('option', { value: `${w}x${h}`, textContent: t }));
  sp.addEventListener('change', () => {
    if (!sp.value) return;
    const [w, h] = sp.value.split('x').map(Number);
    setDocSize(w, h);
  });
  const onSize = () => setDocSize(+$('docW').value || doc.width, +$('docH').value || doc.height);
  $('docW').addEventListener('change', onSize);
  $('docH').addEventListener('change', onSize);
  for (const id of ['docW', 'docH']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('swapWH').addEventListener('click', () => setDocSize(doc.height, doc.width));
  $('imgSize').addEventListener('click', () => ui.image && setDocSize(ui.image.width, ui.image.height));

  const box = $('docControls');
  const bg = sliderCtrl({ label: 'Base fill', unit: 'pct', min: 0, max: 1, def: 0 }, () => doc.background, (v) => { doc.background = clamp(v, 0, 1); });
  bg.node.querySelector('label').title = 'Starting value under all layers (0% = transparent/black). Double-click to reset.';
  const gamma = sliderCtrl({ label: 'Gamma', unit: 'num', min: 0.2, max: 5, def: 1, log: true }, () => doc.gamma, (v) => { doc.gamma = clamp(v, 0.05, 20); });
  gamma.node.querySelector('label').title = 'Global midtone curve: >1 brightens fades, <1 darkens. Double-click to reset.';
  const inv = checkCtrl('Invert', () => doc.invert, (v) => { doc.invert = v; }, 'Invert the final mask');
  const dith = checkCtrl('Dither', () => doc.dither, (v) => { doc.dither = v; }, 'Add ±½ LSB noise to prevent banding in long fades');
  box.append(bg.node, gamma.node, el('div', { className: 'checks' }, inv.node, dith.node));
  docSyncs = [bg.sync, gamma.sync, inv.sync, dith.sync, syncSizeFields];
}

function syncSizeFields() {
  $('docW').value = doc.width;
  $('docH').value = doc.height;
  const key = `${doc.width}x${doc.height}`;
  $('sizePreset').value = SIZES.some(([, w, h]) => `${w}x${h}` === key) ? key : '';
}

function setDocSize(w, h) {
  w = clamp(Math.round(w), 1, 16384);
  h = clamp(Math.round(h), 1, 16384);
  if (w === doc.width && h === doc.height) return syncSizeFields();
  doc.width = w;
  doc.height = h;
  syncSizeFields();
  syncProps();
  fitView();
  invalidate();
  commit();
}

// ---------------------------------------------------------------------------------------------
// Add shape + layers list

function thumbInto(canvas, layer, docLike = doc) {
  const cw = canvas.width, ch = canvas.height;
  const k = Math.min(cw / docLike.width, ch / docLike.height);
  const tw = Math.max(1, Math.round(docLike.width * k)), th = Math.max(1, Math.round(docLike.height * k));
  const alpha = renderAlpha(docLike, tw, th, {
    layers: [{ ...layer, enabled: true, blend: 'add', opacity: 1 }],
    background: 0, gamma: 1, invert: false, dither: false,
  });
  const img = new ImageData(tw, th);
  for (let i = 0; i < alpha.length; i++) {
    const j = i * 4;
    img.data[j] = img.data[j + 1] = img.data[j + 2] = alpha[i];
    img.data[j + 3] = 255;
  }
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);
  ctx.putImageData(img, (cw - tw) >> 1, (ch - th) >> 1);
}

function buildAddButtons() {
  const grid = $('addShape');
  const demo = { width: 1920, height: 1080 };
  for (const type of SHAPE_ORDER) {
    const c = el('canvas', { width: 80, height: 48 });
    thumbInto(c, createLayer(type), demo);
    const b = el('button', { title: `Add ${SHAPES[type].label}` }, c, SHAPES[type].label);
    b.addEventListener('click', () => addLayer(type));
    grid.append(b);
  }
}

function addLayer(type) {
  const layer = createLayer(type);
  const idx = doc.layers.findIndex((l) => l.id === selectedId);
  doc.layers.splice(idx < 0 ? doc.layers.length : idx + 1, 0, layer);
  select(layer.id);
  renderLayerList();
  invalidate();
  commit();
}

const thumbs = new Map();
let dragId = null;

function renderLayerList() {
  const list = $('layerList');
  list.textContent = '';
  thumbs.clear();
  if (!doc.layers.length) list.append(el('div', { className: 'empty', textContent: 'No layers. Add a shape above.' }));
  for (const l of [...doc.layers].reverse()) {
    const canvas = el('canvas', { width: 80, height: 48 });
    thumbs.set(l.id, canvas);
    const vis = el('input', { type: 'checkbox', checked: l.enabled, title: 'Visible (H)' });
    const row = el('div', { className: 'layer', draggable: true },
      vis, canvas,
      el('div', { className: 'lmeta' }, el('span', { className: 'lname' }), el('span', { className: 'lblend' })));
    row.dataset.id = l.id;
    vis.addEventListener('click', (e) => e.stopPropagation());
    vis.addEventListener('change', () => { l.enabled = vis.checked; onEdit(); syncProps(); commit(); });
    row.addEventListener('click', () => select(l.id));
    row.addEventListener('dblclick', () => { select(l.id); const n = $('props').querySelector('.name-input'); n?.focus(); n?.select(); });
    row.addEventListener('dragstart', (e) => { dragId = l.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', l.id); });
    row.addEventListener('dragend', () => { dragId = null; clearDropMarks(); });
    row.addEventListener('dragover', (e) => {
      if (!dragId || dragId === l.id) return;
      e.preventDefault();
      clearDropMarks();
      const r = row.getBoundingClientRect();
      row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const before = row.classList.contains('drop-before');
      clearDropMarks();
      if (!dragId || dragId === l.id) return;
      const order = [...doc.layers].reverse().map((x) => x.id).filter((id) => id !== dragId);
      order.splice(order.indexOf(l.id) + (before ? 0 : 1), 0, dragId);
      const byId = new Map(doc.layers.map((x) => [x.id, x]));
      doc.layers = order.reverse().map((id) => byId.get(id));
      renderLayerList();
      invalidate();
      commit();
    });
    list.append(row);
  }
  updateLayerMeta();
  drawThumbs();
}

function clearDropMarks() {
  for (const r of $('layerList').querySelectorAll('.drop-before, .drop-after')) r.classList.remove('drop-before', 'drop-after');
}

const blendLabel = Object.fromEntries(BLENDS);

function updateLayerMeta() {
  for (const row of $('layerList').querySelectorAll('.layer')) {
    const l = doc.layers.find((x) => x.id === row.dataset.id);
    if (!l) continue;
    row.classList.toggle('sel', l.id === selectedId);
    row.classList.toggle('off', !l.enabled);
    row.querySelector('input').checked = l.enabled;
    row.querySelector('.lname').textContent = l.name || SHAPES[l.type].label;
    row.querySelector('.lblend').textContent =
      `${blendLabel[l.blend].split(' ')[0]} · ${Math.round(l.opacity * 100)}%${l.invert ? ' · inv' : ''}`;
  }
  const idx = doc.layers.findIndex((l) => l.id === selectedId);
  $('layerUp').disabled = idx < 0 || idx === doc.layers.length - 1;
  $('layerDown').disabled = idx <= 0;
  $('layerDup').disabled = $('layerDel').disabled = idx < 0;
}

let thumbTimer = 0;
function drawThumbs() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    for (const l of doc.layers) {
      const c = thumbs.get(l.id);
      if (c) thumbInto(c, l);
    }
  }, 90);
}

function select(id) {
  selectedId = id;
  updateLayerMeta();
  buildProps();
  drawOverlay();
}

function moveLayer(dir) {
  const i = doc.layers.findIndex((l) => l.id === selectedId), j = i + dir;
  if (i < 0 || j < 0 || j >= doc.layers.length) return;
  [doc.layers[i], doc.layers[j]] = [doc.layers[j], doc.layers[i]];
  renderLayerList();
  invalidate();
  commit();
}

function duplicateLayer() {
  const l = selected();
  if (!l) return;
  const copy = { ...structuredClone(l), id: uid(), name: `${l.name} copy` };
  doc.layers.splice(doc.layers.indexOf(l) + 1, 0, copy);
  select(copy.id);
  renderLayerList();
  invalidate();
  commit();
}

function deleteLayer() {
  const i = doc.layers.findIndex((l) => l.id === selectedId);
  if (i < 0) return;
  doc.layers.splice(i, 1);
  selectedId = doc.layers[Math.min(i, doc.layers.length - 1)]?.id ?? null;
  renderLayerList();
  buildProps();
  invalidate();
  commit();
}

// ---------------------------------------------------------------------------------------------
// Properties panel

let propSyncs = [];

function buildProps() {
  const box = $('props');
  box.textContent = '';
  propSyncs = [];
  const l = selected();
  $('propsTitle').textContent = l ? SHAPES[l.type].label : 'Layer';
  if (!l) {
    box.append(el('div', { className: 'empty', textContent: 'Select a layer, or add a shape from the left panel.' }));
    return;
  }
  const name = el('input', { className: 'name-input', value: l.name, spellcheck: false, placeholder: 'Layer name' });
  name.addEventListener('input', () => { l.name = name.value; updateLayerMeta(); });
  name.addEventListener('change', commit);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
  box.append(name);

  const add = (c) => { box.append(c.node); propSyncs.push(c.sync); };
  add(selectCtrl({ label: 'Blend', options: BLENDS }, () => l.blend, (v) => { l.blend = v; }));
  add(sliderCtrl({ label: 'Opacity', unit: 'pct', min: 0, max: 1, def: 1 }, () => l.opacity, (v) => { l.opacity = clamp(v, 0, 1); }));
  const vis = checkCtrl('Visible', () => l.enabled, (v) => { l.enabled = v; });
  const inv = checkCtrl('Invert layer', () => l.invert, (v) => { l.invert = v; });
  box.append(el('div', { className: 'ctrl check' }, el('span'), el('div', { className: 'checks' }, vis.node, inv.node)));
  propSyncs.push(vis.sync, inv.sync);
  box.append(el('div', { className: 'sep' }));

  for (const p of SHAPES[l.type].params) {
    if (p.showIf && !p.showIf(l)) continue;
    if (p.type === 'select') {
      add(selectCtrl(p, () => l[p.key], (v) => { l[p.key] = v; }, { rebuild: SHAPES[l.type].params.some((q) => q.showIf) }));
    } else {
      const get = p.virtual ? () => p.get(l) : () => l[p.key];
      const set = p.virtual ? (v) => { p.set(l, Math.max(0, v)); syncProps(); } : (v) => { l[p.key] = p.key === 'power' ? clamp(v, 0.1, 10) : v; };
      add(sliderCtrl(p, get, set));
    }
  }
}

function syncProps() {
  for (const s of propSyncs) s();
}

function rebuildAll() {
  for (const s of docSyncs) s();
  renderLayerList();
  buildProps();
}

// ---------------------------------------------------------------------------------------------
// Rendering pipeline: synchronous low-res preview every frame, full-res in a worker when idle.

const viewport = $('viewport'), stage = $('stage'), display = $('display'), overlay = $('overlay');
const dctx = display.getContext('2d');
const maskCanvas = document.createElement('canvas'), mctx = maskCanvas.getContext('2d');
const tmpCanvas = document.createElement('canvas'), tctx = tmpCanvas.getContext('2d');
const octx = overlay.getContext('2d');

const SYNC_LIMIT = 520_000;   // documents up to this many pixels render at full res on every frame
let previewPixels = 260_000;  // adapts so the interactive preview stays around one frame
let current = null;           // { rgba, w, h, full, ver }
let rafPending = false, fullTimer = 0, interacting = false;

let worker = null, workerBusy = false, workerPending = false;
try {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    workerBusy = false;
    const { id, w, h, rgba, ms } = e.data;
    if (id === docVersion && w === doc.width && h === doc.height) present(rgba, w, h, true, ms);
    if (workerPending) { workerPending = false; requestFull(); }
  };
  worker.onerror = () => { worker = null; workerBusy = false; requestFull(); };
} catch { worker = null; }

function invalidate() {
  docVersion++;
  if (!rafPending) { rafPending = true; requestAnimationFrame(renderFrame); }
  drawThumbs();
  drawOverlay();
}

function renderFrame() {
  rafPending = false;
  const W = doc.width, H = doc.height;
  const t0 = performance.now();
  if (W * H <= SYNC_LIMIT) {
    present(alphaToRGBA(renderAlpha(doc, W, H)), W, H, true, performance.now() - t0);
    return;
  }
  const k = Math.sqrt(previewPixels / (W * H));
  const rw = Math.max(1, Math.round(W * k)), rh = Math.max(1, Math.round(H * k));
  const rgba = alphaToRGBA(renderAlpha(doc, rw, rh));
  const ms = performance.now() - t0;
  previewPixels = clamp(previewPixels * clamp(12 / Math.max(ms, 1), 0.6, 1.25), 60_000, 400_000);
  present(rgba, rw, rh, false, ms);
  clearTimeout(fullTimer);
  fullTimer = setTimeout(requestFull, interacting ? 200 : 40);
}

function requestFull() {
  if (current?.full && current.ver === docVersion) return;
  if (!worker) {
    const t0 = performance.now();
    present(alphaToRGBA(renderAlpha(doc)), doc.width, doc.height, true, performance.now() - t0);
    return;
  }
  if (workerBusy) { workerPending = true; return; }
  workerBusy = true;
  worker.postMessage({ id: docVersion, doc });
}

function present(rgba, w, h, full, ms) {
  current = { rgba, w, h, full, ver: docVersion };
  if (maskCanvas.width !== w || maskCanvas.height !== h) { maskCanvas.width = w; maskCanvas.height = h; }
  mctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  compose();
  $('renderInfo').textContent = `${doc.width}×${doc.height} · ${full ? 'full' : `preview ${w}×${h}`} · ${ms.toFixed(0)} ms`;
}

let checker = null;
function checkerPattern(ctx, w, h) {
  const cs = Math.max(2, Math.round(Math.min(w, h) / 40));
  if (!checker || checker.cs !== cs) {
    const c = el('canvas', { width: cs * 2, height: cs * 2 });
    const x = c.getContext('2d');
    x.fillStyle = '#9a9a9a'; x.fillRect(0, 0, cs * 2, cs * 2);
    x.fillStyle = '#6b6b6b'; x.fillRect(0, 0, cs, cs); x.fillRect(cs, cs, cs, cs);
    checker = { cs, c };
  }
  return ctx.createPattern(checker.c, 'repeat');
}

function drawImageCover(ctx, img, w, h) {
  const k = Math.max(w / img.width, h / img.height);
  const iw = img.width * k, ih = img.height * k;
  ctx.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih);
}

// Generic TV test card, used as the reference image until the user loads one.
let testCardCache = null;
function testCard() {
  const W = doc.width, H = doc.height;
  const k = Math.min(1, 1920 / Math.max(W, H));
  const w = Math.max(16, Math.round(W * k)), h = Math.max(16, Math.round(H * k));
  const key = `${W}x${H}`;
  if (testCardCache?.key === key) return testCardCache.canvas;
  const c = el('canvas', { width: w, height: h });
  drawTestCard(c.getContext('2d'), w, h, `${W} × ${H}`);
  testCardCache = { key, canvas: c };
  return c;
}

function drawTestCard(ctx, w, h, label) {
  const S = Math.min(w, h), cell = S / 12;
  const cx = w / 2, cy = h / 2;
  // Gray field with a white grid centred on the frame.
  ctx.fillStyle = '#6a6a6a';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#e8e8e8';
  ctx.lineWidth = Math.max(1, S / 540);
  ctx.beginPath();
  for (let x = cx % cell; x <= w; x += cell) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = cy % cell; y <= h; y += cell) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
  // Black/white castellations around the border.
  const t = cell / 2;
  let i = 0;
  for (let x = 0; x < w; x += t, i++) {
    ctx.fillStyle = i % 2 ? '#fff' : '#000';
    ctx.fillRect(x, 0, t, t / 2);
    ctx.fillRect(x, h - t / 2, t, t / 2);
  }
  i = 0;
  for (let y = 0; y < h; y += t, i++) {
    ctx.fillStyle = i % 2 ? '#fff' : '#000';
    ctx.fillRect(0, y, t / 2, t);
    ctx.fillRect(w - t / 2, y, t / 2, t);
  }
  // Corner sharpness targets (concentric rings).
  const rr = cell * 0.9;
  for (const [x, y] of [[cell * 1.6, cell * 1.6], [w - cell * 1.6, cell * 1.6], [cell * 1.6, h - cell * 1.6], [w - cell * 1.6, h - cell * 1.6]]) {
    for (let r = rr, j = 0; r > 0; r -= rr / 6, j++) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = j % 2 ? '#000' : '#fff';
      ctx.fill();
    }
  }
  // Colour ramps on both sides.
  const sideW = cell * 0.7, sideH = cell * 6;
  for (const [x, hue] of [[cx - S * 0.46 - sideW * 1.6, 0], [cx + S * 0.46 + sideW * 0.6, 200]]) {
    const g = ctx.createLinearGradient(0, cy - sideH / 2, 0, cy + sideH / 2);
    for (let s = 0; s <= 6; s++) g.addColorStop(s / 6, `hsl(${hue + s * 60}, 85%, 50%)`);
    ctx.fillStyle = g;
    ctx.fillRect(x, cy - sideH / 2, sideW, sideH);
  }

  // Central circle with the classic bands.
  const R = S * 0.44;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  const top = cy - R, band = (2 * R) / 7, left = cx - R, span = 2 * R;
  // 1. 75% colour bars
  const bars = ['#bfbfbf', '#bfbf00', '#00bfbf', '#00bf00', '#bf00bf', '#bf0000', '#0000bf', '#000000'];
  bars.forEach((col, k) => { ctx.fillStyle = col; ctx.fillRect(left + (span * k) / 8, top, span / 8 + 1, band * 1.5); });
  // 2. grey step wedge
  for (let k = 0; k < 6; k++) {
    const v = Math.round((k / 5) * 255);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(left + (span * k) / 6, top + band * 1.5, span / 6 + 1, band);
  }
  // 3. black ident band
  ctx.fillStyle = '#000';
  ctx.fillRect(left, top + band * 2.5, span, band * 2);
  // 4. multiburst gratings
  const by = top + band * 4.5, segs = 6;
  ctx.fillStyle = '#7f7f7f';
  ctx.fillRect(left, by, span, band);
  for (let k = 0; k < segs; k++) {
    const x0 = left + span * (0.1 + (0.8 * k) / segs), x1 = x0 + (span * 0.8) / segs * 0.9;
    const period = Math.max(2, (S / 60) / (k + 1));
    ctx.fillStyle = '#fff';
    for (let x = x0; x < x1; x += period) ctx.fillRect(x, by + band * 0.15, period / 2, band * 0.7);
  }
  // 5. smooth luminance ramp (shows how the mask fades)
  const g = ctx.createLinearGradient(left, 0, left + span, 0);
  g.addColorStop(0, '#000');
  g.addColorStop(1, '#fff');
  ctx.fillStyle = g;
  ctx.fillRect(left, top + band * 5.5, span, band * 0.75);
  // 6. bottom band
  ctx.fillStyle = '#c8a000';
  ctx.fillRect(left, top + band * 6.25, span, band);
  ctx.restore();

  // Circle outline + centre cross
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(1.5, S / 360);
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.lineWidth = Math.max(1, S / 720);
  ctx.stroke();

  // Text
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(band * 0.55)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillText('TEST CARD', cx, top + band * 3.05);
  ctx.font = `600 ${Math.round(band * 0.42)}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.fillText(label, cx, top + band * 3.95);
  // Caption in the bottom band, sized to fit the circle's chord at that height.
  const capY = top + band * 6.55, chord = 2 * Math.sqrt(Math.max(0, R * R - (capY - cy) ** 2)) * 0.8;
  const caption = 'No reference image · drop one here';
  let size = band * 0.34;
  ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const tw = ctx.measureText(caption).width;
  if (tw > chord) {
    size *= chord / tw;
    ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  }
  ctx.fillStyle = '#000';
  ctx.fillText(caption, cx, capY);
}

function compose() {
  if (!current) return;
  const { w, h } = current;
  if (display.width !== w || display.height !== h) { display.width = w; display.height = h; }
  const mode = ui.view;
  const ref = ui.image || testCard();
  dctx.globalCompositeOperation = 'source-over';
  dctx.globalAlpha = 1;
  dctx.imageSmoothingQuality = 'high';
  if (mode === 'matte') {
    dctx.fillStyle = '#000';
    dctx.fillRect(0, 0, w, h);
    dctx.drawImage(maskCanvas, 0, 0);
  } else if (mode === 'checker') {
    dctx.fillStyle = checkerPattern(dctx, w, h);
    dctx.fillRect(0, 0, w, h);
    dctx.drawImage(maskCanvas, 0, 0);
  } else {
    if (tmpCanvas.width !== w || tmpCanvas.height !== h) { tmpCanvas.width = w; tmpCanvas.height = h; }
    tctx.globalCompositeOperation = 'source-over';
    tctx.clearRect(0, 0, w, h);
    if (mode === 'cut') {
      dctx.fillStyle = checkerPattern(dctx, w, h);
      dctx.fillRect(0, 0, w, h);
      drawImageCover(tctx, ref, w, h);
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(maskCanvas, 0, 0);
      dctx.drawImage(tmpCanvas, 0, 0);
    } else {
      drawImageCover(dctx, ref, w, h);
      tctx.fillStyle = 'rgb(255, 40, 60)';
      tctx.fillRect(0, 0, w, h);
      tctx.globalCompositeOperation = 'destination-out';
      tctx.drawImage(maskCanvas, 0, 0);
      dctx.globalAlpha = 0.6;
      dctx.drawImage(tmpCanvas, 0, 0);
      dctx.globalAlpha = 1;
    }
  }
  display.classList.toggle('pixelated', current.full && view.zoom >= 2);
}

function setViewMode(mode) {
  ui.view = mode;
  local.set('view', mode);
  for (const b of $('viewModes').children) b.classList.toggle('on', b.dataset.view === mode);
  compose();
}

// ---------------------------------------------------------------------------------------------
// View (zoom/pan) and overlay

function applyView() {
  stage.style.width = doc.width + 'px';
  stage.style.height = doc.height + 'px';
  stage.style.transform = `translate(${Math.round(view.x)}px, ${Math.round(view.y)}px) scale(${view.zoom})`;
  const zs = $('zoomSel');
  const match = [...zs.options].find((o) => Number(o.value) && Math.abs(Number(o.value) - view.zoom) < 1e-6);
  if (view.fit) zs.value = 'fit';
  else if (match) zs.value = match.value;
  else {
    const custom = zs.querySelector('option[value="custom"]');
    custom.textContent = `${Math.round(view.zoom * 100)}%`;
    zs.value = 'custom';
  }
  if (current) display.classList.toggle('pixelated', current.full && view.zoom >= 2);
  drawOverlay();
}

function fitView() {
  const r = viewport.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const pad = 28;
  const z = Math.min((r.width - pad * 2) / doc.width, (r.height - pad * 2) / doc.height);
  view.zoom = z > 0 ? z : 1;
  view.x = (r.width - doc.width * view.zoom) / 2;
  view.y = (r.height - doc.height * view.zoom) / 2;
  view.fit = true;
  applyView();
}

function zoomTo(z, cx, cy) {
  const r = viewport.getBoundingClientRect();
  cx ??= r.width / 2;
  cy ??= r.height / 2;
  z = clamp(z, 0.01, 64);
  view.x = cx - (cx - view.x) * (z / view.zoom);
  view.y = cy - (cy - view.y) * (z / view.zoom);
  view.zoom = z;
  view.fit = false;
  applyView();
}

const ZOOM_STEPS = [0.05, 0.1, 0.125, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
function zoomStep(dir) {
  const z = view.zoom;
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z * 1.001) : [...ZOOM_STEPS].reverse().find((s) => s < z * 0.999);
  zoomTo(next ?? z);
}

const toScreen = (X, Y) => [Math.round(view.x) + X * view.zoom, Math.round(view.y) + Y * view.zoom];
const toDoc = (sx, sy) => [(sx - Math.round(view.x)) / view.zoom, (sy - Math.round(view.y)) / view.zoom];

let handles = [];
const ACCENT = '#f0a63a';

function strokeTwice(ctx, dashed = false) {
  ctx.setLineDash(dashed ? [5, 4] : []);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.stroke();
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = dashed ? 'rgba(240,166,58,0.85)' : ACCENT;
  ctx.stroke();
  ctx.setLineDash([]);
}

function geometry(l) {
  const W = doc.width, H = doc.height;
  return { cx: l.cx * W, cy: l.cy * H, hw: (Math.abs(l.w) * W) / 2, hh: (Math.abs(l.h) * H) / 2, rot: ((l.rotation || 0) * Math.PI) / 180 };
}

function drawOverlay() {
  const r = viewport.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(r.width * dpr), ph = Math.round(r.height * dpr);
  if (overlay.width !== pw || overlay.height !== ph) { overlay.width = pw; overlay.height = ph; }
  const ctx = octx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  handles = [];
  const z = view.zoom;

  // Pixel grid when zoomed far in.
  if (z >= 12) {
    const [x0, y0] = toDoc(0, 0), [x1, y1] = toDoc(r.width, r.height);
    const ax = Math.max(0, Math.floor(x0)), bx = Math.min(doc.width, Math.ceil(x1));
    const ay = Math.max(0, Math.floor(y0)), by = Math.min(doc.height, Math.ceil(y1));
    ctx.beginPath();
    for (let x = ax; x <= bx; x++) { const [sx] = toScreen(x, 0); ctx.moveTo(sx + 0.5, toScreen(0, ay)[1]); ctx.lineTo(sx + 0.5, toScreen(0, by)[1]); }
    for (let y = ay; y <= by; y++) { const [, sy] = toScreen(0, y); ctx.moveTo(toScreen(ax, 0)[0], sy + 0.5); ctx.lineTo(toScreen(bx, 0)[0], sy + 0.5); }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(128,128,128,0.35)';
    ctx.stroke();
  }

  const l = selected();
  if (!l) return;
  ctx.globalAlpha = l.enabled ? 1 : 0.45;
  const S = Math.min(doc.width, doc.height);

  if (l.type === 'edge') {
    const ins = l.inset * S;
    const L = ins + l.left * S, R = doc.width - ins - l.right * S, T = ins + l.top * S, B = doc.height - ins - l.bottom * S;
    if (ins > 0) { rectPath(ctx, ins, ins, doc.width - ins, doc.height - ins); strokeTwice(ctx, true); }
    rectPath(ctx, L, T, R, B);
    strokeTwice(ctx, true);
    const mx = (L + R) / 2, my = (T + B) / 2;
    addHandle('edge-left', ...toScreen(L, my), 'square');
    addHandle('edge-right', ...toScreen(R, my), 'square');
    addHandle('edge-top', ...toScreen(mx, T), 'square');
    addHandle('edge-bottom', ...toScreen(mx, B), 'square');
  } else if (l.type === 'linear') {
    const cx = l.cx * doc.width, cy = l.cy * doc.height;
    const a = (l.angle * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
    const f = l.fade * S, hw = (l.width * S) / 2;
    const span = Math.hypot(doc.width, doc.height) * 2;
    const line = (s, dashed) => {
      const px = cx + ux * s, py = cy + uy * s;
      ctx.beginPath();
      ctx.moveTo(...toScreen(px - uy * span, py + ux * span));
      ctx.lineTo(...toScreen(px + uy * span, py - ux * span));
      strokeTwice(ctx, dashed);
    };
    if (l.mode === 'band') { line(-hw, false); line(hw, false); line(-hw - f, true); line(hw + f, true); }
    else { line(0, false); line(-f / 2, true); line(f / 2, true); }
    const [sx, sy] = toScreen(cx, cy);
    const len = 70;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + ux * len, sy + uy * len);
    strokeTwice(ctx);
    addHandle('move', sx, sy);
    addHandle('angle', sx + ux * len, sy + uy * len, 'ring');
  } else {
    const g = geometry(l);
    const [sx, sy] = toScreen(g.cx, g.cy);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(g.rot);
    if (l.type === 'radial') {
      ellipsePath(ctx, g.hw * z, g.hh * z); strokeTwice(ctx);
      if (l.inner > 0) { ellipsePath(ctx, g.hw * z * l.inner, g.hh * z * l.inner); strokeTwice(ctx, true); }
    } else {
      const f = l.feather * S;
      const off = l.align === 'outside' ? f : l.align === 'center' ? f / 2 : 0;
      const contour = (d, dashed) => {
        const hw = Math.max(0, g.hw + d) * z, hh = Math.max(0, g.hh + d) * z;
        if (l.type === 'rect') {
          const rad = Math.max(0, Math.min(l.radius * S + d, g.hw + d, g.hh + d)) * z;
          ctx.beginPath();
          ctx.roundRect(-hw, -hh, hw * 2, hh * 2, rad);
        } else ellipsePath(ctx, hw, hh);
        strokeTwice(ctx, dashed);
      };
      contour(0, false);
      if (f > 0) { contour(off - f, true); if (off) contour(off, true); }
    }
    ctx.restore();
    const rotPt = (lx, ly) => [sx + (lx * Math.cos(g.rot) - ly * Math.sin(g.rot)) * z, sy + (lx * Math.sin(g.rot) + ly * Math.cos(g.rot)) * z];
    addHandle('move', sx, sy);
    const corner = l.type === 'rect' ? 1 : Math.SQRT1_2; // ellipses: handle sits on the curve at 45°
    addHandle('size', ...rotPt(g.hw * corner, g.hh * corner), 'square');
    const [rx, ry] = rotPt(0, -g.hh - 26 / z);
    const [tx, ty] = rotPt(0, -g.hh);
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(rx, ry); strokeTwice(ctx, true);
    addHandle('rot', rx, ry, 'ring');
  }

  for (const h of handles) {
    ctx.beginPath();
    if (h.shape === 'square') ctx.rect(h.x - 4.5, h.y - 4.5, 9, 9);
    else ctx.arc(h.x, h.y, h.shape === 'ring' ? 5 : 5.5, 0, Math.PI * 2);
    ctx.fillStyle = h.shape === 'ring' ? ACCENT : '#fff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#111';
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function addHandle(kind, x, y, shape = 'dot') { handles.push({ kind, x, y, shape }); }
function rectPath(ctx, x0, y0, x1, y1) {
  const [a, b] = toScreen(x0, y0), [c, d] = toScreen(x1, y1);
  ctx.beginPath();
  ctx.rect(a, b, c - a, d - b);
}
function ellipsePath(ctx, rx, ry) {
  ctx.beginPath();
  ctx.ellipse(0, 0, Math.max(0, rx), Math.max(0, ry), 0, 0, Math.PI * 2);
}

// ---------------------------------------------------------------------------------------------
// Pointer interaction

let drag = null, spaceDown = false;

function localPoint(e) {
  const r = viewport.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function hitHandle(px, py) {
  for (let i = handles.length - 1; i >= 0; i--) {
    const h = handles[i];
    if (Math.hypot(h.x - px, h.y - py) <= 9) return h;
  }
  return null;
}

const movable = (l) => !!l && l.type !== 'edge';

function insideLayer(l, px, py) {
  if (!movable(l)) return false;
  if (l.type === 'linear') {
    const [X, Y] = toDoc(px, py);
    const a = (l.angle * Math.PI) / 180;
    const d = Math.abs((X - l.cx * doc.width) * Math.cos(a) + (Y - l.cy * doc.height) * Math.sin(a));
    return d * view.zoom < 10;
  }
  const g = geometry(l);
  const [X, Y] = toDoc(px, py);
  const dx = X - g.cx, dy = Y - g.cy;
  const lx = dx * Math.cos(g.rot) + dy * Math.sin(g.rot), ly = -dx * Math.sin(g.rot) + dy * Math.cos(g.rot);
  if (l.type === 'rect') return Math.abs(lx) <= g.hw && Math.abs(ly) <= g.hh;
  return (lx / Math.max(g.hw, 1e-6)) ** 2 + (ly / Math.max(g.hh, 1e-6)) ** 2 <= 1;
}

// What a left-drag at (px, py) grabs: a handle, the selected shape, another shape under the
// cursor (topmost first, which also selects it), or, failing that, the selected shape anyway.
// Only when nothing positionable is selected does a plain left-drag pan the view.
function dragTarget(px, py) {
  const h = hitHandle(px, py);
  if (h) return { kind: h.kind };
  const sel = selected();
  if (insideLayer(sel, px, py)) return { kind: 'move' };
  const [X, Y] = toDoc(px, py);
  if (X >= 0 && Y >= 0 && X < doc.width && Y < doc.height) {
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (l !== sel && l.enabled && insideLayer(l, px, py)) return { kind: 'move', layer: l };
    }
  }
  return movable(sel) ? { kind: 'move' } : { kind: 'pan' };
}

viewport.addEventListener('contextmenu', (e) => e.preventDefault());

viewport.addEventListener('pointerdown', (e) => {
  viewport.focus({ preventScroll: true });
  const [px, py] = localPoint(e);
  let kind = 'pan';
  if (e.button === 0 && !spaceDown) {
    const t = dragTarget(px, py);
    kind = t.kind;
    if (t.layer) select(t.layer.id);
  } else if (e.button !== 1 && e.button !== 2 && !spaceDown) return;
  const l = selected();
  drag = { kind, px, py, vx: view.x, vy: view.y, start: l ? structuredClone(l) : null, changed: false };
  viewport.setPointerCapture(e.pointerId);
  viewport.classList.toggle('panning', kind === 'pan');
  interacting = true;
  e.preventDefault();
});

viewport.addEventListener('pointermove', (e) => {
  const [px, py] = localPoint(e);
  updateReadout(px, py);
  if (!drag) {
    const t = spaceDown ? { kind: 'pan' } : dragTarget(px, py);
    viewport.classList.toggle('handle', t.kind !== 'move' && t.kind !== 'pan');
    viewport.classList.toggle('move', t.kind === 'move');
    return;
  }
  if (drag.kind === 'pan') {
    view.x = drag.vx + (px - drag.px);
    view.y = drag.vy + (py - drag.py);
    view.fit = false;
    applyView();
    return;
  }
  const l = selected();
  if (!l) return;
  dragShape(l, drag, px, py, e.shiftKey);
  drag.changed = true;
  invalidate();
  syncProps();
});

function endDrag() {
  if (!drag) return;
  if (drag.changed) commit();
  drag = null;
  interacting = false;
  viewport.classList.remove('panning');
  if (current && !current.full) { clearTimeout(fullTimer); fullTimer = setTimeout(requestFull, 0); }
}
viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);
viewport.addEventListener('pointerleave', () => { if (!drag) $('readout').textContent = ''; });

function dragShape(l, d, px, py, shift) {
  const W = doc.width, H = doc.height, S = Math.min(W, H), z = view.zoom, s0 = d.start;
  const [X, Y] = toDoc(px, py);
  switch (d.kind) {
    case 'move': {
      let dx = (px - d.px) / z, dy = (py - d.py) / z;
      if (shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      let cx = s0.cx * W + dx, cy = s0.cy * H + dy;
      if (Math.abs(cx - W / 2) * z < 6) cx = W / 2; // snap to center
      if (Math.abs(cy - H / 2) * z < 6) cy = H / 2;
      l.cx = cx / W;
      l.cy = cy / H;
      break;
    }
    case 'size': {
      const g = geometry(s0);
      const dx = X - g.cx, dy = Y - g.cy;
      const corner = l.type === 'rect' ? 1 : Math.SQRT1_2;
      let lx = Math.abs(dx * Math.cos(g.rot) + dy * Math.sin(g.rot)) / corner;
      let ly = Math.abs(-dx * Math.sin(g.rot) + dy * Math.cos(g.rot)) / corner;
      if (shift && g.hw > 0 && g.hh > 0) {
        const k = Math.max(lx / g.hw, ly / g.hh);
        lx = g.hw * k; ly = g.hh * k;
      }
      l.w = Math.round(lx * 2) / W;
      l.h = Math.round(ly * 2) / H;
      break;
    }
    case 'rot': {
      let a = (Math.atan2(Y - s0.cy * H, X - s0.cx * W) * 180) / Math.PI + 90;
      if (shift) a = Math.round(a / 15) * 15;
      l.rotation = ((((a + 180) % 360) + 360) % 360) - 180;
      break;
    }
    case 'angle': {
      let a = (Math.atan2(Y - s0.cy * H, X - s0.cx * W) * 180) / Math.PI;
      if (shift) a = Math.round(a / 15) * 15;
      l.angle = Math.round(a * 2) / 2;
      break;
    }
    default: {
      if (!d.kind.startsWith('edge-')) break;
      const side = d.kind.slice(5), ins = s0.inset * S;
      const dist = side === 'left' ? X - ins : side === 'right' ? W - X - ins : side === 'top' ? Y - ins : H - Y - ins;
      const v = Math.max(0, Math.round(dist)) / S;
      if (shift) l.left = l.right = l.top = l.bottom = v;
      else l[side] = v;
    }
  }
}

viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  const [px, py] = localPoint(e);
  const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
  zoomTo(view.zoom * Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0018)), px, py);
}, { passive: false });

function updateReadout(px, py) {
  const [X, Y] = toDoc(px, py);
  const out = $('readout');
  if (!current || X < 0 || Y < 0 || X >= doc.width || Y >= doc.height) { out.textContent = ''; return; }
  const ix = Math.floor(X), iy = Math.floor(Y);
  const cx = Math.min(current.w - 1, Math.floor((X * current.w) / doc.width));
  const cy = Math.min(current.h - 1, Math.floor((Y * current.h) / doc.height));
  const a = current.rgba[(cy * current.w + cx) * 4 + 3];
  out.textContent = `x ${ix}  y ${iy}  ·  α ${a} (${((a / 255) * 100).toFixed(1)}%)${current.full ? '' : ' ~'}`;
}

new ResizeObserver(() => (view.fit ? fitView() : applyView())).observe(viewport);

// ---------------------------------------------------------------------------------------------
// Reference image

async function loadImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return toast('Not an image file', true);
  try {
    ui.image = await createImageBitmap(file);
    $('imgSize').disabled = false;
    $('imgSize').title = `Use reference image size (${ui.image.width}×${ui.image.height})`;
    setViewMode(ui.view === 'cut' || ui.view === 'overlay' ? ui.view : 'cut');
    toast(`Reference image loaded · ${ui.image.width}×${ui.image.height}`);
  } catch {
    toast('Could not decode that image', true);
  }
}

$('loadImage').addEventListener('click', () => $('imageFile').click());
$('imageFile').addEventListener('change', (e) => { loadImageFile(e.target.files[0]); e.target.value = ''; });
viewport.addEventListener('dragover', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  viewport.classList.add('dragover');
});
viewport.addEventListener('dragleave', (e) => { if (e.target === viewport) viewport.classList.remove('dragover'); });
viewport.addEventListener('drop', (e) => {
  e.preventDefault();
  viewport.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file && (file.type === 'application/json' || /\.json$/i.test(file.name))) importPresetsFile(file);
  else loadImageFile(file);
});

// ---------------------------------------------------------------------------------------------
// Presets: built-in + saved in this browser (export/import as JSON to move them around)

let savedPresets = readSavedPresets();

function readSavedPresets() {
  const raw = local.get('presets');
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function writeSavedPresets(next) {
  try {
    localStorage.setItem('pac.presets', JSON.stringify(next));
    savedPresets = next;
    return true;
  } catch {
    toast('This browser is not allowing storage here. Use Export presets to keep them as a file.', true);
    return false;
  }
}

function refreshPresets(selectValue) {
  const sel = $('presetSelect');
  sel.textContent = '';
  sel.append(el('option', { value: '', textContent: 'Load preset…' }));
  const builtin = el('optgroup', { label: 'Built-in' });
  for (const name of Object.keys(BUILTIN_PRESETS)) builtin.append(el('option', { value: 'b:' + name, textContent: name }));
  sel.append(builtin);
  const names = Object.keys(savedPresets).sort((a, b) => a.localeCompare(b));
  if (names.length) {
    const saved = el('optgroup', { label: 'Saved in this browser' });
    for (const name of names) saved.append(el('option', { value: 's:' + name, textContent: name }));
    sel.append(saved);
  }
  sel.value = selectValue && [...sel.options].some((o) => o.value === selectValue) ? selectValue : '';
  $('presetDelete').disabled = !sel.value.startsWith('s:');
  $('presetExport').disabled = !names.length;
}

function loadPreset(value) {
  const name = value.slice(2);
  const prevSize = `${doc.width}x${doc.height}`;
  if (value.startsWith('b:')) doc = normalizeDoc({ ...BUILTIN_PRESETS[name](), width: doc.width, height: doc.height });
  else if (savedPresets[name]) doc = normalizeDoc(structuredClone(savedPresets[name]));
  else return;
  selectedId = doc.layers.at(-1)?.id ?? null;
  rebuildAll();
  if (`${doc.width}x${doc.height}` !== prevSize) fitView();
  invalidate();
  commit();
  if (value.startsWith('s:') && $('fileName').value === 'mask') $('fileName').value = name.replace(/[^\w.\- ]+/g, '_');
}

$('presetSelect').addEventListener('change', (e) => {
  $('presetDelete').disabled = !e.target.value.startsWith('s:');
  if (e.target.value) loadPreset(e.target.value);
  e.target.blur();
});

$('presetSave').addEventListener('click', () => {
  const cur = $('presetSelect').value;
  const name = prompt('Save preset as:', cur.startsWith('s:') ? cur.slice(2) : '')?.trim().slice(0, 80);
  if (!name) return;
  if (savedPresets[name] && !cur.endsWith(':' + name) && !confirm(`Overwrite preset "${name}"?`)) return;
  if (!writeSavedPresets({ ...savedPresets, [name]: structuredClone(doc) })) return;
  refreshPresets('s:' + name);
  toast(`Preset "${name}" saved in this browser`);
});

$('presetDelete').addEventListener('click', () => {
  const v = $('presetSelect').value;
  if (!v.startsWith('s:') || !confirm(`Delete preset "${v.slice(2)}"?`)) return;
  const next = { ...savedPresets };
  delete next[v.slice(2)];
  if (!writeSavedPresets(next)) return;
  refreshPresets('');
  toast('Preset deleted');
});

function downloadBlob(blob, file) {
  const a = el('a', { href: URL.createObjectURL(blob), download: file });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

$('presetExport').addEventListener('click', () => {
  const body = JSON.stringify({ app: 'png-alpha-creator', version: 1, presets: savedPresets }, null, 2);
  downloadBlob(new Blob([body], { type: 'application/json' }), 'png-alpha-creator-presets.json');
});

$('presetImport').addEventListener('click', () => $('presetFile').click());
$('presetFile').addEventListener('change', (e) => { importPresetsFile(e.target.files[0]); e.target.value = ''; });

// Accepts an exported presets file ({ presets: { name: doc } }), a bare { name: doc } map,
// or a single document (named after the file).
async function importPresetsFile(file) {
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast(`${file.name} is not valid JSON`, true);
  }
  const entries = data && Array.isArray(data.layers) ? [[file.name.replace(/\.json$/i, ''), data]]
    : Object.entries(data?.presets && typeof data.presets === 'object' ? data.presets : data || {});
  const next = { ...savedPresets };
  let count = 0;
  for (const [name, d] of entries) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.layers)) continue;
    next[String(name).trim().slice(0, 80) || `Imported ${count + 1}`] = normalizeDoc(d);
    count++;
  }
  if (!count) return toast(`No presets found in ${file.name}`, true);
  if (!writeSavedPresets(next)) return;
  refreshPresets($('presetSelect').value);
  toast(`Imported ${count} preset${count === 1 ? '' : 's'}`);
}

// ---------------------------------------------------------------------------------------------
// Export: rendered and PNG-encoded in a worker (same renderer as the preview, so output matches)

function buildFormatSelect() {
  const sel = $('format');
  for (const [k, f] of Object.entries(EXPORT_FORMATS)) sel.append(el('option', { value: k, textContent: f.label }));
  sel.append(el('option', { value: 'both', textContent: 'Alpha + Key (2 files)' }));
  sel.value = local.get('format') || 'alpha';
  sel.addEventListener('change', () => local.set('format', sel.value));
  const fn = $('fileName');
  fn.value = local.get('fileName') || 'mask';
  fn.addEventListener('change', () => local.set('fileName', fn.value));
}

const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
const MAX_EXPORT_PIXELS = 8192 * 8192;

let exportWorker = null, exportSeq = 0;
const exportJobs = new Map();

function encodeInWorker(snapshot, format) {
  if (!exportWorker) {
    exportWorker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    exportWorker.onmessage = (e) => {
      const job = exportJobs.get(e.data.id);
      exportJobs.delete(e.data.id);
      if (e.data.error) job?.reject(new Error(e.data.error));
      else job?.resolve(e.data);
    };
    exportWorker.onerror = (e) => {
      for (const job of exportJobs.values()) job.reject(new Error(e.message || 'Export worker failed'));
      exportJobs.clear();
      exportWorker = null;
    };
  }
  const id = ++exportSeq;
  return new Promise((resolve, reject) => {
    exportJobs.set(id, { resolve, reject });
    exportWorker.postMessage({ id, doc: snapshot, export: format });
  });
}

async function exportPNG() {
  const btn = $('exportBtn');
  if (btn.disabled) return;
  if (doc.width * doc.height > MAX_EXPORT_PIXELS) {
    return toast(`${doc.width}×${doc.height} is too large to export in the browser (max ${MAX_EXPORT_PIXELS / 1e6 | 0} MP)`, true);
  }
  const name = ($('fileName').value.trim() || 'mask').replace(/[^\w.\- ]+/g, '_');
  const f = $('format').value;
  const formats = f === 'both' ? ['alpha', 'key'] : [f];
  const snapshot = structuredClone(doc);
  btn.disabled = true;
  btn.textContent = 'Exporting…';
  try {
    for (const fmt of formats) {
      const t0 = performance.now();
      const { png } = await encodeInWorker(snapshot, fmt);
      const blob = new Blob([png], { type: 'image/png' });
      const file = `${name}${EXPORT_FORMATS[fmt].suffix}.png`;
      downloadBlob(blob, file);
      toast(`${file} · ${snapshot.width}×${snapshot.height} · ${fmtBytes(blob.size)} · ${Math.round(performance.now() - t0)} ms`);
    }
  } catch (e) {
    toast(`Export failed: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Export PNG';
  }
}

// ---------------------------------------------------------------------------------------------
// Toast + keyboard

let toastTimer = 0;
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), err ? 4500 : 2600);
}

function isTyping(t) {
  return (t.tagName === 'INPUT' && !['range', 'checkbox'].includes(t.type)) || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA';
}

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const typing = isTyping(e.target);
  if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); exportPNG(); return; }
  if (typing) return;
  const k = e.key;
  if (mod && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k.toLowerCase() === 'd') { e.preventDefault(); duplicateLayer(); return; }
  if (mod) return;
  if (k === ' ') { spaceDown = true; viewport.classList.add('panning'); e.preventDefault(); return; }
  if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteLayer(); return; }
  if (e.target.type === 'range') return; // let sliders handle arrows etc.
  if (k === '0' || k === 'f') fitView();
  else if (k === '1') zoomTo(1);
  else if (k === '+' || k === '=') zoomStep(1);
  else if (k === '-' || k === '_') zoomStep(-1);
  else if (k === ']') moveLayer(1);
  else if (k === '[') moveLayer(-1);
  else if (k === 'h') { const l = selected(); if (l) { l.enabled = !l.enabled; onEdit(); syncProps(); commit(); } }
  else if (k.startsWith('Arrow')) {
    const l = selected();
    if (!l || !('cx' in l)) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    if (k === 'ArrowLeft') l.cx -= step / doc.width;
    if (k === 'ArrowRight') l.cx += step / doc.width;
    if (k === 'ArrowUp') l.cy -= step / doc.height;
    if (k === 'ArrowDown') l.cy += step / doc.height;
    invalidate();
    syncProps();
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(commit, 400);
  }
});
let nudgeTimer = 0;
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') { spaceDown = false; if (!drag) viewport.classList.remove('panning'); }
});
window.addEventListener('blur', () => { spaceDown = false; });

// ---------------------------------------------------------------------------------------------
// Wire up + start

for (const b of $('viewModes').children) b.addEventListener('click', () => setViewMode(b.dataset.view));
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
$('exportBtn').addEventListener('click', exportPNG);
$('layerUp').addEventListener('click', () => moveLayer(1));
$('layerDown').addEventListener('click', () => moveLayer(-1));
$('layerDup').addEventListener('click', duplicateLayer);
$('layerDel').addEventListener('click', deleteLayer);
$('zoomIn').addEventListener('click', () => zoomStep(1));
$('zoomOut').addEventListener('click', () => zoomStep(-1));
$('zoomFit').addEventListener('click', fitView);
$('zoom100').addEventListener('click', () => zoomTo(1));
$('zoomSel').addEventListener('change', (e) => {
  const v = e.target.value;
  if (v === 'fit') fitView();
  else if (v !== 'custom') zoomTo(Number(v));
  e.target.blur();
});
// Full-res render as soon as a slider drag ends.
document.addEventListener('pointerdown', (e) => { if (e.target.type === 'range') interacting = true; });
document.addEventListener('pointerup', () => {
  if (drag) return;
  interacting = false;
  if (current && !current.full) { clearTimeout(fullTimer); fullTimer = setTimeout(requestFull, 0); }
});

buildDocPanel();
buildAddButtons();
buildFormatSelect();
rebuildAll();
setViewMode(ui.view);
commit();
fitView();
invalidate();
refreshPresets();
