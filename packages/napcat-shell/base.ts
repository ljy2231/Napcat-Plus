import type { SelfInfo } from 'napcat-core/index';

import { NodeIKernelSessionListener } from 'napcat-core/listeners';
import { NodeIDependsAdapter, NodeIDispatcherAdapter, NodeIGlobalAdapter } from 'napcat-core/adapters';
import { NapCatPathWrapper } from 'napcat-common/src/path';
import {
  genSessionConfig,
  InstanceContext,
  loadQQWrapper,
  NapCatCore,
  NapCatCoreWorkingEnv,
  NodeIQQNTStartupSessionWrapper,
  NodeIQQNTWrapperEngine,
  NodeIQQNTWrapperSession,
  PlatformType,
  WrapperNodeApi,
  WrapperSessionInitConfig,
} from 'napcat-core';
import { hostname, systemVersion } from 'napcat-common/src/system';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NodeIKernelLoginService } from 'napcat-core/services';
import { NapCatAdapterManager } from 'napcat-adapter';
import { InitWebUi } from 'napcat-webui-backend/index';
import { WebUiDataRuntime } from 'napcat-webui-backend/src/helper/Data';
import { napCatVersion } from 'napcat-common/src/version';
import { NodeIO3MiscListener } from 'napcat-core/listeners/NodeIO3MiscListener';
import { FFmpegService } from '@/napcat-core/helper/ffmpeg/ffmpeg';
import { NativePacketHandler } from 'napcat-core/packet/handler/client';
import { Napi2NativeLoader } from 'napcat-core/packet/handler/napi2nativeLoader';
import { NapProtoMsg } from 'napcat-protobuf';
import { OidbSvcTrpcTcpBase, OidbSvcTrpcTcp0XCDE_2RespBody } from '@/napcat-core/packet/transformer/proto';
import { loadNapcatConfig } from '@/napcat-core/helper/config';
import { logSubscription, LogWrapper } from '@/napcat-core/helper/log';
import { prepareLogin } from './login';
import { createOfflineRecovery } from '@/napcat-core/helper/offline-recovery';
import { QQBasicInfoWrapper } from '@/napcat-core/helper/qq-basic-info';
import { statusHelperSubscription } from '@/napcat-core/helper/status';
import { applyPendingUpdates } from '@/napcat-webui-backend/src/api/UpdateNapCat';
import { migrateLegacyGlobalPath } from './global-migrate';
import { getDataPaths } from './data-path';
import { connectToNamedPipe } from './pipe';

// NapCat Shell App ES 入口文件
async function handleUncaughtExceptions (logger: LogWrapper) {
  process.on('uncaughtException', (err) => {
    logger.logError('[NapCat] [Error] Unhandled Exception:', err.message);
  });
  process.on('unhandledRejection', (reason) => {
    logger.logError('[NapCat] [Error] unhandledRejection:', reason);
  });
}

function getPlatformType (): PlatformType {
  const platformMapping: Partial<Record<NodeJS.Platform, PlatformType>> = {
    win32: PlatformType.KWINDOWS,
    darwin: PlatformType.KMAC,
    linux: PlatformType.KLINUX,
  };
  return platformMapping[os.platform()] ?? PlatformType.KWINDOWS;
}

async function initializeEngine (
  engine: NodeIQQNTWrapperEngine,
  basicInfoWrapper: QQBasicInfoWrapper,
  dataPathGlobal: string,
  systemPlatform: PlatformType,
  systemVersion: string
) {
  engine.initWithDeskTopConfig(
    {
      base_path_prefix: '',
      platform_type: systemPlatform,
      app_type: 4,
      app_version: basicInfoWrapper.getFullQQVersion(),
      os_version: systemVersion,
      use_xlog: false,
      qua: basicInfoWrapper.QQVersionQua ?? '',
      global_path_config: {
        desktopGlobalPath: dataPathGlobal,
      },
      thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
    },
    new NodeIGlobalAdapter()
  );
}

async function initializeLoginService (
  loginService: NodeIKernelLoginService,
  basicInfoWrapper: QQBasicInfoWrapper,
  dataPathGlobal: string,
  systemVersion: string,
  hostname: string
) {
  loginService.initConfig({
    machineId: '',
    appid: basicInfoWrapper.QQVersionAppid ?? '',
    platVer: systemVersion,
    commonPath: dataPathGlobal,
    clientVer: basicInfoWrapper.getFullQQVersion(),
    hostName: hostname,
    externalVersion: false,
  });
}

async function initializeSession (
  session: NodeIQQNTWrapperSession,
  sessionConfig: WrapperSessionInitConfig,
  startupSession: NodeIQQNTStartupSessionWrapper | null
) {
  return new Promise<void>((resolve, reject) => {
    const sessionListener = new NodeIKernelSessionListener();
    sessionListener.onOpentelemetryInit = (info) => {
      if (info.is_init) {
        resolve();
      } else {
        reject(new Error('opentelemetry init failed'));
      }
    };
    session.init(
      sessionConfig,
      new NodeIDependsAdapter(),
      new NodeIDispatcherAdapter(),
      sessionListener
    );
    if (startupSession) {
      startupSession.start();
    } else {
      try {
        session.startNT(0);
      } catch {
        try {
          session.startNT();
        } catch (e: unknown) {
          reject(new Error('init failed ' + (e as Error).message));
        }
      }
    }
  });
}
async function handleProxy (session: NodeIQQNTWrapperSession, logger: LogWrapper) {
  if (process.env['NAPCAT_PROXY_PORT']) {
    session.getMSFService().setNetworkProxy({
      userName: '',
      userPwd: '',
      address: process.env['NAPCAT_PROXY_ADDRESS'] || '127.0.0.1',
      port: +process.env['NAPCAT_PROXY_PORT'],
      proxyType: 2,
      domain: '',
      isSocket: true,
    });
    logger.logWarn('已设置代理', process.env['NAPCAT_PROXY_ADDRESS'], process.env['NAPCAT_PROXY_PORT']);
  } else if (process.env['NAPCAT_PROXY_CLOSE']) {
    session.getMSFService().setNetworkProxy({
      userName: '',
      userPwd: '',
      address: '',
      port: 0,
      proxyType: 0,
      domain: '',
      isSocket: false,
    });
  }
}

export async function NCoreInitShell () {
  console.log('NapCat Shell App Loading...');
  const pathWrapper = new NapCatPathWrapper();
  const logger = new LogWrapper(pathWrapper.logsPath);
  if (process.env['NAPCAT_WORKER_PROCESS'] !== '1' && process.env['NAPCAT_DISABLE_MULTI_PROCESS'] !== '1' && process.env['NAPCAT_DISABLE_MULTIPROCESSING'] !== '1') {
    logger.setFileLogEnabled(false);
  }
  handleUncaughtExceptions(logger);
  await applyPendingUpdates(pathWrapper, logger);

  // 提前初始化 Native 模块（在登录前加载）
  const basicInfoWrapper = new QQBasicInfoWrapper({ logger });
  const nativePacketHandler = new NativePacketHandler({ logger });
  const napi2nativeLoader = new Napi2NativeLoader({ logger });

  // 初始化 FFmpeg 服务
  await FFmpegService.init(pathWrapper.binaryPath, logger);

  if (!(process.env['NAPCAT_DISABLE_PIPE'] === '1' || process.env['NAPCAT_WORKER_PROCESS'] === '1')) {
    await connectToNamedPipe(logger).catch(e => logger.logError('命名管道连接失败', e));
  }
  const wrapper = loadQQWrapper(basicInfoWrapper.QQMainPath, basicInfoWrapper.getFullQQVersion());
  // wrapper.node 加载后再初始化 hook，按 schema 读取配置
  const napcatConfig = loadNapcatConfig(pathWrapper.configPath);
  await nativePacketHandler.init(basicInfoWrapper.getFullQQVersion(), napcatConfig.o3HookMode === 1);

  // 登录前监听 OidbSvcTrpcTcp.0xcde_2 数据包，获取数据库 passphrase
  let dbPassphrase: string | undefined;
  nativePacketHandler.onCmd('OidbSvcTrpcTcp.0xcde_2', ({ type, hex_data }) => {
    if (type !== 1) return; // 仅处理接收方向
    try {
      const raw = Buffer.from(hex_data, 'hex');
      const base = new NapProtoMsg(OidbSvcTrpcTcpBase).decode(raw);
      if (base.body && base.body.length > 0) {
        const body = new NapProtoMsg(OidbSvcTrpcTcp0XCDE_2RespBody).decode(base.body);
        if (body.inner?.value) {
          dbPassphrase = body.inner.value;
          logger.log('[NapCat] 已启用数据库辅助支持能力');
        }
      }
    } catch (e) {
      logger.logError('[NapCat] [0xCDE_2] 解析失败:', e);
    }
  });

  if (process.env['NAPCAT_ENABLE_VERBOSE_LOG'] === '1') {
    napi2nativeLoader.nativeExports.setVerbose?.(true);
  }
  // wrapper.node 加载后立刻启用 Bypass（可通过环境变量禁用）
  if (process.env['NAPCAT_DISABLE_BYPASS'] !== '1') {
    const bypassOptions = napcatConfig.bypass ?? {};
    napi2nativeLoader.nativeExports.enableAllBypasses?.(bypassOptions);
  } else {
    logger.log('[NapCat] Napi2NativeLoader: Bypass已通过环境变量禁用');
  }

  const o3Service = wrapper.NodeIO3MiscService.get();
  o3Service.addO3MiscListener(new NodeIO3MiscListener());

  logger.log('[NapCat] [Core] NapCat.Core Version: ' + napCatVersion);
  WebUiDataRuntime.setWorkingEnv(NapCatCoreWorkingEnv.Shell);
  const webUiReady = InitWebUi(logger, pathWrapper, logSubscription, statusHelperSubscription);
  const engine = wrapper.NodeIQQNTWrapperEngine.get();
  const loginService = wrapper.NodeIKernelLoginService.get();
  let session!: NodeIQQNTWrapperSession;
  let startupSession: NodeIQQNTStartupSessionWrapper | null = null;
  let dataPath!: string;
  let quickLoginUin: string | undefined;
  try {
    const args = process.argv;
    const qIndex = args.findIndex(arg => arg === '-q' || arg === '--qq');
    if (qIndex !== -1 && qIndex + 1 < args.length) {
      quickLoginUin = args[qIndex + 1];
    }
  } catch (error) {
    logger.logWarn('解析命令行参数失败，无法使用快速登录功能', error);
  }

  // Construction synchronously registers the real login listener. Native
  // session/engine/config initialization runs only after that registration.
  const loginBootstrap = prepareLogin(loginService, logger, pathWrapper, quickLoginUin, {
    webUiReady,
    initialize: async () => {
      try {
        startupSession = wrapper.NodeIQQNTStartupSessionWrapper.create();
        session = wrapper.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1');
      } catch (error) {
        try {
          session = wrapper.NodeIQQNTWrapperSession.create();
        } catch (sessionError) {
          logger.logError('创建 StartupSession 失败', error);
          throw sessionError;
        }
      }
      const paths = getDataPaths(wrapper);
      dataPath = paths[0];
      const dataPathGlobal = paths[1];
      migrateLegacyGlobalPath(dataPath, dataPathGlobal, logger);
      WebUiDataRuntime.setQQDataPath(dataPath);
      if (!basicInfoWrapper.QQVersionAppid || !basicInfoWrapper.QQVersionQua) {
        throw new Error('QQVersionAppid or QQVersionQua is not defined');
      }
      await initializeEngine(engine, basicInfoWrapper, dataPathGlobal, getPlatformType(), systemVersion);
      await initializeLoginService(loginService, basicInfoWrapper, dataPathGlobal, systemVersion, hostname);
      await handleProxy(session, logger);
    },
  });
  await loginBootstrap.start();
  const dataTimestape = new Date().getTime().toString();
  o3Service.reportAmgomWeather('login', 'a1', [dataTimestape, '0', '0']);
  const selfInfo = await loginBootstrap.waitForLogin;
  const appId = basicInfoWrapper.QQVersionAppid;
  if (!appId) throw new Error('QQVersionAppid is not defined after login initialization');

  // 登录成功后通知 Master 进程（用于切换崩溃重试策略）
  if (typeof process.send === 'function') {
    process.send({ type: 'login-success' });
    logger.log('[NapCat] 已通知主进程登录成功');
  }

  const amgomDataPiece = 'eb1fd6ac257461580dc7438eb099f23aae04ca679f4d88f53072dc56e3bb1129';
  o3Service.setAmgomDataPiece(appId, new Uint8Array(Buffer.from(amgomDataPiece, 'hex')));

  let guid = loginService.getMachineGuid();
  guid = guid.slice(0, 8) + '-' + guid.slice(8, 12) + '-' + guid.slice(12, 16) + '-' + guid.slice(16, 20) + '-' + guid.slice(20);
  o3Service.reportAmgomWeather('login', 'a6', [dataTimestape, '184', '329']);

  const sessionConfig = await genSessionConfig(
    guid,
    appId,
    basicInfoWrapper.getFullQQVersion(),
    selfInfo.uin,
    selfInfo.uid,
    dataPath
  );

  await initializeSession(session, sessionConfig, startupSession);

  const accountDataPath = path.resolve(dataPath, './NapCat/data');
  // 判断dataPath是否为根目录 或者 D:/ 之类的盘目录
  if (dataPath !== '/' && /^[a-zA-Z]:\\$/.test(dataPath) === false) {
    try {
      fs.mkdirSync(accountDataPath, { recursive: true });
    } catch (error) {
      logger.logError('创建accountDataPath失败', error);
    }
  }

  logger.logDebug('本账号数据/缓存目录：', accountDataPath);

  const shell = new NapCatShell(
    wrapper,
    session,
    logger,
    selfInfo,
    basicInfoWrapper,
    pathWrapper,
    nativePacketHandler,
    napi2nativeLoader
  );
  // 将捕获的 passphrase 设置到 core 上，供 DatabaseApi 使用
  if (dbPassphrase) {
    shell.core.dbPassphrase = dbPassphrase;
  }
  await shell.InitNapCat();
}

export class NapCatShell {
  readonly core: NapCatCore;
  readonly context: InstanceContext;

  constructor (
    wrapper: WrapperNodeApi,
    session: NodeIQQNTWrapperSession,
    logger: LogWrapper,
    selfInfo: SelfInfo,
    basicInfoWrapper: QQBasicInfoWrapper,
    pathWrapper: NapCatPathWrapper,
    packetHandler: NativePacketHandler,
    napi2nativeLoader: Napi2NativeLoader
  ) {
    this.context = {
      packetHandler,
      napi2nativeLoader,
      workingEnv: NapCatCoreWorkingEnv.Shell,
      wrapper,
      session,
      logger,
      basicInfoWrapper,
      pathWrapper,
    };
    this.core = new NapCatCore(this.context, selfInfo);
  }

  async InitNapCat () {
    await this.core.initCore();

    // // 测试 DatabaseApi
    // if (this.core.dbPassphrase) {
    //   const dbApi = this.core.apis.DatabaseApi;
    //   const sqliteOk = await dbApi.isSqliteAvailable();
    //   if (sqliteOk) {
    //     try {
    //       const result = dbApi.readDatabase('nt_msg.db');
    //       if (result) {
    //         this.context.logger.log('[NapCat] [Database] nt_msg.db:\n' + dbApi.formatResults([result]));
    //       }
    //     } catch (e) {
    //       this.context.logger.logError('[NapCat] [Database] 读取失败:', e);
    //     }
    //   }
    // }

    // 监听下线并同步到 WebUI
    // KickedOffLine：账号被踢下线；SelfOffline：静默离线（服务端会话语义失效但无通知）。
    // 两者复用同一条恢复链路：同步 WebUI -> 重启 Worker -> 快速登录。
    const handleOffline = createOfflineRecovery({
      isOnline: () => this.core.selfInfo.online === true,
      onOffline: (tips) => {
        WebUiDataRuntime.setQQLoginStatus(false);
        // 下线后的二维码已失效，绝不能继续交给页面展示或扫码。
        WebUiDataRuntime.setQQLoginQrcodeURL('');
        WebUiDataRuntime.setQQLoginError(tips);
        WebUiDataRuntime.setQQLoginPhase('reconnecting');
      },
      onRecovered: () => {
        WebUiDataRuntime.setQQLoginStatus(true);
        WebUiDataRuntime.setQQLoginError('');
        WebUiDataRuntime.setQQLoginPhase('ready');
      },
      restart: async (tips) => {
        try {
          const restartResult = await WebUiDataRuntime.requestRestartProcess();
          this.context.logger.logWarn('[Core] [Login] 账号已离线，正在重启 Worker 以重新创建 QQ 登录服务', restartResult);
          if (restartResult.result) return true;
          WebUiDataRuntime.setQQLoginPhase('offline');
          WebUiDataRuntime.setQQLoginError(`${tips}\n登录服务重启失败：${restartResult.message}`);
        } catch (error) {
          WebUiDataRuntime.setQQLoginPhase('offline');
          WebUiDataRuntime.setQQLoginError(`${tips}\n登录服务重启失败：${(error as Error).message}`);
        }
        return false;
      },
    });
    this.core.event.on('KickedOffLine', (tips: string) => handleOffline(tips, false));
    this.core.event.on('SelfOffline', (tips: string) => handleOffline(tips, true));
    // 使用 NapCatAdapterManager 统一管理协议适配器
    const adapterManager = new NapCatAdapterManager(this.core, this.context, this.context.pathWrapper);
    await adapterManager.initAdapters()
      .catch(e => this.context.logger.logError('初始化协议适配器失败', e));
    // 注册 OneBot 适配器到 WebUiDataRuntime，供调试功能使用
    const oneBotAdapter = adapterManager.getOneBotAdapter();
    if (oneBotAdapter) {
      WebUiDataRuntime.setOneBotContext(oneBotAdapter);
      if (WebUiDataRuntime.getQQLoginStatus()) {
        WebUiDataRuntime.setQQLoginPhase('ready');
      }
    }
  }
}
