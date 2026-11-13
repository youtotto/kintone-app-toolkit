'use strict';
// Offline regression tests through the public conversation/execution actions.
const test = require('node:test'), assert = require('node:assert/strict');
const { KTReleaseWorkspace: Workspace } = require('../src/release-workspace.js');
const { KTReleaseView: View } = require('../src/release-view.js');
const { fixture, proposal, plan, generated, deferred, REQUEST } = require('./helpers/release-workspace-fixture.js');
const built = async f => { await f.controller.send(REQUEST); await f.controller.adopt(); };
const state = f => f.controller.getState();
const visible = s => View.render(s).replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ');

test('修正の通信失敗では前の計画・コード・承認を再利用できず、再送した案だけを採用する', async () => {
  let fail = false;
  const revised = proposal(); revised.proposal.behaviors = [{id:'B2', text:'モバイルだけで備考を編集不可にする', origin:'user'}];
  const f = fixture(Workspace, {propose: args => { if(fail) throw new Error('接続が切れました。'); return args.previous ? revised : proposal(); }});
  await built(f); fail = true;
  assert.equal(await f.controller.send('PCを取り消してモバイルだけにしてください'), false);
  assert.equal(state(f).plan, null); assert.equal(state(f).adopted, null); assert.deepEqual(state(f).artifacts, []);
  assert.equal(state(f).prepared, null);
  assert.equal(await f.controller.prepare(), false); assert.equal(await f.controller.resume(), false); assert.equal(await f.controller.apply(), false);
  assert.match(visible(state(f)), /案は更新していません/);
  fail = false; await f.controller.send('PCを取り消してモバイルだけにしてください'); await f.controller.adopt();
  assert.deepEqual(f.calls.filter(c=>c.method==='plan').at(-1).proposal, revised.proposal);
  assert.equal(f.writes.length, 0);
});

test('失敗した修正でも計画の質問は再送まで保持する', async () => {
  const p = plan({platforms:[]}); p.questions = [{question:'一覧に表示する項目を指定してください',blocking:true}];
  let fail = false, received;
  const f = fixture(Workspace,{plan:p,propose: args=>{received=args.pendingPlanQuestions;if(fail)throw new Error('通信失敗');return proposal();}});
  await built(f); fail=true; await f.controller.send('備考を出します');
  fail=false; await f.controller.send('備考を出します');
  assert.deepEqual(received,p.questions);
  await f.controller.send('名前を確認待ちにします'); assert.deepEqual(received,[]);
});

for(const outcome of ['failure','cancel']) test(`再作成の${outcome}で古い計画を残さない`, async()=>{
  const gate=deferred(), entered=deferred(); let again=false;
  const f=fixture(Workspace,{makePlan:()=>{if(again){entered.resolve();return gate.promise;}return {plan:plan()};}});
  await built(f); again=true; const work=f.controller.adopt(); await entered.promise;
  if(outcome==='cancel') f.controller.cancel();
  gate.reject(new Error('計画を作成できませんでした')); await work;
  assert.equal(state(f).plan,null); assert.equal(await f.controller.resume(),false); assert.equal(await f.controller.prepare(),false);
  assert.equal(f.writes.length,0);
  if(outcome==='cancel') assert.doesNotMatch(visible(state(f)),/できた内容は残っています/);
});

test('計画作成の失敗は完成済みと説明せず、押したときだけ再作成する', async()=>{
  let fail=true;
  const f=fixture(Workspace,{makePlan:()=>{if(fail)throw new Error('計画を受信できませんでした');return {plan:plan()};}});
  await built(f);
  const html=View.render(state(f));
  assert.match(html,/もう一度作成/); assert.doesNotMatch(visible(state(f)),/完成した内容は残っています/);
  assert.equal(f.count('plan'),1); assert.equal(f.count('generate'),0);
  fail=false; await f.controller.adopt(); assert.equal(state(f).phase,'review'); assert.equal(f.count('plan'),2);
});

test('修正・一部取り消し・再修正は最新の構造だけを計画と生成に渡す',async()=>{
  const versions=[['PCで備考を編集不可にする','一覧を追加する'],['PCとモバイルで備考を編集不可にする','一覧を追加する'],['PCとモバイルで備考を編集不可にする'],['経理確認中は備考だけ編集可能にする（PC・モバイル）']];
  let i=0;const inputs=[];
  const f=fixture(Workspace,{propose:()=>{const p=proposal();p.proposal.behaviors=versions[i++].map((text,j)=>({id:'B'+(j+1),origin:'user',text}));return p;},makePlan:a=>{inputs.push(a.proposal);return {plan:plan({settings:false})};},generate:a=>{inputs.push(a.proposal);return generated(a.customization);}});
  for(const text of ['PCの編集制御と一覧を追加','モバイルも追加','一覧は取り消す','経理確認中は備考だけ編集可能に修正'])await f.controller.send(text);
  assert.equal(f.count('plan'),0); await f.controller.adopt();
  assert.equal(inputs.length,3); for(const input of inputs) assert.deepEqual(input,state(f).proposal);
  assert.deepEqual(inputs[0].behaviors.map(b=>b.text),versions[3]); assert.equal(f.writes.length,0);
});

test('中断後の遅い相談応答は、次の相談や回答を上書きしない',async()=>{
  const gate=deferred(), entered=deferred();let n=0;
  const f=fixture(Workspace,{propose:()=>{if(++n===2){entered.resolve();return gate.promise;}return proposal(n===1?'最初の案':'最後の案');}});
  await f.controller.send(REQUEST); const pending=f.controller.send('取り消す修正');await entered.promise;
  assert.equal(await f.controller.send('同時送信'),false);assert.equal(await f.controller.adopt(),false);
  f.controller.cancel(); await f.controller.send('最後の修正'); const current=state(f);
  gate.resolve(proposal('中断した古い返答'));await pending;
  assert.deepEqual(state(f),current);assert.equal(f.count('propose'),3);assert.equal(f.writes.length,0);
});

test('反映と復元の実行中は新規相談・中断・二重実行を受け付けない',async()=>{
  const applyGate=deferred(),applyEntered=deferred(),undoGate=deferred(),undoEntered=deferred();
  const f=fixture(Workspace,{apply:()=>{applyEntered.resolve();return applyGate.promise;},rollback:()=>{undoEntered.resolve();return undoGate.promise;}});
  await built(f);const applying=f.controller.apply();await applyEntered.promise;
  assert.equal(f.controller.cancel(),false);assert.equal(f.controller.newTask(),false);assert.equal(await f.controller.send('並行した修正'),false);assert.equal(await f.controller.apply(),false);
  applyGate.resolve({status:'complete',written:1});await applying;
  const id=state(f).runs[0].id;await f.controller.requestRollback(id);const undo=f.controller.rollback(id);await undoEntered.promise;
  assert.equal(f.controller.cancelRollback(),false);assert.equal(f.controller.newTask(),false);assert.equal(await f.controller.send('並行した修正'),false);assert.equal(await f.controller.rollback(id),false);
  undoGate.resolve({status:'complete'});await undo;assert.equal(f.count('apply'),1);assert.equal(f.count('rollback'),1);
});

test('反映直前の確認事項が変わった場合、同じ設定の版でも書き込まない',async()=>{
  const f=fixture(Workspace);await built(f);const prepare=f.execution.prepare;
  f.execution.prepare=async a=>({...await prepare(a),confirmations:['新しい注意事項']});
  await f.controller.apply();assert.equal(state(f).error.code,'APPROVAL_CHANGED');assert.equal(f.writes.length,0);
});

test('一部失敗と復元失敗の具体的な理由を通常表示に残す',()=>{
  for(const undo of [false,true]){
    const failed={status:'partial',message:'処理を完了できませんでした。',reasons:[{code:'STALE',message:'別の作業で一覧の設定が変わりました。'}]};
    const run={id:'r',status:'partial',result:undo?{status:'complete',written:1}:failed,...(undo?{rollback:failed}:{})};
    const s={phase:'result',runs:[run],resultRunId:'r',messages:[],artifacts:[]};
    assert.match(visible(s),/別の作業で一覧の設定が変わりました/);
  }
});
