// ==UserScript==
// @name         kintone App Toolkit: Health Check + Field Inventory + Filter
// @namespace    https://github.com/youtotto/kintone-app-toolkit
// @version      1.2.0
// @description  kintoneアプリのヘルスチェック、フィールド一覧、一覧のフィルター/ソート表示
// @match        https://*.cybozu.com/k/*/
// @icon         https://www.google.com/s2/favicons?sz=64&domain=cybozu.com
// @run-at       document-idle
// @grant        none
// @license      MIT
// @updateURL    https://github.com/youtotto/kintone-app-toolkit/raw/refs/heads/main/kintoneAppToolkit.user.js
// @downloadURL  https://github.com/youtotto/kintone-app-toolkit/raw/refs/heads/main/kintoneAppToolkit.user.js
// ==/UserScript==
(function () {
  'use strict';

  /** ----------------------------
 * readiness / api helpers
 * ---------------------------- */
  const appReady = () => typeof kintone !== 'undefined' && kintone.api && kintone.app;
  const waitReady = () => new Promise(res => {
    const t = setInterval(() => { if (appReady()) { clearInterval(t); res(); } }, 50);
    setTimeout(() => { clearInterval(t); res(); }, 10000);
  });
  const api = (path, params) => kintone.api(kintone.api.url(path, true), 'GET', params);
  const escHTML = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

  /** ----------------------------
 * CONSTANTS
 * ---------------------------- */
  const CONTAINER_TYPES = new Set(['GROUP', 'SUBTABLE', 'LABEL']);
  const SYSTEM_TYPES = new Set(['RECORD_NUMBER', 'CREATOR', 'CREATED_TIME', 'MODIFIER', 'UPDATED_TIME', 'STATUS', 'STATUS_ASSIGNEE']);

  // Health thresholds (edit-able; persisted to LS)
  const LS_TH_KEY = 'ktHealthThresholds.v1';
  const DEFAULT_TH = {
    totalFields: { Y: 100, R: 200, label: 'フォーム総フィールド数' },
    states: { Y: 10, R: 12, label: 'プロセス状態数' },
    actions: { Y: 15, R: 18, label: 'プロセスアクション数' }
  };
  const loadTH = () => {
    try {
      const j = JSON.parse(localStorage.getItem(LS_TH_KEY) || '{}');
      return Object.fromEntries(Object.keys(DEFAULT_TH).map(k => {
        const v = j[k] || {};
        return [k, { Y: Number(v.Y ?? DEFAULT_TH[k].Y), R: Number(v.R ?? DEFAULT_TH[k].R), label: DEFAULT_TH[k].label }];
      }));
    } catch { return structuredClone(DEFAULT_TH); }
  };
  const saveTH = th => localStorage.setItem(LS_TH_KEY, JSON.stringify(th));

  const judge = (val, { Y, R }) =>
    val >= R ? { level: 'RED', badge: '🔴' } :
      val >= Y ? { level: 'YELLOW', badge: '🟡' } :
        { level: 'OK', badge: '🟢' };

  /** ----------------------------
 * Small utils
 * ---------------------------- */
  const getUrlParam = (key) => new URL(location.href).searchParams.get(key);
  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** ----------------------------
 * UI Root (tabs)
 * ---------------------------- */
  const mountRoot = () => {
    const wrap = document.createElement('div');
    wrap.id = 'kt-toolkit';
    wrap.style.cssText = `
      position:fixed; right:16px; bottom:16px; z-index:99999;
      background:#111; color:#fff; border-radius:12px; box-shadow:0 8px 30px rgba(0,0,0,.35);
      font:12px/1.5 ui-sans-serif,system-ui; width:min(920px, 95vw); max-height:80vh; overflow:auto;
      border:1px solid #2a2a2a;
    `;
    wrap.innerHTML = `
      <style>
        #kt-toolkit .bar{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #2a2a2a;}
        #kt-toolkit .tabs{display:flex;gap:6px;flex-wrap:wrap}
        #kt-toolkit .tab{padding:6px 10px;border:1px solid #2a2a2a;background:#1d1d1d;color:#fff;border-radius:8px;cursor:pointer}
        #kt-toolkit .tab.active{background:#2563eb;border-color:#2563eb}
        #kt-toolkit .btn{padding:6px 10px;border:1px solid #2a2a2a;background:#1d1d1d;color:#fff;border-radius:8px;cursor:pointer}
        #kt-toolkit .body{padding:12px}
        /* label≠code 行のハイライト */
        #kt-toolkit .hl-diff td { background: rgba(255, 196, 0, 0.12); }
        #kt-toolkit .hl-diff td:nth-child(1),
        #kt-toolkit .hl-diff td:nth-child(2) { font-weight: 600; }
        #kt-toolkit table{border-collapse:collapse;width:100%}
        #kt-toolkit th{ text-align:left;padding:6px;border-bottom:1px solid #333;position:sticky;top:0;background:#111}
        #kt-toolkit td{ padding:6px;border-bottom:1px solid #222}
        /* 必須列（Fieldsプレビューの3列目）固定 */
        #kt-fields th:nth-child(3), #kt-fields td:nth-child(3){ min-width:64px; text-align:center; white-space:nowrap; }
      </style>
      <div class="bar">
        <div class="tabs">
          <button id="tab-health" class="tab active">Health</button>
          <button id="tab-fields" class="tab">Fields</button>
          <button id="tab-views"  class="tab">Views</button>
          <!--
          <button id="tab-graphs" class="tab">Graphs</button>
          -->
        </div>
        <div>
          <button id="kt-close" class="btn">×</button>
        </div>
      </div>
      <div class="body">
        <div id="view-health"></div>
        <div id="view-fields" style="display:none"></div>
        <div id="view-views"  style="display:none"></div>
        <!--
        <div id="view-graphs" style="display:none"></div>
        -->
      </div>
    `;
    document.body.appendChild(wapCheck(wrap));
    wrap.querySelector('#kt-close').addEventListener('click', () => wrap.remove(), { passive: true });
    const switchTab = (idShow) => {
      wrap.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
      wrap.querySelector('#tab-' + idShow).classList.add('active');
      wrap.querySelector('#view-health').style.display = idShow === 'health' ? 'block' : 'none';
      wrap.querySelector('#view-fields').style.display = idShow === 'fields' ? 'block' : 'none';
      wrap.querySelector('#view-views').style.display = idShow === 'views' ? 'block' : 'none';
      //wrap.querySelector('#view-graphs').style.display = idShow === 'graphs' ? 'block' : 'none';
    };
    wrap.querySelector('#tab-health').addEventListener('click', () => switchTab('health'), { passive: true });
    wrap.querySelector('#tab-fields').addEventListener('click', () => switchTab('fields'), { passive: true });
    wrap.querySelector('#tab-views').addEventListener('click', () => switchTab('views'), { passive: true });
    //wrap.querySelector('#tab-graphs').addEventListener('click', () => switchTab('graphs'), { passive: true });
    return wrap;

  };

  // safety: if DOM node detached before append
  function wapCheck(el) { return el; }

  /** ----------------------------
 * Health view
 * ---------------------------- */
  const renderHealth = async (root, appId) => {
    let TH = loadTH();

    // fetch metrics (best-effort for optional endpoints)
    const [fields, status, views, notifs, customize, acl] = await Promise.all([
      api('/k/v1/app/form/fields', { app: appId }),
      api('/k/v1/app/status', { app: appId }),
      api('/k/v1/app/views', { app: appId }).catch(() => null),
      api('/k/v1/app/notifications/general.json', { app: appId }).catch(() => null),
      api('/k/v1/app/customize', { app: appId }).catch(() => null),
      api('/k/v1/app/acl', { app: appId }).catch(() => null),
    ]);

    const props = Object.values(fields.properties || {});
    const flatten = arr => arr.flatMap(p => p.type === 'SUBTABLE' ? [p, ...Object.values(p.fields)] : [p]);
    const list = flatten(props);
    const metrics = {
      totalFields: list.length,
      groups: list.filter(f => f.type === 'GROUP').length,
      subtables: list.filter(f => f.type === 'SUBTABLE').length,
      subtableColsMax: Math.max(0, ...props.filter(f => f.type === 'SUBTABLE').map(t => Object.keys(t.fields).length)),
      states: Object.keys(status.states || {}).length,
      actions: (status.actions || []).length,
      views: views ? Object.keys(views.views || {}).length : null,
      notifications: notifs ? (notifs.notifications || []).length : null,
      jsFiles: customize ? (customize.desktop.js || []).length : null,
      cssFiles: customize ? (customize.desktop.css || []).length : null,
      roles: acl ? (acl.rights || []).length : null
    };
    const score = {
      totalFields: judge(metrics.totalFields, TH.totalFields),
      states: judge(metrics.states, TH.states),
      actions: judge(metrics.actions, TH.actions),
    };

    const el = root.querySelector('#view-health');
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
        <div style="font-weight:700">App Health（読み取り専用）</div>
        <div style="display:flex;gap:6px">
          <button id="kt-copy" class="btn">Copy</button>
          <button id="kt-th" class="btn">基準</button>
        </div>
      </div>

      <div id="kt-summary">
        <table style="max-width:480px;margin-bottom:8px">
          <tr><td>Fields</td><td>${metrics.totalFields} / Group: ${metrics.groups} / SubTable: ${metrics.subtables} (maxCols: ${metrics.subtableColsMax})</td></tr>
          <tr><td>States/Actions</td><td>${metrics.states} / ${metrics.actions}</td></tr>
          <tr><td>Views/Notifs</td><td>${metrics.views ?? '-'} / ${metrics.notifications ?? '-'}</td></tr>
          <tr><td>JS/CSS</td><td>${metrics.jsFiles ?? '-'} / ${metrics.cssFiles ?? '-'}</td></tr>
          <tr><td>ACL rules</td><td>${metrics.roles ?? '-'}</td></tr>
        </table>

        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <div><strong>Fields</strong>：${score.totalFields.badge} ${score.totalFields.level}</div>
          <div><strong>States</strong>：${score.states.badge} ${score.states.level}</div>
          <div><strong>Actions</strong>：${score.actions.badge} ${score.actions.level}</div>
        </div>
      </div>

      <div id="kt-th-panel" style="display:none;margin-top:10px">
        <div style="opacity:.85;margin-bottom:6px">基準（しきい値）：Y=注意 / R=分割推奨。保存するとLocalStorageに記録されます。</div>
        <table style="max-width:520px">
          <thead>
            <tr><th>指標</th><th style="text-align:right">Y</th><th style="text-align:right">R</th></tr>
          </thead>
          <tbody id="kt-th-rows"></tbody>
        </table>
        <div style="margin-top:8px;display:flex;gap:8px;justify-content:flex-end">
          <button id="kt-th-reset" class="btn">初期化</button>
          <button id="kt-th-save"  class="btn" style="background:#2563eb;border-color:#2563eb">保存</button>
        </div>
      </div>
    `;

    const rowsEl = el.querySelector('#kt-th-rows');
    const renderTHRows = () => {
      rowsEl.innerHTML = Object.entries(TH).map(([k, v]) => `
        <tr data-key="${k}">
          <td>${v.label}</td>
          <td style="text-align:right"><input type="number" min="0" value="${v.Y}"
            style="width:64px;background:#0f0f0f;color:#fff;border:1px solid #333;border-radius:6px;padding:4px 6px"></td>
          <td style="text-align:right"><input type="number" min="0" value="${v.R}"
            style="width:64px;background:#0f0f0f;color:#fff;border:1px solid #333;border-radius:6px;padding:4px 6px"></td>
        </tr>
      `).join('');
    };
    renderTHRows();

    const summaryText = `App ${appId}
           Fields: ${metrics.totalFields} (Group: ${metrics.groups}, SubTable: ${metrics.subtables}, maxCols:${metrics.subtableColsMax})
           States/Actions: ${metrics.states}/${metrics.actions}
           Views/Notifications: ${metrics.views}/${metrics.notifications}
           Customize JS/CSS: ${metrics.jsFiles}/${metrics.cssFiles}
           ACL rules: ${metrics.roles}
           判定: Fields=${score.totalFields.level}, States=${score.states.level}, Actions=${score.actions.level}`;

    el.querySelector('#kt-copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(summaryText);
      const b = el.querySelector('#kt-copy'); const old = b.textContent; b.textContent = 'Copied!';
      setTimeout(() => b.textContent = old, 1200);
    }, { passive: true });

    el.querySelector('#kt-th').addEventListener('click', () => {
      const p = el.querySelector('#kt-th-panel'), s = el.querySelector('#kt-summary');
      const show = p.style.display === 'none';
      p.style.display = show ? 'block' : 'none';
      s.style.display = show ? 'none' : 'block';
    }, { passive: true });

    el.querySelector('#kt-th-reset').addEventListener('click', () => {
      TH = loadTH(); renderTHRows();
    }, { passive: true });

    el.querySelector('#kt-th-save').addEventListener('click', () => {
      [...rowsEl.querySelectorAll('tr')].forEach(tr => {
        const key = tr.dataset.key;
        const [yEl, rEl] = tr.querySelectorAll('input');
        const Y = Math.max(0, Number(yEl.value || 0));
        const R = Math.max(0, Number(rEl.value || 0));
        TH[key].Y = Math.min(Y, R);
        TH[key].R = Math.max(R, Y);
      });
      saveTH(TH);
      const b = el.querySelector('#kt-th-save'); const old = b.textContent; b.textContent = '保存しました';
      setTimeout(() => b.textContent = old, 1200);
    }, { passive: true });
  };

  /** ----------------------------
 * Fields view (layout-aware, MD with notes)
 * ---------------------------- */
  const formatDefault = (f) => {
    if (f.defaultValue === undefined || f.defaultValue === null) return '';
    return Array.isArray(f.defaultValue) ? f.defaultValue.join(', ') : String(f.defaultValue);
  };
  const mdEsc = (v = '') =>
    String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`');

  const toCSV = (rows) => [
    ['フィールド名', 'フィールドコード', '必須', '初期値', 'フィールド形式', 'グループ'].join(','),
    ...rows.map(r => [
      r.label, r.code, r.required ? 'TRUE' : 'FALSE', r.defaultValue, r.type, r.groupPath
    ].map(s => `"${String(s ?? '').replace(/"/g, '""')}"`).join(','))
  ].join('\r\n');

  const toMarkdownWithNotes = (rows) => {
    const header = ['フィールド名', 'フィールドコード', '必須', '初期値', 'フィールド形式', 'グループ', '備考'];
    const sep = header.map(() => ':-').join(' | ');
    const lines = rows.map(r => [
      mdEsc(r.label),
      mdEsc(r.code),
      r.required ? '✓' : '',
      mdEsc(r.defaultValue),
      mdEsc(r.type),
      mdEsc(r.groupPath),
      '' // 備考は空欄
    ].join(' | '));
    return [`| ${header.join(' | ')} |`, `| ${sep} |`, ...lines.map(l => `| ${l} |`)].join('\n');
  };

  const download = (filename, text, type = 'text/plain') => {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  // --- highlight 設定（LocalStorage）
  const LS_HL_KEY = 'ktFieldsHighlightLabelCodeDiff.v1';
  const loadHL = () => {
    const v = localStorage.getItem(LS_HL_KEY);
    return v === null ? true : v === 'true';
  };
  const saveHL = (b) => localStorage.setItem(LS_HL_KEY, String(!!b));

  const renderFields = async (root, appId) => {
    // ルックアップ判定を含めた型の正規化
    const normalizeType = (f) => {
      if (f && f.lookup) return 'LOOKUP';
      return f?.type ?? '';
    };
    // get field defs + layout (for group/subtable placement)
    const [fieldsResp, layoutResp] = await Promise.all([
      api('/k/v1/app/form/fields', { app: appId }),
      api('/k/v1/app/form/layout', { app: appId })
    ]);
    const props = fieldsResp.properties || {};
    const layout = layoutResp.layout || [];

    // build: 1) code -> groupPath map  2) layout order (codes as they appear)
    const groupPathByCode = {};
    const layoutOrderCodes = [];
    const walk = (nodes, curGroup = null) => {
      for (const n of nodes || []) {
        if (n.type === 'ROW') {
          for (const f of n.fields || []) {
            if (f.type === 'SUBTABLE') {
              const stLabel = f.label || f.code || '(Subtable)';
              for (const sf of f.fields || []) {
                const parts = [];
                if (curGroup) parts.push(`Group: ${curGroup}`);
                parts.push(`Subtable: ${stLabel}`);
                if (sf.code) {
                  groupPathByCode[sf.code] = parts.join(' / ');
                  layoutOrderCodes.push(sf.code);
                }
              }
            } else if (f.code) {
              const parts = [];
              if (curGroup) parts.push(`Group: ${curGroup}`);
              groupPathByCode[f.code] = parts.join(' / ');
              layoutOrderCodes.push(f.code);
            }
          }
        } else if (n.type === 'GROUP') {
          const gLabel = n.label || n.code || '(Group)';
          walk(n.layout, gLabel);
        }
      }
    };
    walk(layout);

    // collect leaf fields from defs
    const list = [];
    const seen = new Set();
    const collect = f => {
      if (!f || !f.type) return;
      if (f.type === 'GROUP') Object.values(f.fields || {}).forEach(collect);
      else if (f.type === 'SUBTABLE') Object.values(f.fields || {}).forEach(collect);
      else if (!CONTAINER_TYPES.has(f.type) && f.code && !seen.has(f.code)) {
        seen.add(f.code);
        list.push({
          label: f.label ?? '',
          code: f.code ?? '',
          required: !!f.required,
          defaultValue: formatDefault(f),
          type: normalizeType(f)
        });
      }
    };
    Object.values(props).forEach(collect);

    const rows = list
      .map(r => ({ ...r, groupPath: groupPathByCode[r.code] || '' }))
      .filter(r => !SYSTEM_TYPES.has(r.type));

    // レイアウト順でソート
    const orderIndex = new Map(layoutOrderCodes.map((c, i) => [c, i]));
    rows.sort((a, b) => {
      const ai = orderIndex.has(a.code) ? orderIndex.get(a.code) : Number.POSITIVE_INFINITY;
      const bi = orderIndex.has(b.code) ? orderIndex.get(b.code) : Number.POSITIVE_INFINITY;
      if (ai !== bi) return ai - bi;
      return a.code.localeCompare(b.code);
    });

    // render
    const el = root.querySelector('#view-fields');
    const highlightOn = loadHL();
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
        <div style="font-weight:700">Field Inventory（読み取り専用）</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <label style="display:flex;align-items:center;gap:6px;margin-right:8px;user-select:none">
            <input id="fi-hl-toggle" type="checkbox" ${highlightOn ? 'checked' : ''}>
            <span style="opacity:.9">名称≠コードをハイライト</span>
          </label>
          <button id="fi-copy-md" class="btn">Copy Markdown</button>
          <button id="fi-dl-md"   class="btn">Download MD</button>
          <button id="fi-copy"    class="btn">Copy CSV</button>
          <button id="fi-json"    class="btn">Download JSON</button>
        </div>
      </div>
      <div id="kt-fields">
        <table>
          <thead><tr>
            <th>フィールド名</th><th>フィールドコード</th><th>必須</th>
            <th>初期値</th><th>フィールド形式</th><th>グループ</th>
          </tr></thead>
          <tbody id="fi-tbody"></tbody>
        </table>
      </div>
    `;
    const tbody = el.querySelector('#fi-tbody');
    const applyRowClass = (tr, r) => {
      const different = (r.label || '').trim() !== (r.code || '').trim();
      tr.classList.toggle('hl-diff', highlightOn && different);
      tr.dataset.diff = different ? '1' : '0';
    };

    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escHTML(r.label)}</td>
        <td style="opacity:.9">${escHTML(r.code)}</td>
        <td>${r.required ? '✓' : ''}</td>
        <td style="opacity:.9">${escHTML(r.defaultValue)}</td>
        <td>${escHTML(r.type)}</td>
        <td style="opacity:.9">${escHTML(r.groupPath)}</td>
      `;
      applyRowClass(tr, r);
      tbody.appendChild(tr);
    });

    const md = toMarkdownWithNotes(rows);
    const csv = toCSV(rows);

    // ハイライト切替
    el.querySelector('#fi-hl-toggle').addEventListener('change', e => {
      const on = !!e.target.checked;
      saveHL(on);
      el.querySelectorAll('#fi-tbody tr').forEach(tr => {
        const isDiff = tr.dataset.diff === '1';
        tr.classList.toggle('hl-diff', on && isDiff);
      });
    }, { passive: true });

    el.querySelector('#fi-copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(csv);
      const b = el.querySelector('#fi-copy'); const old = b.textContent; b.textContent = 'Copied!';
      setTimeout(() => b.textContent = old, 1200);
    }, { passive: true });
    el.querySelector('#fi-json').addEventListener('click', () => {
      download(`kintone_fields_${appId}.json`, JSON.stringify(rows, null, 2), 'application/json');
    }, { passive: true });
    el.querySelector('#fi-copy-md').addEventListener('click', async () => {
      await navigator.clipboard.writeText(md);
      const b = el.querySelector('#fi-copy-md'); const old = b.textContent; b.textContent = 'Copied!';
      setTimeout(() => b.textContent = old, 1200);
    }, { passive: true });
    el.querySelector('#fi-dl-md').addEventListener('click', () => {
      download(`kintone_fields_${appId}.md`, md, 'text/markdown');
    }, { passive: true });
  };

  /** ----------------------------
 * Views view（全一覧の一覧化）
 * ---------------------------- */
  // 現在の一覧ビュー情報（イベントからセット）
  let CURRENT_VIEW = { id: null, name: '' };
  // クエリを (condition, orderBy[], limit, offset) に分解
  function parseQuery(query) {
    const q = (query || '').trim();
    if (!q) return { condition: '', orderBy: [], limit: '', offset: '' };

    const lower = q.toLowerCase();
    const idxOrder = lower.indexOf(' order by ');
    const idxLimit = lower.indexOf(' limit ');
    const idxOffset = lower.indexOf(' offset ');

    let conditionEnd = q.length;
    if (idxOrder >= 0) conditionEnd = Math.min(conditionEnd, idxOrder);
    if (idxLimit >= 0) conditionEnd = Math.min(conditionEnd, idxLimit);
    if (idxOffset >= 0) conditionEnd = Math.min(conditionEnd, idxOffset);

    const condition = q.substring(0, conditionEnd).trim();

    // ORDER BY
    let orderPart = '';
    if (idxOrder >= 0) {
      const afterOrder = q.substring(idxOrder + ' order by '.length);
      const end = [idxLimit, idxOffset]
        .filter(i => i >= 0)
        .map(i => i - (idxOrder + ' order by '.length))
        .sort((a, b) => a - b)[0];
      orderPart = (end !== undefined ? afterOrder.substring(0, end) : afterOrder).trim();
    }
    const orderBy = orderPart ? orderPart.split(',').map(s => s.trim()).filter(Boolean) : [];

    // LIMIT
    let limit = '';
    if (idxLimit >= 0) {
      const afterLimit = q.substring(idxLimit + ' limit '.length);
      const end = [idxOffset]
        .filter(i => i >= 0)
        .map(i => i - (idxLimit + ' limit '.length))
        .sort((a, b) => a - b)[0];
      limit = (end !== undefined ? afterLimit.substring(0, end) : afterLimit).trim();
    }

    // OFFSET
    let offset = '';
    if (idxOffset >= 0) {
      const afterOffset = q.substring(idxOffset + ' offset '.length);
      offset = afterOffset.trim();
    }

    return { condition, orderBy, limit, offset };
  }

  // クエリ内のフィールドコードをラベル（＋コード）に置換
  function labelizeQueryPart(part, code2label) {
    if (!part) return part;
    const codes = Object.keys(code2label).sort((a, b) => b.length - a.length);
    let out = part;
    for (const code of codes) {
      const label = code2label[code] || code;
      const re = new RegExp(`(?<![\\w_])${escapeRegExp(code)}(?![\\w_])`, 'g');
      out = out.replace(re, `${label}（${code}）`);
    }
    return out;
  }

  async function fetchFieldMap(appId) {
    try {
      const resp = await api('/k/v1/app/form/fields', { app: appId });
      const map = {};
      const stack = [resp.properties];
      while (stack.length) {
        const cur = stack.pop();
        Object.values(cur).forEach(p => {
          if (p.type === 'SUBTABLE' && p.fields) {
            stack.push(p.fields);
          } else if (p.code) {
            map[p.code] = p.label || p.code;
          }
        });
      }
      return map;
    } catch {
      return {};
    }
  }

  async function getCurrentViewName(appId) {
    // まずはイベントで捕まえた最新値を優先
    if (CURRENT_VIEW.name) return CURRENT_VIEW.name;

    try {
      const viewIdParam = new URL(location.href).searchParams.get('view');
      const resp = await api('/k/v1/app/views', { app: appId });
      const views = resp.views || {};

      // 1) URLのview指定があれば優先
      if (viewIdParam) {
        if (views[viewIdParam]?.name) return views[viewIdParam].name;
        for (const v of Object.values(views)) {
          if (String(v.id) === String(viewIdParam)) return v.name || '';
        }
      }

      // 2) デフォルトビュー（indexが最小のもの）を推定
      //    ※ kintoneのレスポンスで index (並び順) が入る想定。無い環境でも安全にフォールバック。
      const arr = Object.values(views);
      if (arr.length) {
        let cand = arr[0];
        for (const v of arr) {
          if (typeof v.index === 'number' && typeof cand.index === 'number') {
            if (v.index < cand.index) cand = v;
          }
        }
        return cand.name || '';
      }
    } catch (e) {
      // ignore
    }
    return '';
  }

  const toViewsCSV = (rows) => [
    ['ビュー名', '種類', 'フィルター', 'ソート', 'ビューID'].join(','),
    ...rows.map(r => [
      r.name, r.type, r.conditionPretty || '（なし）', r.sortPretty || '（なし）', r.id
    ].map(s => `"${String(s ?? '').replace(/"/g, '""')}"`).join(','))
  ].join('\r\n');

  const toViewsMarkdown = (rows) => {
    const header = ['ビュー名', '種類', 'フィルター', 'ソート', 'ビューID'];
    const sep = header.map(() => ' :- ').join(' | ');
    const lines = rows.map(r => [
      r.name, r.type, r.conditionPretty || '（なし）', r.sortPretty || '（なし）', r.id
    ].map(x => String(x).replace(/\|/g, '\\|')).join(' | '));
    return ['| ' + header.join(' | ') + ' |', '| ' + sep + ' |', ...lines.map(l => '| ' + l + ' |')].join('\n');
  };

  const renderViews = async (root, appId) => {
    const el = root.querySelector('#view-views');
    el.innerHTML = `<div style="opacity:.8">Loading views…</div>`;

    const [viewsResp, code2label] = await Promise.all([
      api('/k/v1/app/views', { app: appId }),
      fetchFieldMap(appId)
    ]);

    const views = Object.values(viewsResp.views || {});
    // index（並び順）でソートし、先頭をデフォルトビューとして扱う（列は出さない）
    views.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    const rows = views.map(v => {
      const condition = v.filterCond || '';
      const sort = (v.sort || '').trim(); // "field asc, field2 desc"
      const query = condition + (sort ? ` order by ${sort}` : '');
      const parsed = parseQuery(query);

      return {
        id: v.id ?? '',
        name: v.name || '',
        type: v.type || '', // LIST, CALENDAR, CUSTOM など
        conditionRaw: parsed.condition,
        conditionPretty: labelizeQueryPart(parsed.condition, code2label),
        sortRaw: parsed.orderBy.join(', '),
        sortPretty: (parsed.orderBy || []).map(ob => labelizeQueryPart(ob, code2label)).join(', ')
      };
    });

    const md = toViewsMarkdown(rows);
    const csv = toViewsCSV(rows);
    const defaultName = rows.length ? rows[0].name : '';

    el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:nowrap;min-width:0">
      <div style="font-weight:700;white-space:nowrap">All Views（全一覧）</div>
      <div style="display:flex;gap:6px;flex-wrap:nowrap;overflow:auto;white-space:nowrap">
        <button id="kv-copy-md"  class="btn">Copy Markdown</button>
        <button id="kv-dl-md"    class="btn">Download MD</button>
        <button id="kv-copy-csv" class="btn">Copy CSV</button>
        <button id="kv-dl-csv"   class="btn">Download CSV</button>
        <button id="kv-refresh"  class="btn">Refresh</button>
      </div>
    </div>

    <div style="opacity:.9;margin-bottom:6px">
      デフォルトビュー（並び順1位）：<strong>${escHTML(defaultName || '—')}</strong>
    </div>

    <div style="overflow:auto;max-height:60vh;border:1px solid #2a2a2a;border-radius:8px">
      <table style="border-collapse:collapse;width:100%;table-layout:fixed">
        <colgroup>
                  <col style="width:88px">  <!-- ビューID -->
          <col style="width:28%">   <!-- ビュー名 -->
          <col style="width:88px">  <!-- 種類 -->
          <col style="width:auto">  <!-- フィルター -->
          <col style="width:26%">   <!-- ソート -->
        </colgroup>
        <thead>
          <tr>
            <th style="position:sticky;top:0;background:#111;padding:6px;border-bottom:1px solid #333;white-space:nowrap">ビューID</th>
            <th style="position:sticky;top:0;background:#111;padding:6px;border-bottom:1px solid #333">ビュー名</th>
            <th style="position:sticky;top:0;background:#111;padding:6px;border-bottom:1px solid #333;white-space:nowrap">種類</th>
            <th style="position:sticky;top:0;background:#111;padding:6px;border-bottom:1px solid #333">フィルター</th>
            <th style="position:sticky;top:0;background:#111;padding:6px;border-bottom:1px solid #333">ソート</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td style="padding:6px;border-bottom:1px solid #222;white-space:nowrap">${escHTML(r.id)}</td>
              <td style="padding:6px;border-bottom:1px solid #222;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escHTML(r.name)}">${escHTML(r.name)}</td>
              <td style="padding:6px;border-bottom:1px solid #222;white-space:nowrap">${escHTML(r.type)}</td>
              <td style="padding:6px;border-bottom:1px solid #222;white-space:pre-wrap">${escHTML(r.conditionPretty || '（なし）')}</td>
              <td style="padding:6px;border-bottom:1px solid #222;white-space:pre-wrap">${escHTML(r.sortPretty || '（なし）')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

    const dl = (filename, text, type = 'text/plain') => {
      const blob = new Blob([text], { type });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    };

    el.querySelector('#kv-refresh').addEventListener('click', () => renderViews(root, appId), { passive: true });
    el.querySelector('#kv-copy-md').addEventListener('click', async () => {
      await navigator.clipboard.writeText(md);
      const b = el.querySelector('#kv-copy-md'); const t = b.textContent; b.textContent = 'Copied!'; setTimeout(() => b.textContent = t, 1200);
    }, { passive: true });
    el.querySelector('#kv-dl-md').addEventListener('click', () => dl(`kintone_views_${appId}.md`, md, 'text/markdown'), { passive: true });
    el.querySelector('#kv-copy-csv').addEventListener('click', async () => {
      await navigator.clipboard.writeText(csv);
      const b = el.querySelector('#kv-copy-csv'); const t = b.textContent; b.textContent = 'Copied!'; setTimeout(() => b.textContent = t, 1200);
    }, { passive: true });
    el.querySelector('#kv-dl-csv').addEventListener('click', () => dl(`kintone_views_${appId}.csv`, csv, 'text/csv'), { passive: true });
  };

  /** ----------------------------
 * Graphs views
 * ---------------------------- */



  /** ----------------------------
 * boot
 * ---------------------------- */
  waitReady().then(async () => {
    const appId = kintone.app.getId();
    if (!appId) return;

    const root = mountRoot();
    // render all views (independently)
    renderHealth(root, appId).catch(e => console.warn('[Toolkit] Health error', e));
    renderFields(root, appId).catch(e => console.warn('[Toolkit] Fields error', e));
    renderViews(root, appId).catch(e => console.warn('[Toolkit] Views error', e));
    //renderGraphs(root, appId).catch(e => console.warn('[Toolkit] Graphs error', e));
  });

})();