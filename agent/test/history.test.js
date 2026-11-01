'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseTranscript, listConversations, readConversation, readConversationFile, sourceOf } = require('../history');

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function line(o) { return JSON.stringify(o); }

const transcriptA = [
  line({ type: 'queue-operation', operation: 'enqueue' }),
  line({ type: 'user', isSidechain: false, entrypoint: 'claude-desktop', cwd: 'D:\\proj', sessionId: ID_A,
    timestamp: '2026-10-30T10:00:00.000Z',
    message: { role: 'user', content: [
      { type: 'text', text: '<system-reminder>injected context</system-reminder>' },
      { type: 'text', text: '帮我写个网页' },
    ] } }),
  line({ type: 'assistant', timestamp: '2026-10-30T10:00:05.000Z',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret thoughts' }] } }),
  line({ type: 'assistant', timestamp: '2026-10-30T10:00:06.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: '好的，我来写。' }] } }),
  line({ type: 'assistant', timestamp: '2026-10-30T10:00:07.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm install', description: 'Install deps' } }] } }),
  line({ type: 'user', timestamp: '2026-10-30T10:00:09.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(5000) }] } }),
  line({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>meta</local-command-caveat>' } }),
  line({ type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent prompt' } }),
  '{not valid json',
  line({ type: 'ai-title', aiTitle: 'AI 起的标题', sessionId: ID_A }),
  line({ type: 'custom-title', customTitle: '网页项目', sessionId: ID_A }),
].join('\n') + '\n';

const transcriptB = [
  line({ type: 'user', entrypoint: 'cli', cwd: 'C:\\Users\\me', sessionId: ID_B, timestamp: '2026-10-29T08:00:00.000Z',
    message: { role: 'user', content: '你好' } }),
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '你好！' }] } }),
].join('\n') + '\n';

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  fs.mkdirSync(path.join(dir, 'D--proj'));
  fs.mkdirSync(path.join(dir, 'C--Users-me'));
  const a = path.join(dir, 'D--proj', `${ID_A}.jsonl`);
  const b = path.join(dir, 'C--Users-me', `${ID_B}.jsonl`);
  fs.writeFileSync(a, transcriptA);
  fs.writeFileSync(b, transcriptB);
  fs.writeFileSync(path.join(dir, 'D--proj', 'notes.txt'), 'ignore me');
  // a newer mtime for A so it sorts first
  fs.utimesSync(b, new Date('2026-10-29T08:00:00Z'), new Date('2026-10-29T08:00:00Z'));
  fs.utimesSync(a, new Date('2026-10-30T10:00:00Z'), new Date('2026-10-30T10:00:00Z'));
  return dir;
}

test('sourceOf maps entrypoints', () => {
  assert.strictEqual(sourceOf('claude-desktop'), 'desktop');
  assert.strictEqual(sourceOf('claude-desktop-3p'), 'desktop');
  assert.strictEqual(sourceOf('cli'), 'cli');
  assert.strictEqual(sourceOf('sdk-cli'), 'other');
  assert.strictEqual(sourceOf(undefined), 'other');
});

test('parseTranscript extracts readable messages and metadata', () => {
  const r = parseTranscript(transcriptA);
  assert.strictEqual(r.cwd, 'D:\\proj');
  assert.strictEqual(r.source, 'desktop');
  assert.strictEqual(r.title, '网页项目'); // custom title beats ai title
  const roles = r.messages.map((m) => m.role);
  assert.deepStrictEqual(roles, ['user', 'assistant', 'tool', 'tool_result']);
  assert.strictEqual(r.messages[0].text, '帮我写个网页'); // system reminder stripped
  assert.strictEqual(r.messages[2].text, 'Bash: npm install');
  assert.ok(r.messages[3].text.length <= 600, 'tool result truncated');
  assert.ok(!JSON.stringify(r).includes('secret thoughts'), 'thinking skipped');
  assert.ok(!JSON.stringify(r).includes('subagent prompt'), 'sidechain skipped');
  assert.ok(!JSON.stringify(r).includes('local-command-caveat'), 'meta skipped');
});

test('slash commands, their output and compact summaries are shown cleanly', () => {
  const t = [
    line({ type: 'user', entrypoint: 'cli', cwd: 'C:\\x', message: { role: 'user', content: '你好' } }),
    line({ type: 'user', message: { role: 'user', content: '/compact' } }),
    line({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true,
      message: { role: 'user', content: 'This session is being continued from a previous conversation...' } }),
    line({ type: 'user', message: { role: 'user', content:
      '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>' } }),
    line({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' } }),
    line({ type: 'user', message: { role: 'user', content:
      '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>' } }),
    line({ type: 'user', message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } }),
  ].join('\n');
  const r = parseTranscript(t);
  assert.deepStrictEqual(r.messages.map((m) => `${m.role}:${m.text}`), [
    'user:你好',
    'user:/compact',
    'system:（上下文已压缩，之前的内容被总结）',
    'system:Compacted (ctrl+o to see full summary)',
    'user:/effort high',
  ]);
  assert.strictEqual(r.title, '你好');
});

test('sent files, edits and wrap-up recaps become structured cards', () => {
  const t = [
    line({ type: 'user', entrypoint: 'claude-desktop', cwd: 'D:\\proj', message: { role: 'user', content: '写设定' } }),
    line({ type: 'assistant', cwd: 'D:\\proj', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Write', input: { file_path: 'D:\\proj\\a.md', content: '# hi' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'D:\\proj\\a.md', old_string: 'x', new_string: 'y' } },
      { type: 'tool_use', name: 'SendUserFile', input: { files: ['notes/b.md', 'D:\\other\\c.png'], caption: '看这个', status: 'normal' } },
      { type: 'tool_use', name: 'mcp__ccd_turn__wrap_up', input: { recap: '设定写好了。', ask: '继续吗？' } },
    ] } }),
  ].join('\n');
  const r = parseTranscript(t);
  const cards = r.messages.slice(1);
  assert.deepStrictEqual(cards[0], { role: 'file', action: 'write', files: ['D:\\proj\\a.md'], text: '新建 a.md', ts: null });
  assert.deepStrictEqual(cards[1], { role: 'file', action: 'edit', files: ['D:\\proj\\a.md'], text: '修改 a.md', ts: null });
  assert.deepStrictEqual(cards[2], { role: 'file', action: 'send', files: ['D:\\proj\\notes\\b.md', 'D:\\other\\c.png'], text: '看这个', ts: null });
  assert.deepStrictEqual(cards[3], { role: 'recap', text: '设定写好了。\n\n❓ 继续吗？', ts: null });
  assert.deepStrictEqual(r.files.sort(), ['D:\\other\\c.png', 'D:\\proj\\a.md', 'D:\\proj\\notes\\b.md']);
});

test('readConversationFile only serves files referenced by that conversation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'histf-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'work-'));
  const md = path.join(work, 'doc.md');
  const png = path.join(work, 'pic.png');
  const secret = path.join(work, 'secret.txt');
  fs.writeFileSync(md, '# 标题\n正文');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(secret, 'nope');
  fs.mkdirSync(path.join(dir, 'p'));
  fs.writeFileSync(path.join(dir, 'p', `${ID_A}.jsonl`), [
    line({ type: 'user', cwd: work, message: { role: 'user', content: 'hi' } }),
    line({ type: 'assistant', cwd: work, message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'SendUserFile', input: { files: ['doc.md', png] } },
    ] } }),
  ].join('\n'));

  const f = await readConversationFile(dir, ID_A, md);
  assert.strictEqual(f.kind, 'text');
  assert.strictEqual(f.content, '# 标题\n正文');
  assert.strictEqual(f.ext, 'md');

  const img = await readConversationFile(dir, ID_A, png);
  assert.strictEqual(img.kind, 'image');
  assert.strictEqual(img.mime, 'image/png');
  assert.strictEqual(img.content, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));

  const denied = await readConversationFile(dir, ID_A, secret);
  assert.strictEqual(denied.error, 'not_referenced');
  const gone = await readConversationFile(dir, ID_A, path.join(work, 'missing.md'));
  assert.strictEqual(gone.error, 'not_referenced');
  fs.unlinkSync(md);
  const deleted = await readConversationFile(dir, ID_A, md);
  assert.strictEqual(deleted.error, 'missing');
});

test('explicit assistant file paths inside the project can be downloaded without a Write event', { skip: process.platform !== 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-file-test-'));
  t.after(() => { if (path.dirname(root) === os.tmpdir()) fs.rmSync(root, { recursive: true, force: true }); });
  const projects = path.join(root, 'projects'), cwd = path.join(root, 'workspace');
  fs.mkdirSync(path.join(projects, 'p'), { recursive: true }); fs.mkdirSync(cwd);
  const jsonFile = path.join(cwd, '角色 卡.json'), zipFile = path.join(cwd, '卡片.zip'), outside = path.join(root, 'private.txt');
  fs.writeFileSync(jsonFile, '{"保持原文":"你好"}');
  const zip = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 12]); fs.writeFileSync(zipFile, zip);
  fs.writeFileSync(outside, 'not in this project');
  const text = '文件在这里：`' + jsonFile + '`，压缩包：`' + zipFile + '`，越界路径：`' + outside + '`';
  fs.writeFileSync(path.join(projects, 'p', `${ID_A}.jsonl`), line({ type: 'assistant', cwd, message: { role: 'assistant', content: text } }));
  const result = await readConversationFile(projects, ID_A, jsonFile);
  assert.equal(result.kind, 'text'); assert.equal(result.content, '{"保持原文":"你好"}');
  const binary = await readConversationFile(projects, ID_A, zipFile);
  assert.equal(binary.kind, 'binary'); assert.deepEqual(Buffer.from(binary.content, 'base64'), zip);
  assert.equal((await readConversationFile(projects, ID_A, outside)).error, 'not_referenced');
});

test('wrap-up recap files are downloadable within the project and reject escaped paths', { skip: process.platform !== 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-file-test-'));
  t.after(() => { if (path.dirname(root) === os.tmpdir()) fs.rmSync(root, { recursive: true, force: true }); });
  const projects = path.join(root, 'projects'), cwd = path.join(root, 'workspace'), outsideDir = path.join(root, 'private');
  fs.mkdirSync(path.join(projects, 'p'), { recursive: true }); fs.mkdirSync(cwd); fs.mkdirSync(outsideDir);
  const file = path.join(cwd, '总结 文件.json'), outside = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(file, '{"总结":"可下载"}'); fs.writeFileSync(outside, 'private data');
  const junction = path.join(cwd, 'linked');
  fs.symlinkSync(outsideDir, junction, 'junction');
  const escaped = path.join(junction, 'secret.txt');
  const traversal = cwd + '\\..\\private\\secret.txt';
  const recap = '下载：`' + file + '`，项目外：`' + outside + '`，穿越：`' + traversal + '`，链接：`' + escaped + '`';
  fs.writeFileSync(path.join(projects, 'p', `${ID_A}.jsonl`), [
    line({ type: 'user', cwd, message: { role: 'user', content: '把文件发给我' } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'mcp__ccd_turn__wrap_up', input: { recap } },
    ] } }),
  ].join('\n'));
  const result = await readConversationFile(projects, ID_A, file);
  assert.equal(result.kind, 'text'); assert.equal(result.content, '{"总结":"可下载"}');
  for (const denied of [outside, traversal, escaped]) {
    assert.equal((await readConversationFile(projects, ID_A, denied)).error, 'not_referenced', denied);
  }
});

test('RP turn context is hidden from the shown user message', () => {
  const t = line({ type: 'user', message: { role: 'user', content: '<rp_context>\n[世界设定]\n秘密\n</rp_context>\n\n你好呀' } });
  assert.deepStrictEqual(parseTranscript(t).messages.map((m) => m.text), ['你好呀']);
});

test('interrupt markers read as a stop', () => {
  const t = [
    line({ type: 'user', message: { role: 'user', content: '你好' } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
  ].join('\n');
  assert.deepStrictEqual(parseTranscript(t).messages.map((m) => `${m.role}:${m.text}`), ['user:你好', 'system:已停止', 'system:已停止']);
});

test('title falls back to ai title then first prompt', () => {
  const noCustom = transcriptA.split('\n').filter((l) => !l.includes('custom-title')).join('\n');
  assert.strictEqual(parseTranscript(noCustom).title, 'AI 起的标题');
  assert.strictEqual(parseTranscript(transcriptB).title, '你好');
});

test('listConversations returns newest first with metadata', async () => {
  const dir = makeFixture();
  const list = await listConversations(dir, { limit: 10 });
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].id, ID_A);
  assert.strictEqual(list[0].title, '网页项目');
  assert.strictEqual(list[0].source, 'desktop');
  assert.strictEqual(list[0].cwd, 'D:\\proj');
  assert.strictEqual(list[1].id, ID_B);
  assert.strictEqual(list[1].source, 'cli');
  assert.ok(list[0].updatedAt > list[1].updatedAt);
  const one = await listConversations(dir, { limit: 1 });
  assert.strictEqual(one.length, 1);
});

test('readConversation finds by id and rejects bad ids', async () => {
  const dir = makeFixture();
  const c = await readConversation(dir, ID_B);
  assert.strictEqual(c.id, ID_B);
  assert.strictEqual(c.messages.length, 2);
  assert.strictEqual(await readConversation(dir, '../../etc/passwd'), null);
  assert.strictEqual(await readConversation(dir, '33333333-3333-4333-8333-333333333333'), null);
});

test('readConversation keeps only the latest messages when long', async () => {
  const dir = makeFixture();
  const c = await readConversation(dir, ID_A, { maxMessages: 2 });
  assert.strictEqual(c.messages.length, 2);
  assert.strictEqual(c.truncated, true);
  assert.strictEqual(c.messages[1].role, 'tool_result');
});

test('context usage takes the latest valid main-session assistant input total without double counting', () => {
  const record = (usage, extra = {}) => line({ type: 'assistant', message: { content: [], usage }, ...extra });
  const latest = { input_tokens: 2, cache_creation_input_tokens: 39673, cache_read_input_tokens: 16321, output_tokens: 1969 };
  const text = [
    record({ input_tokens: 90000 }),
    record(latest), record(latest),
    record({ input_tokens: 999999 }, { isSidechain: true }),
    record({ input_tokens: 888888 }, { parent_tool_use_id: 'tool-subagent' }),
    record({ input_tokens: 777777 }, { isMeta: true }),
    record({ input_tokens: -1, cache_read_input_tokens: 100 }),
    record({ input_tokens: '60000' }),
    record({ output_tokens: 200000 }),
  ].join('\n');
  assert.strictEqual(parseTranscript(text).contextUsed, 55996);
});

test('context usage accepts cache-only and zero values while missing or invalid usage stays unknown', () => {
  const from = usage => parseTranscript(line({ type: 'assistant', message: { content: [], usage } })).contextUsed;
  assert.strictEqual(from({ cache_read_input_tokens: 18000, cache_creation_input_tokens: 7000 }), 25000);
  assert.strictEqual(from({ input_tokens: 0 }), 0);
  for (const usage of [undefined, null, {}, { output_tokens: 0 }, { input_tokens: null },
    { cache_read_input_tokens: -1 }, { input_tokens: NaN }, { cache_creation_input_tokens: Infinity },
    { input_tokens: Number.MAX_VALUE, cache_read_input_tokens: Number.MAX_VALUE }]) {
    assert.strictEqual(from(usage), null);
  }
  assert.strictEqual(parseTranscript('').contextUsed, null);
});

test('readConversation exposes recovered context usage independently of message truncation', async (t) => {
  const dir = makeFixture();
  t.after(() => { if (path.dirname(dir) === os.tmpdir()) fs.rmSync(dir, { recursive: true, force: true }); });
  fs.appendFileSync(path.join(dir, 'D--proj', `${ID_A}.jsonl`), line({ type: 'assistant', message: {
    content: [], usage: { cache_creation_input_tokens: 19509, cache_read_input_tokens: 16321, input_tokens: 2 },
  } }) + '\n');
  const conversation = await readConversation(dir, ID_A, { maxMessages: 1 });
  assert.strictEqual(conversation.contextUsed, 35832);
  assert.strictEqual(conversation.messages.length, 1);
  assert.strictEqual((await readConversation(dir, ID_B)).contextUsed, null);
});
