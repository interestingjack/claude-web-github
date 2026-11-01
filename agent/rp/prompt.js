'use strict';
// Builds what Claude sees in RP mode: a system prompt file (card, persona, constant lore) and,
// for every user message, a <rp_context> block (triggered lore, @depth notes, variables).
const yaml = require('js-yaml');
const { activate } = require('./worldinfo');
const { replaceMacros } = require('./macros');

const RP_RULES = `# 角色扮演模式
你将以「{{char}}」的身份和{{user}}进行角色扮演，下面是角色卡和世界设定。
- 始终保持角色，用{{char}}的口吻、动作和心理来写；不要替{{user}}说话，也不要替{{user}}决定行动。
- 用户消息前面可能带有 <rp_context> 区块，里面是这一轮触发的世界设定、当前变量和写作要求。照着写，但回复里不要提到这个区块。
- 你仍然可以使用工具（读写文件、执行命令、搜索等）。需要时直接使用，正文里不要描述工具调用的过程。
- 设定里如果要求输出变量更新（<UpdateVariable>），按要求放在回复末尾。`;

const greetingOf = (card, i) => (i > 0 ? card.alternate_greetings[i - 1] : card.first_mes) || card.first_mes || '';

function macroCtx({ card, persona, vars, history }) {
  return {
    char: card.name, user: (persona && persona.name) || '用户', persona: persona && persona.description,
    card, vars, lastUserMessage: history && history[0],
  };
}

function section(title, body) {
  const b = (body || '').trim();
  return b ? `## ${title}\n${b}` : '';
}

function buildSystemPrompt({ card, persona, books, toggles, greeting = 0, vars = {} }) {
  const ctx = macroCtx({ card, persona, vars });
  const m = (s) => replaceMacros(s || '', ctx).trim();
  // no messages scanned: only constant entries fire; rng 0 keeps probabilistic constants in
  const lore = activate(books, { messages: [], toggles, rng: () => 0 });
  const join = (list) => list.map((e) => m(e.content)).filter(Boolean).join('\n\n');
  const examples = m(card.mes_example).replace(/^<START>\s*$/gim, '---').trim();
  return [
    m(RP_RULES),
    section('卡片指令', m(card.system_prompt)),
    section('世界设定', join(lore.before)),
    section(`${card.name} 的设定`, m(card.description)),
    section('性格', m(card.personality)),
    section('场景', m(card.scenario)),
    section('补充设定', join([...lore.after, ...lore.other])),
    section(`${ctx.user} 的设定`, m(persona && persona.description)),
    section('示例对话（只参考写法，不是真实发生的对话）', examples),
    section(`开场白（${card.name} 已经说过这段话，对话从这里开始）`, m(greetingOf(card, greeting))),
  ].filter(Boolean).join('\n\n');
}

function buildTurn({ card, persona, books, toggles, history = [], vars = {}, userText, rng }) {
  const ctx = macroCtx({ card, persona, vars, history });
  const m = (s) => replaceMacros(s || '', ctx).trim();
  const lore = activate(books, { messages: history, toggles, rng });
  const triggered = [...lore.before, ...lore.after, ...lore.other].filter((e) => !e.constant);
  const notes = lore.depth.map((e) => m(e.content));
  if (card.depth_prompt) notes.push(m(card.depth_prompt.prompt));
  const stat = vars && (vars.stat_data || (Object.keys(vars).length ? vars : null));
  const parts = [
    triggered.length ? `[世界设定]\n${triggered.map((e) => m(e.content)).join('\n\n')}` : '',
    notes.filter(Boolean).length ? `[写作提示]\n${notes.filter(Boolean).join('\n\n')}` : '',
    stat && Object.keys(stat).length ? `[当前变量]\n${yaml.dump(stat, { lineWidth: -1 }).trimEnd()}` : '',
    card.post_history_instructions ? `[回复要求]\n${m(card.post_history_instructions)}` : '',
  ].filter(Boolean);
  if (!parts.length) return userText;
  return `<rp_context>\n${parts.join('\n\n')}\n</rp_context>\n\n${userText}`;
}

const stripTurnContext = (t) => String(t).replace(/^\s*<rp_context>[\s\S]*?<\/rp_context>\s*/, '');

module.exports = { buildSystemPrompt, buildTurn, stripTurnContext, greetingOf };
