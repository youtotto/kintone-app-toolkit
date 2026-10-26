/* Read-only code comparison from the existing approval preparation. */
'use strict';
const KTReleaseCustomize = (() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const keyOf = file => JSON.stringify([file.target, file.name, file.changeId]);
  function comparisonOf(state, selectedRunId = null) {
    const historical = selectedRunId != null;
    const run = historical || ['result', 'rollback-confirm', 'rolling-back', 'checking-result'].includes(state.phase)
      ? (state.runs || []).find(item => item.id === (historical ? selectedRunId : state.resultRunId)) : null;
    const prepared = historical ? run?.prepared || null : run ? run.prepared : state.prepared;
    return { run, prepared, files: (prepared?.files?.changes || []).filter(file => ['desktop', 'mobile'].includes(file.target) && typeof file.name === 'string') };
  }
  function createComparison(host, { controller, monaco, getSelectedRunId = () => null, subscribeDisplay = null } = {}) {
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
      note.textContent = stateNote + (file.kind === 'ADD_FILE' ? ' 新しいファイルのため、変更前は空欄です。' : file.reason === 'JS_UNCHANGED' ? ' 既存のコードと同じため、このファイルは登録しません。' : '') + ' この表示からコードは編集できません。';
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
  return { createComparison, comparisonOf };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseCustomize };
