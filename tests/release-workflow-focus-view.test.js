'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {KTReleaseWorkspace:W}=require('../src/release-workspace.js');
const {KTReleaseView:V}=require('../src/release-view.js');
const {KTBusinessConsultation:B}=require('../src/release-business-consultation.js');
const {fixture}=require('./helpers/release-workspace-fixture.js');
const F=require('./helpers/business-fixture.js');
const originalFetch=globalThis.fetch;
test.before(()=>{globalThis.fetch=()=>{throw Error('Network prohibited in workflow navigation tests');};});
test.after(()=>{globalThis.fetch=originalFetch;});
async function setup({legacy=false}={}){
 const {s}=await F.snapshot(),scope={domain:'fixture.cybozu.com',appId:'310'};
 const f=fixture({create:args=>W.create({...args,scope})},{propose:()=>({...(legacy?F.answer(s):F.workflowAnswer(s)),proposalUnchanged:true})});
 assert.equal(await f.controller.send('工程',{requestPurpose:'document',businessSnapshot:s,...(!legacy?{businessWorkflow:true}:{})}),true);
 return f;
}
const main=(s,options={})=>V.render(s,{connection:{canConsultBusiness:true},...options}).split('<main ')[1];
const overviews=html=>(html.match(/<section\b[^>]*class="[^"]*\bktr-workflow-overview\b[^>]*>/g)||[]).length;
const consultations=html=>(html.match(/<section\b[^>]*class="[^"]*\bktr-business-consultation\b[^>]*>/g)||[]).length;
const references=html=>(html.match(/class="[^"]*\bktr-business-context-reference\b/g)||[]).length;
const decode=value=>String(value).replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
function hostOf(){
 const listeners=new Map();let html='',input=null;
 const host={ownerDocument:{activeElement:null},querySelector:selector=>selector==='#kt-release-input'?input:null,querySelectorAll:()=>[],
  addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name),
  dispatch:async(name,target)=>listeners.get(name)?.({target,preventDefault(){}})};
 Object.defineProperty(host,'innerHTML',{get:()=>html,set(value){html=String(value);const match=/<textarea\b[^>]*id="kt-release-input"([^>]*)>([\s\S]*?)<\/textarea>/.exec(html);input=match?{id:'kt-release-input',value:decode(match[2]),disabled:/\sdisabled\b/.test(match[1]),selectionStart:0,selectionEnd:0,focus(){host.ownerDocument.activeElement=input;},setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b;}}:null;}});
 return host;
}
async function click(host,action,id,extra={}){await host.dispatch('click',{dataset:{releaseAction:action,...(id?{releaseId:id}:{}),...extra},disabled:false});}
const preserved=s=>({context:s.businessContext,archive:s.businessArchive,result:s.businessResult,selected:s.businessSelectedIds,mode:s.businessMode,drafts:s.businessAnswerDrafts,explanations:s.explanations,proposal:s.proposal,adopted:s.adopted,plan:s.plan,prepared:s.prepared});
const callCounts=f=>Object.fromEntries(['propose','loadBase','plan','generate','prepare','apply'].map(name=>[name,f.count(name)]));
test('工程の元資料は概要が先で、取得状態と根拠一覧は閉じて保持する',async()=>{
 const f=await setup(),html=main(f.controller.getState());
 assert.ok(html.indexOf('class="ktr-workflow-overview"')<html.indexOf('class="ktr-business-inventory"'));
 assert.match(html,/<details class="ktr-business-inventory" data-release-panel="[^"]+"><summary>設定の取得状態・根拠一覧/);
 assert.match(html,/設定で確認できること|設定の取得状態/);
 assert.equal(f.writes.length,0);
});
test('業務相談では空の変更案を表示せず、工程の相談見出しを表示する',async()=>{
 const f=await setup();assert.equal(await f.controller.startBusiness(f.controller.getState().explanationId),true);
 const html=main(f.controller.getState());
 assert.match(html,/業務工程と相談/);assert.match(html,/ktr-workflow-overview/);
 assert.doesNotMatch(html,/ここに変更案を表示します|相談すると、ここに案を表示します/);
 assert.equal(f.count('propose'),1);assert.equal(f.writes.length,0);
});
test('処理中の中断と停止理由は長い工程より前で表示する',async()=>{
 const f=await setup();await f.controller.startBusiness(f.controller.getState().explanationId);
 const state=f.controller.getState(),busy=main({...state,phase:'consulting'});
 assert.ok(busy.indexOf('data-release-action="cancel"')<busy.indexOf('class="ktr-business-workflow-source"'));
 const blocked=main({...state,phase:'blocked',prepared:{reasons:['確認が必要な条件']}});
 assert.ok(blocked.indexOf('確認が必要な条件')<blocked.indexOf('class="ktr-business-workflow-source"'));
});

test('同じ工程資料を開いても概要を重ねず、相談元と復帰操作・資料の保存を保持する',async()=>{
 const f=await setup(),c=f.controller,id=c.getState().explanationId;
 assert.equal(await c.startBusiness(id,'R1'),true);assert.equal(c.showExplanation(id),true);
 const before=F.clone(c.getState()),html=main(before);
 assert.equal(overviews(html),1);assert.equal(consultations(html),0);assert.equal(references(html),1);
 assert.match(html,/相談の参照元：/);assert.match(html,/表示資料を開くだけでは、相談の参照元は切り替わりません。/);
 for(const action of ['show-changes','copy-explanation','download-explanation'])assert.match(html,new RegExp('data-release-action="'+action+'"'));
 assert.match(html,/data-release-stage="explanation"/);
 assert.deepEqual(c.getState(),before);assert.equal(f.count('propose'),1);assert.equal(f.writes.length,0);
});

test('説明と工程相談の往復は未送信入力・回答・下書き・選択工程と送信範囲を変えない',async()=>{
 const f=await setup(),c=f.controller,id=c.getState().explanationId;
 await c.startBusiness(id,'R1');
 assert.equal(c.recordBusiness({kind:'current_operation',text:'担当者が内容を確認します',sourceQuestionRef:{analysisId:id,questionId:'source:R1:0'}}),true);
 assert.equal(c.recordBusiness({kind:'desired_change',text:'確認結果を残したい'}),true);assert.equal(c.selectBusinessChange('BS2',true),true);
 assert.equal(c.setBusinessDraft('source:R1:0','確認中の回答下書き'),true);assert.equal(c.setBusinessDraft('new','まだ記録していない補足'),true);
 c.setRequestPurpose('document');
 const before=F.clone(preserved(c.getState())),wire=F.clone(B.wire(c.getState().businessContext)),counts=callCounts(f);
 const host=hostOf(),view=V.create(host,{controller:c,connection:{canConsultBusiness:true}});
 try{
  view.setDraft('送信していない相談文');
  for(let repeat=0;repeat<2;repeat++){
   await click(host,'show-explanation',id);assert.equal(c.getState().explanationId,id);
   assert.equal(c.getState().requestPurpose,'document');
   assert.equal(overviews(host.innerHTML),1);assert.equal(consultations(host.innerHTML),0);
   assert.equal(host.querySelector('#kt-release-input').value,'送信していない相談文');
   await click(host,'show-changes');assert.equal(c.getState().explanationId,null);
   assert.equal(c.getState().requestPurpose,'document');
   assert.equal(overviews(host.innerHTML),1);assert.equal(consultations(host.innerHTML),1);assert.equal(references(host.innerHTML),0);
   assert.match(host.innerHTML,/確認中の回答下書き|担当者が内容を確認します/);
   assert.equal(host.querySelector('#kt-release-input').value,'送信していない相談文');
  }
  assert.deepEqual(preserved(c.getState()),before);assert.deepEqual(B.wire(c.getState().businessContext),wire);
  assert.deepEqual(callCounts(f),counts);assert.equal(f.writes.length,0);
 }finally{view.dispose();}
});

test('別の工程資料を開いても相談元を変更せず、表示資料だけの概要と参照元の案内を示す',async()=>{
 const f=await setup(),c=f.controller,id=c.getState().explanationId;await c.startBusiness(id,'R1');
 const state=c.getState(),other=F.clone(state.explanations.find(e=>e.id===id));other.id='explanation-other';other.title='別時点の業務工程';other.businessUnderstanding.rules[0].stageName='別資料だけの工程名';
 state.explanations.push(other);state.explanationId=other.id;
 const before=F.clone(state),wire=F.clone(B.wire(state.businessContext)),html=main(state);
 assert.equal(overviews(html),1);assert.equal(consultations(html),0);assert.equal(references(html),1);
 assert.match(html,/別資料だけの工程名/);assert.match(html,/相談の参照元：/);
 assert.match(html,/表示資料を開くだけでは、相談の参照元は切り替わりません。/);
 assert.equal(state.businessContext.analysisId,id);assert.deepEqual(B.wire(state.businessContext),wire);assert.deepEqual(state,before);
 const back=main({...state,explanationId:null});assert.equal(overviews(back),1);assert.equal(consultations(back),1);assert.doesNotMatch(back,/別資料だけの工程名/);
});

test('資料表示中の処理は中断を先に示し、停止理由や相談の再確認警告を隠さない',async()=>{
 const f=await setup(),c=f.controller,id=c.getState().explanationId;await c.startBusiness(id,'R1');c.showExplanation(id);
 const state=c.getState();
 for(const phase of ['consulting','building','preparing']){
  const html=main({...state,phase});assert.equal(overviews(html),1);assert.equal(consultations(html),0);
  assert.ok(html.indexOf('data-release-action="cancel"')>=0);assert.ok(html.indexOf('data-release-action="cancel"')<html.indexOf('class="ktr-workflow-overview"'));
  for(const action of ['show-explanation','show-changes'])assert.match(html,new RegExp('data-release-action="'+action+'"[^>]* disabled'));
 }
 const blocked=main({...state,phase:'blocked',prepared:{reasons:['業務条件の照合が必要です']}});
 assert.equal(overviews(blocked),1);assert.ok(blocked.indexOf('業務条件の照合が必要です')>=0);assert.ok(blocked.indexOf('業務条件の照合が必要です')<blocked.indexOf('class="ktr-workflow-overview"'));
 assert.doesNotMatch(blocked,/data-release-action="reprepare"/);
 const invalid=main({...state,businessInvalid:'元資料の参照を確認できません'});
 assert.equal(overviews(invalid),1);assert.match(invalid,/相談の参照元は未確認のため、相談できません/);assert.match(invalid,/個人別.*実効権限/);
 assert.match(main({...state,explanationId:null,businessInvalid:'元資料の参照を確認できません'}),/元資料の参照を確認できません/);
 for(const rules of [{},[null],[null,{ruleId:'R1',stageName:'保存された選択工程'}]]){
  const damaged=F.clone(state);damaged.businessInvalid='保存した参照が不正です';damaged.businessContext.analysis.rules=rules;
  let html;assert.doesNotThrow(()=>{html=main(damaged);});assert.match(html,/相談の参照元は未確認のため、相談できません/);assert.equal(overviews(html),1);assert.equal(consultations(html),0);
 }
 const review=main({...state,businessReviewRequired:true});assert.match(review,/採用時の前提|運用の前提/);assert.match(review,/再確認/);
});

test('過去の反映記録が選ばれたら工程資料と相談を重ねず、現在へ戻る状態を保持する',async()=>{
 const f=await setup(),c=f.controller,id=c.getState().explanationId;await c.startBusiness(id,'R1');c.setBusinessDraft('new','履歴を見ても残す入力');c.showExplanation(id);
 const state=c.getState(),run={id:'past-run',taskId:0,status:'complete',goal:'以前の確認',archived:true,result:{status:'complete',message:'保存済みの反映記録',written:0}};state.runs=[run];
 const before=F.clone(state),html=main(state,{selectedRunId:run.id});
 assert.equal(overviews(html),0);assert.equal(consultations(html),0);assert.equal(references(html),0);
 assert.match(html,/保存済みの反映記録/);assert.match(html,/data-release-action="current"/);assert.match(html,/data-release-stage="result"/);
 assert.doesNotMatch(html,/data-release-action="business-(?:start|record)"/);assert.deepEqual(state,before);
 assert.equal(overviews(main(state)),1);assert.equal(state.businessContext.selection.ruleId,'R1');
 assert.equal(c.getBusinessDraft('new'),'履歴を見ても残す入力');assert.equal(f.writes.length,0);
});

test('不明な説明IDは既存の選択を壊さず、旧ルールの相談には工程図を追加しない',async()=>{
 const f=await setup(),c=f.controller,id=c.getState().explanationId;await c.startBusiness(id,'R1');c.showExplanation(id);
 const before=F.clone(c.getState());assert.equal(c.showExplanation('missing-document'),false);assert.deepEqual(c.getState(),before);
 const stale=main({...before,explanationId:'missing-document'});assert.equal(overviews(stale),1);assert.equal(consultations(stale),1);assert.equal(references(stale),0);
 const legacy=await setup({legacy:true}),old=legacy.controller,oldId=old.getState().explanationId;await old.startBusiness(oldId,'R1');old.showExplanation(oldId);
 const oldBefore=F.clone(old.getState()),oldHtml=main(oldBefore);assert.equal(overviews(oldHtml),0);assert.equal(consultations(oldHtml),0);assert.equal(references(oldHtml),1);
 assert.match(oldHtml,/推測した業務ルール候補/);old.showChanges();const oldBack=main(old.getState());
 assert.equal(overviews(oldBack),0);assert.equal(consultations(oldBack),1);assert.deepEqual(old.getState().businessContext,oldBefore.businessContext);
});

test('同じ参照元で相談開始が成功したときだけ工程相談へ戻り、失敗では表示資料を残す',async()=>{
 const f=await setup(),c=f.controller,id=c.getState().explanationId;await c.startBusiness(id,'R1');c.setBusinessDraft('new','同じ相談で残す下書き');c.showExplanation(id);c.setRequestPurpose('document');
 const before=F.clone(preserved(c.getState())),counts=callCounts(f),host=hostOf();let view=V.create(host,{controller:c,connection:{canConsultBusiness:true}});
 try{
  await click(host,'business-start',id,{businessRule:'R1'});
  assert.equal(c.getState().explanationId,null);assert.equal(consultations(host.innerHTML),1);assert.equal(overviews(host.innerHTML),1);
  assert.equal(c.getState().requestPurpose,'consultation');
  assert.deepEqual(preserved(c.getState()),before);assert.deepEqual(callCounts(f),counts);
  view.dispose();c.showExplanation(id);c.setRequestPurpose('document');let attempted=0,returned=0;
  const rejected={...c,startBusiness:async()=>{attempted++;return false;},showChanges:()=>{returned++;return c.showChanges();}};
  view=V.create(host,{controller:rejected,connection:{canConsultBusiness:true}});
  await click(host,'business-start',id,{businessRule:'R1'});
  assert.equal(attempted,1);assert.equal(returned,0);assert.equal(c.getState().explanationId,id);
  assert.equal(c.getState().requestPurpose,'document');
  assert.equal(overviews(host.innerHTML),1);assert.equal(consultations(host.innerHTML),0);
  assert.deepEqual(preserved(c.getState()),before);assert.deepEqual(callCounts(f),counts);assert.equal(f.writes.length,0);
 }finally{view.dispose();}
});
