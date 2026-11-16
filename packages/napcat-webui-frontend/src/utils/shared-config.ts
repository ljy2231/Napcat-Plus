/** Shared (instance-wide) config status returned by the WebUI backend. */
export interface SharedConfigStatus {
  scope: 'global';
  application: 'applied' | 'pending' | 'failed';
  message: string;
}

export interface SharedConfigMeta {
  scope: 'global';
  source: 'global' | 'migrated-legacy' | 'defaults';
  legacyAccounts?: string[];
  online?: boolean;
  aliasedFrom?: string;
}

export const SHARED_SCOPE_HINT = '这是一份实例级配置：所有 QQ 账号共用同一份，换号后依然沿用。';

export function parseSharedStatus (value: unknown): SharedConfigStatus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<SharedConfigStatus>;
  if (candidate.scope !== 'global') return undefined;
  if (candidate.application !== 'applied' && candidate.application !== 'pending' && candidate.application !== 'failed') return undefined;
  return {
    scope: 'global',
    application: candidate.application,
    message: typeof candidate.message === 'string' ? candidate.message : '',
  };
}

export function sharedStatusToast (status: SharedConfigStatus | undefined, fallback = '保存成功'): { kind: 'success' | 'warning' | 'error'; text: string; } {
  if (!status) return { kind: 'success', text: fallback };
  if (status.application === 'applied') return { kind: 'success', text: status.message || '已保存并生效' };
  if (status.application === 'pending') return { kind: 'warning', text: status.message || '已保存，登录或重启后生效' };
  return { kind: 'error', text: status.message || '已保存，但应用失败' };
}

/** Read the `__shared` metadata block, ignoring anything malformed. */
export function parseSharedMeta (value: unknown): SharedConfigMeta | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<SharedConfigMeta>;
  if (candidate.scope !== 'global') return undefined;
  if (candidate.source !== 'global' && candidate.source !== 'migrated-legacy' && candidate.source !== 'defaults') return undefined;
  return {
    scope: 'global',
    source: candidate.source,
    legacyAccounts: Array.isArray(candidate.legacyAccounts) ? candidate.legacyAccounts.filter(item => typeof item === 'string') : undefined,
    online: typeof candidate.online === 'boolean' ? candidate.online : undefined,
    aliasedFrom: typeof candidate.aliasedFrom === 'string' ? candidate.aliasedFrom : undefined,
  };
}
