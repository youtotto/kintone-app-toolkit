'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {loadToolkit}=require('./helpers/load-toolkit.js'),{makeKintoneMock}=require('./helpers/kintone-preview-mock.js');
const {KTReleaseExecution}=require('../src/release-execution.js');
const T=loadToolkit(),hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const field=(code,type='SINGLE_LINE_TEXT',extra={})=>({code,label:code,type,required:false,...extra});
const source="kintone.events.on('app.record.create.submit',e=>{for(const row of e.record.travel.value){if(!row.value.departure.value)row.value.departure.error='出発地を入力してください';if(!row.value.arrival.value)row.value.arrival.error='到着地を入力してください';}return e;});";
function fixture(){
 const m=makeKintoneMock({fields:{travel:field('travel','SUBTABLE',{fields:{method:field('method')}}),memo:field('memo')},views:{revision:'15',views:{}},status:{enable:false,states:{},actions:[]}}, {autoPlace:true});
 m.st.layout=[{type:'SUBTABLE',code:'travel',fields:[{type:'SINGLE_LINE_TEXT',code:'method',size:{width:'180'}}]},{type:'ROW',fields:[{type:'SINGLE_LINE_TEXT',code:'memo',size:{width:'240'}}]}];
 const p={steps:[{id:'JS',actionType:'CUSTOMIZATION_REQUIRED',targetRef:'C1',spec:{customizationId:'C1'},dependsOn:['P2'],title:'入力チェックJS'},{id:'P2',actionType:'ADD_FIELD',targetRef:'NEW_FIELD_2',spec:{placement:{position:'AFTER_FIELD',anchor:'NEW_FIELD_1'}},dependsOn:['P1'],title:'到着地追加'},{id:'P1',actionType:'ADD_FIELD',targetRef:'NEW_FIELD_1',spec:{placement:{position:'AFTER_FIELD',anchor:'method'}},dependsOn:[],title:'出発地追加'}],proposedFields:[{temporaryId:'NEW_FIELD_1',suggestedCode:'departure',label:'出発地',type:'SINGLE_LINE_TEXT',required:false},{temporaryId:'NEW_FIELD_2',suggestedCode:'arrival',label:'到着地',type:'SINGLE_LINE_TEXT',required:false}],customizations:[{customizationId:'C1'}]};
 const artifacts=[{customizationId:'C1',title:'入力チェック',result:{generated:{strategy:'NEW_JS_FILE',code:source},artifactOutcome:{state:'ready',operations:[{action:'create',targetPlatform:'desktop',targetFile:'travel-validation.js',contentHash:hash(source)}]}}}];
 const loadBase=async()=>({ok:true,current:await m.current()});
 const service=KTReleaseExecution.create({appId:'427',api:m.api,loadBase,currentOf:b=>b.current,planExecutor:T.KTPlanExecutor,jsExecutor:T.KTJsExecutor,hash:async x=>hash(x)});
 return {m,p,artifacts,loadBase,service};
}
test('two table columns are verified before dependent JS upload; existing layout retained',async()=>{
 const f=fixture(),oldLayout=JSON.parse(JSON.stringify(f.m.st.layout));
 const prepared=await f.service.prepare({plan:f.p,artifacts:f.artifacts,base:await f.loadBase()});
 assert.equal(prepared.ok,true,JSON.stringify(prepared.reasons));assert.equal(f.m.calls.filter(x=>!x.startsWith('GET')).length,0);
 const upload=f.m.api.uploadFile;f.m.api.uploadFile=async(...args)=>{assert.deepEqual(f.m.st.layout[0].fields.map(c=>c.code),['method','departure','arrival']);assert.ok(f.m.st.fields.travel.fields.departure);assert.ok(f.m.st.fields.travel.fields.arrival);return upload(...args);};
 const result=await f.service.apply({prepared});assert.equal(result.status,'complete',JSON.stringify(result));
 assert.deepEqual(f.m.st.layout[1],oldLayout[1]);assert.deepEqual(f.m.st.layout[0].fields[0],oldLayout[0].fields[0]);
 assert.equal(f.m.st.customize.desktop.js.length,1);assert.equal(f.m.st.customize.mobile.js.length,0);assert.equal(f.m.st.prodRevision,15);
});
test('failed second column never uploads or registers dependent JS',async()=>{
 const f=fixture(),add=f.m.api.addPreviewFields;
 let calls=0;f.m.api.addPreviewFields=async(...args)=>{if(++calls===2)throw Object.assign(Error('second column failed'),{code:'GAIA_XX'});return add(...args);};
 const prepared=await f.service.prepare({plan:f.p,artifacts:f.artifacts,base:await f.loadBase()});assert.equal(prepared.ok,true,JSON.stringify(prepared.reasons));
 const result=await f.service.apply({prepared});assert.notEqual(result.status,'complete');
 assert.equal(f.m.calls.includes('POST file'),false);assert.equal(f.m.calls.includes('PUT customize'),false);assert.equal(f.m.st.customize.desktop.js.length,0);
});
