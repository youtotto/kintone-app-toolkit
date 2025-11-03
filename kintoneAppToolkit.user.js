// ==UserScript==
// @name         kintone App Toolkit
// @namespace    https://github.com/youtotto/kintone-app-toolkit
// @version      1.4.1
// @description  kintoneアプリのヘルスチェック、フィールド一覧、ビュー一覧、グラフ一覧
// @match        https://*.cybozu.com/k/*/
// @match        https://*.cybozu.com/k/*/?view=*
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @connect      unpkg.com
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

  /** ----------------------------
  * Small utils
  * ---------------------------- */
  const getUrlParam = (key) => new URL(location.href).searchParams.get(key);
  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** ----------------------------
  * UI Root (tabs)
  * ---------------------------- */
  const mountRoot = () => {
    // 1. ライトモード/ダークモードの判定
    const isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;

    // 2. 色の変数を定義 (D: Dark, L: Light)
    const C = isDarkMode ? {
      bg: '#111',       // メイン背景
      bgSub: '#1d1d1d',  // ボタン/タブ背景
      bgSub2: '#1b1b1b', // Pill背景
      bgInput: '#0f0f0f',// 入力欄背景
      text: '#fff',      // メインテキスト
      textSub: '#ddd',   // Pillテキスト
      border: '#2a2a2a', // メインボーダー
      border2: '#333',   // thボーダー, pillボーダー
      border3: '#222',   // tdボーダー
    } : {
      bg: '#F5F5F5',      // (L) メイン背景
      bgSub: '#eee',       // (L) ボタン/タブ背景
      bgSub2: '#e0e0e0',     // (L) Pill背景
      bgInput: '#fff',     // (L) 入力欄背景
      text: '#111',      // (L) メインテキスト (黒)
      textSub: '#333',    // (L) Pillテキスト
      border: '#ccc',      // (L) メインボーダー
      border2: '#bbb',     // (L) thボーダー, pillボーダー
      border3: '#ddd',     // (L) tdボーダー
    };

    const wrap = document.createElement('div');
    wrap.id = 'kt-toolkit';
    wrap.style.cssText = `
      position:fixed; right:16px; bottom:16px; z-index:9999;
      background:${C.bg}; color:${C.text}; border-radius:12px;
      box-shadow:0 8px 30px rgba(0,0,0,${isDarkMode ? '.35' : '.15'});
      font:12px/1.5 ui-sans-serif,system-ui; width:min(1080px, 95vw); max-height:80vh; overflow:auto;
      border:1px solid ${C.border};
    `;
    wrap.innerHTML = `
      <style>
        #kt-toolkit .bar{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid ${C.border};}
        #kt-toolkit .tabs{display:flex;gap:6px;flex-wrap:wrap}
        #kt-toolkit .tab{padding:6px 10px;border:1px solid ${C.border};background:${C.bgSub};color:${C.text};border-radius:8px;cursor:pointer}
        #kt-toolkit .tab.active{background:#2563eb;border-color:#2563eb;color:#fff;} /* Activeは色固定 */
        #kt-toolkit .btn{padding:6px 10px;border:1px solid ${C.border};background:${C.bgSub};color:${C.text};border-radius:8px;cursor:pointer}
        #kt-toolkit .body{padding:12px}
        /* label≠code 行のハイライト */
        #kt-toolkit .hl-diff td { background: rgba(255, 196, 0, 0.12); }
        #kt-toolkit .hl-diff td:nth-child(1),
        #kt-toolkit .hl-diff td:nth-child(2) { font-weight: 600; }
        /* 共通テーブルスタイル */
        #kt-toolkit table{border-collapse:collapse;width:100%}
        #kt-toolkit th{ text-align:left;padding:6px;border-bottom:1px solid ${C.border2};position:sticky;top:0;background:${C.bg}}
        #kt-toolkit td{ padding:6px;border-bottom:1px solid ${C.border3}}
        /* 必須列（Fieldsプレビューの3列目）固定 */
        #kt-fields th:nth-child(3), #kt-fields td:nth-child(3){ min-width:64px; text-align:center; white-space:nowrap; }
        /* Graphs: 階層タグ */
        #kt-toolkit .pill{
          display:inline-block; padding:2px 6px; border:1px solid ${C.border2}; border-radius:999px;
          font-size:11px; line-height:1; background:${C.bgSub2}; color:${C.textSub}; white-space:nowrap;
        }
        #kt-toolkit .gline{ margin:2px 0; }

        /* Health: 基準値設定のinput */
        #kt-th-panel input {
          background:${C.bgInput};color:${C.text};border:1px solid ${C.border2};border-radius:6px;padding:4px 6px;
          width: 64px;
        }

        /* Views/Graphs: スクロールコンテナ */
        #view-views .table-container, #view-graphs .table-container {
            overflow:auto;max-height:60vh;border:1px solid ${C.border};border-radius:8px
        }
        /* Views/Graphs: th (共通) */
        #view-views th, #view-graphs th {
            position:sticky;top:0;background:${C.bg};padding:6px;border-bottom:1px solid ${C.border2};
        }

        /* Views: 個別スタイル */
        #view-views th:nth-child(1), #view-views th:nth-child(3) { white-space:nowrap; }
        #view-views td { padding:6px;border-bottom:1px solid ${C.border3}; }
        #view-views td:nth-child(1), #view-views td:nth-child(3) { white-space:nowrap; }
        #view-views td:nth-child(2) { white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
        #view-views td:nth-child(4), #view-views td:nth-child(5) { white-space:pre-wrap; }

        /* Graphs: 個別スタイル */
        #view-graphs th { white-space:nowrap; }
        #view-graphs td { padding:6px;border-bottom:1px solid ${C.border3}; }
        #view-graphs td:nth-child(1), #view-graphs td:nth-child(3), #view-graphs td:nth-child(4) { white-space:nowrap; }
        #view-graphs td:nth-child(2) { white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
        #view-graphs td:nth-child(5), #view-graphs td:nth-child(6), #view-graphs td:nth-child(7) { white-space:pre-wrap; }

      </style>
      <div class="bar">
        <div class="tabs">
          <button id="tab-health" class="tab active">Health</button>
          <button id="tab-fields" class="tab">Fields</button>
          <button id="tab-views"  class="tab">Views</button>
          <button id="tab-graphs" class="tab">Graphs</button>
          <button id="tab-templates" class="tab">Templates</button>
        </div>
        <div>
          <button id="kt-close" class="btn">×</button>
        </div>
      </div>
      <div class="body">
        <div id="view-health"></div>
        <div id="view-fields" style="display:none"></div>
        <div id="view-views"  style="display:none"></div>
        <div id="view-graphs" style="display:none"></div>
        <div id="view-templates" style="display:none"></div>
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
      wrap.querySelector('#view-graphs').style.display = idShow === 'graphs' ? 'block' : 'none';
      wrap.querySelector('#view-templates').style.display = idShow === 'templates' ? 'block' : 'none';
    };
    wrap.querySelector('#tab-health').addEventListener('click', () => switchTab('health'), { passive: true });
    wrap.querySelector('#tab-fields').addEventListener('click', () => switchTab('fields'), { passive: true });
    wrap.querySelector('#tab-views').addEventListener('click', () => switchTab('views'), { passive: true });
    wrap.querySelector('#tab-graphs').addEventListener('click', () => switchTab('graphs'), { passive: true });
    wrap.querySelector('#tab-templates').addEventListener('click', () => switchTab('templates'), { passive: true });
    return wrap;

  };

  // safety: if DOM node detached before append
  function wapCheck(el) { return el; }

  /** ----------------------------
  * Health view
  * ---------------------------- */
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

  const renderHealth = async (root, appId) => {
    let TH = loadTH();

    // fetch metrics (best-effort for optional endpoints)
    const [fields, status, views, notifs, customize, acl] = await Promise.all([
      api('/k/v1/app/form/fields', { app: appId }),
      api('/k/v1/app/status', { app: appId }),
      api('/k/v1/app/views', { app: appId }).catch(() => null),
      api('/k/v1/app/notifications/general', { app: appId }).catch(() => null),
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
          <button id="kt-th-save"  class="btn" style="background:#2563eb;border-color:#2563eb;color:#fff;">保存</button>
        </div>
      </div>
    `;

    const rowsEl = el.querySelector('#kt-th-rows');
    const renderTHRows = () => {
      rowsEl.innerHTML = Object.entries(TH).map(([k, v]) => `
        <tr data-key="${k}">
          <td>${v.label}</td>
          <td style="text-align:right"><input type="number" min="0" value="${v.Y}"></td>
          <td style="text-align:right"><input type="number" min="0" value="${v.R}"></td>
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
  // 汎用の初期値フォーマッタ（フィールド定義用）
  function formatDefault(field) {
    const t = field?.type;
    const dv = field?.defaultValue;

    // USER_SELECT / ORGANIZATION_SELECT は defaultValue が配列（Object or string）
    if (t === 'USER_SELECT') {
      // 例：[{ code:'user1', type:'USER' }, { code:'group1', type:'GROUP' }, { code:'LOGINUSER()', type:'FUNCTION' }]
      const arr = Array.isArray(dv) ? dv : [];
      return arr.map(e => {
        if (e && typeof e === 'object') {
          const kind = e.type;
          const code = e.code;
          if (kind === 'FUNCTION') {
            // よく使う関数はラベル化（未知はそのまま表示）
            if (code === 'LOGINUSER()') return 'ログインユーザー';
            if (code === 'PRIMARY_ORGANIZATION()') return '主所属組織';
            return code || '';
          }
          if (kind === 'USER') return `ユーザー:${code}`;
          if (kind === 'GROUP') return `グループ:${code}`;
          if (kind === 'ORGANIZATION') return `組織:${code}`;
          return String(code ?? '');
        }
        // 念のため素の文字列にも対応
        return String(e ?? '');
      }).join(', ');
    }

    if (t === 'ORGANIZATION_SELECT') {
      // 例：['org1', 'org2'] または [{ code:'org1', type:'ORGANIZATION' }]
      const arr = Array.isArray(dv) ? dv : [];
      return arr.map(e => {
        if (e && typeof e === 'object') {

          const kind = e.type;
          const code = e.code;
          if (kind === 'FUNCTION') {
            // よく使う関数はラベル化（未知はそのまま表示）
            if (code === 'PRIMARY_ORGANIZATION()') return '主所属組織';
            return code || '';
          }
          if (kind === 'GROUP') return `グループ:${code}`;
          if (kind === 'ORGANIZATION') return `組織:${code}`;
          return `組織:${String(code ?? '')}`;
        }

        return `組織:${String(e ?? '')}`;
      }).join(', ');
    }

    // それ以外は既存挙動に近いシンプル整形
    if (dv == null) return '';
    if (Array.isArray(dv)) return dv.join(', ');
    if (typeof dv === 'object') {
      // 既定では [object Object] にならないよう JSON文字列化（短く）
      try { return JSON.stringify(dv); } catch { return String(dv); }
    }
    return String(dv);
  }

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

  // ==== DROP-IN REPLACEMENT (layout order only; supports top-level SUBTABLE) ====
  const renderFields = async (root, appId) => {
    const normalizeType = (f) => (f && f.lookup ? 'LOOKUP' : (f?.type ?? ''));

    const [fieldsResp, layoutResp] = await Promise.all([
      api('/k/v1/app/form/fields', { app: appId }),
      api('/k/v1/app/form/layout', { app: appId })
    ]);
    const props = fieldsResp.properties || {};
    const layout = layoutResp.layout || [];

    // --- layout から “表示順” と “グループ/サブテーブル表示名” を作る（子も順にpush）
    const groupPathByCode = {};    // 子フィールドコード -> "Group: … / Subtable: …"
    const layoutOrderCodes = [];   // 表示順どおりのコード列（通常＆サブ子を同一配列で）

    const pushChild = (sf, curGroup, stLabel) => {
      if (!sf?.code) return;
      const parts = [];
      if (curGroup) parts.push(`Group: ${curGroup}`);
      if (stLabel) parts.push(`Subtable: ${stLabel}`);
      groupPathByCode[sf.code] = parts.join(' / ');
      layoutOrderCodes.push(sf.code); // ← 画面通りに採番
    };

    const walkLayout = (nodes, curGroup = null) => {
      for (const n of nodes || []) {
        if (n.type === 'ROW') {
          for (const f of n.fields || []) {
            if (f.type === 'SUBTABLE') {
              const stLabel = f.label || f.code || '(Subtable)';
              for (const sf of f.fields || []) pushChild(sf, curGroup, stLabel);
            } else if (f.code) {
              // 通常フィールド
              groupPathByCode[f.code] = curGroup ? `Group: ${curGroup}` : '';
              layoutOrderCodes.push(f.code);
            }
          }
        } else if (n.type === 'GROUP') {
          const gLabel = n.label || n.code || '(Group)';
          walkLayout(n.layout, gLabel);
        } else if (n.type === 'SUBTABLE') {
          // ★ SUBTABLE がトップレベル要素として現れるケース
          const stLabel = n.label || n.code || '(Subtable)';
          for (const sf of n.fields || []) pushChild(sf, curGroup, stLabel);
        }
      }
    };
    walkLayout(layout);

    // --- 定義から葉フィールドを収集（順序は使わず、型や必須、初期値を取得）
    const list = [];
    const seen = new Set();
    const collect = (f) => {
      if (!f || !f.type) return;
      if (f.type === 'GROUP') { Object.values(f.fields || {}).forEach(collect); return; }
      if (f.type === 'SUBTABLE') { Object.values(f.fields || {}).forEach(collect); return; }
      if (!CONTAINER_TYPES.has(f.type) && f.code && !seen.has(f.code)) {
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

    // --- 表示用行へ。グループ/サブテーブル表示は “layoutだけ” を正とする
    const rows = list
      .map(r => ({
        ...r,
        groupPath: groupPathByCode[r.code] || ''
      }))
      .filter(r => !SYSTEM_TYPES.has(r.type));

    // --- layout の並び順でソート（見つからないコードは末尾）
    const orderIndex = new Map(layoutOrderCodes.map((c, i) => [c, i]));
    const INF = Number.POSITIVE_INFINITY;
    rows.sort((a, b) => {
      const ai = orderIndex.has(a.code) ? orderIndex.get(a.code) : INF;
      const bi = orderIndex.has(b.code) ? orderIndex.get(b.code) : INF;
      return ai === bi ? a.code.localeCompare(b.code) : ai - bi;
    });

    // --- UI
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
  // ==== END REPLACEMENT ====

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

    <div class="table-container">
      <table style="border-collapse:collapse;width:100%;table-layout:fixed">
        <colgroup>
                  <col style="width:88px">  <col style="width:28%">    <col style="width:88px">  <col style="width:auto">  <col style="width:26%">    </colgroup>
        <thead>
          <tr>
            <th>ビューID</th>
            <th>ビュー名</th>
            <th>種類</th>
            <th>フィルター</th>
            <th>ソート</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${escHTML(r.id)}</td>
              <td title="${escHTML(r.name)}">${escHTML(r.name)}</td>
              <td>${escHTML(r.type)}</td>
              <td>${escHTML(r.conditionPretty || '（なし）')}</td>
              <td>${escHTML(r.sortPretty || '（なし）')}</td>
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
  // groups を 1セル内に「G1/G2/G3のピル＋ラベル＋[PER]」で縦積み表示
  const groupsToHTML = (groups = [], code2label = {}) => {
    return groups.map((g, i) => {
      const idx = i + 1;
      const code = g?.code || '';
      const labelRaw = code ? (code2label[code] ? `${code2label[code]}` : code) : '';
      const perTag = g?.per ? `<span class="pill">${String(g.per).toUpperCase()}</span>` : '';
      const label = escHTML(labelRaw);
      return `<div class="gline"><span class="pill">G${idx}</span> ${label} ${perTag}</div>`;
    }).join('');
  };

  // ★ CSV/Markdown 用のテキスト版（全角「、」区切り）
  const groupsToText = (groups = [], code2label = {}) => {
    return groups.map((g, i) => {
      const idx = i + 1;
      const code = g?.code || '';
      const label = code ? (code2label[code] ? `${code2label[code]}（${code}）` : code) : '';
      const per = g?.per ? ` [${String(g.per).toUpperCase()}]` : '';
      return `G${idx} ${label}${per}`;
    }).join('、 ');
  };

  const fmtAggs = (aggs = [], code2label = {}) => {
    // 集計: { type: SUM|COUNT|..., code? }
    return aggs.map(a => {
      const fn = (a.type || '').toUpperCase();
      const code = a.code || '';
      const label = code ? (code2label[code] ? `${code2label[code]}` : code) : 'レコード';
      return fn ? `${fn} ${label}` : label;
    }).join(' / ');
  };

  const toGraphsCSV = (rows) => [
    ['グラフID', 'グラフ名', 'タイプ', '表示モード', '分類項目', '集計方法', '条件'].join(','),
    ...rows.map(r => [
      r.id, r.name, r.chartType, r.chartMode,
      r.groupsText || '',
      r.aggsText, r.filterCond || '',
    ].map(s => `"${String(s ?? '').replace(/"/g, '""')}"`).join(','))
  ].join('\r\n');

  const toGraphsMarkdown = (rows) => {
    const header = ['グラフID', 'グラフ名', 'タイプ', '表示モード', '分類項目', '集計方法', '条件'];
    const sep = header.map(() => ':-').join(' | ');
    const lines = rows.map(r => [
      r.id, r.name, r.chartType, r.chartMode,
      (r.groupsText || ''),
      r.aggsText, r.filterCond || '（なし）'
    ].map(x => String(x).replace(/\|/g, '\\|')).join(' | '));
    return [`| ${header.join(' | ')} |`, `| ${sep} |`, ...lines.map(l => `| ${l} |`)].join('\n');
  };

  const renderGraphs = async (root, appId) => {
    const el = root.querySelector('#view-graphs');
    el.innerHTML = `<div style="opacity:.8">Loading graphs…</div>`;

    // 定義＆フィールドラベルを取得
    const [reportsResp, code2label] = await Promise.all([
      api('/k/v1/app/reports', { app: appId }),
      fetchFieldMap(appId)
    ]);
    // ソート表示用にグローバル参照（fmtSorts内で使用）
    window.__kt_code2label = code2label;

    // reports は { [name]: { id, name, chart: {type,mode,...}, groups:[], aggregations:[], filterCond, sorts:[] } } 想定
    const reports = Object.values(reportsResp.reports || {});

    // 並び順（index）があればそれでソート
    reports.sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || String(a.name || '').localeCompare(String(b.name || '')));

    const rows = reports.map(r => {
      const chartType = r.chartType || r.chart?.type || '';
      const chartMode = r.chartMode || r.chart?.mode || '';
      const groups = Array.isArray(r.groups) ? r.groups : [];
      const groupsHtml = groupsToHTML(groups, code2label);
      const groupsText = groupsToText(groups, code2label);
      const aggsText = fmtAggs(r.aggregations || [], code2label);
      return {
        id: r.id ?? '',
        name: r.name || '',
        chartType,
        chartMode,
        groupsHtml,
        groupsText,
        aggsText,
        filterCond: r.filterCond || '',
      };
    });

    const md = toGraphsMarkdown(rows);
    const csv = toGraphsCSV(rows);

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:nowrap;min-width:0">
        <div style="font-weight:700;white-space:nowrap">Graphs（グラフ全一覧）</div>
        <div style="display:flex;gap:6px;flex-wrap:nowrap;overflow:auto;white-space:nowrap">
          <button id="kg-copy-md"  class="btn">Copy Markdown</button>
          <button id="kg-dl-md"    class="btn">Download MD</button>
          <button id="kg-copy-csv" class="btn">Copy CSV</button>
          <button id="kg-dl-csv"   class="btn">Download CSV</button>
          <button id="kg-refresh"  class="btn">Refresh</button>
        </div>
      </div>
      <div class="table-container">
        <table style="border-collapse:collapse;width:100%;table-layout:fixed">
          <colgroup>
            <col style="width:88px">     <col style="width:24%">     <col style="width:100px">   <col style="width:100px">   <col style="width:24%">     <col style="width:110px">     <col style="width:24%">     </colgroup>
          <thead>
            <tr>
              <th>グラフID</th>
              <th>グラフ名</th>
              <th>タイプ</th>
              <th>表示モード</th>
              <th>分類項目</th>
              <th>集計方法</th>
              <th>条件</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${escHTML(r.id)}</td>
                <td title="${escHTML(r.name)}">${escHTML(r.name)}</td>
                <td>${escHTML(r.chartType)}</td>
                <td>${escHTML(r.chartMode)}</td>
                <td>${r.groupsHtml || '—'}</td>
                <td>${escHTML(r.aggsText || '—')}</td>
                <td>${escHTML(r.filterCond || '（なし）')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    // エクスポート操作
    const dl = (filename, text, type = 'text/plain') => {
      const blob = new Blob([text], { type });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    };
    el.querySelector('#kg-refresh').addEventListener('click', () => renderGraphs(root, appId), { passive: true });
    el.querySelector('#kg-copy-md').addEventListener('click', async () => {
      await navigator.clipboard.writeText(md);
      const b = el.querySelector('#kg-copy-md'); const t = b.textContent; b.textContent = 'Copied!'; setTimeout(() => b.textContent = t, 1200);
    }, { passive: true });
    el.querySelector('#kg-dl-md').addEventListener('click', () => dl(`kintone_graphs_${appId}.md`, md, 'text/markdown'), { passive: true });
    el.querySelector('#kg-copy-csv').addEventListener('click', async () => {
      await navigator.clipboard.writeText(csv);
      const b = el.querySelector('#kg-copy-csv'); const t = b.textContent; b.textContent = 'Copied!'; setTimeout(() => b.textContent = t, 1200);
    }, { passive: true });
    el.querySelector('#kg-dl-csv').addEventListener('click', () => dl(`kintone_graphs_${appId}.csv`, csv, 'text/csv'), { passive: true });
  };

  /** ----------------------------
   * Template views（Templates=上書き表示 / Snippets=挿入専用, OverviewはSnippetsのみ）
   * ---------------------------- */
  async function renderTemplates(root) {
    const view = document.getElementById('view-templates');
    if (!view) return;
    let currentFileName = 'template.js';

    // GitHub設定
    const GH = {
      owner: 'youtotto',
      repo: 'kintoneCustomizeJS',
      dirs: { templates: 'js', snippets: 'snippets' },
      endpoint(dir) { return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${dir}`; },
      cacheKey(kind) { return `kt_tpl_cache_ui_${kind}`; }
    };

    // UI色
    const isDark = matchMedia('(prefers-color-scheme: dark)').matches;
    const BG = isDark ? '#1b1b1b' : '#fff';
    const BD = isDark ? '#333' : '#ddd';
    const PANEL_H = '60vh';

    // レイアウト（整えたHTML/CSS）
    view.innerHTML = `
      <div id="kt-tpl" style="display:flex; gap:14px; align-items:stretch;">
        <!-- 左：エディタ -->
        <div style="flex:2; min-width:380px; display:flex; flex-direction:column; gap:10px;">
          <div style="display:flex; align-items:center; gap:10px; justify-content:space-between;">
            <div style="display:flex; align-items:center; gap:8px;">
              <button id="kt-tpl-refresh" class="btn" style="height:32px; padding:0 10px;">↻ 更新</button>
              <button id="kt-tpl-download" class="btn" disabled style="height:32px; padding:0 10px;">↓ ダウンロード</button>
            </div>
            <span id="kt-tpl-meta"
                  style="opacity:.75; max-width:55%; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; text-align:right;"></span>
          </div>

          <div id="kt-tpl-editor"
            style="
              flex:1;
              min-height:0;
              border:1px solid ${BD};
              border-radius:8px;
              background:${isDark ? '#0f0f0f' : '#fafafa'};
            ">
          </div>
        </div>

        <!-- 右：ファイル一覧 -->
        <div style="flex:1; min-width:240px; display:flex; flex-direction:column; gap:10px; height:${PANEL_H}; min-height:0;">
          <div style="display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:1;
            padding:6px 0; background:${isDark ? '#1b1b1b' : '#fff'};">
            <div style="font-weight:600; padding-left:12px; margin:6px 0;">Files</div>
            <select id="kt-tpl-source" class="btn" style="padding:3px 4px; height:32px;">
              <option value="templates">Templates (GitHub: ${GH.dirs.templates})</option>
              <option value="snippets">Snippets  (GitHub: ${GH.dirs.snippets})</option>
            </select>
          </div>

          <div style="display:flex; gap:8px;">
            <button id="kt-tpl-insert" class="btn" disabled style="flex:1; height:32px;">⤴︎ 挿入</button>
            <button id="kt-tpl-copy" class="btn" disabled style="flex:1; height:32px;">⎘ コピー</button>
          </div>

          <div id="kt-tpl-list"
            style="
              border:1px solid ${BD};
              border-radius:8px;
              overflow:auto;
              max-height:56vh;
              background:${BG};
              padding:6px;
              flex:1;
              min-height:0;
            ">
          </div>

          <div id="kt-tpl-overview"
            style="
              margin-top:4px;
              display:none;
              border:1px solid ${BD};
              border-radius:8px;
              padding:8px;
              background:${isDark ? '#0f0f0f' : '#fafafa'};
            ">
          </div>
        </div>
      </div>
`;

    // 要素参照
    const $list = view.querySelector('#kt-tpl-list');
    const $download = view.querySelector('#kt-tpl-download');
    const $meta = view.querySelector('#kt-tpl-meta');
    const $refresh = view.querySelector('#kt-tpl-refresh');
    const $insert = view.querySelector('#kt-tpl-insert');
    const $copy = view.querySelector('#kt-tpl-copy');
    const $sourceSel = view.querySelector('#kt-tpl-source');
    const $overview = view.querySelector('#kt-tpl-overview');

    // 状態
    let selectedItem = null;        // 選択中ファイル
    let selectedKind = 'templates'; // 'templates' | 'snippets'

    // ヘルパ
    async function loadCode(file) {
      const res = await fetch(file.download_url);
      if (!res.ok) throw new Error(`raw fetch ${res.status}`);
      return await res.text();
    }
    async function fetchList(kind, useCacheFirst = true) {
      const dir = GH.dirs[kind];
      const api = GH.endpoint(dir);
      const cKey = GH.cacheKey(kind);

      if (useCacheFirst) {
        const c = sessionStorage.getItem(cKey);
        if (c) { try { return JSON.parse(c); } catch { } }
      }
      const res = await fetch(api, { headers: { 'Accept': 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const json = await res.json();
      const files = (Array.isArray(json) ? json : []).filter(x => x.type === 'file' && x.name.endsWith('.js'));
      sessionStorage.setItem(cKey, JSON.stringify(files));
      return files;
    }
    function fileRow(file, kind) {
      const el = document.createElement('div');
      el.style.cssText =
        `display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid ${BD};cursor:pointer;`;
      const size = (file.size || 0).toLocaleString();
      const tag = kind === 'snippets' ? 'SNIP' : 'JS';
      el.innerHTML = `
      <div style="border:1px solid ${BD};border-radius:999px;padding:2px 6px;font-size:11px">${tag}</div>
      <div style="flex:1">${file.name}</div>
      <div style="opacity:.6;font-size:11px">${size ? size + ' Bytes' : ''}</div>
    `;
      el.addEventListener('click', async () => {
        selectedItem = file;
        selectedKind = kind;

        if (kind === 'templates') {
          // Templates: クリックでエディタ上書き表示、Overviewは非表示に
          $overview.style.display = 'none';
          $overview.innerHTML = '';
          const code = await loadCode(file);
          currentFileName = file.name;
          if (monacoEditor) monacoEditor.setValue(code);
          else await initEditor(code);
          $meta.textContent = `選択中（Template表示）：${file.name}`;
        } else {
          // Snippets: エディタは上書きせず、Overviewのみ出す
          await showSnippetOverview(file);
          $meta.textContent = `選択中（Snippet挿入用）：${file.name}`;
        }
        [$download, $insert, $copy].forEach(b => b.disabled = false);
      }, { passive: true });
      return el;
    }
    function renderList(kind, files) {
      $list.innerHTML = '';
      if (!files.length) {
        $list.innerHTML = `<div style="padding:12px; opacity:.7">.js ファイルが見つかりませんでした。</div>`;
        // 一覧が空ならOverviewも消す
        $overview.style.display = 'none';
        $overview.innerHTML = '';
        return;
      }
      const frag = document.createDocumentFragment();
      files.forEach(f => frag.appendChild(fileRow(f, kind)));
      $list.appendChild(frag);

      // 選択状態リセット
      selectedItem = null;
      [$download, $insert, $copy].forEach(b => b.disabled = true);
      $meta.textContent = '';
      // タブ切替時にOverviewの表示/非表示を整理
      if (kind === 'snippets') {
        $overview.style.display = 'block';
        $overview.innerHTML = `<div style="opacity:.7; padding:8px; border:1px dashed ${BD}; border-radius:8px;">スニペットを選択するとプレビューが表示されます</div>`;
      } else {
        $overview.style.display = 'none';
        $overview.innerHTML = '';
      }
    }
    async function showSnippetOverview(file) {
      try {
        const code = await loadCode(file);
        const head = code.split('\n').slice(0, 20).join('\n'); // 先頭20行
        $overview.style.display = 'block';
        $overview.innerHTML = `
        <div style="margin-top:8px; border:1px solid ${BD}; border-radius:8px; overflow:hidden;">
          <div style="padding:6px 8px; font-weight:600; ${isDark ? 'background:#101010;color:#eee;' : 'background:#f7f7f7;color:#111;'}">
            Snippet Overview
            <span>（ファイル:</span> <strong>${file.name}）</strong>
          </div>
          <div style="padding:8px; ${isDark ? 'background:#0f0f0f;color:#ddd;' : 'background:#fafafa;color:#333;'}">
            <pre style="margin:0; white-space:pre-wrap; font-size:12px; line-height:1.4; max-height:180px; overflow:auto;">${escapeHtml(head)}</pre>
          </div>
        </div>`;
      } catch (e) {
        $overview.style.display = 'block';
        $overview.innerHTML = `<div style="margin-top:8px; color:#c00">プレビュー取得に失敗しました。</div>`;
      }
    }
    function escapeHtml(s) {
      return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    // 初期化：Monaco & 補完
    await initEditor('');
    if (window.monaco && !window.monaco._kintoneFieldsReady) {
      await registerFieldCompletions(window.monaco);
      window.monaco._kintoneFieldsReady = true;
    }

    // ボタン挙動
    $download.addEventListener('click', async () => {
      if (!selectedItem) return;
      let name = currentFileName || 'template.js';
      let content = '';
      if (selectedKind === 'templates') {
        content = monacoEditor ? monacoEditor.getValue() : '';
      } else {
        name = selectedItem.name;
        content = await loadCode(selectedItem);
      }
      const blob = new Blob([content], { type: 'text/javascript' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    $insert.addEventListener('click', async () => {
      if (!selectedItem || !monacoEditor) return;
      const code = await loadCode(selectedItem); // 種別問わず“選択中コード”を挿入
      monacoEditor.focus();
      const sel = monacoEditor.getSelection();
      monacoEditor.executeEdits('tpl-insert', [{ range: sel, text: `\n${code}\n` }]);
      $meta.textContent = (selectedKind === 'snippets')
        ? `✅ Snippet を挿入しました：${selectedItem.name}`
        : `✅ Template を挿入しました（追記）：${selectedItem.name}`;
      setTimeout(() => ($meta.textContent = ''), 1500);
    });

    $copy.addEventListener('click', async () => {
      if (!selectedItem) return;
      const text = (selectedKind === 'templates')
        ? (monacoEditor ? monacoEditor.getValue() : '')
        : await loadCode(selectedItem);
      try {
        await navigator.clipboard.writeText(text);
        $meta.textContent = '✅ コピーしました';
      } catch {
        $meta.textContent = '⚠️ コピーに失敗しました';
      }
      setTimeout(() => ($meta.textContent = ''), 1200);
    });

    $refresh.addEventListener('click', async () => {
      sessionStorage.removeItem(GH.cacheKey($sourceSel.value));
      await loadList();
    });

    $sourceSel.addEventListener('change', loadList);

    // 初回ロード
    await loadList();

    // ロード関数
    async function loadList() {
      const kind = $sourceSel.value;
      selectedKind = kind;
      $list.innerHTML = `<div style="padding:12px; opacity:.7">読み込み中...</div>`;
      try {
        const files = await fetchList(kind, true);
        renderList(kind, files);
      } catch (e) {
        console.warn(e);
        const c = sessionStorage.getItem(GH.cacheKey(kind));
        if (c) renderList(kind, JSON.parse(c));
        else {
          $list.innerHTML = `<div style="padding:12px; color:#c00">取得に失敗しました。</div>`;
          $overview.style.display = 'none';
          $overview.innerHTML = '';
        }
      }
    }

    // どこか1回だけ実行（存在すればスキップ）
    if (!document.getElementById('kt-tpl-inline-style')) {
      const st = document.createElement('style');
      st.id = 'kt-tpl-inline-style';
      st.textContent = `
        .btn {
          border: 1px solid ${BD};
          background: ${isDark ? '#1e1e1e' : '#fff'};
          color: ${isDark ? '#eee' : '#111'};
          border-radius: 8px;
          line-height: 1;
          cursor: pointer;
        }
        .btn:disabled {
          opacity: .5;
          cursor: not-allowed;
        }
        .btn:not(:disabled):hover {
          filter: brightness(${isDark ? 1.1 : 0.98});
        }
      `;
      document.head.appendChild(st);
    }

  }

  async function loadMonaco() {
    if (window.monaco) return window.monaco;
    // AMDローダを読み込み
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.49.0/min/vs/loader.js';
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
    const CDN_BASE = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.49.0/min/';
    window.require.config({
      paths: { vs: CDN_BASE + 'vs' },
      // 任意: 既定言語（エラー回避には不要。英語固定したい場合）
      // 'vs/nls': { availableLanguages: { '*': 'en' } }
    });
    // Worker の importScripts が参照する baseUrl も「/min/」
    window.MonacoEnvironment = {
      getWorkerUrl: function () {
        const code = `
        self.MonacoEnvironment = { baseUrl: '${CDN_BASE}' };
        importScripts('${CDN_BASE}vs/base/worker/workerMain.js');
      `;
        return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      }
    };
    return new Promise((res) => {
      window.require(['vs/editor/editor.main'], () => res(window.monaco));
    });
  }

  let monacoEditor = null;
  async function initEditor(initialCode = '') {
    const monaco = await loadMonaco();
    // JSバリデーション（構文/セマンティック）をON
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSyntaxValidation: false,
      noSemanticValidation: false,
    });
    // 既存textareaをdivに変えている前提
    const el = document.getElementById('kt-tpl-editor');
    el.style.height = '100%';
    monacoEditor = monaco.editor.create(el, {
      value: initialCode,
      language: 'javascript',
      theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs',
      automaticLayout: true,
      fontSize: 12,
      minimap: { enabled: false },
      wordWrap: 'on',
    });

    // 🔽 サイズ変化に確実に追従させる（初期取りこぼし対策）
    const ro = new ResizeObserver(() => { try { monacoEditor.layout(); } catch { } });
    ro.observe(el);
    window.addEventListener('resize', () => { try { monacoEditor.layout(); } catch { } });

    // タブ切替直後の遅延レイアウト（描画完了後に1回）
    setTimeout(() => { try { monacoEditor.layout(); } catch { } }, 0);

    return monacoEditor;
  }

  async function fetchFieldMeta() {
    const app = kintone.app.getId();
    const resp = await kintone.api(kintone.api.url('/k/v1/app/form/fields', true), 'GET', { app });
    const list = [];
    const walkProps = (propsObj = {}) => {
      Object.values(propsObj).forEach(p => {
        if (p.type === 'SUBTABLE') {
          walkProps(p.fields || {});
        } else if (p && p.code) {
          list.push({ code: p.code, label: p.label || p.code });
        }
      });
    };
    walkProps(resp.properties || {});
    return list;
  }

  async function registerFieldCompletions(monaco) {
    const fields = await fetchFieldMeta();
    monaco.languages.registerCompletionItemProvider('javascript', {
      triggerCharacters: ['"', "'", '`', '.', '['],
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        const items = fields.flatMap(f => ([
          // フィールドコード候補
          {
            label: f.code, kind: monaco.languages.CompletionItemKind.Field,
            insertText: f.code, range, detail: `code: ${f.code}`, documentation: f.label
          },
          // レコード参照スニペット例: record['CODE'].value
          {
            label: `record['${f.code}'].value`, kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: `record['${f.code}'].value`, range, detail: 'record[...] 参照', documentation: `${f.label} を参照`
          }
        ]));
        return { suggestions: items };
      }
    });
  }


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
    renderGraphs(root, appId).catch(e => console.warn('[Toolkit] Graphs error', e));
    renderTemplates(root).catch(e => console.warn('[Toolkit] Templates error', e));
  });

})();
