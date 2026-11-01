(function(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClaudeFilePaths = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function normalizePath(value) {
    if (typeof value !== 'string') return null;
    value = value.trim();
    if (!/^[a-z]:[\\/]/i.test(value) || /[\x00-\x1f<>"|?*]/.test(value) || value.slice(2).includes(':')) return null;
    const tail = value.slice(2).replace(/[\\/]+/g, '\\');
    if (tail === '\\') return null;
    return value[0].toUpperCase() + ':' + tail;
  }

  function pathFromHref(href) {
    if (typeof href !== 'string') return null;
    let value = href.trim();
    if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
    if (/^file:/i.test(value)) {
      let url;
      try { url = new URL(value); } catch { return null; }
      if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return null;
      try { value = decodeURIComponent(url.pathname); } catch { return null; }
      if (/^\/[a-z]:[\\/]/i.test(value)) value = value.slice(1);
    } else {
      // A raw Windows path may legitimately contain %, so leave malformed escapes literal.
      try { value = decodeURIComponent(value); } catch { /* literal percent in filename */ }
    }
    return normalizePath(value);
  }

  function trimProse(value) {
    value = value.replace(/[.,;!?，。；！？、：…]+$/g, '');
    const pairs = { ')': '(', ']': '[', '}': '{', '）': '（', '】': '【', '」': '「', '』': '『' };
    while (pairs[value.slice(-1)]) {
      const close = value.slice(-1), open = pairs[close];
      const count = char => value.split(char).length - 1;
      if (count(close) <= count(open)) break;
      value = value.slice(0, -1).replace(/[.,;!?，。；！？、：…]+$/g, '');
    }
    return value;
  }

  function extractPaths(text) {
    if (typeof text !== 'string' || !text) return [];
    const masked = new Uint8Array(text.length), found = [];
    const mask = (start, end) => masked.fill(1, start, end);
    const add = (index, value) => { if (value) found.push({ index, value }); };

    // Resolve complete Markdown targets before scanning prose or code in their labels.
    for (let marker = text.indexOf(']('); marker >= 0; marker = text.indexOf('](', marker + 2)) {
      const start = text.lastIndexOf('[', marker);
      if (start < 0 || text.slice(start, marker).includes('\n')) continue;
      let cursor = marker + 2;
      while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++;
      const targetStart = cursor;
      let end = -1, target;
      if (text[cursor] === '<') {
        const angle = text.indexOf('>', cursor + 1);
        if (angle < 0 || text.slice(cursor, angle).includes('\n')) continue;
        end = text.indexOf(')', angle + 1);
        if (end < 0 || text.slice(angle, end).includes('\n')) continue;
        target = text.slice(cursor + 1, angle);
      } else {
        let depth = 1, quote = null;
        for (; cursor < text.length && text[cursor] !== '\n'; cursor++) {
          const char = text[cursor];
          if (quote) { if (char === quote) quote = null; continue; }
          if ((char === '"' || char === "'") && /\s/.test(text[cursor - 1] || '')) { quote = char; continue; }
          if (char === '(') depth++;
          if (char === ')' && --depth === 0) { end = cursor; break; }
        }
        if (end < 0) continue;
        target = text.slice(targetStart, end).trim().replace(/\s+(["'])[\s\S]*\1\s*$/, '');
      }
      add(start, pathFromHref(target));
      mask(start, end + 1);
      marker = end;
    }

    // Inline code is an explicit boundary: preserve spaces and punctuation in the filename.
    const code = /(`+)([^\r\n]*?)\1/g;
    let match;
    while ((match = code.exec(text))) {
      if (masked[match.index]) continue;
      const value = match[2].trim();
      add(match.index, /^file:/i.test(value) ? pathFromHref(value) : normalizePath(value));
      mask(match.index, code.lastIndex);
    }

    // External URLs can contain D:/ in either a pathname or query; they are never local references.
    const external = /\b(?:https?|ftp|javascript):[^\s<>`]+/gi;
    while ((match = external.exec(text))) mask(match.index, external.lastIndex);
    const fileUrl = /\bfile:[^\s<>"`,;!，。；！？、：…]+/gi;
    while ((match = fileUrl.exec(text))) {
      if (!masked[match.index]) add(match.index, pathFromHref(trimProse(match[0])));
      mask(match.index, fileUrl.lastIndex);
    }

    const plain = /[a-z]:[\\/][^\s<>"`|,;!，。；！？、：…]+/gi;
    while ((match = plain.exec(text))) {
      if (masked[match.index] || /[a-z0-9_\/:\\]/i.test(text[match.index - 1] || '')) continue;
      // Do not include a marked-out span that happens to touch this prose candidate.
      let end = plain.lastIndex;
      for (let i = match.index; i < end; i++) if (masked[i]) { end = i; break; }
      add(match.index, normalizePath(trimProse(text.slice(match.index, end))));
    }
    const seen = new Set();
    return found.sort((a, b) => a.index - b.index).filter(item => {
      const key = item.value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).map(item => item.value);
  }

  return { extractPaths, pathFromHref };
});
