import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Type, type TSchema } from '@sinclair/typebox';
import { GScoreAdapter } from '../napcat-onebot/network/gscore';
import { OneBotAction } from '../napcat-onebot/action/OneBotAction';
import type { NapCatCore } from 'napcat-core';
import type { NapCatOneBot11Adapter } from '../napcat-onebot';
import type { ActionMap } from '../napcat-onebot/action';
import type { OB11EmitEventContent } from '../napcat-onebot/network';

const fixtureRuntime = vi.hoisted(() => ({
  receive: undefined as ((raw: string, current: () => boolean) => Promise<void>) | undefined,
  generation: 0,
  active: true,
  send: vi.fn(),
}));
vi.mock('../napcat-common/src/gscore/runtime', () => ({
  getGScoreRuntime: () => ({
    bind: (_self: string, callback: (raw: string, current: () => boolean) => Promise<void>) => { fixtureRuntime.receive = callback; },
    status: () => ({ connected: fixtureRuntime.active }),
    captureLease: () => { const generation = fixtureRuntime.generation; return () => fixtureRuntime.active && generation === fixtureRuntime.generation; },
    send: fixtureRuntime.send,
    stop: () => { fixtureRuntime.generation++; fixtureRuntime.active = false; },
  }),
}));
vi.mock('../napcat-onebot/network/index', () => ({ OB11NetworkReloadType: { Normal: 0 } }));
// Break the upstream OneBotAction <-> BasicStream initialization cycle while
// preserving the real OneBotAction.handle/check implementation under test.
vi.mock('../napcat-onebot/action/stream/StreamBasic', () => ({ StreamStatus: { Error: 'error' } }));

beforeEach(() => {
  fixtureRuntime.receive = undefined;
  fixtureRuntime.generation = 0;
  fixtureRuntime.active = true;
  fixtureRuntime.send.mockReset();
});

function setup () {
  const warnings = vi.fn();
  const core = { selfInfo: { uin: '789' }, context: { pathWrapper: { configPath: 'test-only' }, logger: { logWarn: warnings, logError: vi.fn() } } } as unknown as NapCatCore;
  const context = {} as NapCatOneBot11Adapter;
  const actions = new Map();
  const methods = new Map<string, ReturnType<typeof vi.fn>>();
  const handles = new Map<string, ReturnType<typeof vi.spyOn>>();
  const register = (name: string, schema: TSchema, implementation: (payload: Record<string, unknown>) => Promise<unknown>) => {
    const method = vi.fn(implementation);
    class CheckedAction extends OneBotAction<Record<string, unknown>, unknown> {
      override payloadSchema = schema;
      async _handle (payload: Record<string, unknown>) { return method(payload); }
    }
    const action = new CheckedAction(context, core);
    methods.set(name, method);
    handles.set(name, vi.spyOn(action, 'handle'));
    actions.set(name, action);
  };
  const sent: Array<{ action: string; payload: Record<string, unknown>; }> = [];
  for (const name of ['send_group_msg', 'send_private_msg', 'send_group_forward_msg', 'send_private_forward_msg', 'upload_group_file', 'upload_private_file']) {
    const group = name.includes('group');
    const fields: Record<string, TSchema> = name.startsWith('upload') ? { name: Type.String(), file: Type.String() } : name.includes('forward') ? { messages: Type.Array(Type.Unknown()) } : { message: Type.Array(Type.Unknown()) };
    register(name, Type.Object({ [group ? 'group_id' : 'user_id']: Type.String(), ...fields }), async payload => { sent.push({ action: name, payload }); return { message_id: 1 }; });
  }
  const adapter = new GScoreAdapter(core, context, actions as unknown as ActionMap);
  adapter.open();
  const receive = (packet: unknown) => {
    const generation = fixtureRuntime.generation;
    return fixtureRuntime.receive!(JSON.stringify(packet), () => fixtureRuntime.active && fixtureRuntime.generation === generation);
  };
  const onEvent = (message: unknown[], extra = {}) => adapter.onEvent({ post_type: 'message', message_type: 'group', self_id: 789, user_id: 123, group_id: 456, message_id: 1, sender: {}, message, ...extra } as unknown as OB11EmitEventContent);
  return { adapter, register, sent, methods, handles, receive, onEvent, warnings };
}
const packet = (content: unknown[], extra = {}) => ({ bot_id: 'onebot', bot_self_id: '789', target_type: 'group', target_id: '456', content, ...extra });
const message = (type: string, data: unknown) => ({ type, data });

describe('real GScoreAdapter protocol path with checked OneBot action stubs', () => {
  it('uses schema-checked get_msg and private file action results in outbound GS packet', async () => {
    const f = setup();
    f.register('get_msg', Type.Object({ message_id: Type.String() }), async () => ({ message: [message('text', { text: 'quoted text' }), message('image', { url: 'https://example.com/quoted.png' })] }));
    f.register('get_private_file_url', Type.Object({ file_id: Type.String(), user_id: Type.String() }), async () => ({ url: 'https://example.com/report' }));
    await f.onEvent([message('reply', { id: '-42' }), message('file', { file: 'report.txt', file_id: 'file-id' })], { message_type: 'private', group_id: undefined });
    expect(f.handles.get('get_msg')).toHaveBeenCalledWith({ message_id: '-42' }, 'console_gscore', f.adapter.config);
    expect(f.handles.get('get_private_file_url')).toHaveBeenCalledWith({ file_id: 'file-id', user_id: '123' }, 'console_gscore', f.adapter.config);
    expect(fixtureRuntime.send.mock.calls[0]![0].content).toEqual([message('reply_id', '-42'), message('reply', 'quoted text'), message('image', 'https://example.com/quoted.png'), message('file', 'report.txt|https://example.com/report')]);
  });
  it('does not bypass an action schema failure while enriching a quote', async () => {
    const f = setup();
    f.register('get_msg', Type.Object({ message_id: Type.Literal('only-allowed') }), async () => ({ message: [] }));
    await f.onEvent([message('reply', { id: '42' })]);
    expect(f.handles.get('get_msg')).toHaveBeenCalledOnce();
    expect(f.methods.get('get_msg')).not.toHaveBeenCalled();
    expect(fixtureRuntime.send.mock.calls[0]![0].content).toEqual([message('reply_id', '42'), message('reply', '')]);
  });
  it('sends mixed format replies through the allowlisted handle methods in order', async () => {
    const f = setup();
    await f.receive(packet([message('reply_id', '-42'), message('markdown', '**text**'), message('image', 'link://https://example.com/a.png'), message('node', [message('text', 'forwarded'), message('node', [message('image', 'aA==')])]), message('file', 'report.txt|aGVsbG8='), message('text', 'tail')]));
    expect(f.sent.map(s => s.action)).toEqual(['send_group_msg', 'send_group_forward_msg', 'upload_group_file', 'send_group_msg']);
    expect(f.sent[0]!.payload['message']).toEqual([{ type: 'reply', data: { id: '-42' } }, { type: 'text', data: { text: '**text**' } }, { type: 'image', data: { file: 'https://example.com/a.png' } }]);
    expect(f.sent[2]!.payload['file']).toBe('base64://aGVsbG8=');
    expect(f.handles.get('send_group_forward_msg')).toHaveBeenCalledOnce();
  });
  it('rejects unsafe or unsupported suffix before sending any prefix', async () => {
    const f = setup();
    for (const suffix of [message('file', 'x.txt|file:///etc/passwd'), message('excute_ban_user', { group_id: '456', user_id: '123', duration: 1 }), message('image', '../secret')]) {
      await expect(f.receive(packet([message('text', 'must not send'), suffix]))).rejects.toThrow();
    }
    await expect(f.receive(packet([message('text', 'no')], { bot_self_id: '999' }))).rejects.toThrow();
    expect(f.sent).toEqual([]);
  });
  it('allows only the six send action names and stops at a checked action failure', async () => {
    const f = setup();
    f.register('upload_group_file', Type.Object({ group_id: Type.Literal('never') }), async () => ({}));
    await expect(f.receive(packet([message('file', 'a.txt|aA=='), message('text', 'tail')]))).rejects.toThrow('action failed');
    expect(f.methods.get('upload_group_file')).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
  });
  it('stops the remainder of a multi-action reply after a connection epoch change', async () => {
    const f = setup();
    f.register('upload_group_file', Type.Object({ group_id: Type.String(), name: Type.String(), file: Type.String() }), async () => { fixtureRuntime.generation++; return {}; });
    await f.receive(packet([message('file', 'a.txt|aA=='), message('text', 'tail')]));
    expect(f.methods.get('upload_group_file')).toHaveBeenCalledOnce();
    expect(f.sent).toEqual([]);
  });
  it('does not forward enriched data to a new connection after a pending lookup', async () => {
    const f = setup();
    f.register('get_msg', Type.Object({ message_id: Type.String() }), async () => { fixtureRuntime.generation++; return { message: [message('text', { text: 'stale' })] }; });
    await f.onEvent([message('reply', { id: '42' })]);
    expect(fixtureRuntime.send).not.toHaveBeenCalled();
  });
  it('filters notice/meta and self events without lookups or send actions', async () => {
    const f = setup();
    await f.onEvent([message('reply', { id: '42' })], { user_id: 789 });
    await f.onEvent([], { post_type: 'notice', notice_type: 'group_increase' });
    expect(fixtureRuntime.send).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
  });
  it('bounds raw packets before JSON parsing and read expansion before forwarding', async () => {
    const f = setup();
    await expect(fixtureRuntime.receive!(' '.repeat(16 * 1024 * 1024 + 1), () => true)).rejects.toThrow('超过');
    f.register('get_forward_msg', Type.Object({ id: Type.String() }), async () => ({ messages: Array.from({ length: 100 }, () => ({ content: [message('text', { text: 'x' })] })) }));
    await f.onEvent([message('forward', { id: 'big' })]);
    expect(fixtureRuntime.send).not.toHaveBeenCalled();
    expect(f.warnings).toHaveBeenCalled();
  });
});
