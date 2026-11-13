'use strict';
// Offline regression of the stage-card presentation. Collection uses only the local fixture's get stub.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const F=require('./helpers/business-fixture.js');
const {KTBusinessView:V}=require('../src/release-business-view.js');
const hasClass=(opening,name)=>new RegExp('class="[^"]*\\b'+name+'\\b').test(opening);
// Structural extraction of our generated HTML; nested sections/details are matched, not truncated at the first close.
function blocks(html,tag){
 const out=[],stack=[],re=new RegExp('<\\/?'+tag+'\\b[^>]*>','g');let m;
 while((m=re.exec(html))){if(m[0].startsWith('</')){const b=stack.pop();assert.ok(b,'unbalanced '+tag);out.push({...b,end:re.lastIndex,body:html.slice(b.bodyStart,m.index),html:html.slice(b.start,re.lastIndex)});}else stack.push({start:m.index,bodyStart:re.lastIndex,opening:m[0]});}
 assert.equal(stack.length,0,'unclosed '+tag);return out.sort((a,b)=>a.start-b.start);
}
function outsideDetails(html){const top=blocks(html,'details').filter((b,i,a)=>!a.some((parent,j)=>i!==j&&parent.start<b.start&&parent.end>b.end));let out='',at=0;for(const b of top){out+=html.slice(at,b.start);at=b.end;}return out+html.slice(at);}
const stage=(html,id='R1')=>{const b=blocks(html,'section').find(b=>hasClass(b.opening,'ktr-workflow-stage')&&b.opening.includes('-workflow-stage-'+id+'"'));assert.ok(b,'stage '+id);return b;};
const reference=html=>{const d=blocks(html,'details').find(b=>hasClass(b.opening,'ktr-workflow-reference'));assert.ok(d,'whole-process reference');assert.doesNotMatch(d.opening,/\sopen(?:\s|=|>)/);return d;};
const marked=(html,attribute)=>{const tags=[...new Set([...html.matchAll(new RegExp('<([a-z][\\w:-]*)\\b[^>]*\\s'+attribute+'(?:=|\\s|>)','gi'))].map(m=>m[1]))];return tags.flatMap(tag=>blocks(html,tag)).filter(b=>new RegExp('\\s'+attribute+'(?:=|\\s|>)').test(b.opening)).sort((a,b)=>a.start-b.start);};
const overview=html=>{const list=marked(html,'data-workflow-overview');assert.equal(list.length,1,'one stage overview');return list[0];};
const contains=(html,text)=>assert.ok(html.includes(V.escape(text)),text);
const process=s=>({states:s.evidence.filter(e=>e.kind==='process_state'),actions:s.evidence.filter(e=>e.kind==='process_action')});
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
function graphRaw(){const d=F.raw();d.process.states.保留={name:'保留',index:'2',assignee:{type:'ALL',entities:[]}};d.process.actions.push({name:'保留する',from:'申請済み',to:'保留',filterCond:'memo = "要調査"',type:'PRIMARY'},{name:'再開する',from:'保留',to:'申請済み',filterCond:'',type:'PRIMARY'},{name:'再確認する',from:'申請済み',to:'申請済み',filterCond:'',type:'PRIMARY'},{name:'特別に進める',from:'申請済み',to:'確認済み',filterCond:'memo = "特別"',type:'PRIMARY'});return d;}

test('概要図から工程カードへ進み、元プロセス図と一覧は末尾の閉じた参照へ収める',async()=>{
 const {s}=await F.snapshot({data:graphRaw()}),o=F.workflowOutput(s),html=V.outputHtml(o,s),r=reference(html),card=stage(html);
 const summary=overview(html);assert.ok(summary.end<card.start,'overview before stage details');assert.ok(outsideDetails(html).includes('data-workflow-overview'),'overview is not folded');assert.ok(card.end<r.start,'stage before full-process reference');assert.match(r.body,/data-workflow-diagram/);assert.match(r.body,/data-process-state=/);assert.match(r.body,/data-process-action=/);
 assert.doesNotMatch(html.slice(0,r.start),/data-workflow-diagram(?:\s|>)/,'no second prominent full diagram');
 const cards=blocks(html,'section').filter(b=>hasClass(b.opening,'ktr-workflow-stage')||/data-workflow-setting-stage=/.test(b.opening));assert.ok(cards.every(c=>c.end<r.start));
});

test('工程カードの主情報と根拠リンクは常時読め、理由・質問・原文は閉じた詳細へまとめる',async()=>{
 const {s}=await F.snapshot(),o=F.workflowOutput(s),r=o.rules[0],html=V.outputHtml(o,s),card=stage(html),main=outsideDetails(card.body),details=blocks(card.body,'details');
 for(const text of [r.stageName,r.inference,r.participants[0].roleHypothesis,r.trigger.interpretation,...r.inputs.map(x=>x.interpretation),...r.notifications.map(x=>x.interpretation),r.nextAction.interpretation])contains(main,text);
 for(const heading of ['担当','開始','入力','通知','次'])assert.ok(main.includes(heading),heading);
 for(const text of [r.reasoning,...r.questions.flatMap(q=>[q.question,q.whyItMatters])]){assert.ok(!main.includes(V.escape(text)),'hidden in detail: '+text);assert.ok(details.some(d=>d.body.includes(V.escape(text))&&!/\sopen(?:\s|=|>)/.test(d.opening)),text);}
 assert.doesNotMatch(main,/<pre\b/);assert.ok(details.some(d=>d.body.includes('<pre')),'original evidence remains available');
 for(const id of new Set([...r.inputs.flatMap(x=>x.evidenceRefs),...r.notifications.flatMap(x=>x.evidenceRefs),...r.trigger.evidenceRefs,...r.nextAction.evidenceRefs].map(x=>x.evidenceId)))assert.ok(main.includes('>'+id+'</a>'),'inline evidence '+id);
 const notice=s.evidence.find(e=>e.kind==='notification_record');for(const text of [notice.value.filterCond,notice.value.title,'グループ：accounting'])contains(main,text);assert.match(main,/推測/);assert.match(main,/事実/);
});

test('厳密に対応した有効状態の作業者・入出遷移を工程カードへ保持する',async()=>{
 const {s}=await F.snapshot({data:graphRaw()}),o=F.workflowOutput(s),r=o.rules[0],p=process(s),state=p.states.find(e=>e.evidenceId===r.processStateId),card=stage(V.outputHtml(o,s)).body;
 const d=V.description(state);for(const text of [state.value.name,d.action,d.people])contains(card,text);
 for(const action of p.actions.filter(e=>e.value.from===state.value.name||e.value.to===state.value.name)){for(const text of [action.value.name,action.value.from,action.value.to])contains(card,text);if(action.value.filterCond)contains(card,action.value.filterCond);}
 assert.match(card,/設定.*事実|事実.*設定/);
});

test('同じ工程名だけでは状態を対応付けず、未対応の有効状態を事実カードとして全件残す',async()=>{
 const {s}=await F.snapshot({data:graphRaw()}),o=F.workflowOutput(s),p=process(s);o.rules[0].stageName=p.states[0].value.name;o.rules[0].processStateId=null;
 const html=V.outputHtml(o,s),aiCard=stage(html),settingCards=blocks(html,'section').filter(b=>/data-workflow-setting-stage=/.test(b.opening));
 assert.equal(settingCards.length,p.states.length);assert.doesNotMatch(aiCard.opening,/data-workflow-setting-stage=/);
 assert.doesNotMatch(outsideDetails(aiCard.body),/対応する標準ステータス（設定の事実）/);
 for(const state of p.states){const card=settingCards.find(b=>b.opening.includes('data-workflow-setting-stage="'+state.evidenceId+'"'));assert.ok(card,state.evidenceId);contains(card.body,state.value.name);assert.match(card.body,/事実/);assert.match(card.body,/未特定|要確認|未確認|推測.*未/);}
});

test('対応済み状態は二重カードにせず、残る有効状態には全アクションの説明を保持する',async()=>{
 const {s}=await F.snapshot({data:graphRaw()}),o=F.workflowOutput(s),p=process(s),html=V.outputHtml(o,s),cards=blocks(html,'section').filter(b=>/data-workflow-setting-stage=/.test(b.opening));
 assert.equal(cards.length,p.states.length-1);assert.ok(!cards.some(c=>c.opening.includes('data-workflow-setting-stage="'+o.rules[0].processStateId+'"')));
 for(const state of p.states.filter(e=>e.evidenceId!==o.rules[0].processStateId)){const card=cards.find(c=>c.opening.includes('data-workflow-setting-stage="'+state.evidenceId+'"'));assert.ok(card);for(const e of p.actions.filter(e=>e.value.from===state.value.name||e.value.to===state.value.name))contains(card.body,e.value.name);}
});

test('無効プロセスは旧対応IDが残っていても工程へ結ばず、参考図へ全29件を残す',async()=>{
 const d=F.raw();d.process.enable=false;d.process.states=Object.fromEntries(Array.from({length:12},(_,i)=>['状態'+i,{name:'状態'+i,index:String(i),assignee:{type:'ANY',entities:[]}}]));
 d.process.actions=Array.from({length:17},(_,i)=>({name:'操作'+i,from:'状態'+(i%12),to:'状態'+((i+1)%12),filterCond:i===12?'memo = "再確認"':'',type:'PRIMARY'}));
 const {s}=await F.snapshot({data:d}),o=F.workflowOutput(s),p=process(s);o.rules[0].processStateId=p.states[0].evidenceId;
 const html=V.outputHtml(o,s),r=reference(html);assert.doesNotMatch(html,/data-workflow-setting-stage=/);assert.doesNotMatch(html,/data-workflow-node-target="stage"/);
 assert.match(r.body,/参考：無効なプロセス定義/);assert.match(r.body,/現行の工程やJavaScriptの操作と接続して解釈しません/);assert.equal((r.body.match(/data-workflow-node=/g)||[]).length,12);assert.equal((r.body.match(/data-workflow-edge=/g)||[]).length,17);
 assert.doesNotMatch(outsideDetails(stage(html).body),/対応する標準ステータス（設定の事実）/);
});

test('取得不可・有効状態不明・明示設定なしを区別し、取得を推測で補わない',async()=>{
 const {s}=await F.snapshot(),o=F.workflowOutput(s);
 for(const [acquisition,activation,label]of [['forbidden','unknown','権限不足で取得不可'],['success','unknown','プロセス設定の取得状態']]){
  const copy=structuredClone(s),c=copy.categories.find(c=>c.category==='process');c.acquisition=acquisition;c.activation=activation;const html=V.outputHtml(o,copy);assert.doesNotMatch(html,/data-workflow-setting-stage=/);assert.doesNotMatch(html,/data-workflow-node-target="stage"/);contains(reference(html).body,label);if(acquisition==='forbidden'){assert.doesNotMatch(reference(html).body,/<svg\b/);const summary=reference(html).body.match(/^<summary>([\s\S]*?)<\/summary>/)?.[1];assert.ok(summary);assert.match(summary,/権限不足で取得不可・件数未確認/);assert.doesNotMatch(summary,/0状態|0遷移/);}
 }
 const empty=structuredClone(s);empty.evidence=empty.evidence.filter(e=>e.category!=='process');Object.assign(empty.categories.find(c=>c.category==='process'),{acquisition:'success',presence:'empty',activation:'disabled',itemCount:0});
 const no=structuredClone(o);no.rules[0].processStateId=null;no.rules[0].participants=[];no.rules[0].evidenceRefs=no.rules[0].evidenceRefs.filter(r=>empty.evidence.some(e=>e.evidenceId===r.evidenceId));no.rules[0].nextAction.evidenceRefs=[];no.unassignedEvidence=no.unassignedEvidence.filter(r=>empty.evidence.some(e=>e.evidenceId===r.evidenceId));
 const html=V.outputHtml(no,empty);assert.match(reference(html).body,/取得済み・明示設定なし/);assert.doesNotMatch(reference(html).body,/<svg\b/);
});

test('末尾参照にも分岐・戻り・自己遷移・並行アクションが残り、複数描画のリンクが衝突しない',async()=>{
 const {s}=await F.snapshot({data:graphRaw()}),o=F.workflowOutput(s),parts=[V.outputHtml(o,s),V.outputHtml(o,s)],allIds=[];
 for(const html of parts){const ref=reference(html),ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);allIds.push(...ids);const set=new Set(ids);for(const m of html.matchAll(/href="#([^"]+)"/g))assert.ok(set.has(m[1]),m[1]);for(const m of html.matchAll(/marker-end="url\(#([^)]*)\)"/g))assert.ok(set.has(m[1]),m[1]);
  assert.equal((ref.body.match(/data-workflow-edge=/g)||[]).length,6);assert.match(ref.body,/data-workflow-edge-kind="return"/);assert.match(ref.body,/data-workflow-edge-kind="self"/);for(const e of process(s).actions)assert.ok(ref.body.includes('data-workflow-edge="'+e.evidenceId+'"'),e.evidenceId);
 }
 assert.equal(new Set(allIds).size,allIds.length);
});

test('カード化しても保存用Markdown・履歴索引・旧v1表示を変更せず、描画時にAIを呼ばない',async()=>{
 const {s}=await F.snapshot(),o=F.workflowOutput(s),doc={title:'業務工程の確認',snapshot:s,businessUnderstanding:o},before=JSON.stringify(doc),originalFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=()=>{calls++;throw Error('network forbidden in free card rendering test');};
 try{V.outputHtml(o,s);assert.equal(hash(V.historyBody(doc)),'52db3fd03047ab2c0f56e4ed460d55383950409ec2358545ee69b13911a47d6d');assert.equal(hash(V.markdown(doc)),'117a19fb4b5db45345a3a2e6c424330b1692d549956bc34673d17fd4de1f5005');assert.equal(hash(V.outputHtml(F.output(s),s)),'6ca5dc147c060b38061b254344696eb110b2ae3c7172bb3f6b89e3474574c40b');}finally{globalThis.fetch=originalFetch;}
 assert.equal(calls,0);assert.equal(JSON.stringify(doc),before,'presentation must not mutate saved content');
});

test('明細だけが参照する根拠もカード内へ保持し、折りたたみ後にリンク切れを作らない',async()=>{
 const {s}=await F.snapshot(),o=F.workflowOutput(s),r=o.rules[0],reminder=s.evidence.find(e=>e.kind==='notification_reminder'),ref={evidenceId:reminder.evidenceId,pointer:null};
 assert.ok(!r.evidenceRefs.some(x=>x.evidenceId===reminder.evidenceId));
 r.notifications.push({interpretation:'期限前に通知する可能性があります。',evidenceRefs:[ref]});r.questions.push({question:'期限前通知は督促ですか。',whyItMatters:'通知の目的を確認するため。',relatedEvidenceRefs:[ref]});
 const html=V.outputHtml(o,s),card=stage(html),main=outsideDetails(card.body);contains(main,reminder.value.title);assert.ok(main.includes('>'+reminder.evidenceId+'</a>'));
 assert.ok(blocks(card.body,'details').some(d=>d.opening.includes('data-business-evidence="'+reminder.evidenceId+'"')));
 const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));for(const m of html.matchAll(/href="#([^"]+)"/g))assert.ok(ids.has(m[1]),m[1]);
});

test('無効プロセスの3推測工程は概要3ノード・矢印なしで、各同一IDの詳細へ移動する',async()=>{
 const d=graphRaw();d.process.enable=false;const {s}=await F.snapshot({data:d}),o=F.workflowOutput(s),base=o.rules[0];
 o.rules=Array.from({length:3},(_,i)=>({...structuredClone(base),ruleId:'R'+(i+1),stageName:['内容確認','データ補完','連絡の記録'][i],processStateId:null}));
 const html=V.outputHtml(o,s),summary=overview(html),nodes=marked(summary.html,'data-workflow-overview-node');assert.equal(nodes.length,3);assert.equal(marked(summary.html,'data-workflow-overview-actions').length,0);
 const destinations=nodes.map(n=>n.html.match(/href="#([^"]+)"/)?.[1]);assert.ok(destinations.every(Boolean));assert.equal(new Set(destinations).size,3);
 for(const r of o.rules){const card=stage(html,r.ruleId),id=card.opening.match(/\bid="([^"]+)"/)[1];assert.ok(destinations.includes(id));const node=nodes.find(n=>n.html.includes('href="#'+id+'"'));contains(node.html,r.stageName);}
 assert.match(reference(html).body,/参考：無効なプロセス定義/);assert.doesNotMatch(summary.html,/data-workflow-edge=/,'raw disabled transitions stay in reference');
});

test('有効状態の概要は全状態と全操作を保持し、自由工程ノードには状態遷移を結ばない',async()=>{
 const {s}=await F.snapshot({data:graphRaw()}),o=F.workflowOutput(s),p=process(s),base=o.rules[0];
 o.rules.push({...structuredClone(base),ruleId:'R2',stageName:p.states[0].value.name,processStateId:null},{...structuredClone(base),ruleId:'R3',stageName:'JSによる入力補助の候補',processStateId:null});
 const html=V.outputHtml(o,s),summary=overview(html),nodes=marked(summary.html,'data-workflow-overview-node'),edges=marked(summary.html,'data-workflow-overview-actions');assert.equal(nodes.length,p.states.length+2);
 const attr=(b,name)=>b.opening.match(new RegExp('\\s'+name+'="([^"]*)"'))?.[1],used=[],stateIds=new Set(p.states.map(e=>e.evidenceId));
 for(const edge of edges){const ids=attr(edge,'data-workflow-overview-actions').trim().split(/\s+/);assert.ok(ids.length);used.push(...ids);const actions=ids.map(id=>p.actions.find(e=>e.evidenceId===id));assert.ok(actions.every(Boolean));assert.equal(new Set(actions.map(e=>JSON.stringify([e.value.from,e.value.to]))).size,1,'group only same from/to');
  const from=attr(edge,'data-workflow-overview-from'),to=attr(edge,'data-workflow-overview-to');assert.ok(stateIds.has(from),'edge starts at acquired state');assert.ok(stateIds.has(to),'edge ends at acquired state');assert.equal(p.states.find(e=>e.evidenceId===from).value.name,actions[0].value.from);assert.equal(p.states.find(e=>e.evidenceId===to).value.name,actions[0].value.to);
 }
 assert.deepEqual(used.sort(),p.actions.map(e=>e.evidenceId).sort());
 for(const r of o.rules){const id=stage(html,r.ruleId).opening.match(/\bid="([^"]+)"/)[1];assert.equal(nodes.filter(n=>n.html.includes('href="#'+id+'"')).length,1,r.ruleId);}
 for(const state of p.states.filter(e=>e.evidenceId!==base.processStateId)){const card=blocks(html,'section').find(b=>b.opening.includes('data-workflow-setting-stage="'+state.evidenceId+'"')),id=card.opening.match(/\bid="([^"]+)"/)[1];assert.ok(nodes.some(n=>n.html.includes('href="#'+id+'"')));}
 for(const e of p.actions)assert.ok(html.includes('data-workflow-card-action="'+e.evidenceId+'"'),'full action details '+e.evidenceId);
});
