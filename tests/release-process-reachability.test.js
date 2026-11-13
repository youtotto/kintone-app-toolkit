'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {loadToolkit} = require('./helpers/load-toolkit.js');
const {makeKintoneMock} = require('./helpers/kintone-preview-mock.js');
const T = loadToolkit(), P = T.KTPlanExecutor;
const clone = x => JSON.parse(JSON.stringify(x));
const state = (name,index) => ({name,index:String(index),assignee:{type:'ONE',entities:[]}});
const action = (name,from,to,filterCond='') => ({name,from,to,filterCond,type:'PRIMARY'});
function mock() {
  return makeKintoneMock({fields:{},views:{views:{},revision:'10'},status:{enable:true,
    states:{'完了':state('完了',2),'作成中':state('作成中',0),'確認中':state('確認中',1),'旧受付':state('旧受付',3)},
    actions:[action('申請','作成中','確認中'),action('完了する','確認中','完了'),action('旧受付から戻す','旧受付','作成中')]}});
}
const op = (id,actionType,spec,dependsOn=[]) => ({id,actionType,targetRef:spec.name,spec,dependsOn,title:id});
const add = (id,name) => op(id,'ADD_PROCESS_STATUS',{name,assigneeType:'ONE',assignees:['USER:user1']});
const link = (id,from,to,dependsOn=[],filterCond='') => op(id,'ADD_PROCESS_ACTION',action(id,from,to,filterCond),dependsOn);
const prep = async (m,steps) => P.prepareOperations({appId:'310',operations:steps},{api:m.api,current:await m.current()});
const writes = m => m.calls.filter(x=>!x.startsWith('GET'));
const islands = [
  ['incoming action missing',[add('P1','経理確認')]],
  ['self loop',[add('P1','経理確認'),link('P2','経理確認','経理確認',['P1'])]],
  ['disconnected cycle',[add('P1','経理確認'),add('P2','経理承認'),link('P3','経理確認','経理承認',['P1','P2']),link('P4','経理承認','経理確認',['P1','P2'])]],
  ['only outgoing to reachable state',[add('P1','経理確認'),link('P2','経理確認','作成中',['P1'])]],
  ['incoming from existing disconnected status',[add('P1','経理確認'),link('P2','旧受付','経理確認',['P1'])]],
];
for(const [label,steps] of islands) test(label+' cannot prepare or write',async()=>{
  const m=mock(),before=clone(m.st.status),p=await prep(m,steps);
  assert.equal(p.status,'BLOCKED',JSON.stringify(p.blockers));
  assert.ok(p.blockers.some(b=>b.code==='STATUS_UNREACHABLE'));
  assert.ok(p.blockers.some(b=>b.message.includes('経理確認')));
  await assert.rejects(()=>P.executePreview(p,{api:m.api}));
  assert.equal(writes(m).length,0);assert.deepEqual(m.st.status,before);
});

test('connected chain, return cycle and terminal state prepare, apply and restore',async()=>{
  const m=mock(),before=clone(m.st.status);
  const steps=[add('P1','経理確認'),add('P2','経理完了'),
    link('P3','経理確認','経理完了',['P1','P2']),
    link('P4','経理確認','作成中',['P1']),
    link('P5','確認中','経理確認',['P1'],'')];
  const p=await prep(m,steps);assert.equal(p.status,'PREPARED',JSON.stringify(p.blockers));
  const e=await P.executePreview(p,{api:m.api});assert.equal(e.status,'DONE',JSON.stringify(e.steps));
  assert.ok(m.st.status.states['経理完了']);
  const rb=await P.prepareRollback(e,p,{api:m.api});await P.executeRollback(rb,{api:m.api,execution:e});
  assert.equal(rb.status,'ROLLED_BACK_VERIFIED');assert.deepEqual(m.st.status,before);assert.equal(m.st.prodRevision,10);
});

test('redirecting an existing action connects the new state; retained old state does not block',async()=>{
  const m=mock(),steps=[add('P1','経理確認'),op('P2','UPDATE_PROCESS',{name:'申請',from:'作成中',to:'経理確認',changeKind:'ACTION_TRANSITION'},['P1'])];
  const p=await prep(m,steps);assert.equal(p.status,'PREPARED',JSON.stringify(p.blockers));
  const e=await P.executePreview(p,{api:m.api});assert.equal(e.status,'DONE',JSON.stringify(e.steps));
  assert.ok(m.st.status.states['確認中'],'old records can retain their status');
});

test('conditional edge counts structurally; existing disconnected states do not block unrelated changes',async()=>{
  const m=mock();m.st.fields.amount={code:'amount',type:'NUMBER',label:'金額',required:false};
  const p=await prep(m,[add('P1','経理確認'),link('P2','作成中','経理確認',['P1'],'amount >= "1000000"')]);
  assert.equal(p.status,'PREPARED',JSON.stringify(p.blockers));
  const other=await prep(m,[op('P3','UPDATE_PROCESS',{name:'申請',filterCond:'amount >= "1"'})]);
  assert.equal(other.status,'PREPARED',JSON.stringify(other.blockers));assert.equal(writes(m).length,0);
});

test('normal conversation blocks at preparation without another AI request or any write',async()=>{
  const m=mock(),steps=islands[2][1],calls=[];
  const loadBase=async()=>({ok:true,current:await m.current(),stamp:'test:10'});
  const execution=T.KTReleaseExecution.create({appId:'310',api:m.api,loadBase,currentOf:b=>b.current,planExecutor:P,jsExecutor:T.KTJsExecutor,hash:async v=>createHash('sha256').update(JSON.stringify(v)).digest('hex')});
  const c=T.KTReleaseWorkspace.create({loadBase,execution,services:{
    propose:async()=>({reply:'経理確認を追加します。',proposal:{behaviors:[{id:'B1',origin:'user',text:'経理確認を追加する'}],assumptions:[],cannot:[],decisions:[]}}),
    plan:async()=>{calls.push('plan');return {plan:{steps,customizations:[],questions:[]}};},
    generate:async()=>{throw Error('No JavaScript in this plan');}
  }});
  await c.send('経理確認を追加してください。');await c.adopt();
  const s=c.getState();assert.equal(s.prepared.ok,false);assert.notEqual(s.phase,'review');
  assert.ok(s.prepared.reasons.some(x=>x.code==='STATUS_UNREACHABLE'));
  assert.match(T.KTReleaseView.render(s),/最初のステータス/);
  await c.apply();assert.equal(writes(m).length,0);assert.deepEqual(calls,['plan']);
});
