'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { KTReleaseView } = require('../src/release-view.js');
const { KTReleaseContext } = require('../src/release-context.js');
test('フィールドの構造情報をそのまま渡し、コピー先や文章から動作を推測しない',()=>{
 const raw={lookup:{code:'customer',type:'SINGLE_LINE_TEXT',lookup:{fieldMappings:[{field:'memo',relatedField:'name'}]}},auto:{code:'auto',type:'SINGLE_LINE_TEXT',expression:'"test"'},memo:{code:'memo',type:'SINGLE_LINE_TEXT'}};
 const fields=KTReleaseContext.fieldsOf(raw);
 assert.equal(fields[0].lookup,true);assert.deepEqual(fields[0].lookupMappings,raw.lookup.lookup.fieldMappings);
 assert.equal(fields[1].expression,'"test"');assert.equal(fields[2].readOnly,undefined);
});
test('処理中の動きは実際の状態だけに従い、過去の記録には混ぜない',()=>{
 const base={messages:[{role:'user',text:'備考を編集不可にしてください'}],proposal:{behaviors:[{text:'PCで備考を編集不可にする'}]},runs:[{id:'old',status:'failed',result:{status:'failed'}}]};
 for(const phase of ['consulting','building','preparing','applying','rolling-back']){
  const html=KTReleaseView.render({...base,phase}).replace(/<style>[\s\S]*?<\/style>/,'');
  assert.match(html,/data-release-stage="working"/);assert.match(html,/class="ktr-activity"/);
  assert.equal(html.includes('class="ktr-chat-pending"'),phase==='consulting');
  assert.doesNotMatch(html,/\d+%|残り\d+/);
 }
 for(const phase of ['idle','proposal','review','incomplete','blocked','result','unchanged','rollback-confirm']){
  const html=KTReleaseView.render({...base,phase}).replace(/<style>[\s\S]*?<\/style>/,'');
  assert.doesNotMatch(html,/class="ktr-activity"/);
 }
 const historic=KTReleaseView.render({...base,phase:'consulting'},{selectedRunId:'old'}).replace(/<style>[\s\S]*?<\/style>/,'');
 assert.doesNotMatch(historic,/class="ktr-activity"|✓/);assert.match(historic,/反映できませんでした/);
});
test('実ブラウザーで段階の違い・動き・停止・狭い画面を確認する',async()=>{
 let pw;try{pw=require('playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
 const browser=await pw.chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 const out=path.join(__dirname,'.build/release-stages');fs.mkdirSync(out,{recursive:true});
 const errors=[],network=[];
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'no-preference'});
  page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{network.push(r.request().url());return r.abort();});
  await page.setContent('<!doctype html><html lang="ja"><meta charset="utf-8"><title>表示の確認</title><body style="margin:0"><div id="host" style="height:100vh"></div></body></html>');
  await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../src/release-view.js'),'utf8')+'\nwindow.View=KTReleaseView;'});
  const base={phase:'consulting',messages:[{role:'user',text:'承認済みの備考を編集できなくしたいです。'},{role:'assistant',text:'PCの備考を対象にする案です。'},{role:'user',text:'モバイルにも適用してください。'}],proposal:{behaviors:[{text:'承認済みでは備考を編集不可にし、作成中では編集できます（PC）。'},{text:'同じ編集制御をモバイルにも適用します。'}]},prepared:{ok:true,changes:[{kind:'javascript',title:'承認済みの備考を編集不可にします（PC）。',target:'desktop',file:'dealLock.js',operation:'REPLACE_FILE'},{kind:'javascript',title:'同じ編集制御をモバイルにも適用します。',target:'mobile',file:'mobile-lock.js',operation:'REPLACE_FILE'}],confirmations:['既存の編集制御を保ったまま、備考の制御を追加します。']},runs:[{id:'r1',status:'complete',result:{status:'complete'},prepared:{changes:[{title:'PC・モバイルの備考の編集制御'}]}}]};
  await page.evaluate(state=>{window.state=state;window.listener=null;window.v=View.create(document.querySelector('#host'),{appName:'案件管理',controller:{getState:()=>window.state,subscribe:f=>(window.listener=f,()=>{})}});window.setPhase=p=>{state.phase=p;window.listener(state);};},base);
  assert.equal(await page.locator('.ktr-chat-pending').count(),1);
  await page.waitForFunction(()=>typeof document.querySelector('.ktr-progress .ktr-activity i')?.getAnimations()[0]?.currentTime==='number');
  const animation=await page.locator('.ktr-progress .ktr-activity i').first().evaluate(el=>el.getAnimations()[0].currentTime);
  await page.waitForFunction(start=>document.querySelector('.ktr-progress .ktr-activity i').getAnimations()[0].currentTime>start,animation,{timeout:5000});
  await page.screenshot({path:path.join(out,'01-working.png')});
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.ktr-activity i').first().evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  const backgrounds=[];
  for(const [phase,stage] of [['proposal','proposal'],['review','review'],['result','result']]){
   await page.evaluate(p=>window.setPhase(p),phase);
   assert.equal(await page.locator('.ktr-current').getAttribute('data-release-stage'),stage);
   assert.equal(await page.locator('.ktr-activity').count(),0);
   backgrounds.push(await page.locator('.ktr-stage-header').evaluate(el=>getComputedStyle(el).backgroundColor));
   await page.screenshot({path:path.join(out,phase+'.png')});
  }
  assert.equal(new Set(backgrounds).size,3);
  await page.evaluate(()=>window.setPhase('review'));await page.locator('#kt-release-input').fill('モバイルも確認します');
  await page.evaluate(()=>window.v.render());assert.equal(await page.locator('#kt-release-input').inputValue(),'モバイルも確認します');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(out,'narrow.png'),fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
 }finally{await browser.close();}
});
