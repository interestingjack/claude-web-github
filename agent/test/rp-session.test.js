'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { RpController } = require('../rp/session');
const { RpStore } = require('../rp/store');

// Minimal stand-in for ChatSession: records sends, supports rewind/kill like the real one.
class FakeChat extends EventEmitter {
  constructor(opts) {
    super();
    this.id = 'c1';
    this.title = opts.title;
    this.extraArgs = opts.extraArgs;
    this.state = { cwd: opts.cwd, sessionId: opts.sessionId || null, messages: opts.messages || [], running: false };
    this.sent = [];
    this.sentOptions = [];
    this.killed = 0;
  }
  send(text, options) { this.sent.push(text); this.sentOptions.push(options); this.state.running = true; }
  kill() { this.killed++; }
  rewind(uuid) {
    const i = this.state.messages.findIndex((m) => m.uuid === uuid);
    this.state.messages = this.state.messages.slice(0, i);
    return 'x';
  }
  // simulate claude answering the last send
  answer(sessionId, text, userUuid) {
    this.state.sessionId = sessionId;
    const user = { role: 'user', text: 'u', uuid: userUuid };
    const reply = { role: 'assistant', text, uuid: `a-${userUuid}` };
    this.state.messages.push(user, reply);
    this.emit('event', { kind: 'messages', items: [user, reply] });
    this.state.running = false;
    this.emit('event', { kind: 'status', running: false });
  }
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rps-'));
  const store = new RpStore(dir);
  const card = { spec: 'chara_card_v2', data: { name: '夜航', description: '{{char}}的设定', first_mes: '在吗，{{user}}', alternate_greetings: ['睡了吗'],
    character_book: { entries: [
      { id: 0, keys: [], comment: '[InitVar]', content: '好感度: 0', enabled: false },
      { id: 1, keys: ['日记'], content: '她有日记', enabled: true },
    ] } } };
  const { id } = store.importFile(Buffer.from(JSON.stringify(card)), 'c.json');
  store.saveSettings({ persona: { name: '小明', description: '' } });
  const emitted = [];
  const ctl = new RpController({ store, createChat: (o) => new FakeChat(o), notify: (chat, ev) => emitted.push(ev) });
  return { ctl, store, id, emitted };
}

test('new RP chat starts with the greeting, initial variables and a system prompt file', () => {
  const { ctl, id } = setup();
  const chat = ctl.newChat({ cardId: id, greeting: 0 });
  assert.strictEqual(chat.title, '夜航');
  assert.deepStrictEqual(chat.state.messages.map((m) => [m.role, m.text]), [['assistant', '在吗，小明']]);
  assert.deepStrictEqual(chat.rp.vars, { stat_data: { 好感度: 0 } });
  const args = chat.extraArgs();
  assert.strictEqual(args[0], '--append-system-prompt-file');
  assert.match(fs.readFileSync(args[1], 'utf8'), /夜航的设定/);
});

test('configured extra prompt files are appended to the RP system prompt, missing ones skipped', () => {
  const { store, id } = setup();
  const extra = path.join(store.dir, 'extra.md');
  fs.writeFileSync(extra, '额外的系统提示内容');
  const ctl = new RpController({ store, createChat: (o) => new FakeChat(o), notify: () => {},
    extraPromptFiles: [extra, path.join(store.dir, 'missing.md')] });
  const chat = ctl.newChat({ cardId: id, greeting: 0 });
  const text = fs.readFileSync(chat.extraArgs()[1], 'utf8');
  assert.match(text, /夜航的设定/);
  assert.ok(text.trimEnd().endsWith('额外的系统提示内容'));
  // re-read at every spawn, so edits to the file apply to the next message
  fs.writeFileSync(extra, '改过了');
  assert.ok(fs.readFileSync(chat.extraArgs()[1], 'utf8').trimEnd().endsWith('改过了'));
});

test('greeting can be switched before the first message only', () => {
  const { ctl, id } = setup();
  const chat = ctl.newChat({ cardId: id, greeting: 0 });
  ctl.setGreeting(chat, 1);
  assert.strictEqual(chat.state.messages[0].text, '睡了吗');
  assert.match(fs.readFileSync(chat.extraArgs()[1], 'utf8'), /睡了吗/);
  ctl.send(chat, '你好');
  chat.answer('s1', '嗯', 'u1');
  assert.throws(() => ctl.setGreeting(chat, 0), /已经开始/);
});

test('send wraps lore in rp_context; turn end applies MVU updates and saves state', () => {
  const { ctl, store, id, emitted } = setup();
  const chat = ctl.newChat({ cardId: id, greeting: 0 });
  ctl.send(chat, '你写日记吗');
  assert.match(chat.sent[0], /<rp_context>[\s\S]*她有日记[\s\S]*好感度: 0[\s\S]*<\/rp_context>\n\n你写日记吗$/);
  chat.answer('s1', '写啊。<UpdateVariable>_.set("好感度", 0, 2);</UpdateVariable>', 'u1');
  assert.deepStrictEqual(chat.rp.vars, { stat_data: { 好感度: 2 } });
  const ev = emitted.find((e) => e.kind === 'vars');
  assert.deepStrictEqual(ev.changes, [{ path: '好感度', from: 0, to: 2 }]);
  assert.deepStrictEqual(store.loadChat('s1').vars, { stat_data: { 好感度: 2 } });
});

test('regenerate keeps both versions; swiping restores messages, session and variables', () => {
  const { ctl, id } = setup();
  const chat = ctl.newChat({ cardId: id, greeting: 0 });
  ctl.send(chat, '你好');
  chat.answer('s1', '版本一<UpdateVariable>_.set("好感度", 1);</UpdateVariable>', 'u1');
  ctl.regen(chat);
  assert.deepStrictEqual(chat.state.messages.map((m) => m.text), ['在吗，小明'], 'rewound to before the user message');
  assert.deepStrictEqual(chat.rp.vars, { stat_data: { 好感度: 0 } }, 'variables rolled back');
  assert.match(chat.sent[1], /你好$/);
  chat.answer('s2', '版本二<UpdateVariable>_.set("好感度", 5);</UpdateVariable>', 'u2');
  assert.deepStrictEqual(ctl.info(chat).swipes, { index: 1, count: 2 });
  assert.deepStrictEqual(chat.rp.vars.stat_data, { 好感度: 5 });

  ctl.swipe(chat, 0);
  assert.strictEqual(chat.state.sessionId, 's1');
  assert.strictEqual(chat.state.messages.at(-1).text, '版本一<UpdateVariable>_.set("好感度", 1);</UpdateVariable>');
  assert.deepStrictEqual(chat.rp.vars.stat_data, { 好感度: 1 });
  assert.deepStrictEqual(ctl.info(chat).swipes, { index: 0, count: 2 });

  ctl.send(chat, '下一句');
  assert.deepStrictEqual(ctl.info(chat).swipes, { index: 0, count: 0 }, 'a new turn starts fresh swipes');
});

test('reopening an RP conversation from history restores card, greeting and variables', () => {
  const { ctl, store, id } = setup();
  store.saveChat('old-1', { cardId: id, greeting: 1, vars: { stat_data: { 好感度: 9 } }, varsBefore: {}, lastUserText: 'x' });
  const chat = ctl.fromHistory({ id: 'old-1', cwd: os.tmpdir(), messages: [{ role: 'user', text: 'hi', uuid: 'u' }] });
  assert.ok(chat);
  assert.deepStrictEqual(chat.state.messages.map((m) => m.text), ['睡了吗', 'hi']);
  assert.deepStrictEqual(chat.rp.vars.stat_data, { 好感度: 9 });
  assert.strictEqual(ctl.fromHistory({ id: 'not-rp', cwd: '.', messages: [] }), null);
});

test('completed RP turns retain actual context usage when reopened from history', () => {
  const { ctl, store, id } = setup();
  const chat = ctl.newChat({ cardId: id });
  ctl.send(chat, '你好');
  chat.state.contextUsed = 54321;
  chat.state.contextWindow = 1000000;
  chat.answer('context-1', '回复', 'u1');
  const saved = store.loadChat('context-1');
  assert.strictEqual(saved.contextUsed, 54321);
  assert.strictEqual(saved.contextWindow, 1000000);
  const reopened = ctl.fromHistory({ id: 'context-1', cwd: os.tmpdir(), messages: chat.state.messages.slice(1) });
  assert.strictEqual(reopened.state.contextUsed, 54321);
  assert.strictEqual(reopened.state.contextWindow, 1000000);
});

test('legacy or invalid RP context values remain unknown without guessing a window limit', () => {
  const { ctl, store, id } = setup();
  const cases = [
    [{}, [0, 0]],
    [{ contextUsed: -1, contextWindow: -100 }, [0, 0]],
    [{ contextUsed: '25000', contextWindow: '1000000' }, [0, 0]],
    [{ contextUsed: NaN, contextWindow: Infinity }, [0, 0]],
    [{ contextUsed: 24000 }, [24000, 0]],
    [{ contextUsed: 0, contextWindow: 200000 }, [0, 200000]],
  ];
  for (const [usage, expected] of cases) {
    store.saveChat('old-context', { cardId: id, ...usage });
    const chat = ctl.fromHistory({ id: 'old-context', cwd: os.tmpdir(), messages: [] });
    assert.deepStrictEqual([chat.state.contextUsed, chat.state.contextWindow], expected);
    chat.state.contextUsed = Infinity;
    chat.state.contextWindow = -1;
    ctl.setVars(chat, {});
    const saved = store.loadChat('old-context');
    assert.deepStrictEqual([saved.contextUsed, saved.contextWindow], [0, 0]);
  }
});

test('RP swipe versions restore their own context usage and clear unknown legacy values', () => {
  const { ctl, store, id } = setup();
  const chat = ctl.newChat({ cardId: id });
  ctl.send(chat, '你好');
  Object.assign(chat.state, { contextUsed: 12000, contextWindow: 200000 });
  chat.answer('context-swipe-1', '版本一', 'u1');
  ctl.regen(chat);
  Object.assign(chat.state, { contextUsed: 34000, contextWindow: 1000000 });
  chat.answer('context-swipe-2', '版本二', 'u2');

  assert.strictEqual(ctl.swipe(chat, 0), true);
  assert.deepStrictEqual([chat.state.contextUsed, chat.state.contextWindow], [12000, 200000]);
  const saved = store.loadChat('context-swipe-1');
  assert.deepStrictEqual([saved.contextUsed, saved.contextWindow], [12000, 200000]);
  assert.strictEqual(ctl.swipe(chat, 1), true);
  assert.deepStrictEqual([chat.state.contextUsed, chat.state.contextWindow], [34000, 1000000]);

  delete chat.rp.swipes[0].contextUsed;
  delete chat.rp.swipes[0].contextWindow;
  assert.strictEqual(ctl.swipe(chat, 0), true);
  assert.deepStrictEqual([chat.state.contextUsed, chat.state.contextWindow], [0, 0]);
});

test('RP history falls back to transcript usage only when persisted usage is missing or unknown', () => {
  const { ctl, store, id } = setup();
  const cases = [
    [{}, 55996, [55996, 0]],
    [{ contextUsed: 0, contextWindow: 0 }, 35832, [35832, 0]],
    [{ contextUsed: null, contextWindow: 200000 }, 12000, [12000, 200000]],
    [{ contextUsed: -1, contextWindow: 200000 }, 12000, [12000, 200000]],
    [{ contextUsed: 54321, contextWindow: 1000000 }, 55996, [54321, 1000000]],
    [{ contextUsed: 54321, contextWindow: 0 }, 55996, [54321, 0]],
    [{ contextUsed: 0, contextWindow: 200000 }, 12000, [0, 200000]],
    [{}, null, [0, 0]],
    [{}, undefined, [0, 0]],
    [{}, -1, [0, 0]],
    [{}, '55996', [0, 0]],
    [{}, Infinity, [0, 0]],
  ];
  for (const [savedUsage, contextUsed, expected] of cases) {
    store.saveChat('history-context', { cardId: id, ...savedUsage });
    const chat = ctl.fromHistory({ id: 'history-context', cwd: os.tmpdir(), messages: [], contextUsed });
    assert.deepStrictEqual([chat.state.contextUsed, chat.state.contextWindow], expected);
  }
});

test('RP sends and regeneration retain attachment ids without saving image data in RP state', () => {
  const { ctl, store, id } = setup();
  const attachment = { id: '11111111-1111-4111-8111-111111111111', name: '照片.png', mime: 'image/png', size: 4, kind: 'image', path: 'D:\\uploads\\photo.png' };
  const first = { attachments: [attachment], blocks: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'original-image' } }] };
  const reread = { attachments: [attachment], blocks: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'reread-image' } }] };
  let reads = 0;
  ctl.resolveAttachments = (chat, ids) => { reads++; assert.deepStrictEqual(ids, [attachment.id]); return reread; };
  const chat = ctl.newChat({ cardId: id });
  ctl.send(chat, '看这张图', first);
  assert.strictEqual(chat.sentOptions[0], first);
  assert.ok(chat.sent[0].endsWith('看这张图'));
  chat.answer('attachments-1', '看到了', 'u1');
  const saved = store.loadChat('attachments-1');
  assert.deepStrictEqual(saved.lastAttachmentIds, [attachment.id]);
  assert.ok(!JSON.stringify(saved).includes('original-image'));
  const reopened = ctl.fromHistory({ id: 'attachments-1', cwd: os.tmpdir(), messages: chat.state.messages.slice(1) });
  assert.deepStrictEqual(reopened.rp.lastAttachmentIds, [attachment.id]);
  ctl.regen(reopened);
  assert.strictEqual(reads, 1);
  assert.strictEqual(reopened.sentOptions[0], reread);
  assert.ok(reopened.sent[0].endsWith('看这张图'));
  reopened.answer('attachments-2', '另一个回复', 'u2');
  ctl.send(reopened, '下一句');
  assert.deepStrictEqual(reopened.rp.lastAttachmentIds, []);
});

test('missing regeneration attachments fail before changing the current RP reply', () => {
  const { ctl, id } = setup();
  const chat = ctl.newChat({ cardId: id });
  ctl.send(chat, '附件问题');
  chat.answer('attachments-failure', '保留这条回复', 'u1');
  chat.rp.lastAttachmentIds = ['11111111-1111-4111-8111-111111111111'];
  ctl.resolveAttachments = () => { throw new Error('附件已不存在'); };
  const before = structuredClone(chat.state.messages);
  assert.throws(() => ctl.regen(chat), /附件/);
  assert.deepStrictEqual(chat.state.messages, before);
  assert.strictEqual(chat.killed, 0);
});
