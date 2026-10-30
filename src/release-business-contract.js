/* Shared structural contract. No interpretation or rewriting of natural-language output. */
'use strict';
const KTBusinessContract = (() => {
  const CATEGORIES = ['fields','notification_general','notification_record','notification_reminder','process','acl_app','acl_record','acl_field'];
  const PATHS = ['app/form/fields','app/notifications/general','app/notifications/perRecord','app/notifications/reminder','app/status','app/acl','record/acl','field/acl'];
  const LABELS = ['フィールド','アプリの条件通知','レコードの条件通知','リマインダー','プロセス管理','アプリのアクセス権','レコードのアクセス権','フィールドのアクセス権'];
  const EVENTS = ['recordAdded','recordEdited','commentAdded','statusChanged','fileImported'];
  const APP_RIGHTS = ['appEditable','recordViewable','recordAddable','recordEditable','recordDeletable','recordImportable','recordExportable'];
  const ACQUISITIONS = ['not_requested','loading','success','forbidden','failed','cancelled'];
  const obj = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const clone = x => JSON.parse(JSON.stringify(x));
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const pick = (v,keys) => Object.fromEntries(keys.filter(k=>Object.hasOwn(v||{},k)).map(k=>[k,clone(v[k])]));
  const escPointer = s => String(s).replace(/~/g,'~0').replace(/\//g,'~1');
  function pointer(value,p) {
    if(p===null || p==='') return value;
    if(typeof p!=='string'||!p.startsWith('/')||/~(?![01])/u.test(p)) return undefined;
    let v=value;
    for(const raw of p.slice(1).split('/')) {
      const k=raw.replace(/~1/g,'/').replace(/~0/g,'~');
      if(!v || !Object.hasOwn(v,k) || ['__proto__','prototype','constructor'].includes(k)) return undefined;
      v=v[k];
    }
    return v;
  }
  function project(kind,v) {
    if(!obj(v)) throw new Error('設定の構造を確認できません');
    const entity=e=>{if(!obj(e)||typeof e.type!=='string'||!(typeof e.code==='string'||e.code===null))throw new Error('対象者の構造を確認できません');return pick(e,['type','code']);};
    const targets=a=>{if(!Array.isArray(a))throw new Error('対象者一覧を確認できません');return a.map(t=>{if(!obj(t)||typeof t.includeSubs!=='boolean')throw new Error('対象者の指定を確認できません');return {...pick(t,['includeSubs']),entity:entity(t.entity)};});};
    const strings=(keys)=>{for(const k of keys)if(typeof v[k]!=='string')throw new Error('設定の文字列を確認できません');};
    const bools=(value,keys)=>{for(const k of keys)if(typeof value[k]!=='boolean')throw new Error('許可または有効状態を確認できません');};
    if(kind==='field'){strings(['code','label','type']);return pick(v,['code','label','type','parent']);}
    if(kind==='notification_general'){bools(v,['includeSubs',...EVENTS]);return {...pick(v,['includeSubs',...EVENTS]),entity:entity(v.entity)};}
    if(kind==='comment_notification'){bools(v,['notifyToCommenter']);return pick(v,['notifyToCommenter']);}
    if(kind==='notification_record'||kind==='notification_reminder'){
      strings(['filterCond','title']);const o={filterCond:v.filterCond,title:v.title,targets:targets(v.targets)};
      if(kind==='notification_reminder'){if(!obj(v.timing)||typeof v.timing.code!=='string'||typeof v.timing.daysLater!=='string')throw new Error('通知日時を確認できません');for(const k of ['hoursLater','time'])if(Object.hasOwn(v.timing,k)&&typeof v.timing[k]!=='string')throw new Error('通知日時の形式が不正です');o.timing=pick(v.timing,['code','daysLater','hoursLater','time']);if(Object.hasOwn(v,'timezone')){if(typeof v.timezone!=='string')throw new Error('タイムゾーンが不正です');o.timezone=v.timezone;}}
      return o;
    }
    if(kind==='process_state'){strings(['name','index']);if(!obj(v.assignee)||typeof v.assignee.type!=='string')throw new Error('作業者方式を確認できません');return {name:v.name,index:v.index,assignee:{type:v.assignee.type,entities:targets(v.assignee.entities)}};}
    if(kind==='process_action'){strings(['name','from','to','filterCond']);const o=pick(v,['name','from','to','filterCond','type']);if(v.executableUser!=null)o.executableUser={entities:targets(v.executableUser.entities)};return o;}
    if(kind==='acl_app'){bools(v,['includeSubs',...APP_RIGHTS]);return {...pick(v,['includeSubs',...APP_RIGHTS]),entity:entity(v.entity)};}
    if(kind==='acl_record'||kind==='acl_field'){
      strings(kind==='acl_record'?['filterCond']:['code']);
      if(!Array.isArray(v.entities))throw new Error('アクセス権対象を確認できません');
      return {...pick(v,kind==='acl_record'?['filterCond']:['code']),entities:v.entities.map(t=>{
        bools(t,['includeSubs',...(kind==='acl_record'?['viewable','editable','deletable']:[])]);
        if(kind==='acl_field'&&typeof t.accessibility!=='string')throw new Error('フィールド権限を確認できません');
        return {...pick(t,kind==='acl_record'?['includeSubs','viewable','editable','deletable']:['includeSubs','accessibility']),entity:entity(t.entity)};
      })};
    }
    throw new Error('対応していない設定の種類です');
  }
  function issues(kind,v) {
    const out=[];
    function walk(x){if(!obj(x)&&!Array.isArray(x))return;if(obj(x)&&x.entity&&!['USER','GROUP','ORGANIZATION','FIELD_ENTITY','CREATOR','CUSTOM_FIELD'].includes(x.entity.type))out.push('対象者の指定方式を解釈できません：'+x.entity.type);for(const y of Object.values(x))walk(y);}
    walk(v);
    if(kind==='process_state'&&!['ONE','ALL','ANY'].includes(v.assignee.type))out.push('作業者方式を解釈できません');
    if(kind==='process_action'&&!['PRIMARY','SECONDARY'].includes(v.type))out.push('アクションの実行対象を解釈できません');
    if(kind==='process_action'&&v.type==='SECONDARY'&&!v.executableUser)out.push('実行対象の指定を確認できません');
    if(kind==='acl_field'&&v.entities.some(e=>!['READ','WRITE','NONE'].includes(e.accessibility)))out.push('フィールドの許可を解釈できません');
    return out;
  }
  const categoryOf = kind => typeof kind!=='string'?null:kind==='field'?'fields':kind.startsWith('process_')?'process':kind==='comment_notification'?'notification_general':kind;
  const eligible = e => e.category!=='fields'&&e.active!==false&&!issues(e.kind,e.value).length;
  function validateSnapshot(s,{generatable=true}={}) {
    const errors=[];const fail=m=>errors.push(m);
    if(!obj(s)||s.schemaVersion!=='business-snapshot-1'||typeof s.snapshotId!=='string'||!s.snapshotId||typeof s.appId!=='string'||!s.appId||!['production','preview'].includes(s.environment))return ['設定の取得元が不正です'];
    const keys=['schemaVersion','snapshotId','appId','environment','startedAt','completedAt','consistency','revision','categories','evidence','limitations'];
    if(Object.keys(s).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(s,k)))fail('取得結果の項目が不正です');
    if(!['verified','unverified','mismatch'].includes(s.consistency)||!Number.isFinite(Date.parse(s.startedAt))||(s.completedAt!==null&&!Number.isFinite(Date.parse(s.completedAt))))fail('取得日時・版の確認状態が不正です');
    if(generatable&&(!s.completedAt||s.consistency!=='verified'||typeof s.revision!=='string'||!s.revision))fail('同じ設定の版を確認してから作成してください');
    if(!Array.isArray(s.categories)||s.categories.length!==8||new Set(s.categories.map(c=>c?.category)).size!==8)return [...errors,'設定カテゴリが不足しています'];
    for(const c of s.categories) {
      if(!obj(c)||!CATEGORIES.includes(c.category)||!ACQUISITIONS.includes(c.acquisition)||!['present','empty','unknown'].includes(c.presence)||!['enabled','disabled','not_applicable','unknown'].includes(c.activation)||!Array.isArray(c.interpretationIssues)||c.interpretationIssues.some(x=>typeof x!=='string')){fail('取得状態が不正です');continue;}
      if(Object.keys(c).some(k=>!['category','acquisition','presence','activation','itemCount','revision','fetchedAt','error','interpretationIssues'].includes(k)))fail('未知の取得属性です');
      if(c.acquisition==='success'){
        if(!Number.isInteger(c.itemCount)||c.itemCount<0||!Number.isFinite(Date.parse(c.fetchedAt)))fail('取得件数・日時が不正です');
        if(c.presence!==(c.itemCount?'present':'empty')||c.error!==null||(c.category==='process'?!['enabled','disabled'].includes(c.activation):c.activation!=='not_applicable'))fail('設定の有無・有効状態が不正です');
        if(s.consistency==='verified'&&c.revision!==s.revision)fail('設定の版が一致しません');
      } else if(c.itemCount!==null||c.presence!=='unknown'||c.activation!=='unknown')fail('取得失敗を空の設定にできません');
      if(generatable&&['loading','not_requested','cancelled'].includes(c.acquisition))fail('取得が完了していません');
      if(c.error!==null&&(!obj(c.error)||Object.keys(c.error).some(k=>!['code','message'].includes(k))||typeof c.error.message!=='string'))fail('エラー情報が不正です');
    }
    if(errors.length)return errors;
    if(s.revision!==null&&(typeof s.revision!=='string'||!s.revision))fail('設定の版が不正です');
    if(s.consistency==='verified'&&(typeof s.revision!=='string'||!s.revision))fail('確認済みの版が必要です');
    if(s.consistency==='verified'&&s.categories.find(c=>c.category==='fields')?.acquisition!=='success')fail('フィールドの版を確認できません');
    if(!Array.isArray(s.evidence)||!Array.isArray(s.limitations))return [...errors,'根拠・確認範囲が必要です'];
    if(generatable&&s.evidence.length>500)fail('根拠が500件を超えています');
    const ids=new Set();
    for(const [i,e] of s.evidence.entries()) {
      if(!obj(e)||e.evidenceId!=='B'+(i+1)||ids.has(e.evidenceId)||e.snapshotId!==s.snapshotId){fail('根拠IDが不正です');continue;}ids.add(e.evidenceId);
      if(Object.keys(e).some(k=>!['evidenceId','snapshotId','category','kind','source','label','active','value','linkedEvidenceIds','unresolvedReferences'].includes(k)))fail('未知の根拠属性です');
      const c=s.categories.find(c=>c.category===e.category);
      if(!c||c.acquisition!=='success'||categoryOf(e.kind)!==e.category||!obj(e.source)||Object.keys(e.source).some(k=>!['pointer','revision','fetchedAt'].includes(k))||typeof e.source.pointer!=='string'||e.source.revision!==c.revision||e.source.fetchedAt!==c.fetchedAt||typeof e.label!=='string'||![true,false,null].includes(e.active))fail('根拠の取得元が一致しません');
      if(e.category!=='process'&&e.active!==null)fail('対象外の有効状態です');
      if(e.category==='process'&&e.active!==(c?.activation==='enabled'))fail('プロセスの有効状態が一致しません');
      if(!Array.isArray(e.linkedEvidenceIds)||!Array.isArray(e.unresolvedReferences)||e.unresolvedReferences.some(x=>typeof x!=='string'))fail('参照情報が不正です');
      try {if(!same(project(e.kind,e.value),e.value))fail('許可していない設定属性です');}catch(_){fail('設定の構造が不正です');}
    }
    if(errors.length)return errors;
    for(const c of s.categories)if(c.acquisition==='success'&&c.itemCount!==s.evidence.filter(e=>e.category===c.category).length)fail('設定件数が一致しません');
    for(const e of s.evidence)if(e.linkedEvidenceIds?.some(id=>!ids.has(id)))fail('未知の関連設定です');
    for(const l of s.limitations)if(!obj(l)||Object.keys(l).some(k=>!['limitationId','kind','categories','evidenceIds','message'].includes(k))||typeof l.limitationId!=='string'||!['acquisition','interpretation','excluded_scope'].includes(l.kind)||!Array.isArray(l.categories)||l.categories.some(c=>!CATEGORIES.includes(c))||!Array.isArray(l.evidenceIds)||l.evidenceIds.some(id=>!ids.has(id))||typeof l.message!=='string')fail('確認範囲が不正です');
    if(generatable&&!s.evidence.some(e=>{try{return eligible(e);}catch(_){return false;}}))fail('業務ルールを推測できる設定がありません');
    return errors;
  }
  const str=maxLength=>({type:'string',maxLength});
  const arr=(items,maxItems,minItems=0)=>({type:'array',items,maxItems,minItems});
  const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
  const refSchema=object({evidenceId:str(80),pointer:{type:['string','null'],maxLength:1000}});
  const relationNames=['notification_target','assignee','action_executor','view_allowed','edit_allowed','other_permission'];
  const stepSchema=object({interpretation:str(600),evidenceRefs:arr(refSchema,20)});
  const OUTPUT_SCHEMA=object({
    schemaVersion:{type:'string',enum:['business-understanding-1']},snapshotId:str(200),
    rules:arr(object({ruleId:str(40),inference:str(600),basis:{type:'string',enum:['single_setting','cross_setting']},evidenceRefs:arr(refSchema,20,1),reasoning:str(600),
      participants:arr(object({roleHypothesis:str(120),settingRelations:arr(object({relation:{type:'string',enum:relationNames},evidenceRef:refSchema}),8,1)}),8),
      trigger:stepSchema,nextAction:stepSchema,questions:arr(object({question:str(300),whyItMatters:str(300),relatedEvidenceRefs:arr(refSchema,20)}),5)}),8),
    unassignedEvidence:arr(object({evidenceId:str(80),reason:{type:'string',enum:['insufficient_clues','conflicting_clues','context_only','output_limit']}}),500),
    noRuleReason:{type:['string','null'],maxLength:600}
  });
  function schemaErrors(v,s,path='$',out=[]) {
    const types=Array.isArray(s.type)?s.type:[s.type];const t=v===null?'null':Array.isArray(v)?'array':typeof v;
    if(!types.includes(t)){out.push(path+': 型が不正です');return out;}
    if(s.enum&&!s.enum.includes(v))out.push(path+': 語彙が不正です');
    if(t==='string'&&((s.maxLength&&v.length>s.maxLength)||!v.trim()))out.push(path+': 文字列が空か上限を超えています');
    if(t==='array'){if(v.length>s.maxItems||v.length<(s.minItems||0))out.push(path+': 件数が不正です');v.forEach((x,i)=>schemaErrors(x,s.items,path+'['+i+']',out));}
    if(t==='object'){if(Object.keys(v).some(k=>!Object.hasOwn(s.properties,k))||s.required.some(k=>!Object.hasOwn(v,k)))out.push(path+': 項目が不正です');for(const [k,sub]of Object.entries(s.properties))if(Object.hasOwn(v,k))schemaErrors(v[k],sub,path+'.'+k,out);}
    return out;
  }
  function relationValid(rel,e,p) {
    const v=pointer(e.value,p); if(!obj(v))return false;
    if(rel==='notification_target')return (['notification_record','notification_reminder'].includes(e.kind)&&/^\/targets\/[0-9]+$/.test(p)&&obj(v.entity))||(e.kind==='notification_general'&&p===null);
    if(rel==='assignee')return e.kind==='process_state'&&/^\/assignee\/entities\/[0-9]+$/.test(p)&&obj(v.entity);
    if(rel==='action_executor')return e.kind==='process_action'&&e.value.type==='SECONDARY'&&/^\/executableUser\/entities\/[0-9]+$/.test(p)&&obj(v.entity);
    const acl=e.kind==='acl_app'&&p===null||['acl_record','acl_field'].includes(e.kind)&&/^\/entities\/[0-9]+$/.test(p);
    if(!acl||!obj(v.entity))return false;
    if(rel==='view_allowed')return e.kind==='acl_app'?v.recordViewable===true:e.kind==='acl_record'?v.viewable===true:['READ','WRITE'].includes(v.accessibility);
    if(rel==='edit_allowed')return e.kind==='acl_app'?v.recordEditable===true:e.kind==='acl_record'?v.editable===true:v.accessibility==='WRITE';
    return rel==='other_permission';
  }
  function validateOutput(o,s) {
    const errors=schemaErrors(o,OUTPUT_SCHEMA);if(errors.length)return errors;
    if(o.snapshotId!==s.snapshotId)errors.push('根拠の取得回が異なります');
    if((o.rules.length===0)!==(o.noRuleReason!==null))errors.push('候補ゼロの理由が不正です');
    const map=new Map(s.evidence.map(e=>[e.evidenceId,e])), used=new Set(),unassigned=new Set();
    const check=(refs,allowed=null)=>{const seen=new Set();for(const r of refs){const e=map.get(r.evidenceId),key=JSON.stringify(r);if(!e||!eligible(e)||pointer(e.value,r.pointer)===undefined||seen.has(key)||(allowed&&!allowed.has(r.evidenceId)))errors.push('根拠参照が不正です');seen.add(key);}};
    let chars=0;const count=v=>{if(typeof v==='string')chars+=v.length;else if(v&&typeof v==='object')for(const [k,x]of Object.entries(v))if(!['evidenceId','pointer','snapshotId','schemaVersion','ruleId','basis','reason','relation'].includes(k))count(x);};
    count(o);if(chars>8000)errors.push('説明全体が8000文字を超えています');
    o.rules.forEach((r,i)=>{
      if(r.ruleId!=='R'+(i+1))errors.push('候補IDが不正です');
      check(r.evidenceRefs);const ids=new Set(r.evidenceRefs.map(x=>x.evidenceId));ids.forEach(id=>used.add(id));
      if(r.basis!==(ids.size>1?'cross_setting':'single_setting'))errors.push('根拠の種類が一致しません');
      check(r.trigger.evidenceRefs,ids);check(r.nextAction.evidenceRefs,ids);r.questions.forEach(q=>check(q.relatedEvidenceRefs,ids));
      r.participants.forEach(p=>p.settingRelations.forEach(t=>{check([t.evidenceRef],ids);const e=map.get(t.evidenceRef.evidenceId);if(!e||!relationValid(t.relation,e,t.evidenceRef.pointer))errors.push('関係者の設定参照が一致しません');}));
    });
    for(const u of o.unassignedEvidence){const e=map.get(u.evidenceId);if(!e||!eligible(e)||used.has(u.evidenceId)||unassigned.has(u.evidenceId))errors.push('未整理の根拠が不正です');unassigned.add(u.evidenceId);}
    for(const e of s.evidence.filter(eligible))if(!used.has(e.evidenceId)&&!unassigned.has(e.evidenceId))errors.push('説明されていない根拠があります');
    return errors;
  }
  function context(snapshot,question='設定を横断して業務ルールの候補を整理してください。') {
    const errors=validateSnapshot(snapshot);if(errors.length)throw new Error(errors[0]);
    const ctx={contextVersion:'1',releaseContract:'release-workspace-1',clientCapabilities:['appExplanation','businessUnderstandingV1'],requestPurpose:'document',question,
      app:{id:snapshot.appId,name:null},focus:{resolution:'resolved',target:{type:'business-understanding',id:snapshot.appId},candidates:[]},
      facts:[],coverage:{fields:true,dependencies:false,javascript:false,incoming:false,plugins:false,recordData:false,adminNotes:false},truncation:{applied:false,sections:[]},
      businessSnapshot:clone(snapshot),conversation:{mode:'proposal',proposal:null,requirements:[],decisions:[],discussion:[]}};
    if(new TextEncoder().encode(JSON.stringify(ctx)).length>256*1024)throw new Error('設定が送信上限を超えています。設定一覧は保存できます。');
    return ctx;
  }
  return {CATEGORIES,PATHS,LABELS,EVENTS,APP_RIGHTS,project,issues,categoryOf,eligible,validateSnapshot,validateOutput,OUTPUT_SCHEMA,context,pointer,escPointer,clone};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTBusinessContract };
