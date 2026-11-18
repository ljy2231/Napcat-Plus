import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { httpsGet } = vi.hoisted(() => ({ httpsGet: vi.fn() }));
vi.mock('node:https', () => ({ get: httpsGet }));
import { createConsoleVersionChecker, resolveConsoleVersion } from '../napcat-webui-backend/src/helper/ConsoleVersion';

type Reply = { status?: number; body?: string; error?: boolean; hang?: boolean; };
function mockReply (reply: Reply) {
  httpsGet.mockImplementation((_url, _options, callback) => {
    const request = new EventEmitter() as EventEmitter & { destroy: () => void; };
    request.destroy = vi.fn();
    queueMicrotask(() => {
      if (reply.hang) return;
      if (reply.error) return void request.emit('error', new Error('network secret'));
      const response = new EventEmitter() as EventEmitter & { statusCode: number; complete: boolean; destroy: () => void; };
      response.statusCode = reply.status ?? 200;
      response.complete = true;
      response.destroy = vi.fn();
      callback(response);
      if (response.statusCode === 200) {
        response.emit('data', Buffer.from(reply.body ?? ''));
        response.emit('end');
      }
    });
    return request;
  });
}
const release = (tag: string, overrides = {}) => JSON.stringify({ tag_name: tag, draft: false, prerelease: false, ...overrides });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe('Napcat-Plus release check', () => {
  test('uses only the fixed GitHub API, without credentials, and compares releases', async () => {
    mockReply({ body: release('v0.6.0') });
    const check = createConsoleVersionChecker();
    expect(await check('0.5.1')).toEqual({ currentVersion: '0.5.1', latestVersion: '0.6.0', status: 'available', releaseUrl: 'https://github.com/ljy2231/Napcat-Plus/releases/tag/v0.6.0' });
    expect(httpsGet).toHaveBeenCalledWith('https://api.github.com/repos/ljy2231/Napcat-Plus/releases/latest', { headers: { 'User-Agent': 'Napcat-Plus-Version-Check', Accept: 'application/vnd.github+json' } }, expect.any(Function));
    expect((await check('0.6.0')).status).toBe('current');
    expect((await check('0.7.0')).status).toBe('unknown');
    expect(httpsGet).toHaveBeenCalledTimes(1);
  });

  test.each(['1.2', '01.2.3', 'v1.2.3-rc.1', '1.2.3\n', ' v1.2.3', '1.2.3+bad..x', '1.2.3/evil'])('rejects invalid or prerelease tag %s', async (tag) => {
    mockReply({ body: release(tag) });
    expect(await createConsoleVersionChecker()('0.5.1')).toEqual({ currentVersion: '0.5.1', latestVersion: null, status: 'unknown' });
  });

  test('handles arbitrary length numeric components and ignores build metadata', async () => {
    mockReply({ body: release('v999999999999999999999999.0.0+build.2') });
    expect((await createConsoleVersionChecker()('999999999999999999999998.0.0')).status).toBe('available');
    mockReply({ body: release('0.5.1+build.2') });
    expect((await createConsoleVersionChecker()('0.5.1+other')).status).toBe('current');
  });

  test.each([
    { status: 302 }, { status: 403 }, { status: 500 }, { error: true },
    { body: 'not json' }, { body: release('1.0.0', { draft: true }) },
    { body: release('1.0.0', { prerelease: true }) }, { body: release('1.0.0', { prerelease: undefined }) },
    { body: 'x'.repeat(65537) },
  ])('returns unknown on upstream failure %o', async (reply) => {
    mockReply(reply);
    expect(await createConsoleVersionChecker()('0.5.1')).toEqual({ currentVersion: '0.5.1', latestVersion: null, status: 'unknown' });
  });

  test('coalesces concurrent calls, caches briefly and does not use stale success after failure', async () => {
    vi.useFakeTimers();
    mockReply({ body: release('0.5.1') });
    const check = createConsoleVersionChecker();
    const pending = [check('0.5.1'), check('0.4.0')];
    await vi.runAllTicks();
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual(['current', 'available']);
    expect(httpsGet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_001);
    mockReply({ error: true });
    const failed = check('0.5.1');
    await vi.runAllTicks();
    expect((await failed).status).toBe('unknown');
    expect((await check('0.5.1')).status).toBe('unknown');
    expect(httpsGet).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_001);
    mockReply({ body: release('0.6.0') });
    const retry = check('0.5.1');
    await vi.runAllTicks();
    expect((await retry).status).toBe('available');
    expect(httpsGet).toHaveBeenCalledTimes(3);
  });

  test('resolves the build-injected version and falls back on invalid input', () => {
    expect(resolveConsoleVersion('0.5.2', '0.5.1')).toBe('0.5.2');
    expect(resolveConsoleVersion('0.6.0-preview.1', '0.5.1')).toBe('0.6.0-preview.1');
    expect(resolveConsoleVersion('1.0.0+build.7', '0.5.1')).toBe('0.5.1');
    for (const bad of [undefined, '', 'v0.5.2', '0.5', '01.0.0', '0.5.1\n', 'x']) {
      expect(resolveConsoleVersion(bad, '0.5.1')).toBe('0.5.1');
    }
  });

  test('times out stalled requests and never makes a request for invalid current versions', async () => {
    vi.useFakeTimers();
    mockReply({ hang: true });
    const check = createConsoleVersionChecker();
    expect((await check('0.5')).status).toBe('unknown');
    expect(httpsGet).not.toHaveBeenCalled();
    const pending = check('0.5.1');
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await pending).status).toBe('unknown');
    expect(httpsGet.mock.results[0]!.value.destroy).toHaveBeenCalled();
  });
});
