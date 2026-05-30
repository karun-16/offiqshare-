/**
 * app.js — OffiqShare App Controller v2
 * ──────────────────────────────────────
 * Handles: file picking, session creation, all 3 connection
 * methods (QR / Code / Link), accept/reject flow, cancellation
 */

'use strict';

const App = (() => {

  let selectedFiles = [];
  let sessionActive = false;
  let pendingCode   = null;   // code from URL ?r= param

  // ── Boot ──────────────────────────────────────────────────────
  function init() {
    // Check URL for ?r=CODE (receiver clicked a shared link / scanned QR)
    const params = new URLSearchParams(location.search);
    const urlCode = params.get('r');
    if (urlCode && urlCode.length >= 4) {
      switchTab('recv');
      const input = document.getElementById('recvCode');
      if (input) input.value = urlCode.toUpperCase();
      // Auto-peek so receiver sees the files right away
      setTimeout(() => doPeek(urlCode.toUpperCase()), 600);
    }

    // Start on receive tab if ?recv in URL
    if (location.hash === '#receive') switchTab('recv');
  }

  // ── Tab Switching ─────────────────────────────────────────────
  window.switchTab = function(tab) {
    ['send','recv'].forEach(t => {
      document.getElementById('tab-' + t)?.classList.toggle('active', t === tab);
      document.getElementById('panel-' + t)?.classList.toggle('active', t === tab);
    });
  };

  // ── File Selection ────────────────────────────────────────────
  window.triggerFileInput = function() {
    document.getElementById('fileInput').click();
  };

  window.handleFileSelect = function(e) {
    addFiles([...e.target.files]);
    e.target.value = '';
  };

  window.handleDragOver = function(e) {
    e.preventDefault();
    document.getElementById('dropzone')?.classList.add('dragover');
  };
  window.handleDragLeave = function() {
    document.getElementById('dropzone')?.classList.remove('dragover');
  };
  window.handleDrop = function(e) {
    e.preventDefault();
    document.getElementById('dropzone')?.classList.remove('dragover');
    addFiles([...e.dataTransfer.files]);
  };

  function addFiles(newFiles) {
    selectedFiles = [...selectedFiles, ...newFiles];
    UI.renderFileList(selectedFiles);
    if (selectedFiles.length > 0 && !sessionActive) startSession();
  }

  function removeFile(i) {
    selectedFiles.splice(i, 1);
    UI.renderFileList(selectedFiles);
    if (selectedFiles.length === 0) {
      resetSendUI();
    }
  }

  function resetSendUI() {
    document.getElementById('genSection').style.display = 'none';
    document.getElementById('sendStatus').style.display = 'none';
    document.getElementById('cancelRow').style.display = 'none';
    sessionActive = false;
    OS.sessionCode = null;
  }

  // ── Start Session (Sender) ────────────────────────────────────
  function startSession() {
    sessionActive = true;
    window._filesToSend = selectedFiles;
    const meta = selectedFiles.map(f => ({ name: f.name, size: f.size,
      mime: f.type || 'application/octet-stream' }));
    createSession(meta, 'Sender');   // connection.js
    UI.setStatus('sendStatus', 'connecting',
      '<div class="spinner"></div> Creating session…');
  }

  // ── Called when server confirms session creation ──────────────
  window.onSessionCreated = function(code) {
    OS.sessionCode = code;
    const link = `${location.origin}/?r=${code}`;

    // Show the generator section
    document.getElementById('genSection').style.display = 'block';
    document.getElementById('cancelRow').style.display  = 'block';

    // Populate CODE display
    document.getElementById('displayCode').textContent = code;

    // Populate LINK
    const linkEl = document.getElementById('shareLinkText');
    if (linkEl) linkEl.value = link;

    // Render QR
    UI.renderQR(code);

    // Default to QR tab
    UI.switchConnectTab('qr');

    UI.setStatus('sendStatus', 'connecting',
      `<div class="spinner"></div> Waiting for receiver to connect…`);
  };

  // ── Connection method tabs (in gen section) ───────────────────
  window.showConnectTab = function(tab) {
    UI.switchConnectTab(tab);
  };

  // ── Copy / Share ──────────────────────────────────────────────
  window.copyCode = function() {
    const code = OS.sessionCode;
    if (!code) return;
    navigator.clipboard?.writeText(code)
      .then(() => UI.showToast('Code copied! ✓'))
      .catch(() => UI.showToast('Code: ' + code));
  };

  window.copyLink = function() {
    const link = `${location.origin}/?r=${OS.sessionCode}`;
    navigator.clipboard?.writeText(link)
      .then(() => UI.showToast('Link copied! ✓'))
      .catch(() => UI.showToast(link));
  };

  window.shareNative = function() {
    if (!OS.sessionCode) return;
    const link = `${location.origin}/?r=${OS.sessionCode}`;
    if (navigator.share) {
      navigator.share({
        title: 'OffiqShare — Receive files',
        text:  `Receive my files via OffiqShare. Code: ${OS.sessionCode}`,
        url:   link
      }).catch(() => {});
    } else {
      copyLink();
    }
  };

  window.shareWhatsApp = function() {
    if (!OS.sessionCode) return;
    const link = `${location.origin}/?r=${OS.sessionCode}`;
    const msg  = encodeURIComponent(
      `📂 Receive my files using OffiqShare:\nCode: *${OS.sessionCode}*\nLink: ${link}`);
    window.open(`https://wa.me/?text=${msg}`, '_blank');
  };

  // ── Cancel ────────────────────────────────────────────────────
  window.cancelSession = function() {
    cancelSession();   // connection.js
    resetSendUI();
    selectedFiles = [];
    UI.renderFileList([]);
    UI.showToast('Session cancelled');
  };

  // ── Receiver: Peek (see files before accepting) ───────────────
  window.doPeek = function(codeOverride) {
    const raw  = codeOverride || document.getElementById('recvCode')?.value || '';
    const code = raw.trim().toUpperCase();
    if (code.length < 4) {
      UI.showToast('Enter the session code first');
      return;
    }
    UI.setStatus('recvStatus', 'connecting',
      `<div class="spinner"></div> Looking up session ${code}…`);
    document.getElementById('recvStatus').style.display = 'block';
    peekSession(code);   // connection.js
  };

  // ── Called when server sends session-info (peek response) ─────
  window.onSessionInfo = function(info) {
    document.getElementById('recvStatus').style.display = 'none';
    UI.showAcceptModal(info);
  };

  // ── Receiver clicks Accept ────────────────────────────────────
  window.doAccept = function() {
    const modal = document.getElementById('acceptModal');
    if (!modal) return;
    const code = modal.dataset.code;
    UI.hideAcceptModal();
    UI.setStatus('recvStatus', 'connecting',
      `<div class="spinner"></div> Connecting to sender…`);
    acceptSession(code, 'Receiver');   // connection.js
  };

  // ── Receiver clicks Reject ────────────────────────────────────
  window.doReject = function() {
    const modal = document.getElementById('acceptModal');
    if (!modal) return;
    const code = modal.dataset.code;
    UI.hideAcceptModal();
    rejectSession(code);   // connection.js
    document.getElementById('recvCode').value = '';
    document.getElementById('recvStatus').style.display = 'none';
    UI.showToast('Transfer declined.');
  };

  // ── Called when session is joined (accepted) ──────────────────
  window.onSessionJoined = function(info) {
    UI.setStatus('recvStatus', 'connecting',
      `<div class="spinner"></div> Connected! Waiting for transfer to start…`);
  };

  // ── Transfer complete (receiver side) ─────────────────────────
  window.onTransferComplete = function() {
    // Transfer.js already handles the UI update via 'done' msg
  };

  // Expose to HTML
  return { removeFile, init };
})();

document.addEventListener('DOMContentLoaded', App.init);
