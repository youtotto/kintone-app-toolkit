'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {KTAnalysisInput:A}=require('../src/release-analysis-input.js');
const {loadToolkit}=require('./helpers/load-toolkit.js');
const {KTReleaseWorkspace:W}=require('../src/release-workspace.js'),WF=require('./helpers/release-workspace-fixture.js');
const {KTReleaseView:V}=require('../src/release-view.js'),F=require('./helpers/business-fixture.js');
const clone=x=>JSON.parse(JSON.stringify(x));
// Independent decoder: round-trip assertions must not mirror production unpack.
function inverse(p){if(p.encoding!==A.FORMAT)return p;const values=[];function read(x){if(Array.isArray(x))return x.map(read);if(x&&typeof x==='object'){if('r'in x)return clone(values[x.r]);return Object.fromEntries(p.shapes[x.s].map((k,i)=>[k,read(x.v[i])]));}return x;}for(const v of p.shared)values.push(read(v));return read(p.data);}
test('共通化で根拠ID・順序・値・取得状態・特殊キーを完全に保持',()=>{
 const source=JSON.parse('{"__proto__":{"safe":true},"a/b~c":null}');
 const original={source,rows:Array.from({length:700},(_,i)=>({id:'E'+i,confidence:i%2?'CERTAIN':'UNCERTAIN',source:{file:'条件確認.js',text:'// 同じ本文を参照する根拠\n'.repeat(50)},pointer:'/a~1b~0c',empty:null,value:[false,0,'',i]}))};
 const before=JSON.stringify(original),packed=A.prepare(original);
 assert.equal(packed.encoding,A.FORMAT);assert.ok(A.bytes(packed)<A.bytes(original)/2);
 assert.deepEqual(inverse(packed),original);assert.deepEqual(A.unpack(packed),original);assert.equal(JSON.stringify(original),before);assert.equal({}.safe,undefined);
});
test('不正参照・循環・形の不一致・展開爆発をAI送信前に拒否',()=>{
 const p=A.pack({rows:Array.from({length:30},(_,i)=>({id:i,text:'a'.repeat(200)}))});assert.equal(p.encoding,A.FORMAT);
 for(const mutate of [x=>x.data={r:99999},x=>x.shared.unshift({r:0}),x=>x.shapes[0]=['x','x'],x=>x.data={s:0,v:[]},x=>x.data={s:0,v:[],extra:true}]){const bad=clone(p);mutate(bad);assert.throws(()=>A.unpack(bad));}
 const bomb={encoding:A.FORMAT,shapes:[],shared:['x'.repeat(2000)],data:Array.from({length:3000},()=>({r:0}))};
 assert.throws(()=>A.unpack(bomb),e=>e.code==='CONTEXT_TOO_LARGE');
});
test('1MiB送信上限と4MiB展開上限を別々に扱い、根拠を切り捨てない',()=>{
 const compact={entries:Array(500).fill({text:'あ'.repeat(800)})};assert.ok(A.bytes(compact)>1024*1024);assert.deepEqual(A.unpack(A.prepare(compact)),compact);
 assert.throws(()=>A.prepare({text:'x'.repeat(A.MAX_WIRE_BYTES)}),e=>e.details.reason==='INPUT_BYTES');
 assert.throws(()=>A.prepare({text:'x'.repeat(A.MAX_EXPANDED_BYTES)}),e=>e.details.reason==='EXPANDED_BYTES');
});
test('663KB以上の診断入力を新上限で受理し、通常相談の上限は維持',async()=>{
 const T=loadToolkit({ verificationBudget: true }),{input}=await import(require('./helpers/ai-repo.js').aiUrl('worker/test/cases/app-diagnosis.mjs'));
 const ctx=input();ctx.facts[0].value.rows=Array.from({length:900},(_,i)=>({id:i,source:{name:'同じ設定',text:'あ'.repeat(280)},confidence:'CERTAIN'}));
 assert.ok(A.bytes(ctx)>662683);const envelope=T.KTAiClient.buildAskEnvelope({ctx});assert.ok(A.bytes(envelope.payload)<262144);assert.deepEqual(inverse(clone(envelope.payload)),ctx);
 const {validateToolkitContext}=await import(require('./helpers/ai-repo.js').aiUrl('worker/src/v2/toolkit/validate-context.mjs'));assert.equal(validateToolkitContext(A.unpack(envelope.payload)).ok,true);
 const normal=clone(ctx);normal.focus.target=null;normal.requestPurpose='consultation';assert.equal(validateToolkitContext(normal).ok,false);
 assert.deepEqual(T.KTAiClient.buildAskEnvelope({ctx,analysisEncoding:false}).payload,ctx);
});
test('事前確保不足を実費の使い切りと区別し、数値と業務工程名を保存',async()=>{
 const {s:snapshot}=await F.snapshot();let calls=0;
 const detail={reason:'over-allowance',stage:'first',boundUsd:3.19535,remainingUsd:2,allowanceUsd:2,bodyBytes:95686,maxOutputTokens:16000,secret:'never-save'};
 const f=WF.fixture(W,{propose:async()=>{calls++;throw Object.assign(Error('budget'),{code:'BUDGET_EXCEEDED',details:{error:{detail}}});}});
 await f.controller.send('候補を作成',{requestPurpose:'document',businessSnapshot:snapshot});const state=f.controller.getState();
 assert.equal(calls,1);assert.equal(f.writes.length,0);assert.match(state.error.message,/業務工程を整理/);assert.match(state.error.message,/3.19535.*2米ドル/);assert.match(state.error.message,/AIには送信していません/);assert.doesNotMatch(state.error.message,/資料を作成|上限に達しました/);
 const saved=f.controller.exportSession().state.error;assert.equal(saved.detail.boundUsd,3.19535);assert.equal(saved.detail.secret,undefined);assert.match(V.render({...state,error:saved}),/今回のAI利用枠を確保できません/);
});
test('費用判定後の中断を送信前と誤記せず、詳細なしも推測しない',async()=>{
 for(const details of [{error:{detail:{reason:'over-allowance',stage:'repair',boundUsd:1,allowanceUsd:0.5}}},{}]){
  const f=WF.fixture(W,{propose:async()=>{throw Object.assign(Error('budget'),{code:'BUDGET_EXCEEDED',details});}});await f.controller.send('診断',{requestPurpose:'ideation',diagnosis:true});assert.doesNotMatch(f.controller.getState().error.message,/AIには送信していません/);
 }
});
test('診断は残額を渡して実送信内容で判定し、費用拒否を自動再送しない',async()=>{
 const T=loadToolkit({ verificationBudget: true }),{input}=await import(require('./helpers/ai-repo.js').aiUrl('worker/test/cases/app-diagnosis.mjs'));
 const map=new Map(),storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 const budget=T.KTAiBudget.create({storage,session:storage,host:'offline.cybozu.com'});await budget.configure({limitUsd:2,maxCalls:2});let calls=0;
 const limits={budgetAllowance:{version:1,models:['gpt-6.1-sol']},features:{'assistant-qa':{model:'gpt-6.1-sol',maxOutputTokens:12000,maxAiCalls:1}}};
 const client=budget.wrap({propose:async p=>{calls++;assert.equal(p.budget.allowanceUsd,2);throw Object.assign(Error('preflight'),{code:'BUDGET_EXCEEDED',details:{error:{detail:{reason:'over-allowance',stage:'first',boundUsd:3,allowanceUsd:2}}}});}}, {limits});
 await assert.rejects(client.propose({ctx:input()}));assert.equal(calls,1);assert.equal(budget.summary().usedCalls,0);assert.equal(budget.summary().reservedUsd,0);assert.equal(budget.summary().recordedUsd,0);
});

test('Worker入口から共通化した大きい診断を処理し、元の根拠IDで応答を検証',async()=>{
 const {input,answer}=await import(require('./helpers/ai-repo.js').aiUrl('worker/test/cases/app-diagnosis.mjs'));
 const {makeCtx,makeRequest,callV2,makeMockLlm}=await import(require('./helpers/ai-repo.js').aiUrl('worker/test/helpers.mjs'));
 const ctx=input();ctx.facts[0].value.rows=Array.from({length:900},(_,i)=>({id:i,source:{text:'あ'.repeat(280)}}));
 const body={contractVersion:'2.1',meta:{product:'toolkit',feature:'assistant-qa',promptVersion:'1',contextVersion:'1'},payload:A.prepare(ctx)};
 const f=makeCtx();f.ctx.tokenRec={entitlements:[{product:'toolkit',features:['assistant-qa']}]};const llm=makeMockLlm(answer());
 const r=await callV2(makeRequest('/v2/review',{body}),{ctx:f.ctx,llm});assert.equal(r.res.status,200,JSON.stringify(r.body));assert.equal(llm.calls.length,1);assert.deepEqual(r.body.explanation.sections[0].evidenceIds,['E4']);assert.match(llm.calls[0].system,/shared-json-1/);assert.ok(llm.calls[0].user.length<JSON.stringify(ctx).length);
 for(const payload of [{...body.payload,data:{r:99999}},A.pack({...ctx,requestPurpose:'consultation',focus:{resolution:'none',target:null,candidates:[]}})]){
  const other=makeCtx();other.ctx.tokenRec=f.ctx.tokenRec;const noCall=makeMockLlm(answer());const rejected=await callV2(makeRequest('/v2/review',{body:{...body,payload}}),{ctx:other.ctx,llm:noCall});assert.notEqual(rejected.res.status,200);assert.equal(noCall.calls.length,0);
 }
});
test('実際のprovider本文で費用上限を強制し、超過時は必要額・残額を返して送信ゼロ',async()=>{
 const {input,answer}=await import(require('./helpers/ai-repo.js').aiUrl('worker/test/cases/app-diagnosis.mjs'));
 const {makeCtx,makeRequest,callV2,withOpenAiMock}=await import(require('./helpers/ai-repo.js').aiUrl('worker/test/helpers.mjs'));
 const f=makeCtx();f.ctx.tokenRec={entitlements:[{product:'toolkit',features:['assistant-qa']}]};
 await withOpenAiMock(()=>{throw Error('Provider must not be called');},async calls=>{
  const r=await callV2(makeRequest('/v2/review',{body:{contractVersion:'2.1',meta:{product:'toolkit',feature:'assistant-qa',promptVersion:'1',contextVersion:'1'},budget:{allowanceUsd:0.001},payload:A.prepare(input())}}),{ctx:f.ctx,env:{OPENAI_API_KEY:'mock-only'}});
  assert.equal(r.body.error.code,'BUDGET_EXCEEDED');const d=r.body.error.detail;assert.equal(d.stage,'first');assert.ok(d.boundUsd>d.remainingUsd);assert.equal(d.remainingUsd,0.001);assert.ok(d.bodyBytes>0);assert.equal(d.maxOutputTokens,12000);assert.equal(calls.length,0);assert.equal(f.state.increments,0);
 });
});
