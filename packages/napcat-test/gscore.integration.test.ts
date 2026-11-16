import { it, expect } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { once } from 'node:events';
import { GScoreConnection } from '../napcat-common/src/gscore/connection';
import { defaultGScoreConfig } from '../napcat-common/src/gscore/config';

it('performs real GSCore WebSocket handshake and bidirectional frames', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('No local port');
  const received: string[] = [];
  let complete!: () => void;
  const response = new Promise<void>(resolve => { complete = resolve; });
  const connection = new GScoreConnection({ ...defaultGScoreConfig, enabled: true, url: `ws://127.0.0.1:${address.port}`, token: 'local-test-token' }, 'test-self', async (data) => { received.push(data); complete(); });
  let peer: WebSocket | undefined;
  try {
    const accepting = once(server, 'connection');
    connection.start();
    const [socket, request] = await accepting;
    peer = socket;
    expect(request.url).toBe('/ws/test-self?token=local-test-token');
    // Wait for the client's open handler without a timer/poll loop.
    peer!.send(JSON.stringify({ target_type: 'direct', target_id: '123', content: [{ type: 'text', data: 'hello' }] }));
    await response;
    expect(connection.status().connected).toBe(true);
    expect(received).toHaveLength(1);
    const incoming = once(peer!, 'message');
    expect(connection.send({ bot_id: 'onebot', bot_self_id: 'test-self', content: [{ type: 'text', data: 'ping' }] })).toBe(true);
    const [frame] = await incoming;
    expect(JSON.parse(frame.toString()).content[0].data).toBe('ping');
  } finally {
    connection.stop();
    peer?.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10000);
