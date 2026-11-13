 'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { KTPlanExecutor:P, KTReleaseContext:C, KTReleaseExecution:E } = loadToolkit();
const clone = x => JSON.parse(JSON.stringify(x));
const f = (code,type,extra={}) => ({code,label:code,type,required:false,...extra});
const options = names => Object.fromEntries(names.map((label,i)=>[label,{label,index:String(i)}]));
const beforeOptions = ['弥生会計','弥生会計2ユーザー','MFクラウド','freee','勘定奉行i10/11','PCA会計X/DX','会計王','財務応援･財務顧問'];
const edits = () => ({items:beforeOptions.slice(0,6).map(from=>({from,label:from==='勘定奉行i10/11'?'奉行クラウド':from==='PCA会計X/DX'?'PCAクラウド':from})),removed:beforeOptions.slice(6),defaultValue:['奉行クラウド']});
const op = (id,code,spec,actionType='UPDATE_FIELD',dependsOn=[])=>({id,actionType,targetKind:'FIELD',targetRef:code,spec,title:code+'を変更',dependsOn});
function mock(){return makeKintoneMock({fields:{software:f('software','DROP_DOWN',{options:options(beforeOptions),defaultValue:'勘定奉行i10/11'}),referral:f('referral','SINGLE_LINE_TEXT',{label:'紹介経路'}),referral2:f('referral2','SINGLE_LINE_TEXT',{label:'紹介経路'}),calc:f('calc','CALC',{expression:'IF(referral="紹介",100,200)',format:'NUMBER',displayScale:'0'}),memo:f('memo','SINGLE_LINE_TEXT')},views:{views:{}},status:{enable:false,states:{},actions:[]}});}
const prep = async(m,operations)=>P.prepareOperations({appId:'310',operations},{api:m.api,current:await m.current()});
const writes=m=>m.calls.filter(x=>!x.startsWith('GET'));
test('rename is sent under original keys, deleted choices explicit, order/default preserved',async()=>{
 const m=mock(); let payload;const original=m.api.updatePreviewFields;m.api.updatePreviewFields=async(...a)=>{payload=clone(a[1]);return original(...a)};
 const p=await prep(m,[op('P1','software',{optionEdits:edits()})]);assert.equal(p.status,'PREPARED',JSON.stringify(p.blockers));assert.equal(writes(m).length,0);assert.ok(p.steps[0].warnings.length);
 const r=await P.executePreview(p,{api:m.api});assert.equal(r.status,'DONE',JSON.stringify(r.steps));
 assert.equal(payload.software.options['勘定奉行i10/11'].label,'奉行クラウド');assert.equal(payload.software.options['奉行クラウド'],undefined);assert.equal(payload.software.options['会計王'],undefined);
 assert.deepEqual(Object.keys(m.st.fields.software.options),edits().items.map(i=>i.label));assert.equal(m.st.fields.software.defaultValue,'奉行クラウド');assert.equal(m.st.prodRevision,1);
 const rb=await P.prepareRollback(r,p,{api:m.api});assert.equal(rb.status,'BLOCKED');assert.equal(rb.blockers[0].code,'MANUAL_FIELD_RECOVERY');
});
for(const [name,change] of [
 ['omitted existing option',e=>e.items.pop()],['duplicate source',e=>e.items[1].from=e.items[0].from],['duplicate destination',e=>e.items[1].label=e.items[0].label],['unknown removal',e=>e.removed.push('unknown')],['unknown rename',e=>e.items[0].from='unknown'],['removed also retained',e=>e.removed.push('freee')],['invalid default',e=>e.defaultValue=['会計王']],['no remaining options',e=>e.items=[]],['existing treated as new',e=>e.items[0].from=null],['unknown property',e=>e.extra=true]]) test(name+' blocks without writes',async()=>{const m=mock(),e=edits();change(e);const p=await prep(m,[op('P1','software',{optionEdits:e})]);assert.equal(p.status,'BLOCKED');assert.equal(writes(m).length,0);});
test('formula change precedes deleting two fields with identical labels, no unrelated change',async()=>{
 const m=mock(),memo=clone(m.st.fields.memo);const p=await prep(m,[op('P2','referral',{},'DELETE_FIELD',['P1']),op('P1','calc',{expression:'200'}),op('P3','referral2',{},'DELETE_FIELD',['P2'])]);assert.equal(p.status,'PREPARED',JSON.stringify(p.blockers));
 const r=await P.executePreview(p,{api:m.api});assert.equal(r.status,'DONE',JSON.stringify(r.steps));assert.equal(m.st.fields.referral,undefined);assert.equal(m.st.fields.referral2,undefined);assert.equal(m.st.fields.calc.expression,'200');assert.deepEqual(m.st.fields.memo,memo);assert.equal(m.st.prodRevision,1);
 const rb=await P.prepareRollback(r,p,{api:m.api});assert.equal(rb.status,'BLOCKED');
});
test('formula alone can be restored and format remains unchanged',async()=>{const m=mock(),original=clone(m.st.fields.calc),p=await prep(m,[op('P1','calc',{expression:'300'})]);const r=await P.executePreview(p,{api:m.api});assert.equal(r.status,'DONE');const rb=await P.prepareRollback(r,p,{api:m.api});assert.equal(rb.status,'PREPARED',JSON.stringify(rb.blockers));await P.executeRollback(rb,{api:m.api,execution:r});assert.equal(rb.status,'ROLLED_BACK_VERIFIED',JSON.stringify(rb.steps));assert.deepEqual(m.st.fields.calc,original);});
test('remaining formula reference blocks deletion before writes',async()=>{const m=mock(),p=await prep(m,[op('P1','referral',{},'DELETE_FIELD')]);assert.equal(p.status,'BLOCKED');assert.equal(p.blockers[0].code,'FIELD_REFERENCED');assert.equal(writes(m).length,0);});
test('formula update after deletion is not accepted as resolving the reference',async()=>{const m=mock(),p=await prep(m,[op('P1','referral',{},'DELETE_FIELD'),op('P2','calc',{expression:'200'})]);assert.equal(p.status,'BLOCKED');});
test('parallel change stops field write',async()=>{const m=mock(),p=await prep(m,[op('P1','calc',{expression:'200'})]);m.st.fields.calc.expression='400';const r=await P.executePreview(p,{api:m.api});assert.equal(r.status,'FAILED');assert.equal(writes(m).length,0);});
test('wrong readback is never a successful change',async()=>{const m=mock(),original=m.api.updatePreviewFields;m.api.updatePreviewFields=async(...a)=>{const r=await original(...a);m.st.fields.calc.expression='wrong';return r};const p=await prep(m,[op('P1','calc',{expression:'200'})]),r=await P.executePreview(p,{api:m.api});assert.equal(r.status,'FAILED');assert.equal(r.steps[0].status,'VERIFY_FAILED');});
test('invalid formula, wrong type, system/container deletion block',async()=>{for(const [code,spec,type] of [['software',{expression:'200'},'UPDATE_FIELD'],['calc',{expression:''},'UPDATE_FIELD'],['missing',{},'DELETE_FIELD']]){const m=mock(),p=await prep(m,[op('P1',code,spec,type)]);assert.equal(p.status,'BLOCKED');assert.equal(writes(m).length,0);}});
test('prepared operation cannot be changed after approval',async()=>{const m=mock(),p=await prep(m,[op('P1','software',{optionEdits:edits()})]);p.steps[0].prepared.payload.changes.options.freee.label='different';await assert.rejects(()=>P.executePreview(p,{api:m.api}),e=>e.code==='PREPARED_CHANGED');assert.equal(writes(m).length,0);});
test('generation sees projected choices and excludes deleted fields, raw facts retain originals',()=>{
 const base={appId:'310',data:{fields:mock().st.fields},files:[]};const plan={steps:[op('P1','software',{optionEdits:edits()}),op('P2','referral',{},'DELETE_FIELD')],proposedFields:[],customizations:[]};
 const g=C.generator({customization:{customizationId:'C1',strategy:'NEW_FILE',fields:[],events:[],platform:['desktop']},plan,base,version:1});
 assert.ok(!g.dictionary.fieldCodes.includes('referral'));assert.deepEqual(clone(g.fields.find(f=>f.code==='software').options),edits().items.map(i=>i.label));assert.ok(g.plan.standardSteps.length===2);
 const facts=C.factsOf(base);assert.ok(facts.some(f=>f.field?.code==='referral'));assert.ok(facts.find(f=>f.field?.code==='calc').value.expression.includes('referral'));
});

test('empty optional choices no-op skips registration; new choice remains addition',async()=>{
 const m=mock(),e={items:beforeOptions.map(from=>({from,label:from})),removed:[],defaultValue:['勘定奉行i10/11']};
 assert.equal((await prep(m,[op('P1','software',{optionEdits:e})])).steps[0].status,'SKIPPED');
 e.items.push({from:null,label:'新しい会計ソフト'});const p=await prep(m,[op('P1','software',{optionEdits:e})]),r=await P.executePreview(p,{api:m.api});assert.equal(r.status,'DONE');assert.ok(m.st.fields.software.options['新しい会計ソフト']);
});
test('multi-select and radio defaults are typed correctly',async()=>{
 for(const type of ['MULTI_SELECT','CHECK_BOX','RADIO_BUTTON']){const m=mock();m.st.fields.software.type=type;m.st.fields.software.defaultValue=type==='RADIO_BUTTON'?'勘定奉行i10/11':['勘定奉行i10/11'];const e=edits();if(type!=='RADIO_BUTTON')e.defaultValue.push('freee');const p=await prep(m,[op('P1','software',{optionEdits:e})]),r=await P.executePreview(p,{api:m.api});assert.equal(r.status,'DONE',JSON.stringify(r.steps));assert.deepEqual(clone(m.st.fields.software.defaultValue),type==='RADIO_BUTTON'?'奉行クラウド':['奉行クラウド','freee']);}
});
test('nested calculation references and existing view references are not missed',async()=>{
 for(const nested of [true,false]){const m=mock();m.st.fields.calc.expression='200';if(nested)m.st.fields.table=f('table','SUBTABLE',{fields:{inner:f('inner','CALC',{expression:'IF(referral="紹介",1,0)'})}});else m.st.views={一覧:{type:'LIST',fields:['referral'],filterCond:'',sort:''}};const p=await prep(m,[op('P1','referral',{},'DELETE_FIELD')]);assert.equal(p.status,'BLOCKED',JSON.stringify(p));}
});
test('deleted field cannot remain the anchor of a later added field',async()=>{
 const m=mock(),p=await P.prepareOperations({appId:'310',operations:[op('P1','referral2',{},'DELETE_FIELD'),op('P2','F1',{placement:{position:'AFTER_ROW',anchor:'referral2'}},'ADD_FIELD',['P1'])],proposedFields:[{temporaryId:'F1',suggestedCode:'new',label:'new',type:'SINGLE_LINE_TEXT'}],requireFieldPlacement:true},{api:m.api,current:await m.current()});assert.equal(p.status,'BLOCKED');assert.equal(writes(m).length,0);
});
test('single-line automatic calculation changes verbatim, unrelated format preserved',async()=>{
 const m=mock();m.st.fields.calc.type='SINGLE_LINE_TEXT';const expression='IF(software="奉行クラウド","対象","対象外")';const p=await prep(m,[op('P1','calc',{expression})]),r=await P.executePreview(p,{api:m.api});assert.equal(r.status,'DONE');assert.equal(m.st.fields.calc.expression,expression);assert.equal(m.st.fields.calc.displayScale,'0');
});
test('delete failure retains the field and does not claim completion',async()=>{const m=mock();m.ctl.failDelete=true;const p=await prep(m,[op('P1','referral2',{},'DELETE_FIELD')]),r=await P.executePreview(p,{api:m.api});assert.equal(r.status,'FAILED');assert.ok(m.st.fields.referral2);});
test('result explains recovery limit instead of offering automatic rollback',async()=>{
 const {KTReleaseView:V}=loadToolkit(),m=mock(),p=await prep(m,[op('P1','referral2',{},'DELETE_FIELD')]),r=await P.executePreview(p,{api:m.api});
 const html=V.render({phase:'result',runs:[{id:'run',status:'complete',prepared:{settings:p,changes:[]},result:{status:'complete',written:true,settings:r}}],resultRunId:'run',messages:[],answers:[],artifacts:[]});assert.ok(html.includes('自動では元に戻せません'));assert.ok(!html.includes('data-action="request-rollback"'));
});

test('new reference after preparation prevents DELETE itself',async()=>{const m=mock(),p=await prep(m,[op('P1','referral2',{},'DELETE_FIELD')]);m.st.fields.calc.expression='IF(referral2="紹介",1,0)';const r=await P.executePreview(p,{api:m.api});assert.equal(r.status,'FAILED');assert.ok(m.st.fields.referral2);assert.equal(writes(m).length,0);});
test('unrelated layout mutation after DELETE is not verified',async()=>{const m=mock(),original=m.api.deletePreviewFields;m.api.deletePreviewFields=async(...args)=>{const r=await original(...args);m.st.layout.reverse();return r};const p=await prep(m,[op('P1','referral2',{},'DELETE_FIELD')]),r=await P.executePreview(p,{api:m.api});assert.equal(r.status,'FAILED');assert.equal(r.steps[0].status,'VERIFY_FAILED');});

test('API object key order is not a field change',async()=>{const m=mock(),p=await prep(m,[op('P1','calc',{expression:'200'})]);const original=m.api.getPreviewFields;m.api.getPreviewFields=async(...args)=>{const r=await original(...args);r.properties=Object.fromEntries(Object.entries(r.properties).reverse().map(([code,f])=>[code,Object.fromEntries(Object.entries(f).reverse())]));return r};const r=await P.executePreview(p,{api:m.api});assert.equal(r.status,'DONE',JSON.stringify(r.steps));});

test('setting deletion cannot silently skip a required JavaScript-first dependency',async()=>{const m=mock(),p=await prep(m,[op('C1','memo',{},'CUSTOMIZATION_REQUIRED'),op('P1','referral2',{},'DELETE_FIELD',['C1'])]);assert.equal(p.status,'BLOCKED');assert.ok(p.blockers.some(b=>b.code==='DEPENDENCY_ORDER_UNSUPPORTED'));assert.equal(writes(m).length,0);});
