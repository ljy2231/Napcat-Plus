import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PluginCatalog,
  PLUGIN_CATALOG_FRESH_MS,
  PLUGIN_CATALOG_MAX_BYTES,
  PLUGIN_CATALOG_REFRESH_COOLDOWN_MS,
  PLUGIN_CATALOG_SOURCE,
  validatePluginCatalog,
  isValidPluginCatalogId,
} from '../napcat-webui-backend/src/helper/PluginCatalog';

const remoteItem = {
  id: 'example-plugin',
  name: 'Example',
  version: '1.2.3',
  description: 'A sample',
  author: 'Example',
  homepage: 'https://github.com/example/plugin',
  downloadUrl: 'https://github.com/example/plugin/releases/download/v1.2.3/plugin.zip',
  tags: ['tools'],
  sha256: 'a'.repeat(64),
  availability: 'installable',
  builtinPath: 'javascript:alert(1)',
};
const remote = () => ({ version: '4', updateTime: '2026-11-15T00:00:00Z', plugins: [{ ...remoteItem }] });
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.useRealTimers());

describe('conservative plugin catalog', () => {
  it('returns the bundled directory immediately while one official fetch runs', async () => {
    let completeFetch!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { completeFetch = resolve; }));
    const catalog = new PluginCatalog({ fetcher });
    const list = catalog.snapshot();
    expect(list.sourceStatus).toBe('bundled');
    expect(list.refreshing).toBe(true);
    expect(list.remoteInstallEnabled).toBe(true);
    expect(list.plugins.map(item => item.id)).toEqual(['console-gscore', 'console-cleaner', 'console-debug']);
    expect(list.plugins.slice(0, 3).every(item => item.availability === 'builtin' && item.downloadUrl === '')).toBe(true);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(PLUGIN_CATALOG_SOURCE);
    completeFetch(new Response('404', { status: 404 }));
    await catalog.whenIdle();
    expect(catalog.snapshot()).toMatchObject({ sourceStatus: 'bundled', refreshing: false, lastSuccessAt: null });
  });

  it('merges validated remote items browse-only and bundled IDs win', async () => {
    const payload = remote(); payload.plugins.push({ ...remoteItem, id: 'console-gscore' });
    const catalog = new PluginCatalog({ fetcher: vi.fn(async () => response(payload)) });
    catalog.snapshot(); await catalog.whenIdle();
    const list = catalog.snapshot();
    expect(list.sourceStatus).toBe('online');
    expect(list.plugins).toHaveLength(4);
    expect(list.plugins[0]!.availability).toBe('builtin');
    expect(list.plugins[3]).toMatchObject({ availability: 'unavailable', downloadUrl: '', sourceUrl: PLUGIN_CATALOG_SOURCE });
    expect(list.plugins[3]).not.toHaveProperty('sha256');
    expect(list.plugins[3]).not.toHaveProperty('builtinPath');
    list.plugins[0]!.name = 'tampered'; list.plugins[0]!.tags!.push('tampered');
    expect(catalog.snapshot().plugins[0]!.name).not.toBe('tampered');
    expect(catalog.snapshot().plugins[0]!.tags).not.toContain('tampered');
  });

  it('discovers SSQQ only from the configured cloud index', async () => {
    expect(PLUGIN_CATALOG_SOURCE).toBe('https://raw.githubusercontent.com/ljy2231/napcat-plus-plugin-index/main/index.json');
    const payload = remote();
    payload.plugins = [{ ...remoteItem, id: 'napcat-plugin-ssqq', version: '3.5.2-3', downloadUrl: '' }];
    const catalog = new PluginCatalog({ fetcher: vi.fn(async () => response(payload)) });
    expect(catalog.snapshot().plugins.some(item => item.id === 'napcat-plugin-ssqq')).toBe(false);
    await catalog.whenIdle();
    expect(catalog.snapshot().plugins.find(item => item.id === 'napcat-plugin-ssqq')).toMatchObject({ version: '3.5.2-3', availability: 'unavailable', downloadUrl: '', sourceUrl: PLUGIN_CATALOG_SOURCE });
  });

  it('uses last-known-good cache as stale and never drops it on malformed refresh', async () => {
    let now = 1000;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(remote())).mockResolvedValueOnce(response({ plugins: 'wrong' }));
    const catalog = new PluginCatalog({ fetcher, now: () => now });
    catalog.snapshot(); await catalog.whenIdle();
    const originalSuccess = catalog.snapshot().lastSuccessAt;
    now += PLUGIN_CATALOG_FRESH_MS + 1;
    expect(catalog.snapshot()).toMatchObject({ sourceStatus: 'cached', refreshing: true });
    await catalog.whenIdle();
    expect(catalog.snapshot()).toMatchObject({ sourceStatus: 'cached', lastSuccessAt: originalSuccess, remoteInstallEnabled: true });
    expect(catalog.snapshot().plugins.some(item => item.id === remoteItem.id)).toBe(true);
  });

  it('coalesces force refresh and imposes cooldown even after fast 404s', async () => {
    let now = 1000;
    const fetcher = vi.fn(async () => new Response('gone', { status: 404 }));
    const catalog = new PluginCatalog({ fetcher, now: () => now });
    for (let i = 0; i < 100; i++) catalog.snapshot(true);
    await catalog.whenIdle();
    for (let i = 0; i < 100; i++) catalog.snapshot(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += PLUGIN_CATALOG_REFRESH_COOLDOWN_MS;
    catalog.snapshot(true); await catalog.whenIdle();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('bounds header/body work by four seconds even if fetch ignores abort', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => { signal = init?.signal; return new Promise<Response>(() => {}); });
    const catalog = new PluginCatalog({ fetcher, timeoutMs: 60000 });
    expect(catalog.snapshot().plugins).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(4000);
    await catalog.whenIdle();
    expect(signal?.aborted).toBe(true);
    expect(catalog.snapshot()).toMatchObject({ sourceStatus: 'bundled', refreshing: false });
  });

  it('bounds a stalled body and refuses redirect, oversized and wrong-content responses', async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({ start () {} });
    const stalled = new PluginCatalog({ fetcher: vi.fn(async () => new Response(stream, { headers: { 'content-type': 'application/json' } })) });
    stalled.snapshot(); await vi.advanceTimersByTimeAsync(4000); await stalled.whenIdle();
    expect(stalled.snapshot().sourceStatus).toBe('bundled');
    const responses = [
      new Response('{}', { headers: { 'content-type': 'text/html' } }),
      new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(PLUGIN_CATALOG_MAX_BYTES + 1) } }),
      new Response('a'.repeat(PLUGIN_CATALOG_MAX_BYTES + 1), { headers: { 'content-type': 'text/plain' } }),
    ];
    const redirected = response(remote()); Object.defineProperty(redirected, 'redirected', { value: true }); responses.push(redirected);
    for (const result of responses) {
      const catalog = new PluginCatalog({ fetcher: vi.fn(async () => result) });
      catalog.snapshot(); await catalog.whenIdle(); expect(catalog.snapshot().sourceStatus).toBe('bundled');
    }
  });
});

describe('untrusted remote index validation', () => {
  it.each(['..', '.', '../x', '/x', 'a/b', 'a\\b', 'x\n', 'a'.repeat(101)])('rejects invalid IDs: %s', id => {
    expect(isValidPluginCatalogId(id)).toBe(false);
    expect(() => validatePluginCatalog({ ...remote(), plugins: [{ ...remoteItem, id }] })).toThrow();
  });
  it.each(['http://github.com/o/r', 'https://evil.example/o/r', 'https://github.com@127.0.0.1/o/r', 'javascript:alert(1)', 'https://github.com/o/r?token=secret', 'https://github.com/o/r#fragment', 'https://github.com/o/r/%2fetc'])('rejects unsafe URLs: %s', homepage => {
    expect(() => validatePluginCatalog({ ...remote(), plugins: [{ ...remoteItem, homepage }] })).toThrow();
  });
  it('rejects duplicate IDs, excessive count, invalid types and forged digests', () => {
    expect(() => validatePluginCatalog({ ...remote(), plugins: [remoteItem, remoteItem] })).toThrow();
    expect(() => validatePluginCatalog({ ...remote(), plugins: Array.from({ length: 201 }, (_, i) => ({ ...remoteItem, id: `p${i}` })) })).toThrow();
    expect(() => validatePluginCatalog({ ...remote(), plugins: [{ ...remoteItem, name: {} }] })).toThrow();
    expect(() => validatePluginCatalog({ ...remote(), plugins: [{ ...remoteItem, sha256: 'fake' }] })).toThrow();
    expect(() => validatePluginCatalog({ ...remote(), plugins: [{ ...remoteItem, downloadUrl: 'http://localhost/secret' }] })).toThrow();
  });
  it('only enables the independently approved release tuple', () => {
    const approved = { ...remoteItem, id: 'napcat-plugin-ssqq', version: '3.5.2-3', downloadUrl: 'https://github.com/Stapxs/Stapxs-QQ-Lite-2.0/releases/download/v3.5.2/napcat-plugin-ssqq.zip', sha256: '82b9ef50f7e4ddb92a07149d763f7ce98502d24ac73ce8039499b24b25df1c04', size: 6118730 };
    expect(validatePluginCatalog({ ...remote(), plugins: [approved] }).plugins[0]).toMatchObject({ availability: 'installable', sha256: approved.sha256, size: approved.size });
    for (const alteration of [{ sha256: 'b'.repeat(64) }, { size: approved.size + 1 }, { version: '3.5.2-4' }, { downloadUrl: remoteItem.downloadUrl }]) {
      expect(validatePluginCatalog({ ...remote(), plugins: [{ ...approved, ...alteration }] }).plugins[0]).toMatchObject({ availability: 'unavailable', downloadUrl: '' });
    }
  });
  it('strips HTML angle brackets and ignores all remote availability/install claims', () => {
    const list = validatePluginCatalog({ ...remote(), plugins: [{ ...remoteItem, description: '<script>evil</script>' }], sourceStatus: 'online', remoteInstallEnabled: true });
    expect(list.plugins[0]!.description).not.toContain('<');
    expect(list.plugins[0]!.availability).toBe('unavailable');
    expect(list.plugins[0]!.downloadUrl).toBe('');
    expect(list.remoteInstallEnabled).toBeUndefined();
  });
});
