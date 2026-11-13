'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('./helpers/business-fixture.js');
const {KTReleaseWorkspace:W}=require('../src/release-workspace.js');
const {fixture}=require('./helpers/release-workspace-fixture.js');
async function large(){
 const {s}=await F.snapshot(),o=F.workflowAnswer(s).businessUnderstanding,r=o.rules[0];
 r.notifications[0].interpretation='通'.repeat(600);
 r.questions[0].question='確'.repeat(300);r.questions[0].whyItMatters='理'.repeat(300);
 o.rules=Array.from({length:16},(_,i)=>({...structuredClone(r),ruleId:'R'+(i+1),processStateId:null,inference:'工'.repeat(520)}));
 const used=new Set(o.rules.flatMap(r=>r.evidenceRefs.map(e=>e.evidenceId)));
 o.unassignedEvidence=s.evidence.filter(F.C.eligible).filter(e=>!used.has(e.evidenceId)).map(e=>({evidenceId:e.evidenceId,reason:'context_only'}));
 return {s,o};
}
test('共通の通知・確認事項の展開後も全16工程と全根拠を保持して受理する',async()=>{
 const {s,o}=await large(),before=structuredClone(o);
 assert.deepEqual(F.C.validateOutput(o,s),[]);assert.deepEqual(o,before);
 const n=o.rules[1].notifications[0];o.rules[1].notifications[0]={evidenceRefs:n.evidenceRefs,interpretation:n.interpretation};
 assert.deepEqual(F.C.validateOutput(o,s),[]);
});
test('文言・通知条件・根拠・確認理由が異なれば別内容として12000文字上限を維持する',async()=>{
 const {s,o}=await large();
 for(const edit of [r=>r.notifications[0].interpretation='別'+r.notifications[0].interpretation.slice(1),r=>r.notifications[0].evidenceRefs[0].pointer='/title',r=>r.questions[0].whyItMatters='別'+r.questions[0].whyItMatters.slice(1),r=>r.questions[0].relatedEvidenceRefs[1].pointer='/filterCond']){
  const v=structuredClone(o);edit(v.rules[1]);assert.ok(F.C.validateOutput(v,s).some(x=>x.includes('12000')));
 }
 const distinct=structuredClone(o);for(const r of distinct.rules)r.inference='工'.repeat(600);
 assert.ok(F.C.validateOutput(distinct,s).some(x=>x.includes('12000')));
 const invalid=structuredClone(o);invalid.rules[0].notifications[0].evidenceRefs[0].evidenceId='B999999';assert.ok(F.C.validateOutput(invalid,s).length);
});
test('空白反復は専用の案内を出し、保存済みの分析を残し、自動再試行しない',async()=>{
 const {s}=await F.snapshot();let fail=false;
 const f=fixture(W,{propose:()=>{if(fail)throw {code:'MODEL_OUTPUT_INVALID',details:{error:{detail:{reason:'EXCESSIVE_JSON_WHITESPACE'}}}};return {...F.workflowAnswer(s),proposalUnchanged:true};}});
 const options={requestPurpose:'document',businessSnapshot:s,businessWorkflow:true};
 assert.equal(await f.controller.send('工程を整理',options),true);
 const before=structuredClone(f.controller.getState().explanations);fail=true;
 assert.equal(await f.controller.send('工程を整理',options),false);
 assert.match(f.controller.getState().error.message,/空白の繰り返し/);
 assert.match(f.controller.getState().error.message,/未完成/);
 assert.deepEqual(f.controller.getState().explanations,before);assert.equal(f.count('propose'),2);assert.equal(f.writes.length,0);
});
