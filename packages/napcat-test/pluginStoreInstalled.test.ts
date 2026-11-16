import { describe, expect, it } from 'vitest';
import type { PluginItem, PluginListResponse } from '../napcat-webui-frontend/src/types/plugin-manager';
import type { PluginStoreItem } from '../napcat-webui-frontend/src/types/plugin-store';
import { confirmedPlugins, installedStoreItems } from '../napcat-webui-frontend/src/utils/plugin-store';

const local = (id: string): PluginItem => ({ id, name: id, version: '1.0', author: 'author', description: 'local', status: 'disabled' });
const entry = (id: string): PluginStoreItem => ({ id, name: `catalog ${id}`, version: '2.0', author: 'catalog', description: 'remote', downloadUrl: '', availability: 'external' });
const response = (plugins: PluginItem[], missing = false): PluginListResponse => ({ plugins, pluginManagerNotFound: missing, extensionPages: [] });

describe('installed plugin store entries', () => {
  it('only includes manager-confirmed IDs and adds local-only plugins', () => {
    const installed = confirmedPlugins(response([local('both'), local('local-only')]));
    const items = installedStoreItems([entry('both'), entry('not-installed')], installed);
    expect(items.map(item => item.id)).toEqual(['both', 'local-only']);
    expect(items[0]).toEqual(entry('both'));
    expect(items[1]).toMatchObject({ name: 'local-only', availability: 'local', sourceName: '本地插件管理器', downloadUrl: '' });
  });

  it('treats missing manager, failed request and malformed response as unknown, not empty or stale', () => {
    const catalog = [entry('old')];
    expect(confirmedPlugins(response([local('old')], true))).toBeNull();
    expect(confirmedPlugins(undefined)).toBeNull();
    expect(confirmedPlugins({ plugins: [local('old')] } as PluginListResponse)).toBeNull();
    expect(installedStoreItems(catalog, null)).toEqual([]);
    expect(confirmedPlugins(response([]))).toEqual([]);
    expect(installedStoreItems(catalog, confirmedPlugins(response([])))).toEqual([]);
  });

  it('shows confirmed local plugins even if the catalog is unavailable', () => {
    expect(installedStoreItems([], confirmedPlugins(response([local('offline')])))).toMatchObject([{ id: 'offline', availability: 'local' }]);
  });
});
