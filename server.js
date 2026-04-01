/**
 * FIGHTROT — server.js
 * HTTP static file server + WS relay.
 * Run behind ngrok for HTTPS (required for mobile mic access):
 *   npx ngrok http 3000
 *
 * Message protocol (JSON strings):
 *   host   → server:  { type: 'host',   code, player }
 *   phone  → server:  { type: 'join',   code }
 *   server → phone:   { type: 'ack',    player }
 *   server → phone:   { type: 'error',  message }
 *   phone  → server:  { type: 'punch' }
 *   server → host:    { type: 'punch',  player }
 *   either → server:  { type: 'ping' }
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT   = 3000;
const PUBLIC = __dirname;

// ── MIME types ───────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
};

// ── HTTP static file + API server ────────────────────────────
const httpServer = http.createServer((req, res) => {
  const rawPath = req.url.split('?')[0];

  // /api/info — returns port so game.js knows what to show
  if (rawPath === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ port: PORT }));
    return;
  }
  // Serve static files — anything without an extension → index.html
  const filePath = (rawPath === '/' || !path.extname(rawPath))
    ? path.join(PUBLIC, 'index.html')
    : path.join(PUBLIC, rawPath);

  const contentType = MIME[path.extname(filePath)] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('\n⚔️   FIGHTROT');
  console.log(`🌐  Game:      http://localhost:${PORT}`);
  console.log(`\n📡  To expose to phones, run in another terminal:`);
  console.log(`      npx ngrok http ${PORT}`);
  console.log(`    Then paste the https://xxxx.ngrok-free.app URL into the phone.\n`);
});

// ── WS relay (shares the HTTP server — same port) ────────────
const wss = new WebSocketServer({ server: httpServer });

/**
 * rooms: Map<code, { Player1: ws|null, Player2: ws|null }>
 */
const rooms = new Map();

function getOrCreateRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, { Player1: null, Player2: null });
  }
  return rooms.get(code);
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

wss.on('connection', (ws) => {
  ws._role   = null;   // 'host' | 'controller'
  ws._code   = null;
  ws._player = null;   // 'Player1' | 'Player2'

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Keepalive ─────────────────────────────────────────────
    if (msg.type === 'ping') { send(ws, { type: 'pong' }); return; }

    // ── Host registers a player slot ──────────────────────────
    if (msg.type === 'host') {
      const { code, player } = msg;
      if (!code || !player) return;

      const room = getOrCreateRoom(code);
      room[player] = ws;

      ws._role   = 'host';
      ws._code   = code;
      ws._player = player;

      console.log(`[host]  code=${code}  player=${player}  registered`);
      send(ws, { type: 'registered', player });
      return;
    }

    // ── Phone joins a room ────────────────────────────────────
    if (msg.type === 'join') {
      const { code } = msg;
      if (!rooms.has(code)) {
        send(ws, { type: 'error', message: 'Invalid code — no game found.' });
        return;
      }

      const room = rooms.get(code);
      // Find which player slot this code is for (whichever has a host ws)
      let assignedPlayer = null;
      for (const p of ['Player1', 'Player2']) {
        if (room[p] && room[p]._role === 'host') {
          assignedPlayer = p;
          break;
        }
      }

      if (!assignedPlayer) {
        send(ws, { type: 'error', message: 'Host disconnected.' });
        return;
      }

      ws._role   = 'controller';
      ws._code   = code;
      ws._player = assignedPlayer;

      console.log(`[join]  code=${code}  player=${assignedPlayer}  phone connected`);

      // Ack back to phone
      send(ws, { type: 'ack', player: assignedPlayer });

      // Notify the host
      send(room[assignedPlayer], { type: 'phone_connected', player: assignedPlayer });
      return;
    }

    // ── Phone sends a punch / combo / block / toilet ──────────
    if (msg.type === 'punch' || msg.type === 'combo' || msg.type === 'block' || msg.type === 'toilet') {
      if (ws._role !== 'controller' || !ws._code || !ws._player) return;

      const room = rooms.get(ws._code);
      if (!room) return;

      const hostWs = room[ws._player];
      send(hostWs, { type: msg.type, player: ws._player });
      return;
    }
  });

  ws.on('close', () => {
    if (!ws._code) return;
    const room = rooms.get(ws._code);
    if (!room) return;

    if (ws._role === 'host' && ws._player) {
      room[ws._player] = null;
      console.log(`[close] code=${ws._code}  host ${ws._player} disconnected`);
      // Clean up empty rooms
      if (!room.Player1 && !room.Player2) rooms.delete(ws._code);
    }

    if (ws._role === 'controller' && ws._player) {
      const hostWs = room[ws._player];
      send(hostWs, { type: 'phone_disconnected', player: ws._player });
      console.log(`[close] code=${ws._code}  controller ${ws._player} disconnected`);
    }
  });
});

console.log('FIGHTROT server starting…');
