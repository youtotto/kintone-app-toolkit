'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {KTReleaseWorkspace:W}=require('../src/release-workspace.js');
const {KTReleaseView:V}=require('../src/release-view.js');
const F=require('./helpers/release-workspace-fixture.js');
const {loadToolkit}=require('./helpers/load-toolkit.js');
const record=kind=>({version:1,kind,body:JSON.stringify({contractVersion:'2.1',meta:{requestId:'saved-test',product:'toolkit'},payload:{app:{id:'test-only'}}}),inputHash:'test-hash',facts:[]});
const lost=record=>Object.assign(new Error('通信が切れました'),{code:'TRANSPORT_ERROR',recovery:record});
function fixture(kind='propose') {
 const options={};options[kind==='plan'?'makePlan':kind]=async input=>{const r=record(kind);await input.onRecoveryPrepared(r);throw lost(r);};
 const f=F.fixture(W,options);let reads=0;
 f.services.validateRecovery=async()=>true;
 f.services.recover=async r=>{reads++;return kind==='propose'?F.proposal():kind==='plan'?{plan:f.plan}:F.generated(f.plan.customizations[0]);};
 return {...f,reads:()=>reads};
}
test('会話保存・読み直し後に相談の回答を戻し、追加依頼・重複メッセージ・設定反映を行わない',async()=>{
 const f=fixture();await f.controller.send(F.REQUEST,undefined);
 const pending=f.controller.getState().responseRecovery;assert.equal(pending.record.kind,'propose');assert.equal(f.count('propose'),1);
 const exported=JSON.parse(JSON.stringify(f.controller.exportSession()));assert.ok(exported.state.responseRecovery);
 const restored=F.fixture(W);restored.services.recover=f.services.recover;restored.services.validateRecovery=async()=>true;
 assert.equal(await restored.controller.restoreSession(exported),true);
 assert.equal(await restored.controller.recoverResponse(),true);
 const s=restored.controller.getState();assert.ok(s.proposal);assert.equal(s.responseRecovery,null);assert.equal(s.messages.filter(m=>m.role==='user').length,1);
 assert.equal(restored.count('propose'),0);assert.equal(restored.count('plan'),0);assert.equal(restored.count('generate'),0);assert.equal(restored.writes.length,0);
});
test('最終案を回収しても、続きのJS作成を勝手にAIへ依頼しない',async()=>{
 const f=fixture('plan');await f.controller.send(F.REQUEST);await f.controller.adopt();assert.equal(f.count('plan'),1);assert.ok(f.controller.getState().responseRecovery);
 assert.equal(await f.controller.recoverResponse(),true);assert.ok(f.controller.getState().plan);assert.equal(f.count('plan'),1);assert.equal(f.count('generate'),0);assert.equal(f.writes.length,0);
});
test('生成結果だけを取り直し、完成済みの生成物を失わず続きを自動生成しない',async()=>{
 const f=fixture('generate');await f.controller.send(F.REQUEST);await f.controller.adopt();assert.equal(f.count('generate'),1);assert.ok(f.controller.getState().responseRecovery);
 assert.equal(await f.controller.recoverResponse(),true);assert.ok(f.controller.getState().artifacts[0].result);assert.equal(f.count('generate'),1);assert.equal(f.writes.length,0);
});
test('回収に失敗しても元の会話と再取得情報を残し、別の依頼を追加送信しない',async()=>{
 const f=fixture();await f.controller.send(F.REQUEST);const before=f.controller.exportSession();
 f.services.recover=async()=>{throw new Error('まだ接続できません');};assert.equal(await f.controller.recoverResponse(),false);
 assert.deepEqual(f.controller.getState().messages,before.state.messages);assert.ok(f.controller.getState().responseRecovery);
 assert.equal(await f.controller.send('別の依頼'),false);assert.equal(f.count('propose'),1);
});
test('設定が変わった回答を新しい作業へ混ぜず、再取得を終了できる',async()=>{
 const f=fixture();await f.controller.send(F.REQUEST);f.services.validateRecovery=async()=>false;
 assert.equal(await f.controller.recoverResponse(),false);assert.equal(f.controller.getState().proposal,null);assert.ok(f.controller.getState().responseRecovery);
 assert.equal(f.controller.discardResponseRecovery(),true);assert.equal(f.controller.getState().responseRecovery,null);assert.equal(f.count('propose'),1);
});
test('残クレジットゼロでも再取得ボタンを表示し、再取得中は二重操作を防ぐ',async()=>{
 const f=fixture();await f.controller.send(F.REQUEST);let html=V.render(f.controller.getState(),{connection:{connected:true,available:true,canCreate:false,canConsult:false}});
 assert.match(html,/data-release-action="recover-response"/);assert.match(html,/AIの再実行・追加クレジット消費はありません/);
 const hold=F.deferred();f.services.recover=()=>hold.promise;const pending=f.controller.recoverResponse();assert.equal(await f.controller.recoverResponse(),false);
 html=V.render(f.controller.getState(),{});assert.match(html,/<button[^>]*data-release-action="recover-response"[^>]*disabled/);
 hold.resolve(F.proposal());await pending;
});
test('実クライアントは通信断後に再取得専用URLだけを呼び、元の入力とIDを維持する',async()=>{
 const {KTAiClient:C}=loadToolkit(),calls=[];let prepared;
 const body={ok:true,contractVersion:'2.1',meta:{requestId:'exact-id',usage:{version:4}},answer:'保存済みの回答',facts:[],analysis:[],recommendations:[],unknowns:[]};
 const client=C.createAiClient({apiBase:'https://gateway.invalid',accessToken:'SYNTHETIC-ONLY',hostname:'test.invalid',transport:async r=>{calls.push(r);if(r.url.endsWith('/v2/review'))throw new C.AiClientError({code:'TRANSPORT_ERROR',message:'offline test'});return {status:200,body:JSON.stringify(body)};}});
 const r=await client.ask({ctx:{contextVersion:'1',question:'確認',facts:[],app:{id:'310'}},requestId:'exact-id',onRecoveryPrepared:x=>{prepared=x;}});
 assert.equal(r.answer,body.answer);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/v2/review/result'));assert.equal(calls[0].body,calls[1].body);assert.equal(prepared.body,calls[0].body);assert.equal(prepared.body.includes('SYNTHETIC-ONLY'),false);
});
test('再取得も通信断の場合は記録を残し、明示した再取得が新しいAI依頼へ戻らない',async()=>{
 const {KTAiClient:C}=loadToolkit(),calls=[];let captured;
 const client=C.createAiClient({apiBase:'https://gateway.invalid',accessToken:'SYNTHETIC-ONLY',hostname:'test.invalid',transport:async r=>{calls.push(r);throw new C.AiClientError({code:'TRANSPORT_ERROR',message:'offline test'});}});
 await assert.rejects(client.ask({ctx:{contextVersion:'1',question:'確認',facts:[],app:{id:'310'}},onRecoveryPrepared:x=>{captured=x;}}),e=>!!e.recovery);
 await assert.rejects(client.recover({recovery:captured}));assert.equal(calls.filter(r=>r.url.endsWith('/v2/review')).length,1);assert.equal(calls.filter(r=>r.url.endsWith('/v2/review/result')).length,2);
});

test('旧版の会話は再取得情報なしでも復元でき、開いていた別会話の再取得情報を引き継がない',async()=>{
 const source=F.fixture(W);await source.controller.send(F.REQUEST);
 const old=JSON.parse(JSON.stringify(source.controller.exportSession()));delete old.state.responseRecovery;
 for(const version of ['release-workspace-session-1','release-workspace-session-2']){
  old.version=version;const target=fixture();await target.controller.send('別の会話');assert.ok(target.controller.getState().responseRecovery);
  assert.equal(await target.controller.restoreSession(old),true);
  assert.equal(target.controller.getState().responseRecovery,null);
  assert.deepEqual(target.controller.getState().messages,old.state.messages);
  assert.deepEqual(target.controller.getState().proposal,old.state.proposal);
  assert.equal(target.count('propose'),1);assert.equal(target.writes.length,0);
 }
});
