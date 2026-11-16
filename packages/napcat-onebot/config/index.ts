import { ConfigBase } from 'napcat-core/helper/config-base';
import type { NapCatCore } from 'napcat-core';
import { OneBotConfig } from './config';
import { TSchema } from '@sinclair/typebox';

export * from './config';

export class OB11ConfigLoader extends ConfigBase<OneBotConfig> {
  constructor (core: NapCatCore, configPath: string, schema: TSchema) {
    // OneBot network settings are instance-wide: one config for every QQ account.
    super('onebot11', core, configPath, schema, true);
  }
}
