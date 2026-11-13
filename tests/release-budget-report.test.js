'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {KTReleaseBudgetReport:R}=require('../src/release-budget-report.js');
const UUID='11111111-2222-4333-8444-555555555555',OTHER='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NOW='2026-11-03T08:00:00.000Z';
function fixture(entries=[]){const config={id:'b-'+UUID,createdAt:'2026-11-02T11:00:00.000Z',limitUsd:5,maxCalls:2};const ledger={id:config.id,configCreatedAt:config.createdAt,entries};const summary={enabled:true,ok:true,id:config.id,recordedUsd:0,reservedUsd:3.3281,usedCalls:1,costUnknown:1,completionUnknown:0,inFlight:0};const state={mode:'on',config,ledger};return {state,summary,budget:{sessionId:'p-current',readState:()=>state,summary:()=>summary}};}
function entry(extra={}){return {requestId:'tk-'+UUID,kind:'propose',feature:'assistant-qa',status:'unknown',sessionId:'p-current',startedAt:'2026-11-02T11:11:52.690Z',endedAt:'2026-11-02T11:13:10.000Z',responseState:'succeeded',estimatedModel:'gpt-6-astra',model:'gpt-6-astra',estimatedServiceTier:'default',requestedServiceTier:'default',serviceTier:'default',reservedUsd:3.3281,reservedCalls:1,allowanceUsd:5,costUsd:null,costKnownUsd:0,costComplete:false,calls:[],...extra};}
function call(extra={}){return {kind:'proposal',model:'gpt-6-astra',requestedServiceTier:'default',serviceTier:'default',boundUsd:3.3281,costUsd:null,costReason:'cache-usage-unknown',usage:{input:2000,output:500,cached:0,cacheWrite:null,cacheWrite30m:null,cacheWrite12h:null,reasoning:200},...extra};}
const capture=f=>R.capture(f.budget,{now:()=>Date.parse(NOW)});

test('成功した費用未確定の既存台帳を短縮usageごと保存し、実費とは区別する',()=>{
 const f=fixture([entry({gatewayCalls:[call()]})]),before=JSON.stringify(f.state),r=capture(f);
 assert.equal(r.schemaVersion,'toolkit-budget-report-1');assert.equal(r.scope,'active-budget');assert.equal(r.capturedAt,NOW);assert.equal(r.mode,'active');assert.equal(r.budget.id,'b-'+UUID);
 assert.equal(r.entries[0].status,'succeeded-cost-unsettled');assert.equal(r.entries[0].costUsd,null);assert.equal(r.entries[0].costComplete,false);assert.equal(r.totals.knownUsd,0);assert.equal(r.totals.reservedUsd,3.3281);
 assert.deepEqual(r.entries[0].calls[0].usage,{inputTokens:2000,outputTokens:500,cachedTokens:0,cacheWriteTokens:null,cacheWriteTokens30m:null,cacheWriteTokens12h:null,reasoningTokens:200});assert.equal(r.entries[0].calls[0].costReason,'cache-usage-unknown');
 const html=R.html(r);assert.match(html,/応答完了・費用未確定/);assert.match(html,/実際の請求額ではありません/);assert.match(html,/会話・アプリ単位の集計ではありません/);assert.match(html,/キャッシュの読み取り・書き込み/);assert.equal(JSON.stringify(f.state),before);
});

test('複数呼出しの一部だけ確定した場合に既知費用と未確定の確保を別々に保持',()=>{
 const f=fixture([entry({status:'partial-unknown',costKnownUsd:0.012,reservedUsd:0.2,gatewayCalls:[call({costUsd:0.012,costReason:undefined,boundUsd:0.1}),call({boundUsd:0.2,costReason:'service-tier-missing',serviceTier:null})]})]);f.summary.recordedUsd=0.012;f.summary.reservedUsd=0.2;f.summary.usedCalls=2;
 const r=capture(f),e=r.entries[0];assert.equal(e.costUsd,null);assert.equal(e.knownUsd,0.012);assert.equal(e.status,'succeeded-cost-unsettled');assert.equal(e.calls.length,2);assert.equal(e.calls[0].costUsd,0.012);assert.equal(e.calls[0].costReason,null);assert.equal(e.calls[1].costUsd,null);assert.equal(e.calls[1].serviceTier,null);assert.match(R.html(r),/応答に料金区分の記録がなく/);
});

test('進行中・再読込後の終了不明・通信失敗・旧確定台帳・未送信解放を区別',()=>{
 const entries=[entry({status:'in-flight',responseState:undefined,endedAt:null}),entry({status:'in-flight',sessionId:'p-old',responseState:undefined,endedAt:null}),entry({responseState:undefined,reason:'NETWORK_ERROR'}),entry({status:'done',costComplete:undefined,costUsd:0.01,costKnownUsd:undefined,reservedUsd:0,calls:[{input:20,output:10,cached:0,cacheWrite:0,cacheWrite30m:0,cacheWrite12h:0,reasoning:0}]}),entry({status:'released',responseState:undefined,costComplete:true,costUsd:0,costKnownUsd:0,reservedUsd:0,reservedCalls:0})];
 const r=capture(fixture(entries));assert.deepEqual(r.entries.map(e=>e.status),['in-flight','completion-unknown','completion-unknown','cost-confirmed','released']);assert.equal(r.entries[3].knownUsd,0.01);assert.equal(r.entries[3].calls[0].usage.inputTokens,20);assert.equal(r.entries[4].costUsd,0);
 const html=R.html(r);for(const label of ['進行中','終了不明・費用未確定','費用の見積もり確定済み','未送信・確保解放済み'])assert.ok(html.includes(label));assert.ok(!JSON.stringify(r).includes('NETWORK_ERROR'));
});

test('readStateとsummaryの枠ID不一致や壊れた記録はfail closedで金額を出さない',()=>{
 for(const mutate of [f=>{f.summary.id='b-'+OTHER;},f=>{f.state.ledger.id='b-'+OTHER;},f=>{f.state.ledger.configCreatedAt='2020-01-01T00:00:00.000Z';},f=>{f.state.ledger.entries=[null];},f=>{f.state.mode='broken';f.state.reason='PRIVATE_ERROR';},f=>{f.budget.readState=()=>{throw Error('PRIVATE_ERROR');};},f=>{f.budget.summary=()=>{throw Error('PRIVATE_ERROR');};}]){
  const f=fixture([entry()]);mutate(f);const r=capture(f);assert.equal(r.mode,'unreadable');assert.equal(r.totals,null);assert.equal(r.budget,null);assert.deepEqual(r.entries,[]);assert.ok(!JSON.stringify(r).includes('PRIVATE_ERROR'));assert.match(R.html(r),/0とは判断しません/);assert.doesNotMatch(R.html(r),/0 米ドル/);
 }
});

test('無効と空の有効枠は区別し、現在枠以外の記録を収集しない',()=>{
 let reads=0;const disabled=R.capture({readState:()=>({mode:'disabled',otherBudgets:[entry()]}),summary:()=>({enabled:false})},{now:()=>Date.parse(NOW)});assert.equal(disabled.status,'disabled');assert.equal(disabled.totals,null);assert.deepEqual(disabled.entries,[]);
 const f=fixture();f.summary.recordedUsd=0;f.summary.reservedUsd=0;f.summary.usedCalls=0;f.state.previousLedger={entries:[entry()]};const oldRead=f.budget.readState;f.budget.readState=()=>{reads++;return oldRead();};const r=capture(f);assert.equal(reads,2);assert.equal(r.status,'empty');assert.deepEqual(r.entries,[]);assert.equal(r.totals.knownUsd,0);assert.match(R.html(r),/要求の記録がありません/);assert.ok(!JSON.stringify(r).includes('previousLedger'));
});

test('秘密・本文・任意文字列・未知フィールドをallowlistから除外する',()=>{
 const secret='sk-proj-PRIVATE_CONTENT_456',c=call({costReason:secret,model:secret,requestedServiceTier:secret,serviceTier:secret,prompt:secret,usage:{input:4,output:2,cached:secret,apiKey:secret}}),f=fixture([entry({requestId:secret,model:'gpt-6-astra<script>'+secret,estimatedModel:secret,reason:secret,prompt:secret,headers:{Authorization:secret},gatewayCalls:[c]})]);
 f.state.config.token=secret;f.summary.token=secret;f.state.other=secret;const r=capture(f),e=r.entries[0];assert.equal(e.requestId,null);assert.equal(e.model,null);assert.equal(e.estimatedModel,null);assert.equal(e.costReason,'unknown');assert.equal(e.calls[0].model,null);assert.equal(e.calls[0].serviceTier,null);assert.equal(e.calls[0].costReason,'unknown');assert.equal(e.calls[0].usage.cachedTokens,null);assert.ok(!JSON.stringify(r).includes(secret));assert.ok(!R.html(r).includes(secret));
 const forged=structuredClone(r);forged.budget.id=secret;forged.entries[0].requestId=secret;forged.entries[0].model=secret;forged.entries[0].calls[0].costReason=secret;forged.entries[0].calls[0].usage.inputTokens=secret;assert.ok(!R.html(forged).includes(secret));
});

test('数値不正・文字列数値・欠けた利用量はnullで、complete falseを費用0確定にしない',()=>{
 const f=fixture([entry({status:'done',costComplete:false,costUsd:0,costKnownUsd:null,reservedUsd:NaN,gatewayCalls:[call({usage:{input:100,output:null,cached:-1,cacheWrite:Infinity,cacheWrite30m:'12',cacheWrite12h:1.5,reasoning:NaN}})]})]);f.summary.recordedUsd='0';f.summary.reservedUsd=NaN;f.summary.usedCalls=1.5;f.state.config.maxCalls='2';
 const r=capture(f),e=r.entries[0];assert.equal(e.status,'succeeded-cost-unsettled');assert.equal(e.costComplete,false);assert.equal(e.costUsd,null);assert.equal(e.knownUsd,null);assert.equal(e.reservedUsd,null);assert.equal(r.totals.knownUsd,null);assert.equal(r.totals.reservedUsd,null);assert.equal(r.totals.usedCalls,null);assert.equal(r.budget.maxCalls,null);assert.equal(e.calls[0].usage.inputTokens,100);for(const key of ['outputTokens','cachedTokens','cacheWriteTokens','cacheWriteTokens30m','cacheWriteTokens12h','reasoningTokens'])assert.equal(e.calls[0].usage[key],null,key);
 assert.match(R.html(r),/既知の見積もり費用：未確認/);
});

test('Worker正規形とproviderの生利用量の数値だけを扱い、実測modelと推定modelを区別',()=>{
 const f=fixture([entry({model:null,estimatedModel:'gpt-6-astra',gatewayCalls:[call({model:'gpt-6.1-sol-2026-10-27',usage:{inputTokens:8,outputTokens:4,cachedTokens:2,cacheWriteTokens:1,cacheWriteTokens30m:1,cacheWriteTokens12h:0,reasoningTokens:1}}),call({usage:{input_tokens:12,output_tokens:6,input_tokens_details:{cached_tokens:3,cache_write_tokens:2,cache_write_tokens_details:{ttl_30m_tokens:2,ttl_12h_tokens:0}},output_tokens_details:{reasoning_tokens:2},raw_text:'NOT_EXPORTED'}})]})]);
 const e=capture(f).entries[0];assert.equal(e.model,null);assert.equal(e.estimatedModel,'gpt-6-astra');assert.equal(e.calls[0].model,'gpt-6.1-sol-2026-10-27');assert.equal(e.calls[0].usage.cacheWriteTokens30m,1);assert.equal(e.calls[1].usage.cacheWriteTokens30m,2);assert.equal(e.calls[1].usage.reasoningTokens,2);assert.ok(!JSON.stringify(e).includes('NOT_EXPORTED'));
});

test('すべての定義済み未確定理由を日本語にし、未知の理由は生文字列で表示しない',()=>{
 const reasons=['usage-totals-unknown','cache-usage-unknown','cache-write-ttl-unknown','usage-inconsistent','service-tier-missing','service-tier-unknown','unknown-model','cost-invalid','INCOMPLETE_USAGE','INCOMPLETE_SERVICE_TIER'];
 for(const why of reasons){const r=capture(fixture([entry({gatewayCalls:[call({costReason:why})]})]));assert.equal(r.entries[0].calls[0].costReason,why);const html=R.html(r);assert.doesNotMatch(html,new RegExp(why));assert.match(html,/確認できません|計算できません|数値ではありません|不足しています/);}
 const bad=capture(fixture([entry({gatewayCalls:[call({costReason:'<img src=x onerror=alert(1)>'})]})]));assert.equal(bad.entries[0].calls[0].costReason,'unknown');assert.doesNotMatch(R.html(bad),/<img|onerror=/);
});

test('確認情報は台帳を変更せず、予算操作やネットワークを呼ばない',()=>{
 const f=fixture([entry({gatewayCalls:[call()]})]),before=JSON.stringify(f),fetchBefore=globalThis.fetch;let writes=0,network=0;f.budget.configure=f.budget.reserve=f.budget.settle=()=>{writes++;throw Error('write forbidden');};globalThis.fetch=()=>{network++;throw Error('network forbidden');};
 try{const r=capture(f);R.html(r);assert.equal(JSON.stringify(f),before);assert.equal(writes,0);assert.equal(network,0);}finally{globalThis.fetch=fetchBefore;}
});

test('旧方式の要求全体が確定済みなら、呼出別金額がなくても費用未確定とは表示しない',()=>{
 const f=fixture([entry({status:'done',costComplete:true,costUsd:0.02,costKnownUsd:0.02,reservedUsd:0,reason:null,calls:[{input:10,output:5,cached:0,cacheWrite:0,cacheWrite30m:0,cacheWrite12h:0,reasoning:1}]})]);f.summary.recordedUsd=0.02;f.summary.reservedUsd=0;f.summary.costUnknown=0;
 const r=capture(f),c=r.entries[0].calls[0];assert.equal(c.costStatus,'breakdown-unrecorded');assert.equal(c.costUsd,null);assert.equal(c.costReason,null);const html=R.html(r);assert.match(html,/呼び出し別の費用内訳は未記録/);assert.match(html,/要求全体は見積もり確定済み/);assert.doesNotMatch(html,/費用未確定/);assert.match(html,/呼び出しの費用上限（見積もり）/);assert.doesNotMatch(html,/呼び出しの確保額/);assert.match(html,/同じドメインで共通/);
});

test('複数呼出しの未取得料金区分を先頭応答の値で補わない',()=>{
 const calls=[{input:10,output:5},{input:20,output:6}];
 for(const perCall of [[{requestedServiceTier:'default',serviceTier:'default'},{requestedServiceTier:'default',serviceTier:null}], [{requestedServiceTier:'default',serviceTier:'default'}], undefined]){
  const f=fixture([entry({kind:'generate',calls,callServiceTiers:perCall})]);
  const r=capture(f),second=r.entries[0].calls[1];assert.equal(second.serviceTier,null);assert.equal(second.model,null);
  assert.equal(second.requestedServiceTier,perCall?.[1]?.requestedServiceTier??null);
 }
 const single=capture(fixture([entry({calls:[calls[0]],callServiceTiers:[{requestedServiceTier:null,serviceTier:null}]})]));
 assert.equal(single.entries[0].calls[0].requestedServiceTier,null);assert.equal(single.entries[0].calls[0].serviceTier,null);
});

test('同じ枠の精算が読み取り途中で進んだら古い明細と新しい合計を混ぜない',()=>{
 const f=fixture([entry({gatewayCalls:[call()]})]);
 f.budget.summary=()=>{f.state.ledger.entries[0].reservedUsd=0;return {...f.summary,reservedUsd:0,recordedUsd:0.1};};
 const r=capture(f);assert.equal(r.mode,'unreadable');assert.equal(r.errorReason,'inconsistent-state');assert.equal(r.totals,null);assert.deepEqual(r.entries,[]);
});
