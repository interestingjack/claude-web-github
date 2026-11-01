'use strict';
const crypto = require('node:crypto');
const zlib = require('node:zlib');

// Prepared once at startup: neither disk reads nor compression block a phone request.
function createAsset(body, type, cacheControl = 'public, max-age=0, must-revalidate') {
  body = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const version = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
  return {
    type, cacheControl, version, etag: `W/"${version}"`,
    bodies: {
      identity: body,
      br: zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }),
      gzip: zlib.gzipSync(body, { level: 6 }),
    },
  };
}

function encodingFor(header = '') {
  const values = new Map(header.toLowerCase().split(',').map(part => {
    const [name, ...params] = part.trim().split(';');
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    return [name, q ? Number(q.slice(2)) || 0 : 1];
  }));
  const quality = name => values.has(name) ? values.get(name) : (values.get('*') || 0);
  const br = quality('br'), gzip = quality('gzip');
  if (br > 0 && br >= gzip) return 'br';
  return gzip > 0 ? 'gzip' : 'identity';
}

function sendAsset(req, res, asset, headers = {}) {
  const encoding = encodingFor(req.headers['accept-encoding']);
  const body = asset.bodies[encoding];
  const out = { 'Content-Type': asset.type, 'Cache-Control': asset.cacheControl, Vary: 'Accept-Encoding', ...headers };
  if (encoding !== 'identity') out['Content-Encoding'] = encoding;
  if (asset.cacheControl !== 'no-store') {
    out.ETag = asset.etag;
    const match = (req.headers['if-none-match'] || '').split(',').map(s => s.trim());
    if (match.includes('*') || match.some(s => s.replace(/^W\//, '') === asset.etag.replace(/^W\//, ''))) {
      res.writeHead(304, out);
      return res.end();
    }
  }
  res.writeHead(200, { ...out, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

module.exports = { createAsset, sendAsset };
