'use strict';
// Offline public actions: exhaustion/failure before, during, and after useful work.
const test=require('node:test'), assert=require('node:assert/strict');
const {KTReleaseWorkspace:Workspace}=require('../src/release-workspace.js');
const {KTReleaseView:View}=require('../src/release-view.js');
const {fixture,proposal,plan,generated,REQUEST}=require('./helpers/release-workspace-fixture.js');
const shown=f=>View.render(f.controller.getState()).replace(/<style>[\s\S]*?<\/style>/g,'').replace(/<[^>]+>/g,' ');
const budget=()=>Object.assign(new Error('Limit 1.00 USD'),{code:'BUDGET_EXCEEDED'});
for(const at of ['consult','plan','first-generation','second-generation']) test('利用上限で止まる位置: '+at,async()=>{
  let stopped=true;
  const f=fixture(Workspace,{
    settings:false,
    propose:()=>{if(stopped&&at==='consult')throw budget();return proposal();},
    makePlan:()=>{if(stopped&&at==='plan')throw budget();return {plan:plan({settings:false})};},
    generate:({customization:c})=>{if(stopped&&((at==='first-generation'&&c.customizationId==='C1')||(at==='second-generation'&&c.customizationId==='C2')))throw budget();return generated(c);}
  });
  await f.controller.send(REQUEST);
  if(at!=='consult')await f.controller.adopt();
  const s=f.controller.getState(),text=shown(f), finished=s.artifacts.filter(a=>a.result?.artifactOutcome?.state==='ready');
  assert.match(text,/利用上限|AI利用枠を確保できません/);assert.doesNotMatch(text,/1\.00|USD/);
  assert.match(text,/［接続］で利用状況を確認してください/);
  if(at==='consult')assert.match(text,/案は更新していません。利用可能になってから、相談内容をもう一度送信してください/);
  assert.equal(finished.length,at==='second-generation'?1:0);
  if(!finished.length)assert.doesNotMatch(text,/自動確認が完了した内容|JavaScriptは作成済みです/);
  else {
    assert.match(text,/JavaScriptは作成済みです/);assert.match(text,/自動確認が完了した内容/);
    assert.equal(finished[0].customizationId,'C1');
    assert.equal(finished[0].result.code,generated(f.plan.customizations[0]).code);
    assert.match(View.render(s),/data-release-action="copy-code"/);
    assert.match(View.render(s),/data-release-action="download-code"/);
  }
  assert.equal(f.count('apply'),0);assert.equal(f.writes.length,0);
  const calls=f.count('generate');await new Promise(resolve=>setImmediate(resolve));assert.equal(f.count('generate'),calls,'no automatic retry');
  stopped=false;
  if(at==='consult'){await f.controller.send(REQUEST);await f.controller.adopt();}
  else if(at==='plan')await f.controller.adopt();
  else await f.controller.resume();
  assert.equal(f.controller.getState().phase,'review');
  if(at==='second-generation')assert.deepEqual(f.calls.filter(c=>c.method==='generate').map(c=>c.id),['C1','C2','C2']);
  assert.equal(f.writes.length,0);
});
for(const outcome of ['incomplete','failed'])test('最初の生成が'+outcome+'なら完成済みとは言わず、次の生成や準備を始めない',async()=>{
  const f=fixture(Workspace,{settings:false,generate:({customization})=>generated(customization,{state:outcome,message:'必要な確認が終わっていません。'})});
  await f.controller.send(REQUEST);await f.controller.adopt();
  assert.equal(f.controller.getState().phase,'incomplete');
  assert.equal(f.count('generate'),1);assert.equal(f.count('prepare'),0);
  assert.doesNotMatch(shown(f),/完成した内容は残っています|できた内容/);
  assert.match(shown(f),/必要な確認が終わっていません/);
  assert.equal(await f.controller.apply(),false);assert.equal(f.writes.length,0);
});

// 2.3.3: an unverified body is retained and the remaining files are generated,
// but none of it becomes verified or eligible for automatic application.
test('未確認コードがあっても後続を作成し、検証済み・反映可能とは扱わず再生成しない',async()=>{
  const f=fixture(Workspace,{settings:false,generate:({customization})=>generated(customization,{state:'unverified',message:'必要な確認が終わっていません。'})});
  await f.controller.send(REQUEST);await f.controller.adopt();
  const state=f.controller.getState(),html=View.render(state),text=shown(f);
  assert.equal(state.phase,'incomplete');assert.equal(f.count('prepare'),0);
  assert.deepEqual(f.calls.filter(c=>c.method==='generate').map(c=>c.id),['C1','C2']);
  assert.deepEqual(state.artifacts.map(a=>[a.customizationId,a.result.code,a.result.artifactOutcome.state,a.result.artifactOutcome.operations]),
    f.plan.customizations.map(c=>[c.customizationId,generated(c).code,'unverified',[]]));
  assert.match(text,/JavaScriptは作成済みです/);assert.match(text,/自動確認できていない内容があります/);
  assert.match(text,/必要な確認が終わっていません/);
  assert.doesNotMatch(text,/自動確認が完了した内容|検証が完了しました/);
  assert.doesNotMatch(html,/data-release-action="(?:apply|resume)"/);
  assert.match(html,/data-release-action="copy-code"/);assert.match(html,/data-release-action="download-code"/);
  assert.equal(await f.controller.resume(),false);assert.equal(await f.controller.apply(),false);
  assert.equal(f.count('generate'),2);assert.equal(f.count('prepare'),0);assert.equal(f.count('apply'),0);assert.equal(f.writes.length,0);
});

test('未確認でコードが空なら後続の生成・準備・再送・反映を始めない',async()=>{
  const f=fixture(Workspace,{settings:false,generate:({customization})=>generated(customization,{state:'unverified',body:'',message:'コードは未取得です。'})});
  await f.controller.send(REQUEST);await f.controller.adopt();
  assert.equal(f.controller.getState().phase,'incomplete');
  assert.deepEqual(f.calls.filter(c=>c.method==='generate').map(c=>c.id),['C1']);
  assert.doesNotMatch(shown(f),/JavaScriptは作成済みです|自動確認が完了した内容/);
  assert.match(shown(f),/コードは未取得です/);
  assert.equal(await f.controller.resume(),false);assert.equal(await f.controller.apply(),false);
  assert.equal(f.count('generate'),1);assert.equal(f.count('prepare'),0);assert.equal(f.count('apply'),0);assert.equal(f.writes.length,0);
});
