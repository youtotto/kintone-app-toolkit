// KTPlanExecutor Phase 14: App Action Preview Executor（アプリ間のレコード転記アクションを Preview へ追加・変更・検証・復元）
//
// 検証内容（§41〜§45）:
//   §43 full payload: 既存 3 件 ＋ 追加 / 変更 1 件 → 既存 3 件は bit 単位で保持。既存 1 件が抜ける mutant を検出（VERIFY_FAILED）
//   §44 update: 転記の追加 / 利用者の変更 / 利用条件の変更 / stale（対象・無関係なアクション・コピー先の定義）/ identity（TARGET_CHANGED）
//   §41 destination: コピー先が読めない（destApp null）→ BLOCKED / 定義が変わった → STALE_PLAN（DEST_APP_CHANGED）/ Review 時点で未取得のコピー先を実行直前に取得して検証
//   §45 rollback: ADD → Verify → Rollback → 元の actions / UPDATE → Verify → Rollback → 元の actions / 反映後の第三者変更 → ROLLBACK_STALE
//   re-analysis: 転記元 / 転記先 / コピー先アプリの edge が増える
//
// 実行方法: node tests/ai-plan-executor-app-action.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { KTDeps, KTPlanReview, KTPlanExecutor } = loadToolkit();
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const E = KTPlanExecutor, R = KTPlanReview;

const clone = (v) => JSON.parse(JSON.stringify(v));
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], changeKind: null, assigneeType: null, addMappings: [], addPickerFields: [], actionMappings: [], ...o });
const step = (id, actionType, targetKind, targetRef, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PREVIEW_SUPPORTED', supported: true, reason: 'x' }, ...extra });
const pf = (temporaryId, label, suggestedCode, type, extra = {}) => ({ temporaryId, label, suggestedCode, type, typeValid: true, required: false, options: [], reason: '', evidenceIds: [], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false, ...extra });
const plan = (steps, proposedFields = [], extra = {}) => ({ planVersion: '1', requestId: 'tk-p14', goal: 'g', assessment: { summary: '' }, relevantFields: [], proposedFields, steps, alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', ...extra });

/** 既存アクション 3 件（見積を作成 ＋ 再見積 ＋ 複製）。コピー先はすべて 311 */
function makeData() {
  const d = FX.makeData();
  const base = d.actions.actions['見積を作成'];
  d.actions.actions['再見積'] = { ...clone(base), name: '再見積', id: '5521', index: '1', mappings: [{ srcType: 'FIELD', srcField: 'amount', destField: 'quote_amount' }], entities: [{ type: 'GROUP', code: 'everyone' }], filterCond: 'amount >= "1"' };
  d.actions.actions['複製'] = { ...clone(base), name: '複製', id: '5522', index: '2', mappings: [], entities: [{ type: 'ORGANIZATION', code: 'sales_div' }], filterCond: '' };
  return d;
}
const DATA = makeData();
const DEPS = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
const reviewOf = (p, data = DATA) => R.review({ plan: p, data, deps: data === DATA ? DEPS : KTDeps.buildDependencyData(data, KTDeps.normalizeFields(data.fields)), scan: null, incoming: null });
const approveAll = (p, rv) => R.executorOutput(p, rv, p.steps.map(s => s.id));
async function flow(p, mock, { data = DATA, between = null, betweenRollback = null, skipRollback = false, afterExec = null, approved = null } = {}) {
  const rv = reviewOf(p, data);
  const prepared = await E.prepare(approved ? R.executorOutput(p, rv, approved) : approveAll(p, rv), { api: mock.api, appId: '310' });
  if (between && prepared.status === 'PREPARED') between(prepared);
  const log = prepared.status === 'PREPARED' ? await E.executePreview(prepared, { api: mock.api, review: rv, data }) : null;
  if (afterExec && log) afterExec(log, prepared);
  const rb = log && !skipRollback ? await E.prepareRollback(log, prepared, { api: mock.api }) : null;
  if (rb && betweenRollback) betweenRollback(rb);
  const rolled = rb && rb.status === 'PREPARED' ? await E.executeRollback(rb, { api: mock.api, execution: log }) : null;
  return { rv, prepared, log, rb, rolled };
}
const actsOf = (mock) => clone(mock.st.actions);
const strip = (acts) => Object.fromEntries(Object.entries(acts).map(([k, a]) => { const { id, ...rest } = a; return [k, rest]; }));
const check = (log, i, name) => log.steps[i].verification?.checks?.find(c => c.name === name);
const UPD = (sp = {}, extra = {}) => plan([step('P1', 'UPDATE_APP_ACTION', 'APP_ACTION', '見積を作成', { actionMappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: 'note' }], ...sp }, extra)]);
const ADD = (sp = {}) => plan([step('P1', 'ADD_APP_ACTION', 'APP_ACTION', '請求書作成', { name: '請求書作成', destApp: '311', actionMappings: [{ srcType: 'FIELD', srcField: 'case_name', destField: 'customer' }, { srcType: 'FIELD', srcField: 'amount', destField: 'quote_amount' }, { srcType: 'RECORD_URL', srcField: null, destField: 'source_url' }], entities: ['GROUP:sales_group'], filterCond: 'ステータス in ("承認待ち")', ...sp })]);

(async () => {
console.log('\n--- 1. §43 / §44 UPDATE_APP_ACTION: 転記の追加（既存 3 件の完全保持・検証・再解析）---');
{
  const p = UPD(); const mock = makeKintoneMock(DATA); const before = actsOf(mock);
  const { rv, prepared, log } = await flow(p, mock, { skipRollback: true });
  const r1 = rv.steps[0];
  assert(['VALID', 'WARNING', 'NEEDS_CONFIRMATION'].includes(r1.status) && r1.safety === 'REVIEW_REQUIRED' && r1.diff.target.identity.id === '5520' && r1.diff.target.identity.dest.appId === '311' && r1.crossApp && r1.crossApp.appId === '311' && r1.crossApp.role === 'destination', '前提: Review は REVIEW_REQUIRED・identity に id / 手順の crossApp にコピー先の指紋');
  assert(prepared.status === 'PREPARED' && prepared.steps[0].status === 'PENDING' && mock.calls.includes('GET actions') && mock.calls.includes('GET app fields') && prepared.snapshot.actions && Object.keys(prepared.snapshot.actions.actions).length === 3 && prepared.snapshot.relatedApps['311'].name === '見積管理', 'prepare: 現在の全アクションを snapshot に・コピー先 311 の定義を read-only で再取得');
  assert(prepared.crossApp.length === 1 && prepared.crossApp[0].role === 'destination' && prepared.crossApp[0].current.fieldsHash === prepared.crossApp[0].reviewed.fieldsHash && prepared.stale.status === 'FRESH', 'prepare: コピー先の指紋が Review 時点と一致 → FRESH');
  const pp = prepared.steps[0].prepared;
  assert(pp.payload.name === '見積を作成' && pp.payload.changes.mappings.length === 3 && pp.payload.changes.mappings[2].srcField === 'secret_memo' && !('entities' in pp.payload.changes) && !('filterCond' in pp.payload.changes) && pp.expect.addedMappings.length === 1 && /コピー先 App 311「見積管理」/.test(pp.summary) && pp.crossApp.reviewed.fieldsHash, 'prepare: payload は対象 1 件の転記（既存 ＋ 追加の全件）だけ。他の属性は変更しない');
  assert(log.status === 'DONE' && log.steps[0].status === 'VERIFIED' && mock.calls.filter(c => c === 'PUT actions').length === 1 && log.steps[0].requests[0].total === 3 && log.steps[0].requests[0].changedKeys.join() === 'mappings', '反映: 全 3 件を含む PUT 1 回で VERIFIED');
  const now = actsOf(mock);
  assert(now['見積を作成'].mappings.length === 3 && now['見積を作成'].mappings[2].destField === 'note' && now['見積を作成'].id === '5520' && now['見積を作成'].index === '0' && now['見積を作成'].destApp.app === '311' && JSON.stringify(now['見積を作成'].entities) === JSON.stringify(before['見積を作成'].entities) && JSON.stringify(strip({ a: now['再見積'] })) === JSON.stringify(strip({ a: before['再見積'] })) && JSON.stringify(strip({ a: now['複製'] })) === JSON.stringify(strip({ a: before['複製'] })) && now['再見積'].id === '5521', '完全保持: 対象は転記だけ増え、id / 並び順 / コピー先 / 利用者は不変。他の 2 件は bit 単位で同じ（id も）');
  const v = log.steps[0].verification;
  assert(v.ok && ['existingCountBefore', 'countPreserved', 'otherActionsPreserved', 'unexpectedRemoved', 'unexpectedChanged', 'targetExists', 'destAppPreserved', 'indexPreserved', 'mappingCount', 'existingMappingsPreserved', 'added:note', 'mappings', 'entities', 'filterCond', 'unchangedAttributesPreserved'].every(n => v.checks.find(c => c.name === n)?.ok), 'verification: 件数 / 他アクション保持 / 対象の転記（全件・既存・追加）/ コピー先 / 並び順 / 利用者 / 条件 / 他属性');
  assert(log.simulation.compared && log.simulation.match === true, 'Simulation（Review の After）と実際が一致');
  assert(log.reanalysis.available && log.reanalysis.appActions.length === 1 && log.reanalysis.appActions[0].name === '見積を作成' && log.reanalysis.appActions[0].edgesAfter === log.reanalysis.appActions[0].edgesBefore + 2 && log.reanalysis.appActions[0].newEdges.some(e => e.relationType === 'ACTION_MAPS_FROM' && e.target === 'secret_memo') && log.reanalysis.appActions[0].newEdges.some(e => e.relationType === 'ACTION_MAPS_TO' && e.target === '311:note') && log.reanalysis.appActions[0].destFields.includes('311:note'), '再解析: 転記元（secret_memo）と転記先（311:note）の edge が増えた');
  assert(log.actualAfter.appActions === 3 && log.actualAfter.updatedAppActions.join() === '見積を作成' && log.crossApp[0].appId === '311', 'actualAfter.updatedAppActions・log.crossApp');
  const audit = E.buildAudit({ plan: p, review: rv, prepared, execution: log });
  assert(audit.crossApp[0].role === 'destination' && audit.beforeAfter.some(x => x.stepId === 'P1' && x.before.mappings.length === 2 && x.after.mappings.length === 3) && audit.rollbackPlan.steps[0].actionType === 'RESTORE_APP_ACTION_SETTINGS' && !JSON.stringify(audit).includes('"records"'), '監査 JSON: crossApp（コピー先）・転記の before / after・rollback 計画・レコードデータは含まない');
  const rb = await E.prepareRollback(log, prepared, { api: mock.api });
  const rolled = await E.executeRollback(rb, { api: mock.api, execution: log });
  assert(rolled.status === 'ROLLED_BACK_VERIFIED' && rolled.steps[0].actionType === 'RESTORE_APP_ACTION_SETTINGS' && rolled.verification.restoredToSnapshot === true && JSON.stringify(strip(actsOf(mock))) === JSON.stringify(strip(before)) && mock.calls.filter(c => c === 'PUT actions').length === 2, '§45 rollback: snapshot の全アクションを PUT → 元の 3 件と一致');
}

console.log('\n--- 2. §43 mutant: 既存 1 件が抜ける PUT を検出 ---');
{
  const p = UPD(); const mock = makeKintoneMock(DATA);
  mock.ctl.dropOneExistingOnPut = 'actions';
  const { log } = await flow(p, mock, { skipRollback: true });
  assert(log.status === 'FAILED' && log.steps[0].status === 'VERIFY_FAILED' && !check(log, 0, 'countPreserved').ok && !check(log, 0, 'unexpectedRemoved').ok && check(log, 0, 'unexpectedRemoved').actual === 1 && /countPreserved/.test(log.steps[0].message), '既存アクションが 1 件消える mutant → VERIFY_FAILED（countPreserved / unexpectedRemoved）');
  const mock2 = makeKintoneMock(DATA);
  mock2.ctl.mutateList = (what, list) => { if (what === 'actions') list['複製'].filterCond = 'amount >= "9"'; return list; };
  const { log: log2 } = await flow(p, mock2, { skipRollback: true });
  assert(log2.steps[0].status === 'VERIFY_FAILED' && !check(log2, 0, 'otherActionsPreserved').ok && check(log2, 0, 'otherActionsPreserved').actual.join() === '複製' && !check(log2, 0, 'unexpectedChanged').ok, '無関係なアクションが変わる mutant → VERIFY_FAILED（otherActionsPreserved / unexpectedChanged）');
}

console.log('\n--- 3. ADD_APP_ACTION: 新規アクション（index 末尾・転記 3 件・RECORD_URL・利用者・条件）→ Rollback ---');
{
  const p = ADD(); const mock = makeKintoneMock(DATA); const before = actsOf(mock);
  const { rv, prepared, log, rolled } = await flow(p, mock);
  const r1 = rv.steps[0];
  assert(r1.status === 'NEEDS_CONFIRMATION' && r1.safety === 'REVIEW_REQUIRED' && r1.diff.after.index === '3' && r1.issues.some(i => i.code === 'DEST_REQUIRED_FIELD_UNMAPPED' && i.fields.map(f => f.code).join() === 'quote_title,issue_date'), '前提: Review は index 末尾（3）・必須項目の警告（quote_title / issue_date）');
  const pp = prepared.steps[0].prepared;
  assert(prepared.status === 'PREPARED' && pp.payload.entry.mappings.length === 3 && pp.payload.entry.mappings[2].srcType === 'RECORD_URL' && !('srcField' in pp.payload.entry.mappings[2]) === false && pp.payload.entry.entities[0].code === 'sales_group' && pp.payload.entry.filterCond === 'ステータス in ("承認待ち")' && pp.sensitive.some(x => x.code === 'DEST_REQUIRED_FIELD_UNMAPPED'), 'prepare: 新規 1 件の完全な定義（転記 3 件・RECORD_URL・利用者・条件）・必須項目の警告は sensitive');
  assert(log.status === 'DONE' && log.steps[0].status === 'VERIFIED' && log.steps[0].requests[0].total === 4 && log.steps[0].requests[0].added.join() === '請求書作成', '反映: 既存 3 ＋ 新規 1 = 4 件の PUT 1 回で VERIFIED');
  const mid = log.actualAfterRaw.actions.actions;
  assert(Object.keys(mid).length === 4 && mid['請求書作成'].index === '3' && mid['請求書作成'].destApp.app === '311' && mid['請求書作成'].mappings.length === 3 && mid['請求書作成'].mappings[2].srcType === 'RECORD_URL' && mid['請求書作成'].mappings[2].destField === 'source_url' && mid['請求書作成'].entities[0].type === 'GROUP' && mid['請求書作成'].id && JSON.stringify(strip({ a: mid['見積を作成'] })) === JSON.stringify(strip({ a: before['見積を作成'] })), '反映直後: 新規アクションは末尾・id 採番・RECORD_URL 転記。既存 3 件は同じ');
  const v = log.steps[0].verification;
  assert(v.ok && ['countPreserved', 'existingActionsPreserved', 'unexpectedRemoved', 'unexpectedChanged', 'targetExists', 'destAppPreserved', 'requestedMappingsExist', 'entities', 'filterCond', 'index'].every(n => v.checks.find(c => c.name === n)?.ok) && log.simulation.match === true && log.reanalysis.appActions[0].name === '請求書作成' && log.reanalysis.appActions[0].edgesAfter === 6 && log.actualAfter.addedAppActions.join() === '請求書作成', 'verification / Simulation 一致 / 再解析（転記元 2 ＋ 転記先 3 ＋ コピー先 1 = 6 edge）');
  assert(rolled.status === 'ROLLED_BACK_VERIFIED' && JSON.stringify(strip(actsOf(mock))) === JSON.stringify(strip(before)) && !actsOf(mock)['請求書作成'], '§45 rollback: 追加したアクションが消え、元の 3 件に戻る');
  // ADD で同名が既にある（prepare 後に人間が作った）→ TARGET_EXISTS
  const mock2 = makeKintoneMock(DATA);
  const { log: log2 } = await flow(p, mock2, { skipRollback: true, between: () => { mock2.st.actions['請求書作成'] = { ...clone(mock2.st.actions['複製']), name: '請求書作成', id: '7777', index: '3' }; } });
  assert(log2.steps[0].status === 'FAILED' && log2.steps[0].reason === 'TARGET_EXISTS' && mock2.calls.filter(c => c === 'PUT actions').length === 0, 'prepare 後に同名アクションが作られた → TARGET_EXISTS（PUT しない）');
}

console.log('\n--- 4. §44 利用者 / 利用条件の変更・計画のみ ---');
{
  const mock = makeKintoneMock(DATA);
  const { rv, prepared, log, rolled } = await flow(plan([step('P1', 'UPDATE_APP_ACTION', 'APP_ACTION', '見積を作成', { entities: ['GROUP:sales_group', 'ORGANIZATION:sales_div'], filterCond: 'ステータス in ("承認待ち")' })]), mock);
  assert(rv.steps[0].status === 'NEEDS_CONFIRMATION' && rv.steps[0].issues.some(i => i.code === 'APP_ACTION_ENTITIES_REMOVED') && prepared.steps[0].prepared.payload.changes.entities.length === 2 && prepared.steps[0].prepared.payload.changes.filterCond === 'ステータス in ("承認待ち")' && !('mappings' in prepared.steps[0].prepared.payload.changes) && prepared.steps[0].prepared.sensitive.some(x => x.code === 'APP_ACTION_ENTITIES_REMOVED'), 'prepare: 利用者と条件だけ変更（転記は送らない）・利用者の削除は sensitive');
  assert(log.status === 'DONE' && log.steps[0].status === 'VERIFIED' && log.actualAfterRaw.actions.actions['見積を作成'].entities.map(e => e.code).join() === 'sales_group,sales_div' && log.actualAfterRaw.actions.actions['見積を作成'].filterCond === 'ステータス in ("承認待ち")' && log.actualAfterRaw.actions.actions['見積を作成'].mappings.length === 2 && check(log, 0, 'entities').ok && check(log, 0, 'filterCond').ok, '反映: 利用者 / 条件が変わり転記は不変');
  assert(rolled.status === 'ROLLED_BACK_VERIFIED' && actsOf(mock)['見積を作成'].entities.map(e => e.code).join() === 'user1,sales_group' && actsOf(mock)['見積を作成'].filterCond === '', 'rollback: 利用者 / 条件が元に戻る');
  //   2026-10-21: handler は変更の組を計画の検査の appActionChanges から作る（前後の差から組み直さない）。組が無ければ作らない（NO_APP_ACTION_SPEC）
  const mk = (after, before, ch) => E.HANDLERS.UPDATE_APP_ACTION.prepare({}, { stepReview: { diff: { before, after, ...(ch ? { appActionChanges: ch } : {}), target: { identity: { kind: 'APP_ACTION', id: '5520', name: before.name, index: '0', destApp: before.destApp, mappings: before.mappings, entities: before.entities, filterCond: before.filterCond, dest: { appId: '311', name: '見積管理', revision: '7', fieldsHash: 'x' } } } }, issues: [] } });
  const b0 = R.appActionView(R.buildBeforeModel(DATA).appActions[0]);
  const NONE = { mappings: [], entities: null, filterCond: null };
  const withMap = { ...b0, mappings: [...b0.mappings, { srcType: 'FIELD', srcField: 'secret_memo', destField: 'note' }] };
  const pm = mk(withMap, b0, { ...NONE, mappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: 'note' }] });
  assert(mk(b0, b0, NONE).unsupported === 'NO_CHANGE' && mk(b0, b0, null).unsupported === 'NO_APP_ACTION_SPEC' && !pm.unsupported && JSON.stringify(pm.payload.changes.mappings) === JSON.stringify(withMap.mappings.map(m => ({ srcType: m.srcType, srcField: m.srcType === 'RECORD_URL' ? null : m.srcField, destField: m.destField }))) && pm.expect.addedMappings.length === 1,
    'handler: 変更の組は計画の検査の appActionChanges（変更なしは NO_CHANGE・組が無ければ作らない・転記の追加は完全な転記の一覧で送る）');
  //   名前・コピー先の変更は計画の検査が計画のみにする（handler に来ない）
  const rvRen = reviewOf(plan([step('P1', 'UPDATE_APP_ACTION', 'APP_ACTION', '見積を作成', { name: '見積書作成', filterCond: 'amount >= "1"' })]));
  const clRen = E.classifySteps(approveAll(plan([step('P1', 'UPDATE_APP_ACTION', 'APP_ACTION', '見積を作成', { name: '見積書作成', filterCond: 'amount >= "1"' })]), rvRen));
  assert(rvRen.steps[0].safety === 'PLAN_ONLY' && rvRen.steps[0].issues.some(i => i.code === 'APP_ACTION_RENAME') && clRen[0].status === 'UNSUPPORTED' && clRen[0].reason === 'PLAN_ONLY', '名前の変更: 計画の検査が計画のみにする（handler で名前の変更を探さない）');
}

console.log('\n--- 5. §41 / §44 stale: 対象・無関係なアクション・コピー先の定義・コピー先が読めない ---');
{
  const p = UPD();
  const mock = makeKintoneMock(DATA); mock.st.actions['複製'].filterCond = 'amount >= "100"';   // 無関係なアクションを人間が変えた（全体置換 API なので stale）
  const { prepared } = await flow(p, mock);
  assert(prepared.status === 'BLOCKED' && prepared.blockers.some(b => b.code === 'STALE_PLAN') && prepared.stale.diffs.some(d => d.kind === 'APP_ACTION' && d.id === '複製' && d.change === 'CHANGED'), '無関係なアクションの変更 → STALE_PLAN（全体置換なので他のアクションも stale 対象）');
  const mock2 = makeKintoneMock(DATA); mock2.st.actions['見積を作成'].mappings.push({ srcType: 'FIELD', srcField: 'amount', destField: 'quote_amount' });
  const { prepared: pr2 } = await flow(p, mock2);
  assert(pr2.status === 'BLOCKED' && pr2.stale.diffs.some(d => d.kind === 'APP_ACTION' && d.id === '見積を作成'), '対象アクションの変更 → STALE_PLAN');
  const mock3 = makeKintoneMock(DATA); delete mock3.st.relatedApps['311'].fields.note; mock3.st.relatedApps['311'].revision = '8';
  const { prepared: pr3 } = await flow(p, mock3);
  assert(pr3.status === 'BLOCKED' && pr3.stale.diffs.some(d => d.code === 'DEST_APP_CHANGED' && /コピー先 App 311「見積管理」/.test(d.message)) && pr3.steps[0].status === 'BLOCKED' && pr3.steps[0].reason === 'REVIEW_BLOCKED' && /転記先「[^」]+」はコピー先 App 311/.test(pr3.steps[0].message), 'コピー先の定義が変わった（転記先が消えた）→ STALE_PLAN（DEST_APP_CHANGED）＋ 取り直した設定に対する計画の検査が転記先なしで止める（REVIEW_BLOCKED）');
  const mock4 = makeKintoneMock(DATA); mock4.st.relatedApps['311'].revision = '9';
  const { prepared: pr4, log: log4 } = await flow(p, mock4, { skipRollback: true });
  assert(pr4.status === 'PREPARED' && pr4.steps[0].warnings?.some(w => w.code === 'RELATED_APP_REVISION_CHANGED') && log4.status === 'DONE', 'コピー先の revision だけ変わった → 警告・実行できる');
  const mock5 = makeKintoneMock(DATA); mock5.ctl.destUnavailable = '311';
  const { prepared: pr5 } = await flow(p, mock5);
  assert(pr5.status === 'BLOCKED' && pr5.steps[0].status === 'BLOCKED' && pr5.steps[0].reason === 'REVIEW_BLOCKED' && /コピー先アプリの設定を kintone が返しません/.test(pr5.steps[0].message) && pr5.stale.diffs.some(d => d.kind === 'APP_ACTION'), 'コピー先アプリへの権限が無い（destApp null）→ 取り直した設定に対する計画の検査が止める（REVIEW_BLOCKED・推測しない）');
  // identity: prepare → 実行の間に対象が変わった → TARGET_CHANGED
  const mock6 = makeKintoneMock(DATA);
  const { log: log6 } = await flow(p, mock6, { skipRollback: true, between: () => { mock6.st.actions['見積を作成'].filterCond = 'amount >= "5"'; } });
  assert(log6.status === 'FAILED' && log6.steps[0].status === 'FAILED' && log6.steps[0].reason === 'TARGET_CHANGED' && /filterCond/.test(log6.steps[0].error.message) && mock6.calls.filter(c => c === 'PUT actions').length === 0, 'prepare → 実行の間に対象の条件が変わった → TARGET_CHANGED（PUT しない）');
  const mock7 = makeKintoneMock(DATA);
  const { log: log7 } = await flow(p, mock7, { skipRollback: true, between: () => { mock7.st.actions['複製'].entities = []; } });
  assert(log7.steps[0].status === 'FAILED' && log7.steps[0].reason === 'TARGET_CHANGED' && /sincePrepare|確認時点/.test(log7.steps[0].error.message), 'prepare → 実行の間に無関係なアクションが変わった → TARGET_CHANGED（全体置換なので他も bit 比較）');
}

console.log('\n--- 6. §41 Review 時点で未取得のコピー先: 実行直前に取得して検証（DEST_APP_NOT_LOADED） ---');
{
  // 311 を prefetch していない DATA（既存アクションも無い）で、311 へ新規アクション → Review は DEST_APP_NOT_LOADED（要確認）→ Executor が 311 を取得して検証
  const data = FX.makeData(); delete data.relatedApps['311']; data.actions = { actions: {}, revision: '12' };
  const p = plan([step('P1', 'ADD_APP_ACTION', 'APP_ACTION', '請求書作成', { name: '請求書作成', destApp: '311', actionMappings: [{ srcType: 'FIELD', srcField: 'case_name', destField: 'customer' }], entities: ['GROUP:everyone'] })]);
  const mock = makeKintoneMock({ ...data, relatedApps: FX.makeData().relatedApps });   // kintone 側には 311 が存在する
  const { rv, prepared, log, rolled } = await flow(p, mock, { data });
  assert(rv.steps[0].issues.some(i => i.code === 'DEST_APP_NOT_LOADED') && rv.steps[0].safety === 'REVIEW_REQUIRED' && rv.steps[0].crossApp.available === false, 'Review: コピー先 311 は未取得 → DEST_APP_NOT_LOADED（要確認・推測しない）');
  assert(prepared.status === 'PREPARED' && prepared.freshReviewSteps.join() === 'P1' && prepared.crossApp[0].fetchedAtPrepare === true && prepared.crossApp[0].current.available === true && prepared.steps[0].prepared.sensitive.some(x => x.code === 'DEST_REQUIRED_FIELD_UNMAPPED'), 'prepare: 311 を取得して再 Review した結果で準備（必須項目の警告が実行直前に出る）');
  assert(log.status === 'DONE' && log.steps[0].status === 'VERIFIED' && log.simulation.match === true && rolled.status === 'ROLLED_BACK_VERIFIED' && Object.keys(actsOf(mock)).length === 0, '反映 → 検証 → Simulation 一致（再 Review の After）→ rollback で元の 0 件');
  const data2 = FX.makeData(); delete data2.relatedApps['311']; data2.actions = { actions: {}, revision: '12' };
  const p2 = plan([step('P1', 'ADD_APP_ACTION', 'APP_ACTION', '請求書作成', { name: '請求書作成', destApp: '311', actionMappings: [{ srcType: 'FIELD', srcField: 'amount', destField: 'customer' }], entities: ['GROUP:everyone'] })]);
  const mock2 = makeKintoneMock({ ...data2, relatedApps: FX.makeData().relatedApps });
  const { prepared: pr2 } = await flow(p2, mock2, { data: data2 });
  assert(pr2.status === 'BLOCKED' && pr2.steps[0].status === 'BLOCKED' && pr2.steps[0].reason === 'REVIEW_BLOCKED', '取得後の再 Review で型不一致（数値 → 文字列）→ BLOCKED（Review 時点では分からなかった不備を実行前に止める）');
}

console.log('\n--- 7. §45 rollback stale ---');
{
  const p = UPD(); const mock = makeKintoneMock(DATA);
  const { log, rb } = await flow(p, mock, { afterExec: () => { mock.st.actions['再見積'].filterCond = 'amount >= "2"'; mock.st.revision += 1; } });
  assert(log.status === 'DONE' && rb.status === 'BLOCKED' && rb.blockers.some(b => b.code === 'ROLLBACK_STALE') && rb.steps[0].status === 'ROLLBACK_STALE' && rb.steps[0].reason === 'THIRD_PARTY_CHANGE' && rb.steps[0].diffs.some(d => d.kind === 'APP_ACTION' && d.id === '再見積') && actsOf(mock)['見積を作成'].mappings.length === 3, '反映後に無関係なアクションが変えられた → ROLLBACK_STALE（第三者の変更を snapshot で上書きしない）');
  const mock2 = makeKintoneMock(DATA);
  const { rb: rb2 } = await flow(p, mock2, { afterExec: () => { mock2.st.actions['見積を作成'].entities = []; } });
  assert(rb2.status === 'BLOCKED' && rb2.steps[0].status === 'ROLLBACK_STALE', '反映後に対象アクションが変えられた → ROLLBACK_STALE');
  // ADD_FIELD → UPDATE_APP_ACTION（新規フィールドを転記元に）: rollback はアクション復元 → フィールド削除の順（参照が消えてから削除）
  const p3 = plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'MULTI_LINE_TEXT' }), step('P2', 'UPDATE_APP_ACTION', 'APP_ACTION', '見積を作成', { actionMappings: [{ srcType: 'FIELD', srcField: 'NEW_FIELD_1', destField: 'note' }] }, { dependsOn: ['P1'] })], [pf('NEW_FIELD_1', '備考', 'remarks', 'MULTI_LINE_TEXT')]);
  const mock3 = makeKintoneMock(DATA);
  const { log: log3, rb: rb3, rolled: rolled3 } = await flow(p3, mock3);
  assert(log3.status === 'DONE' && log3.steps.every(s => s.status === 'VERIFIED') && rb3.steps.map(s => s.actionType).join() === 'RESTORE_APP_ACTION_SETTINGS,DELETE_FIELD' && rolled3.status === 'ROLLED_BACK_VERIFIED' && !mock3.st.fields.remarks && actsOf(mock3)['見積を作成'].mappings.length === 2, 'cross-category: アクションを先に戻し、転記元の参照が消えてから新規フィールドを削除');
  const refCheck = E.fieldReferences('secret_memo', { fields: { properties: {} }, views: { views: {} }, actions: { actions: { '見積を作成': { mappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: 'note' }], filterCond: '' } } } });
  assert(refCheck.length === 1 && refCheck[0].kind === 'APP_ACTION' && /転記元/.test(refCheck[0].where), 'fieldReferences: アプリアクションの転記元を参照として数える');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
