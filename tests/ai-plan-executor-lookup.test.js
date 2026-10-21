// KTPlanExecutor Phase 13: Lookup Preview Executor（既存ルックアップへの取得項目の追加を、コピー先フィールドの追加と合わせて反映・検証・復元）
//
// 検証内容（§43〜§47）:
//   §46 execution: ADD_FIELD ×2 → UPDATE_LOOKUP（順序・依存）/ 既存コピー先の再利用 / picker・絞り込み・並び順 / 完全保持（参照元・キー・既存取得項目・表示名・必須）
//        verification: fieldMappings / existingMappingsPreserved / added / destinationExists / sourceFieldsExist / searchMode（SERVER_MANAGED）/ 既存取得項目を落とす mutant
//        actualAfter.updatedLookups / 監査の crossApp（反映した後の照合・再解析は 2026-10-21 に廃止。判定は手順ごとの読み戻し）
//   §19 cross-app stale: 参照元のフィールド定義が変わった → STALE_PLAN（LOOKUP_RELATED_APP_CHANGED）/ revision だけ → 警告 / 参照元が読めない → BLOCKED・lookup null
//        identity: prepare → 実行の間にルックアップ設定が変わった → TARGET_CHANGED / 取得項目の削除・参照元の変更は計画のみ
//   §47 rollback: RESTORE_LOOKUP_SETTINGS が DELETE_FIELD より先 → snapshot と完全一致 / 反映後の第三者変更 → ROLLBACK_STALE / 参照元の変化は警告のみ
//
// 実行方法: node tests/ai-plan-executor-lookup.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { KTDeps, KTPlanReview, KTPlanExecutor } = loadToolkit();
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const E = KTPlanExecutor, R = KTPlanReview;

const clone = (v) => JSON.parse(JSON.stringify(v));
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], changeKind: null, assigneeType: null, addMappings: [], addPickerFields: [], ...o });
const step = (id, actionType, targetKind, targetRef, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PREVIEW_SUPPORTED', supported: true, reason: 'x' }, ...extra });
const pf = (temporaryId, label, suggestedCode, type, extra = {}) => ({ temporaryId, label, suggestedCode, type, typeValid: true, required: false, options: [], reason: '', evidenceIds: [], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false, ...extra });
const plan = (steps, proposedFields = [], extra = {}) => ({ planVersion: '1', requestId: 'tk-p13', goal: 'g', assessment: { summary: '' }, relevantFields: [], proposedFields, steps, alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', ...extra });

const DATA = FX.makeData();
const DEPS = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
const withFields = (extra) => { const d = FX.makeData(); Object.assign(d.fields, extra); return d; };
const reviewOf = (p, data = DATA) => R.review({ plan: p, data, deps: data === DATA ? DEPS : KTDeps.buildDependencyData(data, KTDeps.normalizeFields(data.fields)), scan: null, incoming: null });
const approveAll = (p, rv) => R.executorOutput(p, rv, p.steps.map(s => s.id));
async function flow(p, mock, { data = DATA, between = null, betweenRollback = null, skipRollback = false, afterExec = null, approved = null } = {}) {
  const rv = reviewOf(p, data);
  const prepared = await E.prepare(approved ? R.executorOutput(p, rv, approved) : approveAll(p, rv), { api: mock.api, appId: '310' });
  if (between && prepared.status === 'PREPARED') between(prepared);
  const log = prepared.status === 'PREPARED' ? await E.executePreview(prepared, { api: mock.api, review: rv }) : null;
  if (afterExec && log) afterExec(log, prepared);
  const rb = log && !skipRollback ? await E.prepareRollback(log, prepared, { api: mock.api }) : null;
  if (rb && betweenRollback) betweenRollback(rb);
  const rolled = rb && rb.status === 'PREPARED' ? await E.executeRollback(rb, { api: mock.api, execution: log }) : null;
  return { rv, prepared, log, rb, rolled };
}
const lkOf = (mock) => clone(mock.st.fields.customer_lookup.lookup);
const check = (log, i, name) => log.steps[i].verification?.checks?.find(c => c.name === name);
/** 代表ユースケース（§0）: 顧客マスタの 住所 / 与信枠 を新規 2 フィールドへ取得（コピー先の追加 → 取得項目の追加） */
const ADD_TWO = () => plan([
  step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'SINGLE_LINE_TEXT' }),
  step('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_2', { fieldType: 'NUMBER' }),
  step('P3', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', { addMappings: [{ relatedField: 'address', field: 'NEW_FIELD_1' }, { relatedField: 'credit', field: 'NEW_FIELD_2' }] }, { dependsOn: ['P1', 'P2'] }),
], [pf('NEW_FIELD_1', '顧客住所', 'customer_address', 'SINGLE_LINE_TEXT'), pf('NEW_FIELD_2', '与信枠', 'customer_credit', 'NUMBER')]);

(async () => {
console.log('\n--- 1. §46 代表ユースケース: ADD_FIELD ×2 → UPDATE_LOOKUP（完全保持・検証）---');
{
  const p = ADD_TWO(); const mock = makeKintoneMock(DATA); const before = lkOf(mock);
  const { rv, prepared, log } = await flow(p, mock, { skipRollback: true });
  const r3 = rv.steps.find(r => r.stepId === 'P3');
  assert(r3.status === 'VALID' && r3.safety === 'REVIEW_REQUIRED' && r3.diff.target.identity.related.appId === '500' && rv.steps.filter(r => r.crossApp).map(r => r.stepId).join() === 'P3' && r3.crossApp.appId === '500', '前提: Review は P3 を REVIEW_REQUIRED・identity と手順の crossApp に参照元の指紋');
  assert(prepared.status === 'PREPARED' && prepared.steps.every(s => s.status === 'PENDING') && mock.calls.includes('GET app fields') && mock.calls.includes('GET app') && prepared.snapshot.relatedApps['500'].name === '顧客マスタ', 'prepare: 3 step とも PENDING・参照元アプリの定義を read-only で再取得（snapshot.relatedApps）');
  assert(prepared.crossApp.length === 1 && prepared.crossApp[0].appId === '500' && prepared.crossApp[0].current.fieldsHash === prepared.crossApp[0].reviewed.fieldsHash && prepared.crossApp[0].current.revision === '21' && prepared.stale.status === 'FRESH', 'prepare: 参照元の指紋（revision / fieldsHash）が Review 時点と一致 → FRESH');
  const pp = prepared.steps[2].prepared;
  assert(pp.payload.code === 'customer_lookup' && !('relatedApp' in pp.payload.lookup) && !('relatedKeyField' in pp.payload.lookup) && pp.payload.lookup.fieldMappings.length === 4 && pp.payload.lookup.fieldMappings[0].field === 'customer_code' && pp.payload.lookup.fieldMappings[2].relatedField === 'address' && pp.payload.lookup.lookupPickerFields.join() === 'code,name' && pp.expect.addedMappings.length === 2 && /参照元 App 500「顧客マスタ」/.test(pp.summary) && pp.crossApp.reviewed.fieldsHash, 'prepare: payload は「現在の取得項目 ＋ 承認分」の完全な lookup（relatedApp / relatedKeyField は送らない。picker はそのまま）');
  assert(log.status === 'DONE' && log.steps.every(s => s.status === 'VERIFIED') && mock.calls.filter(c => c === 'PUT fields').length === 1 && mock.calls.filter(c => c === 'POST fields').length === 2 && log.steps[2].requests[0].lookupKeys.join() === 'mappings', '反映: フィールド追加 2 回 → ルックアップ PUT 1 回、全 step VERIFIED');
  const now = lkOf(mock);
  assert(now.relatedApp.app === '500' && now.relatedKeyField === 'code' && now.fieldMappings.length === 4 && JSON.stringify(now.fieldMappings.slice(0, 2)) === JSON.stringify(before.fieldMappings) && now.fieldMappings[2].field === 'customer_address' && now.fieldMappings[3].relatedField === 'credit' && now.lookupPickerFields.join() === 'code,name' && now.filterCond === '' && now.sort === '' && mock.st.fields.customer_lookup.label === '顧客マスタ参照' && mock.st.fields.customer_lookup.type === 'SINGLE_LINE_TEXT', '完全保持: 参照元・キー・既存 2 項目・picker・絞り込み・並び順・表示名・型はそのまま、取得項目が 4 件');
  assert(mock.st.fields.customer_address.type === 'SINGLE_LINE_TEXT' && mock.st.fields.customer_credit.type === 'NUMBER', 'コピー先 2 フィールドが追加されている（型は参照元と互換）');
  const v = log.steps[2].verification;
  assert(v.ok && ['exists', 'isLookup', 'typePreserved', 'relatedAppPreserved', 'relatedKeyFieldPreserved', 'fieldMappings', 'existingMappingsPreserved', 'added:customer_address', 'added:customer_credit', 'destinationExists:customer_address', 'lookupPickerFields', 'filterCond', 'sort', 'otherPropertiesPreserved', 'otherFieldsPreserved', 'sourceFieldsExist', 'relatedKeyExists', 'relatedAppFingerprint', 'searchMode'].every(n => v.checks.find(c => c.name === n)?.ok) && v.coverage.searchMode === 'SEARCH_MODE_SERVER_MANAGED' && /API では読めない/.test(v.checks.find(c => c.name === 'searchMode').note), 'verification: 取得項目 / 既存保持 / 追加分 / コピー先実在 / 参照元の取得元が存在 / 検索方法は SERVER_MANAGED（検証対象外と明記）');
  assert(!('simulation' in log) && !('reanalysis' in log), '書いた内容の判定は手順ごとの読み戻しだけ（照合・再解析の記録は無い。反映した後の依存関係は画面が取り直す作業の基準が持つ。2026-10-21）');
  assert(log.actualAfter.updatedLookups.join() === '顧客マスタ参照' && log.actualAfter.addedFields.join() === 'customer_address,customer_credit' && log.crossApp[0].appId === '500', 'actualAfter.updatedLookups・log.crossApp');
  const audit = E.buildAudit({ plan: p, review: rv, prepared, execution: log });
  assert(audit.crossApp[0].appId === '500' && audit.crossApp[0].reviewed.fieldsHash && audit.crossApp[0].current.fieldsHash && audit.beforeAfter.some(x => x.stepId === 'P3' && x.before.mappings.length === 2 && x.after.mappings.length === 4) && !JSON.stringify(audit).includes('"records"'), '監査 JSON: crossApp（参照元の ID / 名前 / 指紋）・取得項目の before / after・レコードデータは含まない');
  const plan1 = E.buildRollbackPlan(log, prepared);
  assert(plan1.steps.map(s => s.actionType).join() === 'RESTORE_LOOKUP_SETTINGS,DELETE_FIELD,DELETE_FIELD' && plan1.steps[0].target === 'customer_lookup' && plan1.steps[0].api.payload.properties.customer_lookup.lookup.fieldMappings.length === 2, 'rollback 計画: ルックアップの復元（snapshot の 2 項目）が先、コピー先フィールドの削除が後');
  const rb = await E.prepareRollback(log, prepared, { api: mock.api });
  assert(rb.status === 'PREPARED' && rb.steps.every(s => s.status === 'ROLLBACK_PENDING') && rb.warnings.length === 0, 'rollback 準備: 3 手順とも PENDING（参照元の警告なし）');
  const rolled = await E.executeRollback(rb, { api: mock.api, execution: log });
  assert(rolled.status === 'ROLLED_BACK_VERIFIED' && rolled.steps.every(s => s.status === 'ROLLBACK_VERIFIED') && rolled.verification.restoredToSnapshot === true && JSON.stringify(lkOf(mock)) === JSON.stringify(before) && !mock.st.fields.customer_address && !mock.st.fields.customer_credit && log.lifecycle === 'ROLLED_BACK_VERIFIED', 'rollback: 取得項目が 2 件に戻り、追加したフィールドも消え、snapshot と完全一致');
}

console.log('\n--- 2. §46 既存コピー先の再利用 / picker・絞り込み・並び順 ---');
{
  const data = withFields({ customer_address: { type: 'SINGLE_LINE_TEXT', code: 'customer_address', label: '顧客住所' } });
  const p = plan([step('P1', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', { addMappings: [{ relatedField: 'address', field: 'customer_address' }] })]);
  const mock = makeKintoneMock(data);
  const { log, rolled } = await flow(p, mock, { data });
  assert(log.status === 'DONE' && log.steps[0].status === 'VERIFIED' && mock.calls.filter(c => c === 'POST fields').length === 0 && rolled.status === 'ROLLED_BACK_VERIFIED' && lkOf(mock).fieldMappings.length === 2 && mock.st.fields.customer_address, '既存フィールドをコピー先に: 追加なしで PUT 1 回 → 復元で取得項目だけ戻る（既存フィールドは残る）');
  const p2 = plan([step('P1', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', { addPickerFields: ['address', 'rank'], filterCond: 'rank in ("A") and credit >= "100"', sort: 'name asc' })]);
  const mock2 = makeKintoneMock(DATA);
  let mid2 = null;
  const { rv: rv2, prepared: pr2, log: log2, rolled: rolled2 } = await flow(p2, mock2, { afterExec: () => { mid2 = lkOf(mock2); } });
  assert(rv2.steps[0].status === 'NEEDS_CONFIRMATION' && pr2.steps[0].prepared.payload.changes.join() === 'pickerFields,filterCond,sort' && pr2.steps[0].prepared.condition === 'rank in ("A") and credit >= "100"' && pr2.steps[0].prepared.sensitive.some(x => x.code === 'LOOKUP_FILTER_CHANGE'), 'prepare: picker / 絞り込み / 並び順の変更（絞り込みは sensitive）');
  assert(log2.status === 'DONE' && mid2.lookupPickerFields.join() === 'code,name,address,rank' && mid2.filterCond === 'rank in ("A") and credit >= "100"' && mid2.sort === 'name asc' && mid2.fieldMappings.length === 2 && mid2.relatedApp.app === '500' && check(log2, 0, 'lookupPickerFields').ok && check(log2, 0, 'filterCond').ok && check(log2, 0, 'sort').ok, '反映: picker に 2 件追加・絞り込み・並び順。取得項目・参照元は不変');
  assert(rolled2.status === 'ROLLED_BACK_VERIFIED' && lkOf(mock2).lookupPickerFields.join() === 'code,name' && lkOf(mock2).filterCond === '' && lkOf(mock2).sort === '', 'rollback: picker / 絞り込み / 並び順が元に戻る');
  // 絞り込みがこのアプリのフィールドで書かれている → Review INVALID → 実行対象にならない
  const bad = reviewOf(plan([step('P1', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', { filterCond: 'customer_code = "A"' })]));
  const prBad = await E.prepare(approveAll(plan([step('P1', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', { filterCond: 'customer_code = "A"' })]), bad), { api: makeKintoneMock(DATA).api, appId: '310' });
  assert(bad.steps[0].status === 'INVALID' && bad.steps[0].issues.some(i => i.code === 'LOOKUP_FILTER_FIELD_UNKNOWN') && prBad.status === 'BLOCKED' && prBad.steps[0].status !== 'PENDING', '参照元に無いフィールドの絞り込み: Review が INVALID（承認対象にならない）→ Executor は実行しない');
}

console.log('\n--- 3. verification mutant ---');
{
  const p = ADD_TWO(); const mock = makeKintoneMock(DATA);
  mock.ctl.mutateLookup = (lk) => ({ ...lk, fieldMappings: lk.fieldMappings.filter(m => m.field !== 'case_name') });   // 既存の取得項目を 1 件落とす
  const { log } = await flow(p, mock, { skipRollback: true });
  assert(log.status === 'PARTIAL' && log.steps[2].status === 'VERIFY_FAILED' && !check(log, 2, 'fieldMappings').ok && !check(log, 2, 'existingMappingsPreserved').ok && check(log, 2, 'added:customer_address').ok, '既存取得項目が落ちる mutant: VERIFY_FAILED（fieldMappings / existingMappingsPreserved）');
  assert(lkOf(mock).fieldMappings.length === 3 && !lkOf(mock).fieldMappings.some(m => m.field === 'case_name'), '（mutant の結果: 既存の case_name が落ちた状態が残る → VERIFY_FAILED は rollback の対象）');
}

console.log('\n--- 4. §19 cross-app stale / identity / 参照元が読めない ---');
{
  // 参照元のフィールド定義が Review 後に変わった（住所がテーブル内へ移動した想定: フィールドが 1 つ消える）
  const p = ADD_TWO(); const mock = makeKintoneMock(DATA);
  delete mock.st.relatedApps['500'].fields.memo; mock.st.relatedApps['500'].revision = '22';
  const { prepared } = await flow(p, mock);
  assert(prepared.status === 'BLOCKED' && prepared.blockers.some(b => b.code === 'STALE_PLAN') && prepared.stale.diffs.some(d => d.kind === 'RELATED_APP' && d.code === 'LOOKUP_RELATED_APP_CHANGED' && /顧客マスタ/.test(d.message) && /21 → 22/.test(d.message)) && prepared.crossApp[0].current.fieldsHash !== prepared.crossApp[0].reviewed.fieldsHash, '参照元のフィールド定義が変わった → STALE_PLAN（LOOKUP_RELATED_APP_CHANGED・revision 21 → 22）');
  // revision だけ変わった（参照元の一覧や通知の変更）: フィールド定義は同じ → 警告のみ・実行できる
  const mock2 = makeKintoneMock(DATA); mock2.st.relatedApps['500'].revision = '23';
  const { prepared: pr2, log: log2 } = await flow(p, mock2, { skipRollback: true });
  assert(pr2.status === 'PREPARED' && pr2.steps[2].warnings?.some(w => w.code === 'RELATED_APP_REVISION_CHANGED') && log2.status === 'DONE', '参照元の revision だけ変わった → 警告（RELATED_APP_REVISION_CHANGED）・実行はできる');
  // 参照元が読めない（権限なし）: Review 時点は読めていた → preview の lookup は null → stale（RELATED_APP_SETTINGS_UNAVAILABLE）
  const mock3 = makeKintoneMock(DATA); mock3.ctl.relatedUnavailable = '500';
  const { prepared: pr3 } = await flow(p, mock3);
  assert(pr3.status === 'BLOCKED' && pr3.stale.diffs.some(d => d.code === 'RELATED_APP_SETTINGS_UNAVAILABLE') && pr3.steps[2].status === 'BLOCKED' && pr3.steps[2].reason === 'REVIEW_BLOCKED' && /参照元アプリへのアクセス権を確認してください/.test(pr3.steps[2].message) && pr3.crossApp[0].current.available === false, '参照元アプリへのアクセス権が無い → ルックアップ設定が読めない → 取り直した設定に対する計画の検査が止める（REVIEW_BLOCKED・推測しない）');
  // identity: prepare → 実行の間にルックアップ設定が変わった（取得項目を手で足した）→ TARGET_CHANGED
  const mock4 = makeKintoneMock(DATA);
  const { log: log4 } = await flow(p, mock4, { skipRollback: true, between: () => { mock4.st.fields.customer_lookup.lookup.fieldMappings.push({ field: 'secret_memo', relatedField: 'memo' }); } });   // revision は変えない（revision 不一致より前に identity で止まることを見る）
  assert(log4.status === 'PARTIAL' && log4.steps[2].status === 'FAILED' && log4.steps[2].reason === 'TARGET_CHANGED' && /fieldMappings/.test(log4.steps[2].error.message) && lkOf(mock4).fieldMappings.length === 3, 'prepare → 実行の間に取得項目が変わった → TARGET_CHANGED（PUT しない。先行 ADD_FIELD は残る = 部分状態を記録）');
  assert(log4.steps[0].status === 'VERIFIED' && E.buildRollbackPlan(log4, (await E.prepare(approveAll(p, reviewOf(p)), { api: makeKintoneMock(DATA).api, appId: '310' }))).steps.length === 2, '非アトミック: 失敗時の rollback 計画は反映済みの ADD_FIELD 2 件だけ');
  //   2026-10-21: handler は変更の組を計画の検査の lookupChanges から作る（前後の差から組み直さない）。参照元・キーの変更は計画の検査が計画のみにする（handler に来ない）
  const idn = { kind: 'LOOKUP', code: 'customer_lookup', type: 'SINGLE_LINE_TEXT', relatedApp: { app: '500', code: '' }, relatedKeyField: 'code', mappings: [{ from: 'code', to: 'customer_code' }, { from: 'name', to: 'case_name' }], pickerFields: ['code', 'name'], filterCond: '', sort: '', related: { appId: '500', name: '顧客マスタ', revision: '21', fieldsHash: 'x' } };
  const lkB = { app: '500', code: '', keyField: 'code', mappings: [{ from: 'code', to: 'customer_code' }, { from: 'name', to: 'case_name' }], pickerFields: ['code', 'name'], filterCond: '', sort: '' };
  const mk = (after, lc) => E.HANDLERS.UPDATE_LOOKUP.prepare({}, { stepReview: { diff: { before: { code: 'customer_lookup', label: 'x', lookup: lkB }, after: { code: 'customer_lookup', label: 'x', lookup: after }, ...(lc ? { lookupChanges: lc } : {}), target: { identity: idn } }, issues: [] } });
  const NONE = { mappings: [], pickerFields: [], filterCond: null, sort: null };
  const addOne = { ...lkB, mappings: [...lkB.mappings, { from: 'address', to: 'customer_address' }] };
  const pa = mk(addOne, { ...NONE, mappings: [{ from: 'address', to: 'customer_address' }] });
  assert(mk(lkB, NONE).unsupported === 'NO_CHANGE' && mk(lkB, null).unsupported === 'NO_LOOKUP_SPEC' && !pa.unsupported && pa.payload.lookup.fieldMappings.length === 3 && pa.expect.addedMappings.length === 1 && pa.payload.changes.join() === 'mappings'
    && mk({ ...lkB, sort: 'code' }, { ...NONE, sort: { from: '', to: 'code' } }).unsupported === 'INVALID_SORT',
    'handler: 変更の組は計画の検査の lookupChanges（変更なしは NO_CHANGE・組が無ければ作らない・取得項目の追加は完全な取得項目で送る）。並び順の形は書き込みの条件として handler が止める');
  const keyChange = plan([step('P1', 'UPDATE_LOOKUP', 'FIELD', 'customer_lookup', { keyField: 'name' })]);
  const rvK = reviewOf(keyChange), clK = E.classifySteps(approveAll(keyChange, rvK));
  assert(rvK.steps[0].safety === 'PLAN_ONLY' && rvK.steps[0].issues.some(i => i.code === 'LOOKUP_KEY_CHANGE') && clK[0].status === 'UNSUPPORTED' && clK[0].reason === 'PLAN_ONLY', 'キーの変更: 計画の検査が計画のみにする（handler で参照元・キーの変更を探さない）');
  // コピー先が未承認の ADD_FIELD に依存 → P3 は BLOCKED（依存）
  const { prepared: pr5 } = await flow(p, makeKintoneMock(DATA), { approved: ['P3'] });
  assert(pr5.steps[2].status === 'BLOCKED' && pr5.steps[2].reason === 'DEPENDENCY_NOT_EXECUTABLE', 'コピー先を追加する step が承認されていない → UPDATE_LOOKUP は BLOCKED（依存）');
}

console.log('\n--- 5. §47 rollback stale / 参照元の変化 / 部分復元 ---');
{
  // 反映後に人間がルックアップの絞り込みを変えた → RESTORE_LOOKUP_SETTINGS は ROLLBACK_STALE（第三者の変更を消さない）
  const p = ADD_TWO(); const mock = makeKintoneMock(DATA);
  const { log, rb } = await flow(p, mock, { afterExec: () => { mock.st.fields.customer_lookup.lookup.filterCond = 'rank in ("A")'; mock.st.revision += 1; } });
  assert(log.status === 'DONE' && rb.status === 'BLOCKED' && rb.blockers.some(b => b.code === 'ROLLBACK_STALE') && rb.steps[0].status === 'ROLLBACK_STALE' && rb.steps[0].reason === 'FIELD_CHANGED' && rb.steps[0].diffs[0].kind === 'LOOKUP' && lkOf(mock).fieldMappings.length === 4, '反映後にルックアップの絞り込みが変えられた → ROLLBACK_STALE（戻さない）');
  // 参照元のフィールド定義が反映後に変わった → 警告のみで復元は進む
  const mock2 = makeKintoneMock(DATA);
  const { rb: rb2, rolled: rolled2 } = await flow(p, mock2, { afterExec: () => { mock2.st.relatedApps['500'].fields.extra = { type: 'SINGLE_LINE_TEXT', code: 'extra', label: 'x' }; mock2.st.relatedApps['500'].revision = '30'; } });
  assert(rb2.blockers.length === 0 && rb2.warnings.some(w => w.code === 'RELATED_APP_CHANGED_SINCE_EXECUTION') && rolled2.status === 'ROLLED_BACK_VERIFIED', '参照元の定義が反映後に変わった → 警告（RELATED_APP_CHANGED_SINCE_EXECUTION）・復元は実行できる');
  // 参照元から実行前の取得元が消えた → kintone が PUT を拒否 → ROLLBACK_FAILED（再試行なし）・後続の削除は止まる（部分復元なし）
  const mock3 = makeKintoneMock(DATA);
  const { rolled: rolled3 } = await flow(p, mock3, { afterExec: () => { delete mock3.st.relatedApps['500'].fields.name; } });
  assert(rolled3.status === 'ROLLBACK_FAILED' && rolled3.steps[0].status === 'ROLLBACK_FAILED' && rolled3.steps[0].reason === 'API_ERROR' && rolled3.steps[1].status === 'ROLLBACK_SKIPPED' && rolled3.partial === false && rolled3.message === '元に戻せませんでした。', '実行前の取得元が参照元から消えた → PUT 拒否 → ROLLBACK_FAILED・以降停止');
  // 先行手順が戻した後の状態で参照を見る: ルックアップ復元 → コピー先の参照が消える → DELETE_FIELD が通る（順序が逆なら FIELD_REFERENCED）
  const mock4 = makeKintoneMock(DATA);
  const { log: log4, rb: rb4 } = await flow(p, mock4, { betweenRollback: null });
  assert(rb4.steps[1].actionType === 'DELETE_FIELD' && rb4.steps[1].status === 'ROLLBACK_VERIFIED' && rb4.steps[0].status === 'ROLLBACK_VERIFIED' && log4.lifecycle === 'ROLLED_BACK_VERIFIED', 'ルックアップを先に戻すので、コピー先フィールドは参照されていない状態で削除できる');
  const refCheck = E.ROLLBACK_STRATEGIES.DELETE_FIELD.check({ current: { fields: { properties: { customer_address: { type: 'SINGLE_LINE_TEXT', code: 'customer_address' }, customer_lookup: { type: 'SINGLE_LINE_TEXT', code: 'customer_lookup', label: '顧客マスタ参照', lookup: { relatedApp: { app: '500' }, relatedKeyField: 'code', fieldMappings: [{ field: 'customer_address', relatedField: 'address' }] } } } }, views: { views: {} } }, expected: { fields: { properties: { customer_address: { type: 'SINGLE_LINE_TEXT', code: 'customer_address' } } } }, snapshot: { fields: { properties: {} } }, step: { target: 'customer_address' } });
  assert(refCheck.ok === false && refCheck.code === 'FIELD_REFERENCED' && /ルックアップ「顧客マスタ参照」/.test(refCheck.message), 'ルックアップがまだコピー先を参照していれば DELETE_FIELD は止まる（FIELD_REFERENCED）');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
