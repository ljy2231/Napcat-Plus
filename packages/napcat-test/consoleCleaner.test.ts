import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConsoleCleaner } from '../napcat-webui-backend/src/helper/ConsoleCleaner';

it('previews only old safe files and requires a one-shot confirmation', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'console-cleaner-'));
  const logs = path.join(root, 'logs'); const cache = path.join(root, 'cache');
  await fs.mkdir(logs); await fs.mkdir(cache);
  const old = new Date(Date.now() - 10 * 86400000);
  try {
    for (const name of ['old.log', 'account.db', 'new.log']) {
      await fs.writeFile(path.join(logs, name), 'abc');
      if (name !== 'new.log') await fs.utimes(path.join(logs, name), old, old);
    }
    await fs.writeFile(path.join(cache, 'qrcode.png'), 'abc'); await fs.utimes(path.join(cache, 'qrcode.png'), old, old);
    const cleaner = new ConsoleCleaner({ logs, cache });
    const preview = await cleaner.preview({ categories: ['logs', 'cache'], olderThanDays: 7 });
    expect(preview.count).toBe(1); expect(preview.files[0]!.name).toBe('old.log');
    await expect(cleaner.execute({ previewId: preview.previewId })).rejects.toThrow();
    expect(await cleaner.execute({ previewId: preview.previewId, confirm: true })).toEqual({ deleted: 1, skipped: 0, bytes: 3 });
    await expect(cleaner.execute({ previewId: preview.previewId, confirm: true })).rejects.toThrow();
    expect(await fs.readFile(path.join(logs, 'account.db'), 'utf8')).toBe('abc');
  } finally { await fs.rm(root, { recursive: true }); }
});

it('does not follow symlinks or delete a changed file after preview', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'console-cleaner-'));
  const logs = path.join(root, 'logs'); await fs.mkdir(logs);
  const old = new Date(Date.now() - 10 * 86400000);
  try {
    const outside = path.join(root, 'outside.log'); await fs.writeFile(outside, 'do not delete'); await fs.utimes(outside, old, old);
    await fs.symlink(outside, path.join(logs, 'link.log'));
    const file = path.join(logs, 'old.log'); await fs.writeFile(file, 'old'); await fs.utimes(file, old, old);
    const cleaner = new ConsoleCleaner({ logs, cache: path.join(root, 'missing') });
    const preview = await cleaner.preview({ categories: ['logs'], olderThanDays: 7 });
    expect(preview.count).toBe(1);
    await fs.writeFile(file, 'new contents');
    expect(await cleaner.execute({ previewId: preview.previewId, confirm: true })).toEqual({ deleted: 0, skipped: 1, bytes: 0 });
    expect(await fs.readFile(outside, 'utf8')).toBe('do not delete');
    await expect(cleaner.preview({ categories: ['../qq'], olderThanDays: 7 })).rejects.toThrow();
    await expect(cleaner.preview({ categories: ['logs'], olderThanDays: 0 })).rejects.toThrow();
  } finally { await fs.rm(root, { recursive: true }); }
});
