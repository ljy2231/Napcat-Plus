export interface LoginStartSnapshot {
  ready: boolean;
  connected: boolean;
  initialStarted: boolean;
  initialCompleted: boolean;
  initialFailed: boolean;
  connectionEpoch: number;
  running: boolean;
  disposed: boolean;
}

export interface LoginStartGateOptions {
  startInitial: () => Promise<void> | void;
  startReconnect: () => Promise<void> | void;
  onError: (error: unknown) => void;
  onTimeout: (state: LoginStartSnapshot) => void;
  timeoutMs?: number;
}

/**
 * Native connection events are authoritative. No undocumented MSF numeric state
 * or sleep is used to decide whether login can begin. Register the listener
 * before engine/session initialization, then release ready after all barriers.
 */
export function createLoginStartGate (options: LoginStartGateOptions) {
  let ready = false;
  let connected = false;
  let initialStarted = false;
  let initialCompleted = false;
  let initialFailed = false;
  let connectionEpoch = 0;
  let connectionRevision = 0;
  let handledEpoch = -1;
  let successRevision = 0;
  let running: Promise<void> | undefined;
  let disposed = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  const snapshot = (): LoginStartSnapshot => ({
    ready,
    connected,
    initialStarted,
    initialCompleted,
    initialFailed,
    connectionEpoch,
    running: !!running,
    disposed,
  });
  const clearWatchdog = () => {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = undefined;
  };
  const reportError = (error: unknown) => {
    try { options.onError(error); } catch { /* Reporting cannot create retry loops. */ }
  };

  function drain () {
    if (disposed || running || !ready || !connected || initialFailed) return;
    const initial = !initialStarted;
    if (!initial && (!initialCompleted || handledEpoch === connectionEpoch)) return;

    // Take the single-flight lock before invoking a callback or crossing await.
    if (initial) initialStarted = true;
    handledEpoch = connectionEpoch;
    const revision = connectionRevision;
    const success = successRevision;
    running = Promise.resolve().then(async () => {
      if (initial && initialCompleted) return;
      if (disposed || !connected || revision !== connectionRevision) {
        // No native login attempt happened, so a new real connection may retry.
        if (initial) initialStarted = false;
        return;
      }
      await (initial ? options.startInitial() : options.startReconnect());
      if (initial) {
        initialCompleted = true;
        clearWatchdog();
      }
    }).catch((error: unknown) => {
      // A successful native login wins over late async errors, on either path.
      if (disposed || success !== successRevision) return;
      if (initial) initialFailed = true;
      clearWatchdog();
      reportError(error);
    }).finally(() => {
      running = undefined;
      drain();
    });
  }

  watchdog = setTimeout(() => {
    if (disposed || initialCompleted || initialFailed) return;
    try { options.onTimeout(snapshot()); } catch { /* best effort */ }
    // Keep accepting late readiness/connection; a diagnostic timeout is not a retry.
  }, options.timeoutMs ?? 30_000);
  watchdog.unref?.();

  return {
    connected () {
      if (disposed) return;
      if (!connected) {
        connected = true;
        connectionEpoch++;
        connectionRevision++;
      }
      drain();
    },
    disconnected () {
      if (disposed) return;
      connected = false;
      connectionRevision++;
    },
    ready () {
      if (disposed) return;
      ready = true;
      drain();
    },
    succeeded () {
      if (disposed) return;
      successRevision++;
      initialStarted = true;
      initialCompleted = true;
      initialFailed = false;
      clearWatchdog();
    },
    fail (error: unknown) {
      if (disposed || initialCompleted) return;
      initialFailed = true;
      clearWatchdog();
      reportError(error);
    },
    dispose () {
      disposed = true;
      clearWatchdog();
    },
    snapshot,
    async idle () {
      let current = running;
      while (current) {
        await current;
        current = running;
      }
    },
  };
}
