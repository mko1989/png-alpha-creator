# PNG Alpha Creator

Create PNG alpha masks in your browser: edge fades, vignettes, feathered shapes and gradients,
combined in layers and exported as alpha PNGs or B/W key mattes.

Everything runs locally in the browser, so nothing is uploaded. It's a static site, hosted on GitHub Pages.

- **Fast to work with:** while you drag, a low-res preview renders every frame; a full-resolution
  render follows in a Web Worker as soon as you pause. All controls stay in view.
- **Exact exports:** PNGs are rendered and encoded in a worker by the same renderer as the preview.
  The built-in presets reproduce the masks in [`reference/`](reference/) to within ±2/255 (`npm test`).
- **No dependencies:** plain HTML/CSS/JS ES modules. There's no build step and nothing to install.

## Using it

- **Document** (left): resolution presets or custom W×H, base fill, global gamma, invert, and dither
  (adds sub-LSB noise so long fades don't band).
- **Add shape:** Edge fade · Rectangle (rounded corners) · Ellipse · Vignette · Gradient (ramp or band).
- **Layers** apply bottom to top with a blend mode (Add, Subtract, Multiply, Lighten, Darken,
  Difference), opacity and invert. Drag rows to reorder.
- **Properties** (right): every value has a slider and a number field in px, % or °. Double-click a
  label to reset it. Fades use a curve (Smooth, Linear, Smoother, Ease in/out, Sine, Gaussian) and a
  falloff power. Geometry is stored relative to the canvas, so changing resolution keeps the look.
- **Canvas:** left-drag moves shapes. Dragging on any shape selects and moves it; dragging elsewhere
  moves the selected shape. Handles set size, rotation, gradient angle and edge-fade widths. Shift
  snaps or constrains. Space-drag, right-drag or middle-drag pans. Wheel zooms at the cursor. Past
  1200% a pixel grid appears. The status bar shows the exact α under the cursor.
- **Preview modes:** Matte, Alpha (checkerboard), Cut-out and Overlay. The last two show a TV test
  card until you load a reference image (button or drag and drop). The ⤢ button sets the document
  size to the image size.
- **Export:** Alpha (white + α), Key (RGB B/W), black + α, 8-bit grayscale, or Alpha + Key together.
  Up to 8192×8192.
- **Presets:** built-in presets keep the current resolution. **Save** stores the current mask in
  this browser, and saved presets restore their own resolution. Use the export/import buttons (or
  drop a `.json` on the canvas) to back them up or move them to another browser or machine. Clearing
  site data deletes presets you haven't exported.

| Keys | Action |
|------|--------|
| Ctrl/⌘ Z · Ctrl/⌘ Shift Z | Undo · Redo |
| Ctrl/⌘ E | Export |
| Ctrl/⌘ D · Del | Duplicate · Delete layer |
| `[` `]` | Move layer down / up |
| H | Toggle layer visibility |
| Arrows (Shift = 10 px) | Nudge shape |
| 0 / F · 1 · + / − | Fit · 100% · Zoom |

## Develop

```bash
npm start      # serves public/ at http://localhost:8080 (modules and workers need http, not file://)
npm test       # renders vs reference masks + PNG encoder round-trips (Node 18+)
```

Any static file server works too, e.g. `python3 -m http.server -d public`.

## Deploy to GitHub Pages

The workflow in [`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs the tests and
publishes `public/` on every push to `main`. One-time setup: in the repository, go to
**Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.

## Layout

```
public/index.html, css/app.css   the page
public/js/core.js                renderer + document model
public/js/app.js                 editor UI
public/js/worker.js              full-res previews and PNG export
public/js/png.js                 PNG encoder (CompressionStream)
public/js/presets.js             built-in presets
reference/                       reference masks used by the tests
scripts/verify.js                npm test
scripts/serve.js                 npm start (local preview)
```

## License

[MIT](LICENSE)
