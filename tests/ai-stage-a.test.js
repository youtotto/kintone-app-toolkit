// 段階 A（会話フローの再設計 §2.6 / §3）: JS 生成・検証の修正（5.1〜5.6）と回帰ケース R12〜R15
//
// 検証内容:
//   T-A1（5.1）計画の新設分を生成に渡す: buildGenerator の planned（statuses / fields）・dictionary.statuses = 現在 ∪ 新設・allowedFields は fields[] と同じ集合・style の文
//   T-A2（5.2）新規フィールドの接続: 実装仕様の条件と標準設定の spec の NEW_FIELD_n を採番後のコードに置換。conditional-control は条件の値（ステータス名）まで照合
//   T-A3（5.3）R12 / R13: error-cancels-edit を経路（早い return の否定・同じ判別式と別の値・switch の別の case・if / else の別の枝）で判定し直す
//   T-A4（5.4）未実装を完成扱いしない: 範囲内の NOT_MET は coverage-unmet（block）・PARTIAL は review。見出しは「要件を満たしていない部分があります（登録できません）」
//   T-A5（5.5）var: patch を入れる handler の中の既存の var を安全な判定で const / let に更新。handler の外・安全でない宣言は変えない
//   T-A6（5.6）同じ入力・同じ指摘での再生成は AI を呼ばない。生成の回数と token / 費用の見積もり（「生成 N 回目」）
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
const { makeVmBackend } = require('./helpers/js-sim-vm.js');   // 段階 C: 競合・制御の判定は模擬イベント（Node では vm の別 context）
const T = loadToolkit();
const { KTDeps, KTScan, KTContext, KTCodeReview, KTModernJs, KTJsExecutor, KTAiConversation, KTAiWorkspaceViewModel, KTAiChatUi, KTPlanReview, KTJsSim } = T;
const vmBackend = makeVmBackend({ timeoutMs: 2000 });
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const R = require('./fixtures/p21-bfc-replay.js');
const SA = require('./fixtures/stage-a-edit-lock.js');
const SR = require('./fixtures/spec-retention-cases.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
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
console.log('\n--- T-A2（5.2）新規フィールドの接続: 条件・spec の NEW_FIELD_n の置換、conditional-control の値の照合 ---');
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
  // KTCodeReview: planCond も置換後の条件で引く（NEW_FIELD_1 の条件つき READ・amount の条件は approver_mgr を見ている）
  const rv = KTCodeReview.review({ generated: GEN_R14, customization: CUST_R14, plan: PLAN_R14, data: DATA, scan: null, existingSource: null });
  const cc = (rv.checks || []).filter(x => x.name === 'conditional-control');
  assert(rv.status !== 'BLOCKED' && cc.length === 1 && cc[0].ok && !/NEW_FIELD/.test(cc[0].message) && /部長承認待ち/.test(cc[0].message), `Review: 置換後の条件（approver_mgr）で照合し、計画の条件の中のロックとして通過: ${rv.status} ${JSON.stringify(cc.map(x => x.message))} ${JSON.stringify(codesOf(rv.registration.blockers))}`);
  // 条件の値（ステータス名）まで照合する: 同じ項目を別の値と比べていれば計画の条件ではない（別の条件 → 条件の外と同じ扱い）
  const wrong = review(handler(EDIT, "    if (record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }"));
  const cw = check(wrong, 'conditional-control');
  assert(wrong.registration.verdict === 'BLOCKED' && cw && cw.severity === 'block' && /計画の値「承認待ち」ではなく別の値/.test(cw.message), `値が違う（承認済み と 承認待ち）→ 計画の条件ではない（登録不可・理由に値を書く）: ${cw && cw.message}`);
  const right = review(handler(EDIT, "    if (record['ステータス'].value === '承認待ち') {\n      record['amount'].disabled = true;\n    }"));
  assert(right.registration.verdict === 'RUNTIME_UNVERIFIED' && check(right, 'conditional-control').ok, '値が同じ（承認待ち）→ 通過');
  const sw = review(handler(EDIT, "    switch (record['ステータス'].value) {\n      case '承認待ち':\n        record['amount'].disabled = true;\n        break;\n      default:\n        break;\n    }"));
  // 段階 C: switch の case のラベルの照合（段階 A）は外した。case の中の値は静的には読まず確認（review）に留め、条件どおりに動くかは模擬イベント（T-A3）で確かめる
  assert(check(sw, 'conditional-control') && check(sw, 'conditional-control').severity === 'review' && sw.registration.verdict !== 'BLOCKED', `switch の case の中 → 静的には値を読まない（確認）: ${check(sw, 'conditional-control').message}`);
  const swWrong = review(handler(EDIT, "    switch (record['ステータス'].value) {\n      case '承認済み':\n        record['amount'].disabled = true;\n        break;\n      default:\n        break;\n    }"));
  assert(swWrong.registration.verdict === 'NEEDS_CONFIRMATION', 'switch の別の case（承認済み）の中 → 静的には確認（値の違いは模擬イベントの不合格で分かる）');
  const viaVar = review(handler(EDIT, "    const PENDING = '承認待ち';\n    const st = record['ステータス'].value;\n    if (st === PENDING) {\n      record['amount'].disabled = true;\n    }"));
  assert(check(viaVar, 'conditional-control').ok, `値を変数に入れた書き方（st === PENDING）も定義をたどって通過: ${check(viaVar, 'conditional-control').message}`);
});

// =========================================================
console.log('\n--- T-A3（5.3 → 段階 C）R12 / R13: error と disabled の競合は静的な排他判定ではなく模擬イベント（KTJsSim）で決める ---');
//   段階 A の静的な排他判定（早い return の否定・同じ判別式と別の値・switch の別の case・if / else の別の枝）は段階 C で削除した（改訂 2: 任意の分岐の解析で採用可否を決めない）。
//   静的な検査（error-cancels-edit）は「同じイベントに記述がある」ことを確認（review）として残し、実際の競合は代表条件を実行した結果（sim-conflict）で登録不可にする
const simOf = (code, c = cust(), otherFiles = [], data = DATA) => KTJsSim.simulate({ customization: c, generated: gen(code), review: { finalCode: code }, existingSource: null, otherFiles, data, backend: vmBackend });
const mergedOf = async (code, c = cust(), otherFiles = [], data = DATA) => KTCodeReview.attachSim(review(code, c), await simOf(code, c, otherFiles, data), { customization: c });
await section(async () => {
  const ec = (rv) => check(rv, 'error-cancels-edit');
  // R12 の最小ケース: ステータス不明なら error ＋ return、承認待ちなら disabled
  const R12 = "    const st = record['ステータス'] ? record['ステータス'].value : '';\n    if (!st) {\n      record['amount'].error = 'ステータスが不明です';\n      return event;\n    }\n    if (st === '承認待ち') {\n      record['amount'].disabled = true;\n    }";
  const r12s = review(handler(EDIT, R12));
  // 確認 1: 模擬の結果が無い review（従来の流れ・模擬が動かない）では従来どおり登録不可。模擬が動いたら下の R12（模擬）のとおり模擬の結果で判定する
  assert(r12s.registration.verdict === 'BLOCKED' && ec(r12s) && ec(r12s).severity === 'block' && ec(r12s).simDecides === true && /生成工程の模擬テスト（代表条件）で確かめます/.test(ec(r12s).message) && codesOf(r12s.registration.blockers).includes('error-cancels-edit'), `R12（静的）: 模擬の結果が無い間は登録不可（静的な排他の解析では下げない）: ${ec(r12s) && ec(r12s).message}`);
  const r12 = await mergedOf(handler(EDIT, R12));
  assert(r12.registration.verdict !== 'BLOCKED' && !r12.checks.some(x => x.name === 'sim-conflict') && r12.checks.some(x => x.name === 'sim-control' && x.ok) && r12.sim.passed === true, `R12（模擬）: 代表条件（承認待ち・作成中・空）を実行しても error と disabled は同時に起きない → 競合なし: ${JSON.stringify(r12.sim.cases.map(x => [x.verdict, x.message.slice(0, 30)]))}`);
  assert(r12.registration.confirmations.some(x => x.code === 'error-cancels-edit' && /編集不可のまま・警告が出ない/.test(x.howToCheck)) && r12.registration.unverified.some(u => u.code === 'SIM_VERIFIED'), 'R12: 確認の項目は残し、登録の未確認は「模擬イベントで確認（実機は未確認）」');
  // (ii)(iii)(iv) 段階 A が静的に排他と判定していた書き方も、模擬で確かめる（競合なし）
  const bodies = [['同じ判別式と別の値', "    const st = record['ステータス'].value;\n    if (st === '作成中') {\n      record['amount'].error = '未申請です';\n    }\n    if (st === '承認待ち') {\n      record['amount'].disabled = true;\n    }"], ['switch の別の case', "    switch (record['ステータス'].value) {\n      case '承認待ち':\n        record['amount'].disabled = true;\n        break;\n      case '作成中':\n        record['amount'].error = '未申請です';\n        break;\n      default:\n        break;\n    }"], ['if / else の別の枝', "    const st = record['ステータス'].value;\n    if (st === '承認待ち') {\n      record['amount'].disabled = true;\n    } else if (st === '承認済み') {\n      record['amount'].disabled = true;\n    } else {\n      record['amount'].error = '申請前です';\n    }"]];
  for (const [name, body] of bodies) {
    const m = await mergedOf(handler(EDIT, body));
    assert(!m.checks.some(x => x.name === 'sim-conflict') && m.registration.verdict !== 'BLOCKED', `R12（${name}）: 模擬で競合なし → 停止しない: ${JSON.stringify(m.checks.filter(x => !x.ok).map(x => x.name))}`);
  }
  // siteConds は Phase 21 の形（早い return の否定）だけ残す。else if の手前の枝の否定・switch の case のラベル（段階 A）は付けない
  const ops = KTCodeReview.fieldOperations(clean(handler(EDIT, "    const st = record['ステータス'].value;\n    if (!st) {\n      record['amount'].error = 'x';\n      return event;\n    }\n    if (st === 'A') {\n      record['amount'].disabled = true;\n    } else if (st === 'B') {\n      record['amount'].disabled = false;\n    }\n    switch (st) {\n      case 'C':\n        record['amount'].disabled = true;\n        break;\n    }")));
  const condsOf = (op) => (op.conds || []).map(t => String(t).replace(/\s*\/\*[\s\S]*?\*\/\s*$/, ''));
  const dA = ops.find(o => o.op === 'disabled'), dB = ops.find(o => o.op === 'enabled'), dC = ops.filter(o => o.op === 'disabled').pop();
  assert(dA && condsOf(dA).includes('!(!st)') && dB && !condsOf(dB).some(t => /else of/.test(t)) && dC && condsOf(dC).some(t => t === 'switch (st)'), `siteConds: 早い return の否定は残し、else if の手前の枝の否定・switch の case のラベル（段階 A）は外した: ${JSON.stringify([condsOf(dA), condsOf(dB), condsOf(dC)])}`);
});

// =========================================================
console.log('\n--- T-A3（5.3 → 段階 C）R13: 実際の競合は模擬イベントで検出する ---');
await section(async () => {
  const ec = (rv) => check(rv, 'error-cancels-edit');
  const both = await mergedOf(handler(EDIT, "    record['amount'].disabled = true;\n    record['amount'].error = '確認してください';"));
  assert(both.registration.verdict === 'BLOCKED' && codesOf(both.registration.blockers).includes('sim-conflict') && !codesOf(both.registration.blockers).includes('error-cancels-edit') && ec(both).severity === 'review', `R13: 同じ経路で無条件に disabled と error → 模擬で競合（sim-conflict が登録不可。静的な error-cancels-edit は確認）: ${JSON.stringify(codesOf(both.registration.blockers))}`);
  const mixed = await mergedOf(handler(EDIT, "    const st = record['ステータス'] ? record['ステータス'].value : '';\n    if (!st) {\n      record['amount'].error = 'ステータスが不明です';\n      return event;\n    }\n    if (st === '承認待ち') {\n      record['amount'].disabled = true;\n    }\n    record['amount'].error = '金額を確認してください';"));
  assert(mixed.registration.verdict === 'BLOCKED' && codesOf(mixed.registration.blockers).includes('sim-conflict'), 'R13: 排他の組と排他でない組が混ざる → 承認待ちの代表条件で両方が立つ → 登録不可');
  const same = await mergedOf(handler(EDIT, "    const st = record['ステータス'].value;\n    if (st === '承認待ち') {\n      record['amount'].disabled = true;\n    }\n    if (st === '承認待ち' && Number(record['amount'].value) > 0) {\n      record['amount'].error = '金額を確認してください';\n    }"));
  assert(same.registration.verdict === 'BLOCKED' && codesOf(same.registration.blockers).includes('sim-conflict'), 'R13: 同じ値（承認待ち）で disabled と error → 代表条件で同時に起きるので登録不可');
  // 別ファイルの disabled と自コードの error → 静的には error-cancels-other-js（確認）。模擬で同じイベントに両方が立てば sim-conflict（登録不可）
  const data = clone(DATA);
  data.customize = { scope: 'ALL', desktop: { js: [{ type: 'FILE', file: { contentType: 'text/javascript', fileKey: 'pv:other', name: 'otherLock.js', size: '200' } }], css: [] }, mobile: { js: [], css: [] }, revision: '7' };
  const OTHER = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認待ち') {\n      record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();\n";
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const scan = KTScan.buildPayload({ appId: 353, files: [{ name: 'otherLock.js', target: 'desktop', kind: 'js', text: OTHER }], fields: fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType })), deps: KTDeps.buildDependencyData(data, fieldsN), scannedAt: '2026-10-07T00:00:00.000Z' });
  const warnCust = cust({ requirement: 'ステータスが無いときは警告する', fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL' }] });
  const other = KTCodeReview.review({ generated: gen(handler(EDIT, "    const st = record['ステータス'] ? record['ステータス'].value : '';\n    if (!st) {\n      record['amount'].error = 'ステータスが不明です';\n      return event;\n    }"), { targetFile: 'warn.js' }), customization: warnCust, plan: null, data, scan, existingSource: null });
  const oj = check(other, 'error-cancels-other-js');
  assert(oj && !oj.ok && oj.severity === 'review' && /otherLock\.js/.test(oj.message) && /app\.record\.edit\.show/.test(oj.message), `R13: 別ファイル（otherLock.js）の disabled と自コードの error → error-cancels-other-js（確認）: ${oj && oj.message}`);
  assert(ec(other) && ec(other).ok, '自分のファイルの中には disabled が無いので error-cancels-edit 自体は重なっていない');
  const otherSim = await simOf(handler(EDIT, "    record['amount'].error = '金額を確認してください';"), warnCust, [{ name: 'otherLock.js', target: 'desktop', text: OTHER, sourceAvailable: true, analyzed: true }], data);
  assert(otherSim.checks.some(x => x.name === 'sim-conflict' && x.severity === 'block') && otherSim.conflicts[0].candidateInvolved === true && /既存の otherLock\.js/.test(otherSim.checks.find(x => x.name === 'sim-conflict').message), `R13: 別ファイルの disabled と候補の無条件の error → 模擬で同じイベントに両方が立つ → 競合（登録不可）: ${otherSim.checks.find(x => x.name === 'sim-conflict').message}`);
  // 編集不可（disabled）を読む条件で分けている既存の書き方は引き続き有効（確認）
  const guarded = review(handler(EDIT, "    record['amount'].disabled = record['ステータス'].value === '承認済み';\n    if (!record['amount'].disabled && Number(record['amount'].value) > 1000000) {\n      record['amount'].error = '100万円を超えています';\n    } else {\n      record['amount'].error = null;\n    }"), cust({ fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL' }] }));
  assert(ec(guarded).severity === 'review' && /編集不可（disabled）を見る条件で分けられています/.test(ec(guarded).message), `既存の errorGuardedByDisabled（disabled を読む if の中）はそのまま有効: ${ec(guarded).message}`);
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
  // 表示: VM.codeSummary（見出し・登録できるか）・コードカード・コードペイン
  const entry = { generated: gen(okCode, { coverage: covNotMet }), review: rv, existingSource: null, attempts: { count: 2, measured: 2, tokens: { input: 3000, output: 400 }, costUsd: 0.01 } };
  const v = { planId: 'p', version: 1, goal: 'g', plan: mkPlan([], { customizations: [cust()] }), review: null, ctx: null, status: 'ACTIVE', generated: { C1: entry } };
  const cs = VM.codeSummary(entry, 'C1', v);
  assert(cs.unmet.length === 1 && cs.headline === 'JavaScript を作りましたが、要件を満たしていない部分があります（登録できません）。' && cs.verdictJa === '× 要件を満たしていない部分があります（登録できません）' && cs.blocked && cs.attemptCount === 2, `codeSummary: 見出しと登録の判定は「要件を満たしていない部分があります（登録できません）」・生成の回数: ${JSON.stringify({ headline: cs.headline, verdictJa: cs.verdictJa, attemptCount: cs.attemptCount })}`);
  const card = KTAiChatUi.messageHtml({ id: 'm1', type: 'CODE', role: 'toolkit', text: 'JavaScript', at: '', data: { planId: 'p', version: 1, customizationId: 'C1' } }, { plans: new Map([['p:1', v]]) });
  assert(/<b>JavaScript を作りましたが、要件を満たしていない部分があります（登録できません）。<\/b>/.test(card) && !/静的な検査は通過/.test(card) && /生成 2 回目/.test(card) && /kt-ai-code-not-achieved[^>]*>要件のうち満たせない部分（AI の申告）/.test(card), `コードカード: 見出しを差し替え、「✓ 静的な検査は通過」とは並べない。「生成 N 回目」を出す: ${card.replace(/<[^>]*>/g, '').slice(0, 200)}`);
  // 独立レビュー C: AI の申告は「AI の申告」と書き、coverage-unmet の blocker と同じ項目を 2 回出さない
  assert((card.match(/部長承認待ちでも金額を編集不可にする/g) || []).length === 1 && !/（Toolkit の確認）/.test(card), `コードカード: AI の申告の未達は 1 回だけ（blocker の行と重ねない）・Toolkit の確認の行は出ない: ${card.replace(/<[^>]*>/g, '').slice(0, 300)}`);
  const pane = KTAiChatUi.codePaneHtml(entry);
  assert(/× 要件を満たしていない部分があります（登録できません）/.test(pane.head) && !/静的な検査は通過/.test(pane.head) && /生成 2 回目（使用量: 入力 3000 \/ 出力 400 token/.test(pane.head) && !/見積もり/.test(pane.head), `コードペインの見出しも同じ（登録の判定・生成の回数と実測の使用量）: ${pane.head.replace(/<[^>]*>/g, '').slice(0, 300)}`);
  assert((pane.head.match(/部長承認待ちでも金額を編集不可にする/g) || []).length === 1 && !/（Toolkit の確認）/.test(pane.head) && /要件の達成: 要件を満たしていません（AI の申告）/.test(pane.review), 'コードペイン: AI の申告は検査の一覧（要件の達成）に 1 回だけ。Toolkit の確認の行には出さない');
  const entryPl = { generated: GEN_R14, review: rvPl, existingSource: null };
  const vPl = { planId: 'p', version: 1, goal: 'g', plan: PLAN_R14, review: null, ctx: null, status: 'ACTIVE', generated: { C1: entryPl } };
  const cardPl = KTAiChatUi.messageHtml({ id: 'm2', type: 'CODE', role: 'toolkit', text: 'JavaScript', at: '', data: { planId: 'p', version: 1, customizationId: 'C1' } }, { plans: new Map([['p:1', vPl]]) });
  assert(!/kt-ai-code-planned-hint/.test(cardPl) && /生成 1 回目/.test(cardPl), 'コードカード: 新設の項目の案内（plannedHint）は出さない。「生成 N 回目」は出す');
});

// =========================================================
console.log('\n--- T-A5（5.5 → 段階 C）var: 自動修正は生成した新しいコード（patch の content）だけ。変更する handler の既存の var は自動では変えない ---');
//   段階 A の「変更する handler の本体の既存 var の自動変換」は段階 C で外した（改訂 2: 任意の既存コードの独自変換器を広げない）。既存の記法の違反は生成側の指示と記法の検査に任せる
await section(() => {
  const SRC = R.DEAL_LOCK;   // handler の中に var record
  const content = "      record['items'].value.forEach(function (row) {\n        row.value['qty'].disabled = true;\n      });\n";
  const g = { strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', code: content, patch: { baseHash: KTScan.hashText(SRC), operations: [{ type: 'INSERT_AFTER', anchor: "      record['amount'].disabled = true;", content }] }, events: ['app.record.edit.show'], fields: [{ code: 'qty', access: 'CONTROL' }], apis: [] };
  const src = { name: 'dealLock.js', target: 'desktop', text: SRC };
  const f = KTModernJs.fixGenerated({ generated: g, existingSource: src });
  assert(f.status === 'ok' && f.fixed.length === 0 && !('handlerVars' in f) && /var record = event\.record;/.test(f.source) && f.generated.patch.operations.length === 1, `DEAL_LOCK（var record）の handler に挿入する patch → 既存の var record は変えない（操作も増やさない）: ${f.status} ${JSON.stringify(f.fixed)}`);
  const c = { customizationId: 'C1', requirement: '承認済みでは明細の数量を編集不可', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], events: ['app.record.create.show', 'app.record.edit.show'], fields: [{ code: 'qty', access: 'CONTROL' }], apis: [], existingFiles: [{ name: 'dealLock.js', target: 'desktop' }] };
  const rv = KTCodeReview.review({ generated: f.generated, customization: c, plan: null, data: DATA, scan: null, existingSource: src });
  const pc = check(rv, 'patch');
  assert(pc && pc.ok && /元のコードは保持（全文の書き換えなし）$/.test(pc.message) && !/既存の宣言/.test(pc.message) && !check(rv, 'patch-removal') && check(rv, 'modern-js').ok, `patch の検査: 既存の var は変更していない行（記法の検査の対象外）・置き換えも無い: ${pc && pc.message}`);
  // 追加した var は従来どおり const / let に直す（ai-modern-js M4）。handler の外・別の handler・同じ handler の既存の var は変えない
  const SRC2 = "(function () {\n  'use strict';\n  var EVENTS = ['app.record.edit.show'];\n  var LIMIT = 1000000;\n  kintone.events.on(EVENTS, function (event) {\n    var record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();\n";
  const content2 = "      var rows = record['items'].value;\n      rows.forEach(function (row) { row.value['qty'].disabled = true; });\n";
  const g2 = { strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', code: content2, patch: { baseHash: KTScan.hashText(SRC2), operations: [{ type: 'INSERT_AFTER', anchor: "      record['amount'].disabled = true;", content: content2 }] }, events: ['app.record.edit.show'], fields: [{ code: 'qty', access: 'CONTROL' }], apis: [] };
  const f2 = KTModernJs.fixGenerated({ generated: g2, existingSource: { name: 'dealLock.js', target: 'desktop', text: SRC2 } });
  assert(f2.status === 'fixed' && f2.fixed.map(x => x.name).join() === 'rows' && /var EVENTS = /.test(f2.source) && /var LIMIT = /.test(f2.source) && /var record = event\.record;/.test(f2.source) && /const rows = record\['items'\]\.value;/.test(f2.source) && f2.generated.patch.operations.length === 1, `追加した var rows だけ const に。handler の外（EVENTS / LIMIT）も同じ handler の既存の var record も変えない: ${JSON.stringify(f2.fixed.map(x => x.name))}`);
  // patch が handler の外に入る（即時関数の直下に新しい handler を足す）→ 既存の handler の var は変えない
  const g3 = { strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', code: SA.EDIT_LOCK_CONTENT, patch: { baseHash: KTScan.hashText(SRC), operations: [{ type: 'INSERT_BEFORE', anchor: '})();', content: SA.EDIT_LOCK_CONTENT }] }, events: [], fields: [], apis: [] };
  const f3 = KTModernJs.fixGenerated({ generated: g3, existingSource: src });
  assert(f3.status === 'ok' && /var record = event\.record;/.test(f3.source), `新しい handler を足すだけ → 既存の handler の var record は触らない: ${f3.status}`);
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
  const INPUTS = SR.inputs353(T);
  const custC1 = { customizationId: 'C1', requirement: '承認済みでは金額を編集不可にする', whyStandardInsufficient: 'ステータスで切り替えるアクセス権は無い', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [] };
  const hybrid = mkPlan([mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { solution: 'CUSTOMIZATION', confidence: 'CONFIRMED' })], { goal: '承認済みでは金額を編集できなくして', solution: 'HYBRID', customizations: [custC1] });
  const seen = [];
  const blockedReview = { status: 'BLOCKED', checks: [{ name: 'fields', ok: false, severity: 'block', message: '存在しないフィールドコードを参照しています: approver_mgr' }], registration: { verdict: 'BLOCKED', blockers: [{ code: 'fields', message: '存在しないフィールドコードを参照しています: approver_mgr' }], confirmations: [], unverified: [] }, coverage: { achieved: [], notAchieved: [], outOfScope: [], unowned: [] } };
  const services = {
    async plan() { const p = clone(hybrid); return { plan: p, ctx: { facts: [] }, review: KTPlanReview.review({ plan: p, ...INPUTS }), turn: null }; },
    revisionModes: () => ['full', 'patch'], conversationFeatures: () => ['requirements', 'brief'],
    async ask() { return { ok: true, answer: { answer: 'a', facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx: { facts: [] } }; },
    // 実物の services.generate と同じ順: 入力の指紋 → 前の記録と照合 → 同じなら AI を呼ばない
    async generate({ previous }) { seen.push(previous || null); const rep2 = repeatOf(previous, 'h1'); if (rep2.repeat) return { ok: false, reason: 'REPEAT_SAME_INPUT', message: rep2.message, hints: rep2.hints, blockers: rep2.blockers, attempts: previous.attempts }; return { ok: true, generated: { code: "(function () { 'use strict'; })();", strategy: 'NEW_JS_FILE', targetFile: 'a.js', summary: 's' }, review: clone(blockedReview), ctx: { size: { approxTokens: 1200 } }, inputHash: 'h1' }; },
    readiness(v) { return { approved: 0, executable: 0, unsupported: 0, blocked: 0, undecided: v.plan.steps.length }; },
  };
  const c = KTAiConversation.create({ services, now: () => '2026-10-07T00:00:00.000Z', clock: () => 1000 });
  await c.send('承認済みでは金額を編集できなくして'); await ticks();
  const v = c.activePlan(); c.confirmSpec({ planId: v.planId, version: v.version });
  await c.send('コードを作って'); await ticks();
  assert(seen.length === 1 && seen[0] === null && v.generated.C1 && v.generated.C1.inputHash === 'h1' && v.generated.C1.blockers.join() === 'fields' && v.generated.C1.attempts.count === 1 && v.generated.C1.attempts.measured === 0 && v.generated.C1.attempts.tokens.input === 0, `1 回目: 前の記録なし → 版に指紋・blocker・回数を記録（AI の記録が無いので使用量は足さない）: ${JSON.stringify(v.generated.C1 && { inputHash: v.generated.C1.inputHash, blockers: v.generated.C1.blockers, attempts: v.generated.C1.attempts })}`);
  const before = c.messages().length;
  const r2 = await c.send('コードを作って'); await ticks();
  const rep2 = c.messages().find(m => m.data?.kind === 'generate-repeat');
  assert(seen.length === 2 && seen[1] && seen[1].attempts.count === 1 && r2.ok === false && rep2 && /同じ入力・同じ指摘です/.test(rep2.text) && rep2.data.hints.length >= 2 && v.generated.C1.attempts.count === 1 && !c.messages().slice(before).some(m => m.type === KTAiConversation.MSG.ERROR), `2 回目（同じ入力・同じ指摘）: AI を呼ばず「同じ入力・同じ指摘です」と何を変えれば変わるかを会話に出す。エラーカード（再試行）は出さない・回数は増えない: ${rep2 && rep2.text.slice(0, 120)}`);
  const cardHtml = KTAiChatUi.messageHtml(c.messages().filter(m => m.type === 'CODE').pop(), { plans: new Map([[`${v.planId}:${v.version}`, v]]) });
  assert(/生成 1 回目/.test(cardHtml), `コードカードに「生成 N 回目」: ${cardHtml.replace(/<[^>]*>/g, '').slice(0, 120)}`);
  // 会話の案内（code-intro）: 範囲内の NOT_MET があれば見出しは「要件を満たしていない部分があります（登録できません）」＋ 新設を前提にした作り直しが要る案内。
  //   独立レビュー C: AI の申告と Toolkit の確認を分けて書く
  const services2 = { ...services, async generate() { return { ok: true, generated: { code: "(function () { 'use strict'; })();", strategy: 'NEW_JS_FILE', targetFile: 'a.js', summary: 's' }, review: { status: 'BLOCKED', checks: [{ name: 'coverage-unmet', ok: false, severity: 'block', message: 'x' }], registration: { verdict: 'BLOCKED', blockers: [{ code: 'coverage-unmet', message: 'x' }], confirmations: [], unverified: [] }, coverage: { achieved: [], notAchieved: [{ code: 'AI_NOT_MET', message: '部長承認待ちでも編集不可にする（部長承認待ちは存在しない）', planned: ['部長承認待ち'] }, { code: 'SUBTABLE_ROWS', message: '明細（テーブル）の行の追加・削除は止められません' }], plannedHint: { names: ['部長承認待ち'], message: '計画で新設する項目（部長承認待ち）を前提にした作り直しが必要です。計画を直すか、最終案の作成で作り直します' }, outOfScope: [], unowned: [] } }, ctx: null, inputHash: 'h9' }; } };
  const c2 = KTAiConversation.create({ services: services2, now: () => '2026-10-07T00:00:00.000Z', clock: () => 1000 });
  await c2.send('承認済みでは金額を編集できなくして'); await ticks();
  const v2 = c2.activePlan(); c2.confirmSpec({ planId: v2.planId, version: v2.version });
  await c2.send('コードを作って'); await ticks();
  const intro = c2.messages().find(m => m.data?.kind === 'code-intro');
  assert(intro && /^JavaScript を生成しましたが、要件を満たしていない部分があります（登録できません）。/.test(intro.text) && /要件のうち満たせない部分があります（AI の申告）: 部長承認待ちでも編集不可にする/.test(intro.text) && /要件のうち満たせない部分があります（Toolkit の確認）: 明細（テーブル）の行の追加・削除は止められません/.test(intro.text) && !/前提にした作り直し/.test(intro.text) && !/静的な検査は通過/.test(intro.text), `code-intro: NOT_MET の見出し ＋ AI の申告と Toolkit の確認を分けて書く（段階 C: 新設を前提にした作り直しの案内（plannedHint）は出さない）: ${intro && intro.text}`);
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
  // 実機と同じ順: 生成の直後に modern JavaScript の修正 → Code Review
  const mf = KTModernJs.fixGenerated({ generated: g0, existingSource: src });
  assert(['ok', 'fixed'].includes(mf.status) && !mf.handlerVars, `生成コードは const で書かれている（新しい handler を足すだけなので既存の handler の var は触らない）: ${mf.status}`);
  const rv = KTCodeReview.review({ generated: mf.generated, customization: SA.CUSTOMIZATION, plan: null, data, scan, existingSource: src });
  const codes = codesOf(rv.registration.blockers);
  assert(rv.status !== 'BLOCKED' && rv.registration.verdict === 'NEEDS_CONFIRMATION' && !codes.length, `R15: 登録不可にはならない（確認が残る）: ${rv.status} ${JSON.stringify(rv.checks.filter(x => !x.ok).map(x => [x.name, x.severity, x.message.slice(0, 80)]))}`);
  const text = clean(rv.finalCode);
  // 両承認待ち状態: 金額のロックの経路に 2 つのステータス名（早い return の否定に両方）
  const amountSites = KTCodeReview.disableSites(text, 'amount').filter(x => /課長承認待ち/.test(JSON.stringify(x.conds)));
  assert(amountSites.length === 1 && /部長承認待ち/.test(JSON.stringify(amountSites[0].conds)) && !amountSites[0].unconditional, `両承認待ち: 金額のロックは課長承認待ち・部長承認待ちの両方を見る条件の中: ${JSON.stringify(amountSites.map(x => x.conds))}`);
  const ccA = rv.checks.filter(x => x.name === 'conditional-control');
  const ccAmount = ccA.find(x => /^amount /.test(x.message));
  assert(ccAmount && ccAmount.severity !== 'block' && /承認済み/.test(ccAmount.message) && /両方が効きます/.test(ccAmount.message), `既存制御: 承認済みの既存のロック（dealLock.js）は別の条件の制御として残り、両方が効くことを確認に出す: ${ccAmount && ccAmount.message}`);
  assert(['item_name', 'qty', 'unit_price', 'items'].every(code => { const x = ccA.find(y => y.message.startsWith(`${code} `)); return x && x.ok; }), `明細: 明細の列（item_name / qty / unit_price）とテーブル（items）は計画の条件の中でだけ編集不可: ${JSON.stringify(ccA.map(x => [x.ok, x.message.slice(0, 60)]))}`);
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
  const ch = KTJsExecutor.changeFromGenerated({ customization: SA.CUSTOMIZATION, generated: mf.generated, review: rv, existingSource: src });
  assert(ch.ok && ch.change.kind === 'REPLACE_FILE' && ch.change.name === 'dealLock.js' && ch.change.content.includes("record['ステータス'].value === '承認済み'") && ch.change.content.includes("st !== '課長承認待ち' && st !== '部長承認待ち'") && ch.change.dependsOn.statuses.length === 0, '登録の単位: dealLock.js の差し替え（承認済みの既存制御 ＋ 承認待ち 2 種類の新しい制御）。新設の依存は無い');
});

// =========================================================
console.log('\n--- T-A9（独立レビューの指摘）早い return の誤認・not in の条件・緩い等号と再代入・宣言の更新・依存の確認・文字列の中の }・前提の手順番号・二重の表示 ---');
await section(async () => {
  const ec = (rv) => check(rv, 'error-cancels-edit');
  const okCode = handler(EDIT, "    if (record['ステータス'].value === '承認待ち') {\n      record['amount'].disabled = true;\n    }");
  // ---- A-1（段階 C）: 早い return の見分け（入れ子の if / for / callback の return）で競合を断定することはやめた。静的には確認（review）に留め、競合は模擬イベントで決める
  const nestedBody = "    const st = record['ステータス'].value;\n    const amt = Number(record['amount'].value);\n    if (!st) {\n      record['amount'].error = 'x';\n      if (amt > 100) return event;\n    }\n    record['amount'].disabled = true;";
  const nested = review(handler(EDIT, nestedBody));
  assert(ec(nested) && ec(nested).severity === 'block' && ec(nested).simDecides === true, `A-1（静的）: 入れ子の return の if と無条件の disabled → 模擬の結果が無い間は error-cancels-edit も登録不可（模擬が動けば模擬の結果で判定）: ${ec(nested) && ec(nested).severity}`);
  const nestedSim = await mergedOf(handler(EDIT, nestedBody));
  assert(!nestedSim.checks.some(x => x.name === 'sim-conflict') && nestedSim.checks.some(x => x.name === 'sim-control' && !x.ok && x.severity === 'review'), `A-1（模擬）: 代表条件（ステータスあり）では error が立たず disabled だけ → 競合なし。条件に合わないステータス（作成中）でも編集不可にする → 条件の外の制御（確認）: ${JSON.stringify(nestedSim.sim.cases.map(x => x.verdict))}`);
  const opsN = KTCodeReview.fieldOperations(clean(handler(EDIT, "    const st = record['ステータス'].value;\n    if (!st) {\n      record['amount'].error = 'x';\n      if (Number(record['amount'].value) > 100) return event;\n    }\n    record['amount'].disabled = true;")));
  const dN = opsN.find(o => o.op === 'disabled');
  assert(dN && dN.unconditional && !(dN.conds || []).length, `siteConds: 入れ子の return の if には否定（!(…)）を付けない（disabled は無条件のまま。字句の判定）: ${JSON.stringify(dN && dN.conds)}`);
  // callback の中の return と error / disabled が行ごとに同時に起きる → 模擬で競合（block）
  const tableCust = cust({ requirement: '承認待ちでは明細の数量を編集不可。数量が空なら警告', fields: [{ code: 'ステータス', access: 'READ' }, { code: 'items', access: 'CONTROL', condition: 'ステータス in ("承認待ち")' }, { code: 'qty', access: 'CONTROL' }] });
  const feBody = "    if (record['ステータス'].value !== '承認待ち') { return event; }\n    record['items'].value.forEach(function (row) {\n      if (!row.value['qty'].value) {\n        row.value['qty'].error = '必須';\n        return;\n      }\n      row.value['qty'].disabled = true;\n    });";
  const fe = await KTCodeReview.attachSim(review(handler(EDIT, feBody), tableCust, { fields: [{ code: 'items', access: 'CONTROL' }, { code: 'qty', access: 'CONTROL' }] }), await KTJsSim.simulate({ customization: tableCust, generated: gen(handler(EDIT, feBody), { fields: [{ code: 'items', access: 'CONTROL' }, { code: 'qty', access: 'CONTROL' }] }), review: null, existingSource: null, otherFiles: [], data: DATA, backend: vmBackend }), { customization: tableCust });
  assert(fe.registration.verdict === 'BLOCKED' && codesOf(fe.registration.blockers).includes('sim-conflict'), `A-1（模擬）: 空のケース（編集画面）は明細 2 行（1 行目は空・2 行目は入力あり）→ 空の行で error・入力ありの行で disabled → 同じイベントで両方が立つ → 競合（登録不可）: ${JSON.stringify(codesOf(fe.registration.blockers))} ${JSON.stringify(fe.sim.cases.map(x => [x.kind, x.verdict]))}`);
  // ---- A-2: not in / != の条件は値を照合しない（項目を見ていれば計画の条件）。肯定の in は従来どおり値まで照合
  const notIn = review(handler(EDIT, "    const st = record['ステータス'].value;\n    if (st === '作成中' || st === '承認待ち') {\n      record['amount'].disabled = true;\n    }"), cust({ fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス not in ("承認済み")' }] }));
  assert(notIn.registration.verdict !== 'BLOCKED' && check(notIn, 'conditional-control') && check(notIn, 'conditional-control').ok, `A-2: not in ("承認済み") を列挙（作成中 / 承認待ち）で書いても BLOCKED にしない: ${notIn.registration.verdict} ${check(notIn, 'conditional-control') && check(notIn, 'conditional-control').message}`);
  const notEq = review(handler(EDIT, "    const st = record['ステータス'].value;\n    if (st !== '承認済み') {\n      record['amount'].disabled = true;\n    }"), cust({ fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス != "承認済み"' }] }));
  assert(notEq.registration.verdict !== 'BLOCKED' && check(notEq, 'conditional-control').ok, 'A-2: != の条件も値を照合しない');
  const mixed = review(handler(EDIT, "    const st = record['ステータス'].value;\n    if (st === '承認済み') {\n      record['amount'].disabled = true;\n    }"), cust({ fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち") and 担当者 not in (LOGINUSER())' }] }));
  assert(mixed.registration.verdict === 'BLOCKED' && /計画の値「承認待ち」ではなく別の値/.test(check(mixed, 'conditional-control').message), `A-2: 肯定の in の値（承認待ち）は引き続き照合し、not in の項の値は数えない: ${check(mixed, 'conditional-control').message}`);
  // ---- B-3（段階 C）: 緩い等号・再代入を見る排他の判定は削除（静的には確認。模擬の結果で決める）
  const loose = review(handler(EDIT, "    const n = record['amount'].value;\n    if (n == 1) { record['amount'].error = 'x'; }\n    if (n === '1') { record['amount'].disabled = true; }"), cust({ fields: [{ code: 'amount', access: 'CONTROL' }] }));
  assert(loose.registration.verdict === 'BLOCKED' && ec(loose) && ec(loose).severity === 'block' && ec(loose).simDecides === true, `B-3: 排他の判定はしない（模擬の結果が無い間は登録不可・模擬が動けば模擬で判定）: ${ec(loose) && ec(loose).severity}`);
  const looseSim = await mergedOf(handler(EDIT, "    const n = record['amount'].value;\n    if (n == 1) { record['amount'].error = 'x'; }\n    if (n === '1') { record['amount'].disabled = true; }"), cust({ fields: [{ code: 'amount', access: 'CONTROL' }] }));
  assert(ec(looseSim).severity === 'review', `B-3（模擬）: 模擬イベントが動いたら確認に下げる: ${ec(looseSim).severity}`);
  // ---- C: 確認の文は短く、確認の仕方（HOW_TO_CHECK）に模擬イベントの位置づけを書く
  const strictBoth = review(handler(EDIT, "    const st = record['ステータス'].value;\n    if (st === '作成中') { record['amount'].error = 'x'; }\n    if (st === '承認待ち') { record['amount'].disabled = true; }"));
  const strictBothSim = await mergedOf(handler(EDIT, "    const st = record['ステータス'].value;\n    if (st === '作成中') { record['amount'].error = 'x'; }\n    if (st === '承認待ち') { record['amount'].disabled = true; }"));
  assert(ec(strictBoth).message === '同じイベント（app.record.edit.show: error と disabled）にエラー表示と編集可否・値の変更の記述があります。kintone はエラーを表示したイベントで編集可否（disabled）と値の変更を取り消す（別の handler で設定したものも）ため、実際に同時に起きるかを生成工程の模擬テスト（代表条件）で確かめます。模擬テストで確かめられない間は登録できません' && strictBothSim.registration.confirmations.some(x => x.code === 'error-cancels-edit' && /編集不可のまま・警告が出ない/.test(x.howToCheck) && /生成工程の模擬テスト/.test(x.howToCheck)), `C: 確認の文と確認の仕方: ${ec(strictBoth).message}`);
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
  // ---- B8（段階 C）: handler の本文の範囲（handlerBodiesOf）は削除した（使う処理が無くなった）
  assert(typeof KTModernJs.handlerBodiesOf === 'undefined' && typeof KTModernJs.parseAst === 'function', 'B8: handlerBodiesOf は削除・parseAst は残す（KTJsSim が同じ構文解析器を使う）');
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
  // ---- 7: kind 'generate-repeat' の描画: 見出し 1 行 ＋ hints の箇条書き（r.message の長文は出さない）。検査が完了しなかった回は見出しもそう言う
  const INPUTS = SR.inputs353(T);
  const custC1 = { customizationId: 'C1', requirement: '承認済みでは金額を編集不可にする', whyStandardInsufficient: 'ステータスで切り替えるアクセス権は無い', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [] };
  const hybrid = mkPlan([mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { solution: 'CUSTOMIZATION', confidence: 'CONFIRMED' })], { goal: '承認済みでは金額を編集できなくして', solution: 'HYBRID', customizations: [custC1] });
  const convWith = async (firstReview) => {
    const services = {
      async plan() { const p = clone(hybrid); return { plan: p, ctx: { facts: [] }, review: KTPlanReview.review({ plan: p, ...INPUTS }), turn: null }; },
      revisionModes: () => ['full', 'patch'], conversationFeatures: () => ['requirements', 'brief'],
      async ask() { return { ok: true, answer: { answer: 'a', facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx: { facts: [] } }; },
      // 実物の services.generate と同じ順: 前の記録と照合 → 同じ入力なら AI を呼ばず REPEAT_SAME_INPUT（reviewFailed も返す）
      async generate({ previous }) { const rp = repeatOf(previous, 'h1'); if (rp.repeat) return { ok: false, reason: 'REPEAT_SAME_INPUT', message: rp.message, hints: rp.hints, blockers: rp.blockers, reviewFailed: !!rp.reviewFailed, attempts: previous.attempts }; return { ok: true, generated: { code: "(function () { 'use strict'; })();", strategy: 'NEW_JS_FILE', targetFile: 'a.js', summary: 's' }, review: clone(firstReview), ctx: { size: { approxTokens: 1200 } }, inputHash: 'h1' }; },
      readiness(v) { return { approved: 0, executable: 0, unsupported: 0, blocked: 0, undecided: v.plan.steps.length }; },
    };
    const c = KTAiConversation.create({ services, now: () => '2026-10-07T00:00:00.000Z', clock: () => 1000 });
    await c.send('承認済みでは金額を編集できなくして'); await ticks();
    const v = c.activePlan(); c.confirmSpec({ planId: v.planId, version: v.version });
    await c.send('コードを作って'); await ticks();
    await c.send('コードを作って'); await ticks();
    const msg = c.messages().find(m => m.data?.kind === 'generate-repeat');
    return { c, v, msg, html: msg ? KTAiChatUi.messageHtml(msg, { plans: new Map([[`${v.planId}:${v.version}`, v]]) }) : '' };
  };
  const okReview = { status: 'OK', checks: [{ name: 'syntax', ok: true, severity: 'info', message: 'ok' }], registration: { verdict: 'RUNTIME_UNVERIFIED', blockers: [], confirmations: [], unverified: [] }, coverage: { achieved: [], notAchieved: [], outOfScope: [], unowned: [] } };
  const normal = await convWith(okReview);
  assert(normal.msg && normal.msg.data.reviewFailed === false && /<b>同じ入力・同じ指摘のため、作り直していません<\/b>/.test(normal.html) && /<ul[^>]*>(<li>[^<]+<\/li>){2,}<\/ul>/.test(normal.html) && /<li>検査は通っています。/.test(normal.html) && !/原因（入力の不足・指示・検証）を直してから/.test(normal.html), `7: 見出し 1 行 ＋ hints の箇条書き（長文は出さない）: ${normal.html.replace(/<[^>]*>/g, '｜').slice(0, 200)}`);
  assert(normal.html.split('<li>').length - 1 === normal.msg.data.hints.length, '7: 箇条書きは hints と同じ件数');
  // 検査が例外で完了しなかった回（services.generate の代替 review: reviewFailed: true・registration 無し）
  const failedReview = { status: 'REVIEW_REQUIRED', reviewFailed: true, checks: [{ name: 'code', ok: false, severity: 'review', message: 'Toolkit の検査を完了できませんでした: x' }], finalCode: '', addedCode: '', diff: null, mismatches: [], security: [] };
  const failed = await convWith(failedReview);
  assert(failed.v.generated.C1.reviewFailed === true && failed.v.generated.C1.attempts.history[0].reviewFailed === true, '4: 会話は代替 review の reviewFailed を版の記録と履歴に残す');
  assert(failed.msg && failed.msg.data.reviewFailed === true && /<b>同じ入力のため、作り直していません（前回は検査を完了できませんでした）<\/b>/.test(failed.html) && !/検査は通っています/.test(failed.html) && /<li>前回は Toolkit の検査を完了できなかった/.test(failed.html), `4 / 7: 検査が完了しなかった回の後は「検査は通っています」と言わない: ${failed.html.replace(/<[^>]*>/g, '｜').slice(0, 200)}`);
  // ---- 8: 括弧で囲んだ否定（not (ステータス in ("承認済み"))）も肯定の項から除く（値を照合しない。項目を見ていれば計画の条件）
  const notParen = review(handler(EDIT, "    const st = record['ステータス'].value;\n    if (st === '作成中' || st === '承認待ち') {\n      record['amount'].disabled = true;\n    }"), cust({ fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'not (ステータス in ("承認済み"))' }] }));
  assert(notParen.registration.verdict !== 'BLOCKED' && check(notParen, 'conditional-control') && check(notParen, 'conditional-control').ok, `8: 括弧で囲んだ否定の値（承認済み）は照合しない: ${notParen.registration.verdict} ${check(notParen, 'conditional-control') && check(notParen, 'conditional-control').message}`);
  const notParenAnd = review(handler(EDIT, "    const st = record['ステータス'].value;\n    if (st === '承認済み') {\n      record['amount'].disabled = true;\n    }"), cust({ fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち") and not (担当者 in (LOGINUSER()))' }] }));
  assert(notParenAnd.registration.verdict === 'BLOCKED' && /計画の値「承認待ち」ではなく別の値/.test(check(notParenAnd, 'conditional-control').message), `8: 肯定の in の値は引き続き照合し、括弧の否定の項は数えない: ${check(notParenAnd, 'conditional-control').message}`);
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
