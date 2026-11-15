'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {KTReleaseContext:C}=require('../src/release-context.js');
const {plan}=require('./helpers/release-workspace-fixture.js');
function fixture(){
 const base={ok:true,appId:'427',env:'preview',data:{fields:{travel:{code:'travel',type:'SUBTABLE',label:'旅費',fields:{method:{code:'method',type:'DROP_DOWN',label:'手段',options:{電車:{index:'0'}}}}},memo:{code:'memo',type:'MULTI_LINE_TEXT',label:'備考'}}},files:[]};
 const p=plan({settings:false,platforms:['desktop']});
 p.proposedFields=[{temporaryId:'NEW_FIELD_1',suggestedCode:'departure',label:'出発地',type:'SINGLE_LINE_TEXT'},{temporaryId:'NEW_FIELD_2',suggestedCode:'arrival',label:'到着地',type:'SINGLE_LINE_TEXT'}];
 p.steps=[{id:'P2',actionType:'ADD_FIELD',targetRef:'NEW_FIELD_2',spec:{placement:{position:'AFTER_FIELD',anchor:'NEW_FIELD_1'}},dependsOn:['P1']},{id:'P1',actionType:'ADD_FIELD',targetRef:'NEW_FIELD_1',spec:{placement:{position:'AFTER_FIELD',anchor:'method'}},dependsOn:[]},...p.steps];
 p.customizations[0].fields=[{code:'NEW_FIELD_1',access:'READ'},{code:'NEW_FIELD_2',access:'READ'}];
 return {base,p};
}
test('planned table columns keep their parent and real code through JS generation input',()=>{
 const {base,p}=fixture(),original=JSON.stringify({base,p});
 const ctx=C.generator({customization:p.customizations[0],plan:p,version:1,base});
 for(const code of ['departure','arrival']){
  assert.equal(ctx.fields.find(f=>f.code===code).subtable,'travel');
  assert.equal(ctx.planned.fields.find(f=>f.code===code).subtable,'travel');
  assert.equal(ctx.verification.appFields.find(f=>f.code===code).subtable,'travel');
 }
 assert.deepEqual(ctx.fields.find(f=>f.code==='travel').columns,['method','departure','arrival']);
 assert.deepEqual(ctx.customization.fields.map(f=>f.code),['departure','arrival']);
 assert.equal(ctx.planned.fields.find(f=>f.code==='departure').stepId,'P1');
 assert.equal(ctx.planned.fields.find(f=>f.code==='arrival').stepId,'P2');
 assert.equal(JSON.stringify({base,p}),original,'does not mutate settings or adopted plan');
});
test('table-like labels and row placement do not invent table membership',()=>{
 const {base,p}=fixture();p.steps[1].spec.placement={position:'AFTER_ROW',anchor:'travel'};
 p.proposedFields[0].label='旅費テーブル内の項目（文章だけ）';
 const ctx=C.generator({customization:p.customizations[0],plan:p,version:1,base});
 assert.equal(ctx.fields.find(f=>f.code==='departure').subtable,undefined);
 assert.equal(ctx.fields.find(f=>f.code==='arrival').subtable,undefined);
 assert.deepEqual(ctx.fields.find(f=>f.code==='travel').columns,['method']);
});
test('proposal and plan advertise table placement without losing normal placement',()=>{
 const {base}=fixture();
 const contexts=[C.proposal({text:'旅費の手段の右に出発地を追加',base}),C.plan({proposal:{behaviors:[],assumptions:[],decisions:[],approach:{standard:[],js:[]},cannot:[]},goal:'列を追加',version:1,base})];
 for(const ctx of contexts){assert.ok(ctx.clientCapabilities.includes('subtableFieldPlacement'));assert.ok(ctx.clientCapabilities.includes('formLayoutPlacement'));}
});
