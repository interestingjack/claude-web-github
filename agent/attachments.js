'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LIMITS = Object.freeze({ maxFiles: 5, maxFileBytes: 10 * 1024 * 1024, maxImageBytes: 5 * 1024 * 1024, maxTotalBytes: 12 * 1024 * 1024 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const cleanName = name => String(name || '附件').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 240) || '附件';

function identity(chat) {
  const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
  const chatId = valid(chat?.id), sessionId = valid(chat?.state?.sessionId || chat?.sessionId);
  if (!chatId && !sessionId) fail('INVALID_CHAT', '请先打开一个对话再上传附件');
  return { chatId, sessionId };
}

function owns(record, owner) {
  return !!((owner.chatId && [record.chatId, ...(record.chatIds || [])].includes(owner.chatId))
    || (owner.sessionId && [record.sessionId, ...(record.sessionIds || [])].includes(owner.sessionId)));
}

function within(file, directory) {
  const relative = path.relative(directory, file);
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function decode(data) {
  if (typeof data !== 'string' || data.length > 4 * Math.ceil(LIMITS.maxFileBytes / 3)) fail('FILE_TOO_LARGE', '单个附件不能超过 10MB');
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  if (data.length % 4 || /[^A-Za-z0-9+/=]/.test(data) || data.slice(0, data.length - padding).includes('=')) fail('INVALID_BASE64', '附件数据不完整，请重新上传');
  if (padding) {
    const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(data[data.length - padding - 1]);
    if (last < 0 || (padding === 2 ? last & 15 : last & 3)) fail('INVALID_BASE64', '附件数据不完整，请重新上传');
  }
  const size = data.length / 4 * 3 - padding;
  if (size > LIMITS.maxFileBytes) fail('FILE_TOO_LARGE', '单个附件不能超过 10MB');
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length !== size) fail('INVALID_BASE64', '附件数据不完整，请重新上传');
  return buffer;
}

function imageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return 'image/gif';
  return null;
}

class AttachmentStore {
  constructor({ dir }) {
    if (typeof dir !== 'string' || !dir) throw new TypeError('AttachmentStore requires a directory');
    fs.mkdirSync(dir, { recursive: true });
    this.dir = fs.realpathSync(dir);
  }

  _record(id) {
    if (typeof id !== 'string' || !UUID.test(id)) fail('UNKNOWN_ATTACHMENT', '找不到附件，请重新上传');
    const directory = path.join(this.dir, id);
    let record;
    try {
      if (fs.lstatSync(directory).isSymbolicLink() || !within(fs.realpathSync(directory), this.dir)) throw new Error('unsafe directory');
      const manifest = path.join(directory, 'manifest.json');
      const stat = fs.lstatSync(manifest);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('unsafe manifest');
      record = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    } catch { fail('UNKNOWN_ATTACHMENT', '找不到附件，请重新上传'); }
    if (record.version !== 1 || record.id !== id || !/^attachment(?:\.[a-z0-9]{1,16})?$/.test(record.filename)
      || typeof record.name !== 'string' || !Number.isSafeInteger(record.size) || record.size < 0 || record.size > LIMITS.maxFileBytes
      || !/^[a-f0-9]{64}$/.test(record.sha256) || !['image', 'file'].includes(record.kind)
      || (record.kind === 'image' && (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(record.mime) || record.size > LIMITS.maxImageBytes))
      || !['application/octet-stream', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(record.mime)
      || (record.sessionIds != null && (!Array.isArray(record.sessionIds) || record.sessionIds.some(id => typeof id !== 'string')))
      || (record.chatIds != null && (!Array.isArray(record.chatIds) || record.chatIds.some(id => typeof id !== 'string')))) fail('INVALID_ATTACHMENT', '附件记录损坏，请重新上传');
    return record;
  }

  _records() {
    const records = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!UUID.test(name)) continue;
      try { records.push(this._record(name)); } catch { /* Incomplete or damaged uploads are never usable. */ }
    }
    return records;
  }

  _metadata(record) {
    return { id: record.id, name: record.name, mime: record.mime, size: record.size, kind: record.kind, path: path.join(this.dir, record.id, record.filename) };
  }

  _read(record) {
    const file = this._metadata(record).path;
    let buffer;
    try {
      const stat = fs.lstatSync(file), realFile = fs.realpathSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.size || !within(realFile, this.dir) || !within(realFile, path.join(this.dir, record.id))) throw new Error('unsafe file');
      buffer = fs.readFileSync(realFile);
    } catch { fail('INVALID_ATTACHMENT', '附件文件缺失或已改变，请重新上传'); }
    if (buffer.length !== record.size || hash(buffer) !== record.sha256) fail('INVALID_ATTACHMENT', '附件文件已改变，请重新上传');
    return buffer;
  }

  _bind(record, owner) {
    if (!owns(record, owner)) return;
    const sessionIds = [...new Set([record.sessionId, ...(record.sessionIds || []), owner.sessionId].filter(Boolean))];
    const chatIds = [...new Set([record.chatId, ...(record.chatIds || []), owner.chatId].filter(Boolean))];
    if (JSON.stringify(sessionIds) === JSON.stringify(record.sessionIds) && JSON.stringify(chatIds) === JSON.stringify(record.chatIds)) return;
    const updated = { ...record, sessionIds, chatIds };
    const directory = path.join(this.dir, record.id), temporary = path.join(directory, '.manifest-' + crypto.randomUUID());
    try {
      fs.writeFileSync(temporary, JSON.stringify(updated), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, path.join(directory, 'manifest.json'));
      Object.assign(record, updated);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  upload(chat, { requestId, name, data } = {}) {
    const owner = identity(chat);
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(requestId)) fail('INVALID_REQUEST', '上传标识无效，请重新选择附件');
    const buffer = decode(data), mime = imageMime(buffer) || 'application/octet-stream';
    const displayName = cleanName(name), digest = hash(buffer);
    const previous = this._records().find(record => record.requestId === requestId && owns(record, owner));
    if (previous) {
      if (previous.sha256 !== digest || previous.name !== displayName || previous.size !== buffer.length) fail('REQUEST_CONFLICT', '这次上传标识已用于其他文件，请重新选择附件');
      this._read(previous); this._bind(previous, owner);
      return this._metadata(previous);
    }
    const id = crypto.randomUUID(), extension = displayName.match(/\.([a-z0-9]{1,16})$/i);
    const record = { version: 1, id, ...owner, chatIds: owner.chatId ? [owner.chatId] : [], sessionIds: owner.sessionId ? [owner.sessionId] : [],
      requestId, name: displayName, filename: 'attachment' + (extension ? '.' + extension[1].toLowerCase() : ''),
      mime, size: buffer.length, kind: mime.startsWith('image/') && buffer.length <= LIMITS.maxImageBytes ? 'image' : 'file', sha256: digest, createdAt: new Date().toISOString() };
    const temporary = path.join(this.dir, '.upload-' + id), destination = path.join(this.dir, id);
    fs.mkdirSync(temporary);
    try {
      fs.writeFileSync(path.join(temporary, record.filename), buffer, { flag: 'wx', mode: 0o600 });
      fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, destination);
    } catch (error) {
      if (within(temporary, this.dir)) fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
    return this._metadata(record);
  }

  metadata(chat, id) {
    const owner = identity(chat), record = this._record(id);
    if (!owns(record, owner)) fail('WRONG_CHAT', '这个附件不属于当前对话，请重新上传');
    this._read(record); this._bind(record, owner);
    return this._metadata(record);
  }

  metadataForSession(sessionId, id) {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    try {
      const record = this._record(id);
      if (!owns(record, { sessionId })) return null;
      this._read(record);
      return this._metadata(record);
    } catch { return null; }
  }

  prepare(chat, ids) {
    const owner = identity(chat);
    if (!Array.isArray(ids) || ids.length > LIMITS.maxFiles || new Set(ids).size !== ids.length) fail('TOO_MANY_ATTACHMENTS', '每次最多发送 5 个附件，请勿重复选择');
    const records = ids.map(id => {
      const record = this._record(id);
      if (!owns(record, owner)) fail('WRONG_CHAT', '这个附件不属于当前对话，请重新上传');
      return record;
    });
    if (records.reduce((sum, record) => sum + record.size, 0) > LIMITS.maxTotalBytes) fail('TOTAL_TOO_LARGE', '每次发送的附件合计不能超过 12MB');
    const blocks = [];
    for (const record of records) {
      const buffer = this._read(record);
      if (record.kind === 'image') {
        if (imageMime(buffer) !== record.mime) fail('INVALID_ATTACHMENT', '图片附件已改变，请重新上传');
        blocks.push({ type: 'image', source: { type: 'base64', media_type: record.mime, data: buffer.toString('base64') } });
      }
      this._bind(record, owner);
    }
    return { attachments: records.map(record => this._metadata(record)), blocks };
  }

  bindSession(chat, ids) {
    const owner = identity(chat);
    if (!owner.sessionId || !owner.chatId) return;
    const records = ids == null ? this._records() : ids.map(id => this._record(id));
    for (const record of records) {
      if (!owns(record, owner)) {
        if (ids != null) fail('WRONG_CHAT', '这个附件不属于当前对话，请重新上传');
        continue;
      }
      this._bind(record, owner);
    }
  }
}

module.exports = { AttachmentStore, LIMITS };
