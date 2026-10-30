/* Read-only settings collection. No records, files, memberships or administrator notes. */
'use strict';
const KTBusinessSettings = (() => {
  const C=typeof KTBusinessContract!=='undefined'?KTBusinessContract:require('./release-business-contract.js').KTBusinessContract;
  const {clone}=C;
  const invalid=()=>{throw new Error('INVALID_SETTING');};
  const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
  const empty=(appId,environment,now,id)=>({schemaVersion:'business-snapshot-1',snapshotId:id,appId:String(appId),environment,startedAt:now(),completedAt:null,consistency:'unverified',revision:null,
    categories:C.CATEGORIES.map(category=>({category,acquisition:'not_requested',presence:'unknown',activation:'unknown',itemCount:null,revision:null,fetchedAt:null,error:null,interpretationIssues:[]})),evidence:[],limitations:[]});
  function entries(category,raw) {
    if(!object(raw))invalid();
    const out=[];
    const extra=(raw,projected)=>object(raw)?Object.keys(raw).some(k=>!Object.hasOwn(projected||{},k)||extra(raw[k],projected[k])):Array.isArray(raw)?raw.some((v,i)=>extra(v,projected?.[i])):false;
    const add=(kind,pointer,label,value,active=null)=>{const projected=C.project(kind,value);out.push({kind,pointer,label,value:projected,active,unknownAttributes:kind!=='field'&&extra(value,projected)});};
    if(category==='fields'){
      if(!object(raw.properties))invalid();
      const visit=(fields,path,parent=null)=>{for(const [key,f]of Object.entries(fields)){add('field',path+'/'+C.escPointer(key),f.label,{...f,...(parent?{parent}:{})});if(f.type==='SUBTABLE'){if(!object(f.fields))invalid();visit(f.fields,path+'/'+C.escPointer(key)+'/fields',f.code);}}};visit(raw.properties,'/properties');
    } else if(category==='process'){
      if(typeof raw.enable!=='boolean'||!(raw.states===null||object(raw.states))||!(raw.actions===null||Array.isArray(raw.actions)))invalid();
      for(const [name,state]of Object.entries(raw.states||{}))add('process_state','/states/'+C.escPointer(name),'ステータス：'+name,state,raw.enable);
      (raw.actions||[]).forEach((a,i)=>add('process_action','/actions/'+i,'アクション：'+a.name,a,raw.enable));
    } else if(category.startsWith('notification_')){
      if(!Array.isArray(raw.notifications))invalid();
      raw.notifications.forEach((n,i)=>add(category,'/notifications/'+i,(C.LABELS[C.CATEGORIES.indexOf(category)])+' '+(i+1),category==='notification_reminder'?{...n,...(raw.timezone!==undefined?{timezone:raw.timezone}:{})}:n));
      if(category==='notification_general'){if(typeof raw.notifyToCommenter!=='boolean')invalid();if(raw.notifyToCommenter)add('comment_notification','/notifyToCommenter','コメント投稿者への通知',{notifyToCommenter:true});}
    } else {
      if(!Array.isArray(raw.rights))invalid();
      raw.rights.forEach((right,i)=>add(category,'/rights/'+i,category==='acl_field'?'項目の権限：'+right.code:C.LABELS[C.CATEGORIES.indexOf(category)]+' '+(i+1),right));
    }
    return out;
  }
  async function collect({appId,environment='production',get,signal=null,onProgress=null,now=()=>new Date().toISOString(),snapshotId=null,queryParser=typeof KTQueryCheck!=='undefined'?KTQueryCheck:null}) {
    if(!['production','preview'].includes(environment)||typeof get!=='function'||!String(appId))throw new Error('設定の取得先を確認してください');
    const s=empty(appId,environment,now,snapshotId||'business-'+globalThis.crypto.randomUUID()), rows=new Map();
    const path=key=>'/k/v1/'+(environment==='preview'?'preview/':'')+key;
    const notify=()=>onProgress?.(clone(s));
    const stopped=()=>signal?.aborted===true;
    const error=(e)=>({code:typeof e?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(e.code)?e.code:null,message:(e?.status===403||e?.code==='CB_NO02')?'設定を読む権限がありません':'設定を取得できませんでした'});
    async function read(i) {
      const c=s.categories[i];if(stopped()){c.acquisition='cancelled';notify();return null;}
      c.acquisition='loading';notify();
      try {
        const raw=await get(path(C.PATHS[i]),{app:String(appId)});
        if(stopped()){c.acquisition='cancelled';return null;}
        const r=entries(c.category,raw);rows.set(c.category,r);
        c.acquisition='success';c.presence=r.length?'present':'empty';c.activation=c.category==='process'?(raw.enable?'enabled':'disabled'):'not_applicable';
        c.itemCount=r.length;c.revision=typeof raw.revision==='string'?raw.revision:null;c.fetchedAt=now();
        const topKeys=c.category==='fields'?['properties','revision']:c.category==='process'?['enable','states','actions','revision']:c.category==='notification_general'?['notifications','notifyToCommenter','revision']:c.category==='notification_reminder'?['notifications','timezone','revision']:c.category==='notification_record'?['notifications','revision']:['rights','revision'];
        c.interpretationIssues=[...new Set([...r.flatMap(e=>C.issues(e.kind,e.value)),...(r.some(e=>e.unknownAttributes)||Object.keys(raw).some(k=>!topKeys.includes(k))?['未対応の設定属性を検出しました。該当属性は送信せず、業務上の意味を解釈していません。']:[])])];
        return raw;
      }catch(e){c.acquisition=stopped()?'cancelled':(e?.status===403||e?.code==='CB_NO02')?'forbidden':'failed';c.error=stopped()?null:error(e);return null;}
      finally{notify();}
    }
    // Bracket concurrent category reads with the field-definition revision.
    const first=await read(0);
    await Promise.all(C.CATEGORIES.slice(1).map((_,i)=>read(i+1)));
    let last=null;
    if(!stopped())try{last=await get(path(C.PATHS[0]),{app:String(appId)});entries('fields',last);}catch(_){last=null;}
    if(stopped())for(const c of s.categories)if(['loading','not_requested'].includes(c.acquisition))c.acquisition='cancelled';
    const revs=[first?.revision,last?.revision,...s.categories.filter(c=>c.acquisition==='success').map(c=>c.revision)];
    if(!stopped()&&revs.every(r=>typeof r==='string'&&r.length)) {
      s.consistency=new Set(revs).size===1?'verified':'mismatch';s.revision=s.consistency==='verified'?revs[0]:null;
    }
    for(const c of s.categories)for(const r of rows.get(c.category)||[]){
      s.evidence.push({evidenceId:'B'+(s.evidence.length+1),snapshotId:s.snapshotId,category:c.category,kind:r.kind,
        source:{pointer:r.pointer,revision:c.revision,fetchedAt:c.fetchedAt},label:r.label,active:r.active,value:r.value,linkedEvidenceIds:[],unresolvedReferences:[]});
    }
    const fieldMap=new Map(s.evidence.filter(e=>e.kind==='field').map(e=>[e.value.code,e.evidenceId]));
    const stateMap=new Map(s.evidence.filter(e=>e.kind==='process_state').map(e=>[e.value.name,e.evidenceId]));
    for(const e of s.evidence){
      const link=(name,map,type)=>{const id=map.get(name);if(id)e.linkedEvidenceIds.push(id);else e.unresolvedReferences.push(type+'：'+name);};
      const walk=v=>{if(!object(v)&&!Array.isArray(v))return;if(v.entity?.type==='FIELD_ENTITY')link(v.entity.code,fieldMap,'対象フィールドを未解決');for(const x of Object.values(v))walk(x);};walk(e.value);
      if(e.kind==='process_action'){link(e.value.from,stateMap,'遷移元を未解決');link(e.value.to,stateMap,'遷移先を未解決');}
      if(e.kind==='acl_field')link(e.value.code,fieldMap,'権限対象フィールドを未解決');
      if(e.kind==='notification_reminder')link(e.value.timing.code,fieldMap,'基準日時フィールドを未解決');
      if(e.value.filterCond){
        try{
          if(!queryParser)throw new Error('No parser');
          const parsed=queryParser.parse(queryParser.tokenize(e.value.filterCond));
          for(const cond of parsed.conds){
            link(cond.field,fieldMap,'条件の参照フィールドを未解決');
            const field=s.evidence.find(f=>f.kind==='field'&&f.value.code===cond.field);
            if(field?.value.type==='STATUS')for(const v of (cond.value.kind==='list'?cond.value.items:[cond.value]))if(v.kind==='str')link(v.v,stateMap,'条件のステータスを未解決');
          }
        }catch(_){e.unresolvedReferences.push('条件式は原文を保持しています。条件内の参照を解析できていません。');}
      }
      e.linkedEvidenceIds=[...new Set(e.linkedEvidenceIds)];
    }
    const limitation=(kind,categories,evidenceIds,message)=>{const prior=s.limitations.find(l=>l.kind===kind&&l.message===message);if(prior){prior.categories=[...new Set([...prior.categories,...categories])];prior.evidenceIds=[...new Set([...prior.evidenceIds,...evidenceIds])];}else s.limitations.push({limitationId:'L'+(s.limitations.length+1),kind,categories,evidenceIds,message});};
    for(const c of s.categories){
      if(c.acquisition!=='success')limitation('acquisition',[c.category],[],C.LABELS[C.CATEGORIES.indexOf(c.category)]+'：'+({forbidden:'権限不足で取得不可',cancelled:'取得中断',failed:'取得失敗',not_requested:'未取得',loading:'取得中'}[c.acquisition]));
      if(c.interpretationIssues.length)limitation('interpretation',[c.category],s.evidence.filter(e=>e.category===c.category&&C.issues(e.kind,e.value).length).map(e=>e.evidenceId),c.interpretationIssues.join('。'));
    }
    for(const e of s.evidence)for(const message of e.unresolvedReferences)limitation('interpretation',[e.category],[e.evidenceId],message);
    for(const message of ['実レコード値と実際の操作・通知の配信実績は未確認です。','対象者の所属と個人別の実効権限は未確認です。','JavaScript・プラグインによる補助処理は対象外です。','他アプリの設定とアプリ外の運用は未確認です。'])limitation('excluded_scope',[],[],message);
    s.completedAt=now();notify();return s;
  }
  return {collect,entries,empty};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTBusinessSettings };
