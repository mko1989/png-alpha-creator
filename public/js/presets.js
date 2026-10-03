// Built-in presets. They reproduce the reference masks and are resolution-independent,
// so loading one keeps the current document size.
import { createLayer } from './core.js';

const E = 150 / 1080;

const base = (layers) => ({ background: 0, gamma: 1, invert: false, dither: true, layers });

export const BUILTIN_PRESETS = {
  'Edge fade (all sides)': () => base([createLayer('edge')]),
  'Edge fade (left/right)': () => base([createLayer('edge', { name: 'Edge fade L/R', top: 0, bottom: 0 })]),
  'Edge fade (top/bottom)': () => base([createLayer('edge', { name: 'Edge fade T/B', left: 0, right: 0 })]),
  'Soft vignette': () => base([createLayer('radial')]),
  'Rounded card': () => base([createLayer('rect', { w: 0.8, h: 0.8, radius: 0.06, feather: 0.05 })]),
  'Spotlight': () => base([createLayer('ellipse', { w: 0.35, h: 0.6, feather: 0.2, curve: 'gaussian' })]),
  'Window (frame cut-out)': () => ({
    ...base([
      createLayer('edge', { left: E / 2, right: E / 2, top: E / 2, bottom: E / 2 }),
      createLayer('rect', { name: 'Hole', blend: 'subtract', w: 0.55, h: 0.55, radius: 0.03, feather: 0.04 }),
    ]),
  }),
  'Horizon band': () => base([createLayer('linear', { name: 'Band', angle: 90, mode: 'band', width: 0.25, fade: 0.3 })]),
  'Bottom ramp': () => base([createLayer('linear', { name: 'Ramp', angle: -90, cy: 0.6, fade: 0.8 })]),
};
