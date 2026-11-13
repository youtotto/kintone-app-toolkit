'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('./helpers/business-fixture.js');
const {KTWorkflowDiagram:D}=require('../src/release-workflow-diagram.js');
const {KTBusinessView:V}=require('../src/release-business-view.js');
function pathPoints(path){
 const tokens=path.match(/[MVH]|-?\d+(?:\.\d+)?/g),points=[];let x,y;
 while(tokens.length){const command=tokens.shift();if(command==='M'){x=Number(tokens.shift());y=Number(tokens.shift());}else if(command==='V')y=Number(tokens.shift());else if(command==='H')x=Number(tokens.shift());else assert.fail('unexpected SVG path command');points.push({x,y});}
 return points;
}
function assertClearPaths(graph,compact){
 for(const edge of graph.edges){
  const points=pathPoints(edge.path);
  assert.deepEqual(points[0],{x:edge.from.x+edge.from.w/2-(compact?8:0),y:edge.from.y+edge.from.h},edge.evidence.evidenceId+' starts at its source');
  assert.deepEqual(points.at(-1),{x:edge.to.x+edge.to.w/2+(compact?8:0),y:edge.to.y},edge.evidence.evidenceId+' ends at its destination');
  for(const point of points)assert.ok(point.x>=0&&point.x<=graph.width&&point.y>=0&&point.y<=graph.height,'path remains in the diagram');
  for(let i=1;i<points.length;i++){
   const a=points[i-1],b=points[i];
   for(const n of graph.nodes){
    const crosses=a.y===b.y?a.y>n.y&&a.y<n.y+n.h&&Math.max(Math.min(a.x,b.x),n.x)<Math.min(Math.max(a.x,b.x),n.x+n.w):a.x>n.x&&a.x<n.x+n.w&&Math.max(Math.min(a.y,b.y),n.y)<Math.min(Math.max(a.y,b.y),n.y+n.h);
    assert.equal(crosses,false,edge.evidence.evidenceId+' crosses node '+n.name+' via '+edge.path);
   }
  }
 }
}
const process=s=>({states:s.evidence.filter(e=>e.kind==='process_state'),actions:s.evidence.filter(e=>e.kind==='process_action')});
const htmlIds=html=>[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
const nodeLink=(html,id)=>html.match(new RegExp('data-workflow-node="'+id+'"[\\s\\S]*?<a href="#([^"]+)"[^>]*data-workflow-node-target="([^"]+)"'))?.slice(1);
function graphRaw(){const d=F.raw();d.process.states.保留={name:'保留',index:'2',assignee:{type:'ALL',entities:[]}};d.process.actions.push({name:'保留する',from:'申請済み',to:'保留',filterCond:'memo = "要調査"',type:'PRIMARY'},{name:'再開する',from:'保留',to:'申請済み',filterCond:'',type:'PRIMARY'},{name:'再確認する',from:'申請済み',to:'申請済み',filterCond:'',type:'PRIMARY'},{name:'特別に進める',from:'申請済み',to:'確認済み',filterCond:'memo = "特別"',type:'PRIMARY'});return d;}

test('取得した分岐・戻り・自己遷移・同じ両端の複数操作を決定的な図に全件保持する',async()=>{
 const {s}=await F.snapshot({data:graphRaw()}),p=process(s),g=D.layout(p.states,p.actions),h=D.render({...p,prefix:'test-diagram'});
 assert.equal(g.nodes.length,3);assert.equal(g.edges.length,6);assert.ok(g.width<=600,'3-state branching graph fits the normal pane');assert.deepEqual(D.layout(p.states,p.actions),g);
 assert.ok(g.edges.some(e=>e.kind==='return'));assert.ok(g.edges.some(e=>e.kind==='self'));
 for(const e of p.actions){const edge=g.edges.find(x=>x.evidence.evidenceId===e.evidenceId);assert.equal(edge.from.name,e.value.from);assert.equal(edge.to.name,e.value.to);assert.equal((h.match(new RegExp('data-workflow-edge="'+e.evidenceId+'"','g'))||[]).length,1);assert.ok(edge.path.startsWith('M '));}
 assert.equal(g.edges.filter(e=>e.from.name==='申請済み'&&e.to.name==='確認済み').length,2);
 assert.equal((h.match(/marker-end=/g)||[]).length,6);assert.equal((h.match(/data-workflow-node=/g)||[]).length,3);
 assert.match(h,/data-natural-width="\d+"/);assert.match(h,/data-natural-height="\d+"/);assert.match(h,/data-workflow-scale/);
 for(const value of ['0.5','0.75','1','1.25','1.5'])assert.ok(h.includes('value="'+value+'"'));
});

test('工程カードを先に表示し、補足図は完全一致した有効processStateIdだけを工程説明へ結ぶ',async()=>{
 const {s}=await F.snapshot(),o=F.workflowOutput(s),p=process(s),h=V.outputHtml(o,s);
 assert.ok(h.indexOf('data-workflow-rule=')<h.indexOf('data-workflow-diagram'));assert.match(h,/<details class="ktr-workflow-reference"><summary>/);
 const linked=nodeLink(h,o.rules[0].processStateId);assert.equal(linked[1],'stage');assert.ok(h.includes('id="'+linked[0]+'"'));
 const other=p.states.find(e=>e.evidenceId!==o.rules[0].processStateId),unlinked=nodeLink(h,other.evidenceId);assert.equal(unlinked[1],'setting');assert.ok(h.includes('id="'+unlinked[0]+'" data-process-state="'+other.evidenceId+'"'));
 o.rules[0].processStateId=null;o.rules[0].stageName=p.states[0].value.name;const sameName=V.outputHtml(o,s);assert.doesNotMatch(sameName,/data-workflow-node-target="stage"/);
 for(const m of h.matchAll(/href="#([^"]+)"/g))assert.ok(h.includes('id="'+m[1]+'"'),m[1]);
});

test('無効定義の図は参考であることを明示し、古い対応IDが残っても推測工程へ接続しない',async()=>{
 const d=graphRaw();d.process.enable=false;const {s}=await F.snapshot({data:d}),o=F.workflowOutput(s);o.rules[0].processStateId=process(s).states[0].evidenceId;
 const h=V.outputHtml(o,s);assert.match(h,/参考：無効なプロセス定義の遷移図/);assert.match(h,/data-workflow-diagram-disabled="true"/);assert.doesNotMatch(h,/data-workflow-node-target="stage"/);
 assert.equal((h.match(/data-workflow-edge=/g)||[]).length,6);assert.equal((h.match(/data-workflow-node-target="setting"/g)||[]).length,3);
 assert.match(h,/現行の工程やJavaScriptの操作と接続して解釈しません/);
});

test('複数の同一snapshot描画でも図・工程・全ての根拠idを共有せずリンク先が実在する',async()=>{
 const {s}=await F.snapshot(),o=F.workflowOutput(s),a=V.outputHtml(o,s),b=V.outputHtml(o,s),c=V.processHtml(s),all=a+b+c,ids=htmlIds(all);
 assert.equal(new Set(ids).size,ids.length);
 for(const html of [a,b,c]){const own=new Set(htmlIds(html));for(const m of html.matchAll(/href="#([^"]+)"/g))assert.ok(own.has(m[1]),m[1]);for(const m of html.matchAll(/marker-end="url\(#([^)]*)\)"/g))assert.ok(own.has(m[1]),m[1]);}
});

test('長い状態名・操作名・絵文字を省略せず折り返し、HTMLとして実行させない',()=>{
 const name='確認<&"\'>😀'.repeat(25),action='操作<script>alert(1)</script>😀'.repeat(8);
 const states=[{evidenceId:'B1',value:{name}}],actions=[{evidenceId:'B2',value:{name:action,from:name,to:name}}];
 const g=D.layout(states,actions),h=D.render({states,actions,prefix:'safe'});
 assert.equal(g.nodes[0].lines.join(''),name);assert.equal(g.edges[0].lines.join(''),action);assert.ok(g.nodes[0].lines.every(line=>Array.from(line).length<=12));
 assert.ok(g.nodes[0].h>=g.nodes[0].lines.length*18+44);assert.ok(g.height>g.nodes[0].h);
 assert.doesNotMatch(h,/<script|<img|onerror=/);assert.match(h,/&lt;script&gt;/);assert.ok(!h.includes('\ufffd'));
});

test('取得不可と明示設定なしには偽の遷移図を作らない',async()=>{
 const denied=F.raw();denied.process=Object.assign(Error('denied'),{status:403});const {s}=await F.snapshot({data:denied}),h=V.processHtml(s);assert.match(h,/権限不足で取得不可/);assert.doesNotMatch(h,/<svg/);
 const empty=F.raw();empty.process={enable:false,states:{},actions:[],revision:'22'};const {s:e}=await F.snapshot({data:empty}),eh=V.processHtml(e);assert.match(eh,/取得済み・明示設定なし/);assert.doesNotMatch(eh,/<svg/);
});

test('欠けた遷移先のある保存物もアクションを落とさず未取得状態として区別する',()=>{
 const states=[{evidenceId:'B1',value:{name:'開始'}}],actions=[{evidenceId:'B2',value:{name:'進む',from:'開始',to:'不明な状態'}}];
 const g=D.layout(states,actions),h=D.render({states,actions,prefix:'missing'});assert.equal(g.edges.length,1);assert.equal(g.nodes.length,2);assert.equal(g.nodes.filter(n=>n.missing).length,1);assert.match(h,/未取得：不明な状態/);assert.match(h,/ktr-workflow-diagram-missing/);
});

test('概要図の独立した交差遷移は横線を共有せず、分岐・自己遷移と区別する',()=>{
 const states=['A','B','C','D'].map((name,i)=>({evidenceId:'B'+(i+1),value:{name}}));
 const actions=[{evidenceId:'B5',value:{name:'操作1',from:'A',to:'D'}},{evidenceId:'B6',value:{name:'操作2',from:'B',to:'C'}}];
 const graph=D.layout(states,actions,{compact:true});assert.equal(graph.edges.length,2);assert.notEqual(graph.edges[0].midY,graph.edges[1].midY);
 const segments=path=>{const values=path.match(/M ([\d.]+) ([\d.]+) V ([\d.]+) H ([\d.]+) V ([\d.]+)/).slice(1).map(Number),[sx,sy,mid,tx,ty]=values;return [{axis:'v',at:sx,lo:Math.min(sy,mid),hi:Math.max(sy,mid)},{axis:'h',at:mid,lo:Math.min(sx,tx),hi:Math.max(sx,tx)},{axis:'v',at:tx,lo:Math.min(mid,ty),hi:Math.max(mid,ty)}];};
 for(const a of segments(graph.edges[0].path))for(const b of segments(graph.edges[1].path))assert.ok(a.axis!==b.axis||a.at!==b.at||Math.min(a.hi,b.hi)<=Math.max(a.lo,b.lo),'independent connections must not share a line segment');
 assert.equal(graph.edges[0].from.name,'A');assert.equal(graph.edges[0].to.name,'D');assert.equal(graph.edges[1].from.name,'B');assert.equal(graph.edges[1].to.name,'C');
 const tops=graph.nodes.filter(n=>n.rank===1).map(n=>n.y);assert.ok(graph.edges.every(e=>e.midY<Math.min(...tops)));
});

test('概要の大きい図は全体表示用の寸法を持ち、未取得端点も操作も保持する',()=>{
 const states=Array.from({length:12},(_,i)=>({evidenceId:'B'+i,value:{name:'工程'+i}}));
 const actions=[{evidenceId:'B20',value:{name:'続ける',from:'工程0',to:'未取得の工程'}}];
 const graph=D.layout(states,actions,{compact:true}),html=D.renderOverview({states,actions,prefix:'readable'});
 assert.doesNotMatch(html,/min-width/);assert.ok(html.includes('data-natural-width="'+graph.width+'"'));assert.ok(html.includes('data-natural-height="'+graph.height+'"'));assert.match(html,/ktr-workflow-overview-missing/);assert.match(html,/状態の定義が未取得/);assert.match(html,/data-workflow-overview-actions="B20"/);
 const unsafe=D.renderOverview({stages:[{ruleId:'R1',stageName:'<img src=x onerror=alert(1)>'}],stageTarget:()=>'<target>',prefix:'unsafe'});assert.doesNotMatch(unsafe,/<img/);assert.match(unsafe,/&lt;img/);assert.match(unsafe,/href="#&lt;target&gt;"/);
});

test('概要図の全工程を選択でき、未取得は詳細を偽らず区別し、選択結果は図の後に表示する',()=>{
 const states=[{evidenceId:'B1',value:{name:'開始'}},{evidenceId:'B2',value:{name:'確認'}}];
 const actions=[{evidenceId:'B3',value:{name:'確認する',from:'開始',to:'確認'}},{evidenceId:'B4',value:{name:'未取得先へ進む',from:'確認',to:'未取得先'}}];
 const html=D.renderOverview({states,actions,prefix:'picker',stateTarget:e=>({id:'detail-'+e.evidenceId})});
 assert.equal((html.match(/data-workflow-overview-root/g)||[]).length,1);
 assert.match(html,/<select data-workflow-overview-picker aria-label="強調する工程"><option value="">工程を選ぶ<\/option><option value="B1">開始<\/option><option value="B2">確認<\/option><option value="missing-2">未取得：未取得先<\/option><\/select>/);
 assert.match(html,/<select data-workflow-overview-zoom aria-label="主図の倍率"><option value="1" selected>100%<\/option><option value="1.5">150%<\/option><option value="2">200%<\/option><\/select>/);
 assert.match(html,/<button type="button" data-workflow-overview-clear>強調を解除<\/button>/);
 assert.match(html,/data-workflow-overview-node="B1" data-workflow-overview-name="開始" data-workflow-overview-target="detail-B1"/);
 assert.match(html,/<a href="#detail-B1" data-workflow-overview-select="B1" tabindex="0" role="button" aria-pressed="false" aria-label="開始：前後のつながりを強調">/);
 assert.match(html,/data-workflow-overview-node="missing-2" data-workflow-overview-name="未取得先" data-workflow-overview-target=""/);
 assert.match(html,/<a data-workflow-overview-select="missing-2" tabindex="0" role="button" aria-pressed="false" aria-label="未取得：未取得先：前後のつながりを強調">/);
 assert.equal((html.match(/data-workflow-overview-select=/g)||[]).length,3);
 assert.match(html,/<div class="ktr-workflow-overview-selection" data-workflow-overview-selection aria-live="polite"><\/div>/);
 assert.ok(html.indexOf('data-workflow-overview-picker')<html.indexOf('<svg'));
 assert.ok(html.indexOf('</svg>')<html.indexOf('data-workflow-overview-selection'));
});

test('選択用の工程名・キー・詳細IDをエスケープし、複数操作と自己遷移の根拠を省略しない',()=>{
 const name='入力<&>"\'😀',target='detail<&>"\'',key='B<&>"\'';
 const states=[{evidenceId:key,value:{name}}];
 const actions=[{evidenceId:'B2',value:{name:'自己確認',from:name,to:name}},{evidenceId:'B3',value:{name:'別条件の自己確認',from:name,to:name}}];
 const html=D.renderOverview({states,actions,prefix:'escape-overview',stateTarget:()=>({id:target})});
 assert.match(html,/data-workflow-overview-name="入力&lt;&amp;&gt;&quot;&#39;😀"/);
 assert.match(html,/data-workflow-overview-target="detail&lt;&amp;&gt;&quot;&#39;"/);
 assert.match(html,/data-workflow-overview-select="B&lt;&amp;&gt;&quot;&#39;"/);
 assert.match(html,/href="#detail&lt;&amp;&gt;&quot;&#39;"/);
 assert.match(html,/<option value="B&lt;&amp;&gt;&quot;&#39;">入力&lt;&amp;&gt;&quot;&#39;😀<\/option>/);
 assert.equal((html.match(/data-workflow-overview-actions=/g)||[]).length,1);
 assert.match(html,/data-workflow-overview-actions="B2 B3"/);
 assert.equal((html.match(/marker-end=/g)||[]).length,1);
 assert.doesNotMatch(html,/<script|<img|\ufffd/);
});

test('標準状態に未対応の工程は選択UIに混ぜず、従来の詳細リンクを保つ',()=>{
 const html=D.renderOverview({stages:[{ruleId:'R1',stageName:'入力の補助'}],stageTarget:()=> 'detail-R1'});
 assert.match(html,/data-workflow-overview-node="R1" href="#detail-R1"/);
 assert.match(html,/順序・つながりは未確認/);
 assert.doesNotMatch(html,/data-workflow-overview-root|data-workflow-overview-select=|data-workflow-overview-picker|data-workflow-overview-zoom/);
});

test('直接の前後関係だけを求め、自己ループと往復を両方向に保持し根拠IDを落とさない',()=>{
 const nodes=[{key:'A',name:'申請',target:'a',missing:false},{key:'B',name:'確認',target:'b',missing:false},{key:'C',name:'補足',target:'c',missing:false},{key:'M',name:'未取得先',target:'',missing:true},{key:'D',name:'間接工程',target:'d',missing:false}];
 const edges=[{from:'A',to:'B',ids:['B1','B2']},{from:'B',to:'A',ids:['B3']},{from:'B',to:'B',ids:['B4','B5']},{from:'C',to:'B',ids:['B6']},{from:'B',to:'M',ids:['B7']},{from:'D',to:'C',ids:['B8']},{from:'A',to:'B',ids:['B9']}];
 const before=structuredClone({nodes,edges});
 for(const node of nodes)Object.freeze(node);for(const edge of edges){Object.freeze(edge.ids);Object.freeze(edge);}Object.freeze(nodes);Object.freeze(edges);
 const result=D.neighborhood(nodes,edges,'B');
 assert.equal(result.selected,nodes[1]);
 assert.deepEqual(result.previous.map(n=>n.key),['A','B','C']);assert.deepEqual(result.next.map(n=>n.key),['A','B','M']);
 assert.deepEqual(result.relatedEdges,[edges[0],edges[1],edges[2],edges[3],edges[4],edges[6]]);
 assert.deepEqual(result.relatedEdges.flatMap(e=>e.ids),['B1','B2','B3','B4','B5','B6','B7','B9']);
 assert.deepEqual({nodes,edges},before);
 assert.deepEqual(D.neighborhood(nodes,edges,'M'),{selected:nodes[3],previous:[nodes[1]],next:[],relatedEdges:[edges[4]]});
});

test('空選択と未知の工程は周辺を推測せず、孤立した工程は選択だけを返す',()=>{
 const node={key:'A',name:'孤立した工程',target:'a',missing:false},empty={selected:null,previous:[],next:[],relatedEdges:[]};
 assert.deepEqual(D.neighborhood(),empty);assert.deepEqual(D.neighborhood([node],[],''),empty);assert.deepEqual(D.neighborhood([node],[],'unknown'),empty);
 assert.deepEqual(D.neighborhood([node],[],'A'),{selected:node,previous:[],next:[],relatedEdges:[]});
});

test('兄弟状態の自己ループは他の状態を横断せず、各標的の上端へ独立した帯から入る',()=>{
 const states=['開始','分岐A','分岐B','完了'].map((name,i)=>({evidenceId:'B'+(i+1),value:{name}}));
 const pairs=[['開始','分岐A'],['開始','分岐B'],['分岐A','完了'],['分岐B','完了'],['分岐B','分岐B'],['分岐A','分岐A']];
 const actions=pairs.map(([from,to],i)=>({evidenceId:'B'+(i+5),value:{name:'操作'+i,from,to}}));
 for(const compact of [false,true]){
  const graph=D.layout(states,actions,{compact});
  assert.equal(graph.nodes.length,4);assert.equal(graph.edges.length,6);
  const loops=graph.edges.filter(e=>e.kind==='self');assert.equal(loops.length,2);assert.notEqual(loops[0].entryY,loops[1].entryY);
  assertClearPaths(graph,compact);
 }
});

test('24状態の分岐・合流・循環・差戻し・自己ループと未取得端点でも線は状態内部を通らない',async()=>{
 const {makeComplexFixture}=require('./helpers/business-complex-fixture.js');
 const {snapshot}=await makeComplexFixture(),p=process(snapshot);
 assert.equal(p.states.length,24);assert.equal(p.actions.length,39);
 const actions=[...p.actions,{evidenceId:'missing-from-action',value:{name:'未取得元から入る',from:'未取得元',to:p.states[3].value.name}},{evidenceId:'missing-to-action',value:{name:'未取得先へ進む',from:p.states[7].value.name,to:'未取得先'}}];
 for(const compact of [false,true]){
  const graph=D.layout(p.states,actions,{compact});
  assert.equal(graph.edges.length,41);assert.equal(graph.nodes.length,26);assert.equal(graph.nodes.filter(n=>n.missing).length,2);
  for(const action of actions){const edge=graph.edges.find(e=>e.evidence.evidenceId===action.evidenceId);assert.equal(edge.from.name,action.value.from);assert.equal(edge.to.name,action.value.to);}
  assert.ok(graph.edges.some(e=>e.kind==='self'));assert.ok(graph.edges.some(e=>e.kind==='return'));
  assertClearPaths(graph,compact);
 }
});
