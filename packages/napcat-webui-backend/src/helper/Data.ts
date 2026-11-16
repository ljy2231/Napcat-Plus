import store from 'napcat-common/src/store';
import { napCatVersion } from 'napcat-common/src/version';
import { NapCatCoreWorkingEnv, type LoginRuntimeType, type QQLoginPhase } from '../types';

export interface WebUiAutoLoginResult {
  attempted: boolean;
  success: boolean;
  needsVerification?: boolean;
}

type WebUiAutoLoginCallback = () => Promise<WebUiAutoLoginResult | void>;
let webUiAutoLoginCallback: WebUiAutoLoginCallback | undefined;
let refreshingQRCode: Promise<string> | undefined;

const LoginRuntime: LoginRuntimeType = {
  workingEnv: NapCatCoreWorkingEnv.Unknown,
  LoginCurrentTime: Date.now(),
  LoginCurrentRate: 0,
  QQLoginStatus: false, // 已实现 但太傻了 得去那边注册个回调刷新
  QQLoginPhase: 'waiting_qrcode',
  QQQRCodeURL: '',
  QQLoginUin: '',
  QQLoginInfo: {
    uid: '',
    uin: '',
    nick: '',
  },
  QQLoginError: '',
  QQVersion: 'unknown',
  QQDataPath: '',
  OneBotContext: null,
  onQQLoginStatusChange: async (status: boolean) => {
    LoginRuntime.QQLoginStatus = status;
  },
  onWebUiTokenChange: async (_token: string) => {

  },
  onRefreshQRCode: async () => {
    throw new Error('QQ 登录服务尚未初始化完成，请稍后再试');
  },
  NapCatHelper: {
    onOB11ConfigChanged: async () => {

    },
    onQuickLoginRequested: async () => {
      return { result: false, message: '' };
    },
    onPasswordLoginRequested: async () => {
      return { result: false, message: '密码登录功能未初始化' };
    },
    onCaptchaLoginRequested: async () => {
      return { result: false, message: '验证码登录功能未初始化' };
    },
    onNewDeviceLoginRequested: async () => {
      return { result: false, message: '新设备登录功能未初始化' };
    },
    onRestartProcessRequested: async () => {
      return { result: false, message: '重启功能未初始化' };
    },
    QQLoginList: [],
    NewQQLoginList: [],
  },
  NapCatVersion: napCatVersion,
  WebUiConfigQuickFunction: async () => {

  },
};
export const WebUiDataRuntime = {
  setWorkingEnv (env: NapCatCoreWorkingEnv): void {
    LoginRuntime.workingEnv = env;
  },
  getWorkingEnv (): NapCatCoreWorkingEnv {
    return LoginRuntime.workingEnv;
  },
  setWebUiTokenChangeCallback (func: (token: string) => Promise<void>): void {
    LoginRuntime.onWebUiTokenChange = func;
  },
  getWebUiTokenChangeCallback (): (token: string) => Promise<void> {
    return LoginRuntime.onWebUiTokenChange;
  },
  checkLoginRate (ip: string, RateLimit: number): boolean {
    const key = `login_rate:${ip}`;
    const count = store.get<number>(key) || 0;

    if (count === 0) {
      // 第一次访问，设置计数器为1，并设置60秒过期
      store.set(key, 1, 60);
      return true;
    }

    if (count >= RateLimit) {
      return false;
    }

    store.set(key, count + 1);
    return true;
  },

  getQQLoginStatus (): LoginRuntimeType['QQLoginStatus'] {
    return LoginRuntime.QQLoginStatus;
  },

  setQQLoginCallback (func: (status: boolean) => Promise<void>): void {
    LoginRuntime.onQQLoginStatusChange = func;
  },

  getQQLoginCallback (): (status: boolean) => Promise<void> {
    return LoginRuntime.onQQLoginStatusChange;
  },

  setQQLoginStatus (status: LoginRuntimeType['QQLoginStatus']): void {
    LoginRuntime.QQLoginStatus = status;
  },

  setQQLoginPhase (phase: QQLoginPhase): void {
    LoginRuntime.QQLoginPhase = phase;
  },

  getQQLoginPhase (): QQLoginPhase {
    return LoginRuntime.QQLoginPhase;
  },

  setQQLoginQrcodeURL (url: LoginRuntimeType['QQQRCodeURL']): void {
    LoginRuntime.QQQRCodeURL = url;
  },

  getQQLoginQrcodeURL (): LoginRuntimeType['QQQRCodeURL'] {
    return LoginRuntime.QQQRCodeURL;
  },

  setQQLoginInfo (info: LoginRuntimeType['QQLoginInfo']): void {
    LoginRuntime.QQLoginInfo = info;
    LoginRuntime.QQLoginUin = info.uin.toString();
  },

  getQQLoginInfo (): LoginRuntimeType['QQLoginInfo'] {
    return LoginRuntime.QQLoginInfo;
  },

  getQQLoginUin (): LoginRuntimeType['QQLoginUin'] {
    return LoginRuntime.QQLoginUin;
  },

  getQQQuickLoginList (): LoginRuntimeType['NapCatHelper']['QQLoginList'] {
    return LoginRuntime.NapCatHelper.QQLoginList;
  },

  setQQQuickLoginList (list: LoginRuntimeType['NapCatHelper']['QQLoginList']): void {
    LoginRuntime.NapCatHelper.QQLoginList = list;
  },

  getQQNewLoginList (): LoginRuntimeType['NapCatHelper']['NewQQLoginList'] {
    return LoginRuntime.NapCatHelper.NewQQLoginList;
  },

  setQQNewLoginList (list: LoginRuntimeType['NapCatHelper']['NewQQLoginList']): void {
    LoginRuntime.NapCatHelper.NewQQLoginList = list;
  },

  setQuickLoginCall (func: LoginRuntimeType['NapCatHelper']['onQuickLoginRequested']): void {
    LoginRuntime.NapCatHelper.onQuickLoginRequested = func;
  },

  requestQuickLogin: function (uin) {
    return LoginRuntime.NapCatHelper.onQuickLoginRequested(uin);
  } as LoginRuntimeType['NapCatHelper']['onQuickLoginRequested'],

  setPasswordLoginCall (func: LoginRuntimeType['NapCatHelper']['onPasswordLoginRequested']): void {
    LoginRuntime.NapCatHelper.onPasswordLoginRequested = func;
  },

  requestPasswordLogin: function (uin: string, passwordMd5: string) {
    return LoginRuntime.NapCatHelper.onPasswordLoginRequested(uin, passwordMd5);
  } as LoginRuntimeType['NapCatHelper']['onPasswordLoginRequested'],

  setCaptchaLoginCall (func: LoginRuntimeType['NapCatHelper']['onCaptchaLoginRequested']): void {
    LoginRuntime.NapCatHelper.onCaptchaLoginRequested = func;
  },

  requestCaptchaLogin: function (uin: string, passwordMd5: string, ticket: string, randstr: string, sid: string) {
    return LoginRuntime.NapCatHelper.onCaptchaLoginRequested(uin, passwordMd5, ticket, randstr, sid);
  } as LoginRuntimeType['NapCatHelper']['onCaptchaLoginRequested'],

  setNewDeviceLoginCall (func: LoginRuntimeType['NapCatHelper']['onNewDeviceLoginRequested']): void {
    LoginRuntime.NapCatHelper.onNewDeviceLoginRequested = func;
  },

  requestNewDeviceLogin: function (uin: string, passwordMd5: string, newDevicePullQrCodeSig: string) {
    return LoginRuntime.NapCatHelper.onNewDeviceLoginRequested(uin, passwordMd5, newDevicePullQrCodeSig);
  } as LoginRuntimeType['NapCatHelper']['onNewDeviceLoginRequested'],

  setOnOB11ConfigChanged (func: LoginRuntimeType['NapCatHelper']['onOB11ConfigChanged']): void {
    LoginRuntime.NapCatHelper.onOB11ConfigChanged = func;
  },

  setOB11Config: function (ob11) {
    return LoginRuntime.NapCatHelper.onOB11ConfigChanged(ob11);
  } as LoginRuntimeType['NapCatHelper']['onOB11ConfigChanged'],

  GetNapCatVersion () {
    return LoginRuntime.NapCatVersion;
  },

  setQQVersion (version: string) {
    LoginRuntime.QQVersion = version;
  },

  getQQVersion () {
    return LoginRuntime.QQVersion;
  },

  setQQDataPath (dataPath: string) {
    LoginRuntime.QQDataPath = dataPath;
  },

  getQQDataPath (): string {
    return LoginRuntime.QQDataPath;
  },

  setWebUiConfigQuickFunction (func: WebUiAutoLoginCallback): void {
    webUiAutoLoginCallback = func;
  },
  clearWebUiConfigQuickFunction (): void {
    webUiAutoLoginCallback = undefined;
  },
  runWebUiConfigQuickFunction: async function (): Promise<WebUiAutoLoginResult> {
    if (!webUiAutoLoginCallback) return { attempted: false, success: false };
    const result = await webUiAutoLoginCallback();
    // Compatibility for integrations with the old void callback: native success
    // still wins; otherwise shell may safely produce one deduplicated QR.
    return result ?? { attempted: true, success: LoginRuntime.QQLoginStatus };
  },

  setOneBotContext (context: any): void {
    LoginRuntime.OneBotContext = context;
  },

  getOneBotContext (): any | null {
    return LoginRuntime.OneBotContext;
  },

  setRestartProcessCall (func: () => Promise<{ result: boolean; message: string; }>): void {
    LoginRuntime.NapCatHelper.onRestartProcessRequested = func;
  },

  requestRestartProcess: async function () {
    return await LoginRuntime.NapCatHelper.onRestartProcessRequested();
  },

  setQQLoginError (error: string): void {
    LoginRuntime.QQLoginError = error;
  },

  getQQLoginError (): string {
    return LoginRuntime.QQLoginError;
  },

  setRefreshQRCodeCallback (func: () => Promise<void>): void {
    LoginRuntime.onRefreshQRCode = func;
  },

  getRefreshQRCodeCallback (): () => Promise<void> {
    return LoginRuntime.onRefreshQRCode;
  },

  refreshQRCode: function (): Promise<string> {
    if (refreshingQRCode) return refreshingQRCode;
    // Share one native request across duplicate clicks/pollers. Acquire the
    // single-flight promise before invoking a callback that can synchronously
    // emit native login events.
    refreshingQRCode = Promise.resolve().then(async () => {
      const previousQRCodeUrl = LoginRuntime.QQQRCodeURL;
      const previousPhase = LoginRuntime.QQLoginPhase;
      try {
        await LoginRuntime.onRefreshQRCode();
        if (LoginRuntime.QQLoginStatus) throw new Error('QQ 已登录，无需刷新二维码');
        LoginRuntime.QQLoginError = '';
        LoginRuntime.QQLoginPhase = 'generating_qrcode';
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (LoginRuntime.QQLoginStatus) throw new Error('QQ 已登录，无需刷新二维码');
          const qrcodeUrl = LoginRuntime.QQQRCodeURL;
          if (qrcodeUrl && qrcodeUrl !== previousQRCodeUrl) {
            LoginRuntime.QQLoginPhase = 'waiting_qrcode';
            return qrcodeUrl;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('二维码刷新超时：QQ 登录服务未返回新的二维码');
      } catch (error) {
        // Success and explicit reconnect state take precedence over late errors.
        if (!LoginRuntime.QQLoginStatus && LoginRuntime.QQLoginPhase !== 'reconnecting') {
          LoginRuntime.QQLoginError = error instanceof Error ? error.message : String(error);
          LoginRuntime.QQLoginPhase = previousPhase === 'reconnecting' ? previousPhase : previousQRCodeUrl ? 'waiting_qrcode' : 'offline';
        }
        throw error;
      }
    }).finally(() => { refreshingQRCode = undefined; });
    return refreshingQRCode;
  },
};
