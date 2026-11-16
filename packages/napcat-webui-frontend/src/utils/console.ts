import type { ConsoleLogin, GSCoreConfig, GSCoreUpdate } from '../types/console';

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral';

export function loginPresentation (login?: ConsoleLogin): { label: string; detail: string; tone: StatusTone; } {
  if (!login) return { label: '等待状态', detail: '正在读取 QQ 登录状态', tone: 'neutral' };
  if (login.isLogin && login.coreReady) return { label: '在线就绪', detail: 'QQ 已登录，核心服务已就绪', tone: 'success' };
  if (login.loginError) return { label: '需要处理', detail: login.loginError, tone: 'danger' };
  if (login.isOffline || login.loginPhase === 'offline') return { label: '已离线', detail: '请检查登录状态并重新连接', tone: 'warning' };
  const phases: Record<string, [string, string]> = {
    waiting_qrcode: ['等待扫码', '打开 QQ 登录页面完成登录'],
    generating_qrcode: ['生成二维码', 'QQ 登录服务正在准备二维码'],
    qrcode_scanned: ['等待确认', '请在手机 QQ 上确认本次登录'],
    initializing: ['初始化中', '已收到登录确认，正在启动核心服务'],
    reconnecting: ['正在恢复', '登录服务正在重新连接，请稍候'],
    ready: ['检查就绪状态', '正在等待核心服务确认'],
  };
  const [label, detail] = phases[login.loginPhase] ?? ['等待登录', '请在登录页查看当前状态'];
  return { label, detail, tone: 'warning' };
}

export function gscorePresentation (state?: string): { label: string; tone: StatusTone; } {
  switch (state) {
    case 'connected': return { label: '已连接', tone: 'success' };
    case 'connecting': return { label: '连接中', tone: 'warning' };
    case 'retrying': return { label: '重试中', tone: 'warning' };
    case 'error': return { label: '连接异常', tone: 'danger' };
    case 'disabled': return { label: '未启用', tone: 'neutral' };
    default: return { label: '等待状态', tone: 'neutral' };
  }
}

export function formatUptime (seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const value = Math.floor(seconds);
  const days = Math.floor(value / 86400);
  const hours = Math.floor(value / 3600) % 24;
  const minutes = Math.floor(value / 60) % 60;
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分 ${value % 60} 秒`;
}

export function validateGSCoreConfig (config: Pick<GSCoreConfig, 'url' | 'reconnectIntervalMs' | 'maxReconnectAttempts'>): string | undefined {
  try {
    const url = new URL(config.url.trim());
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname) return '连接地址必须以 ws:// 或 wss:// 开头。';
    if (url.username || url.password || url.search || url.hash) return '地址中不能包含账号、密码、查询参数或片段；请使用独立 Token 输入框。';
  } catch {
    return '请输入有效的 WebSocket 地址，例如 ws://gsuid_core:8765。';
  }
  if (!Number.isInteger(config.reconnectIntervalMs) || config.reconnectIntervalMs < 1000 || config.reconnectIntervalMs > 300000) {
    return '重连间隔必须为 1,000–300,000 毫秒之间的整数。';
  }
  if (!Number.isInteger(config.maxReconnectAttempts) || config.maxReconnectAttempts < 1 || config.maxReconnectAttempts > 100) {
    return '最大重试次数必须为 1–100 之间的整数。';
  }
}

export function buildGSCoreUpdate (config: GSCoreConfig, token: string, clearToken: boolean): GSCoreUpdate {
  const result: GSCoreUpdate = {
    enabled: config.enabled,
    url: config.url.trim(),
    reconnectIntervalMs: config.reconnectIntervalMs,
    maxReconnectAttempts: config.maxReconnectAttempts,
  };
  if (clearToken) result.token = '';
  else if (token) result.token = token;
  return result;
}
