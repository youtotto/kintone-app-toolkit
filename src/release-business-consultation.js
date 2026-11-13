/* Business handoff: immutable source, explicit user records, no prose interpretation. */
'use strict';
const KTBusinessConsultation = (() => {
  const C = () => typeof KTBusinessContract !== 'undefined' ? KTBusinessContract : require('./release-business-contract.js').KTBusinessContract;
  const VERSION='business-consultation-handoff-1', CAPABILITY='businessConsultationV1';
  const clone=x=>x==null?x:JSON.parse(JSON.stringify(x));
  const obj=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
  const stable=x=>Array.isArray(x)?x.map(stable):obj(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
  const equal=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
  const text=(x,n=2000)=>typeof x==='string'&&!!x.trim()&&x.length<=n;
  const exact=(x,keys)=>obj(x)&&Object.keys(x).every(k=>keys.includes(k))&&keys.every(k=>Object.hasOwn(x,k));
  const fail=m=>{throw Object.assign(new Error(m),{code:'BUSINESS_CONTEXT_INVALID'});};
  async function hash(value){return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(stable(value)))))].map(x=>x.toString(16).padStart(2,'0')).join('');}
  const sourceOf=h=>({sourceScope:h.sourceScope,snapshot:h.snapshot,analysis:h.analysis,referenceDocument:h.referenceDocument});
  const validScope=s=>exact(s,['domain','appId','environment','startedAt','completedAt','revision','snapshotId'])&&/^[a-z0-9.-]+$/i.test(s.domain)&&text(s.appId,100)&&['production','preview'].includes(s.environment)&&text(s.snapshotId,200)&&text(s.revision,100)&&Number.isFinite(Date.parse(s.startedAt))&&Number.isFinite(Date.parse(s.completedAt));
  const kinds=['current_operation','desired_change','open_question'],states=['draft','recorded','unknown','deferred','superseded','withdrawn'];
  const active=s=>!['superseded','withdrawn'].includes(s.state);
  const ruleRef=(h,id)=>({analysisId:h.analysisId,snapshotId:h.sourceScope.snapshotId,ruleId:id});
  const evidenceRef=(h,r)=>({snapshotId:h.sourceScope.snapshotId,evidenceId:r.evidenceId,pointer:r.pointer});
  const rules=h=>h.analysis?.rules||[];
  const selectedRules=h=>rules(h).filter(r=>h.selection.type==='all'||r.ruleId===h.selection.ruleId);
  function checkRef(h,r){return exact(r,['snapshotId','evidenceId','pointer'])&&r.snapshotId===h.sourceScope.snapshotId&&(r.pointer===null||typeof r.pointer==='string')&&(h.snapshot?.evidence||h.sourceBundle?.evidence||[]).some(e=>e.evidenceId===r.evidenceId&&C().pointer(e.value,r.pointer)!==undefined);}
  const checkRule=(h,r)=>exact(r,['analysisId','snapshotId','ruleId'])&&r.analysisId===h.analysisId&&r.snapshotId===h.sourceScope.snapshotId&&rules(h).some(x=>x.ruleId===r.ruleId);
  function validate(h,{wire=false}={}) {
    const errors=[];const bad=m=>errors.push(m);
    if(!obj(h)||h.schemaVersion!==VERSION||!validScope(h.sourceScope)||!text(h.handoffId,200)||!text(h.analysisId,100)||!/^[a-f0-9]{64}$/.test(h.analysisHash||''))return ['引き継ぎ元を確認できません'];
    if(Object.keys(h).some(k=>!['schemaVersion','handoffId','analysisId','analysisHash','sourceKind','sourceScope','selection','snapshot','analysis','referenceDocument','statements','messages','freshness','sourceBundle','attachmentExcludedIds','omittedStatementCount','questionHistory'].includes(k)))bad('未知の引き継ぎ属性です');
    if(!obj(h.freshness)||!['unchecked','unchanged','changed','unavailable'].includes(h.freshness.status)||!Array.isArray(h.freshness.rows))bad('照合結果が不正です');
    if(!exact(h.selection,['type','ruleId'])||!['all','rule'].includes(h.selection.type)||(h.selection.type==='all'?h.selection.ruleId!==null:!rules(h).some(r=>r.ruleId===h.selection.ruleId)))bad('選択したルールがありません');
    if(!['structured_business','reference_document'].includes(h.sourceKind))bad('未対応の資料です');
    if(h.sourceKind==='structured_business'){
      if(!wire){try{errors.push(...C().validateSnapshot(h.snapshot,{workflow:h.analysis?.schemaVersion==='business-workflow-1'}),...C().validateOutput(h.analysis,h.snapshot));}catch(_){bad('分析の構造が不正です');}
        if(h.snapshot?.snapshotId!==h.sourceScope.snapshotId||h.snapshot?.appId!==h.sourceScope.appId||h.snapshot?.environment!==h.sourceScope.environment||h.snapshot?.revision!==h.sourceScope.revision)bad('分析の取得元が一致しません');
      }else{
        const b=h.sourceBundle;
        if(!exact(b,['categories','evidence','limitations','unassignedEvidence','omittedEvidenceCount'])||!Array.isArray(b.categories)||!Array.isArray(b.evidence)||b.evidence.length>500||!Array.isArray(b.limitations)||!Number.isSafeInteger(b.omittedEvidenceCount)||b.omittedEvidenceCount<0)return [...errors,'相談の根拠資料が不正です'];
        if(![8,10].includes(b.categories.length)||new Set(b.categories.map(c=>c.category)).size!==b.categories.length||C().CATEGORIES.slice(0,8).some(k=>!b.categories.some(c=>c.category===k)))bad('取得範囲が不正です');
        for(const c of b.categories){if(!['success','failed','forbidden'].includes(c.acquisition)||!['enabled','disabled','not_applicable','unknown'].includes(c.activation)||!Array.isArray(c.interpretationIssues))bad('完了していない取得状態');if(Object.keys(c).some(k=>!['category','acquisition','presence','activation','itemCount','revision','fetchedAt','error','interpretationIssues'].includes(k)))bad('未知の取得属性');if(c.acquisition==='success'){if(c.presence!==(c.itemCount?'present':'empty')||!Number.isInteger(c.itemCount)||c.itemCount<0||c.revision!==h.sourceScope.revision||!Number.isFinite(Date.parse(c.fetchedAt)))bad('取得結果不正');}else if(c.presence!=='unknown'||c.itemCount!==null||c.activation!=='unknown')bad('取得失敗を空設定にできません');}
        for(const c of b.categories)if(!C().CATEGORIES.includes(c.category)||!['not_requested','loading','success','forbidden','failed','cancelled'].includes(c.acquisition)||!['present','empty','unknown'].includes(c.presence))bad('取得状態が不正です');
        const ids=new Set();for(const e of b.evidence){try{if(!/^B[1-9]\d*$/.test(e.evidenceId)||ids.has(e.evidenceId)||e.snapshotId!==h.sourceScope.snapshotId||!equal(C().project(e.kind,e.value),e.value))bad('根拠の構造が不正です');ids.add(e.evidenceId);if(Object.keys(e).some(k=>!['evidenceId','snapshotId','category','kind','source','label','active','value','linkedEvidenceIds','unresolvedReferences'].includes(k)))bad('未知の根拠属性');if(![true,false,null].includes(e.active)||typeof e.label!=='string'||typeof e.source?.pointer!=='string')bad('根拠の有効状態・取得位置が不正');const category=b.categories.find(c=>c.category===e.category);if(category&&(e.category==='process'?e.active!==(category.activation==='enabled'):e.kind==='javascript'?e.active!==(e.value.scope!=='NONE'):e.kind==='plugin'?e.active!==e.value.enabled:e.active!==null))bad('有効状態不一致');if(category&&category.itemCount<b.evidence.filter(x=>x.category===e.category).length)bad('取得件数より根拠が多い');if(!category||category.acquisition!=='success'||C().categoryOf(e.kind)!==e.category||!exact(e.source,['pointer','revision','fetchedAt'])||e.source.revision!==category.revision||e.source.fetchedAt!==category.fetchedAt||!Array.isArray(e.linkedEvidenceIds)||!Array.isArray(e.unresolvedReferences))bad('取得元不正');}catch(_){bad('根拠の構造が不正です');}}
        if(!Array.isArray(h.analysis?.rules)||rules(h).length>(h.analysis?.schemaVersion==='business-workflow-1'?16:8)||h.analysis.snapshotId!==h.sourceScope.snapshotId)bad('ルールの構造が不正です');
        if(schemaErrors(C().outputSchema(h.analysis),h.analysis).length)bad('分析の形が不正です');
        for(const r of rules(h)){const all=[...(r.evidenceRefs||[]),...(r.trigger?.evidenceRefs||[]),...(r.nextAction?.evidenceRefs||[]),...(r.questions||[]).flatMap(q=>q.relatedEvidenceRefs||[]),...(r.inputs||[]).flatMap(x=>x.evidenceRefs||[]),...(r.notifications||[]).flatMap(x=>x.evidenceRefs||[])];for(const ref of all){const e=b.evidence.find(e=>e.evidenceId===ref.evidenceId);if(!e||!C().canReference(e,h.analysis)||!checkRef(h,evidenceRef(h,ref)))bad('推測対象外の根拠');}for(const p of r.participants||[])for(const rel of p.settingRelations||[]){const e=b.evidence.find(e=>e.evidenceId===rel.evidenceRef.evidenceId);if(!e||!C().relationValid(rel.relation,e,rel.evidenceRef.pointer))bad('関係者の参照不正');}}
        if(h.analysis?.schemaVersion==='business-workflow-1')errors.push(...C().validateOutput(h.analysis,{snapshotId:h.sourceScope.snapshotId,evidence:b.evidence},{partial:true}));
        for(const r of rules(h))if(!Array.isArray(r.evidenceRefs)||!r.evidenceRefs.length||r.evidenceRefs.some(ref=>!checkRef(h,evidenceRef(h,ref))))bad('ルールの根拠が不正です');
      }
    }else if(h.selection.type!=='all'||h.analysis!==null||h.snapshot!==null||!obj(h.referenceDocument)||!text(h.referenceDocument.title,1000)||!Array.isArray(h.referenceDocument.sections)||!Array.isArray(h.referenceDocument.unknowns))bad('参考資料の構造が不正です');
    if(h.attachmentExcludedIds!==undefined&&(!Array.isArray(h.attachmentExcludedIds)||h.attachmentExcludedIds.some(id=>typeof id!=='string')))bad('添付選択が不正です');
    if(!Array.isArray(h.statements)||!Array.isArray(h.messages)||h.messages.some(m=>!exact(m,['id','role','text'])||!text(m.id,100)||!['user','assistant'].includes(m.role)||!text(m.text,m.role==='assistant'?128000:10000)))bad('相談の記録が不正です');
    if(h.questionHistory!==undefined&&(!Array.isArray(h.questionHistory)||h.questionHistory.some(q=>!exact(q,['questionId','text','purpose','blockingFor','ruleRefs','evidenceRefs','statementRefs','messageRefs'])||!text(q.questionId,100)||!text(q.text,500)||!text(q.purpose,500)||!['none','proposal','plan'].includes(q.blockingFor)||!Array.isArray(q.ruleRefs)||q.ruleRefs.some(r=>!checkRule(h,r))||!Array.isArray(q.evidenceRefs)||q.evidenceRefs.some(r=>!checkRef(h,r)))))bad('確認質問の履歴が不正です');
    const ids=new Set();for(const s of h.statements||[]){
      if(!exact(s,['statementId','kind','state','text','relationToHypothesis','sourceRuleRefs','sourceEvidenceRefs','sourceMessageId','sourceQuestionRef','origin','recordedAt','supersedes','reviewState'])||!/^BS[1-9]\d*$/.test(s.statementId)||ids.has(s.statementId)||!kinds.includes(s.kind)||!states.includes(s.state)||!text(s.text)||!['supports','corrects','supplements','unclear'].includes(s.relationToHypothesis)||!['user_form','user_message_confirmed','ai_draft'].includes(s.origin)||!['current','needs_review'].includes(s.reviewState)||!Number.isFinite(Date.parse(s.recordedAt))) {bad('運用の記録が不正です');continue;}
      ids.add(s.statementId);
      if(!Array.isArray(s.sourceRuleRefs)||s.sourceRuleRefs.some(r=>!checkRule(h,r))||!Array.isArray(s.sourceEvidenceRefs)||s.sourceEvidenceRefs.some(r=>!checkRef(h,r)))bad('回答の根拠が不正です');
      if(s.sourceQuestionRef!==null&&(!obj(s.sourceQuestionRef)||Object.keys(s.sourceQuestionRef).some(k=>!['analysisId','questionId'].includes(k))||s.sourceQuestionRef.analysisId!==h.analysisId||!text(s.sourceQuestionRef.questionId,100)))bad('質問の出所が不正です');
      if(s.sourceQuestionRef){const q=s.sourceQuestionRef.questionId;const sourceQuestion=rules(h).some(r=>r.questions?.some((_,i)=>q==='source:'+r.ruleId+':'+i));if(!sourceQuestion&&!(h.questionHistory||[]).some(x=>x.questionId===q))bad('回答元の質問がありません');}
      if(s.origin==='ai_draft'&&s.state!=='draft')bad('AIは回答を確定できません');
      if(s.sourceMessageId!==null&&!h.messages?.some(m=>m.id===s.sourceMessageId&&m.role==='user'))bad('回答元の発言がありません');
      if(!wire&&s.supersedes!==null&&!h.statements.some(x=>x.statementId===s.supersedes&&x.statementId!==s.statementId))bad('訂正元がありません');
    }
    if(wire&&(h.statements||[]).filter(active).length>30)bad('添付する運用記録は30件までです');
    return errors;
  }
  async function create(doc,scope,ruleId=null){
    if(!validScope(doc?.sourceScope)||doc.sourceScope.domain!==scope?.domain||doc.sourceScope.appId!==String(scope?.appId))fail('取得元のアプリ・ドメインを確認できません。対象の設定から資料を作り直してください。');
    const structured=doc.kind==='business-understanding';
    const h={schemaVersion:VERSION,handoffId:doc.id+':'+(ruleId||'all'),analysisId:doc.id,analysisHash:'',sourceKind:structured?'structured_business':'reference_document',sourceScope:clone(doc.sourceScope),selection:{type:ruleId?'rule':'all',ruleId},snapshot:structured?clone(doc.snapshot):null,analysis:structured?clone(doc.businessUnderstanding):null,referenceDocument:structured?null:clone({title:doc.title,sections:doc.sections,unknowns:doc.unknowns||[]}),statements:[],messages:[],questionHistory:[],attachmentExcludedIds:[],freshness:{status:'unchecked',checkedAt:null,rows:[]}};
    h.analysisHash=await hash(sourceOf(h));const errors=validate(h);if(errors.length)fail(errors[0]);return h;
  }
  async function verify(h,scope){const e=validate(h);if(e.length)fail(e[0]);if(h.sourceScope.domain!==scope?.domain||h.sourceScope.appId!==String(scope?.appId))fail('別アプリ・ドメインの分析は相談できません');if(await hash(sourceOf(h))!==h.analysisHash)fail('元の分析内容が変わっています');}
  function wire(h){
    const out=clone(h);delete out.freshness.source;if(out.freshness.preview){out.freshness.previewRevision=out.freshness.preview.revision;delete out.freshness.preview;}out.statements=out.statements.filter(s=>active(s)&&(s.kind==='open_question'||!(h.attachmentExcludedIds||[]).includes(s.statementId)));out.omittedStatementCount=h.statements.filter(active).length-out.statements.length;out.questionHistory=(h.questionHistory||[]).filter(q=>out.statements.some(s=>s.sourceQuestionRef?.questionId===q.questionId));if(out.statements.length>30)fail('運用記録が30件を超えています。添付対象を整理してください。');
    if(h.snapshot){const rs=selectedRules(h),ids=new Set(rs.flatMap(r=>r.evidenceRefs.map(x=>x.evidenceId)));
      if(h.selection.type==='all')h.snapshot.evidence.forEach(e=>ids.add(e.evidenceId));
      for(const s of out.statements){for(const r of s.sourceEvidenceRefs)ids.add(r.evidenceId);for(const ref of s.sourceRuleRefs)for(const e of rules(h).find(r=>r.ruleId===ref.ruleId)?.evidenceRefs||[])ids.add(e.evidenceId);}
      let count=-1;while(count!==ids.size){count=ids.size;for(const e of h.snapshot.evidence)if(ids.has(e.evidenceId))for(const id of e.linkedEvidenceIds||[])ids.add(id);}
      out.sourceBundle={categories:clone(h.snapshot.categories),evidence:clone(h.snapshot.evidence.filter(e=>ids.has(e.evidenceId))),limitations:clone(h.snapshot.limitations),unassignedEvidence:clone(h.analysis.unassignedEvidence.filter(e=>ids.has(e.evidenceId))),omittedEvidenceCount:h.snapshot.evidence.filter(e=>!ids.has(e.evidenceId)).length};
      // Explicit records may cite other rules. Retain their provenance without selecting their changes.
      const referenced=new Set(out.statements.flatMap(s=>s.sourceRuleRefs.map(r=>r.ruleId)));
      out.analysis={...clone(h.analysis),unassignedEvidence:clone(out.sourceBundle.unassignedEvidence),rules:clone(rules(h).filter(r=>rs.includes(r)||referenced.has(r.ruleId)))};
      out.snapshot=null;
    }else out.sourceBundle=null;
    const errors=validate(out,{wire:true});if(errors.length)fail(errors[0]);return out;
  }
  function context(h,question){const b=wire(h),ctx={contextVersion:'1',releaseContract:'release-workspace-1',clientCapabilities:['appExplanation',CAPABILITY],requestPurpose:'consultation',question,app:{id:h.sourceScope.appId,name:null},focus:{resolution:'resolved',target:{type:'business-consultation',id:h.sourceScope.appId},candidates:[]},facts:[],coverage:{fields:false,dependencies:false,javascript:false,incoming:false,plugins:false,recordData:false,adminNotes:false},truncation:{applied:false,sections:[]},businessMode:'understand',businessContext:b,conversation:{mode:'proposal',proposal:null,requirements:[],decisions:[],discussion:[]}};if(new TextEncoder().encode(JSON.stringify(ctx)).length>256*1024)fail('相談資料が送信上限を超えています。全体ではなく1件を選ぶか、添付記録を整理してください。');return ctx;}
  function record(h,input,now=new Date().toISOString()){
    const next=clone(h),old=input.supersedes?next.statements.find(s=>s.statementId===input.supersedes&&active(s)):null;if(input.supersedes&&!old)fail('訂正する記録がありません');
    const s={statementId:'BS'+(Math.max(0,...next.statements.map(x=>Number(x.statementId.slice(2))))+1),kind:input.kind,state:input.state||'recorded',text:input.text,relationToHypothesis:input.relationToHypothesis||'supplements',sourceRuleRefs:clone(input.sourceRuleRefs||selectedRules(h).map(r=>ruleRef(h,r.ruleId))),sourceEvidenceRefs:clone(input.sourceEvidenceRefs||[]),sourceMessageId:input.sourceMessageId||null,sourceQuestionRef:input.sourceQuestionRef||null,origin:input.origin||'user_form',recordedAt:now,supersedes:old?.statementId||null,reviewState:'current'};
    if(old)old.state='superseded';next.statements.push(s);const e=validate(next);if(e.length)fail(e[0]);return next;
  }
  const STR=n=>({type:'string',minLength:1,maxLength:n}),ARR=(items,n)=>({type:'array',items,maxItems:n}),OBJ=p=>({type:'object',properties:p,required:Object.keys(p),additionalProperties:false});
  const RR=OBJ({analysisId:STR(100),snapshotId:STR(200),ruleId:STR(40)}),ER=OBJ({snapshotId:STR(200),evidenceId:STR(80),pointer:{type:['string','null'],maxLength:1000}});
  const refs={ruleRefs:ARR(RR,8),evidenceRefs:ARR(ER,20),statementRefs:ARR(STR(80),30),messageRefs:ARR(STR(100),30)};
  const OUTPUT_SCHEMA=OBJ({schemaVersion:{type:'string',enum:[VERSION]},handoffId:STR(200),mode:{type:'string',enum:['understand']},blocks:ARR(OBJ({kind:{type:'string',enum:['setting_fact','inference','user_report','desired_change','discrepancy']},text:STR(1000),...refs}),8),questions:ARR(OBJ({questionId:STR(80),text:STR(500),purpose:STR(500),blockingFor:{type:'string',enum:['none','proposal','plan']},...refs}),5),statementDrafts:ARR(OBJ({kind:{type:'string',enum:kinds},text:STR(2000),sourceMessageId:STR(100),state:{type:'string',enum:['draft']}}),5)});
  // The generation schema and both validators share the same read-only envelope.
  const EMPTY={type:'array',items:{type:'string'},maxItems:0};
  const RESPONSE_SCHEMA=OBJ({reply:STR(1200),intent:{type:'string',enum:['question']},adoptQuote:{type:'string',enum:['']},proposal:OBJ({behaviors:EMPTY,assumptions:EMPTY,decisions:EMPTY,approach:OBJ({standard:EMPTY,js:EMPTY}),cannot:EMPTY}),turn:OBJ({ops:EMPTY,answers:EMPTY,requirementOps:EMPTY}),explanation:{type:'null'},businessConsultation:OUTPUT_SCHEMA});
  function schemaErrors(s,v,p='result',out=[]) {
    if(s.enum&&!s.enum.includes(v))out.push(p);
    if(v===null){if(s.type!=='null'&&!(Array.isArray(s.type)&&s.type.includes('null')))out.push(p);return out;}
    if(s.type==='object'){
      if(!obj(v)){out.push(p);return out;}
      if(Object.keys(v).some(k=>!Object.hasOwn(s.properties,k)))out.push(p);
      for(const[k,x]of Object.entries(s.properties))schemaErrors(x,v[k],p+'.'+k,out);
    }else if(s.type==='array'){
      if(!Array.isArray(v)||v.length>s.maxItems)out.push(p);
      else v.forEach((x,i)=>schemaErrors(s.items,x,p+'['+i+']',out));
    }else if(s.type==='string'||Array.isArray(s.type)){
      // Empty JSON Pointer means the evidence value itself, just as null does.
      if(typeof v!=='string'||v.length>(s.maxLength??Infinity)||(s.minLength&&(v.length<s.minLength||!v.trim())))out.push(p);
    }else if(s.type==='null')out.push(p);
    return [...new Set(out)];
  }
  function outputIssues(o,h) {
    const e=schemaErrors(OUTPUT_SCHEMA,o,'businessConsultation').map(path=>({path,message:'応答の型・必須項目・件数・文字数を確認してください'}));
    if(e.length)return e;
    const bad=(path,message)=>e.push({path,message});
    if(o.handoffId!==h.handoffId)bad('businessConsultation.handoffId','引き継ぎ元のIDが一致しません');
    for(const key of ['blocks','questions'])o[key].forEach((b,i)=>{
      const p='businessConsultation.'+key+'['+i+']';
      b.ruleRefs.forEach((r,j)=>{if(!checkRule(h,r))bad(p+'.ruleRefs['+j+']','添付した分析・取得回・ルールを参照してください');});
      b.evidenceRefs.forEach((r,j)=>{if(!checkRef(h,r))bad(p+'.evidenceRefs['+j+']','添付した根拠のID・取得回・value内の位置を参照してください');});
      b.statementRefs.forEach((id,j)=>{if(!h.statements.some(s=>s.statementId===id&&active(s)))bad(p+'.statementRefs['+j+']','添付した有効な利用者記録を参照してください');});
      b.messageRefs.forEach((id,j)=>{if(!h.messages.some(m=>m.id===id&&m.role==='user'))bad(p+'.messageRefs['+j+']','添付した利用者発言を参照してください');});
      if(b.kind==='setting_fact'&&(h.sourceKind!=='structured_business'||!b.evidenceRefs.length))bad(p+'.evidenceRefs','設定事実には取得設定の根拠が必要です');
      if(['user_report','desired_change'].includes(b.kind)&&!b.statementRefs.length&&!b.messageRefs.length)bad(p+'.statementRefs','利用者の記録または発言の参照が必要です');
      if(b.kind==='inference'&&!b.ruleRefs.length&&!b.evidenceRefs.length&&!b.statementRefs.length&&!b.messageRefs.length&&h.sourceKind!=='reference_document')bad(p+'.ruleRefs','推測の根拠参照が必要です');
      if(b.kind==='discrepancy'&&b.ruleRefs.length+b.evidenceRefs.length+b.statementRefs.length+b.messageRefs.length<2)bad(p+'.ruleRefs','相違点には2つ以上の比較元が必要です');
    });
    const ids=new Set();o.questions.forEach((q,i)=>{if(ids.has(q.questionId))bad('businessConsultation.questions['+i+'].questionId','質問IDが重複しています');ids.add(q.questionId);});
    o.statementDrafts.forEach((s,i)=>{if(!h.messages.some(m=>m.id===s.sourceMessageId&&m.role==='user'))bad('businessConsultation.statementDrafts['+i+'].sourceMessageId','抽出元の利用者発言がありません');});
    return e;
  }
  function validateOutput(o,h){return outputIssues(o,h).map(e=>e.path+'：'+e.message);}
  function responseIssues(r,h,{strictRoot=false}={}) {
    if(!obj(r))return [{path:'response',message:'相談応答のオブジェクトが必要です'}];
    const e=[];
    if(strictRoot&&Object.keys(r).some(k=>!Object.hasOwn(RESPONSE_SCHEMA.properties,k)))e.push({path:'response',message:'相談応答に未対応の項目が含まれています'});
    for(const[k,schema]of Object.entries(RESPONSE_SCHEMA.properties))if(k!=='businessConsultation'){
      for(const path of schemaErrors(schema,r[k],k))e.push({path,message:k==='reply'?'導入文は1〜1200文字で返してください':'業務確認はintent=question・adoptQuoteは空・explanation=null・proposalとturnの配列は空で返してください'});
    }
    return e.concat(outputIssues(r.businessConsultation,h));
  }
  function readonlyResponse(r,h){return !responseIssues(r,h).length;}
  function compare(before,after){return C().CATEGORIES.map(category=>{const a=before?.categories.find(c=>c.category===category),b=after?.categories.find(c=>c.category===category);let status='unavailable';if(a?.acquisition==='success'&&b?.acquisition==='success'&&before.consistency==='verified'&&after.consistency==='verified'){const entries=s=>s.evidence.filter(e=>e.category===category).map(e=>({kind:e.kind,source:e.source.pointer,value:e.value,active:e.active}));status=equal(entries(before),entries(after))?'unchanged':'changed';}return {category,status};});}
  function assess(h,source,preview){
    const scopeOK=(s,env)=>s?.appId===h.sourceScope.appId&&s?.environment===env;
    if(!scopeOK(source,h.sourceScope.environment)||!scopeOK(preview,'preview'))fail('照合する取得元が一致しません');
    const historical=h.snapshot?compare(h.snapshot,source):C().CATEGORIES.map(category=>({category,status:'not_compared'})),environment=compare(source,preview);
    return {status:[...historical,...environment].some(r=>r.status==='unavailable')?'unavailable':[...historical,...environment].some(r=>r.status==='changed')?'changed':'unchanged',checkedAt:new Date().toISOString(),source:clone(source),rows:historical.map(r=>({...r,comparison:'history'})).concat(environment.map(r=>({...r,comparison:'environment'}))),preview:clone(preview)};
  }
  return {VERSION,CAPABILITY,clone,equal,hash,validate,create,verify,wire,context,record,active,selectedRules,ruleRef,evidenceRef,checkRef,OUTPUT_SCHEMA,RESPONSE_SCHEMA,validateOutput,responseIssues,readonlyResponse,compare,assess};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTBusinessConsultation };
