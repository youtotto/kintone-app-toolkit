'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {KTReleaseWorkspace: Workspace}=require('../src/release-workspace.js');
const {KTReleaseExecution: Execution}=require('../src/release-execution.js');
const {loadToolkit}=require('./helpers/load-toolkit.js');
const {makeKintoneMock}=require('./helpers/kintone-preview-mock.js');
const {makeData}=require('./fixtures/ai-context-app.js');
const {proposal,plan,generated}=require('./helpers/release-workspace-fixture.js');
const clone=x=>JSON.parse(JSON.stringify(x));
function setup(withCode=true) {
 const T=loadToolkit(), data=makeData();
 data.fields.memo={code:'memo',label:'備考',type:'MULTI_LINE_TEXT'};
 data.customize={scope:'ALL',desktop:{js:[],css:[]},mobile:{js:[],css:[]}};
 const m=makeKintoneMock(data),counts={proposal:0,plan:0,generate:0};
 const p=withCode?plan({settings:false,platforms:['desktop']}):{steps:[{id:'P1',title:'金額を必須にする',actionType:'UPDATE_FIELD',targetRef:'amount',spec:{required:true}}],customizations:[],questions:[]};
 const loadBase=async()=>{const current=await m.current();current.appId='310';current.env='preview';return {ok:true,current,stamp:await Workspace.hash(current)};};
 const execution=Execution.create({appId:'310',api:m.api,loadBase,currentOf:b=>b.current,planExecutor:T.KTPlanExecutor,jsExecutor:T.KTJsExecutor,hash:Workspace.hash});
 const controller=Workspace.create({loadBase,execution,services:{
  propose:async()=>{counts.proposal++;return proposal();},
  plan:async()=>{counts.plan++;return {plan:clone(p)};},
  generate:async a=>{counts.generate++;return generated(a.customization);}
 }});
 const build=async()=>{await controller.send('備考の編集を制御してください');await controller.adopt();assert.equal(controller.getState().phase,'review',JSON.stringify(controller.getState().prepared?.reasons));};
 const writes=()=>m.calls.filter(c=>!c.startsWith('GET'));
 return {m,controller,counts,build,writes};
}

test('既存の実行部品で、一覧だけの並行変更を保ち、作成済みJSの無料再準備から承認へ戻れる',async()=>{
 const f=setup();await f.build();const counts=clone(f.counts);
 f.m.st.views['別の一覧']={name:'別の一覧',type:'LIST',index:'99',fields:['amount'],filterCond:'',sort:''};f.m.st.revision++;
 await f.controller.apply();assert.equal(f.controller.getState().error.code,'BASE_CHANGED');
 await f.controller.reprepare();assert.equal(f.controller.getState().phase,'review',JSON.stringify(f.controller.getState()));
 assert.deepEqual(f.counts,counts);assert.equal(f.writes().length,0);
 await f.controller.apply();assert.equal(f.controller.getState().runs[0].status,'complete');
 assert.ok(f.m.st.views['別の一覧']);assert.equal(f.m.st.customize.desktop.js.length,1);
});

for(const kind of ['field','status','script']) test(`検証の材料が変わる場合は、無料再準備で古い合格を持ち越さない: ${kind}`,async()=>{
 const f=setup();await f.build();const counts=clone(f.counts);
 if(kind==='field')f.m.st.fields.memo.type='SINGLE_LINE_TEXT';
 if(kind==='status')f.m.st.status.states['経理確認中']={name:'経理確認中',index:'5',assignee:{type:'ONE',entities:[]}};
 if(kind==='script')f.m.st.customize.desktop.js.push({type:'URL',url:'https://example.invalid/another.js'});
 f.m.st.revision++;await f.controller.apply();await f.controller.reprepare();
 const s=f.controller.getState();assert.equal(s.phase,'blocked');
 assert.ok(s.prepared.reasons.some(r=>r.code==='VERIFICATION_CONTEXT_CHANGED'));
 await f.controller.reprepare();assert.equal(f.controller.getState().phase,'blocked','繰り返しても古い検証へ新しい基準を付け替えない');
 assert.deepEqual(f.counts,counts);assert.equal(f.writes().length,0);assert.equal(await f.controller.apply(),false);
});

test('設定だけの案は最新の変更前を示して無料再準備し、関係ないフィールド変更を保持する',async()=>{
 const f=setup(false);await f.build();const counts=clone(f.counts);
 f.m.st.fields.case_name.label='別の作業による名前';f.m.st.revision++;
 await f.controller.apply();await f.controller.reprepare();
 assert.equal(f.controller.getState().phase,'review');assert.deepEqual(f.counts,counts);assert.equal(f.writes().length,0);
 await f.controller.apply();assert.equal(f.controller.getState().runs[0].status,'complete');
 assert.equal(f.m.st.fields.case_name.label,'別の作業による名前');assert.equal(f.m.st.fields.amount.required,true);
});
