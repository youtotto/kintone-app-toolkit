'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { KTReleaseWorkspace: Workspace } = require('../src/release-workspace.js');
const { fixture, REQUEST, plan, generated, deferred } = require('./helpers/release-workspace-fixture.js');
const state = f => f.controller.getState();
const build = async f => { await f.controller.send(REQUEST); await f.controller.adopt(); };
const aiCounts = f => ['propose','plan','generate'].map(method => f.count(method));

test('設定変更後は同じ案と検証済みコードで無料再準備し、新しい確認を経てだけ反映する', async () => {
  const f = fixture(Workspace);
  await build(f);
  const before = state(f), counts = aiCounts(f);
  f.bump(); await f.controller.apply();
  assert.equal(state(f).error.code, 'BASE_CHANGED');
  assert.equal(f.writes.length, 0);
  assert.equal(Workspace.canReprepare(state(f)), true);
  assert.equal(await f.controller.reprepare(), true);
  const after = state(f);
  assert.equal(after.phase, 'review');
  assert.deepEqual(after.plan, before.plan);
  assert.deepEqual(after.artifacts, before.artifacts);
  assert.deepEqual(aiCounts(f), counts);
  assert.notEqual(after.prepared.signature, before.prepared.signature);
  assert.equal(after.prepared.baseStamp, 'preview:2');
  assert.equal(f.writes.length, 0); assert.equal(after.runs.length, 0);
  await f.controller.apply();
  assert.equal(f.count('apply'), 1); assert.equal(state(f).phase, 'result');
});

test('再準備で変わった確認事項を新しい確認画面へ残し、古い承認で進めない', async () => {
  const f = fixture(Workspace); await build(f);
  const prepare = f.execution.prepare;
  f.execution.prepare = async args => ({ ...await prepare(args), confirmations: [{key:'changed',message:'既存の一覧を変更します。'}] });
  await f.controller.apply();
  assert.equal(state(f).error.code, 'APPROVAL_CHANGED');
  const counts = aiCounts(f);
  await f.controller.reprepare();
  assert.equal(state(f).phase, 'review');
  assert.deepEqual(state(f).prepared.confirmations, [{key:'changed',message:'既存の一覧を変更します。'}]);
  assert.equal(f.writes.length, 0); assert.deepEqual(aiCounts(f), counts);
});

test('登録先や依存する設定が変わり再準備が止まる場合、同じ案を強制反映しない', async () => {
  const f = fixture(Workspace); await build(f); f.bump(); await f.controller.apply();
  f.execution.prepare = async () => ({ok:false,changes:[],confirmations:[],reasons:[{code:'FILE_TARGET_CHANGED',message:'対象ファイルが変更されました。'}]});
  const counts = aiCounts(f); await f.controller.reprepare();
  assert.equal(state(f).phase, 'blocked');
  assert.equal(state(f).prepared.reasons[0].code, 'FILE_TARGET_CHANGED');
  assert.equal(await f.controller.apply(), false);
  assert.deepEqual(aiCounts(f), counts); assert.equal(f.writes.length, 0);
});

test('未完成・未回答・反映済みの案は無料再準備で承認可に変えない', async () => {
  const incomplete = fixture(Workspace,{generate:c=>generated(c.customization,{state:'unverified'})});
  await build(incomplete); assert.equal(await incomplete.controller.reprepare(),false);
  const p=plan(); p.questions=[{question:'対象を指定してください',blocking:true}];
  const questions=fixture(Workspace,{plan:p}); await build(questions); assert.equal(await questions.controller.reprepare(),false);
  const f=fixture(Workspace); await build(f); await f.controller.apply();
  assert.equal(await f.controller.reprepare(),false);
  assert.equal(Workspace.canReprepare({...state(f),phase:'blocked',error:{code:'BASE_CHANGED'}}),false);
});

test('設定取得の失敗後も、AIを呼ばず取得と準備を再実行できる', async () => {
  let fail=false;
  const f=fixture(Workspace,{loadBase:()=>{if(fail)throw Object.assign(new Error('設定を取得できません'),{code:'BASE_UNAVAILABLE'});return {ok:true,stamp:'same'};}});
  await build(f); fail=true; await f.controller.apply();
  assert.equal(Workspace.canReprepare(state(f)),true); const counts=aiCounts(f);
  fail=false; await f.controller.reprepare(); assert.equal(state(f).phase,'review');
  assert.deepEqual(aiCounts(f),counts); assert.equal(f.writes.length,0);
});

test('無料再準備中は二重操作を受けず、中断した結果で次の会話を上書きしない', async () => {
  const f=fixture(Workspace); await build(f); f.bump(); await f.controller.apply();
  const gate=deferred(), entered=deferred(), prepare=f.execution.prepare;
  f.execution.prepare=async args=>{entered.resolve();await gate.promise;return prepare(args);};
  const work=f.controller.reprepare();await entered.promise;
  assert.equal(await f.controller.reprepare(),false);assert.equal(await f.controller.apply(),false);
  assert.equal(f.controller.cancel(),true);assert.equal(f.controller.newTask(),true);
  await f.controller.send('新しい依頼'); const current=state(f);
  gate.resolve();await work;assert.deepEqual(state(f),current);assert.equal(f.writes.length,0);
});

async function unknownRollback() {
  const f=fixture(Workspace,{rollback:async()=>({status:'unknown',message:'復元結果が分かりません',files:{marker:'keep'}})});
  await build(f);await f.controller.apply();const id=state(f).runs[0].id;
  await f.controller.requestRollback(id);await f.controller.rollback(id);
  return {f,id};
}

test('復元結果の読み取りで完了を確認しても、復元・反映・AIを追加実行しない',async()=>{
  const {f,id}=await unknownRollback(), counts=aiCounts(f), writes=f.writes.length;
  let reads=0;
  f.execution.recheckRollback=async run=>{reads++;assert.equal(run.id,id);run.goal='写しだけの変更';return {status:'complete',recoveryState:'restored',message:'元に戻っていることを確認しました。'};};
  assert.equal(await f.controller.recheckRollback(id),true);
  assert.equal(state(f).phase,'result');assert.equal(state(f).runs[0].rollback.status,'complete');
  assert.notEqual(state(f).runs[0].goal,'写しだけの変更');assert.equal(reads,1);
  assert.deepEqual(aiCounts(f),counts);assert.equal(f.writes.length,writes);assert.equal(f.count('rollback'),1);
  assert.equal(await f.controller.requestRollback(id),false);assert.equal(await f.controller.recheckRollback(id),false);
});

test('復元が未実施と分かっても再実行せず、改めて復元前の確認を必要とする',async()=>{
  const {f,id}=await unknownRollback();
  f.execution.recheckRollback=async()=>({status:'failed',retryable:true,recoveryState:'applied',message:'反映後のままでした。'});
  await f.controller.recheckRollback(id);assert.equal(f.count('rollback'),1);
  assert.equal(await f.controller.rollback(id),false);
  await f.controller.requestRollback(id);assert.equal(state(f).phase,'rollback-confirm');
  assert.equal(f.count('rollback'),1);
});

test('復元結果の取得失敗では、既に戻した部分の記録を失わず不明のままにする',async()=>{
  const {f,id}=await unknownRollback();f.execution.recheckRollback=async()=>{throw new Error('読み取り失敗');};
  await f.controller.recheckRollback(id);
  assert.equal(state(f).runs[0].rollback.status,'unknown');
  assert.deepEqual(state(f).runs[0].rollback.files,{marker:'keep'});
  assert.equal(f.count('rollback'),1);
});

test('復元結果の確認中は同じ確認・反映・新会話を開始しない',async()=>{
  const {f,id}=await unknownRollback(),gate=deferred(),entered=deferred();
  f.execution.recheckRollback=async()=>{entered.resolve();return gate.promise;};
  const work=f.controller.recheckRollback(id);await entered.promise;
  assert.equal(state(f).phase,'checking-result');
  assert.equal(await f.controller.recheckRollback(id),false);assert.equal(await f.controller.apply(),false);
  assert.equal(await f.controller.send('別の依頼'),false);assert.equal(f.controller.newTask(),false);
  gate.resolve({status:'unknown',message:'まだ確認できません。'});await work;
  assert.equal(state(f).phase,'result');assert.equal(f.count('rollback'),1);
});
