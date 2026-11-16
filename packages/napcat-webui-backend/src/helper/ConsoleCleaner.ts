import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

type Category = 'logs' | 'cache';
interface Candidate { category: Category; name: string; file: string; root: string; size: number; mtimeMs: number; ino: number; dev: number; }
interface Preview { expiresAt: number; files: Candidate[]; }

/** Conservative cleanup: only explicit NapCat cache/log roots, never QQ account data. */
export class ConsoleCleaner {
  private readonly previews = new Map<string, Preview>();
  constructor (private readonly roots: Record<Category, string>) {}

  async preview (input: unknown) {
    const request = input as { categories?: unknown; olderThanDays?: unknown; };
    if (!request || !Array.isArray(request.categories) || !request.categories.length || request.categories.length > 2 || request.categories.some(c => c !== 'logs' && c !== 'cache')) throw new Error('请选择日志或临时缓存');
    if (!Number.isInteger(request.olderThanDays) || Number(request.olderThanDays) < 1 || Number(request.olderThanDays) > 3650) throw new Error('保留时间需为 1–3650 天');
    const cutoff = Date.now() - Number(request.olderThanDays) * 86400000;
    const files: Candidate[] = [];
    let scanned = 0; let truncated = false;
    for (const category of new Set(request.categories as Category[])) {
      const supplied = path.resolve(this.roots[category]);
      let root: string;
      try {
        const info = await fs.lstat(supplied);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('清理根目录必须是实际目录');
        root = await fs.realpath(supplied);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (root === path.parse(root).root) throw new Error('拒绝清理文件系统根目录');
      const stack = [root];
      while (stack.length && scanned < 10000 && files.length < 1000) {
        const directory = stack.pop()!;
        if (!(await fs.realpath(directory)).startsWith(root + path.sep) && directory !== root) continue;
        const handle = await fs.opendir(directory);
        for await (const entry of handle) {
          if (++scanned > 10000 || files.length >= 1000) { truncated = true; break; }
          if (entry.isSymbolicLink()) continue;
          const file = path.join(directory, entry.name);
          const stat = await fs.lstat(file);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) { stack.push(file); continue; }
          if (!stat.isFile() || stat.nlink !== 1 || stat.mtimeMs >= cutoff) continue;
          if (/\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$/i.test(entry.name) || /^(?:qrcode\.png|machine-info|login)/i.test(entry.name)) continue;
          if (category === 'logs' && !/\.(?:log|txt|jsonl)$/i.test(entry.name)) continue;
          const resolved = await fs.realpath(file);
          if (!resolved.startsWith(root + path.sep)) continue;
          files.push({ category, name: path.relative(root, file), file, root, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev });
        }
      }
      if (stack.length) truncated = true;
    }
    const previewId = randomBytes(24).toString('hex');
    const expiresAt = Date.now() + 60000;
    for (const [key, preview] of this.previews) if (preview.expiresAt < Date.now()) this.previews.delete(key);
    if (this.previews.size >= 10) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(previewId, { expiresAt, files });
    return {
      previewId,
      expiresAt,
      count: files.length,
      totalBytes: files.reduce((n, f) => n + f.size, 0),
      truncated,
      files: files.map(({ category, name, size }) => ({ category, name, size })),
    };
  }

  async execute (input: unknown) {
    const request = input as { previewId?: unknown; confirm?: unknown; };
    if (!request || typeof request.previewId !== 'string' || request.confirm !== true) throw new Error('需要有效预览和明确确认');
    const preview = this.previews.get(request.previewId);
    this.previews.delete(request.previewId); // one-shot even if deletion partially fails
    if (!preview || preview.expiresAt < Date.now()) throw new Error('预览已过期，请重新预览');
    let deleted = 0; let skipped = 0; let bytes = 0;
    for (const candidate of preview.files) {
      try {
        // Verify the exact resolved target and identity immediately before unlink.
        const currentRoot = await fs.realpath(this.roots[candidate.category]);
        const resolved = await fs.realpath(candidate.file);
        const stat = await fs.lstat(candidate.file);
        if (currentRoot !== candidate.root || !resolved.startsWith(currentRoot + path.sep) || resolved !== candidate.file || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.ino !== candidate.ino || stat.dev !== candidate.dev || stat.size !== candidate.size || stat.mtimeMs !== candidate.mtimeMs) { skipped++; continue; }
        await fs.unlink(resolved);
        deleted++; bytes += candidate.size;
      } catch { skipped++; }
    }
    return { deleted, skipped, bytes };
  }
}
