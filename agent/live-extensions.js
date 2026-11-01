'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const KEY = Symbol.for('claude-web.rp-live-extensions');
const BIND_KEY = Symbol.for('claude-web.attachment-session-binding');
const COMMANDS = new Set(['rp_edit_reply', 'rp_set_avatar', 'attachment_upload', 'send_attachments', 'browse_folders', 'rp_book_entry']);
const MAX_RECEIPTS = 1000;

function validateRequestId(requestId) {
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) throw new Error('请求标识无效，请重试');
}

async function handleFolderBrowse(state, cid, message) {
  const reply = { type: 'folders_result', requestId: message.requestId };
  const pending = state.folderPending;
  let counted = false;
  try {
    validateRequestId(message.requestId);
    if ((pending.get(cid) || 0) >= 4) {
      const error = new Error('文件夹仍在加载，请稍后重试'); error.code = 'busy'; throw error;
    }
    pending.set(cid, (pending.get(cid) || 0) + 1); counted = true;
    const browse = state.options.browseFolders || require('./folders').browseFolders;
    const result = await browse({ path: message.path ?? null, offset: message.offset ?? 0, limit: message.limit ?? 100 });
    state.options.sendTo(cid, { ...reply, ...result, ok: true });
  } catch (error) {
    state.options.sendTo(cid, { ...reply, ok: false, code: error.code || 'unavailable', message: error.message || '暂时无法读取文件夹' });
  } finally {
    if (counted) {
      const count = (pending.get(cid) || 1) - 1;
      if (count) pending.set(cid, count); else pending.delete(cid);
    }
  }
}

function handleBookEntry(state, cid, message) {
  const reply = { type: 'rp_book_entry_result', requestId: message.requestId, bookId: message.bookId, key: message.key };
  const { store, sendTo } = state.options;
  try {
    validateRequestId(message.requestId);
    if (typeof message.bookId !== 'string' || message.bookId.length > 200 || typeof message.key !== 'string' || message.key.length > 500) throw new Error('世界书条目标识无效');
    const book = message.bookId.startsWith('card-')
      ? store.getCard(message.bookId.slice(5))?.character_book : store.getBook(message.bookId);
    const entry = Array.isArray(book?.entries) && book.entries.find(value => `${message.bookId}:${value.uid}` === message.key);
    if (!entry) throw new Error('找不到这个世界书条目，请重新打开列表');
    const toggles = store.settings().toggles || {};
    sendTo(cid, { ...reply, ok: true, entry: {
      key: message.key, comment: entry.comment, keys: entry.keys, constant: !!entry.constant,
      on: Object.hasOwn(toggles, message.key) ? !!toggles[message.key] : !!entry.enabled,
      content: typeof entry.content === 'string' ? entry.content : String(entry.content ?? ''),
    } });
  } catch (error) {
    sendTo(cid, { ...reply, ok: false, message: error.message || '暂时无法读取条目内容' });
  }
}

function attachmentStore(state) {
  if (!state.attachmentStore) state.attachmentStore = new (require('./attachments').AttachmentStore)({ dir: path.join(__dirname, 'attachments') });
  return state.attachmentStore;
}

function bindAttachments(chat, state) {
  if (chat[BIND_KEY]) { chat[BIND_KEY].state = state; return; }
  const binding = { state };
  chat[BIND_KEY] = binding;
  chat.on('event', ev => {
    if (ev.kind !== 'meta') return;
    try { attachmentStore(binding.state).bindSession(chat); }
    catch (error) { console.error('Attachment session binding failed:', error.message); }
  });
}

function hotReload(options) {
  const oldChat = require('./chat').ChatSession;
  for (const file of ['./rp/store', './rp/session', './chat']) delete require.cache[require.resolve(file)];
  const nextStore = require('./rp/store').RpStore;
  const nextRpc = require('./rp/session').RpController;
  const nextChat = require('./chat').ChatSession;
  const methods = Object.getOwnPropertyDescriptors(nextChat.prototype);
  delete methods.constructor;
  // agent.js may still hold the old constructor; update it as well as every live instance.
  for (const Class of new Set([oldChat, options.ChatSession].filter(Boolean))) Object.defineProperties(Class.prototype, methods);
  for (const chat of options.chats.values()) if (typeof chat._spawn === 'function') Object.defineProperties(chat, methods);
  require('./chat').ChatSession = oldChat;
  Object.setPrototypeOf(options.store, nextStore.prototype);
  Object.setPrototypeOf(options.rpc, nextRpc.prototype);
}

function handleAttachments(state, cid, message) {
  const opts = state.options;
  const replyType = message.type === 'attachment_upload' ? 'attachment_result' : 'send_result';
  const reply = { type: replyType, chatId: message.chatId, requestId: message.requestId };
  try {
    if (typeof message.requestId !== 'string' || !message.requestId.trim() || message.requestId.length > 128) throw new Error('请求标识无效，请重新发送');
    const chat = opts.chats.get(message.chatId);
    if (!chat) throw new Error('请先打开对话');
    if (message.type === 'attachment_upload') {
      if (chat.state.running) throw new Error('回复正在生成，完成后才能上传附件');
      const attachment = attachmentStore(state).upload(chat, message);
      bindAttachments(chat, state);
      return opts.sendTo(cid, { ...reply, ok: true, attachment });
    }
    const text = message.text === undefined ? '' : message.text;
    const ids = message.attachmentIds === undefined ? [] : message.attachmentIds;
    if (typeof text !== 'string' || !Array.isArray(ids) || ids.length > 5 || ids.some(id => typeof id !== 'string' || id.length > 128)) throw new Error('消息或附件格式不正确');
    if (!text.trim() && !ids.length) throw new Error('请输入内容或添加附件');
    const key = JSON.stringify([chat.id, message.requestId]);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ text, attachmentIds: ids })).digest('hex');
    const previous = state.receipts.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('重复请求的内容不同，请重新发送');
      return opts.sendTo(cid, previous.reply);
    }
    if (chat.state.running) throw new Error('回复正在生成，请完成后再发送');
    const prepared = ids.length ? attachmentStore(state).prepare(chat, ids) : { attachments: [], blocks: [] };
    if (ids.length) bindAttachments(chat, state);
    if (chat.rp && !(text.startsWith('/') && !ids.length)) opts.rpc.send(chat, text, prepared);
    else chat.send(text, prepared);
    const success = { ...reply, ok: true };
    state.receipts.set(key, { fingerprint, reply: success });
    if (state.receipts.size > MAX_RECEIPTS) state.receipts.delete(state.receipts.keys().next().value);
    opts.sendTo(cid, success);
  } catch (error) {
    opts.sendTo(cid, { ...reply, ok: false, message: error.message || '操作失败，请重试' });
  }
}

function dispatch(state, socket, event, args) {
  const opts = state.options;
  if (event !== 'message' || socket.url !== opts.cfg.relayUrl) return state.emit.call(socket, event, ...args);
  let envelope;
  try { envelope = JSON.parse(String(args[0])); } catch { return state.emit.call(socket, event, ...args); }
  const message = envelope?.msg;
  if (!Number.isInteger(envelope?.from) || !COMMANDS.has(message?.type)) return state.emit.call(socket, event, ...args);
  if (message.type === 'browse_folders') { void handleFolderBrowse(state, envelope.from, message); return true; }
  if (message.type === 'rp_book_entry') { handleBookEntry(state, envelope.from, message); return true; }
  if (message.type === 'attachment_upload' || message.type === 'send_attachments') {
    handleAttachments(state, envelope.from, message);
    return true;
  }
  const replyType = message.type === 'rp_edit_reply' ? 'rp_edit_result' : 'rp_avatar_result';
  try {
    if (message.type === 'rp_edit_reply') {
      const chat = opts.chats.get(message.chatId);
      if (!chat?.rp) throw new Error('请先打开角色扮演对话');
      opts.rpc.editReply(chat, message);
      opts.resync(chat);
    } else {
      if (typeof message.data !== 'string' || message.data.length > 2800000) throw new Error('头像图片超过 2MB');
      const avatar = Buffer.from(message.data, 'base64');
      opts.store.setAvatar(message.cardId, avatar);
      opts.broadcast({ type: 'rp_card', cardId: message.cardId, card: opts.store.getCard(message.cardId), avatar: avatar.toString('base64') });
      opts.broadcast(opts.rpListMsg());
    }
    opts.sendTo(envelope.from, { type: replyType, requestId: message.requestId, ok: true });
  } catch (error) {
    opts.sendTo(envelope.from, { type: replyType, requestId: message.requestId, ok: false, message: error.message || '操作失败，请重试' });
  }
  return true;
}

function install(options) {
  const { WebSocket, rpc } = options;
  if (options.hotReload) hotReload(options);
  const proto = WebSocket.prototype;
  const state = proto[KEY] || { emit: proto.emit };
  state.options = options;
  state.receipts ||= new Map();
  state.folderPending ||= new Map();
  if (options.attachmentStore) state.attachmentStore = options.attachmentStore;
  rpc.resolveAttachments = (chat, ids) => {
    const prepared = attachmentStore(state).prepare(chat, ids);
    bindAttachments(chat, state);
    return prepared;
  };
  proto[KEY] = state;
  state.dispatch = function(event, ...args) { return dispatch(state, this, event, args); };
  // Older releases captured their command set in emit. Replace that wrapper once, retaining its original emit.
  if (!state.wrapper) {
    proto.emit = state.emit;
    state.wrapper = function(event, ...args) { return state.dispatch.call(this, event, ...args); };
  }
  proto.emit = state.wrapper;
  return { installed: true, pid: process.pid };
}

module.exports = { install };
