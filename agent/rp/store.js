'use strict';
// On-disk RP data: imported cards (with avatar), global world books, settings and per-conversation state.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseImport } = require('./card');

const ID_RE = /^[0-9a-f]{10}$/;
const CHAT_RE = /^[\w-]{1,80}$/;
const DEFAULT_SETTINGS = { persona: { name: '用户', description: '' }, globalBooks: [], toggles: {} };

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => {
  const temp = `${f}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(v, null, 2)); fs.renameSync(temp, f); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
};

class RpStore {
  constructor(dir) {
    this.dir = dir;
    for (const d of ['cards', 'books', 'chats']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  }

  cardDir(id) { return path.join(this.dir, 'cards', id); }

  importFile(buf, filename) {
    const r = parseImport(buf, filename);
    const id = crypto.randomBytes(5).toString('hex');
    if (r.kind === 'card') {
      fs.mkdirSync(this.cardDir(id), { recursive: true });
      writeJson(path.join(this.cardDir(id), 'card.json'), r.card);
      if (r.avatar) fs.writeFileSync(path.join(this.cardDir(id), 'avatar.png'), r.avatar);
      return { kind: 'card', id, name: r.card.name };
    }
    writeJson(path.join(this.dir, 'books', `${id}.json`), r.book);
    return { kind: 'worldbook', id, name: r.book.name };
  }

  listCards() {
    const root = path.join(this.dir, 'cards');
    return fs.readdirSync(root).filter((id) => ID_RE.test(id)).map((id) => {
      const card = this.getCard(id);
      if (!card) return null;
      return {
        id, name: card.name, tags: card.tags, notes: (card.creator_notes || '').slice(0, 200),
        greetings: 1 + card.alternate_greetings.length,
        hasAvatar: fs.existsSync(path.join(this.cardDir(id), 'avatar.png')),
        mtime: fs.statSync(path.join(this.cardDir(id), 'card.json')).mtimeMs,
      };
    }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  }

  getCard(id) {
    if (!ID_RE.test(String(id))) return null;
    return readJson(path.join(this.cardDir(id), 'card.json'), null);
  }

  avatar(id) {
    if (!ID_RE.test(String(id))) return null;
    try { return fs.readFileSync(path.join(this.cardDir(id), 'avatar.png')); } catch { return null; }
  }

  setAvatar(id, buf) {
    if (!this.getCard(id)) throw new Error('找不到这张角色卡');
    require('./avatar').validateAvatar(buf);
    const file = path.join(this.cardDir(id), 'avatar.png');
    const temp = path.join(this.cardDir(id), `avatar-${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temp, buf);
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(this.cardDir(id), 'avatar.previous.png'));
      fs.renameSync(temp, file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }

  deleteCard(id) {
    if (ID_RE.test(String(id))) fs.rmSync(this.cardDir(id), { recursive: true, force: true });
  }

  listBooks() {
    const root = path.join(this.dir, 'books');
    return fs.readdirSync(root).filter((f) => ID_RE.test(f.replace(/\.json$/, ''))).map((f) => {
      const b = readJson(path.join(root, f), null);
      return b && { id: f.replace(/\.json$/, ''), name: b.name, entries: b.entries.length };
    }).filter(Boolean);
  }

  getBook(id) {
    if (!ID_RE.test(String(id))) return null;
    const b = readJson(path.join(this.dir, 'books', `${id}.json`), null);
    return b && { id, ...b };
  }

  deleteBook(id) {
    if (!ID_RE.test(String(id))) return;
    fs.rmSync(path.join(this.dir, 'books', `${id}.json`), { force: true });
    const s = this.settings();
    s.globalBooks = s.globalBooks.filter((b) => b !== id);
    this.saveSettings(s);
  }

  settings() {
    const s = readJson(path.join(this.dir, 'settings.json'), {});
    return { ...DEFAULT_SETTINGS, ...s, persona: { ...DEFAULT_SETTINGS.persona, ...(s.persona || {}) } };
  }

  saveSettings(s) { writeJson(path.join(this.dir, 'settings.json'), { ...this.settings(), ...s }); }

  // the card's own book first, then the enabled global books
  booksFor(cardId) {
    const out = [];
    const card = this.getCard(cardId);
    if (card && card.character_book) out.push({ id: `card-${cardId}`, ...card.character_book });
    for (const id of this.settings().globalBooks) {
      const b = this.getBook(id);
      if (b) out.push(b);
    }
    return out;
  }

  saveChat(sessionId, state) {
    if (CHAT_RE.test(String(sessionId))) writeJson(path.join(this.dir, 'chats', `${sessionId}.json`), state);
  }

  loadChat(sessionId) {
    if (!CHAT_RE.test(String(sessionId))) return null;
    return readJson(path.join(this.dir, 'chats', `${sessionId}.json`), null);
  }
}

module.exports = { RpStore };
