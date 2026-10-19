// Q2（金額の境界）の局所修正（2026-10-14・仕様 §11.2）— 条件式の簡易比較と、直した計画の経路（有料の AI は使わない）
//
// 経緯: 保存済みの計画（2026-10-10 の実機。AI版 sandbox/test/fixtures/scenarios/nl1010.js の PLAN）の P2 は amount <= "999999" で、計画の AI が
//   「金額は整数の円単位だけか、小数も使うか」（Q2）を聞いた。利用者の意図「100 万円未満」は確定している。アプリの設定の数値の条件は = != >= <= だけ
//   （> < は不可）で and で結合できるので、amount <= "1000000" and amount != "1000000" と表せば、整数でも小数でも部長側 amount >= "1000000" と重なり・漏れが無い。
//   Toolkit の条件式の簡易比較（parseCond / condsOverlap / condNarrower / partitionCheck）は and の式を読めず「判定できません」（UNKNOWN・ACTION_CONDITION_UNPARSED）
//   になり、condsOverlap は != があるだけで「重なる」としていた → 同じフィールドの単純比較の and を節の配列で読み、節の集合をサンプルの値で評価する
//   （整数のサンプル・「整数として判定」の文・判定の意味は変えない）。
//
// 検証内容:
//   §B1 parseCond / condHolds: and の式 → 節 2 つ・単独 → 節 1 つ・or / 括弧 / 別のフィールド → null・値の中の and で切らない。
//        999999・999999.5・1000000・1000000.5 → 課長側 [真, 真, 偽, 偽]・部長側 [偽, 偽, 真, 真]（重なり・漏れなし）。''（空）・null → どちらも偽（暗黙に 0 にしない）
//   §B2 condsOverlap（<= 1000000 and != 1000000 と >= 1000000 は重ならない。!= の近道を使わない）・condNarrower（無条件 → 条件あり は制限）・
//        partitionCheck PARTITION_OK（旧の形 <= 999999 / >= 1000000 も従来どおり PARTITION_OK。GAP / OVERLAP / IDENTICAL の判定は今のまま）・KTQueryCheck.check（process）ok
//   §B3 KTPlanReview.review（直した計画 tests/fixtures/nl1010-branch-fixed.js・App 353 相当）: P2 は EXISTING_PATH_RESTRICTED（high）の NEEDS_CONFIRMATION で BLOCKED でない・
//        ACTION_CONDITION_OVERLAP / ACTION_CONDITION_UNPARSED / CONDITION_CHANGE_UNPARSED を出さない・P2 の理由に「整数」「小数」が無い・After と executorOutput で式がそのまま
//   §B4 会話（偽の services。new-flow の部品）: 直した計画（Q2 なし・Q1 は priority 'later'）＋ 3 本の検証済みの生成 → 最終案が承認できる（readiness.ready true・
//        「先に決めたいこと」なし・Q1 は後で決めるものとして表示・計画の AI 1 回・生成 3 回・修復 0）。同じ計画で C3 の生成が未解決（模擬テストの不合格）／
//        移植元の本文を送れない（条件が分からない）なら承認できないまま（未解決事項全般を無視していない）
//
//   修正前の版（KT_SRC）でも例外で止めずに各 assert を評価する（無い関数は例外を section が受けて FAIL にする）
//
// 実行方法: node tests/ai-process-branch-boundary.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
//   簡素化（2026-10-17）: 反映できるかは、最新の版なら会話の今の判定、前の版なら最終案の記録で確かめる（tests/helpers/final-state.js）
const FS = require('./helpers/final-state.js');
const { gwCandidateHash, gwWithBody } = require('./helpers/gw-hash.js');
const T = loadToolkit();
const { KTCodeReview, KTScan, KTAiClient, KTPlanReview, KTQueryCheck, KTDeps } = T;
const { assert, state } = makeAssert();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { clone, B, req, makeConvC } = K;
const F = require('./fixtures/nl1010-port.js');
const FX = require('./fixtures/nl1010-branch-fixed.js');
const RP = require('./fixtures/p21-bfc-replay.js');
const R = KTPlanReview;
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }

const LOW = 'amount <= "1000000" and amount != "1000000"';   // 課長側（100 万円未満）
const HIGH = 'amount >= "1000000"';                          // 部長側（100 万円以上）
const OLD_LOW = 'amount <= "999999"';                        // 保存済みの計画の形（整数限定）
const UNPARSED = ['ACTION_CONDITION_OVERLAP', 'ACTION_CONDITION_UNPARSED', 'CONDITION_CHANGE_UNPARSED', 'PROCESS_CONDITION_UNKNOWN', 'PROCESS_CONDITION_OVERLAP', 'PROCESS_CONDITION_GAP', 'PROCESS_CONDITION_IDENTICAL'];
const LABELS = { amount: '金額', 'ステータス': 'ステータス', items: '明細', item_name: '品名', qty: '数量', unit_price: '単価', subtotal: '小計' };
const COLUMNS = { item_name: 'items', qty: 'items', unit_price: 'items', subtotal: 'items' };
const SUBMITS = ['app.record.create.submit', 'app.record.edit.submit'];
const M_SUBMITS = ['mobile.app.record.create.submit', 'mobile.app.record.edit.submit'];
/** App 353 相当（フィールドは p21 の写し・プロセス管理は反映前・既存の JavaScript 2 ファイル） */
const DATA = { appId: '353', fields: clone(RP.FIELDS), status: clone(FX.STATUS_353), layout: [], views: { views: {} }, customize: { scope: 'ALL', desktop: { js: [{ type: 'FILE', file: { name: 'dealLock.js', fileKey: 'k-lock' } }, { type: 'FILE', file: { name: 'dealValidate.js', fileKey: 'k-validate' } }], css: [] }, mobile: { js: [], css: [] } } };
const DEPS = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
const reviewOf = (plan) => R.review({ plan, data: DATA, deps: DEPS, scan: null, incoming: null });
const st = (rv, id) => rv.steps.find(s => s.stepId === id);
const codes = (r) => (r && r.issues ? r.issues : []).map(i => i.code);
/** 直した計画の P2 を別の条件にした写し */
const planWithP2 = (cond) => { const p = clone(FX.PLAN_FIXED); p.steps.find(s => s.id === 'P2').spec.filterCond = cond; return p; };
/** partitionCheck に渡すプロセス（Review の After と同じ形）: 作成中 → 承認待ち（申請する: low）/ 作成中 → 部長承認待ち（部長へ申請: high） */
const procOf = (low, high = HIGH) => ({
  states: ['作成中', '承認待ち', '承認済み', '部長承認待ち'].map((name, index) => ({ name, index, assigneeType: 'ONE', assignees: [] })),
  actions: [{ name: '申請する', from: '作成中', to: '承認待ち', filterCond: low }, { name: '承認する', from: '承認待ち', to: '承認済み', filterCond: '' }, { name: '差し戻す', from: '承認待ち', to: '作成中', filterCond: '' }, { name: '部長へ申請', from: '作成中', to: '部長承認待ち', filterCond: high }].map(a => ({ ...a, type: 'PRIMARY', executableUsers: [] })),
});
const partOf = (low, high) => R.partitionCheck(procOf(low, high), LABELS).find(x => x.from === '作成中');

(async () => {
// =========================================================
console.log('\n--- §B1. parseCond / condHolds: and の式を節の配列で読む・境界の値の評価 ---');
await section(async () => {
  const pl = R.parseCond(LOW), ph = R.parseCond(HIGH);
  assert(pl && pl.field === 'amount' && Array.isArray(pl.clauses) && pl.clauses.length === 2 && JSON.stringify(pl.clauses.map(c => [c.op, c.value, c.num])) === JSON.stringify([['<=', '1000000', 1000000], ['!=', '1000000', 1000000]]),
    `B1-1: and の式 → 同じフィールドの節 2 つ（op / value / num）: ${JSON.stringify(pl)}`);
  assert(ph && ph.field === 'amount' && ph.clauses.length === 1 && ph.clauses[0].op === '>=' && ph.clauses[0].num === 1000000, `B1-2: 単独の式 → 節 1 つ: ${JSON.stringify(ph)}`);
  const upper = R.parseCond('amount >= "1000000" AND amount <= "2000000"');
  assert(R.parseCond('amount <= "1000000" or amount != "1000000"') === null && R.parseCond('(amount <= "1000000") and amount != "1000000"') === null && R.parseCond('amount <= "1000000" and qty != "1"') === null && upper && upper.clauses.length === 2,
    'B1-3: or・括弧・別のフィールドの混在は今までどおり null（大文字の AND は読む）');
  const text = R.parseCond('deal_name = "a and b"');
  assert(text && text.clauses.length === 1 && text.clauses[0].value === 'a and b' && text.clauses[0].num === null && R.parseCond('') === null && R.parseCond(null) === null, `B1-4: 値の中の and で式を切らない・空は null: ${JSON.stringify(text)}`);
  const vals = ['999999', '999999.5', '1000000', '1000000.5'];
  const low = vals.map(v => R.condHolds(pl, v)), high = vals.map(v => R.condHolds(ph, v));
  assert(JSON.stringify(low) === JSON.stringify([true, true, false, false]) && JSON.stringify(high) === JSON.stringify([false, false, true, true]),
    `B1-5: 999999・999999.5・1000000・1000000.5 → 課長側 [真, 真, 偽, 偽]・部長側 [偽, 偽, 真, 真]: ${JSON.stringify({ low, high })}`);
  assert(vals.every((v, i) => low[i] !== high[i]), 'B1-6: どの値もどちらか一方だけ（重なり・漏れなし）');
  assert([pl, ph].every(p => R.condHolds(p, '') === false && R.condHolds(p, null) === false && R.condHolds(p, undefined) === false), 'B1-7: 空の文字列・null・undefined はどちらも偽（<= 1000000 でも 0 に変換して真にしない）');
  assert(R.condHolds(pl, 999999.5) === true && R.condHolds(pl, '1,000,000') === false && R.condHolds(ph, '1,000,000') === true && R.condHolds(ph, 'abc') === false && R.condHolds(null, 1) === false && R.condHolds(R.parseCond('deal_name = "x"'), 1) === false,
    'B1-8: 数値・桁区切りの文字列は読む。数値でない値・解析できない式・数値でない節は偽');
});

// =========================================================
console.log('\n--- §B2. condsOverlap / condNarrower / partitionCheck / KTQueryCheck ---');
await section(async () => {
  assert(R.condsOverlap(LOW, HIGH) === false && R.condsOverlap(HIGH, LOW) === false, `B2-1: <= 1000000 and != 1000000 と >= 1000000 は重ならない（!= があるだけで「重なる」にしない）: ${R.condsOverlap(LOW, HIGH)}`);
  assert(R.condsOverlap(OLD_LOW, HIGH) === false && R.condsOverlap('amount <= "1000000"', HIGH) === true && R.condsOverlap('amount != "1000000"', HIGH) === true && R.condsOverlap('amount != "1000000"', 'amount = "1000000"') === false && R.condsOverlap('', HIGH) === true && R.condsOverlap(LOW, 'deal_name = "x"') === true && R.condsOverlap(LOW, 'deal_name like "x"') === null,
    'B2-2: 旧の形は従来どおり・<= と >= は境界で重なる・!= と = は重ならない・無条件は重なる・別のフィールドは重なる・読めない式は null');
  assert(R.condNarrower(LOW, '') === true && R.condNarrower(LOW, 'amount >= "0"') === true && R.condNarrower('amount <= "2000000" and amount != "2000000"', LOW) === false && R.condNarrower(LOW, LOW) === false && R.condNarrower('', LOW) === false,
    'B2-3: condNarrower: 無条件 → 条件あり は制限・範囲が狭まれば真・広がれば偽・同じなら偽');
  const now = partOf(LOW), old = partOf(OLD_LOW);
  assert(now && now.verdict === 'PARTITION_OK' && /「金額」・整数として判定/.test(now.message) && /明らかな重複・欠落なし/.test(now.message) && !now.overlaps.length && !now.gap,
    `B2-4: partitionCheck: 申請する（<= 1000000 and != 1000000）/ 部長へ申請（>= 1000000）→ PARTITION_OK（文は今までどおり「整数として判定」）: ${JSON.stringify(now && [now.verdict, now.message])}`);
  assert(old && old.verdict === 'PARTITION_OK', `B2-5: 旧の形（<= 999999 / >= 1000000）は従来どおり PARTITION_OK: ${JSON.stringify(old && [old.verdict, old.message])}`);
  const gap = partOf('amount <= "500000" and amount != "500000"'), ov = partOf('amount <= "1000000"'), same = partOf('amount != "1000000" and amount >= "1000000"', 'amount >= "1000000" and amount != "1000000"'), unk = partOf('amount <= "1000000" or amount = "5"');
  assert(gap && gap.verdict === 'GAP' && ov && ov.verdict === 'OVERLAP' && same && same.verdict === 'IDENTICAL' && unk && unk.verdict === 'UNKNOWN',
    `B2-6: GAP（50 万未満 / 100 万以上）・OVERLAP（<= 100 万 / >= 100 万）・IDENTICAL（節の順が違う同じ式）・UNKNOWN（or）の判定は今のまま: ${JSON.stringify([gap && gap.verdict, ov && ov.verdict, same && same.verdict, unk && unk.verdict])}`);
  const qc = KTQueryCheck.check(LOW, { fields: R.buildBeforeModel(DATA).fields, usage: 'process' });
  assert(qc.ok === true && qc.conds.length === 2 && qc.logical === 'and' && qc.conds.every(c => c.field === 'amount') && KTQueryCheck.check(HIGH, { fields: R.buildBeforeModel(DATA).fields, usage: 'process' }).ok === true,
    `B2-7: KTQueryCheck.check（process）: 数値の <= と != を and で結んだ式は ok（SETTINGS_OPS の NUMBER に != がある）: ${JSON.stringify(qc.errors)}`);
  assert(KTQueryCheck.check('amount < "1000000"', { fields: R.buildBeforeModel(DATA).fields, usage: 'process' }).errors.some(e => e.code === 'COND_OPERATOR_NOT_ALLOWED'), 'B2-8: 前提: 数値の < は process では使えない（だから <= と != で表す）');
});

// =========================================================
console.log('\n--- §B3. KTPlanReview.review: 直した計画（P2 が <= と != の and）---');
await section(async () => {
  const fixed = FX.PLAN_FIXED;
  assert(fixed.steps.find(s => s.id === 'P2').spec.filterCond === LOW && fixed.steps.find(s => s.id === 'P2').confidence === 'CONFIRMED' && !fixed.questions.some(q => q.id === 'Q2') && fixed.questions.find(q => q.id === 'Q1').priority === 'later' && fixed.steps.find(s => s.id === 'P3').spec.filterCond === HIGH,
    'B3-0: 前提: 素材の P2 は新しい式・CONFIRMED、Q2 は無く、Q1 は later、P3 は >= 1000000');
  const rv = reviewOf(clone(fixed));
  const p2 = st(rv, 'P2'), p3 = st(rv, 'P3');
  assert(p2 && p2.status === 'NEEDS_CONFIRMATION' && p2.safety === 'REVIEW_REQUIRED' && codes(p2).includes('EXISTING_PATH_RESTRICTED') && p2.issues.find(i => i.code === 'EXISTING_PATH_RESTRICTED').severity === 'high' && p2.diff.after.filterCond === LOW,
    `B3-1: P2 は無条件 → 条件ありの EXISTING_PATH_RESTRICTED（high・確認待ち）で、BLOCKED / INVALID でない: ${JSON.stringify([p2 && p2.status, codes(p2)])}`);
  assert(!rv.steps.some(r => codes(r).some(c => UNPARSED.includes(c))) && !rv.warnings.some(w => UNPARSED.includes(w.code)) && !rv.steps.some(r => r.status === 'INVALID') && !rv.steps.some(r => r.safety === 'BLOCKED'),
    `B3-2: どの手順にも ACTION_CONDITION_OVERLAP / ACTION_CONDITION_UNPARSED / CONDITION_CHANGE_UNPARSED / PROCESS_CONDITION_* が無く、実行できない手順も無い: ${JSON.stringify(rv.steps.map(r => [r.stepId, r.status, codes(r)]))}`);
  const reasons = [...p2.issues.map(i => i.message), ...rv.warnings.map(w => w.message)];
  assert(!reasons.some(t => /整数|小数/.test(t)), `B3-3: P2 の確認待ちの理由と警告に「整数」「小数」の文が無い: ${JSON.stringify(reasons)}`);
  const part = (rv.simulation.process.partition || []).find(x => x.from === '作成中');
  assert(part && part.verdict === 'PARTITION_OK' && p3 && p3.status === 'NEEDS_CONFIRMATION' && !codes(p3).length, `B3-4: 作成中からの分岐は PARTITION_OK・P3（部長へ申請）に重なりの指摘なし: ${JSON.stringify(part && [part.verdict, part.message])}`);
  const after = rv.simulation.after.process.actions;
  assert(after.find(a => a.name === '申請する').filterCond === LOW && after.find(a => a.name === '部長へ申請').filterCond === HIGH, 'B3-5: After のプロセスに式がそのまま（正規化で崩れない）');
  const out = R.executorOutput(fixed, rv, fixed.steps.map(s => s.id));
  const outP2 = (out.plan.steps || []).find(s => s.id === 'P2');
  assert(outP2 && outP2.spec && outP2.spec.filterCond === LOW && out.approvedSteps.includes('P2') && out.approvedSteps.includes('P3'), `B3-6: Executor へ渡す形でも P2 の式がそのまま: ${JSON.stringify(outP2 && outP2.spec)}`);
  //   旧の形の計画（保存済みと同じ <= 999999）は従来どおり PARTITION_OK（整数として判定）
  const rvOld = reviewOf(planWithP2(OLD_LOW));
  const partOld = (rvOld.simulation.process.partition || []).find(x => x.from === '作成中');
  assert(partOld && partOld.verdict === 'PARTITION_OK' && !rvOld.steps.some(r => codes(r).some(c => UNPARSED.includes(c))), `B3-7: 旧の形（<= 999999）の計画は従来どおり PARTITION_OK: ${JSON.stringify(partOld && partOld.verdict)}`);
});

// =========================================================
console.log('\n--- §B4. 会話（偽の services）: 直した計画 ＋ 3 本の検証済みの生成 → 最終案が承認できる ---');
const JSF = (o = {}) => [
  { name: 'dealLock.js', target: 'desktop', events: ['app.record.create.show', 'app.record.edit.show'], fields: ['amount', 'ステータス'], source: true, analyzed: true, eventsUnresolved: false },
  { name: 'dealValidate.js', target: 'desktop', events: [...SUBMITS], fields: ['amount'], source: true, analyzed: true, eventsUnresolved: false, ...o },
];
const U = FX.PLAN_FIXED.goal.split('\n')[0];
/** 仮案の台本: 依頼の 1 発言で 3 つの振る舞い（分岐・編集不可・入力チェックの移植）を要件にする */
const script = ({ utterance }) => (utterance === U ? { reply: '金額で課長承認と部長承認に分け、承認済みでは金額と明細を編集できなくします。既存の入力チェックはモバイルにも移します。', intent: 'propose',
  proposal: { behaviors: [B('金額が100万円以上なら部長承認、100万円未満なら課長承認に分岐する', 'user'), B('承認済みでは金額と明細を変更できなくし、差戻し後は再編集できる', 'user'), B('既存の入力チェックを維持し、PC とモバイルの両方で使う', 'user')], assumptions: [], decisions: [], approach: { standard: ['プロセス管理のステータスとアクション'], js: ['編集制御', '入力チェックの移植'] }, cannot: [] },
  turn: { ops: [], answers: [], requirementOps: [
    req('add', { target: '承認の経路', condition: '金額が100万円以上', behavior: '部長承認にする（未満は課長承認）', sourceQuotes: ['100万円以上は部長承認'], planRefs: ['B1'], effects: [] }),
    req('add', { target: '金額と明細', condition: '承認済み', behavior: '変更できないようにする（差戻し後は再編集できる）', sourceQuotes: ['承認済みでは金額と明細を変更できなく'], planRefs: ['B2'], effects: [] }),
    req('add', { target: '入力チェック', condition: '', behavior: '既存の入力チェックをモバイルでも同じ判定で使う', sourceQuotes: ['今ある入力チェックは残して'], planRefs: ['B3'], effects: [] }),
  ] } } : null);
const refsOf = (r) => (/承認の経路/.test(r.target) ? ['P1', 'P2', 'P3', 'P4', 'P5'] : /入力チェック/.test(r.target) ? ['C3'] : ['C1', 'C2']);
/** 計画の AI の偽物: 直した計画を返す（Review は本物の KTPlanReview.review）。要件は手順・JavaScript に割り当てる */
const planImpl = (args) => {
  const plan = clone(FX.PLAN_FIXED);
  plan.goal = args.goal;
  const ops = (args.requirements || []).map(r => ({ op: 'update', id: r.id, target: r.target, condition: r.condition, behavior: r.behavior, exceptions: r.exceptions || [], decision: r.decision, disposition: 'adopted', sourceQuotes: [], planRefs: refsOf(r), effects: [], note: '' }));
  return { plan, ctx: null, gatewayPlan: clone(plan), turn: { reply: '計画を作りました。', requirementOps: ops, utteranceCoverage: [] }, review: reviewOf(plan) };
};
/** 承認済みで金額と明細のセルを編集不可にし、それ以外では解除する handler（C1 は dealLock.js の既存の handler を置き換え、C2 は新しいファイル） */
const LOCK_HANDLER = (evs) => [
  `kintone.events.on(${JSON.stringify(evs)}, function (event) {`,
  "    const record = event.record;",
  "    const locked = !!(record['ステータス'] && record['ステータス'].value === '承認済み');",
  "    record['amount'].disabled = locked;",
  "    if (record['items'] && Array.isArray(record['items'].value)) {",
  "      record['items'].value.forEach(function (row) {",
  "        ['item_name', 'qty', 'unit_price'].forEach(function (col) { if (row.value[col]) row.value[col].disabled = locked; });",
  "      });",
  "    }",
  "    return event;",
  "  });",
].join('\n');
const OLD_HANDLER = [
  "kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {",
  "    var record = event.record;",
  "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {",
  "      record['amount'].disabled = true;",
  "    }",
  "    return event;",
  "  });",
].join('\n');
/** C3 の移植元と比べる代表条件の値と移植元の動き（tests/ai-port-and-table-change.test.js と同じ） */
const VALUES = [['', '空', { stopped: true, errors: { amount: '金額を入力してください' }, eventError: null }], ['-1', '-1', { stopped: true, errors: { amount: '金額は0円以上で入力してください' }, eventError: null }], ['0', '0', { stopped: false, errors: {}, eventError: null }], ['1', '1', { stopped: false, errors: {}, eventError: null }]];
/** 生成工程の偽物: C1（dealLock.js に統合）・C2（モバイルの新しいファイル）は編集不可の代表条件で合格、C3 は移植元と比べる代表条件（c3 = 'fail' なら -1 で止めない候補）*/
const generate = ({ c3 = 'pass' } = {}) => {
  const seen = [];
  const impl = async (args) => {
    const cid = args.customizationId;
    seen.push({ cid, requiredEffects: clone(args.requiredEffects || []) });
    const c = (args.version.plan.customizations || []).find(x => x.customizationId === cid);
    const e0 = (args.requiredEffects || [])[0] || {};
    const mk = (g) => ({ summary: '', patch: null, apis: ['kintone.events.on'], assumptions: [], warnings: [], coverage: [{ requirementId: cid, status: 'MET', note: '', text: c.requirement }], ...g });
    let generated, existingSource = null, verification;
    if (cid === 'C1') {
      existingSource = { name: 'dealLock.js', target: 'desktop', text: F.DEAL_LOCK_JS };
      const content = LOCK_HANDLER(c.events);
      //   2026-10-18（AI版 契約 20 §20）: 統合の書き込む本文は生成工程が合成して返す（偽の生成工程は既存の本文と patch から作る）
      generated = gwWithBody(mk({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', summary: '承認済みでは金額と明細のセルを編集できないようにし、それ以外では解除します。', code: content, patch: { baseHash: KTScan.hashText(F.DEAL_LOCK_JS), operations: [{ type: 'REPLACE', anchor: OLD_HANDLER, content }] }, events: [...c.events], fields: c.fields.map(f => ({ code: f.code, access: f.access })) }), F.DEAL_LOCK_JS);
    } else if (cid === 'C2') {
      generated = mk({ strategy: 'NEW_JS_FILE', targetFile: 'dealLockMobile.js', summary: 'モバイルでも承認済みでは金額と明細のセルを編集できないようにします。', code: `(function () {\n  'use strict';\n  ${LOCK_HANDLER(c.events)}\n})();\n`, events: [...c.events], fields: c.fields.map(f => ({ code: f.code, access: f.access })) });
    } else {
      generated = mk({ strategy: 'NEW_JS_FILE', targetFile: 'dealValidateMobile.js', summary: 'PC と同じ保存時の入力チェックをモバイルにも用意します。', code: F.C3_CODE, events: [...M_SUBMITS], fields: [{ code: 'amount', access: 'CONTROL' }] });
    }
    const review = KTCodeReview.review({ generated, customization: c, plan: args.version.plan, data: clone(DATA), scan: null, existingSource });
    const candidateHash = gwCandidateHash({ strategy: generated.strategy, targetFile: generated.targetFile, code: generated.code, body: generated.body, baseHash: existingSource ? KTScan.hashText(existingSource.text) : null, customizationId: cid });
    if (cid === 'C3') {
      const failing = c3 === 'fail';
      let n = 0;
      const cases = (e0.events || []).flatMap(ev => VALUES.map(([val, ja, ref]) => { const mine = failing && val === '-1' ? { stopped: false, errors: {}, eventError: null } : clone(ref); const fail = JSON.stringify(mine) !== JSON.stringify(ref); return { id: `K${++n}`, requirementId: 'C3', requirementIds: ['C3'], field: 'amount', effect: 'block-save', expect: 'same-as-source', side: 'match', kind: 'port', event: ev, refEvent: ev.replace(/^mobile\./, ''), refFile: { file: 'dealValidate.js', target: 'desktop' }, verdict: fail ? 'fail' : 'pass', reference: ref, observed: mine, ...(fail ? { cause: 'expectation' } : {}), note: `金額 が ${ja} で保存する`, message: fail ? '移植元と違う動きです' : '移植元と同じ動きです' }; }));
      const raw = { version: '1', bodyHash: candidateHash, sameAsPrevious: false, passed: !failing, machine: [{ name: 'syntax', ok: true, severity: 'info', message: '構文エラーなし' }, { name: 'required-effects', ok: true, severity: 'info', message: '必須の効果の処理があります' }], requiredEffects: [{ requirementId: 'C3', requirementIds: ['C3'], field: 'amount', effect: 'block-save', status: 'present' }], behavior: { status: failing ? 'failed' : 'passed', reason: null, cases, ...clone(K.GW_SCOPE) }, repairs: { count: failing ? 1 : 0, reasons: [], stoppedBy: failing ? 'same-failure' : null }, unverified: ['実機での動作'] };
      verification = KTAiClient.normalizeVerification(raw);
    } else {
      verification = K.fakeVerification({ code: generated.code, has: { amount: ['lock'], item_name: ['lock'], qty: ['lock'], unit_price: ['lock'] } }, args.requiredEffects, { candidateHash });
    }
    return { ok: true, generated, review, ctx: { size: { approxTokens: 1000 } }, existingSource, inputHash: `h-${seen.length}`, verification, candidateHash, requirementIds: [{ id: cid, kind: 'customization', text: c.requirement }] };
  };
  return { impl, seen, calls: seen };
};
/** 依頼 → 採用（計画 → 生成 3 本 → 最終案）まで進めて、会話・生成の記録・最終案を返す */
const runBranch = async ({ c3 = 'pass', jsFiles = () => JSF() } = {}) => {
  const gen = generate({ c3 });
  const x = makeConvC({ scriptFn: script, labels: LABELS, generate: gen, planImpl });
  x.services.jsFiles = jsFiles;
  x.services.tableColumns = () => COLUMNS;
  await x.c.send(U);
  await x.c.send('採用します');
  return { x, gen, v: x.c.activePlan() };
};
await section(async () => {
  const { x, gen, v } = await runBranch();
  const g = (v && v.generated) || {};
  assert(x.calls.plan.length === 1 && gen.seen.map(s => s.cid).join() === 'C1,C2,C3' && ['C1', 'C2', 'C3'].every(cid => g[cid] && g[cid].status === 'verified') && Object.values(g).every(e => (e.repairs || 0) === 0 && !(e.verification && e.verification.repairs && e.verification.repairs.count)),
    `B4-1: 計画の AI 1 回・生成 3 回（C1 → C2 → C3）・修復 0 で 3 本とも検証済み: ${JSON.stringify({ plans: x.calls.plan.length, gens: gen.seen.map(s => s.cid), status: Object.fromEntries(Object.entries(g).map(([k, e]) => [k, e.status])) })}`);
  const sentC3 = gen.seen.find(s => s.cid === 'C3');
  assert(sentC3 && sentC3.requiredEffects.length === 1 && sentC3.requiredEffects[0].conditionFrom && sentC3.requiredEffects[0].conditionFrom.file === 'dealValidate.js' && sentC3.requiredEffects[0].condition === '',
    `B4-2: C3 の生成に渡した必須の効果は移植元 dealValidate.js と同じ条件（計画から生成へ移植元が渡る）: ${JSON.stringify(sentC3 && sentC3.requiredEffects)}`);
  const f = v && v.final;
  assert(f && f.approvable === true && f.readiness && f.readiness.ready === true && !(f.readiness.reasons || []).length && !f.blockingReason && !(f.blockedSteps || []).length && !f.fix,
    `B4-3: 最終案は承認できる（readiness.ready true・理由なし・実行できない手順なし・直す依頼なし）: ${JSON.stringify(f && { approvable: f.approvable, readiness: f.readiness, blocked: f.blockedSteps })}`);
  assert(f && f.questions.length === 1 && f.questions[0].id === 'Q1' && f.questions[0].priority === 'later' && !f.questions.some(q => /整数|小数/.test(q.text)),
    `B4-4: 残る質問は Q1（priority later）だけで、整数か小数かの質問（Q2）は無い: ${JSON.stringify(f && f.questions.map(q => [q.id, q.priority]))}`);
  const html = K.stripC(K.finalHtml(x));
  assert(!/先に決めたいこと/.test(html) && /後で決めてよいことが 1 件あります（答えなくても反映できます/.test(html) && !/整数|小数/.test(html),
    `B4-5: 最終案のカードに「先に決めたいこと」が無く、Q1 は後で決めてよいこととして出る。「整数」「小数」の文も無い: ${(html.match(/[^\n]*(先に決めたいこと|後で決めてよいこと)[^\n]*/g) || []).join(' / ')}`);
  const ap = K.approveC(x);
  assert(ap && ap.ok === true && ap.approval && Object.keys(ap.approval.candidates).join() === 'C1,C2,C3', `B4-6: 承認できる（3 本の候補の hash を結び付ける）: ${JSON.stringify(ap && (ap.ok ? Object.keys(ap.approval.candidates) : ap))}`);
});
await section(async () => {
  //   同じ計画で C3 の生成が未解決（移植元と違う動き）→ 承認できないまま（未解決事項全般を無視していない）
  const { x, gen, v } = await runBranch({ c3: 'fail' });
  const g = (v && v.generated) || {};
  assert(gen.seen.length === 3 && g.C1 && g.C1.status === 'verified' && g.C2 && g.C2.status === 'verified' && g.C3 && g.C3.status === 'unresolved' && g.C3.verdict && g.C3.verdict.kind === 'behavior-fail',
    `B4-7: C3 の模擬テストが不合格 → C3 だけ未解決（C1・C2 は検証済み）: ${JSON.stringify(Object.fromEntries(Object.entries(g).map(([k, e]) => [k, e.status])))}`);
  const f = v && v.final;
  assert(f && f.approvable === false && f.readiness.ready === false && (f.readiness.reasons || []).some(r => r.kind === 'unresolved') && f.questions.length === 1 && f.questions[0].priority === 'later' && K.approveC(x).ok === false,
    `B4-8: 最終案は承認できない（Q1 が later でも、未解決の JavaScript があれば止める）: ${JSON.stringify(f && { approvable: f.approvable, reasons: f.readiness.reasons })}`);
  //   移植元の本文を生成に送れない（条件が分からない）→ C3 は生成を呼ばず準備未完了 → 承認できない
  const ns = await runBranch({ jsFiles: () => JSF({ source: false }) });
  const gn = (ns.v && ns.v.generated) || {};
  assert(ns.gen.seen.map(s => s.cid).join() === 'C1,C2' && gn.C3 && gn.C3.status === 'not-ready' && gn.C3.verdict && gn.C3.verdict.port === true && FS.readyOf(ns.v) === false && (FS.readinessOf(ns.v).reasons || []).some(r => r.kind === 'effects-unknown'),
    `B4-9: 移植元の本文を送れない（条件が分からない）→ C3 の生成を呼ばず準備未完了・承認できない: ${JSON.stringify({ gens: ns.gen.seen.map(s => s.cid), c3: gn.C3 && [gn.C3.status, gn.C3.verdict && gn.C3.verdict.kind], approvable: FS.readyOf(ns.v) })}`);
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
