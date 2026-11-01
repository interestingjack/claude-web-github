'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSystemPrompt, buildTurn, stripTurnContext } = require('../rp/prompt');
const { normalizeBook } = require('../rp/worldinfo');
const { RpStore } = require('../rp/store');

const card = {
  name: '夜航', description: '{{char}}是{{user}}的姐姐。', personality: '外冷内热', scenario: '深夜私信',
  first_mes: '在吗，{{user}}？', alternate_greetings: ['睡了吗'], mes_example: '<START>\n{{char}}: 嗯',
  system_prompt: '', post_history_instructions: '保持第三人称', depth_prompt: { prompt: '用短句', depth: 4, role: 'system' },
  character_book: normalizeBook({ entries: [
    { id: 0, keys: [], content: '常驻：信息差守则', constant: true, enabled: true, extensions: { position: 1 } },
    { id: 1, keys: [], content: '常驻@depth：回复格式', constant: true, enabled: true, extensions: { position: 4, depth: 4 } },
    { id: 2, keys: ['日记'], content: '触发：{{char}}有一本日记', constant: false, enabled: true, extensions: { position: 1 } },
  ] }),
};
const books = [{ id: 'card', ...card.character_book }];
const persona = { name: '小明', description: '大学生' };

test('system prompt carries card, persona, constant lore and the chosen greeting with macros filled', () => {
  const s = buildSystemPrompt({ card, persona, books, toggles: {}, greeting: 1, vars: {} });
  assert.match(s, /夜航是小明的姐姐。/);
  assert.match(s, /外冷内热/);
  assert.match(s, /深夜私信/);
  assert.match(s, /大学生/);
  assert.match(s, /常驻：信息差守则/);
  assert.doesNotMatch(s, /常驻@depth/, '@depth entries go with each turn');
  assert.doesNotMatch(s, /触发：/, 'keyword entries go with each turn');
  assert.match(s, /夜航: 嗯/);
  assert.match(s, /睡了吗/);
  assert.doesNotMatch(s, /在吗/);
});

test('turn context carries triggered lore, @depth lore, variables and post-history instructions', () => {
  const vars = { stat_data: { 好感度: 3 } };
  const t = buildTurn({ card, persona, books, toggles: {}, history: ['你写日记吗'], vars, userText: '你写日记吗' });
  assert.match(t, /^<rp_context>/);
  assert.match(t, /触发：夜航有一本日记/);
  assert.match(t, /常驻@depth：回复格式/);
  assert.match(t, /好感度: 3/);
  assert.match(t, /用短句/);
  assert.match(t, /保持第三人称/);
  assert.ok(t.endsWith('</rp_context>\n\n你写日记吗'));
  assert.strictEqual(stripTurnContext(t), '你写日记吗');
});

test('turn without triggers or variables still carries the user text plainly', () => {
  const bare = { ...card, character_book: null, depth_prompt: null, post_history_instructions: '' };
  assert.strictEqual(buildTurn({ card: bare, persona, books: [], toggles: {}, history: ['嗨'], vars: {}, userText: '嗨' }), '嗨');
});

test('RpStore imports cards and world books, persists settings and chat state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
  const store = new RpStore(dir);
  const json = Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name: '夜航', description: 'd', first_mes: 'hi',
    character_book: { entries: [{ id: 0, keys: ['a'], content: 'x', enabled: true }] } } }));
  const r = store.importFile(json, '夜航.json');
  assert.strictEqual(r.kind, 'card');
  const list = store.listCards();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, '夜航');
  assert.strictEqual(list[0].hasAvatar, false);
  assert.strictEqual(store.getCard(r.id).name, '夜航');
  assert.ok(fs.statSync(store.cardDir(r.id)).isDirectory());

  const wb = store.importFile(Buffer.from(JSON.stringify({ entries: { 0: { uid: 0, key: ['k'], content: 'c' } } })), '全局.json');
  assert.strictEqual(wb.kind, 'worldbook');
  assert.deepStrictEqual(store.listBooks().map((b) => [b.name, b.entries]), [['全局', 1]]);

  store.saveSettings({ persona: { name: '小明', description: '' }, globalBooks: [wb.id], toggles: { 'x:0': false } });
  assert.deepStrictEqual(new RpStore(dir).settings().globalBooks, [wb.id]);
  // books used by a card chat: its own book first, then enabled global books
  assert.deepStrictEqual(store.booksFor(r.id).map((b) => b.id), [`card-${r.id}`, wb.id]);

  store.saveChat('sess-1', { cardId: r.id, vars: { stat_data: { a: 1 } } });
  assert.deepStrictEqual(store.loadChat('sess-1').vars, { stat_data: { a: 1 } });
  assert.strictEqual(store.loadChat('../evil'), null);

  store.deleteCard(r.id);
  assert.strictEqual(store.listCards().length, 0);
});
