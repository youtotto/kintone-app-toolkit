'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTReleaseCustomize } = require('../src/release-customize.js');
const file = (target, name = 'same.js', extra = {}) => ({ changeId: target + '-1', target, name, kind: 'REPLACE_FILE', status: 'PENDING', currentSource: 'const before = 1;\r\n', content: 'const after = 2;\r\n', ...extra });
const state = files => ({ phase: 'review', prepared: { ok: true, files: { changes: files } }, runs: [], resultRunId: null });
function fixture(initial = state([file('desktop')]), options = {}) {
  const make = () => ({ value: '', textContent: '', innerHTML: '', disabled: false, hidden: false, attrs: {}, dataset: {}, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; }, removeEventListener(type, fn) { if (this.listeners[type] === fn) delete this.listeners[type]; },
    setAttribute(name, value) { this.attrs[name] = value; } });
  const elements = Object.fromEntries(['file', 'note', 'empty', 'editor'].map(name => [name, make()]));
  const buttons = ['before', 'after', 'diff'].map(mode => { const b = make(); b.dataset.comparisonMode = mode; b.closest = () => b; return b; });
  const host = { ...make(), querySelector(selector) { return elements[selector.slice('[data-comparison-'.length, -1)]; }, querySelectorAll: () => buttons,
    replaceChildren() { this.innerHTML = ''; } };
  const models = [], editors = [], events = [];
  const monaco = { editor: {
    createModel(text, language) { const model = { text, language, disposed: false, dispose() { this.disposed = true; events.push('model.dispose'); } }; models.push(model); return model; },
    createDiffEditor(surface, options) { assert.equal(surface, elements.editor); const editor = { options, diff: true, disposed: false, setModel(value) { this.model = value; }, layout() { this.layouts = (this.layouts || 0) + 1; }, dispose() { this.disposed = true; events.push('editor.dispose'); } }; editors.push(editor); return editor; },
    create(surface, options) { assert.equal(surface, elements.editor); const editor = { options, model: options.model, disposed: false, layout() {}, dispose() { this.disposed = true; events.push('editor.dispose'); } }; editors.push(editor); return editor; }
  } };
  let current = initial;
  const listeners = new Set(), controller = { getState: () => current, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const api = KTReleaseCustomize.createComparison(host, { controller, monaco, ...options });
  return { host, elements, buttons, models, editors, events, listeners, api,
    emit(next) { current = next; for (const listener of listeners) listener(next); },
    choose(index) { const next = KTReleaseCustomize.comparisonOf(current).files[index]; elements.file.value = JSON.stringify([next.target, next.name, next.changeId]); elements.file.listeners.change(); },
    mode(mode) { host.listeners.click({ target: buttons.find(button => button.dataset.comparisonMode === mode) }); } };
}

test('反映前確認の原文をそのまま使い、コード・選択・差分は読み取り専用', () => {
  const before = '/* <script>danger()</script> */\r\nconst before = "<&>";\r\n';
  const after = '/* </code><img src=x onerror=alert(1)> */\r\nconst after = "<&>";\r\n';
  const initial = state([file('desktop', 'test.js', { currentSource: before, content: after })]), original = JSON.stringify(initial);
  const f = fixture(initial), diff = f.editors[0];
  assert.equal(diff.model.original.text, before); assert.equal(diff.model.modified.text, after);
  assert.equal(diff.options.readOnly, true); assert.equal(diff.options.domReadOnly, true); assert.equal(diff.options.originalEditable, false);
  assert.equal(f.host.innerHTML.includes('danger()'), false); assert.equal(f.host.innerHTML.includes('onerror=alert'), false);
  f.mode('before'); assert.equal(f.editors.at(-1).model.text, before); assert.equal(f.editors.at(-1).options.readOnly, true);
  f.mode('after'); assert.equal(f.editors.at(-1).model.text, after);
  assert.equal(JSON.stringify(initial), original, '表示や切替で採用・準備データを書き換えない');
});

test('同名ファイルのPCとモバイルを区別し、再描画でも選択を維持する', () => {
  const initial = state([file('desktop'), file('mobile', 'same.js', { currentSource: 'mobileBefore', content: 'mobileAfter' })]);
  const f = fixture(initial);
  assert.match(f.elements.file.innerHTML, /PC \/ same.js/); assert.match(f.elements.file.innerHTML, /モバイル \/ same.js/);
  f.choose(1); assert.equal(f.editors.at(-1).model.modified.text, 'mobileAfter');
  const count = f.models.length; f.emit(JSON.parse(JSON.stringify(initial)));
  assert.equal(f.models.length, count, '同一本文でモデルを作り直さない');
  assert.equal(f.editors.at(-1).model.modified.text, 'mobileAfter');
});

test('対象名はHTMLとして扱わない', () => {
  const f = fixture(state([file('desktop', '<img src=x onerror=alert(1)>.js')]));
  assert.equal(f.elements.file.innerHTML.includes('<img'), false);
  assert.match(f.elements.file.innerHTML, /&lt;img/);
});

test('新規ファイルだけは変更前を空にする。既存本文未取得を追加扱いにしない', () => {
  const f = fixture(state([file('desktop', 'new.js', { kind: 'ADD_FILE', currentSource: undefined, content: 'newBody' })]));
  assert.equal(f.models[0].text, ''); assert.equal(f.models[1].text, 'newBody');
  assert.match(f.elements.note.textContent, /新しいファイル/);
  f.emit(state([file('desktop', 'old.js', { currentSource: undefined })]));
  assert.equal(f.elements.editor.hidden, true); assert.match(f.elements.empty.textContent, /そろっていない/);
  assert.ok(f.buttons.every(button => button.disabled)); assert.ok(f.models.every(model => model.disposed));
});

test('未完成の生成結果から比較や合格状態を捏造しない', () => {
  const f = fixture({ phase: 'incomplete', prepared: null, artifacts: [{ result: { generated: { code: 'partial body' } } }], runs: [] });
  assert.equal(f.models.length, 0); assert.equal(f.elements.editor.hidden, true);
  assert.match(f.elements.empty.textContent, /完了していません/);
  f.emit(state([file('desktop')])); assert.equal(f.elements.editor.hidden, false);
  f.emit({ phase: 'consulting', prepared: null, runs: [] });
  assert.equal(f.elements.editor.hidden, true); assert.ok(f.models.every(model => model.disposed));
});

test('準備が不合格の場合は比較できても反映可能とは表示しない', () => {
  const initial = state([file('desktop', 'same.js', { status: 'BLOCKED', reason: 'JS_SOURCE_CHANGED' })]); initial.prepared.ok = false;
  const f = fixture(initial);
  assert.equal(f.models.length, 2); assert.match(f.elements.note.textContent, /確認は完了していません/);
  assert.match(f.elements.note.textContent, /この比較だけでは反映できません/);
  assert.equal(f.host.innerHTML.includes('data-release-action="apply"'), false);
});

test('変更なしは既存と同じコードで示す', () => {
  const f = fixture(state([file('desktop', 'same.js', { status: 'SKIPPED', reason: 'JS_UNCHANGED', currentSource: 'same', content: 'same' })]));
  assert.equal(f.models[0].text, f.models[1].text);
  assert.match(f.elements.note.textContent, /登録しません/);
});

test('反映結果ではその反映の準備を使い、別作業や現在の登録内容と混同しない', () => {
  const prepared = state([file('mobile', 'applied.js', { content: 'applied body' })]).prepared;
  const initial = { ...state([file('desktop', 'unrelated.js')]), phase: 'result', resultRunId: 'R1', runs: [{ id: 'R1', prepared }, { id: 'R2', prepared: state([file('desktop', 'later.js')]).prepared }] };
  const f = fixture(initial);
  assert.match(f.elements.file.innerHTML, /applied.js/); assert.equal(f.elements.file.innerHTML.includes('unrelated'), false);
  assert.equal(f.editors.at(-1).model.modified.text, 'applied body'); assert.match(f.elements.note.textContent, /取り直した表示ではありません/);
  assert.equal(f.buttons[0].textContent, '反映前のコード'); assert.equal(f.buttons[1].textContent, '反映に使用した案');
  f.emit({ phase: 'idle', prepared: null, resultRunId: 'R1', runs: initial.runs });
  assert.equal(f.models.at(-1).disposed, true, '新しい相談で前の反映案を現在案として出さない');
});

test('切替と終了でMonacoを先に破棄してからモデルを解放する', () => {
  const f = fixture(); f.mode('after');
  assert.deepEqual(f.events.slice(0, 3), ['editor.dispose', 'model.dispose', 'model.dispose']);
  f.api.dispose(); f.api.dispose();
  assert.ok(f.models.every(model => model.disposed)); assert.ok(f.editors.every(editor => editor.disposed));
  assert.equal(f.listeners.size, 0); assert.equal(f.host.innerHTML, '');
  const count = f.models.length; f.emit(state([file('mobile')])); assert.equal(f.models.length, count);
});

test('会話で選んだ過去の反映記録に比較も追随し、現在へ戻るまで混在させない', () => {
  let selectedRunId = null;
  const displayListeners = new Set();
  const initial = { ...state([file('desktop', 'current.js', { content: 'current body' })]), resultRunId: 'R2', runs: [
    { id: 'R1', prepared: state([file('desktop', 'first.js', { content: 'first body' })]).prepared },
    { id: 'R2', prepared: state([file('mobile', 'second.js', { content: 'second body' })]).prepared }
  ] };
  const f = fixture(initial, { getSelectedRunId: () => selectedRunId,
    subscribeDisplay(fn) { displayListeners.add(fn); return () => displayListeners.delete(fn); } });
  const chooseHistory = id => { selectedRunId = id; for (const listener of displayListeners) listener(); };
  assert.equal(f.editors.at(-1).model.modified.text, 'current body');
  chooseHistory('R1'); assert.equal(f.editors.at(-1).model.modified.text, 'first body'); assert.equal(f.buttons[0].textContent, '反映前のコード');
  chooseHistory('R2'); assert.equal(f.editors.at(-1).model.modified.text, 'second body');
  chooseHistory('missing'); assert.equal(f.elements.editor.hidden, true); assert.ok(f.models.every(model => model.disposed), '不存在の履歴に現在の案を代入しない');
  chooseHistory(null); assert.equal(f.editors.at(-1).model.modified.text, 'current body'); assert.equal(f.buttons[0].textContent, '現在のコード');
  f.api.dispose(); assert.equal(displayListeners.size, 0);
});

test('上下表示の比較は手元の編集中の差分ではないと伝え、別ファイルでも選択を勝手に変えない', () => {
  let editing = { target: 'desktop', name: 'same.js', text: 'unsaved code' };
  const f = fixture(state([file('desktop'), file('mobile', 'same.js', { content: 'mobile after' })]), { getEditingFile: () => editing });
  assert.match(f.elements.note.textContent, /手元の編集中のコードとの差分ではありません/);
  assert.doesNotMatch(f.elements.note.textContent, /別のファイル/);
  f.choose(1);
  const selected = f.elements.file.value;
  assert.match(f.elements.note.textContent, /上のエディターとは別のファイル/);
  editing = { target: 'desktop', name: 'another.js' }; f.api.render();
  assert.equal(f.elements.file.value, selected);
  assert.equal(f.editors.at(-1).model.modified.text, 'mobile after');
  editing = { target: 'mobile', name: 'same.js' }; f.api.render();
  assert.doesNotMatch(f.elements.note.textContent, /別のファイル/);
  assert.match(f.elements.note.textContent, /手元の編集中のコードとの差分ではありません/);
});
