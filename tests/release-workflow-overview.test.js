'use strict';
// Offline unit tests for local reading controls. No browser, provider, or application APIs.
const test=require('node:test'),assert=require('node:assert/strict');
const {KTWorkflowOverview:O}=require('../src/release-workflow-overview.js');
const originalFetch=globalThis.fetch;
test.before(()=>{globalThis.fetch=()=>{throw Error('Network prohibited in overview unit tests');};});
test.after(()=>{globalThis.fetch=originalFetch;});
function fakeRoot({width=4000,height=1000,available=800,names={},animationFrames=false}={}){
 const listeners=new Map(),frames=new Map(),styles={};let resizeCallback=null,disconnected=false,observed=null,focus=null,frameId=0,scheduled=0,cancelled=0,styleWrites=0,lastScheduledCallback=null;
 const win={ResizeObserver:class{constructor(fn){resizeCallback=fn;}observe(el){observed=el;}disconnect(){disconnected=true;}}};
 if(animationFrames){win.requestAnimationFrame=fn=>{const id=++frameId;frames.set(id,fn);scheduled++;lastScheduledCallback=fn;return id;};win.cancelAnimationFrame=id=>{frames.delete(id);cancelled++;};}
 const root={dataset:{},ownerDocument:{defaultView:win},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name),contains:el=>el?.fixtureRoot===root};
 const control=(kind,key)=>({fixtureRoot:root,tagName:kind==='anchor'?'A':'BUTTON',dataset:key?{workflowOverviewSelect:key}:{},attributes:{},setAttribute(name,value){this.attributes[name]=value;},focus(){focus=this;},closest(selector){
  if(selector==='[data-workflow-overview-select]')return this.dataset.workflowOverviewSelect?this:null;
  if(selector==='a[data-workflow-overview-select]')return kind==='anchor'?this:null;
  if(selector==='.ktr-workflow-neighbors')return kind==='neighbor'?{}:null;
  if(selector==='[data-workflow-overview-clear]')return kind==='clear'?this:null;
  return null;
 }});
 const nodes=['A','B','C','D','missing-4'].map(key=>{const anchor=control('anchor',key);return {dataset:{workflowOverviewNode:key,workflowOverviewName:names[key]||key,workflowOverviewTarget:key.startsWith('missing')?'':names.target||'stage-'+key},classList:{contains:name=>name==='ktr-workflow-overview-missing'&&key.startsWith('missing')},anchor,querySelector:selector=>selector==='[data-workflow-overview-select]'?anchor:null};});
 const pairs=[['A','B','P1 P2'],['B','A','P3'],['B','B','P4'],['B','C','P5'],['D','C','P6'],['missing-4','B','P7']];
 const edges=pairs.map(([from,to,ids])=>({dataset:{workflowOverviewFrom:from,workflowOverviewTo:to,workflowOverviewActions:ids}}));
 const style={};for(const key of ['width','height'])Object.defineProperty(style,key,{enumerable:true,get:()=>styles[key],set:value=>{styleWrites++;styles[key]=value;}});
 const canvas={clientWidth:available,clientHeight:320,scrollLeft:0,scrollTop:0,dataset:{}},svg={dataset:{naturalWidth:String(width),naturalHeight:String(height)},style,querySelectorAll:selector=>selector==='[data-workflow-overview-node]'?nodes:selector==='[data-workflow-overview-actions]'?edges:[]};
 const picker={...control('picker'),value:''},zoomPicker={...control('zoom'),value:'fit'},summary={innerHTML:''},clear={...control('clear'),disabled:false};
 const elements={'.ktr-workflow-overview-canvas':canvas,'.ktr-workflow-overview-svg':svg,'[data-workflow-overview-picker]':picker,'[data-workflow-overview-zoom]':zoomPicker,'[data-workflow-overview-selection]':summary,'[data-workflow-overview-clear]':clear};
 root.querySelector=selector=>elements[selector]||null;
 const dispatch=(type,target,key,extra={})=>{const result={prevented:false,stopped:false};listeners.get(type)?.({target,key,...extra,preventDefault(){result.prevented=true;},stopPropagation(){result.stopped=true;}});return result;};
 return {root,nodes,edges,canvas,svg,picker,zoomPicker,summary,clear,dispatch,neighbor:key=>control('neighbor',key),resize(value){canvas.clientWidth=value;resizeCallback?.([]);},flushFrames(){const pending=[...frames.values()];frames.clear();for(const fn of pending)fn(100);},get pendingFrames(){return frames.size;},get scheduled(){return scheduled;},get cancelled(){return cancelled;},get styleWrites(){return styleWrites;},get lastScheduledCallback(){return lastScheduledCallback;},get disconnected(){return disconnected;},get observed(){return observed;},get focus(){return focus;}};
}
const nodeFocus=f=>Object.fromEntries(f.nodes.map(n=>[n.dataset.workflowOverviewNode,n.dataset.workflowFocus]));
const edgeFocus=f=>f.edges.map(e=>e.dataset.workflowFocus);

test('主図は大きい図や狭い幅でも縮小せず、非表示からの復帰でも倍率を保つ',()=>{
 assert.equal(O.scaleFor(4000,1000,800),1);assert.equal(O.scaleFor(400,2000,280),1);
 assert.equal(O.scaleFor(400,100,800),1);assert.equal(O.scaleFor(4000,1000,800,'1.5'),1.5);assert.equal(O.scaleFor(4000,1000,800,'2'),2);
 assert.equal(O.scaleFor(4000,1000,800,'fit'),1,'legacy fit cannot make labels unreadable');
 for(const dimensions of [[0,100,800],[400,0,800],[400,100,0]])assert.equal(O.scaleFor(...dimensions),null);
 const f=fakeRoot({available:0}),reader=O.mount(f.root);assert.equal(f.svg.style.width,undefined);
 f.resize(800);assert.equal(f.svg.style.width,'4000px');assert.equal(f.svg.style.height,'1000px');
 f.canvas.scrollLeft=100;f.canvas.scrollTop=50;f.resize(400);assert.equal(f.svg.style.width,'4000px');
 assert.deepEqual(reader.getState(),{selected:null,zoom:'1',left:100,top:50});reader.dispose();
});

test('直接の前後・双方向・自己ループだけを強調し、関連外の工程と全操作IDを残す',()=>{
 const f=fakeRoot(),reader=O.mount(f.root),originalActions=f.edges.map(e=>e.dataset.workflowOverviewActions);
 reader.select('B');assert.equal(f.root.dataset.workflowHasSelection,'true');assert.equal(f.picker.value,'B');assert.equal(f.clear.disabled,false);
 assert.deepEqual(nodeFocus(f),{A:'both',B:'selected',C:'next',D:'unrelated','missing-4':'previous'});
 assert.deepEqual(edgeFocus(f),['incoming','outgoing','both','outgoing','unrelated','incoming']);
 assert.equal(f.nodes.find(n=>n.dataset.workflowOverviewNode==='B').anchor.attributes['aria-pressed'],'true');
 assert.match(f.summary.innerHTML,/B（同じ工程）/);assert.match(f.summary.innerHTML,/前工程/);assert.match(f.summary.innerHTML,/次工程/);
 assert.equal(f.nodes.length,5);assert.equal(f.edges.length,6);assert.deepEqual(f.edges.map(e=>e.dataset.workflowOverviewActions),originalActions);
 reader.select('not-in-this-diagram');assert.equal(reader.getState().selected,null);assert.equal(f.root.dataset.workflowHasSelection,'false');assert.ok(Object.values(nodeFocus(f)).every(value=>value===''));assert.ok(edgeFocus(f).every(value=>value===''));reader.dispose();
});

test('ノードのEnter・Spaceと選択欄は同じ選択となり、Escape・解除で選択を消す',()=>{
 const f=fakeRoot(),reader=O.mount(f.root),anchor=f.nodes[1].anchor;
 for(const key of ['Enter',' ']){reader.select(null);assert.deepEqual(f.dispatch('keydown',anchor,key),{prevented:true,stopped:true});assert.equal(reader.getState().selected,'B');}
 f.picker.value='A';assert.deepEqual(f.dispatch('change',f.picker),{prevented:false,stopped:true});assert.equal(reader.getState().selected,'A');
 assert.deepEqual(f.dispatch('click',f.neighbor('C')),{prevented:true,stopped:true});assert.equal(reader.getState().selected,'C');assert.equal(f.focus,f.picker);
 assert.deepEqual(f.dispatch('keydown',f.picker,'Escape'),{prevented:true,stopped:true});assert.equal(reader.getState().selected,null);assert.equal(f.clear.disabled,true);
 reader.select('B');assert.deepEqual(f.dispatch('click',f.clear),{prevented:true,stopped:true});assert.equal(reader.getState().selected,null);
 assert.deepEqual(f.dispatch('keydown',anchor,'ArrowRight'),{prevented:false,stopped:false});reader.dispose();
});

test('選択概要の工程名・リンク先はHTMLを実行させず、未取得状態に偽の詳細リンクを作らない',()=>{
 const f=fakeRoot({names:{B:'<img src=x onerror="bad()"> & \'確認\'',target:'stage" onclick="bad()'}}),reader=O.mount(f.root);
 reader.select('B');assert.doesNotMatch(f.summary.innerHTML,/<img|<script| href="#stage" onclick=/);assert.match(f.summary.innerHTML,/&lt;img/);assert.match(f.summary.innerHTML,/&quot; onclick=&quot;/);assert.match(f.summary.innerHTML,/&#39;確認&#39;/);
 reader.select('missing-4');assert.match(f.summary.innerHTML,/未取得：missing-4/);assert.match(f.summary.innerHTML,/状態の定義は未取得です/);assert.doesNotMatch(f.summary.innerHTML,/工程の詳細を見る/);reader.dispose();
});

test('100%・150%・200%の切替は見ていた中心を保ち、読書状態だけを返す',()=>{
 const initial=Object.freeze({selected:'B',zoom:'1.5',left:400,top:170}),f=fakeRoot(),reader=O.mount(f.root,initial);
 assert.equal(f.svg.style.width,'6000px');assert.deepEqual(reader.getState(),initial);
 const center=()=>({x:(f.canvas.scrollLeft+f.canvas.clientWidth/2)/Number(reader.getState().zoom),y:(f.canvas.scrollTop+f.canvas.clientHeight/2)/Number(reader.getState().zoom)}),before=center();
 for(const zoom of ['2','1','1.5']){reader.setZoom(zoom);assert.ok(Math.abs(center().x-before.x)<1e-9);assert.ok(Math.abs(center().y-before.y)<1e-9);}
 const current=reader.getState();reader.setZoom('fit');reader.setZoom('999');assert.deepEqual(reader.getState(),current);
 const leaked=reader.getState();leaked.selected='D';assert.equal(reader.getState().selected,'B');
 assert.deepEqual(Object.keys(reader.getState()).sort(),['left','selected','top','zoom']);assert.deepEqual(initial,{selected:'B',zoom:'1.5',left:400,top:170});reader.dispose();
});

test('破棄後はResizeObserverと操作の更新を止め、図がない場合は安全に何もしない',()=>{
 assert.equal(O.mount(null),null);assert.equal(O.mount({querySelector:()=>null}),null);
 const f=fakeRoot(),reader=O.mount(f.root,{selected:'B',zoom:'invalid'});assert.equal(reader.getState().zoom,'1');const before=reader.getState(),size={...f.svg.style},summary=f.summary.innerHTML;
 reader.dispose();assert.equal(f.disconnected,true);f.resize(200);reader.select('A');reader.setZoom('1.5');f.dispatch('click',f.nodes[0].anchor);
 assert.deepEqual(reader.getState(),before);assert.deepEqual(f.svg.style,size);assert.equal(f.summary.innerHTML,summary);
});

test('表示領域の連続リサイズは次フレームへまとめ、主図の寸法を書き換えない',()=>{
 const f=fakeRoot({animationFrames:true}),reader=O.mount(f.root);
 assert.equal(f.styleWrites,2);f.canvas.clientHeight=200;f.resize(800);f.canvas.clientHeight=360;f.resize(800);f.resize(600);f.resize(400);
 assert.equal(f.scheduled,1);assert.equal(f.pendingFrames,1);assert.equal(f.svg.style.width,'4000px');
 f.flushFrames();assert.equal(f.styleWrites,2);assert.equal(f.pendingFrames,0);
 f.resize(400);reader.setZoom('1');assert.equal(f.scheduled,1);assert.equal(f.styleWrites,2);reader.dispose();
});

test('非表示からの幅変更を予約した後に破棄すると予約を取消し、遅れて届く通知もDOMを更新しない',()=>{
 const f=fakeRoot({available:0,animationFrames:true}),reader=O.mount(f.root);
 assert.equal(f.styleWrites,0);f.resize(800);assert.equal(f.pendingFrames,1);assert.equal(f.styleWrites,0);
 const late=f.lastScheduledCallback,before=reader.getState();reader.dispose();
 assert.equal(f.disconnected,true);assert.equal(f.cancelled,1);assert.equal(f.pendingFrames,0);
 f.flushFrames();late(200);f.resize(600);reader.setZoom('1.5');
 assert.equal(f.styleWrites,0);assert.equal(f.scheduled,1);assert.deepEqual(reader.getState(),before);
});

test('案内図の表示範囲は倍率とスクロールに一致し、図の端を越えない',()=>{
 assert.deepEqual(O.viewportFor(4000,1000,1,800,400,1200,300),{x:1200,y:300,width:800,height:400});
 assert.deepEqual(O.viewportFor(4000,1000,2,800,400,2400,600),{x:1200,y:300,width:400,height:200});
 assert.deepEqual(O.viewportFor(4000,1000,1,800,400,99999,-100),{x:3200,y:0,width:800,height:400});
 assert.deepEqual(O.viewportFor(200,100,1,800,400,0,0),{x:0,y:0,width:200,height:100});
});
test('案内図の余白を除いてクリック位置を変換し、横長・縦長の図の端も扱う',()=>{
 assert.deepEqual(O.mapPoint(4000,1000,{left:10,top:20,width:400,height:200},210,120),{x:2000,y:500});
 assert.deepEqual(O.mapPoint(4000,1000,{left:10,top:20,width:400,height:200},410,220),{x:4000,y:1000});
 assert.deepEqual(O.mapPoint(1000,4000,{left:10,top:20,width:200,height:400},110,220),{x:500,y:2000});
});

function mapRoot(){
 const f=fakeRoot(),attrs={},listeners=new Map(),q=f.root.querySelector;
 const map={querySelectorAll:()=>[],getBoundingClientRect:()=>({left:0,top:0,width:400,height:100}),setPointerCapture(){},releasePointerCapture(){}};
 const wide={setAttribute(){},focus(){}},viewport={setAttribute:(k,v)=>attrs[k]=Number(v)};
 f.canvas.addEventListener=(n,fn)=>listeners.set(n,fn);f.canvas.removeEventListener=n=>listeners.delete(n);
 f.root.querySelector=selector=>selector==='[data-workflow-minimap]'?map:selector==='[data-workflow-map-viewport]'?viewport:selector==='[data-workflow-wide]'?wide:q(selector);
 for(const n of f.nodes){const old=n.querySelector;n.querySelector=selector=>selector==='rect'?{getAttribute:k=>({x:2000,y:400,width:168,height:60}[k])}:old(selector);}
 const target=area=>({closest:s=>s==='[data-workflow-minimap],.ktr-workflow-overview-canvas'?area:null});
 return {...f,map,attrs,wide,canvasTarget:target(f.canvas),mapTarget:target(map),scroll:()=>listeners.get('scroll')?.()};
}
test('主図のスクロール・矢印・案内図クリックが同じ表示範囲に同期する',()=>{
 const f=mapRoot(),reader=O.mount(f.root);
 assert.deepEqual(f.attrs,{x:0,y:0,width:800,height:320});
 f.canvas.scrollLeft=400;f.canvas.scrollTop=120;f.scroll();assert.deepEqual(f.attrs,{x:400,y:120,width:800,height:320});
 f.dispatch('keydown',f.canvas,'ArrowRight');assert.equal(reader.getState().left,520);assert.equal(f.attrs.x,520);
 f.dispatch('pointerdown',f.mapTarget,undefined,{button:0,pointerId:1,clientX:200,clientY:50});
 assert.deepEqual(f.attrs,{x:1600,y:340,width:800,height:320});
 f.dispatch('pointermove',f.mapTarget,undefined,{pointerId:1,clientX:999,clientY:999});
 assert.deepEqual(f.attrs,{x:3200,y:680,width:800,height:320});
 f.dispatch('pointerup',f.mapTarget,undefined,{pointerId:1});
 f.dispatch('keydown',f.canvas,'Home');assert.deepEqual(f.attrs,{x:0,y:0,width:800,height:320});reader.dispose();
});
test('ドラッグは主図を移動し、終了・中断・破棄後の動きを止める',()=>{
 const f=mapRoot(),reader=O.mount(f.root);
 f.dispatch('pointerdown',f.canvasTarget,undefined,{button:0,pointerId:2,clientX:500,clientY:300});
 f.dispatch('pointermove',f.canvasTarget,undefined,{pointerId:2,clientX:300,clientY:200});
 assert.deepEqual(f.attrs,{x:200,y:100,width:800,height:320});
 f.dispatch('pointercancel',f.canvasTarget,undefined,{pointerId:2});
 f.dispatch('pointermove',f.canvasTarget,undefined,{pointerId:2,clientX:0,clientY:0});assert.equal(reader.getState().left,200);
 reader.dispose();f.canvas.scrollLeft=999;f.scroll();assert.equal(f.attrs.x,200);
});
test('選択工程を主図へ移動し、広い表示から詳細へ進むと通常表示に戻す',()=>{
 const f=mapRoot(),reader=O.mount(f.root);reader.select('B');assert.equal(reader.getState().left,1684);assert.equal(reader.getState().top,270);
 const wide={closest:s=>s==='[data-workflow-wide]'?{}:null};
 f.dispatch('click',wide);assert.equal(f.root.dataset.workflowExpanded,'true');
 f.dispatch('keydown',f.canvas,'Escape');assert.equal(f.root.dataset.workflowExpanded,'false');assert.equal(reader.getState().selected,'B');
 f.dispatch('click',wide);f.dispatch('click',{closest:s=>s==='.ktr-workflow-overview-detail'?{}:null});assert.equal(f.root.dataset.workflowExpanded,'false');reader.dispose();
});
