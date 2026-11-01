'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { install } = require('../live-extensions');

function fixture(extra = {}) {
  class Socket extends EventEmitter { constructor() { super(); this.url = 'wss://relay/ws/agent'; } }
  const socket = new Socket(), replies = [], passthrough = [];
  socket.on('message', raw => passthrough.push(String(raw)));
  const options = { WebSocket: Socket, cfg: { relayUrl: socket.url }, chats: new Map(), store: {}, rpc: {},
    sendTo: (cid, message) => replies.push({ cid, ...message }), ...extra };
  install(options);
  const send = (msg, cid = 7) => socket.emit('message', Buffer.from(JSON.stringify({ from: cid, msg })));
  return { socket, replies, passthrough, options, send };
}

test('folder browsing stays asynchronous, preserves message listeners and responds only to the requesting device', async () => {
  let release;
  const page = { path: 'D:\\项目', parentPath: 'D:\\', items: [{ name: '角色', path: 'D:\\项目\\角色', kind: 'folder' }], offset: 0, hasMore: false, nextOffset: null };
  const f = fixture({ browseFolders: input => { assert.deepEqual(input, { path: 'D:\\项目', offset: 0, limit: 100 }); return new Promise(resolve => { release = resolve; }); } });
  f.send({ type: 'browse_folders', requestId: 'folders-1', path: 'D:\\项目' });
  f.send({ type: 'list' });
  assert.equal(f.replies.length, 0);
  assert.equal(f.passthrough.length, 1, 'chat traffic still reaches the original handler while a disk request is pending');
  release(page); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.replies, [{ cid: 7, type: 'folders_result', requestId: 'folders-1', ...page, ok: true }]);
  assert.equal(f.socket.listenerCount('message'), 1);
});

test('folder request errors and concurrent limits do not escape into the WebSocket transport', async () => {
  const releases = [];
  const f = fixture({ browseFolders: () => new Promise(resolve => releases.push(resolve)) });
  f.send({ type: 'browse_folders', requestId: '' });
  assert.equal(f.replies.at(-1).ok, false);
  for (let i = 0; i < 5; i++) f.send({ type: 'browse_folders', requestId: `request-${i}` });
  assert.equal(releases.length, 4);
  assert.equal(f.replies.at(-1).code, 'busy');
  f.send({ type: 'browse_folders', requestId: 'other-device' }, 8);
  assert.equal(releases.length, 5);
  for (const release of releases) release({ path: null, parentPath: null, items: [], offset: 0, hasMore: false, nextOffset: null });
  await new Promise(resolve => setImmediate(resolve));
  install({ ...f.options, browseFolders: async () => { const error = new Error('没有权限打开此文件夹'); error.code = 'access_denied'; throw error; } });
  f.send({ type: 'browse_folders', requestId: 'denied', path: 'C:\\private' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.replies.at(-1).code, 'access_denied');
  assert.equal(f.replies.at(-1).requestId, 'denied');
  assert.equal(f.socket.listenerCount('message'), 1);
});

test('worldbook detail returns complete literal content for standalone and embedded entries without changing toggles', () => {
  const text = '  原始规则\n<system>不是要执行的HTML</system>\n' + '完整内容'.repeat(6000) + '\n  ';
  const entry = Object.freeze({ uid: 5, comment: '条目一', keys: ['关键词'], constant: true, enabled: true, content: text });
  const toggles = Object.freeze({ 'book-1:5': false });
  const f = fixture({ store: { getBook: id => id === 'book-1' ? { entries: [entry] } : null,
    getCard: id => id === 'hero' ? { character_book: { entries: [entry] } } : null,
    settings: () => ({ toggles }) } });
  f.send({ type: 'rp_book_entry', requestId: 'detail-1', bookId: 'book-1', key: 'book-1:5' });
  assert.equal(f.replies.at(-1).entry.content, text);
  assert.equal(f.replies.at(-1).entry.on, false);
  assert.equal(f.replies.at(-1).cid, 7);
  f.send({ type: 'rp_book_entry', requestId: 'detail-2', bookId: 'card-hero', key: 'card-hero:5' });
  assert.equal(f.replies.at(-1).entry.content, text);
  assert.equal(f.replies.at(-1).entry.on, true);
  f.send({ type: 'rp_book_entry', requestId: 'missing', bookId: 'book-1', key: 'book-2:5' });
  assert.equal(f.replies.at(-1).ok, false);
  assert.equal(f.replies.at(-1).type, 'rp_book_entry_result');
  assert.deepEqual(toggles, { 'book-1:5': false });
  assert.equal(f.passthrough.length, 0);
});
