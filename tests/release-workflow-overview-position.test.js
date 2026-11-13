'use strict';
// Real workspace, renderer and overview controller; synthetic SVG dimensions and browser-like scroll clamping.
const test=require('node:test'),assert=require('node:assert/strict');
const {KTReleaseWorkspace:W}=require('../src/release-workspace.js');
const {KTReleaseView:V}=require('../src/release-view.js');
const {KTBusinessConsultation:B}=require('../src/release-business-consultation.js');
const {makeComplexFixture,restoreComplexDocument}=require('./helpers/business-complex-fixture.js');
const {fixture}=require('./helpers/release-workspace-fixture.js');
const scope={domain:'fixture.cybozu.com',appId:'310'},wide={scrollWidth:3487,clientWidth:656,scrollHeight:2000,clientHeight:360};
const originalFetch=globalThis.fetch;
test.before(()=>{globalThis.fetch=()=>{throw Error('Network prohibited in overview position tests');};});
test.after(()=>{globalThis.fetch=originalFetch;});
const decode=value=>String(value).replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
function hostOf(dimensions=wide){
 const listeners=new Map();let html='',input=null,canvas=null,overview=null,generation=0;
 const host={ownerDocument:{activeElement:null},querySelector:selector=>selector==='#kt-release-input'?input:selector==='.ktr-workflow-overview-canvas'?canvas:selector==='[data-workflow-overview-root]'?overview:null,querySelectorAll:()=>[],addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 Object.defineProperty(host,'innerHTML',{get:()=>html,set(value){
  html=String(value);generation++;
  const match=/<textarea\b[^>]*id="kt-release-input"([^>]*)>([\s\S]*?)<\/textarea>/.exec(html);
  input=match?{id:'kt-release-input',value:decode(match[2]),disabled:/\sdisabled\b/.test(match[1]),selectionStart:0,selectionEnd:0,focus(){host.ownerDocument.activeElement=input;},setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b;}}:null;
  canvas=null;overview=null;
  if(/\bdata-workflow-overview-root(?:\s|>)/.test(html)){
   const handlers=new Map(),elements=new Map(),nodes=[],edges=[];
   const element=(dataset={})=>({dataset,style:{},value:'',disabled:false,focus(){host.ownerDocument.activeElement=this;},setAttribute(name,value){this[name]=String(value);}});
   const svg=element({naturalWidth:String(dimensions.scrollWidth),naturalHeight:String(dimensions.scrollHeight)});
   const picker=element(),zoom=element(),summary=element(),clear=element();
   for(const [selector,node] of [['.ktr-workflow-overview-svg',svg],['[data-workflow-overview-picker]',picker],['[data-workflow-overview-zoom]',zoom],['[data-workflow-overview-selection]',summary],['[data-workflow-overview-clear]',clear]])elements.set(selector,node);
   for(const match of html.matchAll(/<g\b([^>]*\bdata-workflow-overview-(?:node|actions)="[^"]*"[^>]*)>/g)){
    const attrs=Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],decode(m[2])]));
    const dataset=Object.fromEntries(Object.entries(attrs).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
    const node=element(dataset),select=element({workflowOverviewSelect:dataset.workflowOverviewNode});
    node.classList={contains:name=>(attrs.class||'').split(/\s+/).includes(name)};
    node.querySelector=selector=>selector==='[data-workflow-overview-select]'?select:null;
    (Object.hasOwn(dataset,'workflowOverviewNode')?nodes:edges).push(node);
   }
   svg.querySelectorAll=selector=>selector==='[data-workflow-overview-node]'?nodes:selector==='[data-workflow-overview-actions]'?edges:[];
   let left=0,top=0;canvas={generation,dataset:{}};
   Object.defineProperties(canvas,{
    clientWidth:{get:()=>dimensions.clientWidth},clientHeight:{get:()=>dimensions.clientHeight},
    scrollWidth:{get:()=>Math.max(dimensions.clientWidth,parseFloat(svg.style.width)||dimensions.scrollWidth)},
    scrollHeight:{get:()=>Math.max(dimensions.clientHeight,parseFloat(svg.style.height)||dimensions.scrollHeight)},
    scrollLeft:{get:()=>left,set:value=>{left=Math.max(0,Math.min(Number(value),canvas.scrollWidth-canvas.clientWidth));}},
    scrollTop:{get:()=>top,set:value=>{top=Math.max(0,Math.min(Number(value),canvas.scrollHeight-canvas.clientHeight));}}
   });
   elements.set('.ktr-workflow-overview-canvas',canvas);
   overview={dataset:{},ownerDocument:host.ownerDocument,querySelector:selector=>elements.get(selector)||null,querySelectorAll:svg.querySelectorAll,
    addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:name=>handlers.delete(name),
    dispatch:(name,target)=>handlers.get(name)?.({target,preventDefault(){},stopPropagation(){}})};
  }
 }});
 return host;
}
const canvas=host=>{const node=host.querySelector('.ktr-workflow-overview-canvas');assert.ok(node,'real workflow rendered an overview canvas');return node;};
const position=host=>({left:canvas(host).scrollLeft,top:canvas(host).scrollTop});
const overview=host=>host.querySelector('[data-workflow-overview-root]');
const control=(host,kind)=>overview(host).querySelector('[data-workflow-overview-'+kind+']');
const change=(host,kind,value)=>{const root=overview(host),field=control(host,kind);field.value=value;root.dispatch('change',field);};
const pan=(host,left,top,zoom='1')=>{change(host,'zoom',zoom);canvas(host).scrollLeft=left;canvas(host).scrollTop=top;};
const choose=(host,index=0)=>{const node=overview(host).querySelectorAll('[data-workflow-overview-node]')[index];assert.ok(node);change(host,'picker',node.dataset.workflowOverviewNode);return node.dataset.workflowOverviewNode;};
const reading=host=>({selected:control(host,'picker').value||null,zoom:control(host,'zoom').value,...position(host)});
async function setup({two=false}={}){
 const fixtures=[await makeComplexFixture()];if(two)fixtures.push(await makeComplexFixture({snapshotId:'position-workflow-2',revision:'58',environment:'preview'}));
 const f=fixture({create:args=>W.create({...args,scope})},{propose:args=>{const found=fixtures.find(x=>x.snapshot.snapshotId===args.businessSnapshot?.snapshotId);if(!found)throw Error('Unexpected request outside the synthetic document fixture');return structuredClone(found.answer);}}),c=f.controller,docs=[];
 for(const data of fixtures)docs.push(await restoreComplexDocument(c,data));
 await c.startBusiness(docs[0].id,'R1');c.showExplanation(docs[0].id);
 return {...f,c,docs};
}
const mount=(f,dimensions)=>{const host=hostOf(dimensions),view=V.create(host,{controller:f.c,connection:{canConsultBusiness:true}});return {host,view};};

test('主図は初回100%を保ち、非表示から現れても縮小しない',async()=>{
 const f=await setup(),before=f.c.getState();
 for(const dimensions of [wide,{...wide,scrollWidth:480}, {...wide,scrollWidth:656}]){
  const {host,view}=mount(f,dimensions);
  try{
   assert.deepEqual(reading(host),{selected:null,zoom:'1',left:0,top:0});
   const svg=overview(host).querySelector('.ktr-workflow-overview-svg'),scale=1;
   assert.equal(parseFloat(svg.style.width),dimensions.scrollWidth*scale);assert.equal(parseFloat(svg.style.height),dimensions.scrollHeight*scale);
   assert.ok(canvas(host).scrollWidth>=dimensions.scrollWidth);
  }finally{view.dispose();}
 }
 const hiddenDimensions={...wide,clientWidth:0},hidden=mount(f,hiddenDimensions);
 try{
  assert.deepEqual(position(hidden.host),{left:0,top:0});
  hiddenDimensions.clientWidth=wide.clientWidth;
  // The hidden SVG must be sized when it first becomes visible, rather than restoring an uninitialized size.
  assert.equal(canvas(hidden.host).clientWidth,wide.clientWidth);hidden.view.onVisible();
  assert.deepEqual(reading(hidden.host),{selected:null,zoom:'1',left:0,top:0});assert.equal(canvas(hidden.host).scrollWidth,wide.scrollWidth);
 }finally{hidden.view.dispose();}
 assert.deepEqual(f.c.getState(),before);assert.equal(f.count('propose'),0);assert.equal(f.writes.length,0);
});

test('同資料の再描画・再表示でも新しいDOMへ読んでいた横位置と縦位置を復元する',async()=>{
 const f=await setup(),before=f.c.getState(),wire=B.wire(before.businessContext),{host,view}=mount(f);
 try{
  const selected=choose(host,1);pan(host,2651,181);const old=canvas(host);view.render();assert.notEqual(canvas(host),old);assert.deepEqual(reading(host),{selected,zoom:'1',left:2651,top:181});
  pan(host,0,0);view.onVisible();assert.deepEqual(reading(host),{selected,zoom:'1',left:0,top:0},'intentional edge and zoom survive redraw');
  assert.deepEqual(f.c.getState(),before);assert.deepEqual(B.wire(f.c.getState().businessContext),wire);assert.equal(f.count('propose'),0);assert.equal(f.writes.length,0);
 }finally{view.dispose();}
});

test('初回の非表示再描画でも選択工程と倍率を保存し、再表示で失わない',async()=>{
 const f=await setup(),dimensions={...wide},{host,view}=mount(f,dimensions),before=f.c.exportSession(),wire=B.wire(f.c.getState().businessContext);
 try{
  const selected=choose(host,1);change(host,'zoom','1.5');
  dimensions.clientWidth=0;
  for(let repeat=0;repeat<2;repeat++){
   view.render();assert.equal(control(host,'picker').value,selected);assert.equal(control(host,'zoom').value,'1.5');
  }
  dimensions.clientWidth=wide.clientWidth;view.onVisible();
  assert.deepEqual(reading(host),{selected,zoom:'1.5',left:0,top:0});
  assert.deepEqual(f.c.exportSession(),before);assert.deepEqual(B.wire(f.c.getState().businessContext),wire);assert.equal(f.count('propose'),0);assert.equal(f.writes.length,0);
 }finally{view.dispose();}
});

test('非表示時のゼロ位置で記憶済み位置を上書きせず、最新の選択と倍率だけを更新する',async()=>{
 const f=await setup(),dimensions={...wide},{host,view}=mount(f,dimensions),before=f.c.exportSession(),wire=B.wire(f.c.getState().businessContext);
 try{
  choose(host,1);pan(host,2300,180);view.render();
  const selected=choose(host,2);change(host,'zoom','1.5');
  dimensions.clientWidth=0;canvas(host).scrollLeft=0;canvas(host).scrollTop=0;
  view.render();assert.equal(control(host,'picker').value,selected);assert.equal(control(host,'zoom').value,'1.5');
  canvas(host).scrollLeft=0;canvas(host).scrollTop=0;view.render();
  dimensions.clientWidth=wide.clientWidth;view.onVisible();
  assert.deepEqual(reading(host),{selected,zoom:'1.5',left:2300,top:180});
  assert.deepEqual(f.c.exportSession(),before);assert.deepEqual(B.wire(f.c.getState().businessContext),wire);assert.equal(f.count('propose'),0);assert.equal(f.writes.length,0);
 }finally{view.dispose();}
});

test('同じ分析でも説明と工程相談ではスクロール位置を別々に保持する',async()=>{
 const f=await setup(),{host,view}=mount(f),doc=f.docs[0],before=structuredClone(f.c.getState().businessContext),wire=B.wire(before);
 try{
  const documentNode=choose(host,1);pan(host,2500,90);f.c.showChanges();assert.deepEqual(reading(host),{selected:null,zoom:'1',left:0,top:0});
  const consultationNode=choose(host,2);pan(host,415,130,'1.5');f.c.showExplanation(doc.id);assert.deepEqual(reading(host),{selected:documentNode,zoom:'1',left:2500,top:90});
  f.c.showChanges();assert.deepEqual(reading(host),{selected:consultationNode,zoom:'1.5',left:415,top:130});
  assert.deepEqual(f.c.getState().businessContext,before);assert.deepEqual(B.wire(f.c.getState().businessContext),wire);assert.equal(f.count('propose'),0);assert.equal(f.writes.length,0);
 }finally{view.dispose();}
});

test('別資料と同じanalysisIdの別analysisHashへ読んでいた位置を混ぜず、初回100%表示へ戻る',async()=>{
 const f=await setup({two:true}),{host,view}=mount(f),[first,second]=f.docs;
 try{
  pan(host,2400,111);f.c.showExplanation(second.id);assert.deepEqual(reading(host),{selected:null,zoom:'1',left:0,top:0});
  pan(host,700,222);f.c.showExplanation(first.id);assert.deepEqual(position(host),{left:2400,top:111});
  f.c.showExplanation(second.id);assert.deepEqual(position(host),{left:700,top:222});
  f.c.showChanges();assert.deepEqual(reading(host),{selected:null,zoom:'1',left:0,top:0});pan(host,2700,333);
  const state=f.c.getState(),before=structuredClone(state),alternate=await B.create({...second,id:first.id},scope,'R1');
  assert.equal(alternate.analysisId,state.businessContext.analysisId);assert.notEqual(alternate.analysisHash,state.businessContext.analysisHash);await B.verify(alternate,scope);
  view.render({...state,businessContext:alternate});assert.deepEqual(reading(host),{selected:null,zoom:'1',left:0,top:0});pan(host,123,444);
  view.render(state);assert.deepEqual(position(host),{left:2700,top:333});
  view.render({...state,businessContext:alternate});assert.deepEqual(position(host),{left:123,top:444});
  assert.deepEqual(f.c.getState(),before);assert.equal(f.count('propose'),0);assert.equal(f.writes.length,0);
 }finally{view.dispose();}
});

test('表示をリセットすると説明・工程相談双方の位置だけを消し、保存本体と送信範囲は変えない',async()=>{
 const f=await setup(),{host,view}=mount(f),doc=f.docs[0];
 try{
  choose(host,1);pan(host,2600,99);f.c.showChanges();choose(host,2);pan(host,500,210);const before=f.c.getState(),wire=B.wire(before.businessContext),saved=f.c.exportSession();
  view.resetDisplay();assert.deepEqual(reading(host),{selected:null,zoom:'1',left:0,top:0});assert.deepEqual(f.c.getState(),before);assert.deepEqual(B.wire(f.c.getState().businessContext),wire);assert.deepEqual(f.c.exportSession(),saved);
  f.c.showExplanation(doc.id);assert.deepEqual(reading(host),{selected:null,zoom:'1',left:0,top:0},'reset also cleared the hidden document selection and zoom');
  assert.equal(f.count('propose'),0);assert.equal(f.writes.length,0);
 }finally{view.dispose();}
});

test('新しい作業の開始を取り消すと位置を保ち、開始後に同じ会話を復元すると双方を初回位置へ戻す',async()=>{
 const f=await setup(),host=hostOf();let allow=false,prompts=0;
 const view=V.create(host,{controller:f.c,connection:{canConsultBusiness:true},onNewTask:()=>{prompts++;return allow;}});
 try{
  pan(host,2500,91);f.c.showChanges();pan(host,390,205);f.c.showExplanation(f.docs[0].id);
  const before=f.c.getState(),saved=f.c.exportSession(),wire=B.wire(before.businessContext);
  // Public UI entry point runs the same action handler used by the completed-task button.
  assert.equal(await view.newTask(),false);assert.equal(prompts,1);assert.deepEqual(position(host),{left:2500,top:91});assert.deepEqual(f.c.getState(),before);
  f.c.showChanges();assert.deepEqual(position(host),{left:390,top:205});f.c.showExplanation(f.docs[0].id);
  allow=true;assert.equal(await view.newTask(),true);assert.equal(prompts,2);assert.equal(host.querySelector('.ktr-workflow-overview-canvas'),null);assert.equal(f.c.getState().businessContext,null);assert.equal(f.c.getState().explanations.length,0);
  assert.equal(await f.c.restoreSession(saved),true);assert.deepEqual(reading(host),{selected:null,zoom:'1',left:0,top:0});assert.deepEqual(B.wire(f.c.getState().businessContext),wire);
  f.c.showChanges();assert.deepEqual(reading(host),{selected:null,zoom:'1',left:0,top:0});assert.equal(f.count('propose'),0);assert.equal(f.writes.length,0);
 }finally{view.dispose();}
});
