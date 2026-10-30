'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {KTReleaseWorkspace:W}=require('../src/release-workspace.js');
const {KTReleaseView:V}=require('../src/release-view.js');
const {KTBusinessView:BV}=require('../src/release-business-view.js');
const {fixture,proposal,REQUEST,deferred}=require('./helpers/release-workspace-fixture.js');
const F=require('./helpers/business-fixture.js');
const response=s=>({...F.answer(s),proposalUnchanged:true});
const work=s=>({phase:s.phase,version:s.version,proposal:s.proposal,adopted:s.adopted,answers:s.answers,plan:s.plan,artifacts:s.artifacts,prepared:s.prepared,goal:s.goal,requestPurpose:s.requestPurpose});
test('無料設定一覧の保存・復元はAIを呼ばず根拠・取得状態を保持',async()=>{
 const {s}=await F.snapshot(),f=fixture(W);
 assert.equal(f.controller.saveBusinessSnapshot(s),true);assert.equal(f.calls.length,0);
 const saved=f.controller.exportSession(),restored=fixture(W);
 assert.equal(await restored.controller.restoreSession(saved),true);
 assert.deepEqual(restored.controller.getState().explanations,f.controller.getState().explanations);
 assert.equal(restored.count('propose'),0);assert.equal(restored.writes.length,0);
 const broken=F.clone(saved);broken.state.explanations[0].snapshot.categories[0].presence='empty';
 assert.equal(await restored.controller.restoreSession(broken),false);
});
test('候補生成は既存の採用内容と用途を保ち、別環境の追加取得・変更・反映をしない',async()=>{
 const {s}=await F.snapshot();let input;
 const f=fixture(W,{propose:args=>{input=args;return args.businessSnapshot?response(s):proposal();}});
 await f.controller.send(REQUEST);await f.controller.adopt();
 const before=work(f.controller.getState()),reads=f.count('loadBase');
 assert.equal(await f.controller.send('業務ルールを整理',{requestPurpose:'document',businessSnapshot:s}),true);
 assert.deepEqual(work(f.controller.getState()),before);assert.equal(f.count('loadBase'),reads);
 assert.deepEqual(input.businessSnapshot,s);assert.equal(input.base,undefined);assert.equal(input.previous,undefined);
 assert.equal(f.count('plan'),1);assert.equal(f.writes.length,0);
 const doc=f.controller.getState().explanations[0],saved=f.controller.exportSession();
 assert.deepEqual(saved.state.explanations[0].businessUnderstanding,F.output(s));
 assert.deepEqual(saved.state.explanations[0].snapshot,s);
 assert.match(V.render(f.controller.getState()),/設定から確認できたこと/);
 for(const text of s.limitations.map(x=>x.message))assert.ok(V.explanationMarkdown(doc).includes(text.replace(/[\\\x60*_{}\[\]()#+.!|<>-]/g,c=>'\\'+c)));
 const body=BV.historyBody(doc);assert.match(body.title,/過去/);assert.ok(body.sections.every(x=>x.evidenceIds.length===0));
 const fresh=fixture(W);assert.equal(await fresh.controller.restoreSession(saved),true);
 assert.deepEqual(fresh.controller.getState().explanations[0],doc);
});
test('中断・遅延・二重送信でも候補の重複や変更を作らない',async()=>{
 const {s}=await F.snapshot(),gate=deferred(),f=fixture(W,{propose:()=>gate.promise});
 f.controller.saveBusinessSnapshot(s);
 const pending=f.controller.send('候補',{requestPurpose:'document',businessSnapshot:s});await new Promise(r=>setImmediate(r));
 assert.equal(await f.controller.send('重複',{requestPurpose:'document',businessSnapshot:s}),false);
 f.controller.cancel();gate.resolve(response(s));assert.equal(await pending,false);
 assert.equal(f.controller.getState().explanations.length,1);assert.equal(f.count('propose'),1);assert.equal(f.writes.length,0);
});
test('不正な候補と失敗では設定一覧を保持し、自動再送しない',async()=>{
 const {s}=await F.snapshot(),bad=response(s);bad.businessUnderstanding.rules[0].evidenceRefs[0].evidenceId='B999';
 const f=fixture(W,{propose:()=>bad});f.controller.saveBusinessSnapshot(s);
 assert.equal(await f.controller.send('候補',{requestPurpose:'document',businessSnapshot:s}),false);
 assert.equal(f.controller.getState().explanations.length,1);assert.equal(f.count('propose'),1);assert.equal(f.writes.length,0);
 const incomplete=F.clone(s);incomplete.consistency='mismatch';
 assert.equal(await f.controller.send('候補',{requestPurpose:'document',businessSnapshot:incomplete}),false);
 assert.equal(f.count('propose'),1);
});
test('未対応属性は送らず未解釈範囲に残す。未知の状態・形も例外なく拒否',async()=>{
 const data=F.raw();data.notification_record.notifications[0].futureRule={private:'SECRET'};data.acl_field.futureRoot='SECRET';
 const {s}=await F.snapshot({data});
 assert.ok(!JSON.stringify(s).includes('SECRET'));assert.equal(s.categories.filter(c=>c.interpretationIssues.some(x=>x.includes('未対応'))).length,2);
 assert.ok(!F.C.validateSnapshot(s).length);
 for(const mutate of [x=>x.evidence[0]=null,x=>delete x.evidence[0].kind,x=>x.categories[0].presence='unknown',x=>x.evidence[0].active=true,x=>x.categories[0]=null]){
  const x=F.clone(s);mutate(x);assert.ok(F.C.validateSnapshot(x).length);
 }
});

test('F11 既存条件解析器でコードとステータスを結び、未解析式は原文のまま残す',async()=>{
 const {KTQueryCheck}=require('./helpers/load-toolkit.js').loadToolkit();
 const data=F.raw();data.fields.properties.ステータス={code:'ステータス',label:'状態',type:'STATUS'};
 data.notification_record.notifications[0].filterCond='ステータス in ("申請済み") and memo = "due"';
 const {s}=await F.snapshot({data,queryParser:KTQueryCheck}),e=s.evidence.find(e=>e.kind==='notification_record');
 const linked=s.evidence.filter(x=>e.linkedEvidenceIds.includes(x.evidenceId));
 assert.ok(linked.some(x=>x.kind==='field'&&x.value.code==='memo'));
 assert.ok(linked.some(x=>x.kind==='process_state'&&x.value.name==='申請済み'));
 assert.ok(!linked.some(x=>x.kind==='field'&&x.value.code==='due'),'値の文字列を参照コードにしない');
 assert.deepEqual(e.unresolvedReferences,[]);
 data.notification_record.notifications[0].filterCond='memo future_operator "x"';
 const bad=(await F.snapshot({data,queryParser:KTQueryCheck})).s;
 assert.equal(bad.evidence.find(e=>e.kind==='notification_record').value.filterCond,'memo future_operator "x"');
 assert.ok(bad.limitations.some(x=>x.message.includes('解析できていません')));
 assert.equal(new Set(bad.limitations.map(x=>x.kind+x.message)).size,bad.limitations.length);
});
test('F18 500根拠・256KiB・8候補・8000文字の境界内成功と1超過拒否',async()=>{
 const {s}=await F.snapshot(),data=F.raw();
 data.notification_record.notifications=Array.from({length:501-s.evidence.length},()=>F.clone(data.notification_record.notifications[0]));
 const many=(await F.snapshot({data})).s;assert.equal(many.evidence.length,500);assert.deepEqual(F.C.validateSnapshot(many),[]);
 data.notification_record.notifications.push(F.clone(data.notification_record.notifications[0]));
 assert.ok(F.C.validateSnapshot((await F.snapshot({data})).s).length);
 const exact=F.clone(s),title=exact.evidence.find(e=>e.kind==='notification_record').value;title.title='';
 const initial=Buffer.byteLength(JSON.stringify(F.C.context(exact)));
 title.title='a'.repeat(256*1024-initial);
 assert.equal(Buffer.byteLength(JSON.stringify(F.C.context(exact))),256*1024);title.title+='a';assert.throws(()=>F.C.context(exact),/送信上限/);
 const o=F.output(s),rule=o.rules[0];rule.participants=[];rule.questions=[];rule.inference='a'.repeat(600);rule.reasoning='b'.repeat(398);rule.trigger.interpretation='c';rule.nextAction.interpretation='d';
 o.rules=Array.from({length:8},(_,i)=>({...F.clone(rule),ruleId:'R'+(i+1)}));
 assert.deepEqual(F.C.validateOutput(o,s),[]);o.rules[0].reasoning+='e';assert.ok(F.C.validateOutput(o,s).some(x=>x.includes('8000')));
 o.rules[0].reasoning=rule.reasoning;o.rules.push({...F.clone(rule),ruleId:'R9'});assert.ok(F.C.validateOutput(o,s).length);
});
