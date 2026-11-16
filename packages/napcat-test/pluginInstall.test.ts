import { createHash } from 'node:crypto';
import { readFile, mkdtemp, readdir, rm, stat, mkdir, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/napcat-onebot/action', () => ({}));
vi.mock('@/napcat-onebot/index', () => ({}));
vi.mock('@/napcat-onebot/network/index', () => ({}));
vi.mock('@/napcat-onebot/network/adapter', () => ({ IOB11NetworkAdapter: class {} }));
import { installPluginFromStore, PluginInstallError } from '../napcat-webui-backend/src/helper/PluginInstaller';
import { OB11PluginMangerAdapter } from '../napcat-onebot/network/plugin-manger';
import { PluginLoader } from '../napcat-onebot/network/plugin/loader';
import type { PluginStoreItem } from '../napcat-webui-backend/src/types/PluginStore';

const fixtureDir = fileURLToPath(new URL('./fixtures/plugins/', import.meta.url));
const tempDirs: string[] = [];

async function readFixture (name: string): Promise<Buffer> {
  return readFile(path.join(fixtureDir, name));
}

async function createPluginDir (): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'napcat-plugin-install-'));
  tempDirs.push(dir);
  return dir;
}

function itemFor (id: string, version: string, archive: Buffer): PluginStoreItem {
  return {
    id,
    name: id,
    version,
    description: '',
    author: '',
    downloadUrl: `https://github.com/example/repo/releases/download/v${version}/plugin.zip`,
    sha256: createHash('sha256').update(archive).digest('hex'),
    size: archive.byteLength,
    availability: 'installable',
  };
}

function fetcherFor (archive: Buffer, rewrite?: (body: Buffer) => Buffer): typeof fetch {
  return (async () => new Response(rewrite ? rewrite(archive) : archive, {
    status: 200,
    headers: { 'content-length': String(archive.byteLength) },
  })) as unknown as typeof fetch;
}

function manager (loaded = true) {
  const calls: string[] = [];
  return {
    calls,
    getPluginInfo: () => undefined,
    preparePluginInstall: (id: string) => { calls.push(`prepare:${id}`); },
    finishPluginInstall: () => {},
    registerInstalledDirectory: (id: string) => { calls.push(`register:${id}`); return loaded; },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('store plugin installer', () => {

  it('rejects installation without a manager', async () => {
    const dir = await createPluginDir();
    const archive = await readFixture('valid.zip');
    await expect(installPluginFromStore(itemFor('napcat-plugin-demo', '1.0.0', archive), null, () => {}, { pluginDir: dir, fetcher: fetcherFor(archive) })).rejects.toThrow('管理器');
    expect(await readdir(dir)).toEqual([]);
  });

  it.each(['../escape', '/absolute', '.', '..', 'bad/name', 'bad\\name'])('rejects unsafe ID %s', async id => {
    const dir = await createPluginDir();
    const archive = await readFixture('valid.zip');
    await expect(installPluginFromStore(itemFor(id, '1.0.0', archive), manager(), () => {}, { pluginDir: dir, fetcher: fetcherFor(archive) })).rejects.toThrow('ID');
    expect(await readdir(dir)).toEqual([]);
  });

  it('rejects a version mismatch', async () => {
    const dir = await createPluginDir();
    const archive = await readFixture('valid.zip');
    await expect(installPluginFromStore(itemFor('napcat-plugin-demo', '2.0.0', archive), manager(), () => {}, { pluginDir: dir, fetcher: fetcherFor(archive) })).rejects.toThrow('版本');
    expect(await readdir(dir)).toEqual([]);
  });

  it('rejects a matching manifest name in a differently named directory', async () => {
    const dir = await createPluginDir();
    const archive = await readFixture('valid.zip');
    await mkdir(path.join(dir, 'other'));
    await writeFile(path.join(dir, 'other', 'package.json'), JSON.stringify({ name: 'napcat-plugin-demo' }));
    const local = manager();
    await expect(installPluginFromStore(itemFor('napcat-plugin-demo', '1.0.0', archive), local, () => {}, { pluginDir: dir, fetcher: fetcherFor(archive) })).rejects.toThrow('ID');
    expect(local.calls).toEqual([]);
    expect(await readdir(dir)).toEqual(['other']);
  });

  it('rejects a symlink plugin root', async () => {
    const dir = await createPluginDir();
    const real = path.join(dir, 'real');
    const link = path.join(dir, 'link');
    await mkdir(real);
    await symlink(real, link);
    const archive = await readFixture('valid.zip');
    await expect(installPluginFromStore(itemFor('napcat-plugin-demo', '1.0.0', archive), manager(), () => {}, { pluginDir: link, fetcher: fetcherFor(archive) })).rejects.toThrow('路径');
  });

  it('installs a verified package and reports whether it was loaded', async () => {
    const dir = await createPluginDir();
    const archive = await readFixture('valid.zip');
    const local = manager(true);
    const result = await installPluginFromStore(itemFor('napcat-plugin-demo', '1.0.0', archive), local, () => {}, {
      pluginDir: dir,
      fetcher: fetcherFor(archive),
    });
    expect(result).toEqual({ pluginId: 'napcat-plugin-demo', version: '1.0.0', loaded: false, status: 'registered' });
    expect(await readFile(path.join(dir, 'napcat-plugin-demo', 'package.json'), 'utf8')).toContain('napcat-plugin-demo');
    expect(local.calls).toEqual(['prepare:napcat-plugin-demo', 'register:napcat-plugin-demo']);
    // Staging and backup directories must not remain behind.
    expect(await readdir(dir)).toEqual(['napcat-plugin-demo']);
  });

  it('distinguishes failed registration and restart-required after committing the directory', async () => {
    const archive = await readFixture('valid.zip');
    for (const mode of ['failed', 'throws', 'restart'] as const) {
      const dir = await createPluginDir();
      const local = manager();
      const register = mode === 'restart' ? undefined : () => { if (mode === 'throws') throw new Error('failed'); return false; };
      const result = await installPluginFromStore(itemFor('napcat-plugin-demo', '1.0.0', archive), { ...local, registerInstalledDirectory: register }, () => {}, { pluginDir: dir, fetcher: fetcherFor(archive) });
      expect(result.status).toBe(mode === 'restart' ? 'restart_required' : 'registration_failed');
      expect(await readdir(dir)).toEqual(['napcat-plugin-demo']);
    }
  });

  it('refuses installation without durable disable support or when preparation fails', async () => {
    const archive = await readFixture('valid.zip');
    for (const prepare of [undefined, () => { throw new Error('disk error'); }]) {
      const dir = await createPluginDir();
      await expect(installPluginFromStore(itemFor('napcat-plugin-demo', '1.0.0', archive), { ...manager(), preparePluginInstall: prepare }, () => {}, { pluginDir: dir, fetcher: fetcherFor(archive) })).rejects.toThrow();
      expect(await readdir(dir)).toEqual([]);
    }
  });

  it('persists disabled state and registers metadata without executing code or replacing entries', async () => {
    const dir = await createPluginDir();
    const configPath = path.join(dir, 'plugins.json');
    const pluginDir = path.join(dir, 'plugins');
    const id = 'napcat-plugin-cleaner';
    await mkdir(path.join(pluginDir, id), { recursive: true });
    await writeFile(configPath, JSON.stringify({ [id]: true }));
    await writeFile(path.join(pluginDir, id, 'package.json'), JSON.stringify({ name: id, main: 'index.js' }));
    await writeFile(path.join(pluginDir, id, 'index.js'), `throw new Error('must not execute');`);
    const logger = { logWarn: () => {}, logError: () => {}, logDebug: () => {}, log: () => {} };
    const local = Object.create(OB11PluginMangerAdapter.prototype) as OB11PluginMangerAdapter;
    Object.assign(local, { pluginPath: pluginDir, configPath, loader: new PluginLoader(pluginDir, configPath, logger as never), plugins: new Map(), pendingPluginInstalls: new Set() });
    await expect(local.setPluginStatus(id, true)).rejects.toThrow();
    local.preparePluginInstall(id);
    await expect(local.setPluginStatus(id, true)).rejects.toThrow();
    expect(JSON.parse(await readFile(configPath, 'utf8'))[id]).toBe(false);
    expect(local.registerInstalledDirectory(id)).toBe(true);
    const entry = local.getPluginInfo(id);
    expect(entry).toMatchObject({ id, enable: false, loaded: false, runtime: { status: 'unloaded' } });
    expect(local.registerInstalledDirectory(id)).toBe(false);
    expect(local.getPluginInfo(id)).toBe(entry);
    expect(local.registerInstalledDirectory('../escape')).toBe(false);
    await mkdir(path.join(pluginDir, 'other'));
    await writeFile(path.join(pluginDir, 'other', 'package.json'), JSON.stringify({ name: id, main: 'index.js' }));
    await writeFile(path.join(pluginDir, 'other', 'index.js'), '');
    expect(local.registerInstalledDirectory('other')).toBe(false);
  });

  it('installs a package whose archive contains one top-level directory', async () => {
    const dir = await createPluginDir();
    const archive = await readFixture('nested.zip');
    await installPluginFromStore(itemFor('napcat-plugin-demo', '1.0.0', archive), manager(), () => {}, {
      pluginDir: dir,
      fetcher: fetcherFor(archive),
    });
    expect((await stat(path.join(dir, 'napcat-plugin-demo', 'index.mjs'))).isFile()).toBe(true);
  });

  it('rejects a digest mismatch and leaves the plugin directory untouched', async () => {
    const dir = await createPluginDir();
    const archive = await readFixture('valid.zip');
    const item = itemFor('napcat-plugin-demo', '1.0.0', archive);
    item.sha256 = '0'.repeat(64);
    await expect(installPluginFromStore(item, manager(), () => {}, { pluginDir: dir, fetcher: fetcherFor(archive) })).rejects.toThrow(PluginInstallError);
    expect(await readdir(dir)).toEqual([]);
  });

  it('rejects a declared size that differs from the download', async () => {
    const dir = await createPluginDir();
    const archive = await readFixture('valid.zip');
    const item = itemFor('napcat-plugin-demo', '1.0.0', archive);
    item.size = archive.byteLength + 1;
    await expect(installPluginFromStore(item, manager(), () => {}, { pluginDir: dir, fetcher: fetcherFor(archive) })).rejects.toThrow('大小');
    expect(await readdir(dir)).toEqual([]);
  });

  it('rejects path traversal entries', async () => {
    const dir = await createPluginDir();
    const archive = await readFixture('traversal.zip');
    await expect(installPluginFromStore(itemFor('napcat-plugin-demo', '1.0.0', archive), manager(), () => {}, { pluginDir: dir, fetcher: fetcherFor(archive) })).rejects.toThrow(PluginInstallError);
    expect(await readdir(dir)).toEqual([]);
  });

  it('rejects symbolic links in the archive', async () => {
    const dir = await createPluginDir();
    const archive = await readFixture('symlink.zip');
    await expect(installPluginFromStore(itemFor('napcat-plugin-demo', '1.0.0', archive), manager(), () => {}, { pluginDir: dir, fetcher: fetcherFor(archive) })).rejects.toThrow(PluginInstallError);
    expect(await readdir(dir)).toEqual([]);
  });

  it('rejects a manifest whose plugin ID differs from the catalog entry', async () => {
    const dir = await createPluginDir();
    const archive = await readFixture('mismatch.zip');
    await expect(installPluginFromStore(itemFor('napcat-plugin-demo', '1.0.0', archive), manager(), () => {}, { pluginDir: dir, fetcher: fetcherFor(archive) })).rejects.toThrow('ID');
    expect(await readdir(dir)).toEqual([]);
  });

  it('preserves the previous directory when an upgrade is rejected', async () => {
    const dir = await createPluginDir();
    const archive = await readFixture('valid.zip');
    await installPluginFromStore(itemFor('napcat-plugin-demo', '1.0.0', archive), manager(false), () => {}, {
      pluginDir: dir,
      fetcher: fetcherFor(archive),
    });
    const broken = await readFixture('mismatch.zip');
    await expect(installPluginFromStore(itemFor('napcat-plugin-demo', '2.0.0', broken), manager(), () => {}, { pluginDir: dir, fetcher: fetcherFor(broken) })).rejects.toThrow(PluginInstallError);
    const manifest = JSON.parse(await readFile(path.join(dir, 'napcat-plugin-demo', 'package.json'), 'utf8')) as { version: string };
    expect(manifest.version).toBe('1.0.0');
    expect((await readdir(dir)).sort()).toEqual(['napcat-plugin-demo']);
  });
});
