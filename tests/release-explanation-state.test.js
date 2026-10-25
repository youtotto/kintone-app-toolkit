'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTReleaseWorkspace: W } = require('../src/release-workspace.js');
const { KTReleaseContext: C } = require('../src/release-context.js');
const { fixture, proposal, REQUEST, deferred } = require('./helpers/release-workspace-fixture.js');
const body = () => ({ title: 'アプリの概要', sections: [{ heading: '承認の流れ', paragraphs: ['現在の設定には承認待ちがあります。'], items: [], table: null, evidenceIds: ['E1'] }], unknowns: ['実際の運用手順は設定だけでは分かりません。'] });
const answer = () => ({ reply: '現在の設定を説明しました。', intent: 'question', proposalUnchanged: true, explanation: body(), turn: { ops: [], answers: [], requirementOps: [] }, facts: [{ id: 'E1', statement: '動作テスト環境の設定', value: { revision: 1 } }] });
function scenario() {
  let response = proposal(), input;
  const f = fixture(W, { propose: async args => { input = args; return typeof response === 'function' ? response(args) : response; } });
  return { ...f, respond: value => { response = value; }, input: () => input, state: () => f.controller.getState() };
}
async function built(f) { await f.controller.send(REQUEST); await f.controller.adopt(); }
const work = s => ({ phase:s.phase, version:s.version, proposal:s.proposal, adopted:s.adopted, answers:s.answers, plan:s.plan, artifacts:s.artifacts, prepared:s.prepared, error:s.error });

test('概要の質問1回は説明だけ。作成・準備・反映も業務の依頼としてのgoalも作らない', async () => {
  const f=scenario(); f.respond(answer()); await f.controller.send('このアプリの概要を教えて');
  const s=f.state(); assert.equal(s.phase,'idle'); assert.equal(s.proposal,null); assert.equal(s.goal,''); assert.equal(s.version,0);
  assert.equal(s.explanations.length,1); assert.equal(s.explanationId,s.explanations[0].id); assert.deepEqual(s.explanations[0].sections,body().sections);
  assert.equal(f.count('propose'),1); for(const m of ['plan','generate','prepare','apply'])assert.equal(f.count(m),0);
  assert.equal(await f.controller.adopt(),false); assert.equal(await f.controller.apply(),false); assert.equal(f.writes.length,0);
});

test('説明の後の資料作成に本文と会話が届く。以前の説明は変えない', async () => {
  const f=scenario(); f.respond(answer()); await f.controller.send('概要を教えて');
  const first=f.state().explanations[0]; const next=answer(); next.explanation.title='引継ぎ資料'; f.respond(next);
  await f.controller.send('その説明を引継ぎ資料にまとめて');
  assert.deepEqual(f.input().discussion.map(m=>m.role),['user','assistant']);
  assert.deepEqual(f.input().discussion[1].explanation,body());
  assert.deepEqual(f.state().explanations[0],first); assert.equal(f.state().explanations[1].title,'引継ぎ資料'); assert.equal(f.count('propose'),2);
  assert.equal(f.controller.showExplanation(first.id),true); assert.equal(f.state().explanationId,first.id);
  assert.equal(f.controller.showExplanation('missing'),false); f.controller.showChanges(); assert.equal(f.state().explanationId,null);
});

test('仮案への質問では版・回答・採用対象を変えない', async () => {
  const f=scenario(); await f.controller.send(REQUEST); const before=work(f.state()); f.respond(answer()); await f.controller.send('この案の意味を教えて');
  assert.deepEqual(work(f.state()),before); assert.equal(f.count('plan'),0); assert.equal(f.state().proposalPending,false);
});

test('反映前の案への質問では確認内容・検証済みコードを保持し、保存可能な説明を追加するだけ', async () => {
  const f=scenario(); await built(f); const before=work(f.state()), prepares=f.count('prepare'); f.respond(answer()); await f.controller.send('この変更を説明して');
  assert.deepEqual(work(f.state()),before); assert.deepEqual(f.input().acceptedProposal,before.adopted);
  assert.equal(JSON.parse(f.input().currentPlanSummary).steps.length,before.plan.steps.length); assert.equal(f.count('prepare'),prepares); assert.equal(f.writes.length,0);
});

test('説明待ちでは旧案への操作を止め、非変更応答後だけ同じ確認へ戻せる', async () => {
  const f=scenario(); await built(f); const before=work(f.state()), gate=deferred(); f.respond(()=>gate.promise);
  const running=f.controller.send('この変更を説明して'); await new Promise(r=>setImmediate(r));
  assert.equal(f.state().phase,'consulting'); assert.equal(await f.controller.apply(),false); assert.equal(await f.controller.adopt(),false);
  gate.resolve(answer()); await running; assert.deepEqual(work(f.state()),before);
});

test('説明の間に設定が変われば案を保持しても反映できず、最新基準にすり替えない', async () => {
  const f=scenario(); await built(f); const plan=f.state().plan; f.bump(); f.respond(answer()); await f.controller.send('この変更を説明して');
  assert.deepEqual(f.state().plan,plan); assert.equal(f.state().phase,'blocked'); assert.equal(f.state().prepared,null); assert.equal(f.state().error.code,'BASE_CHANGED');
  assert.equal(await f.controller.apply(),false); assert.equal(f.writes.length,0);
  await f.controller.prepare(); assert.equal(f.state().error.code,'BASE_CHANGED'); assert.equal(f.state().prepared,null);
});

test('修正が失敗した後の説明では古い案を再び作成可能にしない', async () => {
  const f=scenario(); await built(f); f.respond(()=>{throw Object.assign(Error('不正な応答'),{code:'MODEL_OUTPUT_INVALID'});});
  await f.controller.send('一部を取り消して'); assert.equal(f.state().proposalPending,true); assert.equal(f.state().plan,null);
  f.respond(answer()); await f.controller.send('なぜ止まったか教えて'); assert.equal(f.state().proposalPending,true); assert.equal(f.state().plan,null);
  assert.equal(await f.controller.adopt(),false); assert.equal(await f.controller.apply(),false);
});

test('中断後に遅れて届く説明は採用しない。以前の反映準備も復活しない', async () => {
  const f=scenario(); await built(f); const gate=deferred(); f.respond(()=>gate.promise);
  const running=f.controller.send('説明をお願い'); await new Promise(r=>setImmediate(r)); f.controller.cancel(); gate.resolve(answer()); await running;
  assert.equal(f.state().explanations.length,0); assert.equal(f.state().plan,null); assert.equal(f.state().prepared,null); assert.equal(f.state().proposalPending,true);
});

test('説明に続く変更はAIの通常の提案として受け、明示的な作成まで計画を開始しない', async () => {
  const f=scenario(); f.respond(answer()); await f.controller.send('概要を教えて'); f.respond(proposal()); await f.controller.send(REQUEST);
  assert.equal(f.state().goal,REQUEST); assert.equal(f.state().explanationId,null); assert.equal(f.state().explanations.length,1);
  assert.equal(f.state().phase,'proposal'); assert.equal(f.count('plan'),0); await f.controller.adopt(); assert.equal(f.count('plan'),1);
});

test('反映結果への質問は反映済みと採用内容を資料へ渡し、再反映や復元をしない', async () => {
  const f=scenario(); await built(f); await f.controller.apply(); const before=f.state(); const writes=f.writes.length; f.bump();
  f.respond(answer()); await f.controller.send('今回の変更を引継ぎ資料にして');
  assert.deepEqual(f.state().runs,before.runs); assert.equal(f.state().phase,'result'); assert.equal(f.writes.length,writes); assert.equal(f.rollbackWrites.length,0);
  assert.equal(JSON.parse(f.input().currentResultSummary).status,'complete'); assert.deepEqual(f.input().acceptedProposal,before.adopted);
});

test('新しい相談では説明・根拠・履歴のAIへの引継ぎを消す', async () => {
  const f=scenario(); f.respond(answer()); await f.controller.send('概要を教えて'); f.controller.newTask();
  assert.equal(f.state().explanations.length,0); assert.equal(f.state().explanationId,null); await f.controller.send('別の相談'); assert.deepEqual(f.input().discussion,[]);
});

test('AIへ渡す説明材料は現在の全設定・コードと会話。取得していない内容は推定しない', () => {
  const base={appId:'test',revision:2,data:{fields:{memo:{code:'memo',type:'MULTI_LINE_TEXT',label:'備考'}},status:{states:{draft:{name:'作成中'}}}},files:[{name:'lock.js',type:'FILE',target:'desktop',text:'/* source */'},{name:'missing.js',sourceAvailable:false}]};
  const discussion=[{role:'assistant',text:'説明です',explanation:body()}], acceptedProposal=proposal().proposal;
  const ctx=C.proposal({text:'資料にまとめて',base,discussion,acceptedProposal,currentPlanSummary:'計画',currentResultSummary:'未反映'});
  assert.ok(ctx.clientCapabilities.includes('appExplanation')); assert.deepEqual(ctx.conversation.discussion,discussion);
  assert.deepEqual(ctx.conversation.acceptedProposal,acceptedProposal); assert.equal(ctx.conversation.currentResultSummary,'未反映');
  assert.equal(ctx.facts.find(f=>f.value?.name==='lock.js').value.source,'/* source */'); assert.equal(ctx.facts.find(f=>f.value?.name==='missing.js').confidence,'NOT_ANALYZED');
  discussion[0].text='changed'; assert.equal(ctx.conversation.discussion[0].text,'説明です'); assert.equal(ctx.coverage.recordData,false);
});

test('一部反映の説明には手順ごとの成功/失敗を渡し、追加反映しない', async () => {
 let input;const rows=[{title:'一覧の追加',status:'VERIFIED',message:'反映済み'},{title:'モバイルの登録',status:'FAILED',message:'登録できません'}];
 const f=fixture(W,{propose:args=>{input=args;return args.previous?answer():proposal();},apply:async()=>({status:'partial',written:true,message:'一部を反映しました',rows,reasons:[{code:'TEST',message:'登録を中止しました'}]})});
 await f.controller.send(REQUEST);await f.controller.adopt();await f.controller.apply();f.bump();await f.controller.send('何が反映されたか資料にまとめて');
 const summary=JSON.parse(input.currentResultSummary);assert.deepEqual(summary.rows,rows);assert.equal(summary.status,'partial');assert.equal(summary.reasons[0].code,'TEST');assert.ok(summary.plannedChanges.length);
 assert.equal(f.controller.getState().phase,'result');assert.equal(f.count('apply'),1);assert.equal(f.count('rollback'),0);
});
