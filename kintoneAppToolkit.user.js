// ==UserScript==
// @name         kintone App Toolkit
// @namespace    https://github.com/youtotto/kintone-app-toolkit
// @version      2.0.1
// @description  kintone開発をブラウザで完結。アプリ分析・コード生成・ドキュメント編集を備えた開発支援ツールキット。
// @match        https://*.cybozu.com/k/*/
// @match        https://*.cybozu.com/k/*/?*view=*
// @exclude      https://*.cybozu.com/k/admin/*
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @connect      unpkg.com
// @icon         https://www.google.com/s2/favicons?sz=64&domain=cybozu.com
// @run-at       document-idle
// @grant        none
// @require     https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js
// @license      MIT
// @updateURL    https://github.com/youtotto/kintone-app-toolkit/raw/refs/heads/main/kintoneAppToolkit.user.js
// @downloadURL  https://github.com/youtotto/kintone-app-toolkit/raw/refs/heads/main/kintoneAppToolkit.user.js
// ==/UserScript==
(function () {
  'use strict';


  // ==========================================
  // 1. 定数・グローバル状態
  // ==========================================
  const SCRIPT_VERSION = '2.0.1';
  const CONTAINER_TYPES = new Set(['GROUP', 'SUBTABLE', 'LABEL', 'CATEGORY']);
  const SYSTEM_TYPES = new Set(['RECORD_NUMBER', 'CREATOR', 'CREATED_TIME', 'MODIFIER', 'UPDATED_TIME', 'STATUS', 'STATUS_ASSIGNEE']);


  // ==========================================
  // 2. 汎用ユーティリティ (特定の機能に依存しない共通関数)
  // ==========================================
  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapeHtml = (v) => String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // シンプルなスピナー: Spinner.show()で表示　.hide()で非表示
  const Spinner = (() => {
    let node;
    return {
      show() {
        if (node) return;
        node = document.createElement('div');
        node.innerHTML = '<div style="padding:12px 16px;border:1px solid #999;border-radius:10px;background:#fff">update...</div>';
        node.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;background:rgba(255,255,255,.4);z-index:9999;';
        document.body.appendChild(node);
      },
      hide() { node?.remove(); node = null; }
    };
  })();

  // テーマカラーを返す共通関数
  function getThemeColors() {
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    return {
      isDark,
      bg: isDark ? '#111' : '#F5F5F5',
      bgSub: isDark ? '#1d1d1d' : '#eee',
      bgSub2: isDark ? '#1b1b1b' : '#e0e0e0',
      bgInput: isDark ? '#0f0f0f' : '#fff',
      text: isDark ? '#fff' : '#111',
      textSub: isDark ? '#ddd' : '#333',
      border: isDark ? '#2a2a2a' : '#ccc',
      border2: isDark ? '#333' : '#bbb',
      border3: isDark ? '#222' : '#ddd',
    };
  }

  // ボタンの一時表示ユーティリティ（任意）
  function flashBtnText(btn, text = 'Done!', ms = 1200) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), ms);
  }

  // KTExport: CSV/Markdown/DL/Copy 共通ユーティリティ
  const KTExport = (() => {
    // ---- Escape helpers ----
    const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const mdEsc = (v = '') => String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`');

    // ---- Core table builders ----
    // columns: [{ header:'ヘッダ', select:(row)=>値, md?:fn, csv?:fn }]
    function buildMatrix(rows, columns, { forMd = false } = {}) {
      const headers = columns.map(c => c.header);
      const matrix = rows.map(r => columns.map(c => {
        const raw = c.select ? c.select(r) : r[c.key];
        if (forMd) return c.md ? c.md(raw, r) : mdEsc(raw);
        return c.csv ? c.csv(raw, r) : raw;
      }));
      return { headers, matrix };
    }

    function toCSVString(rows, columns) {
      const { headers, matrix } = buildMatrix(rows, columns, { forMd: false });
      const head = headers.map(csvEsc).join(',');
      const body = matrix.map(r => r.map(csvEsc).join(',')).join('\r\n');
      return [head, body].join('\r\n');
    }

    function toMarkdownString(rows, columns) {
      const { headers, matrix } = buildMatrix(rows, columns, { forMd: true });
      const header = `| ${headers.join(' | ')} |`;
      const sep = `| ${headers.map(() => ':-').join(' | ')} |`;
      const lines = (matrix.length
        ? matrix.map(r => `| ${r.map(x => String(x ?? '')).join(' | ')} |`).join('\n')
        : `| ${headers.map(() => '-').join(' | ')} |`);
      return [header, sep, lines].join('\n');
    }

    // ---- Download helpers ----
    function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
      const blob = new Blob([text], { type: mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    function downloadCSV(filename, rows, columns, { withBom = false } = {}) {
      const csv = toCSVString(rows, columns);
      const data = withBom ? '\uFEFF' + csv : csv; // Excel対策（任意）
      downloadText(filename, data, 'text/csv;charset=utf-8');
    }
    function downloadMD(filename, rows, columns) {
      downloadText(filename, toMarkdownString(rows, columns), 'text/markdown;charset=utf-8');
    }

    // ---- Clipboard helpers ----
    async function copyText(text) {
      // 1) 標準API
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {
        // 2) フォールバック（HTTP/権限NG/古いブラウザ）
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          return ok;
        } catch {
          return false;
        }
      }
    }
    async function copyCSV(rows, columns, { withBom = false } = {}) {
      const csv = toCSVString(rows, columns);
      const data = withBom ? '\uFEFF' + csv : csv;
      return copyText(data);
    }
    async function copyMD(rows, columns) {
      return copyText(toMarkdownString(rows, columns));
    }

    return {
      // 文字列生成
      toCSVString, toMarkdownString, mdEsc,
      // ダウンロード
      downloadText, downloadCSV, downloadMD,
      // クリップボード
      copyText, copyCSV, copyMD,
    };
  })();

  // 共通Monacoローダ（複数タブで安全に使う）
  window.loadMonaco = async function loadMonaco() {
    if (window.monaco) return window.monaco; // 既にロード済
    if (window.__monaco_loading__) return window.__monaco_loading__; // 読み込み中Promise共有

    window.__monaco_loading__ = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-monaco-loader]');
      if (existing) {
        existing.addEventListener('load', () => resolve(window.monaco));
        return;
      }
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.36.1/min/vs/loader.min.js';
      s.setAttribute('data-monaco-loader', 'true');
      s.onload = () => {
        require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.36.1/min/vs' } });
        require(['vs/editor/editor.main'], () => resolve(window.monaco));
      };
      s.onerror = reject;
      document.head.appendChild(s);
    });

    return window.__monaco_loading__;
  };

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
      theme: getThemeColors().isDark ? 'vs-dark' : 'vs',
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


  // ==========================================
  // 3. Kintone API・データ取得層
  // ==========================================
  const appReady = () => typeof kintone !== 'undefined' && kintone.api && kintone.app;
  const waitReady = () => new Promise(res => {
    const t = setInterval(() => { if (appReady()) { clearInterval(t); res(); } }, 50);
    setTimeout(() => { clearInterval(t); res(); }, 10000);
  });

  // ---- GET ラッパ（必要なら差し替え可） ----
  const kGet = (path, params) =>
    kintone.api(kintone.api.url(path, true), 'GET', params);

  // ---- optional（失敗は null に丸める）----
  const opt = (p) => p.catch(() => null);

  // カスタマイズデプロイ用
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

  /**
   * 指定アプリの各種定義をまとめて取得（生レスポンスのみを返す）
   * @param {number|string} appId
   * @param {(path:string, params:object)=>Promise<any>} [getImpl=kGet] 差し替え用GET関数
   */
  async function prefetchAppData(appId, getImpl = kGet) {
    // この関数内だけで使う、小さなヘルパ
    const api = (path, extra = {}) => getImpl(path, { app: appId, ...extra });

    const [
      fields, layout, views, reports, status, generalNotify, perRecordNotify, reminderNotify,
      customize, appAcl, recordAcl, fieldAcl, actions, plugins,
    ] = await Promise.all([
      kintone.app.getFormFields(),
      kintone.app.getFormLayout(),
      opt(api('/k/v1/app/views')),
      opt(api('/k/v1/app/reports')),
      opt(api('/k/v1/app/status')),
      opt(api('/k/v1/app/notifications/general')),
      opt(api('/k/v1/app/notifications/perRecord')),
      opt(api('/k/v1/app/notifications/reminder')),
      opt(api('/k/v1/app/customize')),
      opt(api('/k/v1/app/acl')),
      opt(api('/k/v1/record/acl')),
      opt(api('/k/v1/field/acl')),
      opt(api('/k/v1/app/actions')),
      opt(api('/k/v1/plugins')),
    ]);

    // 生データを読み取り専用で返す（派生計算は別レイヤで）
    return Object.freeze({
      appId,
      fields,     // /k/v1/app/form/fields
      layout,     // /k/v1/app/form/layout
      views,      // /k/v1/app/views               （null可）
      reports,    // /k/v1/app/reports             （null可）
      status,     // /k/v1/app/status              （null可）
      generalNotify,    // /k/v1/app/notifications/general
      perRecordNotify,  // /k/v1/app/notifications/perRecord
      reminderNotify,   // /k/v1/app/notifications/reminder
      customize,  // /k/v1/app/customize           （null可）
      appAcl,   // /k/v1/app/acl
      recordAcl,    // /k/v1/record/acl
      fieldAcl,   // /k/v1/field/acl
      actions,    // /k/v1/app/actions             （null可）
      plugins,     // /k/v1/plugins  
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

    const allFields = fieldsResp ? flattenFields(fieldsResp) : [];

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


  // ==========================================
  // 4. UIルート構築
  // ==========================================
  const mountRoot = () => {
    // 1. ライトモード/ダークモードの判定
    const C = getThemeColors();
    const isDarkMode = C.isDark;

    const githubURL = 'https://github.com/youtotto/kintone-app-toolkit';
    const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(githubURL)}&sz=64`;

    const wrap = document.createElement('div');
    wrap.id = 'kt-toolkit';
    wrap.style.cssText = `
      position:fixed; right:16px; z-index:9998;
      background:${C.bg}; color:${C.text}; border-radius:12px;
      box-shadow:0 8px 30px rgba(0,0,0,${isDarkMode ? '.35' : '.15'});
      font:12px/1.5 ui-sans-serif,system-ui; width:min(1280px, 95vw); max-height:85vh; overflow:auto;
      border:1px solid ${C.border};
    `;
    wrap.innerHTML = `
      <style>
        #kt-toolkit {
          bottom: 16px;
          transition: bottom .18s ease;
        }

        #kt-toolkit.is-mini {
          bottom: 32px;
        }

        #kt-toolkit .bar{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid ${C.border};}
        #kt-toolkit .tabs{display:flex;gap:6px;flex-wrap:wrap}
        #kt-toolkit .tab{padding:6px 10px;border:1px solid ${C.border};background:${C.bgSub};color:${C.text};border-radius:8px;cursor:pointer}
        #kt-toolkit .tab.active{background:#2563eb;border-color:#2563eb;color:#fff;} /* Activeは色固定 */
        #kt-toolkit .btn{padding:6px 10px;border:1px solid ${C.border};background:${C.bgSub};color:${C.text};border-radius:8px;cursor:pointer}
        #kt-toolkit .body{padding:12px}
        /* 各タブ内 view の高さをそろえる */
        #kt-toolkit .body > div[id^="view-"]{
          min-height: 75vh;  /* max-height -10vh くらいに調整 */
        }
        #kt-toolkit.is-mini{
          width:auto !important; max-width:calc(100vw - 32px) !important;
          height:auto !important; max-height:none !important; overflow:visible !important;
        }
        #kt-toolkit.is-mini .body{ display:none !important; }
        #kt-toolkit.is-mini .tabs{ display:none !important; }

        /* Version 表示（控えめ） */
        #kt-toolkit .version-info{
          display:flex;
          align-items:center;
          gap:4px;
          font-size:11px;
          color:${C.textSub};
          opacity:0.75;
          cursor:default;        /* 単なる情報ラベル */
          user-select:none;
        }
        #kt-toolkit .version-info:hover{
          opacity:1;
        }
        #kt-toolkit .version-info img{
          width:14px;
          height:14px;
          border-radius:3px;
          margin-top:1px;
        }

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

        .fi-detail-btn {
          background: none;
          border: none;
          padding: 0;
          cursor: pointer;
          font-size: 12px;
          font-weight: 500;
        }

        .fi-detail-btn:hover {
          text-decoration: underline;
        }

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

        /* バッジ */
        #kt-toolkit .logic-badge {
          display:inline-block;
          padding:3px 10px;
          border-radius:999px;
          border:1px solid ${C.border2};
          background:${C.bgSub2};
          font-size:11px;
          font-weight:600;
          letter-spacing:0.5px;
        }

      </style>
      <div class="bar">
        <div class="tabs">
          <button id="tab-health" class="tab active">Health</button>
          <button id="tab-fields" class="tab">Fields</button>
          <button id="tab-views"  class="tab">Views</button>
          <button id="tab-graphs" class="tab">Graphs</button>
          <button id="tab-relations" class="tab">Relations</button>
          <button id="tab-notice" class="tab">Notices</button>
          <button id="tab-acl" class="tab">Access Control</button>
          <button id="tab-templates" class="tab">Templates</button>
          <button id="tab-customize" class="tab">Customize</button>
          <button id="tab-field-scanner" class="tab">Field Scanner</button>
          <button id="tab-plugins" class="tab">Plugins</button>
          <button id="tab-links" class="tab">Links</button>
        </div>
        <div class="actions" style="display:flex;gap:6px;align-items:center;">
          <button id="kt-mini" class="btn" title="最小化">–</button>
          <div id="kt-version" class="version-info" title="Toolkit version">
            <img src="${favicon}" alt="Toolkit icon" />
            <span>Ver ${SCRIPT_VERSION}</span>
          </div>
        </div>
      </div>
      <div class="body">
        <div id="view-health"></div>
        <div id="view-fields" style="display:none"></div>
        <div id="view-views"  style="display:none"></div>
        <div id="view-graphs" style="display:none"></div>
        <div id="view-relations" style="display:none"></div>
        <div id="view-notice" style="display:none"></div>
        <div id="view-acl" style="display:none"></div>
        <div id="view-templates" style="display:none"></div>
        <div id="view-customize" style="display:none"></div>
        <div id="view-field-scanner" style="display:none"></div>
        <div id="view-plugins" style="display:none;"></div>
        <div id="view-links" style="display:none"></div>
      </div>
    `;

    document.body.appendChild(wrap);

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
    btnMini && btnMini.addEventListener('click', toggleMini, { passive: true });
    const btnVer = wrap.querySelector('#kt-version');
    btnVer && btnVer.addEventListener('click', () => window.open(githubURL, '_blank', 'noopener'), { passive: true });

    const TABS = ['health', 'fields', 'views', 'graphs', 'relations', 'notice', 'acl', 'templates', 'customize', 'field-scanner', 'plugins', 'links'];

    const switchTab = (idShow) => {
      TABS.forEach(tabId => {
        // タブボタンのActive切り替え
        const btn = wrap.querySelector(`#tab-${tabId}`);
        if (btn) btn.classList.toggle('active', tabId === idShow);

        // Viewの表示切り替え
        const view = wrap.querySelector(`#view-${tabId}`);
        if (view) view.style.display = tabId === idShow ? 'block' : 'none';
      });
    };

    // イベントリスナーの一括登録
    TABS.forEach(tabId => {
      const btn = wrap.querySelector(`#tab-${tabId}`);
      if (btn) {
        btn.addEventListener('click', () => switchTab(tabId), { passive: true });
      }
    });
    return wrap;

  };


  // ==========================================
  // 5. 各機能（タブ）のモジュール
  // ==========================================
  // ----------------------------
  // [Feature] Health
  // ----------------------------
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

  // kintone プロセス管理 → Mermaid flowchart を生成
  const buildProcessMermaid = (status) => {
    if (!status || !status.states) return '';

    const states = status.states || {};
    const actions = status.actions || [];

    // index順にソート
    const entries = Object.entries(states).sort(
      (a, b) => (a[1].index ?? 0) - (b[1].index ?? 0)
    );

    if (!entries.length) return '';

    const idMap = {};
    entries.forEach(([key, st], idx) => {
      idMap[key] = `S${idx}`; // Mermaid用ノードID
    });

    const esc = (s) => String(s || '').replace(/"/g, '\\"');

    const lines = ['flowchart LR'];

    // ノード定義
    for (const [key, st] of entries) {
      const id = idMap[key];
      const label = esc(st.name || key);
      lines.push(`  ${id}["${label}"]`);
    }

    // アクション（遷移）定義
    for (const a of actions) {
      const fromId = idMap[a.from];
      const toId = idMap[a.to];
      if (!fromId || !toId) continue;
      const name = esc(a.name || '');
      if (name) {
        lines.push(`  ${fromId} -->|${name}| ${toId}`);
      } else {
        lines.push(`  ${fromId} --> ${toId}`);
      }
    }

    return lines.join('\n');
  };

  // renderHealth
  const renderHealth = async (
    root,
    {
      appId, fields, status, views, reports, customize,
      generalNotify, perRecordNotify, reminderNotify,
      appAcl, recordAcl, fieldAcl,
      actions, plugins
    }
  ) => {
    let TH = loadTH();

    // ガード
    const el = root.querySelector('#view-health');
    if (!el) return;

    // --- メトリクス計算（整形はこの中だけ） ---
    const props = Object.values(fields || {});
    const flatten = (arr) =>
      arr.flatMap((p) => (p.type === 'SUBTABLE' ? [p, ...Object.values(p.fields)] : [p]));
    const list = flatten(props);

    const safeLen = (v, path) => {
      try {
        const x = path.split('.').reduce((a, k) => (a ? a[k] : undefined), v);
        return Array.isArray(x) ? x.length : (x ? Object.keys(x).length : 0);
      } catch { return 0; }
    };

    // 通知系
    const cntGeneralNotify = generalNotify ? safeLen(generalNotify, 'notifications') : null;
    const cntPerRecordNotify = perRecordNotify ? safeLen(perRecordNotify, 'notifications') : null;
    const cntReminderNotify = reminderNotify ? safeLen(reminderNotify, 'notifications') : null;

    const notificationsTotal =
      (cntGeneralNotify == null && cntPerRecordNotify == null && cntReminderNotify == null)
        ? null
        : (cntGeneralNotify || 0) + (cntPerRecordNotify || 0) + (cntReminderNotify || 0);

    // ACL系
    const cntAppAcl = appAcl ? safeLen(appAcl, 'rights') : null;
    const cntRecordAcl = recordAcl ? safeLen(recordAcl, 'rights') : null;
    const cntFieldAcl = fieldAcl ? safeLen(fieldAcl, 'rights') : null;

    const aclTotal =
      (cntAppAcl == null && cntRecordAcl == null && cntFieldAcl == null)
        ? null
        : (cntAppAcl || 0) + (cntRecordAcl || 0) + (cntFieldAcl || 0);

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
      notifications: notificationsTotal,
      jsFiles: customize ? ((customize.desktop && customize.desktop.js) || []).length : null,
      cssFiles: customize ? ((customize.desktop && customize.desktop.css) || []).length : null,
      roles: aclTotal,
    };

    const score = {
      totalFields: judge(metrics.totalFields, TH.totalFields),
      states: judge(metrics.states, TH.states),
      actions: judge(metrics.actions, TH.actions)
    };

    // ★ プロセス管理のステータスフィールドコードを特定
    let statusFieldCode = null;
    if (status && status.enable) {
      // kintoneアプリ設定から取れる場合（フィールドコードが入っている想定）
      statusFieldCode = status.statusField || status.field;
    }
    if (!statusFieldCode) {
      // 念のためフィールド一覧から type=STATUS を探すフォールバック
      const statusFieldEntry = Object.entries(fields || {}).find(
        ([, f]) => f.type === 'STATUS'
      );
      if (statusFieldEntry) {
        statusFieldCode = statusFieldEntry[0];
      }
    }

    let processMermaidCode = '';

    // --- 描画 ---
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;gap:12px;">

        <!-- ヘッダー -->
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div style="font-weight:700;font-size:14px;">
            App Health <span style="opacity:.7;font-weight:400">(Read-only)</span>
          </div>
          <div style="display:flex;gap:6px">
            <button id="kt-copy" class="btn">Copy</button>
            <button id="kt-th" class="btn">基準 / Thresholds</button>
          </div>
        </div>

        <!-- メインビュー -->
        <div id="kt-summary"
            style="flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;">

          <!-- 上段：3カード -->
          <div style="
            display:grid;
            grid-template-columns:repeat(3,minmax(0,1fr));
            gap:10px;
          ">
            <!-- Fields Card -->
            <div style="
              border:1px solid #e5e7eb;
              border-radius:8px;
              padding:8px 10px;
              display:flex;
              flex-direction:column;
              gap:4px;
            ">
              <div style="font-size:12px;opacity:.8;">フォーム構成 / Fields</div>
              <div style="font-size:18px;font-weight:700;">
                ${metrics.totalFields}
                <span style="font-size:11px;font-weight:400;opacity:.7;">
                  （Group: ${metrics.groups}, SubTable: ${metrics.subtables}）
                </span>
              </div>
              <div style="font-size:11px;opacity:.75;">
                サブテーブル最大列数：${metrics.subtableColsMax}
              </div>
            </div>

            <!-- Process Card -->
            <div style="
              border:1px solid #e5e7eb;
              border-radius:8px;
              padding:8px 10px;
              display:flex;
              flex-direction:column;
              gap:4px;
            ">
              <div style="font-size:12px;opacity:.8;">プロセス管理 / Process</div>
              <div style="font-size:18px;font-weight:700;">
                ${metrics.states}
                <span style="font-size:11px;font-weight:400;opacity:.7;">States</span>
                <span style="margin:0 4px;">/</span>
                ${metrics.actions}
                <span style="font-size:11px;font-weight:400;opacity:.7;">Actions</span>
              </div>
              <div style="font-size:11px;opacity:.75;">
                ステータス・アクションの複雑さの目安です。
              </div>
            </div>

            <!-- Logic & ACL Card -->
            <div style="
              border:1px solid #e5e7eb;
              border-radius:8px;
              padding:8px 10px;
              display:flex;
              flex-direction:column;
              gap:4px;
            ">
              <div style="font-size:12px;opacity:.8;">ロジック / アクセス制御</div>

              <!-- メイン指標：JS / ACL -->
              <div style="font-size:18px;font-weight:700;">
                ${metrics.jsFiles ?? '-'}
                <span style="font-size:11px;font-weight:400;opacity:.7;">JS</span>
                <span style="margin:0 6px;">/</span>
                ${metrics.roles ?? '-'}
                <span style="font-size:11px;font-weight:400;opacity:.7;">ACL</span>
              </div>
              <div style="font-size:11px;opacity:.75;">
                アプリの制御ロジックの複雑さの目安です。<br>
              </div>
            </div>
          </div>

          <!-- 中段：Health サマリー + しきい値ガイド -->
          <div style="
            border:1px solid #e5e7eb;
            border-radius:8px;
            padding:8px 10px;
            display:flex;
            flex-direction:column;
            gap:8px;
          ">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div style="font-size:12px;font-weight:600;">
                Health summary
              </div>
              <div style="font-size:11px;opacity:.7;">
                現在値としきい値（Y / R）の関係をざっくり確認できます
              </div>
            </div>

            <!-- 行ごとのサマリー -->
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
              <thead>
                <tr style="opacity:.7;">
                  <th style="text-align:left;padding:4px 6px;">指標</th>
                  <th style="text-align:right;padding:4px 6px;">現在値</th>
                  <th style="text-align:right;padding:4px 6px;">Y（注意）</th>
                  <th style="text-align:right;padding:4px 6px;">R（危険）</th>
                  <th style="text-align:left;padding:4px 6px;">判定</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style="padding:4px 6px;">${TH.totalFields.label}</td>
                  <td style="padding:4px 6px;text-align:right;">
                    ${metrics.totalFields}
                  </td>
                  <td style="padding:4px 6px;text-align:right;">
                    ${TH.totalFields.Y}
                  </td>
                  <td style="padding:4px 6px;text-align:right;">
                    ${TH.totalFields.R}
                  </td>
                  <td style="padding:4px 6px;">
                    <span style="
                      padding:2px 8px;
                      border-radius:999px;
                      border:1px solid #e5e7eb;
                      display:inline-flex;
                      align-items:center;
                      gap:4px;
                      font-size:11px;
                    ">
                      <span>${score.totalFields.badge}</span>
                      <span>${score.totalFields.level}</span>
                    </span>
                  </td>
                </tr>

                <tr>
                  <td style="padding:4px 6px;">${TH.states.label}</td>
                  <td style="padding:4px 6px;text-align:right;">
                    ${metrics.states}
                  </td>
                  <td style="padding:4px 6px;text-align:right;">
                    ${TH.states.Y}
                  </td>
                  <td style="padding:4px 6px;text-align:right;">
                    ${TH.states.R}
                  </td>
                  <td style="padding:4px 6px;">
                    <span style="
                      padding:2px 8px;
                      border-radius:999px;
                      border:1px solid #e5e7eb;
                      display:inline-flex;
                      align-items:center;
                      gap:4px;
                      font-size:11px;
                    ">
                      <span>${score.states.badge}</span>
                      <span>${score.states.level}</span>
                    </span>
                  </td>
                </tr>

                <tr>
                  <td style="padding:4px 6px;">${TH.actions.label}</td>
                  <td style="padding:4px 6px;text-align:right;">
                    ${metrics.actions}
                  </td>
                  <td style="padding:4px 6px;text-align:right;">
                    ${TH.actions.Y}
                  </td>
                  <td style="padding:4px 6px;text-align:right;">
                    ${TH.actions.R}
                  </td>
                  <td style="padding:4px 6px;">
                    <span style="
                      padding:2px 8px;
                      border-radius:999px;
                      border:1px solid #e5e7eb;
                      display:inline-flex;
                      align-items:center;
                      gap:4px;
                      font-size:11px;
                    ">
                      <span>${score.actions.badge}</span>
                      <span>${score.actions.level}</span>
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>

            <!-- しきい値の説明 -->
            <div style="margin-top:4px;font-size:11px;opacity:.8;line-height:1.5;">
              <div>
                上部の <b>「基準 / Thresholds」</b> ボタンから、各指標の Y / R を編集できます。<br>
              </div>
            </div>
          </div>


          <!-- 下段：Process Flow 図 -->
          <div style="
            border:1px solid #e5e7eb;
            border-radius:8px;
            padding:10px;
            min-height:200px; /* 横並びにするため少し高さを確保 */
            display: flex;
            flex-direction: column;
            gap: 8px;
          ">
            <div style="font-size:12px;font-weight:600;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #f3f4f6;padding-bottom:4px;">
              <span>Process Analysis (Flow & Distribution)</span>
              <button id="kt-copy-mermaid" class="btn" style="padding:2px 8px;font-size:11px;">Copy Mermaid</button>
            </div>

            <div style="display: flex; gap: 16px; flex: 1; min-height: 0;">
              
              <div style="flex: 2; overflow: auto; border-right: 1px dashed #eee; padding-right: 8px;">
                <div id="kt-process-diagram">
                  </div>
              </div>

              <div style="flex: 1; overflow-y: auto;">
                <div id="kt-process-heatmap">
                  </div>
              </div>

            </div>
          </div>
        </div>

        <!-- Thresholds パネル -->
        <div id="kt-th-panel"
            style="
              display:none;
              margin-top:2px;
              padding:8px 10px;
              border:1px solid #e5e7eb;
              border-radius:8px;
              max-height:calc(75vh - 60px);
              overflow:auto;
            ">
          <div style="opacity:.85;margin-bottom:6px;font-size:11px;line-height:1.5;">
            しきい値（Thresholds）：Y = 注意（Caution） / R = 危険（Danger）<br>
            保存すると LocalStorage に記録されます。 / Saved to LocalStorage.
          </div>
          <table style="width:100%;max-width:560px;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr>
                <th style="text-align:left;padding:4px 6px;">指標 / Metric</th>
                <th style="text-align:right;padding:4px 6px;">Y（注意 / Caution）</th>
                <th style="text-align:right;padding:4px 6px;">R（危険 / Danger）</th>
              </tr>
            </thead>
            <tbody id="kt-th-rows"></tbody>
          </table>
          <div style="margin-top:8px;display:flex;gap:8px;justify-content:flex-end;">
            <button id="kt-th-reset" class="btn">初期化 / Reset</button>
            <button id="kt-th-save"  class="btn"
                    style="background:#2563eb;border-color:#2563eb;color:#fff;">
              保存 / Save
            </button>
          </div>
        </div>

      </div>
    `;

    // --- renderHealth 関数内の Mermaid 描画部分 ---
    const drawMermaid = () => {
      const target = el.querySelector(`#kt-process-mermaid-${appId}`);
      // 表示されている（display:noneでない）かつ、まだ描画されていない（data-processed属性がない）場合のみ実行
      if (target && target.offsetParent !== null && window.mermaid) {
        window.mermaid.run({ nodes: [target] });
      }
    };

    // 初回実行（もし表示状態なら描画）
    drawMermaid();

    // しきい値テーブル
    const rowsEl = el.querySelector('#kt-th-rows');
    const renderTHRows = () => {
      rowsEl.innerHTML = Object.entries(TH)
        .map(
          ([k, v]) => `
          <tr data-key="${k}">
            <td style="padding:4px 6px;">${v.label}</td>
            <td style="text-align:right;padding:4px 6px;">
              <input type="number" min="0" value="${v.Y}"
                     style="width:80px;text-align:right;">
            </td>
            <td style="text-align:right;padding:4px 6px;">
              <input type="number" min="0" value="${v.R}"
                     style="width:80px;text-align:right;">
            </td>
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

    // Process Flow 図描画
    const processHost = el.querySelector('#kt-process-diagram');
    if (processHost) {
      const code = buildProcessMermaid(status);
      processMermaidCode = code || '';
      if (code) {
        const id = `kt-process-mermaid-${appId}`;

        processHost.innerHTML = '';

        const div = document.createElement('div');
        div.className = 'mermaid';
        div.id = id;
        div.style.fontSize = '11px';
        div.style.lineHeight = '1.4';
        div.textContent = code;   // ★ Mermaidコードは textContent で

        processHost.appendChild(div);

        // --- 修正後の描画ロジック ---
        if (window.mermaid && typeof window.mermaid.run === 'function') {
          try {
            // 1. 要素がブラウザ上で高さ/幅を持っているかチェック
            // offsetParent が null の場合は非表示（display:none等）の状態
            if (div.offsetParent !== null) {
              window.mermaid.run({ nodes: [div] });
            } else {
              // 2. 非表示の場合は、IntersectionObserver で表示された瞬間に実行する
              const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                  if (entry.isIntersecting) {
                    window.mermaid.run({ nodes: [div] });
                    observer.disconnect(); // 一度描画したら監視終了
                  }
                });
              });
              observer.observe(div);
            }
          } catch (e) {
            console.error("Mermaid render error:", e);
          }
        } else {
          const msg = document.createElement('div');
          msg.style.fontSize = '11px';
          msg.style.opacity = '0.7';
          msg.style.marginTop = '4px';
          msg.textContent = '※ Mermaid が読み込まれていないため、コード表示のみです。';
          processHost.appendChild(msg);
        }
      } else {
        processHost.innerHTML = `
          <div style="font-size:11px;opacity:.7;">
            プロセス管理が無効、またはステータス情報が取得できませんでした。
          </div>
        `;
      }
    }

    // ★★★ 直近500件のステータス滞留ヒートマップ ★★★
    (async () => {
      const heatHost = el.querySelector('#kt-process-heatmap');
      if (!heatHost) return;
      if (!statusFieldCode) {
        heatHost.innerHTML = `
          <div style="opacity:.7;">ステータスフィールドが特定できないため、滞留状況は表示できません。</div>
        `;
        return;
      }

      // ローディング表示
      heatHost.innerHTML = `<div style="opacity:.7;">直近500件のステータス分布を集計中...</div>`;

      try {
        const resp = await kintone.api(
          kintone.api.url('/k/v1/records', true),
          'GET',
          {
            app: appId,
            fields: [statusFieldCode],
            query: 'order by $id desc limit 500'
          }
        );

        const records = resp.records || [];
        if (!records.length) {
          heatHost.innerHTML = `<div style="opacity:.7;">レコードが存在しません。</div>`;
          return;
        }

        // ステータス名 → 件数
        const counts = {};
        for (const r of records) {
          const v = (r[statusFieldCode] && r[statusFieldCode].value) || '';
          if (!v) continue;
          counts[v] = (counts[v] || 0) + 1;
        }

        const total = records.length;
        const maxCount = Math.max(...Object.values(counts), 0);

        // configのstates順に並べる（設定されているステータスだけ出す）
        const stateEntries = status && status.states
          ? Object.values(status.states).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
          : [];

        if (!stateEntries.length) {
          heatHost.innerHTML = `<div style="opacity:.7;">ステータス定義が取得できませんでした。</div>`;
          return;
        }

        const rowsHtml = stateEntries.map(st => {
          const name = st.name || '';
          const c = counts[name] || 0;
          const ratio = total ? (c / total) : 0;
          const percent = (ratio * 100).toFixed(1);
          const intensity = maxCount ? (c / maxCount) : 0; // 0～1

          // 背景を割合に応じてグラデーション（簡易ヒートマップ）
          const bg = intensity
            ? `linear-gradient(to right, rgba(248,113,113,0.6) ${percent}%, transparent ${percent}%)`
            : 'none';

          return `
            <tr>
              <td style="padding:2px 4px;white-space:nowrap;">${name || '(未設定)'}</td>
              <td style="padding:2px 4px;text-align:right;">${c}</td>
              <td style="padding:2px 4px;text-align:right;">${percent}%</td>
              <td style="padding:2px 0 2px 4px;">
                <div style="
                  height:10px;
                  border-radius:999px;
                  background:${bg};
                  border:1px solid #fecaca;
                  min-width:40px;
                "></div>
              </td>
            </tr>
          `;
        }).join('');

        heatHost.innerHTML = `
          <div style="margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;">
            <span>直近500件のステータス分布</span>
            <span style="opacity:.6;">総件数：${total}</span>
          </div>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="font-size:10px;opacity:.7;">
                <th style="text-align:left;padding:2px 4px;">Status</th>
                <th style="text-align:right;padding:2px 4px;">件数</th>
                <th style="text-align:right;padding:2px 4px;">割合</th>
                <th style="text-align:left;padding:2px 4px;">滞留ヒート</th>
              </tr>
            </thead>
            <tbody style="font-size:11px;">
              ${rowsHtml}
            </tbody>
          </table>
        `;
      } catch (e) {
        heatHost.innerHTML = `<div style="opacity:.7;">ステータス分布の取得に失敗しました。</div>`;
        // console.error(e);
      }
    })();

    const copyText = async (text) => {
      if (!text) return false;

      // 標準 Clipboard API
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch (e) {
          // fall through
        }
      }

      // フォールバック（古い環境/制限時）
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.left = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return !!ok;
      } catch (e) {
        return false;
      }
    };


    // イベント
    el.querySelector('#kt-copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(summaryText);
      const b = el.querySelector('#kt-copy'); const old = b.textContent;
      b.textContent = 'Copied!'; setTimeout(() => (b.textContent = old), 1200);
    });

    const copyMermaidBtn = el.querySelector('#kt-copy-mermaid');
    if (copyMermaidBtn) {
      copyMermaidBtn.addEventListener('click', async () => {
        const ok = await copyText(processMermaidCode);

        const old = copyMermaidBtn.textContent;
        copyMermaidBtn.textContent = ok ? 'Copied!' : 'Copy failed';
        setTimeout(() => (copyMermaidBtn.textContent = old), 1200);
      });
    }

    el.querySelector('#kt-th').addEventListener('click', () => {
      const p = el.querySelector('#kt-th-panel');
      const s = el.querySelector('#kt-summary');
      const showPanel = p.style.display === 'none' || p.style.display === '';

      if (showPanel) {
        p.style.display = 'block';
        s.style.display = 'none';
      } else {
        p.style.display = 'none';
        s.style.display = 'flex';
        // パネルを切り替えた瞬間に再描画をかける
        setTimeout(drawMermaid, 0);
      }
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


  // ----------------------------
  // [Feature] Fields
  // ----------------------------
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

    // 例：['group1', 'group2'] または [{ code:'group1', type:'GROUP' }, { code:'LOGINUSERGROUPS()', type:'FUNCTION' }]
    if (t === 'GROUP_SELECT') {
      const arr = Array.isArray(dv) ? dv : [];
      return arr.map(e => {
        if (e && typeof e === 'object') {
          const kind = e.type;
          const code = e.code;

          if (kind === 'FUNCTION') {
            // よく使いそうなものだけラベル化（未知はそのまま表示）
            if (code === 'LOGINUSERGROUPS()') return 'ログインユーザーの所属グループ';
            return code || '';
          }
          if (kind === 'GROUP') return `グループ:${code}`;
          // 念のため（万一混ざってても壊れないように）
          if (kind === 'USER') return `ユーザー:${code}`;
          if (kind === 'ORGANIZATION') return `組織:${code}`;
          return String(code ?? '');
        }

        // 文字列配列のとき
        return `グループ:${String(e ?? '')}`;
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

  // --- highlight 設定（LocalStorage）
  const LS_HL_KEY = 'ktFieldsHighlightLabelCodeDiff.v1';
  const loadHL = () => {
    const v = localStorage.getItem(LS_HL_KEY);
    return v === null ? true : v === 'true';
  };
  const saveHL = (b) => localStorage.setItem(LS_HL_KEY, String(!!b));

  // --- elementId（LABEL/罫線等）表示トグル（LocalStorage）
  const LS_ELEM_KEY = 'ktFieldsShowElementIdRows.v1';
  const loadElem = () => {
    const v = localStorage.getItem(LS_ELEM_KEY);
    return v === 'true'; // デフォルトOFF
  };
  const saveElem = (b) => localStorage.setItem(LS_ELEM_KEY, String(!!b));

  // ==== DROP-IN REPLACEMENT (layout order only; supports top-level SUBTABLE) ====
  const renderFields = async (root, { appId, fields, layout, usageData }) => {

    injectFieldBadgeStyle();

    const normalizeType = (f) => (f && f.lookup ? 'LOOKUP' : (f?.type ?? ''));

    // 生レスポンスの安全な取り出し
    const props = fields || {};
    const layoutNodes = layout || [];

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

    const elementRows = []; // elementIdを持つ LABEL/罫線 を溜める

    const stripHtml = (html) => {
      // 1) HTMLを文字列として扱う（DOMに入れない）
      const s = String(html || '');

      // 2) タグ除去（簡易）
      // <br> は改行に寄せてもいい
      return s
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const pushElement = (node, curGroup) => {
      const eid = node?.elementId;
      if (!eid) return;

      const t = node?.type || '';
      const rawLabel = node?.label || '';

      const pseudoCode = `@要素ID: ${eid}`;
      groupPathByCode[pseudoCode] = curGroup ? `Group: ${curGroup}` : '';
      layoutOrderCodes.push(pseudoCode);

      // ★表示用：HTMLタグは落として文字だけに
      const displayLabel = (t === 'LABEL')
        ? stripHtml(rawLabel) || '(LABEL)'
        : (rawLabel ? stripHtml(rawLabel) : `[${t}]`);

      elementRows.push({
        label: displayLabel,          // ← 以後は “テキスト” として扱える
        code: pseudoCode,
        required: false,
        defaultValue: '',
        type: t,
        elementId: eid,
        _raw: node,
        _isElement: true
      });
    };

    const walkLayout = (nodes, curGroup = null) => {
      for (const n of nodes || []) {
        if (n.type === 'ROW') {
          for (const f of n.fields || []) {

            // 1) SUBTABLE
            if (f.type === 'SUBTABLE') {
              const stLabel = f.label || f.code || '(Subtable)';
              for (const sf of f.fields || []) pushChild(sf, curGroup, stLabel);
              continue;
            }

            // 2) 通常フィールド（codeあり）
            if (f.code) {
              groupPathByCode[f.code] = curGroup ? `Group: ${curGroup}` : '';
              layoutOrderCodes.push(f.code);
              continue;
            }

            // 3) codeなしだけど elementId があるやつ（LABEL/罫線など）
            if (f.elementId) {
              pushElement(f, curGroup);
              continue;
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
          unique: !!f.unique,
          defaultValue: formatDefault(f),
          type: normalizeType(f),
          _raw: f
        });
      }
    };
    Object.values(props).forEach(collect);

    // 全フィールドコード（usage抽出のため）
    const allFieldCodes = list.map(x => x.code).filter(Boolean);

    // ここは “AppInsightから渡される usageData” が必要。
    // いま Toolkit 側で usageData を持ってないなら、まずは引数に追加するのが一歩目です。
    // 例：renderFields(root, { appId, fields, layout, usageData })
    const usagePlacesMap = usageData ? extractUsedFields(usageData, allFieldCodes) : {};

    // --- 表示用行へ。グループ/サブテーブル表示は “layoutだけ” を正とする
    const showElements = loadElem();

    let rows = list
      .map(r => ({
        ...r,
        groupPath: groupPathByCode[r.code] || '',
        usagePlaces: usagePlacesMap?.[r.code] || [],
        detail: null
      }))
      .filter(r => !SYSTEM_TYPES.has(r.type));

    // ★ elementId行を混ぜる（初期はOFF）
    if (showElements && elementRows.length) {
      rows = rows.concat(
        elementRows.map(er => ({
          ...er,
          groupPath: groupPathByCode[er.code] || '',
          usagePlaces: [], // element系は usage なし
          detail: { elementId: er.elementId }, // 詳細に入れても良い
        }))
      );
    }

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
    const C = getThemeColors();

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
        <div style="font-weight:700">Field Inventory</div>

        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <input id="fi-search" type="search"
            placeholder="検索（フィールド名 / コード）"
            style="
              width: 260px;
              padding: 6px 10px;
              margin-right: 24px;
              border-radius: 10px;
              border: 1px solid ${C.border};
              background: ${C.bgInput};
              color: ${C.text};
              outline: none;
              transition: border .15s ease;
            "
          />

          <label style="display:flex;align-items:center;gap:6px;margin-right:8px;user-select:none">
            <input id="fi-hl-toggle" type="checkbox" ${highlightOn ? 'checked' : ''}>
            <span style="opacity:.9">名称≠コードをハイライト</span>
          </label>

          <label style="display:flex;align-items:center;gap:6px;margin-right:8px;user-select:none">
            <input id="fi-elem-toggle" type="checkbox" ${showElements ? 'checked' : ''}>
            <span style="opacity:.9">要素ID を表示</span>
          </label>

          <button id="fi-copy-md" class="btn">Copy Markdown</button>
          <button id="fi-dl-md"   class="btn">DL MD</button>
          <button id="fi-dl-csv"  class="btn">DL CSV</button>
          <button id="fi-dl-json" class="btn">DL JSON</button>
        </div>
      </div>

      <div id="kt-fields">
        <table>
          <thead><tr>
            <th>フィールド名</th><th>フィールドコード</th><th>フィールド形式</th>
            <th>必須</th><th>重複禁止</th><th>初期値</th>
            <th>グループ / テーブル</th><th>詳細</th>
          </tr></thead>
          <tbody id="fi-tbody"></tbody>
        </table>
      </div>
    `;

    const tbody = el.querySelector('#fi-tbody');

    const searchInput = el.querySelector('#fi-search');
    searchInput.addEventListener('focus', () => {
      searchInput.style.border = `1px solid ${C.border2}`;
    });
    searchInput.addEventListener('blur', () => {
      searchInput.style.border = `1px solid ${C.border}`;
    });

    const applyRowClass = (tr, r, hlOn) => {
      const different = (r.label || '').trim() !== (r.code || '').trim();
      tr.classList.toggle('hl-diff', hlOn && different);
      tr.dataset.diff = different ? '1' : '0';
    };

    // ★ tbody描画（検索・再描画用）
    const renderRows = (rowsToRender) => {
      tbody.innerHTML = '';

      rowsToRender.forEach(r => {
        const tr = document.createElement('tr');

        tr.innerHTML = `
          <td>${escapeHtml(r.label)}</td>
          <td style="opacity:.9">${escapeHtml(r.code)}</td>
          <td>${escapeHtml(r.type)}</td>
          <td>${r.required ? '✓' : ''}</td>
          <td>${r.unique ? '✓' : ''}</td>
          <td style="opacity:.9">${escapeHtml(r.defaultValue)}</td>
          <td style="opacity:.9">${escapeHtml(r.groupPath)}</td>
          <td class="fi-detail-cell"></td>
        `;

        applyRowClass(tr, r, loadHL()); //
        // --- 詳細
        const places = Array.isArray(r.usagePlaces) ? r.usagePlaces : [];
        const detailObj = buildDetail(r._raw);
        const detailHtml = buildDetailHtml(detailObj, places);

        const detailCell = tr.querySelector('.fi-detail-cell');

        if (detailHtml) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'fi-detail-btn';
          btn.textContent = '開く';
          detailCell.appendChild(btn);

          const detailTr = document.createElement('tr');
          detailTr.className = 'fi-detail-row';
          detailTr.style.display = 'none';

          const td = document.createElement('td');
          td.colSpan = 8;
          td.innerHTML = detailHtml;
          detailTr.appendChild(td);

          btn.addEventListener('click', () => {
            const opened = detailTr.style.display !== 'none';
            detailTr.style.display = opened ? 'none' : '';
            btn.textContent = opened ? '開く' : '閉じる';
          });

          tbody.appendChild(tr);
          tbody.appendChild(detailTr);
          return;
        }

        // detail無し
        detailCell.textContent = '';
        tbody.appendChild(tr);
      });
    };

    // 初期描画
    renderRows(rows);

    // ★検索
    const elSearch = el.querySelector('#fi-search');

    const norm = (s) => String(s || '').toLowerCase();

    const filterRows = (q) => {
      const qq = norm(q).trim();
      if (!qq) return rows;

      return rows.filter(r => {
        // 検索対象（好きに増減OK）
        const target = [
          r.label,
          r.code,
        ].map(norm).join(' | ');

        return target.includes(qq);
      });
    };

    // デバウンス
    const debounce = (fn, ms = 150) => {
      let t = null;
      return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
      };
    };

    const applySearch = () => {
      const q = elSearch.value || '';
      const filtered = filterRows(q);
      renderRows(filtered);
    };

    const applySearchDebounced = debounce(applySearch, 150);

    elSearch.addEventListener('input', applySearchDebounced, { passive: true });

    el.querySelector('#fi-hl-toggle').addEventListener('change', e => {
      const on = !!e.target.checked;
      saveHL(on);
      el.querySelectorAll('#fi-tbody tr').forEach(tr => {
        const isDiff = tr.dataset.diff === '1';
        tr.classList.toggle('hl-diff', on && isDiff);
      });
    }, { passive: true });

    el.querySelector('#fi-elem-toggle').addEventListener('change', async (e) => {
      const on = !!e.target.checked;
      saveElem(on);
      // 再描画（今の引数をそのまま）
      await renderFields(root, { appId, fields, layout, usageData });
    }, { passive: true });

    // Fields 用の列定義
    const FD_COLUMNS = [
      { header: 'フィールド名', select: r => r.label },
      { header: 'フィールドコード', select: r => r.code },
      { header: 'フィールド形式', select: r => r.type },
      { header: '必須', select: r => r.required ? 'TRUE' : 'FALSE' },
      { header: '重複禁止', select: r => r.unique ? 'TRUE' : 'FALSE' },
      { header: '初期値', select: r => r.defaultValue || '' },
      { header: 'グループ', select: r => r.groupPath || '' },
    ];

    // クリップボード／DL を KTExport に統一
    el.querySelector('#fi-copy-md').addEventListener('click', async () => {
      const ok = await KTExport.copyMD(rows, FD_COLUMNS);
      flashBtnText(el.querySelector('#fi-copy-md'), ok ? 'Copied!' : 'Failed');
    }, { passive: true });

    el.querySelector('#fi-dl-md').addEventListener('click', () => {
      KTExport.downloadMD(`kintone_fields_${appId}.md`, rows, FD_COLUMNS);
    }, { passive: true });

    el.querySelector('#fi-dl-csv').addEventListener('click', async () => {
      KTExport.downloadCSV(`kintone_fields_${appId}.csv`, rows, FD_COLUMNS, { withBom: true });
    }, { passive: true });

    el.querySelector('#fi-dl-json').addEventListener('click', () => {
      const json = JSON.stringify(rows, null, 2);
      KTExport.downloadText(`kintone_fields_${appId}.json`, json, 'application/json;charset=utf-8');
    }, { passive: true });
  };

  // --- フィールド利用箇所の抽出（全フィールドコードを元に拾う）
  // usageData: { views, perRecordNotify, reminderNotify, status, customize, reports, actions }
  function extractUsedFields(usageData, allFieldCodes) {
    const usageMap = {}; // code -> Set(場所)
    const mark = (code, where) => {
      if (!code) return;
      if (!usageMap[code]) usageMap[code] = new Set();
      usageMap[code].add(where);
    };

    const codes = Array.isArray(allFieldCodes) ? allFieldCodes : [];
    const markByCond = (cond, where) => {
      const s = String(cond || '');
      if (!s) return;
      for (const code of codes) {
        // 簡易：含まれてたら使用扱い（厳密にやるなら tokenizer 化）
        if (s.includes(code)) mark(code, where);
      }
    };

    const { views, perRecordNotify, reminderNotify, status, customize, reports, actions } = usageData || {};

    // 一覧ビュー
    Object.values(views?.views || {}).forEach(view => {
      (view.fields || []).forEach(code => mark(code, '一覧ビュー'));
    });

    // レコード通知
    (perRecordNotify?.notifications || []).forEach(n => {
      markByCond(n.filterCond, 'レコード通知');
    });

    // リマインダー
    (reminderNotify?.notifications || []).forEach(n => {
      const timingCode = n?.timing?.code;
      if (timingCode) mark(timingCode, 'リマインダー');
      markByCond(n.filterCond, 'リマインダー');
    });

    // プロセス管理（actions の JSON をざっくり走査）
    (status?.actions || []).forEach(action => {
      markByCond(JSON.stringify(action), 'プロセス管理');
    });

    const jsText = (customize?.desktop?.js || []).map(js => js.url || '').join('\n');
    const codePattern = /record\.(\w+)/g;
    let m;
    while ((m = codePattern.exec(jsText)) !== null) mark(m[1], 'JavaScript');

    // レポート
    Object.values(reports?.reports || {}).forEach(rep => {
      (rep.groups || []).forEach(g => { if (g.code) mark(g.code, 'レポート'); });
      (rep.aggregations || []).forEach(agg => { if (agg.code) mark(agg.code, 'レポート'); });

      markByCond(rep.filterCond, 'レポート');

      (rep.sorts || []).forEach(sort => {
        const by = sort.by;
        if (by && !['TOTAL', 'GROUP1', 'GROUP2'].includes(by)) mark(by, 'レポート');
      });
    });

    // アプリアクション
    Object.values(actions?.actions || {}).forEach(action => {
      (action.mappings || []).forEach(m => {
        if (m.srcType === 'FIELD' && m.srcField) mark(m.srcField, 'アクション（マッピング）');
      });
      markByCond(action.filterCond, 'アクション（条件）');
    });

    // Set -> Array
    const out = {};
    for (const [code, set] of Object.entries(usageMap)) out[code] = Array.from(set);
    return out;
  }

  function getFieldOptionLabels(field) {
    if (!field) return null;
    if (['CHECK_BOX', 'RADIO_BUTTON', 'DROP_DOWN', 'MULTI_SELECT'].includes(field.type)) {
      return Object.values(field.options || {}).map(o => o.label).filter(Boolean);
    }
    return null;
  }

  function getCalcDetail(field) {
    if (!field) return null;

    // CALC
    if (field.type === 'CALC') {
      return { calcExpression: field.expression || '' };
    }

    // 文字列(1行)の式
    if (field.type === 'SINGLE_LINE_TEXT' && ('expression' in field)) {
      if (field.hideExpression) return { calcExpression: '(hidden)' };
      return { calcExpression: field.expression || '' };
    }

    return null;
  }

  function buildDetail(fieldObj) {
    if (!fieldObj) return null;

    const optionLabels = getFieldOptionLabels(fieldObj);
    const calcDetail = getCalcDetail(fieldObj);

    const initialValue = formatDefault(fieldObj); // Toolkit側の formatDefault を使う

    const detail = {
      ...(optionLabels?.length ? { options: optionLabels } : {}),
      ...(initialValue ? { initialValue } : {}),
      ...(calcDetail || {}),
    };

    const hasAny =
      (detail.options && detail.options.length) ||
      detail.initialValue ||
      detail.calcExpression

    return hasAny ? detail : null;
  }

  function buildDetailHtml(detail, usagePlaces) {
    const items = [];

    const add = (k, v) => {
      if (v == null) return;
      const s = String(v).trim();
      if (!s) return;
      items.push(`
      <div class="fi-detail-item">
        <div class="fi-detail-k">${k}: </div>
        <div class="fi-detail-v">${escapeHtml(s)}</div>
      </div>
    `);
    };

    // ★使用箇所（バッジ）
    const places = Array.isArray(usagePlaces) ? usagePlaces : [];
    if (places.length) {
      const badges = places.map(p => `<span class="fi-badge">${escapeHtml(p)}</span>`).join('');
      items.push(`
      <div class="fi-detail-item">
        <div class="fi-detail-k">使用箇所: </div>
        <div class="fi-detail-v">${badges}</div>
      </div>
    `);
    }

    if (detail?.options?.length) {
      const badges = detail.options.map(o => `<span class="fi-badge">${escapeHtml(o)}</span>`).join('');
      items.push(`
      <div class="fi-detail-item">
        <div class="fi-detail-k">選択肢: </div>
        <div class="fi-detail-v">${badges}</div>
      </div>
    `);
    }

    add('初期値', detail?.initialValue);
    add('計算式', detail?.calcExpression);

    return items.length ? `<div class="fi-detail-box">${items.join('')}</div>` : '';
  }

  /* フィールドバッジ用スタイルを注入 */
  function injectFieldBadgeStyle() {
    const STYLE_ID = 'toolkit-field-badge-style';
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
    .fi-badge{
      display: inline-block;
      padding: 1px 6px;
      border: 1px solid #d1d5db;
      border-radius: 999px;
      font-size: 11px;
      margin-right: 4px;
      margin-bottom: 4px;
      line-height: 1.4;
      white-space: nowrap;
    }

    .fi-detail-item{
      display: block;
      margin-bottom: 6px;
    }

    .fi-detail-k{
      display: inline;
      font-weight: 600;
      margin-right: 8px;
    }

    .fi-detail-v{
      display: inline;
    }
  `;
    document.head.appendChild(style);
  }


  // ----------------------------
  // [Feature] Views
  // ----------------------------
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

  // ==== Views ====
  const renderViews = async (root, { appId, views, fields }) => {
    const el = root.querySelector('#view-views');
    if (!el) return;
    el.innerHTML = `<div style="opacity:.8">Loading views…</div>`;

    // フィールドcode→label Map（SUBTABLE子も含む）
    const code2label = new Map();
    const props = fields || {};
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

      // ★ viewが持つフィールド情報（type別）
      const listFields = Array.isArray(v.fields) ? v.fields : [];
      const calDate = v.date || '';
      const calTitle = v.title || '';
      const customHtml = typeof v.html === 'string' ? v.html : '';
      const customHtmlLen = customHtml ? customHtml.length : 0;

      // ★ label化（fields配列はフィールドコードなので labelも併記）
      const listFieldsPretty = listFields.length
        ? listFields.map(code => `${code2label.get(code) || code}（${code}）`).join(', ')
        : '（なし）';

      return {
        id: String(v.id ?? ''),
        name: v.name || '',
        type: v.type || '',
        builtinType: v.builtinType || '',
        index: String(v.index ?? ''),
        conditionRaw: parsed.condition,
        conditionPretty: labelizeQueryPart(parsed.condition, code2label),
        sortRaw: (parsed.orderBy || []).join(', '),
        sortPretty: (parsed.orderBy || []).map(ob => labelizeQueryPart(ob, code2label)).join(', '),

        // ★ 追加：ビュー設定としての使用フィールド
        listFields,              // LIST: ["コード", ...]
        listFieldsPretty,        // LIST: "ラベル（コード）, ..."
        calDate,                 // CALENDAR
        calTitle,                // CALENDAR
        customHtmlLen,           // CUSTOM
      };
    });

    const defaultName = rows.length ? rows[0].name : '';

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:nowrap;min-width:0">
        <div style="font-weight:700;white-space:nowrap">All Views（全一覧）</div>
        <div style="display:flex;gap:6px;flex-wrap:nowrap;overflow:auto;white-space:nowrap">
          <button id="kv-copy-md"  class="btn">Copy Markdown</button>
          <button id="kv-dl-md"    class="btn">DL MD</button>
          <button id="kv-dl-csv"   class="btn">DL CSV</button>
          <button id="kv-dl-json" class="btn">DL JSON</button>
        </div>
      </div>

      <div style="opacity:.9;margin-bottom:6px">
        デフォルトビュー（並び順1位）：<strong>${escapeHtml(defaultName || '—')}</strong>
      </div>

      <div class="table-container">
        <table style="border-collapse:collapse;width:100%;table-layout:fixed">
          <colgroup>
            <col style="width:88px">
            <col style="width:28%">
            <col style="width:88px">
            <col style="width:auto">
            <col style="width:26%">
            <col style="width:72px">
          </colgroup>
          <thead>
            <tr>
              <th>ビューID</th>
              <th>ビュー名</th>
              <th>種類</th>
              <th>フィルター</th>
              <th>ソート</th>
              <th>詳細</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr data-view-row="${escapeHtml(r.id)}">
                <td>${escapeHtml(r.id)}</td>
                <td title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>
                <td>${escapeHtml(r.type)}</td>
                <td>${escapeHtml(r.conditionPretty || '（なし）')}</td>
                <td>${escapeHtml(r.sortPretty || '（なし）')}</td>
                <td>
                  <button 
                    type="button"
                    class="fi-detail-btn kv-vw-detail"
                    data-view-id="${escapeHtml(r.id)}"
                    aria-expanded="false"
                  >
                    開く
                  </button>
                </td>
              </tr>

              <tr class="kv-vw-detail-row" data-detail-for="${escapeHtml(r.id)}" style="display:none">
                <td colspan="6" style="padding:10px 12px;background:rgba(0,0,0,.02)">
                  ${r.type === 'LIST' ? `
                    <div style="font-weight:700;margin-bottom:6px">表示フィールド（LIST）</div>
                    <div style="display:flex;gap:6px;flex-wrap:wrap">
                      ${(r.listFields || []).length ? (r.listFields || []).map(code => `
                        <span style="display:inline-flex;gap:6px;align-items:center;border:1px solid rgb(255, 255, 255);border-radius:999px;padding:3px 10px;">
                          <span style="font-weight:600">${escapeHtml(code2label.get(code) || code)}</span>
                          <span style="opacity:.7">(${escapeHtml(code)})</span>
                        </span>
                      `).join('') : `<span style="opacity:.75">（なし）</span>`}
                    </div>
                  ` : r.type === 'CALENDAR' ? `
                    <div style="display:flex;gap:14px;flex-wrap:wrap">
                      <div>
                        <div style="font-weight:700;margin-bottom:6px">日付フィールド（CALENDAR）</div>
                        <div>${escapeHtml((code2label.get(r.calDate) || r.calDate) || '（未設定）')}${r.calDate ? ` <span style="opacity:.7">(${escapeHtml(r.calDate)})</span>` : ''}</div>
                      </div>
                      <div>
                        <div style="font-weight:700;margin-bottom:6px">タイトルフィールド（CALENDAR）</div>
                        <div>${escapeHtml((code2label.get(r.calTitle) || r.calTitle) || '（未設定）')}${r.calTitle ? ` <span style="opacity:.7">(${escapeHtml(r.calTitle)})</span>` : ''}</div>
                      </div>
                    </div>
                  ` : r.type === 'CUSTOM' ? `
                    <div style="display:flex;flex-direction:column;gap:10px">

                      <div>
                        <div style="font-weight:700;margin-bottom:6px">
                          カスタムHTML（CUSTOM）
                        </div>

                        <div style="opacity:.75;font-size:12px;margin-bottom:6px">
                          文字数：${escapeHtml(String(r.customHtmlLen || 0))}
                        </div>

                        <pre style="
                          white-space:pre-wrap;
                          word-break:break-word;
                          border:1px solid rgb(255, 255, 255);
                          border-radius:8px;
                          padding:12px;
                          font-size:12px;
                          line-height:1.6;
                          max-height:400px;
                          overflow:auto;
                        ">
                        ${escapeHtml((views.views[r.name]?.html || '（未設定）'))}
                        </pre>
                      </div>

                    </div>
                  ` : `
                    <div style="opacity:.8">このビュータイプでは、フィールド情報の表示はありません。</div>
                  `}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    // 列定義（ヘッダー順に並べる）
    const VW_COLUMNS = [
      { header: 'ビューID', select: r => r.id },
      { header: 'ビュー名', select: r => r.name },
      { header: '種類', select: r => r.type },
      { header: 'フィルター', select: r => r.conditionPretty || '（なし）' },
      { header: 'ソート', select: r => r.sortPretty || '（なし）' },
      { header: '表示フィールド（LIST）', select: r => r.type === 'LIST' ? (r.listFieldsPretty || '（なし）') : '' },
      { header: 'CALENDAR日付', select: r => r.type === 'CALENDAR' ? (r.calDate || '') : '' },
      { header: 'CALENDARタイトル', select: r => r.type === 'CALENDAR' ? (r.calTitle || '') : '' },
      { header: 'CUSTOM htmlLen', select: r => r.type === 'CUSTOM' ? String(r.customHtmlLen || 0) : '' },
    ];

    // 詳細の開閉（イベントデリゲーション）
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('.kv-vw-detail');
      if (!btn) return;

      const viewId = btn.dataset.viewId || '';
      const detailRow = el.querySelector(`tr.kv-vw-detail-row[data-detail-for="${CSS.escape(viewId)}"]`);
      if (!detailRow) return;

      const isOpen = detailRow.style.display !== 'none';
      detailRow.style.display = isOpen ? 'none' : '';
      btn.setAttribute('aria-expanded', String(!isOpen));
      btn.textContent = isOpen ? '開く' : '閉じる';
    }, { passive: true });

    // イベント（Copy MD / DL MD / Copy CSV / DL JSON）
    el.querySelector('#kv-copy-md').addEventListener('click', async () => {
      const ok = await KTExport.copyMD(rows, VW_COLUMNS);
      flashBtnText(el.querySelector('#kv-copy-md'), ok ? 'Copied!' : 'Failed');
    }, { passive: true });

    el.querySelector('#kv-dl-md').addEventListener('click', () => {
      KTExport.downloadMD(`kintone_views_${appId}.md`, rows, VW_COLUMNS);
    }, { passive: true });

    el.querySelector('#kv-dl-csv').addEventListener('click', async () => {
      KTExport.downloadCSV(`kintone_views_${appId}.csv`, rows, VW_COLUMNS, { withBom: true });
    }, { passive: true });

    el.querySelector('#kv-dl-json').addEventListener('click', () => {
      const json = JSON.stringify(rows, null, 2);
      KTExport.downloadText(`kintone_views_${appId}.json`, json, 'application/json;charset=utf-8');
    }, { passive: true });

  };


  // ----------------------------
  // [Feature] Graphs
  // ----------------------------
  // groups を 1セル内に「G1/G2/G3のピル＋ラベル＋[PER]」で縦積み表示
  const groupsToHTML = (groups = [], code2label = {}) => {
    return groups.map((g, i) => {
      const idx = i + 1;
      const code = g?.code || '';
      const labelRaw = code ? (code2label[code] ? `${code2label[code]}` : code) : '';
      const perTag = g?.per ? `<span class="pill">${String(g.per).toUpperCase()}</span>` : '';
      const label = escapeHtml(labelRaw);
      return `<div class="gline"><span class="pill">G${idx}</span> ${label} ${perTag}</div>`;
    }).join('');
  };

  // groups を 1セル内に「G1 ラベル（コード） [PER]」で全角読点区切り
  const groupsToText = (groups = [], code2label = {}) => {
    const list = Array.isArray(groups) ? groups : [];
    return list.map((g, i) => {
      const idx = i + 1;
      const code = g?.code ?? '';
      // ラベル（コード） or codeのみ
      const label =
        code ? (code2label[code] ? `${code2label[code]}（${code}）` : code) : '';
      // per があれば [PER] を付与
      const per = g?.per ? ` [${String(g.per).toUpperCase()}]` : '';
      return `G${idx} ${label}${per}`;
    }).join('、 ');
  };

  const fmtAggs = (aggs = [], code2label = {}) => {
    const list = Array.isArray(aggs) ? aggs : [];
    return list.map((a) => {
      const fn = String(a?.type || '').toUpperCase();
      const code = a?.code || '';
      const label = code
        ? (code2label[code] ? `${code2label[code]}` : code)
        : 'レコード';
      return fn ? `${fn} ${label}` : label;
    }).join(' / ');
  };

  const renderGraphs = async (root, { appId, reports, fields }) => {
    const el = root.querySelector('#view-graphs');
    if (!el) return;
    el.innerHTML = `<div style="opacity:.8">Loading graphs…</div>`;

    // フィールド code→label Map（SUBTABLE 子も含む）
    const code2label = new Map();
    const props = fields || {};
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

    // UI
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:nowrap;min-width:0">
        <div style="font-weight:700;white-space:nowrap">Graphs（グラフ全一覧）</div>
        <div style="display:flex;gap:6px;flex-wrap:nowrap;overflow:auto;white-space:nowrap">
          <button id="kg-copy-md"  class="btn">Copy Markdown</button>
          <button id="kg-dl-md"    class="btn">DL MD</button>
          <button id="kg-dl-csv"   class="btn">DL CSV</button>
          <button id="kg-dl-json" class="btn">DL JSON</button>
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
                <td>${escapeHtml(r.id)}</td>
                <td title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>
                <td>${escapeHtml(r.chartType)}</td>
                <td>${escapeHtml(r.chartMode)}</td>
                <td>${r.groupsHtml || '—'}</td>
                <td>${escapeHtml(r.aggsText || '—')}</td>
                <td>${escapeHtml(r.filterCond || '（なし）')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    const GR_COLUMNS = [
      { header: 'グラフID', select: r => r.id },
      { header: 'グラフ名', select: r => r.name },
      { header: 'タイプ', select: r => r.chartType },
      { header: '表示モード', select: r => r.chartMode },
      { header: '分類項目', select: r => r.groupsText || '' },
      { header: '集計方法', select: r => r.aggsText },
      { header: '条件', select: r => r.filterCond || '（なし）' },
    ];

    // 2) イベント: Copy MD / Download MD / Copy CSV / Download CSV
    el.querySelector('#kg-copy-md').addEventListener('click', async () => {
      const ok = await KTExport.copyMD(rows, GR_COLUMNS);
      flashBtnText(el.querySelector('#kg-copy-md'), ok ? 'Copied!' : 'Failed');
    }, { passive: true });

    el.querySelector('#kg-dl-md').addEventListener('click', () => {
      KTExport.downloadMD(`kintone_graphs_${appId}.md`, rows, GR_COLUMNS);
    }, { passive: true });

    el.querySelector('#kg-dl-csv').addEventListener('click', () => {
      KTExport.downloadCSV(`kintone_graphs_${appId}.csv`, rows, GR_COLUMNS,
      );
    }, { passive: true });

    el.querySelector('#kg-dl-json').addEventListener('click', async () => {
      const json = JSON.stringify(rows, null, 2);
      KTExport.downloadText(`kintone_graphs_${appId}.json`, json, 'application/json;charset=utf-8');
    }, { passive: true });
  };


  // ----------------------------
  // [Feature] Relations
  // ----------------------------
  // --- 4ボタン＋折り畳み＋インジケータ（命名統一版）---
  function sectionWithDL(
    title, headers, dlRows, innerTableHTML,
    filenameBase = 'relations',            // kind 相当（例: 'relations_lookups' など）
    { appId, defaultOpen = true, indicator = false, relationType } = {}
  ) {

    // ファイル名ビルダー: kintone_${base}_${appId}.${ext}
    const fname = (ext) =>
      `kintone_${filenameBase}_${appId}_${relationType}.${ext}`;

    const uid = Math.random().toString(36).slice(2, 8);
    const secId = `rel-sec-${uid}`;
    const btnCopyMd = `btn-copy-md-${uid}`;
    const btnDlMd = `btn-dl-md-${uid}`;
    const btnDlCsv = `btn-dl-csv-${uid}`;
    const btnDlJSON = `btn-dl-json-${uid}`;
    const indId = `rel-ind-${uid}`;

    const COLS = headers.map((h, i) => ({ header: h, select: (r) => r[i] }));
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
                <button id="${btnDlMd}"    class="btn">DL MD</button>
                <button id="${btnDlCsv}"   class="btn">DL CSV</button>
                <button id="${btnDlJSON}"  class="btn">DL JSON</button>
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
      const container = root.querySelector?.(`#${secId}`) || document.getElementById(secId);
      if (!container) return;
      const qs = (sel) => container.querySelector(sel);
      const touch = (btn, txt = 'Done!') => { if (!btn) return; const o = btn.textContent; btn.textContent = txt; setTimeout(() => btn.textContent = o, 1200); };

      qs(`#${btnCopyMd}`)?.addEventListener('click', async () => {
        const ok = await KTExport.copyMD(dlRows, COLS);
        touch(qs(`#${btnCopyMd}`), ok ? 'Copied!' : 'Failed');
      }, { passive: true });

      qs(`#${btnDlMd}`)?.addEventListener('click', () => {
        KTExport.downloadMD(fname('md'), dlRows, COLS);
      }, { passive: true });

      qs(`#${btnDlCsv}`)?.addEventListener('click', () => {
        KTExport.downloadCSV(fname('csv'), dlRows, COLS, { withBom: true }); // DLはBOM付
      }, { passive: true });

      // JSONダウンロード（命名統一）
      qs(`#${btnDlJSON}`)?.addEventListener('click', () => {
        const data = dlRows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
        const json = JSON.stringify(data, null, 2);
        KTExport.downloadText(fname('json'), json, 'application/json;charset=utf-8');
      }, { passive: true });

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
  function renderRelations(root, relations, appId) {
    const view = root.querySelector('#view-relations');
    if (!view) return;

    const R = relations || {};
    const lookups = Array.isArray(R.lookups) ? R.lookups : [];
    const rts = Array.isArray(R.relatedTables) ? R.relatedTables : [];
    const acts = Array.isArray(R.actions) ? R.actions : [];

    const esc = (v) => String(v ?? '');
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
        { appId, defaultOpen: true, indicator: true, relationType: 'lookup' }
      );

    // Related Records：閉じる
    const widthsRT = ['24%', '16%', '18%', '28%', '14%'];
    const { html: secRT, bind: bindRT } =
      sectionWithDL(
        'Related Records（関連レコード）',
        headersRT, rtRowsDL,
        table(headersRT, rtRowsHtml, widthsRT),
        'relations_relatedTables',
        { appId, defaultOpen: true, indicator: true, relationType: 'Related' }
      );

    // Actions：閉じる
    const widthsAC = ['20%', '8%', '18%', '24%', '20%', '10%'];
    const { html: secAC, bind: bindAC } =
      sectionWithDL(
        'Actions（レコード作成アクション）',
        headersAC, actRowsDL,
        table(headersAC, actRowsHtml, widthsAC),
        'relations_actions',
        { appId, defaultOpen: true, indicator: true, relationType: 'action' }
      );

    // まとめて描画 & バインド
    view.innerHTML = `${secLU}${secRT}${secAC}`;
    bindLU(view); bindRT(view); bindAC(view);

  }


  // ----------------------------
  // [Feature] Notifications
  // ----------------------------
  function renderNotifications(root, ctx) {
    const view = root.querySelector('#view-notice');
    if (!view) return;

    const appId = ctx?.appId || kintone.app.getId();

    view.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin:0 0 8px;flex-wrap:nowrap;min-width:0">
        <h3 style="font-size:14px;margin:0;border-left:4px solid #888;padding-left:8px;display:flex;align-items:center;gap:6px;flex:1">
          <span>Notifications</span>
        </h3>
      </div>
      <div id="kt-notify-body"></div>
    `;

    const body = view.querySelector('#kt-notify-body');

    try {
      renderNotificationsByType(body, ctx, appId);
    } catch (err) {
      console.error('[renderNotifications] render failed', err);
      body.innerHTML = `
        <div style="padding:10px;border:1px solid #f5c2c7;background:#f8d7da;color:#842029;border-radius:8px">
          <b>Notifications render error</b><br>
          <pre style="margin:6px 0 0;white-space:pre-wrap">${String(err?.stack || err)}</pre>
        </div>
      `;
    }
  }

  function renderNotificationsByType(container, data, appId) {
    if (!container) return;

    const general = data?.generalNotify || {};
    const perRecord = data?.perRecordNotify || {};
    const reminder = data?.reminderNotify || {};

    const esc = (v) => String(v ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", "&#39;");

    const yn = (b) => (b ? 'ON' : 'OFF');

    const formatEntity = (entity, includeSubs) => {
      if (!entity) return '—';
      const t = entity?.type || '';
      const code = entity?.code || '';
      if (!t && !code) return '—';
      return `${t}: ${code}${includeSubs ? ' (+subs)' : ''}`;
    };
    const formatTargets = (targets) => {
      const arr = Array.isArray(targets) ? targets : [];
      const s = arr.map(t => formatEntity(t?.entity, t?.includeSubs)).filter(x => x && x !== '—').join(', ');
      return s || '—';
    };
    const formatTiming = (timing) => {
      const t = timing || {};
      const parts = [];
      if (t.code) parts.push(`code=${t.code}`);
      if (t.daysLater != null) parts.push(`daysLater=${t.daysLater}`);
      if (t.hoursLater != null) parts.push(`hoursLater=${t.hoursLater}`);
      if (t.time) parts.push(`time=${t.time}`);
      return parts.join(' / ') || '—';
    };

    // AND/ORバッジ + 条件は「AND/ORを除去して改行」
    const splitByAndOrPreserveQuotes = (s) => {
      const out = [];
      let buf = '';
      let inQuote = false;
      const flush = () => { const t = buf.trim(); if (t) out.push({ type: 'cond', text: t }); buf = ''; };
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"') { inQuote = !inQuote; buf += ch; continue; }
        if (!inQuote) {
          const rest = s.slice(i).toLowerCase();
          if (rest.startsWith(' and ')) { flush(); out.push({ type: 'op', op: 'AND' }); i += 4; continue; }
          if (rest.startsWith(' or ')) { flush(); out.push({ type: 'op', op: 'OR' }); i += 3; continue; }
        }
        buf += ch;
      }
      flush();
      return out.length ? out : [{ type: 'cond', text: s }];
    };
    const parseCondForBadgeAndLines = (cond) => {
      const raw = String(cond || '').trim();
      if (!raw) return { badge: '', linesHtml: '—', linesText: '' };
      const tokens = splitByAndOrPreserveQuotes(raw);
      const ops = tokens.filter(t => t.type === 'op').map(t => t.op);
      const hasAnd = ops.includes('AND');
      const hasOr = ops.includes('OR');
      let badge = '';
      if (hasAnd && hasOr) badge = 'AND/OR';
      else if (hasAnd) badge = 'AND';
      else if (hasOr) badge = 'OR';

      const lines = tokens.filter(t => t.type === 'cond').map(t => t.text.trim()).filter(Boolean);
      const linesHtml = lines.length ? lines.map(esc).join('<br>') : '—';
      const linesText = lines.join('\n');
      return { badge, linesHtml, linesText };
    };
    const badgeHtml = (txt) => txt ? `<span class="pill">${esc(txt)}</span>` : '—';

    // Relationsと同じ table()
    const table = (headers, rows, colWidths = null) => `
      <table style="width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed">
        ${Array.isArray(colWidths) ? `<colgroup>${colWidths.map(w => `<col style="width:${w}">`).join('')}</colgroup>` : ''}
        <thead>
          <tr>${headers.map(h => `<th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;white-space:nowrap;">${h}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map(cols => `
            <tr>${cols.map((c, i) => `
              <td style="padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;${i === 0 || i === 1 ? 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' : ''}${i >= 2 ? 'white-space:pre-wrap;word-break:break-word;' : ''}">${c}</td>
            `).join('')}</tr>
          `).join('') : `<tr><td colspan="${headers.length}" style="padding:10px;color:#666">項目なし</td></tr>`}
        </tbody>
      </table>
    `;

    // ---------------- App notifications ----------------
    const headersApp = ['通知先', 'イベント'];
    const appRowsHtml = [];
    const appRowsDL = [];

    const appNotifs = Array.isArray(general?.notifications) ? general.notifications : [];
    appNotifs.forEach(n => {
      const to = formatEntity(n?.entity, n?.includeSubs);
      const ev = [];
      if (n?.recordAdded) ev.push('レコード追加');
      if (n?.recordEdited) ev.push('レコード編集');
      if (n?.commentAdded) ev.push('コメント書き込み');
      if (n?.statusChanged) ev.push('ステータスの更新');
      if (n?.fileImported) ev.push('ファイル読み込み');
      const evText = ev.join(', ') || '—';
      appRowsHtml.push([esc(to), esc(evText)]);
      appRowsDL.push([to, evText]);
    });

    if (general?.notifyToCommenter != null) {
      const v = yn(!!general.notifyToCommenter);
      appRowsHtml.push(['コメント投稿者', esc(v)]);
      appRowsDL.push(['コメント投稿者', v]);
    }

    const secApp = sectionWithDL(
      `アプリ通知（レコード追加/編集/インポート等）`,
      headersApp, appRowsDL,
      table(headersApp, appRowsHtml, ['40%', '60%']),
      'notifications_general',
      { appId, defaultOpen: true, indicator: true, relationType: 'general' }
    );

    // ---------------- Per-record notifications ----------------
    const headersRec = ['タイトル', 'AND/OR', '条件', '通知先'];
    const recRowsHtml = [];
    const recRowsDL = [];

    const recNotifs = Array.isArray(perRecord?.notifications) ? perRecord.notifications : [];
    recNotifs.forEach(n => {
      const title = n?.title || '—';
      const cond = n?.filterCond || '';
      const parsed = parseCondForBadgeAndLines(cond);
      const to = formatTargets(n?.targets);

      recRowsHtml.push([esc(title), badgeHtml(parsed.badge), parsed.linesHtml, esc(to)]);
      recRowsDL.push([title, parsed.badge || '', parsed.linesText || cond || '', to]);
    });

    const secRec = sectionWithDL(
      `レコード通知（条件一致で通知）`,
      headersRec, recRowsDL,
      table(headersRec, recRowsHtml, ['22%', '10%', '36%', '32%']),
      'notifications_perRecord',
      { appId, defaultOpen: true, indicator: true, relationType: 'perRecord' }
    );

    // ---------------- Reminder notifications ----------------
    const headersRem = ['タイトル', '基準フィールド', 'タイミング', 'AND/OR', '条件', '通知先'];
    const remRowsHtml = [];
    const remRowsDL = [];

    const remNotifs = Array.isArray(reminder?.notifications) ? reminder.notifications : [];
    remNotifs.forEach(n => {
      const title = n?.title || '—';
      const timingCode = n?.timing?.code || '—';
      const timingText = formatTiming(n?.timing);
      const cond = n?.filterCond || '';
      const parsed = parseCondForBadgeAndLines(cond);
      const to = formatTargets(n?.targets);

      remRowsHtml.push([
        esc(title),
        `<code>${esc(timingCode)}</code>`,
        esc(timingText),
        badgeHtml(parsed.badge),
        parsed.linesHtml,
        esc(to),
      ]);

      remRowsDL.push([
        title,
        timingCode,
        timingText,
        parsed.badge || '',
        parsed.linesText || cond || '',
        to,
      ]);
    });

    const tz = reminder?.timezone ? `timezone: ${reminder.timezone}` : '';
    const secRem = sectionWithDL(
      `リマインダー通知（日時フィールド基準） ${tz}`.trim(),
      headersRem, remRowsDL,
      table(headersRem, remRowsHtml, ['18%', '12%', '18%', '10%', '22%', '20%']),
      'notifications_reminder',
      { appId, defaultOpen: true, indicator: true, relationType: 'reminder' }
    );

    container.innerHTML = `${secApp.html}${secRec.html}${secRem.html}`;
    secApp.bind(container); secRec.bind(container); secRem.bind(container);
  }


  // ----------------------------
  // [Feature] Access Control List
  // ----------------------------
  function renderAcl(root, ctx) {
    const view = root.querySelector('#view-acl');
    if (!view) return;

    const appId = ctx?.appId || kintone.app.getId();

    view.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin:0 0 8px;flex-wrap:nowrap;min-width:0">
        <h3 style="font-size:14px;margin:0;border-left:4px solid #888;padding-left:8px;display:flex;align-items:center;gap:6px;flex:1">
          <span>ACL</span>
        </h3>
      </div>
      <div id="kt-acl-body"></div>
    `;

    const body = view.querySelector('#kt-acl-body');

    try {
      renderAclByType(body, ctx, appId);
    } catch (err) {
      console.error('[renderAcl] render failed', err);
      body.innerHTML = `
      <div style="padding:10px;border:1px solid #f5c2c7;background:#f8d7da;color:#842029;border-radius:8px">
        <b>ACL render error</b><br>
        <pre style="margin:6px 0 0;white-space:pre-wrap">${String(err?.stack || err)}</pre>
      </div>
    `;
    }
  }

  function renderAclByType(container, ctx, appId) {
    if (!container) return;

    const esc = (v) => String(v ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", "&#39;");

    const yn = (b) => (b ? 'ON' : 'OFF');

    const formatEntity = (entity, includeSubs) => {
      if (!entity) return '—';
      const t = entity?.type || '';
      const code = entity?.code ?? '';
      const codeText = (code === null || code === undefined || code === '') ? '—' : String(code);
      return `${t}: ${codeText}${includeSubs ? ' (+subs)' : ''}`;
    };

    // AND/ORバッジ + 条件は「AND/ORを除去して改行」(Notifications と同じ)
    const splitByAndOrPreserveQuotes = (s) => {
      const out = [];
      let buf = '';
      let inQuote = false;
      const flush = () => { const t = buf.trim(); if (t) out.push({ type: 'cond', text: t }); buf = ''; };
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"') { inQuote = !inQuote; buf += ch; continue; }
        if (!inQuote) {
          const rest = s.slice(i).toLowerCase();
          if (rest.startsWith(' and ')) { flush(); out.push({ type: 'op', op: 'AND' }); i += 4; continue; }
          if (rest.startsWith(' or ')) { flush(); out.push({ type: 'op', op: 'OR' }); i += 3; continue; }
        }
        buf += ch;
      }
      flush();
      return out.length ? out : [{ type: 'cond', text: s }];
    };
    const parseCondForBadgeAndLines = (cond) => {
      const raw = String(cond || '').trim();
      if (!raw) return { badge: '', linesHtml: '—', linesText: '' };
      const tokens = splitByAndOrPreserveQuotes(raw);
      const ops = tokens.filter(t => t.type === 'op').map(t => t.op);
      const hasAnd = ops.includes('AND');
      const hasOr = ops.includes('OR');
      let badge = '';
      if (hasAnd && hasOr) badge = 'AND/OR';
      else if (hasAnd) badge = 'AND';
      else if (hasOr) badge = 'OR';
      const lines = tokens.filter(t => t.type === 'cond').map(t => t.text.trim()).filter(Boolean);
      const linesHtml = lines.length ? lines.map(esc).join('<br>') : '—';
      const linesText = lines.join('\n');
      return { badge, linesHtml, linesText };
    };
    const badgeHtml = (txt) => txt ? `<span class="pill">${esc(txt)}</span>` : '—';

    const table = (headers, rows, colWidths = null) => `
      <table style="width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed">
        ${Array.isArray(colWidths) ? `<colgroup>${colWidths.map(w => `<col style="width:${w}">`).join('')}</colgroup>` : ''}
        <thead>
          <tr>${headers.map(h => `<th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;white-space:nowrap;">${h}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map(cols => `
            <tr>${cols.map((c, i) => `
              <td style="padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;
                ${i === 0 || i === 1 ? 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' : ''}
                ${i >= 2 ? 'white-space:pre-wrap;word-break:break-word;' : ''}
              ">${c}</td>
            `).join('')}</tr>
          `).join('') : `<tr><td colspan="${headers.length}" style="padding:10px;color:#666">項目なし</td></tr>`}
        </tbody>
      </table>
    `;

    // ========================
    // 1) App ACL (ctx.appAcl.rights[])
    // ========================
    const appAcl = ctx?.appAcl || {};
    const appRights = Array.isArray(appAcl?.rights) ? appAcl.rights : [];

    const headersApp = [
      '対象',
      'appEditable',
      'recordView',
      'add',
      'edit',
      'del',
      'import',
      'export',
    ];

    const appRowsHtml = appRights.map(r => [
      esc(formatEntity(r?.entity, r?.includeSubs)),
      esc(yn(!!r?.appEditable)),
      esc(yn(!!r?.recordViewable)),
      esc(yn(!!r?.recordAddable)),
      esc(yn(!!r?.recordEditable)),
      esc(yn(!!r?.recordDeletable)),
      esc(yn(!!r?.recordImportable)),
      esc(yn(!!r?.recordExportable)),
    ]);

    const appRowsDL = appRights.map(r => [
      formatEntity(r?.entity, r?.includeSubs),
      yn(!!r?.appEditable),
      yn(!!r?.recordViewable),
      yn(!!r?.recordAddable),
      yn(!!r?.recordEditable),
      yn(!!r?.recordDeletable),
      yn(!!r?.recordImportable),
      yn(!!r?.recordExportable),
    ]);

    const secApp = sectionWithDL(
      `アプリのアクセス権限`,
      headersApp, appRowsDL,
      table(headersApp, appRowsHtml, ['32%', '10%', '10%', '8%', '8%', '8%', '12%', '12%']),
      'acl_app',
      { appId, defaultOpen: true, indicator: true, relationType: 'appAcl' }
    );

    // ========================
    // 2) Record ACL (ctx.recordAcl.rights[] -> entities[])
    // ========================
    const recordAcl = ctx?.recordAcl || {};
    const recRights = Array.isArray(recordAcl?.rights) ? recordAcl.rights : [];

    const headersRec = ['#', 'AND/OR', '条件', '対象', 'view', 'edit', 'del'];
    const recRowsHtml = [];
    const recRowsDL = [];

    recRights.forEach((rule, ridx) => {
      const condRaw = String(rule?.filterCond || '').trim();
      const parsed = parseCondForBadgeAndLines(condRaw);
      const ents = Array.isArray(rule?.entities) ? rule.entities : [];

      // entities が空でも “ルール自体” は見えるように1行出す
      if (!ents.length) {
        recRowsHtml.push([
          esc(String(ridx + 1)),
          badgeHtml(parsed.badge),
          parsed.linesHtml,
          '—',
          '—', '—', '—',
        ]);
        recRowsDL.push([
          String(ridx + 1),
          parsed.badge || '',
          parsed.linesText || condRaw || '',
          '',
          '', '', '',
        ]);
        return;
      }

      // ★各 entity 行に必ず条件を出す（潰れ防止）
      ents.forEach((e) => {
        recRowsHtml.push([
          esc(String(ridx + 1)),
          badgeHtml(parsed.badge),
          parsed.linesHtml, // 条件（改行済み）
          esc(formatEntity(e?.entity, e?.includeSubs)),
          esc(yn(!!e?.viewable)),
          esc(yn(!!e?.editable)),
          esc(yn(!!e?.deletable)),
        ]);

        recRowsDL.push([
          String(ridx + 1),
          parsed.badge || '',
          parsed.linesText || condRaw || '',
          formatEntity(e?.entity, e?.includeSubs),
          yn(!!e?.viewable),
          yn(!!e?.editable),
          yn(!!e?.deletable),
        ]);
      });
    });

    // ★ Record ACL 専用テーブル（条件列だけ pre-wrap、nowrap を当てない）
    const recordTable = (headers, rows) => `
      <table style="width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed">
        <colgroup>
          <col style="width:6%">
          <col style="width:10%">
          <col style="width:34%">
          <col style="width:26%">
          <col style="width:8%">
          <col style="width:8%">
          <col style="width:8%">
        </colgroup>
        <thead>
          <tr>${headers.map(h => `<th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;white-space:nowrap;">${h}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map(cols => `
            <tr>
              ${cols.map((c, i) => {
      // i=2 が「条件」列：必ず折り返し
      const style =
        i === 2
          ? 'white-space:pre-wrap;word-break:break-word;'
          : (i === 0 || i === 4 || i === 5 || i === 6)
            ? 'white-space:nowrap;'
            : 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      return `<td style="padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;${style}">${c}</td>`;
    }).join('')}
                      </tr>
                    `).join('') : `<tr><td colspan="${headers.length}" style="padding:10px;color:#666">項目なし</td></tr>`}
                  </tbody>
                </table>
              `;

    const secRec = sectionWithDL(
      `レコードのアクセス権限`,
      headersRec, recRowsDL,
      recordTable(headersRec, recRowsHtml),
      'acl_record',
      { appId, defaultOpen: true, indicator: true, relationType: 'recordAcl' }
    );

    // ========================
    // 3) Field ACL (ctx.fieldAcl.rights[] -> code + entities[])
    // ========================
    const fieldAcl = ctx?.fieldAcl || {};
    const fldRights = Array.isArray(fieldAcl?.rights) ? fieldAcl.rights : [];

    const headersFld = ['フィールド', '対象', '権限'];
    const fldRowsHtml = [];
    const fldRowsDL = [];

    fldRights.forEach((r) => {
      const code = r?.code || '—';
      const label = ctx?.fields?.[code]?.label ? `（${ctx.fields[code].label}）` : '';
      const ents = Array.isArray(r?.entities) ? r.entities : [];

      if (!ents.length) {
        fldRowsHtml.push([`<code>${esc(code)}</code>${esc(label)}`, '—', '—']);
        fldRowsDL.push([`${code}${label}`, '', '']);
        return;
      }

      ents.forEach((e, i) => {
        const first = (i === 0);
        fldRowsHtml.push([
          first ? `<code>${esc(code)}</code>${esc(label)}` : ' ',
          esc(formatEntity(e?.entity, e?.includeSubs)),
          esc(e?.accessibility ?? '—'),
        ]);
        fldRowsDL.push([
          first ? `${code}${label}` : '',
          formatEntity(e?.entity, e?.includeSubs),
          e?.accessibility ?? '',
        ]);
      });
    });

    const secFld = sectionWithDL(
      `フィールドのアクセス権限`,
      headersFld, fldRowsDL,
      table(headersFld, fldRowsHtml, ['34%', '34%', '32%']),
      'acl_field',
      { appId, defaultOpen: true, indicator: true, relationType: 'fieldAcl' }
    );

    container.innerHTML = `${secApp.html}${secRec.html}${secFld.html}`;
    secApp.bind(container); secRec.bind(container); secFld.bind(container);
  }


  // ----------------------------
  // [Feature] Templates
  // ----------------------------
  function fetchFieldMeta(fields) {
    const resp = fields;
    const list = [];
    const walkProps = (propsObj = {}) => {
      Object.values(propsObj).forEach(p => {
        if (p?.type === 'SUBTABLE') {
          walkProps(p.fields || {});
        } else if (p?.code) {
          list.push({ code: p.code, label: p.label || p.code });
        }
      });
    };
    walkProps(resp || {});
    return list; // ← 同期で即返す
  }

  async function registerFieldCompletions(monaco, fieldsProp) {

    const fields = fetchFieldMeta(fieldsProp);
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

  function buildDocPayloadLiteFromPrefetch(pref) {
    if (!pref || !pref.fields || !pref.layout) {
      throw new Error('prefetch data is missing required properties');
    }
    const props = pref.fields || {};

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

  async function renderTemplates(root, DATA) {
    const view = root.querySelector('#view-templates');
    if (!view) return;
    let currentFileName = 'template.js';

    // GitHub設定
    const GH = {
      owner: 'youtotto',
      repo: 'kintone-Customize-template',
      dirs: { templates: 'js', css: 'CSS', snippets: 'snippets', documents: 'documents' },
      endpoint(dir) { return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${encodeURIComponent(dir)}`; },
      cacheKey(kind) { return `kt_tpl_cache_ui_${kind}`; }
    };
    const GH_BASE = `https://github.com/${GH.owner}/${GH.repo}`;

    // UI色
    const C = getThemeColors();
    const BG = C.bgSub2; // または C.bg
    const BD = C.border2;
    const isDark = C.isDark;
    const PANEL_H = '75vh';

    // レイアウト
    view.innerHTML = `
      <div id="kt-tpl" style="display:flex; gap:14px; align-items:stretch;">
        <!-- 左：エディタ -->
        <div style="flex:2; min-width:380px; display:flex; flex-direction:column; gap:10px;">
          <div style="display:flex; align-items:center; gap:10px; justify-content:space-between;">
            <div style="display:flex; align-items:center; gap:8px;">
              <button id="kt-tpl-download" class="btn" disabled style="height:32px; padding:0 10px;">⬇ ローカルに保存</button>
              <button id="kt-tpl-upload" class="btn" disabled style="height:32px; padding:0 10px;">⬆ アプリに反映</button>
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
              <option value="css">Css  (GitHub: ${GH.dirs.css})</option>
              <option value="snippets">Snippets  (GitHub: ${GH.dirs.snippets})</option>
              <option value="documents">Documents (GitHub: ${GH.dirs.documents})</option>
            </select>
          </div>

          <div style="display:flex; gap:8px;">
            <button id="kt-tpl-insert" class="btn" disabled style="flex:1; height:32px;">⤴︎ 挿入</button>
            <button id="kt-tpl-refresh" class="btn" style="flex:1; height:32px;">↻ 一覧更新</button>
            <button id="kt-tpl-github" class="btn" style="flex:1; height:32px;">🔗 Github</button>
            <button id="kt-tpl-ai-req" class="btn" style="flex:1; height:32px; display:none;">AI prompt</button>
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
    const $sourceSel = view.querySelector('#kt-tpl-source');
    const $overview = view.querySelector('#kt-tpl-overview');
    const $btnAIReq = view.querySelector('#kt-tpl-ai-req');
    const $upload = view.querySelector('#kt-tpl-upload');
    const $btnGithub = view.querySelector('#kt-tpl-github');

    function updateAIReqVisibility() {
      const isDocs = ($sourceSel.value === 'documents');
      // 表示/非表示
      $btnAIReq.style.display = isDocs ? '' : 'none';
      $insert.style.display = isDocs ? 'none' : '';
      if (!isDocs) return;

      // documents のときは内容があれば有効化
      const text = (monacoEditor ? monacoEditor.getValue() : '').trim();
      $btnAIReq.disabled = !text;
    }

    // 状態
    let selectedItem = null;        // 選択中ファイル
    let selectedKind = 'templates'; // 'templates' | 'snippets' | 'documents'

    // ヘルパ
    // 現在の種別に応じて GitHub へ飛ばす
    function openGithubForCurrent() {
      const kind = $sourceSel.value;
      let url = '';

      if (kind === 'templates') {
        // Templates → js ディレクトリ
        url = `${GH_BASE}/tree/main/${GH.dirs.templates}/README.md`; // https://github.com/.../tree/main/js
      } else if (kind === 'css') {
        // css → css ディレクトリ
        url = `${GH_BASE}/tree/main/${GH.dirs.css}/README.md`;  // https://github.com/.../tree/main/css
      } else if (kind === 'snippets') {
        // Snippets → snippets ディレクトリ
        url = `${GH_BASE}/tree/main/${GH.dirs.snippets}/README.md`;  // https://github.com/.../tree/main/snippets
      } else if (kind === 'documents') {
        // Documents のときは、選択中があればそのファイル、なければディレクトリ
        if (selectedItem) {
          url = `${GH_BASE}/blob/main/${GH.dirs.documents}/${encodeURIComponent(selectedItem.name)}`;
        } else {
          url = `${GH_BASE}/tree/main/${GH.dirs.documents}`;
        }
      } else {
        // フォールバック：リポジトリTOP
        url = GH_BASE;
      }

      window.open(url, '_blank', 'noopener');
    }

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
        if (kind === 'css') return n.endsWith('.css'); // ★追加
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

      const tag =
        kind === 'snippets' ? 'SNIP' :
          kind === 'documents' ? 'DOC' :
            kind === 'css' ? 'CSS' : 'JS';

      el.innerHTML = `
        <div style="border:1px solid ${BD};border-radius:999px;padding:2px 6px;font-size:11px">${tag}</div>
        <div style="flex:1">${file.name}</div>
        <div style="opacity:.6;font-size:11px">${size ? size + ' Bytes' : ''}</div>
      `;

      // ★言語切替は「クリック時」に統一すると事故が減ります（ここで切るなら kindごとに）
      // if (kind === 'templates' || kind === 'snippets') setEditorLanguage('javascript');
      // else if (kind === 'css') setEditorLanguage('css');
      // else if (kind === 'documents') setEditorLanguage('markdown');

      el.addEventListener('click', async () => {
        selectedItem = file;
        selectedKind = kind;

        if (window.monaco && monacoEditor && !monacoEditor._aiReqHooked) {
          monacoEditor._aiReqHooked = true;
          monacoEditor.onDidChangeModelContent(() => updateAIReqVisibility());
        }

        // ★ここで言語決定（確実）
        if (kind === 'documents') setEditorLanguage('markdown');
        else if (kind === 'css') setEditorLanguage('css');
        else setEditorLanguage('javascript');

        if (kind === 'templates') {
          $overview.style.display = 'none';
          $overview.innerHTML = '';
          const code = await loadCode(file);
          currentFileName = file.name;
          if (monacoEditor) monacoEditor.setValue(code);
          else await initEditor(code);
          updateAIReqVisibility();
          $meta.textContent = `選択中（Template表示）：${file.name}`;
          [$download, $upload].forEach(b => b.disabled = false);
          $insert.disabled = false;

        } else if (kind === 'css') {
          // ★CSSは「エディタで表示」「ローカル保存」「アプリに反映」まで
          $overview.style.display = 'none';
          $overview.innerHTML = '';
          const code = await loadCode(file);
          currentFileName = file.name;
          if (monacoEditor) monacoEditor.setValue(code);
          else await initEditor(code);
          updateAIReqVisibility();
          $meta.textContent = `選択中（CSS表示）：${file.name}`;
          [$download, $upload].forEach(b => b.disabled = false);
          $insert.disabled = true; // CSSをJSへ挿入するのは事故るので無効推奨

        } else if (kind === 'snippets') {
          await showSnippetOverview(file);
          [$insert, $upload].forEach(b => b.disabled = false);

        } else if (kind === 'documents') {
          $overview.style.display = 'none';
          $overview.innerHTML = '';
          const code = await loadCode(file);
          currentFileName = file.name;
          if (monacoEditor) monacoEditor.setValue(code);
          else await initEditor(code);
          updateAIReqVisibility();
          $meta.textContent = `選択中（document表示）：${file.name}`;
          [$download].forEach(b => b.disabled = false);
          [$upload].forEach(b => b.disabled = true);
          $insert.disabled = false;
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
      // ★初期は全部OFF（クリックでONにする）
      [$download, $insert, $upload].forEach(b => { if (b) b.disabled = true; });
      $meta.textContent = '';

      if (kind === 'snippets') {
        $overview.style.display = 'block';
        $overview.innerHTML = `<div style="opacity:.7; padding:8px; border:1px dashed ${BD}; border-radius:8px;">
          スニペットを選択するとプレビューが表示されます
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

    // 初期テンプレ（kintone CustomizeJS）
    const KINTONE_TEMPLATE = String.raw`
    (function () {
        'use strict';

        kintone.events.on('app.record.index.show', (event) => {

            const rec = event.record;

            return event;
        });
    })();`;
    // どこかの初期化処理内で
    await initEditor(KINTONE_TEMPLATE);
    if (window.monaco && !window.monaco._kintoneFieldsReady) {
      try {
        // 既存の registerFieldCompletions(monaco, props?) があれば fields.properties を渡す
        await registerFieldCompletions(window.monaco, DATA?.fields);
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

      if (selectedKind === 'templates' || selectedKind === 'documents' || selectedKind === 'css') {
        content = monacoEditor ? monacoEditor.getValue() : '';
      } else {
        name = selectedItem.name;
        content = await loadCode(selectedItem);
      }

      const mime =
        selectedKind === 'documents' ? 'text/markdown' :
          selectedKind === 'css' ? 'text/css' :
            'text/javascript';

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
            style="display:block; width:100%; max-width:100%; box-sizing:border-box; padding:8px 10px; border-radius:8px; border:1px solid #8882; background:transparent; color:inherit" />

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
          <div role="alert"
              style="margin-top:12px; font-size:12px; line-height:1.6; border:1px solid #f59e0b55; background:#f59e0b0f; border-radius:8px; padding:10px 12px;">
            <div style="font-weight:700; margin-bottom:6px;">⚠️ 同名ファイルについて</div>
            <ul style="margin:0 0 0 18px; padding:0;">
              <li>同名のファイルの重複チェックは行いません。そのままアップロードされます。</li>
              <li>重複を避けたい場合は<b>ファイル名を変更</b>してください。</li>
            </ul>
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

    async function putAppendFileToCustomizeWithTargets(app, keys, { toDesktop, toMobile }, assetType) {
      // assetType: 'js' | 'css'
      const slot = (assetType === 'css') ? 'css' : 'js';

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

      const toFileItem = (fileKey) => ({ type: 'FILE', file: { fileKey } });

      const next = {
        app,
        scope: base.scope || 'ALL',
        desktop: {
          js: [...(base.desktop?.js ?? [])],
          css: [...(base.desktop?.css ?? [])]
        },
        mobile: {
          js: [...(base.mobile?.js ?? [])],
          css: [...(base.mobile?.css ?? [])]
        }
      };

      // ★追記先を slot で切替
      if (toDesktop && keys.fileKeyDesktop) next.desktop[slot].push(toFileItem(keys.fileKeyDesktop));
      if (toMobile && keys.fileKeyMobile) next.mobile[slot].push(toFileItem(keys.fileKeyMobile));

      await kintone.api(kintone.api.url('/k/v1/preview/app/customize.json', true), 'PUT', next);
      await kintone.api(kintone.api.url('/k/v1/preview/app/deploy.json', true), 'POST', { apps: [{ app, revision: -1 }], revert: false });
    }
    $upload?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget; btn.disabled = true;
      try {
        const app = kintone.app.getId();

        const assetType = (selectedKind === 'css') ? 'css' : 'js';
        const defaultName =
          currentFileName ||
          (selectedKind === 'css' ? 'style.css' :
            selectedKind === 'documents' ? 'document.md' : 'template.js');

        // 1) ダイアログ
        const form = await openUploadDialog({
          defaultName,
          defaultDesktop: true,
          defaultMobile: false
        });
        if (!form) return;

        const mime =
          (selectedKind === 'css') ? 'text/css' :
            (selectedKind === 'documents') ? 'text/markdown' :
              'text/javascript';

        const content = monacoEditor ? monacoEditor.getValue() : '';
        if (!content.trim()) throw new Error('editor is empty');

        Spinner.show();

        // 2) アップロード（desktop/mobileで fileKey 分ける）
        let fileKeyDesktop = null, fileKeyMobile = null;

        if (form.toDesktop && form.toMobile) {
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

        // 3) 追記PUT → デプロイ待ち（★assetType渡す）
        await putAppendFileToCustomizeWithTargets(
          app,
          { fileKeyDesktop, fileKeyMobile },
          { toDesktop: form.toDesktop, toMobile: form.toMobile },
          assetType
        );

        await waitDeploy(app);

        const label = (assetType === 'css') ? 'CSS' : 'JS';
        alert(`✅ 追記＆デプロイ完了：${form.name}\n[Desktop ${label}: ${form.toDesktop ? 'Yes' : 'No'} / Mobile ${label}: ${form.toMobile ? 'Yes' : 'No'}]`);

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

    $refresh.addEventListener('click', async () => {
      sessionStorage.removeItem(GH.cacheKey($sourceSel.value));
      await loadList();
    });

    $btnGithub.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openGithubForCurrent();
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

        $meta.textContent = '✅ 生成プロンプトをテキストとしてダウンロードしました。';
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

  }


  // ----------------------------
  // [Feature] Customize
  // kintone JS/CSS カスタマイズ編集機能（Toolkit版 JSEditタブ）
  // ----------------------------
  async function renderCustomize(root, DATA, appId) {
    const view = root.querySelector('#view-customize');
    if (!view) return;

    // === カラースキーム ===
    const C = getThemeColors();
    const BG = C.bgSub2; // または C.bg
    const BD = C.border2;
    const isDark = C.isDark;
    const PANEL_H = '75vh';

    // === GitHub: snippetsのみ ===
    const GH = {
      owner: 'youtotto',
      repo: 'kintone-Customize-template',
      dirs: { snippets: 'snippets' },
      endpoint(dir) { return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${encodeURIComponent(dir)}`; },
    };

    // === レイアウト（Templatesタブと同じ見た目） ===
    view.innerHTML = `
      <div id="kt-tpl" style="display:flex; gap:14px; align-items:stretch;">
        <!-- 左：エディタ -->
        <div style="flex:2; min-width:380px; display:flex; flex-direction:column; gap:10px;">
          <div style="display:flex; align-items:center; gap:10px; justify-content:space-between;">
            <div style="display:flex; align-items:center; gap:8px;">
              <button id="kt-tpl-download" class="btn" disabled style="height:32px; padding:0 10px;">⬇ ローカルに保存</button>
              <button id="kt-tpl-upload" class="btn" disabled style="height:32px; padding:0 10px;">⬆ アプリに反映</button>
              <button id="kt-tpl-new" class="btn" style="height:32px; padding:0 10px;">＋ 新規作成</button>
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

        <!-- 右：ファイル一覧（Customize / Snippets） -->
        <div style="flex:1; min-width:240px; display:flex; flex-direction:column; gap:10px; height:${PANEL_H}; min-height:0;">
          <div style="display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:1;
            padding:6px 0; background:${isDark ? '#1b1b1b' : '#fff'};">
            <div style="font-weight:600; padding-left:12px; margin:6px 0;">Files</div>
            <select id="kt-tpl-source" class="btn" style="padding:3px 4px; height:32px;">
              <option value="JavaScript">JavaScript (desktop)</option>
              <option value="css">CSS (desktop)</option>
              <option value="JavaScriptMobile">JavaScript (mobile)</option>
              <option value="cssMobile">CSS (mobile)</option>
              <option value="snippets">Snippets (GitHub: ${GH.dirs.snippets})</option>
            </select>
          </div>

          <div style="display:flex; gap:8px;">
            <button id="kt-tpl-insert"  class="btn" disabled style="flex:1; height:32px;">⤴︎ 挿入</button>
            <button id="kt-tpl-refresh" class="btn"          style="flex:1; height:32px;">↻ 一覧更新</button>
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

    // === 要素参照（TemplatesタブのID命名に合わせる） ===
    const $ = (s) => view.querySelector(s);
    const $list = $('#kt-tpl-list');
    const $download = $('#kt-tpl-download');
    const $upload = $('#kt-tpl-upload');
    const $new = $('#kt-tpl-new');
    const $meta = $('#kt-tpl-meta');
    const $refresh = $('#kt-tpl-refresh');
    const $insert = $('#kt-tpl-insert');
    const $sourceSel = $('#kt-tpl-source');
    const $overview = $('#kt-tpl-overview');
    const $editorHost = $('#kt-tpl-editor');

    // === Monaco ===
    const monaco = await loadMonaco();
    const editor = monaco.editor.create($editorHost, {
      value: '',
      language: 'javascript',
      theme: isDark ? 'vs-dark' : 'vs',
      automaticLayout: true,
      fontSize: 12,
      minimap: { enabled: false },
    });
    window.monacoEditor = editor;
    const setEditorLanguage = (lang = 'javascript') => {
      const model = editor.getModel();
      if (model) monaco.editor.setModelLanguage(model, lang);
    };

    // === ヘルパ ===
    const apiUrl = (p) => kintone.api.url(p, true);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const CURRENT = { target: 'desktop', name: null };

    // src値 → kind/js|css, target/desktop|mobile のマッピング
    const SRC = {
      JavaScript: { kind: 'js', target: 'desktop' },
      css: { kind: 'css', target: 'desktop' },
      JavaScriptMobile: { kind: 'js', target: 'mobile' },
      cssMobile: { kind: 'css', target: 'mobile' },
      snippets: { kind: 'js', target: 'desktop' } // エディタ言語の既定用
    };

    const getMimeByName = (name) =>
      /\.css$/i.test(name) ? 'text/css'
        : /\.json$/i.test(name) ? 'application/json'
          : 'text/javascript';

    // kintone customize
    async function getCustomize(app) {
      try {
        const prev = await kintone.api(apiUrl('/k/v1/preview/app/customize.json'), 'GET', { app });
        return { source: 'preview', data: prev };
      } catch {
        const prod = await kintone.api(apiUrl('/k/v1/app/customize.json'), 'GET', { app });
        return { source: 'production', data: prod };
      }
    }
    async function downloadByKey(fileKey) {
      const res = await fetch(apiUrl('/k/v1/file.json') + '?fileKey=' + encodeURIComponent(fileKey), {
        method: 'GET',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin'
      });
      if (!res.ok) throw new Error('Download error ' + res.status);
      return await res.text();
    }
    async function uploadOnce(name, content, mime) {
      const fd = new FormData();
      try { fd.append('__REQUEST_TOKEN__', kintone.getRequestToken()); } catch { }
      fd.append('file', new Blob([content], { type: mime }), name);
      const res = await fetch(apiUrl('/k/v1/file.json'), {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin',
        body: fd
      });
      if (!res.ok) throw new Error('Upload ' + res.status);
      const { fileKey } = await res.json();
      return fileKey;
    }
    function getKindByName(name) {
      const n = String(name || '').toLowerCase().trim();
      if (n.endsWith('.css')) return 'css';
      if (n.endsWith('.js')) return 'js';
      // 拡張子が無い/特殊な場合は nameヒントで雑に判定
      return n.includes('css') ? 'css' : 'js';
    }
    async function putPreviewReplace(app, target /* 'desktop'|'mobile' */, name, fileKey) {
      const kind = getKindByName(name);     // ← js or css
      const { data } = await getCustomize(app); // 既存wrapper想定（preview側を返す）

      const desk = data.desktop || { js: [], css: [] };
      const mobi = data.mobile || { js: [], css: [] };

      // 対象配列（js/css × desktop/mobile）を選択
      const arr = (target === 'desktop')
        ? (kind === 'css' ? desk.css : desk.js)
        : (kind === 'css' ? mobi.css : mobi.js);

      const next = (arr || []).filter(f => !(f.type === 'FILE' && f.file?.name === name));
      next.push({ type: 'FILE', file: { fileKey, name } });

      // 選んだ配列だけ上書き
      if (target === 'desktop') {
        if (kind === 'css') desk.css = next; else desk.js = next;
      } else {
        if (kind === 'css') mobi.css = next; else mobi.js = next;
      }

      const payload = {
        app,
        scope: data.scope || 'ALL',
        desktop: desk,
        mobile: mobi
      };

      await kintone.api(apiUrl('/k/v1/preview/app/customize.json'), 'PUT', payload);
    }
    async function deployAndWait(app, pollMs = 1500, timeoutMs = 60000) {
      await kintone.api(apiUrl('/k/v1/preview/app/deploy.json'), 'POST', { apps: [{ app, revision: -1 }], revert: false });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(pollMs);
        const st = await kintone.api(apiUrl('/k/v1/preview/app/deploy.json'), 'GET', { apps: [Number(app)] });
        const s = st?.apps?.[0]?.status;
        if (s === 'SUCCESS' || s === 'PROCESSED') return;
        if (s === 'FAIL' || s === 'FAILED') throw new Error('Deploy failed');
      }
      throw new Error('Deploy timeout');
    }

    // GitHub snippets
    async function loadSnippets() {
      const res = await fetch(GH.endpoint(GH.dirs.snippets), { headers: { 'Accept': 'application/vnd.github+json' } });
      const json = await res.json();
      if (!Array.isArray(json)) return [];
      return json.filter(x => x.type === 'file' && /\.js$/i.test(x.name));
    }
    const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // === ファイル行：Templatesタブの見た目に合わせたデザイン ===
    function fileRow({ name, size, badge = 'JS' }) {
      const el = document.createElement('div');
      el.style.cssText = `display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid ${BD};cursor:pointer;`;
      const sz = size ? Number(size) : 0; // "12345" でも OK
      el.innerHTML = `
        <div style="border:1px solid ${BD};border-radius:999px;padding:2px 6px;font-size:11px">${badge}</div>
        <div style="flex:1">${name}</div>
        <div style="opacity:.6;font-size:11px">${sz ? sz.toLocaleString() + ' Bytes' : ''}</div>
      `;
      return el;
    }

    // === リスト描画（Customize / Snippets） ===
    let currentFileName = null;
    async function refreshList() {
      const src = $sourceSel.value;
      const conf = SRC[src] || { kind: 'js', target: 'desktop' };
      CURRENT.target = conf.target; // ← 重要：選択に合わせて更新
      $list.innerHTML = '<div style="padding:12px; opacity:.7">Loading...</div>';
      $overview.style.display = 'none'; $overview.innerHTML = '';
      $download.disabled = false; $upload.disabled = false; $insert.disabled = true;
      CURRENT.name = null;

      // --- Customize (App) list ---
      if (src === 'snippets') { // --- Snippets (GitHub) list ---
        const items = await loadSnippets();
        $list.innerHTML = '';
        if (!items.length) {
          $list.innerHTML = `<div style="padding:12px; opacity:.7">対象のファイルが見つかりませんでした。</div>`;
          // エディタに何かあればデプロイしたいケースもあるため、アップロードは無効化しない
          $upload.disabled = false;
          return;
        }
        setEditorLanguage('javascript');

        // Snippets表示時は常にデプロイ可能（上書き先は currentFileName を使う）
        $upload.disabled = false;

        items.forEach((f) => {
          const row = fileRow({ name: f.name, size: f.size, badge: 'SNIP' });
          row.addEventListener('click', async () => {
            const res = await fetch(f.download_url);
            const code = await res.text();

            // プレビュー
            const head = code.split('\n').slice(0, 20).join('\n');
            $overview.style.display = 'block';
            $overview.innerHTML = /* …（既存のプレビューHTMLそのまま）… */ `
              <div style="margin-top:8px; border:1px solid ${BD}; border-radius:8px; overflow:hidden;">
                <div style="padding:6px 8px; font-weight:600; ${isDark ? 'background:#101010;color:#eee;' : 'background:#f7f7f7;color:#111;'}">
                  Snippet Overview <strong>${f.name}</strong>
                </div>
                <div style="padding:8px; ${isDark ? 'background:#0f0f0f;color:#ddd;' : 'background:#fafafa;color:#333;'}">
                  <pre style="margin:0; white-space:pre-wrap; font-size:12px; line-height:1.4; max-height:180px; overflow:auto;">${escapeHtml(head)}</pre>
                </div>
              </div>`;

            // エディタへは「挿入」ボタンで追記（currentFileName はいじらない）
            //$meta.textContent = `Snippet: ${f.name}`;
            $insert.disabled = false;
            $download.disabled = false;

            $insert.onclick = () => {
              const model = editor.getModel();
              const sel = editor.getSelection();
              const pos = sel ? sel.getStartPosition() : model.getFullModelRange().getEndPosition();
              model.pushEditOperations([], [{
                range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
                text: code + '\n'
              }]);
              editor.focus();
            };
          }, { passive: true });
          $list.appendChild(row);
        });
        return;
      }

      // --- Customize (App) list: desktop/mobile × js/css 共通 ---
      const { data } = await getCustomize(appId);
      const bucket = conf.target === 'mobile' ? (data.mobile || { js: [], css: [] })
        : (data.desktop || { js: [], css: [] });
      const arr = (conf.kind === 'js' ? bucket.js : bucket.css) || [];
      const files = arr.filter(x => x.type === 'FILE');

      $list.innerHTML = '';
      if (!files.length) {
        $list.innerHTML = `<div style="padding:12px; opacity:.7">対象のファイルが見つかりませんでした。</div>`;
        return;
      }

      setEditorLanguage(conf.kind === 'js' ? 'javascript' : 'css');
      const badge = conf.target === 'mobile'
        ? (conf.kind === 'js' ? 'mJS' : 'mCSS')
        : (conf.kind === 'js' ? 'JS' : 'CSS');

      files.forEach((f, i) => {
        const row = fileRow({ name: f.file.name, size: f.file.size, badge });
        row.addEventListener('click', async () => {
          const code = await downloadByKey(f.file.fileKey);
          editor.setValue(code);
          currentFileName = f.file.name;   // 上書き先は常にこれ
          CURRENT.target = conf.target;    // 念のためクリック時にも保持
          $meta.textContent = `${i}: ${f.file.name} (${conf.target})`;
          $download.disabled = false;
          $upload.disabled = false;        // 保存+デプロイ可
          $insert.disabled = true;
        }, { passive: true });
        $list.appendChild(row);
      });
    }

    // === 保存+デプロイ（ワンボタン） ===
    // === 新規ファイルダイアログ ===
    function openNewFileDialog(defaultName, kindLabel) {
      return new Promise((resolve) => {
        const wrap = document.createElement('div');
        wrap.id = 'kt-newfile-dialog';
        wrap.style.cssText = `
          position: fixed; inset: 0; z-index: 9999;
          background: rgba(0,0,0,.35); display:flex; align-items:center; justify-content:center;
        `;

        const dark = document.documentElement.matches('[data-theme="dark"]');
        const box = document.createElement('div');
        box.style.cssText = `
          width: 480px; max-width: 92vw; border-radius: 12px;
          background: ${dark ? '#1c1c1c' : '#fff'};
          color: inherit; padding: 16px 18px; box-shadow: 0 12px 30px rgba(0,0,0,.25);
          border: 1px solid ${dark ? '#333' : '#ddd'};
        `;
        box.innerHTML = `
          <div style="font-weight:700; font-size:16px; margin-bottom:10px;">新規ファイルを作成</div>
          <div style="font-size:12px; opacity:.8; margin-bottom:8px;">
            種別: <strong>${kindLabel}</strong>
          </div>

          <label style="display:block; font-size:12px; opacity:.8; margin:6px 0 4px;">ファイル名</label>
          <input id="kt-newfile-name" type="text" value="${defaultName || ''}"
              style="display:block; width:100%; max-width:100%; box-sizing:border-box;
                  padding:8px 10px; border-radius:8px; border:1px solid #8882;
                  background:transparent; color:inherit"/>

          <div style="font-size:11px; opacity:.7; margin-top:6px;">
            拡張子が付いていない場合は、自動で <code>.js</code> または <code>.css</code> を付与します。
          </div>

          <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:16px;">
            <button id="kt-newfile-cancel" class="btn" style="height:32px; padding:0 12px;">キャンセル</button>
            <button id="kt-newfile-ok"     class="btn" style="height:32px; padding:0 14px; font-weight:600;">作成</button>
          </div>
        `;

        wrap.appendChild(box);
        document.body.appendChild(wrap);

        const $name = box.querySelector('#kt-newfile-name');
        const $ok = box.querySelector('#kt-newfile-ok');
        const $cancel = box.querySelector('#kt-newfile-cancel');

        const close = (result) => {
          wrap.remove();
          resolve(result);
        };

        $ok.addEventListener('click', () => {
          const name = ($name.value || '').trim();
          if (!name) { $name.focus(); return; }
          close(name);
        });
        $cancel.addEventListener('click', () => close(null));
        wrap.addEventListener('click', (e) => { if (e.target === wrap) close(null); });

        $name.select();
        $name.focus();
      });
    }

    // === 新規ファイル作成 ===
    $new.addEventListener('click', async () => {
      const src = $sourceSel.value;

      if (src === 'snippets') {
        alert('Snippets からは新規ファイルを作成できません。\n上部のセレクトで JavaScript / CSS を選択してください。');
        return;
      }

      const conf = SRC[src] || { kind: 'js', target: 'desktop' };
      const kindLabel = conf.target === 'mobile'
        ? (conf.kind === 'js' ? 'モバイル JS' : 'モバイル CSS')
        : (conf.kind === 'js' ? 'JS' : 'CSS');

      const defaultBase = conf.kind === 'css' ? 'custom.css' : 'custom.js';
      const inputName = await openNewFileDialog(defaultBase, kindLabel);
      if (!inputName) return; // キャンセル

      let name = inputName.trim();
      if (!name) return;

      // 拡張子自動付与
      if (conf.kind === 'js' && !/\.js$/i.test(name)) name += '.js';
      if (conf.kind === 'css' && !/\.css$/i.test(name)) name += '.css';

      CURRENT.target = conf.target;
      currentFileName = name;

      // エディタを初期化
      setEditorLanguage(conf.kind === 'js' ? 'javascript' : 'css');
      editor.setValue('');
      editor.focus();

      $meta.textContent = `新規: ${name} (${conf.target})`;
      $upload.disabled = false;   // すぐ保存＆デプロイできる
      $download.disabled = false; // ローカル保存も可能
      $insert.disabled = true;
    });

    function openUploadDialog(defaultName, fileType) {
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
          <input id="kt-up-name" type="text" value="${fileType}: ${defaultName || 'template.js'}"
              style="display:block; width:100%; max-width:100%; box-sizing:border-box;
                  padding:8px 10px; border-radius:8px; border:1px solid #8882;
                  background:transparent; color:inherit" readonly/>
            <div role="alert"
              style="margin-top:12px; font-size:12px; line-height:1.6; border:1px solid #f59e0b55; background:#f59e0b0f; border-radius:8px; padding:10px 12px;">
            <div style="font-weight:700; margin-bottom:6px;">⚠️ アップロードについて</div>
            <ul style="margin:0 0 0 18px; padding:0;">
              <li>OKボタンを押下すると、運用環境へファイルが上書きアップロードされます。</li>
              <li>アップロードする前にバックアップを取ることをおすすめします。</li>
            </ul>
          </div>
            <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:16px;">
            <button id="kt-up-cancel" class="btn" style="height:32px; padding:0 12px;">キャンセル</button>
            <button id="kt-up-ok" class="btn" style="height:32px; padding:0 14px; font-weight:600;">OK</button>
          </div>
        `;

        wrap.appendChild(box);
        document.body.appendChild(wrap);

        const $name = box.querySelector('#kt-up-name');
        const $ok = box.querySelector('#kt-up-ok');
        const $cancel = box.querySelector('#kt-up-cancel');

        const close = (result) => {
          wrap.remove();
          resolve(result);
        };

        $ok.addEventListener('click', () => {
          const name = ($name.value || '').trim();
          if (!name) { $name.focus(); return; }
          close(name);
        });
        $cancel.addEventListener('click', () => close(null));
        wrap.addEventListener('click', (e) => { if (e.target === wrap) close(null); });
        $name.select();
      });
    }
    $upload.addEventListener('click', async () => {
      try {
        Spinner.show();
        // ✅ 上書き先は必ず currentFileName を使う
        if (!currentFileName) {
          alert('上書き先のファイルが未選択です。先に「Customize」側で対象ファイルを選択してください。');
          return;
        }

        const code = editor.getValue().trim();
        if (!code) throw new Error('コードが空です');

        //ダイアログで入力
        const fileType = CURRENT.target;
        const form = await openUploadDialog(currentFileName, fileType);
        if (!form) return; // cancel

        const fileKey = await uploadOnce(currentFileName, code, getMimeByName(currentFileName));
        await putPreviewReplace(appId, 'desktop', currentFileName, fileKey);
        await deployAndWait(appId);
        alert(`✅ デプロイ完了：${currentFileName} `);
        await refreshList();
      } catch (e) {
        alert('失敗: ' + (e?.message || e));
      } finally {
        Spinner.hide();
      }
    });

    // === ダウンロード（エディタ内容を保存） ===
    $download.onclick = () => {
      const blob = new Blob([editor.getValue()], { type: getMimeByName(currentFileName || 'custom.js') });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = currentFileName || 'custom.js';
      a.click();
    };

    // === イベント ===
    $refresh.onclick = refreshList;
    $sourceSel.onchange = refreshList;

    // 初期
    await refreshList();
  }


  // ----------------------------
  // [Feature] Field Scanner
  // ----------------------------
  async function renderScanner(root, DATA) {
    const el = root.querySelector('#view-field-scanner');
    if (!el) return;
    el.innerHTML = '';

    (function FS_bootstrap() {
      // UI色
      const C = getThemeColors();
      const BG = C.bgInput;
      const BD = C.border2;
      const isDark = C.isDark;

      // ルートにCSS変数を割当（この1行で下位へ配布）
      el.innerHTML = `
        <style>
          /* 共通: Scannerタブ内のトーン統一 */
          #fs-wrap { --fs-bg: ${BG}; --fs-bd: ${BD}; }
          #fs-wrap select,
          #fs-wrap .btn {
            background: var(--fs-bg);
            color: inherit;
            border: 1px solid var(--fs-bd);
            border-radius: 8px;
            height: 32px;
            padding: 6px 10px;
            outline: none;
          }
          #fs-wrap select { padding: 4px 8px; }
          #fs-wrap .btn:hover,
          #fs-wrap select:hover { filter: brightness(${isDark ? '1.15' : '0.98'}); }
          #fs-wrap .btn:focus-visible,
          #fs-wrap select:focus-visible {
            box-shadow: 0 0 0 2px ${isDark ? '#444' : '#e5e7eb'};
          }
          #fs-wrap table thead th {
            background: var(--fs-bg) !important;
            border-bottom: 1px solid var(--fs-bd) !important;
          }
          #fs-wrap td { border-bottom: 1px solid var(--fs-bd); }
          #fs-table-wrap { border: 1px solid var(--fs-bd); border-radius: 12px; }
        </style>

        <div id="fs-wrap" style="display:flex; flex-direction:column; gap:12px;">
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <strong style="font-size:14px;">🔎 Field Scanner</strong>

            <label style="display:inline-flex; align-items:center; gap:6px; border:1px solid var(--fs-bd); padding:4px 8px; border-radius:10px;">
              <span>Target</span>
              <select id="fs-target" style="border:none;">
                <option value="both" selected>desktop + mobile</option>
                <option value="desktop">desktop only</option>
                <option value="mobile">mobile only</option>
              </select>
            </label>

            <label style="display:inline-flex; align-items:center; gap:6px; border:1px solid var(--fs-bd); padding:4px 8px; border-radius:10px;">
              <span>Kinds</span>
              <select id="fs-kinds" style="border:none;">
                <option value="js" selected>JS</option>
                <option value="css">CSS</option>
                <option value="both">JS + CSS</option>
              </select>
            </label>

            <button id="fs-scan" class="btn" style="margin-left:auto;">Scan</button>
            <div style="display:flex; gap:8px;">
              <button id="fs-copy-md"  class="btn">MD Copy</button>
              <button id="fs-dl-md"    class="btn">MD DL</button>
              <button id="fs-dl-csv"   class="btn">CSV DL</button>
              <button id="fs-dl-json"  class="btn">JSON DL</button>
            </div>
          </div>

          <div id="fs-meta" style="opacity:.8; font-size:12px;">未実行</div>

          <div id="fs-table-wrap" style="overflow:auto; max-height:56vh;">
            <table id="fs-table" style="width:100%; border-collapse:collapse;">
              <thead>
                <tr>
                  <th style="text-align:left; position:sticky; top:0; padding:8px;">Used</th>
                  <th style="text-align:left; position:sticky; top:0; padding:8px;">FieldCode</th>
                  <th style="text-align:left; position:sticky; top:0; padding:8px;">Label</th>
                  <th style="text-align:left; position:sticky; top:0; padding:8px;">Type</th>
                  <th style="text-align:right; position:sticky; top:0; padding:8px;">Matches</th>
                  <th style="text-align:left; position:sticky; top:0; padding:8px;">Files</th>
                </tr>
              </thead>
              <tbody id="fs-tbody">
                <tr><td colspan="6" style="padding:14px; opacity:.8;">Scanボタンを押してください。</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      `;

      // --- ユーティリティ（KTExport 優先で使用） ---
      const KTExport = (window.KTExport || {});
      const flashBtnText = (window.flashBtnText || function (btn, text = 'Done!', ms = 1200) {
        const old = btn.textContent;
        btn.textContent = text;
        setTimeout(() => (btn.textContent = old), ms);
      });

      // フォールバック：downloadText
      const downloadTextFallback = (name, text, mime = 'text/plain;charset=utf-8') => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: mime }));
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 0);
      };

      // KTExport が提供するAPIへ寄せる（存在しない場合はフォールバック）
      const dlText = (name, text, mime = 'text/plain;charset=utf-8') => {
        if (typeof KTExport.downloadText === 'function') return KTExport.downloadText(name, text, mime);
        // 互換：download(name, text, mime) / saveText(name, text, mime) を持つ版も許容
        if (typeof KTExport.download === 'function') return KTExport.download(name, text, mime);
        if (typeof KTExport.saveText === 'function') return KTExport.saveText(name, text, mime);
        return downloadTextFallback(name, text, mime);
      };

      const copyText = async (text) => {
        if (typeof KTExport.copyText === 'function') return await KTExport.copyText(text);
        // 互換：copy(text) があればそれを使う
        if (typeof KTExport.copy === 'function') return await KTExport.copy(text);
        // 最後の砦：Clipboard API
        await navigator.clipboard.writeText(text);
        return true;
      };

      // -----------------------------
      // Export columns（KTExport.downloadCSV / copyMD 用）
      // -----------------------------
      const FS_COLUMNS = [
        { header: 'Used', select: r => (r.used ? '1' : '0') },
        { header: 'FieldCode', select: r => r.code },
        { header: 'FieldLabel', select: r => r.label },
        { header: 'Type', select: r => r.type },
        { header: 'MatchCount', select: r => String(r.count ?? 0) },
        { header: 'Files', select: r => (Array.isArray(r.files) ? r.files.join(' | ') : '') },
      ];

      // -----------------------------
      // Markdown report（メタ込み）
      // -----------------------------
      const toMarkdownReport = (scan) => {
        const { results, files, fields, meta } = scan;
        const used = results.filter(r => r.used).length;
        const lines = [];
        lines.push(`# Field Usage Report`);
        lines.push('');
        lines.push(`- App ID: ${meta.appId}`);
        lines.push(`- Target: ${meta.include.desktop && meta.include.mobile ? 'desktop+mobile' : (meta.include.desktop ? 'desktop' : 'mobile')}`);
        lines.push(`- Kinds: ${meta.kinds.join(', ')}`);
        lines.push(`- Files: ${files.length} / Fields: ${fields.length} / Used Fields: ${used}`);
        lines.push('');

        // ここは "MD表" として出したいので、手組み（既存のまま）
        lines.push(`| Used | Code | Label | Type | Matches | Files |`);
        lines.push(`|:---:|:-----|:------|:-----|-------:|:------|`);
        for (const r of results) {
          const fileStr = (r.files || []).join('<br>');
          lines.push(`| ${r.used ? '✅' : '—'} | \`${r.code}\` | ${r.label ?? ''} | ${r.type ?? ''} | ${r.count} | ${fileStr} |`);
        }
        return lines.join('\n');
      };

      // --- DOM取得 ---
      const $target = el.querySelector('#fs-target');
      const $kinds = el.querySelector('#fs-kinds');
      const $scan = el.querySelector('#fs-scan');
      const $copyMD = el.querySelector('#fs-copy-md');
      const $dlMD = el.querySelector('#fs-dl-md');
      const $dlCSV = el.querySelector('#fs-dl-csv');
      const $dlJSON = el.querySelector('#fs-dl-json');
      const $meta = el.querySelector('#fs-meta');
      const $tbody = el.querySelector('#fs-tbody');

      let FS_last = null;

      const resolveInclude = (v) =>
        v === 'desktop' ? { desktop: true, mobile: false } :
          v === 'mobile' ? { desktop: false, mobile: true } :
            { desktop: true, mobile: true };

      const resolveKinds = (v) =>
        v === 'css' ? ['css'] : (v === 'both' ? ['js', 'css'] : ['js']);

      // ---- fields ----
      async function fetchFieldList(resp) {
        const props = resp || {};
        const out = [];
        for (const p of Object.values(props)) {
          if (p.type === 'SUBTABLE') {
            if (p.code) out.push({ code: p.code, label: p.label, type: 'SUBTABLE' });
            for (const sf of Object.values(p.fields || {})) {
              out.push({ code: sf.code, label: sf.label, type: sf.type, parent: p.code });
            }
          } else {
            out.push({ code: p.code, label: p.label, type: p.type });
          }
        }
        return out;
      }

      // ---- テキスト取得（URLは既定でスキップ、FILEのみ実体取得）----
      async function fetchTexts({ appId, include, kinds }) {
        const apiUrl = (p) => kintone.api.url(p, true);

        // preview優先 → production
        async function getCustomize(appId) {
          try {
            const prev = await kintone.api(apiUrl('/k/v1/preview/app/customize.json'), 'GET', { app: appId });
            if (prev && (prev.desktop || prev.mobile)) return prev;
          } catch { }
          return await kintone.api(apiUrl('/k/v1/app/customize.json'), 'GET', { app: appId });
        }

        async function downloadByKey(fileKey) {
          const res = await fetch(apiUrl('/k/v1/file.json') + '?fileKey=' + encodeURIComponent(fileKey), {
            method: 'GET',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
            credentials: 'same-origin'
          });
          if (!res.ok) throw new Error('Download error ' + res.status);
          return await res.text();
        }

        const data = await getCustomize(appId);
        const desk = data.desktop || { js: [], css: [] };
        const mobi = data.mobile || { js: [], css: [] };

        const pickFile = (bucket, kind) => (bucket?.[kind] || []).filter(x => x.type === 'FILE');
        const pickUrl = (bucket, kind) => (bucket?.[kind] || []).filter(x => x.url);

        const chosen = [];
        const pushKind = (bucket, target) => {
          if (kinds.includes('js')) {
            chosen.push(...pickFile(bucket, 'js').map(f => ({ target, kind: 'js', fileKey: f.file?.fileKey, name: f.file?.name })));
            chosen.push(...pickUrl(bucket, 'js').map(u => ({ target, kind: 'js', url: u.url, name: (u.url || '').split('/').pop() || u.url })));
          }
          if (kinds.includes('css')) {
            chosen.push(...pickFile(bucket, 'css').map(f => ({ target, kind: 'css', fileKey: f.file?.fileKey, name: f.file?.name })));
            chosen.push(...pickUrl(bucket, 'css').map(u => ({ target, kind: 'css', url: u.url, name: (u.url || '').split('/').pop() || u.url })));
          }
        };

        if (include.desktop) pushKind(desk, 'desktop');
        if (include.mobile) pushKind(mobi, 'mobile');

        const out = [];
        for (const t of chosen) {
          try {
            if (t.fileKey) {
              // FILEタイプは実体取得
              const text = await downloadByKey(t.fileKey);
              out.push({ name: t.name || '(no-name)', target: t.target, kind: t.kind, text });
            } else if (t.url) {
              // URLタイプは既定スキップ（CORS回避）
              // 必要なら同一オリジンのみ取得したい場合は、以下の条件をtrueにしてください。
              const sameOrigin = (() => {
                try { return new URL(t.url, location.href).hostname === location.hostname; }
                catch { return false; }
              })();

              if (sameOrigin) {
                // どうしても同一オリジンURLの中身も見たい場合のみ取得
                try {
                  const res = await fetch(t.url, { credentials: 'include' });
                  const text = res.ok ? await res.text() : '';
                  out.push({ name: t.name || t.url, target: t.target, kind: t.kind, text, note: res.ok ? undefined : 'URL fetch failed' });
                } catch (e) {
                  // エラー時も落とさず空テキストで登録
                  out.push({ name: t.name || t.url, target: t.target, kind: t.kind, text: '', note: 'URL fetch error (skipped)' });
                }
              } else {
                // 外部URLは完全にスキップ（解析はできないが、一覧表示はする）
                out.push({ name: t.name || t.url, target: t.target, kind: t.kind, text: '', note: 'external URL (skipped)' });
              }
            } else {
              out.push({ name: t.name || '(unknown)', target: t.target, kind: t.kind, text: '' });
            }
          } catch (e) {
            // いかなる場合も落とさず、空テキストで残す
            out.push({ name: t.name || '(no-name)', target: t.target, kind: t.kind, text: '', note: String(e) });
          }
        }
        return out;
      }

      // ---- analyze ----
      function stripCommentsOnly(src) {
        return src.replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
      }
      function buildRegexps(code) {
        const safe = String(code || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pats = [
          new RegExp(`['"\`]${safe}['"\`]`, 'gu'),
          new RegExp(`\\[\\s*['"\`]${safe}['"\`]\\s*\\]`, 'gu'),
          new RegExp(`getFieldElement\\(\\s*['"\`]${safe}['"\`]\\s*\\)`, 'gu'),
          new RegExp(`getFieldElements\\(\\s*['"\`]${safe}['"\`]\\s*\\)`, 'gu'),
        ];
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(code)) {
          pats.push(new RegExp(`(?<![A-Za-z0-9_$])${safe}(?![A-Za-z0-9_$])`, 'g'));
        }
        return pats;
      }
      function findMatches(text, code, regexps, { before = 24, after = 48 } = {}) {
        const arr = [];
        for (const rx of regexps) {
          let m;
          while ((m = rx.exec(text)) !== null) {
            const s = Math.max(0, m.index - before);
            const e = Math.min(text.length, m.index + m[0].length + after);
            arr.push({ index: m.index, snippet: text.slice(s, e).replace(/\n/g, '⏎') });
          }
        }
        return arr;
      }
      function analyze({ fields, files, snippet }) {
        const cleans = files.map(f => ({ ...f, clean: stripCommentsOnly(f.text || '') }));
        const results = [];
        for (const fld of fields) {
          if (!fld.code) continue;
          const rxs = buildRegexps(fld.code);
          let count = 0;
          const usedIn = [];
          const samples = [];
          for (const f of cleans) {
            if (!f.clean) continue;
            const hits = findMatches(f.clean, fld.code, rxs, snippet);
            if (hits.length) {
              count += hits.length;
              usedIn.push(`${f.target}: ${f.name}`);
              samples.push(...hits.slice(0, 2).map(h => ({ file: `${f.target}: ${f.name}`, snippet: h.snippet })));
            }
          }
          results.push({ code: fld.code, label: fld.label, type: fld.type, used: count > 0, count, files: usedIn, samples });
        }
        results.sort((a, b) => (Number(b.used) - Number(a.used)) || (b.count - a.count) || String(a.code).localeCompare(String(b.code)));
        return results;
      }

      // ---- 表示 & エクスポート ----
      function renderTable(results) {
        const rows = results.map(r => {
          const filesHtml = (r.files || []).map(s => `<div>${s}</div>`).join('');
          const samples = r.samples && r.samples.length
            ? r.samples.map(s => `
              <div style="opacity:.9; padding:4px 6px; border:1px dashed #8883; border-radius:8px; margin:3px 0;">
                <b>${s.file}</b> … ${s.snippet}
              </div>`).join('')
            : '';
          return `
            <tr>
              <td style="white-space:nowrap; padding:8px; border-bottom:1px solid ${BD};">${r.used ? '✅' : '—'}</td>
              <td style="white-space:nowrap; padding:8px; border-bottom:1px solid ${BD};"><code>${r.code}</code></td>
              <td style="padding:8px; border-bottom:1px solid ${BD};">${r.label ?? ''}</td>
              <td style="white-space:nowrap; padding:8px; border-bottom:1px solid ${BD};">${r.type ?? ''}</td>
              <td style="text-align:right; padding:8px; border-bottom:1px solid ${BD};">${r.count}</td>
              <td style="padding:8px; border-bottom:1px solid ${BD};">${filesHtml}</td>
            </tr>
            ${samples ? `<tr><td></td><td colspan="5" style="padding:6px 8px; border-bottom:1px solid ${BD};">${samples}</td></tr>` : ''}
          `;
        }).join('');
        $tbody.innerHTML = rows || `<tr><td colspan="6" style="padding:14px; opacity:.8;">結果なし</td></tr>`;
      }

      // ---- Scan 実行（初期実行なし）----
      async function scanOnce() {
        const t0 = Date.now();
        const appId = kintone.app.getId();
        const include = resolveInclude($target.value);
        const kinds = resolveKinds($kinds.value);

        const fields = await fetchFieldList(DATA.fields);
        const files = await fetchTexts({ appId, include, kinds });
        const results = analyze({ fields, files, snippet: { before: 24, after: 48 } });

        FS_last = { results, files, fields, meta: { appId, include, kinds } };
        const usedCount = results.filter(r => r.used).length;
        const dt = ((Date.now() - t0) / 1000).toFixed(2);
        $meta.textContent = `files: ${files.length} / fields: ${fields.length} / used: ${usedCount} / time: ${dt}s`;
        renderTable(results);
      }

      // ---- イベント ----
      $scan.onclick = async () => {
        $meta.textContent = 'Scanning...';
        try { await scanOnce(); } catch (e) { console.error(e); $meta.textContent = 'Scan failed'; }
      };

      $copyMD.onclick = async () => {
        if (!FS_last) return;
        const md = toMarkdownReport(FS_last);
        try {
          const ok = await copyText(md);
          flashBtnText($copyMD, ok ? 'Copied!' : 'Failed');
        } catch {
          // クリップボード失敗時は DL にフォールバック
          dlText(`field-usage-app${FS_last.meta.appId}.md`, md, 'text/markdown;charset=utf-8');
          flashBtnText($copyMD, 'Saved');
        }
      };

      $dlMD.onclick = () => {
        if (!FS_last) return;
        const md = toMarkdownReport(FS_last);
        dlText(`field-usage-app${FS_last.meta.appId}.md`, md, 'text/markdown;charset=utf-8');
        flashBtnText($dlMD);
      };

      $dlCSV.onclick = () => {
        if (!FS_last) return;
        // ✅ renderFields と同じ：KTExport.downloadCSV に統一（BOMあり）
        if (typeof KTExport.downloadCSV === 'function') {
          KTExport.downloadCSV(`field-usage-app${FS_last.meta.appId}.csv`, FS_last.results, FS_COLUMNS, { withBom: true });
          flashBtnText($dlCSV);
          return;
        }

        // フォールバック（KTExportが無い/古い場合）
        const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
        const header = FS_COLUMNS.map(c => esc(c.header)).join(',');
        const lines = FS_last.results.map(r => FS_COLUMNS.map(c => esc(c.select(r))).join(','));
        const csv = [header, ...lines].join('\n');
        dlText(`field-usage-app${FS_last.meta.appId}.csv`, csv, 'text/csv;charset=utf-8');
        flashBtnText($dlCSV);
      };

      $dlJSON.onclick = () => {
        if (!FS_last) return;
        const json = JSON.stringify(FS_last, null, 2);
        dlText(`field-usage-app${FS_last.meta.appId}.json`, json, 'application/json;charset=utf-8');
        flashBtnText($dlJSON);
      };
    })();
  }


  // ----------------------------
  // [Feature] Plugins
  // ----------------------------
  async function renderPlugins(root, DATA) {
    const view = root.querySelector('#view-plugins');
    if (!view) return;

    // ★ ここでガード
    const ok = await kintone.system.getPermissions();
    if (!ok) {
      view.innerHTML = `
        <div style="padding:12px; border:1px solid #ddd; border-radius:10px;">
          <div style="font-weight:700; margin-bottom:6px;">🔒 plug-in タブ（管理者専用）</div>
          <div style="opacity:.8; font-size:12px; line-height:1.6;">
            この機能は <b>システム管理者</b> のみ利用できます。<br/>
            ※ REST API では、UIで「利用許可されていないプラグイン」も追加できてしまうため、
            誤操作防止として制限しています。
          </div>
        </div>
      `;
      return;
    }

    const app = Number(DATA?.appId || (kintone.app?.getId?.() ?? 0));

    const installedRaw = DATA?.plugins;
    const installed =
      Array.isArray(installedRaw) ? installedRaw :
        Array.isArray(installedRaw?.plugins) ? installedRaw.plugins :
          [];

    const C = getThemeColors();
    const BG = C.bgInput;
    const BD = C.border2;
    const isDark = C.isDark;

    // 使い回しボタンCSS
    if (!document.getElementById('kt-plugins-inline-style')) {
      const st = document.createElement('style');
      st.id = 'kt-plugins-inline-style';
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
        .kt-row { border-bottom: 1px solid ${BD}; }
        .kt-row:hover { background:${isDark ? '#111' : '#fafafa'}; }
        .kt-pill { display:inline-flex; align-items:center; gap:6px; border:1px solid ${BD}; border-radius:999px; padding:2px 8px; font-size:11px; opacity:.85; }
        .kt-muted { opacity:.75; }
        .kt-danger { color:${isDark ? '#ffb4b4' : '#b00020'}; }
      `;
      document.head.appendChild(st);
    }

    if (!app) {
      view.innerHTML = `<div style="padding:12px" class="kt-danger">appId が取得できません（アプリ画面で開いてください）</div>`;
      return;
    }

    const api = (path, method, params) =>
      kintone.api(kintone.api.url(path, true), method, params);

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    async function waitDeploy(appId) {
      const maxWaitMs = 60_000, intervalMs = 1500;
      let waited = 0;
      while (true) {
        await sleep(intervalMs);
        waited += intervalMs;
        const st = await api('/k/v1/preview/app/deploy.json', 'GET', { apps: [Number(appId)] });
        const s = st?.apps?.[0]?.status;
        if (s === 'SUCCESS') return;
        if (s === 'FAIL') throw new Error('Deploy failed.');
        if (waited >= maxWaitMs) throw new Error('Deploy timeout.');
      }
    }

    // --- UI ---
    const PANEL_H = '75vh';

    view.innerHTML = `
      <div style="
        height:${PANEL_H};
        min-height:0;
        display:flex;
        gap:14px;
        align-items:stretch;
        overflow:hidden;   /* ← 外に溢れさせない */
      ">
        <div style="flex:1.15; min-width:320px; display:flex; flex-direction:column; gap:10px; min-height:0;">
          <div style="display:flex; align-items:center; justify-content:space-between;">
            <div style="font-weight:700;">App Plugins</div>
            <div class="kt-muted" style="font-size:12px;">app: <b>${app}</b></div>
          </div>

          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button id="kt-plg-reload" class="btn" style="height:32px; padding:0 12px;">↻ 再取得</button>
            <button id="kt-plg-deploy" class="btn" style="height:32px; padding:0 12px;" disabled>🚀 deploy</button>
          </div>

          <div id="kt-plg-status" style="border:1px solid ${BD}; border-radius:10px; background:${isDark ? '#0f0f0f' : '#fafafa'}; padding:10px 12px; font-size:12px;">
            読み込み中...
          </div>

          <div style="display:flex; gap:10px; min-height:0; flex:1;">
            <div style="flex:1; min-width:0; display:flex; flex-direction:column; min-height:0;">
              <div style="display:flex; align-items:center; justify-content:space-between; margin:6px 0;">
                <div style="font-weight:600;">本番</div><span class="kt-pill">prod</span>
              </div>
              <div id="kt-plg-prod" style="flex:1; min-height:0; overflow:auto; border:1px solid ${BD}; border-radius:10px; background:${BG};"></div>
            </div>
            <div style="flex:1; min-width:0; display:flex; flex-direction:column; min-height:0;">
              <div style="display:flex; align-items:center; justify-content:space-between; margin:6px 0;">
                <div style="font-weight:600;">プレビュー</div><span class="kt-pill">preview</span>
              </div>
              <div id="kt-plg-prev" style="flex:1; min-height:0; overflow:auto; border:1px solid ${BD}; border-radius:10px; background:${BG};"></div>
            </div>
          </div>

          <div id="kt-plg-diff" style="border:1px dashed ${BD}; border-radius:10px; padding:10px 12px; font-size:12px; background:${isDark ? '#101010' : '#fff'};">
            差分: -
          </div>
        </div>

        <div style="flex:1; min-width:360px; display:flex; flex-direction:column; gap:10px; min-height:0;">
          <div style="display:flex; align-items:center; justify-content:space-between;">
            <div style="font-weight:700;">Installed Plugins (Domain)</div>
            <span class="kt-pill">${installed.length}件</span>
          </div>

          <div style="display:flex; gap:8px; align-items:center;">
            <input id="kt-plg-search" placeholder="検索（名前/説明/ID）"
              style="flex:1; height:32px; padding:0 10px; border-radius:8px; border:1px solid ${BD}; background:transparent; color:inherit;" />
            <button id="kt-plg-add" class="btn" style="height:32px; padding:0 12px;" disabled>＋ previewに追加</button>
          </div>

          <div class="kt-muted" style="font-size:12px;">
            ※ previewへ追加後、deployで本番反映されます。
          </div>

          <div id="kt-plg-catalog" style="flex:1; min-height:0; overflow:auto; border:1px solid ${BD}; border-radius:10px; background:${BG};"></div>

          <div id="kt-plg-log" style="border:1px solid ${BD}; border-radius:10px; padding:10px 12px; font-size:12px; background:${isDark ? '#0f0f0f' : '#fafafa'};">
            ログ: -
          </div>
        </div>
      </div>
    `;

    const $status = view.querySelector('#kt-plg-status');
    const $prod = view.querySelector('#kt-plg-prod');
    const $prev = view.querySelector('#kt-plg-prev');
    const $diff = view.querySelector('#kt-plg-diff');

    const $reload = view.querySelector('#kt-plg-reload');
    const $deploy = view.querySelector('#kt-plg-deploy');

    const $search = view.querySelector('#kt-plg-search');
    const $add = view.querySelector('#kt-plg-add');
    const $catalog = view.querySelector('#kt-plg-catalog');
    const $log = view.querySelector('#kt-plg-log');

    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const setLog = (m) => ($log.textContent = `ログ: ${m}`);

    let prodRes = null;
    let prevRes = null;
    let selected = new Set();

    const metaMap = new Map(installed.map(p => [p.id, p]));

    function rowSimple(id) {
      const m = metaMap.get(id) || {};
      const el = document.createElement('div');
      el.className = 'kt-row';
      el.style.cssText = `padding:8px 10px; display:flex; gap:8px; align-items:center;`;
      el.innerHTML = `
      <div class="kt-pill">PLG</div>
      <div style="flex:1; min-width:0;">
        <div style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(m.name || id)}</div>
        <div class="kt-muted" style="font-size:11px;">${esc(id)}</div>
      </div>
    `;
      return el;
    }

    function renderApp() {
      const prodIds = (prodRes?.plugins || []).map(x => x.id || x).filter(Boolean);
      const prevIds = (prevRes?.plugins || []).map(x => x.id || x).filter(Boolean);

      $prod.innerHTML = '';
      $prev.innerHTML = '';
      if (!prodIds.length) $prod.innerHTML = `<div style="padding:10px 12px" class="kt-muted">（なし）</div>`;
      else prodIds.forEach(id => $prod.appendChild(rowSimple(id)));
      if (!prevIds.length) $prev.innerHTML = `<div style="padding:10px 12px" class="kt-muted">（なし）</div>`;
      else prevIds.forEach(id => $prev.appendChild(rowSimple(id)));

      const prodSet = new Set(prodIds), prevSet = new Set(prevIds);
      const onlyProd = [...prodSet].filter(x => !prevSet.has(x));
      const onlyPrev = [...prevSet].filter(x => !prodSet.has(x));

      $diff.innerHTML = `
      <div style="font-weight:700;">差分</div>
      <div class="kt-muted" style="margin-top:6px;">本番のみ: ${onlyProd.length} / previewのみ: ${onlyPrev.length}</div>
    `;

      $deploy.disabled = !(onlyProd.length || onlyPrev.length);
    }

    function renderCatalog(filterText = '') {
      const t = (filterText || '').trim().toLowerCase();
      $catalog.innerHTML = '';

      const list = installed
        .filter(p => {
          if (!t) return true;
          const hay = `${p.id} ${p.name || ''} ${p.description || ''}`.toLowerCase();
          return hay.includes(t);
        })
        .sort((a, b) => (a.name || '').localeCompare((b.name || ''), 'ja'));

      if (!list.length) {
        $catalog.innerHTML = `<div style="padding:10px 12px" class="kt-muted">該当なし</div>`;
        return;
      }

      const prevIds = new Set((prevRes?.plugins || []).map(x => x.id || x).filter(Boolean));
      const frag = document.createDocumentFragment();

      list.forEach(p => {
        const id = p.id;
        const el = document.createElement('label');
        el.className = 'kt-row';
        el.style.cssText = `display:flex; gap:10px; padding:10px 12px; align-items:flex-start; cursor:pointer;`;
        el.innerHTML = `
        <input type="checkbox" ${selected.has(id) ? 'checked' : ''} style="margin-top:3px;" />
        <div style="flex:1; min-width:0;">
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <div style="font-weight:600;">${esc(p.name || '(no name)')}</div>
            ${p.version ? `<span class="kt-pill">v${esc(p.version)}</span>` : ''}
            ${prevIds.has(id) ? `<span class="kt-pill">IN PREVIEW</span>` : ''}
          </div>
          <div class="kt-muted" style="font-size:12px; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${esc(p.description || '')}
          </div>
          <div class="kt-muted" style="font-size:11px; margin-top:4px;">id: ${esc(id)}</div>
        </div>
      `;
        const $cb = el.querySelector('input');
        el.addEventListener('click', (e) => {
          if (e.target !== $cb) $cb.checked = !$cb.checked;
          if ($cb.checked) selected.add(id);
          else selected.delete(id);
          $add.disabled = selected.size === 0;
        });
        frag.appendChild(el);
      });

      $catalog.appendChild(frag);
    }

    async function reload() {
      try {
        setLog('読み込み中...');
        $status.textContent = '読み込み中...';

        prodRes = await api('/k/v1/app/plugins.json', 'GET', { app });
        prevRes = await api('/k/v1/preview/app/plugins.json', 'GET', { app });

        $status.innerHTML = `
        <div>本番: <b>${(prodRes?.plugins || []).length}</b> / preview: <b>${(prevRes?.plugins || []).length}</b></div>
        <div class="kt-muted" style="margin-top:6px;">右の一覧から preview に追加 → deploy</div>
      `;

        renderApp();
        renderCatalog($search.value || '');
        setLog('OK');
      } catch (e) {
        console.error(e);
        $status.innerHTML = `<div class="kt-danger">取得に失敗: ${esc(e?.message || e)}</div>`;
        setLog(`NG: ${e?.message || e}`);
      }
    }

    // events
    $search.addEventListener('input', () => renderCatalog($search.value || ''), { passive: true });
    $reload.addEventListener('click', reload);

    $add.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const ids = [...selected];
        if (!ids.length) return;

        // 既にpreviewにあるものは除外
        const prevIds = new Set((prevRes?.plugins || []).map(x => x.id || x).filter(Boolean));
        const toAdd = ids.filter(id => !prevIds.has(id));
        if (!toAdd.length) { setLog('追加対象なし（全てpreviewに存在）'); return; }

        setLog(`previewに追加中... (${toAdd.length})`);
        await api('/k/v1/preview/app/plugins.json', 'POST', { app, ids: toAdd });

        // preview再取得
        prevRes = await api('/k/v1/preview/app/plugins.json', 'GET', { app });

        selected.clear();
        renderApp();
        renderCatalog($search.value || '');

        setLog(`previewに追加しました: ${toAdd.length}件`);
      } catch (e) {
        console.error(e);
        setLog(`NG: ${e?.message || e}`);
        alert(`❌ 追加に失敗: ${e?.message || e}`);
      } finally {
        $add.disabled = selected.size === 0;
      }
    });

    $deploy.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        setLog('deploy開始...');
        await api('/k/v1/preview/app/deploy.json', 'POST', { apps: [{ app, revision: -1 }], revert: false });
        await waitDeploy(app);

        await reload();
        setLog('✅ deploy完了');
        alert('✅ deploy完了（preview→本番）');
      } catch (e) {
        console.error(e);
        setLog(`NG: ${e?.message || e}`);
        alert(`❌ deploy失敗: ${e?.message || e}`);
      } finally {
        // reloadで差分判定されるのでここでは触らない
      }
    });

    // init
    await reload();
  }


  // ----------------------------
  // [Feature] Links
  // ----------------------------
  const LINKS_CONFIG = {
    locale: 'ja',
    categories: ['Official', 'Community', 'Docs', 'Tools', 'Blog/Note', 'Library'],
    tags: ['kintone', 'API', 'Customize', 'Plugin', 'Design', 'Mermaid', 'REST', 'JS', 'CSV', 'ZIP'],

    items: [
      // --- Official ---
      {
        title: 'kintone developer network',
        url: 'https://cybozu.dev/ja/kintone/',
        category: 'Official',
        desc: '公式ドキュメント・サンプル・最新情報',
        tags: ['kintone', 'Docs', 'API']
      },
      {
        title: 'Cybozu Developer Network (日本語)',
        url: 'https://cybozu.dev/ja/',
        category: 'Official',
        desc: 'Cybozu Dev 全体（日本語）',
        tags: ['Docs']
      },

      // --- Community ---
      {
        title: 'kintone developer community',
        url: 'https://community.cybozu.dev/',
        category: 'Community',
        desc: '日本語フォーラム',
        tags: ['Community']
      },
      {
        title: 'Qiita: kintone タグ',
        url: 'https://qiita.com/tags/kintone',
        category: 'Community',
        desc: '日本の技術記事コミュニティ',
        tags: ['Community']
      },

      // --- Docs ---
      {
        title: 'REST API Reference',
        url: 'https://cybozu.dev/ja/kintone/docs/rest-api/',
        category: 'Docs',
        desc: 'kintone REST API 一覧',
        tags: ['REST', 'API', 'Docs']
      },
      {
        title: 'JavaScript API Reference',
        url: 'https://cybozu.dev/ja/kintone/docs/js-api/',
        category: 'Docs',
        desc: 'kintone JavaScript API',
        tags: ['JS', 'API', 'Docs']
      },

      // --- Tools ---
      {
        title: 'Toolkit (GitHub)',
        url: 'https://github.com/youtotto/kintone-app-toolkit',
        category: 'Tools',
        desc: '本スクリプトのリポジトリ',
        tags: ['Customize', 'Tools']
      },
      {
        title: 'Mermaid Live Editor',
        url: 'https://mermaid.live/',
        category: 'Tools',
        desc: 'Mermaid図の編集・プレビュー',
        tags: ['Mermaid', 'Design']
      },

      // --- Blog/Note ---
      {
        title: 'Note: kintone タグ',
        url: 'https://note.com/hashtag/kintone',
        category: 'Blog/Note',
        desc: 'kintone活用記事',
        tags: ['Blog/Note']
      },

      // --- Library ---
      {
        title: 'kintone UI Component',
        url: 'https://ui-component.kintone.dev/ja/',
        category: 'Library',
        desc: 'kintone向けUIコンポーネント（KUC）',
        tags: ['kintone', 'Design']
      },
      {
        title: 'SweetAlert2',
        url: 'https://sweetalert2.github.io/',
        category: 'Library',
        desc: 'ダイアログUI（定番）',
        tags: ['Design']
      },
      {
        title: 'FileSaver.js',
        url: 'https://github.com/eligrey/FileSaver.js',
        category: 'Library',
        desc: 'ブラウザでファイル保存',
        tags: ['download']
      },
      {
        title: 'SortableJS',
        url: 'https://sortablejs.github.io/Sortable/',
        category: 'Library',
        desc: 'ドラッグ＆ドロップ並べ替え',
        tags: ['UI']
      },
      {
        title: 'holiday_jp-js',
        url: 'https://github.com/holiday-jp/holiday_jp-js',
        category: 'Library',
        desc: '日本の祝日カレンダー',
        tags: ['date', 'jp']
      }
    ]
  };

  // LocalStorageキー
  const LINKS_LS_KEYS = {
    category: 'kat_links_category',
    tag: 'kat_links_tag'
  };

  function renderLinks(root) {
    // ガード
    const el = root.querySelector('#view-links');
    if (!el) return;

    // UI色の取得
    const C = getThemeColors();
    const isDark = C.isDark;

    // 既存クリア
    el.innerHTML = '';

    // ----- 状態（検索・カテゴリ・タグ） -----
    const state = {
      category: localStorage.getItem(LINKS_LS_KEYS.category) || 'All',
      tag: localStorage.getItem(LINKS_LS_KEYS.tag) || 'All'
    };

    // ----- ユーティリティ -----
    const h = (html) => {
      const div = document.createElement('div');
      div.innerHTML = html.trim();
      return div.firstElementChild;
    };

    // ----- ヘッダUI（配色を共通変数へ） -----
    const categories = ['All', ...LINKS_CONFIG.categories];
    const tags = ['All', ...LINKS_CONFIG.tags];

    const $header = h(`
      <div style="
        display:flex; gap:8px; align-items:center; margin-bottom:12px;
        justify-content:flex-end; flex-wrap:wrap;
      ">
        <select id="links-category"
          style="padding:8px 10px; border-radius:8px; border:1px solid ${C.border}; background:${C.bgInput}; color:${C.text};">
          ${categories.map(c => `<option ${c === state.category ? 'selected' : ''} value="${c}" style="background:${C.bgInput}; color:${C.text};">${c}</option>`).join('')}
        </select>
        <select id="links-tag"
          style="padding:8px 10px; border-radius:8px; border:1px solid ${C.border}; background:${C.bgInput}; color:${C.text};">
          ${tags.map(t => `<option ${t === state.tag ? 'selected' : ''} value="${t}" style="background:${C.bgInput}; color:${C.text};">${t}</option>`).join('')}
        </select>
      </div>
    `);

    // option配色のテーマ適用
    if (!document.getElementById('kat-links-select-theme')) {
      document.head.insertAdjacentHTML('beforeend', `
        <style id="kat-links-select-theme">
          #links-category:focus, #links-tag:focus { outline:none; box-shadow:0 0 0 2px ${isDark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.05)'} inset; }
        </style>
      `);
    }

    const $cat = $header.querySelector('#links-category');
    const $tag = $header.querySelector('#links-tag');

    $cat.addEventListener('change', () => {
      state.category = $cat.value;
      localStorage.setItem(LINKS_LS_KEYS.category, state.category);
      renderList();
    });
    $tag.addEventListener('change', () => {
      state.tag = $tag.value;
      localStorage.setItem(LINKS_LS_KEYS.tag, state.tag);
      renderList();
    });

    el.appendChild($header);

    // ----- リスト本体 -----
    const $list = h(`<div id="links-list" style="display:grid; gap:10px;"></div>`);
    el.appendChild($list);

    // カード生成（枠線やバッジの色を調整）
    function card(item) {
      const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(item.url)}&sz=64`;
      const $c = h(`
        <div class="link-card" style="
          border:1px solid ${C.border}; border-radius:12px; padding:12px; 
          display:flex; gap:12px; align-items:flex-start;
          min-height: 84px;
          background: ${isDark ? 'rgba(255,255,255,.03)' : 'transparent'};
          ">
          <img src="${favicon}" alt="" width="20" height="20" style="margin-top:2px; border-radius:4px;" />
          <div style="flex:1 1 auto; min-width:0;">
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <a href="${item.url}" target="_blank" rel="noopener" 
                style="font-weight:700; text-decoration:none; color:${C.text};">${item.title}</a>
              <span style="font-size:11px; opacity:.7; padding:2px 6px; border:1px solid ${C.border}; border-radius:999px; color:${C.text};">
                ${item.category}
              </span>
              ${(item.tags || []).slice(0, 5).map(t => `
                <span style="font-size:10px; opacity:.6; padding:2px 6px; border:1px dashed ${C.border}; border-radius:999px; color:${C.text};">#${t}</span>
              `).join('')}
            </div>
            <div style="font-size:12px; opacity:.85; margin-top:4px; color:${C.text};">${item.desc || ''}</div>
          </div>
        </div>
      `);
      return $c;
    }

    // --- (renderList 以下のロジックは変更なしのため省略可能ですが、色の反映を確実にします) ---
    function renderList() {
      $list.innerHTML = '';
      $list.style.gridTemplateColumns = `repeat(auto-fill, minmax(280px, 1fr))`;

      const q = (state.search || '').toLowerCase();
      const filtered = LINKS_CONFIG.items.filter(item => {
        const catOK = (state.category === 'All') || (item.category === state.category);
        const tagOK = (state.tag === 'All') || ((item.tags || []).includes(state.tag));
        const text = [item.title, item.desc, item.url, item.category, ...(item.tags || [])].join(' ').toLowerCase();
        return catOK && tagOK && (!q || text.includes(q));
      });

      const groups = {};
      for (const c of ['All', ...LINKS_CONFIG.categories]) groups[c] = [];
      for (const it of filtered) groups[it.category]?.push(it);

      LINKS_CONFIG.categories.forEach(cat => {
        const arr = groups[cat];
        if (!arr || arr.length === 0) return;
        const $sec = h(`
          <section>
            <h3 style="margin:12px 4px 6px; font-size:13px; opacity:.8; color:${C.text};">${cat}</h3>
            <div class="links-cat" style="display:grid; gap:10px;"></div>
          </section>
        `);
        const $wrap = $sec.querySelector('.links-cat');
        $wrap.style.gridTemplateColumns = `repeat(auto-fill, minmax(280px, 1fr))`;
        arr.forEach(item => $wrap.appendChild(card(item)));
        $list.appendChild($sec);
      });

      if (filtered.length === 0) {
        $list.appendChild(h(`<div style="opacity:.7; font-size:12px; color:${C.text};">該当するリンクがありません。</div>`));
      }
      normalizeHeights();
    }

    renderList();

    // (以下、normalizeHeights と resize イベント処理は既存と同じ)
    function normalizeHeights() {
      $list.querySelectorAll('.link-card').forEach(c => (c.style.height = 'auto'));
      $list.querySelectorAll('section .links-cat').forEach(cat => {
        const cards = [...cat.children].filter(el => el.classList.contains('link-card'));
        if (cards.length < 2) return;
        const max = Math.max(...cards.map(c => c.getBoundingClientRect().height));
        cards.forEach(c => (c.style.height = `${Math.ceil(max)}px`));
      });
    }

    window.addEventListener('resize', normalizeHeights);
  }


  // ==========================================
  // 6. メイン実行処理 (Entry Point)
  // ==========================================
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
    renderHealth(root, pick(DATA, [
      'appId', 'fields', 'status', 'views', 'reports', 'customize',
      'generalNotify', 'perRecordNotify', 'reminderNotify',
      'appAcl', 'recordAcl', 'fieldAcl',
      'actions', 'plugins'
    ]));
    renderFields(root, { ...pick(DATA, ['appId', 'fields', 'layout']), usageData: DATA });
    renderViews(root, pick(DATA, ['appId', 'views', 'fields']));
    renderGraphs(root, pick(DATA, ['appId', 'reports', 'fields']));
    renderRelations(root, relations, appId);
    renderNotifications(root, pick(DATA, [
      'appId',
      'generalNotify',
      'perRecordNotify',
      'reminderNotify',
    ]));
    renderAcl(root, pick(DATA, [
      'appId',
      'appAcl',
      'recordAcl',
      'fieldAcl',
    ]));
    renderCustomize(root, DATA, appId);
    renderTemplates(root, DATA, appId);
    renderScanner(root, pick(DATA, ['appId', 'fields', 'customize']));
    renderPlugins(root, pick(DATA, ['appId', 'plugins']));
    renderLinks(root);

  });

})();
