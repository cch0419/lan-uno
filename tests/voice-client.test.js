import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoice } from '../public/voice.js';

// Fake microphone only. No real device permissions or user audio in tests.
function setup({ delayed = false, denied = false, secure = true } = {}) {
  const nodes = new Map(), hostEvents = new Map(), pageEvents = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, dataset: {}, handlers: {},
      textContent: '', setAttribute(k, v) { this[k] = v; }, addEventListener(k, fn) { this.handlers[k] = fn; },
      querySelector() { return this.label ??= {}; }, replaceChildren() {}, contains() { return false; }, setPointerCapture() {} });
    return nodes.get(id);
  }
  const track = { readyState: 'live', stopped: 0, stop() { this.stopped++; this.readyState = 'ended'; } };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  let allow; let captures = 0;
  const pending = new Promise(resolve => { allow = resolve; });
  const sent = [], notices = [];
  const host = { isSecureContext: secure, RTCPeerConnection: class {}, Event,
    navigator: { mediaDevices: { getUserMedia: async () => { captures++; if (denied) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); return delayed ? pending : stream; } } },
    fetch: async () => ({ ok: true, json: async () => ({ iceServers: [] }) }),
    addEventListener: (type, fn) => hostEvents.set(type, fn), dispatchEvent: event => hostEvents.get(event.type)?.(event), setTimeout };
  const page = { getElementById: node, querySelector: () => node('bar'), addEventListener: (type, fn) => pageEvents.set(type, fn) };
  const voice = createVoice({ host, page, notify: (...args) => notices.push(args), send: async (type, payload) => { sent.push({ type, payload }); } });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const press = () => node('voiceMic').handlers.pointerdown({ button: 0, pointerId: 1, preventDefault() {} });
  return { voice, node, sent, notices, track, allow: () => allow(stream), captures: () => captures, press, flush, hostEvents, pageEvents };
}

test('push-to-talk never captures on entry, stops on release and preserves listening', async () => {
  const e = setup(); e.voice.setRoom({ roomCode: '1234' });
  assert.equal(e.captures(), 0);
  e.press(); await e.flush();
  assert.equal(e.captures(), 1);
  assert.equal(e.sent.at(-1).type, 'VOICE_JOIN'); assert.equal(e.sent.at(-1).payload.mic, true);
  e.node('voiceMic').handlers.pointerup(); await e.flush();
  assert.equal(e.track.stopped, 1);
  assert.equal(e.sent.at(-1).payload.mic, false); assert.equal(e.sent.at(-1).payload.listening, true);
  e.voice.disconnect();
});

test('releasing while permission is pending cannot leave a microphone running', async () => {
  const e = setup({ delayed: true }); e.voice.setRoom({ roomCode: '1234' });
  e.press(); await e.flush(); e.node('voiceMic').handlers.pointerup();
  e.allow(); await e.flush();
  assert.equal(e.track.stopped, 1);
  assert.equal(e.sent.some(m => m.type === 'VOICE_JOIN' && m.payload.mic), false);
  e.voice.disconnect();
});

test('backgrounding, room change and disconnect all stop capture; denied permission fails closed', async () => {
  for (const stop of ['background', 'room', 'disconnect']) {
    const e = setup(); e.voice.setRoom({ roomCode: '1234' }); e.press(); await e.flush();
    if (stop === 'background') { e.pageEvents.get('visibilitychange'); e.hostEvents.get('blur')(); }
    if (stop === 'room') e.voice.setRoom({ roomCode: '5678' });
    if (stop === 'disconnect') e.voice.disconnect();
    await e.flush(); assert.equal(e.track.stopped, 1); e.voice.disconnect();
  }
  const denied = setup({ denied: true }); denied.voice.setRoom({ roomCode: '1234' }); denied.press(); await denied.flush();
  assert.equal(denied.sent.some(m => m.type === 'VOICE_JOIN' && m.payload.mic), false);
  assert.match(denied.notices[0][0], /权限被拒绝/); denied.voice.disconnect();
  const insecure = setup({ secure: false }); insecure.voice.setRoom({ roomCode: '1234' }); insecure.press();
  assert.equal(insecure.captures(), 0); insecure.voice.disconnect();
});
