'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const saved=require('./fixtures/app427-unverified-replies.json');
const {fixture}=require('./helpers/release-workspace-fixture.js');
const {KTReleaseWorkspace:Workspace}=require('../src/release-workspace.js');
test('保存回答をローカル画面で開き、確認不能の表示なしで明示的な反映へ進む',{timeout:60000},async()=>{
  let pw;try{pw=require('playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
  const browser=await pw.chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true}),errors=[],network=[];
  const output=path.join(__dirname,'.build/release-unverified-review');fs.mkdirSync(output,{recursive:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.request().url()==='https://release.test.invalid/'?r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><body><div id="host" style="height:100vh"></div></body></html>'}):(network.push(r.request().url()),r.abort()));
    await page.goto('https://release.test.invalid/');
    for(const file of ['release-workflow-diagram.js','release-workflow-overview.js','release-workspace.js','release-view.js'])await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../src',file),'utf8')});
    const payload=fixture(Workspace).controller.exportSession();
    Object.assign(payload.state,{phase:'incomplete',plan:saved.plan,artifacts:saved.artifacts,version:1});
    payload.baseline={stamp:'fixed',appId:'427',environment:'preview',verificationFingerprint:null};
    await page.evaluate(async payload=>{
      window.calls={ai:0,apply:0};const noAI=async()=>{calls.ai++;throw Error('unexpected AI');};
      window.controller=KTReleaseWorkspace.create({loadBase:async()=>({ok:true,stamp:'fixed',appId:'427',env:'preview'}),
        services:{propose:noAI,plan:noAI,generate:noAI},execution:{
          // Actual execution service + prerequisites are covered by release-unverified-apply.test.js.
          prepare:async({artifacts})=>({ok:true,changes:artifacts.map((a,i)=>({kind:'javascript',file:a.result.generated.targetFile,title:a.result.generated.summary,target:'desktop',operation:i?'ADD_FILE':'REPLACE_FILE'})),confirmations:[],reasons:[]}),
          apply:async()=>{calls.apply++;return {status:'complete',written:true,rows:[]};}
        }});
      window.view=KTReleaseView.create(document.getElementById('host'),{controller});
      if(!await controller.restoreSession(payload))throw Error('restore failed');
    },payload);
    await page.locator('[data-release-action="reprepare"]').click();
    await page.waitForFunction(()=>controller.getState().phase==='review');
    assert.equal(await page.locator('[data-release-action="apply"]').isEnabled(),true);
    const text=await page.locator('.ktr-current').innerText();
    assert.doesNotMatch(text,/模擬テストの環境|条件の値が特定|自動確認できていない|一部未確認|検証は完了/);
    assert.match(text,/expense-reason.js/);assert.match(text,/travel-location-validation.js/);
    assert.equal(await page.locator('[data-release-panel="verification"]').count(),0);
    assert.deepEqual(await page.evaluate(()=>calls),{ai:0,apply:0});
    await page.screenshot({path:path.join(output,'review.png')});
    await page.locator('[data-release-panel="code"] > summary').click();
    assert.match(await page.locator('[data-release-panel="code"]').innerText(),/THRESHOLD_YEN = 30000/);
    await page.locator('[data-release-action="apply"]').click();
    await page.waitForFunction(()=>controller.getState().phase==='result');
    assert.deepEqual(await page.evaluate(()=>calls),{ai:0,apply:1});
    assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
  }finally{await browser.close();}
});
