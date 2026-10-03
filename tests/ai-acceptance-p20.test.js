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
//   FR-1 / FR-2 / FR-6 / FR-7: 計画の要求のタイムアウト・不完全な応答・Gateway の MODEL_OUTPUT_INVALID で計画を登録せず入力を残す。
//     送信中の再クリックで要求を重ねない。再試行で計画が 1 件だけ登録される（実際の AI client と transport を通す）
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
console.log('\n--- BF-C（再 3）/ F24. エラー表示と編集不可: 条件で分けたコードは要確認・別 handler / 別ファイルも見る（実機の生成コード 2 本）---');
{
  const DEAL_LOCK = "(function () {\n  'use strict';\n  // 承認済みの案件は金額を変更できないようにする（既存の運用ルール）\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {\n    var record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();";
  // 1 本目（実機: 承認済み・1,000,001 で金額が編集できるようになった）: 別 handler で、条件なしに error を設定
  const SEPARATE = DEAL_LOCK.replace("})();", "  // 金額が100万円を超えたら警告を表示する\n  function checkAmountWarning(event) {\n    var record = event.record;\n    if (record['amount']) {\n      record['amount'].error = (record['amount'].value > 1000000) ? '100万円を超えています' : null;\n    }\n    return event;\n  }\n\n  kintone.events.on([\n    'app.record.create.show',\n    'app.record.edit.show',\n    'app.record.create.change.amount',\n    'app.record.edit.change.amount'\n  ], checkAmountWarning);\n})();");
  // 2 本目（実機: 承認済みは編集不可のまま・警告なし。編集できるときだけ警告）: disabled を読む条件で分け、編集不可なら null
  const GUARDED = "(function () {\n  'use strict';\n  // 金額が100万円超なら警告表示（承認済みかつ編集不可なら非表示）\n  function checkAmountWarning(event) {\n    var record = event.record;\n    var amount = record['amount'].value;\n    var status = record['ステータス'] ? record['ステータス'].value : '';\n    var disabled = record['amount'].disabled;\n    if (amount > 1000000 && !(status === '承認済み' && disabled)) {\n      record['amount'].error = '100万円を超えています';\n    } else {\n      record['amount'].error = null;\n    }\n    return event;\n  }\n\n  // 画面表示時の処理に警告表示を追加\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function(event) {\n    var record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    return checkAmountWarning(event);\n  });\n\n  // 金額変更時の警告表示更新\n  kintone.events.on(['app.record.create.change.amount', 'app.record.edit.change.amount'], checkAmountWarning);\n})();\n";
  const ops = KTCodeReview.kintoneFieldOps(KTScan.stripCommentsOnly(GUARDED));
  assert(ops.find(o => o.events.includes('app.record.edit.show')).errorGuarded === true && KTCodeReview.kintoneFieldOps(KTScan.stripCommentsOnly(SEPARATE)).every(o => !o.errorGuarded), 'kintoneFieldOps: disabled を読む条件の中だけで error を出すコードは errorGuarded（条件なしの別 handler は guarded ではない）');
  const custom = { customizationId: 'C1', requirement: '金額が100万円を超えたら警告', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.create.show', 'app.record.edit.show', 'app.record.create.change.amount', 'app.record.edit.change.amount'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [] };
  const gen = (code) => ({ strategy: 'NEW_JS_FILE', targetFile: 'warn.js', code, patch: null, events: custom.events, fields: custom.fields, apis: [] });
  const chk = (r, n) => r.checks.find(c => c.name === n) || null;
  const rSep = KTCodeReview.review({ generated: gen(SEPARATE), customization: custom, plan: null, data: DATA, scan: null, existingSource: null });
  assert(rSep.status === 'BLOCKED' && chk(rSep, 'error-cancels-edit').severity === 'block' && /別の handler で設定したものも/.test(chk(rSep, 'error-cancels-edit').message), 'F5（実機 1 本目）: 別 handler でも条件なしに同じ表示イベントで error → 停止（kintone が編集不可を取り消す）');
  const rGuard = KTCodeReview.review({ generated: gen(GUARDED), customization: custom, plan: null, data: DATA, scan: null, existingSource: null });
  assert(rGuard.status !== 'BLOCKED' && chk(rGuard, 'error-cancels-edit').ok === false && chk(rGuard, 'error-cancels-edit').severity === 'review' && /動作テスト環境/.test(chk(rGuard, 'error-cancels-edit').message), 'F24（実機 2 本目）: 編集不可を見る条件で分けたコードは停止しない（要確認・動作テストで確かめる）');
  // 別ファイル: 新規 JS が条件なしに show で error、既存の dealLock.js が同じ show で disabled → 要確認（以前は同じファイルの中しか見ず見逃していた）
  const WARN_ONLY = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show', 'app.record.edit.change.amount'], function (event) {\n    var f = event.record['amount'];\n    f.error = Number(f.value || 0) > 1000000 ? '100万円を超えています' : null;\n    return event;\n  });\n})();";
  const data2 = FX.makeData();
  data2.customize = { scope: 'ALL', desktop: { js: [{ type: 'FILE', file: { contentType: 'text/javascript', fileKey: 'dl:lock', name: 'dealLock.js', size: '422' } }], css: [] }, mobile: { js: [], css: [] }, revision: '5' };
  const fieldsN = KTDeps.normalizeFields(data2.fields);
  const deps2 = KTDeps.buildDependencyData(data2, fieldsN);
  const FILES = [{ name: 'dealLock.js', target: 'desktop', kind: 'js', text: DEAL_LOCK }];
  const scan2 = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files: FILES, fields: fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType })), deps: deps2 });
  const rOther = KTCodeReview.review({ generated: gen(WARN_ONLY), customization: custom, plan: null, data: data2, scan: scan2, existingSource: null });
  assert(chk(rOther, 'error-cancels-other-js') && chk(rOther, 'error-cancels-other-js').severity === 'review' && /dealLock\.js（app\.record\.create\.show, app\.record\.edit\.show）/.test(chk(rOther, 'error-cancels-other-js').message) && !/change\.amount/.test(chk(rOther, 'error-cancels-other-js').message), '別ファイル: 既存の dealLock.js が同じ表示イベントで disabled → こちらの error が取り消すことを要確認で示す（change は対象外）');
  const rOtherOk = KTCodeReview.review({ generated: gen(WARN_ONLY.replace("'app.record.create.show', 'app.record.edit.show', ", '')), customization: { ...custom, events: ['app.record.edit.change.amount'] }, plan: null, data: data2, scan: scan2, existingSource: null });
  assert(!chk(rOtherOk, 'error-cancels-other-js'), '警告が値の変更時だけなら、他ファイルの show の disabled とは重ならない');
  // BF-C 4 回目（実機の生成そのまま）: 既存の show handler の中に「編集不可でないときだけ警告」を追加。計画の change は登録していない
  const DL_SRC = "(function () {\n  'use strict';\n  // 承認済みの案件は金額を変更できないようにする（既存の運用ルール）\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {\n    var record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();\n";
  const PATCH4 = { baseHash: KTScan.hashText(DL_SRC), operations: [{ type: 'INSERT_AFTER', anchor: "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }", content: "\n    // 金額が100万円を超えたら警告を表示する\n    if (record['amount'].value > 1000000 && !record['amount'].disabled) {\n      record['amount'].error = '金額が100万円を超えています。';\n    } else {\n      record['amount'].error = null;\n    }\n" }] };
  const cust4 = { ...custom, strategy: 'EXTEND_EXISTING_JS', existingFiles: [{ name: 'dealLock.js', target: 'desktop' }] };
  const r4 = KTCodeReview.review({ generated: { strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', summary: 's', code: PATCH4.operations[0].content, patch: PATCH4, events: custom.events, fields: custom.fields, apis: ['kintone.events.on'] }, customization: cust4, plan: null, data: DATA, scan: null, existingSource: { name: 'dealLock.js', target: 'desktop', text: DL_SRC } });
  assert(chk(r4, 'patch').ok && chk(r4, 'error-cancels-edit').severity === 'review' && !chk(r4, 'plan-consistency').ok && /入力中に切り替わりません/.test(chk(r4, 'plan-consistency').message) && r4.status === 'REVIEW_REQUIRED', 'F26（BF-C 4 回目）: 計画の change をコードが登録していない → 計画との不一致（要確認）。以前は「軽微な差」で合格扱い');
  assert(chk(r4, 'duplicate-handler').ok, '既存の handler の中に追加しただけなら「別の handler を足す」と言わない');
  // F27（BF-C 4 回目）: 「C1 のコードを作り直して。金額を変更したときにも…」の後半は生成に渡らない → 黙って捨てず、仕様を直すか今の仕様のまま作るかを選ぶ
  {
    const E = KTAiConversation.extraRequestIn;
    assert(/金額を変更したときにも警告が切り替わるように/.test(E('C1 のコードを作り直して。金額を変更したときにも警告が切り替わるようにしてください') || '') && !E('コードを作って') && !E('C1 のコードを作って') && !E('dealLock.js のコードを作り直して') && !E('JavaScript を生成して') && !E('コードを作ってください'), 'extraRequestIn: 生成の言い回し・対象・語尾を除いて要望が残るときだけ返す');
    let gens = 0;
    const conv = KTAiConversation.create({ services: { generate: async () => { gens++; return { ok: true, generated: { code: '' }, review: { status: 'PASSED' } }; } } });
    const cp = plan([step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', '', { customizationId: 'C1' }, { solution: 'CUSTOMIZATION', execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' } })], [], { solution: 'CUSTOMIZATION', customizations: [{ customizationId: 'C1', requirement: '金額が100万円を超えたら金額の下に警告', whyStandardInsufficient: '標準設定に無い', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.create.show', 'app.record.edit.show', 'app.record.create.change.amount', 'app.record.edit.change.amount'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [] }] });
    const v = conv.registerPlan({ plan: cp, ctx: null, review: reviewOf(cp) });
    conv.confirmSpec({ planId: v.planId, version: v.version });
    await conv.send('C1 のコードを作り直して。金額を変更したときにも警告が切り替わるようにしてください');
    const ask = conv.messages().find(x => x.data && x.data.kind === 'generate-extra-choices');
    assert(gens === 0 && ask && /仕様に入っていない/.test(ask.text) && ask.data.reviseText && ask.data.generateText === 'C1 のコードを作って', 'F27: 要望付きの生成の指示 → まだ生成せず「仕様を直してから作る / 今の仕様のまま作る」を聞く');
    await conv.send('C1 のコードを作って', { intentOverride: 'GENERATE_CODE' });
    assert(gens === 1, '［今の仕様のまま作る］（選んだ後）は聞き直さずに生成する');
    // U6: JS の登録が検証で一致しない（VERIFY_FAILED。PUT は成功）→ 作業状態は「一部だけ反映」ではなく「登録済み・検証で不一致」
    const ws = VM.workspaceState({ version: conv.activePlan(), execState: null, jsExec: { stage: 'done', execution: { status: 'VERIFY_FAILED', put: { ok: true }, steps: [{ name: 'dealLock.js', target: 'desktop', status: 'VERIFY_FAILED' }] } }, subject: null });
    assert(ws.lines.includes('Preview登録済み・検証で不一致（要確認）') && !ws.lines.includes('一部だけ反映（要確認）'), 'U6: JS 登録の検証不一致は「Preview登録済み・検証で不一致（要確認）」');
  }
  // 計画の段階（Review）: 値に応じた警告を show だけで判定する計画は、入力中に切り替わらないと指摘する（実機 BF-C で 2 回続けて change が抜けた）
  const custPlan = (requirement, events, fields) => plan([step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', '', { customizationId: 'C1' }, { solution: 'CUSTOMIZATION', execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' } })], [], { solution: 'CUSTOMIZATION', customizations: [{ customizationId: 'C1', requirement, whyStandardInsufficient: '標準設定に無い', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events, fields, apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [] }] });
  const showOnly = reviewOf(custPlan('画面表示時に金額が100万円を超えた場合に金額フィールドの下に警告メッセージを表示する', ['app.record.create.show', 'app.record.edit.show'], [{ code: 'amount', access: 'CONTROL' }])).steps[0];
  assert(showOnly.issues.some(i => i.code === 'JS_CHANGE_EVENT_MISSING' && /amount/.test(i.message)) && showOnly.status === 'NEEDS_CONFIRMATION', 'BF-C: 「100万円を超えた場合に警告」を show だけで判定 → JS_CHANGE_EVENT_MISSING（入力中に切り替わらない）');
  const withChange = reviewOf(custPlan('金額が100万円を超えた場合に警告を表示する', ['app.record.create.show', 'app.record.edit.show', 'app.record.create.change.amount', 'app.record.edit.change.amount'], [{ code: 'amount', access: 'CONTROL' }])).steps[0];
  const lockOnly = reviewOf(custPlan('承認済みステータスのとき、金額に加えて担当者も編集不可にする', ['app.record.create.show', 'app.record.edit.show'], [{ code: 'amount', access: 'CONTROL' }, { code: 'owner', access: 'CONTROL' }])).steps[0];
  assert(!withChange.issues.some(i => i.code === 'JS_CHANGE_EVENT_MISSING') && !lockOnly.issues.some(i => i.code === 'JS_CHANGE_EVENT_MISSING'), 'change がある計画・ステータスで決まるロック（BF-D）は指摘しない');
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
  // 実機 354: 通知時刻の無いリマインダーは「問題なし」と出さず確認事項（Executor は時刻が無いと反映しない）
  const pNoTime = plan([step('P1', 'ADD_REMINDER', 'NEW_SETTING', '対応日7日後', { name: '対応日7日後', timingField: 'due_date', daysLater: 7, targets: ['FIELD_ENTITY:owner'] })]);
  const rNoTime = reviewOf(pNoTime).steps[0];
  assert(rNoTime.status === 'NEEDS_CONFIRMATION' && rNoTime.safety === 'REVIEW_REQUIRED' && rNoTime.issues.some(i => i.code === 'REMINDER_TIME_MISSING' && /9時に通知/.test(i.message)) && rNoTime.diff.human.some(l => /時刻 未定/.test(l)), '実機 354: 時刻の無いリマインダー → 確認が必要（REMINDER_TIME_MISSING・「時刻 未定」）');
  assert(/チャットで伝えて計画を修正/.test(KTContextUi.reviewHtml(reviewOf(pNoTime), pNoTime)), '自動で反映できない理由に「チャットで伝えて計画を修正」を案内');
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
  // F29（CX-5 実機）: 計画がある会話の途中変更「やっぱり税込150万円以上。既存フィールドは増やさないで」は修正
  {
    const withPlan = { activePlan: { status: 'ACTIVE', plan: { steps: [{ id: 'P1', actionType: 'ADD_PROCESS_STATUS', targetRef: '部長承認待ち', title: 'ステータスの追加', spec: { name: '部長承認待ち' } }], proposedFields: [{ label: '部長承認者', suggestedCode: 'manager_approver' }] } } };
    const CI = (t) => KTAiConversation.classifyIntent(t, withPlan).intent;
    assert(CI('やっぱり税込150万円以上。既存フィールドは増やさないで') === 'REVISE_PLAN' && CI('やはり200万円以上にして') === 'REVISE_PLAN' && CI('通知は送らないで') === 'REVISE_PLAN', 'F29: 「やっぱり / やはり」「〜ないで」は計画の修正');
    assert(KTAiConversation.classifyIntent('既存フィールドは増やさないで', {}).intent !== 'REVISE_PLAN', '計画が無ければ修正にはならない');
  }
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
  // F28（CX-2a 4 回目）: 「営業担当がいれば営業担当に通知、いなければ担当者に通知」の JS は生成の対象外（JavaScript では kintone の通知を送れない）
  const byJs = reviewOf(plan([step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', '', { customizationId: 'C1' }, { solution: 'CUSTOMIZATION' })], [], { solution: 'CUSTOMIZATION', customizations: [{ ...cust, requirement: '営業担当が空でない場合は営業担当に通知し、空の場合は担当者に通知する条件分岐を実装する', whyStandardInsufficient: '通知先を条件で切り替える標準機能がない', events: ['app.record.detail.process.proceed'], fields: [{ code: 'owner', access: 'READ' }] }] })).steps[0];
  assert(byJs.codeGeneration.supported === false && byJs.codeGeneration.reason === 'NOTIFICATION_BY_JS' && byJs.issues.some(i => i.code === 'JS_NOTIFICATION_NOT_POSSIBLE' && /標準の通知設定/.test(i.message)), 'F28: JavaScript で通知を送る / 通知先を切り替える要件は生成の対象外（NOTIFICATION_BY_JS）');
  const uiMsg = reviewOf(plan([step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', '', { customizationId: 'C1' }, { solution: 'CUSTOMIZATION' })], [], { solution: 'CUSTOMIZATION', customizations: [{ ...cust, requirement: '承認済みのレコードを開いたら画面の上部に注意メッセージを表示する', whyStandardInsufficient: '標準にない', events: ['app.record.detail.show'], fields: [{ code: 'amount', access: 'READ' }] }] })).steps[0];
  assert(!uiMsg.issues.some(i => i.code === 'JS_NOTIFICATION_NOT_POSSIBLE'), '画面のメッセージ表示は対象外にしない');
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

// =========================================================
console.log('\n--- CX-2a / CX-7 / XA-5（再実行）. 通知の種類・未確認のユーザー・言い切り・秘密情報・依頼のアプリ名 ---');
{
  const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] } } }, usage: { monthlyLimit: 200, usedThisMonth: 1 } };
  const respOf = (goal, steps, extra = {}) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'pl-r', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 200 } }, plan: { goal, solution: 'STANDARD', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], gaps: [], evidenceIds: [] }, relevantFields: [], proposedFields: [], steps, alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', customizations: [], ...extra } });
  const mountWith = (resp) => {
    const storage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
    const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
    settings.setConsent(true);
    const calls = [];
    const client = { async getHealth() { return HEALTH; }, async plan({ ctx, requestId }) { calls.push(ctx); const v = KTAiClient.validatePlan(resp, ctx); if (!v.ok) throw new Error(JSON.stringify(v.errors)); return { ...v.normalized, requestId, clientWarnings: v.warnings }; } };
    const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
    const host = makeFakeHost();
    const panel = mountAiWorkspace(host, { getInputs: () => ({ data: DATA, deps: DEPS, scan: null, incoming: null }), copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false }, executor: { api: makeKintoneMock(DATA).api, appId: '310' } });
    return { panel, host, calls, $: (id) => host.querySelector(`#${id}`) };
  };
  const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

  // 通知の種類: 条件式とイベントの両方 → Review も「要確認・種類 未定」（反映できない判定と一致させる）
  const amb = plan([step('P1', 'ADD_NOTIFICATION', 'NEW_SETTING', '高額案件の登録', { name: '高額案件の登録', filterCond: 'amount >= "1000000"', events: ['recordAdded'], targets: ['FIELD_ENTITY:owner'] })]);
  const rvAmb = reviewOf(amb);
  const sAmb = rvAmb.steps.find(x => x.stepId === 'P1');
  const aAmb = KTPlanExecutor.applyReadiness(amb, rvAmb).find(x => x.stepId === 'P1');
  assert(sAmb.status === 'NEEDS_CONFIRMATION' && sAmb.issues.some(i => i.code === 'NOTIFICATION_SCOPE_AMBIGUOUS' && i.severity === 'medium') && !sAmb.issues.some(i => i.code === 'NOTIFICATION_EVENTS_IGNORED') && /通知（種類 未定）/.test(sAmb.diff.human[0]) && aAmb.apply === 'MANUAL' && aAmb.reason === 'NOTIFICATION_SCOPE_AMBIGUOUS', 'CX-2a / CX-7: 条件式とイベントの両方 → Review も要確認（種類 未定）。反映の判定（MANUAL・NOTIFICATION_SCOPE_AMBIGUOUS）と食い違わない');
  // 受信時: 「ステータスの更新」＋「ステータス in (…)」だけはレコードの条件通知として直す（意味が一致する）
  {
    // 実機（CX-2a 3 回目）と同じ形: 説明文（details）にも「イベント: statusChanged」がある（Review は構造化した値が空だと説明文から取り込む）
    const m = mountWith(respOf('承認されたら担当者に通知したい', [step('P1', 'ADD_NOTIFICATION', 'NEW_SETTING', '承認済み通知', { name: '承認済み通知', filterCond: 'ステータス = "承認済み"', events: ['statusChanged'], targets: ['FIELD_ENTITY:owner'] }, { proposal: { summary: '承認済みステータスに変更されたときに担当者フィールドへ通知を送る設定を追加します。', details: [{ key: '通知名', value: '承認済み通知' }, { key: '通知先', value: 'FIELD_ENTITY:owner' }, { key: 'イベント', value: 'statusChanged' }, { key: '条件式', value: 'ステータス = "承認済み"' }] } })]));
    await ticks();
    await m.panel.send('承認されたら担当者に通知したい');
    const v = m.panel.conversation().activePlan();
    const r1 = v.review.steps.find(x => x.stepId === 'P1');
    assert(v.plan.steps[0].spec.events.length === 0 && v.plan.steps[0].spec.filterCond === 'ステータス in ("承認済み")' && r1.issues.some(i => i.code === 'NOTIFICATION_EVENTS_DROPPED' && /レコードの条件通知/.test(i.message)) && !r1.issues.some(i => i.code === 'NOTIFICATION_SCOPE_AMBIGUOUS') && KTPlanExecutor.applyReadiness(v.plan, v.review).find(a => a.stepId === 'P1').apply === 'AUTO', 'CX-2a: statusChanged ＋ ステータス in (…) は受信時にレコードの条件通知へ（イベントを外したと表示）→ 自動で反映できる');
    const m2 = mountWith(respOf('高額案件が登録されたら通知したい', [step('P1', 'ADD_NOTIFICATION', 'NEW_SETTING', '高額', { name: '高額', filterCond: 'amount >= "1000000"', events: ['statusChanged'], targets: ['FIELD_ENTITY:owner'] })]));
    await ticks();
    await m2.panel.send('高額案件が登録されたら通知したい');
    const v2 = m2.panel.conversation().activePlan();
    assert(v2.plan.steps[0].spec.events.length === 1 && v2.review.steps.find(x => x.stepId === 'P1').issues.some(i => i.code === 'NOTIFICATION_SCOPE_AMBIGUOUS'), 'ステータス以外の条件との組み合わせは直さない（要確認のまま）');
  }
  // 未確認のユーザー（CX-7: USER:SLACK_WEBHOOK_USER）
  const fake = reviewOf(plan([step('P1', 'ADD_NOTIFICATION', 'NEW_SETTING', 'Slack承認通知', { name: 'Slack承認通知', filterCond: 'ステータス in ("承認済み")', targets: ['USER:SLACK_WEBHOOK_USER'] })]));
  const sFake = fake.steps.find(x => x.stepId === 'P1');
  assert(sFake.status === 'NEEDS_CONFIRMATION' && sFake.issues.some(i => i.code === 'ENTITY_UNVERIFIED' && /SLACK_WEBHOOK_USER/.test(i.message) && /確かめていません/.test(i.message)), 'CX-7: このアプリの設定に出てこないユーザーを宛先にした通知は要確認（ENTITY_UNVERIFIED）');
  const known = reviewOf(plan([step('P1', 'ADD_NOTIFICATION', 'NEW_SETTING', '通知', { name: '通知', filterCond: 'ステータス in ("承認済み")', targets: ['USER:user1', 'GROUP:everyone'] })])).steps.find(x => x.stepId === 'P1');
  assert(!known.issues.some(i => i.code === 'ENTITY_UNVERIFIED'), '既存の設定に出てくるユーザー（user1）と Everyone は要確認にしない');
  // 案内の言い切り（CX-7）: 自動で反映できる手順が無ければそう伝える
  {
    const conv = KTAiConversation.create({ services: {} });
    const p = plan([step('P1', 'UPDATE_RECORD_ACL', 'NEW_SETTING', '', { filterCond: 'ステータス in ("承認済み")', entities: ['FIELD_ENTITY:owner'] }), step('P2', 'REQUIRE_CONFIRMATION', 'NEW_SETTING', '', {})], [], { solution: 'HYBRID' });
    conv.registerPlan({ plan: p, ctx: null, review: reviewOf(p) });
    const texts = conv.messages().map(x => x.text).join('\n');
    assert(!/組み合わせで実現できます/.test(texts) && /標準設定と JavaScript を組み合わせる計画です/.test(texts) && /設定の手順は、どれも Toolkit からは自動で反映できません/.test(texts), 'CX-7: 「実現できます」と言い切らず、自動で反映できる手順が無いことを伝える');
  }
  // 秘密情報（CX-7: AI が Webhook URL を質問した）
  {
    const S = KTAiConversation.secretLikeIn;
    const pos = ['https://hooks.slack.com/services/T0000/B0000/XXXXXXXXXXXXXXXX', 'Authorization: Bearer abcdefghijklmnop1234567890', 'xoxb-1234567890-abcdefghij', 'APIキー: a1B2c3D4e5', 'password=hunter22', 'トークンは AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd です', 'https://example.com/hook?token=abcdef123456'];
    const neg = ['承認されたらSlackに通知して', 'パスワード：まだ決めていません', 'API キーは使わない方式にしたい', "kintone.app.record.getSpaceElement('amount_warning_space')", '顧客マスタ（旧）の顧客コードで会社名を取ってきたい', 'https://qlcmsgqzf8g1.cybozu.com/k/357/'];
    assert(pos.every(t => S(t)) && neg.every(t => !S(t)), `秘密情報らしい文字列だけを検出する（誤検出なし）: ${pos.filter(t => !S(t)).concat(neg.filter(t => S(t))).join(' | ') || 'ok'}`);
    let called = 0;
    const conv = KTAiConversation.create({ services: { plan: async () => { called++; return { plan: null }; }, ask: async () => { called++; return { ok: true, answer: { answer: 'x' } }; } } });
    const res = await conv.send('Slack の Webhook URL は https://hooks.slack.com/services/T0000/B0000/XXXXXXXXXXXXXXXX です');
    assert(res.ok === false && res.reason === 'SECRET_LIKE' && called === 0 && !conv.messages().some(x => x.type === 'USER') && conv.messages().some(x => x.type === 'SYSTEM_NOTICE' && x.data.kind === 'secret-blocked' && /送信しませんでした/.test(x.text) && !/hooks\.slack\.com/.test(x.text)), 'CX-7: Webhook URL を含む入力は AI へ送らず会話にも残さない（理由だけ表示）');
    const m = mountWith(respOf('x', []));
    await ticks();
    m.$('kt-ai-input').value = 'APIキー: a1B2c3D4e5f6 を使って会計システムに送って';
    await m.$('kt-ai-send').dispatch('click'); await ticks();
    assert(m.calls.length === 0 && m.$('kt-ai-input').value === 'APIキー: a1B2c3D4e5f6 を使って会計システムに送って' && /送信しませんでした/.test(m.$('kt-ai-chat').innerHTML) && !/a1B2c3D4e5f6/.test(m.$('kt-ai-chat').innerHTML), '画面: 送信しない・入力欄の文は残る（直して送れる）・会話には秘密情報を出さない');
    const conv2 = KTAiConversation.create({ services: {} });
    const pq = plan([step('P1', 'REQUIRE_CONFIRMATION', 'NEW_SETTING', '', {})], [], { questions: [{ id: 'Q1', question: 'Slack通知の送信先Webhook URLや通知内容の詳細は？', relatedEvidenceIds: [] }] });
    conv2.registerPlan({ plan: pq, ctx: null, review: reviewOf(pq) });
    assert(conv2.messages().some(x => x.data && x.data.kind === 'secret-question' && /チャットに書かないでください/.test(x.text)), 'CX-7: AI が秘密情報を質問したら、チャットに書かないよう Toolkit が伝える');
  }
  // 依頼のアプリ名と参照先アプリの名前（XA-5）
  {
    const W = (goal, steps = []) => reviewOf(plan(steps, [], { goal })).warnings.filter(w => w.code === 'RELATED_APP_NAME_MISMATCH');
    const w1 = W('顧客マスタ（旧）の顧客コードで会社名を取ってきたい');
    assert(w1.length === 1 && w1[0].severity === 'medium' && /顧客マスタ\(旧\)/.test(w1[0].message) && /「顧客マスタ」（App 500）/.test(w1[0].message), 'XA-5: 「顧客マスタ（旧）」は参照先「顧客マスタ」と名前が一致しない → 計画全体の指摘（medium）');
    assert(W('顧客マスタ2から電話番号を取得したい').length === 1 && W('顧客マスタから住所と電話番号も取得したい').length === 0 && W('見積管理にも金額を転記したい').length === 0, '番号付きの名前は指摘・同じ名前（参照先そのもの）は指摘しない');
    assert(W('顧客マスタ（旧）の顧客コードで会社名を取ってきたい', [step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'LOOKUP', sourceApp: '357', keyField: 'cust_cd' })]).length === 0, '計画が参照先以外のアプリ（ID）を明示していれば指摘しない（利用者が ID を伝えた後）');
    // CX-4: 全体の禁止と例外が両方ある依頼で、計画の確認事項が触れていなければ計画全体の指摘
    const X = (goal, questions = []) => reviewOf(plan([], [], { goal, questions: questions.map((q, i) => ({ id: `Q${i + 1}`, question: q, relatedEvidenceIds: [] })) })).warnings.filter(w => w.code === 'REQUEST_EXCEPTION_UNCONFIRMED');
    const x1 = X('承認後は誰も金額を変更できないようにして。ただし営業担当はいつでも変更できるようにして', ['営業担当フィールドは文字列です。ログインユーザーとの照合方法は？']);
    assert(x1.length === 1 && x1[0].severity === 'medium' && /誰も/.test(x1[0].message) && /ただし/.test(x1[0].message), 'CX-4: 「誰も…できない」と「ただし…できる」が両方・確認事項が触れていない → 計画全体の指摘');
    assert(X('承認後は誰も金額を変更できないようにして。ただし営業担当はいつでも変更できるようにして', ['営業担当を例外として扱ってよいですか？']).length === 0 && X('承認後は金額を変更できないようにして').length === 0 && X('担当者以外は見られないようにして').length === 0, '確認事項が例外に触れている・例外の無い依頼は指摘しない');
    const conv = KTAiConversation.create({ services: {} });
    const p0 = plan([], [], { goal: '顧客マスタ（旧）の顧客コードで会社名を取ってきたい' });
    conv.registerPlan({ plan: p0, ctx: null, review: reviewOf(p0) });
    assert(conv.messages().some(x => /計画全体に確認が必要な点があります/.test(x.text)) && !conv.messages().some(x => /問題は見つかりませんでした/.test(x.text)), 'XA-5: 手順が無く「既存の設定で足りる」計画でも「問題は見つかりませんでした」と言わない');
  }
}

// =========================================================
console.log('\n--- F31（CX-1 実機）. プロセス: 承認と差し戻しは利用者が選ぶ別のボタン（同じ条件でも分岐の衝突にしない）---');
{
  // fixture のプロセス: 未処理 →［申請する］→ 承認待ち →［承認する］→ 完了、承認待ち →［取り下げる］（SECONDARY）→ 未処理
  const p = plan([
    step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認待ち', { name: '部長承認待ち', assignees: ['FIELD_ENTITY:owner'], assigneeType: 'ONE' }),
    step('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ回す', { name: '部長へ回す', from: '承認待ち', to: '部長承認待ち', filterCond: 'amount >= "1000000"' }, { dependsOn: ['P1'] }),
    step('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '承認する（部長）', { name: '承認する（部長）', from: '部長承認待ち', to: '完了' }, { dependsOn: ['P1'] }),
    step('P4', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '差し戻す（部長）', { name: '差し戻す（部長）', from: '部長承認待ち', to: '未処理' }, { dependsOn: ['P1'] }),
  ]);
  const rv = reviewOf(p);
  const p4 = rv.steps.find(x => x.stepId === 'P4');
  assert(!p4.issues.some(i => i.code === 'ACTION_SAME_CONDITION') && !rv.conflicts.some(c => c.code === 'ACTION_SAME_CONDITION'), 'F31: 部長承認待ちの［承認する］と［差し戻す］（前のステータスへ戻す）は、両方とも条件なしでも同じ条件の衝突にしない');
  assert(!rv.warnings.some(w => /部長承認待ち/.test(w.message) && /PROCESS_CONDITION_(OVERLAP|IDENTICAL)/.test(w.code)), 'F31: 分岐の判定（partition）でも差し戻しは相手にしない');
  // 進む方向の 2 つのアクションが同じ条件（両方とも条件なし）→ どちらのルートへ進むかを条件で分けていない → 従来どおり指摘
  const p2 = plan([
    step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '課長承認待ち', { name: '課長承認待ち', assignees: ['FIELD_ENTITY:owner'], assigneeType: 'ONE' }),
    step('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '課長へ回す', { name: '課長へ回す', from: '承認待ち', to: '課長承認待ち' }, { dependsOn: ['P1'] }),
  ]);
  const s2 = reviewOf(p2).steps.find(x => x.stepId === 'P2');
  assert(s2.issues.some(i => i.code === 'ACTION_SAME_CONDITION' && /ルート/.test(i.message)), '進む方向のアクション同士が同じ条件なら従来どおり指摘（どちらのルートへ進むかを条件で分けていない）');
}

// =========================================================
console.log('\n--- U5. ［新しい会話］: 続けて書いた別の依頼が今の計画の修正にならないよう、画面から会話を始め直せる ---');
{
  const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] } } }, usage: { monthlyLimit: 200, usedThisMonth: 1 } };
  const RESP = { ok: true, contractVersion: '2.1', meta: { requestId: 'pl-u5', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 200 } }, plan: { goal: '承認済みの案件だけの一覧を追加したい', solution: 'STANDARD', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], gaps: [], evidenceIds: [] }, relevantFields: [], proposedFields: [], steps: [step('P1', 'ADD_VIEW', 'VIEW', '承認済みの案件', { name: '承認済みの案件', fields: ['amount'] })], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', customizations: [] } };
  let gate = null; const calls = [];
  const client = { async getHealth() { return HEALTH; }, async plan({ ctx, requestId, signal }) { calls.push({ ctx, signal }); if (gate) await new Promise((res, rej) => { gate.res = res; signal?.addEventListener?.('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'CANCELLED' }))); }); const v = KTAiClient.validatePlan(RESP, ctx); return { ...v.normalized, requestId, clientWarnings: v.warnings }; } };
  const storage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' }); settings.setConsent(true);
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const host = makeFakeHost();
  const mock = makeKintoneMock(DATA);
  const panel = mountAiWorkspace(host, { getInputs: () => ({ data: DATA, deps: DEPS, scan: null, incoming: null }), copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false }, executor: { api: mock.api, appId: '310' } });
  const $ = (id) => host.querySelector(`#${id}`);
  const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
  const act = (a) => $('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act: a } } });
  await ticks();
  assert($('kt-ai-new-conv') && $('kt-ai-new-conv').disabled === true, '会話が空のうちは［新しい会話］は押せない');
  await panel.send('承認済みの案件だけの一覧を追加したい'); await ticks();
  assert(panel.conversation().planHistory().length === 1 && $('kt-ai-new-conv').disabled === false, '前提: 計画 v1 がある・［新しい会話］が押せる');
  await panel.startExecutor(); await ticks();
  // 承認してから準備（最終確認の画面）まで進める
  panel.decide && panel.decide('P1', 'approve');
  await panel.startExecutor(); await ticks();
  const stageBefore = panel.executorState().stage;
  await $('kt-ai-new-conv').dispatch('click'); await ticks();
  assert(panel.conversation().messages().some(m => m.data && m.data.kind === 'new-conv-choices') && /新しい会話を始める/.test($('kt-ai-chat').innerHTML) && panel.conversation().planHistory().length === 1, '［新しい会話］→ 確認カード（まだ消さない）');
  await act('new-conv-cancel'); await ticks();
  assert(!panel.conversation().messages().some(m => m.data && m.data.kind === 'new-conv-choices') && panel.conversation().planHistory().length === 1, '［このまま続ける］→ カードだけ消え、計画は残る');
  await $('kt-ai-new-conv').dispatch('click'); await ticks();
  await act('new-conv'); await ticks();
  assert(panel.conversation().messages().length === 0 && panel.conversation().planHistory().length === 0 && !panel.conversation().activePlan() && $('kt-ai-new-conv').disabled === true, '［新しい会話を始める］→ 会話・計画が消え、ボタンは押せない状態に戻る');
  assert(['confirm', 'blocked'].includes(stageBefore) ? panel.executorState().stage === 'idle' : true, `未反映の準備（最終確認）は取り消す（前の会話の計画を新しい会話から反映しない）: ${stageBefore} → ${panel.executorState().stage}`);
  assert(mock.calls.every(c => c.startsWith('GET')), '新しい会話の操作で kintone の設定へ書き込まない');
  // 送信中に新しい会話 → 要求を中断し、遅れた応答を新しい会話に入れない
  gate = {};
  const pending = panel.send('承認済みの案件だけの一覧を追加したい');
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
  await $('kt-ai-new-conv').dispatch('click'); await ticks();
  await act('new-conv'); await pending; await ticks();
  assert(calls[calls.length - 1].signal && calls[calls.length - 1].signal.aborted === true && panel.conversation().planHistory().length === 0 && !panel.conversation().isBusy(), '送信中なら要求を中断し、新しい会話に前の応答を入れない');
}

// =========================================================
console.log('\n--- FR-1 / FR-2 / FR-6 / FR-7（UI・実際の AI client と transport）. 計画の要求の失敗・二重クリック・再試行 ---');
{
  const data = FX.makeData();
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  const scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files: FX.files, fields: fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType })), deps, skippedUrlFiles: FX.skippedUrlFiles });
  KTDeps.mergeScannerEdges(deps, scan);
  const inputs = { data, deps, scan, incoming: null };
  const GOAL = '承認済みの案件だけの一覧を追加したい';
  const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] } } }, usage: { monthlyLimit: 200, usedThisMonth: 1 } };
  const META = { requestId: 'pl-fr', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 2, monthlyLimit: 200 } };
  const GOOD = { ok: true, contractVersion: '2.1', meta: META, plan: { goal: GOAL, solution: 'STANDARD', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], gaps: [], evidenceIds: [] }, relevantFields: [], proposedFields: [], steps: [step('P1', 'ADD_VIEW', 'VIEW', '承認済みの案件', { name: '承認済みの案件', fields: ['amount'] })], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', customizations: [] } };
  // POST /v2/review の応答を順に切り替える: hang（応答なし → client の timeout）/ malformed（plan.steps が無い）/ model-invalid（Gateway 502）/ gate（保留）/ ok
  const queue = [], posts = []; let release = null;
  const transport = async (req) => {
    if (req.method === 'GET') return { status: 200, body: JSON.stringify(HEALTH) };
    posts.push(req.url);
    const next = queue.shift() || 'ok';
    if (next === 'hang') return new Promise(() => { });
    if (next === 'gate') await new Promise((res) => { release = res; });
    if (next === 'malformed') return { status: 200, body: JSON.stringify({ ok: true, contractVersion: '2.1', meta: META, plan: { goal: GOAL, assessment: { summary: 's' } } }) };
    if (next === 'model-invalid') return { status: 502, body: JSON.stringify({ ok: false, contractVersion: '2.1', error: { code: 'MODEL_OUTPUT_INVALID', message: 'm', requestId: 'e-mi' } }) };
    return { status: 200, body: JSON.stringify(GOOD) };
  };
  const client = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 't.cybozu.com', transport, timeoutMs: 400 });   // gate（保留）の間に timeout しない長さ
  const storage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const mock = makeKintoneMock(data);
  const panel = mountAiWorkspace(host, { getInputs: () => inputs, copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow, executor: { api: mock.api, appId: '310' } });
  const $ = (id) => host.querySelector(`#${id}`);
  const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
  const msgs = () => panel.conversation().messages();
  const last = () => msgs()[msgs().length - 1];
  const chat = () => $('kt-ai-chat').innerHTML;
  const plans = () => panel.conversation().planHistory().length;
  const retry = () => $('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act: 'retry', text: GOAL } } });
  // 応答（timeout を含む）が返って送信中でなくなるまで待つ / 要求が n 件送られるまで待つ
  const settle = async (ms = 3000) => { const t0 = Date.now(); await ticks(); while (panel.conversation().isBusy() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10)); await ticks(); };
  const sentCount = async (n, ms = 3000) => { const t0 = Date.now(); while (posts.length < n && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 5)); await ticks(); };
  await ticks();
  // FR-1: 応答が返らない → client の timeout
  queue.push('hang');
  $('kt-ai-input').value = GOAL;
  $('kt-ai-send').dispatch('click'); await settle();
  assert(posts.length === 1 && last().type === 'ERROR' && last().data.code === 'TIMEOUT' && /data-act="retry"/.test(chat()) && $('kt-ai-input').value === GOAL && plans() === 0 && !msgs().some(m => m.type === 'PLAN') && !panel.conversation().isBusy() && $('kt-ai-send').disabled === false, 'FR-1: タイムアウト → エラーカード（再試行）・入力欄の文は残る・計画は登録しない・続けて送信できる');
  // FR-2: 不完全な応答（plan.steps が無い）→ client の検証で拒否 / Gateway の MODEL_OUTPUT_INVALID
  queue.push('malformed');
  retry(); await settle();
  assert(posts.length === 2 && last().type === 'ERROR' && last().data.code === 'INVALID_RESPONSE' && /\[INVALID_RESPONSE\]/.test(chat()) && plans() === 0, 'FR-2: plan の形が不完全な応答 → INVALID_RESPONSE（計画として登録しない・理由の code を表示）');
  queue.push('model-invalid');
  retry(); await settle();
  assert(posts.length === 3 && last().type === 'ERROR' && last().data.code === 'MODEL_OUTPUT_INVALID' && /\[MODEL_OUTPUT_INVALID\]/.test(chat()) && plans() === 0 && $('kt-ai-input').value === GOAL, 'FR-2: Gateway が AI 出力を契約違反と判定（502 MODEL_OUTPUT_INVALID）→ 登録しない・入力は残る');
  // FR-7 / FR-6: 再試行の応答待ちに［再試行］と［送信］をもう一度押しても要求は 1 回。応答が来たら計画は 1 件だけ
  queue.push('gate');
  const p1 = retry(); await sentCount(4);
  assert(panel.conversation().isBusy() && posts.length === 4, '前提: 再試行の要求を送信中（応答待ち）');
  const p2 = retry(); const p3 = $('kt-ai-send').dispatch('click'); await ticks();
  assert(posts.length === 4, 'FR-6: 送信中の［再試行］［送信］の再クリックで要求を重ねない（POST は 4 回のまま）');
  release(); await p1; await p2; await p3; await settle();
  assert(posts.length === 4 && plans() === 1 && msgs().filter(m => m.type === 'PLAN').length === 1 && panel.conversation().activePlan().version === 1 && $('kt-ai-input').value === '', 'FR-7: 失敗の後の再試行で計画 v1 が 1 件だけ登録される（重複しない）・成功後に入力欄は空');
  assert(mock.calls.every(c => c.startsWith('GET')), 'FR-1 / FR-2 / FR-7: AI の失敗・再試行で kintone の設定へ書き込まない');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
