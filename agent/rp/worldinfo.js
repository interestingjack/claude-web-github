'use strict';
// SillyTavern-compatible world info ("lorebook") activation.
// Positions: 0 before char, 1 after char, 2/3 author's note top/bottom, 4 @depth, 5/6 example messages top/bottom.

const first = (...vals) => vals.find((v) => v !== undefined && v !== null);
const CHAR_BOOK_POSITION = { before_char: 0, after_char: 1 };

// Accepts both the world-file format ({entries: {uid: {...}}}) and the card's character_book ({entries: [...]}).
function normalizeBook(raw) {
  const list = Array.isArray(raw.entries) ? raw.entries : Object.values(raw.entries || {});
  const entries = list.map((e, i) => {
    const x = e.extensions || {};
    let position;
    if (typeof e.position === 'number') position = e.position;
    else if (typeof x.position === 'number') position = x.position;
    else position = first(CHAR_BOOK_POSITION[e.position], 1);
    return {
      uid: first(e.uid, e.id, i),
      comment: e.comment || e.name || '',
      keys: e.key || e.keys || [],
      secondaryKeys: e.keysecondary || e.secondary_keys || [],
      content: e.content || '',
      constant: !!e.constant,
      enabled: 'disable' in e ? !e.disable : e.enabled !== false,
      selective: !!e.selective,
      selectiveLogic: first(e.selectiveLogic, x.selectiveLogic, 0),
      order: first(e.order, e.insertion_order, 100),
      position,
      depth: first(e.depth, x.depth, 4),
      role: first(e.role, x.role, 0),
      probability: first(e.probability, x.probability, 100),
      useProbability: !!first(e.useProbability, x.useProbability, false),
      excludeRecursion: !!first(e.excludeRecursion, x.exclude_recursion, false),
      preventRecursion: !!first(e.preventRecursion, x.prevent_recursion, false),
      caseSensitive: !!first(e.caseSensitive, x.case_sensitive, false),
      matchWholeWords: !!first(e.matchWholeWords, x.match_whole_words, false),
      scanDepth: first(e.scanDepth, x.scan_depth, null),
    };
  });
  return { name: raw.name || '', entries };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matchKey(key, text, e) {
  if (!key) return false;
  const re = /^\/([\s\S]+)\/([a-z]*)$/.exec(key);
  if (re) {
    try { return new RegExp(re[1], re[2].replace('g', '')).test(text); } catch { return false; }
  }
  if (e.matchWholeWords) {
    return new RegExp(`(^|\\W)${escapeRe(key)}(\\W|$)`, e.caseSensitive ? '' : 'i').test(text);
  }
  return e.caseSensitive ? text.includes(key) : text.toLowerCase().includes(key.toLowerCase());
}

const LOGIC_AND_ANY = 0, LOGIC_NOT_ALL = 1, LOGIC_NOT_ANY = 2, LOGIC_AND_ALL = 3;

function keysFire(e, text) {
  if (!e.keys.some((k) => matchKey(k, text, e))) return false;
  if (!e.selective || !e.secondaryKeys.length) return true;
  const hits = e.secondaryKeys.map((k) => matchKey(k, text, e));
  switch (e.selectiveLogic) {
    case LOGIC_NOT_ALL: return !hits.every(Boolean);
    case LOGIC_NOT_ANY: return !hits.some(Boolean);
    case LOGIC_AND_ALL: return hits.every(Boolean);
    case LOGIC_AND_ANY:
    default: return hits.some(Boolean);
  }
}

// messages: newest first. toggles: { "bookId:uid": bool } overrides an entry's own enabled flag.
function activate(books, { messages = [], scanDepth = 2, toggles = {}, rng = Math.random, maxRecursion = 3 } = {}) {
  const candidates = [];
  for (const b of books) {
    for (const e of b.entries) {
      const key = `${b.id}:${e.uid}`;
      const on = key in toggles ? !!toggles[key] : e.enabled;
      if (on && e.content) candidates.push({ ...e, key, book: b.id });
    }
  }
  const lucky = (e) => !e.useProbability || e.probability >= 100 || rng() * 100 < e.probability;
  const active = new Map();

  for (const e of candidates) {
    const text = messages.slice(0, first(e.scanDepth, scanDepth)).join('\n');
    if ((e.constant || keysFire(e, text)) && lucky(e)) active.set(e.key, e);
  }

  // recursion: activated content may trigger further entries
  let fresh = [...active.values()];
  for (let level = 0; level < maxRecursion && fresh.length; level++) {
    const text = fresh.filter((e) => !e.preventRecursion).map((e) => e.content).join('\n');
    fresh = [];
    if (!text) break;
    for (const e of candidates) {
      if (active.has(e.key) || e.constant || e.excludeRecursion) continue;
      if (keysFire(e, text) && lucky(e)) { active.set(e.key, e); fresh.push(e); }
    }
  }

  const sorted = [...active.values()].sort((a, b) => a.order - b.order);
  return {
    before: sorted.filter((e) => e.position === 0),
    after: sorted.filter((e) => e.position === 1),
    depth: sorted.filter((e) => e.position === 4),
    other: sorted.filter((e) => ![0, 1, 4].includes(e.position)),
    activated: sorted.map((e) => e.key),
  };
}

module.exports = { normalizeBook, activate, matchKey };
