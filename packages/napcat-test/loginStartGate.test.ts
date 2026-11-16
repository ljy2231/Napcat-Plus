import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createLoginStartGate, type LoginStartGateOptions } from '../napcat-shell/login-start-gate';

function deferred () {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((_resolve, _reject) => { resolve = _resolve; reject = _reject; });
  return { promise, resolve, reject };
}

const gates: ReturnType<typeof createLoginStartGate>[] = [];
function setup (options: Partial<LoginStartGateOptions> = {}) {
  const initial = vi.fn(async () => {});
  const reconnect = vi.fn(async () => {});
  const error = vi.fn();
  const timeout = vi.fn();
  const gate = createLoginStartGate({ startInitial: initial, startReconnect: reconnect, onError: error, onTimeout: timeout, ...options });
  gates.push(gate);
  return { gate, initial, reconnect, error, timeout };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { gates.splice(0).forEach(g => g.dispose()); vi.useRealTimers(); });

describe('login start gate', () => {
  test('latches an early native event until ready and deduplicates callbacks', async () => {
    const { gate, initial, reconnect } = setup();
    gate.connected(); gate.connected(); await gate.idle();
    expect(initial).not.toHaveBeenCalled();
    gate.ready(); gate.ready(); await gate.idle();
    gate.connected(); await gate.idle();
    expect(initial).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  test('supports ready-first and invalidates an early connection on disconnect', async () => {
    const { gate, initial } = setup();
    gate.connected(); gate.disconnected(); gate.ready(); await gate.idle();
    expect(initial).not.toHaveBeenCalled();
    gate.connected(); await gate.idle();
    expect(initial).toHaveBeenCalledTimes(1);
  });

  test('does not execute a stale queued login; new connection can start it', async () => {
    const { gate, initial } = setup();
    gate.ready(); gate.connected(); gate.disconnected(); gate.connected(); await gate.idle();
    expect(initial).toHaveBeenCalledTimes(1);
  });

  test('reconnect cannot run concurrently with pending initial login', async () => {
    const pending = deferred();
    const { gate, initial, reconnect } = setup({ startInitial: vi.fn(() => pending.promise) });
    gate.ready(); gate.connected(); await Promise.resolve();
    gate.disconnected(); gate.connected(); gate.connected();
    expect(reconnect).not.toHaveBeenCalled();
    pending.resolve(); await gate.idle();
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(initial).not.toHaveBeenCalled();
  });

  test('initial failure is visible and does not retry automatic account login', async () => {
    const initial = vi.fn(() => { throw new Error('failed'); });
    const { gate, error } = setup({ startInitial: initial });
    gate.ready(); gate.connected(); await gate.idle();
    gate.disconnected(); gate.connected(); gate.ready(); await gate.idle();
    expect(initial).toHaveBeenCalledTimes(1); expect(error).toHaveBeenCalledTimes(1);
    expect(gate.snapshot().initialFailed).toBe(true);
  });

  test('diagnostic timeout reports phase but late connection can recover', async () => {
    const { gate, timeout, initial } = setup({ timeoutMs: 100 });
    gate.ready(); await vi.advanceTimersByTimeAsync(100);
    expect(timeout).toHaveBeenCalledWith(expect.objectContaining({ ready: true, connected: false }));
    gate.connected(); await gate.idle();
    expect(initial).toHaveBeenCalledTimes(1);
  });

  test('success before queued microtask never starts another automatic login', async () => {
    const { gate, initial } = setup();
    gate.ready(); gate.connected(); gate.succeeded(); await gate.idle();
    expect(initial).not.toHaveBeenCalled();
  });

  test.each(['initial', 'reconnect'])('success wins over a late %s rejection', async (kind) => {
    const pending = deferred();
    const { gate, error, timeout } = setup(kind === 'initial' ? { startInitial: () => pending.promise } : { startReconnect: () => pending.promise });
    gate.ready(); gate.connected();
    if (kind === 'reconnect') { await gate.idle(); gate.disconnected(); gate.connected(); }
    await Promise.resolve(); gate.succeeded(); pending.reject(new Error('late')); await gate.idle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(error).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled();
  });

  test('disposing cancels queued work and deadline', async () => {
    const { gate, initial, timeout } = setup();
    gate.ready(); gate.connected(); gate.dispose(); await gate.idle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(initial).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled();
  });
});
