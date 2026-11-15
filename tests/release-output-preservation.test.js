'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadToolkit}=require('./helpers/load-toolkit.js');
const {KTReleaseWorkspace:W}=require('../src/release-workspace.js');
const {KTReleaseView:V}=require('../src/release-view.js');
const {KTReleaseContext:C}=require('../src/release-context.js');
const F=require('./helpers/release-workspace-fixture.js');
const T=loadToolkit({verificationBudget:true}),plain=x=>JSON.parse(JSON.stringify(x));
const long=label=>label+'の条件をすべて保持します。'.repeat(30)+'【'+label+'末尾】';
const base={ok:true,appId:'310',env:'preview',data:{fields:{properties:{memo:{type:'MULTI_LINE_TEXT',code:'memo',label:'備考'}}}},files:[]};
function completeProposal(){
 const r=F.proposal('説明を保持します。'.repeat(200)+'【回答末尾】');
 r.proposal.behaviors=Array.from({length:10},(_,i)=>({id:'B'+(i+1),text:long('動作'+i),origin:'user'}));
 r.proposal.assumptions=Array.from({length:10},(_,i)=>({id:'A'+(i+1),key:'assumption.'+i,label:long('前提名'+i),text:long('前提'+i),changeHint:long('変更'+i)}));
 r.proposal.decisions=Array.from({length:6},(_,i)=>({id:'Q'+(i+1),key:'decision.'+i,label:long('質問名'+i),question:long('質問'+i),options:Array.from({length:7},(_,j)=>long('選択'+i+'_'+j)),recommendation:long('推奨'+i),impact:long('影響'+i),blocking:true}));
 r.proposal.approach={standard:Array.from({length:8},(_,i)=>long('標準'+i)),js:Array.from({length:8},(_,i)=>long('JS'+i))};
 r.proposal.cannot=Array.from({length:8},(_,i)=>long('対象外'+i));
 return r;
}
test('完成した相談回答をクライアント・表示・保存復元・次回送信まで切り詰めない',async()=>{
 const raw=completeProposal();
 const received=T.KTAiClient.receive('proposal',{...raw,ok:true,contractVersion:'2.1',meta:{}});
 assert.equal(received.reply,raw.reply);assert.deepEqual(plain(received.proposal),raw.proposal);
 const f=F.fixture(W,{propose:()=>received});await f.controller.send('条件を追加してください');
 const s=f.controller.getState();assert.deepEqual(plain(s.proposal),raw.proposal);
 assert.equal(s.messages.find(m=>m.role==='assistant').text,raw.reply);
 // proposalHtml shows behaviors, assumptions, questions and constraints; approach is retained for the next request.
 const html=V.render(s);for(const tail of ['回答末尾','動作9末尾','前提9末尾','質問5末尾','選択5_6末尾','対象外7末尾'])assert.ok(html.includes(tail),tail);
 assert.deepEqual(s.proposal.approach,raw.proposal.approach);
 assert.equal(s.proposal.approach.standard[7],long('標準7'));assert.equal(s.proposal.approach.js[7],long('JS7'));
 const saved=plain(f.controller.exportSession());const again=F.fixture(W);
 assert.equal(await again.controller.restoreSession(saved),true);
 assert.deepEqual(again.controller.getState().proposal,raw.proposal);
 let next;
 again.services.propose=async args=>{next=C.proposal({...args,base});return {...received,intent:'question',proposalUnchanged:true};};
 await again.controller.send('質問内容を確認しました');
 assert.deepEqual(next.conversation.proposal,raw.proposal);
 assert.equal(next.conversation.discussion.find(m=>m.role==='assistant').text,raw.reply);
 assert.equal(f.writes.length+again.writes.length,0);
 assert.equal(f.count('plan')+again.count('plan'),0);
});
test('計画とJS差分の末尾をクライアントが落とさない',()=>{
 const plan=F.plan({platforms:Array.from({length:9},()=> 'desktop')});
 plan.assessment.summary=long('計画').repeat(6);
 const p=T.KTAiClient.receive('plan',{ok:true,contractVersion:'2.1',plan,meta:{}});
 assert.equal(p.customizations.length,9);assert.equal(p.assessment.summary,plan.assessment.summary);assert.deepEqual(plain(p.gatewayPlan),plan);
 const generated=F.generated(plan.customizations[0]);generated.strategy='EXTEND_EXISTING_JS';
 generated.summary=long('生成結果').repeat(6);generated.patch={operations:Array.from({length:10},(_,i)=>({op:'insertAfter',anchor:'anchor'+i,code:'// patch '+i}))};
 const {verification,...body}=generated;
 const g=T.KTAiClient.receive('generated',{ok:true,contractVersion:'2.1',generated:body,verification,meta:{}});
 assert.deepEqual(plain(g.patch),generated.patch);assert.equal(g.summary,generated.summary);
});
test('長い回答の返送でも根拠を削らず、通常相談の入力容量超過は明示して止める',()=>{
 const ctx=C.proposal({text:'続きを相談します',previous:completeProposal().proposal,base});assert.ok(ctx.facts.length>0);
 const oversized=completeProposal().proposal;oversized.behaviors[0].text='あ'.repeat(100000);
 assert.throws(()=>C.proposal({text:'続きを相談します',previous:oversized,base}),e=>e.code==='CONTEXT_TOO_LARGE');
});
test('API上限未指定と検証費用用の最大出力を混同せず、通常相談を4000へ戻さない',()=>{
 const lf={model:'gpt-6-luna',maxOutputTokens:4000,maxOutputTokensByPurpose:{consultation:null,diagnosis:12000},outputTokenBudgetBoundByPurpose:{consultation:128000,diagnosis:12000},modelsByPurpose:{diagnosis:'gpt-6.1-sol'},maxAiCalls:1};
 const limits={features:{'assistant-qa':lf}};
 for(const ctx of [{},{requestPurpose:'consultation'}]){
  const e=T.KTAiBudget.estimate({kind:'propose',ctx,limits,ctxBytes:1000});assert.equal(e.ok,true);assert.equal(e.apiMaxOutputTokens,null);assert.equal(e.outputTokenBudgetBound,128000);assert.equal(e.calls[0].output,128000);assert.ok(e.maxUsd>0.064);
  const bound=T.KTAiBudget.gatewayBound({kind:'propose',ctx,limits,bodyBytes:1000});assert.equal(bound.apiMaxOutputTokens,null);assert.equal(bound.outputTokenBudgetBound,128000);assert.ok(bound.maxUsd>0.064);
 }
 const diagnosis=T.KTAiBudget.estimate({kind:'propose',ctx:{focus:{target:{type:'app-diagnosis'}}},limits});assert.equal(diagnosis.maxOutputTokens,12000);assert.equal(diagnosis.apiMaxOutputTokens,12000);
 delete lf.outputTokenBudgetBoundByPurpose;
 const unknown=T.KTAiBudget.estimate({kind:'propose',ctx:{requestPurpose:'consultation'},limits});assert.equal(unknown.ok,false);assert.equal(unknown.reason,'unknown-bound');
 delete lf.maxOutputTokensByPurpose;
 assert.equal(T.KTAiBudget.estimate({kind:'propose',limits}).maxOutputTokens,4000);
});
