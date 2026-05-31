/**
 * transfer.js — WebRTC File Transfer Engine (v2 + resume)
 * ────────────────────────────────────────────────────────
 * Protocol:
 *   JSON:   { type:'start', name, size, mime, index }
 *           { type:'end',   index }
 *           { type:'done' }
 *           { type:'resume', fromIndex, fromOffset }
 *   Binary: raw ArrayBuffer chunks (64 KB each)
 *
 * Resume: sender can restart from a saved (index, offset).
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
  let isResumed      = false;

  // Receiver state
  let recvChunks   = [];
  let recvMeta     = null;
  let recvReceived = 0;
  let recvStartTime= 0;
  let recvFiles    = [];

  // ── Send ──────────────────────────────────────────────────────
  /**
   * @param {object|null} resumeState - optional saved state from Resume module
   */
  function startSending(resumeState) {
    sendFiles      = window._filesToSend || [];
    sendTotalBytes = sendFiles.reduce((a, f) => a + f.size, 0);
    sendStartTime  = Date.now();
    isResumed      = false;

    if (!sendFiles.length) return;

    if (resumeState && resumeState.sentBytes > 0) {
      // Resume from saved progress
      isResumed    = true;
      sendIndex    = resumeState.sentIndex  || 0;
      sendOffset   = resumeState.sentOffset || 0;
      sendSentBytes = resumeState.sentBytes || 0;
      UI.showToast('🔄 Resuming transfer from where it left off…');
    } else {
      sendIndex    = 0;
      sendOffset   = 0;
      sendSentBytes = 0;
    }

    sendNextFile();
  }

  function sendNextFile() {
    if (sendIndex >= sendFiles.length) {
      sendJSON({ type: 'done' });
      sendSignal({ type: 'transfer-complete' });

      // Record in history
      if (typeof History !== 'undefined') {
        const files = sendFiles.map(f => ({ name: f.name, size: f.size }));
        const totalSize = files.reduce((a, f) => a + f.size, 0);
        History.addRecord({
          status:    isResumed ? 'resumed' : 'completed',
          role:      'sender',
          files,
          fileCount: files.length,
          totalSize,
        });
      }

      Resume.clearState();
      UI.setStatus('sendStatus', 'done', `✅ All ${sendFiles.length} file(s) sent successfully!`);
      return;
    }

    const file = sendFiles[sendIndex];
    // If resuming this file mid-way, tell receiver to skip to offset
    if (isResumed && sendOffset > 0) {
      sendJSON({ type: 'resume', fromIndex: sendIndex, fromOffset: sendOffset });
    } else {
      sendOffset = 0;
    }

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
      // Clear resume offset so next file starts fresh
      sendOffset = 0;
      isResumed  = false;
      sendIndex++;
      sendNextFile();
      return;
    }
    if (OS.dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
      sendPaused = true;
      // Save progress for potential reconnect
      Resume.saveState({
        sessionCode: OS.sessionCode,
        role:        'sender',
        filesMeta:   sendFiles.map(f => ({ name: f.name, size: f.size })),
        sentIndex:   sendIndex,
        sentOffset:  sendOffset,
        sentBytes:   sendSentBytes,
        totalBytes:  sendTotalBytes,
      });
      return;
    }

    const slice  = file.slice(sendOffset, sendOffset + CHUNK_SIZE);
    sendOffset  += slice.size;

    const reader = new FileReader();
    reader.onload = (e) => {
      OS.dataChannel.send(e.target.result);
      sendSentBytes += e.target.result.byteLength;
      updateSendProgress();
      // Periodically persist progress (every ~1 MB)
      if (sendSentBytes % (1024 * 1024) < CHUNK_SIZE) {
        Resume.saveState({
          sessionCode: OS.sessionCode,
          role:        'sender',
          filesMeta:   sendFiles.map(f => ({ name: f.name, size: f.size })),
          sentIndex:   sendIndex,
          sentOffset:  sendOffset,
          sentBytes:   sendSentBytes,
          totalBytes:  sendTotalBytes,
        });
      }
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
      `📤 Sending <strong>${file.name}</strong>${isResumed ? ' <em>(resumed)</em>' : ''}`,
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
      case 'resume':
        // Sender is resuming — clear any partial chunks we may have
        recvChunks   = [];
        recvReceived = msg.fromOffset || 0;
        break;
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
        // Record in history (receiver side)
        if (typeof History !== 'undefined') {
          const files = recvFiles.map(f => ({ name: f.name, size: f.size }));
          const totalSize = files.reduce((a, f) => a + f.size, 0);
          History.addRecord({
            status:    'completed',
            role:      'receiver',
            files,
            fileCount: files.length,
            totalSize,
          });
        }
        Resume.clearState();
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

  // ── Progress snapshot for resume ──────────────────────────────
  function getProgress() {
    return {
      filesMeta:  sendFiles.map(f => ({ name: f.name, size: f.size })),
      sentIndex:  sendIndex,
      sentOffset: sendOffset,
      sentBytes:  sendSentBytes,
      totalBytes: sendTotalBytes,
    };
  }

  return { startSending, handleIncoming, getProgress };
})();
