/**
 * resume.js — Transfer Resume / Recovery Module v2
 * ─────────────────────────────────────────────────
 * Saves transfer progress to sessionStorage so it
 * survives page refreshes.
 *
 * Recovery TTL: 30 minutes from disconnection.
 */

'use strict';

const Resume = (() => {
  const STORAGE_KEY = 'offiqshare_resume';
  const TTL_MS      = 30 * 60 * 1000;   // 30 minutes

  let countdownTimer = null;

  // ── State persistence ─────────────────────────────────────────
  function saveState(state) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        ...state,
        savedAt: Date.now(),
      }));
    } catch (e) { }
  }

  function loadState() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const state = JSON.parse(raw);
      const elapsed = Date.now() - (state.savedAt || 0);
      if (elapsed >= TTL_MS) {
        clearState();
        return null;
      }
      return state;
    } catch (e) {
      return null;
    }
  }

  function clearState() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { }
  }

  // ── Time remaining ────────────────────────────────────────────
  function remainingMs(state) {
    if (!state) return 0;
    const elapsed = Date.now() - (state.savedAt || 0);
    return Math.max(0, TTL_MS - elapsed);
  }

  function formatCountdown(ms) {
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const s = (totalSec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  // ── Countdown UI ──────────────────────────────────────────────
  function startCountdown(panelId, onExpire) {
    stopCountdown();

    function tick() {
      const state = loadState();
      if (!state) { stopCountdown(); onExpire?.(); return; }
      const ms = remainingMs(state);

      if (ms <= 0) {
        stopCountdown();
        clearState();
        onExpire?.();
        return;
      }

      UI.setStatus(panelId, 'error',
        `🔌 <strong>Connection Lost</strong><br>
         <small>Waiting for reconnection…</small><br>
         <small class="resume-countdown">Session expires in: ${formatCountdown(ms)}</small>`);
    }

    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function stopCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  // ── Public ────────────────────────────────────────────────────
  return { saveState, loadState, clearState, remainingMs, startCountdown, stopCountdown };
})();
