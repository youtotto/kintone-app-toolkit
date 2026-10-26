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
    window.operations = []; window.manualChanges = []; window.fileReads = []; window.pendingFile = null; window.fileFailure = null; window.holdNextCustomize = false; window.pendingList = null;
    const denied = name => () => { operations.push(name); throw Error('Forbidden in local browser test: ' + name); };
    const file = (name, fileKey) => ({type:'FILE', file:{name,fileKey,size:'40'}});
    const customize = {revision:'7',scope:'ALL',desktop:{js:[file('same.js','pc'),file('second.js','second'),file('slow.js','slow')],css:[file('style.css','css')]},mobile:{js:[file('same.js','mobile')],css:[]}};
    let production=clone(customize);
    const sources = {pc:'// PC original\nconst memo = 1;\n',mobile:'// mobile original\nconst memo = 2;\n',second:'// second original\n',slow:'// slow original\n',css:'.memo { color: blue; }\n'};
    window.addRegisteredFiles = count => { for(let i=0;i<count;i++){const key='extra-'+i;customize.desktop.js.push(file(key+'.js',key));production.desktop.js.push(file(key+'.js',key));sources[key]='// extra registered file '+i+'\n';} };
    T.KTApi.getCustomize = async (_app, options) => { const result={source:options?.preferPreview === false ? 'prod' : 'preview',data:clone(options?.preferPreview === false ? production : customize)}; if(window.holdNextCustomize&&result.source==='preview'){window.holdNextCustomize=false;return new Promise(resolve=>{window.pendingList=()=>resolve(result);});} return result; };
    T.KTApi.downloadFile = async key => { fileReads.push(key); if(key===window.fileFailure)throw Error('Fixture download failure'); if(key === 'slow')return new Promise(resolve => {window.pendingFile=()=>resolve(sources.slow);}); return sources[key]; };
    window.actualDeploy=T.KTApi.deploy;
    for(const method of ['uploadFile','putPreviewCustomize','deploy','waitDeploy','deployAndWait'])T.KTApi[method]=denied('kintone.'+method);
    window.manualFixtures={customize,sources};
    window.enableManualWrites=()=>{
      let sequence=0;const uploaded=new Map();
      T.KTApi.uploadFile=async(name,content)=>{operations.push({type:'upload',name,content});const key='upload-'+(++sequence);sources[key]=content;uploaded.set(key,{name,fileKey:key,size:String(content.length)});if(window.holdUpload){window.holdUpload=false;await new Promise(resolve=>{window.finishUpload=resolve;});}return key;};
      T.KTApi.putPreviewCustomize=async(app,payload)=>{operations.push({type:'put',app,payload:clone(payload)});if(String(payload.revision)!==customize.revision)throw Error('Revision mismatch');const known=new Map([...uploaded]);for(const target of ['desktop','mobile'])for(const kind of ['js','css'])for(const item of customize[target][kind])if(item.type==='FILE')known.set(item.file.fileKey,item.file);for(const target of ['desktop','mobile'])for(const kind of ['js','css'])customize[target][kind]=payload[target][kind].map(item=>item.type==='URL'?clone(item):{type:'FILE',file:clone(known.get(item.file.fileKey))});customize.scope=payload.scope;customize.revision=String(Number(customize.revision)+1);if(window.failNextRegistrationReadback){window.failNextRegistrationReadback=false;window.fileFailure='upload-'+sequence;}return {revision:customize.revision};};
      T.KTApi.deploy=async(app,options)=>{operations.push({type:'deploy',app,options});if(String(options.revision)!==customize.revision)throw Error('Revision mismatch');production=clone(customize);};
      T.KTApi.waitDeploy=async()=>{operations.push({type:'waitDeploy'});return 'SUCCESS';};
    };
    window.monacoModels=[]; window.monacoEditors=[]; window.monacoDiffs=[];
    const createModel = (value,language) => {
      const model={text:String(value),language,disposed:false,listeners:new Set(),getValue(){return this.text;},getValueInRange(range){return range.testText||'';},getLineContent(lineNumber){return this.text.split(/\r?\n/)[lineNumber-1]||'';},getWordAtPosition(position){if(this.testWord!=null)return {word:this.testWord};const offset=position.column-1;const word=[...this.getLineContent(position.lineNumber).matchAll(/[$\p{L}\p{N}_]+/gu)].find(match=>match.index<=offset&&offset<=match.index+match[0].length);return word?{word:word[0]}:null;},setValue(text){this.text=String(text);for(const listener of this.listeners)listener();},dispose(){this.disposed=true;this.listeners.clear();},onDidChangeContent(listener){this.listeners.add(listener);return {dispose:()=>this.listeners.delete(listener)};}};
      monacoModels.push(model); return model;
    };
    const createEditor = (host, options={}) => {
      const area=document.createElement('textarea');area.dataset.testEditor='true';area.style.cssText='width:100%;height:100%;box-sizing:border-box;font:13px monospace';host.appendChild(area);
      let model=options.model||createModel(options.value||'',options.language),off=null;
      const listeners=new Set(),cursorListeners=new Set();
      const attach=()=>{off?.dispose();off=model.onDidChangeContent(()=>{area.value=model.getValue();for(const listener of listeners)listener();});area.value=model.getValue();};attach();
      area.readOnly=!!options.readOnly;area.addEventListener('input',()=>model.setValue(area.value));
      const editor={host,area,disposed:false,getValue:()=>model.getValue(),setValue:value=>model.setValue(value),getModel:()=>model,setModel(value){model=value;attach();},onDidChangeModelContent(listener){listeners.add(listener);return {dispose:()=>listeners.delete(listener)};},saveViewState:()=>({selection:[area.selectionStart,area.selectionEnd],top:area.scrollTop}),restoreViewState(saved){if(saved?.selection)area.setSelectionRange(...saved.selection);if(saved)area.scrollTop=saved.top;},getPosition:()=>editor.testPosition||({lineNumber:1,column:1}),getSelection:()=>editor.testSelection||{isEmpty:()=>true},onDidChangeCursorSelection(listener){cursorListeners.add(listener);return {dispose:()=>cursorListeners.delete(listener)};},setTestCursor(word,text=''){model.testWord=word;editor.testPosition=null;editor.testSelection={isEmpty:()=>!text,testText:text};for(const listener of cursorListeners)listener();},setTestSelection(text){editor.testSelection={isEmpty:()=>!text,testText:text};for(const listener of cursorListeners)listener();},setTestCaret(lineNumber,column){delete model.testWord;editor.testPosition={lineNumber,column};editor.testSelection={isEmpty:()=>true};const lines=model.getValue().split('\n'),offset=lines.slice(0,lineNumber-1).reduce((sum,line)=>sum+line.length+1,0)+column-1;area.setSelectionRange(offset,offset);for(const listener of cursorListeners)listener();},cursorListenerCount:()=>cursorListeners.size,setPosition(){},updateOptions(value){if('readOnly' in value)area.readOnly=value.readOnly;},focus:()=>area.focus(),layout(){},dispose(){off?.dispose();editor.disposed=true;area.remove();}};
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
    base.files.forEach(file=>file.env='preview');
    window.dependencyBase=base;window.baseReads=0;window.pendingDependency=null;window.holdDependency=false;window.dependencyFailure=false;window.dependencyContinue=null;
    T.KTDevBase.loadForRelease=async(options={})=>{window.dependencyContinue=options.shouldContinue;baseReads++;const result=clone(dependencyBase);if(dependencyFailure)throw Error('Dependency fixture failure');if(holdDependency){holdDependency=false;return new Promise(resolve=>{pendingDependency=()=>resolve(result);});}return result;};
    const health={ok:true,supportedContractVersions:[C.CONTRACT_VERSION],entitlements:[{product:C.PRODUCT,features:[C.FEATURE,C.FEATURE_PLANNER]}],registry:{[C.PRODUCT]:{
      [C.FEATURE]:{implemented:true,promptVersions:[C.PROMPT_VERSION],conversation:[...C.CONVERSATION_MARKS,'releaseWorkspace','appExplanation']},
      [C.FEATURE_PLANNER]:{implemented:true,promptVersions:[C.PLANNER_PROMPT_VERSION],...C.PLANNER_MARKS,requirementOps:[...C.PLANNER_MARKS.requirementOps,'releaseWorkspace','formLayoutPlacement','fieldMaintenance']}
    }}};
    window.proposalCalls=[];
    const client={getHealth:async()=>health,propose:async({ctx})=>{proposalCalls.push(clone(ctx));return {reply:'備考の編集条件を変更する案です。',intent:'propose',proposal:{behaviors:[{id:'B1',text:'備考の編集条件を変更する',origin:'user'}],assumptions:[],decisions:[],approach:{standard:[],js:['備考の編集条件']},cannot:[]},turn:{ops:[],answers:[],requirementOps:[]}};},plan:denied('AI.plan'),generate:denied('AI.generate')};
    window.fixtureClient=client;
    localStorage.setItem('ktToolkitFull.v1','1');
    const shell=window.shell=T.mountRoot();
    const settings=C.createSettingsStore();settings.setConsent(true,'release-raw-source-1');
    const session={client,status:()=>({connected:true,apiBase:'https://gateway.test.invalid'}),disconnect:async()=>{}};
    window.work=T.renderAiWorkspace(shell,data,'310',{getContextInputs:()=>({data,deps:{},scan:{files:[]}}),aiLink:{settings,session,probe:async()=>({ok:true,health})}});
    shell.ktAi=work;
    window.customize=T.renderCustomize(shell,data,'310',{autoLoad:true,getInputs:()=>({data,deps:{},scan:window.referenceScan}),onSettingsChanged:info=>manualChanges.push(clone(info)),consult:seed=>work.consult(seed)});
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
async function geometry(page){return page.evaluate(async()=>{
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
  return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,shell:rect('#kt-toolkit'),ai:rect('#kt-ai-host'),chat:rect('#kt-ai-host .ktr-conversation'),code:rect('#kt-customize-code-pane'),codeSlot:rect('.ktr-code-slot'),proposal:rect('#kt-ai-host .ktr-current'),editor:rect('#kt-customize-editor'),menu:rect('.kt-customize-menu'),home:rect('#kt-customize-workspace')};
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
        const menuDensity=await page.evaluate(()=>{const menu=document.querySelector('.kt-customize-menu').getBoundingClientRect(),deps=document.querySelector('#kt-customize-dependencies');return {upperHeight:Math.round(deps.getBoundingClientRect().top-menu.top),dependencyFont:getComputedStyle(deps).fontSize,pickerHeight:Math.round(document.querySelector('#kt-customize-picker').getBoundingClientRect().height)};});
        t.diagnostic(colorScheme+' Customize menu: '+JSON.stringify(menuDensity));
        assert.ok(menuDensity.upperHeight<=145,'操作と選択欄の占有高さを旧304pxから半分以下にし、依存領域を上へ出す');
        assert.equal(menuDensity.dependencyFont,'12px','依存情報の文字を縮めずMenu側を圧縮する');
        assert.ok(menuDensity.pickerHeight<=42,'操作の高さを確保し、十分な幅では種類・ファイル・更新を1行にまとめる');
        assert.equal(await page.locator('.kt-customize-files h3').count(),0,'選択欄と重なるファイル見出しを繰り返さない');
        assert.equal(await page.locator('#view-customize #kt-ai-host').count(),0,'Customizeにチャットを複製しない');
        assert.equal(await page.locator('#kt-release-input').isVisible(),false,'Customizeは編集に集中する');
        const initialShare=initialGeometry.editor.width/(initialGeometry.editor.width+initialGeometry.menu.width);
        assert.ok(initialShare>=.60&&initialShare<=.70,'左は約65%、右は参照情報を読める幅にする');
        assert.ok(initialGeometry.menu.left>=initialGeometry.editor.right+6,'Menuはエディターの右に置く');
        assert.ok(initialGeometry.menu.width>=280,'Menuの操作と参照情報に幅を残す');
        assert.ok(initialGeometry.editor.height>600,'短いコードでも利用可能な縦領域を使う');
        assert.ok(Math.abs(initialGeometry.editor.bottom-initialGeometry.home.bottom)<=3,'エディターはCustomize領域の下端まで伸びる');
        assert.equal(await page.locator('#kt-customize-height-resize').count(),0,'高さ調整は不要で幅調整だけを残す');
        await page.screenshot({path:path.join(out,colorScheme+'-customize-menu.png'),fullPage:true});
        assert.ok(initialGeometry.code.right<=initialGeometry.shell.right+1,'Customizeのコードは枠内に収まる');
        assert.equal(await page.locator('.kt-customize-editor-heading #kt-customize-consult').count(),1,'相談はエディターの見出しに置く');
        assert.equal(await page.locator('.kt-customize-menu > section').first().getAttribute('aria-label'),'保存と反映','右上に保存・登録・運用反映をまとめる');
        assert.equal(await page.locator('#kt-customize-register').isVisible(),true);
        assert.equal(await page.locator('#kt-customize-deploy').isVisible(),true);
        assert.equal(await page.locator('#kt-customize-upload').count(),0,'旧い登録と運用反映の一括操作は戻さない');
        assert.equal(await page.locator('[data-customize-mode="comparison"]').isVisible(),false,'CustomizeにAIの差分操作を出さない');
        const callsBeforeSelection=await page.evaluate(()=>proposalCalls.length);
        const reference=page.locator('#kt-customize-reference-info [data-reference-content]');
        assert.equal(await reference.isVisible(),false,'登録済みコードの参照情報は必要時だけ開く');
        await page.locator('#kt-customize-reference-info > summary').click();
        assert.equal(await reference.isVisible(),true);
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
        const widthHandle=page.locator('#kt-customize-width-resize');
        assert.equal(await widthHandle.getAttribute('role'),'separator');assert.equal(await widthHandle.getAttribute('aria-orientation'),'vertical');
        assert.equal(await widthHandle.getAttribute('aria-valuemin'),'45');assert.equal(await widthHandle.getAttribute('aria-valuemax'),'80');
        assert.ok(Number(await widthHandle.getAttribute('tabindex'))>=0,'幅調整をキーボードでも選べる');
        const startWidth=Number(await widthHandle.getAttribute('aria-valuenow'));
        await widthHandle.press('ArrowRight');assert.equal(Number(await widthHandle.getAttribute('aria-valuenow')),startWidth+2);
        await widthHandle.press('ArrowLeft');assert.equal(Number(await widthHandle.getAttribute('aria-valuenow')),startWidth);
        await dragBy(page,widthHandle,70,0);assert.ok((await geometry(page)).editor.width>initialGeometry.editor.width+30,'ドラッグで左の幅が広がる');
        await widthHandle.press('End');await widthHandle.press('ArrowRight');assert.equal(await widthHandle.getAttribute('aria-valuenow'),'80','右へ動かし続けても幅の上限を越えない');
        assert.ok((await geometry(page)).menu.width>=270,'幅を広げてもMenuを潰さない');
        await widthHandle.press('Home');await widthHandle.press('ArrowLeft');assert.equal(await widthHandle.getAttribute('aria-valuenow'),'45','幅の下限を越えない');
        for(let i=0;i<10;i++)await widthHandle.press('ArrowRight');
        const widthReset=await geometry(page);assert.ok(Math.abs(widthReset.editor.width-initialGeometry.editor.width)<=3,'65%へ戻せる');
        await page.setViewportSize({width:1440,height:720});
        const shorterGeometry=await geometry(page);
        assert.ok(shorterGeometry.editor.height<initialGeometry.editor.height-100,'画面が低くなったらエディターも追従する');
        assert.ok(Math.abs(shorterGeometry.editor.bottom-shorterGeometry.home.bottom)<=3,'低い画面でも下端まで使う');
        await page.locator('#kt-full').click();
        const panelGeometry=await geometry(page);
        assert.ok(Math.abs(panelGeometry.editor.bottom-panelGeometry.home.bottom)<=3,'通常パネルでも利用可能な高さを使う');
        await page.locator('#kt-full').click();
        await page.setViewportSize({width:1440,height:960});
        await page.waitForFunction(()=>Math.abs(document.querySelector('#kt-toolkit').getBoundingClientRect().height-innerHeight)<=1);
        const restoredGeometry=await geometry(page);
        assert.ok(Math.abs(restoredGeometry.editor.height-initialGeometry.editor.height)<=3,'元の画面サイズに戻ると高さも戻る');
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
        assert.equal(await page.locator('#kt-customize-upload').count(),0,'AIの隣で運用環境の手反映ボタンを出さない');
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
        assert.equal(await page.locator('#kt-customize-upload').count(),0);
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
        const returnedGeometry=await geometry(page);
        assert.ok(Math.abs(returnedGeometry.editor.bottom-returnedGeometry.home.bottom)<=3,'AI Assistantから戻ると利用可能高さへ戻る');
        assert.equal(await page.locator('[data-customize-mode="comparison"]').isVisible(),false,'Customizeへ戻るとAI差分の操作を隠す');
        assert.equal(await page.locator('#kt-customize-comparison').isVisible(),false,'CustomizeへAI差分を持ち出さない');
        assert.equal(await editor(page).inputValue(),'// PC unsaved edit\nconst memo = 10;\n','差分を隠しても手編集を保持する');
        await page.screenshot({path:path.join(out,colorScheme+'-customize-editor-only.png'),fullPage:true});
        await page.locator('#tab-ai').click();
        assert.equal(await page.locator('#kt-customize-code-pane').isVisible(),false,'AIタブへ戻るだけではコードを開かない');
        await page.locator('[data-release-action="code"]').click();
        assert.equal(await page.evaluate(()=>JSON.stringify({adopted:work.controller.getState().adopted,prepared:work.controller.getState().prepared,runs:work.controller.getState().runs})),stateBeforeTabs);
        assert.equal(await editor(page).inputValue(),'// PC unsaved edit\nconst memo = 10;\n');
        assert.equal(await page.locator('#kt-release-input').inputValue(),'送信していない修正の相談');
        assert.equal(await page.locator('#kt-customize-comparison').isVisible(),true,'AI Assistantで開き直すと差分表示を戻す');
        assert.deepEqual(await comparison(),{before:prepared.files.changes[1].currentSource,after:prepared.files.changes[1].content,readOnly:true,originalEditable:false},'戻る前の比較対象を保持する');
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
        assert.equal(await page.locator('[data-customize-mode="editor"]').isVisible(),false);
        const narrowCustomize=await geometry(page);
        assert.ok(narrowCustomize.editor.top>=narrowCustomize.menu.bottom,'狭い表示ではMenuとエディターを縦に並べる');
        assert.equal(await widthHandle.isVisible(),false,'狭い表示は幅調整なしで縦に並べる');
        assert.equal(await page.locator('.kt-customize-menu').evaluate(el=>el.scrollHeight<=el.clientHeight+1),true,'Menu内の説明と最後の操作を枠内に収める');
        assert.ok((await page.locator('#kt-customize-file-details').boundingBox()).y+(await page.locator('#kt-customize-file-details').boundingBox()).height<=narrowCustomize.menu.bottom,'末尾の情報をエディターへ重ねない');
        assert.ok(narrowCustomize.editor.width>=350,'狭い表示でもエディター幅を確保する');
        assert.ok(narrowCustomize.editor.height>=220,'Menuが上に並ぶ狭い表示でもエディターを潰さない');
        assert.ok(narrowCustomize.documentWidth<=narrowCustomize.viewport+1,'CustomizeのMenuで横はみ出しを増やさない');
        assert.equal(await page.locator('.kt-customize-actionbar').evaluate(el=>[...el.querySelectorAll('button')].every(button=>button.getBoundingClientRect().right<=el.getBoundingClientRect().right+1&&button.scrollWidth<=button.clientWidth+1)),true,'狭幅でも操作は折り返し、環境を示す名前を切らない');
        assert.equal(await page.locator('#kt-customize-picker').evaluate(el=>[...el.querySelectorAll('select,button')].every(control=>control.getBoundingClientRect().right<=el.getBoundingClientRect().right+1)),true,'種類とファイル選択は狭幅でもはみ出さない');
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

test('Customizeの依存関係は自動取得して再利用し、コードの選択は登録基準だけを参照する（外部通信なし）',{timeout:60000},async()=>{
  const browser=await playwright().chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
  try{for(const colorScheme of ['light','dark']){
  const context=await browser.newContext({viewport:{width:1440,height:960},colorScheme,serviceWorkers:'block'}),errors=[],unexpected=[];
  try{
    await context.route('**/*',route=>{const url=route.request().url();if(url==='https://customize.test.invalid/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%}</style><body></body></html>'});if(url.startsWith('https://www.google.com/s2/favicons?'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg"/>'});unexpected.push(url);return route.abort();});
    const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
    await page.goto('https://customize.test.invalid/');await page.addScriptTag({content:bundle()});await mount(page);
    const field=page.locator('#kt-customize-field'),content=page.locator('#kt-customize-dependency-content'),status=page.locator('#kt-customize-dependency-status'),refresh=page.locator('#kt-customize-dependency-refresh');
    assert.equal(await field.isDisabled(),true);const initialBaseReads=await page.evaluate(()=>baseReads);assert.equal(initialBaseReads,1,'会話開始時の取得以外を増やさない');
    await page.evaluate(()=>{dependencyBase.data.fields.show={code:'show',label:'表示',type:'SINGLE_LINE_TEXT'};dependencyBase.data.fields.税_番号={code:'税_番号',label:'税の番号',type:'SINGLE_LINE_TEXT'};dependencyBase.data.fields.items={code:'items',label:'明細',type:'SUBTABLE',fields:{qty:{code:'qty',label:'数量',type:'NUMBER'}}};dependencyBase.data.fields.summary={code:'summary',label:'備考の確認',type:'SINGLE_LINE_TEXT',expression:'IF(memo="","未入力","入力済み")'};dependencyBase.files.find(f=>f.name==='second.js').text="kintone.events.on('app.record.edit.show', event => { event.record.memo.value = 'x'; return event; });";dependencyBase.files.find(f=>f.name==='same.js'&&f.target==='desktop').text="kintone.events.on(['app.record.edit.show','app.record.edit.change.memo'], event => { event.record.memo.value = 'pc'; return event; });";dependencyBase.files.find(f=>f.name==='same.js'&&f.target==='mobile').text="kintone.events.on('mobile.app.record.edit.show', event => { event.record.memo.value = 'mobile'; return event; });";});
    const aiBefore=await page.evaluate(()=>proposalCalls.length);await selected(page,'same.js','// PC original\nconst memo = 1;\n');await assertEventually(()=>field.isDisabled(),false);
    assert.equal(await page.evaluate(()=>baseReads),initialBaseReads+1,'ファイルを開くと更新ボタンを押さずに依存関係を取得する');assert.match(await status.innerText(),/動作テスト環境/);
    await field.selectOption('memo');assert.match(await content.innerText(),/備考/);assert.match(await content.innerText(),/second\.js/);assert.match(await content.innerText(),/備考の確認/);
    const counts=await page.evaluate(()=>({base:baseReads,files:fileReads.length,scan:[...scanCalls],ai:proposalCalls.length,writes:[...operations]}));
    const eventMode=page.locator('[data-dependency-kind="event"]'),fieldMode=page.locator('[data-dependency-kind="field"]');
    await eventMode.click();assert.equal(await eventMode.getAttribute('aria-pressed'),'true');assert.equal(await field.getAttribute('aria-label'),'依存関係を確認するイベント');
    await field.selectOption('app.record.edit.show');assert.match(await content.innerText(),/same\.js/);assert.match(await content.innerText(),/second\.js/);assert.doesNotMatch(await content.innerText(),/モバイル|行目/,'PCイベントへモバイルや推定した行番号を混ぜない');
    await page.screenshot({path:path.join(out,colorScheme+'-dependency-event.png'),fullPage:true});
    await field.selectOption('mobile.app.record.edit.show');assert.match(await content.innerText(),/モバイル/);assert.doesNotMatch(await content.innerText(),/second\.js/);
    await page.evaluate(()=>monacoEditors[0].setTestCursor('app','app.record.edit.show'));assert.equal(await field.inputValue(),'app.record.edit.show','完全選択した既存のイベント名へ追従する');
    await page.evaluate(()=>monacoEditors[0].setTestCursor('record.edit.show','record.edit.show'));assert.equal(await field.inputValue(),'app.record.edit.show','イベント名を部分一致で推定しない');
    await fieldMode.click();assert.equal(await field.inputValue(),'memo','フィールドへ戻ると前のフィールド選択を保つ');
    await page.evaluate(()=>monacoEditors[0].setTestCursor('app','app.record.edit.show'));assert.equal(await eventMode.getAttribute('aria-pressed'),'true','コードのイベント選択で同じ依存領域をイベント表示へ切り替える');
    assert.deepEqual(await page.evaluate(()=>({base:baseReads,files:fileReads.length,scan:[...scanCalls],ai:proposalCalls.length,writes:[...operations]})),counts,'イベントの選択も取得・解析・AI・書き込みを増やさない');
    const eventDraft = [
      "const events = ['app.record.edit.show', \"mobile.app.record.edit.show\"];",
      "const later = 'app.record.edit.show';",
      "const unknown = ['app.record.edit.unknown', 'other.app.record.edit.show', 'app.record.edit.show.more'];",
      "const memo = '';",
      'const template = '+String.fromCharCode(96)+'app.record.edit.show'+String.fromCharCode(96)+';',
      "const unrelated = 1;",
      "const change = 'app.record.edit.change.memo';"
    ].join('\n');
    await editor(page).fill(eventDraft);await fieldMode.click();await field.selectOption('memo');
    const caretAt=async(line,text,inside)=>page.evaluate(({line,text,inside})=>{const model=monacoEditors[0].getModel(),content=model.getLineContent(line);const start=content.indexOf(text);if(start<0)throw Error('Missing caret fixture');monacoEditors[0].setTestCaret(line,start+inside+1);},{line,text,inside});
    await caretAt(1,'app.record.edit.show',5);assert.equal(await eventMode.getAttribute('aria-pressed'),'true','ドット区切りのイベント内にカーソルを置くだけでイベントへ切り替わる');assert.equal(await field.inputValue(),'app.record.edit.show');assert.match(await content.innerText(),/second\.js/);
    await page.locator('#kt-customize-field-search').fill('edit');await page.evaluate(()=>window.selectedEventOption=document.querySelector('#kt-customize-field option:checked'));await caretAt(1,'app.record.edit.show',12);assert.equal(await page.locator('#kt-customize-field-search').inputValue(),'edit');assert.equal(await page.evaluate(()=>selectedEventOption===document.querySelector('#kt-customize-field option:checked')),true,'同じイベント内のカーソル移動では選択欄を描き直さない');
    await caretAt(1,'mobile.app.record.edit.show',12);assert.equal(await field.inputValue(),'mobile.app.record.edit.show','同じ行にPCとモバイルがあってもカーソル側の完全なイベント名を使う');assert.match(await content.innerText(),/モバイル/);assert.doesNotMatch(await content.innerText(),/second\.js/);
    await caretAt(2,'app.record.edit.show',17);assert.equal(await field.inputValue(),'app.record.edit.show','イベントの一部と同じフィールドコードshowへ切り替えない');assert.equal(await eventMode.getAttribute('aria-pressed'),'true');
    await caretAt(7,'app.record.edit.change.memo',24);assert.equal(await field.inputValue(),'app.record.edit.change.memo','changeイベントの末尾memoでもフィールドではなくイベント全体へ追従する');
    await caretAt(4,'memo',2);assert.equal(await field.inputValue(),'memo');assert.equal(await fieldMode.getAttribute('aria-pressed'),'true','フィールドへカーソルを移すとフィールド表示へ戻る');
    await caretAt(5,'app.record.edit.show',9);assert.equal(await field.inputValue(),'app.record.edit.show','テンプレート引用符でも完全な既知イベントを追従する');
    await fieldMode.click();await field.selectOption('memo');
    for(const name of ['app.record.edit.unknown','other.app.record.edit.show','app.record.edit.show.more']){await caretAt(3,name,name.indexOf('record')+2);assert.equal(await field.inputValue(),'memo','未知・前後に文字があるイベントを部分一致させない: '+name);assert.equal(await fieldMode.getAttribute('aria-pressed'),'true');}
    await caretAt(1,'app.record.edit.show',8);await fieldMode.click();await field.selectOption('memo');await page.evaluate(()=>monacoEditors[0].setTestSelection('record.edit'));assert.equal(await field.inputValue(),'memo','イベント内にある部分選択をカーソル位置から補完しない');await page.evaluate(()=>monacoEditors[0].setTestSelection('app.record.edit.show\nmemo'));assert.equal(await field.inputValue(),'memo','複数行の選択もイベント名へ読み替えない');
    await caretAt(6,'unrelated',3);assert.equal(await field.inputValue(),'memo','イベント外のカーソルで表示を勝手に切り替えない');
    assert.equal(await editor(page).inputValue(),eventDraft,'カーソルに追従しても編集中のコードを変更しない');
    assert.deepEqual(await page.evaluate(()=>({base:baseReads,files:fileReads.length,scan:[...scanCalls],ai:proposalCalls.length,writes:[...operations]})),counts,'カーソル追従でも取得・解析・AI・書き込みを増やさない');
    await page.evaluate(()=>monacoEditors[0].setTestCursor('税_番号'));assert.equal(await field.inputValue(),'税_番号');assert.match(await content.innerText(),/税の番号/);
    await page.evaluate(()=>monacoEditors[0].setTestCursor('数量'));assert.equal(await field.inputValue(),'税_番号','ラベルからコードを推定しない');
    await page.evaluate(()=>monacoEditors[0].setTestCursor('memoSuffix'));assert.equal(await field.inputValue(),'税_番号','部分一致にしない');
    await page.evaluate(()=>monacoEditors[0].setTestCursor('memo','memo qty'));assert.equal(await field.inputValue(),'税_番号','複数語の選択を補わない');
    await page.evaluate(()=>monacoEditors[0].setTestCursor('memo','qty'));assert.equal(await field.inputValue(),'qty','選択文字とテーブル内のコードを完全一致で照合する');
    await page.locator('#kt-customize-field-search').fill('備考');await field.selectOption('memo');assert.match(await content.innerText(),/備考/);await page.locator('#kt-customize-field-search').fill('');
    await editor(page).fill('// hand edit\nconst memo = 42;\n');assert.match(await content.innerText(),/編集中|手元/);
    assert.deepEqual(await page.evaluate(()=>({base:baseReads,files:fileReads.length,scan:[...scanCalls],ai:proposalCalls.length,writes:[...operations]})),counts,'選択・検索・手編集では取得・解析・AI・書き込みをしない');
    await field.selectOption('memo');
    await page.screenshot({path:path.join(out,colorScheme+'-dependency-selected.png'),fullPage:true});
    await page.evaluate(()=>dependencyFailure=true);await refresh.click();await assertEventually(()=>refresh.isDisabled(),false);assert.match(await status.innerText(),/取得できません/);assert.equal(await field.isDisabled(),true);assert.doesNotMatch(await content.innerText(),/second\.js|備考の確認/,'取得失敗で古い結果を確認済みとして残さない');
    await page.evaluate(()=>{dependencyFailure=false;holdDependency=true;});await refresh.click();await page.waitForFunction(()=>typeof pendingDependency==='function');assert.match(await status.innerText(),/取得しています/);assert.equal(await content.innerText(),'');
    const readsWhileBusy=await page.evaluate(()=>baseReads);await page.evaluate(()=>document.querySelector('#kt-customize-dependency-refresh').dispatchEvent(new Event('click')));assert.equal(await page.evaluate(()=>baseReads),readsWhileBusy,'更新中に二重取得しない');
    await filePicker(page).selectOption({label:'second.js'});await assertEventually(()=>editor(page).inputValue(),'// second original\n');await page.evaluate(()=>pendingDependency());await assertEventually(()=>refresh.isDisabled(),false);assert.equal(await field.isDisabled(),false,'同じ取得単位にある別ファイルにも取得中の結果を共有する');await field.selectOption('memo');assert.match(await content.innerText(),/second\.js（開いているファイル）/,'取得中に切り替えても現在のファイルを表示する');assert.equal(await page.evaluate(()=>baseReads),readsWhileBusy,'別ファイルへの切替で二重取得しない');
    await selected(page,'same.js','// hand edit\nconst memo = 42;\n');await refresh.click();await assertEventually(()=>field.isDisabled(),false);await field.selectOption('memo');
    await page.evaluate(()=>holdDependency=true);await refresh.click();await page.waitForFunction(()=>typeof pendingDependency==='function');await page.evaluate(()=>{window.oldDependency=pendingDependency;customize.markStale();});assert.match(await status.innerText(),/設定が変わった/);
    await refresh.click();await assertEventually(()=>field.isDisabled(),false);await field.selectOption('memo');assert.match(await content.innerText(),/second\.js/,'設定変更後は一覧更新を挟まず依存関係の更新だけで回復する');assert.match(await content.innerText(),/備考の確認/);await field.selectOption('税_番号');const latestText=await content.innerText();await page.evaluate(()=>oldDependency());assert.equal(await field.inputValue(),'税_番号');assert.equal(await content.innerText(),latestText,'古い更新結果で新しい選択や結果を上書きしない');
    await page.evaluate(()=>dependencyBase.data.customize.revision='8');await page.locator('#kt-customize-refresh').click();await page.waitForFunction(()=>!document.querySelector('#kt-customize-file').disabled);
    assert.equal(await field.isDisabled(),true);assert.match(await status.innerText(),/設定の版が変わった/);assert.equal(await content.innerText(),'','一覧の新しい版を見つけたら旧依存表示を失効する');
    await refresh.click();await assertEventually(()=>refresh.isDisabled(),false);assert.match(await status.innerText(),/設定の版が変わった/);assert.equal(await field.isDisabled(),true,'既知の一覧より古い取得結果を確認済みにしない');
    await page.evaluate(()=>dependencyBase.revision.preview='9');await refresh.click();await assertEventually(()=>field.isDisabled(),false);await field.selectOption('memo');
    await page.locator('#kt-customize-refresh').click();await page.waitForFunction(()=>!document.querySelector('#kt-customize-file').disabled);assert.equal(await field.isDisabled(),false,'古い一覧の取得で新しい依存結果を失効しない');
    await page.evaluate(()=>{const current=dependencyBase.files.find(f=>f.target==='desktop'&&f.name==='same.js');current.fileKey='pc-latest';current.text="kintone.events.on('app.record.edit.show', event => { event.record.memo.value = 'latest'; return event; });";dependencyBase.revision.preview='10';});
    await refresh.click();await assertEventually(()=>field.isDisabled(),false);await field.selectOption('memo');
    assert.match(await content.innerText(),/same\.js/);assert.match(await content.innerText(),/備考の確認/);assert.match(await content.innerText(),/一致|異な|更新|変わ/,'登録済み本文が更新されたことを示す');
    assert.equal(await editor(page).inputValue(),'// hand edit\nconst memo = 42;\n','登録済み本文が外部更新されても手編集を置き換えず最新の依存結果を読む');
    await page.screenshot({path:path.join(out,colorScheme+'-dependency-editor-retained.png'),fullPage:true});
    await page.evaluate(()=>dependencyBase.env='production');await refresh.click();await assertEventually(()=>refresh.isDisabled(),false);assert.equal(await field.isDisabled(),true);assert.doesNotMatch(await content.innerText(),/second\.js|備考の確認/,'別環境の結果を混ぜない');
    assert.equal(await editor(page).inputValue(),'// hand edit\nconst memo = 42;\n');
    assert.equal(await page.evaluate(()=>proposalCalls.length),aiBefore);assert.deepEqual(await page.evaluate(()=>operations),[]);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
    await page.evaluate(()=>document.querySelector('#view-customize')._ktCustomizeDispose());assert.equal(await page.evaluate(()=>monacoEditors[0].cursorListenerCount()),0,'カーソル監視を破棄する');await page.evaluate(()=>work.dispose());
  }finally{await context.close();}
  }}finally{await browser.close();}
});


test('手編集の登録と運用反映は別確認・編集中の保持・外部変更から復帰（仮想APIだけ）',{timeout:60000},async()=>{
  fs.mkdirSync(out,{recursive:true});
  const browser=await playwright().chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:960},serviceWorkers:'block'}),unexpected=[],errors=[];
  try{
    await context.route('**/*',route=>{const url=route.request().url();if(url==='https://customize.test.invalid/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><body></body></html>'});if(url.startsWith('https://www.google.com/s2/favicons?'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg"/>'});unexpected.push(url);return route.abort();});
    const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
    await page.goto('https://customize.test.invalid/');await page.addScriptTag({content:bundle()});await mount(page);
    const actualPayloads=await page.evaluate(async()=>{const calls=[];window.kintone={api:Object.assign(async(url,method,payload)=>{calls.push({url,method,payload});},{url:path=>path})};await actualDeploy('310',{revision:'17'});await actualDeploy('310');return calls;});
    assert.equal(actualPayloads[0].payload.apps[0].revision,'17','実部品も確認した版を送る');assert.equal(actualPayloads[1].payload.apps[0].revision,-1,'既存呼出しの既定値は保つ');
    await selected(page,'same.js','// PC original\nconst memo = 1;\n');await page.evaluate(()=>enableManualWrites());
    const register=page.locator('#kt-customize-register'),deploy=page.locator('#kt-customize-deploy'),confirm=page.locator('#kt-customize-manual-confirm'),accept=confirm.locator('[data-manual-confirm]'),cancel=confirm.locator('[data-manual-cancel]'),status=page.locator('#kt-customize-manual-status');
    const initialCalls=await page.evaluate(()=>proposalCalls.length);
    await editor(page).fill('// manual v1');await register.click();await assertEventually(()=>confirm.isVisible(),true);
    assert.match(await confirm.innerText(),/same\.js（PC）/);assert.match(await confirm.innerText(),/運用環境は変更しません/);
    await page.screenshot({path:path.join(out,'manual-register-confirm.png'),fullPage:true});
    await cancel.click();assert.deepEqual(await page.evaluate(()=>operations),[],'確認を取り消すとアップロードも書込みもしない');
    await page.evaluate(()=>{holdNextCustomize=true;pendingList=null;});await register.click();await page.waitForFunction(()=>typeof pendingList==='function');await editor(page).fill('// edited during prepare');await page.evaluate(()=>pendingList());await assertEventually(()=>register.isEnabled(),true);
    assert.equal(await confirm.isVisible(),false,'読取り準備中に本文が変わると旧内容の確認を出さない');
    await register.click();await assertEventually(()=>confirm.isVisible(),true);await editor(page).fill('// manual v2');assert.equal(await confirm.isVisible(),false,'確認後の編集で確認を取り消す');
    await register.click();await assertEventually(()=>confirm.isVisible(),true);await page.evaluate(()=>holdUpload=true);await accept.click();await page.waitForFunction(()=>typeof finishUpload==='function');
    await editor(page).fill('// next edit retained');await page.evaluate(()=>finishUpload());await page.waitForFunction(()=>document.querySelector('#kt-customize-manual-status').textContent.includes('読み戻して一致'));await assertEventually(()=>register.isEnabled(),true);
    assert.equal(await editor(page).inputValue(),'// next edit retained','登録中に進んだ手編集を上書きしない');
    assert.deepEqual(await page.evaluate(()=>operations.map(x=>x.type)),['upload','put'],'登録だけでは運用反映しない');
    assert.equal(await page.evaluate(()=>manualFixtures.sources[manualFixtures.customize.desktop.js[0].file.fileKey]),'// manual v2');
    assert.ok((await page.evaluate(()=>manualChanges)).every(change=>change.preview&&!change.production),'登録後に動作テスト環境の基準を失効する');
    await register.click();await assertEventually(()=>confirm.isVisible(),true);await accept.click();await page.waitForFunction(()=>operations.filter(x=>x.type==='put').length===2);await assertEventually(()=>register.isEnabled(),true);
    assert.equal(await page.evaluate(()=>manualFixtures.sources[manualFixtures.customize.desktop.js[0].file.fileKey]),'// next edit retained','更新したfileKeyを基準に次の手編集を登録できる');
    await page.evaluate(()=>{manualFixtures.customize.desktop.js[0].file.fileKey='external';manualFixtures.sources.external='// external current';manualFixtures.customize.revision=String(Number(manualFixtures.customize.revision)+1);});
    await editor(page).fill('// conflicting edit');await register.click();await assertEventually(()=>register.isEnabled(),true);assert.equal(await confirm.isVisible(),false);assert.match(await status.innerText(),/ファイルが変わ/);
    const writesBeforeReload=await page.evaluate(()=>operations.length);await page.locator('#kt-customize-manual-reload').click();await assertEventually(()=>confirm.isVisible(),true);assert.match(await confirm.innerText(),/手元の編集は置き換わります/);await cancel.click();assert.equal(await editor(page).inputValue(),'// conflicting edit');
    await page.locator('#kt-customize-manual-reload').click();await assertEventually(()=>confirm.isVisible(),true);await accept.click();await assertEventually(()=>editor(page).inputValue(),'// external current');assert.equal(await page.evaluate(()=>operations.length),writesBeforeReload,'読み直しはkintoneに書き込まない');
    await editor(page).fill('// after recovery');await register.click();await assertEventually(()=>confirm.isVisible(),true);await accept.click();await page.waitForFunction(()=>operations.filter(x=>x.type==='put').length===3);await assertEventually(()=>register.isEnabled(),true);
    await page.locator('#kt-customize-new').click();await page.locator('#kt-newfile-name').fill('new-manual.js');await page.locator('#kt-newfile-ok').click();await editor(page).fill('// new registered body');
    await page.evaluate(()=>failNextRegistrationReadback=true);await register.click();await assertEventually(()=>confirm.isVisible(),true);await accept.click();await assertEventually(()=>register.isEnabled(),true);assert.match(await status.innerText(),/登録後の確認が完了していません/);
    assert.equal(await editor(page).inputValue(),'// new registered body');assert.equal(await page.locator('#kt-customize-manual-reload').isVisible(),true,'新規の登録結果不明でも読み直せる');
    await page.evaluate(()=>fileFailure=null);await page.locator('#kt-customize-manual-reload').click();await assertEventually(()=>confirm.isVisible(),true);await accept.click();await assertEventually(()=>register.isEnabled(),true);
    await editor(page).fill('// new edited again');await register.click();await assertEventually(()=>confirm.isVisible(),true);assert.match(await confirm.innerText(),/現在の本文を置き換え/);await accept.click();await assertEventually(()=>register.isEnabled(),true);assert.match(await status.innerText(),/読み戻して一致/);assert.equal(await page.evaluate(()=>manualFixtures.customize.desktop.js.filter(item=>item.file.name==='new-manual.js').length),1,'回復後の新規ファイルを重複追加しない');
    await selected(page,'same.js','// after recovery');
    await deploy.click();await assertEventually(()=>confirm.isVisible(),true);assert.match(await confirm.innerText(),/未反映の変更をすべて運用環境/);assert.match(await confirm.innerText(),/フォーム・一覧・プロセス管理/);assert.match(await confirm.innerText(),/編集中のコードは、この操作では登録しません/);await page.screenshot({path:path.join(out,'manual-deploy-confirm.png'),fullPage:true});await cancel.click();
    assert.equal(await page.evaluate(()=>operations.some(x=>x.type==='deploy')),false);
    await deploy.click();await assertEventually(()=>confirm.isVisible(),true);await page.evaluate(()=>manualFixtures.customize.revision=String(Number(manualFixtures.customize.revision)+1));await accept.click();await assertEventually(()=>deploy.isEnabled(),true);assert.match(await status.innerText(),/設定が変わりました/);assert.equal(await page.evaluate(()=>operations.some(x=>x.type==='deploy')),false,'確認後の別の変更を未確認で運用反映しない');
    await deploy.click();await assertEventually(()=>confirm.isVisible(),true);await accept.click();await page.waitForFunction(()=>document.querySelector('#kt-customize-manual-status').textContent.includes('反映が完了'));assert.equal(await page.evaluate(()=>operations.filter(x=>x.type==='deploy').length),1);assert.ok((await page.evaluate(()=>manualChanges)).some(change=>change.production));
    await page.evaluate(()=>{fixtureClient.propose=()=>new Promise(resolve=>{window.finishConsult=()=>resolve({reply:'確認しました。',intent:'answer',turn:{ops:[],answers:[],requirementOps:[]}});});window.busyConsult=work.controller.send('今のコードを説明してください');});await page.waitForFunction(()=>work.controller.getState().phase==='consulting');assert.equal(await register.isDisabled(),true);assert.equal(await deploy.isDisabled(),true);await page.evaluate(async()=>{finishConsult();await busyConsult;});await assertEventually(()=>register.isEnabled(),true);
    await page.locator('#kt-customize-consult').click();await page.locator('[data-release-action="code"]').click();assert.equal(await register.isVisible(),false);assert.equal(await deploy.isVisible(),false,'AIの相談画面に手編集の反映ボタンを混ぜない');
    assert.equal(await page.evaluate(()=>proposalCalls.length),initialCalls,'手編集の操作からAIを呼ばない');assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);await page.evaluate(()=>work.dispose());
  }finally{await context.close();await browser.close();}
});

test('依存関係の自動取得は失敗を繰り返さず、再表示と新しい設定で再開する（外部通信なし）',{timeout:60000},async()=>{
  const browser=await playwright().chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:960},serviceWorkers:'block'}),errors=[],unexpected=[];
  try{
    await context.route('**/*',route=>{const url=route.request().url();if(url==='https://customize.test.invalid/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><body></body></html>'});if(url.startsWith('https://www.google.com/s2/favicons?'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg"/>'});unexpected.push(url);return route.abort();});
    const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
    await page.goto('https://customize.test.invalid/');await page.addScriptTag({content:bundle()});await mount(page);
    const field=page.locator('#kt-customize-field'),status=page.locator('#kt-customize-dependency-status'),refresh=page.locator('#kt-customize-dependency-refresh');
    const initial=await page.evaluate(()=>({reads:baseReads,ai:proposalCalls.length}));
    await page.locator('#kt-customize-source').selectOption('css');await selected(page,'style.css','.memo { color: blue; }\n');
    assert.equal(await page.evaluate(()=>baseReads),initial.reads,'CSSを開くだけでは依存関係を自動取得しない');
    await page.locator('#kt-customize-source').selectOption('JavaScript');await page.locator('#kt-customize-new').click();await page.locator('#kt-newfile-name').fill('scratch.js');await page.locator('#kt-newfile-ok').click();
    assert.equal(await page.evaluate(()=>baseReads),initial.reads,'登録していない新規ファイルでは取得しない');
    await page.evaluate(()=>dependencyFailure=true);await selected(page,'same.js','// PC original\nconst memo = 1;\n');await assertEventually(()=>refresh.isDisabled(),false);assert.match(await status.innerText(),/取得できません/);
    const failedReads=await page.evaluate(()=>baseReads);assert.equal(failedReads,initial.reads+1);
    await editor(page).fill('// kept draft\nconst memo = 42;');await selected(page,'second.js','// second original\n');
    await page.locator('#tab-health').click();await page.locator('#tab-customize').click();await page.evaluate(()=>monacoEditors[0].setTestCursor('memo'));
    assert.equal(await page.evaluate(()=>baseReads),failedReads,'失敗後にファイル・タブ・カーソルを変えても自動で再試行しない');
    await page.evaluate(()=>dependencyFailure=false);await refresh.click();await assertEventually(()=>field.isDisabled(),false);assert.equal(await page.evaluate(()=>dependencyContinue),null,'手動更新は表示の中断条件を渡さない');
    await selected(page,'same.js','// kept draft\nconst memo = 42;');assert.equal(await page.evaluate(()=>baseReads),failedReads+1,'手動更新の成功結果はファイルを変えても再利用する');
    await page.evaluate(()=>{customize.markStale();dependencyBase.revision.preview='8';manualFixtures.customize.revision='8';});
    await page.locator('#tab-health').click();await page.locator('#tab-customize').click();await assertEventually(()=>field.isDisabled(),false);
    assert.equal(await page.evaluate(()=>baseReads),failedReads+2,'設定変更の新しい世代では次の表示時に自動取得する');assert.equal(await editor(page).inputValue(),'// kept draft\nconst memo = 42;');
    await page.evaluate(()=>{customize.markStale();holdDependency=true;pendingDependency=null;});
    await page.locator('#tab-health').click();await page.locator('#tab-customize').click();await page.waitForFunction(()=>typeof pendingDependency==='function');
    const pausedReads=await page.evaluate(()=>baseReads),pausedScans=await page.evaluate(()=>scanCalls.length);
    assert.equal(await page.evaluate(()=>typeof dependencyContinue),'function','自動取得は既存の段階取得に表示条件を渡す');assert.equal(await page.evaluate(()=>dependencyContinue()),true);
    await page.locator('#kt-mini').click();assert.equal(await page.evaluate(()=>dependencyContinue()),false,'最小化後は次の取得段を始めない');await page.evaluate(()=>pendingDependency());await assertEventually(()=>refresh.isDisabled(),false);
    assert.equal(await page.evaluate(()=>scanCalls.length),pausedScans,'最小化した後の結果は解析しない');assert.match(await status.textContent(),/表示すると/);
    await page.locator('#kt-mini').click();await page.evaluate(()=>customize.ensureLoaded());await assertEventually(()=>field.isDisabled(),false);
    assert.equal(await page.evaluate(()=>baseReads),pausedReads+1,'再表示時は失敗の扱いにせず再開する');
    await page.evaluate(()=>{customize.markStale();holdDependency=true;pendingDependency=null;});
    await page.locator('#tab-health').click();await page.locator('#tab-customize').click();await page.waitForFunction(()=>typeof pendingDependency==='function');const quickReads=await page.evaluate(()=>baseReads);
    await page.locator('#kt-mini').click();await page.locator('#kt-mini').click();await page.evaluate(()=>customize.ensureLoaded());await page.evaluate(()=>pendingDependency());await assertEventually(()=>field.isDisabled(),false);
    assert.equal(await page.evaluate(()=>baseReads),quickReads+1,'旧取得の終了前に再展開しても自動再開を取りこぼさない');
    await page.evaluate(()=>{customize.markStale();holdDependency=true;pendingDependency=null;});
    await page.locator('#tab-health').click();await page.locator('#tab-customize').click();await page.waitForFunction(()=>typeof pendingDependency==='function');
    const oldReads=await page.evaluate(()=>baseReads);await page.evaluate(()=>{manualFixtures.customize.revision='9';dependencyBase.revision.preview='9';});
    await page.locator('#kt-customize-refresh').click();await assertEventually(()=>filePicker(page).isDisabled(),false);await page.evaluate(()=>pendingDependency());await assertEventually(()=>field.isDisabled(),false);
    assert.equal(await page.evaluate(()=>baseReads),oldReads+1,'取得中に新しい設定の版を知った場合は最新を一度取り直す');
    await page.locator('#tab-ai').click();await page.evaluate(()=>customize.markStale());const aiCodeReads=await page.evaluate(()=>baseReads);
    await page.locator('[data-release-action="code"]').click();await assertEventually(()=>editor(page).isVisible(),true);await page.evaluate(()=>customize.ensureLoaded());
    assert.equal(await page.evaluate(()=>baseReads),aiCodeReads,'AI側へコード表示を開いただけでは依存関係を自動取得しない');
    await page.locator('#tab-customize').click();await assertEventually(()=>field.isDisabled(),false);assert.equal(await page.evaluate(()=>baseReads),aiCodeReads+1,'Customizeへ戻ると新しい世代の依存関係を取得する');
    assert.equal(await editor(page).inputValue(),'// kept draft\nconst memo = 42;');assert.equal(await page.evaluate(()=>proposalCalls.length),initial.ai);assert.deepEqual(await page.evaluate(()=>operations),[]);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await page.evaluate(()=>work.dispose());
  }finally{await context.close();await browser.close();}
});
