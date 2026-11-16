import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { LogWrapper } from '../napcat-core/helper/log';
import type { NapCatPathWrapper } from '../napcat-common/src/path';
import type { NodeIKernelLoginListener } from '../napcat-core/listeners/NodeIKernelLoginListener';
import type { NodeIKernelLoginService, LoginListItem } from '../napcat-core/services/NodeIKernelLoginService';

import { handleLoginInner, prepareLogin, type LoginContext } from '../napcat-shell/login';
import { WebUiDataRuntime } from '../napcat-webui-backend/src/helper/Data';

vi.mock('napcat-qrcode/lib/main', () => ({ default: { generate: vi.fn() } }));
vi.mock('napcat-common/src/store', () => ({ default: { get: vi.fn(), set: vi.fn() } }));
vi.mock('napcat-common/src/version', () => ({ napCatVersion: 'test' }));
vi.mock('../napcat-core/helper/proxy-handler', () => ({ proxiedListenerOf: (listener: unknown) => listener }));

const logger = { log: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() } as unknown as LogWrapper;
const cleanup: (() => void)[] = [];
function service () {
  let listener!: NodeIKernelLoginListener;
  const fake = {
    addKernelLoginListener: vi.fn((value: NodeIKernelLoginListener) => { listener = value; return 1; }),
    removeKernelLoginListener: vi.fn(),
    connect: vi.fn(() => { listener.onLoginConnected(); return true; }),
    getLoginList: vi.fn(async () => ({ result: 0, LocalLoginInfoList: [] })),
    getMsfStatus: vi.fn(() => { throw new Error('must not guess MSF state'); }),
    getQRCodePicture: vi.fn(() => true),
    quickLoginWithUin: vi.fn(async () => ({ result: '-1', loginErrorInfo: { errMsg: 'expired' } })),
    passwordLogin: vi.fn(async () => ({ result: '-1', loginErrorInfo: { errMsg: 'failed' } })),
  };
  return { fake, service: fake as unknown as NodeIKernelLoginService, get listener () { return listener; } };
}
const context = (): LoginContext => ({ isLogined: false, connected: true, qrRequested: false, automaticLogin: false });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('NAPCAT_QUICK_ACCOUNT', ''); vi.stubEnv('NAPCAT_QUICK_PASSWORD', ''); vi.stubEnv('NAPCAT_QUICK_PASSWORD_MD5', '');
  WebUiDataRuntime.clearWebUiConfigQuickFunction();
  WebUiDataRuntime.setQQLoginStatus(false); WebUiDataRuntime.setQQLoginPhase('waiting_qrcode');
  WebUiDataRuntime.setQQLoginError(''); WebUiDataRuntime.setQQLoginQrcodeURL(''); WebUiDataRuntime.setOneBotContext(null);
});
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('real prepareLogin and handleLoginInner', () => {
  test('registers real listener before native init, handles early + duplicate events once', async () => {
    const s = service();
    const initialize = vi.fn(async () => { expect(s.fake.addKernelLoginListener).toHaveBeenCalled(); s.listener.onLoginConnected(); });
    const boot = prepareLogin(s.service, logger, { cachePath: '/unused' } as NapCatPathWrapper, undefined, { initialize, webUiReady: Promise.resolve() });
    cleanup.push(() => boot.dispose());
    expect(s.fake.addKernelLoginListener).toHaveBeenCalledTimes(1);
    expect(typeof boot.start).toBe('function'); expect(boot.waitForLogin).toBeInstanceOf(Promise);
    await boot.start(); await boot.idle();
    s.listener.onLoginConnected(); await boot.idle();
    expect(s.fake.getQRCodePicture).toHaveBeenCalledTimes(1);
    expect(s.fake.getMsfStatus).not.toHaveBeenCalled();
  });

  test('native success resolves promise and ignores a stale QR event', async () => {
    const s = service();
    const boot = prepareLogin(s.service, logger, { cachePath: '/unused' } as NapCatPathWrapper, undefined, { initialize: async () => {}, webUiReady: Promise.resolve() });
    cleanup.push(() => boot.dispose());
    s.listener.onQRCodeLoginSucceed({ uin: 'test', uid: 'test-uid' } as Parameters<NodeIKernelLoginListener['onQRCodeLoginSucceed']>[0]);
    await boot.start(); await boot.idle();
    await expect(boot.waitForLogin).resolves.toMatchObject({ uin: 'test', online: true });
    s.listener.onQRCodeGetPicture({ pngBase64QrcodeData: '', qrcodeUrl: 'stale' });
    expect(WebUiDataRuntime.getQQLoginPhase()).toBe('initializing');
    expect(WebUiDataRuntime.getQQLoginQrcodeURL()).toBe('');
    expect(s.fake.getQRCodePicture).not.toHaveBeenCalled();
  });

  test('unregistered/disabled WebUI and password-only env fall back to one QR', async () => {
    const s = service(); vi.stubEnv('NAPCAT_QUICK_PASSWORD', 'test-password');
    await handleLoginInner(context(), logger, s.service, undefined, []);
    expect(s.fake.quickLoginWithUin).not.toHaveBeenCalled();
    expect(s.fake.getQRCodePicture).toHaveBeenCalledTimes(1);
  });

  test('configured auto account failure is followed by exactly one QR', async () => {
    const s = service();
    WebUiDataRuntime.setWebUiConfigQuickFunction(async () => {
      const result = await WebUiDataRuntime.requestQuickLogin('test');
      return { attempted: true, success: result.result };
    });
    await handleLoginInner(context(), logger, s.service, undefined, []);
    expect(s.fake.quickLoginWithUin).toHaveBeenCalledTimes(1);
    expect(s.fake.getQRCodePicture).toHaveBeenCalledTimes(1);
  });

  test('automatic password fallback does not request intermediate or duplicate QR', async () => {
    const s = service();
    WebUiDataRuntime.setWebUiConfigQuickFunction(async () => {
      await WebUiDataRuntime.requestQuickLogin('test');
      await WebUiDataRuntime.requestPasswordLogin('test', '0'.repeat(32));
      return { attempted: true, success: false };
    });
    await handleLoginInner(context(), logger, s.service, undefined, []);
    expect(s.fake.quickLoginWithUin).toHaveBeenCalledTimes(1);
    expect(s.fake.passwordLogin).toHaveBeenCalledTimes(1);
    expect(s.fake.getQRCodePicture).toHaveBeenCalledTimes(1);
  });

  test('successful or verification-required auto login never requests QR', async () => {
    for (const result of [{ attempted: true, success: true }, { attempted: true, success: false, needsVerification: true }]) {
      const s = service(); WebUiDataRuntime.setWebUiConfigQuickFunction(async () => result);
      await handleLoginInner(context(), logger, s.service, undefined, []);
      expect(s.fake.getQRCodePicture).not.toHaveBeenCalled();
    }
  });

  test('CLI history login awaits result and requests only one fallback QR', async () => {
    const s = service();
    await handleLoginInner(context(), logger, s.service, 'test', [{ uin: 'test' } as LoginListItem]);
    expect(s.fake.quickLoginWithUin).toHaveBeenCalledTimes(1);
    expect(s.fake.getQRCodePicture).toHaveBeenCalledTimes(1);
  });

  test('late automatic login rejection cannot replace a native login success', async () => {
    const s = service();
    let reject!: (reason: unknown) => void;
    s.fake.quickLoginWithUin.mockImplementation(() => new Promise((_resolve, _reject) => { reject = _reject; }));
    WebUiDataRuntime.setWebUiConfigQuickFunction(async () => {
      const result = await WebUiDataRuntime.requestQuickLogin('test');
      return { attempted: true, success: result.result };
    });
    const state = context();
    const result = handleLoginInner(state, logger, s.service, undefined, []);
    state.isLogined = true; WebUiDataRuntime.setQQLoginStatus(true); WebUiDataRuntime.setQQLoginPhase('ready');
    reject(new Error('late')); await result;
    expect(WebUiDataRuntime.getQQLoginError()).toBe('');
    expect(s.fake.getQRCodePicture).not.toHaveBeenCalled();
  });

  test('duplicate refresh calls share one request and preserve login success', async () => {
    let resolve!: () => void;
    const refresh = vi.fn(() => new Promise<void>((_resolve) => { resolve = _resolve; }));
    WebUiDataRuntime.setRefreshQRCodeCallback(refresh);
    const first = WebUiDataRuntime.refreshQRCode();
    const second = WebUiDataRuntime.refreshQRCode();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    WebUiDataRuntime.setQQLoginStatus(true); WebUiDataRuntime.setQQLoginPhase('ready'); resolve();
    await expect(first).rejects.toThrow('已登录');
    expect(WebUiDataRuntime.getQQLoginPhase()).toBe('ready');
  });

  test('refresh callback errors immediately before bootstrap readiness', async () => {
    const s = service(); const pending = new Promise<void>(() => {});
    const boot = prepareLogin(s.service, logger, { cachePath: '/unused' } as NapCatPathWrapper, undefined, { initialize: () => pending, webUiReady: Promise.resolve() });
    cleanup.push(() => boot.dispose());
    await expect(WebUiDataRuntime.getRefreshQRCodeCallback()()).rejects.toThrow('尚未初始化');
  });
});
