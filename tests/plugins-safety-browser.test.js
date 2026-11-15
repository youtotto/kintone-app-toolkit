'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function playwright(){try{return require(process.env.PLAYWRIGHT_MODULE||'playwright');}catch{return require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}}
async function fixture(t){
  const browser=await playwright().chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
  const context=await browser.newContext({serviceWorkers:'block'}), unexpected=[];
  let page;
  t.after(async()=>{try{assert.deepEqual(unexpected,[]);if(page)assert.deepEqual(await page.evaluate(()=>window.writes||[]),[]);}finally{await browser.close();}});
  await context.route('**/*',r=>{if(r.request().url()==='https://audit.test.invalid/')return r.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div id="root"><div id="view-plugins"></div></div><div id="incoming"><button id="kt-in-scan">Scan</button><input id="kt-in-actions" type="checkbox" checked><div id="kt-in-status"></div><div id="kt-in-result"></div></div>'});unexpected.push(r.request().url());return r.abort();});
  page=await context.newPage();await page.goto('https://audit.test.invalid/');
  let source=fs.readFileSync(process.env.KT_SRC||path.join(root,'kintoneAppToolkit.user.js'),'utf8').replace('waitReady().then(() => startToolkit());','');
  const end=source.lastIndexOf('})();');source=source.slice(0,end)+'\nglobalThis.Audit={renderPlugins,bindIncoming,KTIncoming,KTApi};\n'+source.slice(end);
  await page.addScriptTag({content:source});
  await page.evaluate(()=>{
    window.reads=[];window.writes=[];
    const api=async(url,method)=>{if(method!=='GET'){writes.push(url);throw Error('No writes allowed');}reads.push(url);return {plugins:[]};};api.url=p=>p;
    window.kintone={api,app:{getId:()=>310},getLoginUser:()=>({id:'A'}),system:{getPermissions:async()=>({administration:true})}};
    window.render=()=>Audit.renderPlugins(document.querySelector('#root'),{appId:'310',plugins:[{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',name:'Audit plugin',description:'Plugin description',version:'1'}]});
  });
  return page;
}
test('non-admin, malformed and rejected permissions fail closed, including an already rendered view',async t=>{
  const page=await fixture(t);
  for(const permission of [{administration:false},null,{},true,'reject']){
    await page.evaluate(async()=>{kintone.system.getPermissions=async()=>({administration:true});await render();reads.length=0;});
    await page.evaluate(async permission=>{kintone.system.getPermissions=async()=>{if(permission==='reject')throw Error('Permission unavailable');return permission;};await render();},permission);
    assert.equal(await page.locator('#view-plugins button').count(),0);
    assert.match(await page.locator('#view-plugins').innerText(),/システム管理者|権限/);
    assert.deepEqual(await page.evaluate(()=>reads),[]);
  }
});
test('plugin row name, description, blank area, checkbox and Space each toggle exactly once',async t=>{
  const page=await fixture(t);await page.evaluate(()=>render());
  const cb=page.locator('#kt-plg-catalog input');
  async function check(expected){assert.equal(await cb.isChecked(),expected);assert.equal(await page.locator('#kt-plg-add').isEnabled(),expected);}
  await page.getByText('Audit plugin',{exact:true}).click();await check(true);
  await page.getByText('Plugin description',{exact:true}).click();await check(false);
  await page.locator('#kt-plg-catalog label').click({position:{x:3,y:3}});await check(true);
  await cb.click();await check(false);await cb.focus();await page.keyboard.press('Space');await check(true);
  await page.locator('#kt-plg-search').fill('Audit');await check(true);
  await page.getByText('Audit plugin',{exact:true}).click();await check(false);
  assert.deepEqual(await page.evaluate(()=>reads),['/k/v1/app/plugins.json','/k/v1/preview/app/plugins.json']);
});
test('incoming screen shows partial action reads and cap warnings; account B cannot restore A rows',async t=>{
  const page=await fixture(t);
  await page.evaluate(async()=>{
    Audit.KTApi.getAppList=async()=>[{appId:'2',name:'Private app'}];
    Audit.KTApi.getFormFieldsOf=async()=>({properties:{}});
    Audit.KTApi.getActionsOf=async()=>{throw Error('permission denied');};
    Audit.bindIncoming(document.querySelector('#incoming'),'1',null);
  });
  await page.locator('#kt-in-scan').click();await page.waitForFunction(()=>!document.querySelector('#kt-in-scan').disabled);
  assert.match(await page.locator('#kt-in-status').innerText(),/確認できず/);
  assert.match(await page.locator('#kt-in-result').innerText(),/アプリアクション.*確認できていません/);
  await page.evaluate(async()=>{
    Audit.KTApi.getActionsOf=async()=>({actions:{}});
    Audit.KTApi.getAppList=async()=>Array.from({length:500},(_,i)=>({appId:String(i+1),name:'Private app'}));
    Audit.KTApi.getFormFieldsOf=async()=>({properties:{x:{code:'x',lookup:{relatedApp:{app:'1'},relatedKeyField:'key'}}}});
  });
  await page.locator('#kt-in-scan').click();await page.waitForFunction(()=>!document.querySelector('#kt-in-scan').disabled);
  assert.match(await page.locator('#kt-in-status').innerText(),/上限.*500/);
  assert.match(await page.locator('#kt-in-result').innerText(),/Private app/);
  await page.evaluate(()=>{kintone.getLoginUser=()=>({id:'B'});document.querySelector('#kt-in-result').innerHTML='';Audit.bindIncoming(document.querySelector('#incoming'),'1',null);});
  assert.equal(await page.locator('#kt-in-status').innerText(),'未走査');
  assert.doesNotMatch(await page.locator('#kt-in-result').innerText(),/Private app/);
});
