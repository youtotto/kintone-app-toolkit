'use strict';
// Run offline: node --require ../proof/no-network.cjs --test tests/release-business-complex.test.js
const test=require('node:test'),assert=require('node:assert/strict');
const {makeComplexFixture,restoreComplexDocument}=require('./helpers/business-complex-fixture.js');
const {fixture}=require('./helpers/release-workspace-fixture.js');
const {KTBusinessContract:C}=require('../src/release-business-contract.js');
const {KTBusinessView:BV}=require('../src/release-business-view.js');
const {KTBusinessConsultation:B}=require('../src/release-business-consultation.js');
const {KTReleaseWorkspace:W}=require('../src/release-workspace.js');
const {KTReleaseView:V}=require('../src/release-view.js');
const {KTWorkflowDiagram:D}=require('../src/release-workflow-diagram.js');
const scope={domain:'fixture.cybozu.com',appId:'310'},copy=x=>structuredClone(x);
const ofKind=(s,kind)=>s.evidence.filter(e=>e.kind===kind);
const attr=(tag,name)=>tag.match(new RegExp('\\s'+name+'="([^"]*)"'))?.[1];
const tagged=(html,name)=>[...html.matchAll(new RegExp('<[A-Za-z][^>]*\\s'+name+'="[^"]*"[^>]*>','g'))].map(m=>m[0]);
const main=s=>V.render(s,{connection:{canConsultBusiness:true}}).split('<main ')[1];
const overviews=html=>(html.match(/<section\b[^>]*class="[^\"]*\bktr-workflow-overview\b[^>]*>/g)||[]).length;
const counts=f=>Object.fromEntries(['propose','loadBase','plan','generate','prepare','apply'].map(k=>[k,f.count(k)]));
function controllerFor(fixtures){
 return fixture({create:args=>W.create({...args,scope})},{propose:args=>{
  const data=fixtures.find(f=>f.snapshot.snapshotId===args.businessSnapshot?.snapshotId);
  if(!data)throw Error('Only the local synthetic document response is allowed');return copy(data.answer);
 }});
}
async function setup({two=false}={}){
 const first=await makeComplexFixture(),fixtures=[first];
 if(two)fixtures.push(await makeComplexFixture({snapshotId:'complex-workflow-2',revision:'58',environment:'preview'}));
 const f=controllerFor(fixtures),c=f.controller,docs=[];
 for(const data of fixtures)docs.push(await restoreComplexDocument(c,data));
 return {...f,c,fixtures,docs};
}
function localLinksResolve(html){
 const ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]),known=new Set(ids);
 assert.equal(known.size,ids.length,'rendered IDs are unique');
 for(const match of html.matchAll(/href="#([^"]+)"/g))assert.ok(known.has(match[1]),'missing local target '+match[1]);
}

test('22並列分岐の合成設定は全状態・操作・詳細へのリンクを保持する',async()=>{
 const {snapshot:s,answer:a}=await makeComplexFixture({parallel:true}),states=ofKind(s,'process_state'),actions=ofKind(s,'process_action');
 assert.deepEqual(C.validateSnapshot(s,{workflow:true}),[]);assert.deepEqual(C.validateOutput(a.businessUnderstanding,s),[]);
 assert.equal(states.length,24);assert.equal(actions.length,46);
 const graph=D.layout(states,actions,{compact:true}),ranks=new Map();
 for(const node of graph.nodes)ranks.set(node.rank,(ranks.get(node.rank)||0)+1);
 assert.equal(Math.max(...ranks.values()),22,'fixture must have real parallel branches');
 const html=BV.outputHtml(a.businessUnderstanding,s);localLinksResolve(html);
 assert.equal(tagged(html,'data-workflow-overview-node').length,26);
 const shown=new Set(tagged(html,'data-workflow-overview-actions').flatMap(tag=>attr(tag,'data-workflow-overview-actions').split(' ')));
 assert.deepEqual([...shown].sort(),actions.map(e=>e.evidenceId).sort());
});

test('24状態の旧保存資料は読めるが新たな全工程分析は拒否し、条件と根拠を保持する',async()=>{
 const {snapshot:s,answer:a}=await makeComplexFixture(),o=a.businessUnderstanding;
 assert.deepEqual(C.validateSnapshot(s,{workflow:true}),[]);assert.deepEqual(C.validateOutput(o,s),[]);
 assert.equal(o.rules.length,16);assert.equal(ofKind(s,'process_state').length,24);assert.equal(ofKind(s,'process_action').length,39);
 assert.equal(o.rules.filter(r=>r.processStateId===null).length,2);assert.equal(o.rules.at(-1).stageName.length,120);
 const byEndpoint=new Map();for(const e of ofKind(s,'process_action')){const key=JSON.stringify([e.value.from,e.value.to]);byEndpoint.set(key,[...(byEndpoint.get(key)||[]),e]);}
 assert.ok([...byEndpoint.values()].some(es=>es.length>=3&&new Set(es.map(e=>e.value.filterCond)).size===es.length),'parallel actions retain independent conditions');
 assert.equal(ofKind(s,'process_action').filter(e=>e.value.from===e.value.to).length,2);
 assert.throws(()=>C.context(s,undefined,{workflow:true}),/16工程/);assert.equal(C.workflowEligibility(s).mode,'material-only');
 for(const r of o.rules){assert.ok(r.inputs.length&&r.notifications.length&&r.questions.length);assert.ok(r.evidenceRefs.some(ref=>s.evidence.find(e=>e.evidenceId===ref.evidenceId).kind==='acl_field'));}
 const second=await makeComplexFixture();assert.deepEqual(second,{snapshot:s,answer:a},'fixture is deterministic');
});

test('複雑な概要・詳細・参考図は全候補と未整理の標準状態、全操作と根拠リンクを保持する',async()=>{
 const {snapshot:s,answer:a}=await makeComplexFixture(),o=a.businessUnderstanding,html=BV.outputHtml(o,s),states=ofKind(s,'process_state'),actions=ofKind(s,'process_action');
 assert.equal(tagged(html,'data-workflow-rule').length,16);assert.equal(tagged(html,'data-workflow-setting-stage').length,10);
 assert.equal(tagged(html,'data-workflow-overview-node').length,26);assert.equal(tagged(html,'data-process-state').length,24);assert.equal(tagged(html,'data-process-action').length,39);
 const stateMap=new Map(states.map(e=>[e.evidenceId,e.value.name])),actionMap=new Map(actions.map(e=>[e.evidenceId,e])),seen=[];
 for(const edge of tagged(html,'data-workflow-overview-actions')){
  const ids=attr(edge,'data-workflow-overview-actions').split(' ');seen.push(...ids);
  for(const id of ids){const e=actionMap.get(id);assert.ok(e,id);assert.equal(e.value.from,stateMap.get(attr(edge,'data-workflow-overview-from')));assert.equal(e.value.to,stateMap.get(attr(edge,'data-workflow-overview-to')));}
 }
 assert.deepEqual(seen.sort(),actions.map(e=>e.evidenceId).sort());
 const detailIds=new Set(tagged(html,'data-workflow-card-action').map(tag=>attr(tag,'data-workflow-card-action')));assert.deepEqual([...detailIds].sort(),actions.map(e=>e.evidenceId).sort());
 for(const e of actions){assert.ok(html.includes(BV.escape(e.value.name)));if(e.value.filterCond)assert.ok(html.includes(BV.escape(e.value.filterCond)));}
 for(const r of o.rules){assert.ok(html.includes(BV.escape(r.stageName)));for(const q of r.questions)assert.ok(html.includes(q.question));}
 assert.match(html,/<details class="ktr-workflow-reference"><summary>/);assert.match(html,/表示順は実行順ではありません/);
 localLinksResolve(html);localLinksResolve(html+BV.outputHtml(o,s));
});

test('保存用Markdownは長い工程説明と原文を維持し、一般会話の索引は16候補と詳細の所在を保持する',async()=>{
 const {snapshot:s,answer:a}=await makeComplexFixture(),o=a.businessUnderstanding,doc={title:'複雑な購買工程',snapshot:s,businessUnderstanding:o},md=BV.markdown(doc),history=BV.historyBody(doc);
 for(const r of o.rules){for(const text of [r.stageName,r.inference,r.reasoning,r.trigger.interpretation,r.nextAction.interpretation,...r.inputs.map(x=>x.interpretation),...r.notifications.map(x=>x.interpretation),...r.questions.flatMap(q=>[q.question,q.whyItMatters])])assert.ok(md.includes(text),r.ruleId+' content omitted');}
 for(const e of s.evidence.filter(e=>e.category==='process')){assert.ok(md.includes(e.evidenceId));assert.ok(md.includes(e.source.pointer));assert.ok(md.includes(e.value.name));}
 assert.equal(history.sections.length,2);assert.equal(history.sections[1].items.length,16);assert.ok(JSON.stringify(history).length<6000);
 for(const r of o.rules)assert.ok(history.sections[1].items.includes(r.ruleId+' '+r.stageName));
 assert.match(JSON.stringify(history),/索引だけ/);assert.match(JSON.stringify(history),/保存資料または専用の工程相談/);
 assert.ok(md.indexOf(o.rules[0].stageName)<md.indexOf('根拠の原文一覧'));
});

test('別版の資料への往復でも相談元・選択工程・他工程を参照した運用記録とwireは変わらない',async()=>{
 const f=await setup({two:true}),c=f.c,[first,second]=f.docs;assert.equal(await c.startBusiness(first.id,'R16'),true);
 const source=c.getState().businessContext;
 assert.equal(c.recordBusiness({kind:'current_operation',text:'帳票整理時には部門長の確認結果も参照します。',sourceRuleRefs:[B.ruleRef(source,'R2')],sourceQuestionRef:{analysisId:first.id,questionId:'source:R2:0'}}),true);
 assert.equal(c.setBusinessDraft('new','別資料を見ながら入力している補足'),true);
 const before=copy(c.getState().businessContext),wire=copy(B.wire(before)),calls=counts(f);
 assert.deepEqual(wire.analysis.rules.map(r=>r.ruleId),['R2','R16']);assert.equal(wire.selection.ruleId,'R16');
 for(const id of [second.id,first.id,second.id]){
  assert.equal(c.showExplanation(id),true);const html=main(c.getState());assert.equal(overviews(html),1);assert.match(html,/相談の参照元：/);assert.match(html,/表示資料を開くだけでは、相談の参照元は切り替わりません/);
  assert.deepEqual(c.getState().businessContext,before);assert.deepEqual(B.wire(c.getState().businessContext),wire);assert.equal(c.getBusinessDraft('new'),'別資料を見ながら入力している補足');
  c.showChanges();assert.equal(overviews(main(c.getState())),1);assert.deepEqual(c.getState().businessContext,before);
 }
 assert.deepEqual(counts(f),calls);assert.equal(f.writes.length,0);
});

test('30件の運用記録・質問への回答・選択希望と複数の下書きを会話保存から完全復元する',async()=>{
 const f=await setup(),c=f.c,doc=f.docs[0];assert.equal(await c.startBusiness(doc.id),true);
 for(let i=0;i<30;i++){
  const h=c.getState().businessContext,ruleId='R'+(i%16+1);
  assert.equal(c.recordBusiness({kind:i===29?'desired_change':'current_operation',text:'記録'+(i+1)+'：担当部門が確認結果と引き渡し条件を記録する運用です。',sourceRuleRefs:[B.ruleRef(h,ruleId)],sourceQuestionRef:{analysisId:doc.id,questionId:'source:'+ruleId+':0'}}),true);
 }
 assert.equal(c.selectBusinessChange('BS30',true),true);
 for(const id of ['new','source:R1:0','source:R8:0','source:R16:0'])assert.equal(c.setBusinessDraft(id,'未記録の回答 '+id+'：関係部門に確認中'),true);
 const before=c.getState(),wire=B.wire(before.businessContext),saved=JSON.parse(JSON.stringify(c.exportSession()));
 assert.equal(wire.statements.length,30);assert.deepEqual(B.validate(wire,{wire:true}),[]);assert.ok(Buffer.byteLength(JSON.stringify(B.context(before.businessContext,'運用を確認')))<256*1024);
 const g=controllerFor(f.fixtures);assert.equal(await g.controller.restoreSession(saved),true,JSON.stringify(g.controller.getState().error));
 const restored=g.controller.getState();assert.deepEqual(restored.businessContext,before.businessContext);assert.deepEqual(restored.explanations,before.explanations);assert.deepEqual(restored.businessSelectedIds,before.businessSelectedIds);assert.deepEqual(B.wire(restored.businessContext),wire);
 for(const id of ['new','source:R1:0','source:R8:0','source:R16:0'])assert.equal(g.controller.getBusinessDraft(id),c.getBusinessDraft(id));
 assert.equal(overviews(main(restored)),1);assert.equal(g.count('propose'),0);assert.equal(g.writes.length,0);assert.equal(f.writes.length,0);
});

test('31件目は送信形を黙って切らず停止し、添付を外しても保存記録と確認事項は失わない',async()=>{
 const f=await setup(),c=f.c;assert.equal(await c.startBusiness(f.docs[0].id,'R1'),true);
 for(let i=0;i<31;i++)assert.equal(c.recordBusiness({kind:'current_operation',text:'部門で確認した運用 '+(i+1)}),true);
 const calls=counts(f);assert.throws(()=>B.context(c.getState().businessContext,'確認'),/30件/);assert.equal(c.getState().businessContext.statements.length,31);
 assert.equal(c.attachBusinessStatement('BS1',false),true);let wire=B.wire(c.getState().businessContext);assert.equal(wire.statements.length,30);assert.equal(wire.omittedStatementCount,1);assert.equal(c.getState().businessContext.statements.length,31);
 assert.equal(c.recordBusiness({kind:'open_question',state:'unknown',text:'例外時の承認責任者は未確認です。'}),true);assert.equal(c.attachBusinessStatement('BS32',false),false);assert.throws(()=>B.wire(c.getState().businessContext),/30件/);
 assert.equal(c.attachBusinessStatement('BS2',false),true);wire=B.wire(c.getState().businessContext);assert.equal(wire.statements.length,30);assert.equal(wire.omittedStatementCount,2);assert.ok(wire.statements.some(s=>s.statementId==='BS32'&&s.state==='unknown'));
 const g=controllerFor(f.fixtures);assert.equal(await g.controller.restoreSession(c.exportSession()),true);assert.equal(g.controller.getState().businessContext.statements.length,32);assert.deepEqual(B.wire(g.controller.getState().businessContext),wire);assert.deepEqual(counts(f),calls);assert.equal(g.count('propose'),0);assert.equal(f.writes.length,0);assert.equal(g.writes.length,0);
});
