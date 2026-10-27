'use strict';
// Offline browser: every network request is intercepted; no live AI or kintone.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {loadToolkit}=require('./helpers/load-toolkit.js');
const {makeEnvGetter,fileEntry}=require('./helpers/dev-base-fake.js');
const F=require('./helpers/release-workspace-fixture.js'),E=require('./helpers/release-explanation-fixture.js');
const root=path.resolve(__dirname,'..');
const clone=F.clone;
test('未反映一覧は無料、説明だけ1回送信し、採用対象・下書き・編集を保持する',{timeout:90000},async()=>{
 let pw;try{pw=require(process.env.PLAYWRIGHT_MODULE||'playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
 const {describeRegistry}=await import(pathToFileURL(path.join(root,'../AI/worker/src/v2/prompt-registry.mjs')).href);
 const health={ok:true,supportedContractVersions:['2.1'],registry:describeRegistry(),entitlements:[{product:'toolkit',features:['assistant-qa','change-planner','customization-generator']}]};
 const prod={appId:'398',appName:'比較用',fields:{memo:{code:'memo',label:'備考',type:'SINGLE_LINE_TEXT'}},layout:[],views:{views:{}},settings:{name:'比較用',description:''},customize:{scope:'ALL',desktop:{js:[fileEntry('old','test.js','OLD;')],css:[]},mobile:{js:[],css:[]}}};
 const prev=clone(prod);prev.fields.memo.required=true;prev.fields.added={code:'added',label:'<img src=x onerror=alert(1)>',type:'SINGLE_LINE_TEXT'};prev.customize.desktop.js=[fileEntry('new','test.js','NEW;')];
 const T=loadToolkit(),calls=[],unexpected=[],errors=[];let revision='2',failCore=false,holdRead=null,holdNextRead=false,releaseRead,failNextAI=false;
 const getter=()=>makeEnvGetter({preview:prev,production:prod,files:{old:'OLD;',new:'NEW;'},revisions:{preview:revision,production:'1'},fail:{...(failCore?{'preview:app/form/fields':new Error('fixture core denied')}:{}),'production:field/acl':Object.assign(new Error('fixture denied'),{status:403})}});
 const loadBase=async()=>{const g=getter();const result=await T.KTDevBase.loadForRelease({appId:'398',...g});if(holdNextRead){holdNextRead=false;holdRead=new Promise(resolve=>{releaseRead=resolve;});await holdRead;}return JSON.parse(JSON.stringify(result));};
 const browser=await pw.chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
  await context.route('**/*',route=>{if(route.request().url()==='https://diff.test.invalid/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><body style="margin:0"><div id="app" style="height:100vh"></div><div id="code-home"><textarea id="code">local secret draft</textarea></div></body></html>'});unexpected.push(route.request().url());return route.abort();});
  const page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('base',loadBase);await page.exposeFunction('service',async(name,ctx)=>{calls.push({name,ctx});if(name==='getHealth')return health;if(name==='propose'&&ctx.requestPurpose==='document'){if(failNextAI){failNextAI=false;throw new Error('固定の通信失敗');}const r=E.response('未反映の変更の説明');r.explanation.sections.forEach(s=>s.evidenceIds=[ctx.facts[0].id]);return r;}if(name==='propose')return F.proposal();throw Error('Unexpected '+name);});
  await page.goto('https://diff.test.invalid/');
  let src=fs.readFileSync(path.join(root,'kintoneAppToolkit.user.js'),'utf8').replace('waitReady().then(() => startToolkit());','');const end=src.lastIndexOf('})();');src=src.slice(0,end)+'\nglobalThis.DiffTest={mountReleaseWorkspace,KTAiClient};\n'+src.slice(end);await page.addScriptTag({content:src});
  await page.evaluate(prod=>{
   window.connected=false;window.saved=[];window.edits=[{name:'test.js',kind:'js',target:'desktop',environment:'preview',state:'edited',text:'local secret draft',fileKey:'do-not-send'}];
   const client=Object.fromEntries(['getHealth','propose','plan','generate'].map(name=>[name,async input=>window.service(name,input?.ctx)]));
   window.work=DiffTest.mountReleaseWorkspace(document.querySelector('#app'),{appId:'398',settings:DiffTest.KTAiClient.createSettingsStore(),session:{client,status:()=>({connected,apiBase:'https://gateway.test.invalid'})},loadDevBase:window.base,getInputs:()=>({data:prod}),copyText:()=>{},downloadText:(name,text)=>saved.push({name,text})});
   work.attachCodePanel({element:document.querySelector('#code'),home:document.querySelector('#code-home'),getLocalEdits:()=>edits});
  },prod);
  const action=name=>page.locator('[data-release-action="'+name+'"]').first(),dialog=()=>page.locator('dialog:has([data-environment-comparison])'),explain=()=>dialog().locator('[data-comparison-explain]');
  const open=async()=>{await action('pending-changes').click();await page.waitForFunction(()=>document.querySelector('[data-environment-comparison]')?.textContent.includes('手元の未登録編集'));};
  const paid=()=>calls.filter(c=>c.name!=='getHealth').length;
  await open();
  assert.equal(calls.length,0,'無料一覧はAIもhealthも呼ばない');assert.equal(await explain().isDisabled(),true,'未接続なら説明だけ使えない');
  assert.match(await dialog().innerText(),/確認できた変更/);assert.match(await dialog().innerText(),/手元で編集中・未登録/);assert.equal(await dialog().locator('img').count(),0,'設定値はHTMLとして実行しない');
  await dialog().locator('.ktr-env-coverage summary').click();assert.match(await dialog().innerText(),/アクセス権：フィールド/);
  await dialog().locator('.ktr-env-entry summary').first().click();assert.match(await dialog().innerText(),/運用環境/);assert.match(await dialog().innerText(),/動作テスト環境/);
  const out=path.join(__dirname,'.build/release-environment-diff');fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'comparison-wide.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await dialog().evaluate(el=>el.scrollWidth<=el.clientWidth+2),true,'狭い画面でもダイアログ全体をはみ出さない');await page.screenshot({path:path.join(out,'comparison-narrow.png'),fullPage:true});await page.setViewportSize({width:1440,height:900});
  await dialog().locator('[data-close]').click();assert.equal(await page.locator('#kt-release-input').inputValue(),'');assert.equal(await page.locator('#code').inputValue(),'local secret draft');
  await page.evaluate(()=>{connected=true;return work.refreshCapability(true);});
  await open();await explain().click();await page.locator('dialog:has([data-consent]) [data-close]').click();await page.waitForFunction(()=>!document.querySelector('[data-comparison-explain]').disabled);assert.equal(paid(),0,'送信同意を取り消すとAIは呼ばない');await dialog().locator('[data-close]').click();
  await page.locator('#kt-release-input').fill(F.REQUEST);await action('send').click();await page.locator('[data-consent]').click();await page.waitForFunction(()=>work.controller.getState().phase==='proposal');
  await page.evaluate(()=>work.controller.setConsultationTarget({type:'FILE',name:'test.js',target:'desktop',environment:'preview'}));
  const before=await page.evaluate(()=>{const s=work.controller.getState();return{proposal:s.proposal,version:s.version,answers:s.answers,plan:s.plan,prepared:s.prepared,runs:s.runs,consultationTarget:s.consultationTarget};});
  await page.locator('#kt-release-input').fill('残しておく下書き');await open();const initial=paid();await explain().dblclick();await page.waitForFunction(()=>work.controller.getState().explanations.length===1);
  assert.equal(paid(),initial+1);const sent=calls.at(-1).ctx;assert.deepEqual(sent.focus.target,{type:'environment-diff',id:'production->preview'});assert.equal(sent.requestPurpose,'document');
  assert.ok(sent.facts.some(f=>f.kind==='env-diff-coverage'));assert.ok(sent.facts.some(f=>f.value?.before?.text==='OLD;'&&f.value?.after?.text==='NEW;'));assert.ok(sent.facts.some(f=>f.kind==='local-unregistered-edit'));
  assert.doesNotMatch(JSON.stringify(sent),/local secret draft|do-not-send|残しておく下書き/);assert.ok(sent.facts.every(f=>/^E\d+$/.test(f.id)&&f.statement&&f.confidence));
  assert.deepEqual(await page.evaluate(()=>{const s=work.controller.getState();return{proposal:s.proposal,version:s.version,answers:s.answers,plan:s.plan,prepared:s.prepared,runs:s.runs,consultationTarget:s.consultationTarget};}),before);
  assert.equal(await page.locator('#kt-release-input').inputValue(),'残しておく下書き');assert.equal(await page.locator('#code').inputValue(),'local secret draft');
  await action('code').click();await action('code').click();assert.equal(await page.locator('#code').inputValue(),'local secret draft');
  await open();const unchangedCalls=paid();revision='3';await explain().click();await page.waitForFunction(()=>work.controller.getState().error?.code==='ENVIRONMENT_COMPARISON_CHANGED');assert.equal(paid(),unchangedCalls,'一覧の後に設定が変わればAI送信前に止める');
  await open();failNextAI=true;await explain().click();await page.waitForFunction(()=>work.controller.getState().error?.message.includes('固定の通信失敗'));assert.equal(await page.locator('#kt-release-input').inputValue(),'残しておく下書き');
  holdNextRead=true;await action('pending-changes').click();await page.waitForFunction(()=>document.querySelector('[data-comparison-refresh]')?.disabled===true);await dialog().locator('[data-close]').click();while(!releaseRead)await new Promise(r=>setTimeout(r,10));releaseRead();await page.waitForTimeout(50);assert.equal(await dialog().count(),0,'閉じた一覧へ遅い取得結果を再表示しない');
  failCore=true;await open();assert.equal(await explain().isDisabled(),true,'比較できた範囲があっても説明に必要な取得が失敗したら押せない');assert.match(await dialog().innerText(),/AIの説明に必要な動作テスト環境の設定を取得できませんでした/);await dialog().locator('[data-close]').click();
  assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);await page.evaluate(()=>work.dispose());await context.close();
 }finally{await browser.close();}
});
