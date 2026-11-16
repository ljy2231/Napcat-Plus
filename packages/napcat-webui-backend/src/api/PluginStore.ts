import type { RequestHandler } from 'express';
import { sendError, sendSuccess } from '@/napcat-webui-backend/src/utils/response';
import {
  isValidPluginCatalogId,
  pluginCatalog,
} from '@/napcat-webui-backend/src/helper/PluginCatalog';
import { installPluginFromStore, PluginInstallError, type PluginManagerLike } from '@/napcat-webui-backend/src/helper/PluginInstaller';
import { WebUiDataRuntime } from '@/napcat-webui-backend/src/helper/Data';
import { NapCatOneBot11Adapter } from '@/napcat-onebot/index';
import { OB11PluginMangerAdapter } from '@/napcat-onebot/network/plugin-manger';

function getPluginManager (): OB11PluginMangerAdapter | null {
  const ob11 = WebUiDataRuntime.getOneBotContext() as NapCatOneBot11Adapter;
  if (!ob11) return null;
  return ob11.networkManager.findSomeAdapter('plugin_manager') as OB11PluginMangerAdapter;
}

function resolveStoreItem (id: unknown) {
  if (!isValidPluginCatalogId(id)) return { error: '插件 ID 无效' } as const;
  const snapshot = pluginCatalog.snapshot();
  if (snapshot.sourceStatus !== 'online') return { error: '云端目录不可用或已过期，请刷新后重试' } as const;
  const item = snapshot.plugins.find(plugin => plugin.id === id);
  if (!item) return { error: '当前目录没有该插件' } as const;
  if (item.availability !== 'installable' || !item.downloadUrl || !item.sha256 || !item.size) {
    return { error: item.availabilityReason || '该条目没有可核验的安装包' } as const;
  }
  return { item } as const;
}

export const GetPluginStoreListHandler: RequestHandler = async (req, res) => {
  return sendSuccess(res, pluginCatalog.snapshot(req.query['forceRefresh'] === 'true'));
};

export const GetPluginStoreDetailHandler: RequestHandler = async (req, res) => {
  const id = req.params['id'];
  if (!isValidPluginCatalogId(id)) return sendError(res, '插件 ID 无效');
  const plugin = pluginCatalog.snapshot().plugins.find(item => item.id === id);
  return plugin ? sendSuccess(res, plugin) : sendError(res, '当前目录没有该插件');
};

/**
 * Installs only an independently approved, fresh catalog entry. The archive is
 * staged and checked before a new plugin directory is committed. Existing
 * installations are not replaced, and plugin code is not automatically run.
 */
export const InstallPluginFromStoreHandler: RequestHandler = async (req, res) => {
  // Query-string credentials are unsuitable for a state-changing endpoint.
  if (!/^Bearer\s+\S+$/i.test(req.headers?.authorization || '')) return sendError(res, '安装请求需要 Authorization Bearer 凭据');
  if (!req.is('application/json')) return sendError(res, '安装请求必须使用 JSON');
  const resolved = resolveStoreItem(req.body?.id);
  if ('error' in resolved) return sendError(res, resolved.error);
  try {
    const result = await installPluginFromStore(resolved.item, getPluginManager() as unknown as PluginManagerLike | null);
    return sendSuccess(res, result);
  } catch (error) {
    const message = error instanceof PluginInstallError || error instanceof Error ? error.message : '安装失败';
    return sendError(res, message);
  }
};

// GET requests must never start an installation: EventSource reconnects and
// link previews can replay them. Use the authenticated POST endpoint instead.
export const InstallPluginFromStoreSSEHandler: RequestHandler = async (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ code: -1, error: '请使用 POST 接口安装插件', done: true })}\n\n`);
  res.end();
};
