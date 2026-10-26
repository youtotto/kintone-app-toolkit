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
  assert.match(text,/利用上限/);assert.doesNotMatch(text,/1\.00|USD/);
  assert.match(text,/［接続］で利用状況を確認してください/);
  if(at==='consult')assert.match(text,/案は更新していません。利用可能になってから、相談内容をもう一度送信してください/);
  assert.equal(finished.length,at==='second-generation'?1:0);
  if(!finished.length)assert.doesNotMatch(text,/完成した内容は残っています|できた内容は残っています|できた内容/);
  else assert.match(text,/できた内容/);
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
for(const outcome of ['incomplete','unverified','failed'])test('最初の生成が'+outcome+'なら完成済みとは言わず、次の生成や準備を始めない',async()=>{
  const f=fixture(Workspace,{settings:false,generate:({customization})=>generated(customization,{state:outcome,message:'必要な確認が終わっていません。'})});
  await f.controller.send(REQUEST);await f.controller.adopt();
  assert.equal(f.controller.getState().phase,'incomplete');
  assert.equal(f.count('generate'),1);assert.equal(f.count('prepare'),0);
  assert.doesNotMatch(shown(f),/完成した内容は残っています|できた内容/);
  assert.match(shown(f),/必要な確認が終わっていません/);
  assert.equal(await f.controller.apply(),false);assert.equal(f.writes.length,0);
});
