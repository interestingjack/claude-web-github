'use strict';
const zlib = require('node:zlib');
const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0); chunk.write(type, 4, 4, 'ascii'); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}
function validateAvatar(buf) {
  if (!Buffer.isBuffer(buf) || buf.length > 2 * 1024 * 1024 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('头像必须是有效 PNG 图片，且不超过 2MB');
  let width = 0, height = 0, channels = 0, ended = false;
  const idat = [];
  for (let offset = 8; offset < buf.length;) {
    if (offset + 12 > buf.length) throw new Error('PNG 图片不完整');
    const size = buf.readUInt32BE(offset), end = offset + size + 12;
    if (end > buf.length) throw new Error('PNG 图片不完整');
    const type = buf.toString('ascii', offset + 4, offset + 8), data = buf.subarray(offset + 8, end - 4);
    if (crc32(buf.subarray(offset + 4, end - 4)) !== buf.readUInt32BE(end - 4)) throw new Error('PNG 图片校验失败');
    if (offset === 8 && type !== 'IHDR') throw new Error('PNG 图片缺少尺寸');
    if (type === 'IHDR') {
      if (width || size !== 13) throw new Error('PNG 图片格式不正确');
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (!width || !height || width > 1024 || height > 1024 || data[8] !== 8 || !channels || data[10] || data[11] || data[12]) throw new Error('头像图片格式或尺寸不受支持');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { if (size || end !== buf.length) throw new Error('PNG 图片结尾不正确'); ended = true; }
    offset = end;
  }
  if (!ended || !idat.length) throw new Error('PNG 图片不完整');
  let pixels;
  try { pixels = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: 5 * 1024 * 1024 }); } catch { throw new Error('PNG 图片无法解码'); }
  if (pixels.length !== height * (1 + width * channels)) throw new Error('PNG 图片像素不完整');
  return { width, height };
}
module.exports = { validateAvatar, pngChunk };
