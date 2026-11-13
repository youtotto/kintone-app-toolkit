'use strict';
// Existing free products are preserved independently of the replaced AI work surface.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { inputsOf } = require('./helpers/free-materials-fixture.js');
const REAL = require('./fixtures/scanner-cache-297.js');
const T = loadToolkit(), UI = T.KTContextUi;
const json = x => JSON.parse(JSON.stringify(x));
const formats = ['prompt','markdown','json'];

test('無料資料の全7種類を既存の正式な生成部品で3形式に出す', () => {
  assert.deepEqual(json(UI.DOCUMENT_KINDS.map(x=>x.id)).sort(), ['spec','requirements','review-request','plain','changes','handover','improvement'].sort());
  const inputs = inputsOf(T);
  const version = { version:1, status:'ACTIVE', goal:'備考を確認する', plan:{ goal:'備考を確認する', solution:'STANDARD', steps:[{id:'P1',title:'一覧に備考を表示',actionType:'ADD_VIEW',dependsOn:[]}], customizations:[], questions:[] } };
  for (const kind of UI.DOCUMENT_KINDS) {
    const result = UI.generateDocument({kind:kind.id,inputs,version,now:'2026-10-24T00:00:00Z'});
    assert.equal(result.ok,true,kind.id);
    for (const f of formats) assert.ok(result.outputs[f].length>50,`${kind.id}/${f}`);
    assert.match(result.outputs.markdown,/一覧に備考を表示/);
    assert.match(result.outputs.prompt,/Context/);
    assert.equal(JSON.parse(result.outputs.json).production.deployed,false);
    assert.match(result.warnings.join('\n'),/Nest Rec AI は使っていません/);
  }
  assert.equal(UI.generateDocument({kind:'changes',inputs}).reason,'no-plan');
});

test('修正後に採用した内容・前提・制約を全7種類の3形式へ全文保存し、古い回答を履歴に分ける', () => {
  const initialRequest = '経理確認と承認済みの備考をPCとモバイルで編集できなくしてください。';
  const correction = '経理確認では備考を編集可能に修正します。承認済みでは編集不可を維持してください。';
  const behavior = '経理確認では備考を編集可能にし、承認済みでは編集不可にする。';
  const longBehavior = '採用文の先頭。' + '既存の明細の入力チェックと行の追加・削除は維持する。'.repeat(100) + '採用文の末尾も保存する。';
  const acceptedProposal = { revision: 2, proposal: {
    behaviors: [{ id:'B2', text:behavior, origin:'user' }, { id:'B7', text:longBehavior, origin:'user' }],
    assumptions: ['経理確認の作業者は部長承認待ちと同じ指定を使う。'],
    cannot: ['運用環境への反映は利用者が行う。'], decisions: [],
    approach: { standard:[], js:['備考の編集制御'] },
  } };
  const answerHistory = [{ id:'Q4', key:'memo-lock', label:'備考を編集不可にする状態', question:'備考を編集不可にするステータスはどれですか。', answer:'経理確認中と承認済みの両方で、備考を編集不可にします。', kind:'user' }];
  const requestHistory = [initialRequest, answerHistory[0].answer, correction];
  const version = { version:2, status:'ACTIVE', goal:initialRequest, acceptedProposal, answerHistory, requestHistory,
    plan:{ goal:initialRequest, solution:'CUSTOMIZATION', steps:[{id:'C8',title:behavior,actionType:'CUSTOMIZATION_REQUIRED',dependsOn:[]}], customizations:[{customizationId:'C8',requirement:behavior,strategy:'NEW_JS_FILE',platform:['desktop','mobile']}], questions:[] } };
  const inputs = inputsOf(T), before = JSON.stringify({version,inputs});
  for (const kind of UI.DOCUMENT_KINDS) {
    const result = UI.generateDocument({kind:kind.id,inputs,version,now:'2026-10-24T00:00:00Z'});
    assert.equal(result.ok,true,kind.id);
    const saved = JSON.parse(result.outputs.json);
    assert.deepEqual(saved.acceptedProposal,acceptedProposal,kind.id+' preserves the complete adopted proposal');
    assert.deepEqual(saved.answerHistory,answerHistory);
    assert.equal(Object.hasOwn(saved,'decisions'),false,'past answers are not exported as current decisions');
    assert.deepEqual(saved.requestHistory,requestHistory);
    assert.equal(Object.hasOwn(saved.plan,'goal'),false,'the original request is not presented as the adopted plan goal');
    assert.equal(saved.plan.customizations[0].requirement,behavior);
    assert.equal(saved.planStatus,'ACTIVE');
    assert.equal(saved.planVersion,2);
    assert.equal(saved.production.deployed,false);
    for (const format of ['markdown','prompt']) {
      const output = result.outputs[format];
      for (const heading of ['採用した内容','採用した前提','採用した制約','確認事項への回答履歴','依頼と修正の履歴（採用内容ではありません）']) assert.ok(output.includes(heading),kind.id+'/'+format+'/'+heading);
      for (const text of [behavior,longBehavior,...acceptedProposal.proposal.assumptions,...acceptedProposal.proposal.cannot,answerHistory[0].question,answerHistory[0].answer,...requestHistory]) assert.ok(output.includes(text),kind.id+'/'+format+' preserves the full text');
      const historyStart=output.indexOf('## 依頼と修正の履歴（採用内容ではありません）');
      assert.ok(historyStart>0);
      assert.ok(!output.slice(0,historyStart).includes(answerHistory[0].answer),'the superseded answer is not part of the adopted content');
      assert.ok(!output.slice(0,historyStart).includes(answerHistory[0].question),'answered questions remain with their history');
      assert.ok(output.indexOf('### 確認事項への回答履歴')>historyStart,'answers are explicitly nested under history');
      assert.ok(!output.includes('## 回答した確認事項'));
      if(format==='prompt') assert.ok(output.includes('現在の合意内容は「採用した内容」とその前提・制約です。'));
      assert.ok(!output.includes('**実現したいこと**: '+initialRequest),'the original request is labelled as history');
    }
  }
  assert.equal(JSON.stringify({version,inputs}),before,'export does not rewrite the live plan, adopted proposal, or app facts');
});

test('採用情報のない既存の資料では計画と依頼の従来の出力を維持する', () => {
  const version = { version:1, status:'ACTIVE', goal:'従来の依頼', plan:{goal:'従来の計画目的',solution:'STANDARD',steps:[],customizations:[],questions:[]} };
  const result = UI.generateDocument({kind:'changes',inputs:inputsOf(T),version});
  const saved = JSON.parse(result.outputs.json);
  assert.equal(saved.plan.goal,'従来の計画目的');
  for (const key of ['acceptedProposal','decisions','answerHistory','requestHistory']) assert.equal(Object.hasOwn(saved,key),false);
  for (const format of ['markdown','prompt']) {
    assert.ok(result.outputs[format].includes('**実現したいこと**: 従来の依頼'));
    assert.ok(!result.outputs[format].includes('採用した内容'));
  }
});

test('相談用と計画用の資料、PCとモバイルの同名ファイルと同名フィールドを取り違えない', () => {
  const inputs = inputsOf(T), targets = UI.listTargets(inputs);
  for (const id of ['desktop:js:common.js','mobile:js:common.js']) assert.ok(targets.files.some(f=>f.id===id));
  assert.ok(targets.fields.some(f=>f.id==='pic_sales'));
  assert.ok(targets.fields.some(f=>f.id==='pic_support'));
  for (const [type,id] of [['app',null],['field','pic_sales'],['file','desktop:js:common.js'],['file','mobile:js:common.js']]) {
    const result=UI.generate({targetType:type,targetId:id,question:'この対象の構造を説明してください',inputs});
    assert.equal(result.ok,true,`${type}:${id}`);
    for (const f of formats) assert.ok(result.outputs[f].length>50);
    if(id) assert.equal(result.ctx.focus.target.id,id);
  }
  const result=UI.generatePlan({goal:'備考を一覧に表示する',inputs});
  assert.equal(result.ok,true);
  for (const f of formats) assert.ok(result.outputs[f].length>50);
  assert.equal(UI.generatePlan({goal:'',inputs}).reason,'no-goal');
});

test('対象が曖昧なら資料を作らず、明示した対象から作る', () => {
  const inputs=inputsOf(T);
  const first=UI.generate({targetType:'app',question:'common.js を説明してください',inputs});
  assert.equal(first.ok,false); assert.equal(first.reason,'ambiguous');
  assert.equal(first.outputs,undefined);
  assert.ok(first.candidates.some(c=>c.id==='desktop:js:common.js'));
  const next=UI.generate({targetType:'file',targetId:'desktop:js:common.js',question:'common.js を説明してください',inputs});
  assert.equal(next.ok,true); assert.equal(next.ctx.focus.target.id,'desktop:js:common.js');
});

test('資料の本文・形式ごとに秘密情報を除き、未解析と本文の無いキャッシュを事実どおり示す', () => {
  const data=REAL.makeData(), deps=T.KTDeps.buildDependencyData(data,T.KTDeps.normalizeFields(data.fields));
  T.KTDeps.mergeScannerEdges(deps,REAL.cache.payload);
  const inputs={data,deps,scan:REAL.cache.payload,incoming:null};
  const result=UI.generate({targetType:'file',targetId:`desktop:js:${REAL.FILE}`,question:'この JavaScript を説明してください',inputs});
  assert.equal(result.ok,true);
  assert.match(result.warnings.join('\n'),/キャッシュに含まれない/);
  assert.equal(result.ctx.coverage.javascriptSource,'snippets');
  assert.ok(result.ctx.facts.some(f=>f.kind==='js-match'));
  assert.ok(!result.ctx.facts.some(f=>f.kind==='code-excerpt'));
  for (const f of formats) { assert.doesNotMatch(result.outputs[f],/abcdEFGH12345678/); assert.match(result.outputs[f],/\*\*\*/); }
  const unscanned=UI.generate({targetType:'app',question:'構造を説明してください',inputs:inputsOf(T,{withScan:false})});
  assert.match(unscanned.warnings.join('\n'),/JavaScript は未解析/);
  assert.ok(unscanned.coverage.some(row=>row.label==='レコードデータ' && row.included===false));
  assert.ok(unscanned.coverage.some(row=>row.label==='添付ファイル' && row.included===false));
  const truncated=UI.generate({targetType:'field',targetId:'customer_code',question:'構造を説明してください',inputs:inputsOf(T),limits:{maxDependencyFacts:2,maxJsMatchFacts:1}});
  assert.equal(truncated.truncation.applied,true);
  assert.match(truncated.truncation.message,/省略されています/);
  assert.ok(truncated.truncation.details.some(x=>/件中2件/.test(x)));
});

test('Healthのプロセス図は状態・操作名と空ラベルを失わない', () => {
  const states=Object.fromEntries(['申請前','承認待ち','承認済み'].map((name,i)=>[name,{name,index:String(i)}]));
  const code=T.buildProcessMermaid({states,actions:[{name:'申請する(課長)',from:'申請前',to:'承認待ち'},{name:'承認する',from:'承認待ち',to:'承認済み'},{name:'',from:'承認待ち',to:'申請前'}]});
  assert.match(code,/^flowchart LR/);
  assert.ok(code.includes('S0["申請前"]'));
  assert.ok(code.includes('S0 -->|"申請する(課長)"| S1'));
  assert.ok(code.includes('S1 -->|"承認する"| S2'));
  assert.ok(code.includes('S1 --> S0'));
  assert.equal(T.buildProcessMermaid({states:{},actions:[]}),'');
});

test('Healthのプロセス図は引用符・括弧・改行を安全なラベルにする', () => {
  const labels=['承認("課長")','部長 #1','状態`確認`','確認<対象>','行\n追加','角[括弧] {中括弧} |区切り;'];
  const states=Object.fromEntries(labels.map((name,i)=>[name,{name,index:i}]));
  const code=T.buildProcessMermaid({states,actions:labels.slice(1).map((name,i)=>({name,from:labels[i],to:labels[i+1]}))});
  const node=/^  S\d+\["[^"]*"\]$/, edge=/^  S\d+ -->\|"[^"]*"\| S\d+$/;
  for (const line of code.split('\n').slice(1)) assert.ok(node.test(line)||edge.test(line),line);
  assert.match(code,/#quot;課長#quot;/); assert.match(code,/#35;1/); assert.match(code,/#96;確認#96;/);
  assert.match(code,/確認＜対象＞/); assert.match(code,/行 追加/);
});
