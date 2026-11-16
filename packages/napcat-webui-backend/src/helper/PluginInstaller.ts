import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import type { PluginStoreItem } from '../types/PluginStore';
import { MAX_PLUGIN_PACKAGE_BYTES } from './PluginCatalog';

const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);

export class PluginInstallError extends Error {}

export interface PluginInstallResult {
  pluginId: string;
  version: string;
  loaded: boolean;
  status: 'registered' | 'registration_failed' | 'restart_required';
}

export interface InstallOptions {
  pluginDir?: string;
  fetcher?: typeof fetch;
}

export type InstallProgress = (progress: number, message: string) => void;

export interface PluginManagerLike {
  getPluginInfo: (id: string) => { loaded?: boolean } | undefined;
  preparePluginInstall?: (id: string) => void;
  finishPluginInstall?: (id: string) => void;
  registerInstalledDirectory?: (dirname: string) => boolean;
}

interface Manifest {
  name?: unknown;
  version?: unknown;
  main?: unknown;
}

const inFlight = new Map<string, Promise<PluginInstallResult>>();

async function pathExists (target: string): Promise<boolean> {
  try { await fsp.access(target); return true; } catch { return false; }
}

function assertDownloadUrl (url: URL): void {
  if (url.protocol !== 'https:' || url.port || url.username || url.password) throw new PluginInstallError('下载地址必须是公开 HTTPS 地址');
  if (!ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) throw new PluginInstallError('下载地址不在允许的 GitHub 发布域名内');
}

async function downloadPackage (url: string, sha256: string, size: number, destination: string, fetcher: typeof fetch): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertDownloadUrl(current);
      const response = await fetcher(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'Napcat-Plus-Installer', Accept: 'application/zip, application/octet-stream' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new PluginInstallError('下载重定向缺少目标地址');
        current = new URL(location, current);
        continue;
      }
      if (!response.ok || !response.body) throw new PluginInstallError(`下载失败（HTTP ${response.status}）`);
      const declared = response.headers.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) !== size)) throw new PluginInstallError('安装包大小与目录记录不一致');
      const hash = createHash('sha256');
      let received = 0;
      const meter = new Transform({
        transform (chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > size || received > MAX_PLUGIN_PACKAGE_BYTES) { callback(new PluginInstallError('安装包超过声明大小')); return; }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(response.body as unknown as NodeJS.ReadableStream, meter, createWriteStream(destination, { mode: 0o600 }));
      if (received !== size) throw new PluginInstallError('安装包大小与目录记录不一致');
      if (hash.digest('hex') !== sha256) throw new PluginInstallError('安装包 SHA-256 校验失败');
      return;
    }
    throw new PluginInstallError('下载重定向次数过多');
  } finally {
    clearTimeout(timer);
  }
}

function safeEntryPath (fileName: string): string {
  const normalized = fileName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.includes('\0')) throw new PluginInstallError('安装包包含非法路径');
  const parts = normalized.split('/').filter(part => part.length > 0);
  if (!parts.length || parts.some(part => part === '..' || part === '.')) throw new PluginInstallError('安装包包含路径穿越');
  return parts.join('/');
}

function openZip (zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (error, zipfile) => {
      if (error || !zipfile) reject(new PluginInstallError('安装包不是有效的 ZIP 文件')); else resolve(zipfile);
    });
  });
}

function openEntryStream (zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(new PluginInstallError('无法读取安装包内容')); else resolve(stream);
    });
  });
}

async function extractZip (zipPath: string, destination: string): Promise<void> {
  await fsp.mkdir(destination, { recursive: true });
  const zipfile = await openZip(zipPath);
  const seen = new Set<string>();
  let entries = 0;
  let extracted = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch { /* already closed */ }
        reject(error instanceof PluginInstallError ? error : new PluginInstallError('安装包解压被拒绝'));
      };
      zipfile.on('error', fail);
      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch { /* already closed */ }
        resolve();
      });
      zipfile.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          entries += 1;
          if (entries > MAX_FILES) throw new PluginInstallError('安装包条目数量超过限制');
          const relative = safeEntryPath(entry.fileName);
          if (seen.has(relative)) throw new PluginInstallError('安装包包含重复路径');
          seen.add(relative);
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          // 0o120000 is a symbolic link; reject links and device/socket nodes.
          if (mode === 0o120000) throw new PluginInstallError('安装包包含符号链接，已拒绝');
          if (mode !== 0 && mode !== 0o100000 && mode !== 0o040000) throw new PluginInstallError('安装包包含不支持的文件类型');
          const target = path.join(destination, relative);
          const resolved = path.resolve(target);
          if (resolved !== target || !resolved.startsWith(path.resolve(destination) + path.sep)) throw new PluginInstallError('安装包路径越界');
          const isDirectory = mode === 0o040000 || entry.fileName.endsWith('/');
          if (isDirectory) {
            await fsp.mkdir(target, { recursive: true });
            zipfile.readEntry();
            return;
          }
          if (entry.uncompressedSize > MAX_EXTRACTED_BYTES) throw new PluginInstallError('安装包单个文件过大');
          if (entry.compressedSize === 0 && entry.uncompressedSize > 0) throw new PluginInstallError('安装包压缩信息异常');
          await fsp.mkdir(path.dirname(target), { recursive: true });
          const stream = await openEntryStream(zipfile, entry);
          let current = 0;
          const meter = new Transform({
            transform (chunk: Buffer, _encoding, callback) {
              current += chunk.length;
              extracted += chunk.length;
              if (current > entry.uncompressedSize || extracted > MAX_EXTRACTED_BYTES) { callback(new PluginInstallError('解压内容超过限制')); return; }
              callback(null, chunk);
            },
          });
          await pipeline(stream, meter, createWriteStream(target, { mode: 0o600, flags: 'wx' }));
          if (current !== entry.uncompressedSize) throw new PluginInstallError('安装包内容不完整');
          zipfile.readEntry();
        })().catch(fail);
      });
      zipfile.readEntry();
    });
  } finally {
    try { zipfile.close(); } catch { /* already closed */ }
  }
}

async function resolvePluginRoot (extractDir: string): Promise<string> {
  if (await pathExists(path.join(extractDir, 'package.json'))) return extractDir;
  const entries = await fsp.readdir(extractDir, { withFileTypes: true });
  const directories = entries.filter(entry => entry.isDirectory());
  if (entries.length === 1 && directories.length === 1) {
    const nested = path.join(extractDir, directories[0]!.name);
    if (await pathExists(path.join(nested, 'package.json'))) return nested;
  }
  throw new PluginInstallError('安装包结构无效：找不到插件根目录的 package.json');
}

async function assertNoSymlinkPath (target: string): Promise<void> {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await fsp.lstat(current);
    if (info.isSymbolicLink()) throw new PluginInstallError('路径包含符号链接，已拒绝');
  }
}

async function validateManifest (root: string, expectedId: string, expectedVersion: string): Promise<void> {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8')) as Manifest;
  } catch {
    throw new PluginInstallError('无法读取插件 package.json');
  }
  if (manifest.name !== expectedId) throw new PluginInstallError('安装包插件 ID 与目录记录不一致');
  if (typeof manifest.version !== 'string' || manifest.version !== expectedVersion) throw new PluginInstallError('安装包版本与目录记录不一致');
  if (typeof manifest.main !== 'string' || !manifest.main.trim()) throw new PluginInstallError('安装包缺少入口文件');
  const entry = path.resolve(root, manifest.main);
  if (entry !== root && !entry.startsWith(path.resolve(root) + path.sep)) throw new PluginInstallError('插件入口路径越界');
  try {
    await assertNoSymlinkPath(entry);
    if (!(await fsp.stat(entry)).isFile()) throw new PluginInstallError('插件入口必须是文件');
  } catch (error) {
    if (error instanceof PluginInstallError) throw error;
    throw new PluginInstallError('插件入口文件不存在');
  }
}

async function ensurePluginDirectory (target: string): Promise<void> {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fsp.mkdir(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await fsp.lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new PluginInstallError('插件目录路径不安全');
  }
}

async function assertNotInstalled (pluginsDir: string, id: string, manager: PluginManagerLike): Promise<void> {
  if (manager.getPluginInfo(id)) throw new PluginInstallError('插件已存在，不能重复安装');
  for (const entry of await fsp.readdir(pluginsDir, { withFileTypes: true })) {
    const dir = path.join(pluginsDir, entry.name);
    if (entry.name === id) throw new PluginInstallError('插件目标目录已存在');
    if (entry.isSymbolicLink()) throw new PluginInstallError('插件目录包含符号链接');
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(dir, 'package.json');
    let data: string;
    try {
      const info = await fsp.lstat(manifestPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new PluginInstallError('已有插件 manifest 不安全');
      data = await fsp.readFile(manifestPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let manifest: Manifest;
    try { manifest = JSON.parse(data) as Manifest; } catch { throw new PluginInstallError('无法检查已有插件 manifest'); }
    if (manifest?.name === id) throw new PluginInstallError('插件 ID 已存在，不能重复安装');
  }
}

async function performInstall (item: PluginStoreItem, manager: PluginManagerLike | null, onProgress: InstallProgress, options: InstallOptions): Promise<PluginInstallResult> {
  if (!manager) throw new PluginInstallError('插件管理器不可用');
  if (typeof manager.preparePluginInstall !== 'function' || typeof manager.finishPluginInstall !== 'function') throw new PluginInstallError('插件管理器版本过旧，无法安全安装，请重启后重试');
  if (typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(item.id) || item.id === '.' || item.id === '..') throw new PluginInstallError('插件 ID 不安全');
  if (item.availability !== 'installable' || !item.downloadUrl || !item.sha256 || !item.size) throw new PluginInstallError('该目录条目没有可核验的安装包');
  const pluginsDir = path.resolve(options.pluginDir ?? (await import('@/napcat-webui-backend/index')).webUiPathWrapper.pluginPath);
  await ensurePluginDirectory(pluginsDir);
  await assertNotInstalled(pluginsDir, item.id, manager);
  // Staging must share the plugin mount's filesystem for the final rename.
  // The plugin loader explicitly excludes this reserved prefix.
  const staging = await fsp.mkdtemp(path.join(pluginsDir, '.napcat-install-'));
  const target = path.join(pluginsDir, item.id);
  let reserved = false;
  let prepared = false;
  try {
    const zipPath = path.join(staging, 'package.zip');
    const extractDir = path.join(staging, 'extract');
    onProgress(10, '正在下载安装包…');
    await downloadPackage(item.downloadUrl, item.sha256, item.size, zipPath, options.fetcher ?? fetch);
    onProgress(50, '安装包摘要校验通过');
    await extractZip(zipPath, extractDir);
    onProgress(70, '正在校验插件结构…');
    const root = await resolvePluginRoot(extractDir);
    await validateManifest(root, item.id, item.version);
    await assertNoSymlinkPath(pluginsDir);
    await assertNotInstalled(pluginsDir, item.id, manager);
    onProgress(85, '正在安装插件目录…');
    // 先持久禁用，再提交目录：即使进程在 rename 后崩溃也不会自动运行。
    manager.preparePluginInstall(item.id);
    prepared = true;
    try { await fsp.mkdir(target); reserved = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PluginInstallError('插件目标目录已存在');
      throw error;
    }
    await fsp.rename(root, target);
    reserved = false;
    let status: PluginInstallResult['status'];
    if (typeof manager.registerInstalledDirectory !== 'function') {
      status = 'restart_required';
    } else {
      try {
        status = manager.registerInstalledDirectory(item.id) ? 'registered' : 'registration_failed';
      } catch {
        status = 'registration_failed';
      }
    }
    const message = status === 'registered' ? '安装完成，已登记并默认禁用' : status === 'restart_required' ? '安装完成，需重启后显示' : '插件目录已安装，但登记失败';
    onProgress(100, message);
    return { pluginId: item.id, version: item.version, loaded: false, status };
  } finally {
    if (prepared) manager.finishPluginInstall!(item.id);
    if (reserved) await fsp.rmdir(target).catch(() => {});
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** One install per plugin ID; failures never leave a partially replaced directory. */
export function installPluginFromStore (item: PluginStoreItem, manager: PluginManagerLike | null, onProgress: InstallProgress = () => {}, options: InstallOptions = {}): Promise<PluginInstallResult> {
  if (inFlight.has(item.id)) return Promise.reject(new PluginInstallError('该插件正在安装，请稍候'));
  const task = performInstall(item, manager, onProgress, options).finally(() => { inFlight.delete(item.id); });
  inFlight.set(item.id, task);
  return task;
}
