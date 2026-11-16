import { GScoreConfigStore, defaultGScoreConfig, publicGScoreConfig, validateGScoreConfig, type GScoreConfig } from './config';
import { GScoreConnection, type GScoreStatus } from './connection';

export class GScoreRuntime {
  private readonly store: GScoreConfigStore;
  private config: GScoreConfig;
  private connection?: GScoreConnection;
  private bindingGeneration = 0;
  private messageGeneration = 0;
  private configurationError = '';

  constructor (directory: string) {
    this.store = new GScoreConfigStore(directory);
    try { this.config = this.store.load(); } catch {
      this.config = { ...defaultGScoreConfig };
      this.configurationError = 'GSCore 配置读取失败，连接已停用；请检查或重新保存配置';
    }
  }

  getConfig () { return publicGScoreConfig(this.config); }

  update (input: unknown) {
    const next = validateGScoreConfig(input, this.config);
    this.store.save(next);
    if (JSON.stringify(next) !== JSON.stringify(this.config)) this.messageGeneration++;
    this.config = next;
    this.configurationError = '';
    this.connection?.update(next);
    return this.getConfig();
  }

  bind (selfId: string, onMessage: (data: string) => Promise<void>) {
    this.connection?.stop();
    const binding = ++this.bindingGeneration;
    let pending = 0;
    let chain = Promise.resolve();
    this.connection = new GScoreConnection(this.config, `qq-bot-console-${selfId}`, async (data) => {
      if (pending >= 100) throw new Error('GSCore 队列已满');
      pending++;
      const generation = this.messageGeneration;
      const task = chain.then(() => {
        if (binding !== this.bindingGeneration || generation !== this.messageGeneration || !this.config.enabled) return;
        return onMessage(data);
      });
      chain = task.catch(() => {});
      try { await task; } finally { pending--; }
    });
    this.connection.start();
  }

  stop () { this.bindingGeneration++; this.connection?.stop(); this.connection = undefined; }
  reconnect () {
    if (!this.config.enabled) throw new Error('请先启用 GSCore');
    if (!this.connection) throw new Error('QQ 尚未登录，登录后将自动连接 GSCore');
    this.messageGeneration++;
    this.connection.reconnect();
  }

  status (): GScoreStatus {
    return this.connection?.status() ?? {
      enabled: this.config.enabled,
      connected: false,
      state: this.configurationError ? 'error' : this.config.enabled ? 'connecting' : 'disabled',
      url: this.config.url,
      reconnectAttempts: 0,
      lastError: this.configurationError || (this.config.enabled ? '等待 QQ 登录后建立 GSCore 连接' : ''),
      tokenConfigured: !!this.config.token,
    };
  }

  send (message: object) { return this.connection?.send(message) ?? false; }
}

const runtimes = new Map<string, GScoreRuntime>();
export function getGScoreRuntime (directory: string): GScoreRuntime {
  let runtime = runtimes.get(directory);
  if (!runtime) { runtime = new GScoreRuntime(directory); runtimes.set(directory, runtime); }
  return runtime;
}
