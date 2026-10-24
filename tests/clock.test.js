import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../server/rooms.js';

// Inject time so deadline races and long disconnects need no real sleeping.
function setup() {
  let now = 100_000;
  const manager = new RoomManager({ now: () => now, disconnectGrace: 60_000 });
  const sockets = Array.from({ length: 4 }, () => ({ readyState: 1, bufferedAmount: 0, send() {}, close() {} }));
  sockets.forEach((socket, i) => manager.hello(socket, { nickname: `p${i}` }));
  const [host, ...players] = sockets.map(s => manager.players.get(s.playerId));
  const room = manager.create(host, 3, false, 15);
  players.forEach(p => manager.join(p, room.code));
  manager.execute(host, { type: 'GAME_START', payload: {} });
  // Normalize opening effects so this fixture exercises an ordinary turn.
  room.game.phase = 'turn'; room.game.activeColor = 'red';
  manager.startClock(room);
  const command = (type = 'DRAW_CARD', player = manager.players.get(room.game.currentPlayerId)) => manager.execute(player,
    { type, payload: { gameId: room.game.id, turnId: room.game.turnId } });
  return { manager, room, sockets, host, players, command, setNow: value => { now = value; } };
}

test('server clock allows settling time and handles exactly one draw at its deadline', () => {
  const { manager, room, command, setNow } = setup();
  assert.equal(room.turnClock.startsAt, 102_200);
  assert.equal(room.turnClock.deadlineAt, 117_200);
  assert.throws(() => command(), { code: 'ANIMATION_IN_PROGRESS' });
  const actor = room.game.currentPlayerId;
  const before = room.game.hands[actor].length;
  setNow(117_199); manager.sweep();
  assert.equal(room.game.hands[actor].length, before);
  setNow(117_200); manager.sweep(); manager.sweep();
  assert.equal(room.game.hands[actor].length, before + 1);
  assert.notEqual(room.game.currentPlayerId, actor);
  assert.equal(room.game.log.filter(e => e.kind === 'timeout').length, 1);
  assert.equal(room.turnClock.startsAt, 119_400);
});

test('a command arriving at the deadline cannot play before automatic timeout', () => {
  const { room, command, setNow } = setup();
  const actor = room.game.currentPlayerId;
  setNow(room.turnClock.deadlineAt);
  assert.throws(() => command(), { code: 'TURN_TIMED_OUT' });
  assert.notEqual(room.game.currentPlayerId, actor);
  assert.equal(room.game.log.filter(e => e.kind === 'drawn').length, 1);
});

test('disconnect freezes remaining time; reconnect restores it; spectator never pauses', () => {
  const { manager, room, sockets, players, host, setNow } = setup();
  setNow(107_200); manager.disconnect(sockets[1]);
  assert.equal(room.turnClock.remainingMs, 10_000);
  assert.equal(room.turnClock.paused, true);
  setNow(120_000); manager.sweep();
  assert.equal(room.game.log.length, 0);
  manager.hello({ readyState: 1, bufferedAmount: 0, send() {}, close() {} }, { resumeToken: players[0].token });
  assert.equal(room.turnClock.deadlineAt, 132_200);
  manager.disconnect(sockets[0]);
  assert.equal(room.game.paused, false);
  manager.leave(host);
  assert.equal(room.status, 'playing');
});

test('finished players may disconnect and leave without interrupting remaining players', () => {
  const { manager, room, sockets, players } = setup();
  const [finished, next] = players;
  room.game.drawPile.push(...room.game.hands[finished.id]);
  room.game.hands[finished.id] = [];
  room.game.finishOrder = [finished.id]; room.game.currentPlayerId = next.id;
  manager.disconnect(sockets[1]);
  assert.equal(room.game.paused, false);
  manager.leave(finished);
  assert.equal(room.status, 'playing');
  manager.players.delete(finished.id);
  const seat = manager.view(room, next).players.find(p => p.id === finished.id);
  assert.equal(seat.nickname, finished.nickname);
  assert.equal(seat.rank, 1);
  assert.equal(seat.online, false);
});

test('host timer setting validation is atomic and unavailable after starting', () => {
  const { manager, room, host } = setup();
  assert.throws(() => manager.execute(host, { type: 'ROOM_UPDATE', payload: { turnSeconds: 30 } }), { code: 'GAME_STARTED' });
  room.status = 'waiting'; room.game = null;
  for (const turnSeconds of [0, 14, 121, 15.5, '45']) {
    assert.throws(() => manager.execute(host, { type: 'ROOM_UPDATE', payload: { turnSeconds } }), { code: 'INVALID_TURN_SECONDS' });
    assert.equal(room.turnSeconds, 15);
  }
  manager.execute(host, { type: 'ROOM_UPDATE', payload: { turnSeconds: 60 } });
  assert.equal(room.turnSeconds, 60);
});

test('personal time overrides default for each turn and rules are host-only and frozen during play', () => {
  const { manager, room, host, players, command, setNow } = setup();
  room.status = 'waiting'; room.game = null;
  const nextSettings = { turnSeconds: 45, turnSecondsByPlayer: { [players[0].id]: 90 },
    rules: { initialCards: 5, catchUno: true, challengeWild4: true, allowActionMatch: true } };
  assert.throws(() => manager.execute(players[0], { type: 'ROOM_UPDATE', payload: nextSettings }), { code: 'HOST_ONLY' });
  manager.execute(host, { type: 'ROOM_UPDATE', payload: nextSettings });
  const before = structuredClone(room);
  assert.throws(() => manager.execute(host, { type: 'ROOM_UPDATE', payload: { rules: { initialCards: 99 }, turnSeconds: 30 } }), { code: 'INVALID_INITIAL_CARDS' });
  assert.deepEqual(structuredClone(room), before);
  assert.throws(() => manager.execute(host, { type: 'ROOM_UPDATE', payload: { turnSecondsByPlayer: { stranger: 60 } } }), { code: 'INVALID_PLAYER_TIMES' });
  assert.deepEqual(structuredClone(room), before);
  manager.execute(host, { type: 'GAME_START', payload: {} });
  assert.equal(room.game.rules.initialCards, 5);
  room.game.phase = 'turn'; room.game.currentPlayerId = players[0].id;
  manager.startClock(room);
  assert.equal(room.turnClock.durationMs, 90000);
  setNow(room.turnClock.startsAt); command();
  assert.equal(room.turnClock.durationMs, 45000);
  assert.throws(() => manager.execute(host, { type: 'ROOM_UPDATE', payload: nextSettings }), { code: 'GAME_STARTED' });
});
