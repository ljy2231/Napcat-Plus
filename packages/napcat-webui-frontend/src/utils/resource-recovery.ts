/** Only recognize browser/bundler resource errors, never arbitrary fetch failures. */
export function isResourceLoadError (value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const error = value as { name?: unknown; message?: unknown; };
  const message = typeof error.message === 'string' ? error.message : '';
  if (error.name === 'ChunkLoadError' && /Loading (?:CSS )?chunk .* failed/i.test(message)) return true;
  return /Failed to fetch dynamically imported module(?::|\s|$)/i.test(message) ||
    /error loading dynamically imported module(?::|\s|$)/i.test(message) ||
    /Importing a module script failed\.?$/i.test(message) ||
    /Loading CSS chunk .* failed/i.test(message) ||
    /Unable to preload CSS for /i.test(message);
}

export function resourceRecoveryMessage (online: boolean): string {
  return online
    ? '页面资源未能加载，可能是服务刚升级、浏览器缓存仍引用旧文件，或网络暂时中断。这不是 QQ 账号未登录导致的配置限制。'
    : '当前浏览器处于离线状态。请先恢复网络，再手动刷新页面；不会自动重载或清除管理凭据。';
}

/** No timer/auto reload: every refresh is an explicit user action. */
export function shouldReloadResources (online: boolean, confirmed: boolean, alreadyReloading: boolean): boolean {
  return online && confirmed && !alreadyReloading;
}
