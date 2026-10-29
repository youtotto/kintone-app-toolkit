'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { KTReleaseWorkspace: W } = require('../src/release-workspace.js');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const F = require('./helpers/release-workspace-fixture.js');
const bundle = id => ({ version: 1, id, expiresAt: '2099-11-01T00:00:00.000Z' });
const withBundle = id => ({ ...F.plan(), planId: 'plan-' + id, finalBundle: bundle(id) });

test('計画の利用記録を受け取り、生成の送信メタへ渡し、AIへの依頼本文には加えない', () => {
  const C = loadToolkit().KTAiClient, rawPlan = withBundle('bundle-1');
  const received = C.receive('plan', { ok: true, contractVersion: '2.1', plan: rawPlan, meta: { finalBundle: bundle('bundle-1') } });
  assert.deepEqual(received.finalBundle, bundle('bundle-1'));
  const ctx = { contextVersion: '1', customization: rawPlan.customizations[0], plan: { goal: rawPlan.goal } };
  const before = JSON.stringify(ctx);
  const envelope = C.buildGenerateEnvelope({ ctx, finalBundleId: received.finalBundle.id, requestId: 'generate-1' });
  assert.equal(envelope.meta.creditContractVersion, 4);
  assert.equal(envelope.meta.finalBundleId, 'bundle-1');
  assert.equal(JSON.stringify(envelope.payload), before);
  assert.equal(JSON.stringify(ctx), before);
  assert.equal(C.buildPlanEnvelope({ ctx: { contextVersion: '1', facts: [], goal: F.REQUEST } }).meta.creditContractVersion, 4);
  assert.equal(C.buildGenerateEnvelope({ ctx }).meta.finalBundleId, undefined);
});

test('途中の案を保存して開き直しても同じ利用記録を引き継ぎ、未完成のJSだけ再開する', async () => {
  const f = F.fixture(W, { plan: withBundle('bundle-1'), generate: async ({ customization }) => {
    if (customization.customizationId === 'C2') throw new Error('通信が切れました');
    return F.generated(customization);
  } });
  await f.controller.send(F.REQUEST); await f.controller.adopt();
  assert.equal(f.controller.getState().phase, 'incomplete');
  const saved = f.controller.exportSession();
  assert.deepEqual(saved.state.plan.finalBundle, bundle('bundle-1'));
  assert.equal(saved.state.plan.planId, 'plan-bundle-1');
  const passed = saved.state.artifacts.find(a => a.customizationId === 'C1').result;
  const received = [];
  const next = F.fixture(W, { generate: async input => { received.push(input); return F.generated(input.customization); } });
  assert.equal(await next.controller.restoreSession(F.clone(saved)), true);
  for (const action of ['propose', 'plan', 'generate', 'prepare', 'apply']) assert.equal(next.count(action), 0, action);
  assert.deepEqual(next.controller.getState().adopted, saved.state.adopted);
  assert.equal(W.finalBundleAvailable(next.controller.getState().plan), true);
  assert.equal(await next.controller.resume(), true);
  assert.equal(next.controller.getState().phase, 'review');
  assert.deepEqual(received.map(x => x.customization.customizationId), ['C2']);
  assert.deepEqual(received[0].plan.finalBundle, bundle('bundle-1'));
  assert.deepEqual(next.controller.getState().artifacts.find(a => a.customizationId === 'C1').result, passed);
  assert.equal(next.count('plan'), 0); assert.equal(next.writes.length, 0);
});

test('採用内容を修正した後の作成は古い利用記録を流用しない', async () => {
  let sequence = 0;
  const f = F.fixture(W, { makePlan: async () => ({ plan: withBundle('bundle-' + (++sequence)) }) });
  await f.controller.send(F.REQUEST); await f.controller.adopt();
  assert.equal(f.controller.getState().plan.finalBundle.id, 'bundle-1');
  await f.controller.send('備考を止める対象は承認済みだけにしてください。');
  assert.equal(f.controller.getState().plan, null);
  await f.controller.adopt();
  assert.equal(f.controller.getState().plan.finalBundle.id, 'bundle-2');
  assert.equal(f.count('plan'), 2); assert.equal(f.writes.length, 0);
});

test('最終案の有効期間と、資料に必要な2クレジットが予約中の場合を区別する', () => {
  assert.equal(W.finalBundleAvailable({ finalBundle: bundle('one') }, Date.parse('2099-10-31')), true);
  assert.equal(W.finalBundleAvailable({ finalBundle: bundle('one') }, Date.parse(bundle('one').expiresAt)), false);
  assert.equal(W.finalBundleAvailable({}), false);
  const usage = { version: 4, operationCosts: { consultation: 1, document: 2, final: 3 }, credits: { limit: 100, used: 97, reserved: 2, remaining: 1 } };
  const details = { error: { detail: { bucket: 'credits', operation: 'document', requiredCredits: 2, usage } } };
  assert.match(W.monthlyLimitText({ code: 'MONTHLY_LIMIT_EXCEEDED', details }), /処理中の要求.*確保/);
  assert.doesNotMatch(W.monthlyLimitText({ code: 'MONTHLY_LIMIT_EXCEEDED', details }), /今月の.*上限/);
  const empty = { ...usage, credits: { limit: 100, used: 99, reserved: 0, remaining: 1 } };
  details.error.detail.usage = empty;
  assert.match(W.monthlyLimitText({ code: 'MONTHLY_LIMIT_EXCEEDED', details }), /必要な2クレジットが足りません/);
});

test('未完成の案について説明を聞いて保存しても、採用時の生成条件を変えずに再開する', async () => {
  const inputs = [];
  const f = F.fixture(W, { plan: withBundle('bundle-1'), generate: async input => {
    inputs.push(F.clone({ requests: input.requests, answers: input.answers, version: input.version, proposal: input.proposal }));
    throw new Error('一時的な接続エラー');
  } });
  await f.controller.send(F.REQUEST); await f.controller.adopt();
  f.services.propose = async () => ({ ...F.proposal(), intent: 'question', proposal: null, proposalUnchanged: true, reply: '作成した案について説明します。' });
  await f.controller.send('この案を分かりやすく説明して。');
  assert.equal(f.controller.getState().phase, 'incomplete');
  const saved = f.controller.exportSession();
  const next = F.fixture(W, { generate: async input => {
    assert.deepEqual({ requests: input.requests, answers: input.answers, version: input.version, proposal: input.proposal }, inputs[0]);
    return F.generated(input.customization);
  } });
  assert.equal(await next.controller.restoreSession(saved), true);
  assert.equal(await next.controller.resume(), true);
  assert.equal(next.controller.getState().phase, 'review');
  assert.equal(next.count('plan'), 0);
  assert.ok(next.controller.getState().messages.some(m => m.text === 'この案を分かりやすく説明して。'));
});
