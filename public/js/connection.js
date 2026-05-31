/**
 * connection.js — WebSocket + WebRTC signaling (v2 + resume)
 * ──────────────────────────────────────────────────────────
 * Adds:
 *  - Resume-interrupted-transfer support (30 min recovery window)
 *  - Reconnect-on-disconnect with countdown
 */

'use strict';

const WS_URL = (() => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
})();

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // ↓ Add TURN for corporate firewalls (see SETUP.md)
  // { urls: 'turn:YOUR_TURN', username: 'u', credential: 'p' }
];

// Global state
window.OS = {
  ws:          null,
  pc:          null,
  dataChannel: null,
  sessionCode: null,
  role:        null,      // 'sender' | 'receiver'
  connected:   false,
  wsReady:     false,
};

// ── WebSocket ───────────────────────────────────────────────────
function connectWS(onReady) {
  if (OS.ws && OS.ws.readyState === WebSocket.OPEN) {
    return onReady?.();
  }
  showConnBanner('Connecting to OffiqShare network…');
  OS.ws = new WebSocket(WS_URL);

  OS.ws.onopen = () => {
    OS.wsReady = true;
    hideConnBanner();
    onReady?.();
  };
  OS.ws.onclose = () => {
    OS.wsReady = false;
    if (OS.connected) {
      showConnBanner('Connection lost — reconnecting…');
      setTimeout(() => connectWS(), 3000);
    }
  };
  OS.ws.onerror  = (e) => console.error('[ws]', e);
  OS.ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    handleSignal(msg);
  };
}

function sendSignal(obj) {
  if (OS.ws?.readyState === WebSocket.OPEN) OS.ws.send(JSON.stringify(obj));
}

// ── Signal Dispatcher ───────────────────────────────────────────
async function handleSignal(msg) {
  switch (msg.type) {

    case 'session-created':
      OS.sessionCode = msg.code;
      window.onSessionCreated?.(msg.code);
      break;

    case 'session-info':
      window.onSessionInfo?.(msg);
      break;

    case 'receiver-joined':
      UI.setStatus('sendStatus', 'connecting',
        `<div class="spinner"></div> Receiver accepted! Starting transfer…`);
      await createOffer();
      break;

    case 'receiver-rejected':
      // Record as cancelled in history (sender side)
      _recordHistory('cancelled');
      UI.setStatus('sendStatus', 'error', '❌ Receiver declined the transfer.');
      UI.showToast('Receiver declined.');
      break;

    case 'session-joined':
      OS.sessionCode = msg.code;
      setupReceiverPC();
      window.onSessionJoined?.(msg);
      break;

    case 'offer':
      await handleOffer(msg.sdp);
      break;

    case 'answer':
      await OS.pc.setRemoteDescription(
        new RTCSessionDescription({ type: 'answer', sdp: msg.sdp })
      );
      break;

    case 'ice-candidate':
      if (msg.candidate && OS.pc) {
        try { await OS.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); }
        catch(e) { console.warn('[ice]', e); }
      }
      break;

    case 'peer-disconnected':
      _handlePeerDisconnected();
      break;

    case 'transfer-complete':
      window.onTransferComplete?.();
      break;

    case 'cancelled':
      _recordHistory('cancelled');
      UI.showToast('Session was cancelled.');
      UI.setStatus('recvStatus', 'error', '❌ Session cancelled.');
      UI.setStatus('sendStatus', 'error', '❌ Session cancelled.');
      Resume.clearState();
      break;

    case 'session-expired':
      _recordHistory('expired');
      UI.showToast('Session expired — create a new one.');
      UI.setStatus('sendStatus', 'error', '⏱ Session expired.');
      Resume.clearState();
      break;

    case 'error':
      UI.showToast(msg.message);
      UI.setStatus('recvStatus', 'error', '❌ ' + msg.message);
      break;
  }
}

// ── Peer disconnected: start resume countdown ────────────────────
function _handlePeerDisconnected() {
  OS.connected = false;

  // Determine which panel to show the countdown in
  const panelId = OS.role === 'sender' ? 'sendStatus' : 'recvStatus';

  // Save current progress state for potential resume
  const progress = Transfer.getProgress?.() || {};
  Resume.saveState({
    sessionCode: OS.sessionCode,
    role:        OS.role,
    filesMeta:   progress.filesMeta   || [],
    sentIndex:   progress.sentIndex   || 0,
    sentOffset:  progress.sentOffset  || 0,
    sentBytes:   progress.sentBytes   || 0,
    totalBytes:  progress.totalBytes  || 0,
  });

  Resume.startCountdown(panelId, () => {
    // TTL expired
    _recordHistory('expired');
    Resume.clearState();
    UI.setStatus(panelId, 'error',
      '⏱ Transfer session expired. Start a new transfer.');
    UI.showToast('Transfer session expired.');
  });
}

// ── History helper ───────────────────────────────────────────────
function _recordHistory(status) {
  if (typeof History === 'undefined') return;
  const progress = Transfer.getProgress?.() || {};
  const files = progress.filesMeta || window._filesToSend
    ? (window._filesToSend || []).map(f => ({ name: f.name, size: f.size }))
    : [];
  const totalSize = files.reduce((a, f) => a + (f.size || 0), 0);
  History.addRecord({
    status,
    role:      OS.role,
    files,
    fileCount: files.length,
    totalSize,
  });
}

// Expose for use by app.js
window._recordHistory = _recordHistory;

// ── Session API (called by app.js) ──────────────────────────────
function createSession(filesMeta, senderName) {
  connectWS(() => sendSignal({ type: 'create-session', files: filesMeta, senderName }));
}

function peekSession(code) {
  connectWS(() => {
    OS.role = 'receiver';
    sendSignal({ type: 'peek-session', code });
  });
}

function acceptSession(code, receiverName) {
  sendSignal({ type: 'join-session', code, receiverName });
}

function rejectSession(code) {
  sendSignal({ type: 'reject-session', code });
}

function cancelSession() {
  _recordHistory('cancelled');
  Resume.clearState();
  sendSignal({ type: 'cancel' });
  OS.pc?.close(); OS.pc = null;
  OS.sessionCode = null;
  OS.connected   = false;
  Resume.stopCountdown();
}

// ── RTCPeerConnection: Sender ────────────────────────────────────
function setupSenderPC() {
  OS.pc   = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  OS.role = 'sender';

  OS.dataChannel = OS.pc.createDataChannel('offiqshare', { ordered: true });
  OS.dataChannel.binaryType = 'arraybuffer';
  OS.dataChannel.bufferedAmountLowThreshold = 256 * 1024;

  OS.dataChannel.onopen  = () => {
    OS.connected = true;
    Resume.stopCountdown();
    // Check if this is a resume
    const savedState = Resume.loadState();
    if (savedState && savedState.sentBytes > 0) {
      Transfer.startSending(savedState);
    } else {
      Transfer.startSending();
    }
  };
  OS.dataChannel.onclose = () => { OS.connected = false; };
  OS.dataChannel.onerror = (e) => console.error('[dc]', e);

  OS.pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal({ type: 'ice-candidate', candidate });
  };
  OS.pc.onconnectionstatechange = () =>
    console.log('[rtc] state:', OS.pc.connectionState);
}

async function createOffer() {
  setupSenderPC();
  const offer = await OS.pc.createOffer();
  await OS.pc.setLocalDescription(offer);
  sendSignal({ type: 'offer', sdp: offer.sdp });
}

// ── RTCPeerConnection: Receiver ──────────────────────────────────
function setupReceiverPC() {
  OS.pc   = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  OS.role = 'receiver';

  OS.pc.ondatachannel = ({ channel }) => {
    OS.dataChannel = channel;
    OS.dataChannel.binaryType = 'arraybuffer';
    OS.dataChannel.onmessage = (e) => Transfer.handleIncoming(e.data);
    OS.dataChannel.onopen    = () => {
      OS.connected = true;
      Resume.stopCountdown();
    };
    OS.dataChannel.onclose   = () => { OS.connected = false; };
  };
  OS.pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal({ type: 'ice-candidate', candidate });
  };
}

async function handleOffer(sdp) {
  await OS.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
  const answer = await OS.pc.createAnswer();
  await OS.pc.setLocalDescription(answer);
  sendSignal({ type: 'answer', sdp: answer.sdp });
}

// ── Banner ────────────────────────────────────────────────────────
function showConnBanner(text) {
  const b = document.getElementById('connBanner');
  b.style.display = 'block';
  document.getElementById('connBannerText').textContent = text;
}
function hideConnBanner() {
  document.getElementById('connBanner').style.display = 'none';
}
