import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeck, createGame, applyCommand, applyTurnTimeout, assertGame, gameView, matches, drawCards } from '../server/game.js';

function fixture(hands, top = 'red:5', extra = {}) {
  const pack = buildDeck();
  function take(spec) {
    const [color, value] = spec.split(':');
    const kind = value === undefined ? color : /^\d+$/.test(value) ? 'number' : value;
    const i = pack.findIndex(c => c.kind === kind && (value === undefined || c.color === color) && (kind !== 'number' || c.value === Number(value)));
    assert.notEqual(i, -1, `Missing fixture card ${spec}`);
    return pack.splice(i, 1)[0];
  }
  const ids = Object.keys(hands);
  const game = createGame(ids);
  game.hands = Object.fromEntries(Object.entries(hands).map(([id, cards]) => [id, cards.map(take)]));
  game.discardPile = [take(top)];
  game.drawPile = pack;
  Object.assign(game, { currentPlayerId: ids[0], direction: 1, turnId: 10,
    phase: 'turn', paused: false, activeColor: game.discardPile[0].color,
    unoDeclaredIds: [], pendingWild4: null, eventSequence: 0,
    provisionalWinnerId: null, winnerId: null, endReason: null,
    dryPassPlayerIds: [], log: [] }, extra);
  assertGame(game);
  return game;
}

function act(game, type, data = {}, actor = game.currentPlayerId) {
  return applyCommand(game, actor, { type, payload: { gameId: game.id, turnId: game.turnId, ...data } });
}
function play(game, index = 0, extra = {}, actor = game.currentPlayerId) {
  return act(game, 'PLAY_CARD', { cardId: game.hands[actor][index].id, ...extra }, actor);
}

test('108 unique cards with the classic distribution; deal to 2 through 10 players', () => {
  const deck = buildDeck();
  assert.equal(deck.length, 108);
  assert.equal(new Set(deck.map(c => c.id)).size, 108);
  assert.equal(deck.filter(c => c.kind === 'number').length, 76);
  for (const color of ['red', 'yellow', 'green', 'blue']) {
    assert.equal(deck.filter(c => c.color === color && c.value === 0).length, 1);
    assert.equal(deck.filter(c => c.color === color).length, 25);
  }
  for (let n = 2; n <= 10; n++) {
    const game = createGame(Array.from({ length: n }, (_, i) => `${i}`));
    assertGame(game);
    for (const id of game.seatOrder) {
      assert.ok([7, 9].includes(game.hands[id].length)); // opening +2 is applied
    }
    assert.notEqual(game.discardPile[0].kind, 'wild4');
  }
});

test('numeric matching remains; colored action cards follow color, never just the symbol', () => {
  const g = fixture({ A: ['red:2', 'blue:5', 'green:9', 'wild'], B: ['blue:1'] });
  assert.deepEqual(g.hands.A.map(c => matches(g, c)), [true, true, false, true]);
  const actions = fixture({ A: ['blue:skip', 'green:reverse'], B: ['blue:1'] }, 'red:skip');
  assert.deepEqual(actions.hands.A.map(c => matches(actions, c)), [false, false]);
  for (const kind of ['reverse', 'skip', 'draw2']) {
    const g = fixture({ A: [`blue:${kind}`, `red:${kind}`, 'wild', 'wild4'], B: ['blue:1'] }, `red:${kind}`);
    assert.deepEqual(g.hands.A.map(c => matches(g, c)), [false, true, true, true]);
    assert.throws(() => play(g), { code: 'CARD_MISMATCH' });
    assert.ok(!gameView(g, 'A').actions.playableCardIds.includes(g.hands.A[0].id));
  }
});

test('invalid commands have no side effects, including UNO declarations', () => {
  const g = fixture({ A: ['green:9', 'red:2'], B: ['blue:1'], C: ['yellow:1'] });
  g.unoDeclaredIds = ['B'];
  const before = structuredClone(g);
  assert.throws(() => play(g), { code: 'CARD_MISMATCH' });
  assert.throws(() => act(g, 'DRAW_CARD', {}, 'B'), { code: 'NOT_YOUR_TURN' });
  assert.throws(() => act(g, 'PLAY_CARD', { cardId: 'fake' }), { code: 'CARD_NOT_OWNED' });
  assert.deepEqual(g, before);
});

test('wild requires a valid color before any mutation', () => {
  const g = fixture({ A: ['wild', 'red:1'], B: ['blue:1'] });
  assert.throws(() => play(g), { code: 'INVALID_COLOR' });
  const result = play(g, 0, { chosenColor: 'blue' }).game;
  assert.equal(result.activeColor, 'blue');
  assert.equal(result.currentPlayerId, 'B');
});

test('three-player reverse wraps in the new direction; skip bypasses next seat', () => {
  const g = fixture({ A: ['red:reverse', 'red:skip', 'red:1'], B: ['blue:1'], C: ['green:1'] });
  const reversed = play(g).game;
  assert.equal(reversed.direction, -1);
  assert.equal(reversed.currentPlayerId, 'C');
  const skipped = play(g, 1).game;
  assert.equal(skipped.currentPlayerId, 'C');
});

test('two-player reverse and skip both return play to actor with a new turnId', () => {
  for (const kind of ['reverse', 'skip']) {
    const g = fixture({ A: [`red:${kind}`, 'red:1'], B: ['blue:1'] });
    const next = play(g).game;
    assert.equal(next.currentPlayerId, 'A');
    assert.ok(next.turnId > g.turnId);
    assert.throws(() => act(next, 'DRAW_CARD', { turnId: g.turnId }), { code: 'STALE_TURN' });
  }
});

test('+2 draws two and skips recipient; final +2 settles before winner', () => {
  for (const n of [2, 3]) {
    const hands = { A: ['red:draw2'], B: ['blue:1'] };
    if (n === 3) hands.C = ['green:1'];
    const next = play(fixture(hands)).game;
    assert.equal(next.hands.B.length, 3);
    assert.equal(next.winnerId, 'A');
    assert.equal(next.phase, n === 2 ? 'finished' : 'turn');
    assert.deepEqual(next.finishOrder, ['A']);
    assertGame(next);
  }
});

test('drawing a playable card ends the turn; neither old nor drawn cards may be played', () => {
  const g = fixture({ A: ['red:1', 'red:2'], B: ['blue:1'] });
  const i = g.drawPile.findIndex(c => c.color === 'red' && c.value === 9);
  g.drawPile.push(g.drawPile.splice(i, 1)[0]);
  const drawn = act(g, 'DRAW_CARD').game;
  assert.equal(drawn.phase, 'turn');
  assert.equal(drawn.currentPlayerId, 'B');
  assert.equal(drawn.hands.A.length, 3);
  assert.throws(() => play(drawn, 0, {}, 'A'), { code: 'NOT_YOUR_TURN' });
  assert.throws(() => play(drawn, 2, {}, 'A'), { code: 'NOT_YOUR_TURN' });
  assert.throws(() => act(drawn, 'DRAW_CARD', {}, 'A'), { code: 'NOT_YOUR_TURN' });
  assert.deepEqual(gameView(drawn, 'A').actions.playableCardIds, []);
  assert.equal('canPass' in gameView(drawn, 'B').actions, false);
});

test('unplayable draw advances identically; passing is not a supported command', () => {
  const g = fixture({ A: ['red:1'], B: ['blue:1'] });
  const i = g.drawPile.findIndex(c => c.color === 'green' && c.value === 9);
  g.drawPile.push(g.drawPile.splice(i, 1)[0]);
  assert.throws(() => act(g, 'PASS_TURN'), { code: 'UNKNOWN_EVENT' });
  const next = act(g, 'DRAW_CARD').game;
  assert.equal(next.currentPlayerId, 'B');
  assert.equal(next.hands.A.length, 2);
});

test('UNO on play is atomic; omitted UNO has no penalty and catch is unsupported', () => {
  const g = fixture({ A: ['red:1', 'blue:2'], B: ['blue:1'], C: ['green:1'] });
  const called = play(g, 0, { declareUno: true }).game;
  assert.deepEqual(called.unoDeclaredIds, ['A']);
  assert.equal(called.log.at(-1).kind, 'uno');
  const missed = play(g).game;
  assert.deepEqual(missed.unoDeclaredIds, []);
  assert.equal(missed.hands.A.length, 1);
  assert.equal('unoWindow' in missed, false);
  assert.throws(() => act(missed, 'CATCH_UNO'), { code: 'UNKNOWN_EVENT' });
  assert.equal(missed.hands.A.length, 1);
});

test('UNO can be announced once with one card; drawing resets the declaration', () => {
  const missed = play(fixture({ A: ['red:1', 'blue:2'], B: ['red:3', 'green:1'] })).game;
  const declared = act(missed, 'CALL_UNO', {}, 'A').game;
  assert.deepEqual(declared.unoDeclaredIds, ['A']);
  assert.throws(() => act(declared, 'CALL_UNO', {}, 'A'), { code: 'UNO_ALREADY_CALLED' });
  assert.throws(() => act(declared, 'CALL_UNO', {}, 'B'), { code: 'INVALID_UNO' });
  const one = fixture({ A: ['red:1'], B: ['blue:1'] }, 'red:5', { unoDeclaredIds: ['A'] });
  assert.deepEqual(act(one, 'DRAW_CARD').game.unoDeclaredIds, []);
});

test('+4 bluff is accepted; challenge success penalizes actor and preserves target turn', () => {
  const g = fixture({ A: ['wild4', 'red:1', 'blue:5'], B: ['green:1'], C: ['yellow:1'] });
  const pending = play(g, 0, { chosenColor: 'blue' }).game;
  assert.equal(pending.pendingWild4.wasLegal, false);
  assert.equal(pending.phase, 'wild4_response');
  assert.throws(() => act(pending, 'DRAW_CARD'), { code: 'WRONG_PHASE' });
  const result = act(pending, 'CHALLENGE_WILD4', { pendingId: pending.pendingWild4.id });
  assert.equal(result.game.currentPlayerId, 'B');
  assert.equal(result.game.hands.A.length, 6);
  assert.equal(result.game.hands.B.length, 1);
  assert.equal(result.game.activeColor, 'blue');
  assert.deepEqual(result.evidence.handBeforePlay, g.hands.A);
});

test('+4 with matching number but different color is legal; failed challenge draws six', () => {
  const pending = play(fixture({ A: ['wild4', 'blue:5'], B: ['green:1'], C: ['yellow:1'] }), 0, { chosenColor: 'green' }).game;
  assert.equal(pending.pendingWild4.wasLegal, true);
  const result = act(pending, 'CHALLENGE_WILD4', { pendingId: pending.pendingWild4.id });
  assert.equal(result.game.hands.B.length, 7);
  assert.equal(result.game.currentPlayerId, 'C');
});

test('last +4 delays winner, acceptance draws four; stale response cannot run again', () => {
  const pending = play(fixture({ A: ['wild4'], B: ['blue:1'] }), 0, { chosenColor: 'green' }).game;
  assert.equal(pending.winnerId, null);
  assert.equal(pending.provisionalWinnerId, 'A');
  const result = act(pending, 'ACCEPT_WILD4', { pendingId: pending.pendingWild4.id }).game;
  assert.equal(result.winnerId, 'A');
  assert.equal(result.hands.B.length, 5);
  assert.throws(() => act(result, 'ACCEPT_WILD4', { pendingId: pending.pendingWild4.id }), { code: 'GAME_FINISHED' });
});

test('+4 evidence stays private and unchanged while actor announces UNO', () => {
  const original = fixture({ A: ['wild4', 'red:1'], B: ['blue:1'], C: ['green:1'] });
  const pending = play(original, 0, { chosenColor: 'blue' }).game;
  const declared = act(pending, 'CALL_UNO', {}, 'A').game;
  assert.equal(declared.hands.A.length, 1);
  const result = act(declared, 'CHALLENGE_WILD4', { pendingId: declared.pendingWild4.id });
  assert.deepEqual(result.evidence.handBeforePlay, original.hands.A);
  assert.equal(result.game.hands.A.length, 5);
});

test('discard recycling keeps top card and conserves the pack', () => {
  const game = fixture({ A: ['red:1'], B: ['blue:1'] });
  const top = game.discardPile[0];
  game.discardPile = [...game.drawPile, top]; game.drawPile = [];
  assert.equal(drawCards(game, 'A', 6), 6);
  assert.deepEqual(game.discardPile, [top]);
  assertGame(game);
});

test('exhausted pack skips a dry turn without prematurely ending the match', () => {
  const game = fixture({ A: ['red:1'], B: ['blue:1'] });
  game.hands.B.push(...game.drawPile); game.drawPile = [];
  const first = act(game, 'DRAW_CARD').game;
  const next = act(first, 'DRAW_CARD').game;
  assert.equal(next.phase, 'turn');
  assert.equal(next.endReason, null);
  assert.equal(next.winnerId, null);
  assertGame(next);
});

test('paused and stale-game commands are rejected', () => {
  const g = fixture({ A: ['red:1'], B: ['blue:1'] });
  assert.throws(() => act(g, 'DRAW_CARD', { gameId: 'old' }), { code: 'STALE_GAME' });
  g.paused = true;
  assert.throws(() => act(g, 'DRAW_CARD'), { code: 'PAUSED' });
});

test('private projection excludes opponents, deck order and +4 verdict', () => {
  const pending = play(fixture({ A: ['wild4', 'red:1'], B: ['blue:1'] }), 0, { chosenColor: 'blue' }).game;
  const view = gameView(pending, 'B');
  assert.deepEqual(view.hand, pending.hands.B);
  const text = JSON.stringify(view);
  for (const key of ['wasLegal', 'handBeforePlay', 'drawPile"', '"hands"']) assert.ok(!text.includes(key));
  assert.equal(view.game.pendingWild4.actorId, 'A');
});

test('simulated complete 2/3/10-player games preserve all invariants through actions', () => {
  for (const count of [2, 3, 10]) {
    for (let run = 0; run < 5; run++) {
      let game = createGame(Array.from({ length: count }, (_, i) => `p${i}`));
      let moves = 0;
      while (game.phase !== 'finished' && moves++ < 3000) {
        const actor = game.currentPlayerId;
        if (game.phase === 'choose_initial_color') game = act(game, 'CHOOSE_INITIAL_COLOR', { color: 'blue' }).game;
        else if (game.phase === 'wild4_response') game = act(game, run % 2 ? 'CHALLENGE_WILD4' : 'ACCEPT_WILD4', { pendingId: game.pendingWild4.id }).game;
        else {
          const { actions } = gameView(game, actor);
          if (actions.playableCardIds.length) {
            game = act(game, 'PLAY_CARD', { cardId: actions.playableCardIds[0], chosenColor: 'red', declareUno: true }).game;
          } else game = act(game, 'DRAW_CARD').game;
        }
        assertGame(game);
      }
      assert.equal(game.phase, 'finished', `Game stalled after ${moves} moves`);
    }
  }
});

test('players finish in sequence; completed seats are skipped until only one remains', () => {
  let game = fixture({ A: ['red:1'], B: ['red:2'], C: ['red:3'], D: ['blue:1'] });
  for (const [index, actor] of ['A', 'B', 'C'].entries()) {
    assert.equal(game.currentPlayerId, actor);
    game = play(game).game;
    assert.equal(game.finishOrder.length, index + 1);
    assert.equal(game.phase, index === 2 ? 'finished' : 'turn');
    if (index < 2) assert.throws(() => act(game, 'DRAW_CARD', {}, actor), { code: 'PLAYER_FINISHED' });
  }
  assert.deepEqual(game.ranking.map(r => r.playerId), ['A', 'B', 'C', 'D']);
  assert.equal(game.lastPlayerId, 'D');
  assert.equal(game.ranking[3].remainingCards, 1);
  assertGame(game);
});

test('reverse and skip follow active players after earlier finishers leave rotation', () => {
  for (const kind of ['reverse', 'skip', 'draw2']) {
    let game = fixture({ A: [], B: [`red:${kind}`, 'red:1'], C: ['red:3'] }, 'red:5', { finishOrder: ['A'], currentPlayerId: 'B' });
    game = play(game).game;
    assert.equal(game.currentPlayerId, 'B');
    assert.equal(game.phase, 'turn');
    game = play(game).game;
    assert.equal(game.phase, 'finished');
    assert.deepEqual(game.ranking.map(r => r.playerId), ['A', 'B', 'C']);
  }
});

test('last +4 records rank only after response and continues a three-player match', () => {
  const pending = play(fixture({ A: ['wild4'], B: ['green:1'], C: ['green:2'] }), 0, { chosenColor: 'green' }).game;
  assert.deepEqual(pending.finishOrder, []);
  const settled = applyTurnTimeout(pending).game;
  assert.deepEqual(settled.finishOrder, ['A']);
  assert.equal(settled.phase, 'turn');
  assert.equal(settled.currentPlayerId, 'C');
  assert.equal(settled.hands.B.length, 5);
  assert.equal(settled.log.filter(e => e.kind === 'timeout').length, 1);
});

test('timeout draws once and advances; initial wild timeout also chooses a valid color', () => {
  const original = fixture({ A: ['red:1'], B: ['blue:1'], C: ['green:1'] });
  const next = applyTurnTimeout(original);
  assert.equal(next.game.hands.A.length, 2);
  assert.equal(next.game.currentPlayerId, 'B');
  assert.deepEqual(next.events.map(e => e.kind), ['timeout', 'drawn']);
  const initial = fixture({ A: ['blue:1', 'blue:2'], B: ['red:1'] }, 'wild', { phase: 'choose_initial_color' });
  const result = applyTurnTimeout(initial);
  assert.equal(result.game.activeColor, 'blue');
  assert.equal(result.game.hands.A.length, 3);
  assert.equal(result.game.currentPlayerId, 'B');
  assert.deepEqual(result.events.map(e => e.sequence), [1, 2, 3]);
});

test('animation events have monotonic IDs and identify the true skipped/penalized seat', () => {
  const start = fixture({ A: ['red:skip', 'red:draw2', 'red:1'], B: ['blue:1'], C: ['green:1'] });
  const skipped = play(start);
  assert.equal(skipped.events.find(e => e.kind === 'skipped').targetId, 'B');
  assert.deepEqual(skipped.events.map(e => e.sequence), [1, 2]);
  assert.equal(skipped.game.eventSequence, 2);
  const penalty = play(start, 1);
  assert.equal(penalty.events.find(e => e.kind === 'penalty').targetId, 'B');
  const view = gameView(penalty.game, 'C');
  assert.equal(view.game.eventSequence, penalty.game.eventSequence);
  assert.deepEqual(view.game.seatOrder, ['A', 'B', 'C']);
});
