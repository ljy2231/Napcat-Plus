import type { PluginItem, PluginListResponse } from '../types/plugin-manager';
import type { PluginStoreItem, PluginStoreList } from '../types/plugin-store';

/** The API also includes bundled tools; only entries from its cloud source belong here. */
export function cloudStoreItems (catalog?: PluginStoreList): PluginStoreItem[] {
  if (!catalog?.sourceUrl) return [];
  return catalog.plugins.filter(item => item.availability !== 'builtin' && item.sourceUrl === catalog.sourceUrl);
}

/** Only a successful response from an available manager confirms installation. */
export function confirmedPlugins (response?: PluginListResponse): PluginItem[] | null {
  return response && response.pluginManagerNotFound === false && Array.isArray(response.plugins) ? response.plugins : null;
}

/** Keep manager order and include locally installed plugins absent from the directory. */
export function installedStoreItems (catalog: PluginStoreItem[], installed: PluginItem[] | null): PluginStoreItem[] {
  if (!installed) return [];
  const byId = new Map(catalog.map(item => [item.id, item]));
  return installed.map(plugin => byId.get(plugin.id) || {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    author: plugin.author,
    homepage: plugin.homepage || plugin.repository,
    downloadUrl: '',
    availability: 'local',
    sourceName: '本地插件管理器',
    availabilityReason: '此插件未收录于当前目录，仅显示本地管理器提供的信息。',
  });
}

export type InstallStatus = 'installed' | 'not-installed' | 'unknown';

/** Never infer absence from an unavailable manager or a missing version. */
export function pluginInstallStatus (id: string, installed: PluginItem[] | null): InstallStatus {
  return installed === null ? 'unknown' : installed.some(plugin => plugin.id === id) ? 'installed' : 'not-installed';
}

export function safePluginHomepage (value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.toString();
  } catch { return undefined; }
}

export function builtinPluginPath (plugin: PluginStoreItem): string | undefined {
  if (plugin.availability !== 'builtin') return undefined;
  return ['/gscore', '/tools', '/debug/ws'].includes(plugin.builtinPath || '') ? plugin.builtinPath : undefined;
}

export function pluginAvailabilityLabel (plugin: PluginStoreItem): string {
  return ({ builtin: '项目内置', external: '外部项目', unavailable: '暂不可用', installable: '可安装', local: '本地插件' } as const)[plugin.availability || 'unavailable'];
}
