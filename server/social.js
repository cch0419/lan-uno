import { randomUUID } from 'node:crypto';
import { requireRule } from './game.js';

export const SOCIAL_COMMANDS = new Set(['SOCIAL_START', 'SOCIAL_END', 'SOCIAL_TEXT', 'SOCIAL_EMOTE']);
export const TARGET_EMOTES = new Set(['egg', 'slipper', 'flowers']);
export const SELF_EMOTES = new Set(['laugh', 'cry', 'clap']);

/** Ephemeral speech captions and reactions; voice media uses VoiceHub/WebRTC. */
export class SocialHub {
  sessions = new Map();
  cooldowns = new Map();

  constructor({ roomFor, broadcast, now }) {
    this.roomFor = roomFor; this.broadcast = broadcast; this.now = now;
  }

  room(player, payload) {
    const room = this.roomFor(player);
    requireRule(room.game && payload.gameId === room.game.id, 'SOCIAL_STALE_GAME', '请在当前牌桌使用互动');
    return room;
  }

  emit(room, kind, data) {
    this.broadcast(room, { id: randomUUID(), roomCode: room.code, gameId: room.game.id,
      kind, ...data });
  }

  throttle(playerId, key, interval) {
    const id = `${playerId}:${key}`; const now = this.now();
    requireRule(!this.cooldowns.has(id) || now - this.cooldowns.get(id) >= interval,
      'SOCIAL_TOO_FAST', '互动太频繁，请稍候再试');
    this.cooldowns.set(id, now);
  }

  command(player, type, payload) {
    const room = this.room(player, payload);
    if (type === 'SOCIAL_START') {
      requireRule(payload.mode === 'text', 'INVALID_SOCIAL_MODE', '请选择转文字');
      requireRule(typeof payload.sessionId === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(payload.sessionId), 'INVALID_SOCIAL_SESSION', '发言编号无效');
      const old = this.sessions.get(player.id);
      if (old?.id === payload.sessionId) return;
      requireRule(!old, 'ALREADY_SPEAKING', '请先结束上一段发言');
      this.throttle(player.id, 'start', 500);
      this.sessions.set(player.id, { id: payload.sessionId, room, playerId: player.id,
        mode: payload.mode, startedAt: this.now() });
      this.emit(room, 'start', { playerId: player.id, sessionId: payload.sessionId, mode: payload.mode });
    } else if (type === 'SOCIAL_END') {
      const session = this.sessions.get(player.id);
      requireRule(!session || session.id === payload.sessionId, 'STALE_SOCIAL_SESSION', '这段发言已经结束');
      this.end(player.id);
    } else if (type === 'SOCIAL_TEXT') {
      const session = this.sessions.get(player.id);
      // Typed fallback has no microphone session; recognized text has one.
      if (payload.sessionId) requireRule(session?.id === payload.sessionId && session.mode === 'text', 'STALE_SOCIAL_SESSION', '这段转文字已经结束');
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      requireRule(text && [...text].length <= 160 && !/[\x00-\x1f\x7f]/.test(text), 'INVALID_CHAT_TEXT', '文字需为 1～160 个字符，不能包含控制字符');
      this.throttle(player.id, 'text', 1200);
      this.emit(room, 'text', { playerId: player.id, text });
      if (payload.sessionId) this.end(player.id);
    } else if (type === 'SOCIAL_EMOTE') {
      const emote = payload.emote;
      requireRule(TARGET_EMOTES.has(emote) || SELF_EMOTES.has(emote), 'INVALID_EMOTE', '未知表情');
      const targetId = SELF_EMOTES.has(emote) ? player.id : payload.targetPlayerId;
      requireRule(room.playerIds.includes(targetId) && (targetId === player.id || room.game.seatOrder.includes(targetId)), 'INVALID_EMOTE_TARGET', '请选择本房间牌桌上的玩家');
      requireRule(!TARGET_EMOTES.has(emote) || targetId !== player.id, 'INVALID_EMOTE_TARGET', '请把互动表情送给其他玩家');
      this.throttle(player.id, 'emote', 1200);
      this.emit(room, 'emote', { playerId: player.id, targetPlayerId: targetId, emote });
    }
  }

  end(playerId) {
    const session = this.sessions.get(playerId);
    if (!session) return;
    this.sessions.delete(playerId);
    if (session.room.game) this.emit(session.room, 'end', { playerId, sessionId: session.id });
  }

  clearRoom(room) {
    for (const [id, session] of this.sessions) if (session.room === room) this.end(id);
  }

  speakers(room) {
    return [...this.sessions.values()].filter(session => session.room === room).map(s =>
      ({ playerId: s.playerId, sessionId: s.id, mode: s.mode }));
  }

  sweep(now) {
    for (const [id, s] of this.sessions) {
      if (!s.room.game || now - s.startedAt > 18_000) this.end(id);
    }
    for (const [id, at] of this.cooldowns) if (now - at > 60_000) this.cooldowns.delete(id);
  }
}
