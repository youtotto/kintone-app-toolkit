'use strict';
// Local browser only: every request is intercepted; no live AI, kintone or connection service.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),STAGING='https://appinsight-ai-api-staging.black-waterfall-157a.workers.dev';
function bundle(){
 const source=fs.readFileSync(process.env.KT_SRC||path.join(root,'kintoneAppToolkit.user.js'),'utf8').replace('waitReady().then(() => startToolkit());','');
 const end=source.lastIndexOf('})();');
 return source.slice(0,end)+'\nglobalThis.ConnectionTest={mountReleaseWorkspace,KTAiClient,KTAiBudget};\n'+source.slice(end);
}
test('検証用接続先の切替は未接続・会話前に限定し、保存確認と接続情報の分離を保つ',{timeout:90000},async t=>{
 let pw;try{pw=require(process.env.PLAYWRIGHT_MODULE||'playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
 const browser=await pw.chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 try{
  async function setup(options={}){
   let releaseComplete=null;const requests=[],errors=[],context=await browser.newContext({viewport:{width:1200,height:900}});
   await context.route('**/*',async route=>{
    const url=route.request().url();
    if(url==='https://connection.test.invalid/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div id="app" style="height:100vh"></div>'});
    if(url==='https://authorize.test.invalid/')return route.fulfill({contentType:'text/html',body:'固定の承認画面'});
    requests.push({url,headers:route.request().headers(),body:route.request().postData()});
    if(options.completePending){
     let response=null;
     if(url.endsWith('/v2/connect/start'))response={ok:true,sessionId:'fixed-session',authorizeUrl:'https://authorize.test.invalid/',expiresAt:'2099-01-01T00:00:00Z',pollIntervalSeconds:1};
     if(url.includes('/v2/connect/status?'))response={ok:true,status:'authorized'};
     if(url.endsWith('/v2/connect/complete')){await new Promise(resolve=>releaseComplete=resolve);response={ok:true,accessToken:'production-access',expiresAt:'2099-01-01T00:00:00Z',refreshToken:'production-refresh',refreshExpiresAt:'2099-01-01T00:00:00Z',scope:{product:'toolkit'}};}
     if(response)return route.fulfill({contentType:'application/json',body:JSON.stringify(response)});
    }
    return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,contractVersion:'2.1',error:{code:'UNAVAILABLE',message:'固定応答'}})});
   });
   const page=await context.newPage();page.setDefaultTimeout(3000);page.on('pageerror',e=>errors.push(e.message));await page.goto('https://connection.test.invalid/');
   await page.addScriptTag({content:bundle()});
   await page.evaluate(options=>{
    const C=ConnectionTest;window.settings=C.KTAiClient.createSettingsStore();window.originalSave=settings.save.bind(settings);
    if(options.saved)originalSave(options.saved);
    settings.setConsent(true,'release-raw-source-1');
    localStorage.setItem('unchanged-budget-proof','existing-accounting');
    window.saveCalls=0;
    settings.save=value=>{saveCalls++;if(options.fail==='false')return false;if(options.fail==='false-after-write'){originalSave(value);return false;}if(options.fail==='throw')throw Error('保存不可');if(options.fail==='ignored')return true;if(options.fail==='wrong')return originalSave({...value,apiBase:C.KTAiClient.DEFAULT_API_BASE});return originalSave(value);};
    window.session=C.KTAiClient.createSession({store:settings,locks:null});
    if(options.holdHealth)session.client.getHealth=()=>new Promise(resolve=>window.releaseHealth=resolve);
    if(options.access){session.adopt({accessToken:'old-access-only',expiresAt:'2099-01-01T00:00:00Z',refreshToken:'',refreshExpiresAt:null,scope:null});window.saveCalls=0;}
    const budget=C.KTAiBudget.create({storage:localStorage,session:sessionStorage,host:'connection.test.invalid',locks:null});
    window.budget=budget;
    window.work=C.mountReleaseWorkspace(document.querySelector('#app'),{appId:'310',settings,session,budget,
      loadDevBase:()=>options.holdBase?new Promise(resolve=>window.releaseBase=resolve):Promise.resolve({ok:true,current:{},stamp:'empty',revision:{preview:'1'},files:[],inputs:{data:{appId:'310',fields:{}}}}),
      executor:{api:{}},getInputs:()=>({data:{appName:'接続の無料試験'}}),canAutoFetch:()=>false});
   },options);
   const open=async()=>{await page.locator('[data-release-action="connect"]').first().click();await page.locator('dialog [data-budget-panel] > summary').click();};
   const select=()=>page.locator('dialog [data-staging-select]');
   return {page,context,requests,errors,open,select,completeReady:()=>!!releaseComplete,complete:()=>releaseComplete()};
  }
  await t.test('未接続の既定環境からのみ固定stagingへ保存し、下書き・同意・利用記録を保つ',async()=>{
   const h=await setup();try{
    await h.page.locator('#kt-release-input').evaluate(el=>{el.value='まだ送らない下書き';el.dispatchEvent(new Event('input',{bubbles:true}));});await h.open();
    await h.select().waitFor({state:'visible',timeout:2500});assert.equal(await h.select().isEnabled(),true);
    const before=await h.page.evaluate(()=>({consent:settings.hasConsent('release-raw-source-1'),budget:budget.summary()}));
    await h.select().click();
    assert.equal(await h.page.evaluate(()=>session.status().apiBase),STAGING);assert.equal(await h.page.evaluate(()=>saveCalls),1);
    assert.deepEqual(await h.page.evaluate(()=>settings.load()),{apiBase:STAGING,refreshToken:'',refreshExpiresAt:null,scope:null,connectedAt:null});
    assert.match(await h.page.locator('[data-staging-note]').innerText(),/変更は不要/);
    assert.match(await h.page.locator('[data-message]').innerText(),/検証用.*切り替え/);
    assert.equal(await h.select().isDisabled(),true);assert.deepEqual(h.requests,[]);
    assert.equal(await h.page.evaluate(()=>settings.hasConsent('release-raw-source-1')),before.consent);
    assert.deepEqual(await h.page.evaluate(()=>budget.summary()),before.budget);
    assert.equal(await h.page.evaluate(()=>localStorage.getItem('unchanged-budget-proof')),'existing-accounting');
    assert.equal(await h.page.locator('#kt-release-input').inputValue(),'まだ送らない下書き');
    await h.page.locator('[data-connect]').click();
    await h.page.waitForFunction(()=>document.querySelector('[data-connect]').disabled===false);
    assert.ok(h.requests.some(r=>r.url===STAGING+'/v2/connect/start'));
    assert.ok(h.requests.every(r=>r.url.startsWith(STAGING+'/')));
    assert.ok(h.requests.every(r=>!r.headers.authorization),'切替後の接続開始に古いtokenは送らない');
    await h.page.evaluate(()=>session.adopt({accessToken:'new-staging-access',expiresAt:'2099-01-01T00:00:00Z',refreshToken:'new-staging-refresh',refreshExpiresAt:'2099-01-01T00:00:00Z'}));
    await h.page.locator('[data-refresh]').click();await h.page.waitForFunction(()=>document.querySelector('[data-refresh]').disabled===false);
    assert.ok(h.requests.some(r=>r.url===STAGING+'/v2/health'&&r.headers.authorization==='Bearer new-staging-access'));
    assert.ok(h.requests.every(r=>r.url.startsWith(STAGING+'/')));
   }finally{await h.context.close();}assert.deepEqual(h.errors,[]);
  });
  for(const [name,saved,access] of [
   ['有効な接続',{refreshToken:'existing-refresh',refreshExpiresAt:'2099-01-01T00:00:00Z'},false],
   ['期限切れの接続情報',{refreshToken:'expired-refresh',refreshExpiresAt:'2020-01-01T00:00:00Z'},false],
   ['更新処理の記録',{refreshAttempt:{requestId:'old-request',at:'2020-01-01T00:00:00Z'}},false],
   ['メモリのaccess',null,true]
  ])await t.test(name+'を他の接続先へ移さない',async()=>{
   const h=await setup({saved,access});try{
    await h.open();assert.equal(await h.select().isDisabled(),true);
    const before=await h.page.evaluate(()=>settings.load());await h.select().dispatchEvent('click');
    assert.equal(await h.page.evaluate(()=>saveCalls),0);assert.deepEqual(await h.page.evaluate(()=>settings.load()),before);assert.deepEqual(h.requests,[]);
   }finally{await h.context.close();}assert.deepEqual(h.errors,[]);
  });
  for(const fail of ['false','false-after-write','throw','ignored','wrong'])await t.test('保存失敗 '+fail+' では成功扱いせず接続も更新も始めない',async()=>{
   const h=await setup({fail});try{
    await h.open();await h.select().click();assert.match(await h.page.locator('[data-message]').innerText(),/保存.*確認できません/);
    assert.equal(await h.page.locator('[data-connect]').isDisabled(),true);assert.equal(await h.page.locator('[data-refresh]').isDisabled(),true);
    await h.page.locator('[data-connect]').dispatchEvent('click');await h.page.locator('[data-refresh]').dispatchEvent('click');
    assert.deepEqual(h.requests,[]);assert.equal(await h.page.evaluate(()=>saveCalls),1);
    await h.page.locator('[data-close]').click();await h.open();assert.equal(await h.page.locator('[data-connect]').isDisabled(),true,'閉じ直しても保存失敗を無視しない');
    await h.page.evaluate(()=>{settings.save=value=>{saveCalls++;return originalSave(value);};});await h.select().click();
    assert.equal(await h.page.evaluate(()=>session.status().apiBase),STAGING);assert.equal(await h.page.locator('[data-connect]').isEnabled(),true);
   }finally{await h.context.close();}assert.deepEqual(h.errors,[]);
  });
  await t.test('staging設定済みは再保存しない',async()=>{
   const h=await setup({saved:{apiBase:STAGING}});try{await h.open();assert.equal(await h.select().isDisabled(),true);await h.select().dispatchEvent('click');assert.equal(await h.page.evaluate(()=>saveCalls),0);assert.match(await h.page.locator('[data-staging-note]').innerText(),/変更は不要/);assert.deepEqual(h.requests,[]);}finally{await h.context.close();}
  });
  await t.test('接続確認の処理中は切り替えず、完了後に再操作できる',async()=>{
   const h=await setup({holdHealth:true});try{
    await h.page.evaluate(()=>{work.refreshCapability();});await h.open();assert.equal(await h.select().isDisabled(),true);await h.select().dispatchEvent('click');assert.equal(await h.page.evaluate(()=>saveCalls),0);
    await h.page.evaluate(()=>releaseHealth({ok:true,supportedContractVersions:['2.1'],registry:{},entitlements:[]}));
    await h.page.locator('[data-close]').click();await h.open();assert.equal(await h.select().isEnabled(),true);await h.select().click();assert.equal(await h.page.evaluate(()=>session.status().apiBase),STAGING);assert.deepEqual(h.requests,[]);
   }finally{await h.context.close();}
  });
  await t.test('接続承認の完了待ちに閉じ直しても旧環境のtokenをstagingへ移さない',async()=>{
   const h=await setup({completePending:true});try{
    await h.open();await h.page.locator('[data-connect]').click();
    await h.page.waitForFunction(()=>document.querySelector('[data-message]').textContent==='接続を準備しています。');
    for(let i=0;i<100&&!h.completeReady();i++)await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(h.completeReady(),true);
    await h.page.locator('[data-close]').click();await h.open();assert.equal(await h.select().isDisabled(),true);assert.equal(await h.page.locator('[data-connect]').isDisabled(),true);
    await h.select().dispatchEvent('click');assert.equal(await h.page.evaluate(()=>saveCalls),0);h.complete();
    await h.page.waitForFunction(()=>session.status().connected&&!document.querySelector('[data-connect]').disabled);
    assert.equal(await h.page.evaluate(()=>settings.load().apiBase),await h.page.evaluate(()=>ConnectionTest.KTAiClient.DEFAULT_API_BASE));
    assert.equal(await h.page.evaluate(()=>settings.load().refreshToken),'production-refresh');
    assert.equal(await h.select().isDisabled(),true);assert.ok(h.requests.every(r=>!r.url.startsWith(STAGING)));
   }finally{await h.context.close();}assert.deepEqual(h.errors,[]);
  });
  await t.test('会話の処理中と中断後の会話がある状態では切り替えない',async()=>{
   const h=await setup({holdBase:true});try{
    await h.page.evaluate(()=>{work.controller.send('固定の依頼');});await h.open();assert.equal(await h.select().isDisabled(),true);await h.select().dispatchEvent('click');assert.equal(await h.page.evaluate(()=>saveCalls),0);
    await h.page.evaluate(()=>work.controller.cancel());assert.equal(await h.select().isDisabled(),true);await h.select().dispatchEvent('click');assert.equal(await h.page.evaluate(()=>saveCalls),0);assert.deepEqual(h.requests,[]);
   }finally{await h.context.close();}
  });
 }finally{await browser.close();}
});
