'use strict';
const crypto = require('node:crypto');
const { SEC_HEADERS } = require('./http-assets');

function createUsageState() { return { value: null, requested: false, worker: null, readers: new Set() }; }
function createUsageHandler({ isAuthed, agentToken, state = createUsageState() }) {
  const json = (res, status, body) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const agentAuth = req => {
    const hash = text => crypto.createHash('sha256').update(text).digest();
    return !!agentToken && crypto.timingSafeEqual(hash(req.headers.authorization || ''), hash(`Bearer ${agentToken}`));
  };
  const view = () => !state.value ? { status: 'loading', fiveHour: null, sevenDay: null, updatedAt: null }
    : Date.now() - state.value.checkedAt > 75000 ? { ...state.value, status: 'error', error: 'computer_offline' } : state.value;
  function wait(res, timeout, done) {
    const finish = value => { clearTimeout(timer); res.off('close', closed); done(finish); json(res, 200, value); };
    const closed = () => { clearTimeout(timer); done(finish); };
    const timer = setTimeout(() => finish(timeout.value()), timeout.ms);
    res.once('close', closed);
    return finish;
  }
  function wake() {
    state.requested = true;
    if (state.worker) { state.requested = false; state.worker({ refresh: true }); }
  }
  function windowValue(value) {
    if (!value || !Number.isFinite(value.utilization) || value.utilization < 0 || value.utilization > 1000) return null;
    return { utilization: value.utilization, resetsAt: Number.isFinite(Date.parse(value.resetsAt)) ? value.resetsAt : null };
  }
  return (req, res) => {
    const url = new URL(req.url, 'https://local');
    if (!['/api/usage', '/api/usage/next', '/api/usage/update'].includes(url.pathname)) return false;
    if (url.pathname === '/api/usage') {
      if (!isAuthed(req)) { json(res, 401, { error: 'login_required' }); return true; }
      if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }); return true; }
      const age = Date.now() - (state.value?.checkedAt || 0);
      const ttl = url.searchParams.get('refresh') === '1' ? 10000 : 60000;
      if (age < ttl) json(res, 200, view());
      else {
        const reader = wait(res, { ms: 8000, value: view }, finish => state.readers.delete(finish));
        state.readers.add(reader); wake();
      }
      return true;
    }
    if (!agentAuth(req)) { json(res, 401, { error: 'agent_auth_required' }); return true; }
    if (url.pathname === '/api/usage/next' && req.method === 'GET') {
      if (state.requested || Date.now() - (state.value?.checkedAt || 0) >= 60000) {
        state.requested = false; json(res, 200, { refresh: true });
      } else {
        if (state.worker) state.worker({ refresh: false });
        const ms = Math.max(1, Math.min(25000, Number(url.searchParams.get('wait')) || 25000));
        state.worker = wait(res, { ms, value: () => ({ refresh: false }) }, finish => { if (state.worker === finish) state.worker = null; });
      }
      return true;
    }
    if (url.pathname === '/api/usage/update' && req.method === 'POST') {
      let body = '', size = 0;
      req.on('data', chunk => { size += chunk.length; if (size <= 16384) body += chunk; });
      req.on('end', () => {
        if (size > 16384) return json(res, 413, { error: 'too_large' });
        let data; try { data = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid_json' }); }
        if (!data || !['ok', 'error'].includes(data.status)) return json(res, 400, { error: 'invalid_usage' });
        const now = Date.now(), ok = data.status === 'ok';
        state.value = {
          status: data.status,
          fiveHour: ok ? windowValue(data.fiveHour) : (state.value?.fiveHour || null),
          sevenDay: ok ? windowValue(data.sevenDay) : (state.value?.sevenDay || null),
          updatedAt: ok ? now : (state.value?.updatedAt || null), checkedAt: now,
          error: ok ? null : (['auth_required', 'rate_limited', 'network', 'unsupported'].includes(data.error) ? data.error : 'network'),
        };
        state.requested = false;
        for (const reader of [...state.readers]) reader(view());
        json(res, 200, { ok: true });
      });
      return true;
    }
    json(res, 405, { error: 'method_not_allowed' });
    return true;
  };
}

module.exports = { createUsageState, createUsageHandler };
