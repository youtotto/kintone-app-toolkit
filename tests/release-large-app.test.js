'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadToolkit}=require('./helpers/load-toolkit.js');
const T=loadToolkit({ verificationBudget: true }),C=T.KTReleaseContext,F=require('./helpers/business-fixture.js');
const {KTReleaseWorkspace:W}=require('../src/release-workspace.js'),WF=require('./helpers/release-workspace-fixture.js');
const {KTReleaseView:V}=require('../src/release-view.js');
const clone=x=>JSON.parse(JSON.stringify(x));
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):x;
const sort=xs=>Array.from(xs,x=>JSON.stringify(canonical(x))).sort();
const fields=n=>Object.fromEntries(Array.from({length:n},(_,i)=>['f'+i,{code:'f'+i,label:'項目'+i,type:'SINGLE_LINE_TEXT',defaultValue:'',required:i%2===0}]));
const base=n=>({ok:true,env:'preview',appId:'310',revision:{preview:'12'},loadedAt:'2026-11-02T00:00:00Z',data:{fields:fields(n),views:{views:{all:{name:'一覧',type:'LIST',fields:Object.keys(fields(n)),filterCond:'',sort:''}}}},files:[],errors:[]});
const tools={analyze:T.KTDevBase.analyze,factFromEdge:T.KTContext.factFromEdge,findBrokenRefs:T.KTDeps.findBrokenRefs,calcChainStats:T.KTDeps.calcChainStats};
const diagnose=b=>C.proposal({text:'診断',requestPurpose:'ideation',diagnosis:true,base:b},tools);
test('400フィールドと依存関係を共通属性でまとめ、全値・確かさ・未確認を保ってWorkerが受理する',async()=>{
 const b=base(400),ctx=diagnose(b);assert.ok(ctx.facts.length<500);assert.equal(ctx.truncation.applied,false);
 const expanded=ctx.facts.flatMap(f=>f.kind==='evidence-group'?f.value.items.map(item=>({...f.value.shared,...item})):[f]);
 assert.equal(expanded.filter(f=>f.kind==='field').length,400);
 assert.deepEqual(sort(expanded.filter(f=>f.kind==='field').map(f=>f.value)),sort(Object.values(b.data.fields)));
 const current=clone(b);T.KTDevBase.analyze(current);
 const depFacts=expanded.filter(f=>['dependency','js-reference'].includes(f.kind));assert.equal(depFacts.length,current.deps.edges.length);assert.ok(depFacts.length>=400);
 for(const d of depFacts){assert.equal(d.provenance.revision,'12');assert.equal(d.provenance.environment,'preview');}
 const {validateToolkitContext}=await import(require('./helpers/ai-repo.js').aiUrl('worker/src/v2/toolkit/validate-context.mjs'));
 assert.equal(validateToolkitContext(ctx).ok,true,JSON.stringify(validateToolkitContext(ctx).errors));
 const group=ctx.facts.find(f=>f.kind==='evidence-group');
 for(const mutate of [x=>x.value.count++,x=>x.value.shared.confidence='UNCERTAIN',x=>x.value.items=[],x=>x.value.items[0].id='E999']){
  const bad=clone(ctx);mutate(bad.facts.find(f=>f.id===group.id));assert.equal(validateToolkitContext(bad).ok,false);
 }
 assert.throws(()=>C.proposal({text:'変更相談',base:b},tools),e=>e.code==='CONTEXT_TOO_LARGE','変更経路の契約は勝手に緩めない');
 assert.ok(ctx.facts.find(f=>f.kind==='dependency-coverage').value.unchecked.length);
});
test('同じkindでも異なる確かさを混同せず共通情報から元の根拠に戻せる',()=>{
 const b=base(2),facts=Array.from({length:620},(_,i)=>({kind:i%2?'dependency':'js-reference',confidence:i%3?'LIKELY':'UNCERTAIN',statement:'参照'+i,source:{id:'view'+i},target:{id:'f'+i%2},basis:i%2?'setting':'code',provenance:{environment:'preview',revision:'12'},value:i%5?null:{code:'f1'}}));
 const compact=C.factsOf(b,{facts},[],null,true),expanded=compact.flatMap(f=>f.kind==='evidence-group'?f.value.items.map(x=>({...f.value.shared,...x})):[f]).filter(f=>['dependency','js-reference'].includes(f.kind)).map(({id,...f})=>f);
 assert.deepEqual(sort(expanded),sort(facts));assert.equal(new Set(compact.map(f=>f.id)).size,compact.length);
 for(const g of compact.filter(f=>f.kind==='evidence-group')) for(const item of g.value.items)assert.equal(({...g.value.shared,...item}).confidence,g.confidence);
});
test('共有化しても送信上限を超えるJSは切り捨てず入力バイト数を表示して止める',()=>{
 const b=base(2);b.files=[{env:'preview',type:'FILE',name:'large.js',target:'desktop',text:'x'.repeat(1100000)}];
 assert.throws(()=>diagnose(b),e=>e.code==='CONTEXT_TOO_LARGE'&&e.details.reason==='INPUT_BYTES'&&e.details.bytes>e.details.limit&&/AIには送信していません/.test(e.message));
});
test('業務理解は500超のフィールドでも個別根拠IDと取得状態を保持し共通属性だけまとめる',async()=>{
 const data=F.raw();data.fields.properties=fields(600);const {s}=await F.snapshot({data});assert.ok(s.evidence.length>600);assert.deepEqual(F.C.validateSnapshot(s),[]);
 const {compactBusinessSnapshot}=await import(require('./helpers/ai-repo.js').aiUrl('worker/src/v2/toolkit/business-understanding.mjs'));
 const before=JSON.stringify(s),p=compactBusinessSnapshot(s),expanded=p.evidenceGroups.flatMap(g=>g.items.map(x=>({...g.shared,...x})));
 assert.deepEqual(sort(expanded),sort(s.evidence));assert.equal(JSON.stringify(s),before);assert.deepEqual(p.categories,s.categories);assert.deepEqual(p.limitations,s.limitations);
 assert.ok(Buffer.byteLength(JSON.stringify(p))<Buffer.byteLength(before));
});
test('purpose別の出力上限を費用事前見積もりに使用、旧healthでは互換値を使用',()=>{
 const lf={model:'gpt-6-luna',modelsByPurpose:{diagnosis:'gpt-6.1-sol',business:'gpt-6-astra'},maxOutputTokens:4000,maxOutputTokensByPurpose:{diagnosis:12000,business:16000},maxAiCalls:1},limits={features:{'assistant-qa':lf}};
 for(const [ctx,out] of [[{focus:{target:{type:'app-diagnosis'}}},12000],[{businessSnapshot:{}},16000],[{requestPurpose:'consultation'},4000]]){
  const e=T.KTAiBudget.estimate({kind:'propose',ctx,limits,ctxBytes:1000});assert.equal(e.ok,true);assert.equal(e.maxOutputTokens,out);assert.equal(e.calls[0].output,out);
 }
 delete lf.maxOutputTokensByPurpose;assert.equal(T.KTAiBudget.estimate({kind:'propose',ctx:{businessSnapshot:{}},limits,ctxBytes:1000}).maxOutputTokens,4000);
});
for(const [name,code,details,label]of [['入力','CONTEXT_TOO_LARGE',{reason:'INPUT_BYTES',bytes:270000,limit:262144},'送信する設定が入力上限'],['出力','MODEL_OUTPUT_INVALID',{error:{detail:{reason:'OUTPUT_TRUNCATED'}}},'AIの回答が出力上限で途中終了'],['形式','MODEL_OUTPUT_INVALID',{error:{detail:{reason:'INVALID_JSON'}}},'AIの応答形式を確認できません']])test(name+'の失敗理由を保存しヘッダーにも表示、自動再試行・反映なし',async()=>{
 let calls=0;const f=WF.fixture(W,{propose:async()=>{calls++;throw Object.assign(new Error('offline failure'),{code,details});}});
 await f.controller.send('診断',{requestPurpose:'ideation',diagnosis:true});const s=f.controller.getState();
 assert.equal(calls,1);assert.equal(f.writes.length,0);assert.equal(s.error.code,code);assert.deepEqual(s.error.detail,details);assert.match(V.render(s),new RegExp(label));
 if(name==='出力')assert.match(s.error.message,/出力上限.*再実行するとAIを呼び直します/);
 const saved=f.controller.exportSession().state.error;assert.equal(saved.code,s.error.code);assert.equal(saved.message,s.error.message);assert.equal(saved.detail.reason,(details.error?.detail||details).reason);assert.match(V.render({...s,error:saved}),new RegExp(label));
});

test('業務根拠2000件の境界、超過は保存可能だが送信不可',async()=>{
 const data=F.raw(),{s:seed}=await F.snapshot({data}),other=seed.evidence.filter(e=>e.category!=='fields').length;
 data.fields.properties=fields(2000-other);const {s}=await F.snapshot({data});assert.equal(s.evidence.length,2000);assert.deepEqual(F.C.validateSnapshot(s),[]);
 data.fields.properties.extra={code:'extra',label:'追加',type:'DATE'};const {s:over}=await F.snapshot({data});
 assert.ok(F.C.validateSnapshot(over).some(x=>x.includes('2000')));assert.deepEqual(F.C.validateSnapshot(over,{generatable:false}),[]);
 assert.throws(()=>F.C.context(over),e=>e.code==='CONTEXT_TOO_LARGE');
});
