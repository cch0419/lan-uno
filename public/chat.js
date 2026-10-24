import { quickPhrases, stickers, emojis, CHAT_TEXT_LIMIT, CHAT_IMAGE_LIMIT } from './chat-catalog.js';

export function createChat({ send, notify }) {
  const $ = id => document.getElementById(id);
  const panel = $('chatPanel'); const list = $('chatMessages'); const input = $('chatInput');
  const stickerMap = new Map(stickers.map(sticker => [sticker.id, sticker]));
  let room = null;
  let connected = false;
  let messages = [];
  let unread = 0;
  let open = false;
  let pending = false;
  let generation = 0;
  let follow = true;
  let picker = '';
  let status = '';

  function bottom() { list.scrollTop = list.scrollHeight; follow = true; $('chatNewMessages').hidden = true; }
  function renderControls() {
    $('chatLauncher').hidden = !room;
    $('chatUnread').hidden = !unread;
    $('chatUnread').textContent = unread > 99 ? '99+' : String(unread);
    $('chatLauncher').setAttribute('aria-label', unread ? `聊天，${unread} 条未读消息` : '打开牌桌聊天');
    $('chatLauncher').setAttribute('aria-expanded', String(open));
    const length = [...input.value.trim()].length;
    $('chatCount').textContent = `${length}/${CHAT_TEXT_LIMIT}`;
    $('chatCount').classList.toggle('over-limit', length > CHAT_TEXT_LIMIT);
    input.disabled = !connected;
    $('chatSend').disabled = !connected || pending || !length || length > CHAT_TEXT_LIMIT;
    for (const button of panel.querySelectorAll('[data-chat-send]')) button.disabled = !connected || pending;
    $('chatStatus').textContent = !connected && room ? '连接已断开，恢复后可继续发送' : pending ? '正在发送…' : status;
    $('chatQuickToggle').setAttribute('aria-expanded', String(picker === 'quick'));
    $('chatStickerToggle').setAttribute('aria-expanded', String(picker === 'stickers'));
    $('chatQuick').hidden = picker !== 'quick';
    $('chatStickers').hidden = picker !== 'stickers';
  }

  function setOpen(value) {
    open = value && !!room;
    document.body.classList.toggle('chat-open', open);
    panel.hidden = !open;
    if (open) { unread = 0; requestAnimationFrame(bottom); }
    else if (panel.contains(document.activeElement)) $('chatLauncher').focus({ preventScroll: true });
    renderControls(); adjustViewport();
  }

  function makeMessage(message) {
    const node = document.createElement('li');
    const own = message.playerId === room?.playerId;
    node.className = `chat-message${own ? ' own' : ''}`; node.dataset.messageId = message.id;
    const meta = document.createElement('div'); meta.className = 'chat-message-meta';
    const name = document.createElement('strong'); name.textContent = own ? `${message.nickname}（你）` : message.nickname;
    const time = document.createElement('time'); time.dateTime = new Date(message.sentAt).toISOString();
    time.textContent = new Date(message.sentAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    meta.append(name, time);
    const bubble = document.createElement('div'); bubble.className = `chat-bubble ${message.kind}`;
    if (message.kind === 'text') bubble.textContent = message.text;
    else {
      const sticker = stickerMap.get(message.stickerId);
      const image = document.createElement('img'); image.decoding = 'async';
      image.src = message.kind === 'sticker' && sticker ? `/stickers/${sticker.id}.svg` : message.image;
      image.alt = sticker?.label ?? `${message.nickname} 发送的图片`;
      if (sticker) { image.width = 134; image.height = 128; }
      image.addEventListener('load', () => { if (open && follow) bottom(); });
      image.addEventListener('error', () => { bubble.textContent = '图片暂时无法显示'; });
      bubble.append(image);
    }
    node.append(meta, bubble); return node;
  }

  function renderMessages(pin = follow) {
    const top = list.scrollTop;
    $('chatEmpty').hidden = messages.length > 0;
    list.replaceChildren(...messages.map(makeMessage));
    if (open && pin) bottom(); else list.scrollTop = top;
  }

  function receive(type, payload) {
    if (!room || payload.roomCode !== room.code || payload.chatId !== room.id) return;
    if (type === 'CHAT_HISTORY') {
      const merged = new Map(payload.messages.map(message => [message.id, message]));
      for (const message of messages) if (message.sequence > payload.sequence) merged.set(message.id, message);
      messages = [...merged.values()].sort((a, b) => a.sequence - b.sequence).slice(-50);
      renderMessages();
    } else if (type === 'CHAT_MESSAGE') {
      const message = payload.message;
      if (messages.some(item => item.id === message.id)) return;
      messages = [...messages, message].sort((a, b) => a.sequence - b.sequence).slice(-50);
      if (!open && message.playerId !== room.playerId) unread++;
      if (open && !follow) $('chatNewMessages').hidden = false;
      renderMessages();
    }
    renderControls();
  }

  async function sync() {
    if (!room || !connected) return;
    const version = generation;
    $('chatRetry').hidden = true;
    try {
      await send('CHAT_SYNC', { roomCode: room.code, chatId: room.id });
      if (version === generation) { status = ''; renderControls(); }
    } catch {
      if (version !== generation) return;
      status = '聊天记录同步失败，可点击重试'; $('chatRetry').hidden = false; renderControls();
    }
  }

  function setRoom(next) {
    const id = next?.chatId;
    const changed = room?.id !== id;
    const recovering = !connected;
    if (changed) {
      generation++; messages = []; unread = 0; pending = false; picker = ''; status = ''; input.value = '';
      $('chatRetry').hidden = true; $('chatNewMessages').hidden = true;
      room = id ? { code: next.roomCode, id, playerId: next.you.playerId } : null;
      renderMessages(true);
      if (!room) setOpen(false);
    }
    connected = !!room;
    renderControls();
    if (room && (changed || recovering)) void sync();
  }

  function disconnect() { connected = false; pending = false; generation++; renderControls(); }

  async function post(content, draft = null, closePicker = false) {
    if (!connected || pending || !room) return;
    const version = generation;
    pending = true; status = ''; follow = true; renderControls();
    try {
      await send('CHAT_SEND', { roomCode: room.code, chatId: room.id, ...content });
      if (version !== generation) return;
      if (draft !== null && input.value === draft) input.value = '';
      if (closePicker) { picker = ''; requestAnimationFrame(bottom); }
    } catch (error) {
      if (version !== generation) return;
      status = error.message; notify(error.message, true);
    } finally { if (version === generation) { pending = false; renderControls(); } }
  }

  const readDataUrl = blob => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败，请重新选择'));
    reader.readAsDataURL(blob);
  });

  async function prepareImage(file) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片');
    if (file.size > 5 * 1024 * 1024) throw new Error('原图不能超过 5MB，请先缩小后再发送');
    const url = URL.createObjectURL(file);
    const image = new Image();
    try {
      image.src = url; await image.decode();
      if (file.size <= CHAT_IMAGE_LIMIT && image.naturalWidth <= 1024 && image.naturalHeight <= 1024) return await readDataUrl(file);
      if (file.type === 'image/gif') throw new Error('动图需小于 96KB，且尺寸不超过 1024×1024');
      const scale = Math.min(1, 640 / image.naturalWidth, 640 / image.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.82, 0.62, 0.42]) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
        if (blob && blob.size <= CHAT_IMAGE_LIMIT) return await readDataUrl(blob);
      }
      throw new Error('图片压缩后仍然过大，请选择更小的图片');
    } finally { URL.revokeObjectURL(url); }
  }

  function quickButton(label, content, parent, className = '') {
    const button = document.createElement('button'); button.type = 'button'; button.className = className;
    button.dataset.chatSend = ''; button.textContent = label;
    button.addEventListener('click', () => { void post(content, null, true); }); parent.append(button); return button;
  }
  for (const phrase of quickPhrases) quickButton(phrase, { kind: 'text', text: phrase }, $('chatPhrases'), 'chat-phrase');
  for (const emoji of emojis) quickButton(emoji, { kind: 'text', text: emoji }, $('chatEmojis'), 'chat-emoji');
  for (const sticker of stickers) {
    const button = quickButton('', { kind: 'sticker', stickerId: sticker.id }, $('chatStickers'), 'chat-sticker-option');
    button.setAttribute('aria-label', `发送表情包：${sticker.label}`); button.title = sticker.label;
    const image = document.createElement('img'); image.src = `/stickers/${sticker.id}.svg`; image.alt = sticker.label;
    image.width = 100; image.height = 95; button.append(image);
  }
  $('chatLauncher').addEventListener('click', () => setOpen(!open));
  $('chatClose').addEventListener('click', () => setOpen(false));
  $('chatQuickToggle').addEventListener('click', () => { picker = picker === 'quick' ? '' : 'quick'; renderControls(); if (follow) requestAnimationFrame(bottom); });
  $('chatStickerToggle').addEventListener('click', () => { picker = picker === 'stickers' ? '' : 'stickers'; renderControls(); if (follow) requestAnimationFrame(bottom); });
  $('chatForm').addEventListener('submit', event => {
    event.preventDefault(); const text = input.value;
    if (text.trim() && [...text.trim()].length <= CHAT_TEXT_LIMIT) void post({ kind: 'text', text }, text);
  });
  input.addEventListener('input', renderControls);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); $('chatForm').requestSubmit();
    }
  });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } });
  list.addEventListener('scroll', () => { follow = list.scrollHeight - list.scrollTop - list.clientHeight < 35; if (follow) $('chatNewMessages').hidden = true; });
  $('chatNewMessages').addEventListener('click', bottom);
  $('chatRetry').addEventListener('click', () => { void sync(); });
  $('chatUpload').addEventListener('click', () => $('chatFile').click());
  $('chatFile').addEventListener('change', async () => {
    const file = $('chatFile').files[0]; $('chatFile').value = '';
    if (!file || pending || !connected) return;
    const version = generation;
    pending = true; renderControls();
    try {
      const image = await prepareImage(file);
      if (version !== generation) return;
      pending = false;
      await post({ kind: 'image', image });
    } catch (error) {
      if (version === generation) { status = error.message; notify(error.message, true); }
    } finally { if (version === generation) { pending = false; renderControls(); } }
  });

  function adjustViewport() {
    const viewport = window.visualViewport;
    const available = viewport?.height ?? innerHeight;
    panel.style.setProperty('--chat-height', `${Math.max(160, Math.min(580, available - 24))}px`);
    panel.classList.toggle('compact', available < 450);
    const keyboard = viewport ? Math.max(0, innerHeight - available - viewport.offsetTop) : 0;
    panel.style.setProperty('--chat-bottom', `${keyboard + (innerWidth <= 720 ? 0 : 18)}px`);
  }
  window.visualViewport?.addEventListener('resize', adjustViewport);
  window.visualViewport?.addEventListener('scroll', adjustViewport);
  window.addEventListener('resize', adjustViewport);
  renderControls();
  return { setRoom, disconnect, receive };
}
