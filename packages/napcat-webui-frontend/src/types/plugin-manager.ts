/** 插件状态 */
export type PluginStatus = 'active' | 'disabled' | 'stopped';

/** 插件信息 */
export interface PluginItem {
  /** 显示名称 (优先 package.json 的 plugin 字段) */
  name: string;
  /** 包名 (package name)，用于 API 操作 */
  id: string;
  /** 版本号 */
  version: string;
  /** 描述 */
  description: string;
  /** 作者 */
  author: string;
  /** 状态: active-运行中, disabled-已禁用, stopped-已停止 */
  status: PluginStatus;
  /** 是否有配置项 */
  hasConfig?: boolean;
  /** 是否有扩展页面 */
  hasPages?: boolean;
  /** 主页链接 */
  homepage?: string;
  /** 仓库链接 */
  repository?: string;
  /** 插件图标 URL（由后端返回） */
  icon?: string;
}

/** 扩展页面信息 */
export interface ExtensionPageItem {
  /** 插件 ID */
  pluginId: string;
  /** 插件名称 */
  pluginName: string;
  /** 页面路径 */
  path: string;
  /** 页面标题 */
  title: string;
  /** 页面图标 */
  icon?: string;
  /** 页面描述 */
  description?: string;
}

/** 插件列表响应 */
export interface PluginListResponse {
  plugins: PluginItem[];
  pluginManagerNotFound: boolean;
  extensionPages: ExtensionPageItem[];
}
