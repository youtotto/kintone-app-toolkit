'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {loadToolkit}=require('./helpers/load-toolkit.js');const {devBaseLoaderOf}=require('./helpers/dev-base-fake.js');const {makeKintoneMock}=require('./helpers/kintone-preview-mock.js');const F=require('./helpers/release-workspace-fixture.js');
const root=path.resolve(__dirname,'..');
test('実ブラウザーで無料雑談・手動引き継ぎ・コード保持・自動保存復旧',{timeout:90000},async()=>{
 let pw;try{pw=require('playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
 const T=loadToolkit();const {describeRegistry}=await import(pathToFileURL(path.join(root,'../AI/worker/src/v2/prompt-registry.mjs')).href);
 const health={ok:true,supportedContractVersions:['2.1'],registry:describeRegistry(),entitlements:[{product:'toolkit',features:['assistant-qa','change-planner','customization-generator']}],smalltalk:{version:1,available:true}};
 const prod={appId:'310',appName:'案件管理',adminNotes:{content:'PRIVATE_ADMIN_NOTE'},fields:{memo:{type:'MULTI_LINE_TEXT',code:'memo',label:'備考'}},layout:[],views:{views:{},revision:'1'},status:{enable:false,states:{},actions:[]},customize:{scope:'ALL',desktop:{js:[],css:[]},mobile:{js:[],css:[]}}};
 const mock=makeKintoneMock(prod),loadBase=devBaseLoaderOf({KTDevBase:{load:T.KTDevBase.loadForRelease}},{appId:'310',production:prod,mockRef:()=>mock});
 const calls=[],unexpected=[],errors=[];let held=null,hold=false;const browser=await pw.chromium.launch({channel:'msedge',headless:true});
 try{
 const context=await browser.newContext({viewport:{width:1440,height:900}});await context.route('**/*',route=>{if(route.request().url()==='https://smalltalk.test.invalid/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><body style="margin:0"><div id="app" style="height:100vh"></div><div id="home"></div></body></html>'});unexpected.push(route.request().url());return route.abort();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.exposeFunction('base',loadBase);await page.exposeFunction('api',async(n,a)=>mock.api[n](...a));
 await page.exposeFunction('service',async(n,input)=>{calls.push({n,input});if(n==='getHealth')return structuredClone(health);if(n==='smalltalk'){if(hold){hold=false;await new Promise(r=>held=r);}return{ok:true,version:1,reply:'具体的な変更は、アプリの相談で設定を確認できます。',handoff:true,smalltalkUsage:{monthly:{used:36,limit:300,remaining:264,resetsAt:'2026-11-01T00:00:00+09:00'}}};}return F.proposal();});
 let source=fs.readFileSync(path.join(root,'kintoneAppToolkit.user.js'),'utf8').replace('waitReady().then(() => startToolkit());','');const end=source.lastIndexOf('})();');source=source.slice(0,end)+'\nglobalThis.TestSmall={mountReleaseWorkspace,KTAiClient};\n'+source.slice(end);
 const boot=async()=>{
  await page.goto('https://smalltalk.test.invalid/');await page.addScriptTag({content:source});await page.evaluate(({names,prod})=>{
   const settings=TestSmall.KTAiClient.createSettingsStore();settings.setConsent(true,'release-raw-source-1');
   const client=Object.fromEntries(['getHealth','smalltalk','propose','plan','generate'].map(n=>[n,input=>window.service(n,input)]));
   window.work=TestSmall.mountReleaseWorkspace(document.querySelector('#app'),{appId:'310',settings,session:{client,status:()=>({connected:true,apiBase:'https://gateway.test.invalid'})},loadDevBase:window.base,executor:{api:Object.fromEntries(names.map(n=>[n,(...a)=>window.api(n,a)]))},getInputs:()=>({data:prod}),historyScope:{domain:location.origin,appId:'310',userId:'u1',environment:'preview'},historyOptions:{dbName:'smalltalk-test'},historySessionOptions:{debounceMs:5},copyText:async()=>{},downloadText:()=>{}});
   const home=document.querySelector('#home'),element=document.createElement('div');element.innerHTML='<textarea id="local-code">REGISTERED</textarea>';home.append(element);
   window.editorFiles={version:1,active:'memo.js',files:[{id:'memo.js',name:'memo.js',kind:'js',target:'desktop',environment:'preview',registeredText:'REGISTERED',text:'REGISTERED'}]};
   work.attachCodePanel({home,element,exportDrafts:()=>editorFiles,restoreDrafts:v=>{editorFiles=v;element.querySelector('textarea').value=v.files[0]?.text||'';return true;},canRestoreDrafts:()=>true,subscribeDrafts:()=>()=>{}});
   work.onVisible();
  },{names:Object.keys(mock.api),prod});await page.waitForFunction(()=>work.capability().available===true);await page.evaluate(()=>work.history().ready());
 };
 await boot();await page.evaluate(()=>{editorFiles.files[0].text='HAND_EDIT';document.querySelector('#local-code').value='HAND_EDIT';});const action=n=>page.locator('[data-release-action="'+n+'"]').first();
 const switchChat=async()=>{const open=await action('smalltalk-open').getAttribute('aria-pressed');await action(open==='true'?'smalltalk-close':'smalltalk-open').click();};
 assert.equal(await page.locator('.ktr-tools [data-release-action^="smalltalk-"]').count(),0);
 assert.equal(await page.getByRole('group',{name:'チャットの種類'}).getByRole('button').count(),2);
 assert.equal(await action('smalltalk-close').getAttribute('aria-pressed'),'true');
 await page.locator('#kt-release-input').fill(F.REQUEST);await action('send').click();await page.waitForFunction(()=>work.controller.getState().phase==='proposal');
 const fixed=await page.evaluate(()=>JSON.stringify(work.controller.getState()));await page.locator('#kt-release-input').fill('通常相談の未送信文');
 await action('code').click();await switchChat();assert.equal(await page.locator('#local-code').inputValue(),'HAND_EDIT');assert.equal(calls.filter(c=>c.n==='smalltalk').length,0);assert.equal(await action('documents').count(),0);assert.equal(await action('adopt').isDisabled(),true);assert.equal(await page.evaluate(()=>work.view.requestDocument('資料を作って')),false);
 await page.locator('[data-release-panel="smalltalk-quota"] summary').click();assert.match(await page.locator('[data-release-panel="smalltalk-quota"]').innerText(),/月300回/);assert.match(await page.locator('[data-release-panel="smalltalk-quota"]').innerText(),/1日制限はありません/);
 assert.match(await page.getByRole('group',{name:'チャットの種類'}).innerText(),/クレジット消費なし・月300回まで（契約全体）/);
 const beforeSelection=calls.length;await action('smalltalk-open').click();assert.equal(await action('smalltalk-open').getAttribute('aria-pressed'),'true');assert.equal(calls.length,beforeSelection);
 const reads=mock.calls.length;await page.locator('#kt-smalltalk-input').fill('その案について少し話そう');await action('smalltalk-send').click();await page.waitForFunction(()=>work.smalltalk.getState().turns[0]?.reply);
 assert.equal(await page.locator('#kt-smalltalk-input').evaluate(el=>el===document.activeElement),true);
 assert.ok((await page.locator('[data-release-panel="smalltalk-quota"]').innerText()).includes("今月 36/300回"));assert.equal(await page.evaluate(()=>work.smalltalk.getState().usage.monthly.remaining),264);
 assert.equal(await page.getByText('雑談ではアプリの設定を確認していません。設定に合わせた変更案は、この画面の［アプリの相談］で作れます。',{exact:true}).isVisible(),true);
 const sent=calls.find(c=>c.n==='smalltalk').input;assert.deepEqual(Object.keys(sent).sort(),['history','requestId','signal','text']);assert.ok(!JSON.stringify(sent).includes('PRIVATE_ADMIN_NOTE'));assert.ok(!JSON.stringify(sent).includes('HAND_EDIT'));assert.equal(mock.calls.length,reads);assert.equal(await page.evaluate(()=>JSON.stringify(work.controller.getState())),fixed);
 await action('smalltalk-handoff').click();assert.equal(await page.evaluate(()=>work.view.getDraft()),'通常相談の未送信文');assert.equal(calls.filter(c=>c.n==='smalltalk').length,1);
 await switchChat();assert.equal(await page.locator('#kt-release-input').inputValue(),'通常相談の未送信文');await page.locator('#kt-release-input').fill('');await switchChat();await action('smalltalk-handoff').click();assert.match(await page.locator('#kt-release-input').inputValue(),/未採用/);assert.equal(calls.filter(c=>c.n==='propose').length,1);
 await switchChat();await page.locator('#kt-smalltalk-input').fill('雑談の下書き');await page.evaluate(()=>work.history().flush());
 const saved=await page.evaluate(()=>work.history().exportCurrent());assert.equal(saved.smalltalk.draft,'雑談の下書き');assert.ok(saved.draft.includes('未採用'));await boot();
 assert.equal(await page.locator('#kt-smalltalk-input').inputValue(),'雑談の下書き');assert.equal(await page.locator('[aria-label="雑談の記録"]').getByText('具体的な変更は、アプリの相談で設定を確認できます。').count(),1);assert.equal(calls.filter(c=>c.n==='smalltalk').length,1);assert.equal(await page.evaluate(()=>editorFiles.files[0].text),'HAND_EDIT');
 await action('code').click();assert.equal(await page.locator('#local-code').inputValue(),'HAND_EDIT');
 // Pending smalltalk blocks paid actions and session switching; cancellation never adopts.
 hold=true;await action('smalltalk-send').click();await page.waitForFunction(()=>work.smalltalk.getState().pending);assert.equal(await action('smalltalk-open').isDisabled(),true);assert.equal(await page.evaluate(()=>work.view.canSwitchSession()),false);await action('smalltalk-cancel').click();held();await page.waitForFunction(()=>!work.smalltalk.getState().pending);
 const out=path.join(__dirname,'.build/release-smalltalk');fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'smalltalk.png'),fullPage:true});await page.setViewportSize({width:800,height:900});await page.screenshot({path:path.join(out,'smalltalk-narrow.png'),fullPage:true});
 // Enter submission also returns focus, while editing elsewhere during the wait keeps that focus.
 await page.locator('#kt-smalltalk-input').fill('続けて話そう');await page.locator('#kt-smalltalk-input').press('Enter');await page.waitForFunction(()=>!work.smalltalk.getState().pending);
 assert.equal(await page.locator('#kt-smalltalk-input').evaluate(el=>el===document.activeElement),true);
 hold=true;await page.locator('#kt-smalltalk-input').fill('待っている間に編集する');await action('smalltalk-send').click();await page.waitForFunction(()=>work.smalltalk.getState().pending);
 await page.locator('#local-code').click();held();await page.waitForFunction(()=>!work.smalltalk.getState().pending);
 assert.equal(await page.locator('#local-code').evaluate(el=>el===document.activeElement),true);
 health.smalltalk.available=false;await page.evaluate(()=>work.refreshCapability(true));assert.equal(await action('smalltalk-send').isDisabled(),true);await switchChat();assert.equal(await action('send').isEnabled(),true);
 assert.equal(mock.calls.filter(c=>!c.startsWith('GET')).length,0);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
