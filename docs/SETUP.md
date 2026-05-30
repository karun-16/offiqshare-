# OffiqShare v2 — Setup & Deployment Guide

## What's new in v2
- **3 ways to connect**: QR code, 6-letter code, and shareable link — all generated at once
- **Receiver accept/reject flow**: Receiver sees a file preview and must tap Accept before transfer starts
- **QR scanning auto-connects**: Scanning the QR opens OffiqShare with the session pre-loaded and file preview shown automatically
- **Link auto-connects**: Clicking a shared link does the same — receiver sees files and taps Accept
- Upgraded session TTL (15 min), better STUN servers, receiver-rejected signal back to sender

---

## Local Development (test in 3 minutes)

```bash
cd offiqshare-v2/server
npm install
npm start
```

Open `http://localhost:3000` in two browser tabs (or on two devices on the same WiFi).

**Device 1 (Sender):**
1. Go to Send tab
2. Drop any files
3. Choose: QR / Code / Link

**Device 2 (Receiver):**
- If QR: scan with phone camera → accept files
- If Link: click link → accept files  
- If Code: go to Receive tab → enter code → preview → accept

---

## Production Deployment (free)

### Option A — Railway (easiest, 2 min)

1. Push the `server/` folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select the repo, set root directory to `server/`
4. Railway auto-detects Node.js and deploys
5. Copy the Railway URL (e.g. `https://offiqshare.up.railway.app`)
6. Point your domain at it

### Option B — Render

1. Push to GitHub
2. [render.com](https://render.com) → New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Free tier is enough for thousands of sessions/day

### Option C — VPS (Hetzner / DigitalOcean / any)

```bash
git clone <your-repo> /opt/offiqshare
cd /opt/offiqshare/server
npm install
npm start

# With PM2 to keep it running
npm install -g pm2
pm2 start index.js --name offiqshare
pm2 save && pm2 startup
```

Use Nginx as reverse proxy with SSL (certbot).

---

## TURN Server (for users behind strict firewalls)

Most connections work with STUN only. For users behind corporate firewalls or strict NATs, add a TURN server:

**Free option: metered.ca** (50 GB/month free)

1. Sign up at [metered.ca](https://metered.ca)
2. Get your TURN credentials
3. In `public/js/connection.js`, add to `ICE_SERVERS`:

```javascript
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  {
    urls: 'turn:relay.metered.ca:80',
    username: 'YOUR_USERNAME',
    credential: 'YOUR_PASSWORD'
  },
  {
    urls: 'turns:relay.metered.ca:443',
    username: 'YOUR_USERNAME',
    credential: 'YOUR_PASSWORD'
  }
];
```

This adds relay capability for ~99.9% of network conditions.

---

## File Structure

```
offiqshare-v2/
├── server/
│   ├── index.js          ← Signaling server (Node.js + WebSocket)
│   └── package.json
└── public/
    ├── index.html         ← Full product (landing + app)
    ├── css/
    │   └── style.css
    └── js/
        ├── connection.js  ← WebSocket + WebRTC, peek/accept/reject
        ├── transfer.js    ← Chunked file engine (any size)
        ├── ui.js          ← DOM helpers + accept modal
        └── app.js         ← Controller, all 3 connection methods
```

---

## Key Technical Facts

| Item | Detail |
|------|--------|
| File transfer | WebRTC DataChannels (P2P direct) |
| Server role | Only relays ~1KB of signaling data per session |
| File size limit | None — files go device-to-device |
| Server bandwidth cost | ~0 — files never pass through |
| Encryption | DTLS-SRTP (WebRTC standard) |
| Session TTL | 15 minutes |
| Chunk size | 64 KB with flow control |
| QR encoding | Link to OffiqShare with session code |

---

## Cost at Scale

| Component | Cost |
|-----------|------|
| Signaling server (Railway/Render free tier) | $0/month |
| File transfer bandwidth | $0 — P2P |
| TURN relay (metered.ca free) | $0 (50 GB/month) |
| Domain | ~$12/year |
| **Total** | **~$1/month** |
