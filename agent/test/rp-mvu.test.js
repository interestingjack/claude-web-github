'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { initVars, extractCommands, applyCommands, stripUpdateBlocks, toPath } = require('../rp/mvu');
const { replaceMacros } = require('../rp/macros');
const { normalizeBook } = require('../rp/worldinfo');

test('toPath handles dots, brackets and quoted keys', () => {
  assert.deepStrictEqual(toPath('角色.好感度'), ['角色', '好感度']);
  assert.deepStrictEqual(toPath('背包[0].名称'), ['背包', '0', '名称']);
  assert.deepStrictEqual(toPath("世界['地.点']"), ['世界', '地.点']);
});

test('initVars merges [InitVar] entries (YAML or JSON), even disabled ones', () => {
  const b = normalizeBook({ entries: {
    0: { uid: 0, comment: '[InitVar]角色', content: '角色:\n  好感度: 0\n  心情: 平静\n', disable: true },
    1: { uid: 1, comment: '[InitVar] 世界', content: '{"世界": {"时间": "夜晚"}}', disable: false },
    2: { uid: 2, comment: '普通条目', content: 'x: 1' },
  } });
  assert.deepStrictEqual(initVars([b]), { 角色: { 好感度: 0, 心情: '平静' }, 世界: { 时间: '夜晚' } });
});

test('extractCommands reads _.set/_.add/_.insert/_.remove with JS-literal args, preferring UpdateVariable blocks', () => {
  const text = `正文里提到 _.set('不该', 1);
<UpdateVariable>
<Analysis>想法</Analysis>
_.set('角色.好感度', 0, 5);//她笑了
_.set("角色.心情", '开心');
_.add('金币', -3);
_.insert('背包', {名称: '钥匙', 数量: 1});
_.insert('地图', '东区', "已探索");
_.remove('背包', 0);
_.set('标签', ['a', "b, c"]);
</UpdateVariable>`;
  assert.deepStrictEqual(extractCommands(text), [
    { op: 'set', path: '角色.好感度', args: [0, 5] },
    { op: 'set', path: '角色.心情', args: ['开心'] },
    { op: 'add', path: '金币', args: [-3] },
    { op: 'insert', path: '背包', args: [{ 名称: '钥匙', 数量: 1 }] },
    { op: 'insert', path: '地图', args: ['东区', '已探索'] },
    { op: 'remove', path: '背包', args: [0] },
    { op: 'set', path: '标签', args: [['a', 'b, c']] },
  ]);
});

test('extractCommands also reads JSONPatch blocks', () => {
  const text = '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/角色/好感度","value":9},{"op":"delta","path":"/金币","value":2},{"op":"remove","path":"/旧"}]</JSONPatch></UpdateVariable>';
  assert.deepStrictEqual(extractCommands(text), [
    { op: 'set', path: '角色.好感度', args: [9] },
    { op: 'add', path: '金币', args: [2] },
    { op: 'remove', path: '旧', args: [] },
  ]);
});

test('applyCommands updates a copy and reports changes; [value, desc] pairs keep their description', () => {
  const vars = { 角色: { 好感度: [0, '0-100'], 心情: '平静' }, 金币: 10, 背包: ['剑'], 地图: {}, 旧: 1 };
  const cmds = [
    { op: 'set', path: '角色.好感度', args: [0, 5] },
    { op: 'set', path: '角色.心情', args: ['开心'] },
    { op: 'add', path: '金币', args: [-3] },
    { op: 'insert', path: '背包', args: ['盾'] },
    { op: 'insert', path: '地图', args: ['东区', '已探索'] },
    { op: 'remove', path: '背包', args: [0] },
    { op: 'remove', path: '旧', args: [] },
    { op: 'set', path: '新.深层', args: [1] },
  ];
  const r = applyCommands(vars, cmds);
  assert.deepStrictEqual(r.vars, { 角色: { 好感度: [5, '0-100'], 心情: '开心' }, 金币: 7, 背包: ['盾'], 地图: { 东区: '已探索' }, 新: { 深层: 1 } });
  assert.strictEqual(vars.金币, 10, 'input untouched');
  assert.deepStrictEqual(r.changes[0], { path: '角色.好感度', from: 0, to: 5 });
  assert.strictEqual(r.changes.length, 8);
});

test('stripUpdateBlocks hides variable updates from the chat text', () => {
  assert.strictEqual(stripUpdateBlocks('她笑了。\n<UpdateVariable>\n_.set("a", 1);\n</UpdateVariable>\n'), '她笑了。');
});

test('macros: char/user, variables, formatting, random, comments', () => {
  const ctx = { char: '夜航', user: '小明', vars: { stat_data: { 角色: { 好感度: 5 } } }, rng: () => 0.99, lastUserMessage: '你好' };
  assert.strictEqual(replaceMacros('{{char}}看着{{user}}，<USER>和<BOT>', ctx), '夜航看着小明，小明和夜航');
  assert.strictEqual(replaceMacros('好感{{get_message_variable::stat_data.角色.好感度}}', ctx), '好感5');
  assert.strictEqual(replaceMacros('{{getvar::stat_data.角色.好感度}}', ctx), '5');
  assert.strictEqual(replaceMacros('{{format_message_variable::stat_data}}', ctx), '角色:\n  好感度: 5');
  assert.strictEqual(replaceMacros('{{random::红::绿::蓝}}', ctx), '蓝');
  assert.strictEqual(replaceMacros('{{random:红,绿}}', ctx), '绿');
  assert.strictEqual(replaceMacros('a{{// 注释}}b{{lastUserMessage}}', ctx), 'ab你好');
  assert.strictEqual(replaceMacros('{{unknown_macro}}', ctx), '{{unknown_macro}}');
});
