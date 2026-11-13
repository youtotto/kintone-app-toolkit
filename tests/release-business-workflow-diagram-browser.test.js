'use strict';
// Every URL is intercepted: saved/ synthetic settings only, no AI or kintone.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const F=require('./helpers/business-fixture.js');
const out=path.join(__dirname,'.build/workflow-diagram');
const baseState=doc=>({phase:'idle',taskId:1,version:0,runs:[],answers:[],artifacts:[],messages:[],explanations:[doc],explanationId:doc.id});
async function fixture(disabled=false){
 const data=F.raw();data.process.enable=!disabled;
 data.process.states.保留={name:'保留',index:'2',assignee:{type:'ALL',entities:[]}};
 data.process.actions.push({name:'調査へ回す',from:'申請済み',to:'保留',filterCond:'memo = "要調査"',type:'PRIMARY'},{name:'調査後に再開',from:'保留',to:'申請済み',filterCond:'',type:'PRIMARY'},{name:'再確認',from:'申請済み',to:'申請済み',filterCond:'',type:'PRIMARY'});
 const {s}=await F.snapshot({data}),o=F.workflowOutput(s);
 return {id:'diagram',kind:'business-understanding',title:'業務工程を読み解く',snapshot:s,businessUnderstanding:o};
}
test('概要図と工程詳細を分け、クリック往復・補足図・無効状態・狭幅・ダークテーマを無料で確認',{timeout:90000},async()=>{
 let pw;try{pw=require('playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
 const browser=await pw.chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 const unexpected=[],errors=[];fs.mkdirSync(out,{recursive:true});
 try{
  const context=await browser.newContext({viewport:{width:1360,height:1000}});
  await context.route('**/*',route=>route.request().url()==='https://workflow-diagram.test.invalid/'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><body style="margin:0"><div id="app" style="height:100vh"></div></body></html>'}):(unexpected.push(route.request().url()),route.abort()));
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://workflow-diagram.test.invalid/');
  let code=fs.readFileSync(path.join(root,'kintoneAppToolkit.user.js'),'utf8').replace('waitReady().then(() => startToolkit());','');
  const end=code.lastIndexOf('})();');code=code.slice(0,end)+'\nglobalThis.WorkflowDiagramTest={KTReleaseView};\n'+code.slice(end);await page.addScriptTag({content:code});
  const mount=async doc=>page.evaluate(state=>{
   window.diagramView?.dispose();document.querySelector('#app').innerHTML='';
   window.diagramState=state;
   const controller={getState:()=>diagramState,subscribe:()=>()=>{}};
   window.diagramView=WorkflowDiagramTest.KTReleaseView.create(document.querySelector('#app'),{controller,connection:{connected:false},appName:'無料の表示確認'});
  },baseState(doc));
  const enabled=await fixture();await mount(enabled);
  const svg=page.locator('[data-workflow-diagram]'),scale=page.locator('[data-workflow-scale]');
  assert.equal(await page.locator('.ktr-workflow-reference').getAttribute('open'),null);assert.equal(await svg.isVisible(),false);
  assert.equal(await page.locator('[data-workflow-rule]').count(),1);assert.equal(await page.locator('[data-workflow-setting-stage]').count(),2);
  const overview=page.locator('[data-workflow-overview]');
  assert.equal(await overview.isVisible(),true);assert.equal(await overview.locator('[data-workflow-overview-node]').count(),3);
  assert.equal(await overview.locator('[data-workflow-overview-actions]').count(),5);
  assert.equal(await page.locator('.ktr-workflow-overview').evaluate(el=>!!(el.compareDocumentPosition(document.querySelector('.ktr-workflow-card'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
  const selectR1=overview.locator('a[data-workflow-overview-select][href*="-stage-R1"]');
  await selectR1.focus();
  const beforeSelect=await page.evaluate(()=>({state:JSON.stringify(diagramState),top:document.querySelector('.ktr-current').scrollTop}));
  await page.keyboard.press('Enter');
  const selectedKey=await selectR1.getAttribute('data-workflow-overview-select');
  assert.equal(await overview.locator('[data-workflow-overview-node="'+selectedKey+'"]').getAttribute('data-workflow-focus'),'selected');
  assert.equal(await selectR1.getAttribute('aria-pressed'),'true');
  assert.deepEqual(await page.evaluate(()=>({state:JSON.stringify(diagramState),top:document.querySelector('.ktr-current').scrollTop})),beforeSelect,'selecting a node stays in the overview and leaves the document unchanged');
  assert.equal(new URL(page.url()).hash,'');
  // Adjacent-stage cards must inherit the same complete palette as the workspace.
  const neighborCards=page.locator('.ktr-workflow-focus-flow .ktr-workflow-neighbors button');
  assert.ok(await neighborCards.count()>0);
  for(const theme of [
   {name:'light',css:'',text:'rgb(37, 50, 71)',paper:'rgb(255, 255, 255)',soft:'rgb(245, 247, 251)',line:'rgb(219, 226, 236)'},
   {name:'dark',css:'--kt-text:#e5edf8;--kt-muted:#a9b6c8;--kt-paper:#172235;--kt-soft:#202f45;--kt-line:#42516a;--kt-accent:#8ebaff;',text:'rgb(229, 237, 248)',paper:'rgb(23, 34, 53)',soft:'rgb(32, 47, 69)',line:'rgb(66, 81, 106)'}
  ]){
   await page.locator('#app').evaluate((el,css)=>{el.style.cssText='height:100vh;'+css;},theme.css);
   const checkPalette=async()=>{
    const colors=await neighborCards.evaluateAll(els=>els.map(el=>{const s=getComputedStyle(el);return {text:s.color,paper:s.backgroundColor,line:s.borderTopColor,width:s.borderTopWidth,hover:el.matches(':hover')};}));
    for(const {hover,...color} of colors)assert.deepEqual(color,{text:theme.text,paper:hover?theme.soft:theme.paper,line:theme.line,width:'1px'},theme.name+' neighbor palette');
   };
   await checkPalette();await neighborCards.first().hover();await checkPalette();
   await neighborCards.first().focus();await checkPalette();
   await page.locator('.ktr-workflow-overview-selection').screenshot({path:path.join(out,'neighbors-'+theme.name+'.png')});
  }
  await page.locator('#app').evaluate(el=>{el.style.cssText='height:100vh';});
  await overview.locator('.ktr-workflow-overview-detail').click();
  assert.equal(await page.locator('.ktr-workflow-selected').getAttribute('data-workflow-rule'),'R1');
  await page.locator('.ktr-workflow-selected .ktr-workflow-back').click();
  assert.match(await page.locator('.ktr-workflow-selected').getAttribute('class'),/ktr-workflow-overview/);
  assert.equal(await page.locator('.ktr-workflow-selected').evaluate(el=>el===document.activeElement),true);assert.equal(new URL(page.url()).hash,'');
  const selectSetting=overview.locator('a[data-workflow-overview-select][href*="-setting-stage-"]').first();
  await selectSetting.click();
  assert.equal(await selectSetting.getAttribute('aria-pressed'),'true');
  await overview.locator('.ktr-workflow-overview-detail').click();
  assert.ok(await page.locator('.ktr-workflow-selected').getAttribute('data-workflow-setting-stage'));
  await page.locator('.ktr-workflow-selected .ktr-workflow-back').click();
  await page.screenshot({path:path.join(out,'enabled-cards.png')});
  await page.locator('.ktr-workflow-reference>summary').click();
  assert.equal(await svg.isVisible(),true);
  assert.equal(await svg.count(),1);assert.equal(await svg.locator('.ktr-workflow-diagram-node').count(),3);
  assert.equal(await svg.locator('.ktr-workflow-diagram-edge').count(),5);
  const order=await page.evaluate(()=>{const graph=document.querySelector('[data-workflow-diagram]'),stage=document.querySelector('.ktr-workflow-stage');return !!(stage.compareDocumentPosition(graph)&Node.DOCUMENT_POSITION_FOLLOWING);});assert.equal(order,true);
  const natural=await svg.boundingBox();await scale.selectOption('0.75');const smaller=await svg.boundingBox();assert.ok(Math.abs(smaller.width/natural.width-.75)<.01);assert.ok(Math.abs(smaller.height/natural.height-.75)<.01);
  await scale.selectOption('1');
  const stageLink=svg.locator('a[href*="-stage-R1"]').first();assert.equal(await stageLink.count(),1);await stageLink.focus();await page.keyboard.press('Enter');
  assert.match(await page.locator('.ktr-workflow-selected').getAttribute('class'),/ktr-workflow-stage/);assert.equal(new URL(page.url()).hash,'');assert.equal(await page.locator('.ktr-workflow-selected').evaluate(el=>el===document.activeElement),true);
  const text=await page.locator('.ktr-workflow-selected').innerText();for(const label of ['担当者','開始タイミング','入力・確認','通知','次へ進む条件・操作'])assert.ok(text.includes(label));
  await page.locator('.ktr-workflow-unassigned>summary').click();await page.locator('.ktr-workflow-unassigned a').first().click();assert.equal(new URL(page.url()).hash,'');assert.equal(await page.locator('.ktr-workflow-selected').evaluate(el=>el.tagName==='DETAILS'&&el.open),true);
  await page.locator('.ktr-workflow-reference>summary').click();
  await page.locator('.ktr-current').evaluate(el=>{el.scrollTop=0;});await page.screenshot({path:path.join(out,'enabled.png')});
  const metrics=async()=>page.evaluate(()=>({width:innerWidth,bodyWidth:document.documentElement.scrollWidth,scroll:[...document.querySelectorAll('[data-workflow-diagram-scroll]')].map(el=>({width:el.clientWidth,height:el.clientHeight,scrollWidth:el.scrollWidth}))}));
  await page.setViewportSize({width:390,height:844});await mount(enabled);const narrow=await metrics();assert.ok(narrow.bodyWidth<=390,'graph must not widen document');assert.ok(narrow.scroll[0].height<=480);assert.equal(await svg.isVisible(),false);assert.equal(await overview.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);const cardOverflow=await page.locator('.ktr-workflow-card').evaluateAll(els=>els.some(el=>el.scrollWidth>el.clientWidth+1));assert.equal(cardOverflow,false);await page.screenshot({path:path.join(out,'narrow.png')});
  await page.setViewportSize({width:1360,height:1000});await mount(await fixture(true));
  assert.equal(await svg.locator('a[href*="-stage-"]').count(),0);assert.match(await page.locator('.ktr-workflow-reference>summary').innerText(),/参考：無効/);
  assert.equal(await page.locator('[data-workflow-setting-stage]').count(),0);assert.equal(await svg.isVisible(),false);
  await page.locator('.ktr-workflow-reference>summary').click();
  const first=svg.locator('.ktr-workflow-diagram-node').first();await first.click();assert.equal(await page.locator('.ktr-workflow-selected').getAttribute('data-process-state')!==null,true);
  await page.locator('.ktr-current').evaluate(el=>{el.scrollTop=0;});await page.screenshot({path:path.join(out,'disabled.png')});
  await page.locator('#app').evaluate(el=>el.style.cssText+=';--kt-text:#e5edf8;--kt-muted:#a9b6c8;--kt-line:#42516a;--kt-paper:#172235;--kt-soft:#202f45;--kt-accent:#8ebaff;--kt-warning:#e5bd72;');
  await page.screenshot({path:path.join(out,'dark.png')});
  const palette=await svg.locator('.ktr-workflow-diagram-node text').first().evaluate(el=>({fill:getComputedStyle(el).fill,background:getComputedStyle(el.closest('.ktr-workflow-diagram-scroll')).backgroundColor}));assert.equal(palette.fill,'rgb(229, 237, 248)');assert.equal(palette.background,'rgb(23, 34, 53)');
  const wide=structuredClone(enabled),template=wide.snapshot.evidence.find(e=>e.kind==='process_state');
  wide.snapshot.evidence.push(...Array.from({length:9},(_,i)=>({...structuredClone(template),evidenceId:'wide-state-'+i,value:{...structuredClone(template.value),name:'独立した工程'+i,index:String(i+3)}})));
  wide.snapshot.categories.find(c=>c.category==='process').itemCount+=9;
  await mount(wide);
  const overviewZoom=overview.locator('[data-workflow-overview-zoom]');
  const overviewSize=()=>page.locator('.ktr-workflow-overview-svg').evaluate(el=>({renderedWidth:el.getBoundingClientRect().width,renderedHeight:el.getBoundingClientRect().height,naturalWidth:Number(el.dataset.naturalWidth),naturalHeight:Number(el.dataset.naturalHeight),scrollWidth:el.parentElement.scrollWidth,clientWidth:el.parentElement.clientWidth}));
  const readability=await overviewSize();
  assert.equal(await overviewZoom.inputValue(),'1');assert.ok(readability.renderedWidth>=readability.clientWidth);assert.ok(readability.scrollWidth>=readability.clientWidth);assert.equal(await overview.locator('[data-workflow-minimap]').count(),1);assert.ok((await metrics()).bodyWidth<=1360);
  await overviewZoom.selectOption('1');const fullSize=await overviewSize();assert.ok(Math.abs(fullSize.renderedWidth-fullSize.naturalWidth)<1);assert.ok(fullSize.scrollWidth>fullSize.clientWidth);
  await overviewZoom.selectOption('1.5');const larger=await overviewSize();assert.ok(Math.abs(larger.renderedWidth-larger.naturalWidth*1.5)<1);assert.ok(Math.abs(larger.renderedHeight-larger.naturalHeight*1.5)<1);
  await overviewZoom.selectOption('1');assert.ok((await overviewSize()).scrollWidth>=readability.clientWidth);
  await page.locator('.ktr-workflow-overview').evaluate(el=>el.scrollIntoView({block:'start'}));await page.screenshot({path:path.join(out,'wide-overview.png')});
  if(process.env.WORKFLOW_PREVIEW_CONVERSATION){
   const saved=JSON.parse(fs.readFileSync(process.env.WORKFLOW_PREVIEW_CONVERSATION,'utf8'));
   const doc=saved.session.state.explanations.find(x=>x.businessUnderstanding?.schemaVersion==='business-workflow-1');
   assert.ok(doc);await mount(doc);
   assert.equal(await page.locator('[data-workflow-rule]').count(),doc.businessUnderstanding.rules.length);
   assert.equal(await svg.isVisible(),false);assert.equal(await page.locator('[data-workflow-setting-stage]').count(),0);
   const before=JSON.stringify(doc);assert.equal(doc.businessUnderstanding.rules.length,3);assert.equal(await overview.locator('[data-workflow-overview-node]').count(),3);assert.equal(await overview.locator('[data-workflow-overview-actions]').count(),0);assert.match(await overview.innerText(),/順序・つながりは未確認/);
   await page.screenshot({path:path.join(out,'app1072-cards.png')});
   await page.locator('.ktr-workflow-overview a').nth(1).click();
   assert.match(await page.locator('.ktr-workflow-selected').innerText(),/保存時の内容確認/);assert.equal(new URL(page.url()).hash,'');
   await page.screenshot({path:path.join(out,'app1072-second-card.png')});
   await page.locator('.ktr-workflow-questions').nth(1).locator('summary').click();
   assert.match(await page.locator('.ktr-workflow-questions').nth(1).innerText(),/誰が担当/);
   assert.equal(JSON.stringify(doc),before);
   await page.setViewportSize({width:390,height:844});await mount(doc);
   assert.ok((await metrics()).bodyWidth<=390);await page.locator('.ktr-workflow-overview').evaluate(el=>el.scrollIntoView({block:'start'}));await page.screenshot({path:path.join(out,'app1072-narrow.png')});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({narrow,palette,readability,errors,unexpected},null,2));
 }finally{await browser.close();}
});
