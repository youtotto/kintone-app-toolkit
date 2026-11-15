'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
test('入力欄の手動サイズ・スクロール・選択範囲を入力と状態更新で保持する',{timeout:30000},async()=>{
 let pw;try{pw=require('playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
 const browser=await pw.chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1536,height:900}});const requests=[];
  await context.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
  const page=await context.newPage();await page.setContent('<html style="height:100%"><body style="margin:0;height:100%"><div id="app" style="height:100%"></div></body></html>');
  let source=fs.readFileSync(process.env.KT_SRC||path.join(root,'kintoneAppToolkit.user.js'),'utf8').replace('waitReady().then(() => startToolkit());','');const end=source.lastIndexOf('})();');
  await page.addScriptTag({content:source.slice(0,end)+'\nglobalThis.ComposerTest=KTReleaseView;\n'+source.slice(end)});
  await page.evaluate(()=>{
   const state={phase:'idle',taskId:1,version:1,messages:Array.from({length:20},(_,i)=>({role:i%2?'assistant':'user',text:'既存の相談本文 '+i})),runs:[],artifacts:[]};
   const listeners=new Set();window.redraw=()=>{for(const fn of listeners)fn(state);};
   window.view=ComposerTest.create(document.querySelector('#app'),{controller:{getState:()=>state,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}},connection:{connected:true,available:true},onHistory:()=>{}});
  });
  const input=page.locator('#kt-release-input');
  // Previous visible message heights at the same viewport and fixture.
  for (const [width, minimum] of [[1536,466],[1100,437],[900,331]]) {
   await page.setViewportSize({width,height:790});
   const height=await page.locator('.ktr-chat-log').evaluate(el=>el.getBoundingClientRect().height);
   assert.ok(height>=minimum,'本文の表示領域を減らさない: '+width+'px ('+height+')');
  }
  await page.setViewportSize({width:1536,height:900});
  const initial=await input.evaluate(el=>el.clientHeight);assert.ok(initial>=100,'初期状態で4行以上を表示する');
  await input.fill(Array.from({length:30},(_,i)=>'まだ送信しない下書き '+i).join('\n'));
  await input.evaluate(el=>{el.style.height='240px';el.focus();el.setSelectionRange(4,8);el.scrollTop=40;window.originalComposer=el;});
  const before=await input.evaluate(el=>({height:el.clientHeight,scroll:el.scrollTop,start:el.selectionStart,end:el.selectionEnd}));
  await page.evaluate(()=>view.setDraft(document.querySelector('#kt-release-input').value));
  assert.equal(await input.evaluate(el=>el===originalComposer),true,'入力変更だけでは入力ノードを作り直さない');
  await page.evaluate(()=>redraw());
  assert.deepEqual(await input.evaluate(el=>({height:el.clientHeight,scroll:el.scrollTop,start:el.selectionStart,end:el.selectionEnd})),before);
  assert.equal(await input.evaluate(el=>el===document.activeElement),true);
  assert.deepEqual(requests,[]);
 }finally{await browser.close();}
});
