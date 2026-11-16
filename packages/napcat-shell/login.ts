import type { SelfInfo } from 'napcat-core/index';
import { NodeIKernelLoginListener } from '@/napcat-core/listeners/NodeIKernelLoginListener';
import type { NapCatPathWrapper } from '@/napcat-common/src/path';
import type { LoginListItem, NodeIKernelLoginService } from '@/napcat-core/services/NodeIKernelLoginService';
import type { LogWrapper } from '@/napcat-core/helper/log';
import { proxiedListenerOf } from '@/napcat-core/helper/proxy-handler';
import { WebUiDataRuntime } from '@/napcat-webui-backend/src/helper/Data';
import { createLoginBootstrap } from './login-bootstrap';
import type { LoginBootstrapEvents } from './login-bootstrap';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import qrcode from 'napcat-qrcode/lib/main';

export interface LoginContext {
  isLogined: boolean;
  connected: boolean;
  qrRequested: boolean;
  automaticLogin: boolean;
}

export function prepareLogin (
  loginService: NodeIKernelLoginService,
  logger: LogWrapper,
  pathWrapper: NapCatPathWrapper,
  quickLoginUin: string | undefined,
  options: { initialize: () => Promise<void>; webUiReady: Promise<unknown>; timeoutMs?: number; }
) {
  const context: LoginContext = { isLogined: false, connected: false, qrRequested: false, automaticLogin: false };
  WebUiDataRuntime.setRefreshQRCodeCallback(async () => {
    throw new Error('QQ 登录服务尚未初始化完成，请稍后再试');
  });
  return createLoginBootstrap<LoginListItem[], SelfInfo>({
    ...options,
    register: events => registerLoginListener(loginService, logger, pathWrapper, context, events),
    loadHistory: async () => (await loginService.getLoginList()).LocalLoginInfoList,
    connect: () => loginService.connect(),
    startInitial: async (history) => {
      WebUiDataRuntime.setQQLoginError('');
      WebUiDataRuntime.setQQLoginPhase('generating_qrcode');
      // The real native connection event is latched; no sleep or MSF enum guess.
      await handleLoginInner(context, logger, loginService, quickLoginUin, history);
      logger.log('[Core] [Login] 首次登录流程已启动');
    },
    startReconnect: () => {
      if (context.isLogined) return;
      WebUiDataRuntime.setQQLoginError('');
      WebUiDataRuntime.setQQLoginPhase('generating_qrcode');
      requestQRCode(context, loginService);
    },
    onError: (error) => {
      if (context.isLogined) return;
      WebUiDataRuntime.setQQLoginError('登录初始化失败，请检查日志或手动重启');
      WebUiDataRuntime.setQQLoginPhase('offline');
      logger.logError('[Core] [Login] 初始化失败（不会自动重复登录）', error);
    },
    onTimeout: (state, stage) => {
      if (context.isLogined) return;
      const description = !state.ready
        ? ({ initializing_native: '等待 QQ 原生初始化', loading_history: '等待历史登录记录', waiting_webui: '等待 WebUI 登录配置' } as Record<string, string>)[stage] ?? stage
        : !state.connected ? '等待 QQ 连接成功事件' : '等待登录请求完成';
      WebUiDataRuntime.setQQLoginError(`登录初始化等待超时：${description}`);
      WebUiDataRuntime.setQQLoginPhase('offline');
      logger.logWarn('[Core] [Login] ' + description + '；后续连接仍可恢复');
    },
  });
}

function requestQRCode (context: LoginContext, service: NodeIKernelLoginService) {
  if (context.isLogined || context.qrRequested) return;
  if (!context.connected) throw new Error('QQ 登录服务尚未连接，请等待连接恢复');
  context.qrRequested = true;
  try {
    if (!service.getQRCodePicture()) throw new Error('QQ 未接受二维码请求');
  } catch (error) {
    context.qrRequested = false;
    throw error;
  }
}

function registerLoginListener (
  loginService: NodeIKernelLoginService,
  logger: LogWrapper,
  pathWrapper: NapCatPathWrapper,
  context: LoginContext,
  events: LoginBootstrapEvents<SelfInfo>
) {
  const loginListener = new NodeIKernelLoginListener();
  loginListener.onUserLoggedIn = (userid: string) => {
    const tips = `当前账号(${userid})已登录,无法重复登录`;
    logger.logError(tips);
    WebUiDataRuntime.setQQLoginError(tips);
  };
  loginListener.onQRCodeLoginSucceed = async (loginResult) => {
    context.isLogined = true;
    WebUiDataRuntime.setQQLoginStatus(true);
    WebUiDataRuntime.setQQLoginError('');
    const oneBotContext = WebUiDataRuntime.getOneBotContext();
    if (oneBotContext?.core?.selfInfo) {
      oneBotContext.core.selfInfo.online = true;
      WebUiDataRuntime.setQQLoginPhase('ready');
    } else {
      WebUiDataRuntime.setQQLoginPhase('initializing');
    }
    events.succeeded({
      uid: loginResult.uid,
      uin: loginResult.uin,
      nick: '',
      online: true,
    });
  };
  loginListener.onLoginDisConnected = () => {
    context.connected = false;
    context.qrRequested = false;
    events.disconnected();
    context.isLogined = false;
    WebUiDataRuntime.setQQLoginStatus(false);
    WebUiDataRuntime.setQQLoginPhase('offline');
    logger.logWarn('[Core] [Login] 登录服务已断开，将允许重新获取二维码');
  };
  loginListener.onLogoutSucceed = () => {
    context.connected = false;
    context.qrRequested = false;
    events.disconnected();
    context.isLogined = false;
    WebUiDataRuntime.setQQLoginStatus(false);
    WebUiDataRuntime.setQQLoginPhase('offline');
  };
  loginListener.onLoginConnected = () => {
    context.connected = true;
    events.connected();
  };
  loginListener.onQRCodeGetPicture = ({ pngBase64QrcodeData, qrcodeUrl }) => {
    if (context.isLogined) return;
    context.qrRequested = true;
    WebUiDataRuntime.setQQLoginQrcodeURL(qrcodeUrl);
    WebUiDataRuntime.setQQLoginError('');
    WebUiDataRuntime.setQQLoginPhase('waiting_qrcode');

    const realBase64 = pngBase64QrcodeData.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(realBase64, 'base64');
    logger.logWarn('请扫描下面的二维码，然后在手Q上授权登录：');
    const qrcodePath = path.join(pathWrapper.cachePath, 'qrcode.png');
    qrcode.generate(qrcodeUrl, { small: true }, (res) => {
      logger.logWarn([
        '\n',
        res,
        '二维码解码URL: ' + qrcodeUrl,
        '如果控制台二维码无法扫码，可以复制解码url到二维码生成网站生成二维码再扫码，也可以打开下方的二维码路径图片进行扫码。',
      ].join('\n'));
      fs.writeFile(qrcodePath, buffer, {}, () => {
        logger.logWarn('二维码已保存到', qrcodePath);
      });
    });
  };

  loginListener.onQRCodeSessionUserScaned = () => {
    if (context.isLogined) return;
    WebUiDataRuntime.setQQLoginPhase('qrcode_scanned');
    logger.log('[Core] [Login] 二维码已被扫描，等待确认...');
  };

  loginListener.onQRCodeSessionFailed = (errType: number, errCode: number) => {
    if (!context.isLogined) {
      logger.logError('[Core] [Login] Login Error,ErrType: ', errType, ' ErrCode:', errCode);
      if (errType === 1 && errCode === 3) {
        // 仅二维码过期时自动请求下一张二维码。账号被踢下线等其他错误
        // 需要由用户触发刷新，避免每两秒重复创建原生登录会话。
        WebUiDataRuntime.setQQLoginError('二维码已过期，请刷新');
        context.qrRequested = false;
        try { requestQRCode(context, loginService); } catch (error) { logger.logError(error); }
      }
    }
  };

  loginListener.onLoginFailed = (...args) => {
    if (context.isLogined) return;
    const errInfo = JSON.stringify(args);
    logger.logError('[Core] [Login] Login Error , ErrInfo: ', errInfo);
    WebUiDataRuntime.setQQLoginError(`登录失败: ${errInfo}`);
  };

  const listenerId = loginService.addKernelLoginListener(proxiedListenerOf(loginListener, logger));
  logger.log('[Core] [Login] 已提前注册登录监听器');
  return () => loginService.removeKernelLoginListener(listenerId);
}

export async function handleLoginInner (context: LoginContext, logger: LogWrapper, loginService: NodeIKernelLoginService, quickLoginUin: string | undefined, historyLoginList: LoginListItem[]) {
  const requestFallbackQr = () => {
    if (context.automaticLogin || context.isLogined) return;
    try { requestQRCode(context, loginService); } catch (error) {
      logger.logError('[Core] [Login] 二维码回退请求失败', error);
      WebUiDataRuntime.setQQLoginError('二维码请求失败，请等待连接恢复后刷新');
    }
  };
  const resolveQuickPasswordMd5 = (): string | undefined => {
    const quickPasswordMd5 = process.env['NAPCAT_QUICK_PASSWORD_MD5']?.trim();
    if (quickPasswordMd5) {
      if (/^[a-fA-F0-9]{32}$/.test(quickPasswordMd5)) {
        return quickPasswordMd5.toLowerCase();
      }
      logger.logError('NAPCAT_QUICK_PASSWORD_MD5 格式无效（需为 32 位 MD5）');
    }

    const quickPassword = process.env['NAPCAT_QUICK_PASSWORD'];
    if (typeof quickPassword === 'string' && quickPassword.length > 0) {
      logger.log('检测到 NAPCAT_QUICK_PASSWORD，已在内存中计算 MD5 用于回退登录');
      return createHash('md5').update(quickPassword, 'utf8').digest('hex');
    }

    return undefined;
  };

  // 注册刷新二维码回调
  WebUiDataRuntime.setRefreshQRCodeCallback(async () => {
    if (context.isLogined) throw new Error('QQ 已登录，无需刷新二维码');
    if (WebUiDataRuntime.getQQLoginPhase() === 'reconnecting' || !context.connected) {
      throw new Error('QQ 登录服务正在重连，请稍后再试');
    }
    context.qrRequested = false;
    requestQRCode(context, loginService);
    logger.logWarn('[Core] [Login] 已请求刷新二维码');
  });

  WebUiDataRuntime.setQuickLoginCall(async (uin: string) => {
    return await new Promise((resolve) => {
      if (uin) {
        logger.log('正在快速登录 ', uin);
        loginService.quickLoginWithUin(uin).then(res => {
          if (context.isLogined) return resolve({ result: true, message: '' });
          const quickLoginSuccess = res.result === '0' && !res.loginErrorInfo?.errMsg;
          if (!quickLoginSuccess) {
            const errMsg = res.loginErrorInfo?.errMsg || `快速登录失败，错误码: ${res.result}`;
            WebUiDataRuntime.setQQLoginError(errMsg);
            requestFallbackQr();
            resolve({ result: false, message: errMsg });
          } else {
            WebUiDataRuntime.setQQLoginStatus(true);
            WebUiDataRuntime.setQQLoginError('');
            resolve({ result: true, message: '' });
          }
        }).catch((e) => {
          if (context.isLogined) return resolve({ result: true, message: '' });
          logger.logError(e);
          WebUiDataRuntime.setQQLoginError('快速登录发生错误');
          requestFallbackQr();
          resolve({ result: false, message: '快速登录发生错误' });
        });
      } else {
        resolve({ result: false, message: '快速登录失败' });
      }
    });
  });

  // 注册密码登录回调
  WebUiDataRuntime.setPasswordLoginCall(async (uin: string, passwordMd5: string) => {
    return await new Promise((resolve) => {
      if (uin && passwordMd5) {
        logger.log('正在密码登录 ', uin);
        loginService.passwordLogin({
          uin,
          passwordMd5,
          step: 0,
          newDeviceLoginSig: new Uint8Array(),
          proofWaterSig: new Uint8Array(),
          proofWaterRand: new Uint8Array(),
          proofWaterSid: new Uint8Array(),
          unusualDeviceCheckSig: new Uint8Array(),
        }).then(res => {
          if (context.isLogined) return resolve({ result: true, message: '' });
          if (res.result === '140022008') {
            const proofWaterUrl = res.loginErrorInfo?.proofWaterUrl || '';
            logger.log('需要验证码, proofWaterUrl: ', proofWaterUrl);
            resolve({
              result: false,
              message: '需要验证码',
              needCaptcha: true,
              proofWaterUrl,
            });
          } else if (res.result === '140022010') {
            const jumpUrl = res.loginErrorInfo?.jumpUrl || '';
            const newDevicePullQrCodeSig = res.loginErrorInfo?.newDevicePullQrCodeSig || '';
            logger.log('新设备需要扫码验证, jumpUrl: ', jumpUrl);
            resolve({
              result: false,
              message: '新设备需要扫码验证',
              needNewDevice: true,
              jumpUrl,
              newDevicePullQrCodeSig,
            });
          } else if (res.result === '140022011') {
            const jumpUrl = res.loginErrorInfo?.jumpUrl || '';
            const newDevicePullQrCodeSig = res.loginErrorInfo?.newDevicePullQrCodeSig || '';
            logger.log('异常设备需要验证, jumpUrl: ', jumpUrl);
            resolve({
              result: false,
              message: '异常设备需要验证',
              needNewDevice: true,
              jumpUrl,
              newDevicePullQrCodeSig,
            });
          } else if (res.result !== '0') {
            const errMsg = res.loginErrorInfo?.errMsg || '密码登录失败';
            WebUiDataRuntime.setQQLoginError(errMsg);
            requestFallbackQr();
            resolve({ result: false, message: errMsg });
          } else {
            WebUiDataRuntime.setQQLoginStatus(true);
            WebUiDataRuntime.setQQLoginError('');
            resolve({ result: true, message: '' });
          }
        }).catch((e) => {
          if (context.isLogined) return resolve({ result: true, message: '' });
          logger.logError(e);
          WebUiDataRuntime.setQQLoginError('密码登录发生错误');
          requestFallbackQr();
          resolve({ result: false, message: '密码登录发生错误' });
        });
      } else {
        resolve({ result: false, message: '密码登录失败：参数不完整' });
      }
    });
  });
  const tryPasswordFallbackLogin = async (uin: string): Promise<{ success: boolean; attempted: boolean; needsVerification?: boolean; }> => {
    const quickPasswordMd5 = resolveQuickPasswordMd5();
    if (!quickPasswordMd5) {
      logger.log(`QQ ${uin} 未配置回退密码环境变量，建议优先使用 ACCOUNT + NAPCAT_QUICK_PASSWORD（NAPCAT_QUICK_PASSWORD_MD5 作为备用），将使用二维码登录方式`);
      return { success: false, attempted: false };
    }

    logger.log('正在尝试密码回退登录 ', uin);
    const fallbackResult = await WebUiDataRuntime.requestPasswordLogin(uin, quickPasswordMd5);
    if (fallbackResult.result) {
      logger.log('密码回退登录成功 ', uin);
      return { success: true, attempted: true };
    }
    if (fallbackResult.needCaptcha) {
      const captchaTip = fallbackResult.proofWaterUrl
        ? `密码回退需要验证码，请在 WebUi 中继续完成验证：${fallbackResult.proofWaterUrl}`
        : '密码回退需要验证码，请在 WebUi 中继续完成验证';
      logger.logWarn(captchaTip);
      WebUiDataRuntime.setQQLoginError('密码回退需要验证码，请在 WebUi 中继续完成验证');
      return { success: false, attempted: true, needsVerification: true };
    }
    if (fallbackResult.needNewDevice) {
      const newDeviceTip = fallbackResult.jumpUrl
        ? `密码回退需要新设备验证，请在 WebUi 中继续完成验证：${fallbackResult.jumpUrl}`
        : '密码回退需要新设备验证，请在 WebUi 中继续完成验证';
      logger.logWarn(newDeviceTip);
      WebUiDataRuntime.setQQLoginError('密码回退需要新设备验证，请在 WebUi 中继续完成验证');
      return { success: false, attempted: true, needsVerification: true };
    }
    logger.logError('密码回退登录失败：', fallbackResult.message);
    return { success: false, attempted: true };
  };

  // 注册验证码登录回调（密码登录需要验证码时的第二步）
  WebUiDataRuntime.setCaptchaLoginCall(async (uin: string, passwordMd5: string, ticket: string, randstr: string, sid: string) => {
    return await new Promise((resolve) => {
      if (uin && passwordMd5 && ticket) {
        logger.log('正在验证码登录 ', uin);
        loginService.passwordLogin({
          uin,
          passwordMd5,
          step: 1,
          newDeviceLoginSig: new Uint8Array(),
          proofWaterSig: new TextEncoder().encode(ticket),
          proofWaterRand: new TextEncoder().encode(randstr),
          proofWaterSid: new TextEncoder().encode(sid),
          unusualDeviceCheckSig: new Uint8Array(),
        }).then(res => {
          if (context.isLogined) return resolve({ result: true, message: '' });
          if (res.result === '140022010') {
            const jumpUrl = res.loginErrorInfo?.jumpUrl || '';
            const newDevicePullQrCodeSig = res.loginErrorInfo?.newDevicePullQrCodeSig || '';
            logger.log('验证码登录后需要新设备验证, jumpUrl: ', jumpUrl);
            resolve({
              result: false,
              message: '新设备需要扫码验证',
              needNewDevice: true,
              jumpUrl,
              newDevicePullQrCodeSig,
            });
          } else if (res.result === '140022011') {
            const jumpUrl = res.loginErrorInfo?.jumpUrl || '';
            const newDevicePullQrCodeSig = res.loginErrorInfo?.newDevicePullQrCodeSig || '';
            logger.log('验证码登录后需要异常设备验证, jumpUrl: ', jumpUrl);
            resolve({
              result: false,
              message: '异常设备需要验证',
              needNewDevice: true,
              jumpUrl,
              newDevicePullQrCodeSig,
            });
          } else if (res.result !== '0') {
            const errMsg = res.loginErrorInfo?.errMsg || '验证码登录失败';
            WebUiDataRuntime.setQQLoginError(errMsg);
            requestFallbackQr();
            resolve({ result: false, message: errMsg });
          } else {
            WebUiDataRuntime.setQQLoginStatus(true);
            WebUiDataRuntime.setQQLoginError('');
            resolve({ result: true, message: '' });
          }
        }).catch((e) => {
          if (context.isLogined) return resolve({ result: true, message: '' });
          logger.logError(e);
          WebUiDataRuntime.setQQLoginError('验证码登录发生错误');
          requestFallbackQr();
          resolve({ result: false, message: '验证码登录发生错误' });
        });
      } else {
        resolve({ result: false, message: '验证码登录失败：参数不完整' });
      }
    });
  });

  // 注册新设备登录回调（密码登录需要新设备验证时的第二步）
  WebUiDataRuntime.setNewDeviceLoginCall(async (uin: string, passwordMd5: string, newDevicePullQrCodeSig: string) => {
    return await new Promise((resolve) => {
      if (uin && passwordMd5 && newDevicePullQrCodeSig) {
        logger.log('正在新设备验证登录 ', uin);
        loginService.passwordLogin({
          uin,
          passwordMd5,
          step: 2,
          newDeviceLoginSig: new TextEncoder().encode(newDevicePullQrCodeSig),
          proofWaterSig: new Uint8Array(),
          proofWaterRand: new Uint8Array(),
          proofWaterSid: new Uint8Array(),
          unusualDeviceCheckSig: new Uint8Array(),
        }).then(res => {
          if (context.isLogined) return resolve({ result: true, message: '' });
          if (res.result === '140022011') {
            const jumpUrl = res.loginErrorInfo?.jumpUrl || '';
            const newDevicePullQrCodeSig = res.loginErrorInfo?.newDevicePullQrCodeSig || '';
            logger.log('新设备验证后需要异常设备验证, jumpUrl: ', jumpUrl);
            resolve({
              result: false,
              message: '异常设备需要验证',
              needNewDevice: true,
              jumpUrl,
              newDevicePullQrCodeSig,
            });
          } else if (res.result !== '0') {
            const errMsg = res.loginErrorInfo?.errMsg || '新设备验证登录失败';
            WebUiDataRuntime.setQQLoginError(errMsg);
            requestFallbackQr();
            resolve({ result: false, message: errMsg });
          } else {
            WebUiDataRuntime.setQQLoginStatus(true);
            WebUiDataRuntime.setQQLoginError('');
            resolve({ result: true, message: '' });
          }
        }).catch((e) => {
          if (context.isLogined) return resolve({ result: true, message: '' });
          logger.logError(e);
          WebUiDataRuntime.setQQLoginError('新设备验证登录发生错误');
          requestFallbackQr();
          resolve({ result: false, message: '新设备验证登录发生错误' });
        });
      } else {
        resolve({ result: false, message: '新设备验证登录失败：参数不完整' });
      }
    });
  });
  let loginAccepted = false;
  let needsVerification = false;
  context.automaticLogin = true;
  try {
    if (quickLoginUin) {
      if (historyLoginList.some(u => u.uin === quickLoginUin)) {
        // Await the actual request, not a detached .then chain: reconnect cannot
        // start a second login while this one is still in flight.
        const result = await WebUiDataRuntime.requestQuickLogin(quickLoginUin);
        loginAccepted = result.result;
      }
      if (!loginAccepted && !context.isLogined) {
        const result = await tryPasswordFallbackLogin(quickLoginUin);
        loginAccepted = result.success;
        needsVerification = result.needsVerification === true;
      }
    } else {
      // The callback explicitly reports whether it attempted login. A password
      // env var or stale history alone must never suppress the QR fallback.
      const result = await WebUiDataRuntime.runWebUiConfigQuickFunction();
      loginAccepted = result.success;
      needsVerification = result.needsVerification === true;
    }
  } catch (error) {
    logger.logError('[Core] [Login] 自动登录策略执行失败', error);
  } finally {
    context.automaticLogin = false;
  }
  if (!loginAccepted && !needsVerification && !context.isLogined) requestFallbackQr();

  loginService.getLoginList().then((res) => {
    const list = res.LocalLoginInfoList.filter(item => item.isQuickLogin);
    WebUiDataRuntime.setQQQuickLoginList(list.map(item => item.uin.toString()));
    WebUiDataRuntime.setQQNewLoginList(list);
  }).catch(error => logger.logWarn('[Core] [Login] 更新历史登录列表失败', error));
}
