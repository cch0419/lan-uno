import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../server/rooms.js';

function setup() {
  let now = 100000; const manager = new RoomManager({ now: () => now });
  const sockets = Array.from({ length: 4 }, () => ({ readyState: 1, bufferedAmount: 0, messages: [], send(raw) { this.messages.push(JSON.parse(raw)); }, close() {} }));
  sockets.forEach((s, i) => manager.hello(s, { nickname: `player${i}` }));
  const [a, b, observer, outside] = sockets.map(s => manager.players.get(s.playerId));
  const room = manager.create(observer, 3, false); manager.join(a, room.code); manager.join(b, room.code);
  manager.execute(observer, { type: 'GAME_START', payload: {} }); manager.create(outside, 2, true);
  sockets.forEach(s => { s.messages = []; });
  let sequence = 0;
  const command = (player, type, data = {}, requestId = `social-${++sequence}`) => {
    manager.handle(player.socket, { type, payload: { gameId: room.game?.id, ...data }, requestId });
    return player.socket.messages.filter(m => m.type === 'COMMAND_RESULT').at(-1)?.payload;
  };
  return { manager, room, a, b, observer, outside, sockets, command, setNow: n => { now = n; } };
}

test('room interactions are authenticated, bounded, isolated, idempotent and never advance game state', () => {
  const { room, a, b, observer, outside, command, sockets } = setup();
  const before = structuredClone(room.game), clock = structuredClone(room.turnClock), revision = room.revision;
  assert.equal(command(a, 'SOCIAL_EMOTE', { emote: 'egg', targetPlayerId: b.id }, 'egg-once').ok, true);
  assert.equal(command(a, 'SOCIAL_EMOTE', { emote: 'egg', targetPlayerId: b.id }, 'egg-once').ok, true);
  assert.equal(sockets[1].messages.filter(m => m.type === 'SOCIAL').length, 1);
  assert.equal(sockets[3].messages.some(m => m.type === 'SOCIAL'), false);
  assert.equal(command(outside, 'SOCIAL_TEXT', { text: 'outside' }).code, 'SOCIAL_STALE_GAME');
  assert.equal(command(b, 'SOCIAL_EMOTE', { emote: 'egg', targetPlayerId: outside.id }).code, 'INVALID_EMOTE_TARGET');
  assert.equal(command(b, 'SOCIAL_EMOTE', { emote: 'egg', targetPlayerId: b.id }).code, 'INVALID_EMOTE_TARGET');
  assert.equal(command(observer, 'SOCIAL_EMOTE', { emote: 'laugh', targetPlayerId: b.id }).ok, true);
  const reaction = sockets[0].messages.filter(m => m.type === 'SOCIAL').at(-1).payload;
  assert.equal(reaction.targetPlayerId, observer.id);
  assert.equal(command(a, 'SOCIAL_EMOTE', { emote: 'cry' }).code, 'SOCIAL_TOO_FAST');
  assert.equal(command(b, 'SOCIAL_TEXT', { text: '<script>hi</script>', nickname: 'forged' }).ok, true);
  assert.equal(command(b, 'SOCIAL_TEXT', { text: 'x'.repeat(161) }).code, 'INVALID_CHAT_TEXT');
  assert.equal(command(b, 'SOCIAL_TEXT', { text: '\u0000' }).code, 'INVALID_CHAT_TEXT');
  assert.deepEqual(room.game, before); assert.deepEqual(room.turnClock, clock); assert.equal(room.revision, revision);
  assert.equal(sockets.some(s => s.messages.some(m => m.type === 'STATE')), false);
});

test('caption sessions expire and close on disconnect and game abort', () => {
  const { manager, room, a, b, observer, command, setNow } = setup();
  const id = 'session-caption-1';
  assert.equal(command(a, 'SOCIAL_START', { mode: 'text', sessionId: id }).ok, true);
  assert.equal(command(a, 'SOCIAL_TEXT', { sessionId: 'stale-session', text: 'no' }).code, 'STALE_SOCIAL_SESSION');
  assert.equal(command(a, 'SOCIAL_TEXT', { sessionId: id, text: '你好' }).ok, true);
  assert.equal(manager.social.sessions.size, 0);
  setNow(101000); command(a, 'SOCIAL_START', { mode: 'text', sessionId: 'session-caption-2' });
  manager.disconnect(a.socket); assert.equal(manager.social.sessions.size, 0);
  command(b, 'SOCIAL_START', { mode: 'text', sessionId: 'session-caption-3' });
  setNow(120000); manager.sweep(); assert.equal(manager.social.sessions.size, 0);
  command(observer, 'SOCIAL_START', { mode: 'text', sessionId: 'session-caption-4' });
  manager.leave(b); assert.equal(room.game, null); assert.equal(manager.social.sessions.size, 0);
});
