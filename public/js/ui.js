/**
 * ui.js — UI Utilities v2
 * ─────────────────────────────────────────────────
 * New: accept/reject modal, larger QR, connection tabs
 */

'use strict';

const UI = (() => {

  // ── Formatters ────────────────────────────────────────────────
  function formatSize(bytes) {
    if (bytes < 1024)       return bytes + ' B';
    if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function fileEmoji(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
      jpg:'🖼️', jpeg:'🖼️', png:'🖼️', gif:'🖼️', webp:'🖼️', svg:'🖼️', bmp:'🖼️', heic:'🖼️',
      mp4:'🎬', mov:'🎬', avi:'🎬', mkv:'🎬', webm:'🎬', m4v:'🎬',
      mp3:'🎵', wav:'🎵', aac:'🎵', flac:'🎵', ogg:'🎵', m4a:'🎵',
      pdf:'📄', txt:'📄', md:'📄',
      zip:'📦', rar:'📦', '7z':'📦', tar:'📦', gz:'📦',
      doc:'📝', docx:'📝', odt:'📝', rtf:'📝',
      xls:'📊', xlsx:'📊', csv:'📊',
      ppt:'📑', pptx:'📑',
      js:'💻', ts:'💻', py:'💻', java:'💻', cpp:'💻', c:'💻',
      html:'💻', css:'💻', json:'💻',
      apk:'📲', ipa:'📲', exe:'⚙️', dmg:'⚙️',
    };
    return map[ext] || '📁';
  }

  // ── Toast ─────────────────────────────────────────────────────
  let toastTimer;
  function showToast(msg, dur = 3500) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), dur);
  }

  // ── Status Box ────────────────────────────────────────────────
  function setStatus(id, type, html) {
    const box = document.getElementById(id);
    if (!box) return;
    box.style.display = 'block';
    box.className = 'status-box status-' + type;
    box.innerHTML = `<div class="status-label">${html}</div>`;
  }

  function setStatusProgress(id, labelHtml, pct, speed, eta) {
    const box = document.getElementById(id);
    if (!box) return;
    box.style.display = 'block';
    box.className = 'status-box status-sending';
    box.innerHTML = `
      <div class="status-label">${labelHtml}</div>
      <div class="progress-track">
        <div class="progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="progress-meta">
        <span>${Math.round(pct)}%${speed ? ' · ' + speed : ''}</span>
        <span>${eta || ''}</span>
      </div>`;
  }

  // ── File List (sender) ─────────────────────────────────────────
  function renderFileList(files) {
    const fl = document.getElementById('fileList');
    if (!fl) return;
    fl.innerHTML = files.map((f, i) => `
      <div class="file-item">
        <div class="file-thumb">${fileEmoji(f.name)}</div>
        <div class="file-info">
          <div class="file-name">${escHtml(f.name)}</div>
          <div class="file-size">${formatSize(f.size)}</div>
        </div>
        <button class="file-remove" onclick="App.removeFile(${i})" aria-label="Remove">✕</button>
      </div>`).join('');
  }

  // ── Accept/Reject Preview (receiver sees files before accepting) ──
  function showAcceptModal(info) {
    const modal = document.getElementById('acceptModal');
    if (!modal) return;

    const { senderName, files, code } = info;
    const totalSize = files.reduce((a, f) => a + (f.size || 0), 0);

    document.getElementById('acceptSenderName').textContent = senderName || 'Someone';
    document.getElementById('acceptFileCount').textContent =
      `${files.length} file${files.length !== 1 ? 's' : ''} · ${formatSize(totalSize)}`;

    const list = document.getElementById('acceptFileList');
    list.innerHTML = files.slice(0, 8).map(f => `
      <div class="accept-file-item">
        <span class="accept-file-icon">${fileEmoji(f.name)}</span>
        <span class="accept-file-name">${escHtml(f.name)}</span>
        <span class="accept-file-size">${formatSize(f.size || 0)}</span>
      </div>`).join('') +
      (files.length > 8 ? `<div class="accept-more">+${files.length - 8} more files</div>` : '');

    modal.style.display = 'flex';
    modal.dataset.code = code;
  }

  function hideAcceptModal() {
    const modal = document.getElementById('acceptModal');
    if (modal) modal.style.display = 'none';
  }

  // ── Received file item ─────────────────────────────────────────
  function addReceivedFile(name, size, url) {
    const list = document.getElementById('incomingList');
    if (!list) return;
    const item = document.createElement('div');
    item.className = 'incoming-item';
    item.innerHTML = `
      <div class="file-thumb recv-thumb">${fileEmoji(name)}</div>
      <div class="file-info">
        <div class="file-name">${escHtml(name)}</div>
        <div class="file-size">${formatSize(size)}</div>
      </div>
      <a class="dl-btn" href="${url}" download="${escHtml(name)}">↓ Save</a>`;
    list.appendChild(item);
  }

  // ── QR Code (larger, with link) ───────────────────────────────
  function renderQR(code) {
    const el = document.getElementById('qr-render');
    if (!el) return;
    el.innerHTML = '';
    const link = `${location.origin}/?r=${code}`;
    try {
      new QRCode(el, {
        text: link,
        width: 160,
        height: 160,
        colorDark: '#0f0f12',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    } catch(e) {
      el.textContent = code;
    }
  }

  // ── Connection method tabs (send panel) ───────────────────────
  function switchConnectTab(tab) {
    ['tab-qr', 'tab-code', 'tab-link'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('active', id === 'tab-' + tab);
    });
    ['connect-qr', 'connect-code', 'connect-link'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = id === 'connect-' + tab ? 'block' : 'none';
    });
  }

  // ── Misc ──────────────────────────────────────────────────────
  function escHtml(str) {
    return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
                      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function scrollToApp() {
    document.getElementById('app')?.scrollIntoView({ behavior: 'smooth' });
  }

  return {
    formatSize, fileEmoji, showToast,
    setStatus, setStatusProgress,
    renderFileList, addReceivedFile,
    showAcceptModal, hideAcceptModal,
    renderQR, switchConnectTab,
    escHtml, scrollToApp
  };
})();

function scrollToApp() { UI.scrollToApp(); }
