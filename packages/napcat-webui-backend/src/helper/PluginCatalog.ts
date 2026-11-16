import type { PluginStoreItem, PluginStoreList } from '../types/PluginStore';

export const PLUGIN_CATALOG_SOURCE = 'https://raw.githubusercontent.com/NapNeko/napcat-plugin-index/main/plugins.v4.json';
export const REMOTE_INSTALL_DISABLED_MESSAGE = '在线安装暂已停用：上游索引及安装包完整性未完成核验，旧安装器也尚未完成安全审查。内置工具可直接打开；第三方插件请查看官方页面并自行核对许可与来源后手动安装。';
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
  {
    id: 'napcat-plugin-ssqq',
    name: 'Stapxs QQ Lite（SSQQ）',
    version: '',
    description: '第三方 QQ Web 客户端；仅提供作者官方项目入口，不捆绑客户端或声称可一键安装。',
    author: 'Stapxs',
    homepage: 'https://github.com/Stapxs/Stapxs-QQ-Lite-2.0',
    downloadUrl: '',
    tags: ['外部', '聊天'],
    availability: 'external',
    availabilityReason: '需自行检查官方版本、客户端及资源许可证；本项目未验证最新包，不提供在线安装。',
    sourceName: 'Stapxs 官方项目（仅外部入口）',
    sourceUrl: 'https://github.com/Stapxs/Stapxs-QQ-Lite-2.0',
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
    // Download URLs are checked for structure, then intentionally discarded.
    // A remote advertised SHA256 is not an independent trust anchor.
    githubLink(item['downloadUrl'], true);
    const tags = item['tags'];
    if (tags !== undefined && (!Array.isArray(tags) || tags.length > 12)) throw new Error('Invalid tags');
    const sha256 = item['sha256'];
    if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(sha256))) throw new Error('Invalid SHA256');
    return {
      id,
      name: text(item['name'], 120),
      version: text(item['version'], 80, true),
      description: text(item['description'], 2000, true),
      author: text(item['author'], 160, true),
      ...(homepage ? { homepage } : {}),
      downloadUrl: '',
      tags: Array.isArray(tags) ? tags.map(tag => text(tag, 40)) : [],
      ...(item['minVersion'] === undefined ? {} : { minVersion: text(item['minVersion'], 80) }),
      availability: 'unavailable',
      availabilityReason: '来自上游索引的目录信息；插件来源、版本和包摘要未独立核验，仅供浏览，在线安装已停用。',
      sourceName: 'NapNeko 官方索引（第三方条目未独立核验）',
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
      ? '官方索引最近可达；第三方条目仍未独立核验。在线安装暂已停用。'
      : status === 'cached'
        ? '上游暂不可用或目录已过期；显示最近验证过结构的缓存，仅供浏览，不允许安装。'
        : this.checked === undefined
          ? '显示随 Napcat-Plus 提供的保守目录；正在后台检查官方索引，不影响浏览。在线安装暂已停用。'
          : '官方插件索引暂不可用；已切换到随包目录，可打开内置工具或官方外部页面。在线安装暂已停用。';
    const bundledIds = new Set(BUNDLED_ITEMS.map(item => item.id));
    const remote = this.lastGood?.plugins.filter(item => !bundledIds.has(item.id)) ?? [];
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
      remoteInstallEnabled: false,
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
