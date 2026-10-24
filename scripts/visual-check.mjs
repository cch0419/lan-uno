// Local visual QA only. Not loaded by npm start and exposes no debug endpoint.
// Run: node scripts/visual-check.mjs, open http://localhost:3002, create a room,
// then type "table 6", "skip", "+2", "reverse", "wild", "+4" or "uno" here.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server/index.js';
import { buildDeck, createGame, applyCommand, assertGame } from '../server/game.js';

const app = await createServer();
app.server.listen(3002, '127.0.0.1', () => console.log('Visual QA: http://localhost:3002'));
let count = 6;
const names = ['阿青', '小林', '橙子', '星星', '南风', '阿月', '小熊', '山海', '晴天'];
const bots = [];
function prepare(kind) {
  const host = [...app.manager.players.values()].find(p => p.socket && !p.socket.isVisualBot);
  if (!host) { console.log('Open the page and create a room first.'); return; }
  if (host.roomCode) {
    const old = app.manager.rooms.get(host.roomCode);
    for (const id of old.playerIds) app.manager.players.get(id).roomCode = null;
    app.manager.rooms.delete(old.code);
  }
  const room = app.manager.create(host, count, true);
  while (bots.length < count - 1) {
    const socket = { isVisualBot: true, readyState: 1, bufferedAmount: 0, send() {}, close() {} };
    app.manager.hello(socket, { nickname: names[bots.length] });
    bots.push(app.manager.players.get(socket.playerId));
  }
  for (const bot of bots.slice(0, count - 1)) app.manager.join(bot, room.code);
  if (kind === 'lobby') { app.manager.publish(room); console.log(`Prepared lobby ${room.code}`); return; }
  const game = createGame(room.playerIds);
  game.rules.autoUno = kind !== 'catch';
  const pack = buildDeck();
  function take(kind, color = 'red', value) {
    const i = pack.findIndex(c => c.kind === kind && (c.color === color || color === null) && (value === undefined || c.value === value));
    if (i < 0) throw new Error('Invalid visual fixture');
    return pack.splice(i, 1)[0];
  }
  const hands = [take('skip'), take('draw2'), take('reverse'), take('wild', null), take('wild4', null), take('number', 'red', 1), take('number', 'blue', 9)];
  game.hands = Object.fromEntries(room.playerIds.map(id => [id, []]));
  const finish = kind === 'finish' || kind === 'final';
  game.hands[host.id] = finish ? [hands[5]] : kind === 'uno' ? hands.slice(-2) : hands;
  if (finish) pack.push(...hands.filter(c => c !== hands[5]));
  else if (kind === 'uno') pack.push(...hands.slice(0, -2));
  for (const id of room.playerIds.slice(1)) for (let i = 0; i < 7; i++) game.hands[id].push(pack.pop());
  game.discardPile = [take('number', 'red', 5)];
  if (kind === 'many') game.hands[host.id].push(...pack.splice(-17));
  game.drawPile = pack; game.activeColor = 'red'; game.currentPlayerId = host.id;
  game.phase = 'turn'; game.direction = 1; game.turnId = 1; game.eventSequence = 0;
  game.log = []; game.pendingWild4 = null; game.unoDeclaredIds = [];
  game.provisionalWinnerId = null; game.winnerId = null; game.endReason = null; game.dryPassPlayerIds = [];
  game.playerNames = Object.fromEntries(room.playerIds.map(id => [id, app.manager.players.get(id).nickname]));
  if (kind === 'final') {
    game.finishOrder = room.playerIds.slice(2);
    game.winnerId = game.finishOrder[0] ?? null;
    for (const id of game.finishOrder) { pack.push(...game.hands[id]); game.hands[id] = []; }
  }
  if (['skip', '+2', 'reverse', 'wild', '+4'].includes(kind)) {
    const wanted = { skip: 'skip', '+2': 'draw2', reverse: 'reverse', wild: 'wild', '+4': 'wild4' }[kind];
    const index = game.hands[host.id].findIndex(c => c.kind === wanted);
    game.hands[host.id].unshift(game.hands[host.id].splice(index, 1)[0]);
  }
  assertGame(game);
  room.game = game;
  if (kind === 'catch' || kind === 'respond') {
    const actor = room.playerIds[1];
    pack.push(...game.hands[actor]);
    game.hands[actor] = [take(kind === 'respond' ? 'wild4' : 'number', kind === 'respond' ? null : 'red', kind === 'respond' ? undefined : 1), take('number', 'red', 2)];
    game.currentPlayerId = actor;
    game.direction = -1;
    room.game = applyCommand(game, actor, { type: 'PLAY_CARD', payload: { gameId: game.id, turnId: game.turnId,
      cardId: game.hands[actor][0].id, chosenColor: 'blue' } }).game;
  }
  room.status = 'playing'; room.revision++;
  room.turnSeconds = kind === 'timeout' ? 15 : 120;
  app.manager.startClock(room);
  app.manager.publish(room);
  console.log(`Prepared ${count} seats (${kind}), room ${room.code}, game ${randomUUID().slice(0, 4)}.`);
}
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const [kind, size] = line.trim().split(/\s+/);
  try {
    if (kind === 'social') {
      // Synthetic activity only: this fixture never opens a real microphone.
      const host = [...app.manager.players.values()].find(p => p.socket && !p.socket.isVisualBot);
      const room = app.manager.roomFor(host);
      const actor = app.manager.players.get(room.playerIds[1]);
      const speaker = app.manager.players.get(room.playerIds[2]);
      app.manager.social.command(actor, 'SOCIAL_TEXT', { gameId: room.game.id, text: '好牌！下一轮看我的 😎' });
      app.manager.voice.handle(speaker, 'VOICE_JOIN', { roomCode: room.code, mic: true, listening: true });
      setTimeout(() => { if (app.manager.rooms.has(room.code)) app.manager.voice.leave(speaker.id); }, 4000);
      console.log('Synthetic speech bubble and speaking icon sent.'); return;
    }
    if (kind === 'table') count = Math.max(2, Math.min(10, Number(size) || 6));
    prepare(kind);
  } catch (error) { console.error(error); }
});
process.on('SIGINT', async () => { input.close(); await app.close(); });
