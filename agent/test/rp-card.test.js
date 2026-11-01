'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseImport } = require('../rp/card');

function pngWithText(chunks) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]); // CRC not checked
  };
  const parts = [sig, chunk('IHDR', Buffer.alloc(13))];
  for (const [k, v] of Object.entries(chunks)) parts.push(chunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1')])));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const v3 = {
  spec: 'chara_card_v3', spec_version: '3.0', name: 'outer',
  data: {
    name: '夜航', description: '{{char}}是{{user}}的姐姐', personality: '外冷内热', scenario: '深夜私信',
    first_mes: '在吗？', alternate_greetings: ['睡了吗'], mes_example: '<START>\n{{char}}: 嗯',
    system_prompt: '', post_history_instructions: '保持中文', creator_notes: '作者说明', tags: ['姐妹'],
    extensions: {
      regex_scripts: [{ scriptName: '备注', findRegex: '/夜航/g', replaceString: '$&（姐姐）', placement: [2], markdownOnly: true }],
      depth_prompt: { prompt: '记得用短句', depth: 4, role: 'system' },
      tavern_helper: { scripts: [{ name: 'MVU', content: "import 'x'" }] },
    },
    character_book: { name: '书', entries: [
      { id: 0, keys: [], secondary_keys: [], comment: '守则', content: '信息差', constant: true, selective: true,
        insertion_order: 100, enabled: true, position: 'after_char', extensions: { position: 1, depth: 4, probability: 100, useProbability: true } },
    ] },
  },
};

test('JSON v3 card is normalised from data, not the outer v1 fields', () => {
  const c = parseImport(Buffer.from(JSON.stringify(v3)), 'a.json');
  assert.strictEqual(c.kind, 'card');
  assert.strictEqual(c.card.name, '夜航');
  assert.strictEqual(c.card.first_mes, '在吗？');
  assert.deepStrictEqual(c.card.alternate_greetings, ['睡了吗']);
  assert.strictEqual(c.card.post_history_instructions, '保持中文');
  assert.strictEqual(c.card.regex_scripts.length, 1);
  assert.deepStrictEqual(c.card.depth_prompt, { prompt: '记得用短句', depth: 4, role: 'system' });
  assert.strictEqual(c.card.helper_scripts.length, 1);
  assert.strictEqual(c.card.character_book.entries[0].comment, '守则');
  assert.strictEqual(c.card.character_book.entries[0].position, 1);
  assert.strictEqual(c.avatar, null);
});

test('v1 flat JSON card works', () => {
  const c = parseImport(Buffer.from('﻿' + JSON.stringify({ name: '甲', description: 'd', first_mes: 'hi', mes_example: '' })), 'v1.json');
  assert.strictEqual(c.card.name, '甲');
  assert.deepStrictEqual(c.card.alternate_greetings, []);
  assert.strictEqual(c.card.character_book, null);
});

test('PNG card: ccv3 chunk wins over chara, avatar kept', () => {
  const v2 = { spec: 'chara_card_v2', data: { name: '旧版', description: '' } };
  const png = pngWithText({
    chara: Buffer.from(JSON.stringify(v2)).toString('base64'),
    ccv3: Buffer.from(JSON.stringify(v3)).toString('base64'),
  });
  const c = parseImport(png, 'card.png');
  assert.strictEqual(c.kind, 'card');
  assert.strictEqual(c.card.name, '夜航');
  assert.ok(Buffer.isBuffer(c.avatar));
});

test('PNG without card data is rejected', () => {
  assert.throws(() => parseImport(pngWithText({ Software: 'x' }), 'pic.png'), /没有角色卡数据/);
});

test('a world book file is recognised as a world book', () => {
  const wb = { entries: { 0: { uid: 0, key: ['足'], keysecondary: [], comment: '指导', content: 'c', constant: false, disable: false, order: 100, position: 4, depth: 2 } } };
  const c = parseImport(Buffer.from(JSON.stringify(wb)), '足交描写指导.json');
  assert.strictEqual(c.kind, 'worldbook');
  assert.strictEqual(c.book.name, '足交描写指导');
  assert.deepStrictEqual(c.book.entries[0].keys, ['足']);
  assert.strictEqual(c.book.entries[0].position, 4);
  assert.strictEqual(c.book.entries[0].depth, 2);
});

test('garbage is rejected with a readable error', () => {
  assert.throws(() => parseImport(Buffer.from('not json'), 'x.json'), /无法识别/);
});
