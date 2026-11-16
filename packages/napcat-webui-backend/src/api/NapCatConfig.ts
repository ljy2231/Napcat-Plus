import { RequestHandler } from 'express';
import { webUiPathWrapper } from '@/napcat-webui-backend/index';
import { WebUiDataRuntime } from '@/napcat-webui-backend/src/helper/Data';
import { sendError, sendSuccess } from '@/napcat-webui-backend/src/utils/response';
import { NapcatConfigSchema, type NapcatConfig } from '@/napcat-core/helper/config';
import { readSharedConfig, writeSharedConfig } from '@/napcat-webui-backend/src/helper/SharedConfig';

/**
 * NapCat runtime settings are instance-wide (`napcat.json`), never per account.
 * Most of them (logging, packet backend, bypass) only take effect after restart,
 * so a save always reports `pending` instead of pretending it was applied.
 */
const pendingStatus = {
  scope: 'global' as const,
  application: 'pending' as const,
  message: '已保存到实例共享配置 napcat.json；日志、数据包后端与 bypass 等设置需重启 NapCat 后生效。',
};

function readConfig (): { data: NapcatConfig; source: string; legacyAccounts: string[]; } {
  return readSharedConfig<NapcatConfig>(
    webUiPathWrapper.configPath,
    'napcat',
    NapcatConfigSchema,
    WebUiDataRuntime.getQQLoginUin() || undefined
  );
}

function saveConfig (value: unknown): NapcatConfig {
  return writeSharedConfig<NapcatConfig>(webUiPathWrapper.configPath, 'napcat', NapcatConfigSchema, value);
}

export const NapCatGetConfigHandler: RequestHandler = (_, res) => {
  try {
    const result = readConfig();
    return sendSuccess(res, {
      ...result.data,
      __shared: { scope: 'global', source: result.source, legacyAccounts: result.legacyAccounts },
    });
  } catch (e) {
    return sendError(res, 'Config Get Error: ' + (e as Error).message);
  }
};

export const NapCatSetConfigHandler: RequestHandler = (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') return sendError(res, 'config is empty or invalid');
    const current = readConfig().data;
    saveConfig({ ...current, ...newConfig });
    return sendSuccess(res, pendingStatus);
  } catch (e) {
    return sendError(res, 'Config Set Error: ' + (e as Error).message);
  }
};

// ---------------------------------------------------------------------------
// Legacy per-account routes. They used to read/write napcat_<uin>.json; they now
// alias the shared config so old frontends keep working without splitting data.
// ---------------------------------------------------------------------------

export const NapCatGetUinConfigHandler: RequestHandler = (_, res) => {
  try {
    const result = readConfig();
    return sendSuccess(res, {
      ...result.data,
      __shared: { scope: 'global', source: result.source, legacyAccounts: result.legacyAccounts, aliasedFrom: 'per-uin' },
    });
  } catch (e) {
    return sendError(res, 'Config Get Error: ' + (e as Error).message);
  }
};

export const NapCatSetUinConfigHandler: RequestHandler = (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') return sendError(res, 'config is empty or invalid');
    const current = readConfig().data;
    saveConfig({ ...current, ...newConfig });
    return sendSuccess(res, { ...pendingStatus, aliasedFrom: 'per-uin' });
  } catch (e) {
    return sendError(res, 'Config Set Error: ' + (e as Error).message);
  }
};
