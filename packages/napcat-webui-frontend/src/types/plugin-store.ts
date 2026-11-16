export type PluginAvailability = 'installable' | 'builtin' | 'external' | 'unavailable' | 'local';

export interface PluginStoreItem {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  downloadUrl: string;
  tags?: string[];
  minVersion?: string;
  availability?: PluginAvailability;
  availabilityReason?: string;
  builtinPath?: string;
  sourceName?: string;
  sourceUrl?: string;
  sha256?: string;
}

export interface PluginStoreList {
  version: string;
  updateTime: string;
  plugins: PluginStoreItem[];
  sourceStatus?: 'online' | 'cached' | 'bundled';
  sourceMessage?: string;
  sourceUrl?: string;
  checkedAt?: string | null;
  lastSuccessAt?: string | null;
  refreshing?: boolean;
  remoteInstallEnabled?: boolean;
}
