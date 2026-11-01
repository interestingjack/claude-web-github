'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { install } = require('../live-extensions');

test('live commands preserve transport listeners and reject edits during generation', () => {
  class Socket extends EventEmitter { constructor() { super(); this.url = 'wss://relay/ws/agent'; } }
  const socket = new Socket(), replies = [], passthrough = [];
  socket.on('message', raw => passthrough.push(String(raw)));
  const chat = { rp: {}, state: { running: true } };
  let syncs = 0;
  const options = { WebSocket: Socket, cfg: { relayUrl: socket.url }, chats: new Map([['chat', chat]]), store: {},
    rpc: { editReply(value) { if (value.state.running) throw new Error('回复正在生成'); } },
    sendTo: (cid, message) => replies.push({ cid, ...message }), resync() { syncs++; } };
  install(options); install(options);
  socket.emit('message', Buffer.from('{"from":3,"msg":{"type":"list"}}'));
  assert.equal(passthrough.length, 1);
  socket.emit('message', Buffer.from('{"from":3,"msg":{"type":"rp_edit_reply","chatId":"chat","requestId":"edit-1"}}'));
  assert.equal(replies[0].ok, false); assert.match(replies[0].message, /生成/); assert.equal(syncs, 0);
  chat.state.running = false;
  socket.emit('message', Buffer.from('{"from":3,"msg":{"type":"rp_edit_reply","chatId":"chat","requestId":"edit-2"}}'));
  assert.equal(replies[1].ok, true); assert.equal(syncs, 1); assert.equal(socket.listenerCount('message'), 1);
});

test('attachment commands acknowledge uploads, reject busy chats and deduplicate successful sends', () => {
  class Socket extends EventEmitter { constructor() { super(); this.url = 'wss://relay/ws/agent'; } }
  const socket = new Socket(), replies = [], calls = [];
  const chat = new EventEmitter();
  Object.assign(chat, { id: 'chat', state: { running: false, sessionId: null }, send(text, options) { calls.push({ route: 'chat', text, options }); this.state.running = true; } });
  const attachment = { id: '11111111-1111-4111-8111-111111111111', kind: 'image' }, blocks = [{ type: 'image', source: { data: 'test-image' } }];
  let uploads = 0, bindings = 0;
  const attachmentStore = { upload(value, message) { assert.equal(value, chat); uploads++; return attachment; },
    prepare(value, ids) { assert.equal(value, chat); assert.deepEqual(ids, [attachment.id]); return { attachments: [attachment], blocks }; },
    bindSession(value) { assert.equal(value, chat); bindings++; } };
  const rpc = { send(value, text, options) { calls.push({ route: 'rp', text, options }); value.state.running = true; } };
  const options = { WebSocket: Socket, cfg: { relayUrl: socket.url }, chats: new Map([['chat', chat]]), store: {}, rpc, attachmentStore,
    sendTo: (cid, message) => replies.push({ cid, ...message }) };
  install(options); install(options);
  const send = msg => socket.emit('message', Buffer.from(JSON.stringify({ from: 3, msg: { chatId: chat.id, ...msg } })));
  send({ type: 'attachment_upload', requestId: 'upload-1', name: '照片.png', mime: 'image/png', data: 'dGVzdA==' });
  assert.equal(uploads, 1); assert.equal(replies.at(-1).type, 'attachment_result'); assert.equal(replies.at(-1).attachment, attachment);
  const request = { type: 'send_attachments', requestId: 'send-1', text: '看图', attachmentIds: [attachment.id] };
  send(request);
  assert.equal(calls.length, 1); assert.equal(calls[0].route, 'chat'); assert.deepEqual(calls[0].options, { attachments: [attachment], blocks });
  assert.equal(replies.at(-1).ok, true);
  install(options);
  send(request);
  assert.equal(calls.length, 1, 'retrying an acknowledged send must not send twice, even after reinstall');
  assert.equal(replies.at(-1).ok, true);
  send({ ...request, text: '冲突内容' });
  assert.equal(replies.at(-1).ok, false); assert.match(replies.at(-1).message, /重复|冲突|不同/);
  send({ ...request, requestId: 'send-busy' });
  assert.equal(replies.at(-1).ok, false); assert.match(replies.at(-1).message, /正在/);
  send({ type: 'attachment_upload', requestId: 'upload-busy' });
  assert.equal(replies.at(-1).ok, false); assert.equal(uploads, 1);
  chat.state.sessionId = 'session-1'; chat.emit('event', { kind: 'meta' });
  assert.equal(bindings, 1);
  chat.state.running = false; chat.rp = {};
  send({ type: 'send_attachments', requestId: 'rp-1', text: '', attachmentIds: [attachment.id] });
  assert.equal(calls.at(-1).route, 'rp'); assert.equal(replies.at(-1).ok, true);
  chat.state.running = false;
  send({ type: 'send_attachments', requestId: 'slash-1', text: '/context', attachmentIds: [] });
  assert.equal(calls.at(-1).route, 'chat'); assert.equal(calls.at(-1).text, '/context');
  assert.equal(chat.listenerCount('event'), 1, 'binding listeners must not stack during hot reload');
});

test('install upgrades a legacy dispatch closure without stacking transport listeners', () => {
  class Socket extends EventEmitter { constructor() { super(); this.url = 'wss://relay/ws/agent'; } }
  const key = Symbol.for('claude-web.rp-live-extensions'), original = Socket.prototype.emit;
  let legacyCalls = 0, passthrough = 0;
  Socket.prototype[key] = { emit: original, options: {} };
  Socket.prototype.emit = function(...args) { legacyCalls++; return original.apply(this, args); };
  const socket = new Socket(), replies = [], chat = new EventEmitter();
  Object.assign(chat, { id: 'chat', state: { running: false }, send() { this.state.running = true; } });
  socket.on('message', () => passthrough++);
  const options = { WebSocket: Socket, cfg: { relayUrl: socket.url }, chats: new Map([['chat', chat]]), store: {}, rpc: {}, sendTo: (cid, reply) => replies.push(reply) };
  install(options); install(options);
  socket.emit('message', Buffer.from('{"from":3,"msg":{"type":"send_attachments","chatId":"chat","requestId":"new-command","text":"hi","attachmentIds":[]}}'));
  assert.equal(replies.at(-1)?.ok, true);
  socket.emit('message', Buffer.from('{"from":3,"msg":{"type":"list"}}'));
  assert.equal(passthrough, 1); assert.equal(legacyCalls, 0); assert.equal(socket.listenerCount('message'), 1);
  assert.equal(Socket.prototype[key].emit, original);
});

test('failed sends can retry their request id and invalid payloads never reach the chat', () => {
  class Socket extends EventEmitter { constructor() { super(); this.url = 'wss://relay/ws/agent'; } }
  const socket = new Socket(), replies = [];
  let attempts = 0;
  const chat = { id: 'chat', state: { running: false }, send() { if (++attempts === 1) throw new Error('暂时无法发送'); this.state.running = true; } };
  install({ WebSocket: Socket, cfg: { relayUrl: socket.url }, chats: new Map([['chat', chat]]), store: {}, rpc: {}, sendTo: (cid, reply) => replies.push(reply) });
  const send = message => socket.emit('message', Buffer.from(JSON.stringify({ from: 3, msg: { type: 'send_attachments', chatId: 'chat', requestId: 'retry', text: 'hi', attachmentIds: [], ...message } })));
  send({}); assert.equal(replies.at(-1).ok, false);
  send({}); assert.equal(replies.at(-1).ok, true); assert.equal(attempts, 2);
  for (const message of [{ requestId: '' }, { requestId: 'empty', text: '' }, { requestId: 'bad-text', text: {} }, { requestId: 'many', attachmentIds: ['1', '2', '3', '4', '5', '6'] }]) {
    send(message); assert.equal(replies.at(-1).ok, false);
  }
  assert.equal(attempts, 2);
});

test('hot reload updates the captured ChatSession class and live methods without replacing the process', () => {
  const CapturedChat = require('../chat').ChatSession;
  const writes = [], live = new CapturedChat({ cwd: 'D:\\proj', command: 'not-started' });
  const processHandle = { stdin: { write(data) { writes.push(JSON.parse(data)); } } };
  live.proc = processHandle;
  CapturedChat.prototype.send = function() { throw new Error('old send'); };
  delete require.cache[require.resolve('../chat')];
  require('../chat'); // A cached replacement alone does not update the class captured by agent.js.
  class Socket extends EventEmitter {}
  install({ WebSocket: Socket, ChatSession: CapturedChat, cfg: { relayUrl: 'wss://relay/ws/agent' },
    chats: new Map([[live.id, live]]), rpc: {}, store: {}, hotReload: true });
  live.send('继续使用原进程');
  assert.equal(live.proc, processHandle);
  assert.equal(writes[0].message.content[0].text, '继续使用原进程');
  const future = new CapturedChat({ cwd: 'D:\\proj', command: 'not-started' });
  future.proc = processHandle;
  future.send('旧构造器创建的新会话');
  assert.equal(writes[1].message.content[0].text, '旧构造器创建的新会话');
});
