'use strict';
const { createStaticHandler } = require('./http-assets');
const { createUsageHandler, createUsageState } = require('./usage-channel');
const fs = require('node:fs');
const path = require('node:path');
const KEY = Symbol.for('claude-relay.http-assets');

// Update only HTTP delivery. Never close/listen, replace upgrade handlers, or touch agent/client sockets.
function install(server, options = {}) {
  if (!server || typeof server.setSecureContext !== 'function' || !server.listening) throw new Error('Expected a running HTTPS relay');
  let state = server[KEY];
  if (!state && server.listeners('request').length !== 1) throw new Error('Unexpected HTTP handlers; refusing to change them');
  const original = state ? state.original : server.listeners('request')[0];
  // Ask the existing in-memory login handler. Do not create a second session store.
  const isAuthed = req => {
    let authed = false;
    original.call(server, { method: 'GET', url: '/api/me', headers: req.headers }, {
      writeHead() {},
      end(body) { authed = JSON.parse(String(body)).authed === true; },
    });
    return authed;
  };
  const usageState = state?.usageState || createUsageState();
  const agentToken = options.agentToken || JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).agentToken;
  const staticHandler = createStaticHandler(isAuthed);
  const usageHandler = createUsageHandler({ isAuthed, agentToken, state: usageState });
  const handler = (req, res) => usageHandler(req, res) || staticHandler(req, res);
  if (state) state.serve = handler;
  else {
    state = { original, serve: handler, dispatch: null };
    state.dispatch = (req, res) => { if (!state.serve(req, res)) original.call(server, req, res); };
    server[KEY] = state;
    server.removeListener('request', original);
    server.on('request', state.dispatch);
  }
  state.usageState = usageState;
  return { updated: true, pid: process.pid, port: server.address().port };
}

function rollback(server) {
  const state = server[KEY];
  if (!state) return false;
  server.removeListener('request', state.dispatch);
  server.on('request', state.original);
  delete server[KEY];
  return true;
}

module.exports = { install, rollback };
