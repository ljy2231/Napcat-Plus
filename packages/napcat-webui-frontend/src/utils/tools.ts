export function formatBytes (bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function previewExpiry (expiresAt: string | number): number {
  const time = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
  return Number.isFinite(time) ? time : 0;
}

export function cleanupInputError (categories: string[], olderThanDays: number): string | undefined {
  if (!categories.length || categories.some((category) => !['logs', 'cache'].includes(category))) return '请至少选择一种允许的清理类别。';
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650) return '保留天数必须为 1–3650 之间的整数。';
}
