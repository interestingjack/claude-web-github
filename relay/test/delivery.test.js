'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const net = require('node:net');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '..');
let dir, child, port;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-relay-test-'));
  for (const name of ['relay.js', 'static-assets.js', 'http-assets.js', 'usage-channel.js', 'public', 'certs']) {
    if (fs.existsSync(path.join(root, name))) fs.cpSync(path.join(root, name), path.join(dir, name), { recursive: true });
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, password: 'test-only-password', agentToken: 'test-only-agent', cert: 'certs/server.crt', key: 'certs/server.key', ca: 'certs/ca.crt' }));
  child = spawn(process.execPath, ['relay.js'], { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Relay did not start')), 10000);
    let output = '';
    child.stdout.on('data', data => { if (String(data).includes('relay listening')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', data => { output += data; });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Relay exited ${code}: ${output}`)); });
  });
});
after(async () => {
  if (child && child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; }
  if (dir && path.dirname(path.resolve(dir)) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('claude-relay-test-')) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function request(url = '/', headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port, path: url, method: body ? 'POST' : 'GET', rejectUnauthorized: false, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('phone receives compressed HTML with an identical decoded page', async () => {
  const plain = await request();
  const br = await request('/', { 'Accept-Encoding': 'gzip, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.deepEqual(zlib.brotliDecompressSync(br.body), plain.body);
  assert.ok(br.body.length < plain.body.length * 0.5);
  const gzip = await request('/', { 'Accept-Encoding': 'br;q=0, gzip;q=1' });
  assert.equal(gzip.headers['content-encoding'], 'gzip');
  assert.deepEqual(zlib.gunzipSync(gzip.body), plain.body);
  assert.equal(br.headers['cache-control'], 'no-store');
});

test('page carries session state and versioned reusable scripts/styles', async () => {
  const anon = await request();
  assert.match(anon.body.toString(), /name="session-authenticated" content="false"/);
  const login = await request('/api/login', { 'Content-Type': 'application/json' }, JSON.stringify({ password: 'test-only-password' }));
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const signedIn = await request('/', { Cookie: cookie });
  const html = signedIn.body.toString();
  assert.match(html, /name="session-authenticated" content="true"/);
  assert.equal(signedIn.headers['cache-control'], 'no-store');
  const urls = [...html.matchAll(/(?:src|href)="((?:\/assets|\/vendor)\/[^" ]+)"/g)].map(m => m[1]);
  assert.equal(urls.length, 2);
  for (const url of urls) {
    assert.match(url, /\?v=[a-f0-9]{16}$/);
    const asset = await request(url, { 'Accept-Encoding': 'br' });
    assert.equal(asset.status, 200);
    assert.match(asset.headers['cache-control'], /immutable/);
    const cached = await request(url, { 'If-None-Match': asset.headers.etag });
    assert.equal(cached.status, 304);
    assert.equal(cached.body.length, 0);
    const unversioned = await request(url.split('?')[0]);
    assert.match(unversioned.headers['cache-control'], /must-revalidate/);
  }
  await request('/api/logout', { Cookie: cookie }, '{}');
  assert.match((await request('/', { Cookie: cookie })).body.toString(), /name="session-authenticated" content="false"/);
});

test('chat snapshots arrive intact and the existing heartbeat protocol still works', async (t) => {
  const login = await request('/api/login', { 'Content-Type': 'application/json' }, JSON.stringify({ password: 'test-only-password' }));
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const agent = new WebSocket(`wss://127.0.0.1:${port}/ws/agent`, { rejectUnauthorized: false, headers: { Authorization: 'Bearer test-only-agent' } });
  t.after(() => agent.terminate());
  await once(agent, 'open');
  const phone = new WebSocket(`wss://127.0.0.1:${port}/ws/client`, { rejectUnauthorized: false, origin: `https://127.0.0.1:${port}`, headers: { Cookie: cookie } });
  t.after(() => phone.terminate());
  const online = once(phone, 'message');
  await once(phone, 'open');
  await online;
  const forwarded = once(agent, 'message');
  phone.send(JSON.stringify({ type: 'open', hid: 'test-session' }));
  const envelope = JSON.parse((await forwarded)[0]);
  assert.equal(envelope.msg.hid, 'test-session');
  const msg = { type: 'chat', messages: [{ role: 'assistant', text: '手机恢复聊天测试。'.repeat(8000) }] };
  const snapshot = once(phone, 'message');
  agent.send(JSON.stringify({ to: envelope.from, msg }));
  assert.deepEqual(JSON.parse((await snapshot)[0]), msg);
  const pong = once(phone, 'message');
  phone.send(JSON.stringify({ type: 'ping' }));
  assert.equal(JSON.parse((await pong)[0]).type, 'pong');
});

test('account usage requires login, wakes the computer and only returns approved quota fields', async () => {
  assert.equal((await request('/api/usage')).status, 401);
  assert.equal((await request('/api/usage/update', {}, '{}')).status, 401);
  const login = await request('/api/login', { 'Content-Type': 'application/json' }, JSON.stringify({ password: 'test-only-password' }));
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const phone = request('/api/usage', { Cookie: cookie });
  const task = await request('/api/usage/next?wait=1000', { Authorization: 'Bearer test-only-agent' });
  assert.equal(JSON.parse(task.body).refresh, true);
  const data = { status: 'ok', fiveHour: { utilization: 7, resetsAt: '2026-11-01T02:00:00Z' }, sevenDay: { utilization: 11, resetsAt: '2026-11-07T02:00:00Z' }, accessToken: 'must-never-reach-the-browser' };
  assert.equal((await request('/api/usage/update', { Authorization: 'Bearer test-only-agent' }, JSON.stringify(data))).status, 200);
  const result = JSON.parse((await phone).body);
  assert.equal(result.status, 'ok');
  assert.equal(result.fiveHour.utilization, 7);
  assert.equal(result.sevenDay.utilization, 11);
  assert.equal(result.accessToken, undefined);
  assert.ok(result.updatedAt);
  assert.equal((await request('/api/usage', { Cookie: cookie })).status, 200);
  await request('/api/usage/update', { Authorization: 'Bearer test-only-agent' }, JSON.stringify({ status: 'error', error: 'rate_limited', accessToken: 'not-returned' }));
  const stale = JSON.parse((await request('/api/usage', { Cookie: cookie })).body);
  assert.equal(stale.status, 'error');
  assert.equal(stale.fiveHour.utilization, 7, 'temporary errors retain the last known quota');
  assert.equal(stale.error, 'rate_limited');
});
