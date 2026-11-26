'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { makeData } = require('./fixtures/ai-context-app.js');
const { generated } = require('./helpers/release-workspace-fixture.js');

const { KTReleaseWorkspace, KTReleaseView, KTReleaseExecution, KTPlanExecutor, KTJsExecutor, KTScan } = loadToolkit();
const target = '商品未選択の受注';
const unrelated = '確認用の一覧';
const request = '商品未選択の受注の昇順を解除してください';
const descending = 'レコード番号 desc';
const ascending = 'レコード番号 asc';
const clone = value => JSON.parse(JSON.stringify(value));
const scope = { appId: '310', environment: 'preview', domain: 'https://demo.example.invalid', userId: 'test-user' };
const requestRollbackButton = /data-release-action="request-rollback"/;
const confirmRollbackButton = /<button[^>]+data-release-action="rollback"[^>]*>/;
const render = (controller, options) => KTReleaseView.render(controller.getState(), options).replace(/<style>[\s\S]*?<\/style>/g, '');
const operation = (id, actionType, targetRef, spec) => ({ id, title: actionType + ' ' + targetRef, actionType, targetRef, spec, dependsOn: [] });
const clearSort = operation('V1', 'UPDATE_VIEW', target, { sort: '' });
const otherSort = operation('V2', 'UPDATE_VIEW', unrelated, { sort: 'amount desc' });
const previousSource = 'kintone.events.on("app.record.edit.show", event => event);';
const approvedSource = previousSource + '\n// 記録済みの変更';

function setup({ saveBeforeHistoryRollback, beforePutViews, operations = [clearSort], fileChange } = {}) {
  const data = makeData();
  const file = 'existing.js', fileKey = 'base-desktop';
  const existingFile = { type: 'FILE', file: { name: file, fileKey } };
  const jsSources = fileChange ? [{ name: file, target: 'desktop', text: previousSource }] : [];
  data.customize = { scope: 'ALL', desktop: { js: fileChange ? [existingFile] : [], css: [] }, mobile: { js: [], css: [] } };
  const mock = makeKintoneMock(data, { jsSources });
  const first = { id: '77', name: target, index: '4', type: 'LIST', fields: ['case_name', 'レコード番号'], filterCond: 'case_name = ""', sort: ascending };
  const second = { ...first, name: unrelated, id: '78', index: '5', sort: 'amount asc' };
  mock.st.views[target] = clone(first);
  mock.st.views[unrelated] = clone(second);
  const before = clone(mock.st.views);
  const putPreviewViews = mock.api.putPreviewViews;
  mock.api.putPreviewViews = (appId, views, revision) => {
    beforePutViews?.();
    return putPreviewViews(appId, Object.fromEntries(Object.entries(views).map(([name, view]) => [name,
      view.type === 'LIST' && view.sort === '' ? { ...view, sort: descending } : view
    ])), revision);
  };
  const loadBase = async () => ({
    ok: true, stamp: 'preview:' + mock.st.revision, appId: '310', env: 'preview', current: await mock.current()
  });
  const services = {
    async propose() {
      return { reply: request, proposal: { behaviors: [{ id: 'B1', text: request, origin: 'user' }], decisions: [] } };
    },
    async plan() {
      return { plan: {
        steps: [...operations, ...(fileChange ? [operation('C1', 'CUSTOMIZATION_REQUIRED', file, { customizationId: 'C1' })] : [])],
        proposedFields: [], customizations: fileChange ? [{ customizationId: 'C1', requirement: 'PC版の動作を変更',
          strategy: fileChange === 'replace' ? 'EXTEND_EXISTING_JS' : 'NEW_JS_FILE', platform: ['desktop'],
          events: ['app.record.edit.show'], fields: [], existingFiles: fileChange === 'replace' ? [{ name: file, target: 'desktop' }] : [] }] : [], questions: [],
      } };
    },
    async generate({ customization }) {
      const result = generated(customization, { body: approvedSource });
      if (fileChange === 'replace') {
        result.strategy = 'EXTEND_EXISTING_JS';
        result.targetFile = file;
        Object.assign(result.artifactOutcome.operations[0], {
          action: 'replace', targetFile: file, targetExistingFileId: fileKey, baseHash: KTScan.hashText(previousSource),
        });
      }
      return result;
    },
  };
  const aiCalls = [];
  const newController = () => KTReleaseWorkspace.create({
    scope,
    loadBase,
    saveBeforeHistoryRollback,
    execution: KTReleaseExecution.create({
      appId: '310', api: mock.api, loadBase, currentOf: base => base.current, planExecutor: KTPlanExecutor,
      jsExecutor: KTJsExecutor, hash: async input => createHash('sha256').update(typeof input === 'string' ? input : JSON.stringify(input)).digest('hex')
    }),
    services: Object.fromEntries(Object.entries(services).map(([method, handler]) => [method, async (...args) => {
      aiCalls.push(method);
      return handler(...args);
    }])),
  });
  const writes = () => mock.calls.filter(call => !call.startsWith('GET'));
  const localHistory = controller => clone(controller.exportSession({ includeRollback: true }));
  async function reopen(saved, options = { allowRollback: true }) {
    const controller = newController();
    const written = writes().length, spent = aiCalls.length;
    assert.equal(await controller.restoreSession(saved, options), true);
    assert.equal(writes().length, written, '履歴を開くだけで設定を書き換えない');
    assert.equal(aiCalls.length, spent, '履歴を開くだけでAIを呼ばない');
    return controller;
  }
  async function startRun() {
    const controller = newController();
    assert.equal(await controller.send(request), true);
    assert.equal(await controller.adopt(), true);
    assert.equal(controller.getState().phase, 'review', JSON.stringify(controller.getState().error));
    assert.equal(await controller.apply(), true);
    const run = controller.getState().runs[0];
    assert.equal(run.status, 'complete', JSON.stringify({ reasons: run.result?.reasons, rows: run.result?.rows, message: run.result?.message }));
    return controller;
  }
  async function apply() {
    const controller = await startRun();
    assert.equal(mock.st.views[target].sort, descending);
    assert.deepEqual(writes(), ['PUT views']);
    return controller;
  }
  function editOtherView() {
    mock.st.views[unrelated].sort = 'case_name desc';
    mock.st.revision++;
  }
  const readSettings = async () => {
    const { views, generalNotify, perRecordNotify, reminderNotify } = await mock.current();
    return clone([views.views, generalNotify.notifications, generalNotify.notifyToCommenter,
      perRecordNotify.notifications, reminderNotify.notifications, reminderNotify.timezone]);
  };
  const registeredJs = () => clone(Object.fromEntries(['desktop', 'mobile'].map(platform => [platform, mock.st.customize[platform].js.map(registration => {
    const {name, content} = mock.st.files.get(registration.fileKey);
    return {name, content};
  })])));
  return { mock, apply, startRun, before, localHistory, reopen, editOtherView, writes, readSettings, registeredJs };
}

test('一覧の反映履歴を開き直し、明示的な確認を経て並び順を元に戻す', async () => {
  const f = setup(), initial = await f.apply();
  const saved = f.localHistory(initial);
  const savedRun = saved.state.runs[0];
  assert.equal(JSON.stringify(savedRun).includes(unrelated), false, '無関係な一覧定義は保存しない');
  assert.equal(savedRun.result.settings.snapshot, undefined);
  assert.equal(savedRun.result.settings.actualAfterRaw, undefined);
  const portable = initial.exportSession().state.runs[0];
  assert.equal(portable.viewRollback ?? portable.historyRollback, undefined, 'ファイル用の履歴に復元情報は含めない');
  const controller = await f.reopen(saved);
  const id = controller.getState().runs[0].id;
  assert.equal(requestRollbackButton.test(render(controller, { selectedRunId: id })), true);
  assert.equal(await controller.rollback(id), false, '履歴からの復元にも明示的な確認が必要');
  assert.equal(await controller.requestRollback(id), true);
  assert.equal(controller.getState().phase, 'rollback-confirm');
  assert.equal(controller.getState().rollback.prepared.ok, true, JSON.stringify(controller.getState().rollback.prepared.reasons));
  const button = render(controller).match(confirmRollbackButton)?.[0];
  assert.ok(button);
  assert.doesNotMatch(button, /\sdisabled(?:[\s=>]|$)/);
  assert.deepEqual(f.writes(), ['PUT views']);
  assert.equal(await controller.rollback(id), true);
  assert.equal(controller.getState().runs[0].rollback.status, 'complete');
  assert.deepEqual(clone(f.mock.st.views), f.before);
  assert.deepEqual(f.writes(), ['PUT views', 'PUT views']);
  const reopened = await f.reopen(f.localHistory(controller));
  assert.equal(reopened.getState().runs[0].rollback.status, 'complete');
  assert.equal(requestRollbackButton.test(render(reopened, { selectedRunId: id })), false);
  assert.equal(await reopened.requestRollback(id), false);
  assert.deepEqual(f.writes(), ['PUT views', 'PUT views']);
});

test('別の一覧が変更されていたら、開き直した履歴からの復元を止める', async () => {
  const f = setup(), saved = f.localHistory(await f.apply());
  f.editOtherView();
  const expected = clone(f.mock.st.views);
  const controller = await f.reopen(saved);
  const id = controller.getState().runs[0].id;
  assert.equal(await controller.requestRollback(id), true);
  assert.equal(controller.getState().phase, 'rollback-confirm');
  assert.equal(controller.getState().rollback.prepared.ok, false);
  assert.ok(controller.getState().rollback.prepared.reasons.some(reason => reason.code === 'THIRD_PARTY_CHANGE'));
  const button = render(controller).match(confirmRollbackButton)?.[0];
  assert.ok(button);
  assert.match(button, /\sdisabled(?:[\s=>]|$)/);
  assert.equal(await controller.rollback(id), false);
  assert.deepEqual(f.writes(), ['PUT views']);
  assert.deepEqual(clone(f.mock.st.views), expected);
});

test('別の一覧が復元確認後に変更されても、書き込み前に再検査して止める', async () => {
  const f = setup(), controller = await f.reopen(f.localHistory(await f.apply()));
  const id = controller.getState().runs[0].id;
  assert.equal(await controller.requestRollback(id), true);
  assert.equal(controller.getState().rollback.prepared.ok, true);
  f.editOtherView();
  const expected = clone(f.mock.st.views);
  await controller.rollback(id);
  assert.notEqual(controller.getState().runs[0].rollback?.status, 'complete');
  assert.deepEqual(clone(f.mock.st.views), expected);
  assert.deepEqual(f.writes(), ['PUT views']);
});

test('履歴ファイルとして開いた結果と、復元情報が保存されていない旧履歴は閲覧のみ', async () => {
  const f = setup(), initial = await f.apply();
  for (const [saved, options] of [[f.localHistory(initial), {}], [clone(initial.exportSession()), { allowRollback: true }]]) {
    const controller = await f.reopen(saved, options);
    const id = controller.getState().runs[0].id;
    assert.equal(requestRollbackButton.test(render(controller, { selectedRunId: id })), false);
    assert.equal(await controller.requestRollback(id), false);
  }
  assert.deepEqual(f.writes(), ['PUT views']);
  assert.equal(f.mock.st.views[target].sort, descending);
});

test('復元の確認中に開き直した場合は承認を引き継がず、設定を読み直す', async () => {
  const f = setup(), controller = await f.reopen(f.localHistory(await f.apply()));
  const id = controller.getState().runs[0].id;
  assert.equal(await controller.requestRollback(id), true);
  assert.equal(controller.getState().rollback.prepared.ok, true);
  const reopened = await f.reopen(f.localHistory(controller));
  assert.equal(reopened.getState().phase, 'result');
  assert.equal(reopened.getState().rollback, null);
  assert.equal(await reopened.rollback(id), false);
  assert.deepEqual(f.writes(), ['PUT views']);
  f.editOtherView();
  assert.equal(await reopened.requestRollback(id), true);
  assert.equal(reopened.getState().rollback.prepared.ok, false);
  assert.deepEqual(f.writes(), ['PUT views']);
});

test('復元開始を履歴に書けない場合は、kintoneを変更せず確認へ戻せる', async () => {
  let writesAllowed = true, failSave = true, saveCalls = 0;
  const f = setup({
    saveBeforeHistoryRollback: async () => {
      saveCalls++;
      if (failSave) throw Error('会話の保存を完了できませんでした。');
      writesAllowed = true;
    },
    beforePutViews: () => assert.equal(writesAllowed, true, '保存の完了前にkintoneを書き換えない'),
  });
  const controller = await f.reopen(f.localHistory(await f.apply()));
  const id = controller.getState().runs[0].id;
  writesAllowed = false;
  assert.equal(await controller.requestRollback(id), true);
  assert.equal(await controller.rollback(id), false);
  assert.equal(saveCalls, 1);
  assert.deepEqual(f.writes(), ['PUT views']);
  assert.equal(f.mock.st.views[target].sort, descending);
  assert.match(controller.getState().error.message, /保存を完了できません/);
  failSave = false;
  assert.equal(await controller.requestRollback(id), true);
  assert.equal(await controller.rollback(id), true);
  assert.equal(saveCalls, 2);
  assert.equal(controller.getState().runs[0].rollback.status, 'complete');
  assert.deepEqual(clone(f.mock.st.views), f.before);
});

test('保存された復元情報が壊れていた場合は復元を止める', async () => {
  const f = setup(), saved = f.localHistory(await f.apply());
  const { viewRollback, historyRollback } = saved.state.runs[0];
  const capsule = historyRollback ?? viewRollback;
  capsule.revision = 'invalid';
  const controller = await f.reopen(saved);
  const id = controller.getState().runs[0].id;
  assert.equal(await controller.requestRollback(id), true);
  assert.equal(controller.getState().rollback.prepared.ok, false);
  assert.ok(controller.getState().rollback.prepared.reasons.some(reason => reason.code === 'INVALID_ROLLBACK_HISTORY'));
  assert.equal(await controller.rollback(id), false);
  assert.deepEqual(f.writes(), ['PUT views']);
  assert.equal(f.mock.st.views[target].sort, descending);
});

test('前のステージング版が保存した一覧の復元情報も使える', async () => {
  const f = setup(), initial = await f.apply(), saved = f.localHistory(initial);
  const run = initial.getState().runs[0];
  const savedRun = saved.state.runs[0];
  const hash = value => createHash('sha256').update(JSON.stringify(value, (_, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : entry)).digest('hex');
  delete savedRun.historyRollback;
  savedRun.viewRollback = {
    version: 1, executionId: run.result.settings.executionId, appId: scope.appId,
    name: target, stepId: clearSort.id, revision: String(f.mock.st.revision),
    before: { sort: ascending }, beforeHash: hash(f.before), afterHash: hash(f.mock.st.views),
  };
  const controller = await f.reopen(saved);
  assert.equal(await controller.requestRollback(run.id), true);
  assert.equal(controller.getState().rollback.prepared.ok, true);
  assert.equal(await controller.rollback(run.id), true);
  assert.equal(controller.getState().runs[0].rollback.status, 'complete');
  assert.deepEqual(clone(f.mock.st.views), f.before);
});

const recordNotificationAdd = operation('N1', 'ADD_NOTIFICATION', '', {
  name: '確認を担当者に通知', targets: ['USER:user2'], filterCond: 'amount >= "3"',
});
const recordNotificationUpdate = operation('N2', 'UPDATE_NOTIFICATION', 'perRecord#1', { filterCond: 'amount >= "400"' });
const generalNotificationUpdate = operation('N3', 'UPDATE_NOTIFICATION', 'general#1', { events: ['recordAdded', 'recordEdited'] });
const reminderAdd = operation('R1', 'ADD_REMINDER', '', {
  name: '期限を知らせる', targets: ['USER:user2'], timingField: 'due_date', daysLater: 1, time: '10:00', filterCond: '',
});
const reminderUpdate = operation('R2', 'UPDATE_REMINDER', 'reminder#1', { time: '10:00' });
const viewAdd = operation('V3', 'ADD_VIEW', '確認する案件', {
  name: '確認する案件', fields: ['case_name'], filterCond: '', sort: '',
});

for (const [label, options] of [
  ['複数の一覧', { operations: [clearSort, otherSort] }],
  ['一覧の追加と更新', { operations: [viewAdd, clearSort] }],
  ['レコード通知の追加', { operations: [recordNotificationAdd] }],
  ['レコード通知の更新', { operations: [recordNotificationUpdate] }],
  ['アプリ通知の更新', { operations: [generalNotificationUpdate] }],
  ['リマインダーの追加', { operations: [reminderAdd] }],
  ['リマインダーの更新', { operations: [reminderUpdate] }],
  ['JavaScriptの新規登録', { operations: [], fileChange: 'add' }],
  ['JavaScriptの差し替え', { operations: [], fileChange: 'replace' }],
  ['一覧・通知・JavaScriptを含む1回の反映', { operations: [clearSort, otherSort, recordNotificationUpdate, reminderUpdate], fileChange: 'replace' }],
]) test(label + 'を開き直した履歴から復元する', async () => {
  const f = setup(options), before = await f.readSettings(), filesBefore = f.registeredJs();
  const initial = await f.startRun();
  if (options.operations.length) assert.notDeepEqual(await f.readSettings(), before);
  if (options.fileChange) assert.notDeepEqual(f.registeredJs(), filesBefore);
  const afterApply = f.writes();
  const controller = await f.reopen(f.localHistory(initial));
  const id = controller.getState().runs[0].id;
  assert.equal(requestRollbackButton.test(render(controller, { selectedRunId: id })), true);
  assert.equal(await controller.requestRollback(id), true);
  const prepared = controller.getState().rollback.prepared;
  assert.equal(prepared.ok, true, JSON.stringify(prepared.reasons));
  assert.deepEqual(f.writes(), afterApply);
  assert.equal(await controller.rollback(id), true);
  const rolledBack = controller.getState().runs[0].rollback;
  assert.equal(rolledBack.status, 'complete', JSON.stringify(rolledBack.reasons || rolledBack.message));
  assert.deepEqual(await f.readSettings(), before);
  assert.deepEqual(f.registeredJs(), filesBefore);
  const reopened = await f.reopen(f.localHistory(controller));
  assert.equal(await reopened.requestRollback(id), false);
});

test('複数の一覧を反映したあと、反映対象外の一覧が変わったら一切書き戻さない', async () => {
  const f = setup({ operations: [clearSort, otherSort] });
  const saved = f.localHistory(await f.startRun());
  assert.equal(Object.hasOwn(f.mock.st.views, '顧客別一覧'), true);
  f.mock.st.views['顧客別一覧'].sort = 'amount asc';
  f.mock.st.revision++;
  const afterEdit = clone(f.mock.st.views);
  const afterApply = f.writes();
  const controller = await f.reopen(saved);
  const id = controller.getState().runs[0].id;
  assert.equal(await controller.requestRollback(id), true);
  assert.equal(controller.getState().rollback.prepared.ok, false);
  assert.equal(await controller.rollback(id), false);
  assert.deepEqual(f.writes(), afterApply);
  assert.deepEqual(clone(f.mock.st.views), afterEdit);
});

test('一覧とJavaScriptの復元確認後に別の一覧が変わると、ファイルのアップロードも始めない', async () => {
  const f = setup({ operations: [clearSort], fileChange: 'replace' });
  const controller = await f.reopen(f.localHistory(await f.startRun()));
  const id = controller.getState().runs[0].id;
  assert.equal(await controller.requestRollback(id), true);
  assert.equal(controller.getState().rollback.prepared.ok, true);
  f.editOtherView();
  const afterEdit = await f.readSettings(), afterApply = f.writes(), filesAfterApply = f.registeredJs();
  await controller.rollback(id);
  assert.notEqual(controller.getState().runs[0].rollback?.status, 'complete');
  assert.deepEqual(f.writes(), afterApply);
  assert.deepEqual(await f.readSettings(), afterEdit);
  assert.deepEqual(f.registeredJs(), filesAfterApply);
});

test('JavaScriptの復元直後に別の一覧が変わったら、残りの一覧復元を止める', async () => {
  const f = setup({ operations: [clearSort], fileChange: 'replace' });
  const filesBefore = f.registeredJs();
  const controller = await f.reopen(f.localHistory(await f.startRun()));
  const id = controller.getState().runs[0].id;
  assert.equal(await controller.requestRollback(id), true);
  assert.equal(controller.getState().rollback.prepared.ok, true);
  const writesBefore = f.writes().length;
  const putCustomize = f.mock.api.putPreviewCustomize;
  f.mock.api.putPreviewCustomize = async (...args) => {
    const result = await putCustomize(...args);
    f.editOtherView();
    return result;
  };
  assert.equal(await controller.rollback(id), true);
  assert.equal(controller.getState().runs[0].rollback.status, 'partial');
  assert.deepEqual(f.registeredJs(), filesBefore);
  assert.deepEqual(f.writes().slice(writesBefore), ['POST file', 'PUT customize']);
  assert.equal(f.mock.st.views[target].sort, descending);
  assert.equal(f.mock.st.views[unrelated].sort, 'case_name desc');
});

test('個別の復元確認後に一覧が変わった場合は、履歴を復元済みと表示しない', async () => {
  const f = setup(), controller = await f.reopen(f.localHistory(await f.apply()));
  const id = controller.getState().runs[0].id;
  assert.equal(await controller.requestRollback(id), true);
  assert.equal(controller.getState().rollback.prepared.ok, true);
  const writesBefore = f.writes().length;
  const getViews = f.mock.api.getPreviewViews;
  let changed = false;
  f.mock.api.getPreviewViews = async (...args) => {
    const result = await getViews(...args);
    if (!changed && f.writes().length > writesBefore) {
      changed = true;
      f.editOtherView();
    }
    return result;
  };

  assert.equal(await controller.rollback(id), true);
  const rollback = controller.getState().runs[0].rollback;
  assert.equal(changed, true);
  assert.equal(rollback.settings.steps[0].status, 'ROLLBACK_VERIFIED');
  assert.equal(rollback.settings.verification.restoredToSnapshot, false);
  assert.equal(rollback.settings.status, 'ROLLBACK_VERIFY_FAILED');
  assert.equal(rollback.status, 'partial');
  assert.deepEqual(f.writes().slice(writesBefore), ['PUT views']);
  assert.equal(f.mock.st.views[target].sort, ascending);
  assert.equal(f.mock.st.views[unrelated].sort, 'case_name desc');
});

for (const [label, options, laterChange] of [
  ['通知', { operations: [recordNotificationUpdate] }, mock => {
    mock.st.perRecord[0].filterCond = 'amount >= "500"';
  }],
  ['JavaScript', { operations: [], fileChange: 'replace' }, mock => {
    const [registration] = mock.st.customize.desktop.js;
    mock.st.files.get(registration.fileKey).content = '// 現場の担当者による更新';
  }],
]) test('反映後に' + label + 'を別途編集した場合は履歴から書き戻さない', async () => {
  const f = setup(options), saved = f.localHistory(await f.startRun());
  laterChange(f.mock);
  f.mock.st.revision++;
  const afterEdit = await f.readSettings(), editsInJs = f.registeredJs(), writes = f.writes();
  const controller = await f.reopen(saved);
  const id = controller.getState().runs[0].id;
  assert.equal(await controller.requestRollback(id), true);
  assert.equal(controller.getState().rollback.prepared.ok, false);
  assert.equal(await controller.rollback(id), false);
  assert.deepEqual(f.writes(), writes);
  assert.deepEqual(await f.readSettings(), afterEdit);
  assert.deepEqual(f.registeredJs(), editsInJs);
});
