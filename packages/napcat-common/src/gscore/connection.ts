import { WebSocket, type RawData } from 'ws';
import { type GScoreConfig } from './config';

export type GScoreState = 'disabled' | 'connecting' | 'connected' | 'retrying' | 'error';
export interface GScoreStatus {
  enabled: boolean;
  connected: boolean;
  state: GScoreState;
  url: string;
  reconnectAttempts: number;
  lastError: string;
  tokenConfigured: boolean;
}
export type SocketFactory = (url: string) => WebSocket;

/** One owner per socket generation: late close/error events cannot clear a newer connection. */
export class GScoreConnection {
  private socket: WebSocket | null = null;
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private heartbeatAlive = true;
  private state: GScoreState = 'disabled';
  private attempts = 0;
  private lastError = '';
  private started = false;

  constructor (
    private config: GScoreConfig,
    private readonly botId: string,
    private readonly onMessage: (data: string, isCurrent: () => boolean) => void | Promise<void>,
    private readonly createSocket: SocketFactory = (url) => new WebSocket(url, {
      handshakeTimeout: 10_000,
      maxPayload: 16 * 1024 * 1024,
      perMessageDeflate: false,
      followRedirects: false,
    })
  ) {}

  status (): GScoreStatus {
    return {
      enabled: this.config.enabled,
      connected: this.state === 'connected' && this.socket?.readyState === WebSocket.OPEN,
      state: this.state,
      url: this.config.url,
      reconnectAttempts: this.attempts,
      lastError: this.lastError,
      tokenConfigured: !!this.config.token,
    };
  }

  start (): void {
    if (this.started) return;
    this.started = true;
    if (this.config.enabled) this.connect();
  }

  update (config: GScoreConfig): void {
    const changed = JSON.stringify(this.config) !== JSON.stringify(config);
    this.config = { ...config };
    if (changed) this.reconnect();
  }

  reconnect (): void {
    this.stop();
    this.attempts = 0;
    this.lastError = '';
    this.start();
  }

  stop (): void {
    this.started = false;
    this.generation++;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeat);
    this.retryTimer = undefined;
    this.heartbeat = undefined;
    const previous = this.socket;
    this.socket = null;
    this.state = 'disabled';
    // Keep listeners attached to swallow the expected async error after terminate.
    // Their generation guards make them inert.
    previous?.terminate();
  }

  captureLease (): () => boolean {
    const socket = this.socket;
    const generation = this.generation;
    return () => this.started && generation === this.generation && socket !== null && this.socket === socket && socket.readyState === WebSocket.OPEN && this.state === 'connected';
  }

  send (value: object): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.state !== 'connected') return false;
    if (socket.bufferedAmount > 4 * 1024 * 1024) { this.lastError = 'GSCore 发送队列已满，已丢弃当前消息'; return false; }
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload) > 16 * 1024 * 1024) { this.lastError = 'GSCore 消息超过 16 MiB 限制'; return false; }
    try {
      const generation = this.generation;
      socket.send(Buffer.from(payload), (error) => {
        if (error && generation === this.generation) this.lastError = 'GSCore 消息发送失败';
      });
      return true;
    } catch { this.lastError = 'GSCore 消息发送失败'; return false; }
  }

  private connect (): void {
    if (!this.started || !this.config.enabled || this.socket) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const generation = ++this.generation;
    const url = new URL(this.config.url);
    if (!url.pathname.startsWith('/ws/')) url.pathname = `${url.pathname.replace(/\/$/, '')}/ws/${encodeURIComponent(this.botId)}`;
    if (this.config.token) url.searchParams.set('token', this.config.token);
    this.state = 'connecting';
    let socket: WebSocket;
    try { socket = this.createSocket(url.toString()); } catch { this.lastError = '无法创建 GSCore 连接'; this.scheduleRetry(); return; }
    this.socket = socket;
    const current = () => this.started && generation === this.generation && this.socket === socket;
    socket.on('open', () => {
      if (!current()) return;
      this.state = 'connected';
      this.attempts = 0;
      this.lastError = '';
      this.heartbeatAlive = true;
      this.heartbeat = setInterval(() => {
        if (!current()) return;
        if (!this.heartbeatAlive) { this.lastError = 'GSCore 心跳超时'; socket.terminate(); return; }
        this.heartbeatAlive = false;
        try { socket.ping(); } catch { socket.terminate(); }
      }, 30000);
      this.heartbeat.unref?.();
    });
    socket.on('pong', () => { if (current()) this.heartbeatAlive = true; });
    socket.on('message', (data: RawData) => {
      if (!current()) return;
      const lease = this.captureLease();
      Promise.resolve().then(() => { if (lease()) return this.onMessage(data.toString(), lease); }).catch(() => {
        if (current()) this.lastError = 'GSCore 消息格式或处理失败，请检查兼容性';
      });
    });
    socket.on('error', () => {
      if (!current()) return;
      // Never include ws errors/URLs: they can contain query-token credentials.
      this.lastError = 'GSCore 连接失败，请检查地址、服务状态和 Token';
      socket.terminate();
    });
    socket.on('close', () => {
      if (!current()) return;
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      this.socket = null;
      if (!this.lastError) this.lastError = 'GSCore 连接已断开';
      this.scheduleRetry();
    });
  }

  private scheduleRetry (): void {
    if (!this.started || !this.config.enabled || this.retryTimer) return;
    if (this.attempts >= this.config.maxReconnectAttempts) { this.state = 'error'; return; }
    this.state = 'retrying';
    const delay = Math.min(this.config.reconnectIntervalMs * 2 ** Math.min(this.attempts, 4), 300000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.attempts++;
      this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }
}
