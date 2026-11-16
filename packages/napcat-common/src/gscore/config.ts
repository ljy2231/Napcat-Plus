import fs from 'node:fs';
import path from 'node:path';

export interface GScoreConfig {
  enabled: boolean;
  url: string;
  token: string;
  reconnectIntervalMs: number;
  maxReconnectAttempts: number;
}

export const defaultGScoreConfig: GScoreConfig = {
  enabled: false,
  url: 'ws://gsuid_core:8765',
  token: '',
  reconnectIntervalMs: 5000,
  maxReconnectAttempts: 10,
};

export function validateGScoreConfig (value: unknown, previous = defaultGScoreConfig): GScoreConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GSCore 配置必须为对象');
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!['enabled', 'url', 'token', 'reconnectIntervalMs', 'maxReconnectAttempts'].includes(key)) throw new Error('GSCore 配置包含未知字段');
  }
  const next = { ...previous, ...input };
  if (typeof next.enabled !== 'boolean') throw new Error('enabled 必须为布尔值');
  if (typeof next.url !== 'string' || next.url.length > 2048) throw new Error('连接地址无效');
  let url: URL;
  try { url = new URL(next.url); } catch { throw new Error('请输入有效的 ws:// 或 wss:// 地址'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('仅支持无账号、查询参数和片段的 WebSocket 地址；Token 请使用独立输入框');
  }
  if (typeof next.token !== 'string' || next.token.length > 4096 || /[\r\n]/.test(next.token)) throw new Error('Token 格式无效');
  if (!Number.isInteger(next.reconnectIntervalMs) || next.reconnectIntervalMs < 1000 || next.reconnectIntervalMs > 300000) throw new Error('重连间隔需为 1000–300000 毫秒');
  if (!Number.isInteger(next.maxReconnectAttempts) || next.maxReconnectAttempts < 1 || next.maxReconnectAttempts > 100) throw new Error('重连上限需为 1–100 次');
  return { ...next, url: url.toString().replace(/\/$/, '') };
}

export function publicGScoreConfig (config: GScoreConfig) {
  const { token, ...safe } = config;
  return { ...safe, tokenConfigured: !!token };
}

export class GScoreConfigStore {
  private readonly file: string;
  constructor (directory: string) { this.file = path.join(directory, 'console-gscore.json'); }

  load (): GScoreConfig {
    if (!fs.existsSync(this.file)) return { ...defaultGScoreConfig };
    return validateGScoreConfig(JSON.parse(fs.readFileSync(this.file, 'utf8')));
  }

  save (value: GScoreConfig): void {
    const config = validateGScoreConfig(value);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    fs.chmodSync(this.file, 0o600);
  }
}
