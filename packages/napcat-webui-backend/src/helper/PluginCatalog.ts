import type { PluginStoreItem, PluginStoreList } from '../types/PluginStore';

export const PLUGIN_CATALOG_SOURCE = 'https://raw.githubusercontent.com/ljy2231/napcat-plus-plugin-index/main/index.json';
export const PLUGIN_CATALOG_TIMEOUT_MS = 4000;
export const PLUGIN_CATALOG_MAX_BYTES = 256 * 1024;
export const PLUGIN_CATALOG_REFRESH_COOLDOWN_MS = 60000;
export const PLUGIN_CATALOG_FRESH_MS = 10 * 60000;
const MAX_REMOTE_ITEMS = 200;
const CATALOG_DATE = '2026-11-16T00:00:00.000Z';
const PROJECT_SOURCE = 'https://github.com/ljy2231/Napcat-Plus';

const BUNDLED_ITEMS: readonly PluginStoreItem[] = [
  {
    id: 'console-gscore',
    name: 'GSCore 内置连接管理',
    version: '0.1.0',
    description: 'Napcat-Plus 的独立内置 GSCore 桥接；不是旧的第三方 GSCore 适配插件。',
    author: 'Napcat-Plus',
    homepage: PROJECT_SOURCE,
    downloadUrl: '',
    tags: ['内置', '连接'],
    availability: 'builtin',
    availabilityReason: '已随本项目构建，无需安装。启用前先停用旧 GSCore 桥接，避免重复收发；协议功能可能不同。',
    builtinPath: '/gscore',
    sourceName: 'Napcat-Plus 随包目录',
    sourceUrl: PROJECT_SOURCE,
  },
  {
    id: 'console-cleaner',
    name: '内置缓存清理工具',
    version: '0.1.0',
    description: '预览并确认清理 NapCat 日志和临时缓存，不处理 QQ 账号数据库。',
    author: 'Napcat-Plus',
    homepage: PROJECT_SOURCE,
    downloadUrl: '',
    tags: ['内置', '维护'],
    availability: 'builtin',
    availabilityReason: '已随本项目构建；无默认定时清理，不等同于原 Cleaner 插件的所有功能。',
    builtinPath: '/tools',
    sourceName: 'Napcat-Plus 随包目录',
    sourceUrl: PROJECT_SOURCE,
  },
  {
    id: 'console-debug',
    name: '内置插件诊断工具',
    version: '0.1.0',
    description: '在管理鉴权下查看插件状态、开关与手动热重载，不开放额外调试 WebSocket 端口。',
    author: 'Napcat-Plus',
    homepage: PROJECT_SOURCE,
    downloadUrl: '',
    tags: ['内置', '调试'],
    availability: 'builtin',
    availabilityReason: '已随本项目构建；与旧 Debug 插件不是同一个可安装包。',
    builtinPath: '/tools',
    sourceName: 'Napcat-Plus 随包目录',
    sourceUrl: PROJECT_SOURCE,
  },
];

export function isValidPluginCatalogId (value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value) && value !== '.' && value !== '..';
}

function record (value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid catalog object');
  return value as Record<string, unknown>;
}

function text (value: unknown, limit: number, optional = false): string {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > limit || Array.from(value).some(char => {
    const code = char.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  })) throw new Error('Invalid catalog text');
  // Text is data, never HTML. Restrict metacharacters so legacy markdown/HTML UI
  // cannot accidentally execute a remote description if the renderer changes.
  return value.trim().replace(/[<>]/g, '');
}

export const MAX_PLUGIN_PACKAGE_BYTES = 64 * 1024 * 1024;

// Audited out of band and pinned in the application, independently of the
// mutable cloud index. Updating the index alone cannot authorize executable code.
const APPROVED_RELEASES: ReadonlyArray<{ id: string; version: string; url: string; sha256: string; size: number }> = [{
  id: 'napcat-plugin-ssqq',
  version: '3.5.2-3',
  url: 'https://github.com/Stapxs/Stapxs-QQ-Lite-2.0/releases/download/v3.5.2/napcat-plugin-ssqq.zip',
  sha256: '82b9ef50f7e4ddb92a07149d763f7ce98502d24ac73ce8039499b24b25df1c04',
  size: 6118730,
}];

/** Only an exact GitHub release asset URL; a separate approval list authorizes installs. */
function githubReleaseAsset (value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid download URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid download URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || /%2f|%5c|%2e/i.test(url.pathname)) throw new Error('Disallowed download URL');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 6 || parts[2] !== 'releases' || parts[3] !== 'download') throw new Error('Download URL must be a GitHub release asset');
  if (!parts.every(part => /^[a-zA-Z0-9._@+~-]+$/.test(part))) throw new Error('Invalid download URL');
  return url.toString();
}

/** Only explicit public HTTPS GitHub project/release links, never a fetch target. */
function githubLink (value: unknown, optional = false): string {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid catalog URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid catalog URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || /%2f|%5c|%2e/i.test(url.pathname)) throw new Error('Disallowed catalog URL');
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2 || !segments.every(segment => /^[a-zA-Z0-9._@+~-]+$/.test(segment))) throw new Error('Invalid GitHub project URL');
  return url.toString();
}

/** Treat all external index entries as unverified browse-only data. */
export function validatePluginCatalog (value: unknown): PluginStoreList {
  const data = record(value);
  if (!Array.isArray(data['plugins']) || data['plugins'].length > MAX_REMOTE_ITEMS) throw new Error('Invalid plugin count');
  const version = text(data['version'], 80);
  const rawDate = text(data['updateTime'], 80);
  if (!Number.isFinite(Date.parse(rawDate))) throw new Error('Invalid update date');
  const ids = new Set<string>();
  const plugins = data['plugins'].map((entry): PluginStoreItem => {
    const item = record(entry);
    const id = item['id'];
    if (!isValidPluginCatalogId(id) || ids.has(id)) throw new Error('Invalid or duplicate plugin ID');
    ids.add(id);
    const homepage = githubLink(item['homepage'], true);
    // A cloud index is mutable. Installation is permitted only when every
    // release field exactly matches the independently reviewed local allowlist.
    const rawDownload = item['downloadUrl'];
    const hasDownload = rawDownload !== undefined && rawDownload !== null && rawDownload !== '';
    const downloadUrl = hasDownload ? githubReleaseAsset(rawDownload) : '';
    const tags = item['tags'];
    if (tags !== undefined && (!Array.isArray(tags) || tags.length > 12)) throw new Error('Invalid tags');
    const rawSha256 = item['sha256'];
    if (rawSha256 !== undefined && (typeof rawSha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(rawSha256))) throw new Error('Invalid SHA256');
    const sha256 = typeof rawSha256 === 'string' ? rawSha256.toLowerCase() : '';
    const rawSize = item['size'];
    if (rawSize !== undefined && (typeof rawSize !== 'number' || !Number.isSafeInteger(rawSize) || rawSize <= 0 || rawSize > MAX_PLUGIN_PACKAGE_BYTES)) throw new Error('Invalid package size');
    const size = typeof rawSize === 'number' ? rawSize : 0;
    const version = text(item['version'], 80, true);
    const installable = APPROVED_RELEASES.some(approved => approved.id === id && approved.version === version && approved.url === downloadUrl && approved.sha256 === sha256 && approved.size === size);
    return {
      id,
      name: text(item['name'], 120),
      version,
      description: text(item['description'], 2000, true),
      author: text(item['author'], 160, true),
      ...(homepage ? { homepage } : {}),
      downloadUrl: installable ? downloadUrl : '',
      ...(installable ? { sha256, size } : {}),
      tags: Array.isArray(tags) ? tags.map(tag => text(tag, 40)) : [],
      ...(item['minVersion'] === undefined ? {} : { minVersion: text(item['minVersion'], 80) }),
      availability: installable ? 'installable' : 'unavailable',
      availabilityReason: installable
        ? '此版本与本程序批准的发布包信息一致；安装前会校验摘要，但这不构成安全审计或第三方许可确认。'
        : '该版本未获本程序固定发布包清单批准，仅供浏览。',
      sourceName: 'Napcat-Plus 云端索引（安装前校验固定摘要）',
      sourceUrl: PLUGIN_CATALOG_SOURCE,
    };
  });
  return { version, updateTime: new Date(rawDate).toISOString(), plugins };
}

async function readBoundedJson (response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok) throw new Error('Catalog unavailable');
  if (response.redirected || (response.url && response.url !== PLUGIN_CATALOG_SOURCE)) throw new Error('Unexpected redirect');
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > PLUGIN_CATALOG_MAX_BYTES)) throw new Error('Catalog too large');
  const type = response.headers.get('content-type') || '';
  if (!/^(application\/(?:json|octet-stream)|text\/plain)(?:;|$)/i.test(type)) throw new Error('Unexpected content type');
  if (!response.body) throw new Error('Empty catalog body');
  const reader = response.body.getReader();
  const cancelBody = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelBody, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('Catalog timeout');
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > PLUGIN_CATALOG_MAX_BYTES) throw new Error('Catalog too large');
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    signal.removeEventListener('abort', cancelBody);
    cancelBody();
  }
}

export interface PluginCatalogOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Stale-while-revalidate in-memory LKG. Every HTTP list call returns synchronously
 * from trusted bundled entries/cache; one bounded official request runs in the
 * background. forceRefresh cannot bypass the cooldown or start a second fetch.
 */
export class PluginCatalog {
  private lastGood: PluginStoreList | undefined;
  private lastSuccess: number | undefined;
  private checked: number | undefined;
  private lastAttempt: number | undefined;
  private lastResultOk = false;
  private inFlight: Promise<void> | undefined;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor (options: PluginCatalogOptions = {}) {
    this.fetcher = options.fetcher ?? ((...args) => fetch(...args));
    this.now = options.now ?? Date.now;
    this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? PLUGIN_CATALOG_TIMEOUT_MS, 1), PLUGIN_CATALOG_TIMEOUT_MS);
  }

  snapshot (forceRefresh = false): PluginStoreList {
    const now = this.now();
    const stale = this.lastSuccess === undefined || now - this.lastSuccess >= PLUGIN_CATALOG_FRESH_MS;
    const canCheck = this.lastAttempt === undefined || now - this.lastAttempt >= PLUGIN_CATALOG_REFRESH_COOLDOWN_MS;
    if ((forceRefresh || stale) && canCheck && !this.inFlight) this.startRefresh();
    const status = this.lastGood ? (!stale && this.lastResultOk ? 'online' : 'cached') : 'bundled';
    const message = status === 'online'
      ? '云端索引最近可达；仅本程序批准的固定版本可以安装，其余仅供浏览。'
      : status === 'cached'
        ? '云端索引暂不可用或目录已过期；显示最近验证过结构的缓存，仅供浏览，不允许安装。'
        : this.checked === undefined
          ? '显示随 Napcat-Plus 提供的内置工具目录；正在后台检查云端索引，不影响浏览。'
          : '云端索引暂不可用；已切换到随包目录，可打开内置工具或官方外部页面。';
    const bundledIds = new Set(BUNDLED_ITEMS.map(item => item.id));
    const remote = (this.lastGood?.plugins.filter(item => !bundledIds.has(item.id)) ?? []).map(item => status === 'online' ? item : {
      ...item,
      availability: 'unavailable' as const,
      availabilityReason: '云端索引不可用或已过期，缓存仅供浏览，不能安装。',
    });
    return {
      version: this.lastGood?.version ?? 'napcat-plus-bundled-v1',
      updateTime: this.lastGood?.updateTime ?? CATALOG_DATE,
      plugins: [...BUNDLED_ITEMS, ...remote].map(item => ({ ...item, tags: item.tags ? [...item.tags] : [] })),
      sourceStatus: status,
      sourceMessage: message,
      sourceUrl: PLUGIN_CATALOG_SOURCE,
      checkedAt: this.checked === undefined ? null : new Date(this.checked).toISOString(),
      lastSuccessAt: this.lastSuccess === undefined ? null : new Date(this.lastSuccess).toISOString(),
      refreshing: !!this.inFlight,
      remoteInstallEnabled: true,
    };
  }

  /** Test/maintenance hook; request handlers must not await this. */
  async whenIdle (): Promise<void> { await this.inFlight; }

  private startRefresh (): void {
    this.lastAttempt = this.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Catalog timeout')); }, this.timeoutMs);
      timer.unref?.();
    });
    // The timeout covers headers, body reads, parsing and validation; external
    // responses/errors are not logged or returned to clients.
    const request = Promise.resolve().then(async () => {
      const response = await this.fetcher(PLUGIN_CATALOG_SOURCE, {
        headers: { 'User-Agent': 'Napcat-Plus-Catalog', Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      });
      return validatePluginCatalog(await readBoundedJson(response, controller.signal));
    });
    this.inFlight = Promise.race([request, timeout]).then((list) => {
      this.lastGood = list;
      this.lastSuccess = this.now();
      this.lastResultOk = true;
    }).catch(() => { this.lastResultOk = false; }).finally(() => {
      clearTimeout(timer!);
      controller.abort();
      this.checked = this.now();
      this.inFlight = undefined;
    });
  }
}

export const pluginCatalog = new PluginCatalog();
