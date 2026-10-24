import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';
import { createNetworkPolicy, parsePublicUrl } from '../server/network.js';
import { createServer } from '../server/index.js';
import { quickTunnelUrl, watchTunnel } from '../server/tunnel.js';
import { websocketUrl, invitation } from '../public/network-client.js';

const publicUrl = 'https://uno-test.trycloudflare.com';
const policy = options => createNetworkPolicy({ localHosts: ['localhost', '127.0.0.1'], publicUrl, ...options });
const request = (host, origin, address = '127.0.0.1', extra = {}) =>
  ({ headers: { host, origin, ...extra }, socket: { remoteAddress: address } });

test('public URL rejects non-HTTPS, credentials, paths and wildcard configuration', () => {
  assert.equal(parsePublicUrl(''), null);
  assert.equal(parsePublicUrl(`${publicUrl}/`), publicUrl);
  for (const value of ['http://uno.example', 'https://*.example.com', 'https://u:p@uno.example',
    'https://uno.example/path', 'https://uno.example/?x=1', 'https://uno.example/#x', 'https://localhost', 'not a url']) {
    assert.throws(() => parsePublicUrl(value), /UNO_PUBLIC_URL/);
  }
  assert.throws(() => policy({ extraHosts: '*.example.com' }), /UNO_ALLOWED_HOSTS/);
  assert.throws(() => policy({ extraHosts: 'https://example.com' }), /UNO_ALLOWED_HOSTS/);
});

test('public WebSocket origin is exact; untrusted forwarded headers cannot bypass it', () => {
  const network = policy();
  assert.equal(network.validOrigin(request('uno-test.trycloudflare.com', publicUrl)), true);
  for (const origin of [undefined, 'null', 'http://uno-test.trycloudflare.com', 'https://evil.example', `${publicUrl}/path`]) {
    assert.equal(network.validOrigin(request('uno-test.trycloudflare.com', origin)), false);
  }
  assert.equal(network.validHost(request('evil.example', publicUrl, '127.0.0.1', { 'x-forwarded-host': 'uno-test.trycloudflare.com' })), false);
  assert.equal(network.validOrigin(request('localhost:3000', 'https://evil.example', '127.0.0.1',
    { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'uno-test.trycloudflare.com' })), false);
  assert.equal(network.validHost(request('localhost/path', publicUrl)), false);
});

test('loopback proxy rewrite is explicit; LAN clients retain original same-origin rules', () => {
  const network = policy();
  assert.equal(network.validOrigin(request('localhost:3000', publicUrl)), true);
  assert.equal(network.validOrigin(request('localhost:3000', publicUrl, '192.168.1.2')), false);
  assert.equal(network.validOrigin(request('localhost:3000', 'http://localhost:3000')), true);
  assert.equal(network.validOrigin(request('localhost:3000', undefined)), true);
  assert.equal(network.validOrigin(request('localhost:3000', 'https://wrong.example')), false);
});

test('changing the live public URL revokes the old hostname without clearing rooms', async t => {
  const app = await createServer({ publicUrl, extraHosts: '' });
  t.after(() => app.close());
  const network = app.network;
  assert.equal(network.validHost(request('uno-test.trycloudflare.com')), true);
  network.configurePublicUrl('https://next-test.trycloudflare.com');
  assert.equal(network.validHost(request('uno-test.trycloudflare.com')), false);
  assert.equal(network.validHost(request('next-test.trycloudflare.com')), true);
  assert.equal(network.clientConfig().publicUrl, 'https://next-test.trycloudflare.com');
});

test('client uses WSS on HTTPS and never offers local/failed invitation links', () => {
  assert.equal(websocketUrl(publicUrl), 'wss://uno-test.trycloudflare.com/ws');
  assert.equal(websocketUrl('http://localhost:3000'), 'ws://localhost:3000/ws');
  assert.equal(invitation(null, 'http://localhost:3000').canCopy, false);
  assert.equal(invitation({ mode: 'internet', publicUrl, tunnelStatus: 'starting' }, 'http://localhost:3000').canCopy, false);
  assert.equal(invitation({ mode: 'internet', publicUrl, tunnelStatus: 'failed' }, publicUrl).address, '');
  assert.equal(invitation({ mode: 'internet', publicUrl, tunnelStatus: 'ready' }, 'http://localhost:3000').address, publicUrl);
});

test('tunnel logs support split chunks and publish only after a registered connection', () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = 0; child.kill = () => { killed++; };
  const network = policy({ publicUrl: '' });
  const messages = [];
  const watch = watchTunnel(child, network, { log: s => messages.push(s), warn: s => messages.push(s) });
  child.stderr.write('| https://uno-test.try');
  assert.equal(network.clientConfig().publicUrl, null);
  child.stderr.write('cloudflare.com |\n');
  assert.equal(network.clientConfig().publicUrl, publicUrl);
  assert.equal(network.clientConfig().tunnelStatus, 'starting');
  child.stderr.write('INF Registered tunnel connection connIndex=0\n');
  assert.equal(network.clientConfig().tunnelStatus, 'ready');
  assert.equal(messages.length, 1);
  watch.stop();
  child.emit('close', 0);
  assert.equal(killed, 1);
  assert.equal(network.clientConfig().tunnelStatus, 'stopped');
  assert.equal(messages.length, 1);
  // stdout/stderr can arrive in either order, including registration first.
  const reverseChild = new EventEmitter(); reverseChild.stdout = new PassThrough(); reverseChild.stderr = new PassThrough(); reverseChild.kill = () => {};
  const reverseNetwork = policy({ publicUrl: '' }); const notices = [];
  watchTunnel(reverseChild, reverseNetwork, { log: s => notices.push(s), warn() {} });
  reverseChild.stderr.write('INF Registered tunnel connection connIndex=0\n');
  reverseChild.stdout.write(`${publicUrl}\n`);
  assert.equal(reverseNetwork.clientConfig().tunnelStatus, 'ready');
  assert.equal(notices.length, 1);
  for (const line of ['https://evil.example', 'https://good.trycloudflare.com.evil', 'https://evil@uno.trycloudflare.com']) {
    assert.equal(quickTunnelUrl(line), null);
  }
});

test('unexpected tunnel termination disables invitations but leaves the Node service independent', () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  const network = policy();
  watchTunnel(child, network, { log() {}, warn() {} });
  child.emit('error', new Error('tool failed'));
  child.emit('close', 1);
  assert.equal(network.clientConfig().tunnelStatus, 'failed');
  assert.equal(network.validOrigin(request('localhost:3000', 'http://localhost:3000')), true);
  assert.equal(invitation(network.clientConfig(), publicUrl).canCopy, false);
});

async function get(port, host, path = '/') {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path, headers: { Host: host } }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    }).on('error', reject);
  });
}

test('real HTTP and WS accept the public proxy and localhost host in the same room', async t => {
  const app = await createServer({ publicUrl, extraHosts: '', actionDelayMs: 0 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const port = app.server.address().port;
  assert.equal((await get(port, 'uno-test.trycloudflare.com')).status, 200);
  assert.equal((await get(port, 'foreign.example')).status, 403);
  const config = await get(port, `localhost:${port}`, '/api/config');
  assert.equal(config.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(config.body), { mode: 'internet', publicUrl, tunnelStatus: 'configured' });
  const sockets = [];
  for (const [host, origin] of [[`localhost:${port}`, `http://localhost:${port}`], ['uno-test.trycloudflare.com', publicUrl]]) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Host: host }, origin });
    await once(socket, 'open'); sockets.push(socket);
  }
  let sequence = 0;
  const command = (socket, type, payload = {}) => new Promise((resolve, reject) => {
    const requestId = `network-${++sequence}`;
    const timer = setTimeout(() => { socket.off('message', handler); reject(new Error('Command timed out')); }, 3000);
    const handler = raw => {
      const message = JSON.parse(raw);
      if (message.type === 'COMMAND_RESULT' && message.payload.requestId === requestId) {
        clearTimeout(timer); socket.off('message', handler); resolve(message.payload);
      }
    };
    socket.on('message', handler); socket.send(JSON.stringify({ type, requestId, payload }));
  });
  for (const [i, socket] of sockets.entries()) assert.equal((await command(socket, 'HELLO', { nickname: `net${i}` })).ok, true);
  assert.equal((await command(sockets[0], 'ROOM_CREATE', { maxPlayers: 2 })).ok, true);
  const room = [...app.manager.rooms.values()][0];
  assert.equal((await command(sockets[1], 'ROOM_JOIN', { code: room.code })).ok, true);
  assert.equal((await command(sockets[0], 'GAME_START')).ok, true);
  assert.equal(room.game.seatOrder.length, 2);
  assert.notDeepEqual(room.game.hands[room.playerIds[0]], room.game.hands[room.playerIds[1]]);
  const bad = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Host: 'uno-test.trycloudflare.com' }, origin: 'https://foreign.example' });
  const [error] = await once(bad, 'error'); assert.match(error.message, /403/);
  const before = room.game.id;
  app.network.setTunnelStatus('failed');
  assert.equal((await command(sockets[0], 'GET_STATE')).ok, true);
  assert.equal(room.game.id, before);
});
