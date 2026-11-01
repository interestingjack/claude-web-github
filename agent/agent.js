'use strict';
// Windows agent: runs Claude conversations (stream-json) and connects out to the relay.
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const WebSocket = require('ws');
const history = require('./history');
const { ChatSession } = require('./chat');
const { RpStore } = require('./rp/store');
const { RpController } = require('./rp/session');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PROJECTS_DIR = cfg.projectsDir || path.join(os.homedir(), '.claude', 'projects');
const CA = fs.readFileSync(path.join(__dirname, cfg.caFile));
const IDLE_KILL_MS = 30 * 60 * 1000;

const chats = new Map();     // chat id -> ChatSession
const attached = new Map();  // relay client id -> chat id
let ws = null;
let backoff = 1000;

// started hidden at login there is no console, so always keep a log file (reset past 1MB)
const LOG_FILE = path.join(__dirname, 'agent.log');
try { if (fs.statSync(LOG_FILE).size > 1024 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch { /* no log yet */ }
function log(...a) {
  const line = [new Date().toLocaleString(), ...a].join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* disk issue, ignore */ }
}

// single instance: two agents would keep replacing each other on the relay
const lock = net.createServer();
lock.on('error', () => {
  log('another agent is already running, exiting');
  process.exit(0);
});
lock.listen('\\\\.\\pipe\\claude-web-agent', () => {
  try { require('./usage-publisher').start({ cfg }); } catch { log('usage helper unavailable'); }
  connect();
});

// When the agent itself was launched from inside a Claude Code session, drop the
// session markers it inherited so each spawned claude behaves like a fresh one.
function childEnv() {
  const env = { ...process.env };
  if (!process.env.CLAUDECODE) return env;
  const keep = new Set(cfg.keepEnv || []);
  for (const k of Object.keys(env)) {
    if (keep.has(k)) continue;
    if (/^(CLAUDECODE$|CLAUDE_|MCP_SERVER_CONNECTION|MCP_CONNECTION|ANTHROPIC_BASE_URL$)/.test(k)) delete env[k];
  }
  return env;
}

function sendTo(cid, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ to: cid, msg }));
}
function broadcast(msg) { sendTo(null, msg); }
function error(cid, message) { sendTo(cid, { type: 'error', message }); }

function chatsMsg() {
  return {
    type: 'chats', defaultCwd: cfg.defaultCwd,
    list: [...chats.values()].map((c) => ({ ...c.info(), rp: c.rp ? { cardId: c.rp.cardId } : null })),
  };
}

function toAttached(chat, msg) {
  for (const [cid, id] of attached) if (id === chat.id) sendTo(cid, msg);
}

function addChat(opts) {
  const chat = new ChatSession({ ...opts, command: cfg.claudeCommand, env: childEnv() });
  chats.set(chat.id, chat);
  // text deltas are coalesced (~40ms) so a fast stream doesn't flood the relay; order is kept
  let pending = '';
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (pending) toAttached(chat, { type: 'ev', chatId: chat.id, ev: { kind: 'delta', text: pending } });
    pending = '';
  };
  chat.on('event', (ev) => {
    if (ev.kind === 'delta') {
      pending += ev.text;
      if (!timer) timer = setTimeout(flush, 40);
      return;
    }
    flush();
    toAttached(chat, { type: 'ev', chatId: chat.id, ev });
  });
  chat.on('changed', () => broadcast(chatsMsg()));
  return chat;
}

function snapshotMsg(chat) {
  return { type: 'chat', ...chat.snapshot(), rp: chat.rp ? rpc.info(chat) : null };
}

function attach(cid, chat) {
  attached.set(cid, chat.id);
  sendTo(cid, snapshotMsg(chat));
}

function resync(chat) {
  for (const [c, id] of attached) if (id === chat.id) sendTo(c, snapshotMsg(chat));
  broadcast(chatsMsg());
}

// ---------- RP mode ----------
const store = new RpStore(path.join(__dirname, 'rp-data'));
const rpc = new RpController({
  store,
  createChat: (opts) => addChat(opts),
  notify: (chat, ev) => toAttached(chat, { type: 'ev', chatId: chat.id, ev }),
  extraPromptFiles: cfg.rpSystemPromptFiles || [],
});
require('./live-extensions').install({ WebSocket, cfg, chats, store, rpc, sendTo, resync, broadcast, rpListMsg });

function rpListMsg() {
  return { type: 'rp_list', cards: store.listCards(), books: store.listBooks(), settings: store.settings() };
}

// persona / world book changes reach idle RP chats through a fresh system prompt on their next message
function restartRpChats() {
  for (const c of chats.values()) if (c.rp && c.proc && !c.state.running) c.kill();
}

function bookEntries(bookId) {
  let book;
  if (String(bookId).startsWith('card-')) {
    const card = store.getCard(bookId.slice(5));
    book = card && card.character_book && { ...card.character_book, name: `${card.name}（角色卡自带）` };
  } else book = store.getBook(bookId);
  if (!book) return null;
  const toggles = store.settings().toggles;
  return {
    type: 'rp_book', bookId, name: book.name || '世界书',
    entries: book.entries.map((e) => {
      const key = `${bookId}:${e.uid}`;
      return { key, comment: e.comment, keys: e.keys, constant: e.constant, on: key in toggles ? !!toggles[key] : e.enabled };
    }),
  };
}

function handleRp(cid, msg, chat) {
  switch (msg.type) {
    case 'rp_list':
      return sendTo(cid, rpListMsg());
    case 'rp_import': {
      const buf = Buffer.from(String(msg.data || ''), 'base64');
      if (!buf.length || buf.length > 15 * 1024 * 1024) return error(cid, '文件为空或超过 15MB');
      const r = store.importFile(buf, String(msg.name || ''));
      log('rp import', r.kind, r.id, r.name);
      sendTo(cid, { type: 'rp_imported', ...r });
      return broadcast(rpListMsg());
    }
    case 'rp_card': {
      const card = store.getCard(msg.cardId);
      if (!card) return error(cid, '找不到这张角色卡');
      const av = store.avatar(msg.cardId);
      return sendTo(cid, { type: 'rp_card', cardId: msg.cardId, card, avatar: av ? av.toString('base64') : null });
    }
    case 'rp_delete_card':
      store.deleteCard(msg.cardId);
      return broadcast(rpListMsg());
    case 'rp_delete_book':
      store.deleteBook(msg.bookId);
      restartRpChats();
      return broadcast(rpListMsg());
    case 'rp_settings': {
      const next = {};
      if (msg.persona) next.persona = { name: String(msg.persona.name || '用户'), description: String(msg.persona.description || '') };
      if (Array.isArray(msg.globalBooks)) next.globalBooks = msg.globalBooks.map(String);
      store.saveSettings(next);
      restartRpChats();
      return broadcast(rpListMsg());
    }
    case 'rp_book': {
      const b = bookEntries(msg.bookId);
      return b ? sendTo(cid, b) : error(cid, '找不到这本世界书');
    }
    case 'rp_toggle': {
      const s = store.settings();
      s.toggles[String(msg.key)] = !!msg.on;
      store.saveSettings({ toggles: s.toggles });
      return restartRpChats();
    }
    case 'rp_new': {
      const c = rpc.newChat({ cardId: msg.cardId, greeting: msg.greeting });
      log('rp chat new', c.id, msg.cardId);
      broadcast(chatsMsg());
      return attach(cid, c);
    }
    case 'rp_regen':
      if (!chat || !chat.rp) return;
      rpc.regen(chat);
      return resync(chat);
    case 'rp_swipe':
      if (!chat || !chat.rp) return;
      if (rpc.swipe(chat, msg.index | 0)) resync(chat);
      return;
    case 'rp_greeting':
      if (!chat || !chat.rp) return;
      rpc.setGreeting(chat, msg.index | 0);
      return resync(chat);
    case 'rp_setvars':
      if (!chat || !chat.rp || !msg.vars || typeof msg.vars !== 'object') return;
      rpc.setVars(chat, msg.vars);
      return toAttached(chat, { type: 'ev', chatId: chat.id, ev: { kind: 'vars', vars: chat.rp.vars, changes: [] } });
  }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

async function openHistory(cid, hid) {
  const live = [...chats.values()].find((c) => c.state.sessionId === hid);
  if (live) return attach(cid, live);
  const conv = await history.readConversation(PROJECTS_DIR, hid, { maxMessages: 300 });
  if (!conv) return error(cid, '找不到这个对话');
  const rpChat = conv.cwd && isDir(conv.cwd) ? rpc.fromHistory(conv) : null;
  if (rpChat) {
    log('rp chat opened from history', rpChat.id, conv.id);
    broadcast(chatsMsg());
    return attach(cid, rpChat);
  }
  if (!conv.cwd || !isDir(conv.cwd)) {
    // still readable, but it can't be continued without its folder
    sendTo(cid, { type: 'chat', readonly: true, chat: { id: null, title: conv.title, cwd: conv.cwd, sessionId: conv.id },
      messages: conv.messages, streaming: null });
    return;
  }
  const chat = addChat({ cwd: conv.cwd, sessionId: conv.id, title: conv.title, messages: conv.messages });
  log('chat opened from history', chat.id, conv.id);
  broadcast(chatsMsg());
  attach(cid, chat);
}

function handle(cid, msg) {
  const chat = msg.chatId ? chats.get(msg.chatId) : null;
  const text = typeof msg.text === 'string' ? msg.text : '';
  if (String(msg.type).startsWith('rp_')) {
    try { return handleRp(cid, msg, chat); } catch (e) { return error(cid, e.message); }
  }
  switch (msg.type) {
    case 'list':
      return sendTo(cid, chatsMsg());
    case 'history_list':
      return history.listConversations(PROJECTS_DIR, { limit: Math.min(200, msg.limit | 0 || 80) })
        .then((list) => sendTo(cid, { type: 'history', list: list.map((h) => {
          const st = store.loadChat(h.id);
          return st ? { ...h, rp: { cardId: st.cardId } } : h;
        }) }))
        .catch((e) => error(cid, `读取历史失败：${e.message}`));
    case 'open':
      return openHistory(cid, msg.hid).catch((e) => error(cid, `打开对话失败：${e.message}`));
    case 'open_chat':
      if (!chat) return sendTo(cid, chatsMsg());
      return attach(cid, chat);
    case 'new': {
      const cwd = String(msg.cwd || cfg.defaultCwd).trim();
      if (!isDir(cwd)) return error(cid, `目录不存在：${cwd}`);
      const c = addChat({ cwd });
      log('chat new', c.id, cwd);
      broadcast(chatsMsg());
      return attach(cid, c);
    }
    case 'send':
      if (!chat || !text.trim()) return;
      try {
        // slash commands (/compact, /context, …) go to claude as-is, also in RP mode
        if (chat.rp && !text.startsWith('/')) rpc.send(chat, text);
        else chat.send(text);
      } catch (e) { error(cid, `发送失败：${e.message}`); }
      return;
    case 'stop':
      if (chat) chat.stop();
      return;
    case 'rewind': {
      if (!chat) return;
      const lastUser = [...chat.state.messages].reverse().find((m) => m.role === 'user');
      const old = chat.rewind(msg.uuid);
      if (old === null) return error(cid, '这条消息无法回溯');
      if (chat.rp) {
        // only the latest turn's starting variables are known; earlier rewinds keep the current ones
        if (lastUser && lastUser.uuid === msg.uuid) chat.rp.vars = structuredClone(chat.rp.varsBefore);
        chat.rp.swipes = [];
        chat.rp.swipeIndex = 0;
      }
      log('chat rewind', chat.id);
      resync(chat);
      return sendTo(cid, { type: 'rewound', chatId: chat.id, text: old });
    }
    case 'close':
      if (!chat) return;
      chat.kill();
      chats.delete(chat.id);
      for (const [c, id] of attached) if (id === chat.id) attached.delete(c);
      log('chat closed', chat.id);
      return broadcast(chatsMsg());
    case 'detach':
      return attached.delete(cid);
    case 'file_get':
      return history.readConversationFile(PROJECTS_DIR, msg.hid, msg.path)
        .then((f) => sendTo(cid, { type: 'file', req: msg.path, ...f }))
        .catch((e) => sendTo(cid, { type: 'file', req: msg.path, error: e.message }));
  }
}

// idle conversations give their process back; the next message resumes them
setInterval(() => {
  const now = Date.now();
  for (const c of chats.values()) {
    if (c.proc && !c.state.running && now - c.updatedAt > IDLE_KILL_MS) {
      log('chat idle, stopping process', c.id);
      c.kill();
      broadcast(chatsMsg());
    }
  }
}, 60 * 1000);

function connect() {
  log('connecting to', cfg.relayUrl);
  const sock = new WebSocket(cfg.relayUrl, {
    ca: CA,
    headers: { Authorization: `Bearer ${cfg.agentToken}` },
    handshakeTimeout: 15000,
    maxPayload: 20 * 1024 * 1024, // card uploads (base64)
  });
  let alive = true;
  let hb = null;

  sock.on('open', () => {
    ws = sock;
    backoff = 1000;
    attached.clear(); // relay client ids are re-issued; clients re-open their chat on agent_status
    log('connected');
    broadcast(chatsMsg());
    hb = setInterval(() => {
      if (!alive) return sock.terminate();
      alive = false;
      sock.ping();
    }, 25000);
  });
  sock.on('pong', () => { alive = true; });
  sock.on('message', (raw) => {
    let env;
    try { env = JSON.parse(raw); } catch { return; }
    if (env && env.msg) handle(env.from, env.msg);
  });
  sock.on('error', (e) => log('ws error:', e.message));
  sock.on('close', (code) => {
    clearInterval(hb);
    if (ws === sock) ws = null;
    log(`disconnected (${code}), retry in ${backoff / 1000}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  });
}

process.on('uncaughtException', (e) => log('uncaught:', e && e.stack || e));
