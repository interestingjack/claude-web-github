'use strict';
// One phone conversation = one `claude -p` stream-json process (started lazily, resumable).
const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');
const crypto = require('crypto');
const { createState, applyEvent, status } = require('./chat-events');

const BASE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
  '--include-partial-messages', '--verbose', '--replay-user-messages', '--permission-mode', 'auto'];

function withAttachments(text, attachments) {
  if (!attachments.length) return text;
  const data = JSON.stringify({ files: attachments,
    instruction: '这些文件由用户上传，已保存在本机。需要文件内容时可读取对应 path；kind 为 image 的附件同时作为本条消息的图片内容提供。',
  }).replace(/</g, '\\u003c');
  const marker = `<claude_web_attachments>${data}</claude_web_attachments>`;
  const prefix = text.match(/^<rp_context>[\s\S]*?<\/rp_context>(?:\r?\n){0,2}/)?.[0] || '';
  return `${prefix}${marker}\n\n${text.slice(prefix.length)}`;
}

function buildArgs({ resume, resumeAt, effort, extra = [] } = {}) {
  const args = [...BASE_ARGS];
  if (resume) {
    args.push('--resume', resume);
    // rewinding forks at an earlier record so the original conversation stays intact
    if (resumeAt) args.push('--resume-session-at', resumeAt, '--fork-session');
  }
  if (effort) args.push('--effort', effort);
  args.push(...extra);
  return args;
}

// claude.exe starts its own children (shells, MCP servers); take the whole tree down on Windows
function killTree(p) {
  if (!p || p.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], () => {});
  else p.kill();
}

class ChatSession extends EventEmitter {
  // extraArgs: called at every spawn, so RP mode can rewrite its system prompt file first
  constructor({ cwd, sessionId = null, title = '新对话', messages = [], command, env, extraArgs = () => [] }) {
    super();
    this.extraArgs = extraArgs;
    this.id = crypto.randomBytes(4).toString('hex');
    this.title = title;
    this.command = command;
    this.env = env;
    this.state = createState(cwd);
    this.state.sessionId = sessionId;
    this.state.messages = messages;
    this.proc = null;
    this.resumeAt = null;
    this.effort = null;
    this.updatedAt = Date.now();
  }

  info() {
    const s = this.state;
    return {
      id: this.id, title: this.title, cwd: s.cwd, sessionId: s.sessionId, running: s.running,
      alive: !!this.proc, updatedAt: this.updatedAt, contextUsed: s.contextUsed, contextWindow: s.contextWindow,
    };
  }

  snapshot() {
    return { chat: this.info(), messages: this.state.messages, streaming: this.state.streaming };
  }

  _emit(events) {
    for (const ev of events) {
      if (ev.kind === 'messages') {
        const normalize = require('./history').normalizeAttachmentMessage;
        if (normalize) for (const item of ev.items) normalize(item);
      }
      if (ev.kind === 'meta') this.emit('changed');
      this.emit('event', ev);
    }
  }

  _spawn() {
    const args = buildArgs({ resume: this.state.sessionId, resumeAt: this.resumeAt, effort: this.effort, extra: this.extraArgs() });
    this.resumeAt = null;
    const p = spawn(this.command, args, { cwd: this.state.cwd, env: this.env, windowsHide: true });
    this.proc = p;
    let buf = '';
    let errTail = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        this._emit(applyEvent(this.state, ev));
      }
    });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => { errTail = (errTail + d).slice(-1000); });
    const onEnd = (why) => {
      if (this.proc !== p) return;
      this.proc = null;
      const wasRunning = this.state.running;
      this.state.running = false;
      this.state.streaming = null;
      if (wasRunning) {
        const item = { role: 'system', text: `Claude 进程意外结束（${why}）${errTail.trim() ? '：' + errTail.trim().slice(-300) : ''}`, ts: new Date().toISOString() };
        this.state.messages.push(item);
        this.emit('event', { kind: 'messages', items: [item] });
      }
      this.emit('event', status(this.state));
      this.emit('changed');
    };
    p.on('exit', (code) => onEnd(`代码 ${code}`));
    p.on('error', (e) => onEnd(e.message));
  }

  send(text, { attachments = [], blocks = [] } = {}) {
    if (this.state.running) throw new Error('回复正在生成，请完成后再发送');
    if (!this.proc) this._spawn();
    if (this.title === '新对话' && !text.startsWith('/')) this.title = (text || attachments.map(a => a.name).join('、')).replace(/\s+/g, ' ').slice(0, 30);
    const content = [{ type: 'text', text: withAttachments(text, attachments) }, ...blocks];
    this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
    this.state.running = true;
    this.updatedAt = Date.now();
    this.emit('event', status(this.state));
    this.emit('changed');
  }

  stop() {
    if (!this.proc || !this.state.running) return;
    const p = this.proc;
    this.state.interrupted = true;
    p.stdin.write(JSON.stringify({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } }) + '\n');
    // if the interrupt is ignored, end the process; the next message resumes the conversation
    setTimeout(() => { if (this.proc === p && this.state.running) this.kill(); }, 5000);
  }

  // Drops the chosen user message and everything after it; returns its text for re-editing.
  rewind(uuid) {
    const msgs = this.state.messages;
    const idx = msgs.findIndex((m) => m.role === 'user' && m.uuid === uuid);
    if (idx < 0) return null;
    let prev = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].uuid && msgs[i].uuid !== uuid) { prev = msgs[i].uuid; break; }
    }
    const text = msgs[idx].text;
    this.kill();
    this.state.messages = msgs.slice(0, idx);
    if (prev) this.resumeAt = prev;
    else this.state.sessionId = null; // rewinding to the very first message is a fresh conversation
    this.emit('changed');
    return text;
  }

  kill() {
    const p = this.proc;
    this.proc = null;
    if (p) killTree(p);
    if (this.state.running) {
      this.state.running = false;
      this.state.streaming = null;
      this.emit('event', status(this.state));
    }
  }
}

module.exports = { ChatSession, buildArgs };
