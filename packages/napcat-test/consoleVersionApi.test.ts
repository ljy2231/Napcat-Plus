import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const { check } = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('@/napcat-webui-backend/index', () => ({ getInitialWebUiToken: () => 'test-token', webUiPathWrapper: {} }));
vi.mock('../napcat-webui-backend/src/helper/ConsoleVersion', () => ({
  checkConsoleVersion: check,
  resolveConsoleVersion: (_value: string | undefined, fallback: string) => fallback,
}));
vi.mock('../napcat-webui-backend/src/helper/Data', () => ({ WebUiDataRuntime: {} }));
vi.mock('@/napcat-common/src/gscore/runtime', () => ({ getGScoreRuntime: vi.fn() }));
vi.mock('@/napcat-onebot/network/plugin-manger', () => ({}));
import { auth } from '../napcat-webui-backend/src/middleware/auth';
import { AuthHelper } from '../napcat-webui-backend/src/helper/SignToken';
import { ConsoleRouter } from '../napcat-webui-backend/src/router/Console';

let server: Server;
let baseUrl: string;
beforeAll(async () => {
  const app = express();
  app.use('/api', auth, express.Router().use('/Console', ConsoleRouter));
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

describe('authenticated Console update check', () => {
  test('rejects missing and invalid credentials before calling checker', async () => {
    for (const headers of [new Headers(), new Headers({ Authorization: 'Bearer invalid' })]) {
      const response = await fetch(`${baseUrl}/api/Console/update/check`, { headers });
      expect(await response.json()).toMatchObject({ code: -1, message: 'Unauthorized' });
    }
    expect(check).not.toHaveBeenCalled();
  });
  test('allows a valid credential and returns the checker result', async () => {
    const result = { currentVersion: '0.5.2', latestVersion: '0.6.0', status: 'available' };
    check.mockResolvedValueOnce(result);
    const credential = AuthHelper.signCredential(AuthHelper.generatePasswordHash('test-token'));
    const authorization = Buffer.from(JSON.stringify(credential)).toString('base64');
    const response = await fetch(`${baseUrl}/api/Console/update/check`, { headers: { Authorization: `Bearer ${authorization}` } });
    expect(await response.json()).toEqual({ code: 0, message: 'success', data: result });
    expect(check).toHaveBeenCalledWith('0.5.2');
  });
});
