'use strict';
// Actual shell, runtime and Customize DOM; local Monaco and service fixtures only.
// No request may leave this browser context.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'tests/.build/release-customize');
function playwright() {
  try { return require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
  catch { return require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
}
function bundle() {
  const source = fs.readFileSync(process.env.KT_SRC || path.join(root, 'kintoneAppToolkit.user.js'), 'utf8').replace('waitReady().then(() => startToolkit());', '');
  const end = source.lastIndexOf('})();');
  return source.slice(0, end) + '\nglobalThis.CustomizeTest={mountRoot,renderCustomize,renderAiWorkspace,KTApi,KTDevBase,KTAiClient,KTScan};\n' + source.slice(end);
}
async function mount(page) {
  await page.evaluate(async () => {
    const T = CustomizeTest, C = T.KTAiClient;
    const clone = value => structuredClone(value);
    window.scanCalls=[];
    for(const method of ['run','runStale','analyzeFile','buildPayload']){const original=T.KTScan[method];T.KTScan[method]=function(...args){scanCalls.push(method);return original.apply(this,args);};}
    window.operations = []; window.fileReads = []; window.pendingFile = null; window.fileFailure = null; window.holdNextCustomize = false; window.pendingList = null;
    const denied = name => () => { operations.push(name); throw Error('Forbidden in local browser test: ' + name); };
    const file = (name, fileKey) => ({type:'FILE', file:{name,fileKey,size:'40'}});
    const customize = {revision:'7',scope:'ALL',desktop:{js:[file('same.js','pc'),file('second.js','second'),file('slow.js','slow')],css:[file('style.css','css')]},mobile:{js:[file('same.js','mobile')],css:[]}};
    const sources = {pc:'// PC original\nconst memo = 1;\n',mobile:'// mobile original\nconst memo = 2;\n',second:'// second original\n',slow:'// slow original\n',css:'.memo { color: blue; }\n'};
    window.addRegisteredFiles = count => { for(let i=0;i<count;i++){const key='extra-'+i;customize.desktop.js.push(file(key+'.js',key));sources[key]='// extra registered file '+i+'\n';} };
    T.KTApi.getCustomize = async (_app, options) => { const result={source:options?.preferPreview === false ? 'prod' : 'preview',data:clone(customize)}; if(window.holdNextCustomize&&result.source==='preview'){window.holdNextCustomize=false;return new Promise(resolve=>{window.pendingList=()=>resolve(result);});} return result; };
    T.KTApi.downloadFile = async key => { fileReads.push(key); if(key===window.fileFailure)throw Error('Fixture download failure'); if(key === 'slow')return new Promise(resolve => {window.pendingFile=()=>resolve(sources.slow);}); return sources[key]; };
    for(const method of ['uploadFile','putPreviewCustomize','deploy','waitDeploy','deployAndWait'])T.KTApi[method]=denied('kintone.'+method);
    window.monacoModels=[]; window.monacoEditors=[]; window.monacoDiffs=[];
    const createModel = (value,language) => {
      const model={text:String(value),language,disposed:false,listeners:new Set(),getValue(){return this.text;},setValue(text){this.text=String(text);for(const listener of this.listeners)listener();},dispose(){this.disposed=true;this.listeners.clear();},onDidChangeContent(listener){this.listeners.add(listener);return {dispose:()=>this.listeners.delete(listener)};}};
      monacoModels.push(model); return model;
    };
    const createEditor = (host, options={}) => {
      const area=document.createElement('textarea');area.dataset.testEditor='true';area.style.cssText='width:100%;height:100%;box-sizing:border-box;font:13px monospace';host.appendChild(area);
      let model=options.model||createModel(options.value||'',options.language),off=null;
      const listeners=new Set();
      const attach=()=>{off?.dispose();off=model.onDidChangeContent(()=>{area.value=model.getValue();for(const listener of listeners)listener();});area.value=model.getValue();};attach();
      area.readOnly=!!options.readOnly;area.addEventListener('input',()=>model.setValue(area.value));
      const editor={host,area,disposed:false,getValue:()=>model.getValue(),setValue:value=>model.setValue(value),getModel:()=>model,setModel(value){model=value;attach();},onDidChangeModelContent(listener){listeners.add(listener);return {dispose:()=>listeners.delete(listener)};},saveViewState:()=>({selection:[area.selectionStart,area.selectionEnd],top:area.scrollTop}),restoreViewState(saved){if(saved?.selection)area.setSelectionRange(...saved.selection);if(saved)area.scrollTop=saved.top;},getPosition:()=>({lineNumber:1,column:1}),setPosition(){},updateOptions(value){if('readOnly' in value)area.readOnly=value.readOnly;},focus:()=>area.focus(),layout(){},dispose(){off?.dispose();editor.disposed=true;area.remove();}};
      monacoEditors.push(editor);return editor;
    };
    window.loadMonaco = async()=>({ _kintoneFieldsReady:true,editor:{create:createEditor,createModel,setModelLanguage(model,language){model.language=language;},createDiffEditor(host,options={}){
      const before=createEditor(host,{readOnly:options.readOnly}),after=createEditor(host,{readOnly:options.readOnly});host.style.display='flex';
      before.area.dataset.diffSide='original';after.area.dataset.diffSide='modified';
      const editor={host,options,disposed:false,model:null,setModel(models){this.model=models;if(models){before.setModel(models.original);after.setModel(models.modified);}},getModel(){return this.model;},getOriginalEditor:()=>before,getModifiedEditor:()=>after,updateOptions(){},layout(){},dispose(){this.disposed=true;before.dispose();after.dispose();}};
      monacoDiffs.push(editor);return editor;
    }}});
    window.referenceScan={meta:{appId:'310',source:'preview',scannedAt:'2026-10-26T00:00:00Z'},files:[{name:'same.js',target:'desktop',kind:'js',fileKey:'pc',text:sources.pc}],results:[{code:'memo',label:'備考',type:'SINGLE_LINE_TEXT',matches:[{file:'same.js',target:'desktop',kind:'js',access:'READ',line:2,confidence:'HIGH'}]}],fileEvents:{'desktop:js:same.js':[{name:'app.record.edit.show',direct:true}]},unknownRefs:[]};
    window.matchingReferenceScan=clone(referenceScan);
    const data={appId:'310',appName:'カスタマイズ確認用',fields:{memo:{type:'SINGLE_LINE_TEXT',code:'memo',label:'備考'}},layout:[],status:{enable:false,states:{},actions:[]},views:{views:{}},customize};
    const base={ok:true,env:'preview',appId:'310',loadedAt:'2026-10-26T00:00:00Z',revision:{preview:'7',production:'7'},data,files:[...customize.desktop.js.map(entry=>({name:entry.file.name,fileKey:entry.file.fileKey,type:'FILE',target:'desktop',text:sources[entry.file.fileKey],sourceAvailable:true})),...customize.mobile.js.map(entry=>({name:entry.file.name,fileKey:entry.file.fileKey,type:'FILE',target:'mobile',text:sources[entry.file.fileKey],sourceAvailable:true}))],errors:[]};
    T.KTDevBase.loadForRelease=async()=>clone(base);
    const health={ok:true,supportedContractVersions:[C.CONTRACT_VERSION],entitlements:[{product:C.PRODUCT,features:[C.FEATURE,C.FEATURE_PLANNER]}],registry:{[C.PRODUCT]:{
      [C.FEATURE]:{implemented:true,promptVersions:[C.PROMPT_VERSION],conversation:[...C.CONVERSATION_MARKS,'releaseWorkspace','appExplanation']},
      [C.FEATURE_PLANNER]:{implemented:true,promptVersions:[C.PLANNER_PROMPT_VERSION],...C.PLANNER_MARKS,requirementOps:[...C.PLANNER_MARKS.requirementOps,'releaseWorkspace','formLayoutPlacement','fieldMaintenance']}
    }}};
    window.proposalCalls=[];
    const client={getHealth:async()=>health,propose:async({ctx})=>{proposalCalls.push(clone(ctx));return {reply:'備考の編集条件を変更する案です。',intent:'propose',proposal:{behaviors:[{id:'B1',text:'備考の編集条件を変更する',origin:'user'}],assumptions:[],decisions:[],approach:{standard:[],js:['備考の編集条件']},cannot:[]},turn:{ops:[],answers:[],requirementOps:[]}};},plan:denied('AI.plan'),generate:denied('AI.generate')};
    localStorage.setItem('ktToolkitFull.v1','1');
    const shell=window.shell=T.mountRoot();
    const settings=C.createSettingsStore();settings.setConsent(true,'release-raw-source-1');
    const session={client,status:()=>({connected:true,apiBase:'https://gateway.test.invalid'}),disconnect:async()=>{}};
    window.work=T.renderAiWorkspace(shell,data,'310',{getContextInputs:()=>({data,deps:{},scan:{files:[]}}),aiLink:{settings,session,probe:async()=>({ok:true,health})}});
    shell.ktAi=work;
    window.customize=T.renderCustomize(shell,data,'310',{autoLoad:true,getInputs:()=>({data,deps:{},scan:window.referenceScan}),consult:seed=>work.consult(seed)});
    window.customize=await window.customize;shell.ktCustomize=window.customize;
    window.customize.attachAssistant(work);
    window.originalHost=shell.querySelector('#kt-ai-host');
    await work.refreshCapability();
    await work.controller.send('備考の編集条件を見直したいです。');
    shell.ktTabs.switchTab('customize');
  });
}
const filePicker = page => page.locator('#kt-customize-file');
const editor = page => page.locator('#kt-customize-editor textarea[data-test-editor]');
async function selected(page,name,value){await filePicker(page).selectOption({label:name});await assertEventually(()=>editor(page).inputValue(),value);}
async function dragBy(page,handle,dx,dy){
  await handle.scrollIntoViewIfNeeded();const box=await handle.boundingBox();assert.ok(box,'サイズ調整の境界線を表示する');
  const x=box.x+box.width/2,y=box.y+box.height/2;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:6});await page.mouse.up();
}
const editorCssHeight=page=>page.locator('#kt-customize-editor').evaluate(el=>parseFloat(getComputedStyle(el).height));
async function geometry(page){return page.evaluate(async()=>{
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
  return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,shell:rect('#kt-toolkit'),ai:rect('#kt-ai-host'),chat:rect('#kt-ai-host .ktr-conversation'),code:rect('#kt-customize-code-pane'),codeSlot:rect('.ktr-code-slot'),proposal:rect('#kt-ai-host .ktr-current'),editor:rect('#kt-customize-editor'),menu:rect('.kt-customize-menu')};
});}
function assertHorizontal(g,label){
  assert.ok(g.code.left>=g.ai.right-2,label+': 左の相談と右のコードが重ならない');
  assert.ok(Math.abs(g.ai.top-g.codeSlot.top)<=2,label+': 相談とコードを同じ高さに並べる');
  assert.ok(g.ai.width>=320&&g.code.width>=380,label+': 相談とコードに読み書きできる幅を残す');
  assert.ok(g.ai.left>=g.shell.left-1&&g.code.right<=g.shell.right+1,label+': 枠内に収まる');
}
function assertVertical(g,label){
  assert.ok(g.code.top>=g.ai.bottom-2,label+': 上の相談と下のコードが重ならない');
  assert.ok(g.ai.width>0&&g.code.width>0,label+': 両方を表示する');
  assert.ok(g.ai.left>=g.shell.left-1&&g.ai.right<=g.shell.right+1&&g.code.left>=g.shell.left-1&&g.code.right<=g.shell.right+1,label+': 枠内に収まる');
  assert.ok(g.documentWidth<=g.viewport+1,label+': ページ横スクロールを増やさない');
}
async function assertEventually(read,expected){for(let i=0;i<100;i++){const value=await read();if(value===expected)return;await new Promise(resolve=>setTimeout(resolve,20));}assert.equal(await read(),expected);}

test('CustomizeからAI Assistantへ相談・必要時のコード表示と手編集の保持（外部通信なし）',{timeout:90000},async t=>{
  fs.mkdirSync(out,{recursive:true});
  const browser=await playwright().chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
  try{
    for(const colorScheme of ['light','dark'])await t.test(colorScheme,async()=>{
      const errors=[],unexpected=[];
      const context=await browser.newContext({viewport:{width:1440,height:960},colorScheme,serviceWorkers:'block'});
      try{
        await context.route('**/*',route=>{
          const url=route.request().url();
          if(url==='https://customize.test.invalid/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%}</style><body></body></html>'});
          if(url.startsWith('https://www.google.com/s2/favicons?'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg"/>'});
          unexpected.push(url);return route.abort();
        });
        const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
        await page.goto('https://customize.test.invalid/');await page.addScriptTag({content:bundle()});await mount(page);
        await selected(page,'same.js','// PC original\nconst memo = 1;\n');
        const initialGeometry=await geometry(page);
        assert.equal(await page.locator('#view-customize #kt-ai-host').count(),0,'Customizeにチャットを複製しない');
        assert.equal(await page.locator('#kt-release-input').isVisible(),false,'Customizeは編集に集中する');
        const initialShare=initialGeometry.editor.width/(initialGeometry.editor.width+initialGeometry.menu.width);
        assert.ok(initialShare>=.60&&initialShare<=.70,'左は約65%、右は参照情報を読める幅にする');
        assert.ok(initialGeometry.menu.left>=initialGeometry.editor.right+6,'Menuはエディターの右に置く');
        assert.ok(initialGeometry.menu.width>=280,'Menuの操作と参照情報に幅を残す');
        assert.ok(initialGeometry.editor.height>=260&&initialGeometry.editor.height<600,'短いコードの編集領域が画面いっぱいに伸びない');
        await page.screenshot({path:path.join(out,colorScheme+'-customize-menu.png'),fullPage:true});
        assert.ok(initialGeometry.code.right<=initialGeometry.shell.right+1,'Customizeのコードは枠内に収まる');
        const callsBeforeSelection=await page.evaluate(()=>proposalCalls.length);
        const reference=page.locator('#kt-customize-reference-info [data-reference-content]');
        assert.equal(await reference.isVisible(),true,'Menuの下で登録済みコードの参照情報を読める');
        assert.match(await reference.innerText(),/動作テスト環境/);assert.match(await reference.innerText(),/備考/);
        assert.match(await reference.innerText(),/編集画面を開いたとき（PC）/);assert.match(await reference.innerText(),/app\.record\.edit\.show/);
        assert.match(await reference.innerText(),/登録済みコードの解析結果/);assert.match(await reference.innerText(),/手元の編集は含みません/);
        const referenceCalls=await page.evaluate(()=>({ai:proposalCalls.length,reads:fileReads.length,scan:[...scanCalls]}));
        await page.evaluate(()=>{referenceScan={...matchingReferenceScan,meta:{...matchingReferenceScan.meta,source:'production'}};});
        await selected(page,'same.js','// PC original\nconst memo = 1;\n');
        assert.match(await reference.innerText(),/未確認/);assert.match(await reference.innerText(),/同じアプリ・環境の解析結果を確認できていません/);
        assert.doesNotMatch(await reference.innerText(),/備考|app\.record\.edit\.show/,'別環境のときに前の参照結果を残さない');
        await page.evaluate(()=>{referenceScan=structuredClone(matchingReferenceScan);});
        await selected(page,'same.js','// PC original\nconst memo = 1;\n');
        assert.match(await reference.innerText(),/備考/);assert.match(await reference.innerText(),/app\.record\.edit\.show/);
        assert.deepEqual(await page.evaluate(()=>({ai:proposalCalls.length,reads:fileReads.length,scan:[...scanCalls]})),referenceCalls,'参照情報の切り替えでAI・ダウンロード・新しい解析を呼ばない');
        const stateBeforeResize=await page.evaluate(()=>JSON.stringify(work.controller.getState()));
        await page.evaluate(()=>{window.resizeEditor=document.querySelector('#kt-customize-editor textarea[data-test-editor]');});
        const widthHandle=page.locator('#kt-customize-width-resize'),heightHandle=page.locator('#kt-customize-height-resize');
        assert.equal(await widthHandle.getAttribute('role'),'separator');assert.equal(await widthHandle.getAttribute('aria-orientation'),'vertical');
        assert.equal(await heightHandle.getAttribute('role'),'separator');assert.equal(await heightHandle.getAttribute('aria-orientation'),'horizontal');
        assert.equal(await widthHandle.getAttribute('aria-valuemin'),'45');assert.equal(await widthHandle.getAttribute('aria-valuemax'),'80');
        assert.equal(await heightHandle.getAttribute('aria-valuemin'),'220');assert.equal(await heightHandle.getAttribute('aria-valuemax'),'1000');
        assert.ok(Number(await widthHandle.getAttribute('tabindex'))>=0,'幅調整をキーボードでも選べる');
        assert.ok(Number(await heightHandle.getAttribute('tabindex'))>=0,'高さ調整をキーボードでも選べる');
        const startWidth=Number(await widthHandle.getAttribute('aria-valuenow'));
        await widthHandle.press('ArrowRight');assert.equal(Number(await widthHandle.getAttribute('aria-valuenow')),startWidth+2);
        await widthHandle.press('ArrowLeft');assert.equal(Number(await widthHandle.getAttribute('aria-valuenow')),startWidth);
        await dragBy(page,widthHandle,70,0);assert.ok((await geometry(page)).editor.width>initialGeometry.editor.width+30,'ドラッグで左の幅が広がる');
        await widthHandle.press('End');await widthHandle.press('ArrowRight');assert.equal(await widthHandle.getAttribute('aria-valuenow'),'80','右へ動かし続けても幅の上限を越えない');
        assert.ok((await geometry(page)).menu.width>=270,'幅を広げてもMenuを潰さない');
        await widthHandle.press('Home');await widthHandle.press('ArrowLeft');assert.equal(await widthHandle.getAttribute('aria-valuenow'),'45','幅の下限を越えない');
        for(let i=0;i<10;i++)await widthHandle.press('ArrowRight');
        const widthReset=await geometry(page);assert.ok(Math.abs(widthReset.editor.width-initialGeometry.editor.width)<=3,'65%へ戻せる');
        const startHeight=await editorCssHeight(page);
        await heightHandle.press('ArrowUp');assert.ok(Math.abs((await editorCssHeight(page))-(startHeight-20))<=2,'高さはキーで縮められる');
        await heightHandle.press('ArrowDown');assert.ok(Math.abs((await editorCssHeight(page))-startHeight)<=2);
        await dragBy(page,heightHandle,0,66);assert.ok((await editorCssHeight(page))>startHeight+40,'文字倍率があってもドラッグで高さが増える');
        await heightHandle.press('End');await heightHandle.press('ArrowDown');assert.equal(await heightHandle.getAttribute('aria-valuenow'),'1000','高さの上限を越えない');
        await heightHandle.press('Home');await heightHandle.press('ArrowUp');assert.equal(await heightHandle.getAttribute('aria-valuenow'),'220','高さの下限を越えない');
        for(let i=0;i<11;i++)await heightHandle.press('ArrowDown');
        assert.ok(Math.abs((await editorCssHeight(page))-440)<=2);
        assert.equal(await page.evaluate(()=>document.querySelector('#kt-customize-editor textarea[data-test-editor]')===resizeEditor),true,'サイズ変更でエディターを作り直さない');
        assert.equal(await editor(page).inputValue(),'// PC original\nconst memo = 1;\n');
        assert.equal(await page.evaluate(()=>JSON.stringify(work.controller.getState())),stateBeforeResize,'サイズ変更は会話・採用・呼び出しを変えない');
        // The picker keeps the editing area stable even when an app has many registered files.
        await page.evaluate(()=>addRegisteredFiles(50));
        await page.locator('#kt-customize-refresh').click();
        await page.waitForFunction(()=>[...document.querySelector('#kt-customize-file').options].some(option=>option.textContent==='extra-49.js'));
        assert.equal(await filePicker(page).evaluate(select=>select.tagName),'SELECT');
        assert.equal(await filePicker(page).evaluate(select=>select.multiple||select.size>1),false,'登録済みファイルは1行の選択欄');
        const manyGeometry=await geometry(page);
        assert.ok(manyGeometry.editor.width>=initialGeometry.editor.width-2,'ファイルが多数でもCustomizeのコード幅を保つ');
        assert.ok(manyGeometry.editor.height>=initialGeometry.editor.height-2,'ファイルの数でエディターを狭くしない');
        await selected(page,'extra-49.js','// extra registered file 49\n');
        await selected(page,'same.js','// PC original\nconst memo = 1;\n');
        assert.equal(await page.evaluate(()=>proposalCalls.length),callsBeforeSelection,'ファイルの選択・再取得ではAIを呼ばない');
        const beforeReferenceEdit=await page.evaluate(()=>({ai:proposalCalls.length,reads:fileReads.length,scan:[...scanCalls]}));
        await editor(page).fill('// PC unsaved edit\nconst memo = 10;\n');
        assert.match(await reference.innerText(),/登録済みコードの解析結果/);assert.match(await reference.innerText(),/手元の編集は含みません/);
        assert.match(await reference.innerText(),/備考/,'編集中でも登録済みコードの参照情報として示す');
        assert.deepEqual(await page.evaluate(()=>({ai:proposalCalls.length,reads:fileReads.length,scan:[...scanCalls]})),beforeReferenceEdit,'入力したコードを新たに解析しない');
        // A failed download must leave one consistent visible file and preserve its hand edits.
        await page.evaluate(()=>{window.fileFailure='second';});
        await filePicker(page).selectOption({label:'second.js'});
        await page.waitForFunction(()=>document.querySelector('#kt-customize-file-status').textContent.includes('読み込めませんでした'));
        assert.equal(await editor(page).inputValue(),'// PC unsaved edit\nconst memo = 10;\n');
        assert.equal(await filePicker(page).evaluate(select=>select.selectedOptions[0].textContent),'same.js','読み込めなかったBではなく表示中のAを選択欄に戻す');
        assert.match(await page.locator('#kt-customize-meta').innerText(),/same\.js（PC）/,'表示中のAの名前を残す');
        assert.match(await page.locator('#kt-customize-file-status').innerText(),/second\.js.*読み込めませんでした/,'Bの失敗は別の場所に表示する');
        assert.equal(await page.evaluate(()=>proposalCalls.length),callsBeforeSelection);
        await page.evaluate(()=>{window.fileFailure=null;});
        await selected(page,'second.js','// second original\n');
        await editor(page).fill('// second unsaved edit\n');
        await selected(page,'same.js','// PC unsaved edit\nconst memo = 10;\n');
        await page.locator('#kt-customize-source').selectOption('JavaScriptMobile');
        await selected(page,'same.js','// mobile original\nconst memo = 2;\n');
        await editor(page).fill('// mobile unsaved edit\n');
        // An old show(PC) request must not select the mobile file with the same name.
        await page.evaluate(()=>{window.holdNextCustomize=true;window.pendingList=null;window.pendingShow=customize.show({target:'desktop',kind:'js',name:'same.js'});});
        await page.waitForFunction(()=>typeof pendingList==='function');
        await page.locator('#kt-customize-source').selectOption('JavaScriptMobile');
        await selected(page,'same.js','// mobile unsaved edit\n');
        await page.locator('#kt-customize-consult').click();
        const mobileBefore=await page.evaluate(()=>({target:work.controller.getState().consultationTarget,calls:proposalCalls.length,reads:[...fileReads],source:document.querySelector('#kt-customize-source').value,selection:document.querySelector('#kt-customize-file').selectedOptions[0].textContent,meta:document.querySelector('#kt-customize-meta').textContent}));
        const staleShow=await page.evaluate(async()=>{pendingList();return await pendingShow;});
        assert.equal(staleShow.found,false,'古いshowの一覧は別の対象の同名ファイルを開かない');
        assert.equal(await editor(page).inputValue(),'// mobile unsaved edit\n');
        assert.deepEqual(await page.evaluate(()=>({target:work.controller.getState().consultationTarget,calls:proposalCalls.length,reads:[...fileReads],source:document.querySelector('#kt-customize-source').value,selection:document.querySelector('#kt-customize-file').selectedOptions[0].textContent,meta:document.querySelector('#kt-customize-meta').textContent})),mobileBefore,'新しく選んだモバイル本文・相談対象・AI回数を変更しない');
        await page.locator('#tab-customize').click();
        await page.locator('#kt-customize-source').selectOption('css');
        await selected(page,'style.css','.memo { color: blue; }\n');
        assert.equal(await page.locator('#kt-customize-consult').isEnabled(),false,'CSSをJavaScriptの相談対象にしない');
        await editor(page).fill('.memo { color: red; }\n');
        await page.locator('#kt-customize-source').selectOption('JavaScript');
        await selected(page,'same.js','// PC unsaved edit\nconst memo = 10;\n');
        // A late download must not overwrite a newer file selection or its draft.
        await filePicker(page).selectOption({label:'slow.js'});
        await page.waitForFunction(()=>typeof pendingFile==='function');
        await selected(page,'second.js','// second unsaved edit\n');
        await page.evaluate(()=>pendingFile());
        await page.waitForTimeout(30);
        assert.equal(await editor(page).inputValue(),'// second unsaved edit\n');
        // New unsaved files also have a stable place to return to.
        await page.locator('#kt-customize-new').click();
        await page.locator('#kt-newfile-name').fill('draft.js');
        await page.locator('#kt-newfile-ok').click();
        await editor(page).fill('// new unsaved file\n');
        const draftKey=await page.locator('#kt-customize-drafts').inputValue();
        await selected(page,'same.js','// PC unsaved edit\nconst memo = 10;\n');
        await page.locator('#kt-customize-drafts').selectOption(draftKey);
        assert.equal(await editor(page).inputValue(),'// new unsaved file\n');
        await selected(page,'same.js','// PC unsaved edit\nconst memo = 10;\n');
        await page.locator('#kt-customize-source').selectOption('JavaScriptMobile');
        await selected(page,'same.js','// mobile unsaved edit\n');
        await page.locator('#kt-customize-source').selectOption('css');
        await selected(page,'style.css','.memo { color: red; }\n');
        await page.locator('#kt-customize-source').selectOption('JavaScript');
        await selected(page,'same.js','// PC unsaved edit\nconst memo = 10;\n');
        await page.locator('#tab-ai').click();
        await page.locator('#kt-release-input').fill('送信していない修正の相談');
        const before=await page.evaluate(()=>({taskId:work.controller.getState().taskId,messages:work.controller.getState().messages,proposal:work.controller.getState().proposal,calls:proposalCalls.length}));
        await page.locator('#tab-customize').click();
        await page.locator('#kt-customize-consult').click();
        assert.equal(await page.locator('#view-ai').isVisible(),true,'AIに相談するとAI Assistantへ移る');
        assert.equal(await page.locator('#view-customize').isVisible(),false);
        assert.equal(await page.locator('.ktr-current').isVisible(),true,'相談後は通常案を表示する');
        assert.equal(await page.locator('#kt-customize-code-pane').isVisible(),false,'コードは明示的に開くまで表示しない');
        assert.equal(await page.locator('[data-release-action="code"]').innerText(),'コード・差分を見る');
        assert.equal(await page.locator('#kt-release-input').inputValue(),'送信していない修正の相談','入力途中の相談を上書きしない');
        assert.equal(await page.evaluate(()=>document.querySelector('#view-ai #kt-ai-host')===originalHost),true,'会話のDOMはAI Assistantに固定する');
        assert.equal(await page.locator('#kt-ai-host').count(),1,'会話の表示を複製しない');
        const after=await page.evaluate(()=>({taskId:work.controller.getState().taskId,messages:work.controller.getState().messages,proposal:work.controller.getState().proposal,calls:proposalCalls.length}));
        assert.deepEqual(after,before,'対象選択はAI・採用・会話の作り直しをしない');
        // beforeSend is asynchronous even while the controller itself is still idle.
        await page.evaluate(()=>CustomizeTest.KTAiClient.createSettingsStore().setConsent(false,'release-raw-source-1'));
        await page.locator('[data-release-action="send"]').click();
        await page.locator('dialog[open] [data-consent]').waitFor();
        const consentWait=await page.evaluate(()=>({target:work.controller.getState().consultationTarget,calls:proposalCalls.length,task:work.controller.getState().taskId}));
        const refused=await page.evaluate(()=>work.consult({name:'second.js',target:'desktop',type:'FILE',environment:'preview'}));
        assert.equal(refused.ok,false,'同意待ち中に相談対象を差し替えない');
        assert.deepEqual(await page.evaluate(()=>({target:work.controller.getState().consultationTarget,calls:proposalCalls.length,task:work.controller.getState().taskId})),consentWait);
        await page.locator('dialog[open] [data-close]').click();
        await page.waitForFunction(()=>work.view.canFocusConsultation());
        assert.equal((await page.evaluate(()=>work.consult({name:'second.js',target:'desktop',type:'FILE',environment:'preview'}))).ok,true,'同意待ちを閉じた後は対象を変更できる');
        assert.equal(await page.evaluate(()=>proposalCalls.length),consentWait.calls,'同意せず閉じた場合にAIを呼ばない');
        await page.evaluate(()=>{work.consult({name:'same.js',target:'desktop',type:'FILE',environment:'preview'});CustomizeTest.KTAiClient.createSettingsStore().setConsent(true,'release-raw-source-1');});
        assert.equal(await editor(page).inputValue(),'// PC unsaved edit\nconst memo = 10;\n','AI相談に手編集を差し込まない');
        assert.equal(await page.locator('#kt-customize-upload').isVisible(),false,'AIの隣で運用環境の手反映ボタンを出さない');
        await page.locator('#tab-ai').click();
        assert.equal(await page.evaluate(()=>document.querySelector('#view-ai #kt-ai-host')===originalHost),true);
        assert.equal(await page.locator('#kt-release-input').inputValue(),'送信していない修正の相談');
        assert.equal(await page.locator('#view-customize #kt-ai-host').count(),0);
        await page.locator('#tab-customize').click();
        assert.equal(await page.locator('#kt-release-input').inputValue(),'送信していない修正の相談');
        await page.screenshot({path:path.join(out,colorScheme+'-customize.png'),fullPage:true});
        await page.locator('#tab-ai').click();
        const normal=await geometry(page);
        assert.ok(normal.proposal.left>=normal.chat.right-2,'AI Assistantは左相談・右通常案');
        assert.equal(await page.locator('#kt-customize-code-pane').isVisible(),false);
        await page.screenshot({path:path.join(out,colorScheme+'-conversation.png'),fullPage:true});
        const stateBeforeCode=await page.evaluate(()=>JSON.stringify(work.controller.getState()));
        await page.evaluate(()=>{window.originalEditor=document.querySelector('#kt-customize-editor textarea[data-test-editor]');});
        await page.locator('[data-release-action="code"]').click();
        assert.equal(await page.locator('[data-release-action="code"]').innerText(),'変更案・結果を見る');
        assertHorizontal(await geometry(page),'AI Assistantでコードを開く');
        assert.equal(await widthHandle.isVisible(),false,'AI Assistantの右コード欄でCustomize用の幅ハンドルを出さない');
        assert.equal(await page.locator('.ktr-current').isVisible(),false,'コードを開いている間は通常案と重ねない');
        assert.equal(await editor(page).inputValue(),'// PC unsaved edit\nconst memo = 10;\n');
        assert.equal(await page.locator('#kt-release-input').inputValue(),'送信していない修正の相談');
        await page.evaluate(()=>work.view.render());
        assert.equal(await page.evaluate(()=>document.querySelector('#kt-customize-editor textarea[data-test-editor]')===originalEditor),true,'会話の再描画でエディターDOMを作り直さない');
        assert.equal(await editor(page).inputValue(),'// PC unsaved edit\nconst memo = 10;\n');
        await page.screenshot({path:path.join(out,colorScheme+'-code-open.png'),fullPage:true});
        // Keeping code open must not hide progress, cancellation, or an artifact's failure.
        await page.evaluate(()=>{
          window.normalGetState=work.controller.getState;
          const state=normalGetState();
          window.temporaryDisplay={...state,phase:'building',progress:'モバイルの編集制御を作成しています。'};
          work.controller.getState=()=>structuredClone(temporaryDisplay);
          work.view.render();
        });
        assert.equal(await page.locator('.ktr-current').isVisible(),false);
        assert.equal(await page.locator('.ktr-code-progress').isVisible(),true,'コード表示中も進み具合を表示する');
        assert.match(await page.locator('.ktr-code-progress').innerText(),/モバイルの編集制御を作成しています/);
        assert.equal(await page.locator('.ktr-code-progress [data-release-action="cancel"]').isVisible(),true,'コード表示中も中断操作を表示する');
        assert.equal(await page.locator('.ktr-code-progress [data-release-action="cancel"]').isEnabled(),true);
        assert.equal(await page.evaluate(()=>document.querySelector('#kt-customize-editor textarea[data-test-editor]')===originalEditor),true);
        await page.screenshot({path:path.join(out,colorScheme+'-code-progress.png'),fullPage:true});
        await page.evaluate(()=>{
          const message='モバイルの編集制御を完成できませんでした。';
          temporaryDisplay={...normalGetState(),phase:'incomplete',progress:'',error:{code:'GENERATION_INCOMPLETE',message},plan:{goal:'備考の編集制御',steps:[],customizations:[{customizationId:'C1',requirement:'モバイルの備考を編集不可にする'}]},artifacts:[{customizationId:'C1',title:'モバイルの編集制御',error:{message},result:{artifactOutcome:{state:'incomplete',message}}}]};
          work.view.render();
        });
        assert.equal(await page.locator('.ktr-current').isVisible(),false);
        assert.equal(await page.locator('.ktr-content > .ktr-error').isVisible(),true,'通常案と同じ失敗理由がコード表示中も上部に残る');
        assert.equal(await page.locator('.ktr-content > .ktr-error').innerText(),'モバイルの編集制御を完成できませんでした。');
        assert.equal(await page.locator('.ktr-code-progress').count(),0,'失敗後は処理中の表示を残さない');
        assert.equal(await editor(page).inputValue(),'// PC unsaved edit\nconst memo = 10;\n');
        assert.equal(await page.locator('#kt-release-input').inputValue(),'送信していない修正の相談');
        await page.screenshot({path:path.join(out,colorScheme+'-code-error.png'),fullPage:true});
        await page.evaluate(()=>{
          temporaryDisplay={...temporaryDisplay,error:null,artifacts:[{customizationId:'C1',title:'モバイルの編集制御',result:{artifactOutcome:{state:'failed',message:'モバイルの備考の編集制御を確認できませんでした。'}}}]};
          work.view.render();
        });
        assert.equal(await page.locator('.ktr-content > .ktr-error').count(),0);
        assert.equal(await page.locator('.ktr-code-attention').isVisible(),true,'最上位のerrorが無くても未完成を伝える');
        assert.match(await page.locator('.ktr-code-attention').innerText(),/作成が完了していません/);
        await page.locator('.ktr-code-attention [data-release-action="code"]').click();
        assert.equal(await page.locator('.ktr-current').isVisible(),true);
        assert.match(await page.locator('.ktr-current .ktr-reasons').innerText(),/モバイルの備考の編集制御を確認できませんでした/,'案に戻って生成物の不合格理由を読める');
        await page.locator('.ktr-tools [data-release-action="code"]').click();
        await page.evaluate(()=>{
          temporaryDisplay={...temporaryDisplay,phase:'blocked',artifacts:[],prepared:{ok:false,reasons:[{message:'動作テスト環境の設定が変更されています。'}]}};
          work.view.render();
        });
        assert.equal(await page.locator('.ktr-code-attention').isVisible(),true);
        assert.match(await page.locator('.ktr-code-attention').innerText(),/反映前の確認が完了していません/);
        await page.locator('.ktr-code-attention [data-release-action="code"]').click();
        assert.equal(await page.locator('.ktr-current').isVisible(),true);
        assert.match(await page.locator('.ktr-current .ktr-reasons').innerText(),/動作テスト環境の設定が変更されています/,'案に戻って反映前の停止理由を読める');
        await page.locator('.ktr-tools [data-release-action="code"]').click();

        await page.evaluate(()=>{work.controller.getState=normalGetState;work.view.render();});
        assert.equal(await page.evaluate(()=>JSON.stringify(work.controller.getState())),stateBeforeCode,'表示用の状態を元に戻す');
        assert.equal(await page.locator('.ktr-content > .ktr-error').count(),0);

        await page.locator('[data-release-action="code"]').click();
        assert.equal(await page.locator('.ktr-current').isVisible(),true);
        assert.equal(await page.locator('#kt-customize-code-pane').isVisible(),false);
        assert.equal(await page.evaluate(()=>JSON.stringify(work.controller.getState())),stateBeforeCode,'開閉だけでは会話・採用・AI呼び出しを変更しない');
        // Seed only the prepared display record. Candidate code must stay separate from hand edits.
        const prepared=await page.evaluate(()=>{
          const state=work.controller.getState();
          const changes=[
            {changeId:'C1',kind:'REPLACE_FILE',target:'desktop',name:'same.js',currentSource:'// PC original\nconst memo = 1;\n',content:'// PC AI proposal\nconst memo = 3;\n'},
            {changeId:'C2',kind:'REPLACE_FILE',target:'mobile',name:'same.js',currentSource:'// mobile original\nconst memo = 2;\n',content:'// mobile AI proposal\nconst memo = 4;\n'}
          ];
          window.displayState={...state,phase:'review',adopted:state.proposal,plan:{goal:'備考の編集条件を変更',steps:[],customizations:[]},artifacts:[],prepared:{ok:true,signature:'fixed-signature',changes:changes.map(c=>({kind:'javascript',target:c.target,file:c.name,title:'備考の編集条件',operation:c.kind})),files:{changes},confirmations:[],reasons:[]}};
          work.controller.getState=()=>structuredClone(displayState);
          work.view.render();customize.attachAssistant({...work});
          return displayState.prepared;
        });
        await page.locator('[data-release-action="code"]').click();
        await page.locator('[data-customize-mode="comparison"]').click();
        assert.equal(await page.locator('#kt-customize-comparison').isVisible(),true);
        assert.equal(await editor(page).isVisible(),true,'比較を開いても手元のコードを残す');
        const comparisonTop=await page.locator('#kt-customize-comparison').boundingBox(),editorAbove=await page.locator('#kt-customize-editor').boundingBox();
        assert.ok(comparisonTop.y>=editorAbove.y+editorAbove.height,'比較はエディターの下に開く');
        assert.equal(await page.locator('#kt-customize-upload').isVisible(),false);
        const comparison=()=>page.evaluate(()=>{const d=monacoDiffs.findLast(x=>!x.disposed);return {before:d.getModel().original.getValue(),after:d.getModel().modified.getValue(),readOnly:d.options.readOnly,originalEditable:d.options.originalEditable};});
        assert.deepEqual(await comparison(),{before:prepared.files.changes[0].currentSource,after:prepared.files.changes[0].content,readOnly:true,originalEditable:false});
        await page.locator('[data-comparison-file]').selectOption({index:1});
        assert.deepEqual(await comparison(),{before:prepared.files.changes[1].currentSource,after:prepared.files.changes[1].content,readOnly:true,originalEditable:false});
        assert.match(await page.locator('#kt-customize-meta').innerText(),/same\.js（PC）/,'上の手元のコードはPCのまま');
        assert.match(await page.locator('[data-comparison-file]').evaluate(el=>el.selectedOptions[0].textContent),/モバイル.*same\.js/,'下の比較対象のモバイルを明示する');
        assert.match(await page.locator('[data-comparison-note]').innerText(),/手元の編集/,'上下を現在の手編集との差分と誤解させない');
        await page.locator('[data-customize-mode="comparison"]').click();
        assert.equal(await page.locator('#kt-customize-comparison').isVisible(),false,'比較のボタンでも下側を閉じられる');
        assert.equal(await page.evaluate(()=>document.querySelector('#kt-customize-editor textarea[data-test-editor]')===originalEditor),true);
        assert.equal(await editor(page).inputValue(),'// PC unsaved edit\nconst memo = 10;\n');
        await page.locator('[data-customize-mode="comparison"]').click();
        assert.equal(await page.locator('#kt-customize-comparison').isVisible(),true);
        assert.deepEqual(await comparison(),{before:prepared.files.changes[1].currentSource,after:prepared.files.changes[1].content,readOnly:true,originalEditable:false});
        const stateBeforeTabs=await page.evaluate(()=>JSON.stringify({adopted:work.controller.getState().adopted,prepared:work.controller.getState().prepared,runs:work.controller.getState().runs}));
        await page.locator('#tab-customize').click();
        assert.equal(await page.locator('#view-customize #kt-customize-code-pane').count(),1,'Customizeへ戻るとコードを元の場所へ戻す');
        assert.equal(await page.locator('#view-customize #kt-ai-host').count(),0);
        assert.equal(await widthHandle.isVisible(),true,'Customizeへ戻すと幅調整を戻す');
        assert.ok(Math.abs((await editorCssHeight(page))-440)<=2,'表示場所を変えても調整した高さを保つ');
        await page.screenshot({path:path.join(out,colorScheme+'-customize-comparison-below.png'),fullPage:true});
        await page.locator('#tab-ai').click();
        assert.equal(await page.locator('#kt-customize-code-pane').isVisible(),false,'AIタブへ戻るだけではコードを開かない');
        await page.locator('[data-release-action="code"]').click();
        assert.equal(await page.evaluate(()=>JSON.stringify({adopted:work.controller.getState().adopted,prepared:work.controller.getState().prepared,runs:work.controller.getState().runs})),stateBeforeTabs);
        assert.equal(await editor(page).inputValue(),'// PC unsaved edit\nconst memo = 10;\n');
        assert.equal(await page.locator('#kt-release-input').inputValue(),'送信していない修正の相談');
        await page.screenshot({path:path.join(out,colorScheme+'-comparison.png'),fullPage:true});
        await page.evaluate(()=>{
          const prepared=displayState.prepared;
          const prior=structuredClone(prepared);
          prior.files.changes=[{changeId:'old-C1',kind:'REPLACE_FILE',target:'desktop',name:'prior.js',currentSource:'// earlier before\n',content:'// earlier after\n'}];
          prior.changes=[{kind:'javascript',target:'desktop',file:'prior.js',title:'前の反映内容',operation:'REPLACE_FILE'}];
          displayState={...displayState,phase:'result',prepared:null,resultRunId:'run-1',runs:[
            {id:'run-0',taskId:0,status:'complete',goal:'前の反映内容',prepared:prior,result:{status:'complete',written:1,message:'以前の内容を反映しました。',rows:[]}},
            {id:'run-1',taskId:displayState.taskId,status:'complete',goal:'備考の編集条件',prepared,result:{status:'complete',written:2,message:'動作テスト環境に反映しました。',rows:[]}}
          ]};
          work.view.render();customize.attachAssistant({...work});
        });
        assert.match(await page.locator('[data-comparison-note]').innerText(),/この反映の記録/);
        await page.locator('[data-release-action="code"]').click();
        assert.match(await page.locator('.ktr-current').innerText(),/動作テスト環境に反映しました/);
        await page.locator('[data-release-panel="runs"] > summary').click();
        await page.locator('[data-release-action="history"][data-release-id="run-0"]').click();
        assert.match(await page.locator('.ktr-current').innerText(),/以前の内容を反映しました/);
        await page.locator('[data-release-action="code"]').click();
        assert.deepEqual(await comparison(),{before:'// earlier before\n',after:'// earlier after\n',readOnly:true,originalEditable:false},'過去の反映を選ぶと左右とも同じ記録になる');
        assert.equal(await page.evaluate(()=>work.view.getSelectedRunId()),'run-0');
        await page.locator('[data-release-action="code"]').click();
        assert.match(await page.locator('.ktr-current').innerText(),/以前の内容を反映しました/,'閉じると選択していた反映結果へ戻る');
        await page.locator('[data-release-action="history"][data-release-id="run-1"]').click();
        assert.match(await page.locator('.ktr-current').innerText(),/動作テスト環境に反映しました/);
        await page.locator('[data-release-action="code"]').click();
        assert.deepEqual(await comparison(),{before:prepared.files.changes[0].currentSource,after:prepared.files.changes[0].content,readOnly:true,originalEditable:false});
        await page.locator('[data-release-action="code"]').click();
        await page.locator('[data-release-action="current"]').click();
        await page.locator('[data-release-action="code"]').click();
        assert.equal(await page.evaluate(()=>work.view.getSelectedRunId()),null);
        assert.deepEqual(await comparison(),{before:prepared.files.changes[0].currentSource,after:prepared.files.changes[0].content,readOnly:true,originalEditable:false});
        const runBefore=await page.evaluate(()=>JSON.stringify(work.controller.getState().runs));
        await page.locator('[data-release-action="code"]').click();
        assert.match(await page.locator('.ktr-current').innerText(),/動作テスト環境に反映しました/);
        await page.locator('#tab-customize').click();
        await page.locator('#tab-ai').click();
        assert.match(await page.locator('.ktr-current').innerText(),/動作テスト環境に反映しました/);
        await page.locator('[data-release-action="code"]').click();
        assert.equal(await page.evaluate(()=>JSON.stringify(work.controller.getState().runs)),runBefore,'タブ移動は反映結果を作り直さない');
        assert.deepEqual(await comparison(),{before:prepared.files.changes[0].currentSource,after:prepared.files.changes[0].content,readOnly:true,originalEditable:false});
        await page.locator('[data-customize-mode="editor"]').click();
        assert.equal(await editor(page).isVisible(),true);
        assert.equal(await editor(page).inputValue(),'// PC unsaved edit\nconst memo = 10;\n');
        await page.locator('#kt-full').click();
        assertHorizontal(await geometry(page),'1440px画面のパネル');
        // Simulate a narrower host panel while keeping the browser viewport wide.
        await page.evaluate(()=>document.querySelector('#kt-toolkit').style.width='760px');
        assertVertical(await geometry(page),'760px幅のパネル');
        assert.equal(await editor(page).inputValue(),'// PC unsaved edit\nconst memo = 10;\n');
        assert.equal(await page.locator('#kt-release-input').inputValue(),'送信していない修正の相談');
        await page.screenshot({path:path.join(out,colorScheme+'-panel.png'),fullPage:true});
        await page.locator('#kt-full').click();
        await page.setViewportSize({width:430,height:932});
        const narrowGeometry=await geometry(page);
        assert.ok(narrowGeometry.shell.right<=narrowGeometry.viewport+1,'狭い画面で外枠がはみ出さない');
        assertVertical(narrowGeometry,'430px全画面');
        assert.ok(await page.locator('.ktr-chat-log').evaluate(el=>el.clientHeight)>=120,'狭い画面で相談履歴の高さを潰さない');
        await page.locator('.ktr-conversation [data-release-action=send]').click({trial:true});
        await page.screenshot({path:path.join(out,colorScheme+'-narrow.png'),fullPage:true});
        await page.locator('[data-customize-mode="comparison"]').scrollIntoViewIfNeeded();
        await page.locator('[data-customize-mode="comparison"]').click();
        await page.locator('[data-comparison-mode="after"]').click();
        assert.equal(await page.locator('[data-comparison-editor] textarea').inputValue(),prepared.files.changes[0].content);
        assert.equal(await page.locator('[data-comparison-editor] textarea').evaluate(el=>el.readOnly),true);
        await page.screenshot({path:path.join(out,colorScheme+'-narrow-code.png'),fullPage:true});
        await page.locator('[data-release-action="code"]').click();
        assert.equal(await page.locator('.ktr-current').isVisible(),true);
        assert.equal(await page.locator('#kt-customize-code-pane').isVisible(),false);
        await page.screenshot({path:path.join(out,colorScheme+'-narrow-proposal.png'),fullPage:true});
        await page.locator('#tab-customize').click();
        await page.locator('[data-customize-mode="editor"]').click();
        const narrowCustomize=await geometry(page);
        assert.ok(narrowCustomize.editor.top>=narrowCustomize.menu.bottom,'狭い表示ではMenuとエディターを縦に並べる');
        assert.equal(await widthHandle.isVisible(),false,'狭い表示は幅調整なしで縦に並べる');
        assert.equal(await heightHandle.isVisible(),true,'狭い表示でも高さを調整できる');
        await heightHandle.press('ArrowUp');assert.ok(Math.abs((await editorCssHeight(page))-420)<=2);
        await heightHandle.press('ArrowDown');assert.ok(Math.abs((await editorCssHeight(page))-440)<=2);
        assert.equal(await page.locator('.kt-customize-menu').evaluate(el=>el.scrollHeight<=el.clientHeight+1),true,'Menu内の説明と最後の操作を枠内に収める');
        assert.ok((await page.locator('#kt-customize-manual-actions').boundingBox()).y+(await page.locator('#kt-customize-manual-actions').boundingBox()).height<=narrowCustomize.menu.bottom,'末尾の操作をエディターへ重ねない');
        assert.ok(narrowCustomize.editor.width>=350,'狭い表示でもエディター幅を確保する');
        assert.ok(narrowCustomize.documentWidth<=narrowCustomize.viewport+1,'CustomizeのMenuで横はみ出しを増やさない');
        assert.equal(await editor(page).inputValue(),'// PC unsaved edit\nconst memo = 10;\n');
        await page.screenshot({path:path.join(out,colorScheme+'-customize-narrow.png'),fullPage:true});
        const beforeReferenceStale=await page.evaluate(()=>({ai:proposalCalls.length,reads:fileReads.length,scan:[...scanCalls]}));
        await page.evaluate(()=>customize.markStale());
        assert.match(await reference.innerText(),/未確認/);assert.match(await reference.innerText(),/設定が変わったため、解析結果を確認できていません/);
        assert.match(await reference.innerText(),/手元の編集中のコードは解析していません/);
        assert.doesNotMatch(await reference.innerText(),/備考|app\.record\.edit\.show/,'古い印が付いた解析結果を残さない');
        assert.equal(await editor(page).inputValue(),'// PC unsaved edit\nconst memo = 10;\n','参照情報が未確認でも下書きを消さない');
        assert.deepEqual(await page.evaluate(()=>({ai:proposalCalls.length,reads:fileReads.length,scan:[...scanCalls]})),beforeReferenceStale,'古い参照情報を隠すだけで再取得・解析・AIを呼ばない');
        assert.equal(await page.evaluate(()=>proposalCalls.length),callsBeforeSelection,'相談への移動とコード開閉だけではAIを呼ばない');
        assert.deepEqual(await page.evaluate(()=>operations),[],'有料機能とkintoneの書き込みは呼ばない');
        assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
        await page.evaluate(()=>work.dispose());
      }finally{await context.close();}
    });
  }finally{await browser.close();}
});
