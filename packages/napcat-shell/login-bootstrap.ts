import type { LoginStartSnapshot } from './login-start-gate';
import { createLoginStartGate } from './login-start-gate';

export interface LoginBootstrapEvents<Result> {
  connected: () => void;
  disconnected: () => void;
  succeeded: (result: Result) => void;
}

export interface LoginBootstrapOptions<History, Result> {
  /** Must synchronously register the real native listener, not a late proxy. */
  register: (events: LoginBootstrapEvents<Result>) => (() => void) | void;
  initialize: () => Promise<void>;
  loadHistory: () => Promise<History>;
  webUiReady: Promise<unknown>;
  connect: () => unknown;
  startInitial: (history: History) => Promise<void> | void;
  startReconnect: () => Promise<void> | void;
  onError: (error: unknown) => void;
  onTimeout: (state: LoginStartSnapshot, stage: LoginBootstrapStage) => void;
  timeoutMs?: number;
}

export type LoginBootstrapStage = 'initializing_native' | 'loading_history' | 'waiting_webui' | 'waiting_connection' | 'starting_login';

/**
 * Executed by the production shell, not just a test helper. Construction installs
 * listeners synchronously; initialize() cannot run until start() is called.
 */
export function createLoginBootstrap<History, Result> (options: LoginBootstrapOptions<History, Result>) {
  let stage: LoginBootstrapStage = 'initializing_native';
  let history: History;
  let started: Promise<void> | undefined;
  let resolveLogin!: (result: Result) => void;
  let rejectLogin!: (error: unknown) => void;
  const waitForLogin = new Promise<Result>((resolve, reject) => {
    resolveLogin = resolve;
    rejectLogin = reject;
  });
  // A native success can arrive before start() completes. Errors are consumed
  // immediately too, while the original promise still rejects to its caller.
  waitForLogin.catch(() => {});
  // Normalize an early rejected WebUI promise before asynchronous native init.
  const webUiReady = options.webUiReady.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  const gate = createLoginStartGate({
    startInitial: () => {
      stage = 'starting_login';
      return options.startInitial(history);
    },
    startReconnect: options.startReconnect,
    onError: options.onError,
    onTimeout: state => options.onTimeout(state, stage),
    timeoutMs: options.timeoutMs,
  });
  const unregister = options.register({
    connected: () => gate.connected(),
    disconnected: () => gate.disconnected(),
    succeeded: (result) => {
      gate.succeeded();
      resolveLogin(result);
    },
  });

  return {
    waitForLogin,
    start () {
      if (started) return started;
      started = (async () => {
        try {
          await options.initialize();
          stage = 'loading_history';
          history = await options.loadHistory();
          stage = 'waiting_webui';
          const webUi = await webUiReady;
          if (!webUi.ok) options.onError(webUi.error);
          // Even when WebUI is disabled/unavailable the explicit callback
          // contract permits the shell to fall back to QR rather than hang.
          stage = 'waiting_connection';
          gate.ready();
          options.connect();
        } catch (error) {
          gate.fail(error);
          rejectLogin(error);
          throw error;
        }
      })();
      return started;
    },
    dispose () {
      gate.dispose();
      unregister?.();
    },
    snapshot: gate.snapshot,
    idle: gate.idle,
  };
}
