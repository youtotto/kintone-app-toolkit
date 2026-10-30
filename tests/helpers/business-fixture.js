'use strict';
const {KTBusinessContract:C}=require('../../src/release-business-contract.js');
const {KTBusinessSettings:S}=require('../../src/release-business-settings.js');
const clone=x=>structuredClone(x);
const target=()=>({entity:{type:'GROUP',code:'accounting'},includeSubs:false});
function raw(){
  const data={
    fields:{properties:{memo:{code:'memo',label:'確認メモ',type:'SINGLE_LINE_TEXT'},due:{code:'due',label:'期限',type:'DATE'}}},
    notification_general:{notifications:[],notifyToCommenter:false},
    notification_record:{notifications:[{filterCond:'ステータス = "申請済み" and (金額 >= 100 or 急ぎ in ("はい"))',title:'内容を確認してください。\n不備は差し戻してください。',targets:[target()]}]},
    notification_reminder:{notifications:[{timing:{code:'due',daysLater:'-1',time:'09:00'},filterCond:'ステータス != "完了"',title:'期限前の確認',targets:[target()]}],timezone:'Asia/Tokyo'},
    process:{enable:true,states:{申請済み:{name:'申請済み',index:'0',assignee:{type:'ANY',entities:[target()]}},確認済み:{name:'確認済み',index:'1',assignee:{type:'ONE',entities:[]}}},
      actions:[{name:'確認完了',from:'申請済み',to:'確認済み',filterCond:'',type:'PRIMARY'},{name:'差し戻す',from:'確認済み',to:'申請済み',filterCond:'',type:'SECONDARY',executableUser:{entities:[target()]}}]},
    acl_app:{rights:[{...target(),appEditable:false,recordViewable:true,recordAddable:true,recordEditable:true,recordDeletable:false,recordImportable:false,recordExportable:false}]},
    acl_record:{rights:[{filterCond:'ステータス = "確認済み"',entities:[{...target(),viewable:true,editable:false,deletable:false}]}]},
    acl_field:{rights:[{code:'memo',entities:[{...target(),accessibility:'WRITE'}]}]}
  };
  for(const value of Object.values(data))value.revision='22';return data;
}
async function snapshot(options={}){
  const data=options.data||raw(),calls=[];
  const s=await S.collect({appId:'310',environment:options.environment||'production',snapshotId:'fixture-business-1',now:()=> '2026-10-30T02:00:00.000Z',...options,
    get:options.get||(async(path,args)=>{calls.push({path,args});const i=C.PATHS.indexOf(path.replace('/k/v1/preview/','').replace('/k/v1/',''));if(i<0)throw new Error('unexpected request');const value=data[C.CATEGORIES[i]];if(value instanceof Error)throw value;return clone(value);})});
  return {s,calls,data};
}
function output(s){
  const find=kind=>s.evidence.find(e=>e.kind===kind).evidenceId;
  const ref=(kind,pointer=null)=>({evidenceId:find(kind),pointer});
  const evidenceRefs=['notification_record','process_state','acl_field','process_action'].map(k=>ref(k));
  const used=new Set(evidenceRefs.map(r=>r.evidenceId));
  return {schemaVersion:'business-understanding-1',snapshotId:s.snapshotId,rules:[{ruleId:'R1',inference:'申請後に経理が内容を確認・補完する運用の可能性があります。',basis:'cross_setting',evidenceRefs,
    reasoning:'通知の宛先・作業者候補と編集許可対象が共通しています。',participants:[{roleHypothesis:'内容を確認する役割の候補',settingRelations:[{relation:'notification_target',evidenceRef:ref('notification_record','/targets/0')},{relation:'assignee',evidenceRef:ref('process_state','/assignee/entities/0')},{relation:'edit_allowed',evidenceRef:ref('acl_field','/entities/0')}]}],
    trigger:{interpretation:'申請済みとなった後を想定しています。',evidenceRefs:[ref('notification_record')]},nextAction:{interpretation:'確認し必要事項を補完して次工程へ進める想定です。',evidenceRefs:[ref('process_action')]},
    questions:[{question:'補完は必須ですか。通知は作業依頼ですか。',whyItMatters:'編集許可と通知だけでは作業義務を判断できません。',relatedEvidenceRefs:[ref('acl_field'),ref('notification_record')]}]}],
    unassignedEvidence:s.evidence.filter(C.eligible).filter(e=>!used.has(e.evidenceId)).map(e=>({evidenceId:e.evidenceId,reason:'context_only'})),noRuleReason:null};
}
function answer(s){return {reply:'設定を根拠に業務ルールの候補を整理しました。',intent:'question',adoptQuote:'',explanation:null,proposal:{behaviors:[],assumptions:[],decisions:[],approach:{standard:[],js:[]},cannot:[]},turn:{ops:[],answers:[],requirementOps:[]},businessUnderstanding:output(s)};}
module.exports={raw,snapshot,output,answer,clone,C,S};
