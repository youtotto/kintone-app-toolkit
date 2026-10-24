'use strict';
const { createHash } = require('crypto');
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { makeEnvGetter } = require('./helpers/dev-base-fake.js');
const FX = require('./fixtures/ai-context-app.js');
const T = loadToolkit(), P = T.KTPlanExecutor, J = T.KTJsExecutor;
const { assert, state } = makeAssert();
const clone = x => JSON.parse(JSON.stringify(x));
const sha = s => createHash('sha256').update(s).digest('hex');
const op = (actionType, targetRef, spec, id='S1', dependsOn=[]) => ({ id, actionType, targetRef, spec, dependsOn, title: '保存・警告・維持などの説明には依存しない' });
const writes = m => m.calls.filter(x => !x.startsWith('GET'));
const prep = async (m, operations, extra={}) => P.prepareOperations({ appId:'310', operations, ...extra }, { api:m.api, current:await m.current() });
const mk = () => makeKintoneMock(FX.makeData());
const info = p => JSON.stringify(p.blockers || []);
const fixtures = [
  ['field add', [op('ADD_FIELD','F1',{})], {proposedFields:[{temporaryId:'F1',suggestedCode:'memo_new',label:'備考',type:'MULTI_LINE_TEXT',required:false}]}],
  ['field update', [op('UPDATE_FIELD','case_name',{name:'案件名変更',required:false})]],
  ['view add', [op('ADD_VIEW','追加一覧',{name:'追加一覧',fields:['case_name','amount'],filterCond:'amount >= "1"',sort:'amount asc'})]],
  ['view update', [op('UPDATE_VIEW','顧客別一覧',{fields:['case_name','amount'],filterCond:'amount >= "2"',sort:'amount desc'})]],
  ['notification add', [op('ADD_NOTIFICATION','',{name:'新しい通知',targets:['USER:user2'],filterCond:'amount >= "3"'})]],
  ['notification update', [op('UPDATE_NOTIFICATION','perRecord#1',{filterCond:'amount >= "400"',name:'条件変更'})]],
  ['general notification update', [op('UPDATE_NOTIFICATION','general#1',{events:['recordAdded','recordEdited']})]],
  ['reminder add', [op('ADD_REMINDER','',{name:'追加リマインド',targets:['USER:user2'],timingField:'due_date',daysLater:1,time:'10:00',filterCond:''})]],
  ['reminder update', [op('UPDATE_REMINDER','reminder#1',{time:'10:00'})]],
  ['process update', [op('UPDATE_PROCESS','申請する',{filterCond:'amount <= "1000000" and amount != "1000000"'})]],
  ['process status+action', [op('ADD_PROCESS_STATUS','部長承認待ち',{name:'部長承認待ち',assigneeType:'ONE',assignees:['USER:user1']},'S1'),op('ADD_PROCESS_ACTION','部長へ申請',{name:'部長へ申請',from:'未処理',to:'部長承認待ち',filterCond:'amount >= "1000000"'},'S2',['S1'])]],
  ['lookup update', [op('UPDATE_LOOKUP','customer_lookup',{addMappings:[{from:'address',to:'secret_memo'}],addPickerFields:['address']})]],
  ['app action update', [op('UPDATE_APP_ACTION','見積を作成',{filterCond:'amount >= "1"'})]],
  ['app action add', [op('ADD_APP_ACTION','新規アクション',{name:'新規アクション',destApp:'311',actionMappings:[{srcType:'FIELD',srcField:'case_name',destField:'quote_title'}],entities:['GROUP:everyone'],filterCond:''})]],
];

(async () => {
  // New execution never asks the legacy semantic reviewer to interpret a request.
  for (const [label,operations,extra] of fixtures) {
    const m=mk(), before=await m.current(), p=await prep(m,operations,extra);
    assert(p.status==='PREPARED' && p.summary.executable>0, label+' prepares '+info(p));
    assert(writes(m).length===0,label+' prepare is read only');
    if(p.status!=='PREPARED'||!p.summary.executable)continue;
    const e=await P.executePreview(p,{api:m.api});
    assert(e.status==='DONE',label+' applies and reads back '+JSON.stringify(e.steps.map(x=>({status:x.status,reason:x.reason,message:x.message}))));
    if(e.status!=='DONE')continue;
    const rb=await P.prepareRollback(e,p,{api:m.api});
    assert(rb.status==='PREPARED',label+' rollback prepares '+JSON.stringify(rb.blockers));
    if(rb.status==='PREPARED') {
      await P.executeRollback(rb,{api:m.api,execution:e});
      assert(rb.status==='ROLLED_BACK_VERIFIED',label+' restores '+rb.status);
    }
  }

  {
    const m=mk(); const p=await prep(m,[op('REUSE_FIELD','amount',{}),op('CUSTOMIZATION_REQUIRED','C1',{},'S2'),op('REQUIRE_CONFIRMATION','',{},'S3')]);
    assert(p.status==='PREPARED' && p.summary.executable===0 && p.steps.every(x=>x.status==='SKIPPED'),'explicit reuse/JavaScript/information has no setting writes');
    let rejected=false;try{await P.executePreview(p,{api:m.api});}catch(e){rejected=e.code==='NOTHING_TO_EXECUTE';}
    assert(rejected && !writes(m).length,'no-write preparation cannot claim an execution');
    const blocked=await prep(m,[{...op('REQUIRE_CONFIRMATION','',{}),blocking:true}]);
    assert(blocked.status==='BLOCKED','explicit unresolved question blocks');
    const missing=await prep(m,[op('UPDATE_FIELD','amount',null)]);
    assert(missing.status==='BLOCKED' && missing.blockers[0].code==='VALUES_MISSING','missing write values cannot become no-change');
    const altered=await prep(m,[op('UPDATE_FIELD','amount',{required:true})]); altered.steps[0].prepared.payload.changes.required=false;
    rejected=false;try{await P.executePreview(altered,{api:m.api});}catch(e){rejected=e.code==='PREPARED_CHANGED';}
    assert(rejected && !writes(m).length,'modified prepared settings never write');
  }
  {
    const m=mk(), p=await prep(m,[op('UPDATE_FIELD','amount',{required:true})]);
    m.st.fields.amount.label='他の変更';m.st.revision++;
    const e=await P.executePreview(p,{api:m.api});
    assert(e.status==='FAILED' && !writes(m).length,'fresh pre-write identity catches concurrent changes');
  }
  {
    const m=mk(), p=await prep(m,[op('UPDATE_FIELD','amount',{required:true},'S1'),op('UPDATE_FIELD','case_name',{required:false},'S2',['S1'])]);
    m.ctl.onWrite=(what)=>{if(what==='PUT fields'&&m.st.fields.amount.required)m.ctl.failPut='fields';};
    const e=await P.executePreview(p,{api:m.api});
    assert(e.status==='PARTIAL' && m.st.fields.amount.required && m.st.fields.case_name.required,'partial apply preserves exact completed and failed steps');
  }
  {
    const m=mk(), p=await prep(m,[op('UPDATE_FIELD','amount',{required:true})]);
    const e=await P.executePreview(p,{api:m.api});m.st.fields.amount.label='他の変更';m.st.revision++;
    const rb=await P.prepareRollback(e,p,{api:m.api});
    assert(rb.status==='BLOCKED','rollback does not overwrite another change');
  }
  {
    const m=mk(), cur=await m.current();
    const p=await P.prepareOperations({appId:'310',env:'production',operations:[]},{api:m.api,current:cur});
    assert(p.status==='BLOCKED'&&!writes(m).length,'production input rejected');
    const cyc=await prep(m,[op('UPDATE_FIELD','amount',{required:true},'S1',['S2']),op('UPDATE_FIELD','case_name',{required:false},'S2',['S1'])]);
    assert(cyc.status==='BLOCKED'&&cyc.blockers[0].code==='DEPENDENCY_CYCLE','cyclic operation dependencies blocked');
    const stale=await prep(m,[op('UPDATE_FIELD','amount',{required:true})],{expectedRevision:'-1'});
    assert(stale.status==='BLOCKED','stale expected revision blocked');
  }
  // Fetch and fingerprints belong to the base; non-AI inspection retains opt-in analysis.
  {
    const data=FX.makeData(), io=makeEnvGetter({preview:data,production:data});
    const scan=T.KTScan.buildPayload, deps=T.KTDeps.buildDependencyData;let scans=0,analyses=0;
    T.KTScan.buildPayload=(...a)=>{scans++;return scan(...a);};
    T.KTDeps.buildDependencyData=(...a)=>{analyses++;return deps(...a);};
    const base=await T.KTDevBase.loadForRelease({appId:'310',getImpl:io.getImpl,download:io.download});
    assert(base.ok && scans===0&&analyses===0,'release base loads without semantic scans/dependency analysis');
    assert(T.KTDevBase.currentOf(base).appId==='310'&&T.KTDevBase.currentOf(base).env==='preview','execution current carries app and environment');
    T.KTDevBase.analyze(base);
    assert(scans>0&&analyses>0,'existing non-AI base analysis remains available');
    T.KTScan.buildPayload=scan;T.KTDeps.buildDependencyData=deps;
  }
  const source='(function(){ kintone.events.on("app.record.edit.show", e => e); })();';
  const changed=source+'\n// approved';
  const jmock=()=>{const d=FX.makeData();d.customize={scope:'ALL',desktop:{js:[{type:'FILE',file:{name:'lock.js',fileKey:'base'}}],css:[]},mobile:{js:[],css:[]}};return makeKintoneMock(d,{jsSources:[{name:'lock.js',target:'desktop',text:source}]});};
  const file=(kind='ADD_FILE',target='mobile',name='mobile.js',code=changed)=>({id:target+name,kind,target,name,code,contentHash:sha(code),verification:{accepted:true,contentHash:sha(code)},...(kind==='REPLACE_FILE'?{baseHash:T.KTScan.hashText(source)}:{})});
  const jp=async(m,operations,extra={})=>J.prepareFiles({appId:'310',operations,...extra},{api:m.api,current:await m.current()});
  {
    const m=jmock(),p=await jp(m,[file('REPLACE_FILE','desktop','lock.js'),file('ADD_FILE','mobile','one.js'),file('ADD_FILE','mobile','two.js')]);
    assert(p.status==='PREPARED'&&p.summary.add===2&&p.summary.replace===1,'explicit verified files prepare '+info(p));
    assert(!writes(m).length,'file preparation writes nothing');
    const e=await J.executePreview(p,{api:m.api});
    assert(e.status==='DONE'&&e.verification?.ok,'two additions preserve order and all files read back');
    const rb=await J.prepareRollback(e,{api:m.api}); await J.executeRollback(rb,{api:m.api,execution:e});
    assert(rb.status==='ROLLED_BACK_VERIFIED'&&m.st.customize.mobile.js.length===0&&m.st.files.get(m.st.customize.desktop.js[0].fileKey).content===source,'file rollback restores exact list and previous source');
  }
  {
    const m=jmock(),same=await jp(m,[file('REPLACE_FILE','desktop','lock.js',source)]);
    assert(same.status==='PREPARED'&&same.unchanged.length===1&&same.changes[0].status==='SKIPPED','verified identical source is explicitly unchanged');
    const bad=file('REPLACE_FILE','desktop','lock.js',source);bad.verification.accepted=false;
    assert((await jp(m,[bad])).status==='BLOCKED','unverified identical source is not unchanged');
    const tampered=file();tampered.code+='\n// tampered';
    assert((await jp(m,[tampered])).status==='BLOCKED','SHA-256 binds accepted verification to exact content');
    const missing=file('REPLACE_FILE','desktop','lock.js');delete missing.baseHash;
    assert((await jp(m,[missing])).status==='BLOCKED','replace requires prior source hash');
    assert((await jp(m,[file('ADD_FILE','mobile','same.js'),file('ADD_FILE','mobile','SAME.js')])).status==='BLOCKED','duplicate new file names blocked');
    const mobileCode=file('ADD_FILE','desktop','desktop.js','kintone.events.on("mobile.app.record.edit.show",e=>e);');
    const explicit=await jp(m,[mobileCode]);
    assert(explicit.changes.length===1&&explicit.changes[0].target==='desktop','file destination is never inferred from code');
    explicit.changes[0].content+='x';let rejected=false;
    try{await J.executePreview(explicit,{api:m.api});}catch(e){rejected=e.code==='PREPARED_CHANGED';}
    assert(rejected&&!writes(m).length,'prepared file mutation rejected before upload');
  }
  {
    const m=jmock(),f=file();f.dependsOn={fields:[{code:'new_field',stepId:'S1'}],statuses:[]};
    const deferred=await jp(m,[f],{deferDependencies:true});
    assert(deferred.status==='PREPARED'&&deferred.deferred.length===1,'approved field addition may defer file preparation');
    assert((await jp(m,[f])).status==='BLOCKED','actual registration waits for dependency to exist');
    const p=await jp(m,[file()]);m.st.customize.scope='ADMIN';m.st.revision++;
    const e=await J.executePreview(p,{api:m.api});
    assert(e.status==='FAILED'&&e.error.code==='STALE_CUSTOMIZATION'&&!writes(m).length,'concurrent customization change prevents upload');
  }
  {
    const m=jmock(),p=await jp(m,[file()]);m.ctl.failUpload='PERMISSION';
    const e=await J.executePreview(p,{api:m.api});
    assert(e.status==='FAILED'&&e.error.code==='PERMISSION_DENIED'&&!m.calls.includes('PUT customize'),'permission failure never updates customization');
  }
  {
    const m=jmock(),p=await jp(m,[file()]);m.ctl.corruptUploaded=true;
    const e=await J.executePreview(p,{api:m.api});
    assert(e.status==='VERIFY_FAILED'&&!e.verification.ok,'corrupted uploaded source cannot be reported as verified');
  }
  {
    const m=mk(),p=await prep(m,[op('ADD_VIEW','確認一覧',{name:'確認一覧',fields:['amount']})]);
    m.ctl.mutateList=(what,list)=>{if(what==='views')delete list['顧客別一覧'];return list;};const e=await P.executePreview(p,{api:m.api});
    assert(e.status==='FAILED'&&e.steps[0].status==='VERIFY_FAILED','readback catches unrelated setting loss');
  }
  {
    const m=mk(),p=await prep(m,[op('UPDATE_FIELD','amount',{required:true})]);
    m.api.updatePreviewFields=async()=>{throw Object.assign(new Error('no permission'),{code:'CB_NO02'});};
    const e=await P.executePreview(p,{api:m.api});
    assert(e.status==='FAILED'&&e.steps[0].reason==='PERMISSION_DENIED'&&!m.st.fields.amount.required,'setting write permission denial fails without a fake success');
  }
  // Real release coordinator + real setting/registration services, only kintone is fake.
  {
    const { KTReleaseExecution }=require('../src/release-execution.js');
    for(const failure of [false,true]) {
      const m=jmock();const loadBase=async()=>({ok:true,current:await m.current()});
      const service=KTReleaseExecution.create({appId:'310',api:m.api,loadBase,currentOf:b=>b.current,planExecutor:P,jsExecutor:J,hash:async v=>sha(typeof v==='string'?v:JSON.stringify(v))});
      const artifact={customizationId:'C1',title:'モバイルの編集制御',result:{generated:{strategy:'NEW_JS_FILE',code:changed},artifactOutcome:{state:'ready',operations:[{action:'create',targetPlatform:'mobile',targetFile:'release-mobile.js',contentHash:sha(changed)}]}}};
      const prepared=await service.prepare({plan:{steps:[op('UPDATE_FIELD','amount',{required:true})],proposedFields:[]},artifacts:[artifact],base:await loadBase()});
      assert(prepared.ok&&prepared.changes.length===2,'release coordinator prepares settings and explicit file operations');
      if(failure)m.ctl.failUpload='PERMISSION';
      const result=await service.apply({prepared});
      assert(result.status===(failure?'partial':'complete')&&m.st.fields.amount.required,'release coordinator preserves completed settings when registration '+(failure?'fails':'succeeds'));
      assert(m.st.customize.mobile.js.length===(failure?0:1),'failed registration does not invent a registered file');
      const run={prepared,result};const rb=await service.prepareRollback(run);
      assert(rb.ok,'coordinator prepares explicit rollback after '+result.status);
      const restored=await service.rollback({run,prepared:rb});
      assert(restored.status==='complete'&&!m.st.fields.amount.required&&m.st.customize.mobile.js.length===0,'coordinator restores only this run, scripts before settings');
      assert(m.st.prodRevision===Number(FX.makeData().views.revision),'coordinator never deploys to production');
    }
  }
  {
    const fields=[{temporaryId:'F2',suggestedCode:'reused_memo',label:'補足',type:'MULTI_LINE_TEXT',required:false}];
    for(const exists of [true,false]) {
      const m=mk(),operations=[op('REUSE_FIELD',exists?'amount':'missing',{},'S1'),op('ADD_FIELD','F2',{},'S2',['S1'])];
      const p=await prep(m,operations,{proposedFields:fields});
      assert(p.status===(exists?'PREPARED':'BLOCKED'),'reuse dependency '+(exists?'uses an existing field':'fails if the field is absent'));
      if(exists) {const e=await P.executePreview(p,{api:m.api});assert(e.status==='DONE'&&e.steps[0].status==='SKIPPED'&&m.st.fields.reused_memo,'no-write reuse satisfies an explicit later operation dependency');}
      else assert(!writes(m).length&&!m.st.fields.reused_memo,'missing reuse target prevents dependent writes');
    }
    const m=mk();const p=await prep(m,[op('UPDATE_PROCESS','申請する',{name:'別の申請',filterCond:''})]);
    assert(p.status==='BLOCKED','unsupported rename cannot be silently ignored while changing conditions');
    assert(!P.prepare&&!P.classifySteps&&!P.applyReadiness&&!J.prepare&&!J.changeFromGenerated&&!J.mobileCompanionOf,'retired review and inferred registration entry points are absent');
  }
  // Retained API-condition boundaries, without request-text interpretation.
  for (const [label,type,spec,valid] of [
    ['user selection operator','ADD_NOTIFICATION',{name:'通知',targets:['FIELD_ENTITY:owner'],filterCond:'owner != ""'},false],
    ['notification function','ADD_NOTIFICATION',{name:'通知',targets:['FIELD_ENTITY:owner'],filterCond:'owner in (LOGINUSER())'},false],
    ['view condition','ADD_VIEW',{name:'v',fields:['case_name'],filterCond:'owner in (LOGINUSER()) and amount >= "1"'},true],
    ['process operator','ADD_PROCESS_ACTION',{name:'a',from:'未処理',to:'承認待ち',filterCond:'amount > "1000000"'},false],
  ]) { const m=mk(),p=await prep(m,[op(type,'',spec)]);assert((p.status==='PREPARED')===valid&&(!valid?p.blockers.some(x=>x.code==='COND_INVALID'):true)&&!writes(m).length,'API condition boundary: '+label); }
  console.log(`\n${state.failed?'FAILED':'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
  process.exitCode=state.failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
