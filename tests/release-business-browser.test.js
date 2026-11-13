'use strict';
// All URLs intercepted. Settings and model response are fixed fixtures.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const F=require('./helpers/business-fixture.js');
const root=path.resolve(__dirname,'..');
test('業務理解の無料取得・候補・根拠・保存・旧Gatewayの画面を固定応答で検証',{timeout:90000},async()=>{
 let pw;try{pw=require('playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
 const {describeRegistry}=await import(require('./helpers/ai-repo.js').aiUrl('worker/src/v2/prompt-registry.mjs'));
 const health={limits:{version:1,deadlineMs:{'toolkit.assistant-qa':300000},features:{'toolkit.assistant-qa':{deadlineMsByPurpose:{business:300000,consultation:120000}}}},ok:true,supportedContractVersions:['2.1'],registry:describeRegistry(),entitlements:[{product:'toolkit',features:['assistant-qa','change-planner','customization-generator']}]};
 const jsText="kintone.events.on('app.record.edit.submit', e => { e.record.memo.value = '経理確認待ち'; return e; });";
 const raw=()=>{const d=F.raw();d.javascript.desktop.js=[{type:'FILE',file:{name:'accounting.js',fileKey:'mock-file',size:'100'}}];d.plugins.plugins=[{id:'plugin-one',name:'確認補助プラグイン',enabled:true}];return d;};
 const calls=[],reads=[],unexpected=[],errors=[];let old=false,oldPrice=false,remaining=10,failed=false,mismatch=false,hold=null,modelHold=null,modelFailure=false;
 const usage=()=>({version:4,plan:'toolkit-light',resetsAt:'2099-11-01T00:00:00Z',operationCosts:{consultation:1,document:2,diagnosis:3,final:3,...(oldPrice?{}:{business:10})},credits:{limit:100,used:100-remaining,reserved:0,remaining}});
 const browser=await pw.chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  await context.route('**/*',route=>{if(route.request().url()==='https://business.test.invalid/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><body style="margin:0"><div id="app" style="height:100vh"></div></body></html>'});unexpected.push(route.request().url());return route.abort();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('businessFile',async key=>{assert.equal(key,'mock-file');return jsText;});
  await page.exposeFunction('settingsGet',async(p,args)=>{
   reads.push({p,args});const i=F.C.PATHS.indexOf(p.replace('/k/v1/preview/','').replace('/k/v1/',''));assert.ok(i>=0,p);
   if(hold)await hold;
   if(failed&&i===6)throw Error('fixed failure');
   const value=raw()[F.C.CATEGORIES[i]];if(mismatch&&i===4)value.revision='23';return value;
  });
  await page.exposeFunction('service',async(name,ctx,deadlineMs)=>{
   calls.push({name,ctx});
   if(name==='getHealth'){const h=F.clone(health);h.meta={usage:usage()};if(old)h.registry.toolkit['assistant-qa'].conversation=h.registry.toolkit['assistant-qa'].conversation.filter(x=>x!=='businessWorkflowV1');return h;}
   assert.equal(name,'propose');assert.equal(deadlineMs,300000);assert.equal(ctx.requestPurpose,'document');assert.deepEqual(F.C.validateSnapshot(ctx.businessSnapshot),[]);
   assert.equal(ctx.businessSnapshot.evidence.find(e=>e.kind==='javascript').value.text,jsText);assert.equal(ctx.businessSnapshot.evidence.find(e=>e.kind==='plugin').value.name,'確認補助プラグイン');
   assert.ok(ctx.clientCapabilities.includes('businessUnderstandingCredits10'));assert.ok(ctx.clientCapabilities.includes('businessWorkflowV1'));if(modelHold)await modelHold;if(modelFailure)throw Error('fixed model failure');remaining-=10;return {...F.workflowAnswer(ctx.businessSnapshot),proposalUnchanged:true,usage:usage()};
  });
  await page.goto('https://business.test.invalid/');
  let source=fs.readFileSync(path.join(root,'kintoneAppToolkit.user.js'),'utf8').replace('waitReady().then(() => startToolkit());','');
  const end=source.lastIndexOf('})();');source=source.slice(0,end)+'\nglobalThis.BusinessTest={mountReleaseWorkspace,KTAiClient,KTReleaseHistory};\n'+source.slice(end);
  await page.addScriptTag({content:source});
  await page.evaluate(()=>{
   window.saved=[];window.copies=[];
   const client=Object.fromEntries(['getHealth','propose','plan','generate'].map(name=>[name,input=>window.service(name,input?.ctx,input?.deadlineMs)]));
   window.work=BusinessTest.mountReleaseWorkspace(document.querySelector('#app'),{
    appId:'310',settings:BusinessTest.KTAiClient.createSettingsStore(),session:{client,status:()=>({connected:true,apiBase:'https://gateway.test.invalid'})},
    getBusinessSettings:window.settingsGet,downloadBusinessFile:window.businessFile,loadDevBase:()=>{throw Error('Unexpected baseline read');},getInputs:()=>({data:{appId:'310'}}),
    copyText:async text=>window.copies.push(text),downloadText:(name,text,type)=>window.saved.push({name,text,type})
   });work.onVisible();
  });
  await page.waitForFunction(()=>work.capability().available===true);
  const action=name=>page.locator('[data-release-action="'+name+'"]').first();
  const open=async()=>{await action('understand-business').click();};
  const dialog=()=>page.locator('dialog:has([data-business-read])');
  const read=async()=>{await page.locator('[data-business-read]').click();await page.waitForFunction(()=>!document.querySelector('[data-business-read]').disabled);};
  const generate=()=>page.locator('[data-business-generate]');
  const count=()=>calls.filter(c=>c.name==='propose').length;
  const out=path.join(__dirname,'.build/release-business');fs.mkdirSync(out,{recursive:true});
  await page.locator('#kt-release-input').fill('未送信の相談はそのまま残す');
  assert.deepEqual(await page.getByRole('navigation',{name:'相談を始める'}).locator('.ktr-entry-title').allTextContents(),['アプリを診断','業務工程を読み解く','資料を作る']);
  const entries=page.locator('.ktr-compose-tools'),help=page.locator('.ktr-entry-help');
  assert.equal(await help.getAttribute('open'),null);
  assert.ok((await entries.boundingBox()).height<=40,'入口は通常幅で1行に収める');
  assert.deepEqual(await entries.locator('.ktr-entry-price').allTextContents(),['3クレジット','10クレジット','2クレジット']);
  await help.locator('summary').click();
  assert.match(await help.innerText(),/設定やJSの不整合・改善点を確認/);
  assert.match(await help.innerText(),/設定確認は無料/);
  assert.equal(count(),0);assert.equal(reads.length,0,'案内の開閉ではAIも設定取得も呼ばない');
  await help.locator('summary').click();
  assert.match(await page.locator('#ktr-entry-business').textContent(),/10クレジット/);
  assert.match(await action('documents').getAttribute('title'),/引き継ぎ用の資料/);
  assert.match(await action('understand-business').getAttribute('title'),/誰が・いつ・何をするか.*設定確認は無料/);
  await page.screenshot({path:path.join(out,'entry-wide.png'),fullPage:true});
  await page.setViewportSize({width:320,height:844});
  assert.ok(await action('understand-business').isVisible());
  const entryBox=await action('understand-business').boundingBox();assert.ok(entryBox.x>=0&&entryBox.x+entryBox.width<=320);
  assert.ok((await entries.boundingBox()).height<=120,'狭い画面でも案内を常時展開しない');
  await page.screenshot({path:path.join(out,'entry-narrow.png'),fullPage:true});
  await open();assert.equal(count(),0);assert.equal(reads.length,0,'入口を開くだけでは設定取得もしない');
  assert.equal(await page.locator('#kt-release-input').inputValue(),'未送信の相談はそのまま残す');
  await dialog().locator('[data-close]').click();
  await action('documents').click();assert.equal(await page.locator('[data-business-open]').count(),0);assert.equal(await page.locator('input[name="document-template"]').count(),5);
  await page.locator('dialog [data-close]').click();assert.equal(count(),0);
  await page.setViewportSize({width:1440,height:900});
  await open();assert.equal(await page.locator('[data-business-environment]').inputValue(),'production');
  await read();assert.equal(reads.length,11);assert.ok(reads.every(x=>!x.p.includes('/preview/')));assert.equal(count(),0);
  assert.equal(await generate().isDisabled(),false,await page.locator('[data-business-status]').innerText()+' '+JSON.stringify(await page.evaluate(()=>work.capability())));
  assert.match(await dialog().innerText(),/明示設定なし/);assert.match(await dialog().innerText(),/確認できていない範囲/);
  await page.screenshot({path:path.join(out,'settings-wide.png'),fullPage:true});
  await page.setViewportSize({width:800,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(out,'settings-800.png'),fullPage:true});
  assert.match(await page.locator('[data-business-status]').innerText(),/10クレジット/);
  remaining=9;await page.evaluate(()=>work.refreshCapability(true));assert.equal(await generate().isDisabled(),true);assert.match(await page.locator('[data-business-status]').innerText(),/10クレジットが必要/);assert.equal(count(),0);
  oldPrice=true;await page.evaluate(()=>work.refreshCapability(true));assert.equal(await generate().isDisabled(),true);assert.match(await page.locator('[data-business-status]').innerText(),/サービスへの接続・更新/);assert.equal(count(),0);
  oldPrice=false;remaining=10;await page.evaluate(()=>work.refreshCapability(true));assert.equal(await generate().isDisabled(),false);
  await generate().click();await page.locator('[data-consent]').click();
  await dialog().waitFor({state:'detached'});await page.waitForFunction(()=>work.controller.getState().explanations.length===2);
  assert.equal(count(),1);assert.equal(reads.length,11);assert.equal(await page.locator('#kt-release-input').inputValue(),'未送信の相談はそのまま残す');
  await page.waitForFunction(()=>!document.querySelector('[data-release-action="saved-history"]').disabled);
  assert.equal(await action('smalltalk-open').isEnabled(),true);
  assert.equal(await action('diagnose').isDisabled(),true,'残数不足の無効状態は送信完了後も維持する');
  assert.match(await page.locator('#app').innerText(),/業務工程/);
  // Reopening a saved result works with zero remaining credits and no new AI call.
  const savedBefore=await page.evaluate(()=>JSON.stringify(work.controller.getState().explanations));
  const readsBefore=reads.length;
  await open();assert.equal(await page.locator('[data-business-saved]').isVisible(),true);
  await page.locator('[data-business-saved]>summary').click();
  assert.match(await page.locator('[data-business-saved]').innerText(),/現在の設定との一致は未確認/);
  await page.screenshot({path:path.join(out,'saved-analysis-free.png'),fullPage:true});
  await page.locator('[data-business-show-saved]').click();await dialog().waitFor({state:'detached'});
  assert.equal(count(),1);assert.equal(reads.length,readsBefore);
  assert.equal(await page.evaluate(()=>JSON.stringify(work.controller.getState().explanations)),savedBefore);
  await page.locator('.ktr-workflow-input-facts>summary').first().click();
  assert.match(await page.locator('.ktr-workflow-input-facts').first().innerText(),/この工程での入力義務・担当・時期を意味しません/);
  await page.screenshot({path:path.join(out,'input-setting-facts.png'),fullPage:true});
  await page.locator('[data-business-rule="R1"] > summary').click();
  assert.ok(await page.locator('[data-business-rule="R1"] [data-business-evidence]').count()>=3);
  await action('copy-explanation').click();await action('download-explanation').click();
  const exported=await page.evaluate(()=>({saved,copies}));assert.equal(exported.saved.length,1);assert.equal(exported.copies[0],exported.saved[0].text);
  assert.match(exported.saved[0].text,/実レコード値/);assert.match(exported.saved[0].text,/確認事項/);
  await page.screenshot({path:path.join(out,'candidate-800.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:900});await page.screenshot({path:path.join(out,'candidate-wide.png'),fullPage:true});
  assert.equal(remaining,0);remaining=10;await page.evaluate(()=>work.refreshCapability(true));
  await open();await page.locator('[data-business-environment]').selectOption('preview');await read();
  assert.ok(reads.slice(11).every(x=>x.p.includes('/preview/')));assert.match(await dialog().innerText(),/動作テスト環境/);
  await dialog().locator('[data-close]').click();assert.equal(count(),1);
  failed=true;await open();await read();assert.match(await dialog().innerText(),/取得失敗/);assert.equal(await generate().isDisabled(),false,await page.locator('[data-business-status]').innerText()+' '+JSON.stringify(await page.evaluate(()=>work.capability())));await dialog().locator('[data-close]').click();failed=false;
  mismatch=true;await open();await read();assert.equal(await generate().isDisabled(),true);assert.match(await page.locator('[data-business-status]').innerText(),/同じ設定の版/);await dialog().locator('[data-close]').click();mismatch=false;
  // Closing/Escape detach only the view. Reopening reuses one in-flight read.
  let release;hold=new Promise(r=>{release=r;});let before=await page.evaluate(()=>work.controller.getState().explanations.length);
  await open();await page.locator('[data-business-read]').click();await page.waitForFunction(()=>document.querySelector('[data-business-read]').disabled);
  await dialog().locator('[data-close]').click();await dialog().waitFor({state:'detached'});
  const readsWhileClosed=reads.length;await open();assert.match(await page.locator('[data-business-status]').innerText(),/設定を取得しています/);
  assert.equal(await page.locator('[data-business-read]').isDisabled(),true);assert.equal(reads.length,readsWhileClosed);
  await page.keyboard.press('Escape');await dialog().waitFor({state:'detached'});release();hold=null;
  await page.waitForFunction(n=>work.controller.getState().explanations.length===n+1,before);
  await open();assert.match(await page.locator('[data-business-status]').innerText(),/この取得結果を使用/);assert.equal(await generate().isEnabled(),true);
  assert.equal(count(),1,'閉じた設定取得は無料のまま完了・保存する');
  // Explicit cancellation discards a late settings response, and allows retry.
  hold=new Promise(r=>{release=r;});before=await page.evaluate(()=>work.controller.getState().explanations.length);
  await page.locator('[data-business-read]').click();await page.locator('[data-business-cancel]').click();
  assert.equal(await page.locator('[data-business-cancel]').innerText(),'中断');
  release();hold=null;await page.waitForFunction(()=>!document.querySelector('[data-business-read]').disabled);
  assert.equal(await page.evaluate(()=>work.controller.getState().explanations.length),before);
  assert.match(await page.locator('[data-business-status]').innerText(),/取得を中断しました/);assert.equal(await generate().isDisabled(),true);
  await read();remaining=100;await page.evaluate(()=>work.refreshCapability(true));
  // Closing a generation does not cancel it or start a duplicate request.
  modelHold=new Promise(r=>{release=r;});before=await page.evaluate(()=>work.controller.getState().explanations.length);
  await generate().click();await page.waitForFunction(()=>work.controller.getState().phase==='consulting');
  await dialog().locator('[data-close]').click();await dialog().waitFor({state:'detached'});await open();
  assert.match(await page.locator('[data-business-status]').innerText(),/業務工程を整理しています/);
  assert.equal(await generate().isDisabled(),true);assert.equal(await page.locator('[data-business-cancel]').isEnabled(),true);
  await page.keyboard.press('Escape');await dialog().waitFor({state:'detached'});release();modelHold=null;
  await page.waitForFunction(n=>work.controller.getState().explanations.length===n+1,before);
  await page.waitForFunction(()=>!document.querySelector('[data-release-action="saved-history"]').disabled);
  assert.equal(count(),2);await open();assert.match(await page.locator('[data-business-status]').innerText(),/結果は会話に保存/);
  // Explicit AI cancel ignores late successful responses and keeps prior results.
  modelHold=new Promise(r=>{release=r;});before=await page.evaluate(()=>work.controller.getState().explanations.length);
  await generate().click();await page.waitForFunction(()=>work.controller.getState().phase==='consulting');
  await page.locator('[data-business-cancel]').click();assert.match(await page.locator('[data-business-status]').innerText(),/費用がかかる場合/);
  release();modelHold=null;await page.waitForFunction(()=>!document.querySelector('[data-business-read]').disabled);
  assert.equal(await page.evaluate(()=>work.controller.getState().explanations.length),before);
  assert.equal(await generate().isEnabled(),true);assert.match(await page.locator('[data-business-status]').innerText(),/整理を中断しました/);
  // Background failure is visible when reopened; controls recover without reload.
  modelFailure=true;modelHold=new Promise(r=>{release=r;});
  await generate().click();await page.waitForFunction(()=>work.controller.getState().phase==='consulting');
  await dialog().locator('[data-close]').click();await dialog().waitFor({state:'detached'});release();modelHold=null;
  await page.waitForFunction(()=>!document.querySelector('[data-release-action="saved-history"]').disabled);
  await open();assert.match(await page.locator('[data-business-status]').innerText(),/fixed model failure/);
  assert.equal(await page.locator('[data-business-read]').isEnabled(),true);assert.equal(await generate().isEnabled(),true);
  modelFailure=false;await dialog().locator('[data-close]').click();
  old=true;await action('connect').click();await page.locator('dialog [data-close]').click();
  // Refresh via the existing public onVisible capability probe.
  await page.evaluate(()=>work.refreshCapability(true));await page.waitForFunction(()=>!work.capability().features['assistant-qa'].conversation.includes('businessWorkflowV1'));
  await open();await read();assert.equal(await generate().isDisabled(),true);assert.match(await page.locator('[data-business-status]').innerText(),/対応したサービス/);
  await dialog().locator('[data-close]').click();
  // A saved workflow remains readable, but an old Gateway must never receive it.
  assert.equal(await page.evaluate(async()=>work.controller.startBusiness(work.controller.getState().explanations.find(e=>e.businessUnderstanding?.schemaVersion==='business-workflow-1').id,'R1')),true);
  assert.match(await page.locator('#app').innerText(),/AI相談には対応サービスへの更新が必要/);
  await page.locator('#kt-release-input').fill('この工程の担当者を確認したい');
  await action('send').click();assert.equal(count(),4);
  assert.equal(await page.locator('#kt-release-input').inputValue(),'この工程の担当者を確認したい');
  // Runtime also blocks direct controller calls before transport, not only the button.
  assert.equal(await page.evaluate(()=>work.controller.send('工程の通知先を確認したい')),false);
  assert.equal(count(),4);assert.match(await page.evaluate(()=>work.controller.getState().error.message),/AIサービスの更新が必要/);
  await page.evaluate(()=>work.controller.closeBusiness());
  const storage=await page.evaluate(async()=>{
   const store=BusinessTest.KTReleaseHistory.create({scope:{domain:'fixture.cybozu.com',appId:'310',userId:'fixture',environment:'production'},dbName:'business-offline-capacity',maxBytes:200000});
   const payload=work.controller.exportSession();
   const record={id:'business',revision:null,title:'業務ルール',payload,completedAt:null,pinned:false};
   const saved=await store.save(record),restored=await store.load('business');
   const tooLarge=structuredClone(payload);tooLarge.state.explanations[0].title=Array.from({length:300000},(_,i)=>String.fromCharCode(33+(i%80))).join('');
   const code=await store.save({...record,revision:saved.revision,payload:tooLarge}).then(()=>null,e=>e.code);
   const kept=await store.load('business');store.close();
   return {code,equal:JSON.stringify(restored.payload)===JSON.stringify(payload),retained:JSON.stringify(kept.payload)===JSON.stringify(payload)};
  });
  assert.deepEqual(storage,{code:'HISTORY_LIMIT',equal:true,retained:true});
  assert.equal(count(),4);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
  // Changing conversations/disposal must not save late reads into another session.
  hold=new Promise(r=>{release=r;});await open();await page.locator('[data-business-read]').click();
  await dialog().locator('[data-close]').click();await dialog().waitFor({state:'detached'});
  await page.evaluate(()=>work.controller.newTask());release();hold=null;
  await new Promise(r=>setTimeout(r,100));assert.equal(await page.evaluate(()=>work.controller.getState().explanations.length),0);
  hold=new Promise(r=>{release=r;});await open();await page.locator('[data-business-read]').click();
  await page.evaluate(()=>work.dispose());release();hold=null;
  await new Promise(r=>setTimeout(r,100));assert.equal(await page.evaluate(()=>work.controller.getState().explanations.length),0);
  assert.equal(await dialog().count(),0);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
