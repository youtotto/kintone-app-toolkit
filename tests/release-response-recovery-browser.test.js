'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {loadToolkit}=require('./helpers/load-toolkit.js');
const {devBaseLoaderOf}=require('./helpers/dev-base-fake.js');
const {makeKintoneMock}=require('./helpers/kintone-preview-mock.js');
const F=require('./helpers/release-workspace-fixture.js');
test('通信断・再読込後に実クライアントで回答を回収し、残0でも会話へ一度だけ戻す', {timeout:60000},async()=>{
 const root=path.resolve(__dirname,'..');let pw;try{pw=require('playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
 const {describeRegistry}=await import(require('./helpers/ai-repo.js').aiUrl('worker/src/v2/prompt-registry.mjs'));
 const usage=used=>({version:4,plan:'toolkit-light',yyyymm:'209910',resetsAt:'2099-10-31T15:00:00.000Z',timeZone:'Asia/Tokyo',price:{monthlyJpy:2480,taxIncluded:true},operationCosts:{consultation:1,document:2,diagnosis:3,business:10,final:3},credits:{limit:100,used,reserved:0,remaining:100-used}});
 const prod={appId:'310',appName:'通信断回収の無料確認',fields:{memo:{type:'MULTI_LINE_TEXT',code:'memo',label:'備考'}},layout:[],views:{views:{},revision:'1'},status:{enable:false,states:{},actions:[]},customize:{scope:'ALL',desktop:{js:[],css:[]},mobile:{js:[],css:[]}}};
 const T=loadToolkit(),mock=makeKintoneMock(prod),base=devBaseLoaderOf({KTDevBase:{load:T.KTDevBase.loadForRelease}},{appId:'310',production:prod,mockRef:()=>mock});
 let used=99,aiCalls=0,allowRecovery=false,saved=null,wire=null;const routes=[],unexpected=[],errors=[];
 const browser=await pw.chromium.launch({channel:'msedge',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1200,height:900},serviceWorkers:'block'});
  await context.route('**/*',route=>{if(route.request().url()==='https://recovery.test.invalid/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><div id="app" style="height:100vh"></div></html>'});unexpected.push(route.request().url());return route.abort();});
  const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('base',base);await page.exposeFunction('api',(name,args)=>mock.api[name](...args));
  await page.exposeFunction('gateway',async req=>{
   const route=new URL(req.url).pathname;routes.push(route);
   if(route==='/v2/health')return {status:200,body:JSON.stringify({ok:true,supportedContractVersions:['2.1'],registry:describeRegistry(),entitlements:[{product:'toolkit',features:['assistant-qa','change-planner','customization-generator']}],meta:{usage:usage(used)}})};
   if(route==='/v2/review'){
    aiCalls++;used++;wire=req.body;const b=JSON.parse(wire);saved={ok:true,contractVersion:'2.1',...F.proposal(),meta:{requestId:b.meta.requestId,mode:'proposal',usage:usage(used)}};
    throw Error('Intentional lost success response');
   }
   if(route==='/v2/review/result'){
    assert.equal(req.body,wire,'recovery preserves the exact submitted envelope');if(!allowRecovery)throw Error('Connection still offline');return {status:200,body:JSON.stringify(saved)};
   }
   throw Error('Unexpected endpoint '+route);
  });
  let source=fs.readFileSync(path.join(root,'kintoneAppToolkit.user.js'),'utf8').replace('waitReady().then(() => startToolkit());','');const end=source.lastIndexOf('})();');source=source.slice(0,end)+'\nglobalThis.RecoveryTest={mountReleaseWorkspace,KTAiClient};\n'+source.slice(end);
  async function mount(){await page.addScriptTag({content:source});await page.evaluate(({prod,names})=>{
   const C=RecoveryTest.KTAiClient,settings=C.createSettingsStore();settings.setConsent(true,'release-raw-source-1');
   const session=C.createSession({store:settings,hostname:location.hostname,transport:req=>window.gateway(req)});session.adopt({accessToken:'SYNTHETIC-BROWSER-ONLY',expiresAt:'2099-01-01T00:00:00Z',refreshToken:'SYNTHETIC-REFRESH-ONLY',refreshExpiresAt:'2099-01-01T00:00:00Z',scope:{product:'toolkit'}});
   window.work=RecoveryTest.mountReleaseWorkspace(document.querySelector('#app'),{appId:'310',settings,historyScope:{domain:location.origin,appId:'310',userId:'offline-user',environment:'preview'},historyOptions:{dbName:'offline-response-recovery'},historySessionOptions:{debounceMs:20},session,loadDevBase:window.base,executor:{api:Object.fromEntries(names.map(n=>[n,(...args)=>window.api(n,args)]))},getInputs:()=>({data:prod})});work.onVisible();
  },{prod,names:Object.keys(mock.api)});await page.waitForFunction(()=>work.capability().available&&!!work.history());await page.evaluate(()=>work.history().ready());}
  await page.goto('https://recovery.test.invalid/');await mount();
  await page.locator('#kt-release-input').fill(F.REQUEST);await page.locator('[data-release-action="send"]').first().click();
  try{await page.waitForFunction(()=>work.controller.getState().responseRecovery&&work.controller.getState().phase==='idle');}catch(e){console.log(JSON.stringify({routes,aiCalls,errors,state:await page.evaluate(()=>({phase:work.controller.getState().phase,error:work.controller.getState().error,recovery:!!work.controller.getState().responseRecovery}))}));throw e;}
  await page.waitForTimeout(700);assert.equal(aiCalls,1);assert.equal(used,100);
  await page.reload();await mount();
  try{await page.waitForFunction(()=>work.controller.getState().responseRecovery&&work.controller.getState().phase==='idle');}catch(e){console.log(JSON.stringify({routes,aiCalls,errors,state:await page.evaluate(()=>({phase:work.controller.getState().phase,error:work.controller.getState().error,recovery:!!work.controller.getState().responseRecovery}))}));throw e;}
  assert.equal(await page.evaluate(()=>work.capability().usage.credits.remaining),0);
  const button=page.locator('[data-release-action="recover-response"]').first();assert.equal(await button.isEnabled(),true);allowRecovery=true;
  await button.click();try{await page.waitForFunction(()=>work.controller.getState().phase==='proposal',null,{timeout:10000});}catch(e){console.log(JSON.stringify({routes,aiCalls,errors,state:await page.evaluate(()=>({phase:work.controller.getState().phase,error:work.controller.getState().error,recovery:!!work.controller.getState().responseRecovery}))}));throw e;}
  await page.waitForFunction(()=>document.querySelector('#kt-release-input').value==='');
  const state=await page.evaluate(()=>work.controller.getState());assert.equal(state.responseRecovery,null);assert.equal(state.messages.filter(m=>m.role==='user').length,1);assert.equal(aiCalls,1);assert.equal(used,100);assert.equal(routes.filter(r=>r==='/v2/review').length,1);
  assert.equal(await page.locator('[data-release-action="adopt"]').first().isDisabled(),true,'recovery does not grant new credits');
  const out=path.join(__dirname,'.build/release-response-recovery');fs.mkdirSync(out,{recursive:true});await page.evaluate(()=>work.history().flush());await page.screenshot({path:path.join(out,'recovered-after-reload.png')});
  assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
