import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createServer } from '../server/index.js';
import { RoomManager } from '../server/rooms.js';

class TestClient {
  constructor(url, options = {}) {
    this.socket = new WebSocket(url, options);
    this.messages = [];
    this.events = new EventEmitter();
    this.sequence = 0;
    this.prefix = randomUUID();
    this.socket.on('error', () => {});
    this.socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      this.messages.push(message);
      if (message.type === 'STATE') this.state = message.payload;
      if (message.type === 'SESSION') this.session = message.payload;
      this.events.emit('message', message);
    });
  }
  async open() { await once(this.socket, 'open'); return this; }
  wait(type, predicate = () => true, after = 0) {
    const match = this.messages.slice(after).find(m => m.type === type && predicate(m.payload));
    if (match) return Promise.resolve(match.payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.events.off('message', handler); reject(new Error(`Timeout waiting for ${type}`)); }, 3000);
      const handler = message => {
        if (message.type === type && predicate(message.payload)) {
          clearTimeout(timer); this.events.off('message', handler); resolve(message.payload);
        }
      };
      this.events.on('message', handler);
    });
  }
  async command(type, payload = {}, requestId = `${this.prefix}-r${++this.sequence}`) {
    const after = this.messages.length;
    this.socket.send(JSON.stringify({ type, requestId, payload }));
    return this.wait('COMMAND_RESULT', result => result.requestId === requestId, after);
  }
  async currentState() { assert.equal((await this.command('GET_STATE')).ok, true); return this.state; }
}

async function setup(t, count) {
  // Integration simulations issue commands faster than human clicks. The
  // shipped server retains its 40-message burst / 20-per-second default.
  const app = await createServer({ rateBurst: 20_000, actionDelayMs: 0 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  t.after(() => app.close());
  const clients = [];
  for (let i = 0; i < count; i++) {
    const client = await new TestClient(`ws://127.0.0.1:${port}/ws`).open();
    assert.equal((await client.command('HELLO', { nickname: `玩家${i}` })).ok, true);
    clients.push(client);
  }
  return { app, clients, port };
}

test('HTTP serves only local assets, rejects wrong Host and foreign WebSocket Origin', async t => {
  const { port } = await setup(t, 0);
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /局域网牌桌/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/styles.css`)).status, 200);
  const sounds = await fetch(`http://127.0.0.1:${port}/sounds.js`);
  assert.equal(sounds.status, 200);
  assert.match(sounds.headers.get('content-type'), /javascript/);
  const voice = await fetch(`http://127.0.0.1:${port}/audio/uno.wav`);
  assert.equal(voice.status, 200);
  assert.equal(voice.headers.get('content-type'), 'audio/wav');
  const wave = Buffer.from(await voice.arrayBuffer());
  assert.equal(wave.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wave.toString('ascii', 8, 12), 'WAVE');
  assert.ok(wave.length > 1000);
  const victory = await fetch(`http://127.0.0.1:${port}/audio/victory.wav`);
  assert.equal(victory.status, 200);
  assert.equal(victory.headers.get('content-type'), 'audio/wav');
  const victoryWave = Buffer.from(await victory.arrayBuffer());
  assert.equal(victoryWave.toString('ascii', 0, 4), 'RIFF');
  assert.equal(victoryWave.toString('ascii', 8, 12), 'WAVE');
  assert.ok(victoryWave.length > 1000);
  assert.equal((await fetch(`http://127.0.0.1:${port}/server/game.js`)).status, 404);
  // Fetch may normalize/replace Host. Use raw HTTP to test a hostile header.
  const wrongHostStatus = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/', headers: { Host: 'foreign.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(wrongHostStatus, 403);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://foreign.example' });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /403/);
});

test('room permissions, capacity, private hands and request idempotency over real sockets', async t => {
  const { clients: [a, b, c] } = await setup(t, 3);
  assert.equal((await a.command('ROOM_CREATE', { maxPlayers: 2 })).ok, true);
  const code = (await a.currentState()).roomCode;
  assert.match(code, /^\d{4}$/);
  assert.equal((await b.command('ROOM_JOIN', { code })).ok, true);
  assert.equal((await b.command('ROOM_JOIN', { code })).ok, true);
  assert.equal((await c.command('ROOM_JOIN', { code })).code, 'ROOM_FULL');
  assert.equal((await b.command('GAME_START')).code, 'HOST_ONLY');
  assert.equal((await a.command('GAME_START', {}, 'start-once')).ok, true);
  const before = await a.currentState();
  assert.equal((await a.command('GAME_START', {}, 'start-once')).ok, true);
  const after = await a.currentState();
  assert.equal(before.game.id, after.game.id);
  const opponent = await b.currentState();
  assert.notDeepEqual(after.you.hand, opponent.you.hand);
  assert.equal(after.players.length, 2);
  assert.equal(after.game.id, opponent.game.id);
  for (const key of ['"hands"', '"drawPile"', 'handBeforePlay', 'resumeToken', 'wasLegal']) {
    assert.ok(!JSON.stringify(after).includes(key));
  }
  assert.equal((await a.command('ROOM_CLOSE', {}, 'start-once')).code, 'REQUEST_ID_REUSED');
});

test('disconnect pauses, resume restores cards, new tab replaces old socket, timeout aborts', async t => {
  const { app, port, clients: [a, b] } = await setup(t, 2);
  await a.command('ROOM_CREATE', { maxPlayers: 4 });
  const code = (await a.currentState()).roomCode;
  await b.command('ROOM_JOIN', { code });
  await a.command('GAME_START');
  const hand = (await b.currentState()).you.hand;
  const disconnected = once(b.socket, 'close'); b.socket.close(); await disconnected;
  await a.wait('STATE', s => s?.game?.paused);
  const b2 = await new TestClient(`ws://127.0.0.1:${port}/ws`).open();
  await b2.command('HELLO', { nickname: 'ignored', resumeToken: b.session.resumeToken });
  const restored = await b2.currentState();
  assert.deepEqual(restored.you.hand, hand);
  assert.equal(restored.game.paused, false);
  const b3 = await new TestClient(`ws://127.0.0.1:${port}/ws`).open();
  const replaced = once(b2.socket, 'close');
  await b3.command('HELLO', { resumeToken: b.session.resumeToken });
  await replaced;
  assert.equal((await b3.currentState()).players.find(p => p.id === b.session.playerId).online, true);
  const gone = once(b3.socket, 'close'); b3.socket.close(); await gone;
  await a.wait('STATE', s => s?.game?.paused, a.messages.length - 1);
  app.manager.sweep(Date.now() + 61_000);
  const waiting = await a.currentState();
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.game, null);
  assert.equal(waiting.players.length, 1);
  assert.match(waiting.info, /超时/);
});

test('a managing host plus 10 players receive isolated game snapshots', async t => {
  const { clients } = await setup(t, 11);
  await clients[0].command('ROOM_CREATE', { maxPlayers: 10, hostParticipates: false });
  const code = (await clients[0].currentState()).roomCode;
  for (const client of clients.slice(1)) assert.equal((await client.command('ROOM_JOIN', { code })).ok, true);
  await clients[0].command('GAME_START');
  const allHands = [];
  const states = await Promise.all(clients.map(client => client.currentState()));
  for (const state of states) {
    assert.equal(state.players.length, 11);
    assert.equal(state.participantCount, 10);
    allHands.push(...state.you.hand.map(card => card.id));
    assert.equal(state.game.id, states[0].game.id);
    assert.equal(state.revision, states[0].revision);
  }
  assert.deepEqual(states[0].you.hand, []);
  assert.equal(states[0].you.isParticipating, false);
  assert.equal(new Set(allHands).size, allHands.length);
});

test('a complete game with a nonplaying host runs over the protocol and returns to lobby', async t => {
  const { clients: [host, a, b] } = await setup(t, 3);
  await host.command('ROOM_CREATE', { maxPlayers: 2, hostParticipates: false });
  const code = (await host.currentState()).roomCode;
  await a.command('ROOM_JOIN', { code });
  await b.command('ROOM_JOIN', { code });
  await host.command('GAME_START');
  const byId = new Map([a, b].map(client => [client.session.playerId, client]));
  let snapshot = await a.currentState();
  for (let move = 0; move < 2500 && snapshot.status !== 'finished'; move++) {
    const active = byId.get(snapshot.game.currentPlayerId);
    const state = await active.currentState();
    const payload = { gameId: state.game.id, turnId: state.game.turnId };
    let type;
    if (state.actions.canChooseInitialColor) { type = 'CHOOSE_INITIAL_COLOR'; payload.color = 'blue'; }
    else if (state.actions.canRespondWild4) { type = 'ACCEPT_WILD4'; payload.pendingId = state.game.pendingWild4.id; }
    else if (state.actions.playableCardIds.length) {
      type = 'PLAY_CARD'; payload.cardId = state.actions.playableCardIds[0];
      payload.chosenColor = 'red'; payload.declareUno = true;
    } else type = 'DRAW_CARD';
    const result = await active.command(type, payload);
    assert.equal(result.ok, true, result.message);
    snapshot = await a.currentState();
  }
  assert.equal(snapshot.status, 'finished');
  assert.ok(snapshot.game.winnerId);
  assert.deepEqual((await host.currentState()).you.hand, []);
  await host.command('RETURN_TO_LOBBY');
  assert.equal((await b.currentState()).status, 'waiting');
  assert.equal((await host.currentState()).you.isParticipating, false);
});

test('malformed input returns an error while connection remains usable', async t => {
  const { clients: [a] } = await setup(t, 1);
  const after = a.messages.length;
  a.socket.send('{not json');
  assert.equal((await a.wait('COMMAND_RESULT', p => p.code === 'INVALID_JSON', after)).ok, false);
  assert.equal((await a.command('ROOM_CREATE', { maxPlayers: 11 })).code, 'INVALID_CAPACITY');
  assert.equal((await a.command('ROOM_CREATE', { maxPlayers: 4 })).ok, true);
});

class FakeSocket {
  readyState = 1; bufferedAmount = 0; messages = [];
  send(raw) { this.messages.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
}

test('host transfer, destruction and bounded cleanup keep membership consistent', () => {
  const manager = new RoomManager({ disconnectGrace: 10, sessionTtl: 100 });
  const a = new FakeSocket(); const b = new FakeSocket();
  manager.hello(a, { nickname: 'A' }); manager.hello(b, { nickname: 'B' });
  const pa = manager.players.get(a.playerId); const pb = manager.players.get(b.playerId);
  const room = manager.create(pa, 4); manager.join(pb, room.code);
  manager.disconnect(a, 1000);
  assert.equal(room.hostId, pb.id);
  manager.sweep(1011);
  assert.equal(pa.roomCode, null);
  assert.deepEqual(room.playerIds, [pb.id]);
  manager.execute(pb, { type: 'ROOM_CLOSE', payload: {} });
  assert.equal(pb.roomCode, null);
  assert.equal(manager.rooms.size, 0);
  manager.sweep(1101);
  assert.equal(manager.players.has(pa.id), false);
});

function managedRoom({ maxPlayers = 2, hostParticipates = false } = {}) {
  const manager = new RoomManager({ disconnectGrace: 10, sessionTtl: 1000, actionDelayMs: 0 });
  const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
  for (const [index, socket] of sockets.entries()) manager.hello(socket, { nickname: `成员${index}` });
  const [host, a, b] = sockets.map(socket => manager.players.get(socket.playerId));
  const room = manager.create(host, maxPlayers, hostParticipates);
  return { manager, sockets, host, a, b, room };
}

test('nonplaying host is excluded from capacity, minimum players, dealing and all game actions', () => {
  const { manager, host, a, b, room } = managedRoom();
  manager.join(a, room.code);
  assert.throws(() => manager.execute(host, { type: 'GAME_START', payload: {} }), { code: 'NEED_PLAYERS' });
  manager.join(b, room.code);
  manager.execute(host, { type: 'GAME_START', payload: {} });
  assert.deepEqual(room.game.seatOrder, [a.id, b.id]);
  assert.equal(room.game.hands[host.id], undefined);
  const view = manager.view(room, host);
  assert.equal(view.participantCount, 2);
  assert.deepEqual(view.you.hand, []);
  assert.equal(view.you.isParticipating, false);
  assert.deepEqual(view.actions.playableCardIds, []);
  for (const [name, value] of Object.entries(view.actions)) {
    if (name !== 'playableCardIds') assert.equal(value, false, name);
  }
  const before = structuredClone(room.game);
  for (const type of ['PLAY_CARD', 'DRAW_CARD', 'CALL_UNO',
    'ACCEPT_WILD4', 'CHALLENGE_WILD4', 'CHOOSE_INITIAL_COLOR']) {
    assert.throws(() => manager.execute(host, { type, payload: { gameId: room.game.id } }), { code: 'NOT_MEMBER' });
  }
  assert.deepEqual(room.game, before);
});

test('removed catch and pass commands cannot mutate a live room', async t => {
  const { clients: [a, b] } = await setup(t, 2);
  await a.command('ROOM_CREATE', { maxPlayers: 2 });
  await b.command('ROOM_JOIN', { code: (await a.currentState()).roomCode });
  await a.command('GAME_START');
  const before = await a.currentState();
  for (const type of ['CATCH_UNO', 'PASS_TURN']) {
    assert.equal((await a.command(type, { gameId: before.game.id })).code, 'UNKNOWN_EVENT');
  }
  const after = await a.currentState();
  assert.equal(after.revision, before.revision);
  assert.equal(after.game.eventSequence, before.game.eventSequence);
  assert.equal('canCatchUno' in after.actions, false);
  assert.equal('canPass' in after.actions, false);
});

test('host can switch participation in the lobby; full seats and invalid settings are atomic', () => {
  const { manager, host, a, b, room } = managedRoom({ hostParticipates: true });
  manager.join(a, room.code);
  manager.execute(host, { type: 'ROOM_UPDATE', payload: { hostParticipates: false } });
  manager.join(b, room.code);
  const before = structuredClone(room);
  assert.throws(() => manager.execute(host, { type: 'ROOM_UPDATE', payload: { hostParticipates: true } }), { code: 'TOO_MANY_PLAYERS' });
  assert.deepEqual(room, before);
  assert.throws(() => manager.execute(host, { type: 'ROOM_UPDATE', payload: { hostParticipates: 'false' } }), { code: 'INVALID_PARTICIPATION' });
  assert.deepEqual(room, before);
  manager.execute(host, { type: 'ROOM_UPDATE', payload: { maxPlayers: 3, hostParticipates: true } });
  assert.equal(manager.participants(room).length, 3);
  assert.equal(room.maxPlayers, 3);
  manager.execute(host, { type: 'GAME_START', payload: {} });
  assert.throws(() => manager.execute(host, { type: 'ROOM_UPDATE', payload: { hostParticipates: false } }), { code: 'GAME_STARTED' });
  assert.equal(room.game.seatOrder.length, 3);
});

test('only host can change participation; transferring host never changes seats implicitly', () => {
  const { manager, host, a, b, room } = managedRoom({ maxPlayers: 3 });
  manager.join(a, room.code); manager.join(b, room.code);
  assert.throws(() => manager.execute(a, { type: 'ROOM_UPDATE', payload: { hostParticipates: false } }), { code: 'HOST_ONLY' });
  manager.execute(host, { type: 'HOST_TRANSFER', payload: { targetPlayerId: a.id } });
  assert.equal(manager.view(room, host).you.isParticipating, false);
  assert.equal(manager.view(room, a).you.isParticipating, true);
  manager.execute(a, { type: 'GAME_START', payload: {} });
  const beforeSeats = [...room.game.seatOrder];
  manager.execute(a, { type: 'HOST_TRANSFER', payload: { targetPlayerId: host.id } });
  assert.deepEqual(room.game.seatOrder, beforeSeats);
  assert.equal(manager.view(room, host).you.isParticipating, false);
});

test('managing host disconnect, resume and timeout leave the live game running', () => {
  const { manager, sockets, host, a, b, room } = managedRoom();
  manager.join(a, room.code); manager.join(b, room.code);
  manager.execute(host, { type: 'GAME_START', payload: {} });
  const gameId = room.game.id;
  manager.disconnect(sockets[0], 1000);
  assert.equal(room.game.paused, false);
  const replacement = new FakeSocket();
  manager.hello(replacement, { resumeToken: host.token });
  assert.equal(manager.view(room, host).you.isParticipating, false);
  assert.equal(room.game.paused, false);
  manager.disconnect(replacement, 1001);
  manager.sweep(1012);
  assert.equal(room.game.id, gameId);
  assert.equal(room.game.paused, false);
  assert.equal(room.status, 'playing');
  assert.equal(host.roomCode, null);
  assert.equal(room.hostId, a.id);
  assert.deepEqual(room.game.seatOrder, [a.id, b.id]);
});

test('spectator reconnect cannot unpause a disconnected participant; spectator leave is harmless', () => {
  const { manager, sockets, host, a, b, room } = managedRoom();
  manager.join(a, room.code); manager.join(b, room.code);
  manager.execute(host, { type: 'GAME_START', payload: {} });
  const gameId = room.game.id;
  manager.disconnect(sockets[1], 1000);
  manager.disconnect(sockets[0], 1000);
  manager.hello(new FakeSocket(), { resumeToken: host.token });
  assert.equal(room.game.paused, true);
  manager.leave(host);
  assert.equal(room.game.id, gameId);
  assert.equal(room.game.paused, true);
  manager.hello(new FakeSocket(), { resumeToken: a.token });
  assert.equal(room.game.paused, false);
  manager.leave(a);
  assert.equal(room.status, 'waiting');
  assert.equal(room.game, null);
});
