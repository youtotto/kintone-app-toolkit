'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {KTReleaseWorkspace:W}=require('../src/release-workspace.js');
const {KTBusinessConsultation:B}=require('../src/release-business-consultation.js');
const {KTBusinessConsultationView:CV}=require('../src/release-business-consultation-view.js');
const {fixture}=require('./helpers/release-workspace-fixture.js');
const F=require('./helpers/business-fixture.js');
const scope={domain:'fixture.cybozu.com',appId:'310'};
async function setup(){
 const {s}=await F.snapshot();let request;
 const f=fixture({create:args=>W.create({...args,scope})},{propose:args=>{request=args;return {...F.workflowAnswer(s),proposalUnchanged:true};}});
 assert.equal(await f.controller.send('工程を整理',{requestPurpose:'document',businessSnapshot:s,businessWorkflow:true}),true,JSON.stringify(f.controller.getState().error));
 return {...f,s,request,doc:f.controller.getState().explanations.at(-1)};
}
test('工程出力を保存・復元し、入力/通知/根拠を保って1工程の相談へ渡す',async()=>{
 const f=await setup();assert.equal(f.request.businessWorkflow,true);assert.equal(f.doc.title,'業務工程の整理');assert.equal(f.doc.schemaVersion,'business-workflow-1');
 const restored=fixture({create:args=>W.create({...args,scope})});assert.equal(await restored.controller.restoreSession(f.controller.exportSession()),true);
 assert.deepEqual(restored.controller.getState().explanations.at(-1).businessUnderstanding,f.doc.businessUnderstanding);
 const h=await B.create(f.doc,scope,'R1');await B.verify(h,scope);const w=B.wire(h);
 assert.deepEqual(B.validate(w,{wire:true}),[]);assert.deepEqual(w.analysis.rules[0].inputs,f.doc.businessUnderstanding.rules[0].inputs);
 assert.deepEqual(w.analysis.rules[0].notifications,f.doc.businessUnderstanding.rules[0].notifications);
 assert.equal(w.analysis.rules[0].processStateId,f.doc.businessUnderstanding.rules[0].processStateId);
 assert.match(CV.render({businessContext:h,businessSelectedIds:[],businessAnswerDrafts:{},businessMode:'understand'},{canConsultBusiness:true},false),/選択工程：R1/);
 assert.equal(f.count('propose'),1);assert.equal(f.writes.length,0);assert.equal(restored.count('propose'),0);
});
test('工程対応を要求したとき旧ルール応答を受理せず、既存保存を壊さない',async()=>{
 const {s}=await F.snapshot();const f=fixture(W,{propose:()=>({...F.answer(s),proposalUnchanged:true})});
 assert.equal(f.controller.saveBusinessSnapshot(s),true);
 assert.equal(await f.controller.send('工程',{requestPurpose:'document',businessSnapshot:s,businessWorkflow:true}),false);
 assert.equal(f.controller.getState().explanations.length,1);assert.equal(f.writes.length,0);assert.equal(f.count('propose'),1);
});
test('旧形式の保存・全体相談は引き続き検証を通る',async()=>{
 const {s}=await F.snapshot(),f=fixture({create:args=>W.create({...args,scope})},{propose:()=>({...F.answer(s),proposalUnchanged:true})});
 assert.equal(await f.controller.send('旧形式',{requestPurpose:'document',businessSnapshot:s}),true);
 const h=await B.create(f.controller.getState().explanations[0],scope);
 assert.deepEqual(B.validate(B.wire(h),{wire:true}),[]);
});
test('工程の相談でも無効プロセス・不正な通知参照・追加明細の捏造を拒否',async()=>{
 const f=await setup(),h=await B.create(f.doc,scope),w=B.wire(h);
 for(const mutate of [
  x=>x.analysis.rules[0].inputs[0].evidenceRefs[0].evidenceId='B999999',
  x=>x.analysis.rules[0].notifications[0].evidenceRefs=[{evidenceId:x.sourceBundle.evidence.find(e=>e.kind==='field').evidenceId,pointer:null}],
  x=>{const e=x.sourceBundle.evidence.find(e=>e.kind==='process_state');e.active=false;},
  x=>x.analysis.rules[0].processStateId=x.sourceBundle.evidence.find(e=>e.kind==='field').evidenceId
 ]){const bad=F.clone(w);mutate(bad);assert.ok(B.validate(bad,{wire:true}).length);}
});
test('取得済みJS/有効プラグインの状態を相談資料でも維持する',async()=>{
 const data=F.raw();data.javascript.desktop.js=[{type:'FILE',file:{name:'check.js',fileKey:'test',size:'10'}}];data.plugins.plugins=[{id:'fixture',name:'補助プラグイン',enabled:true}];
 const {s}=await F.snapshot({data,download:async()=>"kintone.events.on('app.record.create.submit', e=>e);"});
 const doc={id:'workflow-js',kind:'business-understanding',snapshot:s,businessUnderstanding:F.workflowOutput(s),sourceScope:{...scope,environment:s.environment,startedAt:s.startedAt,completedAt:s.completedAt,revision:s.revision,snapshotId:s.snapshotId}};
 const h=await B.create(doc,scope);assert.deepEqual(B.validate(B.wire(h),{wire:true}),[]);
});
