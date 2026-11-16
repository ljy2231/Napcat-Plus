import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { GScoreConnection } from '../napcat-common/src/gscore/connection';
import { defaultGScoreConfig } from '../napcat-common/src/gscore/config';

class Socket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  terminate () { this.readyState = 3; }
  ping () {}
  send (_data: unknown, callback?: (error?: Error) => void) { callback?.(); }
  open () { this.readyState = 1; this.emit('open'); }
}
const connections: GScoreConnection[] = [];
afterEach(() => { connections.forEach(c => c.stop()); connections.length = 0; vi.useRealTimers(); });

it('natural disconnect invalidates leases even before the next connection', async () => {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  const received: Array<() => boolean> = [];
  const c = new GScoreConnection({ ...defaultGScoreConfig, enabled: true, reconnectIntervalMs: 1000 }, 'test', async (_data, lease) => { received.push(lease); }, () => {
    const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket;
  });
  connections.push(c); c.start(); sockets[0]!.open();
  const inboundLease = c.captureLease();
  sockets[0]!.emit('message', Buffer.from('response'));
  await Promise.resolve(); await Promise.resolve();
  expect(received[0]!()).toBe(true);
  sockets[0]!.readyState = 3; sockets[0]!.emit('close');
  expect(inboundLease()).toBe(false); expect(received[0]!()).toBe(false);
  await vi.advanceTimersByTimeAsync(1000); sockets[1]!.open();
  expect(c.status().connected).toBe(true);
  expect(c.captureLease()()).toBe(true);
  expect(inboundLease()).toBe(false); expect(received[0]!()).toBe(false);
});

it('a delayed operation receives a lease that becomes invalid during reconfiguration', async () => {
  let resume!: () => void;
  const waiting = new Promise<void>(resolve => { resume = resolve; });
  const sockets: Socket[] = [];
  let sideEffects = 0;
  const config = { ...defaultGScoreConfig, enabled: true };
  const c = new GScoreConnection(config, 'test', async (_data, lease) => {
    await waiting;
    if (lease()) sideEffects++;
  }, () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; });
  connections.push(c); c.start(); sockets[0]!.open();
  sockets[0]!.emit('message', Buffer.from('old'));
  await Promise.resolve();
  c.update({ ...config, token: 'replacement-test-token' }); sockets[1]!.open();
  resume(); await waiting; await Promise.resolve();
  expect(sideEffects).toBe(0);
});

it('disabling or stopping invalidates current leases', () => {
  const sockets: Socket[] = [];
  const config = { ...defaultGScoreConfig, enabled: true };
  const c = new GScoreConnection(config, 'test', () => {}, () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; });
  connections.push(c); c.start(); sockets[0]!.open();
  const lease = c.captureLease(); c.stop(); expect(lease()).toBe(false);
  c.start(); sockets[1]!.open(); const second = c.captureLease();
  c.update({ ...config, enabled: false }); expect(second()).toBe(false);
});
