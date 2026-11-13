'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('./helpers/business-fixture.js');
const {KTBusinessView:V}=require('../src/release-business-view.js');
const ref=(e,pointer=null)=>({evidenceId:e.evidenceId,pointer});
function workflow(s){
  const o=F.output(s),r=o.rules[0],find=k=>s.evidence.find(e=>e.kind===k);
  o.schemaVersion='business-workflow-1';
  r.stageName='経理で申請内容を確認';r.processStateId=find('process_state')?.active?find('process_state').evidenceId:null;
  r.inputs=[{kind:'input',interpretation:'確認メモを補完する可能性があります。',evidenceRefs:[ref(find('acl_field'),'/entities/0')]},{kind:'check',interpretation:'内容と期限を確認する想定です。',evidenceRefs:[ref(find('notification_record'))]}];
  r.notifications=[{interpretation:'申請時の確認依頼に使う可能性があります。',evidenceRefs:[ref(find('notification_record'))]},{interpretation:'期限前に確認を促す可能性があります。',evidenceRefs:[ref(find('notification_reminder'))]}];
  r.evidenceRefs=s.evidence.filter(F.C.eligible).map(e=>ref(e));o.unassignedEvidence=[];
  return o;
}
const doc=(s,o)=>({title:'業務工程の確認',snapshot:s,businessUnderstanding:o});
test('工程概要と詳細で誰が・いつ・入力確認・通知・次の操作を分け、通知原文と推測も分ける',async()=>{
 const {s}=await F.snapshot(),o=workflow(s),html=V.outputHtml(o,s,id=>'<button data-rule="'+id+'">相談</button>');
 for(const label of ['工程','担当者','開始タイミング','入力・確認','通知','次へ進む条件・操作','根拠確認'])assert.ok(html.includes(label),label);
 assert.match(html,/通知設定の事実/);assert.match(html,/工程との関連（推測）/);
 assert.ok(html.includes(V.escape('ステータス = "申請済み" and (金額 >= 100 or 急ぎ in ("はい"))')));
 assert.ok(html.includes('内容を確認してください。\n不備は差し戻してください。'));
 assert.match(html,/グループ：accounting/);assert.match(html,/基準 due、-1日後、時刻 09:00、Asia\/Tokyo/);
 assert.match(html,/data-rule="R1"/);assert.match(html,/個人別の実効権限/);
 const anchors=[...html.matchAll(/href="#([^"]+)"/g)].map(x=>x[1]);for(const id of anchors)assert.ok(html.includes('id="'+id+'"'),id);
});
test('全ステータスと全遷移を保持し、分岐・戻り・同じ状態への遷移を勝手な直列にしない',async()=>{
 const data=F.raw();data.process.states.保留={name:'保留',index:'2',assignee:{type:'ALL',entities:[]}};
 data.process.actions.push({name:'保留する',from:'申請済み',to:'保留',filterCond:'memo = "要調査"',type:'PRIMARY'},{name:'再開する',from:'保留',to:'申請済み',filterCond:'',type:'PRIMARY'},{name:'再確認する',from:'申請済み',to:'申請済み',filterCond:'',type:'PRIMARY'});
 const {s}=await F.snapshot({data}),html=V.processHtml(s);
 assert.equal((html.match(/data-process-state=/g)||[]).length,3);assert.equal((html.match(/data-process-action=/g)||[]).length,5);
 for(const e of s.evidence.filter(e=>e.category==='process'))assert.ok(html.includes('workflow-process-'+e.evidenceId));
 assert.match(html,/申請済み → 保留/);assert.match(html,/確認済み → 申請済み/);assert.match(html,/申請済み → 申請済み/);
 assert.ok(html.includes(V.escape('memo = "要調査"')));assert.match(html,/表示順は進行順を意味しません/);
 assert.match(html,/作業者以外でも実行できるアクション/);
});
test('無効なプロセスは全定義を参考枠へ隔離し、現行工程の対応付けを表示しない',async()=>{
 const data=F.raw();data.process.enable=false;const {s}=await F.snapshot({data}),o=workflow(s);
 // Defensive rendering also avoids attaching an obsolete state if an old imported object names it.
 o.rules[0].processStateId=s.evidence.find(e=>e.kind==='process_state').evidenceId;
 const html=V.outputHtml(o,s),md=V.markdown(doc(s,o)),history=JSON.stringify(V.historyBody(doc(s,o)));
 assert.match(html,/参考：無効なプロセス定義/);assert.match(html,/現行の工程やJavaScriptの操作と接続して解釈しません/);
 assert.doesNotMatch(html,/対応する標準ステータス（設定の事実）/);
 assert.equal((html.match(/data-process-action=/g)||[]).length,2);
 assert.match(md,/参考：無効なプロセス定義/);assert.match(history,/無効プロセスの詳細/);assert.doesNotMatch(history,/参考：無効なプロセス定義/);
});
test('取得不可と明示設定なしを区別し、担当・入力・通知の根拠不足は要確認と表示',async()=>{
 const data=F.raw();data.process=Object.assign(Error('read failed'),{status:403});const {s}=await F.snapshot({data});
 assert.match(V.processHtml(s),/権限不足で取得不可/);assert.match(V.processHtml(s),/「設定なし」とは判断できません/);
 const empty=F.raw();empty.process={enable:false,states:{},actions:[],revision:'22'};const {s:e}=await F.snapshot({data:empty});assert.match(V.processHtml(e),/取得済み・明示設定なし/);
 const {s:normal}=await F.snapshot(),o=workflow(normal);o.rules[0].participants=[];o.rules[0].inputs=[];o.rules[0].notifications=[];
 const html=V.outputHtml(o,normal);assert.match(html,/担当者は未特定・要確認/);assert.match(html,/入力・確認・自動処理は未特定・要確認/);assert.match(html,/通知は未特定・要確認/);assert.match(html,/通知設定がないとは判断しません/);
});
test('コメント投稿者の通知先とJS由来で通知設定を特定できないケースを区別',async()=>{
 const data=F.raw();data.notification_general.notifyToCommenter=true;const {s}=await F.snapshot({data}),o=workflow(s),e=s.evidence.find(e=>e.kind==='comment_notification');
 o.rules[0].notifications=[{interpretation:'コメントした人への連絡の可能性があります。',evidenceRefs:[ref(e)]}];
 let html=V.outputHtml(o,s);assert.match(html,/そのレコードのコメント投稿者/);assert.match(html,/条件・タイミング：コメント追加/);
 o.rules[0].notifications=[{interpretation:'別の処理から通知される可能性は未確認です。',evidenceRefs:[]}];html=V.outputHtml(o,s);assert.match(html,/通知設定の条件・宛先・時刻は未特定・要確認/);
});
test('Markdownには全工程構造と根拠を保持し、一般履歴は詳細の所在を明示した索引にする',async()=>{
 const {s}=await F.snapshot(),o=workflow(s),r=o.rules[0],md=V.markdown(doc(s,o)),h=V.historyBody(doc(s,o)),history=JSON.stringify(h);
 assert.ok(md.indexOf('経理で申請内容を確認')<md.indexOf('根拠の原文一覧'));
 for(const text of [r.stageName,r.inference,r.reasoning,r.trigger.interpretation,r.nextAction.interpretation,...r.inputs.map(x=>x.interpretation),...r.notifications.map(x=>x.interpretation),...r.questions.flatMap(x=>[x.question,x.whyItMatters])])assert.ok(md.includes(text),text);
 for(const e of s.evidence.filter(e=>e.category==='process')){assert.ok(md.includes(e.evidenceId));assert.ok(md.includes(e.source.pointer));}
 assert.ok(history.includes(r.ruleId+' '+r.stageName));assert.ok(history.includes(s.appId));assert.ok(history.includes(s.revision));assert.ok(history.includes(s.startedAt));
 assert.match(history,/索引だけ/);assert.match(history,/保存資料または専用の工程相談/);
 assert.doesNotMatch(history,/補完は必須ですか/);assert.ok(!history.includes(r.nextAction.interpretation));assert.ok(!history.includes('/targets/0'));
 assert.ok(h.sections.every(x=>x.evidenceIds.length===0));assert.match(h.title,/過去の業務工程/);
});
test('最大16工程・120文字名・29プロセス根拠でも汎用履歴制限内に全工程索引を保持',async()=>{
 const data=F.raw();data.process.states=Object.fromEntries(Array.from({length:16},(_,i)=>['工程'+i,{name:'工程'+i,index:String(i),assignee:{type:'ANY',entities:[]}}]));
 data.process.actions=Array.from({length:13},(_,i)=>({name:'工程を進める'+i,from:'工程'+i,to:'工程'+(i+1),filterCond:'',type:'PRIMARY'}));
 const {s}=await F.snapshot({data}),states=s.evidence.filter(e=>e.kind==='process_state');
 const o={schemaVersion:'business-workflow-1',snapshotId:s.snapshotId,rules:states.map((e,i)=>({ruleId:'R'+(i+1),stageName:('工程'+i+' ').padEnd(120,'長'),processStateId:e.evidenceId,inference:'この状態の業務を行う想定です。',basis:'single_setting',evidenceRefs:[ref(e)],reasoning:'有効なステータスの設定があります。',participants:[],trigger:{interpretation:'開始条件は未確認です。',evidenceRefs:[]},nextAction:{interpretation:'次の操作は要確認です。',evidenceRefs:[]},inputs:[],notifications:[],questions:[]})),unassignedEvidence:s.evidence.filter(F.C.eligible).filter(e=>e.kind!=='process_state').map(e=>({evidenceId:e.evidenceId,reason:'context_only'})),noRuleReason:null};
 assert.deepEqual(F.C.validateOutput(o,s),[]);assert.equal(s.evidence.filter(e=>e.category==='process').length,29);assert.ok(s.evidence.length>20);
 const h=V.historyBody(doc(s,o)),{validateExplanation}=await import(require('./helpers/ai-repo.js').aiUrl('worker/src/v2/toolkit/app-explanation.mjs')),errors=[];
 validateExplanation(h,(path,message)=>errors.push({path,message}));assert.deepEqual(errors,[]);
 assert.equal(h.sections[1].items.length,16);for(const r of o.rules)assert.ok(h.sections[1].items.includes(r.ruleId+' '+r.stageName));
 assert.ok(JSON.stringify(h).length<6000);assert.equal(h.sections.length,2);assert.match(JSON.stringify(h),/工程数：16/);
 const md=V.markdown(doc(s,o));for(const e of s.evidence.filter(e=>e.category==='process'))assert.ok(md.includes(e.evidenceId));
});
test('工程ゼロの索引にも理由を保持し、汎用履歴の空節を作らない',async()=>{
 const {s}=await F.snapshot(),o={schemaVersion:'business-workflow-1',snapshotId:s.snapshotId,rules:[],unassignedEvidence:[],noRuleReason:'現在の工程を特定できません。'};
 const h=V.historyBody(doc(s,o)),{validateExplanation}=await import(require('./helpers/ai-repo.js').aiUrl('worker/src/v2/toolkit/app-explanation.mjs')),errors=[];
 validateExplanation(h,(path,message)=>errors.push({path,message}));assert.deepEqual(errors,[]);assert.equal(h.sections[1].paragraphs[0],o.noRuleReason);
});
test('設定値や工程名をHTMLとして実行せず、Markdown表も壊さない',async()=>{
 const {s}=await F.snapshot(),o=workflow(s);o.rules[0].stageName='<img src=x onerror=alert(1)> | 確認';o.rules[0].notifications[0].interpretation='<script>alert(1)</script>';
 const html=V.outputHtml(o,s);assert.doesNotMatch(html,/<img|<script>/);assert.match(html,/&lt;img/);assert.match(html,/&lt;script&gt;/);
 const md=V.markdown(doc(s,o));assert.ok(md.includes('\\| 確認'));
});
test('既存のbusiness-understanding-1は従来の見出しと保存形式を維持',async()=>{
 const {s}=await F.snapshot(),o=F.output(s),html=V.outputHtml(o,s),md=V.markdown(doc(s,o)),history=V.historyBody(doc(s,o));
 assert.match(html,/推測した業務ルール候補/);assert.doesNotMatch(html,/ktr-workflow/);assert.match(html,/発生条件・次の行動/);
 assert.ok(md.indexOf('設定から確認できたこと')<md.indexOf('推測した業務ルール候補'));
 assert.match(history.title,/過去の業務ルール候補/);assert.equal(history.sections[0].heading,'推測：R1');
});
