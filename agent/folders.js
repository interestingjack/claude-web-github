'use strict';
const fs = require('node:fs/promises');
const path = require('node:path').win32;
const { execFile } = require('node:child_process');

// Keep this command static: paths received from the phone never enter PowerShell.
const LOCATION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$local = @()
$network = @()
foreach ($drive in [System.IO.DriveInfo]::GetDrives()) {
  try {
    if ($drive.DriveType -eq [System.IO.DriveType]::Network) { $network += $drive.Name }
    elseif ($drive.DriveType -in @([System.IO.DriveType]::Fixed, [System.IO.DriveType]::Removable, [System.IO.DriveType]::CDRom, [System.IO.DriveType]::Ram)) { $local += $drive.Name }
  } catch {}
}
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders')
$shortcuts = @()
$definitions = @(
  @('文档', 'Personal', 'MyDocuments'),
  @('桌面', 'Desktop', 'DesktopDirectory'),
  @('图片', 'My Pictures', 'MyPictures'),
  @('视频', 'My Video', 'MyVideos'),
  @('音乐', 'My Music', 'MyMusic'),
  @('下载', '{374DE290-123F-4565-9164-39C4925E467B}', '')
)
try {
  foreach ($definition in $definitions) {
    $target = $null
    if ($null -ne $key) { $target = $key.GetValue($definition[1], $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    if ([string]::IsNullOrWhiteSpace([string]$target) -and $definition[2]) { $target = [Environment]::GetFolderPath([Enum]::Parse([Environment+SpecialFolder], $definition[2])) }
    if ([string]::IsNullOrWhiteSpace([string]$target) -and $definition[0] -eq '下载') { $target = [System.IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile), 'Downloads') }
    if (-not [string]::IsNullOrWhiteSpace([string]$target)) { $shortcuts += @{ name = $definition[0]; path = [Environment]::ExpandEnvironmentVariables([string]$target) } }
  }
} finally { if ($null -ne $key) { $key.Dispose() } }
@{ drives = @($local); networkDrives = @($network); shortcuts = @($shortcuts) } | ConvertTo-Json -Depth 4 -Compress
`;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readableError(error) {
  if (['invalid_path', 'not_found', 'access_denied', 'unavailable'].includes(error?.code)) return error;
  if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return failure('not_found', '找不到这个文件夹，可能已移动或删除');
  if (['EACCES', 'EPERM'].includes(error?.code)) return failure('access_denied', '没有权限打开这个文件夹');
  return failure('unavailable', '暂时无法读取这个文件夹，请检查磁盘是否已连接');
}

function normalizeLocalPath(value, linkTarget = false) {
  if (typeof value !== 'string' || !value || value.length > 4096) throw failure('invalid_path', '请选择本机磁盘上的文件夹');
  let result = value.replace(/\//g, '\\');
  // Node returns this prefix for ordinary local junction targets, never accept it from requests.
  if (linkTarget && /^\\\\\?\\[a-z]:\\/i.test(result)) result = result.slice(4);
  if (!/^[a-z]:\\/i.test(result) || /[\x00-\x1f\x7f<>"|?*]/.test(result) || result.slice(2).includes(':')) {
    throw failure('invalid_path', '仅支持本机绝对目录，不支持网络或设备路径');
  }
  const parts = result.slice(3).split('\\').filter(Boolean);
  if (parts.some(part => part !== '.' && part !== '..' && (/[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) {
    throw failure('invalid_path', '文件夹路径无效');
  }
  result = path.normalize(result);
  if (result.length > 3) result = result.replace(/\\+$/, '');
  return result[0].toUpperCase() + result.slice(1);
}

function loadWindowsLocations() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', LOCATION_SCRIPT], {
      encoding: 'utf8', windowsHide: true, timeout: 6000, maxBuffer: 256 * 1024,
    }, (error, stdout) => {
      if (error) return reject(failure('unavailable', '暂时无法读取本机磁盘列表，请稍后重试'));
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); }
      catch { reject(failure('unavailable', '暂时无法读取本机磁盘列表，请稍后重试')); }
    });
  });
}

// The factory keeps tests independent of real drives, redirected user folders and permissions.
function createFolderBrowser({
  fileSystem = fs, loadLocations = loadWindowsLocations, now = Date.now,
  cacheTtlMs = 20000, operationTimeoutMs = 3000, requestTimeoutMs = 10000,
  maxConcurrentFs = 4,
} = {}) {
  const compare = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }).compare;
  let locationsCache, locationsExpires = 0, locationsPending;
  let homeCache, homeExpires = 0, homePending;
  let active = 0;
  const queue = [];

  function pump() {
    while (active < maxConcurrentFs && queue.length) {
      const job = queue.shift();
      if (job.expired) continue;
      active++;
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  }

  function io(context, method, ...args) {
    const remaining = context.deadline - now();
    if (remaining <= 0) return Promise.reject(failure('unavailable', '读取文件夹超时，请稍后重试'));
    return new Promise((resolve, reject) => {
      const job = { expired: false, run: () => fileSystem[method](...args) };
      const timer = setTimeout(() => {
        job.expired = true;
        const index = queue.indexOf(job);
        if (index !== -1) queue.splice(index, 1);
        reject(failure('unavailable', '读取文件夹超时，请稍后重试'));
      }, Math.min(operationTimeoutMs, remaining));
      job.resolve = value => { clearTimeout(timer); if (!job.expired) resolve(value); };
      job.reject = error => { clearTimeout(timer); if (!job.expired) reject(readableError(error)); };
      queue.push(job);
      pump();
    });
  }

  async function getLocations() {
    if (locationsCache && now() < locationsExpires) return locationsCache;
    if (!locationsPending) {
      locationsPending = Promise.resolve().then(loadLocations).then(data => {
        if (!data || !Array.isArray(data.drives)) throw failure('unavailable', '暂时无法读取本机磁盘列表');
        const roots = values => new Set((Array.isArray(values) ? values : []).flatMap(value => {
          try {
            const normalized = normalizeLocalPath(typeof value === 'string' ? value : value.path);
            return normalized.length === 3 ? [normalized.toUpperCase()] : [];
          } catch { return []; }
        }));
        const network = roots(data.networkDrives);
        const local = roots(data.drives);
        for (const root of network) local.delete(root);
        locationsCache = { local, network, shortcuts: Array.isArray(data.shortcuts) ? data.shortcuts : [] };
        locationsExpires = now() + cacheTtlMs;
        return locationsCache;
      }).catch(error => { throw readableError(error); }).finally(() => { locationsPending = null; });
    }
    return locationsPending;
  }

  function checkDrive(value, locations) {
    const root = path.parse(value).root.toUpperCase();
    if (locations.network.has(root)) throw failure('invalid_path', '暂不支持网络磁盘，请选择本机文件夹');
    if (!locations.local.has(root)) throw failure('unavailable', '此磁盘不可用，请检查是否已连接');
    return root;
  }

  async function resolveDirectory(value, locations, context) {
    let target = normalizeLocalPath(value), links = 0;
    let current = checkDrive(target, locations);
    let pending = target.slice(3).split('\\').filter(Boolean);
    const seenLinks = new Set();
    if (!pending.length) {
      const stat = await io(context, 'lstat', current);
      if (!stat.isDirectory()) throw failure('not_found', '找不到这个文件夹');
    }
    while (pending.length) {
      const candidate = path.join(current, pending.shift());
      const stat = await io(context, 'lstat', candidate);
      if (stat.isSymbolicLink()) {
        if (++links > 32 || seenLinks.has(candidate.toLowerCase())) throw failure('unavailable', '文件夹链接无法打开');
        seenLinks.add(candidate.toLowerCase());
        const destination = await io(context, 'readlink', candidate);
        if (typeof destination !== 'string') throw failure('invalid_path', '文件夹链接目标无效');
        const absolute = /^[a-z]:[\\/]/i.test(destination) || /^[\\/]/.test(destination);
        target = normalizeLocalPath(absolute ? destination : path.resolve(path.dirname(candidate), destination), true);
        current = checkDrive(target, locations);
        pending = [...target.slice(3).split('\\').filter(Boolean), ...pending];
        if (!pending.length) {
          const rootStat = await io(context, 'lstat', current);
          if (!rootStat.isDirectory()) throw failure('not_found', '找不到这个文件夹');
        }
      } else {
        if (!stat.isDirectory()) throw failure('not_found', '找不到这个文件夹');
        current = candidate;
      }
    }
    return current;
  }

  function sortItems(items) {
    return items.sort((a, b) => compare(a.name, b.name) || a.name.localeCompare(b.name, 'en') || a.path.localeCompare(b.path, 'en'));
  }

  async function mapLimited(items, visitor) {
    const output = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        output[index] = await visitor(items[index]);
      }
    }));
    return output.filter(Boolean);
  }

  async function getHomeItems(locations, context) {
    if (homeCache && now() < homeExpires) return homeCache;
    if (!homePending) {
      homePending = (async () => {
        const drives = [...locations.local].map(root => ({ name: root.slice(0, 2), path: root, kind: 'drive' }));
        const shortcuts = await mapLimited(locations.shortcuts, async shortcut => {
          if (!shortcut || typeof shortcut.name !== 'string' || !shortcut.name.trim()) return null;
          try {
            const target = await resolveDirectory(shortcut.path, locations, context);
            return { name: shortcut.name, path: target, kind: 'shortcut' };
          } catch { return null; }
        });
        homeCache = [...sortItems(drives), ...sortItems(shortcuts)];
        homeExpires = now() + cacheTtlMs;
        return homeCache;
      })().finally(() => { homePending = null; });
    }
    return homePending;
  }

  return async function browseFolders(options = {}) {
    try {
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw failure('invalid_path', '文件夹请求无效');
      const { path: requestedPath = null, offset = 0, limit: requestedLimit = 100 } = options;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw failure('invalid_path', '文件夹分页参数无效');
      const limit = Math.min(200, requestedLimit);
      // Reject malformed paths before invoking Windows or touching the filesystem.
      const normalized = requestedPath === null ? null : normalizeLocalPath(requestedPath);
      const context = { deadline: now() + requestTimeoutMs };
      const locations = await getLocations();
      let current = null, parentPath = null, items;
      if (normalized === null) {
        items = await getHomeItems(locations, context);
      } else {
        current = await resolveDirectory(normalized, locations, context);
        parentPath = current.length === 3 ? null : path.dirname(current);
        const entries = await io(context, 'readdir', current, { withFileTypes: true });
        items = await mapLimited(entries, async entry => {
          if (typeof entry.name !== 'string' || !entry.name || entry.name === '.' || entry.name === '..' || /[\\/]/.test(entry.name)) return null;
          const child = path.join(current, entry.name);
          if (entry.isSymbolicLink()) {
            try { return { name: entry.name, path: await resolveDirectory(child, locations, context), kind: 'folder' }; }
            catch { return null; }
          }
          if (!entry.isDirectory()) return null;
          try { return { name: entry.name, path: normalizeLocalPath(child), kind: 'folder' }; }
          catch { return null; }
        });
        sortItems(items);
      }
      const selected = items.slice(offset, offset + limit).map(item => ({ ...item }));
      const hasMore = offset + selected.length < items.length;
      return { path: current, parentPath, items: selected, offset, hasMore, nextOffset: hasMore ? offset + selected.length : null };
    } catch (error) { throw readableError(error); }
  };
}

const browseFolders = createFolderBrowser();
module.exports = { browseFolders, createFolderBrowser };
