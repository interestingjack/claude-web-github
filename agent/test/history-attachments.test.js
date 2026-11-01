'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { normalizeAttachmentMessage, parseTranscript, readConversationFile } = require('../history');

const metadata = (overrides = {}) => ({ id: crypto.randomUUID(), name: '说明 文件.txt', path: 'D:\\attachments\\说明 文件.txt',
  size: 12, kind: 'file', mime: 'text/plain', ...overrides });
const marker = files => `<claude_web_attachments>${JSON.stringify({ files, instruction: '用户上传的文件' })}</claude_web_attachments>`;

test('attachment marker becomes a user card without changing the user text or exposing hidden fields', () => {
  const file = metadata({ secret: 'not-for-ui' });
  const body = '  请读这个文件\n保留末尾空格  \n';
  const item = { role: 'user', text: `${marker([file])}\n\n${body}`, uuid: 'turn' };
  assert.equal(normalizeAttachmentMessage(item), item);
  assert.equal(item.text, body);
  assert.equal(item.attachments[0].name, file.name);
  assert.equal(item.attachments[0].secret, undefined);
  const assistant = { role: 'assistant', text: marker([file]) };
  normalizeAttachmentMessage(assistant);
  assert.equal(assistant.attachments, undefined);
  const malformed = { role: 'user', text: marker([metadata({ size: -1 })]) };
  normalizeAttachmentMessage(malformed);
  assert.equal(malformed.attachments, undefined);
});

test('history preserves attachment-only and long user turns while excluding native image bytes', () => {
  const file = metadata({ kind: 'image', mime: 'image/png' });
  const record = text => JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { content: [
    { type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'hidden-image-bytes' } },
  ] } });
  const only = parseTranscript(record(marker([file])));
  assert.equal(only.messages.length, 1);
  assert.equal(only.messages[0].text, '');
  assert.equal(only.messages[0].attachments[0].id, file.id);
  const long = parseTranscript(record(`<rp_context>unchanged role context</rp_context>\n\n${marker([file])}\n\n${'正文'.repeat(6000)}`));
  assert.equal(long.messages[0].attachments[0].id, file.id);
  assert.ok(long.messages[0].text.startsWith('正文'));
  assert.equal(JSON.stringify(long.messages).includes('hidden-image-bytes'), false);
  assert.equal(JSON.stringify(long.messages).includes('unchanged role context'), false);
});

test('different attachment-only turns survive history deduplication even around a status message', () => {
  const first = metadata(), second = metadata();
  const record = file => JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { content: marker([file]) } });
  const between = JSON.stringify({ type: 'user', message: { content: '[Request interrupted by user]' } });
  for (const middle of ['', between]) {
    const users = parseTranscript([record(first), middle, record(second)].join('\n')).messages.filter(item => item.role === 'user');
    assert.equal(users.length, 2);
    assert.deepEqual(users.map(item => item.attachments[0].id), [first.id, second.id]);
  }
});

test('uploaded files need a matching server-owned session record, not a path typed in the transcript', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-attachment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'projects', 'test');
  fs.mkdirSync(project, { recursive: true });
  const sid = crypto.randomUUID(), source = path.join(root, 'private attachment.bin');
  const bytes = Buffer.from([0, 255, 128, 17, 0, 99]);
  fs.writeFileSync(source, bytes);
  const file = metadata({ path: source, size: bytes.length });
  const transcript = path.join(project, `${sid}.jsonl`);
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', cwd: project, message: { content: marker([file]) } }));
  const calls = [];
  const attachmentStore = { metadataForSession(session, id) { calls.push([session, id]); return session === sid && id === file.id ? file : null; } };
  const result = await readConversationFile(path.join(root, 'projects'), sid, source, { attachmentStore });
  assert.equal(result.kind, 'binary');
  assert.deepEqual(Buffer.from(result.content, 'base64'), bytes);
  assert.deepEqual(calls, [[sid, file.id]]);
  const denied = { metadataForSession() { return null; } };
  assert.equal((await readConversationFile(path.join(root, 'projects'), sid, source, { attachmentStore: denied })).error, 'not_referenced');
  const mismatch = { metadataForSession() { return metadata({ path: path.join(root, 'other.txt') }); } };
  assert.equal((await readConversationFile(path.join(root, 'projects'), sid, source, { attachmentStore: mismatch })).error, 'not_referenced');
});

test('a real upload binds its first session and remains viewable after reopening, including images with an unusual filename', async t => {
  const { AttachmentStore } = require('../attachments');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-upload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'projects', 'test');
  fs.mkdirSync(project, { recursive: true });
  const repository = new AttachmentStore({ dir: path.join(root, 'uploads') });
  const chat = { id: 'first-chat', state: { sessionId: null } };
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ9sAAAAASUVORK5CYII=', 'base64');
  const file = repository.upload(chat, { requestId: 'history-integration', name: '图片.data', data: image.toString('base64') });
  const sid = crypto.randomUUID();
  assert.equal(repository.metadataForSession(sid, file.id), null);
  chat.state.sessionId = sid;
  repository.bindSession(chat);
  fs.writeFileSync(path.join(project, `${sid}.jsonl`), JSON.stringify({ type: 'user', cwd: project, message: { content: marker([file]) } }));
  const reopened = new AttachmentStore({ dir: path.join(root, 'uploads') });
  const result = await readConversationFile(path.join(root, 'projects'), sid, file.path, { attachmentStore: reopened });
  assert.equal(result.kind, 'image');
  assert.equal(result.mime, 'image/png');
  assert.deepEqual(Buffer.from(result.content, 'base64'), image);
});
