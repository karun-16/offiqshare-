/**
 * transfer.js — WebRTC File Transfer Engine (v2)
 * ────────────────────────────────────────────────
 * Protocol:
 *   JSON:   { type:'start', name, size, mime, index }
 *           { type:'end',   index }
 *           { type:'done' }
 *   Binary: raw ArrayBuffer chunks (64 KB each)
 */

'use strict';

const Transfer = (() => {

  const CHUNK_SIZE       = 64 * 1024;
  const BUFFER_THRESHOLD = 4 * 1024 * 1024;
  const BUFFER_LOW       = 256 * 1024;

  // Sender state
  let sendFiles      = [];
  let sendIndex      = 0;
  let sendOffset     = 0;
  let sendStartTime  = 0;
  let sendTotalBytes = 0;
  let sendSentBytes  = 0;
  let sendPaused     = false;

  // Receiver state
  let recvChunks   = [];
  let recvMeta     = null;
  let recvReceived = 0;
  let recvStartTime= 0;
  let recvFiles    = [];

  // ── Send ──────────────────────────────────────────────────────
  function startSending() {
    sendFiles      = window._filesToSend || [];
    sendTotalBytes = sendFiles.reduce((a, f) => a + f.size, 0);
    sendStartTime  = Date.now();
    sendIndex      = 0;
    sendSentBytes  = 0;
    if (!sendFiles.length) return;
    sendNextFile();
  }

  function sendNextFile() {
    if (sendIndex >= sendFiles.length) {
      sendJSON({ type: 'done' });
      sendSignal({ type: 'transfer-complete' });
      UI.setStatus('sendStatus', 'done', `✅ All ${sendFiles.length} file(s) sent successfully!`);
      return;
    }
    const file = sendFiles[sendIndex];
    sendOffset = 0;
    sendJSON({ type: 'start', name: file.name, size: file.size,
               mime: file.type || 'application/octet-stream', index: sendIndex });

    OS.dataChannel.bufferedAmountLowThreshold = BUFFER_LOW;
    OS.dataChannel.onbufferedamountlow = () => {
      if (sendPaused) { sendPaused = false; readNextChunk(); }
    };
    readNextChunk();
  }

  function readNextChunk() {
    if (sendIndex >= sendFiles.length) return;
    const file = sendFiles[sendIndex];

    if (sendOffset >= file.size) {
      sendJSON({ type: 'end', index: sendIndex });
      sendIndex++;
      sendNextFile();
      return;
    }
    if (OS.dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
      sendPaused = true;
      return;
    }

    const slice  = file.slice(sendOffset, sendOffset + CHUNK_SIZE);
    sendOffset  += slice.size;

    const reader = new FileReader();
    reader.onload = (e) => {
      OS.dataChannel.send(e.target.result);
      sendSentBytes += e.target.result.byteLength;
      updateSendProgress();
      readNextChunk();
    };
    reader.readAsArrayBuffer(slice);
  }

  function updateSendProgress() {
    const file    = sendFiles[sendIndex] || sendFiles[sendFiles.length - 1];
    const elapsed = (Date.now() - sendStartTime) / 1000 || 0.001;
    const speed   = sendSentBytes / elapsed;
    const pct     = Math.min(100, (sendSentBytes / sendTotalBytes) * 100);
    const eta     = speed > 0 ? (sendTotalBytes - sendSentBytes) / speed : 0;
    UI.setStatusProgress('sendStatus',
      `📤 Sending <strong>${file.name}</strong>`,
      pct,
      UI.formatSize(speed) + '/s',
      eta > 0 ? `~${Math.ceil(eta)}s left` : ''
    );
  }

  // ── Receive ───────────────────────────────────────────────────
  function handleIncoming(data) {
    if (typeof data === 'string') {
      try { handleControlMsg(JSON.parse(data)); } catch(e) {}
      return;
    }
    if (data instanceof ArrayBuffer) {
      recvChunks.push(data);
      recvReceived += data.byteLength;
      updateRecvProgress();
    }
  }

  function handleControlMsg(msg) {
    switch (msg.type) {
      case 'start':
        recvChunks    = [];
        recvReceived  = 0;
        recvMeta      = msg;
        recvStartTime = Date.now();
        UI.setStatusProgress('recvStatus',
          `📥 Receiving <strong>${msg.name}</strong> (${UI.formatSize(msg.size)})`, 0);
        break;
      case 'end':
        assembleFile();
        break;
      case 'done':
        OS.connected = false;
        showRecvSummary();
        break;
    }
  }

  function assembleFile() {
    const blob = new Blob(recvChunks, { type: recvMeta.mime });
    const url  = URL.createObjectURL(blob);
    recvFiles.push({ name: recvMeta.name, size: recvMeta.size, url });
    UI.addReceivedFile(recvMeta.name, recvMeta.size, url);
    recvChunks   = [];
    recvReceived = 0;
    recvMeta     = null;
  }

  function updateRecvProgress() {
    if (!recvMeta) return;
    const elapsed = (Date.now() - recvStartTime) / 1000 || 0.001;
    const speed   = recvReceived / elapsed;
    const pct     = Math.min(100, (recvReceived / recvMeta.size) * 100);
    UI.setStatusProgress('recvStatus',
      `📥 Receiving <strong>${recvMeta.name}</strong>`,
      pct, UI.formatSize(speed) + '/s');
  }

  function showRecvSummary() {
    const total = recvFiles.reduce((a, f) => a + f.size, 0);
    UI.setStatus('recvStatus', 'done', `✅ ${recvFiles.length} file(s) received!`);
    const el = document.getElementById('recvSummary');
    if (el) {
      el.style.display = 'block';
      const det = document.getElementById('summaryDetails');
      if (det) det.innerHTML = `${recvFiles.length} file(s) · ${UI.formatSize(total)} total`;
    }
  }

  function sendJSON(obj) {
    if (OS.dataChannel?.readyState === 'open')
      OS.dataChannel.send(JSON.stringify(obj));
  }

  return { startSending, handleIncoming };
})();
