'use strict';
// Synthetic procurement workflow. All collection functions return local constants.
const F=require('./business-fixture.js');
const group=code=>({entity:{type:'GROUP',code},includeSubs:false});
const STATE_NAMES=[
 '申請内容の下書き','申請を受け付ける','部門長が必要性を確認する','予算担当が費用を確認する',
 '購買担当が依頼内容を整理する','取引先の登録内容を確認する','見積条件と比較資料を確認する','法務が契約条件を確認する',
 '情報管理担当が取扱情報を確認する','経理が支払条件と税区分を確認する','調達責任者が発注内容を承認する','発注書を作成して送付内容を確認する',
 '取引先からの受注確認を待つ','納品予定日と分納条件を確認する','物品または役務の納品を受け付ける','利用部門が検収結果を登録する',
 '差異の調査結果と再検収日を確認する','請求書を受け付けて照合する','経理が仕訳と計上月を確認する','支払責任者が支払予定を承認する',
 '支払結果を確認する','関連資料を保管する','完了後の問合せを受け付ける','取消理由と関連する記録を保管する'
];
const ROLES=['requesters','department_managers','budget_team','purchasing','legal','information_management','accounting'];
function complexRaw(){
 const raw=F.raw();
 raw.fields.properties={
  ステータス:{code:'ステータス',label:'ステータス',type:'STATUS'},
  金額:{code:'金額',label:'予定金額',type:'NUMBER',required:true},
  急ぎ:{code:'急ぎ',label:'至急対応',type:'DROP_DOWN'},
  due:{code:'due',label:'対応期限',type:'DATE'},memo:{code:'memo',label:'共通の確認メモ',type:'MULTI_LINE_TEXT'},
  担当者:{code:'担当者',label:'担当者',type:'USER_SELECT'},経理判定:{code:'経理判定',label:'経理判定',type:'DROP_DOWN'}
 };
 for(let i=0;i<16;i++)raw.fields.properties['note_'+i]={code:'note_'+i,label:'工程'+(i+1)+'の入力・確認結果',type:'MULTI_LINE_TEXT',required:i%4===0};
 raw.process.states=Object.fromEntries(STATE_NAMES.map((name,i)=>[name,{name,index:String(i),assignee:{type:i%3===0?'ALL':i%3===1?'ONE':'ANY',entities:[group(ROLES[i%ROLES.length])]}}]));
 const action=(name,from,to,filterCond='',secondary=false)=>({name,from:STATE_NAMES[from],to:STATE_NAMES[to],filterCond,type:secondary?'SECONDARY':'PRIMARY',...(secondary?{executableUser:{entities:[group('purchasing')]}}:{})});
 raw.process.actions=Array.from({length:23},(_,i)=>action('確認結果を登録して次の確認へ進める '+(i+1),i,i+1,i===9?'経理判定 in ("確認済み")':''));
 raw.process.actions.push(
  action('予算確認へ分岐する',1,3,'金額 >= 100000'),
  action('承認済みの予算を使って購買へ進む',2,4,'金額 < 100000'),
  action('標準契約で法務確認を省略する',6,8,'急ぎ in ("いいえ")'),
  action('不足資料の追記を申請者へ依頼する',4,0,'memo = "資料不足"',true),
  action('契約条件の修正を購買へ依頼する',7,4,'memo = "条件修正"',true),
  action('税区分を確認して再審査する',9,9,'経理判定 in ("再確認")'),
  action('納品予定日を再確認する',13,13,'due <= TODAY()'),
  action('検収差異の調査へ分岐する',15,16,'memo = "差異あり"'),
  action('差異なしとして請求照合へ合流する',15,17,'memo = "差異なし"'),
  action('再納品後に検収へ戻す',16,15,'memo = "再納品済み"',true),
  action('少額支払を承認する',18,19,'金額 < 100000'),
  action('高額支払を追加確認して承認する',18,19,'金額 >= 100000'),
  action('請求内容の修正へ差し戻す',19,17,'経理判定 in ("要修正")',true),
  action('完了後の問合せから購買へ戻す',22,4,'memo != ""',true),
  action('申請を取り消して記録を保管する',0,23,'memo = "取消"',true),
  action('取引先都合で発注を取り消す',12,23,'memo = "取消"',true)
 );
 raw.notification_general={notifyToCommenter:true,notifications:[{...group('purchasing'),recordAdded:true,recordEdited:false,commentAdded:true,statusChanged:true,fileImported:false}]};
 raw.notification_record.notifications=STATE_NAMES.slice(0,16).map((name,i)=>({filterCond:'ステータス = "'+name+'"'+(i%3===0?' and 金額 >= 100000':''),title:'工程'+(i+1)+'の内容を確認してください。\n不備があれば理由を記録して差し戻してください。',targets:[group(ROLES[i%ROLES.length])]}));
 raw.notification_reminder.notifications=[{timing:{code:'due',daysLater:'-1',time:'09:00'},filterCond:'ステータス != "'+STATE_NAMES[21]+'"',title:'期限が近づいています。対応状況を確認してください。',targets:[group('purchasing')]},{timing:{code:'due',daysLater:'1',time:'10:00'},filterCond:'経理判定 in ("再確認")',title:'期限超過の確認依頼です。担当者と対応予定を共有してください。',targets:[group('accounting')]}];
 raw.acl_record.rights=[{filterCond:'ステータス = "'+STATE_NAMES[21]+'"',entities:[{...group('requesters'),viewable:true,editable:false,deletable:false},{...group('purchasing'),viewable:true,editable:true,deletable:false}]}];
 raw.acl_field.rights=Array.from({length:16},(_,i)=>({code:'note_'+i,entities:[{...group(ROLES[i%ROLES.length]),accessibility:'WRITE'},{...group('auditors'),accessibility:'READ'}]}));
 raw.javascript.desktop.js=[{type:'FILE',file:{name:'synthetic-procurement-input.js',fileKey:'local-fixture-js',size:'256'}}];
 raw.plugins.plugins=[{id:'synthetic-export-plugin',name:'帳票出力補助（合成テスト）',enabled:true}];
 return raw;
}
async function makeComplexFixture({snapshotId='complex-workflow-1',revision='57',environment='production',parallel=false}={}){
 const data=complexRaw();
 if(parallel){
  const action=(name,from,to)=>({name,from:STATE_NAMES[from],to:STATE_NAMES[to],filterCond:'',type:'PRIMARY'});
  data.process.actions=STATE_NAMES.slice(1,-1).flatMap((_,i)=>[action('担当部門へ分岐 '+(i+1),0,i+1),action('確認結果を合流 '+(i+1),i+1,23)]);
  data.process.actions.push(action('確認し直す',8,8),action('申請内容へ差し戻す',17,0));
 }
 for(const category of Object.values(data))category.revision=revision;
 const {s:snapshot}=await F.snapshot({data,snapshotId,environment,now:()=> '2026-11-04T02:00:00.000Z',download:async key=>{if(key!=='local-fixture-js')throw Error('Unexpected synthetic file');return "kintone.events.on('app.record.edit.change.金額',function(event){event.record.memo.value='金額の変更内容を確認';return event;});";}});
 const kind=k=>snapshot.evidence.filter(e=>e.kind===k),states=kind('process_state'),actions=kind('process_action'),notices=kind('notification_record'),acls=kind('acl_field');
 const ref=(e,pointer=null)=>({evidenceId:e.evidenceId,pointer}),field=i=>kind('field').find(e=>e.value.code==='note_'+i),reminder=kind('notification_reminder')[0];
 const rules=Array.from({length:16},(_,i)=>{
  const state=i<14?states[i]:null,action=state?actions.find(e=>e.value.from===state.value.name):null,notice=notices[i],acl=acls[i],input=field(i),custom=i===14?kind('javascript')[0]:i===15?kind('plugin')[0]:null;
  const base=[state,action,input,notice,acl,reminder,custom].filter(Boolean),refs=base.map(e=>ref(e));
  const stageName=i<14?'【購買・契約・支払の連携】'+STATE_NAMES[i]+'ために担当部門で必要な入力と確認を行う':i===14?'金額を変更したときに入力内容の確認メモを補助する':('完了後の関連資料を帳票として整理し、関係部門と保管方法を確認する工程。').repeat(4).slice(0,120);
  return {ruleId:'R'+(i+1),stageName,processStateId:state?.evidenceId||null,basis:'cross_setting',evidenceRefs:refs,
   inference:i<14?'担当部門が内容と確認結果を整理し、次の判断へ引き渡す運用の可能性があります。':i===14?'金額変更時の確認メモをJavaScriptで補助する可能性があります。':'プラグイン名から帳票整理の補助が想定されますが、利用実態は未確認です。',
   reasoning:'入力項目・編集許可・通知先を組み合わせた推測です。役割や作業義務を確定するものではありません。',
   participants:[{roleHypothesis:'工程'+(i+1)+'の内容を確認する役割の候補',settingRelations:[...(state?[{relation:'assignee',evidenceRef:ref(state,'/assignee/entities/0')}]:[]),{relation:'notification_target',evidenceRef:ref(notice,'/targets/0')},{relation:'edit_allowed',evidenceRef:ref(acl,'/entities/0')}]}],
   trigger:{interpretation:state?'「'+state.value.name+'」の状態となった後に確認する想定です。':'関連する入力や資料の整理を行う場面が想定されます。発生時期は要確認です。',evidenceRefs:[ref(state||custom)]},
   nextAction:{interpretation:state?'操作ごとの条件を確認し、必要な入力を補完して遷移先へ進める想定です。':'次の標準工程との接続は設定だけでは特定できません。',evidenceRefs:[ref(action||custom)]},
   inputs:[{kind:i===14?'automatic':i%2?'check':'input',interpretation:'工程'+(i+1)+'の確認結果を入力または照合する想定です。編集可能でも作業義務は未確定です。',evidenceRefs:[ref(input),ref(acl),...(i===14?[ref(custom)]:[])]}],
   notifications:[{interpretation:'状態や金額の条件を満たす場合に確認依頼が届く可能性があります。配信実績は未確認です。',evidenceRefs:[ref(notice)]},{interpretation:'期限前に対応状況を再確認する想定です。実際の担当者は要確認です。',evidenceRefs:[ref(reminder)]}],
   questions:[{question:i<14?'この確認を担当する人と、差し戻す条件はどのように決めていますか。':'この補助機能を実際に使う人・時期・結果を確認できますか。',whyItMatters:'通知先や編集権限だけでは担当と義務を断定できないためです。',relatedEvidenceRefs:[ref(notice),ref(acl),...(custom?[ref(custom)]:[])]}]
  };
 });
 const used=new Set(rules.flatMap(r=>r.evidenceRefs.map(e=>e.evidenceId)));
 const businessUnderstanding={schemaVersion:'business-workflow-1',snapshotId:snapshot.snapshotId,rules,unassignedEvidence:snapshot.evidence.filter(F.C.eligible).filter(e=>!used.has(e.evidenceId)).map(e=>({evidenceId:e.evidenceId,reason:'context_only'})),noRuleReason:null};
 const answer={...F.answer(snapshot),reply:'合成の購買・契約・支払業務を工程ごとに整理しました。',proposalUnchanged:true,businessUnderstanding};
 const errors=[...F.C.validateSnapshot(snapshot,{workflow:true}),...F.C.validateOutput(businessUnderstanding,snapshot)];if(errors.length)throw Error('Invalid complex fixture: '+errors.join('; '));
 return {snapshot,answer};
}
// These deliberately partial 24-state answers represent pre-existing saved analyses.
// New all-stage requests must not generate this fixture; exercise history restoration.
async function restoreComplexDocument(controller,data){
 if(!controller.saveBusinessSnapshot(data.snapshot))throw Error('Could not save historical fixture source');
 const saved=controller.exportSession(),doc=saved.state.explanations.at(-1);
 Object.assign(doc,{businessUnderstanding:structuredClone(data.answer.businessUnderstanding),schemaVersion:'business-workflow-1',title:'保存済み合成工程資料'});
 if(!await controller.restoreSession(saved))throw Error('Could not restore historical workflow fixture');
 return controller.getState().explanations.at(-1);
}
module.exports={makeComplexFixture,restoreComplexDocument,STATE_NAMES};
