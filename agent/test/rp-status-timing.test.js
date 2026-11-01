'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatSession } = require('../chat');
const { applyEvent } = require('../chat-events');
const { RpController } = require('../rp/session');

test('RP commits and publishes this turn variables at its result, before any next user turn', () => {
  const forwarded = [], saved = [];
  const card = { name: 'Status timing fixture', first_mes: 'hello', alternate_greetings: [] };
  const store = {
    getCard: () => card,
    cardDir: () => process.cwd(),
    settings: () => ({ persona: { name: 'User', description: '' }, toggles: {} }),
    booksFor: () => [{ entries: [{ comment: '[InitVar]', content: 'score: 0' }] }],
    saveChat: (id, state) => saved.push({ id, state: structuredClone(state) }),
  };
  const ctl = new RpController({
    store,
    createChat(opts) {
      const chat = new ChatSession({ ...opts, command: 'unused-no-process-is-spawned' });
      // Match agent.addChat: forwarding is registered before the RP observer.
      chat.on('event', event => forwarded.push(structuredClone(event)));
      return chat;
    },
    notify: (_chat, event) => forwarded.push(structuredClone(event)),
  });
  const chat = ctl.newChat({ cardId: 'fixture' });
  chat.state.sessionId = 'isolated-status-timing';
  const accept = event => chat._emit(applyEvent(chat.state, event));

  for (const [turn, before, after] of [[1, 0, 2], [2, 2, 5]]) {
    const start = forwarded.length;
    chat.state.running = true;
    accept({ type: 'user', uuid: `u-${turn}`, message: { role: 'user', content: `turn ${turn}` } });
    accept({ type: 'assistant', uuid: `a-${turn}`, message: { role: 'assistant', content: [
      { type: 'text', text: `reply ${turn}<UpdateVariable>_.set("score", ${before}, ${after});</UpdateVariable>` },
    ] } });
    assert.equal(chat.rp.vars.stat_data.score, before, 'updates wait until the complete reply is available');
    accept({ type: 'result', modelUsage: { fixture: { contextWindow: 200000 } } });

    const events = forwarded.slice(start);
    assert.deepEqual(events.map(event => event.kind), ['messages', 'messages', 'status', 'vars', 'rp']);
    assert.equal(events[2].running, false);
    assert.equal(events[3].vars.stat_data.score, after, 'the same result immediately publishes this turn value');
    assert.equal(events[4].rp.vars.stat_data.score, after, 'the following RP snapshot cannot restore the old value');
    assert.equal(chat.rp.vars.stat_data.score, after);
    assert.equal(saved.at(-1).state.vars.stat_data.score, after, 'history saves the same authoritative value');
    assert.equal(chat.rp.turnText, '', 'processed update commands do not leak into the next turn');
  }
  assert.equal(saved.length, 2);
  assert.equal(chat.proc, null, 'the fixture never starts a real chat process');
});
