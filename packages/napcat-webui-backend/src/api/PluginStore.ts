import type { RequestHandler } from 'express';
import { sendError, sendSuccess } from '@/napcat-webui-backend/src/utils/response';
import {
  isValidPluginCatalogId,
  pluginCatalog,
  REMOTE_INSTALL_DISABLED_MESSAGE,
} from '@/napcat-webui-backend/src/helper/PluginCatalog';

/** Instant bundled/LKG response; the bounded official check happens in background. */
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
 * Fail closed in both installers, not only in the UI. The old implementation
 * downloaded unverified archives and removed the existing plugin before unzip.
 * Until an independently verified package + staged safe extractor exists, no
 * store request (including mirror/downloadUrl/force overrides) may touch disk.
 */
export const InstallPluginFromStoreHandler: RequestHandler = async (req, res) => {
  if (!isValidPluginCatalogId(req.body?.id)) return sendError(res, '插件 ID 无效');
  return sendError(res, REMOTE_INSTALL_DISABLED_MESSAGE);
};

export const InstallPluginFromStoreSSEHandler: RequestHandler = async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const message = isValidPluginCatalogId(req.query['id']) ? REMOTE_INSTALL_DISABLED_MESSAGE : '插件 ID 无效';
  res.write(`data: ${JSON.stringify({ code: -1, error: message, message, progress: 0, remoteInstallEnabled: false })}\n\n`);
  res.end();
};
