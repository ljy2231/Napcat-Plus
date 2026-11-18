import { Router } from 'express';
import http from 'node:http';
import { sendError, sendSuccess } from '../utils/response';

// This path is deliberately not request-controlled. Only mount the restricted updater
// socket directory, never /var/run/docker.sock, into the application container.
const SOCKET = '/run/napcat-docker-updater/updater.sock';
const enabled = () => process.env['NAPCAT_DOCKER_UPDATER'] === '1';

type UpdateSource = 'ghcr' | 'mirror';
type UpdateExpectation = { source: UpdateSource; expectedVersion: string; expectedDigest: string; };
type HostAction = 'status' | 'preview' | 'update';
const MAX_REQUEST_BYTES = 1024;
const MAX_RESPONSE_BYTES = 4096;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function isVersion (value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && !/\s/.test(value) && VERSION_RE.test(value);
}

function isDigest (value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function callHost (action: HostAction, expectation?: UpdateExpectation): Promise<Record<string, unknown>> {
  const method = action === 'update' ? 'POST' : 'GET';
  const payload = action === 'update' ? JSON.stringify(expectation) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, method, path: `/${action}`,
      headers: payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload).toString() },
      timeout: action === 'preview' ? 45_000 : 3000 }, res => {
      let body = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_RESPONSE_BYTES) {
          const error = new Error('response too large');
          reject(error);
          req.destroy(error);
          return;
        }
        body += chunk;
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
    req.end(payload);
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
  try { return sendSuccess(res, { ...(await callHost('status')), enabled: true }); } catch { return sendError(res, '宿主更新器不可用'); }
});
router.get('/preview', async (_req, res) => {
  if (!enabled()) return sendError(res, '宿主更新器未启用');
  try {
    const result = await callHost('preview');
    // Do not expose arbitrary host-provided fields (in particular URLs or paths).
    if (!isVersion(result['version']) || !isDigest(result['digest'])) return sendError(res, '宿主更新预检结果无效');
    return sendSuccess(res, { version: result['version'], digest: result['digest'] });
  } catch { return sendError(res, '宿主更新预检不可用'); }
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
  // The global JSON parser already enforces its own limit. Require a small, uncompressed,
  // fixed-length body here as well, and never forward arbitrary request properties.
  const length = req.headers['content-length'];
  if (!length || !/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES ||
      req.headers['transfer-encoding'] || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
    return sendError(res, '请求体长度无效');
  }
  const body: unknown = req.body;
  if (!req.is('application/json') || !body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, '更新请求参数无效');
  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  if (keys.length !== 3 || !['source', 'expectedVersion', 'expectedDigest'].every(key => Object.prototype.hasOwnProperty.call(values, key)) ||
      (values['source'] !== 'ghcr' && values['source'] !== 'mirror') || !isVersion(values['expectedVersion']) || !isDigest(values['expectedDigest'])) {
    return sendError(res, '更新请求参数无效');
  }
  // These are only expected values from preview, not authorization or a target
  // supplied by the client. The host resolves and validates everything again.
  const expectation: UpdateExpectation = {
    source: values['source'],
    expectedVersion: values['expectedVersion'],
    expectedDigest: values['expectedDigest'],
  };
  try { return sendSuccess(res, await callHost('update', expectation)); } catch { return sendError(res, '宿主更新器不可用或正在更新'); }
});
export { router as DockerUpdaterRouter };
