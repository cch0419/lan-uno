const colors = { red: '红色', yellow: '黄色', green: '绿色', blue: '蓝色' };

/** Visual effects consume public events only; they never decide game state. */
export function createEffects({ createCard, getState, playerName, playSound = () => {} }) {
  const layer = document.getElementById('motionLayer');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const flights = new Set();
  const transientNodes = new Set();
  let announcementQueue = [];
  let announcing = false;
  let announcementTimer;

  const rect = node => node?.getBoundingClientRect();
  const seat = id => [...document.querySelectorAll('.table-seat')].find(node => node.dataset.playerId === id);
  const center = box => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function temporary(node, life = 1500) {
    transientNodes.add(node); layer.append(node);
    setTimeout(() => { node.remove(); transientNodes.delete(node); }, life);
    return node;
  }

  async function fly(node, from, to, { delay = 0, startScale = 1, endScale = 1, tilt = -12 } = {}) {
    if (!from || !to || document.hidden || reduced.matches) return;
    node.classList.add('flying-card');
    layer.append(node);
    const size = rect(node);
    const origin = center(from); const destination = center(to);
    const dx = origin.x - size.width / 2; const dy = origin.y - size.height / 2;
    const tx = destination.x - size.width / 2; const ty = destination.y - size.height / 2;
    const motion = node.animate([
      { transform: `translate(${dx}px,${dy}px) rotate(${tilt}deg) scale(${startScale})`, opacity: .4 },
      { transform: `translate(${dx}px,${dy - 20}px) rotate(${tilt}deg) scale(${startScale * 1.08})`, opacity: 1, offset: .18 },
      { transform: `translate(${(dx + tx) / 2}px,${(dy + ty) / 2 - 65}px) rotate(${tilt / 2}deg) scale(${Math.max(startScale, endScale) * 1.15})`, opacity: 1, offset: .55 },
      { transform: `translate(${tx}px,${ty}px) rotate(0deg) scale(${endScale})`, opacity: 1 }
    ], { duration: 1050, delay, easing: 'cubic-bezier(.3,.05,.2,1)', fill: 'both' });
    flights.add(motion);
    try { await motion.finished; } catch { /* canceled by room/game transition */ }
    finally { flights.delete(motion); node.remove(); }
  }

  function stamp(text, playerId, kind) {
    if (document.hidden) return;
    const target = rect(seat(playerId));
    if (!target) return;
    const point = center(target);
    const node = document.createElement('div');
    node.className = `seat-stamp ${kind}${reduced.matches ? ' reduced' : ''}`;
    node.style.left = `${Math.max(45, Math.min(innerWidth - 45, point.x))}px`;
    node.style.top = `${point.y}px`;
    const symbol = document.createElement('strong'); symbol.textContent = text;
    const label = document.createElement('small'); label.textContent = kind === 'skip-stamp' ? '本轮跳过' : '罚抽两张';
    node.append(symbol, label);
    temporary(node, 2100);
    seat(playerId)?.animate(reduced.matches ? [{ opacity: .6 }, { opacity: 1 }] : [
      { transform: 'translate(-50%,-50%) scale(1)' },
      { transform: 'translate(-50%,-50%) scale(.9)', offset: .25 },
      { transform: 'translate(-50%,-50%) scale(1)' }
    ], { duration: 450 });
  }

  function burst(kind, color) {
    if (document.hidden) return;
    const target = rect(document.getElementById('topCard'));
    if (!target) return;
    const point = center(target);
    const node = document.createElement('div');
    node.className = `central-burst ${kind} color-${color ?? 'green'}${reduced.matches ? ' reduced' : ''}`;
    node.style.left = `${Math.max(125, Math.min(innerWidth - 125, point.x))}px`;
    node.style.top = `${point.y}px`;
    const halo = document.createElement('span'); halo.className = 'burst-halo';
    const title = document.createElement('strong');
    title.textContent = kind === 'wild4-burst' ? '+4' : kind === 'reverse-burst' ? '⇄' : '变色！';
    const subtitle = document.createElement('small');
    subtitle.textContent = kind === 'reverse-burst' ? '轮转方向反转' : `接下来跟${colors[color]}`;
    node.append(halo, title, subtitle);
    temporary(node, 2100);
  }

  async function animateEvents(events, previous, next, isCurrent = () => true) {
    if (document.hidden) return;
    if (reduced.matches) { for (const event of events) { if (isCurrent()) playSound(event); } return; }
    for (const event of events) {
      if (!isCurrent()) return;
      playSound(event);
      if (event.kind === 'played') {
        const own = event.playerId === previous.you.playerId;
        const cardNode = own ? [...document.querySelectorAll('#hand .playing-card')].find(node => node.dataset.cardId === event.card.id) : null;
        const source = rect(cardNode ?? seat(event.playerId));
        if (cardNode) cardNode.classList.add('leaving');
        await fly(createCard(event.card), source, rect(document.getElementById('topCard')), { startScale: own ? 1 : .38 });
        if (!isCurrent()) return;
        // Keep the landed card visible while penalties continue animating.
        // This is presentation of an already accepted event, not a new move.
        const landed = createCard(event.card);
        landed.classList.add('card-settle');
        document.getElementById('topCard').replaceChildren(landed);
        const ripple = document.createElement('div'); ripple.className = 'card-impact';
        const landing = center(rect(document.getElementById('topCard')));
        ripple.style.left = `${landing.x}px`; ripple.style.top = `${landing.y}px`; temporary(ripple, 900);
        document.getElementById('roundTable').dataset.color = event.color;
        document.getElementById('roundTable').setAttribute('aria-label', `${colors[event.color]}牌桌`);
        if (event.card.kind === 'wild' || event.card.kind === 'wild4') burst(`${event.card.kind}-burst`, event.color);
      } else if (event.kind === 'skipped') {
        stamp('⊘', event.targetId, 'skip-stamp');
      } else if (event.kind === 'reversed') {
        burst('reverse-burst');
      } else if (['drawn', 'penalty', 'accepted', 'challenge_won', 'challenge_lost', 'caught_uno'].includes(event.kind)) {
        const targetId = event.targetId ?? event.playerId;
        if (event.kind === 'penalty') { stamp('+2', targetId, 'draw-stamp'); await sleep(300); }
        if (!isCurrent()) return;
        const source = rect(document.getElementById('drawPile'));
        const own = targetId === next.you.playerId;
        const destination = rect(own ? document.getElementById('hand') : seat(targetId));
        const count = Math.min(event.count, 6);
        await Promise.all(Array.from({ length: count }, (_, index) => {
          const back = document.createElement('div'); back.className = 'card-back';
          const label = document.createElement('span'); label.textContent = 'UNO'; back.append(label);
          return fly(back, source, destination, { delay: index * 100, startScale: .85, endScale: own ? .85 : .32, tilt: index % 2 ? 12 : -12 });
        }));
      }
    }
  }

  function pumpAnnouncements() {
    if (announcing || !announcementQueue.length || document.hidden) return;
    const item = announcementQueue.shift();
    const current = getState();
    if (item.kind === 'turn' && (!current?.game || current.game.id !== item.gameId ||
        current.game.turnId !== item.turnId || current.game.currentPlayerId !== current.you.playerId || current.game.paused)) {
      pumpAnnouncements(); return;
    }
    const node = document.getElementById('announcement');
    node.className = `announcement ${item.kind}${reduced.matches ? ' reduced' : ''}`;
    document.getElementById('announcementTitle').textContent = item.title;
    document.getElementById('announcementDetail').textContent = item.detail;
    node.hidden = false;
    // Restart the CSS entrance even if the preceding announcement had same kind.
    node.style.animation = 'none'; void node.offsetWidth; node.style.animation = '';
    announcing = true;
    announcementTimer = setTimeout(() => {
      node.hidden = true; announcing = false; pumpAnnouncements();
    }, reduced.matches ? 1100 : 2000);
  }

  function afterSnapshot(previous, next, events) {
    if (!next?.game || document.hidden) return;
    for (const event of events) {
      if (event.kind === 'uno') announcementQueue.push({ kind: 'uno', title: 'UNO!', detail: `${playerName(event.playerId)} 只剩一张牌了！` });
      if (event.kind === 'caught_uno') announcementQueue.push({ kind: 'uno', title: '抓漏成功！', detail: `${playerName(event.targetId)} 罚抽 ${event.count} 张` });
      if (event.kind === 'player_finished') announcementQueue.push({ kind: 'finish', title: `第 ${event.rank} 名 · 完赛！`, detail: `${playerName(event.playerId)} 已出完手牌` });
    }
    const game = next.game;
    const turnChanged = previous?.game?.id !== game.id || previous.game.turnId !== game.turnId || previous.game.paused;
    if (turnChanged && !game.paused && game.phase !== 'finished' && game.currentPlayerId === next.you.playerId) {
      announcementQueue = announcementQueue.filter(item => item.kind !== 'turn');
      announcementQueue.push({ kind: 'turn', title: '轮到你了！！！',
        detail: game.phase === 'wild4_response' ? '选择接受 +4，或发起质疑' : '出一张牌，或摸一张结束回合',
        gameId: game.id, turnId: game.turnId });
    }
    pumpAnnouncements();
  }

  function reset() {
    for (const motion of flights) motion.cancel();
    for (const node of transientNodes) node.remove();
    transientNodes.clear();
    announcementQueue = []; announcing = false;
    clearTimeout(announcementTimer);
    document.getElementById('announcement').hidden = true;
  }

  return { animateEvents, afterSnapshot, reset };
}
