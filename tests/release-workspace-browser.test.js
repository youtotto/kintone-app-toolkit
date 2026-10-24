'use strict';
// Isolated headless browser. Every network request is intercepted; AI responses and kintone are local fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { devBaseLoaderOf } = require('./helpers/dev-base-fake.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const fixture = require('./helpers/release-workspace-fixture.js');
const root = path.resolve(__dirname, '..');
const bundle = () => {
  const source = fs.readFileSync(path.join(root, 'kintoneAppToolkit.user.js'), 'utf8').replace('waitReady().then(() => startToolkit());', '');
  const end = source.lastIndexOf('})();');
  return source.slice(0,end) + '\nglobalThis.ReleaseTest={mountReleaseWorkspace,KTAiClient};\n' + source.slice(end);
};
function data() {
  return { appId:'310', appName:'案件管理', fields:{
    memo:{type:'MULTI_LINE_TEXT',code:'memo',label:'備考',required:false},
    ステータス:{type:'STATUS',code:'ステータス',label:'ステータス',enabled:true}
  },layout:[], views:{views:{},revision:'1'},status:{enable:true,states:{
    作成中:{name:'作成中',index:'0',assignee:{type:'ONE',entities:[]}},
    承認待ち:{name:'承認待ち',index:'1',assignee:{type:'ONE',entities:[]}},
    承認済み:{name:'承認済み',index:'2',assignee:{type:'ONE',entities:[]}}
  },actions:[]},customize:{scope:'ALL',desktop:{js:[],css:[]},mobile:{js:[],css:[]}} };
}
test('実ブラウザーの正式な操作で相談・採用・確認・反映・復元を通す（外部通信なし）', {timeout:90000}, async () => {
  let playwright;
  if (process.env.PLAYWRIGHT_MODULE) playwright = require(process.env.PLAYWRIGHT_MODULE);
  else {
    try { playwright = require('playwright'); }
    catch (_) { playwright = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  }
  const { describeRegistry } = await import(pathToFileURL(path.join(process.env.KT_AI_REPO || path.resolve(root,'../AI'),'worker/src/v2/prompt-registry.mjs')).href);
  const health = {ok:true,supportedContractVersions:['2.1'],registry:describeRegistry(),entitlements:[{product:'toolkit',features:['assistant-qa','change-planner','customization-generator']}]};
  const t=loadToolkit(), prod=data(), mock=makeKintoneMock(prod);
  const loadBase=devBaseLoaderOf({KTDevBase:{load:t.KTDevBase.loadForRelease}}, {appId:'310',production:prod,mockRef:()=>mock});
  const serviceCalls=[], signals=[], errors=[], unexpected=[];
  let failMobile=false;
  const browser = await playwright.chromium.launch({channel:process.env.BROWSER_CHANNEL || 'msedge',headless:true});
  try {
    const context=await browser.newContext({viewport:{width:1120,height:920}});
    await context.route('**/*', async route => {
      if(route.request().url()==='https://release.test.invalid/') return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><title>Toolkit 作業画面の確認</title><body style="margin:0;background:#f4f7fa"><div id="app" style="height:100vh"></div></body></html>'});
      unexpected.push(route.request().url()); return route.abort();
    });
    const page=await context.newPage();
    page.on('pageerror', e=>errors.push(e.message));
    await page.exposeFunction('testBase',loadBase);
    await page.exposeFunction('testApi',async (name,args)=> {
      try { return {ok:true,value:await mock.api[name](...args)}; }
      catch(e) { return {ok:false,error:{code:e.code,message:e.message,status:e.status}}; }
    });
    await page.exposeFunction('testSignal',x=>signals.push(x));
    await page.exposeFunction('testService',async (name,ctx)=> {
      serviceCalls.push({name,ctx});
      if(name==='getHealth')return health;
      if(name==='propose')return fixture.proposal();
      if(name==='plan')return fixture.plan();
      if(failMobile && ctx.customization.platform[0]==='mobile')return {declined:true,artifactOutcome:fixture.generated(ctx.customization,{state:'incomplete',message:'モバイル用の作成が完了していません。'}).artifactOutcome,
        error:{code:'GENERATION_DECLINED',detail:{summary:'対象のファイルを確認できず、変更を作成しませんでした。',reason:'登録先の指定を確認してください。',warnings:[],coverage:[]}}};
      return fixture.generated(ctx.customization);
    });
    await page.goto('https://release.test.invalid/');
    await page.addScriptTag({content:bundle()});
    await page.evaluate(({names,prod})=>{
      const api=Object.fromEntries(names.map(name=>[name,async(...args)=> {
        const r=await window.testApi(name,args);
        if(!r.ok)throw Object.assign(new Error(r.error.message),r.error);
        return r.value;
      }]));
      const client=Object.fromEntries(['getHealth','propose','plan','generate'].map(name=>[name,async input=>{
        const response=await window.testService(name,input?.ctx);
        if(response.declined)throw Object.assign(new Error('作成を完了できませんでした。'),{code:'GENERATION_DECLINED',details:response});
        return response;
      }]));
      const settings=ReleaseTest.KTAiClient.createSettingsStore();
      // Old consent for a different send scope must not suppress the new confirmation.
      settings.setConsent(true);
      const session={client,status:()=>({connected:true,apiBase:'https://gateway.test.invalid'}),disconnect:async()=>{}};
      window.work=ReleaseTest.mountReleaseWorkspace(document.querySelector('#app'),{
        appId:'310',settings,session,loadDevBase:window.testBase,executor:{api},
        getInputs:()=>({data:prod,deps:{},scan:{files:[]}}),
        copyText:async text=>{window.copied=text;},downloadText:()=>{},
        onSettingsChanged:window.testSignal,canAutoFetch:()=>true
      });
      window.work.onVisible();
    },{names:Object.keys(mock.api),prod});
    const phase=async value=>page.waitForFunction(v=>window.work.controller.getState().phase===v,value);
    const action=name=>page.locator('[data-release-action="'+name+'"]').first();
    await page.waitForFunction(()=>window.work.capability().available);
    await page.locator('#kt-release-input').fill(fixture.REQUEST);
    await action('send').click();
    await page.locator('[data-consent]').waitFor();
    assert.equal(serviceCalls.filter(c=>c.name==='propose').length,0);
    await page.locator('[data-consent]').click();
    await phase('proposal');
    assert.equal(serviceCalls.filter(c=>c.name==='plan').length,0);
    await action('adopt').click(); await phase('review');
    assert.equal(mock.calls.filter(c=>!c.startsWith('GET')).length,0);
    assert.equal(await page.locator('.ktr-workspace main .ktr-primary').count(),1);
    assert.match(await page.locator('main').innerText(),/承認待ち|備考/);
    assert.doesNotMatch(await page.locator('body').innerText(),/米ドル|token|トークン|var は|担当が計画に/);
    const out=path.join(root,'tests/.build/release-browser');fs.mkdirSync(out,{recursive:true});
    await page.screenshot({path:path.join(out,'review.png'),fullPage:true});
    await action('consult').click();
    await page.locator('#kt-release-input').fill('入力途中の文章');
    await page.evaluate(()=>window.work.view.render());
    assert.equal(await page.locator('#kt-release-input').inputValue(),'入力途中の文章');
    await action('current').click();
    await action('apply').click(); await phase('result');
    const run=await page.evaluate(()=>window.work.controller.getState().runs.at(-1));
    assert.equal(run.status,'complete',JSON.stringify(run.result));
    assert.equal(mock.st.customize.desktop.js.length,1);
    assert.equal(mock.st.customize.mobile.js.length,1);
    assert.ok(mock.st.views['承認待ち']);
    assert.deepEqual(mock.st.prodViews,{});
    assert.ok(signals.some(s=>s.preview===true && s.production===false));
    await action('request-rollback').click();await phase('rollback-confirm');
    await action('cancel-rollback').click();await phase('result');
    assert.equal(mock.st.customize.desktop.js.length,1);
    await action('request-rollback').click();await phase('rollback-confirm');
    await action('rollback').click();await phase('result');
    assert.equal(await page.evaluate(()=>window.work.controller.getState().runs.at(-1).rollback.status),'complete');
    assert.equal(mock.st.customize.desktop.js.length,0);
    assert.deepEqual(mock.st.views,{});
    await page.screenshot({path:path.join(out,'restored.png'),fullPage:true});
    // A second, incomplete conversation stays unwriteable and the previous record remains available.
    failMobile=true;
    await action('new-task').click();
    await page.locator('#kt-release-input').fill(fixture.REQUEST);await action('send').click();await phase('proposal');
    await action('adopt').click();await phase('incomplete');
    assert.match(await page.locator('main').innerText(),/対象のファイルを確認できず、変更を作成しませんでした/);
    assert.equal(await page.locator('[data-release-action="apply"]').count(),0);
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'narrow layout must not overflow');
    await page.screenshot({path:path.join(out,'incomplete-mobile.png'),fullPage:true});
    await action('free-context').click();
    await page.locator('dialog [data-kind]').waitFor();
    await page.locator('dialog [data-make]').click();
    assert.ok((await page.locator('dialog [data-output]').inputValue()).length>50);
    await page.locator('dialog [data-close]').click();
    assert.deepEqual(errors,[]);
    assert.deepEqual(unexpected,[]);
    await page.evaluate(()=>window.work.dispose());
  } finally { await browser.close(); }
});
