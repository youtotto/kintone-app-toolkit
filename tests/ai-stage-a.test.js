// 段階 A（会話フローの再設計 §2.6 / §3）: JS 生成・検証の修正（5.1〜5.6）と回帰ケース R12〜R15
//
// 検証内容:
//   T-A1（5.1）計画の新設分を生成に渡す: buildGenerator の planned（statuses / fields）・dictionary.statuses = 現在 ∪ 新設・allowedFields は fields[] と同じ集合・style の文
//   T-A2（5.2）新規フィールドの接続: 実装仕様の条件と標準設定の spec の NEW_FIELD_n を採番後のコードに置換（条件の値の照合 conditional-control は C-1 第 2 段で削除。生成工程の代表条件で守る）
//   T-A3（5.3）R12 / R13: error と disabled の重なり（旧 error-cancels-edit）は C-1 第 2 段で Toolkit の判定から外した（生成工程の模擬テストで守る）。siteConds の字句の形だけ確かめる
//   T-A4（5.4）未実装を完成扱いしない: 範囲内の NOT_MET は coverage-unmet（block）・PARTIAL は review。見出しは「要件を満たしていない部分があります（登録できません）」
//   T-A5（5.5）var: patch を入れる handler の中の既存の var を安全な判定で const / let に更新。handler の外・安全でない宣言は変えない
//   T-A6（5.6）同じ入力・同じ指摘での再生成は AI を呼ばない。生成の回数と token / 費用の見積もり（「生成 N 回目」）。
//     C-1 第 3 段（2026-10-08）: 会話の部分は新しい流れ（仮案 → 採用 → 最終案 → 「コードを作って」で最終案の作り直し）の上で試す
//   T-A7（R14）新設の依存: dependsOn が動作テスト環境に無ければ DEPENDENCY_NOT_APPLIED で登録しない。再検査は実在するフィールドだけ。反映後は登録できる
//   T-A8（R15）編集制限コードの検証: 両承認待ち・通常編集・一覧編集・明細・保存禁止・既存制御（行操作の制限と保存禁止を混同しない）
//   T-A9（独立レビューの指摘）早い return の誤認（入れ子の if / for の return・callback の return）・not in の条件・緩い等号と再代入・宣言の更新は handler の中だけ・
//     依存の確認手段が無いとき・文字列の中の } ・同じ入力の 2 回目で止める・前提の手順番号の置き換え・使用量の実測・AI の申告と Toolkit の確認の二重の解消
//   T-A10（修正後レビューの指摘）自分の要件の NOT_MET は担当範囲外に読み替えない・担当は設定を実際に変える手順だけ・repeatOf の案内文・検査名の日本語・
//     検査が完了しなかった回の案内・plannedHint の単語境界とラベル優先・計画が無いときの displayNote・generate-repeat の描画・括弧で囲んだ否定の条件
//
// 実行方法: node tests/ai-stage-a.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTDeps, KTScan, KTContext, KTCodeReview, KTJsExecutor, KTAiConversation, KTAiWorkspaceViewModel, KTAiChatUi } = T;
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const R = require('./fixtures/p21-bfc-replay.js');
const SA = require('./fixtures/stage-a-edit-lock.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
//   C-1 第 3 段（2026-10-08）: 会話の試験（T-A6・T-A10 の 4 / 7）は新しい流れ（仮案 → 採用 → 最終案）の上で行う（共有の部品）
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const VM = KTAiWorkspaceViewModel;
const clone = (v) => JSON.parse(JSON.stringify(v));
const clean = (t) => KTScan.stripCommentsOnly(t);
const check = (rv, name) => (rv.checks || []).find(x => x.name === name) || null;
const codesOf = (list) => (list || []).map(x => x.code);
const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }

// ---- 計画の fixture（ai-spec-retention.test.js と同じ形）----
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], changeKind: null, assigneeType: null, customizationId: null, ...o });
const mkStep = (id, actionType, targetKind, targetRef, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, ...extra });
const mkPlan = (steps, extra = {}) => ({ planVersion: '1', goal: 'g', assessment: { summary: '', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps, alternatives: [], impact: [], questions: [], provisionals: [], unknowns: [], planConfidence: 'INFERRED', solution: 'STANDARD', customizations: [], ...extra });

// ---- アプリの定義: App 353 のフィールド（金額・明細 items・ステータス）＋ プロセス管理 ----
const dataWith = (status) => { const d = FX.makeData(); d.fields = clone(R.FIELDS); d.status = clone(status); return d; };
const STATUS_NOW = { enable: true, states: { '作成中': { name: '作成中', index: '0', assignee: { type: 'ONE', entities: [] } }, '承認待ち': { name: '承認待ち', index: '1', assignee: { type: 'ONE', entities: [] } }, '承認済み': { name: '承認済み', index: '2', assignee: { type: 'ONE', entities: [] } } }, actions: [] };
const DATA = dataWith(STATUS_NOW);
const handler = (events, body) => `(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(events).replace(/"/g, "'")}, function (event) {\n    const record = event.record;\n${body}\n    return event;\n  });\n})();`;
const EDIT = ['app.record.edit.show'];
const cust = (o = {}) => ({ customizationId: 'C1', requirement: '承認待ちでは金額を編集不可にする', whyStandardInsufficient: '', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: ['desktop'], events: EDIT, fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち")' }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [], ...o });
const gen = (code, o = {}) => ({ strategy: 'NEW_JS_FILE', targetFile: 'lock.js', summary: 's', code, patch: null, events: EDIT, fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], ...o });
const review = (code, c = cust(), g = {}, o = {}) => KTCodeReview.review({ generated: gen(code, g), customization: c, plan: null, data: DATA, scan: null, existingSource: null, ...o });

// ---- R14 の計画: 部長承認待ち（新設）＋ 部長承認者（新規フィールド NEW_FIELD_1 → approver_mgr）----
const CUST_R14 = { customizationId: 'C1', requirement: 'ステータスが部長承認待ちで、部長承認者が自分でないときは金額を編集不可にする', whyStandardInsufficient: 'ステータスと人で切り替えるアクセス権は無い', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: ['desktop'], events: ['app.record.edit.show', 'app.record.edit.change.NEW_FIELD_1'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'NEW_FIELD_1', access: 'READ', condition: 'ステータス in ("部長承認待ち")' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("部長承認待ち") and NEW_FIELD_1 not in (LOGINUSER())' }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: ['P1', 'P2'], evidenceIds: [] };
const PLAN_R14 = mkPlan([
  mkStep('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認待ち', { name: '部長承認待ち', assigneeType: 'ONE', assignees: ['NEW_FIELD_1'] }, { title: 'ステータス「部長承認待ち」を追加' }),
  mkStep('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'USER_SELECT' }, { title: 'フィールド「部長承認者」を追加' }),
  mkStep('P3', 'ADD_VIEW', 'VIEW', '部長承認待ちの一覧', { filterCond: 'ステータス in ("部長承認待ち") and NEW_FIELD_1 in (LOGINUSER())', sort: 'NEW_FIELD_1 asc' }, { title: '一覧を追加' }),
  mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }),
], { goal: '100万円以上は部長承認にして、部長承認待ちでは部長以外は金額を直せなくして', solution: 'HYBRID', proposedFields: [{ temporaryId: 'NEW_FIELD_1', label: '部長承認者', suggestedCode: 'approver_mgr', type: 'USER_SELECT', required: false, reason: '部長承認の作業者', evidenceIds: [] }], customizations: [CUST_R14] });
const CODE_R14 = [
  "(function () {",
  "  'use strict';",
  "  kintone.events.on(['app.record.edit.show', 'app.record.edit.change.approver_mgr'], function (event) {",
  "    const record = event.record;",
  "    const st = record['ステータス'] ? record['ステータス'].value : '';",
  "    const approvers = record['approver_mgr'] ? record['approver_mgr'].value : [];",
  "    const me = kintone.getLoginUser().code;",
  "    if (st === '部長承認待ち' && !approvers.some(function (u) { return u.code === me; })) {",
  "      record['amount'].disabled = true;",
  "    }",
  "    return event;",
  "  });",
  "})();",
].join('\n');
const GEN_R14 = { strategy: 'NEW_JS_FILE', targetFile: 'mgrLock.js', summary: '部長承認待ちで部長承認者以外は金額を編集不可にします。', code: CODE_R14, patch: null, events: ['app.record.edit.show', 'app.record.edit.change.approver_mgr'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'approver_mgr', access: 'READ' }, { code: 'amount', access: 'CONTROL' }], apis: ['kintone.getLoginUser'], assumptions: [], warnings: [], coverage: [{ requirement: '部長承認待ちで部長承認者以外は金額を編集不可', status: 'MET', note: '' }] };

(async () => {
// =========================================================
console.log('\n--- T-A1（5.1）計画の新設分を生成に渡す: planned・dictionary.statuses・allowedFields・style ---');
await section(() => {
  const ctx = KTContext.buildGenerator({ customization: CUST_R14, plan: PLAN_R14, planId: 'p1', version: 1, data: DATA, deps: null, scan: null });
  assert(ctx.planned && JSON.stringify(ctx.planned.statuses) === JSON.stringify([{ name: '部長承認待ち', stepId: 'P1' }]), `planned.statuses = ADD_PROCESS_STATUS の spec.name と手順: ${JSON.stringify(ctx.planned && ctx.planned.statuses)}`);
  assert(ctx.planned && ctx.planned.fields.length === 1 && ctx.planned.fields[0].code === 'approver_mgr' && ctx.planned.fields[0].label === '部長承認者' && ctx.planned.fields[0].type === 'USER_SELECT' && ctx.planned.fields[0].stepId === 'P2', `planned.fields = proposedFields の採番後のコード・ラベル・型と ADD_FIELD の手順: ${JSON.stringify(ctx.planned && ctx.planned.fields)}`);
  assert(ctx.dictionary.statuses.includes('承認待ち') && ctx.dictionary.statuses.includes('承認済み') && ctx.dictionary.statuses.includes('部長承認待ち') && ctx.dictionary.statuses.filter(s => s === '部長承認待ち').length === 1, `dictionary.statuses = 現在 ∪ 新設（重複なし）: ${JSON.stringify(ctx.dictionary.statuses)}`);
  const af = ctx.constraints.allowedFields;
  assert(af.includes('approver_mgr') && af.includes('amount') && af.includes('ステータス') && ctx.fields.every(f => af.includes(f.code)), `allowedFields は fields[]（提案・イベント由来・ステータスを含む）と同じ集合: ${JSON.stringify(af)}`);
  assert(/planned にある名前/.test(ctx.constraints.style) && /dictionary に無い名前は書けない/.test(ctx.constraints.style), `style: dictionary に無い名前は書けない。planned の名前はその手順の反映が前提で書ける: ${ctx.constraints.style}`);
  // 現在のステータスが無いアプリ（プロセス管理が無効）でも planned だけで dictionary.statuses ができる
  const noProc = clone(DATA); noProc.status = { enable: false, states: {}, actions: [] };
  const ctx2 = KTContext.buildGenerator({ customization: CUST_R14, plan: PLAN_R14, planId: 'p1', version: 1, data: noProc });
  assert(JSON.stringify(ctx2.dictionary.statuses) === JSON.stringify(['部長承認待ち']), `プロセス管理が無効でも新設の名前は dictionary に入る: ${JSON.stringify(ctx2.dictionary.statuses)}`);
  // 計画が無ければ planned は空（契約の形は保つ）
  const ctx3 = KTContext.buildGenerator({ customization: cust(), plan: null, data: DATA });
  assert(ctx3.planned && ctx3.planned.statuses.length === 0 && ctx3.planned.fields.length === 0 && ctx3.dictionary.statuses.length === 3, '計画が無ければ planned は空・dictionary.statuses は現在のまま');
  // 生成の入力の指紋: 時刻とサイズを除いて同じ入力なら同じ値
  const h1 = KTContext.generatorInputHash(ctx), h2 = KTContext.generatorInputHash(KTContext.buildGenerator({ customization: CUST_R14, plan: PLAN_R14, planId: 'p1', version: 1, data: DATA, options: { now: '2030-01-01T00:00:00.000Z' } }));
  const h3 = KTContext.generatorInputHash(KTContext.buildGenerator({ customization: { ...CUST_R14, requirement: `${CUST_R14.requirement}。差戻し後は編集できる` }, plan: PLAN_R14, planId: 'p1', version: 1, data: DATA }));
  assert(h1 && h1 === h2 && h1 !== h3, `generatorInputHash: 時刻が違っても同じ入力なら同じ・要件が変われば違う: ${h1} / ${h2} / ${h3}`);
});

// =========================================================
console.log('\n--- T-A2（5.2）新規フィールドの接続: 条件・spec の NEW_FIELD_n の置換（条件の値の照合は C-1 第 2 段で生成工程へ） ---');
await section(() => {
  const ctx = KTContext.buildGenerator({ customization: CUST_R14, plan: PLAN_R14, planId: 'p1', version: 1, data: DATA });
  const f1 = ctx.customization.fields.find(f => f.code === 'approver_mgr');
  const fa = ctx.customization.fields.find(f => f.code === 'amount');
  assert(f1 && !/NEW_FIELD/.test(f1.condition || '') && fa && fa.condition === 'ステータス in ("部長承認待ち") and approver_mgr not in (LOGINUSER())', `customization.fields[].condition の NEW_FIELD_1 を approver_mgr に置換: ${JSON.stringify(ctx.customization.fields)}`);
  assert(!/NEW_FIELD/.test(JSON.stringify(ctx.customization)) && ctx.customization.events.includes('app.record.edit.change.approver_mgr'), 'customization のどこにも NEW_FIELD_n が残らない（イベントも採番後）');
  const p3 = ctx.plan.standardSteps.find(s => s.id === 'P3');
  const p1 = ctx.plan.standardSteps.find(s => s.id === 'P1');
  assert(p3 && p3.spec.filterCond === 'ステータス in ("部長承認待ち") and approver_mgr in (LOGINUSER())' && p3.spec.sort === 'approver_mgr asc' && p1 && JSON.stringify(p1.spec.assignees) === JSON.stringify(['approver_mgr']), `standardSteps の spec（条件式・並び順・作業者）の NEW_FIELD_1 も置換: ${JSON.stringify([p1 && p1.spec, p3 && p3.spec])}`);
  // 対応表は 1 つ（KTContext.proposedCodeMap）
  const map = KTContext.proposedCodeMap(PLAN_R14);
  assert(map.get('NEW_FIELD_1') === 'approver_mgr' && KTContext.resolveProposedRefs('NEW_FIELD_1 = "x" and NEW_FIELD_2 = "y"', map) === 'approver_mgr = "x" and NEW_FIELD_2 = "y"', '置換は計画の正規化が残した suggestedCode の対応表で行い、対応の無い仮の名前はそのまま');
  // C-1 第 2 段（設計 §0d.4）: 囲む条件が計画の条件（値まで）を見ているかの照合（旧 conditional-control・planCond）は Toolkit では行わない。
  //   条件どおりに動くかは生成工程の代表条件で守る: Gateway worker/test/cases/required-effects.mjs「lock: 条件に合う（承認済）→ lock・合わない（作成中）→ not-locked…」・
  //   「A1 in の値ごと（本物の隔離環境）…「新規だけ」で編集不可にする誤った候補 → failed」・「A1 E1c（本物の隔離環境）…ステータスだけ見る誤った候補 → failed」、
  //   sandbox/test/cross-toolkit.mjs「7-3: 条件に合う側は in の値ごとに作る」・「7-6: 条件の両方・in の値のすべてを見る正しい候補は passed」。
  //   ここでは、置換後の計画（approver_mgr）で形式確認が通ること・正しい条件の書き方を形式確認が止めないことだけを確かめる
  const rv = KTCodeReview.review({ generated: GEN_R14, customization: CUST_R14, plan: PLAN_R14, data: DATA, scan: null, existingSource: null });
  assert(rv.status !== 'BLOCKED' && !(rv.checks || []).some(x => /NEW_FIELD/.test(x.message || '')), `Review: 置換後の計画（approver_mgr）で形式確認が通る（NEW_FIELD_n を指摘の文に出さない）: ${rv.status} ${JSON.stringify(codesOf(rv.registration.blockers))}`);
  const right = review(handler(EDIT, "    if (record['ステータス'].value === '承認待ち') {\n      record['amount'].disabled = true;\n    }"));
  assert(right.registration.verdict === 'RUNTIME_UNVERIFIED', '値が同じ（承認待ち）→ 通過（動作は未確認のまま）');
  const sw = review(handler(EDIT, "    switch (record['ステータス'].value) {\n      case '承認待ち':\n        record['amount'].disabled = true;\n        break;\n      default:\n        break;\n    }"));
  assert(sw.registration.verdict !== 'BLOCKED', `switch の case の中 → 形式確認では止めない: ${sw.registration.verdict}`);
});

// =========================================================
console.log('\n--- T-A3（5.3 → 段階 C → C-1 第 2 段）R12 / R13: error と disabled の重なりは Toolkit では判定しない（実際の競合は生成工程の模擬テスト） ---');
//   段階 A の静的な排他判定（早い return の否定・同じ判別式と別の値・switch の別の case・if / else の別の枝）は段階 C で削除した（改訂 2: 任意の分岐の解析で採用可否を決めない）。
//   C-1 第 2 段（2026-10-08・設計 §0d.4）: Toolkit の模擬実行（KTJsSim）と、同じイベントの error と disabled / value の重なりの静的な判定
//   （error-cancels-edit・error-cancels-other-js・errorGuarded・errorGuardedByDisabled・simDecides）は削除した。守っていた振る舞いは次の生成工程の回帰で守る:
//   - 排他の書き方（else・switch・別の値・早い return）は取り消しが起きない: AI版 sandbox/test/run.mjs「§2 R12: 排他（else・switch・別の値・早い return）」の
//     「R12 {else / switch / 別の値 / 早いreturn}: 承認待ちでは amount が編集不可（取り消し無し）」
//   - 実際に重なる書き方は取り消される: sandbox/test/run.mjs「§3 R13」の「R13 同じ handler: error で disabled が取り消される」・
//     「R13 同じファイルの別 handler…」・「R13 別ファイル: 既存の disabled が候補の error で取り消される」・「R13 event.error…」・「R13 値の変更と error…」
//   - 生成工程の判定: worker/test/cases/required-effects.mjs「§0d.1 S7（既知の競合）…check behavior（checkReason candidate-error-same-event…）」・
//     「取り消し: 候補が同じイベントで error を表示すると kintone の規則で disabled が取り消される → lock は fail…」・
//     「レビュー S11: 既存 JS の error で候補の編集不可が取り消される → not-run（existing…）」、sandbox/test/cross-toolkit.mjs「5-3: error と disabled を同時に立てる候補は failed」
//   - 生成工程で確かめていない JavaScript は登録しない・承認できない（Toolkit が維持する取り込みの判定。ai-flow-redesign の D14・D27・D8）
await section(async () => {
  // siteConds は Phase 21 の形（早い return の否定）だけ残す。else if の手前の枝の否定・switch の case のラベル（段階 A）は付けない
  const ops = KTCodeReview.fieldOperations(clean(handler(EDIT, "    const st = record['ステータス'].value;\n    if (!st) {\n      record['amount'].error = 'x';\n      return event;\n    }\n    if (st === 'A') {\n      record['amount'].disabled = true;\n    } else if (st === 'B') {\n      record['amount'].disabled = false;\n    }\n    switch (st) {\n      case 'C':\n        record['amount'].disabled = true;\n        break;\n    }")));
  const condsOf = (op) => (op.conds || []).map(t => String(t).replace(/\s*\/\*[\s\S]*?\*\/\s*$/, ''));
  const dA = ops.find(o => o.op === 'disabled'), dB = ops.find(o => o.op === 'enabled'), dC = ops.filter(o => o.op === 'disabled').pop();
  assert(dA && condsOf(dA).includes('!(!st)') && dB && !condsOf(dB).some(t => /else of/.test(t)) && dC && condsOf(dC).some(t => t === 'switch (st)'), `siteConds: 早い return の否定は残し、else if の手前の枝の否定・switch の case のラベル（段階 A）は外した: ${JSON.stringify([condsOf(dA), condsOf(dB), condsOf(dC)])}`);
  // 形式確認（静的）は動作を確かめた扱いにしない: 同じ経路で無条件に disabled と error を設定するコードでも、動作の未確認（RUNTIME_NOT_RUN）が残る
  const both = review(handler(EDIT, "    record['amount'].disabled = true;\n    record['amount'].error = '確認してください';"));
  assert((both.registration.unverified || []).some(u => u.code === 'RUNTIME_NOT_RUN') && !check(both, 'error-cancels-edit'), `R13: 形式確認は動作を確かめた扱いにしない（RUNTIME_NOT_RUN）。重なりの判定は生成工程の模擬テスト（sandbox §3）: ${both.registration.verdict} ${JSON.stringify((both.registration.unverified || []).map(u => u.code))}`);
});

// =========================================================
console.log('\n--- T-A4（5.4）未実装を完成扱いしない: coverage-unmet・見出し・計画の新設を前提に作り直す案内 ---');
await section(() => {
  const okCode = handler(EDIT, "    if (record['ステータス'].value === '承認待ち') {\n      record['amount'].disabled = true;\n    }");
  const covNotMet = [{ requirement: '承認待ちでは金額を編集不可にする', status: 'MET', note: '' }, { requirement: '部長承認待ちでも金額を編集不可にする', status: 'NOT_MET', note: '部長承認待ちは現在のステータスに無いため実装していません' }];
  const rv = review(okCode, cust(), { coverage: covNotMet });
  const cu = (rv.checks || []).filter(x => x.name === 'coverage-unmet');
  assert(rv.status === 'BLOCKED' && rv.registration.verdict === 'BLOCKED' && cu.length === 1 && cu[0].severity === 'block' && /要件を満たしていません/.test(cu[0].message) && /部長承認待ちでも金額を編集不可にする/.test(cu[0].message) && codesOf(rv.registration.blockers).includes('coverage-unmet'), `範囲内の NOT_MET → check coverage-unmet（block）・登録の判定は BLOCKED（以前は「✓ 静的な検査は通過」と並んだ）: ${JSON.stringify(cu)} ${rv.registration.verdict}`);
  const rvP = review(okCode, cust(), { coverage: [{ requirement: '明細の行の追加・削除も止める', status: 'PARTIAL', note: 'セルだけ' }] });
  const cuP = (rvP.checks || []).filter(x => x.name === 'coverage-unmet');
  assert(rvP.status === 'REVIEW_REQUIRED' && cuP.length === 1 && cuP[0].severity === 'review' && rvP.registration.verdict === 'NEEDS_CONFIRMATION' && rvP.registration.confirmations.some(x => x.code === 'coverage-unmet'), `PARTIAL → review（登録の前に確認）: ${JSON.stringify(cuP)}`);
  // SUBTABLE_ROWS（行の追加・削除）は従来どおり確認事項（check にしない・block にしない）
  const tableCust = cust({ requirement: '承認待ちでは明細（items）を編集不可にする', fields: [{ code: 'ステータス', access: 'READ' }, { code: 'items', access: 'CONTROL', condition: 'ステータス in ("承認待ち")' }] });
  const rvT = review(handler(EDIT, "    if (record['ステータス'].value === '承認待ち') {\n      record['items'].value.forEach(function (row) {\n        row.value['qty'].disabled = true;\n      });\n    }"), tableCust, { summary: '承認待ちでは明細のセルを編集不可にします', fields: [{ code: 'items', access: 'CONTROL' }] });
  assert(rvT.coverage.notAchieved.some(x => x.code === 'SUBTABLE_ROWS') && !(rvT.checks || []).some(x => x.name === 'coverage-unmet') && rvT.registration.verdict !== 'BLOCKED', `SUBTABLE_ROWS は coverage の確認事項のまま（coverage-unmet にしない・登録不可にしない）: ${rvT.registration.verdict} ${JSON.stringify(codesOf(rvT.registration.blockers))}`);
  // 段階 C: 計画の新設の名前を requirement の文から照合する plannedHint（段階 A）は削除した（文からの推定を減らす）。新設に関わる未達も、この JavaScript の id の NOT_MET として登録不可のまま
  const rvPl = KTCodeReview.review({ generated: { ...GEN_R14, coverage: [{ requirementId: 'C1', requirement: 'ステータスが「部長承認待ち」のときは部長承認者以外は金額を編集不可にする', status: 'NOT_MET', note: '部長承認待ちというステータスは存在しないため実装できません' }] }, customization: CUST_R14, plan: PLAN_R14, data: DATA, scan: null, existingSource: null });
  assert(!('plannedHint' in rvPl.coverage) && rvPl.registration.verdict === 'BLOCKED' && rvPl.coverage.notAchieved.some(x => x.code === 'AI_NOT_MET' && x.requirementId === 'C1'), `plannedHint は無い。自分の id の NOT_MET は登録不可: ${JSON.stringify(rvPl.coverage.notAchieved)}`);
  // 表示: VM.codeSummary（見出し・登録できるか）・コードペイン
  //   C-1 第 3 段（2026-10-08）: 会話のコードのカード（MSG.CODE・codeCardHtml）は削除した（JavaScript は最終案のカードの中だけ）。カードの見出し・「生成 N 回目」・
  //   AI の申告を 1 回だけ出す期待は、下のコードペインの同じ期待と、ai-flow-redesign の F7-2（コードのカードの描画は無い）・F2-3（最終案を通らない生成のカードは出ない）・
  //   R19-3 / R19-5（未解決の理由と次の方針は最終案のカードに 1 回だけ）・D1-4（検証の区分に必須の動作の未達）で守る
  const entry = { generated: gen(okCode, { coverage: covNotMet }), review: rv, existingSource: null, attempts: { count: 2, measured: 2, tokens: { input: 3000, output: 400 }, costUsd: 0.01 } };
  const v = { planId: 'p', version: 1, goal: 'g', plan: mkPlan([], { customizations: [cust()] }), review: null, ctx: null, status: 'ACTIVE', generated: { C1: entry } };
  const cs = VM.codeSummary(entry, 'C1', v);
  assert(cs.unmet.length === 1 && cs.headline === 'JavaScript を作りましたが、要件を満たしていない部分があります（登録できません）。' && cs.verdictJa === '× 要件を満たしていない部分があります（登録できません）' && cs.blocked && cs.attemptCount === 2, `codeSummary: 見出しと登録の判定は「要件を満たしていない部分があります（登録できません）」・生成の回数: ${JSON.stringify({ headline: cs.headline, verdictJa: cs.verdictJa, attemptCount: cs.attemptCount })}`);
  const pane = KTAiChatUi.codePaneHtml(entry);
  assert(/× 要件を満たしていない部分があります（登録できません）/.test(pane.head) && !/静的な検査は通過/.test(pane.head) && /生成 2 回目（使用量: 入力 3000 \/ 出力 400 token/.test(pane.head) && !/見積もり/.test(pane.head), `コードペインの見出しも同じ（登録の判定・生成の回数と実測の使用量）: ${pane.head.replace(/<[^>]*>/g, '').slice(0, 300)}`);
  assert((pane.head.match(/部長承認待ちでも金額を編集不可にする/g) || []).length === 1 && !/（Toolkit の確認）/.test(pane.head) && /要件の達成: 要件を満たしていません（AI の申告）/.test(pane.review), 'コードペイン: AI の申告は検査の一覧（要件の達成）に 1 回だけ。Toolkit の確認の行には出さない');
  //   C-1 第 3 段: コードのカードの「新設の項目の案内（plannedHint）は出さない」は、上の rvPl（plannedHint は無い）とコードペインで守る
  const panePl = KTAiChatUi.codePaneHtml({ generated: GEN_R14, review: rvPl, existingSource: null });
  assert(!/kt-ai-code-planned-hint/.test(panePl.head + panePl.review) && !/前提にした作り直し/.test(panePl.head + panePl.review), 'コードペイン: 新設の項目の案内（plannedHint）は出さない');
});

// =========================================================
// 確認 7（C-1 第 2 段で tests/ai-js-sim.test.js から移した。模擬実行を使わない KTCodeReview の回帰）:
//   JavaScript で直せない制約（行の追加・削除）を NOT_MET と申告 → 登録不可のまま修復を頼まない（SUBTABLE_ROWS で示す）
console.log('\n--- T-A4b 確認 7: 行の追加・削除を理由にした NOT_MET は登録不可のまま修復の対象外 ---');
//   C-1 第 3 段（2026-10-08）: 理由（行の追加・削除）は生成工程が返す coverage の limitCode（SUBTABLE_ROWS）だけで決める。AI の申告の文（note）は読まない
//   （ai-flow-redesign の D15-3〜D15-6・F9-1 と同じ規則）。期待（登録不可のまま・修復の対象外・達成範囲に SUBTABLE_ROWS・ほかの理由は修復の対象）はそのまま
await section(() => {
  const GOOD_LOCK_C1F = handler(EDIT, "    if (record['ステータス'] && record['ステータス'].value === '承認待ち') record['amount'].disabled = true;");
  const rv = (note, limitCode = null) => KTCodeReview.review({ generated: gen(GOOD_LOCK_C1F, { coverage: [{ requirementId: 'C1', status: 'NOT_MET', note, text: '承認待ちでは明細を編集不可', ...(limitCode ? { limitCode } : {}) }] }), customization: cust({ requirement: '承認待ちでは明細を編集不可' }), plan: { customizations: [cust()], steps: [] }, data: clone(DATA), scan: null, existingSource: null });
  const rows = rv('テーブルの行の追加・削除は JavaScript では止められない', 'SUBTABLE_ROWS');
  const cu = rows.checks.find(x => x.name === 'coverage-unmet');
  assert(rows.registration.verdict === 'BLOCKED' && cu && cu.severity === 'block' && cu.noRepair === true && cu.limit === 'SUBTABLE_ROWS' && rows.coverage.notAchieved.some(x => x.code === 'SUBTABLE_ROWS'), `確認 7: 行の追加・削除（limitCode SUBTABLE_ROWS）を理由にした NOT_MET は登録不可のまま・修復の対象外（noRepair）・達成範囲に SUBTABLE_ROWS: ${JSON.stringify(cu)}`);
  const other = rv('一部の条件を満たせない').checks.find(x => x.name === 'coverage-unmet');
  assert(other && other.severity === 'block' && !other.noRepair, '確認 7: ほかの理由の NOT_MET は従来どおり修復の対象');
  //   limitCode の無い申告は、文に行の追加・削除と書いてあっても登録不可のまま（文を読んで修復の対象外にはしない）
  const noCode = rv('テーブルの行の追加・削除は JavaScript では止められない');
  const cuN = noCode.checks.find(x => x.name === 'coverage-unmet');
  assert(noCode.registration.verdict === 'BLOCKED' && cuN && cuN.severity === 'block' && !cuN.noRepair, `確認 7: limitCode の無い NOT_MET は文を読まずに登録不可のまま（修復の対象外にしない）: ${JSON.stringify(cuN)}`);
});

// =========================================================
console.log('\n--- T-A5（5.5 → 段階 C → 簡素化 B）var: 記法の修正と検査は生成工程だけ。既存の var を含む統合先へ patch を当てても全文を書き換えない ---');
//   段階 A の「変更する handler の本体の既存 var の自動変換」は段階 C で外した（改訂 2: 任意の既存コードの独自変換器を広げない）。簡素化 B（2026-10-16）で、Toolkit の記法の
//   写し（KTModernJs）も削除した（追加した var だけを直し、handler の外・別の handler・同じ handler の既存の var を変えないことは AI版 worker/test/cases/modern-js.mjs が確かめる）
await section(() => {
  const SRC = R.DEAL_LOCK;   // handler の中に var record
  const content = "      record['items'].value.forEach(function (row) {\n        row.value['qty'].disabled = true;\n      });\n";
  const g = { strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', code: content, patch: { baseHash: KTScan.hashText(SRC), operations: [{ type: 'INSERT_AFTER', anchor: "      record['amount'].disabled = true;", content }] }, events: ['app.record.edit.show'], fields: [{ code: 'qty', access: 'CONTROL' }], apis: [] };
  const src = { name: 'dealLock.js', target: 'desktop', text: SRC };
  const c = { customizationId: 'C1', requirement: '承認済みでは明細の数量を編集不可', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], events: ['app.record.create.show', 'app.record.edit.show'], fields: [{ code: 'qty', access: 'CONTROL' }], apis: [], existingFiles: [{ name: 'dealLock.js', target: 'desktop' }] };
  const rv = KTCodeReview.review({ generated: g, customization: c, plan: null, data: DATA, scan: null, existingSource: src });
  const pc = check(rv, 'patch');
  assert(pc && pc.ok && /元のコードは保持（全文の書き換えなし）$/.test(pc.message) && !/既存の宣言/.test(pc.message) && !check(rv, 'patch-removal') && !check(rv, 'modern-js') && /var record = event\.record;/.test(rv.finalCode || ''), `patch の検査: 既存の var record を含む統合先に挿入しても全文を書き換えず、置き換えも無い（記法は Toolkit では確かめない）: ${pc && pc.message}`);
});

// =========================================================
console.log('\n--- T-A6（5.6）同じ入力・同じ指摘での再生成は AI を呼ばない。生成の回数と見積もり ---');
await section(async () => {
  const { repeatOf, nextAttempts, generationEstimate } = KTAiConversation;
  // 純粋関数（独立レビュー B3 = 5.6 の解釈）: 同じ入力なら同じコード・同じ指摘になるので、同じ入力の 2 回目で止める。入力が変われば呼ぶ
  const a1 = nextAttempts(null, { inputHash: 'h1', blockers: ['fields'], estimate: { measured: true, input: 1000, output: 200, costUsd: 0.004 } });
  assert(a1.count === 1 && a1.sameInput === 0 && a1.measured === 1 && a1.history.length === 1 && a1.tokens.input === 1000 && a1.costUsd === 0.004, `attempts 1 回目: ${JSON.stringify(a1)}`);
  const rep = repeatOf({ attempts: a1 }, 'h1');
  assert(rep.repeat === true && /同じ入力・同じ指摘です。原因（入力の不足・指示・検証）を直してから作り直してください/.test(rep.message) && rep.hints.some(h => /存在しないフィールド/.test(h)) && rep.hints.some(h => /計画に新設するフィールド・ステータスがありません/.test(h)) && rep.blockers.join() === 'fields', `2 回目（同じ入力）→ 呼ばない。何を変えれば変わるか（planned に無い名前 → 計画の修正）: ${rep.message}`);
  // 再レビュー 2026-10-07: 判定は入力の指紋だけ。新設の手順を反映すると planned が変わり入力も変わる（「指摘の内容が変わったとき」とは言わない）
  assert(rep.hints.some(h => h === '計画で新設するステータス・フィールドを動作テスト環境に反映すると、生成の入力が変わり作り直せます。入力が同じまま作り直しても同じ結果になります') && !rep.hints.some(h => /指摘の内容が変わったとき|設定の手順を反映しても生成の入力は変わりません/.test(h)), `案内: 新設の手順を反映すると生成の入力が変わり作り直せる（判定は入力の指紋だけ）: ${JSON.stringify(rep.hints)}`);
  assert(!/（planned）/.test(JSON.stringify(KTAiConversation.REPEAT_HINT)) && !/\bplanned\b/.test(rep.message), '案内に内部名「（planned）」を出さない');
  assert(repeatOf({ attempts: a1 }, 'h1', { plannedNames: ['approver_mgr'] }).hints.every(h => !/計画に新設するフィールド・ステータスがありません/.test(h)), 'planned があるときはその案内を出さない');
  assert(repeatOf({ attempts: a1 }, 'h2').repeat === false, '入力が変われば呼ぶ');
  const a2 = nextAttempts({ attempts: a1 }, { inputHash: 'h2', blockers: ['conditional-control'], estimate: null });
  assert(a2.count === 2 && a2.sameInput === 0 && a2.measured === 1 && a2.tokens.input === 1000 && a2.costUsd === 0.004, `attempts 2 回目（別の入力・実測なし）: 回数は進み、使用量は実測が取れた回だけ足す: ${JSON.stringify({ count: a2.count, measured: a2.measured, tokens: a2.tokens, costUsd: a2.costUsd })}`);
  const okRep = repeatOf({ attempts: nextAttempts(null, { inputHash: 'h1', blockers: [] }) }, 'h1');
  assert(okRep.repeat && okRep.hints.some(h => /検査は通っています/.test(h)), '指摘が無い（検査を通った）コードの作り直しも、同じ入力では 2 回目から呼ばない（変えたい点を仕様に入れる案内）');
  assert(repeatOf(null, 'h1').repeat === false && repeatOf({ attempts: a1 }, null).repeat === false, '前の記録が無い・指紋が無ければ判定しない');
  // 独立レビュー A2: 対応表に無い指摘の案内は検査の日本語名（KTAiChatUi.CHECK_JA）で書く。内部名（code）は出さない
  const repDup = repeatOf({ attempts: nextAttempts(null, { inputHash: 'h1', blockers: ['duplicate-handler'] }) }, 'h1');
  assert(repDup.hints.some(h => h === '「重複 handler」の指摘の内容を直してください') && !/duplicate-handler/.test(repDup.message), `対応表に無い指摘 → 検査の日本語名: ${repDup.message}`);
  const repUnknown = repeatOf({ attempts: nextAttempts(null, { inputHash: 'h1', blockers: ['no-such-check'] }) }, 'h1');
  assert(repUnknown.hints.some(h => h === '「検査で止まった点」の指摘の内容を直してください') && !/no-such-check/.test(repUnknown.message), '日本語名も無い指摘 → 「検査で止まった点」');
  // 独立レビュー A4: 使用量は AI の記録（provider の生の形 input_tokens / output_tokens。無ければ prompt_tokens / completion_tokens）だけ。取れなければ数字を出さない
  const est = generationEstimate({ ctx: { size: { approxTokens: 5000 } }, generated: { code: 'a'.repeat(300) } });
  assert(est.measured === false && est.input === null && est.output === null && est.costUsd === null, `AI の記録が無ければ見積もらない（Context の概算・応答の長さから数字を作らない）: ${JSON.stringify(est)}`);
  const est2 = generationEstimate({ ctx: { size: { approxTokens: 5000 } }, generated: { code: 'x', ai: { model: 'm', usage: { input_tokens: 7000, output_tokens: 900 } } } });
  assert(est2.measured === true && est2.input === 7000 && est2.output === 900 && est2.costUsd === 0.023, `ai.usage.input_tokens / output_tokens（§10 の単価: 入力 $2 / 出力 $10 per 1M token）: ${JSON.stringify(est2)}`);
  const est3 = generationEstimate({ ctx: null, generated: { code: 'x', ai: { usage: { prompt_tokens: 100, completion_tokens: 10 } } } });
  assert(est3.measured === true && est3.input === 100 && est3.output === 10, 'prompt_tokens / completion_tokens の形も読む');
  const paneNoUsage = KTAiChatUi.codePaneHtml({ generated: gen("(function () { 'use strict'; })();"), review: null, existingSource: null, attempts: nextAttempts(null, { inputHash: 'h1', blockers: [] }) });
  assert(/生成 1 回目（使用量は未取得）/.test(paneNoUsage.head) && !/見積もり/.test(paneNoUsage.head), `実測が無ければ「使用量は未取得」（数字を出さない）: ${paneNoUsage.head.replace(/<[^>]*>/g, '').slice(0, 200)}`);
  // 会話: どの入口（『作って』・generate ボタン＝同じ GENERATE_CODE）でも services.generate に前の記録を渡し、REPEAT_SAME_INPUT なら案内だけ（エラーカードの［再試行］は出さない）
  //   C-1 第 3 段（2026-10-08）: 新しい流れ（仮案 → 採用 → 最終案）の上で試す。最初の生成は最終案のパイプラインが行い、最終案の後の「コードを作って」は
  //   同じ計画の新しい版で最終案を作り直す（ai-flow-redesign F2-1）。同じ入力のときの案内は、最終案のカードの「実現できない点」に出る（会話の generate-repeat・
  //   コードのカード・code-intro は削除した。F2-3・F7-2）
  const seen = [];
  const blockedReview = { status: 'BLOCKED', checks: [{ name: 'fields', ok: false, severity: 'block', message: '存在しないフィールドコードを参照しています: approver_mgr' }], registration: { verdict: 'BLOCKED', blockers: [{ code: 'fields', message: '存在しないフィールドコードを参照しています: approver_mgr' }], confirmations: [], unverified: [] }, coverage: { achieved: [], notAchieved: [], outOfScope: [], unowned: [] } };
  // 実物の services.generate と同じ順: 入力の指紋 → 前の記録と照合 → 同じなら AI を呼ばない
  const genRepeat = { calls: [], impl: async ({ previous }) => { seen.push(previous || null); const rep2 = repeatOf(previous, 'h1'); if (rep2.repeat) return { ok: false, reason: 'REPEAT_SAME_INPUT', message: rep2.message, hints: rep2.hints, blockers: rep2.blockers, attempts: previous.attempts, inputHash: 'h1' }; return { ok: true, generated: { code: "(function () { 'use strict'; })();", strategy: 'NEW_JS_FILE', targetFile: 'a.js', summary: 's' }, review: clone(blockedReview), ctx: { size: { approxTokens: 1200 } }, inputHash: 'h1' }; } };
  const x = K.makeConvC({ generate: genRepeat });
  await K.adoptC(x); await ticks();
  const v = x.c.activePlan();
  assert(seen.length === 1 && seen[0] === null && v.final && v.generated.C1 && v.generated.C1.inputHash === 'h1' && v.generated.C1.blockers.join() === 'fields' && v.generated.C1.attempts.count === 1 && v.generated.C1.attempts.measured === 0 && v.generated.C1.attempts.tokens.input === 0, `1 回目（最終案のパイプライン）: 前の記録なし → 版に指紋・blocker・回数を記録（AI の記録が無いので使用量は足さない）: ${JSON.stringify(v.generated.C1 && { inputHash: v.generated.C1.inputHash, blockers: v.generated.C1.blockers, attempts: v.generated.C1.attempts })}`);
  const before = x.c.messages().length;
  await x.c.send('コードを作って'); await ticks();
  const v2 = x.c.activePlan(), e2 = v2.generated.C1;
  const cannotText = (v2.final && v2.final.cannot ? v2.final.cannot : []).map(c => c.text).join('\n');
  assert(seen.length === 2 && seen[1] && seen[1].attempts.count === 1 && e2 && e2.failure && e2.failure.reason === 'REPEAT_SAME_INPUT' && /同じ入力・同じ指摘です/.test(cannotText) && /存在しないフィールドを参照しています/.test(cannotText) && /計画に新設するフィールド・ステータスがありません/.test(cannotText) && v2.final.approvable === false && !x.c.messages().slice(before).some(m => m.type === KTAiConversation.MSG.ERROR), `2 回目（同じ入力・同じ指摘）: AI を呼ばず「同じ入力・同じ指摘です」と何を変えれば変わるか（2 つ以上）を最終案のカードに出す。エラーカード（再試行）は出さない: ${cannotText.slice(0, 160)}`);
  assert(e2.attempts && e2.attempts.count === 1, `2 回目（同じ入力・同じ指摘）: AI を呼んでいないので生成の回数は増えない: ${JSON.stringify(e2.attempts && { count: e2.attempts.count, history: e2.attempts.history.length })}`);
});

// =========================================================
console.log('\n--- T-A7（R14）新設の依存: dependsOn が動作テスト環境に無ければ登録しない。再検査は実在するフィールドだけ。反映後は登録できる ---');
await section(async () => {
  // 生成時の Review（計画の新規フィールドは既知として検査）→ 通過。dependsOn にこのコードが使う新設の名前
  const rv = KTCodeReview.review({ generated: GEN_R14, customization: CUST_R14, plan: PLAN_R14, data: DATA, scan: null, existingSource: null });
  assert(rv.status !== 'BLOCKED' && rv.dependsOn && rv.dependsOn.statuses.map(x => x.name).join() === '部長承認待ち' && rv.dependsOn.statuses[0].stepId === 'P1' && /部長承認待ち/.test(rv.dependsOn.statuses[0].title) && rv.dependsOn.fields.map(x => x.code).join() === 'approver_mgr' && rv.dependsOn.fields[0].stepId === 'P2' && rv.registration.dependsOn.fields.length === 1, `Review: 生成コードが使う新設のステータス・フィールドを dependsOn に（手順つき）: ${rv.status} ${JSON.stringify(rv.dependsOn)} ${JSON.stringify(codesOf(rv.registration.blockers))}`);
  const rvNone = review(handler(EDIT, "    if (record['ステータス'].value === '承認待ち') {\n      record['amount'].disabled = true;\n    }"), cust(), {}, { plan: PLAN_R14 });
  assert(rvNone.dependsOn.statuses.length === 0 && rvNone.dependsOn.fields.length === 0, '新設の名前を使わないコードの dependsOn は空（計画に新設があっても）');
  // 登録前の再検査（existingOnly）: 新規フィールドを「存在する」扱いにしない → 実在しなければ登録不可
  const strict = KTCodeReview.review({ generated: GEN_R14, customization: CUST_R14, plan: PLAN_R14, data: DATA, scan: null, existingSource: null, existingOnly: true });
  assert(strict.registration.verdict === 'BLOCKED' && strict.registration.blockers.some(b => /approver_mgr/.test(b.message)), `再検査（existingOnly）: 実在しない approver_mgr を参照 → 登録不可: ${JSON.stringify(strict.registration.blockers.map(b => [b.code, b.message.slice(0, 60)]))}`);
  const applied = clone(DATA);
  applied.fields.approver_mgr = { type: 'USER_SELECT', code: 'approver_mgr', label: '部長承認者', noLabel: false, required: false, entities: [], defaultValue: [] };
  applied.status.states['部長承認待ち'] = { name: '部長承認待ち', index: '3', assignee: { type: 'ONE', entities: [] } };
  const strictOk = KTCodeReview.review({ generated: GEN_R14, customization: CUST_R14, plan: PLAN_R14, data: applied, scan: null, existingSource: null, existingOnly: true });
  assert(strictOk.registration.verdict !== 'BLOCKED' && strictOk.dependsOn.fields.length === 0 && strictOk.dependsOn.statuses.length === 0, `手順を反映した後の再検査（existingOnly）: フィールドが実在するので通過・依存も残らない: ${strictOk.registration.verdict} ${JSON.stringify(codesOf(strictOk.registration.blockers))}`);
  // KTJsExecutor.prepare: 動作テスト環境に新設の設定が無ければ DEPENDENCY_NOT_APPLIED（登録しない）
  const dataEnv = clone(DATA);
  dataEnv.customize = { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] }, revision: '12' };
  const m = makeKintoneMock(dataEnv, { jsSources: [] });
  const ch = KTJsExecutor.changeFromGenerated({ customization: CUST_R14, generated: GEN_R14, review: rv, existingNames: [] });
  assert(ch.ok && ch.change.dependsOn && ch.change.dependsOn.statuses[0].name === '部長承認待ち' && ch.change.dependsOn.fields[0].code === 'approver_mgr', `変更（change）に dependsOn が付く: ${JSON.stringify(ch.change && ch.change.dependsOn)}`);
  const p1 = await KTJsExecutor.prepare({ appId: '310', changes: [ch.change] }, { api: m.api });
  const dep = (p1.blockers || []).find(b => b.code === 'DEPENDENCY_NOT_APPLIED');
  // 独立レビュー A5: 文は「先に手順「…」を反映してください（このコードはその…を前提にしています）」（三重の括弧をやめる）。依存の文だけで、再検査の blocker を重ねない
  assert(p1.status === 'BLOCKED' && dep && dep.message === '先に手順「ステータス「部長承認待ち」を追加」・手順「フィールド「部長承認者」を追加」を反映してください（このコードはそのステータス・フィールドを前提にしています）' && p1.blockers.length === 1 && p1.changes[0].status === 'BLOCKED' && p1.changes[0].reason === 'DEPENDENCY_NOT_APPLIED' && !m.calls.some(x => /^(PUT|POST)/.test(x)), `prepare: 新設のステータス・フィールドが動作テスト環境に無い → DEPENDENCY_NOT_APPLIED（手順の名前つき）・書き込みなし: ${dep && dep.message}`);
  // input.dependsOn（全体）でも同じ。名前だけの指定も受ける（手順の名前が無ければ「ステータス「…」を追加する手順」）
  const p1b = await KTJsExecutor.prepare({ appId: '310', changes: [{ ...ch.change, dependsOn: null }], dependsOn: { statuses: ['部長承認待ち'], fields: [] } }, { api: m.api });
  assert(p1b.status === 'BLOCKED' && (p1b.blockers || []).some(b => b.code === 'DEPENDENCY_NOT_APPLIED' && b.message === '先にステータス「部長承認待ち」を追加する手順を反映してください（このコードはそのステータスを前提にしています）'), `prepare: input.dependsOn（名前だけ）でも止める: ${JSON.stringify((p1b.blockers || []).map(b => b.message))}`);
  // 標準設定の手順が EXECUTED になった後（動作テスト環境にステータスとフィールドがある）→ 登録できる
  m.st.status.states['部長承認待ち'] = { name: '部長承認待ち', index: '3', assignee: { type: 'ONE', entities: [] } };
  m.st.fields.approver_mgr = { type: 'USER_SELECT', code: 'approver_mgr', label: '部長承認者', noLabel: false, required: false, entities: [], defaultValue: [] };
  const p2 = await KTJsExecutor.prepare({ appId: '310', changes: [ch.change] }, { api: m.api });
  assert(p2.status === 'PREPARED' && !(p2.blockers || []).length && p2.changes[0].status === 'PENDING', `手順の反映後（ステータス・フィールドが動作テスト環境にある）→ 登録できる（PREPARED）: ${p2.status} ${JSON.stringify((p2.blockers || []).map(b => b.code))}`);
  // 依存の無い変更はこれまでどおり（確認の API も呼ばない）
  const m2 = makeKintoneMock(dataEnv, { jsSources: [] });
  const plain = KTJsExecutor.changeFromGenerated({ customization: cust(), generated: gen(handler(EDIT, "    if (record['ステータス'].value === '承認待ち') {\n      record['amount'].disabled = true;\n    }")), review: review(handler(EDIT, "    if (record['ステータス'].value === '承認待ち') {\n      record['amount'].disabled = true;\n    }")), existingNames: [] });
  const p3 = await KTJsExecutor.prepare({ appId: '310', changes: [plain.change] }, { api: m2.api });
  assert(p3.status === 'PREPARED' && !m2.calls.includes('GET status') && !m2.calls.includes('GET fields'), `依存が無ければ設定の確認は呼ばない: ${JSON.stringify(m2.calls)}`);
});

// =========================================================
console.log('\n--- T-A8（R15）編集制限コードの検証: 両承認待ち・通常編集・一覧編集・明細・保存禁止・既存制御 ---');
await section(() => {
  const data = dataWith(SA.STATUS);
  data.customize = { scope: 'ALL', desktop: { js: [{ type: 'FILE', file: { contentType: 'text/javascript', fileKey: 'pv:lock', name: 'dealLock.js', size: '422' } }, { type: 'FILE', file: { contentType: 'text/javascript', fileKey: 'pv:validate', name: 'dealValidate.js', size: '542' } }], css: [] }, mobile: { js: [], css: [] }, revision: '55' };
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const files = [{ name: 'dealLock.js', target: 'desktop', kind: 'js', text: SA.DEAL_LOCK }, { name: 'dealValidate.js', target: 'desktop', kind: 'js', text: SA.DEAL_VALIDATE }];
  const scan = KTScan.buildPayload({ appId: 353, files, fields: fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType })), deps: KTDeps.buildDependencyData(data, fieldsN), scannedAt: '2026-10-07T00:00:00.000Z' });
  const src = { name: 'dealLock.js', target: 'desktop', text: SA.DEAL_LOCK };
  const g0 = SA.generatedOf(KTScan.hashText(SA.DEAL_LOCK));
  //   簡素化 B（2026-10-16）: 記法の修正は生成工程だけ（Toolkit の写しは削除）。素材の生成コードは const で書かれている（新しい handler を足すだけ）
  assert(!(g0.patch && g0.patch.operations || []).some(o => /(^|[^\w$.])var\s/m.test(String(o.content || ''))), '前提: 素材の生成コード（足す handler）に var は無い');
  const rv = KTCodeReview.review({ generated: g0, customization: SA.CUSTOMIZATION, plan: null, data, scan, existingSource: src });
  const codes = codesOf(rv.registration.blockers);
  assert(rv.status !== 'BLOCKED' && rv.registration.verdict === 'NEEDS_CONFIRMATION' && !codes.length, `R15: 登録不可にはならない（確認が残る）: ${rv.status} ${JSON.stringify(rv.checks.filter(x => !x.ok).map(x => [x.name, x.severity, x.message.slice(0, 80)]))}`);
  const text = clean(rv.finalCode);
  // 両承認待ち状態: 金額のロックの経路に 2 つのステータス名（早い return の否定に両方）
  const amountSites = KTCodeReview.disableSites(text, 'amount').filter(x => /課長承認待ち/.test(JSON.stringify(x.conds)));
  assert(amountSites.length === 1 && /部長承認待ち/.test(JSON.stringify(amountSites[0].conds)) && !amountSites[0].unconditional, `両承認待ち: 金額のロックは課長承認待ち・部長承認待ちの両方を見る条件の中: ${JSON.stringify(amountSites.map(x => x.conds))}`);
  // C-1 第 2 段（設計 §0d.4）: 既存のロックと新しいロックの条件の照合・明細の列が計画の条件の中かの照合（旧 conditional-control）は Toolkit では行わない。
  //   同じ dealLock.js と dealValidate.js の組を生成工程の回帰で守る: AI版 sandbox/test/run.mjs §2 の「R15 課長承認待ち・編集画面: 金額と明細のセルがすべての行で編集不可」・
  //   「R15 部長承認待ち・一覧の編集: 金額と明細のセルがすべての行で編集不可」・「R15: 承認済みは既存のロック（同じファイルの既存の handler）で編集不可」・「R15: 作成中は編集できる」、
  //   worker/test/cases/required-effects.mjs「§0d.1 の 2: テーブルの列 → behavior（subtable-column）…」・「レビュー S8: テーブルの列の lock…」・
  //   「§0d.1 の 2: 同じ platform の既存 JS（送ったもの）がそのイベントを登録する・登録を読めない → behavior（existing-same-event）…」
  // 通常編集・一覧編集: 2 つのイベントが同じ handler にあり、planned-events / platform は通る
  const ops = KTCodeReview.kintoneFieldOps(text);
  const lockHandler = ops.find(h => h.events.includes('app.record.index.edit.show'));
  assert(lockHandler && lockHandler.events.includes('app.record.edit.show') && lockHandler.disabled && !lockHandler.error && !check(rv, 'planned-events') && check(rv, 'platform').ok, `通常編集（edit.show）と一覧編集（index.edit.show）の両方で編集不可にする handler がある: ${JSON.stringify(lockHandler && lockHandler.events)}`);
  // 明細: セルのロックは達成範囲、行の追加・削除（SUBTABLE_ROWS）は確認事項（登録不可にしない）
  assert(KTCodeReview.subtableCellSites(text, 'items').length === 3 && rv.coverage.achieved.some(a => /明細（テーブル items）のセルを編集不可にする/.test(a)), `明細: 3 列のセルのロックを達成範囲に: ${JSON.stringify(rv.coverage.achieved)}`);
  const rows = rv.coverage.notAchieved.find(x => x.code === 'SUBTABLE_ROWS');
  assert(rows && /行の追加・削除/.test(rows.message) && !/保存/.test(rows.message) && !codes.includes('coverage-unmet'), `行操作の制限: SUBTABLE_ROWS は「行の追加・削除は止められない」の確認（保存の話ではない・登録不可にしない）: ${rows && rows.message}`);
  const partial = rv.checks.find(x => x.name === 'coverage-unmet');
  assert(partial && partial.severity === 'review' && /行の追加・削除/.test(partial.message), `AI の申告の PARTIAL（行の追加・削除）は coverage-unmet の確認: ${partial && partial.message}`);
  // 保存禁止: 保存を止めるのは既存 dealValidate.js の submit の error（別の check・別の文言）。生成コードは error を設定しない → error-cancels-edit は重ならない
  const saveChecks = KTCodeReview.inputChecks(clean(SA.DEAL_VALIDATE));
  assert(saveChecks.length === 2 && saveChecks.every(x => x.kind === 'field-error' && x.target === 'amount' && x.events.includes('app.record.edit.submit')), `保存禁止: 既存 dealValidate.js の保存時（submit）の入力チェック（金額）: ${JSON.stringify(saveChecks.map(x => [x.kind, x.events]))}`);
  const ece = check(rv, 'error-cancels-edit');
  assert(!/\.error\s*=/.test(text) && (!ece || ece.ok) && !check(rv, 'error-cancels-other-js'), `生成コードも dealLock.js も error を設定せず、保存時のチェック（dealValidate.js の submit）とは別のイベントなので競合しない: ${ece ? ece.message : '（error の設定が無いので検査の対象外）'}`);
  assert(!rv.checks.some(x => x.name === 'summary-scope') && check(rv, 'patch').ok && !check(rv, 'patch-removal'), `AI の要約は「セル」と書いている（行の追加・削除を言い切らない）・既存の 2 ファイルは書き換えない: ${JSON.stringify(rv.checks.filter(x => /scope|patch/.test(x.name)).map(x => [x.name, x.ok]))}`);
  // 変更の組み立て: 既存の dealLock.js の差し替え（保存時のチェックの dealValidate.js は触らない）
  const ch = KTJsExecutor.changeFromGenerated({ customization: SA.CUSTOMIZATION, generated: g0, review: rv, existingSource: src });
  assert(ch.ok && ch.change.kind === 'REPLACE_FILE' && ch.change.name === 'dealLock.js' && ch.change.content.includes("record['ステータス'].value === '承認済み'") && ch.change.content.includes("st !== '課長承認待ち' && st !== '部長承認待ち'") && ch.change.dependsOn.statuses.length === 0, '登録の単位: dealLock.js の差し替え（承認済みの既存制御 ＋ 承認待ち 2 種類の新しい制御）。新設の依存は無い');
});

// =========================================================
console.log('\n--- T-A9（独立レビューの指摘）早い return の誤認・not in の条件・緩い等号と再代入・宣言の更新・依存の確認・文字列の中の }・前提の手順番号・二重の表示 ---');
await section(async () => {
  const okCode = handler(EDIT, "    if (record['ステータス'].value === '承認待ち') {\n      record['amount'].disabled = true;\n    }");
  // ---- A-1（段階 C → C-1 第 2 段）: 早い return の見分け（入れ子の if / for / callback の return）で競合を断定することはやめた。同じイベントの error と disabled の
  //   重なり（旧 error-cancels-edit）も Toolkit では判定しない。実際の重なりは生成工程で守る: AI版 sandbox/test/run.mjs「R12 早いreturn: 承認待ちでは amount が編集不可（取り消し無し）」・
  //   「R13 同じ handler: error で disabled が取り消される」、worker/test/cases/required-effects.mjs「§0d.1 S7（既知の競合）…candidate-error-same-event…」。ここでは siteConds の字句の形だけ確かめる
  const opsN = KTCodeReview.fieldOperations(clean(handler(EDIT, "    const st = record['ステータス'].value;\n    if (!st) {\n      record['amount'].error = 'x';\n      if (Number(record['amount'].value) > 100) return event;\n    }\n    record['amount'].disabled = true;")));
  const dN = opsN.find(o => o.op === 'disabled');
  assert(dN && dN.unconditional && !(dN.conds || []).length, `siteConds: 入れ子の return の if には否定（!(…)）を付けない（disabled は無条件のまま。字句の判定）: ${JSON.stringify(dN && dN.conds)}`);
  // 明細の行ごとの error と disabled（callback の中の return）も Toolkit では判定しない。行ごとの取り消しは AI版 sandbox/test/run.mjs「§12 テーブル（subtable）の行と列」と
  //   「R13 同じファイルの別 handler: 別のフィールドの error でも取り消される」、worker/test/cases/required-effects.mjs「レビュー S8: テーブルの列の lock…」で守る
  // ---- A-2: not in / != の条件を列挙で書いても形式確認は止めない（値の照合 conditional-control は C-1 第 2 段で削除）。条件どおりに動くかは生成工程で守る:
  //   worker/test/cases/required-effects.mjs「A4 F4（本物の隔離環境）: not in は許すステータス（承認待ち・承認済）のそれぞれで「合う」を作る…」・「A1 E1c（本物の隔離環境）…」
  const notIn = review(handler(EDIT, "    const st = record['ステータス'].value;\n    if (st === '作成中' || st === '承認待ち') {\n      record['amount'].disabled = true;\n    }"), cust({ fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス not in ("承認済み")' }] }));
  assert(notIn.registration.verdict !== 'BLOCKED', `A-2: not in ("承認済み") を列挙（作成中 / 承認待ち）で書いても BLOCKED にしない: ${notIn.registration.verdict}`);
  const notEq = review(handler(EDIT, "    const st = record['ステータス'].value;\n    if (st !== '承認済み') {\n      record['amount'].disabled = true;\n    }"), cust({ fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス != "承認済み"' }] }));
  assert(notEq.registration.verdict !== 'BLOCKED', 'A-2: != の条件でも BLOCKED にしない');
  // ---- B-3・C（段階 C → C-1 第 2 段）: 緩い等号・再代入の排他の判定と、重なりの確認の文（旧 error-cancels-edit の message）は判定ごと削除した。
  //   取り消しの理由の日本語の文は worker/test/cases/required-effects.mjs「取り消し: 候補が同じイベントで error を表示すると kintone の規則で disabled が取り消される → lock は fail（候補に起因・修復の対象）。文は日本語で取り消しの理由を書く」で守る
  // ---- B-5（段階 C）: 宣言の更新（var → const / let）を特別に数える処理（declUpdateCount）は削除。REPLACE で置き換えた既存の行は handler の内外を問わず patch-removal の確認
  const SRC5 = "(function () {\n  'use strict';\n  var LIMIT = 1000000;\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    var record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();\n";
  const c5 = { customizationId: 'C1', requirement: '承認済みでは明細の数量を編集不可', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'qty', access: 'CONTROL' }], apis: [], existingFiles: [{ name: 'dealLock.js', target: 'desktop' }] };
  const ins = "      record['items'].value.forEach(function (row) {\n        row.value['qty'].disabled = true;\n      });\n";
  const mk5 = (ops) => ({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', code: ins, patch: { baseHash: KTScan.hashText(SRC5), operations: ops }, events: ['app.record.edit.show'], fields: [{ code: 'qty', access: 'CONTROL' }], apis: [] });
  const src5 = { name: 'dealLock.js', target: 'desktop', text: SRC5 };
  const outer = KTCodeReview.review({ generated: mk5([{ type: 'INSERT_AFTER', anchor: "      record['amount'].disabled = true;", content: ins }, { type: 'REPLACE', anchor: '  var LIMIT = 1000000;', content: '  const LIMIT = 1000000;' }]), customization: c5, plan: null, data: DATA, scan: null, existingSource: src5 });
  assert(check(outer, 'patch') && !/既存の宣言/.test(check(outer, 'patch').message) && check(outer, 'patch-removal') && /既存の 1 行が置き換え/.test(check(outer, 'patch-removal').message), `B-5: handler の外の var LIMIT → const の REPLACE は patch-removal の確認: ${JSON.stringify(check(outer, 'patch-removal'))}`);
  const innerR = KTCodeReview.review({ generated: mk5([{ type: 'INSERT_AFTER', anchor: "      record['amount'].disabled = true;", content: ins }, { type: 'REPLACE', anchor: '    var record = event.record;', content: '    const record = event.record;' }]), customization: c5, plan: null, data: DATA, scan: null, existingSource: src5 });
  assert(!/既存の宣言/.test(check(innerR, 'patch').message) && check(innerR, 'patch-removal') && /既存の 1 行が置き換え/.test(check(innerR, 'patch-removal').message), `B-5: handler の中の var record → const の REPLACE も同じ扱い（特別に数えない）: ${check(innerR, 'patch').message}`);
  // ---- B8（段階 C）: handler の本文の範囲（handlerBodiesOf）は削除した（使う処理が無くなった）。簡素化 B（2026-10-16）で記法の写し（KTModernJs）ごと削除した
  assert(typeof T.KTModernJs === 'undefined', 'B8: handlerBodiesOf は段階 C、parseAst は C-1 第 2 段で削除し、簡素化 B で KTModernJs ごと削除した（本体に呼び出し元が無い。KTJsSim も削除）');
  // ---- B6 / B7: api に getPreviewStatus / getPreviewFields が無ければ依存の成立を確かめられない → DEPENDENCY_CHECK_FAILED（登録しない）
  const base6 = { getPreviewCustomize: async () => ({ scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] }, revision: '1' }), putPreviewCustomize: async () => ({}), uploadFile: async () => ({ fileKey: 'k' }) };
  const change6 = (dependsOn) => ({ changeId: 'c1', kind: 'ADD_FILE', name: 'x.js', target: 'desktop', content: 'x', contentHash: KTScan.hashText('x'), bytes: 1, dependsOn, registration: { verdict: 'RUNTIME_UNVERIFIED', blockers: [], confirmations: [], unverified: [], codeHash: KTScan.hashText('x') } });
  const p6 = await KTJsExecutor.prepare({ appId: '1', changes: [change6({ statuses: [{ name: '部長承認待ち', title: 'ステータス「部長承認待ち」を追加' }], fields: [] })] }, { api: base6 });
  assert(p6.status === 'BLOCKED' && p6.blockers.length === 1 && p6.blockers[0].code === 'DEPENDENCY_CHECK_FAILED' && /依存の成立を確かめられませんでした/.test(p6.blockers[0].message), `B6: getPreviewStatus が無い api ＋ ステータスの依存 → DEPENDENCY_CHECK_FAILED: ${JSON.stringify(p6.blockers)}`);
  const p7 = await KTJsExecutor.prepare({ appId: '1', changes: [change6({ statuses: [], fields: [{ code: 'approver_mgr', label: '部長承認者' }] })] }, { api: { ...base6, getPreviewStatus: async () => ({ states: {} }) } });
  assert(p7.status === 'BLOCKED' && p7.blockers.length === 1 && p7.blockers[0].code === 'DEPENDENCY_CHECK_FAILED' && /依存の成立を確かめられませんでした/.test(p7.blockers[0].message), `B7: getPreviewFields が無い api ＋ フィールドの依存 → DEPENDENCY_CHECK_FAILED: ${JSON.stringify(p7.blockers)}`);
  // ---- A5: 依存が未反映の change は依存の文だけ（再検査の「存在しないフィールド」を重ねない・再検査は呼ばない）
  const dataEnv = clone(DATA); dataEnv.customize = { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] }, revision: '12' };
  const m5 = makeKintoneMock(dataEnv, { jsSources: [] });
  const rv14 = KTCodeReview.review({ generated: GEN_R14, customization: CUST_R14, plan: PLAN_R14, data: DATA, scan: null, existingSource: null });
  const ch14 = KTJsExecutor.changeFromGenerated({ customization: CUST_R14, generated: GEN_R14, review: rv14, existingNames: [] });
  let rechecked = 0;
  const pA5 = await KTJsExecutor.prepare({ appId: '310', changes: [ch14.change], recheck: () => { rechecked++; return KTCodeReview.review({ generated: GEN_R14, customization: CUST_R14, plan: PLAN_R14, data: DATA, scan: null, existingSource: null, existingOnly: true }).registration; } }, { api: m5.api });
  assert(pA5.status === 'BLOCKED' && pA5.blockers.length === 1 && pA5.blockers[0].code === 'DEPENDENCY_NOT_APPLIED' && !/approver_mgr/.test(JSON.stringify(pA5.blockers)) && pA5.changes[0].reason === 'DEPENDENCY_NOT_APPLIED' && /先に手順「ステータス「部長承認待ち」を追加」/.test(pA5.changes[0].message) && rechecked === 0, `A5: 依存未反映 → DEPENDENCY_NOT_APPLIED だけ（再検査の blocker を重ねない・再検査を呼ばない）: ${JSON.stringify(pA5.blockers.map(b => [b.code, b.message]))} rechecked=${rechecked}`);
  // ---- B-2: NOT_MET でも note が計画の手順・標準設定を名指ししていてその手順が計画にあれば担当範囲外。行の追加・削除を理由にした NOT_MET は確認（review）
  const planNotify = mkPlan([mkStep('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', null, { targets: ['a'] }, { title: '承認待ちの通知を追加' }), mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' })], { solution: 'HYBRID', customizations: [cust()] });
  const rvB2 = KTCodeReview.review({ generated: gen(okCode, { coverage: [{ requirement: '承認待ちになったら承認者に通知する', status: 'NOT_MET', note: 'P1 の通知設定で対応するため JavaScript では実装しない' }] }), customization: cust(), plan: planNotify, data: DATA, scan: null, existingSource: null });
  // 段階 C: note の名指し（P1）では担当にしない。requirementId が無い旧い形は自分の要件（登録不可）。表示の文の番号は手順の名前に置き換える
  assert(rvB2.registration.verdict === 'BLOCKED' && check(rvB2, 'coverage-unmet') && rvB2.coverage.outOfScope.length === 0 && rvB2.coverage.notAchieved.some(x => x.code === 'AI_NOT_MET' && x.message === '承認待ちになったら承認者に通知する（手順「承認待ちの通知を追加」の通知設定で対応するため JavaScript では実装しない）'), `B-2（段階 C）: note に計画の手順（P1）があっても担当範囲外にしない（内部の番号は手順の名前に）: ${rvB2.registration.verdict} ${JSON.stringify(rvB2.coverage.notAchieved)}`);
  const rvNoPlan = review(okCode, cust(), { coverage: [{ requirement: '承認待ちは通知する', status: 'NOT_MET', note: 'P1 の通知設定で対応' }] });
  assert(rvNoPlan.registration.verdict === 'BLOCKED' && check(rvNoPlan, 'coverage-unmet').severity === 'block', 'B-2: 計画が無ければ note の P1 は担当にならない（登録不可のまま）');
  const rvRows = review(okCode, cust(), { coverage: [{ requirement: '明細の行の追加・削除を禁止する', status: 'NOT_MET', note: 'kintone の JavaScript では行の追加・削除は止められない' }] });
  // 段階 C（反証 D・C3）: 文の照合（ROW_OPS_RE）で NOT_MET を PARTIAL に下げる処理は削除した（AI の申告どおり。行の追加・削除は Toolkit の SUBTABLE_ROWS で別に示す）
  assert(rvRows.registration.verdict === 'BLOCKED' && check(rvRows, 'coverage-unmet').severity === 'block' && rvRows.coverage.notAchieved.some(x => x.code === 'AI_NOT_MET') && !rvRows.coverage.notAchieved.some(x => x.code === 'AI_PARTIAL'), `B-2（段階 C）: 行の追加・削除を理由にした NOT_MET も文では読み替えない（登録不可のまま）: ${rvRows.registration.verdict}`);
  // ---- B1 / B2: plannedHint は requirement の文だけで照合。短いラベル（2 文字）・引用符の無いステータス名は照合しない
  const planMemo = mkPlan([mkStep('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'SINGLE_LINE_TEXT' }, { title: 'フィールド「備考」を追加' })], { proposedFields: [{ temporaryId: 'NEW_FIELD_1', label: '備考', suggestedCode: 'memo', type: 'SINGLE_LINE_TEXT', required: false, reason: '', evidenceIds: [] }] });
  const rvHint = KTCodeReview.review({ generated: gen(okCode, { coverage: [{ requirement: '承認済みでも警告を出す', status: 'NOT_MET', note: '備考: 実装していない' }] }), customization: cust(), plan: planMemo, data: DATA, scan: null, existingSource: null });
  assert(!rvHint.coverage.plannedHint, `B1 / B2: note の「備考:」と 2 文字のラベル「備考」では plannedHint を出さない: ${JSON.stringify(rvHint.coverage.plannedHint)}`);
  const rvHint2 = KTCodeReview.review({ generated: { ...GEN_R14, coverage: [{ requirement: '部長承認待ちでは金額を編集不可にする', status: 'NOT_MET', note: '「部長承認待ち」は存在しない' }] }, customization: CUST_R14, plan: PLAN_R14, data: DATA, scan: null, existingSource: null });
  assert(!rvHint2.coverage.plannedHint, 'B1 / B2: requirement に引用符つきのステータス名が無ければ（note にあっても）plannedHint を出さない');
  // ---- B-4 / B5 / B-1: plannedOf
  const applied = clone(DATA);
  applied.fields.approver_mgr = { type: 'USER_SELECT', code: 'approver_mgr', label: '部長承認者', noLabel: false, required: false, entities: [], defaultValue: [] };
  applied.status.states['部長承認待ち'] = { name: '部長承認待ち', index: '3', assignee: { type: 'ONE', entities: [] } };
  const pl = KTContext.plannedOf(PLAN_R14, applied);
  assert(pl.statuses.length === 0 && pl.fields.length === 0, `B-4: 現在の設定に既にある名前は planned から除く: ${JSON.stringify(pl)}`);
  const plOdd = KTContext.plannedOf(mkPlan([mkStep('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', 'ステータス', {}, { title: 'ステータスを追加' })]), DATA);
  assert(plOdd.statuses.length === 0, `B5: spec.name の無い ADD_PROCESS_STATUS は planned に入れない（targetRef を名前にしない）: ${JSON.stringify(plOdd)}`);
  const plNull = KTContext.plannedOf(mkPlan([], { proposedFields: [{ temporaryId: 'NEW_FIELD_1', label: '承認者', suggestedCode: 'approver', type: 'USER_SELECT', required: false, reason: '', evidenceIds: [] }] }), DATA);
  assert(plNull.fields.length === 1 && plNull.fields[0].stepId === null, 'B-1: ADD_FIELD の手順が無い proposedField は stepId: null で渡す');
  const ctxApplied = KTContext.buildGenerator({ customization: CUST_R14, plan: PLAN_R14, planId: 'p1', version: 1, data: applied });
  assert(ctxApplied.planned.statuses.length === 0 && ctxApplied.planned.fields.length === 0 && ctxApplied.dictionary.statuses.includes('部長承認待ち'), 'B-4: 反映後の buildGenerator は planned が空・dictionary.statuses には現在の設定として入る');
  // ---- A3: 前提（assumptions）の手順番号は手順の名前に置き換える（コードペインの「前提: …」）
  const genA3 = { ...GEN_R14, assumptions: ['手順 P1 の反映が前提', 'P2 で追加するフィールドを使う', 'C1 の要件どおり'] };
  const rvA3 = KTCodeReview.review({ generated: genA3, customization: CUST_R14, plan: PLAN_R14, data: DATA, scan: null, existingSource: null });
  assert(JSON.stringify(rvA3.assumptions) === JSON.stringify(['手順「ステータス「部長承認待ち」を追加」の反映が前提', '手順「フィールド「部長承認者」を追加」で追加するフィールドを使う', 'この JavaScript の要件どおり']), `A3: review.assumptions は番号を手順の名前に置き換えた表示用: ${JSON.stringify(rvA3.assumptions)}`);
  const paneA3 = KTAiChatUi.codePaneHtml({ generated: genA3, review: rvA3, existingSource: null });
  assert(/前提: 手順「ステータス「部長承認待ち」を追加」の反映が前提／手順「フィールド「部長承認者」を追加」で追加するフィールドを使う／この JavaScript の要件どおり/.test(paneA3.review) && !/\bP[12]\b/.test(paneA3.review), `A3: コードペインの「前提:」に P1 / P2 を出さない: ${/前提: [^<]*/.exec(paneA3.review)?.[0]}`);
});

// =========================================================
console.log('\n--- T-A10（修正後レビューの指摘）自分の要件の NOT_MET・担当の範囲・repeatOf の案内・検査名の日本語・検査が完了しなかった回・plannedHint・displayNote・generate-repeat の描画・括弧の否定 ---');
await section(async () => {
  const { repeatOf, nextAttempts } = KTAiConversation;
  const okCode = handler(EDIT, "    if (record['ステータス'].value === '承認待ち') {\n      record['amount'].disabled = true;\n    }");
  const custStep = mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' });
  const covReview = (plan, requirement, note, c = cust()) => KTCodeReview.review({ generated: gen(okCode, { coverage: [{ requirement, status: 'NOT_MET', note }] }), customization: c, plan, data: DATA, scan: null, existingSource: null });
  const unmetBlock = (rv) => rv.registration.verdict === 'BLOCKED' && check(rv, 'coverage-unmet') && check(rv, 'coverage-unmet').severity === 'block' && rv.coverage.outOfScope.length === 0 && rv.coverage.notAchieved.some(x => x.code === 'AI_NOT_MET');
  // ---- 1（段階 C）: 担当は requirementId で引く（契約 20 §5）。note の文言（P1 の名指し・「標準設定」「プロセス管理」）からの推定は削除した
  const planRC = mkPlan([mkStep('P1', 'REQUIRE_CONFIRMATION', 'PROCESS_STATUS', '承認待ち', {}, { title: '承認者を特定' }), custStep], { customizations: [cust()] });
  const planNotify = mkPlan([mkStep('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', null, { targets: ['a'] }, { title: '承認待ちの通知を追加' }), custStep], { customizations: [cust()] });
  const planProcess = mkPlan([mkStep('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認待ち', { name: '部長承認待ち' }, { title: 'ステータス「部長承認待ち」を追加' }), custStep], { customizations: [cust()] });
  const covId = (plan, items, extra = {}) => KTCodeReview.review({ generated: gen(okCode, { coverage: items }), customization: cust(), plan, data: DATA, scan: null, existingSource: null, ...extra });
  // 自分の id（C1）の NOT_MET は、note に手順や標準設定が書かれていても登録不可のまま
  const mineRC = covId(planRC, [{ requirementId: 'C1', text: '承認待ちでは金額を編集不可にする', status: 'NOT_MET', note: 'P1 の確認を待つため実装していない' }]);
  assert(unmetBlock(mineRC) && /手順「承認者を特定」の確認を待つ/.test(mineRC.coverage.notAchieved[0].message), `1: 自分の id の NOT_MET → 登録不可（note の番号は手順の名前に置き換えて表示）: ${mineRC.registration.verdict} ${JSON.stringify(mineRC.coverage.notAchieved)}`);
  assert(unmetBlock(covId(planProcess, [{ requirementId: 'C1', text: '承認待ちでは金額を編集不可にする', status: 'NOT_MET', note: 'プロセス管理で対応' }])), '1: 自分の id の NOT_MET に「プロセス管理で対応」→ 読み替えない（文言は見ない）');
  // 旧い Gateway（requirementId 無し）: 入口でこの customization の id に変換 → 自分の要件として扱う（担当の推定はしない）
  const legacy = covId(planNotify, [{ requirement: '承認待ちになったら承認者に通知する', status: 'NOT_MET', note: 'P1 で対応' }]);
  assert(unmetBlock(legacy) && legacy.coverage.declared[0].requirementId === 'C1' && legacy.coverage.declared[0].legacy === true, `1: requirementId の無い旧い形は自分の id に変換（登録不可）: ${JSON.stringify(legacy.coverage.declared)}`);
  // 別の担当の id: 設定を変える手順（P1 ADD_NOTIFICATION）→ 担当範囲外。確認待ちの手順（REQUIRE_CONFIRMATION）や計画に無い id（C9）→ unowned（計画全体の確認に残す。登録不可にはしない）
  const otherReq = '承認待ちになったら承認者に通知する';
  const unownedReview = (rv, req) => rv.registration.verdict !== 'BLOCKED' && rv.coverage.outOfScope.some(x => x.code === 'AI_OUT_OF_SCOPE' && x.requirement === req) && rv.coverage.unowned.some(x => x.requirement === req) && (rv.checks || []).some(x => x.name === 'coverage-owner' && !x.ok && x.severity === 'review' && x.message.includes(req)) && !rv.coverage.notAchieved.some(x => x.code === 'AI_NOT_MET');
  const byStep = covId(planNotify, [{ requirementId: 'P1', text: otherReq, status: 'NOT_MET', note: '通知の設定で対応' }]);
  assert(byStep.registration.verdict !== 'BLOCKED' && byStep.coverage.outOfScope.some(x => x.code === 'OTHER_OWNER' && x.owner === 'step' && /手順「承認待ちの通知を追加」の担当/.test(x.message)) && !byStep.coverage.unowned.length && !byStep.coverage.notAchieved.length, `1: 設定を変える手順の id（P1 ADD_NOTIFICATION）→ 担当範囲外（手順の名前で表示）: ${JSON.stringify(byStep.coverage.outOfScope)}`);
  const byRC = covId(planRC, [{ requirementId: 'P1', text: otherReq, status: 'OUT_OF_SCOPE', note: '確認の後に決める' }]);
  assert(unownedReview(byRC, otherReq), `1: 確認待ちの手順の id（REQUIRE_CONFIRMATION）は担当にしない → unowned・確認: ${byRC.registration.verdict} ${JSON.stringify(byRC.coverage.unowned)}`);
  const byUnknown = covId(planNotify, [{ requirementId: 'C9', text: otherReq, status: 'OUT_OF_SCOPE', note: '' }]);
  assert(unownedReview(byUnknown, otherReq), `1: 計画に無い id（C9）→ unowned・確認: ${JSON.stringify(byUnknown.coverage.unowned)}`);
  const planTwo = mkPlan([custStep, mkStep('C2', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C2' })], { customizations: [cust(), cust({ customizationId: 'C2', requirement: 'モバイルでも同じ制御' })] });
  const byCust = covId(planTwo, [{ requirementId: 'C2', text: 'モバイルでも同じ制御', status: 'OUT_OF_SCOPE', note: '' }]);
  assert(byCust.registration.verdict !== 'BLOCKED' && byCust.coverage.outOfScope.some(x => x.code === 'OTHER_OWNER' && x.customizationId === 'C2' && /別の JavaScript「モバイルでも同じ制御」の担当/.test(x.message)) && !byCust.coverage.unowned.length, `1: 別の JavaScript の id（C2）→ 担当範囲外（要件の文で表示）: ${JSON.stringify(byCust.coverage.outOfScope)}`);
  // 要件の id（R…）は要件の台帳の planRefs で担当を引く: C1 を指す → 自分の要件（NOT_MET は登録不可）。P1 を指す → 手順の担当。無ければ unowned
  const reqs = [{ id: 'R1', planRefs: ['C1'] }, { id: 'R2', planRefs: ['P1'] }, { id: 'R3', planRefs: [] }];
  const r1 = covId(planNotify, [{ requirementId: 'R1', text: '承認待ちでは金額を編集不可にする', status: 'NOT_MET', note: '' }], { requirements: reqs });
  const r2 = covId(planNotify, [{ requirementId: 'R2', text: otherReq, status: 'NOT_MET', note: '' }], { requirements: reqs });
  const r3 = covId(planNotify, [{ requirementId: 'R3', text: otherReq, status: 'OUT_OF_SCOPE', note: '' }], { requirements: reqs });
  assert(unmetBlock(r1) && r2.registration.verdict !== 'BLOCKED' && r2.coverage.outOfScope.some(x => x.owner === 'step') && unownedReview(r3, otherReq), `1: R… は planRefs で担当を引く（C1 → 自分・P1 → 手順・無し → unowned）: ${[r1.registration.verdict, r2.registration.verdict, r3.registration.verdict].join('/')}`);
  assert(covId(null, [{ requirementId: 'P1', text: otherReq, status: 'OUT_OF_SCOPE', note: '' }]).coverage.unowned.length === 1 && covId(null, [{ requirement: otherReq, status: 'NOT_MET', note: 'P1 で対応' }]).registration.verdict === 'BLOCKED', '1: 計画が無ければ P1 も担当にならない（unowned）。旧い形の NOT_MET は登録不可のまま');
  // ---- 1b（2026-10-15 レビューの反映 T1 / T8）: Gateway は手順（P…）の OUT_OF_SCOPE を補わない（coverage はこの JavaScript の担当 MET / PARTIAL だけ）。
  //   計画に確認待ちの手順（REQUIRE_CONFIRMATION）があっても、review の status・registration の verdict・確認事項（confirmations）・検査（checks）は、その手順が無い計画と同じ
  //   （担当は計画から引くので coverage に書かれていなくてよい）。AI が自分で書いた手順の OUT_OF_SCOPE（古い形）は、設定を変える手順なら担当範囲外として通り（表示なし・判定は同じ）、
  //   確認待ちの手順なら上の 1 のとおり unowned（確認）に残る
  const planCustOnly = mkPlan([custStep], { customizations: [cust()] });
  const shapeOf = (rv) => JSON.stringify({ status: rv.status, verdict: rv.registration.verdict, blockers: rv.registration.blockers, confirmations: rv.registration.confirmations.map(x => [x.code, x.message]), checks: (rv.checks || []).map(x => [x.name, x.ok, x.severity]), unowned: rv.coverage.unowned, notAchieved: rv.coverage.notAchieved.map(x => [x.code, x.requirementId || null]) });
  const metOnly = [{ requirementId: 'C1', text: '承認待ちでは金額を編集不可にする', status: 'MET', note: '' }];
  const partialOnly = [{ requirementId: 'C1', text: '承認待ちでは金額を編集不可にする', status: 'PARTIAL', note: '一覧の編集画面では止められません' }];
  const rcMet = covId(planRC, metOnly), baseMet = covId(planCustOnly, metOnly);
  assert(shapeOf(rcMet) === shapeOf(baseMet) && rcMet.registration.verdict !== 'BLOCKED' && rcMet.coverage.outOfScope.length === 0 && rcMet.coverage.unowned.length === 0 && !check(rcMet, 'coverage-owner'), `1b（T1）: 確認待ちの手順がある計画で coverage が担当の MET だけ → 手順の無い計画と同じ status / verdict / 確認事項（担当範囲外・unowned・coverage-owner は無い）: ${shapeOf(rcMet)}`);
  const rcPartial = covId(planRC, partialOnly), basePartial = covId(planCustOnly, partialOnly);
  assert(shapeOf(rcPartial) === shapeOf(basePartial) && rcPartial.registration.verdict === 'NEEDS_CONFIRMATION' && rcPartial.registration.confirmations.some(x => x.code === 'coverage-unmet') && !check(rcPartial, 'coverage-owner'), `1b（T1）: 担当の PARTIAL だけでも同じ（確認は PARTIAL の 1 件。手順の OUT_OF_SCOPE による確認は増えない）: ${shapeOf(rcPartial)}`);
  const withStep = covId(planNotify, [...metOnly, { requirementId: 'P1', text: otherReq, status: 'OUT_OF_SCOPE', note: '標準設定の手順' }]), without = covId(planNotify, metOnly);
  assert(shapeOf(withStep) === shapeOf(without) && withStep.coverage.outOfScope.length === 1 && withStep.coverage.outOfScope[0].code === 'OTHER_OWNER' && without.coverage.outOfScope.length === 0, `1b（T8）: 設定を変える手順の OUT_OF_SCOPE（AI が書いた古い形）があっても無くても、status / verdict / 確認事項は同じ（担当範囲外は表示に出さない）: ${shapeOf(withStep)}`);
  // ---- 2: repeatOf の案内文（判定は inputHash だけ。新設の手順を反映すると入力が変わる）
  const repA = repeatOf({ attempts: nextAttempts(null, { inputHash: 'h', blockers: ['conditional-control'] }) }, 'h');
  assert(repA.repeat && repA.hints.includes('計画で新設するステータス・フィールドを動作テスト環境に反映すると、生成の入力が変わり作り直せます。入力が同じまま作り直しても同じ結果になります') && !repA.hints.some(h => /指摘の内容が変わったとき|設定の手順を反映しても/.test(h)), `2: 案内文の差し替え: ${JSON.stringify(repA.hints)}`);
  // ---- 3: 検査名は日本語（会話の案内・コードペインの検査一覧の両方）
  const latin = Object.entries(KTAiChatUi.CHECK_JA).filter(([, v]) => /^[A-Za-z /（）()]+$/.test(v));
  assert(latin.length === 0, `3: CHECK_JA に英語のままの値を残さない: ${JSON.stringify(latin)}`);
  assert(KTAiChatUi.CHECK_JA.syntax === '構文' && KTAiChatUi.CHECK_JA.patch === '既存ファイルへの統合' && KTAiChatUi.CHECK_JA.security === '安全性' && KTAiChatUi.CHECK_JA.handler === 'handler の形' && KTAiChatUi.CHECK_JA.apis === '使う API' && KTAiChatUi.CHECK_JA['return-event'] === 'return event の有無' && KTAiChatUi.CHECK_JA.async === 'async の使い方' && KTAiChatUi.CHECK_JA['modern-js'] === '新しい記法', `3: 対応表: ${JSON.stringify(KTAiChatUi.CHECK_JA)}`);
  const repSyntax = repeatOf({ attempts: nextAttempts(null, { inputHash: 'h', blockers: ['syntax', 'security', 'modern-js'] }) }, 'h');
  assert(repSyntax.hints.includes('「構文」の指摘の内容を直してください') && repSyntax.hints.includes('「安全性」の指摘の内容を直してください') && !/Syntax|Security/.test(repSyntax.message), `3: 会話の案内に英語の検査名が出ない: ${repSyntax.message}`);
  const paneJa = KTAiChatUi.codePaneHtml({ generated: gen(okCode), review: { status: 'BLOCKED', checks: [{ name: 'syntax', ok: false, severity: 'block', message: '構文エラー' }, { name: 'patch', ok: true, severity: 'info', message: '適用' }], registration: { verdict: 'BLOCKED', blockers: [], confirmations: [], unverified: [] } }, existingSource: null });
  assert(/構文: 構文エラー/.test(paneJa.review) && /既存ファイルへの統合: 適用/.test(paneJa.review) && !/Syntax|Patch/.test(paneJa.review), `3: コードペインの検査一覧も同じ対応表: ${paneJa.review.replace(/<[^>]*>/g, ' ').slice(0, 160)}`);
  // ---- 4: 検査が例外で完了しなかった回（reviewFailed）の後の同じ入力 → 「検査は通っています」と言わない
  const aFailed = nextAttempts(null, { inputHash: 'h', blockers: [], reviewFailed: true });
  assert(aFailed.history[0].reviewFailed === true && !('reviewFailed' in nextAttempts(null, { inputHash: 'h', blockers: [] }).history[0]), '4: 履歴に reviewFailed を残す（完了した回には付けない）');
  const repFailed = repeatOf({ attempts: aFailed }, 'h');
  assert(repFailed.repeat && repFailed.reviewFailed === true && repFailed.hints.some(h => /前回は Toolkit の検査を完了できなかった/.test(h)) && !repFailed.hints.some(h => /検査は通っています/.test(h)), `4: 検査が完了しなかった回の案内: ${JSON.stringify(repFailed.hints)}`);
  const repFailedLegacy = repeatOf({ inputHash: 'h', blockers: [], reviewFailed: true }, 'h');
  assert(repFailedLegacy.repeat && repFailedLegacy.reviewFailed === true && !repFailedLegacy.hints.some(h => /検査は通っています/.test(h)), '4: 履歴の無い古い記録（inputHash / blockers / reviewFailed）でも同じ');
  assert(repeatOf({ attempts: nextAttempts(null, { inputHash: 'h', blockers: [] }) }, 'h').reviewFailed === false, '4: 完了した回は reviewFailed: false');
  // ---- 5（段階 C）: plannedHint（新設の名前を requirement の文から照合する案内）は削除した
  const planTax = mkPlan([mkStep('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'NUMBER' }, { title: 'フィールド「消費税額」を追加' })], { proposedFields: [{ temporaryId: 'NEW_FIELD_1', label: '消費税額', suggestedCode: 'no', type: 'NUMBER', required: false, reason: '', evidenceIds: [] }] });
  const noHint = covReview(planTax, '消費税額を確認する', '実装していない');
  assert(!('plannedHint' in noHint.coverage) && noHint.registration.verdict === 'BLOCKED' && !(noHint.checks || []).some(x => /前提にした作り直し/.test(x.message)), '5: plannedHint は出ない（新設の名前を含む未達も自分の id の NOT_MET として登録不可）');
  // ---- 6: 計画が無いときの displayNote（「計画の別の手順 の反映が前提」の半角空白を落とす）
  const rvNoPlan = review(okCode, cust(), { assumptions: ['手順 P1 の反映が前提', 'C2 と同じ条件'] });
  assert(JSON.stringify(rvNoPlan.assumptions) === JSON.stringify(['計画の別の手順の反映が前提', '計画の別の手順と同じ条件']), `6: 置き換えの後ろの空白を落とす: ${JSON.stringify(rvNoPlan.assumptions)}`);
  const rvSelf = review(okCode, cust(), { assumptions: ['C1 と同じ条件'] });
  assert(rvSelf.assumptions[0] === 'この JavaScript と同じ条件', `6: 英字で終わる置き換え（この JavaScript）は空白を残す: ${rvSelf.assumptions[0]}`);
  // ---- 7: 同じ入力での作り直しの案内。検査が完了しなかった回の後は「検査は通っています」と言わない
  //   C-1 第 3 段（2026-10-08）: 会話の generate-repeat のカード（見出し 1 行 ＋ hints の箇条書き）は従来の生成と一緒に削除した（ai-flow-redesign F2-3）。
  //   新しい流れ（仮案 → 採用 → 最終案 → 「コードを作って」で最終案の作り直し）の上で、同じ入力の案内が最終案のカードの「実現できない点」に出ることと、
  //   その中身（検査が完了しなかった回の後は「検査は通っています」と言わない）を確かめる
  const convWith = async (firstReview) => {
    // 実物の services.generate と同じ順: 前の記録と照合 → 同じ入力なら AI を呼ばず REPEAT_SAME_INPUT（reviewFailed も返す）
    const genR = { calls: [], impl: async ({ previous }) => { const rp = repeatOf(previous, 'h1'); if (rp.repeat) return { ok: false, reason: 'REPEAT_SAME_INPUT', message: rp.message, hints: rp.hints, blockers: rp.blockers, reviewFailed: !!rp.reviewFailed, attempts: previous.attempts, inputHash: 'h1' }; return { ok: true, generated: { code: "(function () { 'use strict'; })();", strategy: 'NEW_JS_FILE', targetFile: 'a.js', summary: 's' }, review: clone(firstReview), ctx: { size: { approxTokens: 1200 } }, inputHash: 'h1' }; } };
    const x = K.makeConvC({ generate: genR });
    await K.adoptC(x); await ticks();
    const v = x.c.activePlan();
    await x.c.send('コードを作って'); await ticks();
    const v2 = x.c.activePlan(), e2 = v2.generated.C1;
    const cannot = (v2.final && v2.final.cannot ? v2.final.cannot : []).map(c => c.text).join('\n');
    return { x, v, v2, e2, cannot, card: K.stripC(K.finalHtml(x)) };
  };
  const okReview = { status: 'OK', checks: [{ name: 'syntax', ok: true, severity: 'info', message: 'ok' }], registration: { verdict: 'RUNTIME_UNVERIFIED', blockers: [], confirmations: [], unverified: [] }, coverage: { achieved: [], notAchieved: [], outOfScope: [], unowned: [] } };
  const normal = await convWith(okReview);
  assert(normal.e2 && normal.e2.failure && normal.e2.failure.reason === 'REPEAT_SAME_INPUT' && /同じ入力・同じ指摘です/.test(normal.cannot) && /検査は通っています。/.test(normal.cannot) && /確認できないこと／反映を止めている理由/.test(normal.card) && /同じ入力・同じ指摘です/.test(normal.card) && !normal.x.c.messages().some(m => m.type === 'ERROR' || m.data?.kind === 'generate-repeat'), `7: 同じ入力の案内は最終案のカードの「実現できない点」に出る（エラーカード・generate-repeat のカードは出さない）: ${normal.cannot.slice(0, 160)}`);
  // 検査が例外で完了しなかった回（services.generate の代替 review: reviewFailed: true・registration 無し）
  const failedReview = { status: 'REVIEW_REQUIRED', reviewFailed: true, checks: [{ name: 'code', ok: false, severity: 'review', message: 'Toolkit の検査を完了できませんでした: x' }], finalCode: '', addedCode: '', diff: null, mismatches: [], security: [] };
  const failed = await convWith(failedReview);
  assert(failed.v.generated.C1.attempts.history[0].reviewFailed === true, '4: 会話（最終案のパイプライン）は代替 review の reviewFailed を版の生成の履歴に残す');
  assert(/前回は Toolkit の検査を完了できなかった/.test(failed.cannot) && !/検査は通っています/.test(failed.cannot) && !/検査は通っています/.test(failed.card), `4 / 7: 検査が完了しなかった回の後は「検査は通っています」と言わない: ${failed.cannot.slice(0, 200)}`);
  // ---- 8: 括弧で囲んだ否定（not (ステータス in ("承認済み"))）を列挙で書いても形式確認は止めない（値の照合 conditional-control は C-1 第 2 段で削除）。
  //   肯定の in の値の照合（旧 notParenAnd）は生成工程の代表条件で守る: worker/test/cases/required-effects.mjs「A1 in の値ごと（本物の隔離環境）…」・「A4 F4（本物の隔離環境）: not in は…」
  const notParen = review(handler(EDIT, "    const st = record['ステータス'].value;\n    if (st === '作成中' || st === '承認待ち') {\n      record['amount'].disabled = true;\n    }"), cust({ fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'not (ステータス in ("承認済み"))' }] }));
  assert(notParen.registration.verdict !== 'BLOCKED', `8: 括弧で囲んだ否定の値（承認済み）があっても BLOCKED にしない: ${notParen.registration.verdict}`);
});

// =========================================================
console.log('\n--- T-A11（再確認の指摘）言い換えた自分の要件・否定の言い回し・検査名の対応表・置き換え後の空白 ---');
await section(async () => {
  const okCode = handler(EDIT, "    if (record['ステータス'].value === '承認待ち') {\n      record['amount'].disabled = true;\n    }");
  const custStep = mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' });
  const planNotify = mkPlan([mkStep('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', null, { targets: ['a'] }, { title: '承認待ちの通知を追加' }), custStep], { customizations: [cust()] });
  const covReview = (plan, requirement, note, extra = {}) => KTCodeReview.review({ generated: gen(okCode, { coverage: [{ requirement, status: 'NOT_MET', note }], ...extra }), customization: cust(), plan, data: DATA, scan: null, existingSource: null });
  // 1: 自分の要件を言い換えた NOT_MET（Dice 係数が低い）でも、この JavaScript が制御するフィールド（amount）に触れていれば自分の要件 → 登録不可のまま
  const para = covReview(planNotify, 'amount の入力を止める', 'P1 で対応');
  assert(para.registration.verdict === 'BLOCKED' && para.coverage.outOfScope.length === 0 && para.coverage.notAchieved.some(x => x.code === 'AI_NOT_MET'), `1（段階 C）: requirementId の無い NOT_MET は文を見ずに自分の要件（登録不可）: ${para.registration.verdict} ${JSON.stringify(para.coverage.outOfScope)}`);
  // 2（段階 C）: note の文言（否定・肯定の名指し）は担当の判定に使わない。requirementId が無ければどちらも自分の要件として登録不可
  const neg = covReview(planNotify, '承認待ちになったら承認者に通知する', '標準機能では実現できないため未対応');
  assert(neg.registration.verdict === 'BLOCKED' && neg.coverage.outOfScope.length === 0 && neg.coverage.unowned.length === 0, `2: 否定の言い回しでも登録不可のまま: ${neg.registration.verdict}`);
  const pos = covReview(planNotify, '承認待ちになったら承認者に通知する', '標準機能の通知で対応する');
  assert(pos.registration.verdict === 'BLOCKED' && pos.coverage.outOfScope.length === 0, `2: 肯定の名指しも文言では担当にしない（担当は requirementId で）: ${pos.registration.verdict}`);
  // 3: Code Review が出す検査名が対応表にある（内部名のまま画面に出さない）
  const names = ['conditional-control', 'unconditional-control', 'target-fields', 'planned-fields', 'planned-events', 'space-element', 'api-screen', 'empty-undefined', 'error-clear-compare', 'nested-registration', 'create-missing-field', 'summary-scope', 'requirement-scope', 'refetch', 'error-cancels-other-js'];
  const missing = names.filter(n => !KTAiChatUi.CHECK_JA[n] || /^[A-Za-z /()（）-]+$/.test(KTAiChatUi.CHECK_JA[n]));
  assert(missing.length === 0, `3: 検査名の対応表に無い・英語のままの名前: ${JSON.stringify(missing)}`);
  // 4: 置き換え後に英数字が続くときは空白を残す
  const asm = covReview(planNotify, '承認待ちになったら承認者に通知する', '標準機能の通知で対応する', { assumptions: ['手順 P1 ADD_FIELD の後に有効', '手順 P1 の反映が前提'] });
  assert(Array.isArray(asm.assumptions) && asm.assumptions[0] === '手順「承認待ちの通知を追加」 ADD_FIELD の後に有効' && asm.assumptions[1] === '手順「承認待ちの通知を追加」の反映が前提', `4: 置き換え後の空白: ${JSON.stringify(asm.assumptions)}`);
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
