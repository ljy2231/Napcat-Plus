import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import json5 from 'json5';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';

/** Configs that belong to the instance rather than to one QQ account. */
export const SHARED_CONFIG_NAMES = ['onebot11', 'napcat'] as const;
export type SharedConfigName = typeof SHARED_CONFIG_NAMES[number];

export type SharedConfigSource = 'global' | 'migrated-legacy' | 'defaults';

export interface SharedConfigReadResult<T> {
  data: T;
  source: SharedConfigSource;
  /** Legacy per-account files still present on disk. */
  legacyAccounts: string[];
}

export function sharedConfigFile (configPath: string, name: SharedConfigName): string {
  return join(configPath, `${name}.json`);
}

function legacyFile (configPath: string, name: SharedConfigName, uin: string): string {
  return join(configPath, `${name}_${uin}.json`);
}

export function listLegacyAccounts (configPath: string, name: SharedConfigName): string[] {
  try {
    return readdirSync(configPath)
      .filter(file => file.startsWith(`${name}_`) && file.endsWith('.json'))
      .map(file => file.slice(name.length + 1, -'.json'.length))
      .filter(uin => /^\d+$/.test(uin));
  } catch {
    return [];
  }
}

function parseStrict<T> (schema: TSchema, raw: unknown, label: string): T {
  const validate = TypeCompiler.Compile(schema);
  let data: unknown;
  try {
    data = Value.Parse(schema, raw);
  } catch (error) {
    throw new Error(`${label} 格式校验失败: ${(error as Error).message}`);
  }
  if (!validate.Check(data)) {
    throw new Error(`${label} 格式校验失败: ${[...validate.Errors(data)].map(e => e.message).join(', ')}`);
  }
  return data as T;
}

/**
 * Read a shared config without requiring a logged-in QQ account. Never guesses
 * between multiple legacy per-account files and never overwrites them.
 */
export function readSharedConfig<T> (
  configPath: string,
  name: SharedConfigName,
  schema: TSchema,
  preferredUin?: string
): SharedConfigReadResult<T> {
  const globalPath = sharedConfigFile(configPath, name);
  const legacyAccounts = listLegacyAccounts(configPath, name);

  if (existsSync(globalPath)) {
    let raw: unknown;
    try {
      raw = json5.parse(readFileSync(globalPath, 'utf-8'));
    } catch (error) {
      throw new Error(`${name}.json 不是有效 JSON: ${(error as Error).message}`);
    }
    return { data: parseStrict<T>(schema, raw, `${name}.json`), source: 'global', legacyAccounts };
  }

  const uin = preferredUin && /^\d+$/.test(preferredUin) ? preferredUin : undefined;
  if (uin) {
    const legacyPath = legacyFile(configPath, name, uin);
    if (existsSync(legacyPath)) {
      const raw = json5.parse(readFileSync(legacyPath, 'utf-8'));
      const data = parseStrict<T>(schema, raw, `${name}_${uin}.json`);
      writeSharedConfig(configPath, name, schema, data);
      return { data, source: 'migrated-legacy', legacyAccounts };
    }
  }

  return { data: parseStrict<T>(schema, {}, `${name}.json 默认值`), source: 'defaults', legacyAccounts };
}

/** Atomic, owner-only write so a crashed save cannot truncate live config. */
export function writeSharedConfig<T> (configPath: string, name: SharedConfigName, schema: TSchema, value: unknown): T {
  const data = parseStrict<T>(schema, value, `${name}.json`);
  mkdirSync(configPath, { recursive: true });
  const target = sharedConfigFile(configPath, name);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(temporary, target);
  chmodSync(target, 0o600);
  return data;
}
