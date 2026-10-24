import test from 'node:test';
import assert from 'node:assert/strict';
import { createSounds } from '../public/sounds.js';

function setup({ stored, unsupported = false, failedVoice = false } = {}) {
  const listeners = {};
  const started = [];
  const stopped = [];
  const attributes = {};
  const saved = new Map();
  let contexts = 0;
  const button = { setAttribute: (key, value) => { attributes[key] = value; }, addEventListener: (_, fn) => { listeners.click = fn; } };
  const page = { hidden: false, getElementById: () => button, addEventListener: (name, fn) => { listeners[name] = fn; } };
  const parameter = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  function source(type) {
    return { type, frequency: parameter(), connect() {}, disconnect() {}, start(time) { started.push({ type, time, node: this }); }, stop() { stopped.push(this); } };
  }
  class AudioContext {
    state = 'suspended'; currentTime = 0; destination = {};
    constructor() { contexts++; }
    async resume() { this.state = 'running'; }
    createGain() { return { gain: parameter(), connect() {}, disconnect() {} }; }
    createOscillator() { return source('oscillator'); }
    createBufferSource() { return source('voice'); }
    async decodeAudioData(data) { return { duration: 0.8, voice: new Uint8Array(data)[0] }; }
  }
  const host = { AudioContext: unsupported ? undefined : AudioContext, fetch: async url => {
    if (failedVoice) throw new Error('offline');
    return { ok: true, arrayBuffer: async () => new Uint8Array([url.includes('victory') ? 2 : 1]).buffer };
  } };
  const sounds = createSounds({ host, page, readStorage: () => stored, writeStorage: (key, value) => saved.set(key, value) });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const gesture = async () => { listeners.pointerdown(); await flush(); };
  return { sounds, page, listeners, started, stopped, attributes, saved, gesture, flush, contexts: () => contexts };
}
const snapshot = count => ({ game: { id: 'game', rules: { autoUno: true } }, players: [{ id: 'a', handCount: count }] });
const played = kind => ({ kind: 'played', playerId: 'a', card: { kind } });

test('network events never unlock audio; every card kind plays after user activation', async () => {
  const env = setup();
  env.sounds.playEvent(played('number'));
  assert.equal(env.contexts(), 0);
  assert.equal(env.started.length, 0);
  await env.gesture();
  const counts = [];
  for (const kind of ['number', 'skip', 'reverse', 'draw2', 'wild', 'wild4']) {
    const before = env.started.length;
    env.sounds.playEvent(played(kind));
    counts.push(env.started.length - before);
  }
  assert.deepEqual(counts, [2, 2, 3, 3, 5, 5]);
  const count = env.started.length;
  for (const kind of ['reversed', 'skipped', 'penalty']) env.sounds.playEvent({ kind });
  assert.equal(env.started.length, count, 'derived events must not duplicate card audio');
});

test('one-card transition speaks once, a later UNO declaration does not repeat it; drawing rearms it', async () => {
  const env = setup(); await env.gesture();
  env.sounds.afterSnapshot(snapshot(2), snapshot(1), [played('number'), { kind: 'uno', playerId: 'a' }]);
  await env.flush();
  assert.equal(env.started.filter(item => item.type === 'voice').length, 1);
  env.sounds.afterSnapshot(snapshot(1), snapshot(1), [{ kind: 'uno', playerId: 'a' }]);
  await env.flush();
  assert.equal(env.started.length, 1);
  env.sounds.afterSnapshot(snapshot(1), snapshot(3), []);
  env.sounds.afterSnapshot(snapshot(2), snapshot(1), [played('number')]);
  await env.flush();
  assert.equal(env.started.length, 2);
});

test('manual UNO mode never speaks for a player who has not declared', async () => {
  const env = setup(); await env.gesture();
  const before = snapshot(2), after = snapshot(1);
  after.game.rules.autoUno = false;
  env.sounds.afterSnapshot(before, after, [played('number')]);
  await env.flush(); assert.equal(env.started.length, 0);
  env.sounds.afterSnapshot(after, after, [{ kind: 'uno', playerId: 'a' }]);
  await env.flush(); assert.equal(env.started.length, 1);
});

test('initial/reconnected snapshot does not announce historical UNO', async () => {
  const env = setup(); await env.gesture();
  env.sounds.afterSnapshot(null, snapshot(1), [{ kind: 'uno', playerId: 'a' }]);
  await env.flush();
  assert.equal(env.started.length, 0);
});

test('mute persists and stops current audio; hidden tabs suppress playback and stop scheduled audio', async () => {
  const env = setup(); await env.gesture();
  env.sounds.playEvent(played('wild4'));
  env.listeners.click();
  assert.equal(env.saved.get('uno.sound'), 'off');
  assert.equal(env.attributes['aria-pressed'], 'false');
  assert.ok(env.stopped.length >= env.started.length);
  const count = env.started.length;
  env.sounds.playEvent(played('number'));
  assert.equal(env.started.length, count);
  env.listeners.click(); await env.flush();
  env.page.hidden = true; env.listeners.visibilitychange();
  env.sounds.playEvent(played('number'));
  assert.equal(env.started.length, count);
  env.page.hidden = false;
  env.sounds.playEvent(played('number'));
  assert.ok(env.started.length > count);
  const muted = setup({ stored: 'off' }); await muted.gesture();
  assert.equal(muted.contexts(), 0);
});

test('unavailable Web Audio and failed voice download never interrupt game processing', async () => {
  const unsupported = setup({ unsupported: true }); await unsupported.gesture();
  assert.doesNotThrow(() => unsupported.sounds.playEvent(played('wild')));
  const env = setup({ failedVoice: true }); await env.gesture();
  env.sounds.afterSnapshot(snapshot(2), snapshot(1), [played('number')]);
  await env.flush();
  assert.equal(env.started.length, 2, 'failed voice falls back to a short cue');
});

test('victory uses its own voice once for rank 1, not subsequent finishers or final rankings', async () => {
  const env = setup(); await env.gesture();
  const won = { ...snapshot(0), game: { id: 'game', winnerId: 'a' } };
  const finish = { kind: 'player_finished', playerId: 'a', rank: 1 };
  env.sounds.afterSnapshot(snapshot(1), won, [finish]);
  await env.flush();
  assert.equal(env.started.length, 1);
  assert.equal(env.started[0].node.buffer.voice, 2, 'must play Victory, not UNO');
  env.sounds.afterSnapshot(snapshot(1), won, [finish]);
  env.sounds.afterSnapshot(won, won, [{ kind: 'player_finished', playerId: 'b', rank: 2 }]);
  env.sounds.afterSnapshot(won, { ...won, game: { ...won.game, phase: 'finished' } }, []);
  await env.flush();
  assert.equal(env.started.length, 1);
  env.sounds.reset();
  env.sounds.afterSnapshot(snapshot(1), won, [finish]);
  await env.flush();
  assert.equal(env.started.length, 2, 'a new game can announce its winner');
});

test('pending final +4 waits for confirmed victory; reconnect and paused-game recovery never replay it', async () => {
  const env = setup(); await env.gesture();
  const pending = { ...snapshot(0), game: { id: 'game', phase: 'wild4_response' } };
  env.sounds.afterSnapshot(snapshot(1), pending, [played('wild4')]);
  await env.flush();
  assert.equal(env.started.length, 0);
  const finish = { kind: 'player_finished', playerId: 'a', rank: 1 };
  const won = { ...snapshot(0), game: { id: 'game', winnerId: 'a' } };
  env.sounds.afterSnapshot(pending, won, [{ kind: 'accepted', count: 4 }, finish]);
  await env.flush();
  assert.equal(env.started.length, 1);
  env.sounds.reset();
  env.sounds.afterSnapshot(null, won, [finish]);
  env.sounds.afterSnapshot(won, won, [finish]);
  await env.flush();
  assert.equal(env.started.length, 1);
});

test('victory respects mute and background suppression and falls back when the voice fails', async () => {
  const finish = { kind: 'player_finished', playerId: 'a', rank: 1 };
  const muted = setup({ stored: 'off' }); await muted.gesture();
  muted.sounds.afterSnapshot(snapshot(1), snapshot(0), [finish]);
  await muted.flush();
  assert.equal(muted.started.length, 0);
  const hidden = setup(); await hidden.gesture(); hidden.page.hidden = true;
  hidden.sounds.afterSnapshot(snapshot(1), snapshot(0), [finish]);
  hidden.page.hidden = false;
  hidden.sounds.afterSnapshot(snapshot(1), snapshot(0), [finish]);
  await hidden.flush();
  assert.equal(hidden.started.length, 0);
  const failed = setup({ failedVoice: true }); await failed.gesture();
  failed.sounds.afterSnapshot(snapshot(1), snapshot(0), [finish]);
  await failed.flush();
  assert.equal(failed.started.length, 4);
  assert.ok(failed.started.every(item => item.type === 'oscillator'));
});
