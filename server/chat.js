import { randomUUID } from 'node:crypto';
import { requireRule } from './game.js';
import { stickers, CHAT_TEXT_LIMIT, CHAT_IMAGE_LIMIT } from '../public/chat-catalog.js';

const stickerIds = new Set(stickers.map(sticker => sticker.id));
const MAX_HISTORY_BYTES = 1024 * 1024;

/** Accept raster data only. Dimension bounds also reject compressed pixel bombs. */
export function validateChatImage(value) {
  requireRule(typeof value === 'string' && value.length <= Math.ceil(CHAT_IMAGE_LIMIT / 3) * 4 + 40,
    'CHAT_IMAGE_TOO_LARGE', '图片需小于 96KB，请缩小图片后再发送');
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  requireRule(match, 'CHAT_INVALID_IMAGE', '只支持 PNG、JPEG、WebP 和 GIF 图片');
  const buffer = Buffer.from(match[2], 'base64');
  requireRule(buffer.length <= CHAT_IMAGE_LIMIT && buffer.toString('base64') === match[2], 'CHAT_INVALID_IMAGE', '图片数据无效或过大');
  let width = 0; let height = 0;
  if (match[1] === 'png' && buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR') {
    width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20);
  } else if (match[1] === 'gif' && buffer.length >= 13 && /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) {
    width = buffer.readUInt16LE(6); height = buffer.readUInt16LE(8);
  } else if (match[1] === 'webp' && buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buffer.toString('ascii', 12, 16);
    if (kind === 'VP8X') { width = buffer.readUIntLE(24, 3) + 1; height = buffer.readUIntLE(27, 3) + 1; }
    else if (kind === 'VP8 ' && buffer.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {
      width = buffer.readUInt16LE(26) & 16383; height = buffer.readUInt16LE(28) & 16383;
    } else if (kind === 'VP8L' && buffer[20] === 47) {
      const bits = buffer.readUInt32LE(21); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1;
    }
  } else if (match[1] === 'jpeg' && buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216 && buffer.at(-2) === 255 && buffer.at(-1) === 217) {
    let offset = 2;
    while (offset + 4 < buffer.length && buffer[offset] === 255) {
      while (buffer[offset] === 255) offset++;
      const marker = buffer[offset++];
      if (marker === 218 || marker === 217) break;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
        height = buffer.readUInt16BE(offset + 3); width = buffer.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  requireRule(width > 0 && height > 0 && width <= 1024 && height <= 1024, 'CHAT_INVALID_IMAGE', '图片格式无效，或尺寸超过 1024×1024');
  return value;
}

export class RoomChat {
  id = randomUUID();
  sequence = 0;
  messages = [];
  bytes = 0;
  budgets = new Map();

  history(roomCode) { return { roomCode, chatId: this.id, sequence: this.sequence, messages: [...this.messages] }; }

  post(player, data, now) {
    let content;
    if (data.kind === 'text') {
      requireRule(typeof data.text === 'string', 'CHAT_INVALID_TEXT', '请输入要发送的文字');
      const text = data.text.replace(/\r\n?/g, '\n').trim();
      requireRule(text.replace(/[\u200b-\u200d\ufeff]/g, '').trim().length > 0 && [...text].length <= CHAT_TEXT_LIMIT && !/[\x00-\x08\x0b-\x1f\x7f]/.test(text),
        'CHAT_INVALID_TEXT', '消息须为 1～200 个字符，不能包含控制字符');
      content = { kind: 'text', text };
    } else if (data.kind === 'sticker') {
      requireRule(stickerIds.has(data.stickerId), 'CHAT_INVALID_STICKER', '请选择内置表情包');
      content = { kind: 'sticker', stickerId: data.stickerId };
    } else if (data.kind === 'image') {
      content = { kind: 'image', image: validateChatImage(data.image) };
    } else requireRule(false, 'CHAT_INVALID_KIND', '不支持的消息类型');
    const previous = this.budgets.get(player.id) ?? { tokens: 3, at: now };
    const tokens = Math.min(3, previous.tokens + Math.max(0, now - previous.at) / 1200);
    requireRule(tokens >= 1, 'CHAT_TOO_FAST', '发送太快了，请稍候再试');
    this.budgets.set(player.id, { tokens: tokens - 1, at: now });
    const message = { id: `${this.id}:${++this.sequence}`, sequence: this.sequence, playerId: player.id,
      nickname: player.nickname, sentAt: now, ...content };
    this.messages.push(message);
    this.bytes += Buffer.byteLength(JSON.stringify(message));
    while (this.messages.length > 50 || this.bytes > MAX_HISTORY_BYTES) {
      this.bytes -= Buffer.byteLength(JSON.stringify(this.messages.shift()));
    }
    return message;
  }
}
