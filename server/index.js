/**
 * OffiqShare Signaling Server v2
 * ─────────────────────────────────────────────────────────────
 * Features:
 *  - 6-char CODE connection
 *  - Shareable LINK  (?r=CODE)
 *  - QR Code (generated client-side, encodes the link)
 *  - Receiver ACCEPT / REJECT flow before transfer begins
 *  - Session TTL cleanup
 *  - Files NEVER pass through here — only tiny signaling msgs
 * ─────────────────────────────────────────────────────────────
 */

const express           = require('express');
const { WebSocketServer } = require('ws');
const cors              = require('cors');
const http              = require('http');
const path              = require('path');
const { v4: uuidv4 }   = require('uuid');

const PORT          = process.env.PORT || 3000;
const SESSION_TTL   = 15 * 60 * 1000; // 15 minutes

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
);

// ─── Session Store ─────────────────────────────────────────────
// sessions[CODE] = { sender, receiver|null, files[], state, createdAt }
// state: 'waiting' | 'pending-accept' | 'accepted' | 'transferring' | 'done'
const sessions = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return sessions.has(c) ? genCode() : c;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, s] of sessions.entries()) {
    if (now - s.createdAt > SESSION_TTL) {
      notify(s.sender,   { type: 'session-expired' });
      notify(s.receiver, { type: 'session-expired' });
      sessions.delete(code);
      console.log(`[cleanup] Expired: ${code}`);
    }
  }
}, 60_000);

function notify(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// ─── WebSocket ─────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.id   = uuidv4();
  ws.role = null;
  ws.code = null;
  console.log(`[ws] +${ws.id.slice(0,8)}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handle(ws, msg);
  });

  ws.on('close', () => {
    console.log(`[ws] -${ws.id.slice(0,8)} (${ws.role}, ${ws.code})`);
    if (!ws.code) return;
    const s = sessions.get(ws.code);
    if (!s) return;
    const other = ws.role === 'sender' ? s.receiver : s.sender;
    notify(other, { type: 'peer-disconnected' });
    if (ws.role === 'sender') sessions.delete(ws.code);
  });

  ws.on('error', (e) => console.error('[ws]', e.message));
});

function handle(ws, msg) {
  switch (msg.type) {

    // ── SENDER: create session ─────────────────────────────
    case 'create-session': {
      const code = genCode();
      sessions.set(code, {
        sender:    ws,
        receiver:  null,
        files:     msg.files || [],
        senderName: msg.senderName || 'Anonymous',
        state:     'waiting',
        createdAt: Date.now(),
      });
      ws.role = 'sender';
      ws.code = code;
      console.log(`[session] Created ${code}`);
      notify(ws, { type: 'session-created', code });
      break;
    }

    // ── RECEIVER: peek at session before joining ───────────
    case 'peek-session': {
      const code = (msg.code || '').toUpperCase().trim();
      const s = sessions.get(code);
      if (!s) return notify(ws, { type: 'error', message: 'Session not found. Check the code.' });
      if (s.receiver) return notify(ws, { type: 'error', message: 'Someone is already connected to this session.' });
      // Send session info so receiver can see files before accepting
      notify(ws, {
        type:       'session-info',
        code,
        files:      s.files,
        senderName: s.senderName,
      });
      break;
    }

    // ── RECEIVER: accept and join ──────────────────────────
    case 'join-session': {
      const code = (msg.code || '').toUpperCase().trim();
      const s = sessions.get(code);
      if (!s) return notify(ws, { type: 'error', message: 'Session not found.' });
      if (s.receiver) return notify(ws, { type: 'error', message: 'Session already has a receiver.' });

      s.receiver    = ws;
      s.state       = 'accepted';
      ws.role       = 'receiver';
      ws.code       = code;
      console.log(`[session] Joined ${code}`);

      notify(ws, { type: 'session-joined', code, files: s.files, senderName: s.senderName });
      notify(s.sender, { type: 'receiver-joined', receiverName: msg.receiverName || 'Receiver' });
      break;
    }

    // ── RECEIVER: reject ───────────────────────────────────
    case 'reject-session': {
      const code = (msg.code || '').toUpperCase().trim();
      const s = sessions.get(code);
      if (!s) return;
      notify(s.sender, { type: 'receiver-rejected' });
      break;
    }

    // ── WebRTC SIGNALING ───────────────────────────────────
    case 'offer':
    case 'answer':
    case 'ice-candidate': {
      const s = sessions.get(ws.code);
      if (!s) return;
      const target = ws.role === 'sender' ? s.receiver : s.sender;
      notify(target, msg);
      break;
    }

    // ── TRANSFER EVENTS ────────────────────────────────────
    case 'transfer-complete': {
      const s = sessions.get(ws.code);
      if (!s) return;
      s.state = 'done';
      const target = ws.role === 'sender' ? s.receiver : s.sender;
      notify(target, { type: 'transfer-complete' });
      console.log(`[session] Done: ${ws.code}`);
      break;
    }

    case 'cancel': {
      const s = sessions.get(ws.code);
      if (!s) return;
      const other = ws.role === 'sender' ? s.receiver : s.sender;
      notify(other, { type: 'cancelled', by: ws.role });
      sessions.delete(ws.code);
      console.log(`[session] Cancelled: ${ws.code}`);
      break;
    }
  }
}

// ─── Health ─────────────────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({ status: 'ok', sessions: sessions.size, uptime: Math.floor(process.uptime()) + 's' })
);

server.listen(PORT, () => {
  console.log(`\n🚀 OffiqShare v2 running on :${PORT}`);
  console.log(`   http://localhost:${PORT}\n`);
});
