// Off-main-thread work so the UI never stalls:
//   { id, doc }                    -> full-resolution preview (RGBA, white + alpha)
//   { id, doc, export: format }    -> encoded PNG bytes for download
import { renderAlpha, alphaToRGBA, alphaToFormat, EXPORT_FORMATS } from './core.js';
import { encodePNG } from './png.js';

self.onmessage = async (e) => {
  const { id, doc } = e.data;
  const t0 = performance.now();
  try {
    if (e.data.export) {
      const format = e.data.export;
      const alpha = renderAlpha(doc, doc.width, doc.height);
      const png = await encodePNG(alphaToFormat(alpha, format), doc.width, doc.height, EXPORT_FORMATS[format].channels);
      self.postMessage({ id, png, ms: performance.now() - t0 }, [png.buffer]);
      return;
    }
    const rgba = alphaToRGBA(renderAlpha(doc, doc.width, doc.height));
    self.postMessage({ id, w: doc.width, h: doc.height, rgba, ms: performance.now() - t0 }, [rgba.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
