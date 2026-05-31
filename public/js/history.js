/**
 * history.js — Transfer History Module v2
 * ─────────────────────────────────────────
 * Persists transfer records to localStorage.
 * Statuses: completed | failed | cancelled | expired | resumed
 */

'use strict';

const History = (() => {
  const STORAGE_KEY = 'offiqshare_history';

  // ── Data Access ───────────────────────────────────────────────
  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function save(records) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    } catch (e) {
      console.warn('[history] Could not save:', e);
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────
  function addRecord(record) {
    const records = load();
    records.unshift({
      id:        Date.now() + Math.random().toString(36).slice(2),
      timestamp: Date.now(),
      ...record
    });
    save(records);
    renderHistory();
  }

  function deleteRecord(id) {
    const records = load().filter(r => r.id !== id);
    save(records);
    renderHistory();
  }

  function clearAll() {
    save([]);
    renderHistory();
  }

  // ── Rendering ─────────────────────────────────────────────────
  function formatTs(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    const mins = Math.floor(diff / 60000);
    const hrs  = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (mins < 1)   return 'Just now';
    if (mins < 60)  return `${mins}m ago`;
    if (hrs < 24)   return `${hrs}h ago`;
    if (days < 7)   return `${days}d ago`;
    return d.toLocaleDateString();
  }

  function statusBadge(status) {
    const map = {
      completed: { cls: 'hist-status-done',      icon: '✅', label: 'Completed' },
      failed:    { cls: 'hist-status-failed',     icon: '❌', label: 'Failed'    },
      cancelled: { cls: 'hist-status-cancelled',  icon: '✕',  label: 'Cancelled' },
      expired:   { cls: 'hist-status-expired',    icon: '⏱', label: 'Expired'   },
      resumed:   { cls: 'hist-status-resumed',    icon: '🔄', label: 'Resumed'   },
    };
    const s = map[status] || map.failed;
    return `<span class="hist-status ${s.cls}">${s.icon} ${s.label}</span>`;
  }

  function renderHistory() {
    const container = document.getElementById('historyList');
    if (!container) return;

    const records = load();

    if (records.length === 0) {
      container.innerHTML = `
        <div class="hist-empty">
          <div class="hist-empty-icon">📭</div>
          <div class="hist-empty-text">No transfer history yet</div>
          <div class="hist-empty-sub">Completed transfers will appear here</div>
        </div>`;
      return;
    }

    container.innerHTML = records.map(r => {
      const fileNames = (r.files || []).slice(0, 3).map(f =>
        `<span class="hist-file-chip">${UI.fileEmoji(f.name)} ${UI.escHtml(f.name)}</span>`
      ).join('');
      const more = r.files && r.files.length > 3
        ? `<span class="hist-file-more">+${r.files.length - 3} more</span>` : '';

      return `
        <div class="hist-item" data-id="${r.id}">
          <div class="hist-item-head">
            <div class="hist-item-meta">
              ${statusBadge(r.status)}
              <span class="hist-ts">${formatTs(r.timestamp)}</span>
            </div>
            <button class="hist-delete-btn" onclick="History.deleteRecord('${r.id}')" title="Delete">✕</button>
          </div>
          <div class="hist-files">${fileNames}${more}</div>
          <div class="hist-summary">
            ${r.fileCount || (r.files && r.files.length) || 0} file(s) ·
            ${UI.formatSize(r.totalSize || 0)}
            ${r.role ? ' · ' + (r.role === 'sender' ? '📤 Sent' : '📥 Received') : ''}
          </div>
        </div>`;
    }).join('');
  }

  // ── Public API ────────────────────────────────────────────────
  return { addRecord, deleteRecord, clearAll, renderHistory, load };
})();
