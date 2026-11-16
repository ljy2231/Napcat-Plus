import express from 'express';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

export const WEBUI_NO_STORE = 'no-store, max-age=0, must-revalidate';

/** Index bytes include hashed JS/CSS entrypoints, so same-version rebuilds differ. */
export function webUiBuildFingerprint (directory: string): string {
  try { return createHash('sha256').update(readFileSync(join(directory, 'index.html'))).digest('hex').slice(0, 20); } catch { return 'missing-index'; }
}

/** Mount after sw.js, at /webui. Assets must never fall through to SPA HTML. */
export function createWebUiStaticRouter (directory: string): express.Router {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
  router.use(express.static(directory, {
    maxAge: 0,
    setHeaders (res, file) {
      if (extname(file) === '.html' || basename(file) === 'sw.js' || basename(file) === 'sw_template.js') {
        res.setHeader('Cache-Control', WEBUI_NO_STORE);
      } else if (/[.-][a-zA-Z0-9_-]{8,}\.(?:m?js|css|png|jpe?g|webp|svg|woff2?|ttf)$/.test(basename(file))) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
      }
    },
  }));
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', WEBUI_NO_STORE);
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(404).type('text/plain').send('Not found');
    if (req.path.startsWith('/assets/') || req.path.startsWith('/fonts/') || extname(req.path)) {
      return res.status(404).type('text/plain').send('WebUI resource not found. Refresh the page to load the current build.');
    }
    // Only route-like paths may receive the SPA entrypoint, never missing modules.
    return res.sendFile(join(directory, 'index.html'), { headers: { 'Cache-Control': WEBUI_NO_STORE } }, error => { if (error) next(error); });
  });
  return router;
}
