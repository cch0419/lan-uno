import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomChat, validateChatImage } from '../server/chat.js';
import { CHAT_IMAGE_LIMIT } from '../public/chat-catalog.js';
const player = { id: 'a', nickname: '阿青' };

test('chat text uses Unicode character limits and validates before consuming rate budget', () => {
  const chat = new RoomChat();
  for (const text of ['', '   ', '\u200b', 'x\u0000', '😎'.repeat(201)]) assert.throws(() => chat.post(player, { kind: 'text', text }, 1000), { code: 'CHAT_INVALID_TEXT' });
  const message = chat.post(player, { kind: 'text', text: '  你好\r\n😎  ', nickname: '冒充', playerId: 'other' }, 1000);
  assert.equal(message.text, '你好\n😎');
  assert.equal(message.playerId, player.id);
  assert.equal(message.nickname, player.nickname);
  assert.equal(chat.post(player, { kind: 'text', text: '😎'.repeat(200) }, 1000).text.length, 400);
  assert.throws(() => chat.post(player, { kind: 'sticker', stickerId: '../secret' }, 1000), { code: 'CHAT_INVALID_STICKER' });
  assert.equal(chat.post(player, { kind: 'sticker', stickerId: 'laugh' }, 1000).sequence, 3);
  assert.throws(() => chat.post(player, { kind: 'text', text: 'too fast' }, 1000), { code: 'CHAT_TOO_FAST' });
  assert.equal(chat.post(player, { kind: 'text', text: '恢复' }, 2200).sequence, 4);
});

test('chat history is capped at fifty messages and old snapshots remain stable', () => {
  const chat = new RoomChat();
  chat.post(player, { kind: 'text', text: 'first' }, 0);
  const before = chat.history('1234');
  for (let i = 1; i < 80; i++) chat.post(player, { kind: 'text', text: String(i) }, i * 1200);
  assert.equal(before.messages.length, 1);
  assert.equal(before.sequence, 1);
  assert.equal(chat.messages.length, 50);
  assert.equal(chat.messages[0].sequence, 31);
  assert.equal(chat.messages.at(-1).sequence, 80);
});

test('chat rejects SVG, external links, invalid image headers and excessive dimensions or data', () => {
  const validGif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  assert.equal(validateChatImage(validGif), validGif);
  for (const image of ['https://example.com/a.gif', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,AAAA']) assert.throws(() => validateChatImage(image), { code: 'CHAT_INVALID_IMAGE' });
  const huge = Buffer.from(validGif.split(',')[1], 'base64'); huge.writeUInt16LE(5000, 6);
  assert.throws(() => validateChatImage(`data:image/gif;base64,${huge.toString('base64')}`), { code: 'CHAT_INVALID_IMAGE' });
  assert.throws(() => validateChatImage(`data:image/gif;base64,${Buffer.alloc(CHAT_IMAGE_LIMIT + 100).toString('base64')}`), { code: 'CHAT_IMAGE_TOO_LARGE' });
});

test('image history has a byte cap as well as a message count cap', () => {
  const chat = new RoomChat();
  const buffer = Buffer.alloc(90000);
  Buffer.from('GIF89a').copy(buffer); buffer.writeUInt16LE(10, 6); buffer.writeUInt16LE(10, 8);
  const image = `data:image/gif;base64,${buffer.toString('base64')}`;
  for (let i = 0; i < 20; i++) chat.post(player, { kind: 'image', image }, i * 1200);
  assert.ok(chat.messages.length < 10);
  assert.ok(chat.bytes <= 1024 * 1024);
});
