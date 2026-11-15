'use strict';
// Saved real AI responses; production executors, in-memory kintone only.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const { createHash } = require('node:crypto');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { fixture, REQUEST } = require('./helpers/release-workspace-fixture.js');
const saved = require('./fixtures/app427-unverified-replies.json');
const { KTReleaseExecution: Execution } = require('../src/release-execution.js');
const { KTReleaseWorkspace: Workspace } = require('../src/release-workspace.js');
const { KTReleaseView: View } = require('../src/release-view.js');
const T = loadToolkit(), clone = x => JSON.parse(JSON.stringify(x));
const hash = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const field = (code, type = 'SINGLE_LINE_TEXT') => ({ code, label: code, type });
const writes = m => m.calls.filter(c => !c.startsWith('GET'));
function setup({ routeFields = true, originalPlan = false } = {}) {
  const fields = { 精算金額: field('精算金額', 'NUMBER'), 高額申請の理由: field('高額申請の理由', 'MULTI_LINE_TEXT'),
    旅費: { ...field('旅費', 'SUBTABLE'), fields: { 手段: { ...field('手段','DROP_DOWN'), options: Object.fromEntries(['電車','バス','タクシー','宿泊'].map((label,index)=>[label,{label,index:String(index)}])) }, 旅費金額: field('旅費金額', 'NUMBER'),
      ...(routeFields ? { 旅費出発地: field('旅費出発地'), 旅費到着地: field('旅費到着地') } : {}) } } };
  const m = makeKintoneMock({ fields, customize: { scope:'ALL', desktop:{js:[{type:'FILE',file:{name:'expense-reason.js',fileKey:'base'}}],css:[]},mobile:{js:[],css:[]} } },
    { jsSources: [{ target:'desktop',name:'expense-reason.js',text:saved.initialJs }] });
  const plan = clone(saved.plan), artifacts = clone(saved.artifacts);
  // Isolate JS registration with the manual prerequisite already satisfied.
  // A separate test below retains the complete original plan and missing fields.
  if (!originalPlan) plan.steps = plan.steps.filter(s=>s.actionType==='CUSTOMIZATION_REQUIRED').map(s=>({...s,dependsOn:s.dependsOn.filter(id=>id!=='P1')}));
  const loadBase = async()=>({ok:true,appId:'427',env:'preview',stamp:'fixed',current:await m.current()});
  const service = Execution.create({appId:'427',api:m.api,loadBase,currentOf:b=>b.current,planExecutor:T.KTPlanExecutor,jsExecutor:T.KTJsExecutor,hash:async x=>hash(x)});
  const prepare = async()=>service.prepare({plan,artifacts,base:await loadBase()});
  return {m,plan,artifacts,service,loadBase,prepare};
}
test('保存済みの既存編集と新規JSは未確認の状態を保持し、明示的な反映で2本だけ登録する',async()=>{
  const f=setup(), before=clone(f.artifacts), prepared=await f.prepare();
  assert.equal(prepared.ok,true,JSON.stringify(prepared.reasons));
  assert.deepEqual(prepared.operations.map(o=>[o.kind,o.name,o.verification.state]),[
    ['REPLACE_FILE','expense-reason.js','unverified'],['ADD_FILE','travel-location-validation.js','unverified']]);
  assert.equal(writes(f.m).length,0);assert.deepEqual(f.artifacts,before);
  assert.equal(prepared.confirmations.some(c=>/模擬テスト|未確認|自動確認|条件の値が特定/.test(c.message)),false);
  const result=await f.service.apply({prepared});
  assert.equal(result.status,'complete',JSON.stringify(result));
  const current=await f.m.current();
  assert.deepEqual(current.files.map(f=>f.name),['expense-reason.js','travel-location-validation.js']);
  assert.deepEqual(current.files.map(f=>f.text),f.artifacts.map(a=>a.result.generated.body || a.result.generated.code));
  assert.deepEqual(f.artifacts,before,'registration never relabels an unverified response as ready');
});
test('保存回答の復元から反映確認へ進み、追加AI・自動反映・未確認バナーを出さない',async()=>{
  const f=setup(), stub=fixture(Workspace,{plan:f.plan}), payload=stub.controller.exportSession();
  Object.assign(payload.state,{phase:'incomplete',plan:f.plan,artifacts:f.artifacts,goal:REQUEST,version:1});
  payload.baseline={stamp:'fixed',appId:'427',environment:'preview',verificationFingerprint:null};
  let ai=0;const noAI=async()=>{ai++;throw Error('Unexpected AI');};
  const c=Workspace.create({loadBase:f.loadBase,execution:f.service,services:{propose:noAI,plan:noAI,generate:noAI}});
  assert.equal(await c.restoreSession(payload),true);
  assert.equal(c.getState().phase,'blocked');assert.equal(Workspace.canReprepare(c.getState()),true);
  assert.equal(await c.reprepare(),true);assert.equal(c.getState().phase,'review');
  const html=View.render(c.getState()).replace(/<style>[\s\S]*?<\/style>/g,'');
  assert.match(html,/data-release-action="apply"/);
  assert.doesNotMatch(html,/模擬テストの環境|条件の値が特定|自動確認できていない|検証は完了|一部未確認|data-release-panel="verification"/);
  assert.equal(ai,0);assert.equal(writes(f.m).length,0);
  const again=Workspace.create({loadBase:f.loadBase,execution:f.service,services:{propose:noAI,plan:noAI,generate:noAI}});
  assert.equal(await again.restoreSession(c.exportSession()),true);assert.equal(await again.reprepare(),true);
  assert.equal(await again.apply(),true);assert.equal(again.getState().phase,'result');
  assert.equal(again.getState().runs[0].result.status,'complete');assert.equal(ai,0);
  assert.deepEqual(again.getState().artifacts,f.artifacts);
});
test('元の回答の手動項目追加は未実施なら具体的な前提不足として止める',async()=>{
  const f=setup({routeFields:false,originalPlan:true}), p=await f.prepare();
  assert.equal(p.ok,false);assert.ok(p.reasons.some(r=>r.code==='DEPENDENCY_NOT_APPLIED'));
  assert.equal(writes(f.m).length,0);
  assert.equal(p.reasons.some(r=>/模擬テスト|自動確認|未確認/.test(r.message)),false);
});
test('保存後の本文改変・別変更の結果・登録先違い・具体的な構文エラーは止める',async()=>{
  for(const mutate of [
    f=>{f.artifacts[0].result.generated.body+='\n// changed';},
    f=>{f.artifacts[0].result.artifactOutcome.scope.customizationId='other';},
    f=>{f.plan.customizations[0].platform=['mobile'];},
    f=>{f.artifacts[0].result.verification.machine.push({name:'syntax',ok:false,severity:'error',message:'構文エラー'});},
    f=>{f.artifacts[1].result.generated.code='';}
  ]){const f=setup();mutate(f);await assert.rejects(f.prepare());assert.equal(writes(f.m).length,0);}
});
test('置換元JSの変更・同名重複・反映前の変更は上書きしない',async()=>{
  {const f=setup();f.m.st.files.get('base').content+='\n// edited';const p=await f.prepare();assert.equal(p.ok,false);assert.equal(writes(f.m).length,0);}
  {const f=setup();f.m.st.customize.desktop.js.push({type:'FILE',fileKey:'base'});await assert.rejects(f.prepare());assert.equal(writes(f.m).length,0);}
  {const f=setup(),p=await f.prepare();f.m.st.files.get('base').content+='\n// concurrent';const r=await f.service.apply({prepared:p});assert.notEqual(r.status,'complete');assert.equal(writes(f.m).length,0);}
});
test('実回答2本の保存条件を追加・編集イベントと境界値で実行する（無料の模擬環境）',()=>{
  const handlers={},sandbox={kintone:{events:{on:(names,fn)=>names.forEach(n=>(handlers[n]||=[]).push(fn))}}};vm.createContext(sandbox);
  for(const a of saved.artifacts)new vm.Script(a.result.generated.body || a.result.generated.code).runInContext(sandbox);
  let cases=0;
  for(const eventType of ['app.record.create.submit','app.record.edit.submit']) for(const amount of [29999,30000,50000]) for(const reason of ['', '  ', '業務上必要']) for(const method of ['電車','バス','タクシー','宿泊']) for(const travelAmount of [0,100]) {
    const row={手段:{value:method},旅費金額:{value:String(travelAmount)},旅費出発地:{value:'  '},旅費到着地:{value:'東京'}};
    const event={appId:427,record:{精算金額:{value:String(amount)},高額申請の理由:{value:reason},旅費:{value:[{value:row}]}}};
    for(const fn of handlers[eventType])assert.equal(fn(event),event);
    assert.equal(Boolean(event.record.高額申請の理由.error),amount>=30000&&!reason.trim());
    assert.equal(Boolean(row.旅費出発地.error),method!=='宿泊'&&travelAmount>0);assert.equal(Boolean(row.旅費到着地.error),false);cases++;
  }
  assert.equal(cases,144);
});
