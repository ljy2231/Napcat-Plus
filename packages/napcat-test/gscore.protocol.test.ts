import { describe, expect, it, vi } from 'vitest';
import { basicInboundSegment, fromGScoreMessage, fromGScoreMessages, GScoreLimits, normalizeMedia, toGScoreMessage } from '../napcat-common/src/gscore/protocol';
import { enrichGScoreMessage, type GScoreReadCall } from '../napcat-common/src/gscore/enrichment';

const packet = (content: unknown, extra: Record<string, unknown> = {}) => ({ bot_id: 'onebot', bot_self_id: '789', target_type: 'group', target_id: '456', content, ...extra });
const event = (message: unknown[], extra: Record<string, unknown> = {}) => ({ post_type: 'message', message_type: 'group', self_id: 789, user_id: 123, group_id: 456, message_id: 42, sender: { role: 'member' }, message, ...extra });
const segment = (type: string, data: unknown) => ({ type, data });

describe('safe GSCore wire compatibility', () => {
  it.each(['https://example.com/a.png', 'link://https://example.com/a.png', 'base64://aGVsbG8=', 'aGVsbG8='])('accepts compatible media %s without a local file reference', input => {
    const expected = input.includes('https:') ? 'https://example.com/a.png' : 'base64://aGVsbG8=';
    for (const type of ['image', 'record', 'video']) {
      const action = fromGScoreMessage(packet([segment(type, input)]), '789');
      expect(action.params['message']).toEqual([{ type, data: { file: expected } }]);
    }
  });
  it.each(['link://file:///etc/passwd', 'file:///etc/passwd', '/etc/passwd', '../secret', './secret', 'C:\\Windows\\secret', '\\\\server\\secret', 'ftp://example.com/a', 'data:image/png;base64,aA==', 'https://user:password@example.com/a', 'a===', 'aG VsbG8=', 'https://example.com/\nfoo', 'link://aGVsbG8='])('rejects unsafe media %s', input => {
    expect(() => normalizeMedia(input)).toThrow();
  });
  it('accepts bare base64 file and strips link prefix with a safe file name', () => {
    expect(fromGScoreMessage(packet([segment('file', 'hello.txt|aGVsbG8=')]), '789')).toEqual({ action: 'upload_group_file', params: { group_id: '456', name: 'hello.txt', file: 'base64://aGVsbG8=' } });
    expect(fromGScoreMessage(packet([segment('file', 'hello.txt|link://https://example.com/a')], { target_type: 'direct', target_id: '123' }), '789')).toEqual({ action: 'upload_private_file', params: { user_id: '123', name: 'hello.txt', file: 'https://example.com/a' } });
  });
  it.each(['../bad.txt|aA==', 'C:\\bad.txt|aA==', 'bad.txt|file:///etc/passwd', 'bad\n.txt|aA==', '..|aA==', 'bad.txt|/root/x', 'bad.txt|https://u:p@example.com/x'])('rejects unsafe file %s', file => {
    expect(() => fromGScoreMessages(packet([segment('file', file)]), '789')).toThrow();
  });
  it('maps reply_id and markdown to safe OneBot message segments', () => {
    const result = fromGScoreMessage(packet([segment('reply_id', '-20'), segment('markdown', '**hello**'), segment('at', '123')]), '789');
    expect(result.params['message']).toEqual([{ type: 'reply', data: { id: '-20' } }, { type: 'text', data: { text: '**hello**' } }, { type: 'at', data: { qq: '123' } }]);
  });
  it('plans mixed text, forward, file and trailing text in the original order', () => {
    const input = packet([segment('text', 'before'), segment('node', [segment('text', 'node 1'), segment('node', [segment('image', 'aGVsbG8=')])]), segment('file', 'a.txt|aGVsbG8='), segment('text', 'after')]);
    const actions = fromGScoreMessages(input, '789');
    expect(actions.map(a => a.action)).toEqual(['send_group_msg', 'send_group_forward_msg', 'upload_group_file', 'send_group_msg']);
    expect((actions[1]!.params['messages'] as unknown[])).toHaveLength(2);
    expect(() => fromGScoreMessage(input, '789')).toThrow('多个动作');
  });
  it('rejects deeply nested, cyclic, oversized and excessive mixed actions', () => {
    let value: unknown = segment('text', 'end');
    for (let i = 0; i < 4; i++) value = segment('node', [value]);
    expect(() => fromGScoreMessages(packet([value]), '789')).toThrow('深度');
    const cycle: { type: string; data: unknown[]; } = { type: 'node', data: [] }; cycle.data.push(cycle);
    expect(() => fromGScoreMessages(packet([cycle]), '789')).toThrow();
    expect(() => fromGScoreMessages(packet(Array.from({ length: 101 }, () => segment('text', 'x'))), '789')).toThrow();
    expect(() => fromGScoreMessages(packet(Array.from({ length: 21 }, () => segment('file', 'x.txt|aA=='))), '789')).toThrow('20');
    expect(() => fromGScoreMessages(packet([segment('text', 'x'.repeat(GScoreLimits.textChars + 1))]), '789')).toThrow();
    expect(() => fromGScoreMessages(packet([segment('image', 'a'.repeat(GScoreLimits.payloadBytes))]), '789')).toThrow('16 MiB');
  });
  it('rejects cross-account, unsafe numeric identifiers, unsupported actions and controls', () => {
    const simple = [segment('text', 'x')];
    expect(() => fromGScoreMessages(packet(simple, { bot_self_id: '456' }), '789')).toThrow('账号');
    expect(() => fromGScoreMessages(packet(simple, { bot_self_id: 0 }), '789')).toThrow('账号');
    expect(() => fromGScoreMessages(packet(simple, { target_id: Number.MAX_SAFE_INTEGER + 1 }), '789')).toThrow();
    expect(() => fromGScoreMessages(packet(simple, { action: 'delete_msg' }), '789')).toThrow('任意 API');
    for (const type of ['excute_delete_message', 'excute_ban_user', 'meta-poke', 'buttons']) {
      expect(() => fromGScoreMessages(packet([segment(type, { message_id: 1 })]), '789')).toThrow('暂不支持');
    }
  });
  it('basic inbound mapper keeps reply ID separate and file name from data.file', () => {
    expect(basicInboundSegment(segment('reply', { id: 42 }))).toEqual([{ type: 'reply_id', data: '42' }, { type: 'reply', data: '' }]);
    expect(basicInboundSegment(segment('file', { file: 'real.txt', url: 'https://example.com/a' }))).toEqual([{ type: 'file', data: 'real.txt|https://example.com/a' }]);
    expect(toGScoreMessage(event([segment('text', { text: 'x' })], { self_id: 999 }), '789')).toBeUndefined();
    expect(toGScoreMessage({ post_type: 'notice', notice_type: 'group_increase' }, '789')).toBeUndefined();
  });
});

describe('inbound context enrichment', () => {
  it('fetches reply body and quoted media rather than using the ID as reply text', async () => {
    const read: GScoreReadCall = vi.fn(async () => ({ group_id: 456, message: [segment('text', { text: 'quoted body' }), segment('image', { url: 'https://example.com/a.png' }), segment('record', { url: 'https://example.com/a.mp3' })] }));
    const result = await enrichGScoreMessage(event([segment('text', { text: 'new' }), segment('reply', { id: '-42' })]), '789', read);
    expect(read).toHaveBeenCalledWith('get_msg', { message_id: '-42' });
    expect(result!.content).toEqual([segment('text', 'new'), segment('reply_id', '-42'), segment('reply', 'quoted body'), segment('image', 'https://example.com/a.png'), segment('record', 'https://example.com/a.mp3')]);
  });
  it('gets private file URL using file_id while retaining data.file filename', async () => {
    const read: GScoreReadCall = vi.fn(async () => ({ url: 'https://example.com/file' }));
    const result = await enrichGScoreMessage(event([segment('file', { file: 'report.json', file_id: 'uuid-a' })], { message_type: 'private', group_id: undefined }), '789', read);
    expect(read).toHaveBeenCalledWith('get_private_file_url', { user_id: '123', file_id: 'uuid-a' });
    expect(result!.content).toEqual([segment('file', 'report.json|https://example.com/file')]);
  });
  it('uses an existing URL without lookup and never falls back to the filename as an ID', async () => {
    const read = vi.fn(async () => ({}));
    const message = event([segment('file', { name: 'name.txt', file: 'other.txt', url: 'https://example.com/file' })], { message_type: 'private' });
    expect((await enrichGScoreMessage(message, '789', read))!.content[0]!.data).toBe('name.txt|https://example.com/file');
    expect(await enrichGScoreMessage(event([segment('file', { file: '../secret' })], { message_type: 'private' }), '789', read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
  it('reports unknown segments while keeping identified content', async () => {
    const diagnostic = vi.fn();
    const result = await enrichGScoreMessage(event([segment('text', { text: 'keep' }), segment('unknown', { data: 'not interpreted' })]), '789', async () => ({}), { onDiagnostic: diagnostic });
    expect(result!.content).toEqual([segment('text', 'keep')]);
    expect(diagnostic).toHaveBeenCalledWith('不支持的 QQ 消息段已跳过，已识别内容继续转发');
  });
  it('keeps reply_id on lookup failure, excludes unsafe media, and reports generic diagnostics', async () => {
    const diagnostic = vi.fn();
    const result = await enrichGScoreMessage(event([segment('reply', { id: '42' }), segment('image', { file: '/etc/passwd' })]), '789', async () => { throw new Error('SECRET_URL'); }, { onDiagnostic: diagnostic });
    expect(result!.content).toEqual([segment('reply_id', '42'), segment('reply', '')]);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('SECRET_URL');
  });
  it('rejects mismatched quoted group/account context', async () => {
    const quoted = event([segment('reply', { id: 42 })]);
    const result = await enrichGScoreMessage(quoted, '789', async () => ({ group_id: 999, message: [segment('text', { text: 'not this conversation' })] }));
    expect(result!.content).toEqual([segment('reply_id', '42'), segment('reply', '')]);
  });
  it('expands forward messages and inline nested nodes with bounded cycles', async () => {
    const read = vi.fn(async () => ({ messages: [{ type: 'node', data: { content: [segment('text', { text: 'forwarded' }), segment('forward', { id: 'res-a' })] } }] }));
    const result = await enrichGScoreMessage(event([segment('forward', { id: 'res-a' })]), '789', read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result!.content).toEqual([segment('node', [segment('text', 'forwarded'), segment('node', [segment('text', '[合并转发]')])])]);
  });
  it('enriches quoted forward payload without recursively fetching nested replies', async () => {
    const read: GScoreReadCall = vi.fn(async (action) => action === 'get_msg'
      ? { group_id: 456, message: [segment('forward', { id: 'forward' }), segment('reply', { id: '99' })] }
      : { messages: [{ content: [segment('image', { url: 'https://example.com/a' })] }] });
    const result = await enrichGScoreMessage(event([segment('reply', { id: '42' })]), '789', read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result!.content.some(item => item.type === 'node')).toBe(true);
  });
  it('bounds aggregate expansion and lookup calls', async () => {
    await expect(enrichGScoreMessage(event([segment('forward', { id: 'x' })]), '789', async () => ({ messages: Array.from({ length: 100 }, () => ({ content: [segment('text', { text: 'x' })] })) }))).rejects.toThrow('100');
    const read = vi.fn(async () => ({ url: 'https://example.com/a' }));
    await expect(enrichGScoreMessage(event(Array.from({ length: 17 }, (_, i) => segment('file', { file: `${i}.txt`, file_id: `id-${i}` })), { message_type: 'private' }), '789', read)).rejects.toThrow('16');
    expect(read).toHaveBeenCalledTimes(16);
  });
  it('times out read-only lookups and ignores stale results', async () => {
    vi.useFakeTimers();
    try {
      const operation = enrichGScoreMessage(event([segment('reply', { id: 42 })]), '789', () => new Promise(() => {}), { lookupTimeoutMs: 5 });
      await vi.advanceTimersByTimeAsync(6);
      expect((await operation)!.content).toEqual([segment('reply_id', '42'), segment('reply', '')]);
    } finally { vi.useRealTimers(); }
    let current = true;
    await expect(enrichGScoreMessage(event([segment('reply', { id: 42 })]), '789', async () => { current = false; return { message: [] }; }, { isCurrent: () => current })).rejects.toThrow('变更');
  });
});
