'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {KTReleaseWorkspace:W}=require(process.env.KT_WORKSPACE_SOURCE||'../src/release-workspace.js');
const {KTReleaseContext:C}=require('../src/release-context.js');
const {fixture,proposal,plan,REQUEST,deferred}=require('./helpers/release-workspace-fixture.js');
const copy=x=>JSON.parse(JSON.stringify(x));
const answer=()=>({reply:'検討内容をまとめました。',intent:'question',proposalUnchanged:true,
 explanation:{title:'検討用アイディア',sections:[{heading:'候補',paragraphs:['期限のリマインダーも候補です。まだ採用していません。'],items:[],table:null,evidenceIds:[]}],unknowns:['通知先と必要性は未確認です。']},
 turn:{ops:[],answers:[],requirementOps:[]},facts:[]});
const work=s=>({phase:s.phase,goal:s.goal,version:s.version,proposal:s.proposal,adopted:s.adopted,answers:s.answers,plan:s.plan,prepared:s.prepared,artifacts:s.artifacts,runs:s.runs,rollback:s.rollback,proposalPending:s.proposalPending});
function scenario(options={}){let response=proposal(),input;const f=fixture(W,{...options,propose:a=>{input=a;return typeof response==='function'?response(a):response;}});return {...f,state:()=>f.controller.getState(),input:()=>input,respond:r=>{response=r;}};}
async function built(f){await f.controller.send(REQUEST);await f.controller.adopt();}
function materialScenario(){
 const initial='確認期限を備考の上に追加し、期限順の一覧も追加してください。';
 const revised='配置は確認メモのすぐ下の独立した行に訂正します。一覧は取り消してください。空欄で保存できるようにしてください。';
 const accepted=proposal();accepted.proposal.behaviors=[{id:'B1',origin:'user',text:'確認期限を確認メモのすぐ下の独立した行に追加し、空欄でも保存できるようにする。'},{id:'B2',origin:'suggestion',text:'期限前のリマインダーを追加する。'}];
 const p={...plan({settings:false,platforms:[]}),goal:initial,solution:'STANDARD',proposedFields:[{temporaryId:'F1',suggestedCode:'check_due',label:'確認期限',type:'DATE'}],
 steps:[{id:'P1',title:'確認期限を追加',actionType:'ADD_FIELD',targetRef:'F1',spec:{required:false,placement:{position:'AFTER_ROW',anchor:'check_memo'}},dependsOn:[]}]};
 const base={ok:true,appId:'test',env:'preview',stamp:'preview:1',revision:{preview:'1'},data:{fields:{check_memo:{code:'check_memo',label:'確認メモ',type:'SINGLE_LINE_TEXT'}}},files:[{type:'FILE',target:'desktop',name:'source.js',text:'/* registered source */'}]};
 const f=scenario({plan:p,loadBase:()=>copy(base)});
 return{f,initial,revised,accepted,p,base};
}

test('訂正後の採用内容と配置を資料へ渡し、初回依頼の配置と取り消した一覧は履歴に分ける',async()=>{
 const {f,initial,revised,accepted,p}=materialScenario();await f.controller.send(initial);f.respond(accepted);await f.controller.send(revised);await f.controller.adopt();
 const before=work(f.state());f.respond(answer());await f.controller.send('引継ぎ資料にしてください',{requestPurpose:'document'});
 const ctx=C.proposal(f.input()),s=JSON.parse(ctx.conversation.currentPlanSummary);
 assert.deepEqual(ctx.conversation.originalRequestHistory,{initialRequest:initial,status:'history-only'});
 assert.equal(Object.hasOwn(s,'goal'),false);assert.equal(s.source.matchesCurrentBase,true);assert.equal(s.source.environment,'preview');
 assert.deepEqual(s.steps,p.steps);assert.deepEqual(s.proposedFields,p.proposedFields);assert.equal(s.steps[0].spec.required,false);assert.deepEqual(s.steps[0].spec.placement,{position:'AFTER_ROW',anchor:'check_memo'});
 assert.deepEqual(s.preparation.changes,before.prepared.changes);assert.ok(!s.steps.some(x=>x.actionType==='ADD_VIEW'));
 assert.deepEqual(ctx.conversation.acceptedProposal.behaviors,[accepted.proposal.behaviors[0]]);
 assert.equal(ctx.conversation.proposal.behaviors[1].origin,'suggestion');
 assert.deepEqual(ctx.conversation.userRequests,[initial,revised]);assert.ok(ctx.conversation.discussion.some(m=>m.text===revised));
 assert.equal(ctx.facts.find(x=>x.value?.name==='source.js').value.source,'/* registered source */');
 assert.equal(ctx.coverage.recordData,false);assert.equal(ctx.coverage.incoming,false);assert.deepEqual(work(f.state()),before);
 assert.equal(f.count('plan'),1);assert.equal(f.writes.length,0);
});

test('資料の要約は6000字を超えるspecも省略せず保持する',async()=>{
 const {f,p}=materialScenario();p.steps[0].spec.description='必要な条件。'.repeat(1500);
 await built(f);f.respond(answer());await f.controller.send('資料にして',{requestPurpose:'document'});
 const s=JSON.parse(C.proposal(f.input()).conversation.currentPlanSummary);assert.equal(s.steps[0].spec.description,p.steps[0].spec.description);assert.ok(f.input().currentPlanSummary.length>6000);
});

test('同じアプリの古い計画は取得時点と不一致を明示し、反映準備を復活させない',async()=>{
 const f=scenario();await built(f);f.bump();f.respond(answer());await f.controller.send('資料にして',{requestPurpose:'document'});
 const s=JSON.parse(f.input().currentPlanSummary);assert.equal(s.source.baseStamp,'preview:1');assert.equal(s.source.matchesCurrentBase,false);
 assert.equal(f.state().phase,'blocked');assert.equal(f.state().prepared,null);assert.equal(await f.controller.apply(),false);
});

for(const change of ['app','environment'])test('別'+change+'の設定と既存の会話を混ぜてAIへ送らない',async()=>{
 const {f,base}=materialScenario();await built(f);const before=work(f.state()),count=f.count('propose');
 if(change==='app')base.appId='another';else base.env='production';f.respond(answer());
 assert.equal(await f.controller.send('資料にして',{requestPurpose:'document'}),false);
 assert.equal(f.state().error.code,'CONSULTATION_ENVIRONMENT');assert.equal(f.count('propose'),count);assert.deepEqual(work(f.state()),before);
});

test('アイディア用途の選択・表示切替ではAIを呼ばず、送信後も採用内容と計画を変えない',async()=>{
 const f=scenario();await built(f);const before=work(f.state()),count=f.count('propose');
 assert.equal(f.controller.setRequestPurpose('ideation'),true);f.controller.showChanges();assert.equal(f.count('propose'),count);
 f.respond(answer());assert.equal(await f.controller.send('改善案を考えて'),true);
 assert.equal(f.input().requestPurpose,'ideation');assert.equal(C.proposal(f.input()).requestPurpose,'ideation');assert.deepEqual(work(f.state()),before);
 assert.equal(f.state().explanations[0].accepted,false);assert.equal(f.state().explanations[0].requestPurpose,'ideation');
 assert.equal(f.count('plan'),1);assert.equal(f.writes.length,0);
});

test('資料には未採用アイディアだけでなく元資料と確定内容を渡し、戻った相談の依頼履歴へ資料依頼を混ぜない',async()=>{
 const f=scenario();await built(f);const adopted=f.state().adopted;f.respond(answer());await f.controller.send('改善案を考えて',{requestPurpose:'ideation'});
 await f.controller.send('引継ぎ資料にして',{requestPurpose:'document'});
 const ctx=C.proposal(f.input());assert.deepEqual(ctx.conversation.acceptedProposal,adopted);assert.ok(ctx.conversation.currentPlanSummary);
 const idea=ctx.conversation.discussion.find(m=>m.explanation?.title==='検討用アイディア');assert.equal(idea.requestPurpose,'ideation');assert.equal(idea.accepted,false);
 assert.deepEqual(ctx.conversation.userRequests,[REQUEST]);
 f.controller.setRequestPurpose('consultation');f.respond(proposal());await f.controller.send('備考の条件は維持して');
 assert.deepEqual(f.input().requests,[REQUEST,'備考の条件は維持して']);assert.equal(f.input().requestPurpose,'consultation');
});

test('アイディア用途で変更提案が返っても取り込まず、再試行は自動で呼ばない',async()=>{
 const f=scenario();await built(f);const before=work(f.state());f.respond(proposal('未採用の通知を勝手に追加'));
 assert.equal(await f.controller.send('案を考えて',{requestPurpose:'ideation'}),false);assert.deepEqual(work(f.state()),before);
 assert.equal(f.state().error.code,'IDEATION_RESPONSE_INVALID');assert.equal(f.count('propose'),2);assert.equal(f.state().explanations.length,0);
});

test('アイディアの中断では案を保持し、遅い応答を採用しない',async()=>{
 const f=scenario();await built(f);const before=work(f.state()),gate=deferred();f.respond(()=>gate.promise);
 const pending=f.controller.send('案を考えて',{requestPurpose:'ideation'});await new Promise(r=>setImmediate(r));
 assert.equal(await f.controller.apply(),false);assert.equal(f.controller.cancel(),true);assert.deepEqual(work(f.state()),before);
 assert.equal(f.state().error.operation,'ideation');gate.resolve(answer());assert.equal(await pending,false);assert.equal(f.state().explanations.length,0);
});

test('アイディアの失敗でも採用内容を保ち、次の成功でエラーを解消する',async()=>{
 const f=scenario();await built(f);const before=work(f.state());f.respond(()=>{throw Error('固定の通信失敗');});
 assert.equal(await f.controller.send('案を考えて',{requestPurpose:'ideation'}),false);assert.deepEqual(work(f.state()),before);assert.equal(f.state().error.operation,'ideation');
 f.respond(answer());assert.equal(await f.controller.send('再度考えて'),true);assert.equal(f.state().error,null);assert.deepEqual(work(f.state()),before);
});

test('アイディアだけの会話は業務要件を作らず、追加提案の取込と明示採用は通常用途へ戻る',async()=>{
 const f=scenario();f.respond(answer());await f.controller.send('案を考えて',{requestPurpose:'ideation'});assert.equal(f.state().goal,'');assert.equal(f.state().adopted,null);assert.equal(f.count('plan'),0);
 f.controller.setRequestPurpose('consultation');const p=proposal();p.proposal.behaviors.push({id:'B3',origin:'suggestion',text:'確認期限を追加'});f.respond(p);await f.controller.send(REQUEST);
 const ref={taskId:f.state().taskId,version:f.state().version};f.controller.selectSuggestion('B3',true,ref);f.controller.setRequestPurpose('ideation');
 f.respond(proposal());await f.controller.updateSuggestions(ref);assert.equal(f.input().requestPurpose,'consultation');
 f.controller.setRequestPurpose('ideation');await f.controller.adopt();assert.equal(f.state().requestPurpose,'consultation');assert.equal(f.count('plan'),1);assert.equal(f.writes.length,0);
});

for(const phase of ['result','rollback-confirm']) for(const scope of ['app','environment']) test(phase+'で別'+scope+'の資料依頼を繰り返しても、拒否した設定を元の会話の基準にしない',async()=>{
 const {f,base}=materialScenario();await built(f);await f.controller.apply();if(phase==='rollback-confirm')await f.controller.requestRollback(f.state().resultRunId);
 const before=work(f.state()),count=f.count('propose');if(scope==='app')base.appId='another';else base.env='production';f.respond(answer());
 for(let i=0;i<2;i++){assert.equal(await f.controller.send('資料にして',{requestPurpose:'document'}),false);assert.equal(f.state().error.code,'CONSULTATION_ENVIRONMENT');assert.equal(f.count('propose'),count);assert.deepEqual(work(f.state()),before);}
 base.appId='test';base.env='preview';assert.equal(await f.controller.send('元の対象の資料にして'),true);assert.equal(f.count('propose'),count+1);
 assert.equal(JSON.parse(f.input().currentPlanSummary).source.appId,'test');assert.deepEqual(work(f.state()),before);
});

for(const purpose of ['consultation','document'])test('反映結果から'+purpose+'を繰り返しても旧計画を新しい設定の版でラベル付けしない',async()=>{
 const {f,base}=materialScenario();await built(f);await f.controller.apply();const before=work(f.state());f.respond(answer());base.stamp='preview:2';base.revision.preview='2';
 for(let i=0;i<2;i++){assert.equal(await f.controller.send('今の状態を説明して',{requestPurpose:purpose}),true);const s=JSON.parse(f.input().currentPlanSummary);
  assert.equal(s.source.baseStamp,'preview:1');assert.equal(s.source.revision,'1');assert.equal(s.source.matchesCurrentBase,false);assert.equal(f.input().base.revision.preview,'2');assert.deepEqual(work(f.state()),before);}
 assert.equal(f.count('apply'),1);
});
