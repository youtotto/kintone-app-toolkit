/* Read-only code comparison from the existing approval preparation. */
'use strict';
const KTReleaseCustomize = (() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const keyOf = file => JSON.stringify([file.target, file.name, file.changeId]);
  // Reuse a scan only when its app, environment and registered source can be identified.
  // Draft text is deliberately excluded: this function does not analyze edited code.
  function referenceInfoOf({ appId, document, scan, stale = false } = {}) {
    const result = { status: 'unavailable', reason: '未取得', source: document?.environment || null,
      scannedAt: scan?.meta?.scannedAt || null, basis: 'registered', fields: [], events: [], unknownRefs: [] };
    const unavailable = (reason, status = 'unavailable') => ({ ...result, status, reason });
    if (!document || document.isNew || !document.fileKey) return unavailable('登録済みのファイルを選んでください。');
    if (document.kind !== 'js') return unavailable('参照情報はJavaScriptで表示します。', 'unsupported');
    if (stale) return unavailable('設定が変わったため、解析結果を確認できていません。', 'stale');
    if (!['preview', 'production'].includes(document.environment) || !['desktop', 'mobile'].includes(document.target)
      || appId == null || scan?.meta?.appId == null || String(scan.meta.appId) !== String(appId)
      || scan.meta.source !== document.environment) return unavailable('同じアプリ・環境の解析結果を確認できていません。');
    if (!Array.isArray(scan.files) || !Array.isArray(scan.results) || !scan.fileEvents || typeof scan.fileEvents !== 'object' || Array.isArray(scan.fileEvents)) {
      return unavailable('このファイルの解析結果をまだ取得していません。');
    }
    const files = scan.files.filter(file => file?.name === document.name && file.target === document.target && file.kind === document.kind);
    if (files.length !== 1) return unavailable(files.length ? '同名のファイルがあるため、解析結果を特定できません。' : 'このファイルの解析結果をまだ取得していません。');
    const file = files[0];
    if (file.note || file.analyzed === false || file.type === 'URL' || file.url) return unavailable('このファイルの解析は確認できていません。');
    const sameKey = file.fileKey != null && file.fileKey !== '' && String(file.fileKey) === String(document.fileKey);
    const sameBody = typeof document.registeredText === 'string' && typeof file.text === 'string' && document.registeredText === file.text;
    if (!sameKey && !sameBody) return unavailable('登録済みのコードと一致する解析結果を確認できていません。');
    const eventKey = `${document.target}:js:${document.name}`;
    const eventRows = Object.prototype.hasOwnProperty.call(scan.fileEvents, eventKey) ? scan.fileEvents[eventKey] : [];
    if (!Array.isArray(eventRows)) return unavailable('このファイルの解析結果を確認できていません。');
    const fields = new Map(), events = new Map();
    for (const row of scan.results) {
      if (typeof row?.code !== 'string' || !Array.isArray(row.matches)) continue;
      const matches = row.matches.filter(match => match?.file === document.name && match.target === document.target && match.kind === document.kind);
      if (!matches.length) continue;
      let field = fields.get(row.code);
      if (!field) {
        field = { code: row.code, label: row.label || row.code, type: row.type || null, access: new Set(), lines: new Set(), confidence: new Set() };
        fields.set(row.code, field);
      }
      for (const match of matches) {
        if (typeof match.access === 'string') field.access.add(match.access);
        if (Number.isInteger(match.line) && match.line > 0) field.lines.add(match.line);
        if (typeof match.confidence === 'string') field.confidence.add(match.confidence);
      }
    }
    for (const event of eventRows) {
      const name = typeof event === 'string' ? event : event?.name;
      if (typeof name !== 'string' || !name) continue;
      events.set(name, { name, direct: events.get(name)?.direct === true || event?.direct === true });
    }
    const unknownRefs = (Array.isArray(scan.unknownRefs) ? scan.unknownRefs : []).flatMap(ref => {
      if (typeof ref?.code !== 'string' || !Array.isArray(ref.files)) return [];
      const matched = ref.files.filter(item => item?.name === `${document.target}:${document.name}`);
      if (!matched.length) return [];
      return [{ code: ref.code, confidence: ref.confidence || null,
        lines: [...new Set(matched.flatMap(item => Array.isArray(item.lines) ? item.lines : []).filter(line => Number.isInteger(line) && line > 0))].sort((a, b) => a - b) }];
    });
    return { ...result, status: 'ready', reason: null,
      fields: [...fields.values()].map(field => ({ ...field, access: [...field.access].sort(), lines: [...field.lines].sort((a, b) => a - b), confidence: [...field.confidence].sort() })),
      events: [...events.values()], unknownRefs };
  }

  const cloneDependency = value => value == null ? value : JSON.parse(JSON.stringify(value));
  function dependencyFieldsOf(properties, parent = null) {
    return Object.values(properties || {}).flatMap(field => !field || typeof field.code !== 'string' ? [] : [
      { code: field.code, label: field.label || field.code, type: field.type || null, parent,
        ...(typeof field.expression === 'string' ? { expression: field.expression } : {}) },
      ...(field.type === 'SUBTABLE' ? dependencyFieldsOf(field.fields, field.code) : [])
    ]);
  }
  // This explicit-refresh adapter only calls the existing Deps/Scanner analysis.
  // No result from another environment, global cache, or edited buffer is supplied.
  function createDependencySnapshot(base, analyze) {
    const snapshot = {
      status: 'unavailable', reason: '同じアプリ・環境の依存関係をまだ取得していません。',
      appId: base?.appId == null ? null : String(base.appId), environment: base?.env || null,
      loadedAt: base?.loadedAt || null, revision: base?.revision?.preview ?? null,
      basis: 'registered', fields: [], files: [], deps: null, scan: null,
      missingSettings: cloneDependency((base?.errors || []).filter(item => item.env === base?.env)),
      unavailableFiles: [], limitations: [
        '編集中のコードは解析していません。取得した登録済みのコードを表示しています。',
        '変数で組み立てる参照、プラグインの内部処理、他アプリからの参照と実際の動作は未確認です。',
        '参照が見つからなくても、依存関係がないとは限りません。'
      ]
    };
    if (!base?.ok || base.env !== 'preview' || !snapshot.appId || !base.loadedAt
      || !base.data || String(base.data.appId ?? base.appId) !== snapshot.appId || typeof analyze !== 'function') return snapshot;
    const current = { ok: true, env: base.env, appId: base.appId, loadedAt: base.loadedAt,
      data: { ...cloneDependency(base.data), relatedApps: {}, plugins: null },
      files: cloneDependency(base.files || []), incoming: null, deps: null, scan: null };
    // Source scope is explicit for loaded files. An unidentified source is not
    // borrowed from a different environment, even if its filename matches.
    current.files = current.files.map(file => file.env !== base.env
      ? { name: file.name, target: file.target, kind: file.kind, type: file.type, env: file.env,
        sourceAvailable: false, note: '同じ環境の本文か確認できません。' } : file);
    snapshot.files = cloneDependency(current.files);
    snapshot.fields = dependencyFieldsOf(current.data.fields?.properties || current.data.fields);
    snapshot.unavailableFiles = current.files.filter(file => file.type !== 'FILE' || file.sourceAvailable === false || typeof file.text !== 'string')
      .map(file => ({ name: file.name, target: file.target, reason: file.type === 'URL' ? 'URL指定の本文は未確認です。' : file.note || '本文を取得できていません。' }));
    if (snapshot.missingSettings.length) snapshot.limitations.push('取得できなかった設定があります。確認できた範囲だけを表示します。');
    if (snapshot.unavailableFiles.length) snapshot.limitations.push('本文を確認できていないファイルがあります。');
    try {
      analyze(current);
      if (current.analysisError || !Array.isArray(current.deps?.edges) || !Array.isArray(current.scan?.results)
        || !Array.isArray(current.scan?.files) || String(current.deps?.meta?.appId) !== snapshot.appId
        || String(current.scan?.meta?.appId) !== snapshot.appId || current.scan.meta.source !== base.env
        || current.scan.meta.scannedAt !== base.loadedAt) throw new Error('DEPENDENCIES_UNAVAILABLE');
      snapshot.deps = cloneDependency(current.deps); snapshot.scan = cloneDependency(current.scan);
      snapshot.status = 'ready'; snapshot.reason = null;
    } catch (_) {
      snapshot.reason = '依存関係の解析結果を取得できませんでした。';
    }
    return snapshot;
  }
  function dependencyInfoOf({ appId, document, environment = document?.environment, fieldCode, snapshot, stale = false } = {}) {
    const result = { status: 'unavailable', reason: '［依存関係を更新］で登録済みのコードと設定を確認してください。',
      appId: appId == null ? null : String(appId), environment: environment || null,
      loadedAt: snapshot?.loadedAt || null, revision: snapshot?.revision ?? null, basis: 'registered',
      field: null, fields: [], jsReferences: [], formulaReferences: [], unavailableFiles: [],
      missingSettings: [], documentNotice: null, limitations: cloneDependency(snapshot?.limitations || []) };
    if (stale) return { ...result, status: 'stale', reason: '設定が変わったため、依存関係を更新してください。' };
    if (snapshot?.status !== 'ready') return { ...result, reason: snapshot?.reason || result.reason };
    if (!['preview', 'production'].includes(environment) || appId == null
      || snapshot.appId !== String(appId) || snapshot.environment !== environment
      || snapshot.scan?.meta?.source !== environment || String(snapshot.scan?.meta?.appId) !== String(appId)
      || snapshot.scan?.meta?.scannedAt !== snapshot.loadedAt || String(snapshot.deps?.meta?.appId) !== String(appId)) {
      return { ...result, reason: '同じアプリ・環境の依存関係を確認できていません。' };
    }
    // The editor supplies only the field-code selection. Retain its draft while
    // showing independently verified, newly fetched registered-source references.
    if (document && !document.isNew && document.kind === 'js') {
      const identity = referenceInfoOf({ appId, document, scan: snapshot.scan });
      if (identity.status !== 'ready') result.documentNotice = '開いているコードと今回取得した登録済みコードの一致は確認できていません。以下は今回取得した登録済みコードから調べた参照です。';
    }
    result.fields = cloneDependency(snapshot.fields);
    result.missingSettings = cloneDependency(snapshot.missingSettings);
    result.unavailableFiles = cloneDependency(snapshot.unavailableFiles);
    if (typeof fieldCode !== 'string' || !fieldCode) return { ...result, status: 'select-field', reason: 'コード内のフィールドコードを選択するか、ここでフィールドを選んでください。' };
    const fields = snapshot.fields.filter(field => field.code === fieldCode);
    if (fields.length !== 1) return { ...result, status: 'unresolved', reason: '選択した文字と一致するフィールドコードを確認できません。' };
    result.field = cloneDependency(fields[0]);
    const seenFiles = new Set();
    for (const file of snapshot.files) {
      const id = JSON.stringify([file.target, file.name]);
      if (seenFiles.has(id)) continue;
      seenFiles.add(id);
      if (file.type !== 'FILE' || file.env !== environment || file.sourceAvailable === false || typeof file.text !== 'string') continue;
      const fileInfo = referenceInfoOf({ appId, document: { name: file.name, target: file.target, kind: 'js', environment,
        fileKey: file.fileKey, registeredText: file.text }, scan: snapshot.scan });
      if (fileInfo.status !== 'ready') {
        result.unavailableFiles.push({ name: file.name, target: file.target, reason: fileInfo.reason });
        continue;
      }
      const reference = fileInfo.fields.find(field => field.code === fieldCode);
      if (reference) result.jsReferences.push({ name: file.name, target: file.target,
        current: document?.name === file.name && document.target === file.target && document.kind === 'js',
        access: reference.access, lines: reference.lines, confidence: reference.confidence });
    }
    const formulas = new Map();
    for (const edge of snapshot.deps.edges) {
      if (edge.sourceType !== 'FIELD' || edge.targetType !== 'FIELD' || edge.targetId !== fieldCode
        || edge.relationType !== 'REFERENCES' || edge.context?.settingType !== 'CALC'
        || (edge.context?.appId != null && String(edge.context.appId) !== String(appId))) continue;
      const definitions = snapshot.fields.filter(field => field.code === edge.sourceId
        && ['CALC', 'SINGLE_LINE_TEXT'].includes(field.type) && typeof field.expression === 'string');
      if (definitions.length !== 1) continue;
      const definition = definitions[0], existing = formulas.get(definition.code);
      formulas.set(definition.code, { ...cloneDependency(definition),
        confidence: [...new Set([...(existing?.confidence || []), ...(typeof edge.confidence === 'string' ? [edge.confidence] : [])])] });
    }
    result.formulaReferences = [...formulas.values()];
    return { ...result, status: 'ready', reason: null };
  }
  function renderDependencyInfo(info) {
    if (!info || info.status !== 'ready') return '<p class="kt-muted">' + escape(info?.reason || '依存関係は未取得です。') + '</p>';
    const platform = target => target === 'mobile' ? 'モバイル' : 'PC';
    const accessLabels = { READ: '読み取り', WRITE: '書き換え', CONTROL: '入力の制御', ELEMENT: '画面の操作', SHOW_HIDE: '表示の切替',
      FIELDS_PARAM: '読み取り項目', QUERY: '条件', ARGUMENT: '引数', LIST: '項目の指定', OTHER: '参照' };
    const references = info.jsReferences.map(ref => '<li><strong>' + escape(platform(ref.target) + ' / ' + ref.name) + '</strong>'
      + (ref.current ? '（開いているファイル）' : '') + '<br>'
      + escape(ref.access.map(access => accessLabels[access] || '参照').join('・'))
      + (ref.lines.length ? ' / ' + escape(ref.lines.join('・')) + '行目' : '')
      + '</li>').join('');
    const formulas = info.formulaReferences.map(ref => '<li><strong>' + escape(ref.label) + '</strong> <code>' + escape(ref.code)
      + '</code><pre>' + escape(ref.expression) + '</pre></li>').join('');
    const missing = [...info.unavailableFiles.map(file => platform(file.target) + ' / ' + file.name + ': ' + file.reason),
      ...info.missingSettings.map(item => (item.label || item.what || '設定') + 'を取得できていません。')];
    return '<p><strong>' + escape(info.field.label) + '</strong> <code>' + escape(info.field.code) + '</code></p>'
      + '<p class="kt-muted">取得した登録済みコードと計算式の参照です。編集中のコードは解析していません。</p>'
      + (info.documentNotice ? '<p class="kt-muted">' + escape(info.documentNotice) + '</p>' : '')
      + '<h4>このフィールドを使うJavaScript</h4>' + (references ? '<ul>' + references + '</ul>' : '<p>取得できた範囲では参照が見つかりませんでした。</p>')
      + '<h4>このフィールドを使う計算式</h4>' + (formulas ? '<ul>' + formulas + '</ul>' : '<p>取得できた範囲では参照が見つかりませんでした。</p>')
      + '<p class="kt-muted">参照が見つからなくても、依存関係がないとは限りません。参照元は既存の解析による候補です。</p>'
      + '<details><summary>未確認の範囲</summary><ul>' + [...new Set([...info.limitations, ...missing])].map(text => '<li>' + escape(text) + '</li>').join('') + '</ul></details>';
  }

  function comparisonOf(state, selectedRunId = null) {
    const historical = selectedRunId != null;
    const run = historical || ['result', 'rollback-confirm', 'rolling-back', 'checking-result'].includes(state.phase)
      ? (state.runs || []).find(item => item.id === (historical ? selectedRunId : state.resultRunId)) : null;
    const prepared = historical ? run?.prepared || null : run ? run.prepared : state.prepared;
    return { run, prepared, files: (prepared?.files?.changes || []).filter(file => ['desktop', 'mobile'].includes(file.target) && typeof file.name === 'string') };
  }
  function createComparison(host, { controller, monaco, getSelectedRunId = () => null, subscribeDisplay = null, getEditingFile = () => null } = {}) {
    if (!host || !controller || !monaco?.editor) throw new Error('コードの比較に必要な情報がありません。');
    host.innerHTML = `<section class="ktr-code-comparison" aria-label="AIの修正案と差分"><style>
      .ktr-code-comparison{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:360px;height:100%;color:var(--kt-text,#253247);background:var(--kt-paper,#fff);font:14px/1.6 system-ui,sans-serif}
      .ktr-code-comparison h3,.ktr-code-comparison p{margin:0}.ktr-code-comparison header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.ktr-code-comparison select{min-width:0;max-width:100%;font:inherit;padding:6px;border:1px solid var(--kt-line,#dbe2ec);background:var(--kt-paper,#fff);color:inherit;border-radius:6px}
      .ktr-code-comparison [data-comparison-modes]{display:flex;gap:6px;flex-wrap:wrap}.ktr-code-comparison button{font:inherit;padding:6px 10px;border:1px solid var(--kt-line,#dbe2ec);border-radius:6px;background:var(--kt-paper,#fff);color:inherit;cursor:pointer}.ktr-code-comparison button[aria-pressed="true"]{background:var(--kt-soft,#f5f7fb);border-color:var(--kt-accent,#285fbd)}.ktr-code-comparison button:disabled{opacity:.5;cursor:default}.ktr-code-comparison :is(button,select):focus-visible{outline:3px solid #83b6fb;outline-offset:2px}
      .ktr-code-comparison [data-comparison-note],.ktr-code-comparison [data-comparison-empty]{font-size:12px;color:var(--kt-muted,#58677d)}.ktr-code-comparison [data-comparison-editor]{flex:1;min-height:280px;min-width:0;border:1px solid var(--kt-line,#dbe2ec)}.ktr-code-comparison [hidden]{display:none!important}
      </style><header><h3>AIの修正案と差分</h3><label>対象ファイル <select data-comparison-file aria-label="比較するファイル"></select></label></header>
      <div data-comparison-modes role="group" aria-label="コードの表示"><button type="button" data-comparison-mode="before">現在のコード</button><button type="button" data-comparison-mode="after">修正案</button><button type="button" data-comparison-mode="diff">差分</button></div>
      <p data-comparison-note></p><p data-comparison-empty role="status"></p><div data-comparison-editor></div></section>`;
    const select = host.querySelector('[data-comparison-file]'), note = host.querySelector('[data-comparison-note]'), empty = host.querySelector('[data-comparison-empty]'), surface = host.querySelector('[data-comparison-editor]');
    const buttons = [...host.querySelectorAll('[data-comparison-mode]')];
    let selected = null, mode = 'diff', editor = null, models = [], shown = null, disposed = false;
    function release() {
      editor?.dispose(); editor = null;
      for (const model of models) model.dispose();
      models = []; shown = null;
    }
    function render(state = controller.getState()) {
      if (disposed) return;
      const { run, prepared, files } = comparisonOf(state, getSelectedRunId());
      if (!files.some(file => keyOf(file) === selected)) selected = files.length ? keyOf(files[0]) : null;
      const options = files.map(file => `<option value="${escape(keyOf(file))}">${escape((file.target === 'mobile' ? 'モバイル' : 'PC') + ' / ' + file.name)}</option>`).join('');
      if (select.innerHTML !== options) select.innerHTML = options;
      select.disabled = !files.length; select.value = selected || '';
      const file = files.find(item => keyOf(item) === selected);
      const before = file?.kind === 'ADD_FILE' ? '' : file?.currentSource;
      const after = file?.content;
      const complete = typeof before === 'string' && typeof after === 'string';
      buttons.forEach(button => { button.disabled = !complete; button.setAttribute('aria-pressed', String(button.dataset.comparisonMode === mode)); });
      buttons.find(button => button.dataset.comparisonMode === 'before').textContent = run ? '反映前のコード' : '現在のコード';
      buttons.find(button => button.dataset.comparisonMode === 'after').textContent = run ? '反映に使用した案' : '修正案';
      empty.hidden = complete; surface.hidden = !complete;
      if (!complete) {
        note.textContent = '';
        empty.textContent = file ? '変更前後のコードがそろっていないため、まだ比較できません。反映前の確認結果を確認してください。'
          : ['consulting', 'building', 'preparing', 'incomplete', 'blocked'].includes(state.phase)
            ? '修正案の作成・確認が完了していません。変更前後のコードがそろうと、ここに表示します。'
            : 'AIに相談し、案を作成すると、ここでコードと差分を確認できます。';
        release(); return;
      }
      const stateNote = run ? 'この反映の記録に保存された変更前と修正案です。現在の登録内容を取り直した表示ではありません。'
        : prepared.ok ? '反映前の確認に使用しているコードです。確認後の登録は、相談欄の「動作テスト環境に反映」から行います。'
          : '反映前の確認は完了していません。この比較だけでは反映できません。';
      const editingFile = getEditingFile();
      const differentFile = editingFile && (editingFile.target !== file.target || editingFile.name !== file.name);
      note.textContent = stateNote + (file.kind === 'ADD_FILE' ? ' 新しいファイルのため、変更前は空欄です。' : file.reason === 'JS_UNCHANGED' ? ' 既存のコードと同じため、このファイルは登録しません。' : '')
        + ' 手元の編集中のコードとの差分ではありません。' + (differentFile ? ' 上のエディターとは別のファイルを比較しています。' : '') + ' この表示からコードは編集できません。';
      if (shown?.key === selected && shown.mode === mode && shown.before === before && shown.after === after) { editor?.layout(); return; }
      release();
      const optionsEditor = { readOnly: true, domReadOnly: true, automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, wordWrap: 'on' };
      if (mode === 'diff') {
        models = [monaco.editor.createModel(before, 'javascript'), monaco.editor.createModel(after, 'javascript')];
        editor = monaco.editor.createDiffEditor(surface, { ...optionsEditor, originalEditable: false, renderSideBySide: false, enableSplitViewResizing: false, diffWordWrap: 'on' });
        editor.setModel({ original: models[0], modified: models[1] });
      } else {
        models = [monaco.editor.createModel(mode === 'before' ? before : after, 'javascript')];
        editor = monaco.editor.create(surface, { ...optionsEditor, model: models[0] });
      }
      shown = { key: selected, mode, before, after };
    }
    const change = () => { selected = select.value; render(); };
    const click = event => { const button = event.target?.closest?.('[data-comparison-mode]'); if (!button || !buttons.includes(button) || button.disabled) return; mode = button.dataset.comparisonMode; render(); };
    select.addEventListener('change', change); host.addEventListener('click', click);
    const unsubscribe = controller.subscribe(render), unsubscribeDisplay = subscribeDisplay?.(() => render()); render();
    return { render, layout() { editor?.layout(); }, dispose() { if (disposed) return; disposed = true; unsubscribe(); unsubscribeDisplay?.(); select.removeEventListener('change', change); host.removeEventListener('click', click); release(); host.replaceChildren(); } };
  }
  return { createComparison, comparisonOf, referenceInfoOf, createDependencySnapshot, dependencyInfoOf, renderDependencyInfo };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseCustomize };
