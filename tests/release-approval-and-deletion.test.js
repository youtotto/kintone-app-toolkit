'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {loadToolkit} = require('./helpers/load-toolkit.js');
const {fixture,REQUEST,plan} = require('./helpers/release-workspace-fixture.js');
const {KTAiClient,KTReleaseView,KTReleaseWorkspace} = loadToolkit();

test('receive a composed deletion-only patch while rejecting blank new files and incomplete patch bodies', () => {
  const operation = {type:'REPLACE',anchor:'const old = event.record.referral.value; ',content:''};
  const g = {strategy:'EXTEND_EXISTING_JS',code:'',targetFile:'estimate.js',body:'event.record.memo.disabled = true;',patch:{operations:[operation]}};
  const receive = generated => KTAiClient.receive('generated',{ok:true,contractVersion:'2.1',generated,verification:{machine:[],requiredEffects:[]}});
  assert.equal(receive(g).body,g.body);
  for(const bad of [{...g,strategy:'NEW_JS_FILE'},{...g,body:null},{...g,patch:{operations:[]}},{...g,patch:{operations:[{...operation,content:'x'}]}}])assert.throws(()=>receive(bad));
});

test('show provisional approval steps and options, then require a revised plan before preview writes', async () => {
  const choice='候補全員が操作する';
  const q={id:'Q1',topic:'assignee',question:'経理確認を完了するのは誰ですか？',options:['一人を選ぶ',choice],priority:'blocking'};
  const draft=plan({platforms:[]});
  const step={id:'S1',actionType:'ADD_PROCESS_STATUS',title:'経理確認を追加する',spec:{name:'経理確認',assignees:['FIELD_ENTITY:owner'],assigneeType:null}};
  draft.steps=[step];draft.questions=[q];
  let answered=false;
  const f=fixture(KTReleaseWorkspace,{makePlan:()=>({plan:answered?{...draft,questions:[],steps:[{...step,spec:{...step.spec,assigneeType:'ALL'}}]}:draft})});
  const c=f.controller;
  await c.send(REQUEST);await c.adopt();
  function checkBlocked(){
    const html=KTReleaseView.render(c.getState());
    assert.match(html,/仮案を確認してください/);assert.match(html,/経理確認を追加する/);
    assert.match(html,/経理確認を完了するのは誰/);assert.match(html,/候補全員が操作する/);
    assert.doesNotMatch(html,/data-release-action="apply"/);
  }
  checkBlocked();assert.equal(await c.apply(),false);assert.equal(f.count('prepare'),0);
  assert.ok(await c.restoreSession(c.exportSession()));checkBlocked();
  await c.send(choice);answered=true;await c.adopt();
  assert.equal(c.getState().phase,'review');assert.match(KTReleaseView.render(c.getState()),/候補全員が操作すると次へ進む/);
  assert.equal(f.count('apply'),0);await c.apply();assert.equal(f.count('apply'),1);
});

test('an assigned new status with no selection mode and no AI question still requires an answer',async()=>{
  const draft=plan({platforms:[]});draft.questions=[];
  draft.steps=[{id:'S1',actionType:'ADD_PROCESS_STATUS',title:'承認待ち',spec:{name:'承認待ち',assignees:['FIELD_ENTITY:owner']}}];
  const f=fixture(KTReleaseWorkspace,{plan:draft});await f.controller.send(REQUEST);await f.controller.adopt();
  assert.equal(f.controller.getState().phase,'blocked');assert.equal(await f.controller.apply(),false);
  assert.match(KTReleaseView.render(f.controller.getState()),/承認待ち.*作業者が複数/);
});
