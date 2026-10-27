'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTReleaseWorkspace: Workspace } = require('../src/release-workspace.js');
const { fixture, proposal, REQUEST, deferred } = require('./helpers/release-workspace-fixture.js');
const DOCUMENT = { requestPurpose: 'document' };
const explanation = () => ({ reply: '資料を作成しました。', intent: 'question', proposalUnchanged: true,
  explanation: { title: '引継ぎ資料', sections: [{ heading: '変更内容', paragraphs: ['一覧と編集制御を追加する案です。まだ反映していません。'], items: [], table: null, evidenceIds: [] }], unknowns: [] },
  turn: { ops: [], answers: [], requirementOps: [] }, facts: [] });
const work = s => ({ phase: s.phase, goal: s.goal, version: s.version, proposal: s.proposal, proposalPending: s.proposalPending,
  questionIdFloor: s.questionIdFloor, answers: s.answers, adopted: s.adopted, plan: s.plan, artifacts: s.artifacts,
  prepared: s.prepared, runs: s.runs, resultRunId: s.resultRunId, rollback: s.rollback });
function scenario(options = {}) {
  let response = proposal(), input;
  const f = fixture(Workspace, { ...options, propose: async args => { input = args; return typeof response === 'function' ? response(args) : response; } });
  return { ...f, respond: value => { response = value; }, input: () => input, state: () => f.controller.getState() };
}
async function built(f) { await f.controller.send(REQUEST); await f.controller.adopt(); }

test('明示した資料作成は採用内容と準備を維持し、同じ会話の説明を1件だけ増やす', async () => {
  const f = scenario(); await built(f); const before = work(f.state()), prepares = f.count('prepare');
  f.respond(explanation()); assert.equal(await f.controller.send('引継ぎ資料にまとめて', DOCUMENT), true);
  assert.deepEqual(work(f.state()), before); assert.equal(f.state().explanations.length, 1);
  assert.deepEqual(f.input().acceptedProposal, before.adopted); assert.equal(f.input().discussion.length, 2);
  assert.equal(f.state().messages.at(-1).explanationId, f.state().explanationId);
  assert.equal(f.count('propose'), 2); assert.equal(f.count('plan'), 1); assert.equal(f.count('prepare'), prepares);
  assert.equal(f.count('apply'), 0); assert.equal(f.writes.length, 0);
});

test('資料の用途を送信に引き継ぎ、続く自由文の修正も変更案を変えずに資料として扱う', async () => {
  const { KTReleaseContext: Context } = require('../src/release-context.js');
  const f = scenario(); await built(f); const before = work(f.state());
  assert.equal(f.input().requestPurpose, 'consultation');
  f.respond(explanation()); await f.controller.send('引継ぎ資料にまとめて', DOCUMENT);
  assert.equal(f.state().requestPurpose, 'document');
  await f.controller.send('その見出しを短くして');
  assert.equal(f.input().requestPurpose, 'document');
  assert.equal(Context.proposal(f.input()).requestPurpose, 'document');
  assert.deepEqual(work(f.state()), before);
  assert.equal(f.state().explanations.length, 2); assert.equal(f.count('plan'), 1); assert.equal(f.writes.length, 0);
  const count = f.count('propose');
  f.controller.showChanges(); f.controller.showExplanation(f.state().explanations[0].id);
  assert.equal(f.state().requestPurpose, 'document'); assert.equal(f.count('propose'), count);
  assert.equal(f.controller.setRequestPurpose('consultation'), true);
  f.controller.showChanges(); f.controller.showExplanation(f.state().explanations[0].id);
  assert.equal(f.state().requestPurpose, 'consultation'); assert.equal(f.count('propose'), count);
  f.respond(proposal()); await f.controller.send('一覧は取り消してください');
  assert.equal(f.input().requestPurpose, 'consultation'); assert.equal(Context.proposal(f.input()).requestPurpose, 'consultation');
});

test('用途の選択はAIを呼ばず、新しい会話や対象からの相談は相談用途に戻る', async () => {
  const f = scenario();
  assert.equal(f.controller.setRequestPurpose('document'), true);
  assert.equal(f.controller.setRequestPurpose('unknown'), false);
  assert.equal(await f.controller.send('不正な用途', { requestPurpose: 'unknown' }), false);
  assert.equal(f.count('propose'), 0); assert.equal(f.state().messages.length, 0);
  assert.equal(f.controller.setConsultationTarget({ name: 'sample.js', target: 'desktop', type: 'FILE', environment: 'preview' }), true);
  assert.equal(f.state().requestPurpose, 'consultation'); assert.equal(f.count('propose'), 0);
  f.controller.setRequestPurpose('document'); f.controller.newTask();
  assert.equal(f.state().requestPurpose, 'consultation'); assert.equal(f.count('propose'), 0);
});

test('資料用途からでも選択した追加提案の更新は相談として送る', async () => {
  const f = scenario(), p = proposal();
  p.proposal.behaviors.push({ id: 'B3', text: '期限順の一覧を追加する', origin: 'suggestion' });
  f.respond(p); await f.controller.send(REQUEST);
  const reference = { taskId: f.state().taskId, version: f.state().version };
  f.controller.selectSuggestion('B3', true, reference); f.controller.setRequestPurpose('document');
  f.respond(proposal()); assert.equal(await f.controller.updateSuggestions(reference), true);
  assert.equal(f.input().requestPurpose, 'consultation'); assert.equal(f.state().requestPurpose, 'consultation');
  assert.match(f.input().text, /期限順の一覧/); assert.equal(f.count('plan'), 0);
});

for (const code of ['NETWORK_ERROR', 'MODEL_OUTPUT_INVALID']) test(`資料作成が${code}でも採用済み案を失わず、失敗を表示する`, async () => {
  const f = scenario(); await built(f); const before = work(f.state());
  f.respond(() => { throw Object.assign(new Error('応答を取得できません。'), { code }); });
  assert.equal(await f.controller.send('仕様書を作って', DOCUMENT), false);
  assert.deepEqual(work(f.state()), before); assert.equal(f.state().explanations.length, 0);
  assert.equal(f.state().error.code, code); assert.match(f.state().error.message, /資料を作成できませんでした/);
  assert.equal(f.state().messages.at(-1).role, 'user'); assert.equal(f.writes.length, 0);
  f.respond(explanation()); assert.equal(await f.controller.send('もう一度資料を作って', DOCUMENT), true);
  assert.deepEqual(work(f.state()), before); assert.equal(f.state().error, null);
});

for (const [name, response] of [
  ['通常の提案', () => proposal('別の一覧を追加します。')],
  ['本文のない返答', () => ({ reply: '分かりました。', intent: 'question', proposalUnchanged: true })],
  ['空の説明', () => ({ ...explanation(), explanation: { title: '資料', sections: [], unknowns: [] } })],
  ['変更なしの印がない説明', () => ({ ...explanation(), proposalUnchanged: false })]
]) test(`資料専用の${name}は採用せず、空の成功にもせず元の計画を残す`, async () => {
  const f = scenario(); await built(f); const before = work(f.state()); f.respond(response());
  assert.equal(await f.controller.send('資料を作って', DOCUMENT), false);
  assert.deepEqual(work(f.state()), before); assert.equal(f.state().explanations.length, 0);
  assert.equal(f.state().error.code, 'DOCUMENT_RESPONSE_INVALID'); assert.equal(f.state().messages.at(-1).role, 'user');
  assert.equal(f.count('plan'), 1); assert.equal(f.count('apply'), 0);
});

test('資料の中断は元の案を保持し、遅い応答が次の相談を上書きしない', async () => {
  const f = scenario(); await built(f); const before = work(f.state()), gate = deferred(); f.respond(() => gate.promise);
  const pending = f.controller.send('資料を作って', DOCUMENT); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state().phase, 'consulting'); assert.equal(await f.controller.apply(), false);
  assert.equal(f.controller.setRequestPurpose('consultation'), false); assert.equal(f.state().requestPurpose, 'document');
  assert.equal(await f.controller.send('二重送信', DOCUMENT), false); assert.equal(f.count('propose'), 2);
  assert.equal(f.controller.cancel(), true); assert.deepEqual(work(f.state()), before); assert.equal(f.state().error.code, 'CANCELLED');
  f.controller.newTask(); f.respond(proposal('新しい相談の案です。')); await f.controller.send('別の相談');
  const next = f.state(); gate.resolve(explanation()); assert.equal(await pending, false);
  assert.deepEqual(f.state(), next); assert.equal(f.state().explanations.length, 0);
});

test('中断した資料の終了処理が、新しい資料の中断処理を消さない', async () => {
  const f = scenario(); await built(f); const before = work(f.state());
  const first = deferred(), second = deferred(); f.respond(() => first.promise);
  const oldPending = f.controller.send('最初の資料', DOCUMENT); await new Promise(resolve => setImmediate(resolve)); f.controller.cancel();
  f.respond(() => second.promise);
  const nextPending = f.controller.send('次の資料', DOCUMENT); await new Promise(resolve => setImmediate(resolve));
  first.resolve(explanation()); assert.equal(await oldPending, false); assert.equal(f.state().phase, 'consulting');
  assert.equal(f.controller.cancel(), true); assert.deepEqual(work(f.state()), before);
  second.resolve(explanation()); assert.equal(await nextPending, false); assert.equal(f.state().explanations.length, 0);
});

test('資料だけの新しい会話は業務要件や採用案を作らず、通常の変更相談に続けられる', async () => {
  const f = scenario(); f.respond(explanation()); assert.equal(await f.controller.send('概要資料を作って', DOCUMENT), true);
  assert.equal(f.state().phase, 'idle'); assert.equal(f.state().goal, ''); assert.equal(f.state().proposal, null); assert.equal(f.state().adopted, null);
  assert.equal(f.state().explanations.length, 1); assert.equal(f.count('plan'), 0); assert.equal(f.count('prepare'), 0);
  f.controller.setRequestPurpose('consultation');
  f.respond(proposal()); await f.controller.send(REQUEST); assert.equal(f.state().goal, REQUEST); assert.equal(f.state().phase, 'proposal');
  assert.equal(f.state().explanations.length, 1); assert.equal(f.state().explanationId, null);
});

for (const outcome of ['success', 'failure', 'cancel']) test(`資料の${outcome}でも取得済みの設定変更を見逃さず、古い準備に戻さない`, async () => {
  const f = scenario(); await built(f); const old = f.state(); f.bump();
  let gate;
  if (outcome === 'success') f.respond(explanation());
  else if (outcome === 'failure') f.respond(() => { throw new Error('通信失敗'); });
  else { gate = deferred(); f.respond(() => gate.promise); }
  const pending = f.controller.send('資料を作って', DOCUMENT);
  if (gate) { await new Promise(resolve => setImmediate(resolve)); f.controller.cancel(); gate.resolve(explanation()); }
  await pending;
  assert.deepEqual(f.state().plan, old.plan); assert.deepEqual(f.state().adopted, old.adopted);
  assert.equal(f.state().phase, 'blocked'); assert.equal(f.state().prepared, null); assert.equal(f.state().error.code, 'BASE_CHANGED');
  assert.equal(await f.controller.apply(), false); await f.controller.prepare();
  assert.equal(f.state().error.code, 'BASE_CHANGED'); assert.equal(f.state().prepared, null); assert.equal(f.writes.length, 0);
});

test('通常の修正が失敗した後は、資料成功でも古い案の採用を許可しない', async () => {
  const f = scenario(); await built(f); f.respond(() => { throw new Error('通信失敗'); }); await f.controller.send('一覧を取り消して');
  const before = work(f.state()); assert.equal(before.proposalPending, true); assert.equal(before.plan, null);
  f.respond(explanation()); assert.equal(await f.controller.send('状況を資料にまとめて', DOCUMENT), true);
  assert.deepEqual(work(f.state()), before); assert.equal(await f.controller.adopt(), false); assert.equal(await f.controller.apply(), false);
});

test('資料の設定取得失敗は案と準備を消さず、空の資料も作らない', async () => {
  let fail = false;
  const f = scenario({ loadBase: ({ revision }) => fail ? { ok: false, message: '設定を取得できません。' } : { ok: true, stamp: 'preview:' + revision } });
  await built(f); const before = work(f.state()); fail = true;
  assert.equal(await f.controller.send('仕様書を作って', DOCUMENT), false);
  assert.deepEqual(work(f.state()), before); assert.equal(f.state().error.code, 'BASE_UNAVAILABLE');
  assert.equal(f.count('propose'), 1); assert.equal(f.state().explanations.length, 0);
});

test('既存の復元確認と実行結果は資料だけでは変更せず、書き込みもしない', async () => {
  const f = scenario(); await built(f); await f.controller.apply(); await f.controller.requestRollback(f.state().resultRunId);
  const before = work(f.state()), writes = f.writes.length; f.respond(explanation());
  assert.equal(await f.controller.send('反映結果をまとめて', DOCUMENT), true);
  assert.deepEqual(work(f.state()), before); assert.equal(f.writes.length, writes); assert.equal(f.rollbackWrites.length, 0);
});
