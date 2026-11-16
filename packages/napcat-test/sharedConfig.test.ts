import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { listLegacyAccounts, readSharedConfig, sharedConfigFile, writeSharedConfig } from '../napcat-webui-backend/src/helper/SharedConfig';

const Schema = Type.Object({
  enabled: Type.Boolean({ default: false }),
  url: Type.String({ default: '' }),
});

const dirs: string[] = [];
function tempDir (): string {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-shared-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

describe('shared instance config', () => {
  it('reads defaults without requiring a QQ account', () => {
    const dir = tempDir();
    const result = readSharedConfig<{ enabled: boolean; url: string; }>(dir, 'onebot11', Schema);
    expect(result.source).toBe('defaults');
    expect(result.data.enabled).toBe(false);
  });

  it('prefers the existing global file over any legacy account file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'onebot11.json'), JSON.stringify({ enabled: true, url: 'ws://global' }));
    writeFileSync(join(dir, 'onebot11_111.json'), JSON.stringify({ enabled: false, url: 'ws://legacy' }));
    const result = readSharedConfig<{ enabled: boolean; url: string; }>(dir, 'onebot11', Schema, '111');
    expect(result.source).toBe('global');
    expect(result.data.url).toBe('ws://global');
  });

  it('migrates the current account file once and keeps the original', () => {
    const dir = tempDir();
    const legacy = join(dir, 'onebot11_222.json');
    writeFileSync(legacy, JSON.stringify({ enabled: true, url: 'ws://account' }));
    const result = readSharedConfig<{ enabled: boolean; url: string; }>(dir, 'onebot11', Schema, '222');
    expect(result.source).toBe('migrated-legacy');
    expect(readFileSync(sharedConfigFile(dir, 'onebot11'), 'utf-8')).toContain('ws://account');
    expect(existsSync(legacy)).toBe(true);
  });

  it('never guesses between legacy accounts when no account context is known', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'napcat_111.json'), JSON.stringify({ enabled: true, url: 'a' }));
    writeFileSync(join(dir, 'napcat_222.json'), JSON.stringify({ enabled: true, url: 'b' }));
    const result = readSharedConfig<{ enabled: boolean; url: string; }>(dir, 'napcat', Schema);
    expect(result.source).toBe('defaults');
    expect(result.legacyAccounts.sort()).toEqual(['111', '222']);
    expect(existsSync(sharedConfigFile(dir, 'napcat'))).toBe(false);
    expect(listLegacyAccounts(dir, 'napcat').length).toBe(2);
  });

  it('rejects malformed or wrong-typed config instead of silently rewriting it', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'onebot11.json'), JSON.stringify({ enabled: 'yes' }));
    expect(() => readSharedConfig(dir, 'onebot11', Schema)).toThrow(/格式校验失败/);
    writeFileSync(join(dir, 'onebot11.json'), '{ not json');
    expect(() => readSharedConfig(dir, 'onebot11', Schema)).toThrow(/不是有效 JSON/);
  });

  it('writes atomically with owner-only permissions', () => {
    const dir = tempDir();
    writeSharedConfig(dir, 'onebot11', Schema, { enabled: true, url: 'ws://x' });
    const target = sharedConfigFile(dir, 'onebot11');
    expect(JSON.parse(readFileSync(target, 'utf-8')).url).toBe('ws://x');
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});
