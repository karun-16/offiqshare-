/**
 * app.js — OffiqShare App Controller v2 (+ history + resume + desktop mode)
 * ──────────────────────────────────────────────────────────────────────────
 * Handles: file picking, session creation, all 3 connection
 * methods (QR / Code / Link), accept/reject flow, cancellation,
 * transfer history tab, resume-on-reconnect, and desktop-mode detection.
 *
 * Desktop mode:
 *   When running inside the Tauri desktop app, Tauri injects:
 *     window.OFFIQSHARE_DESKTOP = true
 *   This causes all download-related UI elements to be hidden via the
 *   CSS class "desktop-hidden". Browser users see everything unchanged.
 */

'use strict';

// ── Desktop Mode Detection ────────────────────────────────────────────────
// Runs immediately (before DOMContentLoaded) so elements are hidden before
// first paint, preventing any flash of download UI for desktop users.
(function applyDesktopMode() {
  if (!window.OFFIQSHARE_DESKTOP) return;

  // Inject a <style> rule that hides all download-related elements.
  // Using a CSS class rather than inline display:none keeps things clean
  // and easy to override or debug.
  const style = document.createElement('style');
  style.id = 'offiqshare-desktop-mode';
  style.textContent = '.desktop-hidden { display: none !important; }';
  // Append to <head> if available, otherwise <html> root
  (document.head || document.documentElement).appendChild(style);
})();

const App = (() => {

  let selectedFiles = [];
  let sessionActive = false;
  let pendingCode   = null;

  // ── Boot ──────────────────────────────────────────────────────
  function init() {
    // Apply desktop-mode hiding after DOM is ready.
    // This handles any elements that are dynamically rendered or
    // exist in the DOM but weren't caught by the pre-DOMContentLoaded pass.
    applyDesktopHiding();

    // Check URL for ?r=CODE
    const params = new URLSearchParams(location.search);
    const urlCode = params.get('r');
    if (urlCode && urlCode.length >= 4) {
      switchTab('recv');
      const input = document.getElementById('recvCode');
      if (input) input.value = urlCode.toUpperCase();
      setTimeout(() => doPeek(urlCode.toUpperCase()), 600);
    }

    if (location.hash === '#receive') switchTab('recv');

    // Render history if on that tab
    History.renderHistory();

    // Check for interrupted transfer (page refreshed during recovery window)
    const savedState = Resume.loadState();
    if (savedState) {
      const ms = Resume.remainingMs(savedState);
      if (ms > 0 && savedState.role === 'sender') {
        // Restore sender UI showing countdown
        switchTab('send');
        const panelId = 'sendStatus';
        document.getElementById('sendStatus').style.display = 'block';
        Resume.startCountdown(panelId, () => {
          Resume.clearState();
          UI.setStatus(panelId, 'error',
            '⏱ Transfer session expired. Start a new transfer.');
        });
        UI.showToast('⚠ Previous transfer was interrupted. Waiting for peer to reconnect…');
      }
    }
  }

  // ── Desktop Hiding ────────────────────────────────────────────
  // Finds all elements marked with data-desktop-hide="true" OR
  // matching known download-related selectors, and hides them.
  // Safe to call multiple times (idempotent).
  function applyDesktopHiding() {
    if (!window.OFFIQSHARE_DESKTOP) return;

    // 1. Any element explicitly tagged for desktop hiding
    document.querySelectorAll('[data-desktop-hide]').forEach(el => {
      el.classList.add('desktop-hidden');
    });

    // 2. Known selector patterns for download-related UI
    const downloadSelectors = [
      // Navbar download link
      'a[href="download.html"]',
      'a[href*="download.html"]',
      // Desktop announcement card / badge (homepage hero)
      '.desktop-announce',
      // Any element with a download-related class
      '.dl-card',
      '.dl-cards-section',
      '.dl-cards-grid',
      // Download page links that are buttons
      '.dl-btn-primary',
      // Windows-specific download button text matches
      'a[href*="releases"]',
    ];

    downloadSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        el.classList.add('desktop-hidden');
      });
    });
  }

  // ── Tab Switching ─────────────────────────────────────────────
  window.switchTab = function(tab) {
    ['send','recv','hist'].forEach(t => {
      document.getElementById('tab-' + t)?.classList.toggle('active', t === tab);
      document.getElementById('panel-' + t)?.classList.toggle('active', t === tab);
    });
    if (tab === 'hist') History.renderHistory();
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
    if (selectedFiles.length === 0) resetSendUI();
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
    createSession(meta, 'Sender');
    UI.setStatus('sendStatus', 'connecting',
      '<div class="spinner"></div> Creating session…');
  }

  // ── Called when server confirms session creation ──────────────
  window.onSessionCreated = function(code) {
    OS.sessionCode = code;
    const link = `${location.origin}/?r=${code}`;

    document.getElementById('genSection').style.display = 'block';
    document.getElementById('cancelRow').style.display  = 'block';

    document.getElementById('displayCode').textContent = code;

    const linkEl = document.getElementById('shareLinkText');
    if (linkEl) linkEl.value = link;

    UI.renderQR(code);
    UI.switchConnectTab('qr');

    UI.setStatus('sendStatus', 'connecting',
      `<div class="spinner"></div> Waiting for receiver to connect…`);
  };

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
    cancelSession();
    resetSendUI();
    selectedFiles = [];
    UI.renderFileList([]);
    UI.showToast('Session cancelled');
  };

  // ── Receiver: Peek ────────────────────────────────────────────
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
    peekSession(code);
  };

  window.onSessionInfo = function(info) {
    document.getElementById('recvStatus').style.display = 'none';
    UI.showAcceptModal(info);
  };

  window.doAccept = function() {
    const modal = document.getElementById('acceptModal');
    if (!modal) return;
    const code = modal.dataset.code;
    UI.hideAcceptModal();
    UI.setStatus('recvStatus', 'connecting',
      `<div class="spinner"></div> Connecting to sender…`);
    acceptSession(code, 'Receiver');
  };

  window.doReject = function() {
    const modal = document.getElementById('acceptModal');
    if (!modal) return;
    const code = modal.dataset.code;
    UI.hideAcceptModal();
    rejectSession(code);
    document.getElementById('recvCode').value = '';
    document.getElementById('recvStatus').style.display = 'none';
    UI.showToast('Transfer declined.');
  };

  window.onSessionJoined = function(info) {
    UI.setStatus('recvStatus', 'connecting',
      `<div class="spinner"></div> Connected! Waiting for transfer to start…`);
  };

  window.onTransferComplete = function() {
    // Transfer.js handles UI update via 'done' msg
  };

  // ── History actions exposed to HTML ───────────────────────────
  window.clearHistory = function() {
    if (confirm('Clear all transfer history?')) {
      History.clearAll();
    }
  };

  return { removeFile, init };
})();

document.addEventListener('DOMContentLoaded', App.init);
