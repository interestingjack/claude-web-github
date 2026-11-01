'use strict';
// Turns claude stream-json events into what the phone needs: live text deltas, finished messages, status.
const { recordMessages } = require('./history');

function createState(cwd) {
  return {
    cwd, sessionId: null, model: null, messages: [], streaming: null,
    running: false, interrupted: false, contextUsed: 0, contextWindow: 0, cost: 0,
  };
}

function status(s) {
  return { kind: 'status', running: s.running, contextUsed: s.contextUsed, contextWindow: s.contextWindow, cost: s.cost };
}

function applyEvent(s, ev) {
  if (!ev || ev.parent_tool_use_id) return []; // subagent traffic stays inside its tool card
  switch (ev.type) {
    case 'system':
      if (ev.subtype !== 'init') return [];
      s.sessionId = ev.session_id;
      s.model = ev.model;
      return [{ kind: 'meta', sessionId: s.sessionId, model: s.model }];

    case 'stream_event': {
      const e = ev.event || {};
      if (e.type === 'message_start' && e.message && e.message.usage) {
        const u = e.message.usage;
        s.contextUsed = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        return [status(s)];
      }
      if (e.type === 'content_block_start' && e.content_block) {
        if (e.content_block.type === 'text') { s.streaming = ''; return [{ kind: 'stream_start' }]; }
        if (e.content_block.type === 'thinking') return [{ kind: 'thinking' }];
        return [];
      }
      if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
        s.streaming = (s.streaming || '') + e.delta.text;
        return [{ kind: 'delta', text: e.delta.text }];
      }
      return [];
    }

    case 'assistant':
    case 'user': {
      if (ev.type === 'assistant') s.streaming = null;
      const items = recordMessages({ type: ev.type, uuid: ev.uuid, message: ev.message, timestamp: new Date().toISOString() }, s.cwd);
      if (!items.length) return [];
      s.messages.push(...items);
      return [{ kind: 'messages', items }];
    }

    case 'result': {
      s.running = false;
      s.streaming = null;
      if (typeof ev.total_cost_usd === 'number') s.cost = ev.total_cost_usd;
      const usage = Object.values(ev.modelUsage || {})[0];
      if (usage && usage.contextWindow) s.contextWindow = usage.contextWindow;
      const out = [];
      const stopped = s.interrupted; // an interrupt ends the turn with an error result; "已停止" was already shown
      s.interrupted = false;
      if (ev.is_error && !stopped) {
        const item = { role: 'system', text: `出错了：${ev.result || ev.subtype}`, ts: new Date().toISOString() };
        s.messages.push(item);
        out.push({ kind: 'messages', items: [item] });
      }
      out.push(status(s));
      return out;
    }

    default:
      return [];
  }
}

module.exports = { createState, applyEvent, status };
