import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createLoginBootstrap, type LoginBootstrapEvents } from '../napcat-shell/login-bootstrap';

function deferred<T> () {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((_resolve, _reject) => { resolve = _resolve; reject = _reject; });
  return { promise, resolve, reject };
}
const cleanups: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.useRealTimers(); });

function setup () {
  const native = deferred<void>();
  const history = deferred<string[]>();
  const webui = deferred<void>();
  let events!: LoginBootstrapEvents<string>;
  const order: string[] = [];
  const initial = vi.fn(async (items: string[]) => { order.push('initial:' + items.length); });
  const connect = vi.fn(() => events.connected());
  const error = vi.fn();
  const timeout = vi.fn();
  const remove = vi.fn();
  const bootstrap = createLoginBootstrap({
    register: (value) => { order.push('registered'); events = value; return remove; },
    initialize: () => { order.push('native'); events.connected(); return native.promise; },
    loadHistory: () => { order.push('history'); return history.promise; },
    webUiReady: webui.promise,
    connect,
    startInitial: initial,
    startReconnect: vi.fn(),
    onError: error,
    onTimeout: timeout,
  });
  cleanups.push(() => bootstrap.dispose());
  return { bootstrap, native, history, webui, get events () { return events; }, order, initial, connect, error, timeout, remove };
}

describe('production login bootstrap boundaries', () => {
  test('registers synchronously, then waits native/history/WebUI barriers', async () => {
    const f = setup();
    expect(f.order).toEqual(['registered']);
    const start = f.bootstrap.start();
    expect(f.bootstrap.start()).toBe(start);
    expect(f.order).toEqual(['registered', 'native']);
    f.native.resolve(); await Promise.resolve();
    expect(f.initial).not.toHaveBeenCalled();
    f.history.resolve(['test']); await Promise.resolve();
    expect(f.initial).not.toHaveBeenCalled();
    f.webui.resolve(); await start; await f.bootstrap.idle();
    expect(f.initial).toHaveBeenCalledExactlyOnceWith(['test']);
    expect(f.connect).toHaveBeenCalledTimes(1);
    f.events.succeeded('logged-in');
    await expect(f.bootstrap.waitForLogin).resolves.toBe('logged-in');
  });

  test('a failed/disabled WebUI permits explicit QR fallback strategy', async () => {
    const f = setup(); f.webui.reject(new Error('webui unavailable'));
    const start = f.bootstrap.start(); f.native.resolve(); f.history.resolve([]);
    await start; await f.bootstrap.idle();
    expect(f.error).toHaveBeenCalledTimes(1);
    expect(f.initial).toHaveBeenCalledTimes(1);
  });

  test('native initialization failure rejects caller, never enters login', async () => {
    const f = setup();
    const start = f.bootstrap.start();
    f.native.reject(new Error('native failed')); f.webui.resolve();
    await expect(start).rejects.toThrow('native failed');
    await expect(f.bootstrap.waitForLogin).rejects.toThrow('native failed');
    expect(f.initial).not.toHaveBeenCalled();
  });

  test('reports a pending history stage without retrying or restarting', async () => {
    const f = setup(); f.bootstrap.start(); f.native.resolve(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.timeout).toHaveBeenCalledWith(expect.anything(), 'loading_history');
    expect(f.initial).not.toHaveBeenCalled();
    f.history.resolve([]); f.webui.resolve(); await f.bootstrap.start(); await f.bootstrap.idle();
    expect(f.initial).toHaveBeenCalledTimes(1);
  });

  test('shell uses this bootstrap around native session/engine/config initialization', () => {
    const source = readFileSync(new URL('../napcat-shell/base.ts', import.meta.url), 'utf8');
    expect(source).toContain("import { prepareLogin } from './login'");
    const prepare = source.indexOf('const loginBootstrap = prepareLogin(');
    expect(prepare).toBeGreaterThan(0);
    for (const needle of ['wrapper.NodeIQQNTStartupSessionWrapper.create()', 'await initializeEngine(engine', 'await initializeLoginService(loginService']) {
      expect(source.indexOf(needle)).toBeGreaterThan(prepare);
    }
    expect(source).toContain('await loginBootstrap.start()');
    expect(source).toContain('await loginBootstrap.waitForLogin');
    expect(source).not.toContain('waitForNetworkConnection');
  });
});
