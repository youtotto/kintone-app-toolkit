// Phase 20 受け入れテストで見つかった不具合の回帰テスト（実機 staging の P20 専用アプリで再現したものを fixture で固定する）
//
// 検証内容:
//   F1 文書: 計画のある会話では、どの種類のドキュメントでも Markdown / JSON に変更の記録（手順・状態・確認事項・運用環境は未反映）を入れる。Context が運用環境の設定であることを明記
//   F2 復元: リマインダーを一度も設定していないアプリ（timezone null）で ADD_REMINDER → 復元しても ROLLBACK_VERIFIED（timezone は API で null に戻せない）。復元の失敗は作業状態で「要確認」
//   F3 反映の可否: 承認の前に手順ごとの「自動で反映できるか」（KTPlanExecutor.applyReadiness）。ルックアップのコピー先の新規リンクは取得元のリンクの種類を引き継いで追加できる
//   F4 / F5 Code Review: error を '' で消す（kintone は null だけ）・同じ show / change イベントで error と disabled / value を設定（kintone が取り消す）を BLOCKED
//   F7 相談: 相談開始時に取得した本文を Planner Context と Review に使う（Scanner がキャッシュ復元で本文なしでも「未取得」と言わない）
//   GM-6 / FR-9: 会話を切り替えた後に遅れて返った応答・エラーを新しい会話に入れない。新しい相談を始めると送信中の要求を中断する
//   U2 / U3: 利用者向けの文言に Executor / Tier を出さない・最終確認に未回答の確認事項を出す
//
// 実行方法: node tests/ai-acceptance-p20.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const { KTDeps, KTScan, KTContext, KTContextUi, KTAiClient, KTAiConversation, KTAiWorkspaceViewModel: VM, KTAiChatUi, KTPlanReview, KTPlanExecutor, KTCodeReview, mountAiWorkspace } = loadToolkit();
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');

const clone = (v) => JSON.parse(JSON.stringify(v));
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], addMappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
const step = (id, actionType, targetKind, targetRef, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PREVIEW_SUPPORTED', supported: true, reason: 'x' }, ...extra });
const pf = (temporaryId, label, suggestedCode, type, extra = {}) => ({ temporaryId, label, suggestedCode, type, typeValid: true, required: false, options: [], reason: '', evidenceIds: [], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false, ...extra });
const plan = (steps, proposedFields = [], extra = {}) => ({ planVersion: '1', requestId: 'tk-p20', goal: 'g', assessment: { summary: '' }, relevantFields: [], proposedFields, steps, alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', solution: 'STANDARD', customizations: [], ...extra });
const DATA = FX.makeData();
const DEPS = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
const reviewOf = (p, data = DATA) => KTPlanReview.review({ plan: p, data, deps: data === DATA ? DEPS : null, scan: null, incoming: null });

(async () => {
// =========================================================
console.log('\n--- F4 / F5. KTCodeReview: kintone のエラー表示の作法（実機 BF-C の生成コードと同じ形）---');
{
  const DEAL_LOCK = [
    "(function () {",
    "  'use strict';",
    "  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {",
    "    var record = event.record;",
    "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {",
    "      record['amount'].disabled = true;",
    "    }",
    "    return event;",
    "  });",
    "})();",
  ].join('\n');
  // 実機（P20 案件・見積管理 / BF-C v2）で生成されたパッチと同じ構造: 補助関数 checkAmountWarning を show の既存 handler から呼び、change でも使う。消すときは ''
  const WARN_FN = [
    "  function checkAmountWarning(event) {",
    "    var amountField = event.record['amount'];",
    "    if (amountField.value > 1000000) {",
    "      amountField.error = '金額が100万円を超えています。';",
    "    } else {",
    "      amountField.error = '';",
    "    }",
    "    return event;",
    "  }",
  ].join('\n');
  const BAD = DEAL_LOCK.replace("  kintone.events.on(['app.record.create.show'", WARN_FN + "\n  kintone.events.on(['app.record.create.show'").replace("    return event;\n  });\n})();", "    return checkAmountWarning(event);\n  });\n  kintone.events.on(['app.record.create.change.amount', 'app.record.edit.change.amount'], checkAmountWarning);\n})();");
  const ops = KTCodeReview.kintoneFieldOps(KTScan.stripCommentsOnly(BAD));
  const show = ops.find(o => o.events.includes('app.record.edit.show')), change = ops.find(o => o.events.includes('app.record.edit.change.amount'));
  assert(show && show.error && show.emptyErrorClear && show.disabled && change && change.error && !change.disabled, 'kintoneFieldOps: handler が呼ぶ補助関数（1 段）と名前付き handler を展開して error / disabled を見る');
  const custom = { customizationId: 'C1', requirement: '金額が100万円を超えたら警告', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], events: ['app.record.create.show', 'app.record.edit.show', 'app.record.create.change.amount', 'app.record.edit.change.amount'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [{ name: 'dealLock.js', target: 'desktop' }] };
  const gen = (code) => ({ strategy: 'NEW_JS_FILE', targetFile: 'warn.js', code, patch: null, events: custom.events, fields: custom.fields, apis: [] });
  const rv = KTCodeReview.review({ generated: gen(BAD), customization: { ...custom, strategy: 'NEW_JS_FILE' }, plan: null, data: DATA, scan: null, existingSource: null });
  const chk = (r, n) => r.checks.find(c => c.name === n) || null;
  assert(rv.status === 'BLOCKED' && chk(rv, 'error-clear') && !chk(rv, 'error-clear').ok && /null/.test(chk(rv, 'error-clear').message), "F4: error を '' で消すコード → BLOCKED（error-clear。kintone は null を設定したときだけ消える）");
  assert(chk(rv, 'error-cancels-edit') && !chk(rv, 'error-cancels-edit').ok && /app\.record\.edit\.show: error と disabled/.test(chk(rv, 'error-cancels-edit').message) && !/change\.amount: error/.test(chk(rv, 'error-cancels-edit').message), 'F5: 同じ show イベントで error と disabled → BLOCKED（error-cancels-edit）。change だけで error を出すのは対象外');
  // 直したコード: 消すのは null、警告は change だけ（show の disabled と重ねない）
  const GOOD = DEAL_LOCK.replace("})();", "  kintone.events.on(['app.record.create.change.amount', 'app.record.edit.change.amount'], function (event) {\n    var f = event.record['amount'];\n    f.error = Number(f.value || 0) > 1000000 ? '金額が100万円を超えています。' : null;\n    return event;\n  });\n})();");
  const ok = KTCodeReview.review({ generated: gen(GOOD), customization: { ...custom, strategy: 'NEW_JS_FILE' }, plan: null, data: DATA, scan: null, existingSource: null });
  assert(chk(ok, 'error-clear').ok && chk(ok, 'error-cancels-edit').ok, '直したコード（null で消す・警告は change だけ）は 2 つの検査を通る');
  // 保存時（submit）の検証: エラーで保存自体が止まるので、error と value の組み合わせは対象外
  const SUBMIT = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.create.submit'], function (event) {\n    var r = event.record;\n    if (!r['amount'].value) { r['amount'].error = '金額を入力してください'; } else { r['case_name'].value = r['case_name'].value || '（無題）'; }\n    return event;\n  });\n})();";
  const sub = KTCodeReview.review({ generated: { strategy: 'NEW_JS_FILE', targetFile: 'v.js', code: SUBMIT, patch: null, events: ['app.record.create.submit'], fields: [{ code: 'amount', access: 'CONTROL' }, { code: 'case_name', access: 'WRITE' }], apis: [] }, customization: { ...custom, strategy: 'NEW_JS_FILE', events: ['app.record.create.submit'], fields: [{ code: 'amount', access: 'CONTROL' }, { code: 'case_name', access: 'WRITE' }] }, plan: null, data: DATA, scan: null, existingSource: null });
  assert(chk(sub, 'error-cancels-edit').ok, 'submit の error と value は error-cancels-edit の対象外（保存が止まるだけ）');
  const none = KTCodeReview.review({ generated: gen(DEAL_LOCK), customization: { ...custom, strategy: 'NEW_JS_FILE' }, plan: null, data: DATA, scan: null, existingSource: null });
  assert(!chk(none, 'error-clear') && !chk(none, 'error-cancels-edit'), 'error を使わないコードには 2 つの検査行を出さない（ノイズにしない）');
}

// =========================================================
console.log('\n--- BF-C（再）. スペース要素: 実在するスペースは通す・無いスペースは専用の理由で止める・Generator にスペース一覧を渡す ---');
{
  const SPACE_JS = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.change.amount'], function (event) {\n    var sp = kintone.app.record.getSpaceElement('amount_warning_space');\n    if (!sp) return event;\n    sp.textContent = Number(event.record['amount'].value || 0) > 1000000 ? '金額が100万円を超えています' : '';\n    return event;\n  });\n})();";
  const cust = { customizationId: 'C1', requirement: '金額が100万円を超えたら警告', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.edit.change.amount'], fields: [{ code: 'amount', access: 'READ' }], apis: ['kintone.events.on', 'kintone.app.record.getSpaceElement'], existingFiles: [] };
  const gen = { strategy: 'NEW_JS_FILE', targetFile: 'warn.js', code: SPACE_JS, patch: null, events: cust.events, fields: cust.fields, apis: cust.apis };
  const chk = (r, n) => r.checks.find(c => c.name === n) || null;
  const noSpace = KTCodeReview.review({ generated: gen, customization: cust, plan: null, data: DATA, scan: null, existingSource: null });
  assert(noSpace.status === 'BLOCKED' && chk(noSpace, 'space-element') && !chk(noSpace, 'space-element').ok && /amount_warning_space/.test(chk(noSpace, 'space-element').message) && chk(noSpace, 'fields').ok, 'フォームに無いスペース → space-element で止める（「存在しないフィールド」とは言わない）');
  const withLayout = clone(DATA); withLayout.layout = [{ type: 'ROW', fields: [{ type: 'NUMBER', code: 'amount' }, { type: 'SPACER', elementId: 'amount_warning_space', size: { width: '200' } }] }];
  const ok = KTCodeReview.review({ generated: gen, customization: cust, plan: null, data: withLayout, scan: null, existingSource: null });
  assert(chk(ok, 'space-element').ok && chk(ok, 'fields').ok && ok.status !== 'BLOCKED', 'フォームに実在するスペースは通す（存在しないフィールドと数えない）');
  assert(KTCodeReview.layoutSpaceIds([{ type: 'GROUP', code: 'g', layout: [{ type: 'ROW', fields: [{ type: 'SPACER', elementId: 'inner' }] }] }, { type: 'ROW', fields: [{ type: 'SPACER', elementId: 'top' }, { type: 'LABEL', elementId: 'lbl' }] }]).sort().join() === 'inner,top', 'layoutSpaceIds: グループ内のスペースも・ラベルは含めない');
  const gctx = KTContext.buildGenerator({ customization: cust, plan: null, data: withLayout, deps: null, scan: null });
  assert(Array.isArray(gctx.constraints.spaces) && gctx.constraints.spaces.join() === 'amount_warning_space', 'Generator の Context: constraints.spaces にフォームのスペース要素 ID');
}

// =========================================================
console.log('\n--- F2. 復元: リマインダー未設定（timezone null）のアプリでも ROLLED_BACK_VERIFIED ---');
{
  const data = clone(DATA);
  data.reminderNotify = { notifications: [], timezone: null, revision: '4' };
  const p = plan([step('P1', 'ADD_REMINDER', 'NEW_SETTING', '契約終了30日前通知', { name: '契約終了30日前通知', timingField: 'due_date', daysLater: -30, time: '09:00', targets: ['FIELD_ENTITY:owner'] })]);
  const rv = reviewOf(p, data);
  const mock = makeKintoneMock(data);
  assert(mock.st.timezone === null, '前提: モックも実機と同じく未設定の timezone は null');
  const prepared = await KTPlanExecutor.prepare(KTPlanReview.executorOutput(p, rv, ['P1']), { api: mock.api, appId: '310' });
  const log = await KTPlanExecutor.executePreview(prepared, { api: mock.api, review: rv, data });
  assert(log.status === 'DONE' && mock.st.reminders.length === 1 && mock.st.timezone === 'Asia/Tokyo', '反映: リマインダー 1 件・kintone が既定の timezone を入れる');
  const rb = await KTPlanExecutor.prepareRollback(log, prepared, { api: mock.api });
  const rolled = await KTPlanExecutor.executeRollback(rb, { api: mock.api, execution: log });
  assert(rolled.status === 'ROLLED_BACK_VERIFIED' && rolled.steps[0].status === 'ROLLBACK_VERIFIED' && mock.st.reminders.length === 0 && rolled.verification.restoredToSnapshot === true, 'F2: 通知 0 件に戻れば ROLLED_BACK_VERIFIED（timezone の null → 既定値は差分にしない）');
  // 通知があるときの timezone の違いは従来どおり差分（設定済み同士）
  const data2 = clone(DATA); data2.reminderNotify = { notifications: [], timezone: 'UTC', revision: '4' };
  const mock2 = makeKintoneMock(data2);
  const prep2 = await KTPlanExecutor.prepare(KTPlanReview.executorOutput(p, reviewOf(p, data2), ['P1']), { api: mock2.api, appId: '310' });
  const log2 = await KTPlanExecutor.executePreview(prep2, { api: mock2.api, review: reviewOf(p, data2), data: data2 });
  const rb2 = await KTPlanExecutor.prepareRollback(log2, prep2, { api: mock2.api });
  const rolled2 = await KTPlanExecutor.executeRollback(rb2, { api: mock2.api, execution: log2 });
  assert(rolled2.status === 'ROLLED_BACK_VERIFIED' && mock2.st.timezone === 'UTC', 'timezone が設定済み（UTC）のアプリは snapshot の timezone で戻す');
  // 作業状態: 復元の失敗・検証不一致は「反映済み」と出さない
  const v = { planId: 'p', version: 1, status: 'EXECUTED', plan: p, review: rv };
  const failedRb = { stage: 'rolled-back', execution: { ...log, rollback: { status: 'ROLLBACK_VERIFY_FAILED' } }, rollback: { status: 'ROLLBACK_VERIFY_FAILED' } };
  assert(VM.workspaceState({ version: v, execState: failedRb }).lines.includes('元に戻せず（要確認）'), '作業状態: 復元の検証不一致 → 「元に戻せず（要確認）」（Preview反映済みと出さない）');
  const okRb = { stage: 'rolled-back', execution: { ...log, rollback: { status: 'ROLLED_BACK_VERIFIED' } }, rollback: { status: 'ROLLED_BACK_VERIFIED' } };
  assert(VM.workspaceState({ version: v, execState: okRb }).lines.includes('元に戻し済み'), '作業状態: 復元できた → 「元に戻し済み」');
  const partial = { stage: 'done', execution: { status: 'PARTIAL', steps: [{ stepId: 'P1', status: 'VERIFIED' }, { stepId: 'P2', status: 'FAILED' }] } };
  assert(VM.workspaceState({ version: v, execState: partial }).lines.includes('一部だけ反映（要確認）'), '作業状態: 反映が途中で止まった → 「一部だけ反映（要確認）」');
}

// =========================================================
console.log('\n--- F3. 承認の前の「自動で反映できるか」と、ルックアップのコピー先のリンク型 ---');
{
  // 実機 BF-B と同じ形: 既存ルックアップ customer_lookup（→ App 500）に住所・電話番号（リンク・電話番号）を足す
  const p = plan([
    step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'SINGLE_LINE_TEXT' }),
    step('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_2', { fieldType: 'LINK' }),
    step('P3', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', { sourceApp: '500', keyField: 'code', addMappings: [{ relatedField: 'address', field: 'NEW_FIELD_1' }, { relatedField: 'phone', field: 'NEW_FIELD_2' }] }, { dependsOn: ['P1', 'P2'] }),
  ], [pf('NEW_FIELD_1', '住所', 'address', 'SINGLE_LINE_TEXT'), pf('NEW_FIELD_2', '電話番号', 'phone', 'LINK')]);
  const rv = reviewOf(p);
  const r2 = rv.steps.find(r => r.stepId === 'P2');
  assert(r2.diff.after.protocol === 'CALL' && r2.diff.human.some(l => /リンクの種類: 電話番号（ルックアップの取得元「phone」に合わせる）/.test(l)), 'Review: 新規リンクのコピー先は取得元（phone・電話番号）のリンクの種類を引き継ぐ');
  const ar = KTPlanExecutor.applyReadiness(p, rv);
  assert(ar.length === 3 && ar.every(a => a.apply === 'AUTO'), 'applyReadiness: 3 手順とも自動で反映できる（LINK の種類が決まっている）');
  const mock = makeKintoneMock(DATA);
  const prepared = await KTPlanExecutor.prepare(KTPlanReview.executorOutput(p, rv, ['P1', 'P2', 'P3']), { api: mock.api, appId: '310' });
  const p2 = prepared.steps.find(s => s.stepId === 'P2');
  assert(prepared.status === 'PREPARED' && p2.status === 'PENDING' && p2.prepared.payload.properties.phone.protocol === 'CALL', 'Executor の準備: phone を LINK（CALL）で追加する payload');
  const log = await KTPlanExecutor.executePreview(prepared, { api: mock.api, review: rv, data: DATA });
  const added = mock.st.fields.phone;
  const lk = mock.st.fields.customer_lookup.lookup.fieldMappings.map(m => `${m.relatedField}→${m.field}`);
  assert(log.status === 'DONE' && log.steps.every(s => s.status === 'VERIFIED') && added && added.type === 'LINK' && added.protocol === 'CALL' && lk.includes('address→address') && lk.includes('phone→phone'), '反映: phone（LINK・CALL）を追加し、ルックアップの取得項目に address / phone が入る（3 手順 VERIFIED）');
  assert(log.steps.find(s => s.stepId === 'P2').verification.checks.some(c => c.name === 'protocol' && c.ok), '検証: 追加したリンクの種類（protocol）を再取得で確かめる');
  // 自動で反映できない手順: 種類が決まらないリンク（ルックアップに使わない）・計算フィールド・それに依存する手順
  const p4 = plan([
    step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'LINK' }),
    step('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_2', { fieldType: 'CALC' }),
    step('P3', 'ADD_VIEW', 'NEW_SETTING', '税込一覧', { name: '税込一覧', fields: ['NEW_FIELD_2'] }, { dependsOn: ['P2'] }),
    step('P4', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_3', { fieldType: 'SINGLE_LINE_TEXT' }),
  ], [pf('NEW_FIELD_1', '資料URL', 'doc_url', 'LINK'), pf('NEW_FIELD_2', '税込金額', 'amount_tax', 'CALC'), pf('NEW_FIELD_3', 'メモ2', 'memo2', 'SINGLE_LINE_TEXT')]);
  const rv4 = reviewOf(p4);
  const a4 = new Map(KTPlanExecutor.applyReadiness(p4, rv4).map(a => [a.stepId, a]));
  assert(a4.get('P1').apply === 'MANUAL' && a4.get('P1').reason === 'LINK_PROTOCOL_UNKNOWN', 'リンクの種類が決まらない新規リンク → 自動で反映できない（LINK_PROTOCOL_UNKNOWN）');
  assert(a4.get('P2').apply === 'MANUAL' && a4.get('P2').reason === 'FIELD_TYPE_NOT_SUPPORTED' && !/Executor|Tier/.test(a4.get('P2').message), '計算フィールド → 自動で反映できない（理由の文言に Executor / Tier を出さない）');
  assert(a4.get('P3').apply === 'BLOCKED' && a4.get('P3').reason === 'DEPENDENCY_NOT_EXECUTABLE' && a4.get('P4').apply === 'AUTO', '依存先が反映されない手順 → 反映できない（DEPENDENCY_NOT_EXECUTABLE）。関係ない手順は自動で反映できる');
  const html = KTContextUi.reviewHtml(rv4, p4);
  assert(/id="kt-ai-review-apply"/.test(html) && /できる：1 件（P4）/.test(html) && /できない：3 件（P1, P2, P3）/.test(html), '検証ペイン: 自動反映できる / できない手順の集計（承認の前に分かる）');
  assert((html.match(/class="kt-ai-apply" data-apply="MANUAL"/g) || []).length === 2 && /data-apply="BLOCKED"/.test(html) && /承認しても反映されません/.test(html), '検証ペイン: 手順ごとに「Toolkit からは自動で反映できません — 理由（承認しても反映されません）」');
  const v4 = { planId: 'p4', version: 1, status: 'ACTIVE', plan: p4, review: rv4 };
  assert(VM.reviewSummary(v4).notAuto.join() === 'P1,P2,P3' && /自動で反映できない手順：P1, P2, P3/.test(KTAiChatUi.reviewCardHtml(v4)), '会話の検証カード: 自動で反映できない手順を要約に出す（✓ 実行可能 だけで安心させない）');
}

{
  // 実機 BF-B（2 回目）: 取得項目を mappings（コピー先は新規フィールドの予定コード）で書き、説明文に「address → 新規フィールド customer_address」
  const pR2 = plan([
    step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'SINGLE_LINE_TEXT' }),
    step('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_2', { fieldType: 'LINK' }),
    step('P3', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', { sourceApp: '500', keyField: 'code', mappings: [{ from: 'address', to: 'customer_address' }, { from: 'phone', to: 'customer_phone' }] }, { dependsOn: ['P1', 'P2'], proposal: { summary: '', details: [{ key: '追加取得項目', value: 'address → 新規フィールド customer_address, phone → 新規フィールド customer_phone' }] } }),
  ], [pf('NEW_FIELD_1', '顧客住所', 'customer_address', 'SINGLE_LINE_TEXT'), pf('NEW_FIELD_2', '顧客電話番号', 'customer_phone', 'LINK')]);
  const rvR2 = reviewOf(pR2);
  const p3R2 = rvR2.steps.find(r => r.stepId === 'P3');
  assert(p3R2.status !== 'INVALID' && !p3R2.issues.some(i => i.code === 'LOOKUP_DEST_UNKNOWN' || i.code === 'LOOKUP_SOURCE_ALREADY_MAPPED') && rvR2.simulation.after.fields.customer_lookup.lookup.mappings.filter(m => m.to === 'customer_address' || m.to === 'customer_phone').length === 2, 'BF-B（2 回目）: 構造化した mappings があれば説明文の「新規フィールド X」を二重に取り込まない（コピー先が無いと誤判定しない）');
  assert(KTPlanExecutor.applyReadiness(pR2, rvR2).every(a => a.apply === 'AUTO'), 'BF-B（2 回目）: 3 手順とも自動で反映できる');
}

// =========================================================
console.log('\n--- F1. 文書: 計画のある会話の引継ぎ資料 / 仕様書にも変更の記録と状態 ---');
{
  const p = plan([step('P1', 'ADD_REMINDER', 'NEW_SETTING', '契約終了30日前通知', { name: '契約終了30日前通知', timingField: 'due_date', daysLater: -30, time: '09:00', targets: ['FIELD_ENTITY:owner'] })], [], { goal: '契約終了30日前に担当者へ通知したい', questions: [{ id: 'Q1', question: '通知の送信時間は何時が適切ですか？', reason: '', relatedEvidenceIds: [] }] });
  const rv = reviewOf(p);
  const version = { planId: 'plan_x', version: 1, status: 'EXECUTED', goal: p.goal, plan: p, review: rv, spec: null, createdAt: '2026-10-03T07:22:00Z' };
  const execState = { stage: 'done', execution: { status: 'DONE', executionId: 'ex_1', steps: [{ stepId: 'P1', status: 'VERIFIED' }] } };
  const inputs = { data: DATA, deps: DEPS, scan: null, incoming: null };
  const doc = KTContextUi.generateDocument({ kind: 'handover', inputs, version, execState });
  const md = doc.outputs.markdown;
  assert(doc.ok && /## 変更計画（Toolkit の記録）/.test(md) && /動作テスト環境へ反映済み/.test(md) && /P1: VERIFIED/.test(md) && /通知の送信時間は何時が適切ですか/.test(md) && /運用環境には反映していません/.test(md), 'F1: 引継ぎ資料の Markdown に変更の記録（状態・反映結果・確認事項・運用環境は未反映）');
  assert(/この Context は運用環境の設定（画面を開いた時点）から作っています/.test(md) && /運用環境へ反映したとは書かない/.test(doc.outputs.prompt), 'F1: Context が運用環境の設定であることを明記・Prompt にも「運用環境へ反映したとは書かない」');
  const j = JSON.parse(doc.outputs.json);
  assert(j.document === 'handover' && j.plan && j.planStatus === 'EXECUTED' && j.execution && j.execution.status === 'DONE' && j.execution.environment === 'preview' && j.production.deployed === false && j.contextEnvironment === 'production' && j.context, 'F1: JSON にも計画・状態・動作テスト環境の反映結果・運用環境は未反映');
  const specDoc = KTContextUi.generateDocument({ kind: 'spec', inputs, version });
  assert(/## 変更計画（Toolkit の記録）/.test(specDoc.outputs.markdown), '仕様書など他の種類でも、計画がある会話なら変更の記録を入れる');
  const plain = KTContextUi.generateDocument({ kind: 'handover', inputs, version: null });
  assert(!/変更計画（Toolkit の記録）/.test(plain.outputs.markdown) && !/この Context は運用環境の設定/.test(plain.outputs.markdown) && JSON.parse(plain.outputs.json).contextVersion, '計画の無い会話では従来どおり（骨格 ＋ Context、JSON は Context）');
}

// =========================================================
console.log('\n--- GM-6 / FR-9. 会話の切り替え後に遅れて返った応答 ---');
{
  const seed = { sourceId: 'desktop:js:a.js', name: 'a.js', platform: 'desktop', customizationType: 'FILE', source: { available: true, text: '(function(){})();', hash: 'x' }, counts: {}, analysis: { events: [], fields: {}, fieldAccess: {} } };
  const gateOf = () => { let release, fail; const p = new Promise((res, rej) => { release = res; fail = rej; }); return { p, release, fail }; };
  // 計画
  {
    const g = gateOf();
    const conv = KTAiConversation.create({ services: { plan: async () => { await g.p; return { plan: plan([step('P1', 'ADD_VIEW', 'NEW_SETTING', '古い一覧', { name: '古い一覧' })], [], { goal: '前の会話の goal' }), ctx: null, review: null }; } } });
    const sent = conv.send('承認済みの案件だけの一覧を追加したい');
    await new Promise(r => setTimeout(r, 0));
    conv.startConsultation(seed, { force: true });
    g.release();
    const res = await sent;
    assert(res.discarded === true && res.ok === false && conv.planHistory().length === 0 && !conv.activePlan() && conv.messages().length === 1 && /a\.js について相談します/.test(conv.messages()[0].text) && !conv.isBusy(), 'GM-6: 新しい相談を始めた後に届いた前の会話の計画は登録しない（新しい会話には相談開始のメッセージだけ）');
  }
  // エラー（前の会話の失敗も新しい会話に出さない）
  {
    const g = gateOf();
    const conv = KTAiConversation.create({ services: { ask: async () => { await g.p; return { ok: true, answer: { answer: 'x' } }; } } });
    const sent = conv.send('このフィールドは何に使ってる？');
    await new Promise(r => setTimeout(r, 0));
    conv.startConsultation(seed, { force: true });
    g.fail(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
    const res = await sent;
    assert(res.discarded === true && !conv.messages().some(m => m.type === 'ERROR'), 'FR-9: 前の会話の質問が失敗しても新しい会話にエラーを出さない');
  }
  // 同じ会話のまま遅れて返った応答は従来どおり登録する（世代が同じ）
  {
    const g = gateOf();
    const conv = KTAiConversation.create({ services: { plan: async () => { await g.p; return { plan: plan([step('P1', 'ADD_VIEW', 'NEW_SETTING', '一覧', { name: '一覧' })]), ctx: null, review: null }; } } });
    const sent = conv.send('承認済みの案件だけの一覧を追加したい');
    g.release();
    const res = await sent;
    assert(res.ok && !res.discarded && conv.planHistory().length === 1, '同じ会話の応答はそのまま登録する');
  }
}

// =========================================================
console.log('\n--- F7 / GM-6（UI）. 相談: 取得済みの本文を Context と Review に使う・新しい相談で送信中の要求を中断 ---');
{
  const FIELD_ON_OFF = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {\n    var record = event.record;\n    if (record['ステータス'].value === '承認待ち') {\n      record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();";
  const FILES = [{ name: 'fieldOnOff.js', target: 'desktop', kind: 'js', text: FIELD_ON_OFF }];
  const data = FX.makeData();
  data.customize = { scope: 'ALL', desktop: { js: [{ type: 'FILE', file: { contentType: 'text/javascript', fileKey: 'dl:fieldOnOff', name: 'fieldOnOff.js', size: '290' } }], css: [] }, mobile: { js: [], css: [] }, revision: '12' };
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  const fieldRows = fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType }));
  const scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files: FILES, fields: fieldRows, deps });
  scan.results = KTScan.analyze({ fields: fieldRows, files: FILES, snippet: { before: 24, after: 48 } });
  KTDeps.mergeScannerEdges(deps, scan);
  // キャッシュ復元と同じ: 本文（text）が無い
  const cached = { ...scan, files: scan.files.map(f => { const { text, ...rest } = f; return rest; }) };
  const inputs = { data, deps, scan: cached, incoming: null };
  assert(!KTScan.summarizeFiles(cached, data).find(f => f.name === 'fieldOnOff.js').sourceAvailable, '前提: Field Scanner がキャッシュ復元だと本文は無い');
  const storage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const calls = [];
  const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] }, 'customization-generator': { implemented: true, promptVersions: ['1'] } } }, contract: { usage: { usedThisMonth: 1, monthlyLimit: 200 } } };
  const CUST = { customizationId: 'C1', requirement: '承認済では担当者も編集不可', whyStandardInsufficient: 'フィールドのアクセス権はステータスで変えられない', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [{ name: 'fieldOnOff.js', target: 'desktop', reason: '' }], risks: [], questions: [], dependsOn: [], evidenceIds: [] };
  const PLAN_RESP = { ok: true, contractVersion: '2.1', meta: { requestId: 'pl-1', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 200 } }, plan: { goal: '承認済みでは担当者も編集不可', solution: 'CUSTOMIZATION', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], gaps: [], evidenceIds: [] }, relevantFields: [], proposedFields: [], steps: [step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', 'fieldOnOff.js', { customizationId: 'C1' }, { solution: 'CUSTOMIZATION', execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' } })], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', customizations: [CUST] } };
  let gate = null;
  const client = {
    async getHealth() { return HEALTH; },
    async plan({ ctx, requestId, signal }) {
      calls.push({ ctx, signal });
      if (gate) await new Promise((res, rej) => { gate.res = res; if (signal) signal.addEventListener?.('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'CANCELLED' }))); });
      const v = KTAiClient.validatePlan(PLAN_RESP, ctx); if (!v.ok) throw new Error(JSON.stringify(v.errors)); return { ...v.normalized, requestId, clientWarnings: v.warnings };
    },
  };
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner,customization-generator', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const mock = makeKintoneMock(data, { jsSources: FILES });
  const panel = mountAiWorkspace(host, { getInputs: () => inputs, copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow, executor: { api: mock.api, appId: '310' } });
  for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  const seed = KTContext.buildConsultationSeed({ data, deps, scan: cached, file: { name: 'fieldOnOff.js', target: 'desktop', type: 'FILE', fileKey: 'dl:fieldOnOff', size: '290' }, sourceText: FIELD_ON_OFF, appName: '案件管理' });
  panel.consult(seed);
  await panel.send('承認済みでは、金額に加えて担当者も編集できなくしたい');
  const ctx = calls[0].ctx;
  const jsFact = (ctx.facts || []).find(f => f.kind === 'js-file' && f.jsFile && f.jsFile.name === 'fieldOnOff.js');
  assert(jsFact && jsFact.jsFile.sourceAvailable === true && /本文は取得済み/.test(jsFact.statement) && !/本文は未取得/.test(jsFact.statement), 'F7: 相談中のファイルは Planner Context で「本文は取得済み」（キャッシュに本文が無くても）');
  assert(!JSON.stringify(ctx).includes("record['amount'].disabled"), 'F7: 本文そのものは Planner Context に入れない');
  const rvStep = panel.conversation().activePlan().review.steps.find(r => r.stepId === 'C1');
  assert(rvStep && !rvStep.issues.some(i => i.code === 'JS_SOURCE_UNAVAILABLE') && rvStep.codeGeneration.sourceAvailable === true, 'F7: Review も「本文はまだ取得していません」と言わない（codeGeneration.sourceAvailable）');
  // GM-6（UI）: 送信中に別の JS で新しい相談を始めると、送信中の要求を中断し、前の応答を新しい会話に入れない
  gate = {};
  const pending = panel.send('担当者も編集できなくしたい（修正）', { intent: KTAiConversation.INTENT.REVISE_PLAN });
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
  assert(calls.length === 2 && panel.conversation().isBusy(), '前提: 修正の要求を送信中（Planner を呼んで応答待ち）');
  const seed2 = KTContext.buildConsultationSeed({ data, deps, scan: cached, file: { name: 'other.js', target: 'desktop', type: 'FILE', fileKey: 'dl:other', size: '10' }, sourceText: "(function () { 'use strict'; })();", appName: '案件管理' });
  panel.consult(seed2);   // 別の JS → 「戻る / 新しい会話」の選択
  await host.querySelector('#kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act: 'consult-new' } } });
  await pending;
  for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  const last = calls[calls.length - 1];
  assert(last.signal && last.signal.aborted === true, 'GM-6（UI）: 新しい相談を始めると送信中の要求を中断する（AbortSignal）');
  assert(panel.conversation().subject().name === 'other.js' && panel.conversation().planHistory().length === 0 && !panel.conversation().messages().some(m => m.type === 'PLAN' || m.type === 'ERROR' || (m.type === 'SYSTEM_NOTICE' && /キャンセル/.test(m.text))), 'GM-6（UI）: 新しい会話には前の会話の計画・エラー・キャンセル通知が入らない');
}

// =========================================================
console.log('\n--- CX-4（intent）. 「誰も」「いつでも」などの不定の言い方を質問と判定しない ---');
{
  const C = (t) => KTAiConversation.classifyIntent(t, {}).intent;
  assert(C('承認後は誰も金額を変更できないようにして。ただし営業担当はいつでも変更できるようにして') === 'PLAN', '「承認後は誰も…変更できないようにして。…いつでも変更できるようにして」は計画（実機で質問扱いになった）');
  assert(C('誰でも編集できるようにして') === 'PLAN' && C('何も入力しなくても通知されるようにしたい') === 'PLAN' && C('どこでも見られるようにして') === 'PLAN' && C('いつも担当者に通知したい') === 'PLAN', '「誰でも / 何も / どこでも / いつも」を含む依頼は計画');
  assert(C('このフィールドは何に使ってる？') === 'ASK' && C('誰が承認するの') === 'ASK' && C('いつ通知されますか') === 'ASK' && C('通知は何件ある？') === 'ASK' && C('どこで使われている？') === 'ASK', '「何に / 誰が / いつ / 何件 / どこで」の質問は従来どおり質問');
  // XA-4（実機）: 文末の「〜たい / 〜てほしい / 〜てください」は依頼
  assert(C('顧客マスタの電話番号を連絡先電話にも入れたい') === 'PLAN' && C('承認済みの案件だけ一覧に出したいです') === 'PLAN' && C('金額の入力欄を分けてほしい') === 'PLAN' && C('担当者を必須にしてください') === 'PLAN', 'XA-4: 「入れたい / 出したいです / 分けてほしい / してください」は計画（実機で質問扱いになった）');
  assert(C('このアプリの通知の仕組みを知りたい') === 'ASK' && C('どこで金額を使っているか聞きたい') === 'ASK', '「知りたい / 聞きたい」は質問のまま');
  // XA-11（実機）: 計画の語（新規フィールドのラベル）に触れる質問は計画の説明（反映済みの変更を踏まえて答える）
  const planSt = { activePlan: { status: 'EXECUTED', plan: { proposedFields: [{ temporaryId: 'NEW_FIELD_1', label: '住所', suggestedCode: 'address' }, { temporaryId: 'NEW_FIELD_2', label: '電話番号', suggestedCode: 'phone' }], steps: [{ id: 'P3', actionType: 'UPDATE_LOOKUP', targetRef: 'customer_lookup', title: '顧客コードルックアップに住所と電話番号の取得項目を追加' }] } } };
  assert(KTAiConversation.classifyIntent('既存の案件にも住所と電話番号は自動で入りますか？', planSt).intent === 'EXPLAIN_PLAN', 'XA-11: 計画の語を含む質問は EXPLAIN_PLAN（ASK にしない）');
  assert(KTAiConversation.classifyIntent('このアプリの通知先は誰ですか？', planSt).intent === 'ASK', '計画の語を含まない現在の設定の質問は ASK のまま');
  // XA-11: ルックアップの取得項目を足す Review / 最終確認に「既存のレコードの値は自動では入りません」
  const pX = plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'SINGLE_LINE_TEXT' }), step('P2', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', { sourceApp: '500', keyField: 'code', addMappings: [{ relatedField: 'address', field: 'NEW_FIELD_1' }] }, { dependsOn: ['P1'] })], [pf('NEW_FIELD_1', '顧客住所', 'cust_addr', 'SINGLE_LINE_TEXT')]);
  const rX = reviewOf(pX).steps.find(r => r.stepId === 'P2');
  assert(rX.diff.human.some(l => /既存のレコード: 取得項目を足しても、保存済みのレコードの値は自動では入りません/.test(l)), 'XA-11: ルックアップの取得項目を足す手順に、既存レコードは自動では更新されない旨');
}

// =========================================================
console.log('\n--- CX-2a / CX-3 / CX-7. 条件式の in / not in への正規化（AI が繰り返し「ステータス = "承認済み"」と書いた）---');
{
  const { KTQueryCheck } = loadToolkit();
  const F = DATA.fields;
  const n1 = KTQueryCheck.normalize('ステータス = "承認済み"', { fields: F });
  assert(n1.text === 'ステータス in ("承認済み")' && n1.changes.length === 1 && n1.changes[0].from === 'ステータス = "承認済み"', 'ステータス = "承認済み" → ステータス in ("承認済み")');
  const n2 = KTQueryCheck.normalize('owner != LOGINUSER()', { fields: F });
  assert(n2.text === 'owner not in (LOGINUSER())', 'ユーザー選択 != LOGINUSER() → not in (LOGINUSER())');
  const n3 = KTQueryCheck.normalize('ステータス = "承認済み" and amount >= "1000000"', { fields: F });
  assert(n3.text === 'ステータス in ("承認済み") and amount >= "1000000"' && n3.changes.length === 1, '数値の比較はそのまま・ステータスだけ直す');
  assert(KTQueryCheck.normalize('amount = "100"', { fields: F }).changes.length === 0 && KTQueryCheck.normalize('ステータス in ("承認済み")', { fields: F }).changes.length === 0 && KTQueryCheck.normalize('ステータス = ', { fields: F }).changes.length === 0, '= が使える種類・既に in・解釈できない式は触らない');
  assert(KTQueryCheck.check(n1.text, { fields: F, usage: 'perRecordNotification' }).ok, '直した式は kintone の条件として受理される（check）');
  // 画面経由: 計画の受信時に直し、Review の手順に「条件式を直しました」と出す（黙って直さない）
  const storage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] }, 'customization-generator': { implemented: true, promptVersions: ['1'] } } }, contract: { usage: { usedThisMonth: 1, monthlyLimit: 200 } } };
  const RESP = { ok: true, contractVersion: '2.1', meta: { requestId: 'pl-n', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 200 } }, plan: { goal: '承認されたら担当者に通知したい', solution: 'STANDARD', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], gaps: [], evidenceIds: [] }, relevantFields: [], proposedFields: [], steps: [step('P1', 'ADD_NOTIFICATION', 'NEW_SETTING', '承認済み通知', { name: '承認済み通知', filterCond: 'ステータス = "承認済み"', targets: ['FIELD_ENTITY:owner'] })], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', customizations: [] } };
  const client = { async getHealth() { return HEALTH; }, async plan({ ctx, requestId }) { const v = KTAiClient.validatePlan(RESP, ctx); if (!v.ok) throw new Error(JSON.stringify(v.errors)); return { ...v.normalized, requestId, clientWarnings: v.warnings }; } };
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner,customization-generator', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const host = makeFakeHost();
  const panel = mountAiWorkspace(host, { getInputs: () => ({ data: DATA, deps: DEPS, scan: null, incoming: null }), copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false }, executor: { api: makeKintoneMock(DATA).api, appId: '310' } });
  for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  await panel.send('承認されたら担当者に通知したい');
  const v = panel.conversation().activePlan();
  const rP1 = v.review.steps.find(x => x.stepId === 'P1');
  assert(v.plan.steps[0].spec.filterCond === 'ステータス in ("承認済み")' && rP1.issues.some(i => i.code === 'COND_NORMALIZED' && /ステータス = "承認済み" → ステータス in \("承認済み"\)/.test(i.message)) && !rP1.issues.some(i => i.code === 'COND_INVALID'), '受信時に直し、Review の手順に COND_NORMALIZED（直した前後）を出す・COND_INVALID にならない');
  assert(KTPlanExecutor.applyReadiness(v.plan, v.review).find(a => a.stepId === 'P1').apply === 'AUTO', '直した条件で自動反映できる');
}

// =========================================================
console.log('\n--- CX-7. 外部サービス / 外部システムとの連携はコード生成の対象外・案内文 ---');
{
  const cust = { customizationId: 'C1', requirement: '承認済みになったら会計システムに請求データを自動送信する', whyStandardInsufficient: 'kintone標準機能に会計システムへの自動送信機能がないため', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.detail.process.proceed'], fields: [{ code: 'amount', access: 'READ' }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [] };
  const p = plan([step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', '', { customizationId: 'C1' }, { solution: 'CUSTOMIZATION', execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' } })], [], { solution: 'CUSTOMIZATION', customizations: [cust] });
  const rv = reviewOf(p);
  const r = rv.steps.find(x => x.stepId === 'C1');
  assert(r.codeGeneration.supported === false && r.codeGeneration.reason === 'EXTERNAL_INTEGRATION' && r.issues.some(i => i.code === 'JS_EXTERNAL_INTEGRATION' && /会計システム/.test(i.message)), 'CX-7: 会計システムへの送信はコード生成の対象外（EXTERNAL_INTEGRATION）');
  const slack = reviewOf(plan([step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', '', { customizationId: 'C1' }, { solution: 'CUSTOMIZATION' })], [], { solution: 'CUSTOMIZATION', customizations: [{ ...cust, requirement: '承認されたらSlackに通知する', whyStandardInsufficient: '標準の通知はSlackに送れない' }] })).steps[0];
  assert(slack.codeGeneration.supported === false && slack.codeGeneration.reason === 'EXTERNAL_INTEGRATION', 'Slack への通知も対象外');
  const local = reviewOf(plan([step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', '', { customizationId: 'C1' }, { solution: 'CUSTOMIZATION' })], [], { solution: 'CUSTOMIZATION', customizations: [{ ...cust, requirement: '金額が100万円を超えたら警告を表示する', whyStandardInsufficient: '条件付きの画面警告は標準にない', events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }] }] })).steps[0];
  assert(local.codeGeneration.supported === true, '画面内の処理（外部連携の語なし）は従来どおり生成できる');
  const conv = KTAiConversation.create({ services: {} });
  conv.registerPlan({ plan: p, ctx: null, review: rv });
  const intro = conv.messages().find(m => m.data && m.data.kind === 'spec-intro');
  assert(intro && /この内容は Toolkit ではコードを生成できません/.test(intro.text) && !/押すとコードを生成できます/.test(intro.text), '案内: 生成できない項目しか無ければ「コードを生成できます」と言わない');
}

// =========================================================
console.log('\n--- U2 / U3. 文言と最終確認の確認事項 ---');
{
  const p = plan([step('P1', 'ADD_REMINDER', 'NEW_SETTING', '契約終了30日前通知', { name: '契約終了30日前通知', timingField: 'due_date', daysLater: -30, time: '09:00', targets: ['FIELD_ENTITY:owner'] })]);
  const rv = reviewOf(p);
  const mock = makeKintoneMock(DATA);
  const prepared = await KTPlanExecutor.prepare(KTPlanReview.executorOutput(p, rv, ['P1']), { api: mock.api, appId: '310' });
  const confirmHtml = KTContextUi.executorHtml({ stage: 'confirm', prepared, execution: null, classified: KTPlanExecutor.classifySteps(KTPlanReview.executorOutput(p, rv, ['P1'])), available: true, review: rv, questions: ['通知の送信時間は何時が適切ですか？', '通知対象の担当者は tantou_user でよいですか？'] });
  assert(/id="kt-ai-exec-questions"/.test(confirmHtml) && /未回答の確認事項が 2 件あります/.test(confirmHtml) && /通知の送信時間は何時が適切ですか/.test(confirmHtml), 'U3: 最終確認に未回答の確認事項（仮の値のまま反映される）');
  const noQ = KTContextUi.executorHtml({ stage: 'confirm', prepared, execution: null, classified: [], available: true, review: rv, questions: [] });
  assert(!/kt-ai-exec-questions/.test(noQ), '確認事項が無ければ出さない');
  const log = await KTPlanExecutor.executePreview(prepared, { api: mock.api, review: rv, data: DATA });
  const doneHtml = KTContextUi.executorHtml({ stage: 'done', prepared, execution: log, classified: [], available: true, review: rv });
  assert(/運用環境への反映は kintone のアプリ設定画面の［アプリを更新］で行います。Toolkit は運用環境へ反映しません/.test(doneHtml) && !/Executor/.test(doneHtml), 'U2: 結果の文言に Executor を出さない');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
