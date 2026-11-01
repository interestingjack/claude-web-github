'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('usage reader uses local Claude login and returns quotas without credentials', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-test-'));
  const file = path.join(dir, 'credentials.json');
  t.after(() => { if (path.dirname(dir) === os.tmpdir()) fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'local-test-token', refreshToken: 'never-publish' } }));
  const { readUsage } = require('../usage-publisher');
  const result = await readUsage({ credentialsPath: file, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(options.headers.Authorization, 'Bearer local-test-token');
    return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 7, resets_at: '2026-11-01T02:00:00Z' }, seven_day: { utilization: 11, resets_at: '2026-11-07T02:00:00Z' }, extra_usage: { secret: 'ignore' } }) };
  } });
  assert.deepEqual(result, { status: 'ok', fiveHour: { utilization: 7, resetsAt: '2026-11-01T02:00:00Z' }, sevenDay: { utilization: 11, resetsAt: '2026-11-07T02:00:00Z' } });
  assert.equal(JSON.stringify(result).includes('token'), false);
  const limited = await readUsage({ credentialsPath: file, fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.deepEqual(limited, { status: 'error', error: 'rate_limited' });
  assert.deepEqual(await readUsage({ credentialsPath: path.join(dir, 'missing.json') }), { status: 'error', error: 'auth_required' });
});
