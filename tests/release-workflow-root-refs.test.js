'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./helpers/workflow-root-refs-fixture.js');
const {KTBusinessContract:C}=require('../src/release-business-contract.js');
const {KTBusinessConsultation:B}=require('../src/release-business-consultation.js');
const {KTReleaseWorkspace:W}=require('../src/release-workspace.js');
const {fixture:workspace}=require('./helpers/release-workspace-fixture.js');
test('集約した全引用を保持し、受信・保存復元・相談で件数だけを理由に拒否しない',async()=>{
 const {s,answer}=await fixture(),original=structuredClone(answer.businessUnderstanding);
 assert.ok(original.rules[0].evidenceRefs.length>20);assert.deepEqual(C.validateOutput(original,s,{requireAllStages:true}),[]);
 const scope={domain:'offline.cybozu.com',appId:s.appId};
 const create={create:args=>W.create({...args,scope})};
 const w=workspace(create,{propose:()=>({...answer,proposalUnchanged:true})});
 assert.equal(await w.controller.send('工程を整理',{requestPurpose:'document',businessSnapshot:s,businessWorkflow:true}),true,JSON.stringify(w.controller.getState().error));
 const saved=w.controller.exportSession(),restored=workspace(create);assert.equal(await restored.controller.restoreSession(saved),true);
 const doc=restored.controller.getState().explanations.at(-1);assert.deepEqual(doc.businessUnderstanding,original);assert.deepEqual(doc.snapshot,s);
 const h=await B.create(doc,scope);assert.deepEqual(B.validate(B.wire(h),{wire:true}),[]);assert.equal(restored.count('propose'),0);assert.equal(w.writes.length,0);
});
test('20件を別の固定上限へ置き換えず、取得済み設定への有効な全引用を検証する',async()=>{
 const {s,answer,fields}=await fixture(450),o=answer.businessUnderstanding;
 for(const e of fields)for(const pointer of ['/code','/label','/type','/required','/expression'])o.rules[0].evidenceRefs.push({evidenceId:e.evidenceId,pointer});
 assert.ok(o.rules[0].evidenceRefs.length>2000);const before=structuredClone(o);
 assert.equal(C.WORKFLOW_OUTPUT_SCHEMA.properties.rules.items.properties.evidenceRefs.maxItems,undefined);
 assert.deepEqual(C.validateOutput(o,s,{requireAllStages:true}),[]);assert.deepEqual(o,before);
});
test('多い根拠でも未知ID・無効pointer・重複・取得回不一致・全工程欠落を受理しない',async()=>{
 const {s,answer}=await fixture();
 for(const edit of [o=>o.rules[0].evidenceRefs.push({evidenceId:'B999999',pointer:null}),o=>o.rules[0].evidenceRefs[25].pointer='/absent',o=>o.rules[0].evidenceRefs.push(o.rules[0].evidenceRefs[25]),o=>o.snapshotId='other',o=>o.rules.pop()]){
  const o=structuredClone(answer.businessUnderstanding);edit(o);assert.ok(C.validateOutput(o,s,{requireAllStages:true}).length);
 }
});
