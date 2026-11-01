'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createState, applyEvent } = require('../chat-events');
const { ChatSession, buildArgs } = require('../chat');

const SID = 'f67f9b43-ea39-4de7-8aaa-2573f5c9c915';
const se = (event, extra) => ({ type: 'stream_event', event, session_id: SID, parent_tool_use_id: null, ...extra });

test('buildArgs: fresh, resumed, rewound and effort sessions', () => {
  const base = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--include-partial-messages', '--verbose', '--replay-user-messages', '--permission-mode', 'auto'];
  assert.deepStrictEqual(buildArgs({}), base);
  assert.deepStrictEqual(buildArgs({ resume: SID }), [...base, '--resume', SID]);
  assert.deepStrictEqual(buildArgs({ resume: SID, resumeAt: 'u-1' }),
    [...base, '--resume', SID, '--resume-session-at', 'u-1', '--fork-session']);
  assert.deepStrictEqual(buildArgs({ effort: 'high' }), [...base, '--effort', 'high']);
  assert.deepStrictEqual(buildArgs({ resumeAt: 'u-1' }), base, 'resumeAt without a session is ignored');
  assert.deepStrictEqual(buildArgs({ resume: SID, extra: ['--append-system-prompt-file', 'x.md'] }),
    [...base, '--resume', SID, '--append-system-prompt-file', 'x.md']);
});

test('init records session id and model', () => {
  const s = createState('D:\\proj');
  const out = applyEvent(s, { type: 'system', subtype: 'init', session_id: SID, model: 'claude-opus-5-5', cwd: 'D:\\proj' });
  assert.strictEqual(s.sessionId, SID);
  assert.deepStrictEqual(out, [{ kind: 'meta', sessionId: SID, model: 'claude-opus-5-5' }]);
});

test('text deltas stream, then the final assistant block replaces them', () => {
  const s = createState('D:\\proj');
  assert.deepStrictEqual(applyEvent(s, se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })),
    [{ kind: 'stream_start' }]);
  assert.deepStrictEqual(applyEvent(s, se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '海' } })),
    [{ kind: 'delta', text: '海' }]);
  applyEvent(s, se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '浪' } }));
  assert.strictEqual(s.streaming, '海浪');
  const out = applyEvent(s, { type: 'assistant', uuid: 'a-1', parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: '海浪' }] } });
  assert.strictEqual(s.streaming, null);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'messages');
  assert.strictEqual(out[0].items[0].role, 'assistant');
  assert.strictEqual(out[0].items[0].text, '海浪');
  assert.strictEqual(out[0].items[0].uuid, 'a-1');
  assert.strictEqual(s.messages.length, 1);
});

test('thinking start is surfaced, empty thinking blocks are not stored', () => {
  const s = createState('D:\\proj');
  assert.deepStrictEqual(applyEvent(s, se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })),
    [{ kind: 'thinking' }]);
  const out = applyEvent(s, { type: 'assistant', uuid: 'a-0', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } });
  assert.deepStrictEqual(out, []);
  assert.strictEqual(s.messages.length, 0);
});

test('tool use, tool result, file cards and replayed user messages are normalised', () => {
  const s = createState('D:\\proj');
  const u = applyEvent(s, { type: 'user', uuid: 'u-1', message: { role: 'user', content: [{ type: 'text', text: '写个文件' }] } });
  assert.deepStrictEqual(u[0].items.map((m) => [m.role, m.text, m.uuid]), [['user', '写个文件', 'u-1']]);
  const w = applyEvent(s, { type: 'assistant', uuid: 'a-2', message: { role: 'assistant', content: [
    { type: 'tool_use', name: 'Write', input: { file_path: 'notes.md', content: 'x' } }] } });
  assert.deepStrictEqual(w[0].items[0].files, ['D:\\proj\\notes.md']);
  const r = applyEvent(s, { type: 'user', uuid: 'u-2', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
  assert.strictEqual(r[0].items[0].role, 'tool_result');
});

test('subagent traffic is ignored', () => {
  const s = createState('D:\\proj');
  assert.deepStrictEqual(applyEvent(s, { type: 'assistant', parent_tool_use_id: 'toolu_1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'inner' }] } }), []);
  assert.deepStrictEqual(applyEvent(s, se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
    { parent_tool_use_id: 'toolu_1' })), []);
});

test('message_start usage and result give context usage and end the turn', () => {
  const s = createState('D:\\proj');
  s.running = true;
  const a = applyEvent(s, se({ type: 'message_start', message: { usage: { input_tokens: 4, cache_read_input_tokens: 30000, cache_creation_input_tokens: 20000 } } }));
  assert.strictEqual(s.contextUsed, 50004);
  assert.strictEqual(a[0].kind, 'status');
  const out = applyEvent(s, { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.27,
    modelUsage: { 'claude-opus-5-5': { contextWindow: 1000000 } } });
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.contextWindow, 1000000);
  assert.deepStrictEqual(out, [{ kind: 'status', running: false, contextUsed: 50004, contextWindow: 1000000, cost: 0.27 }]);
});

test('a user stop shows one "已停止" line instead of an error', () => {
  const s = createState('D:\\proj');
  s.running = true;
  s.interrupted = true;
  const a = applyEvent(s, { type: 'user', uuid: 'u-9', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  assert.deepStrictEqual(a[0].items.map((m) => [m.role, m.text]), [['system', '已停止']]);
  const out = applyEvent(s, { type: 'result', subtype: 'error_during_execution', is_error: true });
  assert.deepStrictEqual(out.map((o) => o.kind), ['status']);
  assert.strictEqual(s.interrupted, false);
});

test('error results become a system message', () => {
  const s = createState('D:\\proj');
  const out = applyEvent(s, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API overloaded' });
  assert.strictEqual(out[0].kind, 'messages');
  assert.deepStrictEqual(out[0].items[0], { role: 'system', text: '出错了：API overloaded', ts: out[0].items[0].ts });
  assert.strictEqual(out[1].kind, 'status');
});

test('sending attachments writes native image blocks and a durable marker before user text', () => {
  const writes = [];
  const chat = new ChatSession({ cwd: 'D:\\proj', command: 'not-started' });
  chat.proc = { stdin: { write(data) { writes.push(JSON.parse(data)); } } };
  const attachment = { id: '11111111-1111-4111-8111-111111111111', name: '照片.png', mime: 'image/png', size: 4, kind: 'image', path: 'D:\\uploads\\photo.png' };
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'dGVzdA==' } };
  chat.send('看看这张图', { attachments: [attachment], blocks: [image] });
  const content = writes[0].message.content;
  assert.strictEqual(content.length, 2);
  assert.deepStrictEqual(content[1], image);
  assert.match(content[0].text, /^<claude_web_attachments>/);
  assert.ok(content[0].text.endsWith('</claude_web_attachments>\n\n看看这张图'));
  assert.ok(!content[0].text.includes(image.source.data));
  const marker = JSON.parse(content[0].text.match(/<claude_web_attachments>(.*?)<\/claude_web_attachments>/s)[1]);
  assert.deepStrictEqual(marker.files, [attachment]);
  assert.match(marker.instruction, /读取/);
  assert.throws(() => chat.send('不应打断当前生成'), /正在/);
  assert.strictEqual(writes.length, 1);

  chat.state.running = false;
  const rpText = '<rp_context>\n完整角色上下文\n</rp_context>\n\n原始用户正文';
  chat.send(rpText, { attachments: [attachment], blocks: [image] });
  assert.match(writes[1].message.content[0].text, /^<rp_context>\n完整角色上下文\n<\/rp_context>\n\n<claude_web_attachments>/);
  assert.ok(writes[1].message.content[0].text.endsWith('\n\n原始用户正文'));
  chat.state.running = false;
  chat.send('/context');
  assert.deepStrictEqual(writes[2].message.content, [{ type: 'text', text: '/context' }]);
});

test('attachment-only sends remain visible and old process message events normalize attachment markers', () => {
  const writes = [];
  const chat = new ChatSession({ cwd: 'D:\\proj', command: 'not-started' });
  chat.proc = { stdin: { write(data) { writes.push(JSON.parse(data)); } } };
  const attachment = { id: '22222222-2222-4222-8222-222222222222', name: '数据.json', mime: 'application/json', size: 5, kind: 'file', path: 'D:\\uploads\\data.json' };
  chat.send('', { attachments: [attachment], blocks: [] });
  const item = { role: 'user', text: writes[0].message.content[0].text };
  chat.state.messages.push(item);
  let event;
  chat.on('event', value => { event = value; });
  chat._emit([{ kind: 'messages', items: [item] }]);
  assert.deepStrictEqual(item.attachments, [attachment]);
  assert.strictEqual(item.text, '');
  assert.strictEqual(event.items[0], item);
  assert.strictEqual(chat.state.messages[0], item);
  assert.notStrictEqual(chat.title, '');
});
