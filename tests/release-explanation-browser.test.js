'use strict';
// All browser requests are intercepted. No live AI or kintone is used.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {loadToolkit}=require('./helpers/load-toolkit.js');
const {devBaseLoaderOf}=require('./helpers/dev-base-fake.js');
const {makeKintoneMock}=require('./helpers/kintone-preview-mock.js');
const F=require('./helpers/release-workspace-fixture.js'),E=require('./helpers/release-explanation-fixture.js');
const root=path.resolve(__dirname,'..');
test('同じ相談で概要から引継ぎ資料を作り、コピー保存と説明・変更案の切替はAIを呼ばない',{timeout:90000},async()=>{
 let pw;try{pw=require(process.env.PLAYWRIGHT_MODULE||'playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
 const T=loadToolkit();
 const {describeRegistry}=await import(require('./helpers/ai-repo.js').aiUrl('worker/src/v2/prompt-registry.mjs'));
 const health={ok:true,supportedContractVersions:['2.1'],registry:describeRegistry(),entitlements:[{product:'toolkit',features:['assistant-qa','change-planner','customization-generator']}]};
 const prod={appId:'310',appName:'案件管理',fields:{memo:{type:'MULTI_LINE_TEXT',code:'memo',label:'備考'},ステータス:{type:'STATUS',code:'ステータス',label:'ステータス',enabled:true}},
 layout:[],views:{views:{},revision:'1'},status:{enable:true,states:{作成中:{name:'作成中',index:'0',assignee:{type:'ONE',entities:[]}},承認待ち:{name:'承認待ち',index:'1',assignee:{type:'ONE',entities:[]}},承認済み:{name:'承認済み',index:'2',assignee:{type:'ONE',entities:[]}}},actions:[]},customize:{scope:'ALL',desktop:{js:[],css:[]},mobile:{js:[],css:[]}}};
 const mock=makeKintoneMock(prod),loadBase=devBaseLoaderOf({KTDevBase:{load:T.KTDevBase.loadForRelease}},{appId:'310',production:prod,mockRef:()=>mock});
 const calls=[],unexpected=[],errors=[];let proposalCount=0,missingMark='discussionMetadata';
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
   calls.push({name,ctx});if(name==='getHealth'){const result=E.clone(health);if(missingMark)result.registry.toolkit['assistant-qa'].conversation=result.registry.toolkit['assistant-qa'].conversation.filter(x=>x!==missingMark);return result;}
   if(name==='propose'||name==='plan'){
    assert.equal(ctx.coverage.dependencies,true);
    const scope=ctx.facts.find(f=>f.kind==='dependency-coverage');
    assert.equal(scope.value.environment,'preview');assert.equal(scope.value.appId,'310');
    assert.equal(scope.value.status,'analyzed');assert.ok(scope.value.loadedAt);
    assert.equal(ctx.coverage.incoming,false);assert.ok(scope.value.unchecked.length);
   }
   if(name==='propose'){
    proposalCount++;
    if(proposalCount<=2){
     const answer=E.response(proposalCount===1?'案件管理の仕組み':'案件管理の引継ぎ資料');
     answer.budgetMeta={costUsd:0.01};answer.ai={usage:{input_tokens:100,output_tokens:100}};
     const memo=ctx.facts.find(f=>f.field?.code==='memo');
     assert.ok(memo);answer.explanation.sections.forEach(s=>s.evidenceIds=[memo.id,'unknown']);
     return answer;
    }
    return F.proposal();
   }
   if(name==='plan')return F.plan();
   return F.generated(ctx.customization);
  });
  await page.goto('https://explanation.test.invalid/');
  let source=fs.readFileSync(process.env.KT_SRC||path.join(root,'kintoneAppToolkit.user.js'),'utf8').replace('waitReady().then(() => startToolkit());','');
  const end=source.lastIndexOf('})();');source=source.slice(0,end)+'\nglobalThis.ExplanationTest={mountReleaseWorkspace,KTAiClient};\n'+source.slice(end);
  await page.addScriptTag({content:source});
  await page.evaluate(({names,prod})=>{
   window.saved=[];window.copies=[];
   const client=Object.fromEntries(['getHealth','propose','plan','generate'].map(name=>[name,async input=>window.service(name,input?.ctx)]));
   window.work=ExplanationTest.mountReleaseWorkspace(document.querySelector('#app'),{
    appId:'310',settings:ExplanationTest.KTAiClient.createSettingsStore(),session:{client,status:()=>({connected:true,apiBase:'https://gateway.test.invalid'})},
    loadDevBase:window.base,executor:{api:Object.fromEntries(names.map(name=>[name,(...args)=>window.api(name,args)]))},
    getInputs:()=>({data:prod}),copyText:async text=>window.copies.push(text),downloadText:(name,text,type)=>window.saved.push({name,text,type})
   });
   work.onVisible();
  },{names:Object.keys(mock.api),prod});
  const action=name=>page.locator('[data-release-action="'+name+'"]:visible').first();
  const send=async text=>{await page.locator('#kt-release-input').fill(text);await action('send').click();};
  const countPaid=()=>calls.filter(c=>c.name!=='getHealth').length;
  await page.waitForFunction(()=>work.capability().available===true);
  // A prior Gateway may advertise appExplanation but reject metadata on turn two.
  // Detect that combination before the first paid call, including direct controller use.
  assert.equal(await action('send').isDisabled(),true);
  assert.equal(await page.evaluate(()=>work.controller.send('互換確認前は送らない')),false);
  assert.equal(await page.evaluate(()=>work.controller.getState().error.code),'CAPABILITY_OUTDATED');
  assert.equal(countPaid(),0);
  assert.equal(mock.calls.filter(c=>!c.startsWith('GET')).length,0);
  await page.evaluate(()=>work.controller.newTask());
  missingMark='';await action('connect').click();await page.locator('dialog [data-refresh]').click();
  await page.waitForFunction(()=>work.capability().features['assistant-qa'].conversation.includes('discussionMetadata'));
  await page.locator('dialog [data-close]').click();
  assert.equal(await action('send').isEnabled(),true);assert.equal(countPaid(),0);
  assert.equal(await action('documents').locator('.ktr-entry-title').innerText(),'資料を作る');assert.equal(await action('documents').locator('.ktr-entry-price').innerText(),'2クレジット');
  await send('このアプリの仕組みを教えてください。');await page.locator('[data-consent]').click();
  await page.waitForFunction(()=>work.controller.getState().explanations.length===1);
  assert.equal(await page.locator('.ktr-current').getAttribute('data-release-stage'),'explanation');
  assert.equal(await page.locator('.ktr-explanation h2').innerText(),'案件管理の仕組み');
  assert.equal(await page.locator('[data-release-action="adopt"],[data-release-action="apply"]').count(),0);
  assert.equal(await page.locator('#kt-release-input').isEnabled(),true);
  assert.equal(await page.locator('.ktr-explanation img,.ktr-explanation script,.ktr-explanation iframe').count(),0);
  assert.equal(await page.evaluate(()=>window.injected),undefined);
  const evidence=page.locator('.ktr-explanation details').first();await evidence.locator('summary').first().click();
  assert.match(await evidence.innerText(),/説明作成時の設定|フィールド「備考」の設定/);
  assert.ok(!(await evidence.innerText()).includes('unknown'));

  await send('この説明を引継ぎ資料としてまとめてください。');
  await page.waitForFunction(()=>work.controller.getState().explanations.length===2);
  assert.equal(await page.locator('.ktr-explanation h2').innerText(),'案件管理の引継ぎ資料');
  const proposalCalls=calls.filter(c=>c.name==='propose');
  assert.equal(proposalCalls[1].ctx.conversation.discussion.find(m=>m.role==='assistant').explanation.title,'案件管理の仕組み');
  assert.equal(countPaid(),2);
  const before=await page.evaluate(()=>JSON.stringify(work.controller.getState()));
  await action('copy-explanation').click();await action('download-explanation').click();
  assert.equal(countPaid(),2);assert.equal(await page.evaluate(()=>JSON.stringify(work.controller.getState())),before);
  const exported=await page.evaluate(()=>({copy:copies.at(-1),file:saved.at(-1)}));
  assert.equal(exported.file.text,exported.copy);assert.equal(exported.file.type,'text/markdown;charset=utf-8');assert.equal(exported.file.name,'アプリの説明.md');
  assert.match(exported.copy,/^# 案件管理の引継ぎ資料/);assert.match(exported.copy,/根拠（説明作成時の設定）/);
  assert.doesNotMatch(exported.copy,/MULTI_LINE_TEXT/);
  assert.ok(exported.copy.includes('A\\|B<br>次の行'));assert.ok(exported.copy.includes('\\<img'));
  const ids=await page.evaluate(()=>work.controller.getState().explanations.map(x=>x.id));
  await page.locator('[data-release-panel="explanation-history"]>summary').click();
  await page.locator('[data-release-panel="explanation-history"] [data-release-id="'+ids[0]+'"]').click();
  assert.equal(await page.locator('.ktr-explanation h2').innerText(),'案件管理の仕組み');
  await page.locator('#kt-release-input').fill('あとで詳しく聞きます');
  await action('show-changes').click();assert.equal(await page.locator('#kt-release-input').inputValue(),'あとで詳しく聞きます');
  await action('show-explanation').click();assert.equal(await page.locator('#kt-release-input').inputValue(),'あとで詳しく聞きます');
  assert.equal(countPaid(),2);

  const out=path.join(__dirname,'.build/release-explanation');fs.mkdirSync(out,{recursive:true});
  await page.screenshot({path:path.join(out,'01-explanation.png')});
  await page.setViewportSize({width:320,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const size=await page.locator('.ktr-table-scroll').evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth,overflow:getComputedStyle(el).overflowX}));
  assert.ok(size.scroll>size.width);assert.equal(size.overflow,'auto');
  await page.screenshot({path:path.join(out,'02-narrow.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:900});
  await page.locator('#kt-release-input').fill('');await send(F.REQUEST);
  await page.waitForFunction(()=>work.controller.getState().phase==='proposal');
  await action('adopt').click();await page.waitForFunction(()=>work.controller.getState().phase==='review');
  const prepared=await page.evaluate(()=>JSON.stringify(work.controller.getState().prepared)),paid=countPaid();
  await action('show-explanation').click();assert.equal(await page.locator('[data-release-action="apply"]').count(),0);
  await action('show-changes').click();assert.equal(await action('apply').isEnabled(),true);
  assert.equal(await page.evaluate(()=>JSON.stringify(work.controller.getState().prepared)),prepared);
  assert.equal(countPaid(),paid);assert.equal(mock.calls.filter(c=>!c.startsWith('GET')).length,0);
  await action('show-explanation').click();
  const oldDocument=await page.locator('.ktr-explanation h2').innerText(),beforeOldPaid=countPaid();
  const retained=await page.evaluate(()=>JSON.stringify({messages:work.controller.getState().messages,adopted:work.controller.getState().adopted,prepared:work.controller.getState().prepared}));
  await page.locator('#kt-release-input').fill('採用後の未送信の相談');
  for (const mark of ['appExplanation','discussionMetadata']) {
    missingMark=mark;await action('connect').click();await page.locator('dialog [data-refresh]').click();
    await page.waitForFunction(mark=>!work.capability().features['assistant-qa'].conversation.includes(mark),mark);
    await page.locator('dialog [data-close]').click();
    assert.equal(await action('send').isDisabled(),true);
    assert.equal(await page.locator('.ktr-explanation h2').innerText(),oldDocument);
    assert.equal(await page.locator('#kt-release-input').inputValue(),'採用後の未送信の相談');
    assert.equal(await page.evaluate(()=>JSON.stringify({messages:work.controller.getState().messages,adopted:work.controller.getState().adopted,prepared:work.controller.getState().prepared})),retained);
    await action('copy-explanation').click();assert.equal(countPaid(),beforeOldPaid);
  }
  missingMark='';await action('connect').click();await page.locator('dialog [data-refresh]').click();
  await page.waitForFunction(()=>work.capability().features['assistant-qa'].conversation.includes('discussionMetadata'));
  await page.locator('dialog [data-close]').click();
  assert.equal(await action('send').isEnabled(),true);
  assert.equal(await page.locator('#kt-release-input').inputValue(),'採用後の未送信の相談');
  assert.equal(await page.evaluate(()=>JSON.stringify({messages:work.controller.getState().messages,adopted:work.controller.getState().adopted,prepared:work.controller.getState().prepared})),retained);
  assert.equal(countPaid(),beforeOldPaid);
  assert.equal(mock.calls.filter(c=>!c.startsWith('GET')).length,0);
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  await page.evaluate(()=>work.dispose());
 }finally{await browser.close();}
});
