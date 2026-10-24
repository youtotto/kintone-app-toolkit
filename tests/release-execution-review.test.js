/* Real coordinator and write services; only kintone transport is fixed. */
'use strict';
const {createHash}=require('crypto');
const {loadToolkit,makeAssert}=require('./helpers/load-toolkit.js');
const {makeKintoneMock}=require('./helpers/kintone-preview-mock.js');
const FX=require('./fixtures/ai-context-app.js');
const {KTReleaseExecution}=require(process.env.KT_EXECUTION_SRC || '../src/release-execution.js');
const T=loadToolkit(),P=T.KTPlanExecutor,J=T.KTJsExecutor,{assert,state}=makeAssert();
const clone=x=>JSON.parse(JSON.stringify(x));
const sha=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const source='kintone.events.on("app.record.edit.show",e=>e);',code=source+'\n// approved';
const mk=opts=>{const d=FX.makeData();d.customize={scope:'ALL',desktop:{js:[{type:'FILE',file:{name:'lock.js',fileKey:'base'}}],css:[]},mobile:{js:[],css:[]}};return makeKintoneMock(d,{jsSources:[{name:'lock.js',target:'desktop',text:source}],...opts});};
const setting={id:'P1',actionType:'UPDATE_FIELD',targetRef:'amount',spec:{required:true},title:'金額を必須にする'};
const artifact=(replace=false,sourceId='base')=>({customizationId:'C1',title:'編集制御',result:{generated:{strategy:replace?'EXTEND_EXISTING_JS':'NEW_JS_FILE',code:replace?'':code,body:replace?code:undefined},artifactOutcome:{state:'ready',operations:[{action:replace?'replace':'create',targetPlatform:replace?'desktop':'mobile',targetFile:replace?'lock.js':'mobile.js',contentHash:sha(code),...(replace?{baseHash:T.KTScan.hashText(source),targetExistingFileId:sourceId}:{})}]}}});
const setup=(m,overrides={})=>{const loadBase=async()=>({ok:true,current:await m.current()});return {loadBase,service:KTReleaseExecution.create({appId:'310',api:m.api,loadBase,currentOf:b=>b.current,planExecutor:P,jsExecutor:J,hash:async x=>sha(x),...overrides})};};
const prepare=async(s,steps=[],artifacts=[artifact()])=>s.service.prepare({plan:{steps,proposedFields:[]},artifacts,base:await s.loadBase()});
(async()=>{
  {
    const m=mk({autoPlace:false}),s=setup(m),add={id:'P1',actionType:'ADD_FIELD',targetRef:'F1',spec:{placement:{position:'FORM_END',anchor:''}},title:'備考を追加'};
    const prepared=await s.service.prepare({plan:{steps:[add],proposedFields:[{temporaryId:'F1',suggestedCode:'extra_memo',label:'備考',type:'MULTI_LINE_TEXT'}]},artifacts:[],base:await s.loadBase()});
    m.ctl.failPut='layout';const result=await s.service.apply({prepared});
    assert(!!m.st.fields.extra_memo&&result.settings.steps[0].partial,'field is written before layout failure');
    assert(result.status==='partial'&&result.written===true,'partial setting write is not reported as untouched');
    m.ctl.failPut=null;const run={prepared,result},rb=await s.service.prepareRollback(run);
    assert(rb.ok&&rb.settings.steps.length===1,'partial field write remains a rollback target');
    if(rb.ok){const restored=await s.service.rollback({run,prepared:rb});assert(restored.status==='complete'&&!m.st.fields.extra_memo,'rollback restores field created before layout failure');}
  }
  for(const initial of [[],[{key:'KEEP',message:'承認した注意'}]]) {
    const m=mk();let prepares=0,executions=0;
    const proxy={...J,prepareFiles:async(...args)=>{const r=await J.prepareFiles(...args);r.confirmations=++prepares===1?clone(initial):[{key:initial[0]?.key||'NEW',message:'新しく必要になった確認'}];return r;},executePreview:async(...args)=>{executions++;return J.executePreview(...args);}};
    const s=setup(m,{jsExecutor:proxy}),p=await prepare(s),result=await s.service.apply({prepared:p});
    assert(result.status==='failed'&&executions===0&&!m.calls.includes('POST file'),'reprepare cannot acknowledge '+(initial.length?'changed confirmation under the same key':'a new confirmation'));
  }
  {
    const m=mk();let acknowledgements;
    const proxy={...J,prepareFiles:async(...args)=>{const r=await J.prepareFiles(...args);r.confirmations=[{key:'KEEP',message:'承認済みの確認'}];return r;},executePreview:async(p,o)=>{acknowledgements=o.acknowledged;return J.executePreview(p,o);}};
    const s=setup(m,{jsExecutor:proxy}),p=await prepare(s),result=await s.service.apply({prepared:p});
    assert(result.status==='complete'&&acknowledgements.join(',')==='KEEP','unchanged approved confirmations may proceed once');
  }
  for(const id of ['wrong-id',null]) {
    const m=mk(),s=setup(m),p=await prepare(s,[],[artifact(true,id)]);
    assert(!p.ok&&!m.calls.includes('POST file'),'replace requires exact generated source identity '+String(id));
  }
  {
    const m=mk(),s=setup(m),p=await prepare(s,[],[artifact(true)]),result=await s.service.apply({prepared:p});
    assert(result.status==='complete','matching source id/name/platform registers normally');
  }
  for(const action of ['delete',null]) {
    const m=mk(),s=setup(m),a=artifact(true);a.result.artifactOutcome.operations[0].action=action;
    let blocked=false;try{const p=await prepare(s,[],[a]);blocked=!p.ok;}catch(e){blocked=true;}
    assert(blocked&&!m.calls.includes('POST file'),'unknown file action cannot become replacement '+String(action));
  }
  for(const useSettings of [false,true]) {
    const m=mk(),s=setup(m),p=await prepare(s,useSettings?[setting]:[]);
    const put=m.api.putPreviewCustomize;m.api.putPreviewCustomize=async(...args)=>{await put(...args);throw new Error('response lost');};
    const result=await s.service.apply({prepared:p});
    assert(m.st.customize.mobile.js.length===1,'lost response may follow a real registration');
    assert(result.status==='unknown'&&result.written===null,'unconfirmed registration remains unknown '+(useSettings?'after settings':'alone'));
    const before=m.calls.length,run={prepared:p,result},rb=await s.service.prepareRollback(run);
    assert(!rb.ok&&m.calls.length===before,'unknown registration never starts automatic rollback preparation');
  }
  {
    const m=mk(),s=setup(m),p=await prepare(s,[setting],[]),put=m.api.updatePreviewFields;
    m.api.updatePreviewFields=async(...args)=>{await put(...args);throw new Error('setting response lost');};
    const result=await s.service.apply({prepared:p});
    assert(m.st.fields.amount.required&&result.status==='unknown'&&result.written===null,'lost setting response never claims no change');
  }
  {
    const m=mk(),s=setup(m),p=await prepare(s,[setting],[]);let wrote=false;
    const put=m.api.updatePreviewFields,get=m.api.getPreviewFields;
    m.api.updatePreviewFields=async(...args)=>{const r=await put(...args);wrote=true;return r;};
    m.api.getPreviewFields=async(...args)=>{if(wrote)throw new Error('readback failed');return get(...args);};
    const result=await s.service.apply({prepared:p});
    assert(result.written===true&&result.status==='partial','acknowledged setting write survives readback failure classification');
  }
  {
    const m=mk(),s=setup(m),p=await prepare(s,[setting],[]),result=await s.service.apply({prepared:p}),run={prepared:p,result};
    const rb=await s.service.prepareRollback(run);let altered={...rb,settings:{...rb.settings,executionId:'another-run'}};
    const count=m.calls.length,res=await s.service.rollback({run,prepared:altered});
    assert(res.status==='failed'&&m.calls.length===count,'rollback preparation belongs to the exact execution');
  }
  {
    const m=mk(),s=setup(m),before=clone(m.st.status),p=await prepare(s,[{id:'P1',actionType:'UPDATE_PROCESS',targetRef:'申請する',spec:{filterCond:'amount >= "1000000"'}}],[]);
    let wrote=false,failed=false;const put=m.api.putPreviewStatus,get=m.api.getPreviewStatus;
    m.api.putPreviewStatus=async(...args)=>{const r=await put(...args);wrote=true;return r;};
    m.api.getPreviewStatus=async(...args)=>{if(wrote&&!failed){failed=true;throw new Error('readback failed');}return get(...args);};
    const result=await s.service.apply({prepared:p});
    assert(result.status==='partial'&&result.written===true&&!!result.settings.steps[0].partial,'group write acknowledgement survives readback failure');
    const run={prepared:p,result},rb=await s.service.prepareRollback(run);
    assert(rb.ok&&rb.settings.steps[0].stepIds.includes('P1'),'failed group readback keeps the original group as rollback target');
    if(rb.ok){const restored=await s.service.rollback({run,prepared:rb});assert(restored.status==='complete'&&JSON.stringify(m.st.status)===JSON.stringify(before),'group restoration uses the exact before snapshot');}
  }
  {
    const m=mk();let rollbacks=0,executions=0;
    const proxy={...P,prepareRollback:async(...args)=>{const p=await P.prepareRollback(...args);if(++rollbacks>1)p.warnings.push({code:'RELATED_APP_UNREADABLE',message:'参照先を確認できません'});return p;},executeRollback:async(...args)=>{executions++;return P.executeRollback(...args);}};
    const s=setup(m,{planExecutor:proxy}),p=await prepare(s,[setting],[]),result=await s.service.apply({prepared:p}),run={prepared:p,result};
    const rb=await s.service.prepareRollback(run),restored=await s.service.rollback({run,prepared:rb});
    assert(restored.status==='failed'&&executions===0&&m.st.fields.amount.required,'new rollback confirmation is never implicitly approved');
  }
  {
    const n=mk(),fresh=async()=>{const b={ok:true,current:await n.current()};b.current.customize.desktop.js[0].file.fileKey='different-file';return b;};
    const t=setup(n,{loadBase:fresh}),approved=await prepare(t,[],[artifact(true)]),blocked=await t.service.apply({prepared:approved});
    assert(blocked.status==='failed'&&!n.calls.includes('POST file'),'replacement identity is checked again immediately before registration');
  }
  // Formal Gateway operation shape: a ready EXTEND may explicitly report unchanged.
  const unchanged=()=>{const a=artifact(true);a.result.generated.body=source;Object.assign(a.result.artifactOutcome.operations[0],{action:'unchanged',contentHash:sha(source),bodyHash:'verified-body'});return a;};
  {
    const m=mk(),s=setup(m);let p,error;
    try{p=await prepare(s,[],[unchanged()]);}catch(e){error=e;}
    assert(!error&&p.ok&&p.changes.length===0&&p.unchanged.length===1&&p.files.changes[0].reason==='JS_UNCHANGED','Gateway unchanged is confirmed against the current verified body, not rejected');
    assert(!m.calls.some(c=>c.startsWith('POST')||c.startsWith('PUT')),'confirmed unchanged never uploads or registers');
  }
  for(const change of ['id','source','hash','claimed-only','platform']) {
    const m=mk(),s=setup(m),a=unchanged();
    if(change==='id')a.result.artifactOutcome.operations[0].targetExistingFileId='wrong';
    if(change==='source')m.st.files.get('base').content+='\n// concurrently changed';
    if(change==='hash')a.result.artifactOutcome.operations[0].contentHash=sha(code);
    if(change==='claimed-only'){a.result.generated.body=code;a.result.artifactOutcome.operations[0].contentHash=sha(code);}
    if(change==='platform')a.result.artifactOutcome.operations[0].targetPlatform='mobile';
    let p,error;try{p=await prepare(s,[],[a]);}catch(e){error=e;}
    assert(!error&&!p.ok&&!m.calls.some(c=>c.startsWith('POST')||c.startsWith('PUT')),'unchanged does not bypass current '+change+' checks');
  }
  {
    const m=mk(),s=setup(m);let p,error;
    try{p=await prepare(s,[setting],[unchanged(),{...artifact(),customizationId:'C2'}]);}catch(e){error=e;}
    assert(!error&&p.ok&&p.changes.length===2&&p.unchanged.length===1,'unchanged and actual setting/file changes remain distinct');
    if(!error&&p.ok){const result=await s.service.apply({prepared:p});assert(result.status==='complete'&&m.calls.filter(c=>c==='POST file').length===1&&m.st.customize.desktop.js[0].fileKey==='base','mixed apply registers only the actual file change');}
  }
  // A script restoration can complete before a setting restoration fails. Resume
  // only the remaining settings, preserving and rechecking the first readback.
  async function partialRestore(replace=false) {
    const m=mk(),s=setup(m),prepared=await prepare(s,[setting],[artifact(replace)]);
    const result=await s.service.apply({prepared}),run={id:'run-recovery',prepared,result};
    const rb=await s.service.prepareRollback(clone(run));
    m.ctl.failPut='fields';run.rollback=await s.service.rollback({run:clone(run),prepared:clone(rb)});m.ctl.failPut=null;
    return {m,s,run};
  }
  for(const replace of [false,true]) {
    const {m,s,run}=await partialRestore(replace);
    assert(run.rollback.status==='partial'&&run.rollback.files.status==='ROLLED_BACK_VERIFIED'&&run.rollback.settings.status==='ROLLBACK_FAILED','script restoration is retained when settings fail '+replace);
    assert(run.rollback.files.restoredSnapshot&&m.st.fields.amount.required,'completed script restoration keeps the exact readback '+replace);
    const scriptWrites=m.calls.filter(c=>c==='PUT customize'||c==='POST file').length;
    const retry=await s.service.prepareRollback(clone(run));
    assert(retry.ok&&!retry.files&&retry.settings&&retry.restoredFiles.executionId===run.result.files.executionId,'retry prepares only remaining settings for the same run '+replace);
    assert(retry.changes.length===1&&retry.changes[0].kind==='setting'&&retry.restoredChanges?.length===1&&retry.restoredChanges[0].kind==='javascript','retry confirmation separates remaining settings from restored scripts '+replace);
    run.rollback=await s.service.rollback({run:clone(run),prepared:clone(retry)});
    assert(run.rollback.status==='complete'&&!m.st.fields.amount.required&&run.rollback.files.status==='ROLLED_BACK_VERIFIED','remaining restoration completes and keeps prior script evidence '+replace);
    assert(m.calls.filter(c=>c==='PUT customize'||c==='POST file').length===scriptWrites,'retry never repeats script upload or registration '+replace);
    assert(!run.result.files.rollback&&!run.result.settings.rollback,'original apply records remain immutable '+replace);
  }
  for(const when of ['before-prepare','after-prepare']) {
    const {m,s,run}=await partialRestore();
    let retry;if(when==='after-prepare')retry=await s.service.prepareRollback(clone(run));
    m.st.customize.mobile.js.push({type:'URL',url:'https://example.invalid/other-change.js'});m.st.revision++;
    const before=m.calls.filter(c=>c.startsWith('PUT')||c.startsWith('POST')).length;
    const checked=when==='before-prepare'?await s.service.prepareRollback(clone(run)):await s.service.rollback({run:clone(run),prepared:clone(retry)});
    assert(when==='before-prepare'?!checked.ok:checked.status==='partial','concurrent customization edit blocks remaining restoration '+when);
    assert(m.st.fields.amount.required&&m.st.customize.mobile.js.length===1&&m.calls.filter(c=>c.startsWith('PUT')||c.startsWith('POST')).length===before,'another change is never overwritten by recovery '+when);
  }
  {
    const {m,s,run}=await partialRestore();run.rollback.files.executionId='another-execution';
    const before=m.calls.length,retry=await s.service.prepareRollback(clone(run));
    assert(!retry.ok&&retry.reasons.some(r=>r.code==='ROLLBACK_EVIDENCE_MISMATCH')&&m.calls.length===before,'restoration evidence from another execution is rejected before reads');
  }
  {
    const {m,s,run}=await partialRestore();const retry=await s.service.prepareRollback(clone(run));if(retry.restoredFiles)retry.restoredFiles.restoredSnapshot.scope='NONE';
    const before=m.calls.length,result=await s.service.rollback({run:clone(run),prepared:clone(retry)});
    assert(result.status==='failed'&&m.calls.length===before&&m.st.fields.amount.required,'changed prepared restoration evidence cannot authorize remaining writes');
  }
  {
    const {m,s,run}=await partialRestore();let retry=await s.service.prepareRollback(clone(run));const get=m.api.getPreviewCustomize;
    m.api.getPreviewCustomize=async()=>{throw new Error('temporary read failure');};
    run.rollback=await s.service.rollback({run:clone(run),prepared:clone(retry)});m.api.getPreviewCustomize=get;
    assert(run.rollback.status==='partial'&&run.rollback.files?.status==='ROLLED_BACK_VERIFIED'&&run.rollback.files?.restoredSnapshot,'temporary recheck failure preserves completed restoration evidence');
    retry=await s.service.prepareRollback(clone(run));
    const result=await s.service.rollback({run:clone(run),prepared:clone(retry)});
    assert(retry.ok&&result.status==='complete'&&!m.st.fields.amount.required,'explicit retry succeeds after a read-only recheck failure');
  }
  {
    const {m,s,run}=await partialRestore();run.rollback.status='unknown';const before=m.calls.length;
    const retry=await s.service.prepareRollback(clone(run));
    assert(!retry.ok&&retry.reasons.some(r=>r.code==='RESULT_UNKNOWN')&&m.calls.length===before,'unknown restoration is not automatically replayed');
  }
  {
    const {m,s,run}=await partialRestore();const retry=await s.service.prepareRollback(clone(run));delete retry.restoredFiles;
    const before=m.calls.length,result=await s.service.rollback({run:clone(run),prepared:clone(retry)});
    assert(result.status==='failed'&&m.calls.length===before&&m.st.fields.amount.required,'omitting restored script evidence cannot skip its current-state check');
  }
  {
    const m=mk(),s=setup(m),p=await prepare(s,[setting,{...setting,id:'P2',targetRef:'case_name',spec:{required:false},title:'案件名の必須を解除する'}],[]);
    const result=await s.service.apply({prepared:p}),run={id:'settings-recovery',prepared:p,result};const rb=await s.service.prepareRollback(clone(run));
    const put=m.api.updatePreviewFields;let fail=true;const restored=[];
    m.api.updatePreviewFields=async(app,properties,revision)=>{if(Object.keys(properties).includes('amount')&&fail)throw Object.assign(new Error('temporary setting failure'),{code:'GAIA_XX'});const result=await put(app,properties,revision);restored.push(...Object.keys(properties));return result;};
    run.rollback=await s.service.rollback({run:clone(run),prepared:clone(rb)});fail=false;
    assert(run.rollback.status==='partial'&&m.st.fields.amount.required&&m.st.fields.case_name.required,'ordinary setting rollback preserves a completed earlier step');
    const retry=await s.service.prepareRollback(clone(run));
    assert(retry.ok&&retry.changes.map(x=>x.id).join()==='P1,P2'&&retry.restoredChanges?.length===0,'retry confirmation keeps setting changes visible without inferring current restoration from preparation notes');
    run.rollback=await s.service.rollback({run:clone(run),prepared:clone(retry)});
    assert(run.rollback.status==='complete'&&restored.join()==='case_name,amount'&&!m.st.fields.amount.required,'ordinary setting recovery skips the verified restored step and writes only the remainder');
  }
  {
    const m=mk(),s=setup(m),steps=['reviewA','reviewB'].map((name,i)=>({id:'P'+(i+1),actionType:'ADD_VIEW',targetKind:'VIEW',targetRef:name,spec:{name,fields:['amount'],filterCond:'',sort:''},title:'一覧'+name+'を追加',dependsOn:[]}));
    const p=await prepare(s,steps,[artifact()]),result=await s.service.apply({prepared:p}),run={id:'view-recovery',prepared:p,result};
    const first=await s.service.prepareRollback(clone(run));m.ctl.failPut='views';
    run.rollback=await s.service.rollback({run:clone(run),prepared:clone(first)});m.ctl.failPut=null;
    assert(run.rollback.status==='partial'&&run.rollback.files.status==='ROLLED_BACK_VERIFIED'&&m.st.views.reviewA&&m.st.views.reviewB,'failed first view restoration leaves both applied views after restoring scripts');
    const retry=await s.service.prepareRollback(clone(run));
    assert(retry.ok&&retry.settings.steps.some(x=>x.stepId==='P1'&&x.note==='ALREADY_RESTORED'),'view preparation can mark a projected restoration before either current view is restored');
    assert(retry.changes.filter(x=>x.kind==='setting').map(x=>x.id).join()==='P1,P2'&&retry.restoredChanges.length===1&&retry.restoredChanges[0].kind==='javascript','retry confirmation retains every setting the whole-collection restoration will change');
    const scriptWrites=m.calls.filter(c=>c==='PUT customize'||c==='POST file').length;
    run.rollback=await s.service.rollback({run:clone(run),prepared:clone(retry)});
    assert(run.rollback.status==='complete'&&!m.st.views.reviewA&&!m.st.views.reviewB,'confirmed view restoration removes both views still present at confirmation');
    assert(m.calls.filter(c=>c==='PUT customize'||c==='POST file').length===scriptWrites,'view recovery does not repeat the completed script restoration');
  }
  {
    const {KTReleaseWorkspace}=require('../src/release-workspace.js');
    const m=mk(),s=setup(m),a=artifact(),customization={customizationId:'C1',requirement:'モバイルの編集制御'};
    Object.assign(a.result,{verification:{bodyHash:'verified'}});
    Object.assign(a.result.artifactOutcome,{version:'artifact-outcome-1',scope:{customizationId:'C1'},verifiedBodyHash:'verified'});
    a.result.artifactOutcome.operations[0].bodyHash='verified';
    const controller=KTReleaseWorkspace.create({
      loadBase:async()=>({...await s.loadBase(),stamp:String(m.st.revision)}),execution:s.service,
      services:{
        propose:async()=>({reply:'一覧とJavaScriptを作ります',proposal:{behaviors:[],decisions:[]}}),
        plan:async()=>({plan:{steps:[setting],customizations:[customization],questions:[],proposedFields:[]}}),
        generate:async()=>clone(a.result)
      }
    });
    await controller.send('変更してください');await controller.adopt();await controller.apply();
    const id=controller.getState().runs[0].id;await controller.requestRollback(id);m.ctl.failPut='fields';await controller.rollback(id);m.ctl.failPut=null;
    assert(controller.getState().runs[0].rollback.status==='partial','workspace retains partial rollback on its original run');
    await controller.requestRollback(id);
    assert(controller.getState().phase==='rollback-confirm'&&controller.getState().rollback.prepared.ok,'workspace offers explicit confirmation for remaining restoration');
    await controller.rollback(id);
    assert(controller.getState().runs[0].rollback.status==='complete'&&!m.st.fields.amount.required&&m.st.customize.mobile.js.length===0,'workspace resumes only the remaining restoration through its public actions');
  }
  console.log(`\n${state.failed?'FAILED':'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);process.exitCode=state.failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
