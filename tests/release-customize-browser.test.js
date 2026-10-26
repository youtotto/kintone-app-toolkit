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
  return source.slice(0, end) + '\nglobalThis.CustomizeTest={mountRoot,renderCustomize,renderAiWorkspace,KTApi,KTDevBase,KTAiClient};\n' + source.slice(end);
}
async function mount(page) {
  await page.evaluate(async () => {
    const T = CustomizeTest, C = T.KTAiClient;
    const clone = value => structuredClone(value);
    window.operations = []; window.fileReads = []; window.pendingFile = null;
    const denied = name => () => { operations.push(name); throw Error('Forbidden in local browser test: ' + name); };
    const file = (name, fileKey) => ({type:'FILE', file:{name,fileKey,size:'40'}});
    const customize = {revision:'7',scope:'ALL',desktop:{js:[file('same.js','pc'),file('second.js','second'),file('slow.js','slow')],css:[file('style.css','css')]},mobile:{js:[file('same.js','mobile')],css:[]}};
    const sources = {pc:'// PC original\nconst memo = 1;\n',mobile:'// mobile original\nconst memo = 2;\n',second:'// second original\n',slow:'// slow original\n',css:'.memo { color: blue; }\n'};
    T.KTApi.getCustomize = async (_app, options) => ({source:options?.preferPreview === false ? 'prod' : 'preview',data:clone(customize)});
    T.KTApi.downloadFile = async key => { fileReads.push(key); if(key === 'slow')return new Promise(resolve => {window.pendingFile=()=>resolve(sources.slow);}); return sources[key]; };
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
    window.customize=T.renderCustomize(shell,data,'310',{autoLoad:true,getInputs:()=>({data,deps:{},scan:{files:[]}}),consult:seed=>work.consult(seed)});
    window.customize=await window.customize;shell.ktCustomize=window.customize;
    window.customize.attachAssistant(work);
    window.originalHost=shell.querySelector('#kt-ai-host');
    await work.refreshCapability();
    await work.controller.send('備考の編集条件を見直したいです。');
    shell.ktTabs.switchTab('customize');
  });
}
async function row(page,name){return page.locator('#kt-customize-list > div').filter({has:page.locator('[title="'+name+'"]')});}
const editor = page => page.locator('#kt-customize-editor textarea[data-test-editor]');
async function selected(page,name,value){await (await row(page,name)).click();await assertEventually(()=>editor(page).inputValue(),value);}
async function assertEventually(read,expected){for(let i=0;i<100;i++){const value=await read();if(value===expected)return;await new Promise(resolve=>setTimeout(resolve,20));}assert.equal(await read(),expected);}

test('Customize内の共通会話・差分と手編集の保持（外部通信なし）',{timeout:90000},async t=>{
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
        await editor(page).fill('// PC unsaved edit\nconst memo = 10;\n');
        await selected(page,'second.js','// second original\n');
        await editor(page).fill('// second unsaved edit\n');
        await selected(page,'same.js','// PC unsaved edit\nconst memo = 10;\n');
        await page.locator('#kt-customize-source').selectOption('JavaScriptMobile');
        await selected(page,'same.js','// mobile original\nconst memo = 2;\n');
        await editor(page).fill('// mobile unsaved edit\n');
        await page.locator('#kt-customize-source').selectOption('css');
        await selected(page,'style.css','.memo { color: blue; }\n');
        await editor(page).fill('.memo { color: red; }\n');
        await page.locator('#kt-customize-source').selectOption('JavaScript');
        await selected(page,'same.js','// PC unsaved edit\nconst memo = 10;\n');
        // A late download must not overwrite a newer file selection or its draft.
        await (await row(page,'slow.js')).click();
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
        await (await row(page,'same.js')).locator('button.kt-customize-consult').click();
        assert.equal(await page.locator('#view-customize').isVisible(),true,'相談を始めてもCustomizeに残る');
        assert.equal(await page.locator('#kt-release-input').inputValue(),'送信していない修正の相談','入力途中の相談を上書きしない');
        assert.equal(await page.evaluate(()=>document.querySelector('#kt-customize-ai-slot #kt-ai-host')===originalHost),true,'同じDOMを移動する');
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
        assert.equal(await page.locator('#kt-customize-ai-slot #kt-ai-host').count(),0);
        await page.locator('#tab-customize').click();
        assert.equal(await page.locator('#kt-release-input').inputValue(),'送信していない修正の相談');
        await page.screenshot({path:path.join(out,colorScheme+'-conversation.png'),fullPage:true});
        // Seed only the prepared display record. Candidate code must stay separate from hand edits.
        const prepared=await page.evaluate(()=>{
          const state=work.controller.getState();
          const changes=[
            {changeId:'C1',kind:'REPLACE_FILE',target:'desktop',name:'same.js',currentSource:'// PC original\nconst memo = 1;\n',content:'// PC AI proposal\nconst memo = 3;\n'},
            {changeId:'C2',kind:'REPLACE_FILE',target:'mobile',name:'same.js',currentSource:'// mobile original\nconst memo = 2;\n',content:'// mobile AI proposal\nconst memo = 4;\n'}
          ];
          window.displayState={...state,phase:'review',adopted:state.proposal,plan:{goal:'備考の編集条件を変更',steps:[],customizations:[]},artifacts:[],prepared:{ok:true,signature:'fixed-signature',changes:changes.map(c=>({kind:'javascript',target:c.target,file:c.name,title:'備考の編集条件',operation:c.kind})),files:{changes},confirmations:[],reasons:[]}};
          work.controller.getState=()=>structuredClone(displayState);
          work.view.render();customize.attachAssistant({...work});customize.onVisible();
          return displayState.prepared;
        });
        await page.locator('[data-customize-mode="comparison"]').click();
        assert.equal(await page.locator('#kt-customize-comparison').isVisible(),true);
        assert.equal(await page.locator('#kt-customize-upload').isVisible(),false);
        const comparison=()=>page.evaluate(()=>{const d=monacoDiffs.findLast(x=>!x.disposed);return {before:d.getModel().original.getValue(),after:d.getModel().modified.getValue(),readOnly:d.options.readOnly,originalEditable:d.options.originalEditable};});
        assert.deepEqual(await comparison(),{before:prepared.files.changes[0].currentSource,after:prepared.files.changes[0].content,readOnly:true,originalEditable:false});
        await page.locator('[data-comparison-file]').selectOption({index:1});
        assert.deepEqual(await comparison(),{before:prepared.files.changes[1].currentSource,after:prepared.files.changes[1].content,readOnly:true,originalEditable:false});
        const stateBeforeTabs=await page.evaluate(()=>JSON.stringify({adopted:work.controller.getState().adopted,prepared:work.controller.getState().prepared,runs:work.controller.getState().runs}));
        await page.locator('#tab-ai').click();
        await page.locator('#tab-customize').click();
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
          work.view.render();customize.attachAssistant({...work});customize.onVisible();
        });
        assert.match(await page.locator('.ktr-current').innerText(),/動作テスト環境に反映しました/);
        assert.match(await page.locator('[data-comparison-note]').innerText(),/この反映の記録/);
        await page.locator('[data-release-panel="runs"] > summary').click();
        await page.locator('[data-release-action="history"][data-release-id="run-0"]').click();
        assert.match(await page.locator('.ktr-current').innerText(),/以前の内容を反映しました/);
        assert.deepEqual(await comparison(),{before:'// earlier before\n',after:'// earlier after\n',readOnly:true,originalEditable:false},'過去の反映を選ぶと左右とも同じ記録になる');
        assert.equal(await page.evaluate(()=>work.view.getSelectedRunId()),'run-0');
        await page.locator('[data-release-action="history"][data-release-id="run-1"]').click();
        assert.match(await page.locator('.ktr-current').innerText(),/動作テスト環境に反映しました/);
        assert.deepEqual(await comparison(),{before:prepared.files.changes[0].currentSource,after:prepared.files.changes[0].content,readOnly:true,originalEditable:false});
        await page.locator('[data-release-action="current"]').click();
        assert.equal(await page.evaluate(()=>work.view.getSelectedRunId()),null);
        assert.deepEqual(await comparison(),{before:prepared.files.changes[0].currentSource,after:prepared.files.changes[0].content,readOnly:true,originalEditable:false});
        const runBefore=await page.evaluate(()=>JSON.stringify(work.controller.getState().runs));
        await page.locator('#tab-ai').click();
        assert.match(await page.locator('.ktr-current').innerText(),/動作テスト環境に反映しました/);
        await page.locator('#tab-customize').click();
        assert.equal(await page.evaluate(()=>JSON.stringify(work.controller.getState().runs)),runBefore,'タブ移動は反映結果を作り直さない');
        assert.deepEqual(await comparison(),{before:prepared.files.changes[0].currentSource,after:prepared.files.changes[0].content,readOnly:true,originalEditable:false});
        await page.locator('[data-customize-mode="editor"]').click();
        assert.equal(await editor(page).isVisible(),true);
        assert.equal(await editor(page).inputValue(),'// PC unsaved edit\nconst memo = 10;\n');
        await page.setViewportSize({width:430,height:932});
        const geometry=await page.evaluate(()=>{
          const shell=document.querySelector('#kt-toolkit').getBoundingClientRect(),ai=document.querySelector('#kt-customize-ai-slot').getBoundingClientRect(),code=document.querySelector('#kt-customize-code-pane').getBoundingClientRect();
          return {viewport:innerWidth,shellRight:shell.right,aiWidth:ai.width,codeWidth:code.width,aiTop:ai.top,aiBottom:ai.bottom,codeTop:code.top,documentWidth:document.documentElement.scrollWidth};
        });
        assert.ok(geometry.shellRight<=geometry.viewport+1,'狭い画面で外枠がはみ出さない');
        assert.ok(geometry.codeTop>=geometry.aiBottom-2,'狭い画面では相談とコードを縦に並べる');
        assert.ok(geometry.documentWidth<=geometry.viewport+1,'ページ横スクロールを増やさない');
        await page.screenshot({path:path.join(out,colorScheme+'-narrow.png'),fullPage:true});
        await page.locator('[data-customize-mode="comparison"]').scrollIntoViewIfNeeded();
        await page.locator('[data-customize-mode="comparison"]').click();
        await page.locator('[data-comparison-mode="after"]').click();
        assert.equal(await page.locator('[data-comparison-editor] textarea').inputValue(),prepared.files.changes[0].content);
        assert.equal(await page.locator('[data-comparison-editor] textarea').evaluate(el=>el.readOnly),true);
        await page.screenshot({path:path.join(out,colorScheme+'-narrow-code.png'),fullPage:true});
        assert.deepEqual(await page.evaluate(()=>operations),[],'有料機能とkintoneの書き込みは呼ばない');
        assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
        await page.evaluate(()=>work.dispose());
      }finally{await context.close();}
    });
  }finally{await browser.close();}
});
