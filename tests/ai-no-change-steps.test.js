// 簡素化 A（2026-10-16）: 値を指定した変更の手順が、今の設定と同じ（既存の比較で変わる項目なし）なら「変更不要」。
//
// 検証内容:
//   §N1 今と同じ値の承認分岐 2 つ（10-16 の実機の P1・P2 と同じ形）: 書き込まない・確認事項・反映できないこと・変更する設定に数えない
//   §N2 値が無い手順は変更不要にしない（要確認のまま。依存先としても満たさない）
//   §N3 同じ遷移元で、片方が変更不要・片方が本当に変わる → 変わる方を反映できる（以前は変更不要の相手のせいで PROCESS_BRANCH_PARTIAL）
//   §N4 両方が本当に変わり片方だけ反映できない → 今までどおり止める（分岐を片方だけ反映しない）
//   §N5 対象が無い → 無効のまま／反映の直前に設定が変わった → 今までどおり TARGET_CHANGED で止める
//   §N6 変更不要の手順に依存する手順は反映できる（今の設定が条件を満たす）
//   §N7 ほかの種類（フィールド・一覧・通知・リマインダー・作業者・ルックアップ）も、今と同じ値なら変更不要
//   §N8 比べられないもの（反映しない値・取得していないコピー先）は変更不要にしない
//   §N9 計画の版の反映済み: JavaScript の登録の後、変更不要の手順しか残っていなければ反映済み（本当に変える手順が残れば反映済みにしない）
//
// 実行方法: node tests/ai-no-change-steps.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTDeps, KTPlanReview, KTPlanExecutor, KTAiConversation } = T;
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const E = KTPlanExecutor, R = KTPlanReview;

const clone = (v) => JSON.parse(JSON.stringify(v));
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], changeKind: null, assigneeType: null, ...o });
const step = (id, actionType, targetKind, targetRef, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: true, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'CONFIRMED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PREVIEW_SUPPORTED', supported: true, reason: 'x' }, ...extra });
const plan = (steps, extra = {}) => ({ planVersion: '1', requestId: 'tk-nochange', goal: 'g', assessment: { summary: '' }, relevantFields: [], proposedFields: [], steps, alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'CONFIRMED', ...extra });

// 承認分岐のあるアプリ（10-16 の実機の App 353 と同じ形: 同じ遷移元から金額で 2 つに分かれる）
const DATA = (() => {
  const d = FX.makeData();
  d.status = clone(d.status);
  d.status.actions = [
    { name: '部長へ申請する', from: '未処理', to: '承認待ち', filterCond: 'amount >= "1000000"', type: 'PRIMARY' },
    { name: '申請する', from: '未処理', to: '完了', filterCond: 'amount < "1000000"', type: 'PRIMARY' },
    { name: '承認する', from: '承認待ち', to: '完了', filterCond: '', type: 'PRIMARY' },
  ];
  return d;
})();
const DEPS = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
const reviewOf = (p, data = DATA) => R.review({ plan: p, data, deps: data === DATA ? DEPS : null, scan: null, incoming: null });
const approveAll = (p, rv) => R.executorOutput(p, rv, p.steps.map(s => s.id));
const classOf = (p, rv) => new Map(E.classifySteps(approveAll(p, rv)).map(s => [s.stepId, s]));
const applyOf = (p, rv) => new Map(E.applyReadiness(p, rv).map(a => [a.stepId, a]));
const SAME_P1 = () => step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '部長へ申請する', { name: '部長へ申請する', from: '未処理', to: '承認待ち', filterCond: 'amount >= "1000000"', changeKind: 'ACTION_CONDITION' }, { title: '100万円以上の既存部長承認分岐を維持' });
const SAME_P2 = () => step('P2', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', to: '完了', filterCond: 'amount < "1000000"', changeKind: 'ACTION_CONDITION' }, { title: '100万円未満の既存分岐を維持' });

(async () => {
console.log('\n--- §N1 今と同じ値の承認分岐 2 つ（10-16 の実機の P1・P2 と同じ形）---');
{
  const p = plan([SAME_P1(), SAME_P2()]);
  const rv = reviewOf(p);
  for (const id of ['P1', 'P2']) {
    const r = rv.steps.find(x => x.stepId === id);
    assert(r.status === 'VALID' && r.safety === 'SAFE' && r.diff.changeType === 'REUSE' && !r.issues.length, `${id}: 変更不要（VALID・REUSE・指摘なし）。以前は NO_STRUCTURED_CHANGE（要確認・「変更内容が構造化されていない」）: ${r.status}/${r.diff.changeType}/${r.issues.map(i => i.code)}`);
    assert(JSON.stringify(r.diff.before) === JSON.stringify(r.diff.after) && r.diff.before.filterCond === r.spec.filterCond, `${id}: 変更前と変更後は同じ（今の設定の値）`);
  }
  assert(!rv.steps.some(r => r.status === 'NEEDS_CONFIRMATION' || r.diff.changeType === 'UPDATE'), `確認事項・変更する設定にしない（手順ごとの確認の結果）: ${JSON.stringify(rv.steps.map(r => [r.stepId, r.status, r.diff.changeType]))}`);
  const cls = classOf(p, rv), ap = applyOf(p, rv);
  assert(['P1', 'P2'].every(id => cls.get(id).status === 'SKIPPED' && cls.get(id).reason === 'NO_CHANGE'), `反映の分類: 書き込まない（SKIPPED・NO_CHANGE。以前は UNSUPPORTED＝反映できない）: ${[...cls.values()].map(s => `${s.stepId}:${s.status}/${s.reason}`)}`);
  assert(['P1', 'P2'].every(id => ap.get(id).apply === 'CONFIRM' && ap.get(id).reason === 'NO_CHANGE'), `反映の見込み: 「反映できない（MANUAL）」にしない: ${[...ap.values()].map(a => `${a.stepId}:${a.apply}`)}`);
  const mock = makeKintoneMock(DATA);
  const pr = await E.prepare(approveAll(p, rv), { api: mock.api, appId: '310' });
  assert(!pr.steps.some(s => s.status === 'PENDING') && !mock.calls.some(c => /^PUT /.test(c)), `反映の準備: 実行する手順なし・書き込みなし: ${pr.status}/${mock.calls.filter(c => /^PUT /.test(c))}`);
}

console.log('\n--- §N2 値が無い手順は変更不要にしない ---');
{
  const p = plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { changeKind: 'ACTION_CONDITION' }), step('V1', 'ADD_VIEW', 'VIEW', '新しい一覧', { name: '新しい一覧', fields: ['amount'] }, { dependsOn: ['P1'] })]);
  const rv = reviewOf(p);
  const r = rv.steps.find(x => x.stepId === 'P1');
  assert(r.status === 'NEEDS_CONFIRMATION' && r.diff.changeType === 'NO_CHANGE' && r.issues.some(i => i.code === 'NO_STRUCTURED_CHANGE'), `値の無い手順は要確認のまま（NO_STRUCTURED_CHANGE）: ${r.status}/${r.diff.changeType}`);
  const cls = classOf(p, rv);
  assert(cls.get('P1').status === 'UNSUPPORTED' && cls.get('P1').reason === 'NO_VALUES', `反映の分類: 「変更の値が計画にありません」（変更不要の NO_CHANGE と別の理由）: ${cls.get('P1').status}/${cls.get('P1').reason}`);
  assert(cls.get('V1').status === 'BLOCKED' && cls.get('V1').reason === 'DEPENDENCY_NOT_EXECUTABLE', `値の無い手順は依存先として満たさない（依存する手順は止まる）: ${cls.get('V1').status}/${cls.get('V1').reason}`);
  assert(rv.steps.filter(r => r.status === 'NEEDS_CONFIRMATION').map(r => r.stepId).join() === 'P1', `確認が必要な手順は P1 の 1 件（手順ごとの確認の結果）: ${JSON.stringify(rv.steps.map(r => [r.stepId, r.status]))}`);
}

console.log('\n--- §N3 同じ遷移元で、片方が変更不要・片方が本当に変わる ---');
{
  const p = plan([SAME_P1(), step('P2', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', to: '承認待ち', filterCond: 'amount < "1000000"', changeKind: 'ACTION_TRANSITION' })]);
  const rv = reviewOf(p);
  assert(rv.steps.find(x => x.stepId === 'P1').diff.changeType === 'REUSE' && rv.steps.find(x => x.stepId === 'P2').diff.changeType === 'UPDATE', '前提: P1 は変更不要・P2 は本当に変わる（遷移先）');
  const cls = classOf(p, rv);
  assert(cls.get('P2').status === 'PENDING' && cls.get('P1').reason === 'NO_CHANGE', `変わる P2 は反映できる（変更不要の P1 を「反映されない分岐」に数えない。以前は PROCESS_BRANCH_PARTIAL）: P2 ${cls.get('P2').status}/${cls.get('P2').reason}`);
  const mock = makeKintoneMock(DATA);
  const pr = await E.prepare(approveAll(p, rv), { api: mock.api, appId: '310' });
  const log = pr.status === 'PREPARED' ? await E.executePreview(pr, { api: mock.api, review: rv, data: DATA }) : null;
  const now = new Map(mock.st.status.actions.map(a => [a.name, a]));
  assert(log && log.status === 'DONE' && mock.calls.filter(c => c === 'PUT status').length === 1, `書き込みは P2 の 1 回だけ: ${log && log.status}/${mock.calls.filter(c => c === 'PUT status').length}`);
  assert(now.get('申請する').to === '承認待ち' && now.get('部長へ申請する').filterCond === 'amount >= "1000000"' && now.get('部長へ申請する').to === '承認待ち', '反映の後: P2 は変わり、変更不要の P1 は今のまま');
}

console.log('\n--- §N4 両方が本当に変わり、片方だけ反映できない ---');
{
  const p = plan([
    step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '部長へ申請する', { name: '部長へ申請する', from: '未処理', to: '承認待ち', filterCond: 'owner != ""', changeKind: 'ACTION_CONDITION' }),
    step('P2', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', to: '承認待ち', filterCond: 'amount < "1000000"', changeKind: 'ACTION_TRANSITION' }),
  ]);
  const rv = reviewOf(p);
  const cls = classOf(p, rv);
  assert(cls.get('P1').status === 'BLOCKED' && cls.get('P2').status === 'BLOCKED' && cls.get('P2').reason === 'PROCESS_BRANCH_PARTIAL', `分岐を片方だけ反映しない（今までどおり）: P1 ${cls.get('P1').reason}・P2 ${cls.get('P2').reason}`);
}

console.log('\n--- §N5 対象が無い・反映の直前に設定が変わった ---');
{
  const rvU = reviewOf(plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '存在しない操作', { from: '未処理', to: '完了', filterCond: 'amount >= "1"' })]));
  assert(rvU.steps[0].status === 'INVALID' && rvU.steps[0].issues.some(i => i.code === 'UNKNOWN_PROCESS_TARGET') && rvU.steps[0].diff.changeType !== 'REUSE', '対象が無い手順は無効のまま（変更不要にしない）');
  const p = plan([SAME_P1(), step('P2', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', to: '承認待ち', filterCond: 'amount < "1000000"', changeKind: 'ACTION_TRANSITION' })]);
  const rv = reviewOf(p);
  const mock = makeKintoneMock(DATA);
  const pr = await E.prepare(approveAll(p, rv), { api: mock.api, appId: '310' });
  mock.st.status.actions.find(a => a.name === '申請する').filterCond = 'amount < "500000"';   // 準備の後に人が変えた
  const log = await E.executePreview(pr, { api: mock.api, review: rv, data: DATA });
  const s2 = log.steps.find(s => s.stepId === 'P2');
  assert(log.status === 'FAILED' && s2.reason === 'TARGET_CHANGED' && !mock.calls.some(c => c === 'PUT status') && mock.st.status.actions.find(a => a.name === '申請する').filterCond === 'amount < "500000"', `反映の直前の照合は残る（TARGET_CHANGED・書き込みなし・人の変更はそのまま）: ${log.status}/${s2 && s2.reason}`);
}

console.log('\n--- §N6 変更不要の手順に依存する手順 ---');
{
  const p = plan([SAME_P1(), step('V1', 'ADD_VIEW', 'VIEW', '高額の申請', { name: '高額の申請', fields: ['amount'], filterCond: 'amount >= "1000000"' }, { dependsOn: ['P1'] })]);
  const rv = reviewOf(p);
  const cls = classOf(p, rv);
  assert(cls.get('V1').status === 'PENDING', `変更不要の P1 に依存する V1 は反映できる（今の設定が条件を満たす）: ${cls.get('V1').status}/${cls.get('V1').reason}`);
  const outNoP1 = R.executorOutput(p, rv, ['V1']);   // P1 を外しても（承認の有無に関係なく）同じ
  assert(new Map(E.classifySteps(outNoP1).map(s => [s.stepId, s])).get('V1').status === 'PENDING', '書き込みの要らない手順は承認の有無に関係なく依存を満たす');
}

console.log('\n--- §N7 ほかの種類も、今と同じ値なら変更不要 ---');
{
  const cases = [
    ['フィールドの表示名', step('F1', 'UPDATE_FIELD', 'FIELD', 'amount', { name: '金額' })],
    ['一覧の絞り込み', step('W1', 'UPDATE_VIEW', 'VIEW', '承認待ち', { name: '承認待ち', filterCond: 'ステータス in ("承認待ち")' })],
    ['通知の条件', step('N1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', '高額案件の登録', { filterCond: 'amount >= "1000000"' })],
    ['リマインダーの日数', step('M1', 'UPDATE_REMINDER', 'REMINDER', '期限前日のリマインド', { daysLater: '-1' })],
    ['作業者の指定形式', step('S1', 'UPDATE_PROCESS', 'PROCESS_STATUS', '承認待ち', { assigneeType: 'ALL', changeKind: 'ASSIGNEE' })],
    ['ルックアップの選択時の表示', step('L1', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', { addPickerFields: ['code'] })],
  ];
  for (const [label, st] of cases) {
    const rv = reviewOf(plan([st]));
    const r = rv.steps[0];
    assert(r.diff.changeType === 'REUSE' && r.status === 'VALID' && !r.issues.some(i => i.code === 'NO_STRUCTURED_CHANGE'), `${label}: 変更不要: ${r.status}/${r.diff.changeType}/${r.issues.map(i => i.code)}`);
    assert(new Map(E.classifySteps(approveAll(plan([st]), rv)).map(s => [s.stepId, s])).get(st.id).reason === 'NO_CHANGE', `${label}: 書き込まない（NO_CHANGE）`);
  }
  //   本当に変わる値は今までどおり変更（要確認）
  const real = reviewOf(plan([step('M1', 'UPDATE_REMINDER', 'REMINDER', '期限前日のリマインド', { daysLater: '-2' })])).steps[0];
  assert(real.diff.changeType !== 'REUSE' && real.status === 'NEEDS_CONFIRMATION' && real.issues.some(i => i.code === 'REMINDER_TIMING_CHANGE'), 'リマインダーの日数を本当に変えるなら、今までどおり変更（要確認）');
}

console.log('\n--- §N8 比べられないものは変更不要にしない ---');
{
  const ign = reviewOf(plan([step('N1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', '高額案件の登録', { events: ['RECORD_ADDED'] })])).steps[0];
  assert(ign.diff.changeType !== 'REUSE' && ign.issues.some(i => i.code === 'NO_STRUCTURED_CHANGE'), `反映しない値（レコードの条件通知のイベント）だけの手順は要確認のまま: ${ign.diff.changeType}/${ign.issues.map(i => i.code)}`);
  const d2 = clone(DATA); delete d2.relatedApps[String(FX.QUOTE_DEST_APP)];
  const aa = R.review({ plan: plan([step('A1', 'UPDATE_APP_ACTION', 'APP_ACTION', '見積を作成', { filterCond: '' , entities: [] })]), data: d2, deps: null, scan: null, incoming: null }).steps[0];
  assert(aa.diff.changeType !== 'REUSE', `コピー先を取得していない・値の無いアプリアクションは変更不要にしない: ${aa.status}/${aa.diff.changeType}/${aa.issues.map(i => i.code)}`);
}

console.log('\n--- §N9 計画の版の反映済み（JavaScript の登録の後）---');
{
  const draftRaw = (u) => ({ reply: `「${u}」を実現する変更案にできます。`, intent: 'propose', proposal: { behaviors: [{ text: u, origin: 'user' }], assumptions: [], decisions: [], approach: { standard: [], js: ['JavaScript で実現する'] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } });
  const cust = { customizationId: 'C1', requirement: 'r', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: [], fields: [], apis: [], existingFiles: [], dependsOn: [], questions: [], risks: [] };
  const withJs = (procStep) => plan([step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { solution: 'CUSTOMIZATION' }), procStep], { solution: 'HYBRID', customizations: [cust] });
  const run = async (p) => {
    const rv = reviewOf(p);
    const svc = { conversationFeatures: () => ['requirements', 'stream', 'proposal', 'itemIds'], async propose(args) { return { ok: true, proposal: K.normalized(draftRaw(args.utterance), 'pp-1', null, args), ctx: { facts: [] } }; }, async plan() { return { plan: clone(p), ctx: null, review: clone(rv) }; }, async ask() { return { ok: true, answer: { answer: 'a' } }; } };
    const c = KTAiConversation.create({ services: svc });
    await c.send('承認済みの備考を編集できないようにしたい'); await c.send('これで進めて');
    const v = c.activePlan(); v.generated = { C1: { generated: { strategy: 'NEW_JS_FILE' } } };
    c.noteJsExecution({ stage: 'running', execution: { executionId: 'jx1', status: 'RUNNING', put: null } });
    c.noteJsExecution({ stage: 'done', execution: { executionId: 'jx1', status: 'DONE', put: { ok: true } } });
    return v;
  };
  const vSame = await run(withJs(SAME_P1()));
  assert(vSame.status === 'EXECUTED', `JavaScript の登録の後、変更不要の手順しか残っていなければ反映済み（以前は「維持」の手順を残りに数え ACTIVE のまま）: ${vSame.status}`);
  const vReal = await run(withJs(step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', to: '承認待ち', filterCond: 'amount < "1000000"', changeKind: 'ACTION_TRANSITION' })));
  assert(vReal.status === 'ACTIVE', `本当に変える設定の手順がまだ反映されていなければ反映済みにしない: ${vReal.status}`);
}

console.log('\n--- §N10 最終案の判定: 値の無い手順と、それで止まる手順があれば反映できない（2026-10-18）---');
{
  //   2026-10-18（説明文から設定値を補わない）: 最終案の判定は、確認の結果の BLOCKED だけでなく設定の手順の反映の分類（値の無い NO_VALUES・依存や分岐で止まる手順）も見る。
  //   前は、値の無い手順と、それに依存して止まる手順があっても「この内容で反映できます」としていた（ほかの手順だけを反映する）
  const FS = require('./helpers/final-state.js');
  const draftRaw = (u) => ({ reply: `「${u}」を実現する変更案にできます。`, intent: 'propose', proposal: { behaviors: [{ text: u, origin: 'user' }], assumptions: [], decisions: [], approach: { standard: ['プロセス管理と一覧'], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } });
  const finalOf = async (p) => {
    const rv = reviewOf(p);
    const svc = { conversationFeatures: () => ['requirements', 'stream', 'proposal', 'itemIds'], async propose(args) { return { ok: true, proposal: K.normalized(draftRaw(args.utterance), 'pp-1', null, args), ctx: { facts: [] } }; }, async plan() { return { plan: clone(p), ctx: null, review: clone(rv) }; }, async ask() { return { ok: true, answer: { answer: 'a' } }; } };
    const c = KTAiConversation.create({ services: svc });
    await c.send('100万円未満の申請の条件を変えて、一覧も足したい'); await c.send('これで進めて');
    return c.activePlan();
  };
  const view = () => step('V1', 'ADD_VIEW', 'VIEW', '新しい一覧', { name: '新しい一覧', fields: ['amount'] }, { dependsOn: ['P1'] });
  //   条件の変更（changeKind ACTION_CONDITION）なのに条件式が spec に無い（説明文にだけ書いた）P1 と、P1 に依存する一覧
  const noVal = step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', changeKind: 'ACTION_CONDITION' }, { proposal: { summary: '申請するを 100 万円未満だけにする', details: [{ key: '条件', value: 'amount < "1000000"' }] } });
  const a = await finalOf(plan([noVal, view()]));
  const rdA = FS.readinessOf(a);
  assert(a.final && rdA.ready === false && rdA.reasons.some(r => r.kind === 'no-values') && rdA.reasons.some(r => r.kind === 'blocked') && (a.final.cannot || []).some(x => x.kind === 'no-values' && /変更の値が計画に無い手順/.test(x.text)) && (a.final.cannot || []).some(x => x.kind === 'blocked' && /依存する P1/.test(x.text)),
    `値の無い手順（説明文にだけ条件を書いた）と、それに依存して止まる手順があれば、最終案は反映できない（理由と「実現できない点」に出す）: ${JSON.stringify({ reasons: rdA.reasons.map(r => r.kind), cannot: (a.final.cannot || []).map(x => x.kind) })}`);
  //   同じ形で、spec の条件式が今の条件と同じなら変更不要（値の欠落ではない）→ 依存する一覧も反映でき、最終案は反映できる
  const same = step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', filterCond: 'amount < "1000000"', changeKind: 'ACTION_CONDITION' }, { proposal: { summary: '申請するを 100 万円未満だけにする', details: [{ key: '条件', value: 'amount < "1000000"' }] } });
  const b = await finalOf(plan([same, view()]));
  assert(b.final && FS.readyOf(b) === true && !(b.final.cannot || []).some(x => ['no-values', 'blocked'].includes(x.kind)), `spec の値が今と同じ手順（変更不要）なら、依存する手順も反映でき最終案は反映できる: ${JSON.stringify(FS.readinessOf(b).reasons)}`);
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
