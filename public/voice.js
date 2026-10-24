/** Room-scoped WebRTC mesh. Devices are captured only after an explicit click. */
export function createVoice({ send, notify, host = window, page = document }) {
  const micButton = page.getElementById('voiceMic');
  const listenButton = page.getElementById('voiceListen');
  const status = page.getElementById('voiceStatus');
  const people = page.getElementById('voicePeople');
  const bar = page.querySelector('.voice-bar');
  const detailsButton = page.getElementById('voiceDetailsToggle');
  const peers = new Map();
  let roomCode = null;
  let self = null;
  let members = [];
  let stream = null;
  let listening = false;
  let busy = false;
  let generation = 0;
  let iceServers = [];
  let errorText = '';
  const supported = !!host.RTCPeerConnection;
  const canRecord = !!host.isSecureContext && !!host.navigator.mediaDevices?.getUserMedia;

  const micOn = () => !!stream?.getAudioTracks().some(track => track.readyState === 'live');
  const current = peer => peers.get(peer.id) === peer && !peer.closed;

  function render() {
    const mic = micOn();
    micButton.disabled = !roomCode || busy || !supported || !canRecord;
    listenButton.disabled = !roomCode || busy || !supported;
    micButton.setAttribute('aria-pressed', String(mic));
    listenButton.setAttribute('aria-pressed', String(listening));
    micButton.querySelector('.voice-button-label').textContent = mic ? '麦克风：开' : '开启麦克风';
    listenButton.querySelector('.voice-button-label').textContent = listening ? '听筒：开' : '开启听筒';
    micButton.setAttribute('aria-label', mic ? '关闭麦克风' : canRecord ? '开启麦克风' : '麦克风不可用，需要可信任的 HTTPS');
    listenButton.setAttribute('aria-label', listening ? '关闭听筒' : '开启听筒');
    detailsButton.dataset.notice = String(!!errorText || !canRecord || !supported);
    micButton.title = canRecord ? '点击切换麦克风' : '手机麦克风需要可信任的 HTTPS 地址，请查看启动说明';
    status.textContent = errorText || (!supported ? '当前浏览器不支持语音聊天' :
      !canRecord ? '麦克风需要可信任的 HTTPS 地址；可先尝试仅开启听筒' :
      busy ? '正在连接语音…' : mic || listening ?
      `${mic ? '麦克风已开启' : '仅收听'} · ${Math.max(0, members.length - 1)} 位语音伙伴` : '语音未开启，点击麦克风或听筒加入');
    detailsButton.title = status.textContent;
    detailsButton.setAttribute('aria-label', errorText ? `语音详情：${errorText}` : '语音详情');
    people.replaceChildren(...members.filter(member => member.id !== self?.id).map(member => {
      const item = page.createElement('span');
      const peer = peers.get(member.id);
      item.className = 'voice-person';
      item.textContent = `${member.mic ? '🎙' : '🔈'} ${member.nickname}`;
      item.title = `${member.mic ? '麦克风已开启' : '仅收听'} · ${peer?.pc.connectionState === 'connected' ? '已连接' : '连接中'}`;
      return item;
    }));
  }

  function removePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    peer.closed = true;
    peer.pc.close();
    peer.audio.pause(); peer.audio.srcObject = null; peer.audio.remove();
    peers.delete(id);
  }

  function stopMicrophone() {
    const previous = stream; stream = null;
    for (const track of previous?.getTracks() ?? []) track.stop();
  }

  function reset() {
    generation++;
    self = null; members = []; listening = false; busy = false; errorText = '';
    stopMicrophone();
    page.getElementById('voiceResume').hidden = true;
    bar.dataset.expanded = 'false'; detailsButton.setAttribute('aria-expanded', 'false');
    for (const id of peers.keys()) removePeer(id);
    render();
  }

  function setRoom(next) {
    const nextCode = next?.roomCode ?? null;
    if (nextCode !== roomCode) { roomCode = nextCode; reset(); }
  }

  async function playRemote(peer) {
    peer.audio.muted = !listening;
    if (!listening || !peer.audio.srcObject) return;
    try { await peer.audio.play(); }
    catch {
      if (!current(peer)) return;
      errorText = '浏览器暂停了语音播放，点击“恢复收听”继续';
      page.getElementById('voiceResume').hidden = false;
      render();
    }
  }

  async function signal(peer, payload) {
    if (!current(peer) || !self) return;
    try {
      await send('VOICE_SIGNAL', { roomCode, sessionId: self.sessionId,
        targetId: peer.id, targetSessionId: peer.sessionId, ...payload });
    } catch {
      if (current(peer)) { errorText = '语音连接中断，可关闭后重新开启听筒或麦克风'; render(); }
    }
  }

  async function offer(peer) {
    const description = await peer.pc.createOffer();
    if (!current(peer)) return;
    await peer.pc.setLocalDescription(description);
    if (current(peer)) await signal(peer, { description: peer.pc.localDescription.toJSON() });
  }

  function ensurePeer(member) {
    if (peers.has(member.id)) return peers.get(member.id);
    const pc = new host.RTCPeerConnection({ iceServers });
    const audio = page.createElement('audio');
    audio.autoplay = true; audio.muted = !listening;
    audio.setAttribute('playsinline', ''); audio.hidden = true;
    page.getElementById('voiceAudio').append(audio);
    const peer = { id: member.id, sessionId: member.sessionId, pc, audio, sender: null, candidates: [], closed: false, chain: Promise.resolve() };
    peers.set(member.id, peer);
    pc.onicecandidate = event => { if (event.candidate && current(peer)) void signal(peer, { candidate: event.candidate.toJSON() }); };
    pc.ontrack = event => {
      if (!current(peer) || event.track.kind !== 'audio') return;
      audio.srcObject = event.streams[0] ?? new host.MediaStream([event.track]);
      void playRemote(peer);
    };
    pc.onconnectionstatechange = () => {
      if (!current(peer)) return;
      if (pc.connectionState === 'failed') errorText = '部分语音未连通，请关闭后重新开启语音，或检查网络';
      render();
    };
    // One deterministic offerer prevents simultaneous offers from colliding.
    if (self.id < member.id) {
      const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
      peer.sender = transceiver.sender;
      peer.chain = peer.sender.replaceTrack(stream?.getAudioTracks()[0] ?? null)
        .then(() => current(peer) && offer(peer)).catch(() => peerFailure(peer));
    }
    return peer;
  }

  function peerFailure(peer) {
    if (!current(peer)) return;
    errorText = '语音协商失败，可关闭后重新开启语音'; render();
  }

  async function handleSignal(payload) {
    if (payload.roomCode !== roomCode || payload.targetSessionId !== self?.sessionId) return;
    const peer = peers.get(payload.fromId);
    if (!peer || peer.sessionId !== payload.sessionId) return;
    // Candidates can arrive before setRemoteDescription finishes.
    peer.chain = peer.chain.then(async () => {
      if (!current(peer)) return;
      if (payload.description) {
        if (payload.description.type === 'offer' && self.id < peer.id) return;
        if (payload.description.type === 'answer' && peer.pc.signalingState !== 'have-local-offer') return;
        await peer.pc.setRemoteDescription(payload.description);
        if (!current(peer)) return;
        if (payload.description.type === 'offer') {
          const transceiver = peer.pc.getTransceivers().find(item => item.receiver.track.kind === 'audio');
          if (!transceiver) throw new Error('No audio transceiver');
          transceiver.direction = 'sendrecv'; peer.sender = transceiver.sender;
          await peer.sender.replaceTrack(stream?.getAudioTracks()[0] ?? null);
          if (!current(peer)) return;
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          if (!current(peer)) return;
          await signal(peer, { description: peer.pc.localDescription.toJSON() });
        }
        for (const candidate of peer.candidates.splice(0)) {
          if (!current(peer)) return;
          await peer.pc.addIceCandidate(candidate);
        }
      } else if (payload.candidate) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(payload.candidate);
        else if (peer.candidates.length < 50) peer.candidates.push(payload.candidate);
      }
    }).catch(() => peerFailure(peer));
    await peer.chain;
  }

  function receive(type, payload) {
    if (type === 'VOICE_SIGNAL') { void handleSignal(payload); return; }
    if (type !== 'VOICE_ROSTER' || payload.roomCode !== roomCode || !(micOn() || listening)) return;
    self = payload.self; members = payload.members;
    for (const [id, peer] of peers) if (!members.some(member => member.id === id && member.sessionId === peer.sessionId)) removePeer(id);
    for (const member of members) if (member.id !== self.id) ensurePeer(member);
    render();
  }

  async function sync() {
    const version = generation;
    const code = roomCode;
    for (const peer of peers.values()) {
      if (peer.sender) await peer.sender.replaceTrack(stream?.getAudioTracks()[0] ?? null);
      if (version !== generation) return;
      void playRemote(peer);
    }
    if (version !== generation) return;
    if (micOn() || listening) {
      await send('VOICE_JOIN', { roomCode: code, mic: micOn(), listening });
    } else {
      const previousRoom = roomCode;
      reset();
      await send('VOICE_LEAVE', { roomCode: previousRoom });
    }
  }

  function microphoneError(error) {
    return error.name === 'NotAllowedError' ? '麦克风权限被拒绝，请在浏览器设置中允许，也可只开启听筒' :
      error.name === 'NotFoundError' ? '没有找到麦克风，可只开启听筒' :
      error.name === 'NotReadableError' ? '麦克风被占用，请关闭其他录音程序后重试' : '麦克风开启失败，请检查设备后重试';
  }

  async function action(callback) {
    if (busy || !roomCode) return;
    busy = true; errorText = ''; render();
    const version = generation;
    try {
      // No public STUN service is required for same-network voice.
      if (!self) {
        try {
          const response = await host.fetch('/voice-config.json');
          if (response.ok) iceServers = (await response.json()).iceServers ?? [];
        } catch { iceServers = []; }
      }
      if (version !== generation) return;
      await callback(version);
    } catch (error) {
      if (version !== generation) return;
      // Fail closed: no device capture may remain after a rejected join.
      stopMicrophone(); listening = false;
      for (const id of peers.keys()) removePeer(id);
      self = null; members = [];
      void send('VOICE_LEAVE', { roomCode }).catch(() => {});
      errorText = error.name === 'NotAllowedError' ? '麦克风权限被拒绝，请在浏览器设置中允许，也可只开启听筒' :
        error.name === 'NotFoundError' ? '没有找到麦克风，可只开启听筒' :
        error.name === 'NotReadableError' ? '麦克风被占用，请关闭其他录音程序后重试' : '语音开启失败，请检查设备和连接后重试';
      notify(errorText, true);
    } finally { if (version === generation) { busy = false; render(); } }
  }

  micButton.addEventListener('click', () => {
    if (!canRecord) return;
    void action(async version => {
      if (micOn()) stopMicrophone();
      else {
        let captured;
        try {
          captured = await host.navigator.mediaDevices.getUserMedia({ audio: {
            echoCancellation: true, noiseSuppression: true, autoGainControl: true
          }, video: false });
        } catch (error) {
          if (version !== generation) return;
          errorText = microphoneError(error); notify(errorText, true);
          return; // A rejected microphone permission must not stop listening.
        }
        if (version !== generation) { captured.getTracks().forEach(track => track.stop()); return; }
        stream = captured; listening = true;
        for (const track of stream.getAudioTracks()) track.onended = () => {
          if (stream !== captured) return;
          stopMicrophone(); void sync().catch(() => {}); render();
        };
      }
      await sync();
    });
  });
  listenButton.addEventListener('click', () => { void action(async () => { listening = !listening; await sync(); }); });
  page.getElementById('voiceResume').addEventListener('click', () => {
    errorText = ''; page.getElementById('voiceResume').hidden = true;
    for (const peer of peers.values()) void playRemote(peer);
    render();
  });
  detailsButton.addEventListener('click', () => {
    const expanded = bar.dataset.expanded !== 'true';
    bar.dataset.expanded = String(expanded); detailsButton.setAttribute('aria-expanded', String(expanded));
  });
  page.addEventListener('pointerdown', event => {
    if (!bar.contains(event.target)) { bar.dataset.expanded = 'false'; detailsButton.setAttribute('aria-expanded', 'false'); }
  });
  bar.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      bar.dataset.expanded = 'false'; detailsButton.setAttribute('aria-expanded', 'false'); detailsButton.focus();
    }
  });
  host.addEventListener('pagehide', () => {
    const previousRoom = roomCode; reset();
    if (previousRoom) void send('VOICE_LEAVE', { roomCode: previousRoom }).catch(() => {});
  });
  render();
  return { setRoom, receive, disconnect: () => { roomCode = null; reset(); } };
}
