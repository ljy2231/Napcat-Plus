/**
 * The OneBot schema must have exactly one definition. This module used to carry a
 * duplicate copy that had drifted (it lost `verifyCertificate`), so saving from
 * the WebUI silently stripped fields. Re-export the loader's schema instead.
 */
export {
  OneBotConfigSchema,
  loadConfig,
  calculateTimeout,
  capTimeout,
} from '@/napcat-onebot/config/config';

export type {
  OneBotConfig,
  HttpServerConfig,
  HttpSseServerConfig,
  HttpClientConfig,
  WebsocketServerConfig,
  WebsocketClientConfig,
  PluginConfig,
  NetworkAdapterConfig,
  NetworkConfigKey,
} from '@/napcat-onebot/config/config';
