'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../src/release-smalltalk.js');
const make=(overrides={})=>S.create({send:async()=>({ok:true,version:1,reply:'ひと息つきましょう。',handoff:false}),available:()=>true,canSend:()=>true,makeId:()=> 'r1',...overrides});
test('雑談の開閉は送信せず独立履歴・下書きを維持する',async()=>{
 let calls=[];const s=make({send:async x=>{calls.push(x);return{ok:true,version:1,reply:'アプリの相談で確認できます。',handoff:true};}});
 s.toggle();s.setDraft('このアプリに期限を追加したい');assert.equal(calls.length,0);assert.equal(await s.submit(),true);assert.equal(calls.length,1);
 assert.deepEqual(Object.keys(calls[0]).sort(),['history','requestId','signal','text']);assert.deepEqual(calls[0].history,[]);
 s.setDraft('続きの雑談');s.close();s.toggle();assert.equal(s.getState().draft,'続きの雑談');assert.match(s.handoff('r1'),/未採用/);assert.equal(calls.length,1);
 const restored=make();assert.equal(restored.restore(s.snapshot()),true);assert.deepEqual(restored.snapshot(),s.snapshot());assert.equal(calls.length,1);
});
test('古い表示履歴は残して最新3往復のみ送る',async()=>{
 let request;const s=make({send:async x=>{request=x;return {ok:true,version:1,reply:'返信',handoff:false};}});
 s.restore({version:1,open:true,draft:'訂正です',turns:Array.from({length:5},(_,i)=>({id:String(i),user:'質問'+i,reply:'回答'+i,handoff:false}))});await s.submit();
 assert.deepEqual(request.history.map(x=>x.user),['質問2','質問3','質問4']);assert.equal(s.snapshot().turns.length,6);
});
test('保留中の二重送信・復元・開閉を止め、失敗しても入力を保つ',async()=>{
 let resolve,n=0;const s=make({send:()=>{n++;return new Promise(r=>resolve=r);}});s.toggle();s.setDraft('こんにちは');const pending=s.submit();await new Promise(r=>setImmediate(r));
 assert.equal(await s.submit(),false);assert.equal(s.toggle(),false);assert.equal(s.restore({version:1,open:false,draft:'',turns:[]}),false);
 s.cancel();resolve({ok:true,version:1,reply:'遅い結果',handoff:false});await pending;assert.equal(n,1);assert.equal(s.getState().turns[0].reply,null);assert.match(s.getState().error,/中断/);assert.equal(s.getState().draft,'こんにちは');
});
test('無料非対応・作業中・長文では呼ばない',async()=>{
 let n=0;const s=make({available:()=>false,send:async()=>n++});s.toggle();s.setDraft('こんにちは');await s.submit();assert.equal(n,0);assert.equal(s.getState().draft,'こんにちは');
 const busy=make({canSend:()=>false,send:async()=>n++});assert.equal(busy.toggle(),false);assert.equal(await busy.submit(),false);
 const long=make({send:async()=>n++});long.toggle();long.setDraft('あ'.repeat(101));await long.submit();assert.equal(n,0);assert.equal(long.getState().draft.length,101);
});
test('失敗から自動再試行せず、生成物を受け渡さない',async()=>{
 let calls=0;const s=make({send:async()=>{calls++;throw Error('通信できません');}});s.toggle();s.setDraft('入力');await s.submit();assert.equal(calls,1);assert.equal(s.getState().draft,'入力');assert.equal(s.handoff('r1'),null);
 const restored=make();restored.restore(s.snapshot());assert.match(restored.getState().error,/自動では再送/);assert.equal(calls,1);
});

test('本物の認証クライアントから雑談だけを送り、通信失敗で再生成しない',async()=>{
 const {KTAiClient}=require('./helpers/load-toolkit.js').loadToolkit();
 const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const requests=[];let fail=false;
 const session=KTAiClient.createSession({store:KTAiClient.createSettingsStore({storage,host:'h'}),hostname:'h',transport:async req=>{
  requests.push(req);if(fail)throw Error('offline');return {status:200,body:JSON.stringify({ok:true,version:1,reply:'こんにちは',handoff:false})};
 }});
 session.adopt({accessToken:'FAKE-AT',expiresAt:new Date(Date.now()+3600000).toISOString(),refreshToken:'FAKE-RT',refreshExpiresAt:new Date(Date.now()+86400000).toISOString(),scope:{product:'toolkit',feature:'assistant-qa',domain:'h'}});
 const result=await session.client.smalltalk({text:'こんにちは',history:[],requestId:'free-1',context:{adminNotes:'送らない'},model:'別モデル'});
 assert.equal(result.reply,'こんにちは');assert.equal(requests.length,1);
 assert.equal(requests[0].url,KTAiClient.DEFAULT_API_BASE+'/v2/smalltalk');assert.equal(requests[0].headers.Authorization,'Bearer FAKE-AT');
 assert.deepEqual(JSON.parse(requests[0].body),{version:1,requestId:'free-1',text:'こんにちは',history:[]});
 fail=true;await assert.rejects(session.client.smalltalk({text:'続き',requestId:'free-2'}));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,2,'通信失敗後に生成を再送しない');
 assert.ok(requests.every(req=>req.url===KTAiClient.DEFAULT_API_BASE+'/v2/smalltalk'));
 assert.deepEqual(JSON.parse(requests[1].body),{version:1,requestId:'free-2',text:'続き',history:[]});
});

 test('100文字は送信し101文字は拒否、旧500文字の履歴は保持する',async()=>{
  let calls=[];const s=make({send:async x=>{calls.push(x);return {ok:true,version:1,reply:'返信',handoff:false};}});
  const old={id:'old',user:'あ'.repeat(500),reply:'以前の返信',handoff:false};
  assert.equal(s.restore({version:1,open:true,draft:'',turns:[old]}),true);
  s.setDraft('😀'.repeat(101));assert.equal(await s.submit(),false);assert.equal(calls.length,0);assert.match(s.getState().error,/100文字/);
  s.setDraft('😀'.repeat(100));assert.equal(await s.submit(),true);assert.equal(calls.length,1);assert.equal(calls[0].text,'😀'.repeat(100));assert.equal(calls[0].history[0].user,old.user);
 });
