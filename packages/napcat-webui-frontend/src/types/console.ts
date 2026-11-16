export interface ConsoleLogin {
  isLogin: boolean;
  isOffline: boolean;
  loginPhase: string;
  coreReady: boolean;
  loginError: string;
}

export interface GSCoreConfig {
  enabled: boolean;
  url: string;
  tokenConfigured: boolean;
  reconnectIntervalMs: number;
  maxReconnectAttempts: number;
}

export interface GSCoreUpdate extends Omit<GSCoreConfig, 'tokenConfigured'> {
  /** Omit to preserve the stored token; an empty string explicitly clears it. */
  token?: string;
}

export interface ConsoleStatus {
  product: 'Napcat-Plus';
  version: string;
  /** Process uptime in seconds, not an invented historical availability metric. */
  uptime: number;
  login: ConsoleLogin;
  gscore: {
    enabled: boolean;
    connected: boolean;
    state: 'disabled' | 'connecting' | 'connected' | 'retrying' | 'error';
    url: string;
    reconnectAttempts: number;
    lastError: string;
    tokenConfigured: boolean;
  };
  diagnostics: Array<{ level: 'info' | 'warning' | 'error'; title: string; detail: string; }>;
}
