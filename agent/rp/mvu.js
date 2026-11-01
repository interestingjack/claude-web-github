'use strict';
// MagVarUpdate (MVU) compatible variables: [InitVar] seeding and _.set/_.add/_.insert/_.remove / JSONPatch updates.
// Paths are relative to stat_data, as in MVU.
const yaml = require('js-yaml');

function toPath(p) {
  const out = [];
  const re = /[^.[\]]+|\[(?:(-?\d+)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]/g;
  let m;
  while ((m = re.exec(String(p)))) {
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[3] !== undefined) out.push(m[3]);
    else out.push(m[0]);
  }
  return out;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
// old-style MVU values are [value, "description"]
const isPair = (v) => Array.isArray(v) && v.length === 2 && typeof v[1] === 'string' && (v[0] === null || typeof v[0] !== 'object');

function deepMerge(into, from) {
  for (const [k, v] of Object.entries(from || {})) {
    if (isObj(v) && isObj(into[k])) deepMerge(into[k], v);
    else into[k] = structuredClone(v);
  }
  return into;
}

function initVars(books) {
  const out = {};
  for (const b of books) {
    for (const e of b.entries) {
      if (!/\[InitVar\]/i.test(e.comment || '')) continue;
      try {
        const v = yaml.load(e.content);
        if (isObj(v)) deepMerge(out, v);
      } catch { /* malformed init block: skip */ }
    }
  }
  return out;
}

// split "a, [1,2], {x: 'y,z'}" at top-level commas
function splitArgs(s) {
  const out = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += s[++i] || ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((a) => a.trim());
}

function parseArg(s) {
  if (/^`[\s\S]*`$/.test(s)) return s.slice(1, -1);
  try { return JSON.parse(s); } catch { /* not strict JSON */ }
  try {
    const v = yaml.load(s); // handles 'single quotes', {key: value}, [a, b]
    return v === undefined ? s : v;
  } catch { return s; }
}

// index just past the ")" that closes the call starting at `start` (which points after "(")
function callEnd(text, start) {
  let depth = 1, quote = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && --depth === 0) return i;
  }
  return -1;
}

const OP_ALIAS = { set: 'set', add: 'add', insert: 'insert', assign: 'insert', remove: 'remove', delete: 'remove', unset: 'remove' };
const pointerToPath = (p) => String(p).replace(/^\//, '').split('/').map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~')).join('.');

function patchCommands(json) {
  const out = [];
  for (const p of Array.isArray(json) ? json : []) {
    const path = pointerToPath(p.path || '');
    if (p.op === 'replace') out.push({ op: 'set', path, args: [p.value] });
    else if (p.op === 'delta') out.push({ op: 'add', path, args: [p.value] });
    else if (p.op === 'remove') out.push({ op: 'remove', path, args: [] });
    else if (p.op === 'add' || p.op === 'insert') {
      if (path.endsWith('.-')) out.push({ op: 'insert', path: path.slice(0, -2), args: [p.value] });
      else out.push({ op: 'set', path, args: [p.value] });
    }
  }
  return out;
}

function extractCommands(text) {
  const blocks = [...String(text).matchAll(/<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gi)].map((m) => m[1]);
  let src = blocks.length ? blocks.join('\n') : String(text);
  const out = [];
  src = src.replace(/<JSONPatch>([\s\S]*?)<\/JSONPatch>/gi, (_, body) => {
    try { out.push(...patchCommands(JSON.parse(body))); } catch { /* malformed patch */ }
    return '';
  });
  const re = /_\.(set|add|insert|assign|remove|delete|unset)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = callEnd(src, start);
    if (end < 0) break;
    const args = splitArgs(src.slice(start, end)).map(parseArg);
    re.lastIndex = end + 1;
    if (!args.length) continue;
    out.push({ op: OP_ALIAS[m[1]], path: String(args.shift()), args });
  }
  return out;
}

function getAt(root, keys) {
  let o = root;
  for (const k of keys) { if (o == null) return undefined; o = o[k]; }
  return o;
}
function parentOf(root, keys, create) {
  let o = root;
  for (const k of keys.slice(0, -1)) {
    if (o[k] == null || typeof o[k] !== 'object') { if (!create) return null; o[k] = {}; }
    o = o[k];
  }
  return o;
}

function applyCommands(vars, cmds) {
  const out = structuredClone(vars || {});
  const changes = [];
  for (const c of cmds) {
    const keys = toPath(c.path);
    if (!keys.length) continue;
    const last = keys[keys.length - 1];
    const cur = getAt(out, keys);
    if (c.op === 'set') {
      const val = c.args.length >= 2 ? c.args[1] : c.args[0];
      if (isPair(cur) && !Array.isArray(val)) {
        changes.push({ path: c.path, from: cur[0], to: val });
        cur[0] = val;
      } else {
        parentOf(out, keys, true)[last] = val;
        changes.push({ path: c.path, from: cur, to: val });
      }
    } else if (c.op === 'add') {
      const delta = Number(c.args[0]) || 0;
      if (isPair(cur)) {
        const to = (Number(cur[0]) || 0) + delta;
        changes.push({ path: c.path, from: cur[0], to });
        cur[0] = to;
      } else {
        const to = (Number(cur) || 0) + delta;
        parentOf(out, keys, true)[last] = to;
        changes.push({ path: c.path, from: cur, to });
      }
    } else if (c.op === 'insert') {
      let target = cur;
      if (target == null) { target = c.args.length >= 2 ? {} : []; parentOf(out, keys, true)[last] = target; }
      if (c.args.length >= 2) {
        const [k, v] = c.args;
        if (Array.isArray(target)) target.splice(Number(k), 0, v); else target[k] = v;
        changes.push({ path: `${c.path}.${k}`, from: undefined, to: v });
      } else {
        const v = c.args[0];
        if (Array.isArray(target)) target.push(v);
        else if (isObj(v)) Object.assign(target, v);
        changes.push({ path: c.path, from: undefined, to: v });
      }
    } else if (c.op === 'remove') {
      if (!c.args.length) {
        const parent = parentOf(out, keys, false);
        if (!parent) continue;
        if (Array.isArray(parent)) parent.splice(Number(last), 1); else delete parent[last];
        changes.push({ path: c.path, from: cur, to: undefined });
      } else if (Array.isArray(cur)) {
        const a = c.args[0];
        const i = typeof a === 'number' ? a : cur.indexOf(a);
        if (i >= 0 && i < cur.length) changes.push({ path: c.path, from: cur.splice(i, 1)[0], to: undefined });
      } else if (isObj(cur)) {
        changes.push({ path: `${c.path}.${c.args[0]}`, from: cur[c.args[0]], to: undefined });
        delete cur[c.args[0]];
      }
    }
  }
  return { vars: out, changes };
}

function stripUpdateBlocks(text) {
  return String(text).replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '').trim();
}

module.exports = { toPath, initVars, extractCommands, applyCommands, stripUpdateBlocks, deepMerge };
