'use strict';
// Imports SillyTavern character cards (PNG with embedded JSON, or JSON v1/v2/v3) and world book files.
const path = require('path');
const { normalizeBook } = require('./worldinfo');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UNKNOWN = '无法识别的文件：不是角色卡（PNG/JSON），也不是世界书 JSON';

function pngTextChunks(buf) {
  const out = {};
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'tEXt') {
      const zero = data.indexOf(0);
      if (zero > 0) out[data.toString('latin1', 0, zero)] = data.toString('latin1', zero + 1);
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return out;
}

function helperScripts(ext) {
  const th = ext.tavern_helper;
  if (Array.isArray(th)) { // older exports: [["scripts", [...]], ["variables", {...}]]
    const s = th.find((p) => Array.isArray(p) && p[0] === 'scripts');
    return s ? s[1] || [] : [];
  }
  return (th && th.scripts) || ext.TavernHelper_scripts || [];
}

function normalizeCard(json) {
  const d = json.data && typeof json.data === 'object' ? json.data : json;
  const ext = d.extensions || {};
  const dp = ext.depth_prompt;
  return {
    name: d.name || d.char_name || '未命名',
    description: d.description || '',
    personality: d.personality || '',
    scenario: d.scenario || '',
    first_mes: d.first_mes || '',
    alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [],
    mes_example: d.mes_example || '',
    system_prompt: d.system_prompt || '',
    post_history_instructions: d.post_history_instructions || '',
    creator_notes: d.creator_notes || json.creatorcomment || '',
    tags: Array.isArray(d.tags) ? d.tags : [],
    depth_prompt: dp && dp.prompt ? { prompt: dp.prompt, depth: dp.depth ?? 4, role: dp.role || 'system' } : null,
    regex_scripts: Array.isArray(ext.regex_scripts) ? ext.regex_scripts : [],
    helper_scripts: helperScripts(ext),
    character_book: d.character_book ? normalizeBook(d.character_book) : null,
  };
}

const isWorldbook = (j) => j && j.entries && typeof j.entries === 'object' && !j.data && !j.spec && !j.first_mes && !j.description;

function parseImport(buf, filename = '') {
  if (buf.subarray(0, 8).equals(PNG_SIG)) {
    const t = pngTextChunks(buf);
    const b64 = t.ccv3 || t.chara;
    if (!b64) throw new Error('这张 PNG 里没有角色卡数据');
    let json;
    try { json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch { throw new Error('PNG 里的角色卡数据已损坏'); }
    return { kind: 'card', card: normalizeCard(json), avatar: buf };
  }
  let json;
  try { json = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch { throw new Error(UNKNOWN); }
  if (isWorldbook(json)) {
    return { kind: 'worldbook', book: { ...normalizeBook(json), name: json.name || path.parse(filename).name || '世界书' } };
  }
  if (json && (json.name || (json.data && json.data.name))) return { kind: 'card', card: normalizeCard(json), avatar: null };
  throw new Error(UNKNOWN);
}

module.exports = { parseImport, normalizeCard };
