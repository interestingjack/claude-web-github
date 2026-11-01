'use strict';
// RP mode on top of a normal chat: greeting, per-turn lore/variables, MVU updates, regenerate + swipes.
const fs = require('fs');
const path = require('path');
const { buildSystemPrompt, buildTurn, greetingOf } = require('./prompt');
const { replaceMacros } = require('./macros');
const { initVars, extractCommands, applyCommands, stripUpdateBlocks } = require('./mvu');

const clone = (v) => structuredClone(v === undefined ? {} : v);
const HISTORY_SCAN = 10;
const contextUsage = (state) => ({
  contextUsed: Number.isFinite(state.contextUsed) && state.contextUsed >= 0 ? state.contextUsed : 0,
  contextWindow: Number.isFinite(state.contextWindow) && state.contextWindow >= 0 ? state.contextWindow : 0,
});

class RpController {
  // createChat(opts) -> ChatSession-like; notify(chat, ev) -> forwards an event to the chat's viewers
  // extraPromptFiles: user-chosen files appended verbatim to every RP system prompt (read at spawn time)
  constructor({ store, createChat, notify, extraPromptFiles = [] }) {
    this.store = store;
    this.createChat = createChat;
    this.notify = notify;
    this.extraPromptFiles = extraPromptFiles;
  }

  _extraPrompt() {
    return this.extraPromptFiles.map((f) => {
      try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; }
    }).filter(Boolean).join('\n\n');
  }

  _ctx(rp) {
    const card = this.store.getCard(rp.cardId);
    const settings = this.store.settings();
    return { card, persona: settings.persona, toggles: settings.toggles, books: this.store.booksFor(rp.cardId) };
  }

  _greetingMessage(rp) {
    const { card, persona } = this._ctx(rp);
    const text = replaceMacros(greetingOf(card, rp.greeting), { char: card.name, user: persona.name, card, vars: rp.vars });
    return { role: 'assistant', text, greeting: true };
  }

  _make({ rp, cwd, sessionId = null, messages }) {
    const { card } = this._ctx(rp);
    let chat = null;
    const extraArgs = () => {
      // rewritten at every spawn so persona / world book changes apply on the next message
      const c = this._ctx(rp);
      const file = path.join(this.store.dir, 'chats', `${chat.id}.system.md`);
      const extra = this._extraPrompt();
      const prompt = buildSystemPrompt({ ...c, greeting: rp.greeting, vars: rp.vars });
      fs.writeFileSync(file, extra ? `${prompt}\n\n${extra}\n` : prompt);
      return ['--append-system-prompt-file', file];
    };
    chat = this.createChat({ cwd, sessionId, title: card.name, messages, extraArgs });
    chat.rp = rp;
    chat.on('event', (ev) => this._onEvent(chat, ev));
    return chat;
  }

  newChat({ cardId, greeting = 0 }) {
    const card = this.store.getCard(cardId);
    if (!card) throw new Error('找不到这张角色卡');
    const vars = { stat_data: initVars(this.store.booksFor(cardId)) };
    const rp = { cardId, greeting: Math.max(0, Math.min(greeting | 0, card.alternate_greetings.length)), vars,
      varsBefore: clone(vars), lastUserText: '', lastAttachmentIds: [], turnText: '', swipes: [], swipeIndex: 0, regenerating: false };
    return this._make({ rp, cwd: this.store.cardDir(cardId), messages: [this._greetingMessage(rp)] });
  }

  // conv: { id, cwd, messages } from the transcript; null when it isn't an RP conversation
  fromHistory(conv) {
    const st = this.store.loadChat(conv.id);
    if (!st || !this.store.getCard(st.cardId)) return null;
    const rp = { cardId: st.cardId, greeting: st.greeting || 0, vars: st.vars || { stat_data: {} }, varsBefore: st.varsBefore || {},
      lastUserText: st.lastUserText || '', turnText: '', swipes: [], swipeIndex: 0, regenerating: false,
      lastAttachmentIds: Array.isArray(st.lastAttachmentIds) ? st.lastAttachmentIds.filter(id => typeof id === 'string' && /^[a-f0-9-]{20,64}$/.test(id)) : [],
      edits: Array.isArray(st.edits) ? st.edits : [] };
    const messages = [this._greetingMessage(rp), ...conv.messages];
    for (const edit of rp.edits) {
      const item = messages.find(m => m.role === 'assistant' && (edit.greeting ? m.greeting : m.uuid === edit.uuid && m.text === edit.originalText));
      if (item && typeof edit.text === 'string') item.text = edit.text;
    }
    const chat = this._make({ rp, cwd: conv.cwd, sessionId: conv.id, messages });
    const usage = contextUsage(st);
    const missingUsed = !Number.isFinite(st.contextUsed) || st.contextUsed < 0 || (usage.contextUsed === 0 && usage.contextWindow === 0);
    if (missingUsed && Number.isFinite(conv.contextUsed) && conv.contextUsed >= 0) usage.contextUsed = conv.contextUsed;
    Object.assign(chat.state, usage);
    return chat;
  }

  info(chat) {
    const rp = chat.rp;
    const card = this.store.getCard(rp.cardId) || { alternate_greetings: [] };
    return {
      cardId: rp.cardId, name: card.name, user: this.store.settings().persona.name,
      greeting: rp.greeting, greetings: 1 + card.alternate_greetings.length,
      swipes: { index: rp.swipeIndex, count: rp.swipes.length }, vars: rp.vars,
    };
  }

  _lastUserIndex(chat) {
    const msgs = chat.state.messages;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return i;
    return -1;
  }

  _version(chat) {
    return { sessionId: chat.state.sessionId, items: clone(chat.state.messages.slice(this._lastUserIndex(chat) + 1)), vars: clone(chat.rp.vars),
      ...contextUsage(chat.state) };
  }

  _save(chat) {
    const rp = chat.rp;
    if (!chat.state.sessionId) return;
    this.store.saveChat(chat.state.sessionId, {
      cardId: rp.cardId, greeting: rp.greeting, vars: rp.vars, varsBefore: rp.varsBefore, lastUserText: rp.lastUserText,
      edits: Array.isArray(rp.edits) ? rp.edits : [],
      lastAttachmentIds: Array.isArray(rp.lastAttachmentIds) ? rp.lastAttachmentIds : [],
      ...contextUsage(chat.state),
    });
  }

  _sendTurn(chat, text, options = {}) {
    const rp = chat.rp;
    const recent = chat.state.messages.filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-HISTORY_SCAN).reverse().map((m) => stripUpdateBlocks(m.text));
    let turn = buildTurn({ ...this._ctx(rp), history: [text, ...recent], vars: rp.vars, userText: text });
    const edits = (rp.edits || []).filter(e => chat.state.messages.some(m => m.role === 'assistant' && m.text === e.text && (e.greeting ? m.greeting : m.uuid === e.uuid)));
    if (edits.length) {
      const correction = '[用户修订的历史回复]\n以下历史回复已被用户编辑。继续故事时，以这些完整修订内容替代对应的旧回复；不要把旧内容继续当作事实。\n'
        + JSON.stringify(edits.map(e => ({ reply: e.greeting ? '开场白' : e.uuid, text: e.text }))) + '\n';
      turn = turn.startsWith('<rp_context>') ? turn.replace('<rp_context>', () => `<rp_context>\n${correction}`)
        : `<rp_context>\n${correction}</rp_context>\n\n${turn}`;
    }
    rp.varsBefore = clone(rp.vars);
    rp.lastUserText = text;
    rp.lastAttachmentIds = (options.attachments || []).map(attachment => attachment.id);
    rp.turnText = '';
    chat.send(turn, options);
  }

  send(chat, text, options = {}) {
    if (chat.state.running) throw new Error('回复正在生成，请完成后再发送');
    chat.rp.swipes = [];
    chat.rp.swipeIndex = 0;
    chat.rp.regenerating = false;
    this._sendTurn(chat, text, options);
  }

  editReply(chat, { uuid, greeting = false, originalText, text }) {
    if (!chat.rp) throw new Error('只能编辑角色扮演的回复');
    if (chat.state.running) throw new Error('回复正在生成，完成后才能编辑');
    if (typeof text !== 'string' || !text.trim() || text.length > 200000) throw new Error('请输入回复内容，最多 20 万字符');
    if (!greeting && !uuid) throw new Error('回复尚未同步完成，请稍后再试');
    const item = chat.state.messages.find(m => m.role === 'assistant' && (greeting ? m.greeting : m.uuid === uuid) && m.text === originalText);
    if (!item) throw new Error('这条回复已经更新，请重新打开编辑');
    const previous = Array.isArray(chat.rp.edits) ? chat.rp.edits : [];
    const existing = previous.find(e => (greeting ? e.greeting : e.uuid === uuid) && e.text === originalText);
    const edit = { uuid: item.uuid || null, greeting: !!item.greeting, originalText: existing ? existing.originalText : item.text, text };
    chat.rp.edits = previous.filter(e => e !== existing).concat(edit);
    try { this._save(chat); } catch (error) { chat.rp.edits = previous; throw error; }
    const currentSwipe = chat.rp.swipes[chat.rp.swipeIndex];
    if (currentSwipe) for (const m of currentSwipe.items) if (m.role === 'assistant' && m.uuid === item.uuid && m.text === item.text) m.text = text;
    item.text = text;
    chat.updatedAt = Date.now();
  }

  regen(chat) {
    const rp = chat.rp;
    if (chat.state.running) throw new Error('正在回复中');
    const idx = this._lastUserIndex(chat);
    if (idx < 0) throw new Error('还没有可以重新生成的回复');
    const uuid = chat.state.messages[idx].uuid;
    if (!uuid) throw new Error('这条消息还没同步完成，稍后再试');
    let options = {};
    if (rp.lastAttachmentIds?.length) {
      if (typeof this.resolveAttachments !== 'function') throw new Error('附件暂不可用，请稍后重试');
      options = this.resolveAttachments(chat, rp.lastAttachmentIds);
    }
    if (!rp.swipes.length) rp.swipes.push(this._version(chat));
    const text = rp.lastUserText || chat.state.messages[idx].text;
    rp.vars = clone(rp.varsBefore);
    chat.rewind(uuid);
    rp.regenerating = true;
    this._sendTurn(chat, text, options);
  }

  swipe(chat, index) {
    const rp = chat.rp;
    const v = rp.swipes[index];
    if (!v || chat.state.running) return false;
    chat.kill();
    const idx = this._lastUserIndex(chat);
    chat.state.messages = chat.state.messages.slice(0, idx + 1).concat(clone(v.items));
    chat.state.sessionId = v.sessionId;
    Object.assign(chat.state, contextUsage(v));
    chat.resumeAt = null;
    rp.vars = clone(v.vars);
    rp.swipeIndex = index;
    this._save(chat);
    return true;
  }

  setGreeting(chat, index) {
    if (chat.state.messages.some((m) => m.role === 'user')) throw new Error('对话已经开始，不能再换开场白');
    const card = this.store.getCard(chat.rp.cardId);
    chat.rp.greeting = Math.max(0, Math.min(index | 0, card.alternate_greetings.length));
    chat.rp.edits = (chat.rp.edits || []).filter(e => !e.greeting);
    chat.state.messages = [this._greetingMessage(chat.rp)];
    chat.kill(); // the greeting lives in the system prompt
  }

  setVars(chat, vars) {
    chat.rp.vars = clone(vars);
    this._save(chat);
  }

  _onEvent(chat, ev) {
    const rp = chat.rp;
    if (ev.kind === 'messages') {
      for (const it of ev.items) if (it.role === 'assistant') rp.turnText += `${it.text}\n`;
      return;
    }
    if (ev.kind !== 'status' || ev.running) return;
    const cmds = extractCommands(rp.turnText);
    rp.turnText = '';
    if (cmds.length) {
      const r = applyCommands(rp.vars.stat_data || {}, cmds);
      rp.vars = { ...rp.vars, stat_data: r.vars };
      this.notify(chat, { kind: 'vars', vars: rp.vars, changes: r.changes });
    }
    if (rp.regenerating) {
      rp.regenerating = false;
      rp.swipes.push(this._version(chat));
      rp.swipeIndex = rp.swipes.length - 1;
    }
    this.notify(chat, { kind: 'rp', rp: this.info(chat) });
    this._save(chat);
  }
}

module.exports = { RpController };
