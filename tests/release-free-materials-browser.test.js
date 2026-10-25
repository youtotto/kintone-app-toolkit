'use strict';
// All requests are intercepted; no paid AI or real kintone is used.
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {loadToolkit}=require('./helpers/load-toolkit.js');
const {inputsOf}=require('./helpers/free-materials-fixture.js');
const {devBaseLoaderOf}=require('./helpers/dev-base-fake.js');
const {makeKintoneMock}=require('./helpers/kintone-preview-mock.js');
const F=require('./helpers/release-workspace-fixture.js');
const root=path.resolve(__dirname,'..');

test('無料の資料画面は全種類・形式・対象・コピー・保存・解析の注意を保つ', {timeout:90000}, async()=>{
  let pw;
  try {pw=require(process.env.PLAYWRIGHT_MODULE || 'playwright');}
  catch (_) {pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
  const T=loadToolkit(), inputs=inputsOf(T,{cachedOnly:true}), freshInputs=inputsOf(T), unscannedInputs=inputsOf(T,{withScan:false});
  const {describeRegistry}=await import(pathToFileURL(path.join(root,'../AI/worker/src/v2/prompt-registry.mjs')).href);
  const health={ok:true,supportedContractVersions:['2.1'],registry:describeRegistry(),entitlements:[{product:'toolkit',features:['assistant-qa','change-planner','customization-generator']}]};
  const prod={appId:'310',appName:'案件管理',fields:{memo:{type:'MULTI_LINE_TEXT',code:'memo',label:'備考'},ステータス:{type:'STATUS',code:'ステータス',label:'ステータス',enabled:true}},layout:[],views:{views:{},revision:'1'},status:{enable:true,states:{作成中:{name:'作成中',index:'0',assignee:{type:'ONE',entities:[]}},承認待ち:{name:'承認待ち',index:'1',assignee:{type:'ONE',entities:[]}},承認済み:{name:'承認済み',index:'2',assignee:{type:'ONE',entities:[]}}},actions:[]},customize:{scope:'ALL',desktop:{js:[],css:[]},mobile:{js:[],css:[]}}};
  const mock=makeKintoneMock(prod), loadBase=devBaseLoaderOf({KTDevBase:{load:T.KTDevBase.loadForRelease}},{appId:'310',production:prod,mockRef:()=>mock});
  const calls=[],unexpected=[],errors=[];
  const initialRequest='経理確認と承認済みの備考をPCとモバイルで編集できなくしてください。';
  const correction='経理確認では備考を編集可能にしてください。承認済みの編集不可は維持します。作業者は現在の部長承認待ちと同じ指定を使います。';
  const adoptedBehavior='経理確認では備考を編集可能にし、承認済みではPCとモバイルの備考を編集不可にする。';
  const question={id:'Q4',key:'memo-lock',label:'備考を編集不可にする状態',question:'備考を編集不可にするステータスはどれですか。',blocking:true};
  const answer='経理確認中と承認済みの両方で、備考を編集不可にします。';
  const initial=F.proposal();initial.proposal.behaviors=[{id:'B2',text:initialRequest,origin:'user'}];initial.proposal.decisions=[question];
  const answered=F.proposal('回答を受け取りました。');answered.proposal.behaviors=[{id:'B2',text:initialRequest,origin:'user'}];
  answered.turn.answers=[{id:'Q4',text:answer,kind:'user'}];
  const adopted=F.proposal('修正した案を確認してください。');
  adopted.proposal.behaviors=[{id:'B2',text:adoptedBehavior,origin:'user'}];
  adopted.proposal.assumptions=['既存の作業者の指定を引き継ぐ。'];adopted.proposal.cannot=['運用環境への反映は利用者が行う。'];
  const revisedPlan=F.plan();revisedPlan.goal=initialRequest;
  for(const c of revisedPlan.customizations)c.requirement=adoptedBehavior;
  let proposalCount=0,planCount=0;
  const browser=await pw.chromium.launch({channel:process.env.BROWSER_CHANNEL || 'msedge',headless:true});
  try {
    const context=await browser.newContext();
    await context.route('**/*',route=>{
      if(route.request().url()==='https://free.test.invalid/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><body><div id="app"></div></body></html>'});
      unexpected.push(route.request().url());return route.abort();
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.exposeFunction('base',loadBase);
    await page.exposeFunction('api',async(name,args)=>mock.api[name](...args));
    await page.exposeFunction('service',async(name,ctx)=>{
      calls.push(name);if(name==='getHealth')return health;
      if(name==='propose')return [initial,answered,adopted][proposalCount++] || F.proposal();
      if(name==='plan')return planCount++===0?revisedPlan:F.plan();
      return F.generated(ctx.customization);
    });
    await page.goto('https://free.test.invalid/');
    let source=fs.readFileSync(process.env.KT_SRC || path.join(root,'kintoneAppToolkit.user.js'),'utf8').replace('waitReady().then(() => startToolkit());','');
    const end=source.lastIndexOf('})();');source=source.slice(0,end)+'\nglobalThis.FreeTest={mountReleaseWorkspace,KTAiClient};\n'+source.slice(end);
    await page.addScriptTag({content:source});
    await page.evaluate(({inputs,freshInputs,unscannedInputs,names})=>{
      window.materialInputs=inputs;window.unscannedInputs=unscannedInputs;window.scanCount=0;window.saved=[];window.copies=[];
      const client=Object.fromEntries(['getHealth','propose','plan','generate'].map(name=>[name,async input=>window.service(name,input?.ctx)]));
      const settings=FreeTest.KTAiClient.createSettingsStore();
      window.work=FreeTest.mountReleaseWorkspace(document.querySelector('#app'),{
        appId:'310',settings,session:{client,status:()=>({connected:true,apiBase:'https://gateway.test.invalid'})},
        loadDevBase:window.base,executor:{api:Object.fromEntries(names.map(name=>[name,(...args)=>window.api(name,args)]))},
        getInputs:()=>window.materialInputs,
        copyText:async text=>window.copies.push(text),downloadText:(name,text)=>window.saved.push({name,text}),
        runScan:async()=>{window.scanCount++;window.materialInputs=freshInputs;}
      });
      window.work.onVisible();
    },{inputs,freshInputs,unscannedInputs,names:Object.keys(mock.api)});
    const action=name=>page.locator('[data-release-action="'+name+'"]').first();
    const field=name=>page.locator('dialog [data-'+name+']');
    const openOfflineMaterials=async()=>{
      await action('documents').click();
      await page.locator('dialog details[data-offline-materials] > summary').click();
      await page.locator('dialog button[data-offline-export]').click();
    };
    const phase=value=>page.waitForFunction(v=>work.controller.getState().phase===v,value);
    await openOfflineMaterials();
    assert.equal(await field('copy').isDisabled(),true);
    const options=await field('focus').locator('option').evaluateAll(nodes=>nodes.map(n=>({value:n.value,label:n.textContent})));
    const pc=options.find(x=>x.label==='PC: common.js'),mobile=options.find(x=>x.label==='モバイル: common.js');
    assert.ok(pc&&mobile&&pc.value!==mobile.value);
    for(const selected of [pc,mobile]){
      await field('focus').selectOption(selected.value);await field('make').click();
      await field('format').selectOption('json');
      const doc=JSON.parse(await field('output').inputValue());
      assert.equal(doc.focus.target.id,selected===pc?'desktop:js:common.js':'mobile:js:common.js');
      assert.match(await field('note').innerText(),/キャッシュに含まれない/);
    }
    await field('focus').selectOption('');await field('question').fill('common.js を説明してください');await field('make').click();
    assert.match(await field('note').innerText(),/候補から選択/);
    assert.equal(await field('output').inputValue(),'');assert.equal(await field('copy').isDisabled(),true);
    await field('focus').selectOption(pc.value);await field('make').click();
    for(const format of ['prompt','markdown','json']){
      await field('format').selectOption(format);const output=await field('output').inputValue();
      assert.ok(output.length>50);assert.doesNotMatch(output,/sk_live_0123456789abcdef0123|abcdefgh12345678ZZZZ/);await field('copy').click();await field('save').click();
      assert.equal(await page.evaluate(()=>copies.at(-1)),output);assert.equal(await page.evaluate(()=>saved.at(-1).text),output);
    }
    assert.equal(calls.filter(n=>n!=='getHealth').length,0);
    await field('close').click();
    // Revise through the public conversation controls, keeping the planner's old goal to reproduce the original defect.
    await page.locator('#kt-release-input').fill(initialRequest);await action('send').click();await page.locator('[data-consent]').click();await phase('proposal');
    await page.locator('#kt-release-input').fill(answer);await action('send').click();await phase('proposal');
    const answeredState=await page.evaluate(()=>work.controller.getState());
    assert.equal(answeredState.answers[0].answer,answer);assert.deepEqual(answeredState.proposal.decisions,[],'the answered question is removed from the next proposal');
    await page.locator('#kt-release-input').fill(correction);await action('send').click();await phase('proposal');
    const beforeAdoption=calls.filter(n=>n!=='getHealth').length;
    await openOfflineMaterials();await field('kind').selectOption('changes');await field('make').click();
    assert.match(await field('note').innerText(),/まとめる変更計画がありません/);assert.equal(await field('save').isDisabled(),true);
    await field('kind').selectOption('spec');await field('make').click();await field('format').selectOption('json');
    const unadopted=JSON.parse(await field('output').inputValue());assert.equal(Object.hasOwn(unadopted,'acceptedProposal'),false);
    assert.ok(!(await field('output').inputValue()).includes(adoptedBehavior),'unadopted proposal text is not saved as accepted');
    await field('close').click();assert.equal(calls.filter(n=>n!=='getHealth').length,beforeAdoption);
    await action('adopt').click();await phase('review');
    const paidBefore=calls.filter(n=>n!=='getHealth').length;
    const stateBefore=await page.evaluate(()=>JSON.stringify(work.controller.getState())),acceptedState=JSON.parse(stateBefore);
    assert.equal(acceptedState.goal,initialRequest);assert.equal(acceptedState.plan.goal,initialRequest);
    assert.equal(acceptedState.answers[0].answer,answer,'the earlier answer remains in the conversation history');
    assert.deepEqual(acceptedState.adopted.decisions,[]);
    assert.equal(acceptedState.adopted.behaviors[0].text,adoptedBehavior,'adoption uses the later correction');
    await openOfflineMaterials();
    for(const kind of ['context','planner',...T.KTContextUi.DOCUMENT_KINDS.map(k=>k.id)]){
      await field('kind').selectOption(kind);await field('question').fill('備考を一覧に表示する');await field('make').click();
      assert.match(await field('note').innerText(),/資料を作成しました/,kind);
      for(const format of ['markdown','prompt','json']){
        await field('format').selectOption(format);const output=await field('output').inputValue();assert.ok(output.length>50,kind+'/'+format);
        if(format==='json')JSON.parse(output);
        if(T.KTContextUi.DOCUMENT_KINDS.some(k=>k.id===kind)){
          if(format==='json'){
            const saved=JSON.parse(output);
            assert.deepEqual(saved.acceptedProposal,{revision:acceptedState.version,proposal:acceptedState.adopted},kind);
            assert.deepEqual(saved.answerHistory,acceptedState.answers);assert.deepEqual(saved.requestHistory,[initialRequest,answer,correction]);
            assert.equal(Object.hasOwn(saved,'decisions'),false,'an earlier answer is not a current decision');
            assert.ok(!JSON.stringify(saved.acceptedProposal).includes(answer));
            assert.equal(Object.hasOwn(saved.plan,'goal'),false);
            assert.equal(saved.plan.customizations[0].requirement,adoptedBehavior);
          }else{
            for(const text of ['採用した内容',adoptedBehavior,...adopted.proposal.assumptions,...adopted.proposal.cannot,question.question,answer,'依頼と修正の履歴（採用内容ではありません）',initialRequest,correction]) assert.ok(output.includes(text),kind+'/'+format+' contains adopted contents and labelled history');
            assert.ok(!output.includes('**実現したいこと**: '+initialRequest));
            const historyStart=output.indexOf('## 依頼と修正の履歴（採用内容ではありません）');
            assert.ok(historyStart>0);assert.ok(output.indexOf('### 確認事項への回答履歴')>historyStart);
            assert.ok(!output.slice(0,historyStart).includes(answer),'the superseded answer only appears in history');
            assert.ok(!output.slice(0,historyStart).includes(question.question),'the old question is not a current adoption decision');
            assert.ok(!output.includes('## 回答した確認事項'));
            if(format==='prompt')assert.ok(output.includes('現在の合意内容は「採用した内容」とその前提・制約です。'));
          }
          await field('copy').click();await field('save').click();
          assert.equal(await page.evaluate(()=>copies.at(-1)),output);
          assert.equal(await page.evaluate(()=>saved.at(-1).text),output);
        }
      }
    }
    assert.equal(calls.filter(n=>n!=='getHealth').length,paidBefore);
    assert.equal(mock.calls.filter(c=>!c.startsWith('GET')).length,0);
    assert.equal(await page.evaluate(()=>JSON.stringify(work.controller.getState())),stateBefore,'creating and saving documents does not change the adopted plan');
    await field('close').click();
    await action('apply').click();await phase('result');
    await openOfflineMaterials();await field('kind').selectOption('changes');await field('make').click();await field('format').selectOption('json');
    assert.equal(JSON.parse(await field('output').inputValue()).planStatus,'EXECUTED');await field('close').click();
    await action('request-rollback').click();await phase('rollback-confirm');await action('rollback').click();await phase('result');
    await openOfflineMaterials();await field('kind').selectOption('changes');await field('make').click();await field('format').selectOption('json');
    const restored=JSON.parse(await field('output').inputValue());assert.equal(restored.planStatus,'ROLLED_BACK');assert.equal(restored.production.deployed,false);await field('close').click();
    await action('new-task').click();
    const nextTaskPaidBefore=calls.filter(n=>n!=='getHealth').length;
    await openOfflineMaterials();await field('kind').selectOption('changes');await field('make').click();
    assert.match(await field('note').innerText(),/まとめる変更計画がありません/);
    await field('kind').selectOption('spec');await field('make').click();await field('format').selectOption('json');
    const emptyTask=JSON.parse(await field('output').inputValue());assert.equal(Object.hasOwn(emptyTask,'acceptedProposal'),false);
    assert.ok(!(await field('output').inputValue()).includes(adoptedBehavior));await field('close').click();
    assert.equal(calls.filter(n=>n!=='getHealth').length,nextTaskPaidBefore);
    await page.locator('#kt-release-input').fill(F.REQUEST);await action('send').click();await phase('proposal');await action('adopt').click();await phase('review');
    await openOfflineMaterials();await field('kind').selectOption('changes');await field('make').click();await field('format').selectOption('json');
    const next=JSON.parse(await field('output').inputValue());assert.equal(next.planStatus,'ACTIVE');assert.equal(next.execution,null);assert.equal(next.jsExecution,null);
    assert.deepEqual(next.acceptedProposal.proposal,F.proposal().proposal);assert.deepEqual(next.requestHistory,[F.REQUEST]);assert.deepEqual(next.answerHistory,[]);
    assert.ok(!(await field('output').inputValue()).includes(adoptedBehavior));await field('close').click();
    await page.evaluate(()=>window.materialInputs=window.unscannedInputs);
    await openOfflineMaterials();await field('make').click();
    assert.match(await field('note').innerText(),/JavaScript は未解析/);
    await field('scan').click();await page.waitForFunction(()=>window.scanCount===1);
    assert.equal(await field('output').inputValue(),'');assert.equal(await field('copy').isDisabled(),true);
    await field('make').click();assert.doesNotMatch(await field('note').innerText(),/JavaScript は未解析/);
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
    await page.evaluate(()=>window.work.dispose());
  } finally {await browser.close();}
});
