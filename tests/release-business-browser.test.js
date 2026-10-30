'use strict';
// All URLs intercepted. Settings and model response are fixed fixtures.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const F=require('./helpers/business-fixture.js');
const root=path.resolve(__dirname,'..');
test('業務理解の無料取得・候補・根拠・保存・旧Gatewayの画面を固定応答で検証',{timeout:90000},async()=>{
 let pw;try{pw=require('playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
 const {describeRegistry}=await import(pathToFileURL(path.join(root,'../AI/worker/src/v2/prompt-registry.mjs')).href);
 const health={ok:true,supportedContractVersions:['2.1'],registry:describeRegistry(),entitlements:[{product:'toolkit',features:['assistant-qa','change-planner','customization-generator']}]};
 const calls=[],reads=[],unexpected=[],errors=[];let old=false,failed=false,mismatch=false,hold=null;
 const browser=await pw.chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  await context.route('**/*',route=>{if(route.request().url()==='https://business.test.invalid/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><body style="margin:0"><div id="app" style="height:100vh"></div></body></html>'});unexpected.push(route.request().url());return route.abort();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('settingsGet',async(p,args)=>{
   reads.push({p,args});const i=F.C.PATHS.indexOf(p.replace('/k/v1/preview/','').replace('/k/v1/',''));assert.ok(i>=0,p);
   if(hold)await hold;
   if(failed&&i===6)throw Error('fixed failure');
   const value=F.raw()[F.C.CATEGORIES[i]];if(mismatch&&i===4)value.revision='23';return value;
  });
  await page.exposeFunction('service',async(name,ctx)=>{
   calls.push({name,ctx});
   if(name==='getHealth'){const h=F.clone(health);if(old)h.registry.toolkit['assistant-qa'].conversation=h.registry.toolkit['assistant-qa'].conversation.filter(x=>x!=='businessUnderstandingV1');return h;}
   assert.equal(name,'propose');assert.equal(ctx.requestPurpose,'document');assert.deepEqual(F.C.validateSnapshot(ctx.businessSnapshot),[]);
   return {...F.answer(ctx.businessSnapshot),proposalUnchanged:true};
  });
  await page.goto('https://business.test.invalid/');
  let source=fs.readFileSync(path.join(root,'kintoneAppToolkit.user.js'),'utf8').replace('waitReady().then(() => startToolkit());','');
  const end=source.lastIndexOf('})();');source=source.slice(0,end)+'\nglobalThis.BusinessTest={mountReleaseWorkspace,KTAiClient,KTReleaseHistory};\n'+source.slice(end);
  await page.addScriptTag({content:source});
  await page.evaluate(()=>{
   window.saved=[];window.copies=[];
   const client=Object.fromEntries(['getHealth','propose','plan','generate'].map(name=>[name,input=>window.service(name,input?.ctx)]));
   window.work=BusinessTest.mountReleaseWorkspace(document.querySelector('#app'),{
    appId:'310',settings:BusinessTest.KTAiClient.createSettingsStore(),session:{client,status:()=>({connected:true,apiBase:'https://gateway.test.invalid'})},
    getBusinessSettings:window.settingsGet,loadDevBase:()=>{throw Error('Unexpected baseline read');},getInputs:()=>({data:{appId:'310'}}),
    copyText:async text=>window.copies.push(text),downloadText:(name,text,type)=>window.saved.push({name,text,type})
   });work.onVisible();
  });
  await page.waitForFunction(()=>work.capability().available===true);
  const action=name=>page.locator('[data-release-action="'+name+'"]').first();
  const open=async()=>{await action('documents').click();await page.locator('[data-business-open]').click();};
  const dialog=()=>page.locator('dialog:has([data-business-read])');
  const read=async()=>{await page.locator('[data-business-read]').click();await page.waitForFunction(()=>!document.querySelector('[data-business-read]').disabled);};
  const generate=()=>page.locator('[data-business-generate]');
  const count=()=>calls.filter(c=>c.name==='propose').length;
  const out=path.join(__dirname,'.build/release-business');fs.mkdirSync(out,{recursive:true});
  await page.locator('#kt-release-input').fill('未送信の相談はそのまま残す');
  await open();assert.equal(await page.locator('[data-business-environment]').inputValue(),'production');
  await read();assert.equal(reads.length,9);assert.ok(reads.every(x=>!x.p.includes('/preview/')));assert.equal(count(),0);
  assert.equal(await generate().isDisabled(),false,await page.locator('[data-business-status]').innerText()+' '+JSON.stringify(await page.evaluate(()=>work.capability())));
  assert.match(await dialog().innerText(),/明示設定なし/);assert.match(await dialog().innerText(),/確認できていない範囲/);
  await page.screenshot({path:path.join(out,'settings-wide.png'),fullPage:true});
  await page.setViewportSize({width:800,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(out,'settings-800.png'),fullPage:true});
  await generate().click();await page.locator('[data-consent]').click();
  await dialog().waitFor({state:'detached'});await page.waitForFunction(()=>work.controller.getState().explanations.length===2);
  assert.equal(count(),1);assert.equal(reads.length,9);assert.equal(await page.locator('#kt-release-input').inputValue(),'未送信の相談はそのまま残す');
  assert.match(await page.locator('#app').innerText(),/推測した業務ルール候補/);
  await page.locator('[data-business-rule="R1"] > summary').click();
  assert.ok(await page.locator('[data-business-rule="R1"] [data-business-evidence]').count()>=3);
  await action('copy-explanation').click();await action('download-explanation').click();
  const exported=await page.evaluate(()=>({saved,copies}));assert.equal(exported.saved.length,1);assert.equal(exported.copies[0],exported.saved[0].text);
  assert.match(exported.saved[0].text,/実レコード値/);assert.match(exported.saved[0].text,/確認事項/);
  await page.screenshot({path:path.join(out,'candidate-800.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:900});await page.screenshot({path:path.join(out,'candidate-wide.png'),fullPage:true});
  await open();await page.locator('[data-business-environment]').selectOption('preview');await read();
  assert.ok(reads.slice(9).every(x=>x.p.includes('/preview/')));assert.match(await dialog().innerText(),/動作テスト環境/);
  await dialog().locator('[data-close]').click();assert.equal(count(),1);
  failed=true;await open();await read();assert.match(await dialog().innerText(),/取得失敗/);assert.equal(await generate().isDisabled(),false,await page.locator('[data-business-status]').innerText()+' '+JSON.stringify(await page.evaluate(()=>work.capability())));await dialog().locator('[data-close]').click();failed=false;
  mismatch=true;await open();await read();assert.equal(await generate().isDisabled(),true);assert.match(await page.locator('[data-business-status]').innerText(),/同じ設定の版/);await dialog().locator('[data-close]').click();mismatch=false;
  // Closing a blocked read must discard its late completion.
  let release;hold=new Promise(r=>{release=r;});const before=await page.evaluate(()=>work.controller.getState().explanations.length);
  await open();await page.locator('[data-business-read]').click();await dialog().locator('[data-close]').click();release();hold=null;
  await new Promise(r=>setTimeout(r,100));assert.equal(await page.evaluate(()=>work.controller.getState().explanations.length),before);
  old=true;await action('connect').click();await page.locator('dialog [data-close]').click();
  // Refresh via the existing public onVisible capability probe.
  await page.evaluate(()=>work.refreshCapability(true));await page.waitForFunction(()=>!work.capability().features['assistant-qa'].conversation.includes('businessUnderstandingV1'));
  await open();await read();assert.equal(await generate().isDisabled(),true);assert.match(await page.locator('[data-business-status]').innerText(),/対応したサービス/);
  await dialog().locator('[data-close]').click();
  const storage=await page.evaluate(async()=>{
   const store=BusinessTest.KTReleaseHistory.create({scope:{domain:'fixture.cybozu.com',appId:'310',userId:'fixture',environment:'production'},dbName:'business-offline-capacity',maxBytes:65536});
   const payload=work.controller.exportSession();
   const record={id:'business',revision:null,title:'業務ルール',payload,completedAt:null,pinned:false};
   const saved=await store.save(record),restored=await store.load('business');
   const tooLarge=structuredClone(payload);tooLarge.state.explanations[0].title=Array.from({length:70000},(_,i)=>String.fromCharCode(33+(i%80))).join('');
   const code=await store.save({...record,revision:saved.revision,payload:tooLarge}).then(()=>null,e=>e.code);
   const kept=await store.load('business');store.close();
   return {code,equal:JSON.stringify(restored.payload)===JSON.stringify(payload),retained:JSON.stringify(kept.payload)===JSON.stringify(payload)};
  });
  assert.deepEqual(storage,{code:'HISTORY_LIMIT',equal:true,retained:true});
  assert.equal(count(),1);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
  await page.evaluate(()=>work.dispose());
 }finally{await browser.close();}
});
