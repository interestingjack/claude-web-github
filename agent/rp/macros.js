'use strict';
// SillyTavern-style {{macros}}. Unknown macros are left untouched.
const yaml = require('js-yaml');
const { toPath } = require('./mvu');

function getPath(obj, p) {
  for (const k of toPath(p)) { if (obj == null) return undefined; obj = obj[k]; }
  return obj;
}
const show = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function roll(spec, rng) {
  const m = /^(\d*)d(\d+)$/i.exec(spec.trim());
  if (!m) return null;
  let total = 0;
  for (let i = 0; i < (Number(m[1]) || 1); i++) total += 1 + Math.floor(rng() * Number(m[2]));
  return String(total);
}

// ctx: { char, user, persona, card, vars, lastUserMessage, lastCharMessage, rng }
function replaceMacros(text, ctx = {}) {
  if (!text) return '';
  const rng = ctx.rng || Math.random;
  const card = ctx.card || {};
  const s = String(text).replace(/<USER>/gi, ctx.user || '').replace(/<(BOT|CHAR)>/gi, ctx.char || '');
  return s.replace(/\{\{([\s\S]*?)\}\}/g, (all, inner) => {
    const body = inner.trim();
    if (body.startsWith('//')) return '';
    const [name, ...rest] = body.split('::');
    const arg = rest.join('::');
    switch (name.trim().toLowerCase()) {
      case 'char': return ctx.char || '';
      case 'user': return ctx.user || '';
      case 'persona': return ctx.persona || '';
      case 'description': return card.description || '';
      case 'personality': return card.personality || '';
      case 'scenario': return card.scenario || '';
      case 'getvar':
      case 'getglobalvar':
      case 'get_message_variable':
      case 'get_chat_variable':
        return show(getPath(ctx.vars, arg));
      case 'format_message_variable':
      case 'format_chat_variable': {
        const v = getPath(ctx.vars, arg);
        return v == null ? '' : typeof v === 'object' ? yaml.dump(v, { lineWidth: -1 }).trimEnd() : String(v);
      }
      case 'random': if (rest.length) return rest[Math.floor(rng() * rest.length)]; break;
      case 'roll': if (rest.length) return roll(arg, rng) ?? all; break;
      case 'lastusermessage': return ctx.lastUserMessage || '';
      case 'lastcharmessage': return ctx.lastCharMessage || '';
      case 'newline': return '\n';
      case 'trim': return '';
      case 'time': return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      case 'date': return new Date().toLocaleDateString('zh-CN');
      case 'weekday': return new Date().toLocaleDateString('zh-CN', { weekday: 'long' });
      default: break;
    }
    let m = /^random\s*:\s*([\s\S]*)$/i.exec(body);
    if (m) { const c = m[1].split(','); return c[Math.floor(rng() * c.length)].trim(); }
    m = /^roll\s*:\s*(.+)$/i.exec(body);
    if (m) return roll(m[1], rng) ?? all;
    return all;
  });
}

module.exports = { replaceMacros, getPath };
