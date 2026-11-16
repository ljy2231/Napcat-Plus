import { serverRequest } from '@/utils/request';

export type CleanupCategory = 'logs' | 'cache';
export interface CleanupPreview {
  previewId: string;
  expiresAt: string | number;
  count: number;
  totalBytes: number;
  files: Array<{ name: string; category: string; size: number; }>;
  truncated: boolean;
}
export interface CleanupResult { deleted: number; skipped: number; bytes: number; }

export default class ToolsManager {
  static async previewCleanup (categories: CleanupCategory[], olderThanDays: number) {
    const { data } = await serverRequest.post<ServerResponse<CleanupPreview>>('/Console/cleaner/preview', { categories, olderThanDays });
    return data.data;
  }

  static async executeCleanup (previewId: string) {
    const { data } = await serverRequest.post<ServerResponse<CleanupResult>>('/Console/cleaner/execute', { previewId, confirm: true });
    return data.data;
  }

  static async reloadPlugin (id: string) {
    await serverRequest.post('/Console/plugins/reload', { id });
  }
}
