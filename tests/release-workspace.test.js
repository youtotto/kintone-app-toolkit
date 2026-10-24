'use strict';

// 採用した設計の利用者操作を通す受入試験。旧画面名・旧会話状態への互換は求めない。
// AI、kintone、Cloudflareへの接続は行わない。
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTReleaseWorkspace } = require('../src/release-workspace.js');
const { KTReleaseView } = require('../src/release-view.js');
const { REQUEST, proposal, plan, generated, fixture, deferred } = require('./helpers/release-workspace-fixture.js');

const fresh = options => fixture(KTReleaseWorkspace, options);
const stateOf = f => f.controller.getState();
async function built(f) {
  await f.controller.send(REQUEST);
  await f.controller.adopt();
  return stateOf(f);
}
const plain = html => String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const ordinary = html => plain(String(html).replace(/<details\b[\s\S]*?<\/details>/g, ''));
const latestRun = f => stateOf(f).runs.at(-1);

function digestGateModule(match) {
  const vm = require('node:vm'), fs = require('node:fs'), crypto = require('node:crypto');
  const entered = deferred(), gate = deferred();
  let intercepted = false;
  const context = { module: { exports: {} }, console, TextEncoder, AbortController, crypto: { subtle: { digest: async (algorithm, bytes) => {
    if (!intercepted && match(new TextDecoder().decode(bytes))) { intercepted = true; entered.resolve(); await gate.promise; }
    return crypto.webcrypto.subtle.digest(algorithm, bytes);
  } } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/release-workspace.js'), 'utf8'), context);
  return { Module: context.module.exports.KTReleaseWorkspace, entered, gate };
}

test('相談と修正だけでは作成も反映も始めない。採用は別操作', async () => {
  const f = fresh();
  await f.controller.send(REQUEST);
  assert.equal(stateOf(f).phase, 'proposal');
  assert.equal(f.count('plan'), 0);
  await f.controller.send('一覧の名前は「確認待ち」に変えてください。');
  assert.equal(stateOf(f).phase, 'proposal');
  assert.equal(f.count('plan'), 0);
  assert.equal(f.count('generate'), 0);
  assert.equal(f.count('apply'), 0);
  assert.equal(f.writes.length, 0);
  await f.controller.adopt();
  assert.equal(f.count('plan'), 1);
  assert.equal(f.count('generate'), 2);
  assert.equal(stateOf(f).phase, 'review');
  assert.equal(f.writes.length, 0);
});

test('AIがadoptを返しても通常の送信からは書き込みの承認を作らない', async () => {
  const f = fresh({ propose: () => ({ ...proposal(), intent: 'adopt', adoptQuote: 'この内容で進めてください' }) });
  await f.controller.send('この内容で進めてください');
  assert.equal(f.count('apply'), 0);
  assert.equal(f.writes.length, 0);
});

test('未採用の代替案の手順と専用JavaScriptは作らず、主案でも使うJavaScriptは残す', async () => {
  const p = plan(), c1 = p.customizations[0], c2 = p.customizations[1];
  p.steps.find(s => s.id === 'C2').alternativeId = 'ALT_MOBILE';
  c2.questions = [{ question: '未採用の案だけの質問', blocking: true }];
  const c3 = { ...JSON.parse(JSON.stringify(c2)), customizationId: 'C3' };
  p.customizations.push(c3);
  p.steps.push({ ...JSON.parse(JSON.stringify(p.steps[0])), id: 'P_ALT', title: '未採用の別の一覧' },
    { id: 'C_ALT', actionType: 'CUSTOMIZATION_REQUIRED', spec: { customizationId: 'C3' } },
    { id: 'C_SHARED', actionType: 'CUSTOMIZATION_REQUIRED', spec: { customizationId: c1.customizationId } });
  p.alternatives = [{ id: 'ALT_OTHER', stepIds: ['P_ALT', 'C_ALT', 'C_SHARED'] }];
  const original = JSON.stringify(p), f = fresh({ plan: p });
  await built(f);
  assert.equal(stateOf(f).phase, 'review');
  assert.deepEqual(stateOf(f).plan.steps.map(s => s.id), ['P1', 'C1']);
  assert.deepEqual(stateOf(f).plan.customizations.map(c => c.customizationId), ['C1']);
  assert.deepEqual(f.calls.filter(c => c.method === 'generate').map(c => c.id), ['C1']);
  assert.equal(stateOf(f).plan.questions.length, 0);
  assert.equal(JSON.stringify(p), original);
  await f.controller.apply();
  assert.deepEqual(f.writes.filter(w => w.type === 'settings').map(w => w.stepId), ['P1']);
  assert.equal(f.writes.length, 2);
});

test('主案のJavaScriptに必要な質問があれば、内容を示して生成前で止まる', async () => {
  const p = plan();
  p.questions = [{ question: '一覧にはどの項目を出しますか？', blocking: true }];
  p.customizations[0].questions = [{ question: '編集を許可する担当者を指定してください。', blocking: true }];
  const f = fresh({ plan: p });
  await built(f);
  assert.equal(stateOf(f).phase, 'blocked');
  assert.equal(f.count('generate'), 0);
  assert.equal(f.count('prepare'), 0);
  const html = ordinary(KTReleaseView.render(stateOf(f)));
  assert.match(html, /一覧にはどの項目を出しますか/);
  assert.match(html, /編集を許可する担当者を指定してください/);
});

test('質問の回答は識別子だけでなく質問本文と組で計画と生成へ渡す', async () => {
  let proposed = 0, plannedAnswers = null, generatedAnswers = null;
  const question = { id: 'Q1', key: 'approver', label: '承認者', question: '今の承認者の指定を引き継いでよいですか？', blocking: true };
  const f = fresh({ propose: () => {
    const value = proposal();
    value.proposal.decisions = [question];
    if (proposed++) { value.proposalUnchanged = true; value.turn.answers = [{ id: 'Q1', text: '今の指定を引き継ぎます。', kind: 'user' }]; }
    return value;
  }, makePlan: args => { plannedAnswers = args.answers; return { plan: plan() }; }, generate: args => { generatedAnswers = args.answers; return generated(args.customization); } });
  await f.controller.send(REQUEST); await f.controller.adopt();
  assert.equal(f.count('plan'), 0);
  await f.controller.send('今の指定を引き継ぎます。');
  assert.equal(f.count('plan'), 0);
  await f.controller.adopt();
  assert.equal(stateOf(f).phase, 'review');
  for (const answers of [stateOf(f).answers, plannedAnswers, generatedAnswers]) {
    assert.equal(answers[0].question, question.question);
    assert.equal(answers[0].answer, '今の指定を引き継ぎます。');
  }
});

test('通常の一会話で最終確認に到達し、一度の承認で設定とPC・モバイルのJSを扱う', async () => {
  const f = fresh();
  await built(f);
  assert.equal(stateOf(f).phase, 'review');
  assert.equal(f.count('apply'), 0);
  assert.equal(f.writes.length, 0);
  await f.controller.apply();
  assert.equal(stateOf(f).phase, 'result');
  assert.equal(f.count('apply'), 1);
  assert.equal(f.writes.filter(w => w.type === 'settings').length, 1);
  assert.deepEqual(f.writes.filter(w => w.type === 'file').map(w => w.targetPlatform).sort(), ['desktop', 'mobile']);
  assert.equal(latestRun(f).status, 'complete');
  assert.ok(f.calls.findIndex(c => c.method === 'prepare') < f.calls.findIndex(c => c.method === 'apply'));
});

test('反映を連打しても同じ変更を二重に書かない', async () => {
  const gate = deferred();
  const f = fresh({ apply: async (args, { writes }) => { await gate.promise; writes.push({ type: 'settings' }); return { status: 'complete', settings: args.prepared.settings, files: args.prepared.files, written: 1, message: '反映しました。' }; } });
  await built(f);
  const first = f.controller.apply();
  await new Promise(resolve => setImmediate(resolve));
  const second = f.controller.apply();
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(f.count('apply'), 1);
  assert.equal(f.writes.length, 1);
  await f.controller.apply();
  assert.equal(f.count('apply'), 1);
});

test('確認後に動作テスト環境の基準が変われば書き込み前に止まる', async () => {
  const f = fresh();
  await built(f);
  f.bump();
  await f.controller.apply();
  assert.equal(f.count('apply'), 0);
  assert.equal(f.writes.length, 0);
  assert.notEqual(stateOf(f).phase, 'result');
  assert.match(ordinary(KTReleaseView.render(stateOf(f))), /変わ|変更|確認|取得/);
});

test('設定取得に権限がないときは作成済みの内容を消さずに反映を止める', async () => {
  let inaccessible = false;
  const f = fresh({ loadBase: async () => {
    if (inaccessible) throw Object.assign(new Error('動作テスト環境の設定を取得できません。'), { code: 'CB_NO02' });
    return { ok: true, current: {}, stamp: 'preview:1', inputs: { data: {} }, files: [] };
  } });
  await built(f);
  inaccessible = true;
  await f.controller.apply();
  assert.equal(f.count('apply'), 0);
  assert.equal(f.writes.length, 0);
  assert.ok(stateOf(f).plan);
  assert.ok(Object.keys(stateOf(f).artifacts || {}).length > 0);
});

test('検証済みの変更なしだけなら登録操作と承認を作らない', async () => {
  const f = fresh({ settings: false, generate: ({ customization }) => generated(customization, { action: 'unchanged' }) });
  await built(f);
  assert.equal(stateOf(f).phase, 'unchanged');
  await f.controller.apply();
  assert.equal(f.count('apply'), 0);
  assert.equal(f.writes.length, 0);
});

test('変更なしと未完成の混在を「変更不要」にしない', async () => {
  const f = fresh({ settings: false, generate: ({ customization }) => generated(customization, customization.platform[0] === 'desktop' ? { action: 'unchanged' } : { state: 'incomplete', message: 'モバイル用の内容を作成できませんでした。' }) });
  await built(f);
  assert.equal(stateOf(f).phase, 'incomplete');
  const text = ordinary(KTReleaseView.render(stateOf(f)));
  assert.doesNotMatch(text, /反映する変更はありません/);
  assert.match(text, /モバイル|作成|残り/);
  await f.controller.apply();
  assert.equal(f.count('apply'), 0);
});

test('残りの作成は完成済みPCを使い、未完成のモバイルだけを作る', async () => {
  let mobile = 0;
  const f = fresh({ generate: ({ customization }) => generated(customization, customization.platform[0] === 'mobile' && mobile++ === 0 ? { state: 'incomplete', message: '作成が終わりませんでした。' } : {}) });
  await built(f);
  assert.equal(stateOf(f).phase, 'incomplete');
  await f.controller.resume();
  assert.equal(stateOf(f).phase, 'review');
  assert.equal(f.calls.filter(c => c.method === 'generate' && c.id === 'C1').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'generate' && c.id === 'C2').length, 2);
  assert.equal(f.count('plan'), 1);
});

for (const outcome of ['unverified', 'failed']) test(`必須の検証が${outcome}なら、AIの肯定的な要約で承認可能にしない`, async () => {
  const f = fresh({ generate: ({ customization }) => ({ ...generated(customization, { state: outcome, message: '必要な確認を完了できませんでした。' }), summary: 'すべて正しく完成しました。', coverage: [{ requirementId: 'R1', status: 'MET' }] }) });
  await built(f);
  assert.notEqual(stateOf(f).phase, 'review');
  await f.controller.apply();
  assert.equal(f.count('apply'), 0);
  assert.equal(f.writes.length, 0);
});

test('確定した成果物の結果が無い応答を、旧機械検査の合格だけで受け入れない', async () => {
  const f = fresh({ generate: ({ customization }) => { const value = generated(customization); delete value.artifactOutcome; return value; } });
  await built(f);
  assert.notEqual(stateOf(f).phase, 'review');
  await f.controller.apply();
  assert.equal(f.count('apply'), 0);
});

test('検証された本文と違う本文を登録しない', async () => {
  const f = fresh({ generate: ({ customization }) => { const value = generated(customization); value.code += '\n// 検証後の差し替え'; value.body = value.code; return value; } });
  await built(f);
  await f.controller.apply();
  assert.equal(f.count('apply'), 0);
  assert.equal(f.writes.length, 0);
});

for (const [label, change] of [
  ['対象の識別子が無い', value => { delete value.artifactOutcome.scope; }],
  ['別の変更の検証結果', value => { value.artifactOutcome.scope.customizationId = 'OTHER'; }],
  ['検証の本文の印が違う', value => { value.verification.bodyHash = 'another-body'; }],
  ['登録内容の本文の印が違う', value => { value.artifactOutcome.operations[0].bodyHash = 'another-body'; }],
]) test(`${label}応答は承認対象にせず、書き込みの準備にも渡さない`, async () => {
  const f = fresh({ generate: ({ customization }) => { const value = generated(customization); change(value); return value; } });
  await built(f);
  assert.equal(stateOf(f).phase, 'incomplete');
  await f.controller.apply();
  assert.equal(f.count('prepare'), 0);
  assert.equal(f.count('apply'), 0);
  assert.equal(f.writes.length, 0);
});

test('設定だけ成功してJSが失敗した結果は、一部反映として履歴に残す', async () => {
  const f = fresh({ apply: async (args, { writes }) => { writes.push({ type: 'settings', stepId: 'P1' }); return { status: 'partial', settings: [{ stepId: 'P1', status: 'applied' }], files: [{ targetFile: 'approved-memo.js', status: 'failed' }], written: 1, message: '一覧を反映しました。JavaScriptは登録できませんでした。' }; } });
  await built(f);
  await f.controller.apply();
  assert.equal(stateOf(f).phase, 'result');
  assert.equal(latestRun(f).status, 'partial');
  assert.equal(f.writes.length, 1);
  assert.match(ordinary(KTReleaseView.render(stateOf(f))), /一覧|JavaScript|一部/);
  assert.doesNotMatch(ordinary(KTReleaseView.render(stateOf(f))), /すべて反映/);
});

test('送信後に通信が切れた結果不明を成功や変更なしに変えない', async () => {
  const f = fresh({ apply: async () => ({ status: 'unknown', settings: [], files: [], written: null, message: '反映の結果を確認できません。' }) });
  await built(f);
  await f.controller.apply();
  assert.equal(latestRun(f).status, 'unknown');
  await f.controller.apply();
  assert.equal(f.count('apply'), 1);
  assert.doesNotMatch(ordinary(KTReleaseView.render(stateOf(f))), /反映する変更はありません|反映しました。/);
});

test('復元は指定した実行記録を確認してから一度だけ行う', async () => {
  const f = fresh();
  await built(f);
  await f.controller.apply();
  const run = latestRun(f), runId = run.id;
  assert.ok(runId);
  await f.controller.requestRollback(runId);
  assert.equal(stateOf(f).phase, 'rollback-confirm');
  assert.equal(f.rollbackWrites.length, 0);
  await f.controller.rollback(runId);
  assert.deepEqual(f.rollbackWrites, [runId]);
  assert.equal(f.count('rollback'), 1);
  await f.controller.rollback(runId);
  assert.equal(f.count('rollback'), 1);
});

test('戻す確認の取消しは書き込まず、反映結果を残す', async () => {
  const f = fresh();
  await built(f); await f.controller.apply();
  const runId = latestRun(f).id;
  const writeCount = f.writes.length;
  await f.controller.requestRollback(runId);
  await f.controller.cancelRollback();
  assert.equal(stateOf(f).phase, 'result');
  assert.equal(latestRun(f).status, 'complete');
  assert.equal(f.writes.length, writeCount);
  assert.equal(f.rollbackWrites.length, 0);
});

test('反映後に別の変更があれば復元の確認で止まり、他人の変更を戻さない', async () => {
  const f = fresh({ prepareRollback: async () => ({ ok: false, reasons: ['反映後に設定が変更されています。'], signature: null }) });
  await built(f); await f.controller.apply();
  await f.controller.requestRollback(latestRun(f).id);
  await f.controller.rollback(latestRun(f).id);
  assert.equal(f.count('rollback'), 0);
  assert.equal(f.rollbackWrites.length, 0);
  assert.equal(latestRun(f).status, 'complete');
});

test('作成中の取消し後に届いた応答を、新しい依頼の成果物に混ぜない', async () => {
  const gate = deferred();
  const f = fresh({ makePlan: async () => { await gate.promise; return { plan: plan() }; } });
  await f.controller.send(REQUEST);
  const building = f.controller.adopt();
  await new Promise(resolve => setImmediate(resolve));
  f.controller.cancel();
  f.controller.newTask();
  gate.resolve();
  await building;
  assert.equal(stateOf(f).phase, 'idle');
  assert.equal(f.count('generate'), 0);
  assert.equal(f.count('apply'), 0);
});

test('修正相談を中断したら古い計画の再開ではなく未更新の仮案へ戻る', async () => {
  const entered = deferred(), gate = deferred(); let count = 0;
  const changed = proposal('一覧名を確認待ちへ変更しました。');
  changed.proposal.behaviors[0].text = '確認待ちの一覧を追加する';
  const f = fresh({ propose: async () => {
    count++;
    if (count === 1) return proposal();
    if (count === 2) { entered.resolve(); await gate.promise; }
    return changed;
  } });
  await built(f);
  const sending = f.controller.send('一覧の名前を確認待ちへ変更してください。');
  await entered.promise;
  assert.equal(await f.controller.apply(), false);
  f.controller.cancel(); gate.resolve(); await sending;
  assert.equal(stateOf(f).phase, 'proposal');
  assert.equal(stateOf(f).plan, null);
  assert.equal(stateOf(f).adopted, null);
  assert.equal(stateOf(f).prepared, null);
  assert.deepEqual(stateOf(f).artifacts, []);
  assert.equal(stateOf(f).version, 1, '遅れて届いた修正版を採用しない');
  assert.match(stateOf(f).error.message, /相談を中断.*案は更新していません/);
  assert.equal(await f.controller.resume(), false);
  assert.equal(await f.controller.apply(), false);
  assert.equal(f.count('plan'), 1); assert.equal(f.count('generate'), 2);
  assert.equal(f.writes.length, 0);
  await f.controller.send('一覧の名前を確認待ちへ変更してください。');
  assert.equal(f.count('plan'), 1, '修正送信だけで計画を作らない');
  await f.controller.adopt();
  assert.equal(f.count('plan'), 2);
  assert.equal(f.calls.filter(c => c.method === 'plan').at(-1).proposal.behaviors[0].text, '確認待ちの一覧を追加する');
  assert.equal(stateOf(f).phase, 'review');
  assert.equal(f.writes.length, 0);
});

test('生成の中断では完成したPCを残し、再開でモバイルだけを作る', async () => {
  const entered = deferred(), gate = deferred(); let mobile = 0;
  const f = fresh({ generate: async ({ customization }) => {
    if (customization.platform[0] === 'mobile' && mobile++ === 0) { entered.resolve(); await gate.promise; }
    return generated(customization);
  } });
  await f.controller.send(REQUEST);
  const building = f.controller.adopt(); await entered.promise;
  f.controller.cancel(); gate.resolve(); await building;
  assert.equal(stateOf(f).phase, 'incomplete');
  assert.equal(stateOf(f).artifacts.length, 1);
  assert.equal(stateOf(f).artifacts[0].customizationId, 'C1');
  await f.controller.resume();
  assert.equal(stateOf(f).phase, 'review');
  assert.equal(f.count('plan'), 1);
  assert.equal(f.calls.filter(c => c.method === 'generate' && c.id === 'C1').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'generate' && c.id === 'C2').length, 2);
  assert.equal(f.writes.length, 0);
});

test('計画の質問への相談を中断しても再送へ原文を渡し、成功後は解消する', async () => {
  const p = plan(); p.questions = [{ id: 'QP1', question: '一覧に表示する列はどれですか。', blocking: true }];
  const attempts = [], entered = [deferred(), deferred()], gates = [deferred(), deferred()];
  const f = fresh({ plan: p, propose: async args => {
    attempts.push(args);
    const index = attempts.length - 2;
    if (index >= 0 && index < gates.length) { entered[index].resolve(); await gates[index].promise; }
    return proposal();
  } });
  await built(f);
  for (let index = 0; index < gates.length; index++) {
    const sending = f.controller.send('備考を表示してください。'); await entered[index].promise;
    assert.deepEqual(attempts.at(-1).pendingPlanQuestions, p.questions);
    f.controller.cancel(); gates[index].resolve(); await sending;
    assert.equal(stateOf(f).plan, null);
    assert.equal(await f.controller.resume(), false);
    assert.equal(await f.controller.prepare(), false);
  }
  await f.controller.send('備考を表示してください。');
  assert.deepEqual(attempts.at(-1).pendingPlanQuestions, p.questions);
  assert.equal(attempts.at(-1).text, '備考を表示してください。');
  await f.controller.send('一覧の名前も確認待ちにしてください。');
  assert.deepEqual(attempts.at(-1).pendingPlanQuestions, []);
  assert.equal(f.count('plan'), 1);
  assert.equal(f.count('generate'), 0);
  assert.equal(f.writes.length, 0);
});

for (const next of ['newTask', 'adopt']) test(`中断した計画の質問を${next === 'newTask' ? '新しい会話' : '新しい採用'}へ持ち越さない`, async () => {
  const p = plan(); p.questions = [{ id: 'QP1', question: '一覧に表示する列はどれですか。', blocking: true }];
  const entered = deferred(), gate = deferred(), attempts = []; let planned = 0;
  const f = fresh({ makePlan: () => {
    if (planned++) throw new Error('新しい計画はまだ取得できません。');
    return { plan: p };
  }, propose: async args => {
    attempts.push(args);
    if (attempts.length === 2) { entered.resolve(); await gate.promise; }
    return proposal();
  } });
  await built(f);
  const sending = f.controller.send('備考を表示してください。'); await entered.promise;
  f.controller.cancel(); gate.resolve(); await sending;
  await f.controller[next]();
  await f.controller.send('次の案を相談します。');
  assert.deepEqual(attempts.at(-1).pendingPlanQuestions, []);
  assert.equal(stateOf(f).plan, null);
  assert.equal(f.writes.length, 0);
});

test('相談前の設定取得を待つ間に取り消したらAIへ送信しない', async () => {
  const gate = deferred();
  const f = fresh({ loadBase: async () => { await gate.promise; return { ok: true, current: {}, stamp: 'preview:1', inputs: { data: {} }, files: [] }; } });
  const sending = f.controller.send(REQUEST);
  await new Promise(resolve => setImmediate(resolve));
  f.controller.cancel();
  f.controller.newTask();
  gate.resolve();
  await sending;
  assert.equal(f.count('propose'), 0);
  assert.equal(stateOf(f).phase, 'idle');
});

test('採用後の設定取得を待つ間に取り消したら計画をAIへ送信しない', async () => {
  const gate = deferred();
  const f = fresh({ loadBase: async ({ reason }) => {
    if (reason === 'plan') await gate.promise;
    return { ok: true, current: {}, stamp: 'preview:1', inputs: { data: {} }, files: [] };
  } });
  await f.controller.send(REQUEST);
  const building = f.controller.adopt();
  await new Promise(resolve => setImmediate(resolve));
  f.controller.cancel();
  f.controller.newTask();
  gate.resolve();
  await building;
  assert.equal(f.count('plan'), 0);
  assert.equal(f.count('generate'), 0);
  assert.equal(stateOf(f).phase, 'idle');
});

for (const stage of ['artifact', 'preparation']) test(`${stage === 'artifact' ? '成果物の本文照合' : '承認内容の指紋作成'}を待つ間に取り消したら、遅れた結果を新しい作業へ混ぜない`, async () => {
  const held = digestGateModule(text => stage === 'artifact' ? text.startsWith('(function') : text.startsWith('{'));
  const f = fixture(held.Module, stage === 'preparation' ? { platforms: [] } : {});
  await f.controller.send(REQUEST);
  const building = f.controller.adopt();
  await held.entered.promise;
  f.controller.cancel(); f.controller.newTask();
  held.gate.resolve(); await building;
  assert.equal(stateOf(f).phase, 'idle');
  assert.equal(stateOf(f).prepared, null);
  assert.equal(stateOf(f).artifacts.length, 0);
  assert.equal(f.writes.length, 0);
});

test('復元内容の確認を待つ間に取り消したら、古い戻す確認を新しい作業へ出さない', async () => {
  const entered = deferred(), gate = deferred();
  const f = fresh({ prepareRollback: async run => { entered.resolve(); await gate.promise; return { ok: true, runId: run.id, reasons: [] }; } });
  await built(f); await f.controller.apply();
  const checking = f.controller.requestRollback(latestRun(f).id);
  await entered.promise;
  f.controller.cancel(); f.controller.newTask();
  gate.resolve(); await checking;
  assert.equal(stateOf(f).phase, 'idle');
  assert.equal(stateOf(f).rollback, null);
  assert.equal(f.rollbackWrites.length, 0);
  assert.equal(latestRun(f).status, 'complete');
});

test('未完成の成果物がある間は準備のやり直しでも承認へ進めない', async () => {
  const f = fresh({ generate: ({ customization }) => generated(customization, customization.platform[0] === 'mobile' ? { state: 'incomplete', message: 'モバイル用は未完成です。' } : {}) });
  await built(f);
  assert.equal(stateOf(f).phase, 'incomplete');
  await f.controller.prepare();
  await f.controller.apply();
  assert.equal(f.count('apply'), 0);
  assert.equal(f.writes.length, 0);
  assert.notEqual(stateOf(f).phase, 'review');
});

test('通常表示は一つの主操作を持ち、費用・内部検査・担当推定を出さない', async () => {
  const f = fresh();
  await built(f);
  const html = KTReleaseView.render(stateOf(f));
  const text = ordinary(html);
  assert.match(text, /動作テスト環境/);
  assert.match(text, /一覧|備考/);
  assert.doesNotMatch(text, /米ドル|トークン|token|costUsd|0\.019|0\.022|確保額|var\s*はありません|担当が計画に/);
  assert.doesNotMatch(html, /kt-ai-pane-(review|code|exec)|kt-ai-workspace-right/);
});

test('AIが返した説明はHTMLとして実行しない', async () => {
  const f = fresh({ propose: () => proposal('<img src=x onerror="alert(1)">') });
  await f.controller.send(REQUEST);
  const html = KTReleaseView.render(stateOf(f));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});

test('利用上限で止まったときも原価を通常表示へ出さず、作成済み内容を残す', async () => {
  const f = fresh({ generate: ({ customization }) => {
    if (customization.platform[0] === 'mobile') throw Object.assign(new Error('Cost limit 0.80 USD'), { code: 'BUDGET_EXCEEDED', details: { costUsd: 0.80 } });
    return generated(customization);
  } });
  await built(f);
  assert.equal(stateOf(f).phase, 'incomplete');
  assert.equal(stateOf(f).artifacts.filter(a => a.result?.artifactOutcome?.state === 'ready').length, 1);
  const shown = ordinary(KTReleaseView.render(stateOf(f)));
  assert.match(shown, /利用上限/);
  assert.doesNotMatch(shown, /USD|0\.80|Cost limit/);
  assert.equal(f.writes.length, 0);
});
