'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { KTReleaseWorkspace: W } = require('../src/release-workspace.js');
const { KTReleaseView: V } = require('../src/release-view.js');
const F = require('./helpers/release-workspace-fixture.js');
const prepared = () => ({ ok: true, changes: [{ title: '変更内容' }], confirmations: [], settings: [], files: [] });
const counts = f => ['propose', 'plan', 'generate'].map(method => f.count(method));
const checkFreeAction = state => {
  assert.equal(W.canReprepare(state), true);
  assert.equal(W.creationStateOf(state).canResume, false);
  const html = V.render(state, { connection: { connected: false, available: false, canCreate: false, canResume: false } });
  const button = html.match(/<button[^>]*data-release-action="reprepare"[^>]*>/)?.[0];
  assert.ok(button); assert.doesNotMatch(button, / disabled/); assert.doesNotMatch(html, /data-release-action="resume"/);
};

test('全JS完成後の準備を中断しても利用枠に依存せず無料で確認し直せる', async () => {
  const gate = F.deferred(), entered = F.deferred(); let hold = true;
  const f = F.fixture(W, { prepare: async () => { if (hold) { entered.resolve(); await gate.promise; } return prepared(); } });
  await f.controller.send(F.REQUEST); const creating = f.controller.adopt(); await entered.promise;
  assert.equal(f.controller.cancel(), true); hold = false; gate.resolve(); await creating;
  const before = f.controller.getState(), used = counts(f);
  assert.equal(before.error.code, 'CANCELLED'); assert.equal(before.artifacts.length, 2); checkFreeAction(before);
  assert.equal(await f.controller.reprepare(), true); assert.equal(f.controller.getState().phase, 'review');
  assert.deepEqual(counts(f), used); assert.deepEqual(f.controller.getState().artifacts, before.artifacts); assert.equal(f.writes.length, 0);
});

test('全JS完成後の準備例外でも生成をやり直さず無料再確認へ進む', async () => {
  let fail = true;
  const f = F.fixture(W, { prepare: async () => { if (fail) throw Error('準備時の一時的なエラー'); return prepared(); } });
  await f.controller.send(F.REQUEST); await f.controller.adopt();
  const before = f.controller.getState(), used = counts(f);
  assert.equal(before.error.code, 'ERROR'); checkFreeAction(before);
  fail = false; assert.equal(await f.controller.reprepare(), true);
  assert.equal(f.controller.getState().phase, 'review'); assert.deepEqual(counts(f), used); assert.equal(f.writes.length, 0);
});

test('未完成JS・計画の未回答・回答回収待ち・反映済みは無料再確認で飛ばさない', async () => {
  const f = F.fixture(W); await f.controller.send(F.REQUEST); await f.controller.adopt();
  const state = { ...f.controller.getState(), phase: 'incomplete', error: { code: 'CANCELLED' } };
  assert.equal(W.canReprepare(state), true);
  assert.equal(W.canReprepare({ ...state, artifacts: state.artifacts.slice(0, 1) }), false);
  assert.equal(W.canReprepare({ ...state, plan: { ...state.plan, questions: [{ question: '対象は？', blocking: true }] } }), false);
  assert.equal(W.canReprepare({ ...state, responseRecovery: { action: 'resume' } }), false);
  assert.equal(W.canReprepare({ ...state, runs: [{ taskId: state.taskId, status: 'complete' }] }), false);
});
