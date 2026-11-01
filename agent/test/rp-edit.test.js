'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const zlib = require('node:zlib');
const { RpStore } = require('../rp/store');
const { RpController } = require('../rp/session');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-edit-test-'));
  t.after(() => { if (path.dirname(dir) === os.tmpdir()) fs.rmSync(dir, { recursive: true, force: true }); });
  const store = new RpStore(dir);
  const { id } = store.importFile(Buffer.from(JSON.stringify({ name: '测试角色', description: '完整角色提示词保持原样', first_mes: '原始开场' })), 'card.json');
  const rpc = new RpController({ store, notify() {}, createChat(opts) {
    const chat = new EventEmitter();
    Object.assign(chat, { id: 'testchat', state: { cwd: opts.cwd, sessionId: '11111111-1111-4111-8111-111111111111', messages: opts.messages, running: false }, sent: [], send(text) { this.sent.push(text); }, kill() { throw new Error('Editing must not kill any process'); } });
    return chat;
  } });
  const chat = rpc.newChat({ cardId: id });
  chat.state.messages.push({ role: 'user', uuid: 'user-1', text: '你好' }, { role: 'assistant', uuid: 'reply-1', text: '原始回复' });
  return { store, rpc, chat, id, dir };
}

test('editing an RP reply persists, changes future turn context and rejects running/stale saves', t => {
  const { store, rpc, chat } = setup(t);
  const edit = { uuid: 'reply-1', originalText: '原始回复', text: '修改后的完整回复\n保留末尾空格  ' };
  rpc.editReply(chat, edit);
  assert.equal(chat.state.messages.at(-1).text, edit.text);
  assert.equal(store.loadChat(chat.state.sessionId).edits[0].text, edit.text);
  const reopened = rpc.fromHistory({ id: chat.state.sessionId, cwd: chat.state.cwd, messages: [{ role: 'user', text: '你好' }, { role: 'assistant', uuid: 'reply-1', text: '原始回复' }] });
  assert.equal(reopened.state.messages.at(-1).text, edit.text);
  rpc.send(chat, '接着讲');
  assert.ok(chat.sent[0].includes(JSON.stringify(edit.text)));
  assert.ok(chat.sent[0].endsWith('接着讲'));
  chat.state.running = true;
  assert.throws(() => rpc.editReply(chat, { ...edit, originalText: edit.text, text: '禁止修改' }), /生成/);
  assert.equal(chat.state.messages.at(-1).text, edit.text);
  chat.state.running = false;
  assert.throws(() => rpc.editReply(chat, edit), /更新|改变/);
});

test('avatar replacement retains card prompts and rejects invalid images and unknown cards', t => {
  const { store, id } = setup(t);
  const cardFile = path.join(store.cardDir(id), 'card.json');
  const before = fs.readFileSync(cardFile);
  const { pngChunk } = require('../rp/avatar');
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 30, 120, 220, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
  store.setAvatar(id, png);
  assert.deepEqual(store.avatar(id), png);
  assert.deepEqual(fs.readFileSync(cardFile), before);
  assert.equal(store.listCards()[0].hasAvatar, true);
  assert.throws(() => store.setAvatar(id, Buffer.from('<svg/>')), /图片|PNG/);
  assert.throws(() => store.setAvatar('../outside', png), /角色/);
});

test('literal dollar sequences survive corrections and edited greetings survive persona changes', t => {
  const { store, rpc, chat, id } = setup(t);
  const text = "literal $& and $' and $` and $$ stay untouched";
  rpc.editReply(chat, { uuid: 'reply-1', originalText: '原始回复', text });
  rpc.send(chat, '<rp_context>已有上下文</rp_context>\n\n继续');
  assert.ok(chat.sent[0].includes(JSON.stringify(text)), 'replacement syntax must not alter user edits');
  const greeting = chat.state.messages[0];
  rpc.editReply(chat, { greeting: true, originalText: greeting.text, text: '自定义开场白' });
  const card = store.getCard(id); card.first_mes = '你好 {{user}}';
  fs.writeFileSync(path.join(store.cardDir(id), 'card.json'), JSON.stringify(card));
  store.saveSettings({ persona: { name: '新用户', description: '' } });
  const reopened = rpc.fromHistory({ id: chat.state.sessionId, cwd: chat.state.cwd, messages: [] });
  assert.equal(reopened.state.messages[0].text, '自定义开场白');
});

test('failed RP save preserves the previous session file and in-memory reply', t => {
  const { store, rpc, chat } = setup(t);
  rpc._save(chat);
  const file = path.join(store.dir, 'chats', `${chat.state.sessionId}.json`), before = fs.readFileSync(file);
  const originalWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = (target, value, ...args) => {
      if (String(target).startsWith(file)) { originalWrite(target, String(value).slice(0, 12), ...args); throw new Error('simulated disk full'); }
      return originalWrite(target, value, ...args);
    };
    assert.throws(() => rpc.editReply(chat, { uuid: 'reply-1', originalText: '原始回复', text: '修改稿' }), /disk full/);
  } finally { fs.writeFileSync = originalWrite; }
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(chat.state.messages.at(-1).text, '原始回复');
});
