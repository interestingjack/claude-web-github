'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');

test('hot update preserves an already connected device and the running login handler', async (t) => {
  const root = path.resolve(__dirname, '..');
  let authenticated = true;
  const original = (req, res) => {
    if (req.url === '/api/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ authed: authenticated && req.headers.cookie === 'crs=existing-login' }));
    }
    res.writeHead(200); res.end('old page');
  };
  const server = https.createServer({ key: fs.readFileSync(path.join(root, 'certs/server.key')), cert: fs.readFileSync(path.join(root, 'certs/server.crt')) }, original);
  const wss = new WebSocketServer({ server });
  wss.on('connection', socket => socket.on('message', data => socket.send(data)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => { wss.close(); server.close(); });
  const phone = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  t.after(() => phone.terminate());
  await once(phone, 'open');
  let disconnects = 0;
  phone.on('close', () => disconnects++);
  const get = (url, headers = {}) => new Promise((resolve, reject) => {
    https.get({ hostname: '127.0.0.1', port, path: url, rejectUnauthorized: false, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    }).on('error', reject);
  });
  assert.equal((await get('/')).body, 'old page');
  const { install, rollback } = require('../hot-update');
  install(server, { agentToken: 'test-only-agent' });
  const pong = once(phone, 'message');
  phone.send('still connected after update');
  assert.equal(String((await pong)[0]), 'still connected after update');
  assert.equal(disconnects, 0);
  assert.ok((await get('/', { Cookie: 'crs=existing-login' })).body.includes('name="session-authenticated" content="true"'));
  authenticated = false;
  assert.ok((await get('/', { Cookie: 'crs=existing-login' })).body.includes('name="session-authenticated" content="false"'));
  assert.equal((await get('/api/me', { Cookie: 'crs=existing-login' })).body, '{"authed":false}');
  install(server, { agentToken: 'test-only-agent' }); // Installing a second release must not stack request listeners.
  assert.equal(server.listeners('request').length, 1);
  rollback(server);
  assert.equal((await get('/')).body, 'old page');
  assert.equal(disconnects, 0);
});
