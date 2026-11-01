'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createAsset, sendAsset } = require('./static-assets');

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
};

function createStaticHandler(isAuthed) {
  const files = {
    '/assets/app.js': ['public/app.js', 'application/javascript'],
    '/assets/file-paths.js': ['public/file-paths.js', 'application/javascript'],
    '/assets/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
    '/vendor/marked.js': ['node_modules/marked/lib/marked.umd.js', 'application/javascript'],
    '/vendor/purify.js': ['node_modules/dompurify/dist/purify.min.js', 'application/javascript'],
    '/vendor/jquery.js': ['node_modules/jquery/dist/jquery.min.js', 'application/javascript'],
    '/vendor/lodash.js': ['node_modules/lodash/lodash.min.js', 'application/javascript'],
  };
  const assets = new Map(Object.entries(files).map(([url, [file, type]]) =>
    [url, createAsset(fs.readFileSync(path.join(__dirname, file)), type)]));
  // A single script avoids extra mobile TLS connections while preserving source files for maintenance.
  assets.set('/assets/app.js', createAsset(Buffer.concat([
    assets.get('/vendor/marked.js').bodies.identity, Buffer.from('\n;\n'),
    assets.get('/vendor/purify.js').bodies.identity, Buffer.from('\n;\n'),
    assets.get('/assets/file-paths.js').bodies.identity, Buffer.from('\n;\n'),
    assets.get('/assets/app.js').bodies.identity,
  ]), 'application/javascript'));
  const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8')
    .replace(/(src|href)="(\/(?:assets|vendor)\/[^"?]+)"/g, (tag, attr, url) => {
      const asset = assets.get(url);
      return asset ? `${attr}="${url}?v=${asset.version}"` : tag;
    });
  const pages = [false, true].map(authed => createAsset(
    html.replace('__SESSION_AUTH__', String(authed)), 'text/html; charset=utf-8', 'no-store'));
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const url = new URL(req.url, 'https://local');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      sendAsset(req, res, pages[isAuthed(req) ? 1 : 0], SEC_HEADERS);
      return true;
    }
    const asset = assets.get(url.pathname);
    if (!asset) return false;
    const cache = url.searchParams.get('v') === asset.version ? 'public, max-age=31536000, immutable' : asset.cacheControl;
    sendAsset(req, res, asset, { ...SEC_HEADERS, 'Cache-Control': cache });
    return true;
  };
}

module.exports = { createStaticHandler, SEC_HEADERS };
