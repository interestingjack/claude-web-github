'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AttachmentStore, LIMITS } = require('../attachments');

const chat = { id: 'chat-a', state: { sessionId: 'session-a' } };
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-test-'));
  t.after(() => { if (path.dirname(root) === os.tmpdir()) fs.rmSync(root, { recursive: true, force: true }); });
  const dir = path.join(root, 'attachments');
  return { root, dir, store: new AttachmentStore({ dir }) };
}
const upload = (store, owner, requestId, buffer, name = '文件.json', mime = 'text/plain') => store.upload(owner, { requestId, name, mime, data: buffer.toString('base64') });
const hasCode = code => error => error.code === code;

test('attachments preserve original bytes, ignore supplied mime and isolate hostile filenames', t => {
  const { store, dir } = setup(t), bytes = Buffer.from([0, 255, 128, 13, 10, 42]);
  for (const [i, name] of ['../../outside.json', 'C:\\outside.txt', 'CON', 'NUL.txt', 'report.txt:secret', '名字\u0000\n卡片.json'].entries()) {
    const item = upload(store, chat, 'file-' + i, bytes, name, 'image/png');
    assert.equal(item.kind, 'file'); assert.equal(item.mime, 'application/octet-stream');
    assert.equal(path.dirname(path.dirname(item.path)), dir);
    assert.match(path.basename(item.path), /^attachment(?:\.[a-z0-9]+)?$/);
    assert.doesNotMatch(item.name, /[\x00-\x1f]/);
    assert.deepEqual(fs.readFileSync(item.path), bytes);
    assert.deepEqual(store.prepare(chat, [item.id]), { attachments: [item], blocks: [] });
  }
});

test('image signatures produce native image blocks without trusting filename or mime', t => {
  const { store } = setup(t);
  const images = [
    [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]), 'image/png'],
    [Buffer.from([255, 216, 255, 224, 1]), 'image/jpeg'],
    [Buffer.from('RIFF0000WEBPmore'), 'image/webp'],
    [Buffer.from('GIF89amore'), 'image/gif'],
  ];
  for (const [i, [bytes, mime]] of images.entries()) {
    const item = upload(store, chat, 'image-' + i, bytes, '伪装.txt', 'application/octet-stream');
    assert.equal(item.kind, 'image'); assert.equal(item.mime, mime);
    const prepared = store.prepare(chat, [item.id]);
    assert.deepEqual(prepared.blocks, [{ type: 'image', source: { type: 'base64', media_type: mime, data: bytes.toString('base64') } }]);
  }
});

test('upload retries survive store replacement and reject conflicts and cross-chat references', t => {
  const { store, dir } = setup(t), bytes = Buffer.from('内容');
  const item = upload(store, chat, 'stable-request', bytes);
  const restored = new AttachmentStore({ dir });
  assert.deepEqual(upload(restored, chat, 'stable-request', bytes), item);
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.throws(() => upload(restored, chat, 'stable-request', Buffer.from('变了')), hasCode('REQUEST_CONFLICT'));
  assert.throws(() => upload(restored, chat, 'stable-request', bytes, '改名.json'), hasCode('REQUEST_CONFLICT'));
  const other = { id: 'chat-b', state: { sessionId: 'session-b' } };
  assert.throws(() => restored.prepare(other, [item.id]), hasCode('WRONG_CHAT'));
  assert.throws(() => restored.metadata(other, item.id), hasCode('WRONG_CHAT'));
  assert.deepEqual(restored.prepare({ id: 'reopened', state: { sessionId: 'session-a' } }, [item.id]).attachments, [item]);
});

test('first-turn uploads can bind their later session and be reused after history restoration', t => {
  const { store, dir } = setup(t), fresh = { id: 'fresh', state: { sessionId: null } };
  const item = upload(store, fresh, 'first-turn', Buffer.from('hello'));
  fresh.state.sessionId = 'assigned-session'; store.bindSession(fresh);
  const restored = new AttachmentStore({ dir });
  const reopened = { id: 'new-chat-id', state: { sessionId: 'assigned-session' } };
  assert.deepEqual(restored.prepare(reopened, [item.id]).attachments, [item]);
  assert.deepEqual(restored.prepare(fresh, [item.id]).attachments, [item]);
  reopened.state.sessionId = 'fork-session'; restored.bindSession(reopened, [item.id]);
  for (const sessionId of ['assigned-session', 'fork-session']) assert.deepEqual(restored.metadataForSession(sessionId, item.id), item);
  assert.equal(restored.metadataForSession('unrelated-session', item.id), null);
  assert.equal(restored.metadataForSession('assigned-session', '../outside'), null);
  assert.equal('data' in restored.metadataForSession('assigned-session', item.id), false);
});

test('attachments reject malformed base64 and per-send count or byte overflow while preserving large images as files', t => {
  const { store } = setup(t);
  for (const data of ['@@==', 'a', 'ab==', 'aGV=sbG8', 'aGVsbG8=\n', 'data:text/plain;base64,aA==']) {
    assert.throws(() => store.upload(chat, { requestId: 'bad', data }), hasCode('INVALID_BASE64'));
  }
  assert.throws(() => upload(store, chat, 'too-large', Buffer.alloc(LIMITS.maxFileBytes + 1)), hasCode('FILE_TOO_LARGE'));
  const image = Buffer.alloc(LIMITS.maxImageBytes + 1); image.set([255, 216, 255]);
  const largeImage = upload(store, chat, 'large-image', image);
  assert.equal(largeImage.kind, 'file'); assert.equal(largeImage.mime, 'image/jpeg');
  assert.deepEqual(fs.readFileSync(largeImage.path), image);
  assert.deepEqual(store.prepare(chat, [largeImage.id]).blocks, []);
  const small = Array.from({ length: 6 }, (_, i) => upload(store, chat, 'small-' + i, Buffer.from([i])));
  assert.throws(() => store.prepare(chat, small.map(item => item.id)), hasCode('TOO_MANY_ATTACHMENTS'));
  assert.throws(() => store.prepare(chat, [small[0].id, small[0].id]), hasCode('TOO_MANY_ATTACHMENTS'));
  const a = upload(store, chat, 'large-a', Buffer.alloc(7 * 1024 * 1024));
  const b = upload(store, chat, 'large-b', Buffer.alloc(6 * 1024 * 1024));
  assert.throws(() => store.prepare(chat, [a.id, b.id]), hasCode('TOTAL_TOO_LARGE'));
});

test('attachment reads reject file tampering and directories redirected outside the store', t => {
  const { store, root } = setup(t);
  const item = upload(store, chat, 'tamper', Buffer.from('safe'));
  fs.writeFileSync(item.path, 'evil');
  assert.throws(() => store.prepare(chat, [item.id]), hasCode('INVALID_ATTACHMENT'));
  const linked = upload(store, chat, 'linked', Buffer.from('safe'));
  const directory = path.dirname(linked.path), outside = path.join(root, 'outside');
  fs.renameSync(directory, outside);
  fs.symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.prepare(chat, [linked.id]), hasCode('UNKNOWN_ATTACHMENT'));
  assert.throws(() => store.metadata(chat, '../outside'), hasCode('UNKNOWN_ATTACHMENT'));
});

test('failed uploads remove partial files and can retry the same request', t => {
  const { store, dir } = setup(t), original = fs.writeFileSync;
  const patched = t.mock.method(fs, 'writeFileSync', function(file, ...args) {
    if (path.basename(file) === 'manifest.json') throw new Error('disk full');
    return original.call(this, file, ...args);
  });
  assert.throws(() => upload(store, chat, 'retry-write', Buffer.from('bytes')), /disk full/);
  assert.deepEqual(fs.readdirSync(dir), []);
  patched.mock.restore();
  assert.equal(upload(store, chat, 'retry-write', Buffer.from('bytes')).size, 5);
});
