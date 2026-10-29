'use strict';
// All browser requests are intercepted. No live AI or kintone is used.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {loadToolkit}=require('./helpers/load-toolkit.js');
const {devBaseLoaderOf}=require('./helpers/dev-base-fake.js');
const {makeKintoneMock}=require('./helpers/kintone-preview-mock.js');
const F=require('./helpers/release-workspace-fixture.js'),E=require('./helpers/release-explanation-fixture.js');
const root=path.resolve(__dirname,'..');
test('診断から選択した項目だけを相談し、入力・案・コードを保ち自動送信しない',{timeout:90000},async()=>{
 let pw;try{pw=require(process.env.PLAYWRIGHT_MODULE||'playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
 const T=loadToolkit();
 const {describeRegistry}=await import(pathToFileURL(path.join(root,'../AI/worker/src/v2/prompt-registry.mjs')).href);
 const health={ok:true,supportedContractVersions:['2.1'],registry:describeRegistry(),entitlements:[{product:'toolkit',features:['assistant-qa','change-planner','customization-generator']}]};
 const prod={appId:'310',appName:'案件管理',fields:{memo:{type:'MULTI_LINE_TEXT',code:'memo',label:'備考'},ステータス:{type:'STATUS',code:'ステータス',label:'ステータス',enabled:true}},
 adminNotes:{content:'PRIVATE_ADMIN_NOTE'},layout:[],views:{views:{},revision:'1'},status:{enable:true,states:{作成中:{name:'作成中',index:'0',assignee:{type:'ONE',entities:[]}},承認待ち:{name:'承認待ち',index:'1',assignee:{type:'ONE',entities:[]}},承認済み:{name:'承認済み',index:'2',assignee:{type:'ONE',entities:[]}}},actions:[]},customize:{scope:'ALL',desktop:{js:[],css:[]},mobile:{js:[],css:[]}}};
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
    const answer=E.response('アプリの診断'),memo=ctx.facts.find(f=>f.field?.code==='memo');
    answer.explanation.sections=[{heading:'確認：備考の扱いを確認できます',paragraphs:['備考は複数行の文字列です。'],items:['入力の手順を確かめます。'],table:null,evidenceIds:[]},{heading:'参考：引継ぎを見つけやすくできそうです',paragraphs:['備考を一覧に追加する案です。'],items:['必要な場合だけ相談できます。'],table:null,evidenceIds:[]}];
    answer.explanation.unknowns=['実際の画面の動きは未確認です。'];
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
  const countPaid=()=>calls.filter(c=>c.name!=='getHealth').length;
  await page.waitForFunction(()=>work.capability().available===true);
  assert.equal(await action('diagnose').isEnabled(),true);assert.equal(countPaid(),0);
  await page.locator('#kt-release-input').fill('編集中の相談');
  await action('diagnose').click();await page.locator('[data-consent]').click();
  await page.waitForFunction(()=>work.controller.getState().explanations.length===1);
  assert.equal(countPaid(),1);assert.equal(await page.locator('#kt-release-input').inputValue(),'編集中の相談');
  const input=calls.find(c=>c.name==='propose').ctx;
  assert.equal(input.requestPurpose,'ideation');assert.equal(input.focus.target.type,'app-diagnosis');assert.ok(input.facts.some(f=>f.kind==='app-health'));assert.ok(input.facts.some(f=>f.kind==='js-events'));
  assert.ok(!JSON.stringify(input).includes('PRIVATE_ADMIN_NOTE'));
  assert.equal(await page.locator('[data-release-action="consult-diagnosis"]').count(),2);
  const before=await page.evaluate(()=>JSON.stringify({proposal:work.controller.getState().proposal,plan:work.controller.getState().plan,artifacts:work.controller.getState().artifacts}));
  await action('consult-diagnosis').click();assert.equal(await page.locator('#kt-release-input').inputValue(),'編集中の相談');assert.equal(countPaid(),1);
  await page.locator('#kt-release-input').fill('');
  await page.locator('[data-release-action="consult-diagnosis"]').nth(1).click();
  const draft=await page.locator('#kt-release-input').inputValue();assert.match(draft,/参考：引継ぎ/);assert.doesNotMatch(draft,/確認：備考の扱い/);assert.match(draft,/まだ変更は採用していません/);assert.match(draft,/未確認/);assert.equal(countPaid(),1);
  assert.equal(await page.evaluate(()=>work.controller.getState().requestPurpose),'consultation');
  assert.equal(await page.evaluate(()=>JSON.stringify({proposal:work.controller.getState().proposal,plan:work.controller.getState().plan,artifacts:work.controller.getState().artifacts})),before);
  assert.equal(await page.locator('[data-release-action="apply"]').count(),0);
  await action('copy-explanation').click();await action('download-explanation').click();assert.equal(countPaid(),1);
  const out=path.join(__dirname,'.build/release-app-diagnosis');fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'diagnosis.png'),fullPage:true});
  await page.setViewportSize({width:800,height:900});assert.equal(await action('consult-diagnosis').isVisible(),true);await page.screenshot({path:path.join(out,'diagnosis-narrow.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>work.controller.getState().requestPurpose),'consultation');
  await action('send').click();await page.waitForFunction(()=>work.controller.getState().explanations.length===2);
  const selected=calls.filter(c=>c.name==='propose')[1].ctx;
  assert.equal(selected.requestPurpose,'consultation');assert.equal(selected.question,draft.trim());assert.equal(selected.conversation.discussion.find(m=>m.role==='assistant').accepted,false);assert.equal(countPaid(),2);
  // Missing diagnosis capability disables only this action; regular consultation remains usable.
  health.registry.toolkit['assistant-qa'].conversation=health.registry.toolkit['assistant-qa'].conversation.filter(x=>x!=='appDiagnosis');
  await action('connect').click();await page.locator('dialog [data-refresh]').click();await page.waitForFunction(()=>!work.capability().features['assistant-qa'].conversation.includes('appDiagnosis'));await page.locator('dialog [data-close]').click();
  assert.equal(await action('diagnose').isDisabled(),true);assert.equal(await action('send').isEnabled(),true);assert.equal(countPaid(),2);
  assert.equal(mock.calls.filter(c=>!c.startsWith('GET')).length,0);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
