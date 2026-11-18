import { Router } from 'express';
import http from 'node:http';
import { sendError, sendSuccess } from '../utils/response';

// This path is deliberately not request-controlled. Only mount the restricted updater
// socket directory, never /var/run/docker.sock, into the application container.
const SOCKET = '/run/napcat-docker-updater/updater.sock';
const enabled = () => process.env['NAPCAT_DOCKER_UPDATER'] === '1';

function callHost (method: 'GET' | 'POST'): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, method, path: method === 'GET' ? '/status' : '/update',
      headers: method === 'POST' ? { 'Content-Length': '0' } : {}, timeout: 3000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 4096) req.destroy(new Error('response too large'));
      });
      res.on('end', () => {
        try {
          const data: unknown = JSON.parse(body);
          if (res.statusCode !== (method === 'GET' ? 200 : 202) || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('host rejected request');
          resolve(data as Record<string, unknown>);
        } catch { reject(new Error('invalid host response')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('host timeout')));
    req.on('error', reject);
    req.end();
  });
}

const router = Router();
// The existing auth middleware accepts query tokens; this privileged operation does not.
router.use((req, res, next) => {
  if (!/^Bearer\s+\S+$/i.test(req.headers.authorization ?? '') || Object.keys(req.query).length) return sendError(res, 'Unauthorized');
  return next();
});
router.get('/status', async (_req, res) => {
  if (!enabled()) return sendSuccess(res, { enabled: false, phase: 'disabled' });
  try { return sendSuccess(res, { ...(await callHost('GET')), enabled: true }); } catch { return sendError(res, '宿主更新器不可用'); }
});
router.post('/update', async (req, res) => {
  // Require same-origin browser POSTs even though global CORS reflects arbitrary origins.
  const origin = req.headers.origin;
  const fetchSite = req.headers['sec-fetch-site'];
  try {
    const url = new URL(origin ?? '');
    const allowed = process.env['NAPCAT_DOCKER_UPDATER_ORIGIN'];
    if (!allowed || origin !== allowed || url.origin !== allowed || !['http:', 'https:'].includes(url.protocol) ||
        (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none')) return sendError(res, '跨站请求被拒绝');
  } catch { return sendError(res, '缺少可信 Origin'); }
  if (!enabled()) return sendError(res, '宿主更新器未启用');
  if (!req.is('application/json') || !req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 0) return sendError(res, '仅接受空 JSON 对象');
  try { return sendSuccess(res, await callHost('POST')); } catch { return sendError(res, '宿主更新器不可用或正在更新'); }
});
export { router as DockerUpdaterRouter };
