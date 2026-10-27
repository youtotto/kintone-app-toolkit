'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadToolkit}=require('./helpers/load-toolkit.js');
const {makeEnvGetter}=require('./helpers/dev-base-fake.js');
const F=require('./helpers/release-workspace-fixture.js');
const {KTReleaseWorkspace:W}=require('../src/release-workspace.js');
const {KTReleaseContext:C}=require('../src/release-context.js');
const {KTReleaseEnvironmentDiff:D}=require('../src/release-environment-diff.js');
const {KTReleaseEnvironmentView:V}=require('../src/release-environment-view.js');
const response=()=>({reply:'未反映の変更をまとめました。',intent:'question',proposalUnchanged:true,turn:{ops:[],answers:[],requirementOps:[]},explanation:{title:'未反映の変更',sections:[{heading:'変更内容',paragraphs:['比較できた範囲の内容です。'],items:[],evidenceIds:['E1']}],unknowns:[]}});
async function setup(){
 const prod={fields:{memo:{code:'memo',label:'備考',type:'MULTI_LINE_TEXT'}},settings:{name:'test',description:''}},preview=F.clone(prod);preview.fields.memo.required=true;
 const T=loadToolkit(),b=await T.KTDevBase.loadForRelease({appId:'398',...makeEnvGetter({production:prod,preview})});b.stamp=T.KTDevBase.stamp(b);b.current=T.KTDevBase.currentOf(b);
 let current=b,ctx=null,requests=0;
 const f=F.fixture(W,{loadBase:()=>F.clone(current),propose:args=>{if(args.requestPurpose!=='document')return F.proposal();ctx=C.proposal(args);requests++;return response();}});
 return{...f,b,input:()=>ctx,requests:()=>requests,setBase:value=>{current=value;}};
}
const retained=s=>({proposal:s.proposal,version:s.version,goal:s.goal,adopted:s.adopted,plan:s.plan,prepared:s.prepared,answers:s.answers,runs:s.runs});
test('比較の説明は採用済みの案・準備・対象を保ち、業務要件へ加えない',async()=>{
 const f=await setup();await f.controller.send(F.REQUEST);await f.controller.adopt();assert.equal(f.controller.getState().phase,'review');const before=retained(f.controller.getState());
 assert.equal(await f.controller.send('未反映の変更の説明',{requestPurpose:'document',consultationTarget:null,environmentComparison:{key:V.keyOf(D.compare(f.b)),localEdits:{available:true,files:[]}}}),true);
 assert.deepEqual(retained(f.controller.getState()),before);assert.equal(f.requests(),1);assert.equal(f.count('plan'),1);assert.equal(f.count('apply'),0);
 assert.deepEqual(f.input().conversation.acceptedProposal,before.adopted);assert.ok(!f.input().conversation.userRequests.includes('未反映の変更の説明'));assert.equal(f.input().facts.some(x=>x.kind==='field'),false,'無関係な現在設定を重複して送らない');
});
test('一覧を表示した後に設定が変わるとAIを呼ばず、古い採用の準備も使わない',async()=>{
 const f=await setup();await f.controller.send(F.REQUEST);await f.controller.adopt();const before=f.controller.getState().adopted,key=V.keyOf(D.compare(f.b));
 const next=F.clone(f.b);next.revision.preview='13';for(const value of Object.values(next.comparisonInputs.preview))value.revision='13';next.data.fields.memo.label='修正した備考';next.comparisonInputs.preview.fields.properties.memo.label='修正した備考';next.stamp=loadToolkit().KTDevBase.stamp(next);f.setBase(next);
 assert.equal(await f.controller.send('説明',{requestPurpose:'document',consultationTarget:null,environmentComparison:{key}}),false);assert.equal(f.requests(),0);const s=f.controller.getState();assert.equal(s.error.code,'BASE_CHANGED');assert.equal(s.prepared,null);assert.deepEqual(s.adopted,before);assert.equal(f.count('apply'),0);
});
test('比較の未取得範囲と未登録編集のメタデータを分け、本文・キーを送らない',async()=>{
 const f=await setup(),result=D.compare(f.b),localEdits={available:true,files:[{name:'draft.js',target:'mobile',kind:'js',environment:'preview',state:'edited',text:'PRIVATE',fileKey:'SECRET'}]};
 const ctx=C.proposal({text:'説明',requestPurpose:'document',base:f.b,environmentComparison:{key:V.keyOf(result),localEdits}});
 assert.equal(ctx.coverage.dependencies,false);assert.ok(ctx.facts.find(x=>x.kind==='env-diff-coverage').value.categories.some(x=>x.status==='unavailable'));assert.doesNotMatch(JSON.stringify(ctx),/PRIVATE|SECRET/);assert.deepEqual(ctx.facts.at(-1).value.files,[{name:'draft.js',kind:'js',target:'mobile',environment:'preview',state:'edited'}]);
 const later=F.clone(f.b);later.loadedAt='2099-01-01T00:00:00Z';assert.equal(V.keyOf(D.compare(later)),V.keyOf(result),'時刻だけ取り直して同じ内容なら説明できる');
});
test('比較に必要な情報を制限内へ黙って切り詰めず、AI送信前に知らせる',async()=>{
 const f=await setup();for(let i=0;i<510;i++)f.b.comparisonInputs.preview.fields.properties['f'+i]={code:'f'+i,label:'追加'+i,type:'SINGLE_LINE_TEXT'};
 assert.throws(()=>C.proposal({text:'説明',requestPurpose:'document',base:f.b,environmentComparison:{key:V.keyOf(D.compare(f.b))}}),{code:'CONTEXT_TOO_LARGE'});
});
