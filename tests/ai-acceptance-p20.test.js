// Phase 20 受け入れテストで見つかった不具合の回帰テスト（実機 staging の P20 専用アプリで再現したものを fixture で固定する）
//
// 検証内容:
//   F1 文書: 計画のある会話では、どの種類のドキュメントでも Markdown / JSON に変更の記録（手順・状態・確認事項・運用環境は未反映）を入れる。Context が運用環境の設定であることを明記
//   F2 復元: リマインダーを一度も設定していないアプリ（timezone null）で ADD_REMINDER → 復元しても ROLLBACK_VERIFIED（timezone は API で null に戻せない）。復元の失敗は作業状態で「要確認」
//   F3 反映の可否: 承認の前に手順ごとの「自動で反映できるか」（KTPlanExecutor.applyReadiness）。ルックアップのコピー先の新規リンクは取得元のリンクの種類を引き継いで追加できる
//   F4 / F5 Code Review: error を '' で消す（kintone は null だけ）を BLOCKED。同じ show / change イベントで error と disabled / value を設定（kintone が取り消す）は、
//     C-1 第 2 段（§0d.4）から生成工程（Gateway の check behavior と模擬テスト）が判定し、Toolkit はその結果（返却の欠落・behavior の fail）を取り込んで登録不可にする
//   F7 相談: 相談開始時に取得した本文を Planner Context と Review に使う（Scanner がキャッシュ復元で本文なしでも「未取得」と言わない）
//   GM-6 / FR-9: 会話を切り替えた後に遅れて返った応答・エラーを新しい会話に入れない。新しい相談を始めると送信中の要求を中断する
//   U2 / U3: 利用者向けの文言に Executor / Tier を出さない・最終確認に未回答の確認事項を出す
//   FR-1 / FR-2 / FR-6 / FR-7: 計画の要求のタイムアウト・不完全な応答・Gateway の MODEL_OUTPUT_INVALID で計画を登録せず入力を残す。
//     送信中の再クリックで要求を重ねない。再試行で計画が 1 件だけ登録される（実際の AI client と transport を通す）
//
// 実行方法: node tests/ai-acceptance-p20.test.js
'use strict';
// 実行が 10 秒を超えると、スクリプトの入口（waitReady の 10 秒の待ちの後に kintone.app.getId() を呼ぶ）が動く。テストには kintone が無いので、その 1 件だけを無視する
//   （C-1 第 3 段で画面の試験を新しい流れ（仮案 → 採用 → 最終案）に移したため、実行が 10 秒を超えることがある。ai-two-pane と同じ扱い）
const ignoreNoKintone = (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); };
process.on('unhandledRejection', ignoreNoKintone);
process.on('uncaughtException', ignoreNoKintone);
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
//   簡素化（2026-10-17）: 反映できるかは、最新の版なら会話の今の判定、前の版なら最終案の記録で確かめる（tests/helpers/final-state.js）
const FS = require('./helpers/final-state.js');
const { withDevBase } = require('./helpers/dev-base-fake.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const T = loadToolkit();
const { KTDeps, KTScan, KTContext, KTContextUi, KTAiClient, KTAiConversation, KTAiWorkspaceViewModel: VM, KTAiChatUi, KTPlanReview, KTPlanExecutor, KTCodeReview, KTJsExecutor, mountAiWorkspace } = T;
// C-1 第 3 段（2026-10-08）: 古い確認の流れ（質問カード・仕様の確定・従来の生成）を前提にしていた試験は、共有の部品で新しい流れ（仮案 → 採用 → 最終案 → 承認）の上に移した
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
//   画面の試験の共通: health の assistant-qa に会話の能力（proposal）を足し、client.propose は共有の部品の台本で答える。
//   依頼は台本の 4 発言（K.REQUESTS）で仮案 → 採用 → 計画（試験ごとの client.plan）→ 最終案まで進める
const withProposal = (h) => { const x = JSON.parse(JSON.stringify(h)); x.registry.toolkit['assistant-qa'].conversation = ['requirements', 'stream', 'proposal', 'itemIds']; return x; };
const proposeByScript = async ({ ctx, requestId }) => { const raw = K.script({ utterance: ctx.question, previous: ctx.conversation.proposal, requirements: ctx.conversation.requirements }); if (!raw) throw new Error(`台本がありません: ${ctx.question}`); return K.normalized(raw, requestId, null, ctx.conversation); };
const adoptOnPanel = (panel) => K.adoptOnScreen({ panel, conv: () => panel.conversation() });
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const { gwWithBody } = require('./helpers/gw-hash.js');

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
  //   簡素化 B（2026-10-17）: エラー表示を ''（空文字）で消す書き方（error-clear）と、その判定に使った handler の操作の解析（kintoneFieldOps）は Toolkit だけの規則で、
  //   生成のときの候補の検査は生成工程（Gateway）の検証結果が正本になったので削除した（Gateway には移植していない。生成工程の検査に無い規則は増やさない）。
  //   Toolkit の形式確認はこの書き方で止めない（以前の期待: BLOCKED・error-clear）。同じ show イベントの error と disabled の競合（F5）は以前から生成工程の模擬テストの範囲
  const BAD = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.change.amount'], function (event) {\n    const f = event.record['amount'];\n    f.error = Number(f.value || 0) > 1000000 ? '金額が100万円を超えています。' : '';\n    return event;\n  });\n})();";
  const custom = { customizationId: 'C1', requirement: '金額が100万円を超えたら警告', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.edit.change.amount'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [] };
  const rv = KTCodeReview.review({ generated: { strategy: 'NEW_JS_FILE', targetFile: 'warn.js', code: BAD, patch: null, events: custom.events, fields: custom.fields, apis: [] }, customization: custom, plan: null, data: DATA, scan: null, existingSource: null });
  assert(typeof KTCodeReview.kintoneFieldOps === 'undefined' && !rv.checks.some(c => c.name === 'error-clear') && rv.status !== 'BLOCKED', `F4（簡素化 B）: エラー表示の解除の書き方は Toolkit の形式確認で止めない（生成工程の検査の範囲）: ${JSON.stringify(rv.checks.map(c => c.name))}`);
}

// =========================================================
console.log('\n--- BF-C（再 3）/ F24. エラー表示と編集不可: 条件で分けたコードは要確認・別 handler / 別ファイルも見る（実機の生成コード 2 本）---');
{
  const DEAL_LOCK = "(function () {\n  'use strict';\n  // 承認済みの案件は金額を変更できないようにする（既存の運用ルール）\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();";
  // 1 本目（実機: 承認済み・1,000,001 で金額が編集できるようになった）: 別 handler で、条件なしに error を設定
  const SEPARATE = DEAL_LOCK.replace("})();", "  // 金額が100万円を超えたら警告を表示する\n  function checkAmountWarning(event) {\n    const record = event.record;\n    if (record['amount']) {\n      record['amount'].error = (record['amount'].value > 1000000) ? '100万円を超えています' : null;\n    }\n    return event;\n  }\n\n  kintone.events.on([\n    'app.record.create.show',\n    'app.record.edit.show',\n    'app.record.create.change.amount',\n    'app.record.edit.change.amount'\n  ], checkAmountWarning);\n})();");
  // 2 本目（実機: 承認済みは編集不可のまま・警告なし。編集できるときだけ警告）: disabled を読む条件で分け、編集不可なら null
  const GUARDED = "(function () {\n  'use strict';\n  // 金額が100万円超なら警告表示（承認済みかつ編集不可なら非表示）\n  function checkAmountWarning(event) {\n    const record = event.record;\n    const amount = record['amount'].value;\n    const status = record['ステータス'] ? record['ステータス'].value : '';\n    const disabled = record['amount'].disabled;\n    if (amount > 1000000 && !(status === '承認済み' && disabled)) {\n      record['amount'].error = '100万円を超えています';\n    } else {\n      record['amount'].error = null;\n    }\n    return event;\n  }\n\n  // 画面表示時の処理に警告表示を追加\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function(event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    return checkAmountWarning(event);\n  });\n\n  // 金額変更時の警告表示更新\n  kintone.events.on(['app.record.create.change.amount', 'app.record.edit.change.amount'], checkAmountWarning);\n})();\n";
  // 条件で分けた警告（kintoneFieldOps の errorGuarded）・別 handler の条件なしの警告（error-cancels-edit）の判定は、C-1 第 2 段（§0d.4）で Toolkit の形式確認から外した。
  //   生成工程で守る: AI版 worker/test/cases/required-effects.mjs「§0d.1 S7（既知の競合）」（排他的な分岐の正しい候補を機械検査で止めない・判定は動作テスト）、
  //   sandbox/test/run.mjs「R12 …: 承認待ちでは amount が編集不可（取り消し無し）」「R13 同じファイルの別 handler」「p21 分けた警告」「p21 分けない警告」
  const custom = { customizationId: 'C1', requirement: '金額が100万円を超えたら警告', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.create.show', 'app.record.edit.show', 'app.record.create.change.amount', 'app.record.edit.change.amount'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [] };
  const gen = (code) => ({ strategy: 'NEW_JS_FILE', targetFile: 'warn.js', code, patch: null, events: custom.events, fields: custom.fields, apis: [] });
  const chk = (r, n) => r.checks.find(c => c.name === n) || null;
  // F5（実機 1 本目・SEPARATE）: 動作テストの結果が無い間は登録不可・模擬テストで編集不可の取り消しが見つかれば登録不可。
  //   §0d.4: 競合の断定は生成工程（Gateway の check behavior・candidate-error-same-event と模擬テスト）。Toolkit は返却の欠落と明示された失敗を取り込む（attachBehavior）
  const rSep = KTCodeReview.review({ generated: gen(SEPARATE), customization: custom, plan: null, data: DATA, scan: null, existingSource: null });
  const REQ_SEP = [{ requirementId: 'C1', field: 'amount', effect: 'lock', events: ['app.record.edit.show'], condition: 'ステータス in ("承認済み")' }];
  const GW_SEP_RE = [{ requirementId: 'C1', field: 'amount', effect: 'lock', status: 'present', check: 'behavior', checkReason: ['candidate-error-same-event'], events: [{ event: 'app.record.edit.show', status: 'present' }] }];
  const GW_SEP_FAIL = { requiredEffects: GW_SEP_RE, behavior: { status: 'failed', reason: null, cases: [{ id: 'k1', field: 'amount', effect: 'lock', expect: 'lock', event: 'app.record.edit.show', side: 'match', verdict: 'fail', message: '承認済みで金額が編集できます（同じイベントの error で編集不可が取り消されました）' }] } };
  const sepNone = KTCodeReview.attachBehavior(rSep, null, { requiredEffects: REQ_SEP, customization: custom });
  const sepFail = KTCodeReview.attachBehavior(rSep, GW_SEP_FAIL, { requiredEffects: REQ_SEP, customization: custom });
  assert(sepNone.status === 'BLOCKED' && sepNone.registration.verdict === 'BLOCKED' && (chk(sepNone, 'required-effects') || {}).severity === 'block', `F5（実機 1 本目）: 別 handler でも条件なしに同じ表示イベントで error → 生成工程の結果が無い間は登録不可（返却の欠落）: ${sepNone.registration.verdict}`);
  assert(sepFail.status === 'BLOCKED' && sepFail.registration.verdict === 'BLOCKED' && (chk(sepFail, 'behavior-fail') || {}).severity === 'block' && /取り消され/.test((chk(sepFail, 'behavior-fail') || {}).message || ''), `F5（実機 1 本目）: 模擬テストで編集不可の取り消しが見つかった（Gateway の behavior の fail）→ 登録不可: ${sepFail.registration.verdict} ${(chk(sepFail, 'behavior-fail') || {}).message}`);
  const rGuard = KTCodeReview.review({ generated: gen(GUARDED), customization: custom, plan: null, data: DATA, scan: null, existingSource: null });
  assert(rGuard.status !== 'BLOCKED', 'F24（実機 2 本目）: 編集不可を見る条件で分けたコードは形式確認で停止しない（競合の有無は生成工程の模擬テストで確かめる）');
  // 別ファイル（新規 JS が条件なしに show で error、既存の dealLock.js が同じ show で disabled）の判定は、C-1 第 3 段（2026-10-08）で
  //   Toolkit の形式確認から外した（error-cancels-other-js・errorGuarded は削除）。守り手は生成工程の模擬テスト（Gateway の cause candidate-cancels-existing-lock の fail）で、
  //   Toolkit はその fail をほかの fail と同じく未解決（承認できない）として取り込む。既存 JS の編集不可の条件（承認済みなど）が代表条件で成り立たず
  //   取り消しを観測できないときは、生成工程が existing-lock-unverified の not-run を返し、Toolkit は準備未完了（［計画を直すよう依頼する］）にする。
  //   この守り手を持たない Gateway（health の印 cancelCheck が無い）は「接続先が非対応」として扱う。新しい流れの回帰: tests/ai-flow-redesign.test.js の F8-1〜F8-5・D49
  // BF-C 4 回目（実機の生成そのまま）: 既存の show handler の中に「編集不可でないときだけ警告」を追加。計画の change は登録していない
  const DL_SRC = "(function () {\n  'use strict';\n  // 承認済みの案件は金額を変更できないようにする（既存の運用ルール）\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();\n";
  const PATCH4 = { baseHash: KTScan.hashText(DL_SRC), operations: [{ type: 'INSERT_AFTER', anchor: "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }", content: "\n    // 金額が100万円を超えたら警告を表示する\n    if (record['amount'].value > 1000000 && !record['amount'].disabled) {\n      record['amount'].error = '金額が100万円を超えています。';\n    } else {\n      record['amount'].error = null;\n    }\n" }] };
  const cust4 = { ...custom, strategy: 'EXTEND_EXISTING_JS', existingFiles: [{ name: 'dealLock.js', target: 'desktop' }] };
  const r4 = KTCodeReview.review({ generated: gwWithBody({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', summary: 's', code: PATCH4.operations[0].content, patch: PATCH4, events: custom.events, fields: custom.fields, apis: ['kintone.events.on'] }, DL_SRC), customization: cust4, plan: null, data: DATA, scan: null, existingSource: { name: 'dealLock.js', target: 'desktop', text: DL_SRC } });
  //   簡素化 B（2026-10-17）: 計画のイベント（change）をコードが登録しているかは、生成工程の必須の効果（効果のイベントごとの処理の形。AI版 worker/test/cases/required-effects.mjs）が
  //   確かめる（Toolkit の planned-events・duplicate-handler は削除した）。Toolkit はその結果（missing）を登録不可として取り込む
  const REQ4 = [{ requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect: 'warn', events: ['app.record.edit.change.amount'], condition: '' }];
  const r4v = KTCodeReview.attachBehavior(r4, { version: '1', passed: false, machine: [], requiredEffects: [{ requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect: 'warn', status: 'missing', events: [{ event: 'app.record.edit.change.amount', status: 'missing' }] }], behavior: { status: 'not-run', reason: 'machine-blocked', cases: [] } }, { requiredEffects: REQ4, customization: cust4 });
  assert(chk(r4, 'patch').ok && !chk(r4, 'planned-events') && !chk(r4, 'duplicate-handler') && r4.status !== 'BLOCKED' && r4v.status === 'BLOCKED' && r4v.registration.verdict === 'BLOCKED' && chk(r4v, 'required-effects') && !chk(r4v, 'required-effects').ok,
    'F26（BF-C 4 回目・簡素化 B）: 計画の change をコードが登録していないことは、生成工程の必須の効果の結果（missing）で登録不可にする（Toolkit は同じ判定を作り直さない）');
  // F27（BF-C 4 回目）: 「C1 のコードを作り直して。金額を変更したときにも…」の後半を黙って捨てない。
  //   C-1 第 3 段（2026-10-08）: 古い確認の流れ（extraRequestIn・［この変更で確定してコードを作る］・仕様の確定）は削除した。
  //   要望付きの生成の指示は最終案を直す依頼（REVISE_PLAN・TURN_THEN_GENERATE）になり、JavaScript は最終案のパイプラインが作り直す。
  //   新しい流れの回帰: tests/ai-flow-redesign.test.js の F2-5・F3-1・R18-1
  {
    //   U6 は新しい流れの最終案（仕様は自動で確定・JavaScript は生成工程で検証済み）の版で確かめる
    const xU6 = K.makeConvC();
    await K.adoptC(xU6);
    const conv = xU6.c;
    // U6: JS の登録が検証で一致しない（VERIFY_FAILED。PUT は成功）→ 右上の見出し（workStatus）は「反映済み」でも「一部反映」でもなく「要確認」
    //   簡素化（2026-10-17）: 画面に出ていなかった作業状態（workspaceState）は削除した。見出しの状態で確かめる
    const jx = VM.jsExecutionSummary({ stage: 'done', execution: { status: 'VERIFY_FAILED', put: { ok: true }, steps: [{ name: 'dealLock.js', target: 'desktop', status: 'VERIFY_FAILED' }] } });
    const ws = VM.workStatus({ version: conv.activePlan(), current: [jx] });
    assert(jx.written && ws.key === 'attention' && ws.label === '要確認', `U6: JS 登録の検証不一致は「要確認」（「反映済み」「一部反映」と出さない）: ${JSON.stringify(ws)}`);
  }
  //   簡素化（2026-10-17）: 計画の段階で要件の文の語（「超え」「以上」など）から change イベントの不足を指摘する注意（JS_CHANGE_EVENT_MISSING）は削除した。
  //   入力中の切り替えは、必須の効果のイベント（計画の effects）と生成工程の模擬テストが扱う（F26・F27）
}

// =========================================================
console.log('\n--- BF-C（再）. スペース要素: 実在するスペースは通す・無いスペースは専用の理由で止める・Generator にスペース一覧を渡す ---');
{
  const SPACE_JS = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.change.amount'], function (event) {\n    const sp = kintone.app.record.getSpaceElement('amount_warning_space');\n    if (!sp) return event;\n    sp.textContent = Number(event.record['amount'].value || 0) > 1000000 ? '金額が100万円を超えています' : '';\n    return event;\n  });\n})();";
  const cust = { customizationId: 'C1', requirement: '金額が100万円を超えたら警告', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.edit.change.amount'], fields: [{ code: 'amount', access: 'READ' }], apis: ['kintone.events.on', 'kintone.app.record.getSpaceElement'], existingFiles: [] };
  const gen = { strategy: 'NEW_JS_FILE', targetFile: 'warn.js', code: SPACE_JS, patch: null, events: cust.events, fields: cust.fields, apis: cust.apis };
  const chk = (r, n) => r.checks.find(c => c.name === n) || null;
  //   簡素化 B（2026-10-17）: スペース要素とフィールドの存在は、反映のとき（反映の前の準備・登録の直前。existingOnly）に今の設定で確かめる（生成のときは生成工程の検査）
  const noSpace = KTCodeReview.review({ generated: gen, customization: cust, plan: null, data: DATA, scan: null, existingSource: null, existingOnly: true });
  assert(noSpace.status === 'BLOCKED' && chk(noSpace, 'space-element') && !chk(noSpace, 'space-element').ok && /amount_warning_space/.test(chk(noSpace, 'space-element').message) && chk(noSpace, 'fields').ok, 'フォームに無いスペース → space-element で止める（「存在しないフィールド」とは言わない）');
  const withLayout = clone(DATA); withLayout.layout = [{ type: 'ROW', fields: [{ type: 'NUMBER', code: 'amount' }, { type: 'SPACER', elementId: 'amount_warning_space', size: { width: '200' } }] }];
  const ok = KTCodeReview.review({ generated: gen, customization: cust, plan: null, data: withLayout, scan: null, existingSource: null, existingOnly: true });
  const atGen = KTCodeReview.review({ generated: gen, customization: cust, plan: null, data: DATA, scan: null, existingSource: null });
  assert(!chk(atGen, 'space-element') && !chk(atGen, 'fields'), '生成のとき（existingOnly でない）は、存在の確認を Toolkit で繰り返さない（生成工程の検査）');
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
  const prepared = await KTPlanExecutor.prepare(KTPlanReview.executorOutput(p, rv, ['P1']), { api: mock.api, current: await mock.current(), appId: '310' });
  const log = await KTPlanExecutor.executePreview(prepared, { api: mock.api, review: rv });
  assert(log.status === 'DONE' && mock.st.reminders.length === 1 && mock.st.timezone === 'Asia/Tokyo', '反映: リマインダー 1 件・kintone が既定の timezone を入れる');
  const rb = await KTPlanExecutor.prepareRollback(log, prepared, { api: mock.api });
  const rolled = await KTPlanExecutor.executeRollback(rb, { api: mock.api, execution: log });
  assert(rolled.status === 'ROLLED_BACK_VERIFIED' && rolled.steps[0].status === 'ROLLBACK_VERIFIED' && mock.st.reminders.length === 0 && rolled.verification.restoredToSnapshot === true, 'F2: 通知 0 件に戻れば ROLLED_BACK_VERIFIED（timezone の null → 既定値は差分にしない）');
  // 通知があるときの timezone の違いは従来どおり差分（設定済み同士）
  const data2 = clone(DATA); data2.reminderNotify = { notifications: [], timezone: 'UTC', revision: '4' };
  const mock2 = makeKintoneMock(data2);
  const prep2 = await KTPlanExecutor.prepare(KTPlanReview.executorOutput(p, reviewOf(p, data2), ['P1']), { api: mock2.api, current: await mock2.current(), appId: '310' });
  const log2 = await KTPlanExecutor.executePreview(prep2, { api: mock2.api, review: reviewOf(p, data2) });
  const rb2 = await KTPlanExecutor.prepareRollback(log2, prep2, { api: mock2.api });
  const rolled2 = await KTPlanExecutor.executeRollback(rb2, { api: mock2.api, execution: log2 });
  assert(rolled2.status === 'ROLLED_BACK_VERIFIED' && mock2.st.timezone === 'UTC', 'timezone が設定済み（UTC）のアプリは snapshot の timezone で戻す');
  // 実機 354: 通知時刻の無いリマインダーは「問題なし」と出さず確認事項（Executor は時刻が無いと反映しない）
  const pNoTime = plan([step('P1', 'ADD_REMINDER', 'NEW_SETTING', '対応日7日後', { name: '対応日7日後', timingField: 'due_date', daysLater: 7, targets: ['FIELD_ENTITY:owner'] })]);
  const rNoTime = reviewOf(pNoTime).steps[0];
  assert(rNoTime.status === 'NEEDS_CONFIRMATION' && rNoTime.safety === 'REVIEW_REQUIRED' && rNoTime.issues.some(i => i.code === 'REMINDER_TIME_MISSING' && /9時に通知/.test(i.message)) && rNoTime.diff.human.some(l => /時刻 未定/.test(l)), '実機 354: 時刻の無いリマインダー → 確認が必要（REMINDER_TIME_MISSING・「時刻 未定」）');
  //   2026-10-19: 右の「確認結果」（廃止）の手順の判定に出していた理由と直し方は、右の「変更内容」の「反映できないこと」に出す
  const sumNoTime = KTAiChatUi.changeSummaryHtml({ plan: pNoTime, review: reviewOf(pNoTime) });
  //   2026-10-19: 通知時刻が無い手順は値が無い手順（最終案の判定で反映を止める）。右も「必要な値が計画に無いため反映できません」と、値を伝える次の操作（kintone の画面で設定する案内は手作業に回す種類だけ）
  assert(/反映できないこと[\s\S]*必要な値が計画に無いため反映できません（通知時刻[\s\S]*値を会話で伝えて変更案を直してください（それまで反映できません）/.test(sumNoTime) && !/kintone の画面で設定/.test(sumNoTime), `反映できない理由と次の操作（値を会話で伝えて直す）（右の「変更内容」の「反映できないこと」）: ${K.stripC(sumNoTime).slice(0, 300)}`);
  // 右上の見出し（workStatus）: 復元の失敗・検証不一致は「反映済み」と出さない（簡素化（2026-10-17）: 作業状態 workspaceState は削除した）
  const v = { planId: 'p', version: 1, status: 'EXECUTED', plan: p, review: rv };
  const failedRb = { stage: 'rolled-back', execution: { ...log, rollback: { status: 'ROLLBACK_VERIFY_FAILED' } }, rollback: { status: 'ROLLBACK_VERIFY_FAILED' } };
  const W = (execState) => VM.workStatus({ version: v, current: [VM.executionSummary(execState)] });
  assert(W(failedRb).key === 'attention' && W(failedRb).label === '要確認', `見出し: 復元の検証不一致 → 「要確認」（反映済みと出さない）: ${JSON.stringify(W(failedRb))}`);
  const okRb = { stage: 'rolled-back', execution: { ...log, rollback: { status: 'ROLLED_BACK_VERIFIED' } }, rollback: { status: 'ROLLED_BACK_VERIFIED' } };
  assert(W(okRb).key === 'rolled-back' && W(okRb).label === '元に戻し済み', `見出し: 復元できた → 「元に戻し済み」: ${JSON.stringify(W(okRb))}`);
  const partial = { stage: 'done', execution: { status: 'PARTIAL', steps: [{ stepId: 'P1', status: 'VERIFIED' }, { stepId: 'P2', status: 'FAILED' }] } };
  assert(W(partial).key === 'attention' && W(partial).label === '要確認', `見出し: 反映が途中で止まった → 「要確認」（反映済みと出さない）: ${JSON.stringify(W(partial))}`);
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
  const prepared = await KTPlanExecutor.prepare(KTPlanReview.executorOutput(p, rv, ['P1', 'P2', 'P3']), { api: mock.api, current: await mock.current(), appId: '310' });
  const p2 = prepared.steps.find(s => s.stepId === 'P2');
  assert(prepared.status === 'PREPARED' && p2.status === 'PENDING' && p2.prepared.payload.properties.phone.protocol === 'CALL', 'Executor の準備: phone を LINK（CALL）で追加する payload');
  const log = await KTPlanExecutor.executePreview(prepared, { api: mock.api, review: rv });
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
  //   2026-10-19: 右の「確認結果」（廃止）の集計と手順ごとの行の代わりに、右の「変更内容」の「反映できないこと」に、自動で反映できない手順と反映できない手順を理由と一緒に出す
  const html = KTAiChatUi.changeSummaryHtml({ plan: p4, review: rv4 });
  const cannot4 = html.slice(html.indexOf('>反映できないこと</div>'));
  const cannotRows = (cannot4.slice(0, cannot4.indexOf('</ul>')).match(/<li>[\s\S]*?<\/li>/g) || []).map(x => K.stripC(x));
  //   2026-10-19: リンクの種類が決まっていない P1 は値が無い手順（反映を止める）。計算フィールドの P2 は手作業に回す種類（Toolkit から自動で反映できない）
  assert(cannotRows.length === 3 && cannotRows.filter(x => /必要な値が計画に無いため反映できません（リンクの種類/.test(x)).length === 1 && cannotRows.filter(x => /Toolkit からは自動で反映できません/.test(x)).length === 1 && cannotRows.filter(x => /：反映できません/.test(x)).length === 1 && !cannotRows.some(x => /メモ2|NEW_FIELD_3/.test(x)), `変更内容: 反映できないこと 3 件（値が無い 1 件・自動で反映できない 1 件・反映できない 1 件）。自動で反映できる手順は入らない（承認の前に分かる）: ${JSON.stringify(cannotRows)}`);
  //   C-1 第 3 段（2026-10-08）: 会話の検証カード（reviewCardHtml）は削除した。会話では最終案のカードの「反映先と主な影響」と、
  //   実行できない手順があれば承認できないこと（tests/ai-flow-redesign.test.js の 指示 A7・R09-9）で示す。
  //   簡素化（2026-10-17）: 画面に出ていなかった要約の集計（VM.reviewSummary の notAuto）は削除した（自動で反映できない手順は上の applyReadiness と変更内容の「反映できないこと」）
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
  // 計画（C-1 第 3 段: 計画の AI を呼ぶのは仮案の採用のとき。共有の部品の台本で採用まで進め、計画の応答を止めている間に新しい相談を始める）
  {
    const g = K.gateMk();
    const x = K.makeConvC({ planGate: g });
    for (const s0 of K.REQUESTS.slice(0, 3)) await x.c.send(s0);
    const sent = x.c.send(K.REQUESTS[3]);
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
    assert(x.calls.plan.length === 1, '前提: 採用で計画の AI を呼んで応答待ち');
    const conv = x.c;
    conv.startConsultation(seed, { force: true });
    g.open();
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
    const g = K.gateMk();
    const x = K.makeConvC({ planGate: g });
    for (const s0 of K.REQUESTS.slice(0, 3)) await x.c.send(s0);
    const sent = x.c.send(K.REQUESTS[3]);
    g.open();
    const res = await sent;
    assert(res.ok && !res.discarded && x.c.planHistory().length === 1, '同じ会話の応答はそのまま登録する');
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
  //   C-1 第 3 段（2026-10-08）: 依頼は仮案の流れ（health の conversation に proposal・client.propose は共有の部品の台本）。計画の AI は採用で 1 回呼ぶ
  const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'], conversation: ['requirements', 'stream', 'proposal', 'itemIds'] }, 'change-planner': { implemented: true, promptVersions: ['1'] }, 'customization-generator': { implemented: true, promptVersions: ['1'] } } }, contract: { usage: { usedThisMonth: 1, monthlyLimit: 200 } } };
  const CUST = { customizationId: 'C1', requirement: '承認済では担当者も編集不可', whyStandardInsufficient: 'フィールドのアクセス権はステータスで変えられない', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [{ name: 'fieldOnOff.js', target: 'desktop', reason: '' }], risks: [], questions: [], dependsOn: [], evidenceIds: [] };
  const PLAN_RESP = { ok: true, contractVersion: '2.1', meta: { requestId: 'pl-1', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 200 } }, plan: { goal: '承認済みでは担当者も編集不可', solution: 'CUSTOMIZATION', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], gaps: [], evidenceIds: [] }, relevantFields: [], proposedFields: [], steps: [step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', 'fieldOnOff.js', { customizationId: 'C1' }, { solution: 'CUSTOMIZATION', execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' } })], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', customizations: [CUST] } };
  let gate = null;
  const client = {
    async getHealth() { return HEALTH; },
    async propose({ ctx, requestId }) { const raw = K.script({ utterance: ctx.question, previous: ctx.conversation.proposal, requirements: ctx.conversation.requirements }); if (!raw) throw new Error(`台本がありません: ${ctx.question}`); return K.normalized(raw, requestId, null, ctx.conversation); },
    async plan({ ctx, requestId, signal }) {
      calls.push({ ctx, signal });
      if (gate) await new Promise((res, rej) => { gate.res = res; if (signal) signal.addEventListener?.('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'CANCELLED' }))); });
      const v = KTAiClient.validatePlan(K.rawWithPlannerMapping(PLAN_RESP, ctx), ctx); if (!v.ok) throw new Error(JSON.stringify(v.errors)); return { ...v.normalized, requestId, clientWarnings: v.warnings };
    },
  };
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner,customization-generator', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const mock = makeKintoneMock(data, { jsSources: FILES });
  const panel = mountAiWorkspace(host, withDevBase(T, { getInputs: () => inputs, copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow, executor: { api: mock.api, appId: '310' } }));
  for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  const seed = KTContext.buildConsultationSeed({ data, deps, scan: cached, file: { name: 'fieldOnOff.js', target: 'desktop', type: 'FILE', fileKey: 'dl:fieldOnOff', size: '290' }, sourceText: FIELD_ON_OFF, appName: '案件管理' });
  panel.consult(seed);
  for (const s0 of K.REQUESTS) { await panel.send(s0); for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); }
  //   計画の C1 は効果（effects）を持たないので、最終案の前に自動の差分更新が 1 回入る（D16-2）。最初の Planner Context で確かめる
  assert(calls.length >= 1 && panel.conversation().activePlan() && panel.conversation().activePlan().final, `前提: 相談中に仮案を採用 → 計画の AI → 最終案: ${calls.length}`);
  const ctx = calls[0].ctx;
  const jsFact = (ctx.facts || []).find(f => f.kind === 'js-file' && f.jsFile && f.jsFile.name === 'fieldOnOff.js');
  assert(jsFact && jsFact.jsFile.sourceAvailable === true && /本文は取得済み/.test(jsFact.statement) && !/本文は未取得/.test(jsFact.statement), 'F7: 相談中のファイルは Planner Context で「本文は取得済み」（キャッシュに本文が無くても）');
  assert(!JSON.stringify(ctx).includes("record['amount'].disabled"), 'F7: 本文そのものは Planner Context に入れない');
  const rvStep = panel.conversation().activePlan().review.steps.find(r => r.stepId === 'C1');
  assert(rvStep && !rvStep.issues.some(i => i.code === 'JS_SOURCE_UNAVAILABLE') && rvStep.codeGeneration.existingFile && rvStep.codeGeneration.existingFile.name === 'fieldOnOff.js', 'F7: Review も「本文はまだ取得していません」と言わない（統合先 fieldOnOff.js を解決し、本文が無いという指摘を出さない）');
  // GM-6（UI）: 送信中に別の JS で新しい相談を始めると、送信中の要求を中断し、前の応答を新しい会話に入れない
  gate = {};
  const nCalls = calls.length;
  const pending = panel.send('担当者も編集できなくしたい（修正）', { intent: KTAiConversation.INTENT.REVISE_PLAN });
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
  assert(calls.length === nCalls + 1 && panel.conversation().isBusy(), `前提: 修正の要求を送信中（Planner を呼んで応答待ち）: ${calls.length - nCalls}`);
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
  const HEALTH = withProposal({ ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] }, 'customization-generator': { implemented: true, promptVersions: ['1'] } } }, contract: { usage: { usedThisMonth: 1, monthlyLimit: 200 } } });
  const RESP = { ok: true, contractVersion: '2.1', meta: { requestId: 'pl-n', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 200 } }, plan: { goal: '承認されたら担当者に通知したい', solution: 'STANDARD', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], gaps: [], evidenceIds: [] }, relevantFields: [], proposedFields: [], steps: [step('P1', 'ADD_NOTIFICATION', 'NEW_SETTING', '承認済み通知', { name: '承認済み通知', filterCond: 'ステータス = "承認済み"', targets: ['FIELD_ENTITY:owner'] })], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', customizations: [] } };
  const client = { async getHealth() { return HEALTH; }, propose: proposeByScript, async plan({ ctx, requestId }) { const v = KTAiClient.validatePlan(K.rawWithPlannerMapping(RESP, ctx), ctx); if (!v.ok) throw new Error(JSON.stringify(v.errors)); return { ...v.normalized, requestId, clientWarnings: v.warnings }; } };
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner,customization-generator', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const host = makeFakeHost();
  const panel = mountAiWorkspace(host, withDevBase(T, { getInputs: () => ({ data: DATA, deps: DEPS, scan: null, incoming: null }), copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false }, executor: { api: makeKintoneMock(DATA).api, appId: '310' } }));
  for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  await adoptOnPanel(panel);
  const v = panel.conversation().activePlan();
  const rP1 = v.review.steps.find(x => x.stepId === 'P1');
  assert(v.plan.steps[0].spec.filterCond === 'ステータス in ("承認済み")' && rP1.issues.some(i => i.code === 'COND_NORMALIZED' && /ステータス = "承認済み" → ステータス in \("承認済み"\)/.test(i.message)) && !rP1.issues.some(i => i.code === 'COND_INVALID'), '受信時に直し、Review の手順に COND_NORMALIZED（直した前後）を出す・COND_INVALID にならない');
  assert(KTPlanExecutor.applyReadiness(v.plan, v.review).find(a => a.stepId === 'P1').apply === 'AUTO', '直した条件で自動反映できる');
}

// =========================================================
console.log('\n--- CX-7. 外部連携・通知の語で生成の可否を変えない（簡素化 2026-10-18: 制限は生成工程の機械検査）・生成できない項目の案内 ---');
{
  //   簡素化（2026-10-18）: 要件の文を語の照合で読み、外部サービスとの連携（EXTERNAL_INTEGRATION）と JavaScript による通知（NOTIFICATION_BY_JS）を生成の対象外にする
  //   処理（7b・7c）は削除した。外部への通信と通知の制限は生成工程の責任（生成の指示と機械検査の security・security-review・notification が生成したコードの形で止める。
  //   AI版 worker の customization-generator §11・cross-toolkit §15）。ここでは、言い回しが違っても生成の可否・理由・判定・確認の項目が変わらないことを確かめる
  const cust = { customizationId: 'C1', requirement: '金額が100万円を超えたら画面に警告を表示する', whyStandardInsufficient: '条件付きの画面の警告は標準にない', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.detail.process.proceed'], fields: [{ code: 'amount', access: 'READ' }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [] };
  const planC = (o) => plan([step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', '', { customizationId: 'C1' }, { solution: 'CUSTOMIZATION', execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' } })], [], { solution: 'CUSTOMIZATION', customizations: [{ ...cust, ...o }] });
  const shape = (r) => JSON.stringify({ supported: r.codeGeneration.supported, reason: r.codeGeneration.reason, status: r.status, safety: r.safety, codes: (r.issues || []).map(i => `${i.code}:${i.severity}`).sort() });
  const base = reviewOf(planC({})).steps.find(x => x.stepId === 'C1');
  const variants = [
    { requirement: '承認済みになったら会計システムに請求データを自動送信する', whyStandardInsufficient: 'kintone標準機能に会計システムへの自動送信機能がないため' },
    { requirement: '承認されたらSlackに通知する', whyStandardInsufficient: '標準の通知はSlackに送れない' },
    { requirement: '営業担当が空でない場合は営業担当に通知し、空の場合は担当者に通知する条件分岐を実装する', whyStandardInsufficient: '通知先を条件で切り替える標準機能がない' },
    { requirement: '承認待ちになったら承認者をメンションしてコメントを書き込む', whyStandardInsufficient: '標準にない' },
    { requirement: '承認待ちになったら承認者にコメントで知らせる', whyStandardInsufficient: '標準にない' },
    { requirement: 'メンションされた人の一覧を画面に表示する', whyStandardInsufficient: '標準にない' },
    //   関係の無い説明の文（リスクの注意）に外部連携の語がある
    { risks: ['他のシステムとの連携は今回は扱わない', 'Webhook の設定は変えない'] },
  ];
  assert(base.codeGeneration.supported === true && base.codeGeneration.reason === null, `CX-7: 画面の処理は生成できる: ${shape(base)}`);
  for (const v of variants) {
    const r = reviewOf(planC(v)).steps.find(x => x.stepId === 'C1');
    assert(shape(r) === shape(base), `CX-7: 要件・理由・リスクの文の語（外部連携・通知・メンション）で、生成の可否・理由・判定・確認の項目を変えない（${v.requirement || v.risks.join('・')}）: ${shape(r)} / ${shape(base)}`);
    assert(!(r.issues || []).some(i => i.code === 'JS_EXTERNAL_INTEGRATION' || i.code === 'JS_NOTIFICATION_NOT_POSSIBLE'), 'CX-7: 文から外部連携・通知の確認を作らない');
  }
  //   生成できない理由は構造で決まるもの（方針が生成の対象外など）だけ。生成できない項目しか無ければ、最終案のカードで「コードを生成できます」と言わない（生成は呼ばない）
  const p = planC({ requirement: '承認済みになったら会計システムに請求データを自動送信する', whyStandardInsufficient: 'kintone標準機能に会計システムへの自動送信機能がないため', strategy: 'PLUGIN_CANDIDATE' });
  const rP = reviewOf(p).steps.find(x => x.stepId === 'C1');
  assert(rP.codeGeneration.supported === false && rP.codeGeneration.reason === 'STRATEGY_NOT_GENERATED', `CX-7: 方針が生成の対象外（構造）なら生成しない: ${shape(rP)}`);
  //   C-1 第 3 段（2026-10-08）: 仕様の案内（spec-intro）は削除した。同じ約束を新しい流れの最終案のカードで確かめる（生成できない部分を示し、「コードを生成できます」と言わない）
  const xExt = K.makeConvC({ planImpl: () => ({ plan: clone(p), ctx: null, review: reviewOf(p), turn: { reply: '計画を作りました。', requirementOps: [], utteranceCoverage: [] } }) });
  await K.adoptC(xExt);
  const extCard = K.stripC(K.finalHtml(xExt));
  assert(/Toolkit では JavaScript を作れない部分があります/.test(extCard) && /会計システム/.test(extCard) && !/コードを生成できます/.test(extCard) && xExt.gen.calls.length === 0 && !FS.readyOf(xExt.c.activePlan()), `案内: 生成できない項目しか無ければ「コードを生成できます」と言わない（最終案のカード・生成は呼ばない）: ${extCard.replace(/\s+/g, ' ').slice(0, 160)}`);
  //   接続先の能力（AI版 契約 20 §19・§20）: 今の受け渡しの印（外部への通信と通知の検査 networkCheck・検査した本文の受け渡し verifiedBody）の無い接続先には、
  //   生成を依頼しない（使えないと分かっている結果のために有料の生成をしない。文の語の判定には戻さない）。理由は必須の動作の確認の文と分ける。印のある接続先は今までどおり確認済み
  const xOld = K.makeConvC({ current: false });
  await K.adoptC(xOld);
  const vOld = xOld.c.activePlan(), eOld = vOld && vOld.generated ? vOld.generated.C1 : null;
  assert(eOld && eOld.status === 'unsupported' && eOld.verdict.kind === 'capability' && eOld.verdict.capability === 'generator' && /生成を依頼していません/.test(eOld.verdict.reason) && xOld.gen.calls.length === 0 && !FS.readyOf(vOld)
    && /接続先（生成工程）が今の Toolkit の生成の受け渡し（必須の動作の確認・検査と模擬テストに使った本文・外部への通信と通知の検査）に対応していないため、まだ反映できません。/.test(FS.reasonOf(vOld)) && !/必須の動作の確認に対応していない/.test(FS.reasonOf(vOld)),
    `CX-7: 今の受け渡しの印の無い接続先には生成を依頼しない（生成 0 回・理由は受け渡しの文）: ${JSON.stringify({ status: eOld && eOld.status, calls: xOld.gen.calls.length, verdict: eOld && eOld.verdict && eOld.verdict.reason, reason: FS.reasonOf(vOld) })}`);
  const xNow = K.makeConvC();
  await K.adoptC(xNow);
  const vNow = xNow.c.activePlan();
  assert(vNow.generated.C1.status === 'verified' && xNow.gen.calls.length === 1 && FS.readyOf(vNow), `CX-7: 印のある接続先の生成結果は今までどおり確認済み: ${JSON.stringify({ status: vNow.generated.C1.status, reason: FS.reasonOf(vNow) })}`);
}

// =========================================================
console.log('\n--- U2 / U3. 文言と最終確認の確認事項 ---');
{
  const p = plan([step('P1', 'ADD_REMINDER', 'NEW_SETTING', '契約終了30日前通知', { name: '契約終了30日前通知', timingField: 'due_date', daysLater: -30, time: '09:00', targets: ['FIELD_ENTITY:owner'] })]);
  const rv = reviewOf(p);
  const mock = makeKintoneMock(DATA);
  const prepared = await KTPlanExecutor.prepare(KTPlanReview.executorOutput(p, rv, ['P1']), { api: mock.api, current: await mock.current(), appId: '310' });
  //   簡素化 E（2026-10-16）: 手順ごとの承認の後の最終確認の段（未回答の確認事項・［キャンセル］［動作テスト環境へ反映］）は削除した。
  //   反映は最終案のカードの［動作テスト環境へ反映］1 回で、未回答の確認事項（先に決めたいこと・後で決めてよいこと）は最終案のカードが出す（ai-flow-redesign の指示 A7・B6）。
  //   ここでは、反映の画面に最終確認の段（書き込みのボタン）が戻っていないことだけを確かめる
  const confirmHtml = KTContextUi.executorHtml({ stage: 'confirm', prepared, execution: null, classified: KTPlanExecutor.classifySteps(KTPlanReview.executorOutput(p, rv, ['P1'])), available: true, review: rv, questions: ['通知の送信時間は何時が適切ですか？'] });
  assert(!/id="kt-ai-exec-confirm"|id="kt-ai-exec-go"|id="kt-ai-exec-start"/.test(confirmHtml), 'U3: 反映の画面に最終確認の段と書き込みのボタンは無い（反映は最終案のカードの 1 回。未回答の確認事項は最終案のカードで出す）');
  const log = await KTPlanExecutor.executePreview(prepared, { api: mock.api, review: rv });
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
    const client = { async getHealth() { return withProposal(HEALTH); }, async propose(a) { calls.push(a.ctx); return proposeByScript(a); }, async plan({ ctx, requestId }) { calls.push(ctx); const v = KTAiClient.validatePlan(K.rawWithPlannerMapping(resp, ctx), ctx); if (!v.ok) throw new Error(JSON.stringify(v.errors)); return { ...v.normalized, requestId, clientWarnings: v.warnings }; } };
    const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
    const host = makeFakeHost();
    const panel = mountAiWorkspace(host, withDevBase(T, { getInputs: () => ({ data: DATA, deps: DEPS, scan: null, incoming: null }), copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false }, executor: { api: makeKintoneMock(DATA).api, appId: '310' } }));
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
    await adoptOnPanel(m.panel);
    const v = m.panel.conversation().activePlan();
    const r1 = v.review.steps.find(x => x.stepId === 'P1');
    assert(v.plan.steps[0].spec.events.length === 0 && v.plan.steps[0].spec.filterCond === 'ステータス in ("承認済み")' && r1.issues.some(i => i.code === 'NOTIFICATION_EVENTS_DROPPED' && /レコードの条件通知/.test(i.message)) && !r1.issues.some(i => i.code === 'NOTIFICATION_SCOPE_AMBIGUOUS') && KTPlanExecutor.applyReadiness(v.plan, v.review).find(a => a.stepId === 'P1').apply === 'AUTO', 'CX-2a: statusChanged ＋ ステータス in (…) は受信時にレコードの条件通知へ（イベントを外したと表示）→ 自動で反映できる');
    const m2 = mountWith(respOf('高額案件が登録されたら通知したい', [step('P1', 'ADD_NOTIFICATION', 'NEW_SETTING', '高額', { name: '高額', filterCond: 'amount >= "1000000"', events: ['statusChanged'], targets: ['FIELD_ENTITY:owner'] })]));
    await ticks();
    await adoptOnPanel(m2.panel);
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
  //   C-1 第 3 段（2026-10-08）: 変更案の要約の文（plan-summary）は削除した。同じ約束を新しい流れの最終案のカード（反映先と主な影響）で確かめる
  {
    const p = plan([step('P1', 'UPDATE_RECORD_ACL', 'NEW_SETTING', '', { filterCond: 'ステータス in ("承認済み")', entities: ['FIELD_ENTITY:owner'] }), step('P2', 'REQUIRE_CONFIRMATION', 'NEW_SETTING', '', {})], [], { solution: 'HYBRID' });
    const xAcl = K.makeConvC({ planImpl: () => ({ plan: clone(p), ctx: null, review: reviewOf(p), turn: { reply: '計画を作りました。', requirementOps: [], utteranceCoverage: [] } }) });
    await K.adoptC(xAcl);
    const texts = xAcl.c.messages().map(x => x.text).join('\n') + '\n' + K.stripC(K.finalHtml(xAcl)) + '\n' + K.stripC(KTAiChatUi.changeSummaryHtml(xAcl.c.activePlan(), {}));   // 2026-10-14: 反映する内容（自動で反映できる件数）・反映の前に確かめることは右の「変更内容」
    assert(!/組み合わせで実現できます|実現できます。/.test(texts) && /Toolkit から自動で反映できるのは 0 件/.test(texts) && /反映の前に確かめること/.test(texts), 'CX-7: 「実現できます」と言い切らず、自動で反映できる手順が無いことを伝える（最終案のカード）');
    //   レビュー 10（2026-10-14・人が判断できる形）: 確認が済むまで反映しない手順（cannot の kind confirm。止めない注意）は、左の最終案の「仮案からの補足」に 1 行で残す
    const leftAcl = K.stripC(K.finalHtml(xAcl));
    assert(/仮案からの補足[\s\S]*確認が済むまで反映しない手順: P2 REQUIRE_CONFIRMATION/.test(leftAcl) && (leftAcl.match(/確認が済むまで反映しない手順/g) || []).length === 1, `CX-7b: 確認が済むまで反映しない手順は左の「仮案からの補足」に 1 行: ${(leftAcl.match(/仮案からの補足[\s\S]{0,160}/) || [''])[0]}`);
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
    //   簡素化（2026-10-17）: 計画は採用した仮案から作る（仮案を経ない計画は登録できない）。計画の AI が秘密情報を質問した計画を、本来の流れで登録する
    const x7 = K.makeConvC({ planImpl: (args) => { const r = K.planJs(args); r.plan.questions = [...(r.plan.questions || []), { id: 'Q9', question: 'Slack通知の送信先Webhook URLや通知内容の詳細は？', relatedEvidenceIds: [] }]; return r; } });
    await K.adoptC(x7);
    assert(x7.c.activePlan() && x7.c.messages().some(x => x.data && x.data.kind === 'secret-question' && /チャットに書かないでください/.test(x.text)), 'CX-7: AI が秘密情報を質問したら、チャットに書かないよう Toolkit が伝える');
  }
  // 依頼のアプリ名と参照先アプリの名前（XA-5）
  //   簡素化（2026-10-17）: 依頼の文を語の照合で読み直す計画全体の指摘（RELATED_APP_NAME_MISMATCH・CX-4 の REQUEST_EXCEPTION_UNCONFIRMED）は削除した。
  //   どのアプリか・例外として扱うかは計画の AI と質問の AI が扱う。ここでは手順の無い計画で「問題は見つかりませんでした」と言わないことだけを確かめる
  {
    //   C-1 第 3 段（2026-10-08）: 会話の検証の要約（review-summary の「計画全体に確認が必要な点があります」）は削除した。
    //   新しい流れでは、最終案のカードで「問題は見つかりませんでした」と言わず、計画全体の指摘は右の「変更内容」（手順の行の指摘・重なりと注意点）に出る
    const mX = mountWith(respOf('顧客マスタ（旧）の顧客コードで会社名を取ってきたい', []));
    await ticks();
    await adoptOnPanel(mX.panel);
    const vX = mX.panel.conversation().activePlan();
    const chatX = mX.$('kt-ai-chat').innerHTML;
    assert(vX && vX.final && !/問題は見つかりませんでした/.test(chatX), 'XA-5: 手順が無く「既存の設定で足りる」計画でも「問題は見つかりませんでした」と言わない');
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
  //   2026-10-18（説明文から設定値を補わない）: 前は説明文の 2 組を読んで STEP_MULTIPLE_SETTINGS で止めていた（その検出と、同じ値の繰り返し・一覧の行を合わせる確かめは消した）。
  //   今は説明文を読まない。spec は changeKind ACTION_CONDITION なのに条件式が無いので、遷移元が今と同じでも変更不要にせず値の欠落（NO_STRUCTURED_CHANGE → NO_VALUES）。
  //   1 組目だけ・説明文から推測した値で反映することも、黙って「変更不要」で外すことも無い
  const ar = KTPlanExecutor.applyReadiness(p, rv).find(a => a.stepId === 'P3');
  const p3Actions = rv.simulation.after.process.actions.filter(a => a.name === '申請する');
  assert(s3.status === 'NEEDS_CONFIRMATION' && s3.issues.some(i => i.code === 'NO_STRUCTURED_CHANGE' && /条件の変更の値（条件式）が計画にありません/.test(i.message)) && s3.diff.changeType === 'NO_CHANGE' && !s3.issues.some(i => i.code === 'BRANCH_ADDED') && !s3.diff.human.some(h => /変更不要/.test(h))
    && ar.apply !== 'APPLY' && ar.reason === 'NO_VALUES' && p3Actions.length === 1 && p3Actions[0].to === '承認待ち' && p3Actions[0].filterCond === 'amount > "0"' && p3Actions[0].origin === 'existing',
    `F32: 説明に遷移先・条件が 2 組あっても読まない。spec に条件式が無いので値の欠落で反映しない（変更不要にもしない・分岐も作らない）: ${JSON.stringify({ status: s3.status, codes: s3.issues.map(i => i.code), apply: ar.apply, reason: ar.reason, actions: p3Actions })}`);
  // 同じ手順で spec の条件式が今の条件（amount > "0"）と同じなら、値はあるので変更不要。空の条件式は値の欠落（区別する。どちらも説明文の 2 組は読まない）
  const empty = reviewOf(plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', filterCond: '', changeKind: 'ACTION_CONDITION' }, { proposal: { summary: '', details: det } })])).steps[0];
  const sameNow = reviewOf(plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', filterCond: 'amount > "0"', changeKind: 'ACTION_CONDITION' }, { proposal: { summary: '', details: det } })])).steps[0];
  assert(empty.issues.some(i => i.code === 'NO_STRUCTURED_CHANGE') && empty.diff.changeType === 'NO_CHANGE' && sameNow.diff.changeType === 'REUSE' && sameNow.diff.human.some(h => /変更不要/.test(h)) && !sameNow.issues.some(i => i.code === 'NO_STRUCTURED_CHANGE'),
    `F32: 値の欠落（条件式が空）と変更不要（条件式が今と同じ）を分ける: ${JSON.stringify({ empty: [empty.diff.changeType, empty.issues.map(i => i.code)], same: [sameNow.diff.changeType, sameNow.issues.map(i => i.code)] })}`);

  // F33: 「申請する」の遷移先を新しいステータスへ変えると、既存の「承認待ち」へ進むアクションが無くなる（実機では指摘が無かった）
  const orphan = plan([
    statusStep('P1', '部長承認待ち'),
    //   2026-10-18: 遷移先だけを変える手順なので changeKind は ACTION_TRANSITION（前の固定データは ACTION_CONDITION で条件式が無く、変更の種類の値の欠落になる）
    step('P2', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { name: '申請する', from: '未処理', to: '部長承認待ち', changeKind: 'ACTION_TRANSITION' }, { dependsOn: ['P1'] }),
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
  //   簡素化 B（2026-10-17）: 画面ごとの処理の有無（platform-fields）と、そのためのイベントの解析は Toolkit だけの規則で、削除した（生成工程には移植していない）。
  //   同じことは生成工程の必須の効果が効果のイベントごとに確かめる（AI版 verify-generated.mjs: 候補が読み込まれる画面のイベントの handler に処理が無ければ、そのイベントは missing）。
  //   Toolkit はその結果を登録不可として取り込む
  const DL = ["(function () {", "  'use strict';", "  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {", "    const record = event.record;", "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {", "      record['amount'].disabled = true;", "    }", "    return event;", "  });", "})();", ""].join('\n');
  const ADD = "  kintone.events.on(['mobile.app.record.create.show', 'mobile.app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['owner'].disabled = true;\n    }\n    return event;\n  });\n";
  const SRC = { name: 'dealLock.js', target: 'desktop', text: DL };
  const baseHash = KTScan.analyzeFile({ name: 'dealLock.js', target: 'desktop', kind: 'js', text: DL }, { fields: [], selfAppId: null }).file.hash;
  const cust = { customizationId: 'C1', requirement: '承認済みでは担当者も編集不可（PC・スマホ）', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop', 'mobile'], events: ['app.record.create.show', 'app.record.edit.show', 'mobile.app.record.create.show', 'mobile.app.record.edit.show'], fields: [{ code: 'owner', access: 'CONTROL' }, { code: 'ステータス', access: 'READ' }], apis: [], existingFiles: [{ name: 'dealLock.js', target: 'desktop' }] };
  const genOf = (add) => gwWithBody({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', code: add, patch: { baseHash, operations: [{ type: 'INSERT_BEFORE', anchor: '})();', content: add }] }, events: cust.events, fields: cust.fields, apis: ['kintone.events.on'] }, DL);
  const chk = (r, n) => r.checks.find(c => c.name === n) || null;
  const bad = KTCodeReview.review({ generated: genOf(ADD), customization: cust, plan: null, data: DATA, scan: null, existingSource: SRC });
  assert(chk(bad, 'patch').ok && !chk(bad, 'platform-fields') && bad.status !== 'BLOCKED', `F41（簡素化 B）: Toolkit の形式確認は画面ごとの処理の有無を判定しない（生成工程の必須の効果の範囲）: ${JSON.stringify(bad.checks.map(c => c.name))}`);
  const REQ = [{ requirementId: 'C1', requirementIds: ['C1'], field: 'owner', effect: 'lock', events: cust.events, condition: 'ステータス = "承認済み"' }];
  const badV = KTCodeReview.attachBehavior(bad, { version: '1', passed: false, machine: [], requiredEffects: [{ requirementId: 'C1', requirementIds: ['C1'], field: 'owner', effect: 'lock', status: 'missing', events: [{ event: 'app.record.create.show', status: 'not-on-create' }, { event: 'app.record.edit.show', status: 'missing' }, { event: 'mobile.app.record.create.show', status: 'not-on-create' }, { event: 'mobile.app.record.edit.show', status: 'present' }] }], behavior: { status: 'not-run', reason: 'machine-blocked', cases: [] } }, { requiredEffects: REQ, customization: cust });
  assert(badV.status === 'BLOCKED' && badV.registration.verdict === 'BLOCKED' && chk(badV, 'required-effects') && !chk(badV, 'required-effects').ok && /owner/.test(chk(badV, 'required-effects').message),
    `F41（簡素化 B）: PC の画面の処理が無いことは、生成工程の必須の効果の結果（PC のイベントが missing）で登録不可にする: ${JSON.stringify(badV.checks.filter(c => !c.ok).map(c => c.name + ':' + c.message))}`);
  // 両方の画面で制御するコード（PC の handler にも担当者）は、Toolkit の形式確認で止めない
  const BOTH = "  kintone.events.on(['app.record.create.show', 'app.record.edit.show', 'mobile.app.record.create.show', 'mobile.app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['owner'].disabled = true;\n    }\n    return event;\n  });\n";
  const good = KTCodeReview.review({ generated: genOf(BOTH), customization: cust, plan: null, data: DATA, scan: null, existingSource: SRC });
  assert(good.status !== 'BLOCKED' && chk(good, 'patch').ok, `F41: PC とモバイルの両方で制御するコードは止めない: ${JSON.stringify(good.checks.filter(c => !c.ok).map(c => c.name))}`);
}

// F42（F41 の再生成・実機。既存の if の外に足した編集不可 → すべてのステータスで編集できなくなる）の unconditional-control は、C-1 第 2 段（§0d.4）で Toolkit の形式確認から外した。
//   生成工程で守る: AI版 worker/test/cases/required-effects.mjs「lock: 条件に合う（承認済）→ lock・合わない（作成中）→ not-locked…」「A3 F5（本物の隔離環境）: 一覧の編集だけ条件を見ずに編集不可にする誤った候補 → 一覧の編集の「合わない」で failed」、
//   sandbox/test/cross-toolkit.mjs「7-8」「7-9」（条件の片方だけの誤った候補は failed）と「7-8b」「7-9b」（Toolkit の effectResults でも不合格）

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
console.log('\n--- F38（CX-1 2 回目・実機）. 既存ファイルの即時関数の外に足したコード（ファイル直下の宣言）---');
{
  //   簡素化 B（2026-10-17）: 即時関数の外の宣言（globals）は Toolkit だけの規則で、削除した。生成工程（Gateway）の機械検査にも同じ規則は無く、移植していない（検査を増やさない）。
  //   このため、即時関数の外に足した宣言は Toolkit でも生成工程でも止めない（判定しない範囲として残る）。2026-10-18: 統合した本文は生成工程が作り（generated.body）、
  //   Toolkit はその本文をそのまま書き込む本文にする（合成し直さない）
  const DL = ["(function () {", "  'use strict';", "  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {", "    const record = event.record;", "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {", "      record['amount'].disabled = true;", "    }", "    return event;", "  });", "})();", ""].join('\n');
  const baseHash = KTScan.analyzeFile({ name: 'dealLock.js', target: 'desktop', kind: 'js', text: DL }, { fields: [], selfAppId: null }).file.hash;
  const ADD = "  // 承認済みはモバイルでも金額を編集不可\n  const EVENTS = ['mobile.app.record.create.show', 'mobile.app.record.edit.show'];\n  kintone.events.on(EVENTS, function (event) {\n    if (event.record['ステータス'] && event.record['ステータス'].value === '承認済み') { event.record['amount'].disabled = true; }\n    return event;\n  });\n";
  const cust = { customizationId: 'C1', requirement: '承認済みは金額を編集不可（PC・モバイル）', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop', 'mobile'], events: ['app.record.create.show', 'app.record.edit.show', 'mobile.app.record.create.show', 'mobile.app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [{ name: 'dealLock.js', target: 'desktop' }] };
  const genOf = (op) => gwWithBody({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', code: ADD, patch: { baseHash, operations: [op] }, events: cust.events, fields: cust.fields, apis: ['kintone.events.on'] }, DL);
  const chk = (r, n) => r.checks.find(c => c.name === n) || null;
  // 実機と同じ: APPEND（anchor「})();」）→ 即時関数の外（ファイル直下）に const EVENTS
  const out = KTCodeReview.review({ generated: genOf({ type: 'APPEND', anchor: '})();\n', content: ADD }), customization: cust, plan: null, data: DATA, scan: null, existingSource: { name: 'dealLock.js', target: 'desktop', text: DL } });
  assert(chk(out, 'patch').ok && !chk(out, 'globals') && out.finalCode === genOf({ type: 'APPEND', anchor: '})();\n', content: ADD }).body && out.finalCode.startsWith(DL), `F38（簡素化 B）: 即時関数の外への追加も、受け取った統合の本文のまま書き込む（globals は判定しない）: ${JSON.stringify(out.checks.map(c => c.name))}`);
  // 即時関数の中（閉じる行の前）に入れたコード
  const inside = KTCodeReview.review({ generated: genOf({ type: 'INSERT_BEFORE', anchor: '})();', content: ADD }), customization: cust, plan: null, data: DATA, scan: null, existingSource: { name: 'dealLock.js', target: 'desktop', text: DL } });
  assert(chk(inside, 'patch').ok && !chk(inside, 'globals') && inside.status !== 'BLOCKED', `F38: 即時関数の中に入れたコードは止めない: ${JSON.stringify(inside.checks.filter(c => !c.ok).map(c => c.name))}`);
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
  const gen = gwWithBody({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', summary: 'モバイルでも金額を編集不可', code: ADD, patch: { baseHash, operations: [{ type: 'INSERT_BEFORE', anchor: '})();', content: ADD }] }, events: cust.events, fields: cust.fields, apis: ['kintone.events.on'], assumptions: [], warnings: [] }, DL);
  const rv = KTCodeReview.review({ generated: gen, customization: cust, plan: null, data: DATA, scan: null, existingSource: SRC });
  const r = KTJsExecutor.changeFromGenerated({ customization: cust, generated: gen, review: rv, existingSource: SRC });
  assert(r.ok && r.change.target === 'desktop' && r.change.kind === 'REPLACE_FILE' && r.change.content === gen.body, '前提: PC の dealLock.js を、受け取った統合の本文で差し替える変更');
  const mob = typeof KTJsExecutor.mobileCompanionOf === 'function' ? KTJsExecutor.mobileCompanionOf(r.change, { customization: cust, mobileNames: [] }) : { ok: false };
  assert(mob.ok && mob.change.target === 'mobile' && mob.change.kind === 'ADD_FILE' && mob.change.name === 'dealLock.js' && mob.change.content === r.change.content && mob.change.changeId !== r.change.changeId, 'F39: PC とモバイルの計画でモバイルのイベントを含むコード → モバイルにも同じ本文を追加する変更');
  // 登録（mock）: PC は差し替え・モバイルは追加 → 復元で両方とも元に戻る
  const data = clone(DATA);
  data.customize = { scope: 'ALL', desktop: { js: [{ type: 'FILE', file: { contentType: 'text/javascript', fileKey: 'dl:lock', name: 'dealLock.js', size: '100' } }], css: [] }, mobile: { js: [], css: [] }, revision: '5' };
  const m = makeKintoneMock(data, { jsSources: [{ name: 'dealLock.js', target: 'desktop', text: DL }] });
  if (mob.ok) {
    const prep = await KTJsExecutor.prepare({ appId: '310', changes: [r.change, mob.change] }, { api: m.api, current: await m.current() });
    assert(prep.status === 'PREPARED' && prep.summary.byTarget.desktop.replace === 1 && prep.summary.byTarget.mobile.add === 1, `F39: 確認画面の件数は PC：差し替え 1・モバイル：追加 1（${JSON.stringify(prep.summary.byTarget)}）`);
    const ex = await KTJsExecutor.executePreview(prep, { api: m.api });
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
    const gen2 = gwWithBody({ ...gen, code: ADD2, patch: { baseHash, operations: [{ type: 'INSERT_BEFORE', anchor: '})();', content: ADD2 }] }, events: cust2.events, fields: cust2.fields }, DL);
    const rv2 = KTCodeReview.review({ generated: gen2, customization: cust2, plan: null, data: DATA, scan: null, existingSource: SRC });
    const r2 = KTJsExecutor.changeFromGenerated({ customization: cust2, generated: gen2, review: rv2, existingSource: SRC });
    const mob2 = KTJsExecutor.mobileCompanionOf(r2.change, { customization: cust2, mobileNames: [] });
    const data2 = clone(data); data2.customize.mobile.js = [];
    const m2 = makeKintoneMock(data2, { jsSources: [{ name: 'dealLock.js', target: 'desktop', text: DL }] });
    const prep2 = await KTJsExecutor.prepare({ appId: '310', changes: [r2.change, mob2.change] }, { api: m2.api, current: await m2.current() });
    const ex2 = await KTJsExecutor.executePreview(prep2, { api: m2.api, acknowledged: (prep2.confirmations || []).map(x => x.key) });   // Phase 21: 確認が必要な項目（既存のイベントに handler を足す）を確認した
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
  //   F35c（依頼の文に参照元アプリの名前と関連レコードの名前があれば指摘する RELATED_RECORDS_IN_OTHER_APP）は、依頼の文を語の照合で読み直す指摘なので 2026-10-17 に削除した。
  //   関連レコードを一覧として反映しないこと（F35b の REFERENCE_TABLE_NOT_VIEW）は構造で決まるので残る

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
  //   C-1 第 3 段（2026-10-08）: 依頼は仮案の流れ（共有の部品の台本で採用 → 計画）。反映は最終案のカードの［動作テスト環境へ反映］（承認と反映を 1 回）
  const client = { async getHealth() { return withProposal(HEALTH); }, propose: proposeByScript, async plan({ ctx, requestId, signal }) { calls.push({ ctx, signal }); if (gate) await new Promise((res, rej) => { gate.res = res; signal?.addEventListener?.('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'CANCELLED' }))); }); const v = KTAiClient.validatePlan(K.rawWithPlannerMapping(RESP, ctx), ctx); return { ...v.normalized, requestId, clientWarnings: v.warnings }; } };
  const storage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' }); settings.setConsent(true);
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const host = makeFakeHost();
  const mock = makeKintoneMock(DATA);
  const panel = mountAiWorkspace(host, withDevBase(T, { getInputs: () => ({ data: DATA, deps: DEPS, scan: null, incoming: null }), copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false }, executor: { api: mock.api, appId: '310' } }));
  const $ = (id) => host.querySelector(`#${id}`);
  const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
  const act = (a) => $('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act: a } } });
  await ticks();
  assert($('kt-ai-new-conv') && $('kt-ai-new-conv').disabled === true, '会話が空のうちは［新しい会話］は押せない');
  await adoptOnPanel(panel); await ticks();
  assert(panel.conversation().planHistory().length === 1 && $('kt-ai-new-conv').disabled === false, '前提: 計画 v1 がある・［新しい会話］が押せる');
  //   まだ反映していない準備（最終案のカードの承認の欄の準備。書き込みなし）がある状態から押す（新しい会話がそれを使わないことを確かめる）。
  //   簡素化（2026-10-17）: 承認だけを記録して右で準備する口は削除した（承認と反映は［動作テスト環境へ反映］1 回）
  const v0 = panel.conversation().activePlan();
  for (let i = 0; i < 60 && panel.finalPrecheck().status !== 'ready'; i++) await ticks(1);
  const preBefore = panel.finalPrecheck();
  // 2026-10-06 利用者の指示で意図して更新: 確認のカード（new-conv-choices・［このまま続ける］）は廃止。［新しい会話］はすぐ新しい会話を始める
  //   （ここでは右の「反映」を開いた状態から押し、右も新しい会話の分に片づくことを確かめる。2026-10-19: 右の「確認結果」のタブは廃止）
  panel.showPane('exec'); await ticks();
  const summaryBefore = $('kt-ai-change-summary').innerHTML;
  assert(panel.drawerState().pane === 'exec' && /承認済みの案件/.test(summaryBefore), `前提: 右に前の変更案の内容がある（「反映」を表示中）: ${panel.drawerState().pane}`);
  await $('kt-ai-new-conv').dispatch('click'); await ticks();
  assert(!panel.conversation().messages().some(m => m.data && m.data.kind === 'new-conv-choices') && !/data-act="new-conv-cancel"/.test($('kt-ai-chat').innerHTML), '［新しい会話］→ 確認のカードは出さない');
  assert(panel.conversation().messages().length === 0 && panel.conversation().planHistory().length === 0 && !panel.conversation().activePlan() && $('kt-ai-new-conv').disabled === true, '［新しい会話］→ すぐ会話・計画が消え、ボタンは押せない状態に戻る');
  assert(panel.drawerState().open === true && panel.drawerState().pane === 'plan' && !panel.activeArtifact() && !/承認済みの案件/.test($('kt-ai-change-summary').innerHTML) && !/承認済みの案件/.test($('kt-ai-plan-result').innerHTML), `新しい会話では右を片づける（表示中のタブは「変更内容」に戻り、前の変更案の内容を残さない。右は常に表示）: ${panel.drawerState().pane}`);
  const rOld = await panel.applyFinal(v0.planId, v0.version); await ticks();
  assert(preBefore.status === 'ready' && preBefore.planId === v0.planId && panel.finalPrecheck().planId === null && rOld === null && !v0.approval && panel.executorState().stage === 'idle', `未反映の準備（承認の欄の準備）は使わない（前の会話の計画を新しい会話から反映しない）: ${preBefore.status} → ${JSON.stringify(panel.finalPrecheck())}`);
  assert(mock.calls.every(c => c.startsWith('GET')), '新しい会話の操作で kintone の設定へ書き込まない');
  // 送信中に新しい会話 → 要求を中断し、遅れた応答を新しい会話に入れない
  for (const s0 of K.REQUESTS.slice(0, 3)) { await panel.send(s0); await ticks(); }
  gate = {};
  const pending = panel.send(K.REQUESTS[3]);
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
  await $('kt-ai-new-conv').dispatch('click'); await pending; await ticks();
  assert(calls[calls.length - 1].signal && calls[calls.length - 1].signal.aborted === true && panel.conversation().planHistory().length === 0 && panel.conversation().messages().length === 0 && !panel.conversation().isBusy(), '送信中なら［新しい会話］で要求を中断し、新しい会話に前の応答を入れない');
  assert(mock.calls.every(c => c.startsWith('GET')), '新しい会話の操作（送信中を含む）で kintone の設定へ書き込まない');
}

// =========================================================
console.log('\n--- U8（Phase 20・利用者の指摘）. 確認事項は質問ごとの回答欄で答え、入力した回答だけを計画の修正として送る ---');
{
  const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] } } }, usage: { monthlyLimit: 200, usedThisMonth: 1 } };
  const respOf = (goal) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'pl-u8', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 200 } }, plan: { goal, solution: 'STANDARD', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], gaps: [], evidenceIds: [] }, relevantFields: [], proposedFields: [], steps: [step('P1', 'ADD_VIEW', 'VIEW', '高額案件', { name: '高額案件', fields: ['amount'] })], alternatives: [], impact: [], questions: [{ id: 'Q1', question: '高額とはいくらからですか？', priority: 'blocking' }, { id: 'Q2', question: '一覧に表示する項目は金額だけでよいですか？', priority: 'blocking' }], unknowns: [], planConfidence: 'INFERRED', customizations: [] } });
  const calls = [];
  //   C-1 第 3 段（2026-10-08）: 確認事項のカード（questions）は削除した。回答欄は最終案のカードの中で、先に決めたいこと（priority blocking）だけに出る（指示 B6・R10-1〜R10-4）。
  //   回答の受け付け・入力した回答だけを送ること・決定事項・再質問の扱いは同じなので、確認事項を先に決めたいことにして新しい流れの上で確かめる
  const client = { async getHealth() { return withProposal(HEALTH); }, propose: proposeByScript, async plan({ ctx, requestId }) { calls.push(ctx); const v = KTAiClient.validatePlan(K.rawWithPlannerMapping(respOf(ctx.goal), ctx), ctx); return { ...v.normalized, requestId, clientWarnings: v.warnings }; } };
  const storage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' }); settings.setConsent(true);
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const host = makeFakeHost();
  const panel = mountAiWorkspace(host, withDevBase(T, { getInputs: () => ({ data: DATA, deps: DEPS, scan: null, incoming: null }), copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false }, executor: { api: makeKintoneMock(DATA).api, appId: '310' } }));
  const $ = (id) => host.querySelector(`#${id}`);
  const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
  const click = (dataset) => $('kt-ai-chat').dispatch({ type: 'click', target: { dataset } });
  await ticks();
  await adoptOnPanel(panel); await ticks();
  const v1 = panel.conversation().activePlan();
  const html1 = $('kt-ai-chat').innerHTML;
  // 2026-10-06 利用者の指示で意図して更新: 番号（Q1 など）は出さず「1．」で並べる。C-1 第 3 段: 回答欄とボタン［回答を送る］は最終案のカードの中
  assert(/kt-ai-final-card/.test(html1) && !/kt-ai-questions-card/.test(html1) && (html1.match(/class="kt-ai-qa-input"/g) || []).length === 2 && /data-act="answer-questions"[^>]*>回答を送る</.test(html1) && /1．高額とはいくらからですか？/.test(html1) && /2．一覧に表示する項目は金額だけでよいですか？/.test(html1) && !/\bQ[12]\b/.test(html1.replace(/data-[a-z-]+="[^"]*"/g, '')), 'U8: 確認事項ごとに回答欄（2 件）と［回答を送る］（最終案のカードの中・Q 番号は出さない）');
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
  //   新しい流れでは仮案で決めたこと（出典 chat）も決定事項に入る。回答欄の回答（出典 answer-card）は 1 件だけ
  const fromCard = Array.isArray(last.decisions) ? last.decisions.filter(d => d.source === 'answer-card') : [];
  assert(fromCard.length === 1 && fromCard[0].answer === '100万円以上' && fromCard[0].status === 'answered' && /^D[1-9]/.test(fromCard[0].id), `U8: 回答欄の回答は決定事項（出典 answer-card）として Planner Context に載る: ${JSON.stringify(fromCard)}`);
  assert(panel.conversation().messages().some(m => m.type === 'USER' && /確認事項への回答/.test(m.text)), 'U8: 送った回答は会話に利用者の発言として残る');
  const html2 = $('kt-ai-chat').innerHTML;
  // 同じ Q1・Q2 を AI がもう一度質問した（respOf は毎回同じ質問を返す）→ 回答済みの Q1 は回答欄を出さない（再質問として数える）。Q2 だけ回答欄
  //   C-1 第 3 段: 回答は最終案のカードの「変わった点」に出る。古い版は 1 行に畳んだ前の最終案（読むだけ・回答欄なし）
  assert((html2.match(/class="kt-ai-qa-input"/g) || []).length === 1 && /前の最終案から変わった点[\s\S]*100万円以上/.test($('kt-ai-change-summary').innerHTML) && /前の最終案 — このあと直した案があります/.test(html2) && panel.conversation().metrics().reasked === 1, `U8: 回答欄は最新の版の未回答の確認事項だけ（回答済みの再質問は出さない・古い版は読むだけ）: reasked=${panel.conversation().metrics().reasked}`);
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
  //   C-1 第 3 段（2026-10-08）: 依頼は仮案の流れ。仮案（assistant-qa の conversation mode proposal）は共有の部品の台本で答え、計画（change-planner）の POST だけを数えて順に切り替える
  const transport = async (req) => {
    if (req.method === 'GET') return { status: 200, body: JSON.stringify(withProposal(HEALTH)) };
    const env = JSON.parse(req.body || '{}');
    if (env.meta && env.meta.feature === 'assistant-qa' && env.payload && env.payload.conversation && env.payload.conversation.mode === 'proposal') {
      const raw = K.script({ utterance: env.payload.question, previous: env.payload.conversation.proposal, requirements: env.payload.conversation.requirements });
      return { status: 200, body: JSON.stringify({ ok: true, contractVersion: '2.1', meta: K.META, ...K.gatewayIds(raw, env.payload.conversation) }) };
    }
    posts.push(req.url);
    const next = queue.shift() || 'ok';
    if (next === 'hang') return new Promise(() => { });
    if (next === 'gate') await new Promise((res) => { release = res; });
    if (next === 'malformed') return { status: 200, body: JSON.stringify({ ok: true, contractVersion: '2.1', meta: META, plan: { goal: GOAL, assessment: { summary: 's' } } }) };
    if (next === 'model-invalid') return { status: 502, body: JSON.stringify({ ok: false, contractVersion: '2.1', error: { code: 'MODEL_OUTPUT_INVALID', message: 'm', requestId: 'e-mi' } }) };
    //   2026-10-15（追加の指示 1）: 偽の計画の AI は要件の対応づけ（turn.requirementOps）を返す（K.rawWithPlannerMapping）
    return { status: 200, body: JSON.stringify(K.rawWithPlannerMapping(GOOD, env.payload)) };
  };
  const client = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 't.cybozu.com', transport, timeoutMs: 400 });   // gate（保留）の間に timeout しない長さ
  const storage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const mock = makeKintoneMock(data);
  const panel = mountAiWorkspace(host, withDevBase(T, { getInputs: () => inputs, copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow, executor: { api: mock.api, appId: '310' } }));
  const $ = (id) => host.querySelector(`#${id}`);
  const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
  const msgs = () => panel.conversation().messages();
  const last = () => msgs()[msgs().length - 1];
  const chat = () => $('kt-ai-chat').innerHTML;
  const plans = () => panel.conversation().planHistory().length;
  //   失敗のカードの［再試行］が送る文（採用の失敗では「採用します」。B3-2）
  const retryText = () => { const e = msgs().filter(m => m.type === 'ERROR').pop(); return (e && e.data && e.data.retryText) || '採用します'; };
  const retry = () => $('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act: 'retry', text: retryText() } } });
  const ADOPT = K.REQUESTS[3];
  // 2026-10-06 利用者の指示で意図して更新: エラーのカードの code（と requestId）は本文ではなく［詳細情報］（details.kt-ai-tech）の中。[CODE] の形では出さない
  const techCode = (code, { requestId = false } = {}) => {
    const h = chat();
    const inTech = new RegExp(`<details class="kt-ai-tech"><summary>詳細情報</summary><div class="kt-ai-error-code">${code}${requestId ? ' / requestId: [^<]+' : '( / requestId: [^<]+)?'}</div></details>`).test(h);
    return inTech && !h.includes(`[${code}]`);
  };
  // 応答（timeout を含む）が返って送信中でなくなるまで待つ / 要求が n 件送られるまで待つ
  const settle = async (ms = 3000) => { const t0 = Date.now(); await ticks(); while (panel.conversation().isBusy() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10)); await ticks(); };
  const sentCount = async (n, ms = 3000) => { const t0 = Date.now(); while (posts.length < n && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 5)); await ticks(); };
  await ticks();
  void GOAL;
  for (const s0 of K.REQUESTS.slice(0, 3)) { $('kt-ai-input').value = s0; await $('kt-ai-send').dispatch('click'); await settle(); }
  assert(posts.length === 0 && panel.conversation().draft() && panel.conversation().draft().status === 'open', '前提: 仮案まで（計画の AI はまだ呼ばない）');
  // FR-1: 応答が返らない → client の timeout（採用の後の計画の要求）
  queue.push('hang');
  $('kt-ai-input').value = ADOPT;
  $('kt-ai-send').dispatch('click'); await settle();
  assert(posts.length === 1 && last().type === 'ERROR' && last().data.code === 'TIMEOUT' && /data-act="retry"/.test(chat()) && $('kt-ai-input').value === ADOPT && plans() === 0 && !msgs().some(m => m.type === 'FINAL') && !panel.conversation().isBusy() && $('kt-ai-send').disabled === false, `FR-1: タイムアウト → エラーカード（再試行）・入力欄の文は残る・計画は登録しない・続けて送信できる: ${JSON.stringify({ posts: posts.length, last: last().type, code: last().data && last().data.code, input: $('kt-ai-input').value })}`);
  // FR-2: 不完全な応答（plan.steps が無い）→ client の検証で拒否 / Gateway の MODEL_OUTPUT_INVALID
  queue.push('malformed');
  retry(); await settle();
  assert(posts.length === 2 && last().type === 'ERROR' && last().data.code === 'INVALID_RESPONSE' && techCode('INVALID_RESPONSE') && plans() === 0, 'FR-2: plan の形が不完全な応答 → INVALID_RESPONSE（計画として登録しない・理由の code は［詳細情報］の中に表示し、本文に [CODE] の形では出さない）');
  queue.push('model-invalid');
  retry(); await settle();
  assert(posts.length === 3 && last().type === 'ERROR' && last().data.code === 'MODEL_OUTPUT_INVALID' && techCode('MODEL_OUTPUT_INVALID', { requestId: true }) && plans() === 0 && $('kt-ai-input').value === ADOPT, 'FR-2: Gateway が AI 出力を契約違反と判定（502 MODEL_OUTPUT_INVALID）→ 登録しない・入力は残る（code と requestId は［詳細情報］の中）');
  // FR-7 / FR-6: 再試行の応答待ちに［再試行］と［送信］をもう一度押しても要求は 1 回。応答が来たら計画は 1 件だけ
  queue.push('gate');
  const p1 = retry(); await sentCount(4);
  assert(panel.conversation().isBusy() && posts.length === 4, '前提: 再試行の要求を送信中（応答待ち）');
  const p2 = retry(); const p3 = $('kt-ai-send').dispatch('click'); await ticks();
  assert(posts.length === 4, 'FR-6: 送信中の［再試行］［送信］の再クリックで要求を重ねない（POST は 4 回のまま）');
  release(); await p1; await p2; await p3; await settle();
  assert(posts.length === 4 && plans() === 1 && msgs().filter(m => m.type === 'FINAL').length === 1 && panel.conversation().activePlan().version === 1 && $('kt-ai-input').value === '', `FR-7: 失敗の後の再試行で計画 v1 が 1 件だけ登録される（最終案のカードも 1 枚・重複しない）・成功後に入力欄は空: ${JSON.stringify({ posts: posts.length, plans: plans(), input: $('kt-ai-input').value })}`);
  assert(mock.calls.every(c => c.startsWith('GET')), 'FR-1 / FR-2 / FR-7: AI の失敗・再試行で kintone の設定へ書き込まない');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
