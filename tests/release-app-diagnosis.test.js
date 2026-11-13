'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeEnvGetter, fileEntry } = require('./helpers/dev-base-fake.js');
const T = loadToolkit(), C = T.KTReleaseContext;
const clone = x => JSON.parse(JSON.stringify(x));
const field = (code, type = 'NUMBER', extra = {}) => ({ code, label: code, type, ...extra });
const src = code => "kintone.events.on('app.record.edit.show',function(event){event.record['" + code + "'].disabled=true;return event;});";
function data(code = 'amount', target = 'desktop') {
  const text = src(code), js = fileEntry('current-' + code, 'shared.js', text);
  return {
    appId: '310', fields: { amount: field('amount'), memo: field('memo', 'SINGLE_LINE_TEXT'), total: field('total', 'CALC', { expression: code + '*2' }) },
    layout: [], settings: { name: '依存関係確認用' }, views: { views: { 一覧: { id: '1', name: '一覧', type: 'LIST', fields: [code], filterCond: '', sort: '' } } },
    status: { enable: false, states: {}, actions: [] }, generalNotify: { notifications: [] }, perRecordNotify: { notifications: [] }, reminderNotify: { notifications: [] },
    appAcl: { rights: [] }, recordAcl: { rights: [] }, fieldAcl: { rights: [] }, actions: { actions: {} }, reports: { reports: {} }, appPlugins: { plugins: [] },
    customize: { scope: 'ALL', desktop: { js: target === 'desktop' ? [js] : [], css: [] }, mobile: { js: target === 'mobile' ? [js] : [], css: [] } }
  };
}
async function baseOf(options = {}) {
  const preview = options.preview || data(), production = options.production || data('memo');
  const io = makeEnvGetter({ preview, production, files: { 'current-amount': src('amount'), 'current-memo': src('memo'), ...(options.files || {}) }, revisions: options.revisions || { preview: '12', production: '10' }, fail: options.fail || {} });
  const base = await T.KTDevBase.loadForRelease({ appId: '310', getImpl: io.getImpl, download: io.download, now: () => Date.parse(options.at || '2026-10-26T01:00:00Z') });
  return { base, io };
}
const tools = extra => ({ analyze: T.KTDevBase.analyze, factFromEdge: T.KTContext.factFromEdge, ...extra });
const proposal = (base, extra) => C.proposal({ text: 'このアプリを説明し、変更の影響を整理してください。', base }, tools(extra));
const plan = (base, extra) => C.plan({ goal: '金額の変更', proposal: { behaviors: [], assumptions: [], decisions: [], cannot: [] }, base, version: 1 }, tools(extra));
const deps = ctx => ctx.facts.filter(f => ['dependency', 'js-reference'].includes(f.kind));
const coverage = ctx => {
  const f = ctx.facts.find(f => f.kind === 'dependency-coverage');
  assert.ok(f, 'dependency coverage must be an explicit fact');
  return f.value;
};
const targetOf = f => String(f.target?.id || '');
const textOf = value => JSON.stringify(value);


const diagnose=(base, extra={})=>C.proposal({text:'診断してください',requestPurpose:'ideation',diagnosis:true,base},tools({findBrokenRefs:T.KTDeps.findBrokenRefs,calcChainStats:T.KTDeps.calcChainStats,...extra}));
test('診断は現在のHealth・Deps・JS Scannerだけを使い、管理者用メモや別環境を送らない',async()=>{
 const {base}=await baseOf();base.data.adminNotes={content:'ADMIN_SECRET'};base.deps={secret:'STALE_GRAPH'};base.scan={secret:'STALE_SCAN'};
 base.productionData.adminNotes={content:'PRODUCTION_SECRET'};
 let n=0,current;const ctx=diagnose(base,{analyze:b=>{n++;current=b;T.KTDevBase.analyze(b);}});
 assert.equal(n,1);assert.equal(ctx.requestPurpose,'ideation');assert.equal(ctx.focus.target.type,'app-diagnosis');assert.equal(ctx.focus.target.id,'310');
 const health=ctx.facts.find(f=>f.kind==='app-health');assert.ok(health);assert.deepEqual(clone(health.value.brokenReferences),clone(T.KTDeps.findBrokenRefs(current.deps)));
 assert.deepEqual(clone(health.value.calculationChains),clone(T.KTDeps.calcChainStats(current.deps)));
 assert.deepEqual(clone(ctx.facts.find(f=>f.kind==='js-events').value),clone(current.scan.fileEvents));assert.ok(JSON.stringify(ctx).includes('app.record.edit.show'));
 assert.ok(deps(ctx).length);assert.equal(ctx.coverage.adminNotes,false);assert.doesNotMatch(JSON.stringify(ctx),/ADMIN_SECRET|PRODUCTION_SECRET|STALE_GRAPH|STALE_SCAN/);
 assert.equal(health.provenance.revision,'12');assert.equal(health.provenance.environment,'preview');
});
test('解析失敗と取得できない権限・ファイルは問題なしにしない',async()=>{
 const {base}=await baseOf({fail:{'preview:app/acl':Object.assign(Error('denied'),{status:403})}});
 const ctx=diagnose(base,{findBrokenRefs:()=>{throw Error('no graph');}});
 assert.equal(ctx.coverage.dependencies,false);assert.equal(coverage(ctx).status,'unavailable');assert.ok(coverage(ctx).missingSettings.length);assert.ok(!ctx.facts.some(f=>f.kind==='app-health'));
 assert.throws(()=>diagnose({...base,env:'production'}));
 assert.throws(()=>C.proposal({text:'診断',requestPurpose:'consultation',diagnosis:true,base},tools()));
});
test('古い診断ではなく毎回の設定を根拠にする。通常の相談に診断集計を足さない',async()=>{
 const a=await baseOf(),b=await baseOf({preview:data('memo'),revisions:{preview:'13',production:'10'}});
 const x=diagnose(a.base),y=diagnose(b.base);
 assert.equal(y.facts.find(f=>f.kind==='app-health').provenance.revision,'13');assert.notDeepEqual(x.facts,y.facts);
 assert.ok(!proposal(a.base).facts.some(f=>f.kind==='app-health'));
});
const {KTReleaseWorkspace:W}=require('../src/release-workspace.js');
const F=require('./helpers/release-workspace-fixture.js');
const answer=()=>({reply:'診断しました。',intent:'question',proposalUnchanged:true,explanation:{title:'診断',sections:[{heading:'参考：期限を見つけやすくできそうです',paragraphs:['期限があります。'],items:['期限の一覧を検討できます。'],table:null,evidenceIds:['E1']}],unknowns:['実際の動作は未確認です。']},facts:[{id:'E1',statement:'期限の設定'}]});
for(const mode of ['success','failure','cancel','changed'])test('診断 '+mode+' は採用内容とコードを保持し、変更・反映しない',async()=>{
 let result=null,input;const gate=F.deferred();
 const f=F.fixture(W,{loadBase:async({revision})=>({ok:true,env:'preview',appId:'310',revision:{preview:String(revision)},stamp:'preview:'+revision,data:{fields:{}},files:[]}),propose:async p=>{input=p;if(result==='cancel')return gate.promise;if(result==='failure')throw Error('offline');return result?answer():F.proposal();}});
 await f.controller.send(F.REQUEST);await f.controller.adopt();const before=f.controller.getState();
 result=mode;if(mode==='changed')f.bump();
 const pending=f.controller.send('診断',{requestPurpose:'ideation',diagnosis:true,consultationTarget:null});
 if(mode==='cancel'){await new Promise(r=>setImmediate(r));f.controller.cancel();gate.resolve(answer());}
 await pending;const after=f.controller.getState();
 assert.deepEqual(after.adopted,before.adopted);assert.deepEqual(after.proposal,before.proposal);assert.deepEqual(after.artifacts,before.artifacts);assert.deepEqual(after.plan,before.plan);assert.equal(f.writes.length,0);
 assert.equal(after.requestPurpose,before.requestPurpose);assert.equal(input.diagnosis,true);assert.equal(input.requestPurpose,'ideation');
 if(mode==='changed'){assert.equal(after.phase,'blocked');assert.equal(after.prepared,null);}else if(mode==='success'){
  assert.equal(after.phase,before.phase);const e=after.explanations[0];assert.equal(e.accepted,false);assert.equal(e.diagnosisSource.appId,'310');
  const exported=f.controller.exportSession();assert.deepEqual(exported.state.explanations[0].diagnosisSource,e.diagnosisSource);
  assert.equal(await f.controller.restoreSession(exported),true);assert.deepEqual(f.controller.getState().explanations[0].diagnosisSource,e.diagnosisSource);
 }else assert.equal(after.explanations.length,0);
});
