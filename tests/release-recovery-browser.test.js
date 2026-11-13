'use strict';
// Real browser and production controller/view, fixed responses only. Block all external traffic.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('長い案・修正失敗・計画失敗・一部反映を画面で区別し、末尾の制約と次の操作に到達できる', {timeout:60000}, async()=>{
 let pw;try{pw=require('playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
 const browser=await pw.chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 const out=path.join(__dirname,'.build/release-recovery');fs.mkdirSync(out,{recursive:true});
 const errors=[],network=[];
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url()==='https://release.test.invalid/'?r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><body style="margin:0"><div id="host" style="height:100vh"></div></body></html>'}):(network.push(r.request().url()),r.abort()));
  await page.goto('https://release.test.invalid/');
  for(const file of ['release-workflow-diagram.js','release-workflow-overview.js','release-workspace.js','release-view.js'])await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../src',file),'utf8')});
  await page.evaluate(()=>{
   window.calls={plan:0,apply:0,propose:0};window.failConsult=false;
   const long='承認済みの場合は入力欄を編集できなくし、差し戻した後は編集できます。'.repeat(6);
   const proposal={behaviors:Array.from({length:12},(_,i)=>({id:'B'+(i+1),text:`変更${i+1}：${long}`,origin:'user'})),cannot:['末尾の制約：画面からの編集だけが対象です。'],assumptions:[],decisions:[]};
   const changes=proposal.behaviors.map((b,i)=>({id:'P'+i,title:b.text,kind:'settings',before:{label:'変更前'},after:{label:'変更後'}}));
   window.controller=KTReleaseWorkspace.create({loadBase:async()=>({ok:true,stamp:'fixed'}),services:{
    propose:async()=>{calls.propose++;if(failConsult)throw new Error('返答を受信できませんでした。');return {reply:'変更案を確認してください。',proposal};},
    plan:async()=>{calls.plan++;if(calls.plan===1)throw new Error('計画を受信できませんでした。'+ '接続先の応答を確認できません。'.repeat(70));return {plan:{steps:[],customizations:[]}};}
   },execution:{prepare:async()=>({ok:true,changes,confirmations:['末尾の確認：既存の配置を維持します。']}),apply:async()=>{calls.apply++;return {status:'partial',written:1,message:'一部の設定を反映しました。',rows:[{title:'一覧の追加',status:'VERIFIED'},{title:'フォームの配置',status:'PENDING'}],reasons:[{message:'別の作業でフォームが変わったため、配置の変更を止めました。'}]};}}});
   window.view=KTReleaseView.create(document.querySelector('#host'),{controller});
  });
  const send=async text=>{await page.locator('#kt-release-input').fill(text);await page.locator('[data-release-action="send"]').click();};
  const reachable=async locator=>{await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();assert.ok(box&&box.y>=0&&box.y+box.height<=901,'操作または説明までスクロールできる');};
  const noOverflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await send('一覧と編集制御を変更してください');
  await reachable(page.getByText('末尾の制約：画面からの編集だけが対象です。',{exact:true}));
  await page.locator('[data-release-action="adopt"]').click();
  await page.waitForFunction(()=>controller.getState().phase==='incomplete');
  assert.equal(await page.locator('[data-release-action="resume"]').count(),0);
  await reachable(page.locator('[data-release-action="adopt"]'));
  assert.equal(await page.locator('[data-release-action="adopt"]').innerText(),'もう一度作成');
  assert.ok(await page.locator('.ktr-layout').evaluate(el=>el.clientHeight)>300,'長い失敗理由でも相談と次の操作を表示する高さが残る');
  const notification=page.locator('[data-release-panel="header-notice"]');
  assert.equal(await notification.evaluate(el=>el.open),false,'長い理由は初期表示を広げない');
  assert.equal(await notification.locator('summary [role="alert"]').innerText(),'処理を完了できませんでした');
  const titleBox=await page.locator('.ktr-title-line strong').boundingBox(),noticeBox=await notification.boundingBox();
  assert.ok(noticeBox.x>=titleBox.x+titleBox.width&&Math.abs(noticeBox.y-titleBox.y)<25,'アプリの相談の右に短い通知を置く');
  assert.equal(await page.locator('.ktr-content > .ktr-error').count(),0,'全幅の失敗バナーは置かない');
  await page.screenshot({path:path.join(out,'plan-failed.png')});
  await page.setViewportSize({width:390,height:900});await noOverflow();
  assert.ok(await page.locator('.ktr-layout').evaluate(el=>el.clientHeight)>300,'狭い画面でも長い失敗理由が操作領域を押し出さない');
  await reachable(page.locator('[data-release-action="adopt"]'));
  await notification.locator('summary').click();
  assert.equal(await notification.locator('.ktr-header-notice-body .ktr-error').innerText(),await page.evaluate(()=>controller.getState().error.message));
  const body=notification.locator('.ktr-header-notice-body'),bodyBox=await body.boundingBox();
  assert.ok(bodyBox&&bodyBox.x>=0&&bodyBox.x+bodyBox.width<=391&&bodyBox.height<=320,'長い通知の全文は狭い画面内のスクロール領域に収まる');
  assert.ok(await body.evaluate(el=>el.scrollHeight>el.clientHeight),'長い理由を内部でスクロールできる');
  await noOverflow();
  await page.screenshot({path:path.join(out,'narrow-plan-failed.png')});
  await notification.locator('summary').press('Escape');
  assert.equal(await notification.evaluate(el=>el.open),false);
  assert.equal(await notification.locator('summary').evaluate(el=>el===document.activeElement),true);
  await page.setViewportSize({width:1440,height:900});
  await page.locator('#kt-release-input').fill('内容を修正します');
  assert.equal(await page.locator('[data-release-action="adopt"]').isDisabled(),true);
  await page.locator('#kt-release-input').fill('');await page.locator('[data-release-action="adopt"]').click();
  await page.waitForFunction(()=>controller.getState().phase==='review');
  assert.equal(await page.locator('.ktr-changes>li').count(),12);
  await reachable(page.getByText('末尾の確認：既存の配置を維持します。',{exact:true}));
  await reachable(page.locator('[data-release-action="apply"]'));await noOverflow();
  await page.screenshot({path:path.join(out,'long-review.png')});
  await page.evaluate(()=>{window.failConsult=true;});await send('一覧の追加は取り消してください');
  await page.waitForFunction(()=>controller.getState().phase==='proposal');
  assert.equal(await notification.locator('summary [role="alert"]').innerText(),'処理を完了できませんでした');
  await notification.locator('summary').click();
  assert.match(await notification.locator('.ktr-header-notice-body .ktr-error').innerText(),/案は更新していません/);
  await notification.locator('[data-release-action="close-notice"]').click();
  assert.equal(await page.locator('[data-release-action="apply"]').count(),0);
  await page.evaluate(()=>{window.failConsult=false;});await send('一覧の追加は取り消してください');
  await page.locator('[data-release-action="adopt"]').click();await page.waitForFunction(()=>controller.getState().phase==='review');
  await page.locator('[data-release-action="apply"]').click();await page.waitForFunction(()=>controller.getState().phase==='result');
  assert.match(await page.locator('.ktr-current').innerText(),/一部だけ反映/);
  assert.match(await page.locator('.ktr-current').innerText(),/別の作業でフォームが変わった/);
  assert.match(await page.locator('.ktr-current').innerText(),/一覧の追加：確認済み/);
  assert.match(await page.locator('.ktr-current').innerText(),/フォームの配置：未実施/);
  assert.equal(await page.locator('[data-release-action="apply"]').count(),0);
  assert.equal(await page.evaluate(()=>calls.apply),1);
  await page.screenshot({path:path.join(out,'partial.png')});
  await page.setViewportSize({width:390,height:900});await noOverflow();
  await reachable(page.getByText('別の作業でフォームが変わったため、配置の変更を止めました。',{exact:true}));
  await page.screenshot({path:path.join(out,'narrow-partial.png')});
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
 }finally{await browser.close();}
});

test('ヘッダー通知の開閉と再表示は相談・変更案・手元のコードを保持し、異なる通知の全文を混ぜない', {timeout:60000}, async()=>{
 let pw;try{pw=require('playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
 const browser=await pw.chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 const errors=[],network=[];
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url()==='https://release.test.invalid/'?r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><body style="margin:0"><div id="host" style="height:100vh"></div><textarea id="local-code" hidden>const edited = true;</textarea></body></html>'}):(network.push(r.request().url()),r.abort()));
  await page.goto('https://release.test.invalid/');
  for(const file of ['release-workflow-diagram.js','release-workflow-overview.js','release-workspace.js','release-view.js'])await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../src',file),'utf8')});
  await page.evaluate(()=>{
   window.calls={ai:0,write:0,connect:0};window.codeOpen=false;window.connection={connected:true,available:true,canPlan:true};
   window.state={phase:'proposal',version:1,taskId:1,messages:[{role:'user',text:'備考を編集できなくしてください。'}],runs:[],artifacts:[],
    error:{code:'BUDGET_EXCEEDED',message:'AIの利用上限に達したため、作成を止めました。案は更新していません。'+'確認用の長い説明です。'.repeat(100)},
    proposal:{behaviors:[{id:'B1',text:'承認済みの備考を編集できなくする。',origin:'user'}],cannot:['画面からの編集だけが対象です。'],assumptions:[],decisions:[]}};
   window.controller={getState:()=>JSON.parse(JSON.stringify(state)),subscribe:()=>()=>{},send:async()=>calls.ai++,adopt:async()=>calls.ai++,apply:async()=>calls.write++};
   window.view=KTReleaseView.create(document.querySelector('#host'),{controller,connection:()=>connection,codePanelState:()=>({available:true,open:codeOpen,id:'local-code'}),
    onToggleCode:()=>{codeOpen=!codeOpen;document.querySelector('#local-code').hidden=!codeOpen;view.render();return codeOpen;},onConnect:()=>{calls.connect++;}});
  });
  const notification=page.locator('[data-release-panel="header-notice"]'),summary=notification.locator('summary');
  const open=async()=>{if(!await notification.evaluate(el=>el.open))await summary.click();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve())));};
  const closed=async()=>assert.equal(await notification.evaluate(el=>el.open),false);
  await closed();assert.equal(await summary.locator('[role="alert"]').innerText(),'今回のAI利用枠を確保できません');
  await page.locator('#kt-release-input').fill('未送信の修正相談');
  const initial=await page.evaluate(()=>JSON.stringify(state)),proposalText=await page.locator('.ktr-current').innerText();
  await open();
  const body=notification.locator('.ktr-header-notice-body');
  assert.ok(await body.evaluate(el=>el.scrollHeight>el.clientHeight),'保持の確認に使う通知にはスクロールできる全文がある');
  for(const selector of ['summary','.ktr-header-notice-body','[data-release-action="close-notice"]']){
   const focused=notification.locator(selector);
   await focused.focus();await body.evaluate(el=>{el.scrollTop=80;});
   const scrollBefore=await body.evaluate(el=>el.scrollTop);
   assert.ok(scrollBefore>0);
   await page.evaluate(()=>view.render());
   assert.equal(await notification.evaluate(el=>el.open),true);
   assert.equal(await focused.evaluate(el=>el===document.activeElement),true,'同じ通知の再描画で焦点を保つ: '+selector);
   assert.equal(await body.evaluate(el=>el.scrollTop),scrollBefore,'通知を読んでいる位置を保つ: '+selector);
  }
  assert.equal(await notification.evaluate(el=>el.open),true,'同じ通知は再描画でも開いたまま');
  assert.equal(await page.locator('#kt-release-input').inputValue(),'未送信の修正相談');
  assert.equal(await page.locator('.ktr-current').innerText(),proposalText);
  await notification.locator('[data-release-action="close-notice"]').click();await closed();
  assert.equal(await summary.evaluate(el=>el===document.activeElement),true,'閉じる操作後は通知の見出しへ焦点を戻す');
  await open();await summary.press('Escape');await closed();
  assert.equal(await summary.evaluate(el=>el===document.activeElement),true);
  await page.locator('[data-release-action="code"]').click();
  await page.locator('#local-code').fill('const edited = "手直し中";');
  await open();await page.evaluate(()=>view.render());
  assert.equal(await notification.evaluate(el=>el.open),true);
  assert.equal(await page.locator('.ktr-current').isHidden(),true,'通知操作でコード表示から変更案へ戻さない');
  assert.equal(await page.locator('#local-code').inputValue(),'const edited = "手直し中";');
  assert.equal(await page.locator('#kt-release-input').inputValue(),'未送信の修正相談');
  assert.equal(await page.evaluate(()=>JSON.stringify(state)),initial,'通知操作は採用内容や反映状態を書き換えない');
  await notification.locator('.ktr-header-notice-body').focus();
  await page.evaluate(()=>{state.error={code:'NETWORK_ERROR',message:'別の通信エラーが発生しました。'};view.render();});await closed();
  assert.equal(await summary.evaluate(el=>el===document.activeElement),true,'別の通知へ替わったら閉じた見出しへ焦点を移す');
  assert.equal(await summary.locator('[role="alert"]').innerText(),'処理を完了できませんでした');
  await open();assert.match(await notification.locator('.ktr-header-notice-body').innerText(),/別の通信エラー/);
  assert.doesNotMatch(await notification.locator('.ktr-header-notice-body').innerText(),/利用上限/);
  await page.locator('#kt-release-input').focus();
  await page.locator('#kt-release-input').evaluate(el=>el.setSelectionRange(2,5));
  await page.evaluate(()=>{state.error={code:'NETWORK_ERROR',message:'接続をもう一度確認してください。'};view.render();});await closed();
  assert.equal(await page.locator('#kt-release-input').evaluate(el=>el===document.activeElement),true,'通知の外で入力中なら新しい通知へ焦点を奪わない');
  assert.deepEqual(await page.locator('#kt-release-input').evaluate(el=>[el.selectionStart,el.selectionEnd]),[2,5]);
  await page.evaluate(()=>{state.error=null;view.render();});
  assert.equal(await notification.count(),0,'通知がなくなれば前の全文も消す');
  await page.evaluate(()=>{connection={connected:false};view.render();});await closed();
  assert.equal(await summary.locator('[role="status"]').innerText(),'接続を確認してください');
  await open();await notification.locator('[data-release-action="connect"]').click();
  assert.deepEqual(await page.evaluate(()=>calls),{ai:0,write:0,connect:1},'開閉や接続画面の入口でAIや書き込みを実行しない');
  assert.equal(await page.locator('#local-code').inputValue(),'const edited = "手直し中";');
  assert.equal(await page.locator('#kt-release-input').inputValue(),'未送信の修正相談');
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
 }finally{await browser.close();}
});
