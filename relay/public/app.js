(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // ---------- state ----------
  let ws = null, agentOnline = false, retry = 0, retryTimer = null;
  let connectTimer = null, pongTimer = null;
  let contextPopoverTimer = null;
  let lastUserCommand = '';
  let accountUsage = null, usageLoading = false;
  let rpEditor = null, avatarUpload = null;
  let folderBrowser = null, bookEntryFocus = null, bookEntryView = null;
  let chats = [], historyList = [], defaultCwd = '', src = 'all';
  let chat = null;          // current chat info from agent
  let readonly = false;
  let streamEl = null, streamText = '', thinkingEl = null, lastTool = null;
  let wantOpen = store.get('open', null); // { chatId } or { hid } to reopen after reconnect

  // ---------- markdown ----------
  marked.setOptions({ gfm: true, breaks: true });
  const escapeCodeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  marked.use({ renderer: { code(token) {
    const opening = token.raw.match(/^ {0,3}(`{3,}|~{3,})[^\n]*\n/);
    const closing = opening && token.raw.slice(opening[0].length).match(new RegExp(`(?:^|\\n) {0,3}${opening[1][0]}{${opening[1].length},}[ \\t]*(?:\\n)?$`));
    // Marked removes the newline before a closing fence; keep it and any extra blank lines for copying.
    const text = token.text + (closing?.[0].startsWith('\n') ? '\n' : '');
    const language = (token.lang || '').split(/\s/)[0];
    return `<pre><code${language ? ` class="language-${escapeCodeHtml(language)}"` : ''}>${escapeCodeHtml(text)}</code></pre>\n`;
  } } });
  DOMPurify.addHook('afterSanitizeAttributes', (n) => {
    if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
  });
  function md(text, localFiles = false) {
    let markup = marked.parse(text || '');
    if (localFiles && window.ClaudeFilePaths) {
      const template = document.createElement('template'); template.innerHTML = markup;
      for (const link of template.content.querySelectorAll('a[href]')) {
        const file = window.ClaudeFilePaths.pathFromHref(link.getAttribute('href'));
        if (file) { link.dataset.localFile = file; link.setAttribute('href', '#'); }
      }
      markup = template.innerHTML;
    }
    return DOMPurify.sanitize(markup);
  }
  function addCodeCopyButtons(container) {
    for (const code of container.querySelectorAll('pre > code')) {
      const pre = code.parentElement;
      if (pre.parentElement.classList.contains('code-block')) continue;
      const block = el('div', 'code-block'), toolbar = el('div', 'code-toolbar');
      const button = el('button', 'code-copy', '复制'); button.type = 'button';
      button.setAttribute('aria-label', '复制代码块');
      toolbar.appendChild(button); pre.replaceWith(block); block.append(toolbar, pre);
    }
  }

  // ---------- helpers ----------
  let toastTimer;
  function toast(text) {
    const t = $('toast');
    t.textContent = text; t.classList.remove('hidden'); t.style.opacity = 1;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.opacity = 0; setTimeout(() => t.classList.add('hidden'), 300); }, 2400);
  }
  function send(obj) { if (!ws || ws.readyState !== 1) return false; ws.send(JSON.stringify(obj)); return true; }
  function baseName(p) { return (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p || ''; }
  function splitPath(p) { const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')); return [p.slice(0, i), p.slice(i + 1)]; }
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return '刚刚';
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
    return new Date(t).toLocaleDateString();
  }
  async function copyText(text, label) {
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      try { copied = document.execCommand('copy'); } catch { /* Browser denied both clipboard methods. */ }
      finally { ta.remove(); }
    }
    if (!copied) { toast('复制失败，请长按文字手动复制'); return false; }
    toast(`已复制${label || ''}`);
    return true;
  }

  // ---------- iOS viewport / keyboard ----------
  const app = $('app');
  function syncChromeInsets() {
    if (app.classList.contains('hidden')) return;
    const header = app.querySelector(':scope > .top'), composer = app.querySelector(':scope > .composer');
    if (!header || !composer) return;
    const headerBottom = Math.max(0, header.getBoundingClientRect().bottom - app.getBoundingClientRect().top);
    const banner = $('banner');
    const bannerHeight = banner.classList.contains('hidden') ? 0 : banner.offsetHeight + 10;
    app.style.setProperty('--nav-bottom', `${Math.ceil(headerBottom + 10)}px`);
    app.style.setProperty('--chrome-top', `${Math.ceil(headerBottom + 14 + bannerHeight)}px`);
    app.style.setProperty('--chrome-bottom', `${Math.ceil(composer.getBoundingClientRect().height + 22)}px`);
  }
  function layout() {
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    app.style.height = height + 'px';
    app.style.setProperty('--viewport-height', height + 'px');
    app.style.top = (vv ? vv.offsetTop : 0) + 'px';
    app.classList.toggle('kb', vv ? window.innerHeight - vv.height > 120 : false);
    syncChromeInsets();
    positionContextPopover();
  }
  if (window.ResizeObserver) {
    const chromeObserver = new ResizeObserver(() => {
      const stick = nearBottom();
      syncChromeInsets();
      if (stick) requestAnimationFrame(scrollBottom);
      positionContextPopover();
    });
    for (const node of [app.querySelector(':scope > .top'), app.querySelector(':scope > .composer'), $('banner')]) {
      if (node) chromeObserver.observe(node);
    }
  }
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', () => { const b = nearBottom(); layout(); if (b) scrollBottom(); });
    visualViewport.addEventListener('scroll', layout);
  }
  window.addEventListener('resize', layout);

  // ---------- login ----------
  async function checkAuth() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch('/api/me', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) return null;
      const result = await response.json();
      return typeof result.authed === 'boolean' ? result.authed : null;
    } catch { return null; } // An unreachable network does not mean the login expired.
    finally { clearTimeout(timeout); }
  }
  function showLogin() { $('app').classList.add('hidden'); $('login').classList.remove('hidden'); }
  function showApp() { $('login').classList.add('hidden'); $('app').classList.remove('hidden'); layout(); }
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginErr').textContent = '';
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('pw').value }) }).catch(() => null);
    if (!r) return ($('loginErr').textContent = '网络错误');
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return ($('loginErr').textContent = j.error || '登录失败');
    $('pw').value = '';
    showApp(); connect();
  });
  $('logoutBtn').onclick = async () => {
    if (!confirm('退出登录？')) return;
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  };

  // ---------- websocket ----------
  function setOnline(on) {
    agentOnline = on;
    $('agentDot').classList.toggle('off', !on);
    $('agentText').textContent = on ? '电脑已连接' : '电脑未连接';
    updateBanner();
    updateSend();
    updateRpEditor();
    renderAvatarControl();
    if (folderBrowser) {
      if (!on) failFolderBrowser('电脑连接已断开，连接恢复后可重新加载。');
      else renderFolderBrowser();
    }
    if (bookEntryView) {
      if (!on && bookEntryView.loading) failBookEntry('电脑连接已断开，连接恢复后可重新加载。');
      else renderBookEntry();
    }
    if (rpState) refreshRpActions();
    if (on) pumpUploads(); else composerDisconnected();
  }
  function connect() {
    clearTimeout(retryTimer);
    if (navigator.onLine === false || $('app').classList.contains('hidden')) return;
    if (ws && ws.readyState <= 1) return;
    const boot = window.__relayBoot;
    window.__relayBoot = null;
    const socket = boot?.socket && boot.socket.readyState <= 1 ? boot.socket
      : new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/client`);
    let opened = socket.readyState === 1;
    ws = socket;
    if (!opened) connectTimer = setTimeout(() => {
        if (ws !== socket) return;
        discardSocket(); scheduleReconnect();
      }, 10000);
    socket.onopen = () => {
      if (ws !== socket) return;
      clearTimeout(connectTimer);
      opened = true; retry = 0;
    };
    socket.onmessage = (ev) => {
      if (ws !== socket) return;
      clearTimeout(pongTimer); pongTimer = null;
      let m; try { m = JSON.parse(ev.data); } catch { return; } handle(m);
    };
    socket.onclose = async () => {
      if (ws !== socket) return;
      clearTimeout(connectTimer); clearTimeout(pongTimer); pongTimer = null;
      if (loadCard.busy) loadCard.busy.clear();
      setOnline(false);
      if (!opened) {
        const authed = await checkAuth();
        if (ws !== socket) return;
        if (authed === false) { discardSocket(); return showLogin(); }
      }
      scheduleReconnect();
    };
    if (boot?.socket === socket) {
      for (const data of boot.messages) socket.onmessage({ data });
      boot.messages.length = 0;
    }
  }
  function discardSocket() {
    clearTimeout(retryTimer); clearTimeout(connectTimer); clearTimeout(pongTimer); pongTimer = null;
    const old = ws; ws = null;
    if (old) { old.onopen = old.onmessage = old.onclose = old.onerror = null; old.close(); }
    if (loadCard.busy) loadCard.busy.clear();
    setOnline(false);
  }
  function scheduleReconnect() {
    if (document.visibilityState !== 'visible' || navigator.onLine === false || $('app').classList.contains('hidden')) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, Math.min(8000, 250 * 2 ** Math.min(retry++, 5)));
  }
  function probeConnection() {
    if (!ws || ws.readyState !== 1) return connect();
    if (pongTimer) return;
    const socket = ws;
    send({ type: 'ping' });
    pongTimer = setTimeout(() => {
      if (ws !== socket) return;
      discardSocket(); connect();
    }, 3000);
  }
  function resumeConnection() {
    if ($('app').classList.contains('hidden')) return;
    retry = 0;
    probeConnection();
  }
  // Safari can leave a dead socket marked OPEN after backgrounding or a Wi-Fi/mobile handoff.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeConnection();
    else { clearTimeout(pongTimer); pongTimer = null; }
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) resumeConnection(); });
  window.addEventListener('online', resumeConnection);
  window.addEventListener('offline', discardSocket);
  setInterval(() => { if (document.visibilityState === 'visible' && !$('app').classList.contains('hidden')) probeConnection(); }, 15000);

  function reopen() {
    if (!wantOpen) return renderEmpty();
    if (wantOpen.chatId && chats.some((c) => c.id === wantOpen.chatId)) send({ type: 'open_chat', chatId: wantOpen.chatId });
    else if (wantOpen.hid) send({ type: 'open', hid: wantOpen.hid });
    else renderEmpty();
  }

  let firstChats = true;
  function handle(m) {
    switch (m.type) {
      case 'agent_status':
        setOnline(m.online);
        if (m.online) {
          // The agent already resolves a history id to its live chat, so no list round trip is needed.
          firstChats = !wantOpen?.hid;
          if (wantOpen?.hid) send({ type: 'open', hid: wantOpen.hid });
          send({ type: 'list' }); send({ type: 'history_list' });
        }
        break;
      case 'chats':
        chats = m.list || [];
        if (m.defaultCwd) defaultCwd = m.defaultCwd;
        if (chat && chat.id) {
          const cur = chats.find((c) => c.id === chat.id);
          if (cur) { chat = cur; renderHeader(); }
        }
        if (firstChats) { firstChats = false; reopen(); }
        renderList();
        break;
      case 'history':
        historyList = m.list || [];
        renderList(); renderRp();
        break;
      case 'chat':
        openChat(m);
        break;
      case 'ev':
        if (chat && m.chatId === chat.id) onEvent(m.ev);
        break;
      case 'rewound':
        setDraftText(m.text);
        $('msg').focus();
        toast('已回到这条消息之前，可以修改后重新发送');
        break;
      case 'file':
        if (viewerFile && viewerFile.req === m.req) { viewerFile = m; renderFile(); }
        break;
      case 'attachment_result':
        onAttachmentResult(m);
        break;
      case 'send_result':
        onSendResult(m);
        break;
      case 'rp_list':
        rpCards = m.cards || []; rpBooks = m.books || []; rpSettings = m.settings || rpSettings;
        rpCards.forEach((c) => { if (c.hasAvatar && !cardCache[c.id]) loadCard(c.id); });
        renderRp(); if (!$('setSheet').classList.contains('hidden')) renderSettings();
        break;
      case 'rp_card':
        onCardLoaded(m);
        break;
      case 'rp_avatar_result':
        finishAvatarUpload(m);
        break;
      case 'rp_edit_result':
        finishReplyEdit(m);
        break;
      case 'folders_result':
        onFoldersResult(m);
        break;
      case 'rp_book_entry_result':
        onBookEntryResult(m);
        break;
      case 'rp_book':
        renderBook(m);
        break;
      case 'rp_imported':
        toast(`已导入${m.kind === 'card' ? '角色卡' : '世界书'}：${m.name}`);
        if (m.kind === 'worldbook' && confirm(`把「${m.name}」设为全局世界书？（对所有角色生效，之后也可以在“人设与世界书”里关掉）`)) {
          send({ type: 'rp_settings', globalBooks: [...(rpSettings.globalBooks || []), m.id] });
        }
        break;
      case 'error':
        toast(m.message || '出错了');
        break;
    }
  }

  // ---------- conversation view ----------
  const thread = $('thread'), scroller = $('msgs');
  const codeCopyTimers = new WeakMap();
  thread.addEventListener('click', async event => {
    const button = event.target.closest('button.code-copy');
    if (button && thread.contains(button)) {
      event.preventDefault(); event.stopPropagation();
      const code = button.closest('.code-block')?.querySelector(':scope > pre > code');
      if (!code) return;
      clearTimeout(codeCopyTimers.get(button)); button.disabled = true;
      const copied = await copyText(code.textContent);
      button.disabled = false;
      button.textContent = copied ? '已复制' : '重试复制';
      button.setAttribute('aria-label', copied ? '代码已复制' : '重试复制代码块');
      codeCopyTimers.set(button, setTimeout(() => {
        button.textContent = '复制'; button.setAttribute('aria-label', '复制代码块');
      }, 1800));
      return;
    }
    const link = event.target.closest('a[data-local-file]');
    if (!link || !thread.contains(link)) return;
    event.preventDefault(); event.stopPropagation();
    openFile(link.dataset.localFile);
  });
  function nearBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80; }
  function scrollBottom() { scroller.scrollTop = scroller.scrollHeight; }

  function renderEmpty() {
    closeReplyEditor();
    hideContextPopover();
    lastUserCommand = '';
    activateComposer(null);
    chat = null; readonly = false; rpState = null;
    scroller.classList.remove('rp');
    thread.textContent = '';
    const e = el('div', 'empty');
    e.append(el('div', 'hello', '你好'), el('div', null, agentOnline ? '从左上角打开一个对话，或者开始新对话' : '等待电脑连接…'));
    thread.appendChild(e);
    renderHeader(); updateBanner(); updateSend();
  }

  function renderHeader() {
    $('title').textContent = chat ? chat.title : 'Claude';
    $('subtitle').textContent = !chat ? '' : rpState ? `角色扮演 · 我是${rpState.user}` : baseName(chat.cwd);
    const ctx = $('ctx');
    const usage = contextUsage();
    ctx.classList.remove('hidden');
    ctx.setAttribute('aria-label', usage?.total ? `查看上下文，已使用 ${Math.round(usage.ratio * 100)}%`
      : usage ? `查看上下文，已用 ${Math.round(usage.used).toLocaleString('zh-CN')} tokens，窗口上限待更新` : '查看上下文和账户用量');
    if (usage?.total) {
      $('ctxVal').setAttribute('stroke-dashoffset', String(94.25 * (1 - usage.ratio)));
    } else $('ctxVal').setAttribute('stroke-dashoffset', '94.25');
    if (!$('ctxPopover').classList.contains('hidden')) renderContextPopover();
    updateSend();
    updateRpEditor();
  }

  function updateBanner() {
    const b = $('banner');
    let text = '';
    if (!agentOnline) text = '电脑未连接，暂时不能发送消息';
    else if (readonly) text = '这个对话的工作目录已经不存在，只能查看';
    b.textContent = text;
    b.classList.toggle('hidden', !text);
  }

  function openChat(m) {
    if (rpEditor && rpEditor.chatId !== m.chat?.id) closeReplyEditor();
    hideContextPopover();
    // RP chats need the card (regex scripts, avatar) before their messages can be drawn
    if (m.rp && !cardCache[m.rp.cardId]) { pendingOpen = m; return loadCard(m.rp.cardId); }
    pendingOpen = null;
    rpState = m.rp || null;
    scroller.classList.toggle('rp', !!rpState);
    frames.clear();
    readonly = !!m.readonly;
    activateComposer(m.chat);
    chat = m.chat;
    wantOpen = chat.id ? { chatId: chat.id, hid: chat.sessionId } : null;
    store.set('open', wantOpen);
    thread.textContent = '';
    streamEl = null; thinkingEl = null; lastTool = null;
    lastUserCommand = '';
    for (const item of m.messages || []) appendItem(item);
    if (m.streaming) { startStream(); streamText = m.streaming; renderStream(); }
    if (chat.running && !m.streaming) showThinking();
    if (!(m.messages || []).length && !chat.running) {
      const e = el('div', 'empty');
      e.append(el('div', 'hello', '有什么可以帮你？'), el('div', null, chat.cwd || ''));
      thread.appendChild(e);
    }
    renderHeader(); updateBanner(); renderList(); closeDrawer();
    pumpUploads();
    requestAnimationFrame(scrollBottom);
  }

  function clearEmpty() { const e = thread.querySelector('.empty'); if (e) e.remove(); }

  function appendItem(it) {
    clearEmpty();
    if (it.role === 'user') noteUserCommand(it.text);
    if (isContextResult(it)) {
      thread.appendChild(contextResult(it.text)); lastTool = null; return;
    }
    switch (it.role) {
      case 'user': {
        const text = it.text || '', attachments = it.attachments || [];
        const attachmentKey = JSON.stringify(attachments.map(file => file.path || file.id || file.name));
        for (const { attempt } of sendRequests.values()) {
          if (attempt.chatId === chat?.id && attempt.text === text && JSON.stringify(attempt.attachments.map(file => file.path || file.id || file.name)) === attachmentKey) attempt.echoed = true;
        }
        // our own optimistic bubble is confirmed by the replayed message
        const pend = [...thread.querySelectorAll('.m.user.pending')].find((p) => p.dataset.text === text && p.dataset.attachments === attachmentKey);
        if (pend) { pend.classList.remove('pending'); pend.dataset.uuid = it.uuid || ''; return; }
        thread.appendChild(userBubble(text, it.uuid, false, attachments));
        lastTool = null;
        return;
      }
      case 'assistant': {
        if (rpState) { rpAssistant(it); lastTool = null; return; }
        const wrap = el('div', 'm assistant');
        const body = el('div', 'md'); body.innerHTML = md(it.text, true);
        addCodeCopyButtons(body);
        const acts = el('div', 'acts');
        const cp = el('button', null, '复制'); cp.onclick = () => copyText(it.text);
        acts.appendChild(cp);
        wrap.append(body, acts);
        appendMentionedFiles(wrap, it.text);
        thread.appendChild(wrap);
        lastTool = null;
        return;
      }
      case 'tool': {
        const d = el('details', 'tool');
        const s = el('summary');
        s.append(el('span', 'chev', '›'), el('span', 'tn', it.text));
        d.appendChild(s);
        thread.appendChild(d);
        lastTool = d;
        return;
      }
      case 'tool_result': {
        const pre = el('pre', null, it.text || '（无输出）');
        if (lastTool && !lastTool.querySelector('pre')) { lastTool.appendChild(pre); return; }
        const d = el('details', 'tool');
        const s = el('summary'); s.append(el('span', 'chev', '›'), el('span', 'tn', '工具结果'));
        d.append(s, pre); thread.appendChild(d);
        return;
      }
      case 'file': {
        const wrap = el('div', 'm');
        if (it.action === 'send' && it.text) wrap.appendChild(el('div', 'fcap', it.text));
        for (const f of it.files) wrap.appendChild(fileCard(f, it.action));
        thread.appendChild(wrap);
        lastTool = null;
        return;
      }
      case 'recap': {
        const r = el('div', 'm recap', it.text);
        if (!rpState) appendMentionedFiles(r, it.text);
        thread.appendChild(r);
        return;
      }
      default:
        thread.appendChild(el('div', 'sys', it.text));
    }
  }

  function userBubble(text, uuid, pending, attachments = []) {
    noteUserCommand(text);
    const row = el('div', 'm user' + (pending ? ' pending' : ''));
    row.dataset.text = text;
    row.dataset.uuid = uuid || '';
    row.dataset.attachments = JSON.stringify(attachments.map(file => file.path || file.id || file.name));
    const display = rpState ? applyRegex(text, 1) : text;
    if (isLongText(display)) {
      const wrap = el('div');
      const b = el('button', 'fcard long-message');
      const info = el('span', 'finfo');
      info.append(el('div', 'fname', '长文本'), el('div', 'fdir', `${display.length.toLocaleString()} 字 · 点击查看全文`));
      b.append(el('span', 'ficon', '📄'), info);
      b.onclick = () => previewText(display, '长文本');
      const actions = el('button', 'long-message-actions', '复制 / 更多');
      actions.onclick = () => openSheet(row);
      wrap.append(b, actions); row.appendChild(wrap);
    } else if (display || !attachments.length) {
      const b = el('div', 'bubble', display);
      b.onclick = () => openSheet(row);
      row.appendChild(b);
    }
    if (attachments.length) {
      const files = el('div', 'user-files');
      for (const attachment of attachments) {
        const card = fileCard(attachment.path || attachment.name, 'send');
        card.querySelector('.fname').textContent = attachment.name || baseName(attachment.path);
        card.querySelector('.fdir').textContent = fileSize(attachment.size || 0);
        card.disabled = !attachment.path || !chat?.sessionId;
        if (attachment.path) card.dataset.attachmentPath = attachment.path;
        files.appendChild(card);
      }
      row.appendChild(files);
    }
    return row;
  }

  function noteUserCommand(text) { lastUserCommand = /^\s*\/context(?:\s|$)/i.test(text || '') ? 'context' : ''; }
  function isContextResult(item) {
    if (!['system', 'assistant'].includes(item.role) || /^(?:出错了[:：]|已停止\s*$)/.test(item.text || '')) return false;
    return lastUserCommand === 'context' || /^\s*(?:#+\s*)?(?:Context Usage|上下文用量|上下文使用情况)(?:\s|[:：]|$)/i.test(item.text || '');
  }
  function contextResult(text, streaming = false) {
    const details = el('details', 'm context-result');
    const summary = el('summary');
    const hint = el('span', 'context-fold-hint', '点击展开');
    summary.append(el('span', null, '上下文详情'), hint);
    const body = streaming ? el('div', 'md cursor') : el('pre', null, text);
    details.append(summary, body);
    details.addEventListener('toggle', () => { hint.textContent = details.open ? '点击收起' : '点击展开'; });
    if (!streaming) {
      const actions = el('div', 'acts');
      const copy = el('button', null, '复制'); copy.onclick = () => copyText(text);
      actions.appendChild(copy); details.appendChild(actions);
    }
    return details;
  }

  // ---------- streaming ----------
  const SPARK = '<svg class="spark" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z"/></svg>';
  function showThinking() {
    if (thinkingEl || streamEl) return;
    clearEmpty();
    thinkingEl = el('div', 'thinking');
    thinkingEl.innerHTML = SPARK + '<span>思考中…</span>';
    thread.appendChild(thinkingEl);
  }
  function hideThinking() { if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; } }
  function startStream() {
    hideThinking();
    if (streamEl) streamEl.remove();
    streamText = '';
    streamEl = lastUserCommand === 'context' ? contextResult('', true) : el('div', 'm assistant');
    if (lastUserCommand !== 'context') streamEl.appendChild(el('div', 'md cursor'));
    thread.appendChild(streamEl);
  }
  let streamQueued = false;
  function renderStream() {
    if (streamQueued) return;
    streamQueued = true;
    requestAnimationFrame(() => {
      streamQueued = false;
      if (!streamEl) return;
      const stick = nearBottom();
      // RP: hide variable updates while streaming; status bars render once the message is final
      const body = streamEl.querySelector('.md');
      body.innerHTML = rpState ? rpInline(rpVisible(streamText)) : md(streamText, true);
      addCodeCopyButtons(body);
      if (stick) scrollBottom();
    });
  }
  function endStream() { if (streamEl) { streamEl.remove(); streamEl = null; } streamText = ''; }

  function onEvent(ev) {
    const stick = nearBottom();
    switch (ev.kind) {
      case 'thinking': showThinking(); break;
      case 'stream_start': startStream(); break;
      case 'delta':
        if (!streamEl) startStream();
        streamText += ev.text;
        renderStream();
        return;
      case 'messages':
        for (const it of ev.items) {
          if (it.role === 'assistant') endStream();
          appendItem(it);
        }
        if (chat && chat.running) { hideThinking(); if (!streamEl) showThinking(); }
        break;
      case 'meta':
        if (chat) {
          chat.sessionId = ev.sessionId; wantOpen = { chatId: chat.id, hid: ev.sessionId }; store.set('open', wantOpen);
          composerDrafts.set(`history:${ev.sessionId}`, composerDraft);
          thread.querySelectorAll('.user-files [data-attachment-path]').forEach(button => { button.disabled = false; });
        }
        break;
      case 'status':
        if (!chat) break;
        chat.running = ev.running;
        chat.contextUsed = ev.contextUsed; chat.contextWindow = ev.contextWindow;
        if (!ev.running) { endStream(); hideThinking(); thread.querySelectorAll('.m.user.pending').forEach((p) => p.classList.remove('pending')); }
        else if (!streamEl) showThinking();
        renderHeader();
        if (rpState) refreshRpActions();
        break;
      case 'vars':
        if (!rpState) break;
        rpState.vars = ev.vars;
        for (const [, f] of frames) { try { f.contentWindow.postMessage({ __rpVars: true, vars: ev.vars }, '*'); } catch { /* gone */ } }
        if (ev.changes && ev.changes.length) showVarChanges(ev.changes);
        break;
      case 'rp':
        if (!rpState) break;
        Object.assign(rpState, ev.rp);
        refreshRpActions();
        break;
    }
    if (stick) scrollBottom();
  }

  // ---------- composer ----------
  const msg = $('msg');
  let pastedTexts = [];
  const attachmentLimits = { count: 5, file: 10 * 1024 * 1024, total: 12 * 1024 * 1024, image: 5 * 1024 * 1024 };
  const composerDrafts = new Map(), uploadRequests = new Map(), sendRequests = new Map();
  const newComposerDraft = () => ({ chatId: null, text: '', texts: [], files: [], attempt: null });
  let composerDraft = newComposerDraft(), activeUpload = null;
  const requestId = prefix => `${prefix}-${crypto.randomUUID()}`;
  const fileSize = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${Math.max(0, bytes)} B`;
  function saveComposerDraft() { composerDraft.text = msg.value; composerDraft.texts = pastedTexts; }
  function activateComposer(next) {
    saveComposerDraft();
    let draft = next && (composerDrafts.get(next.id) || (next.sessionId && composerDrafts.get(`history:${next.sessionId}`)));
    if (!draft) draft = !composerDraft.chatId ? composerDraft : newComposerDraft();
    composerDraft = draft; draft.chatId = next?.id || null;
    if (next) {
      composerDrafts.set(next.id, draft);
      if (next.sessionId) composerDrafts.set(`history:${next.sessionId}`, draft);
      for (const file of draft.files) if (file.uploadChatId && file.uploadChatId !== next.id && file.status !== 'uploading') {
        file.attachment = null; file.status = 'queued'; file.uploadChatId = null;
      }
    }
    pastedTexts = draft.texts; msg.value = draft.text;
    renderPastedTexts(); renderAttachments(); autoGrow();
  }
  function invalidateSendAttempt(draft = composerDraft) {
    if (draft === composerDraft) saveComposerDraft();
    if (draft.attempt && !draft.attempt.waiting) draft.attempt = null;
  }
  function isLongText(text) { return text.length > 1500 || text.split('\n').length > 15; }
  function draftText() { return [...pastedTexts, msg.value].filter(text => text.length).join('\n\n'); }
  function renderPastedTexts() {
    const box = $('pastedTexts'); box.textContent = '';
    box.classList.toggle('hidden', !pastedTexts.length);
    pastedTexts.forEach((text, index) => {
      const card = el('div', 'paste-card');
      const preview = el('button', 'paste-preview'); preview.type = 'button';
      const info = el('span', 'paste-info');
      info.append(el('div', 'paste-title', `粘贴的文本 ${index + 1}`), el('div', 'paste-meta', `${text.length.toLocaleString()} 字 · 查看全文`));
      preview.append(el('span', null, '📄'), info);
      preview.onclick = () => previewText(text, `粘贴的文本 ${index + 1}`);
      const remove = el('button', 'paste-remove', '×'); remove.type = 'button';
      remove.setAttribute('aria-label', `移除粘贴的文本 ${index + 1}`);
      remove.disabled = !!composerDraft.attempt?.waiting;
      remove.onclick = () => { pastedTexts.splice(index, 1); invalidateSendAttempt(); renderPastedTexts(); updateSend(); };
      card.append(preview, remove); box.appendChild(card);
    });
  }
  function foldDraft(text) {
    pastedTexts.push(text); msg.value = '';
    invalidateSendAttempt(); renderPastedTexts(); autoGrow(); updateSend();
  }
  function setDraftText(text) {
    if (composerDraft.attempt?.waiting) return toast('消息正在发送，确认后可以编辑');
    pastedTexts = []; msg.value = text;
    if (isLongText(text)) return foldDraft(text);
    invalidateSendAttempt(); renderPastedTexts(); autoGrow(); updateSend();
  }
  function renderAttachments() {
    const box = $('attachments'); box.textContent = ''; box.classList.toggle('hidden', !composerDraft.files.length);
    const locked = !!composerDraft.attempt?.waiting;
    for (const file of composerDraft.files) {
      const card = el('div', `attachment-card${file.status === 'error' ? ' failed' : ''}`);
      const preview = el('button', 'attachment-preview'); preview.type = 'button';
      const thumb = el('span', 'attachment-thumb', '📎');
      if (file.previewUrl) { thumb.textContent = ''; const image = el('img'); image.src = file.previewUrl; image.alt = ''; thumb.appendChild(image); }
      const info = el('span', 'attachment-info');
      const state = { preparing: '准备中…', queued: agentOnline ? '等待上传' : '连接恢复后上传', uploading: '上传中…', ready: '已上传', error: file.error || '上传失败' }[file.status];
      info.append(el('div', 'attachment-name', file.name), el('div', 'attachment-status', [fileSize(file.size), file.note, state].filter(Boolean).join(' · ')));
      preview.append(thumb, info); preview.onclick = () => previewAttachment(file);
      preview.disabled = file.status === 'preparing'; card.appendChild(preview);
      if (file.status === 'error') {
        const retry = el('button', 'attachment-retry', '重试'); retry.type = 'button'; retry.disabled = locked || !agentOnline;
        retry.onclick = () => { file.error = ''; file.status = 'queued'; invalidateSendAttempt(); renderAttachments(); pumpUploads(); updateSend(); };
        card.appendChild(retry);
      }
      const remove = el('button', 'attachment-remove', '×'); remove.type = 'button'; remove.disabled = locked;
      remove.setAttribute('aria-label', `移除附件 ${file.name}`);
      remove.onclick = () => {
        composerDraft.files = composerDraft.files.filter(item => item !== file);
        if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
        if (file.requestId) finishUploadRequest(file.requestId);
        invalidateSendAttempt(); renderAttachments(); pumpUploads(); updateSend();
      };
      card.appendChild(remove); box.appendChild(card);
    }
  }
  function blobBase64(blob) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('读取文件失败'));
      reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(blob); });
  }
  async function prepareAttachment(file) {
    const original = file.blob, supported = /^image\/(png|jpeg|webp|gif)$/i.test(original.type);
    if (supported && (original.size <= attachmentLimits.image || original.type === 'image/gif')) {
      if (original.size > attachmentLimits.image) file.note = '作为文件发送，保留原图';
      else file.previewUrl = URL.createObjectURL(original);
      return;
    }
    const canConvert = supported || /^image\/(heic|heif|bmp|tiff)$/i.test(original.type) || /\.(heic|heif)$/i.test(file.name);
    if (!canConvert) { if (/^image\//i.test(original.type)) file.note = '作为文件发送'; return; }
    const source = URL.createObjectURL(original);
    try {
      const image = new Image(); image.src = source; await image.decode();
      const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .88));
      if (!blob || blob.size > attachmentLimits.image) throw new Error('图片转换失败');
      file.blob = blob; file.size = blob.size; file.mime = 'image/jpeg'; file.name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
      file.note = original.size > attachmentLimits.image ? '已压缩' : '已转为 JPEG'; file.previewUrl = URL.createObjectURL(blob);
    } catch { file.note = '作为文件发送，图片预览请选 PNG/JPEG'; }
    finally { URL.revokeObjectURL(source); }
  }
  async function addAttachments(files) {
    if (!chat?.id || readonly || composerDraft.attempt?.waiting) return toast('先打开可发送的对话');
    const draft = composerDraft;
    for (const source of files) {
      if (draft.files.length >= attachmentLimits.count) { toast('每次最多添加 5 个附件'); break; }
      if (source.size > attachmentLimits.file) { toast(`「${source.name}」超过 10 MB`); continue; }
      if (draft.files.reduce((sum, file) => sum + file.size, 0) + source.size > attachmentLimits.total) { toast('附件合计不能超过 12 MB'); continue; }
      const file = { name: source.name || '图片.png', mime: source.type || 'application/octet-stream', size: source.size, blob: source, status: 'preparing', note: '', attachment: null };
      draft.files.push(file); invalidateSendAttempt(draft); if (draft === composerDraft) { renderAttachments(); updateSend(); }
      await prepareAttachment(file);
      if (!draft.files.includes(file)) { if (file.previewUrl) URL.revokeObjectURL(file.previewUrl); continue; }
      file.status = 'queued'; if (draft === composerDraft) { renderAttachments(); pumpUploads(); updateSend(); }
    }
  }
  function finishUploadRequest(id) {
    const request = uploadRequests.get(id); if (!request) return;
    clearTimeout(request.timer); uploadRequests.delete(id);
    if (activeUpload === id) activeUpload = null;
  }
  async function pumpUploads() {
    if (activeUpload || !agentOnline || !chat?.id || composerDraft.chatId !== chat.id || readonly) return;
    const draft = composerDraft, file = draft.files.find(item => item.status === 'queued'); if (!file) return;
    const id = requestId('upload'); activeUpload = id; file.requestId = id; file.uploadChatId = chat.id; file.status = 'uploading';
    const request = { draft, file, chatId: chat.id, timer: null }; uploadRequests.set(id, request); renderAttachments(); updateSend();
    try {
      const data = await blobBase64(file.blob);
      if (!uploadRequests.has(id)) return;
      if (!send({ type: 'attachment_upload', chatId: request.chatId, requestId: id, name: file.name, mime: file.mime, data })) throw new Error('连接中断，请重试');
      request.timer = setTimeout(() => {
        file.status = 'error'; file.error = '上传超时，请重试'; finishUploadRequest(id);
        if (draft === composerDraft) { renderAttachments(); updateSend(); } pumpUploads();
      }, 45000);
    } catch (error) {
      file.status = 'error'; file.error = error.message || '上传失败，请重试'; finishUploadRequest(id);
      if (draft === composerDraft) { renderAttachments(); updateSend(); } pumpUploads();
    }
  }
  function onAttachmentResult(result) {
    const request = uploadRequests.get(result.requestId); if (!request || result.chatId !== request.chatId) return;
    const { draft, file } = request; finishUploadRequest(result.requestId);
    if (draft.files.includes(file)) {
      if (result.ok && result.attachment?.id) { file.status = 'ready'; file.attachment = result.attachment; file.error = ''; }
      else { file.status = 'error'; file.error = result.message || '上传失败，请重试'; }
    }
    if (draft === composerDraft) { renderAttachments(); updateSend(); } pumpUploads();
  }
  async function previewAttachment(file) {
    try {
      const isImage = !!file.previewUrl, isText = /^text\//.test(file.mime) || /\.(txt|md|json|csv|js|ts|py|html|css|yaml|yml|xml|log)$/i.test(file.name);
      const content = isText && !isImage ? await file.blob.text() : await blobBase64(file.blob);
      viewerFile = { kind: isImage ? 'image' : isText ? 'text' : 'binary', path: file.name, ext: isText ? 'txt' : '', mime: file.mime, content }; viewerSource = false;
      $('viewerTitle').textContent = file.name; $('viewerDir').textContent = fileSize(file.size); $('viewer').classList.remove('hidden'); $('viewerMode').classList.add('hidden'); renderFile();
    } catch { toast('暂时无法预览这个附件'); }
  }
  $('attachBtn').onclick = () => $('attachmentFiles').click();
  $('attachmentFiles').onchange = event => { const files = [...event.target.files]; event.target.value = ''; void addAttachments(files); };
  msg.addEventListener('paste', (event) => {
    if (event.clipboardData?.files.length) { event.preventDefault(); void addAttachments([...event.clipboardData.files]); return; }
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    const draft = msg.value.slice(0, msg.selectionStart) + text + msg.value.slice(msg.selectionEnd);
    if (!isLongText(draft)) return;
    event.preventDefault(); foldDraft(draft);
  });
  const composer = document.querySelector('.composer');
  composer.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); composer.classList.add('dragging'); } });
  composer.addEventListener('dragleave', event => { if (!composer.contains(event.relatedTarget)) composer.classList.remove('dragging'); });
  composer.addEventListener('drop', event => { event.preventDefault(); composer.classList.remove('dragging'); void addAttachments([...event.dataTransfer.files]); });
  function autoGrow() { msg.style.height = 'auto'; msg.style.height = Math.min(msg.scrollHeight, 200) + 'px'; }
  function updateSend() {
    const b = $('sendBtn');
    const hasDraft = pastedTexts.some(text => text.trim()) || !!msg.value.trim() || composerDraft.files.length > 0;
    const waiting = !!composerDraft.attempt?.waiting, filesReady = composerDraft.files.every(file => file.status === 'ready');
    const stop = !!(chat && chat.running) && !hasDraft;
    b.classList.toggle('stop', stop);
    $('sendIcon').innerHTML = stop ? '<rect x="7" y="7" width="10" height="10" rx="2"/>' : '<path d="M12 19V5M5 12l7-7 7 7"/>';
    b.setAttribute('aria-label', stop ? '停止' : '发送');
    b.disabled = !agentOnline || readonly || waiting || (!stop && (!hasDraft || !chat?.id || chat.running || !filesReady));
    msg.disabled = waiting; $('attachBtn').disabled = readonly || !chat?.id || waiting;
    const notice = composerDraft.attempt?.message || (waiting ? '正在发送，确认后会清空输入内容…' : '');
    $('composerNoticeText').textContent = notice; $('composerNotice').classList.toggle('hidden', !notice);
    $('sendRetry').classList.toggle('hidden', !composerDraft.attempt || waiting || !composerDraft.attempt.message);
    $('sendRetry').disabled = !agentOnline || readonly;
  }
  msg.addEventListener('input', (event) => {
    if (!event.isComposing && isLongText(msg.value)) return foldDraft(msg.value);
    invalidateSendAttempt(); autoGrow(); updateSend();
  });
  msg.addEventListener('compositionend', () => { if (isLongText(msg.value)) foldDraft(msg.value); });
  $('sendBtn').addEventListener('mousedown', (e) => e.preventDefault()); // keep the keyboard open
  $('sendBtn').onclick = () => {
    const text = draftText();
    if (chat && chat.running && !text.trim() && !composerDraft.files.length) return send({ type: 'stop', chatId: chat.id });
    sendText(text, true);
  };
  function sendText(text, clearDraft = false) {
    const files = clearDraft ? composerDraft.files : [];
    if (!chat?.id || readonly || chat.running || composerDraft.attempt?.waiting || (!text.trim() && !files.length)) return;
    if (!agentOnline) return toast('连接恢复后再发送，内容已保留');
    if (files.some(file => file.status !== 'ready')) return toast('附件上传完成后再发送');
    saveComposerDraft();
    const attachmentIds = files.map(file => file.attachment.id), signature = JSON.stringify({ text, attachmentIds, clearDraft });
    let attempt = composerDraft.attempt;
    if (!attempt || attempt.signature !== signature) attempt = composerDraft.attempt = {
      requestId: requestId('send'), chatId: chat.id, text, attachmentIds, attachments: files.map(file => file.attachment), signature, clearDraft, waiting: false, message: '', echoed: false,
    };
    submitAttempt(composerDraft, attempt);
  }
  function submitAttempt(draft, attempt) {
    if (attempt.waiting || !agentOnline) return;
    attempt.waiting = true; attempt.message = ''; sendRequests.set(attempt.requestId, { draft, attempt });
    if (!send({ type: 'send_attachments', chatId: attempt.chatId, requestId: attempt.requestId, text: attempt.text, attachmentIds: attempt.attachmentIds })) {
      attempt.waiting = false; attempt.message = '连接中断，内容已保留，请重试';
    } else attempt.timer = setTimeout(() => {
      attempt.waiting = false; attempt.message = '发送状态暂未确认，内容已保留，请重试';
      if (draft === composerDraft) { renderPastedTexts(); renderAttachments(); updateSend(); }
    }, 15000);
    if (draft === composerDraft) { renderPastedTexts(); renderAttachments(); updateSend(); }
  }
  $('sendRetry').onclick = () => { if (composerDraft.attempt) submitAttempt(composerDraft, composerDraft.attempt); };
  function onSendResult(result) {
    const request = sendRequests.get(result.requestId); if (!request || result.chatId !== request.attempt.chatId) return;
    const { draft, attempt } = request; clearTimeout(attempt.timer); attempt.waiting = false;
    if (!result.ok) {
      attempt.message = result.message || '发送失败，内容已保留，请重试';
      if (draft === composerDraft) { renderPastedTexts(); renderAttachments(); updateSend(); } return;
    }
    sendRequests.delete(result.requestId);
    if (draft.attempt === attempt) {
      if (attempt.clearDraft) {
        for (const file of draft.files) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
        draft.text = ''; draft.texts = []; draft.files = [];
      }
      draft.attempt = null;
      if (draft === composerDraft) {
        msg.value = draft.text; pastedTexts = draft.texts; renderPastedTexts(); renderAttachments(); autoGrow();
      }
    }
    if (chat?.id === attempt.chatId && !attempt.echoed) {
      clearEmpty(); thread.appendChild(userBubble(attempt.text, '', true, attempt.attachments)); scrollBottom();
    }
    updateSend();
  }
  function composerDisconnected() {
    for (const [id, request] of uploadRequests) {
      request.file.status = 'error'; request.file.error = '连接中断，请重试'; finishUploadRequest(id);
    }
    for (const { draft, attempt } of sendRequests.values()) {
      if (draft.attempt !== attempt || !attempt.waiting) continue;
      clearTimeout(attempt.timer); attempt.waiting = false; attempt.message = '连接中断，发送状态未确认，内容已保留';
    }
    renderPastedTexts(); renderAttachments(); updateSend();
  }

  // ---------- drawer ----------
  function openDrawer() {
    $('drawer').classList.add('on'); $('scrim').classList.add('on');
    msg.blur();
    showTab(store.get('dtab', 'chat'));
    if (agentOnline) { send({ type: 'list' }); send({ type: 'history_list' }); }
  }
  function closeDrawer() { $('drawer').classList.remove('on'); $('scrim').classList.remove('on'); $('newForm').classList.add('hidden'); }
  $('menuBtn').onclick = openDrawer;
  $('scrim').onclick = closeDrawer;
  $('refreshBtn').onclick = () => { send({ type: 'list' }); send({ type: 'history_list' }); toast('已刷新'); };
  for (const b of document.querySelectorAll('#chips button')) {
    b.onclick = () => { src = b.dataset.src; document.querySelectorAll('#chips button').forEach((x) => x.classList.toggle('on', x === b)); renderList(); };
  }
  const SRC_LABEL = { desktop: '桌面端', cli: '终端', other: '其他' };

  function renderList() {
    const box = $('convList');
    box.textContent = '';
    const liveIds = new Set(chats.map((c) => c.sessionId).filter(Boolean));
    if (chats.length) {
      box.appendChild(el('div', 'sec', '手机上打开的'));
      for (const c of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
        const h = historyList.find((x) => x.id === c.sessionId);
        if (src !== 'all' && (!h || h.source !== src)) continue;
        const b = el('button', 'conv' + (chat && chat.id === c.id ? ' on' : ''));
        const t = el('div', 'ct');
        t.append(el('span', null, c.title));
        if (c.running) t.append(el('span', 'dot busy'));
        else if (c.alive) t.append(el('span', 'dot'));
        b.append(t, el('div', 'cm', `${ago(c.updatedAt)} · ${baseName(c.cwd)}`));
        b.onclick = () => send({ type: 'open_chat', chatId: c.id });
        box.appendChild(b);
      }
    }
    const items = historyList.filter((h) => !liveIds.has(h.id) && (src === 'all' || h.source === src));
    if (items.length) box.appendChild(el('div', 'sec', '最近'));
    for (const h of items) {
      const b = el('button', 'conv' + (chat && chat.sessionId === h.id ? ' on' : ''));
      const t = el('div', 'ct');
      t.append(el('span', null, h.title), el('span', `tag ${h.source}`, SRC_LABEL[h.source] || h.source));
      b.append(t, el('div', 'cm', `${ago(h.updatedAt)} · ${baseName(h.cwd)}`));
      b.onclick = () => {
        if (h.source === 'desktop' && !store.get('warnedDesktop', false)) {
          if (!confirm('这是桌面端的对话。可以在手机上接着聊，但如果桌面端也开着它，两边同时发消息会让对话分叉。')) return;
          store.set('warnedDesktop', true);
        }
        send({ type: 'open', hid: h.id });
      };
      box.appendChild(b);
    }
    if (!chats.length && !items.length) box.appendChild(el('div', 'sec', agentOnline ? '还没有对话' : '电脑未连接'));
  }

  // new chat
  $('newChatBtn').onclick = () => {
    const f = $('newForm');
    if (!f.classList.contains('hidden')) return f.classList.add('hidden');
    $('cwd').value = defaultCwd || store.get('recentCwds', [])[0] || '';
    const box = $('recent'); box.textContent = '';
    for (const p of [...new Set([defaultCwd, ...store.get('recentCwds', [])].filter(Boolean))].slice(0, 6)) {
      const b = el('button', null, baseName(p)); b.title = p; b.onclick = () => { $('cwd').value = p; };
      box.appendChild(b);
    }
    f.classList.remove('hidden');
  };
  $('newCancel').onclick = () => $('newForm').classList.add('hidden');
  $('newGo').onclick = () => {
    const cwd = $('cwd').value.trim();
    if (!cwd) return toast('请填写工作目录');
    if (!agentOnline || !send({ type: 'new', cwd })) return toast('电脑未连接，请连接后再开始');
    store.set('recentCwds', [cwd, ...store.get('recentCwds', []).filter((x) => x !== cwd)].slice(0, 8));
  };

  // ---------- computer folder picker ----------
  function folderIcon(kind) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', kind === 'drive' ? 'M5 4h14l2 14H3L5 4zm-2 14v3h18v-3M16 18h2' : kind === 'shortcut' ? 'm3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7' : 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z');
    icon.appendChild(shape); return icon;
  }
  function renderFolderBrowser() {
    const s = folderBrowser; if (!s) return;
    $('folderTitle').textContent = s.path ? baseName(s.path) : '选择工作目录';
    $('folderPath').textContent = s.path || '浏览电脑上的磁盘与常用位置';
    $('folderUp').disabled = !agentOnline || !s.path;
    $('folderHome').disabled = !agentOnline;
    $('folderChoose').disabled = !agentOnline || s.loading || !!s.error || !s.valid || !s.path;
    $('folderStatus').textContent = s.error || (s.loading ? (s.offset ? '正在加载更多文件夹…' : '正在读取文件夹…') : s.items.length ? '' : s.path ? '这个文件夹里没有子文件夹' : '没有可浏览的位置');
    $('folderStatus').classList.toggle('error', !!s.error);
    $('folderRetry').classList.toggle('hidden', !s.error);
    $('folderRetry').disabled = !agentOnline;
    $('folderItems').setAttribute('aria-busy', String(s.loading));
    const box = $('folderItems'); box.textContent = '';
    for (const item of s.items) {
      const row = el('button', 'folder-item'); row.type = 'button';
      row.append(folderIcon(item.kind), el('span', 'folder-name', item.name), el('span', 'folder-arrow', '›'));
      row.lastChild.setAttribute('aria-hidden', 'true');
      row.disabled = !agentOnline;
      row.onclick = () => requestFolders(item.path);
      box.appendChild(row);
    }
    $('folderMore').classList.toggle('hidden', !s.hasMore || !!s.error);
    $('folderMore').disabled = s.loading || !agentOnline;
  }
  function failFolderBrowser(message) {
    const s = folderBrowser; if (!s) return;
    clearTimeout(s.timer); s.requestId = null; s.loading = false; s.valid = false; s.error = message;
    renderFolderBrowser();
  }
  function requestFolders(path, more = false) {
    const s = folderBrowser; if (!s) return;
    clearTimeout(s.timer);
    if (!more) {
      const oldPath = s.path;
      s.path = path || null; s.parentPath = path ? oldPath : null;
      s.items = []; s.offset = 0; s.nextOffset = 0; s.hasMore = false; s.valid = false;
      $('folderScroll').scrollTop = 0;
    }
    s.loading = true; s.error = ''; s.offset = more ? s.nextOffset : 0;
    s.requestId = requestId('folders');
    renderFolderBrowser();
    if (!agentOnline || !send({ type: 'browse_folders', requestId: s.requestId, path: s.path, offset: s.offset, limit: 100 })) {
      failFolderBrowser('电脑未连接，连接恢复后可重新加载。'); return;
    }
    const pending = s.requestId;
    s.timer = setTimeout(() => { if (folderBrowser?.requestId === pending) failFolderBrowser('读取超时，请重新加载或返回位置首页。'); }, 20000);
  }
  function onFoldersResult(result) {
    const s = folderBrowser;
    if (!s || result.requestId !== s.requestId) return;
    clearTimeout(s.timer); s.requestId = null;
    if (!result.ok) {
      const messages = { EACCES: '没有权限打开此文件夹，请选择其他位置。', EPERM: '没有权限打开此文件夹，请选择其他位置。', ENOENT: '此文件夹已不存在，请返回上一级或位置首页。', ENOTDIR: '此位置不是文件夹，请选择其他位置。' };
      failFolderBrowser(messages[result.code] || result.message || '无法读取此文件夹，请重新加载。'); return;
    }
    const append = s.offset > 0;
    s.path = typeof result.path === 'string' && result.path ? result.path : null;
    s.parentPath = typeof result.parentPath === 'string' && result.parentPath ? result.parentPath : null;
    const items = (Array.isArray(result.items) ? result.items : []).filter(item => item && typeof item.name === 'string' && typeof item.path === 'string' && ['drive', 'shortcut', 'folder'].includes(item.kind));
    s.items = [...new Map([...(append ? s.items : []), ...items].map(item => [item.path, item])).values()];
    s.loading = false; s.error = ''; s.valid = true;
    s.nextOffset = Number.isInteger(result.nextOffset) ? result.nextOffset : s.offset + items.length;
    s.hasMore = !!result.hasMore && s.nextOffset > s.offset;
    renderFolderBrowser();
  }
  function closeFolderBrowser() {
    if (!folderBrowser) return;
    clearTimeout(folderBrowser.timer); folderBrowser = null;
    $('folderSheet').classList.add('hidden'); $('browseCwd').focus();
  }
  $('browseCwd').onclick = () => {
    folderBrowser = { path: null, parentPath: null, items: [], loading: false, valid: false, error: '', offset: 0, nextOffset: 0, hasMore: false, requestId: null, timer: null };
    $('folderSheet').classList.remove('hidden'); $('folderClose').focus(); requestFolders(null);
  };
  $('folderUp').onclick = () => { if (folderBrowser?.path) requestFolders(folderBrowser.parentPath); };
  $('folderHome').onclick = () => requestFolders(null);
  $('folderClose').onclick = closeFolderBrowser;
  $('folderSheet').onclick = event => { if (event.target === $('folderSheet')) closeFolderBrowser(); };
  $('folderRetry').onclick = () => { if (folderBrowser) requestFolders(folderBrowser.path); };
  $('folderMore').onclick = () => { if (folderBrowser && !folderBrowser.loading && folderBrowser.hasMore) requestFolders(folderBrowser.path, true); };
  $('folderChoose').onclick = () => {
    const s = folderBrowser; if (!s || !s.valid || !s.path || s.loading || s.error || !agentOnline) return;
    $('cwd').value = s.path; closeFolderBrowser();
  };
  document.addEventListener('keydown', event => {
    const dialog = folderBrowser ? $('folderSheet') : !$('bookEntrySheet').classList.contains('hidden') ? $('bookEntrySheet') : null;
    if (!dialog) return;
    if (event.key === 'Escape') { event.preventDefault(); if (folderBrowser) closeFolderBrowser(); else closeBookEntry(); }
    if (event.key === 'Tab') {
      const controls = [...dialog.querySelectorAll('button:not(:disabled), [tabindex="0"]')].filter(node => node.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    }
  });

  // ---------- more menu ----------
  const menu = $('moreMenu');
  $('moreBtn').onclick = (e) => {
    e.stopPropagation();
    hideContextPopover();
    if (!menu.classList.contains('hidden')) return menu.classList.add('hidden');
    const cur = store.get('effort', 'medium');
    menu.querySelectorAll('[data-effort]').forEach((b) => b.classList.toggle('on', b.dataset.effort === cur));
    menu.classList.remove('hidden');
    const r = $('moreBtn').getBoundingClientRect();
    menu.style.top = (r.bottom + 4) + 'px';
    menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  };
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.classList.add('hidden'); });
  function needChat() {
    if (!chat || !chat.id || readonly) { toast('先打开一个对话'); return false; }
    if (chat.running) { toast('Claude 正在回复，请稍等'); return false; }
    return true;
  }
  menu.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      menu.classList.add('hidden');
      if (b.dataset.effort) {
        if (!needChat()) return;
        store.set('effort', b.dataset.effort);
        return sendText(`/effort ${b.dataset.effort}`);
      }
      const act = b.dataset.act;
      if (act === 'context') { if (needChat() && confirm('查看当前对话的详细上下文？确认后将发送 /context。')) sendText('/context'); }
      else if (act === 'compact') { if (needChat() && confirm('确定压缩当前对话的上下文吗？确认后将发送 /compact，之前的内容会被总结。')) sendText('/compact'); }
      else if (act === 'close') {
        if (!chat || !chat.id) return;
        if (!confirm('结束这个对话？电脑上对应的 Claude 进程会被关闭，之后仍可以从“最近”里重新打开。')) return;
        send({ type: 'close', chatId: chat.id });
        wantOpen = null; store.set('open', null);
        renderEmpty();
      }
    };
  });
  function contextUsage() {
    const total = Number(chat && chat.contextWindow), value = Number(chat && chat.contextUsed);
    const used = Number.isFinite(value) ? Math.max(0, value) : 0;
    if (!Number.isFinite(total) || total <= 0) return used > 0 ? { used, total: null, ratio: null } : null;
    return { used, total, ratio: Math.min(1, used / total) };
  }
  function hideContextPopover() {
    clearTimeout(contextPopoverTimer); contextPopoverTimer = null;
    $('ctxPopover').classList.add('hidden');
    $('ctx').setAttribute('aria-expanded', 'false');
  }
  function positionContextPopover() {
    const pop = $('ctxPopover');
    if (pop.classList.contains('hidden')) return;
    const r = $('ctx').getBoundingClientRect(), width = pop.offsetWidth;
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${r.bottom + 8}px`;
    const bottom = window.visualViewport ? visualViewport.offsetTop + visualViewport.height : window.innerHeight;
    pop.style.maxHeight = `${Math.max(120, bottom - r.bottom - 16)}px`;
  }
  function renderContextPopover() {
    const usage = contextUsage();
    if (!usage) {
      $('ctxPercent').textContent = '暂无数据'; $('ctxAmount').textContent = chat ? '等待当前对话返回上下文用量' : '打开对话后显示上下文用量';
      $('ctxRemaining').textContent = ''; $('ctxMeter').style.width = '0%';
      $('contextMeter').removeAttribute('aria-valuenow');
      positionContextPopover(); return;
    }
    const number = n => Math.round(n).toLocaleString('zh-CN');
    if (!usage.total) {
      $('ctxPercent').textContent = `已用 ${number(usage.used)} tokens`; $('ctxAmount').textContent = '窗口上限待更新';
      $('ctxRemaining').textContent = ''; $('ctxMeter').style.width = '0%';
      $('contextMeter').removeAttribute('aria-valuenow');
      positionContextPopover(); return;
    }
    $('ctxPercent').textContent = `已使用 ${Math.round(usage.used / usage.total * 100)}%`;
    $('ctxAmount').textContent = `${number(usage.used)} / ${number(usage.total)} tokens`;
    $('ctxRemaining').textContent = `剩余 ${number(Math.max(0, usage.total - usage.used))} tokens`;
    $('ctxMeter').style.width = `${usage.ratio * 100}%`;
    $('contextMeter').setAttribute('aria-valuenow', String(Math.round(usage.ratio * 100)));
    positionContextPopover();
  }
  $('ctx').onclick = () => {
    if (!$('ctxPopover').classList.contains('hidden')) return hideContextPopover();
    menu.classList.add('hidden');
    $('ctxPopover').classList.remove('hidden');
    $('ctx').setAttribute('aria-expanded', 'true');
    renderContextPopover();
    renderAccountUsage();
    void loadAccountUsage();
    clearTimeout(contextPopoverTimer);
    contextPopoverTimer = setTimeout(hideContextPopover, 10000);
  };
  function dismissContextOutside(event) {
    if (!$('ctx').contains(event.target) && !$('ctxPopover').contains(event.target)) hideContextPopover();
  }
  document.addEventListener('pointerdown', dismissContextOutside, true);
  document.addEventListener('click', dismissContextOutside, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hideContextPopover(); });

  function renderAccountUsage() {
    for (const [prefix, value] of [['fiveHour', accountUsage?.fiveHour], ['sevenDay', accountUsage?.sevenDay]]) {
      const percent = Number.isFinite(value?.utilization) ? value.utilization : null;
      $(prefix + 'Percent').textContent = percent == null ? '暂无数据' : `已使用 ${percent.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`;
      const meter = $(prefix + 'Meter');
      meter.firstElementChild.style.width = `${percent == null ? 0 : Math.min(100, Math.max(0, percent))}%`;
      if (percent == null) meter.removeAttribute('aria-valuenow');
      else meter.setAttribute('aria-valuenow', String(Math.min(100, Math.max(0, percent))));
      const reset = Date.parse(value?.resetsAt);
      $(prefix + 'Reset').textContent = Number.isFinite(reset)
        ? `将于 ${new Date(reset).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 重置`
        : (usageLoading ? '读取中…' : '重置时间暂无数据');
    }
    $('usageRefresh').disabled = usageLoading;
    const error = { auth_required: 'Claude 登录已过期，请在电脑上重新登录', rate_limited: '用量查询暂时受限，稍后会自动重试', network: '暂时无法更新用量，请稍后重试', unsupported: '当前账户暂不提供套餐用量', login_required: '登录已过期，请刷新页面', computer_offline: '电脑暂未更新，显示上次用量' };
    const updated = accountUsage?.updatedAt ? `更新于 ${new Date(accountUsage.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '';
    $('usageNote').textContent = usageLoading ? '正在更新账户用量…'
      : accountUsage?.status === 'error' ? `${error[accountUsage.error] || error.network}${updated ? ` · ${updated}` : ''}`
      : accountUsage?.status === 'loading' ? '等待电脑返回用量，可稍后刷新'
      : [updated, '约每分钟更新'].filter(Boolean).join(' · ');
    positionContextPopover();
  }
  async function loadAccountUsage(force = false) {
    if (usageLoading) return;
    usageLoading = true; renderAccountUsage();
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`/api/usage${force ? '?refresh=1' : ''}`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) {
        accountUsage = { ...accountUsage, status: 'error', error: response.status === 401 ? 'login_required' : 'network' };
      } else accountUsage = await response.json();
    } catch { accountUsage = { ...accountUsage, status: 'error', error: 'network' }; }
    finally { clearTimeout(timeout); usageLoading = false; renderAccountUsage(); }
  }
  $('usageRefresh').onclick = () => { void loadAccountUsage(true); };

  // ---------- message action sheet ----------
  let sheetRow = null;
  function openSheet(row) {
    sheetRow = row;
    $('sheetQuote').textContent = row.dataset.text;
    $('sheetRewind').classList.toggle('hidden', !row.dataset.uuid || readonly);
    $('sheet').classList.remove('hidden');
  }
  function closeSheet() { $('sheet').classList.add('hidden'); sheetRow = null; }
  $('sheetCancel').onclick = closeSheet;
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
  $('sheetCopy').onclick = () => { copyText(sheetRow.dataset.text); closeSheet(); };
  $('sheetRewind').onclick = () => {
    if (chat && chat.running) { toast('Claude 正在回复，请先停止'); return closeSheet(); }
    send({ type: 'rewind', chatId: chat.id, uuid: sheetRow.dataset.uuid });
    closeSheet();
  };

  // ---------- file cards + viewer ----------
  const FILE_ICON = { write: '📄', edit: '✏️', send: '📎' };
  const FILE_TAG = { write: '新建', edit: '已修改', send: '' };
  function appendMentionedFiles(container, text) {
    if (rpState || !window.ClaudeFilePaths) return;
    const files = window.ClaudeFilePaths.extractPaths(text || '');
    if (!files.length) return;
    const cards = el('div', 'mentioned-files');
    for (const file of files) cards.appendChild(fileCard(file, 'send'));
    container.appendChild(cards);
  }
  function fileCard(file, action) {
    const [dir, name] = splitPath(file);
    const b = el('button', 'fcard');
    const icon = el('span', 'ficon', /\.(png|jpe?g|gif|webp|svg)$/i.test(name) ? '🖼️' : FILE_ICON[action] || '📄');
    const info = el('span', 'finfo');
    info.append(el('div', 'fname', name), el('div', 'fdir', [FILE_TAG[action], baseName(dir)].filter(Boolean).join(' · ')));
    b.append(icon, info);
    b.onclick = () => openFile(file);
    return b;
  }
  let viewerFile = null, viewerSource = false;
  function previewText(text, title) {
    msg.blur();
    viewerFile = { kind: 'text', ext: 'txt', content: text }; viewerSource = false;
    $('viewerTitle').textContent = title;
    $('viewerDir').textContent = `${text.length.toLocaleString()} 字`;
    $('viewer').classList.remove('hidden');
    renderFile();
  }
  function openFile(file) {
    if (!chat || !chat.sessionId) return toast('这个对话还没有记录');
    viewerFile = { req: file, path: file };
    viewerSource = false;
    const [dir, name] = splitPath(file);
    $('viewerTitle').textContent = name;
    $('viewerDir').textContent = dir;
    $('viewerBody').innerHTML = '<div class="note">加载中…</div>';
    $('viewerMode').classList.add('hidden');
    $('downloadFile').disabled = true;
    $('viewer').classList.remove('hidden');
    send({ type: 'file_get', hid: chat.sessionId, path: file });
  }
  const DOC_CSS = `<meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{font:16px/1.65 -apple-system,"PingFang SC",sans-serif;color:#1f1e1d;padding:14px 18px 40px;margin:0;word-wrap:break-word;background:#fff}
    pre,code{font:13px Menlo,monospace;background:#f3f1ea;border-radius:6px}pre{padding:10px;overflow:auto}code{padding:1px 4px}
    pre code{padding:0}table{border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid #ddd;padding:5px 8px}
    img{max-width:100%}blockquote{margin:0;padding-left:12px;border-left:3px solid #d97757;color:#555}h1,h2,h3{line-height:1.3}
  </style>`;
  function renderFile() {
    const f = viewerFile, body = $('viewerBody');
    body.textContent = '';
    $('downloadFile').disabled = !!f.error || typeof f.content !== 'string' || !['text', 'image', 'binary'].includes(f.kind);
    if (f.error) {
      const t = { missing: '文件已经不存在了', too_large: '文件太大（超过 10MB），无法在手机上打开',
        not_referenced: '只能打开这个对话里出现过的文件', not_found: '找不到这个对话' }[f.error] || `打开失败：${f.error}`;
      return body.appendChild(el('div', 'note', t));
    }
    const rich = f.kind === 'text' && ['md', 'markdown', 'html', 'htm'].includes(f.ext);
    $('viewerMode').classList.toggle('hidden', !rich);
    if (f.kind === 'image') { const img = el('img'); img.src = `data:${f.mime};base64,${f.content}`; return body.appendChild(img); }
    if (f.kind === 'binary') return body.appendChild(el('div', 'note', typeof f.content === 'string' ? '此文件不支持预览，可以下载到设备。' : '此文件暂不支持预览或下载'));
    if (rich && !viewerSource) {
      // documents render in a sandboxed frame: markdown gets no scripts, html runs isolated from this page
      const frame = el('iframe');
      const isMd = f.ext === 'md' || f.ext === 'markdown';
      frame.setAttribute('sandbox', isMd ? '' : 'allow-scripts');
      frame.srcdoc = isMd ? DOC_CSS + md(f.content) : f.content;
      return body.appendChild(frame);
    }
    body.appendChild(el('pre', null, f.content));
  }
  $('viewerBack').onclick = () => $('viewer').classList.add('hidden');
  $('downloadFile').onclick = () => {
    const f = viewerFile;
    if (!f || f.error || typeof f.content !== 'string') return;
    try {
      let data = f.content;
      if (f.kind === 'image' || f.kind === 'binary') {
        const binary = atob(f.content), bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        data = bytes;
      }
      const blob = new Blob([data], { type: f.mime || (f.kind === 'text' ? 'text/plain;charset=utf-8' : 'application/octet-stream') });
      const url = URL.createObjectURL(blob), link = el('a');
      link.href = url; link.download = baseName(f.path || f.req) || '文本.txt';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { toast('文件下载失败，请重新打开后再试'); }
  };
  $('viewerMode').onclick = () => { viewerSource = !viewerSource; renderFile(); };
  $('copyPath').onclick = () => viewerFile && copyText(viewerFile.path || viewerFile.req, '路径');
  $('copyContent').onclick = () => {
    const f = viewerFile;
    if (!f || f.error) return toast('没有可复制的内容');
    if (f.kind !== 'text') return copyText(f.path, '路径');
    copyText(f.content, '内容');
  };

  // =====================================================================
  // RP mode: cards, world books, regex display, MVU status bars
  // =====================================================================
  let rpState = null;           // { cardId, name, user, greeting, greetings, swipes, vars } of the open RP chat
  let rpCards = [], rpBooks = [], rpSettings = { persona: { name: '用户', description: '' }, globalBooks: [], toggles: {} };
  const cardCache = {};         // cardId -> { card, avatarUrl }
  let pendingOpen = null, sheetCardId = null, sheetGreeting = 0;
  const frames = new Map();     // frame id -> iframe of the open chat

  function loadCard(id) { if (!loadCard.busy) loadCard.busy = new Set(); if (loadCard.busy.has(id)) return; loadCard.busy.add(id); send({ type: 'rp_card', cardId: id }); }
  function onCardLoaded(m) {
    if (loadCard.busy) loadCard.busy.delete(m.cardId);
    let avatarUrl = null;
    if (m.avatar) {
      const bin = atob(m.avatar); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      avatarUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    }
    const previousAvatar = cardCache[m.cardId]?.avatarUrl;
    cardCache[m.cardId] = { card: m.card, avatarUrl };
    document.querySelectorAll(`.av[data-card="${m.cardId}"]`).forEach((a) => fillAvatar(a, m.cardId));
    if (previousAvatar) URL.revokeObjectURL(previousAvatar);
    if (pendingOpen && pendingOpen.rp && pendingOpen.rp.cardId === m.cardId) openChat(pendingOpen);
    if (sheetCardId === m.cardId) renderCardSheet();
  }
  function fillAvatar(a, id) {
    const c = cardCache[id];
    a.textContent = '';
    if (c && c.avatarUrl) { const img = el('img'); img.src = c.avatarUrl; img.alt = ''; a.appendChild(img); }
    else a.textContent = ((c && c.card.name) || (rpCards.find((x) => x.id === id) || {}).name || '?').slice(0, 1);
  }
  function avatarEl(id, size) { const a = el('div', `av ${size || ''}`); a.dataset.card = id; fillAvatar(a, id); return a; }
  const rpCard = () => (rpState && cardCache[rpState.cardId] ? cardCache[rpState.cardId].card : { regex_scripts: [], name: '' });

  // ---------- display pipeline: hide variable updates -> card regex -> macros -> markdown / html frames ----------
  function getPath(o, p) {
    for (const k of String(p).split(/[.[\]'"]+/).filter(Boolean)) { if (o == null) return undefined; o = o[k]; }
    return o;
  }
  function rpMacros(t) {
    const vars = (rpState && rpState.vars) || {};
    return String(t).replace(/\{\{\s*(user|char)\s*\}\}/gi, (_, w) => (w.toLowerCase() === 'user' ? rpState.user : rpCard().name))
      .replace(/<USER>/gi, rpState.user).replace(/<(BOT|CHAR)>/gi, rpCard().name)
      .replace(/\{\{\s*(?:get_message_variable|getvar|get_chat_variable)::([^}]+)\}\}/gi, (_, p) => {
        const v = getPath(vars, p.trim()); return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      })
      .replace(/\{\{\s*format_message_variable::([^}]+)\}\}/gi, (_, p) => JSON.stringify(getPath(vars, p.trim()) ?? '', null, 2));
  }
  function parseRe(src) {
    const m = /^\/([\s\S]*)\/([gimsuy]*)$/.exec(src);
    try { return m ? new RegExp(m[1], m[2]) : new RegExp(String(src).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'); } catch { return null; }
  }
  // placement: 1 = user input, 2 = AI output (SillyTavern numbering); prompt-only scripts never touch the display
  function applyRegex(text, placement) {
    let t = String(text);
    if (!rpState) return t;
    for (const s of rpCard().regex_scripts || []) {
      if (s.disabled || s.promptOnly || !(s.placement || []).includes(placement)) continue;
      const re = parseRe(s.substituteRegex ? rpMacros(s.findRegex) : s.findRegex);
      if (!re) continue;
      const rep = rpMacros(String(s.replaceString ?? '').replace(/\{\{match\}\}/gi, '$&'));
      t = t.replace(re, (...a) => {
        let m0 = a[0];
        for (const ts of s.trimStrings || []) if (ts) m0 = m0.split(ts).join('');
        const groups = a.slice(1, a.findIndex((x) => typeof x === 'number'));
        return rep.replace(/\$(&|\d+)/g, (x, n) => (n === '&' ? m0 : groups[n - 1] ?? ''));
      });
    }
    return t;
  }
  function rpVisible(text) {
    let t = String(text).replace(/<UpdateVariable>[\s\S]*?(<\/UpdateVariable>|$)/gi, '');
    // mid-stream the opening tag may be only half written
    const i = t.lastIndexOf('<');
    if (i >= 0 && '<updatevariable>'.startsWith(t.slice(i).toLowerCase())) t = t.slice(0, i);
    return t.trim();
  }
  function rpInline(t) {
    const template = document.createElement('template');
    template.innerHTML = DOMPurify.sanitize(marked.parse(t), { FORBID_TAGS: ['script'], ADD_ATTR: ['target'] });
    // Colour dialogue after parsing so code and prompt blocks retain their exact text.
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT), nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (node.parentElement?.closest('pre, code, style, script, .q')) continue;
      const pattern = /(“[^”\n]*”|「[^」\n]*」|『[^』\n]*』)/g;
      let match, offset = 0; const fragment = document.createDocumentFragment();
      while ((match = pattern.exec(node.textContent))) {
        fragment.append(node.textContent.slice(offset, match.index), el('span', 'q', match[0]));
        offset = match.index + match[0].length;
      }
      if (offset) { fragment.append(node.textContent.slice(offset)); node.replaceWith(fragment); }
    }
    return template.innerHTML;
  }
  const usesPlaceholder = () => (rpCard().regex_scripts || []).some((s) => /StatusPlaceHolderImpl/.test(s.findRegex || ''));

  function renderRpBody(container, text, opts) {
    let t = rpVisible(text);
    // MVU appends this placeholder to the latest reply; card regexes turn it into the status bar
    if (opts.last && usesPlaceholder() && !/<StatusPlaceHolderImpl\s*\/>/.test(t)) t += '\n\n<StatusPlaceHolderImpl/>';
    t = rpMacros(applyRegex(t, 2));
    container.textContent = '';
    // fenced blocks that hold a page run in a sandboxed frame (like SillyTavern's helper); the rest renders inline
    const re = /```[a-zA-Z]*\s*\n?([\s\S]*?)```/g;
    let last = 0, m;
    const pushMd = (s) => { if (s.trim()) { const d = el('div'); d.innerHTML = rpInline(s); container.appendChild(d); } };
    while ((m = re.exec(t))) {
      if (!/<(html|body|!doctype|script|style|div)/i.test(m[1])) continue;
      pushMd(t.slice(last, m.index));
      container.appendChild(helperFrame(m[1], opts.messageId));
      last = m.index + m[0].length;
    }
    pushMd(t.slice(last));
    addCodeCopyButtons(container);
  }

  function rpMessages() {
    return [...thread.querySelectorAll('.m.user, .m.assistant')].map((n, i) => ({
      message_id: i, name: n.classList.contains('user') ? rpState.user : rpCard().name,
      role: n.classList.contains('user') ? 'user' : 'assistant', is_user: n.classList.contains('user'),
      message: n.dataset.text || '',
    }));
  }

  function rpAssistant(it) {
    const wrap = el('div', 'm assistant');
    wrap.dataset.text = it.text;
    wrap.dataset.uuid = it.uuid || '';
    if (it.greeting) wrap.dataset.greeting = '1';
    const who = el('div', 'who');
    who.append(avatarEl(rpState.cardId, 'sm'), el('span', null, rpCard().name));
    const body = el('div', 'md');
    wrap.append(who, body, el('div', 'acts'));
    thread.appendChild(wrap);
    // only the newest reply carries the status-bar placeholder; older ones lose it
    thread.querySelectorAll('.m.assistant[data-last]').forEach((n) => {
      n.removeAttribute('data-last'); renderRpBody(n.querySelector('.md'), n.dataset.text, { last: false, messageId: msgIdOf(n) });
    });
    wrap.dataset.last = '1';
    renderRpBody(body, it.text, { last: true, messageId: msgIdOf(wrap) });
    refreshRpActions();
  }
  const msgIdOf = (node) => [...thread.querySelectorAll('.m.user, .m.assistant')].indexOf(node);

  function refreshRpActions() {
    if (!rpState) return;
    const all = [...thread.querySelectorAll('.m.assistant')];
    const hasUser = !!thread.querySelector('.m.user');
    all.forEach((n, i) => {
      const acts = n.querySelector('.acts');
      if (!acts) return;
      acts.textContent = '';
      const cp = el('button', null, '复制'); cp.onclick = () => copyText(rpVisible(n.dataset.text)); acts.appendChild(cp);
      const edit = el('button', null, '编辑');
      edit.disabled = !agentOnline || readonly || !chat?.id || !!chat.running || (!n.dataset.uuid && !n.dataset.greeting);
      if (chat?.running) edit.title = '回复正在生成，完成后才能编辑';
      edit.onclick = () => openReplyEditor(n);
      acts.appendChild(edit);
      if (i !== all.length - 1 || (chat && chat.running)) return;
      if (n.dataset.greeting && !hasUser && rpState.greetings > 1) {
        acts.appendChild(swipeCtl(rpState.greeting, rpState.greetings, (k) => send({ type: 'rp_greeting', chatId: chat.id, index: k })));
      } else if (!n.dataset.greeting) {
        const rg = el('button', null, '↻ 重新生成');
        rg.onclick = () => send({ type: 'rp_regen', chatId: chat.id });
        acts.appendChild(rg);
        if (rpState.swipes && rpState.swipes.count > 1) {
          acts.appendChild(swipeCtl(rpState.swipes.index, rpState.swipes.count, (k) => send({ type: 'rp_swipe', chatId: chat.id, index: k })));
        }
      }
    });
    updateRpEditor();
  }

  function closeReplyEditor() {
    if (rpEditor?.timer) clearTimeout(rpEditor.timer);
    rpEditor = null;
    $('rpEditSheet').classList.add('hidden');
  }
  function updateRpEditor() {
    if (!rpEditor) return;
    const generating = !!chat?.running;
    const unavailable = !agentOnline || !chat || chat.id !== rpEditor.chatId || readonly;
    $('rpEditText').disabled = generating || !!rpEditor.saving;
    $('rpEditSave').disabled = generating || unavailable || !!rpEditor.saving || !$('rpEditText').value.trim();
    $('rpEditCancel').disabled = !!rpEditor.saving;
    $('rpEditSave').textContent = rpEditor.saving ? '保存中…' : '保存';
    $('rpEditHint').textContent = generating ? '回复正在生成，完成后才能编辑或保存。'
      : !agentOnline ? '连接恢复后可以保存，草稿已保留。' : '保存后会用于后续对话。';
  }
  function openReplyEditor(row) {
    if (!chat?.id || !rpState || readonly || chat.running || !agentOnline) return;
    rpEditor = { chatId: chat.id, uuid: row.dataset.uuid || null, greeting: row.dataset.greeting === '1', originalText: row.dataset.text || '', saving: false };
    $('rpEditText').value = rpEditor.originalText;
    $('rpEditError').textContent = '';
    $('rpEditSheet').classList.remove('hidden');
    updateRpEditor();
  }
  $('rpEditText').addEventListener('input', updateRpEditor);
  $('rpEditCancel').onclick = () => { if (!rpEditor?.saving) closeReplyEditor(); };
  $('rpEditSheet').addEventListener('click', event => { if (event.target === $('rpEditSheet') && !rpEditor?.saving) closeReplyEditor(); });
  $('rpEditSave').onclick = () => {
    if (!rpEditor || rpEditor.saving || !chat || chat.id !== rpEditor.chatId || chat.running || readonly || !agentOnline) return;
    const text = $('rpEditText').value;
    if (!text.trim()) return;
    if (text.length > 200000) { $('rpEditError').textContent = '回复内容最多 20 万字符'; return; }
    const requestId = `edit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (!send({ type: 'rp_edit_reply', chatId: rpEditor.chatId, uuid: rpEditor.uuid, greeting: rpEditor.greeting, originalText: rpEditor.originalText, text, requestId })) return;
    rpEditor.saving = true; rpEditor.requestId = requestId;
    $('rpEditError').textContent = '';
    rpEditor.timer = setTimeout(() => finishReplyEdit({ requestId, ok: false, message: '保存确认超时，草稿已保留。请重新打开回复确认是否已保存。' }), 20000);
    updateRpEditor();
  };
  function finishReplyEdit(result) {
    if (!rpEditor || result.requestId !== rpEditor.requestId) return;
    clearTimeout(rpEditor.timer);
    if (result.ok) { closeReplyEditor(); toast('回复已保存'); }
    else { rpEditor.saving = false; $('rpEditError').textContent = result.message || '保存失败，草稿已保留'; updateRpEditor(); }
  }
  function swipeCtl(index, count, go) {
    const w = el('span', 'swipe');
    const prev = el('button', null, '‹'); prev.disabled = index <= 0; prev.onclick = () => go(index - 1);
    const next = el('button', null, '›'); next.disabled = index >= count - 1; next.onclick = () => go(index + 1);
    w.append(prev, el('span', null, `${index + 1}/${count}`), next);
    return w;
  }
  function showVarChanges(changes) {
    const lastA = [...thread.querySelectorAll('.m.assistant')].pop();
    if (!lastA) return;
    const fmt = (v) => (v === undefined ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    const chip = el('div', 'varchip', `变量：${changes.slice(0, 3).map((c) => `${c.path.split('.').pop()} ${fmt(c.from)}→${fmt(c.to)}`).join('，')}${changes.length > 3 ? ` 等 ${changes.length} 项` : ''}`);
    lastA.insertBefore(chip, lastA.querySelector('.acts'));
  }

  // ---------- status-bar frames with a SillyTavern helper (TavernHelper / MVU) compatibility layer ----------
  const SHIM = String.raw`(function(){
    var B = window.__BOOT, vars = B.vars, handlers = {};
    function clone(v){ return JSON.parse(JSON.stringify(v == null ? {} : v)); }
    function post(m){ m.__rpFrame = B.id; parent.postMessage(m, '*'); }
    function get(o, p){ String(p).split(/[.[\]'"]+/).filter(Boolean).forEach(function(k){ o = o == null ? undefined : o[k]; }); return o; }
    window.getVariables = function(){ return clone(vars); };
    window.getAllVariables = window.getVariables;
    window.replaceVariables = function(v){ vars = clone(v); post({ type: 'setvars', vars: vars }); };
    window.insertOrAssignVariables = function(v){ var n = clone(vars); Object.assign(n, v); window.replaceVariables(n); };
    window.updateVariablesWith = function(fn){ var n = fn(clone(vars)) || vars; window.replaceVariables(n); return n; };
    window.getCurrentMessageId = function(){ return B.messageId; };
    window.getLastMessageId = function(){ return B.messages.length - 1; };
    window.getChatMessages = function(r){
      var all = B.messages, last = all.length - 1;
      if (typeof r === 'number') return [all[r < 0 ? last + 1 + r : r]].filter(Boolean);
      var m = /^(-?\d+)-(-?\d+)$/.exec(String(r || '')); if (!m) return all.slice();
      var a = +m[1], b = +m[2]; if (a < 0) a = last + 1 + a; if (b < 0) b = last + 1 + b; return all.slice(a, b + 1);
    };
    window.triggerSlash = function(cmd){ post({ type: 'slash', cmd: String(cmd) }); return Promise.resolve(''); };
    window.triggerSlashWithResult = window.triggerSlash;
    window.substitudeMacros = function(t){ return String(t).replace(/\{\{user\}\}/gi, B.user).replace(/\{\{char\}\}/gi, B.char); };
    window.tavern_events = new Proxy({}, { get: function(_, k){ return String(k); } });
    window.iframe_events = window.tavern_events;
    window.eventOn = function(e, f){ (handlers[e] = handlers[e] || []).push(f); return { stop: function(){ window.eventRemoveListener(e, f); } }; };
    window.eventOnce = window.eventMakeFirst = window.eventMakeLast = window.eventOn;
    window.eventRemoveListener = function(e, f){ handlers[e] = (handlers[e] || []).filter(function(x){ return x !== f; }); };
    window.eventEmit = function(e){ var a = [].slice.call(arguments, 1); (handlers[e] || []).forEach(function(f){ try { f.apply(null, a); } catch (x) { console.error(x); } }); return Promise.resolve(); };
    window.toastr = { success: t, info: t, warning: t, error: t };
    function t(x){ post({ type: 'toast', text: String(x) }); }
    window.Mvu = {
      events: { VARIABLE_UPDATE_STARTED: 'mag_variable_update_started', VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended', SINGLE_VARIABLE_UPDATED: 'mag_variable_updated' },
      getMvuData: function(){ return clone(vars); },
      replaceMvuData: function(d){ window.replaceVariables(d); return Promise.resolve(); },
      getMvuVariable: function(d, p, o){ var v = get(d && d.stat_data ? d.stat_data : d, p); if (Array.isArray(v) && v.length === 2 && typeof v[1] === 'string') v = v[0]; return v === undefined && o ? o.default_value : v; },
      setMvuVariable: function(d, p, val){ var root = d.stat_data || d, ks = String(p).split('.'), o = root; ks.slice(0, -1).forEach(function(k){ o = o[k] = o[k] || {}; }); o[ks[ks.length - 1]] = val; window.replaceVariables(d); return Promise.resolve(true); }
    };
    window.waitGlobalInitialized = function(){ return Promise.resolve(); };
    window.getCharData = function(){ return { name: B.char }; };
    window.SillyTavern = { getContext: function(){ return { name1: B.user, name2: B.char, chat: B.messages.map(function(m){ return { name: m.name, is_user: m.is_user, mes: m.message }; }), chatMetadata: { variables: vars } }; } };
    window.TavernHelper = { getVariables: window.getVariables, replaceVariables: window.replaceVariables, getChatMessages: window.getChatMessages,
      getLastMessageId: window.getLastMessageId, triggerSlash: window.triggerSlash, substitudeMacros: window.substitudeMacros };
    window.addEventListener('message', function(e){
      var d = e.data || {};
      if (d.__rpVars) { vars = d.vars; window.eventEmit('mag_variable_update_ended', clone(vars)); window.eventEmit('message_updated', B.messageId); }
    });
    function report(){ post({ type: 'height', h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) }); }
    window.addEventListener('load', function(){ report(); post({ type: 'ready' }); }); setTimeout(report, 300); setTimeout(report, 1500);
    if (window.ResizeObserver) new ResizeObserver(report).observe(document.documentElement);
  })();`;

  let frameSeq = 0;
  function helperFrame(html, messageId) {
    const id = `f${++frameSeq}`;
    const frame = el('iframe', 'rpframe');
    // scripts run, but in an opaque origin: no access to this page, its cookies or storage
    frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms allow-modals');
    const boot = { id, vars: rpState.vars || {}, user: rpState.user, char: rpCard().name, messageId, messages: rpMessages() };
    const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank">`
      + `<script>window.__BOOT=${JSON.stringify(boot).replace(/</g, '\\u003c')};<\/script>`
      + `<script src="${location.origin}/vendor/jquery.js"><\/script><script src="${location.origin}/vendor/lodash.js"><\/script>`
      + `<script>${SHIM}<\/script><style>html,body{margin:0;background:transparent;color:${getComputedStyle(document.body).color}}</style>`;
    let doc = html;
    if (/<head[^>]*>/i.test(doc)) doc = doc.replace(/<head[^>]*>/i, (h) => h + head);
    else if (/<html[^>]*>/i.test(doc)) doc = doc.replace(/<html[^>]*>/i, (h) => `${h}<head>${head}</head>`);
    else doc = `<!doctype html><html><head>${head}</head><body>${doc}</body></html>`;
    frame.srcdoc = doc;
    frames.set(id, frame);
    return frame;
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || !d.__rpFrame) return;
    const frame = frames.get(d.__rpFrame);
    if (!frame || e.source !== frame.contentWindow) return;
    if (d.type === 'ready' && rpState && frame.isConnected) {
      frame.contentWindow.postMessage({ __rpVars: true, vars: rpState.vars || {} }, '*');
      return;
    }
    if (d.type === 'height') frame.style.height = `${Math.min(Math.max(Number(d.h) || 0, 20), 3000)}px`;
    else if (d.type === 'toast') toast(d.text.slice(0, 200));
    else if (d.type === 'setvars' && chat && rpState) { rpState.vars = d.vars; send({ type: 'rp_setvars', chatId: chat.id, vars: d.vars }); }
    else if (d.type === 'slash') runSlash(d.cmd);
  });

  // the slash commands status bars use to talk back: /send, /trigger, /setinput, /echo
  function runSlash(cmd) {
    const sends = [];
    let trigger = false;
    for (const part of String(cmd).split('|')) {
      const m = /^\s*\/(\w+)\s*([\s\S]*)$/.exec(part);
      if (!m) continue;
      const [, name, arg] = m;
      if (name === 'send' || name === 'sendas') sends.push(arg.replace(/^name=\S+\s*/, ''));
      else if (name === 'trigger') trigger = true;
      else if (name === 'setinput') setDraftText(arg);
      else if (name === 'echo') toast(arg.slice(0, 200));
    }
    if (sends.length || trigger) {
      const text = sends.join('\n').trim();
      if (text) sendText(text); else toast('状态栏请求了生成，但没有要发送的内容');
    }
  }

  // ---------- drawer: RP tab ----------
  function showTab(tab) {
    store.set('dtab', tab);
    document.querySelectorAll('#dtabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $('paneChat').classList.toggle('hidden', tab !== 'chat');
    $('paneRp').classList.toggle('hidden', tab !== 'rp');
    if (tab === 'rp') send({ type: 'rp_list' });
  }
  document.querySelectorAll('#dtabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

  function renderRp() {
    const grid = $('cardGrid');
    grid.textContent = '';
    if (!rpCards.length) {
      const e = el('div', 'sec', '还没有角色卡。点“导入卡片 / 世界书”，选一张酒馆 PNG 或 JSON 卡。');
      e.style.gridColumn = '1 / -1';
      grid.appendChild(e);
    }
    for (const c of rpCards) {
      const b = el('button', 'cardtile');
      b.append(avatarEl(c.id), el('div', 'nm', c.name));
      b.onclick = () => openCardSheet(c.id);
      grid.appendChild(b);
    }
    const box = $('rpRecent');
    box.textContent = '';
    const items = historyList.filter((h) => h.rp);
    if (items.length) box.appendChild(el('div', 'sec', '最近的扮演'));
    for (const h of items) box.appendChild(convRow(h));
  }
  function convRow(h) {
    const b = el('button', 'conv' + (chat && chat.sessionId === h.id ? ' on' : ''));
    const card = rpCards.find((c) => c.id === (h.rp && h.rp.cardId));
    const t = el('div', 'ct');
    t.append(el('span', null, card ? card.name : h.title));
    b.append(t, el('div', 'cm', `${ago(h.updatedAt)} · ${(h.firstPrompt || '').slice(0, 30)}`));
    b.onclick = () => send({ type: 'open', hid: h.id });
    return b;
  }

  $('rpImportBtn').onclick = () => $('rpFile').click();
  $('rpFile').onchange = () => {
    for (const f of $('rpFile').files) {
      if (f.size > 15 * 1024 * 1024) { toast(`${f.name} 超过 15MB`); continue; }
      const r = new FileReader();
      r.onload = () => send({ type: 'rp_import', name: f.name, data: String(r.result).split(',')[1] || '' });
      r.readAsDataURL(f);
    }
    $('rpFile').value = '';
    toast('正在导入…');
  };

  // paste import: JSON text from the clipboard (or a PNG image, if the clipboard kept its card data)
  function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function importText(text) {
    const t = String(text || '').trim();
    if (!t) { toast('剪贴板是空的'); return false; }
    if (!/^[[{]/.test(t)) { toast('粘贴的内容不是角色卡或世界书的 JSON'); return false; }
    send({ type: 'rp_import', name: '粘贴导入.json', data: toBase64(new TextEncoder().encode(t)) });
    toast('正在导入…');
    return true;
  }
  async function pasteImage() {
    if (!navigator.clipboard || !navigator.clipboard.read) return false;
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((x) => x === 'image/png');
      if (!type) continue;
      const bytes = new Uint8Array(await (await item.getType(type)).arrayBuffer());
      send({ type: 'rp_import', name: '粘贴导入.png', data: toBase64(bytes) });
      toast('正在导入…');
      return true;
    }
    return false;
  }
  $('rpPasteBtn').onclick = async () => {
    // Safari shows its own "粘贴" bubble; if reading is refused, fall back to a box the user pastes into
    try {
      const text = navigator.clipboard && navigator.clipboard.readText ? await navigator.clipboard.readText() : '';
      if (text && text.trim()) { importText(text); return; }
      if (await pasteImage()) return;
    } catch { /* permission refused */ }
    $('pasteText').value = '';
    openMSheet('pasteSheet');
  };
  $('pasteCancel').onclick = () => $('pasteSheet').classList.add('hidden');
  $('pasteGo').onclick = () => { if (importText($('pasteText').value)) $('pasteSheet').classList.add('hidden'); };

  // ---------- sheets ----------
  function openMSheet(id) { $(id).classList.remove('hidden'); }
  for (const id of ['cardSheet', 'setSheet', 'bookSheet', 'pasteSheet']) {
    $(id).addEventListener('click', (e) => { if (e.target === $(id)) { $(id).classList.add('hidden'); if (id === 'cardSheet') sheetCardId = null; } });
  }

  function openCardSheet(id) {
    sheetCardId = id; sheetGreeting = 0;
    if (!cardCache[id]) loadCard(id);
    renderCardSheet();
    openMSheet('cardSheet');
  }
  function renderCardSheet() {
    const id = sheetCardId;
    const c = cardCache[id] && cardCache[id].card;
    const meta = rpCards.find((x) => x.id === id) || {};
    const av = $('csAv'); av.dataset.card = id; fillAvatar(av, id);
    renderAvatarControl();
    $('csName').textContent = (c && c.name) || meta.name || '';
    const notes = (c && c.creator_notes) || '';
    $('csNotes').innerHTML = notes ? DOMPurify.sanitize(marked.parse(notes)) : '';
    $('csNotes').classList.remove('open');
    $('csMore').classList.toggle('hidden', notes.length < 200);
    const g = $('csGreetings'); g.textContent = '';
    const n = c ? 1 + c.alternate_greetings.length : meta.greetings || 1;
    for (let i = 0; i < n; i++) {
      const b = el('button', i === sheetGreeting ? 'on' : '', i === 0 ? '默认开场' : `开场 ${i + 1}`);
      b.onclick = () => { sheetGreeting = i; renderCardSheet(); };
      g.appendChild(b);
    }
    $('csBook').classList.toggle('hidden', !(c && c.character_book));
    const hist = historyList.filter((h) => h.rp && h.rp.cardId === id);
    $('csHistTitle').classList.toggle('hidden', !hist.length);
    const hb = $('csHist'); hb.textContent = '';
    for (const h of hist) { const r = convRow(h); r.addEventListener('click', () => $('cardSheet').classList.add('hidden')); hb.appendChild(r); }
  }
  $('csMore').onclick = () => { $('csNotes').classList.add('open'); $('csMore').classList.add('hidden'); };
  function renderAvatarControl() {
    const button = $('csAvatar');
    const hasAvatar = sheetCardId && (cardCache[sheetCardId]?.avatarUrl || rpCards.find(c => c.id === sheetCardId)?.hasAvatar);
    button.textContent = avatarUpload ? '正在上传…' : hasAvatar ? '更换头像' : '上传头像';
    button.disabled = !sheetCardId || !agentOnline || !!avatarUpload;
  }
  $('csAvatar').onclick = () => {
    if (!sheetCardId || !agentOnline || avatarUpload) return;
    $('rpAvatarFile').dataset.cardId = sheetCardId;
    $('rpAvatarFile').click();
  };
  $('rpAvatarFile').onchange = async () => {
    const input = $('rpAvatarFile'), file = input.files[0];
    const cardId = input.dataset.cardId || sheetCardId;
    input.value = ''; delete input.dataset.cardId;
    if (!file || !cardId || avatarUpload) return;
    if (!file.type.startsWith('image/')) return toast('请选择头像图片');
    if (file.size > 10 * 1024 * 1024) return toast('图片超过 10MB，请选择较小的图片');
    const requestId = `avatar-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    avatarUpload = { cardId, requestId, timer: null }; renderAvatarControl();
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('无法读取图片，请使用 PNG、JPG 或 WebP 图片')); image.src = objectUrl; });
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40000000) throw new Error('图片尺寸过大，请选择较小的图片');
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
      const size = Math.min(image.naturalWidth, image.naturalHeight);
      canvas.getContext('2d').drawImage(image, (image.naturalWidth - size) / 2, (image.naturalHeight - size) / 2, size, size, 0, 0, 512, 512);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob || blob.size > 2 * 1024 * 1024) throw new Error('头像转换失败，请选择较小的图片');
      const data = toBase64(new Uint8Array(await blob.arrayBuffer()));
      if (!agentOnline || !send({ type: 'rp_set_avatar', cardId, data, requestId })) throw new Error('电脑未连接，请连接后重新上传');
      avatarUpload.timer = setTimeout(() => finishAvatarUpload({ requestId, ok: false, message: '头像上传确认超时，请稍后查看或重试' }), 20000);
    } catch (error) { finishAvatarUpload({ requestId, ok: false, message: error.message }); }
    finally { URL.revokeObjectURL(objectUrl); }
  };
  function finishAvatarUpload(result) {
    if (!avatarUpload || result.requestId !== avatarUpload.requestId) return;
    clearTimeout(avatarUpload.timer); avatarUpload = null;
    renderAvatarControl();
    toast(result.ok ? '头像已更新' : result.message || '头像上传失败');
  }
  $('csStart').onclick = () => {
    send({ type: 'rp_new', cardId: sheetCardId, greeting: sheetGreeting });
    $('cardSheet').classList.add('hidden');
  };
  $('csBook').onclick = () => send({ type: 'rp_book', bookId: `card-${sheetCardId}` });
  $('csDelete').onclick = () => {
    const name = $('csName').textContent;
    if (!confirm(`删除角色卡「${name}」？已有的扮演记录不会删除，但之后无法继续。`)) return;
    send({ type: 'rp_delete_card', cardId: sheetCardId });
    $('cardSheet').classList.add('hidden');
  };

  function renderSettings() {
    $('psName').value = rpSettings.persona.name || '';
    $('psDesc').value = rpSettings.persona.description || '';
    const box = $('gbList'); box.textContent = '';
    if (!rpBooks.length) box.appendChild(el('div', 'sec', '还没有导入世界书'));
    for (const b of rpBooks) {
      const on = (rpSettings.globalBooks || []).includes(b.id);
      const row = el('div', 'entry');
      const info = el('button', 'ei'); info.style.textAlign = 'left';
      info.append(el('div', 'en', b.name), el('div', 'ek', `${b.entries} 个条目 · 点开管理条目`));
      info.onclick = () => send({ type: 'rp_book', bookId: b.id });
      const del = el('button', 'linkbtn', '删除'); del.style.color = 'var(--bad)';
      del.onclick = () => { if (confirm(`删除世界书「${b.name}」？`)) send({ type: 'rp_delete_book', bookId: b.id }); };
      const sw = el('button', 'sw' + (on ? ' on' : ''));
      sw.onclick = () => {
        const list = new Set(rpSettings.globalBooks || []);
        if (on) list.delete(b.id); else list.add(b.id);
        send({ type: 'rp_settings', globalBooks: [...list] });
      };
      row.append(info, del, sw);
      box.appendChild(row);
    }
  }
  $('rpSettingsBtn').onclick = () => { renderSettings(); openMSheet('setSheet'); send({ type: 'rp_list' }); };
  $('psSave').onclick = () => {
    send({ type: 'rp_settings', persona: { name: $('psName').value.trim() || '用户', description: $('psDesc').value } });
    toast('人设已保存，下一条消息起生效');
  };

  function renderBook(b) {
    $('bkName').textContent = b.name;
    const box = $('bkEntries'); box.textContent = '';
    for (const e of b.entries) {
      const row = el('div', 'entry');
      const info = el('button', 'ei book-entry-open'); info.type = 'button';
      const name = e.comment || '（无标题条目）';
      info.setAttribute('aria-label', `查看条目：${name}`);
      info.append(el('div', 'en', name),
        el('div', 'ek', e.constant ? '常驻 · 查看完整内容' : `关键词：${(e.keys || []).join('、') || '无'} · 查看完整内容`));
      info.onclick = () => openBookEntry(e, info, b.bookId || b.id);
      const sw = el('button', 'sw' + (e.on ? ' on' : '')); sw.type = 'button';
      sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(!!e.on)); sw.setAttribute('aria-label', `启用条目：${name}`);
      sw.onclick = () => { e.on = !e.on; sw.classList.toggle('on', e.on); sw.setAttribute('aria-checked', String(e.on)); send({ type: 'rp_toggle', key: e.key, on: e.on }); };
      row.append(info, sw);
      box.appendChild(row);
    }
    openMSheet('bookSheet');
  }

  function renderBookEntry() {
    const s = bookEntryView; if (!s) return;
    const entry = s.entry;
    $('bookEntryTitle').textContent = entry.comment || '（无标题条目）';
    $('bookEntryMeta').textContent = entry.constant ? '常驻条目 · 只读' : `关键词：${(entry.keys || []).join('、') || '无'} · 只读`;
    $('bookEntryContent').textContent = s.content;
    $('bookEntryContent').classList.toggle('hidden', s.loading || !!s.error);
    $('bookEntryStatus').textContent = s.error || (s.loading ? '正在读取完整条目…' : '');
    $('bookEntryStatus').classList.toggle('error', !!s.error);
    $('bookEntryRetry').classList.toggle('hidden', !s.error);
    $('bookEntryRetry').disabled = !agentOnline;
    $('bookEntryCopy').disabled = s.loading || !!s.error;
  }
  function failBookEntry(message) {
    const s = bookEntryView; if (!s) return;
    clearTimeout(s.timer); s.requestId = null; s.loading = false; s.error = message; renderBookEntry();
  }
  function loadBookEntry() {
    const s = bookEntryView; if (!s) return;
    clearTimeout(s.timer); s.loading = true; s.error = ''; s.requestId = requestId('book-entry'); renderBookEntry();
    if (!agentOnline || !send({ type: 'rp_book_entry', requestId: s.requestId, bookId: s.bookId, key: s.entry.key })) {
      failBookEntry('电脑未连接，连接恢复后可重新加载。'); return;
    }
    const pending = s.requestId;
    s.timer = setTimeout(() => { if (bookEntryView?.requestId === pending) failBookEntry('读取超时，请重新加载条目。'); }, 20000);
  }
  function onBookEntryResult(result) {
    const s = bookEntryView; if (!s || result.requestId !== s.requestId) return;
    clearTimeout(s.timer); s.requestId = null;
    if (!result.ok || typeof result.entry?.content !== 'string') { failBookEntry(result.message || '无法读取此条目，请重新加载。'); return; }
    s.entry = result.entry; s.content = result.entry.content; s.loading = false; s.error = ''; renderBookEntry();
  }
  function openBookEntry(entry, trigger, bookId) {
    if (bookEntryView) clearTimeout(bookEntryView.timer);
    bookEntryFocus = trigger;
    const cached = typeof entry.content === 'string';
    bookEntryView = { bookId, entry, content: cached ? entry.content : '', loading: !cached, error: '', requestId: null, timer: null };
    $('bookEntryContent').scrollTop = 0;
    $('bookEntrySheet').classList.remove('hidden'); $('bookEntryClose').focus();
    if (cached) renderBookEntry(); else loadBookEntry();
  }
  function closeBookEntry() {
    if (bookEntryView) clearTimeout(bookEntryView.timer);
    bookEntryView = null;
    $('bookEntrySheet').classList.add('hidden');
    if (bookEntryFocus?.isConnected) bookEntryFocus.focus();
    bookEntryFocus = null;
  }
  $('bookEntryClose').onclick = closeBookEntry;
  $('bookEntryBack').onclick = closeBookEntry;
  $('bookEntryRetry').onclick = loadBookEntry;
  $('bookEntryCopy').onclick = () => { if (bookEntryView && !bookEntryView.loading && !bookEntryView.error) copyText(bookEntryView.content, '完整条目'); };
  $('bookEntrySheet').onclick = event => { if (event.target === $('bookEntrySheet')) closeBookEntry(); };

  // ---------- boot ----------
  renderEmpty();
  if (document.querySelector('meta[name="session-authenticated"]')?.content === 'true') { showApp(); connect(); }
  else showLogin();
})();
