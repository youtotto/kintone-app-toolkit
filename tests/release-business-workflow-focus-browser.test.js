'use strict';
// Synthetic fixtures and local service functions only. All browser URLs are intercepted.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const F=require('./helpers/business-fixture.js');
const root=path.resolve(__dirname,'..');

async function workflowFixture(){
 const {s}=await F.snapshot(),answer=F.workflowAnswer(s),o=answer.businessUnderstanding;
 const second=structuredClone(o.rules[0]),state=s.evidence.filter(e=>e.kind==='process_state')[1];
 second.ruleId='R2';second.stageName='確認後の内容を整理する';second.processStateId=state.evidenceId;
 second.evidenceRefs.push({evidenceId:state.evidenceId,pointer:null});
 o.rules[1]=second;o.unassignedEvidence=o.unassignedEvidence.filter(e=>e.evidenceId!==state.evidenceId);
 return {s,answer:{...answer,proposalUnchanged:true}};
}

test('工程相談で概要・詳細を先に示し、確認を必要時だけ開いて回答・下書き・参照を保持する',{timeout:90000},async()=>{
 let pw;try{pw=require('playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
 const browser=await pw.chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 const unexpected=[],errors=[],calls=[];
 try{
  const context=await browser.newContext({viewport:{width:1360,height:1000}});
  await context.route('**/*',route=>route.request().url()==='https://workflow-focus.test.invalid/'
   ?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><body style="margin:0"><div id="app" style="height:100vh"></div></body></html>'})
   :(unexpected.push(route.request().url()),route.abort()));
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const fixture=await workflowFixture();
  await page.exposeFunction('fixedWorkflow',async input=>{calls.push(input);assert.ok(input.businessSnapshot,'This test must not send a consultation');return fixture.answer;});
  await page.goto('https://workflow-focus.test.invalid/');
  let source=fs.readFileSync(path.join(root,'kintoneAppToolkit.user.js'),'utf8').replace('waitReady().then(() => startToolkit());','');
  const end=source.lastIndexOf('})();');source=source.slice(0,end)+'\nglobalThis.WorkflowFocusUI={KTReleaseWorkspace,KTReleaseView,KTBusinessConsultation};\n'+source.slice(end);await page.addScriptTag({content:source});
  await page.evaluate(async snapshot=>{
   window.cap={connected:true,available:true,canConsult:true,canConsultBusiness:true};
   window.c=WorkflowFocusUI.KTReleaseWorkspace.create({scope:{domain:location.hostname,appId:'310'},services:{propose:window.fixedWorkflow},loadBase:()=>{throw Error('Unexpected settings read');},execution:{}});
   window.v=WorkflowFocusUI.KTReleaseView.create(document.querySelector('#app'),{controller:c,connection:()=>cap});
   if(!await c.send('合成工程資料',{requestPurpose:'document',businessSnapshot:snapshot,businessWorkflow:true}))throw Error(JSON.stringify(c.getState().error));
   window.docId=c.getState().explanations.at(-1).id;
   if(!await c.startBusiness(docId))throw Error('Cannot open all-workflow consultation');
  },fixture.s);
  assert.equal(calls.length,1);
  const consultation=page.locator('.ktr-business-consultation'),workflow=consultation.locator('.ktr-business-workflow-source');
  const overview=workflow.locator('.ktr-workflow-overview'),optional=consultation.locator('.ktr-business-questions');
  assert.equal(await overview.isVisible(),true);assert.equal(await workflow.locator('[data-workflow-rule]').count(),2);
  assert.equal(await optional.getAttribute('open'),null);assert.match(await optional.locator(':scope>summary').innerText(),/2件.*任意/);
  assert.equal(await consultation.locator('textarea[data-business-input="new"]').isVisible(),true);
  assert.equal(await workflow.evaluate(el=>!!(el.compareDocumentPosition(document.querySelector('.ktr-business-questions'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
  assert.doesNotMatch(await page.locator('.ktr-current').innerText(),/相談すると、ここに案を表示します/);
  assert.equal(await page.locator('.ktr-business-unverified').isVisible(),true);
  assert.equal(await page.locator('.ktr-business-unverified').evaluate(el=>el.closest('details')),null);

  async function assertIdsAndTargets(){
   const result=await page.evaluate(()=>{
    const ids=[...document.querySelectorAll('#app [id]')].map(el=>el.id);
    const links=[...document.querySelectorAll('.ktr-business-workflow-source a[href^="#"]')];
    return {duplicates:ids.filter((id,i)=>ids.indexOf(id)!==i),missing:links.map(a=>a.getAttribute('href').slice(1)).filter(id=>!document.getElementById(id))};
   });assert.deepEqual(result,{duplicates:[],missing:[]});
  }
  async function roundTrip(ruleId,keyboard){
   const link=overview.locator('a[data-workflow-overview-select][href$="-stage-'+ruleId+'"]');
   const before=await page.evaluate(()=>({session:JSON.stringify(c.exportSession()),wire:JSON.stringify(WorkflowFocusUI.KTBusinessConsultation.wire(c.getState().businessContext))}));
   if(keyboard){await link.focus();await page.keyboard.press('Enter');}else await link.click();
   const key=await link.getAttribute('data-workflow-overview-select');
   assert.equal(await overview.locator('[data-workflow-overview-node="'+key+'"]').getAttribute('data-workflow-focus'),'selected');
   assert.equal(await link.getAttribute('aria-pressed'),'true');
   assert.equal(await overview.locator('[data-workflow-overview-picker]').inputValue(),key);
   assert.equal(new URL(page.url()).hash,'');
   assert.deepEqual(await page.evaluate(()=>({session:JSON.stringify(c.exportSession()),wire:JSON.stringify(WorkflowFocusUI.KTBusinessConsultation.wire(c.getState().businessContext))})),before,'overview selection must not change business selection, saved data or AI context');
   const stage=workflow.locator('[data-workflow-rule="'+ruleId+'"]');
   assert.equal(await stage.evaluate(el=>el===document.activeElement),false,'node selection does not jump to details');
   await overview.locator('.ktr-workflow-overview-detail').click();
   assert.match(await stage.getAttribute('class'),/ktr-workflow-selected/);
   assert.equal(await stage.evaluate(el=>el===document.activeElement),true);
   assert.equal(new URL(page.url()).hash,'');
   await stage.locator('.ktr-workflow-back').click();
   assert.match(await overview.getAttribute('class'),/ktr-workflow-selected/);
   assert.equal(await overview.evaluate(el=>el===document.activeElement),true);
   assert.equal(new URL(page.url()).hash,'');
   assert.equal(await overview.locator('[data-workflow-overview-picker]').inputValue(),key,'returning from details preserves the selected overview node');
  }
  await assertIdsAndTargets();await roundTrip('R1',true);await roundTrip('R2',false);
  await page.evaluate(async()=>{if(!await c.startBusiness(docId,'R1'))throw Error('Cannot select R1');});
  assert.match(await consultation.locator('.ktr-business-consultation-scope').innerText(),/R1/);
  assert.match(await workflow.innerText(),/元の工程全体/);
  assert.equal(await workflow.locator('[data-workflow-rule]').count(),2,'the original diagram stays complete for reference');
  assert.deepEqual(await page.evaluate(()=>WorkflowFocusUI.KTBusinessConsultation.wire(c.getState().businessContext).analysis.rules.map(r=>r.ruleId)),['R1']);
  assert.match(await optional.locator(':scope>summary').innerText(),/1件.*任意/);
  await assertIdsAndTargets();await roundTrip('R1',false);

  const question=optional.locator('.ktr-business-question').first(),draft=question.locator('textarea[data-business-input="source:R1:0"]');
  assert.equal(await question.getAttribute('open'),null);assert.equal(await draft.isVisible(),false);
  await optional.locator(':scope>summary').click();await question.locator(':scope>summary').click();
  await draft.fill('経理が確認してメモを補完します');await draft.evaluate(el=>{el.focus();el.setSelectionRange(3,8);});
  await page.evaluate(()=>v.render());
  assert.equal(await optional.evaluate(el=>el.open),true);assert.equal(await question.evaluate(el=>el.open),true);
  assert.deepEqual(await draft.evaluate(el=>({value:el.value,focus:el===document.activeElement,start:el.selectionStart,end:el.selectionEnd})),{value:'経理が確認してメモを補完します',focus:true,start:3,end:8});
  assert.equal(calls.length,1);
  await question.locator('[data-release-action="business-record"][data-business-kind="current_operation"]').click();
  assert.equal(calls.length,1,'recording an answer must not invoke AI');
  assert.deepEqual(await page.evaluate(()=>{const s=c.getState().businessContext.statements[0];return {text:s.text,source:s.sourceQuestionRef.questionId};}),{text:'経理が確認してメモを補完します',source:'source:R1:0'});
  await draft.fill('次回確認するための未保存下書き');
  await consultation.locator('textarea[data-business-input="new"]').fill('自由入力の未保存下書き');
  await page.evaluate(()=>{window.savedWorkflowSession=c.exportSession();});
  await page.evaluate(async()=>{
   v.dispose();c=WorkflowFocusUI.KTReleaseWorkspace.create({scope:{domain:location.hostname,appId:'310'},services:{propose:()=>{throw Error('Unexpected AI call after restore');}},loadBase:({reason}={})=>{if(reason!=='history-open')throw Error('Unexpected settings read after restore');return {ok:true,stamp:'preview:22',appId:'310',env:'preview',files:[],current:{revision:'22',fields:{properties:{memo:{type:'SINGLE_LINE_TEXT',code:'memo',label:'確認メモ'}}}},inputs:{data:{appId:'310',name:'合成アプリ',fields:{}},deps:{},scan:{files:[]}}};},execution:{}});
   if(!await c.restoreSession(savedWorkflowSession))throw Error('Cannot restore workflow session');
   v=WorkflowFocusUI.KTReleaseView.create(document.querySelector('#app'),{controller:c,connection:()=>cap});
  });
  assert.equal(await optional.getAttribute('open'),null);assert.equal(await question.getAttribute('open'),null);
  assert.equal(await draft.inputValue(),'次回確認するための未保存下書き');
  assert.equal(await consultation.locator('textarea[data-business-input="new"]').inputValue(),'自由入力の未保存下書き');
  assert.equal(await page.evaluate(()=>c.getState().businessContext.statements[0].text),'経理が確認してメモを補完します');
  assert.equal(calls.length,1);await assertIdsAndTargets();await roundTrip('R1',true);
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>v.render());
  assert.ok(await overview.isVisible());assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await consultation.locator('textarea[data-business-input="new"]').isVisible(),true);
  await optional.locator(':scope>summary').click();await question.locator(':scope>summary').click();
  assert.equal(await draft.isVisible(),true);assert.equal(await draft.inputValue(),'次回確認するための未保存下書き');
  assert.equal(await workflow.locator('.ktr-workflow-card').evaluateAll(els=>els.some(el=>el.scrollWidth>el.clientWidth+1)),false);
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  const out=path.join(root,'tests/.build/business-workflow-focus');fs.mkdirSync(out,{recursive:true});
  await page.screenshot({path:path.join(out,'narrow.png'),fullPage:true});await page.setViewportSize({width:1360,height:1000});await page.screenshot({path:path.join(out,'wide.png'),fullPage:true});
  await page.evaluate(()=>v.dispose());
 }finally{await browser.close();}
});
