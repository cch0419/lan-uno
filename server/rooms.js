import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { VoiceHub } from './voice.js';
import { RoomChat } from './chat.js';
import { createGame, applyCommand, applyTurnTimeout, activePlayers, gameView, RuleError, requireRule, normalizeRules } from './game.js';
import { SocialHub, SOCIAL_COMMANDS } from './social.js';

const GAME_COMMANDS = new Set(['CHOOSE_INITIAL_COLOR', 'PLAY_CARD', 'DRAW_CARD',
  'CALL_UNO', 'CATCH_UNO', 'ACCEPT_WILD4', 'CHALLENGE_WILD4']);

export function send(socket, type, payload) {
  if (socket?.readyState !== 1) return;
  if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, 'Slow connection'); return; }
  socket.send(JSON.stringify({ type, payload }));
}

export class RoomManager {
  rooms = new Map();
  players = new Map();
  sessions = new Map();

  constructor({ disconnectGrace = 60_000, sessionTtl = 30 * 60_000, actionDelayMs = 2200, now = Date.now } = {}) {
    this.disconnectGrace = disconnectGrace;
    this.sessionTtl = sessionTtl;
    this.actionDelayMs = actionDelayMs;
    this.now = now;
    this.voice = new VoiceHub({ send, roomFor: player => this.roomFor(player), getPlayer: id => this.players.get(id) });
    this.social = new SocialHub({ now, roomFor: player => this.roomFor(player), broadcast: (room, payload) => {
      for (const id of room.playerIds) {
        const socket = this.players.get(id)?.socket;
        send(socket, 'SOCIAL', payload);
      }
    } });
  }

  roomFor(player) {
    const room = this.rooms.get(player.roomCode);
    requireRule(room?.playerIds.includes(player.id), 'ROOM_NOT_FOUND', '你尚未加入房间或房间已关闭');
    return room;
  }

  hostRoom(player) {
    const room = this.roomFor(player);
    requireRule(room.hostId === player.id, 'HOST_ONLY', '只有房主可以进行此操作');
    return room;
  }

  // Room membership includes the managing browser; only seated participants
  // consume capacity, receive cards, or affect the running game's lifecycle.
  participants(room) {
    return room.playerIds.filter(id => !room.spectatorIds.includes(id));
  }

  view(room, player) {
    const projected = room.game ? gameView(room.game, player.id) : null;
    const rosterIds = [...new Set([...room.playerIds, ...(room.game?.seatOrder ?? [])])];
    const rankOf = id => room.game?.ranking.find(entry => entry.playerId === id)?.rank ??
      ((room.game?.finishOrder.indexOf(id) ?? -1) + 1 || null);
    return {
      roomCode: room.code, revision: room.revision, hostId: room.hostId, chatId: room.chat.id,
      maxPlayers: room.maxPlayers, status: room.status, info: room.info,
      participantCount: this.participants(room).length,
      turnSeconds: room.turnSeconds, turnSecondsByPlayer: room.turnSecondsByPlayer, rules: room.rules, serverTime: this.now(),
      disconnectGraceSeconds: Math.round(this.disconnectGrace / 1000),
      players: rosterIds.map(id => {
        const member = this.players.get(id);
        return { id, nickname: member?.nickname ?? room.game?.playerNames?.[id] ?? '玩家', online: !!member?.online && room.playerIds.includes(id),
          rank: rankOf(id), isFinished: !!room.game?.finishOrder.includes(id),
          isParticipating: room.game ? room.game.seatOrder.includes(id) : !room.spectatorIds.includes(id),
          handCount: room.game?.hands[id]?.length ?? 0 };
      }),
      you: { playerId: player.id, hand: projected?.hand ?? [],
        isParticipating: room.game ? room.game.seatOrder.includes(player.id) : !room.spectatorIds.includes(player.id),
        isFinished: !!room.game?.finishOrder.includes(player.id), rank: rankOf(player.id) },
      game: projected ? { ...projected.game, clock: room.turnClock } : null, actions: projected?.actions ?? {},
      social: { speakers: this.social.speakers(room) },
      voiceMembers: [...this.voice.members.values()].filter(m => m.roomCode === room.code && m.mic).map(m => ({ playerId: m.id }))
    };
  }

  publish(room) {
    if (!room) return;
    for (const id of room.playerIds) {
      const player = this.players.get(id);
      send(player.socket, 'STATE', this.view(room, player));
    }
  }

  hello(socket, data) {
    requireRule(!socket.playerId, 'ALREADY_AUTHENTICATED', '此连接已经建立身份');
    let player = typeof data.resumeToken === 'string' ? this.sessions.get(data.resumeToken) : null;
    const resumed = !!player;
    if (!player) {
      const nickname = typeof data.nickname === 'string' ? data.nickname.trim() : '';
      requireRule([...nickname].length >= 1 && [...nickname].length <= 16 && !/[\x00-\x1f\x7f]/.test(nickname),
        'INVALID_NICKNAME', '昵称需要 1～16 个字符，不能包含控制字符');
      requireRule(this.sessions.size < 500, 'SERVER_BUSY', '服务器玩家数量已达上限，请稍后重试');
      player = { id: randomUUID(), token: randomBytes(32).toString('hex'), nickname,
        roomCode: null, online: true, disconnectedAt: null, socket: null, requests: new Map() };
      this.sessions.set(player.token, player);
      this.players.set(player.id, player);
    }
    const previousSocket = player.socket;
    this.voice.leave(player.id);
    if (previousSocket && previousSocket !== socket) this.social.end(player.id);
    player.socket = socket;
    player.online = true;
    player.disconnectedAt = null;
    socket.playerId = player.id;
    if (previousSocket && previousSocket !== socket) {
      send(previousSocket, 'SESSION_REPLACED', { reason: 'new_tab' });
      previousSocket.close(4001, 'Session replaced');
    }
    send(socket, 'SESSION', { playerId: player.id, resumeToken: player.token,
      nickname: player.nickname, resumed, previousSessionExpired: !!data.resumeToken && !resumed });
    if (player.roomCode) {
      const room = this.roomFor(player);
      if (room.game) this.refreshPause(room, this.now());
      room.revision++;
      this.publish(room);
    } else send(socket, 'STATE', null);
  }

  validateCapacity(value) {
    requireRule(Number.isInteger(value) && value >= 2 && value <= 10,
      'INVALID_CAPACITY', '房间人数必须是 2～10 的整数');
  }

  validateTurnSeconds(value) {
    requireRule(Number.isInteger(value) && value >= 15 && value <= 120,
      'INVALID_TURN_SECONDS', '出牌时间应为 15～120 秒的整数');
  }

  startClock(room, now = this.now()) {
    if (!room.game || room.game.phase === 'finished') { room.turnClock = null; return; }
    const startsAt = now + this.actionDelayMs;
    const durationMs = (room.turnSecondsByPlayer?.[room.game.currentPlayerId] ?? room.turnSeconds) * 1000;
    room.turnClock = { gameId: room.game.id, turnId: room.game.turnId, phase: room.game.phase,
      startsAt, deadlineAt: startsAt + durationMs, durationMs, paused: false,
      remainingMs: durationMs, readyRemainingMs: 0 };
  }

  refreshPause(room, now) {
    const game = room.game;
    const paused = game.phase !== 'finished' && activePlayers(game).some(id => !this.players.get(id)?.online);
    if (paused === game.paused) return;
    const clock = room.turnClock;
    if (paused && clock) {
      clock.remainingMs = Math.max(0, clock.deadlineAt - Math.max(now, clock.startsAt));
      clock.readyRemainingMs = Math.max(0, clock.startsAt - now);
      clock.deadlineAt = null; clock.startsAt = null; clock.paused = true;
    } else if (clock) {
      clock.startsAt = now + Math.max(clock.readyRemainingMs, this.actionDelayMs);
      clock.deadlineAt = clock.startsAt + clock.remainingMs; clock.paused = false;
    }
    game.paused = paused;
  }

  timeoutRoom(room, now) {
    const clock = room.turnClock;
    if (!room.game || room.status !== 'playing' || room.game.paused || !clock ||
        clock.deadlineAt === null || now < clock.deadlineAt) return false;
    const result = applyTurnTimeout(room.game);
    room.game = result.game;
    room.status = room.game.phase === 'finished' ? 'finished' : 'playing';
    this.startClock(room, now);
    room.revision++;
    this.publish(room);
    return true;
  }

  create(player, maxPlayers, hostParticipates = true, turnSeconds = 45) {
    requireRule(!player.roomCode, 'ALREADY_IN_ROOM', '请先退出当前房间');
    this.validateCapacity(maxPlayers);
    this.validateTurnSeconds(turnSeconds);
    requireRule(typeof hostParticipates === 'boolean', 'INVALID_PARTICIPATION', '请选择房主是否参与游戏');
    requireRule(this.rooms.size < 100, 'ROOM_LIMIT', '服务器房间数量已达上限');
    const start = randomInt(10_000);
    let code;
    for (let i = 0; i < 10_000; i++) {
      const candidate = String((start + i) % 10_000).padStart(4, '0');
      if (!this.rooms.has(candidate)) { code = candidate; break; }
    }
    requireRule(code !== undefined, 'ROOM_CODE_EXHAUSTED', '房间编号已用完');
    const room = { code, maxPlayers, turnSeconds, turnSecondsByPlayer: {}, rules: normalizeRules(), turnClock: null, hostId: player.id, playerIds: [player.id],
      spectatorIds: hostParticipates ? [] : [player.id],
      status: 'waiting', revision: 1, game: null, chat: new RoomChat(), info: '邀请朋友输入房间号加入，至少 2 人即可开始。' };
    this.rooms.set(code, room);
    player.roomCode = code;
    return room;
  }

  join(player, code) {
    requireRule(typeof code === 'string' && /^\d{4}$/.test(code), 'INVALID_CODE', '请输入 4 位数字房间号');
    const room = this.rooms.get(code);
    requireRule(room, 'ROOM_NOT_FOUND', '没有找到这个房间，请确认地址与房间号');
    if (player.roomCode === code) return room;
    requireRule(!player.roomCode, 'ALREADY_IN_ROOM', '请先退出当前房间');
    requireRule(room.status === 'waiting', 'GAME_STARTED', '游戏已开始，请等待本局结束并返回大厅');
    requireRule(this.participants(room).length < room.maxPlayers, 'ROOM_FULL', '玩家席位已满');
    room.playerIds.push(player.id);
    player.roomCode = code;
    room.revision++;
    return room;
  }

  leave(player, reason = 'left') {
    const room = this.roomFor(player);
    this.voice.leave(player.id);
    this.social.end(player.id);
    room.chat.budgets.delete(player.id);
    const wasPlaying = room.game?.seatOrder.includes(player.id) && !room.game.finishOrder.includes(player.id);
    room.playerIds = room.playerIds.filter(id => id !== player.id);
    room.spectatorIds = room.spectatorIds.filter(id => id !== player.id);
    delete room.turnSecondsByPlayer[player.id];
    player.roomCode = null;
    send(player.socket, 'STATE', null);
    if (!room.playerIds.length) { this.rooms.delete(room.code); return null; }
    if (room.game && wasPlaying) {
      this.social.clearRoom(room);
      room.info = room.status === 'playing'
        ? `${player.nickname}${reason === 'timeout' ? '重连超时' : '退出了游戏'}，本局中止，可以重新开始。`
        : '有玩家离开，已返回等待大厅。';
      room.game = null;
      room.turnClock = null;
      room.status = 'waiting';
    }
    if (room.hostId === player.id) this.assignHost(room);
    room.revision++;
    return room;
  }

  assignHost(room) {
    room.hostId = room.playerIds.find(id => this.players.get(id).online) ?? room.playerIds[0];
  }

  execute(player, message) {
    const data = message.payload;
    let room;
    const privateMessages = [];
    switch (message.type) {
      case 'GET_STATE':
        send(player.socket, 'STATE', player.roomCode ? this.view(this.roomFor(player), player) : null);
        break;
      case 'ROOM_CREATE': room = this.create(player, data.maxPlayers, data.hostParticipates, data.turnSeconds); break;
      case 'ROOM_JOIN': room = this.join(player, data.code); break;
      case 'ROOM_LEAVE': room = this.leave(player); break;
      case 'ROOM_UPDATE': {
        room = this.hostRoom(player);
        requireRule(room.status === 'waiting', 'GAME_STARTED', '只能在大厅修改人数');
        const maxPlayers = data.maxPlayers === undefined ? room.maxPlayers : data.maxPlayers;
        const turnSeconds = data.turnSeconds === undefined ? room.turnSeconds : data.turnSeconds;
        const hostParticipates = data.hostParticipates === undefined
          ? !room.spectatorIds.includes(player.id) : data.hostParticipates;
        this.validateCapacity(maxPlayers);
        this.validateTurnSeconds(turnSeconds);
        const rules = normalizeRules({ ...room.rules, ...(data.rules ?? {}) });
        if (data.rules !== undefined) normalizeRules(data.rules);
        const turnSecondsByPlayer = { ...room.turnSecondsByPlayer };
        if (data.turnSecondsByPlayer !== undefined) {
          const overrides = data.turnSecondsByPlayer;
          requireRule(overrides && typeof overrides === 'object' && !Array.isArray(overrides), 'INVALID_PLAYER_TIMES', '个人时间设置格式错误');
          for (const key of Object.keys(turnSecondsByPlayer)) delete turnSecondsByPlayer[key];
          for (const [id, seconds] of Object.entries(overrides)) {
            requireRule(room.playerIds.includes(id), 'INVALID_PLAYER_TIMES', '个人时间只能设置给本房间成员');
            this.validateTurnSeconds(seconds);
            turnSecondsByPlayer[id] = seconds;
          }
        }
        requireRule(typeof hostParticipates === 'boolean', 'INVALID_PARTICIPATION', '请选择房主是否参与游戏');
        const spectatorIds = room.spectatorIds.filter(id => id !== player.id);
        if (!hostParticipates) spectatorIds.push(player.id);
        const participantCount = room.playerIds.filter(id => !spectatorIds.includes(id)).length;
        // Validate all proposed settings before committing either field.
        requireRule(maxPlayers >= participantCount, 'TOO_MANY_PLAYERS', '玩家席位已满，请先增加人数上限或等待玩家退出');
        room.maxPlayers = maxPlayers; room.turnSeconds = turnSeconds; room.rules = rules;
        room.turnSecondsByPlayer = turnSecondsByPlayer; room.spectatorIds = spectatorIds; room.revision++;
        break;
      }
      case 'HOST_TRANSFER':
        room = this.hostRoom(player);
        requireRule(room.playerIds.includes(data.targetPlayerId) && this.players.get(data.targetPlayerId).online,
          'TARGET_OFFLINE', '请选择房间内的在线玩家');
        room.hostId = data.targetPlayerId; room.revision++;
        break;
      case 'ROOM_CLOSE': {
        const closing = this.hostRoom(player);
        this.social.clearRoom(closing);
        for (const id of closing.playerIds) {
          this.voice.leave(id);
          const member = this.players.get(id);
          member.roomCode = null;
          send(member.socket, 'ROOM_CLOSED', { reason: 'host_closed' });
        }
        this.rooms.delete(closing.code);
        break;
      }
      case 'GAME_START':
        room = this.hostRoom(player);
        requireRule(room.status === 'waiting', 'GAME_STARTED', '本局已经开始，请勿重复操作');
        requireRule(this.participants(room).length >= 2, 'NEED_PLAYERS', '至少需要 2 名参与游戏的玩家，仅管理的房主不计入人数');
        requireRule(this.participants(room).every(id => this.players.get(id).online), 'PLAYER_OFFLINE', '请等待所有参与游戏的玩家上线');
        room.game = createGame(this.participants(room), undefined, room.rules);
        room.game.playerNames = Object.fromEntries(room.game.seatOrder.map(id => [id, this.players.get(id).nickname]));
        this.startClock(room);
        room.status = 'playing'; room.info = ''; room.revision++;
        break;
      case 'RETURN_TO_LOBBY':
        room = this.hostRoom(player);
        requireRule(room.status === 'finished', 'GAME_NOT_FINISHED', '游戏还没有结束');
        this.social.clearRoom(room);
        room.game = null; room.turnClock = null; room.status = 'waiting'; room.info = '上一局已结束，准备好后可以再次开始。'; room.revision++;
        break;
      default: {
        requireRule(GAME_COMMANDS.has(message.type), 'UNKNOWN_EVENT', '无法识别的操作');
        room = this.roomFor(player);
        requireRule(room.game, 'NO_GAME', '游戏尚未开始');
        if (!['CALL_UNO', 'CATCH_UNO'].includes(message.type) && room.status === 'playing' && !room.game.paused) {
          requireRule(!this.timeoutRoom(room, this.now()), 'TURN_TIMED_OUT', '本回合已超时，已自动处理');
          requireRule(!room.turnClock || this.now() >= room.turnClock.startsAt,
            'ANIMATION_IN_PROGRESS', '请等上一张牌落桌后再出牌');
        }
        const previousTurn = room.game.turnId;
        const result = applyCommand(room.game, player.id, message);
        room.game = result.game;
        room.status = result.game.phase === 'finished' ? 'finished' : 'playing';
        if (result.game.turnId !== previousTurn || room.status === 'finished') this.startClock(room);
        room.revision++;
        if (result.evidence) privateMessages.push({ type: 'CHALLENGE_EVIDENCE', payload: result.evidence });
      }
    }
    return { room, privateMessages };
  }

  handle(socket, message) {
    let player;
    let signature;
    try {
      requireRule(message && typeof message === 'object' && !Array.isArray(message), 'INVALID_MESSAGE', '消息格式错误');
      requireRule(typeof message.type === 'string' && message.type.length <= 40 &&
        typeof message.requestId === 'string' && message.requestId.length > 0 && message.requestId.length <= 100,
      'INVALID_MESSAGE', '消息类型或请求编号错误');
      message.payload ??= {};
      requireRule(message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload),
        'INVALID_PAYLOAD', '操作参数必须是对象');
      if (message.type === 'HELLO') {
        this.hello(socket, message.payload);
        send(socket, 'COMMAND_RESULT', { requestId: message.requestId, ok: true });
        return;
      }
      player = this.players.get(socket.playerId);
      requireRule(player?.socket === socket, 'SESSION_REQUIRED', '请先连接，或此窗口已被其他窗口接管');
      if (message.type.startsWith('VOICE_')) {
        this.voice.handle(player, message.type, message.payload);
        send(socket, 'COMMAND_RESULT', { requestId: message.requestId, ok: true });
        return;
      }
      // Hash large image requests instead of retaining their base64 in the cache.
      signature = createHash('sha256').update(JSON.stringify([message.type, message.payload])).digest('hex');
      const cached = player.requests.get(message.requestId);
      if (cached) {
        requireRule(cached.signature === signature, 'REQUEST_ID_REUSED', '请求编号不能重复用于不同操作');
        if (message.type === 'CHAT_SYNC' && cached.result.ok) {
          const room = this.roomFor(player);
          requireRule(message.payload.roomCode === room.code && message.payload.chatId === room.chat.id,
            'CHAT_STALE_ROOM', '聊天房间已变化，请重新加入');
          send(socket, 'COMMAND_RESULT', cached.result);
          send(socket, 'CHAT_HISTORY', room.chat.history(room.code));
          return;
        }
        send(socket, 'COMMAND_RESULT', cached.result);
        if (message.type === 'CHAT_SEND' || message.type === 'CHAT_SYNC' || SOCIAL_COMMANDS.has(message.type)) return;
        for (const item of cached.privateMessages) send(socket, item.type, item.payload);
        send(socket, 'STATE', player.roomCode ? this.view(this.roomFor(player), player) : null);
        return;
      }
      if (message.type === 'CHAT_SEND' || message.type === 'CHAT_SYNC') {
        const room = this.roomFor(player);
        requireRule(message.payload.roomCode === room.code && message.payload.chatId === room.chat.id,
          'CHAT_STALE_ROOM', '聊天房间已变化，请重新加入');
        let history;
        if (message.type === 'CHAT_SYNC') history = room.chat.history(room.code);
        else {
          const item = room.chat.post(player, message.payload, this.now());
          for (const id of room.playerIds) send(this.players.get(id)?.socket, 'CHAT_MESSAGE', {
            roomCode: room.code, chatId: room.chat.id, message: item
          });
        }
        const result = { requestId: message.requestId, ok: true };
        this.remember(player, message.requestId, signature, result, []);
        send(socket, 'COMMAND_RESULT', result);
        if (history) send(socket, 'CHAT_HISTORY', history);
        return;
      }
      if (SOCIAL_COMMANDS.has(message.type)) {
        this.social.command(player, message.type, message.payload);
        const result = { requestId: message.requestId, ok: true };
        this.remember(player, message.requestId, signature, result, []);
        send(socket, 'COMMAND_RESULT', result);
        return; // Reactions must not publish game snapshots or reset clocks.
      }
      const { room, privateMessages } = this.execute(player, message);
      const result = { requestId: message.requestId, ok: true };
      this.remember(player, message.requestId, signature, result, privateMessages);
      send(socket, 'COMMAND_RESULT', result);
      for (const item of privateMessages) send(socket, item.type, item.payload);
      this.publish(room);
    } catch (error) {
      if (!(error instanceof RuleError)) console.error(error);
      const result = { requestId: typeof message?.requestId === 'string' ? message.requestId : null,
        ok: false, code: error.code ?? 'INTERNAL_ERROR',
        message: error instanceof RuleError ? error.message : '服务处理失败，请重试或重新连接' };
      if (player && signature && !player.requests.has(message.requestId)) {
        this.remember(player, message.requestId, signature, result, []);
      }
      send(socket, 'COMMAND_RESULT', result);
    }
  }

  remember(player, id, signature, result, privateMessages) {
    player.requests.set(id, { signature, result, privateMessages, time: Date.now() });
    while (player.requests.size > 100) player.requests.delete(player.requests.keys().next().value);
  }

  disconnect(socket, now = this.now()) {
    const player = this.players.get(socket.playerId);
    if (!player || player.socket !== socket) return;
    this.voice.leave(player.id);
    this.social.end(player.id);
    player.socket = null; player.online = false; player.disconnectedAt = now;
    if (!player.roomCode) return;
    const room = this.roomFor(player);
    if (room.game && room.status === 'playing') this.refreshPause(room, now);
    if (room.hostId === player.id) this.assignHost(room);
    room.revision++;
    this.publish(room);
  }

  sweep(now = this.now()) {
    this.social.sweep(now);
    for (const player of this.players.values()) {
      for (const [id, entry] of player.requests) {
        if (now - entry.time > 5 * 60_000) player.requests.delete(id);
      }
      if (player.online) continue;
      if (player.roomCode && now - player.disconnectedAt >= this.disconnectGrace) {
        this.publish(this.leave(player, 'timeout'));
      }
      if (!player.roomCode && now - player.disconnectedAt >= this.sessionTtl) {
        this.players.delete(player.id); this.sessions.delete(player.token);
      }
    }
    for (const room of this.rooms.values()) this.timeoutRoom(room, now);
  }
}
