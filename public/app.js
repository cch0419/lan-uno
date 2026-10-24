import { layoutSeats } from './table-layout.js';
import { createEffects } from './effects.js';
import { createSounds } from './sounds.js';
import { layoutHand } from './hand-layout.js';
import { createVoice } from './voice.js';
import { createChat } from './chat.js';

const $ = id => document.getElementById(id);
const compactGame = window.matchMedia('(max-width: 720px), (max-width: 1000px) and (max-height: 500px) and (orientation: landscape)');
const colorNames = { red: '红色', yellow: '黄色', green: '绿色', blue: '蓝色' };
const symbols = { skip: '⊘', reverse: '↻', draw2: '+2', wild: '变色', wild4: '+4' };
const kindNames = { skip: '跳过', reverse: '反转', draw2: '+2', wild: '变色', wild4: '变色 +4' };
let state = null;
let socket = null;
let ready = false;
let busy = false;
let shouldReconnect = true;
let attempt = 0;
let retryTimer;
let connectPromise;
let connectResolve;
let connectReject;
let handshakeTimer;
let toastTimer;
let requestSequence = 0;
let colorSelection = null;
let confirmAction = null;
let animating = false;
let snapshotQueue = [];
let drainingSnapshots = false;
let visualEpoch = 0;
let freshCardIds = new Set();
let serverOffset = 0;
let lastClockReady = false;
const requests = new Map();
const clientPrefix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const effects = createEffects({ createCard: card => cardElement(card), getState: () => state, playerName: nameOf,
  playSound: event => sounds.playEvent(event) });

// Storage can be unavailable in private/restricted browsers; the game still
// works for this tab, but recovery then lasts only for this page lifetime.
const memoryStorage = new Map();
function readStorage(key) {
  try { return localStorage.getItem(key) ?? memoryStorage.get(key); }
  catch { return memoryStorage.get(key); }
}
function writeStorage(key, value) {
  memoryStorage.set(key, value);
  try { localStorage.setItem(key, value); } catch { /* session-only fallback */ }
}

const sounds = createSounds({ readStorage, writeStorage });
const voice = createVoice({ send: request, notify: toast });
const chat = createChat({ send: request, notify: toast });

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
}

function status(text, mode = '') {
  $('connectionText').textContent = text;
  $('connectionDot').className = `status-dot ${mode}`;
  $('reconnect').hidden = ready || !readStorage('uno.token');
}

function rawSend(type, payload, requestId) {
  socket.send(JSON.stringify({ type, payload, requestId }));
}

function connect() {
  if (ready) return Promise.resolve();
  if (connectPromise) return connectPromise;
  const nickname = $('nickname').value.trim();
  if ([...nickname].length < 1 || [...nickname].length > 16) {
    return Promise.reject(new Error('请先输入 1～16 个字符的昵称'));
  }
  writeStorage('uno.nickname', nickname);
  clearTimeout(retryTimer);
  shouldReconnect = true;
  status('正在连接牌桌…');
  connectPromise = new Promise((resolve, reject) => { connectResolve = resolve; connectReject = reject; });
  const thisSocket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket = thisSocket;
  handshakeTimer = setTimeout(() => { thisSocket.close(); }, 10_000);
  thisSocket.onopen = () => {
    if (socket !== thisSocket) return;
    rawSend('HELLO', { nickname, resumeToken: readStorage('uno.token') }, `${clientPrefix}-hello-${++requestSequence}`);
  };
  thisSocket.onmessage = event => {
    if (socket !== thisSocket) return;
    try { receive(JSON.parse(event.data)); }
    catch (error) { console.error(error); toast('页面同步失败，请重新连接', true); }
  };
  thisSocket.onclose = event => {
    if (socket !== thisSocket) return;
    clearTimeout(handshakeTimer);
    ready = false;
    voice.disconnect();
    chat.disconnect();
    connectReject?.(new Error('连接失败，请确认主机服务正在运行'));
    connectPromise = null; connectResolve = null; connectReject = null;
    for (const entry of requests.values()) { clearTimeout(entry.timer); entry.reject(new Error('连接已断开，恢复后将同步最新状态')); }
    requests.clear();
    if (event.code === 4001) shouldReconnect = false;
    status(shouldReconnect ? '连接断开，正在恢复…' : '已由其他标签页接管', 'offline');
    render();
    if (shouldReconnect && readStorage('uno.token')) {
      retryTimer = setTimeout(() => connect().catch(() => {}), Math.min(1000 * 2 ** attempt++, 10_000));
    }
  };
  thisSocket.onerror = () => { status('连接出现问题', 'offline'); };
  return connectPromise;
}

function request(type, payload = {}) {
  if (!ready || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('连接尚未恢复'));
  const requestId = `${clientPrefix}-${++requestSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requests.delete(requestId);
      reject(new Error('响应超时，正在重新同步；请不要重复提交'));
      socket.close();
    }, 8000);
    requests.set(requestId, { resolve, reject, timer });
    rawSend(type, payload, requestId);
  });
}

async function execute(type, payload = {}) {
  if (busy || animating) return;
  busy = true; render();
  try { await connect(); await request(type, payload); }
  catch (error) { toast(error.message, true); }
  finally { busy = false; render(); }
}

function gameCommand(type, payload = {}) {
  if (!state?.game) return;
  return execute(type, { gameId: state.game.id, turnId: state.game.turnId, ...payload });
}

function receive({ type, payload }) {
  if (type === 'SESSION') {
    ready = true; attempt = 0; clearTimeout(handshakeTimer);
    writeStorage('uno.token', payload.resumeToken);
    writeStorage('uno.nickname', payload.nickname);
    $('nickname').value = payload.nickname;
    connectResolve?.(); connectPromise = null; connectResolve = null; connectReject = null;
    status(`${payload.nickname} · 已连接`, 'online');
    if (payload.previousSessionExpired) toast('之前的会话已失效，已建立新身份。服务重启后需要重新建房。');
    render();
  } else if (type === 'STATE') {
    voice.setRoom(payload);
    chat.setRoom(payload);
    if (payload?.serverTime) serverOffset = payload.serverTime - Date.now();
    enqueueSnapshot(payload);
  } else if (type === 'COMMAND_RESULT') {
    const entry = requests.get(payload.requestId);
    if (entry) {
      clearTimeout(entry.timer); requests.delete(payload.requestId);
      if (payload.ok) entry.resolve(payload);
      else entry.reject(new Error(payload.message ?? payload.code));
    } else if (!payload.ok && !ready) {
      shouldReconnect = false;
      connectReject?.(new Error(payload.message));
      socket.close();
    }
  } else if (type === 'ROOM_CLOSED') {
    voice.disconnect();
    chat.setRoom(null);
    enqueueSnapshot(null);
    toast('房间已解散'); render();
  } else if (type === 'SESSION_REPLACED') {
    voice.disconnect();
    chat.disconnect();
    shouldReconnect = false; ready = false;
    toast('你已在另一个标签页入座。此窗口停止连接。'); render();
  } else if (type === 'VOICE_ROSTER' || type === 'VOICE_SIGNAL') {
    voice.receive(type, payload);
  } else if (type === 'CHAT_HISTORY' || type === 'CHAT_MESSAGE') {
    chat.receive(type, payload);
  } else if (type === 'CHALLENGE_EVIDENCE') {
    $('evidenceTitle').textContent = payload.wasLegal ? '质疑失败' : '质疑成功';
    $('evidenceText').textContent = `${nameOf(payload.actorId)} 出牌前的生效颜色是${colorNames[payload.previousColor]}。${payload.wasLegal ? '手中没有该颜色的牌，你罚抽 6 张并跳过。' : '手中有该颜色的牌，对方罚抽 4 张，继续你的回合。'}`;
    $('evidenceCards').replaceChildren(...payload.handBeforePlay.map(card => cardElement(card)));
    if (!$('evidenceDialog').open) $('evidenceDialog').showModal();
  }
}

function commitSnapshot(next) {
  state = next;
  if (colorSelection && (!state?.game || state.game.paused ||
      state.game.id !== colorSelection.gameId || state.game.turnId !== colorSelection.turnId)) {
    $('colorDialog').close(); colorSelection = null;
  }
}

function enqueueSnapshot(next) {
  const latest = snapshotQueue.at(-1)?.snapshot ?? state;
  if (next && latest?.roomCode === next.roomCode && next.revision <= latest.revision) return;
  // Room exits, restarts and pauses invalidate flights immediately. A late
  // animation completion must never resurrect a closed room or unpause a game.
  if (!next?.game || !state?.game || next.game.id !== state.game.id || next.game.paused) {
    const previous = state;
    visualEpoch++;
    effects.reset(); sounds.reset(); snapshotQueue = []; animating = false; freshCardIds.clear();
    commitSnapshot(next); render(); effects.afterSnapshot(previous, next, []);
    return;
  }
  snapshotQueue.push({ snapshot: next, skipAnimation: false });
  if (snapshotQueue.length > 4) snapshotQueue = [{ snapshot: next, skipAnimation: true }];
  drainSnapshots();
}

async function drainSnapshots() {
  if (drainingSnapshots) return;
  drainingSnapshots = true;
  try {
    while (snapshotQueue.length) {
      const { snapshot: next, skipAnimation } = snapshotQueue.shift();
      const previous = state;
      const epoch = visualEpoch;
      const events = next.game.log.filter(event => event.sequence > previous.game.eventSequence);
      animating = events.length > 0;
      render();
      if (!skipAnimation) {
        try { await effects.animateEvents(events, previous, next, () => epoch === visualEpoch); }
        catch (error) { console.error('Animation skipped:', error); }
      }
      if (epoch !== visualEpoch) continue;
      if (!skipAnimation) sounds.afterSnapshot(previous, next, events);
      const oldIds = new Set(previous.you.hand.map(card => card.id));
      freshCardIds = new Set(next.you.hand.filter(card => !oldIds.has(card.id)).map(card => card.id));
      animating = snapshotQueue.length > 0;
      commitSnapshot(next); render(); effects.afterSnapshot(previous, next, events);
    }
  } finally { drainingSnapshots = false; animating = false; render(); }
}

function nameOf(id) { return state?.players.find(player => player.id === id)?.nickname ?? '玩家'; }
function describeCard(card) { return `${colorNames[card.color] ?? ''}${card.kind === 'number' ? ` ${card.value}` : kindNames[card.kind]}`; }
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function cardElement(card, interactive = false, playable = false) {
  const node = element(interactive ? 'button' : 'div', `playing-card ${card.color ?? card.kind}${playable ? ' playable' : ''}`);
  node.setAttribute('aria-label', describeCard(card));
  node.dataset.cardId = card.id;
  node.title = describeCard(card);
  const symbol = card.kind === 'number' ? String(card.value) : symbols[card.kind];
  node.append(element('span', 'card-corner', symbol), element('span', 'card-center', symbol),
    element('span', 'card-color-label', colorNames[card.color] ?? '任意颜色'));
  if (interactive) {
    node.disabled = !ready || busy || animating || !playable;
    node.onclick = () => {
      if (card.kind === 'wild' || card.kind === 'wild4') openColors(card.id);
      else gameCommand('PLAY_CARD', { cardId: card.id });
    };
  }
  return node;
}

function openColors(cardId = null) {
  if (!ready || busy || animating || !state?.game || state.game.paused) return;
  colorSelection = { cardId, gameId: state.game.id, turnId: state.game.turnId };
  $('colorDialog').showModal();
}

function showConfirm(title, text, callback) {
  $('confirmTitle').textContent = title; $('confirmText').textContent = text;
  confirmAction = callback; $('confirmDialog').showModal();
}

function render() {
  document.body.classList.toggle('in-game', !!state?.game);
  $('chatGameStatus').hidden = !state?.game;
  $('home').hidden = !!state;
  $('room').hidden = !state;
  $('nickname').disabled = ready || busy;
  $('identityHint').textContent = ready ? '身份已连接，刷新页面会回到原来的座位。' : '1–16 个字符，同一浏览器会记住你的身份。';
  $('createRoom').disabled = busy;
  $('joinRoom').disabled = busy;
  if (!state) return;
  const host = state.hostId === state.you.playerId;
  const enabled = ready && !busy && !animating;
  $('roomCode').textContent = state.roomCode;
  $('roomStatus').textContent = { waiting: '等待入座', playing: '对局中', finished: '本局结束' }[state.status];
  $('closeRoom').hidden = !host;
  $('closeRoom').disabled = !enabled;
  $('leaveRoom').disabled = !enabled;
  $('lobby').hidden = !!state.game;
  $('game').hidden = !state.game;
  $('pauseBanner').hidden = !state.game?.paused || state.status === 'finished';
  $('pauseBanner').textContent = `等待 ${state.players.filter(p => p.isParticipating && !p.isFinished && !p.online).map(p => p.nickname).join('、')} 重新连接。计时已暂停；掉线保留 ${state.disconnectGraceSeconds} 秒，超时会中止本局。`;
  if (!state.game) renderLobby(host, enabled);
  else renderGame(host, enabled);
}

function renderLobby(host, enabled) {
  const participants = state.players.filter(player => player.isParticipating);
  const spectatorCount = state.players.length - participants.length;
  $('playerCount').textContent = `玩家 ${participants.length} / ${state.maxPlayers}${spectatorCount ? ` · 旁观 ${spectatorCount}` : ''}`;
  $('lobbyPlayers').replaceChildren();
  for (const player of state.players) {
    const row = element('div', 'lobby-player');
    row.append(element('span', 'avatar', [...player.nickname][0]));
    const detail = element('div', 'player-detail');
    detail.append(element('strong', '', `${player.nickname}${player.id === state.you.playerId ? '（你）' : ''}`),
      element('small', '', `${player.id === state.hostId ? '房主 · ' : ''}${player.isParticipating ? '玩家' : '仅管理／旁观'} · ${player.online ? '在线' : '暂时离线'}`));
    row.append(detail);
    if (host && player.online && player.id !== state.you.playerId) {
      const transfer = element('button', 'text-button transfer', '移交房主');
      transfer.disabled = !enabled;
      transfer.onclick = () => execute('HOST_TRANSFER', { targetPlayerId: player.id });
      row.append(transfer);
    }
    $('lobbyPlayers').append(row);
  }
  $('hostSettings').hidden = !host;
  $('participationSetting').hidden = !host;
  $('roomHostParticipates').checked = state.you.isParticipating;
  $('roomHostParticipates').disabled = !enabled;
  if (document.activeElement !== $('roomCapacity')) $('roomCapacity').value = state.maxPlayers;
  if (document.activeElement !== $('turnSeconds')) $('turnSeconds').value = state.turnSeconds;
  $('timerSettingHint').textContent = `每回合 ${state.turnSeconds} 秒 · 超时自动摸一张并结束回合 · 房主可设置 15～120 秒`;
  $('saveCapacity').disabled = !enabled;
  $('roomInfo').textContent = state.info;
  $('startGame').hidden = !host;
  const everyoneOnline = participants.every(player => player.online);
  $('startGame').disabled = !enabled || !everyoneOnline || participants.length < 2;
  $('startHint').textContent = !host ? '等房主开始，准备好你的好运气。' : participants.length < 2 ? `还需 ${2 - participants.length} 名玩家；仅管理的房主不计入开局人数。` : !everyoneOnline ? '请等待离线玩家恢复连接。' : '玩家已到齐，现在就可以开始。';
  $('shareAddress').value = location.origin;
  $('localhostHint').textContent = ['localhost', '127.0.0.1'].includes(location.hostname)
    ? '你正在使用本机地址。其他设备请使用启动终端显示的“局域网”网址。'
    : '可长按或选中地址复制。朋友需要与你处于可互通的局域网。';
}

function renderGame(host, enabled) {
  const { game, actions, you } = state;
  const actionEnabled = enabled && clockReady();
  const myTurn = game.currentPlayerId === you.playerId;
  $('handPanel').hidden = !you.isParticipating;
  $('spectatorPanel').hidden = you.isParticipating;
  $('tableMode').textContent = you.isParticipating ? '你坐在下方 · 按座次依次行动' : '房主管理视角 · 旁观本局';
  renderSeats(game, you.playerId);
  $('roundTable').dataset.color = game.activeColor ?? 'green';
  $('roundTable').dataset.phase = game.phase;
  const clockwise = game.direction === 1;
  const directionLabel = clockwise ? '顺时针' : '逆时针';
  for (const [id, arrow] of [['directionTop', clockwise ? '→' : '←'], ['directionBottom', clockwise ? '←' : '→']]) {
    const node = $(id);
    if (node.dataset.direction && node.dataset.direction !== String(game.direction)) {
      node.classList.remove('direction-changed'); void node.offsetWidth; node.classList.add('direction-changed');
    }
    node.dataset.direction = game.direction;
    node.setAttribute('aria-label', directionLabel);
    node.firstElementChild.textContent = arrow;
    node.lastElementChild.textContent = directionLabel;
  }
  $('activeColor').textContent = game.activeColor ? `跟${colorNames[game.activeColor]}` : '选择颜色';
  $('turnText').textContent = game.phase === 'finished' ? '本局结束' : game.paused ? '等待朋友重新连接' : myTurn ? '你的回合 · 出牌或摸一张' : `${nameOf(game.currentPlayerId)} 正在行动`;
  if ($('topCard').firstElementChild?.dataset.cardId !== game.topCard.id) {
    const card = cardElement(game.topCard);
    if ($('topCard').firstElementChild) card.classList.add('card-settle');
    $('topCard').replaceChildren(card);
  }
  $('deckCount').textContent = `牌堆剩 ${game.drawPileCount} 张`;
  $('phaseText').textContent = {
    choose_initial_color: '起始牌为黑色，先选择本局颜色',
    turn: myTurn ? '数字可同号 · 彩色功能牌只跟颜色' : '高亮座位正在出牌',
    wild4_response: `${nameOf(game.currentPlayerId)} 选择接受或质疑 +4`,
    finished: '本局已完成结算'
  }[game.phase];
  $('wildResponse').hidden = !actions.canRespondWild4;
  $('acceptWild4').disabled = !actionEnabled;
  $('challengeWild4').disabled = !actionEnabled;
  $('initialColor').hidden = !actions.canChooseInitialColor;
  $('initialColor').disabled = !actionEnabled;
  arrangeTableActions();
  $('drawPile').disabled = !actionEnabled || !actions.canDraw;
  $('drawCard').disabled = !actionEnabled || !actions.canDraw;
  $('handCount').textContent = you.hand.length;
  $('handHint').textContent = you.isFinished ? `你已获得第 ${you.rank} 名，继续看看朋友们的对决吧！` : !ready ? '连接恢复后才能操作' : animating || !clockReady() ? '等牌落桌，慢慢来…' : myTurn ? '点描边牌出牌 · 剩一张自动喊 UNO' : '等待轮到你 · 剩一张自动喊 UNO';
  if (game.phase === 'finished') $('handHint').textContent = you.rank ? `本局第 ${you.rank} 名 · 下一局再战！` : '本局已结束';
  renderHand(you.hand, actions.playableCardIds, actionEnabled);
  updateClock();
  for (const id of ['activityLog', 'mobileActivityLog']) {
    $(id).replaceChildren(...game.log.slice().reverse().map(event => element('li', '', eventText(event))));
    if (!game.log.length) $(id).append(element('li', '', '牌已发好，祝你好运。'));
  }
  $('gameResult').hidden = game.phase !== 'finished';
  $('winnerText').textContent = '本局排名';
  $('winnerHint').textContent = '只剩最后一位玩家，本局结束。';
  $('rankingList').replaceChildren(...game.ranking.map(entry => {
    const row = element('li', entry.playerId === you.playerId ? 'your-rank' : '');
    row.append(element('b', '', `#${entry.rank}`), element('span', '', nameOf(entry.playerId)),
      element('small', '', entry.playerId === game.lastPlayerId ? `剩 ${entry.remainingCards} 张` : '已完赛'));
    return row;
  }));
  $('returnLobby').hidden = !host;
  $('returnLobby').disabled = !enabled;
  if (!host && game.phase === 'finished') $('winnerHint').textContent += ' 等待房主返回大厅。';
}

function renderSeats(game, viewerId) {
  const ring = $('seatRing');
  const positions = layoutSeats(game.seatOrder, viewerId);
  $('roundTable').dataset.count = positions.length;
  const existing = new Map([...ring.children].map(node => [node.dataset.playerId, node]));
  for (const node of [...ring.children]) if (!game.seatOrder.includes(node.dataset.playerId)) node.remove();
  for (const position of positions) {
    const player = state.players.find(p => p.id === position.id);
    if (!player) continue;
    let node = existing.get(player.id);
    if (!node) {
      node = element('div', 'table-seat'); node.dataset.playerId = player.id; node.setAttribute('role', 'listitem');
      const head = element('div', 'seat-head'); head.append(element('span', 'avatar'), element('span', 'seat-count'));
      node.append(element('span', 'seat-number'), head, element('strong', 'seat-name'), element('small', 'seat-status'));
      ring.append(node);
    }
    const current = player.id === game.currentPlayerId && game.phase !== 'finished';
    const declared = game.unoDeclaredIds.includes(player.id) && player.handCount === 1;
    node.classList.toggle('self', player.id === viewerId);
    node.classList.toggle('current', current);
    node.classList.toggle('offline', !player.online);
    node.classList.toggle('uno', declared);
    node.classList.toggle('finished-seat', player.isFinished);
    node.style.left = `${position.x}%`; node.style.top = `${position.y}%`;
    node.setAttribute('aria-current', current ? 'true' : 'false');
    node.setAttribute('aria-label', `${player.nickname}${player.id === viewerId ? '，你' : ''}，${player.handCount} 张牌${current ? '，当前行动者' : ''}`);
    node.querySelector('.seat-number').textContent = position.index + 1;
    node.querySelector('.avatar').textContent = [...player.nickname][0];
    node.querySelector('.seat-count').textContent = player.rank ? `#${player.rank}` : declared ? 'UNO!' : `${player.handCount}`;
    node.querySelector('.seat-name').textContent = `${player.id === viewerId ? '你 · ' : ''}${player.nickname}`;
    node.querySelector('.seat-name').title = player.nickname;
    node.querySelector('.seat-status').textContent = player.isFinished ? `第 ${player.rank} 名 · 完赛` : !player.online ? '暂时离线' : current ? (game.paused ? '暂停中' : game.phase === 'wild4_response' ? '回应 +4' : '出牌中') : '等待回合';
  }
}

function renderHand(cards, playableIds, enabled) {
  const container = $('handFan');
  const existing = new Map([...container.children].map(node => [node.dataset.cardId, node]));
  const ids = new Set(cards.map(card => card.id));
  for (const node of [...container.children]) if (!ids.has(node.dataset.cardId)) node.remove();
  cards.forEach((card, index) => {
    const playable = playableIds.includes(card.id);
    let node = existing.get(card.id);
    if (!node) {
      node = cardElement(card, true, playable);
      if (freshCardIds.has(card.id)) node.classList.add('drawn-in');
    }
    node.disabled = !enabled || !playable;
    node.classList.toggle('playable', playable);
    node.classList.remove('leaving');
    if (container.children[index] !== node) container.insertBefore(node, container.children[index] ?? null);
  });
  $('hand').hidden = cards.length === 0;
  if (!cards.length) $('handScrollHint').hidden = true;
  arrangeHand();
}

function arrangeTableActions() {
  const mobile = compactGame.matches;
  const destination = $(mobile ? 'mobileTableActions' : 'tableActionsHome');
  for (const id of ['wildResponse', 'initialColor']) {
    const node = $(id);
    if (node.parentNode !== destination) destination.append(node);
  }
  $('mobileTableActions').hidden = !mobile || !state?.game ||
    !(state.actions.canRespondWild4 || state.actions.canChooseInitialColor);
}

function arrangeHand() {
  const viewport = $('hand');
  const fan = $('handFan');
  if (!viewport.clientWidth) return;
  const styles = getComputedStyle(viewport);
  const layout = layoutHand(fan.children.length, viewport.clientWidth,
    parseFloat(styles.getPropertyValue('--hand-card-width')),
    parseFloat(styles.getPropertyValue('--hand-card-height')), {
      top: parseFloat(styles.getPropertyValue('--hand-fan-top')) || 28,
      bottom: parseFloat(styles.getPropertyValue('--hand-fan-bottom')) || 24,
      maxRise: parseFloat(styles.getPropertyValue('--hand-fan-rise')) || 24
    });
  fan.style.width = `${layout.width}px`;
  fan.style.height = `${layout.height}px`;
  viewport.dataset.overflow = String(layout.overflowing ?? false);
  $('handScrollHint').hidden = !layout.overflowing;
  viewport.setAttribute('aria-label', layout.overflowing ? '扇形手牌，左右滑动查看全部牌' : '扇形手牌');
  layout.cards.forEach((position, index) => {
    const node = fan.children[index];
    node.style.left = `${position.x}px`;
    node.style.top = `${position.y}px`;
    node.style.setProperty('--fan-angle', `${position.angle}deg`);
    node.style.zIndex = index + 1;
  });
}

// The server owns the deadline; client timers only paint the remaining time.
function clockReady() {
  const clock = state?.game?.clock;
  const now = Date.now() + serverOffset;
  return !!clock && !clock.paused && now >= clock.startsAt && now < clock.deadlineAt;
}

function updateClock() {
  const clock = state?.game?.clock;
  $('turnClock').hidden = !clock;
  if (!clock) {
    if (state?.game) {
      $('chatGameTurn').textContent = '本局结束'; $('chatGameColor').textContent = ''; $('chatGameClock').textContent = '';
    }
    return;
  }
  const now = Date.now() + serverOffset;
  const settling = !clock.paused && now < clock.startsAt;
  const remaining = clock.paused ? clock.remainingMs : Math.max(0, clock.deadlineAt - Math.max(now, clock.startsAt));
  $('clockSeconds').textContent = animating ? '…' : `${Math.ceil(remaining / 1000)}s`;
  $('clockLabel').textContent = clock.paused ? '已暂停' : settling || animating ? '牌落桌后开始计时' : remaining === 0 ? '超时处理中' : state.game.phase === 'wild4_response' ? '回应倒计时' : '出牌倒计时';
  $('turnClock').classList.toggle('urgent', !clock.paused && !settling && remaining <= 10000);
  $('clockProgress').style.width = `${Math.min(100, remaining / (state.turnSeconds * 1000) * 100)}%`;
  $('chatGameTurn').textContent = clock.paused ? '对局暂停' : state.game.currentPlayerId === state.you.playerId ? '轮到你了' : `${nameOf(state.game.currentPlayerId)}的回合`;
  $('chatGameColor').textContent = state.game.activeColor ? `跟${colorNames[state.game.activeColor]}` : '待选色';
  $('chatGameClock').textContent = clock.paused ? '暂停' : settling || animating ? '落牌中' : `${Math.ceil(remaining / 1000)}s`;
  $('chatGameStatus').classList.toggle('urgent', !clock.paused && !settling && remaining <= 10000);
}

setInterval(() => {
  if (!state?.game) return;
  const available = clockReady();
  if (available !== lastClockReady) { lastClockReady = available; render(); }
  else updateClock();
}, 200);

function eventText(event) {
  const who = nameOf(event.playerId);
  switch (event.kind) {
    case 'played': return `${who} 出了${describeCard(event.card)}${event.card.color ? '' : `，选择${colorNames[event.color]}`}`;
    case 'drawn': return `${who} 摸了 ${event.count} 张，回合结束`;
    case 'uno': return `${who}：UNO！`;
    case 'timeout': return `${who} 回合超时，自动处理`;
    case 'player_finished': return `${who} 第 ${event.rank} 名完赛，其他玩家继续`;
    case 'skipped': return `${nameOf(event.targetId)} 被跳过一轮`;
    case 'reversed': return `方向反转，改为${event.direction === 1 ? '顺时针' : '逆时针'}`;
    case 'penalty': return `${nameOf(event.targetId)} 罚抽 ${event.count} 张并跳过`;
    case 'accepted': return `${who} 接受 +4，抽了 ${event.count} 张`;
    case 'challenge_won': return `${who} 质疑成功，${nameOf(event.targetId)} 抽 ${event.count} 张`;
    case 'challenge_lost': return `${who} 质疑失败，抽 ${event.count} 张并跳过`;
    case 'color': return `${who} 选择了${colorNames[event.color]}`;
    default: return '牌桌状态已更新';
  }
}

$('nickname').value = readStorage('uno.nickname') ?? '';
for (let count = 2; count <= 10; count++) {
  const option = element('option', '', `${count} 人`); option.value = count; $('roomCapacity').append(option);
}
$('createRoom').onclick = () => execute('ROOM_CREATE', {
  maxPlayers: Number($('capacity').value), hostParticipates: $('createHostParticipates').checked
});
$('joinRoom').onclick = () => execute('ROOM_JOIN', { code: $('joinCode').value.trim() });
$('joinCode').onkeydown = event => { if (event.key === 'Enter') $('joinRoom').click(); };
$('startGame').onclick = () => execute('GAME_START');
$('saveCapacity').onclick = () => execute('ROOM_UPDATE', { maxPlayers: Number($('roomCapacity').value), turnSeconds: Number($('turnSeconds').value) });
$('roomHostParticipates').onchange = () => execute('ROOM_UPDATE', { hostParticipates: $('roomHostParticipates').checked });
$('leaveRoom').onclick = () => state?.status === 'playing' && state.you.isParticipating && !state.you.isFinished
  ? showConfirm('离开这张牌桌？', '离开会中止本局，所有其他玩家返回等待大厅。', () => execute('ROOM_LEAVE'))
  : execute('ROOM_LEAVE');
$('closeRoom').onclick = () => showConfirm('解散房间？', '所有玩家将离开房间，当前对局无法恢复。', () => execute('ROOM_CLOSE'));
$('acceptConfirm').onclick = () => { $('confirmDialog').close(); confirmAction?.(); confirmAction = null; };
$('cancelConfirm').onclick = () => { $('confirmDialog').close(); confirmAction = null; };
$('returnLobby').onclick = () => execute('RETURN_TO_LOBBY');
$('drawCard').onclick = $('drawPile').onclick = () => gameCommand('DRAW_CARD');
$('acceptWild4').onclick = () => gameCommand('ACCEPT_WILD4', { pendingId: state.game.pendingWild4.id });
$('challengeWild4').onclick = () => gameCommand('CHALLENGE_WILD4', { pendingId: state.game.pendingWild4.id });
$('initialColor').onclick = () => openColors();
$('cancelColor').onclick = () => { $('colorDialog').close(); colorSelection = null; };
for (const button of $('colorOptions').children) button.onclick = () => {
  const selection = colorSelection;
  $('colorDialog').close(); colorSelection = null;
  if (!selection || !state?.game || selection.gameId !== state.game.id || selection.turnId !== state.game.turnId) return;
  if (selection.cardId) gameCommand('PLAY_CARD', { cardId: selection.cardId, chosenColor: button.dataset.color });
  else gameCommand('CHOOSE_INITIAL_COLOR', { color: button.dataset.color });
};
$('closeEvidence').onclick = () => $('evidenceDialog').close();
$('showRules').onclick = () => $('rulesDialog').showModal();
$('closeRules').onclick = () => $('rulesDialog').close();
$('reconnect').onclick = () => { attempt = 0; connect().catch(error => toast(error.message, true)); };
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(arrangeHand).observe($('hand'));
window.addEventListener('resize', () => { arrangeHand(); arrangeTableActions(); });
compactGame.addEventListener('change', arrangeTableActions);
render();
if (readStorage('uno.token') && $('nickname').value) connect().catch(() => {});
