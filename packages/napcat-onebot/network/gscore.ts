import { IOB11NetworkAdapter } from './adapter';
import { type PluginConfig } from '../config/config';
import { OB11NetworkReloadType, type OB11EmitEventContent } from './index';
import { type NapCatCore } from 'napcat-core';
import { type NapCatOneBot11Adapter } from '../index';
import { type ActionMap } from '../action';
import type { OneBotAction } from '../action/OneBotAction';
import { getGScoreRuntime, type GScoreRuntime } from '@/napcat-common/src/gscore/runtime';
import { fromGScoreMessages, GScoreLimits, type SendAction } from '@/napcat-common/src/gscore/protocol';
import { enrichGScoreMessage, type GScoreReadAction } from '@/napcat-common/src/gscore/enrichment';

/** Built-in GSUID Core adapter, independent of third-party plugin implementation. */
export class GScoreAdapter extends IOB11NetworkAdapter<PluginConfig> {
  private readonly runtime: GScoreRuntime;
  constructor (core: NapCatCore, context: NapCatOneBot11Adapter, actions: ActionMap) {
    super('console_gscore', { name: 'console_gscore', enable: true, messagePostFormat: 'array', reportSelfMessage: false, debug: false }, core, context, actions);
    this.runtime = getGScoreRuntime(core.context.pathWrapper.configPath);
  }

  override get isActive () { return this.isEnable && this.runtime.status().connected; }

  private async callAction (name: SendAction | GScoreReadAction, params: Record<string, unknown>): Promise<unknown> {
    // Every native read/send uses the existing OneBot schema-checked entrypoint.
    // No arbitrary remote action, raw _handle or user-provided API name is accepted.
    const action = this.actions.get(name) as OneBotAction<Record<string, unknown>, unknown> | undefined;
    if (!action) throw new Error('Unsupported GSCore action');
    const result = await action.handle(params, this.name, this.config);
    if (result.retcode !== 0) throw new Error('GSCore action failed');
    return result.data;
  }

  open () {
    this.isEnable = true;
    this.runtime.bind(this.core.selfInfo.uin, async (raw, isCurrent) => {
      if (!isCurrent()) return;
      if (Buffer.byteLength(raw) > GScoreLimits.payloadBytes) throw new Error('GSCore 消息超过限制');
      // Construct and validate the WHOLE plan before sending its first message.
      const requests = fromGScoreMessages(JSON.parse(raw), this.core.selfInfo.uin);
      for (const request of requests) {
        if (!isCurrent()) return;
        await this.callAction(request.action, request.params);
      }
    });
  }

  close () { this.isEnable = false; this.runtime.stop(); }
  reload () { return OB11NetworkReloadType.Normal; }

  async onEvent<T extends OB11EmitEventContent> (event: T): Promise<void> {
    if (!this.isActive) return;
    const lease = this.runtime.captureLease();
    try {
      const message = await enrichGScoreMessage(event, this.core.selfInfo.uin, (action, params) => this.callAction(action, params), {
        isCurrent: lease,
        onDiagnostic: detail => this.logger.logWarn('[GSCore] ' + detail),
      });
      if (message && lease() && this.isActive) this.runtime.send(message);
    } catch {
      // Avoid leaking quoted content, download URLs or QQ identifiers in errors.
      if (lease()) this.logger.logWarn('[GSCore] 消息上下文无效或超过安全限制，已跳过');
    }
  }
}
