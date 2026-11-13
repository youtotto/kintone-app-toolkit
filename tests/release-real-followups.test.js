 'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {KTReleaseView:V}=require('../src/release-view.js');
const {KTBusinessView:BV}=require('../src/release-business-view.js');
const F=require('./helpers/business-fixture.js');
test('旧保存診断とAIが権限の未確認を省略した診断でも画面・コピー・書き出しに明示する',()=>{
 const doc={id:'diagnosis-1',title:'診断',sections:[{heading:'権限',paragraphs:['Everyoneに編集・削除の許可が設定されています。'],items:[],evidenceIds:[]}],unknowns:[],diagnosisSource:{appId:'413',revision:'22',loadedAt:'2026-10-31T00:00:00Z'}};
 const saved=JSON.stringify(doc),state={phase:'idle',taskId:1,version:1,messages:[],runs:[],artifacts:[],explanations:[doc],explanationId:doc.id};
 for(const restored of [doc,JSON.parse(saved)]){
  const html=V.render({...state,explanations:[restored]}),md=V.explanationMarkdown(restored);
  for(const text of [html,md]){assert.match(text,/対象者の所属と個人別の実効権限は未確認です/);assert.match(text,/特定の人が実際に閲覧・編集・削除できるかは確定できません/);assert.equal((text.match(/個人別の実効権限は未確認/g)||[]).length,1);}
 }
 assert.equal(JSON.stringify(doc),saved,'AI本文・保存データを勝手に書き換えない');
 assert.doesNotMatch(V.explanationMarkdown({...doc,diagnosisSource:null}),/個人別の実効権限/);
});
test('コメント投稿者への通知は通常の宛先と区別し、画面・Markdown・保存復元で同じ関係を示す',async()=>{
 const data=F.raw();data.notification_general.notifyToCommenter=true;const {s}=await F.snapshot({data});
 const e=s.evidence.find(e=>e.kind==='comment_notification'),ref={evidenceId:e.evidenceId,pointer:null},o=F.output(s);
 o.rules[0].evidenceRefs.push(ref);o.rules[0].participants.push({roleHypothesis:'コメント共有先の候補',settingRelations:[{relation:'notification_target',evidenceRef:ref}]});o.unassignedEvidence=o.unassignedEvidence.filter(x=>x.evidenceId!==e.evidenceId);
 assert.deepEqual(F.C.validateOutput(o,s),[]);
 const doc={snapshot:s,businessUnderstanding:o};
 for(const d of [doc,F.clone(doc)])for(const text of [BV.outputHtml(d.businessUnderstanding,d.snapshot),BV.markdown(d)]){assert.match(text,/通知先：そのレコードのコメント投稿者/);assert.match(text,/通知先：グループ：accounting/);assert.doesNotMatch(text,/通知先：対象未確認/);}
 const disabled=F.clone(s);disabled.evidence.find(x=>x.evidenceId===e.evidenceId).value.notifyToCommenter=false;
 assert.match(BV.outputHtml(o,disabled),/通知先：対象未確認/,'無効な通知から宛先を推測しない');
});
