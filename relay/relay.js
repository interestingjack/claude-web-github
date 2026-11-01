'use strict';
// Claude Code web relay: phone browser <-> this server <-> Windows agent.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createStaticHandler, SEC_HEADERS } = require('./http-assets');
const { createUsageHandler } = require('./usage-channel');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const SESSION_FILE = path.join(__dirname, 'sessions.json');
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const COOKIE = 'crs';

// ---------- login sessions ----------
let loginSessions = {};
try { loginSessions = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { /* none yet */ }
function saveSessions() {
  const now = Date.now();
  for (const [k, exp] of Object.entries(loginSessions)) if (exp < now) delete loginSessions[k];
  fs.writeFileSync(SESSION_FILE, JSON.stringify(loginSessions), { mode: 0o600 });
}

function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function isAuthed(req) {
  const t = getCookie(req, COOKIE);
  const exp = t && loginSessions[t];
  return !!exp && exp > Date.now();
}

// per-IP brute force protection: 5 failures -> 10 minute lockout
const loginFails = new Map();
function clientIp(req) { return req.socket.remoteAddress || '?'; }

// ---------- HTTP ----------
const serveStatic = createStaticHandler(isAuthed);
const serveUsage = createUsageHandler({ isAuthed, agentToken: cfg.agentToken });

function send(res, code, type, body, extra) {
  res.writeHead(code, { 'Content-Type': type, ...SEC_HEADERS, ...(extra || {}) });
  res.end(body);
}

function readBody(req, limit, cb) {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > limit) req.destroy(); });
  req.on('end', () => cb(data));
}

const server = https.createServer({
  cert: fs.readFileSync(path.join(__dirname, cfg.cert)),
  key: fs.readFileSync(path.join(__dirname, cfg.key)),
}, (req, res) => {
  if (serveUsage(req, res)) return;
  if (serveStatic(req, res)) return;
  const url = new URL(req.url, 'https://local');
  const p = url.pathname;
  if (req.method === 'GET' && p === '/ca.crt') {
    // our own root CA (public part only); installed + trusted on the iPhone so Safari accepts the WebSocket
    return send(res, 200, 'application/x-x509-ca-cert', fs.readFileSync(path.join(__dirname, cfg.ca)),
      { 'Content-Disposition': 'attachment; filename="claude-relay-ca.crt"' });
  }
  if (req.method === 'GET' && p === '/api/me') {
    return send(res, 200, 'application/json', JSON.stringify({ authed: isAuthed(req) }));
  }
  if (req.method === 'POST' && p === '/api/login') {
    const ip = clientIp(req);
    const f = loginFails.get(ip);
    if (f && f.until > Date.now()) {
      return send(res, 429, 'application/json', JSON.stringify({ error: '尝试次数过多，请 10 分钟后再试' }));
    }
    return readBody(req, 4096, (body) => {
      let pw = '';
      try { pw = JSON.parse(body).password || ''; } catch { /* bad json */ }
      if (!sameSecret(pw, cfg.password)) {
        const cur = loginFails.get(ip) || { count: 0, until: 0 };
        cur.count += 1;
        if (cur.count >= 5) { cur.count = 0; cur.until = Date.now() + 10 * 60 * 1000; }
        loginFails.set(ip, cur);
        return send(res, 401, 'application/json', JSON.stringify({ error: '密码错误' }));
      }
      loginFails.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      loginSessions[token] = Date.now() + SESSION_TTL;
      saveSessions();
      send(res, 200, 'application/json', JSON.stringify({ ok: true }), {
        'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`,
      });
    });
  }
  if (req.method === 'POST' && p === '/api/logout') {
    const t = getCookie(req, COOKIE);
    if (t) { delete loginSessions[t]; saveSessions(); }
    return send(res, 200, 'application/json', '{"ok":true}', {
      'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    });
  }
  send(res, 404, 'text/plain', 'not found');
});

// ---------- WebSocket relay ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 20 * 1024 * 1024 });
let agent = null;
const clients = new Map(); // cid -> ws
let nextCid = 1;

function sendJson(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj) { const s = JSON.stringify(obj); for (const c of clients.values()) if (c.readyState === 1) c.send(s); }

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'https://local');
  if (url.pathname === '/ws/agent') {
    const auth = req.headers.authorization || '';
    if (!sameSecret(auth, `Bearer ${cfg.agentToken}`)) { socket.destroy(); return; }
    return wss.handleUpgrade(req, socket, head, (ws) => onAgent(ws));
  }
  if (url.pathname === '/ws/client') {
    // reject cross-site WebSocket hijacking: origin must be this host
    const origin = req.headers.origin || '';
    let originHost = '';
    try { originHost = new URL(origin).host; } catch { /* missing */ }
    if (!isAuthed(req) || originHost !== req.headers.host) { socket.destroy(); return; }
    return wss.handleUpgrade(req, socket, head, (ws) => onClient(ws));
  }
  socket.destroy();
});

function onAgent(ws) {
  if (agent) agent.close(4000, 'replaced');
  agent = ws;
  ws.isAlive = true;
  console.log(new Date().toISOString(), 'agent connected');
  broadcast({ type: 'agent_status', online: true });
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let env;
    try { env = JSON.parse(raw); } catch { return; }
    if (env.to != null) sendJson(clients.get(env.to), env.msg);
    else broadcast(env.msg);
  });
  ws.on('close', () => {
    if (agent !== ws) return;
    agent = null;
    console.log(new Date().toISOString(), 'agent disconnected');
    broadcast({ type: 'agent_status', online: false });
  });
}

function onClient(ws) {
  const cid = nextCid++;
  clients.set(cid, ws);
  ws.isAlive = true;
  sendJson(ws, { type: 'agent_status', online: !!agent });
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'ping') return sendJson(ws, { type: 'pong' });
    if (!agent) return sendJson(ws, { type: 'agent_status', online: false });
    sendJson(agent, { from: cid, msg });
  });
  ws.on('close', () => {
    clients.delete(cid);
    sendJson(agent, { from: cid, msg: { type: 'detach' } });
  });
}

setInterval(() => {
  for (const ws of [agent, ...clients.values()]) {
    if (!ws) continue;
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(cfg.port, () => console.log(`relay listening on https://0.0.0.0:${cfg.port}`));
