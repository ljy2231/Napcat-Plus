import { IOB11NetworkAdapter } from './adapter';
import { type PluginConfig } from '../config/config';
import { OB11NetworkReloadType, type OB11EmitEventContent } from './index';
import { type NapCatCore } from 'napcat-core';
import { type NapCatOneBot11Adapter } from '../index';
import { type ActionMap } from '../action';
import type { OneBotAction } from '../action/OneBotAction';
import { getGScoreRuntime, type GScoreRuntime } from '@/napcat-common/src/gscore/runtime';
import { fromGScoreMessage, toGScoreMessage } from '@/napcat-common/src/gscore/protocol';

/** Built-in GSUID Core adapter, independent of the third-party plugin ID/whitelist. */
export class GScoreAdapter extends IOB11NetworkAdapter<PluginConfig> {
  private readonly runtime: GScoreRuntime;
  constructor (core: NapCatCore, context: NapCatOneBot11Adapter, actions: ActionMap) {
    super('console_gscore', { name: 'console_gscore', enable: true, messagePostFormat: 'array', reportSelfMessage: false, debug: false }, core, context, actions);
    this.runtime = getGScoreRuntime(core.context.pathWrapper.configPath);
  }

  override get isActive () { return this.isEnable && this.runtime.status().connected; }

  open () {
    this.isEnable = true;
    this.runtime.bind(this.core.selfInfo.uin, async (raw) => {
      const request = fromGScoreMessage(JSON.parse(raw), this.core.selfInfo.uin);
      // The wire mapper emits only six allowlisted send actions; handle performs
      // each action's own TypeBox payload validation before touching QQ.
      const action = this.actions.get(request.action) as OneBotAction<Record<string, unknown>, unknown> | undefined;
      if (!action) throw new Error('Unsupported GSCore action');
      const result = await action.handle(request.params, this.name, this.config);
      if (result.retcode !== 0) throw new Error('GSCore send action failed');
    });
  }

  close () { this.isEnable = false; this.runtime.stop(); }
  reload () { return OB11NetworkReloadType.Normal; }

  async onEvent<T extends OB11EmitEventContent> (event: T): Promise<void> {
    const message = toGScoreMessage(event, this.core.selfInfo.uin);
    if (message) this.runtime.send(message);
  }
}
