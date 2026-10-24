import { randomUUID } from 'node:crypto';
import { requireRule } from './game.js';

/** Signaling only. Microphone audio travels over encrypted WebRTC, not game WS. */
export class VoiceHub {
  members = new Map();
  constructor({ send, roomFor, getPlayer }) {
    this.send = send; this.roomFor = roomFor; this.getPlayer = getPlayer;
  }

  roster(roomCode) {
    const members = [...this.members.values()].filter(member => member.roomCode === roomCode);
    for (const member of members) this.send(this.getPlayer(member.id)?.socket, 'VOICE_ROSTER', {
      roomCode, self: { id: member.id, sessionId: member.sessionId },
      members: members.map(({ id, sessionId, mic, listening }) => ({
        id, sessionId, mic, listening, nickname: this.getPlayer(id)?.nickname ?? '玩家'
      }))
    });
  }

  leave(id) {
    const member = this.members.get(id);
    if (!member) return;
    this.members.delete(id);
    this.roster(member.roomCode);
  }

  handle(player, type, data) {
    const room = this.roomFor(player);
    requireRule(data.roomCode === room.code, 'VOICE_STALE_ROOM', '语音房间已变化，请重新开启');
    if (type === 'VOICE_JOIN') {
      requireRule(typeof data.mic === 'boolean' && typeof data.listening === 'boolean' && (data.mic || data.listening),
        'INVALID_VOICE_STATE', '请选择开启麦克风或听筒');
      const previous = this.members.get(player.id);
      if (previous && previous.roomCode !== room.code) this.leave(player.id);
      this.members.set(player.id, { id: player.id, roomCode: room.code,
        sessionId: previous?.roomCode === room.code ? previous.sessionId : randomUUID(),
        mic: data.mic, listening: data.listening });
      this.roster(room.code);
    } else if (type === 'VOICE_LEAVE') {
      this.leave(player.id);
    } else if (type === 'VOICE_SIGNAL') {
      const from = this.members.get(player.id);
      const target = this.members.get(data.targetId);
      requireRule(from?.roomCode === room.code && from.sessionId === data.sessionId,
        'VOICE_SESSION_REQUIRED', '请先加入语音');
      requireRule(target?.roomCode === room.code && room.playerIds.includes(target.id) &&
        this.getPlayer(target.id)?.online && target.sessionId === data.targetSessionId && target.id !== player.id,
        'VOICE_TARGET_UNAVAILABLE', '对方已离开语音');
      const description = data.description;
      const candidate = data.candidate;
      requireRule((description !== undefined) !== (candidate !== undefined), 'INVALID_VOICE_SIGNAL', '语音信令格式错误');
      let signal;
      if (description !== undefined) {
        requireRule(description && ['offer', 'answer'].includes(description.type) &&
          typeof description.sdp === 'string' && description.sdp.length > 0 && description.sdp.length <= 6500,
          'INVALID_VOICE_SIGNAL', '语音协商格式错误');
        signal = { description: { type: description.type, sdp: description.sdp } };
      } else {
        requireRule(candidate && typeof candidate.candidate === 'string' && candidate.candidate.length <= 1500 &&
          (candidate.sdpMid === null || typeof candidate.sdpMid === 'string' && candidate.sdpMid.length <= 100) &&
          (candidate.sdpMLineIndex === null || Number.isInteger(candidate.sdpMLineIndex) && candidate.sdpMLineIndex >= 0 && candidate.sdpMLineIndex <= 10),
          'INVALID_VOICE_SIGNAL', '语音网络候选格式错误');
        signal = { candidate: { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex } };
      }
      this.send(this.getPlayer(target.id).socket, 'VOICE_SIGNAL', {
        roomCode: room.code, fromId: player.id, sessionId: from.sessionId,
        targetSessionId: target.sessionId, ...signal
      });
    } else requireRule(false, 'UNKNOWN_EVENT', '无法识别的语音操作');
  }
}
