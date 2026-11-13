'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {KTReleaseWorkspace:W}=require('../src/release-workspace.js');
const {KTBusinessView:V}=require('../src/release-business-view.js');
const {fixture}=require('./helpers/release-workspace-fixture.js');
const F=require('./helpers/business-fixture.js');
const scope={domain:'fixture.cybozu.com',appId:'310'};
const create=(scopeOverride=scope,options={})=>fixture({create:args=>W.create({...args,scope:scopeOverride})},options);
test('保存済みの全工程を無料再表示し、作成・課金・設定取得・書き込みを呼ばない',async()=>{
 const {s}=await F.snapshot(),f=create(scope,{propose:()=>({...F.workflowAnswer(s),proposalUnchanged:true})});
 assert.equal(await f.controller.send('整理',{requestPurpose:'document',businessSnapshot:s,businessWorkflow:true}),true);
 const original=f.controller.getState().explanations[0],saved=f.controller.savedBusinessAnalyses(s.environment),count=f.calls.length;
 assert.equal(saved.length,1);assert.equal(saved[0].revision,s.revision);assert.equal(saved[0].completedAt,s.completedAt);
 f.controller.showChanges();assert.equal(f.controller.showExplanation(saved[0].id),true);
 assert.deepEqual(f.controller.getState().explanations[0],original);assert.equal(f.calls.length,count);assert.equal(f.writes.length,0);
 const g=create();assert.equal(await g.controller.restoreSession(f.controller.exportSession()),true);
 assert.deepEqual(g.controller.savedBusinessAnalyses(s.environment),saved);
 assert.equal(g.count('propose'),0);assert.equal(g.writes.length,0);
});
test('別ドメイン・別アプリ・別環境・資料だけ・全工程未完の回答を再利用候補にしない',async()=>{
 const {s}=await F.snapshot(),f=create(scope,{propose:()=>({...F.workflowAnswer(s),proposalUnchanged:true})});
 f.controller.saveBusinessSnapshot(s);assert.deepEqual(f.controller.savedBusinessAnalyses(s.environment),[]);
 await f.controller.send('整理',{requestPurpose:'document',businessSnapshot:s,businessWorkflow:true});
 assert.deepEqual(f.controller.savedBusinessAnalyses(s.environment==='production'?'preview':'production'),[]);
 for(const other of [{...scope,domain:'other.cybozu.com'},{...scope,appId:'311'},null]){const g=create(other);assert.equal(await g.controller.restoreSession(f.controller.exportSession()),true);assert.deepEqual(g.controller.savedBusinessAnalyses(s.environment),[]);}
 const bad=f.controller.exportSession(),partial=bad.state.explanations.at(-1).businessUnderstanding,removed=partial.rules.pop();partial.unassignedEvidence.push({evidenceId:removed.processStateId,reason:'context_only'});
 const g=create();assert.equal(await g.controller.restoreSession(bad),true);assert.deepEqual(g.controller.savedBusinessAnalyses(s.environment),[]);
});
test('根拠にしたフィールドの事実を表示し工程別入力義務に置き換えない',async()=>{
 const {s}=await F.snapshot(),o=F.workflowAnswer(s).businessUnderstanding,field=s.evidence.find(e=>e.kind==='field');
 field.value.required=true;field.value.expression='<script>unsafe</script>';
 const before=JSON.stringify({s,o}),html=V.outputHtml(o,s);
 assert.match(html,/参照した項目の設定（事実）/);assert.match(html,/アプリ全体で必須/);
 assert.match(html,/この工程での入力義務・担当・時期を意味しません/);assert.match(html,/&lt;script&gt;unsafe&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
 assert.equal(JSON.stringify({s,o}),before);
 delete field.value.required;assert.match(V.outputHtml(o,s),/必須指定は未取得/);
 field.value.required=false;assert.match(V.outputHtml(o,s),/アプリ全体の必須指定なし/);
});
