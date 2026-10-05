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
const { KTDeps, KTScan, KTContext, KTContextUi, KTAiClient, KTAiConversation, KTAiWorkspaceViewModel: VM, KTAiChatUi, KTPlanReview, KTPlanExecutor, KTCodeReview, KTJsExecutor, mountAiWorkspace } = loadToolkit();
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
    "    const record = event.record;",
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
    "    const amountField = event.record['amount'];",
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
  const GOOD = DEAL_LOCK.replace("})();", "  kintone.events.on(['app.record.create.change.amount', 'app.record.edit.change.amount'], function (event) {\n    const f = event.record['amount'];\n    f.error = Number(f.value || 0) > 1000000 ? '金額が100万円を超えています。' : null;\n    return event;\n  });\n})();");
  const ok = KTCodeReview.review({ generated: gen(GOOD), customization: { ...custom, strategy: 'NEW_JS_FILE' }, plan: null, data: DATA, scan: null, existingSource: null });
  assert(chk(ok, 'error-clear').ok && chk(ok, 'error-cancels-edit').ok, '直したコード（null で消す・警告は change だけ）は 2 つの検査を通る');
  // 保存時（submit）の検証: エラーで保存自体が止まるので、error と value の組み合わせは対象外
  const SUBMIT = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.create.submit'], function (event) {\n    const r = event.record;\n    if (!r['amount'].value) { r['amount'].error = '金額を入力してください'; } else { r['case_name'].value = r['case_name'].value || '（無題）'; }\n    return event;\n  });\n})();";
  const sub = KTCodeReview.review({ generated: { strategy: 'NEW_JS_FILE', targetFile: 'v.js', code: SUBMIT, patch: null, events: ['app.record.create.submit'], fields: [{ code: 'amount', access: 'CONTROL' }, { code: 'case_name', access: 'WRITE' }], apis: [] }, customization: { ...custom, strategy: 'NEW_JS_FILE', events: ['app.record.create.submit'], fields: [{ code: 'amount', access: 'CONTROL' }, { code: 'case_name', access: 'WRITE' }] }, plan: null, data: DATA, scan: null, existingSource: null });
  assert(chk(sub, 'error-cancels-edit').ok, 'submit の error と value は error-cancels-edit の対象外（保存が止まるだけ）');
  const none = KTCodeReview.review({ generated: gen(DEAL_LOCK), customization: { ...custom, strategy: 'NEW_JS_FILE' }, plan: null, data: DATA, scan: null, existingSource: null });
  assert(!chk(none, 'error-clear') && !chk(none, 'error-cancels-edit'), 'error を使わないコードには 2 つの検査行を出さない（ノイズにしない）');
}

// =========================================================
console.log('\n--- BF-C（再 3）/ F24. エラー表示と編集不可: 条件で分けたコードは要確認・別 handler / 別ファイルも見る（実機の生成コード 2 本）---');
{
  const DEAL_LOCK = "(function () {\n  'use strict';\n  // 承認済みの案件は金額を変更できないようにする（既存の運用ルール）\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();";
  // 1 本目（実機: 承認済み・1,000,001 で金額が編集できるようになった）: 別 handler で、条件なしに error を設定
  const SEPARATE = DEAL_LOCK.replace("})();", "  // 金額が100万円を超えたら警告を表示する\n  function checkAmountWarning(event) {\n    const record = event.record;\n    if (record['amount']) {\n      record['amount'].error = (record['amount'].value > 1000000) ? '100万円を超えています' : null;\n    }\n    return event;\n  }\n\n  kintone.events.on([\n    'app.record.create.show',\n    'app.record.edit.show',\n    'app.record.create.change.amount',\n    'app.record.edit.change.amount'\n  ], checkAmountWarning);\n})();");
  // 2 本目（実機: 承認済みは編集不可のまま・警告なし。編集できるときだけ警告）: disabled を読む条件で分け、編集不可なら null
  const GUARDED = "(function () {\n  'use strict';\n  // 金額が100万円超なら警告表示（承認済みかつ編集不可なら非表示）\n  function checkAmountWarning(event) {\n    const record = event.record;\n    const amount = record['amount'].value;\n    const status = record['ステータス'] ? record['ステータス'].value : '';\n    const disabled = record['amount'].disabled;\n    if (amount > 1000000 && !(status === '承認済み' && disabled)) {\n      record['amount'].error = '100万円を超えています';\n    } else {\n      record['amount'].error = null;\n    }\n    return event;\n  }\n\n  // 画面表示時の処理に警告表示を追加\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function(event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    return checkAmountWarning(event);\n  });\n\n  // 金額変更時の警告表示更新\n  kintone.events.on(['app.record.create.change.amount', 'app.record.edit.change.amount'], checkAmountWarning);\n})();\n";
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
  const WARN_ONLY = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show', 'app.record.edit.change.amount'], function (event) {\n    const f = event.record['amount'];\n    f.error = Number(f.value || 0) > 1000000 ? '100万円を超えています' : null;\n    return event;\n  });\n})();";
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
  const DL_SRC = "(function () {\n  'use strict';\n  // 承認済みの案件は金額を変更できないようにする（既存の運用ルール）\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();\n";
  const PATCH4 = { baseHash: KTScan.hashText(DL_SRC), operations: [{ type: 'INSERT_AFTER', anchor: "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }", content: "\n    // 金額が100万円を超えたら警告を表示する\n    if (record['amount'].value > 1000000 && !record['amount'].disabled) {\n      record['amount'].error = '金額が100万円を超えています。';\n    } else {\n      record['amount'].error = null;\n    }\n" }] };
  const cust4 = { ...custom, strategy: 'EXTEND_EXISTING_JS', existingFiles: [{ name: 'dealLock.js', target: 'desktop' }] };
  const r4 = KTCodeReview.review({ generated: { strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', summary: 's', code: PATCH4.operations[0].content, patch: PATCH4, events: custom.events, fields: custom.fields, apis: ['kintone.events.on'] }, customization: cust4, plan: null, data: DATA, scan: null, existingSource: { name: 'dealLock.js', target: 'desktop', text: DL_SRC } });
  assert(chk(r4, 'patch').ok && chk(r4, 'error-cancels-edit').severity === 'review' && !chk(r4, 'planned-events').ok && chk(r4, 'planned-events').severity === 'block' && /入力中に切り替わりません/.test(chk(r4, 'planned-events').message) && r4.status === 'BLOCKED' && r4.registration.verdict === 'BLOCKED', 'F26（BF-C 4 回目）: 計画の change をコードが登録していない → 登録不可（Phase 21。Phase 20 は要確認、それ以前は「軽微な差」で合格扱い）');
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
  const SPACE_JS = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.change.amount'], function (event) {\n    const sp = kintone.app.record.getSpaceElement('amount_warning_space');\n    if (!sp) return event;\n    sp.textContent = Number(event.record['amount'].value || 0) > 1000000 ? '金額が100万円を超えています' : '';\n    return event;\n  });\n})();";
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
  const FIELD_ON_OFF = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'].value === '承認待ち') {\n      record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();";
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
console.log('\n--- F32 / F33（CX-1 実機）. 1 つの手順の説明に書かれた複数の設定・既存のステータスへ進む道が無くなる ---');
{
  const statusStep = (id, name) => step(id, 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', name, { name, assignees: ['FIELD_ENTITY:owner'], assigneeType: 'ONE' });
  // 実機の v2 の P3 と同じ形: spec は name / from / changeKind だけで、説明（details）に 2 つの分岐（遷移先・条件）を続けて書いた
  const det = [['name', '申請する'], ['from', '未処理'], ['to', '部長承認待ち'], ['filterCond', 'amount >= "1000000"'], ['name', '申請する'], ['from', '未処理'], ['to', '課長承認待ち'], ['filterCond', 'amount < "1000000"']].map(([key, value]) => ({ key, value }));
  const p = plan([
    statusStep('P1', '部長承認待ち'), statusStep('P2', '課長承認待ち'),
    step('P3', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', changeKind: 'ACTION_CONDITION' }, { proposal: { summary: '申請するの遷移先を金額で部長承認待ち / 課長承認待ちに分ける', details: det } }),
    step('P4', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '承認する（部長）', { name: '承認する（部長）', from: '部長承認待ち', to: '完了' }, { dependsOn: ['P1'] }),
    step('P5', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '承認する（課長）', { name: '承認する（課長）', from: '課長承認待ち', to: '完了' }, { dependsOn: ['P2'] }),
  ]);
  const rv = reviewOf(p);
  const s3 = rv.steps.find(x => x.stepId === 'P3');
  const multi = s3.issues.find(i => i.code === 'STEP_MULTIPLE_SETTINGS');
  assert(multi && multi.severity === 'high' && /課長承認待ち/.test(multi.message) && /amount < "1000000"/.test(multi.message) && /部長承認待ち/.test(multi.message), 'F32: 説明に遷移先・条件が 2 組 → STEP_MULTIPLE_SETTINGS（以前は 1 組目だけを黙って使い、2 組目は検証も表示もされなかった）');
  const ar = KTPlanExecutor.applyReadiness(p, rv).find(a => a.stepId === 'P3');
  assert(ar.apply === 'BLOCKED' && ar.reason === 'MULTIPLE_SETTINGS_IN_STEP', `F32: その手順は自動で反映しない（1 組目だけを反映すると 100 万円未満を申請できなくなる。依存の書き方に頼らない）: ${ar.apply} ${ar.reason}`);
  // 同じ値の繰り返し（name / from）だけなら指摘しない
  const same = plan([statusStep('P1', '部長承認待ち'), step('P2', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', changeKind: 'ACTION_CONDITION' }, { dependsOn: ['P1'], proposal: { summary: '', details: [['to', '部長承認待ち'], ['filterCond', 'amount >= "1000000"'], ['遷移先', '部長承認待ち'], ['条件', 'amount >= "1000000"']].map(([key, value]) => ({ key, value })) } })]);
  assert(!reviewOf(same).steps.find(x => x.stepId === 'P2').issues.some(i => i.code === 'STEP_MULTIPLE_SETTINGS'), 'F32: 同じ値の繰り返し（表記違いの同じ条件を含む）は指摘しない');
  // 一覧の項目（通知先など）は行が分かれていても全部使う（2 行目を黙って捨てない）
  const n = reviewOf(plan([step('P1', 'ADD_NOTIFICATION', 'NEW_SETTING', '高額案件', { name: '高額案件' }, { proposal: { summary: '', details: [['通知先', 'FIELD_ENTITY:owner'], ['通知先', 'CREATOR'], ['条件', 'amount >= "1000000"']].map(([key, value]) => ({ key, value })) } })])).steps.find(x => x.stepId === 'P1');
  assert(n.spec.targets.length === 2 && !n.issues.some(i => i.code === 'STEP_MULTIPLE_SETTINGS'), `F32: 通知先の行が 2 つ → 2 人とも通知先（以前は 1 行目だけ）: ${JSON.stringify(n.spec.targets)}`);

  // F33: 「申請する」の遷移先を新しいステータスへ変えると、既存の「承認待ち」へ進むアクションが無くなる（実機では指摘が無かった）
  const orphan = plan([
    statusStep('P1', '部長承認待ち'),
    step('P2', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', to: '部長承認待ち', changeKind: 'ACTION_CONDITION' }, { dependsOn: ['P1'] }),
    step('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '承認する（部長）', { name: '承認する（部長）', from: '部長承認待ち', to: '完了' }, { dependsOn: ['P1'] }),
  ]);
  const w = reviewOf(orphan).warnings.find(x => x.code === 'STATUS_ORPHANED');
  assert(w && /「承認待ち」/.test(w.message) && /残/.test(w.message) && w.stepIds.includes('P2'), `F33: 既存の「承認待ち」へ進むアクションが無くなる → 指摘（今あるレコードは残る・新しいレコードは入らない）: ${w && w.message}`);
  // 既存のステータスへ進む道が残るなら指摘しない（承認待ち → 部長承認待ちへ回す）
  const kept = plan([statusStep('P1', '部長承認待ち'), step('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ回す', { name: '部長へ回す', from: '承認待ち', to: '部長承認待ち', filterCond: 'amount >= "1000000"' }, { dependsOn: ['P1'] }), step('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '承認する（部長）', { name: '承認する（部長）', from: '部長承認待ち', to: '完了' }, { dependsOn: ['P1'] })]);
  assert(!reviewOf(kept).warnings.some(x => x.code === 'STATUS_ORPHANED'), 'F33: 既存のステータスへ進む道が残る計画では指摘しない');
}

// =========================================================
console.log('\n--- F37（CX-1 2 回目・実機）. 同じ遷移元の分岐は一緒に反映する（片方が反映できないなら、もう片方も反映しない）---');
{
  const statusStep = (id, name) => step(id, 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', name, { name, assignees: ['FIELD_ENTITY:owner'], assigneeType: 'ONE' });
  // 実機の v2 と同じ形: 申請するを 100 万円以上だけ部長承認待ちへ・課長用の申請を追加（条件が < で無効）・部長承認待ちの承認 / 差し戻し
  const mk = (cond2) => plan([
    statusStep('P1', '部長承認待ち'),
    step('P2', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', to: '部長承認待ち', filterCond: 'amount >= "1000000"', changeKind: 'ACTION_CONDITION' }),
    step('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '申請する（課長）', { name: '申請する（課長）', from: '未処理', to: '承認待ち', filterCond: cond2 }),
    step('P4', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '承認する（部長）', { name: '承認する（部長）', from: '部長承認待ち', to: '完了' }, { dependsOn: ['P1'] }),
    step('P5', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '差し戻す（部長）', { name: '差し戻す（部長）', from: '部長承認待ち', to: '未処理' }, { dependsOn: ['P1'] }),
  ]);
  const by = (ar, id) => ar.find(a => a.stepId === id) || {};
  const bad = mk('amount < "1000000"');
  const arBad = KTPlanExecutor.applyReadiness(bad, reviewOf(bad));
  assert(by(arBad, 'P3').apply === 'BLOCKED' && by(arBad, 'P2').apply === 'BLOCKED' && by(arBad, 'P2').reason === 'PROCESS_BRANCH_PARTIAL' && /P3/.test(by(arBad, 'P2').message || ''), `F37: 分岐の片方（P3: < で無効）が反映できない → もう片方（P2: 申請を 100 万円以上だけにする）も反映しない（以前は P2 を自動で反映できると表示）: ${arBad.map(a => a.stepId + ':' + a.apply + (a.reason ? '(' + a.reason + ')' : '')).join(' ')}`);
  assert(['P1', 'P4', 'P5'].every(id => by(arBad, id).apply === 'BLOCKED'), `F37: 進む手順が反映されない新しいステータスと、そこから出るアクションも反映しない（孤立させない）: ${arBad.map(a => a.stepId + ':' + a.apply).join(' ')}`);
  const good = mk('amount <= "999999"');
  const arGood = KTPlanExecutor.applyReadiness(good, reviewOf(good));
  assert(['P1', 'P2', 'P3', 'P4', 'P5'].every(id => by(arGood, id).apply === 'AUTO'), `F37: 条件が正しければ 5 手順とも自動で反映できる: ${arGood.map(a => a.stepId + ':' + a.apply + (a.reason ? '(' + a.reason + ')' : '')).join(' ')}`);
  // 実機 CX-5 3 回目: 分岐の相手が「無効な UPDATE_PROCESS（存在しないアクション・変更種別なし）」でも同じ遷移元の分岐として扱う（以前は P1 だけ自動反映できた）
  const inv = plan([
    step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', to: '承認待ち', filterCond: 'amount >= "1500000"', changeKind: 'ACTION_CONDITION' }),
    step('P2', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する（少額）', { name: '申請する（少額）', from: '未処理', to: '完了', filterCond: 'amount <= "1499999"' }, { dependsOn: ['P1'] }),
  ]);
  const arInv = KTPlanExecutor.applyReadiness(inv, reviewOf(inv));
  assert(by(arInv, 'P2').apply === 'BLOCKED' && by(arInv, 'P1').apply === 'BLOCKED' && by(arInv, 'P1').reason === 'PROCESS_BRANCH_PARTIAL', `F37: 分岐の相手が無効な UPDATE_PROCESS（変更種別なし）でも、もう片方を反映しない: ${arInv.map(a => a.stepId + ':' + a.apply + (a.reason ? '(' + a.reason + ')' : '')).join(' ')}`);
  // 実機 CX-1 2・4 回目: 承認者のフィールドを提案しただけで ADD_FIELD の手順が無い → 「順序を確認」ではなく、追加の手順が無いと伝える
  const noAdd = plan([step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認待ち', { name: '部長承認待ち', assignees: ['NEW_FIELD_1'], assigneeType: 'ONE' })], [pf('NEW_FIELD_1', '部長承認者', 'director_approver', 'USER_SELECT')]);
  const na = reviewOf(noAdd).steps[0].issues.find(i => i.code === 'PROPOSED_FIELD_NOT_APPLIED');
  assert(na && /追加する手順が計画にありません/.test(na.message) && !/順序/.test(na.message), `PROPOSED_FIELD_NOT_APPLIED: 追加の手順が無いときはそう伝える: ${na && na.message}`);
  // 片方だけを承認した場合も同じ（承認しなかった分岐があると、承認した分岐も反映しない）
  const cls = KTPlanExecutor.classifySteps({ plan: good, review: reviewOf(good), approvedSteps: ['P1', 'P2', 'P4', 'P5'] });
  const st = (id) => cls.find(x => x.stepId === id) || {};
  assert(st('P3').status === 'SKIPPED' && st('P2').status === 'BLOCKED' && st('P2').reason === 'PROCESS_BRANCH_PARTIAL', `F37: 分岐の片方だけ承認 → 承認した方も反映しない（理由を表示）: P2 ${st('P2').status} ${st('P2').reason}`);
}

// =========================================================
console.log('\n--- F41（F39 の確認・実機）. PC とモバイルの計画で、制御するフィールドが片方の画面の処理にしか無い ---');
{
  // 実機の生成そのまま: 既存の PC の handler（金額）はそのまま、担当者のロックはモバイルの handler だけ → PC では承認済みでも担当者を編集できた（Code Review は OK）
  const DL = ["(function () {", "  'use strict';", "  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {", "    const record = event.record;", "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {", "      record['amount'].disabled = true;", "    }", "    return event;", "  });", "})();", ""].join('\n');
  const ADD = "  kintone.events.on(['mobile.app.record.create.show', 'mobile.app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['owner'].disabled = true;\n    }\n    return event;\n  });\n";
  const SRC = { name: 'dealLock.js', target: 'desktop', text: DL };
  const baseHash = KTScan.analyzeFile({ name: 'dealLock.js', target: 'desktop', kind: 'js', text: DL }, { fields: [], selfAppId: null }).file.hash;
  const cust = { customizationId: 'C1', requirement: '承認済みでは担当者も編集不可（PC・スマホ）', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop', 'mobile'], events: ['app.record.create.show', 'app.record.edit.show', 'mobile.app.record.create.show', 'mobile.app.record.edit.show'], fields: [{ code: 'owner', access: 'CONTROL' }, { code: 'ステータス', access: 'READ' }], apis: [], existingFiles: [{ name: 'dealLock.js', target: 'desktop' }] };
  const genOf = (add) => ({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', code: add, patch: { baseHash, operations: [{ type: 'INSERT_BEFORE', anchor: '})();', content: add }] }, events: cust.events, fields: cust.fields, apis: ['kintone.events.on'] });
  const chk = (r, n) => r.checks.find(c => c.name === n) || null;
  const bad = KTCodeReview.review({ generated: genOf(ADD), customization: cust, plan: null, data: DATA, scan: null, existingSource: SRC });
  assert(chk(bad, 'platform-fields') && !chk(bad, 'platform-fields').ok && chk(bad, 'platform-fields').severity === 'block' && /owner/.test(chk(bad, 'platform-fields').message) && /PC ?の画面/.test(chk(bad, 'platform-fields').message) && bad.status === 'BLOCKED' && bad.registration.verdict === 'BLOCKED', `F41: 担当者のロックがモバイルの処理だけ → 登録不可（Phase 21。PC では制御していない。Phase 20 は要確認）: ${chk(bad, 'platform-fields') && chk(bad, 'platform-fields').message}`);
  // 両方の画面で制御するコード（PC の handler にも担当者）は従来どおり
  const BOTH = "  kintone.events.on(['app.record.create.show', 'app.record.edit.show', 'mobile.app.record.create.show', 'mobile.app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['owner'].disabled = true;\n    }\n    return event;\n  });\n";
  const good = KTCodeReview.review({ generated: genOf(BOTH), customization: cust, plan: null, data: DATA, scan: null, existingSource: SRC });
  assert(!(good.mismatches || []).some(m => m.code === 'PLATFORM_FIELD_MISSING'), `F41: PC とモバイルの両方で制御するコードは指摘しない: ${JSON.stringify((good.mismatches || []).map(m => m.code))}`);
  // イベントを変数（const EVENTS = [...]）で渡す書き方でも、配列の定義をたどって両方の画面と判定する（誤って「PC だけ」にしない）
  const VARS = "  const EVENTS = ['app.record.create.show', 'app.record.edit.show', 'mobile.app.record.create.show', 'mobile.app.record.edit.show'];\n  kintone.events.on(EVENTS, function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['owner'].disabled = true;\n    }\n    return event;\n  });\n";
  const viaVar = KTCodeReview.review({ generated: genOf(VARS), customization: cust, plan: null, data: DATA, scan: null, existingSource: SRC });
  assert(!(viaVar.mismatches || []).some(m => m.code === 'PLATFORM_FIELD_MISSING'), `F41: イベントを変数で渡しても両方の画面と判定する: ${JSON.stringify((viaVar.mismatches || []).map(m => m.code + ':' + m.message))}`);
}

// =========================================================
console.log('\n--- F42（F41 の再生成・実機）. 既存の条件（if）の外に足した編集不可（すべてのステータスで編集できなくなる）---');
{
  const DL = ["(function () {", "  'use strict';", "  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {", "    const record = event.record;", "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {", "      record['amount'].disabled = true;", "    }", "    return event;", "  });", "})();", ""].join('\n');
  const SRC = { name: 'dealLock.js', target: 'desktop', text: DL };
  const baseHash = KTScan.analyzeFile({ name: 'dealLock.js', target: 'desktop', kind: 'js', text: DL }, { fields: [], selfAppId: null }).file.hash;
  const cust = { customizationId: 'C1', requirement: '承認済みでは担当者も編集不可', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], events: ['app.record.create.show', 'app.record.edit.show'], fields: [{ code: 'owner', access: 'CONTROL' }, { code: 'ステータス', access: 'READ' }], apis: [], existingFiles: [{ name: 'dealLock.js', target: 'desktop' }] };
  const genOf = (op) => ({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', code: op.content, patch: { baseHash, operations: [op] }, events: cust.events, fields: cust.fields, apis: [] });
  const chk = (r, n) => r.checks.find(c => c.name === n) || null;
  // 実機の生成と同じ: 閉じ括弧「    }」の後ろに足した → 条件の外
  const out = KTCodeReview.review({ generated: genOf({ type: 'INSERT_AFTER', anchor: "      record['amount'].disabled = true;\n    }", content: "\n      record['owner'].disabled = true;" }), customization: cust, plan: null, data: DATA, scan: null, existingSource: SRC });
  const c1 = chk(out, 'unconditional-control');
  assert(c1 && !c1.ok && /owner/.test(c1.message) && /条件/.test(c1.message) && out.status !== 'OK', `F42: 既存の if の外に足した「owner を編集不可」→ 要確認（すべてのステータスで編集できなくなる）: ${c1 && c1.message}`);
  // 条件の中（同じ if のブロックの中）に足したコードは指摘しない
  const inside = KTCodeReview.review({ generated: genOf({ type: 'INSERT_AFTER', anchor: "      record['amount'].disabled = true;", content: "\n      record['owner'].disabled = true;" }), customization: cust, plan: null, data: DATA, scan: null, existingSource: SRC });
  assert(!chk(inside, 'unconditional-control') || chk(inside, 'unconditional-control').ok, `F42: 同じ if の中に足したコードは指摘しない: ${JSON.stringify(inside.checks.filter(c => !c.ok).map(c => c.name))}`);
}

// =========================================================
console.log('\n--- U9（使い勝手・実機）. キーボード操作でフォーカスの位置が見える（kintone の CSS が枠を消していた）---');
{
  const SRC = require('fs').readFileSync(require('path').join(__dirname, '..', 'kintoneAppToolkit.user.js'), 'utf8');
  assert(/#kt-toolkit button:focus-visible[^{]*\{outline:2px solid #2563eb !important/.test(SRC) && /#kt-toolkit textarea:focus-visible/.test(SRC), 'U9: Toolkit のボタン・入力欄・タブはキーボードで移ったときに枠を出す（:focus-visible・!important で kintone の outline:none より優先）');
}

// =========================================================
console.log('\n--- F40（CX-3 3 回目・実機）. 同じ既存の設定を 2 つの手順が変更する（後の手順が前を上書きする）---');
{
  // 実機と同じ形: 「申請する」を P1 で 100 万円以上 → 承認待ち、P2 で 100 万円未満 → 承認済み（どちらも UPDATE_PROCESS。分岐なら 2 本目は ADD_PROCESS_ACTION）
  const p = plan([
    step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', to: '承認待ち', filterCond: 'amount >= "1000000"', changeKind: 'ACTION_CONDITION' }),
    step('P2', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', to: '完了', filterCond: 'amount <= "999999"', changeKind: 'ACTION_CONDITION' }, { dependsOn: ['P1'] }),
  ]);
  const rv = reviewOf(p);
  const c = rv.conflicts.find(x => x.code === 'PLAN_INTERNAL_SAME_TARGET');
  assert(c && c.severity === 'high' && c.stepIds.includes('P1') && c.stepIds.includes('P2') && /申請する/.test(c.message) && /上書き/.test(c.message), `F40: 同じアクション「申請する」を 2 つの手順が変更 → PLAN_INTERNAL_SAME_TARGET（以前は副作用の「承認待ちへ進む道が無くなる」だけ）: ${c && c.message}`);
  const ar = KTPlanExecutor.applyReadiness(p, rv);
  assert(ar.every(a => a.apply === 'BLOCKED') && ar.some(a => a.reason === 'SAME_TARGET_IN_PLAN'), `F40: その手順はどちらも自動で反映しない: ${ar.map(a => a.stepId + ':' + a.apply + '(' + a.reason + ')').join(' ')}`);
  // 別々の設定（別のアクション）を変える手順は従来どおり
  const ok = plan([
    step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', to: '承認待ち', filterCond: 'amount >= "1000000"', changeKind: 'ACTION_CONDITION' }),
    step('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '申請する（少額）', { name: '申請する（少額）', from: '未処理', to: '完了', filterCond: 'amount <= "999999"' }),
  ]);
  assert(!reviewOf(ok).conflicts.some(x => x.code === 'PLAN_INTERNAL_SAME_TARGET'), 'F40: 既存アクションの変更 ＋ 新しいアクションの追加（分岐の正しい書き方）は指摘しない');
}

// =========================================================
console.log('\n--- F38（CX-1 2 回目・実機）. 既存ファイルの即時関数の外に足したコード（ファイル直下の宣言）を見逃さない ---');
{
  const DL = ["(function () {", "  'use strict';", "  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {", "    const record = event.record;", "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {", "      record['amount'].disabled = true;", "    }", "    return event;", "  });", "})();", ""].join('\n');
  const baseHash = KTScan.analyzeFile({ name: 'dealLock.js', target: 'desktop', kind: 'js', text: DL }, { fields: [], selfAppId: null }).file.hash;
  const ADD = "  // 承認済みはモバイルでも金額を編集不可\n  const EVENTS = ['mobile.app.record.create.show', 'mobile.app.record.edit.show'];\n  kintone.events.on(EVENTS, function (event) {\n    if (event.record['ステータス'] && event.record['ステータス'].value === '承認済み') { event.record['amount'].disabled = true; }\n    return event;\n  });\n";
  const cust = { customizationId: 'C1', requirement: '承認済みは金額を編集不可（PC・モバイル）', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop', 'mobile'], events: ['app.record.create.show', 'app.record.edit.show', 'mobile.app.record.create.show', 'mobile.app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [{ name: 'dealLock.js', target: 'desktop' }] };
  const genOf = (op) => ({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', code: ADD, patch: { baseHash, operations: [op] }, events: cust.events, fields: cust.fields, apis: ['kintone.events.on'] });
  const chk = (r, n) => r.checks.find(c => c.name === n) || null;
  // 実機と同じ: APPEND（anchor「})();」）→ 即時関数の外（ファイル直下）に const EVENTS
  const out = KTCodeReview.review({ generated: genOf({ type: 'APPEND', anchor: '})();\n', content: ADD }), customization: cust, plan: null, data: DATA, scan: null, existingSource: { name: 'dealLock.js', target: 'desktop', text: DL } });
  assert(chk(out, 'globals') && !chk(out, 'globals').ok && /EVENTS/.test(chk(out, 'globals').message) && /即時関数の中/.test(chk(out, 'globals').message) && out.status !== 'OK', `F38: 既存ファイルへの統合でも、即時関数の外に足した宣言はグローバル汚染として要確認（以前は「即時関数の外に宣言はありません」）: ${chk(out, 'globals') && chk(out, 'globals').message}`);
  // 即時関数の中（閉じる行の前）に入れたコードは従来どおり
  const inside = KTCodeReview.review({ generated: genOf({ type: 'INSERT_BEFORE', anchor: '})();', content: ADD }), customization: cust, plan: null, data: DATA, scan: null, existingSource: { name: 'dealLock.js', target: 'desktop', text: DL } });
  assert(chk(inside, 'patch').ok && chk(inside, 'globals').ok, `F38: 即時関数の中に入れたコードは指摘しない: ${JSON.stringify(inside.checks.filter(c => !c.ok).map(c => c.name))}`);
}

// =========================================================
console.log('\n--- F39（CX-1 2 回目・実機）. PC とモバイルの計画: モバイルのイベントを含むコードはモバイルにも登録する ---');
{
  // 実機: dealLock.js（PC だけに登録されている）へモバイルのイベントを統合 → 登録の確認は「PC：2 件変更・Mobile：変更なし」= モバイルでは読み込まれない
  const DL = ["(function () {", "  'use strict';", "  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {", "    const record = event.record;", "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {", "      record['amount'].disabled = true;", "    }", "    return event;", "  });", "})();", ""].join('\n');
  const ADD = "  kintone.events.on(['mobile.app.record.create.show', 'mobile.app.record.edit.show'], function (event) {\n    if (event.record['ステータス'] && event.record['ステータス'].value === '承認済み') { event.record['amount'].disabled = true; }\n    return event;\n  });\n";
  const SRC = { name: 'dealLock.js', target: 'desktop', text: DL };
  const baseHash = KTScan.analyzeFile({ name: 'dealLock.js', target: 'desktop', kind: 'js', text: DL }, { fields: [], selfAppId: null }).file.hash;
  const cust = { customizationId: 'C1', requirement: '承認済みは金額を編集不可（PC・モバイル）', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop', 'mobile'], events: ['app.record.create.show', 'app.record.edit.show', 'mobile.app.record.create.show', 'mobile.app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [{ name: 'dealLock.js', target: 'desktop' }] };
  const gen = { strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', summary: 'モバイルでも金額を編集不可', code: ADD, patch: { baseHash, operations: [{ type: 'INSERT_BEFORE', anchor: '})();', content: ADD }] }, events: cust.events, fields: cust.fields, apis: ['kintone.events.on'], assumptions: [], warnings: [] };
  const rv = KTCodeReview.review({ generated: gen, customization: cust, plan: null, data: DATA, scan: null, existingSource: SRC });
  const r = KTJsExecutor.changeFromGenerated({ customization: cust, generated: gen, review: rv, existingSource: SRC });
  assert(r.ok && r.change.target === 'desktop' && r.change.kind === 'REPLACE_FILE', '前提: PC の dealLock.js を差し替える変更');
  const mob = typeof KTJsExecutor.mobileCompanionOf === 'function' ? KTJsExecutor.mobileCompanionOf(r.change, { customization: cust, mobileNames: [] }) : { ok: false };
  assert(mob.ok && mob.change.target === 'mobile' && mob.change.kind === 'ADD_FILE' && mob.change.name === 'dealLock.js' && mob.change.content === r.change.content && mob.change.changeId !== r.change.changeId, 'F39: PC とモバイルの計画でモバイルのイベントを含むコード → モバイルにも同じ本文を追加する変更');
  // 登録（mock）: PC は差し替え・モバイルは追加 → 復元で両方とも元に戻る
  const data = clone(DATA);
  data.customize = { scope: 'ALL', desktop: { js: [{ type: 'FILE', file: { contentType: 'text/javascript', fileKey: 'dl:lock', name: 'dealLock.js', size: '100' } }], css: [] }, mobile: { js: [], css: [] }, revision: '5' };
  const m = makeKintoneMock(data, { jsSources: [{ name: 'dealLock.js', target: 'desktop', text: DL }] });
  const rows = KTDeps.normalizeFields(data.fields).map(f => ({ code: f.code, label: f.label, type: f.rawType }));
  if (mob.ok) {
    const prep = await KTJsExecutor.prepare({ appId: '310', changes: [r.change, mob.change] }, { api: m.api });
    assert(prep.status === 'PREPARED' && prep.summary.byTarget.desktop.replace === 1 && prep.summary.byTarget.mobile.add === 1, `F39: 確認画面の件数は PC：差し替え 1・モバイル：追加 1（${JSON.stringify(prep.summary.byTarget)}）`);
    const ex = await KTJsExecutor.executePreview(prep, { api: m.api, fieldRows: rows });
    const mobJs = m.st.customize.mobile.js;
    assert(ex.status === 'DONE' && ex.steps.every(s => s.status === 'VERIFIED') && mobJs.length === 1 && m.st.files.get(mobJs[0].fileKey).content.includes("mobile.app.record.edit.show"), `F39: 登録で PC・モバイルとも VERIFIED、モバイルの一覧に dealLock.js（${ex.status} / ${ex.steps.map(s => s.target + ':' + s.status).join(',')}）`);
    const rb = await KTJsExecutor.prepareRollback(ex, { api: m.api });
    await KTJsExecutor.executeRollback(rb, { api: m.api, execution: ex });
    assert(m.st.customize.mobile.js.length === 0 && m.st.customize.desktop.js.length === 1 && m.st.files.get(m.st.customize.desktop.js[0].fileKey).content === DL, 'F39: 復元でモバイルの追加も取り消し、PC は元の本文');
  }
  // 実機（F39 の確認）: 計画のフィールドは担当者だけ・既存の dealLock.js は金額を編集不可にしている → モバイルの追加ファイルには既存の処理も入るので、
  //   新規ファイルとして厳密に照合すると「計画に無い書き込み amount」で VERIFY_FAILED になった。既存ファイルを写したモバイル側は統合と同じ照合にする
  {
    // Phase 21: PC とモバイルの両方が対象なら、担当者のロックは両方の画面の処理に入れる（モバイルだけだと F41 の不具合として登録不可）
    const ADD2 = "  kintone.events.on(['app.record.create.show', 'app.record.edit.show', 'mobile.app.record.create.show', 'mobile.app.record.edit.show'], function (event) {\n    if (event.record['ステータス'] && event.record['ステータス'].value === '承認済み') { event.record['owner'].disabled = true; }\n    return event;\n  });\n";
    const cust2 = { ...cust, fields: [{ code: 'owner', access: 'CONTROL' }], events: ['app.record.create.show', 'app.record.edit.show', 'mobile.app.record.create.show', 'mobile.app.record.edit.show'] };
    const gen2 = { ...gen, code: ADD2, patch: { baseHash, operations: [{ type: 'INSERT_BEFORE', anchor: '})();', content: ADD2 }] }, events: cust2.events, fields: cust2.fields };
    const rv2 = KTCodeReview.review({ generated: gen2, customization: cust2, plan: null, data: DATA, scan: null, existingSource: SRC });
    const r2 = KTJsExecutor.changeFromGenerated({ customization: cust2, generated: gen2, review: rv2, existingSource: SRC });
    const mob2 = KTJsExecutor.mobileCompanionOf(r2.change, { customization: cust2, mobileNames: [] });
    const data2 = clone(data); data2.customize.mobile.js = [];
    const m2 = makeKintoneMock(data2, { jsSources: [{ name: 'dealLock.js', target: 'desktop', text: DL }] });
    const prep2 = await KTJsExecutor.prepare({ appId: '310', changes: [r2.change, mob2.change] }, { api: m2.api });
    const ex2 = await KTJsExecutor.executePreview(prep2, { api: m2.api, fieldRows: rows, acknowledged: (prep2.confirmations || []).map(x => x.key) });   // Phase 21: 確認が必要な項目（既存のイベントに handler を足す）を確認した
    const ms = ex2.steps.find(s => s.target === 'mobile') || {};
    assert(ex2.status === 'DONE' && ms.status === 'VERIFIED', `F39: 既存ファイルを写したモバイル側は、既存の処理（amount）を計画外の書き込みとして扱わない: ${ex2.status} / ${ms.status} ${JSON.stringify((ms.verification?.checks || []).filter(c => !c.ok).map(c => c.name + ':' + JSON.stringify(c.actual)))}`);
  }
  // モバイルのイベントが無い・PC だけの計画・モバイルに同じ名前のファイルがある → 追加しない（最後は理由を返す）
  const pcOnly = KTJsExecutor.mobileCompanionOf ? KTJsExecutor.mobileCompanionOf({ ...r.change, content: DL }, { customization: cust, mobileNames: [] }) : { ok: true };
  const notMobile = KTJsExecutor.mobileCompanionOf ? KTJsExecutor.mobileCompanionOf(r.change, { customization: { ...cust, platform: ['desktop'] }, mobileNames: [] }) : { ok: true };
  const exists = KTJsExecutor.mobileCompanionOf ? KTJsExecutor.mobileCompanionOf(r.change, { customization: cust, mobileNames: ['dealLock.js'] }) : { ok: true };
  assert(!pcOnly.ok && !notMobile.ok && !exists.ok && exists.reason === 'MOBILE_FILE_EXISTS' && /手作業/.test(exists.message || ''), 'F39: モバイルのイベントが無い / PC だけの計画では追加しない。モバイルに同じ名前のファイルがあれば自動では更新せず理由を示す');
}

// =========================================================
console.log('\n--- F35 / F36（XA-7 / XA-9 実機）. 関連レコードの設定の場所・別のアプリへの手順 ---');
{
  // F35a: 関連レコードの fact に並び順・件数・絞り込み（実機 XA-7a で AI が「今の表示設定（表示項目と並び順）を教えて」と利用者に聞いた）
  const ctx = KTContext.buildPlan({ goal: '見積一覧に担当も表示して新しい順にして', data: DATA, deps: DEPS, scan: null, incoming: null, options: { now: '2026-10-02T00:00:00.000Z' } });
  const rf = ctx.facts.find(f => f.kind === 'field' && f.field?.code === 'quotes');
  assert(rf && rf.field.referenceTable && rf.field.referenceTable.size === '5' && 'sort' in rf.field.referenceTable && /関連レコード/.test(rf.statement) && /quote_no/.test(rf.statement), `F35: 関連レコードの fact に表示項目・並び順・件数（statement にも）: ${rf && rf.statement}`);
  // F35b: 一覧（ビュー）の手順の対象が関連レコードのフィールド（実機 XA-7a: UPDATE_VIEW の targetRef に support_history。Gateway の「存在しない VIEW」だけでは理由が分からない）
  const pB = plan([step('P1', 'UPDATE_VIEW', 'VIEW', 'quotes', { fields: ['quote_no', 'amount', 'owner_q'], sort: 'レコード番号 desc' }, { validation: { status: 'invalid', issues: ['存在しないVIEW「quotes」を既存として参照しています'] } })]);
  const sB = reviewOf(pB).steps[0];
  assert(sB.issues.some(i => i.code === 'REFERENCE_TABLE_NOT_VIEW' && /関連レコード/.test(i.message) && /反映しません/.test(i.message)), 'F35: 一覧の手順の対象が関連レコード（フィールド）→ 設定の場所と、Toolkit は反映しないことを示す');
  const pB2 = plan([step('P1', 'UPDATE_VIEW', 'VIEW', '見積一覧', { fields: ['quote_no', 'amount'], sort: 'レコード番号 desc' })]);
  const rvB2 = reviewOf(pB2);
  assert(rvB2.steps[0].issues.some(i => i.code === 'REFERENCE_TABLE_NOT_VIEW') && KTPlanExecutor.applyReadiness(pB2, rvB2)[0].apply !== 'AUTO', 'F35: Gateway が通しても（ラベルで指定）関連レコードを一覧として反映しない');
  // F35c: 依頼が参照元アプリの画面の関連レコード一覧を指すのに、計画はこのアプリの一覧を追加（実機 XA-7b: 対応履歴から「案件の画面に出ている対応履歴の一覧」→ 対応履歴アプリに一覧を追加・「問題は見つかりませんでした」）
  const data2 = clone(DATA);
  data2.relatedApps['500'].fields.deal_history = { type: 'REFERENCE_TABLE', code: 'deal_history', label: '案件履歴', referenceTable: { relatedApp: { app: String(FX.SELF_APP), code: '' }, condition: { field: 'code', relatedField: 'customer_code' }, displayFields: ['case_name'], sort: 'レコード番号 desc', filterCond: '', size: '5' } };
  const stepsC = [step('P1', 'ADD_VIEW', 'VIEW', '案件履歴（担当表示）', { name: '案件履歴（担当表示）', fields: ['case_name', 'owner'], sort: 'レコード番号 desc' })];
  const rvC = reviewOf(plan(stepsC, [], { goal: '顧客マスタの画面に出ている案件履歴の一覧に、担当も表示して新しい順にしたい' }), data2);
  const wC = rvC.warnings.find(w => w.code === 'RELATED_RECORDS_IN_OTHER_APP');
  assert(wC && /App 500/.test(wC.message) && /案件履歴/.test(wC.message) && wC.stepIds.includes('P1'), `F35: 依頼の一覧は参照元アプリの関連レコード → このアプリの一覧を変えても変わらないと指摘: ${wC && wC.message}`);
  assert(!reviewOf(plan(stepsC, [], { goal: '案件履歴の一覧に担当も表示して新しい順にしたい' }), data2).warnings.some(w => w.code === 'RELATED_RECORDS_IN_OTHER_APP'), 'F35: 依頼に別のアプリの名前が無ければ（このアプリの一覧の話）指摘しない');

  // F36: 別のアプリへの手順（実機 XA-9: 「顧客マスタに顧客ランクを追加」を ADD_FIELD ＋ destApp 351 で書き、Toolkit は「自動で反映できる」= このアプリに追加する状態だった）
  const p36 = plan([
    step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { name: '顧客ランク', fieldType: 'DROP_DOWN', options: ['A', 'B'], destApp: '500' }),
    step('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_2', { name: '顧客ランク', fieldType: 'SINGLE_LINE_TEXT', destApp: String(FX.SELF_APP) }),
  ], [pf('NEW_FIELD_1', '顧客ランク', 'customer_rank', 'DROP_DOWN', { options: ['A', 'B'] }), pf('NEW_FIELD_2', '顧客ランク', 'customer_rank', 'SINGLE_LINE_TEXT')], { goal: '顧客マスタに顧客ランクを追加して、案件にも表示したい' });
  const rv36 = reviewOf(p36);
  const s1 = rv36.steps.find(x => x.stepId === 'P1'), s2 = rv36.steps.find(x => x.stepId === 'P2');
  const ar36 = KTPlanExecutor.applyReadiness(p36, rv36);
  assert(s1.issues.some(i => i.code === 'OTHER_APP_STEP' && /App 500/.test(i.message) && /顧客マスタ/.test(i.message)) && s1.safety === 'PLAN_ONLY' && ar36.find(a => a.stepId === 'P1').apply === 'MANUAL', `F36: 別のアプリ（App 500）への ADD_FIELD は計画のみ（このアプリには追加しない）: ${s1.safety} ${ar36.find(a => a.stepId === 'P1').apply}`);
  assert(!s2.issues.some(i => /DUPLICATE/.test(i.code)) && ar36.find(a => a.stepId === 'P2').apply === 'AUTO', `F36: このアプリへの手順（コピー先の新規フィールド）は従来どおり。別のアプリの同じコードと重複扱いにしない: ${JSON.stringify(s2.issues.map(i => i.code))} ${ar36.find(a => a.stepId === 'P2').apply}`);
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
console.log('\n--- U8（Phase 20・利用者の指摘）. 確認事項は質問ごとの回答欄で答え、入力した回答だけを計画の修正として送る ---');
{
  const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] } } }, usage: { monthlyLimit: 200, usedThisMonth: 1 } };
  const respOf = (goal) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'pl-u8', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 200 } }, plan: { goal, solution: 'STANDARD', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], gaps: [], evidenceIds: [] }, relevantFields: [], proposedFields: [], steps: [step('P1', 'ADD_VIEW', 'VIEW', '高額案件', { name: '高額案件', fields: ['amount'] })], alternatives: [], impact: [], questions: [{ id: 'Q1', question: '高額とはいくらからですか？' }, { id: 'Q2', question: '一覧に表示する項目は金額だけでよいですか？' }], unknowns: [], planConfidence: 'INFERRED', customizations: [] } });
  const calls = [];
  const client = { async getHealth() { return HEALTH; }, async plan({ ctx, requestId }) { calls.push(ctx); const v = KTAiClient.validatePlan(respOf(ctx.goal), ctx); return { ...v.normalized, requestId, clientWarnings: v.warnings }; } };
  const storage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' }); settings.setConsent(true);
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const host = makeFakeHost();
  const panel = mountAiWorkspace(host, { getInputs: () => ({ data: DATA, deps: DEPS, scan: null, incoming: null }), copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false }, executor: { api: makeKintoneMock(DATA).api, appId: '310' } });
  const $ = (id) => host.querySelector(`#${id}`);
  const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
  const click = (dataset) => $('kt-ai-chat').dispatch({ type: 'click', target: { dataset } });
  await ticks();
  await panel.send('高額案件の一覧を作りたい'); await ticks();
  const v1 = panel.conversation().activePlan();
  const html1 = $('kt-ai-chat').innerHTML;
  assert(/kt-ai-questions-card/.test(html1) && (html1.match(/class="kt-ai-qa-input"/g) || []).length === 2 && /data-act="answer-questions"/.test(html1) && /高額とはいくらからですか？/.test(html1), 'U8: 確認事項ごとに回答欄（2 件）と［回答を送って計画を直す］');
  // 空のまま押しても送らない（AI の利用回数を使わない）
  await click({ act: 'answer-questions', plan: v1.planId, version: String(v1.version) }); await ticks();
  assert(calls.length === 1 && /回答を 1 つ以上入力してください/.test($('kt-ai-composer-note').textContent || ''), 'U8: 回答が空なら送らない');
  // 入力した回答は再描画しても残る
  // 会話の応答性（2026-10-05）で意図して更新: 回答欄のキーは台帳の項目（版をまたいで同じ。Q 番号は版ごとに振り直される）
  const q1 = panel.conversation().answerContext().open.find(q => q.key === 'Q1');
  await $('kt-ai-chat').dispatch({ type: 'input', target: { dataset: { qkey: `${v1.planId}:e:${q1.entryId}` }, value: '100万円以上' } });
  await click({ act: 'show-all' }); await ticks();
  assert(/>100万円以上<\/textarea>/.test($('kt-ai-chat').innerHTML), 'U8: 入力中の回答は再描画しても残る');
  // 送る: 入力した回答だけ（未回答も伝える）を計画の修正として 1 回だけ AI へ
  await click({ act: 'answer-questions', plan: v1.planId, version: String(v1.version) }); await ticks(8);
  const last = calls[calls.length - 1];
  // 会話の応答性（2026-10-05）で意図して更新: 送る文は版ごとに振り直される番号（Q1 / 未回答: Q2）ではなく質問文で書き、回答は構造化した決定事項（ctx.decisions）でも送る
  assert(calls.length === 2 && last.revision && /質問「高額とはいくらからですか？」）：100万円以上/.test(last.revision.request) && /まだ答えていない確認事項：「一覧に表示する項目は金額だけでよいですか？」/.test(last.revision.request) && !/\bQ[12]\b/.test(last.revision.request) && panel.conversation().activePlan().version === 2, `U8: 回答は計画の修正として送られ v2 になる（未回答の質問も質問文で伝える。Q 番号は使わない）: ${last.revision && last.revision.request}`);
  assert(Array.isArray(last.decisions) && last.decisions.length === 1 && last.decisions[0].answer === '100万円以上' && last.decisions[0].source === 'answer-card' && last.decisions[0].status === 'answered' && /^D[1-9]/.test(last.decisions[0].id), `U8: 回答欄の回答は決定事項（出典 answer-card）として Planner Context に載る: ${JSON.stringify(last.decisions)}`);
  assert(panel.conversation().messages().some(m => m.type === 'USER' && /確認事項への回答/.test(m.text)), 'U8: 送った回答は会話に利用者の発言として残る');
  const html2 = $('kt-ai-chat').innerHTML;
  // 同じ Q1・Q2 を AI がもう一度質問した（respOf は毎回同じ質問を返す）→ 回答済みの Q1 は回答欄を出さず「回答済み」と示す（再質問として数える）。Q2 だけ回答欄
  assert((html2.match(/class="kt-ai-qa-input"/g) || []).length === 1 && /回答済み：[^<]*→ 100万円以上/.test(html2) && /新しい版があります/.test(html2) && panel.conversation().metrics().reasked === 1, `U8: 回答欄は最新の版の未回答の確認事項だけ（回答済みの再質問は出さない・古い版は読むだけ）: reasked=${panel.conversation().metrics().reasked}`);
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
