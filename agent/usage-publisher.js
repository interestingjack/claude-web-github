'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const https = require('node:https');

async function readUsage({ credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json'), fetchImpl = fetch } = {}) {
  let oauth;
  try { oauth = JSON.parse(await fs.promises.readFile(credentialsPath, 'utf8')).claudeAiOauth; } catch { /* not logged in */ }
  if (!oauth?.accessToken) return { status: 'error', error: 'auth_required' };
  try {
    const response = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-web-usage/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { status: 'error', error: response.status === 429 ? 'rate_limited' : [401, 403].includes(response.status) ? 'auth_required' : 'network' };
    const data = await response.json();
    const windowValue = value => value && Number.isFinite(value.utilization)
      ? { utilization: value.utilization, resetsAt: Number.isFinite(Date.parse(value.resets_at)) ? value.resets_at : null } : null;
    if (!('five_hour' in data) && !('seven_day' in data)) return { status: 'error', error: 'unsupported' };
    // Only quota numbers and reset times leave the computer. Never publish tokens or the raw API response.
    return { status: 'ok', fiveHour: windowValue(data.five_hour), sevenDay: windowValue(data.seven_day) };
  } catch { return { status: 'error', error: 'network' }; }
}

function start({ cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) } = {}) {
  const ca = fs.readFileSync(path.join(__dirname, cfg.caFile));
  const origin = new URL(cfg.relayUrl.replace(/^wss:/, 'https:'));
  const lock = net.createServer();
  let stopped = false;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function relay(route, body) {
    return new Promise((resolve, reject) => {
      const req = https.request(new URL(route, origin), {
        method: body ? 'POST' : 'GET', ca,
        headers: { Authorization: `Bearer ${cfg.agentToken}`, 'Content-Type': 'application/json' },
      }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; if (text.length > 65536) req.destroy(new Error('Invalid relay response')); });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error('Usage relay unavailable'));
          try { resolve(JSON.parse(text)); } catch { reject(new Error('Invalid relay response')); }
        });
      });
      req.setTimeout(35000, () => req.destroy(new Error('Usage relay timeout')));
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  async function run() {
    let lastCheck = 0, retry = 1000, cooldown = 10000;
    while (!stopped) {
      try {
        const task = await relay(`/api/usage/next?wait=${Math.max(1, Math.min(25000, lastCheck + 60000 - Date.now()))}`);
        if (task.refresh || Date.now() - lastCheck >= 60000) {
          if (Date.now() - lastCheck < cooldown) await sleep(cooldown - (Date.now() - lastCheck));
          if (stopped) break;
          const usage = await readUsage();
          lastCheck = Date.now(); cooldown = usage.error === 'rate_limited' ? 60000 : 10000;
          await relay('/api/usage/update', usage);
        }
        retry = 1000;
      } catch {
        await sleep(retry); retry = Math.min(60000, retry * 2);
      }
    }
  }
  lock.on('error', () => { stopped = true; }); // The standalone helper and agent share a single instance.
  lock.listen(process.platform === 'win32' ? '\\\\.\\pipe\\claude-web-usage' : path.join(os.tmpdir(), 'claude-web-usage.sock'), () => { void run(); });
  return { stop() { stopped = true; lock.close(); } };
}

module.exports = { readUsage, start };
if (require.main === module) start();
