'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { makeData } = require('./fixtures/ai-context-app.js');

const { KTReleaseWorkspace, KTReleaseView, KTReleaseExecution, KTPlanExecutor, KTJsExecutor } = loadToolkit();
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

function setup({ saveBeforeHistoryRollback, beforePutViews } = {}) {
  const mock = makeKintoneMock(makeData());
  const first = { name: target, id: '77', index: '4', type: 'LIST', fields: ['case_name', 'レコード番号'], filterCond: 'case_name = ""', sort: ascending };
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
        steps: [{ id: 'V1', title: request, actionType: 'UPDATE_VIEW', targetKind: 'VIEW', targetRef: target, spec: { sort: '' }, dependsOn: [] }],
        proposedFields: [], customizations: [], questions: [],
      } };
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
  async function apply() {
    const controller = newController();
    assert.equal(await controller.send(request), true);
    assert.equal(await controller.adopt(), true);
    assert.equal(controller.getState().phase, 'review', JSON.stringify(controller.getState().error));
    assert.equal(await controller.apply(), true);
    assert.equal(controller.getState().runs[0].status, 'complete');
    assert.equal(mock.st.views[target].sort, descending);
    assert.deepEqual(writes(), ['PUT views']);
    return controller;
  }
  function editOtherView() {
    mock.st.views[unrelated].sort = 'case_name desc';
    mock.st.revision++;
  }
  return { mock, apply, before, localHistory, reopen, editOtherView, writes };
}

test('一覧の反映履歴を開き直し、明示的な確認を経て並び順を元に戻す', async () => {
  const f = setup(), initial = await f.apply();
  const saved = f.localHistory(initial);
  const savedRun = saved.state.runs[0];
  assert.equal(JSON.stringify(savedRun).includes(unrelated), false, '無関係な一覧定義は保存しない');
  assert.equal(savedRun.result.settings.snapshot, undefined);
  assert.equal(savedRun.result.settings.actualAfterRaw, undefined);
  assert.equal(initial.exportSession().state.runs[0].viewRollback, undefined, 'ファイル用の履歴に復元情報は含めない');
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

test('保存された変更前の並び順が壊れていた場合は復元を止める', async () => {
  const f = setup(), saved = f.localHistory(await f.apply());
  saved.state.runs[0].viewRollback.before.sort = 'amount desc';
  const controller = await f.reopen(saved);
  const id = controller.getState().runs[0].id;
  assert.equal(await controller.requestRollback(id), true);
  assert.equal(controller.getState().rollback.prepared.ok, false);
  assert.ok(controller.getState().rollback.prepared.reasons.some(reason => reason.code === 'INVALID_ROLLBACK_HISTORY'));
  assert.equal(await controller.rollback(id), false);
  assert.deepEqual(f.writes(), ['PUT views']);
  assert.equal(f.mock.st.views[target].sort, descending);
});
