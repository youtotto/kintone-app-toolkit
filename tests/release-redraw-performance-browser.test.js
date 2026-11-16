'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
let browser;
test.before(async()=>{let pw;try{pw=require('playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}browser=await pw.chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});});
test.after(async()=>{await browser?.close();});
async function fixture(t){
  const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[],network=[];
  t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(network,[]);});
  page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{network.push(r.request().url());return r.abort();});
  await page.setContent('<!doctype html><meta charset="utf-8"><div id="host" style="height:800px"></div>');
  let source=fs.readFileSync(process.env.KT_SRC||path.join(root,'kintoneAppToolkit.user.js'),'utf8').replace('waitReady().then(() => startToolkit());','');
  const end=source.lastIndexOf('})();');source=source.slice(0,end)+'\nwindow.Perf={KTReleaseWorkspace,KTReleaseView};\n'+source.slice(end);
  await page.addScriptTag({content:source});
  await page.evaluate(()=>{
    const denied=()=>{throw Error('No services permitted');};
    const c=Perf.KTReleaseWorkspace.create({services:{propose:denied,plan:denied,generate:denied},loadBase:denied,execution:{}});
    window.state=c.getState();state.messages=Array.from({length:200},(_,i)=>({role:i%2?'assistant':'user',text:'相談 '+i+' 確認する内容。'.repeat(20)}));
    c.getState=()=>structuredClone(state);window.conn={connected:true,available:true};window.host=document.querySelector('#host');
    window.view=Perf.KTReleaseView.create(host,{controller:c,connection:()=>conn});window.displayEvents=0;view.subscribeDisplay(()=>displayEvents++);
  });return page;
}
test('unchanged redraws preserve conversation DOM, focus, selection, scrolling and open details',async t=>{
  const page=await fixture(t);
  const result=await page.evaluate(()=>{
    view.setDraft('入力中の文章');view.render();
    const input=host.querySelector('#kt-release-input'),message=host.querySelector('.ktr-message'),log=host.querySelector('.ktr-chat-log');
    const detail=host.querySelector('details[data-release-panel]');if(detail)detail.open=true;
    input.focus();input.setSelectionRange(2,5);log.scrollTop=50;const top=log.scrollTop;
    for(let i=0;i<5;i++)view.render();
    return {inputSame:input===host.querySelector('#kt-release-input'),messageSame:message===host.querySelector('.ktr-message'),focused:document.activeElement===input,selection:[input.selectionStart,input.selectionEnd],draft:view.getDraft(),scrollSame:log.scrollTop===top,detailsOpen:!detail||detail.open,events:displayEvents,count:host.querySelectorAll('.ktr-message').length};
  });
  assert.equal(result.inputSame,true);assert.equal(result.messageSame,true);assert.equal(result.focused,true);assert.deepEqual(result.selection,[2,5]);assert.equal(result.draft,'入力中の文章');assert.equal(result.scrollSame,true);assert.equal(result.detailsOpen,true);assert.ok(result.events>=5);assert.equal(result.count,200);
});
test('message edits with the same message count and connection changes invalidate the rendered result',async t=>{
  const page=await fixture(t);
  const result=await page.evaluate(()=>{
    const before=host.querySelector('.ktr-message');state.messages[0].text='変更した内容';view.render();
    const changed=host.querySelector('.ktr-message'),text=changed.textContent;
    conn.connected=false;view.render();const disabled=host.querySelector('[data-release-action="send"]').disabled;
    conn.connected=true;view.render();return {replaced:before!==changed,text,disabled,count:host.querySelectorAll('.ktr-message').length};
  });assert.equal(result.replaced,true);assert.match(result.text,/変更した内容/);assert.equal(result.disabled,true);assert.equal(result.count,200);
});
test('resetDisplay remains explicit and rebuilds even when state text is unchanged',async t=>{
  const page=await fixture(t);
  const result=await page.evaluate(()=>{const before=host.querySelector('.ktr-message');view.resetDisplay();return {replaced:before!==host.querySelector('.ktr-message'),count:host.querySelectorAll('.ktr-message').length};});
  assert.equal(result.replaced,true);assert.equal(result.count,200);
});

test('a different task or proposal version never reuses old controls despite identical visible text',async t=>{
  const page=await fixture(t);
  const result=await page.evaluate(()=>{
    const first=host.querySelector('#kt-release-input');state.taskId++;view.render();const second=host.querySelector('#kt-release-input');
    state.version++;view.render();return {taskChanged:first!==second,versionChanged:second!==host.querySelector('#kt-release-input')};
  });assert.equal(result.taskChanged,true);assert.equal(result.versionChanged,true);
});

test('large views exceed the reuse limit without truncating displayed content',async t=>{
  const page=await fixture(t);
  const result=await page.evaluate(()=>{
    state.messages=[{role:'assistant',text:'長文の確認。'.repeat(90000)}];view.render();
    const before=host.querySelector('.ktr-message'),length=before.querySelector('p').textContent.length;
    view.render();return {replaced:before!==host.querySelector('.ktr-message'),length,nextLength:host.querySelector('.ktr-message p').textContent.length,expected:state.messages[0].text.length};
  });assert.equal(result.replaced,true);assert.equal(result.length,result.expected);assert.equal(result.nextLength,result.expected);
});
