// mountAiDocsPanel 用の最小 DOM 代替。
//   パネルは #id だけで要素を引き、value / innerHTML / textContent / disabled / style.display /
//   addEventListener しか使わないため、その範囲だけを模す（HTML の解析はしない）。
'use strict';

function makeFakeElement(id) {
  const listeners = {};
  return {
    id, value: '', innerHTML: '', textContent: '', disabled: false, style: {},
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    async dispatch(typeOrEvent) {
      const ev = typeof typeOrEvent === 'string' ? { type: typeOrEvent, target: this } : { target: this, ...typeOrEvent };
      for (const fn of (listeners[ev.type] || [])) await fn(ev);
    },
    listenerCount(type) { return (listeners[type] || []).length; },
  };
}

/** host 要素。querySelector('#id') で子要素スタブを返す（初回アクセス時に生成） */
function makeFakeHost() {
  const children = new Map();
  const host = makeFakeElement('host');
  host.querySelector = (sel) => {
    const id = String(sel).replace(/^#/, '');
    if (!children.has(id)) children.set(id, makeFakeElement(id));
    return children.get(id);
  };
  host.children = children;
  return host;
}

/** `<option value="…">` の value を抜き出す（select の innerHTML 検証用） */
const optionValues = (html) => [...String(html).matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
const unescape = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * mountRoot（タブ構成）用の最小 document（Phase 15）。
 *   innerHTML の id 付き要素と data 属性の操作要素を登録する。data 属性はその host 内の単純な一致だけ。
 *   classList / style / addEventListener / dispatch を模す。HTML の木構造や一般の CSS selector は扱わない。
 */
function makeFakeDocument() {
  const byId = new Map();
  const dataKey = key => key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  function makeEl(tag) {
    const el = { tagName: String(tag).toUpperCase(), id: '', style: {}, dataset: {}, _cls: new Set(), children: [], attrs: {}, listeners: {}, _html: '', textContent: '', value: '', disabled: false, title: '' };
    let dataChildren = [];
    el.classList = {
      toggle(c, on) { if (on === undefined) on = !el._cls.has(c); if (on) el._cls.add(c); else el._cls.delete(c); return on; },
      add(c) { el._cls.add(c); }, remove(c) { el._cls.delete(c); }, contains(c) { return el._cls.has(c); },
    };
    Object.defineProperty(el, 'className', { get: () => [...el._cls].join(' '), set: (v) => { el._cls = new Set(String(v).split(/\s+/).filter(Boolean)); } });
    Object.defineProperty(el, 'innerHTML', {
      get: () => el._html,
      set: (v) => {
        el._html = String(v);
        dataChildren = [];
        for (const m of el._html.matchAll(/<(\w+)([^>]*?)>/g)) {
          const attrs = m[2];
          const idm = /\sid="([^"]+)"/.exec(attrs);
          const data = [...attrs.matchAll(/\sdata-([\w-]+)(?:="([^"]*)")?/g)];
          if (!idm && !data.length) continue;
          if (idm && byId.has(idm[1])) { if (data.length) dataChildren.push(byId.get(idm[1])); continue; }
          const c = makeEl(m[1]); if (idm) c.id = idm[1];
          const cls = /\sclass="([^"]*)"/.exec(attrs); if (cls) c.className = cls[1];
          const st = /\sstyle="([^"]*)"/.exec(attrs); if (st && /display:\s*none/.test(st[1])) c.style.display = 'none';
          const ttl = /\stitle="([^"]*)"/.exec(attrs); if (ttl) c.title = ttl[1];
          for (const item of data) { c.dataset[dataKey(item[1])] = item[2] || ''; c.attrs['data-' + item[1]] = item[2] || ''; }
          if (idm) byId.set(c.id, c);
          if (data.length) dataChildren.push(c);
        }
      },
    });
    const matchingData = sel => {
      const match = /^\[data-([\w-]+)(?:="([^"]*)")?\]$/.exec(String(sel));
      return match ? dataChildren.filter(child => Object.hasOwn(child.dataset, dataKey(match[1])) && (match[2] === undefined || child.dataset[dataKey(match[1])] === match[2])) : [];
    };
    el.querySelector = (sel) => { const m = /^#([\w-]+)$/.exec(String(sel)); return m ? (byId.get(m[1]) || null) : matchingData(sel)[0] || null; };
    el.querySelectorAll = matchingData;
    el.addEventListener = (t, fn) => { (el.listeners[t] = el.listeners[t] || []).push(fn); };
    el.dispatch = async (t, ev = {}) => { for (const fn of (el.listeners[t] || [])) await fn({ type: t, target: el, ...ev }); };
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
    el.appendChild = (c) => { el.children.push(c); return c; };
    el.remove = () => { };
    el.replaceWith = () => { };
    return el;
  }
  const doc = {
    createElement: (t) => makeEl(t),
    body: makeEl('body'), head: makeEl('head'),
    querySelector: (s) => { const m = /^#([\w-]+)$/.exec(String(s)); return m ? (byId.get(m[1]) || null) : null; },
    getElementById: (id) => byId.get(id) || null,
    documentElement: { matches: () => false },
    addEventListener: () => { },
  };
  return { doc, byId, makeEl };
}

module.exports = { makeFakeElement, makeFakeHost, makeFakeDocument, optionValues, unescape };
