import { Router } from 'express';
import { WebUiDataRuntime } from '../helper/Data';
import { webUiPathWrapper } from '../../index';
import { sendError, sendSuccess } from '../utils/response';
import { getGScoreRuntime } from '@/napcat-common/src/gscore/runtime';
import { ConsoleCleaner } from '../helper/ConsoleCleaner';
import { OB11PluginMangerAdapter } from '@/napcat-onebot/network/plugin-manger';
const consoleVersion = '0.1.0';

const router = Router();
const runtime = () => {
  if (!webUiPathWrapper?.configPath) throw new Error('配置目录尚未就绪');
  return getGScoreRuntime(webUiPathWrapper.configPath);
};

router.get('/status', (_, res) => {
  try {
    const core = WebUiDataRuntime.getOneBotContext()?.core;
    const nativeLoggedIn = WebUiDataRuntime.getQQLoginStatus();
    const online = core?.selfInfo.online;
    const login = {
      isLogin: nativeLoggedIn && online === true,
      isOffline: nativeLoggedIn && online === false,
      loginPhase: WebUiDataRuntime.getQQLoginPhase(),
      coreReady: nativeLoggedIn && online === true,
      loginError: WebUiDataRuntime.getQQLoginError(),
    };
    const gscore = runtime().status();
    const diagnostics: Array<{ level: 'info' | 'warning' | 'error'; title: string; detail: string; }> = [];
    if (login.loginError) diagnostics.push({ level: 'error', title: '登录需要处理', detail: login.loginError });
    else if (!login.coreReady) diagnostics.push({ level: 'info', title: '等待 QQ 登录', detail: '可继续管理配置；QQ 登录后 GSCore 会自动建立连接。' });
    if (gscore.lastError) diagnostics.push({ level: 'warning', title: 'GSCore 连接诊断', detail: gscore.lastError });
    if (gscore.enabled) diagnostics.push({ level: 'info', title: '避免重复桥接', detail: '已启用内置 GSCore；请停用旧的 GSCore 适配插件，避免重复收发。Docker 中请使用同网络服务名，不要把 localhost 当作其他容器。' });
    if (!diagnostics.length) diagnostics.push({ level: 'info', title: '核心运行正常', detail: '当前没有登录错误；GSCore 可在连接管理页面按需启用。' });
    return sendSuccess(res, { product: 'Napcat-Plus', version: consoleVersion, uptime: Math.floor(process.uptime()), login, gscore, diagnostics });
  } catch { return sendError(res, '控制台状态尚未就绪'); }
});

router.get('/gscore', (_, res) => {
  try { return sendSuccess(res, runtime().getConfig()); } catch { return sendError(res, 'GSCore 配置尚未就绪'); }
});
router.post('/gscore', (req, res) => {
  try { return sendSuccess(res, runtime().update(req.body)); } catch (error) {
    return sendError(res, error instanceof Error ? error.message : '保存 GSCore 配置失败');
  }
});
router.post('/gscore/reconnect', (_, res) => {
  try { runtime().reconnect(); return sendSuccess(res, { requested: true }); } catch (error) {
    return sendError(res, error instanceof Error ? error.message : 'GSCore 重连失败');
  }
});
let cleaner: ConsoleCleaner | undefined;
const getCleaner = () => {
  if (!webUiPathWrapper?.logsPath || !webUiPathWrapper?.cachePath) throw new Error('缓存路径尚未就绪');
  cleaner ??= new ConsoleCleaner({ logs: webUiPathWrapper.logsPath, cache: webUiPathWrapper.cachePath });
  return cleaner;
};
router.post('/cleaner/preview', async (req, res) => {
  try { return sendSuccess(res, await getCleaner().preview(req.body)); } catch (error) {
    return sendError(res, error instanceof Error ? error.message : '清理预览失败');
  }
});
router.post('/cleaner/execute', async (req, res) => {
  try { return sendSuccess(res, await getCleaner().execute(req.body)); } catch (error) {
    return sendError(res, error instanceof Error ? error.message : '清理失败');
  }
});
const reloads = new Set<string>();
router.post('/plugins/reload', async (req, res) => {
  const id: unknown = req.body?.id;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(id)) return sendError(res, '插件 ID 无效');
  const manager = WebUiDataRuntime.getOneBotContext()?.networkManager.findSomeAdapter('plugin_manager') as OB11PluginMangerAdapter | undefined;
  const plugin = manager?.getPluginInfo(id);
  if (!manager || !plugin?.enable || plugin.runtime.status !== 'loaded') return sendError(res, '仅支持重载已启用且已加载的插件');
  if (reloads.has(id)) return sendError(res, '插件正在重载');
  reloads.add(id);
  try {
    const success = await manager.reloadPlugin(id);
    const refreshed = manager.getPluginInfo(id);
    const loaded = success && refreshed?.enable && refreshed.runtime.status === 'loaded';
    return loaded ? sendSuccess(res, { reloaded: true }) : sendError(res, '重载失败，请查看插件日志');
  } catch { return sendError(res, '重载失败，请查看插件日志'); } finally { reloads.delete(id); }
});
export { router as ConsoleRouter };
