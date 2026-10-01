// mountAiDocsPanel 用の最小 DOM 代替。
//   パネルは #id だけで要素を引き、value / innerHTML / textContent / disabled / style.display /
//   addEventListener しか使わないため、その範囲だけを模す（HTML の解析はしない）。
'use strict';

function makeFakeElement(id) {
  const listeners = {};
  return {
    id, value: '', innerHTML: '', textContent: '', disabled: false, style: {},
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    async dispatch(type) { for (const fn of (listeners[type] || [])) await fn({ type, target: this }); },
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

module.exports = { makeFakeElement, makeFakeHost, optionValues, unescape };
