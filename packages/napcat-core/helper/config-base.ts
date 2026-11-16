import path from 'node:path';
import fs from 'node:fs';
import type { NapCatCore } from '@/napcat-core';
import json5 from 'json5';
import { TypeCompiler, TypeCheck } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import { TSchema } from '@sinclair/typebox';

export abstract class ConfigBase<T> {
  name: string;
  core: NapCatCore;
  configPath: string;
  configData: T = {} as T;
  configSchema: TSchema;
  validate: TypeCheck<TSchema>;
  /** When true the file is instance-wide (`name.json`) instead of per account. */
  readonly shared: boolean;

  protected constructor (name: string, core: NapCatCore, configPath: string, ConfigSchema: TSchema, shared = false) {
    this.name = name;
    this.core = core;
    this.configPath = configPath;
    this.configSchema = ConfigSchema;
    this.shared = shared;
    this.validate = TypeCompiler.Compile(ConfigSchema);
    fs.mkdirSync(this.configPath, { recursive: true });
    this.read();
  }

  getConfigPath (pathName?: string): string {
    if (this.shared) return path.join(this.configPath, `${this.name}.json`);
    const filename = pathName ? `${this.name}_${pathName}.json` : `${this.name}.json`;
    return path.join(this.configPath, filename);
  }

  private getLegacyPath (uin: string): string {
    return path.join(this.configPath, `${this.name}_${uin}.json`);
  }

  /** Legacy per-account files that still exist next to the shared file. */
  private listLegacyAccounts (): string[] {
    const prefix = `${this.name}_`;
    try {
      return fs.readdirSync(this.configPath)
        .filter(file => file.startsWith(prefix) && file.endsWith('.json'))
        .map(file => file.slice(prefix.length, -'.json'.length))
        .filter(uin => /^\d+$/.test(uin));
    } catch {
      return [];
    }
  }

  private schemaDefaults (): T {
    return Value.Parse(this.configSchema, {}) as T;
  }

  /**
   * Copy a legacy per-account file to the shared path, keeping the original in
   * place so a rollback never loses the account's previous settings.
   */
  private migrateLegacy (legacyPath: string, targetPath: string): void {
    const body = fs.readFileSync(legacyPath, 'utf-8');
    const temporary = `${targetPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, body, { mode: 0o600 });
    fs.renameSync(temporary, targetPath);
    fs.chmodSync(targetPath, 0o600);
    this.core.context.logger.log(
      `[Core] [Config] 已将账号配置 ${path.basename(legacyPath)} 复制为实例共享配置 ${path.basename(targetPath)}（原文件保留）`
    );
  }

  read (): T {
    if (this.shared) return this.readShared();
    const configPath = this.getConfigPath(this.core.selfInfo.uin);
    const defaultConfigPath = this.getConfigPath();
    if (!fs.existsSync(configPath)) {
      if (fs.existsSync(defaultConfigPath)) {
        this.configData = this.loadConfig(defaultConfigPath);
      }
      this.save();
      return this.configData;
    }
    return this.loadConfig(configPath);
  }

  private readShared (): T {
    const sharedPath = this.getConfigPath();
    if (fs.existsSync(sharedPath)) return this.loadConfig(sharedPath);

    const uin = this.core.selfInfo.uin;
    const legacyPath = uin ? this.getLegacyPath(uin) : undefined;
    if (legacyPath && fs.existsSync(legacyPath)) {
      this.migrateLegacy(legacyPath, sharedPath);
      return this.loadConfig(sharedPath);
    }

    const legacyAccounts = this.listLegacyAccounts();
    if (legacyAccounts.length > 0) {
      // Never guess which account is authoritative and never overwrite a legacy
      // file. Keep running with defaults until an account context exists.
      this.core.context.logger.logWarn(
        `[Core] [Config] 检测到账号独立配置 ${legacyAccounts.join(', ')}，但当前没有账号信息可用于迁移；` +
        `本次使用默认 ${this.name} 配置且不写入共享文件。登录后将自动迁移当前账号配置。`
      );
      this.configData = this.schemaDefaults();
      return this.configData;
    }

    this.configData = this.schemaDefaults();
    this.save();
    return this.configData;
  }

  private loadConfig (configPath: string): T {
    try {
      const newConfigData = json5.parse(fs.readFileSync(configPath, 'utf-8'));
      let data: unknown = newConfigData;
      data = Value.Parse(this.configSchema, data);
      if (!this.validate.Check(data)) {
        throw new Error([...this.validate.Errors(data)].map(e => e.message).join(', '));
      }
      this.configData = data as T;
      this.core.context.logger.logDebug(`[Core] [Config] 配置文件${configPath}加载`, this.configData);
      return this.configData;
    } catch (e: unknown) {
      this.handleError(e, '读取配置文件时发生错误');
      return {} as T;
    }
  }

  save (newConfigData: T = this.configData): void {
    const configPath = this.getConfigPath(this.core.selfInfo.uin);
    let data: unknown = newConfigData;
    data = Value.Parse(this.configSchema, data);
    if (!this.validate.Check(data)) {
      throw new Error([...this.validate.Errors(data)].map(e => e.message).join(', '));
    }
    this.configData = data as T;
    try {
      const temporary = `${configPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.configData, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, configPath);
      if (this.shared) fs.chmodSync(configPath, 0o600);
    } catch (e: unknown) {
      this.handleError(e, `保存配置文件 ${configPath} 时发生错误:`);
    }
  }

  private handleError (e: unknown, message: string): void {
    if (e instanceof SyntaxError) {
      this.core.context.logger.logError('[Core] [Config] 操作配置文件格式错误，请检查配置文件:', e.message);
    } else {
      this.core.context.logger.logError(`[Core] [Config] ${message}:`, (e as Error).message);
    }
  }
}
