export type DockerUpdatePhase = 'disabled' | 'idle' | 'pulling' | 'applying' | 'rolling_back' | 'succeeded' | 'failed' | 'blocked' | 'rate_limited';
export interface DockerUpdateStatus {
  enabled: boolean;
  phase: DockerUpdatePhase;
  generation?: number;
  message?: string;
  retryAt?: number;
}

const phases: DockerUpdatePhase[] = ['disabled', 'idle', 'pulling', 'applying', 'rolling_back', 'succeeded', 'failed', 'blocked', 'rate_limited'];
export function parseDockerUpdateStatus (input: unknown): DockerUpdateStatus | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.enabled !== 'boolean' || typeof value.phase !== 'string' || !phases.includes(value.phase as DockerUpdatePhase)) return undefined;
  if ((value.enabled && value.phase === 'disabled') || (!value.enabled && value.phase !== 'disabled')) return undefined;
  return {
    enabled: value.enabled,
    phase: value.phase as DockerUpdatePhase,
    generation: typeof value.generation === 'number' && Number.isSafeInteger(value.generation) && value.generation >= 0 ? value.generation : undefined,
    message: typeof value.message === 'string' ? value.message : undefined,
    retryAt: typeof value.retryAt === 'number' && Number.isFinite(value.retryAt) && value.retryAt >= 0 && value.retryAt <= 8640000000000 ? value.retryAt : undefined,
  };
}

export function dockerUpdateBusy (phase: DockerUpdatePhase): boolean {
  return phase === 'pulling' || phase === 'applying' || phase === 'rolling_back';
}

export function dockerUpdatePhaseLabel (phase: DockerUpdatePhase): string {
  return ({ disabled: '更新器未启用', idle: '更新器空闲', pulling: '正在拉取已批准镜像', applying: '正在替换容器', rolling_back: '更新失败，正在回滚', succeeded: '镜像更新完成', failed: '更新失败，已尝试恢复', blocked: '更新受阻，需要管理员处理', rate_limited: '操作过于频繁，请等待后重试' })[phase];
}

export function canStartDockerUpdate (status: DockerUpdateStatus | undefined, pending: boolean, uncertain: boolean): boolean {
  return !!status?.enabled && !pending && !uncertain && !dockerUpdateBusy(status.phase) && status.phase !== 'blocked' && status.phase !== 'rate_limited';
}

export function isAcceptedDockerUpdate (value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as Record<string, unknown>).accepted === true;
}
