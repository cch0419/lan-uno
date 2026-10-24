import { randomInt, randomUUID } from 'node:crypto';

export const COLORS = ['red', 'yellow', 'green', 'blue'];

export class RuleError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function requireRule(condition, code, message) {
  if (!condition) throw new RuleError(code, message);
}

export function buildDeck() {
  const cards = [];
  const add = (kind, color, value) => {
    const card = { id: `c${cards.length}`, kind, color };
    if (kind === 'number') card.value = value;
    cards.push(card);
  };
  for (const color of COLORS) {
    add('number', color, 0);
    for (let value = 1; value <= 9; value++) {
      add('number', color, value); add('number', color, value);
    }
    for (const kind of ['skip', 'reverse', 'draw2']) {
      add(kind, color); add(kind, color);
    }
  }
  for (let i = 0; i < 4; i++) { add('wild', null); add('wild4', null); }
  return cards;
}

export function shuffle(cards, random = randomInt) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export function activePlayers(game) {
  return game.seatOrder.filter(id => !game.finishOrder.includes(id));
}

export function nextPlayer(game, playerId, steps = 1) {
  const count = game.seatOrder.length;
  let index = game.seatOrder.indexOf(playerId);
  const active = new Set(activePlayers(game));
  if (!active.size) return playerId;
  for (let step = 0; step < steps; step++) {
    do { index = ((index + game.direction) % count + count) % count; }
    while (!active.has(game.seatOrder[index]));
  }
  return game.seatOrder[index];
}

export function matches(game, card) {
  if (card.kind === 'wild' || card.kind === 'wild4') return true;
  if (card.color === game.activeColor) return true;
  const top = game.discardPile.at(-1);
  if (card.kind === 'number') {
    return top.kind === 'number' && card.value === top.value;
  }
  // House rule: colored action cards follow the active color, never just
  // the symbol. Only black wild cards may ignore color entirely.
  return false;
}

function beginTurn(game, playerId) {
  game.currentPlayerId = playerId;
  game.turnId++;
  game.phase = 'turn';
}

// Every physical card stays in exactly one pile or hand. No artificial cards.
export function drawCards(game, playerId, count, random = randomInt) {
  let drawn = 0;
  while (drawn < count) {
    if (!game.drawPile.length && game.discardPile.length > 1) {
      const top = game.discardPile.pop();
      game.drawPile = shuffle(game.discardPile, random);
      game.discardPile = [top];
    }
    if (!game.drawPile.length) break;
    game.hands[playerId].push(game.drawPile.pop());
    drawn++;
  }
  if (drawn) game.unoDeclaredIds = game.unoDeclaredIds.filter(id => id !== playerId);
  return drawn;
}

function chooseDealer(ids, random) {
  let candidates = [...ids];
  // Ties are redrawn from a freshly mixed pack. Bound the loop for test RNGs.
  for (let round = 0; round < 100; round++) {
    const pack = shuffle(buildDeck(), random);
    const draws = candidates.map(id => ({ id, value: pack.pop().value ?? 0 }));
    const max = Math.max(...draws.map(draw => draw.value));
    candidates = draws.filter(draw => draw.value === max).map(draw => draw.id);
    if (candidates.length === 1) return candidates[0];
  }
  return candidates[random(candidates.length)];
}

export function createGame(ids, random = randomInt) {
  requireRule(ids.length >= 2 && ids.length <= 10, 'INVALID_PLAYERS', '需要 2～10 名玩家');
  const game = {
    id: randomUUID(), phase: 'turn', paused: false,
    seatOrder: [...ids], dealerId: chooseDealer(ids, random),
    currentPlayerId: null, direction: 1, turnId: 0,
    hands: Object.fromEntries(ids.map(id => [id, []])),
    drawPile: shuffle(buildDeck(), random), discardPile: [], activeColor: null,
    unoDeclaredIds: [], pendingWild4: null,
    finishOrder: [], ranking: [], lastPlayerId: null,
    provisionalWinnerId: null, winnerId: null, endReason: null,
    dryPassPlayerIds: [], log: [], eventSequence: 0
  };
  for (let round = 0; round < 7; round++) {
    for (const id of ids) drawCards(game, id, 1, random);
  }
  // Hold rejected +4 cards aside until a valid starter is found; then return
  // them and shuffle. This is equivalent to redrawing without an endless loop.
  const rejected = [];
  let top = game.drawPile.pop();
  while (top.kind === 'wild4') { rejected.push(top); top = game.drawPile.pop(); }
  game.drawPile.push(...rejected);
  if (rejected.length) shuffle(game.drawPile, random);
  game.discardPile.push(top);
  game.activeColor = top.color;
  const first = nextPlayer(game, game.dealerId);
  beginTurn(game, first);
  if (top.kind === 'wild') game.phase = 'choose_initial_color';
  if (top.kind === 'skip') beginTurn(game, nextPlayer(game, first));
  if (top.kind === 'draw2') {
    drawCards(game, first, 2, random);
    beginTurn(game, nextPlayer(game, first));
  }
  if (top.kind === 'reverse') {
    game.direction = -1;
    beginTurn(game, game.dealerId);
  }
  assertGame(game);
  return game;
}

export function assertGame(game) {
  const cards = [...Object.values(game.hands).flat(), ...game.drawPile, ...game.discardPile];
  if (cards.length !== 108 || new Set(cards.map(card => card.id)).size !== 108) {
    throw new Error('Card conservation violated');
  }
  if (!game.discardPile.length || !game.seatOrder.includes(game.currentPlayerId)) {
    throw new Error('Invalid game state');
  }
}

function finishIfReady(game, note) {
  if (!game.provisionalWinnerId || game.pendingWild4) return;
  const playerId = game.provisionalWinnerId;
  game.provisionalWinnerId = null;
  if (game.hands[playerId].length !== 0) return;
  if (!game.finishOrder.includes(playerId)) {
    game.finishOrder.push(playerId);
    game.winnerId = game.finishOrder[0];
    note('player_finished', { playerId, rank: game.finishOrder.length });
  }
  const remaining = activePlayers(game);
  if (remaining.length === 1) {
    game.lastPlayerId = remaining[0];
    game.ranking = [...game.finishOrder, remaining[0]].map((id, index) => ({
      playerId: id, rank: index + 1, remainingCards: game.hands[id].length
    }));
    game.phase = 'finished';
    game.endReason = 'normal';
  } else if (!remaining.includes(game.currentPlayerId)) {
    // A two-active-player reverse/skip may have pointed back to the finisher.
    beginTurn(game, nextPlayer(game, game.currentPlayerId));
  }
}

/** Apply on a private copy. Failed commands cannot partially mutate a game. */
export function applyCommand(original, actorId, command, random = randomInt, { automatic = false } = {}) {
  const game = structuredClone(original);
  const p = command.payload;
  const events = [];
  let evidence = null;
  const note = (kind, extra = {}) => events.push({ kind, playerId: actorId, ...extra });
  requireRule(p.gameId === game.id, 'STALE_GAME', '这局已经结束或更换，请刷新状态');
  requireRule(!game.paused, 'PAUSED', '正在等待掉线玩家重连');
  requireRule(game.phase !== 'finished', 'GAME_FINISHED', '本局已经结束');
  requireRule(game.seatOrder.includes(actorId), 'NOT_MEMBER', '你不在这场对局中');
  requireRule(!game.finishOrder.includes(actorId), 'PLAYER_FINISHED', '你已完成本局，正在等待其他玩家决出名次');
  if (automatic) note('timeout', { phase: game.phase });

  if (command.type === 'CALL_UNO') {
    requireRule(game.hands[actorId].length === 1, 'INVALID_UNO', '只剩一张牌时才能喊 UNO');
    requireRule(!game.unoDeclaredIds.includes(actorId), 'UNO_ALREADY_CALLED', '你已经喊过 UNO 了');
    game.unoDeclaredIds.push(actorId);
    note('uno');
  } else {
    requireRule(game.currentPlayerId === actorId, 'NOT_YOUR_TURN', '还没有轮到你');

    if (command.type === 'CHOOSE_INITIAL_COLOR') {
      requireRule(game.phase === 'choose_initial_color', 'WRONG_PHASE', '现在不需要选择起始颜色');
      requireRule(COLORS.includes(p.color), 'INVALID_COLOR', '请选择红、黄、绿、蓝之一');
      game.activeColor = p.color;
      beginTurn(game, actorId);
      note('color', { color: p.color });
    } else if (['ACCEPT_WILD4', 'CHALLENGE_WILD4'].includes(command.type)) {
      const pending = game.pendingWild4;
      requireRule(game.phase === 'wild4_response' && pending?.id === p.pendingId,
        'STALE_PENALTY', '这次 +4 已经处理');
      if (command.type === 'CHALLENGE_WILD4') {
        evidence = { pendingId: pending.id, actorId: pending.actorId,
          previousColor: pending.previousColor, handBeforePlay: pending.handBeforePlay,
          wasLegal: pending.wasLegal };
        if (!pending.wasLegal) {
          note('challenge_won', { targetId: pending.actorId, count: drawCards(game, pending.actorId, 4, random) });
          beginTurn(game, actorId);
        } else {
          note('challenge_lost', { count: drawCards(game, actorId, 6, random) });
          beginTurn(game, nextPlayer(game, actorId));
        }
      } else {
        note('accepted', { count: drawCards(game, actorId, 4, random) });
        beginTurn(game, nextPlayer(game, actorId));
      }
      game.pendingWild4 = null;
      finishIfReady(game, note);
    } else {
      requireRule(p.turnId === game.turnId, 'STALE_TURN', '回合已变化，请按最新牌面操作');
      requireRule(game.phase === 'turn', 'WRONG_PHASE', '请先完成当前选择');

      if (command.type === 'PLAY_CARD') {
        const hand = game.hands[actorId];
        const index = hand.findIndex(card => card.id === p.cardId);
        requireRule(index !== -1, 'CARD_NOT_OWNED', '这张牌不在你的手中');
        const card = hand[index];
        requireRule(matches(game, card), 'CARD_MISMATCH', '颜色、数字或功能不匹配');
        const wild = card.kind === 'wild' || card.kind === 'wild4';
        requireRule(!wild || COLORS.includes(p.chosenColor), 'INVALID_COLOR', '请先选择变色牌的颜色');
        requireRule(p.declareUno === undefined || typeof p.declareUno === 'boolean', 'INVALID_UNO', 'UNO 参数无效');
        if (card.kind === 'wild4') {
          game.pendingWild4 = {
            id: randomUUID(), actorId, targetId: nextPlayer(game, actorId),
            previousColor: game.activeColor, chosenColor: p.chosenColor,
            wasLegal: !hand.some(c => c.color === game.activeColor),
            handBeforePlay: structuredClone(hand)
          };
        }
        game.unoDeclaredIds = game.unoDeclaredIds.filter(id => id !== actorId);
        hand.splice(index, 1);
        game.discardPile.push(card);
        game.activeColor = wild ? p.chosenColor : card.color;
        game.dryPassPlayerIds = [];
        note('played', { card, color: game.activeColor, targetId: nextPlayer(game, actorId) });
        if (hand.length === 1) {
          game.unoDeclaredIds.push(actorId);
          note('uno');
        }
        if (!hand.length) game.provisionalWinnerId = actorId;
        if (card.kind === 'reverse') {
          game.direction *= -1;
          note('reversed', { direction: game.direction });
          beginTurn(game, activePlayers(game).length === 2 ? actorId : nextPlayer(game, actorId));
        } else if (card.kind === 'skip') {
          note('skipped', { targetId: nextPlayer(game, actorId) });
          beginTurn(game, nextPlayer(game, actorId, 2));
        } else if (card.kind === 'draw2') {
          const targetId = nextPlayer(game, actorId);
          note('penalty', { targetId, count: drawCards(game, targetId, 2, random) });
          beginTurn(game, nextPlayer(game, targetId));
        } else if (card.kind === 'wild4') {
          beginTurn(game, game.pendingWild4.targetId);
          game.phase = 'wild4_response';
        } else beginTurn(game, nextPlayer(game, actorId));
        finishIfReady(game, note);
      } else if (command.type === 'DRAW_CARD') {
        const count = drawCards(game, actorId, 1, random);
        note('drawn', { count });
        if (count) {
          game.dryPassPlayerIds = [];
          // House rule requested by players: drawing always ends the turn,
          // including when the drawn card matches. There is no pass/discard UI.
          beginTurn(game, nextPlayer(game, actorId));
        } else {
          if (!game.dryPassPlayerIds.includes(actorId)) game.dryPassPlayerIds.push(actorId);
          beginTurn(game, nextPlayer(game, actorId));
          // No cards available: end only this turn. The match still waits for
          // all but one player to finish; never declare a premature draw.
        }
      } else requireRule(false, 'UNKNOWN_EVENT', '未知的游戏操作');
    }
  }
  // Stable event IDs let browsers animate each accepted action exactly once,
  // even after log truncation, duplicate snapshots or a reconnect.
  for (const event of events) event.sequence = ++game.eventSequence;
  game.log.push(...events);
  game.log = game.log.slice(-32);
  assertGame(game);
  return { game, events, evidence };
}

/** Called exclusively by the server clock, never exposed as a client command. */
export function applyTurnTimeout(original, random = randomInt) {
  const actor = original.currentPlayerId;
  const payload = { gameId: original.id, turnId: original.turnId };
  if (original.phase === 'choose_initial_color') {
    const color = COLORS.reduce((best, candidate) =>
      original.hands[actor].filter(c => c.color === candidate).length > original.hands[actor].filter(c => c.color === best).length ? candidate : best
    );
    const chosen = applyCommand(original, actor, { type: 'CHOOSE_INITIAL_COLOR', payload: { ...payload, color } }, random, { automatic: true });
    const drawn = applyCommand(chosen.game, actor, { type: 'DRAW_CARD', payload: { gameId: chosen.game.id, turnId: chosen.game.turnId } }, random);
    return { game: drawn.game, events: [...chosen.events, ...drawn.events], evidence: null };
  }
  const type = original.phase === 'wild4_response' ? 'ACCEPT_WILD4' : 'DRAW_CARD';
  if (original.pendingWild4) payload.pendingId = original.pendingWild4.id;
  return applyCommand(original, actor, { type, payload }, random, { automatic: true });
}

/** Only this explicitly allowlisted projection may cross the network. */
export function gameView(game, playerId) {
  const isParticipating = game.seatOrder.includes(playerId);
  const hand = isParticipating ? game.hands[playerId] : [];
  const isFinished = game.finishOrder.includes(playerId);
  const myTurn = isParticipating && !isFinished && game.currentPlayerId === playerId && !game.paused;
  const canPlay = myTurn && game.phase === 'turn';
  return {
    game: {
      id: game.id, phase: game.phase, paused: game.paused,
      currentPlayerId: game.currentPlayerId, turnId: game.turnId,
      seatOrder: game.seatOrder, eventSequence: game.eventSequence,
      activePlayerIds: activePlayers(game), finishOrder: game.finishOrder,
      ranking: game.ranking, lastPlayerId: game.lastPlayerId,
      direction: game.direction, activeColor: game.activeColor,
      topCard: game.discardPile.at(-1), drawPileCount: game.drawPile.length,
      winnerId: game.winnerId, endReason: game.endReason,
      unoDeclaredIds: game.unoDeclaredIds,
      pendingWild4: game.pendingWild4 ? {
        id: game.pendingWild4.id, actorId: game.pendingWild4.actorId,
        targetId: game.pendingWild4.targetId
      } : null,
      log: game.log
    },
    hand,
    actions: {
      playableCardIds: canPlay ? hand.filter(card =>
        matches(game, card)
      ).map(card => card.id) : [],
      canDraw: myTurn && game.phase === 'turn',
      canChooseInitialColor: myTurn && game.phase === 'choose_initial_color',
      canRespondWild4: myTurn && game.phase === 'wild4_response',
      canCallUno: isParticipating && !isFinished && !game.paused && game.phase !== 'finished' && hand.length === 1 && !game.unoDeclaredIds.includes(playerId)
    }
  };
}
