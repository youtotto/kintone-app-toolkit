/*
 * MIT License
 *
 * Copyright (c) 2026 Yuto Kawai (Nest Rec)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */
/* Read-only saved form preview. Layout matching and visual conventions adapted
 * from kintone Config Lens v0.9.2, fa9a942024c7947c3766414d5e6a2d254940260d.
 * The upstream MIT notice is included below by the build preparation script. */
'use strict';
const KTReleaseConfigLensLayout = (() => {
  const Lens = typeof KTConfigLensCompare !== 'undefined' ? KTConfigLensCompare : require('./vendor/config-lens-compare.js').KTConfigLensCompare;
  const { stable, flatten } = Lens;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function layoutIndex(layout) {
    const nodes = [], counts = new Map();
    function walk(items, path = []) {
      (items || []).forEach((node, index) => {
        const position = [...path, index];
        if (node.type !== 'ROW') {
          const identity = node.code ? 'code:' + node.code : node.elementId ? 'element:' + node.elementId : '';
          nodes.push({ node, position, identity });
          if (identity) counts.set(identity, (counts.get(identity) || 0) + 1);
        }
        if (node.fields) walk(node.fields, [...position, 'fields']);
        if (node.layout) walk(node.layout, [...position, 'layout']);
      });
    }
    walk(layout);
    return new Map(nodes.map(item => [item.identity && counts.get(item.identity) === 1 ? item.identity : 'slot:' + item.position.join('/'), item]));
  }
  function layoutMarks(before, after, beforeFields = {}, afterFields = {}) {
    const sides = [layoutIndex(before), layoutIndex(after)], marks = [new Map(), new Map()];
    const properties = [flatten(beforeFields), flatten(afterFields)];
    for (const key of new Set([...sides[0].keys(), ...sides[1].keys()])) {
      const a = sides[0].get(key), b = sides[1].get(key), reasons = [];
      if (a && b) {
        if (stable(a.position) !== stable(b.position)) reasons.push('配置位置');
        const own = ({ fields, layout, ...rest }) => rest;
        if (stable(own(a.node)) !== stable(own(b.node))) reasons.push('寸法・部品');
        if (a.node.code && stable(properties[0].get(a.node.code)) !== stable(properties[1].get(b.node.code))) reasons.push('項目設定');
      }
      [a, b].forEach((item, side) => {
        if (item) marks[side].set(item.position.join('/'), { key, kind: !a ? 'added' : !b ? 'deleted' : reasons.length ? 'changed' : '',
          text: !a ? '追加' : !b ? '削除予定' : reasons.join('・'), anonymous: key.startsWith('slot:') });
      });
    }
    return marks;
  }
  const dimension = (value, fallback) => /^\d+(\.\d+)?$/.test(String(value)) ? Math.max(20, Math.min(3000, Number(value))) : fallback;
  function validateTree(settings) {
    let count = 0;
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    function visit(nodes, depth, layout) {
      if (depth > 40 || (layout ? !Array.isArray(nodes) : !object(nodes))) throw new Error('Invalid form');
      for (const node of Object.values(nodes)) {
        if (!object(node) || typeof node.type !== 'string' || ++count > 10000) throw new Error('Invalid form');
        if (node.fields !== undefined) visit(node.fields, depth + 1, layout);
        if (node.layout !== undefined) visit(node.layout, depth + 1, true);
        if (node.options !== undefined && (!object(node.options) || Object.values(node.options).some(option => !object(option)))) throw new Error('Invalid options');
      }
    }
    visit(settings.layout.layout, 0, true); visit(settings.fields.properties, 0, false);
  }
  function render(comparison, labels, zoom = 75, busy = false) {
    const valid = comparison && ['before', 'after'].every(side => {
      try {
        for (const id of ['layout', 'fields']) Lens.validateResponse(Lens.CATEGORIES.find(c => c.id === id), comparison[side]?.[id]);
        validateTree(comparison[side]);
        return true;
      } catch { return false; }
    });
    if (!valid) return '<p class="ktcl-warning" data-cl-layout-unavailable>フォーム配置には、両側の配置とフォーム項目の取得が必要です。未取得・取得失敗の範囲は空のフォームとして表示しません。</p>';
    const sides = [comparison.before, comparison.after], layouts = sides.map(s => s.layout.layout);
    const maps = sides.map(s => flatten(s.fields.properties));
    const marks = layoutMarks(...layouts, ...sides.map(s => s.fields.properties));
    const scale = [50, 75, 100].includes(Number(zoom)) ? Number(zoom) : 75;
    function paint(nodes, side, path = []) {
      return nodes.map((node, index) => {
        const position = [...path, index];
        if (node.type === 'ROW') return '<div class="ktcl-layout-row">' + paint(node.fields || [], side, [...position, 'fields']) + '</div>';
        const properties = maps[side].get(node.code)?.settings || {}, container = ['GROUP', 'SUBTABLE'].includes(node.type);
        const mark = marks[side].get(position.join('/'));
        const selectable = node.code && mark && !mark.anonymous;
        const interaction = selectable ? ' data-cl-layout-match="' + esc(mark.key) + '" role="' + (container ? 'group' : 'button') + '" tabindex="' + (busy ? '-1' : '0') + '" aria-label="' + esc((properties.label || node.code) + '（' + node.code + '）の対応位置を強調') + '" aria-disabled="' + busy + '"' + (container ? '' : ' aria-pressed="false"') : '';
        let html = '<div class="ktcl-layout-node' + (container ? ' ktcl-layout-container' : '') + (mark?.kind ? ' ktcl-layout-' + mark.kind : '') + '" data-cl-layout-code="' + esc(node.code || '') + '" data-cl-layout-key="' + esc(mark?.key) + '" data-cl-layout-position="' + position.join('/') + '"' + interaction + ' style="' +
          (!container ? 'width:' + dimension(node.size?.width, 200) + 'px;' : '') + (node.size?.height ? 'min-height:' + dimension(node.size.height, 60) + 'px;' : '') + '">';
        if (node.code) {
          html += '<h4>' + esc(properties.label || node.code) + '</h4>';
          html += '<span class="ktcl-layout-code">' + esc(node.code + ' · ' + Lens.format(node.type, ['type'])) + '</span>';
        }
        if (container) html += node.type === 'GROUP' ? paint(node.layout || [], side, [...position, 'layout']) : '<div class="ktcl-layout-row">' + paint(node.fields || [], side, [...position, 'fields']) + '</div>';
        else if (node.type === 'LABEL') html += '<div class="ktcl-layout-label" data-cl-layout-label>' + esc(node.label || '') + '</div>';
        else if (node.type === 'HR') html += '<hr>';
        else if (node.type === 'SPACER') html += '<div class="ktcl-layout-space">スペース</div>';
        else {
          html += '<div class="ktcl-layout-input"' + (node.size?.innerHeight ? ' style="min-height:' + dimension(node.size.innerHeight, 60) + 'px"' : '') + '>' + '</div>';
        }
        return html + '</div>';
      }).join('');
    }
    return '<section class="ktcl-layout" aria-label="フォーム配置の比較">' + styles() +
      '<div class="ktcl-layout-tools"><label>表示倍率 <select data-cl-layout-zoom aria-label="レイアウト表示倍率"' + (busy ? ' disabled' : '') + '>' + [50,75,100].map(value => '<option value="' + value + '"' + (value === scale ? ' selected' : '') + '>' + value + '%</option>').join('') + '</select></label>' +
      '<details class="ktcl-layout-help" data-cl-disclosure="layout-help"><summary>表示について</summary>' +
      '<p class="ktcl-layout-note">保存済みのPC用フォーム配置と、フィールド名・コード・タイプを表示します。選択肢・必須表示・寸法の数値は省略しています。未保存の編集・レコード値・JS/CSS・プラグインによる見た目は含みません。</p>' +
      '<p class="ktcl-layout-note">黄：配置位置・寸法・項目設定の変更 ／ 緑：追加 ／ 赤：削除。項目をクリックすると左右の同じコードを強調します。IDのない部品は同じ行・列で比較します。ラベルは文字だけ、グループは展開して表示します。</p>' +
      '</details></div>' +
      '<div class="ktcl-layout-pair">' + layouts.map((nodes, side) => {
        const title = labels[side ? 'after' : 'before'];
        return '<section class="ktcl-layout-side"><h4>' + esc(title) + '</h4><div class="ktcl-layout-scroll" data-cl-layout-side="' + side + '" tabindex="0" role="region" aria-label="' + esc(title + 'の配置') + '"><div class="ktcl-layout-canvas" style="zoom:' + scale / 100 + '">' + (nodes.length ? paint(nodes, side) : '<p>配置された項目はありません。</p>') + '</div></div></section>';
      }).join('') + '</div></section>';
  }
  function hydrate(host) {
    for (const label of host.querySelectorAll('[data-cl-layout-label]')) {
      // Only text escapes the inert template: source elements/URLs never enter the live document.
      const template = host.ownerDocument.createElement('template');
      template.innerHTML = label.textContent.replace(/<br\s*\/?\s*>/gi, '\n');
      template.content.querySelectorAll('script,style').forEach(node => node.remove());
      label.textContent = template.content.textContent;
    }
  }
  function highlight(host, key, scroll = false) {
    for (const node of host.querySelectorAll('[data-cl-layout-key]')) {
      const selected = node.getAttribute('data-cl-layout-key') === key;
      node.classList.toggle('ktcl-layout-selected', selected);
      if (node.hasAttribute('data-cl-layout-match')) {
        node.setAttribute('aria-current', String(selected));
        if (node.getAttribute('role') === 'button') node.setAttribute('aria-pressed', String(selected));
      }
      if (selected && scroll) {
        // Scroll each pane only; keep the page and the keyboard focus stationary.
        const pane = node.closest('.ktcl-layout-scroll'), box = node.getBoundingClientRect(), bounds = pane.getBoundingClientRect();
        pane.scrollLeft += box.left - bounds.left - 16;
        pane.scrollTop += box.top - bounds.top - 16;
      }
    }
  }
  function styles() {
    return '<style>' +
      '.ktcl-layout{margin:6px 0;min-width:0}.ktcl-layout-note{font-size:12px;color:var(--kt-muted,#58677d);margin:6px 0!important}.ktcl-layout-tools{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px 18px;margin:6px 0 8px;font-size:12px}.ktcl-layout-tools>label{display:flex;align-items:center;gap:8px}.ktcl-layout-help{color:var(--kt-muted,#58677d)}.ktcl-layout-help summary{cursor:pointer}.ktcl-layout-help[open]{flex-basis:100%;order:1}.ktcl-layout-tools select{font:inherit;color:inherit;background:var(--kt-paper,#fff);border:1px solid var(--kt-line,#dbe2ec);padding:4px;border-radius:4px}' +
      '.ktcl-layout-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;min-width:0}.ktcl-layout-side{border:1px solid var(--kt-line,#dbe2ec);border-radius:7px;overflow:hidden;min-width:0}.ktcl-layout-side>h4{padding:10px 12px;margin:0;background:var(--kt-soft,#f5f7fb);font-size:13px}.ktcl-layout-scroll{overflow:auto;max-height:56vh;background:var(--kt-soft,#f5f7fb);padding:14px}.ktcl-layout-scroll:focus-visible{outline:2px solid var(--kt-accent,#285fbd);outline-offset:-2px}.ktcl-layout-canvas{width:max-content;min-width:100%}.ktcl-layout-row{display:flex;align-items:flex-start;gap:8px;margin-bottom:12px;width:max-content;min-height:20px}' +
      '.ktcl-layout-node{position:relative;box-sizing:border-box;padding:10px;border:1px solid var(--kt-line,#ccd7e4);border-radius:5px;background:var(--kt-paper,#fff);flex:none;overflow-wrap:anywhere}.ktcl-layout-node h4{font-size:14px;margin:0 0 6px;line-height:1.4}.ktcl-layout-code{font-size:10px;color:var(--kt-muted,#58677d);display:block;margin:4px 0}.ktcl-layout-input{border:1px solid var(--kt-line,#bccada);border-radius:3px;background:var(--kt-soft,#f5f7fb);color:var(--kt-muted,#58677d);padding:7px;min-height:34px;font-size:12px;white-space:pre-wrap;overflow:hidden}.ktcl-layout-container{width:max-content;min-width:240px;margin-bottom:12px;background:var(--kt-soft,#f5f7fb)}.ktcl-layout-container>.ktcl-layout-row{margin-bottom:0}.ktcl-layout-label{white-space:pre-wrap}.ktcl-layout-space{border:1px dashed var(--kt-muted,#78889c);color:var(--kt-muted,#58677d);min-height:32px;text-align:center}' +
      '.ktcl-layout-node.ktcl-layout-added{border:2px solid var(--kt-success,#24634f)}.ktcl-layout-node.ktcl-layout-deleted{border:2px solid var(--kt-danger,#9d3d22)}.ktcl-layout-node.ktcl-layout-changed{border:2px solid var(--kt-warning,#805c15)}.ktcl-layout-node.ktcl-layout-selected{outline:3px solid var(--kt-accent,#285fbd);outline-offset:2px}.ktcl-view [data-cl-layout-match]{cursor:pointer}.ktcl-view [data-cl-layout-match][aria-disabled="true"]{cursor:default}.ktcl-view [data-cl-layout-match]:focus-visible{outline:3px solid var(--kt-accent,#285fbd);outline-offset:2px}.ktcl-view [data-cl-layout-match]:hover{border-color:var(--kt-accent,#285fbd)}' +
      '@media(max-width:760px){.ktcl-layout-pair{grid-template-columns:minmax(0,1fr)}}' + '</style>';
  }
  return { render, hydrate, highlight, layoutIndex, layoutMarks, dimension };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseConfigLensLayout };
