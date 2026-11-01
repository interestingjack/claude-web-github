'use strict';
// Reads Claude Code transcripts (~/.claude/projects/<project>/<session>.jsonl) for the phone UI.
const fs = require('fs');
const path = require('path');
const { extractPaths } = require('../relay/public/file-paths');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDGE_BYTES = 64 * 1024;
const MAX_TEXT = 8000; // keeps a 200-message conversation well under the relay's 4MB frame limit
const MAX_RESULT = 500;

function sourceOf(entrypoint) {
  if (entrypoint && entrypoint.startsWith('claude-desktop')) return 'desktop';
  if (entrypoint === 'cli') return 'cli';
  return 'other';
}

function clip(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

function stripInjected(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/^\s*<rp_context>[\s\S]*?<\/rp_context>/, '') // RP mode's per-turn lore/variables
    .trim();
}

function toolSummary(block) {
  const input = block.input || {};
  const arg = input.command || input.file_path || input.pattern || input.url || input.query
    || input.description || input.prompt || Object.values(input).find((v) => typeof v === 'string') || '';
  return clip(`${block.name}: ${String(arg).replace(/\s+/g, ' ').trim()}`.replace(/: $/, ''), 160);
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return '';
}

// Upload metadata is small and persisted with the user turn; image bytes stay out of snapshots.
function normalizeAttachmentMessage(item) {
  if (item?.role !== 'user' || typeof item.text !== 'string') return item;
  const match = item.text.match(/^<claude_web_attachments>([\s\S]*?)<\/claude_web_attachments>(?:\r?\n){0,2}/);
  if (!match || match[1].length > 20000) return item;
  let data;
  try { data = JSON.parse(match[1]); } catch { return item; }
  if (!Array.isArray(data?.files) || !data.files.length || data.files.length > 5) return item;
  const files = data.files;
  if (!files.every(file => file && typeof file.id === 'string' && /^[a-f0-9-]{20,64}$/i.test(file.id)
    && typeof file.name === 'string' && file.name.length > 0 && file.name.length <= 255
    && typeof file.path === 'string' && file.path.length > 0 && file.path.length <= 4096
    && Number.isFinite(file.size) && file.size >= 0 && file.size <= 10 * 1024 * 1024
    && ['image', 'file'].includes(file.kind) && typeof file.mime === 'string' && file.mime.length <= 100)) return item;
  item.attachments = files.map(({ id, name, path: filePath, size, kind, mime }) => ({ id, name, path: filePath, size, kind, mime }));
  item.text = item.text.slice(match[0].length);
  return item;
}

// Slash commands are recorded as tagged pseudo-messages; turn them back into what was typed / printed.
function textMessage(role, raw, ts) {
  const text = stripInjected(raw);
  if (!text) return null;
  const item = normalizeAttachmentMessage({ role, text, ts });
  if (item.attachments) { item.text = clip(item.text, MAX_TEXT); return item; }
  if (role === 'user') {
    if (/^\[Request interrupted by user[^\]]*\]$/.test(text)) return { role: 'system', text: '已停止', ts };
    const cmd = text.match(/^<command-name>([\s\S]*?)<\/command-name>/);
    if (cmd) {
      const args = (text.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
      return { role: 'user', text: `${cmd[1].trim()} ${args.trim()}`.trim(), ts };
    }
    const stdout = text.match(/^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>$/);
    if (stdout) return stdout[1].trim() ? { role: 'system', text: clip(stdout[1].trim(), MAX_RESULT), ts } : null;
  }
  return { role, text: clip(text, MAX_TEXT), ts };
}

// File-producing tools and the desktop wrap-up become cards, like the desktop app shows them.
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
function toolMessage(b, cwd, ts) {
  const input = b.input || {};
  const abs = (p) => (cwd ? path.resolve(cwd, String(p)) : String(p));
  if (b.name === 'Write' && input.file_path) {
    const f = abs(input.file_path);
    return { role: 'file', action: 'write', files: [f], text: `新建 ${path.basename(f)}`, ts };
  }
  if (EDIT_TOOLS.has(b.name) && (input.file_path || input.notebook_path)) {
    const f = abs(input.file_path || input.notebook_path);
    return { role: 'file', action: 'edit', files: [f], text: `修改 ${path.basename(f)}`, ts };
  }
  if (b.name === 'SendUserFile' && Array.isArray(input.files) && input.files.length) {
    const files = input.files.map(abs);
    return { role: 'file', action: 'send', files, text: input.caption || `发送了 ${files.length} 个文件`, ts };
  }
  if (/(^|__)wrap_up$/.test(b.name) && input.recap) {
    return { role: 'recap', text: input.ask ? `${input.recap}\n\n❓ ${input.ask}` : input.recap, ts };
  }
  return { role: 'tool', text: toolSummary(b), ts };
}

// Turns one transcript record into zero or more display messages.
// Each message keeps its record uuid: rewinding resumes the conversation at a record.
function recordMessages(o, cwd = o.cwd) {
  const msgs = recordContent(o, cwd);
  if (o.uuid) for (const m of msgs) m.uuid = o.uuid;
  return msgs;
}

function recordContent(o, cwd) {
  if ((o.type !== 'user' && o.type !== 'assistant') || !o.message || o.isSidechain || o.isMeta) return [];
  const ts = o.timestamp || null;
  if (o.isCompactSummary) return [{ role: 'system', text: '（上下文已压缩，之前的内容被总结）', ts }];
  const content = o.message.content;
  if (typeof content === 'string') {
    const m = textMessage(o.type, content, ts);
    return m ? [m] : [];
  }
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (b.type === 'text') {
      const m = textMessage(o.type, b.text || '', ts);
      if (m) out.push(m);
    } else if (b.type === 'tool_use') {
      out.push(toolMessage(b, cwd, ts));
    } else if (b.type === 'tool_result') {
      out.push({ role: 'tool_result', text: clip(resultText(b.content), MAX_RESULT), ts });
    }
  }
  return out;
}

function contextUsedFrom(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  let total = 0, known = false;
  for (const key of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    if (!Object.hasOwn(usage, key)) continue;
    if (!Number.isFinite(usage[key]) || usage[key] < 0) return null;
    known = true;
    total += usage[key];
  }
  return known && Number.isFinite(total) ? total : null;
}

function parseLines(lines, wantMessages) {
  const r = { cwd: null, entrypoint: null, firstPrompt: null, customTitle: null, aiTitle: null, messages: [], files: new Set(), mentionedFiles: [], contextUsed: null };
  let lastCwd = null; // a desktop session can move folders mid-conversation
  for (const l of lines) {
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (o.type === 'custom-title' && o.customTitle) r.customTitle = o.customTitle;
    else if (o.type === 'ai-title' && o.aiTitle) r.aiTitle = o.aiTitle;
    if (!r.cwd && o.cwd) r.cwd = o.cwd;
    if (o.cwd) lastCwd = o.cwd;
    if (!r.entrypoint && o.entrypoint) r.entrypoint = o.entrypoint;
    if (wantMessages && o.type === 'assistant' && !o.isSidechain && !o.parent_tool_use_id && !o.isMeta) {
      const used = contextUsedFrom(o.message?.usage);
      if (used !== null) r.contextUsed = used;
    }
    const msgs = recordMessages(o, o.cwd || lastCwd);
    for (const m of msgs) if (m.files) m.files.forEach((f) => r.files.add(f));
    if (wantMessages && o.type === 'assistant' && o.message && !o.isSidechain) {
      const cwd = o.cwd || lastCwd;
      const content = typeof o.message.content === 'string' ? o.message.content
        : (Array.isArray(o.message.content) ? o.message.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n') : '');
      const mentionedText = [content, ...msgs.filter(m => m.role === 'recap').map(m => m.text)].join('\n');
      for (const file of extractPaths(mentionedText)) if (cwd && withinDirectory(file, cwd)) r.mentionedFiles.push({ file, cwd });
    }
    if (!r.firstPrompt) {
      const u = msgs.find((m) => m.role === 'user');
      if (u) r.firstPrompt = u.text;
    }
    if (!wantMessages) continue;
    for (const m of msgs) {
      // a typed "/cmd" is followed by its <command-name> record (possibly after a compact summary); show it once
      let i = r.messages.length - 1;
      while (i >= 0 && r.messages[i].role === 'system') i -= 1;
      const prev = r.messages[i];
      if (prev && m.role === 'user' && prev.role === 'user' && prev.text === m.text && !prev.attachments?.length && !m.attachments?.length) continue;
      r.messages.push(m);
    }
  }
  return r;
}

function finish(r) {
  return {
    cwd: r.cwd,
    source: sourceOf(r.entrypoint),
    title: r.customTitle || r.aiTitle || clip((r.firstPrompt || '').replace(/\s+/g, ' '), 60) || '(无标题)',
    firstPrompt: r.firstPrompt ? clip(r.firstPrompt.replace(/\s+/g, ' '), 120) : '',
  };
}

function parseTranscript(text) {
  const r = parseLines(text.split('\n'), true);
  return { ...finish(r), messages: r.messages, files: [...r.files], mentionedFiles: r.mentionedFiles, contextUsed: r.contextUsed };
}

// Head + tail of a big file is enough for list metadata (cwd/first prompt at the top, titles near the end).
async function readEdges(file, size) {
  const fh = await fs.promises.open(file, 'r');
  try {
    if (size <= EDGE_BYTES * 2) {
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      return buf.toString('utf8').split('\n');
    }
    const head = Buffer.alloc(EDGE_BYTES);
    const tail = Buffer.alloc(EDGE_BYTES);
    await fh.read(head, 0, EDGE_BYTES, 0);
    await fh.read(tail, 0, EDGE_BYTES, size - EDGE_BYTES);
    const h = head.toString('utf8').split('\n'); h.pop();   // last line is partial
    const t = tail.toString('utf8').split('\n'); t.shift(); // first line is partial
    return [...h, ...t];
  } finally {
    await fh.close();
  }
}

async function transcriptFiles(projectsDir) {
  const out = [];
  let dirs = [];
  try { dirs = await fs.promises.readdir(projectsDir, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files = [];
    try { files = await fs.promises.readdir(path.join(projectsDir, d.name)); } catch { continue; }
    for (const f of files) {
      const id = f.slice(0, -6);
      if (f.endsWith('.jsonl') && UUID_RE.test(id)) out.push({ id, file: path.join(projectsDir, d.name, f) });
    }
  }
  return out;
}

const metaCache = new Map(); // file -> { mtimeMs, meta }

async function listConversations(projectsDir, { limit = 50 } = {}) {
  const files = await transcriptFiles(projectsDir);
  const stats = await Promise.all(files.map(async (f) => {
    try { return { ...f, stat: await fs.promises.stat(f.file) }; } catch { return null; }
  }));
  const newest = stats.filter(Boolean).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, limit);
  return Promise.all(newest.map(async ({ id, file, stat }) => {
    const cached = metaCache.get(file);
    let meta = cached && cached.mtimeMs === stat.mtimeMs ? cached.meta : null;
    if (!meta) {
      meta = finish(parseLines(await readEdges(file, stat.size), false));
      metaCache.set(file, { mtimeMs: stat.mtimeMs, meta });
    }
    return { id, ...meta, updatedAt: stat.mtimeMs, size: stat.size };
  }));
}

async function readConversation(projectsDir, id, { maxMessages = 300 } = {}) {
  if (!UUID_RE.test(String(id))) return null;
  const hit = (await transcriptFiles(projectsDir)).find((f) => f.id === id);
  if (!hit) return null;
  const r = parseTranscript(await fs.promises.readFile(hit.file, 'utf8'));
  const truncated = r.messages.length > maxMessages;
  return { id, ...r, messages: truncated ? r.messages.slice(-maxMessages) : r.messages, truncated };
}

const MAX_FILE = 10 * 1024 * 1024; // base64 stays below the relay's 20MB frame limit
const MAX_TEXT_FILE = 2.5 * 1024 * 1024; // even JSON escaping stays within the socket limit
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); // Windows paths are case-insensitive
function withinDirectory(file, dir) {
  const api = /^[a-z]:[\\/]/i.test(file) ? path.win32 : path;
  const relative = api.relative(api.resolve(dir), api.resolve(file));
  return !!relative && relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}

// The phone may open files this conversation wrote, edited, sent or explicitly mentions within its project.
async function readConversationFile(projectsDir, id, filePath, { attachmentStore } = {}) {
  if (!UUID_RE.test(String(id)) || typeof filePath !== 'string' || !filePath) return { error: 'not_found' };
  const hit = (await transcriptFiles(projectsDir)).find((f) => f.id === id);
  if (!hit) return { error: 'not_found' };
  const { files, mentionedFiles, messages } = parseTranscript(await fs.promises.readFile(hit.file, 'utf8'));
  let ref = files.find((f) => samePath(f, filePath));
  let attachmentMime = null;
  if (!ref) {
    for (const item of messages) {
      if (item.role !== 'user') continue;
      for (const attachment of item.attachments || []) {
        if (!samePath(attachment.path, filePath)) continue;
        try {
          const repository = attachmentStore || new (require('./attachments').AttachmentStore)({ dir: path.join(__dirname, 'attachments') });
          const trusted = repository.metadataForSession(id, attachment.id);
          if (trusted && samePath(trusted.path, filePath)) {
            ref = trusted.path;
            if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(trusted.mime)) attachmentMime = trusted.mime;
          }
        } catch { /* A forged, missing, or cross-session attachment never grants file access. */ }
      }
    }
  }
  if (!ref) {
    const mention = mentionedFiles.find(f => samePath(f.file, filePath));
    if (mention) {
      try {
        const [realFile, realDirectory] = await Promise.all([fs.promises.realpath(mention.file), fs.promises.realpath(mention.cwd)]);
        if (withinDirectory(realFile, realDirectory)) ref = realFile;
      } catch { return { error: 'missing', path: mention.file }; }
    }
  }
  if (!ref) return { error: 'not_referenced' };
  let stat;
  try { stat = await fs.promises.stat(ref); } catch { return { error: 'missing', path: ref }; }
  if (!stat.isFile()) return { error: 'missing', path: ref };
  if (stat.size > MAX_FILE) return { error: 'too_large', path: ref, size: stat.size };
  const ext = path.extname(ref).slice(1).toLowerCase();
  const buf = await fs.promises.readFile(ref);
  const base = { path: ref, ext, size: stat.size };
  if (attachmentMime || IMAGE_MIME[ext]) return { ...base, kind: 'image', mime: attachmentMime || IMAGE_MIME[ext], content: buf.toString('base64') };
  const binary = () => ({ ...base, kind: 'binary', mime: 'application/octet-stream', encoding: 'base64', content: buf.toString('base64') });
  if (buf.length > MAX_TEXT_FILE || buf.subarray(0, 8192).includes(0) || /^(zip|7z|rar|pdf|docx?|xlsx?|pptx?|exe|dll)$/i.test(ext)) return binary();
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return binary(); }
  return { ...base, kind: 'text', content: buf.toString('utf8') };
}

module.exports = {
  parseTranscript, recordMessages, listConversations, readConversation, readConversationFile, sourceOf, UUID_RE, normalizeAttachmentMessage,
};
