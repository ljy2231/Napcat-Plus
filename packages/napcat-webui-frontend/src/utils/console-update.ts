export interface ConsoleUpdateCheck {
  currentVersion: string;
  latestVersion: string | null;
  status: 'current' | 'available' | 'unknown';
  releaseUrl?: string;
}

/** Invalid or incomplete responses must never be presented as a successful check. */
export function parseConsoleUpdate (value: unknown): ConsoleUpdateCheck {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const currentVersion = typeof input.currentVersion === 'string' ? input.currentVersion.trim() : '';
  const latestVersion = typeof input.latestVersion === 'string' && input.latestVersion.trim() ? input.latestVersion.trim() : null;
  const status = currentVersion && latestVersion && (input.status === 'current' || input.status === 'available') ? input.status : 'unknown';
  let releaseUrl: string | undefined;
  if (typeof input.releaseUrl === 'string') {
    try {
      const url = new URL(input.releaseUrl);
      if (url.protocol === 'https:' && !url.username && !url.password) releaseUrl = url.href;
    } catch { /* Ignore unsafe or malformed links. */ }
  }
  return { currentVersion, latestVersion, status, releaseUrl };
}

export function consoleUpdateLabel (data: ConsoleUpdateCheck | undefined, loading: boolean, error: unknown): string {
  if (loading) return '正在检查版本';
  if (error || !data || data.status === 'unknown') return '版本检查不可用';
  return data.status === 'current' ? '已是最新版本' : '有新版本！';
}
