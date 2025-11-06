// ==UserScript==
// @name         kintone App Toolkit
// @namespace    https://github.com/youtotto/kintone-app-toolkit
// @version      1.6.1
// @description  kintone開発をブラウザで完結。アプリ分析・コード生成・ドキュメント編集を備えた開発支援ツールキット。
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
  const escHTML = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

  // ---- GET ラッパ（必要なら差し替え可） ----
  const kGet = (path, params) =>
    kintone.api(kintone.api.url(path, true), 'GET', params);

  // ---- optional（失敗は null に丸める）----
  const opt = (p) => p.catch(() => null);

  /**
   * 指定アプリの各種定義をまとめて取得（生レスポンスのみを返す）
   * @param {number|string} appId
   * @param {(path:string, params:object)=>Promise<any>} [getImpl=kGet] 差し替え用GET関数
   */
  async function prefetchAppData(appId, getImpl = kGet) {
    // この関数内だけで使う、小さなヘルパ
    const api = (path, extra = {}) => getImpl(path, { app: appId, ...extra });

    const [
      fields, layout, views, reports, status, notifs, customize, acl, actions
    ] = await Promise.all([
      api('/k/v1/app/form/fields'),
      api('/k/v1/app/form/layout'),
      opt(api('/k/v1/app/views')),
      opt(api('/k/v1/app/reports')),
      opt(api('/k/v1/app/status')),
      opt(api('/k/v1/app/notifications/general')),
      opt(api('/k/v1/app/customize')),
      opt(api('/k/v1/app/acl')),
      opt(api('/k/v1/app/actions')),
    ]);

    // 生データを読み取り専用で返す（派生計算は別レイヤで）
    return Object.freeze({
      appId,
      fields,     // /k/v1/app/form/fields
      layout,     // /k/v1/app/form/layout
      views,      // /k/v1/app/views               （null可）
      reports,    // /k/v1/app/reports             （null可）
      status,     // /k/v1/app/status              （null可）
      notifs,     // /k/v1/app/notifications/general（null可）
      customize,  // /k/v1/app/customize           （null可）
      acl,        // /k/v1/app/acl                 （null可）
      actions,    // /k/v1/app/actions             （null可）
    });
  }

  // ---- 派生: relations を作る（同期・純関数） ----
  function buildRelations(DATA) {
    const fieldsResp = DATA?.fields;
    const actionsResp = DATA?.actions;

    // フィールド（サブテーブル含む）をフラット化
    function flattenFields(props) {
      if (!props) return [];
      const list = [];
      for (const code in props) {
        const f = props[code];
        if (!f) continue;
        list.push(f);
        if (f.type === 'SUBTABLE' && f.fields) {
          for (const sub in f.fields) {
            const sf = f.fields[sub];
            if (sf) list.push(sf);
          }
        }
      }
      return list;
    }

    const allFields = fieldsResp?.properties ? flattenFields(fieldsResp.properties) : [];

    // Lookups（allFields から relations.lookups を生成）
    const lookups = allFields
      .filter(f => !!f.lookup)
      .map(f => ({
        code: f.code,
        label: f.label,
        relatedAppId: f.lookup?.relatedApp?.app ?? null,
        relatedAppCode: f.lookup?.relatedApp?.code ?? null,
        // 古い形（keyField）への後方互換も維持
        relatedKeyField: f.lookup?.relatedKeyField ?? f.lookup?.keyField ?? null,
        fieldMappings: (f.lookup?.fieldMappings || [])
          .map(m => ({
            // ← 重要：Kintoneレスポンスは「relatedField=元, field=先」
            from: m?.relatedField?.code ?? m?.relatedField ?? null, // コピー元（参照アプリ側）
            to: m?.field?.code ?? m?.field ?? null  // コピー先（自アプリ側）
          }))
          .filter(x => x.from || x.to),
        lookupPickerFields: Array.isArray(f.lookup?.lookupPickerFields)
          ? [...f.lookup.lookupPickerFields]
          : [],
      }));

    // Related Records（REFERENCE_TABLE）
    const relatedTables = allFields
      .filter(f => f.type === 'REFERENCE_TABLE' && f.referenceTable)
      .map(f => ({
        code: f.code,
        label: f.label,
        relatedAppId: f.referenceTable?.relatedApp?.app ?? null,
        relatedAppCode: f.referenceTable?.relatedApp?.code ?? null,
        condition: f.referenceTable?.condition ?? '',
        displayFields: Array.isArray(f.referenceTable?.displayFields)
          ? f.referenceTable.displayFields.slice()
          : [],
        sort: f.referenceTable?.sort ?? '',
      }));

    // ---- Actions（srcField→destField 文字列で保存）----
    const actions = actionsResp?.actions
      ? Object.entries(actionsResp.actions).map(([key, a], i) => {
        const dest = a?.destApp || a?.toApp || {};

        // ここを「文字列で保存」に変更
        const mappings = (a?.mappings || a?.mapping || [])
          .map(m => {
            const left = m?.srcField ?? (m?.srcType || ''); // srcFieldが無ければsrcType
            const right = m?.destField ?? '';
            const L = left ? left : '—';
            const R = right ? right : '—';
            return `${L} → ${R}`;
          })
          .join('<br>'); // 複数は改行

        const entities = Array.isArray(a?.entities)
          ? a.entities.map(e => ({ type: e?.type ?? null, code: e?.code ?? null }))
          : [];

        return {
          id: a?.id ?? key,
          name: a?.name ?? key,
          toAppId: dest?.app ?? null,
          toAppCode: dest?.code ?? null,
          mappings,                 // ← 文字列で保存（例: "数値_0 → 数値_0<br>RECORD_URL → リンク_0"）
          entities,
          filterCond: a?.filterCond ?? '',
        };
      })
      : [];


    return { lookups, relatedTables, actions };
  }

  /** ----------------------------
  * CONSTANTS
  * ---------------------------- */
  const CONTAINER_TYPES = new Set(['GROUP', 'SUBTABLE', 'LABEL']);
  const SYSTEM_TYPES = new Set(['RECORD_NUMBER', 'CREATOR', 'CREATED_TIME', 'MODIFIER', 'UPDATED_TIME', 'STATUS', 'STATUS_ASSIGNEE']);

  /** ----------------------------
  * Small utils
  * ---------------------------- */
  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* シンプルなスピナー: Spinner.show()で表示　.hide()で非表示 */
  const Spinner = (() => {
    let node;
    return {
      show() {
        if (node) return;
        node = document.createElement('div');
        node.innerHTML = '<div style="padding:12px 16px;border:1px solid #999;border-radius:10px;background:#fff">Loading...</div>';
        node.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;background:rgba(255,255,255,.4);z-index:9999;';
        document.body.appendChild(node);
      },
      hide() { node?.remove(); node = null; }
    };
  })();

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
      position:fixed; right:16px; bottom:16px; z-index:9998;
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
        #kt-toolkit.is-mini{
          width:auto !important; max-width:calc(100vw - 32px) !important;
          height:auto !important; max-height:none !important; overflow:visible !important;
        }
        #kt-toolkit.is-mini .body{ display:none !important; }
        #kt-toolkit.is-mini .tabs{ display:none !important; }
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

        /* Relations: 個別スタイル（graphviewに寄せる） */
        #view-relations th { white-space:nowrap; }
        #view-relations td { padding:6px; border-bottom:1px solid var(--kt-border3, #e6e6e6); }
        #view-relations details > summary::-webkit-details-marker { display:none; }
        #view-relations details > summary { outline:none; }
        #view-relations .table-container { overflow: hidden; /* colgroup+wrapで横スクロール抑制 */ }

      </style>
      <div class="bar">
        <div class="tabs">
          <button id="tab-health" class="tab active">Health</button>
          <button id="tab-fields" class="tab">Fields</button>
          <button id="tab-views"  class="tab">Views</button>
          <button id="tab-graphs" class="tab">Graphs</button>
          <button id="tab-relations" class="tab">Relations</button>
          <button id="tab-templates" class="tab">Templates</button>
        </div>
        <div class="actions" style="display:flex;gap:6px;align-items:center;">
          <button id="kt-mini" class="btn" title="最小化">–</button>
          <button id="kt-close" class="btn" title="閉じる">×</button>
        </div>
      </div>
      <div class="body">
        <div id="view-health"></div>
        <div id="view-fields" style="display:none"></div>
        <div id="view-views"  style="display:none"></div>
        <div id="view-graphs" style="display:none"></div>
        <div id="view-relations" style="display:none"></div>
        <div id="view-templates" style="display:none"></div>
      </div>
    `;
    document.body.appendChild(wapCheck(wrap));

    // === 最小化：ドメイン共通 ===
    const MINI_KEY = `kt_mini_${location.host}_global`;

    // 状態適用＋保存
    function setMini(on) {
      wrap.classList.toggle('is-mini', !!on);
      try { localStorage.setItem(MINI_KEY, on ? '1' : '0'); } catch (e) { }
    }

    // 復元（既定=非最小）
    (function restoreMini() {
      try {
        const v = localStorage.getItem(MINI_KEY);
        if (v === '1') wrap.classList.add('is-mini');
      } catch (e) { }
    })();

    // トグル
    function toggleMini() { setMini(!wrap.classList.contains('is-mini')); }

    // ボタン取得＆イベント
    const btnMini = wrap.querySelector('#kt-mini');
    const btnClose = wrap.querySelector('#kt-close');
    btnMini && btnMini.addEventListener('click', toggleMini, { passive: true });
    btnClose && btnClose.addEventListener('click', () => wrap.remove(), { passive: true });

    wrap.querySelector('#kt-close').addEventListener('click', () => wrap.remove(), { passive: true });
    const switchTab = (idShow) => {
      wrap.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
      wrap.querySelector('#tab-' + idShow).classList.add('active');
      wrap.querySelector('#view-health').style.display = idShow === 'health' ? 'block' : 'none';
      wrap.querySelector('#view-fields').style.display = idShow === 'fields' ? 'block' : 'none';
      wrap.querySelector('#view-views').style.display = idShow === 'views' ? 'block' : 'none';
      wrap.querySelector('#view-graphs').style.display = idShow === 'graphs' ? 'block' : 'none';
      wrap.querySelector('#view-relations').style.display = idShow === 'relations' ? 'block' : 'none';
      wrap.querySelector('#view-templates').style.display = idShow === 'templates' ? 'block' : 'none';
    };
    wrap.querySelector('#tab-health').addEventListener('click', () => switchTab('health'), { passive: true });
    wrap.querySelector('#tab-fields').addEventListener('click', () => switchTab('fields'), { passive: true });
    wrap.querySelector('#tab-views').addEventListener('click', () => switchTab('views'), { passive: true });
    wrap.querySelector('#tab-graphs').addEventListener('click', () => switchTab('graphs'), { passive: true });
    wrap.querySelector('#tab-relations').addEventListener('click', () => switchTab('relations'), { passive: true });
    wrap.querySelector('#tab-templates').addEventListener('click', () => switchTab('templates'), { passive: true });
    return wrap;

  };

  // safety: if DOM node detached before append
  function wapCheck(el) { return el; }

  /** --------------------------------------------------------
  * Health view
  * -------------------------------------------------------- */
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

  // renderHealth
  const renderHealth = async (
    root,
    { appId, fields, status, views, notifs, customize, acl }
  ) => {
    let TH = loadTH();

    // ガード
    const el = root.querySelector('#view-health');
    if (!el) return;

    // --- メトリクス計算（整形はこの中だけ） ---
    const props = Object.values((fields && fields.properties) || {});
    const flatten = (arr) =>
      arr.flatMap((p) => (p.type === 'SUBTABLE' ? [p, ...Object.values(p.fields)] : [p]));
    const list = flatten(props);

    const metrics = {
      totalFields: list.length,
      groups: list.filter((f) => f.type === 'GROUP').length,
      subtables: list.filter((f) => f.type === 'SUBTABLE').length,
      subtableColsMax: Math.max(
        0,
        ...props
          .filter((f) => f.type === 'SUBTABLE')
          .map((t) => Object.keys(t.fields || {}).length)
      ),
      states: Object.keys((status && status.states) || {}).length,
      actions: ((status && status.actions) || []).length,
      views: views ? Object.keys((views.views) || {}).length : null,
      notifications: notifs ? ((notifs.notifications) || []).length : null,
      jsFiles: customize ? ((customize.desktop && customize.desktop.js) || []).length : null,
      cssFiles: customize ? ((customize.desktop && customize.desktop.css) || []).length : null,
      roles: acl ? ((acl.rights) || []).length : null
    };

    const score = {
      totalFields: judge(metrics.totalFields, TH.totalFields),
      states: judge(metrics.states, TH.states),
      actions: judge(metrics.actions, TH.actions)
    };

    // --- 描画 ---
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

    // しきい値テーブル
    const rowsEl = el.querySelector('#kt-th-rows');
    const renderTHRows = () => {
      rowsEl.innerHTML = Object.entries(TH)
        .map(
          ([k, v]) => `
        <tr data-key="${k}">
          <td>${v.label}</td>
          <td style="text-align:right"><input type="number" min="0" value="${v.Y}"></td>
          <td style="text-align:right"><input type="number" min="0" value="${v.R}"></td>
        </tr>`
        )
        .join('');
    };
    renderTHRows();

    const summaryText =
      `App ${appId}\n` +
      `  Fields: ${metrics.totalFields} (Group: ${metrics.groups}, SubTable: ${metrics.subtables}, maxCols:${metrics.subtableColsMax})\n` +
      `  States/Actions: ${metrics.states}/${metrics.actions}\n` +
      `  Views/Notifications: ${metrics.views ?? '-'}\/${metrics.notifications ?? '-'}\n` +
      `  Customize JS/CSS: ${metrics.jsFiles ?? '-'}\/${metrics.cssFiles ?? '-'}\n` +
      `  ACL rules: ${metrics.roles ?? '-'}\n` +
      `  判定: Fields=${score.totalFields.level}, States=${score.states.level}, Actions=${score.actions.level}`;

    // イベント
    el.querySelector('#kt-copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(summaryText);
      const b = el.querySelector('#kt-copy'); const old = b.textContent;
      b.textContent = 'Copied!'; setTimeout(() => (b.textContent = old), 1200);
    });

    el.querySelector('#kt-th').addEventListener('click', () => {
      const p = el.querySelector('#kt-th-panel');
      const s = el.querySelector('#kt-summary');
      const show = p.style.display === 'none';
      p.style.display = show ? 'block' : 'none';
      s.style.display = show ? 'none' : 'block';
    });

    el.querySelector('#kt-th-reset').addEventListener('click', () => {
      TH = loadTH(); renderTHRows();
    });

    el.querySelector('#kt-th-save').addEventListener('click', () => {
      [...rowsEl.querySelectorAll('tr')].forEach((tr) => {
        const key = tr.dataset.key;
        const [yEl, rEl] = tr.querySelectorAll('input');
        const Y = Math.max(0, Number(yEl.value || 0));
        const R = Math.max(0, Number(rEl.value || 0));
        TH[key].Y = Math.min(Y, R);
        TH[key].R = Math.max(R, Y);
      });
      saveTH(TH);
      const b = el.querySelector('#kt-th-save'); const old = b.textContent;
      b.textContent = '保存しました'; setTimeout(() => (b.textContent = old), 1200);
    });
  };


  /** --------------------------------------------------------
  * Fields view (layout-aware, MD with notes)
  * -------------------------------------------------------- */
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
  const renderFields = async (root, { appId, fields, layout }) => {
    const normalizeType = (f) => (f && f.lookup ? 'LOOKUP' : (f?.type ?? ''));

    // 生レスポンスの安全な取り出し
    const props = (fields && fields.properties) || {};
    const layoutNodes = (layout && layout.layout) || [];

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
    walkLayout(layoutNodes);

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
      .map(r => ({ ...r, groupPath: groupPathByCode[r.code] || '' }))
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
    if (!el) return;

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

  /** --------------------------------------------------------
  * Views view（全一覧の一覧化）
  * -------------------------------------------------------- */
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

  const toViewsCSV = (rows) => [
    ['ビューID', 'ビュー名', '種類', 'フィルター', 'ソート'].join(','),
    ...rows.map(r => [
      r.name, r.type, r.conditionPretty || '（なし）', r.sortPretty || '（なし）', r.id
    ].map(s => `"${String(s ?? '').replace(/"/g, '""')}"`).join(','))
  ].join('\r\n');

  const toViewsMarkdown = (rows) => {
    const header = ['ビューID', 'ビュー名', '種類', 'フィルター', 'ソート'];
    const sep = header.map(() => ' :- ').join(' | ');
    const lines = rows.map(r => [
      r.id, r.name, r.type, r.conditionPretty || '（なし）', r.sortPretty || '（なし）'
    ].map(x => String(x).replace(/\|/g, '\\|')).join(' | '));
    return ['| ' + header.join(' | ') + ' |', '| ' + sep + ' |', ...lines.map(l => '| ' + l + ' |')].join('\n');
  };

  // ==== Views ====
  const renderViews = async (root, { appId, views, fields }) => {
    const el = root.querySelector('#view-views');
    if (!el) return;
    el.innerHTML = `<div style="opacity:.8">Loading views…</div>`;

    // フィールドcode→label Map（SUBTABLE子も含む）
    const code2label = new Map();
    const props = (fields && fields.properties) || {};
    (function walk(obj) {
      Object.values(obj || {}).forEach(p => {
        if (p.code && p.label) code2label.set(p.code, p.label);
        if (p.type === 'SUBTABLE' && p.fields) walk(p.fields);
      });
    })(props);

    // viewsを配列化＆index昇順
    const viewsArray = Object.values((views && views.views) || {});
    viewsArray.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    const rows = viewsArray.map(v => {
      const condition = v.filterCond || '';
      const sort = (v.sort || '').trim();
      const query = condition + (sort ? ` order by ${sort}` : '');
      const parsed = parseQuery(query);

      return {
        id: String(v.id ?? ''),
        name: v.name || '',
        type: v.type || '',
        conditionRaw: parsed.condition,
        conditionPretty: labelizeQueryPart(parsed.condition, code2label),
        sortRaw: (parsed.orderBy || []).join(', '),
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
        </div>
      </div>

      <div style="opacity:.9;margin-bottom:6px">
        デフォルトビュー（並び順1位）：<strong>${escHTML(defaultName || '—')}</strong>
      </div>

      <div class="table-container">
        <table style="border-collapse:collapse;width:100%;table-layout:fixed">
          <colgroup>
            <col style="width:88px">
            <col style="width:28%">
            <col style="width:88px">
            <col style="width:auto">
            <col style="width:26%">
          </colgroup>
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

    // DLヘルパ
    const dl = (filename, text, type = 'text/plain') => {
      const blob = new Blob([text], { type });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    };

    // イベント（コピー／DLのみ）
    el.querySelector('#kv-copy-md').addEventListener('click', async () => {
      await navigator.clipboard.writeText(md);
      const b = el.querySelector('#kv-copy-md'); const t = b.textContent;
      b.textContent = 'Copied!'; setTimeout(() => (b.textContent = t), 1200);
    });

    el.querySelector('#kv-dl-md').addEventListener('click', () =>
      dl(`kintone_views_${appId}.md`, md, 'text/markdown'));

    el.querySelector('#kv-copy-csv').addEventListener('click', async () => {
      await navigator.clipboard.writeText(csv);
      const b = el.querySelector('#kv-copy-csv'); const t = b.textContent;
      b.textContent = 'Copied!'; setTimeout(() => (b.textContent = t), 1200);
    });

    el.querySelector('#kv-dl-csv').addEventListener('click', () =>
      dl(`kintone_views_${appId}.csv`, csv, 'text/csv'));
  };

  /** --------------------------------------------------------
  * Graphs views
  * -------------------------------------------------------- */
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

  const renderGraphs = async (root, { appId, reports, fields }) => {
    const el = root.querySelector('#view-graphs');
    if (!el) return;
    el.innerHTML = `<div style="opacity:.8">Loading graphs…</div>`;

    // フィールド code→label Map（SUBTABLE 子も含む）
    const code2label = new Map();
    const props = (fields && fields.properties) || {};
    (function walk(obj) {
      Object.values(obj || {}).forEach(p => {
        if (p.code && p.label) code2label.set(p.code, p.label);
        if (p.type === 'SUBTABLE' && p.fields) walk(p.fields);
      });
    })(props);

    // fmtSorts などがグローバル参照している場合に備えて置いておく（互換維持）
    window.__kt_code2label = code2label;

    // reports は { name: {...} } 想定 → 配列へ
    const reportsArr = Object.values((reports && reports.reports) || {});

    // 並び順（index）→ 名前の昇順
    reportsArr.sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0) ||
        String(a.name || '').localeCompare(String(b.name || ''))
    );

    // 表示用行
    const rows = reportsArr.map(r => {
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

    // UI
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:nowrap;min-width:0">
        <div style="font-weight:700;white-space:nowrap">Graphs（グラフ全一覧）</div>
        <div style="display:flex;gap:6px;flex-wrap:nowrap;overflow:auto;white-space:nowrap">
          <button id="kg-copy-md"  class="btn">Copy Markdown</button>
          <button id="kg-dl-md"    class="btn">Download MD</button>
          <button id="kg-copy-csv" class="btn">Copy CSV</button>
          <button id="kg-dl-csv"   class="btn">Download CSV</button>
        </div>
      </div>
      <div class="table-container">
        <table style="border-collapse:collapse;width:100%;table-layout:fixed">
          <colgroup>
            <col style="width:88px">
            <col style="width:24%">
            <col style="width:100px">
            <col style="width:100px">
            <col style="width:24%">
            <col style="width:110px">
            <col style="width:24%">
          </colgroup>
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

    // エクスポート
    const dl = (filename, text, type = 'text/plain') => {
      const blob = new Blob([text], { type });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    };

    el.querySelector('#kg-copy-md').addEventListener('click', async () => {
      await navigator.clipboard.writeText(md);
      const b = el.querySelector('#kg-copy-md'); const t = b.textContent;
      b.textContent = 'Copied!'; setTimeout(() => b.textContent = t, 1200);
    }, { passive: true });
    el.querySelector('#kg-dl-md').addEventListener('click', () =>
      dl(`kintone_graphs_${appId}.md`, md, 'text/markdown'), { passive: true });
    el.querySelector('#kg-copy-csv').addEventListener('click', async () => {
      await navigator.clipboard.writeText(csv);
      const b = el.querySelector('#kg-copy-csv'); const t = b.textContent;
      b.textContent = 'Copied!'; setTimeout(() => b.textContent = t, 1200);
    }, { passive: true });
    el.querySelector('#kg-dl-csv').addEventListener('click', () =>
      dl(`kintone_graphs_${appId}.csv`, csv, 'text/csv'), { passive: true });
  };

  /** --------------------------------------------------------
  * Relations view
  * -------------------------------------------------------- */
  // ===== ダウンロード共通ユーティリティ =====
  function dlText(filename, text, mime = 'text/plain;charset=utf-8') {
    const blob = new Blob([text], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function toRelationsCSV(headers, rows) {
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const head = headers.map(q).join(',');
    const body = rows.map(r => r.map(q).join(',')).join('\r\n');
    return [head, body].join('\r\n');
  }

  // MDテーブル
  function toRelationsMD(headers, rows) {
    const esc = (s) => mdEsc(s);
    const header = `| ${headers.join(' | ')} |`;
    const sep = `| ${headers.map(() => ':-').join(' | ')} |`;
    const lines = rows.length
      ? rows.map(r => `| ${r.map(esc).join(' | ')} |`).join('\n')
      : `| ${headers.map(() => '-').join(' | ')} |`;
    return [header, sep, lines].join('\n');
  }

  // --- 4ボタン＋折り畳み＋インジケータ---
  function sectionWithDL(
    title, headers, dlRows, innerTableHTML, filenameBase = 'relations',
    { defaultOpen = true, indicator = false } = {}
  ) {
    const t = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const suffix = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}_${pad(t.getHours())}${pad(t.getMinutes())}`;

    // セクション固有ID（ここを基準スコープにする）
    const uid = Math.random().toString(36).slice(2, 8);
    const secId = `rel-sec-${uid}`;
    const btnCopyMd = `btn-copy-md-${uid}`;
    const btnDlMd = `btn-dl-md-${uid}`;
    const btnCopyCsv = `btn-copy-csv-${uid}`;
    const btnDlCsv = `btn-dl-csv-${uid}`;
    const indId = `rel-ind-${uid}`;

    const mdStr = toRelationsMD(headers, dlRows);
    const csvStr = toRelationsCSV(headers, dlRows);
    const caret = indicator ? (defaultOpen ? '▾' : '▸') : '';

    const html = `
    <section id="${secId}" style="margin:12px 0 20px">
      <details ${defaultOpen ? 'open' : ''}>
        <summary style="list-style:none;cursor:pointer">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin:0 0 8px;flex-wrap:nowrap;min-width:0">
            <h3 style="font-size:14px;margin:0;border-left:4px solid #888;padding-left:8px;display:flex;align-items:center;gap:6px;flex:1">
              ${indicator ? `<span id="${indId}" aria-hidden="true" style="display:inline-block;width:1em;text-align:center">${caret}</span>` : ''}
              <span>${title}</span>
            </h3>
            <div style="display:flex;gap:6px;flex-wrap:nowrap;overflow:auto;white-space:nowrap">
              <button id="${btnCopyMd}"  class="btn">Copy Markdown</button>
              <button id="${btnDlMd}"    class="btn">Download MD</button>
              <button id="${btnCopyCsv}" class="btn">Copy CSV</button>
              <button id="${btnDlCsv}"   class="btn">Download CSV</button>
            </div>
          </div>
        </summary>
        <div class="table-container" style="border:1px solid #ddd;border-radius:8px">
          ${innerTableHTML}
        </div>
      </details>
    </section>
  `;

    const bind = (root = document) => {
      // ここから先は「このセクションだけ」をスコープに探索
      const container = (root.querySelector ? root.querySelector(`#${secId}`) : document.getElementById(secId));
      if (!container) return;
      const qs = (sel) => container.querySelector(sel);
      const touch = (btn, txt = 'Copied!') => { if (!btn) return; const o = btn.textContent; btn.textContent = txt; setTimeout(() => btn.textContent = o, 1200); };

      // Copy / Download
      qs(`#${btnCopyMd}`)?.addEventListener('click', async () => {
        await navigator.clipboard.writeText(mdStr);
        touch(qs(`#${btnCopyMd}`));
      }, { passive: true });

      qs(`#${btnDlMd}`)?.addEventListener('click', () => {
        const name = `${filenameBase}_${suffix}.md`;
        dlText(name, mdStr, 'text/markdown;charset=utf-8');
      }, { passive: true });

      qs(`#${btnCopyCsv}`)?.addEventListener('click', async () => {
        await navigator.clipboard.writeText(csvStr);
        touch(qs(`#${btnCopyCsv}`));
      }, { passive: true });

      qs(`#${btnDlCsv}`)?.addEventListener('click', () => {
        const name = `${filenameBase}_${suffix}.csv`;
        dlText(name, csvStr, 'text/csv;charset=utf-8');
      }, { passive: true });

      // ▸/▾ の切替（必要な時だけ）
      if (indicator) {
        const det = qs('details');
        const ind = qs(`#${indId}`);
        det?.addEventListener('toggle', () => { if (ind) ind.textContent = det.open ? '▾' : '▸'; }, { passive: true });
      }
    };

    return { html, bind };
  }

  /**
   * Relationsタブを描画
   * @param {HTMLElement|Document} root  document か ルート要素
   * @param {{relations?:{lookups?:Array, relatedTables?:Array, actions?:Array}}} data
   */
  function renderRelations(root, relations) {
    const view = root.querySelector('#view-relations');
    if (!view) return;

    const R = relations || {};
    const lookups = Array.isArray(R.lookups) ? R.lookups : [];
    const rts = Array.isArray(R.relatedTables) ? R.relatedTables : [];
    const acts = Array.isArray(R.actions) ? R.actions : [];

    const esc = (v) => String(v ?? '');
    const join = (arr, sep = ', ') => (Array.isArray(arr) ? arr.join(sep) : esc(arr));
    const yn = (b) => (b ? '✅' : '—');

    const table = (headers, rows, colWidths = null) => `
      <table style="width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed">
        ${Array.isArray(colWidths) ? `
          <colgroup>
            ${colWidths.map(w => `<col style="width:${w}">`).join('')}
          </colgroup>` : ''}
        <thead>
          <tr>${headers.map(h => `
            <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;white-space:nowrap;">${h}</th>
          `).join('')}</tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map(cols => `
            <tr>${cols.map((c, i) => `
              <td
                style="
                  padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;
                  ${i === 0 || i === 1 ? 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' : ''}
                  ${i >= 2 ? 'white-space:pre-wrap;word-break:break-word;' : ''}
                "
              >${c}</td>
            `).join('')}</tr>
          `).join('') : `<tr><td colspan="${headers.length}" style="padding:10px;color:#666">項目なし</td></tr>`}
        </tbody>
      </table>
    `;

    // ---------- Lookups（表示用とDL用） ----------
    const headersLookups = ['フィールド', '参照アプリID / コード', '参照キー', 'フィールドマッピング', 'ピッカー表示項目'];

    const lookupRowsHtml = [];
    const lookupRowsDL = [];

    lookups.forEach(lu => {
      const app = [lu?.relatedAppId || '', lu?.relatedAppCode || ''].filter(Boolean).join(' / ') || '—';
      const mappingsHtml = (Array.isArray(lu?.fieldMappings) && lu.fieldMappings.length)
        ? lu.fieldMappings.map(m => `${esc(m?.from || '—')} → ${esc(m?.to || '—')}`).join('<br>')
        : '—';
      const mappingsText = (Array.isArray(lu?.fieldMappings) && lu.fieldMappings.length)
        ? lu.fieldMappings.map(m => `${esc(m?.from || '—')} → ${esc(m?.to || '—')}`).join(' / ')
        : '—';
      const keyHtml = lu?.relatedKeyField ? `<code>${esc(lu.relatedKeyField)}</code>` : '—';
      const keyText = lu?.relatedKeyField || '—';
      const picker = (Array.isArray(lu?.lookupPickerFields) && lu.lookupPickerFields.length)
        ? lu.lookupPickerFields.join(', ')
        : '—';

      // 表示：code と label を分行
      lookupRowsHtml.push([
        `<code>${esc(lu?.code ?? '')}</code><br><small>${esc(lu?.label ?? '')}</small>`,
        app,
        keyHtml,
        mappingsHtml,
        picker,
      ]);

      // DL：フィールド列は「ラベル（コード）」で1セルに集約
      lookupRowsDL.push([
        `${lu?.label ?? ''}（${lu?.code ?? ''}）`,
        app,
        keyText,
        mappingsText,
        picker,
      ]);
    });

    // ---------- Related Records（表示用とDL用） ----------
    const headersRT = ['フィールド', '参照アプリID / コード', '連携条件', '表示フィールド', '並び順'];

    const rtRowsHtml = [];
    const rtRowsDL = [];

    rts.forEach(rt => {
      const app = [rt?.relatedAppId || '', rt?.relatedAppCode || ''].filter(Boolean).join(' / ') || '—';
      const cond = (rt?.condition?.field && rt?.condition?.relatedField)
        ? `${esc(rt.condition.field)} = ${esc(rt.condition.relatedField)}`
        : '—';
      const disp = (Array.isArray(rt?.displayFields) && rt.displayFields.length)
        ? rt.displayFields.join(', ')
        : '—';
      const sort = rt?.sort || '—';

      rtRowsHtml.push([
        `<code>${esc(rt?.code ?? '')}</code><br><small>${esc(rt?.label ?? '')}</small>`,
        app,
        cond,
        disp,
        sort,
      ]);
      rtRowsDL.push([
        `${rt?.label ?? ''}（${rt?.code ?? ''}）`,
        app,
        cond,
        disp,
        sort,
      ]);
    });

    // ---------- Actions（表示用とDL用） ----------
    const headersAC = ['ID / 名称', '有効', '作成先アプリID / コード', 'マッピング', '割当対象', 'フィルタ'];

    const actRowsHtml = [];
    const actRowsDL = [];

    acts.forEach(a => {
      const app = [a?.toAppId || '', a?.toAppCode || ''].filter(Boolean).join(' / ') || '—';
      const mapsHtml = (typeof a?.mappings === 'string' && a.mappings.length) ? a.mappings : '—';
      const mapsText = (typeof a?.mappings === 'string' && a.mappings.length)
        ? a.mappings.replace(/<br\s*\/?>/gi, ' / ')
        : '—';
      const entsText = (Array.isArray(a?.entities) && a.entities.length)
        ? a.entities.map(e => `${esc(e?.code ?? '—')}（${esc(e?.type ?? '—')}）`).join(' / ')
        : '—';
      const enabled = !!a?.enabled;

      actRowsHtml.push([
        `<code>${esc(a?.name ?? '')}</code><br><small>${esc(a?.id ?? '')}</small>`,
        yn(enabled),
        app,
        mapsHtml,
        entsText,
        esc(a?.filterCond || ''),
      ]);

      // CSVは TRUE/FALSE、MDは ✓/空欄 に合わせたい場合はここで分岐も可能だが、統一してTRUE/FALSEに寄せる
      actRowsDL.push([
        `${a?.id ?? ''} / ${a?.name ?? ''}`,
        enabled ? 'TRUE' : 'FALSE',
        app,
        mapsText,
        entsText,
        a?.filterCond || '',
      ]);
    });

    // ---------- セクション描画（DLは *DL用行* を渡す） ----------
    // Lookups：開く
    const widthsLookups = ['22%', '16%', '12%', '30%', '20%'];
    const { html: secLU, bind: bindLU } =
      sectionWithDL(
        'Lookups（ルックアップ）',
        headersLookups, lookupRowsDL,
        table(headersLookups, lookupRowsHtml, widthsLookups),
        'relations_lookups',
        { defaultOpen: true, indicator: true }   // ← open
      );

    // Related Records：閉じる
    const widthsRT = ['24%', '16%', '18%', '28%', '14%'];
    const { html: secRT, bind: bindRT } =
      sectionWithDL(
        'Related Records（関連レコード）',
        headersRT, rtRowsDL,
        table(headersRT, rtRowsHtml, widthsRT),
        'relations_relatedTables',
        { defaultOpen: false, indicator: true }  // ← closed
      );

    // Actions：閉じる
    const widthsAC = ['20%', '8%', '18%', '24%', '20%', '10%'];
    const { html: secAC, bind: bindAC } =
      sectionWithDL(
        'Actions（レコード作成アクション）',
        headersAC, actRowsDL,
        table(headersAC, actRowsHtml, widthsAC),
        'relations_actions',
        { defaultOpen: false, indicator: true }  // ← closed
      );

    // まとめて描画 & バインド
    view.innerHTML = `${secLU}${secRT}${secAC}`;
    bindLU(view); bindRT(view); bindAC(view);

    // まとめて描画＆バインド
    view.innerHTML = `${secLU}${secRT}${secAC}`;
    bindLU(view); bindRT(view); bindAC(view);
  }


  /** --------------------------------------------------------
  * Templates view
  * -------------------------------------------------------- */
  async function renderTemplates(root, DATA, appId) {
    const view = root.querySelector('#view-templates');
    if (!view) return;
    let currentFileName = 'template.js';

    // GitHub設定
    const GH = {
      owner: 'youtotto',
      repo: 'kintoneCustomizeJS',
      dirs: { templates: 'js', snippets: 'snippets', documents: 'documents' },
      endpoint(dir) { return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${encodeURIComponent(dir)}`; },
      cacheKey(kind) { return `kt_tpl_cache_ui_${kind}`; }
    };

    // UI色
    const isDark = matchMedia('(prefers-color-scheme: dark)').matches;
    const BG = isDark ? '#1b1b1b' : '#fff';
    const BD = isDark ? '#333' : '#ddd';
    const PANEL_H = '65vh';

    // レイアウト
    view.innerHTML = `
      <div id="kt-tpl" style="display:flex; gap:14px; align-items:stretch;">
        <!-- 左：エディタ -->
        <div style="flex:2; min-width:380px; display:flex; flex-direction:column; gap:10px;">
          <div style="display:flex; align-items:center; gap:10px; justify-content:space-between;">
            <div style="display:flex; align-items:center; gap:8px;">
              <button id="kt-tpl-download" class="btn" disabled style="height:32px; padding:0 10px;">↓ ダウンロード</button>
              <button id="kt-tpl-upload" class="btn" disabled style="height:32px; padding:0 10px;">↑ アップロード</button>
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
              <option value="documents">Documents (GitHub: ${GH.dirs.documents})</option>
            </select>
          </div>

          <div style="display:flex; gap:8px;">
            <button id="kt-tpl-insert" class="btn" disabled style="flex:1; height:32px;">⤴︎ 挿入</button>
            <button id="kt-tpl-copy" class="btn" disabled style="flex:1; height:32px;">⎘ コピー</button>
            <button id="kt-tpl-refresh" class="btn" style="flex:1; height:32px;">↻ 更新</button>
            <button id="kt-tpl-ai-req" class="btn" style="flex:1; height:32px; display:none;">AI</button>
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
          <div id="kt-tpl-overview"></div>
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
    const $btnAIReq = view.querySelector('#kt-tpl-ai-req');
    const $upload = view.querySelector('#kt-tpl-upload');

    function updateAIReqVisibility() {
      const isDocs = ($sourceSel.value === 'documents');
      // 表示/非表示
      $btnAIReq.style.display = isDocs ? '' : 'none';
      if (!isDocs) return;

      // documents のときは内容があれば有効化
      const text = (monacoEditor ? monacoEditor.getValue() : '').trim();
      $btnAIReq.disabled = !text;
    }

    // 状態
    let selectedItem = null;        // 選択中ファイル
    let selectedKind = 'templates'; // 'templates' | 'snippets' | 'documents'

    // ヘルパ
    async function loadCode(file) {
      const res = await fetch(file.download_url);
      if (!res.ok) throw new Error(`raw fetch ${res.status}`);
      return await res.text();
    }

    function setEditorLanguage(lang = 'javascript') {
      if (!window.monaco || !monacoEditor) return;
      const model = monacoEditor.getModel();
      if (model) window.monaco.editor.setModelLanguage(model, lang);
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

      const files = (Array.isArray(json) ? json : []).filter(x => {
        if (x.type !== 'file' || !x.name) return false;
        const n = x.name.toLowerCase();
        if (kind === 'templates' || kind === 'snippets') return n.endsWith('.js');
        if (kind === 'documents') return (n.endsWith('.md') || n.endsWith('.mdx') || n.endsWith('.markdown') || n.endsWith('.txt'));
        return false;
      });
      sessionStorage.setItem(cKey, JSON.stringify(files));
      return files;
    }

    function fileRow(file, kind) {
      const el = document.createElement('div');
      el.style.cssText = `display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid ${BD};cursor:pointer;`;
      const size = (file.size || 0).toLocaleString();
      const tag = kind === 'snippets' ? 'SNIP' : (kind === 'documents' ? 'DOC' : 'JS');
      el.innerHTML = `
        <div style="border:1px solid ${BD};border-radius:999px;padding:2px 6px;font-size:11px">${tag}</div>
        <div style="flex:1">${file.name}</div>
        <div style="opacity:.6;font-size:11px">${size ? size + ' Bytes' : ''}</div>
      `;

      if (kind === 'templates') setEditorLanguage('javascript');
      else if (kind === 'documents') setEditorLanguage('markdown');

      el.addEventListener('click', async () => {
        selectedItem = file;
        selectedKind = kind;

        if (window.monaco && monacoEditor && !monacoEditor._aiReqHooked) {
          monacoEditor._aiReqHooked = true;
          monacoEditor.onDidChangeModelContent(() => {
            updateAIReqVisibility();
          });
        }

        if (kind === 'templates') {
          // エディタ上書き表示、Overview非表示
          $overview.style.display = 'none';
          $overview.innerHTML = '';
          const code = await loadCode(file);
          currentFileName = file.name;
          if (monacoEditor) monacoEditor.setValue(code);
          else await initEditor(code);
          updateAIReqVisibility();
          $meta.textContent = `選択中（Template表示）：${file.name}`;
          [$download, $copy, $upload].forEach(b => b.disabled = false);
          $insert.disabled = false;
        } else if (kind === 'snippets') {
          await showSnippetOverview(file);
          $meta.textContent = `選択中（Snippet挿入用）：${file.name}`;
          [$download, $copy, $insert, $upload].forEach(b => b.disabled = false);
        } else if (kind === 'documents') {
          $overview.style.display = 'none';
          $overview.innerHTML = '';
          const code = await loadCode(file);
          currentFileName = file.name;
          if (monacoEditor) monacoEditor.setValue(code);
          else await initEditor(code);
          updateAIReqVisibility();
          $meta.textContent = `選択中（document表示）：${file.name}`;
          [$download, $copy].forEach(b => b.disabled = false);
          [$upload].forEach(b => b.disabled = true);
          $insert.disabled = false; // ドキュメントも挿入可にするなら true のまま
        }
      }, { passive: true });
      return el;
    }

    function renderList(kind, files) {
      $list.innerHTML = '';
      if (!files.length) {
        $list.innerHTML = `<div style="padding:12px; opacity:.7">対象のファイルが見つかりませんでした。</div>`;
        $overview.style.display = 'none';
        $overview.innerHTML = '';
        return;
      }
      const frag = document.createDocumentFragment();
      files.forEach(f => frag.appendChild(fileRow(f, kind)));
      $list.appendChild(frag);

      selectedItem = null;
      [$download, $insert, $copy].forEach(b => b.disabled = true);
      $meta.textContent = '';

      if (kind === 'snippets') {
        $overview.style.display = 'block';
        $overview.innerHTML = `<div style="opacity:.7; padding:8px; border:1px dashed ${BD}; border-radius:8px;">
            ${kind === 'snippets' ? 'スニペット' : 'ドキュメント'}を選択するとプレビューが表示されます
          </div>`;
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

    // 初期化：Monaco & 補完（fields を渡せる場合は渡す）
    await initEditor('');
    if (window.monaco && !window.monaco._kintoneFieldsReady) {
      try {
        // 既存の registerFieldCompletions(monaco, props?) があれば fields.properties を渡す
        await registerFieldCompletions(window.monaco, DATA?.fields?.properties);
      } catch (e) {
        // 旧シグネチャ（monacoのみ）互換
        try { await registerFieldCompletions(window.monaco); } catch { }
      }
      window.monaco._kintoneFieldsReady = true;
    }

    // ボタン挙動
    $download.addEventListener('click', async () => {
      if (!selectedItem) return;
      let name = currentFileName || 'template.js';
      let content = '';
      if (selectedKind === 'templates' || selectedKind === 'documents') {
        content = monacoEditor ? monacoEditor.getValue() : '';
      } else {
        name = selectedItem.name;
        content = await loadCode(selectedItem);
      }
      const mime = selectedKind === 'documents' ? 'text/markdown' : 'text/javascript';
      const blob = new Blob([content], { type: mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    });


    // ------ モーダル：入力ダイアログ（ファイル名＆アップ先） ------
    function openUploadDialog({ defaultName, defaultDesktop = true, defaultMobile = false }) {
      return new Promise((resolve) => {
        // ラッパ
        const wrap = document.createElement('div');
        wrap.id = 'kt-upload-dialog';
        wrap.style.cssText = `
      position: fixed; inset: 0; z-index: 9999;
      background: rgba(0,0,0,.35); display:flex; align-items:center; justify-content:center;
    `;

        // ダイアログ
        const box = document.createElement('div');
        box.style.cssText = `
          width: 520px; max-width: 92vw; border-radius: 12px;
          background: ${document.documentElement.matches('[data-theme="dark"]') ? '#1c1c1c' : '#fff'};
          color: inherit; padding: 16px 18px; box-shadow: 0 12px 30px rgba(0,0,0,.25);
          border: 1px solid ${document.documentElement.matches('[data-theme="dark"]') ? '#333' : '#ddd'};
        `;
        box.innerHTML = `
          <div style="font-weight:700; font-size:16px; margin-bottom:10px;">ファイルをアップロード</div>

          <label style="display:block; font-size:12px; opacity:.8; margin:6px 0 4px;">ファイル名</label>
          <input id="kt-up-name" type="text" value="${defaultName || 'template.js'}"
            style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid #8882; background:transparent; color:inherit" />

          <div style="display:flex; gap:14px; margin-top:12px;">
            <label style="display:flex; gap:8px; align-items:center;">
              <input id="kt-up-desktop" type="checkbox" ${defaultDesktop ? 'checked' : ''}/>
              <span>デスクトップ（JS）</span>
            </label>
            <label style="display:flex; gap:8px; align-items:center;">
              <input id="kt-up-mobile" type="checkbox" ${defaultMobile ? 'checked' : ''}/>
              <span>モバイル（JS）</span>
            </label>
          </div>

          <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:16px;">
            <button id="kt-up-cancel" class="btn" style="height:32px; padding:0 12px;">キャンセル</button>
            <button id="kt-up-ok" class="btn" style="height:32px; padding:0 14px; font-weight:600;">OK</button>
          </div>
        `;

        wrap.appendChild(box);
        document.body.appendChild(wrap);

        const $name = box.querySelector('#kt-up-name');
        const $desktop = box.querySelector('#kt-up-desktop');
        const $mobile = box.querySelector('#kt-up-mobile');
        const $ok = box.querySelector('#kt-up-ok');
        const $cancel = box.querySelector('#kt-up-cancel');

        const close = (result) => {
          wrap.remove();
          resolve(result);
        };

        $ok.addEventListener('click', () => {
          const name = ($name.value || '').trim();
          if (!name) { $name.focus(); return; }
          if (!$desktop.checked && !$mobile.checked) {
            // どちらも未選択は不可
            alert('アップロード先を少なくとも1つ選択してください。');
            return;
          }
          close({ name, toDesktop: $desktop.checked, toMobile: $mobile.checked });
        });
        $cancel.addEventListener('click', () => close(null));
        wrap.addEventListener('click', (e) => { if (e.target === wrap) close(null); });
        $name.select();
      });
    }
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    async function waitDeploy(appId) {
      const maxWaitMs = 60_000, intervalMs = 1500;
      let waited = 0;
      while (true) {
        await sleep(intervalMs);
        waited += intervalMs;
        const st = await kintone.api(
          kintone.api.url('/k/v1/preview/app/deploy.json', true),
          'GET',
          { apps: [Number(appId)] }
        );
        const s = st?.apps?.[0]?.status;
        if (s === 'SUCCESS') return;
        if (s === 'FAIL') throw new Error('Deploy failed.');
        if (waited >= maxWaitMs) throw new Error('Deploy timeout.');
      }
    }
    async function uploadOnce(name, content, mime) {
      const fd = new FormData();
      fd.append('__REQUEST_TOKEN__', kintone.getRequestToken());
      fd.append('file', new Blob([content], { type: mime }), name);
      const up = await fetch(kintone.api.url('/k/v1/file.json', true), {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        body: fd,
        credentials: 'same-origin'
      });
      if (!up.ok) throw new Error(`file upload failed: ${up.status} ${await up.text().catch(() => '')}`);
      const { fileKey } = await up.json();
      return fileKey;
    }

    async function putAppendFileToCustomizeWithTargets(app, keys, { toDesktop, toMobile }) {
      // preview現行
      let base;
      try {
        base = await kintone.api(kintone.api.url('/k/v1/preview/app/customize.json', true), 'GET', { app });
      } catch { base = null; }

      // preview無ければ本番からURLだけ
      if (!base) {
        const prod = await kintone.api(kintone.api.url('/k/v1/app/customize.json', true), 'GET', { app });
        const onlyURL = (arr = []) => (arr || []).filter(x => x?.type === 'URL');
        base = {
          app, scope: prod.scope || 'ALL',
          desktop: { js: onlyURL(prod.desktop?.js), css: onlyURL(prod.desktop?.css) },
          mobile: { js: onlyURL(prod.mobile?.js), css: onlyURL(prod.mobile?.css) }
        };
      }

      const next = {
        app,
        scope: base.scope || 'ALL',
        desktop: {
          js: [
            ...(base.desktop?.js ?? []),
            ...(toDesktop && keys.fileKeyDesktop ? [{ type: 'FILE', file: { fileKey: keys.fileKeyDesktop } }] : [])
          ],
          css: [...(base.desktop?.css ?? [])]
        },
        mobile: {
          js: [
            ...(base.mobile?.js ?? []),
            ...(toMobile && keys.fileKeyMobile ? [{ type: 'FILE', file: { fileKey: keys.fileKeyMobile } }] : [])
          ],
          css: [...(base.mobile?.css ?? [])]
        }
      };

      await kintone.api(kintone.api.url('/k/v1/preview/app/customize.json', true), 'PUT', next);
      await kintone.api(kintone.api.url('/k/v1/preview/app/deploy.json', true), 'POST', { apps: [{ app, revision: -1 }], revert: false });
    }

    $upload?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget; btn.disabled = true;
      try {
        const app = kintone.app.getId();
        const defaultName = (currentFileName || (selectedKind === 'documents' ? 'document.md' : 'template.js'));

        // 1) ダイアログで入力
        const form = await openUploadDialog({
          defaultName,
          defaultDesktop: true,
          defaultMobile: false
        });
        if (!form) return; // cancel

        const mime = (selectedKind === 'documents') ? 'text/markdown' : 'text/javascript';
        const content = monacoEditor ? monacoEditor.getValue() : '';
        if (!content.trim()) throw new Error('editor is empty');

        Spinner.show();
        // ←ここを変更：toDesktop/toMobile に応じてアップロード回数を分ける
        let fileKeyDesktop = null, fileKeyMobile = null;
        if (form.toDesktop && form.toMobile) {
          // 同じ内容を2回アップして別 fileKey を作る
          const [fk1, fk2] = await Promise.all([
            uploadOnce(form.name, content, mime),
            uploadOnce(form.name, content, mime)
          ]);
          fileKeyDesktop = fk1;
          fileKeyMobile = fk2;
        } else if (form.toDesktop) {
          fileKeyDesktop = await uploadOnce(form.name, content, mime);
        } else if (form.toMobile) {
          fileKeyMobile = await uploadOnce(form.name, content, mime);
        }

        //  3) 追記PUT → デプロイ待ち
        await putAppendFileToCustomizeWithTargets(app, { fileKeyDesktop, fileKeyMobile }, {
          toDesktop: form.toDesktop, toMobile: form.toMobile
        });
        await waitDeploy(app);
        alert(`✅ 追記＆デプロイ完了：${form.name}\n[Desktop JS: ${form.toDesktop ? 'Yes' : 'No'} / Mobile JS: ${form.toMobile ? 'Yes' : 'No'}]`);
      } catch (e) {
        console.error('[upload]', e);
        alert(`❌ 失敗：${e?.message || e}`);
      } finally {
        btn.disabled = false;
        Spinner.hide();
      }
    });


    $insert.addEventListener('click', async () => {
      if (!selectedItem || !monacoEditor) return;
      if (selectedKind === 'documents') return; // ドキュメントは挿入不可のままにするなら return
      const code = await loadCode(selectedItem);
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
      const text = (selectedKind === 'templates' || selectedKind === 'documents')
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

    $btnAIReq.addEventListener('click', async () => {
      try {
        // 1) エディタの内容（要件テンプレ）
        const editorMarkdown = (monacoEditor ? monacoEditor.getValue() : '').trim();
        if (!editorMarkdown) {
          $meta.textContent = '⚠️ エディタが空です。先に要件テンプレ（Markdown）を開く/入力してください。';
          setTimeout(() => ($meta.textContent = ''), 2500);
          return;
        }

        // 2) 既取得の DATA から整形（API再呼び出ししない）
        const payload = buildDocPayloadLiteFromPrefetch(DATA);

        // 3) プロンプト組み立て
        const prompt = buildRequirementsPromptFromEditor({ payload, editorMarkdown });

        // 4) テキストファイルとしてダウンロード
        const downloadText = (filename, text) => {
          const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          // 後片付け
          setTimeout(() => {
            URL.revokeObjectURL(url);
            a.remove();
          }, 0);
        };

        // 任意：ファイル名（日時＋アプリID入り）
        const pad = (n) => String(n).padStart(2, '0');
        const d = new Date();
        const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
        const appId = (window.kintone && kintone.app && kintone.app.getId && kintone.app.getId()) || 'app';
        const filename = `requirements_prompt_${appId}_${ts}.txt`;

        downloadText(filename, prompt);

        $meta.textContent = '✅ 生成プロンプトをテキストとしてダウンロードしました。（可能ならクリップボードにもコピー済み）';
        setTimeout(() => ($meta.textContent = ''), 3000);
      } catch (e) {
        console.warn(e);
        $meta.textContent = '⚠️ 生成用プロンプトの準備に失敗しました。';
        setTimeout(() => ($meta.textContent = ''), 2500);
      }
    }, { passive: true });

    // ソース切替
    $sourceSel.addEventListener('change', async () => {
      await loadList();
      updateAIReqVisibility();
    });

    // 初回ロード
    await loadList();

    // リスト読み込み完了後
    async function loadList() {
      const kind = $sourceSel.value;
      selectedKind = kind;
      $list.innerHTML = `<div style="padding:12px; opacity:.7">読み込み中...</div>`;
      try {
        const files = await fetchList(kind, true);
        renderList(kind, files);
      } catch (e) {
        // ...既存のエラーハンドリング...
      }
      updateAIReqVisibility();
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
      .btn:disabled { opacity: .5; cursor: not-allowed; }
      .btn:not(:disabled):hover { filter: brightness(${isDark ? 1.1 : 0.98}); }
    `;
      document.head.appendChild(st);
    }

    // ユーティリティ
    function escapeHtml(s) {
      return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
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

  // ==== DocPayload Lite from prefetch (no extra API calls) ====
  function buildDocPayloadLiteFromPrefetch(pref) {
    if (!pref || !pref.fields || !pref.layout) {
      throw new Error('prefetch data is missing required properties');
    }
    const props = pref.fields?.properties || {};

    // フィールド平坦化（SUBTABLEの子を展開）
    const flatFields = Object.values(props).flatMap(f => {
      if (f.type === 'SUBTABLE') {
        const subs = Object.values(f.fields || {}).map(sf => ({
          code: sf.code, label: sf.label, type: sf.type,
          required: !!sf.required, unique: !!sf.unique, inSubtable: f.code
        }));
        return [{ code: f.code, label: f.label, type: 'SUBTABLE', inSubtable: null }, ...subs];
      }
      return [{ code: f.code, label: f.label, type: f.type, required: !!f.required, unique: !!f.unique, inSubtable: null }];
    });

    // 参照関係（Lookup / 参照テーブル）
    const relations = Object.values(props).flatMap(f => {
      const rels = [];
      if (f.lookup) {
        rels.push({
          kind: 'LOOKUP',
          field: f.code,
          toApp: f.lookup?.relatedApp?.app,
          key: (f.lookup?.fieldMappings || []).map(m => m.field)
        });
      }
      if (f.type === 'REFERENCE_TABLE' && f.referenceTable) {
        rels.push({
          kind: 'REFERENCE_TABLE',
          field: f.code,
          toApp: f.referenceTable?.relatedApp?.app,
          condition: f.referenceTable?.condition
        });
      }
      return rels;
    });

    // レイアウト概要
    const layoutOutline = (pref.layout?.layout || []).map(row => ({
      type: row.type,
      title: row.code ? (props[row.code]?.label || row.code) : (row.label || null),
      fields: (row.fields || []).map(it => ({
        code: it.code || null, label: it.label || null, type: it.type || null
      }))
    }));

    // ビュー/レポート
    const views = Object.values(pref.views?.views || {}).map(v => ({
      name: v.name, type: v.type, sort: v.sort, filterCond: v.filterCond
    }));
    const reports = Object.values(pref.reports?.reports || {}).map(r => ({
      name: r.name, type: r.chartType
    }));

    // カスタマイズ一覧（ファイル名のみ）
    const customize = pref.customize ? {
      desktop: { js: (pref.customize.desktop?.js || []).map(x => x.file), css: (pref.customize.desktop?.css || []).map(x => x.file) },
      mobile: { js: (pref.customize.mobile?.js || []).map(x => x.file), css: (pref.customize.mobile?.css || []).map(x => x.file) }
    } : null;

    return {
      meta: {
        appId: pref.appId,
        appName: pref.app?.name || null,
        retrievedAt: new Date().toISOString()
      },
      fields: flatFields,
      layout: layoutOutline,
      views,
      reports,
      process: pref.status ? { enable: !!pref.status.enable, states: pref.status.states || [], actions: pref.status.actions || [] } : null,
      notifications: pref.notifs || null,
      customize,
      acl: pref.acl || null,
      actions: pref.actions?.actions || [],
      relations
    };
  }

  function buildRequirementsPromptFromEditor({ payload, editorMarkdown }) {
    const system = [
      'あなたはkintoneのシステムエンジニアです。',
      '根拠は与えられたJSONのみ。推測で仕様を追加しない。',
      '出力は日本語Markdown。H1〜H3、箇条書き中心、表は最小限。',
      'ユーザー向け要件(What/Why)と開発向け要件(How/Constraints)を分ける。'
    ].join(' ');

    const user = `
      # 目的
      このアプリ用の**ドラフト**を作成してください。10〜15分でレビューできる密度に抑え、曖昧な点は「未確定事項」として列挙してください。

      # テンプレ（エディタの内容を骨格として使用）
      \`\`\`markdown
      ${editorMarkdown}
      \`\`\`

      # 入力（アプリ定義の要約JSON）
      \`\`\`json
      ${JSON.stringify(payload, null, 2)}
      \`\`\`
      `.trim();

    return `SYSTEM:\n${system}\n\nUSER:\n${user}`;
  }

  /** ----------------------------
  * boot
  * ---------------------------- */
  waitReady().then(async () => {
    const appId = kintone.app.getId();
    if (!appId) return;

    const root = mountRoot();

    // 1) 起動時にスナップショット取得
    const DATA = await prefetchAppData(appId);
    // 2) 必要なものだけ渡す（最小限のヘルパ）
    const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k] ?? null]));
    //    派生 relations を別関数で作る
    let relations = buildRelations(DATA);
    // 3) 各 render に “必要分だけ” 注入
    renderHealth(root, pick(DATA, ['appId', 'fields', 'status', 'views', 'notifs', 'customize', 'acl']));
    renderFields(root, pick(DATA, ['appId', 'fields', 'layout']));
    renderViews(root, pick(DATA, ['appId', 'views', 'fields']));
    renderGraphs(root, pick(DATA, ['appId', 'reports', 'fields']));
    renderRelations(root, relations);
    renderTemplates(root, DATA, appId);

  });

})();
