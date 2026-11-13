'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {make}=require('./helpers/workflow-admission-fixture.js'),F=require('./helpers/business-fixture.js');
const {KTBusinessContract:C}=require('../src/release-business-contract.js'),{KTBusinessView:V}=require('../src/release-business-view.js'),{KTReleaseWorkspace:W}=require('../src/release-workspace.js'),{fixture}=require('./helpers/release-workspace-fixture.js');
test('費用・入力・時間の旧目安を超えても全件を分析対象とし原文を変えない',async()=>{
 for(const options of [{stages:16,actions:19},{stages:3,fields:500},{stages:3,js:30000},{stages:3,actions:250}]){
  const s=await make(options),before=JSON.stringify(s),p=C.workflowEligibility(s);
  assert.equal(p.mode,'analyze-all');assert.deepEqual(p.reasons,[]);assert.ok(p.estimate.estimatedUsd>.55);
  if(options.fields)assert.ok(p.estimate.estimatedInputTokens>18000);
  if(options.actions===250)assert.ok(p.estimate.estimatedSeconds>280);
  assert.deepEqual(C.context(s,'全工程',{workflow:true}).businessSnapshot,s);assert.equal(JSON.stringify(s),before);
 }
});
test('16工程・全遷移・根拠は一部選択せず模擬生成し保存復元する',async()=>{
 const s=await make({stages:16,actions:19}),f=fixture(W,{propose:args=>{assert.deepEqual(args.businessSnapshot,s);return {...F.workflowAnswer(s),proposalUnchanged:true};}});
 assert.equal(await f.controller.send('全工程',{requestPurpose:'document',businessSnapshot:s,businessWorkflow:true}),true);
 assert.equal(f.count('propose'),1);assert.equal(f.writes.length,0);
 const doc=f.controller.getState().explanations.at(-1);assert.equal(doc.businessUnderstanding.rules.length,16);assert.deepEqual(doc.snapshot,s);
 const html=V.outputHtml(doc.businessUnderstanding,s);assert.equal((html.match(/data-workflow-node="/g)||[]).length,16);assert.equal((html.match(/data-workflow-edge="/g)||[]).length,19);
 const restored=fixture(W);assert.equal(await restored.controller.restoreSession(f.controller.exportSession()),true);assert.deepEqual(restored.controller.getState().explanations.at(-1),doc);
});
test('JS本文と全根拠のID・原文・取得情報を生成後にも保存復元する',async()=>{
 const s=await make({stages:3,js:30000}),f=fixture(W,{propose:()=>({...F.workflowAnswer(s),proposalUnchanged:true})});
 assert.equal(await f.controller.send('全工程',{requestPurpose:'document',businessSnapshot:s,businessWorkflow:true}),true);
 const doc=f.controller.getState().explanations.at(-1),md=V.markdown(doc);assert.deepEqual(doc.snapshot,s);
 for(const e of s.evidence)assert.ok(md.includes(e.evidenceId));assert.ok(md.includes(s.evidence.at(-1).value.text));
 const restored=fixture(W);assert.equal(await restored.controller.restoreSession(f.controller.exportSession()),true);assert.deepEqual(restored.controller.getState().explanations.at(-1).snapshot,s);assert.equal(f.writes.length,0);
});
test('技術上限の17工程は全体図と全根拠を残し一部分析や自動再試行をしない',async()=>{
 const s=await make({stages:17}),f=fixture(W),before=JSON.stringify(s);
 assert.equal(await f.controller.send('全工程',{requestPurpose:'document',businessSnapshot:s,businessWorkflow:true}),false);
 assert.equal(f.count('propose'),0);assert.equal(f.writes.length,0);const doc=f.controller.getState().explanations.at(-1);
 assert.deepEqual(doc.snapshot,s);assert.equal(doc.businessUnderstanding,null);assert.match(C.workflowEligibility(s).reasons.join(),/16工程/);assert.doesNotMatch(C.workflowEligibility(s).reasons.join(),/10クレジット|事前目安/);assert.equal(JSON.stringify(s),before);
});
test('見積もりは原価確定や完走保証ではなく判定から独立した参考値',async()=>{
 const s=await make({stages:2}),p=C.workflowEligibility(s,{question:'長い依頼'.repeat(10000)});
 assert.equal(p.mode,'analyze-all');assert.ok(p.estimate.estimatedInputTokens>18000);assert.ok(p.estimate.estimatedUsd>.55);
 assert.equal(C.WORKFLOW_ADMISSION.estimateOnly,true);assert.equal(p.estimate.policyVersion,'workflow-admission-3');assert.equal(C.MAX_WORKFLOW_STAGES,16);
});
