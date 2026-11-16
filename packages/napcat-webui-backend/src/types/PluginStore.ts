// 插件商店相关类型定义。保留 plugins/downloadUrl 字段兼容已有客户端。
export type PluginAvailability = 'installable' | 'builtin' | 'external' | 'unavailable';
export type PluginStoreSourceStatus = 'online' | 'cached' | 'bundled';

export interface PluginStoreItem {
  id: string;
  name: string;
  version: string; // 空字符串表示未验证版本，不代表已取得最新版本
  description: string;
  author: string;
  homepage?: string;
  downloadUrl: string; // 没有已核验的安装包时为空，不得用 homepage 代替
  tags?: string[];
  minVersion?: string;
  availability?: PluginAvailability;
  availabilityReason?: string;
  builtinPath?: string; // 本项目内部路径，不是远程资源
  sourceName?: string;
  sourceUrl?: string;
  sha256?: string;
}

export interface PluginStoreList {
  version: string;
  updateTime: string;
  plugins: PluginStoreItem[];
  sourceStatus?: PluginStoreSourceStatus;
  sourceMessage?: string;
  sourceUrl?: string;
  checkedAt?: string | null;
  lastSuccessAt?: string | null;
  refreshing?: boolean;
  remoteInstallEnabled?: boolean;
}
