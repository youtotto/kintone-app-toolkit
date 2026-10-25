'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), {createHash}=require('node:crypto');
const {loadToolkit}=require('./helpers/load-toolkit.js');
const {makeKintoneMock}=require('./helpers/kintone-preview-mock.js');
const T=loadToolkit(), P=T.KTPlanExecutor, J=T.KTJsExecutor;
const {KTReleaseExecution:E}=require('../src/release-execution.js');
const clone=x=>JSON.parse(JSON.stringify(x)), hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const field=(code,type,extra={})=>({code,label:code,type,required:false,...extra});
const old='kintone.events.on("app.record.edit.show", e=>{e.record.memo.value=e.record.referral.value;return e;});';
const code='kintone.events.on("app.record.edit.show", e=>{e.record.memo.value="説明";return e;});';
const op=(id,actionType,targetRef,spec={},dependsOn=[])=>({id,actionType,targetRef,spec,dependsOn,title:id+'の変更'});
function fixture({unchanged=false,extraSteps=[],jsExecutor=J}={}) {
 const m=makeKintoneMock({fields:{referral:field('referral','SINGLE_LINE_TEXT'),referral2:field('referral2','SINGLE_LINE_TEXT'),memo:field('memo','SINGLE_LINE_TEXT'),calc:field('calc','CALC',{expression:'IF(referral="紹介",100,200)'})},views:{views:{}},customize:{scope:'ALL',desktop:{js:[{type:'FILE',file:{name:'fixture.js',fileKey:'base'}}],css:[]},mobile:{js:[],css:[]}}},{jsSources:[{name:'fixture.js',target:'desktop',text:unchanged?code:old}]});
 const artifact={customizationId:'C1',title:'紹介経路の参照を除去',result:{generated:{strategy:'EXTEND_EXISTING_JS',body:code},artifactOutcome:{state:'ready',operations:[{action:unchanged?'unchanged':'replace',targetPlatform:'desktop',targetFile:'fixture.js',targetExistingFileId:'base',contentHash:hash(code),baseHash:T.KTScan.hashText(unchanged?code:old)}]}}};
 const steps=[op('P1','UPDATE_FIELD','calc',{expression:'200'}),op('C1','CUSTOMIZATION_REQUIRED','C1',{},['P1']),op('P2','DELETE_FIELD','referral',{},['C1']),op('P3','DELETE_FIELD','referral2',{},['P2']),...extraSteps];
 const plan={steps,proposedFields:[],customizations:[{customizationId:'C1'}]};
 const loadBase=async()=>({ok:true,current:await m.current()});
 const service=E.create({appId:'310',api:m.api,loadBase,currentOf:b=>b.current,planExecutor:P,jsExecutor,hash:async x=>hash(x)});
 return {m,plan,artifact,service,loadBase};
}
const prepare=async f=>f.service.prepare({plan:f.plan,artifacts:[f.artifact],base:await f.loadBase()});
const writes=m=>m.calls.filter(x=>!x.startsWith('GET'));
test('formula -> verified JS registration -> field deletions in dependency order',async()=>{
 const f=fixture(),p=await prepare(f);assert.equal(p.ok,true,JSON.stringify(p.reasons));assert.equal(writes(f.m).length,0);
 assert.deepEqual(p.changes.map(c=>c.id),['P1','C1-0','P2','P3']);
 const r=await f.service.apply({prepared:p});assert.equal(r.status,'complete',JSON.stringify(r));
 assert.deepEqual(clone(r.rows.map(x=>x.title)),['P1の変更','fixture.js','P2の変更','P3の変更']);
 const calls=writes(f.m);assert.ok(calls.indexOf('PUT fields')<calls.indexOf('PUT customize'));assert.ok(calls.indexOf('PUT customize')<calls.indexOf('DELETE fields'));
 assert.equal(f.m.st.fields.referral,undefined);assert.equal(f.m.st.fields.referral2,undefined);assert.equal(f.m.st.fields.calc.expression,'200');assert.equal(f.m.st.prodRevision,1);
 const rb=await f.service.prepareRollback({prepared:p,result:r});assert.equal(rb.ok,false);assert.ok(rb.reasons.some(x=>x.code==='MANUAL_FIELD_RECOVERY'));
});
for(const kind of ['upload','readback','lost-response','target-change','confirmation-change']) test(kind+' prevents all dependent deletions',async()=>{
 let n=0;const proxy=kind==='confirmation-change'?{...J,prepareFiles:async(...args)=>{const p=await J.prepareFiles(...args);if(++n===2)p.confirmations=[{key:'changed',message:'新しい確認'}];return p;}}:J;
 const f=fixture({jsExecutor:proxy}),p=await prepare(f);assert.equal(p.ok,true,JSON.stringify(p.reasons));
 if(kind==='upload')f.m.ctl.failUpload='PERMISSION';
 if(kind==='readback')f.m.ctl.corruptUploaded=true;
 if(kind==='lost-response'){const put=f.m.api.putPreviewCustomize;f.m.api.putPreviewCustomize=async(...a)=>{await put(...a);throw Error('response lost');};}
 if(kind==='target-change')f.m.ctl.onWrite=what=>{if(what==='PUT fields'){f.m.st.customize.scope='ADMIN';}};
 const r=await f.service.apply({prepared:p});assert.equal(r.status,kind==='lost-response'?'unknown':'partial',JSON.stringify(r));
 assert.ok(f.m.st.fields.referral&&f.m.st.fields.referral2);assert.ok(!writes(f.m).includes('DELETE fields'));
 assert.equal(f.m.st.fields.calc.expression,'200');
});
test('unchanged verified JS satisfies deletion dependency without registering again',async()=>{
 const f=fixture({unchanged:true}),p=await prepare(f);assert.equal(p.ok,true,JSON.stringify(p.reasons));
 const r=await f.service.apply({prepared:p});assert.equal(r.status,'complete',JSON.stringify(r));assert.ok(!writes(f.m).includes('PUT customize'));assert.ok(!f.m.st.fields.referral);
});
test('settings failure before registration prevents registration and deletion',async()=>{
 const f=fixture(),p=await prepare(f);assert.equal(p.ok,true,JSON.stringify(p.reasons));f.m.ctl.failPut='fields';
 const r=await f.service.apply({prepared:p});assert.equal(r.status,'failed');assert.ok(!writes(f.m).includes('PUT customize'));assert.ok(f.m.st.fields.referral);
});
test('new reference after registration prevents deletion and retains registration result',async()=>{
 const f=fixture(),p=await prepare(f);assert.equal(p.ok,true,JSON.stringify(p.reasons));
 f.m.ctl.onWrite=what=>{if(what==='PUT customize')f.m.st.fields.calc.expression='IF(referral="紹介",1,0)';};
 const r=await f.service.apply({prepared:p});assert.equal(r.status,'partial',JSON.stringify(r));assert.equal(r.files.status,'DONE');assert.ok(f.m.st.fields.referral);assert.ok(!writes(f.m).includes('DELETE fields'));
});
test('deletion failure retains registered JS and preceding settings in result',async()=>{
 const f=fixture(),p=await prepare(f);assert.equal(p.ok,true,JSON.stringify(p.reasons));f.m.ctl.failDelete=true;
 const r=await f.service.apply({prepared:p});assert.equal(r.status,'partial');assert.equal(r.files.status,'DONE');assert.equal(f.m.st.fields.calc.expression,'200');assert.ok(f.m.st.fields.referral);
 const rb=await f.service.prepareRollback({prepared:p,result:r});assert.equal(rb.ok,true,JSON.stringify(rb.reasons));
 const back=await f.service.rollback({run:{prepared:p,result:r},prepared:rb});assert.equal(back.status,'complete',JSON.stringify(back));assert.equal(f.m.st.fields.calc.expression,'IF(referral="紹介",100,200)');
});
test('missing generated registration never satisfies a JS prerequisite',async()=>{
 const f=fixture();const p=await f.service.prepare({plan:f.plan,artifacts:[],base:await f.loadBase()});assert.equal(p.ok,false);assert.equal(writes(f.m).length,0);
});
test('standalone setting executor cannot bypass registration coordinator',async()=>{
 const f=fixture(),p=await prepare(f);assert.equal(p.ok,true,JSON.stringify(p.reasons));
 await assert.rejects(()=>P.executePreview(p.settings,{api:f.m.api}),e=>e.code==='REGISTRATION_REQUIRED');assert.equal(writes(f.m).length,0);
});
test('multiple independent JS prerequisites register together after their settings',async()=>{
 const f=fixture();f.plan.steps=[...f.plan.steps,op('P4','UPDATE_FIELD','memo',{required:true}),op('C2','CUSTOMIZATION_REQUIRED','C2',{},['P4'])];f.plan.steps[2].dependsOn.push('C2');
 const a=clone(f.artifact);a.customizationId='C2';a.result.generated={strategy:'NEW_JS_FILE',code:'// second verified file'};a.result.artifactOutcome.operations=[{action:'create',targetPlatform:'mobile',targetFile:'mobile.js',contentHash:hash('// second verified file')}];
 const p=await f.service.prepare({plan:f.plan,artifacts:[f.artifact,a],base:await f.loadBase()});assert.equal(p.ok,true,JSON.stringify(p.reasons));
 const r=await f.service.apply({prepared:p});assert.equal(r.status,'complete',JSON.stringify(r));assert.equal(writes(f.m).filter(c=>c==='PUT customize').length,1);assert.equal(f.m.st.fields.memo.required,true);assert.ok(!f.m.st.fields.referral);
});
test('genuinely alternating registration dependencies fail before any write',async()=>{
 const f=fixture();f.plan.steps.push(op('C2','CUSTOMIZATION_REQUIRED','C2',{},['P2']));
 const a=clone(f.artifact);a.customizationId='C2';a.result.generated={strategy:'NEW_JS_FILE',code:'// second'};a.result.artifactOutcome.operations=[{action:'create',targetPlatform:'mobile',targetFile:'mobile.js',contentHash:hash('// second')}];
 const p=await f.service.prepare({plan:f.plan,artifacts:[f.artifact,a],base:await f.loadBase()});assert.equal(p.ok,false);assert.ok(p.reasons.some(r=>r.code==='REGISTRATION_ORDER_CONFLICT'));assert.equal(writes(f.m).length,0);
});
test('blocking confirmations retain concrete explanation, identical reasons render once',()=>{
 const V=require('../src/release-view.js').KTReleaseView;
 const html=V.render({phase:'blocked',prepared:{reasons:[{code:'X',message:'同じ理由'},{code:'X',message:'同じ理由'},{code:'Y',message:'別の理由'}]},messages:[],artifacts:[]});
 assert.equal(html.split('同じ理由').length-1,1);assert.ok(html.includes('別の理由'));
});
test('real unresolved confirmation keeps its title and details',async()=>{
 const f=fixture();f.plan.steps=[{...op('Q1','REQUIRE_CONFIRMATION',''),blocking:true,title:'移行先を選んでください',details:'保存済みデータの移行先が未指定です。'}];
 const p=await prepare(f);assert.equal(p.ok,false);assert.ok(p.reasons.some(r=>r.message.includes('移行先を選んでください')&&r.message.includes('保存済みデータ')));
});

test('no-op setting after JS still registers the verified file',async()=>{
 const f=fixture();f.plan.steps=[op('C1','CUSTOMIZATION_REQUIRED','C1'),op('P1','UPDATE_FIELD','memo',{required:false},['C1'])];
 const p=await prepare(f);assert.equal(p.ok,true,JSON.stringify(p.reasons));const r=await f.service.apply({prepared:p});assert.equal(r.status,'complete');assert.equal(r.files.status,'DONE');
});
test('concurrent replacement after JS verification prevents deletion',async()=>{
 const f=fixture(),p=await prepare(f);let changed=false;
 const r=await f.service.apply({prepared:p,onProgress:progress=>{if(progress.stage==='settings'&&progress.title==='P2の変更'&&progress.status==='RUNNING'&&!changed){changed=true;f.m.st.customize.scope='ADMIN';f.m.st.revision++;}}});
 assert.equal(r.status,'partial',JSON.stringify(r));assert.ok(!writes(f.m).includes('DELETE fields'));assert.ok(f.m.st.fields.referral);assert.equal(r.files.status,'DONE');
});
test('race after prerequisite read is rejected by kintone revision',async()=>{
 const f=fixture(),p=await prepare(f),remove=f.m.api.deletePreviewFields;
 f.m.api.deletePreviewFields=async(...args)=>{f.m.st.customize.scope='ADMIN';f.m.st.revision++;return remove(...args);};
 const r=await f.service.apply({prepared:p});assert.equal(r.status,'partial',JSON.stringify(r));assert.ok(f.m.st.fields.referral);
});
test('registration identity mapping uses spec.customizationId, not display text',async()=>{
 const f=fixture();f.plan.steps[1].id='JS_STEP';f.plan.steps[1].spec.customizationId='C1';f.plan.steps[2].dependsOn=['JS_STEP'];
 const p=await prepare(f);assert.equal(p.ok,true,JSON.stringify(p.reasons));const r=await f.service.apply({prepared:p});assert.equal(r.status,'complete');
});

test('process batches do not move later changes ahead of JS registration',async()=>{
 const f=fixture(),state=(name,index)=>({name,index:String(index),assignee:{type:'ONE',entities:[]}});
 f.m.st.status={enable:true,states:{作成中:state('作成中',0),確認中:state('確認中',1)},actions:[{name:'申請',from:'作成中',to:'確認中',filterCond:'',type:'PRIMARY'},{name:'差戻し',from:'確認中',to:'作成中',filterCond:'',type:'PRIMARY'}]};
 f.plan.steps=[op('P1','UPDATE_PROCESS','申請',{name:'申請',filterCond:'calc >= "1"'}),op('C1','CUSTOMIZATION_REQUIRED','C1',{},['P1']),op('P2','UPDATE_PROCESS','差戻し',{name:'差戻し',filterCond:'calc >= "2"'},['C1'])];
 const p=await prepare(f);assert.equal(p.ok,true,JSON.stringify(p.reasons));assert.equal(p.settings.groups.length,2);
 const r=await f.service.apply({prepared:p});assert.equal(r.status,'complete',JSON.stringify(r));
 const calls=writes(f.m);assert.ok(calls.indexOf('PUT status')<calls.indexOf('PUT customize'));assert.ok(calls.lastIndexOf('PUT status')>calls.indexOf('PUT customize'));
});
