// ==UserScript==
// @name         kintone App Toolkit
// @namespace    https://github.com/youtotto/kintone-app-toolkit
// @version      2.2.6
// @description  kintoneアプリの構造・依存関係・変更影響をブラウザ上で分析。フィールドの利用箇所、JS解析、アプリ間連携、設定の整合性チェックまで対応した開発支援ツールキット。
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
  const SCRIPT_VERSION = '2.2.6';
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
    // Notion向け：セル内改行は潰す（<br>使わない）
    const mdEscNotion = (v = '') => String(v ?? '')
      .replace(/\r?\n/g, ' / ')       // ★改行は区切りに変換
      .replace(/\s+/g, ' ')           // ★連続空白を潰したいなら（任意）
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/`/g, '\\`');

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

    function toMarkdownString(rows, columns, { esc = mdEscNotion } = {}) {
      const headers = columns.map(c => esc(c.header));
      const matrix = rows.map(r => columns.map(c => {
        const raw = c.select ? c.select(r) : r[c.key];
        // mdフォーマット関数があるなら優先、最後にesc
        const v = c.md ? c.md(raw, r) : raw;
        return esc(v);
      }));

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
      return copyText(toMarkdownString(rows, columns, { esc: mdEscNotion }));
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
  // ★B7修正
  //  (1) 既存のloaderが「読み込み済み」の場合、loadイベントは二度と発火しないため
  //      Promiseが永久に解決しなかった。window.require の有無で判定するよう変更。
  //  (2) 失敗時に __monaco_loading__ が残り、以降ずっと再試行できなかった問題を修正。
  const MONACO_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.36.1/min/vs';
  window.loadMonaco = async function loadMonaco() {
    if (window.monaco) return window.monaco; // 既にロード済
    if (window.__monaco_loading__) return window.__monaco_loading__; // 読み込み中Promise共有

    const p = new Promise((resolve, reject) => {
      // loader.js の読み込み完了後に monaco 本体を require する
      const requireMonaco = () => {
        try {
          if (typeof window.require !== 'function') {
            reject(new Error('Monaco loader is not available'));
            return;
          }
          window.require.config({ paths: { vs: MONACO_BASE } });
          window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
        } catch (e) {
          reject(e);
        }
      };

      const existing = document.querySelector('script[data-monaco-loader]');
      if (existing) {
        // 既に読み込み完了していれば load は発火しないので、require の有無で判定する
        if (typeof window.require === 'function') { requireMonaco(); return; }
        existing.addEventListener('load', requireMonaco, { once: true });
        existing.addEventListener('error', () => reject(new Error('Monaco loader failed to load')), { once: true });
        return;
      }

      const s = document.createElement('script');
      s.src = `${MONACO_BASE}/loader.min.js`;
      s.setAttribute('data-monaco-loader', 'true');
      s.addEventListener('load', requireMonaco, { once: true });
      s.addEventListener('error', () => reject(new Error('Monaco loader failed to load')), { once: true });
      document.head.appendChild(s);
    });

    // 失敗した場合は共有Promiseを破棄し、次回の呼び出しで再試行できるようにする
    p.catch(() => {
      if (window.__monaco_loading__ === p) window.__monaco_loading__ = null;
    });

    window.__monaco_loading__ = p;
    return p;
  };

  let monacoEditor = null;
  // ★レイアウト修正：Templates/Customize で同名IDを使っていたため、document全体からの
  //   getElementById をやめ、呼び出し側からホスト要素を受け取る（Templatesタブにスコープ）。
  //   高さは親のflexレイアウト（ホスト要素の .kt-flex-fill: flex:1; min-height:0）に任せる。
  //   ResizeObserver / resizeリスナーは再生成時に前回分を破棄し、多重登録を防ぐ。
  let monacoEditorResizeCleanup = null;
  async function initEditor(initialCode = '', hostEl = null) {
    const monaco = await loadMonaco();
    // JSバリデーション（構文/セマンティック）をON
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSyntaxValidation: false,
      noSemanticValidation: false,
    });
    const el = hostEl || document.getElementById('kt-template-editor');
    if (!el) throw new Error('editor host element not found');

    // 前回分（observer/リスナー/エディタ）を破棄してから作り直す
    if (typeof monacoEditorResizeCleanup === 'function') { try { monacoEditorResizeCleanup(); } catch { } }
    monacoEditorResizeCleanup = null;
    if (monacoEditor) { try { monacoEditor.dispose(); } catch { } monacoEditor = null; }

    const editor = monaco.editor.create(el, {
      value: initialCode,
      language: 'javascript',
      theme: getThemeColors().isDark ? 'vs-dark' : 'vs',
      automaticLayout: true,
      fontSize: 12,
      minimap: { enabled: false },
      wordWrap: 'on',
    });
    monacoEditor = editor;

    // 🔽 サイズ変化に確実に追従させる（automaticLayout の保険。全画面切替/タブ切替直後など）
    const relayout = () => { try { if (monacoEditor === editor) editor.layout(); } catch { } };
    const ro = new ResizeObserver(relayout);
    ro.observe(el);
    window.addEventListener('resize', relayout);
    monacoEditorResizeCleanup = () => {
      try { ro.disconnect(); } catch { }
      window.removeEventListener('resize', relayout);
    };

    // タブ切替直後の遅延レイアウト（描画完了後に1回）
    setTimeout(relayout, 0);

    return editor;
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

  // ==========================================
  // 2.2 kintone REST 共通クライアント (KTApi)
  //  - Customize / Templates / Field Scanner / Plugins に散在していた
  //    getCustomize・downloadByKey・uploadOnce・waitDeploy を一本化する
  //  - preview（動作テスト環境）と production（運用環境）の区別を明示する
  // ==========================================
  const KTApi = (() => {
    const url = (p) => kintone.api.url(p, true);
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    /**
     * カスタマイズ設定を取得する
     * @param {boolean} opt.preferPreview true(既定)ならpreviewを優先し、無ければproductionを返す
     * @returns {{source:'preview'|'production', data:object}} どちらを取得したかを必ず返す
     */
    async function getCustomize(app, { preferPreview = true } = {}) {
      if (preferPreview) {
        try {
          const prev = await kintone.api(url('/k/v1/preview/app/customize.json'), 'GET', { app });
          if (prev && (prev.desktop || prev.mobile)) return { source: 'preview', data: prev };
        } catch (e) {
          // preview取得不可（権限不足など）はproductionへフォールバックする
          console.warn('[KTApi] preview customize の取得に失敗しました。production を使用します', e);
        }
      }
      const prod = await kintone.api(url('/k/v1/app/customize.json'), 'GET', { app });
      return { source: 'production', data: prod };
    }

    /** fileKey からファイル本文をテキストで取得する */
    async function downloadFile(fileKey) {
      const res = await fetch(url('/k/v1/file.json') + '?fileKey=' + encodeURIComponent(fileKey), {
        method: 'GET',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`file download failed: ${res.status}`);
      return await res.text();
    }

    /** テキストをアップロードして fileKey を得る */
    async function uploadFile(name, content, mime) {
      const fd = new FormData();
      try { fd.append('__REQUEST_TOKEN__', kintone.getRequestToken()); } catch (e) { }
      fd.append('file', new Blob([content], { type: mime }), name);
      const res = await fetch(url('/k/v1/file.json'), {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin',
        body: fd,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`file upload failed: ${res.status} ${detail}`);
      }
      const { fileKey } = await res.json();
      return fileKey;
    }

    /** previewのカスタマイズ設定を更新する（運用環境には反映されない） */
    async function putPreviewCustomize(app, payload) {
      return await kintone.api(url('/k/v1/preview/app/customize.json'), 'PUT', payload);
    }

    /** previewの内容を運用環境へデプロイする（戻り値は無し。完了待ちは waitDeploy） */
    async function deploy(app) {
      return await kintone.api(url('/k/v1/preview/app/deploy.json'), 'POST',
        { apps: [{ app: Number(app), revision: -1 }], revert: false });
    }

    /** デプロイ完了を待つ（SUCCESS/PROCESSEDで正常終了、FAIL系は例外） */
    async function waitDeploy(app, { pollMs = 1500, timeoutMs = 60000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await wait(pollMs);
        const st = await kintone.api(url('/k/v1/preview/app/deploy.json'), 'GET', { apps: [Number(app)] });
        const s = st?.apps?.[0]?.status;
        if (s === 'SUCCESS' || s === 'PROCESSED') return s;
        if (s === 'FAIL' || s === 'FAILED' || s === 'CANCEL') throw new Error(`Deploy failed: ${s}`);
      }
      throw new Error('Deploy timeout');
    }

    /**
     * 複数アプリの基本情報（名前など）をまとめて取得する
     * - /k/v1/apps.json は1回の呼び出しで複数アプリを取得できる（最大100件）
     * - 閲覧権限が無いアプリは結果に含まれない → 名称は解決できないものとして扱う
     * @returns {Map<string,string>} appId -> アプリ名
     */
    // アプリ名のキャッシュ（アプリ名は頻繁には変わらないため、再訪時のAPI呼び出しを避ける）
    const APP_NAME_CACHE_KEY = 'ktAppNames.v1';
    const APP_NAME_TTL_MS = 24 * 60 * 60 * 1000; // 24時間

    function loadAppNameCache() {
      try {
        const raw = localStorage.getItem(APP_NAME_CACHE_KEY);
        const obj = raw ? JSON.parse(raw) : {};
        return (obj && typeof obj === 'object') ? obj : {};
      } catch (e) {
        return {}; // 壊れたキャッシュは無視する
      }
    }
    function saveAppNameCache(cache) {
      try { localStorage.setItem(APP_NAME_CACHE_KEY, JSON.stringify(cache)); }
      catch (e) { console.warn('[KTApi] アプリ名キャッシュの保存に失敗しました', e); }
    }

    async function getAppNames(ids) {
      const list = [...new Set((ids || []).map(String).filter(v => /^\d+$/.test(v)))];
      const map = new Map();
      if (!list.length) return map;

      // 1) キャッシュから引けるものは先に埋め、APIに問い合わせるIDを減らす
      const cache = loadAppNameCache();
      const now = Date.now();
      const missing = [];
      for (const id of list) {
        const c = cache[id];
        if (c && c.name && (now - (c.at || 0)) < APP_NAME_TTL_MS) map.set(id, c.name);
        else missing.push(id);
      }
      if (!missing.length) return map;

      // 2) 不足分だけAPIで取得する
      const before = map.size;
      for (let i = 0; i < missing.length; i += 100) {
        const chunk = missing.slice(i, i + 100).map(Number);
        try {
          const res = await kintone.api(url('/k/v1/apps.json'), 'GET', { ids: chunk });
          for (const a of res?.apps || []) {
            if (a?.appId != null && a?.name) {
              map.set(String(a.appId), a.name);
              cache[String(a.appId)] = { name: a.name, at: now };
            }
          }
        } catch (e) {
          // 権限不足などは致命的ではない。解決できなかったIDは呼び出し側で「取得不可」として扱う
          console.warn('[KTApi] アプリ名の取得に失敗しました', e);
        }
      }
      if (map.size > before) saveAppNameCache(cache);
      return map;
    }

    /**
     * 同一ドメインのアプリ一覧を取得する（閲覧できるアプリのみ返る）
     * 1回あたり最大100件のため、必要な分だけページングする
     */
    async function getAppList({ max = 500 } = {}) {
      const out = [];
      for (let offset = 0; offset < max; offset += 100) {
        const res = await kintone.api(url('/k/v1/apps.json'), 'GET', { limit: 100, offset });
        const apps = res?.apps || [];
        out.push(...apps);
        if (apps.length < 100) break;
      }
      return out;
    }

    /**
     * 指定アプリのフィールド設定を取得する（運用環境）
     * レコード閲覧権限があれば取得できる（アプリ管理権限は不要）
     */
    async function getFormFieldsOf(appId) {
      return await kintone.api(url('/k/v1/app/form/fields.json'), 'GET', { app: Number(appId) });
    }

    /** 指定アプリのアクション設定を取得する（アプリ管理権限が必要） */
    async function getActionsOf(appId) {
      return await kintone.api(url('/k/v1/app/actions.json'), 'GET', { app: Number(appId) });
    }

    /** アプリのURL（同一ドメイン内のアプリへのリンク用） */
    function appUrl(appId) {
      return `${location.origin}/k/${encodeURIComponent(String(appId))}/`;
    }

    /** デプロイして完了まで待つ */
    async function deployAndWait(app, opt = {}) {
      await deploy(app);
      return await waitDeploy(app, opt);
    }

    return { url, wait, getCustomize, downloadFile, uploadFile, putPreviewCustomize, deploy, waitDeploy, deployAndWait, getAppNames, appUrl,
      getAppList, getFormFieldsOf, getActionsOf };
  })();

  // カスタマイズデプロイ用（後方互換のための薄いラッパ。実体は KTApi.uploadFile）
  async function uploadOnce(name, content, mime) {
    return await KTApi.uploadFile(name, content, mime);
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
      fieldsRaw, layoutRaw, views, reports, status, generalNotify, perRecordNotify, reminderNotify,
      customize, appAcl, recordAcl, fieldAcl, actions, plugins, settings, appPlugins,
    ] = await Promise.all([
      // フォーム定義はJS APIで取得する。
      //   これらは REST の properties / layout と同等の値を返し、
      //   RESTと違ってアプリ管理権限を必要としない（一般ユーザーでも動作する）。
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
      // アプリ名・説明（他の取得と並列なので追加のラウンドトリップは発生しない）
      opt(api('/k/v1/app/settings')),
      // このアプリに追加されているプラグイン（/k/v1/plugins はドメイン全体の一覧なので別途取得する）
      opt(api('/k/v1/app/plugins')),
    ]);

    // 戻り値の形をならす。
    //   fields : properties 相当のオブジェクト（{ properties: {...} } 形式で来た場合にも対応）
    //   layout : layout 相当の配列（{ layout: [...] } 形式で来た場合にも対応）
    const fields = (fieldsRaw && typeof fieldsRaw === 'object' && fieldsRaw.properties)
      ? fieldsRaw.properties
      : (fieldsRaw || {});
    const layout = Array.isArray(layoutRaw)
      ? layoutRaw
      : (Array.isArray(layoutRaw?.layout) ? layoutRaw.layout : []);

    // 生データを読み取り専用で返す（派生計算は別レイヤで）
    return Object.freeze({
      appId,
      fields,     // kintone.app.getFormFields()（REST form/fields の properties 相当）
      layout,     // kintone.app.getFormLayout()（REST form/layout の layout 相当。グループ・要素IDを含む）
      views,      // /k/v1/app/views               （null可）
      reports,    // /k/v1/app/reports             （null可）
      status,     // /k/v1/app/status              （null可）
      generalNotify,    // /k/v1/app/notifications/general
      perRecordNotify,  // /k/v1/app/notifications/perRecord
      reminderNotify,   // /k/v1/app/notifications/reminder
      customize,  // /k/v1/app/customize           （null可）
      settings, // /k/v1/app/settings（アプリ名・説明・アイコン等。null可）
      appPlugins, // /k/v1/app/plugins（このアプリに追加されているプラグイン。null可）
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
        // ★Details拡充用（v2.2.1）：APIが返す場合のみ保持する（無ければ空。推測はしない）
        filterCond: f.lookup?.filterCond ?? '',
        sort: f.lookup?.sort ?? '',
        raw: f.lookup ?? null,   // Raw設定JSON表示用
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
        // ★Details拡充用（v2.2.1）：APIが返す場合のみ保持する（無ければ空。推測はしない）
        filterCond: f.referenceTable?.filterCond ?? '',
        size: f.referenceTable?.size ?? null,
        raw: f.referenceTable ?? null,   // Raw設定JSON表示用
      }));

    // ---- Actions（srcField→destField 文字列で保存）----
    const actions = actionsResp?.actions
      ? Object.entries(actionsResp.actions).map(([key, a], i) => {
        const dest = a?.destApp || a?.toApp || {};

        // ★変更：表示用HTML（<br>結合）ではなくプレーン文字列の配列で保持する
        //   （HTML化とエスケープは renderRelations 側で行う。エスケープ漏れ対策）
        const mappings = (a?.mappings || a?.mapping || [])
          .map(m => {
            const left = m?.srcField ?? (m?.srcType || ''); // srcFieldが無ければsrcType
            const right = m?.destField ?? '';
            return `${left || '—'} → ${right || '—'}`;
          });

        const entities = Array.isArray(a?.entities)
          ? a.entities.map(e => ({ type: e?.type ?? null, code: e?.code ?? null }))
          : [];

        return {
          id: a?.id ?? key,
          name: a?.name ?? key,
          toAppId: dest?.app ?? null,
          toAppCode: dest?.code ?? null,
          mappings,                 // ← プレーン文字列の配列（例: ["数値_0 → 数値_0", "RECORD_URL → リンク_0"]）
          // ★追加：APIレスポンスに enabled があれば真偽値、無ければ null（不明）として保持
          enabled: (typeof a?.enabled === 'boolean') ? a.enabled : null,
          entities,
          filterCond: a?.filterCond ?? '',
          // ★Details拡充用（v2.2.1）：構造化マッピング（自アプリ srcField/srcType → 接続先 destField）
          mappingsDetail: (a?.mappings || a?.mapping || []).map(m => ({
            srcType: m?.srcType ?? null,
            srcField: m?.srcField ?? null,
            destField: m?.destField ?? null,
          })),
          raw: a ?? null,   // Raw設定JSON表示用
        };
      })
      : [];


    return { lookups, relatedTables, actions };
  }


  // ==========================================
  // 2.4 JavaScript自動解析の共通基盤 (KTScan)
  //  - Field Scannerタブを開かなくても依存関係にJS情報が入るようにする
  //  - API取得回数を増やさないため、結果をLocalStorageにキャッシュする
  // ==========================================
  const KTScan = (() => {
    const CACHE_PREFIX = 'ktScanCache.v1.';
    // ★解析ロジックのバージョン。
    //   解析内容（検出パターン・保存する項目）を変更したら必ず上げること。
    //   これを署名に含めないと、Toolkit更新後も古い解析結果が使われ続ける。
    const ANALYZER_VERSION = '13'; // 解析ロジックを変更したら上げる（キャッシュが自動的に無効になる）
    const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6時間（プレビュー編集を拾えないため長くしすぎない）

    // Scannerタブが登録する実行関数（renderScannerから設定される）
    let runner = null;
    // 'idle' | 'running' | 'done' | 'cached' | 'skipped' | 'error'
    let state = 'idle';
    let lastError = null;
    let scannedAt = null;
    // 状態変化の通知先（Fields/Relationsの再描画などに使う）
    const listeners = new Set();

    const notify = () => { for (const fn of listeners) { try { fn(getStatus()); } catch (e) { console.error(e); } } };

    const setState = (s, opt = {}) => {
      state = s;
      if ('error' in opt) lastError = opt.error;
      if ('at' in opt) scannedAt = opt.at;
      notify();
    };

    const getStatus = () => ({ state, lastError, scannedAt, available: !!runner });
    const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
    // 直近の解析 payload（Scanner タブが applyScanResult で登録。AI向けドキュメント等、他タブが参照する）
    let lastPayload = null;
    const setLastPayload = (p) => { lastPayload = p || null; };
    const getLastPayload = () => lastPayload;

    /** Scannerタブが自身のscan関数を登録する */
    const register = (fn) => { runner = fn; notify(); };

    /**
     * 解析を実行する
     * @param {object} opt.force trueならキャッシュを無視して再取得する
     * @param {object} opt.silent trueならScannerタブのUI更新を最小限にする
     */
    const run = async (opt = {}) => {
      if (!runner) return { ok: false, reason: 'scanner-not-ready' };
      if (state === 'running') return { ok: false, reason: 'already-running' };
      setState('running');
      try {
        const res = await runner(opt);
        setState(res?.fromCache ? 'cached' : 'done', { at: res?.scannedAt || new Date().toISOString(), error: null });
        return { ok: true, ...res };
      } catch (e) {
        console.error('[KTScan] JavaScript解析に失敗しました', e);
        setState('error', { error: e?.message || String(e) });
        return { ok: false, reason: 'error', error: e };
      }
    };

    // ---- キャッシュ ----
    // 署名：カスタマイズ設定のファイル構成（fileKey/URL）から作る。
    //       内容が差し替われば fileKey が変わるため、変更検知に使える。
    const buildSignature = (customize) => {
      const pick = (bucket, kind, target) => (bucket?.[kind] || []).map(x =>
        `${target}:${kind}:${x?.type || ''}:${x?.file?.fileKey || x?.url || x?.file?.name || ''}`);
      const parts = [
        ...pick(customize?.desktop, 'js', 'desktop'),
        ...pick(customize?.desktop, 'css', 'desktop'),
        ...pick(customize?.mobile, 'js', 'mobile'),
        ...pick(customize?.mobile, 'css', 'mobile'),
      ];
      return parts.sort().join('|') || 'empty';
    };

    const cacheKey = (appId) => `${CACHE_PREFIX}${appId}`;

    const loadCache = (appId, signature) => {
      try {
        const raw = localStorage.getItem(cacheKey(appId));
        if (!raw) return null;
        const c = JSON.parse(raw);
        if (!c || c.signature !== signature) return null;                 // 構成が変わった
        if (Date.now() - new Date(c.scannedAt).getTime() > CACHE_TTL_MS) return null; // 期限切れ
        return c;
      } catch (e) {
        return null; // 壊れたキャッシュは無視する（例外で全体を止めない）
      }
    };

    const saveCache = (appId, signature, payload) => {
      try {
        localStorage.setItem(cacheKey(appId), JSON.stringify({
          signature, scannedAt: new Date().toISOString(), ...payload,
        }));
        return true;
      } catch (e) {
        // 容量超過などは致命的ではないため警告のみ
        console.warn('[KTScan] 解析結果のキャッシュ保存に失敗しました', e);
        return false;
      }
    };

    const clearCache = (appId) => {
      try { localStorage.removeItem(cacheKey(appId)); } catch (e) { }
    };

    // ---- 自動実行の設定（既定ON。ユーザーが切れるようにする）----
    const AUTO_KEY = 'ktScanAuto.v1';
    const isAutoEnabled = () => {
      try { return localStorage.getItem(AUTO_KEY) !== '0'; } catch (e) { return true; }
    };
    const setAutoEnabled = (on) => {
      try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch (e) { }
    };

    /** ブラウザが空いたタイミングで自動実行する（初期描画をブロックしない） */
    const scheduleAuto = (opt = {}) => {
      if (!isAutoEnabled()) { setState('skipped'); return; }
      const kick = () => { run({ silent: true, auto: true }); };
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(kick, { timeout: 3000 });
      } else {
        setTimeout(kick, 500);
      }
    };

    // ==========================================
    // 未知フィールドコード候補の抽出（純粋なテキスト解析）
    //  Field Scanner の通常解析は「既知のフィールドコードを探す」方式のため、
    //  存在しないコードは原理的に見つけられない。ここでは逆に「コードらしき文字列」を先に抽出する。
    //  ★方針：JavaScript内の文字列を広く拾うのではなく、
    //    「その値が実際にフィールドコードとして使われている文脈」だけを見る。
    //    表示ラベル・選択肢値・比較値はフィールドコードではないため対象外にする。
    // ==========================================

    // フィールドコードとしてあり得ない文字列を除外する
    //  - 空白・改行を含む（文章）
    //  - URL / パス / イベント名
    //  - 極端に長い
    function isPlausibleFieldCode(s) {
      const v = String(s || '').trim();
      if (!v || v.length > 128) return false;
      if (/[\s\u3000]/.test(v)) return false;              // 空白を含む
      if (/^(https?:|\/|\.\/|#)/.test(v)) return false;    // URL・パス
      if (/^\$/.test(v)) return false;                     // $id などのシステム項目
      if (/^(mobile\.)?app\.(record|report)\./.test(v)) return false; // イベント名
      if (/^(GET|POST|PUT|DELETE)$/i.test(v)) return false;
      if (/\.(json|js|css|html?)$/i.test(v)) return false; // ファイル名
      return true;
    }

    /** idx から始まる文字列リテラルを読む（文字列でなければ null） */
    function readStringLiteral(s, idx) {
      const q = s[idx];
      if (q !== '"' && q !== "'" && q !== '`') return null;
      let j = idx + 1;
      for (; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === q) break;
      }
      return { value: s.slice(idx + 1, j), index: idx + 1, end: j };
    }

    /**
     * 配列リテラルを走査し、その配列の「直下の要素」である文字列リテラルだけを返す。
     * ★入れ子（オブジェクト・内側の配列）の中身は対象外にする。
     *   これをしないと [{ option: '選択肢', fields: [...] }] のような構造で、
     *   表示ラベルや選択肢値までフィールドコードとして拾ってしまう。
     * @param {string} s ソース全文
     * @param {number} openIdx '[' の位置
     * @returns {{items: Array<{value:string, index:number}>, end:number}|null}
     */
    function scanArrayLiteralItems(s, openIdx) {
      if (s[openIdx] !== '[') return null;
      const items = [];
      let depth = 0;
      for (let i = openIdx; i < s.length; i++) {
        const ch = s[i];
        if (ch === '[' || ch === '{' || ch === '(') { depth++; continue; }
        if (ch === ']' || ch === '}' || ch === ')') {
          depth--;
          if (depth <= 0) return { items, end: i };
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          const lit = readStringLiteral(s, i);
          if (!lit) continue;
          // 直下の要素（depth === 1）のときだけフィールドコード候補として採用する
          if (depth === 1) items.push({ value: lit.value, index: lit.index });
          i = lit.end;
          continue;
        }
      }
      return { items, end: s.length };
    }

    /** idx から空白を読み飛ばした位置 */
    function skipWs(s, idx) {
      let i = idx;
      while (i < s.length && /\s/.test(s[i])) i++;
      return i;
    }

    /**
     * オブジェクトリテラルの「直下のプロパティ」を列挙する（入れ子の中身は見ない）。
     * 識別子キー・文字列キー・省略記法（{ app, fields }）に対応。計算プロパティやスプレッドは対象外。
     * @returns {{props: Array<{key:string, index:number, valueStart:number, shorthand:boolean}>, end:number}|null}
     */
    function scanObjectProps(s, openIdx) {
      if (s[openIdx] !== '{') return null;
      const props = [];
      let depth = 0;
      let expectKey = false;
      for (let i = openIdx; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"' || ch === "'" || ch === '`') {
          const lit = readStringLiteral(s, i);
          if (depth === 1 && expectKey) {
            const m = s.slice(lit.end + 1, lit.end + 40).match(/^\s*:/);
            if (m) props.push({ key: lit.value, index: lit.index, valueStart: skipWs(s, lit.end + 1 + m[0].length), shorthand: false });
            expectKey = false;
          }
          i = lit.end;
          continue;
        }
        if (ch === '{' || ch === '[' || ch === '(') {
          depth++;
          if (depth === 1) expectKey = true;
          continue;
        }
        if (ch === '}' || ch === ']' || ch === ')') {
          depth--;
          if (depth <= 0) return { props, end: i };
          continue;
        }
        if (depth !== 1) continue;
        if (ch === ',') { expectKey = true; continue; }
        if (/\s/.test(ch)) continue;
        if (!expectKey) continue;
        const m = s.slice(i, i + 200).match(/^([A-Za-z_$À-￿][\w$À-￿]*)\s*(:|[,}])/);
        if (m) {
          if (m[2] === ':') {
            props.push({ key: m[1], index: i, valueStart: skipWs(s, i + m[0].length), shorthand: false });
            i += m[0].length - 1;
          } else {
            // 省略記法 { app, fields }：キー名＝変数名
            props.push({ key: m[1], index: i, valueStart: i, shorthand: true });
            i += m[1].length - 1;
          }
        }
        expectKey = false;
      }
      return { props, end: s.length };
    }

    /** 配列リテラルの直下要素のうち、オブジェクトリテラルの '{' 位置を列挙する */
    function scanArrayElementObjects(s, openIdx) {
      const out = [];
      let depth = 0;
      for (let i = openIdx; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"' || ch === "'" || ch === '`') { i = readStringLiteral(s, i).end; continue; }
        if (ch === '[' || ch === '{' || ch === '(') { depth++; if (depth === 2 && ch === '{') out.push(i); continue; }
        if (ch === ']' || ch === '}' || ch === ')') { depth--; if (depth <= 0) break; }
      }
      return out;
    }

    /** at から始まる値の式を、同じ深さの , ; 改行 または閉じ括弧の手前まで読む */
    function readValueExpr(s, at) {
      let depth = 0;
      let i = at;
      for (; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"' || ch === "'" || ch === '`') { i = readStringLiteral(s, i).end; continue; }
        if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
        if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth--; continue; }
        if (depth === 0 && (ch === ',' || ch === ';' || ch === '\n')) break;
      }
      return s.slice(at, i).trim();
    }

    /** const / let / var の初期化式を集める（同名は最初の宣言を採用） */
    function collectDeclarations(s) {
      const decls = new Map();
      const rx = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
      let m;
      while ((m = rx.exec(s)) !== null) {
        if (!decls.has(m[1])) decls.set(m[1], readValueExpr(s, m.index + m[0].length));
      }
      return decls;
    }

    // 自アプリのIDを返す式（kintone.app.getId() / kintone.mobile.app.getId()）
    const SELF_APP_RX = /kintone\s*\.\s*(?:mobile\s*\.\s*)?app\s*\.\s*getId\s*\(\s*\)/;

    /**
     * REST APIパラメータの app: の値を解決する
     * @returns {{kind:'literal', appId:string}|{kind:'self'}|{kind:'unknown', raw:string}}
     *   literal: 数値リテラル（外部アプリ、または自アプリと同じID）
     *   self   : kintone.app.getId() 由来（自アプリ）
     *   unknown: 静的には特定できない（変数・関数戻り値など）→ 断定しない
     */
    function resolveAppExpr(expr, decls, hop = 0) {
      const e = String(expr || '').trim();
      if (!e) return { kind: 'unknown', raw: '' };
      let m;
      if ((m = e.match(/^['"]?(\d{1,7})['"]?$/))) return { kind: 'literal', appId: m[1] };
      if (SELF_APP_RX.test(e)) return { kind: 'self' };
      // Number(x) / String(x) / parseInt(x, 10) の薄い包みは剥がして中身を見る
      if ((m = e.match(/^(?:Number|String|parseInt)\s*\(\s*([^,()]+?)\s*(?:,\s*\d+\s*)?\)$/))) return resolveAppExpr(m[1], decls, hop);
      // 変数：宣言の右辺を辿る（深追い・循環防止で3段まで）
      if (/^[A-Za-z_$][\w$]*$/.test(e) && hop < 3 && decls && decls.has(e)) return resolveAppExpr(decls.get(e), decls, hop + 1);
      return { kind: 'unknown', raw: e.slice(0, 80) };
    }

    /** idx から前方向に空白を読み飛ばした位置の文字（無ければ ''） */
    function prevNonWs(s, idx) {
      let i = idx;
      while (i >= 0 && /\s/.test(s[i])) i--;
      return i >= 0 ? s[i] : '';
    }

    // '(' の直前に来ても「呼び出し」ではない語
    const NOT_CALLEE_RX = /^(?:if|for|while|switch|catch|with|return|typeof|await|yield|void|delete|in|of|function|else|do|case|throw)$/;

    /**
     * '(' の直前にある呼び出し先（識別子・メンバーチェーン）を返す。呼び出しでなければ null
     *   client.record.getRecords( → 'client.record.getRecords'／kintone.api( → 'kintone.api'／if ( → null
     */
    function calleeBefore(s, parenIdx) {
      const head = s.slice(Math.max(0, parenIdx - 160), parenIdx);
      const m = head.match(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*$/);
      if (!m) return null;
      const callee = m[1].replace(/\s+/g, '');
      if (!callee.includes('.') && NOT_CALLEE_RX.test(callee)) return null;
      return callee;
    }

    /** '{' がオブジェクトリテラルの開始か（ブロック { … } と区別する。直前の文字で判定） */
    function isObjectBrace(s, braceIdx) {
      let i = braceIdx - 1;
      while (i >= 0 && /\s/.test(s[i])) i--;
      if (i < 0) return false;
      const c = s[i];
      if (c === '(' || c === ',' || c === '=' || c === ':' || c === '[' || c === '?') return true; // '=> {' はブロック本体なので対象外（'=> ({' は直前が '(' になる）
      return /(?:return|yield)$/.test(s.slice(Math.max(0, i - 6), i + 1));
    }

    /** '{' の直前が「識別子への代入」（const p = { ／ p = {）なら、その識別子名を返す */
    function assignedNameBefore(s, braceIdx) {
      const head = s.slice(Math.max(0, braceIdx - 120), braceIdx);
      const m = head.match(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*$/);
      return m ? m[1] : null;
    }

    /**
     * 関数呼び出しの引数として「そのまま」渡されている識別子を集める（name → 呼び出し先の一覧）
     *   client.record.getRecords(params) → params: ['client.record.getRecords']
     *   getRecords(params.fields) や params[0] のようなメンバー参照は対象外
     */
    function collectCallArgIdentifiers(s) {
      const map = new Map();
      const stack = [];
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"' || ch === "'" || ch === '`') { i = readStringLiteral(s, i).end; continue; }
        if (ch === '(') { stack.push({ ch, callee: calleeBefore(s, i) }); continue; }
        if (ch === '[' || ch === '{') { stack.push({ ch, callee: null }); continue; }
        if (ch === ')' || ch === ']' || ch === '}') { stack.pop(); continue; }
        if (!/[A-Za-z_$]/.test(ch)) continue;
        const name = s.slice(i, i + 200).match(/^[A-Za-z_$][\w$]*/)[0];
        const top = stack[stack.length - 1];
        if (top && top.ch === '(' && top.callee) {
          const bef = prevNonWs(s, i - 1);
          const aft = s[skipWs(s, i + name.length)];
          if ((bef === '(' || bef === ',') && (aft === ',' || aft === ')')) {
            if (!map.has(name)) map.set(name, []);
            map.get(name).push(top.callee);
          }
        }
        i += name.length - 1;
      }
      return map;
    }

    // kintone REST API として認識する呼び出し先。変数名（client / restClient / this.client …）は問わず、
    // メソッド名で判定する：
    //   - @kintone/rest-api-client の record 系（app と fields / record / records を取るもの）
    //   - kintone.api(url, method, params)（kintone.api.url は対象外）
    //   - bulkRequest（requests[].payload に app / record を持つ）
    const REST_CALLEE_RX = new RegExp(
      '(?:^kintone\\.api$'
      + '|(?:^|\\.)bulkRequest$'
      + '|\\.record\\.(?:getRecord|getRecords|getAllRecords(?:WithId|WithOffset|WithCursor)?'
      + '|addRecord|addRecords|addAllRecords|updateRecord|updateRecords|updateAllRecords'
      + '|upsertRecord|upsertRecords|createCursor)$)');
    /** 呼び出し先が kintone REST API と認識できるか */
    function isRestCallee(callee) {
      return !!callee && REST_CALLEE_RX.test(String(callee));
    }

    /**
     * kintone REST API のパラメータ形（app と fields / record / records を持つオブジェクトリテラル）から
     * フィールド参照を抽出する。文字列の見た目ではなく「どのアプリのフィールドか」の文脈で判定する。
     *   { app: 1112, fields: ['A'] }                       → app 1112 の A を取得（READ）
     *   { app: 1112, record: { A: { value } } }            → app 1112 の A を更新（WRITE）
     *   { app: 1112, records: [{ id, record: { A } }] }    → 同上（updateRecords）
     *   { app: 1112, records: [{ A: { value } }] }         → 同上（addRecords）
     * app が kintone.app.getId() 由来なら自アプリ、数値なら外部アプリ（自アプリと同じIDの可能性は呼び出し側で判定）、
     * 変数などで特定できなければ unknown として断定しない。
     *
     * ★REST API 呼び出しとの関連（appRef.restCall / appRef.callee）：
     *   (a) 呼び出しの引数にオブジェクトリテラルを直接書いている   client.record.getRecords({ app, fields })
     *   (b) 変数に入れてから引数として渡している                    const p = {…}; client.record.getRecords(p)
     *   のいずれかで、かつ呼び出し先を kintone REST API と認識できる（isRestCallee）場合だけ restCall = true。
     *   fetchAll(p) / showConfig(p) のような独自関数は、内部で REST API を使うかを静的に追跡できないため
     *   依存（EXTERNAL_FIELD）の根拠にはしない（誤検出の抑制を優先）。どこにも渡されていない設定オブジェクトも同様。
     *   いずれの場合も app の文脈自体は使う（別アプリが明示されていれば自アプリの「存在しない参照」にはしない）。
     * @param {Function} emit (code, index, pattern, confidence, { appRef, access }) を呼ぶ
     * @returns {Set<number>} ここで処理した配列リテラルの '[' 位置（名前ヒューリスティクスと二重に拾わないため）
     */
    function extractRestParamFieldRefs(s, decls, emit) {
      const claimed = new Set();
      const CONF_REST = 'MEDIUM';
      const argUsage = collectCallArgIdentifiers(s);
      const emitObjectKeys = (openIdx, pattern, appRef, skipKeys) => {
        const rec = scanObjectProps(s, openIdx);
        for (const rp of (rec ? rec.props : [])) {
          if (skipKeys && skipKeys.test(rp.key)) continue;
          emit(rp.key, rp.index, pattern, CONF_REST, { appRef, access: 'WRITE' });
        }
      };

      // 括弧の入れ子を追い、'(' には呼び出し先、'{' にはオブジェクトリテラルかどうかを持たせる
      const stack = [];
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"' || ch === "'" || ch === '`') { i = readStringLiteral(s, i).end; continue; }
        if (ch === '(') { stack.push({ ch, callee: calleeBefore(s, i), isObj: false }); continue; }
        if (ch === '[') { stack.push({ ch, callee: null, isObj: false }); continue; }
        if (ch === ')' || ch === ']' || ch === '}') { stack.pop(); continue; }
        if (ch !== '{') continue;

        // この '{' が呼び出し引数（の一部）かどうか：オブジェクト／配列の入れ子だけを遡って '(' を探す
        //   client.record.getRecords({ app })            → 直上が '('
        //   client.bulkRequest({ requests: [{ payload: { app } }] }) → '{' '[' '{' を経て '('
        //   forEach(c => { const cfg = { app } })         → ブロック '{' で止まり、呼び出し引数とはみなさない
        let callee = null;
        for (let k = stack.length - 1; k >= 0; k--) {
          const e = stack[k];
          if (e.ch === '(') { callee = e.callee; break; }
          if (e.ch === '[' || (e.ch === '{' && e.isObj)) continue;
          break;
        }
        stack.push({ ch, callee: null, isObj: isObjectBrace(s, i) });

        const obj = scanObjectProps(s, i);
        if (!obj) continue;
        const appProp = obj.props.find(p => p.key === 'app');
        if (!appProp) continue;

        // (b) 変数に入れてから渡している場合：渡し先が複数あれば REST API と認識できるものを優先する
        if (!callee) {
          const name = assignedNameBefore(s, i);
          const callees = (name && argUsage.get(name)) || [];
          callee = callees.find(isRestCallee) || callees[0] || null;
        }
        // ★依存の根拠にするのは、呼び出し先を kintone REST API と認識できる場合だけ
        const restCall = isRestCallee(callee);
        const appRef = Object.assign(
          appProp.shorthand
            ? resolveAppExpr('app', decls)
            : resolveAppExpr(readValueExpr(s, appProp.valueStart), decls),
          { restCall, callee: callee || null });
        const tag = (appRef.kind === 'literal' ? `app: ${appRef.appId}`
          : appRef.kind === 'self' ? 'app: 自アプリ'
            : 'app: 変数（特定不可）')
          + (!callee ? '・未呼出' : !restCall ? '・呼出先未確認' : '');

        for (const p of obj.props) {
          if (p.shorthand) continue;
          if (p.key === 'fields' && s[p.valueStart] === '[') {
            claimed.add(p.valueStart);
            const arr = scanArrayLiteralItems(s, p.valueStart);
            for (const it of (arr ? arr.items : [])) emit(it.value, it.index, `fields[…]（${tag}）`, CONF_REST, { appRef, access: 'READ' });
          } else if (p.key === 'record' && s[p.valueStart] === '{') {
            emitObjectKeys(p.valueStart, `record: {…}（${tag}）`, appRef, null);
          } else if (p.key === 'records' && s[p.valueStart] === '[') {
            for (const oi of scanArrayElementObjects(s, p.valueStart)) {
              const el = scanObjectProps(s, oi);
              if (!el) continue;
              const inner = el.props.find(q => q.key === 'record' && !q.shorthand && s[q.valueStart] === '{');
              if (inner) emitObjectKeys(inner.valueStart, `records[].record: {…}（${tag}）`, appRef, null);
              else emitObjectKeys(oi, `records[]: {…}（${tag}）`, appRef, /^(id|updateKey|revision)$/);
            }
          }
        }
      }
      return claimed;
    }

    /**
     * JavaScript本文から「フィールドコードらしき文字列」を抽出する
     * @returns {Array<{code, line, pattern, confidence, dynamic, appRef, access}>}
     *   confidence: HIGH = kintone APIやrecord参照の引数（フィールドコード以外あり得ない）
     *               MEDIUM = フィールド系の変数・キーに入った配列リテラルの直下要素
     *   dynamic: テンプレートリテラルの ${...} を含み、実行時にしかコードが決まらない参照
     *   appRef : REST APIパラメータ由来の場合の参照先アプリ（{kind:'literal'|'self'|'unknown', ...}）。それ以外は null
     *   access : REST APIパラメータ由来の場合の用途（'READ' = fields で取得 / 'WRITE' = record で更新）。それ以外は null
     */
    function extractFieldCodeCandidates(cleanText, lineIndexFn) {
      const s = String(cleanText || '');
      const out = [];
      const push = (code, index, pattern, confidence, extra) => {
        if (!isPlausibleFieldCode(code)) return;
        const value = String(code).trim();
        out.push({
          code: value,
          line: lineIndexFn ? lineIndexFn(index) : null,
          pattern, confidence,
          // ${...} を含む参照は静的にコードを確定できない（存在しないと断定してはいけない）
          dynamic: /\$\{/.test(value),
          appRef: (extra && extra.appRef) || null,
          access: (extra && extra.access) || null,
        });
      };

      // 0) kintone REST API のパラメータ（{ app, fields / record / records }）
      //    「どのアプリのフィールドか」を app の値から判定し、候補に appRef を付ける。
      //    ここで処理した fields 配列は 5) の名前ヒューリスティクスでは二重に拾わない。
      const decls = collectDeclarations(s);
      const claimedArrays = extractRestParamFieldRefs(s, decls, push);

      // 1) kintone のフィールド操作API：第1引数はフィールドコード（またはグループコード）
      const rxApi = /\b(setFieldShown|setFieldValue|setFieldRequired|getFieldElements?|getSpaceElement|getHeaderMenuSpaceElement)\s*\(\s*['"`]([^'"`]+)['"`]/g;
      let m;
      while ((m = rxApi.exec(s)) !== null) push(m[2], m.index, m[1], 'HIGH');

      // 2) record['CODE'] / event.record['CODE']
      const rxBracket = /\brecord\s*\[\s*['"`]([^'"`]+)['"`]\s*\]/g;
      while ((m = rxBracket.exec(s)) !== null) push(m[1], m.index, "record['…']", 'HIGH');

      // 3) record.CODE.value / event.record.CODE.value
      //    （.value が続く場合のみ。メソッド呼び出しと区別するため）
      const rxDot = /\brecord\.([A-Za-z_$\u00C0-\uFFFF][\w$\u00C0-\uFFFF]*)\s*\.\s*value/g;
      while ((m = rxDot.exec(s)) !== null) push(m[1], m.index, 'record.….value', 'HIGH');

      // 4) フィールド操作関数の第2引数（第1引数に record を渡している呼び出し）
      //    例: getFieldValue(record, 'CODE') / setFieldValue(record, 'CODE', v)
      //        setFieldsDisabled(record, ['A', 'B'], true)
      //    ★2つの条件を both 満たすときだけ候補にする：
      //      (a) 第1引数が record（= レコードを操作している）
      //      (b) 関数名に field を含む（= フィールドを対象にしている）
      //    (a) だけでは showMessage(record, '表示文言') のような
      //    フィールド操作でない呼び出しまで拾ってしまう。
      //    (b) は 5) の配列名と同じ既存ヒューリスティクスで、関数名を列挙しないため
      //    プロジェクト独自のラッパー（toggleFieldVisibility など）にも効く。
      const rxRecordArg = /\b([A-Za-z_$][\w$]*)\s*\(\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?record\s*,\s*/g;
      while ((m = rxRecordArg.exec(s)) !== null) {
        const fn = m[1];
        if (!/field/i.test(fn)) continue;
        const at = m.index + m[0].length;
        const lit = readStringLiteral(s, at);
        if (lit) { push(lit.value, lit.index, `${fn}(record, '…')`, 'HIGH'); continue; }
        if (s[at] === '[') {
          const arr = scanArrayLiteralItems(s, at);
          for (const it of (arr ? arr.items : [])) push(it.value, it.index, `${fn}(record, […])`, 'HIGH');
        }
        // 変数渡し（例: setFieldsDisabled(record, group.fields, ...)）の場合は、
        // その配列リテラル自体を 5) の名前ヒューリスティクスで拾う
      }

      // 5) フィールド系の変数名・キー名に代入された配列リテラル
      //    例: const disabledFields = ['A','B'];  targetFieldCodes: ['C']
      //    「field」を含む名前のときだけ対象にする（誤検出を抑えるため）
      //    ★配列の「直下の要素」だけを見る。入れ子のオブジェクト内の文字列
      //      （表示ラベル labels や選択肢値 option）はフィールドコードではないため。
      const rxArr = /([A-Za-z_$][\w$]*)\s*[:=]\s*\[/g;
      while ((m = rxArr.exec(s)) !== null) {
        const name = m[1];
        if (!/field/i.test(name)) continue;
        const openIdx = m.index + m[0].length - 1;
        if (claimedArrays.has(openIdx)) continue; // 0) で app の文脈つきで処理済み
        const arr = scanArrayLiteralItems(s, openIdx);
        for (const it of (arr ? arr.items : [])) push(it.value, it.index, `${name}[…]`, 'MEDIUM');
      }

      return out;
    }

    // ==========================================
    // 「存在しないフィールド参照」の集約（純粋なテキスト解析。Field Scanner から利用）
    //   ここに置くことで、回帰テストから同じ経路をそのまま検証できる。
    // ==========================================

    // コメントは削除ではなく「同じ長さの空白」に置換する（文字オフセット・行番号を保ったまま解析するため）
    function stripCommentsOnly(src) {
      return String(src || '')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:\\])(\/\/.*)$/gm, (m, p1, p2) => p1 + ' '.repeat(p2.length));
    }

    // 行番号算出用：各行の先頭オフセット表（1ファイルにつき1回だけ作る）
    function buildLineIndex(text) {
      const starts = [0];
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) starts.push(i + 1);
      }
      return starts;
    }
    function lineAt(starts, idx) {
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= idx) lo = mid; else hi = mid - 1;
      }
      return lo + 1; // 1始まり
    }

    // 比較用の正規化（大文字小文字・全角半角・記号の違いを吸収する）
    function normalizeCode(s) {
      return String(s || '')
        .normalize('NFKC')          // 全角英数→半角など
        .trim()
        .toLowerCase()
        .replace(/[\s　_\-]/g, ''); // 空白・アンダースコア・ハイフンを無視
    }

    /**
     * 抽出した候補のうち、フィールド一覧に存在しないものを集約する
     * @param {Array<{name,target,kind,text}>} files 解析対象ファイル
     * @param {Array<{code}>} fields 自アプリのフィールド一覧
     * @param {string[]} extraKnown 既知として扱う追加コード（依存関係データ側のフィールド等）
     * @param {number|string} selfAppId 自アプリID。REST APIパラメータで別アプリが明示された参照を除外するために使う
     * @returns {Array<{code, files:Array, confidence, count, patterns, nearMatch}>}
     */
    function collectUnknownFieldRefs(files, fields, extraKnown, selfAppId) {
      const known = new Set((fields || []).map(f => f.code).filter(Boolean));
      // 依存関係データ側が知っているフィールドも既知として扱う（多重防御）
      for (const c of extraKnown || []) if (c) known.add(c);

      // 正規化した既知コードの索引（「近い既知コード」を示すために使う）
      const normIndex = new Map();
      for (const c of known) {
        const n = normalizeCode(c);
        if (n && !normIndex.has(n)) normIndex.set(n, c);
      }

      const agg = new Map();

      for (const f of files || []) {
        if (f.kind !== 'js' || !f.text) continue;
        const clean = stripCommentsOnly(f.text);
        const li = buildLineIndex(clean);
        for (const c of extractFieldCodeCandidates(clean, (i) => lineAt(li, i))) {
          if (known.has(c.code)) continue;
          // ${...} を含むテンプレートリテラルは、実行時にしかフィールドコードが決まらない。
          // 静的解析では存在有無を判断できないため「存在しない」とは断定しない。
          // （例: record[`品目${index}_株価計算`]）
          if (c.dynamic) continue;
          // REST APIパラメータで別アプリが明示されている参照（{ app: 1112, fields: [...] } 等）は
          // そのアプリのフィールドであって自アプリのフィールドではないため、「存在しない参照」に含めない。
          // app が変数などで特定できない場合は従来どおり候補に残す（断定はしない）。
          if (c.appRef && c.appRef.kind === 'literal' && selfAppId != null
            && String(c.appRef.appId) !== String(selfAppId)) continue;
          let a = agg.get(c.code);
          if (!a) {
            a = { code: c.code, files: new Map(), confidence: 'MEDIUM', count: 0, patterns: new Set() };
            agg.set(c.code, a);
          }
          a.count++;
          a.patterns.add(c.pattern);
          // 1つでもHIGHがあれば、そのコードはHIGH扱い（API引数は確実にフィールドコード）
          if (c.confidence === 'HIGH') a.confidence = 'HIGH';
          const key = `${f.target}:${f.name}`;
          if (!a.files.has(key)) a.files.set(key, []);
          const lines = a.files.get(key);
          if (lines.length < 10 && !lines.includes(c.line)) lines.push(c.line);
        }
      }

      return [...agg.values()]
        .map(a => ({
          code: a.code,
          confidence: a.confidence,
          count: a.count,
          patterns: [...a.patterns],
          // 表記ゆれで一致していないだけの可能性がある場合、その候補を示す
          nearMatch: normIndex.get(normalizeCode(a.code)) || null,
          // 行番号は昇順に並べる（検出順のままだと読みにくいため）
          files: [...a.files.entries()].map(([name, lines]) => ({ name, lines: [...lines].sort((x, y) => x - y) })),
        }))
        .sort((a, b) =>
          (a.confidence === b.confidence ? 0 : (a.confidence === 'HIGH' ? -1 : 1)) ||
          String(a.code).localeCompare(String(b.code), 'ja')
        );
    }

    /**
     * REST APIパラメータで外部アプリが明示されているフィールド参照を集約する
     *   { app: 1112, fields: ['A'] } → app 1112 の A を READ、record: { A } → WRITE
     * 自アプリと同じIDが数値で書かれている場合は外部扱いにしない。
     * 呼び出し先が kintone REST API と認識できる呼び出しの引数として渡されているもの（直接／変数経由）だけを対象にする。
     * @returns {Array<{appId, code, access:'READ'|'WRITE', file, target, lines:number[], count, via:string|null}>}
     */
    function collectExternalFieldRefs(files, selfAppId) {
      const agg = new Map();
      for (const f of files || []) {
        if (f.kind !== 'js' || !f.text) continue;
        const clean = stripCommentsOnly(f.text);
        const li = buildLineIndex(clean);
        for (const c of extractFieldCodeCandidates(clean, (i) => lineAt(li, i))) {
          if (c.dynamic || !c.appRef || c.appRef.kind !== 'literal') continue;
          if (String(c.appRef.appId) === String(selfAppId)) continue;
          // REST API と認識できる呼び出しに渡されていないもの（未使用の設定・独自関数への受け渡し）は、依存の根拠にしない
          if (!c.appRef.restCall) continue;
          const access = c.access === 'WRITE' ? 'WRITE' : 'READ';
          const key = `${f.target}|${f.name}|${c.appRef.appId}|${c.code}|${access}`;
          let a = agg.get(key);
          if (!a) {
            a = { appId: String(c.appRef.appId), code: c.code, access, file: f.name, target: f.target, lines: [], count: 0, via: c.appRef.callee || null };
            agg.set(key, a);
          }
          a.count++;
          if (a.lines.length < 10 && !a.lines.includes(c.line)) a.lines.push(c.line);
        }
      }
      return [...agg.values()].sort((a, b) =>
        String(a.appId).localeCompare(String(b.appId), 'ja', { numeric: true }) ||
        String(a.code).localeCompare(String(b.code), 'ja') ||
        a.access.localeCompare(b.access));
    }

    return {
      register, run, scheduleAuto, onChange, getStatus, setLastPayload, getLastPayload,
      buildSignature, loadCache, saveCache, clearCache,
      isAutoEnabled, setAutoEnabled,
      CACHE_TTL_MS, ANALYZER_VERSION,
      // 純粋なテキスト解析（Field Scannerが利用。回帰テストの対象）
      isPlausibleFieldCode, extractFieldCodeCandidates, scanArrayLiteralItems,
      scanObjectProps, resolveAppExpr, collectDeclarations, isRestCallee,
      stripCommentsOnly, buildLineIndex, lineAt, normalizeCode,
      collectUnknownFieldRefs, collectExternalFieldRefs,
    };
  })();

  // ==========================================
  // 2.6 他アプリからの被参照の走査 (KTIncoming)
  //  - 「このアプリを参照しているアプリ」はアプリ設定APIでは直接取得できない。
  //    同一ドメインの各アプリのフォーム設定を1つずつ確認する必要がある。
  //  - API呼び出しがアプリ数に比例するため、必ずユーザーの明示操作で実行し、
  //    結果はキャッシュする（自動実行はしない）。
  // ==========================================
  const KTIncoming = (() => {
    // v2: ルックアップ行に「ほかのフィールドのコピー」のコピー元（copyFields）を持つ。
    //     v1 の結果はコピー元を持たないため読まずに破棄し、再走査で最新形式にする。
    const CACHE_PREFIX = 'ktIncoming.v2.';
    const LEGACY_CACHE_PREFIXES = ['ktIncoming.v1.'];
    const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24時間
    const CONCURRENCY = 5;                    // 同時実行数（サーバ負荷を抑える）
    const MAX_APPS = 500;                     // 走査対象の上限（超過時は警告して打ち切る）

    // ---- キャッシュ ----
    const cacheKey = (appId) => `${CACHE_PREFIX}${appId}`;

    function loadCache(appId) {
      try {
        for (const p of LEGACY_CACHE_PREFIXES) localStorage.removeItem(`${p}${appId}`);
        const raw = localStorage.getItem(cacheKey(appId));
        if (!raw) return null;
        const c = JSON.parse(raw);
        if (!c?.scannedAt) return null;
        if (Date.now() - new Date(c.scannedAt).getTime() > CACHE_TTL_MS) return null;
        return c;
      } catch (e) {
        return null; // 壊れたキャッシュは無視する
      }
    }

    function saveCache(appId, data) {
      try { localStorage.setItem(cacheKey(appId), JSON.stringify(data)); }
      catch (e) { console.warn('[KTIncoming] 結果のキャッシュ保存に失敗しました', e); }
    }

    function clearCache(appId) {
      try { localStorage.removeItem(cacheKey(appId)); } catch (e) { }
    }

    /** 指定した並列数でタスクを順に処理する（サーバへの同時接続を抑える） */
    async function runPool(items, worker, concurrency, onEach) {
      const results = [];
      let index = 0;
      let done = 0;
      const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (index < items.length) {
          const i = index++;
          results[i] = await worker(items[i], i);
          done++;
          if (onEach) onEach(done, items.length);
        }
      });
      await Promise.all(runners);
      return results;
    }

    /**
     * 1アプリのフォーム設定を調べ、このアプリを参照している箇所を抽出する
     * @returns {{rows:Array, error:string|null}}
     */
    function analyzeApp(app, selfId, fieldsRes, actionsRes) {
      const rows = [];
      const self = String(selfId);
      const props = fieldsRes?.properties || {};

      const pushField = (f, parentCode) => {
        // ルックアップ：このアプリを参照している
        //   参照キー（relatedKeyField）に加えて、「ほかのフィールドのコピー」のコピー元もこのアプリ側のフィールド。
        //   kintone のレスポンスは relatedField=コピー元（このアプリ側）, field=コピー先（相手アプリ側）。
        //   コピー先は相手アプリのフィールドなので、このアプリの項目としては扱わない。
        if (f?.lookup?.relatedApp?.app != null && String(f.lookup.relatedApp.app) === self) {
          const maps = Array.isArray(f.lookup.fieldMappings) ? f.lookup.fieldMappings : [];
          const copyFields = [];
          for (const m of maps) {
            const from = m?.relatedField?.code ?? m?.relatedField ?? null;
            const to = m?.field?.code ?? m?.field ?? null;
            if (from) copyFields.push({ from: String(from), to: to ? String(to) : '' });
          }
          rows.push({
            appId: String(app.appId), appName: app.name || '',
            kind: 'ルックアップ',
            sourceField: f.code, sourceLabel: f.label || f.code,
            targetField: f.lookup.relatedKeyField || '',
            copyFields,
            note: `${maps.length}項目を取得${parentCode ? `／テーブル ${parentCode} 内` : ''}`,
          });
        }
        // 関連レコード一覧：このアプリのレコードを表示している
        if (f?.type === 'REFERENCE_TABLE' && String(f?.referenceTable?.relatedApp?.app ?? '') === self) {
          rows.push({
            appId: String(app.appId), appName: app.name || '',
            kind: '関連レコード',
            sourceField: f.code, sourceLabel: f.label || f.code,
            targetField: f.referenceTable?.condition?.relatedField || '',
            note: f.referenceTable?.condition?.field
              ? `${f.referenceTable.condition.field} で突合`
              : '',
          });
        }
      };

      for (const f of Object.values(props)) {
        if (f?.type === 'SUBTABLE') {
          for (const sf of Object.values(f.fields || {})) pushField(sf, f.code);
        } else {
          pushField(f, null);
        }
      }

      // アプリアクション：このアプリへレコードを作成している
      for (const [key, a] of Object.entries(actionsRes?.actions || {})) {
        if (String(a?.destApp?.app ?? '') !== self) continue;
        const maps = (a?.mappings || []).filter(m => m?.destField);
        rows.push({
          appId: String(app.appId), appName: app.name || '',
          kind: 'アプリアクション',
          sourceField: a?.name || key, sourceLabel: a?.name || key,
          targetField: maps.length === 1 ? maps[0].destField : (maps.length ? '複数' : ''),
          note: maps.length ? `${maps.length}項目を転記` : '',
          destFields: maps.map(m => m.destField),
        });
      }

      return rows;
    }

    /**
     * 同一ドメインのアプリを走査し、このアプリへの参照を集める
     * @param {number|string} selfId 対象アプリのID
     * @param {object} opt.includeActions アプリアクションも調べる（API呼び出しが約2倍になる）
     * @param {function} opt.onProgress (done, total, phase) => void
     * @param {boolean} opt.force キャッシュを無視して再走査する
     */
    async function run(selfId, opt = {}) {
      const { includeActions = true, onProgress = null, force = false } = opt;
      const self = String(selfId);

      if (!force) {
        const cached = loadCache(self);
        if (cached) return { ...cached, fromCache: true };
      }

      if (onProgress) onProgress(0, 0, 'アプリ一覧を取得中');
      const apps = (await KTApi.getAppList({ max: MAX_APPS }))
        .filter(a => String(a.appId) !== self);

      const truncated = apps.length >= MAX_APPS;
      const rows = [];
      const errors = [];   // 取得できなかったアプリ（権限不足など）

      await runPool(apps, async (app) => {
        try {
          const fieldsRes = await KTApi.getFormFieldsOf(app.appId);
          let actionsRes = null;
          if (includeActions) {
            // アクション設定はアプリ管理権限が必要なため、取れなくても続行する
            try { actionsRes = await KTApi.getActionsOf(app.appId); } catch (e) { actionsRes = null; }
          }
          rows.push(...analyzeApp(app, self, fieldsRes, actionsRes));
        } catch (e) {
          errors.push({
            appId: String(app.appId), appName: app.name || '',
            reason: /403|permission|権限/i.test(String(e?.message || e)) ? '権限不足' : '取得失敗',
          });
        }
      }, CONCURRENCY, (done, total) => {
        if (onProgress) onProgress(done, total, '各アプリを確認中');
      });

      rows.sort((a, b) =>
        String(a.appName).localeCompare(String(b.appName), 'ja') ||
        String(a.kind).localeCompare(String(b.kind), 'ja') ||
        String(a.sourceField).localeCompare(String(b.sourceField), 'ja')
      );

      const data = {
        rows, errors,
        stats: {
          scannedApps: apps.length,
          referencingApps: new Set(rows.map(r => r.appId)).size,
          failedApps: errors.length,
          includeActions,
          truncated,
        },
        scannedAt: new Date().toISOString(),
      };
      saveCache(self, data);
      return { ...data, fromCache: false };
    }

    return { run, analyzeApp, loadCache, clearCache, CACHE_TTL_MS, MAX_APPS };
  })();

  // ==========================================
  // 2.5 依存関係解析レイヤ (KTDeps)
  //  - Raw Data(DATA) から Normalized / Dependency Data を生成する純関数群
  //  - UI描画には依存しない（各タブから再利用する）
  // ==========================================
  const KTDeps = (() => {

    // ---- 定数：関係種別（後からグラフ・影響分析で再利用する共通語彙）----
    const REL = {
      DISPLAYS: 'DISPLAYS',                 // 一覧・関連レコードがフィールドを表示
      FILTERS_BY: 'FILTERS_BY',             // 絞り込み条件で使用
      SORTS_BY: 'SORTS_BY',                 // ソート条件で使用
      GROUPS_BY: 'GROUPS_BY',               // グラフの分類項目
      AGGREGATES: 'AGGREGATES',             // グラフの集計項目
      NOTIFY_TARGET: 'NOTIFY_TARGET',       // 通知先（フィールド指定）
      REMINDER_TIMING: 'REMINDER_TIMING',   // リマインダー基準日時
      ASSIGNS_BY: 'ASSIGNS_BY',             // プロセス管理の作業者（フィールド指定）
      EXECUTABLE_BY: 'EXECUTABLE_BY',       // プロセス管理の「作業者以外でも実行できるアクション」の実行可能ユーザー（フィールド指定）
      LOOKUP_KEY: 'LOOKUP_KEY',             // ルックアップの参照キー（相手アプリ側）
      LOOKUP_COPY_TO: 'LOOKUP_COPY_TO',     // ルックアップのコピー先（自アプリ側）
      LOOKUP_PICKER: 'LOOKUP_PICKER',       // ルックアップのピッカー表示（相手アプリ側）
      REFERENCES: 'REFERENCES',             // 計算式が別フィールドを参照
      HTML_REFERENCE: 'HTML_REFERENCE',     // カスタマイズビューのHTML内に記述（静的解析による推定）
      ACTION_MAPS_FROM: 'ACTION_MAPS_FROM', // アプリアクションの転記元（自アプリ側）
      ACL_CONDITION: 'ACL_CONDITION',       // レコードACLの条件で使用
      ACL_TARGET: 'ACL_TARGET',             // フィールドACLの対象／エンティティ指定
      APP_REFERENCE: 'APP_REFERENCE',       // 他アプリへの参照（Lookup/関連/アクション）
      JS_READ: 'JS_READ',                   // JavaScriptがフィールド値を参照（静的解析による推定）
      JS_WRITE: 'JS_WRITE',                 // JavaScriptがフィールド値を設定（静的解析による推定）
      JS_CONTROL: 'JS_CONTROL',             // JavaScriptが表示/活性/エラー等を制御（静的解析による推定）
      JS_REFERENCE: 'JS_REFERENCE',         // JavaScript内にコードが出現（用途は特定できず）
      REFERENCED_BY: 'REFERENCED_BY',       // 他アプリからこのアプリのフィールドが参照されている
    };

    // ---- 定数：確度（推定結果を確定情報として表示しないための語彙）----
    const CONF = {
      CERTAIN: 'CERTAIN',           // 構造化された設定値から直接取得（確実）
      LIKELY: 'LIKELY',             // 条件式・計算式のトークン一致（可能性が高い）
      UNCERTAIN: 'UNCERTAIN',       // 文字列一致のみ（要確認）
      NOT_ANALYZED: 'NOT_ANALYZED', // 解析対象外（外部URLのJS等）
    };

    // ---- kintone API の entity.type（通知先・作業者・アクセス権の対象の指定形式）----
    //   USER / GROUP / ORGANIZATION : ユーザー・グループ・組織
    //   FIELD_ENTITY                : 「フォームのフィールドを追加」で指定したフィールド（entity.code = フィールドコード）
    //   CREATOR / CUSTOM_FIELD      : アプリ作成者（code は null）／cybozu.com共通管理のカスタマイズ項目
    //   このうちフィールドへの依存になるのは FIELD_ENTITY だけ。
    // ★'FIELD' は依存関係データ（内部モデル）のノード種別と、アプリアクションの mappings[].srcType の値であり、
    //   entity.type の値ではない。APIの語彙を内部モデルの語彙と取り違えないよう、判定はここに集約する。
    const ENTITY_TYPE_FIELD = 'FIELD_ENTITY';

    /** entity（{ type, code }）がフィールド指定なら、そのフィールドコードを返す（それ以外は null） */
    function entityFieldCode(entity) {
      return (entity && entity.type === ENTITY_TYPE_FIELD && entity.code) ? entity.code : null;
    }

    // ================= Normalized Data =================

    /**
     * フォームフィールド定義（DATA.fields）をフラットな配列へ正規化する
     * - SUBTABLE の子は parent にサブテーブルコードを持つ
     * - lookup を持つフィールドは type:'LOOKUP'（rawType に元typeを保持）
     */
    function normalizeFields(fieldsResp) {
      const list = [];
      const walk = (props, parent = null) => {
        for (const code of Object.keys(props || {})) {
          const f = props[code];
          if (!f) continue;
          if (f.type === 'SUBTABLE') {
            list.push({
              code: f.code, label: f.label ?? f.code, type: 'SUBTABLE',
              rawType: 'SUBTABLE', parent: null,
              required: false, unique: false, raw: f,
            });
            walk(f.fields, f.code);
            continue;
          }
          list.push({
            code: f.code, label: f.label ?? f.code,
            type: f.lookup ? 'LOOKUP' : (f.type ?? ''),
            rawType: f.type ?? '',
            parent,
            required: !!f.required, unique: !!f.unique,
            raw: f,
          });
        }
      };
      walk(fieldsResp);
      return list;
    }

    /** code -> label の Map を作る（共通化。各タブはこれを再利用する） */
    function buildCode2Label(normalizedFields) {
      const m = new Map();
      for (const f of normalizedFields || []) {
        if (f.code) m.set(f.code, f.label || f.code);
      }
      return m;
    }

    /** Map / plain object のどちらでもラベルを引ける共通ヘルパ */
    function labelOf(code2label, code) {
      if (!code) return '';
      if (code2label instanceof Map) return code2label.get(code) || code;
      return (code2label && code2label[code]) || code;
    }

    // ================= テキスト解析（誤検出抑制） =================

    /** "..." / '...' の文字列リテラルを同じ長さの空白でマスクする */
    function maskStringLiterals(src) {
      let out = '';
      let i = 0;
      const s = String(src || '');
      while (i < s.length) {
        const ch = s[i];
        if (ch === '"' || ch === "'") {
          const quote = ch;
          out += ' ';
          i++;
          while (i < s.length) {
            if (s[i] === '\\') { out += '  '; i += 2; continue; }
            if (s[i] === quote) { out += ' '; i++; break; }
            out += ' ';
            i++;
          }
          continue;
        }
        out += ch;
        i++;
      }
      return out;
    }

    // 語を構成しうる文字か（英数・_・全角文字全般）
    const isWordChar = (ch) => !!ch && /[A-Za-z0-9_\u00C0-\uFFFF]/.test(ch);

    /**
     * テキストからフィールドコードの出現を抽出する
     * 誤検出対策：
     *  1) 文字列リテラル内はマスクして対象外にする
     *  2) 長いコードを先にマッチさせ、確保した区間には短いコードを再マッチさせない
     *     （「顧客コード」がある文で「コード」を誤検出しない）
     *  3) 前後が語構成文字ならマッチ不採用（前方一致・部分一致の除外）
     * トレードオフ：
     *  - 「旧顧客コード」のような連続語の中の一致も除外するため、取りこぼしはあり得る
     *  - そのため結果は confidence: LIKELY として扱う（確定情報にしない）
     */
    function extractFieldCodes(text, allCodes, { maskStrings = true } = {}) {
      const raw = String(text || '');
      if (!raw || !Array.isArray(allCodes) || !allCodes.length) return [];
      const s = maskStrings ? maskStringLiterals(raw) : raw;

      const codes = [...new Set(allCodes.filter(Boolean))].sort((a, b) => b.length - a.length);
      const taken = new Array(s.length).fill(false);
      const found = [];

      for (const code of codes) {
        let from = 0;
        while (true) {
          const idx = s.indexOf(code, from);
          if (idx < 0) break;
          from = idx + 1;
          const end = idx + code.length;
          let overlapped = false;
          for (let k = idx; k < end; k++) { if (taken[k]) { overlapped = true; break; } }
          if (overlapped) continue;
          const before = idx > 0 ? s[idx - 1] : '';
          const after = end < s.length ? s[end] : '';
          if (isWordChar(before) || isWordChar(after)) continue;
          for (let k = idx; k < end; k++) taken[k] = true;
          found.push({ code, index: idx });
        }
      }
      found.sort((a, b) => a.index - b.index);
      return found;
    }

    /** kintoneクエリの sort 部（"code asc, code2 desc"）を分解して code を返す */
    /**
     * kintoneクエリの sort 部（"code asc, code2 desc"）を分解して code を返す
     * ★変更：存在しないコードも返す（壊れた参照の検出に使うため）。
     *   $id / $revision などのシステム項目はフィールドではないので除外する。
     */
    function parseSortCodes(sortStr) {
      return String(sortStr || '')
        .split(',')
        .map(s => s.trim().split(/\s+/)[0])
        .filter(c => c && !c.startsWith('$'));
    }

    // ================= Dependency Data =================

    /**
     * 依存関係データを生成する（同期・純関数）
     * @returns {{nodes: Array, edges: Array, meta: object}}
     * edge 形式:
     * {
     *   sourceType, sourceId, sourceName,   // 利用する側（VIEW / REPORT / NOTIFICATION / ...）
     *   relationType,                        // REL.*
     *   targetType, targetId, targetName,    // 利用される側（FIELD / APP / EXTERNAL_FIELD）
     *   context: { settingType, settingName },
     *   confidence,                          // CONF.*
     * }
     */
    function buildDependencyData(DATA, normalizedFields) {
      const fieldsN = normalizedFields || normalizeFields(DATA?.fields);
      const code2label = buildCode2Label(fieldsN);
      const allCodes = fieldsN.map(f => f.code).filter(Boolean);
      const codeSet = new Set(allCodes);

      const nodes = [];
      const edges = [];
      const nodeIds = new Set();

      const addNode = (type, id, name, extra = {}) => {
        const key = `${type}:${id}`;
        if (!id || nodeIds.has(key)) return;
        nodeIds.add(key);
        nodes.push({ id: key, type, name: name ?? String(id), ...extra });
      };
      const addEdge = (e) => { edges.push(e); };

      // フィールドノード
      for (const f of fieldsN) {
        addNode('FIELD', f.code, f.label, { fieldType: f.type, parent: f.parent });
      }
      // 自アプリノード
      const selfName = DATA?.settings?.name ? ` ${DATA.settings.name}` : '';
      addNode('APP', String(DATA?.appId ?? ''), `app ${DATA?.appId ?? '?'}${selfName}（このアプリ）`, { self: true });

      // ステータス名の検証に使う情報
      //   states  : プロセス管理に定義されているステータス名
      //   codes   : ステータスフィールドのコード（条件式で使われる）
      //   conds   : 検証対象の条件式（設定の種別・名前つきで集める）
      const statusStates = DATA?.status?.enable
        ? Object.values(DATA.status.states || {}).map(st => st?.name).filter(Boolean)
        : [];
      const statusFieldCodes = fieldsN
        .filter(f => f.rawType === 'STATUS')
        .map(f => f.code);
      const statusConditions = [];
      const collectCond = (cond, category, settingType, settingName) => {
        if (cond) statusConditions.push({ cond, category, settingType, settingName });
      };

      // 条件式（filterCond等）からのエッジ生成ヘルパ
      const edgesFromCond = (cond, src, relationType, settingType, settingName) => {
        // ステータス名の検証用に、条件式そのものも控えておく
        collectCond(cond, IMPACT_CATEGORY[src.sourceType] || src.sourceType, settingType, settingName);
        for (const hit of extractFieldCodes(cond, allCodes)) {
          addEdge({
            ...src, relationType,
            targetType: 'FIELD', targetId: hit.code, targetName: labelOf(code2label, hit.code),
            context: { settingType, settingName },
            confidence: CONF.LIKELY,
          });
        }
      };
      // 設定値として明示されているフィールドコードのエッジを作る。
      // フォーム定義に存在しないコードは missing:true を立て、壊れた参照として検出できるようにする。
      // （条件式や計算式からの抽出はコード一覧を元に行うため、ここには該当しない）
      const fieldEdge = (src, relationType, code, settingType, settingName, confidence = CONF.CERTAIN) => {
        if (!code) return;
        const missing = !codeSet.has(code);
        addEdge({
          ...src, relationType,
          targetType: 'FIELD', targetId: code, targetName: labelOf(code2label, code),
          context: { settingType, settingName, ...(missing ? { missing: true } : {}) },
          confidence: missing ? CONF.UNCERTAIN : confidence,
        });
      };
      // 通知先・作業者・アクセス権の対象（entity）がフィールド指定のとき、そのフィールドへのエッジを作る。
      // ユーザー・グループ・組織などの指定はフィールドへの依存ではないため、エッジにしない。
      const entityEdge = (src, relationType, entity, settingType, settingName) =>
        fieldEdge(src, relationType, entityFieldCode(entity), settingType, settingName);

      // ---- 1) 一覧（views） ----
      for (const v of Object.values(DATA?.views?.views || {})) {
        const src = { sourceType: 'VIEW', sourceId: String(v.id ?? v.name ?? ''), sourceName: v.name ?? '' };
        addNode('VIEW', src.sourceId, v.name ?? '');
        (v.fields || []).forEach(c => fieldEdge(src, REL.DISPLAYS, c, 'VIEW_FIELDS', v.name ?? ''));
        if (v.type === 'CALENDAR') {
          fieldEdge(src, REL.DISPLAYS, v.date, 'VIEW_CALENDAR_DATE', v.name ?? '');
          fieldEdge(src, REL.DISPLAYS, v.title, 'VIEW_CALENDAR_TITLE', v.name ?? '');
        }
        edgesFromCond(v.filterCond, src, REL.FILTERS_BY, 'VIEW_FILTER', v.name ?? '');
        parseSortCodes(v.sort).forEach(c => fieldEdge(src, REL.SORTS_BY, c, 'VIEW_SORT', v.name ?? ''));

        // ★カスタマイズビュー：HTML内に記述されたフィールドコードを検出する
        //   HTMLに埋め込まれたJavaScriptでは 'フィールドコード' のように文字列で書かれるため、
        //   文字列リテラルのマスクは行わない。そのぶん誤検出しやすいので確度は「要確認」とする。
        if (v.type === 'CUSTOM' && v.html) {
          const htmlHits = new Set(extractFieldCodes(v.html, allCodes, { maskStrings: false }).map(h => h.code));
          for (const code of htmlHits) {
            const hit = { code };
            addEdge({
              ...src, relationType: REL.HTML_REFERENCE,
              targetType: 'FIELD', targetId: hit.code, targetName: labelOf(code2label, hit.code),
              context: { settingType: 'VIEW_CUSTOM_HTML', settingName: v.name ?? '' },
              confidence: CONF.UNCERTAIN,
            });
          }
        }
      }

      // ---- 2) グラフ（reports） ----
      for (const r of Object.values(DATA?.reports?.reports || {})) {
        const src = { sourceType: 'REPORT', sourceId: String(r.id ?? r.name ?? ''), sourceName: r.name ?? '' };
        addNode('REPORT', src.sourceId, r.name ?? '');
        (r.groups || []).forEach(g => fieldEdge(src, REL.GROUPS_BY, g?.code, 'REPORT_GROUP', r.name ?? ''));
        (r.aggregations || []).forEach(a => fieldEdge(src, REL.AGGREGATES, a?.code, 'REPORT_AGG', r.name ?? ''));
        edgesFromCond(r.filterCond, src, REL.FILTERS_BY, 'REPORT_FILTER', r.name ?? '');
        (r.sorts || []).forEach(s => {
          const by = s?.by;
          if (by && !['TOTAL', 'GROUP1', 'GROUP2', 'GROUP3'].includes(by)) {
            fieldEdge(src, REL.SORTS_BY, by, 'REPORT_SORT', r.name ?? '');
          }
        });
      }

      // ---- 3) 通知 ----
      // アプリの条件通知（general）：通知先ごとの設定。通知先がフィールド指定の行だけがフィールドへの依存になる
      const generalNotifs = DATA?.generalNotify?.notifications || [];
      if (generalNotifs.length) {
        const name = 'アプリの条件通知';
        const src = { sourceType: 'NOTIFICATION', sourceId: 'general', sourceName: name };
        addNode('NOTIFICATION', src.sourceId, name, { kind: 'general' });
        generalNotifs.forEach(n => entityEdge(src, REL.NOTIFY_TARGET, n?.entity, 'GENERAL_NOTIFY_TARGET', name));
      }
      // レコードの条件通知（perRecord）
      (DATA?.perRecordNotify?.notifications || []).forEach((n, i) => {
        const name = n?.title || `条件通知#${i + 1}`;
        const src = { sourceType: 'NOTIFICATION', sourceId: `perRecord:${i}`, sourceName: name };
        addNode('NOTIFICATION', src.sourceId, name, { kind: 'perRecord' });
        edgesFromCond(n?.filterCond, src, REL.FILTERS_BY, 'NOTIFY_CONDITION', name);
        (n?.targets || []).forEach(t => entityEdge(src, REL.NOTIFY_TARGET, t?.entity, 'NOTIFY_TARGET', name));
      });
      // リマインダー通知
      (DATA?.reminderNotify?.notifications || []).forEach((n, i) => {
        const name = n?.title || `リマインダー#${i + 1}`;
        const src = { sourceType: 'NOTIFICATION', sourceId: `reminder:${i}`, sourceName: name };
        addNode('NOTIFICATION', src.sourceId, name, { kind: 'reminder' });
        fieldEdge(src, REL.REMINDER_TIMING, n?.timing?.code, 'REMINDER_TIMING', name);
        edgesFromCond(n?.filterCond, src, REL.FILTERS_BY, 'REMINDER_CONDITION', name);
        (n?.targets || []).forEach(t => entityEdge(src, REL.NOTIFY_TARGET, t?.entity, 'REMINDER_TARGET', name));
      });

      // ---- 4) プロセス管理（status） ----
      if (DATA?.status?.enable) {
        Object.values(DATA.status.states || {}).forEach(st => {
          const name = st?.name || '';
          const src = { sourceType: 'PROCESS_STATE', sourceId: name, sourceName: name };
          addNode('PROCESS_STATE', name, name);
          (st?.assignee?.entities || []).forEach(e => entityEdge(src, REL.ASSIGNS_BY, e?.entity, 'PROCESS_ASSIGNEE', name));
        });
        (DATA.status.actions || []).forEach((a, i) => {
          const name = a?.name || `アクション#${i + 1}`;
          const src = { sourceType: 'PROCESS_ACTION', sourceId: `${name}:${i}`, sourceName: name };
          addNode('PROCESS_ACTION', src.sourceId, name);
          edgesFromCond(a?.filterCond, src, REL.FILTERS_BY, 'PROCESS_CONDITION', name);
          // 「作業者以外でも実行できるアクション」（type: SECONDARY）の実行可能ユーザー。作業者（ASSIGNS_BY）とは区別する
          (a?.executableUser?.entities || []).forEach(e =>
            entityEdge(src, REL.EXECUTABLE_BY, e?.entity, 'PROCESS_EXECUTABLE_USER', name));
        });
      }

      // ---- 5) アクセス権 ----
      // レコードACL：条件式＋フィールド指定の対象
      (DATA?.recordAcl?.rights || []).forEach((r, i) => {
        const name = `レコードACL#${i + 1}`;
        const src = { sourceType: 'ACL', sourceId: `record:${i}`, sourceName: name };
        addNode('ACL', src.sourceId, name, { kind: 'record' });
        edgesFromCond(r?.filterCond, src, REL.ACL_CONDITION, 'RECORD_ACL_CONDITION', name);
        (r?.entities || []).forEach(e => entityEdge(src, REL.ACL_TARGET, e?.entity, 'RECORD_ACL_ENTITY', name));
      });
      // フィールドACL：対象フィールドそのもの＋フィールド指定の対象
      (DATA?.fieldAcl?.rights || []).forEach((r, i) => {
        const name = `フィールドACL#${i + 1}`;
        const src = { sourceType: 'ACL', sourceId: `field:${i}`, sourceName: name };
        addNode('ACL', src.sourceId, name, { kind: 'field' });
        fieldEdge(src, REL.ACL_TARGET, r?.code, 'FIELD_ACL_TARGET', name);
        (r?.entities || []).forEach(e => entityEdge(src, REL.ACL_TARGET, e?.entity, 'FIELD_ACL_ENTITY', name));
      });

      // ---- 6) ルックアップ / 関連レコード / アプリアクション ----
      // 既存の buildRelations と同じ生データを直接参照する（buildRelations の
      // mappings が表示用文字列になっているため、ここでは raw から取り直す）
      for (const f of fieldsN) {
        const raw = f.raw || {};
        // 6-1) Lookup
        if (raw.lookup) {
          const lu = raw.lookup;
          const relApp = lu?.relatedApp?.app ?? null;
          const src = { sourceType: 'FIELD', sourceId: f.code, sourceName: f.label };
          if (relApp != null) {
            addNode('APP', String(relApp), `app ${relApp}`, { self: false });
            addEdge({
              ...src, relationType: REL.APP_REFERENCE,
              targetType: 'APP', targetId: String(relApp), targetName: `app ${relApp}`,
              context: { settingType: 'LOOKUP', settingName: f.label },
              confidence: CONF.CERTAIN,
            });
          }
          const keyField = lu?.relatedKeyField ?? lu?.keyField ?? null;
          if (keyField) {
            addEdge({
              ...src, relationType: REL.LOOKUP_KEY,
              targetType: 'EXTERNAL_FIELD', targetId: `${relApp ?? '?'}:${keyField}`, targetName: keyField,
              context: { settingType: 'LOOKUP_KEY', settingName: f.label, appId: relApp },
              confidence: CONF.CERTAIN,
            });
          }
          (lu?.fieldMappings || []).forEach(m => {
            // kintoneレスポンス：field=自アプリ側(コピー先), relatedField=参照アプリ側(コピー元)
            const to = m?.field?.code ?? m?.field ?? null;
            const from = m?.relatedField?.code ?? m?.relatedField ?? null;
            if (to) fieldEdge(src, REL.LOOKUP_COPY_TO, to, 'LOOKUP_MAPPING', f.label);
            if (from) {
              addEdge({
                ...src, relationType: REL.LOOKUP_PICKER,
                targetType: 'EXTERNAL_FIELD', targetId: `${relApp ?? '?'}:${from}`, targetName: from,
                context: { settingType: 'LOOKUP_MAPPING_SRC', settingName: f.label, appId: relApp },
                confidence: CONF.CERTAIN,
              });
            }
          });
        }
        // 6-2) 関連レコード一覧
        if (f.rawType === 'REFERENCE_TABLE' && f.raw?.referenceTable) {
          const rt = f.raw.referenceTable;
          const relApp = rt?.relatedApp?.app ?? null;
          const src = { sourceType: 'FIELD', sourceId: f.code, sourceName: f.label };
          if (relApp != null) {
            addNode('APP', String(relApp), `app ${relApp}`, { self: false });
            addEdge({
              ...src, relationType: REL.APP_REFERENCE,
              targetType: 'APP', targetId: String(relApp), targetName: `app ${relApp}`,
              // 連携キー（自アプリ側 condField ＝ 接続先側 condRelatedField）と
              // 表示フィールド数をSummary表示用に保持
              context: {
                settingType: 'REFERENCE_TABLE', settingName: f.label,
                condField: rt?.condition?.field ?? null,
                condRelatedField: rt?.condition?.relatedField ?? null,
                displayCount: Array.isArray(rt?.displayFields) ? rt.displayFields.length : null,
              },
              confidence: CONF.CERTAIN,
            });
          }
          const condField = rt?.condition?.field;
          if (condField) fieldEdge(src, REL.FILTERS_BY, condField, 'REFTABLE_CONDITION', f.label);
        }
      }
      // 6-3) アプリアクション
      for (const [key, a] of Object.entries(DATA?.actions?.actions || {})) {
        const name = a?.name ?? key;
        const src = { sourceType: 'ACTION', sourceId: String(a?.id ?? key), sourceName: name };
        addNode('ACTION', src.sourceId, name);
        const destApp = a?.destApp?.app ?? null;
        if (destApp != null) {
          addNode('APP', String(destApp), `app ${destApp}`, { self: false });
          addEdge({
            ...src, relationType: REL.APP_REFERENCE,
            targetType: 'APP', targetId: String(destApp), targetName: `app ${destApp}`,
            context: { settingType: 'ACTION', settingName: name },
            confidence: CONF.CERTAIN,
          });
        }
        (a?.mappings || []).forEach(m => {
          if (m?.srcType === 'FIELD' && m?.srcField) {
            fieldEdge(src, REL.ACTION_MAPS_FROM, m.srcField, 'ACTION_MAPPING', name);
          }
        });
        edgesFromCond(a?.filterCond, src, REL.FILTERS_BY, 'ACTION_CONDITION', name);
      }

      // ---- 7) 計算式（CALC / 文字列1行の自動計算） ----
      for (const f of fieldsN) {
        const raw = f.raw || {};
        const hasExpr =
          (raw.type === 'CALC' && raw.expression) ||
          (raw.type === 'SINGLE_LINE_TEXT' && raw.expression);
        if (!hasExpr) continue;
        const src = { sourceType: 'FIELD', sourceId: f.code, sourceName: f.label };
        for (const hit of extractFieldCodes(raw.expression, allCodes)) {
          if (hit.code === f.code) continue; // 自己参照は除外
          addEdge({
            ...src, relationType: REL.REFERENCES,
            targetType: 'FIELD', targetId: hit.code, targetName: labelOf(code2label, hit.code),
            context: { settingType: 'CALC', settingName: `${f.label} の計算式` },
            confidence: CONF.LIKELY,
          });
        }
      }

      // ---- 8) JavaScript/CSSカスタマイズ ----
      // 現時点ではファイル本文を取得しないため「解析対象外」として明示だけ行う。
      // （Field Scanner 統合が次フェーズ。取得できないものを取得できるように見せない）
      const jsFiles = [
        ...((DATA?.customize?.desktop?.js || []).map(x => ({ ...x, target: 'desktop', kind: 'js' }))),
        ...((DATA?.customize?.desktop?.css || []).map(x => ({ ...x, target: 'desktop', kind: 'css' }))),
        ...((DATA?.customize?.mobile?.js || []).map(x => ({ ...x, target: 'mobile', kind: 'js' }))),
        ...((DATA?.customize?.mobile?.css || []).map(x => ({ ...x, target: 'mobile', kind: 'css' }))),
      ];
      for (const jf of jsFiles) {
        const name = jf?.file?.name || jf?.url || '(unknown)';
        addNode('CUSTOMIZE', `${jf.target}:${jf.kind}:${name}`, name, {
          target: jf.target, kind: jf.kind,
          analyzed: false, note: 'NOT_ANALYZED（Field Scanner統合で対応予定）',
        });
      }

      return {
        nodes, edges,
        meta: {
          appId: DATA?.appId ?? null,
          appName: DATA?.settings?.name ?? null,
          // ステータス名の検証に使う情報
          statusStates,
          statusFieldCodes,
          statusConditions,
          // プラグイン設定の中身はAPIで取得できないため、件数だけ保持して注意喚起に使う
          pluginCount: Array.isArray(DATA?.appPlugins?.plugins) ? DATA.appPlugins.plugins.length : null,
          generatedAt: new Date().toISOString(),
          fieldCount: fieldsN.length,
          edgeCount: edges.length,
          notAnalyzed: ['JavaScript/CSS本文', 'プラグイン設定内容', '他アプリからの被参照'],
        },
      };
    }

    // ================= Presentation 変換 =================

    // relationType -> 表示ラベル（バッジ用）
    const REL_LABEL = {
      DISPLAYS: '表示', FILTERS_BY: '条件', SORTS_BY: 'ソート',
      GROUPS_BY: '分類', AGGREGATES: '集計',
      NOTIFY_TARGET: '通知先', REMINDER_TIMING: '基準日時',
      ASSIGNS_BY: '作業者', EXECUTABLE_BY: '実行可能ユーザー', LOOKUP_KEY: '参照キー', LOOKUP_COPY_TO: 'コピー先',
      LOOKUP_PICKER: '取得元', REFERENCES: '計算参照',
      ACTION_MAPS_FROM: '転記元', ACL_CONDITION: 'ACL条件', ACL_TARGET: 'ACL対象',
      APP_REFERENCE: 'アプリ参照', HTML_REFERENCE: 'HTML記述',
      JS_READ: '読取', JS_WRITE: '書込', JS_CONTROL: '制御', JS_REFERENCE: '参照',
      REFERENCED_BY: '他アプリから参照',
    };
    const SRC_LABEL = {
      VIEW: '一覧', REPORT: 'グラフ', NOTIFICATION: '通知',
      PROCESS_STATE: 'プロセス', PROCESS_ACTION: 'プロセス',
      ACL: 'ACL', ACTION: 'アクション', FIELD: 'フィールド', CUSTOMIZE: 'JS',
    };

    /**
     * Fieldsタブ互換：フィールドコード -> 使用箇所文字列の配列
     * 例: 「一覧「顧客一覧」表示」「通知「変更通知」条件(推定)」
     * 既存の extractUsedFields の戻り値（string[]）と互換の形で返す
     */
    // 使用箇所サマリのカテゴリ（表示順つき）
    //   同じカテゴリの利用が何件あっても1つのバッジにまとめる。
    //   個別の設定名・確度・行番号は「変更影響」で確認する。
    const USAGE_CATEGORY_ORDER = [
      '一覧', 'グラフ', '通知', 'プロセス管理', 'アクセス権',
      'ルックアップ', '関連レコード', 'アプリアクション', '計算式', 'JavaScript', '他アプリ',
    ];

    /** エッジ1本から、使用箇所サマリのカテゴリ名を求める */
    function usageCategoryOf(edge) {
      if (edge.sourceType === 'FIELD') {
        const st = edge.context?.settingType || '';
        if (st === 'CALC') return '計算式';
        if (st.startsWith('LOOKUP')) return 'ルックアップ';
        if (st.startsWith('REFTABLE')) return '関連レコード';
        return 'フィールド';
      }
      const map = {
        VIEW: '一覧', REPORT: 'グラフ', NOTIFICATION: '通知',
        PROCESS_STATE: 'プロセス管理', PROCESS_ACTION: 'プロセス管理',
        ACL: 'アクセス権', ACTION: 'アプリアクション', CUSTOMIZE: 'JavaScript',
        EXTERNAL_APP: '他アプリ',
      };
      return map[edge.sourceType] || edge.sourceType;
    }

    /**
     * Fieldsタブの「使用箇所」表示用データ
     * どの種類の設定で使われているかだけを返す（例: ['一覧', '通知', 'JavaScript']）
     * 件数・設定名・確度は含めない（詳細は impactOf を参照）
     */
    function usageMapFromEdges(edges) {
      const map = {};
      for (const e of edges || []) {
        if (e.targetType !== 'FIELD') continue;
        if (!map[e.targetId]) map[e.targetId] = new Set();
        map[e.targetId].add(usageCategoryOf(e));
      }
      const rank = (c) => {
        const i = USAGE_CATEGORY_ORDER.indexOf(c);
        return i < 0 ? USAGE_CATEGORY_ORDER.length : i;
      };
      const out = {};
      for (const [code, set] of Object.entries(map)) {
        out[code] = [...set].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'ja'));
      }
      return out;
    }

    // ================= ステータス名の検証 =================

    /**
     * 条件式から、ステータスフィールドに指定されている値を抽出する
     *
     *   ステータス in ("完了", "承認待ち")
     *   ステータス = "未処理"
     *
     * フィールドコードと同じく、ステータス名を変更・削除しても
     * 条件式やJavaScriptの参照は置き去りになるため、突き合わせに使う。
     *
     * @returns {string[]} 指定されているステータス名
     */
    function extractStatusValues(cond, statusCodes) {
      const s = String(cond || '');
      if (!s || !statusCodes || !statusCodes.length) return [];
      const out = [];
      for (const code of statusCodes) {
        const safe = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // <ステータスフィールド> <演算子> ( "..." , "..." ) / "..."
        const rx = new RegExp(`${safe}\\s*(?:not\\s+in|in|!=|=)\\s*(\\([^)]*\\)|['"\`][^'"\`]*['"\`])`, 'g');
        let m;
        while ((m = rx.exec(s)) !== null) {
          const strRx = /['"`]([^'"`]+)['"`]/g;
          let sm;
          while ((sm = strRx.exec(m[1])) !== null) out.push(sm[1].trim());
        }
      }
      return [...new Set(out)];
    }

    /**
     * 設定の条件式に、存在しないステータス名が指定されていないか調べる
     * @returns {Array<{category, settingName, settingType, value}>}
     */
    function findUnknownStatusInSettings(deps) {
      const meta = deps?.meta || {};
      const known = new Set(meta.statusStates || []);
      const codes = meta.statusFieldCodes || [];
      // プロセス管理が無効、またはステータスフィールドが無ければ検証しない
      if (!known.size || !codes.length) return [];

      const rows = [];
      const seen = new Set();
      for (const c of (meta.statusConditions || [])) {
        for (const v of extractStatusValues(c.cond, codes)) {
          if (known.has(v)) continue;
          const key = `${c.category}|${c.settingName}|${v}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({ category: c.category, settingName: c.settingName, settingType: c.settingType, value: v });
        }
      }
      return rows;
    }

    // ================= 壊れた参照の検出 =================

    // 設定種別 → 表示名（どの設定のどの項目かが分かるようにする）
    const BROKEN_ROLE_LABEL = {
      VIEW_FIELDS: '一覧の表示フィールド',
      VIEW_SORT: '一覧のソート条件',
      VIEW_CALENDAR_DATE: 'カレンダー一覧の日付フィールド',
      VIEW_CALENDAR_TITLE: 'カレンダー一覧のタイトルフィールド',
      REPORT_GROUP: 'グラフの分類項目',
      REPORT_AGG: 'グラフの集計項目',
      REPORT_SORT: 'グラフのソート条件',
      GENERAL_NOTIFY_TARGET: 'アプリの条件通知の通知先（フィールド指定）',
      NOTIFY_TARGET: '条件通知の通知先（フィールド指定）',
      REMINDER_TIMING: 'リマインダーの基準日時',
      REMINDER_TARGET: 'リマインダーの通知先（フィールド指定）',
      PROCESS_ASSIGNEE: 'プロセス管理の作業者（フィールド指定）',
      PROCESS_EXECUTABLE_USER: 'プロセス管理のアクションの実行可能ユーザー（フィールド指定）',
      RECORD_ACL_ENTITY: 'レコードのアクセス権（フィールド指定）',
      FIELD_ACL_TARGET: 'フィールドのアクセス権の対象',
      FIELD_ACL_ENTITY: 'フィールドのアクセス権（フィールド指定）',
      LOOKUP_MAPPING: 'ルックアップのコピー先',
      REFTABLE_CONDITION: '関連レコードの条件',
      ACTION_MAPPING: 'アプリアクションの転記元',
    };

    /**
     * フォーム定義に存在しないフィールドコードを参照している設定を洗い出す
     *
     * 対象は「設定値としてフィールドコードが明示されている箇所」のみ。
     * 条件式・計算式・JavaScriptからの抽出はフィールド一覧を元に行っているため、
     * そもそも存在しないコードは出てこない（＝ここには含まれない）。
     * したがって検出結果は推測を含まず、確実に「壊れている」と言える。
     *
     * @returns {Array<{category, settingName, settingType, role, code}>}
     */
    function findBrokenRefs(deps) {
      const rows = [];
      const seen = new Set();

      // ---- ① JavaScript内に残った、存在しないフィールドコード ----
      //   kintoneはフィールドを削除すると一覧・通知などの設定からは自動的に取り除くが、
      //   JavaScriptは対象外のため、古い参照がそのまま残る。実務上はここが主戦場になる。
      for (const u of (deps?.meta?.unknownJsRefs || [])) {
        const fileText = (u.files || [])
          .map(f => `${f.name}${f.lines?.length ? `（${f.lines.map(n => `${n}行目`).join(', ')}）` : ''}`)
          .join(' / ');
        // 表記ゆれで一致していないだけの可能性がある場合は、確度を下げて候補を示す
        const near = u.nearMatch && u.nearMatch !== u.code ? u.nearMatch : null;
        rows.push({
          source: 'JS',
          category: 'JavaScript',
          settingName: (u.files || []).map(f => f.name).join(' / ') || '(unknown)',
          settingType: 'JS_UNKNOWN_FIELD',
          role: `コード参照（${(u.patterns || []).slice(0, 3).join(', ')}）`,
          code: u.code,
          confidence: near ? CONF.UNCERTAIN : (u.confidence === 'HIGH' ? CONF.LIKELY : CONF.UNCERTAIN),
          detail: near ? `${fileText} ／ 近い既存コード: ${near}` : fileText,
          count: u.count || 0,
          nearMatch: near,
        });
      }

      // ---- ③ 存在しないステータス名（JavaScript内の比較）----
      //   ステータス名を変更してもJavaScriptは追随しないため、条件が成立しなくなる
      for (const u of (deps?.meta?.unknownJsStatuses || [])) {
        const fileText = (u.files || [])
          .map(f => `${f.name}${f.lines?.length ? `（${f.lines.map(n => `${n}行目`).join(', ')}）` : ''}`)
          .join(' / ');
        rows.push({
          source: 'JS',
          category: 'JavaScript',
          settingName: (u.files || []).map(f => f.name).join(' / ') || '(unknown)',
          settingType: 'JS_UNKNOWN_STATUS',
          role: 'ステータス名との比較',
          code: u.value,
          confidence: CONF.LIKELY,
          detail: fileText,
          count: u.count || 0,
        });
      }

      // ---- ④ 存在しないステータス名（設定の条件式）----
      for (const u of findUnknownStatusInSettings(deps)) {
        rows.push({
          source: 'SETTING',
          category: u.category,
          settingName: u.settingName,
          settingType: u.settingType,
          role: '条件式のステータス指定',
          code: u.value,
          // 条件式からの抽出のため、確実とまでは言い切らない
          confidence: CONF.LIKELY,
          detail: '',
          count: 1,
        });
      }

      // ---- ② 設定値として記録されたフィールドコードのうち、存在しないもの ----
      for (const e of (deps?.edges || [])) {
        if (!e.context?.missing) continue;
        const st = e.context.settingType || '';
        const category = IMPACT_CATEGORY[e.sourceType] || e.sourceType;
        const settingName = (e.sourceType === 'FIELD')
          ? (e.context.settingName || e.sourceName || e.sourceId)
          : (e.sourceName || e.sourceId);
        const key = `${category}|${settingName}|${st}|${e.targetId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          source: 'SETTING',
          category,
          settingName,
          settingType: st,
          role: BROKEN_ROLE_LABEL[st] || st,
          code: e.targetId,
          confidence: CONF.CERTAIN,
          detail: '',
          count: 1,
        });
      }

      // 設定由来（確実）を先に、JS由来（推定）を後に並べる
      const srcRank = (s) => (s === 'SETTING' ? 0 : 1);
      const confRank = (c) => (c === CONF.CERTAIN ? 0 : c === CONF.LIKELY ? 1 : 2);
      rows.sort((a, b) =>
        srcRank(a.source) - srcRank(b.source) ||
        confRank(a.confidence) - confRank(b.confidence) ||
        String(a.category).localeCompare(String(b.category), 'ja') ||
        String(a.settingName).localeCompare(String(b.settingName), 'ja') ||
        String(a.code).localeCompare(String(b.code), 'ja')
      );
      return rows;
    }

    // ================= 変更影響分析 =================

    // 利用箇所のカテゴリ表示名（バッジの左側に出す種別）
    const IMPACT_CATEGORY = {
      VIEW: '一覧', REPORT: 'グラフ', NOTIFICATION: '通知',
      PROCESS_STATE: 'プロセス管理', PROCESS_ACTION: 'プロセス管理',
      ACL: 'アクセス権', ACTION: 'アプリアクション',
      FIELD: 'フィールド', CUSTOMIZE: 'JavaScript',
      EXTERNAL_APP: '他アプリ',
    };

    /**
     * 指定フィールドを変更・削除した場合の影響候補を集計する
     * @returns {{
     *   direct: Array, indirect: Array, crossApp: Array, cautions: Array,
     *   counts: {direct:number, indirect:number, crossApp:number}
     * }}
     * 注意：
     *  - 完全な静的解析ではないため、各項目に confidence（確実／可能性が高い／要確認）を必ず付ける
     *  - JavaScriptはField Scanner実行後のみ反映される（未実行なら cautions で明示する）
     */
    function impactOf(deps, fieldCode) {
      const edges = (deps && deps.edges) || [];
      const empty = { direct: [], indirect: [], crossApp: [], cautions: [], operations: [], counts: { direct: 0, indirect: 0, crossApp: 0 } };
      // 依存が1件も無くても「削除して問題ないか」の判断材料は必要なので、
      // fieldCode さえあれば通常の処理を続ける（operations は必ず生成される）
      if (!fieldCode) return empty;

      const relLabel = (r) => REL_LABEL[r] || r;
      const lineNote = (ctx) => (Array.isArray(ctx?.lines) && ctx.lines.length)
        ? `${ctx.lines.slice(0, 5).map(n => `${n}行目`).join(', ')}${ctx.lines.length > 5 ? ' ほか' : ''}`
        : '';

      // ---- 直接利用：このフィールドを参照している設定・コード ----
      // 表示用タイトル：JSはファイル名、フィールド起点は設定名、それ以外は 種別「名前」
      const titleOf = (e) => {
        const category = IMPACT_CATEGORY[e.sourceType] || e.sourceType;
        if (e.sourceType === 'CUSTOMIZE') return e.sourceName || e.sourceId;
        if (e.sourceType === 'FIELD') return e.context?.settingName || e.sourceName || e.sourceId;
        return `${category}「${e.sourceName || e.sourceId}」`;
      };
      // ラベルとコードが同じ場合は重複表示しない
      const nameWithCode = (name, code) => (name && name !== code) ? `${name}（${code}）` : String(code);

      const direct = [];
      for (const e of edges) {
        if (e.targetType !== 'FIELD' || e.targetId !== fieldCode) continue;
        const category = IMPACT_CATEGORY[e.sourceType] || e.sourceType;
        const title = titleOf(e);
        // JSはイベント種別が分かれば「いつ動くか」も添える
        const evsRaw = (e.sourceType === 'CUSTOMIZE') ? (deps?.meta?.jsEvents?.[e.sourceId] || []) : [];
        // {name, direct} 形式／旧・文字列形式の両方に対応する
        const evs = evsRaw.map(v => (typeof v === 'string')
          ? { name: v, direct: true }
          : { name: v?.name ?? '', direct: !!v?.direct });
        const evNote = evs.length
          ? `イベント: ${evs.slice(0, 3).map(v => v.direct ? v.name : `${v.name}?`).join(', ')}${evs.length > 3 ? ` ほか${evs.length - 3}件` : ''}`
          : '';
        const baseNote = lineNote(e.context);
        // 他アプリからの参照は、相手アプリのどの設定のどの役割かを添える（例: ルックアップ「商品」の参照キー）
        const inNote = (e.sourceType === 'EXTERNAL_APP')
          ? [
            (e.context?.kind && e.context?.settingName) ? `${e.context.kind}「${e.context.settingName}」` : '',
            e.context?.role || '',
          ].filter(Boolean).join('の')
          : '';

        direct.push({
          category,
          title,
          role: relLabel(e.relationType),
          confidence: e.confidence,
          note: [baseNote, evNote, inNote].filter(Boolean).join(' / '),
          sourceType: e.sourceType,
          relationType: e.relationType,
        });
      }

      // ---- 間接利用：このフィールドを計算式で参照しているフィールドの、さらに利用先（1段のみ）----
      const calcDependents = edges
        .filter(e => e.relationType === REL.REFERENCES && e.targetId === fieldCode && e.sourceType === 'FIELD')
        .map(e => ({ code: e.sourceId, name: e.sourceName || e.sourceId }));

      const indirect = [];
      const seenIndirect = new Set();
      for (const dep of calcDependents) {
        // 計算フィールド自体（値が変わる可能性がある）
        const key0 = `CALC:${dep.code}`;
        if (!seenIndirect.has(key0)) {
          seenIndirect.add(key0);
          indirect.push({
            category: '計算フィールド',
            title: nameWithCode(dep.name, dep.code),
            role: 'このフィールドを計算式で参照',
            via: null,
            confidence: CONF.LIKELY,
          });
        }
        // その計算フィールドを利用している箇所
        for (const e of edges) {
          if (e.targetType !== 'FIELD' || e.targetId !== dep.code) continue;
          if (e.sourceType === 'FIELD' && e.sourceId === fieldCode) continue; // 起点そのものは除く
          const category = IMPACT_CATEGORY[e.sourceType] || e.sourceType;
          const title = titleOf(e);
          const key = `${category}|${title}|${e.relationType}`;
          if (seenIndirect.has(key)) continue;
          seenIndirect.add(key);
          indirect.push({
            category, title,
            role: relLabel(e.relationType),
            via: `${nameWithCode(dep.name, dep.code)}経由`,
            confidence: CONF.LIKELY, // 間接のため確実とは扱わない
          });
        }
      }

      // ---- 他アプリ連携 ----
      const crossApp = [];
      const pushCross = (text, confidence, note) => {
        if (crossApp.some(c => c.text === text)) return;
        crossApp.push({ text, confidence, note: note || '' });
      };
      for (const e of edges) {
        // このフィールド自身が他アプリを参照している（ルックアップ／関連レコード）
        if (e.sourceType === 'FIELD' && e.sourceId === fieldCode) {
          const st = e.context?.settingType;
          if (e.relationType === REL.APP_REFERENCE) {
            const verb = st === 'LOOKUP' ? 'から値を取得' : st === 'REFERENCE_TABLE' ? 'のレコードを表示' : 'を参照';
            pushCross(`${appLabel(deps, e.targetId)}${verb}`, e.confidence);
          } else if (e.relationType === REL.LOOKUP_KEY) {
            pushCross(`${appLabel(deps, e.context?.appId)} の「${e.targetName}」を参照キーに使用`, e.confidence);
          }
        }
        // 他アプリから参照されている（走査済みの場合のみ）
        if (e.relationType === REL.REFERENCED_BY && e.targetId === fieldCode) {
          const kind = e.context?.kind || '参照';
          const via = e.context?.settingName ? `「${e.context.settingName}」` : '';
          // 役割（参照キー／コピー元／転記先）が分かる場合は文中に入れる
          const how = e.context?.role ? `の${e.context.role}として` : 'から';
          pushCross(`${e.sourceName} の${kind}${via}${how}参照されている`, e.confidence, e.context?.note || '');
        }
        // アプリアクションの転記元になっている
        if (e.relationType === REL.ACTION_MAPS_FROM && e.targetId === fieldCode) {
          const appEdge = edges.find(x =>
            x.sourceType === 'ACTION' && x.sourceId === e.sourceId && x.relationType === REL.APP_REFERENCE);
          const appTxt = appEdge ? appLabel(deps, appEdge.targetId) : '接続先アプリ';
          pushCross(`アプリアクション「${e.sourceName}」で ${appTxt} へ値を転記`, e.confidence);
        }
      }

      // ---- 変更時の確認事項（操作の種類ごとに整理する）----
      // kintoneはフィールドコードを変更・削除すると、一覧・通知・条件式などの
      // 「アプリ設定側」は自動的に追随する。追随しないのは JavaScript とプラグイン設定。
      // この違いを踏まえて、操作ごとに見るべき箇所を分ける。
      const has = (fn) => direct.some(fn);
      const jsRows = direct.filter(d => d.sourceType === 'CUSTOMIZE');
      const jsFiles = [...new Set(jsRows.map(d => d.title))];
      const pluginCount = deps?.meta?.pluginCount;
      const scannerDone = !!(deps?.meta?.scannerMergedAt);

      // 選択肢を持つフィールドかどうか（「選択肢を変更する場合」を出すかの判定に使う）
      const fieldNode = (deps?.nodes || []).find(n => n.id === `FIELD:${fieldCode}`);
      const fieldType = fieldNode?.fieldType || '';
      const hasOptions = ['DROP_DOWN', 'RADIO_BUTTON', 'CHECK_BOX', 'MULTI_SELECT'].includes(fieldType);

      const ops = [];
      // 主要な操作区分は常に表示する（区分が消えると「見落としたのか該当なしなのか」が分からないため）
      const addOp = (key, label, notes, emptyNote) => {
        const list = notes.filter(Boolean);
        if (!list.length && emptyNote) list.push(emptyNote);
        if (list.length) ops.push({ key, label, notes: list });
      };

      // 1) フィールドコードの変更
      const codeChange = [];
      if (jsFiles.length) {
        codeChange.push(`JavaScript（${jsFiles.join(' / ')}）の修正が必要です。アプリ設定と違い、JavaScriptはコード変更に追随しません。`);
      }
      if (pluginCount) {
        codeChange.push(`プラグイン設定（${pluginCount}個）でこのフィールドを指定している場合、手動での修正が必要です（設定内容はAPIで取得できないため未確認）。`);
      }
      if (!jsFiles.length && !pluginCount) {
        codeChange.push('一覧・通知・条件式などのアプリ設定は、コード変更に自動的に追随します。手動修正が必要な参照は検出されていません。');
      }
      addOp('CODE_CHANGE', 'フィールドコードを変更する場合', codeChange,
        'アプリ設定は自動的に追随します。手動修正が必要な参照は検出されていません。');

      // 2) フィールド型の変更
      const typeChange = [];
      if (has(d => d.relationType === REL.REFERENCES)) {
        typeChange.push('他フィールドの計算式から参照されています。型が変わると計算結果が変わる、またはエラーになる可能性があります。');
      }
      if (has(d => d.relationType === REL.FILTERS_BY || d.relationType === REL.SORTS_BY)) {
        typeChange.push('条件式・ソート指定に使われています。型によって比較方法や指定できる演算子が変わります。');
      }
      if (has(d => d.relationType === REL.AGGREGATES || d.relationType === REL.GROUPS_BY)) {
        typeChange.push('グラフの分類・集計に使われています。型によっては集計できなくなります。');
      }
      if (has(d => d.relationType === REL.LOOKUP_COPY_TO)) {
        typeChange.push('ルックアップのコピー先です。参照元フィールドと型が一致しないと設定できません。');
      }
      addOp('TYPE_CHANGE', 'フィールド型を変更する場合', typeChange,
        '型に依存する利用箇所（計算式・条件式・グラフ集計・ルックアップ）は検出されていません。');

      // 3) 選択肢の変更（選択肢を持つフィールドのみ意味を持つ）
      const optionChange = [];
      if (has(d => d.relationType === REL.FILTERS_BY)) {
        optionChange.push('条件式で選択肢の値を直接指定している場合、その条件が一致しなくなります（一覧・通知・アクセス権などの絞り込み条件を確認してください）。');
      }
      if (jsFiles.length) {
        optionChange.push('JavaScriptで選択肢の値を比較・代入している可能性があります。');
      }
      // 選択肢を持つフィールドのときだけ出す（数値フィールド等では意味がないため）
      if (hasOptions) {
        addOp('OPTION_CHANGE', '選択肢を変更する場合', optionChange,
          '選択肢の値を条件式やJavaScriptで直接指定している箇所は検出されていません。');
      }

      // 4) 削除
      const del = [];
      const totalUse = direct.length + indirect.length + crossApp.length;
      if (totalUse) {
        // 件数はいずれも「設定（依存関係）の件数」。他アプリ連携は参照元アプリ数ではなく連携の件数
        del.push(`直接 ${direct.length} 件／間接 ${indirect.length} 件／他アプリ連携 ${crossApp.length} 件の設定から参照されています。削除するとこれらの設定から取り除かれます。`);
      } else {
        del.push('解析範囲内では利用箇所が見つかりませんでした（解析対象外の設定で使われている可能性はあります）。');
      }
      if (has(d => d.relationType === REL.REFERENCES)) {
        del.push('計算式から参照されているため、削除すると計算式がエラーになります。');
      }
      if (has(d => d.relationType === REL.ASSIGNS_BY)) {
        del.push('プロセス管理の作業者に指定されています。削除するとワークフローが止まる可能性があります。');
      }
      if (has(d => d.relationType === REL.REMINDER_TIMING)) {
        del.push('リマインダー通知の基準日時です。削除すると通知が動作しなくなります。');
      }
      if (has(d => d.relationType === REL.ACL_TARGET || d.relationType === REL.ACL_CONDITION)) {
        del.push('アクセス権の設定に使われています。削除後に意図しない公開範囲にならないか確認してください。');
      }
      if (has(d => d.relationType === REL.LOOKUP_COPY_TO)) {
        del.push('ルックアップのコピー先です。ルックアップ設定の見直しが必要です。');
      }
      if (crossApp.length) {
        del.push('他アプリとの連携に関わります。接続先アプリ側の設定も確認してください。');
      }
      if (jsFiles.length) {
        del.push(`JavaScript（${jsFiles.join(' / ')}）が参照しているため、削除すると実行時エラーになる可能性があります。`);
      }
      addOp('DELETE', 'フィールドを削除する場合', del);

      // 5) 共通（解析範囲の制約）
      const common = [];
      if (!deps?.meta?.incomingScannedAt) {
        common.push('他アプリからこのアプリへの参照は未走査です。Relationsタブの「他アプリからの参照」で走査すると反映されます。');
      }
      if (!scannerDone) {
        common.push('JavaScriptカスタマイズは未解析です。Field Scannerで「Scan」を実行すると、JSからの参照が反映されます。');
      }
      if (pluginCount) {
        common.push(`このアプリには${pluginCount}個のプラグインが追加されています。プラグイン設定の内容はAPIで取得できないため解析対象外です。各プラグインの設定画面で確認してください。`);
      }
      addOp('COMMON', '解析範囲について', common);

      // 旧形式（フラットな注意書き）も残す：既存の呼び出し側との互換のため
      const cautions = ops.flatMap(o => o.notes);

      return {
        direct, indirect, crossApp, cautions,
        operations: ops,
        counts: { direct: direct.length, indirect: indirect.length, crossApp: crossApp.length },
      };
    }

    // ================= アプリ名の解決 =================

    /**
     * 他アプリからの被参照（KTIncoming の走査結果）を依存関係データへ取り込む
     * - 相手アプリのフォーム設定から得た確実な情報のため confidence は CERTAIN
     * - 再走査時は入れ替える（重複させない）
     */
    function applyIncomingRefs(deps, incoming) {
      if (!deps || !Array.isArray(deps.edges)) return deps;
      const rows = (incoming && incoming.rows) || [];

      // 既存の被参照エッジを除去（再走査時の重複防止）
      deps.edges = deps.edges.filter(e => e.sourceType !== 'EXTERNAL_APP');

      const code2label = new Map(
        (deps.nodes || [])
          .filter(n => n.type === 'FIELD')
          .map(n => [String(n.id).replace(/^FIELD:/, ''), n.name])
      );

      for (const r of rows) {
        // このアプリ側のどのフィールドが参照されているか（役割ごとに集め、同じフィールドは1本のエッジにまとめる）
        //   - アプリアクション: destFields（転記先。複数なら展開する）
        //   - ルックアップ:     targetField（参照キー）＋ copyFields[].from（「ほかのフィールドのコピー」のコピー元）
        //   - 関連レコード:     targetField（突合に使うこのアプリ側のフィールド）
        const targets = new Map(); // code -> { roles: string[], notes: string[] }
        const addTarget = (code, role, note) => {
          const c = String(code ?? '').trim();
          if (!c) return;
          const t = targets.get(c) || { roles: [], notes: [] };
          if (role && !t.roles.includes(role)) t.roles.push(role);
          if (note && !t.notes.includes(note)) t.notes.push(note);
          targets.set(c, t);
        };
        if (Array.isArray(r.destFields) && r.destFields.length) {
          r.destFields.forEach(code => addTarget(code, '転記先', r.note || ''));
        } else if (r.targetField) {
          addTarget(r.targetField, r.kind === 'ルックアップ' ? '参照キー' : '', r.note || '');
        }
        for (const cf of (Array.isArray(r.copyFields) ? r.copyFields : [])) {
          const from = (cf && typeof cf === 'object') ? cf.from : cf;
          const to = (cf && typeof cf === 'object') ? (cf.to || '') : '';
          addTarget(from, 'コピー元', to ? `「${to}」へコピー` : '');
        }
        if (!targets.size) continue;

        for (const [code, t] of targets) {
          addNodeTo(deps, 'EXTERNAL_APP', r.appId, `app ${r.appId} ${r.appName || ''}`.trim());
          deps.edges.push({
            sourceType: 'EXTERNAL_APP', sourceId: r.appId,
            sourceName: r.appName ? `app ${r.appId} ${r.appName}` : `app ${r.appId}`,
            relationType: REL.REFERENCED_BY,
            targetType: 'FIELD', targetId: code, targetName: code2label.get(code) || code,
            context: {
              settingType: `INCOMING_${r.kind}`, settingName: r.sourceLabel || r.sourceField,
              kind: r.kind,
              role: t.roles.join('・'),   // 参照キー／コピー元／転記先（複数の役割は「・」で連結）
              note: t.notes.join('／'),
            },
            confidence: CONF.CERTAIN,
          });
        }
      }

      deps.meta = deps.meta || {};
      deps.meta.incomingScannedAt = incoming?.scannedAt || null;
      deps.meta.incomingStats = incoming?.stats || null;
      return deps;
    }

    /**
     * 参照先アプリの名前を依存関係データへ反映する
     * - 解決できたものだけ meta.appNames に入れる（未解決は「取得不可」として扱う）
     */
    function applyAppNames(deps, nameMap) {
      if (!deps || !nameMap) return deps;
      deps.meta = deps.meta || {};
      deps.meta.appNames = deps.meta.appNames || {};
      for (const [id, name] of nameMap) deps.meta.appNames[String(id)] = name;

      // ノード名も更新しておく（グラフ表示などで再利用するため）
      for (const n of deps.nodes || []) {
        if (n.type !== 'APP') continue;
        const id = String(n.id).replace(/^APP:/, '');
        const nm = deps.meta.appNames[id];
        if (nm) n.name = `app ${id} ${nm}`;
      }
      return deps;
    }

    /**
     * アプリIDの表示文字列を作る
     * 解決済み: 「app 100 顧客管理」／未解決: 「app 100（名称取得不可）」
     */
    function appLabel(deps, appId, { withNote = true } = {}) {
      const id = String(appId ?? '');
      if (!id || id === 'UNKNOWN') return '不明';
      const nm = deps?.meta?.appNames?.[id];
      if (nm) return `app ${id} ${nm}`;
      return withNote ? `app ${id}（名称取得不可）` : `app ${id}`;
    }

    // ================= アプリ間依存（JS内のアプリID参照） =================

    /**
     * JavaScript本文から「他アプリのアプリID参照」を抽出する
     * 検出対象:
     *   app: 123 / app: '123' / appId: 123          → 数値リテラル（確度: 中）
     *   app: SOME_APP_ID / app: CONFIG.appId        → 変数参照（値は不明。確度: 低）
     *   kintone.api.url('/k/v1/records.json') 付近の app 指定
     *   URL内のアプリID  /k/123/ , /k/123/show
     * 注意:
     *   - 正規表現ベースの推定であり、実行時にしか決まらない値は取得できない
     *   - 自アプリID・kintone.app.getId() 由来は除外できないため呼び出し側で除去する
     * @returns {Array<{appId:string|null, raw:string, line:number, kind:string, confidence:string}>}
     */
    function extractAppIdRefs(text, lineIndexFn) {
      const s = String(text || '');
      if (!s) return [];
      const out = [];
      const push = (appId, raw, index, kind, confidence) => {
        out.push({
          appId: appId ?? null,
          raw: String(raw || '').trim().slice(0, 80),
          line: lineIndexFn ? lineIndexFn(index) : null,
          kind, confidence,
        });
      };

      // 1) app: 123 / app: '123' / appId: 123 / "app": 123
      const rxNum = /['"]?\b(?:app|appId|appID|app_id)['"]?\s*[:=]\s*['"]?(\d{1,7})['"]?/g;
      let m;
      while ((m = rxNum.exec(s)) !== null) push(m[1], m[0], m.index, 'LITERAL', 'MEDIUM');

      // 2) app: 変数・定数・プロパティ参照（値は静的には決まらない）
      const rxVar = /['"]?\b(?:app|appId|appID|app_id)['"]?\s*[:=]\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*)/g;
      while ((m = rxVar.exec(s)) !== null) {
        const ident = m[1];
        // 自アプリ取得は他アプリ参照ではないので除外
        if (/^(kintone|event|this|record)\b/.test(ident)) continue;
        push(null, m[0], m.index, 'VARIABLE', 'LOW');
      }

      // 3) URL内のアプリID  /k/123/ （/k/v1/ 等のAPIパスは除外）
      const rxUrl = /\/k\/(\d{1,7})(?=[/'"`?\s])/g;
      while ((m = rxUrl.exec(s)) !== null) push(m[1], m[0], m.index, 'URL', 'MEDIUM');

      return out;
    }

    /**
     * 依存関係データから「アプリ間依存一覧（自アプリ → 他アプリ）」を作る
     * dataSource で情報の取得元・信頼性を区別する:
     *   SETTING : アプリ設定APIから確実に取得（ルックアップ/関連レコード/アクション）
     *   JS_STATIC: JavaScriptの静的解析による推定（値が変数の場合は特定不可）
     * なお「他アプリから自アプリへの参照」はアプリ設定APIでは取得できないため、
     * この一覧には含めない（呼び出し側で注記を表示すること）
     */
    function buildAppLinks(deps, selfAppId) {
      const rows = [];
      const edges = (deps && deps.edges) || [];
      const self = String(selfAppId ?? '');

      // 対象アプリごとの補足情報（参照キー・マッピング数）を集める
      const byField = new Map(); // sourceId(FIELD) -> { keys:[], copies:0, picks:[] }
      for (const e of edges) {
        if (e.sourceType !== 'FIELD') continue;
        if (!['LOOKUP_KEY', 'LOOKUP_COPY_TO', 'LOOKUP_PICKER'].includes(e.relationType)) continue;
        let a = byField.get(e.sourceId);
        if (!a) { a = { keys: [], copies: 0, picks: [] }; byField.set(e.sourceId, a); }
        if (e.relationType === 'LOOKUP_KEY') a.keys.push(e.targetName);
        if (e.relationType === 'LOOKUP_COPY_TO') a.copies++;
        if (e.relationType === 'LOOKUP_PICKER') a.picks.push(e.targetName);
      }

      // 自アプリ参照の表示ラベル（例：関連レコード一覧で自アプリの他レコードを表示する設定）
      //   自アプリ名は meta.appName（/k/v1/app/settings 由来）から補う
      const selfLabel = (id) => {
        const nm = deps?.meta?.appName;
        return `app ${id}${nm ? ' ' + nm : ''}（このアプリ）`;
      };

      for (const e of edges) {
        if (e.relationType !== REL.APP_REFERENCE) continue;
        if (e.targetType !== 'APP') continue;
        // ★修正（v2.2.1）：自アプリ参照を除外しない。
        //   関連レコード一覧が自アプリ自身を参照する設定は、詳細（Related Records）には
        //   表示される一方、この概要からは除外されており、件数が不整合になっていた。
        //   接続先アプリ単位ではなく「設定単位で1行」表示し、自アプリは「（このアプリ）」と明示する。
        //   ※ JS解析由来（JS_APP_ID）の自アプリ参照はスキャン側（scanOnce）で除外済みのため、
        //     ここで self 除外を外しても JS 由来の自アプリ行は増えない。
        const isSelf = String(e.targetId) === self;

        const st = e.context?.settingType || '';
        let kind = st, note = '', destField = '';

        if (st === 'LOOKUP') {
          kind = 'ルックアップ';
          const a = byField.get(e.sourceId) || { keys: [], copies: 0 };
          destField = a.keys[0] || '';
          note = a.copies ? `${a.copies}項目を取得` : '';
        } else if (st === 'REFERENCE_TABLE') {
          kind = '関連レコード';
          // ★v2.2.1：接続先キーは「接続先フィールド」列、自アプリ側キーは行の selfKey で表示する。
          //   備考はキーの重複表示を避け、表示フィールド数の概要に留める（詳細はDetails側）。
          destField = e.context?.condRelatedField || '';
          note = (e.context?.displayCount != null)
            ? `${e.context.displayCount}フィールド表示`
            : '関連レコード一覧で表示';
        } else if (st === 'ACTION') {
          kind = 'アプリアクション';
          const maps = edges.filter(x => x.sourceId === e.sourceId && x.relationType === REL.ACTION_MAPS_FROM).length;
          note = maps ? `${maps}項目を転記` : '';
          destField = maps > 1 ? '複数' : '';
        } else if (st === 'JS_APP_ID') {
          kind = 'JavaScript';
          destField = '不明';
          note = e.context?.note || 'JS内でアプリIDを参照';
        }

        rows.push({
          kind,
          // Summary行 → Details該当カードへのジャンプ用（フィールドコード／アクションID）
          sourceId: e.sourceId,
          selfSide: e.sourceName || e.sourceId,
          // 自アプリ側の接続キー（関連レコードのみ。「自アプリ側」列に ↳ 付きで補足表示する）
          selfKey: st === 'REFERENCE_TABLE' ? (e.context?.condField || '') : '',
          destAppId: e.targetId === 'UNKNOWN' ? '不明' : String(e.targetId),
          // 表示用のアプリ名（未解決なら「名称取得不可」、自アプリなら「（このアプリ）」を明示）
          destAppLabel: isSelf ? selfLabel(e.targetId) : appLabel(deps, e.targetId),
          destField: destField || '—',
          note: note || '—',
          confidence: e.confidence,
          dataSource: st === 'JS_APP_ID' ? 'JS_STATIC' : 'SETTING',
          lines: e.context?.lines || null,
        });
      }

      // 種別 → 接続先アプリID の順で安定ソート
      const order = { 'ルックアップ': 1, '関連レコード': 2, 'アプリアクション': 3, 'JavaScript': 4 };
      rows.sort((a, b) =>
        (order[a.kind] || 9) - (order[b.kind] || 9) ||
        String(a.destAppId).localeCompare(String(b.destAppId), 'ja', { numeric: true }) ||
        String(a.selfSide).localeCompare(String(b.selfSide), 'ja')
      );
      return rows;
    }

    /**
     * Field Scanner の解析結果を依存関係データへ合流させる（再スキャン時は入替え）
     * - 正規表現ベースの静的解析のため、confidence は最大でも LIKELY（確定情報にしない）
     * - スキャン対象（desktop/mobile, JS/CSS）の範囲内のみが反映される点に注意
     */
    // 既存の依存データへノードを後から安全に追加する（重複はスキップ）
    function addNodeTo(deps, type, id, name, extra = {}) {
      if (!deps || !Array.isArray(deps.nodes) || !id) return;
      const key = `${type}:${id}`;
      if (deps.nodes.some(n => n.id === key)) return;
      deps.nodes.push({ id: key, type, name: name ?? String(id), ...extra });
    }

    function mergeScannerEdges(deps, scan) {
      if (!deps || !Array.isArray(deps.edges) || !scan) return deps;

      // 既存のScanner由来エッジ（フィールド利用・アプリID参照とも）を除去（再スキャン時の重複防止）
      deps.edges = deps.edges.filter(e => e.sourceType !== 'CUSTOMIZE');

      const ACCESS2REL = {
        READ: REL.JS_READ, WRITE: REL.JS_WRITE,
        ELEMENT: REL.JS_CONTROL, SHOW_HIDE: REL.JS_CONTROL, CONTROL: REL.JS_CONTROL,
        FIELDS_PARAM: REL.JS_READ, QUERY: REL.JS_READ,
        // 関数へ渡す・配列に列挙は、読み書きのどちらかを断定できないため「参照」として扱う
        ARGUMENT: REL.JS_REFERENCE, LIST: REL.JS_REFERENCE,
        OTHER: REL.JS_REFERENCE,
      };
      const CONF2 = { HIGH: CONF.LIKELY, MEDIUM: CONF.LIKELY, LOW: CONF.UNCERTAIN };

      // (対象ファイル, フィールド, 関係種別) 単位に集約する
      const agg = new Map();
      for (const r of scan.results || []) {
        for (const m of r.matches || []) {
          const rel = ACCESS2REL[m.access] || REL.JS_REFERENCE;
          const srcId = `${m.target}:${m.kind}:${m.file}`; // CUSTOMIZEノードのIDと揃える
          const key = `${srcId}|${r.code}|${rel}`;
          let a = agg.get(key);
          if (!a) {
            a = {
              srcId, file: m.file, target: m.target, code: r.code, label: r.label || r.code,
              rel, conf: CONF2[m.confidence] || CONF.UNCERTAIN, lines: [], count: 0,
            };
            agg.set(key, a);
          }
          a.count++;
          if (a.lines.length < 10) a.lines.push(m.line);
          // 集約内で最も高い確度を採用する
          if ((CONF2[m.confidence] || CONF.UNCERTAIN) === CONF.LIKELY) a.conf = CONF.LIKELY;
        }
      }
      // 依存データにノードが無いコード（グループフィールドなど、form/fields に現れないもの）を補う
      const knownNodeIds = new Set((deps.nodes || []).map(n => n.id));
      const typeByCode = new Map((scan.results || []).map(r => [r.code, r.type]));

      for (const a of agg.values()) {
        if (!knownNodeIds.has(`FIELD:${a.code}`)) {
          knownNodeIds.add(`FIELD:${a.code}`);
          addNodeTo(deps, 'FIELD', a.code, a.label, {
            fieldType: typeByCode.get(a.code) || 'UNKNOWN',
            fromScanner: true, // フォーム定義には無く、JS解析でのみ現れたコード
          });
        }
        deps.edges.push({
          sourceType: 'CUSTOMIZE', sourceId: a.srcId, sourceName: a.file,
          relationType: a.rel,
          targetType: 'FIELD', targetId: a.code, targetName: a.label,
          context: {
            settingType: 'JS', settingName: a.file, target: a.target,
            lines: a.lines, matchCount: a.count,
          },
          confidence: a.conf,
        });
      }

      // ★アプリID参照（JS静的解析）をアプリ間依存エッジとして追加
      //   値が変数の場合はアプリIDを特定できないため targetId は 'UNKNOWN' とする
      //   (対象ファイル, 接続先アプリ) 単位に集約する。ファイルはフィールド利用と同じく target を含むIDで識別する
      //   （ファイル名だけで集約すると、PC用とモバイル用の同名ファイルが1件に合流し、片方の参照が欠落する）
      const appAgg = new Map();
      for (const ref of scan.appRefs || []) {
        const appId = ref.appId || 'UNKNOWN';
        const srcId = `${ref.target}:js:${ref.file}`; // CUSTOMIZEノードのIDと揃える
        const key = `${srcId}|${appId}`;
        let a = appAgg.get(key);
        if (!a) {
          a = { srcId, file: ref.file, target: ref.target, appId, lines: [], kinds: new Set(), count: 0 };
          appAgg.set(key, a);
        }
        a.count++;
        a.kinds.add(ref.kind);
        if (a.lines.length < 10) a.lines.push(ref.line);
      }
      for (const a of appAgg.values()) {
        const isUnknown = a.appId === 'UNKNOWN';
        if (!isUnknown) addNodeTo(deps, 'APP', a.appId, `app ${a.appId}`, { self: false, viaJs: true });
        deps.edges.push({
          sourceType: 'CUSTOMIZE', sourceId: a.srcId, sourceName: a.file,
          relationType: REL.APP_REFERENCE,
          targetType: 'APP', targetId: a.appId, targetName: isUnknown ? '不明（変数指定）' : `app ${a.appId}`,
          context: {
            settingType: 'JS_APP_ID', settingName: a.file, target: a.target,
            lines: a.lines, matchCount: a.count,
            note: isUnknown
              ? '変数でアプリIDを指定（静的解析では特定不可）'
              : `JS内にアプリID記述（${[...a.kinds].join('/')}）`,
          },
          // リテラルでも「実際に呼ばれるか」までは判定できないため UNCERTAIN 止まり
          confidence: CONF.UNCERTAIN,
        });
      }

      // ★REST APIパラメータで外部アプリが明示されたフィールド参照（{ app: 1112, fields / record }）
      //   自アプリのフィールドではないため EXTERNAL_FIELD（相手アプリ側のフィールド）として表現する。
      //   ルックアップの参照キーと同じ形（context.appId）にしておくと、グラフでは接続先アプリノードに畳まれる。
      for (const r of scan.externalRefs || []) {
        if (!r || !r.appId || !r.code) continue;
        addNodeTo(deps, 'APP', r.appId, `app ${r.appId}`, { self: false, viaJs: true });
        deps.edges.push({
          sourceType: 'CUSTOMIZE', sourceId: `${r.target}:js:${r.file}`, sourceName: r.file,
          relationType: r.access === 'WRITE' ? REL.JS_WRITE : REL.JS_READ,
          targetType: 'EXTERNAL_FIELD', targetId: `${r.appId}:${r.code}`, targetName: r.code,
          context: {
            settingType: 'JS_EXTERNAL_FIELD', settingName: r.file, target: r.target, appId: String(r.appId),
            lines: r.lines || [], matchCount: r.count || 0,
            note: `REST API${r.via ? `（${r.via}）` : ''}で app ${r.appId} の「${r.code}」を${r.access === 'WRITE' ? '更新' : '取得'}`,
          },
          // 静的解析による推定のため確定情報にはしない
          confidence: CONF.UNCERTAIN,
        });
      }

      // ★JavaScriptのイベント種別を保持する（このファイルがいつ動くかの手がかり）
      deps.meta = deps.meta || {};
      deps.meta.jsEvents = { ...(scan.fileEvents || {}) };
      // ★JS内に残った「存在しないフィールドコード」も保持する（整合性チェックで使う）
      deps.meta.unknownJsRefs = Array.isArray(scan.unknownRefs) ? scan.unknownRefs : [];
      deps.meta.unknownJsStatuses = Array.isArray(scan.unknownStatuses) ? scan.unknownStatuses : [];

      // CUSTOMIZEノードを解析済みに更新し、meta の未解析一覧から本文解析を外す
      for (const n of deps.nodes || []) {
        if (n.type !== 'CUSTOMIZE') continue;
        n.analyzed = true;
        n.note = 'Field Scanner解析済み';
        const evs = deps.meta.jsEvents[String(n.id).replace(/^CUSTOMIZE:/, '')];
        if (evs && evs.length) n.events = evs;
      }
      if (deps.meta) {
        deps.meta.notAnalyzed = (deps.meta.notAnalyzed || []).filter(x => x !== 'JavaScript/CSS本文');
        deps.meta.scannerMergedAt = new Date().toISOString();
        deps.meta.edgeCount = deps.edges.length;
      }
      return deps;
    }

    // ================= 部分依存グラフ =================

    // グラフの表示カテゴリ（絞り込み用）。edge の sourceType / relationType から判定する
    // color は図のノード色と対応させる（チェックボックスの色見本に使う）
    const GRAPH_SCOPES = {
      CALC: { label: '計算式', color: '#2563eb', colorDark: '#60a5fa', match: (e) => e.relationType === REL.REFERENCES },
      VIEW_REPORT: { label: '一覧・グラフ', color: '#16a34a', colorDark: '#4ade80', match: (e) => e.sourceType === 'VIEW' || e.sourceType === 'REPORT' },
      NOTIFICATION: { label: '通知', color: '#f59e0b', colorDark: '#fbbf24', match: (e) => e.sourceType === 'NOTIFICATION' },
      PROCESS: { label: 'プロセス管理', color: '#f59e0b', colorDark: '#fbbf24', match: (e) => e.sourceType === 'PROCESS_STATE' || e.sourceType === 'PROCESS_ACTION' },
      JS: { label: 'JavaScript', color: '#ec4899', colorDark: '#f472b6', match: (e) => e.sourceType === 'CUSTOMIZE' },
      ACL: { label: 'アクセス権', color: '#a855f7', colorDark: '#c084fc', match: (e) => e.sourceType === 'ACL' },
      APP_LINK: {
        label: 'アプリ間連携',
        color: '#06b6d4', colorDark: '#22d3ee',
        // ★修正：ルックアップのコピー先・参照キー・取得元、アプリアクションの転記元が
        //   どのカテゴリにも該当せず、グラフから抜け落ちていた
        match: (e) => e.targetType === 'APP' || e.targetType === 'EXTERNAL_FIELD'
          || e.sourceType === 'ACTION'
          || [REL.LOOKUP_KEY, REL.LOOKUP_COPY_TO, REL.LOOKUP_PICKER, REL.ACTION_MAPS_FROM].includes(e.relationType)
          || String(e.context?.settingType || '').startsWith('LOOKUP')
          || String(e.context?.settingType || '').startsWith('REFTABLE')
          || e.context?.settingType === 'REFERENCE_TABLE'
          || e.context?.settingType === 'ACTION',
      },
    };
    const GRAPH_SCOPE_KEYS = Object.keys(GRAPH_SCOPES);

    /**
     * 表示対象の部分グラフを組み立てる
     * @param {object} opt.focusId 起点ノードID（例 'FIELD:顧客コード'）。未指定なら絞り込み結果全体
     * @param {string[]} opt.scopes 表示するカテゴリ（GRAPH_SCOPESのキー）。空なら全カテゴリ
     * @param {number} opt.depth 起点からの距離（1=直接依存のみ、2=間接依存まで）
     * @param {boolean} opt.fieldsOnly true ならフィールド同士の関係のみ
     * @param {number} opt.maxNodes ノード数の上限（超過時は truncated=true を返す）
     * @returns {{nodes:Array, edges:Array, truncated:boolean, totalNodes:number, totalEdges:number}}
     */
    function buildSubgraph(deps, opt = {}) {
      const {
        focusId = null, scopes = [], depth = 1,
        fieldsOnly = false, maxNodes = 60,
        foldExternalFields = true,
      } = opt;

      const allEdges = (deps && deps.edges) || [];
      const nodeById = new Map(((deps && deps.nodes) || []).map(n => [n.id, n]));

      // ---- 1) カテゴリで絞り込む ----
      const activeScopes = (scopes && scopes.length) ? scopes : GRAPH_SCOPE_KEYS;
      let edges = allEdges.filter(e =>
        activeScopes.some(k => GRAPH_SCOPES[k] && GRAPH_SCOPES[k].match(e)));

      if (fieldsOnly) {
        edges = edges.filter(e => e.sourceType === 'FIELD' && e.targetType === 'FIELD');
      }

      // 外部フィールド（相手アプリ側のフィールド）を接続先アプリノードに畳む。
      // 1つのルックアップで相手フィールドが何個も生えると図が急激に読みにくくなるため。
      if (foldExternalFields) {
        edges = edges.map(e => {
          if (e.targetType !== 'EXTERNAL_FIELD') return e;
          const appId = String(e.context?.appId ?? String(e.targetId).split(':')[0] ?? '');
          if (!appId) return e;
          return {
            ...e,
            targetType: 'APP', targetId: appId,
            // 解決済みならアプリ名を含めた表示にする
            targetName: appLabel(deps, appId, { withNote: false }),
            context: { ...(e.context || {}), foldedFrom: e.targetName },
          };
        });
      }

      // エッジ→ノードIDの組（グラフ探索用）
      const idOf = (type, id) => `${type}:${id}`;
      const pairs = edges.map(e => ({
        e,
        s: idOf(e.sourceType, e.sourceId),
        t: idOf(e.targetType, e.targetId),
      }));

      const totalEdges = pairs.length;
      const allIds = new Set();
      for (const p of pairs) { allIds.add(p.s); allIds.add(p.t); }
      const totalNodes = allIds.size;

      // ---- 2) 起点があれば、そこから depth ホップ以内に限定する ----
      let keepIds;
      if (focusId) {
        // 無向として探索する（「使っている／使われている」の両方向を見たいため）
        const adj = new Map();
        const link = (a, b) => {
          if (!adj.has(a)) adj.set(a, new Set());
          adj.get(a).add(b);
        };
        for (const p of pairs) { link(p.s, p.t); link(p.t, p.s); }

        keepIds = new Set([focusId]);
        let frontier = [focusId];
        for (let d = 0; d < Math.max(1, depth); d++) {
          const next = [];
          for (const id of frontier) {
            for (const nb of (adj.get(id) || [])) {
              if (keepIds.has(nb)) continue;
              keepIds.add(nb);
              next.push(nb);
            }
          }
          frontier = next;
          if (!frontier.length) break;
        }
      } else {
        keepIds = allIds;
      }

      let selected = pairs.filter(p => keepIds.has(p.s) && keepIds.has(p.t));

      // ---- 3) ノード数の上限を適用する ----
      // 起点に近いノードを優先して残す（起点が無い場合は登場順）
      let truncated = false;
      const ordered = [];
      const seen = new Set();
      const pushId = (id) => { if (!seen.has(id)) { seen.add(id); ordered.push(id); } };
      if (focusId) pushId(focusId);
      for (const p of selected) { pushId(p.s); pushId(p.t); }

      let finalIds = new Set(ordered);
      if (ordered.length > maxNodes) {
        truncated = true;
        finalIds = new Set(ordered.slice(0, maxNodes));
        selected = selected.filter(p => finalIds.has(p.s) && finalIds.has(p.t));
      }

      const nodes = [...finalIds].map(id => nodeById.get(id) || {
        id,
        type: id.split(':')[0],
        name: id.slice(id.indexOf(':') + 1),
      });

      return {
        nodes,
        edges: selected.map(p => p.e),
        truncated,
        totalNodes,
        totalEdges,
        shownNodes: nodes.length,
        shownEdges: selected.length,
      };
    }

    // Mermaid のノード形状（種別が一目で分かるようにする）
    const MERMAID_SHAPE = {
      FIELD: (id, label) => `${id}["${label}"]`,
      VIEW: (id, label) => `${id}[/"${label}"/]`,
      REPORT: (id, label) => `${id}[/"${label}"/]`,
      NOTIFICATION: (id, label) => `${id}>"${label}"]`,
      PROCESS_STATE: (id, label) => `${id}(["${label}"])`,
      PROCESS_ACTION: (id, label) => `${id}(["${label}"])`,
      ACL: (id, label) => `${id}{{"${label}"}}`,
      ACTION: (id, label) => `${id}[["${label}"]]`,
      CUSTOMIZE: (id, label) => `${id}[("${label}")]`,
      APP: (id, label) => `${id}[("${label}")]`,
      EXTERNAL_FIELD: (id, label) => `${id}["${label}"]`,
    };

    // ノード種別 → 表示グループ名（図を種別ごとに枠で囲むために使う）
    const GRAPH_GROUP_OF = {
      FIELD: 'フィールド',
      VIEW: '一覧・グラフ', REPORT: '一覧・グラフ',
      NOTIFICATION: '通知', PROCESS_STATE: 'プロセス管理', PROCESS_ACTION: 'プロセス管理',
      ACL: 'アクセス権', CUSTOMIZE: 'JavaScript',
      ACTION: '他アプリ連携', APP: '他アプリ連携', EXTERNAL_FIELD: '他アプリ連携',
    };

    // ノード種別 → Mermaidのクラス（色分け）
    const MERMAID_CLASS_OF = {
      FIELD: 'ktField',
      VIEW: 'ktViewRep', REPORT: 'ktViewRep',
      NOTIFICATION: 'ktNotice', PROCESS_STATE: 'ktNotice', PROCESS_ACTION: 'ktNotice',
      ACL: 'ktAcl', CUSTOMIZE: 'ktJs',
      ACTION: 'ktApp', APP: 'ktApp', EXTERNAL_FIELD: 'ktApp',
    };

    /**
     * 部分グラフから Mermaid のコードを生成する
     * 読みやすさのための工夫：
     *  - 種別ごとに色分けし、枠（subgraph）で囲む
     *  - 同じノード間の関係は1本にまとめる
     *  - 関係が多いときは矢印ラベルを省略する（文字量で読めなくなるのを防ぐ）
     *  - 推定（LIKELY / UNCERTAIN）の依存は破線にして確実なものと区別する
     */
    function toMermaid(sub, opt = {}) {
      const {
        direction = 'LR',
        focusId = null,
        group = true,          // 種別ごとに枠で囲む
        showLabels = 'auto',   // true / false / 'auto'（本数が多いときは省略）
        labelLimit = 30,       // 'auto' のときにラベルを省略し始める関係数
        linkResolver = null,   // (node) => URL文字列 | null。図中のノードをリンクにする
      } = opt;
      const nodes = (sub && sub.nodes) || [];
      const edges = (sub && sub.edges) || [];
      if (!nodes.length) return '';

      // Mermaidのラベルを壊す文字を除去・置換する
      const safeLabel = (s) => String(s ?? '')
        .replace(/["`]/g, "'")
        .replace(/[<>{}[\]|]/g, ' ')
        .replace(/\r?\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 28) || '(no name)';

      // ノードIDは英数字に正規化する（日本語コードをそのまま使うと壊れるため）
      const idMap = new Map();
      nodes.forEach((n, i) => idMap.set(n.id, `N${i}`));

      const lines = [`flowchart ${direction}`];

      // ---- ノード定義 ----
      const emitNode = (n) => {
        const mid = idMap.get(n.id);
        const shape = MERMAID_SHAPE[n.type] || MERMAID_SHAPE.FIELD;
        // 枠で囲む場合は種別が枠名で分かるため、ノード名に種別を付けない
        const prefix = (group || n.type === 'FIELD') ? '' : `${n.type.toLowerCase()}: `;
        return shape(mid, safeLabel(prefix + (n.name || n.id)));
      };

      if (group) {
        const groups = new Map();
        for (const n of nodes) {
          const g = GRAPH_GROUP_OF[n.type] || 'その他';
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(n);
        }
        let gi = 0;
        for (const [gname, list] of groups) {
          lines.push(`  subgraph G${gi}["${safeLabel(gname)}"]`);
          for (const n of list) lines.push(`    ${emitNode(n)}`);
          lines.push('  end');
          gi++;
        }
      } else {
        for (const n of nodes) lines.push(`  ${emitNode(n)}`);
      }

      // ---- 同じノード間の関係はまとめる（同じ矢印が何本も重なるのを防ぐ）----
      const merged = new Map();
      for (const e of edges) {
        const s = idMap.get(`${e.sourceType}:${e.sourceId}`);
        const t = idMap.get(`${e.targetType}:${e.targetId}`);
        if (!s || !t || s === t) continue;
        // 同じ向きの関係は線種を問わず1本にまとめる。
        // 1つでも確実な依存があれば実線（依存の存在は確定しているため）、
        // すべて推定なら破線にする。
        const certain = (e.confidence === CONF.CERTAIN);
        const key = `${s}|${t}`;
        if (!merged.has(key)) merged.set(key, { s, t, anyCertain: false, labels: new Set() });
        const m = merged.get(key);
        if (certain) m.anyCertain = true;
        m.labels.add(REL_LABEL[e.relationType] || e.relationType);
      }

      // 関係が多いときはラベルを省略する
      const useLabels = (showLabels === 'auto') ? (merged.size <= labelLimit) : !!showLabels;

      for (const m of merged.values()) {
        const label = safeLabel([...m.labels].join('・'));
        const dashed = !m.anyCertain;
        if (useLabels) {
          lines.push(dashed ? `  ${m.s} -. "${label}" .-> ${m.t}` : `  ${m.s} -- "${label}" --> ${m.t}`);
        } else {
          lines.push(dashed ? `  ${m.s} -.-> ${m.t}` : `  ${m.s} --> ${m.t}`);
        }
      }

      // ---- 種別ごとの色分け ----
      // 透過色（末尾22＝約13%）を使い、ライト／ダークどちらでも文字が読めるようにする
      lines.push('  classDef ktField fill:#2563eb22,stroke:#2563eb,stroke-width:1px');
      lines.push('  classDef ktViewRep fill:#16a34a22,stroke:#16a34a,stroke-width:1px');
      lines.push('  classDef ktNotice fill:#f59e0b22,stroke:#f59e0b,stroke-width:1px');
      lines.push('  classDef ktAcl fill:#a855f722,stroke:#a855f7,stroke-width:1px');
      lines.push('  classDef ktJs fill:#ec489922,stroke:#ec4899,stroke-width:1px');
      lines.push('  classDef ktApp fill:#06b6d422,stroke:#06b6d4,stroke-width:1px');

      const byClass = new Map();
      for (const n of nodes) {
        const cls = MERMAID_CLASS_OF[n.type] || 'ktField';
        if (!byClass.has(cls)) byClass.set(cls, []);
        byClass.get(cls).push(idMap.get(n.id));
      }
      for (const [cls, list] of byClass) {
        if (list.length) lines.push(`  class ${list.join(',')} ${cls}`);
      }

      // 起点を強調する
      // classDef は後から定義したものが優先されるため、種別の色分けより後に定義する。
      // あわせて style も指定し、どちらかが効けば赤枠になるようにする。
      if (focusId && idMap.has(focusId)) {
        const fid = idMap.get(focusId);
        lines.push('  classDef ktFocus stroke:#ef4444,stroke-width:4px');
        lines.push(`  class ${fid} ktFocus`);
        lines.push(`  style ${fid} stroke:#ef4444,stroke-width:4px`);
      }

      // ---- ノードのリンク（Mermaidのclick構文）----
      // 動作には securityLevel が 'strict' 以外である必要がある（呼び出し側で設定する）
      if (typeof linkResolver === 'function') {
        for (const n of nodes) {
          let href = null;
          try { href = linkResolver(n); } catch (e) { href = null; }
          if (!href) continue;
          // URLに " が含まれると構文が壊れるため除去する
          const safeHref = String(href).replace(/["\s]/g, '');
          lines.push(`  click ${idMap.get(n.id)} href "${safeHref}" _blank`);
        }
      }

      return lines.join('\n');
    }

    // ================= 計算式チェーン =================

    /**
     * 計算式の参照ツリーを組み立てる
     *
     *   報酬額
     *    ├─ 人数
     *    └─ 単価
     *
     * 計算フィールドが別の計算フィールドを参照していると多段になり、
     * 1つ変えたときの波及が読みにくくなる。その深さを把握するために使う。
     *
     * @param {number} opt.maxDepth 安全のための打ち切り深さ（既定10）
     * @returns {{code, name, depth, children:Array, truncated:boolean, circular:boolean}}
     */
    function buildCalcTree(deps, fieldCode, opt = {}) {
      const { maxDepth = 10 } = opt;
      const edges = (deps?.edges || []).filter(e => e.relationType === REL.REFERENCES);

      // 計算元 → 参照先 の索引（1フィールドが複数を参照する）
      const refMap = new Map();
      for (const e of edges) {
        if (e.sourceType !== 'FIELD' || e.targetType !== 'FIELD') continue;
        if (!refMap.has(e.sourceId)) refMap.set(e.sourceId, []);
        const list = refMap.get(e.sourceId);
        if (!list.includes(e.targetId)) list.push(e.targetId);
      }

      const nameOf = (code) => {
        const n = (deps?.nodes || []).find(x => x.id === `FIELD:${code}`);
        return n?.name || code;
      };

      const walk = (code, depth, ancestors) => {
        const node = { code, name: nameOf(code), depth, children: [], truncated: false, circular: false };
        // 循環参照はkintone側で防がれるが、データ不整合に備えて自衛する
        if (ancestors.has(code)) { node.circular = true; return node; }
        if (depth >= maxDepth) { node.truncated = true; return node; }

        const refs = refMap.get(code) || [];
        if (!refs.length) return node;

        const nextAncestors = new Set(ancestors);
        nextAncestors.add(code);
        node.children = refs
          .map(c => walk(c, depth + 1, nextAncestors))
          .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja'));
        return node;
      };

      return walk(String(fieldCode), 0, new Set());
    }

    /** ツリーの最大深さ（葉までの段数）を返す */
    function calcTreeDepth(tree) {
      if (!tree || !tree.children || !tree.children.length) return 0;
      return 1 + Math.max(...tree.children.map(calcTreeDepth));
    }

    /**
     * アプリ全体の計算式チェーンの状況をまとめる
     * @returns {{maxDepth:number, calcFields:number, deepest:Array<{code,name,depth}>}}
     */
    function calcChainStats(deps, opt = {}) {
      const { topN = 5 } = opt;
      const roots = [...new Set(
        (deps?.edges || [])
          .filter(e => e.relationType === REL.REFERENCES && e.sourceType === 'FIELD')
          .map(e => e.sourceId)
      )];

      const list = roots.map(code => {
        const tree = buildCalcTree(deps, code);
        return { code, name: tree.name, depth: calcTreeDepth(tree) };
      });

      list.sort((a, b) => b.depth - a.depth || String(a.name).localeCompare(String(b.name), 'ja'));
      return {
        maxDepth: list.length ? list[0].depth : 0,
        calcFields: list.length,
        deepest: list.slice(0, topN),
      };
    }

    /** 計算式ツリーを罫線付きのテキストに整形する（表示・レポート共通） */
    function calcTreeToText(tree) {
      const lines = [];
      const walk = (node, prefix, isLast, isRoot) => {
        if (isRoot) {
          lines.push(node.name === node.code ? node.code : `${node.name}（${node.code}）`);
        } else {
          const mark = node.circular ? ' ※循環参照' : (node.truncated ? ' ※以降省略' : '');
          const label = node.name === node.code ? node.code : `${node.name}（${node.code}）`;
          lines.push(`${prefix}${isLast ? '└─ ' : '├─ '}${label}${mark}`);
        }
        const nextPrefix = isRoot ? ' ' : prefix + (isLast ? '   ' : '│  ');
        node.children.forEach((c, i) => walk(c, nextPrefix, i === node.children.length - 1, false));
      };
      walk(tree, '', true, true);
      return lines.join('\n');
    }

    // ================= 横断検索 =================

    /**
     * 依存関係全体をフリーワードで検索する
     *
     * フィールド名・コードだけでなく、設定名・JSファイル名・アプリ名・関係種別も対象にする。
     * 「custom.js が触っているもの」「"顧客" を含む依存」のような探し方ができる。
     *
     * @param {string} query 空白区切りで複数語を指定した場合はAND条件
     * @param {number} opt.limit 返す最大件数（既定200。多すぎる結果でUIが重くならないようにする）
     * @returns {{rows:Array, total:number, truncated:boolean}}
     */
    function searchEdges(deps, query, opt = {}) {
      const { limit = 200 } = opt;
      const terms = String(query || '')
        .trim()
        .toLowerCase()
        .split(/[\s\u3000]+/)
        .filter(Boolean);
      if (!terms.length) return { rows: [], total: 0, truncated: false };

      const CONF_JA_LOCAL = { CERTAIN: '確実', LIKELY: '可能性が高い', UNCERTAIN: '要確認', NOT_ANALYZED: '解析対象外' };

      const rows = [];
      for (const e of (deps?.edges || [])) {
        const relLabel = REL_LABEL[e.relationType] || e.relationType || '';
        const srcKind = IMPACT_CATEGORY[e.sourceType] || e.sourceType || '';
        // 検索対象の文字列をまとめる（表示に出ている情報はすべて引っかかるようにする）
        const haystack = [
          e.sourceType, e.sourceId, e.sourceName,
          e.relationType, relLabel, srcKind,
          e.targetType, e.targetId, e.targetName,
          e.context?.settingType, e.context?.settingName, e.context?.note,
          e.confidence, CONF_JA_LOCAL[e.confidence],
        ].filter(Boolean).join(' ').toLowerCase();

        if (!terms.every(t => haystack.includes(t))) continue;

        rows.push({
          sourceType: e.sourceType,
          sourceKind: srcKind,
          sourceName: e.sourceName || e.sourceId,
          sourceId: e.sourceId,
          relation: relLabel,
          relationType: e.relationType,
          targetType: e.targetType,
          targetName: e.targetName || e.targetId,
          targetId: e.targetId,
          settingName: e.context?.settingName || '',
          confidence: e.confidence,
          lines: Array.isArray(e.context?.lines) ? e.context.lines : null,
        });
      }

      // 確実なものを先に、次に種別・名前順で並べる
      const confRank = (c) => (c === CONF.CERTAIN ? 0 : c === CONF.LIKELY ? 1 : 2);
      rows.sort((a, b) =>
        confRank(a.confidence) - confRank(b.confidence) ||
        String(a.sourceKind).localeCompare(String(b.sourceKind), 'ja') ||
        String(a.sourceName).localeCompare(String(b.sourceName), 'ja') ||
        String(a.targetName).localeCompare(String(b.targetName), 'ja')
      );

      const total = rows.length;
      return { rows: rows.slice(0, limit), total, truncated: total > limit };
    }

    // ================= レポート出力 =================

    // 確度の日本語表記（レポート共通）
    const CONF_JA = {
      CERTAIN: '確実', LIKELY: '可能性が高い',
      UNCERTAIN: '要確認', NOT_ANALYZED: '解析対象外',
    };

    /** Markdownの表やリストを壊す文字を無害化する */
    function mdEscape(s) {
      return String(s ?? '')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ')
        .trim();
    }

    /**
     * 依存関係のMarkdownレポートを生成する
     * 仕様書やNotionへ貼り付けやすい形式（見出し＋箇条書き）にする
     * @param {Array} opt.fields 正規化済みフィールド配列（型・必須の表示に使う）
     * @param {boolean} opt.onlyUsed true なら利用箇所のあるフィールドのみ出力する
     */
    function toMarkdown(deps, opt = {}) {
      const { fields = [], onlyUsed = false } = opt;
      const meta = deps?.meta || {};
      const out = [];

      const appTitle = meta.appName ? `${meta.appName}（app ${meta.appId}）` : `app ${meta.appId ?? '?'}`;
      out.push(`# フィールド依存関係 — ${mdEscape(appTitle)}`);
      out.push('');
      out.push(`- 生成日時: ${meta.generatedAt || new Date().toISOString()}`);
      out.push(`- フィールド数: ${meta.fieldCount ?? fields.length}`);
      out.push(`- 依存関係数: ${(deps?.edges || []).length}`);
      out.push(`- JavaScript解析: ${meta.scannerMergedAt ? `実施済み（${meta.scannerMergedAt}）` : '未実施（JSからの参照は含まれません）'}`);
      if (Array.isArray(meta.notAnalyzed) && meta.notAnalyzed.length) {
        out.push(`- 解析対象外: ${meta.notAnalyzed.map(mdEscape).join(' / ')}`);
      }
      out.push('');
      out.push('> この文書は kintone App Toolkit が自動生成しました。');
      out.push('> 条件式・計算式・JavaScriptの解析は文字列解析による推定を含みます。');
      out.push('> 確度が「可能性が高い」「要確認」の項目は、実際の設定での確認をおすすめします。');
      out.push('');

      // ---- フィールドごとの依存関係 ----
      const fieldNodes = (deps?.nodes || []).filter(n => n.type === 'FIELD');
      const fieldMeta = new Map((fields || []).map(f => [f.code, f]));
      const unused = [];

      for (const n of fieldNodes) {
        const code = String(n.id).replace(/^FIELD:/, '');
        const imp = impactOf(deps, code);
        const total = imp.counts.direct + imp.counts.indirect + imp.counts.crossApp;
        if (!total) unused.push({ code, name: n.name });
        if (onlyUsed && !total) continue;

        const fm = fieldMeta.get(code) || {};
        out.push(`## ${mdEscape(n.name || code)}`);
        out.push('');
        out.push('### 基本情報');
        out.push(`- ラベル: ${mdEscape(fm.label ?? n.name ?? code)}`);
        out.push(`- フィールドコード: \`${mdEscape(code)}\``);
        out.push(`- 種類: ${mdEscape(fm.type ?? n.fieldType ?? '不明')}`);
        out.push(`- 必須: ${fm.required ? 'はい' : 'いいえ'}`);
        if (fm.parent) out.push(`- サブテーブル: ${mdEscape(fm.parent)}`);
        out.push('');

        if (imp.direct.length) {
          out.push('### 利用箇所');
          for (const d of imp.direct) {
            const note = d.note ? `（${mdEscape(d.note)}）` : '';
            out.push(`- [${mdEscape(d.category)}] ${mdEscape(d.title)} — ${mdEscape(d.role)}${note} 〔${CONF_JA[d.confidence] || d.confidence}〕`);
          }
          out.push('');
        }

        if (imp.indirect.length) {
          out.push('### 間接的な影響（計算式経由）');
          for (const d of imp.indirect) {
            const via = d.via ? `（${mdEscape(d.via)}）` : '';
            out.push(`- [${mdEscape(d.category)}] ${mdEscape(d.title)} — ${mdEscape(d.role)}${via}`);
          }
          out.push('');
        }

        // 計算式が多段になっている場合は、参照の連なりも記録する
        const ct = buildCalcTree(deps, code);
        if (ct.children && ct.children.length) {
          out.push('### 計算式の参照ツリー');
          out.push(`- 深さ: ${calcTreeDepth(ct)} 段`);
          out.push('');
          out.push('```');
          out.push(calcTreeToText(ct));
          out.push('```');
          out.push('');
        }

        if (imp.crossApp.length) {
          out.push('### 他アプリ連携');
          for (const c of imp.crossApp) {
            out.push(`- ${mdEscape(c.text)} 〔${CONF_JA[c.confidence] || c.confidence}〕`);
          }
          out.push('');
        }

        if (imp.operations && imp.operations.length) {
          out.push('### 変更時の確認事項');
          for (const o of imp.operations) {
            out.push(`**${mdEscape(o.label)}**`);
            for (const n of o.notes) out.push(`- ${mdEscape(n)}`);
            out.push('');
          }
        } else if (imp.cautions.length) {
          out.push('### 変更時の確認事項');
          for (const c of imp.cautions) out.push(`- ${mdEscape(c)}`);
          out.push('');
        }

        if (!total) {
          out.push('### 利用箇所');
          out.push('- 検出されませんでした（未使用の可能性があります）');
          out.push('');
        }
      }

      // ---- アプリ間依存 ----
      const links = buildAppLinks(deps, meta.appId);
      out.push('# アプリ間依存関係（このアプリ → 他アプリ）');
      out.push('');
      if (links.length) {
        out.push('| 接続種別 | 自アプリ側 | 接続先アプリ | 接続先フィールド | 備考 | 確度 |');
        out.push('| --- | --- | --- | --- | --- | --- |');
        for (const l of links) {
          const dest = l.destAppId === '不明' ? '不明（変数指定）' : (l.destAppLabel || `app ${l.destAppId}`);
          const src = l.dataSource === 'JS_STATIC' ? '推定' : '設定';
          out.push(`| ${mdEscape(l.kind)} | ${mdEscape(l.selfSide)} | ${mdEscape(dest)} | ${mdEscape(l.destField)} | ${mdEscape(l.note)} | ${src}／${CONF_JA[l.confidence] || l.confidence} |`);
        }
      } else {
        out.push('他アプリへの接続は検出されませんでした。');
      }
      out.push('');
      out.push('※ この一覧は「このアプリ → 他アプリ」の向きのみです。');
      out.push('※ 他アプリからこのアプリへの参照は、アプリ設定APIでは取得できません。');
      out.push('');

      // ---- 壊れた参照 ----
      const broken = findBrokenRefs(deps);
      out.push('# 存在しない参照（フィールドコード・ステータス名）');
      out.push('');
      if (broken.length) {
        out.push('フィールドの削除・コード変更のあとに、参照側が更新されていない可能性があります。');
        out.push('kintoneはフィールド削除時に一覧や通知などの設定からは自動的に取り除きますが、JavaScriptは対象外です。');
        out.push('');
        out.push('| 種別 | コード / 名前 | 検出パターン / 箇所 | ファイル・設定名 | 確度 |');
        out.push('| --- | --- | --- | --- | --- |');
        for (const b of broken) {
          out.push(`| ${mdEscape(b.category)} | \`${mdEscape(b.code)}\` | ${mdEscape(b.role)} | ${mdEscape(b.detail || b.settingName)} | ${CONF_JA[b.confidence] || b.confidence} |`);
        }
      } else {
        out.push('存在しないフィールドコード・ステータス名への参照は見つかりませんでした。');
      }
      out.push('');

      // ---- 未使用の可能性があるフィールド ----
      out.push('# 利用箇所が検出されなかったフィールド');
      out.push('');
      if (unused.length) {
        out.push('以下のフィールドは、解析範囲内では利用箇所が見つかりませんでした。');
        out.push('ただし、解析対象外の設定（プラグイン設定、外部URLのJavaScript等）で使われている可能性があります。');
        out.push('削除前に必ず実物での確認を行ってください。');
        out.push('');
        for (const u of unused) out.push(`- ${mdEscape(u.name)}（\`${mdEscape(u.code)}\`）`);
      } else {
        out.push('すべてのフィールドに利用箇所が検出されました。');
      }
      out.push('');

      return out.join('\n');
    }

    /**
     * 依存関係をCSV（1行1関係）で出力する
     * 表計算での絞り込み・集計に使えるフラット形式
     */
    function toCSV(deps) {
      const rows = [[
        'sourceType', 'sourceId', 'sourceName',
        'relationType', 'relationLabel',
        'targetType', 'targetId', 'targetName',
        'settingType', 'settingName', 'confidence', 'confidenceJa', 'lines',
      ]];
      for (const e of (deps?.edges || [])) {
        rows.push([
          e.sourceType ?? '', e.sourceId ?? '', e.sourceName ?? '',
          e.relationType ?? '', REL_LABEL[e.relationType] || e.relationType || '',
          e.targetType ?? '', e.targetId ?? '', e.targetName ?? '',
          e.context?.settingType ?? '', e.context?.settingName ?? '',
          e.confidence ?? '', CONF_JA[e.confidence] || e.confidence || '',
          Array.isArray(e.context?.lines) ? e.context.lines.join(' ') : '',
        ]);
      }
      // CSVエスケープ（" は "" に、値全体を " で囲む）
      return rows
        .map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
        .join('\r\n');
    }

    /** 依存関係JSON（他ツール・AI向け）を文字列で返す */
    function toJSON(deps) {
      // raw（フィールド定義そのもの）は含めない軽量版
      const nodes = (deps?.nodes || []).map(({ raw, ...rest }) => rest);
      return JSON.stringify({ meta: deps?.meta ?? {}, nodes, edges: deps?.edges ?? [] }, null, 2);
    }

    return {
      REL, CONF,
      // 表示ラベル（KTContext の Markdown / 文章化で再利用する。語彙の正本はここ）
      REL_LABEL, IMPACT_CATEGORY, CONF_JA, BROKEN_ROLE_LABEL,
      normalizeFields, buildCode2Label, labelOf,
      maskStringLiterals, extractFieldCodes, parseSortCodes,
      buildDependencyData, usageMapFromEdges, mergeScannerEdges,
      extractAppIdRefs, buildAppLinks, impactOf, applyAppNames, appLabel, findBrokenRefs,
      applyIncomingRefs,
      buildSubgraph, toMermaid, GRAPH_SCOPES, searchEdges,
      buildCalcTree, calcTreeDepth, calcChainStats, calcTreeToText,
      toJSON, toMarkdown, toCSV,
    };
  })();


  // ==========================================
  // 3.5 AI Context Builder (KTContext)
  //   Toolkit が既に解析している事実（DATA / DEPS / KTScan / KTIncoming）を、
  //   AI が理解しやすく・根拠を追跡でき・サイズを制御できる Context へ変換する。
  //
  //   責務: 質問から対象候補を決定（決定的・LLM 不使用）／既存解析結果から事実を取得／重複排除／
  //         根拠ID付与／confidence・coverage の保持／truncation 記録／AI向け JSON・Markdown・Prompt への変換
  //   担当しない: LLM 呼び出し・Prompt 本文（システム指示）・ライセンス・Gateway 通信・AI 回答の生成/検証
  //
  //   階層: L0（App Overview・常に含める）／L1（Focus Context・対象に直接関係する事実）／
  //         L2（Detail Context・JS ファイル等の詳細。必要時のみ）
  //   Fact と Interpretation の分離: ここで出すのは Toolkit の決定的な解析結果（事実）のみ。
  //   「削除すると業務が止まる」のような解釈は含めない（impactOf の operations は Toolkit 自身の
  //   決定的な注意書きなので change-impact fact として含める）。
  //   DOM / kintone API には依存しない純関数（Node の vm sandbox でテストできる）。
  //   有料 AI 専用ではなく、無料版の「AI 向けドキュメント / Prompt のコピー」でも同じ Context を使う。
  // ==========================================
  const KTContext = (() => {
    const CONTEXT_VERSION = '1';
    const LEVELS = { L0: 'L0', L1: 'L1', L2: 'L2' };

    // ---- 既定のサイズ制御（件数上限・バイト上限。超過分は truncation に記録する）----
    const DEFAULT_LIMITS = {
      maxFields: 50,           // L0 のフィールド一覧（L0 を 1〜2k tokens に収めるための既定。大きなアプリは typeCounts と省略記録で補う）
      maxViewNames: 20,        // L0 の一覧名
      maxFacts: 120,           // facts 全体の上限（超過は kind ごとの優先順で削る）
      maxDependencyFacts: 60,  // 対象フィールドの直接依存
      maxIndirectFacts: 20,
      maxBrokenRefFacts: 30,
      maxAppLinkFacts: 30,
      maxIncomingFacts: 30,
      maxJsMatchFacts: 20,     // JS の出現箇所（行・抜粋）
      maxJsFileFacts: 20,
      maxSnippetLen: 160,      // JS 抜粋の最大長（AppInsight の SNIPPET_MAX_LEN と同じ）
      maxCodeExcerptLines: 12, // L2 のコード抜粋（対象行の前後。本文がある場合のみ）
      maxCodeExcerpts: 6,
      maxBytes: null,          // 全体のバイト上限（null = 件数上限のみ）
    };
    const LEVEL_BUDGET_BYTES = { L0: 8 * 1024, L1: 48 * 1024, L2: 80 * 1024 }; // 目安（約 2k / 12k / 20k tokens）

    // ---- 秘密情報の伏字（AppInsight analysis/js-signals.js redactSecretLikeText の移植。過剰 mask 側に倒す）----
    //   key:value 形の secret 系代入・Bearer / API トークンヘッダ・40 文字以上の不透明トークンを '***' へ
    function redactSecretLikeText(text) {
      let s = String(text ?? '');
      s = s.replace(
        /((?:api[_-]?key|apikey|access[_-]?key|token|secret|password|passwd|credential|authorization|cookie)['"`]?\s*[:=]\s*['"`])([^'"`]{4,}?)(['"`])/gi,
        '$1***$3');
      s = s.replace(/((?:X-Cybozu-API-Token|X-Cybozu-Authorization|Authorization)['"`]?\s*[:=]\s*['"`]?)([^'"`\s,}]{4,})/gi, '$1***');
      s = s.replace(/\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi, 'Bearer ***');
      s = s.replace(/\b[A-Za-z0-9_\-]{40,}\b/g, '***');
      return s;
    }
    const bounded = (s, max) => {
      const t = String(s ?? '');
      return t.length > max ? `${t.slice(0, max)}…` : t;
    };
    const snippetOf = (s, max) => bounded(redactSecretLikeText(String(s ?? '').replace(/\r?\n/g, '⏎')), max);

    // ---- サイズ計測（厳密な tokenizer は持たない。文字種から近似する）----
    //   CJK（日本語）はおおむね 1 文字 ≒ 1 token、それ以外（ASCII の JSON 構造・英数）は約 4 文字 ≒ 1 token
    function measureText(str) {
      const s = String(str ?? '');
      let cjk = 0;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0x3000 && c <= 0x9FFF || c >= 0xF900 && c <= 0xFAFF || c >= 0xFF00 && c <= 0xFFEF) cjk++;
      }
      const other = s.length - cjk;
      let bytes = 0;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xD800 && c <= 0xDBFF) ? 4 : 3;
        if (c >= 0xD800 && c <= 0xDBFF) i++;
      }
      return { chars: s.length, bytes, approxTokens: Math.ceil(cjk + other / 4) };
    }

    // ---- 根拠ID：決定的な識別子（表示文字列に依存せず、同じ解析結果なら同じ ID）----
    //   edge の identity = 利用元（type:id）／関係種別／利用先（type:id）／設定種別／設定名
    //   JS ファイルは表示用ファイル名ではなく、既存 edge の sourceId（target:kind:name）をそのまま使う
    const edgeKey = (e) => [
      `${e.sourceType}:${e.sourceId}`, e.relationType, `${e.targetType}:${e.targetId}`,
      e.context?.settingType ?? '', e.context?.settingName ?? '',
    ].join('|');
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

    // 事実の種別と並び順（根拠IDの採番順。同じ入力なら常に同じ順になる）
    const FACT_KIND_ORDER = [
      'field', 'dependency', 'indirect-dependency', 'incoming-reference', 'js-reference', 'js-app-reference',
      'js-external-field', 'calc-chain', 'change-impact', 'broken-reference', 'app-link', 'js-file', 'js-match', 'code-excerpt',
      'overview',   // L0 の要点（AI が引用できるよう根拠ID を持たせる。末尾に置き、他の ID を動かさない）
    ];
    const kindRank = (k) => { const i = FACT_KIND_ORDER.indexOf(k); return i < 0 ? 99 : i; };

    const CONF_RANK = { CERTAIN: 0, LIKELY: 1, UNCERTAIN: 2, NOT_ANALYZED: 3 };
    /** Toolkit の confidence 語彙（KTDeps.CONF）に正規化する。未知の値は UNCERTAIN（確実扱いにしない） */
    const normConf = (c) => (c && CONF_RANK[c] != null) ? c : (c === 'HIGH' || c === 'MEDIUM' ? 'LIKELY' : c === 'LOW' ? 'UNCERTAIN' : 'UNCERTAIN');
    const isCertain = (c) => c === 'CERTAIN';

    const REL_LABEL = () => KTDeps.REL_LABEL || {};
    const SRC_LABEL = () => KTDeps.IMPACT_CATEGORY || {};
    const relLabel = (r) => REL_LABEL()[r] || r || '';
    const srcLabel = (t) => SRC_LABEL()[t] || t || '';
    const confJa = (c) => (KTDeps.CONF_JA || {})[c] || c || '';

    // ================= 対象（focus）の決定的な解決 =================

    /**
     * 質問と照合する辞書を作る（フィールドコード／ラベル／JS ファイル名／アプリID／設定名）
     * 値はすべて既存データ由来。LLM は使わない
     */
    function buildDictionary({ data, deps, scan }) {
      const entries = []; // { key, type, id, label, by, extra }
      const push = (key, type, id, label, by, extra = {}) => {
        const k = String(key ?? '').trim();
        if (!k) return;
        entries.push({ key: k, type, id: String(id), label: label ?? String(id), by, ...extra });
      };
      const fieldsN = Array.isArray(data?.fields) ? data.fields : KTDeps.normalizeFields(data?.fields || {});
      for (const f of fieldsN) {
        push(f.code, 'field', f.code, f.label, 'code', { fieldType: f.type });
        if (f.label && f.label !== f.code) push(f.label, 'field', f.code, f.label, 'label', { fieldType: f.type });
      }
      // JS 解析でのみ現れたコード（グループ等）も対象にできる
      for (const n of (deps?.nodes || [])) {
        if (n.type === 'FIELD' && n.fromScanner) push(String(n.id).replace(/^FIELD:/, ''), 'field', String(n.id).replace(/^FIELD:/, ''), n.name, 'code', { fieldType: n.fieldType });
        if (n.type === 'CUSTOMIZE') {
          // 既存 edge の sourceId（target:kind:name）を identity にする。表示名（ファイル名）は照合キー
          push(n.name, 'file', String(n.id).replace(/^CUSTOMIZE:/, ''), n.name, 'fileName', { target: n.target, kind: n.kind });
        }
        if (n.type === 'VIEW' || n.type === 'REPORT' || n.type === 'NOTIFICATION' || n.type === 'ACTION'
          || n.type === 'PROCESS_STATE' || n.type === 'PROCESS_ACTION') {
          push(n.name, 'setting', String(n.id), n.name, 'settingName', { settingType: n.type });
        }
      }
      for (const f of (scan?.files || [])) {
        if (f?.note) continue;   // 外部 URL（本文未取得・"external URL (skipped)"）は DEPS の CUSTOMIZE ノード側で扱う
        const id = `${f.target}:${f.kind}:${f.name}`;
        if (!entries.some(e => e.type === 'file' && e.id === id)) push(f.name, 'file', id, f.name, 'fileName', { target: f.target, kind: f.kind });
      }
      return entries;
    }

    /**
     * 質問文から対象を決める（完全一致の辞書照合。長い一致を優先し、重なる短い一致は捨てる）
     * @returns {{ resolution:'resolved'|'ambiguous'|'none'|'explicit', target?:object, candidates:Array }}
     */
    function resolveFocus({ question, focus, data, deps, scan }) {
      // 明示指定が最優先（UI や呼び出し側が対象を決めている場合）
      if (focus && typeof focus === 'object' && focus.type && focus.id != null) {
        return { resolution: 'explicit', target: { type: focus.type, id: String(focus.id), label: focus.label ?? String(focus.id) }, candidates: [] };
      }
      const q = String(question ?? '');
      if (!q.trim()) return { resolution: 'none', candidates: [] };
      const dict = buildDictionary({ data, deps, scan });

      // 出現位置を集め、長いキーを優先して重なりを除去する（KTDeps.extractFieldCodes と同じ考え方）
      const hits = [];
      for (const en of dict) {
        let from = 0;
        while (true) {
          const idx = q.indexOf(en.key, from);
          if (idx < 0) break;
          hits.push({ ...en, start: idx, end: idx + en.key.length });
          from = idx + 1;
        }
      }
      hits.sort((a, b) => (a.start - b.start) || (b.end - a.end) || cmp(a.type, b.type) || cmp(a.id, b.id));
      // 同じ区間を占める複数の候補（例: 同じラベルの別フィールド）は全部残す。短い部分一致だけ落とす
      const kept = [];
      let lastStart = -1, lastEnd = -1;
      for (const h of hits) {
        if (h.start === lastStart && h.end === lastEnd) { kept.push(h); continue; }
        if (h.start < lastEnd) continue;
        kept.push(h);
        lastStart = h.start; lastEnd = h.end;
      }
      // 同一 target（type:id）は 1 候補にまとめる（コードとラベルの両方で当たった場合など）
      const byTarget = new Map();
      for (const h of kept) {
        const k = `${h.type}:${h.id}`;
        const c = byTarget.get(k);
        if (c) { if (!c.matchedBy.includes(h.by)) c.matchedBy.push(h.by); continue; }
        byTarget.set(k, {
          type: h.type, id: h.id, label: h.label, matchedBy: [h.by], matchedText: h.key,
          ...(h.fieldType ? { fieldType: h.fieldType } : {}),
          ...(h.target ? { target: h.target, kind: h.kind } : {}),
          ...(h.settingType ? { settingType: h.settingType } : {}),
        });
      }
      const candidates = [...byTarget.values()].sort((a, b) => cmp(a.type, b.type) || cmp(a.id, b.id));
      if (!candidates.length) return { resolution: 'none', candidates: [] };
      if (candidates.length === 1) return { resolution: 'resolved', target: candidates[0], candidates };
      return { resolution: 'ambiguous', candidates }; // 勝手に 1 件へ決めない
    }

    // ================= coverage =================

    function buildCoverage({ data, deps, scan, incoming }) {
      const meta = deps?.meta || {};
      const jsAnalyzed = !!(meta.scannerMergedAt || (scan && Array.isArray(scan.results)));
      const incomingScanned = !!(meta.incomingScannedAt || (incoming && Array.isArray(incoming.rows)));
      const jsFiles = [
        ...((data?.customize?.desktop?.js || []).map(x => ({ ...x, target: 'desktop' }))),
        ...((data?.customize?.mobile?.js || []).map(x => ({ ...x, target: 'mobile' }))),
      ];
      const urlJs = jsFiles.filter(x => x?.type === 'URL' || (!x?.file && x?.url)).length;
      // JS 本文の有無: 直後のスキャンなら files[].text を持つ。キャッシュ復元時は Scanner の断片（snippet）だけ
      const scanFiles = (scan?.files || []).filter(f => !f?.note);
      const jsSource = !jsAnalyzed ? null : scanFiles.some(f => typeof f.text === 'string') ? 'full' : 'snippets';
      const notes = [];
      if (!jsAnalyzed) notes.push('JavaScript/CSS 本文は未解析（Field Scanner 未実行）。JS からの参照は含まれていない');
      if (jsSource === 'snippets') notes.push('JavaScript 本文はキャッシュから復元した解析結果のため含まない（コード抜粋は Scanner の断片のみ）');
      if (jsAnalyzed && urlJs) notes.push(`URL 指定の JavaScript ${urlJs} 件は本文を取得できないため未解析`);
      if (!incomingScanned) notes.push('他アプリからこのアプリへの参照は未走査。被参照は含まれていない');
      if (incomingScanned && incoming?.stats?.truncated) notes.push('他アプリの走査は上限件数で打ち切られている');
      if (incomingScanned && (incoming?.stats?.failedApps || meta.incomingStats?.failedApps)) {
        notes.push(`他アプリの走査で取得できなかったアプリがある（${incoming?.stats?.failedApps ?? meta.incomingStats?.failedApps} 件）`);
      }
      if (meta.pluginCount) notes.push(`プラグイン ${meta.pluginCount} 個の設定内容は API で取得できないため未解析`);
      notes.push('レコードの実データ・添付ファイルは含まない');
      return {
        fields: !!data?.fields,
        layout: Array.isArray(data?.layout) && data.layout.length > 0,
        settings: {
          views: !!data?.views, reports: !!data?.reports,
          notifications: !!(data?.generalNotify || data?.perRecordNotify || data?.reminderNotify),
          process: !!data?.status, acl: !!(data?.recordAcl || data?.fieldAcl), actions: !!data?.actions,
          customize: !!data?.customize,
        },
        dependencies: !!(deps && Array.isArray(deps.edges)),
        javascript: jsAnalyzed,
        javascriptScannedAt: scan?.meta?.scannedAt || meta.scannerMergedAt || null,
        javascriptSource: jsSource,   // 'full' | 'snippets' | null
        incoming: incomingScanned,
        incomingScannedAt: meta.incomingScannedAt || incoming?.scannedAt || null,
        plugins: false,
        pluginCount: meta.pluginCount ?? null,
        recordData: false,
        attachments: false,
        notAnalyzed: Array.isArray(meta.notAnalyzed) ? [...meta.notAnalyzed] : [],
        notes,
      };
    }

    // ================= L0: App Overview =================

    /**
     * Documents 機能の buildDocPayloadLiteFromPrefetch（Common Context Model）を再利用し、
     * AI 向けには要約（件数）だけを載せる。生の通知・ACL オブジェクトは入れない
     */
    function buildAppOverview({ data, deps, scan, incoming, limits, trunc }) {
      let lite = null;
      try {
        lite = buildDocPayloadLiteFromPrefetch({ ...(data || {}), layout: Array.isArray(data?.layout) ? data.layout : [] });
      } catch (e) { lite = null; }
      const fieldsN = KTDeps.normalizeFields(data?.fields || {});
      const fieldRows = (lite?.fields || fieldsN.map(f => ({ code: f.code, label: f.label, type: f.type === 'LOOKUP' ? f.rawType : f.type, required: f.required, unique: f.unique, inSubtable: f.parent })))
        .map(f => ({
          code: f.code, label: f.label, type: f.type,
          ...(f.required ? { required: true } : {}), ...(f.unique ? { unique: true } : {}),
          ...(f.inSubtable ? { subtable: f.inSubtable } : {}),
        }))
        .sort((a, b) => cmp(a.code, b.code));
      const typeCounts = {};
      for (const f of fieldRows) typeCounts[f.type] = (typeCounts[f.type] || 0) + 1;
      const fields = fieldRows.slice(0, limits.maxFields);
      if (fieldRows.length > fields.length) trunc('app.fields', fieldRows.length, fields.length);

      const meta = deps?.meta || {};
      const edges = deps?.edges || [];
      const byRelation = {}, bySource = {};
      for (const e of edges) {
        byRelation[e.relationType] = (byRelation[e.relationType] || 0) + 1;
        bySource[e.sourceType] = (bySource[e.sourceType] || 0) + 1;
      }
      const broken = deps ? safe(() => KTDeps.findBrokenRefs(deps), []) : [];
      const brokenByConf = {};
      for (const b of broken) brokenByConf[normConf(b.confidence)] = (brokenByConf[normConf(b.confidence)] || 0) + 1;
      const links = deps ? safe(() => KTDeps.buildAppLinks(deps, data?.appId), []) : [];
      const linksByKind = {};
      for (const l of links) linksByKind[l.kind] = (linksByKind[l.kind] || 0) + 1;
      const calc = deps ? safe(() => KTDeps.calcChainStats(deps, { topN: 3 }), null) : null;
      // ステータスは kintone の index 順（Object.values の順序に依存しない）
      const states = data?.status?.enable
        ? Object.values(data.status.states || {}).filter(Boolean)
          .sort((a, b) => (Number(a.index ?? 0) - Number(b.index ?? 0)) || cmp(String(a.name ?? ''), String(b.name ?? '')))
          .map(s => s.name).filter(Boolean)
        : [];
      const jsNames = (t) => (data?.customize?.[t]?.js || []).map(x => x?.file?.name || x?.url || '(unknown)');
      const allViewNames = (lite?.views || []).map(v => v.name);
      const viewNames = allViewNames.slice(0, limits.maxViewNames);
      if (allViewNames.length > viewNames.length) trunc('app.views.names', allViewNames.length, viewNames.length);

      return {
        id: String(data?.appId ?? meta.appId ?? ''),
        name: lite?.meta?.appName ?? data?.settings?.name ?? meta.appName ?? null,
        description: lite?.meta?.appDescription ?? null,
        fieldCount: fieldRows.length,
        fieldTypeCounts: typeCounts,
        fields,
        views: { count: (lite?.views || []).length, names: viewNames },
        reports: { count: (lite?.reports || []).length },
        notifications: {
          general: (data?.generalNotify?.notifications || []).length,
          perRecord: (data?.perRecordNotify?.notifications || []).length,
          reminder: (data?.reminderNotify?.notifications || []).length,
        },
        process: { enabled: !!data?.status?.enable, stateCount: states.length, states, actionCount: (data?.status?.actions || []).length },
        acl: {
          app: (data?.appAcl?.rights || []).length,
          record: (data?.recordAcl?.rights || []).length,
          field: (data?.fieldAcl?.rights || []).length,
        },
        actions: { count: Object.keys(data?.actions?.actions || {}).length },
        customize: {
          desktop: { js: jsNames('desktop'), css: (data?.customize?.desktop?.css || []).length },
          mobile: { js: jsNames('mobile'), css: (data?.customize?.mobile?.css || []).length },
        },
        plugins: { count: meta.pluginCount ?? (Array.isArray(data?.appPlugins?.plugins) ? data.appPlugins.plugins.length : null) },
        dependencies: deps ? { edgeCount: edges.length, byRelation, bySource } : null,
        javascript: {
          analyzed: !!(meta.scannerMergedAt || scan),
          scannedAt: scan?.meta?.scannedAt || meta.scannerMergedAt || null,
          fileCount: (deps?.nodes || []).filter(n => n.type === 'CUSTOMIZE').length,
          unknownFieldRefs: (meta.unknownJsRefs || scan?.unknownRefs || []).length,
          unknownStatusRefs: (meta.unknownJsStatuses || scan?.unknownStatuses || []).length,
        },
        incoming: {
          scanned: !!(meta.incomingScannedAt || incoming),
          scannedAt: meta.incomingScannedAt || incoming?.scannedAt || null,
          referencingApps: (incoming?.stats || meta.incomingStats)?.referencingApps ?? null,
          scannedApps: (incoming?.stats || meta.incomingStats)?.scannedApps ?? null,
          failedApps: (incoming?.stats || meta.incomingStats)?.failedApps ?? null,
        },
        brokenRefs: { total: broken.length, byConfidence: brokenByConf },
        appLinks: { count: links.length, byKind: linksByKind },
        calcChain: calc ? { calcFields: calc.calcFields, maxDepth: calc.maxDepth, deepest: calc.deepest } : null,
      };
    }

    const safe = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };

    /**
     * L0（アプリ概要）の要点を根拠ID 付きの fact にする（Phase 5 の L0 grounding）。
     * AI が「フィールド数」「解析状態」等を根拠として引用できるようにする。件数は増やしすぎない（最大 7 件）
     */
    function buildOverviewFacts(app, coverage) {
      if (!app) return [];
      const f = [];
      const push = (key, statement, extra = {}) => f.push({ kind: 'overview', key: `OVERVIEW|${key}`, confidence: 'CERTAIN', statement, ...extra });
      push('fields', `このアプリ（${app.name ? `${app.name}・` : ''}app ${app.id}）のフィールド数は ${app.fieldCount} 件（${Object.entries(app.fieldTypeCounts || {}).map(([k, v]) => `${k}×${v}`).join(', ')}）`, { count: app.fieldCount });
      if (app.dependencies) push('dependencies', `解析済みの依存関係は ${app.dependencies.edgeCount} 件（一覧 ${app.views?.count ?? 0}・グラフ ${app.reports?.count ?? 0}・通知 ${(app.notifications?.general ?? 0) + (app.notifications?.perRecord ?? 0) + (app.notifications?.reminder ?? 0)}・アクセス権 ${(app.acl?.record ?? 0) + (app.acl?.field ?? 0)}・アプリアクション ${app.actions?.count ?? 0}）`, { count: app.dependencies.edgeCount });
      push('process', app.process?.enabled ? `プロセス管理は有効（ステータス: ${(app.process.states || []).join(' → ')}・アクション ${app.process.actionCount} 件）` : 'プロセス管理は無効', { enabled: !!app.process?.enabled });
      push('javascript', app.javascript?.analyzed
        ? `JavaScript は解析済み（${app.javascript.fileCount} ファイル${coverage?.javascriptSource === 'snippets' ? '・本文はキャッシュ復元のため抜粋のみ' : ''}・存在しないコードの参照 ${app.javascript.unknownFieldRefs} 件）`
        : 'JavaScript は未解析（JS からの参照は含まれていない）', { analyzed: !!app.javascript?.analyzed });
      push('incoming', app.incoming?.scanned ? `他アプリからの参照は走査済み（参照元 ${app.incoming.referencingApps ?? 0} アプリ）` : '他アプリからの参照は未走査（被参照は含まれていない）', { scanned: !!app.incoming?.scanned });
      push('brokenRefs', `壊れた参照（存在しないフィールド・ステータスの指定）は ${app.brokenRefs?.total ?? 0} 件`, { count: app.brokenRefs?.total ?? 0 });
      if (app.plugins?.count) push('plugins', `プラグインが ${app.plugins.count} 個追加されている（設定内容は API で取得できないため未解析）`, { count: app.plugins.count });
      return f;
    }

    // ================= facts =================

    const nodeName = (deps, type, id) => (deps?.nodes || []).find(n => n.id === `${type}:${id}`)?.name ?? null;
    const appName = (deps, id) => (deps?.meta?.appNames || {})[String(id)] || null;
    const endpoint = (deps, type, id, name) => {
      const o = { type, id: String(id) };
      const nm = name ?? nodeName(deps, type, id);
      if (nm != null && nm !== '' && nm !== String(id)) o.name = nm;
      if (type === 'APP' || type === 'EXTERNAL_APP') { const an = appName(deps, id); if (an) o.name = an; }
      return o;
    };

    /** edge → dependency fact（文章は語彙ラベルから機械的に組み立てる。解釈は入れない） */
    function factFromEdge(deps, e, direction) {
      const st = e.context?.settingType || '';
      const src = endpoint(deps, e.sourceType, e.sourceId, e.sourceName);
      const tgt = endpoint(deps, e.targetType, e.targetId, e.targetName);
      const srcText = e.sourceType === 'FIELD' ? `フィールド「${e.sourceName || e.sourceId}」`
        : e.sourceType === 'CUSTOMIZE' ? `${e.context?.target ? `${e.context.target} 用 ` : ''}JavaScript「${e.sourceName || e.sourceId}」`
          : e.sourceType === 'EXTERNAL_APP' ? `他アプリ ${e.sourceId}${appName(deps, e.sourceId) ? `（${appName(deps, e.sourceId)}）` : ''}の${e.context?.kind || '設定'}「${e.context?.settingName || ''}」`
            : `${srcLabel(e.sourceType)}「${e.sourceName || e.sourceId}」`;
      const tgtText = e.targetType === 'FIELD' ? `フィールド「${e.targetName || e.targetId}」`
        : e.targetType === 'APP' ? `アプリ ${e.targetId}${appName(deps, e.targetId) ? `（${appName(deps, e.targetId)}）` : ''}`
          : e.targetType === 'EXTERNAL_FIELD' ? `アプリ ${e.context?.appId ?? '?'} のフィールド「${e.targetName || e.targetId}」` : `${e.targetType}「${e.targetName || e.targetId}」`;
      const settingText = (e.sourceType !== 'EXTERNAL_APP' && e.context?.settingName && e.context.settingName !== e.sourceName) ? `（${e.context.settingName}）` : '';
      const fact = {
        kind: 'dependency',
        key: edgeKey(e),
        confidence: normConf(e.confidence),
        direction,
        relationType: e.relationType,
        relationLabel: relLabel(e.relationType),
        source: src,
        target: tgt,
        setting: { type: st, name: e.context?.settingName ?? '' },
        statement: e.sourceType === 'EXTERNAL_APP'
          ? `${srcText}は ${tgtText} を${e.context?.role ? `${e.context.role}として` : ''}参照している（他アプリからの被参照）`
          : `${srcText}${settingText} は ${tgtText} を「${relLabel(e.relationType)}」として利用している`,
      };
      if (e.context?.missing) { fact.missing = true; fact.statement += '（参照先のフィールドはフォームに存在しない）'; }
      if (e.context?.appId != null) fact.appId = String(e.context.appId);
      if (Array.isArray(e.context?.lines) && e.context.lines.length) fact.lines = e.context.lines.slice(0, 10);
      if (e.context?.matchCount != null) fact.matchCount = e.context.matchCount;
      if (e.context?.target) fact.jsTarget = e.context.target;
      if (e.context?.role) fact.role = e.context.role;
      if (e.context?.kind) fact.settingKind = e.context.kind;
      if (e.context?.note) fact.note = e.context.note;
      if (e.sourceType === 'CUSTOMIZE') {
        const evs = (deps?.meta?.jsEvents || {})[e.sourceId] || [];
        if (evs.length) fact.events = evs.map(v => (typeof v === 'string' ? v : v?.name)).filter(Boolean).slice(0, 10);
      }
      return fact;
    }

    /** 対象フィールドの L1 facts */
    function buildFieldFacts({ data, deps, scan, target, limits, trunc }) {
      const code = target.id;
      const facts = [];
      const edges = deps?.edges || [];
      const fieldsN = KTDeps.normalizeFields(data?.fields || {});
      const f = fieldsN.find(x => x.code === code);
      const node = (deps?.nodes || []).find(n => n.id === `FIELD:${code}`);

      // 1) 対象フィールドそのもの（定義）
      const def = {
        kind: 'field', key: `FIELD:${code}`, confidence: 'CERTAIN',
        field: {
          code, label: f?.label ?? node?.name ?? code,
          type: f ? (f.type === 'LOOKUP' ? f.rawType : f.type) : (node?.fieldType ?? 'UNKNOWN'),
          ...(f?.type === 'LOOKUP' ? { lookup: true } : {}),
          ...(f?.required ? { required: true } : {}), ...(f?.unique ? { unique: true } : {}),
          ...(f?.parent ? { subtable: f.parent } : {}),
          ...(f?.raw?.expression ? { expression: bounded(f.raw.expression, 200) } : {}),
          ...(Array.isArray(f?.raw?.options) || (f?.raw?.options && typeof f.raw.options === 'object')
            ? { optionCount: Object.keys(f.raw.options).length } : {}),
          ...(node?.fromScanner ? { fromScanner: true } : {}),
        },
        statement: f
          ? `フィールド「${f.label}」（コード ${code}・${f.type === 'LOOKUP' ? `${f.rawType}／ルックアップ` : f.type}${f.required ? '・必須' : ''}${f.unique ? '・重複禁止' : ''}${f.parent ? `・テーブル ${f.parent} 内` : ''}）はフォームに存在する`
          : `フィールドコード ${code} はフォーム定義に存在しない（JavaScript 解析でのみ現れた）`,
      };
      facts.push(def);

      // 2) 直接依存（このフィールドを利用している設定・JS。incoming / outgoing を区別する）
      const direct = edges.filter(e => e.targetType === 'FIELD' && e.targetId === code);
      const outgoing = edges.filter(e => e.sourceType === 'FIELD' && e.sourceId === code);
      const depFacts = [
        ...direct.map(e => factFromEdge(deps, e, 'usedBy')),
        ...outgoing.map(e => factFromEdge(deps, e, 'uses')),
      ];
      depFacts.sort((a, b) => (CONF_RANK[a.confidence] - CONF_RANK[b.confidence]) || cmp(a.key, b.key));
      const depKept = depFacts.slice(0, limits.maxDependencyFacts);
      if (depFacts.length > depKept.length) trunc('facts.dependency', depFacts.length, depKept.length);
      facts.push(...depKept);

      // 3) 間接依存・他アプリ連携・変更時の確認事項（impactOf: Toolkit の決定的な分析結果）
      const impact = deps ? safe(() => KTDeps.impactOf(deps, code), null) : null;
      if (impact) {
        const ind = (impact.indirect || []).map(i => ({
          kind: 'indirect-dependency', key: `INDIRECT|${i.category}|${i.title}|${i.role}|${i.via ?? ''}`,
          confidence: normConf(i.confidence), category: i.category, title: i.title, role: i.role, via: i.via,
          statement: `${i.category}「${i.title}」は${i.via ? `${i.via}で` : ''}対象フィールドを間接的に利用している（${i.role}）`,
        })).sort((a, b) => cmp(a.key, b.key));
        const indKept = ind.slice(0, limits.maxIndirectFacts);
        if (ind.length > indKept.length) trunc('facts.indirect-dependency', ind.length, indKept.length);
        facts.push(...indKept);
        for (const op of (impact.operations || [])) {
          if (op.key === 'COMMON') continue; // 解析範囲の注記は coverage に載せる
          facts.push({
            kind: 'change-impact', key: `IMPACT|${code}|${op.key}`, confidence: 'CERTAIN',
            operation: op.key, label: op.label, notes: [...op.notes],
            counts: { ...impact.counts },
            statement: `${op.label}: ${op.notes.join(' ')}`,
          });
        }
      }

      // 4) 計算式チェーン（対象が計算式を持つ／計算式から参照されている場合）
      const tree = deps ? safe(() => KTDeps.buildCalcTree(deps, code), null) : null;
      if (tree && tree.children && tree.children.length) {
        facts.push({
          kind: 'calc-chain', key: `CALC|${code}`, confidence: 'LIKELY',
          depth: KTDeps.calcTreeDepth(tree), tree: pruneTree(tree),
          statement: `対象フィールドの計算式は ${tree.children.length} 個のフィールドを参照している（深さ ${KTDeps.calcTreeDepth(tree)}）`,
        });
      }

      // 5) 壊れた参照（対象コードに関するもの。JS の近似一致も含める）
      const broken = deps ? safe(() => KTDeps.findBrokenRefs(deps), []) : [];
      const brokenMine = broken.filter(b => b.code === code || b.nearMatch === code);
      facts.push(...brokenMine.map(b => brokenFact(b)));

      // 6) JavaScript の出現箇所（Field Scanner の結果。抜粋は伏字・上限つき）
      const r = (scan?.results || []).find(x => x.code === code);
      if (r && Array.isArray(r.matches) && r.matches.length) {
        const ms = [...r.matches].sort((a, b) => cmp(`${a.target}:${a.kind}:${a.file}`, `${b.target}:${b.kind}:${b.file}`) || (a.line - b.line) || cmp(a.access, b.access));
        const kept = ms.slice(0, limits.maxJsMatchFacts);
        if (ms.length > kept.length) trunc('facts.js-match', ms.length, kept.length);
        const dupCount = new Map();   // 同じ行に同じ access の出現が複数ある（実データで確認）→ 連番で区別する
        for (const m of kept) {
          const base = `JS|${m.target}:${m.kind}:${m.file}|${m.line}|${m.access}|${code}`;
          const n = (dupCount.get(base) || 0) + 1; dupCount.set(base, n);
          facts.push({
            kind: 'js-match', key: n === 1 ? base : `${base}|#${n}`,
            confidence: normConf(m.confidence),
            file: { id: `${m.target}:${m.kind}:${m.file}`, name: m.file, target: m.target },
            line: m.line, access: m.access, snippet: snippetOf(m.snippet, limits.maxSnippetLen),
            statement: `${m.target} 用 JavaScript「${m.file}」の ${m.line} 行目で対象フィールドを ${m.access} として使用している`,
          });
        }
      }
      return facts;
    }

    const pruneTree = (t) => ({ code: t.code, name: t.name, ...(t.circular ? { circular: true } : {}), ...(t.truncated ? { truncated: true } : {}),
      children: (t.children || []).map(pruneTree) });

    function brokenFact(b) {
      return {
        kind: 'broken-reference', key: `BROKEN|${b.source}|${b.category}|${b.settingName}|${b.settingType}|${b.code}`,
        confidence: normConf(b.confidence), source: b.source, category: b.category,
        setting: { type: b.settingType, name: b.settingName }, role: b.role, code: b.code,
        ...(b.nearMatch ? { nearMatch: b.nearMatch } : {}), ...(b.count ? { count: b.count } : {}),
        statement: `${b.category}「${b.settingName}」の${b.role}に、存在しないコード「${b.code}」が指定されている${b.nearMatch ? `（近い既存コード: ${b.nearMatch}）` : ''}`,
      };
    }

    /** アプリ全体（対象なし）の facts: 壊れた参照とアプリ間連携の一覧 */
    function buildAppFacts({ data, deps, limits, trunc }) {
      const facts = [];
      const broken = deps ? safe(() => KTDeps.findBrokenRefs(deps), []) : [];
      const bk = broken.slice(0, limits.maxBrokenRefFacts);
      if (broken.length > bk.length) trunc('facts.broken-reference', broken.length, bk.length);
      facts.push(...bk.map(brokenFact));
      const links = deps ? safe(() => KTDeps.buildAppLinks(deps, data?.appId), []) : [];
      const lk = links.slice(0, limits.maxAppLinkFacts);
      if (links.length > lk.length) trunc('facts.app-link', links.length, lk.length);
      for (const l of lk) {
        facts.push({
          kind: 'app-link', key: `LINK|${l.kind}|${l.sourceId}|${l.destAppId}`, confidence: normConf(l.confidence),
          linkKind: l.kind, dataSource: l.dataSource, source: { id: l.sourceId, name: l.selfSide }, destAppId: l.destAppId,
          ...(l.destField && l.destField !== '—' ? { destField: l.destField } : {}),
          ...(l.selfKey ? { selfKey: l.selfKey } : {}), ...(l.lines ? { lines: l.lines.slice(0, 10) } : {}),
          statement: `${l.kind}「${l.selfSide}」は ${l.destAppLabel}${l.destField && l.destField !== '—' ? ` の「${l.destField}」` : ''} を参照している${l.dataSource === 'JS_STATIC' ? '（JavaScript の静的解析による推定）' : ''}`,
        });
      }
      // 他アプリからの被参照（走査済みのときだけ）
      const incomingEdges = (deps?.edges || []).filter(e => e.sourceType === 'EXTERNAL_APP');
      const inc = incomingEdges.map(e => ({ ...factFromEdge(deps, e, 'usedBy'), kind: 'incoming-reference' }))
        .sort((a, b) => cmp(a.key, b.key));
      const ik = inc.slice(0, limits.maxIncomingFacts);
      if (inc.length > ik.length) trunc('facts.incoming-reference', inc.length, ik.length);
      facts.push(...ik);
      return facts;
    }

    /** JS ファイル対象の L2 facts（KTScan 結果と既存 edge のみ。AST 解析はしない） */
    function buildFileFacts({ data, deps, scan, target, limits, trunc }) {
      const facts = [];
      const id = target.id; // target:kind:name（既存 edge の sourceId）
      const [tgt, kind, ...rest] = id.split(':');
      const name = rest.join(':');
      const node = (deps?.nodes || []).find(n => n.id === `CUSTOMIZE:${id}`);
      const events = ((deps?.meta?.jsEvents || scan?.fileEvents || {})[id] || []).map(v => (typeof v === 'string' ? { name: v, direct: true } : { name: v?.name ?? '', direct: !!v?.direct }));
      const edges = (deps?.edges || []).filter(e => e.sourceType === 'CUSTOMIZE' && e.sourceId === id);
      const fieldEdges = edges.filter(e => e.targetType === 'FIELD');
      const appEdges = edges.filter(e => e.targetType === 'APP');
      const extEdges = edges.filter(e => e.targetType === 'EXTERNAL_FIELD');
      facts.push({
        kind: 'js-file', key: `FILE|${id}`, confidence: node?.analyzed === false ? 'NOT_ANALYZED' : 'CERTAIN',
        file: { id, name, target: tgt, kind },
        analyzed: node ? node.analyzed !== false : !!scan,
        events: events.map(v => ({ name: v.name, direct: v.direct })),
        referencedFieldCount: new Set(fieldEdges.map(e => e.targetId)).size,
        appRefCount: appEdges.length, externalFieldRefCount: extEdges.length,
        statement: `${tgt} 用 ${kind === 'css' ? 'CSS' : 'JavaScript'}「${name}」は${events.length ? `イベント ${events.map(v => v.direct ? v.name : `${v.name}?`).join(', ')} で動作し、` : ''}フィールド ${new Set(fieldEdges.map(e => e.targetId)).size} 件・アプリ参照 ${appEdges.length} 件を含む`,
      });
      const refs = fieldEdges.map(e => factFromEdge(deps, e, 'uses')).sort((a, b) => cmp(a.key, b.key));
      const rk = refs.slice(0, limits.maxDependencyFacts);
      if (refs.length > rk.length) trunc('facts.js-reference', refs.length, rk.length);
      facts.push(...rk.map(f => ({ ...f, kind: 'js-reference' })));
      facts.push(...appEdges.map(e => ({ ...factFromEdge(deps, e, 'uses'), kind: 'js-app-reference' })).sort((a, b) => cmp(a.key, b.key)));
      facts.push(...extEdges.map(e => ({ ...factFromEdge(deps, e, 'uses'), kind: 'js-external-field' })).sort((a, b) => cmp(a.key, b.key)));
      // このファイルに残った存在しないコード
      const broken = deps ? safe(() => KTDeps.findBrokenRefs(deps), []) : [];
      facts.push(...broken.filter(b => b.source === 'JS'
        && String(b.settingName || '').split(' / ').some(n => n === name || n === `${tgt}:${name}` || n === `${tgt}: ${name}`)).map(brokenFact));
      // コード抜粋（本文がある場合のみ。対象行の前後・上限・伏字）
      const file = (scan?.files || []).find(f => f.name === name && f.target === tgt && f.kind === kind && typeof f.text === 'string');
      if (file) {
        const lines = file.text.split(/\r?\n/);
        const anchors = [...new Set(edges.flatMap(e => e.context?.lines || []))].filter(n => Number.isFinite(n)).sort((a, b) => a - b);
        const kept = anchors.slice(0, limits.maxCodeExcerpts);
        if (anchors.length > kept.length) trunc('facts.code-excerpt', anchors.length, kept.length);
        const half = Math.floor(limits.maxCodeExcerptLines / 2);
        for (const ln of kept) {
          const s = Math.max(1, ln - half), e2 = Math.min(lines.length, ln + half);
          const text = lines.slice(s - 1, e2).map((t, i) => `${s + i}: ${redactSecretLikeText(t)}`).join('\n');
          facts.push({
            kind: 'code-excerpt', key: `CODE|${id}|${ln}`, confidence: 'CERTAIN',
            file: { id, name, target: tgt }, lines: { from: s, to: e2, anchor: ln }, text: bounded(text, limits.maxSnippetLen * 8),
            statement: `「${name}」${s}〜${e2} 行目の抜粋（${ln} 行目付近。秘密情報らしき値は伏字）`,
          });
        }
      } else {
        // 本文が無いときは Scanner の抜粋（伏字・上限つき）だけを載せる
        const ms = (scan?.results || []).flatMap(r => (r.matches || []).filter(m => m.file === name && m.target === tgt).map(m => ({ ...m, code: r.code })))
          .sort((a, b) => (a.line - b.line) || cmp(a.code, b.code));
        const mk = ms.slice(0, limits.maxJsMatchFacts);
        if (ms.length > mk.length) trunc('facts.js-match', ms.length, mk.length);
        const dupCount = new Map();
        for (const m of mk) {
          const base = `JS|${id}|${m.line}|${m.access}|${m.code}`;
          const n = (dupCount.get(base) || 0) + 1; dupCount.set(base, n);
          facts.push({
            kind: 'js-match', key: n === 1 ? base : `${base}|#${n}`, confidence: normConf(m.confidence),
            file: { id, name, target: tgt }, fieldCode: m.code, line: m.line, access: m.access, snippet: snippetOf(m.snippet, limits.maxSnippetLen),
            statement: `「${name}」${m.line} 行目でフィールド「${m.code}」を ${m.access} として使用している`,
          });
        }
      }
      return facts;
    }

    // ================= build =================

    /**
     * Context を生成する（純関数）
     * @param {object} p
     *   question : 質問文（対象の自動解決に使う。無くてもよい）
     *   focus    : 明示の対象 { type:'field'|'file'|'app', id, label? }（指定時は question の解決を省略）
     *   data     : prefetchAppData の戻り値（DATA）
     *   deps     : KTDeps.buildDependencyData の戻り値（mergeScannerEdges / applyIncomingRefs 適用後が望ましい）
     *   scan     : Field Scanner の payload（results / files / appRefs / fileEvents / unknownRefs ...）省略可
     *   incoming : KTIncoming.run の戻り値（rows / stats / scannedAt）省略可
     *   options  : { level:'auto'|'L0'|'L1'|'L2', limits:{...}, now:string }
     */
    function build({ question = null, focus = null, data = null, deps = null, scan = null, incoming = null, options = {} } = {}) {
      const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
      const sections = new Map();
      const trunc = (name, total, included) => {
        const cur = sections.get(name);
        if (cur) { cur.total = Math.max(cur.total, total); cur.included = Math.min(cur.included, included); return; }
        sections.set(name, { name, total, included });
      };

      const resolved = resolveFocus({ question, focus, data, deps, scan });
      const target = resolved.target || null;
      // 自動判定: ファイル対象 → L2 / その他の対象 → L1 / 対象なしでも質問があればアプリ全体の L1 / 質問も無ければ L0
      let level = options.level && options.level !== 'auto' ? options.level
        : target?.type === 'file' ? LEVELS.L2 : target ? LEVELS.L1
          : (resolved.resolution === 'none' && question) ? LEVELS.L1 : LEVELS.L0;
      const levels = level === LEVELS.L2 ? ['L0', 'L1', 'L2'] : level === LEVELS.L1 ? ['L0', 'L1'] : ['L0'];

      const app = buildAppOverview({ data, deps, scan, incoming, limits, trunc });
      const coverage = buildCoverage({ data, deps, scan, incoming });

      let facts = [];
      if (level !== LEVELS.L0 && target?.type === 'field') facts = buildFieldFacts({ data, deps, scan, target, limits, trunc });
      else if (level === LEVELS.L2 && target?.type === 'file') facts = buildFileFacts({ data, deps, scan, target, limits, trunc });
      else if (!target && level !== LEVELS.L0) facts = buildAppFacts({ data, deps, limits, trunc });
      // L1 以上では L0 の要点にも根拠ID を付ける（AI が概要を引用できる。順序は末尾なので他の ID は不変）
      if (level !== LEVELS.L0) facts.push(...buildOverviewFacts(app, coverage));

      // 重複排除（同じ key は 1 件）→ 決定的な並び → 根拠ID採番
      const seen = new Set();
      facts = facts.filter(f => { if (seen.has(f.key)) return false; seen.add(f.key); return true; });
      facts.sort((a, b) => (kindRank(a.kind) - kindRank(b.kind)) || cmp(a.key, b.key));
      if (facts.length > limits.maxFacts) {
        trunc('facts', facts.length, limits.maxFacts);
        facts = facts.slice(0, limits.maxFacts);
      }
      facts = facts.map((f, i) => ({ id: `E${i + 1}`, ...f }));

      const ctx = {
        contextVersion: CONTEXT_VERSION,
        generatedAt: options.now ?? new Date().toISOString(),
        generator: { name: 'kintone App Toolkit', version: SCRIPT_VERSION, analyzerVersion: KTScan?.ANALYZER_VERSION ?? null },
        question: question == null ? null : String(question),
        focus: {
          resolution: resolved.resolution,
          ...(target ? { target } : {}),
          candidates: resolved.candidates,
        },
        level, levels,
        app,
        facts,
        confidenceVocabulary: { CERTAIN: '構造化された設定値から直接取得（確実）', LIKELY: '条件式・計算式・JS のトークン一致（可能性が高い）', UNCERTAIN: '文字列一致のみ（要確認）', NOT_ANALYZED: '解析対象外' },
        coverage,
        truncation: { applied: false, sections: [] },
        size: null,
      };

      // バイト上限（任意）: 超過したら事実を末尾（優先度の低い kind）から削って記録する
      const budget = limits.maxBytes ?? null;
      const finalize = () => {
        ctx.truncation = { applied: sections.size > 0, sections: [...sections.values()].sort((a, b) => cmp(a.name, b.name)) };
        ctx.size = null;
        const m = measureText(JSON.stringify(ctx));
        ctx.size = { bytes: m.bytes, chars: m.chars, approxTokens: m.approxTokens, facts: ctx.facts.length, budgetBytes: budget ?? LEVEL_BUDGET_BYTES[level] ?? null };
      };
      finalize();
      if (budget && ctx.size.bytes > budget) {
        const total = ctx.facts.length;
        while (ctx.facts.length > 1 && ctx.size.bytes > budget) {
          ctx.facts = ctx.facts.slice(0, Math.max(1, Math.floor(ctx.facts.length * 0.8)));
          trunc('facts', total, ctx.facts.length);
          finalize();
        }
        if (ctx.size.bytes > budget && ctx.app.fields.length > 20) {
          const t = ctx.app.fieldCount;
          ctx.app.fields = ctx.app.fields.slice(0, 20);
          trunc('app.fields', t, 20);
          finalize();
        }
      }
      return ctx;
    }

    // ================= 出力 =================

    const toJSON = (ctx, { pretty = false } = {}) => JSON.stringify(ctx, null, pretty ? 2 : 0);

    // ================= Planner Context（AI Change Planner・contextVersion "planner-1"）=================
    //   「実現したい業務（goal）」から、アプリ全体の既存資産（フィールド・プロセス・通知・一覧・ACL・アプリアクション・
    //   依存関係・JS 参照・被参照・壊れた参照）を根拠ID 付きの facts として渡す。単一 focus ではなく、goal との
    //   関連度（retrieval。決定的な辞書照合・キーワード→種別のヒント。LLM は使わない）で候補を複数抽出し、
    //   サイズ上限では関連度の低いものから省略する（省略は truncation に記録）。full DEPS は送らない。
    //   dictionary（既存の識別子一覧）は、AI が「存在しないフィールド・ステータス・通知・一覧」を既存として扱うのを
    //   Gateway / クライアントが検出するために使う。
    const PLANNER_CONTEXT_VERSION = 'planner-1';
    const PLANNER_LIMITS = {
      maxFields: 200, maxOptions: 8, maxDependencyFacts: 60, maxJsFacts: 40, maxIncomingFacts: 20, maxBrokenRefFacts: 20,
      maxViews: 30, maxReports: 20, maxNotifications: 30, maxReminders: 20, maxRecordAcl: 20, maxFieldAcl: 30, maxAppActions: 20,
      maxFacts: 400, maxBytes: 64 * 1024, maxGoalChars: 2000,
    };
    const PLANNER_KIND_ORDER = [
      'overview', 'field', 'process-state', 'process-action', 'notification', 'reminder', 'view', 'report', 'record-acl', 'field-acl', 'app-action',
      'dependency', 'js-reference', 'incoming-reference', 'broken-reference', 'app-link',
    ];
    const plannerKindRank = (k) => { const i = PLANNER_KIND_ORDER.indexOf(k); return i < 0 ? 99 : i; };
    // goal のキーワード → 関係する種別（決定的なヒント。LLM は使わない）
    const PLANNER_HINTS = [
      { re: /通知|知らせ|連絡|メール/, settings: ['notification', 'reminder'], fieldTypes: { USER_SELECT: 3, ORGANIZATION_SELECT: 2, GROUP_SELECT: 2 } },
      { re: /リマインド|リマインダー|日前|前日|期限|締切|期日|経過/, settings: ['reminder'], fieldTypes: { DATE: 4, DATETIME: 3 } },
      { re: /承認|決裁|申請|却下|差し戻|ステータス|プロセス|ワークフロー|作業者/, settings: ['process-state', 'process-action'], fieldTypes: { USER_SELECT: 3, STATUS: 2, STATUS_ASSIGNEE: 2 } },
      { re: /金額|円|以上|以下|超え|未満|合計|単価|数量|税/, settings: [], fieldTypes: { NUMBER: 4, CALC: 3 } },
      { re: /担当|責任者|営業|管理者|部長|課長|上長|本人|ユーザー/, settings: [], fieldTypes: { USER_SELECT: 4, ORGANIZATION_SELECT: 2, GROUP_SELECT: 2, CREATOR: 1 } },
      { re: /住所|電話|メール|取得|マスタ|ルックアップ|コピー|参照/, settings: ['app-link'], fieldTypes: { LOOKUP: 5, SINGLE_LINE_TEXT: 1, LINK: 1 } },
      { re: /一覧|絞り込|並び|表示|ビュー/, settings: ['view'], fieldTypes: {} },
      { re: /権限|閲覧|編集|削除|見せ|公開|非公開|アクセス/, settings: ['record-acl', 'field-acl'], fieldTypes: {} },
      { re: /契約|更新|開始|終了|有効/, settings: ['reminder'], fieldTypes: { DATE: 3, DROP_DOWN: 2, RADIO_BUTTON: 1 } },
      { re: /計算|自動|集計|グラフ/, settings: ['report'], fieldTypes: { CALC: 3, NUMBER: 1 } },
      { re: /別アプリ|他アプリ|連携|作成|アクション/, settings: ['app-action', 'app-link'], fieldTypes: {} },
    ];
    /** 文字列 label の長さ 2 以上の部分文字列が goal に含まれる最長の長さ（部分一致の強さ） */
    function longestSharedSubstring(goal, label) {
      const l = String(label || '');
      if (!l || l.length < 2) return 0;
      if (goal.includes(l)) return l.length;
      for (let len = Math.min(l.length - 1, 12); len >= 2; len--) {
        for (let i = 0; i + len <= l.length; i++) { if (goal.includes(l.slice(i, i + len))) return len; }
      }
      return 0;
    }
    const entityText = (en) => en ? `${en.type}${en.code != null && en.code !== '' ? `:${en.code}` : ''}` : '';
    const entityList = (list, pick = (x) => x?.entity) => (Array.isArray(list) ? list : []).map(x => pick(x)).filter(Boolean).map(en => ({ type: en.type, code: en.code ?? null }));
    const fieldEntityCodes = (list, pick = (x) => x?.entity) => entityList(list, pick).filter(e => e.type === 'FIELD_ENTITY' && e.code).map(e => e.code);

    /**
     * Planner Context を生成する（純関数）
     * @param {object} p goal（必須）/ data / deps / scan / incoming / options { limits, now }
     */
    function buildPlan({ goal = '', data = null, deps = null, scan = null, incoming = null, options = {} } = {}) {
      const limits = { ...PLANNER_LIMITS, ...(options.limits || {}) };
      const g = String(goal ?? '').slice(0, limits.maxGoalChars);
      const sections = new Map();
      const trunc = (name, total, included) => {
        const cur = sections.get(name);
        if (cur) { cur.total = Math.max(cur.total, total); cur.included = Math.min(cur.included, included); return; }
        sections.set(name, { name, total, included });
      };
      const app = buildAppOverview({ data, deps, scan, incoming, limits: { ...DEFAULT_LIMITS, maxFields: 0, maxViewNames: 0 }, trunc: () => { } });
      delete app.fields;   // フィールドは facts（inventory）側に載せる
      const coverage = buildCoverage({ data, deps, scan, incoming });
      const fieldsN = KTDeps.normalizeFields(data?.fields || {});
      const edges = deps?.edges || [];

      // ---- retrieval: goal → 関連する種別・フィールド ----
      const hints = PLANNER_HINTS.filter(h => h.re.test(g));
      const relevantSettings = new Set(hints.flatMap(h => h.settings));
      const fieldTypeScore = {};
      for (const h of hints) for (const [t, v] of Object.entries(h.fieldTypes)) fieldTypeScore[t] = Math.max(fieldTypeScore[t] || 0, v);
      const dict = buildDictionary({ data, deps, scan });
      const matchedTerms = [];
      const fieldScore = new Map();   // code -> { score, reasons[] }
      const bump = (code, pts, reason) => {
        const cur = fieldScore.get(code) || { score: 0, reasons: [] };
        cur.score += pts; if (reason && !cur.reasons.includes(reason)) cur.reasons.push(reason);
        fieldScore.set(code, cur);
      };
      for (const f of fieldsN) {
        const t = f.type === 'LOOKUP' ? 'LOOKUP' : f.rawType;
        const byLabel = longestSharedSubstring(g, f.label), byCode = longestSharedSubstring(g, f.code);
        const best = Math.max(byLabel, byCode);
        if (best >= 2) { bump(f.code, best >= Math.max(2, Math.min(String(f.label).length, String(f.code).length)) ? 10 : Math.min(6, best), `goal に「${byLabel >= byCode ? f.label : f.code}」の語が含まれる`); }
        if (fieldTypeScore[t]) bump(f.code, fieldTypeScore[t], `goal の内容から ${t} 型が関係しやすい`);
        if (fieldTypeScore.LOOKUP && f.type === 'LOOKUP') bump(f.code, 2, 'ルックアップ');
      }
      for (const en of dict) { if (g.includes(en.key) && !matchedTerms.some(m => m.key === en.key && m.type === en.type)) matchedTerms.push({ key: en.key, type: en.type, id: en.id }); }
      matchedTerms.sort((a, b) => (b.key.length - a.key.length) || cmp(a.type, b.type) || cmp(a.id, b.id));
      // 設定名の一致（一覧・通知・ステータス等）
      const settingHit = (name) => !!name && longestSharedSubstring(g, name) >= 2;

      // ---- facts（既存資産の棚卸し。各 fact に根拠ID を付ける）----
      let facts = [];
      const push = (fact, relevance) => facts.push({ ...fact, relevance });
      // overview
      for (const o of buildOverviewFacts(app, coverage)) push(o, 100);   // 概要は省略しない（関連度を最大にする）
      // fields
      const fieldRows = fieldsN.filter(f => f.rawType !== 'SUBTABLE' || true);
      const fieldFacts = fieldRows.map(f => {
        const sc = fieldScore.get(f.code) || { score: 0, reasons: [] };
        const raw = f.raw || {};
        const opts = raw.options && typeof raw.options === 'object' ? Object.keys(raw.options).sort((a, b) => (Number(raw.options[a]?.index ?? 0) - Number(raw.options[b]?.index ?? 0)) || cmp(a, b)) : null;
        const lookup = raw.lookup ? {
          app: String(raw.lookup.relatedApp?.app ?? ''), keyField: raw.lookup.relatedKeyField ?? null,
          mappings: (raw.lookup.fieldMappings || []).map(m => ({ to: m.field, from: m.relatedField })),
        } : null;
        const refTable = raw.referenceTable ? { app: String(raw.referenceTable.relatedApp?.app ?? ''), condition: raw.referenceTable.condition ?? null, displayFields: raw.referenceTable.displayFields || [] } : null;
        const type = f.type === 'LOOKUP' ? `${f.rawType}（ルックアップ）` : f.rawType;
        return {
          kind: 'field', key: `FIELD:${f.code}`, confidence: 'CERTAIN',
          field: {
            code: f.code, label: f.label, type: f.rawType, ...(f.type === 'LOOKUP' ? { lookup } : {}),
            ...(f.required ? { required: true } : {}), ...(f.unique ? { unique: true } : {}), ...(f.parent ? { subtable: f.parent } : {}),
            ...(opts ? { options: opts.slice(0, limits.maxOptions), optionCount: opts.length } : {}),
            ...(raw.expression ? { expression: bounded(raw.expression, 160) } : {}),
            ...(refTable ? { referenceTable: refTable } : {}),
            ...(raw.enabled === false ? { enabled: false } : {}),
          },
          statement: `フィールド「${f.label}」（コード ${f.code}・${type}${f.required ? '・必須' : ''}${f.unique ? '・重複禁止' : ''}${f.parent ? `・テーブル ${f.parent} 内` : ''}${opts ? `・選択肢 ${opts.length} 件` : ''}${lookup ? `・アプリ ${lookup.app} から ${lookup.mappings.length} 項目を取得` : ''}${raw.expression ? `・計算式 ${bounded(raw.expression, 60)}` : ''}）はフォームに存在する`,
          _score: sc.score, _reasons: sc.reasons,
        };
      });
      fieldFacts.sort((a, b) => (b._score - a._score) || cmp(a.key, b.key));
      const fieldKept = fieldFacts.slice(0, limits.maxFields);
      if (fieldFacts.length > fieldKept.length) trunc('facts.field', fieldFacts.length, fieldKept.length);
      for (const ff of fieldKept) { const { _score, _reasons, ...rest } = ff; push({ ...rest, ...(_reasons.length ? { retrieval: { score: _score, reasons: _reasons } } : {}) }, _score); }
      // process
      const states = data?.status?.enable ? Object.values(data.status.states || {}).filter(Boolean).sort((a, b) => (Number(a.index ?? 0) - Number(b.index ?? 0)) || cmp(String(a.name), String(b.name))) : [];
      const procRel = relevantSettings.has('process-state') ? 5 : 1;
      for (const st of states) {
        const ents = entityList(st.assignee?.entities);
        push({
          kind: 'process-state', key: `STATE#${String(Number(st.index ?? 0)).padStart(2, '0')}:${st.name}`, confidence: 'CERTAIN',
          state: { name: st.name, index: Number(st.index ?? 0), assigneeType: st.assignee?.type ?? null, assignees: ents },
          statement: `プロセス管理のステータス「${st.name}」（${Number(st.index ?? 0) + 1} 番目）${ents.length ? `の作業者は ${ents.map(entityText).join(', ')}` : 'に作業者の指定は無い'}`,
        }, procRel + (settingHit(st.name) ? 5 : 0));
      }
      for (const ac of (data?.status?.enable ? (data.status.actions || []) : [])) {
        const ex = entityList(ac.executableUser?.entities);
        push({
          kind: 'process-action', key: `ACTION:${ac.name}|${ac.from}|${ac.to}`, confidence: 'CERTAIN',
          action: { name: ac.name, from: ac.from, to: ac.to, type: ac.type ?? null, filterCond: ac.filterCond ? bounded(ac.filterCond, 160) : '', executableUsers: ex },
          statement: `プロセスアクション「${ac.name}」は「${ac.from}」→「${ac.to}」${ac.filterCond ? `（条件: ${bounded(ac.filterCond, 80)}）` : ''}${ex.length ? `、実行可能ユーザー ${ex.map(entityText).join(', ')}` : ''}`,
        }, procRel + (settingHit(ac.name) ? 5 : 0));
      }
      if (!data?.status?.enable && data?.status) push({ kind: 'process-state', key: 'STATE:(disabled)', confidence: 'CERTAIN', state: null, statement: 'プロセス管理は無効（ステータス・作業者・アクションは使われていない）' }, procRel);
      // notifications
      const notiRel = relevantSettings.has('notification') ? 5 : 1;
      const gen = (data?.generalNotify?.notifications || []);
      gen.slice(0, limits.maxNotifications).forEach((n, i) => {
        const events = ['recordAdded', 'recordEdited', 'commentAdded', 'statusChanged', 'fileImported'].filter(k => n[k]);
        push({ kind: 'notification', key: `NOTIFY:general#${i + 1}`, confidence: 'CERTAIN',
          notification: { id: `general#${i + 1}`, scope: 'general', target: { type: n.entity?.type, code: n.entity?.code ?? null }, events },
          statement: `アプリの条件通知 #${i + 1}: ${entityText(n.entity)} へ ${events.join(', ') || '（イベント指定なし）'} を通知` }, notiRel + (n.entity?.type === 'FIELD_ENTITY' && fieldScore.has(n.entity.code) ? 3 : 0));
      });
      if (gen.length > limits.maxNotifications) trunc('facts.notification.general', gen.length, limits.maxNotifications);
      const per = (data?.perRecordNotify?.notifications || []);
      per.slice(0, limits.maxNotifications).forEach((n, i) => {
        const targets = entityList(n.targets);
        const codes = fieldEntityCodes(n.targets);
        push({ kind: 'notification', key: `NOTIFY:perRecord#${i + 1}`, confidence: 'CERTAIN',
          notification: { id: `perRecord#${i + 1}`, scope: 'perRecord', title: n.title || '', filterCond: bounded(n.filterCond || '', 160), targets },
          statement: `レコードの条件通知 #${i + 1}「${n.title || '（無題）'}」: 条件 ${n.filterCond ? bounded(n.filterCond, 80) : '（なし）'} で ${targets.map(entityText).join(', ') || '（通知先なし）'} へ通知` },
        notiRel + (settingHit(n.title) ? 5 : 0) + (codes.some(c => fieldScore.has(c)) ? 3 : 0));
      });
      if (per.length > limits.maxNotifications) trunc('facts.notification.perRecord', per.length, limits.maxNotifications);
      const rem = (data?.reminderNotify?.notifications || []);
      const remRel = relevantSettings.has('reminder') ? 5 : 1;
      rem.slice(0, limits.maxReminders).forEach((n, i) => {
        const targets = entityList(n.targets);
        push({ kind: 'reminder', key: `REMINDER#${i + 1}`, confidence: 'CERTAIN',
          reminder: { id: `reminder#${i + 1}`, title: n.title || '', timing: { code: n.timing?.code ?? null, daysLater: n.timing?.daysLater ?? null, time: n.timing?.time ?? null }, filterCond: bounded(n.filterCond || '', 160), targets },
          statement: `リマインダー #${i + 1}「${n.title || '（無題）'}」: 「${n.timing?.code ?? '?'}」の ${n.timing?.daysLater ?? '?'} 日後 ${n.timing?.time ?? ''} に ${targets.map(entityText).join(', ') || '（通知先なし）'} へ通知${n.filterCond ? `（条件: ${bounded(n.filterCond, 60)}）` : ''}` },
        remRel + (settingHit(n.title) ? 5 : 0) + (fieldScore.has(n.timing?.code) ? 3 : 0));
      });
      if (rem.length > limits.maxReminders) trunc('facts.reminder', rem.length, limits.maxReminders);
      if (coverage.settings?.notifications && !gen.length && !per.length && !rem.length) push({ kind: 'notification', key: 'NOTIFY:(none)', confidence: 'CERTAIN', notification: null, statement: '通知（アプリの条件通知・レコードの条件通知・リマインダー）は設定されていない' }, notiRel);
      // views / reports
      const viewRel = relevantSettings.has('view') ? 4 : 1;
      const views = Object.values(data?.views?.views || {}).filter(Boolean).sort((a, b) => (Number(a.index ?? 0) - Number(b.index ?? 0)) || cmp(String(a.name), String(b.name)));
      views.slice(0, limits.maxViews).forEach(v => push({ kind: 'view', key: `VIEW:${v.name}`, confidence: 'CERTAIN',
        view: { name: v.name, type: v.type ?? null, fields: Array.isArray(v.fields) ? v.fields.slice(0, 20) : [], filterCond: bounded(v.filterCond || '', 160), sort: v.sort || '' },
        statement: `一覧「${v.name}」（${v.type ?? 'LIST'}）${v.filterCond ? `: 絞り込み ${bounded(v.filterCond, 80)}` : ''}${Array.isArray(v.fields) && v.fields.length ? `、表示 ${v.fields.slice(0, 8).join(', ')}${v.fields.length > 8 ? ' ほか' : ''}` : ''}` },
        viewRel + (settingHit(v.name) ? 5 : 0) + ((v.fields || []).some(c => fieldScore.has(c)) ? 2 : 0)));
      if (views.length > limits.maxViews) trunc('facts.view', views.length, limits.maxViews);
      const reports = Object.values(data?.reports?.reports || {}).filter(Boolean).sort((a, b) => (Number(a.index ?? 0) - Number(b.index ?? 0)) || cmp(String(a.name), String(b.name)));
      reports.slice(0, limits.maxReports).forEach(r => push({ kind: 'report', key: `REPORT:${r.name}`, confidence: 'CERTAIN', report: { name: r.name, chartType: r.chartType ?? null }, statement: `グラフ「${r.name}」${r.chartType ? `（${r.chartType}）` : ''}が存在する` }, (relevantSettings.has('report') ? 3 : 1) + (settingHit(r.name) ? 5 : 0)));
      if (reports.length > limits.maxReports) trunc('facts.report', reports.length, limits.maxReports);
      // ACL
      const aclRel = relevantSettings.has('record-acl') ? 4 : 1;
      const racl = (data?.recordAcl?.rights || []);
      racl.slice(0, limits.maxRecordAcl).forEach((r, i) => push({ kind: 'record-acl', key: `RECORD_ACL#${i + 1}`, confidence: 'CERTAIN',
        acl: { id: `record#${i + 1}`, filterCond: bounded(r.filterCond || '', 160), entities: (r.entities || []).map(e => ({ type: e.entity?.type, code: e.entity?.code ?? null, viewable: !!e.viewable, editable: !!e.editable, deletable: !!e.deletable })) },
        statement: `レコードのアクセス権 #${i + 1}: 条件 ${r.filterCond ? bounded(r.filterCond, 60) : '（全レコード）'} に対し ${(r.entities || []).map(e => `${entityText(e.entity)}(${[e.viewable && '閲覧', e.editable && '編集', e.deletable && '削除'].filter(Boolean).join('/') || '不可'})`).join(', ')}` }, aclRel));
      if (racl.length > limits.maxRecordAcl) trunc('facts.record-acl', racl.length, limits.maxRecordAcl);
      const facl = (data?.fieldAcl?.rights || []);
      facl.slice(0, limits.maxFieldAcl).forEach((r, i) => push({ kind: 'field-acl', key: `FIELD_ACL:${r.code}`, confidence: 'CERTAIN',
        acl: { id: `field:${r.code}`, code: r.code, entities: (r.entities || []).map(e => ({ type: e.entity?.type, code: e.entity?.code ?? null, accessibility: e.accessibility })) },
        statement: `フィールド「${r.code}」のアクセス権: ${(r.entities || []).map(e => `${entityText(e.entity)}=${e.accessibility}`).join(', ')}` }, aclRel + (fieldScore.has(r.code) ? 3 : 0)));
      if (facl.length > limits.maxFieldAcl) trunc('facts.field-acl', facl.length, limits.maxFieldAcl);
      // app actions
      const acts = Object.values(data?.actions?.actions || {}).filter(Boolean).sort((a, b) => (Number(a.index ?? 0) - Number(b.index ?? 0)) || cmp(String(a.name), String(b.name)));
      acts.slice(0, limits.maxAppActions).forEach(a => push({ kind: 'app-action', key: `APP_ACTION:${a.name}`, confidence: 'CERTAIN',
        appAction: { name: a.name, destApp: String(a.destApp?.app ?? ''), mappings: (a.mappings || []).map(m => ({ srcType: m.srcType, srcField: m.srcField ?? null, destField: m.destField })) },
        statement: `アプリアクション「${a.name}」はアプリ ${a.destApp?.app ?? '?'} へレコードを作成し、${(a.mappings || []).length} 項目をコピーする` }, (relevantSettings.has('app-action') ? 4 : 1) + (settingHit(a.name) ? 5 : 0)));
      if (acts.length > limits.maxAppActions) trunc('facts.app-action', acts.length, limits.maxAppActions);
      // dependencies（関連フィールドに触れる edge を優先。full DEPS は送らない）
      const relCodes = new Set([...fieldScore.entries()].filter(([, v]) => v.score >= 3).map(([k]) => k));
      const depFacts = edges.filter(e => e.sourceType !== 'EXTERNAL_APP' && e.sourceType !== 'CUSTOMIZE')
        .map(e => ({ fact: factFromEdge(deps, e, 'usedBy'), rel: (relCodes.has(e.targetId) || relCodes.has(e.sourceId)) ? 4 : 0 }))
        .sort((a, b) => (b.rel - a.rel) || cmp(a.fact.key, b.fact.key));
      const depKept = depFacts.slice(0, limits.maxDependencyFacts);
      if (depFacts.length > depKept.length) trunc('facts.dependency', depFacts.length, depKept.length);
      for (const d of depKept) push(d.fact, d.rel);
      const jsFacts = edges.filter(e => e.sourceType === 'CUSTOMIZE')
        .map(e => ({ fact: { ...factFromEdge(deps, e, 'usedBy'), kind: 'js-reference' }, rel: (relCodes.has(e.targetId)) ? 4 : 0 }))
        .sort((a, b) => (b.rel - a.rel) || cmp(a.fact.key, b.fact.key));
      const jsKept = jsFacts.slice(0, limits.maxJsFacts);
      if (jsFacts.length > jsKept.length) trunc('facts.js-reference', jsFacts.length, jsKept.length);
      for (const d of jsKept) push(d.fact, d.rel);
      const incFacts = edges.filter(e => e.sourceType === 'EXTERNAL_APP').map(e => ({ ...factFromEdge(deps, e, 'usedBy'), kind: 'incoming-reference' })).sort((a, b) => cmp(a.key, b.key));
      const incKept = incFacts.slice(0, limits.maxIncomingFacts);
      if (incFacts.length > incKept.length) trunc('facts.incoming-reference', incFacts.length, incKept.length);
      for (const d of incKept) push(d, relCodes.has(d.target?.id) ? 4 : 1);
      const broken = deps ? safe(() => KTDeps.findBrokenRefs(deps), []) : [];
      const bk = broken.slice(0, limits.maxBrokenRefFacts);
      if (broken.length > bk.length) trunc('facts.broken-reference', broken.length, bk.length);
      for (const b of bk) push(brokenFact(b), 2);
      const links = deps ? safe(() => KTDeps.buildAppLinks(deps, data?.appId), []) : [];
      for (const l of links.slice(0, limits.maxAppLinkFacts || 30)) push({
        kind: 'app-link', key: `LINK|${l.kind}|${l.sourceId}|${l.destAppId}`, confidence: normConf(l.confidence),
        linkKind: l.kind, dataSource: l.dataSource, source: { id: l.sourceId, name: l.selfSide }, destAppId: l.destAppId,
        statement: `${l.kind}「${l.selfSide}」は ${l.destAppLabel}${l.destField && l.destField !== '—' ? ` の「${l.destField}」` : ''} を参照している`,
      }, relevantSettings.has('app-link') ? 3 : 1);

      // ---- 重複排除 → 決定的な並び → 採番 ----
      const seen = new Set();
      facts = facts.filter(x => { if (seen.has(x.key)) return false; seen.add(x.key); return true; });
      const order = (a, b) => (plannerKindRank(a.kind) - plannerKindRank(b.kind)) || cmp(a.key, b.key);
      const assign = () => { facts.sort(order); facts = facts.map((x, i) => ({ id: `E${i + 1}`, ...x })); };
      if (facts.length > limits.maxFacts) {
        // 関連度の低いものから削る（overview / field は残す）
        const keep = [...facts].sort((a, b) => (b.relevance - a.relevance) || order(a, b)).slice(0, limits.maxFacts);
        trunc('facts', facts.length, keep.length);
        facts = keep;
      }
      assign();

      // ---- dictionary（既存の識別子。AI の幻覚検出に使う）----
      const dictionary = {
        fieldCodes: fieldsN.map(x => x.code).sort(cmp),
        fieldLabels: [...new Set(fieldsN.map(x => x.label))].sort(cmp),
        fieldTypes: Object.fromEntries(fieldsN.map(x => [x.code, x.rawType])),
        statuses: states.map(x => x.name),
        processActions: (data?.status?.enable ? (data.status.actions || []) : []).map(a => a.name),
        // 通知・リマインダーは id（perRecord#1 等）に加えてタイトルでも参照できるようにする（AI はタイトルで呼ぶことが多い）
        notifications: [...gen.map((_, i) => `general#${i + 1}`), ...per.map((_, i) => `perRecord#${i + 1}`), ...per.map(n => String(n.title || '').trim()).filter(Boolean)],
        reminders: [...rem.map((_, i) => `reminder#${i + 1}`), ...rem.map(n => String(n.title || '').trim()).filter(Boolean)],
        views: views.map(v => v.name),
        reports: reports.map(r => r.name),
        appActions: acts.map(a => a.name),
        jsFiles: (deps?.nodes || []).filter(n => n.type === 'CUSTOMIZE').map(n => n.name).sort(cmp),
      };

      const candidates = {
        fields: [...fieldScore.entries()].filter(([, v]) => v.score > 0).map(([code, v]) => ({ code, label: fieldsN.find(x => x.code === code)?.label ?? code, type: fieldsN.find(x => x.code === code)?.rawType ?? null, score: v.score, reasons: v.reasons, evidenceId: facts.find(x => x.kind === 'field' && x.field?.code === code)?.id ?? null }))
          .sort((a, b) => (b.score - a.score) || cmp(a.code, b.code)).slice(0, 20),
        settings: [...relevantSettings],
        matchedTerms,
      };

      const ctx = {
        contextVersion: PLANNER_CONTEXT_VERSION,
        generatedAt: options.now ?? new Date().toISOString(),
        generator: { name: 'kintone App Toolkit', version: SCRIPT_VERSION, analyzerVersion: KTScan?.ANALYZER_VERSION ?? null },
        goal: g,
        app,
        retrieval: candidates,
        facts,
        dictionary,
        confidenceVocabulary: { CERTAIN: '構造化された設定値から直接取得（確実）', LIKELY: '条件式・計算式・JS のトークン一致（可能性が高い）', UNCERTAIN: '文字列一致のみ（要確認）', NOT_ANALYZED: '解析対象外' },
        coverage,
        truncation: { applied: false, sections: [] },
        size: null,
      };
      const budget = limits.maxBytes ?? null;
      const finalize = () => {
        ctx.truncation = { applied: sections.size > 0, sections: [...sections.values()].sort((a, b) => cmp(a.name, b.name)) };
        ctx.size = null;
        const m = measureText(JSON.stringify(ctx));
        ctx.size = { bytes: m.bytes, chars: m.chars, approxTokens: m.approxTokens, facts: ctx.facts.length, budgetBytes: budget };
      };
      finalize();
      if (budget && ctx.size.bytes > budget) {
        // 関連度の低い fact から削る（overview と関連フィールドは残す）。採番は削った後にやり直す
        const total = ctx.facts.length;
        let pool = ctx.facts.map(x => { const { id, ...rest } = x; return rest; });
        while (pool.length > 10 && ctx.size.bytes > budget) {
          pool.sort((a, b) => (b.relevance - a.relevance) || order(a, b));
          pool = pool.slice(0, Math.max(10, Math.floor(pool.length * 0.8)));
          facts = pool; assign(); ctx.facts = facts;
          trunc('facts', total, facts.length);
          finalize();
        }
      }
      return ctx;
    }

    /** Planner Context の人間向け Markdown（無料版の「変更計画 Prompt をコピー」で使う） */
    function toPlannerMarkdown(ctx) {
      const out = [];
      const app = ctx.app || {};
      out.push(`# ${app.name ? `${app.name}（app ${app.id}）` : `app ${app.id}`} — Change Planner Context`);
      out.push('');
      out.push(`**実現したいこと**: ${mdEsc(ctx.goal)}`);
      out.push(`**生成**: ${ctx.generatedAt}  **facts**: ${ctx.facts.length}${ctx.truncation?.applied ? '（一部省略あり）' : ''}`);
      out.push('');
      if (ctx.retrieval?.candidates?.length || ctx.retrieval?.fields?.length) {
        out.push('## 関連しそうな既存フィールド（Toolkit の辞書照合）');
        for (const c of (ctx.retrieval.fields || [])) out.push(`- ${c.evidenceId ? `[${c.evidenceId}] ` : ''}${mdEsc(c.label)}（${c.code}・${c.type}）: ${mdEsc(c.reasons.join('／'))}`);
        out.push('');
      }
      out.push('## 既存資産（facts。根拠ID で引用する）');
      let lastKind = null;
      for (const f of ctx.facts) {
        if (f.kind !== lastKind) { out.push(`### ${f.kind}`); lastKind = f.kind; }
        out.push(`- [${f.id}] ${mdEsc(f.statement)}（${confJa(f.confidence)}）`);
      }
      out.push('');
      out.push('## 解析範囲');
      for (const n of (ctx.coverage?.notes || [])) out.push(`- ${mdEsc(n)}`);
      if (ctx.truncation?.applied) { out.push(''); out.push('## 省略'); for (const t of ctx.truncation.sections) out.push(`- ${t.name}: ${t.included} / ${t.total}`); }
      return out.join('\n');
    }
    function toPlannerPrompt(ctx) {
      const rules = [
        'あなたは kintone アプリの変更計画を作るアシスタントです。利用者が実現したい業務を、現在のアプリ設定（下の facts）を使ってどう構築するかを考えてください。',
        '順序: 1) 既存のフィールド・設定だけで実現できないか 2) 既存設定の変更・追加だけで実現できないか 3) 新しい標準設定が必要か 4) 新しいフィールドが必要か 5) 標準機能で不足する場合だけカスタマイズ。',
        'kintone 標準設定を優先し、JavaScript カスタマイズは最後の手段にしてください。既存設定に関する主張は根拠ID（E1 など）を引用してください。',
        '既存フィールドの意味（例: 「承認者」が部長承認者かどうか）は Toolkit の解析では確認できません。勝手に決めず、質問または代替案にしてください。',
        '不足するフィールドは「新規フィールド」として label / 種類 / 理由を示し、既存で代用できる案があれば併記してください。変更計画は P1, P2 … の手順にし、依存関係と影響範囲、確認したいこと、解析できないことを分けて書いてください。',
      ].join('\n');
      return `${rules}\n\n## 実現したいこと\n${ctx.goal}\n\n## Context\n${toPlannerMarkdown(ctx)}\n`;
    }


    const mdEsc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

    /** 人間が読める Markdown（無料版の「AI 用ドキュメントをコピー」で使う形式） */
    function toMarkdown(ctx) {
      const out = [];
      const app = ctx.app || {};
      out.push(`# ${app.name ? `${app.name}（app ${app.id}）` : `app ${app.id}`} — AI Context`);
      out.push('');
      if (ctx.question) out.push(`**質問**: ${mdEsc(ctx.question)}`);
      const fo = ctx.focus || {};
      if (fo.resolution === 'resolved' || fo.resolution === 'explicit') {
        out.push(`**対象**: ${fo.target.type} \`${fo.target.id}\`${fo.target.label && fo.target.label !== fo.target.id ? `（${mdEsc(fo.target.label)}）` : ''}`);
      } else if (fo.resolution === 'ambiguous') {
        out.push(`**対象**: 複数候補のため未確定 — ${fo.candidates.map(c => `${c.type} \`${c.id}\`${c.label !== c.id ? `（${mdEsc(c.label)}）` : ''}`).join(' / ')}`);
      } else {
        out.push('**対象**: アプリ全体（質問から特定の対象は見つからなかった）');
      }
      out.push(`**階層**: ${(ctx.levels || []).join(' + ')}　**contextVersion**: ${ctx.contextVersion}　**生成**: ${ctx.generatedAt}`);
      out.push('');

      out.push('## L0 アプリ概要');
      out.push(`- フィールド数: ${app.fieldCount}（${Object.entries(app.fieldTypeCounts || {}).map(([k, v]) => `${k}×${v}`).join(', ')}）`);
      out.push(`- 一覧 ${app.views?.count ?? 0} / グラフ ${app.reports?.count ?? 0} / 通知 ${(app.notifications?.general ?? 0) + (app.notifications?.perRecord ?? 0) + (app.notifications?.reminder ?? 0)}（アプリ ${app.notifications?.general ?? 0}・レコード ${app.notifications?.perRecord ?? 0}・リマインダー ${app.notifications?.reminder ?? 0}）`);
      out.push(`- プロセス管理: ${app.process?.enabled ? `有効（ステータス ${app.process.stateCount}: ${app.process.states.join(' → ')} / アクション ${app.process.actionCount}）` : '無効'}`);
      out.push(`- アクセス権: アプリ ${app.acl?.app ?? 0} / レコード ${app.acl?.record ?? 0} / フィールド ${app.acl?.field ?? 0}　アプリアクション: ${app.actions?.count ?? 0}　プラグイン: ${app.plugins?.count ?? '不明'}`);
      out.push(`- JavaScript: PC ${app.customize?.desktop?.js?.length ?? 0} 件 / モバイル ${app.customize?.mobile?.js?.length ?? 0} 件（解析: ${app.javascript?.analyzed ? `済 ${app.javascript.scannedAt || ''}` : '未'}）`);
      if (app.dependencies) out.push(`- 依存関係: ${app.dependencies.edgeCount} 件（${Object.entries(app.dependencies.byRelation).map(([k, v]) => `${relLabel(k)} ${v}`).join(', ')}）`);
      out.push(`- 壊れた参照: ${app.brokenRefs?.total ?? 0} 件　アプリ間連携: ${app.appLinks?.count ?? 0} 件　他アプリからの参照: ${app.incoming?.scanned ? `走査済（参照元 ${app.incoming.referencingApps ?? 0} アプリ）` : '未走査'}`);
      if (app.calcChain && app.calcChain.calcFields) out.push(`- 計算式: ${app.calcChain.calcFields} フィールド（最大深さ ${app.calcChain.maxDepth}）`);
      if (app.fields && app.fields.length) {
        out.push('');
        out.push('| コード | ラベル | 型 | 備考 |');
        out.push('|---|---|---|---|');
        for (const f of app.fields) {
          const note = [f.required ? '必須' : '', f.unique ? '重複禁止' : '', f.subtable ? `テーブル ${f.subtable}` : ''].filter(Boolean).join('・');
          out.push(`| ${mdEsc(f.code)} | ${mdEsc(f.label)} | ${mdEsc(f.type)} | ${mdEsc(note)} |`);
        }
        if (app.fieldCount > app.fields.length) out.push(`| … | （${app.fieldCount - app.fields.length} 件省略） | | |`);
      }
      out.push('');

      if (ctx.facts && ctx.facts.length) {
        out.push(`## ${(ctx.levels || []).includes('L2') ? 'L1/L2' : 'L1'} 事実（根拠ID付き）`);
        out.push('');
        out.push('| ID | 種別 | 確度 | 事実 |');
        out.push('|---|---|---|---|');
        for (const f of ctx.facts) {
          const extra = f.kind === 'js-match' ? ` \`${mdEsc(f.snippet)}\`` : f.kind === 'code-excerpt' ? '' : (f.lines ? `（${Array.isArray(f.lines) ? f.lines.join(', ') + ' 行目' : ''}）` : '');
          out.push(`| ${f.id} | ${f.kind} | ${confJa(f.confidence)} | ${mdEsc(f.statement)}${extra} |`);
        }
        for (const f of ctx.facts.filter(x => x.kind === 'code-excerpt')) {
          out.push('');
          out.push(`**${f.id}** ${mdEsc(f.statement)}`);
          out.push('```');
          out.push(f.text);
          out.push('```');
        }
        out.push('');
      }

      out.push('## 解析範囲（coverage）');
      const cv = ctx.coverage || {};
      const yn = (b) => (b ? '含む' : '含まない');
      out.push(`- フィールド定義: ${yn(cv.fields)} / 依存関係: ${yn(cv.dependencies)} / JavaScript 本文: ${yn(cv.javascript)} / 他アプリからの参照: ${yn(cv.incoming)} / プラグイン設定: ${yn(cv.plugins)} / レコード実データ: ${yn(cv.recordData)} / 添付ファイル: ${yn(cv.attachments)}`);
      for (const n of (cv.notes || [])) out.push(`- ${mdEsc(n)}`);
      if (ctx.truncation?.applied) {
        out.push('');
        out.push('## 省略（truncation）');
        for (const s of ctx.truncation.sections) out.push(`- ${s.name}: 全 ${s.total} 件中 ${s.included} 件を収録`);
      }
      out.push('');
      out.push(`> 確度の語彙: 確実＝設定値から直接取得 / 可能性が高い＝条件式・計算式・JS のトークン一致 / 要確認＝文字列一致のみ。`);
      out.push(`> 根拠として引用できるのは「事実」の表にある根拠ID（E1…）だけ。L0 の概要は overview の根拠ID で引用する。`);
      out.push(`> 「含まない」とある項目は未解析であり、「存在しない」ことを意味しない。`);
      return out.join('\n');
    }

    /** ChatGPT / Claude などへそのまま貼れる Prompt（指示＋Markdown Context）。有料 Gateway の Prompt 本文とは別物 */
    function toPrompt(ctx, { instruction = null } = {}) {
      const rules = instruction || [
        'あなたは kintone アプリの設定・依存関係を読み解くアシスタントです。',
        '以下の Context は kintone App Toolkit が解析した事実です。回答は Context の事実だけを根拠にし、根拠ID（E1 など）を引用してください。',
        '確度が「可能性が高い」「要確認」の事実は推定として扱い、「確実」と区別して述べてください。',
        '解析範囲（coverage）で「含まない」とされた項目は未解析であり、存在しないと断定しないでください。',
        'Context に無い設定や業務ルールを推測で補わないでください。不明な点は不明と述べてください。',
      ].join('\n');
      const q = ctx.question ? `\n## 質問\n${ctx.question}\n` : '';
      return `${rules}\n${q}\n## Context\n${toMarkdown(ctx)}\n`;
    }

    /** サイズ計測（JSON byte / 文字数 / token 近似 / 件数） */
    function measure(ctx) {
      const json = typeof ctx === 'string' ? ctx : JSON.stringify({ ...ctx, size: null });
      return { ...measureText(json), facts: Array.isArray(ctx?.facts) ? ctx.facts.length : null };
    }

    return {
      CONTEXT_VERSION, LEVELS, DEFAULT_LIMITS, LEVEL_BUDGET_BYTES,
      build, resolveFocus, buildDictionary, buildCoverage, buildAppOverview,
      toJSON, toMarkdown, toPrompt, measure, measureText,
      redactSecretLikeText, edgeKey,
      // AI Change Planner（Phase 7）
      PLANNER_CONTEXT_VERSION, PLANNER_LIMITS, buildPlan, toPlannerMarkdown, toPlannerPrompt, longestSharedSubstring,
    };
  })();


  // ==========================================
  // 3.6b Change Plan Review & Simulation (KTPlanReview)  — Phase 8
  //   AI Change Planner が生成した Change Plan を、Toolkit 側の決定的ロジックで検証する層。
  //   現在の設定（Before）から Change Plan を仮適用した After モデルをメモリ上に作り、Diff・競合・重複・影響の再確認・
  //   安全分類・実行可否を返す。kintone API は呼ばない。純関数（DOM 非依存・Node でテスト可能）。
  //   AI の「問題ありません」より Toolkit の判定を優先する（安全判定の正本はここ）。
  // ==========================================
  const KTPlanReview = (() => {
    const REVIEW_VERSION = '1';
    const STATUS = Object.freeze({ VALID: 'VALID', WARNING: 'WARNING', NEEDS_CONFIRMATION: 'NEEDS_CONFIRMATION', INVALID: 'INVALID', BLOCKED_BY_DEPENDENCY: 'BLOCKED_BY_DEPENDENCY' });
    const SAFETY = Object.freeze({ SAFE: 'SAFE', REVIEW_REQUIRED: 'REVIEW_REQUIRED', BLOCKED: 'BLOCKED', PLAN_ONLY: 'PLAN_ONLY' });
    const CHANGE = Object.freeze({ ADD: 'ADD', UPDATE: 'UPDATE', REUSE: 'REUSE', REMOVE: 'REMOVE', NO_CHANGE: 'NO_CHANGE', INVALID: 'INVALID' });
    const STATUS_RANK = { VALID: 0, WARNING: 1, NEEDS_CONFIRMATION: 2, INVALID: 3, BLOCKED_BY_DEPENDENCY: 3 };
    /**
     * Action Catalog ごとの能力表（Executor の SoT。KTPlanExecutor.ACTION_CAPABILITIES が previewExecute / verify / rollbackStrategy / productionDeploy を重ねる）。
     *   simulate: After モデルへ仮適用できるか / validate: 検証器があるか / defaultSafety: 既定の安全分類 / execution: 将来の実行対応
     */
    const ACTION_CAPABILITIES = Object.freeze({
      ADD_FIELD: { simulate: true, validate: true, defaultSafety: 'SAFE', execution: 'FUTURE', changeType: 'ADD', kind: 'FIELD' },
      UPDATE_FIELD: { simulate: true, validate: true, defaultSafety: 'REVIEW_REQUIRED', execution: 'FUTURE', changeType: 'UPDATE', kind: 'FIELD' },
      REUSE_FIELD: { simulate: true, validate: true, defaultSafety: 'SAFE', execution: 'NONE', changeType: 'REUSE', kind: 'FIELD' },
      ADD_PROCESS_STATUS: { simulate: true, validate: true, defaultSafety: 'REVIEW_REQUIRED', execution: 'FUTURE', changeType: 'ADD', kind: 'PROCESS_STATUS' },
      UPDATE_PROCESS: { simulate: true, validate: true, defaultSafety: 'REVIEW_REQUIRED', execution: 'FUTURE', changeType: 'UPDATE', kind: 'PROCESS' },
      ADD_PROCESS_ACTION: { simulate: true, validate: true, defaultSafety: 'REVIEW_REQUIRED', execution: 'FUTURE', changeType: 'ADD', kind: 'PROCESS_ACTION' },
      ADD_NOTIFICATION: { simulate: true, validate: true, defaultSafety: 'REVIEW_REQUIRED', execution: 'FUTURE', changeType: 'ADD', kind: 'NOTIFICATION' },
      UPDATE_NOTIFICATION: { simulate: true, validate: true, defaultSafety: 'REVIEW_REQUIRED', execution: 'FUTURE', changeType: 'UPDATE', kind: 'NOTIFICATION' },
      ADD_REMINDER: { simulate: true, validate: true, defaultSafety: 'SAFE', execution: 'FUTURE', changeType: 'ADD', kind: 'REMINDER' },
      ADD_VIEW: { simulate: true, validate: true, defaultSafety: 'SAFE', execution: 'FUTURE', changeType: 'ADD', kind: 'VIEW' },
      UPDATE_VIEW: { simulate: true, validate: true, defaultSafety: 'REVIEW_REQUIRED', execution: 'FUTURE', changeType: 'UPDATE', kind: 'VIEW' },
      UPDATE_RECORD_ACL: { simulate: false, validate: true, defaultSafety: 'REVIEW_REQUIRED', execution: 'FUTURE', changeType: 'UPDATE', kind: 'RECORD_ACL' },
      UPDATE_FIELD_ACL: { simulate: false, validate: true, defaultSafety: 'REVIEW_REQUIRED', execution: 'FUTURE', changeType: 'UPDATE', kind: 'FIELD_ACL' },
      ADD_APP_ACTION: { simulate: true, validate: true, defaultSafety: 'REVIEW_REQUIRED', execution: 'FUTURE', changeType: 'ADD', kind: 'APP_ACTION' },
      UPDATE_APP_ACTION: { simulate: false, validate: true, defaultSafety: 'REVIEW_REQUIRED', execution: 'FUTURE', changeType: 'UPDATE', kind: 'APP_ACTION' },
      ADD_LOOKUP: { simulate: true, validate: true, defaultSafety: 'REVIEW_REQUIRED', execution: 'FUTURE', changeType: 'ADD', kind: 'LOOKUP' },
      UPDATE_LOOKUP: { simulate: true, validate: true, defaultSafety: 'REVIEW_REQUIRED', execution: 'FUTURE', changeType: 'UPDATE', kind: 'LOOKUP' },
      REQUIRE_CONFIRMATION: { simulate: false, validate: false, defaultSafety: 'PLAN_ONLY', execution: 'NONE', changeType: 'NO_CHANGE', kind: 'NONE' },
      CUSTOMIZATION_REQUIRED: { simulate: false, validate: false, defaultSafety: 'PLAN_ONLY', execution: 'NONE', changeType: 'NO_CHANGE', kind: 'JS' },
    });
    /** 高リスクの変更（安全分類を REVIEW_REQUIRED に上げ、status は NEEDS_CONFIRMATION） */
    const HIGH_RISK = ['TYPE_CHANGE', 'OPTIONS_REMOVED', 'EXISTING_PATH_RESTRICTED', 'ACL_CHANGE', 'LOOKUP_MAPPING_OVERWRITE', 'NOTIFICATION_EVENTS_REMOVED'];
    const KINTONE_FIELD_TYPES = ['SINGLE_LINE_TEXT', 'MULTI_LINE_TEXT', 'RICH_TEXT', 'NUMBER', 'CALC', 'CHECK_BOX', 'RADIO_BUTTON', 'DROP_DOWN', 'MULTI_SELECT', 'DATE', 'TIME', 'DATETIME', 'FILE', 'LINK', 'USER_SELECT', 'ORGANIZATION_SELECT', 'GROUP_SELECT', 'LOOKUP', 'REFERENCE_TABLE', 'SUBTABLE', 'GROUP', 'SPACER', 'LABEL', 'HR'];
    const OPTION_TYPES = ['CHECK_BOX', 'RADIO_BUTTON', 'DROP_DOWN', 'MULTI_SELECT'];
    const ENTITY_TYPES = ['USER', 'GROUP', 'ORGANIZATION', 'FIELD_ENTITY', 'CREATOR', 'CUSTOM_FIELD'];
    const NOTIFY_EVENTS = ['recordAdded', 'recordEdited', 'commentAdded', 'statusChanged', 'fileImported'];
    const EVENT_SYNONYMS = [['recordAdded', ['レコード追加', '追加', '登録']], ['recordEdited', ['レコード編集', '編集', '更新', '変更']], ['commentAdded', ['コメント']], ['statusChanged', ['ステータス変更', 'ステータス']], ['fileImported', ['ファイル', 'インポート']]];
    const RESERVED_CODES = ['レコード番号', '作成者', '作成日時', '更新者', '更新日時', 'ステータス', '作業者', 'カテゴリー'];
    const CODE_RE = /^[A-Za-z0-9_＿ぁ-んァ-ヶー一-龠々・￥＄％＄]+$/u;
    const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const norm = (s) => String(s ?? '').replace(/\s+/g, '').replace(/[“”"'「」『』（）()]/g, '').toLowerCase();
    const normCond = (c) => String(c ?? '').replace(/\s+/g, '').replace(/[“”]/g, '"');

    // ================= Before Model =================
    /** prefetchAppData の DATA → 正規化したアプリモデル（深いコピー。元の DATA は変更しない） */
    function buildBeforeModel(data) {
      const d = data || {};
      const fieldsN = KTDeps.normalizeFields(d.fields || {});
      const fields = {};
      for (const f of fieldsN) {
        const raw = f.raw || {};
        const opts = raw.options && typeof raw.options === 'object' ? Object.keys(raw.options).sort((a, b) => (Number(raw.options[a]?.index ?? 0) - Number(raw.options[b]?.index ?? 0)) || cmp(a, b)) : null;
        fields[f.code] = {
          code: f.code, label: f.label, type: f.type === 'LOOKUP' ? 'LOOKUP' : f.rawType, baseType: f.rawType,
          required: !!f.required, unique: !!f.unique, subtable: f.parent || null,
          ...(opts ? { options: opts } : {}),
          ...(raw.expression ? { expression: raw.expression } : {}),
          ...(raw.lookup ? { lookup: { app: String(raw.lookup.relatedApp?.app ?? ''), keyField: raw.lookup.relatedKeyField ?? null, mappings: (raw.lookup.fieldMappings || []).map(m => ({ from: m.relatedField, to: m.field })) } } : {}),
          origin: 'existing',
        };
      }
      const st = d.status || {};
      const states = Object.values(st.states || {}).filter(Boolean).sort((a, b) => (Number(a.index ?? 0) - Number(b.index ?? 0)) || cmp(String(a.name), String(b.name)))
        .map((s, i) => ({ name: s.name, index: i, assigneeType: s.assignee?.type ?? null, assignees: entityList(s.assignee?.entities), origin: 'existing' }));
      const actions = (st.enable ? (st.actions || []) : []).map(a => ({ name: a.name, from: a.from, to: a.to, filterCond: a.filterCond || '', type: a.type ?? null, executableUsers: entityList(a.executableUser?.entities), origin: 'existing' }));
      const general = (d.generalNotify?.notifications || []).map((n, i) => ({ id: `general#${i + 1}`, scope: 'general', title: '', target: { type: n.entity?.type, code: n.entity?.code ?? null }, targets: [{ type: n.entity?.type, code: n.entity?.code ?? null }], events: NOTIFY_EVENTS.filter(k => n[k]), filterCond: '', origin: 'existing' }));
      const perRecord = (d.perRecordNotify?.notifications || []).map((n, i) => ({ id: `perRecord#${i + 1}`, scope: 'perRecord', title: n.title || '', filterCond: n.filterCond || '', targets: entityList(n.targets), events: [], origin: 'existing' }));
      const reminders = (d.reminderNotify?.notifications || []).map((n, i) => ({ id: `reminder#${i + 1}`, title: n.title || '', timing: { code: n.timing?.code ?? null, daysLater: n.timing?.daysLater != null ? String(n.timing.daysLater) : null, time: n.timing?.time ?? null }, filterCond: n.filterCond || '', targets: entityList(n.targets), origin: 'existing' }));
      const views = Object.values(d.views?.views || {}).filter(Boolean).sort((a, b) => (Number(a.index ?? 0) - Number(b.index ?? 0)) || cmp(String(a.name), String(b.name)))
        .map(v => ({ name: v.name, type: v.type ?? 'LIST', fields: Array.isArray(v.fields) ? [...v.fields] : [], filterCond: v.filterCond || '', sort: v.sort || '', origin: 'existing' }));
      const reports = Object.values(d.reports?.reports || {}).filter(Boolean).map(r => ({ name: r.name, origin: 'existing' }));
      const recordAcl = (d.recordAcl?.rights || []).map((r, i) => ({ id: `record#${i + 1}`, filterCond: r.filterCond || '', entities: (r.entities || []).map(e => ({ type: e.entity?.type, code: e.entity?.code ?? null, viewable: !!e.viewable, editable: !!e.editable, deletable: !!e.deletable })), origin: 'existing' }));
      const fieldAcl = (d.fieldAcl?.rights || []).map(r => ({ code: r.code, entities: (r.entities || []).map(e => ({ type: e.entity?.type, code: e.entity?.code ?? null, accessibility: e.accessibility })), origin: 'existing' }));
      const appActions = Object.values(d.actions?.actions || {}).filter(Boolean).sort((a, b) => (Number(a.index ?? 0) - Number(b.index ?? 0)) || cmp(String(a.name), String(b.name)))
        .map(a => ({ name: a.name, destApp: String(a.destApp?.app ?? ''), mappings: (a.mappings || []).map(m => ({ srcType: m.srcType, srcField: m.srcField ?? null, destField: m.destField })), origin: 'existing' }));
      // アプリ設定の revision（各 GET が同じ値を返す。JS API のフィールド取得には無いので、REST の応答から最初に見つかったもの）
      const revisionOf = [d.views, d.status, d.generalNotify, d.perRecordNotify, d.reminderNotify, d.actions, d.appAcl, d.recordAcl, d.fieldAcl].map(x => x?.revision).find(r => r != null && r !== '');
      return {
        appId: String(d.appId ?? ''), fields,
        process: { enabled: !!st.enable, states, actions },
        notifications: { general, perRecord }, reminders, views, reports,
        acl: { record: recordAcl, field: fieldAcl }, appActions,
        revision: revisionOf != null ? String(revisionOf) : null,
      };
    }
    function entityList(list) { return (Array.isArray(list) ? list : []).map(x => x?.entity ?? x).filter(Boolean).map(en => ({ type: en.type, code: en.code ?? null })); }
    const entityText = (en) => (en ? `${en.type}${en.code != null && en.code !== '' ? `:${en.code}` : ''}` : '');
    const sameEntity = (a, b) => a && b && a.type === b.type && String(a.code ?? '') === String(b.code ?? '');

    // ================= step の仕様（spec）の正規化 =================
    //   Gateway の step.spec（構造化）を優先し、無ければ proposal.details（key / value）を同義語で読む
    const DETAIL_KEYS = {
      name: ['name', 'title', 'ステータス名', 'アクション名', '名前', '名称', '通知名', '一覧名', 'タイトル', 'label', 'ラベル', 'フィールド名'],
      from: ['from', '遷移元'], to: ['to', '遷移先'],
      filterCond: ['filtercond', 'condition', '条件', '条件式', '絞り込み', '通知条件', 'filter', 'フィルター'],
      assignees: ['assignee', 'assignees', '作業者'],
      targets: ['target', 'targets', '通知先', '通知対象', '対象者', 'recipients', '通知対象者'],
      events: ['events', 'event', 'イベント', '通知イベント', 'trigger', 'タイミング', '通知タイミング'],
      timingField: ['timingfield', '基準日', '基準フィールド', '基準日フィールド', '日付フィールド', 'basedate', 'basefield'],
      daysLater: ['dayslater', '日数', 'days', 'offset', '何日前', '日前'],
      time: ['time', '時刻', '通知時刻'],
      fields: ['fields', 'フィールド', '表示フィールド', '表示項目', '取得先', 'copyto', 'destination', 'columns'],
      sort: ['sort', 'ソート', '並び順'],
      sourceApp: ['sourceapp', '参照元アプリ', '参照元アプリid', 'app', 'relatedapp', '参照アプリ', 'コピー元アプリ', 'マスタ'],
      keyField: ['keyfield', '参照元フィールド', 'relatedkeyfield', 'key', 'キー', '参照キー'],
      mappings: ['mappings', 'mapping', '取得項目', 'lookupfields', 'fieldmappings', 'コピー', 'コピー項目'],
      fieldType: ['type', 'fieldtype', 'フィールドタイプ', '種類', '型'],
      required: ['required', '必須'],
      options: ['options', '選択肢', 'choices'],
      destApp: ['destapp', '作成先アプリ', '作成先', '遷移先アプリ'],
      accessibility: ['accessibility', '権限', 'アクセス権'],
      entities: ['entities', '対象', 'ユーザー', 'グループ', '組織'],
    };
    const keyOf = (k) => { const n = norm(k); for (const [canon, syn] of Object.entries(DETAIL_KEYS)) if (syn.some(s => n === norm(s) || n.startsWith(norm(s)))) return canon; return null; };
    const splitList = (v) => String(v ?? '').split(/[、,，\/／;；\n]+/).map(s => s.trim()).filter(Boolean);
    /** "担当者(owner)" / "FIELD_ENTITY:owner" / "NEW_FIELD_1（部長承認者）" / "USER:user1" → entity 候補 */
    function parseEntity(text, model, proposedMap) {
      const t = String(text ?? '').trim();
      if (!t) return null;
      const m1 = t.match(/^(USER|GROUP|ORGANIZATION|FIELD_ENTITY|CREATOR|CUSTOM_FIELD)\s*[:：]\s*(.*)$/i);
      if (m1) return { type: m1[1].toUpperCase(), code: m1[2].trim() || null };
      const temp = t.match(/NEW_FIELD_\d+/);
      if (temp) return { type: 'FIELD_ENTITY', code: temp[0], temporaryId: temp[0] };
      const paren = t.match(/[（(]([^）)]+)[）)]/);
      const cands = [t, paren ? paren[1] : null, t.replace(/[（(][^）)]*[）)]/g, '').trim()].filter(Boolean);
      for (const c of cands) {
        if (model.fields[c]) return { type: 'FIELD_ENTITY', code: c };
        const byLabel = Object.values(model.fields).find(f => f.label === c);
        if (byLabel) return { type: 'FIELD_ENTITY', code: byLabel.code };
      }
      if (/^(作成者|creator)$/i.test(t)) return { type: 'CREATOR', code: null };
      // 既存設定に現れる USER / GROUP / ORGANIZATION のコードなら種別を補完する
      const known = knownEntities(model).find(en => String(en.code) === t);
      if (known) return { type: known.type, code: known.code };
      return { type: 'UNKNOWN', code: t };
    }
    function knownEntities(model) {
      const out = [];
      const push = (list) => { for (const en of list || []) if (en && en.type && en.type !== 'FIELD_ENTITY' && en.code && !out.some(x => sameEntity(x, en))) out.push({ type: en.type, code: en.code }); };
      for (const s of model.process.states) push(s.assignees);
      for (const a of model.process.actions) push(a.executableUsers);
      for (const n of model.notifications.general) push(n.targets);
      for (const n of model.notifications.perRecord) push(n.targets);
      for (const r of model.reminders) push(r.targets);
      for (const r of model.acl.record) push(r.entities);
      for (const r of model.acl.field) push(r.entities);
      return out;
    }
    function normalizeSpec(step, model, proposedMap) {
      const spec = {};
      const s = step.spec && typeof step.spec === 'object' ? step.spec : null;
      const put = (k, v) => { if (v == null) return; if (Array.isArray(v) ? v.length : String(v).trim() !== '') spec[k] = v; };
      if (s) {
        for (const k of Object.keys(DETAIL_KEYS)) {
          const v = s[k];
          if (v == null) continue;
          if (k === 'mappings' && Array.isArray(v)) put(k, v.filter(m => m && (m.from || m.to)).map(m => ({ from: String(m.from ?? '').trim(), to: String(m.to ?? '').trim() })));
          else if (['assignees', 'targets', 'events', 'fields', 'options', 'entities'].includes(k)) put(k, Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : splitList(v));
          else if (k === 'required') { if (typeof v === 'boolean') spec.required = v; else if (/^(true|yes|必須|はい)$/i.test(String(v))) spec.required = true; else if (/^(false|no|任意|いいえ)$/i.test(String(v))) spec.required = false; }
          else put(k, String(v).trim());
        }
      }
      for (const d of (step.proposal?.details || [])) {
        const k = keyOf(d.key);
        if (!k || spec[k] != null) continue;
        const v = String(d.value ?? '').trim();
        if (!v) continue;
        if (k === 'mappings') spec.mappings = splitList(v).map(x => { const m = x.match(/^(.+?)\s*(?:→|->|=>|:|：)\s*(.+)$/); return m ? { from: m[1].trim(), to: m[2].trim() } : { from: x, to: '' }; });
        else if (['assignees', 'targets', 'events', 'fields', 'options', 'entities'].includes(k)) spec[k] = splitList(v);
        else if (k === 'required') spec.required = /^(true|yes|必須|はい)$/i.test(v) ? true : /^(false|no|任意|いいえ)$/i.test(v) ? false : undefined;
        else spec[k] = v;
      }
      if (spec.events) spec.events = spec.events.map(e => { const n = norm(e); const exact = NOTIFY_EVENTS.find(x => norm(x) === n); if (exact) return exact; const hit = EVENT_SYNONYMS.find(([, syn]) => syn.some(s => n.includes(norm(s)))); return hit ? hit[0] : e; });
      if (spec.filterCond) spec.filterCond = String(spec.filterCond).replace(/^(条件|condition)[:：]\s*/i, '');
      // name の既定: targetRef（ADD_* の新規名）
      if (!spec.name && step.targetRef && step.targetKind !== 'PROPOSED_FIELD' && /^ADD_/.test(step.actionType)) spec.name = step.targetRef;
      return spec;
    }

    // ================= 条件式の簡易比較 =================
    /** "amount >= \"1000000\"" のような単純な比較式を解析（field / op / value）。解析できなければ null */
    function parseCond(cond) {
      const c = String(cond ?? '').trim();
      if (!c) return null;
      const m = c.match(/^([^\s<>=!]+)\s*(>=|<=|!=|=|>|<)\s*"?([^"]*)"?$/);
      if (!m) return null;
      const num = Number(m[3].replace(/,/g, ''));
      return { field: m[1], op: m[2], value: m[3], num: Number.isFinite(num) ? num : null };
    }
    /** 2 つの単純条件が同時に成り立ち得るか（重なり）。解析できない場合は null（不明） */
    function condsOverlap(a, b) {
      const pa = parseCond(a), pb = parseCond(b);
      if (!a && !b) return true;
      if (!a || !b) return true;   // 片方が無条件なら重なる
      if (!pa || !pb) return null;
      if (pa.field !== pb.field) return true;
      if (pa.num == null || pb.num == null) return normCond(a) === normCond(b) ? true : null;
      const range = (p) => ({ lo: p.op === '>' ? [p.num, false] : p.op === '>=' ? [p.num, true] : p.op === '=' ? [p.num, true] : [-Infinity, true], hi: p.op === '<' ? [p.num, false] : p.op === '<=' ? [p.num, true] : p.op === '=' ? [p.num, true] : [Infinity, true] });
      if (pa.op === '!=' || pb.op === '!=') return true;
      const ra = range(pa), rb = range(pb);
      const lo = ra.lo[0] > rb.lo[0] ? ra.lo : rb.lo, hi = ra.hi[0] < rb.hi[0] ? ra.hi : rb.hi;
      if (lo[0] < hi[0]) return true;
      if (lo[0] === hi[0]) return lo[1] && hi[1];
      return false;
    }
    /** 新条件 a にすると、旧条件 b で通っていた値が通らなくなるか（既存経路の制限）。解析できない場合は null */
    function condNarrower(a, b) {
      if (!b) return !!a;   // 無条件 → 条件あり は制限
      if (!a) return false; // 条件あり → 無条件 は緩和
      const pa = parseCond(a), pb = parseCond(b);
      if (!pa || !pb || pa.field !== pb.field || pa.num == null || pb.num == null) return normCond(a) === normCond(b) ? false : null;
      const ok = (p, x) => p.op === '>' ? x > p.num : p.op === '>=' ? x >= p.num : p.op === '<' ? x < p.num : p.op === '<=' ? x <= p.num : p.op === '=' ? x === p.num : x !== p.num;
      const samples = [pa.num - 1, pa.num, pa.num + 1, pb.num - 1, pb.num, pb.num + 1, -1e12, 1e12];
      return samples.some(x => ok(pb, x) && !ok(pa, x));
    }
    /** kintone の条件式（クエリ）で使える関数。これ以外の「名前(」は kintone では評価できない（AI が別システムの関数を書きがち） */
    const KINTONE_COND_FUNCTIONS = ['LOGINUSER', 'PRIMARY_ORGANIZATION', 'NOW', 'TODAY', 'YESTERDAY', 'TOMORROW', 'FROM_TODAY', 'THIS_WEEK', 'LAST_WEEK', 'NEXT_WEEK', 'THIS_MONTH', 'LAST_MONTH', 'NEXT_MONTH', 'THIS_YEAR', 'LAST_YEAR', 'NEXT_YEAR'];
    /** 条件式に含まれる kintone 外の関数名（NOT / AND / OR / IN / LIKE は演算子なので除く） */
    function condUnknownFunctions(cond) {
      const out = [];
      const c = String(cond ?? '').replace(/"[^"]*"/g, '""');
      const re = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      let m;
      while ((m = re.exec(c))) { const name = m[1].toUpperCase(); if (['NOT', 'AND', 'OR', 'IN', 'LIKE'].includes(name) || KINTONE_COND_FUNCTIONS.includes(name) || out.includes(m[1])) continue; out.push(m[1]); }
      return out;
    }
    /** 条件式が参照するフィールドコード（単純な字句抽出） */
    function condFields(cond, model) {
      const out = [];
      const c = String(cond ?? '');
      for (const code of Object.keys(model.fields)) if (c.includes(code) && !out.includes(code)) out.push(code);
      return out;
    }

    // ================= 類似判定 =================
    const similarLabel = (a, b) => { const x = norm(a), y = norm(b); if (!x || !y) return false; if (x === y) return true; return (x.includes(y) || y.includes(x)) || KTContext.longestSharedSubstring(x, y) >= Math.max(2, Math.min(x.length, y.length) - 1); };
    const sameTargets = (a, b) => a.length === b.length && a.every(x => b.some(y => sameEntity(x, y)));
    const overlapTargets = (a, b) => a.some(x => b.some(y => sameEntity(x, y)));

    // ================= review =================
    /**
     * @param {object} p plan（Gateway が正規化した Change Plan）/ data / deps / scan / incoming
     * @returns {object} review
     */
    function review({ plan, data = null, deps = null, scan = null, incoming = null } = {}) {
      const warnings = [];      // plan 全体の warning { code, severity, stepIds[], message, detail? }
      const conflicts = [];     // 競合・重複 { code, severity, stepIds[], message, existing?, proposed? }
      const before = buildBeforeModel(data);
      const model = clone(before);   // After（仮適用で変化させる）
      const steps = Array.isArray(plan?.steps) ? plan.steps : [];
      const proposedFields = Array.isArray(plan?.proposedFields) ? plan.proposedFields : [];
      const proposedMap = new Map(proposedFields.map(p => [p.temporaryId, p]));
      const resolvedCodes = new Map();   // temporaryId → 仮適用後の実コード
      const results = new Map();         // stepId → step review
      const byId = new Map(steps.map(s => [s.id, s]));

      // ---- 1. dependsOn 順（トポロジカル）。循環は検出して該当 step を INVALID ----
      const order = [];
      const state = new Map();
      const cyc = new Set();
      const visit = (id, stack) => {
        if (state.get(id) === 'done') return;
        if (state.get(id) === 'visiting') { cyc.add(id); stack.forEach(x => cyc.add(x)); return; }
        state.set(id, 'visiting'); stack.push(id);
        for (const dep of (byId.get(id)?.dependsOn || [])) if (byId.has(dep)) visit(dep, stack);
        stack.pop(); state.set(id, 'done'); order.push(id);
      };
      for (const s of steps) visit(s.id, []);
      if (cyc.size) warnings.push({ code: 'CIRCULAR_DEPENDENCY', severity: 'high', stepIds: [...cyc], message: `依存関係が循環しています（${[...cyc].join(', ')}）` });

      // ---- 2. step ごとに検証 → 仮適用 ----
      for (const id of order) {
        const step = byId.get(id);
        const r = reviewStep(step, { model, before, proposedMap, resolvedCodes, deps, scan, cyc, results, steps });
        results.set(id, r);
      }
      // ---- 3. plan 内部の競合（複数 step の組み合わせ）----
      planLevelConflicts(steps, results, model, conflicts);
      // ---- 4. 影響の再確認（Planner の impact と Toolkit の impactOf を照合）----
      const impactCheck = recheckImpact(plan, results, deps, before);
      warnings.push(...impactCheck.warnings);
      // ---- 5. 新規フィールドの必要性（既存の類似フィールド）----
      for (const p of proposedFields) {
        const similar = Object.values(before.fields).filter(f => f.type === p.type || (p.type === 'LOOKUP' && f.type === 'LOOKUP')).filter(f => similarLabel(f.label, p.label) || (p.suggestedCode && similarLabel(f.code, p.suggestedCode)));
        for (const f of similar) {
          const stepIds = steps.filter(s => s.targetKind === 'PROPOSED_FIELD' && s.targetRef === p.temporaryId).map(s => s.id);
          warnings.push({ code: 'POSSIBLE_EXISTING_REUSE', severity: 'medium', stepIds, message: `新規フィールド「${p.label}」（${p.type}）は、既存の「${f.label}」（${f.code}・${f.type}）を再利用できる可能性があります`, detail: { temporaryId: p.temporaryId, existing: f.code } });
          for (const sid of stepIds) { const rr = results.get(sid); if (rr && rr.status === STATUS.VALID) { rr.status = STATUS.WARNING; rr.issues.push({ code: 'POSSIBLE_EXISTING_REUSE', severity: 'medium', message: `既存の「${f.label}」（${f.code}）で代用できる可能性` }); } }
        }
      }
      // ---- 6. 依存先が INVALID / BLOCKED の step は BLOCKED_BY_DEPENDENCY ----
      for (const id of order) {
        const r = results.get(id);
        const blockedBy = (byId.get(id)?.dependsOn || []).filter(dep => { const d = results.get(dep); return !d || d.status === STATUS.INVALID || d.status === STATUS.BLOCKED_BY_DEPENDENCY; });
        if (blockedBy.length && r.status !== STATUS.INVALID) { r.status = STATUS.BLOCKED_BY_DEPENDENCY; r.safety = SAFETY.BLOCKED; r.blockedBy = blockedBy; r.issues.push({ code: 'BLOCKED_BY_DEPENDENCY', severity: 'high', message: `依存する ${blockedBy.join(', ')} が無効のため実行できません` }); }
      }
      // 競合に関わる step の status を反映
      for (const c of conflicts) for (const sid of c.stepIds) { const r = results.get(sid); if (!r) continue; const want = c.severity === 'high' ? STATUS.NEEDS_CONFIRMATION : STATUS.WARNING; if (STATUS_RANK[want] > STATUS_RANK[r.status]) r.status = want; if (!r.issues.some(i => i.code === c.code && i.message === c.message)) r.issues.push({ code: c.code, severity: c.severity, message: c.message }); if (r.safety === SAFETY.SAFE) r.safety = SAFETY.REVIEW_REQUIRED; }
      for (const w of impactCheck.warnings) for (const sid of w.stepIds) { const r = results.get(sid); if (!r) continue; if (r.status === STATUS.VALID) r.status = STATUS.WARNING; if (!r.issues.some(i => i.code === w.code && i.message === w.message)) r.issues.push({ code: w.code, severity: w.severity, message: w.message }); }

      // ---- 7. 集約 ----
      const stepReviews = steps.map(s => results.get(s.id)).filter(Boolean);
      const safeSteps = stepReviews.filter(r => r.safety === SAFETY.SAFE).map(r => r.stepId);
      const reviewSteps = stepReviews.filter(r => r.safety === SAFETY.REVIEW_REQUIRED).map(r => r.stepId);
      const blockedSteps = stepReviews.filter(r => r.safety === SAFETY.BLOCKED).map(r => r.stepId);
      const planOnlySteps = stepReviews.filter(r => r.safety === SAFETY.PLAN_ONLY).map(r => r.stepId);
      const counts = {
        additions: stepReviews.filter(r => r.diff.changeType === CHANGE.ADD).length,
        updates: stepReviews.filter(r => r.diff.changeType === CHANGE.UPDATE).length,
        reuse: stepReviews.filter(r => r.diff.changeType === CHANGE.REUSE).length,
        highRisk: stepReviews.filter(r => r.issues.some(i => HIGH_RISK.includes(i.code))).length,
        conflicts: conflicts.length,
        confirmations: stepReviews.filter(r => r.status === STATUS.NEEDS_CONFIRMATION).length + (plan?.questions || []).length,
        warnings: stepReviews.filter(r => r.status === STATUS.WARNING).length,
        invalid: stepReviews.filter(r => r.status === STATUS.INVALID || r.status === STATUS.BLOCKED_BY_DEPENDENCY).length,
        planOnly: planOnlySteps.length,
      };
      const processChanged = stepReviews.some(r => ['PROCESS_STATUS', 'PROCESS_ACTION', 'PROCESS'].includes(r.diff.target.kind) && r.diff.changeType !== CHANGE.INVALID && r.diff.changeType !== CHANGE.NO_CHANGE);
      const simulation = {
        before, after: model, order: [...order],
        process: { before: processSummary(before.process), after: processSummary(model.process), changed: processChanged, mermaid: { before: processMermaid(before.process), after: processMermaid(model.process, before.process) } },
      };
      return {
        reviewVersion: REVIEW_VERSION, planVersion: plan?.planVersion ?? '1', requestId: plan?.requestId ?? null, reviewedAt: null,
        summary: { counts, status: counts.invalid ? 'BLOCKED' : (reviewSteps.length || counts.confirmations || counts.conflicts) ? 'REVIEW_REQUIRED' : 'SAFE', stepCount: stepReviews.length },
        steps: stepReviews,
        conflicts, warnings,
        diff: { steps: stepReviews.map(r => r.diff), before: { fieldCount: Object.keys(before.fields).length, states: before.process.states.length, actions: before.process.actions.length, notifications: before.notifications.general.length + before.notifications.perRecord.length, reminders: before.reminders.length, views: before.views.length }, after: { fieldCount: Object.keys(model.fields).length, states: model.process.states.length, actions: model.process.actions.length, notifications: model.notifications.general.length + model.notifications.perRecord.length, reminders: model.reminders.length, views: model.views.length } },
        simulation,
        executionReadiness: { status: counts.invalid ? 'BLOCKED' : reviewSteps.length || planOnlySteps.length ? 'REVIEW_REQUIRED' : stepReviews.length ? 'SAFE' : 'EMPTY', safeSteps, reviewSteps, blockedSteps, planOnlySteps, approvedSteps: [] },
        impactCheck: impactCheck.items,
        reviewCoverage: {
          fields: true, process: true, notifications: true, reminders: true, lookup: true, views: true, appActions: 'partial',
          acl: 'partial', javascript: !!(deps && Array.isArray(deps.edges) && deps.meta?.scannerMergedAt) || !!scan, incoming: !!(incoming || deps?.meta?.incomingScannedAt),
          notes: ['ACL は対象の実在・既存ルールとの重複だけを確認し、仮適用はしない', 'アプリアクションは名前・作成先・マッピングのフィールド実在だけを確認', 'JavaScript は既存の参照（impactOf）を再確認するのみで、コードの変更は評価しない', '条件式は単純な比較（field op value）だけを解析し、それ以外は「重なる可能性あり」として扱う'],
        },
      };
    }

    // ================= step ごとの検証・仮適用 =================
    function reviewStep(step, ctx) {
      const { model, before, proposedMap, resolvedCodes, cyc, results } = ctx;
      const cap = ACTION_CAPABILITIES[step.actionType] || null;
      const issues = [];
      const issue = (code, severity, message, extra = {}) => issues.push({ code, severity, message, ...extra });
      const r = { stepId: step.id, actionType: step.actionType, status: STATUS.VALID, safety: cap ? cap.defaultSafety : SAFETY.PLAN_ONLY, issues, blockedBy: [],
        diff: { stepId: step.id, changeType: cap ? cap.changeType : CHANGE.NO_CHANGE, target: { kind: step.targetKind || 'NONE', id: step.targetRef ?? null }, before: null, after: null, human: [] },
        simulated: false, spec: null };
      const invalid = (code, message) => { issue(code, 'high', message); r.status = STATUS.INVALID; r.safety = SAFETY.BLOCKED; r.diff.changeType = CHANGE.INVALID; };
      // Gateway 側の判定を引き継ぐ（AI の文章より Toolkit を優先するが、Gateway の検証は決定的なので尊重する）
      if (step.validation?.status === 'invalid') invalid('GATEWAY_INVALID', (step.validation.issues || []).join('；') || 'Gateway の検証で無効と判定されています');
      if (cyc.has(step.id)) invalid('CIRCULAR_DEPENDENCY', '依存関係が循環しています');
      if (!cap) { invalid('UNSUPPORTED_ACTION_TYPE', `語彙外の actionType「${String(step.actionType)}」`); return r; }
      if (!cap.simulate || !cap.validate) {
        if (cap.validate) validateOnly(step, r, ctx);
        if (!cap.simulate) { r.simulated = false; if (r.status === STATUS.VALID && cap.defaultSafety === SAFETY.PLAN_ONLY) r.diff.human.push('（計画のみ。Toolkit の仮適用には未対応）'); if (!cap.simulate && cap.validate && r.status !== STATUS.INVALID) { r.safety = r.safety === SAFETY.BLOCKED ? r.safety : SAFETY.REVIEW_REQUIRED; } }
        if (!cap.validate) { r.safety = SAFETY.PLAN_ONLY; r.diff.changeType = CHANGE.NO_CHANGE; r.diff.human.push('（計画のみ。自動検証・仮適用の対象外）'); }
        if (r.status === STATUS.INVALID) return r;
        if (!cap.simulate) { r.diff.human.unshift(`${step.title || step.actionType}（仮適用なし）`); return r; }
      }
      if (r.status === STATUS.INVALID) return r;
      const spec = normalizeSpec(step, model, proposedMap);
      r.spec = spec;
      const h = (line) => r.diff.human.push(line);
      const resolveField = (ref) => {
        const t = String(ref ?? '').trim();
        if (!t) return null;
        const temp = t.match(/NEW_FIELD_\d+/);
        if (temp) { const code = resolvedCodes.get(temp[0]); return code && model.fields[code] ? model.fields[code] : { missingProposed: temp[0] }; }
        if (model.fields[t]) return model.fields[t];
        const byLabel = Object.values(model.fields).find(f => f.label === t);
        if (byLabel) return byLabel;
        // この計画で追加予定の新規フィールドを「コード / ラベル」で参照している（まだ仮適用されていない）
        const pending = [...proposedMap.values()].find(p => !resolvedCodes.has(p.temporaryId) && (p.suggestedCode === t || p.label === t));
        return pending ? { missingProposed: pending.temporaryId } : null;
      };
      const addingStepOf = (temporaryId) => { const s = (ctx.steps || []).find(x => x.targetRef === temporaryId && /^ADD_/.test(String(x.actionType))); return s ? `（${s.id} で追加予定）` : ''; };
      const requireField = (ref, role) => {
        const f = resolveField(ref);
        if (!f) { invalid('UNKNOWN_FIELD', `${role}のフィールド「${ref}」が存在しません`); return null; }
        if (f.missingProposed) { invalid('PROPOSED_FIELD_NOT_APPLIED', `${role}の新規フィールド ${f.missingProposed}${addingStepOf(f.missingProposed)} はこの step より前に追加されていません（順序 / dependsOn を確認）`); return null; }
        return f;
      };
      /** 条件式の構文検査: kintone に無い関数が含まれていれば要確認（評価できない条件は設定できない） */
      const checkCond = (cond, role) => {
        const c = String(cond ?? '').trim();
        if (!c) return;
        const unknown = condUnknownFunctions(c);
        if (unknown.length) issue('COND_UNKNOWN_FUNCTION', 'medium', `${role}「${c}」に kintone の条件式で使えない関数（${unknown.join(', ')}）が含まれています（要確認）`);
        else if (!/(=|!=|<|>|\bin\b|\blike\b)/i.test(c)) issue('COND_NOT_EXPRESSION', 'medium', `${role}「${c}」は kintone の条件式（フィールド 演算子 値）の形ではありません（要確認）`);
        else return;
        if (r.status === STATUS.VALID) r.status = STATUS.NEEDS_CONFIRMATION;
      };
      const entityOk = (en, role) => {
        if (!en) return;
        if (en.type === 'FIELD_ENTITY') { const f = requireField(en.temporaryId || en.code, role); if (f) en.code = f.code; }
        else if (en.type === 'UNKNOWN') { issue('UNKNOWN_ENTITY', 'medium', `${role}「${en.code}」はフィールド・ユーザー・グループ・組織のどれか判別できません（要確認）`); if (r.status === STATUS.VALID) r.status = STATUS.NEEDS_CONFIRMATION; }
      };
      switch (step.actionType) {
        case 'ADD_FIELD': case 'ADD_LOOKUP': {
          const p = proposedMap.get(step.targetRef);
          if (!p) { invalid('PROPOSED_FIELD_MISSING', `新規フィールド ${step.targetRef} が提案（proposedFields）にありません`); return r; }
          const code = p.suggestedCode || p.label;
          const type = step.actionType === 'ADD_LOOKUP' ? 'LOOKUP' : (p.type === 'UNKNOWN' ? (spec.fieldType || 'UNKNOWN') : p.type);
          const already = model.fields[code];
          if (already && already.origin === 'proposed') invalid('PLAN_INTERNAL_DUPLICATE', already.temporaryId === p.temporaryId ? `新規フィールド ${p.temporaryId}（${code}）は ${already.stepId} で既に追加しています（同じ新規フィールドを 2 回追加。ルックアップにするなら ADD_LOOKUP 1 回にまとめます）` : `フィールドコード「${code}」は ${already.stepId} で追加する新規フィールドと重複します`);
          else if (already) invalid('FIELD_CODE_COLLISION', `フィールドコード「${code}」は既に存在します`);
          if (RESERVED_CODES.includes(code)) invalid('RESERVED_CODE', `「${code}」は予約されたフィールドコードです`);
          if (!CODE_RE.test(code) || /^[0-9]/.test(code)) issue('INVALID_CODE', 'medium', `フィールドコード「${code}」は kintone の命名規則に合わない可能性があります（要確認）`);
          const sameLabel = Object.values(model.fields).find(f => f.label === p.label && f.code !== code);
          if (sameLabel) issue('LABEL_DUPLICATE', 'medium', sameLabel.origin === 'proposed' ? `フィールド名「${p.label}」は ${sameLabel.stepId} で追加する新規フィールドと重複します` : `フィールド名「${p.label}」は既存のフィールドと重複します`);
          if (!KINTONE_FIELD_TYPES.includes(type)) invalid('INVALID_FIELD_TYPE', `フィールド型「${type}」は kintone の型ではありません`);
          if (OPTION_TYPES.includes(type) && !(p.options || spec.options || []).length) issue('OPTIONS_MISSING', 'medium', '選択肢が指定されていません（要確認）');
          if ([...resolvedCodes.entries()].some(([tid, c]) => tid !== p.temporaryId && c === code)) invalid('PLAN_INTERNAL_DUPLICATE', `同じコード「${code}」を別の step でも追加しています`);
          if (r.status === STATUS.INVALID) return r;
          const field = { code, label: p.label, type, baseType: type === 'LOOKUP' ? (spec.fieldType && spec.fieldType !== 'LOOKUP' ? spec.fieldType : 'SINGLE_LINE_TEXT') : type, required: !!(p.required || spec.required), unique: false, subtable: null, ...(((p.options || spec.options) || []).length ? { options: [...(p.options?.length ? p.options : spec.options)] } : {}), origin: 'proposed', temporaryId: p.temporaryId, stepId: step.id };
          if (type === 'LOOKUP') {
            const lk = { app: spec.sourceApp || null, keyField: spec.keyField || null, mappings: (spec.mappings || []).map(m => ({ from: m.from, to: m.to })) };
            field.lookup = lk;
            if (!lk.app) issue('LOOKUP_SOURCE_UNKNOWN', 'medium', '参照元アプリが指定されていません（要確認）');
            else if (!/^[0-9]+$/.test(String(lk.app).trim())) { issue('LOOKUP_SOURCE_NOT_ID', 'medium', `参照元アプリ「${lk.app}」はアプリ ID ではありません（参照元のアプリを確認してください）`); if (r.status === STATUS.VALID) r.status = STATUS.NEEDS_CONFIRMATION; }
            validateLookupMappings(lk, step, r, { model, resolveField, requireField, invalid, issue, selfCode: code, addingStepOf });
          }
          model.fields[code] = field;
          resolvedCodes.set(p.temporaryId, code);
          r.simulated = true;
          r.diff.target = { kind: 'FIELD', id: code, temporaryId: p.temporaryId };
          r.diff.before = null; r.diff.after = fieldView(field);
          h(`＋ 新規フィールド「${p.label}」（${code}）`); h(`種類: ${type}${field.required ? '・必須' : ''}${field.options ? `・選択肢 ${field.options.length} 件` : ''}`);
          if (field.lookup) h(`ルックアップ: アプリ ${field.lookup.app || '（要確認）'} / キー ${field.lookup.keyField || '（要確認）'} / 取得 ${field.lookup.mappings.map(m => `${m.from}→${m.to}`).join(', ') || '（なし）'}`);
          if (r.status === STATUS.VALID && !issues.length) h('衝突なし');
          break;
        }
        case 'UPDATE_FIELD': case 'REUSE_FIELD': case 'UPDATE_LOOKUP': {
          const f = requireField(step.targetRef, '対象');
          if (!f) return r;
          r.diff.target = { kind: step.actionType === 'UPDATE_LOOKUP' ? 'LOOKUP' : 'FIELD', id: f.code };
          const beforeView = fieldView(f);
          if (step.actionType === 'REUSE_FIELD') {
            r.diff.changeType = CHANGE.REUSE; r.diff.before = beforeView; r.diff.after = beforeView; r.simulated = true;
            h(`既存フィールド「${f.label}」（${f.code}・${f.type}）を利用（設定変更なし）`);
            if (step.confidence === 'NEEDS_CONFIRMATION' || step.validation?.status === 'needs_confirmation') { issue('MEANING_UNCONFIRMED', 'medium', '既存フィールドの意味（用途）は Toolkit の解析では確認できません'); r.status = STATUS.NEEDS_CONFIRMATION; r.safety = SAFETY.REVIEW_REQUIRED; }
            break;
          }
          const after = clone(f);
          let changed = false;
          if (step.actionType === 'UPDATE_LOOKUP') {
            if (f.type !== 'LOOKUP') { invalid('NOT_A_LOOKUP', `「${f.code}」はルックアップフィールドではありません`); return r; }
            const lk = after.lookup || { app: null, keyField: null, mappings: [] };
            if (spec.sourceApp && spec.sourceApp !== lk.app) { issue('LOOKUP_SOURCE_CHANGE', 'high', `参照元アプリを ${lk.app} → ${spec.sourceApp} に変更します（既存の取得値の整合に注意）`); lk.app = spec.sourceApp; changed = true; }
            if (spec.keyField && spec.keyField !== lk.keyField) { issue('LOOKUP_KEY_CHANGE', 'high', `参照キーを ${lk.keyField} → ${spec.keyField} に変更します`); lk.keyField = spec.keyField; changed = true; }
            const addedNow = new Set();
            for (const m of (spec.mappings || [])) {
              const toField = m.to ? resolveField(m.to) : null;
              const toCode = toField && !toField.missingProposed ? toField.code : m.to;
              const existingTo = lk.mappings.find(x => x.to === toCode);
              if (existingTo && addedNow.has(toCode)) { invalid('LOOKUP_DEST_DUPLICATE', `コピー先「${toCode}」に複数の取得元（${existingTo.from}, ${m.from}）があります`); continue; }
              if (existingTo && existingTo.from !== m.from) { issue('LOOKUP_MAPPING_OVERWRITE', 'high', `コピー先「${toCode}」の取得元を ${existingTo.from} → ${m.from} に上書きします`); existingTo.from = m.from; changed = true; continue; }
              if (existingTo) continue;
              lk.mappings.push({ from: m.from, to: toCode }); addedNow.add(toCode); changed = true;
            }
            after.lookup = lk;
            validateLookupMappings(lk, step, r, { model, resolveField, requireField, invalid, issue, selfCode: f.code, addingStepOf });
          } else {
            if (spec.fieldType && spec.fieldType !== f.type && spec.fieldType !== f.baseType) { issue('TYPE_CHANGE', 'high', `フィールド型を ${f.type} → ${spec.fieldType} に変更します（既存データ・参照している設定に影響）`); after.type = spec.fieldType; after.baseType = spec.fieldType; changed = true; }
            if (typeof spec.required === 'boolean' && spec.required !== f.required) { issue('REQUIRED_CHANGE', spec.required ? 'medium' : 'low', `必須を ${f.required} → ${spec.required} に変更します`); after.required = spec.required; changed = true; }
            if (spec.label && spec.label !== f.label) { after.label = spec.label; changed = true; }
            if (spec.options && spec.options.length) {
              const removed = (f.options || []).filter(o => !spec.options.includes(o));
              if (removed.length) issue('OPTIONS_REMOVED', 'high', `選択肢を削除します: ${removed.join(', ')}（既存レコードの値・条件式に影響）`);
              after.options = [...spec.options]; changed = true;
            }
          }
          if (r.status === STATUS.INVALID) return r;
          if (!changed) { r.diff.changeType = CHANGE.NO_CHANGE; r.diff.before = beforeView; r.diff.after = beforeView; h(`「${f.label}」（${f.code}）: 変更内容を特定できません（proposal の details を確認）`); issue('NO_STRUCTURED_CHANGE', 'medium', '変更内容が構造化されていないため仮適用できません（要確認）'); r.status = STATUS.NEEDS_CONFIRMATION; break; }
          model.fields[f.code] = after; r.simulated = true;
          r.diff.before = beforeView; r.diff.after = fieldView(after);
          h(`「${f.label}」（${f.code}）`); for (const line of fieldDiffLines(beforeView, r.diff.after)) h(line);
          if (issues.some(i => HIGH_RISK.includes(i.code))) { r.status = STATUS.NEEDS_CONFIRMATION; r.safety = SAFETY.REVIEW_REQUIRED; }
          break;
        }
        case 'ADD_PROCESS_STATUS': {
          const name = spec.name || step.targetRef;
          if (!name) { invalid('STATUS_NAME_MISSING', 'ステータス名が指定されていません'); return r; }
          if (model.process.states.some(s => s.name === name)) invalid('STATUS_DUPLICATE', `ステータス「${name}」は既に存在します`);
          const assignees = (spec.assignees || []).map(a => parseEntity(a, model, proposedMap)).filter(Boolean);
          assignees.forEach(en => entityOk(en, '作業者'));
          if (r.status === STATUS.INVALID) return r;
          const stateObj = { name, index: model.process.states.length, assigneeType: assignees.length > 1 ? 'ALL' : 'ONE', assignees, origin: 'proposed', stepId: step.id };
          if (!model.process.enabled) issue('PROCESS_DISABLED', 'medium', 'プロセス管理は現在無効です（有効化が必要）');
          model.process.states.push(stateObj); model.process.enabled = true; r.simulated = true;
          r.diff.target = { kind: 'PROCESS_STATUS', id: name }; r.diff.before = null; r.diff.after = clone(stateObj);
          h(`＋ ステータス「${name}」${assignees.length ? `（作業者: ${assignees.map(entityText).join(', ')}）` : '（作業者の指定なし）'}`);
          // 到達可能性は plan 全体の最後に判定する（後続の ADD_PROCESS_ACTION で繋がる）
          if (r.status === STATUS.VALID) r.status = STATUS.NEEDS_CONFIRMATION;   // 既定: プロセスの変更は確認
          break;
        }
        case 'ADD_PROCESS_ACTION': {
          const name = spec.name || step.targetRef;
          const from = spec.from, to = spec.to, cond = spec.filterCond || '';
          if (!name) { invalid('ACTION_NAME_MISSING', 'アクション名が指定されていません'); return r; }
          if (!from || !to) { invalid('ACTION_ENDPOINT_MISSING', `遷移元 / 遷移先が指定されていません（from: ${from || '—'} / to: ${to || '—'}）`); return r; }
          const froms = splitList(from);
          for (const fr of froms) if (!model.process.states.some(s => s.name === fr)) invalid('UNKNOWN_STATUS', `遷移元ステータス「${fr}」が存在しません`);
          if (!model.process.states.some(s => s.name === to)) invalid('UNKNOWN_STATUS', `遷移先ステータス「${to}」が存在しません`);
          if (model.process.actions.some(a => a.name === name && froms.includes(a.from))) invalid('ACTION_DUPLICATE', `アクション「${name}」（${froms.join('/')} から）は既に存在します`);
          for (const c of condFields(cond, model)) requireField(c, '条件式');
          checkCond(cond, '条件式');
          if (r.status === STATUS.INVALID) return r;
          for (const fr of froms) {
            for (const a of model.process.actions.filter(a => a.from === fr)) {
              const ov = condsOverlap(a.filterCond, cond);
              if (normCond(a.filterCond) === normCond(cond)) issue('ACTION_SAME_CONDITION', 'high', `同じ遷移元「${fr}」に同じ条件のアクション「${a.name}」が既にあります（どちらが実行されるか曖昧）`);
              else if (ov === true) issue('ACTION_CONDITION_OVERLAP', 'medium', `遷移元「${fr}」の既存アクション「${a.name}」（${a.filterCond || '条件なし'}）と条件が重なる可能性があります`);
              else if (ov === null) issue('ACTION_CONDITION_UNPARSED', 'low', `既存アクション「${a.name}」との条件の重なりを判定できません（条件式が複雑）`);
            }
            const act = { name, from: fr, to, filterCond: cond, type: 'PRIMARY', executableUsers: (spec.entities || []).map(e => parseEntity(e, model, proposedMap)).filter(Boolean), origin: 'proposed', stepId: step.id };
            model.process.actions.push(act);
          }
          r.simulated = true;
          r.diff.target = { kind: 'PROCESS_ACTION', id: name }; r.diff.before = null; r.diff.after = { name, from: froms, to, filterCond: cond };
          h(`＋ アクション「${name}」: ${froms.join('/')} → ${to}${cond ? ` [${cond}]` : ''}`);
          if (r.status === STATUS.VALID) r.status = STATUS.NEEDS_CONFIRMATION;
          break;
        }
        case 'UPDATE_PROCESS': {
          // 対象: 既存アクション（条件・遷移先の変更）または既存ステータス（作業者の変更）。それ以外は要確認
          const ref = step.targetRef || spec.name;
          const act = model.process.actions.find(a => a.name === ref);
          const st = model.process.states.find(s => s.name === ref);
          if (!act && !st) { if (ref) invalid('UNKNOWN_PROCESS_TARGET', `プロセス管理に「${ref}」というステータス / アクションはありません`); else { issue('PROCESS_TARGET_MISSING', 'medium', '変更対象（ステータス / アクション）が指定されていません'); r.status = STATUS.NEEDS_CONFIRMATION; r.diff.changeType = CHANGE.NO_CHANGE; } return r; }
          if (act) {
            const beforeAct = clone(act);
            let changed = false;
            // 複数条件（分岐）が details に並ぶ場合: 最初の条件を既存に適用し、他は新しい遷移として扱う
            const condDetails = (step.proposal?.details || []).filter(d => keyOf(d.key) === 'filterCond').map(d => String(d.value));
            const branches = condDetails.map(v => { const m = v.match(/^(.*?)\s*(?:→|->|=>)\s*(.+?)(?:へ遷移|に遷移)?$/); return m ? { cond: m[1].trim(), to: m[2].trim() } : { cond: v.replace(/^(条件|condition)[:：]\s*/i, '').trim(), to: null }; });
            const primary = branches[0] || (spec.filterCond ? { cond: spec.filterCond, to: spec.to || null } : null);
            if (primary && primary.cond && normCond(primary.cond) !== normCond(act.filterCond)) {
              for (const c of condFields(primary.cond, model)) requireField(c, '条件式');
              checkCond(primary.cond, '条件式');
              const narrower = condNarrower(primary.cond, act.filterCond);
              if (narrower === true || !act.filterCond) issue('EXISTING_PATH_RESTRICTED', 'high', `「${act.name}」は現在${act.filterCond ? `条件「${act.filterCond}」` : 'すべて'}の「${act.from}」レコードで実行できます。変更後は「${primary.cond}」の場合のみ実行可能になります`);
              else if (narrower === null) issue('CONDITION_CHANGE_UNPARSED', 'medium', `「${act.name}」の条件を「${act.filterCond}」→「${primary.cond}」に変更します（制限の有無を自動判定できません）`);
              else issue('CONDITION_CHANGE', 'medium', `「${act.name}」の条件を「${act.filterCond || 'なし'}」→「${primary.cond}」に変更します`);
              act.filterCond = primary.cond; changed = true;
            }
            const newTo = (primary && primary.to && primary.to !== act.to) ? primary.to : (spec.to && spec.to !== act.to ? spec.to : null);
            if (newTo) { if (!model.process.states.some(s => s.name === newTo)) invalid('UNKNOWN_STATUS', `遷移先ステータス「${newTo}」が存在しません`); else { issue('TRANSITION_CHANGE', 'high', `「${act.name}」の遷移先を「${act.to}」→「${newTo}」に変更します`); act.to = newTo; changed = true; } }
            if (spec.from && spec.from !== act.from && !branches.length) { const nf = splitList(spec.from); for (const x of nf) if (!model.process.states.some(s => s.name === x)) invalid('UNKNOWN_STATUS', `遷移元ステータス「${x}」が存在しません`); if (r.status !== STATUS.INVALID) { issue('TRANSITION_CHANGE', 'high', `「${act.name}」の遷移元を「${act.from}」→「${nf.join('/')}」に変更します`); act.from = nf[0]; changed = true; for (const x of nf.slice(1)) model.process.actions.push({ ...clone(act), from: x, origin: 'proposed', stepId: step.id }); } }
            for (const b of branches.slice(1)) {
              if (!b.to) continue;
              if (!model.process.states.some(s => s.name === b.to)) { invalid('UNKNOWN_STATUS', `遷移先ステータス「${b.to}」が存在しません`); continue; }
              const add = { name: act.name, from: act.from, to: b.to, filterCond: b.cond, type: 'PRIMARY', executableUsers: [], origin: 'proposed', stepId: step.id };
              if (model.process.actions.some(a => a.from === add.from && a.to === add.to && normCond(a.filterCond) === normCond(add.filterCond))) { issue('ACTION_DUPLICATE', 'medium', `同じ遷移「${add.from} → ${add.to}」（${add.filterCond}）が既にあります`); continue; }
              model.process.actions.push(add); changed = true;
              issue('BRANCH_ADDED', 'medium', `「${act.name}」に分岐を追加: ${add.from} → ${add.to} [${add.filterCond}]`);
            }
            if (r.status === STATUS.INVALID) return r;
            if (!changed) { issue('NO_STRUCTURED_CHANGE', 'medium', '変更内容が構造化されていないため仮適用できません（要確認）'); r.status = STATUS.NEEDS_CONFIRMATION; r.diff.changeType = CHANGE.NO_CHANGE; r.diff.target = { kind: 'PROCESS_ACTION', id: act.name }; r.diff.before = beforeAct; r.diff.after = beforeAct; return r; }
            r.simulated = true;
            r.diff.target = { kind: 'PROCESS_ACTION', id: act.name }; r.diff.before = { name: beforeAct.name, from: beforeAct.from, to: beforeAct.to, filterCond: beforeAct.filterCond }; r.diff.after = { name: act.name, from: act.from, to: act.to, filterCond: act.filterCond, branches: model.process.actions.filter(a => a.name === act.name && a.stepId === step.id).map(a => ({ from: a.from, to: a.to, filterCond: a.filterCond })) };
            h(`「${act.name}」を変更`); h(`Before: ${beforeAct.from} → ${beforeAct.to}${beforeAct.filterCond ? ` [${beforeAct.filterCond}]` : '（条件なし）'}`); h(`After: ${act.from} → ${act.to}${act.filterCond ? ` [${act.filterCond}]` : '（条件なし）'}`);
            for (const a of model.process.actions.filter(a => a.name === act.name && a.stepId === step.id)) h(`After（分岐）: ${a.from} → ${a.to}${a.filterCond ? ` [${a.filterCond}]` : ''}`);
            r.status = STATUS.NEEDS_CONFIRMATION;
          } else {
            const beforeSt = clone(st);
            const assignees = (spec.assignees || []).map(a => parseEntity(a, model, proposedMap)).filter(Boolean);
            assignees.forEach(en => entityOk(en, '作業者'));
            if (r.status === STATUS.INVALID) return r;
            if (!assignees.length) { issue('NO_STRUCTURED_CHANGE', 'medium', '作業者の変更内容を特定できません（要確認）'); r.status = STATUS.NEEDS_CONFIRMATION; r.diff.changeType = CHANGE.NO_CHANGE; r.diff.target = { kind: 'PROCESS_STATUS', id: st.name }; return r; }
            st.assignees = assignees; st.assigneeType = assignees.length > 1 ? 'ALL' : 'ONE'; r.simulated = true;
            r.diff.target = { kind: 'PROCESS_STATUS', id: st.name }; r.diff.before = beforeSt; r.diff.after = clone(st);
            h(`ステータス「${st.name}」の作業者を変更`); h(`Before: ${beforeSt.assignees.map(entityText).join(', ') || '（なし）'}`); h(`After: ${assignees.map(entityText).join(', ')}`);
            issue('ASSIGNEE_CHANGE', 'medium', '作業者の変更は承認フローに影響します'); r.status = STATUS.NEEDS_CONFIRMATION;
          }
          break;
        }
        case 'ADD_NOTIFICATION': case 'UPDATE_NOTIFICATION': {
          const targets = (spec.targets || []).map(t => parseEntity(t, model, proposedMap)).filter(Boolean);
          targets.forEach(en => entityOk(en, '通知先'));
          const cond = spec.filterCond || '';
          const events = spec.events || [];
          for (const c of condFields(cond, model)) requireField(c, '通知条件');
          checkCond(cond, '通知条件');
          if (step.actionType === 'UPDATE_NOTIFICATION') {
            const ref = step.targetRef;
            const ex = [...model.notifications.general, ...model.notifications.perRecord].find(n => n.id === ref || (n.title && n.title === ref));
            if (!ex) { invalid('UNKNOWN_NOTIFICATION', `通知「${ref}」が存在しません`); return r; }
            const beforeN = clone(ex);
            let changed = false;
            if (targets.length) { ex.targets = targets; changed = true; }
            if (cond) { if (ex.scope === 'general') issue('GENERAL_NOTIFICATION_COND', 'medium', 'アプリの条件通知には条件式はありません（条件で絞るならレコードの条件通知として追加します。要確認）'); ex.filterCond = cond; changed = true; }
            if (events.length) { const removed = (ex.events || []).filter(e => !events.includes(e)); if (removed.length) issue('NOTIFICATION_EVENTS_REMOVED', 'high', `通知「${ex.title || ex.id}」のイベント ${removed.join(', ')} が外れます（これらのタイミングでは通知されなくなります）`); ex.events = events; changed = true; }
            if (spec.name && spec.name !== ex.title && spec.name !== ex.id && spec.name !== step.targetRef) { ex.title = spec.name; changed = true; }
            if (r.status === STATUS.INVALID) return r;
            if (!changed) { issue('NO_STRUCTURED_CHANGE', 'medium', '変更内容を特定できません（要確認）'); r.status = STATUS.NEEDS_CONFIRMATION; r.diff.changeType = CHANGE.NO_CHANGE; r.diff.target = { kind: 'NOTIFICATION', id: ex.id }; return r; }
            r.simulated = true; r.diff.target = { kind: 'NOTIFICATION', id: ex.id }; r.diff.before = notifView(beforeN); r.diff.after = notifView(ex);
            h(`通知「${beforeN.title || beforeN.id}」を変更`); for (const line of objDiffLines(r.diff.before, r.diff.after)) h(line);
            r.status = STATUS.NEEDS_CONFIRMATION;
            break;
          }
          if (!targets.length) { issue('TARGETS_MISSING', 'medium', '通知先が指定されていません（要確認）'); r.status = STATUS.NEEDS_CONFIRMATION; }
          if (r.status === STATUS.INVALID) return r;
          const scope = cond || !events.length ? 'perRecord' : 'general';
          if (scope === 'perRecord' && events.length) issue('NOTIFICATION_EVENTS_IGNORED', 'low', `レコードの条件通知にはイベント（${events.join(', ')}）の指定はありません（アプリの条件通知の項目。条件式で判定します）`);
          const n = { id: `${scope}#new:${step.id}`, scope, title: spec.name || step.targetRef || step.title || '', filterCond: cond, targets, events: scope === 'perRecord' ? [] : events, origin: 'proposed', stepId: step.id };
          // 重複 / 類似（既存・plan 内）
          for (const ex of [...model.notifications.general, ...model.notifications.perRecord]) {
            const exact = normCond(ex.filterCond) === normCond(n.filterCond) && sameTargets(ex.targets, n.targets) && (ex.scope !== 'general' || (ex.events.length === n.events.length && ex.events.every(e => n.events.includes(e))));
            const similar = !exact && (overlapTargets(ex.targets, n.targets) && (normCond(ex.filterCond) === normCond(n.filterCond) || (!ex.filterCond && !n.filterCond) || similarLabel(ex.title, n.title) || condsOverlap(ex.filterCond, n.filterCond) === true));
            if (exact) issue(ex.origin === 'proposed' ? 'PLAN_INTERNAL_DUPLICATE' : 'DUPLICATE', 'high', `${ex.origin === 'proposed' ? 'この計画の別の step' : '既存'}の通知「${ex.title || ex.id}」（通知先 ${ex.targets.map(entityText).join(', ')}${ex.filterCond ? `・条件 ${ex.filterCond}` : ''}）と同一です`, { existing: notifView(ex), proposed: notifView(n) });
            else if (similar) issue(ex.origin === 'proposed' ? 'PLAN_INTERNAL_POSSIBLE_DUPLICATE' : 'POSSIBLE_DUPLICATE', 'medium', `${ex.origin === 'proposed' ? 'この計画の別の step' : '既存'}の通知「${ex.title || ex.id}」と類似しています（通知先 ${ex.targets.map(entityText).join(', ')}${ex.filterCond ? `・条件 ${ex.filterCond}` : ''}${ex.events.length ? `・イベント ${ex.events.join(',')}` : ''}）`, { existing: notifView(ex), proposed: notifView(n) });
          }
          model.notifications[scope].push(n); r.simulated = true;
          r.diff.target = { kind: 'NOTIFICATION', id: n.title || n.id }; r.diff.before = null; r.diff.after = notifView(n);
          h(`＋ ${scope === 'general' ? 'アプリの条件通知' : 'レコードの条件通知'}「${n.title || '（無題）'}」`); h(`通知先: ${targets.map(entityText).join(', ') || '（未指定）'}`); if (cond) h(`条件: ${cond}`); if (n.events.length) h(`イベント: ${n.events.join(', ')}`);
          if (issues.some(i => i.code === 'DUPLICATE' || i.code === 'PLAN_INTERNAL_DUPLICATE')) r.status = STATUS.NEEDS_CONFIRMATION; else if (issues.some(i => i.code.includes('POSSIBLE_DUPLICATE')) && r.status === STATUS.VALID) r.status = STATUS.WARNING;
          break;
        }
        case 'ADD_REMINDER': {
          const targets = (spec.targets || []).map(t => parseEntity(t, model, proposedMap)).filter(Boolean);
          targets.forEach(en => entityOk(en, '通知先'));
          const tf = spec.timingField ? requireField(spec.timingField, '基準日') : null;
          if (!spec.timingField) { issue('TIMING_FIELD_MISSING', 'medium', '基準となる日付フィールドが指定されていません（要確認）'); r.status = STATUS.NEEDS_CONFIRMATION; }
          else if (tf && !['DATE', 'DATETIME', 'CREATED_TIME', 'UPDATED_TIME'].includes(tf.baseType || tf.type)) invalid('REMINDER_FIELD_TYPE', `基準フィールド「${tf.code}」は日付型ではありません（${tf.type}）`);
          for (const c of condFields(spec.filterCond || '', model)) requireField(c, '条件');
          checkCond(spec.filterCond || '', '条件');
          if (r.status === STATUS.INVALID) return r;
          const days = spec.daysLater != null ? String(spec.daysLater).replace(/[^-0-9]/g, '') : null;
          const rem = { id: `reminder#new:${step.id}`, title: spec.name || step.targetRef || step.title || '', timing: { code: tf ? tf.code : null, daysLater: days, time: spec.time || null }, filterCond: spec.filterCond || '', targets, origin: 'proposed', stepId: step.id };
          for (const ex of model.reminders) {
            const same = ex.timing.code === rem.timing.code && String(ex.timing.daysLater) === String(rem.timing.daysLater) && normCond(ex.filterCond) === normCond(rem.filterCond) && sameTargets(ex.targets, rem.targets);
            const similar = !same && ex.timing.code === rem.timing.code && overlapTargets(ex.targets, rem.targets);
            if (same) issue(ex.origin === 'proposed' ? 'PLAN_INTERNAL_DUPLICATE' : 'DUPLICATE', 'high', `${ex.origin === 'proposed' ? 'この計画の別の step' : '既存'}のリマインダー「${ex.title || ex.id}」と同一です`, { existing: ex, proposed: rem });
            else if (similar) issue(ex.origin === 'proposed' ? 'PLAN_INTERNAL_POSSIBLE_DUPLICATE' : 'POSSIBLE_DUPLICATE', 'medium', `${ex.origin === 'proposed' ? 'この計画の別の step' : '既存'}のリマインダー「${ex.title || ex.id}」（${ex.timing.code} の ${ex.timing.daysLater} 日後・通知先 ${ex.targets.map(entityText).join(', ')}）と類似しています`, { existing: ex, proposed: rem });
          }
          model.reminders.push(rem); r.simulated = true;
          r.diff.target = { kind: 'REMINDER', id: rem.title || rem.id }; r.diff.before = null; r.diff.after = clone(rem);
          h(`＋ リマインダー「${rem.title || '（無題）'}」: ${rem.timing.code || '（基準日 要確認）'} の ${rem.timing.daysLater ?? '?'} 日後${rem.timing.time ? ` ${rem.timing.time}` : ''} に ${targets.map(entityText).join(', ') || '（通知先 未指定）'} へ`);
          if (issues.some(i => i.code === 'DUPLICATE' || i.code === 'PLAN_INTERNAL_DUPLICATE')) r.status = STATUS.NEEDS_CONFIRMATION; else if (issues.some(i => i.code.includes('POSSIBLE_DUPLICATE')) && r.status === STATUS.VALID) r.status = STATUS.WARNING;
          break;
        }
        case 'ADD_VIEW': case 'UPDATE_VIEW': {
          const name = spec.name || step.targetRef;
          const fields = (spec.fields || []).map(f => { const rf = resolveField(f); return rf ? (rf.missingProposed ? rf : rf.code) : f; });
          for (const f of fields) { if (typeof f === 'object') invalid('PROPOSED_FIELD_NOT_APPLIED', `一覧の表示フィールド ${f.missingProposed} はこの step より前に追加されていません`); else if (!model.fields[f] && !RESERVED_CODES.includes(f)) invalid('UNKNOWN_FIELD', `一覧の表示フィールド「${f}」が存在しません`); }
          for (const c of condFields(spec.filterCond || '', model)) requireField(c, '絞り込み条件');
          checkCond(spec.filterCond || '', '絞り込み条件');
          if (spec.sort) { const sf = String(spec.sort).trim().split(/\s+/)[0]; if (sf && !model.fields[sf] && !RESERVED_CODES.includes(sf)) issue('SORT_FIELD_UNKNOWN', 'medium', `ソート条件のフィールド「${sf}」が存在しません（要確認）`); }
          if (step.actionType === 'ADD_VIEW') {
            if (!name) { invalid('VIEW_NAME_MISSING', '一覧名が指定されていません'); return r; }
            if (model.views.some(v => v.name === name)) invalid('VIEW_NAME_DUPLICATE', `一覧「${name}」は既に存在します`);
            if (r.status === STATUS.INVALID) return r;
            const v = { name, type: 'LIST', fields: fields.filter(f => typeof f === 'string'), filterCond: spec.filterCond || '', sort: spec.sort || '', origin: 'proposed', stepId: step.id };
            model.views.push(v); r.simulated = true;
            r.diff.target = { kind: 'VIEW', id: name }; r.diff.before = null; r.diff.after = clone(v);
            h(`＋ 一覧「${name}」`); if (v.fields.length) h(`表示: ${v.fields.join(', ')}`); if (v.filterCond) h(`絞り込み: ${v.filterCond}`); if (v.sort) h(`並び順: ${v.sort}`);
          } else {
            const v = model.views.find(x => x.name === name);
            if (!v) { invalid('UNKNOWN_VIEW', `一覧「${name}」が存在しません`); return r; }
            if (r.status === STATUS.INVALID) return r;
            const beforeV = clone(v); let changed = false;
            if (fields.length) { v.fields = fields.filter(f => typeof f === 'string'); changed = true; }
            if (spec.filterCond) { v.filterCond = spec.filterCond; changed = true; }
            if (spec.sort) { v.sort = spec.sort; changed = true; }
            if (!changed) { issue('NO_STRUCTURED_CHANGE', 'medium', '変更内容を特定できません（要確認）'); r.status = STATUS.NEEDS_CONFIRMATION; r.diff.changeType = CHANGE.NO_CHANGE; r.diff.target = { kind: 'VIEW', id: name }; return r; }
            r.simulated = true; r.diff.target = { kind: 'VIEW', id: name }; r.diff.before = beforeV; r.diff.after = clone(v);
            h(`一覧「${name}」を変更`); for (const line of objDiffLines({ fields: beforeV.fields.join(', '), filterCond: beforeV.filterCond, sort: beforeV.sort }, { fields: v.fields.join(', '), filterCond: v.filterCond, sort: v.sort })) h(line);
            if (r.status === STATUS.VALID) r.status = STATUS.WARNING;
          }
          break;
        }
        case 'ADD_APP_ACTION': {
          const name = spec.name || step.targetRef;
          if (!name) { invalid('APP_ACTION_NAME_MISSING', 'アプリアクション名が指定されていません'); return r; }
          if (model.appActions.some(a => a.name === name)) invalid('APP_ACTION_NAME_DUPLICATE', `アプリアクション「${name}」は既に存在します`);
          const mappings = (spec.mappings || []).map(m => ({ srcType: 'FIELD', srcField: m.from, destField: m.to }));
          for (const m of mappings) { if (m.srcField && !resolveField(m.srcField)) invalid('UNKNOWN_FIELD', `コピー元フィールド「${m.srcField}」が存在しません`); if (!m.destField) issue('DEST_FIELD_UNKNOWN', 'medium', `コピー先フィールドが不明です（${m.srcField}）`); }
          if (!spec.destApp) { issue('DEST_APP_UNKNOWN', 'medium', '作成先アプリが指定されていません（要確認）'); r.status = STATUS.NEEDS_CONFIRMATION; }
          if (mappings.some((m, i) => mappings.findIndex(x => x.destField === m.destField) !== i)) issue('MAPPING_DUPLICATE', 'medium', '同じコピー先に複数のコピー元があります');
          if (r.status === STATUS.INVALID) return r;
          const a = { name, destApp: spec.destApp || '', mappings, origin: 'proposed', stepId: step.id };
          model.appActions.push(a); r.simulated = true;
          r.diff.target = { kind: 'APP_ACTION', id: name }; r.diff.before = null; r.diff.after = clone(a);
          h(`＋ アプリアクション「${name}」→ アプリ ${a.destApp || '（要確認）'}`); if (mappings.length) h(`コピー: ${mappings.map(m => `${m.srcField}→${m.destField || '?'}`).join(', ')}`);
          if (r.status === STATUS.VALID) r.status = STATUS.NEEDS_CONFIRMATION;
          break;
        }
        default:
          break;
      }
      // 高リスクの issue があれば確認必須
      if (issues.some(i => HIGH_RISK.includes(i.code)) && STATUS_RANK[r.status] < STATUS_RANK[STATUS.NEEDS_CONFIRMATION]) r.status = STATUS.NEEDS_CONFIRMATION;
      if (r.status === STATUS.NEEDS_CONFIRMATION && r.safety === SAFETY.SAFE) r.safety = SAFETY.REVIEW_REQUIRED;
      return r;
    }

    /** 仮適用しない（検証のみ）の action: ACL / UPDATE_APP_ACTION */
    function validateOnly(step, r, ctx) {
      const { model, proposedMap } = ctx;
      const spec = normalizeSpec(step, model, proposedMap);
      r.spec = spec;
      const issue = (code, severity, message) => r.issues.push({ code, severity, message });
      const invalid = (code, message) => { issue(code, 'high', message); r.status = STATUS.INVALID; r.safety = SAFETY.BLOCKED; r.diff.changeType = CHANGE.INVALID; };
      if (step.actionType === 'UPDATE_FIELD_ACL') {
        const f = step.targetRef && (model.fields[step.targetRef] || Object.values(model.fields).find(x => x.label === step.targetRef));
        if (!f) { if (/NEW_FIELD_\d+/.test(step.targetRef || '')) issue('PROPOSED_FIELD_DEPENDENCY', 'medium', '新規フィールドのアクセス権はフィールド追加の後に設定します'); else invalid('UNKNOWN_FIELD', `アクセス権の対象フィールド「${step.targetRef}」が存在しません`); }
        else { r.diff.target = { kind: 'FIELD_ACL', id: f.code }; const ex = model.acl.field.find(x => x.code === f.code); r.diff.before = ex ? clone(ex) : null; if (ex) issue('ACL_EXISTING_RULE', 'medium', `「${f.code}」には既にフィールドのアクセス権（${ex.entities.map(e => `${entityText(e)}=${e.accessibility}`).join(', ')}）があります`); }
        issue('ACL_CHANGE', 'high', 'アクセス権の変更は閲覧・編集できる人を変えるため、必ず確認してください');
        for (const e of (spec.entities || [])) { const en = parseEntity(e, model, proposedMap); if (en?.type === 'UNKNOWN') issue('UNKNOWN_ENTITY', 'medium', `対象「${en.code}」の種別（ユーザー / グループ / 組織 / フィールド）を判別できません`); else if (en?.type === 'FIELD_ENTITY' && !model.fields[en.code]) issue('UNKNOWN_FIELD', 'medium', `対象フィールド「${en.code}」が存在しません`); }
        r.diff.human.push(`フィールド「${step.targetRef}」のアクセス権を変更（仮適用なし）`);
      } else if (step.actionType === 'UPDATE_RECORD_ACL') {
        issue('ACL_CHANGE', 'high', 'レコードのアクセス権の変更は閲覧・編集・削除できる人を変えるため、必ず確認してください');
        for (const c of condFields(spec.filterCond || '', model)) if (!model.fields[c]) issue('UNKNOWN_FIELD', 'medium', `条件のフィールド「${c}」が存在しません`);
        const ex = model.acl.record.find(x => spec.filterCond && normCond(x.filterCond) === normCond(spec.filterCond));
        if (ex) issue('ACL_EXISTING_RULE', 'medium', `同じ条件（${ex.filterCond || '全レコード'}）のレコードのアクセス権 ${ex.id} が既にあります`);
        r.diff.target = { kind: 'RECORD_ACL', id: step.targetRef || null }; r.diff.before = ex ? clone(ex) : null;
        r.diff.human.push(`レコードのアクセス権を変更${spec.filterCond ? `（条件 ${spec.filterCond}）` : ''}（仮適用なし）`);
      } else if (step.actionType === 'UPDATE_APP_ACTION') {
        const a = model.appActions.find(x => x.name === step.targetRef);
        if (!a) invalid('UNKNOWN_APP_ACTION', `アプリアクション「${step.targetRef}」が存在しません`);
        else { r.diff.target = { kind: 'APP_ACTION', id: a.name }; r.diff.before = clone(a); for (const m of (spec.mappings || [])) if (m.from && !model.fields[m.from]) issue('UNKNOWN_FIELD', 'medium', `コピー元フィールド「${m.from}」が存在しません`); r.diff.human.push(`アプリアクション「${a.name}」を変更（仮適用なし）`); }
      }
      if (r.status !== STATUS.INVALID) r.status = STATUS.NEEDS_CONFIRMATION;
    }

    function validateLookupMappings(lk, step, r, { model, resolveField, requireField, invalid, issue, selfCode, addingStepOf = () => '' }) {
      const seen = new Map();
      for (const m of lk.mappings) {
        if (!m.to) { issue('LOOKUP_DEST_MISSING', 'medium', `取得項目「${m.from}」のコピー先が指定されていません`); continue; }
        const f = resolveField(m.to);
        if (!f) { invalid('LOOKUP_DEST_UNKNOWN', `コピー先フィールド「${m.to}」が存在しません`); continue; }
        if (f.missingProposed) { invalid('PROPOSED_FIELD_NOT_APPLIED', `コピー先の新規フィールド ${f.missingProposed}${addingStepOf(f.missingProposed)} はこの step より前に追加されていません（順序 / dependsOn を確認）`); continue; }
        m.to = f.code;
        if (seen.has(m.to)) invalid('LOOKUP_DEST_DUPLICATE', `コピー先「${m.to}」に複数の取得元（${seen.get(m.to)}, ${m.from}）があります`); else seen.set(m.to, m.from);
        if (f.type === 'LOOKUP' && f.code !== selfCode) issue('LOOKUP_DEST_IS_LOOKUP', 'medium', `コピー先「${m.to}」はルックアップフィールドです`);
        for (const other of Object.values(model.fields)) if (other.lookup && other.code !== selfCode && other.lookup.mappings.some(x => x.to === m.to)) issue('LOOKUP_DEST_CONFLICT', 'high', `コピー先「${m.to}」は既存のルックアップ「${other.label}」（${other.code}）も書き込みます`);
      }
    }

    // ================= plan 全体の競合 =================
    function planLevelConflicts(steps, results, model, conflicts) {
      // 同じフィールドコードを複数 step が追加
      const adds = new Map();
      for (const r of results.values()) if (r.diff.changeType === CHANGE.ADD && r.diff.target.kind === 'FIELD') { const k = r.diff.target.id; if (adds.has(k)) conflicts.push({ code: 'PLAN_INTERNAL_DUPLICATE_FIELD', severity: 'high', stepIds: [adds.get(k), r.stepId], message: `${adds.get(k)} と ${r.stepId} が同じフィールド「${k}」を追加します` }); else adds.set(k, r.stepId); }
      // plan 内で追加した通知同士の重複（reviewStep で PLAN_INTERNAL_* として issue 済みのものを conflicts にも集約）
      for (const r of results.values()) for (const i of r.issues) if (i.code.startsWith('PLAN_INTERNAL') && !conflicts.some(c => c.stepIds.includes(r.stepId) && c.code === i.code)) conflicts.push({ code: i.code, severity: i.severity, stepIds: [r.stepId, ...(i.existing?.stepId ? [i.existing.stepId] : [])], message: i.message, existing: i.existing ?? null, proposed: i.proposed ?? null });
      for (const r of results.values()) for (const i of r.issues) if ((i.code === 'DUPLICATE' || i.code === 'POSSIBLE_DUPLICATE' || i.code === 'LOOKUP_DEST_CONFLICT' || i.code === 'ACTION_SAME_CONDITION' || i.code === 'ACTION_CONDITION_OVERLAP') && !conflicts.some(c => c.stepIds.includes(r.stepId) && c.message === i.message)) conflicts.push({ code: i.code, severity: i.severity, stepIds: [r.stepId], message: i.message, existing: i.existing ?? null, proposed: i.proposed ?? null });
      // 同じ参照元アプリ・キーのルックアップを複数の step が追加 → kintone では 1 つのルックアップで複数項目を取得できる
      const lookups = new Map();
      for (const r of results.values()) if (r.diff.changeType === CHANGE.ADD && r.diff.after && r.diff.after.lookup && r.diff.after.lookup.app) { const k = `${r.diff.after.lookup.app}|${r.diff.after.lookup.keyField || ''}`; lookups.set(k, [...(lookups.get(k) || []), r.stepId]); }
      for (const [k, ids] of lookups) if (ids.length > 1) conflicts.push({ code: 'LOOKUP_SPLIT', severity: 'medium', stepIds: ids, message: `${ids.join(', ')} は同じ参照元（アプリ ${k.split('|')[0]} / キー ${k.split('|')[1] || '—'}）のルックアップです。1 つのルックアップで複数の項目を取得できます（分けると利用者が ${ids.length} 回選ぶことになります）` });
      // プロセス: 到達不能なステータス（遷移先として現れない新規ステータス）・遷移先の無いステータス
      const states = model.process.states, actions = model.process.actions;
      for (const s of states.filter(x => x.origin === 'proposed')) {
        if (!actions.some(a => a.to === s.name)) conflicts.push({ code: 'STATUS_UNREACHABLE', severity: 'high', stepIds: [s.stepId], message: `ステータス「${s.name}」へ遷移するアクションがありません（到達不能）` });
        if (!actions.some(a => a.from === s.name) && states.findIndex(x => x.name === s.name) !== states.length - 1 && states.some(x => x.index > s.index)) conflicts.push({ code: 'STATUS_DEAD_END', severity: 'medium', stepIds: [s.stepId], message: `ステータス「${s.name}」から先へ進むアクションがありません` });
      }
    }

    // ================= 影響の再確認 =================
    function recheckImpact(plan, results, deps, before) {
      const warnings = [], items = [];
      if (!deps || !Array.isArray(deps.edges)) return { warnings, items };
      const touched = new Map();   // fieldCode → stepIds
      for (const r of results.values()) {
        if (r.diff.target.kind === 'FIELD' && r.diff.changeType === CHANGE.UPDATE || r.diff.target.kind === 'LOOKUP') { const c = r.diff.target.id; if (before.fields[c]) touched.set(c, [...(touched.get(c) || []), r.stepId]); }
        if (r.diff.changeType === CHANGE.REUSE && r.diff.target.kind === 'FIELD') { const c = r.diff.target.id; touched.set(c, [...(touched.get(c) || []), r.stepId]); }
      }
      const plannerImpact = Array.isArray(plan?.impact) ? plan.impact : [];
      for (const [code, stepIds] of touched) {
        let impact = null;
        try { impact = KTDeps.impactOf(deps, code); } catch (e) { impact = null; }
        if (!impact) continue;
        const direct = impact.direct || [];
        const jsCount = direct.filter(d => d.sourceType === 'CUSTOMIZE').length;
        const byCat = {};
        for (const d of direct) byCat[d.category] = (byCat[d.category] || 0) + 1;
        const plannerSaid = plannerImpact.filter(x => x.targetRef === code);
        const plannerMentionsJs = plannerSaid.some(x => /JavaScript|JS|スクリプト/i.test(x.description || ''));
        items.push({ fieldCode: code, stepIds, toolkit: { direct: direct.length, byCategory: byCat, js: jsCount, indirect: (impact.indirect || []).length, crossApp: (impact.crossApp || []).length }, planner: plannerSaid.map(x => x.description) });
        if (!plannerSaid.length && direct.length) warnings.push({ code: 'PLANNER_IMPACT_MISSING', severity: 'medium', stepIds, message: `「${code}」は ${direct.length} 件の設定・JS から参照されていますが、Planner の影響範囲に挙がっていません（${Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join('・')}）` });
        else if (jsCount && !plannerMentionsJs) warnings.push({ code: 'PLANNER_IMPACT_MISMATCH', severity: 'medium', stepIds, message: `「${code}」を参照する JavaScript が ${jsCount} 件ありますが、Planner の影響範囲に JS が含まれていません` });
        else if (plannerSaid.length && !direct.length) warnings.push({ code: 'PLANNER_IMPACT_OVERSTATED', severity: 'low', stepIds, message: `Planner は「${code}」への影響を挙げていますが、Toolkit の解析では参照する設定・JS はありません` });
      }
      return { warnings, items };
    }

    // ================= 表示用 =================
    const fieldView = (f) => ({ code: f.code, label: f.label, type: f.type, required: !!f.required, ...(f.unique ? { unique: true } : {}), ...(f.options ? { options: [...f.options] } : {}), ...(f.expression ? { expression: f.expression } : {}), ...(f.lookup ? { lookup: clone(f.lookup) } : {}), ...(f.temporaryId ? { temporaryId: f.temporaryId } : {}) });
    const notifView = (n) => ({ id: n.id, scope: n.scope, title: n.title, targets: n.targets.map(entityText), filterCond: n.filterCond, events: [...(n.events || [])], ...(n.stepId ? { stepId: n.stepId } : {}) });
    const JA = { type: '種類', required: '必須', label: '名前', options: '選択肢', expression: '計算式', lookup: 'ルックアップ', targets: '通知先', filterCond: '条件', events: 'イベント', title: 'タイトル', fields: '表示フィールド', sort: '並び順' };
    const fmtVal = (v) => (v == null ? '—' : Array.isArray(v) ? (v.length ? v.join(', ') : '（なし）') : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v) || '（なし）');
    /** 変更のある属性だけ Before / After を出す */
    function objDiffLines(a, b) {
      const out = [];
      for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
        if (k === 'code' || k === 'id' || k === 'scope' || k === 'temporaryId') continue;
        const x = a?.[k], y = b?.[k];
        if (JSON.stringify(x) === JSON.stringify(y)) continue;
        out.push(`${JA[k] || k}: ${fmtVal(x)} → ${fmtVal(y)}`);
      }
      return out;
    }
    const fieldDiffLines = objDiffLines;
    function processSummary(p) { return { enabled: p.enabled, states: p.states.map(s => ({ name: s.name, assignees: s.assignees.map(entityText), origin: s.origin })), actions: p.actions.map(a => ({ name: a.name, from: a.from, to: a.to, filterCond: a.filterCond, origin: a.origin })) }; }
    /** プロセスの Mermaid（flowchart LR）。before を渡すと新規・変更分を強調する */
    function processMermaid(p, before = null) {
      if (!p || !p.states.length) return '';
      const esc = (s) => String(s || '').replace(/>=/g, '≧').replace(/<=/g, '≦').replace(/>/g, '＞').replace(/</g, '＜').replace(/["`]/g, '').replace(/[{}[\]|]/g, ' ').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
      const idOf = new Map(p.states.map((s, i) => [s.name, `S${i}`]));
      const lines = ['flowchart LR'];
      for (const s of p.states) lines.push(`  ${idOf.get(s.name)}["${esc(s.name)}"]`);
      const beforeActs = before ? before.actions : null;
      p.actions.forEach((a, i) => {
        const f = idOf.get(a.from), t = idOf.get(a.to);
        if (!f || !t) return;
        const label = esc(a.filterCond ? `${a.name} [${a.filterCond}]` : a.name);
        const existed = beforeActs ? beforeActs.some(b => b.name === a.name && b.from === a.from && b.to === a.to && normCond(b.filterCond) === normCond(a.filterCond)) : true;
        lines.push(`  ${f} ${existed ? '-->' : '==>'}|${label}| ${t}`);
        if (!existed) lines.push(`  linkStyle ${lines.filter(l => /-->|==>/.test(l)).length - 1} stroke:#1a73e8,stroke-width:3px`);
      });
      for (const s of p.states) if (s.origin === 'proposed') lines.push(`  style ${idOf.get(s.name)} fill:#e3f0ff,stroke:#1a73e8,stroke-width:2px`);
      return lines.join('\n');
    }
    /** Executor へ渡す形。承認は BLOCKED でない step（SAFE / REVIEW_REQUIRED / PLAN_ONLY）を採り、review.executionReadiness.approvedSteps と一致させる。
     *  PLAN_ONLY の承認は Executor が「承認済みだが未対応」として表示する（黙って落とさない） */
    const executorOutput = (plan, rev, approvedSteps = []) => {
      const executable = new Set((rev?.steps || []).filter(r => r.safety !== SAFETY.BLOCKED).map(r => r.stepId));
      const approved = [...new Set(approvedSteps)].filter(id => executable.has(id));
      return { outputVersion: '1', plan: KTContextUi.planJson ? KTContextUi.planJson(plan) : plan, review: { ...rev, simulation: { ...rev.simulation, after: undefined }, executionReadiness: { ...(rev?.executionReadiness || {}), approvedSteps: approved } }, approvedSteps: approved };
    };

    return {
      REVIEW_VERSION, STATUS, SAFETY, CHANGE, ACTION_CAPABILITIES, HIGH_RISK,
      buildBeforeModel, normalizeSpec, parseEntity, parseCond, condsOverlap, condNarrower, review, processMermaid, processSummary, objDiffLines, executorOutput,
    };
  })();

  // ==========================================
  // 3.6c Preview Executor (KTPlanExecutor) — Phase 9
  //   人間が承認した「安全に実行できる step」だけを kintone の動作テスト環境（preview）へ反映し、再取得して検証する層。
  //   AI は Executor を直接操作できない。実行経路は AI Plan → KTPlanReview → 人間の承認 → Executor → Action Handler Registry
  //   （allowlist）→ kintone preview API → 再取得 → Verification。運用環境へ反映する関数は持たない（productionDeploy は常に false）。
  //   kintone API は注入（api）。純粋なロジックは Node でテストできる。token・cookie・秘密情報はログに含めない。
  // ==========================================
  const KTPlanExecutor = (() => {
    const EXECUTOR_VERSION = '1';
    const ENV = 'preview';
    const STEP = Object.freeze({ PENDING: 'PENDING', RUNNING: 'RUNNING', APPLIED: 'APPLIED', VERIFIED: 'VERIFIED', VERIFY_FAILED: 'VERIFY_FAILED', FAILED: 'FAILED', SKIPPED: 'SKIPPED', BLOCKED: 'BLOCKED', UNSUPPORTED: 'UNSUPPORTED', ROLLED_BACK: 'ROLLED_BACK' });
    const RUN = Object.freeze({ PREPARED: 'PREPARED', BLOCKED: 'BLOCKED', RUNNING: 'RUNNING', DONE: 'DONE', PARTIAL: 'PARTIAL', FAILED: 'FAILED' });
    /** Tier 1 で preview へ追加できるフィールド型（API 仕様が単純で、追加パラメーターが要らないもの。CALC / LINK / LOOKUP / 関連レコード / テーブル / グループは対象外） */
    const PREVIEW_FIELD_TYPES = ['SINGLE_LINE_TEXT', 'MULTI_LINE_TEXT', 'RICH_TEXT', 'NUMBER', 'DATE', 'TIME', 'DATETIME', 'DROP_DOWN', 'RADIO_BUTTON', 'CHECK_BOX', 'MULTI_SELECT', 'USER_SELECT', 'ORGANIZATION_SELECT', 'GROUP_SELECT', 'FILE'];
    const OPTION_TYPES = ['DROP_DOWN', 'RADIO_BUTTON', 'CHECK_BOX', 'MULTI_SELECT'];
    const BUILTIN_VIEW_CODES = ['レコード番号', '作成者', '作成日時', '更新者', '更新日時', 'ステータス', '作業者', 'カテゴリー'];
    const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const nowIso = (now) => new Date(now()).toISOString();
    const newId = (prefix) => `${prefix}_${(typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
    const strErr = (e) => (e && typeof e === 'object') ? { code: e.code ?? null, message: String(e.message ?? e.error ?? ''), status: e.status ?? null } : { code: null, message: String(e ?? ''), status: null };
    const isPermissionError = (e) => { const s = strErr(e); return s.status === 403 || s.code === 'CB_NO02' || /権限|permission|forbidden/i.test(s.message); };
    const isRevisionError = (e) => { const s = strErr(e); return s.code === 'GAIA_CO02' || /リビジョン|revision/i.test(s.message); };

    // ================= Action Capability Registry（Executor の SoT）=================
    //   Phase 8 の ACTION_CAPABILITIES（validate / simulate / defaultSafety）に Executor の列を重ねる。
    //   previewExecute: 動作テスト環境へ反映できるか / verify: 反映後に再取得で検証するか / rollbackStrategy: 将来の rollback handler の方針 /
    //   productionDeploy: 運用環境へ反映できるか（Phase 9 は全て false。関数も持たない）
    const EXECUTOR_COLUMNS = Object.freeze({
      ADD_FIELD: { previewExecute: true, verify: true, rollbackStrategy: 'DELETE_FIELD' },
      ADD_VIEW: { previewExecute: true, verify: true, rollbackStrategy: 'RESTORE_VIEWS' },
      ADD_NOTIFICATION: { previewExecute: false, verify: true, rollbackStrategy: 'RESTORE_SNAPSHOT', reason: 'NEXT' },
      ADD_REMINDER: { previewExecute: false, verify: true, rollbackStrategy: 'RESTORE_SNAPSHOT', reason: 'NEXT' },
    });
    const ACTION_CAPABILITIES = Object.freeze(Object.fromEntries(Object.entries(KTPlanReview.ACTION_CAPABILITIES).map(([k, v]) => {
      const ex = EXECUTOR_COLUMNS[k] || { previewExecute: false, verify: !!v.validate, rollbackStrategy: v.simulate ? 'RESTORE_SNAPSHOT' : 'NONE' };
      return [k, Object.freeze({ ...v, previewExecute: !!ex.previewExecute, verify: !!ex.verify, rollbackStrategy: ex.rollbackStrategy, productionDeploy: false })];
    })));

    // ================= Action Handler Registry（allowlist）=================
    //   handler = { prepare(step, ctx) → { payload, expect, summary }, apply(ctx, p) → { revision }, verify(ctx, p) → { ok, checks[] }, rollback(ctx, p) → rollback step（計画のみ） }
    const HANDLERS = {};

    /** review の step（diff.after）と spec から、フィールド追加の API payload を作る */
    HANDLERS.ADD_FIELD = {
      prepare(step, { stepReview }) {
        const after = stepReview?.diff?.after;
        if (!after || !after.code) return { unsupported: 'NO_FIELD_SPEC', message: 'Review に追加後のフィールド定義がありません' };
        const type = after.type;
        if (!PREVIEW_FIELD_TYPES.includes(type)) return { unsupported: 'FIELD_TYPE_NOT_SUPPORTED', message: `フィールド型 ${type} は現在の Executor では動作テスト環境へ追加できません（Tier 1: ${PREVIEW_FIELD_TYPES.join(', ')}）` };
        const options = Array.isArray(after.options) ? after.options : [];
        if (OPTION_TYPES.includes(type) && !options.length) return { unsupported: 'OPTIONS_MISSING', message: '選択肢が決まっていないため追加できません' };
        const prop = { type, code: after.code, label: after.label, noLabel: false, required: !!after.required };
        if (OPTION_TYPES.includes(type)) prop.options = Object.fromEntries(options.map((o, i) => [o, { label: o, index: String(i) }]));
        if (type === 'SINGLE_LINE_TEXT' || type === 'NUMBER') prop.unique = !!after.unique;
        return {
          payload: { properties: { [after.code]: prop } },
          expect: { code: after.code, type, label: after.label, required: !!after.required, ...(OPTION_TYPES.includes(type) ? { options } : {}) },
          summary: `＋ フィールド「${after.label}」（${after.code}・${type}${after.required ? '・必須' : ''}${options.length ? `・選択肢 ${options.length} 件` : ''}）`,
          temporaryId: after.temporaryId || null,
        };
      },
      async apply({ api, appId, revision, layoutPolicy }, p) {
        const res = await api.addPreviewFields(appId, p.payload.properties, revision);
        const out = { revision: String(res?.revision ?? ''), requests: [{ method: 'POST', path: '/k/v1/preview/app/form/fields.json', codes: Object.keys(p.payload.properties) }] };
        // 配置: フィールド追加だけでは配置が保証されないので、レイアウトを取得して無ければ末尾の行へ追加する（既存の行は変えない）
        if (layoutPolicy === 'APPEND_ROW') {
          const lay = await api.getPreviewLayout(appId);
          const rows = Array.isArray(lay?.layout) ? lay.layout : [];
          const code = p.expect.code;
          if (!layoutHasCode(rows, code)) {
            const next = [...clone(rows), { type: 'ROW', fields: [{ type: p.expect.type, code }] }];
            const put = await api.putPreviewLayout(appId, next, String(lay?.revision ?? out.revision));
            out.revision = String(put?.revision ?? out.revision);
            out.requests.push({ method: 'PUT', path: '/k/v1/preview/app/form/layout.json', placement: 'APPENDED_ROW', rowsBefore: rows.length, rowsAfter: next.length });
            out.layout = { placement: 'APPENDED_ROW', rowsBefore: rows.length };
          } else {
            out.requests.push({ method: 'GET', path: '/k/v1/preview/app/form/layout.json', placement: 'AUTO' });
            out.layout = { placement: 'AUTO', rowsBefore: rows.length };
          }
        }
        return out;
      },
      async verify({ api, appId, snapshot }, p, applied) {
        const cur = await api.getPreviewFields(appId);
        const f = cur?.properties?.[p.expect.code];
        const checks = [];
        const check = (name, ok, expected, actual) => checks.push({ name, ok, expected, actual });
        check('exists', !!f, true, !!f);
        if (f) {
          check('type', f.type === p.expect.type, p.expect.type, f.type);
          check('label', f.label === p.expect.label, p.expect.label, f.label);
          check('required', !!f.required === p.expect.required, p.expect.required, !!f.required);
          if (p.expect.options) {
            const actual = Object.keys(f.options || {}).sort((a, b) => Number(f.options[a]?.index ?? 0) - Number(f.options[b]?.index ?? 0));
            check('options', same(actual, p.expect.options), p.expect.options, actual);
          }
        }
        // 既存フィールドが減っていない（追加のみ）
        const beforeCodes = Object.keys(snapshot?.fields?.properties || {});
        const lost = beforeCodes.filter(c => !cur?.properties?.[c]);
        check('existingFieldsPreserved', lost.length === 0, beforeCodes.length, beforeCodes.length - lost.length);
        if (applied?.layout) {
          const lay = await api.getPreviewLayout(appId);
          const rows = Array.isArray(lay?.layout) ? lay.layout : [];
          check('layoutContainsField', layoutHasCode(rows, p.expect.code), true, layoutHasCode(rows, p.expect.code));
          const beforeRows = Array.isArray(snapshot?.layout?.layout) ? snapshot.layout.layout : [];
          const preserved = beforeRows.every((row, i) => same(stripLayoutRow(row), stripLayoutRow(rows[i])));
          check('existingLayoutPreserved', preserved, beforeRows.length, rows.length);
        }
        return { ok: checks.every(c => c.ok), checks, revision: String(cur?.revision ?? '') };
      },
      rollback({ appId }, p) {
        return { actionType: 'DELETE_FIELD', target: p.expect.code, api: { method: 'DELETE', path: '/k/v1/preview/app/form/fields.json', payload: { app: appId, fields: [p.expect.code] } }, note: '動作テスト環境のフィールドを削除する（運用環境には無い）。レイアウトは snapshot の layout を PUT で戻す' };
      },
    };

    /** 既存の一覧 ＋ 新しい一覧 = 完全な payload（既存を落とさない） */
    HANDLERS.ADD_VIEW = {
      prepare(step, { stepReview }) {
        const after = stepReview?.diff?.after;
        if (!after || !after.name) return { unsupported: 'NO_VIEW_SPEC', message: 'Review に追加後の一覧定義がありません' };
        if ((after.type || 'LIST') !== 'LIST') return { unsupported: 'VIEW_TYPE_NOT_SUPPORTED', message: `一覧の形式 ${after.type} は現在の Executor では追加できません（表形式のみ）` };
        if (!Array.isArray(after.fields) || !after.fields.length) return { unsupported: 'VIEW_FIELDS_MISSING', message: '表示フィールドが決まっていないため追加できません' };
        return {
          payload: { view: { type: 'LIST', name: after.name, fields: [...after.fields], filterCond: after.filterCond || '', sort: after.sort || '' } },
          expect: { name: after.name, type: 'LIST', fields: [...after.fields], filterCond: after.filterCond || '', sort: after.sort || '' },
          summary: `＋ 一覧「${after.name}」（表示 ${after.fields.join(', ')}${after.filterCond ? `・絞り込み ${after.filterCond}` : ''}${after.sort ? `・並び順 ${after.sort}` : ''}）`,
        };
      },
      async apply({ api, appId }, p) {
        const cur = await api.getPreviewViews(appId);
        const existing = cur?.views && typeof cur.views === 'object' ? cur.views : {};
        if (existing[p.expect.name]) throw Object.assign(new Error(`一覧「${p.expect.name}」は既に存在します`), { code: 'TARGET_EXISTS' });
        const maxIndex = Object.values(existing).reduce((m, v) => Math.max(m, Number(v?.index ?? -1)), -1);
        const views = {};
        for (const [name, v] of Object.entries(existing)) { const { id, ...rest } = v || {}; views[name] = rest; }   // id は応答プロパティ。builtinType（作業者が自分）は保持
        views[p.expect.name] = { ...p.payload.view, index: String(maxIndex + 1) };
        const res = await api.putPreviewViews(appId, views, String(cur?.revision ?? ''));
        return { revision: String(res?.revision ?? ''), requests: [{ method: 'PUT', path: '/k/v1/preview/app/views.json', existingViews: Object.keys(existing).length, totalViews: Object.keys(views).length }] };
      },
      async verify({ api, appId, snapshot }, p) {
        const cur = await api.getPreviewViews(appId);
        const v = cur?.views?.[p.expect.name];
        const checks = [];
        const check = (name, ok, expected, actual) => checks.push({ name, ok, expected, actual });
        check('exists', !!v, true, !!v);
        if (v) {
          check('type', v.type === 'LIST', 'LIST', v.type);
          check('fields', same(v.fields || [], p.expect.fields), p.expect.fields, v.fields || []);
          check('filterCond', String(v.filterCond || '') === p.expect.filterCond, p.expect.filterCond, String(v.filterCond || ''));
          check('sort', String(v.sort || '') === p.expect.sort, p.expect.sort, String(v.sort || ''));
        }
        const beforeNames = Object.keys(snapshot?.views?.views || {});
        const lost = beforeNames.filter(n => !cur?.views?.[n]);
        check('existingViewsPreserved', lost.length === 0, beforeNames.length, beforeNames.length - lost.length);
        return { ok: checks.every(c => c.ok), checks, revision: String(cur?.revision ?? '') };
      },
      rollback({ appId, snapshot }, p) {
        return { actionType: 'RESTORE_VIEWS', target: p.expect.name, api: { method: 'PUT', path: '/k/v1/preview/app/views.json', payload: { app: appId, views: '<snapshot.views.views（id を除く）>' } }, note: `snapshot の一覧設定（${Object.keys(snapshot?.views?.views || {}).length} 件）を PUT で戻す（追加した「${p.expect.name}」が消える）` };
      },
    };

    function layoutHasCode(rows, code) {
      for (const row of rows || []) {
        for (const f of row?.fields || []) if (f?.code === code) return true;
        if (Array.isArray(row?.layout) && layoutHasCode(row.layout, code)) return true;
      }
      return false;
    }
    /** 行の比較用（size は kintone が補正することがあるので code / type だけ） */
    const stripLayoutRow = (row) => row ? { type: row.type, code: row.code ?? null, fields: (row.fields || []).map(f => ({ type: f.type, code: f.code ?? null, elementId: f.elementId ?? null })), layout: Array.isArray(row.layout) ? row.layout.map(stripLayoutRow) : null } : null;

    // ================= preview の設定 → Review の Before と同じ形（stale 判定・再検証・再解析に使う）=================
    function previewDataFrom({ fields, layout, views }, base = null) {
      return {
        ...(base && typeof base === 'object' ? base : {}),
        appId: base?.appId ?? null,
        fields: fields?.properties || {},
        layout: Array.isArray(layout?.layout) ? layout.layout : [],
        views: views || null,
      };
    }
    const fieldKey = (f) => ({ type: f.type, label: f.label, required: !!f.required, ...(f.options ? { options: f.options } : {}), ...(f.lookup ? { lookup: f.lookup } : {}) });
    /** システムフィールド（JS API と REST で有無・表現が揺れることがあり、利用者が変更できない）は stale 判定の対象外 */
    const SYSTEM_FIELD_TYPES = ['RECORD_NUMBER', 'CREATOR', 'CREATED_TIME', 'MODIFIER', 'UPDATED_TIME', 'STATUS', 'STATUS_ASSIGNEE', 'CATEGORY'];
    const isSystemField = (f) => !!f && SYSTEM_FIELD_TYPES.includes(f.type);
    const viewKey = (v) => ({ type: v.type, fields: v.fields, filterCond: v.filterCond, sort: v.sort });
    /** Review 時点の Before と現在の preview の差（stale 判定）。kinds は比較対象 */
    function diffBefore(before, current, { kinds = ['fields', 'views'] } = {}) {
      const diffs = [];
      if (kinds.includes('fields')) {
        for (const [code, f] of Object.entries(before.fields || {})) {
          if (isSystemField(f)) continue;
          const c = current.fields?.[code];
          if (!c) diffs.push({ kind: 'FIELD', id: code, change: 'REMOVED', message: `フィールド「${f.label}」（${code}）が動作テスト環境にありません` });
          else if (!same(fieldKey(f), fieldKey(c))) diffs.push({ kind: 'FIELD', id: code, change: 'CHANGED', message: `フィールド「${f.label}」（${code}）の設定が Review 時点と違います`, before: fieldKey(f), after: fieldKey(c) });
        }
        for (const [code, c] of Object.entries(current.fields || {})) if (!before.fields?.[code] && !isSystemField(c)) diffs.push({ kind: 'FIELD', id: code, change: 'ADDED', message: `動作テスト環境にフィールド「${c.label}」（${code}）が追加されています（未反映の変更）` });
      }
      if (kinds.includes('views')) {
        const bv = new Map((before.views || []).map(v => [v.name, v])), cv = new Map((current.views || []).map(v => [v.name, v]));
        for (const [name, v] of bv) { const c = cv.get(name); if (!c) diffs.push({ kind: 'VIEW', id: name, change: 'REMOVED', message: `一覧「${name}」が動作テスト環境にありません` }); else if (!same(viewKey(v), viewKey(c))) diffs.push({ kind: 'VIEW', id: name, change: 'CHANGED', message: `一覧「${name}」の設定が Review 時点と違います`, before: viewKey(v), after: viewKey(c) }); }
        for (const [name] of cv) if (!bv.has(name)) diffs.push({ kind: 'VIEW', id: name, change: 'ADDED', message: `動作テスト環境に一覧「${name}」が追加されています（未反映の変更）` });
      }
      return diffs;
    }

    // ================= step の分類（API を呼ばない。UI の件数表示と prepare で共用）=================
    /** 承認 / Review の判定 / allowlist（capability ＋ handler の prepare）/ 依存 の順に、各 step を PENDING / SKIPPED / UNSUPPORTED / BLOCKED に分ける */
    function classifySteps({ plan, review, approvedSteps = [] } = {}) {
      const steps = Array.isArray(plan?.steps) ? plan.steps : [];
      const approved = [...new Set(Array.isArray(approvedSteps) ? approvedSteps : [])];
      const byId = new Map(steps.map(s => [s.id, s]));
      const rv = new Map((review?.steps || []).map(r => [r.stepId, r]));
      const order = Array.isArray(review?.simulation?.order) && review.simulation.order.length ? review.simulation.order : steps.map(s => s.id);
      const states = new Map();
      for (const id of order) {
        const step = byId.get(id); const r = rv.get(id);
        if (!step) continue;
        const cap = ACTION_CAPABILITIES[step.actionType] || null;
        const st = { stepId: id, actionType: step.actionType, title: step.title || '', status: STEP.PENDING, reason: null, message: '', dependsOn: [...(step.dependsOn || [])], capability: cap ? { previewExecute: cap.previewExecute, verify: cap.verify, rollbackStrategy: cap.rollbackStrategy, productionDeploy: false } : null, review: r ? { status: r.status, safety: r.safety } : null, approved: approved.includes(id), prepared: null };
        const set = (status, reason, message) => { st.status = status; st.reason = reason; st.message = message; };
        if (!st.approved) set(STEP.SKIPPED, 'NOT_APPROVED', '承認されていません');
        else if (!r) set(STEP.BLOCKED, 'NO_REVIEW', 'Review の結果がありません');
        else if (r.status === KTPlanReview.STATUS.INVALID || r.status === KTPlanReview.STATUS.BLOCKED_BY_DEPENDENCY || r.safety === KTPlanReview.SAFETY.BLOCKED) set(STEP.BLOCKED, 'REVIEW_BLOCKED', 'Review で実行不可と判定されています');
        else if (r.safety === KTPlanReview.SAFETY.PLAN_ONLY) set(STEP.UNSUPPORTED, 'PLAN_ONLY', '計画のみ（自動反映の対象外）');
        else if (!cap || !cap.previewExecute || !HANDLERS[step.actionType]) set(STEP.UNSUPPORTED, 'PREVIEW_NOT_SUPPORTED', '現在の Executor では自動反映できません');
        else {
          const p = HANDLERS[step.actionType].prepare(step, { stepReview: r, plan });
          if (p.unsupported) set(STEP.UNSUPPORTED, p.unsupported, p.message);
          else st.prepared = p;
        }
        states.set(id, st);
      }
      // 依存: 依存先が実行されない（SKIPPED / UNSUPPORTED / BLOCKED）なら BLOCKED
      for (const st of states.values()) {
        if (st.status !== STEP.PENDING) continue;
        const bad = st.dependsOn.filter(d => { const ds = states.get(d); return !ds || ds.status !== STEP.PENDING; });
        if (bad.length) { st.status = STEP.BLOCKED; st.reason = 'DEPENDENCY_NOT_EXECUTABLE'; st.message = `依存する ${bad.join(', ')} が実行されないため反映できません`; }
      }
      return [...states.values()];
    }

    // ================= prepare =================
    /**
     * @param {object} input executorOutput() の { plan, review, approvedSteps }（review は simulation.before / after を含んでよい）
     * @param {object} o { api, appId, now?, data? (再解析用の運用環境 DATA), layoutPolicy? ('APPEND_ROW' | 'NONE') }
     */
    async function prepare(input, { api, appId, now = Date.now, layoutPolicy = 'APPEND_ROW' } = {}) {
      const plan = input?.plan, review = input?.review;
      const approved = Array.isArray(input?.approvedSteps) ? [...new Set(input.approvedSteps)] : [];
      const prepared = {
        executorVersion: EXECUTOR_VERSION, executionId: newId('ex'), appId: String(appId ?? ''), env: ENV, preparedAt: nowIso(now),
        status: RUN.PREPARED, blockers: [], stale: { status: 'FRESH', diffs: [] }, revision: { production: null, preview: null, reviewed: null },
        steps: [], snapshot: null, temporaryIdMap: {}, summary: { executable: 0, unsupported: 0, blocked: 0, skipped: 0 }, layoutPolicy,
      };
      const block = (code, message, detail = null) => { prepared.blockers.push({ code, message, ...(detail ? { detail } : {}) }); prepared.status = RUN.BLOCKED; };
      if (!plan || !Array.isArray(plan.steps) || !review || !Array.isArray(review.steps)) { block('INVALID_INPUT', 'plan / review がありません（executorOutput の形で渡してください）'); return prepared; }
      if (String(review.reviewVersion) !== '1') { block('UNSUPPORTED_REVIEW_VERSION', `reviewVersion ${review.reviewVersion} は未対応です`); return prepared; }
      if (!prepared.appId) { block('APP_ID_MISSING', 'アプリ ID がありません'); return prepared; }
      const before = review.simulation?.before || null;
      if (!before) { block('NO_BEFORE_MODEL', 'Review に Before モデルがありません（古い Review。計画を作り直してください）'); return prepared; }

      // ---- 1. step の分類（承認 / Review の判定 / allowlist / 依存）----
      const rv = new Map(review.steps.map(r => [r.stepId, r]));
      prepared.steps = classifySteps({ plan, review, approvedSteps: approved });
      for (const st of prepared.steps) if (st.prepared?.temporaryId) prepared.temporaryIdMap[st.prepared.temporaryId] = st.prepared.expect.code;
      const summarize = () => { prepared.summary = { executable: prepared.steps.filter(s => s.status === STEP.PENDING).length, unsupported: prepared.steps.filter(s => s.status === STEP.UNSUPPORTED).length, blocked: prepared.steps.filter(s => s.status === STEP.BLOCKED).length, skipped: prepared.steps.filter(s => s.status === STEP.SKIPPED).length }; };
      const pending = prepared.steps.filter(s => s.status === STEP.PENDING);
      if (!pending.length) { block('NOTHING_TO_EXECUTE', '承認済みで実行できる step がありません'); summarize(); return prepared; }

      // ---- 2. 現在の設定（動作テスト環境）と revision を取得（アプリ管理権限が無ければここで止まる）----
      let fields, layout, views, prodViews;
      try {
        [fields, layout, views, prodViews] = await Promise.all([api.getPreviewFields(prepared.appId), api.getPreviewLayout(prepared.appId), api.getPreviewViews(prepared.appId), api.getProductionViews(prepared.appId)]);
      } catch (e) {
        const s = strErr(e);
        if (isPermissionError(e)) block('PERMISSION_DENIED', 'このユーザーにはアプリ設定を変更する権限がありません（動作テスト環境の設定を取得できませんでした）', s);
        else block('FETCH_FAILED', `現在の設定を取得できませんでした: ${s.message}`, s);
        summarize(); return prepared;
      }
      prepared.snapshot = { takenAt: nowIso(now), revision: String(fields?.revision ?? ''), fields: clone(fields), layout: clone(layout), views: clone(views) };
      prepared.revision = { production: prodViews?.revision != null ? String(prodViews.revision) : null, preview: fields?.revision != null ? String(fields.revision) : null, reviewed: before.revision != null ? String(before.revision) : null };

      // ---- 3. stale 判定（Review 時点との差異があれば止める。古い計画を当て直さない）----
      const currentModel = KTPlanReview.buildBeforeModel(previewDataFrom({ fields, layout, views }, { appId: prepared.appId }));
      const diffs = diffBefore(before, currentModel);
      if (prepared.revision.reviewed && prepared.revision.production && prepared.revision.reviewed !== prepared.revision.production) diffs.unshift({ kind: 'APP', id: 'revision', change: 'CHANGED', message: `運用環境の設定が Review 後に変更されています（revision ${prepared.revision.reviewed} → ${prepared.revision.production}）` });
      prepared.stale = { status: diffs.length ? 'STALE' : 'FRESH', diffs };
      if (diffs.length) block('STALE_PLAN', '計画作成後にアプリ設定が変更されています。再レビューしてください。', { count: diffs.length });

      // ---- 4. 実行直前の再検証（同じ決定的エンジンを動作テスト環境の設定で再実行し、期待する結果が変わっていないことを確かめる）----
      if (prepared.status === RUN.PREPARED) {
        let re = null;
        try { re = KTPlanReview.review({ plan, data: previewDataFrom({ fields, layout, views }, { appId: prepared.appId }) }); } catch (e) { block('REVALIDATION_ERROR', `再検証に失敗しました: ${strErr(e).message}`); }
        if (re) {
          const reMap = new Map(re.steps.map(r => [r.stepId, r]));
          for (const st of pending) {
            const r0 = rv.get(st.stepId), r1 = reMap.get(st.stepId);
            const bad = !r1 || r1.status === KTPlanReview.STATUS.INVALID || r1.status === KTPlanReview.STATUS.BLOCKED_BY_DEPENDENCY || r1.safety === KTPlanReview.SAFETY.BLOCKED;
            const changed = !bad && !same(r0?.diff?.after, r1?.diff?.after);
            if (bad || changed) { st.status = STEP.BLOCKED; st.reason = 'REVALIDATION_FAILED'; st.message = bad ? `再検証で実行不可（${(r1?.issues || []).map(i => i.code).join(', ') || '不明'}）` : '再検証の結果が Review 時点と異なります'; }
          }
          if (!prepared.steps.some(s => s.status === STEP.PENDING)) block('REVALIDATION_FAILED', '再検証で実行できる step が無くなりました');
        }
      }
      summarize();
      return prepared;
    }

    // ================= executePreview =================
    /** 承認済み・実行可能な step を dependsOn 順に動作テスト環境へ反映し、1 step ごとに再取得して検証する。失敗したら以降を止める（Fail Stop） */
    async function executePreview(prepared, { api, now = Date.now, onProgress = null, review = null, data = null } = {}) {
      if (!prepared || prepared.status !== RUN.PREPARED) throw Object.assign(new Error('prepare が完了していない、または実行できない状態です'), { code: 'NOT_PREPARED' });
      if (prepared.executed) throw Object.assign(new Error('この prepare は既に実行されています（二重実行の防止。やり直すには prepare からやり直してください）'), { code: 'ALREADY_EXECUTED' });
      prepared.executed = true;
      const log = {
        executorVersion: EXECUTOR_VERSION, executionId: prepared.executionId, appId: prepared.appId, env: ENV, startedAt: nowIso(now), finishedAt: null,
        beforeRevision: prepared.revision.preview, afterRevision: null, status: RUN.RUNNING, steps: [], simulation: null, reanalysis: null, snapshot: prepared.snapshot,
      };
      const progress = (st) => { if (typeof onProgress === 'function') { try { onProgress(clone(st), clone(log)); } catch (e) { } } };
      const yieldUi = () => new Promise(r => setTimeout(r, 0));
      const stepLogs = new Map();
      for (const st of prepared.steps) { const l = { stepId: st.stepId, actionType: st.actionType, title: st.title, status: st.status === STEP.PENDING ? STEP.PENDING : st.status, reason: st.reason, message: st.message, summary: st.prepared?.summary || '', requests: [], revision: null, verification: null, error: null }; stepLogs.set(st.stepId, l); log.steps.push(l); }
      let revision = prepared.revision.preview;
      let failed = false;
      for (const st of prepared.steps) {
        const l = stepLogs.get(st.stepId);
        if (st.status !== STEP.PENDING) { progress(l); continue; }
        if (failed) { l.status = STEP.SKIPPED; l.reason = 'STOPPED_AFTER_FAILURE'; l.message = '前の step が失敗したため実行していません'; progress(l); continue; }
        const depsOk = st.dependsOn.every(d => { const dl = stepLogs.get(d); return !dl || dl.status === STEP.VERIFIED; });
        if (!depsOk) { l.status = STEP.SKIPPED; l.reason = 'DEPENDENCY_NOT_VERIFIED'; l.message = '依存する step が検証済みでないため実行していません'; progress(l); continue; }
        l.status = STEP.RUNNING; progress(l); await yieldUi();
        const handler = HANDLERS[st.actionType];
        const ctx = { api, appId: prepared.appId, revision, snapshot: prepared.snapshot, layoutPolicy: prepared.layoutPolicy };
        try {
          const applied = await handler.apply(ctx, st.prepared);
          l.requests = applied.requests || []; l.revision = applied.revision || null; revision = applied.revision || revision;
          l.status = STEP.APPLIED; progress(l); await yieldUi();
          const v = await handler.verify(ctx, st.prepared, applied);
          l.verification = v; if (v.revision) revision = v.revision;
          l.status = v.ok ? STEP.VERIFIED : STEP.VERIFY_FAILED;
          if (!v.ok) { l.reason = 'VERIFY_FAILED'; l.message = `API は成功しましたが、再取得した設定が期待と一致しません（${v.checks.filter(c => !c.ok).map(c => c.name).join(', ')}）`; failed = true; }
        } catch (e) {
          const s = strErr(e);
          l.status = STEP.FAILED; l.error = s; failed = true;
          l.reason = isPermissionError(e) ? 'PERMISSION_DENIED' : isRevisionError(e) ? 'REVISION_MISMATCH' : s.code === 'TARGET_EXISTS' ? 'TARGET_EXISTS' : 'API_ERROR';
          l.message = l.reason === 'PERMISSION_DENIED' ? 'アプリ設定を変更する権限がありません' : l.reason === 'REVISION_MISMATCH' ? '実行中に他の変更が入りました（revision 不一致）。再レビューしてください' : s.message;
        }
        progress(l); await yieldUi();
      }
      log.afterRevision = revision;
      const verified = log.steps.filter(s => s.status === STEP.VERIFIED).length;
      const bad = log.steps.filter(s => s.status === STEP.FAILED || s.status === STEP.VERIFY_FAILED).length;
      log.status = bad ? (verified ? RUN.PARTIAL : RUN.FAILED) : RUN.DONE;
      // ---- 反映後の再取得 → Simulation との比較・再解析 ----
      try {
        const [fields, layout, views] = await Promise.all([api.getPreviewFields(prepared.appId), api.getPreviewLayout(prepared.appId), api.getPreviewViews(prepared.appId)]);
        log.afterRevision = String(fields?.revision ?? log.afterRevision ?? '');
        const previewData = previewDataFrom({ fields, layout, views }, data && typeof data === 'object' ? { ...data, appId: prepared.appId } : { appId: prepared.appId });
        const actual = KTPlanReview.buildBeforeModel(previewData);
        log.simulation = compareSimulation(review?.simulation?.after || null, actual, log.steps, prepared);
        log.reanalysis = reanalyze(previewData, data, log.steps, prepared);
        log.actualAfter = { fieldCount: Object.keys(actual.fields).length, views: actual.views.length, addedFields: log.steps.filter(s => s.actionType === 'ADD_FIELD' && s.status === STEP.VERIFIED).map(s => stepLogTarget(s, prepared)), addedViews: log.steps.filter(s => s.actionType === 'ADD_VIEW' && s.status === STEP.VERIFIED).map(s => stepLogTarget(s, prepared)) };
      } catch (e) { log.simulation = { compared: false, match: null, mismatches: [], error: strErr(e).message }; }
      log.finishedAt = nowIso(now);
      return log;
    }
    const stepLogTarget = (s, prepared) => prepared.steps.find(x => x.stepId === s.stepId)?.prepared?.expect?.code || prepared.steps.find(x => x.stepId === s.stepId)?.prepared?.expect?.name || null;

    /** Simulation After（Review が仮適用したモデル）と実際の After を、実行した対象だけ比較する */
    function compareSimulation(simAfter, actual, stepLogs, prepared) {
      if (!simAfter) return { compared: false, match: null, mismatches: [], note: 'Review の After モデルが無いため比較していません' };
      const mismatches = [];
      for (const s of stepLogs) {
        if (s.status !== STEP.VERIFIED) continue;
        const expect = prepared?.steps?.find(x => x.stepId === s.stepId)?.prepared?.expect || null;
        if (s.actionType === 'ADD_FIELD') {
          const code = expect?.code;
          const sim = simAfter.fields?.[code], act = actual.fields?.[code];
          if (!sim || !act) { mismatches.push({ stepId: s.stepId, kind: 'FIELD', id: code, message: sim ? '実際の設定に追加したフィールドがありません' : 'Simulation に該当フィールドがありません' }); continue; }
          const a = fieldKey(sim), b = fieldKey(act);
          if (!same(a, b)) mismatches.push({ stepId: s.stepId, kind: 'FIELD', id: code, message: 'Simulation と実際の設定が一致しません', simulation: a, actual: b });
        } else if (s.actionType === 'ADD_VIEW') {
          const name = expect?.name || null;
          const sim = (simAfter.views || []).find(v => v.origin === 'proposed' && v.stepId === s.stepId) || (name ? (simAfter.views || []).find(v => v.name === name) : null) || null;
          const act = sim ? (actual.views || []).find(v => v.name === sim.name) : null;
          if (!sim || !act) { mismatches.push({ stepId: s.stepId, kind: 'VIEW', id: sim?.name || name, message: sim ? '実際の設定に追加した一覧がありません' : 'Simulation に該当一覧がありません' }); continue; }
          const a = viewKey(sim), b = viewKey(act);
          if (!same(a, b)) mismatches.push({ stepId: s.stepId, kind: 'VIEW', id: sim.name, message: 'Simulation と実際の設定が一致しません', simulation: a, actual: b });
        }
      }
      return { compared: true, match: mismatches.length === 0, mismatches, ...(mismatches.length ? { code: 'SIMULATION_MISMATCH' } : {}) };
    }

    /** 反映後の再解析（可能な範囲）: preview の fields / layout / views ＋ 運用環境のその他設定で DEPS を作り直し、追加フィールドの参照・壊れた参照を数える */
    function reanalyze(previewData, baseData, stepLogs, prepared) {
      const out = { available: false, before: null, after: null, addedFields: [] };
      if (!KTDeps || typeof KTDeps.buildDependencyData !== 'function') return out;
      const safe = (fn, fb) => { try { return fn(); } catch (e) { return fb; } };
      const build = (d) => safe(() => { const fieldsN = KTDeps.normalizeFields(d?.fields || {}); const deps = KTDeps.buildDependencyData(d, fieldsN); return { deps, fields: fieldsN.length, edges: Array.isArray(deps?.edges) ? deps.edges.length : 0, broken: safe(() => KTDeps.findBrokenRefs(deps).length, null) }; }, null);
      const after = build(previewData);
      const before = baseData ? build(baseData) : null;
      if (!after) return out;
      out.available = true;
      out.before = before ? { fields: before.fields, edges: before.edges, brokenRefs: before.broken } : null;
      out.after = { fields: after.fields, edges: after.edges, brokenRefs: after.broken };
      for (const s of stepLogs) {
        if (s.actionType !== 'ADD_FIELD' || s.status !== STEP.VERIFIED) continue;
        const code = prepared.steps.find(x => x.stepId === s.stepId)?.prepared?.expect?.code;
        if (!code) continue;
        const impact = safe(() => KTDeps.impactOf(after.deps, code), null);
        out.addedFields.push({ code, directRefs: impact ? (impact.direct || []).length : null, indirectRefs: impact ? (impact.indirect || []).length : null });
      }
      return out;
    }

    // ================= rollback（計画のみ。実行しない）=================
    function buildRollbackPlan(execution, prepared) {
      const steps = [];
      for (const s of [...(execution?.steps || [])].reverse()) {
        if (![STEP.APPLIED, STEP.VERIFIED, STEP.VERIFY_FAILED].includes(s.status)) continue;
        const st = prepared?.steps?.find(x => x.stepId === s.stepId);
        const handler = HANDLERS[s.actionType];
        if (!st?.prepared || !handler) continue;
        steps.push({ stepId: s.stepId, ...handler.rollback({ appId: execution.appId, snapshot: execution.snapshot }, st.prepared) });
      }
      return { rollbackVersion: '1', executionId: execution?.executionId ?? null, appId: execution?.appId ?? null, env: ENV, executed: false, snapshotRevision: execution?.snapshot?.revision ?? null, steps, note: 'このロールバック計画は実行されません（Phase 9 は計画の生成まで）。snapshot は実行前の動作テスト環境の設定です' };
    }

    // ================= 監査用 JSON =================
    function buildAudit({ goal = null, plan = null, review = null, decisions = null, prepared = null, execution = null } = {}) {
      const rv = review ? { ...review, simulation: review.simulation ? { before: review.simulation.before ?? null, process: review.simulation.process ?? null } : null } : null;
      return {
        auditVersion: '1', generatedAt: new Date().toISOString(),
        goal: goal ?? plan?.goal ?? null,
        plan: plan ? (KTContextUi.planJson ? KTContextUi.planJson(plan) : plan) : null,
        review: rv,
        humanDecisions: decisions ? (typeof decisions.entries === 'function' && typeof decisions.get === 'function' ? Object.fromEntries(decisions.entries()) : decisions) : {},   // Map（別 realm でも可）か plain object
        execution: execution ? { ...execution, snapshot: undefined } : (prepared ? { executionId: prepared.executionId, appId: prepared.appId, env: ENV, status: prepared.status, blockers: prepared.blockers, stale: prepared.stale, steps: prepared.steps.map(s => ({ stepId: s.stepId, actionType: s.actionType, status: s.status, reason: s.reason })) } : null),
        verification: execution ? execution.steps.map(s => ({ stepId: s.stepId, status: s.status, verification: s.verification })) : null,
        beforeSnapshot: execution?.snapshot ?? prepared?.snapshot ?? null,
        actualAfter: execution?.actualAfter ?? null,
        simulation: execution?.simulation ?? null,
        reanalysis: execution?.reanalysis ?? null,
        rollbackPlan: execution && prepared ? buildRollbackPlan(execution, prepared) : null,
      };
    }

    // ================= kintone API adapter（セッション認証。Toolkit を使っているユーザーの権限で実行）=================
    function createKintoneApi({ kintoneApi = (typeof kintone !== 'undefined' ? kintone : null) } = {}) {
      if (!kintoneApi) throw new Error('kintone API がありません');
      const url = (p) => kintoneApi.api.url(p, true);
      const call = (p, method, body) => kintoneApi.api(url(p), method, body);
      const app = (a) => Number(a);
      return {
        getPreviewFields: (a) => call('/k/v1/preview/app/form/fields.json', 'GET', { app: app(a) }),
        getPreviewLayout: (a) => call('/k/v1/preview/app/form/layout.json', 'GET', { app: app(a) }),
        getPreviewViews: (a) => call('/k/v1/preview/app/views.json', 'GET', { app: app(a) }),
        getProductionViews: (a) => call('/k/v1/app/views.json', 'GET', { app: app(a) }),
        addPreviewFields: (a, properties, revision) => call('/k/v1/preview/app/form/fields.json', 'POST', { app: app(a), properties, ...(revision ? { revision } : {}) }),
        putPreviewLayout: (a, layout, revision) => call('/k/v1/preview/app/form/layout.json', 'PUT', { app: app(a), layout, ...(revision ? { revision } : {}) }),
        putPreviewViews: (a, views, revision) => call('/k/v1/preview/app/views.json', 'PUT', { app: app(a), views, ...(revision ? { revision } : {}) }),
        // 運用環境へ反映する関数は意図的に無い（Phase 9: Preview only）
      };
    }

    return {
      EXECUTOR_VERSION, ENV, STEP, RUN, PREVIEW_FIELD_TYPES, ACTION_CAPABILITIES, HANDLERS,
      classifySteps, prepare, executePreview, buildRollbackPlan, buildAudit, compareSimulation, diffBefore, previewDataFrom, layoutHasCode, createKintoneApi,
    };
  })();

  // ==========================================
  // 3.7 Nest Rec AI Gateway クライアント (KTAiClient)
  //   有料機能「AIに質問」の通信層。AppInsight の src/desktop/ai/ai-client.js と同じ設計
  //   （kintone.proxy 優先・fetch フォールバック・timeout は AbortController で中断・エラーは
  //   { code, message, httpStatus, details, retryAfterSeconds } へ正規化）。将来 AppInsight と共通化する前提で、
  //   Toolkit 固有なのは envelope（product toolkit / feature assistant-qa / payload = KTContext）と
  //   応答の根拠ID 再検証だけに留める。
  //   クライアントに置かないもの: API キー・Worker secret・model 名・system prompt。
  //   credential（Phase 5 / docs/contracts/14-ai-access-token.md）:
  //     Customer Token（長寿命・契約証明）は「接続」時に 1 回だけ入力し、POST /v2/token/exchange で
  //     短命 Access Token（memory のみ）＋ Refresh Token（localStorage・単回使用・rotation・scope 限定）に交換して捨てる。
  //     /v2 の呼び出しは Access Token で行い、期限切れは Refresh で自動更新する。Customer Token は保存しない。
  //     （kintone 同一オリジンの他 JavaScript は localStorage を読めるため、永続化するのは権限と寿命が小さい Refresh Token だけ）
  // ==========================================
  const KTAiClient = (() => {
    const CONTRACT_VERSION = '2.1';
    const PRODUCT = 'toolkit';
    const FEATURE = 'assistant-qa';
    const FEATURE_PLANNER = 'change-planner';          // Phase 7: AI Change Planner（Gateway の別 feature）
    const FEATURES = [FEATURE, FEATURE_PLANNER];        // 接続（exchange / connect）で要求する scope。許可された交差が付与される
    const PROMPT_VERSION = '1';
    const PLANNER_PROMPT_VERSION = '1';
    /** 公開エンドポイント（secret ではない）。設定で上書きできる */
    const DEFAULT_API_BASE = 'https://appinsight-ai-api.black-waterfall-157a.workers.dev';
    const SETTINGS_KEY = 'ktAi.v1';          // 旧: Customer Token を保存していた（staging E2E 用。見つけたら 1 回だけ exchange して削除）
    const SESSION_KEY = 'ktAi.v2';           // 新: Refresh Token と scope のみ
    const CONSENT_KEY = 'ktAiConsent.v1';
    const HEALTH_TTL_MS = 10 * 60 * 1000;
    const ACCESS_SKEW_MS = 60 * 1000;         // 期限の 60 秒前から更新する

    /** Gateway の error.code（docs/contracts/12 §7・13 §5）＋ client 側の正規化 code */
    const ERROR_CODES = {
      AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN', AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED', AUTH_DOMAIN_MISMATCH: 'AUTH_DOMAIN_MISMATCH',
      PRODUCT_NOT_ENTITLED: 'PRODUCT_NOT_ENTITLED', FEATURE_NOT_ENTITLED: 'FEATURE_NOT_ENTITLED', FEATURE_NOT_IMPLEMENTED: 'FEATURE_NOT_IMPLEMENTED',
      RATE_LIMITED: 'RATE_LIMITED', MONTHLY_LIMIT_EXCEEDED: 'MONTHLY_LIMIT_EXCEEDED',
      UNSUPPORTED_CONTRACT_VERSION: 'UNSUPPORTED_CONTRACT_VERSION', UNKNOWN_PROMPT_VERSION: 'UNKNOWN_PROMPT_VERSION',
      INVALID_ENVELOPE: 'INVALID_ENVELOPE', INVALID_CONTEXT: 'INVALID_CONTEXT', PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
      UPSTREAM_ERROR: 'UPSTREAM_ERROR', MODEL_OUTPUT_INVALID: 'MODEL_OUTPUT_INVALID', INTERNAL_ERROR: 'INTERNAL_ERROR',
      // client 側のみ
      TRANSPORT_ERROR: 'TRANSPORT_ERROR', TIMEOUT: 'TIMEOUT', INVALID_RESPONSE: 'INVALID_RESPONSE', WORKER_ERROR: 'WORKER_ERROR',
      NO_CONFIG: 'NO_CONFIG', NOT_ENTITLED: 'NOT_ENTITLED', CONTRACT_INCOMPATIBLE: 'CONTRACT_INCOMPATIBLE', NO_CONTEXT: 'NO_CONTEXT', PLANNER_NOT_AVAILABLE: 'PLANNER_NOT_AVAILABLE',
      NOT_CONNECTED: 'NOT_CONNECTED', SESSION_EXPIRED: 'SESSION_EXPIRED',
      // tokenless connect（Browser Authorization Session）
      CONNECT_DENIED: 'CONNECT_DENIED', CONNECT_EXPIRED: 'CONNECT_EXPIRED', CONNECT_CANCELLED: 'CONNECT_CANCELLED', NOT_FOUND: 'NOT_FOUND',
    };
    /** ユーザー向け文言（AppInsight ai-review-ui.js の AI_ERROR_TEXT を Toolkit 向けに統合） */
    const ERROR_TEXT = {
      NO_CONFIG: 'AI 機能を利用するには Nest Rec AI の契約が必要です。「Nest Rec AIに接続」から接続してください。',
      NOT_CONNECTED: 'Nest Rec AI に接続されていません。「Nest Rec AIに接続」から接続してください。',
      SESSION_EXPIRED: 'Nest Rec AI との接続の有効期限が切れました。もう一度「Nest Rec AIに接続」してください。',
      NOT_ENTITLED: 'この契約では kintone App Toolkit の AI 機能を利用できません。契約内容を確認してください。',
      PRODUCT_NOT_ENTITLED: 'この契約では kintone App Toolkit の AI 機能を利用できません。契約内容を確認してください。',
      FEATURE_NOT_ENTITLED: 'この契約では「AIに質問」を利用できません。契約内容を確認してください。',
      PLANNER_NOT_AVAILABLE: 'この契約では「変更計画を作る」を利用できません。契約内容を確認してください。',
      CONNECT_DENIED: 'Nest Rec で接続がキャンセル（拒否）されました。',
      CONNECT_EXPIRED: '接続の確認が時間切れになりました。もう一度「Nest Rec AIに接続」してください。',
      CONNECT_CANCELLED: '接続をキャンセルしました。',
      NOT_FOUND: '接続セッションが見つかりません。もう一度「Nest Rec AIに接続」してください。',
      FEATURE_NOT_IMPLEMENTED: 'この機能は AI サービス側でまだ有効化されていません。',
      CONTRACT_INCOMPATIBLE: 'Toolkit と AI サービスのバージョンが一致しません。Toolkit の更新または AI サービスの更新をお待ちください。',
      UNSUPPORTED_CONTRACT_VERSION: 'Toolkit と AI サービスのバージョンが一致しません。Toolkit の更新が必要です。',
      UNKNOWN_PROMPT_VERSION: 'Toolkit と AI サービスのバージョンが一致しません。Toolkit の更新が必要です。',
      AUTH_INVALID_TOKEN: 'Nest Rec AI との接続が無効です。もう一度「Nest Rec AIに接続」してください。',
      AUTH_TOKEN_EXPIRED: 'Nest Rec AI との接続または契約の有効期限が切れています。もう一度「Nest Rec AIに接続」してください。',
      AUTH_DOMAIN_MISMATCH: 'この kintone 環境では AI サービスを利用できません。契約の対象ドメインを確認してください。',
      RATE_LIMITED: 'アクセスが集中しています。しばらく待ってから再実行してください。',
      MONTHLY_LIMIT_EXCEEDED: '今月の AI 利用回数の上限に達しています。',
      UPSTREAM_ERROR: 'AI プロバイダが応答しませんでした。時間をおいて再実行してください。',
      MODEL_OUTPUT_INVALID: 'AI の応答が契約形式を満たしませんでした。再実行しても解決しない場合はお問い合わせください。',
      INTERNAL_ERROR: 'AI サービス内部でエラーが発生しました。時間をおいて再実行してください。',
      TIMEOUT: 'AI サービスが時間内に応答しませんでした。時間をおいて再実行してください。',
      INVALID_RESPONSE: 'AI サービスの応答を解釈できませんでした。',
      INVALID_CONTEXT: '送信した解析データが AI サービスの検証を通りませんでした。Toolkit の更新が必要な可能性があります。',
      INVALID_ENVELOPE: '送信データの生成に失敗しました。',
      PAYLOAD_TOO_LARGE: '解析データが送信上限を超えています。対象を絞って再実行してください。',
      TRANSPORT_ERROR: 'ネットワークエラーが発生しました。通信環境を確認して再実行してください。',
      WORKER_ERROR: 'AI サービスでエラーが発生しました。',
      NO_CONTEXT: '先に「AI Prompt を生成」で Context を作成してください。',
    };
    const errorText = (code) => ERROR_TEXT[code] || 'AI への質問に失敗しました。';

    class AiClientError extends Error {
      constructor({ code, message, httpStatus = null, details = null, retryAfterSeconds = null, requestId = null }) {
        super(message || code);
        this.name = 'AiClientError';
        this.code = code; this.httpStatus = httpStatus; this.details = details;
        this.retryAfterSeconds = retryAfterSeconds; this.requestId = requestId;
      }
    }
    const isAiClientError = (e) => e instanceof AiClientError || (e && e.name === 'AiClientError' && typeof e.code === 'string');

    // ---- 設定（localStorage。token をコードに持たない）----
    function createSettingsStore({ storage = (typeof localStorage !== 'undefined' ? localStorage : null), host = (typeof location !== 'undefined' ? location.host : '') } = {}) {
      const legacyKey = `${SETTINGS_KEY}.${host}`;
      const key = `${SESSION_KEY}.${host}`;
      return {
        /** 接続情報（Refresh Token・scope・期限）。Customer Token / Access Token は含めない */
        load() {
          try {
            const raw = storage?.getItem(key); const j = raw ? JSON.parse(raw) : {};
            const attempt = j.refreshAttempt && typeof j.refreshAttempt.requestId === 'string' ? { requestId: j.refreshAttempt.requestId, at: j.refreshAttempt.at || null } : null;
            return {
              apiBase: String(j.apiBase || DEFAULT_API_BASE),
              refreshToken: String(j.refreshToken || ''), refreshExpiresAt: j.refreshExpiresAt || null,
              scope: j.scope || null, connectedAt: j.connectedAt || null,
              // 進行中（応答未受信）の refresh 要求（Phase 8.5）。再送に同じ requestId を使う。token ではない
              ...(attempt ? { refreshAttempt: attempt } : {}),
            };
          } catch (e) { return { apiBase: DEFAULT_API_BASE, refreshToken: '', refreshExpiresAt: null, scope: null, connectedAt: null }; }
        },
        save({ apiBase, refreshToken, refreshExpiresAt, scope, connectedAt, refreshAttempt = null }) {
          try {
            storage?.setItem(key, JSON.stringify({
              apiBase: String(apiBase || DEFAULT_API_BASE).trim().replace(/\/+$/, ''),
              refreshToken: String(refreshToken || ''), refreshExpiresAt: refreshExpiresAt || null, scope: scope || null, connectedAt: connectedAt || null,
              ...(refreshAttempt && refreshAttempt.requestId ? { refreshAttempt: { requestId: String(refreshAttempt.requestId), at: refreshAttempt.at || null } } : {}),
            }));
            return true;
          } catch (e) { return false; }
        },
        clear() { try { storage?.removeItem(key); } catch (e) { } },
        /** 旧形式（Customer Token を localStorage に保存）を 1 回だけ取り出して削除する（exchange に使う） */
        takeLegacyCustomerToken() {
          try {
            const raw = storage?.getItem(legacyKey); if (!raw) return null;
            const j = JSON.parse(raw); storage?.removeItem(legacyKey);
            return j?.customerToken ? { customerToken: String(j.customerToken), apiBase: String(j.apiBase || DEFAULT_API_BASE) } : null;
          } catch (e) { return null; }
        },
        hasConsent() { try { return storage?.getItem(`${CONSENT_KEY}.${host}`) === '1'; } catch (e) { return false; } },
        setConsent(on) { try { if (on) storage?.setItem(`${CONSENT_KEY}.${host}`, '1'); else storage?.removeItem(`${CONSENT_KEY}.${host}`); } catch (e) { } },
      };
    }

    // ---- transport（AppInsight と同じ: kintone.proxy 優先・fetch フォールバック・signal 対応）----
    function createDefaultTransport({ kintoneApi = (typeof kintone !== 'undefined' ? kintone : null), fetchFn = (typeof fetch !== 'undefined' ? fetch : null) } = {}) {
      return async ({ url, method, headers, body, signal = null }) => {
        if (kintoneApi && typeof kintoneApi.proxy === 'function') {
          const [respBody, status] = await kintoneApi.proxy(url, method, headers, body ?? '');
          return { status: Number(status), body: String(respBody ?? '') };
        }
        if (!fetchFn) throw new AiClientError({ code: ERROR_CODES.TRANSPORT_ERROR, message: '利用可能な transport がありません' });
        const resp = await fetchFn(url, { method, headers, body: body || undefined, ...(signal ? { signal } : {}) });
        return { status: resp.status, body: await resp.text() };
      };
    }

    /** Legacy（/v1 形式）エラー文字列の翻訳（AppInsight ai-client と同じ表）。未知は null */
    function normalizeLegacyErrorCode(message) {
      const m = String(message || '');
      if (m === 'Missing Bearer token' || m === 'Invalid token' || m === 'Token revoked' || m === 'Token expiry invalid') return ERROR_CODES.AUTH_INVALID_TOKEN;
      if (m === 'Token expired') return ERROR_CODES.AUTH_TOKEN_EXPIRED;
      if (m === 'Domain mismatch' || m === 'Token domain not set' || m === 'Missing X-Kintone-Domain header') return ERROR_CODES.AUTH_DOMAIN_MISMATCH;
      if (m === 'Monthly limit exceeded') return ERROR_CODES.MONTHLY_LIMIT_EXCEEDED;
      if (m === 'Rate limit exceeded') return ERROR_CODES.RATE_LIMITED;
      if (m === 'Payload too large') return ERROR_CODES.PAYLOAD_TOO_LARGE;
      return null;
    }

    const newRequestId = () => `tk-${(typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;

    /** Contract 2.1 の request envelope（payload は KTContext.build() の結果そのもの。作り直さない） */
    function buildAskEnvelope({ ctx, requestId = newRequestId(), pluginVersion = SCRIPT_VERSION, now = new Date().toISOString() }) {
      if (!ctx || typeof ctx !== 'object' || !Array.isArray(ctx.facts)) throw new AiClientError({ code: ERROR_CODES.NO_CONTEXT, message: 'KTContext がありません' });
      return {
        contractVersion: CONTRACT_VERSION,
        meta: {
          requestId, generatedAt: now,
          product: PRODUCT, feature: FEATURE, promptVersion: PROMPT_VERSION, contextVersion: String(ctx.contextVersion),
          plugin: { name: 'kintone App Toolkit', version: pluginVersion },
        },
        payload: ctx,
      };
    }

    /** feature 1 つの利用可否（entitlement → registry implemented → promptVersion） */
    function featureCapability(health, feature, promptVersion) {
      const ent = (Array.isArray(health.entitlements) ? health.entitlements : []).find(e => e?.product === PRODUCT);
      if (!ent || !(ent.features || []).includes(feature)) return { available: false, reason: ERROR_CODES.NOT_ENTITLED };
      const reg = health.registry?.[PRODUCT]?.[feature];
      if (!reg || reg.implemented !== true) return { available: false, reason: ERROR_CODES.FEATURE_NOT_IMPLEMENTED };
      if (!(reg.promptVersions || []).includes(promptVersion)) return { available: false, reason: ERROR_CODES.UNKNOWN_PROMPT_VERSION };
      return { available: true, reason: null };
    }
    /**
     * /v2/health → 利用可否。available / reason は assistant-qa（従来どおり）。features に feature ごとの可否
     * （change-planner は契約に含まれない場合もある。Q&A が使えても Planner は不可、ということがある）
     */
    function capabilityFromHealth(health) {
      if (!health || health.ok !== true) return { available: false, reason: ERROR_CODES.INVALID_RESPONSE };
      const versions = Array.isArray(health.supportedContractVersions) ? health.supportedContractVersions : [];
      if (!versions.includes(CONTRACT_VERSION)) return { available: false, reason: ERROR_CODES.CONTRACT_INCOMPATIBLE };
      const qa = featureCapability(health, FEATURE, PROMPT_VERSION);
      const planner = featureCapability(health, FEATURE_PLANNER, PLANNER_PROMPT_VERSION);
      const features = { [FEATURE]: qa, [FEATURE_PLANNER]: planner };
      if (!qa.available) return { available: false, reason: qa.reason, features, usage: health.usage ?? null };
      // contractExpiresAt（契約の期限。W5）。tokenExpiresAt は Access Token 認証では Access の期限なので契約の表示には使わない
      return { available: true, reason: null, features, usage: health.usage ?? null, tokenExpiresAt: health.tokenExpiresAt ?? null, contractExpiresAt: health.contractExpiresAt ?? null };
    }

    /** Contract 2.1 の request envelope（change-planner。payload は KTContext.buildPlan() の結果そのもの） */
    function buildPlanEnvelope({ ctx, requestId = newRequestId(), pluginVersion = SCRIPT_VERSION, now = new Date().toISOString() }) {
      if (!ctx || typeof ctx !== 'object' || !Array.isArray(ctx.facts) || typeof ctx.goal !== 'string') throw new AiClientError({ code: ERROR_CODES.NO_CONTEXT, message: 'Planner Context がありません' });
      return {
        contractVersion: CONTRACT_VERSION,
        meta: {
          requestId, generatedAt: now,
          product: PRODUCT, feature: FEATURE_PLANNER, promptVersion: PLANNER_PROMPT_VERSION, contextVersion: String(ctx.contextVersion),
          plugin: { name: 'kintone App Toolkit', version: pluginVersion },
        },
        payload: ctx,
      };
    }

    /**
     * Change Plan の応答を送信した Planner Context で再検証する（Worker の検証と二重。未知の根拠ID は除去、
     * 存在しない既存資産（dictionary に無い fieldCode / ステータス / 通知 / 一覧）への参照は invalid にして warnings に記録）
     * @returns {{ ok:boolean, errors:Array, warnings:Array, normalized:object|null }}
     */
    function validatePlan(response, ctx) {
      const errors = [], warnings = [];
      const r = response || {};
      if (r.ok !== true) { errors.push({ code: ERROR_CODES.INVALID_RESPONSE, path: 'ok', message: 'ok:true ではありません' }); return { ok: false, errors, warnings, normalized: null }; }
      if (r.contractVersion !== CONTRACT_VERSION) errors.push({ code: ERROR_CODES.UNSUPPORTED_CONTRACT_VERSION, path: 'contractVersion', message: `contractVersion が一致しません: ${r.contractVersion}` });
      const p = r.plan;
      if (!p || typeof p !== 'object' || typeof p.goal !== 'string' || !Array.isArray(p.steps) || !p.assessment) errors.push({ code: ERROR_CODES.INVALID_RESPONSE, path: 'plan', message: 'plan がありません' });
      if (errors.length) return { ok: false, errors, warnings, normalized: null };
      const known = new Set((ctx?.facts || []).map(x => x.id));
      const dict = ctx?.dictionary || {};
      const setOf = (k) => new Set(Array.isArray(dict[k]) ? dict[k] : []);
      const D = { FIELD: setOf('fieldCodes'), LOOKUP: setOf('fieldCodes'), FIELD_ACL: setOf('fieldCodes'), PROCESS_STATUS: setOf('statuses'), PROCESS_ACTION: setOf('processActions'), NOTIFICATION: setOf('notifications'), REMINDER: setOf('reminders'), VIEW: setOf('views'), REPORT: setOf('reports'), APP_ACTION: setOf('appActions'), JS: setOf('jsFiles') };
      const ids = (list, path) => { const kept = []; for (const id of Array.isArray(list) ? list : []) { if (known.has(id)) { if (!kept.includes(id)) kept.push(id); } else warnings.push({ code: 'UNKNOWN_EVIDENCE_REMOVED', path, message: `未知の根拠ID を除去しました: ${id}` }); } return kept; };
      const proposedIds = new Set((p.proposedFields || []).map(x => x.temporaryId));
      const addKinds = { ADD_FIELD: 'PROPOSED_FIELD', ADD_PROCESS_STATUS: 'PROCESS_STATUS', ADD_PROCESS_ACTION: 'PROCESS_ACTION', ADD_NOTIFICATION: 'NOTIFICATION', ADD_REMINDER: 'REMINDER', ADD_VIEW: 'VIEW', ADD_APP_ACTION: 'APP_ACTION' };
      const relevantFields = (p.relevantFields || []).filter(x => { const ok = D.FIELD.has(x.fieldCode); if (!ok) warnings.push({ code: 'HALLUCINATED_EXISTING_REMOVED', path: 'relevantFields', message: `存在しないフィールド「${x.fieldCode}」を除去しました` }); return ok; }).map(x => ({ ...x, evidenceIds: ids(x.evidenceIds, 'relevantFields') }));
      const assessment = { ...p.assessment, usableExistingFields: (p.assessment.usableExistingFields || []).filter(x => D.FIELD.has(x.fieldCode)).map(x => ({ ...x, evidenceIds: ids(x.evidenceIds, 'assessment') })), usableExistingSettings: (p.assessment.usableExistingSettings || []).map(x => ({ ...x, evidenceIds: ids(x.evidenceIds, 'assessment') })) };
      const proposedFields = (p.proposedFields || []).map((x, i) => ({ ...x, evidenceIds: ids(x.evidenceIds, `proposedFields[${i}]`), codeConflict: x.codeConflict || D.FIELD.has(x.suggestedCode), labelDuplicate: x.labelDuplicate || setOf('fieldLabels').has(x.label) }));
      const steps = (p.steps || []).map((st, i) => {
        const v = { status: st.validation?.status || 'ok', issues: [...(st.validation?.issues || [])] };
        if (st.targetKind === 'PROPOSED_FIELD') { if (!proposedIds.has(st.targetRef)) { v.status = 'invalid'; v.issues.push(`新規フィールド ${st.targetRef} が提案に無い`); } }
        else if (st.targetRef && D[st.targetKind] && !D[st.targetKind].has(st.targetRef) && addKinds[st.actionType] !== st.targetKind && !['REQUIRE_CONFIRMATION', 'CUSTOMIZATION_REQUIRED', 'UPDATE_PROCESS', 'UPDATE_RECORD_ACL'].includes(st.actionType)) {
          v.status = 'invalid'; v.issues.push(`存在しない${st.targetKind}「${st.targetRef}」を既存として参照`);
          warnings.push({ code: 'HALLUCINATED_EXISTING_STEP', path: `steps[${i}]`, message: `${st.id}: 存在しない${st.targetKind}「${st.targetRef}」を既存として参照しています` });
        }
        return { ...st, evidenceIds: ids(st.evidenceIds, `steps[${i}]`), dependsOn: Array.isArray(st.dependsOn) ? st.dependsOn : [], validation: v, execution: st.execution || { mode: 'PLAN_ONLY', supported: false, reason: 'Planner MVP では自動変更未実装' } };
      });
      const impact = (p.impact || []).map((x, i) => ({ ...x, evidenceIds: ids(x.evidenceIds, `impact[${i}]`) }));
      const questions = (p.questions || []).map((x, i) => ({ ...x, relatedEvidenceIds: ids(x.relatedEvidenceIds, `questions[${i}]`) }));
      return {
        ok: true, errors, warnings,
        normalized: {
          ...p, assessment, relevantFields, proposedFields, steps, impact, questions,
          requestId: r.meta?.requestId ?? null, usage: r.meta?.usage ?? null, ai: r.meta?.ai ?? null, gatewayWarnings: r.meta?.normalization?.warnings ?? [],
        },
      };
    }

    /**
     * 応答の根拠ID を送信した ctx.facts[].id で再検証する（Worker の検証と二重。未知 ID は除去して warnings に記録）
     * @returns {{ ok:boolean, errors:Array, warnings:Array, normalized:object|null }}
     */
    function validateAnswer(response, ctx) {
      const errors = [], warnings = [];
      const r = response || {};
      if (r.ok !== true) { errors.push({ code: ERROR_CODES.INVALID_RESPONSE, path: 'ok', message: 'ok:true ではありません' }); return { ok: false, errors, warnings, normalized: null }; }
      if (r.contractVersion !== CONTRACT_VERSION) errors.push({ code: ERROR_CODES.UNSUPPORTED_CONTRACT_VERSION, path: 'contractVersion', message: `contractVersion が一致しません: ${r.contractVersion}` });
      if (typeof r.answer !== 'string' || !r.answer.trim()) errors.push({ code: ERROR_CODES.INVALID_RESPONSE, path: 'answer', message: 'answer がありません' });
      const known = new Set((ctx?.facts || []).map(f => f.id));
      const filter = (ids, path) => {
        const kept = [];
        for (const id of Array.isArray(ids) ? ids : []) {
          if (known.has(id)) { if (!kept.includes(id)) kept.push(id); continue; }
          warnings.push({ code: 'UNKNOWN_EVIDENCE_REMOVED', path, message: `未知の根拠ID を除去しました: ${id}` });
        }
        return kept;
      };
      const items = (list, path) => (Array.isArray(list) ? list : []).filter(x => x && typeof x.text === 'string' && x.text.trim())
        .map((x, i) => ({ text: x.text, evidenceIds: filter(x.evidenceIds, `${path}[${i}]`) }));
      if (errors.length) return { ok: false, errors, warnings, normalized: null };
      const facts = [];
      const demoted = [];
      for (const f of items(r.facts, 'facts')) (f.evidenceIds.length ? facts : demoted).push(f);
      if (demoted.length) warnings.push({ code: 'UNGROUNDED_FACT_DEMOTED', path: 'facts', message: `根拠ID の無い事実 ${demoted.length} 件を分析へ移しました` });
      const answer = String(r.answer).replace(/\[((?:E[0-9]*|L[0-9]+|app|overview)[A-Za-z0-9_-]*)\]/g, (m, id) => (known.has(id) ? m : '[根拠不明]'));
      return {
        ok: true, errors, warnings,
        normalized: {
          answer,
          answerEvidenceIds: [...new Set([...answer.matchAll(/\[(E[1-9][0-9]*)\]/g)].map(m => m[1]))],
          facts, analysis: [...demoted, ...items(r.analysis, 'analysis')], recommendations: items(r.recommendations, 'recommendations'),
          unknowns: (Array.isArray(r.unknowns) ? r.unknowns : []).filter(s => typeof s === 'string' && s.trim()),
          requestId: r.meta?.requestId ?? null, usage: r.meta?.usage ?? null, ai: r.meta?.ai ?? null,
          gatewayWarnings: r.meta?.normalization?.warnings ?? [],
        },
      };
    }

    /**
     * @param {object} p apiBase / customerToken（必須）/ hostname（既定 location.hostname）/ transport / timeoutMs（既定 60000）/ pluginVersion
     */
    /**
     * @param {object} p apiBase（必須）/ customerToken（固定 token。staging 等）または getToken()（短命 Access Token の供給。async 可）/
     *   onAuthExpired()（AUTH_TOKEN_EXPIRED のとき 1 回だけ呼んで再試行。Refresh に使う）/ hostname / transport / timeoutMs / pluginVersion
     */
    function createAiClient({ apiBase, customerToken = null, getToken = null, onAuthExpired = null, hostname = null, transport = null, timeoutMs = 60000, pluginVersion = SCRIPT_VERSION, nowFn = null } = {}) {
      if (!apiBase || !String(apiBase).trim()) throw new AiClientError({ code: ERROR_CODES.INVALID_ENVELOPE, message: 'apiBase は必須です' });
      const base = String(apiBase).replace(/\/+$/, '');
      const send = transport || createDefaultTransport();
      const domain = hostname ?? (typeof location !== 'undefined' ? location.hostname : '');
      const resolveToken = async () => (typeof getToken === 'function' ? await getToken() : customerToken);
      const headers = (withJson, token) => {
        const h = { 'X-Kintone-Domain': domain };
        if (token != null && token !== '') h['Authorization'] = `Bearer ${String(token).trim()}`;
        if (withJson) h['Content-Type'] = 'application/json';
        return h;
      };
      const withTimeout = (run) => {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return run(null);
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            try { controller?.abort(); } catch (e) { }
            reject(new AiClientError({ code: ERROR_CODES.TIMEOUT, message: `AI サービスが ${timeoutMs}ms 以内に応答しませんでした` }));
          }, timeoutMs);
        });
        return Promise.race([run(controller?.signal ?? null), timeout]).finally(() => clearTimeout(timer));
      };
      const pickRetryAfter = (we, json) => { const n = Number(we?.retryAfterSeconds ?? json?.details?.retryAfterSec ?? null); return Number.isFinite(n) && n > 0 ? n : null; };
      const settle = ({ status, body }) => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) {
          throw new AiClientError({ code: ERROR_CODES.INVALID_RESPONSE, httpStatus: status, message: 'AI サービスの応答が JSON として解釈できません' });
        }
        if (status >= 200 && status < 300 && json?.ok === true) return json;
        const we = json?.error;
        if (we && typeof we === 'object' && we.code) {
          throw new AiClientError({ code: we.code, httpStatus: status, message: we.message || we.code, details: json, retryAfterSeconds: pickRetryAfter(we, json), requestId: we.requestId ?? null });
        }
        const legacy = typeof we === 'string' ? we : '';
        throw new AiClientError({ code: normalizeLegacyErrorCode(legacy) ?? ERROR_CODES.WORKER_ERROR, httpStatus: status, message: legacy || `AI API error: ${status}`, details: json, retryAfterSeconds: pickRetryAfter(null, json) });
      };
      const rawRequest = async ({ path, method, body, token }) => {
        let result;
        try {
          result = await withTimeout((signal) => send({ url: `${base}${path}`, method, headers: headers(method === 'POST', token), body, signal }));
        } catch (e) {
          if (isAiClientError(e)) throw e;
          if (e?.name === 'AbortError') throw new AiClientError({ code: ERROR_CODES.TIMEOUT, message: `AI サービスが ${timeoutMs}ms 以内に応答しませんでした` });
          throw new AiClientError({ code: ERROR_CODES.TRANSPORT_ERROR, message: e?.message || String(e) });
        }
        return settle(result);
      };
      /** 認証付き request。Access Token の期限切れは onAuthExpired（Refresh）後に 1 回だけ再試行 */
      const request = async ({ path, method, body }) => {
        try {
          return await rawRequest({ path, method, body, token: await resolveToken() });
        } catch (e) {
          if (isAiClientError(e) && e.code === ERROR_CODES.AUTH_TOKEN_EXPIRED && typeof onAuthExpired === 'function') {
            const refreshed = await onAuthExpired(e);
            if (refreshed) return rawRequest({ path, method, body, token: await resolveToken() });
          }
          throw e;
        }
      };
      return {
        /** GET /v2/health */
        getHealth: () => request({ path: '/v2/health', method: 'GET', body: '' }),
        /**
         * POST /v2/token/exchange（docs/contracts/14）。customer_token grant は Bearer に Customer Token、
         * refresh_token grant は body に Refresh Token（Bearer 無し）。戻り値の token は呼び出し側が保持する
         */
        exchange: ({ grantType, customerToken: ct = null, refreshToken = null, product = PRODUCT, feature = FEATURES.join(','), requestId = null }) => rawRequest({
          path: '/v2/token/exchange', method: 'POST',
          token: grantType === 'customer_token' ? ct : null,
          // requestId（Phase 8.5）: refresh 要求ごとの idempotency key。応答を受け取れなかった再送は同じ値を送ると同じ pair が返る
          body: JSON.stringify({ grantType, product, feature, ...(grantType === 'refresh_token' ? { refreshToken, ...(requestId ? { requestId } : {}) } : {}) }),
        }),
        /** tokenless connect（docs/contracts/15）。start / status / complete は認証なし、disconnect は Refresh Token（body）*/
        connectStart: ({ codeChallenge, product = PRODUCT, feature = FEATURES.join(','), clientVersion = pluginVersion }) => rawRequest({
          path: '/v2/connect/start', method: 'POST', token: null,
          body: JSON.stringify({ domain, product, feature, codeChallenge, codeChallengeMethod: 'S256', clientVersion }),
        }),
        connectStatus: (sessionId) => rawRequest({ path: `/v2/connect/status?session=${encodeURIComponent(sessionId)}`, method: 'GET', body: '', token: null }),
        connectComplete: ({ sessionId, codeVerifier }) => rawRequest({ path: '/v2/connect/complete', method: 'POST', token: null, body: JSON.stringify({ sessionId, codeVerifier }) }),
        connectDisconnect: ({ refreshToken }) => rawRequest({ path: '/v2/connect/disconnect', method: 'POST', token: null, body: JSON.stringify({ refreshToken }) }),
        /** POST /v2/review（toolkit.assistant-qa）。生成済みの ctx をそのまま送り、応答の根拠ID を再検証して返す */
        async ask({ ctx, requestId = newRequestId() } = {}) {
          const envelope = buildAskEnvelope({ ctx, requestId, pluginVersion, now: nowFn ? nowFn() : new Date().toISOString() });
          const response = await request({ path: '/v2/review', method: 'POST', body: JSON.stringify(envelope) });
          const v = validateAnswer(response, ctx);
          if (!v.ok) throw new AiClientError({ code: v.errors[0].code, message: v.errors[0].message, details: { errors: v.errors }, requestId });
          return { ...v.normalized, requestId: v.normalized.requestId || requestId, clientWarnings: v.warnings, raw: null };
        },
        /** POST /v2/review（toolkit.change-planner）。Planner Context を送り、Change Plan を再検証して返す（計画のみ。設定変更はしない） */
        async plan({ ctx, requestId = newRequestId() } = {}) {
          const envelope = buildPlanEnvelope({ ctx, requestId, pluginVersion, now: nowFn ? nowFn() : new Date().toISOString() });
          const response = await request({ path: '/v2/review', method: 'POST', body: JSON.stringify(envelope) });
          const v = validatePlan(response, ctx);
          if (!v.ok) throw new AiClientError({ code: v.errors[0].code, message: v.errors[0].message, details: { errors: v.errors }, requestId });
          return { ...v.normalized, requestId: v.normalized.requestId || requestId, clientWarnings: v.warnings };
        },
      };
    }

    /**
     * 接続セッション（Phase 5）。Customer Token → exchange → Access Token（memory）＋ Refresh Token（store）。
     * @param {object} p store（createSettingsStore 互換）/ hostname / transport / nowFn / apiBase（省略時は store の値）
     */
    function createSession({ store, hostname = null, transport = null, nowFn = null, apiBase = null, pluginVersion = SCRIPT_VERSION, timeoutMs = undefined } = {}) {
      const now = () => (nowFn ? nowFn() : Date.now());
      let access = { token: null, expiresAt: null };   // memory のみ
      let refreshing = null;                            // 同時更新の抑止
      const cfg = () => store.load();
      const base = () => apiBase || cfg().apiBase || DEFAULT_API_BASE;
      const clientOpts = () => ({ apiBase: base(), hostname, transport, pluginVersion, ...(timeoutMs != null ? { timeoutMs } : {}) });
      const bare = () => createAiClient(clientOpts());

      const persist = (ex) => {
        // 新しい pair を保存する（進行中の refresh 要求の記録は持ち越さない）
        store.save({ apiBase: base(), refreshToken: ex.refreshToken, refreshExpiresAt: ex.refreshExpiresAt, scope: ex.scope, connectedAt: new Date(now()).toISOString() });
        access = { token: ex.accessToken, expiresAt: ex.expiresAt };
      };
      const accessValid = () => !!access.token && Number.isFinite(Date.parse(access.expiresAt)) && Date.parse(access.expiresAt) - ACCESS_SKEW_MS > now();
      const refreshValid = (c) => !!c.refreshToken && (!c.refreshExpiresAt || Date.parse(c.refreshExpiresAt) > now());
      const newRefreshRequestId = () => `rf_${(typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`}`;

      /**
       * Refresh Token で新しい pair を得る（単回使用・rotation）。Gateway が token を拒否したら接続を破棄して SESSION_EXPIRED。
       * Phase 8.5: 応答を受け取れなかった場合（timeout / 通信断 / タブのスリープ）は旧 Refresh を捨てず、要求の requestId を接続情報と
       * 一緒に保存しておき、次の refresh は同じ requestId で再送する（Gateway は猶予内なら同じ pair を返す。ページ再読込後も同じ）。
       * 旧 token の再利用攻撃は Gateway 側が requestId の不一致で見分けて family を失効する
       */
      async function refresh() {
        if (refreshing) return refreshing;
        refreshing = (async () => {
          const c = cfg();
          if (!refreshValid(c)) { access = { token: null, expiresAt: null }; throw new AiClientError({ code: c.refreshToken ? ERROR_CODES.SESSION_EXPIRED : ERROR_CODES.NOT_CONNECTED, message: 'refresh unavailable' }); }
          const attempt = c.refreshAttempt && c.refreshAttempt.requestId ? c.refreshAttempt : { requestId: newRefreshRequestId(), at: new Date(now()).toISOString() };
          if (!c.refreshAttempt || c.refreshAttempt.requestId !== attempt.requestId) store.save({ ...c, refreshAttempt: attempt });
          try {
            // 要求は常に全 feature（Planner など後から契約に加わった機能を、再接続なしに scope へ取り込む）。Gateway が許可された交差を返す
            const ex = await bare().exchange({ grantType: 'refresh_token', refreshToken: c.refreshToken, product: c.scope?.product || PRODUCT, feature: FEATURES.join(','), requestId: attempt.requestId });
            persist(ex);
            return ex;
          } catch (e) {
            if (isAiClientError(e) && [ERROR_CODES.AUTH_INVALID_TOKEN, ERROR_CODES.AUTH_TOKEN_EXPIRED].includes(e.code)) {
              store.clear(); access = { token: null, expiresAt: null };
              throw new AiClientError({ code: ERROR_CODES.SESSION_EXPIRED, message: e.message, httpStatus: e.httpStatus, requestId: e.requestId });
            }
            // それ以外（TIMEOUT / TRANSPORT_ERROR / RATE_LIMITED / 5xx）: 旧 Refresh と requestId を保持し、次回同じ要求として再送する
            throw e;
          }
        })().finally(() => { refreshing = null; });
        return refreshing;
      }
      /** 有効な Access Token を返す（memory → Refresh の順。無ければ NOT_CONNECTED） */
      async function ensureAccessToken() {
        if (accessValid()) return access.token;
        await refresh();
        return access.token;
      }
      // apiBase は呼び出しのたびに store から解決する（session 生成時の値に固定すると、後から connect で
      // 接続先を変えたときに exchange だけ新しい接続先へ行き、health / ask が既定の production へ飛ぶ）
      const authed = () => createAiClient({
        ...clientOpts(),
        getToken: ensureAccessToken,
        onAuthExpired: async () => { access = { token: null, expiresAt: null }; await refresh(); return true; },
      });
      const client = {
        getHealth: () => authed().getHealth(),
        exchange: (p) => authed().exchange(p),
        ask: (p) => authed().ask(p),
        plan: (p) => authed().plan(p),
      };
      return {
        /** connect flow（PKCE）で発行された pair を取り込む（Customer Token は存在しない） */
        adopt(ex, { apiBase: ab = null } = {}) {
          if (ab) store.save({ ...cfg(), apiBase: ab });
          persist(ex);
          return this.status();
        },
        /** 開発・運用者向け: Customer Token で接続（1 回だけ送り、保存しない。本番 UI には出さない） */
        async connect(customerToken, { apiBase: ab = null } = {}) {
          if (ab) store.save({ ...cfg(), apiBase: ab });
          const ex = await bare().exchange({ grantType: 'customer_token', customerToken: String(customerToken || '').trim() });
          persist(ex);
          return this.status();
        },
        /** 旧形式（localStorage の Customer Token）があれば exchange して移行する。無ければ false */
        async migrateLegacy() {
          const legacy = store.takeLegacyCustomerToken();
          if (!legacy) return false;
          try { await this.connect(legacy.customerToken, { apiBase: legacy.apiBase }); return true; } catch (e) { return false; }
        },
        /** 接続解除: memory の Access・local の Refresh を消し、Gateway 側でも family を失効する（best-effort） */
        async disconnect() {
          const c = cfg();
          const rt = c.refreshToken || '';
          const gateway = bare();   // store を消す前に接続先を確定する（消した後は既定の production URL に戻ってしまう）
          store.clear(); access = { token: null, expiresAt: null };
          if (!rt) return { revoked: false };
          try { await gateway.connectDisconnect({ refreshToken: rt }); return { revoked: true }; }
          catch (e) { return { revoked: false, error: isAiClientError(e) ? e.code : ERROR_CODES.TRANSPORT_ERROR }; }
        },
        refresh,
        status() {
          const c = cfg();
          return {
            connected: refreshValid(c), apiBase: base(),
            refreshExpiresAt: c.refreshExpiresAt, scope: c.scope, connectedAt: c.connectedAt,
            accessExpiresAt: accessValid() ? access.expiresAt : null,
          };
        },
        client,
      };
    }

    // ---- tokenless connect（Browser Authorization Session。docs/contracts/15）----
    const b64url = (bytes) => { let b = ''; bytes.forEach(x => { b += String.fromCharCode(x); }); return btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); };
    /** PKCE（S256）: verifier は memory にだけ置き、Gateway には challenge だけを送る */
    async function createPkce({ cryptoObj = (typeof crypto !== 'undefined' ? crypto : null) } = {}) {
      if (!cryptoObj?.getRandomValues || !cryptoObj?.subtle?.digest) throw new AiClientError({ code: ERROR_CODES.TRANSPORT_ERROR, message: 'この環境では安全な乱数を生成できません' });
      const bytes = new Uint8Array(32);
      cryptoObj.getRandomValues(bytes);
      const verifier = b64url(bytes);
      const digest = await cryptoObj.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      return { verifier, challenge: b64url(new Uint8Array(digest)) };
    }
    const CONNECT_MAX_TRANSIENT = 5;
    /** 開発モード（Customer Token 入力の旧方式を表示する）。本番 UI では非表示 */
    function isDevMode() {
      try { return typeof localStorage !== 'undefined' && localStorage.getItem('ktAi.devMode') === '1'; } catch (e) { return false; }
    }
    /**
     * 接続フロー: start → 承認ページを別タブで開く → status を polling → complete（PKCE）→ session.adopt
     * @param {object} p session（createSession）/ hostname / transport / nowFn / sleep / openUrl(url) → opened:boolean / pluginVersion / cryptoObj
     */
    function createConnectFlow({ session, hostname = null, transport = null, nowFn = null, sleep = null, openUrl = null, pluginVersion = SCRIPT_VERSION, cryptoObj = undefined } = {}) {
      const now = () => (nowFn ? nowFn() : Date.now());
      const wait = sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
      const open = openUrl || ((url) => { try { const w = (typeof window !== 'undefined') ? window.open(url, '_blank', 'noopener') : null; return !!w; } catch (e) { return false; } });
      let state = { phase: 'idle', sessionId: null, authorizeUrl: null, expiresAt: null, popupBlocked: false, error: null };
      let cancelled = false, running = null;
      const set = (patch, onState) => { state = { ...state, ...patch }; if (onState) { try { onState(state); } catch (e) { } } };
      const client = () => createAiClient({ apiBase: session.status().apiBase, hostname, transport, pluginVersion });
      async function run(onState) {
        cancelled = false;
        set({ phase: 'starting', error: null, popupBlocked: false, sessionId: null, authorizeUrl: null }, onState);
        const pkce = await createPkce(cryptoObj === undefined ? {} : { cryptoObj });
        const st = await client().connectStart({ codeChallenge: pkce.challenge });
        const opened = open(st.authorizeUrl);
        set({ phase: 'pending', sessionId: st.sessionId, authorizeUrl: st.authorizeUrl, expiresAt: st.expiresAt, popupBlocked: !opened }, onState);
        let intervalSec = Math.max(1, Number(st.pollIntervalSeconds) || 2);
        let transient = 0;
        while (!cancelled) {
          if (Number.isFinite(Date.parse(st.expiresAt)) && now() >= Date.parse(st.expiresAt)) throw new AiClientError({ code: ERROR_CODES.CONNECT_EXPIRED, message: 'connect session expired' });
          await wait(intervalSec * 1000);
          if (cancelled) break;
          let r;
          try { r = await client().connectStatus(st.sessionId); transient = 0; }
          catch (e) {
            if (isAiClientError(e) && e.code === ERROR_CODES.RATE_LIMITED) { intervalSec = Math.max(intervalSec, Number(e.retryAfterSeconds) || intervalSec * 2); continue; }
            if (isAiClientError(e) && e.code === ERROR_CODES.NOT_FOUND) throw e;
            if (++transient > CONNECT_MAX_TRANSIENT) throw e;
            continue;   // 一時的な失敗は polling を続ける
          }
          if (r.pollIntervalSeconds) intervalSec = Math.max(1, Number(r.pollIntervalSeconds) || intervalSec);
          if (r.status === 'pending') continue;
          if (r.status === 'denied') throw new AiClientError({ code: ERROR_CODES.CONNECT_DENIED, message: 'denied' });
          if (r.status === 'expired') throw new AiClientError({ code: ERROR_CODES.CONNECT_EXPIRED, message: 'expired' });
          if (r.status === 'consumed') throw new AiClientError({ code: ERROR_CODES.AUTH_INVALID_TOKEN, message: 'consumed' });
          // authorized → complete（verifier は memory のみ）
          set({ phase: 'completing' }, onState);
          const ex = await client().connectComplete({ sessionId: st.sessionId, codeVerifier: pkce.verifier });
          session.adopt(ex);
          set({ phase: 'connected', customer: ex.customer || null }, onState);
          return ex;
        }
        throw new AiClientError({ code: ERROR_CODES.CONNECT_CANCELLED, message: 'cancelled' });
      }
      return {
        /** 接続を開始する（同時に 1 つ）。失敗・キャンセルは AiClientError（CONNECT_*）で reject */
        start({ onState = null } = {}) {
          if (running) return running;
          running = run(onState).catch((e) => {
            const code = isAiClientError(e) ? e.code : ERROR_CODES.TRANSPORT_ERROR;
            set({ phase: 'failed', error: code }, onState);
            throw e;
          }).finally(() => { running = null; });
          return running;
        },
        cancel() { cancelled = true; },
        /** ポップアップがブロックされたときに承認ページをもう一度開く */
        reopen() { if (!state.authorizeUrl) return false; const ok = open(state.authorizeUrl); set({ popupBlocked: !ok }); return ok; },
        state: () => ({ ...state }),
        isRunning: () => !!running,
      };
    }

    return {
      CONTRACT_VERSION, PRODUCT, FEATURE, FEATURE_PLANNER, FEATURES, PROMPT_VERSION, PLANNER_PROMPT_VERSION, DEFAULT_API_BASE, HEALTH_TTL_MS, ACCESS_SKEW_MS,
      ERROR_CODES, ERROR_TEXT, errorText, AiClientError, isAiClientError,
      createSettingsStore, createDefaultTransport, normalizeLegacyErrorCode,
      buildAskEnvelope, buildPlanEnvelope, capabilityFromHealth, validateAnswer, validatePlan, createAiClient, createSession, newRequestId,
      createPkce, createConnectFlow, isDevMode,
    };
  })();


  // ==========================================
  // 3.6 AI向けドキュメント UI（KTContextUi ＋ mountAiDocsPanel）
  //   無料版の機能: Toolkit の解析結果を KTContext で AI 向け Prompt / Markdown / JSON に変換し、
  //   ユーザーがコピーして ChatGPT / Claude などへ貼り付ける。LLM へは送信しない。
  //   将来の有料版（Toolkit 内で AI 回答）も同じ対象選択・質問・Context 生成を入口として使う。
  //
  //   KTContextUi      : DOM に依存しない UI ロジック（対象一覧・プリセット・生成・表示用サマリ・HTML 文字列）
  //   mountAiDocsPanel : Templates タブ内のパネルへ結び付ける薄い DOM 層（#id だけで要素を引く）
  // ==========================================
  const KTContextUi = (() => {
    const TARGET_TYPES = [
      { id: 'app', label: 'アプリ全体' },
      { id: 'field', label: 'フィールド' },
      { id: 'file', label: 'JavaScript' },
    ];
    // 質問プリセット（選択後も自由に編集できる）
    const PRESETS = {
      app: [
        'このアプリの構造を説明してください',
        'このアプリで変更時に注意する箇所を教えてください',
        'このアプリの壊れた参照や整合性の問題を整理してください',
      ],
      field: [
        'このフィールドを変更した場合の影響を説明してください',
        'このフィールドを削除して大丈夫か確認してください',
        'このフィールドがどこで使われているか整理してください',
      ],
      file: [
        'このJavaScriptが何をしているか説明してください',
        'このJavaScriptが参照しているフィールドと他アプリを整理してください',
      ],
    };
    const CONFIDENCE_HELP = [
      { code: 'CERTAIN', label: '確実', text: 'アプリ設定の値から直接取得した事実' },
      { code: 'LIKELY', label: '可能性が高い', text: '条件式・計算式・JavaScript のトークン一致による推定' },
      { code: 'UNCERTAIN', label: '要確認', text: '文字列一致のみ。実際の設定・コードでの確認を推奨' },
      { code: 'NOT_ANALYZED', label: '未解析', text: '解析対象外（外部URLのJS・プラグイン設定など）' },
    ];
    const INTRO_TEXT = 'Toolkit が解析したアプリ構成・依存関係・JavaScript の参照を、生成AIが理解しやすい形式に変換します。コピーした内容を ChatGPT や Claude などへ貼り付けて利用できます。Toolkit から AI へ送信することはありません。';
    const INTRO_NOTE = 'レコードの値・添付ファイルは含まれません。API キー等らしき文字列は伏字になります。';

    /** JS ファイルの表示名（PC / モバイルの同名ファイルを区別する。識別子は edge.sourceId） */
    const fileLabel = (f) => `${f.target === 'mobile' ? 'モバイル' : 'PC'}: ${f.name}${f.kind === 'css' ? '（CSS）' : ''}${f.analyzed === false ? '（未解析）' : ''}`;

    /** 選択肢（フィールド・JS ファイル）を既存データから作る。JS は DEPS の CUSTOMIZE ノード（sourceId）を正とする */
    function listTargets({ data, deps, scan }) {
      const fieldsN = KTDeps.normalizeFields(data?.fields || {});
      const fields = fieldsN
        .filter(f => f.type !== 'SUBTABLE' || true)
        .map(f => ({ id: f.code, label: f.label === f.code ? f.code : `${f.label}（${f.code}）`, type: f.type === 'LOOKUP' ? f.rawType : f.type }))
        .sort((a, b) => a.label.localeCompare(b.label, 'ja'));
      const seen = new Set();
      const files = [];
      for (const n of (deps?.nodes || [])) {
        if (n.type !== 'CUSTOMIZE') continue;
        const id = String(n.id).replace(/^CUSTOMIZE:/, '');
        if (seen.has(id)) continue;
        seen.add(id);
        // URL 指定（外部）の JS は Scanner が本文を取得しないため、node.analyzed の値にかかわらず未解析として扱う
        files.push({ id, name: n.name, target: n.target, kind: n.kind, analyzed: n.analyzed !== false && !/^https?:\/\//i.test(String(n.name)) });
      }
      for (const f of (scan?.files || [])) {
        if (f?.note) continue;   // 外部 URL（skipped）は DEPS 側のノード（未解析）で表す
        const id = `${f.target}:${f.kind}:${f.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        files.push({ id, name: f.name, target: f.target, kind: f.kind, analyzed: true });
      }
      files.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'js' ? -1 : 1) || a.name.localeCompare(b.name, 'ja') || a.target.localeCompare(b.target));
      return { fields, files: files.map(f => ({ ...f, label: fileLabel(f) })) };
    }

    /**
     * 画面の入力 → KTContext.build の引数。対象を明示選択しているときは focus を渡し、自然言語からの対象解決は行わない。
     * アプリ全体は focus なし・質問だけ（質問が空なら L0 のみ）
     */
    function toBuildRequest({ targetType, targetId, targetLabel = null, question }) {
      const q = String(question ?? '').trim() || null;
      const label = targetLabel != null && String(targetLabel).trim() ? String(targetLabel) : undefined;
      if (targetType === 'field' && targetId) return { question: q, focus: { type: 'field', id: String(targetId), ...(label ? { label } : {}) } };
      if (targetType === 'file' && targetId) return { question: q, focus: { type: 'file', id: String(targetId), ...(label ? { label } : {}) } };
      return { question: q, focus: null, options: {} };
    }

    /** coverage → 表示行（✓ 含む / — 未解析・対象外。「—」は存在しないという意味ではない） */
    function coverageRows(ctx) {
      const cv = ctx?.coverage || {};
      const s = cv.settings || {};
      const settingsOk = !!(s.views || s.notifications || s.process || s.acl || s.actions);
      return [
        { label: 'フィールド', included: !!cv.fields },
        { label: 'アプリ設定（一覧・通知・プロセス・アクセス権・アクション）', included: settingsOk },
        { label: '依存関係', included: !!cv.dependencies },
        { label: 'JavaScript', included: !!cv.javascript },
        { label: '他アプリからの参照', included: !!cv.incoming },
        { label: 'プラグイン設定', included: false, reason: cv.pluginCount ? `${cv.pluginCount} 個あり・設定内容は API で取得不可` : '取得不可' },
        { label: 'レコードデータ', included: false, reason: '対象外（取得しない）' },
        { label: '添付ファイル', included: false, reason: '対象外（取得しない）' },
      ];
    }

    /** truncation → 表示（applied のときだけ本文と内訳） */
    function truncationSummary(ctx) {
      const t = ctx?.truncation || { applied: false, sections: [] };
      return {
        applied: !!t.applied,
        message: t.applied ? '一部の解析結果はサイズ制限のため省略されています。' : '',
        details: (t.sections || []).map(s => `${s.name}: ${s.total}件中${s.included}件`),
      };
    }

    /** size → 表示文字列（KTContext.measure の近似値） */
    function sizeSummary(ctx) {
      const sz = ctx?.size || {};
      const kb = Math.max(1, Math.round((sz.bytes || 0) / 1024));
      return {
        tokens: sz.approxTokens ?? 0, bytes: sz.bytes ?? 0, facts: sz.facts ?? 0,
        text: `約 ${(sz.approxTokens ?? 0).toLocaleString()} tokens（近似） / ${kb} KB / Facts: ${sz.facts ?? 0}`,
      };
    }

    /**
     * 生成（純関数）。ambiguous のときは候補を返し、出力は作らない（勝手に決めない）
     * @returns {{ ok:true, ctx, outputs:{prompt,markdown,json}, coverage, truncation, size, warnings:string[] }
     *          |{ ok:false, reason:'ambiguous'|'no-data'|'error', candidates?:Array, message:string }}
     */
    function generate({ targetType, targetId, targetLabel = null, question, inputs, limits = null, now = undefined }) {
      if (!inputs || !inputs.data) return { ok: false, reason: 'no-data', message: 'アプリ設定の取得が完了していません。' };
      const req = toBuildRequest({ targetType, targetId, targetLabel, question });
      let ctx;
      try {
        ctx = KTContext.build({
          ...req, data: inputs.data, deps: inputs.deps || null, scan: inputs.scan || null, incoming: inputs.incoming || null,
          options: { ...(limits ? { limits } : {}), ...(now !== undefined ? { now } : {}) },
        });
      } catch (e) {
        return { ok: false, reason: 'error', message: `Context の生成に失敗しました: ${e?.message || e}` };
      }
      if (ctx.focus.resolution === 'ambiguous') {
        return {
          ok: false, reason: 'ambiguous', ctx,
          candidates: ctx.focus.candidates.map(c => ({ type: c.type, id: c.id, label: c.type === 'file' ? fileLabel({ name: c.label, target: c.target, kind: c.kind }) : (c.label && c.label !== c.id ? `${c.label}（${c.id}）` : c.id) })),
          message: '対象を特定できませんでした。候補から選択してください。',
        };
      }
      const warnings = [];
      if (!ctx.coverage.javascript) warnings.push('JavaScript は未解析です（Field Scanner の Scan 実行で反映されます）。');
      if (!ctx.coverage.incoming) warnings.push('他アプリからの参照は未走査です（Relations タブで走査できます）。');
      if (inputs.scan && !(inputs.scan.files || []).some(f => typeof f.text === 'string')) warnings.push('JavaScript 本文はキャッシュに含まれないため、コード抜粋は Scanner の断片のみです。');
      return {
        ok: true, ctx,
        outputs: { prompt: KTContext.toPrompt(ctx), markdown: KTContext.toMarkdown(ctx), json: KTContext.toJSON(ctx, { pretty: true }) },
        coverage: coverageRows(ctx), truncation: truncationSummary(ctx), size: sizeSummary(ctx), warnings,
      };
    }

    /** 変更計画（Planner）の goal プリセット */
    const PLANNER_PRESETS = [
      '担当者が設定されたら本人に通知したい',
      '金額が100万円以上なら部長承認を追加したい',
      '契約終了日の30日前に担当者へ通知したい',
      '顧客マスタから住所と電話番号も自動で取得したい',
    ];
    /**
     * 変更計画用の Context 生成（純関数）。無料側でも Prompt / Markdown / JSON をコピーできる
     * @returns {{ ok:true, ctx, outputs, coverage, truncation, size, warnings }|{ ok:false, reason, message }}
     */
    function generatePlan({ goal, inputs, limits = null, now = undefined }) {
      if (!inputs || !inputs.data) return { ok: false, reason: 'no-data', message: 'アプリ設定の取得が完了していません。' };
      const g = String(goal ?? '').trim();
      if (!g) return { ok: false, reason: 'no-goal', message: '実現したいことを入力してください。' };
      let ctx;
      try {
        ctx = KTContext.buildPlan({ goal: g, data: inputs.data, deps: inputs.deps || null, scan: inputs.scan || null, incoming: inputs.incoming || null, options: { ...(limits ? { limits } : {}), ...(now !== undefined ? { now } : {}) } });
      } catch (e) {
        return { ok: false, reason: 'error', message: `Context の生成に失敗しました: ${e?.message || e}` };
      }
      const warnings = [];
      if (!ctx.coverage.javascript) warnings.push('JavaScript は未解析です（Field Scanner の Scan 実行で反映されます）。');
      if (!ctx.coverage.incoming) warnings.push('他アプリからの参照は未走査です（Relations タブで走査できます）。');
      if (!ctx.retrieval.fields.length) warnings.push('入力内容に一致する既存フィールドは見つかりませんでした（アプリ全体の既存資産を送ります）。');
      return {
        ok: true, ctx, mode: 'plan',
        outputs: { prompt: KTContext.toPlannerPrompt(ctx), markdown: KTContext.toPlannerMarkdown(ctx), json: KTContext.toJSON(ctx, { pretty: true }) },
        coverage: coverageRows(ctx), truncation: truncationSummary(ctx), size: sizeSummary(ctx), warnings,
      };
    }

    /** 出力ファイル名（ローカル保存用） */
    function outputFilename(ctx, view) {
      const ext = view === 'json' ? 'json' : 'md';
      const tgt = ctx?.focus?.target ? `_${String(ctx.focus.target.id).replace(/[^\w.\-]+/g, '_')}` : (ctx?.goal != null ? '_plan' : '');
      return `ai-context_app${ctx?.app?.id ?? ''}${tgt}_${view}.${ext}`;
    }

    // ---- HTML（文字列のみ。DOM には触らない）----
    const esc = (v) => escapeHtml(v);
    function panelHtml({ border, bg }) {
      const opt = (list, sel) => list.map(x => `<option value="${esc(x.id)}"${x.id === sel ? ' selected' : ''}>${esc(x.label)}</option>`).join('');
      return `
        <div id="kt-ai-panel" style="display:flex; flex-direction:column; gap:8px; font-size:12px;">
          <div style="opacity:.85; line-height:1.5;">${esc(INTRO_TEXT)}<br><span style="opacity:.8;">${esc(INTRO_NOTE)}</span></div>
          <!-- モード: 質問する（現在の設定について）/ 変更計画を作る（実現したい業務 → Change Plan）。既存の Q&A は変えない -->
          <div id="kt-ai-mode" style="display:flex; gap:12px; align-items:center;">
            <label style="display:flex; align-items:center; gap:4px; cursor:pointer;"><input type="radio" name="kt-ai-mode" id="kt-ai-mode-qa" value="qa" checked> 質問する</label>
            <label style="display:flex; align-items:center; gap:4px; cursor:pointer;"><input type="radio" name="kt-ai-mode" id="kt-ai-mode-plan" value="plan"> 変更計画を作る</label>
          </div>
          <div id="kt-ai-qa-inputs" style="display:flex; flex-direction:column; gap:8px;">
          <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;">対象
            <select id="kt-ai-target-type" class="btn" style="padding:3px 4px; height:28px; flex:1;">${opt(TARGET_TYPES, 'app')}</select>
          </label>
          <select id="kt-ai-target" class="btn" style="padding:3px 4px; height:28px; display:none;"></select>
          <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;">質問プリセット
            <select id="kt-ai-preset" class="btn" style="padding:3px 4px; height:28px; flex:1;"></select>
          </label>
          <textarea id="kt-ai-question" rows="3" placeholder="質問（自由に編集できます。空でも構成だけの Context を生成します）"
            style="width:100%; box-sizing:border-box; border:1px solid ${border}; border-radius:8px; padding:6px; background:${bg}; color:inherit; font:inherit; resize:vertical;"></textarea>
          </div>
          <div id="kt-ai-plan-inputs" style="display:none; flex-direction:column; gap:8px;">
            <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;">例
              <select id="kt-ai-goal-preset" class="btn" style="padding:3px 4px; height:28px; flex:1;"><option value="">（例を選択）</option>${PLANNER_PRESETS.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}</select>
            </label>
            <textarea id="kt-ai-goal" rows="3" placeholder="実現したいことを入力（例: 契約更新を管理して、終了30日前に担当者へ通知したい）"
              style="width:100%; box-sizing:border-box; border:1px solid ${border}; border-radius:8px; padding:6px; background:${bg}; color:inherit; font:inherit; resize:vertical;"></textarea>
            <div style="opacity:.75; font-size:11px;">Toolkit がアプリ全体の既存資産（フィールド・プロセス・通知・一覧・権限・依存関係）を解析し、既存資産の再利用を最優先に変更計画を作ります。設定の自動変更はしません。</div>
          </div>
          <div style="display:flex; gap:6px; align-items:center;">
            <button id="kt-ai-generate" class="btn" style="flex:1; height:32px; font-weight:600;">AI Prompt を生成</button>
            <button id="kt-ai-scan" class="btn" style="height:32px; display:none;" title="JavaScript を解析して Context に含める">JS を解析</button>
          </div>
          <div id="kt-ai-status" style="min-height:1.2em; opacity:.85;"></div>
          <div id="kt-ai-candidates-wrap" style="display:none; gap:6px; align-items:center;">
            <select id="kt-ai-candidate" class="btn" style="padding:3px 4px; height:28px; flex:1;"></select>
            <button id="kt-ai-candidate-apply" class="btn" style="height:28px;">この対象で生成</button>
          </div>
          <div id="kt-ai-actions" style="display:none; flex-wrap:wrap; gap:6px;">
            <button id="kt-ai-copy-prompt" class="btn" style="height:32px; flex:1 1 100%; font-weight:600;">AI Prompt をコピー</button>
            <button id="kt-ai-copy-md" class="btn" style="height:28px; flex:1;">Markdown をコピー</button>
            <button id="kt-ai-copy-json" class="btn" style="height:28px; flex:1;">JSON をコピー</button>
            <label style="display:flex; align-items:center; gap:6px; flex:1 1 100%; white-space:nowrap;">プレビュー
              <select id="kt-ai-view" class="btn" style="padding:3px 4px; height:28px; flex:1;">
                <option value="prompt">AI Prompt</option><option value="markdown">Markdown</option><option value="json">JSON（開発者向け）</option>
              </select>
            </label>
          </div>
          <div id="kt-ai-result" style="display:none; border:1px solid ${border}; border-radius:8px; padding:8px; background:${bg}; line-height:1.6;"></div>

          <!-- 有料: Nest Rec AI（AIに質問）。無料側の生成・コピーには依存させない -->
          <div id="kt-ai-paid" style="border-top:1px solid ${border}; padding-top:8px; display:flex; flex-direction:column; gap:6px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
              <b>Nest Rec AI</b>
              <span id="kt-ai-conn-badge" style="font-size:11px; opacity:.8;"></span>
            </div>
            <!-- 未接続: 「Nest Rec AIに接続」だけ（利用者に credential を見せない・入力させない）。
                 Customer Token の旧方式は開発モード（localStorage ktAi.devMode = "1"）のときだけ表示する -->
            <div id="kt-ai-connect" style="display:none; flex-direction:column; gap:6px;">
              <button id="kt-ai-connect-start" class="btn" style="height:32px; font-weight:600;">Nest Rec AIに接続</button>
              <div style="opacity:.7; font-size:11px;">AI向けドキュメント機能は接続しなくても無料で利用できます。</div>
              <div id="kt-ai-dev" style="display:none; flex-direction:column; gap:4px; border:1px dashed ${border}; border-radius:6px; padding:6px;">
                <div style="font-size:11px; opacity:.7;">開発モード: Customer Token で接続（運用者向け。接続後は保存されません）</div>
                <input id="kt-ai-token" type="password" placeholder="Customer Token" autocomplete="off" style="border:1px solid ${border}; border-radius:6px; padding:4px; background:${bg}; color:inherit; font:inherit;">
                <div style="display:flex; gap:6px;">
                  <button id="kt-ai-connect-btn" class="btn" style="height:28px; flex:1;">接続（Customer Token）</button>
                  <details id="kt-ai-paid-settings" style="font-size:11px;"><summary style="cursor:pointer; line-height:28px;">詳細</summary>
                    <input id="kt-ai-api-base" placeholder="API Base URL" style="width:100%; box-sizing:border-box; border:1px solid ${border}; border-radius:6px; padding:4px; background:${bg}; color:inherit; font:inherit;">
                  </details>
                </div>
              </div>
            </div>
            <!-- 接続中: Nest Rec の承認ページを別タブで開き、承認を待つ（ポップアップ block 時は再度開ける） -->
            <div id="kt-ai-connecting" style="display:none; flex-direction:column; gap:6px; border:1px solid ${border}; border-radius:8px; padding:8px; background:${bg};">
              <div id="kt-ai-connecting-text">Nest Recで接続を確認しています...</div>
              <div style="display:flex; gap:6px;">
                <button id="kt-ai-open-authorize" class="btn" style="height:28px; flex:1;">Nest Recのページを開く</button>
                <button id="kt-ai-connect-cancel" class="btn" style="height:28px;">キャンセル</button>
              </div>
            </div>
            <!-- 接続済み: AI Assistant / 接続先 / 契約 / 利用量・更新 / 接続解除 -->
            <div id="kt-ai-session" style="display:none; flex-direction:column; gap:2px; font-size:11px;">
              <div id="kt-ai-session-lines"></div>
              <div style="display:flex; gap:6px; margin-top:4px;">
                <button id="kt-ai-session-refresh" class="btn" style="height:26px; flex:1;">接続を更新</button>
                <button id="kt-ai-session-disconnect" class="btn" style="height:26px;">接続解除</button>
              </div>
            </div>
            <button id="kt-ai-ask" class="btn" disabled style="height:32px; font-weight:600;">AIに質問</button>
            <button id="kt-ai-plan" class="btn" disabled style="height:32px; font-weight:600; display:none;">変更計画を作成</button>
            <div id="kt-ai-paid-status" style="opacity:.85; min-height:1.2em;"></div>
            <div id="kt-ai-consent" style="display:none; border:1px solid ${border}; border-radius:8px; padding:8px; background:${bg}; line-height:1.5;">
              <div><b>この Context を AI サービス（Nest Rec AI Gateway）へ送信します。</b></div>
              <div>送信する内容: アプリ設定の要約・依存関係・JavaScript の解析結果と抜粋（伏字済み）・質問</div>
              <div>送信しない内容: レコードの値・添付ファイル・cookie・API キー</div>
              <div style="display:flex; gap:6px; margin-top:6px;">
                <button id="kt-ai-consent-ok" class="btn" style="height:28px; flex:1;">送信する（次回から確認しない）</button>
                <button id="kt-ai-consent-cancel" class="btn" style="height:28px;">キャンセル</button>
              </div>
            </div>
            <div id="kt-ai-answer" style="display:none; border:1px solid ${border}; border-radius:8px; padding:8px; background:${bg}; line-height:1.6;"></div>
            <div id="kt-ai-plan-result" style="display:none; border:1px solid ${border}; border-radius:8px; padding:8px; background:${bg}; line-height:1.6;"></div>
            <div id="kt-ai-fact-detail" style="display:none; border:1px dashed ${border}; border-radius:8px; padding:8px; background:${bg}; line-height:1.5; font-size:11px;"></div>
          </div>
        </div>`;
    }

    /** 利用可否 → 表示文（AI 未契約でも無料機能はそのまま使える） */
    function capabilityStatusText(cap) {
      if (!cap) return '';
      if (cap.checking) return '接続を確認しています...';
      if (cap.available) {
        const u = cap.usage ? `（今月 ${cap.usage.usedThisMonth} / ${cap.usage.monthlyLimit} 回）` : '';
        return `AI に質問できます${u}`;
      }
      return KTAiClient.errorText(cap.reason);
    }

    /** 接続済みの状態表示（AI Assistant / 接続先 / 契約 / AI利用 / 接続の有効期限）。credential は表示しない */
    function sessionLinesHtml(status, cap) {
      const fmt = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleDateString() : '—'; };
      const contract = !status?.connected ? '未接続'
        : cap?.checking ? '確認中...'
          : cap?.available ? `有効${cap.contractExpiresAt ? `（${fmt(cap.contractExpiresAt)} まで）` : ''}`
            : (cap ? KTAiClient.errorText(cap.reason) : '確認済み');
      const rows = [
        ['AI Assistant', cap?.checking ? '確認中...' : cap?.available ? '利用可能' : (cap ? KTAiClient.errorText(cap.reason) : '—')],
        ['接続先', status?.scope?.domain || '—'],
        ['契約', contract],
        ...(cap?.usage ? [['AI利用', `${cap.usage.usedThisMonth} / ${cap.usage.monthlyLimit}`]] : []),
        ['接続の有効期限', fmt(status?.refreshExpiresAt)],
      ];
      return rows.map(([k, v]) => `<div><span style="opacity:.7; display:inline-block; min-width:7em;">${esc(k)}</span>${esc(v)}</div>`).join('');
    }

    /** 根拠ID のチップ（クリックで該当 fact を表示） */
    const chips = (ids) => (ids || []).map(id => `<button type="button" class="btn kt-ai-chip" data-eid="${esc(id)}" style="padding:0 6px; height:20px; font-size:11px; margin-left:4px;">${esc(id)}</button>`).join('');

    /** AI 回答（回答 / 確認できた事実 / AI による分析 / 提案 / 確認できないこと） */
    function answerHtml(a) {
      if (!a) return '';
      const list = (items, empty) => (items && items.length)
        ? `<ul style="margin:4px 0 0 18px; padding:0;">${items.map(x => `<li>${esc(x.text)}${chips(x.evidenceIds)}</li>`).join('')}</ul>`
        : `<div style="opacity:.6; margin-top:4px;">${esc(empty)}</div>`;
      const answerText = esc(a.answer).replace(/\[(E[1-9][0-9]*)\]/g, (m, id) => chips([id]));
      const warn = [...(a.clientWarnings || []), ...(a.gatewayWarnings || [])];
      return `
        <div style="display:flex; align-items:center; justify-content:space-between;"><b>AI回答</b><span style="opacity:.6; font-size:11px;">requestId: ${esc(a.requestId || '')}</span></div>
        <div style="margin-top:6px;"><b>回答</b><div style="margin-top:4px;">${answerText}</div></div>
        <div style="margin-top:8px;"><b>確認できた事実</b>${list(a.facts, '根拠付きの事実はありません')}</div>
        <div style="margin-top:8px;"><b>AIによる分析</b>${list(a.analysis, '分析はありません')}</div>
        <div style="margin-top:8px;"><b>提案</b>${list(a.recommendations, '提案はありません')}</div>
        <div style="margin-top:8px;"><b>確認できないこと</b>${(a.unknowns && a.unknowns.length) ? `<ul style="margin:4px 0 0 18px; padding:0;">${a.unknowns.map(u => `<li>${esc(u)}</li>`).join('')}</ul>` : '<div style="opacity:.6; margin-top:4px;">なし</div>'}</div>
        ${warn.length ? `<details style="margin-top:6px; font-size:11px;"><summary style="cursor:pointer;">検証で除去・調整した項目（${warn.length}）</summary>${warn.map(w => `<div>${esc(w.code)}: ${esc(w.message)}</div>`).join('')}</details>` : ''}
        ${a.usage ? `<div style="margin-top:6px; opacity:.6; font-size:11px;">今月の利用: ${esc(a.usage.usedThisMonth)} / ${esc(a.usage.monthlyLimit)} 回</div>` : ''}
        <div style="margin-top:6px; opacity:.6; font-size:11px;">AI の回答は Toolkit が解析した事実を根拠にした参考情報です。設定を変更する前に実際の設定・コードで確認してください。</div>`;
    }

    // ---- Change Plan（変更計画）の表示 ----
    /** step の種別バッジ（新規提案 / 既存利用 / 変更 / カスタマイズ）と状態バッジ（確認必要 / 無効）。枠線の色は状態を優先 */
    const STEP_KIND_BADGE = (st) => (/^ADD_/.test(st.actionType) ? ['新規提案', '#1a73e8'] : st.actionType === 'REUSE_FIELD' ? ['既存利用', '#2e7d32']
      : /^UPDATE_/.test(st.actionType) ? ['変更', '#6a1b9a'] : st.actionType === 'CUSTOMIZATION_REQUIRED' ? ['カスタマイズ', '#b26a00'] : ['確認', '#555']);
    const STEP_STATUS_BADGE = (st) => (st.validation?.status === 'invalid' ? ['無効', '#b00020']
      : (st.validation?.status === 'needs_confirmation' || st.confidence === 'NEEDS_CONFIRMATION') ? ['確認必要', '#b26a00'] : null);
    const STEP_BADGE = (st) => STEP_STATUS_BADGE(st) || STEP_KIND_BADGE(st);
    const badge = (text, color) => `<span style="display:inline-block; font-size:10px; padding:0 6px; border-radius:8px; border:1px solid ${color}; color:${color}; margin-right:4px;">${esc(text)}</span>`;
    const CONF_JA_PLAN = { CONFIRMED: '確認済み', INFERRED: '推論', NEEDS_CONFIRMATION: '要確認', OUT_OF_SCOPE: '解析範囲外' };
    const ACTION_JA = {
      ADD_FIELD: 'フィールド追加', UPDATE_FIELD: 'フィールド変更', REUSE_FIELD: '既存フィールド利用', ADD_PROCESS_STATUS: 'ステータス追加', UPDATE_PROCESS: 'プロセス管理変更', ADD_PROCESS_ACTION: 'プロセスアクション追加',
      ADD_NOTIFICATION: '通知追加', UPDATE_NOTIFICATION: '通知変更', ADD_REMINDER: 'リマインダー追加', ADD_VIEW: '一覧追加', UPDATE_VIEW: '一覧変更', UPDATE_RECORD_ACL: 'レコードのアクセス権変更', UPDATE_FIELD_ACL: 'フィールドのアクセス権変更',
      ADD_APP_ACTION: 'アプリアクション追加', UPDATE_APP_ACTION: 'アプリアクション変更', ADD_LOOKUP: 'ルックアップ追加', UPDATE_LOOKUP: 'ルックアップ変更', REQUIRE_CONFIRMATION: '要確認', CUSTOMIZATION_REQUIRED: 'カスタマイズが必要',
    };
    // ---- Toolkit 検証（KTPlanReview）の表示 ----
    const RSTATUS = { VALID: ['✓ 問題なし', '#2e7d32'], WARNING: ['△ 注意', '#b26a00'], NEEDS_CONFIRMATION: ['△ 確認が必要', '#b26a00'], INVALID: ['× 実行不可', '#b00020'], BLOCKED_BY_DEPENDENCY: ['× 依存先が無効', '#b00020'] };
    const RSAFETY = { SAFE: ['安全', '#2e7d32'], REVIEW_REQUIRED: ['要レビュー', '#b26a00'], BLOCKED: ['実行不可', '#b00020'], PLAN_ONLY: ['計画のみ', '#555'] };
    const RCHANGE = { ADD: '追加', UPDATE: '既存変更', REUSE: '既存利用', REMOVE: '削除', NO_CHANGE: '変更なし', INVALID: '無効' };
    /** step 1 件分の Toolkit 検証（AI の提案とは分けて表示する） */
    function reviewStepHtml(r) {
      if (!r) return '';
      const [stText, stColor] = RSTATUS[r.status] || [r.status, '#555'];
      const [sfText, sfColor] = RSAFETY[r.safety] || [r.safety, '#555'];
      const lines = (r.diff?.human || []).map(l => `<div style="font-size:11px;">${esc(l)}</div>`).join('');
      const issues = (r.issues || []).map(i => `<div style="font-size:11px; color:${i.severity === 'high' ? '#b00020' : i.severity === 'medium' ? '#b26a00' : '#555'};">${i.severity === 'high' ? '⚠' : '・'} ${esc(i.message)}</div>`).join('');
      return `<div class="kt-ai-review-step" data-step="${esc(r.stepId)}" style="margin-top:6px; padding:6px 8px; border-radius:6px; background:rgba(0,0,0,.04); border-left:3px solid ${stColor};">
        <div><b>Toolkit で確認した結果</b> ${badge(stText, stColor)}${badge(sfText, sfColor)}${badge(RCHANGE[r.diff?.changeType] || r.diff?.changeType || '', '#555')}${r.blockedBy?.length ? badge(`依存: ${r.blockedBy.join(', ')}`, '#b00020') : ''}</div>
        ${lines}${issues}
        <label style="display:flex; align-items:center; gap:6px; margin-top:4px; font-size:11px;">判断
          <select class="kt-ai-decision" data-step="${esc(r.stepId)}" style="font-size:11px;"><option value="">（未定）</option><option value="approve"${r.safety === 'BLOCKED' ? ' disabled' : ''}>承認</option><option value="hold">保留</option><option value="reject">却下</option></select>
        </label>
      </div>`;
    }
    /** 実行前レビュー（plan 全体の集約・競合・警告・Before / After・プロセス図・Review JSON） */
    function reviewHtml(review, plan) {
      if (!review) return '';
      const c = review.summary?.counts || {};
      const er = review.executionReadiness || {};
      const stepLine = (ids, label, color, mark) => `<div style="display:flex; justify-content:space-between; gap:8px;"><span style="color:${color};">${mark} ${esc(label)}</span><b>${ids.length} 件${ids.length ? `（${esc(ids.join(', '))}）` : ''}</b></div>`;
      const conflicts = (review.conflicts || []).map(x => `<div style="border:1px solid #b26a00; border-radius:6px; padding:6px 8px; margin-top:6px;">
        <div><b>⚠ ${esc(x.message)}</b> <span style="opacity:.7; font-size:11px;">（${esc((x.stepIds || []).join(', '))}）</span></div>
        ${x.existing ? `<div style="font-size:11px; margin-top:4px;">${badge('既存', '#2e7d32')}${esc(x.existing.title || x.existing.id || '')}${x.existing.targets ? ` 通知先: ${esc(x.existing.targets.join(', '))}` : ''}${x.existing.filterCond ? ` 条件: ${esc(x.existing.filterCond)}` : ''}${x.existing.events?.length ? ` イベント: ${esc(x.existing.events.join(', '))}` : ''}</div>` : ''}
        ${x.proposed ? `<div style="font-size:11px;">${badge('提案', '#1a73e8')}${esc(x.proposed.title || x.proposed.id || '')}${x.proposed.targets ? ` 通知先: ${esc(x.proposed.targets.join(', '))}` : ''}${x.proposed.filterCond ? ` 条件: ${esc(x.proposed.filterCond)}` : ''}${x.proposed.events?.length ? ` イベント: ${esc(x.proposed.events.join(', '))}` : ''}</div>` : ''}
      </div>`).join('');
      const warnings = (review.warnings || []).map(w => `<div style="font-size:11px; margin-top:2px;">${w.severity === 'high' ? '⚠' : '・'} ${esc(w.message)} <span style="opacity:.6;">(${esc(w.code)}${w.stepIds?.length ? ` / ${esc(w.stepIds.join(', '))}` : ''})</span></div>`).join('');
      const steps = review.steps || [];
      const diffs = steps.map(r => `<div style="margin-top:6px;"><b>${esc(r.stepId)}</b> ${badge(RCHANGE[r.diff?.changeType] || '', '#555')}${esc(r.diff?.target?.kind || '')}${r.diff?.target?.id ? ` <code>${esc(r.diff.target.id)}</code>` : ''}${(r.diff?.human || []).map(l => `<div style="font-size:11px; padding-left:8px;">${esc(l)}</div>`).join('')}</div>`).join('');
      const proc = review.simulation?.process;
      const procHtml = proc && proc.changed ? `<div style="margin-top:8px;"><b>プロセス管理の変更前後</b>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:4px;">
          <div style="flex:1 1 280px; border:1px solid #ccc; border-radius:6px; padding:6px;"><div style="font-size:11px; opacity:.7;">Before</div><pre class="kt-ai-mermaid" data-side="before" style="font-size:11px; white-space:pre-wrap; margin:0;">${esc(proc.mermaid.before)}</pre></div>
          <div style="flex:1 1 280px; border:1px solid #1a73e8; border-radius:6px; padding:6px;"><div style="font-size:11px; opacity:.7;">After（青＝追加・変更）</div><pre class="kt-ai-mermaid" data-side="after" style="font-size:11px; white-space:pre-wrap; margin:0;">${esc(proc.mermaid.after)}</pre></div>
        </div>
        <div style="font-size:11px; opacity:.8; margin-top:4px;">After: ${esc(proc.after.states.map(x => x.name).join(' → '))}　アクション ${proc.after.actions.length} 件（Before ${proc.before.actions.length} 件）</div>
      </div>` : '';
      const cov = review.reviewCoverage || {};
      const covText = Object.entries(cov).filter(([k]) => k !== 'notes').map(([k, v]) => `${k}: ${v === true ? '✓' : v === false ? '—' : esc(String(v))}`).join('　');
      return `<div id="kt-ai-review" style="margin-top:10px; border:2px solid #1a73e8; border-radius:8px; padding:8px;">
        <div style="display:flex; align-items:center; justify-content:space-between;"><b>実行前レビュー（Toolkit 検証）</b><span style="font-size:11px; opacity:.7;">AI の提案を Toolkit が決定的に検証した結果です。AI の説明より優先します</span></div>
        <div style="margin-top:6px; display:grid; gap:2px;">
          ${stepLine(er.safeSteps || [], '安全に追加できる変更', '#2e7d32', '✓')}
          ${stepLine(er.reviewSteps || [], '確認が必要', '#b26a00', '△')}
          ${stepLine(er.blockedSteps || [], '実行不可', '#b00020', '×')}
          ${stepLine(er.planOnlySteps || [], '計画のみ（仮適用・自動検証の対象外）', '#555', '○')}
        </div>
        <div style="margin-top:6px; font-size:11px;">追加：${c.additions ?? 0}　既存変更：${c.updates ?? 0}　既存利用：${c.reuse ?? 0}　高リスク変更：${c.highRisk ?? 0}　競合候補：${c.conflicts ?? 0}　確認事項：${c.confirmations ?? 0}　無効：${c.invalid ?? 0}</div>
        <div id="kt-ai-review-decisions" style="margin-top:4px; font-size:11px;">${esc(decisionSummary(review, {}))}</div>
        ${conflicts ? `<div style="margin-top:8px;"><b>⚠ 競合・重複の候補</b>${conflicts}</div>` : ''}
        ${warnings ? `<div style="margin-top:8px;"><b>Toolkit からの指摘</b>${warnings}</div>` : ''}
        ${procHtml}
        <div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;">
          <button type="button" id="kt-ai-review-diff-toggle" class="btn" style="height:26px; font-size:11px;">変更前後を比較</button>
          <button type="button" id="kt-ai-review-json-toggle" class="btn" style="height:26px; font-size:11px;">Review JSON を見る</button>
          <button type="button" id="kt-ai-review-json-copy" class="btn" style="height:26px; font-size:11px;">Review JSON をコピー</button>
          <button type="button" id="kt-ai-review-raw-toggle" class="btn" style="height:26px; font-size:11px;">Raw Diff JSON</button>
        </div>
        <div id="kt-ai-review-diff" style="display:none; margin-top:6px;">${diffs || '<div style="opacity:.6;">差分はありません</div>'}</div>
        <pre id="kt-ai-review-json" style="display:none; margin-top:6px; max-height:320px; overflow:auto; font-size:11px; white-space:pre-wrap;">${esc(JSON.stringify(KTPlanReview.executorOutput(plan, review), null, 2))}</pre>
        <pre id="kt-ai-review-raw" style="display:none; margin-top:6px; max-height:320px; overflow:auto; font-size:11px; white-space:pre-wrap;">${esc(JSON.stringify(review.diff, null, 2))}</pre>
        <div style="margin-top:6px; font-size:11px; opacity:.7;">検証範囲: ${covText}</div>
        <div style="font-size:11px; opacity:.7;">このレビューは設定を変更しません（計画の検証のみ）。実行可否は Toolkit の判定が正本です。</div>
        <div id="kt-ai-exec" style="margin-top:8px;"></div>
      </div>`;
    }

    // ---- Preview Executor（Phase 9）の表示。設定を書くのは KTPlanExecutor。ここは HTML だけ ----
    const EXEC_STEP_JA = { PENDING: '待機中', RUNNING: '処理中...', APPLIED: '反映済み（検証中）', VERIFIED: 'VERIFIED', VERIFY_FAILED: 'VERIFY_FAILED（状態不一致）', FAILED: 'FAILED', SKIPPED: '未実行', BLOCKED: '実行不可', UNSUPPORTED: 'PLAN_ONLY', ROLLED_BACK: 'ROLLED_BACK' };
    const EXEC_STEP_COLOR = { VERIFIED: '#2e7d32', APPLIED: '#1a73e8', RUNNING: '#1a73e8', VERIFY_FAILED: '#b00020', FAILED: '#b00020', BLOCKED: '#b00020', UNSUPPORTED: '#555', SKIPPED: '#777', PENDING: '#777' };
    const EXEC_REASON_JA = { NOT_APPROVED: '承認されていません', REVIEW_BLOCKED: 'Review で実行不可', PLAN_ONLY: '現在の Executor では自動反映できません', PREVIEW_NOT_SUPPORTED: '現在の Executor では自動反映できません', FIELD_TYPE_NOT_SUPPORTED: 'このフィールド型は現在の Executor では追加できません', OPTIONS_MISSING: '選択肢が決まっていません', DEPENDENCY_NOT_EXECUTABLE: '依存する step が実行されません', REVALIDATION_FAILED: '実行前の再検証で止まりました', STOPPED_AFTER_FAILURE: '前の step の失敗で停止', DEPENDENCY_NOT_VERIFIED: '依存 step が検証済みでない', PERMISSION_DENIED: 'アプリ設定を変更する権限がありません', REVISION_MISMATCH: '他の変更が入りました（revision 不一致）', TARGET_EXISTS: '同じ名前 / コードが既にあります', API_ERROR: 'API エラー', VERIFY_FAILED: 'API は成功したが状態が一致しません' };
    const execActionJa = (a) => ({ ADD_FIELD: 'フィールド追加', ADD_VIEW: '一覧追加', ADD_NOTIFICATION: '通知追加', ADD_REMINDER: 'リマインダー追加' }[a] || ACTION_JA[a] || a);
    const execStepLine = (st) => `<div style="display:flex; gap:8px; align-items:baseline; font-size:12px;"><span style="min-width:34px; font-weight:600;">${esc(st.stepId)}</span><span style="flex:1;">${esc(st.title || execActionJa(st.actionType))}</span><span style="color:${EXEC_STEP_COLOR[st.status] || '#555'}; font-weight:600;">${esc(EXEC_STEP_JA[st.status] || st.status)}</span></div>${st.status !== 'VERIFIED' && st.status !== 'RUNNING' && st.status !== 'PENDING' && (st.message || st.reason) ? `<div style="font-size:11px; opacity:.75; margin-left:42px;">${esc(st.message || EXEC_REASON_JA[st.reason] || st.reason)}</div>` : ''}`;
    /**
     * @param {object} s { stage: 'idle'|'preparing'|'blocked'|'confirm'|'running'|'done', classified[], prepared, execution, error, available }
     */
    function executorHtml(s) {
      const cls = s.classified || [];
      const executable = cls.filter(x => x.status === 'PENDING'), unsupported = cls.filter(x => x.status === 'UNSUPPORTED'), blocked = cls.filter(x => x.status === 'BLOCKED');
      const line = (ids, label, color, mark) => `<div style="display:flex; justify-content:space-between; font-size:12px;"><span style="color:${color};">${mark} ${esc(label)}</span><b>${ids.length} 件${ids.length ? `（${esc(ids.map(x => x.stepId).join(', '))}）` : ''}</b></div>`;
      const unsupportedList = unsupported.length ? `<div style="margin-top:4px; display:grid; gap:2px;">${unsupported.map(x => `<div style="font-size:11px; opacity:.8;">${esc(x.stepId)} ${esc(x.title || execActionJa(x.actionType))}：<b>PLAN_ONLY</b> — ${esc(EXEC_REASON_JA[x.reason] || x.message || x.reason)}</div>`).join('')}</div>` : '';
      const head = `<div style="border-top:1px dashed #1a73e8; padding-top:8px;"><b>動作テスト環境への反映（Preview Executor）</b>
        <div style="margin-top:4px; display:grid; gap:2px;">${line(executable, '承認済み・実行可能', '#2e7d32', '✓')}${line(unsupported, '承認済みだが未対応', '#b26a00', '△')}${line(blocked, '実行不可', '#b00020', '×')}</div>${unsupportedList}`;
      const foot = '</div>';
      const note = (t, color = '#555') => `<div style="font-size:11px; color:${color}; margin-top:4px;">${esc(t)}</div>`;
      if (s.stage === 'idle' || s.stage === 'preparing') {
        const disabled = s.stage === 'preparing' || !executable.length || !s.available;
        return `${head}<div style="margin-top:8px; display:flex; gap:6px; align-items:center; flex-wrap:wrap;"><button type="button" id="kt-ai-exec-start" class="btn" style="height:28px; font-weight:600;"${disabled ? ' disabled' : ''}>動作テスト環境へ反映</button><span style="font-size:11px; opacity:.75;">${s.stage === 'preparing' ? '現在の設定を確認しています...' : !s.available ? 'この環境では実行できません（kintone API が無い）' : !executable.length ? '承認済みで実行できる step がありません' : '運用環境には反映されません（動作テスト環境のみ）'}</span></div>${foot}`;
      }
      if (s.stage === 'blocked') {
        const p = s.prepared;
        const stale = p?.stale?.status === 'STALE' ? `<div style="margin-top:4px; display:grid; gap:2px;">${(p.stale.diffs || []).slice(0, 12).map(d => `<div style="font-size:11px;">・${esc(d.message)}</div>`).join('')}</div>` : '';
        const blockers = (p?.blockers || s.error ? [...(p?.blockers || []), ...(s.error ? [{ code: 'ERROR', message: s.error }] : [])] : []).map(b => `<div style="font-size:12px; color:#b00020;">× ${esc(b.message)} <span style="opacity:.7;">[${esc(b.code)}]</span></div>`).join('');
        return `${head}<div style="margin-top:8px; border:1px solid #b00020; border-radius:6px; padding:6px;">${blockers}${stale}${note('設定は変更していません。計画を作り直すか、動作テスト環境の変更を確認してください。')}</div><div style="margin-top:6px;"><button type="button" id="kt-ai-exec-start" class="btn" style="height:26px; font-size:11px;">もう一度確認する</button></div>${foot}`;
      }
      if (s.stage === 'confirm') {
        const p = s.prepared;
        const pend = (p?.steps || []).filter(x => x.status === 'PENDING');
        const byType = {};
        for (const x of pend) byType[x.actionType] = (byType[x.actionType] || 0) + 1;
        const lines = Object.entries(byType).map(([a, n]) => `<div style="font-size:12px;">＋ ${esc(execActionJa(a))} ${n} 件</div>`).join('');
        const details = pend.map(x => `<div style="font-size:11px; opacity:.85;">${esc(x.stepId)} ${esc(x.prepared?.summary || x.title)}</div>`).join('');
        return `${head}<div id="kt-ai-exec-confirm" style="margin-top:8px; border:2px solid #b26a00; border-radius:6px; padding:8px;">
          <b>動作テスト環境へ以下を反映します。</b>
          <div style="margin-top:4px;">${lines}</div><div style="margin-top:4px; display:grid; gap:2px;">${details}</div>
          <div style="margin-top:6px; font-size:12px;"><b>運用環境には反映されません。</b>（動作テスト環境 revision ${esc(String(p?.revision?.preview ?? '—'))}・実行前の設定は snapshot として保持します）</div>
          <div style="margin-top:8px; display:flex; gap:6px;"><button type="button" id="kt-ai-exec-cancel" class="btn" style="height:28px;">キャンセル</button><button type="button" id="kt-ai-exec-go" class="btn" style="height:28px; font-weight:600; border-color:#b26a00;">動作テスト環境へ反映</button></div>
        </div>${foot}`;
      }
      if (s.stage === 'running' || s.stage === 'done') {
        const ex = s.execution;
        const steps = ex?.steps || (s.prepared?.steps || []);
        const list = `<div id="kt-ai-exec-progress" style="margin-top:6px; display:grid; gap:3px;">${steps.map(execStepLine).join('')}</div>`;
        if (s.stage === 'running') return `${head}<div style="margin-top:8px;"><b>動作テスト環境へ反映しています...</b>${list}${note('画面を閉じずにお待ちください（運用環境には反映されません）')}</div>${foot}`;
        const verified = steps.filter(x => x.status === 'VERIFIED').length, warn = steps.filter(x => x.status === 'VERIFY_FAILED').length, failed = steps.filter(x => x.status === 'FAILED').length, skipped = steps.filter(x => x.status === 'SKIPPED' && x.reason !== 'NOT_APPROVED').length;
        const ok = ex?.status === 'DONE';
        const sim = ex?.simulation;
        const simText = !sim || sim.compared === false ? 'Simulationとの一致：—（比較していません）' : sim.match ? 'Simulationとの一致：✓' : `Simulationとの一致：× SIMULATION_MISMATCH（${(sim.mismatches || []).map(m => m.id).join(', ')}）`;
        const re = ex?.reanalysis;
        const reText = re?.available ? `再解析：フィールド ${re.after.fields} 件（実行前 ${re.before?.fields ?? '—'}）・依存 ${re.after.edges} 件・存在しない参照 ${re.after.brokenRefs ?? '—'} 件（実行前 ${re.before?.brokenRefs ?? '—'}）${(re.addedFields || []).length ? '・追加フィールドの参照 ' + re.addedFields.map(a => `${a.code}: ${a.directRefs}`).join(', ') : ''}` : '再解析：—';
        const title = ok ? '動作テスト環境への反映が完了しました。' : `${verified} 件反映済み・${failed + warn} 件失敗・以降未実行（${skipped} 件）`;
        return `${head}<div id="kt-ai-exec-result" style="margin-top:8px; border:2px solid ${ok ? '#2e7d32' : '#b00020'}; border-radius:6px; padding:8px;">
          <b>${esc(title)}</b>
          <div style="margin-top:4px; font-size:12px;">✓ ${verified} 件 VERIFIED　⚠ ${warn} 件　× ${failed} 件</div>
          <div style="font-size:12px;">${esc(simText)}</div>
          <div style="font-size:11px; opacity:.8;">${esc(reText)}</div>
          ${list}
          <div style="margin-top:6px; font-size:12px;"><b>運用環境にはまだ反映されていません。</b>（反映は kintone のアプリ設定画面から行ってください。Executor は運用環境へ反映しません）</div>
          <div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;">
            <button type="button" id="kt-ai-exec-audit-copy" class="btn" style="height:26px; font-size:11px;">監査 JSON をコピー</button>
            <button type="button" id="kt-ai-exec-audit-download" class="btn" style="height:26px; font-size:11px;">監査 JSON を保存</button>
            <button type="button" id="kt-ai-exec-snapshot-copy" class="btn" style="height:26px; font-size:11px;">実行前スナップショットをコピー</button>
            <button type="button" id="kt-ai-exec-rollback-toggle" class="btn" style="height:26px; font-size:11px;">ロールバック計画を見る</button>
          </div>
          <pre id="kt-ai-exec-rollback" style="display:none; margin-top:6px; max-height:240px; overflow:auto; font-size:11px; white-space:pre-wrap;">${esc(JSON.stringify(s.rollbackPlan || null, null, 2))}</pre>
        </div>${foot}`;
      }
      return `${head}${foot}`;
    }

    /** 判断の集計（承認 / 保留 / 却下 / 未定）。decisions は stepId → 'approve' | 'hold' | 'reject' */
    function decisionSummary(review, decisions) {
      const ids = (review?.steps || []).map(r => r.stepId);
      const get = (id) => (decisions instanceof Map ? decisions.get(id) : decisions?.[id]) || '';
      const n = (v) => ids.filter(id => get(id) === v).length;
      const undecided = ids.filter(id => !get(id)).length;
      return `判断: 承認 ${n('approve')}　保留 ${n('hold')}　却下 ${n('reject')}　未定 ${undecided}（承認した step だけが Executor への入力 approvedSteps になります。保存はしません）`;
    }
    /** Change Plan → HTML（実現したいこと / 現在利用できるもの / 追加が必要なもの / 変更計画 / 代替案 / 影響範囲 / 確認したいこと / 解析できないこと / JSON）。review を渡すと Toolkit 検証を併記 */
    function planHtml(plan, review = null) {
      if (!plan) return '';
      const reviewOf = (id) => (review?.steps || []).find(r => r.stepId === id) || null;
      const li = (items, render, empty) => (items && items.length) ? `<ul style="margin:4px 0 0 18px; padding:0;">${items.map(render).join('')}</ul>` : `<div style="opacity:.6; margin-top:4px;">${esc(empty)}</div>`;
      const sec = (title, body) => `<div style="margin-top:8px;"><b>${esc(title)}</b>${body}</div>`;
      const a = plan.assessment || {};
      const existing = [
        ...(a.usableExistingFields || []).map(x => `<li>${badge('既存', '#2e7d32')}<code>${esc(x.fieldCode)}</code> ${esc(x.note)}${chips(x.evidenceIds)}</li>`),
        ...(a.usableExistingSettings || []).map(x => `<li>${badge('既存', '#2e7d32')}${esc(x.kind)}「${esc(x.name)}」 ${esc(x.note)}${chips(x.evidenceIds)}</li>`),
      ];
      const proposed = (plan.proposedFields || []).map(p => `
        <div class="kt-ai-new-field" style="border:2px solid #1a73e8; border-radius:8px; padding:8px; margin-top:6px; background:rgba(26,115,232,.06);">
          <div><b>＋ 新規フィールド</b> ${badge('新規提案', '#1a73e8')}${p.codeConflict ? badge('コード重複', '#b00020') : ''}${p.labelDuplicate ? badge('名前重複', '#b26a00') : ''}${p.typeValid === false ? badge('型要確認', '#b00020') : ''}</div>
          <div style="margin-top:4px; font-size:13px;"><b>${esc(p.label)}</b> <span style="opacity:.7;">（コード案: ${esc(p.suggestedCode)} / ${esc(p.temporaryId)}）</span></div>
          <div>種類：${esc(p.type)}${p.required ? '（必須）' : ''}${(p.options || []).length ? `　選択肢：${esc(p.options.join(' / '))}` : ''}</div>
          <div style="margin-top:4px;">理由：${esc(p.reason)}${chips(p.evidenceIds)}</div>
          ${p.alternativeExistingFieldCode ? `<div style="margin-top:4px;">${badge('代替案', '#2e7d32')}既存の <code>${esc(p.alternativeExistingFieldCode)}</code> で代用できる可能性（要確認）</div>` : ''}
        </div>`).join('');
      const stepHtml = (st) => {
        const [bt, bc] = STEP_BADGE(st);
        const details = (st.proposal?.details || []).map(dd => `<div style="font-size:11px; opacity:.85;">・${esc(dd.key)}: ${esc(dd.value)}</div>`).join('');
        const issues = (st.validation?.issues || []).map(x => `<div style="font-size:11px; color:#b00020;">※ ${esc(x)}</div>`).join('');
        return `<div class="kt-ai-step" data-step="${esc(st.id)}" style="border:1px solid ${bc}; border-left:4px solid ${bc}; border-radius:6px; padding:6px 8px; margin-top:6px;">
          <div><b>${esc(st.id)}</b> ${STEP_STATUS_BADGE(st) ? badge(...STEP_STATUS_BADGE(st)) : ''}${badge(...STEP_KIND_BADGE(st))}${badge(ACTION_JA[st.actionType] || st.actionType, '#555')}${badge(CONF_JA_PLAN[st.confidence] || st.confidence, '#555')} ${esc(st.title)}</div>
          <div style="margin-top:2px;">対象：${st.targetKind === 'PROPOSED_FIELD' ? `${badge('新規', '#1a73e8')}${esc(st.targetRef || '')}` : st.targetRef ? `${st.targetExists === false ? (/^ADD_/.test(st.actionType) ? badge('新規', '#1a73e8') : badge('不明', '#b00020')) : badge('既存', '#2e7d32')}${esc(st.targetKind)} <code>${esc(st.targetRef)}</code>` : '（なし）'}</div>
          <div style="margin-top:2px;">${esc(st.proposal?.summary || '')}</div>${details}
          <div style="margin-top:2px; opacity:.85;">理由：${esc(st.reason)}${chips(st.evidenceIds)}</div>
          ${(st.dependsOn || []).length ? `<div style="font-size:11px; opacity:.7;">依存：${esc(st.dependsOn.join(', '))} の後</div>` : ''}${issues}
          ${reviewStepHtml(reviewOf(st.id))}
        </div>`;
      };
      const mainSteps = (plan.steps || []).filter(st => !st.alternativeId);
      const altSteps = (alt) => (plan.steps || []).filter(st => st.alternativeId === alt.id);
      const warn = [...(plan.clientWarnings || []), ...(plan.gatewayWarnings || [])];
      return `
        <div style="display:flex; align-items:center; justify-content:space-between;"><b>変更計画（AI Change Planner）</b><span style="opacity:.6; font-size:11px;">requestId: ${esc(plan.requestId || '')}</span></div>
        <div style="font-size:11px; opacity:.7;">以下は AI の提案です。各手順の「Toolkit で確認した結果」と末尾の「実行前レビュー」は Toolkit が決定的に検証したものです。</div>
        ${sec('実現したいこと', `<div style="margin-top:4px;">${esc(plan.goal)}</div><div style="margin-top:4px; opacity:.85;">${esc(a.summary || '')}</div><div style="font-size:11px; opacity:.7;">計画の確度：${esc(CONF_JA_PLAN[plan.planConfidence] || plan.planConfidence || '')}</div>`)}
        ${sec('現在利用できるもの', li(existing, x => x, '利用できる既存資産は挙げられていません'))}
        ${sec('追加が必要なもの', `${li(a.missingCapabilities || [], x => `<li>${esc(x)}</li>`, '追加が必要なものはありません')}${proposed}`)}
        ${sec('変更計画', mainSteps.length ? mainSteps.map(stepHtml).join('') : '<div style="opacity:.6; margin-top:4px;">計画の手順はありません</div>')}
        ${(plan.alternatives || []).length ? sec('代替案', plan.alternatives.map(alt => `<div style="margin-top:6px;"><b>${esc(alt.id)}</b> ${esc(alt.title)} <span style="opacity:.8;">${esc(alt.summary)}</span>${(alt.stepIds || []).length ? `<div style="font-size:11px; opacity:.7;">対象の手順: ${esc(alt.stepIds.join(', '))}</div>` : ''}${altSteps(alt).map(stepHtml).join('')}</div>`).join('')) : ''}
        ${sec('影響範囲', li(plan.impact || [], x => `<li>${x.validation?.status === 'invalid' ? badge('不明な対象', '#b00020') : (x.validation?.status === 'proposed' || x.targetKind === 'PROPOSED_FIELD') ? badge('新規提案', '#1a73e8') : badge('既存', '#2e7d32')}${esc(x.targetKind)}${x.targetRef ? ` <code>${esc(x.targetRef)}</code>` : ''}: ${esc(x.description)}${chips(x.evidenceIds)}</li>`, '既存設定への影響は挙げられていません'))}
        ${sec('確認したいこと', li(plan.questions || [], q => `<li>${badge('確認必要', '#b26a00')}<b>${esc(q.id)}</b> ${esc(q.question)} <span style="opacity:.7;">（${esc(q.reason)}）</span>${chips(q.relatedEvidenceIds)}</li>`, '確認事項はありません'))}
        ${sec('解析できないこと', li(plan.unknowns || [], u => `<li>${esc(u)}</li>`, 'なし'))}
        ${warn.length ? `<details style="margin-top:6px; font-size:11px;"><summary style="cursor:pointer;">検証で除去・調整した項目（${warn.length}）</summary>${warn.map(w => `<div>${esc(w.code)}: ${esc(w.message)}</div>`).join('')}</details>` : ''}
        ${review ? reviewHtml(review, plan) : ''}
        <div style="margin-top:8px; display:flex; gap:6px;">
          <button type="button" id="kt-ai-plan-json-toggle" class="btn" style="height:26px; font-size:11px;">Change Plan JSON を見る</button>
          <button type="button" id="kt-ai-plan-json-copy" class="btn" style="height:26px; font-size:11px;">JSON をコピー</button>
        </div>
        <pre id="kt-ai-plan-json" style="display:none; margin-top:6px; max-height:320px; overflow:auto; font-size:11px; white-space:pre-wrap;">${esc(JSON.stringify(planJson(plan), null, 2))}</pre>
        ${plan.usage ? `<div style="margin-top:6px; opacity:.6; font-size:11px;">今月の利用: ${esc(plan.usage.usedThisMonth)} / ${esc(plan.usage.monthlyLimit)} 回</div>` : ''}
        <div style="margin-top:6px; opacity:.6; font-size:11px;">この変更計画は提案です。Toolkit は設定を変更しません。実施前に各手順と影響範囲を確認してください。</div>`;
    }
    /** Executor へ渡す形（表示用の warnings / usage を除いた計画そのもの） */
    function planJson(plan) {
      if (!plan) return null;
      const { clientWarnings, gatewayWarnings, usage, ai, requestId, ...rest } = plan;
      return { planVersion: '1', requestId: requestId ?? null, ...rest };
    }

    /** 根拠ID → fact の詳細（将来は Fields / Relations / Scanner へ遷移させる） */
    function evidenceDetailHtml(fact) {
      if (!fact) return '<div style="opacity:.7;">該当する根拠が見つかりません</div>';
      const rows = [
        ['根拠ID', fact.id], ['種別', fact.kind], ['確度', `${confJaOf(fact.confidence)}（${fact.confidence}）`],
        fact.source ? ['利用元', `${fact.source.type} ${fact.source.name ? `「${fact.source.name}」` : ''} (${fact.source.id})`] : null,
        fact.relationType ? ['関係', `${fact.relationLabel || ''} (${fact.relationType})`] : null,
        fact.target ? ['利用先', `${fact.target.type} ${fact.target.name ? `「${fact.target.name}」` : ''} (${fact.target.id})`] : null,
        fact.setting && (fact.setting.type || fact.setting.name) ? ['設定', `${fact.setting.name || ''} (${fact.setting.type || ''})`] : null,
        fact.file ? ['ファイル', `${fact.file.target || ''} ${fact.file.name || ''}${fact.line ? ` ${fact.line} 行目` : ''}`] : null,
        Array.isArray(fact.lines) ? ['行', fact.lines.join(', ')] : null,
      ].filter(Boolean);
      return `<div><b>${esc(fact.id)}</b> ${esc(fact.statement)}</div>` +
        `<table style="margin-top:4px; border-collapse:collapse;">${rows.map(([k, v]) => `<tr><td style="opacity:.7; padding:1px 8px 1px 0; white-space:nowrap;">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
    }
    const confJaOf = (c) => ({ CERTAIN: '確実', LIKELY: '可能性が高い', UNCERTAIN: '要確認', NOT_ANALYZED: '未解析' })[c] || c || '';

    /** 生成結果のサマリ HTML（coverage / truncation / size / confidence ヘルプ） */
    function resultHtml(gen) {
      if (!gen || !gen.ok) return '';
      const cov = gen.coverage.map(r => `<div>${r.included ? '✓' : '—'} ${esc(r.label)}${!r.included && r.reason ? ` <span style="opacity:.7;">（${esc(r.reason)}）</span>` : ''}</div>`).join('');
      const tr = gen.truncation.applied
        ? `<details style="margin-top:6px;"><summary style="cursor:pointer;">⚠ ${esc(gen.truncation.message)}</summary><div style="opacity:.85; padding-left:8px;">${gen.truncation.details.map(d => `<div>${esc(d)}</div>`).join('')}</div></details>`
        : '';
      const warn = gen.warnings.length ? `<div style="margin-top:6px; opacity:.85;">${gen.warnings.map(w => `<div>※ ${esc(w)}</div>`).join('')}</div>` : '';
      const help = `<details style="margin-top:6px;"><summary style="cursor:pointer;">確度（confidence）の意味</summary><div style="padding-left:8px;">${CONFIDENCE_HELP.map(h => `<div><b>${esc(h.label)}</b>（${esc(h.code)}）: ${esc(h.text)}</div>`).join('')}</div></details>`;
      const focus = gen.ctx.focus || {};
      const target = focus.target ? `${esc(focus.target.type)} <code>${esc(focus.target.id)}</code>` : (gen.ctx.goal != null ? '変更計画（アプリ全体の既存資産）' : 'アプリ全体');
      const levelText = Array.isArray(gen.ctx.levels) ? gen.ctx.levels.join(' + ') : 'planner';
      return `
        <div><b>対象</b>: ${target}　<b>階層</b>: ${esc(levelText)}</div>
        <div><b>サイズ</b>: ${esc(gen.size.text)}</div>
        <div style="margin-top:6px;"><b>解析範囲</b>（— は未解析・対象外。存在しないという意味ではありません）</div>
        ${cov}${tr}${warn}${help}`;
    }

    return {
      TARGET_TYPES, PRESETS, CONFIDENCE_HELP, INTRO_TEXT, INTRO_NOTE,
      listTargets, fileLabel, toBuildRequest, generate, coverageRows, truncationSummary, sizeSummary, outputFilename,
      panelHtml, resultHtml, capabilityStatusText, sessionLinesHtml, answerHtml, evidenceDetailHtml,
      // AI Change Planner（Phase 7）/ Review（Phase 8）
      PLANNER_PRESETS, generatePlan, planHtml, planJson, reviewHtml, reviewStepHtml, decisionSummary, executorHtml,
    };
  })();

  /**
   * Templates タブ内の「AI向けドキュメント」パネルを組み立てる（DOM 層。#id だけで要素を引く）
   * @param {Element} host  パネルを描くコンテナ
   * @param {object} d
   *   getInputs()        → { data, deps, scan, incoming }（呼び出し時点の最新）
   *   setPreview(text, lang) エディタ側へ出力を表示する
   *   copyText(text)     → Promise<boolean>
   *   runScan()          → Promise<{ok}>（省略可。無ければ「JS を解析」ボタンを出さない）
   *   colors             { border, bg }
   *   ---- 有料（Nest Rec AI）。省略時は無料機能のみ ----
   *   settings           KTAiClient.createSettingsStore() 互換（hasConsent / setConsent を使う）
   *   session            KTAiClient.createSession() 互換（connect / migrateLegacy / disconnect / refresh / status / client）
   *   hostname           X-Kintone-Domain（既定 location.hostname）
   * @returns {{ regenerate(), currentOutput(), refreshCapability(), ask(), showEvidence(id) }} 外側から使う
   */
  function mountAiDocsPanel(host, d) {
    host.innerHTML = KTContextUi.panelHtml(d.colors || { border: '#ccc', bg: 'transparent' });
    const $ = (id) => host.querySelector(`#${id}`);
    const $type = $('kt-ai-target-type'), $target = $('kt-ai-target'), $preset = $('kt-ai-preset'), $q = $('kt-ai-question');
    const $gen = $('kt-ai-generate'), $scan = $('kt-ai-scan'), $status = $('kt-ai-status');
    const $candWrap = $('kt-ai-candidates-wrap'), $cand = $('kt-ai-candidate'), $candApply = $('kt-ai-candidate-apply');
    const $actions = $('kt-ai-actions'), $view = $('kt-ai-view'), $result = $('kt-ai-result');
    const $copyPrompt = $('kt-ai-copy-prompt'), $copyMd = $('kt-ai-copy-md'), $copyJson = $('kt-ai-copy-json');
    // モード（質問する / 変更計画を作る）
    const $modeQa = $('kt-ai-mode-qa'), $modePlan = $('kt-ai-mode-plan'), $qaInputs = $('kt-ai-qa-inputs'), $planInputs = $('kt-ai-plan-inputs');
    const $goal = $('kt-ai-goal'), $goalPreset = $('kt-ai-goal-preset');
    const mode = () => ($modePlan && $modePlan.checked ? 'plan' : 'qa');

    let last = null;      // 直近の generate 結果
    const esc = escapeHtml;
    const setStatus = (t) => { $status.textContent = t || ''; };

    // ---- 有料: Nest Rec AI（AIに質問）。無料側（生成・コピー）はこのブロックに依存しない ----
    const $paid = $('kt-ai-paid'), $ask = $('kt-ai-ask'), $paidStatus = $('kt-ai-paid-status'), $badge = $('kt-ai-conn-badge');
    const $connect = $('kt-ai-connect'), $apiBase = $('kt-ai-api-base'), $token = $('kt-ai-token'), $connectBtn = $('kt-ai-connect-btn');
    const $connectStart = $('kt-ai-connect-start'), $dev = $('kt-ai-dev');
    const $connecting = $('kt-ai-connecting'), $connectingText = $('kt-ai-connecting-text'), $openAuthorize = $('kt-ai-open-authorize'), $connectCancel = $('kt-ai-connect-cancel');
    const $session = $('kt-ai-session'), $sessionLines = $('kt-ai-session-lines'), $sessionRefresh = $('kt-ai-session-refresh'), $sessionDisconnect = $('kt-ai-session-disconnect');
    const $consent = $('kt-ai-consent'), $consentOk = $('kt-ai-consent-ok'), $consentCancel = $('kt-ai-consent-cancel');
    const $answer = $('kt-ai-answer'), $factDetail = $('kt-ai-fact-detail');
    const $planBtn = $('kt-ai-plan'), $planResult = $('kt-ai-plan-result');
    let lastPlan = null;
    let lastReview = null;         // KTPlanReview.review の結果（Toolkit 検証）
    const decisions = new Map();   // stepId → approve | hold | reject（MVP: 保存しない）
    // Preview Executor（Phase 9）。d.executor = { api, appId }。api は kintone のセッション認証（このユーザーの権限）で動作テスト環境だけを書く
    const executor = d.executor && d.executor.api ? d.executor : null;
    const execState = { stage: 'idle', prepared: null, execution: null, error: null, rollbackPlan: null };
    const settings = d.settings || null;
    const session = d.session || null;
    const paidEnabled = !!(settings && session);
    // tokenless connect（Nest Rec の承認ページ → PKCE → Access / Refresh）。credential 文字列を UI に出さない
    // 承認ページはクリック直後に空タブを同期的に開いておき（ポップアップ block 回避）、start の応答が来たら URL を入れる。
    // opener は切る（Nest Rec 側から kintone の window を参照させない）
    let preWin = null;
    const openUrl = d.openUrl || ((url) => {
      try {
        if (preWin && !preWin.closed) { const w = preWin; preWin = null; try { w.opener = null; } catch (e) { } w.location.href = url; return true; }
        const w = (typeof window !== 'undefined' && typeof window.open === 'function') ? window.open(url, '_blank', 'noopener') : null;
        return !!w;
      } catch (e) { return false; }
    });
    const preOpen = () => { try { preWin = (!d.openUrl && typeof window !== 'undefined' && typeof window.open === 'function') ? window.open('about:blank', '_blank') : null; } catch (e) { preWin = null; } };
    const closePre = () => { try { if (preWin && !preWin.closed) preWin.close(); } catch (e) { } preWin = null; };
    const flow = paidEnabled ? (d.connectFlow || KTAiClient.createConnectFlow({ session, openUrl })) : null;
    const devMode = !!(d.devMode ?? KTAiClient.isDevMode());
    let capability = { available: false, reason: KTAiClient.ERROR_CODES.NO_CONFIG };
    let healthAt = 0;
    let sending = false;
    let lastAnswer = null;
    const setPaidStatus = (t) => { $paidStatus.textContent = t || ''; };
    // 一時的な失敗（rate limit / timeout / 通信・サービス障害）は再試行できるようボタンを残す（押下時に再判定）
    const TRANSIENT = [KTAiClient.ERROR_CODES.RATE_LIMITED, KTAiClient.ERROR_CODES.TIMEOUT, KTAiClient.ERROR_CODES.TRANSPORT_ERROR,
      KTAiClient.ERROR_CODES.UPSTREAM_ERROR, KTAiClient.ERROR_CODES.INTERNAL_ERROR, KTAiClient.ERROR_CODES.WORKER_ERROR, KTAiClient.ERROR_CODES.INVALID_RESPONSE];
    const isTransient = () => !capability.available && TRANSIENT.includes(capability.reason);
    const plannerAvailable = () => !!(capability.available && capability.features?.[KTAiClient.FEATURE_PLANNER]?.available);
    const setAskEnabled = () => {
      $ask.disabled = !(paidEnabled && (capability.available || isTransient()) && !sending);
      $planBtn.disabled = !(paidEnabled && (plannerAvailable() || isTransient()) && !sending);
    };
    /** モードに応じて入力欄・ボタン・結果の表示を切り替える（Q&A と Planner を同時に出さない） */
    function applyMode() {
      const plan = mode() === 'plan';
      $qaInputs.style.display = plan ? 'none' : 'flex';
      $planInputs.style.display = plan ? 'flex' : 'none';
      $gen.textContent = plan ? '変更計画 Prompt を生成' : 'AI Prompt を生成';
      $ask.style.display = plan ? 'none' : '';
      $planBtn.style.display = plan ? '' : 'none';
      $answer.style.display = (!plan && lastAnswer) ? '' : 'none';
      $planResult.style.display = (plan && lastPlan) ? '' : 'none';
      $factDetail.style.display = 'none';
    }

    /** 接続状態 → 接続フォーム / 状態表示を切り替える */
    function renderSession() {
      let st = null;
      try { st = session.status(); } catch (e) { st = null; }
      const connected = !!st?.connected;
      const connecting = !connected && !!(flow && flow.isRunning());
      $connect.style.display = (connected || connecting) ? 'none' : 'flex';
      $connecting.style.display = connecting ? 'flex' : 'none';
      $session.style.display = connected ? 'flex' : 'none';
      $dev.style.display = devMode ? 'flex' : 'none';
      $badge.textContent = connected ? '✓ 接続済み' : connecting ? '接続中' : '未接続';
      if (connected) $sessionLines.innerHTML = KTContextUi.sessionLinesHtml(st, capability);
      return st;
    }
    function makeClient() {
      try {
        const st = session.status();
        if (!st.connected) return null;
        return session.client;
      } catch (e) {
        return { error: e };   // session の失敗も無料機能へ波及させない
      }
    }
    /** /v2/health で利用可否を判定（TTL 内は再利用）。失敗しても無料機能には影響しない */
    async function refreshCapability({ force = false } = {}) {
      if (!paidEnabled) { $paid.style.display = 'none'; return capability; }
      const client = makeClient();
      if (!client || client.error) {
        capability = { available: false, reason: client?.error ? KTAiClient.ERROR_CODES.TRANSPORT_ERROR : KTAiClient.ERROR_CODES.NOT_CONNECTED };
        setPaidStatus(KTContextUi.capabilityStatusText(capability)); setAskEnabled(); renderSession();
        return capability;
      }
      if (!force && capability.available && (Date.now() - healthAt) < KTAiClient.HEALTH_TTL_MS) { setAskEnabled(); renderSession(); return capability; }
      capability = { ...capability, checking: true };
      setPaidStatus(KTContextUi.capabilityStatusText({ checking: true })); $ask.disabled = true; renderSession();
      try {
        const health = await client.getHealth();
        capability = KTAiClient.capabilityFromHealth(health);
        healthAt = Date.now();
      } catch (e) {
        capability = { available: false, reason: KTAiClient.isAiClientError(e) ? e.code : KTAiClient.ERROR_CODES.TRANSPORT_ERROR };
      }
      setPaidStatus(KTContextUi.capabilityStatusText(capability)); setAskEnabled(); renderSession();
      return capability;
    }
    function renderAnswer(a) {
      lastAnswer = a;
      $answer.innerHTML = KTContextUi.answerHtml(a);
      $answer.style.display = '';
      $factDetail.style.display = 'none';
    }
    function renderPlan(p) {
      lastPlan = p;
      decisions.clear();
      // Toolkit 検証（決定的）。失敗しても AI の提案は表示する
      try { lastReview = KTPlanReview.review({ plan: p, ...(d.getInputs() || {}) }); } catch (e) { lastReview = null; }
      $planResult.innerHTML = KTContextUi.planHtml(p, lastReview);
      $planResult.style.display = '';
      $factDetail.style.display = 'none';
      renderMermaid($planResult);
      resetExec(); renderExec();
    }
    /** プロセスの Before / After を Mermaid で描く（mermaid があるときだけ。無ければコードのまま表示） */
    function renderMermaid(root) {
      const m = (typeof window !== 'undefined') ? window.mermaid : null;
      if (!m || typeof m.run !== 'function' || typeof root.querySelectorAll !== 'function') return;
      const nodes = [...root.querySelectorAll('pre.kt-ai-mermaid')];
      if (!nodes.length) return;
      const divs = nodes.map(pre => { const div = document.createElement('div'); div.className = 'mermaid'; div.style.fontSize = '11px'; div.textContent = pre.textContent; pre.replaceWith(div); return div; });
      try { const r = m.run({ nodes: divs }); if (r && typeof r.catch === 'function') r.catch(() => { }); } catch (e) { }
    }
    const reviewOutput = () => (lastPlan && lastReview) ? KTPlanReview.executorOutput(lastPlan, lastReview, [...decisions.entries()].filter(([, v]) => v === 'approve').map(([k]) => k)) : null;
    // ---- Preview Executor の表示・操作 ----
    const execClassified = () => { const out = reviewOutput(); return out ? KTPlanExecutor.classifySteps(out) : []; };
    function renderExec() {
      const el = host.querySelector('#kt-ai-exec'); if (!el) return;
      el.innerHTML = KTContextUi.executorHtml({ ...execState, classified: execClassified(), available: !!executor });
    }
    const resetExec = () => { execState.stage = 'idle'; execState.prepared = null; execState.execution = null; execState.error = null; execState.rollbackPlan = null; };
    /** 「動作テスト環境へ反映」: 現在の設定を取得して stale / 権限 / 再検証（書き込みなし）→ 最終確認へ */
    async function startExecutor() {
      if (!executor || execState.stage === 'running' || execState.stage === 'preparing') return null;
      const out = reviewOutput(); if (!out) return null;
      execState.stage = 'preparing'; execState.prepared = null; execState.execution = null; execState.error = null; renderExec();
      try {
        const prepared = await KTPlanExecutor.prepare(out, { api: executor.api, appId: executor.appId });
        execState.prepared = prepared;
        execState.stage = prepared.status === 'PREPARED' ? 'confirm' : 'blocked';
      } catch (e) { execState.stage = 'blocked'; execState.error = e?.message || String(e); }
      renderExec();
      return execState.prepared;
    }
    const cancelExecutor = () => { if (execState.stage === 'confirm' || execState.stage === 'blocked') { resetExec(); renderExec(); } };
    /** 最終確認の後: 動作テスト環境へ反映（dependsOn 順・Fail Stop・1 step ごとに検証）。運用環境へは反映しない */
    async function confirmExecutor() {
      if (!executor || execState.stage !== 'confirm' || !execState.prepared) return null;
      execState.stage = 'running'; renderExec();
      try {
        const inputs = d.getInputs ? (d.getInputs() || {}) : {};
        const execution = await KTPlanExecutor.executePreview(execState.prepared, { api: executor.api, review: lastReview, data: inputs.data || null, onProgress: (step, partial) => { execState.execution = partial; renderExec(); } });
        execState.execution = execution;
        execState.rollbackPlan = KTPlanExecutor.buildRollbackPlan(execution, execState.prepared);
      } catch (e) { execState.error = e?.message || String(e); execState.execution = execState.execution || { status: 'FAILED', steps: execState.prepared.steps, simulation: null, reanalysis: null }; }
      execState.stage = 'done'; renderExec();
      return execState.execution;
    }
    const auditJson = () => (lastPlan && lastReview) ? KTPlanExecutor.buildAudit({ goal: lastPlan.goal, plan: lastPlan, review: lastReview, decisions, prepared: execState.prepared, execution: execState.execution }) : null;
    /** 判断を記録し、表示中の Review JSON・判断の集計・Executor の件数を追従させる */
    const decide = (stepId, v) => {
      if (v) decisions.set(stepId, v); else decisions.delete(stepId);
      const out = reviewOutput();
      const pre = host.querySelector('#kt-ai-review-json'); if (pre && out) pre.textContent = JSON.stringify(out, null, 2);
      const sum = host.querySelector('#kt-ai-review-decisions'); if (sum && lastReview) sum.textContent = KTContextUi.decisionSummary(lastReview, decisions);
      if (execState.stage !== 'running') { if (execState.stage !== 'idle') resetExec(); renderExec(); }
    };
    /** 変更計画の作成（Planner Context を送る。設定は変更しない）。二重送信防止・requestId 保持 */
    async function plan() {
      if (!paidEnabled) return null;
      if (!last || !last.ok || last.ctx?.contextVersion !== KTContext.PLANNER_CONTEXT_VERSION) { setPaidStatus('先に「変更計画 Prompt を生成」で実現したいことの Context を作成してください。'); return null; }
      if (sending) return null;
      if (!capability.available && isTransient()) await refreshCapability({ force: true });
      if (!capability.available) { setPaidStatus(KTContextUi.capabilityStatusText(capability)); return null; }
      if (!plannerAvailable()) { capability = { ...capability }; setPaidStatus(`${KTAiClient.errorText(KTAiClient.ERROR_CODES.PLANNER_NOT_AVAILABLE)} [${capability.features?.[KTAiClient.FEATURE_PLANNER]?.reason || 'NOT_ENTITLED'}]`); return null; }
      const client = makeClient();
      if (!client || client.error) { capability = { available: false, reason: client?.error ? KTAiClient.ERROR_CODES.TRANSPORT_ERROR : KTAiClient.ERROR_CODES.NOT_CONNECTED }; setPaidStatus(KTContextUi.capabilityStatusText(capability)); setAskEnabled(); renderSession(); return null; }
      sending = true; setAskEnabled();
      const requestId = KTAiClient.newRequestId();
      setPaidStatus(`変更計画を作成しています... （requestId: ${requestId}）`);
      $planResult.style.display = 'none'; $factDetail.style.display = 'none';
      try {
        const p = await client.plan({ ctx: last.ctx, requestId });
        renderPlan(p);
        setPaidStatus(`変更計画を受信しました（手順 ${p.steps.length} 件・新規フィールド ${p.proposedFields.length} 件・確認事項 ${p.questions.length} 件${p.usage ? `・今月 ${p.usage.usedThisMonth} / ${p.usage.monthlyLimit} 回` : ''}）`);
        return p;
      } catch (e) {
        const code = KTAiClient.isAiClientError(e) ? e.code : KTAiClient.ERROR_CODES.TRANSPORT_ERROR;
        const retry = KTAiClient.isAiClientError(e) && e.retryAfterSeconds ? `（約${e.retryAfterSeconds}秒後に再実行可能）` : '';
        setPaidStatus(`${KTAiClient.errorText(code)}${retry} [${code}] requestId: ${e?.requestId || requestId}`);
        if ([KTAiClient.ERROR_CODES.AUTH_INVALID_TOKEN, KTAiClient.ERROR_CODES.AUTH_TOKEN_EXPIRED, KTAiClient.ERROR_CODES.AUTH_DOMAIN_MISMATCH,
          KTAiClient.ERROR_CODES.PRODUCT_NOT_ENTITLED, KTAiClient.ERROR_CODES.FEATURE_NOT_ENTITLED, KTAiClient.ERROR_CODES.SESSION_EXPIRED, KTAiClient.ERROR_CODES.NOT_CONNECTED].includes(code)) {
          capability = { available: false, reason: code };
          renderSession();
        }
        return null;
      } finally {
        sending = false; setAskEnabled();
      }
    }
    function showEvidence(id) {
      const fact = (last?.ctx?.facts || []).find(f => f.id === id) || null;
      $factDetail.innerHTML = KTContextUi.evidenceDetailHtml(fact);
      $factDetail.style.display = '';
      return fact;
    }
    /** 送信（二重送信防止・loading・requestId 保持）。生成済みの同じ ctx を送る */
    async function ask() {
      if (!paidEnabled) return null;
      if (!last || !last.ok) { setPaidStatus(KTAiClient.errorText(KTAiClient.ERROR_CODES.NO_CONTEXT)); return null; }
      if (sending) return null;
      if (!capability.available && isTransient()) await refreshCapability({ force: true });   // 一時的な失敗は再判定してから送る
      if (!capability.available) { setPaidStatus(KTContextUi.capabilityStatusText(capability)); return null; }
      const client = makeClient();
      if (!client || client.error) { capability = { available: false, reason: client?.error ? KTAiClient.ERROR_CODES.TRANSPORT_ERROR : KTAiClient.ERROR_CODES.NOT_CONNECTED }; setPaidStatus(KTContextUi.capabilityStatusText(capability)); setAskEnabled(); renderSession(); return null; }
      sending = true; setAskEnabled();
      const requestId = KTAiClient.newRequestId();
      setPaidStatus(`AI に送信中... （requestId: ${requestId}）`);
      $answer.style.display = 'none'; $factDetail.style.display = 'none';
      try {
        const a = await client.ask({ ctx: last.ctx, requestId });
        renderAnswer(a);
        setPaidStatus(`回答を受信しました${a.usage ? `（今月 ${a.usage.usedThisMonth} / ${a.usage.monthlyLimit} 回）` : ''}`);
        return a;
      } catch (e) {
        const code = KTAiClient.isAiClientError(e) ? e.code : KTAiClient.ERROR_CODES.TRANSPORT_ERROR;
        const retry = KTAiClient.isAiClientError(e) && e.retryAfterSeconds ? `（約${e.retryAfterSeconds}秒後に再実行可能）` : '';
        setPaidStatus(`${KTAiClient.errorText(code)}${retry} [${code}] requestId: ${e?.requestId || requestId}`);
        if ([KTAiClient.ERROR_CODES.AUTH_INVALID_TOKEN, KTAiClient.ERROR_CODES.AUTH_TOKEN_EXPIRED, KTAiClient.ERROR_CODES.AUTH_DOMAIN_MISMATCH,
          KTAiClient.ERROR_CODES.PRODUCT_NOT_ENTITLED, KTAiClient.ERROR_CODES.FEATURE_NOT_ENTITLED, KTAiClient.ERROR_CODES.SESSION_EXPIRED, KTAiClient.ERROR_CODES.NOT_CONNECTED].includes(code)) {
          capability = { available: false, reason: code };
          renderSession();
        }
        return null;
      } finally {
        sending = false; setAskEnabled();
      }
    }
    if (paidEnabled) {
      try { $apiBase.value = (session.status?.()?.apiBase) || KTAiClient.DEFAULT_API_BASE; } catch (e) { $apiBase.value = KTAiClient.DEFAULT_API_BASE; }
      // 接続（本番）: Nest Rec AI に接続 → 承認ページ（別タブ）→ 承認を待つ → 自動で接続完了。利用者は credential を扱わない
      const connectingText = (st) => {
        if (st.phase === 'starting') return '接続を準備しています...';
        if (st.phase === 'completing') return '接続を完了しています...';
        if (st.popupBlocked) return 'ブラウザがポップアップをブロックしました。「Nest Recのページを開く」を押して、Nest Rec で接続を承認してください。';
        return 'Nest Recで接続を確認しています...（別タブの Nest Rec ページで「接続する」を押してください）';
      };
      $connectStart.addEventListener('click', async () => {
        if (flow.isRunning()) return;
        $connectStart.disabled = true;
        setPaidStatus('');
        preOpen();
        try {
          await flow.start({ onState: (st) => { if (st.phase === 'failed') closePre(); $connectingText.textContent = connectingText(st); renderSession(); } });
          setPaidStatus('✓ Nest Rec AIに接続しました');
          await refreshCapability({ force: true });
          setPaidStatus(`✓ Nest Rec AIに接続しました。${KTContextUi.capabilityStatusText(capability)}`);
        } catch (e) {
          const code = KTAiClient.isAiClientError(e) ? e.code : KTAiClient.ERROR_CODES.TRANSPORT_ERROR;
          capability = { available: false, reason: code };
          setPaidStatus(`${KTAiClient.errorText(code)} [${code}]${e?.requestId ? ` requestId: ${e.requestId}` : ''}`); setAskEnabled(); renderSession();
        } finally { $connectStart.disabled = false; renderSession(); }
      });
      $openAuthorize.addEventListener('click', () => { const ok = flow.reopen(); $connectingText.textContent = ok ? connectingText({ phase: 'pending' }) : connectingText({ phase: 'pending', popupBlocked: true }); });
      $connectCancel.addEventListener('click', () => { flow.cancel(); });
      // 開発モード: Customer Token を 1 回だけ exchange（入力欄は即座に消す。保存しない）
      $connectBtn.addEventListener('click', async () => {
        const token = String($token.value || '').trim();
        $token.value = '';
        if (!token) { setPaidStatus(KTAiClient.errorText(KTAiClient.ERROR_CODES.NO_CONFIG)); return; }
        $connectBtn.disabled = true; setPaidStatus('Nest Rec AI に接続しています...');
        try {
          await session.connect(token, { apiBase: $apiBase.value || KTAiClient.DEFAULT_API_BASE });
          await refreshCapability({ force: true });
        } catch (e) {
          const code = KTAiClient.isAiClientError(e) ? e.code : KTAiClient.ERROR_CODES.TRANSPORT_ERROR;
          capability = { available: false, reason: code };
          setPaidStatus(`${KTAiClient.errorText(code)} [${code}]${e?.requestId ? ` requestId: ${e.requestId}` : ''}`); setAskEnabled(); renderSession();
        } finally { $connectBtn.disabled = false; }
      });
      $sessionRefresh.addEventListener('click', async () => {
        $sessionRefresh.disabled = true;
        try { await session.refresh(); await refreshCapability({ force: true }); }
        catch (e) {
          const code = KTAiClient.isAiClientError(e) ? e.code : KTAiClient.ERROR_CODES.TRANSPORT_ERROR;
          capability = { available: false, reason: code }; setPaidStatus(`${KTAiClient.errorText(code)} [${code}]`); setAskEnabled(); renderSession();
        } finally { $sessionRefresh.disabled = false; }
      });
      $sessionDisconnect.addEventListener('click', async () => {
        $sessionDisconnect.disabled = true;
        try {
          const r = await session.disconnect();   // memory の Access・local の Refresh を消し、Gateway 側でも family を失効
          settings.setConsent(false);
          $answer.style.display = 'none'; $factDetail.style.display = 'none';
          await refreshCapability({ force: true });
          setPaidStatus(r?.revoked ? 'Nest Rec AI との接続を解除しました。' : 'Nest Rec AI との接続を解除しました（サーバー側の失効は確認できませんでした。接続の有効期限で自動的に失効します）。');
        } finally { $sessionDisconnect.disabled = false; }
      });
      $ask.addEventListener('click', async () => {
        if (!last || !last.ok) { setPaidStatus(KTAiClient.errorText(KTAiClient.ERROR_CODES.NO_CONTEXT)); return; }
        if (!settings.hasConsent()) { $consent.style.display = ''; return; }   // 送信前の確認（初回のみ）
        await ask();
      });
      $planBtn.addEventListener('click', async () => {
        if (!last || !last.ok || last.ctx?.contextVersion !== KTContext.PLANNER_CONTEXT_VERSION) { setPaidStatus('先に「変更計画 Prompt を生成」で実現したいことの Context を作成してください。'); return; }
        if (!settings.hasConsent()) { $consent.style.display = ''; return; }
        await plan();
      });
      $planResult.addEventListener('click', async (ev) => {
        const t = ev?.target;
        const id = t?.id || (typeof t?.getAttribute === 'function' ? t.getAttribute('id') : null);
        if (id === 'kt-ai-plan-json-toggle') { const pre = host.querySelector('#kt-ai-plan-json'); if (pre) pre.style.display = pre.style.display === 'none' ? '' : 'none'; return; }
        if (id === 'kt-ai-plan-json-copy') { const ok = await d.copyText(JSON.stringify(KTContextUi.planJson(lastPlan), null, 2)); if (t) flashBtnText(t, ok ? 'Copied!' : 'Failed'); return; }
        const toggle = (sel) => { const el = host.querySelector(sel); if (el) el.style.display = el.style.display === 'none' ? '' : 'none'; };
        if (id === 'kt-ai-review-diff-toggle') { toggle('#kt-ai-review-diff'); return; }
        if (id === 'kt-ai-review-json-toggle') { toggle('#kt-ai-review-json'); return; }
        if (id === 'kt-ai-review-raw-toggle') { toggle('#kt-ai-review-raw'); return; }
        if (id === 'kt-ai-review-json-copy') { const out = reviewOutput(); const ok = out ? await d.copyText(JSON.stringify(out, null, 2)) : false; if (t) flashBtnText(t, ok ? 'Copied!' : 'Failed'); return; }
        // Preview Executor（Phase 9）
        if (id === 'kt-ai-exec-start') { await startExecutor(); return; }
        if (id === 'kt-ai-exec-cancel') { cancelExecutor(); return; }
        if (id === 'kt-ai-exec-go') { await confirmExecutor(); return; }
        if (id === 'kt-ai-exec-audit-copy') { const a = auditJson(); const ok = a ? await d.copyText(JSON.stringify(a, null, 2)) : false; if (t) flashBtnText(t, ok ? 'Copied!' : 'Failed'); return; }
        if (id === 'kt-ai-exec-audit-download') { const a = auditJson(); if (a) { const name = `toolkit-ai-execution-${execState.execution?.executionId || 'audit'}.json`; const text = JSON.stringify(a, null, 2); if (typeof d.downloadText === 'function') d.downloadText(name, text, 'application/json;charset=utf-8'); else if (typeof KTExport !== 'undefined' && KTExport.downloadText) KTExport.downloadText(name, text, 'application/json;charset=utf-8'); } return; }
        if (id === 'kt-ai-exec-snapshot-copy') { const snap = execState.execution?.snapshot || execState.prepared?.snapshot || null; const ok = snap ? await d.copyText(JSON.stringify(snap, null, 2)) : false; if (t) flashBtnText(t, ok ? 'Copied!' : 'Failed'); return; }
        if (id === 'kt-ai-exec-rollback-toggle') { toggle('#kt-ai-exec-rollback'); return; }
        const el = t && typeof t.closest === 'function' ? t.closest('[data-eid]') : t;
        const eid = el?.dataset?.eid ?? (typeof el?.getAttribute === 'function' ? el.getAttribute('data-eid') : null);
        if (eid) showEvidence(eid);
      });
      $planResult.addEventListener('change', (ev) => {
        const t = ev?.target;
        const sid = t?.dataset?.step ?? (typeof t?.getAttribute === 'function' ? t.getAttribute('data-step') : null);
        if (sid && t && 'value' in t) decide(sid, t.value);
      });
      $consentOk.addEventListener('click', async () => { settings.setConsent(true); $consent.style.display = 'none'; await (mode() === 'plan' ? plan() : ask()); });
      $consentCancel.addEventListener('click', () => { $consent.style.display = 'none'; });
      $answer.addEventListener('click', (ev) => {
        const t = ev?.target;
        const el = t && typeof t.closest === 'function' ? t.closest('[data-eid]') : t;
        const id = el?.dataset?.eid ?? (typeof el?.getAttribute === 'function' ? el.getAttribute('data-eid') : null);
        if (id) showEvidence(id);
      });
      // 初期判定（非同期。無料機能はこの結果を待たない）。旧形式の保存があれば exchange して移行する
      (async () => {
        try { if (typeof session.migrateLegacy === 'function') await session.migrateLegacy(); } catch (e) { }
        await refreshCapability();
      })();
    } else {
      $paid.style.display = 'none';
    }

    function fillTargets() {
      const inputs = d.getInputs() || {};
      const { fields, files } = KTContextUi.listTargets(inputs);
      const type = $type.value || 'app';
      if (type === 'field') {
        $target.innerHTML = fields.map(f => `<option value="${esc(f.id)}">${esc(f.label)}</option>`).join('');
        $target.style.display = '';
      } else if (type === 'file') {
        $target.innerHTML = files.length
          ? files.map(f => `<option value="${esc(f.id)}">${esc(f.label)}</option>`).join('')
          : `<option value="">（JavaScript ファイルがありません）</option>`;
        $target.style.display = '';
      } else {
        $target.innerHTML = '';
        $target.style.display = 'none';
      }
      const presets = KTContextUi.PRESETS[type] || [];
      $preset.innerHTML = `<option value="">（プリセットを選択）</option>` + presets.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
      // JS 未解析なら解析ボタンを出す
      $scan.style.display = (typeof d.runScan === 'function' && !inputs.scan) ? '' : 'none';
    }

    function showPreview() {
      if (!last || !last.ok) return;
      const view = $view.value || 'prompt';
      d.setPreview(last.outputs[view], view === 'json' ? 'json' : 'markdown');
    }

    function render(gen) {
      last = gen;
      if (!gen.ok) {
        $actions.style.display = 'none';
        $result.style.display = 'none';
        setStatus(gen.message);
        if (gen.reason === 'ambiguous') {
          $cand.innerHTML = gen.candidates.map(c => `<option value="${esc(`${c.type}:${c.id}`)}">${esc(c.label)}</option>`).join('');
          $candWrap.style.display = 'flex';
        } else {
          $candWrap.style.display = 'none';
        }
        return;
      }
      $candWrap.style.display = 'none';
      $actions.style.display = 'flex';
      $result.style.display = '';
      $result.innerHTML = KTContextUi.resultHtml(gen);
      setStatus(`生成しました（${gen.size.text}）`);
      showPreview();
    }

    function generate(override = null) {
      if (mode() === 'plan') {
        setStatus('生成中...');
        const gen = KTContextUi.generatePlan({ goal: $goal.value, inputs: d.getInputs() });
        render(gen);
        return gen;
      }
      const type = override?.type || $type.value || 'app';
      const id = override?.id ?? (type === 'app' ? null : $target.value);
      // 表示名（ラベル（コード）/ PC: name）を focus.label に渡す。識別子は常に id（フィールドコード / sourceId）
      const opt = (type !== 'app' && $target.options) ? [...$target.options].find(o => o.value === String(id)) : null;
      const label = override?.label ?? (opt ? opt.textContent : null);
      setStatus('生成中...');
      const gen = KTContextUi.generate({ targetType: type, targetId: id, targetLabel: label, question: $q.value, inputs: d.getInputs() });
      render(gen);
      return gen;
    }

    $type.addEventListener('change', () => { fillTargets(); });
    $preset.addEventListener('change', () => { if ($preset.value) $q.value = $preset.value; });
    $goalPreset.addEventListener('change', () => { if ($goalPreset.value) $goal.value = $goalPreset.value; });
    const onMode = () => { last = null; $actions.style.display = 'none'; $result.style.display = 'none'; $candWrap.style.display = 'none'; setStatus(''); applyMode(); setAskEnabled(); };
    $modeQa.addEventListener('change', onMode);
    $modePlan.addEventListener('change', onMode);
    $gen.addEventListener('click', () => generate());
    $candApply.addEventListener('click', () => {
      const v = String($cand.value || '');
      const i = v.indexOf(':');
      if (i < 0) return;
      const type = v.slice(0, i), id = v.slice(i + 1);
      // 候補を UI の対象選択にも反映し、以後は明示 focus で生成する
      $type.value = type; fillTargets(); $target.value = id;
      generate({ type, id });
    });
    $view.addEventListener('change', showPreview);
    const copy = async (btn, key) => {
      if (!last || !last.ok) { flashBtnText(btn, '先に生成'); return; }
      const ok = await d.copyText(last.outputs[key]);
      flashBtnText(btn, ok ? 'Copied!' : 'Failed');
    };
    $copyPrompt.addEventListener('click', () => copy($copyPrompt, 'prompt'));
    $copyMd.addEventListener('click', () => copy($copyMd, 'markdown'));
    $copyJson.addEventListener('click', () => copy($copyJson, 'json'));
    $scan.addEventListener('click', async () => {
      if (typeof d.runScan !== 'function') return;
      setStatus('JavaScript を解析中...');
      $scan.disabled = true;
      try {
        const r = await d.runScan();
        setStatus(r?.ok ? 'JavaScript を解析しました。再度「AI Prompt を生成」で反映されます。' : `解析できませんでした（${r?.reason || 'unknown'}）`);
      } finally {
        $scan.disabled = false;
        fillTargets();
      }
    });

    fillTargets();
    applyMode();
    return {
      regenerate: () => (last ? generate() : null),
      refreshTargets: fillTargets,
      refreshCapability, ask, plan, showEvidence,
      mode, setMode: (m) => { if ($modePlan) $modePlan.checked = (m === 'plan'); if ($modeQa) $modeQa.checked = (m !== 'plan'); onMode(); },
      lastPlan: () => lastPlan,
      lastReview: () => lastReview,
      reviewOutput,
      decide,
      // Preview Executor（Phase 9）
      executorState: () => execState,
      startExecutor, confirmExecutor, cancelExecutor, auditJson,
      lastAnswer: () => lastAnswer,
      capability: () => capability,
      currentOutput: () => {
        if (!last || !last.ok) return null;
        const view = $view.value || 'prompt';
        return { text: last.outputs[view], filename: KTContextUi.outputFilename(last.ctx, view), mime: view === 'json' ? 'application/json' : 'text/markdown' };
      },
    };
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
      font:12px/1.5 ui-sans-serif,system-ui; width:min(1280px, 95vw);
      border:1px solid ${C.border};
    `;
    wrap.innerHTML = `
      <style>
        /* ★レイアウト：Toolkit本体を「bar（固定）＋body（残り高さ・スクロール）」の縦flexにする。
           通常時は 85vh の確定高さを持たせ、子View が height:100% で追従できるようにする。
           （全画面時は inset:0 で高さが確定するので、子側に vh 指定は不要） */
        #kt-toolkit {
          bottom: 16px;
          transition: bottom .18s ease;
          display: flex;
          flex-direction: column;
          height: 85vh;
          max-height: 85vh;
          overflow: hidden;
        }

        #kt-toolkit.is-mini {
          bottom: 32px;
        }

        /* 全画面表示：画面いっぱいに広げる（内側の高さ指定も併せて広げる） */
        /* 最小化中は全画面指定を打ち消す（is-mini が優先） */
        #kt-toolkit.is-full.is-mini {
          inset: auto !important;
          right: 16px !important;
          bottom: 32px !important;
          width: auto !important;
          height: auto !important;
          max-height: none !important;
          border-radius: 12px !important;
        }

        #kt-toolkit.is-full {
          /* width:100vw は縦スクロールバーの幅を含み、横にはみ出す。
             fixed要素なので上下左右を0にするだけで画面いっぱいになる。 */
          top: 0 !important;
          right: 0 !important;
          bottom: 0 !important;
          left: 0 !important;
          width: auto !important;
          max-width: none !important;
          height: auto !important;
          max-height: none !important;
          border-radius: 0 !important;
          border: none !important;
        }
        /* 全画面のときは、図を画面の高さに合わせて広げる
           （タブが2段になる場合を考慮して余裕を持たせる）
           ※ Field Scanner の結果領域は flex で親に追従するようになったため、ここでの上書きは不要 */
        #kt-toolkit.is-full #dp-canvas { max-height: calc(100vh - 360px) !important; }

        #kt-toolkit .bar{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid ${C.border};flex:none;}
        #kt-toolkit .tabs{display:flex;gap:6px;flex-wrap:wrap}
        #kt-toolkit .tab{padding:6px 10px;border:1px solid ${C.border};background:${C.bgSub};color:${C.text};border-radius:8px;cursor:pointer}
        #kt-toolkit .tab.active{background:#2563eb;border-color:#2563eb;color:#fff;} /* Activeは色固定 */
        #kt-toolkit .btn{padding:6px 10px;border:1px solid ${C.border};background:${C.bgSub};color:${C.text};border-radius:8px;cursor:pointer}
        /* body が唯一の縦スクロール領域（bar は固定） */
        #kt-toolkit .body{padding:12px; flex:1 1 0%; min-height:0; overflow:auto;}
        /* 各タブ内 view の高さをそろえる（bodyの利用可能高さ基準。vh固定はやめる） */
        #kt-toolkit .body > div[id^="view-"]{
          min-height: 100%;
        }
        /* flexで高さ追従させるタブ（Templates / Customize / Field Scanner / Plugins） */
        #kt-toolkit .body > .kt-fill-view{
          height: 100%;
          min-height: 0;
        }

        /* ===== 共通レイアウトクラス（4タブで同じサイズ制御ルールを使う） ===== */
        /* 2カラム分割のルート：親Viewの高さを使い切る */
        #kt-toolkit .kt-split-layout{
          height: 100%;
          min-height: 0;
          display: flex;
          align-items: stretch;
          gap: 14px;
        }
        /* 縦flexコンテナ（min-width/min-height:0 で子が親からはみ出さないようにする） */
        #kt-toolkit .kt-flex-column{
          display: flex;
          flex-direction: column;
          min-width: 0;
          min-height: 0;
        }
        /* 分割の各カラム：最小幅は --kt-col-min で個別指定（.kt-flex-column の min-width:0 より後に置いて優先させる） */
        #kt-toolkit .kt-split-col{
          min-width: var(--kt-col-min, 240px);
        }
        /* 残り領域を使う可変ブロック（Monacoホストなど。スクロールは中身側） */
        #kt-toolkit .kt-flex-fill{
          flex: 1 1 0%;
          min-width: 0;
          min-height: 0;
        }
        /* 残り領域を使い、内部だけスクロールする領域（一覧・テーブル・結果表示） */
        #kt-toolkit .kt-scroll-area{
          flex: 1 1 0%;
          min-width: 0;
          min-height: 0;
          overflow: auto;
        }
        /* 固定高さのパーツ（ツールバー等）。flex縮小で潰れないようにする */
        #kt-toolkit .kt-flex-fixed{
          flex: none;
        }
        /* 幅が狭いときは2カラム→縦積み（各カラムが高さを分け合う） */
        @media (max-width: 760px){
          #kt-toolkit .kt-split-layout{ flex-direction: column; }
          #kt-toolkit .kt-split-layout > .kt-split-col{ min-width: 0; flex: 1 1 0% !important; }
        }
        #kt-toolkit.is-mini{
          width:auto !important; max-width:calc(100vw - 32px) !important;
          height:auto !important; max-height:none !important; overflow:visible !important;
        }
        #kt-toolkit.is-mini .body{ display:none !important; }
        #kt-toolkit.is-mini .tabs{ display:none !important; }
        #kt-toolkit.is-mini #kt-full{ display:none !important; }

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
          <button id="tab-deps" class="tab" title="依存関係グラフ（フィールド・設定・JS・他アプリ）">Deps</button>
          <button id="tab-notice" class="tab">Notices</button>
          <button id="tab-acl" class="tab">Access Control</button>
          <button id="tab-templates" class="tab">Templates</button>
          <button id="tab-customize" class="tab">Customize</button>
          <button id="tab-field-scanner" class="tab">Field Scanner</button>
          <button id="tab-plugins" class="tab">Plugins</button>
        </div>
        <div class="actions" style="display:flex;gap:6px;align-items:center;">
          <button id="kt-full" class="btn" title="全画面表示に切り替え（もう一度押すと戻ります）">⛶</button>
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
        <div id="view-deps" style="display:none"></div>
        <div id="view-notice" style="display:none"></div>
        <div id="view-acl" style="display:none"></div>
        <div id="view-templates" class="kt-fill-view" style="display:none"></div>
        <div id="view-customize" class="kt-fill-view" style="display:none"></div>
        <div id="view-field-scanner" class="kt-fill-view" style="display:none"></div>
        <div id="view-plugins" class="kt-fill-view" style="display:none;"></div>
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
    // 全画面表示の切り替え
    //   既定は従来どおりのパネル表示。kintoneの画面を後ろに見ながら使いたい場面があるため、
    //   全画面は「切り替えて使うモード」として提供する。
    const FULL_KEY = 'ktToolkitFull.v1';
    const btnFull = wrap.querySelector('#kt-full');
    const applyFull = (on) => {
      wrap.classList.toggle('is-full', !!on);
      if (btnFull) {
        btnFull.textContent = on ? '⤢' : '⛶';
        btnFull.title = on ? 'パネル表示に戻す' : '全画面表示に切り替え（もう一度押すと戻ります）';
      }
    };
    let isFull = false;
    try { isFull = localStorage.getItem(FULL_KEY) === '1'; } catch (e) { }
    applyFull(isFull);
    btnFull?.addEventListener('click', () => {
      isFull = !isFull;
      try { localStorage.setItem(FULL_KEY, isFull ? '1' : '0'); } catch (e) { }
      applyFull(isFull);
    }, { passive: true });

    const btnMini = wrap.querySelector('#kt-mini');
    btnMini && btnMini.addEventListener('click', toggleMini, { passive: true });
    const btnVer = wrap.querySelector('#kt-version');
    btnVer && btnVer.addEventListener('click', () => window.open(githubURL, '_blank', 'noopener'), { passive: true });

    const TABS = ['health', 'fields', 'views', 'graphs', 'relations', 'deps', 'notice', 'acl', 'templates', 'customize', 'field-scanner', 'plugins'];

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

    // Mermaidのラベルを壊す文字とHTMLタグ由来の文字をまとめて除去する
    const esc = (s) => String(s || '')
      .replace(/["`]/g, "'")
      .replace(/[<>{}[\]|]/g, ' ')
      .replace(/\r?\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

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

  /**
   * 存在しないフィールドコードへの参照を Healthタブに表示する
   * renderHealth の初回描画時と、JavaScript解析の完了後の両方から呼ぶ。
   * （Healthタブ全体を再描画すると、ステータス分布のレコード取得が再実行されるため分離している）
   */
  function renderBrokenRefs(root, deps) {
    const el = root.querySelector('#view-health');
    if (!el) return;
    const host = el.querySelector('#kt-broken');
    if (!host) return;
    if (!deps) { host.style.display = 'none'; return; }

    let broken = [];
    try {
      broken = KTDeps.findBrokenRefs(deps);
    } catch (e) {
      console.error('[Health] 整合性チェックに失敗しました', e);
      host.style.display = 'none';
      return;
    }

    const scannerDone = !!(deps?.meta?.scannerMergedAt);
    const jsNote = scannerDone
      ? ''
      : '（JavaScriptは未解析です。Field Scannerで「Scan」を実行すると対象になります）';

    if (!broken.length) {
      host.innerHTML = `
        <div style="border:1px solid #16a34a55;background:#16a34a0f;border-radius:8px;padding:8px 10px;font-size:12px">
          ✅ <b>設定の整合性チェック</b>：存在しないフィールドコード・ステータス名への参照は見つかりませんでした。
          <span style="opacity:.75">${escapeHtml(jsNote)}</span>
        </div>`;
      return;
    }

    const CONF_JA = { CERTAIN: '確実', LIKELY: '可能性が高い', UNCERTAIN: '要確認' };
    const CONF_COLOR = { CERTAIN: '#ef4444', LIKELY: '#f59e0b', UNCERTAIN: '#6b7280' };
    const confBadge = (c) => `<span style="display:inline-block;padding:0 6px;border:1px solid ${CONF_COLOR[c] || '#888'}66;
      color:${CONF_COLOR[c] || '#888'};border-radius:999px;font-size:10px;white-space:nowrap">${escapeHtml(CONF_JA[c] || c)}</span>`;

    const rows = broken.map(b => `
      <tr>
        <td style="padding:4px 6px;white-space:nowrap">${escapeHtml(b.category)}</td>
        <td style="padding:4px 6px"><code>${escapeHtml(b.code)}</code></td>
        <td style="padding:4px 6px">${escapeHtml(b.role)}</td>
        <td style="padding:4px 6px;font-size:11px;opacity:.85">${escapeHtml(b.detail || b.settingName)}</td>
        <td style="padding:4px 6px">${confBadge(b.confidence)}</td>
      </tr>`).join('');

    const jsCount = broken.filter(b => b.source === 'JS').length;
    const setCount = broken.length - jsCount;
    const summaryParts = [];
    if (setCount) summaryParts.push(`設定 ${setCount} 件`);
    if (jsCount) summaryParts.push(`JavaScript ${jsCount} 件`);

    host.innerHTML = `
      <div style="border:1px solid #ef444455;background:#ef44440f;border-radius:8px;padding:8px 10px">
        <details open>
          <summary style="cursor:pointer;font-size:12px;font-weight:600">
            ⚠️ 存在しない参照が ${broken.length} 件あります（${escapeHtml(summaryParts.join(' / '))}）
          </summary>
          <div style="font-size:11px;opacity:.85;margin:6px 0 8px;line-height:1.7">
            フィールドの削除・コード変更のあとに、参照側が更新されていない可能性があります。<br>
            kintoneはフィールドを削除すると一覧や通知などの<b>設定からは自動的に取り除きます</b>が、
            <b>JavaScriptは対象外</b>のため、古い参照がそのまま残ります（動かない処理・エラーの原因になります）。<br>
            <span style="opacity:.8">
              ・<b>確実</b>＝設定値として記録されたコードが存在しない
              ・<b>可能性が高い</b>＝フィールド操作APIやrecord参照の引数に指定されている
              ・<b>要確認</b>＝フィールド系の配列に書かれているが、用途は特定できない<br>
              ※ 表示ラベル・選択肢値などフィールドコードとして使われていない文字列は対象外です。
              テンプレートリテラルのように実行時にフィールドコードが決まる参照も、存在の有無を判断できないため検査していません。
            </span>
          </div>
          <div style="max-height:240px;overflow:auto">
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead><tr style="opacity:.7">
                <th style="text-align:left;padding:4px 6px">種別</th>
                <th style="text-align:left;padding:4px 6px">存在しないコード / 名前</th>
                <th style="text-align:left;padding:4px 6px">検出パターン / 箇所</th>
                <th style="text-align:left;padding:4px 6px">ファイル・設定名</th>
                <th style="text-align:left;padding:4px 6px">確度</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          <div style="margin-top:8px;display:flex;justify-content:flex-end">
            <button id="kt-broken-copy" class="btn" style="padding:2px 10px;font-size:11px">Copy MD</button>
          </div>
        </details>
      </div>`;

    host.querySelector('#kt-broken-copy')?.addEventListener('click', async () => {
      const md = [
        '# 存在しない参照（フィールドコード・ステータス名）',
        '',
        '| 種別 | コード / 名前 | 検出パターン / 箇所 | ファイル・設定名 | 確度 |',
        '| --- | --- | --- | --- | --- |',
        ...broken.map(b => `| ${b.category} | \`${b.code}\` | ${b.role} | ${b.detail || b.settingName} | ${CONF_JA[b.confidence] || b.confidence} |`),
      ].join('\n');
      const btn = host.querySelector('#kt-broken-copy');
      try {
        await navigator.clipboard.writeText(md);
        flashBtnText(btn, 'Copied!');
      } catch (e) {
        flashBtnText(btn, 'Failed');
      }
    }, { passive: true });
  }

  // renderHealth
  const renderHealth = async (
    root,
    {
      appId, fields, status, views, reports, customize,
      generalNotify, perRecordNotify, reminderNotify,
      appAcl, recordAcl, fieldAcl,
      actions, plugins, deps
    }
  ) => {
    let TH = loadTH();

    // カードの枠線などに使うテーマ色（ライト／ダーク両対応）
    const C = getThemeColors();

    // 計算式チェーンの状況（依存関係データがある場合のみ）
    let calcStats = null;
    try {
      if (deps) calcStats = KTDeps.calcChainStats(deps);
    } catch (e) {
      console.error('[Health] 計算式チェーンの集計に失敗しました', e);
    }

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

    // カード右上に出す判定バッジ（現在値としきい値の関係を一目で示す）
    //   色は判定に合わせ、しきい値はツールチップで補足する
    const HEALTH_BADGE_COLOR = { OK: '#16a34a', YELLOW: '#f59e0b', RED: '#ef4444' };
    const healthBadge = (sc, th, caption = '') => {
      const color = HEALTH_BADGE_COLOR[sc.level] || '#6b7280';
      const title = `${th.label}：現在値の判定は ${sc.level}（Y=${th.Y} で注意 / R=${th.R} で危険）`;
      return `<span title="${escapeHtml(title)}"
        style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:999px;
               border:1px solid ${color}66;color:${color};font-size:10px;white-space:nowrap;">
        <span>${sc.badge}</span>${caption ? `<span style="opacity:.85">${escapeHtml(caption)}</span>` : ''}
      </span>`;
    };

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

          <!-- 上段：3カード（判定バッジ・しきい値を内包）-->
          <div style="
            display:grid;
            grid-template-columns:repeat(3,minmax(0,1fr));
            gap:10px;
          ">
            <!-- Fields Card -->
            <div style="
              border:1px solid ${C.border};
              border-radius:8px;
              padding:8px 10px;
              display:flex;
              flex-direction:column;
              gap:4px;
            ">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
                <div style="font-size:12px;opacity:.8;">フォーム構成 / Fields</div>
                ${healthBadge(score.totalFields, TH.totalFields)}
              </div>
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
              border:1px solid ${C.border};
              border-radius:8px;
              padding:8px 10px;
              display:flex;
              flex-direction:column;
              gap:4px;
            ">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
                <div style="font-size:12px;opacity:.8;">プロセス管理 / Process</div>
                <div style="display:flex;gap:4px;">
                  ${healthBadge(score.states, TH.states, 'States')}
                  ${healthBadge(score.actions, TH.actions, 'Actions')}
                </div>
              </div>
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
              border:1px solid ${C.border};
              border-radius:8px;
              padding:8px 10px;
              display:flex;
              flex-direction:column;
              gap:4px;
            ">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
                <div style="font-size:12px;opacity:.8;">ロジック / アクセス制御</div>
                <span style="font-size:10px;opacity:.55;white-space:nowrap;">基準なし</span>
              </div>

              <!-- メイン指標：JS / ACL -->
              <div style="font-size:18px;font-weight:700;">
                ${metrics.jsFiles ?? '-'}
                <span style="font-size:11px;font-weight:400;opacity:.7;">JS</span>
                <span style="margin:0 6px;">/</span>
                ${metrics.roles ?? '-'}
                <span style="font-size:11px;font-weight:400;opacity:.7;">ACL</span>
              </div>
              <div style="font-size:11px;opacity:.75;">
                アプリの制御ロジックの複雑さの目安です。
                ${calcStats && calcStats.calcFields
      ? `<br>計算式 ${calcStats.calcFields} 個 / 最大 ${calcStats.maxDepth} 段${calcStats.maxDepth >= 3
        ? `<span title="計算式が多段になっていると、1つ変えたときの波及が読みにくくなります">（${escapeHtml(calcStats.deepest[0].name)} が最長）</span>`
        : ''}`
      : ''}
              </div>
            </div>
          </div>

          <div style="font-size:11px;opacity:.7;">
            バッジは現在値としきい値（Y=注意 / R=危険）の関係を示します。
            上部の「基準 / Thresholds」ボタンから各指標の Y / R を編集できます。
          </div>

          <!-- 設定の整合性チェック（壊れた参照） -->
          <div id="kt-broken"></div>

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

    // --- 設定の整合性チェック（存在しないフィールドコードへの参照）---
    renderBrokenRefs(root, deps);

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
  const renderFields = async (root, { appId, fields, layout, usageData, deps }) => {

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
    // deps（依存関係データ）があればエッジから生成。無ければ既存ロジックにフォールバック
    const usagePlacesMap = deps
      ? KTDeps.usageMapFromEdges(deps.edges)
      : (usageData ? extractUsedFields(usageData, allFieldCodes) : {});

    // ★変更影響はフィールドごとに一度だけ算出してMapに保持する（行描画時の再計算を避ける）
    let impactMap = null;
    if (deps) {
      try {
        impactMap = new Map();
        for (const code of allFieldCodes) impactMap.set(code, KTDeps.impactOf(deps, code));
      } catch (e) {
        console.error('[KTDeps] 変更影響の算出に失敗しました', e);
        impactMap = null;
      }
    }

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

    // フィールド形式の絞り込み用の選択肢
    //   実在する形式だけを、件数の多い順に並べる（使われていない形式は出さない）
    const typeOptions = (() => {
      const counts = new Map();
      for (const r of rows) {
        const key = r.type || '(不明)';
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      return [...counts.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count || String(a.type).localeCompare(String(b.type)));
    })();

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
        <div style="font-weight:700">Field Inventory</div>

        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;justify-content:flex-end;flex:1;min-width:0">
          <input id="fi-search" type="search"
            placeholder="検索（名前 / コード）"
            style="
              width: 200px;
              padding: 6px 10px;
              border-radius: 10px;
              border: 1px solid ${C.border};
              background: ${C.bgInput};
              color: ${C.text};
              outline: none;
              transition: border .15s ease;
            "
          />

          <select id="fi-type" title="フィールド形式で絞り込みます"
            style="padding:6px 8px;border-radius:10px;border:1px solid ${C.border};
                   background:${C.bgInput};color:${C.text};outline:none;max-width:190px">
            <option value="">形式：すべて（${rows.length}）</option>
            ${typeOptions.map(o => `<option value="${escapeHtml(o.type)}">${escapeHtml(o.type)}（${o.count}）</option>`).join('')}
          </select>

          <label style="display:flex;align-items:center;gap:4px;user-select:none;white-space:nowrap"
                 title="フィールド名とフィールドコードが異なる行を色付けします">
            <input id="fi-hl-toggle" type="checkbox" ${highlightOn ? 'checked' : ''} style="margin:0">
            <span style="opacity:.9">名称≠コード</span>
          </label>

          <label style="display:flex;align-items:center;gap:4px;user-select:none;white-space:nowrap"
                 title="スペース・ラベル・罫線などの要素IDも一覧に表示します">
            <input id="fi-elem-toggle" type="checkbox" ${showElements ? 'checked' : ''} style="margin:0">
            <span style="opacity:.9">要素ID</span>
          </label>

          <select id="fi-format" title="出力する形式を選びます"
            style="padding:6px 8px;border-radius:10px;border:1px solid ${C.border};
                   background:${C.bgInput};color:${C.text};outline:none">
            <option value="md" selected>Markdown</option>
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
            <option value="deps">依存関係JSON</option>
          </select>
          <button id="fi-copy" class="btn" title="選択した形式をクリップボードへコピーします">Copy</button>
          <button id="fi-dl" class="btn" title="選択した形式をファイルとして保存します">DL</button>
          <!-- ★状態表示とボタンは1組で扱い、折り返しで分断されないようにする -->
          <span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap">
            <span id="fi-scan-state" style="font-size:11px;opacity:.75"></span>
            <button id="fi-scan-js" class="btn" title="JavaScriptを解析して、使用箇所・変更影響に反映します">JS解析</button>
          </span>
        </div>
      </div>

      <div id="kt-fields">
        <table>
          <thead><tr>
            <th>フィールド名</th><th>フィールドコード</th><th>フィールド形式</th>
            <th>必須</th><th>重複禁止</th><th>初期値</th>
            <th>グループ / テーブル</th>
            <th title="この依存関係データで検出された利用箇所の件数（直接利用）">利用数</th>
            <th>詳細</th>
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
          <td class="fi-usage-cell" style="text-align:right;white-space:nowrap"></td>
          <td class="fi-detail-cell"></td>
        `;

        applyRowClass(tr, r, loadHL()); //
        // --- 詳細
        const places = Array.isArray(r.usagePlaces) ? r.usagePlaces : [];
        const detailObj = buildDetail(r._raw);
        // ★変更影響：解析済みの依存関係データから算出（描画のたびに再解析はしない）
        const impact = impactMap ? impactMap.get(r.code) : null;
        // 計算式ツリーは計算式を持つフィールドだけ組み立てる（不要な再帰を避ける）
        const calcTree = (deps && detailObj?.calcExpression)
          ? KTDeps.buildCalcTree(deps, r.code)
          : null;
        const detailHtml = buildDetailHtml(detailObj, places, impact, calcTree);

        // --- 利用数（直接利用の件数）とグラフへの導線
        const usageCell = tr.querySelector('.fi-usage-cell');
        if (usageCell) {
          const cnt = impact ? impact.counts.direct : null;
          if (cnt === null) {
            usageCell.textContent = '—';
            usageCell.title = '依存関係データを生成できませんでした';
          } else {
            const num = document.createElement('span');
            num.textContent = String(cnt);
            // 未使用（0件）は目立たせて、棚卸しの手がかりにする
            if (cnt === 0) {
              num.style.opacity = '.6';
              num.title = '利用箇所が検出されませんでした（解析対象外の設定で使われている可能性はあります）';
            } else {
              num.title = `直接 ${cnt} 件 / 間接 ${impact.counts.indirect} 件 / 他アプリ連携 ${impact.counts.crossApp} 件`;
            }
            usageCell.appendChild(num);

            // Depsタブでこのフィールドを起点にしたグラフを開く
            const graphBtn = document.createElement('button');
            graphBtn.type = 'button';
            graphBtn.className = 'fi-graph-btn';
            graphBtn.textContent = '図';
            graphBtn.title = 'Depsタブでこのフィールドを起点にしたグラフを表示します';
            graphBtn.addEventListener('click', () => openDepsGraphFor(root, r.code), { passive: true });
            usageCell.appendChild(graphBtn);
          }
        }

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
          td.colSpan = 9;
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

    // フリーワード（名称・コード）と、フィールド形式のAND条件で絞り込む
    //   形式はドロップダウンで選ぶため、検索文字列には混ぜない
    const filterRows = (q, type) => {
      const qq = norm(q).trim();
      const ty = String(type || '');

      return rows.filter(r => {
        if (ty && (r.type || '(不明)') !== ty) return false;
        if (!qq) return true;
        const target = [r.label, r.code].map(norm).join(' | ');
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

    const elType = el.querySelector('#fi-type');

    const applySearch = () => {
      const q = elSearch.value || '';
      const type = elType ? elType.value : '';
      const filtered = filterRows(q, type);
      renderRows(filtered);
    };

    const applySearchDebounced = debounce(applySearch, 150);

    elSearch.addEventListener('input', applySearchDebounced, { passive: true });
    // ドロップダウンは選択が確定するため、待たずに即時反映する
    elType?.addEventListener('change', applySearch, { passive: true });

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
      await renderFields(root, { appId, fields, layout, usageData, deps });
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
      // 依存関係データがある場合のみ意味を持つ列（無い場合は空欄）
      { header: '利用数(直接)', select: r => (impactMap ? String(impactMap.get(r.code)?.counts.direct ?? 0) : '') },
      { header: '利用数(間接)', select: r => (impactMap ? String(impactMap.get(r.code)?.counts.indirect ?? 0) : '') },
      { header: '利用数(他アプリ)', select: r => (impactMap ? String(impactMap.get(r.code)?.counts.crossApp ?? 0) : '') },
    ];

    // クリップボード／DL を KTExport に統一
    // ---- 出力（Copy / DL）----
    // 形式はセレクトで選ぶ。フィールド一覧は現在の絞り込みではなく全件を対象にする
    // （絞り込みは画面上の閲覧用で、出力は資料として全件必要なことが多いため）。
    const $format = el.querySelector('#fi-format');

    /**
     * 選択中の形式で出力内容を組み立てる
     * @returns {{text:string, filename:string, mime:string}|null}
     */
    const buildFieldsOutput = () => {
      const fmt = $format ? $format.value : 'md';
      switch (fmt) {
        case 'csv':
          return {
            // Excelでの文字化けを避けるためBOMを付ける
            text: '\uFEFF' + KTExport.toCSVString(rows, FD_COLUMNS),
            filename: `kintone_fields_${appId}.csv`,
            mime: 'text/csv;charset=utf-8',
          };
        case 'json':
          return {
            text: JSON.stringify(rows, null, 2),
            filename: `kintone_fields_${appId}.json`,
            mime: 'application/json;charset=utf-8',
          };
        case 'deps':
          if (!deps) return null;
          return {
            text: KTDeps.toJSON(deps),
            filename: `kintone_dependencies_${appId}.json`,
            mime: 'application/json;charset=utf-8',
          };
        case 'md':
        default:
          return {
            text: KTExport.toMarkdownString(rows, FD_COLUMNS),
            filename: `kintone_fields_${appId}.md`,
            mime: 'text/markdown;charset=utf-8',
          };
      }
    };

    el.querySelector('#fi-copy').addEventListener('click', async () => {
      const btn = el.querySelector('#fi-copy');
      let out = null;
      try {
        out = buildFieldsOutput();
      } catch (e) {
        console.error('[Fields] 出力の生成に失敗しました', e);
        flashBtnText(btn, 'Failed');
        return;
      }
      if (!out) { flashBtnText(btn, 'No data'); return; }
      const ok = await KTExport.copyText(out.text);
      flashBtnText(btn, ok ? 'Copied!' : 'Failed');
    }, { passive: true });

    el.querySelector('#fi-dl').addEventListener('click', () => {
      const btn = el.querySelector('#fi-dl');
      let out = null;
      try {
        out = buildFieldsOutput();
      } catch (e) {
        console.error('[Fields] 出力の生成に失敗しました', e);
        flashBtnText(btn, 'Failed');
        return;
      }
      if (!out) { flashBtnText(btn, 'No data'); return; }
      KTExport.downloadText(out.filename, out.text, out.mime);
      flashBtnText(btn);
    }, { passive: true });

    // ★JS解析：Scannerタブへ移動しなくても、ここから実行・状態確認できるようにする
    const $scanBtn = el.querySelector('#fi-scan-js');
    const $scanState = el.querySelector('#fi-scan-state');
    // 表示は短く保ち、詳しい説明は title（ツールチップ）に逃がす
    const SCAN_STATE_TEXT = {
      idle: 'JS未解析', running: '解析中…', done: 'JS解析済み',
      cached: 'JS解析済み', skipped: '自動解析OFF', error: '解析失敗',
    };
    const SCAN_STATE_TITLE = {
      idle: 'JavaScriptは未解析です。「JS解析」で使用箇所・変更影響に反映されます。',
      running: 'JavaScriptを解析しています。',
      done: 'JavaScriptの解析結果を反映済みです。',
      cached: 'キャッシュした解析結果を反映済みです。最新にするには「JS解析」を押してください。',
      skipped: '自動解析はオフです（Field Scannerタブで切り替えできます）。',
      error: 'JavaScriptの解析に失敗しました。詳細はコンソールを確認してください。',
    };
    const paintScanState = (st) => {
      if (!$scanState || !$scanBtn) return;
      $scanState.textContent = SCAN_STATE_TEXT[st.state] || '';
      $scanState.title = SCAN_STATE_TITLE[st.state] || '';
      $scanBtn.disabled = (st.state === 'running') || !st.available;
      $scanBtn.textContent = (st.state === 'running') ? '解析中…' : 'JS解析';
    };
    paintScanState(KTScan.getStatus());
    // 状態変化を購読（この購読は次回のrenderFieldsで作り直されるため、都度解除する）
    if (el._ktScanUnsub) { try { el._ktScanUnsub(); } catch (e) { } }
    el._ktScanUnsub = KTScan.onChange(paintScanState);

    $scanBtn?.addEventListener('click', async () => {
      // 手動実行はキャッシュを無視して取り直す
      await KTScan.run({ force: true });
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

  /**
   * 変更影響（KTDeps.impactOf の結果）を折りたたみHTMLに変換する
   * - 断定を避けるため、各行に確度バッジを付ける
   * - 件数が多い場合に備え、既定は折りたたみ
   */
  function buildImpactHtml(impact) {
    if (!impact) return '';
    const { direct = [], indirect = [], crossApp = [], cautions = [], counts } = impact;
    const total = (counts?.direct || 0) + (counts?.indirect || 0) + (counts?.crossApp || 0);

    const CONF_JA = { CERTAIN: '確実', LIKELY: '可能性が高い', UNCERTAIN: '要確認', NOT_ANALYZED: '解析対象外' };
    const CONF_COLOR = { CERTAIN: '#16a34a', LIKELY: '#f59e0b', UNCERTAIN: '#6b7280', NOT_ANALYZED: '#6b7280' };
    const confBadge = (c) => `<span class="fi-conf" style="border-color:${CONF_COLOR[c] || '#888'}55;color:${CONF_COLOR[c] || '#888'}">${escapeHtml(CONF_JA[c] || c)}</span>`;

    const line = (categoryText, mainText, subText, conf) => `
      <div class="fi-imp-row">
        <span class="fi-badge">${escapeHtml(categoryText)}</span>
        <span class="fi-imp-main">${escapeHtml(mainText)}</span>
        ${subText ? `<span class="fi-imp-sub">${escapeHtml(subText)}</span>` : ''}
        ${conf ? confBadge(conf) : ''}
      </div>`;

    const block = (title, rowsHtml, count) => rowsHtml
      ? `<div class="fi-imp-block"><div class="fi-imp-title">${escapeHtml(title)}（${count}）</div>${rowsHtml}</div>`
      : '';

    const directHtml = direct
      .map(d => line(d.category, `${d.title} — ${d.role}`, d.note, d.confidence)).join('');
    const indirectHtml = indirect
      .map(d => line(d.category, `${d.title} — ${d.role}`, d.via, d.confidence)).join('');
    const crossHtml = crossApp
      .map(c => line('他アプリ', c.text, c.note, c.confidence)).join('');
    // 操作の種類ごとに注意事項をまとめる（何をしたいかで見る場所が変わるため）
    const operations = impact.operations || [];
    const cautionHtml = operations.length
      ? operations.map(o => `
          <div class="fi-imp-block">
            <div class="fi-imp-title">${escapeHtml(o.label)}</div>
            ${o.notes.map(n => `<div class="fi-imp-caution">・${escapeHtml(n)}</div>`).join('')}
          </div>`).join('')
      : (cautions.length
        ? `<div class="fi-imp-block"><div class="fi-imp-title">変更時の確認事項</div>` +
          cautions.map(c => `<div class="fi-imp-caution">・${escapeHtml(c)}</div>`).join('') + `</div>`
        : '');

    if (!total && !cautions.length && !(impact.operations || []).length) return '';

    const summary = total
      ? `変更・削除時の影響候補：直接 ${counts.direct} 件／間接 ${counts.indirect} 件／他アプリ連携 ${counts.crossApp} 件`
      : '変更・削除時の影響候補：検出なし';

    return `
      <div class="fi-detail-item" style="align-items:flex-start">
        <div class="fi-detail-k">変更影響: </div>
        <div class="fi-detail-v" style="flex:1;min-width:0">
          <details class="fi-imp">
            <summary class="fi-imp-summary">${escapeHtml(summary)}</summary>
            <div class="fi-imp-body">
              ${block('直接利用', directHtml, counts.direct)}
              ${block('間接利用（計算式経由）', indirectHtml, counts.indirect)}
              ${block('他アプリ連携', crossHtml, counts.crossApp)}
              ${cautionHtml}
              <div class="fi-imp-note">※ 条件式・計算式・JavaScriptの解析は文字列解析による推定を含みます。確度が「可能性が高い」「要確認」の項目は実物での確認をおすすめします。</div>
            </div>
          </details>
        </div>
      </div>`;
  }

  function buildDetailHtml(detail, usagePlaces, impact = null, calcTree = null) {
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

    // 計算式が別の計算フィールドを参照している場合、参照の連なりをツリーで示す
    // （1段だけでは波及範囲が読めないため）
    if (calcTree && calcTree.children && calcTree.children.length) {
      const depth = KTDeps.calcTreeDepth(calcTree);
      items.push(`
        <div class="fi-detail-item" style="align-items:flex-start">
          <div class="fi-detail-k">参照ツリー: </div>
          <div class="fi-detail-v" style="flex:1;min-width:0">
            <div style="font-size:11px;opacity:.7;margin-bottom:2px">深さ ${depth} 段</div>
            <pre style="margin:0;font-size:11px;line-height:1.6;white-space:pre;overflow:auto">${escapeHtml(KTDeps.calcTreeToText(calcTree))}</pre>
          </div>
        </div>`);
    }

    // ★変更影響（依存関係データがある場合のみ）
    const impactHtml = buildImpactHtml(impact);
    if (impactHtml) items.push(impactHtml);

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

    /* ★変更影響（Fieldsタブ詳細内）: 色は currentColor 基準にしてダークモードでも破綻させない */
    .fi-imp > summary{
      cursor: pointer; font-size: 12px; padding: 4px 0; outline: none;
    }
    .fi-imp-body{
      margin-top: 6px; padding: 8px 10px;
      border: 1px solid currentColor; border-color: color-mix(in srgb, currentColor 20%, transparent);
      border-radius: 8px;
    }
    .fi-imp-block{ margin-bottom: 10px; }
    .fi-imp-block:last-of-type{ margin-bottom: 0; }
    .fi-imp-title{ font-weight: 600; font-size: 11px; opacity: .8; margin-bottom: 4px; }
    .fi-imp-row{
      display: flex; align-items: center; gap: 6px;
      flex-wrap: wrap; padding: 2px 0; font-size: 12px; line-height: 1.6;
    }
    .fi-imp-main{ }
    .fi-imp-sub{ font-size: 11px; opacity: .7; }
    .fi-conf{
      display: inline-block; padding: 0 6px; border: 1px solid;
      border-radius: 999px; font-size: 10px; line-height: 1.6; white-space: nowrap;
    }
    .fi-imp-caution{ font-size: 11px; line-height: 1.8; opacity: .9; }
    .fi-imp-note{ margin-top: 8px; font-size: 10px; opacity: .65; line-height: 1.6; }

    /* ★Fieldsタブ：Depsタブへの導線ボタン */
    .fi-graph-btn{
      margin-left: 6px; padding: 0 6px; font-size: 10px; line-height: 1.6;
      border: 1px solid currentColor; border-radius: 999px;
      background: transparent; color: inherit; cursor: pointer; opacity: .7;
    }
    .fi-graph-btn:hover{ opacity: 1; }

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
  // ★修正：code2label が Map / plain object のどちらでも動くように（従来はMapだと無効だった）
  function labelizeQueryPart(part, code2label) {
    if (!part) return part;
    const codes = ((code2label instanceof Map)
      ? [...code2label.keys()]
      : Object.keys(code2label || {}))
      .sort((a, b) => b.length - a.length);
    let out = part;
    for (const code of codes) {
      const label = KTDeps.labelOf(code2label, code);
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
          <button id="kv-copy-md"  class="btn">Copy MD</button>
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
  // ★修正：Map / plain object 両対応（従来はMapだとラベル解決が無効だった）
  const groupsToHTML = (groups = [], code2label = {}) => {
    return groups.map((g, i) => {
      const idx = i + 1;
      const code = g?.code || '';
      const labelRaw = code ? KTDeps.labelOf(code2label, code) : '';
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
      // ラベル（コード） or codeのみ（★Map/plain object 両対応に修正）
      const lb = code ? KTDeps.labelOf(code2label, code) : '';
      const label =
        code ? (lb !== code ? `${lb}（${code}）` : code) : '';
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
      // ★Map/plain object 両対応に修正
      const label = code ? KTDeps.labelOf(code2label, code) : 'レコード';
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
          <button id="kg-copy-md"  class="btn">Copy MD</button>
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
                <button id="${btnCopyMd}"  class="btn">Copy MD</button>
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
   * 「他アプリからの参照」セクションの動作を組み立てる
   * 走査はユーザーがボタンを押したときだけ実行し、結果はキャッシュから復元する。
   */
  function bindIncoming(view, appId, deps, onUpdated = null) {
    const $scan = view.querySelector('#kt-in-scan');
    const $status = view.querySelector('#kt-in-status');
    const $result = view.querySelector('#kt-in-result');
    const $actions = view.querySelector('#kt-in-actions');
    if (!$scan || !$result) return;

    const BD = getThemeColors().border;

    const render = (data, fromCache) => {
      const rows = data?.rows || [];
      const st = data?.stats || {};
      const when = data?.scannedAt ? new Date(data.scannedAt).toLocaleString() : '';

      const summary = [
        `${st.scannedApps ?? 0} アプリを確認`,
        `${st.referencingApps ?? 0} アプリから参照あり`,
        st.failedApps ? `${st.failedApps} アプリは確認できず` : null,
        st.truncated ? `※ 上限 ${KTIncoming.MAX_APPS} アプリで打ち切り` : null,
      ].filter(Boolean).join(' / ');

      if ($status) $status.textContent = `${summary}${when ? `（${fromCache ? 'キャッシュ ' : ''}${when}）` : ''}`;

      // 「このアプリの項目」：参照キー（またはアクションの転記先）に加えて、ルックアップのコピー元も並べる
      const itemsOf = (r) => {
        const out = [];
        if (r.targetField) out.push({ code: r.targetField, role: r.kind === 'ルックアップ' ? '参照キー' : '' });
        for (const cf of (Array.isArray(r.copyFields) ? r.copyFields : [])) {
          const from = (cf && typeof cf === 'object') ? cf.from : cf;
          if (from) out.push({ code: String(from), role: 'コピー元' });
        }
        return out;
      };

      if (!rows.length) {
        $result.innerHTML = `
          <div style="padding:10px;font-size:12px;opacity:.85">
            このアプリを参照しているアプリは見つかりませんでした。
            ${st.failedApps ? `<br><span style="opacity:.75">ただし ${st.failedApps} アプリは権限等の理由で確認できていません。</span>` : ''}
          </div>`;
        return;
      }

      const body = rows.map(r => `
        <tr>
          <td style="padding:5px 7px;border-bottom:1px solid ${BD};white-space:nowrap">
            <a href="${escapeHtml(KTApi.appUrl(r.appId))}" target="_blank" rel="noopener noreferrer" style="color:inherit">
              app ${escapeHtml(r.appId)}${r.appName ? ' ' + escapeHtml(r.appName) : ''} 🔗</a>
          </td>
          <td style="padding:5px 7px;border-bottom:1px solid ${BD};white-space:nowrap">${escapeHtml(r.kind)}</td>
          <td style="padding:5px 7px;border-bottom:1px solid ${BD}">${escapeHtml(r.sourceLabel || r.sourceField)}</td>
          <td style="padding:5px 7px;border-bottom:1px solid ${BD}">${itemsOf(r).map(it =>
            `<code>${escapeHtml(it.code)}</code>${it.role ? `<span style="font-size:11px;opacity:.75">（${escapeHtml(it.role)}）</span>` : ''}`).join('<br>') || '—'}</td>
          <td style="padding:5px 7px;border-bottom:1px solid ${BD};font-size:11px;opacity:.85">${escapeHtml(r.note || '')}</td>
        </tr>`).join('');

      $result.innerHTML = `
        <div style="max-height:280px;overflow:auto">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="opacity:.7">
              <th style="text-align:left;padding:5px 7px">参照元アプリ</th>
              <th style="text-align:left;padding:5px 7px">種別</th>
              <th style="text-align:left;padding:5px 7px">参照元の設定</th>
              <th style="text-align:left;padding:5px 7px">このアプリの項目</th>
              <th style="text-align:left;padding:5px 7px">備考</th>
            </tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        ${(data.errors || []).length ? `
          <div style="margin-top:6px;font-size:11px;opacity:.75">
            確認できなかったアプリ: ${(data.errors || []).slice(0, 20)
          .map(e => `app ${escapeHtml(e.appId)}（${escapeHtml(e.reason)}）`).join(' / ')}${(data.errors || []).length > 20 ? ' ほか' : ''}
          </div>` : ''}
        <div style="margin-top:8px;display:flex;justify-content:flex-end">
          <button id="kt-in-copy" class="btn" style="padding:2px 10px;font-size:11px">Copy MD</button>
        </div>`;

      $result.querySelector('#kt-in-copy')?.addEventListener('click', async () => {
        const btn = $result.querySelector('#kt-in-copy');
        const md = [
          '# 他アプリからの参照（他アプリ → このアプリ）',
          '',
          `- 走査日時: ${when}`,
          `- ${summary}`,
          '',
          '| 参照元アプリ | 種別 | 参照元の設定 | このアプリの項目 | 備考 |',
          '| --- | --- | --- | --- | --- |',
          ...rows.map(r => `| app ${r.appId} ${r.appName || ''} | ${r.kind} | ${r.sourceLabel || r.sourceField} | ${itemsOf(r).map(it => `\`${it.code}\`${it.role ? `（${it.role}）` : ''}`).join('／')} | ${r.note || ''} |`),
        ].join('\n');
        try {
          await navigator.clipboard.writeText(md);
          flashBtnText(btn, 'Copied!');
        } catch (e) {
          flashBtnText(btn, 'Failed');
        }
      }, { passive: true });
    };

    // 走査済みならキャッシュから復元して表示する（API呼び出しは発生しない）
    const cached = KTIncoming.loadCache(String(appId));
    if (cached) {
      render(cached, true);
      if (deps) {
        try { KTDeps.applyIncomingRefs(deps, cached); } catch (e) { console.error(e); }
      }
    } else if ($status) {
      $status.textContent = '未走査';
    }

    $scan.addEventListener('click', async () => {
      $scan.disabled = true;
      const original = $scan.textContent;
      try {
        const data = await KTIncoming.run(appId, {
          includeActions: !!($actions && $actions.checked),
          force: true,
          onProgress: (done, total, phase) => {
            if ($status) $status.textContent = total ? `${phase}… ${done} / ${total}` : `${phase}…`;
            $scan.textContent = total ? `走査中 ${Math.round((done / total) * 100)}%` : '走査中…';
          },
        });
        render(data, false);
        // 依存関係データへ取り込み、変更影響の「他アプリ連携」にも反映する
        if (deps) {
          let applied = false;
          try { KTDeps.applyIncomingRefs(deps, data); applied = true; } catch (e) { console.error(e); }
          // 依存関係データを共有している他のタブ（Fields の利用数・変更影響）を再計算させる
          if (applied && typeof onUpdated === 'function') {
            try { onUpdated(); } catch (e) { console.error('[KTIncoming] 走査結果の反映に失敗しました', e); }
          }
        }
      } catch (e) {
        console.error('[KTIncoming] 走査に失敗しました', e);
        if ($status) $status.textContent = '走査に失敗しました（詳細はブラウザのコンソール）';
      } finally {
        $scan.disabled = false;
        $scan.textContent = original;
      }
    }, { passive: true });
  }

  // ==========================================================
  // Relations：設定詳細（Details）レンダラー（v2.2.1）
  //   Summary（依存関係サマリー）＝どのアプリとどう接続しているかの横断ビュー、
  //   Details（設定詳細）＝各設定の内容を調査する場所、として役割を分離する。
  //   機能単位でレンダラーを分割し、将来 JavaScript／計算式／通知などの詳細も
  //   同じカード構造（relDetailCard）＋共通フィルター（relFilterBar）で追加できるようにする。
  //   各レンダラーは { cardsHtml, headers, dlRows, appOptions } を返す。
  // ==========================================================

  /** deps の FIELD ノードから code → {label, type} を引けるMapを作る */
  function relFieldInfoMap(deps) {
    const m = new Map();
    (deps?.nodes || []).forEach(n => {
      if (n.type === 'FIELD') m.set(String(n.id).replace(/^FIELD:/, ''), { label: n.name || '', type: n.fieldType || '' });
    });
    return m;
  }

  /** 接続先アプリの表示文字列（自アプリなら「（このアプリ）」、名前は解決済みのものだけ表示） */
  function relAppDisp(deps, id, selfAppId) {
    const sid = String(id ?? '');
    if (!sid) return '—';
    if (!/^\d+$/.test(sid)) return `アプリコード: ${sid}`; // アプリコード指定（IDが取得できない場合）
    if (String(selfAppId ?? '') === sid) {
      const nm = deps?.meta?.appName;
      return `app ${sid}${nm ? ' ' + nm : ''}（このアプリ）`;
    }
    const nm = deps?.meta?.appNames?.[sid];
    return nm ? `app ${sid} ${nm}` : `app ${sid}`;
  }

  /** 接続先アプリ名だけを返す（エクスポート用。未解決なら空文字） */
  function relAppNameOnly(deps, id, selfAppId) {
    const sid = String(id ?? '');
    if (!/^\d+$/.test(sid)) return '';
    if (String(selfAppId ?? '') === sid) return `${deps?.meta?.appName || ''}（このアプリ）`;
    return deps?.meta?.appNames?.[sid] || '';
  }

  /** filterCond の簡易整形（and/or の前で改行して大文字表示）。Raw文字列は別途表示する */
  function relCondFmt(cond) {
    return String(cond || '').replace(/\s+(and|or)\s+/gi, (m, op) => `\n${op.toUpperCase()} `);
  }

  /** kintoneのsort文字列（"code desc, code2 asc"）→ [{field, dirJa}] */
  function relSortList(sortStr) {
    return String(sortStr || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => {
        const [field, dir] = s.split(/\s+/);
        const d = String(dir || '').toLowerCase();
        return { field: field || '', dirJa: d === 'desc' ? '降順' : d === 'asc' ? '昇順' : (dir || '') };
      });
  }

  /** Raw設定JSON（開発・調査用。初期状態は閉じる） */
  function relRawJson(obj) {
    if (obj == null) return '';
    let json = '';
    try { json = JSON.stringify(obj, null, 2); } catch { return ''; }
    return `
      <details class="kt-rel-raw" style="margin-top:10px">
        <summary style="cursor:pointer;font-size:11px;opacity:.7">Raw設定JSON（開発・調査用）</summary>
        <pre>${escapeHtml(json)}</pre>
      </details>`;
  }

  /** 「自アプリ側キー → 接続先キー」の縦型キーブロック（Lookup／Related Records共通） */
  function relKeyBlock({ selfLabel, selfCode, destDisp, destCode, opLabel = '=' }) {
    const esc = escapeHtml;
    return `
      <div class="kt-rel-keybox">
        <div class="kt-rel-keybox-app">自アプリ</div>
        <div>${selfLabel && selfLabel !== selfCode ? `${esc(selfLabel)}<br>` : ''}<code>${esc(selfCode || '—')}</code></div>
        <div class="kt-rel-keybox-op">↓ ${esc(opLabel)}</div>
        <div class="kt-rel-keybox-app">${esc(destDisp)}</div>
        <div><code>${esc(destCode || '—')}</code></div>
      </div>`;
  }

  /** 詳細セクションの見出し（本題は短く、補足は小さく分離する） */
  function relH(title, sub) {
    return `<div class="kt-rel-h">${escapeHtml(title)}${sub ? ` <small class="kt-rel-hsub">${escapeHtml(sub)}</small>` : ''}</div>`;
  }

  /** フィールド形式の共通バッジ表示（確度バッジと馴染む控えめなデザイン） */
  function relTypeBadge(type) {
    return type ? ` <span class="kt-rel-type">${escapeHtml(type)}</span>` : '';
  }

  /** 「なし／取得できませんでした／解析できませんでした」等の状態表示 */
  function relStateNote(text) {
    return `<div class="kt-rel-note">${escapeHtml(text)}</div>`;
  }

  /**
   * ラベル・コード（・フィールド形式バッジ）の併記表示（自アプリのフィールドのみ形式が分かる）
   * ラベル＝コードの場合はコードを通常表示、異なる場合はラベル＋弱い表示のコード＋形式バッジ
   */
  function relFieldDisp(fmap, code) {
    const esc = escapeHtml;
    if (!code) return '—';
    const info = fmap?.get(code);
    const hasLabel = !!(info?.label && info.label !== code);
    const codeHtml = hasLabel
      ? `<code style="opacity:.6;font-size:11px">${esc(code)}</code>`
      : `<code>${esc(code)}</code>`;
    return `${hasLabel ? esc(info.label) + ' ' : ''}${codeHtml}${relTypeBadge(info?.type)}`;
  }

  /** 詳細カード共通ラッパ（折りたたみ・フィルター用データ属性つき） */
  function relDetailCard({ kindKey, id, badge, title, sub, destAppId, search, bodyHtml }) {
    const esc = escapeHtml;
    return `
      <details class="kt-rel-card"
        data-rel-card="${esc(`${kindKey}:${id}`)}"
        data-app="${esc(String(destAppId ?? ''))}"
        data-search="${esc(String(search || '').toLowerCase())}">
        <summary>
          <span class="kt-rel-badge">${esc(badge)}</span>
          <span class="kt-rel-title">${esc(title)}</span>
          <span class="kt-rel-sub">${sub}</span>
        </summary>
        <div class="kt-rel-body">${bodyHtml}</div>
      </details>`;
  }

  /** key-value 表（基本情報用） */
  function relKV(rows) {
    return `
      <table class="kt-rel-kv"><tbody>
        ${rows.filter(r => r).map(([k, vHtml]) => `<tr><td>${escapeHtml(k)}</td><td>${vHtml}</td></tr>`).join('')}
      </tbody></table>`;
  }

  /**
   * 条件ブロック（整形版＋Raw折りたたみ）。項目自体は常に表示し、状態を区別する：
   *   - 設定されていない（空文字）             → 「なし」
   *   - APIレスポンスにキーが無い／raw未保持   → 「取得できませんでした」
   *   - 値はあるが整形に失敗                   → 「解析できませんでした」（Rawで確認可能）
   * @param {string} title 見出し（短く）
   * @param {object|null} rawObj APIレスポンス相当のオブジェクト（filterCond等を含む）
   * @param {object} opt key: rawObj上のキー名 / sub: 見出しの補足（小さく表示）
   */
  function relCondBlock(title, rawObj, { key = 'filterCond', sub = 'filterCond' } = {}) {
    let body;
    if (rawObj == null || typeof rawObj !== 'object' || !(key in rawObj)) {
      body = relStateNote('取得できませんでした');
    } else {
      const cond = rawObj[key];
      if (cond == null || String(cond).trim() === '') {
        body = relStateNote('なし');
      } else {
        let fmt = null;
        try { fmt = relCondFmt(cond); } catch { fmt = null; }
        const raw = `
          <details class="kt-rel-raw"><summary style="cursor:pointer;font-size:11px;opacity:.6">Raw</summary>
            <pre>${escapeHtml(String(cond))}</pre></details>`;
        body = (fmt == null)
          ? relStateNote('解析できませんでした') + raw
          : `<pre class="kt-rel-cond">${escapeHtml(fmt)}</pre>` + raw;
      }
    }
    return `${relH(title, sub)}${body}`;
  }

  /** 詳細セクション共通フィルターバー（テキスト検索＋接続先アプリ絞り込み＋件数表示） */
  function relFilterBar(kindKey, appOptions, deps, selfAppId) {
    const opts = (appOptions || []).map(id =>
      `<option value="${escapeHtml(String(id))}">${escapeHtml(relAppDisp(deps, id, selfAppId))}</option>`).join('');
    return `
      <div class="kt-rel-filter">
        <input id="kt-rel-q-${kindKey}" type="text"
          placeholder="検索（フィールド名・コード・アプリ・条件・マッピング）" />
        <select id="kt-rel-app-${kindKey}" title="接続先アプリで絞り込み">
          <option value="">接続先: すべて</option>${opts}
        </select>
        <button id="kt-rel-clear-${kindKey}" class="btn" type="button">クリア</button>
        <span id="kt-rel-count-${kindKey}" class="kt-rel-count"></span>
      </div>`;
  }

  /** フィルターバーのイベントを結線する（カードの表示/非表示と件数表示） */
  function bindRelFilter(view, kindKey) {
    const list = view.querySelector(`#kt-rel-list-${kindKey}`);
    if (!list) return;
    const $q = view.querySelector(`#kt-rel-q-${kindKey}`);
    const $app = view.querySelector(`#kt-rel-app-${kindKey}`);
    const $clear = view.querySelector(`#kt-rel-clear-${kindKey}`);
    const $count = view.querySelector(`#kt-rel-count-${kindKey}`);
    const cards = [...list.querySelectorAll('details.kt-rel-card')];
    const apply = () => {
      const text = ($q?.value || '').trim().toLowerCase();
      const app = $app?.value || '';
      let shown = 0;
      for (const c of cards) {
        const okText = !text || (c.dataset.search || '').includes(text);
        const okApp = !app || String(c.dataset.app || '') === app;
        const on = okText && okApp;
        c.style.display = on ? '' : 'none';
        if (on) shown++;
      }
      if ($count) $count.textContent = `表示 ${shown} / ${cards.length}件`;
    };
    $q?.addEventListener('input', apply, { passive: true });
    $app?.addEventListener('change', apply, { passive: true });
    $clear?.addEventListener('click', () => { if ($q) $q.value = ''; if ($app) $app.value = ''; apply(); }, { passive: true });
    apply();
  }

  /** SummaryからDetailsの該当カードへ移動・展開・一時ハイライト */
  function relJumpToCard(view, kindKey, id) {
    const wanted = `${kindKey}:${id}`;
    const card = [...view.querySelectorAll('details.kt-rel-card')].find(c => c.dataset.relCard === wanted);
    if (!card) return;
    // セクション（外側details）を開いてからカードを開く
    const wrap = view.querySelector(`#kt-rel-details-${kindKey}`);
    const outer = wrap ? wrap.closest('details') : null;
    if (outer && !outer.open) outer.open = true;
    // フィルターで非表示になっていても見えるようにする（フィルター自体は変更しない）
    card.style.display = '';
    card.open = true;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('kt-rel-flash');
    setTimeout(() => card.classList.remove('kt-rel-flash'), 2000);
  }

  /**
   * Details：Lookup（ルックアップ）
   * 基本情報／検索キー（自アプリ→接続先）／フィールドマッピング／その他設定（絞り込み・並び順）／Raw JSON
   */
  function renderLookupDetails(lookups, ctx) {
    const { deps, appId, fmap } = ctx;
    const esc = escapeHtml;
    const headers = ['フィールド', 'コード', '接続先AppID', '接続先アプリ名', '自アプリ側キー', '接続先キー',
      'マッピング（接続先 → 自アプリ）', 'ピッカー表示項目', '絞り込み条件', '並び順'];
    const dlRows = [];
    const cards = [];
    const appIds = new Set();

    (lookups || []).forEach(lu => {
      const destId = (lu?.relatedAppId != null && lu.relatedAppId !== '') ? String(lu.relatedAppId) : '';
      const destKeyForFilter = destId || String(lu?.relatedAppCode || '');
      if (destKeyForFilter) appIds.add(destKeyForFilter);
      const destDisp = relAppDisp(deps, destKeyForFilter, appId);
      const destKey = lu?.relatedKeyField || '';
      const maps = Array.isArray(lu?.fieldMappings) ? lu.fieldMappings : [];
      const picker = Array.isArray(lu?.lookupPickerFields) ? lu.lookupPickerFields : [];
      const selfInfo = fmap?.get(lu?.code);

      const destLink = /^\d+$/.test(destId)
        ? `<a href="${esc(KTApi.appUrl(destId))}" target="_blank" rel="noopener noreferrer" style="color:inherit">${esc(destDisp)} 🔗</a>`
        : esc(destDisp);

      // 表示順は共通方針（基本情報 → 検索キー → 絞り込み → マッピング → ピッカー → 並び順 → Raw）
      const mapRows = relH('フィールドマッピング', '接続先 → 自アプリ') + (maps.length ? `
        <table class="kt-rel-mini">
          <thead><tr><th>接続先</th><th></th><th>自アプリ</th></tr></thead>
          <tbody>${maps.map(m => `
            <tr>
              <td><code>${esc(m?.from || '—')}</code></td>
              <td>→</td>
              <td>${relFieldDisp(fmap, m?.to)}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : relStateNote('なし'));

      const pickerHtml = relH('ピッカー表示項目', 'Lookup選択画面に表示') + (picker.length
        ? `<div style="font-size:12px">${picker.map(p => `<code>${esc(p)}</code>`).join('　')}</div>`
        : relStateNote('なし'));

      const sortList = relSortList(lu?.sort);
      const sortHtml = relH('並び順', 'コピー元') + (
        (lu?.raw == null || !('sort' in lu.raw)) ? relStateNote('取得できませんでした')
          : sortList.length ? `
            <table class="kt-rel-mini">
              <thead><tr><th>フィールド</th><th>順序</th></tr></thead>
              <tbody>${sortList.map(s => `
                <tr><td><code>${esc(s.field)}</code></td><td>${esc(s.dirJa)}</td></tr>`).join('')}
              </tbody></table>`
            : relStateNote('なし'));

      const bodyHtml = `
        ${relH('基本情報')}
        ${relKV([
        ['フィールド名', esc(lu?.label ?? '')],
        ['フィールドコード', `<code>${esc(lu?.code ?? '')}</code>${relTypeBadge(selfInfo?.type)}`],
        ['接続先アプリ', destLink],
        ['コピー項目数', `${maps.length}項目`],
      ])}
        ${relH('検索キー')}
        ${relKeyBlock({ selfLabel: lu?.label, selfCode: lu?.code, destDisp, destCode: destKey, opLabel: '＝（値を照合）' })}
        ${relCondBlock('絞り込み条件', lu?.raw, { sub: 'filterCond（コピー元の絞り込み）' })}
        ${mapRows}
        ${pickerHtml}
        ${sortHtml}
        ${relRawJson(lu?.raw)}`;

      const search = [
        lu?.label, lu?.code, destId, lu?.relatedAppCode, relAppNameOnly(deps, destKeyForFilter, appId),
        destKey, lu?.filterCond, lu?.sort,
        ...maps.flatMap(m => [m?.from, m?.to]), ...picker,
      ].filter(Boolean).join(' ');

      cards.push(relDetailCard({
        kindKey: 'lookup', id: lu?.code ?? '', badge: 'Lookup',
        title: `${lu?.label ?? ''}（${lu?.code ?? ''}）`,
        sub: `→ ${esc(destDisp)}　キー: <code>${esc(destKey || '—')}</code>　${maps.length}項目取得`,
        destAppId: destKeyForFilter, search, bodyHtml,
      }));

      dlRows.push([
        lu?.label ?? '', lu?.code ?? '', destId || (lu?.relatedAppCode || ''), relAppNameOnly(deps, destKeyForFilter, appId),
        lu?.code ?? '', destKey,
        maps.map(m => `${m?.from || '—'} → ${m?.to || '—'}`).join(' / '),
        picker.join(', '), lu?.filterCond || '', lu?.sort || '',
      ]);
    });

    return { cardsHtml: cards.join(''), headers, dlRows, appOptions: [...appIds] };
  }

  /**
   * Details：Related Records（関連レコード一覧）
   * 基本情報／接続条件（自アプリ側キー→接続先キー）／表示フィールド一覧／フィルター条件／並び順／Raw JSON
   */
  function renderRelatedRecordDetails(rts, ctx) {
    const { deps, appId, fmap } = ctx;
    const esc = escapeHtml;
    const headers = ['フィールド', 'コード', '接続先AppID', '接続先アプリ名', '自アプリ側キー', '接続先キー',
      '表示フィールド', '絞り込み条件', '並び順', '表示件数'];
    const dlRows = [];
    const cards = [];
    const appIds = new Set();

    (rts || []).forEach(rt => {
      const destId = (rt?.relatedAppId != null && rt.relatedAppId !== '') ? String(rt.relatedAppId) : '';
      const destKeyForFilter = destId || String(rt?.relatedAppCode || '');
      if (destKeyForFilter) appIds.add(destKeyForFilter);
      const destDisp = relAppDisp(deps, destKeyForFilter, appId);
      const isSelfApp = String(appId ?? '') === destId;
      const condField = rt?.condition?.field || '';
      const condRelated = rt?.condition?.relatedField || '';
      const disp = Array.isArray(rt?.displayFields) ? rt.displayFields : [];
      const sortList = relSortList(rt?.sort);

      const destLink = /^\d+$/.test(destId)
        ? `<a href="${esc(KTApi.appUrl(destId))}" target="_blank" rel="noopener noreferrer" style="color:inherit">${esc(destDisp)} 🔗</a>`
        : esc(destDisp);

      // 表示順は共通方針（基本情報 → 接続条件 → 絞り込み → 表示フィールド → 並び順 → 表示件数 → Raw）
      // 表示フィールド：一覧化（接続先が自アプリの場合のみラベル・形式バッジを併記できる）
      const dispHtml = relH('表示フィールド', '関連レコード一覧に表示') + (disp.length ? `
        <table class="kt-rel-mini">
          <thead><tr><th>#</th><th>フィールド</th></tr></thead>
          <tbody>${disp.map((c, i) => `
            <tr><td>${i + 1}</td><td>${isSelfApp ? relFieldDisp(fmap, c) : `<code>${esc(c)}</code>`}</td></tr>`).join('')}
          </tbody>
        </table>
        ${isSelfApp ? '' : '<div style="font-size:11px;opacity:.6">※ 接続先アプリのフィールドのため、ラベル・形式は取得できません（コードのみ表示）</div>'}`
        : relStateNote('なし'));

      const sortHtml = relH('並び順') + (
        (rt?.raw == null || !('sort' in rt.raw)) ? relStateNote('取得できませんでした')
          : sortList.length ? `
            <table class="kt-rel-mini">
              <thead><tr><th>フィールド</th><th>順序</th></tr></thead>
              <tbody>${sortList.map(s => `
                <tr><td>${isSelfApp ? relFieldDisp(fmap, s.field) : `<code>${esc(s.field)}</code>`}</td><td>${esc(s.dirJa)}</td></tr>`).join('')}
              </tbody></table>`
            : relStateNote('なし'));

      const sizeHtml = relH('表示件数', '一度に表示するレコード数') + (
        rt?.size != null ? `<div style="font-size:12px">${esc(String(rt.size))}件</div>`
          : (rt?.raw != null && 'size' in rt.raw) ? relStateNote('なし')
            : relStateNote('取得できませんでした'));

      const selfInfo = fmap?.get(condField);
      const bodyHtml = `
        ${relH('基本情報')}
        ${relKV([
        ['フィールド名', esc(rt?.label ?? '')],
        ['フィールドコード', `<code>${esc(rt?.code ?? '')}</code>`],
        ['接続先アプリ', destLink],
      ])}
        ${relH('接続条件', '自アプリ側キー → 接続先キー')}
        ${relKeyBlock({
        selfLabel: selfInfo?.label || '', selfCode: condField,
        destDisp, destCode: condRelated, opLabel: '=',
      })}
        ${relCondBlock('絞り込み条件', rt?.raw, { sub: 'filterCond（表示するレコードの絞り込み）' })}
        ${dispHtml}
        ${sortHtml}
        ${sizeHtml}
        ${relRawJson(rt?.raw)}`;

      const search = [
        rt?.label, rt?.code, destId, rt?.relatedAppCode, relAppNameOnly(deps, destKeyForFilter, appId),
        condField, condRelated, rt?.filterCond, rt?.sort, ...disp,
      ].filter(Boolean).join(' ');

      cards.push(relDetailCard({
        kindKey: 'related', id: rt?.code ?? '', badge: 'Related Records',
        title: `${rt?.label ?? ''}（${rt?.code ?? ''}）`,
        sub: `→ ${esc(destDisp)}　連携: <code>${esc(condField || '—')}</code> = <code>${esc(condRelated || '—')}</code>`,
        destAppId: destKeyForFilter, search, bodyHtml,
      }));

      // Export上でも「条件なし（空欄）」と「未取得」を区別する
      const condForExport = (rt?.raw != null && 'filterCond' in rt.raw) ? (rt.filterCond || '') : '（取得不可）';
      dlRows.push([
        rt?.label ?? '', rt?.code ?? '', destId || (rt?.relatedAppCode || ''), relAppNameOnly(deps, destKeyForFilter, appId),
        condField, condRelated, disp.join(', '), condForExport,
        sortList.map(s => `${s.field} ${s.dirJa}`).join(', '),
        rt?.size != null ? String(rt.size) : '',
      ]);
    });

    return { cardsHtml: cards.join(''), headers, dlRows, appOptions: [...appIds] };
  }

  /**
   * Details：App Action（レコード作成アクション）
   * 基本情報／マッピング（自アプリ → 接続先）／実行条件／Raw JSON
   */
  function renderAppActionDetails(acts, ctx) {
    const { deps, appId, fmap } = ctx;
    const esc = escapeHtml;
    const headers = ['ID', 'アクション名', '有効', '接続先AppID', '接続先アプリ名',
      'マッピング（自アプリ → 接続先）', '割当対象', '実行条件'];
    const dlRows = [];
    const cards = [];
    const appIds = new Set();

    (acts || []).forEach(a => {
      const destId = (a?.toAppId != null && a.toAppId !== '') ? String(a.toAppId) : '';
      const destKeyForFilter = destId || String(a?.toAppCode || '');
      if (destKeyForFilter) appIds.add(destKeyForFilter);
      const destDisp = destKeyForFilter ? relAppDisp(deps, destKeyForFilter, appId) : '—（接続先不明）';
      const maps = Array.isArray(a?.mappingsDetail) ? a.mappingsDetail : [];
      const ents = Array.isArray(a?.entities) ? a.entities : [];
      const enabled = a?.enabled;

      const destLink = /^\d+$/.test(destId)
        ? `<a href="${esc(KTApi.appUrl(destId))}" target="_blank" rel="noopener noreferrer" style="color:inherit">${esc(destDisp)} 🔗</a>`
        : esc(destDisp);

      // 表示順は共通方針（基本情報 → 接続方向 → 実行条件 → 転記フィールド → Raw）
      // 接続方向：自アプリ → 接続先アプリ を先に明示する
      const dirHtml = relH('接続方向') + `
        <div class="kt-rel-keybox">
          <div class="kt-rel-keybox-app">自アプリ</div>
          <div class="kt-rel-keybox-op">↓ レコード作成</div>
          <div class="kt-rel-keybox-app">${esc(destDisp)}</div>
        </div>`;

      // 転記フィールド：自アプリ（srcField / srcType）→ 接続先（destField）。方向を明示する
      const mapHtml = relH(`転記フィールド ${maps.length}件`, '自アプリ → 接続先') + (maps.length ? `
        <table class="kt-rel-mini">
          <thead><tr><th>自アプリ</th><th></th><th>接続先</th></tr></thead>
          <tbody>${maps.map(m => `
            <tr>
              <td>${m?.srcField ? relFieldDisp(fmap, m.srcField) : `<small style="opacity:.7">${esc(m?.srcType || '—')}</small>`}</td>
              <td>→</td>
              <td><code>${esc(m?.destField || '—')}</code></td>
            </tr>`).join('')}
          </tbody>
        </table>` : relStateNote('なし'));

      const entsHtml = ents.length
        ? ents.map(e => `${esc(e?.code ?? '—')}<small style="opacity:.6">（${esc(e?.type ?? '—')}）</small>`).join(' / ')
        : '全員';

      const bodyHtml = `
        ${relH('基本情報')}
        ${relKV([
        ['アクション名', esc(a?.name ?? '')],
        ['ID', `<code>${esc(String(a?.id ?? ''))}</code>`],
        ['有効', enabled == null ? '—（取得不可）' : (enabled ? '✅ 有効' : '❌ 無効')],
        ['接続先アプリ', destLink],
        ['利用できるユーザー', entsHtml],
      ])}
        ${dirHtml}
        ${relCondBlock('実行条件', a?.raw, { sub: 'filterCond（アクションを表示するレコードの条件）' })}
        ${mapHtml}
        ${relRawJson(a?.raw)}`;

      const search = [
        a?.name, String(a?.id ?? ''), destId, a?.toAppCode, relAppNameOnly(deps, destKeyForFilter, appId),
        a?.filterCond, ...maps.flatMap(m => [m?.srcField, m?.srcType, m?.destField]),
        ...ents.map(e => e?.code),
      ].filter(Boolean).join(' ');

      cards.push(relDetailCard({
        kindKey: 'action', id: String(a?.id ?? ''), badge: 'App Action',
        title: a?.name ?? '',
        sub: `→ ${esc(destDisp)}　${maps.length}項目を転記${enabled === false ? '　<b style="color:#b00020">無効</b>' : ''}`,
        destAppId: destKeyForFilter, search, bodyHtml,
      }));

      dlRows.push([
        String(a?.id ?? ''), a?.name ?? '',
        enabled == null ? '' : (enabled ? 'TRUE' : 'FALSE'),
        destId || (a?.toAppCode || ''), relAppNameOnly(deps, destKeyForFilter, appId),
        maps.map(m => `${m?.srcField || m?.srcType || '—'} → ${m?.destField || '—'}`).join(' / '),
        ents.map(e => `${e?.code ?? '—'}（${e?.type ?? '—'}）`).join(' / '),
        a?.filterCond || '',
      ]);
    });

    return { cardsHtml: cards.join(''), headers, dlRows, appOptions: [...appIds] };
  }

  /**
   * Relationsタブを描画
   * @param {HTMLElement|Document} root document か ルート要素
   * @param {{lookups?:Array, relatedTables?:Array, actions?:Array}} relations buildRelations の結果
   * @param {number|string} appId 対象アプリのID
   * @param {object} deps 依存関係データ（アプリ間依存一覧の生成に使用。無くても従来3セクションは動作する）
   * @param {object} [opt]
   * @param {function} [opt.onDepsUpdated] 「他アプリからの参照」の走査で deps が更新された後に呼ぶ（Fields などの再計算用）
   */
  function renderRelations(root, relations, appId, deps = null, { onDepsUpdated = null } = {}) {
    const view = root.querySelector('#view-relations');
    if (!view) return;

    // 枠線などに使うテーマ色（ライト／ダーク両対応）
    const BD = getThemeColors().border;

    const R = relations || {};
    const lookups = Array.isArray(R.lookups) ? R.lookups : [];
    const rts = Array.isArray(R.relatedTables) ? R.relatedTables : [];
    const acts = Array.isArray(R.actions) ? R.actions : [];

    // ★エスケープ漏れ修正：HTMLに入れる値は escH（共通の escapeHtml）を必ず通す
    const escH = (v) => escapeHtml(v);

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

    // ---------- 設定詳細（Details）：機能単位のレンダラーで生成 ----------
    // ★v2.2.1 構成変更：詳細は「1設定＝1カード（折りたたみ）」で表示し、
    //   検索・接続先アプリでの絞り込みができる。エクスポートは従来どおり
    //   sectionWithDL（Copy MD / DL MD / CSV / JSON）で、内容はSummaryより詳細な設定情報を出す。
    const cnt = (n) => `（${n}件）`;
    const fmap = relFieldInfoMap(deps);
    const detailCtx = { deps, appId, fmap };

    const LU = renderLookupDetails(lookups, detailCtx);
    const RT = renderRelatedRecordDetails(rts, detailCtx);
    const AC = renderAppActionDetails(acts, detailCtx);

    const emptyCards = `<div style="padding:12px;opacity:.7;font-size:12px">項目なし</div>`;
    const detailSectionInner = (kindKey, R) => `
      <div id="kt-rel-details-${kindKey}" style="padding:8px 10px">
        ${R.dlRows.length ? relFilterBar(kindKey, R.appOptions, deps, appId) : ''}
        <div id="kt-rel-list-${kindKey}">${R.cardsHtml || emptyCards}</div>
      </div>`;

    // 詳細：Lookup（セクションは展開・カードは折りたたみ）
    const { html: secLU, bind: bindLU } =
      sectionWithDL(
        `Lookup（ルックアップ）${cnt(LU.dlRows.length)}`,
        LU.headers, LU.dlRows,
        detailSectionInner('lookup', LU),
        'relations_lookups',
        { appId, defaultOpen: true, indicator: true, relationType: 'lookup' }
      );

    // 詳細：Related Records
    const { html: secRT, bind: bindRT } =
      sectionWithDL(
        `Related Records（関連レコード）${cnt(RT.dlRows.length)}`,
        RT.headers, RT.dlRows,
        detailSectionInner('related', RT),
        'relations_relatedTables',
        { appId, defaultOpen: true, indicator: true, relationType: 'Related' }
      );

    // 詳細：App Actions
    const { html: secAC, bind: bindAC } =
      sectionWithDL(
        `App Actions（レコード作成アクション）${cnt(AC.dlRows.length)}`,
        AC.headers, AC.dlRows,
        detailSectionInner('action', AC),
        'relations_actions',
        { appId, defaultOpen: true, indicator: true, relationType: 'action' }
      );

    // ---------- アプリ間依存関係（概要）----------
    // ルックアップ／関連レコード／アプリアクション／JS内アプリID参照を1表に集約する。
    // 下の「詳細：…」セクションが各設定の内訳で、この表はその横断ビューにあたる。
    // Toolkit単体で確実に取れるもの（設定API）と、JS静的解析による推定を明確に分ける。
    const headersAL = ['接続種別', '自アプリ側', '接続先アプリ', '接続先フィールド', '備考', '確度'];
    const CONF_JA = { CERTAIN: '確実', LIKELY: '可能性が高い', UNCERTAIN: '要確認', NOT_ANALYZED: '解析対象外' };

    const alRows = deps ? KTDeps.buildAppLinks(deps, appId) : [];
    const alRowsHtml = [];
    const alRowsDL = [];

    alRows.forEach(r => {
      // アプリ名が解決できていれば「app 100 顧客管理」、できなければ「app 100（名称取得不可）」
      const destApp = r.destAppId === '不明' ? '不明（変数指定）' : (r.destAppLabel || `app ${r.destAppId}`);
      const lineNote = (Array.isArray(r.lines) && r.lines.length)
        ? `（${r.lines.slice(0, 5).map(n => `${n}行目`).join(', ')}${r.lines.length > 5 ? ' ほか' : ''}）`
        : '';
      const noteFull = `${r.note}${lineNote}`;
      const confJa = CONF_JA[r.confidence] || r.confidence;
      const srcMark = r.dataSource === 'JS_STATIC' ? '推定' : '設定';

      // 接続先アプリはリンクにする（別タブで開く）
      const destAppHtml = /^\d+$/.test(String(r.destAppId))
        ? `<a href="${escH(KTApi.appUrl(r.destAppId))}" target="_blank" rel="noopener noreferrer"
             style="color:inherit" title="このアプリを別タブで開きます">${escH(destApp)} 🔗</a>`
        : escH(destApp);

      // 自アプリ側：関連レコードは接続キーを ↳ 付きで補足（Summaryだけでキーが分かるように）
      const selfSideHtml = r.selfKey
        ? `${escH(r.selfSide)}<br><small style="opacity:.7">↳ ${escH(r.selfKey)}</small>`
        : escH(r.selfSide);
      const selfSideText = r.selfKey ? `${r.selfSide} ↳ ${r.selfKey}` : r.selfSide;

      alRowsHtml.push([
        escH(r.kind),
        selfSideHtml,
        destAppHtml,
        escH(r.destField),
        escH(noteFull),
        `<span class="pill">${escH(srcMark)}／${escH(confJa)}</span>`,
      ]);
      alRowsDL.push([r.kind, selfSideText, destApp, r.destField, noteFull, `${srcMark}／${confJa}`]);
    });

    // 取得可能性の説明（取得できないものを取得できるように見せない）
    // 取得できる情報／できない情報を明示する（折りたたみ。既定は閉じる）
    const alNote = `
      <details style="margin:0 0 8px">
        <summary style="cursor:pointer;font-size:11px;opacity:.85;padding:6px 8px;border:1px solid #f59e0b55;background:#f59e0b0f;border-radius:8px">
          この一覧で分かること・分からないこと（クリックで開く）
        </summary>
        <div style="padding:8px 10px;margin-top:6px;border:1px solid #8883;border-radius:8px;font-size:11px;line-height:1.8">
          <div>・<b>設定</b>＝アプリ設定APIから取得（ルックアップ／関連レコード／アプリアクション）。確実な情報です。
            各設定の詳細な項目は、下の「設定詳細（Details）」の各カードで確認できます。</div>
          <div>・<b>推定</b>＝JavaScriptの静的解析による検出。実行時にしか決まらない値は特定できません。
            Field Scannerで「Scan」を実行すると反映されます${deps ? '' : '（現在は依存データが未生成です）'}。</div>
          <div>・<b>この一覧は「このアプリ → 他アプリ」の向きのみ</b>です。他アプリからこのアプリへの参照は、
            アプリ設定APIでは取得できません（同一ドメインの他アプリを走査すれば取得可能ですが、現時点では未対応です）。</div>
          <div>・関連レコード一覧などが<b>自アプリ自身を参照する設定</b>も、設定単位で1行表示します（接続先に「（このアプリ）」と表示）。</div>
          <div>・プラグイン設定内の接続先アプリ、および外部URLのJavaScriptは<b>解析対象外</b>です。</div>
          <div>・接続先のアプリ名は、閲覧権限があるアプリのみ表示されます。権限が無い場合は「名称取得不可」と表示します。</div>
        </div>
      </details>
    `;

    // 接続先が1件も無い場合の表示（空表よりも状況が伝わる）
    const alEmpty = `
      <div style="padding:14px;opacity:.8;font-size:12px">
        他アプリへの接続は検出されませんでした。
        ${deps ? 'JavaScript内のアプリID参照は、Field Scannerで「Scan」を実行すると検出されます。' : ''}
      </div>
    `;

    const widthsAL = ['12%', '20%', '16%', '16%', '24%', '12%'];
    const destAppCount = new Set(alRows.map(r => r.destAppId)).size;
    // ★v2.2.1：役割が分かる名称へ変更（Summary＝横断ビュー、下の「設定詳細」＝調査用）
    const alTitle = alRows.length
      ? `依存関係サマリー <span style="font-size:11px;opacity:.6;font-weight:400">Summary</span>：このアプリ → 他アプリ（${destAppCount}アプリ / ${alRows.length}件）`
      : `依存関係サマリー <span style="font-size:11px;opacity:.6;font-weight:400">Summary</span>：このアプリ → 他アプリ`;
    const alHint = alRows.length
      ? `<div style="font-size:11px;opacity:.75;margin:2px 0 6px">行をクリックすると、下の「設定詳細」の該当設定へ移動します（JavaScript行を除く）。</div>`
      : '';
    const { html: secAL, bind: bindAL } =
      sectionWithDL(
        alTitle,
        headersAL, alRowsDL,
        alNote + alHint + (alRows.length ? `<div id="kt-rel-summary-table">${table(headersAL, alRowsHtml, widthsAL)}</div>` : alEmpty),
        'relations_appLinks',
        { appId, defaultOpen: true, indicator: true, relationType: 'appLink' }
      );

    // ---------- 他アプリからの参照（走査が必要）----------
    // アプリ設定APIでは「誰がこのアプリを参照しているか」を直接取得できないため、
    // 同一ドメインの各アプリを1つずつ確認する。API呼び出しがアプリ数に比例するので、
    // 自動実行はせず、ユーザーが明示的に走査を実行する形にする。
    const secIN = `
      <details id="kt-incoming" open style="border:1px solid ${BD};border-radius:10px;padding:8px 10px;margin-bottom:10px">
        <summary style="cursor:pointer;font-weight:600;font-size:13px">
          他アプリからの参照（他アプリ → このアプリ）
        </summary>
        <div style="font-size:11px;opacity:.85;margin:6px 0 8px;line-height:1.8">
          この向きの依存は、アプリ設定APIでは直接取得できません。
          同一ドメインのアプリを1件ずつ確認することで判明します。<br>
          <b>アプリ数に比例してAPI呼び出しが発生する</b>ため、実行はボタン操作のみです（自動実行はしません）。
          結果は24時間キャッシュされます。<br>
          <span style="opacity:.8">
            ※ 閲覧権限のないアプリは確認できません。件数を「確認できず」として表示します。<br>
            ※ ルックアップ・関連レコードはレコード閲覧権限で確認できます。
            アプリアクションはアプリ管理権限が必要なため、取得できない場合があります。
          </span>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
          <button id="kt-in-scan" class="btn">走査する</button>
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer"
                 title="アプリアクションも確認します。API呼び出しが約2倍になります">
            <input type="checkbox" id="kt-in-actions" checked style="margin:0">
            <span>アプリアクションも確認</span>
          </label>
          <span id="kt-in-status" style="font-size:11px;opacity:.8"></span>
        </div>
        <div id="kt-in-result"></div>
      </details>
    `;

    // ---------- 設定詳細（Details）の見出し ----------
    const secDivider = `
      <div style="display:flex;align-items:baseline;gap:10px;margin:18px 0 4px;flex-wrap:wrap">
        <h3 style="font-size:14px;margin:0;border-left:4px solid #2563eb;padding-left:8px">
          設定詳細 <span style="font-size:11px;opacity:.6;font-weight:400">Details</span>
        </h3>
        <span style="font-size:11px;opacity:.7">各接続の設定内容を調査できます（検索・接続先アプリで絞り込み可）</span>
      </div>`;

    // ---------- カード・フィルター用スタイル（Relationsタブ内スコープ） ----------
    const relStyle = `
      <style>
        #view-relations .kt-rel-card{border:1px solid ${BD};border-radius:10px;margin:8px 0}
        #view-relations .kt-rel-card>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:8px 10px;flex-wrap:wrap}
        #view-relations .kt-rel-card>summary::-webkit-details-marker{display:none}
        #view-relations .kt-rel-card>summary::before{content:'▸';width:1em;text-align:center;opacity:.6}
        #view-relations .kt-rel-card[open]>summary::before{content:'▾'}
        #view-relations .kt-rel-badge{border:1px solid ${BD};border-radius:999px;padding:2px 8px;font-size:11px;white-space:nowrap;opacity:.85}
        #view-relations .kt-rel-title{font-weight:600;font-size:12px}
        #view-relations .kt-rel-sub{font-size:11px;opacity:.75}
        #view-relations .kt-rel-body{padding:0 12px 10px;border-top:1px dashed ${BD};font-size:12px}
        #view-relations .kt-rel-h{font-weight:600;font-size:12px;margin:10px 0 4px}
        #view-relations .kt-rel-hsub{font-weight:400;font-size:10px;opacity:.6;margin-left:4px}
        #view-relations .kt-rel-note{font-size:12px;opacity:.75}
        #view-relations .kt-rel-type{display:inline-block;border:1px solid ${BD};border-radius:4px;padding:0 4px;font-size:10px;line-height:1.5;opacity:.7;margin-left:4px;vertical-align:1px;white-space:nowrap}
        #view-relations .kt-rel-kv{width:auto}
        #view-relations .kt-rel-kv td{padding:3px 10px 3px 0;vertical-align:top;font-size:12px;border-bottom:none}
        #view-relations .kt-rel-kv td:first-child{opacity:.7;white-space:nowrap}
        #view-relations .kt-rel-mini{width:auto;border-collapse:collapse;font-size:12px}
        #view-relations .kt-rel-mini th{position:static;font-size:11px;opacity:.7;padding:2px 10px 2px 0;border-bottom:1px solid ${BD};text-align:left;background:transparent}
        #view-relations .kt-rel-mini td{padding:3px 10px 3px 0;border-bottom:none;vertical-align:top}
        #view-relations .kt-rel-keybox{border:1px solid ${BD};border-radius:8px;padding:8px 12px;display:inline-block;min-width:220px;font-size:12px;line-height:1.7}
        #view-relations .kt-rel-keybox-app{opacity:.65;font-size:11px}
        #view-relations .kt-rel-keybox-op{opacity:.75;margin:2px 0 2px 10px;font-weight:600}
        #view-relations .kt-rel-cond{margin:0;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;border:1px solid ${BD};border-radius:8px;padding:8px 10px}
        #view-relations .kt-rel-raw pre{margin:4px 0 0;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:240px;overflow:auto;border:1px solid ${BD};border-radius:8px;padding:8px 10px}
        #view-relations .kt-rel-filter{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:2px 0 8px}
        #view-relations .kt-rel-filter input{flex:1;min-width:200px;height:30px;padding:0 10px;border:1px solid ${BD};border-radius:8px;background:transparent;color:inherit;font-size:12px}
        #view-relations .kt-rel-filter select{height:30px;border:1px solid ${BD};border-radius:8px;background:transparent;color:inherit;max-width:280px;font-size:12px}
        #view-relations .kt-rel-count{font-size:11px;opacity:.75}
        #view-relations .kt-rel-flash{outline:2px solid #2563eb;outline-offset:1px}
        #view-relations #kt-rel-summary-table tbody tr[data-rel-jump]:hover{background:rgba(37,99,235,.08)}
      </style>`;

    // まとめて描画 & バインド
    view.innerHTML = `${relStyle}${secAL}${secIN}${secDivider}${secLU}${secRT}${secAC}`;
    bindAL(view); bindLU(view); bindRT(view); bindAC(view);
    bindIncoming(view, appId, deps, onDepsUpdated);

    // 詳細セクションの共通フィルター
    bindRelFilter(view, 'lookup');
    bindRelFilter(view, 'related');
    bindRelFilter(view, 'action');

    // ---------- Summary → Details 導線 ----------
    // Summaryの行クリックで、対応するDetailsカードへスクロール・展開・一時ハイライト。
    // JS由来（JS_APP_ID）行は対応する詳細が無いため対象外。
    const KIND2KEY = { 'ルックアップ': 'lookup', '関連レコード': 'related', 'アプリアクション': 'action' };
    const sumTbl = view.querySelector('#kt-rel-summary-table');
    if (sumTbl) {
      const trs = sumTbl.querySelectorAll('tbody tr');
      alRows.forEach((r, i) => {
        const tr = trs[i];
        const key = KIND2KEY[r.kind];
        if (!tr || !key || r.sourceId == null) return;
        tr.dataset.relJump = '1';
        tr.style.cursor = 'pointer';
        tr.title = 'クリックで該当の設定詳細へ移動します';
        tr.addEventListener('click', (ev) => {
          if (ev.target.closest('a')) return; // アプリへのリンクは通常動作を優先
          relJumpToCard(view, key, String(r.sourceId));
        });
      });
    }
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
        // ★B6修正：従来 key に fieldMappings のオブジェクトがそのまま入っていた。
        //   参照キーは relatedKeyField、コピー設定は mappings として文字列で持たせる。
        rels.push({
          kind: 'LOOKUP',
          field: f.code,
          toApp: f.lookup?.relatedApp?.app ?? null,
          key: f.lookup?.relatedKeyField ?? null,
          mappings: (f.lookup?.fieldMappings || []).map(m => ({
            from: m?.relatedField?.code ?? m?.relatedField ?? null,
            to: m?.field?.code ?? m?.field ?? null,
          })),
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
    // ★B6修正：prefetchの layout は配列（他の描画関数も配列前提）。
    //   従来は pref.layout.layout を見ていたため、常に空になっていた。
    //   将来 { layout: [] } 形式で渡された場合にも備えて両対応にする。
    const layoutArray = Array.isArray(pref.layout) ? pref.layout : (pref.layout?.layout || []);
    const layoutOutline = layoutArray.map(row => ({
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
        // ★B6修正：従来は存在しないプロパティ pref.app?.name を参照していた。
        //   アプリ名は /k/v1/app/settings から取得できるため、そこから設定する。
        //   （権限不足などで取得できなかった場合のみ null）
        appName: pref.settings?.name ?? null,
        appDescription: pref.settings?.description ?? null,
        retrievedAt: new Date().toISOString()
      },
      fields: flatFields,
      layout: layoutOutline,
      views,
      reports,
      process: pref.status ? { enable: !!pref.status.enable, states: pref.status.states || [], actions: pref.status.actions || [] } : null,
      // ★B6修正：prefetch のプロパティ名に合わせる（pref.notifs / pref.acl は存在しなかった）
      notifications: {
        general: pref.generalNotify ?? null,
        perRecord: pref.perRecordNotify ?? null,
        reminder: pref.reminderNotify ?? null,
      },
      customize,
      acl: {
        app: pref.appAcl ?? null,
        record: pref.recordAcl ?? null,
        field: pref.fieldAcl ?? null,
      },
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

  async function renderTemplates(root, DATA, appId = null, { getContextInputs = null, runScan = null } = {}) {
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

    // レイアウト
    //   ★高さは vh 固定ではなく、親View（.kt-fill-view）→ .kt-split-layout → 各カラム → flex:1 の連鎖で追従させる。
    //   ID は Customize タブと重複しないよう kt-template-* に統一。
    view.innerHTML = `
      <div id="kt-template" class="kt-split-layout">
        <!-- 左：エディタ -->
        <div class="kt-split-col kt-flex-column" style="flex:2; --kt-col-min:380px; gap:10px;">
          <div class="kt-flex-fixed" style="display:flex; align-items:center; gap:10px; justify-content:space-between;">
            <div style="display:flex; align-items:center; gap:8px;">
              <button id="kt-template-download" class="btn" disabled style="height:32px; padding:0 10px;">⬇ ローカルに保存</button>
              <button id="kt-template-upload" class="btn" disabled style="height:32px; padding:0 10px;">⬆ アプリに反映</button>
            </div>
            <span id="kt-template-meta"
                  style="opacity:.75; max-width:55%; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; text-align:right;"></span>
          </div>

          <div id="kt-template-editor" class="kt-flex-fill"
            style="
              border:1px solid ${BD};
              border-radius:8px;
              background:${isDark ? '#0f0f0f' : '#fafafa'};
            ">
          </div>
        </div>

        <!-- 右：ファイル一覧 -->
        <div class="kt-split-col kt-flex-column" style="flex:1; --kt-col-min:240px; gap:10px;">
          <div class="kt-flex-fixed" style="display:flex; align-items:center; justify-content:space-between;
            padding:6px 0; background:${isDark ? '#1b1b1b' : '#fff'};">
            <div style="font-weight:600; padding-left:12px; margin:6px 0;">Files</div>
            <select id="kt-template-source" class="btn" style="padding:3px 4px; height:32px;">
              <option value="templates">Templates (GitHub: ${GH.dirs.templates})</option>
              <option value="css">Css  (GitHub: ${GH.dirs.css})</option>
              <option value="snippets">Snippets  (GitHub: ${GH.dirs.snippets})</option>
              <option value="documents">Documents (GitHub: ${GH.dirs.documents})</option>
              <option value="ai">AI向けドキュメント（Toolkit解析 → AI Prompt）</option>
            </select>
          </div>

          <div class="kt-flex-fixed" style="display:flex; gap:8px;">
            <button id="kt-template-insert" class="btn" disabled style="flex:1; height:32px;">⤴︎ 挿入</button>
            <button id="kt-template-refresh" class="btn" style="flex:1; height:32px;">↻ 一覧更新</button>
            <button id="kt-template-github" class="btn" style="flex:1; height:32px;">🔗 Github</button>
            <button id="kt-template-ai-req" class="btn" style="flex:1; height:32px; display:none;">AI prompt</button>
          </div>

          <div id="kt-template-list" class="kt-scroll-area"
            style="
              border:1px solid ${BD};
              border-radius:8px;
              background:${BG};
              padding:6px;
            ">
          </div>
          <!-- AI向けドキュメント（無料機能。source=ai のときだけ表示。KTContext → Prompt / Markdown / JSON） -->
          <div id="kt-template-ai" class="kt-scroll-area" style="display:none; border:1px solid ${BD}; border-radius:8px; background:${BG}; padding:8px;"></div>
          <div id="kt-template-overview" class="kt-flex-fixed"></div>
        </div>
      </div>
    `;

    // 要素参照
    const $list = view.querySelector('#kt-template-list');
    const $download = view.querySelector('#kt-template-download');
    const $meta = view.querySelector('#kt-template-meta');
    const $refresh = view.querySelector('#kt-template-refresh');
    const $insert = view.querySelector('#kt-template-insert');
    const $sourceSel = view.querySelector('#kt-template-source');
    const $overview = view.querySelector('#kt-template-overview');
    const $btnAIReq = view.querySelector('#kt-template-ai-req');
    const $upload = view.querySelector('#kt-template-upload');
    const $btnGithub = view.querySelector('#kt-template-github');
    const $editorHost = view.querySelector('#kt-template-editor');
    const $aiHost = view.querySelector('#kt-template-ai');

    // ---- AI向けドキュメント（KTContext）パネル。source=ai で表示。エディタはプレビューとして使う ----
    async function setAiPreview(text, lang = 'markdown') {
      try {
        if (!monacoEditor) await initEditor(text, $editorHost);
        else monacoEditor.setValue(text);
        setEditorLanguage(lang);
        // 日本語の全角記号が「紛らわしい Unicode」として枠表示されるのを抑える（プレビュー用途のため）
        try { monacoEditor.updateOptions({ unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false } }); } catch (e) { }
      } catch (e) {
        // Monaco（CDN）が使えない環境でもプレビューは出す
        $editorHost.innerHTML = `<pre style="margin:0; padding:8px; white-space:pre-wrap; font-size:12px; overflow:auto; height:100%;">${escapeHtml(text)}</pre>`;
      }
    }
    const aiPanel = (typeof getContextInputs === 'function')
      ? mountAiDocsPanel($aiHost, {
        getInputs: getContextInputs,
        setPreview: setAiPreview,
        copyText: (t) => KTExport.copyText(t),
        runScan,
        colors: { border: BD, bg: isDark ? '#1b1b1b' : '#fff' },
        // 有料: Nest Rec AI（接続情報は Refresh Token のみ localStorage・Customer Token は保存しない）
        settings: KTAiClient.createSettingsStore(),
        session: KTAiClient.createSession({ store: KTAiClient.createSettingsStore() }),
        // Preview Executor: このユーザーのセッション権限で動作テスト環境だけを書く（運用環境への反映関数は無い）
        executor: (() => { try { return { api: KTPlanExecutor.createKintoneApi(), appId: appId ?? (typeof kintone !== 'undefined' ? kintone.app.getId() : null) }; } catch (e) { return null; } })(),
      })
      : null;
    function applyAiMode(isAi) {
      $aiHost.style.display = isAi ? '' : 'none';
      $list.style.display = isAi ? 'none' : '';
      [$refresh, $btnGithub].forEach(b => { b.style.display = isAi ? 'none' : ''; });
      if (isAi) {
        $overview.style.display = 'none';
        $overview.innerHTML = '';
        $insert.style.display = 'none';
        $upload.disabled = true;
        $download.disabled = false;
        $meta.textContent = 'AI向けドキュメント：生成した Prompt / Markdown / JSON を左に表示します';
        if (aiPanel) aiPanel.refreshTargets();
      }
    }

    function updateAIReqVisibility() {
      const isAi = ($sourceSel.value === 'ai');
      applyAiMode(isAi);
      if (isAi) { $btnAIReq.style.display = 'none'; return; }
      // AI プレビューで切っていた Unicode の紛らわしい文字の強調を、通常のテンプレート編集に戻す
      try { monacoEditor?.updateOptions({ unicodeHighlight: { ambiguousCharacters: true, invisibleCharacters: true } }); } catch (e) { }
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
        <div style="flex:1">${escapeHtml(file.name)}</div>
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
          else await initEditor(code, $editorHost);
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
          else await initEditor(code, $editorHost);
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
          else await initEditor(code, $editorHost);
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
              <span>（ファイル:</span> <strong>${escapeHtml(file.name)}）</strong>
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
    await initEditor(KINTONE_TEMPLATE, $editorHost);
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
      // AI向けドキュメント：プレビュー中の出力をそのまま保存する
      if (selectedKind === 'ai') {
        const out = aiPanel ? aiPanel.currentOutput() : null;
        if (!out) { flashBtnText($download, '先に生成'); return; }
        KTExport.downloadText(out.filename, out.text, `${out.mime};charset=utf-8`);
        return;
      }
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
    // ★共通化：実体は KTApi.waitDeploy
    const waitDeploy = (appId) => KTApi.waitDeploy(appId);

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
      if (kind === 'ai') { updateAIReqVisibility(); return; }   // GitHub は参照しない
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
    if (!document.getElementById('kt-template-inline-style')) {
      const st = document.createElement('style');
      st.id = 'kt-template-inline-style';
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

    // === GitHub: snippetsのみ ===
    const GH = {
      owner: 'youtotto',
      repo: 'kintone-Customize-template',
      dirs: { snippets: 'snippets' },
      endpoint(dir) { return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${encodeURIComponent(dir)}`; },
    };

    // === レイアウト（Templatesタブと同じ見た目・同じサイズ制御） ===
    //   ★高さは vh 固定ではなく、親View（.kt-fill-view）→ .kt-split-layout → 各カラム → flex:1 の連鎖で追従させる。
    //   ID は Templates タブと重複しないよう kt-customize-* に統一。
    view.innerHTML = `
      <div id="kt-customize" class="kt-split-layout">
        <!-- 左：エディタ -->
        <div class="kt-split-col kt-flex-column" style="flex:2; --kt-col-min:380px; gap:10px;">
          <div class="kt-flex-fixed" style="display:flex; align-items:center; gap:10px; justify-content:space-between;">
            <div style="display:flex; align-items:center; gap:8px;">
              <button id="kt-customize-download" class="btn" disabled style="height:32px; padding:0 10px;">⬇ ローカルに保存</button>
              <button id="kt-customize-upload" class="btn" disabled style="height:32px; padding:0 10px;">⬆ アプリに反映</button>
              <button id="kt-customize-new" class="btn" style="height:32px; padding:0 10px;">＋ 新規作成</button>
            </div>
            <span id="kt-customize-meta"
                  style="opacity:.75; max-width:55%; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; text-align:right;"></span>
          </div>

          <div id="kt-customize-editor" class="kt-flex-fill"
            style="
              border:1px solid ${BD};
              border-radius:8px;
              background:${isDark ? '#0f0f0f' : '#fafafa'};
            ">
          </div>
        </div>

        <!-- 右：ファイル一覧（Customize / Snippets） -->
        <div class="kt-split-col kt-flex-column" style="flex:1; --kt-col-min:240px; gap:10px;">
          <div class="kt-flex-fixed" style="display:flex; align-items:center; justify-content:space-between;
            padding:6px 0; background:${isDark ? '#1b1b1b' : '#fff'};">
            <div style="font-weight:600; padding-left:12px; margin:6px 0;">Files</div>
            <select id="kt-customize-source" class="btn" style="padding:3px 4px; height:32px;">
              <option value="JavaScript">JavaScript (desktop)</option>
              <option value="css">CSS (desktop)</option>
              <option value="JavaScriptMobile">JavaScript (mobile)</option>
              <option value="cssMobile">CSS (mobile)</option>
              <option value="snippets">Snippets (GitHub: ${GH.dirs.snippets})</option>
            </select>
          </div>

          <div class="kt-flex-fixed" style="display:flex; gap:8px;">
            <button id="kt-customize-insert"  class="btn" disabled style="flex:1; height:32px;">⤴︎ 挿入</button>
            <button id="kt-customize-refresh" class="btn"          style="flex:1; height:32px;">↻ 一覧更新</button>
          </div>

          <div id="kt-customize-list" class="kt-scroll-area"
            style="
              border:1px solid ${BD};
              border-radius:8px;
              background:${BG};
              padding:6px;
            ">
          </div>
          <div id="kt-customize-overview" class="kt-flex-fixed"></div>
        </div>
      </div>
    `;

    // === 要素参照（このタブ内にスコープ） ===
    const $ = (s) => view.querySelector(s);
    const $list = $('#kt-customize-list');
    const $download = $('#kt-customize-download');
    const $upload = $('#kt-customize-upload');
    const $new = $('#kt-customize-new');
    const $meta = $('#kt-customize-meta');
    const $refresh = $('#kt-customize-refresh');
    const $insert = $('#kt-customize-insert');
    const $sourceSel = $('#kt-customize-source');
    const $overview = $('#kt-customize-overview');
    const $editorHost = $('#kt-customize-editor');

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
    // ★共通化：実体は KTApi（重複実装を廃止）
    const getCustomize = (app) => KTApi.getCustomize(app);
    const downloadByKey = (fileKey) => KTApi.downloadFile(fileKey);
    const uploadOnce = (name, content, mime) => KTApi.uploadFile(name, content, mime);
    function getKindByName(name) {
      const n = String(name || '').toLowerCase().trim();
      if (n.endsWith('.css')) return 'css';
      if (n.endsWith('.js')) return 'js';
      // 拡張子が無い/特殊な場合は nameヒントで雑に判定
      return n.includes('css') ? 'css' : 'js';
    }
    async function putPreviewReplace(app, target /* 'desktop'|'mobile' */, name, fileKey) {
      const kind = getKindByName(name);     // ← js or css
      const { data, source } = await KTApi.getCustomize(app);
      if (source !== 'preview') {
        // previewを取得できなかった場合、production をベースにPUTすることになる。
        // preview側の未反映の変更が失われる可能性があるため明示的に警告する。
        console.warn('[Customize] preview設定を取得できなかったため、production設定をベースに更新します');
      }

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

      await KTApi.putPreviewCustomize(app, payload);
    }
    // ★共通化：実体は KTApi.deployAndWait
    const deployAndWait = (app, pollMs = 1500, timeoutMs = 60000) =>
      KTApi.deployAndWait(app, { pollMs, timeoutMs });

    // GitHub snippets
    async function loadSnippets() {
      const res = await fetch(GH.endpoint(GH.dirs.snippets), { headers: { 'Accept': 'application/vnd.github+json' } });
      const json = await res.json();
      if (!Array.isArray(json)) return [];
      return json.filter(x => x.type === 'file' && /\.js$/i.test(x.name));
    }
    // ★修正：引用符未対応のローカル escapeHtml を廃止し、共通の escapeHtml を使用する

    // === ファイル行：Templatesタブの見た目に合わせたデザイン ===
    function fileRow({ name, size, badge = 'JS' }) {
      const el = document.createElement('div');
      el.style.cssText = `display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid ${BD};cursor:pointer;`;
      const sz = size ? Number(size) : 0; // "12345" でも OK
      el.innerHTML = `
        <div style="border:1px solid ${BD};border-radius:999px;padding:2px 6px;font-size:11px">${badge}</div>
        <div style="flex:1">${escapeHtml(name)}</div>
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
                  Snippet Overview <strong>${escapeHtml(f.name)}</strong>
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
        // ★バグ修正：アップロード先が 'desktop' 固定になっており、
        //   モバイルJS/CSSを選択していても desktop 側に登録されていた。
        //   選択中のターゲット（CURRENT.target）を使用する。
        const fileType = CURRENT.target === 'mobile' ? 'mobile' : 'desktop';
        const form = await openUploadDialog(currentFileName, fileType);
        if (!form) return; // cancel

        const fileKey = await uploadOnce(currentFileName, code, getMimeByName(currentFileName));
        await putPreviewReplace(appId, fileType, currentFileName, fileKey);
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
  // [Feature] Deps（依存関係グラフ）
  //  - 全件を最初から描かず、起点と絞り込みを選んで部分グラフを描く
  //  - ノード数の上限を設け、超過時は警告して切り詰める
  //  - 図／一覧の切替と Mermaidコードのコピーに対応する
  // ----------------------------
  // Mermaidの設定を1度だけ適用する
  //  既定の securityLevel は 'strict' で、click（ノードのリンク）が無効になる。
  //  リンクを使うため 'antiscript'（scriptタグは除去、リンクは許可）へ変更する。
  //  ラベルは生成側で危険文字を除去済みのため、HTMLが混入することはない。
  let __ktMermaidConfigured = false;
  function ensureMermaidConfig() {
    if (__ktMermaidConfigured) return true;
    if (!(window.mermaid && typeof window.mermaid.initialize === 'function')) return false;
    try {
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'antiscript' });
      __ktMermaidConfigured = true;
      return true;
    } catch (e) {
      console.warn('[Deps] Mermaidの設定に失敗しました（図中のリンクは無効になります）', e);
      return false;
    }
  }

  /**
   * Depsタブへ切り替え、指定フィールドを起点にしたグラフを表示する
   * （Fieldsタブの「図」ボタンから呼ばれる）
   */
  function openDepsGraphFor(root, fieldCode) {
    const tabBtn = root.querySelector('#tab-deps');
    if (tabBtn) tabBtn.click();

    const $focus = root.querySelector('#dp-focus');
    if (!$focus) return;
    const value = `FIELD:${fieldCode}`;
    // 選択肢に存在する場合のみ設定する（依存が1件も無いフィールドは選択肢に無い場合がある）
    const exists = [...$focus.options].some(o => o.value === value);
    if (!exists) return;
    if ($focus.value !== value) {
      $focus.value = value;
      // change を発火して既存の描画処理に任せる（描画ロジックを二重に持たない）
      $focus.dispatchEvent(new Event('change'));
    }
  }

  function renderDepsGraph(root, deps, appId, fieldsN = []) {
    const el = root.querySelector('#view-deps');
    if (!el) return;

    const C = getThemeColors();
    const BD = C.border;

    if (!deps) {
      el.innerHTML = `<div style="padding:14px;opacity:.8">依存関係データを生成できませんでした。</div>`;
      return;
    }

    // 起点候補（フィールド）。ラベルとコードを併記する
    const fieldNodes = (deps.nodes || [])
      .filter(n => n.type === 'FIELD')
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja'));

    const scopeKeys = Object.keys(KTDeps.GRAPH_SCOPES);
    // チェックボックス自体と文字を、図のノード色と同じ色にする（別途の色見本は置かない）
    // ダークモードでは沈まないよう明るい色を使う
    const scopeChecks = scopeKeys.map(k => {
      const sc = KTDeps.GRAPH_SCOPES[k];
      const col = (C.isDark ? sc.colorDark : sc.color) || '#888';
      return `
      <label style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap;cursor:pointer;color:${col}">
        <input type="checkbox" class="dp-scope" value="${escapeHtml(k)}" checked style="accent-color:${col};margin:0">
        <span>${escapeHtml(sc.label)}</span>
      </label>`;
    }).join('');

    el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div style="font-weight:700">Dependency Graph</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;align-items:center">
            <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;white-space:nowrap"
                   title="図の代わりに依存関係を表で表示します">
              <input type="checkbox" id="dp-list-mode" style="margin:0">
              <span>一覧で表示</span>
            </label>
            <button id="dp-draw" class="btn" title="最新の依存関係データで描き直します（Field ScannerのScan後などに使用）">再描画</button>
            <select id="dp-format" title="出力する形式を選びます"
                    style="padding:4px 8px;border-radius:8px;border:1px solid ${BD};background:${C.bgInput};color:${C.text};font-size:12px">
              <option value="mermaid" selected>Mermaid（表示中の図）</option>
              <option value="md">Markdown（アプリ全体）</option>
              <option value="md-used">Markdown（利用ありのみ）</option>
              <option value="csv">CSV（アプリ全体）</option>
              <option value="json">JSON（アプリ全体）</option>
            </select>
            <button id="dp-copy" class="btn" title="選択した形式をクリップボードへコピーします">Copy</button>
            <button id="dp-dl" class="btn" title="選択した形式をファイルとして保存します">DL</button>
          </div>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12px">
          <label style="display:inline-flex;align-items:center;gap:6px">
            <span>起点</span>
            <select id="dp-focus" style="max-width:260px;padding:4px 8px;border-radius:8px;border:1px solid ${BD};background:${C.bgInput};color:${C.text}">
              <option value="">（指定なし：全体）</option>
              ${fieldNodes.map(n => {
      const code = String(n.id).replace(/^FIELD:/, '');
      const text = n.name === code ? code : `${n.name}（${code}）`;
      return `<option value="${escapeHtml(n.id)}">${escapeHtml(text)}</option>`;
    }).join('')}
            </select>
          </label>

          <label style="display:inline-flex;align-items:center;gap:6px">
            <span>範囲</span>
            <select id="dp-depth" style="padding:4px 8px;border-radius:8px;border:1px solid ${BD};background:${C.bgInput};color:${C.text}">
              <option value="1" selected>直接依存のみ</option>
              <option value="2">直接＋間接依存</option>
            </select>
          </label>

          <label style="display:inline-flex;align-items:center;gap:6px" title="表示するノード数の上限">
            <span>上限(ノード)</span>
            <select id="dp-max" style="padding:4px 8px;border-radius:8px;border:1px solid ${BD};background:${C.bgInput};color:${C.text}">
              <option value="20">20</option>
              <option value="30" selected>30</option>
              <option value="60">60</option>
              <option value="120">120（重い）</option>
            </select>
          </label>

          <label style="display:inline-flex;align-items:center;gap:6px">
            <span>向き</span>
            <select id="dp-dir" style="padding:4px 8px;border-radius:8px;border:1px solid ${BD};background:${C.bgInput};color:${C.text}">
              <option value="LR" selected>横</option>
              <option value="TD">縦</option>
            </select>
          </label>

          <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap"
                 title="フィールド同士の関係だけを表示します">
            <input type="checkbox" id="dp-fields-only" style="margin:0">
            <span>フィールドのみ</span>
          </label>

          <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap"
                 title="種別ごとに枠で囲んで整理します">
            <input type="checkbox" id="dp-group" checked style="margin:0">
            <span>種別で囲む</span>
          </label>

          <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap"
                 title="矢印のラベル。関係が多いと文字量で読みにくくなるため、自動では省略します">
            <input type="checkbox" id="dp-labels" style="margin:0">
            <span>関係ラベル</span>
          </label>

          <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap"
                 title="ルックアップ等の相手アプリ側フィールドを、接続先アプリ1つにまとめます">
            <input type="checkbox" id="dp-fold" checked style="margin:0">
            <span>外部項目を集約</span>
          </label>
        </div>


        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:12px;padding:6px 8px;border:1px solid ${BD};border-radius:8px">
          <span style="opacity:.75">表示対象:</span>${scopeChecks}
          <span id="dp-legend" style="margin-left:auto;display:flex;gap:10px;align-items:center;font-size:11px;opacity:.9;white-space:nowrap">
            <span title="設定から取得した確実な依存">─ 実線＝確実</span>
            <span title="条件式・計算式・JavaScriptの解析による推定">┄ 破線＝推定</span>
            <span title="「起点」で選んだフィールドは、図の中で赤い太枠で表示されます">
              <span style="display:inline-block;padding:0 5px;border:2px solid #ef4444;border-radius:3px;line-height:1.3">A</span>
              赤枠＝選択した起点
            </span>
          </span>
        </div>

        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px">
          <span>検索</span>
          <input id="dp-search" type="search" placeholder="フィールド名・設定名・JSファイル名・アプリ名など（空白区切りでAND）"
                 style="flex:1;min-width:260px;padding:4px 8px;border-radius:8px;border:1px solid ${BD};background:${C.bgInput};color:${C.text}" />
          <span id="dp-search-count" style="font-size:11px;opacity:.75;white-space:nowrap"></span>
          <span id="dp-search-hint" style="font-size:10px;opacity:.55;white-space:nowrap;display:none">行クリックで起点に設定</span>
        </div>
        <div id="dp-search-result"></div>
        <style>
          .dp-badge{
            display:inline-block;padding:0 5px;border:1px solid currentColor;border-radius:999px;
            font-size:10px;opacity:.7;margin-right:3px;
          }
          #dp-search-result tr[data-focus]:not([data-focus=""]):hover{ background:rgba(128,128,128,.12); }
        </style>

        <div id="dp-status" style="font-size:11px;opacity:.8"></div>
        <div id="dp-warn" style="display:none"></div>
        <div id="dp-canvas" style="border:1px solid ${BD};border-radius:10px;padding:10px;overflow:auto;max-height:60vh"></div>
      </div>
    `;

    const $focus = el.querySelector('#dp-focus');
    const $depth = el.querySelector('#dp-depth');
    const $max = el.querySelector('#dp-max');
    const $fieldsOnly = el.querySelector('#dp-fields-only');
    const $dir = el.querySelector('#dp-dir');
    const $group = el.querySelector('#dp-group');
    const $labels = el.querySelector('#dp-labels');
    const $fold = el.querySelector('#dp-fold');
    const $listMode = el.querySelector('#dp-list-mode');
    const $status = el.querySelector('#dp-status');
    const $search = el.querySelector('#dp-search');
    const $searchCount = el.querySelector('#dp-search-count');
    const $searchResult = el.querySelector('#dp-search-result');
    const $searchHint = el.querySelector('#dp-search-hint');
    const $warn = el.querySelector('#dp-warn');
    const $canvas = el.querySelector('#dp-canvas');

    let lastCode = '';
    let renderSeq = 0; // 再描画の競合を避けるための通し番号
    let lastFocusMermaidId = null; // 起点ノードのMermaid上のID（描画後の強調に使う）

    const currentOptions = () => ({
      focusId: $focus.value || null,
      depth: Number($depth.value) || 1,
      maxNodes: Number($max.value) || 60,
      fieldsOnly: $fieldsOnly.checked,
      foldExternalFields: $fold.checked,
      scopes: [...el.querySelectorAll('.dp-scope')].filter(c => c.checked).map(c => c.value),
    });
    // ラベルは既定を 'auto'（関係が多いときだけ省略）とし、チェック時は常に表示する
    const mermaidOptions = (focusId) => ({
      focusId,
      direction: $dir.value === 'TD' ? 'TD' : 'LR',
      group: $group.checked,
      showLabels: $labels.checked ? true : 'auto',
      // 他アプリのノードだけリンクにする（自アプリ・不明は対象外）
      linkResolver: (n) => {
        if (n.type !== 'APP') return null;
        const id = String(n.id).replace(/^APP:/, '');
        if (!/^\d+$/.test(id) || id === String(appId)) return null;
        return KTApi.appUrl(id);
      },
    });

    // 確度の日本語表記（一覧表示で使う）
    const CONF_JA = { CERTAIN: '確実', LIKELY: '可能性が高い', UNCERTAIN: '要確認', NOT_ANALYZED: '解析対象外' };

    const renderList = (sub) => {
      if (!sub.edges.length) {
        $canvas.innerHTML = `<div style="padding:10px;opacity:.8">該当する依存関係はありません。</div>`;
        return;
      }
      // 接続先がアプリの場合はリンクにする
      const targetCell = (e) => {
        const text = e.targetName || e.targetId;
        if (e.targetType !== 'APP' || !/^\d+$/.test(String(e.targetId))) return escapeHtml(text);
        return `<a href="${escapeHtml(KTApi.appUrl(e.targetId))}" target="_blank" rel="noopener noreferrer"
                   style="color:inherit">${escapeHtml(text)} 🔗</a>`;
      };
      const rows = sub.edges.map(e => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid ${BD}">${escapeHtml(e.sourceName || e.sourceId)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid ${BD};white-space:nowrap">→ ${escapeHtml(e.relationType)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid ${BD}">${targetCell(e)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid ${BD};white-space:nowrap">${escapeHtml(CONF_JA[e.confidence] || e.confidence)}</td>
        </tr>`).join('');
      $canvas.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr>
            <th style="text-align:left;padding:6px 8px;border-bottom:1px solid ${BD}">利用する側</th>
            <th style="text-align:left;padding:6px 8px;border-bottom:1px solid ${BD}">関係</th>
            <th style="text-align:left;padding:6px 8px;border-bottom:1px solid ${BD}">利用される側</th>
            <th style="text-align:left;padding:6px 8px;border-bottom:1px solid ${BD}">確度</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    };

    const renderDiagram = (code, seq) => {
      $canvas.innerHTML = '';
      if (!code) {
        $canvas.innerHTML = `<div style="padding:10px;opacity:.8">該当する依存関係はありません。</div>`;
        return;
      }
      const div = document.createElement('div');
      div.className = 'mermaid';
      div.style.fontSize = '11px';
      // Mermaidコードは textContent で入れる（HTMLとして解釈させない）
      div.textContent = code;
      $canvas.appendChild(div);

      ensureMermaidConfig();

      const showCodeFallback = (msg, danger) => {
        $canvas.innerHTML = `<pre style="margin:0;white-space:pre-wrap;font-size:11px">${escapeHtml(code)}</pre>
          <div style="margin-top:6px;font-size:11px;${danger ? 'color:#c00' : 'opacity:.8'}">${escapeHtml(msg)}</div>`;
      };

      if (!(window.mermaid && typeof window.mermaid.run === 'function')) {
        showCodeFallback('Mermaidを読み込めなかったため、コードを表示しています。');
        return;
      }

      // 描画完了後のSVGに手を入れる
      const postProcess = () => {
        try {
          const svg = div.querySelector('svg');
          if (!svg) return;

          // ① リンクは必ず別タブで開く（Mermaidのバージョン差で _blank が付かないことがある）
          for (const a of svg.querySelectorAll('a')) {
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
            a.style.cursor = 'pointer';
          }

          // ② 起点ノードを赤枠にする
          //   classDef（CSSクラス）が style 指定に勝ってしまう場合があるため、
          //   描画後に該当ノードの図形へ直接スタイルを当てて確実に反映させる
          if (lastFocusMermaidId) {
            const g = svg.querySelector(`g.node[id*="-${lastFocusMermaidId}-"]`)
              || svg.querySelector(`g[id^="flowchart-${lastFocusMermaidId}-"]`);
            if (g) {
              for (const shape of g.querySelectorAll('rect, circle, ellipse, polygon, path')) {
                shape.style.stroke = '#ef4444';
                shape.style.strokeWidth = '3px';
              }
            }
          }
        } catch (e) {
          console.warn('[Deps] 図の後処理に失敗しました', e);
        }
      };

      const runMermaid = () => {
        try {
          // 再描画時に前回の結果が残らないよう、処理済みフラグを消してから実行する
          div.removeAttribute('data-processed');
          const p = window.mermaid.run({ nodes: [div] });
          // mermaid.run は Promise を返す（返さない版もあるため両対応）
          if (p && typeof p.then === 'function') p.then(postProcess).catch(() => postProcess());
          else postProcess();
        } catch (e) {
          console.error('Mermaid render error:', e);
          showCodeFallback('図の描画に失敗しました。コードを表示しています。', true);
        }
      };

      if (div.offsetParent !== null) {
        runMermaid();
      } else {
        // 非表示（別タブ）のときは、表示された瞬間に描画する
        const obs = new IntersectionObserver((entries) => {
          for (const en of entries) {
            if (!en.isIntersecting) continue;
            obs.disconnect();
            // 監視中に再描画されていたら、古い描画は行わない
            if (seq !== renderSeq) return;
            runMermaid();
          }
        });
        obs.observe(div);
      }
    };

    // ---- 依存関係の横断検索 ----
    // 起点セレクトはフィールドしか選べないため、設定名やJSファイル名から辿る入口として用意する。
    // 検索は依存関係データを絞り込むだけで、API取得や再描画は行わない。
    const CONF_JA_SEARCH = { CERTAIN: '確実', LIKELY: '可能性が高い', UNCERTAIN: '要確認', NOT_ANALYZED: '解析対象外' };

    const renderSearch = () => {
      if (!$search || !$searchResult) return;
      const q = $search.value || '';
      if (!q.trim()) {
        $searchResult.innerHTML = '';
        if ($searchCount) $searchCount.textContent = '';
        if ($searchHint) $searchHint.style.display = 'none';
        return;
      }

      const res = KTDeps.searchEdges(deps, q, { limit: 200 });
      if ($searchCount) {
        $searchCount.textContent = res.total
          ? `${res.total} 件${res.truncated ? `（上位 ${res.rows.length} 件を表示）` : ''}`
          : '該当なし';
      }

      if ($searchHint) $searchHint.style.display = res.total ? '' : 'none';

      if (!res.total) {
        $searchResult.innerHTML = `<div style="padding:6px 10px;font-size:12px;opacity:.8">該当する依存関係はありません。</div>`;
        return;
      }

      const rows = res.rows.map((r, i) => {
        const lines = (r.lines && r.lines.length)
          ? `<span style="opacity:.6;font-size:10px">${escapeHtml(r.lines.slice(0, 3).map(n => `${n}行目`).join(', '))}</span>`
          : '';
        // フィールドが絡む行は、クリックで起点にできるようにする
        const focusCode = (r.targetType === 'FIELD') ? r.targetId
          : (r.sourceType === 'FIELD' ? r.sourceId : '');
        return `
          <tr data-focus="${escapeHtml(focusCode)}" style="${focusCode ? 'cursor:pointer' : ''}">
            <td style="padding:4px 6px;border-bottom:1px solid ${BD};white-space:nowrap">
              <span class="dp-badge">${escapeHtml(r.sourceKind)}</span> ${escapeHtml(r.sourceName)}
            </td>
            <td style="padding:4px 6px;border-bottom:1px solid ${BD};white-space:nowrap;opacity:.8">→ ${escapeHtml(r.relation)}</td>
            <td style="padding:4px 6px;border-bottom:1px solid ${BD}">${escapeHtml(r.targetName)} ${lines}</td>
            <td style="padding:4px 6px;border-bottom:1px solid ${BD};white-space:nowrap;font-size:10px;opacity:.75">
              ${escapeHtml(CONF_JA_SEARCH[r.confidence] || r.confidence || '')}
            </td>
          </tr>`;
      }).join('');

      $searchResult.innerHTML = `
        <div style="max-height:200px;overflow:auto;border:1px solid ${BD};border-radius:8px">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="opacity:.7">
              <th style="text-align:left;padding:4px 6px">利用する側</th>
              <th style="text-align:left;padding:4px 6px">関係</th>
              <th style="text-align:left;padding:4px 6px">利用される側</th>
              <th style="text-align:left;padding:4px 6px">確度</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        `;

      // 行クリックで起点に設定して描画する
      for (const tr of $searchResult.querySelectorAll('tr[data-focus]')) {
        const code = tr.getAttribute('data-focus');
        if (!code) continue;
        tr.addEventListener('click', () => {
          const value = `FIELD:${code}`;
          if ($focus && [...$focus.options].some(o => o.value === value)) {
            $focus.value = value;
            $focus.dispatchEvent(new Event('change'));
          }
        }, { passive: true });
      }
    };

    const draw = () => {
      const seq = ++renderSeq;
      const opt = currentOptions();
      const sub = KTDeps.buildSubgraph(deps, opt);
      lastCode = KTDeps.toMermaid(sub, mermaidOptions(opt.focusId));
      // toMermaid は nodes の並び順に N0, N1 ... と採番するため、添字から起点のIDが分かる
      const focusIdx = opt.focusId ? sub.nodes.findIndex(n => n.id === opt.focusId) : -1;
      lastFocusMermaidId = focusIdx >= 0 ? `N${focusIdx}` : null;

      $status.textContent =
        `表示 ${sub.shownNodes} ノード / ${sub.shownEdges} 関係（絞り込み後の全体: ${sub.totalNodes} ノード / ${sub.totalEdges} 関係）`;


      if (sub.truncated) {
        $warn.style.display = 'block';
        $warn.innerHTML = `
          <div style="padding:8px 10px;border:1px solid #f59e0b55;background:#f59e0b0f;border-radius:8px;font-size:11px;line-height:1.7">
            <b>ノード数が上限（${opt.maxNodes}）を超えたため、一部のみ表示しています。</b>
            起点フィールドを指定する、表示対象を絞る、「直接依存のみ」にするなどで対象を減らしてください。
          </div>`;
      } else {
        $warn.style.display = 'none';
        $warn.innerHTML = '';
      }

      if ($listMode.checked) renderList(sub);
      else renderDiagram(lastCode, seq);
    };

    // 検索は入力のたびに走るため、少し待ってからまとめて実行する
    let searchTimer = null;
    if ($search) {
      $search.addEventListener('input', () => {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { searchTimer = null; renderSearch(); }, 200);
      }, { passive: true });
    }

    // 連続操作（セレクトのキーボード操作や複数チェックの切り替え）でも
    // 描画が何度も走らないよう、少し待ってからまとめて実行する
    let drawTimer = null;
    const scheduleDraw = () => {
      if (drawTimer) clearTimeout(drawTimer);
      drawTimer = setTimeout(() => { drawTimer = null; draw(); }, 200);
    };

    // すべての設定は変更した時点で反映する（「描画」を押さないと反映されない項目をなくす）
    const allControls = [
      $focus, $depth, $max, $dir,
      $fieldsOnly, $group, $labels, $fold, $listMode,
      ...el.querySelectorAll('.dp-scope'),
    ];
    for (const $c of allControls) {
      if ($c) $c.addEventListener('change', scheduleDraw, { passive: true });
    }

    // ボタンは即時に描き直す（JS解析の完了後など、最新の依存データで描き直したいとき用）
    el.querySelector('#dp-draw').addEventListener('click', () => {
      if (drawTimer) { clearTimeout(drawTimer); drawTimer = null; }
      draw();
    }, { passive: true });

    // ---- 出力（Copy / DL）----
    // 形式はセレクトで選ぶ。Mermaidは「表示中の図」、それ以外は「アプリ全体」が対象。
    const $format = el.querySelector('#dp-format');

    /**
     * 選択中の形式で出力内容を組み立てる
     * レポート生成は全フィールドの影響分析が走るため、押されたときだけ実行する
     * @returns {{text:string, filename:string, mime:string}|null}
     */
    const buildOutput = () => {
      const fmt = $format ? $format.value : 'mermaid';
      switch (fmt) {
        case 'md':
        case 'md-used':
          return {
            text: KTDeps.toMarkdown(deps, { fields: fieldsN, onlyUsed: fmt === 'md-used' }),
            filename: `kintone_dependencies_${appId}.md`,
            mime: 'text/markdown;charset=utf-8',
          };
        case 'csv':
          return {
            // Excelでの文字化けを避けるためBOMを付ける
            text: '\uFEFF' + KTDeps.toCSV(deps),
            filename: `kintone_dependencies_${appId}.csv`,
            mime: 'text/csv;charset=utf-8',
          };
        case 'json':
          return {
            text: KTDeps.toJSON(deps),
            filename: `kintone_dependencies_${appId}.json`,
            mime: 'application/json;charset=utf-8',
          };
        case 'mermaid':
        default:
          // Mermaidは表示中の図が対象。まだ描画していない場合は出力できない
          if (!lastCode) return null;
          return {
            text: lastCode,
            filename: `kintone_deps_${appId}.mmd`,
            mime: 'text/plain;charset=utf-8',
          };
      }
    };

    el.querySelector('#dp-copy').addEventListener('click', async () => {
      const btn = el.querySelector('#dp-copy');
      let out = null;
      try {
        out = buildOutput();
      } catch (e) {
        console.error('[Deps] 出力の生成に失敗しました', e);
        flashBtnText(btn, 'Failed');
        return;
      }
      if (!out) { flashBtnText(btn, '先に描画'); return; }
      try {
        await navigator.clipboard.writeText(out.text);
        flashBtnText(btn, 'Copied!');
      } catch (e) {
        console.error('[Deps] クリップボードへのコピーに失敗しました', e);
        flashBtnText(btn, 'Failed');
      }
    }, { passive: true });

    el.querySelector('#dp-dl').addEventListener('click', () => {
      const btn = el.querySelector('#dp-dl');
      let out = null;
      try {
        out = buildOutput();
      } catch (e) {
        console.error('[Deps] 出力の生成に失敗しました', e);
        flashBtnText(btn, 'Failed');
        return;
      }
      if (!out) { flashBtnText(btn, '先に描画'); return; }
      KTExport.downloadText(out.filename, out.text, out.mime);
      flashBtnText(btn);
    }, { passive: true });

    // 初期表示は描画せず、操作方法だけ案内する（大規模アプリで固まらないようにする）
    $status.textContent =
      `全体では ${(deps.nodes || []).length} ノード / ${(deps.edges || []).length} 関係が検出されています。`;
    $canvas.innerHTML = `
      <div style="padding:14px;opacity:.85;font-size:12px;line-height:1.9">
        <b>上の「起点」からフィールドを1つ選んでください。</b>すぐに図が表示されます。<br>
        設定を変更するとその場で描き直されます（初期状態では、大量のノードを一度に描いて重くならないよう図を出しません）。<br>
        <span style="opacity:.75">
          図が複雑すぎるときは、①起点を指定する ②「直接依存のみ」にする ③表示対象のチェックを減らす
          ④「フィールドのみ」にする ⑤「一覧で表示」に切り替える、のいずれかをお試しください。
        </span>
      </div>`;
  }

  // ----------------------------
  // [Feature] Field Scanner
  // ----------------------------
  async function renderScanner(root, DATA) {
    const el = root.querySelector('#view-field-scanner');
    if (!el) return;
    el.innerHTML = '';
    // ★追加：依存関係データ（エントリポイントで生成）と、統合後にFieldsタブを再描画するコールバック
    const { deps = null, onDepsUpdated = null } = DATA || {};

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
          /* ★ボタンは共通スタイル（#kt-toolkit .btn）に統一するため、ここでは上書きしない。
             従来は背景色と height:32px を独自指定しており、他タブと見た目が揃っていなかった。 */
          #fs-wrap select {
            background: var(--fs-bg);
            color: inherit;
            border: 1px solid var(--fs-bd);
            border-radius: 8px;
            padding: 4px 8px;
            outline: none;
          }
          #fs-wrap select:hover { filter: brightness(${isDark ? '1.15' : '0.98'}); }
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

        <div id="fs-wrap" class="kt-flex-column" style="height:100%; gap:12px;">
          <div class="kt-flex-fixed" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
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

            <label style="display:inline-flex; align-items:center; gap:6px; margin-left:auto; font-size:12px; cursor:pointer;"
                   title="Toolkit起動時にJavaScriptを自動解析し、Fields／Relationsタブへ反映します（結果は6時間キャッシュされます）">
              <input type="checkbox" id="fs-auto" />
              <span>自動解析</span>
            </label>
            <label style="display:inline-flex; align-items:center; gap:6px; font-size:12px; white-space:nowrap;"
                   title="ファイル起点＝このJSがいつ動き何を触るか／フィールド起点＝どのフィールドがJSで使われているか">
              <span>表示</span>
              <select id="fs-view" style="padding:4px 8px;">
                <option value="file" selected>ファイル起点</option>
                <option value="field">フィールド起点</option>
              </select>
            </label>
            <button id="fs-scan" class="btn" title="キャッシュを無視して再取得します">Scan</button>
            <div style="display:flex; gap:8px;">
              <button id="fs-copy-md"  class="btn">Copy MD</button>
              <button id="fs-dl-md"    class="btn">DL MD</button>
              <button id="fs-dl-csv"   class="btn">DL CSV</button>
              <button id="fs-dl-json"  class="btn">DL JSON</button>
            </div>
          </div>

          <div id="fs-meta" class="kt-flex-fixed" style="opacity:.8; font-size:12px;">未実行</div>

          <!-- 結果領域：残り高さをすべて使い、内部だけスクロール（ファイル起点／フィールド起点とも同じ高さ） -->
          <div id="fs-file-view" class="kt-scroll-area">
            <div style="padding:14px; opacity:.8;">解析結果を待っています。</div>
          </div>

          <div id="fs-table-wrap" class="kt-scroll-area" style="display:none;">
            <table id="fs-table" style="width:100%; border-collapse:collapse;">
              <thead>
                <tr>
                  <th style="text-align:left; position:sticky; top:0; padding:8px;">Used</th>
                  <th style="text-align:left; position:sticky; top:0; padding:8px;">FieldCode</th>
                  <th style="text-align:left; position:sticky; top:0; padding:8px;">Label</th>
                  <th style="text-align:left; position:sticky; top:0; padding:8px;">Type</th>
                  <th style="text-align:right; position:sticky; top:0; padding:8px;">Matches</th>
                  <th style="text-align:left; position:sticky; top:0; padding:8px;">Access</th>
                  <th style="text-align:left; position:sticky; top:0; padding:8px;">Files</th>
                </tr>
              </thead>
              <tbody id="fs-tbody">
                <tr><td colspan="7" style="padding:14px; opacity:.8;">Scanボタンを押してください。</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      `;

      // --- ユーティリティ ---
      // ★B5修正：window.KTExport / window.flashBtnText は未登録のため常に空オブジェクトになり、
      //   KTExport統一パスがデッドコードだった。クロージャ上の共通 KTExport / flashBtnText を
      //   そのまま使用する（下の dlText / copyText のフォールバックは保険として残置）。

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
        { header: 'Access', select: r => r.accessSummary || '' },
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
        lines.push(`| Used | Code | Label | Type | Matches | Access | Files |`);
        lines.push(`|:---:|:-----|:------|:-----|-------:|:-------|:------|`);
        for (const r of results) {
          const fileStr = (r.files || []).join('<br>');
          lines.push(`| ${r.used ? '✅' : '—'} | \`${r.code}\` | ${r.label ?? ''} | ${r.type ?? ''} | ${r.count} | ${r.accessSummary || ''} | ${fileStr} |`);
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
      const $fileView = el.querySelector('#fs-file-view');
      const $tableWrap = el.querySelector('#fs-table-wrap');
      const $view = el.querySelector('#fs-view');

      let FS_last = null;

      const resolveInclude = (v) =>
        v === 'desktop' ? { desktop: true, mobile: false } :
          v === 'mobile' ? { desktop: false, mobile: true } :
            { desktop: true, mobile: true };

      const resolveKinds = (v) =>
        v === 'css' ? ['css'] : (v === 'both' ? ['js', 'css'] : ['js']);

      // ---- fields ----
      async function fetchFieldList(resp, layout) {
        // フォーム定義・レイアウトは prefetch 済みの値を使う。
        // 空のまま進むと全コードが「存在しない」と誤判定されるため、念のため取り直す。
        let props = (resp && typeof resp === 'object' && resp.properties) ? resp.properties : (resp || {});
        if (!Object.keys(props).length) {
          try {
            const f = await kintone.app.getFormFields();
            props = (f && f.properties) ? f.properties : (f || {});
            console.warn('[Field Scanner] フィールド定義が空だったため再取得しました', Object.keys(props).length);
          } catch (e) {
            console.error('[Field Scanner] フィールド定義の再取得に失敗しました', e);
          }
        }

        let layoutNodes = Array.isArray(layout) ? layout : (layout?.layout || []);
        if (!layoutNodes.length) {
          try {
            const l = await kintone.app.getFormLayout();
            layoutNodes = Array.isArray(l) ? l : (l?.layout || []);
            console.warn('[Field Scanner] レイアウトが空だったため再取得しました', layoutNodes.length);
          } catch (e) {
            console.error('[Field Scanner] レイアウトの再取得に失敗しました', e);
          }
        }

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

        // ★レイアウトにしか現れない識別子を追加する
        //   JavaScriptは以下も「コード」として指定するが、いずれも form/fields には含まれない。
        //     - グループコード      : setFieldShown('group02', false)
        //     - サブテーブルコード  : setFieldShown('明細', false)
        //     - 要素ID（スペース等）: getSpaceElement('TAG_MENU')
        //   これらを既知リストに入れておかないと、すべて「存在しないコード」と誤検出される。
        const seen = new Set(out.map(f => f.code));
        const add = (code, label, type) => {
          if (!code || seen.has(code)) return;
          seen.add(code);
          out.push({ code, label: label || code, type });
        };

        const walkLayout = (nodes) => {
          for (const n of nodes || []) {
            if (!n) continue;

            if (n.type === 'GROUP') {
              add(n.code, n.label, 'GROUP');
              walkLayout(n.layout);          // グループ内の行を辿る
              continue;
            }

            if (n.type === 'SUBTABLE') {
              add(n.code, n.label, 'SUBTABLE');
              for (const sf of n.fields || []) {
                if (sf?.code) add(sf.code, sf.label, sf.type || 'FIELD');
                else if (sf?.elementId) add(sf.elementId, sf.label, `ELEMENT_${sf.type || ''}`);
              }
              continue;
            }

            if (n.type === 'ROW') {
              for (const f of n.fields || []) {
                if (!f) continue;
                if (f.type === 'SUBTABLE') {
                  add(f.code, f.label, 'SUBTABLE');
                  for (const sf of f.fields || []) {
                    if (sf?.code) add(sf.code, sf.label, sf.type || 'FIELD');
                  }
                  continue;
                }
                // 通常フィールド（form/fields にもあるが、念のため）
                if (f.code) { add(f.code, f.label, f.type || 'FIELD'); continue; }
                // ★スペース・ラベル・罫線などの要素ID（codeを持たない）
                if (f.elementId) add(f.elementId, f.label || `(${f.type || 'ELEMENT'})`, `ELEMENT_${f.type || ''}`);
              }
              continue;
            }

            // 想定外のノードでも layout / fields があれば辿る
            if (Array.isArray(n.layout)) walkLayout(n.layout);
          }
        };
        walkLayout(layoutNodes);

        return out;
      }

      // ---- テキスト取得（URLは既定でスキップ、FILEのみ実体取得）----
      async function fetchTexts({ appId, include, kinds }) {
        const apiUrl = (p) => kintone.api.url(p, true);

        // ★共通化：preview優先 → production（実体は KTApi）
        const downloadByKey = (fileKey) => KTApi.downloadFile(fileKey);

        const { data } = await KTApi.getCustomize(appId);
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

        // ★改善：直列ダウンロードを並列化（結果の順序は chosen の順を維持）
        const out = await Promise.all(chosen.map(async (t) => {
          try {
            if (t.fileKey) {
              // FILEタイプは実体取得
              const text = await downloadByKey(t.fileKey);
              return { name: t.name || '(no-name)', target: t.target, kind: t.kind, text };
            }
            if (t.url) {
              // URLタイプ：同一オリジンのみ取得、外部URLは解析対象外（NOT_ANALYZED）
              const sameOrigin = (() => {
                try { return new URL(t.url, location.href).hostname === location.hostname; }
                catch { return false; }
              })();
              if (sameOrigin) {
                try {
                  const res = await fetch(t.url, { credentials: 'include' });
                  const text = res.ok ? await res.text() : '';
                  return { name: t.name || t.url, target: t.target, kind: t.kind, text, note: res.ok ? undefined : 'URL fetch failed' };
                } catch (e) {
                  return { name: t.name || t.url, target: t.target, kind: t.kind, text: '', note: 'URL fetch error (skipped)' };
                }
              }
              return { name: t.name || t.url, target: t.target, kind: t.kind, text: '', note: 'external URL (skipped)' };
            }
            return { name: t.name || '(unknown)', target: t.target, kind: t.kind, text: '' };
          } catch (e) {
            // いかなる場合も落とさず、空テキストで残す
            return { name: t.name || '(no-name)', target: t.target, kind: t.kind, text: '', note: String(e) };
          }
        }));
        return out;
      }

      // ---- analyze ----
      // ★コメント除去・行番号算出などの純粋な処理は KTScan 側に移設（回帰テストの対象）
      const stripCommentsOnly = KTScan.stripCommentsOnly;

      /**
       * kintone.events.on(...) で登録されているイベント種別を抽出する
       * 対応形式：
       *   kintone.events.on('app.record.create.show', ...)
       *   kintone.events.on(['app.record.create.show', 'app.record.edit.show'], ...)
       *   kintone.events.on(EVENTS, ...) → 変数指定は特定できないため対象外
       * @returns {string[]} 重複を除いたイベント種別
       */
      // kintoneのイベント名の形か（app.record.* / mobile.app.record.* / app.report.show など）
      const EVENT_NAME_RE = /^(mobile\.)?app\.(record|report)\.[A-Za-z0-9_.\u00C0-\uFFFF]+$/;

      function extractEventTypes(cleanText) {
        const s = String(cleanText || '');
        const direct = new Set();

        // ---- ① kintone.events.on(...) の第1引数から検出（確実）----
        //   文字列リテラル、または配列リテラルをそのまま渡している場合に対応する
        const rx = /kintone\.events\.on\s*\(\s*(\[[^\]]*\]|['"`][^'"`]*['"`])/g;
        let m;
        while ((m = rx.exec(s)) !== null) {
          const strRx = /['"`]([^'"`]+)['"`]/g;
          let sm;
          while ((sm = strRx.exec(m[1])) !== null) {
            const ev = sm[1].trim();
            if (EVENT_NAME_RE.test(ev)) direct.add(ev);
          }
        }

        // ---- ② ファイル内のイベント名らしき文字列から検出（推定）----
        //   var events = [...]; kintone.events.on(events, cb) のような
        //   変数経由の書き方は①では拾えないため、文字列リテラル全体を走査して補う。
        //   「登録に使われている」とは限らないので、確度は下げて扱う。
        const inferred = new Set();
        if (/kintone\.events\.on\s*\(/.test(s)) {
          const anyStr = /['"`]([^'"`\n]+)['"`]/g;
          let am;
          while ((am = anyStr.exec(s)) !== null) {
            const ev = am[1].trim();
            if (EVENT_NAME_RE.test(ev) && !direct.has(ev)) inferred.add(ev);
          }
        }

        return [
          ...[...direct].sort().map(name => ({ name, direct: true })),
          ...[...inferred].sort().map(name => ({ name, direct: false })),
        ];
      }

      // 行番号算出用（実体は KTScan 側）
      const buildLineIndex = KTScan.buildLineIndex;
      const lineAt = KTScan.lineAt;

      // ---- 未知フィールドコードの検出 ----
      // Field Scanner の通常解析は「既知のフィールドコードを探す」方式のため、
      // 存在しないコードは原理的に見つけられない。
      // ここでは逆に「コードらしき文字列」を先に抽出し、フィールド一覧に無いものを洗い出す。
      // ★抽出ロジックの実体は KTScan 側にある（純粋なテキスト解析。回帰テストの対象）。
      const extractFieldCodeCandidates = (cleanText, lineIndexFn) =>
        KTScan.extractFieldCodeCandidates(cleanText, lineIndexFn);

      /**
       * JavaScript内で「ステータスと比較している文字列」を抽出する
       *
       *   record['ステータス'].value === '承認待ち'
       *   event.record.ステータス.value !== '完了'
       *   '完了' === record['ステータス'].value      （左右が逆の書き方）
       *
       * ステータス名を変更してもJavaScriptは追随しないため、
       * 存在しない名前との比較が残ると条件が成立しなくなる。
       * @returns {Array<{value, line}>}
       */
      function extractStatusComparisons(cleanText, statusCodes, lineIndexFn) {
        const s = String(cleanText || '');
        if (!s) return [];
        const out = [];
        const push = (value, index) => {
          const v = String(value || '').trim();
          if (v) out.push({ value: v, line: lineIndexFn ? lineIndexFn(index) : null });
        };
        const esc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // --- ステータス値を持つ式を列挙する ---
        //   プロセス管理のイベントでは event.nextStatus.value / event.status.value、
        //   レコードからはステータスフィールドの .value がステータス名になる。
        const exprs = ['event\\s*\\.\\s*(?:nextStatus|status)\\s*\\.\\s*value'];
        for (const code of (statusCodes || [])) {
          const c = esc(code);
          exprs.push(`record\\s*(?:\\[\\s*['"\`]${c}['"\`]\\s*\\]|\\.${c})\\s*\\.\\s*value`);
        }

        // --- 上記を代入した変数も追跡する ---
        //   例: const nStatus = event.nextStatus.value;
        const tokens = [...exprs];
        const rxAssign = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
        let am;
        while ((am = rxAssign.exec(s)) !== null) {
          const name = am[1];
          const rhs = am[2];
          if (exprs.some(e => new RegExp(e).test(rhs))) tokens.push(esc(name));
        }

        for (const token of tokens) {
          // 比較（左右どちらに文字列が来る書き方にも対応）
          const rxA = new RegExp(`${token}\\s*(?:===?|!==?)\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
          const rxB = new RegExp(`['"\`]([^'"\`]+)['"\`]\\s*(?:===?|!==?)\\s*${token}`, 'g');
          for (const rx of [rxA, rxB]) {
            let m;
            while ((m = rx.exec(s)) !== null) push(m[1], m.index);
          }

          // switch 文の case ラベル
          //   例: switch (nStatus) { case 'A03:1次Aチェック中': ... }
          const rxSw = new RegExp(`switch\\s*\\(\\s*${token}\\s*\\)\\s*\\{`, 'g');
          let sm;
          while ((sm = rxSw.exec(s)) !== null) {
            // 対応する閉じ括弧までを switch の本体とみなす
            let depth = 0;
            let end = -1;
            for (let i = sm.index + sm[0].length - 1; i < s.length; i++) {
              if (s[i] === '{') depth++;
              else if (s[i] === '}') {
                depth--;
                if (depth === 0) { end = i; break; }
              }
            }
            const bodyText = s.slice(sm.index, end < 0 ? s.length : end);
            const rxCase = /case\s*['"`]([^'"`]+)['"`]\s*:/g;
            let cm;
            while ((cm = rxCase.exec(bodyText)) !== null) push(cm[1], sm.index + cm.index);
          }
        }

        // 同じ値・同じ行の重複を除く
        const seen = new Set();
        return out.filter(o => {
          const k = `${o.value}|${o.line}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }

      /**
       * JavaScript内の比較のうち、存在しないステータス名を集約する
       * @returns {Array<{value, files:Array, count:number}>}
       */
      function collectUnknownStatusRefs(files, statusStates, statusCodes) {
        const known = new Set(statusStates || []);
        // プロセス管理が無効なアプリでは検証しない（すべて未知になってしまうため）
        // ステータスフィールドが無くても event.nextStatus 経由の判定は検証できる
        if (!known.size) return [];

        const agg = new Map();
        for (const f of files || []) {
          if (f.kind !== 'js' || !f.text) continue;
          const clean = stripCommentsOnly(f.text);
          const li = buildLineIndex(clean);
          for (const c of extractStatusComparisons(clean, statusCodes, (i) => lineAt(li, i))) {
            if (known.has(c.value)) continue;
            let a = agg.get(c.value);
            if (!a) { a = { value: c.value, files: new Map(), count: 0 }; agg.set(c.value, a); }
            a.count++;
            const key = `${f.target}:${f.name}`;
            if (!a.files.has(key)) a.files.set(key, []);
            const lines = a.files.get(key);
            if (lines.length < 10 && !lines.includes(c.line)) lines.push(c.line);
          }
        }
        return [...agg.values()]
          .map(a => ({
            value: a.value, count: a.count,
            files: [...a.files.entries()].map(([name, lines]) => ({ name, lines: [...lines].sort((x, y) => x - y) })),
          }))
          .sort((a, b) => String(a.value).localeCompare(String(b.value), 'ja'));
      }

      // 「存在しないフィールド参照」「外部アプリのフィールド参照」の集約（実体は KTScan 側）
      const collectUnknownFieldRefs = KTScan.collectUnknownFieldRefs;
      const collectExternalFieldRefs = KTScan.collectExternalFieldRefs;

      // パターン種別付きの正規表現を作る
      //   ELEMENT: getFieldElement(s)('code') / BRACKET: ['code'] / QUOTED: 'code' / BARE: 裸の識別子
      function buildRegexps(code) {
        const safe = String(code || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pats = [
          { kind: 'ELEMENT', rx: new RegExp(`getFieldElements?\\(\\s*['"\`]${safe}['"\`]\\s*\\)`, 'gu') },
          { kind: 'BRACKET', rx: new RegExp(`\\[\\s*['"\`]${safe}['"\`]\\s*\\]`, 'gu') },
          { kind: 'QUOTED', rx: new RegExp(`['"\`]${safe}['"\`]`, 'gu') },
        ];
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(code)) {
          pats.push({ kind: 'BARE', rx: new RegExp(`(?<![A-Za-z0-9_$])${safe}(?![A-Za-z0-9_$])`, 'g') });
        }
        return pats;
      }

      // アクセス種別の推定（正規表現ベースの簡易判定。断定せず confidence を必ず併記する）
      //   READ / WRITE / ELEMENT / SHOW_HIDE / CONTROL / FIELDS_PARAM / QUERY / OTHER
      function classifyAccess(text, start, end, kind) {
        if (kind === 'ELEMENT') return { access: 'ELEMENT', confidence: 'HIGH' };
        const before = text.slice(Math.max(0, start - 80), start);
        const after = text.slice(end, end + 80);

        if (/setFieldShown\(\s*$/.test(before)) return { access: 'SHOW_HIDE', confidence: 'HIGH' };

        // 裸の識別子は同名変数・関数名の可能性があるため確度を1段下げる
        const cap = (c) => (kind === 'BARE')
          ? (c === 'HIGH' ? 'MEDIUM' : 'LOW')
          : c;

        // .value.push() など、配列を直接書き換える呼び出しは WRITE として扱う
        if (/^\s*\.value\s*\.\s*(push|pop|shift|unshift|splice|sort|reverse|fill)\s*\(/.test(after)) {
          return { access: 'WRITE', confidence: cap('HIGH') };
        }
        const mv = after.match(/^\s*\.value\s*(=(?!=)|\+=|-=|\*=|\/=)?/);
        if (mv) return { access: mv[1] ? 'WRITE' : 'READ', confidence: cap('HIGH') };
        if (/^\s*\.(disabled|error)\s*=/.test(after)) return { access: 'CONTROL', confidence: cap('HIGH') };
        // fields: [...] の中（BRACKETマッチでは '[' がマッチ側に含まれるため、'[' 無しの形も許容する）
        if (/fields\s*:\s*(\[[^\]]*)?$/.test(before)) return { access: 'FIELDS_PARAM', confidence: cap('MEDIUM') };
        if (/query\s*[:=]\s*['"`][^'"`\n]*$/.test(before)) return { access: 'QUERY', confidence: cap('MEDIUM') };

        // record['CODE'] をそのまま関数へ渡している（読み取りも書き換えもあり得るため用途は断定しない）
        //   例: const err = textCheck(record['得意先名']);
        if (/record\s*$/.test(before) && /^\s*[),]/.test(after)) {
          return { access: 'ARGUMENT', confidence: cap('MEDIUM') };
        }

        // 配列リテラルに列挙されている（後で record[配列[i]] のように使われることが多い）
        //   例: const filedName = ['会計_担当者1_KintoneUser', '会計_担当者2_KintoneUser'];
        if (/[[,]\s*$/.test(before) && /^\s*[,\]]/.test(after)) {
          return { access: 'LIST', confidence: cap('MEDIUM') };
        }
        // 要素が1つだけの配列は ['CODE'] 全体がマッチするため、上の判定に掛からない。
        // 直前が識別子（record など）でなければ、添字アクセスではなく配列リテラルとみなす。
        if (kind === 'BRACKET' && !/[\w$\])]\s*$/.test(before)) {
          return { access: 'LIST', confidence: cap('MEDIUM') };
        }

        return { access: 'OTHER', confidence: 'LOW' };
      }

      // 1ファイル内の全マッチを取得し、重複スパンを除去する
      // ★改善：従来は ['code'] が BRACKET と QUOTED の両方にヒットし二重カウントされていた
      function findAllMatches(text, pats) {
        const all = [];
        for (const p of pats) {
          let m;
          while ((m = p.rx.exec(text)) !== null) {
            all.push({ start: m.index, end: m.index + m[0].length, kind: p.kind });
          }
        }
        // 開始位置昇順・長い方優先で並べ、重なるスパンは捨てる
        all.sort((a, b) => (a.start - b.start) || (b.end - a.end));
        const kept = [];
        let lastEnd = -1;
        for (const h of all) {
          if (h.start < lastEnd) continue;
          kept.push(h);
          lastEnd = h.end;
        }
        return kept;
      }

      function analyze({ fields, files, snippet }) {
        const { before = 24, after = 48 } = snippet || {};
        const cleans = files.map(f => {
          const clean = stripCommentsOnly(f.text || '');
          return { ...f, clean, lineIdx: buildLineIndex(clean) };
        });
        const results = [];
        for (const fld of fields) {
          if (!fld.code) continue;
          const pats = buildRegexps(fld.code);
          let count = 0;
          const usedIn = [];
          const samples = [];
          const matches = [];      // 全マッチ詳細（JSON出力・依存関係データ統合用）
          const accessCounts = {}; // アクセス種別ごとの件数

          for (const f of cleans) {
            if (!f.clean) continue;
            const hits = findAllMatches(f.clean, pats);
            if (!hits.length) continue;
            count += hits.length;
            usedIn.push(`${f.target}: ${f.name}`);
            let sampled = 0;
            for (const h of hits) {
              const cls = classifyAccess(f.clean, h.start, h.end, h.kind);
              const line = lineAt(f.lineIdx, h.start);
              accessCounts[cls.access] = (accessCounts[cls.access] || 0) + 1;
              const s = Math.max(0, h.start - before);
              const e = Math.min(f.clean.length, h.end + after);
              const snip = f.clean.slice(s, e).replace(/\n/g, '⏎');
              matches.push({
                file: f.name, target: f.target, kind: f.kind,
                line, access: cls.access, confidence: cls.confidence, snippet: snip,
              });
              if (sampled < 2) {
                samples.push({
                  file: `${f.target}: ${f.name}`, line,
                  access: cls.access, confidence: cls.confidence, snippet: snip,
                });
                sampled++;
              }
            }
          }

          const accessSummary = Object.entries(accessCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}×${v}`)
            .join(', ');

          results.push({
            code: fld.code, label: fld.label, type: fld.type,
            used: count > 0, count, files: usedIn,
            samples, matches, accessCounts, accessSummary,
          });
        }
        results.sort((a, b) => (Number(b.used) - Number(a.used)) || (b.count - a.count) || String(a.code).localeCompare(String(b.code)));
        return results;
      }

      // ---- 表示 & エクスポート ----

      function renderTable(results) {
        const rows = results.map(r => {
          // ★エスケープ漏れ修正：code / label / type / files / snippet をすべてエスケープする
          const filesHtml = (r.files || []).map(s => `<div>${escapeHtml(s)}</div>`).join('');
          const accessHtml = escapeHtml(r.accessSummary || '');
          const samples = r.samples && r.samples.length
            ? r.samples.map(s => `
              <div style="opacity:.9; padding:4px 6px; border:1px dashed #8883; border-radius:8px; margin:3px 0;">
                <b>${escapeHtml(s.file)}</b>
                <code style="opacity:.8">L${Number(s.line) || '?'}</code>
                <span style="border:1px solid #8886;border-radius:999px;padding:0 6px;font-size:10px;">${escapeHtml(s.access || '')}${s.confidence === 'LOW' ? '?' : ''}</span>
                … ${escapeHtml(s.snippet)}
              </div>`).join('')
            : '';
          return `
            <tr>
              <td style="white-space:nowrap; padding:8px; border-bottom:1px solid ${BD};">${r.used ? '✅' : '—'}</td>
              <td style="white-space:nowrap; padding:8px; border-bottom:1px solid ${BD};"><code>${escapeHtml(r.code)}</code></td>
              <td style="padding:8px; border-bottom:1px solid ${BD};">${escapeHtml(r.label ?? '')}</td>
              <td style="white-space:nowrap; padding:8px; border-bottom:1px solid ${BD};">${escapeHtml(r.type ?? '')}</td>
              <td style="text-align:right; padding:8px; border-bottom:1px solid ${BD};">${r.count}</td>
              <td style="padding:8px; border-bottom:1px solid ${BD};">${accessHtml}</td>
              <td style="padding:8px; border-bottom:1px solid ${BD};">${filesHtml}</td>
            </tr>
            ${samples ? `<tr><td></td><td colspan="6" style="padding:6px 8px; border-bottom:1px solid ${BD};">${samples}</td></tr>` : ''}
          `;
        }).join('');
        $tbody.innerHTML = rows || `<tr><td colspan="7" style="padding:14px; opacity:.8;">結果なし</td></tr>`;
      }

      /**
       * ファイル起点ビュー：JS/CSSファイルごとに「いつ動き・何を触り・どのアプリを見るか」を表示する
       * 既存のフィールド起点テーブル（renderTable）と切り替えて使う。
       * 追加のAPI取得は不要で、スキャン結果（results / appRefs / fileEvents）を並べ替えるだけ。
       */
      function renderFileView(payload) {
        const results = payload?.results || [];
        const files = payload?.files || [];
        const appRefs = payload?.appRefs || [];
        const externalRefs = payload?.externalRefs || [];
        const fileEvents = payload?.fileEvents || {};

        if (!files.length) {
          $fileView.innerHTML = `<div style="padding:14px;opacity:.8">対象ファイルがありません。</div>`;
          return;
        }

        // ファイルキー（target:kind:name）ごとに、フィールド利用を集約する
        const byFile = new Map();
        const keyOf = (target, kind, name) => `${target}:${kind}:${name}`;
        for (const f of files) {
          byFile.set(keyOf(f.target, f.kind, f.name), {
            file: f, fields: new Map(), apps: new Map(),
          });
        }
        for (const r of results) {
          for (const m of (r.matches || [])) {
            const entry = byFile.get(keyOf(m.target, m.kind, m.file));
            if (!entry) continue;
            let fe = entry.fields.get(r.code);
            if (!fe) {
              fe = { code: r.code, label: r.label || r.code, access: {}, lines: [] };
              entry.fields.set(r.code, fe);
            }
            fe.access[m.access] = (fe.access[m.access] || 0) + 1;
            if (fe.lines.length < 10) fe.lines.push(m.line);
          }
        }
        for (const ref of appRefs) {
          const entry = byFile.get(keyOf(ref.target, 'js', ref.file));
          if (!entry) continue;
          const id = ref.appId || 'UNKNOWN';
          let ae = entry.apps.get(id);
          if (!ae) { ae = { appId: id, lines: [], kinds: new Set() }; entry.apps.set(id, ae); }
          if (ae.lines.length < 10) ae.lines.push(ref.line);
          ae.kinds.add(ref.kind);
        }
        // REST APIで触っている外部アプリのフィールド（app ノードの下に並べる）
        for (const r of externalRefs) {
          const entry = byFile.get(keyOf(r.target, 'js', r.file));
          if (!entry) continue;
          let ae = entry.apps.get(r.appId);
          if (!ae) { ae = { appId: r.appId, lines: [], kinds: new Set() }; entry.apps.set(r.appId, ae); }
          if (!ae.fields) ae.fields = new Map();
          const k = `${r.code}|${r.access}`;
          if (!ae.fields.has(k)) ae.fields.set(k, { code: r.code, access: r.access, lines: r.lines || [] });
        }

        // アクセス種別の表示順（読み書きを先に出す）
        const ACCESS_ORDER = ['READ', 'WRITE', 'CONTROL', 'SHOW_HIDE', 'ELEMENT', 'ARGUMENT', 'LIST', 'FIELDS_PARAM', 'QUERY', 'OTHER'];
        const accessText = (obj) => ACCESS_ORDER
          .filter(k => obj[k])
          .map(k => `${k}×${obj[k]}`)
          .join(', ');

        const pill = (text, title = '') =>
          `<span style="display:inline-block;border:1px solid #8886;border-radius:999px;padding:0 6px;font-size:10px;margin:0 4px 4px 0"
                 title="${escapeHtml(title)}">${escapeHtml(text)}</span>`;

        const linesText = (lines) => (lines && lines.length)
          ? `${lines.slice(0, 5).map(n => `${n}行目`).join(', ')}${lines.length > 5 ? ' ほか' : ''}`
          : '';

        const blocks = [];
        for (const entry of byFile.values()) {
          const f = entry.file;
          const key = keyOf(f.target, f.kind, f.name);
          const events = fileEvents[key] || [];
          const fieldList = [...entry.fields.values()]
            .sort((a, b) => String(a.label).localeCompare(String(b.label), 'ja'));
          const appList = [...entry.apps.values()];

          // 解析できていないファイル（外部URL等）は理由を明示する
          const notAnalyzed = !f.text && f.note;

          const row = (label, html) => `
            <div style="display:flex;gap:8px;padding:3px 0;font-size:12px;align-items:flex-start">
              <div style="width:110px;flex:none;opacity:.7">${escapeHtml(label)}</div>
              <div style="flex:1;min-width:0">${html}</div>
            </div>`;

          const fieldsHtml = fieldList.length
            ? fieldList.map(fe => `
                <div style="padding:2px 0">
                  <code>${escapeHtml(fe.code)}</code>
                  ${fe.label !== fe.code ? `<span style="opacity:.75">（${escapeHtml(fe.label)}）</span>` : ''}
                  <span style="opacity:.8;font-size:11px">${escapeHtml(accessText(fe.access))}</span>
                  <span style="opacity:.6;font-size:11px">${escapeHtml(linesText(fe.lines))}</span>
                </div>`).join('')
            : '<span style="opacity:.7">検出なし</span>';

          const appsHtml = appList.length
            ? appList.map(a => {
              const isUnknown = a.appId === 'UNKNOWN';
              const label = isUnknown
                ? '不明（変数指定）'
                : (deps?.meta?.appNames?.[a.appId] ? `app ${a.appId} ${deps.meta.appNames[a.appId]}` : `app ${a.appId}`);
              const link = isUnknown
                ? escapeHtml(label)
                : `<a href="${escapeHtml(KTApi.appUrl(a.appId))}" target="_blank" rel="noopener noreferrer" style="color:inherit">${escapeHtml(label)} 🔗</a>`;
              const ext = a.fields ? [...a.fields.values()] : [];
              const extHtml = ext.length
                ? `<div style="padding:0 0 2px 14px;font-size:11px;opacity:.85">${ext.map(x =>
                  `<code>${escapeHtml(x.code)}</code><span style="opacity:.7">（${x.access === 'WRITE' ? '更新' : '取得'}）</span>`).join('　')}</div>`
                : '';
              return `<div style="padding:2px 0">${link}
                        <span style="opacity:.6;font-size:11px">${escapeHtml(linesText(a.lines))}</span></div>${extHtml}`;
            }).join('')
            : '<span style="opacity:.7">検出なし</span>';

          blocks.push(`
            <div style="border:1px solid ${BD}; border-radius:10px; padding:10px; margin-bottom:8px">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
                <span style="font-weight:600">${escapeHtml(f.name)}</span>
                ${pill(f.target)}${pill(String(f.kind).toUpperCase())}
                ${notAnalyzed ? pill('解析対象外', f.note || '') : ''}
              </div>
              ${notAnalyzed
              ? `<div style="font-size:12px;opacity:.8">${escapeHtml(f.note)}（本文を取得できないため、参照内容は解析していません）</div>`
              : [
                f.kind === 'js' ? row('イベント', events.length
                  ? events.map(e => {
                    // 旧形式（文字列）との後方互換：文字列なら直接検出扱い
                    const name = (typeof e === 'string') ? e : e.name;
                    const isDirect = (typeof e === 'string') ? true : !!e.direct;
                    return isDirect
                      ? pill(name, 'kintone.events.on に直接記述されています')
                      : pill(`${name} ?`, '変数経由などで登録されている可能性があります（ファイル内に記述はありますが、登録に使われているかは確認が必要です）');
                  }).join('')
                  : '<span style="opacity:.7">kintone.events.on の記述を検出できませんでした</span>') : '',
                row('参照フィールド', fieldsHtml),
                f.kind === 'js' ? row('参照アプリ', appsHtml) : '',
              ].filter(Boolean).join('')}
            </div>`);
        }

        $fileView.innerHTML = blocks.join('') || `<div style="padding:14px;opacity:.8">結果なし</div>`;
      }


      // ---- Scan 実行（初期実行なし）----

      /**
       * 依存関係データへの合流とUI更新（キャッシュ経路・実スキャン経路で共通）
       */
      function applyScanResult(payload, { fromCache, elapsedSec, silent }) {
        FS_last = payload;
        KTScan.setLastPayload(payload);

        let merged = false;
        if (deps) {
          try {
            KTDeps.mergeScannerEdges(deps, FS_last);
            if (typeof onDepsUpdated === 'function') onDepsUpdated();
            merged = true;
          } catch (e) {
            console.error('[KTDeps] Scanner結果の統合に失敗しました', e);
          }
        }

        const results = payload.results || [];
        const usedCount = results.filter(r => r.used).length;
        const appRefCount = new Set((payload.appRefs || []).map(r => r.appId || 'UNKNOWN')).size;
        const unknownCount = (payload.unknownRefs || []).length;
        const externalCount = (payload.externalRefs || []).length;
        const src = fromCache
          ? `キャッシュ（${new Date(payload.meta?.scannedAt || Date.now()).toLocaleString()}）`
          : `${elapsedSec}s`;
        $meta.textContent = `files: ${(payload.files || []).length}`
          + ` / fields: ${(payload.fields || []).length} / used: ${usedCount}`
          + ` / appRefs: ${appRefCount} / 未知コード: ${unknownCount}`
          + (externalCount ? ` / 外部フィールド: ${externalCount}` : '') + ` / ${src}`
          + (merged ? ' ｜ 依存データへ反映済み' : '');

        // サイレント実行でも表示を更新しておく（タブを開いたときに結果が見える状態にする）
        renderTable(results);
        renderFileView(payload);
        applyViewMode();
        return merged;
      }

      /**
       * JavaScript/CSSの解析を実行する
       * @param {boolean} opt.force キャッシュを無視して再取得する（手動Scanボタン）
       * @param {boolean} opt.silent 進捗表示を控えめにする（自動実行時）
       * @returns {{fromCache:boolean, scannedAt:string}}
       */
      async function scanOnce(opt = {}) {
        const { force = false, silent = false } = opt;
        const t0 = Date.now();
        const appId = kintone.app.getId();
        const include = resolveInclude($target.value);
        const kinds = resolveKinds($kinds.value);

        // --- キャッシュ確認（API呼び出しを増やさないための要）---
        // 署名は prefetch 済みの customize 設定から作るため、追加のAPI取得は発生しない
        // 解析ロジックのバージョンを含めることで、Toolkit更新時にキャッシュが自動的に無効になる
        const signature = `v${KTScan.ANALYZER_VERSION}|`
          + KTScan.buildSignature(DATA.customize)
          + `|${$target.value}|${$kinds.value}`;
        if (!force) {
          const cached = KTScan.loadCache(appId, signature);
          if (cached?.payload) {
            applyScanResult(cached.payload, { fromCache: true, silent });
            return { fromCache: true, scannedAt: cached.scannedAt };
          }
        }

        if (!silent) $meta.textContent = 'Scanning...';

        const fields = await fetchFieldList(DATA.fields, DATA.layout);
        const files = await fetchTexts({ appId, include, kinds });
        const results = analyze({ fields, files, snippet: { before: 24, after: 48 } });

        // JS本文からアプリID参照とイベント種別を抽出（自アプリIDは除外）
        // コメント除去済みテキストを使い、行番号は原文と一致させる
        const appRefs = [];
        const fileEvents = {};
        for (const f of files) {
          if (f.kind !== 'js' || !f.text) continue;
          const clean = stripCommentsOnly(f.text);
          const li = buildLineIndex(clean);
          for (const ref of KTDeps.extractAppIdRefs(clean, (i) => lineAt(li, i))) {
            if (ref.appId && String(ref.appId) === String(appId)) continue;
            appRefs.push({ ...ref, file: f.name, target: f.target });
          }
          const evs = extractEventTypes(clean);
          if (evs.length) fileEvents[`${f.target}:js:${f.name}`] = evs;
        }

        // ★存在しないフィールドコードの検出（JSに残った古い参照を洗い出す）
        // 依存関係データが持つフィールドコードも既知として渡す
        const depsKnown = (deps?.nodes || [])
          .filter(n => n.type === 'FIELD')
          .map(n => String(n.id).replace(/^FIELD:/, ''));
        const unknownRefs = collectUnknownFieldRefs(files, fields, depsKnown, appId);
        // REST APIパラメータで別アプリが明示されたフィールド参照（{ app: 1112, fields / record }）
        const externalRefs = collectExternalFieldRefs(files, appId);
        // 存在しないステータス名との比較も検出する（プロセス管理が有効な場合のみ）
        const unknownStatuses = collectUnknownStatusRefs(
          files, deps?.meta?.statusStates, deps?.meta?.statusFieldCodes);

        const scannedAt = new Date().toISOString();
        const payload = {
          results, files, fields, appRefs, fileEvents, unknownRefs, unknownStatuses, externalRefs,
          meta: { appId, include, kinds, scannedAt },
        };

        const elapsedSec = ((Date.now() - t0) / 1000).toFixed(2);
        applyScanResult(payload, { fromCache: false, elapsedSec, silent });

        // --- キャッシュ保存 ---
        // ファイル本文（files[].text）は容量が大きいため保存対象から外す。
        // 依存関係の再構築に必要なのは results / appRefs と、件数表示用のファイル名のみ。
        const slimFiles = files.map(f => ({ name: f.name, target: f.target, kind: f.kind, note: f.note }));
        const slimResults = results.map(r => ({
          code: r.code, label: r.label, type: r.type, used: r.used, count: r.count,
          files: r.files, accessCounts: r.accessCounts, accessSummary: r.accessSummary,
          samples: r.samples, matches: r.matches,
        }));
        KTScan.saveCache(appId, signature, {
          payload: { results: slimResults, files: slimFiles, fields, appRefs, fileEvents, unknownRefs, unknownStatuses, externalRefs, meta: payload.meta },
        });

        return { fromCache: false, scannedAt };
      }

      // ★KTScanへ登録：Fieldsタブや起動時の自動実行から呼び出せるようにする
      KTScan.register(scanOnce);

      // ---- イベント ----
      // 表示ビューの切替（ファイル起点／フィールド起点）
      //   選択はLocalStorageに保存し、次回も同じビューで開けるようにする
      const FS_VIEW_KEY = 'ktScanView.v1';
      function applyViewMode() {
        const mode = $view ? $view.value : 'file';
        if ($fileView) $fileView.style.display = (mode === 'file') ? '' : 'none';
        if ($tableWrap) $tableWrap.style.display = (mode === 'file') ? 'none' : '';
      }
      if ($view) {
        try {
          const saved = localStorage.getItem(FS_VIEW_KEY);
          if (saved === 'file' || saved === 'field') $view.value = saved;
        } catch (e) { }
        $view.addEventListener('change', () => {
          try { localStorage.setItem(FS_VIEW_KEY, $view.value); } catch (e) { }
          applyViewMode();
        }, { passive: true });
        applyViewMode();
      }

      // 自動解析トグル（既定ON）
      const $auto = el.querySelector('#fs-auto');
      if ($auto) {
        $auto.checked = KTScan.isAutoEnabled();
        $auto.addEventListener('change', () => {
          KTScan.setAutoEnabled($auto.checked);
          if ($auto.checked && KTScan.getStatus().state !== 'done') KTScan.run({ silent: true });
        }, { passive: true });
      }

      // 手動Scanは常に最新を取り直す（キャッシュ無視）
      $scan.onclick = async () => {
        $meta.textContent = 'Scanning...';
        const r = await KTScan.run({ force: true });
        if (!r.ok && r.reason === 'error') $meta.textContent = 'Scan failed: ' + (r.error?.message || '');
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

    // ★共通化：実体は KTApi.waitDeploy
    const waitDeploy = (appId) => KTApi.waitDeploy(appId);

    // --- UI ---
    //   ★高さは vh 固定ではなく、親View（.kt-fill-view）→ .kt-split-layout → 各カラム → flex:1 の連鎖で追従させる。
    view.innerHTML = `
      <div id="kt-plugins" class="kt-split-layout" style="overflow:hidden; /* ← 外に溢れさせない */">
        <div class="kt-split-col kt-flex-column" style="flex:1.15; --kt-col-min:320px; gap:10px;">
          <div class="kt-flex-fixed" style="display:flex; align-items:center; justify-content:space-between;">
            <div style="font-weight:700;">App Plugins</div>
            <div class="kt-muted" style="font-size:12px;">app: <b>${app}</b></div>
          </div>

          <div class="kt-flex-fixed" style="display:flex; gap:8px; flex-wrap:wrap;">
            <button id="kt-plg-reload" class="btn" style="height:32px; padding:0 12px;">↻ 再取得</button>
            <button id="kt-plg-deploy" class="btn" style="height:32px; padding:0 12px;" disabled>🚀 deploy</button>
          </div>

          <div id="kt-plg-status" class="kt-flex-fixed" style="border:1px solid ${BD}; border-radius:10px; background:${isDark ? '#0f0f0f' : '#fafafa'}; padding:10px 12px; font-size:12px;">
            読み込み中...
          </div>

          <div class="kt-flex-fill" style="display:flex; gap:10px;">
            <div class="kt-flex-column" style="flex:1;">
              <div class="kt-flex-fixed" style="display:flex; align-items:center; justify-content:space-between; margin:6px 0;">
                <div style="font-weight:600;">本番</div><span class="kt-pill">prod</span>
              </div>
              <div id="kt-plg-prod" class="kt-scroll-area" style="border:1px solid ${BD}; border-radius:10px; background:${BG};"></div>
            </div>
            <div class="kt-flex-column" style="flex:1;">
              <div class="kt-flex-fixed" style="display:flex; align-items:center; justify-content:space-between; margin:6px 0;">
                <div style="font-weight:600;">プレビュー</div><span class="kt-pill">preview</span>
              </div>
              <div id="kt-plg-prev" class="kt-scroll-area" style="border:1px solid ${BD}; border-radius:10px; background:${BG};"></div>
            </div>
          </div>

          <div id="kt-plg-diff" class="kt-flex-fixed" style="border:1px dashed ${BD}; border-radius:10px; padding:10px 12px; font-size:12px; background:${isDark ? '#101010' : '#fff'};">
            差分: -
          </div>
        </div>

        <div class="kt-split-col kt-flex-column" style="flex:1; --kt-col-min:360px; gap:10px;">
          <div class="kt-flex-fixed" style="display:flex; align-items:center; justify-content:space-between;">
            <div style="font-weight:700;">Installed Plugins (Domain)</div>
            <span class="kt-pill">${installed.length}件</span>
          </div>

          <div class="kt-flex-fixed" style="display:flex; gap:8px; align-items:center;">
            <input id="kt-plg-search" placeholder="検索（名前/説明/ID）"
              style="flex:1; min-width:0; height:32px; padding:0 10px; border-radius:8px; border:1px solid ${BD}; background:transparent; color:inherit;" />
            <button id="kt-plg-add" class="btn" style="height:32px; padding:0 12px;" disabled>＋ previewに追加</button>
          </div>

          <div class="kt-muted kt-flex-fixed" style="font-size:12px;">
            ※ previewへ追加後、deployで本番反映されます。
          </div>

          <div id="kt-plg-catalog" class="kt-scroll-area" style="border:1px solid ${BD}; border-radius:10px; background:${BG};"></div>

          <div id="kt-plg-log" class="kt-flex-fixed" style="border:1px solid ${BD}; border-radius:10px; padding:10px 12px; font-size:12px; background:${isDark ? '#0f0f0f' : '#fafafa'};">
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

    // ★追加：正規化フィールドと依存関係データを一度だけ生成（各タブで再利用する）
    //   解析に失敗しても Toolkit 全体は停止させない
    let FIELDS_N = [];
    let DEPS = null;
    try {
      FIELDS_N = KTDeps.normalizeFields(DATA.fields);
      DEPS = KTDeps.buildDependencyData(DATA, FIELDS_N);
    } catch (e) {
      console.error('[KTDeps] 依存関係解析に失敗しました（既存表示にフォールバック）', e);
    }

    // ★他アプリからの参照（Relationsタブの走査結果。24時間キャッシュ）は、初回描画の前に依存関係データへ取り込む。
    //   従来は Relations タブの描画時（Fields の描画後）に取り込んでいたため、Fields の変更影響は
    //   JS自動解析による再描画が起きるまで走査結果を含まなかった。走査そのものは自動実行しない。
    if (DEPS) {
      try {
        const cachedIncoming = KTIncoming.loadCache(String(appId));
        if (cachedIncoming) KTDeps.applyIncomingRefs(DEPS, cachedIncoming);
      } catch (e) {
        console.error('[KTIncoming] 走査結果の取り込みに失敗しました（未走査として続行します）', e);
      }
    }

    // ★依存関係データ（DEPS）は各タブで共有する単一のオブジェクト。
    //   Fields は描画時に利用数・変更影響を算出するため、DEPS が更新されたら再描画で再計算する。
    //   （更新契機：参照先アプリ名の解決／JS解析の完了／他アプリからの参照の走査完了）
    const rerenderFields = () =>
      renderFields(root, { ...pick(DATA, ['appId', 'fields', 'layout']), usageData: DATA, deps: DEPS });
    const rerenderRelations = () =>
      renderRelations(root, relations, appId, DEPS, {
        // 「他アプリからの参照」の走査完了後、Fields の利用数・変更影響・未走査の注意書きを最新にする
        onDepsUpdated: rerenderFields,
      });

    // ★参照先アプリ名の解決
    //   /k/v1/apps.json は複数アプリを1回で取得できるうえ、結果は24時間キャッシュされるため、
    //   API呼び出しは通常1回、再訪時は0回で済む。
    //   JS解析で新しい接続先アプリが判明した場合にも、未解決のIDだけを追加で問い合わせる。
    //   取得できないアプリ（閲覧権限なし）は「名称取得不可」として表示する。
    const resolveAppNames = async ({ rerender = true } = {}) => {
      if (!DEPS) return false;
      try {
        const known = (DEPS.meta && DEPS.meta.appNames) || {};
        const ids = [...new Set(
          DEPS.edges
            .filter(e => e.targetType === 'APP' && e.targetId !== 'UNKNOWN' && String(e.targetId) !== String(appId))
            .map(e => String(e.targetId))
        )].filter(id => !known[id]); // 解決済みのIDは問い合わせない
        if (!ids.length) return false;

        const nameMap = await KTApi.getAppNames(ids);
        if (!nameMap.size) return false;
        KTDeps.applyAppNames(DEPS, nameMap);

        if (rerender) {
          // アプリ名を反映して再描画（Relations＝アプリ間依存、Fields＝変更影響の他アプリ連携）
          rerenderRelations();
          rerenderFields();
        }
        return true;
      } catch (e) {
        console.error('[Toolkit] 参照先アプリ名の解決に失敗しました（ID表示のまま継続します）', e);
        return false;
      }
    };

    // 3) 各 render に “必要分だけ” 注入
    renderHealth(root, {
      ...pick(DATA, [
        'appId', 'fields', 'status', 'views', 'reports', 'customize',
        'generalNotify', 'perRecordNotify', 'reminderNotify',
        'appAcl', 'recordAcl', 'fieldAcl',
        'actions', 'plugins'
      ]),
      // 設定の整合性チェック（存在しないフィールド参照の検出）に使用する
      deps: DEPS,
    });
    rerenderFields();
    renderViews(root, pick(DATA, ['appId', 'views', 'fields']));
    renderGraphs(root, pick(DATA, ['appId', 'reports', 'fields']));
    rerenderRelations();
    renderDepsGraph(root, DEPS, appId, FIELDS_N);
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
    renderTemplates(root, DATA, appId, {
      // AI向けドキュメント（無料機能）: 呼び出し時点の最新の解析結果を渡す（Scanner / 他アプリ走査の結果は後から入る）
      getContextInputs: () => ({
        data: DATA,
        deps: DEPS,
        scan: KTScan.getLastPayload(),
        incoming: (() => { try { return KTIncoming.loadCache(String(appId)); } catch (e) { return null; } })(),
      }),
      runScan: () => KTScan.run({ silent: true }),
    });
    renderScanner(root, {
      ...pick(DATA, ['appId', 'fields', 'layout', 'customize']),
      deps: DEPS,
      // ★Scan実行後、JS由来の依存（フィールド利用・アプリID参照）を Fields / Relations に反映する
      onDepsUpdated: () => {
        rerenderFields();
        rerenderRelations();
        // ★Healthタブの整合性チェックも更新する（JS内の未知コードは解析後に判明するため）
        //   Healthタブ全体を描き直すとステータス分布のレコード取得が再実行されるので、
        //   該当ブロックだけを更新する
        renderBrokenRefs(root, DEPS);
        // JS解析で新たに判明した接続先アプリの名前を解決する（未解決のIDだけ問い合わせる）
        resolveAppNames();
      },
    });
    renderPlugins(root, pick(DATA, ['appId', 'plugins']));

    // 参照先アプリ名の解決（定義は上部）。初期描画をブロックしないよう、描画後に実行する
    resolveAppNames();

    // ★JavaScriptの自動解析：初期描画の完了後、ブラウザが空いたタイミングで実行する。
    //   - Field Scannerタブを開かなくても、使用箇所・変更影響・アプリ間依存にJS情報が入る
    //   - 結果は6時間キャッシュされるため、通常の再訪では追加のAPI取得は発生しない
    //   - 失敗してもToolkit全体は停止しない（KTScan内でcatch済み）
    if (DEPS) KTScan.scheduleAuto();

  });

})();