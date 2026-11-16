import { RequestHandler } from 'express';
import { loadConfig, OneBotConfigSchema, type OneBotConfig } from '@/napcat-webui-backend/src/onebot/config';
import { webUiPathWrapper } from '@/napcat-webui-backend/index';
import { WebUiDataRuntime } from '@/napcat-webui-backend/src/helper/Data';
import { sendError, sendSuccess } from '@/napcat-webui-backend/src/utils/response';
import { isEmpty } from '@/napcat-webui-backend/src/utils/check';
import json5 from 'json5';
import { readSharedConfig, writeSharedConfig } from '@/napcat-webui-backend/src/helper/SharedConfig';

export interface SharedConfigWriteStatus {
  scope: 'global';
  /** applied = already pushed to the running adapters; pending = saved, takes effect later. */
  application: 'applied' | 'pending' | 'failed';
  message: string;
}

/**
 * OneBot settings are instance-wide. Reading works before any QQ account logs in,
 * and the same file is used by every account on this instance.
 */
export const OB11GetConfigHandler: RequestHandler = (_, res) => {
  try {
    const result = readSharedConfig<OneBotConfig>(
      webUiPathWrapper.configPath,
      'onebot11',
      OneBotConfigSchema,
      WebUiDataRuntime.getQQLoginUin() || undefined
    );
    return sendSuccess(res, {
      ...result.data,
      __shared: {
        scope: 'global',
        source: result.source,
        legacyAccounts: result.legacyAccounts,
        online: !!WebUiDataRuntime.getOneBotContext(),
      },
    });
  } catch (error) {
    return sendError(res, 'Config Get Error: ' + (error as Error).message);
  }
};

export const OB11SetConfigHandler: RequestHandler = async (req, res) => {
  if (isEmpty(req.body.config)) return sendError(res, 'config is empty');
  let config: OneBotConfig;
  try {
    config = loadConfig(json5.parse(req.body.config)) as OneBotConfig;
  } catch (error) {
    return sendError(res, 'Config Invalid: ' + (error as Error).message);
  }

  // Persist first so the settings survive a missing/offline OneBot context.
  let saved: OneBotConfig;
  try {
    saved = writeSharedConfig<OneBotConfig>(
      webUiPathWrapper.configPath,
      'onebot11',
      OneBotConfigSchema,
      config
    );
  } catch (error) {
    return sendError(res, 'Config Save Error: ' + (error as Error).message);
  }

  const status: SharedConfigWriteStatus = { scope: 'global', application: 'pending', message: '已保存到实例共享配置；QQ 登录后/重启后生效。' };
  if (WebUiDataRuntime.getOneBotContext()) {
    try {
      await WebUiDataRuntime.setOB11Config(saved);
      status.application = 'applied';
      status.message = '已保存并应用到当前网络适配器。';
    } catch (error) {
      status.application = 'failed';
      status.message = '已保存，但应用到运行中的适配器失败：' + (error as Error).message;
    }
  }
  return sendSuccess(res, status);
};
