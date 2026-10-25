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
  for(const file of ['release-workspace.js','release-view.js'])await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../src',file),'utf8')});
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
  await page.screenshot({path:path.join(out,'plan-failed.png')});
  await page.setViewportSize({width:390,height:900});await noOverflow();
  assert.ok(await page.locator('.ktr-layout').evaluate(el=>el.clientHeight)>300,'狭い画面でも長い失敗理由が操作領域を押し出さない');
  await reachable(page.locator('[data-release-action="adopt"]'));
  assert.equal(await page.locator('[role="alert"]').innerText(),await page.evaluate(()=>controller.getState().error.message));
  await page.screenshot({path:path.join(out,'narrow-plan-failed.png')});
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
  assert.match(await page.locator('[role="alert"]').innerText(),/案は更新していません/);
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
