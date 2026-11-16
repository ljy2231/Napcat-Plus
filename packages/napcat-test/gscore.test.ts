import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { GScoreConnection } from '../napcat-common/src/gscore/connection';
import { defaultGScoreConfig, validateGScoreConfig, publicGScoreConfig, GScoreConfigStore } from '../napcat-common/src/gscore/config';
import { toGScoreMessage, fromGScoreMessage } from '../napcat-common/src/gscore/protocol';

class FakeSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  frames: unknown[] = [];
  terminate () { this.readyState = 3; }
  send (data: unknown, callback?: (error?: Error) => void) { this.frames.push(data); callback?.(); }
  ping () {}
  open () { this.readyState = 1; this.emit('open'); }
}
const connections: GScoreConnection[] = [];
afterEach(() => { connections.forEach(c => c.stop()); connections.length = 0; vi.useRealTimers(); });
function fixture () {
  const sockets: FakeSocket[] = []; const urls: string[] = []; const messages: string[] = [];
  const config = { ...defaultGScoreConfig, enabled: true, token: 'test-secret', maxReconnectAttempts: 2 };
  const connection = new GScoreConnection(config, 'test-bot', async data => { messages.push(data); }, url => {
    urls.push(url); const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket;
  });
  connections.push(connection);
  return { connection, sockets, urls, messages, config };
}

describe('GSCore socket generations', () => {
  it('rejects a late old close/error after hot reconnect', () => {
    const { connection, sockets } = fixture();
    connection.start(); const old = sockets[0]!; old.open();
    connection.reconnect(); const current = sockets[1]!; current.open();
    old.emit('close'); old.emit('error', new Error('token-must-never-leak'));
    expect(connection.status().connected).toBe(true);
    expect(connection.status().lastError).toBe('');
    expect(connection.send({ test: true })).toBe(true);
    expect(current.frames).toHaveLength(1);
  });
  it('drops a message already queued when the connection is replaced', async () => {
    const { connection, sockets, messages } = fixture();
    connection.start(); sockets[0]!.open();
    sockets[0]!.emit('message', Buffer.from('stale-microtask'));
    connection.reconnect();
    await Promise.resolve(); await Promise.resolve();
    expect(messages).toEqual([]);
  });
  it('constructs the protocol endpoint without exposing token in public status', () => {
    const { connection, urls } = fixture(); connection.start();
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/ws/test-bot'); expect(url.searchParams.get('token')).toBe('test-secret');
    expect(JSON.stringify(connection.status())).not.toContain('test-secret');
  });
  it('bounded retries and stop do not leave reconnect timers', async () => {
    vi.useFakeTimers(); const { connection, sockets } = fixture(); connection.start();
    sockets[0]!.emit('error', new Error('secret')); sockets[0]!.emit('close');
    expect(connection.status().state).toBe('retrying');
    await vi.advanceTimersByTimeAsync(5000); expect(sockets).toHaveLength(2);
    sockets[1]!.emit('close'); await vi.advanceTimersByTimeAsync(10000); expect(sockets).toHaveLength(3);
    sockets[2]!.emit('close'); expect(connection.status().state).toBe('error');
    await vi.advanceTimersByTimeAsync(600000); expect(sockets).toHaveLength(3);
    connection.reconnect(); connection.stop();
    await vi.advanceTimersByTimeAsync(600000); expect(sockets).toHaveLength(4);
  });
  it('disabled config does not connect and hot enable works', () => {
    const { connection, sockets, config } = fixture();
    connection.update({ ...config, enabled: false }); expect(sockets).toHaveLength(0);
    connection.update(config); expect(sockets).toHaveLength(1);
    sockets[0]!.open(); connection.update({ ...config, enabled: false });
    sockets[0]!.emit('close'); expect(connection.status().state).toBe('disabled');
  });
  it('ignores messages from stale sockets and bounds send queues', async () => {
    const { connection, sockets, messages } = fixture(); connection.start(); connection.reconnect();
    sockets[0]!.emit('message', Buffer.from('old'));
    sockets[1]!.open(); sockets[1]!.emit('message', Buffer.from('new'));
    await Promise.resolve(); await Promise.resolve();
    expect(messages).toEqual(['new']);
    sockets[1]!.bufferedAmount = 5 * 1024 * 1024;
    expect(connection.send({ foo: 'bar' })).toBe(false);
  });
});

describe('GSCore configuration', () => {
  it('preserves omitted token and explicitly clears an empty token', () => {
    const previous = { ...defaultGScoreConfig, token: 'secret' };
    expect(validateGScoreConfig({ enabled: true }, previous).token).toBe('secret');
    expect(validateGScoreConfig({ token: '' }, previous).token).toBe('');
    expect(publicGScoreConfig(previous)).not.toHaveProperty('token');
  });
  it.each(['http://host:8765', 'ws://user:pass@host:8765', 'ws://host:8765?token=secret', 'file:///tmp/foo'])('rejects unsupported or embedded credentials URL %s', url => {
    expect(() => validateGScoreConfig({ url })).toThrow();
  });
  it('rejects unbounded retry and bad timing values', () => {
    expect(() => validateGScoreConfig({ maxReconnectAttempts: 0 })).toThrow();
    expect(() => validateGScoreConfig({ reconnectIntervalMs: 1 })).toThrow();
    expect(() => validateGScoreConfig({ tokenConfigured: false })).toThrow();
  });
  it('stores private config and reloads it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gscore-test-'));
    try {
      const store = new GScoreConfigStore(directory); const config = { ...defaultGScoreConfig, token: 'test' };
      store.save(config); expect(store.load()).toEqual(config);
      expect(JSON.parse(readFileSync(join(directory, 'console-gscore.json'), 'utf8')).token).toBe('test');
      if (process.platform !== 'win32') expect(statSync(join(directory, 'console-gscore.json')).mode & 0o777).toBe(0o600);
    } finally { rmSync(directory, { recursive: true }); }
  });
});

describe('GSCore message mapping', () => {
  const event = { post_type: 'message', message_type: 'group', message_id: 1, user_id: 123, group_id: 456, sender: { role: 'admin' }, message: [{ type: 'text', data: { text: 'help' } }, { type: 'at', data: { qq: '789' } }] };
  it('maps group sender permission and messages', () => {
    const output = toGScoreMessage(event, '789');
    expect(output).toMatchObject({ bot_id: 'onebot', bot_self_id: '789', user_type: 'group', user_id: '123', group_id: '456', user_pm: 3, content: [{ type: 'text', data: 'help' }, { type: 'at', data: '789' }] });
  });
  it('filters self messages and non-message events', () => {
    expect(toGScoreMessage(event, '123')).toBeUndefined();
    expect(toGScoreMessage({ ...event, post_type: 'notice' }, '789')).toBeUndefined();
  });
  it('maps replies to the intended account and target', () => {
    expect(fromGScoreMessage({ bot_id: 'onebot', bot_self_id: '789', target_type: 'group', target_id: '456', content: [{ type: 'text', data: 'hello' }] }, '789')).toEqual({ action: 'send_group_msg', params: { group_id: '456', message: [{ type: 'text', data: { text: 'hello' } }] } });
  });
  it('rejects cross-account commands, arbitrary action and local file access', () => {
    const reply = { target_type: 'direct', target_id: '123', content: [{ type: 'image', data: 'file:///etc/passwd' }] };
    expect(() => fromGScoreMessage(reply, '789')).toThrow();
    expect(() => fromGScoreMessage({ ...reply, bot_self_id: '456' }, '789')).toThrow();
    expect(() => fromGScoreMessage({ action: 'delete_msg' }, '789')).toThrow();
  });
  it('supports bounded merged forward and remote files', () => {
    expect(fromGScoreMessage({ target_type: 'group', target_id: '456', content: [{ type: 'node', data: [{ type: 'text', data: 'hello' }] }] }, '789').action).toBe('send_group_forward_msg');
    expect(fromGScoreMessage({ target_type: 'direct', target_id: '123', content: [{ type: 'file', data: 'report.txt|https://example.com/report.txt' }] }, '789').action).toBe('upload_private_file');
  });
});
