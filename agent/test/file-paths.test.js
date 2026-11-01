'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modulePath = path.resolve(__dirname, '../../relay/public/file-paths.js');
const api = () => require(modulePath);

test('extracts explicit Chinese and spaced Windows paths without partial duplicates', () => {
  const { extractPaths } = api();
  const input = '文件在 `D:\\角色 制作\\导出 文件.json`，也可查看 D:\\普通\\结果.json。';
  assert.deepEqual(extractPaths(input), ['D:\\角色 制作\\导出 文件.json', 'D:\\普通\\结果.json']);
  assert.deepEqual(extractPaths('``D:/space folder/name (v2).json``'), ['D:\\space folder\\name (v2).json']);
});

test('recognizes local Markdown targets and file URLs with percent encoding', () => {
  const { extractPaths, pathFromHref } = api();
  assert.deepEqual(extractPaths('[下载](<D:/角色 卡/卡片.json>) 和 [第二个](file:///D:/exports/report%20v2.json)'), ['D:\\角色 卡\\卡片.json', 'D:\\exports\\report v2.json']);
  assert.deepEqual(extractPaths('[报告](D:/exports/report(v2).json "下载报告")'), ['D:\\exports\\report(v2).json']);
  assert.equal(pathFromHref('file:///d:/exports/%E8%A7%92%E8%89%B2%20%E5%8D%A1.json'), 'D:\\exports\\角色 卡.json');
  assert.equal(pathFromHref('<D%3A%2Fexports%2Freport%20v2.json>'), 'D:\\exports\\report v2.json');
  assert.deepEqual(extractPaths('下载 file:///D:/exports/report%20v2.json。'), ['D:\\exports\\report v2.json']);
});

test('deduplicates separator and case variants while retaining explicit literal percent characters', () => {
  const { extractPaths } = api();
  assert.deepEqual(extractPaths('`d:/Dir/File.json` 和 D:\\dir\\file.json，最后 [下载](file:///D:/DIR/FILE.json)'), ['D:\\Dir\\File.json']);
  assert.deepEqual(extractPaths('`D:\\files\\literal%20name.json`'), ['D:\\files\\literal%20name.json']);
});

test('rejects network, relative and executable links and does not mine local-looking URL substrings', () => {
  const { extractPaths, pathFromHref } = api();
  for (const value of ['https://example.test/D:/secret.json', 'javascript:D:/secret.json', '../file.json', '/tmp/file.json', '\\\\server\\share\\file.json', 'file://server/share/file.json', 'D:relative.json', 'D:\\file.txt:stream']) assert.equal(pathFromHref(value), null, value);
  const text = 'https://example.test/D:/hidden.json https://example.test/?path=D:/hidden2.json [x](javascript:alert("D:/hidden3.json")) `https://example.test/D:/hidden4.json` [D:/label.json](https://example.test/)';
  assert.deepEqual(extractPaths(text), []);
});

test('plain paths discard prose punctuation while quoted paths retain legal filename punctuation', () => {
  const { extractPaths } = api();
  assert.deepEqual(extractPaths('（D:\\out\\card.json），D:/out/report(v2).json! 以及 C:\\notes\\README。'), ['D:\\out\\card.json', 'D:\\out\\report(v2).json', 'C:\\notes\\README']);
  assert.deepEqual(extractPaths('`D:\\out\\报告。json`'), ['D:\\out\\报告。json']);
  assert.deepEqual(extractPaths(null), []);
});

test('browser bundle exports the same API without Node dependencies', () => {
  const sandbox = { URL }; sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), sandbox);
  assert.equal(typeof sandbox.ClaudeFilePaths.extractPaths, 'function');
  assert.equal(sandbox.ClaudeFilePaths.pathFromHref('D:/a.txt'), 'D:\\a.txt');
  assert.equal(JSON.stringify(sandbox.ClaudeFilePaths.extractPaths('`D:/a.txt`')), '["D:\\\\a.txt"]');
});
