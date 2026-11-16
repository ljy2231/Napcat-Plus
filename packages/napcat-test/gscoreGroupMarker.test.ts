import { it, expect } from 'vitest';
import { fromGScoreMessages } from '../napcat-common/src/gscore/protocol';

const b64 = 'base64://' + 'A'.repeat(1004);
const base = {
  bot_id: 'onebot', bot_self_id: '789012345',
  target_type: 'group', target_id: '123456789', msg_id: '123', echo: null,
};

it('skips the trailing group marker GSCore appends to every group frame', () => {
  // Observed live: SayuCore sends image content followed by {"type":"group"}.
  const plan = fromGScoreMessages({ ...base, content: [{ type: 'image', data: b64 }, { type: 'group', data: '123456789' }] }, '789012345');
  expect(plan).toHaveLength(1);
  expect(plan[0]!.action).toBe('send_group_msg');
  expect((plan[0]!.params['message'] as unknown[])).toHaveLength(1);
});

it('skips other GSCore bookkeeping markers without failing the whole send', () => {
  const markers = ['group', 'image_size', 'buttons', 'template_buttons', 'template_markdown'];
  for (const type of markers) {
    const plan = fromGScoreMessages({ ...base, content: [{ type: 'text', data: 'hello' }, { type, data: 'x' }] }, '789012345');
    expect(plan[0]!.action).toBe('send_group_msg');
  }
});

it('a bare group marker alone produces an explicit empty-content error', () => {
  expect(() => fromGScoreMessages({ ...base, content: [{ type: 'group', data: '123456789' }] }, '789012345')).toThrow(/可发送内容/);
});

it('unknown textual extension degrades to text instead of dropping the frame', () => {
  const plan = fromGScoreMessages({ ...base, content: [{ type: 'custom_text_extension', data: 'visible' }, { type: 'group', data: '123456789' }] }, '789012345');
  expect((plan[0]!.params['message'] as Array<{ type: string; data: { text: string; }; }>)[0]!.data.text).toBe('visible');
});

it('non-text control actions still fail closed', () => {
  expect(() => fromGScoreMessages({ ...base, content: [{ type: 'excute_ban_user', data: { user_id: '1', duration: 60 } }] }, '789012345')).toThrow();
  expect(() => fromGScoreMessages({ ...base, action: 'set_group_ban' }, '789012345')).toThrow();
});

it('private frames keep the direct action while ignoring stray markers', () => {
  const plan = fromGScoreMessages({ ...base, target_type: 'direct', target_id: '123', content: [{ type: 'text', data: 'hi' }, { type: 'group', data: '' }] }, '789012345');
  expect(plan[0]!.action).toBe('send_private_msg');
  expect(plan[0]!.params['user_id']).toBe('123');
});
