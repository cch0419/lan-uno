/** Local-only audio: accepted public events never change the game rules. */
export function createSounds({ readStorage, writeStorage, host = window, page = document }) {
  let enabled = readStorage('uno.sound') !== 'off';
  let context;
  let master;
  const voiceBuffers = new Map();
  const loadingVoices = new Map();
  let victoryAnnounced = false;
  let cursor = 0;
  let epoch = 0;
  const sources = new Set();
  const announced = new Set();
  const button = page.getElementById('toggleSound');

  function updateButton() {
    button.textContent = enabled ? '音效：开' : '音效：关';
    button.setAttribute('aria-pressed', String(enabled));
    button.title = enabled ? '关闭游戏音效及 UNO / 胜利语音' : '开启游戏音效及 UNO / 胜利语音';
  }

  async function unlock() {
    if (!enabled) return;
    try {
      const AudioContext = host.AudioContext ?? host.webkitAudioContext;
      if (!AudioContext) return;
      context ??= new AudioContext();
      if (!master) {
        master = context.createGain();
        master.gain.value = 0.55;
        master.connect(context.destination);
      }
      if (context.state === 'suspended') await context.resume();
      // Load once after a user gesture; a failure may retry on the next gesture.
      for (const kind of ['uno', 'victory']) {
        if (voiceBuffers.has(kind) || loadingVoices.has(kind)) continue;
        loadingVoices.set(kind, host.fetch(`/audio/${kind}.wav`)
          .then(response => { if (!response.ok) throw new Error('Voice unavailable'); return response.arrayBuffer(); })
          .then(data => context.decodeAudioData(data))
          .then(buffer => { voiceBuffers.set(kind, buffer); })
          .catch(() => {})
          .finally(() => { loadingVoices.delete(kind); }));
      }
    } catch { /* Unsupported/blocked audio must never interrupt gameplay. */ }
  }

  function stop() {
    epoch++;
    for (const source of sources) { try { source.stop(); } catch { /* already ended */ } }
    sources.clear();
    cursor = 0;
  }

  function track(source, gain, start, duration) {
    source.connect(gain); gain.connect(master);
    sources.add(source);
    source.onended = () => { sources.delete(source); source.disconnect(); gain.disconnect(); };
    source.start(start); source.stop(start + duration);
  }

  function tone(start, frequency, endFrequency, duration, type = 'sine', volume = 0.2) {
    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    track(oscillator, gain, start, duration + 0.01);
  }

  function synth(kind, start) {
    // A short paper-like flick accompanies every accepted card.
    if (!['draw', 'uno', 'victory'].includes(kind)) tone(start, 1050, 180, 0.075, 'triangle', 0.18);
    const patterns = {
      number: [[0.025, 360, 180, 0.09, 'triangle']],
      skip: [[0.06, 540, 160, 0.18, 'square', 0.065]],
      reverse: [[0.06, 250, 900, 0.18, 'sine'], [0.24, 900, 250, 0.2, 'sine']],
      draw2: [[0.06, 330, 220, 0.12, 'triangle'], [0.22, 440, 220, 0.16, 'triangle']],
      wild: [392, 494, 587, 784].map((f, i) => [0.06 + i * 0.075, f, f, 0.19, 'sine']),
      wild4: [220, 277, 330, 440].map((f, i) => [0.06 + i * 0.09, f, f / 2, 0.22, 'triangle', 0.24]),
      draw: [[0, 650, 250, 0.085, 'triangle', 0.12]],
      uno: [[0, 523, 659, 0.13, 'sine'], [0.15, 784, 1046, 0.23, 'sine']],
      victory: [523, 659, 784, 1046].map((f, i) => [i * 0.11, f, f, 0.2, 'triangle'])
    };
    for (const [delay, from, to, duration, type, volume] of patterns[kind] ?? patterns.number) {
      tone(start + delay, from, to, duration, type, volume);
    }
  }

  async function play(kind) {
    // Do not create/resume a context from network messages or replay stale audio.
    if (!enabled || page.hidden || context?.state !== 'running') return;
    const currentEpoch = epoch;
    if (loadingVoices.has(kind)) await loadingVoices.get(kind);
    if (currentEpoch !== epoch || !enabled || page.hidden || context.state !== 'running') return;
    try {
      const start = Math.max(context.currentTime + 0.015, cursor);
      const voiceBuffer = voiceBuffers.get(kind);
      if (voiceBuffer) {
        const source = context.createBufferSource(); source.buffer = voiceBuffer;
        const gain = context.createGain(); gain.gain.value = 0.9;
        track(source, gain, start, voiceBuffer.duration);
        cursor = start + voiceBuffer.duration + 0.05;
      } else {
        synth(kind, start);
        cursor = start + (kind === 'number' || kind === 'draw' ? 0.13 : 0.55);
      }
    } catch { /* Audio failures do not reject the snapshot/animation pipeline. */ }
  }

  function playEvent(event) {
    if (event.kind === 'played') void play(event.card.kind);
    else if (['drawn', 'accepted', 'challenge_won', 'challenge_lost'].includes(event.kind) && event.count > 0) void play('draw');
    else if (event.kind === 'color') void play('wild');
    // reversed/skipped/penalty describe the same card, so do not play twice.
  }

  function afterSnapshot(previous, next, events) {
    if (!next?.game || previous?.game?.id !== next.game.id) { reset(); return; }
    for (const player of next.players) if (player.handCount !== 1) announced.delete(player.id);
    const candidates = new Set(events.filter(event => event.kind === 'uno').map(event => event.playerId));
    for (const player of next.players) {
      const before = previous.players.find(item => item.id === player.id);
      if (player.handCount === 1 && before?.handCount > 1 && events.some(event => event.kind === 'played' && event.playerId === player.id)) candidates.add(player.id);
    }
    for (const id of candidates) {
      if (!announced.has(id)) { announced.add(id); void play('uno'); }
    }
    // Rank 1 is emitted only after any final-card penalty has settled.
    if (!victoryAnnounced && !previous.game.winnerId &&
        events.some(event => event.kind === 'player_finished' && event.rank === 1)) {
      victoryAnnounced = true;
      void play('victory');
    }
  }

  function reset() { stop(); announced.clear(); victoryAnnounced = false; }
  function gesture() { void unlock(); }
  page.addEventListener('pointerdown', gesture, { capture: true });
  page.addEventListener('keydown', gesture, { capture: true });
  page.addEventListener('visibilitychange', () => { if (page.hidden) stop(); });
  button.addEventListener('click', () => {
    enabled = !enabled;
    writeStorage('uno.sound', enabled ? 'on' : 'off');
    if (enabled) void unlock(); else stop();
    updateButton();
  });
  updateButton();
  return { playEvent, afterSnapshot, reset };
}
