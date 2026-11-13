'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { KTReleaseView: View } = require('../src/release-view.js');
const { deferred } = require('./helpers/release-workspace-fixture.js');
const clean = html => html.replace(/<style>[\s\S]*?<\/style>/g, '');
const stateOf = () => ({ phase: 'idle', taskId: 1, version: 1, messages: [], runs: [], artifacts: [] });
const button = (html, action) => (html.match(/<button\b[^>]*>/g) || []).find(tag => tag.includes(`data-release-action="${action}"`));
function hostOf() {
  const listeners = new Map(); let html = '', input = null;
  const host = { ownerDocument: { activeElement: null }, querySelector: selector => selector === '#kt-release-input' ? input : null, querySelectorAll: () => [],
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
    dispatch: async (name, target) => listeners.get(name)?.({ target, preventDefault() {} }) };
  Object.defineProperty(host, 'innerHTML', { get: () => html, set(value) {
    html = String(value); input = { id: 'kt-release-input', value: '', disabled: /<textarea\b[^>]* disabled/.test(html), selectionStart: 0, selectionEnd: 0,
      focus() { host.ownerDocument.activeElement = input; }, setSelectionRange() {} };
  } });
  return host;
}
function mount(options = {}, methods = {}) {
  let state = stateOf(); const listeners = new Set(), calls = [];
  const publish = () => { for (const fn of listeners) fn(state); };
  const controller = { getState: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    newTask() { calls.push('newTask'); state = { ...stateOf(), taskId: state.taskId + 1 }; publish(); return true; },
    send: async text => { calls.push(['send', text]); return true; },
    setRequestPurpose(purpose) { state.requestPurpose = purpose; publish(); }, ...methods };
  const host = hostOf(), view = View.create(host, { controller, ...options });
  return { host, view, controller, calls, publish };
}
async function click(host, action, extra = {}) { await host.dispatch('click', { dataset: { releaseAction: action, ...extra }, disabled: false }); }
async function type(host, text) { const input = host.querySelector('#kt-release-input'); input.value = text; await host.dispatch('input', input); }

test('保存した会話はチャット上部に置き、ヘッダーは接続とその他に絞る', async () => {
  assert.equal(button(clean(View.render(stateOf())), 'saved-history'), undefined);
  let opened = 0;
  const { host, view } = mount({ onHistory: () => ++opened, historyStatus: () => ({ state: 'saved', completed: true, pinned: true }) });
  const html = clean(host.innerHTML), header = html.match(/<header class="ktr-header">[\s\S]*?<\/header>/)[0];
  const chatTools = html.match(/<div class="ktr-conversation-tools">[\s\S]*?<\/div>/)[0];
  assert.match(chatTools, /data-release-action="saved-history"[^>]*>保存した会話/);
  assert.match(header, /data-release-history-state="saved" role="status">保存済み・完了・保護中/);
  assert.match(header, /data-release-action="connect"/);
  assert.match(header, /<summary>その他<\/summary>[\s\S]*data-release-action="details"/);
  assert.doesNotMatch(header, /data-release-action="(?:saved-history|documents|diagnose|code|pending-changes)"|class="ktr-phase"/);
  assert.doesNotMatch(html, /data-release-action="pending-changes"/);
  const composeTools = html.match(/<nav class="ktr-compose-tools"[\s\S]*?<\/nav>/)[0];
  assert.match(composeTools, /data-release-action="diagnose"[\s\S]*data-release-action="documents"/);
  await click(host, 'saved-history'); assert.equal(opened, 1); view.dispose();
});

test('保存状況は短く表示し、失敗の詳しい理由をキーボードで開ける', () => {
  for (const state of ['saving', 'saved', 'loading']) {
    const html = clean(View.render(stateOf(), { historyStatus: () => ({ state }) }));
    assert.match(html, new RegExp('data-release-history-state="' + state + '" role="status"'));
  }
  for (const state of ['error', 'unavailable']) {
    const html = clean(View.render(stateOf(), { historyStatus: () => ({ state, message: '<img src=x onerror="evil()">保存容量が足りません' }) }));
    assert.match(html, /<details class="ktr-history-status-detail"[^>]*><summary><span[^>]* role="alert"/);
    assert.match(html, /保存容量が足りません/); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|onerror="evil/);
    assert.equal((html.match(/ktr-history-status-message/g) || []).length, 1);
  }
  assert.match(clean(View.render(stateOf(), { historyStatus() { throw new Error('read failed'); } })), /保存の状態を確認できません/);
});

test('下書き通知は入力・復元・回答・相談補助の実際の変更ごとに一度だけ発行する', async () => {
  const f = mount(), values = [], unsubscribe = f.view.subscribeDraft(text => values.push(text));
  assert.equal(f.view.getDraft(), ''); assert.deepEqual(values, []);
  await type(f.host, '入力中'); await type(f.host, '入力中');
  f.view.render(); f.publish(); f.view.onVisible();
  assert.deepEqual(values, ['入力中']); assert.equal(f.view.getDraft(), '入力中');
  assert.equal(f.view.setDraft('復元した下書き'), true); assert.equal(f.view.setDraft('復元した下書き'), false);
  assert.equal(f.host.querySelector('#kt-release-input').value, '復元した下書き');
  f.view.focusConsultation('上書きしない'); assert.equal(f.view.getDraft(), '復元した下書き');
  f.view.setDraft(''); f.view.focusConsultation('対象を相談');
  await click(f.host, 'answer', { releaseAnswer: '質問への回答' });
  assert.deepEqual(values, ['入力中', '復元した下書き', '', '対象を相談', '質問への回答']);
  unsubscribe(); f.view.setDraft('通知解除後'); assert.equal(values.length, 5);
  f.view.dispose(); assert.equal(f.view.setDraft('破棄後'), false); assert.equal(f.view.getDraft(), '通知解除後');
});

test('送信で下書きを消したことと、受付失敗で戻したことを通知する', async () => {
  const f = mount({}, { send: async () => false }), values = [];
  f.view.subscribeDraft(text => values.push(text));
  await type(f.host, '相談したい内容'); await click(f.host, 'send');
  assert.deepEqual(values, ['相談したい内容', '', '相談したい内容']);
  assert.equal(f.view.getDraft(), '相談したい内容');
  f.controller.send = async () => true;
  await click(f.host, 'send'); assert.equal(f.view.getDraft(), '');
  assert.deepEqual(values, ['相談したい内容', '', '相談したい内容', '']); f.view.dispose();
});

test('非同期の新規相談処理が終わるまで元の下書きと作業を保持し、重複操作を止める', async () => {
  const gate = deferred(), hooks = [], values = [];
  const f = mount({ onNewTask: async () => { hooks.push(f.view.getDraft()); return gate.promise; } });
  f.view.subscribeDraft(text => values.push(text)); f.view.setDraft('保存する下書き');
  const taskId = f.controller.getState().taskId, pending = click(f.host, 'new-task');
  assert.deepEqual(hooks, ['保存する下書き']); assert.equal(f.view.getDraft(), '保存する下書き');
  assert.equal(f.host.querySelector('#kt-release-input').disabled, true);
  assert.equal(f.controller.getState().taskId, taskId); assert.equal(f.view.canRequestDocument(), false);
  await click(f.host, 'new-task'); await click(f.host, 'send'); assert.equal(hooks.length, 1); assert.deepEqual(f.calls, []);
  gate.resolve(true); await pending;
  assert.equal(f.view.getDraft(), ''); assert.equal(f.controller.getState().taskId, taskId + 1);
  assert.deepEqual(f.calls, ['newTask']); assert.deepEqual(values, ['保存する下書き', '']);
  assert.equal(f.host.querySelector('#kt-release-input').disabled, false); f.view.dispose();
});

test('新規相談前の保存が拒否・失敗したら下書きと現在の作業を残す', async () => {
  for (const onNewTask of [async () => false, async () => { throw new Error('保存を完了できませんでした。'); }]) {
    const f = mount({ onNewTask }), values = []; f.view.setDraft('消さない下書き'); f.view.subscribeDraft(text => values.push(text));
    const before = JSON.stringify(f.controller.getState()); await click(f.host, 'new-task');
    assert.equal(f.view.getDraft(), '消さない下書き'); assert.equal(JSON.stringify(f.controller.getState()), before);
    assert.deepEqual(values, []); assert.deepEqual(f.calls, []); assert.equal(f.host.querySelector('#kt-release-input').disabled, false);
    f.view.dispose();
  }
});

test('送信準備・処理中は履歴切替と新規相談を開始しない', async () => {
  const gate = deferred(); let hooks = 0, histories = 0;
  const f = mount({ beforeSend: () => gate.promise, onNewTask: () => ++hooks, onHistory: () => ++histories });
  f.view.setDraft('相談中'); const pending = click(f.host, 'send');
  await click(f.host, 'new-task'); await click(f.host, 'saved-history'); assert.equal(hooks, 0); assert.equal(histories, 0);
  gate.resolve(false); await pending;
  f.controller.getState().phase = 'building'; f.publish();
  assert.match(button(clean(f.host.innerHTML), 'saved-history'), / disabled/);
  await click(f.host, 'new-task'); await click(f.host, 'saved-history'); assert.equal(hooks, 0); assert.equal(histories, 0);
  assert.equal(f.view.getDraft(), '相談中'); f.view.dispose();
});

test('保存した反映結果は内容を残して、再確認と復元の実行操作を出さない', () => {
  const archivedNote = /保存した反映結果です。現在の状態や、元に戻せることを保証するものではありません。/;
  for (const status of ['complete', 'unknown']) for (const rollback of [null, { status: 'unknown' }]) {
    const state = stateOf(); state.phase = 'result'; state.runs = [{ id: 'old-run', archived: true, status, rollback,
      result: { status, written: 1, message: '保存された結果の本文' }, prepared: { changes: [{ title: '備考の編集制御を変更' }] } }];
    const html = clean(View.render(state));
    assert.match(html, archivedNote); assert.doesNotMatch(html, /data-release-action="(?:request-rollback|rollback|recheck-apply|recheck-rollback)"/);
    if (!rollback) assert.match(html, /保存された結果の本文/);
    if (status === 'complete' && !rollback) assert.match(html, /備考の編集制御を変更/);
    state.phase = 'rollback-confirm'; state.rollback = { runId: 'old-run', prepared: { ok: true } };
    assert.doesNotMatch(clean(View.render(state)), /data-release-action="rollback"/);
  }
  assert.doesNotMatch(clean(View.render(stateOf())), archivedNote);
  const current = stateOf(); current.phase = 'result'; current.runs = [{ id: 'current', status: 'complete', result: { status: 'complete', written: 1 } }];
  assert.match(clean(View.render(current)), /data-release-action="request-rollback"/);
});

test('保存した会話の表示リセットは反映記録の選択を解除し、下書きを変更しない', async () => {
  const f = mount(), values = [];
  f.controller.getState().runs.push({ id: 'old-run', status: 'complete', result: { status: 'complete' } });
  f.view.setDraft('保持する入力'); f.view.subscribeDraft(text => values.push(text));
  await click(f.host, 'history', { releaseId: 'old-run' });
  assert.equal(f.view.getSelectedRunId(), 'old-run'); assert.equal(f.view.canSwitchSession(), true); assert.equal(f.view.canFocusConsultation(), false);
  f.view.resetDisplay();
  assert.equal(f.view.getSelectedRunId(), null); assert.equal(f.view.getDraft(), '保持する入力'); assert.deepEqual(values, []);
  assert.equal(f.host.querySelector('#kt-release-input').disabled, false); f.view.dispose();
});

test('新規相談の保存フックは切替可能な時点で開始する', async () => {
  const f = mount({ onNewTask: () => f.view.canFocusConsultation() });
  f.view.setDraft('保存して移動'); await click(f.host, 'new-task');
  assert.deepEqual(f.calls, ['newTask']); assert.equal(f.view.getDraft(), ''); f.view.dispose();
});

test('保存状態だけの更新は入力DOMと下書き通知を変えず、エラー詳細の開閉を維持する', () => {
  let status = { state: 'error', message: '最初の保存エラー' };
  const f = mount({ historyStatus: () => status });
  f.view.setDraft('入力中'); const input = f.host.querySelector('#kt-release-input'), values = [];
  f.view.subscribeDraft(text => values.push(text));
  let html = '', panel = { open: true, querySelector: () => null };
  const slot = { querySelector: () => panel };
  Object.defineProperty(slot, 'innerHTML', { get: () => html, set(value) { html = value; panel = value.includes('<details') ? { open: false, querySelector: () => null } : null; } });
  const query = f.host.querySelector; f.host.querySelector = selector => selector === '[data-release-history-status]' ? slot : query(selector);
  f.view.updateHistoryStatus(); assert.equal(panel.open, true); assert.match(html, /最初の保存エラー/);
  status = { state: 'error', message: '次の保存エラー' }; f.view.updateHistoryStatus();
  assert.equal(panel.open, true); assert.match(html, /次の保存エラー/);
  status = { state: 'saved' }; f.view.updateHistoryStatus(); assert.equal(panel, null); assert.match(html, /保存済み/);
  assert.equal(f.host.querySelector('#kt-release-input'), input); assert.equal(f.view.getDraft(), '入力中'); assert.deepEqual(values, []);
  f.view.dispose(); status = { state: 'saving' }; f.view.updateHistoryStatus(); assert.match(html, /保存済み/);
});
