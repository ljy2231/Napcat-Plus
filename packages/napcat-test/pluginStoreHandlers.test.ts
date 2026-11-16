import { afterEach, expect, it, vi } from 'vitest';
import type { Request, Response as ExpressResponse } from 'express';
import fs from 'node:fs';
import {
  GetPluginStoreDetailHandler,
  GetPluginStoreListHandler,
  InstallPluginFromStoreHandler,
  InstallPluginFromStoreSSEHandler,
} from '../napcat-webui-backend/src/api/PluginStore';
import { pluginCatalog } from '../napcat-webui-backend/src/helper/PluginCatalog';

function responseMock () {
  const chunks: string[] = [];
  const mock = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => { chunks.push(chunk); return true; }),
    end: vi.fn(),
    writableEnded: false,
  };
  return { mock, chunks, res: mock as unknown as ExpressResponse };
}
const next = () => {};
const postRequest = (body: unknown) => ({ body, headers: { authorization: 'Bearer test' }, is: () => 'application/json' }) as unknown as Request;
afterEach(() => vi.restoreAllMocks());

async function settleCatalog (): Promise<void> {
  const { res } = responseMock();
  await GetPluginStoreListHandler({ query: { forceRefresh: 'true' } } as unknown as Request, res, next);
  await pluginCatalog.whenIdle();
}

it('rejects builtin, unknown and client-supplied install requests without fetching or writing', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('gone', { status: 404 }));
  await settleCatalog();
  const network = vi.spyOn(globalThis, 'fetch');
  network.mockClear();
  const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('must not write'); });
  const remove = vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw new Error('must not delete'); });
  for (const id of ['console-gscore', 'napcat-plugin-ssqq', 'third-party']) {
    const { mock, res } = responseMock();
    // Client-supplied mirrors, URLs and digests must never override the catalog.
    await InstallPluginFromStoreHandler(postRequest({ id, force: true, mirror: 'https://evil.example', downloadUrl: 'http://localhost/private', sha256: 'a'.repeat(64) }), res, next);
    expect(mock.json).toHaveBeenCalledWith(expect.objectContaining({ code: -1 }));
  }
  expect(network).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});

it('SSE installer reports a catalog rejection once and ends', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('gone', { status: 404 }));
  await settleCatalog();
  network.mockClear();
  const { mock, chunks, res } = responseMock();
  await InstallPluginFromStoreSSEHandler({ query: { id: 'console-gscore', mirror: 'https://evil.example', force: 'true' } } as unknown as Request, res, next);
  expect(mock.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
  expect(chunks).toHaveLength(1);
  expect(JSON.parse(chunks[0]!.slice(6))).toMatchObject({ code: -1, error: '请使用 POST 接口安装插件' });
  expect(mock.end).toHaveBeenCalledOnce();
  expect(network).not.toHaveBeenCalled();
});

it('rejects traversal and non-string ids in both installers', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'));
  for (const id of ['..', '../x', ['x'], null, {}]) {
    const post = responseMock();
    await InstallPluginFromStoreHandler(postRequest({ id }), post.res, next);
    expect(post.mock.json).toHaveBeenCalledWith({ code: -1, message: '插件 ID 无效' });
    const sse = responseMock();
    await InstallPluginFromStoreSSEHandler({ query: { id } } as unknown as Request, sse.res, next);
    expect(JSON.parse(sse.chunks[0]!.slice(6)).error).toBe('请使用 POST 接口安装插件');
  }
  expect(network).not.toHaveBeenCalled();
});

it('list preserves successful envelope/plugins array during upstream outage', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('gone', { status: 404 }));
  const { mock, res } = responseMock();
  await GetPluginStoreListHandler({ query: { forceRefresh: 'true' } } as unknown as Request, res, next);
  expect(mock.json).toHaveBeenCalledWith(expect.objectContaining({ code: 0, data: expect.objectContaining({ plugins: expect.any(Array), sourceStatus: 'bundled', remoteInstallEnabled: true }) }));
  const detail = responseMock();
  await GetPluginStoreDetailHandler({ params: { id: 'console-cleaner' } } as unknown as Request, detail.res, next);
  expect(detail.mock.json).toHaveBeenCalledWith(expect.objectContaining({ code: 0, data: expect.objectContaining({ availability: 'builtin', builtinPath: '/tools' }) }));
});
