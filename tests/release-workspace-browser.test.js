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
const supplement = {
  impact: ['PC用のJavaScriptへ備考の編集制御を追加します。', 'モバイル用のJavaScriptへ備考の編集制御を追加します。'],
  common: 'PCとモバイルの画面で備考の編集を制限します。',
  assumption: '差し戻した後は編集画面を開き直してください。',
  warning: 'ほかの仕組みからの更新は、このJavaScriptでは制限しません。',
  desktop: 'PCの編集画面を開いたときに切り替わります。',
  mobile: 'モバイルの編集画面を開いたときに切り替わります。'
};
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
  },actions:[]},customize:{scope:'NONE',desktop:{js:[],css:[]},mobile:{js:[],css:[]}} };
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
  let failMobile=false, heldProposal=null;
  const browser = await playwright.chromium.launch({channel:process.env.BROWSER_CHANNEL || 'msedge',headless:true});
  try {
    const context=await browser.newContext({viewport:{width:1120,height:920}});
    await context.route('**/*', async route => {
      if(route.request().url()==='https://release.test.invalid/') return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja" style="height:100%"><meta charset="utf-8"><title>Toolkit 作業画面の確認</title><body style="margin:0;height:100%;background:#f4f7fa"><div id="app" style="height:100%;display:flex;flex-direction:column;min-height:0"></div></body></html>'});
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
      if(name==='propose')return heldProposal ? heldProposal.promise : fixture.proposal('承認待ちの一覧を追加します。承認済みの場合、備考を編集できなくします。\n' + '既存の設定と入力チェックを維持します。'.repeat(35));
      if(name==='plan') {
        const plan=fixture.plan();
        plan.impact=[...supplement.impact, supplement.common].map(description=>({description}));
        for(const customization of plan.customizations)customization.risks=[supplement.common];
        return plan;
      }
      if(failMobile && ctx.customization.platform[0]==='mobile')return {declined:true,artifactOutcome:fixture.generated(ctx.customization,{state:'incomplete',message:'モバイル用の作成が完了していません。'}).artifactOutcome,
        error:{code:'GENERATION_DECLINED',detail:{summary:'対象のファイルを確認できず、変更を作成しませんでした。',reason:'登録先の指定を確認してください。',warnings:[],coverage:[]}}};
      const generated=fixture.generated(ctx.customization);
      generated.assumptions=[supplement.assumption];
      generated.warnings=[supplement.common,supplement.warning,supplement[ctx.customization.platform[0]]];
      return generated;
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
    assert.equal(await page.locator('#kt-release-input').count(),1);
    assert.match(await page.locator('.ktr-chat-log').innerText(),/既存の設定と入力チェックを維持します/);
    assert.equal(serviceCalls.filter(c=>c.name==='plan').length,0);
    await action('adopt').click(); await phase('review');
    assert.equal(mock.calls.filter(c=>!c.startsWith('GET')).length,0);
    assert.equal(await page.locator('.ktr-workspace main .ktr-primary').count(),1);
    assert.match(await page.locator('main').innerText(),/承認待ち|備考/);
    assert.doesNotMatch(await page.locator('body').innerText(),/米ドル|token|トークン|var は|担当が計画に/);
    // The real executor supplies this confirmation from the fixture's disabled customization scope.
    const confirmation=page.locator('main .ktr-confirmations');
    assert.equal(await confirmation.count(),1);
    assert.equal(await confirmation.isVisible(),true);
    assert.equal(await confirmation.evaluate(el=>el.closest('details')===null),true);
    assert.match(await confirmation.innerText(),/現在無効|有効化はしません/);
    const notices=page.getByRole('heading',{name:'前提と注意点',exact:true}).locator('..');
    assert.equal(await notices.isVisible(),true);
    assert.equal(await notices.evaluate(el=>el.closest('details')===null),true);
    const noticeRows=await notices.locator('li > span').allTextContents();
    for(const text of [supplement.common,supplement.assumption,supplement.warning,supplement.desktop,supplement.mobile])
      assert.equal(noticeRows.filter(row=>row===text).length,1,'each full notice remains visible exactly once');
    const sourceOf=text=>notices.getByText(text,{exact:true}).locator('..').locator('p.ktr-note').innerText();
    assert.equal(await sourceOf(supplement.common),'説明元：PC／モバイル','a shared notice keeps both origins');
    assert.equal(await sourceOf(supplement.desktop),'説明元：PC','the PC-specific notice keeps its short source');
    assert.equal(await sourceOf(supplement.mobile),'説明元：モバイル','the mobile-specific notice keeps its short source');
    const changeTitles=fixture.plan().customizations.map(c=>c.requirement);
    const repeatedHeadings=await page.locator('main h3:visible,main h4:visible').allTextContents();
    for(const title of changeTitles)assert.equal(repeatedHeadings.includes(title),false,'change names are not repeated as supplement headings');
    const explanation=page.getByText('計画の説明を見る',{exact:true}).locator('..');
    assert.equal(await explanation.evaluate(el=>el.tagName==='DETAILS'&&!el.open),true);
    for(const text of supplement.impact)assert.equal((await page.locator('main').innerText()).includes(text),false,'impact descriptions begin folded');
    const preparedBeforeSupplement=await page.evaluate(()=>JSON.stringify(window.work.controller.getState().prepared));
    await explanation.locator(':scope > summary').click();
    for(const text of [...supplement.impact,supplement.common])assert.ok((await explanation.innerText()).includes(text),'the full plan description is still accessible');
    await explanation.locator(':scope > summary').click();
    assert.equal(await page.evaluate(()=>JSON.stringify(window.work.controller.getState().prepared)),preparedBeforeSupplement);
    assert.equal(await page.locator('[data-release-action="apply"]').count(),1);
    assert.equal(await action('apply').isEnabled(),true);
    assert.equal(mock.calls.filter(c=>!c.startsWith('GET')).length,0);
    const out=path.join(root,'tests/.build/release-browser');fs.mkdirSync(out,{recursive:true});
    await page.screenshot({path:path.join(out,'review.png'),fullPage:true});
    assert.equal(await page.locator('[data-release-action="consult"]').count(),0);
    assert.equal(await page.locator('[data-release-action="current"]').count(),0);
    const beforeEdit=await page.evaluate(()=>window.work.controller.getState().prepared.signature);
    await page.locator('#kt-release-input').fill('入力途中の文章');
    assert.equal(await page.evaluate(()=>window.work.controller.getState().prepared.signature),beforeEdit);
    assert.equal(await action('apply').isDisabled(),true);
    await page.locator('#kt-release-input').fill('');
    assert.equal(await action('apply').isEnabled(),true);
    await page.locator('#kt-release-input').fill('入力途中の文章');
    await page.locator('#kt-release-input').evaluate(el=>el.setSelectionRange(2,6));
    const facts=page.locator('.ktr-chat-log details[data-release-panel^="facts-"]').first();
    await facts.locator(':scope > summary').click();
    const values=facts.locator('details[data-release-panel^="fact-value-"]').first();
    if(await values.count())await values.locator(':scope > summary').click();
    const factId=await facts.getAttribute('data-release-panel');
    const factText=await facts.innerText();
    for(const summary of await page.locator('.ktr-current details > summary').all())await summary.click();
    await page.locator('.ktr-current').evaluate(el=>{el.scrollTop=Math.min(90,el.scrollHeight-el.clientHeight);});
    const currentScroll=await page.locator('.ktr-current').evaluate(el=>el.scrollTop);
    assert.ok(currentScroll>0,'the expanded change details must exercise the current-work scroller');
    await page.locator('.ktr-chat-log').evaluate(el=>{el.scrollTop=Math.min(72,el.scrollHeight-el.clientHeight);});
    const chatScroll=await page.locator('.ktr-chat-log').evaluate(el=>el.scrollTop);
    assert.ok(chatScroll>0,'the long fixed response must exercise the chat scroller: '+JSON.stringify(await page.locator('.ktr-chat-log').evaluate(el=>({height:el.clientHeight,scrollHeight:el.scrollHeight,text:el.textContent.length,overflow:getComputedStyle(el).overflow,workspace:document.querySelector('.ktr-workspace').getBoundingClientRect().height}))));
    await page.locator('#kt-release-input').focus();
    await page.locator('#kt-release-input').evaluate(el=>el.setSelectionRange(2,6));
    await page.evaluate(()=>window.work.view.render());
    assert.equal(await page.locator('#kt-release-input').inputValue(),'入力途中の文章');
    assert.deepEqual(await page.locator('#kt-release-input').evaluate(el=>[el.selectionStart,el.selectionEnd]),[2,6]);
    assert.ok(Math.abs(await page.locator('.ktr-chat-log').evaluate(el=>el.scrollTop)-chatScroll)<2,'rerender retains the reading position');
    assert.ok(Math.abs(await page.locator('.ktr-current').evaluate(el=>el.scrollTop)-currentScroll)<2,'rerender retains the change-details position');
    assert.equal(await page.locator('[data-release-panel="'+factId+'"]').evaluate(el=>el.open),true);
    assert.equal(await page.locator('[data-release-panel="'+factId+'"]').innerText(),factText);
    assert.equal(await page.locator('[data-release-panel="'+factId+'"]').count(),1,'facts belong only to their response');
    // Revision goes through the persistent input. Waiting on a response must not leave the old plan actionable.
    heldProposal=fixture.deferred();
    await action('send').click();await phase('consulting');
    assert.equal(await page.evaluate(()=>window.work.controller.getState().prepared),null);
    assert.equal(await page.locator('[data-release-action="apply"]').count(),0);
    assert.equal(await page.locator('[data-release-action="adopt"]').count(),0);
    assert.equal(await page.locator('#kt-release-input').isDisabled(),true);
    assert.match(await page.locator('.ktr-chat-log').innerText(),/入力途中の文章/);
    assert.ok(Math.abs(await page.locator('.ktr-chat-log').evaluate(el=>el.scrollTop)-chatScroll)<2,'a new user message does not move a reader away from older messages');
    heldProposal.resolve(fixture.proposal('修正を受け取った仮案です。'));await phase('proposal');heldProposal=null;
    assert.equal(serviceCalls.filter(c=>c.name==='plan').length,1,'revision alone does not adopt');
    assert.equal(await page.locator('[data-release-panel="'+factId+'"]').count(),1);
    assert.equal(await page.locator('[data-release-panel="'+factId+'"]').innerText(),factText,'old response facts remain attached to the old message');
    assert.ok(Math.abs(await page.locator('.ktr-chat-log').evaluate(el=>el.scrollTop)-chatScroll)<2,'a new response does not move a reader away from older messages');
    await action('adopt').click();await phase('review');
    assert.equal(await page.locator('#kt-release-input').count(),1);
    assert.equal(mock.calls.filter(c=>!c.startsWith('GET')).length,0);
    await action('apply').click(); await phase('result');
    const run=await page.evaluate(()=>window.work.controller.getState().runs.at(-1));
    assert.equal(run.status,'complete',JSON.stringify(run.result));
    assert.equal(mock.st.customize.desktop.js.length,1);
    assert.equal(mock.st.customize.mobile.js.length,1);
    assert.equal(mock.st.customize.scope,'NONE','registering files does not enable customization');
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
    assert.equal(mock.st.customize.scope,'NONE','restoring files preserves the original customization scope');
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
    // An older Gateway must be rejected before any paid proposal or plan request.
    health.registry.toolkit['change-planner'].requirementOps = health.registry.toolkit['change-planner'].requirementOps.filter(x=>x!=='formLayoutPlacement');
    const paidBeforeOldGateway=serviceCalls.filter(c=>c.name!=='getHealth').length;
    await page.evaluate(async()=>{window.work.controller.newTask();await window.work.refreshCapability(true);});
    assert.equal(await page.locator('#kt-release-input').isDisabled(),true);
    assert.equal(await action('send').isDisabled(),true);
    await page.evaluate(()=>window.work.controller.send('金額の右に請求番号を追加してください。'));
    assert.equal(await page.evaluate(()=>window.work.controller.getState().error.code),'CAPABILITY_OUTDATED');
    assert.equal(serviceCalls.filter(c=>c.name!=='getHealth').length,paidBeforeOldGateway);
    assert.equal(await page.locator('[data-release-action="apply"]').count(),0);
    await page.evaluate(()=>window.work.dispose());
  } finally { await browser.close(); }
});
