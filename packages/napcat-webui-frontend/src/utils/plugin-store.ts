import type { PluginStoreItem } from '../types/plugin-store';

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
  return ({ builtin: '项目内置', external: '外部项目', unavailable: '暂不可用', installable: '安装暂停' } as const)[plugin.availability || 'unavailable'];
}
