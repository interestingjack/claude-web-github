'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeBook, activate } = require('../rp/worldinfo');

function book(id, entries) {
  return { id, ...normalizeBook({ name: id, entries: Object.fromEntries(entries.map((e, i) => [i, { uid: i, order: 100, position: 1, ...e }])) }) };
}

test('normalizeBook maps both world-file and character_book formats', () => {
  const wf = normalizeBook({ entries: { 3: { uid: 3, key: ['a'], keysecondary: ['b'], comment: 'c', content: 'x', constant: false,
    disable: true, selective: true, selectiveLogic: 3, order: 7, position: 4, depth: 2, role: 1, probability: 50, useProbability: true,
    caseSensitive: true, scanDepth: 5 } } });
  assert.deepStrictEqual(wf.entries[0], {
    uid: 3, comment: 'c', keys: ['a'], secondaryKeys: ['b'], content: 'x', constant: false, enabled: false, selective: true,
    selectiveLogic: 3, order: 7, position: 4, depth: 2, role: 1, probability: 50, useProbability: true,
    excludeRecursion: false, preventRecursion: false, caseSensitive: true, matchWholeWords: false, scanDepth: 5,
  });
  const cb = normalizeBook({ entries: [{ id: 0, keys: ['k'], secondary_keys: [], content: 'y', constant: true, enabled: true,
    insertion_order: 9, position: 'before_char', extensions: { exclude_recursion: true, scan_depth: 2 } }] });
  assert.strictEqual(cb.entries[0].position, 0);
  assert.strictEqual(cb.entries[0].order, 9);
  assert.strictEqual(cb.entries[0].excludeRecursion, true);
  assert.strictEqual(cb.entries[0].scanDepth, 2);
});

test('constant entries always fire, disabled never, toggles override both', () => {
  const b = book('b', [
    { comment: 'always', content: 'A', constant: true },
    { comment: 'off', content: 'B', constant: true, disable: true },
  ]);
  let r = activate([b], { messages: [] });
  assert.deepStrictEqual(r.after.map((e) => e.content), ['A']);
  r = activate([b], { messages: [], toggles: { 'b:0': false, 'b:1': true } });
  assert.deepStrictEqual(r.after.map((e) => e.content), ['B']);
});

test('keywords match case-insensitively in the scanned recent messages only', () => {
  const b = book('b', [{ key: ['Moon'], content: 'moon lore' }, { key: ['太阳'], content: 'sun lore' }]);
  assert.deepStrictEqual(activate([b], { messages: ['the moon rises', 'old'], scanDepth: 1 }).after.map((e) => e.content), ['moon lore']);
  assert.deepStrictEqual(activate([b], { messages: ['nothing', '太阳出来了'], scanDepth: 1 }).after, []);
  assert.deepStrictEqual(activate([b], { messages: ['nothing', '太阳出来了'], scanDepth: 2 }).after.map((e) => e.content), ['sun lore']);
});

test('regex keys and whole-word matching', () => {
  const b = book('b', [{ key: ['/姐{2}/'], content: 'R' }, { key: ['cat'], matchWholeWords: true, content: 'W' }]);
  assert.deepStrictEqual(activate([b], { messages: ['姐姐来了 concatenate'] }).after.map((e) => e.content), ['R']);
  assert.deepStrictEqual(activate([b], { messages: ['a cat'] }).after.map((e) => e.content), ['W']);
});

test('secondary key logic: AND_ANY, NOT_ALL, NOT_ANY, AND_ALL', () => {
  const mk = (logic) => book('b', [{ key: ['门'], keysecondary: ['钥匙', '锁'], selective: true, selectiveLogic: logic, content: 'L' }]);
  const fire = (logic, text) => activate([mk(logic)], { messages: [text] }).after.length === 1;
  assert.strictEqual(fire(0, '门和钥匙'), true);
  assert.strictEqual(fire(0, '只有门'), false);
  assert.strictEqual(fire(1, '门钥匙锁'), false);
  assert.strictEqual(fire(1, '门和钥匙'), true);
  assert.strictEqual(fire(2, '门和钥匙'), false);
  assert.strictEqual(fire(2, '只有门'), true);
  assert.strictEqual(fire(3, '门和钥匙'), false);
  assert.strictEqual(fire(3, '门钥匙锁'), true);
});

test('recursion: activated content can trigger more entries unless excluded/prevented', () => {
  const b = book('b', [
    { key: ['城堡'], content: '城堡里住着龙' },
    { key: ['龙'], content: '龙会喷火' },
    { key: ['喷火'], content: '火很烫', excludeRecursion: true },
  ]);
  assert.deepStrictEqual(activate([b], { messages: ['去城堡'] }).after.map((e) => e.content), ['城堡里住着龙', '龙会喷火']);
  const p = book('p', [{ key: ['城堡'], content: '城堡里住着龙', preventRecursion: true }, { key: ['龙'], content: '龙会喷火' }]);
  assert.deepStrictEqual(activate([p], { messages: ['去城堡'] }).after.map((e) => e.content), ['城堡里住着龙']);
});

test('probability uses the injected rng', () => {
  const b = book('b', [{ constant: true, content: 'P', probability: 30, useProbability: true }]);
  assert.strictEqual(activate([b], { messages: [], rng: () => 0.2 }).after.length, 1);
  assert.strictEqual(activate([b], { messages: [], rng: () => 0.5 }).after.length, 0);
});

test('entries are grouped by position and sorted by order; depth entries keep depth/role', () => {
  const b = book('b', [
    { constant: true, content: 'late', order: 200, position: 1 },
    { constant: true, content: 'early', order: 10, position: 1 },
    { constant: true, content: 'before', position: 0 },
    { constant: true, content: 'deep', position: 4, depth: 2, role: 0 },
    { constant: true, content: 'an', position: 2 },
  ]);
  const r = activate([b], { messages: [] });
  assert.deepStrictEqual(r.before.map((e) => e.content), ['before']);
  assert.deepStrictEqual(r.after.map((e) => e.content), ['early', 'late']);
  assert.deepStrictEqual(r.depth.map((e) => [e.content, e.depth]), [['deep', 2]]);
  assert.deepStrictEqual(r.other.map((e) => e.content), ['an']);
  assert.deepStrictEqual(r.activated.sort(), ['b:0', 'b:1', 'b:2', 'b:3', 'b:4']);
});
