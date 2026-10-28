/* Config Lens's category -> change -> side-by-side detail workflow.
 * Display only: comparison and provenance belong to the existing adapter. */
'use strict';
const KTReleaseConfigLensView = (() => {
  const Diff = typeof KTReleaseEnvironmentDiff !== 'undefined' ? KTReleaseEnvironmentDiff : require('./release-environment-diff.js').KTReleaseEnvironmentDiff;
  const Environment = typeof KTReleaseEnvironmentView !== 'undefined' ? KTReleaseEnvironmentView : require('./release-environment-view.js').KTReleaseEnvironmentView;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const KINDS = Object.freeze({ added: '追加', changed: '変更', deleted: '削除' });
  const entryKey = entry => entry.id != null && String(entry.id) !== '' ? String(entry.id) : JSON.stringify([String(entry.categoryId || ''), String(entry.code ?? entry.label ?? '')]);
  const countsOf = entries => Object.fromEntries(Object.keys(KINDS).map(kind => [kind, entries.filter(e => e.kind === kind).length]));
  const button = (label, attributes, disabled = false) => '<button type="button" ' + attributes + (disabled ? ' disabled' : '') + '>' + esc(label) + '</button>';
  const list = rows => '<ul>' + rows.map(row => '<li>' + esc(row) + '</li>').join('') + '</ul>';
  const stateLabel = category => {
    if (!['ok', 'partial'].includes(category.status)) return '未確認';
    if (category.status === 'partial') return '一部未確認・変更 ' + category.entries.length + '件';
    return category.entries.length ? '変更 ' + category.entries.length + '件' : '変更なし';
  };
  function detail(entry, labels) {
    const rows = entry.rows?.length ? entry.rows : [{ path: [], before: entry.before, after: entry.after }];
    return '<details class="ktcl-entry" data-cl-entry="' + esc(entryKey(entry)) + '"><summary><span class="ktcl-kind ktcl-kind-' + esc(entry.kind) + '">' + esc(KINDS[entry.kind] || '変更') + '</span><strong>' + esc(entry.label || entry.code) + '</strong>' +
      (entry.code && entry.code !== entry.label ? '<small>' + esc(entry.code) + '</small>' : '') +
      '</summary><div class="ktcl-table-scroll" tabindex="0" role="region" aria-label="' + esc((entry.label || entry.code) + 'の設定比較') + '"><table><thead><tr><th scope="col">設定項目</th><th scope="col">' + esc(labels.before) + '</th><th scope="col">' + esc(labels.after) + '</th></tr></thead><tbody>' +
      rows.map(row => '<tr><th scope="row">' + esc(Diff.pathLabel(row.path) || '設定全体') + '</th><td><pre>' + esc(Diff.formatValue(row.before, row.path)) + '</pre></td><td><pre>' + esc(Diff.formatValue(row.after, row.path)) + '</pre></td></tr>').join('') +
      '</tbody></table></div></details>';
  }
  function editsHtml(edits) {
    const files = edits?.files || [];
    const summary = !edits?.available ? '手元の未登録編集（未確認）' : files.length ? '手元の未登録編集（' + files.length + '件）' : '手元の未登録編集（なし）';
    return '<details class="ktcl-notes"><summary>' + esc(summary) + '</summary><p>保存済みの設定との比較や、設定の保存には含めません。</p>' +
      (!edits?.available ? '<p>この画面では手元の編集状態を取得できていません。</p>' : files.length ? list(files.map(file => file.name + '（' + (file.target === 'mobile' ? 'モバイル' : 'PC') + '・' + ({new:'新規作成・未登録',edited:'手元で編集中・未登録',unknown:'取得時との違いは未確認'}[file.state] || '未確認') + '）')) : '<p>このタブに未登録の編集はありません。</p>') +
      '<p>AIへ説明を依頼する場合も、手元のコード本文は送りません。</p></details>';
  }
  function categoryHtml(category, filter, labels) {
    const visible = category.entries.filter(entry => filter === 'all' || entry.kind === filter);
    const warnings = category.warnings?.length ? '<div class="ktcl-warning">' + list(category.warnings) + '</div>' : '';
    const empty = !['ok', 'partial'].includes(category.status) ? 'この範囲は比較できていません。' :
      category.entries.length ? 'この種類の変更はありません。' :
      category.status === 'partial' ? '比較できた範囲に変更はありません。' : '変更はありません。';
    return '<section class="ktcl-category" data-cl-result-category="' + esc(category.id) + '"><h3>' + esc(category.label) + '<small>' + esc(stateLabel(category)) + '</small></h3>' + warnings +
      (visible.length ? visible.map(entry => detail(entry, labels)).join('') : '<p class="ktcl-empty">' + empty + '</p>') + '</section>';
  }
  function render(options = {}) {
    const {result, reading = false, sending = false, saving = false, importing = false, error = '', exportStatus = ''} = options;
    const busy = !!(options.busy || reading || sending || saving || importing);
    const categories = result?.categories || [], entries = result?.entries || [], source = result?.source || {};
    const fileMode = !!options.savedFile || source.comparisonType === 'saved-settings';
    const targetEnvironment = options.targetEnvironment === 'production' ? 'production' : 'preview';
    const environmentLabel = value => ({ production: '運用環境', preview: '動作テスト環境' }[value] || '環境不明');
    const labels = fileMode ? {
      before: source.beforeLabel || '保存ファイル（' + environmentLabel(options.savedFile?.source?.environment) + '）',
      after: source.afterLabel || '現在のアプリ（' + environmentLabel(targetEnvironment) + '）'
    } : { before: '運用環境', after: '動作テスト環境' };
    const origin = (title, value) => '<div><strong>' + esc(title) + '</strong><span>' +
      esc(value?.domain || '取得元不明') + ' / アプリ ' + esc(value?.appId || '未確認') + ' / ' + esc(environmentLabel(value?.environment)) +
      '</span><span>設定の版 ' + esc(value?.revision ?? '未確認') + ' / 取得：' + esc(value?.capturedAt || '未確認') + '</span></div>';
    const selectedCategory = categories.some(c => c.id === options.selectedCategory) ? options.selectedCategory : 'all';
    const filter = Object.hasOwn(KINDS, options.filter) ? options.filter : 'all';
    const selected = selectedCategory === 'all' ? categories : categories.filter(c => c.id === selectedCategory);
    const categoryEntries = selected.flatMap(c => c.entries), counts = countsOf(categoryEntries);
    const groups = selectedCategory === 'all' ? selected.filter(category => category.status !== 'ok' || category.entries.some(entry => filter === 'all' || entry.kind === filter)) : selected;
    const canExplain = !fileMode && !!result && Environment.canExplain(result) && options.canExplain !== false && !busy;
    const date = source.loadedAt ? String(source.loadedAt) : '未取得';
    const totalLabel = !result ? '設定を読み込むと差分を表示します。' : !Environment.canExplain(result) ? '設定を比較できていません。' :
      entries.length ? '確認できた変更 ' + entries.length + '件' : '比較できた範囲に変更はありません。';
    const overview = categories.filter(c => c.entries.length).length;
    return '<section class="ktcl-view" data-config-lens-view aria-label="Config Lens">' + styles() +
      '<header class="ktcl-header"><div class="ktcl-title"><h2>Config Lens</h2></div><div class="ktcl-actions" role="group" aria-label="比較と設定保存">' +
      button(reading ? '設定を読み込んでいます…' : result ? '設定を取り直す' : '設定を読み込む', 'data-cl-action="refresh"', busy) +
      button(sending ? 'AI説明を準備しています…' : 'AIに変更点を説明してもらう', 'data-cl-action="explain"', !canExplain) +
      button('保存ファイルと比較', 'data-cl-action="open-file"', busy) +
      '<input type="file" data-cl-file accept=".json,application/json" aria-label="比較する保存設定ファイル" hidden' + (busy ? ' disabled' : '') + '>' +
      button(fileMode ? '現在の運用環境を保存' : '運用環境を保存', 'data-cl-action="save-production"', busy || !options.canSaveProduction) +
      button(fileMode ? '現在の動作テスト環境を保存' : '動作テスト環境を保存', 'data-cl-action="save-preview"', busy || !options.canSavePreview) + '</div></header>' +
      (fileMode ? '<div class="ktcl-file-bar" data-cl-file-comparison><span class="ktcl-filename" title="' + esc(options.savedFile?.filename || '保存設定ファイル') + '">' + esc(options.savedFile?.filename || '保存設定ファイル') + '</span>' +
        '<span aria-hidden="true">→</span><label>比較先 <select data-cl-environment' + (busy ? ' disabled' : '') + '><option value="preview"' + (targetEnvironment === 'preview' ? ' selected' : '') + '>現在の動作テスト環境</option><option value="production"' + (targetEnvironment === 'production' ? ' selected' : '') + '>現在の運用環境</option></select></label>' +
        button('環境どうしを比較', 'data-cl-action="environment-mode"', busy) + '</div>' : '') +
      (exportStatus ? '<p class="ktcl-status" role="status" data-cl-export-status>' + esc(exportStatus) + '</p>' : '') +
      (error ? '<p class="ktcl-warning" role="alert" data-cl-error>' + esc(typeof error === 'string' ? error : error.message || '設定を取得できませんでした。') + '</p>' : '') +
      '<div class="ktcl-overview ktcl-meta"><strong role="status" data-cl-summary>' + esc(reading ? '設定を読み込んでいます…' : sending ? 'AI説明を準備しています…' : saving ? '設定を保存しています…' : importing ? '保存ファイルを読み込んでいます…' : totalLabel) + '</strong>' +
      (result ? '<span>' + overview + '分類に変更' + (result.unavailable?.length ? ' ／ ' + result.unavailable.length + '分類に未確認の範囲' : '') + '</span>' +
        (fileMode ? '<span class="ktcl-source">' + esc(labels.before) + ' → ' + esc(labels.after) + '</span>' :
        '<span class="ktcl-source">アプリ ' + esc(source.appId) + '</span><span class="ktcl-source">運用環境の版 ' + esc(source.productionRevision ?? '未確認') + ' → 動作テスト環境の版 ' + esc(source.previewRevision ?? '未確認') + '</span><span class="ktcl-source">取得：' + esc(date) + '</span>') : '') + '</div>' +
      (fileMode ? '<details class="ktcl-provenance"><summary>比較元・比較先を確認</summary>' + origin(labels.before, source.before || options.savedFile?.source) + origin(labels.after, source.after) +
        '<p>保存ファイルの比較はこの画面で確認できます。AI説明は環境どうしの比較が対象です。</p></details>' : '') +
      (fileMode && source.crossApp ? '<p class="ktcl-comparison-note" data-cl-cross-app>別アプリとの設定比較です。変更履歴ではありません。一覧・グラフ・アプリアクションは同じ名前で照合します。</p>' : '') +
      (categories.length ? '<div class="ktcl-shell"><nav class="ktcl-navigation" aria-label="比較する設定">' +
        button('すべての設定', 'data-cl-category="all" aria-pressed="' + (selectedCategory === 'all') + '"', busy) +
        categories.map(category => '<button type="button" data-cl-category="' + esc(category.id) + '" aria-pressed="' + (selectedCategory === category.id) + '"' + (busy ? ' disabled' : '') + '><span>' + esc(category.label) + '</span><small' + (category.status !== 'ok' ? ' class="ktcl-attention"' : '') + '>' + esc(stateLabel(category)) + '</small></button>').join('') +
      '</nav><div class="ktcl-results"><div class="ktcl-filters" role="group" aria-label="変更の種類">' +
        button('すべて ' + categoryEntries.length, 'data-cl-kind="all" aria-pressed="' + (filter === 'all') + '"', busy) +
        Object.entries(KINDS).map(([kind,label]) => button(label + ' ' + counts[kind], 'data-cl-kind="' + kind + '" aria-pressed="' + (filter === kind) + '"', busy)).join('') +
      '</div>' + (groups.length ? groups.map(category => categoryHtml(category, filter, labels)).join('') : '<p class="ktcl-empty">この種類の変更はありません。</p>') + '</div></div>' :
      '<div class="ktcl-empty-page"><p>保存済みの設定を読み込み、変更した項目を左右に並べて確認できます。</p><p>一覧を見る操作ではAIを呼びません。</p></div>') +
      '<footer class="ktcl-footer">' + editsHtml(options.localEdits) +
      '<details class="ktcl-notes"><summary>比較と保存の範囲</summary><p>' + (fileMode ? '保存ファイルを左側、現在のアプリの取得済み設定を右側に表示します。追加・変更・削除は左から右への違いです。' : '運用環境と動作テスト環境の設定を比較します。設定画面で保存した内容が対象で、この会話以外で変更した内容も含みます。') + '</p><p>現在のアプリの取得済み設定をファイルで保存します。設定の変更や復元は行いません。</p>' +
      list(result?.limitations || ['未取得の設定や、手元で編集してまだ登録していないコードは比較しません。']) +
      '<p>設定の保存範囲は、保存したファイルにも記載します。アプリ全体のバックアップではありません。</p></details></footer></section>';
  }
  function styles() {
    return '<style>' +
      '.ktcl-view{color:var(--kt-text,#253247);background:var(--kt-paper,#fff);font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere;min-width:0;padding:12px 20px 20px;box-sizing:border-box}' +
      '.ktcl-view *{box-sizing:border-box}.ktcl-view h2,.ktcl-view h3,.ktcl-view p{margin:0}.ktcl-view button{font:inherit;line-height:1.4;color:inherit;background:var(--kt-paper,#fff);border:1px solid var(--kt-line,#dbe2ec);border-radius:7px;padding:8px 12px;cursor:pointer;min-height:36px}.ktcl-view button:hover{background:var(--kt-soft,#f5f7fb)}.ktcl-view button:disabled{opacity:.55;cursor:default}.ktcl-view button:focus-visible,.ktcl-view summary:focus-visible{outline:2px solid var(--kt-accent,#285fbd);outline-offset:2px}.ktcl-view button[aria-pressed="true"]{border-color:var(--kt-accent,#285fbd);color:var(--kt-accent,#285fbd);background:var(--kt-soft,#f5f7fb);font-weight:600}' +
      '.ktcl-header{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap}.ktcl-title{min-width:0}.ktcl-header h2{font-size:20px;line-height:1.4}.ktcl-source,.ktcl-empty,.ktcl-empty-page,.ktcl-notes p{color:var(--kt-muted,#58677d)}.ktcl-actions,.ktcl-filters{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}.ktcl-actions button{font-size:12px;min-height:32px;padding:6px 10px;max-width:100%}.ktcl-meta{display:flex;gap:3px 16px;align-items:baseline;flex-wrap:wrap;margin:8px 0 12px;min-width:0;font-size:12px}.ktcl-meta strong{font-size:14px}.ktcl-meta>*{min-width:0;max-width:100%}.ktcl-status{margin:8px 0!important}.ktcl-warning{padding:10px 12px;margin:10px 0;color:var(--kt-warning,#805c15);background:var(--kt-soft,#f5f7fb);border-left:3px solid currentColor}.ktcl-warning ul{margin:0;padding-left:18px}' +
      '.ktcl-file-bar{display:flex;align-items:center;gap:6px 12px;flex-wrap:wrap;margin:8px 0;font-size:12px;min-width:0}.ktcl-file-bar>*{min-width:0;max-width:100%}.ktcl-filename{max-width:min(40vw,420px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ktcl-file-bar label{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.ktcl-file-bar select{max-width:100%;font:inherit;color:inherit;background:var(--kt-paper,#fff);border:1px solid var(--kt-line,#dbe2ec);border-radius:7px;padding:6px;min-height:32px}.ktcl-file-bar button{font-size:12px;min-height:32px;padding:6px 10px}.ktcl-provenance{font-size:12px;margin:8px 0 12px;color:var(--kt-muted,#58677d)}.ktcl-provenance summary{cursor:pointer}.ktcl-provenance>div{display:flex;flex-wrap:wrap;gap:3px 12px;margin:6px 0}.ktcl-provenance strong{color:var(--kt-text,#253247)}.ktcl-comparison-note{font-size:12px;color:var(--kt-muted,#58677d);margin:8px 0!important}.ktcl-view select:focus-visible{outline:2px solid var(--kt-accent,#285fbd);outline-offset:2px}' +
      '.ktcl-shell{display:grid;grid-template-columns:210px minmax(0,1fr);gap:24px}.ktcl-navigation{display:flex;flex-direction:column;gap:5px;align-self:start;max-height:min(55vh,640px);overflow:auto;scrollbar-gutter:stable;padding-right:4px}.ktcl-navigation button{flex-shrink:0}.ktcl-navigation button{text-align:left;display:flex;flex-direction:column;align-items:flex-start;padding:9px 12px}.ktcl-navigation small{font-size:11px;color:var(--kt-muted,#58677d);font-weight:400}.ktcl-navigation .ktcl-attention{color:var(--kt-warning,#805c15)}.ktcl-results{min-width:0}.ktcl-filters{padding-bottom:12px;border-bottom:1px solid var(--kt-line,#dbe2ec)}.ktcl-filters button{font-size:12px;padding:5px 10px;min-height:30px}.ktcl-category{margin:18px 0 24px}.ktcl-category h3{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;font-size:16px}.ktcl-category h3 small{font-size:12px;font-weight:400;color:var(--kt-muted,#58677d)}.ktcl-empty{margin:10px 0!important}' +
      '.ktcl-entry{margin-top:8px;border:1px solid var(--kt-line,#dbe2ec);border-radius:7px;overflow:hidden}.ktcl-entry summary{padding:11px 12px;cursor:pointer;overflow-wrap:anywhere;background:var(--kt-soft,#f5f7fb)}.ktcl-entry summary strong{font-weight:600}.ktcl-entry summary small{font-size:12px;margin-left:8px;color:var(--kt-muted,#58677d)}.ktcl-kind{display:inline-block;padding:1px 7px;border:1px solid currentColor;border-radius:4px;font-size:11px;margin-right:10px;line-height:1.5}.ktcl-kind-added{color:var(--kt-success,#24634f)}.ktcl-kind-changed{color:var(--kt-warning,#805c15)}.ktcl-kind-deleted{color:var(--kt-danger,#9d3d22)}.ktcl-table-scroll{max-width:100%;overflow:auto}.ktcl-view table{width:100%;table-layout:fixed;border-collapse:collapse}.ktcl-view th,.ktcl-view td{padding:10px;text-align:left;vertical-align:top;border-bottom:1px solid var(--kt-line,#dbe2ec);overflow-wrap:anywhere}.ktcl-view thead th{background:var(--kt-soft,#f5f7fb);font-size:12px}.ktcl-view th:first-child{width:24%}.ktcl-view tbody th{font-weight:500;font-size:12px}.ktcl-view pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:0;max-height:320px;overflow:auto}.ktcl-empty-page{padding:32px 0}.ktcl-empty-page p+p{margin-top:8px}' +
      '.ktcl-footer{border-top:1px solid var(--kt-line,#dbe2ec);margin-top:20px;padding-top:8px}.ktcl-notes{margin:10px 0}.ktcl-notes summary{cursor:pointer;font-weight:600}.ktcl-notes p{margin:6px 0}.ktcl-notes ul{margin:6px 0;padding-left:20px}.ktcl-notes li{margin:4px 0}' +
      '@media(max-width:760px){.ktcl-view{padding:12px}.ktcl-shell{grid-template-columns:minmax(0,1fr);gap:14px}.ktcl-navigation{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;max-height:180px;overflow:auto}.ktcl-navigation button{min-width:0}.ktcl-actions{width:100%;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.ktcl-actions button{min-width:0;width:100%}.ktcl-meta{gap:3px 12px;margin:8px 0 12px}.ktcl-view th,.ktcl-view td{padding:7px}.ktcl-view th:first-child{width:26%}}' +
      '</style>';
  }
  return { render, styles };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseConfigLensView };
