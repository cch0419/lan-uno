import { stickers } from './chat-catalog.js';

const icons = { egg: '🥚', slipper: '🩴', flowers: '💐', laugh: '😂', cry: '😭', clap: '👏' };
const labels = { egg: '扔鸡蛋', slipper: '扔拖鞋', flowers: '送鲜花', laugh: '大笑', cry: '大哭', clap: '鼓掌' };
const targeted = new Set(['egg', 'slipper', 'flowers']);

/** Independent presentation channel: never blocks a turn or changes a hand. */
export function createSocial({ getState, send, notify, stopVoice }) {
  const $ = id => document.getElementById(id);
  const layer = $('socialLayer');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canRecognize = !!(isSecureContext && Recognition && navigator.mediaDevices?.getUserMedia);
  let room = null; let connected = false; let recording = null; let aim = null; let drag = null;
  let voiceMembers = []; const speakers = new Map(); const bubbles = new Map();
  const seen = new Set(); const transient = new Set(); const badges = new Map();
  const seat = id => [...document.querySelectorAll('.table-seat')].find(node => node.dataset.playerId === id);
  const center = node => {
    const r = (node ?? $('roundTable')).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  function temporary(node, duration) {
    layer.append(node); transient.add(node);
    if (transient.size > 60) { const old = transient.values().next().value; old.remove(); transient.delete(old); }
    setTimeout(() => { node.remove(); transient.delete(node); }, duration);
    return node;
  }
  function unique(id) {
    if (seen.has(id)) return false;
    seen.add(id); if (seen.size > 128) seen.delete(seen.values().next().value);
    return true;
  }
  function bubble(playerId, text) {
    bubbles.get(playerId)?.node.remove(); clearTimeout(bubbles.get(playerId)?.timer);
    const node = document.createElement('div'); node.className = 'comic-bubble'; node.textContent = text;
    const name = room?.players.find(p => p.id === playerId)?.nickname ?? '玩家';
    node.setAttribute('aria-label', `${name}说：${text}`);
    layer.append(node);
    const timer = setTimeout(() => { node.remove(); bubbles.delete(playerId); }, 5500);
    bubbles.set(playerId, { node, timer }); place();
  }
  function place() {
    for (const [id, item] of bubbles) {
      const target = seat(id); const p = center(target);
      item.node.style.left = `${Math.max(104, Math.min(innerWidth - 104, p.x))}px`;
      item.node.style.top = `${Math.max(70, p.y - (target?.clientHeight ?? 30) / 2 - 8)}px`;
    }
    const active = new Map(voiceMembers.map(m => [m.playerId, '🎙 正在说话']));
    for (const [id] of speakers) if (!active.has(id)) active.set(id, '✎ 正在转文字');
    for (const [id, node] of badges) if (!active.has(id)) { node.remove(); badges.delete(id); }
    for (const [id, label] of active) {
      let node = badges.get(id);
      if (!node) { node = document.createElement('span'); node.className = 'speaking-badge'; badges.set(id, node); layer.append(node); }
      node.textContent = label;
      const target = seat(id); const p = center(target);
      node.style.left = `${Math.max(56, Math.min(innerWidth - 56, p.x))}px`;
      node.style.top = `${Math.max(25, p.y - (target?.clientHeight ?? 30) / 2 - 22)}px`;
      node.hidden = !room?.game || document.hidden;
    }
  }
  async function command(type, payload) {
    if (!connected || !room?.game) throw new Error('请先连接并进入牌桌');
    return send(type, { gameId: room.game.id, ...payload });
  }
  function stopText(discard = false) {
    const item = recording;
    if (!item || item.stopping) return;
    item.stopping = true; item.discard = discard; clearTimeout(item.timer);
    try { discard ? item.recognition.abort() : item.recognition.stop(); } catch {}
    item.finishTimer = setTimeout(() => finishText(item), 1600);
    render();
  }
  async function finishText(item) {
    if (item.finished) return;
    item.finished = true; clearTimeout(item.timer); clearTimeout(item.finishTimer);
    if (recording === item) recording = null;
    const text = item.transcript.trim().slice(0, 320);
    try {
      await item.started;
      if (item.cancelled || room?.game?.id !== item.gameId) return;
      if (!item.discard && text) await send('SOCIAL_TEXT', { gameId: item.gameId, sessionId: item.id, text: [...text].slice(0, 160).join('') });
      else if (!item.discard) notify('没有识别到文字，可以重试或打开聊天输入');
    } catch (error) { if (!item.discard) notify(error.message, true); }
    finally {
      if (connected && room?.game?.id === item.gameId) void send('SOCIAL_END', { gameId: item.gameId, sessionId: item.id }).catch(() => {});
      render();
    }
  }
  function startText() {
    if (recording || !canRecognize || !connected || !room?.game) return;
    stopVoice();
    const recognition = new Recognition(); recognition.lang = 'zh-CN'; recognition.continuous = true; recognition.interimResults = true;
    const item = { id: crypto.randomUUID(), gameId: room.game.id, recognition, transcript: '', started: null };
    recording = item;
    item.started = command('SOCIAL_START', { sessionId: item.id, mode: 'text' });
    item.started.catch(error => { notify(error.message, true); stopText(true); });
    recognition.onresult = event => {
      item.transcript = Array.from(event.results, result => result[0].transcript).join('');
      $('speechPreview').textContent = item.transcript || '正在听…';
    };
    recognition.onerror = event => {
      if (event.error !== 'aborted') notify(event.error === 'not-allowed' ? '请允许麦克风和语音识别权限' : '识别不可用，请使用聊天输入', true);
      item.discard = true;
    };
    recognition.onend = () => { void finishText(item); };
    try { recognition.start(); item.timer = setTimeout(() => stopText(), 13000); }
    catch (error) { item.discard = true; void finishText(item); notify(error.message, true); }
    render();
  }
  const textButton = $('holdText');
  textButton.addEventListener('pointerdown', event => {
    if (event.button !== 0) return; event.preventDefault(); textButton.setPointerCapture(event.pointerId); startText();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) textButton.addEventListener(type, () => stopText());
  textButton.addEventListener('contextmenu', e => e.preventDefault());
  textButton.addEventListener('keydown', e => { if ([' ', 'Enter'].includes(e.key)) { e.preventDefault(); if (!e.repeat) startText(); } });
  textButton.addEventListener('keyup', e => { if ([' ', 'Enter'].includes(e.key)) { e.preventDefault(); stopText(); } });
  window.addEventListener('uno-voice-start', () => stopText(true));
  window.addEventListener('blur', () => { stopText(true); cancelAim(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopText(true); cancelAim(); } place(); });
  window.addEventListener('pagehide', () => stopText(true));

  function cancelAim() {
    aim = null; drag?.ghost.remove(); drag = null;
    document.body.classList.remove('aiming-emote');
    for (const node of document.querySelectorAll('.emote-target')) node.classList.remove('emote-target');
    $('reactionHint').textContent = '拖到朋友头像上，或点表情再点朋友；笑哭表情点一下即可。';
    for (const node of document.querySelectorAll('.table-seat[data-aim-tab]')) { node.removeAttribute('tabindex'); delete node.dataset.aimTab; }
  }
  function selectAim(emote) {
    cancelAim(); aim = emote; document.body.classList.add('aiming-emote');
    $('reactionHint').textContent = `已选择${labels[emote]}，点朋友头像发送；按 Esc 取消。`;
    for (const node of document.querySelectorAll('.table-seat')) if (node.dataset.playerId !== room?.you.playerId) { node.tabIndex = 0; node.dataset.aimTab = ''; }
  }
  function hit(x, y) {
    return [...document.querySelectorAll('.table-seat')].find(node => {
      const r = node.getBoundingClientRect(); return node.dataset.playerId !== room?.you.playerId && room?.players.some(p => p.id === node.dataset.playerId) && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
  }
  async function emote(name, targetPlayerId) {
    cancelAim();
    try { await command('SOCIAL_EMOTE', { emote: name, targetPlayerId }); } catch (error) { notify(error.message, true); }
  }
  for (const name of Object.keys(icons)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'reaction-button';
    button.textContent = icons[name]; button.title = labels[name]; button.setAttribute('aria-label', labels[name]); button.dataset.emote = name;
    let suppressClick = false;
    button.onclick = () => {
      if (suppressClick) { suppressClick = false; return; }
      if (targeted.has(name)) selectAim(name); else void emote(name, room?.you.playerId);
    };
    if (targeted.has(name)) {
      button.onpointerdown = event => {
        if (event.button !== 0 || !connected || !room?.game) return;
        suppressClick = false; button.setPointerCapture(event.pointerId);
        const ghost = document.createElement('div'); ghost.className = 'reaction-ghost'; ghost.textContent = icons[name]; ghost.hidden = true; layer.append(ghost);
        drag = { ghost, name, x: event.clientX, y: event.clientY, moved: false };
      };
      button.onpointermove = event => {
        if (!drag || drag.name !== name) return;
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 8) drag.moved = true;
        if (!drag.moved) return;
        drag.ghost.hidden = false; drag.ghost.style.left = `${event.clientX}px`; drag.ghost.style.top = `${event.clientY}px`;
        for (const node of document.querySelectorAll('.emote-target')) node.classList.remove('emote-target');
        hit(event.clientX, event.clientY)?.classList.add('emote-target');
      };
      button.onpointerup = event => {
        if (!drag) return;
        const moved = drag.moved; const target = hit(event.clientX, event.clientY);
        cancelAim();
        if (moved) { suppressClick = true; if (target) void emote(name, target.dataset.playerId); else notify('请松手到其他玩家的头像上'); }
      };
      button.onpointercancel = () => { suppressClick = true; cancelAim(); };
      button.onlostpointercapture = () => { if (drag) cancelAim(); };
    }
    $('reactionPalette').append(button);
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('.table-seat');
    if (aim && target && target.dataset.playerId !== room?.you.playerId) { event.preventDefault(); void emote(aim, target.dataset.playerId); }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') cancelAim();
    if (aim && event.key === 'Enter' && event.target.matches('.table-seat')) { event.preventDefault(); void emote(aim, event.target.dataset.playerId); }
  });
  function animateEmote(event) {
    if (document.hidden) return;
    const target = seat(event.targetPlayerId); const to = center(target); const from = center(seat(event.playerId));
    const node = document.createElement('div'); node.className = 'social-projectile'; node.textContent = icons[event.emote];
    temporary(node, 2300);
    const move = targeted.has(event.emote);
    node.style.left = `${move ? from.x : to.x}px`; node.style.top = `${move ? from.y : to.y - 60}px`;
    const duration = reduced.matches ? 120 : move ? 950 : 1400;
    const frames = move ? [
      { transform: 'translate(-50%,-50%) scale(.5) rotate(-30deg)', opacity: 0 },
      { transform: `translate(calc(-50% + ${(to.x - from.x) * .5}px),calc(-50% + ${(to.y - from.y) * .5 - 90}px)) scale(1.4) rotate(90deg)`, opacity: 1, offset: .5 },
      { transform: `translate(calc(-50% + ${to.x - from.x}px),calc(-50% + ${to.y - from.y}px)) scale(1) rotate(210deg)`, opacity: 1 }
    ] : [{ transform: 'translate(-50%,0) scale(.2)', opacity: 0 }, { transform: 'translate(-50%,-12px) scale(1.3) rotate(-12deg)', opacity: 1, offset: .3 }, { transform: 'translate(-50%,-24px) scale(1) rotate(12deg)', opacity: 0 }];
    const motion = node.animate(reduced.matches ? [{ opacity: 0 }, { opacity: 1 }] : frames, { duration, easing: 'ease-in-out', fill: 'forwards' });
    motion.finished.then(() => {
      node.remove();
      if (!move || !room?.game || document.hidden) return;
      const impact = document.createElement('div'); impact.className = `social-impact ${event.emote}`;
      impact.textContent = event.emote === 'egg' ? '🍳' : event.emote === 'flowers' ? '💐 💕' : '🩴';
      impact.style.left = `${to.x}px`; impact.style.top = `${to.y - 25}px`; temporary(impact, 1300);
    }).catch(() => {});
  }
  function receive(event) {
    if (!room?.game || event.roomCode !== room.roomCode || event.gameId !== room.game.id || !unique(event.id)) return;
    if (event.kind === 'text') bubble(event.playerId, event.text);
    else if (event.kind === 'start') speakers.set(event.playerId, event.sessionId);
    else if (event.kind === 'end' && speakers.get(event.playerId) === event.sessionId) speakers.delete(event.playerId);
    else if (event.kind === 'emote') animateEmote(event);
    place();
  }
  function clear() {
    stopText(true); if (recording) recording.cancelled = true;
    cancelAim(); speakers.clear(); voiceMembers = []; seen.clear();
    for (const { node, timer } of bubbles.values()) { node.remove(); clearTimeout(timer); } bubbles.clear();
    for (const node of badges.values()) node.remove(); badges.clear();
    for (const node of transient) { node.getAnimations().forEach(a => a.cancel()); node.remove(); } transient.clear();
  }
  function setRoom(next) {
    if (room?.game?.id !== next?.game?.id || room?.roomCode !== next?.roomCode) clear();
    room = next; connected = !!next;
    speakers.clear(); for (const s of next?.social?.speakers ?? []) speakers.set(s.playerId, s.sessionId);
    voiceMembers = next?.voiceMembers ?? []; render();
  }
  function render() {
    textButton.disabled = !connected || !room?.game || !canRecognize;
    textButton.classList.toggle('recording', !!recording && !recording.stopping);
    textButton.textContent = recording ? recording.stopping ? '识别中…' : '松手转文字' : '按住转文字';
    textButton.setAttribute('aria-pressed', String(!!recording && !recording.stopping));
    textButton.title = canRecognize ? '按住说话，松手后在头顶显示文字（最长 13 秒）' : '此浏览器不支持语音识别，或当前地址不安全；可以打开聊天输入';
    $('speechPreview').hidden = !recording;
    for (const b of $('reactionPalette').children) b.disabled = !connected || !room?.game;
    place();
  }
  window.addEventListener('resize', place); window.addEventListener('scroll', place, { capture: true, passive: true });
  return { setRoom, receive, render,
    disconnect: () => { connected = false; clear(); render(); },
    voiceActivity: data => { if (data.roomCode === room?.roomCode) { voiceMembers = data.members; place(); } },
    chatMessage: data => {
      if (!room?.game || data.roomCode !== room.roomCode || data.chatId !== room.chatId || !unique(data.message.id)) return;
      const m = data.message;
      bubble(m.playerId, m.kind === 'text' ? [...m.text].slice(0, 160).join('') : m.kind === 'image' ? '🖼 发来一张图片' : `${stickers.find(s => s.id === m.stickerId)?.label ?? '表情'}`);
    }
  };
}
