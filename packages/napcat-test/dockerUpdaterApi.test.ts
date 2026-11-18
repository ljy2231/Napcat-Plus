import express from 'express';
import http, { type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the real credential middleware without importing the live WebUI singleton.
vi.mock('@/napcat-webui-backend/index', () => ({ getInitialWebUiToken: () => 'updater-test-token' }));
import { auth } from '../napcat-webui-backend/src/middleware/auth';
import { AuthHelper } from '../napcat-webui-backend/src/helper/SignToken';
import { DockerUpdaterRouter } from '../napcat-webui-backend/src/router/DockerUpdater';

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://console.example.test';
const VERSION = '0.5.3';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const EXPECTATION = { source: 'ghcr', expectedVersion: VERSION, expectedDigest: DIGEST };
const credential = Buffer.from(JSON.stringify(AuthHelper.signCredential(AuthHelper.generatePasswordHash('updater-test-token')))).toString('base64');
let server: Server;
let baseUrl: string;
let socketRequest: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Match the production order: global credential validation precedes this router.
  app.use('/api', auth, express.Router().use('/Console/docker-update', DockerUpdaterRouter));
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test address');
  baseUrl = `http://127.0.0.1:${address.port}/api/Console/docker-update`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => {
  process.env['NAPCAT_DOCKER_UPDATER'] = '1';
  process.env['NAPCAT_DOCKER_UPDATER_ORIGIN'] = ORIGIN;
  // Never open a Unix socket: simulate ENOENT after request.end().
  socketRequest = vi.spyOn(http, 'request').mockImplementation((() => {
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
    request.end = () => { process.nextTick(() => request.emit('error', Object.assign(new Error('ENOENT /secret/path'), { code: 'ENOENT' }))); };
    request.destroy = (error?: Error) => { if (error) process.nextTick(() => request.emit('error', error)); };
    return request;
  }) as unknown as typeof http.request);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_ENV['NAPCAT_DOCKER_UPDATER'] === undefined) delete process.env['NAPCAT_DOCKER_UPDATER'];
  else process.env['NAPCAT_DOCKER_UPDATER'] = ORIGINAL_ENV['NAPCAT_DOCKER_UPDATER'];
  if (ORIGINAL_ENV['NAPCAT_DOCKER_UPDATER_ORIGIN'] === undefined) delete process.env['NAPCAT_DOCKER_UPDATER_ORIGIN'];
  else process.env['NAPCAT_DOCKER_UPDATER_ORIGIN'] = ORIGINAL_ENV['NAPCAT_DOCKER_UPDATER_ORIGIN'];
});

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${credential}`, Origin: ORIGIN, ...extra };
}
async function get(suffix: string, requestHeaders: Record<string, string> = headers()) {
  return (await fetch(baseUrl + suffix, { headers: requestHeaders })).json();
}
async function post(suffix: string, requestHeaders: Record<string, string> = headers({ 'Content-Type': 'application/json' }), body = JSON.stringify(EXPECTATION)) {
  return (await fetch(baseUrl + suffix, { method: 'POST', headers: requestHeaders, body })).json();
}

describe('Docker updater privileged API', () => {
  it('rejects missing and invalid credentials before reaching the host', async () => {
    const credentials: Record<string, string>[] = [{}, { Authorization: 'Bearer invalid' }, { Authorization: 'Basic invalid' }];
    for (const requestHeaders of credentials) {
      expect(await get('/status', requestHeaders)).toMatchObject({ code: -1, message: 'Unauthorized' });
      expect(await get('/preview', requestHeaders)).toMatchObject({ code: -1, message: 'Unauthorized' });
      expect(await post('/update', { ...requestHeaders, Origin: ORIGIN, 'Content-Type': 'application/json' })).toMatchObject({ code: -1, message: 'Unauthorized' });
    }
    expect(socketRequest).not.toHaveBeenCalled();
  });

  it('rejects query credentials and any query even with a valid bearer credential', async () => {
    expect(await get(`/status?webui_token=${encodeURIComponent(credential)}`, {})).toMatchObject({ code: -1, message: 'Unauthorized' });
    for (const suffix of ['?webui_token=x', '?unused=1']) {
      expect(await get('/status' + suffix)).toMatchObject({ code: -1, message: 'Unauthorized' });
      expect(await get('/preview' + suffix)).toMatchObject({ code: -1, message: 'Unauthorized' });
      expect(await post('/update' + suffix)).toMatchObject({ code: -1, message: 'Unauthorized' });
    }
    expect(socketRequest).not.toHaveBeenCalled();
  });

  it('rejects missing, cross-origin and cross-site update requests', async () => {
    const missing = { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' };
    expect(await post('/update', missing)).toMatchObject({ code: -1, message: '缺少可信 Origin' });
    for (const origin of ['https://evil.example.test', 'null', `${ORIGIN}/path`, 'http://console.example.test']) {
      const result = await post('/update', headers({ Origin: origin, 'Content-Type': 'application/json' }));
      expect(result).toMatchObject({ code: -1 });
    }
    expect(await post('/update', headers({ 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }))).toMatchObject({ code: -1, message: '跨站请求被拒绝' });
    delete process.env['NAPCAT_DOCKER_UPDATER_ORIGIN'];
    expect(await post('/update')).toMatchObject({ code: -1, message: '跨站请求被拒绝' });
    expect(socketRequest).not.toHaveBeenCalled();
  });

  it('rejects malformed or extra fields, arbitrary source and invalid expectation before host calls', async () => {
    expect(await post('/update', headers({ 'Content-Type': 'text/plain' }))).toMatchObject({ code: -1, message: '更新请求参数无效' });
    const invalid = [
      {}, { image: 'evil' }, [], { source: 'ghcr' },
      { ...EXPECTATION, source: 'https://evil.example/image' }, { ...EXPECTATION, source: 'GHCR' },
      { ...EXPECTATION, source: null }, { ...EXPECTATION, source: ['ghcr'] },
      { ...EXPECTATION, url: 'https://evil.example' }, { ...EXPECTATION, path: '/etc/shadow' },
      { ...EXPECTATION, expectedVersion: 'v0.5.3' }, { ...EXPECTATION, expectedVersion: '0.05.3' },
      { ...EXPECTATION, expectedVersion: '0.5.3-preview.1' }, { ...EXPECTATION, expectedVersion: '0.5.3\n' },
      { ...EXPECTATION, expectedDigest: 'sha256:' + 'A'.repeat(64) }, { ...EXPECTATION, expectedDigest: 'a'.repeat(64) },
      { ...EXPECTATION, expectedDigest: `${DIGEST}\n` }, { ...EXPECTATION, expectedDigest: null },
    ];
    for (const value of invalid) {
      expect(await post('/update', headers({ 'Content-Type': 'application/json' }), JSON.stringify(value))).toMatchObject({ code: -1, message: '更新请求参数无效' });
    }
    expect(await post('/update', headers({ 'Content-Type': 'application/json' }), JSON.stringify({ ...EXPECTATION, padding: 'x'.repeat(1024) }))).toMatchObject({ code: -1, message: '请求体长度无效' });
    // Express's strict JSON parser rejects a primitive before the router.
    const primitive = await fetch(baseUrl + '/update', { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: 'null' });
    expect(primitive.status).toBe(400);
    expect(socketRequest).not.toHaveBeenCalled();
  });

  it('reports disabled status and refuses updates without connecting to the host', async () => {
    delete process.env['NAPCAT_DOCKER_UPDATER'];
    expect(await get('/status')).toEqual({ code: 0, message: 'success', data: { enabled: false, phase: 'disabled' } });
    expect(await get('/preview')).toMatchObject({ code: -1, message: '宿主更新器未启用' });
    expect(await post('/update')).toMatchObject({ code: -1, message: '宿主更新器未启用' });
    expect(socketRequest).not.toHaveBeenCalled();
  });

  it('forwards only the source and preview expectations as length-delimited JSON', async () => {
    const payloads: unknown[] = [];
    socketRequest.mockImplementation(((options: { method: string }, callback: (res: EventEmitter) => void) => {
      const request = new EventEmitter() as EventEmitter & { end: (body?: string) => void; destroy: (error?: Error) => void };
      request.destroy = (error?: Error) => { if (error) process.nextTick(() => request.emit('error', error)); };
      request.end = body => {
        payloads.push(body);
        process.nextTick(() => {
          const response = new EventEmitter() as EventEmitter & { statusCode: number; setEncoding: () => void };
          response.statusCode = options.method === 'POST' ? 202 : 200;
          response.setEncoding = () => {};
          callback(response);
          response.emit('data', '{"phase":"updating"}');
          response.emit('end');
        });
      };
      return request;
    }) as unknown as typeof http.request);
    for (const source of ['ghcr', 'mirror']) {
      expect(await post('/update', headers({ 'Content-Type': 'application/json' }), JSON.stringify({ ...EXPECTATION, source }))).toMatchObject({ code: 0, data: { phase: 'updating' } });
    }
    expect(payloads).toEqual([JSON.stringify(EXPECTATION), JSON.stringify({ ...EXPECTATION, source: 'mirror' })]);
    for (const [index, call] of socketRequest.mock.calls.entries()) {
      const options = call[0] as { socketPath: string; method: string; path: string; headers: Record<string, string> };
      expect(options).toMatchObject({ socketPath: '/run/napcat-docker-updater/updater.sock', method: 'POST', path: '/update', headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payloads[index] as string)) } });
    }
  });

  it('rejects an oversized host response without exposing its contents', async () => {
    socketRequest.mockImplementation(((_options: unknown, callback: (res: EventEmitter) => void) => {
      const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
      request.destroy = (error?: Error) => { if (error) process.nextTick(() => request.emit('error', error)); };
      request.end = () => process.nextTick(() => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number; setEncoding: () => void };
        response.statusCode = 202;
        response.setEncoding = () => {};
        callback(response);
        response.emit('data', 'x'.repeat(4097));
        response.emit('end');
      });
      return request;
    }) as unknown as typeof http.request);
    expect(await post('/update')).toEqual({ code: -1, message: '宿主更新器不可用或正在更新' });
  });

  it('fails closed when the host socket is missing without leaking socket errors', async () => {
    expect(await get('/status')).toEqual({ code: -1, message: '宿主更新器不可用' });
    expect(await get('/preview')).toEqual({ code: -1, message: '宿主更新预检不可用' });
    expect(await post('/update')).toEqual({ code: -1, message: '宿主更新器不可用或正在更新' });
    expect(socketRequest).toHaveBeenCalledTimes(3);
    const options = socketRequest.mock.calls.map(call => call[0] as { socketPath: string; method: string; path: string });
    expect(options).toEqual([
      expect.objectContaining({ socketPath: '/run/napcat-docker-updater/updater.sock', method: 'GET', path: '/status', timeout: 3000 }),
      expect.objectContaining({ socketPath: '/run/napcat-docker-updater/updater.sock', method: 'GET', path: '/preview', timeout: 45000 }),
      expect.objectContaining({ socketPath: '/run/napcat-docker-updater/updater.sock', method: 'POST', path: '/update', timeout: 3000 }),
    ]);
  });
});
