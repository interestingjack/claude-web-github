'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { browseFolders, createFolderBrowser } = require('../folders');

const hasCode = code => error => error.code === code && typeof error.message === 'string' && error.message.length > 0;
const directory = { isDirectory: () => true, isSymbolicLink: () => false };
const file = { isDirectory: () => false, isSymbolicLink: () => false };
const link = { isDirectory: () => false, isSymbolicLink: () => true };
const entry = (name, type = directory) => ({ name, ...type });
const error = code => Object.assign(new Error(code), { code });

function mockBrowser({ nodes = {}, listings = {}, links = {}, locations = { drives: ['C:\\', 'D:\\'], shortcuts: [] }, ...options } = {}) {
  const calls = [];
  const fileSystem = {
    async lstat(target) {
      calls.push(['lstat', target]);
      if (target === 'C:\\' || target === 'D:\\') return directory;
      const result = nodes[target];
      if (result instanceof Error) throw result;
      if (!result) throw error('ENOENT');
      return result;
    },
    async readdir(target, settings) {
      calls.push(['readdir', target, settings]);
      const result = listings[target];
      if (result instanceof Error) throw result;
      if (!result) throw error('ENOENT');
      return result;
    },
    async readlink(target) { calls.push(['readlink', target]); return links[target]; },
  };
  return { browse: createFolderBrowser({ fileSystem, loadLocations: async () => locations, ...options }), calls };
}

test('folder browser exports an async default entry point', () => {
  assert.equal(typeof browseFolders, 'function');
  assert.equal(browseFolders.constructor.name, 'AsyncFunction');
});

test('home uses actual redirected folders, excludes UNC/network roots and caches for twenty seconds', async () => {
  let clock = 100, loads = 0;
  const { browse, calls } = mockBrowser({
    nodes: { 'D:\\OneDrive': directory, 'D:\\OneDrive\\学校 文档': directory, 'C:\\桌面': directory },
    loadLocations: async () => {
      loads++;
      return {
        drives: ['D:\\', 'C:\\', 'Z:\\', '\\\\server\\share'], networkDrives: ['Z:\\'],
        shortcuts: [{ name: '文档', path: 'D:\\OneDrive\\学校 文档' }, { name: '桌面', path: 'C:\\桌面' }, { name: '下载', path: '\\\\server\\downloads' }, { name: '图片', path: 'Z:\\图片' }],
      };
    },
    now: () => clock,
  });
  const first = await browse();
  assert.deepEqual(first, {
    path: null, parentPath: null,
    items: [
      { name: 'C:', path: 'C:\\', kind: 'drive' }, { name: 'D:', path: 'D:\\', kind: 'drive' },
      { name: '文档', path: 'D:\\OneDrive\\学校 文档', kind: 'shortcut' }, { name: '桌面', path: 'C:\\桌面', kind: 'shortcut' },
    ], offset: 0, hasMore: false, nextOffset: null,
  });
  const reads = calls.length;
  first.items[0].name = 'mutated';
  assert.equal((await browse()).items[0].name, 'C:');
  assert.equal(calls.length, reads);
  assert.equal(loads, 1);
  assert.equal(calls.some(call => /server|Z:/.test(call[1])), false);
  clock += 20001;
  await browse();
  assert.equal(loads, 2);
  assert.ok(calls.length > reads);
});

test('directories use numeric Chinese sorting, expose only folder names and paginate without duplicates', async () => {
  const names = ['项目10', '项目2', '项目1', '测试 空格', 'Alpha'];
  const { browse, calls } = mockBrowser({ nodes: { 'C:\\项目 空间': directory }, listings: { 'C:\\项目 空间': [...names.map(name => entry(name)), entry('秘密.txt', file)] } });
  const first = await browse({ path: 'c:/项目 空间/', limit: 2 });
  assert.equal(first.path, 'C:\\项目 空间');
  assert.equal(first.parentPath, 'C:\\');
  assert.deepEqual(first.items.map(item => item.name), ['测试 空格', '项目1']);
  assert.equal(first.hasMore, true); assert.equal(first.nextOffset, 2);
  const second = await browse({ path: first.path, offset: first.nextOffset, limit: 2 });
  assert.deepEqual(second.items.map(item => item.name), ['项目2', '项目10']);
  const last = await browse({ path: first.path, offset: second.nextOffset, limit: 2 });
  assert.deepEqual(last.items, [{ name: 'Alpha', path: 'C:\\项目 空间\\Alpha', kind: 'folder' }]);
  assert.equal(last.hasMore, false); assert.equal(last.nextOffset, null);
  assert.deepEqual(calls.filter(call => call[0] === 'readdir')[0], ['readdir', 'C:\\项目 空间', { withFileTypes: true }]);
  assert.equal(calls.filter(call => call[0] === 'lstat').length, 3);
});

test('root parent is null, limits clamp at 200 and exhausted pages stay empty', async () => {
  const { browse } = mockBrowser({ listings: { 'C:\\': Array.from({ length: 205 }, (_, i) => entry(`文件夹${i}`)) } });
  const first = await browse({ path: 'C:\\', limit: 999 });
  assert.equal(first.items.length, 200); assert.equal(first.nextOffset, 200); assert.equal(first.parentPath, null);
  const beyond = await browse({ path: 'C:\\', offset: 300 });
  assert.deepEqual(beyond.items, []); assert.equal(beyond.hasMore, false); assert.equal(beyond.nextOffset, null);
});

test('invalid, relative, UNC, device and ADS paths are rejected before discovery or filesystem work', async () => {
  let loads = 0;
  const { browse, calls } = mockBrowser({ loadLocations: async () => { loads++; return { drives: ['C:\\'] }; } });
  for (const target of ['', 'C:', 'C:relative', '.', '..\\file', '/tmp', '\\rooted', '\\\\server\\share', '\\\\?\\C:\\files', '\\\\.\\C:\\', 'C:\\file:stream', 'C:\\bad\u0000name', 'C:\\bad*name', 'C:\\CON', 'C:\\ends.']) {
    await assert.rejects(browse({ path: target }), hasCode('invalid_path'), target);
  }
  for (const options of [null, [], { path: 3 }, { offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: NaN }]) await assert.rejects(browse(options), hasCode('invalid_path'));
  assert.equal(loads, 0); assert.equal(calls.length, 0);
});

test('missing paths, permissions, disconnected disks and discovery failures produce readable codes', async () => {
  const { browse } = mockBrowser({ nodes: { 'C:\\private': error('EACCES'), 'C:\\broken': error('EIO'), 'C:\\file': file }, locations: { drives: ['C:\\'], networkDrives: ['Z:\\'], shortcuts: [] } });
  await assert.rejects(browse({ path: 'C:\\gone' }), hasCode('not_found'));
  await assert.rejects(browse({ path: 'C:\\private' }), hasCode('access_denied'));
  await assert.rejects(browse({ path: 'C:\\broken' }), hasCode('unavailable'));
  await assert.rejects(browse({ path: 'C:\\file' }), hasCode('not_found'));
  await assert.rejects(browse({ path: 'E:\\' }), hasCode('unavailable'));
  await assert.rejects(browse({ path: 'Z:\\' }), hasCode('invalid_path'));
  const failed = createFolderBrowser({ loadLocations: async () => { throw error('EIO'); } });
  await assert.rejects(failed(), hasCode('unavailable'));
});

test('local junctions resolve their targets; network, device, file and cyclic links are excluded', async () => {
  const { browse, calls } = mockBrowser({
    nodes: {
      'C:\\工作': directory, 'C:\\工作\\本地链接': link, 'C:\\工作\\相对链接': link,
      'C:\\工作\\网络链接': link, 'C:\\工作\\映射链接': link, 'C:\\工作\\设备链接': link,
      'C:\\工作\\文件链接': link, 'C:\\工作\\循环链接': link,
      'D:\\目标': directory, 'D:\\plain.txt': file,
    },
    listings: { 'C:\\工作': ['本地链接', '相对链接', '网络链接', '映射链接', '设备链接', '文件链接', '循环链接'].map(name => entry(name, link)), 'D:\\目标': [] },
    links: {
      'C:\\工作\\本地链接': '\\\\?\\D:\\目标', 'C:\\工作\\相对链接': '.',
      'C:\\工作\\网络链接': '\\\\server\\secret', 'C:\\工作\\映射链接': 'Z:\\secret',
      'C:\\工作\\设备链接': '\\\\?\\Volume{test}\\', 'C:\\工作\\文件链接': 'D:\\plain.txt',
      'C:\\工作\\循环链接': 'C:\\工作\\循环链接',
    },
    locations: { drives: ['C:\\', 'D:\\'], networkDrives: ['Z:\\'], shortcuts: [] },
  });
  const listing = await browse({ path: 'C:\\工作' });
  assert.deepEqual(listing.items, [{ name: '本地链接', path: 'D:\\目标', kind: 'folder' }, { name: '相对链接', path: 'C:\\工作', kind: 'folder' }]);
  const selected = await browse({ path: 'C:\\工作\\本地链接' });
  assert.equal(selected.path, 'D:\\目标'); assert.equal(selected.parentPath, 'D:\\');
  await assert.rejects(browse({ path: 'C:\\工作\\网络链接\\never' }), hasCode('invalid_path'));
  assert.equal(calls.some(call => /server|Z:|never|Volume\{/.test(call[1])), false);
});

test('symlink ancestors are checked before traversing and missing child directories do not leak files', async () => {
  const { browse, calls } = mockBrowser({ nodes: { 'C:\\alias': link, 'D:\\local': directory, 'D:\\local\\deep': directory }, links: { 'C:\\alias': 'D:\\local' }, listings: { 'D:\\local\\deep': [entry('keep'), entry('file.json', file)] } });
  const result = await browse({ path: 'C:\\alias\\deep' });
  assert.equal(result.path, 'D:\\local\\deep');
  assert.deepEqual(result.items, [{ name: 'keep', path: 'D:\\local\\deep\\keep', kind: 'folder' }]);
  assert.equal(calls.some(call => call[1] === 'C:\\alias\\deep'), false);
});

test('filesystem concurrency remains bounded after timeouts and queued work does not start later', async () => {
  let active = 0, peak = 0, started = 0;
  const releases = [];
  const browse = createFolderBrowser({
    loadLocations: async () => ({ drives: ['C:\\'], shortcuts: [] }),
    maxConcurrentFs: 2, operationTimeoutMs: 25,
    fileSystem: { lstat() { started++; active++; peak = Math.max(peak, active); return new Promise(resolve => releases.push(() => { active--; resolve(directory); })); } },
  });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => browse({ path: 'C:\\slow' })));
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'unavailable'));
  assert.equal(peak, 2); assert.equal(started, 2);
  for (const release of releases) release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 2);
});

test('real temporary directories list just one level, preserve Chinese names and never read file contents', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-browser-'));
  t.after(async () => {
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('folder-browser-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(temporary, '中文 空格'));
  await fs.mkdir(path.join(temporary, '目录10'));
  await fs.mkdir(path.join(temporary, '目录2'));
  await fs.mkdir(path.join(temporary, '中文 空格', '不递归'));
  await fs.writeFile(path.join(temporary, '不要读取.txt'), 'private contents');
  // Adapt only this disposable directory to a deterministic virtual local drive.
  const toNative = target => {
    assert.ok(target === 'T:\\' || target.startsWith('T:\\'));
    return path.join(temporary, ...target.slice(3).split('\\').filter(Boolean));
  };
  let listings = 0;
  const browse = createFolderBrowser({
    loadLocations: async () => ({ drives: ['T:\\'], shortcuts: [] }),
    fileSystem: {
      lstat: target => fs.lstat(toNative(target)),
      readlink: target => fs.readlink(toNative(target)),
      readdir: (target, settings) => { listings++; return fs.readdir(toNative(target), settings); },
    },
  });
  const result = await browse({ path: 'T:\\' });
  assert.deepEqual(result.items.map(item => item.name), ['目录2', '目录10', '中文 空格']);
  assert.ok(result.items.every(item => Object.keys(item).join(',') === 'name,path,kind'));
  assert.equal(listings, 1);
});
