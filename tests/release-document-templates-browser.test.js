'use strict';
// All browser requests are intercepted. No live AI or kintone is used.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {loadToolkit}=require('./helpers/load-toolkit.js');
const {devBaseLoaderOf}=require('./helpers/dev-base-fake.js');
const {makeKintoneMock}=require('./helpers/kintone-preview-mock.js');
const F=require('./helpers/release-workspace-fixture.js'),E=require('./helpers/release-explanation-fixture.js');
const root=path.resolve(__dirname,'..');
test('資料の5種類を同じ相談へ送り、採用内容と下書きを保ち取消・重複送信を抑止する',{timeout:90000},async()=>{
 let pw;try{pw=require(process.env.PLAYWRIGHT_MODULE||'playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
 const T=loadToolkit();
 const {describeRegistry}=await import(pathToFileURL(path.join(root,'../AI/worker/src/v2/prompt-registry.mjs')).href);
 const health={ok:true,supportedContractVersions:['2.1'],registry:describeRegistry(),entitlements:[{product:'toolkit',features:['assistant-qa','change-planner','customization-generator']}]};
 const prod={appId:'310',appName:'案件管理',fields:{memo:{type:'MULTI_LINE_TEXT',code:'memo',label:'備考'},ステータス:{type:'STATUS',code:'ステータス',label:'ステータス',enabled:true}},
 layout:[],views:{views:{},revision:'1'},status:{enable:true,states:{作成中:{name:'作成中',index:'0',assignee:{type:'ONE',entities:[]}},承認待ち:{name:'承認待ち',index:'1',assignee:{type:'ONE',entities:[]}},承認済み:{name:'承認済み',index:'2',assignee:{type:'ONE',entities:[]}}},actions:[]},customize:{scope:'ALL',desktop:{js:[],css:[]},mobile:{js:[],css:[]}}};
 const mock=makeKintoneMock(prod),loadBase=devBaseLoaderOf({KTDevBase:{load:T.KTDevBase.loadForRelease}},{appId:'310',production:prod,mockRef:()=>mock});
 const calls=[],unexpected=[],errors=[];let documentCount=0,holdNext=false,failNext=false,releaseHold=null;
 const browser=await pw.chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  await context.route('**/*',route=>{
   if(route.request().url()==='https://explanation.test.invalid/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><body style="margin:0"><div id="app" style="height:100vh"></div></body></html>'});
   unexpected.push(route.request().url());return route.abort();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('base',loadBase);await page.exposeFunction('api',async(name,args)=>mock.api[name](...args));
  await page.exposeFunction('service',async(name,ctx)=>{
   calls.push({name,ctx});if(name==='getHealth')return E.clone(health);
   if(name==='propose'){
    if(ctx.question===F.REQUEST)return F.proposal();
    if(failNext){failNext=false;throw new Error('資料作成の固定の通信失敗です。');}
    documentCount++;
    const answer=E.response('作成した資料 '+documentCount),memo=ctx.facts.find(f=>f.field?.code==='memo');
    assert.ok(memo);answer.explanation.sections.forEach(s=>s.evidenceIds=[memo.id]);
    if(holdNext){holdNext=false;await new Promise(resolve=>{releaseHold=resolve;});}
    return answer;
   }
   if(name==='plan')return F.plan();
   return F.generated(ctx.customization);
  });
  await page.goto('https://explanation.test.invalid/');
  let source=fs.readFileSync(process.env.KT_SRC||path.join(root,'kintoneAppToolkit.user.js'),'utf8').replace('waitReady().then(() => startToolkit());','');
  const end=source.lastIndexOf('})();');source=source.slice(0,end)+'\nglobalThis.ExplanationTest={mountReleaseWorkspace,KTAiClient};\n'+source.slice(end);
  await page.addScriptTag({content:source});
  await page.evaluate(({names,prod})=>{
   window.saved=[];window.copies=[];window.connected=true;
   const client=Object.fromEntries(['getHealth','propose','plan','generate'].map(name=>[name,async input=>window.service(name,input?.ctx)]));
   window.work=ExplanationTest.mountReleaseWorkspace(document.querySelector('#app'),{
    appId:'310',settings:ExplanationTest.KTAiClient.createSettingsStore(),session:{client,status:()=>({connected:window.connected,apiBase:'https://gateway.test.invalid'}),disconnect:async()=>{window.connected=false;}},
    loadDevBase:window.base,executor:{api:Object.fromEntries(names.map(name=>[name,(...args)=>window.api(name,args)]))},
    getInputs:()=>({data:prod}),copyText:async text=>window.copies.push(text),downloadText:(name,text,type)=>window.saved.push({name,text,type})
   });
   work.onVisible();
  },{names:Object.keys(mock.api),prod});
  const action=name=>page.locator('[data-release-action="'+name+'"]').first();
  const send=async text=>{await page.locator('#kt-release-input').fill(text);await action('send').click();};
  const countPaid=()=>calls.filter(c=>c.name!=='getHealth').length;

  await page.waitForFunction(()=>work.capability().available===true);
  assert.equal(await page.locator('.ktr-composer select').count(),0,'利用者に用途やモデルの選択を求めない');
  assert.equal(await page.getByRole('button',{name:'改善案を考える',exact:true}).count(),0,'比較準備のLunaを通常画面へ追加しない');
  const docs=()=>page.locator('dialog:has([data-document-create])');
  const create=()=>docs().locator('[data-document-create]');
  const closeDocs=()=>docs().locator('[data-close]').click();
  const phase=value=>page.waitForFunction(v=>work.controller.getState().phase===v,value);
  const docsCount=value=>page.waitForFunction(v=>work.controller.getState().explanations.length===v,value);
  const draft='これは未送信の相談です。備考の注意点も確認したい。';
  const templates=[
   ['overview','アプリの概要','このアプリの概要を'],
   ['specification','アプリ仕様書','このアプリの仕様書を'],
   ['instructions','操作説明','このアプリを使う人向けの操作説明を'],
   ['handover','引継ぎ資料','このアプリを後任の担当者へ引き継ぐ資料を'],
   ['changes','変更内容のまとめ','この会話の変更内容を資料にまとめて'],
  ];
  await page.locator('#kt-release-input').fill(draft);
  await action('documents').click();
  assert.equal(await docs().locator('input[name="document-template"]').count(),5);
  for(const [id,title] of templates){
   await docs().locator('input[value="'+id+'"]').check();
   assert.match(await docs().innerText(),new RegExp(title));
  }
  const out=path.join(__dirname,'.build/release-document-templates');fs.mkdirSync(out,{recursive:true});
  await page.screenshot({path:path.join(out,'templates-wide.png'),fullPage:true});
  await closeDocs();
  assert.equal(countPaid(),0,'選択して閉じるだけでは送信しない');
  assert.equal(await page.locator('[data-release-purpose]').getAttribute('data-release-purpose'),'consultation');
  assert.equal(await page.locator('#kt-release-input').inputValue(),draft);

  await action('documents').click();await create().click();
  await page.locator('dialog:has([data-consent]) [data-close]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-document-create]').disabled);
  assert.equal(countPaid(),0,'同意取消では送信しない');
  assert.equal(await page.locator('#kt-release-input').inputValue(),draft);
  await closeDocs();

  await send(F.REQUEST);await page.locator('[data-consent]').click();await phase('proposal');
  await action('adopt').click();await phase('review');
  const adopted=await page.evaluate(()=>{const s=work.controller.getState();return{adopted:s.adopted,plan:s.plan,prepared:s.prepared,answers:s.answers,runs:s.runs};});
  assert.ok(adopted.adopted);assert.equal(adopted.prepared.ok,true);
  const initialPaid=countPaid();
  await page.locator('#kt-release-input').fill(draft);
  for(const [index,[id,title,prefix]] of templates.entries()){
   await action('documents').click();await docs().locator('input[value="'+id+'"]').check();
   const extra=id==='instructions'?'初めて担当する人向けに、保存と承認を分けて説明してください。':'';
   if(extra)await docs().locator('[data-document-extra]').fill(extra);
   assert.match(await docs().locator('[data-document-status]').innerText(),/入力は送信せず、そのまま残します/);
   await create().click();await docsCount(index+1);
   await docs().waitFor({state:'detached'});
   assert.equal(await docs().count(),0,'開始したダイアログは閉じる');
   const request=calls.filter(c=>c.name==='propose').at(-1).ctx;
   assert.equal(request.requestPurpose,'document');
   assert.equal(await page.locator('[data-release-purpose]').getAttribute('data-release-purpose'),'document');
   assert.ok(request.question.startsWith(prefix),title+'の依頼を送る');
   assert.ok(request.question.includes('資料の作成だけを依頼しています。'));
   if(extra)assert.ok(request.question.endsWith('追加の希望：'+extra));
   assert.ok(!request.question.includes(draft),'未送信の相談を資料依頼へ混ぜない');
   assert.deepEqual(request.conversation.acceptedProposal,adopted.adopted);
   assert.ok(request.conversation.discussion.some(m=>m.role==='user'&&m.text===F.REQUEST));
   if(index)assert.ok(request.conversation.discussion.some(m=>m.role==='assistant'&&m.explanation?.title==='作成した資料 '+index));
   assert.equal(await page.locator('#kt-release-input').inputValue(),draft);
   const after=await page.evaluate(()=>{const s=work.controller.getState();return{adopted:s.adopted,plan:s.plan,prepared:s.prepared,answers:s.answers,runs:s.runs};});
   assert.deepEqual(after,adopted,'資料作成で採用/準備/反映の状態を変えない');
   assert.equal(countPaid(),initialPaid+index+1,'テンプレート毎に相談1回だけ');
  }
  const stateBeforeSave=await page.evaluate(()=>JSON.stringify(work.controller.getState())),paidBeforeSave=countPaid();
  await action('copy-explanation').click();await action('download-explanation').click();
  const exported=await page.evaluate(()=>({copy:copies.at(-1),saved:saved.at(-1)}));
  assert.equal(exported.saved.text,exported.copy);assert.match(exported.copy,/作成した資料 5/);
  assert.equal(countPaid(),paidBeforeSave);assert.equal(await page.evaluate(()=>JSON.stringify(work.controller.getState())),stateBeforeSave);
  assert.equal(await page.locator('#kt-release-input').inputValue(),draft);

  await page.setViewportSize({width:320,height:844});await action('documents').click();
  const size=await docs().evaluate(el=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,viewport:innerWidth,body:document.documentElement.scrollWidth,client:el.clientWidth,scroll:el.scrollWidth};});
  assert.ok(size.left>=-1&&size.right<=size.viewport+1,JSON.stringify(size));
  assert.ok(size.body<=size.viewport+1&&size.scroll<=size.client+1,JSON.stringify(size));
  await page.screenshot({path:path.join(out,'templates-narrow.png'),fullPage:true});await closeDocs();
  await page.setViewportSize({width:1440,height:900});

  // Two real DOM clicks in the same turn exercise the pending guard.
  holdNext=true;await action('documents').click();
  const beforeDouble=countPaid();
  await create().evaluate(button=>{button.click();button.click();});
  await phase('consulting');
  await new Promise((resolve,reject)=>{const until=Date.now()+10000;function poll(){if(releaseHold)return resolve();if(Date.now()>until)return reject(new Error('固定応答の保留に到達しませんでした'));setTimeout(poll,20);}poll();});
  assert.equal(countPaid(),beforeDouble+1,'二重クリックでも相談1回だけ');
  await action('documents').click();assert.equal(await create().isDisabled(),true);
  await create().evaluate(button=>button.click());
  assert.equal(countPaid(),beforeDouble+1,'処理中の資料作成は送信しない');await closeDocs();
  releaseHold();await docsCount(6);
  assert.equal(await page.locator('#kt-release-input').inputValue(),draft);

  const beforeFailure=countPaid();failNext=true;
  await action('documents').click();await create().click();
  await page.waitForFunction(()=>work.controller.getState().phase!=='consulting'&&!!work.controller.getState().error);
  await docs().waitFor({state:'detached'});
  assert.equal(await docs().count(),0,'送信開始後の失敗は相談側で表示する');
  assert.equal(countPaid(),beforeFailure+1,'失敗時も自動再送しない');
  await page.locator('.ktr-header-notice > summary').click();
  assert.match(await page.locator('.ktr-header-notice-body .ktr-error').innerText(),/資料作成の固定の通信失敗/);
  await page.locator('[data-release-action="close-notice"]').click();
  const failed=await page.evaluate(()=>{const s=work.controller.getState();return{adopted:s.adopted,plan:s.plan,prepared:s.prepared,answers:s.answers,runs:s.runs};});
  assert.deepEqual(failed,adopted,'資料の通信失敗でも既存の採用・準備を失わない');
  assert.equal(await page.locator('#kt-release-input').inputValue(),draft);

  // A free-form follow-up edits the document until the user explicitly changes purpose.
  await send('確認事項を短くして');await docsCount(7);
  assert.equal(calls.filter(c=>c.name==='propose').at(-1).ctx.requestPurpose,'document');
  assert.equal(await page.locator('[data-release-purpose]').getAttribute('data-release-purpose'),'document');
  const afterFollowup=await page.evaluate(()=>{const s=work.controller.getState();return{adopted:s.adopted,plan:s.plan,prepared:s.prepared,answers:s.answers,runs:s.runs};});
  assert.deepEqual(afterFollowup,adopted);
  await page.screenshot({path:path.join(out,'document-purpose-wide.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(out,'document-purpose-narrow.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:900});
  const beforePurpose=countPaid();
  await page.locator('#kt-release-input').fill(draft);
  await action('focus-consultation').click();
  assert.equal(countPaid(),beforePurpose);assert.equal(await page.locator('#kt-release-input').inputValue(),draft);
  await action('show-changes').click();await action('show-explanation').click();
  await action('copy-explanation').click();await action('download-explanation').click();
  assert.equal(await page.locator('[data-release-purpose]').getAttribute('data-release-purpose'),'consultation');
  assert.equal(countPaid(),beforePurpose,'閲覧・コピー・保存は用途を変えずAIも呼ばない');

  await action('connect').click();await page.locator('dialog [data-disconnect]').click();
  await page.locator('dialog [data-close]').click();
  const beforeDisconnected=countPaid();
  await action('documents').click();assert.equal(await create().isDisabled(),true);
  await create().evaluate(button=>button.click());assert.equal(countPaid(),beforeDisconnected);
  await closeDocs();assert.equal(await page.locator('#kt-release-input').inputValue(),draft);
  assert.equal(mock.calls.filter(c=>!c.startsWith('GET')).length,0,'設定・レコードへの書き込みなし');
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  await page.evaluate(()=>work.dispose());
 }finally{if(releaseHold)releaseHold();await browser.close();}
});
