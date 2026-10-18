// 実機確認（2026-10-09）で見つかった範囲逸脱の回帰（設計 §0f.2・利用者の指示 §5 の表の 1〜3 行目。有料の AI は使わない）
//
// 検証内容:
//   §S0 採用範囲の判定（KTAiConversation.requirementScopeOf。1 つの関数・効果の語彙と結び付きだけ）
//   §S1 仮案の段階: origin ai の保存禁止（利用者の要件に無い効果を足す項目）は任意の提案の節に出て［採用］で入らない。効果を足さない ai の項目は採用に入り、
//        印は「（AI が補足・採用すると入ります）」
//   §S2 計画の応答が未採用の効果を戻す（別 ID の proposed の要件・update で付け替えた要件・fields[].effects の amount [lock, block-save]・items [block-save]）
//        → 生成に渡す必須の効果と customization に block-save が無い・計画（v.plan と v.gatewayPlan）と台帳の両方から外れる。
//        自動の見直し・差分更新で同じ提案が戻っても同じ。委任した設定・必要な実装の手順（ステータスの追加・効果 [] の要件）・C3 の入力チェックの移植の
//        block-save は残る。質問は増えない
//   §S2a 要件の追加なしで計画の fields[].effects だけで未採用の保存禁止を足し直す（出どころの無い範囲外。レビューの指摘 row1）→ 同じく外す
//   §S2q 採用の直後の最初の計画の作成中に受け付けた修正の依頼（差分更新の土台が版になる前の計画。レビューの指摘 row2）→ 土台の計画にも保存禁止は無い
//   §S3 利用者が明示採用した保存禁止（decided）は残る。明細だけを採用したときは明細の保存禁止だけ（金額に広げた保存禁止は外して詳細に出す。(customization, フィールド) 単位の範囲）
//   §S4 範囲外を外した最終案は承認を止めない（詳細に「依頼に無い可能性がある動作」・通常表示には名前で書いた 1 行）
//   §S5 委任の粒度（レビューの指摘 row3）: 判断に結び付いた要件が委任のターンで直されない形・計画の AI が委ねた警告を足す形・推奨の無い委任＋混入した保存禁止
//   §S6 画面: 範囲外を外した customization の生成に渡す requirement の文は、範囲内の要件の文（台帳の値）で組み立てる
//   §S6b 画面: ［残りの JavaScript を作る］（GENERATE_CODE。計画の写しで版を上げる）で作り直した版も、元の版の範囲の記録と生成に渡す requirement の文を引き継ぐ
//        （AI版 scenarios.mjs の前の K-4・2026-10-10。計画の AI は呼ばない）
//   §S7 決定事項の結び付き decisionRefs（設計 §0f.2 の 9・契約 16 §12。前の確認の newProblems の medium）: 印（health の change-planner の requirementOps）がある
//        Gateway では、decisionRefs [] の混入した保存禁止は外す（v.plan・v.gatewayPlan・台帳・生成の必須の効果）。再検証前の指示 §1（2026-10-10）: 採用の時点に
//        その判断の動作の構造が無い（X(D) が空）委任に計画の AI が警告を結び付けても、AI の id だけでは上げず判断の候補（黙って入れない・黙って消さない。通常表示と
//        承認の欄に出す）。印の無い古い Gateway の未実現の委任の間の計画の AI の追加も判断の候補（以前の possible＝外さずに残す扱いの置き換え）。
//        計画の段階の「おすすめで」（推奨を採用・推奨の無い確認事項の委任）でも同じ（reviseWith の delegatedWork の置き換え）。画面の health の印と送る決定事項の印
//   §S8 決定事項の採用を先着順にしない（再検証前の指示 §1・§2・2026-10-10。前の f1b01fa の「先に結び付いた要件だけが実現」をやめた）: 決定事項 D に結び付いた計画の要件は、
//        その (フィールド, 効果) がすべて採用の時点の組 X(D)（仮案の段階で D の key に結び付いた要件の対象と効果）に入るときだけ D の実現として上げる（要件ごとに独立。順序に依存しない）。
//        X(D) に無い効果の結び付きは上げない（planner として判定）。X(D) が空なら AI の id だけでは上げず、D が実現していなければ判断の候補（黙って入れない・黙って消さない。
//        通常表示と承認の欄に一度に出す）。D の実現として残した追加は、通常表示の「仮案からの補足」に対象・動作・理由を出す。
//        (a) 仮案の段階で実現済みの値で答えた決定事項に計画の AI が保存禁止を結び付ける → X(D) に無いので planner として外れる／(b) 構造の無い値で答えた決定事項 → 判断の候補／
//        (c) 構造の無い委任に委ねた警告 → 判断の候補／(d1) 構造のある委任に警告と保存禁止を結び付ける（警告 → 保存禁止・保存禁止 → 警告）→ どちらの順でも警告は残り保存禁止は外れる／
//        (d2) 構造の無い委任（今の S7_SF の素材）に両方を結び付ける → どちらの順でも両方を判断の候補に／(d3) 委ねた警告を PC とモバイルの 2 つの要件で実現 → 両方残る／
//        (d4) 前の確認の K-5（2026-10-10）: 構造のある委任がまだ範囲内の要件で実現されていないとき、計画の AI が委ねた警告と混入した保存禁止をどちらも id を付けずに
//        （decisionRefs []）足す → 警告は X(D) に入るので構造の照合で D の実現（delegated・必須の効果・通常表示の「計画で足した」）、保存禁止は planner として外れる。
//        どちらの順でも同じ・印の無い Gateway でも同じ。D が範囲内の要件で実現済みなら構造の照合はしない（S8-23）
//
//   §S10（2026-10-18）採用内容の欠落の区別: 仮案の id の振り直しで、要件が記録した planRefs（前のターンの id）が別の項目を指しても、台帳の対応だけで採用の範囲を決める。
//        採用した AI の項目の要件を任意の提案と取り違えない・対応の切れた要件は計画に入れず取り消さず「結び付かない提案」として出す・未採用の任意の提案は入れない
//
//   修正前の版（KT_SRC）でも例外で止めずに各 assert を評価する（読み取りの関数が無い版では空の読み取りで落ちる）。§S2 は最初の計画・自動の見直し・差分更新の
//   3 つの section に分けている（前の section が落ちても後の assert を評価する）
//
// 実行方法: node tests/ai-realrun-scope.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
//   簡素化（2026-10-17）: 反映できるかは、最新の版なら会話の今の判定、前の版なら最終案の記録で確かめる（tests/helpers/final-state.js）
const FS = require('./helpers/final-state.js');
const T = loadToolkit();
const { KTAiConversation, KTAiChatUi } = T;
const { assert, state } = makeAssert();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { clone, B, A, Q, req, mkStep, makeGenerate, stripC, finalHtml } = K;
//   2026-10-15（追加の指示 1）: この試験は計画の AI の要件の対応づけ（refs）を台本で決める（偽の計画の AI の自動の対応づけは使わない。実機と同じく対応づけの無い要件は計画の構造で確かめる）
const makeConvC = (o = {}) => K.makeConvC({ autoMap: false, ...o });
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
const LABELS = { ...K.LABELS_C, items: '明細' };
//   レビューの指摘 row2（2026-10-09）: 修正前の版（読み取りの関数・記録が無い）でも例外で止めない読み取り
const EMPTY_SCOPE = { adopted: false, adoption: null, requirements: [], scopeStripped: 0, scopeIssues: 0, stripped: [], possible: [], delegationOpen: null };
const scopeOf = (x, id) => (x && x.c && typeof x.c.requirementScope === 'function' ? x.c.requirementScope(id) : null) || EMPTY_SCOPE;
const inScopeIdsOf = (x, planId) => (typeof x.c.requirementsInScope === 'function' ? x.c.requirementsInScope(planId) : x.c.requirements(planId)).map(q => q.id);
const strippedOf = (v) => (v && Array.isArray(v.scopeStripped) ? v.scopeStripped : []);
const issuesOf = (v) => (v && Array.isArray(v.scopeIssues) ? v.scopeIssues : []);
const possibleOf = (v) => (v && Array.isArray(v.scopePossible) ? v.scopePossible : []);
//   再検証前の指示 §1・§2（2026-10-10）: 判断の候補（v.scopeCandidates）と、最終案の通常表示（折りたたみの詳細を除いた文）
const candidatesOf = (v) => (v && Array.isArray(v.scopeCandidates) ? v.scopeCandidates : []);
const shutOfS = (html) => stripC(String(html).replace(/<details[\s\S]*?<\/details>/g, ''));

// ---- 仮案の台本（実機の 2 会話目を縮めた形）----
const REQ = '承認済みでは金額を変更できなくして。差戻し後は再編集できるように。今ある入力チェックは残して、PCとモバイルの両方で使いたい';
const B_LOCK_U = '「承認済み」では金額を変更できなくする';
const B_BACK_U = '差戻し後は金額を再編集できるようにする';
const B_CHECK_U = '既存の入力チェックを維持し、PC とモバイルの両方で使う';
const B_SAVE_AI = '承認済みの明細の行追加・削除を含む変更は、保存時にも検出して保存を止める';
const B_STATUS_AI = '部長承認用のステータスを 1 つ追加する';
const Q_WARN = Q('lock.warn', '備考の警告', '差戻し後に備考が空のとき警告を出しますか', ['出す', '出さない'], '出す', '差戻し後の入力の案内が変わります', false);
const A_WARN = A('lock.warn', '備考の警告', '差戻し後に備考が空なら警告を出す', '出さないこともできます');
const DELEGATE_U = '備考の警告を出すかは、そちらで決めてください';
const SAVE_TOO_U = '明細の保存も止めてください';
/** 仮案の要件（台帳の id は作った順に R1〜R6） */
const R_LOCK = { target: '金額', condition: '承認済み', behavior: '金額を編集不可にする' };
const R_BACK = { target: '金額', condition: '差戻し後', behavior: '再編集できるようにする' };
const R_CHECK = { target: '入力チェック', condition: '', behavior: '既存の入力チェックを維持し、PCとモバイルの両方で使う' };
const R_SAVE = { target: '明細', condition: '承認済み', behavior: '行追加・削除を含む変更の保存を止める' };
const R_STATUS = { target: 'ステータス', condition: '', behavior: '部長承認用のステータスを 1 つ追加する' };
const R_WARN = { target: '備考', condition: '差戻し後', behavior: '備考が空なら警告を出す' };
const scopeScript = ({ utterance: u, previous: p }) => {
  const behaviors = (saveUser = false) => [B(B_LOCK_U, 'user'), B(B_BACK_U, 'user'), B(B_CHECK_U, 'user'), B(B_SAVE_AI, saveUser ? 'user' : 'ai'), B(B_STATUS_AI, 'ai')];
  const rest = { approach: { standard: ['ステータス「部長承認待ち」の追加'], js: ['承認済みの金額の編集不可（PC・モバイル）'] }, cannot: ['明細の行の追加・削除ボタン自体は止められません'] };
  if (u === REQ) return { reply: '承認済みでは金額を編集不可にし、差戻し後は再編集できるようにします。既存の入力チェックは残します。', intent: 'propose',
    proposal: { behaviors: behaviors(), assumptions: [], decisions: [Q_WARN], ...rest },
    turn: { ops: [], answers: [], requirementOps: [
      req('add', { ...R_LOCK, sourceQuotes: ['承認済みでは金額を変更できなくして'], planRefs: ['B1'], effects: ['lock'] }),
      req('add', { ...R_BACK, sourceQuotes: ['差戻し後は再編集できるように'], planRefs: ['B2'], effects: [] }),
      req('add', { ...R_CHECK, sourceQuotes: ['今ある入力チェックは残して'], planRefs: ['B3'], effects: [] }),
      req('add', { ...R_SAVE, decision: 'proposed', disposition: 'unresolved', sourceQuotes: [], planRefs: ['B4'], effects: ['block-save'] }),
      req('add', { ...R_STATUS, decision: 'proposed', disposition: 'unresolved', sourceQuotes: [], planRefs: ['B5'], effects: [] }),
    ] } };
  if (u === DELEGATE_U) return { reply: '備考の警告は出す形で進めます。', intent: 'update',
    proposal: { behaviors: behaviors(), assumptions: [A_WARN], decisions: [], ...rest },
    turn: { ops: [], answers: [{ id: K.idBy(p && p.decisions, d => d.key === 'lock.warn'), kind: 'delegated', text: '', quote: DELEGATE_U }], requirementOps: [
      req('add', { ...R_WARN, decision: 'proposed', disposition: 'unresolved', sourceQuotes: [], planRefs: ['A1'], effects: ['warn'] }),
    ] } };
  if (u === SAVE_TOO_U) return { reply: '明細の保存も止めます。', intent: 'update',
    proposal: { behaviors: behaviors(true), assumptions: [], decisions: [Q_WARN], ...rest },
    turn: { ops: [{ id: K.idBy(p && p.behaviors, b => b.text === B_SAVE_AI), op: 'adopt', text: '', quote: SAVE_TOO_U }], answers: [], requirementOps: [
      req('update', { id: 'R4', ...R_SAVE, decision: 'decided', sourceQuotes: ['明細の保存も止めて'], planRefs: ['B4'], effects: ['block-save'] }),
    ] } };
  return null;
};

// ---- 計画の偽物（今回混入した形を返す。最初の計画・自動の見直し・差分更新のどれでも同じ未採用の効果を足し直す）----
const ST_OK = 'ステータス in ("承認済み")';
const EV = { desktop: ['app.record.edit.show', 'app.record.edit.submit'], mobile: ['mobile.app.record.edit.show', 'mobile.app.record.edit.submit'] };
const lockCust = (id, platform, { memo = true, events = null } = {}) => ({ customizationId: id, requirement: '承認済みでは金額と明細を編集不可にし、金額・明細の変更を保存時に止める', whyStandardInsufficient: 'ステータスで切り替えるアクセス権は無い', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: [platform], events: events || EV[platform],
  fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: ST_OK, effects: ['lock', 'block-save'] }, { code: 'items', access: 'CONTROL', condition: ST_OK, effects: ['block-save'] }, ...(memo ? [{ code: 'memo', access: 'CONTROL', condition: 'ステータス in ("作成中")', effects: ['warn'] }] : [])],
  apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [] });
const CHECK_CUST = { customizationId: 'C3', requirement: '既存の入力チェックをモバイルへ移植する（同じ判定条件・境界・メッセージ）', whyStandardInsufficient: '入力チェックは JavaScript', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: ['mobile'], events: ['mobile.app.record.create.submit', 'mobile.app.record.edit.submit'], fields: [{ code: 'amount', access: 'CONTROL', condition: '', effects: ['block-save'] }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [] };
/**
 * 計画の応答。ids = この計画の customization（C1・C2・C3）。refs = 要件の振り直し（id → planRefs / effects）。各応答に新しい id の proposed の保存禁止を足す
 *   （saveTarget = その要件の対象。既定は実機の「金額と明細」）。desktopEvents = C1 のイベント（既定は表示と保存）
 */
const contaminatedPlan = (args, { ids = ['C1', 'C2', 'C3'], refs = {}, label = 'x', saveTarget = '金額と明細', desktopEvents = null } = {}) => {
  const custs = ids.map(id => (id === 'C3' ? clone(CHECK_CUST) : lockCust(id, id === 'C2' ? 'mobile' : 'desktop', { memo: ids.includes('C2'), events: id === 'C1' ? desktopEvents : null })));
  const steps = [mkStep('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認待ち', { name: '部長承認待ち' }, { title: 'ステータス「部長承認待ち」を追加' }), ...custs.map(c => ({ id: c.customizationId, actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: null, title: `JavaScript（${c.customizationId}）`, spec: { customizationId: c.customizationId }, dependsOn: [] }))];
  const plan = { goal: args.goal, assessment: { summary: '承認済みでは金額と明細を編集不可にし、行の変更を含む変更は保存時に止める計画です。' }, steps, customizations: clone(custs), provisionals: [], questions: [], unknowns: [], impact: [], solution: 'HYBRID' };
  const sent = new Map((args.requirements || []).map(r => [r.id, r]));
  const upd = (id, base) => { const x = refs[id]; const r = sent.get(id) || { ...base, exceptions: [], decision: 'proposed' }; return { op: 'update', id, target: r.target, condition: r.condition, behavior: r.behavior, exceptions: r.exceptions || [], decision: r.decision === 'revoked' ? 'proposed' : r.decision, disposition: x.disposition || 'adopted', sourceQuotes: [], planRefs: x.planRefs, effects: x.effects, note: x.note || '' }; };
  const BASES = { R1: R_LOCK, R2: R_BACK, R3: R_CHECK, R4: R_SAVE, R5: R_STATUS, R6: R_WARN };
  const ops = [
    ...Object.keys(refs).map(id => upd(id, BASES[id])),
    // 別 ID の proposed の要件（対象は金額と明細・保存禁止。C1・C2 に結び付く）
    { op: 'add', target: saveTarget, condition: '承認済み', behavior: `金額・明細の変更を保存時に止める（${label}）`, exceptions: [], decision: 'proposed', disposition: 'adopted', sourceQuotes: [], planRefs: ids.filter(id => id !== 'C3'), effects: ['block-save'], note: '' },
    // 依頼を実現するための手順（効果 []。計画の AI が足した提案）
    { op: 'add', target: 'プロセス管理', condition: '', behavior: `部長承認待ちへ進むアクションを追加する（${label}）`, exceptions: [], decision: 'proposed', disposition: 'adopted', sourceQuotes: [], planRefs: ['P1'], effects: [], note: '' },
  ];
  return { plan, ctx: null, gatewayPlan: clone(plan), turn: { reply: '明細の行の追加・削除ボタン自体は止められないため、承認済みではセルを編集不可にし、行の変更を含む変更は保存時に検出して止める計画です。', requirementOps: ops, utteranceCoverage: [] },
    //   2026-10-18: 最終案の判定は設定の手順の反映の分類（手順ごとの確認の結果が要る）も見るので、偽の確認の結果にも P1（ステータスの追加）を入れる
    //   （製品の確認はすべての手順を確かめる。前の素材は JavaScript の手順だけで、P1 は「確認の結果が無い」で反映できない手順になる）
    review: { base: { baseVersion: '1', env: 'preview', ok: true, fingerprint: 'fp-1', revision: { preview: '10' } }, steps: [{ stepId: 'P1', status: 'NEEDS_CONFIRMATION', safety: 'REVIEW_REQUIRED', spec: { name: '部長承認待ち' }, diff: { changeType: 'ADD', before: null, after: { name: '部長承認待ち' }, human: ['＋ ステータス「部長承認待ち」'] }, issues: [] }, ...custs.map(c => ({ stepId: c.customizationId, status: 'VALID', safety: 'PLAN_ONLY', customization: clone(c), codeGeneration: { supported: true, strategy: c.strategy, reason: null }, issues: [] }))], executionReadiness: { safeSteps: [], reviewSteps: ['P1'], blockedSteps: [], planOnlySteps: custs.map(c => c.customizationId) }, warnings: [] } };
};
const REFS_MAIN = { R1: { planRefs: ['C1', 'C2'], effects: ['lock'] }, R3: { planRefs: ['C1', 'C2', 'C3'], effects: [] }, R4: { planRefs: ['C1'], effects: ['block-save'] }, R5: { planRefs: ['P1'], effects: [] }, R6: { planRefs: ['C1', 'C2'], effects: ['warn'] } };
/** 生成の偽物の呼び出しを記録（必須の効果と、渡された customization） */
const recordingGenerate = (sequence = ['good']) => {
  const base = makeGenerate({ sequence });
  const seen = [];
  return { calls: base.calls, seen, impl: async (args) => { const c = (args.version.plan.customizations || []).find(x => x.customizationId === args.customizationId) || null; seen.push({ cid: args.customizationId, version: args.version.version, requiredEffects: clone(args.requiredEffects || []), customization: clone(c) }); return base.impl(args); } };
};
const effectsOfCust = (c) => (c && Array.isArray(c.fields) ? c.fields.flatMap(f => (Array.isArray(f.effects) ? f.effects : []).map(e => `${f.code}:${typeof e === 'object' && e ? e.effect : e}`)) : []);
const effKeys = (list) => [...new Set((list || []).map(e => `${e.field}:${e.effect}`))].sort();
const planCalls = [];
/** 計画の偽物（呼ばれた引数を記録して混入した応答を返す） */
const planImplOf = (opts) => (args) => { planCalls.push({ revision: !!args.revision, goal: args.goal, request: args.revision ? args.revision.request : null, requirements: clone(args.requirements || []), decisions: clone(args.decisions || []), previousPlan: args.revision ? clone(args.revision.previousPlan || null) : null }); return contaminatedPlan(args, { ...opts, label: `計画 ${planCalls.length}` }); };

(async () => {
// =========================================================
console.log('\n--- §S0. 採用範囲の判定（requirementScopeOf） ---');
await section(async () => {
  //   修正前の版（関数が無い・possible / noMaterial / eInField を返さない）でも例外で止めず、各 assert を評価する（空の結果で落ちる）
  const scopeFn = typeof KTAiConversation.requirementScopeOf === 'function' ? KTAiConversation.requirementScopeOf : null;
  const requirementScopeOf = (...a) => { const s = scopeFn ? scopeFn(...a) || {} : {}; return { inIds: s.inIds || new Set(), out: s.out || new Map(), eIn: s.eIn || new Map(), undetermined: s.undetermined || new Set(), eInField: s.eInField || null, noMaterial: s.noMaterial || new Map() }; };
  assert(!!scopeFn, 'S0-0: 採用範囲の判定の関数がある（KTAiConversation.requirementScopeOf）');
  const P = { customizations: [{ customizationId: 'C1' }, { customizationId: 'C2' }, { customizationId: 'C3' }] };
  const r = (id, basis, effects, planRefs, decision = 'proposed') => ({ id, decision, planRefs, ...(effects ? { effects } : {}), ...(basis ? { scope: { basis } } : {}) });
  const sc = requirementScopeOf([
    r('R1', 'explicit', ['lock'], ['C1', 'C2'], 'decided'), r('R2', 'item-user', ['warn'], ['C1']), r('R3', 'assumption', ['set-value'], ['C2']), r('R4', 'delegated', ['show-hide'], ['C1']),
    r('R5', 'suggestion', ['block-save'], ['C1']), r('R6', 'item-ai', [], ['P1']), r('R7', 'planner', null, ['P1']), r('R8', 'planner', ['block-save'], ['C1', 'C2']),
    r('R9', 'planner', ['lock'], ['C1']), r('R10', 'planner', ['block-save'], ['C3']), r('R11', 'item-ai', ['block-save'], ['B4']), r('R12', null, ['block-save'], ['C2']),
    { id: 'R13', decision: 'revoked', planRefs: ['C1'], effects: ['block-save'], scope: { basis: 'planner' } },
  ], P);
  assert(['R1', 'R2', 'R3', 'R4'].every(id => sc.inIds.has(id)) && !!sc.out.get('R5') && sc.out.get('R5').reason === 'suggestion', `S0-1: 明示・利用者の項目・前提・委任は中、任意の提案は外: ${JSON.stringify([...sc.out])}`);
  assert(sc.inIds.has('R6') && sc.inIds.has('R7') && sc.inIds.has('R9'), 'S0-2: 実現の手順（効果 []）・効果を持たない古い形・範囲内に同じ効果がある要件は中');
  assert(sc.out.get('R8') && sc.out.get('R8').reason === 'adds-effect' && JSON.stringify(sc.out.get('R8').customizationIds) === JSON.stringify(['C1', 'C2']) && JSON.stringify(sc.out.get('R8').effects) === JSON.stringify(['block-save']) && sc.out.get('R12') && sc.out.get('R12').reason === 'adds-effect', `S0-3: 範囲内の要件に無い効果を足す計画の AI の要件・根拠の無い古い要件（unlinked）は外: ${JSON.stringify([...sc.out])}`);
  assert(sc.undetermined.has('C3') && sc.inIds.has('R10') && sc.inIds.has('R11') && !sc.inIds.has('R13') && !sc.out.has('R13'), 'S0-4: 範囲内の要件に効果が無い customization（C3）に結び付く・customization に結び付かない要件は判定できないので中。取り消し済みは判定しない');
  const sc2 = requirementScopeOf([r('R1', 'explicit', ['lock'], ['C1'], 'decided'), r('R2', 'explicit', ['block-save'], ['C3'], 'decided'), r('R3', 'planner', ['block-save'], ['C1', 'C3'])], P);
  assert(sc2.out.get('R3') && JSON.stringify(sc2.out.get('R3').customizationIds) === JSON.stringify(['C1']) && !!sc2.eIn.get('C3') && sc2.eIn.get('C3').has('block-save'), `S0-5: 範囲内の入力チェック（C3 の block-save）がある customization では足さず、ほかの customization（C1）で足すなら外（外すのは C1 の分だけ）: ${JSON.stringify([...sc2.out])}`);
  const sc3 = requirementScopeOf([r('R1', 'explicit', null, ['C1'], 'decided'), r('R2', 'planner', ['block-save'], ['C1'])], P);
  assert(sc3.undetermined.has('C1') && sc3.inIds.has('R2'), 'S0-6: 範囲内に効果を持たない（古い形の）要件が結び付く customization は判定できない（中に残す）');
  //   レビューの指摘 row3 の 3（2026-10-09）: 範囲内の要件の対象がフィールドに決まるときは (customization, フィールド) の単位。対象のフィールドに無い効果を足す追加は外、
  //   範囲内のどの要件の対象でもないフィールド（テーブルの列など）は customization の単位（同じ効果なら中）。対象が決まらない同じ効果の追加は中で材料にしない
  const PF = { customizations: [{ customizationId: 'C1', fields: [{ code: 'amount' }, { code: 'items' }, { code: 'item_name' }] }] };
  const lab = { amount: '金額', items: '明細', item_name: '品名' };
  const sc4 = requirementScopeOf([r('R1', 'explicit', ['lock'], ['C1'], 'decided'), r('R2', 'explicit', ['block-save'], ['C1'], 'decided'), r('R3', 'planner', ['block-save'], ['C1']), r('R4', 'planner', ['lock'], ['C1']), r('R5', 'planner', ['block-save'], ['C1'])].map((q, i) => ({ ...q, target: ['金額', '明細', '金額', '品名', '金額と明細'][i] })), PF, { labels: lab });
  assert(sc4.eInField && sc4.eInField.get('C1') && JSON.stringify([...sc4.eInField.get('C1').keys()].sort()) === JSON.stringify(['amount', 'items']) && sc4.out.get('R3') && sc4.out.get('R3').reason === 'adds-effect' && sc4.inIds.has('R4') && sc4.inIds.has('R5') && !!sc4.noMaterial.get('C1') && sc4.noMaterial.get('C1').has('R5') && !sc4.noMaterial.get('C1').has('R4'),
    `S0-7: 明細の保存禁止だけを採用した customization では、金額に保存禁止を足す計画の AI の要件（R3）は外・利用者の要件の対象でない列（品名）の編集不可（R4）は中・対象が決まらない同じ効果（R5「金額と明細」）は中で必須の効果の材料にしない: ${JSON.stringify({ out: [...sc4.out], inIds: [...sc4.inIds], noMaterial: [...(sc4.noMaterial.get('C1') || [])] })}`);
  //   再検証前の指示 §1（2026-10-10）: 以前の「委任の実現の可能性」（外さずに範囲内に残す possible）は、判断の候補（範囲外で外す＝黙って入れない・out の reason candidate と
  //   決定事項の見出し＝黙って消さず通常表示に出す）に置き換えた（S0-8・S0-9 の期待を直した）
  const OPEN = [{ id: null, key: 'lock.warn', kind: 'delegated', label: '備考の警告' }];
  const sc5 = requirementScopeOf([r('R1', 'explicit', ['lock'], ['C1'], 'decided'), r('R2', 'planner', ['warn'], ['C1'])], P, { delegationOpen: true, openDecisions: OPEN });
  const c5 = sc5.out.get('R2') || {};
  assert(!sc5.inIds.has('R2') && c5.reason === 'candidate' && c5.via === 'delegation' && JSON.stringify(c5.effects) === '["warn"]' && (c5.decisions || []).length === 1 && c5.decisions[0].label === '備考の警告' && requirementScopeOf([r('R1', 'explicit', ['lock'], ['C1'], 'decided'), r('R2', 'planner', ['warn'], ['C1'])], P).out.get('R2').reason === 'adds-effect',
    `S0-8: 未実現の委任があるとき、E_in に無い効果を足す計画の AI の要件は判断の候補（範囲外。委ねた判断の見出しつき）。無ければ今までどおり範囲外（adds-effect）: ${JSON.stringify([...sc5.out])}`);
  //   §0f.2 の 9（2026-10-09）: 計画の段階の委任は、その版（possibleSince）より後に作った・直した計画の AI の追加だけを判断の候補にする（前の版で外した追加は今までどおり）
  const sc6 = requirementScopeOf([r('R1', 'explicit', ['lock'], ['C1'], 'decided'), { ...r('R2', 'planner', ['block-save'], ['C1']), createdIn: 1, updatedIn: 1 }, { ...r('R3', 'planner', ['warn'], ['C1']), createdIn: 3, updatedIn: 3 }, { ...r('R4', 'planner', ['block-save'], ['C1']), createdIn: 1, updatedIn: 3 }], P, { delegationOpen: true, possibleSince: 3, openDecisions: OPEN });
  const reasons6 = Object.fromEntries([...sc6.out].map(([k, o]) => [k, o.reason]));
  assert(reasons6.R2 === 'adds-effect' && reasons6.R3 === 'candidate' && reasons6.R4 === 'candidate' && !['R2', 'R3', 'R4'].some(id => sc6.inIds.has(id)), `S0-9: 計画の段階の委任（possibleSince 3）: 前の版の追加（R2）は今までどおり範囲外・その版より後に作った・直した追加（R3・R4）だけが判断の候補: ${JSON.stringify(reasons6)}`);
  //   再検証前の指示 §1: 印のある Gateway の判断の候補（candidateLinks: 構造の無い決定事項に計画の AI が結び付けた要件）。結び付いた要件でも E_in に無い効果を足さなければ範囲内のまま
  const sc7 = requirementScopeOf([r('R1', 'explicit', ['lock'], ['C1'], 'decided'), r('R2', 'planner', ['warn'], ['C1']), r('R3', 'planner', ['lock'], ['C1'])], P, { candidateLinks: new Map([['R2', [{ id: 'D1', key: 'lock.warn', kind: 'delegated', label: '備考の警告' }]], ['R3', [{ id: 'D1', key: 'lock.warn', kind: 'delegated', label: '備考の警告' }]]]) });
  const c7 = sc7.out.get('R2') || {};
  assert(c7.reason === 'candidate' && c7.via === 'decisionRefs' && c7.decisions[0].id === 'D1' && sc7.inIds.has('R3') && !sc7.out.has('R3'), `S0-10: 構造の無い決定事項への結び付きだけでは上げない（効果を足すなら判断の候補・足さなければ範囲内のまま）: ${JSON.stringify([...sc7.out])}`);
});

// =========================================================
console.log('\n--- §S1. 仮案の段階: 効果を足す ai の項目は任意の提案の節へ ---');
await section(async () => {
  planCalls.length = 0;
  const x = makeConvC({ scriptFn: scopeScript, labels: LABELS, planImpl: planImplOf({ refs: REFS_MAIN }) });
  await x.c.send(REQ);
  const d = x.c.draft();
  const card = KTAiChatUi.messageHtml(x.c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], { draft: d, draftDecisions: x.c.draftDecisions() });
  //   2026-10-14 の設計し直し: 会話の仮案のカードは AI の返答と選択だけ。動作の一覧（本体・任意の提案・印）は右の「変更内容」の仮案の詳細（S1-3）
  assert(!card.includes(B_SAVE_AI) && !card.includes(B_STATUS_AI) && !card.includes(B_LOCK_U) && !/任意の提案（入れるときは伝えてください）/.test(card) && /承認済みでは金額を編集不可にし、差戻し後は再編集できるようにします。/.test(card) && /data-act="draft-adopt"/.test(card), `S1-1: 会話の仮案のカードは AI の返答と選択だけ（動作の一覧・任意の提案は右の「変更内容」）: ${stripC(card).slice(0, 500)}`);
  assert(!/（AI が補足・採用すると入ります）|（提案）/.test(card), 'S1-2: 会話のカードに動作の印は出ない（印は右のペイン: S1-3）');
  const pane = KTAiChatUi.draftSummaryHtml(d, { decisions: x.c.draftDecisions() });
  const [paneMain, paneSug = ''] = pane.split('任意の提案（入れるときは伝えてください）');
  assert(paneSug.includes(B_SAVE_AI) && !paneMain.includes(B_SAVE_AI) && /（AI が補足・採用すると入ります）/.test(paneMain), 'S1-3: 右のペインの仮案の詳細も同じ分け方');
  const sco = scopeOf(x, d.id);
  const basisOf = (id) => (sco.requirements.find(r => r.id === id) || {}).basis;
  assert(['R1', 'R2', 'R3'].every(id => basisOf(id) === 'explicit') && basisOf('R4') === 'suggestion' && basisOf('R5') === 'item-ai' && sco.requirements.every(r => r.createdBy === 'proposal') && !sco.adopted, `S1-4: 仮案の要件の採用の根拠（明示・任意の提案の扱い・ai の補足）と作った段階: ${JSON.stringify(sco.requirements.map(r => [r.id, r.basis, r.createdBy]))}`);
  const r = await x.c.send('採用します');
  const p0 = planCalls[0] || null;
  assert(r.intent === 'ADOPT_DRAFT' && x.calls.propose.length === 1 && p0 && !p0.goal.includes(B_SAVE_AI) && p0.goal.includes(B_STATUS_AI) && p0.goal.includes(B_LOCK_U), `S1-5: ［採用］の依頼文（採用した方針）に任意の提案の扱いにした保存禁止は入らない（ai の補足は入る）: ${p0 && p0.goal}`);
  assert(!p0.requirements.some(q => q.id === 'R4') && p0.requirements.some(q => q.id === 'R5' && q.decision === 'proposed') && p0.requirements.filter(q => q.decision === 'revoked').length === 0, `S1-6: その要件は計画の AI に渡さない（実現の手順の要件は渡す）: ${JSON.stringify(p0.requirements.map(q => [q.id, q.decision]))}`);
  const sc1 = scopeOf(x);
  assert(sc1.adopted && !!sc1.adoption && sc1.adoption.items.B4 === 'suggestion' && sc1.adoption.items.B5 === 'ai' && sc1.adoption.suggestionItems.includes('B4'), `S1-7: 採用の時点の記録（項目の種類・任意の提案の項目）: ${JSON.stringify(sc1.adoption)}`);
});
// =========================================================
console.log('\n--- §S2. 計画の応答・自動の見直し・差分更新が未採用の保存禁止を戻す ---');
//   レビューの指摘（2026-10-09）: 修正前の版でも自動の見直し・差分更新の assert を評価するため、最初の計画・自動の見直し・差分更新の 3 つの section に分ける
//   （1 つの会話を続けて使う。前の section の値が無ければ、その section の assert は前提なしで落ちる）
const fieldOf = (pl, cid, code) => (((pl && pl.customizations) || []).find(c => c.customizationId === cid) || { fields: [] }).fields.find(f => f.code === code) || {};
const noSave = (pl) => !!pl && ['C1', 'C2'].every(cid => !effectsOfCust((pl.customizations || []).find(c => c.customizationId === cid)).some(k => /block-save/.test(k)));
const S2 = {};
await section(async () => {
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const x = makeConvC({ scriptFn: scopeScript, labels: LABELS, generate: gen, planImpl: planImplOf({ refs: REFS_MAIN }) });
  Object.assign(S2, { x, gen, planCalls });
  await x.c.send(REQ);
  await x.c.send(DELEGATE_U);
  const asksBefore = x.calls.ask.length;
  const r = await x.c.send('採用します');
  const v1 = x.c.activePlan();
  Object.assign(S2, { asksBefore, v1 });
  //   §3（2026-10-17）: 範囲外の効果を外しても、説明を直すためだけの自動の見直し（計画の AI）は呼ばない（以前は 1 回呼んで版 2 を作っていた）。最初の計画の版が最終案になる
  assert(r.intent === 'ADOPT_DRAFT' && planCalls.length === 1 && !planCalls[0].revision && !!v1 && v1.version === 1 && !!v1.final, `S2-0: 採用 → 最初の計画 → 範囲外の効果を外す → 最終案（説明を直すための自動の見直しは無い）: ${JSON.stringify(planCalls.map(p => p.revision))}`);
  if (!v1) { assert(false, 'S2-1: 前提: 最初の計画の版（v1）がある'); return; }
  // 最初の計画の版（v1）: 計画と Gateway の計画の両方から外す。効果の無くなった CONTROL は READ。C3（入力チェックの移植）は残す
  assert(noSave(v1.plan) && noSave(v1.gatewayPlan) && fieldOf(v1.plan, 'C1', 'items').access === 'READ' && fieldOf(v1.gatewayPlan, 'C2', 'items').access === 'READ' && JSON.stringify(fieldOf(v1.plan, 'C1', 'amount').effects) === JSON.stringify(['lock']), `S2-1: 計画の返答の未採用の保存禁止を v.plan と v.gatewayPlan の両方から外す（金額は編集不可だけ・明細は読み取りだけ）: ${JSON.stringify({ c1: effectsOfCust(v1.plan.customizations[0]), gw: effectsOfCust(v1.gatewayPlan.customizations[0]) })}`);
  assert(JSON.stringify(fieldOf(v1.plan, 'C3', 'amount').effects) === JSON.stringify(['block-save']) && JSON.stringify(fieldOf(v1.gatewayPlan, 'C3', 'amount').effects) === JSON.stringify(['block-save']) && v1.plan.steps.length === 4 && v1.plan.customizations.length === 3, 'S2-2: C3（既存の入力チェックの移植）の block-save・手順・customization は消さない');
  assert(JSON.stringify(strippedOf(v1).map(s => `${s.customizationId}:${s.field}:${s.effect}`).sort()) === JSON.stringify(['C1:amount:block-save', 'C1:items:block-save', 'C2:amount:block-save', 'C2:items:block-save']) && strippedOf(v1).every(s => s.requirementIds.includes('R7') && s.reason === 'out-of-scope') && strippedOf(v1).some(s => s.requirementIds.includes('R4')) && issuesOf(v1).map(i => i.customizationId).join() === 'C1,C2', `S2-3: 外した効果と出どころの要件（別 ID の追加 R7・update で付け替えた R4。理由 out-of-scope）を記録: ${JSON.stringify(strippedOf(v1))}`);
  //   レビューの指摘 row1 の D: 生成に渡す customization の requirement の文は、範囲内の結び付く要件の文（台帳の値）で組み立てる（計画の AI の文の「保存時に止める」を渡さない）
  const rq1 = (v1.scopeRequirementText || {}).C1 || '';
  assert(rq1.includes('承認済みでは金額を変更できなくして') && rq1.includes('今ある入力チェックは残して') && !/保存/.test(rq1) && !Object.prototype.hasOwnProperty.call(v1.scopeRequirementText || {}, 'C3'), `S2-5c: 外した customization（C1）の生成に渡す requirement の文は範囲内の要件の文から（外していない C3 は計画の文のまま）: ${rq1}`);
});
await section(async () => {
  //   §S2 の 2 つ目: 最初の計画の版の最終案（最初の計画の section の会話を続けて使う）。
  //   §3（2026-10-17）: 構造と合わなくなりうる計画の AI の説明（要約・JavaScript の要件の文）は現在の確定内容に出さず、右の［詳しく］の「元の説明」に残す（文は直さない）
  const { x, gen, v1, asksBefore } = S2;
  if (!x || !v1 || !v1.final) { assert(false, `S2-4: 前提: 最初の計画の版の最終案がある: ${JSON.stringify({ x: !!x, v1: !!v1 })}`); return; }
  assert(planCalls.length === 1 && x.calls.ask.length === asksBefore && x.calls.propose.length === 2, `S2-4（§3）: 説明を直すための計画の AI の呼び出し・追加の AI の要求は無い: ${JSON.stringify({ plans: planCalls.length, asks: x.calls.ask.length - asksBefore, proposes: x.calls.propose.length })}`);
  const SUMMARY = '承認済みでは金額と明細を編集不可にし、行の変更を含む変更は保存時に止める計画です。';
  const right = KTAiChatUi.changeSummaryHtml(v1, { labels: LABELS });
  const rightOut = shutOfS(right);
  assert(!(v1.final.behaviors || []).some(b => /保存時に止める/.test(b)) && !rightOut.includes(SUMMARY) && !/保存時に止める/.test(rightOut), `S2-5（§3）: 外した動作を書いた計画の AI の要約は、現在の確定内容（最終的にどう動くか・右の通常表示）に出さない: ${JSON.stringify({ behaviors: v1.final.behaviors, right: rightOut.slice(0, 300) })}`);
  assert(/<details class="kt-ai-tech kt-ai-sum-orig"><summary>元の説明（計画の AI）<\/summary>/.test(right) && stripC(right).includes(SUMMARY), 'S2-6（§3）: 元の説明は右の［詳しく］（元の説明）に残す');
  assert(/JavaScript：承認済みでは金額を変更できなくして/.test(rightOut) && !/金額・明細の変更を保存時に止める/.test(rightOut), `S2-7（§3）: 右の JavaScript の行は範囲内の要件の文（生成に渡したもの）: ${(rightOut.match(/JavaScript：[^。]*/g) || []).join(' / ')}`);
  // 生成: 必須の効果と customization に block-save が無い（C1・C2）。委任した警告は残る。C3 の入力チェックの移植は残る
  const genV1 = gen.seen.filter(g => g.version === 1);
  const g1 = genV1.find(g => g.cid === 'C1'), g2 = genV1.find(g => g.cid === 'C2'), g3 = genV1.find(g => g.cid === 'C3');
  assert(g1 && g2 && g3 && JSON.stringify(effKeys(g1.requiredEffects)) === JSON.stringify(['amount:lock', 'memo:warn']) && JSON.stringify(effKeys(g2.requiredEffects)) === JSON.stringify(['amount:lock', 'memo:warn']) && !effectsOfCust(g1.customization).some(k => /block-save/.test(k)) && !effectsOfCust(g2.customization).some(k => /block-save/.test(k)), `S2-8: 生成に渡す必須の効果と customization に未採用の保存禁止が無い（委任した警告は残る）: ${JSON.stringify(genV1.map(g => [g.cid, effKeys(g.requiredEffects)]))}`);
  assert(g3 && JSON.stringify(effKeys(g3.requiredEffects)) === JSON.stringify(['amount:block-save']) && JSON.stringify(effectsOfCust(g3.customization)) === JSON.stringify(['amount:block-save']), `S2-9: C3（既存の入力チェックの移植）の block-save は残る: ${JSON.stringify(g3 && g3.requiredEffects)}`);
  assert(!!g1 && g1.requiredEffects.some(e => e.field === 'memo' && e.effect === 'warn' && (e.requirementIds || []).includes('R6')) && g1.requiredEffects.some(e => e.field === 'amount' && e.effect === 'lock' && (e.requirementIds || []).includes('R1')), `S2-10: 委任した設定（R6・警告）と利用者の編集不可（R1）は要件の id つきで必須の効果に残る: ${JSON.stringify(g1 ? g1.requiredEffects.map(e => [e.field, e.effect, e.requirementIds]) : null)}`);
  // 台帳の読み取り（本文なし）
  const sco = scopeOf(x);
  const row = (id) => sco.requirements.find(q => q.id === id) || {};
  assert(row('R1').basis === 'explicit' && row('R6').basis === 'delegated' && row('R5').basis === 'item-ai' && row('R5').inScope && row('R6').inScope && row('R4').basis === 'suggestion' && !row('R4').inScope && row('R7').basis === 'planner' && row('R7').createdBy === 'plan' && !row('R7').inScope && row('R7').out === 'adds-effect' && row('R8').basis === 'planner' && row('R8').inScope && row('R7').stripped === true && row('R1').stripped === false && sco.scopeStripped === 4 && sco.scopeIssues === 2, `S2-11: 台帳の読み取り（根拠・作った段階・範囲・外したか・外した数）: ${JSON.stringify(sco.requirements.map(q => [q.id, q.decision, q.basis, q.createdBy, q.inScope, q.out, q.stripped]))}`);
  assert(!JSON.stringify(sco).includes(R_SAVE.behavior) && !JSON.stringify(sco).includes(REQ), 'S2-12: 読み取りは本文（要件の文・利用者の発言）を返さない');
  const ids = inScopeIdsOf(x, v1.planId);
  assert(!ids.includes('R4') && !ids.includes('R7') && ['R1', 'R2', 'R3', 'R5', 'R6', 'R8'].every(id => ids.includes(id)), `S2-13: 生成の「満たすべき要件」（画面の requirementIds）に使う範囲内の要件: ${ids.join(',')}`);
  // 最終案: 範囲外の要件を「担当が計画にありません」に出さない。詳細に「依頼に無い可能性がある動作」
  const html = finalHtml(x);
  assert(!JSON.stringify((v1.final || {}).outOfScope || []).includes('保存を止める') && /依頼に無い可能性がある動作（2 件）/.test(html) && /<details class="kt-ai-tech kt-ai-final-scope-out"/.test(html) && /「金額」を保存を止める/.test(stripC(html)), `S2-14: 最終案は範囲外の要件を担当なしに出さず、詳細に外した動作を出す: ${(stripC(html).match(/依頼に無い可能性[\s\S]{0,200}/) || [''])[0]}`);
  // 質問が増えない
  assert(x.calls.ask.length === asksBefore && x.calls.propose.length === 2 && !(v1.openQuestions || []).length && !x.c.messages().some(m => m.data && /question/.test(String(m.data.kind || ''))), 'S2-15: 範囲外の保存禁止を利用者に断らせない（質問・仮案の作り直しを増やさない）');
});
await section(async () => {
  //   §S2 の 3 つ目: 利用者の修正による差分更新（同じ会話を続けて使う）。§3: 計画の AI を呼ぶのは利用者の修正の 1 回だけ（説明を直すための自動の見直しは無い）
  const { x, gen, asksBefore } = S2;
  if (!x || !x.c.activePlan()) { assert(false, 'S2-16: 前提: 差分更新する最終案がある'); return; }
  const genBefore = gen.seen.length;
  const plansBefore = planCalls.length;
  await x.c.send('警告の文は「備考を入力してください」にして');
  const v2 = x.c.activePlan();
  const p1 = planCalls[plansBefore] || { revision: false, request: '', requirements: [], previousPlan: null, goal: null };
  assert(planCalls.length === 2 && p1.revision && !/外してください/.test(p1.request) && v2.version === 2 && noSave(v2.plan) && noSave(v2.gatewayPlan) && strippedOf(v2).length === 4 && strippedOf(v2).every(s => s.requirementIds.includes('R9')), `S2-16: 差分更新で戻った保存禁止（別 ID の R9）も外す（説明を直すための依頼は無い）: ${JSON.stringify({ plans: planCalls.length, stripped: strippedOf(v2) })}`);
  const sentOf = (id) => (p1.requirements.find(q => q.id === id) || null);
  assert(sentOf('R7') && sentOf('R7').decision === 'revoked' && !sentOf('R4') && sentOf('R5') && sentOf('R5').decision === 'proposed' && sentOf('R6') && sentOf('R6').decision === 'proposed' && sentOf('R8') && sentOf('R8').decision === 'proposed' && sentOf('R1').decision === 'decided' && noSaveIn(p1.previousPlan) && JSON.stringify(fieldOf(p1.previousPlan, 'C3', 'amount').effects) === JSON.stringify(['block-save']),
    `S2-17: 差分更新に送る要件: 範囲外の追加は revoked・任意の提案の扱いは渡さない・委任した設定と実現の手順はそのまま。土台の計画にも未採用の保存禁止は無い（C3 の入力チェックは残る）: ${JSON.stringify(p1.requirements.map(q => [q.id, q.decision]))}`);
  const genV2 = gen.seen.slice(genBefore);
  assert(genV2.every(g => g.cid === 'C3' || !g.requiredEffects.some(e => e.effect === 'block-save')) && genV2.every(g => !effectsOfCust(g.customization).some(k => /^(amount|items):block-save$/.test(k)) || g.cid === 'C3') && JSON.stringify(effKeys(((x.c.activePlan().generated || {}).C1 || {}).requiredEffects)) === JSON.stringify(['amount:lock', 'memo:warn']) && JSON.stringify(effKeys(((x.c.activePlan().generated || {}).C3 || {}).requiredEffects)) === JSON.stringify(['amount:block-save']), `S2-18: 差分更新の後の生成（作り直し・流用）でも必須の効果に未採用の保存禁止が無い: ${JSON.stringify(genV2.map(g => [g.cid, effKeys(g.requiredEffects)]))}`);
  assert(x.calls.ask.length === asksBefore && x.calls.propose.length === 2 && !(v2.openQuestions || []).length && v2.goalSent === planCalls[0].goal && p1.goal === planCalls[0].goal, 'S2-19: 差分更新でも質問は増えない・送る goal は Toolkit が最初に送ったもの');
  const right2 = shutOfS(KTAiChatUi.changeSummaryHtml(v2, { labels: LABELS }));
  assert(!(v2.final.behaviors || []).some(b => /保存時に止める/.test(b)) && !/保存時に止める/.test(right2), `S2-20（§3）: 差分更新の版でも、外した動作を書いた計画の AI の説明は現在の確定内容に出さない: ${right2.slice(0, 200)}`);
});
function noSaveIn(pl) { return !!pl && (pl.customizations || []).filter(c => c.customizationId !== 'C3').every(c => !effectsOfCust(c).some(k => /block-save/.test(k))); }

// =========================================================
console.log('\n--- §S2c. 利用者の要件の対象が 1 つのフィールドに付け替えられても、同じ要件の列の効果は外さない ---');
await section(async () => {
  //   計画の AI が利用者の要件の target を計画のフィールドの名前（「金額」）に付け替え、明細の列（品名・数量）も編集不可にする（実機の CX-1 と同じ形）。
  //   列は範囲内のどの要件の対象でもないので customization の単位で比べる（編集不可は利用者の要件の効果）。未採用の保存禁止だけを外す
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const COLS = [{ code: 'item_name', access: 'CONTROL', condition: ST_OK, effects: ['lock'] }, { code: 'qty', access: 'CONTROL', condition: ST_OK, effects: ['lock'] }];
  const withCols = (args) => { const r = planImplOf({ refs: REFS_MAIN })(args); for (const pl of [r.plan, r.gatewayPlan]) for (const c of pl.customizations) if (c.customizationId !== 'C3') c.fields.push(...clone(COLS)); return r; };
  const x = makeConvC({ scriptFn: scopeScript, labels: { ...LABELS, item_name: '品名', qty: '数量' }, generate: gen, planImpl: withCols });
  await x.c.send(REQ);
  await x.c.send(DELEGATE_U);
  await x.c.send('採用します');
  const v = x.c.activePlan();
  const g1 = gen.seen.filter(g => g.cid === 'C1' && g.version === v.version)[0];
  assert(!strippedOf(v).some(st => st.effect === 'lock') && strippedOf(v).every(st => st.effect === 'block-save') && g1 && ['amount:lock', 'item_name:lock', 'qty:lock', 'memo:warn'].every(k => effKeys(g1.requiredEffects).includes(k)) && !effKeys(g1.requiredEffects).some(k => /block-save/.test(k)), `S2c-1: 列（品名・数量）の編集不可は外さず必須の効果に残る。外すのは未採用の保存禁止だけ: ${JSON.stringify({ stripped: strippedOf(v).map(st => `${st.customizationId}:${st.field}:${st.effect}`), req: g1 && effKeys(g1.requiredEffects) })}`);
});

// =========================================================
console.log('\n--- §S2a. 要件の追加なしで計画の fields[].effects だけで保存禁止を足し直す（出どころの無い範囲外） ---');
await section(async () => {
  //   レビューの指摘 row1（2026-10-09）: 計画の応答の requirementOps に保存禁止の追加が無く、R4 も付け替えない（R1・R3・R5・R6 の update だけ）。
  //   fields は今と同じく amount [lock, block-save]・items [block-save]。C1・C2 は範囲内の要件（R1 lock・R6 warn）で判定できる
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const refs = { R1: REFS_MAIN.R1, R3: REFS_MAIN.R3, R5: REFS_MAIN.R5, R6: REFS_MAIN.R6 };
  const fieldsOnly = (args) => { planCalls.push({ revision: !!args.revision, goal: args.goal, request: args.revision ? args.revision.request : null, requirements: clone(args.requirements || []), previousPlan: args.revision ? clone(args.revision.previousPlan || null) : null }); const r = contaminatedPlan(args, { refs, label: `計画 ${planCalls.length}` }); r.turn.requirementOps = r.turn.requirementOps.filter(op => !(op.op === 'add' && (op.effects || []).includes('block-save'))); return r; };
  const x = makeConvC({ scriptFn: scopeScript, labels: LABELS, generate: gen, planImpl: fieldsOnly });
  await x.c.send(REQ);
  await x.c.send(DELEGATE_U);
  const asksBefore = x.calls.ask.length;
  await x.c.send('採用します');
  const v = x.c.activePlan();
  const v1 = x.c.planHistory().find(z => z.planId === v.planId && z.version === 1) || v;
  const keys = (vv) => strippedOf(vv).map(st => `${st.customizationId}:${st.field}:${st.effect}`).sort();
  const noSaveC12 = (pl) => !!pl && ['C1', 'C2'].every(cid => !effectsOfCust((pl.customizations || []).find(c => c.customizationId === cid)).some(k => /block-save/.test(k)));
  assert(JSON.stringify(keys(v1)) === JSON.stringify(['C1:amount:block-save', 'C1:items:block-save', 'C2:amount:block-save', 'C2:items:block-save']) && strippedOf(v1).every(st => st.reason === 'unattributed' && Array.isArray(st.requirementIds) && !st.requirementIds.length) && noSaveC12(v1.plan) && noSaveC12(v1.gatewayPlan), `S2a-1: 範囲内・範囲外のどの要件の効果でもない保存禁止（計画の fields[].effects だけ）も v.plan と v.gatewayPlan から外し、理由 unattributed・要件の id なしで記録: ${JSON.stringify(strippedOf(v1))}`);
  const c3 = ((v1.plan.customizations || []).find(c => c.customizationId === 'C3') || {});
  assert(effectsOfCust(c3).includes('amount:block-save') && issuesOf(v1).filter(i => i.kind !== 'delegation').map(i => i.customizationId).join() === 'C1,C2', 'S2a-2: 判定できない customization（C3 の入力チェックの移植）は外さない。外した C1・C2 は説明に残りうる customization（scopeIssues。§3 で自動の見直しの対象にはしない）');
  //   §3（2026-10-17）: 根拠の要件が無い効果を外しても、説明を直すための自動の見直し（計画の AI）は呼ばない（以前は同じ 1 回の見直しで「外す」と依頼していた）
  assert(planCalls.length === 1 && !planCalls[0].revision, `S2a-3（§3）: 根拠の要件が無い効果を外した後も、計画の AI は最初の 1 回だけ: ${JSON.stringify(planCalls.map(p => p.revision))}`);
  const gl = gen.seen.filter(g => g.version === v.version);
  assert(['C1', 'C2'].every(cid => { const g = gl.find(z => z.cid === cid); return g && JSON.stringify(effKeys(g.requiredEffects)) === JSON.stringify(['amount:lock', 'memo:warn']) && !effectsOfCust(g.customization).some(k => /block-save/.test(k)); }), `S2a-4: 生成の必須の効果と customization に保存禁止が無い（委任した警告と利用者の編集不可は残る）: ${JSON.stringify(gl.map(g => [g.cid, effKeys(g.requiredEffects)]))}`);
  assert(x.calls.ask.length === asksBefore && x.calls.propose.length === 2 && !(v.openQuestions || []).length && scopeOf(x).stripped.every(st => st.reason === 'unattributed'), 'S2a-5: 質問は増えない・採用範囲の読み取りに外した理由（unattributed）');
});

// =========================================================
console.log('\n--- §S2q. 最初の計画の作成中に受け付けた修正の依頼（土台は版になる前の計画） ---');
await section(async () => {
  //   レビューの指摘 row2（2026-10-09）: 採用の直後の最初の計画の作成中に修正の依頼を受け付けると、版にする前の最初の計画を土台に差分更新する。
  //   その土台（revision.previousPlan）にも、registerPlan と同じ外し方を当てる
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const pg = K.gate();
  const x = makeConvC({ scriptFn: scopeScript, labels: LABELS, generate: gen, planGate: pg, planImpl: planImplOf({ refs: REFS_MAIN }) });
  await x.c.send(REQ);
  await x.c.send(DELEGATE_U);
  const pA = x.c.send('採用します');
  await K.ticks(10);
  const pB = x.c.send('警告の文は「備考を入力してください」にして');
  await K.ticks(10);
  pg.open();
  await pA; await pB; await K.ticks(30);
  const v = x.c.activePlan();
  const q = planCalls.find(pc => pc.revision && pc.request && /備考を入力してください/.test(pc.request)) || null;
  assert(!!q && !planCalls[0].revision, `S2q-1: 受け付けた修正の依頼は、最初の計画を土台にした差分更新として送られた: ${JSON.stringify(planCalls.map(pc => [pc.revision, (pc.request || '').slice(0, 30)]))}`);
  assert(!!q && noSaveIn(q.previousPlan) && JSON.stringify(((q.previousPlan.customizations || []).find(c => c.customizationId === 'C3') || {}).fields.find(f => f.code === 'amount').effects) === JSON.stringify(['block-save']), `S2q-2: その差分更新の土台の計画（previousPlan）にも未採用の保存禁止は無い（C3 の入力チェックは残る）: ${JSON.stringify(q && (q.previousPlan.customizations || []).map(c => [c.customizationId, effectsOfCust(c)]))}`);
  assert(!!q && (q.requirements.find(rr => rr.id === 'R7') || {}).decision === 'revoked' && v && ['C1', 'C2'].every(cid => !effectsOfCust((v.plan.customizations || []).find(c => c.customizationId === cid)).some(k => /block-save/.test(k))) && gen.seen.filter(g => g.cid !== 'C3').every(g => !g.requiredEffects.some(e => e.effect === 'block-save')), 'S2q-3: 範囲外の追加（R7）は revoked で送り、できた版の計画と生成の必須の効果に未採用の保存禁止は無い');
});

// =========================================================
console.log('\n--- §S3. 利用者が明示採用した保存禁止は残る ---');
await section(async () => {
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const refs = { R1: REFS_MAIN.R1, R3: REFS_MAIN.R3, R4: { planRefs: ['C1', 'C2'], effects: ['block-save'] }, R5: REFS_MAIN.R5 };
  //   計画の AI が同じ保存禁止を足す要件の対象は「明細」（計画のフィールドに決まる。対象が決まらない要件の自動の見直しはこの確認の範囲外）
  const x = makeConvC({ scriptFn: scopeScript, labels: LABELS, generate: gen, planImpl: planImplOf({ refs, saveTarget: '明細' }) });
  await x.c.send(REQ);
  await x.c.send(SAVE_TOO_U);
  const d = x.c.draft();
  const card = KTAiChatUi.messageHtml(x.c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], { draft: d, draftDecisions: x.c.draftDecisions() });
  //   2026-10-14 の設計し直し: 動作の一覧は右の仮案の詳細で確かめる（会話のカードには出ない）
  const pane3 = KTAiChatUi.draftSummaryHtml(d, { decisions: x.c.draftDecisions() });
  assert(!/任意の提案（入れるときは伝えてください）/.test(pane3) && pane3.includes(B_SAVE_AI) && !card.includes(B_SAVE_AI) && (scopeOf(x, d.id).requirements.find(q => q.id === 'R4') || {}).basis === 'explicit', 'S3-1: 「明細の保存も止めて」で採用した保存禁止は利用者の要件（explicit）になり、右の仮案の詳細の本体に出る');
  await x.c.send('採用します');
  const v = x.c.activePlan();
  const v1 = x.c.planHistory().find(z => z.planId === v.planId && z.version === 1) || v;
  //   レビューの指摘 row3 の 3（2026-10-09）: 利用者が採用したのは「明細の保存も止めて」（R4 の対象は明細）。金額の保存禁止と、答えていない判断の警告（memo）は
  //   どの採用した要件でも説明できないので外す（(customization, フィールド) 単位の範囲）。明細の保存禁止は外さない
  const keysOf = (vv) => strippedOf(vv).map(s => `${s.customizationId}:${s.field}:${s.effect}`).sort();
  assert(planCalls[0].goal.includes(B_SAVE_AI) && planCalls[0].requirements.some(q => q.id === 'R4' && q.decision === 'decided') && !strippedOf(v1).some(s => s.field === 'items') && JSON.stringify(keysOf(v1)) === JSON.stringify(['C1:amount:block-save', 'C1:memo:warn', 'C2:amount:block-save', 'C2:memo:warn']) && strippedOf(v1).every(s => s.reason === 'unattributed' && !s.requirementIds.length), `S3-2: 依頼文・計画の AI に渡す要件に入り、明細の保存禁止は計画の返答から外さない（外すのは採用した要件で説明できない金額の保存禁止と答えていない警告だけ）: ${JSON.stringify({ stripped: keysOf(v1), plans: planCalls.length })}`);
  const g1 = gen.seen.filter(g => g.cid === 'C1').slice(-1)[0];
  assert(g1 && effKeys(g1.requiredEffects).includes('items:block-save') && !effKeys(g1.requiredEffects).includes('amount:block-save') && effKeys(g1.requiredEffects).includes('amount:lock') && g1.requiredEffects.some(e => e.field === 'items' && e.effect === 'block-save' && (e.requirementIds || []).includes('R4')), `S3-3: 生成の必須の効果に利用者が採用した明細の保存禁止（R4）が残り、金額の保存禁止は無い: ${JSON.stringify(g1 && effKeys(g1.requiredEffects))}`);
  assert((scopeOf(x).requirements.find(q => q.id === 'R7') || {}).inScope === true, 'S3-4: 同じ効果を同じ対象（明細）に足す計画の AI の要件も範囲内（利用者の保存禁止と同じ効果）');
  const html = finalHtml(x);
  //   偽の生成工程の候補（good）は金額の編集不可だけを作るので、明細の保存禁止の検証は要件未達になる（承認の可否はこの確認の範囲外）
  assert(/依頼に無い可能性がある動作/.test(html) && /「金額」を保存を止める/.test(stripC(html)) && v.final && /依頼に無い「金額の保存の停止」「備考の警告」は入れていません（詳細）/.test(stripC(html.replace(/<details[\s\S]*?<\/details>/g, ''))) && gen.seen.filter(g => g.cid !== 'C3').every(g => !effKeys(g.requiredEffects).includes('amount:block-save')), `S3-5: 外した金額の保存禁止（と答えていない警告）は最終案の詳細と通常表示の名前の 1 行に出す（C1・C2 の必須の動作には入れない）: ${(stripC(html).match(/依頼に無い可能性[\s\S]{0,160}/) || [''])[0]}`);
});
await section(async () => {
  //   レビューの指摘 row3 の 3: 計画の AI の保存禁止の対象を実機の形「金額と明細」（計画のフィールドに決まらない）にした変形。利用者が採用したのは明細の保存禁止だけ
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const refs = { R1: REFS_MAIN.R1, R3: REFS_MAIN.R3, R4: { planRefs: ['C1', 'C2'], effects: ['block-save'] }, R5: REFS_MAIN.R5 };
  const x = makeConvC({ scriptFn: scopeScript, labels: LABELS, generate: gen, planImpl: planImplOf({ refs }) });
  await x.c.send(REQ);
  await x.c.send(SAVE_TOO_U);
  await x.c.send('採用します');
  const v = x.c.activePlan();
  const g1 = gen.seen.filter(g => g.cid === 'C1').slice(-1)[0];
  const r7 = scopeOf(x).requirements.find(q => q.id === 'R7') || {};
  assert(v.generated && v.generated.C1 && v.generated.C1.status !== 'not-ready' && !(v.generated.C1.verdict && v.generated.C1.verdict.kind === 'effects-unknown') && g1 && effKeys(g1.requiredEffects).includes('items:block-save') && !effKeys(g1.requiredEffects).includes('amount:block-save') && !g1.requiredEffects.some(e => (e.requirementIds || []).includes('R7')), `S3-6: 対象が決まらない計画の AI の保存禁止（R7「金額と明細」）は、範囲内でも必須の効果の材料にしない（target-unresolved で準備未完了にしない）。明細の保存禁止（R4）は残る: ${JSON.stringify({ st: v.generated && v.generated.C1 && v.generated.C1.status, req: g1 && effKeys(g1.requiredEffects), verdict: v.generated && v.generated.C1 && v.generated.C1.verdict && v.generated.C1.verdict.reason })}`);
  assert(r7.inScope === true && strippedOf(v).some(s => s.field === 'amount' && s.effect === 'block-save') && !strippedOf(v).some(s => s.field === 'items') && v.final && !(FS.readinessOf(v) && (FS.readinessOf(v).reasons || []).some(x => /特定できません/.test(String(x.text || '')))) && x.calls.ask.length === 0 && planCalls.length === 1, `S3-7: 金額に広げた保存禁止は外して詳細に出す。必須の動作を特定できない理由は出ない・質問は増えない・自動の見直しは 1 回だけ: ${JSON.stringify({ stripped: strippedOf(v).map(s => `${s.customizationId}:${s.field}:${s.effect}`), reasons: v.final && FS.readinessOf(v) && FS.readinessOf(v).reasons, plans: planCalls.length })}`);
});

// =========================================================
console.log('\n--- §S4. 範囲外を外した最終案は承認を止めない ---');
await section(async () => {
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  //   C1 のイベントは表示だけ（偽の生成工程の候補は表示のイベントだけを登録する）
  //   2026-10-15（追加の指示 1）: この計画（PC の JavaScript だけ）は既存の入力チェックの要件（R3。PC とモバイル）を実現しないので、計画の AI はその要件を
  //   対応できない（unsupported）と理由つきで示す（採用の記録だけで担当ありにしない・PC の JavaScript への対応づけだけではモバイルが足りず反映を止める）。
  //   この節は範囲外を外したことで承認を止めないことを確かめる）
  const x = makeConvC({ scriptFn: scopeScript, labels: LABELS, generate: gen, planImpl: planImplOf({ ids: ['C1'], desktopEvents: ['app.record.edit.show'], refs: { R1: { planRefs: ['C1'], effects: ['lock'] }, R3: { planRefs: [], effects: [], disposition: 'unsupported', note: 'この計画は PC の編集制御だけで、入力チェックのモバイルへの移植を含まないため' }, R4: { planRefs: ['C1'], effects: ['block-save'] }, R5: { planRefs: ['P1'], effects: [] } } }) });
  await x.c.send(REQ);
  await x.c.send('採用します');
  const v = x.c.activePlan();
  assert(planCalls.length === 1 && strippedOf(v).length === 2 && v.generated?.C1?.status === 'verified' && v.final?.approvable === true && x.c.approveFinal(K.approveArgs(v)).ok === true, `S4-1: 範囲外を外した最終案は、ほかに理由が無ければ承認できる（依頼に無い可能性がある動作は承認を止めない）: ${JSON.stringify({ stripped: strippedOf(v).length, status: v.generated?.C1?.status, reasons: v.final?.readiness, blockers: (v.final?.blockers || []).map(b => b.text) })}`);
  assert(JSON.stringify(effKeys((gen.seen.slice(-1)[0] || {}).requiredEffects)) === JSON.stringify(['amount:lock']), 'S4-2: 必須の効果は利用者の編集不可だけ');
  const html = finalHtml(x);
  assert(/依頼に無い可能性がある動作（2 件）/.test(html) && /計画の AI の元の説明（右の「変更内容」の［詳しく］）には残っていることがあります/.test(html) && !/依頼に無い可能性/.test(html.replace(/<details[\s\S]*?<\/details>/g, '')), 'S4-3: 「依頼に無い可能性がある動作」は詳細（折りたたみ）の中だけに出す');
  //   レビューの指摘 row1 の D: 通常表示の「最終的にどう動くか」の近くに、名前で書いた短い 1 行（計画の説明の文が外した動作を言っていても、入れていないと分かる）
  const outside = stripC(html.replace(/<details[\s\S]*?<\/details>/g, ''));
  const iBeh = outside.indexOf('仮案からの補足'), iNote = outside.indexOf('依頼に無い「金額・明細の保存の停止」は入れていません（詳細）'), iChanged = outside.indexOf('動作テスト環境へ反映');   // 2026-10-14: 範囲外の通知は「仮案からの補足」
  assert(iBeh >= 0 && iNote > iBeh && (iChanged < 0 || iNote < iChanged) && !/block-save|\bamount\b|\bitems\b/.test(outside.slice(iNote, iNote + 60)), `S4-4（2026-10-14: 「仮案からの補足」に）: 通常表示の「仮案からの補足」の中に「依頼に無い「金額・明細の保存の停止」は入れていません（詳細）」（フィールドは名前・効果は画面の言葉）: ${outside.slice(Math.max(0, iBeh), iBeh + 300)}`);
});

// =========================================================
console.log('\n--- §S5. 委任の粒度（判断に結び付いた要件・計画の AI が委ねた設定を足す・推奨の無い委任＋混入した保存禁止） ---');
const WARN_PLAN_OP = { op: 'add', target: '備考', condition: '差戻し後', behavior: '備考が空なら警告を出す', exceptions: [], decision: 'proposed', disposition: 'adopted', sourceQuotes: [], planRefs: ['C1', 'C2'], effects: ['warn'], note: '' };
await section(async () => {
  //   C1: 1 回目の仮案で、警告の要件（undecided・warn）が判断 Q1（key lock.warn）に結び付く。委任のターンでは要件を直さない（requirementOps []）。
  //   委任のターンの仮案では判断が前提 A1（同じ key）に変わる → 同じ key でつないで要件を引き継ぎ、根拠は delegated
  planCalls.length = 0;
  const R_WARN_Q = { ...R_WARN, decision: 'undecided', disposition: 'unresolved', sourceQuotes: [], planRefs: ['Q1'], effects: ['warn'] };
  const sf = (args) => { const r = scopeScript(args); if (!r) return r; if (args.utterance === REQ) r.turn.requirementOps = [...r.turn.requirementOps, req('add', R_WARN_Q)]; if (args.utterance === DELEGATE_U) r.turn.requirementOps = []; return r; };
  const gen = recordingGenerate(['good']);
  const x = makeConvC({ scriptFn: sf, labels: LABELS, generate: gen, planImpl: planImplOf({ refs: { ...REFS_MAIN, R6: { planRefs: ['C1', 'C2'], effects: ['warn'] } } }) });
  await x.c.send(REQ); await x.c.send(DELEGATE_U);
  const asks = x.calls.ask.length;
  await x.c.send('採用します');
  const v = x.c.activePlan();
  const sco = scopeOf(x);
  const r6 = sco.requirements.find(q => q.id === 'R6') || {};
  const g1 = gen.seen.filter(g => g.cid === 'C1' && g.version === v.version)[0];
  assert(r6.basis === 'delegated' && r6.inScope === true && !strippedOf(v).some(st => st.effect === 'warn') && g1 && effKeys(g1.requiredEffects).includes('memo:warn') && !effKeys(g1.requiredEffects).some(k => /block-save/.test(k)), `S5-1: 判断に結び付いた警告の要件は、判断が前提に変わっても同じ key で引き継ぎ delegated（範囲内）。委ねた警告は必須の効果に残り、混入した保存禁止は外れる: ${JSON.stringify({ r6: [r6.basis, r6.inScope], stripped: strippedOf(v).map(st => `${st.customizationId}:${st.field}:${st.effect}`), req: g1 && effKeys(g1.requiredEffects) })}`);
  assert(x.calls.ask.length === asks && x.calls.propose.length === 2 && sco.delegationOpen === false && !possibleOf(v).length, 'S5-2: 質問は増えない・委任は実現済み（結び付く要件がある）なので委任の実現の可能性の扱いは無い');
});
await section(async () => {
  //   C2: 委任のターンで要件を作らない（既定の台本の「おすすめで」と同じ）。計画の AI が委ねられた警告を proposed（warn・C1/C2）で足す（印の無い Gateway）。
  //   再検証前の指示 §1（2026-10-10）: 未実現の委任の間の計画の AI の追加は、構造では委任の実現と確かめられないので、判断の候補（黙って入れない・黙って消さない）。
  //   以前の期待（外さずに必須の効果に残し、詳細だけに出す）を直した（S5-3〜S5-5）
  planCalls.length = 0;
  const sf = (args) => { const r = scopeScript(args); if (!r) return r; if (args.utterance === DELEGATE_U) r.turn.requirementOps = []; return r; };
  const gen = recordingGenerate(['good']);
  const pi = (args) => { const r = planImplOf({ refs: { R1: REFS_MAIN.R1, R3: REFS_MAIN.R3, R4: REFS_MAIN.R4, R5: REFS_MAIN.R5 } })(args); if (!args.revision) r.turn.requirementOps = [...r.turn.requirementOps, WARN_PLAN_OP]; return r; };
  const x = makeConvC({ scriptFn: sf, labels: LABELS, generate: gen, planImpl: pi });
  await x.c.send(REQ); await x.c.send(DELEGATE_U);
  const asks = x.calls.ask.length;
  await x.c.send('採用します');
  const v = x.c.activePlan();
  const sco = scopeOf(x);
  const warnReq = sco.requirements.find(q => q.createdBy === 'plan' && (q.effects || []).includes('warn')) || {};
  const g1 = gen.seen.filter(g => g.cid === 'C1' && g.version === v.version)[0];
  assert(sco.delegationOpen === true && warnReq.basis === 'planner' && warnReq.inScope === false && warnReq.out === 'candidate' && (warnReq.candidate || {}).via === 'delegation' && g1 && !g1.requiredEffects.some(e => e.effect === 'warn') && strippedOf(v).some(st => st.field === 'memo' && st.effect === 'warn' && st.reason === 'candidate'),
    `S5-3: 委ねた警告（計画の AI が proposed で足した・印の無い Gateway）は判断の候補（黙って必須の効果に入れない・計画から外す）: ${JSON.stringify({ open: sco.delegationOpen, warn: [warnReq.id, warnReq.basis, warnReq.inScope, warnReq.out, warnReq.candidate], req: g1 && g1.requiredEffects.map(e => [e.field, e.effect]) })}`);
  const html = finalHtml(x), shut = shutOfS(html);
  const cand = (shut.match(/判断が残っています[\s\S]{0,400}/) || [''])[0];
  assert(/おまかせにした「備考の警告」は、計画の案と結び付けを確かめられないため、まだ入れていません。計画の案: [^。]*「備考」に警告を出す/.test(cand) && /入れるものを伝えてください/.test(cand) && !/委ねた判断を実現するために計画が足した可能性がある動作/.test(html) && issuesOf(v).some(i => i.kind === 'candidate') && x.calls.ask.length === asks && planCalls.length <= 2,
    `S5-4: 最終案の通常表示（仮案からの補足）に判断が残っていることを一度に示す（委ねた判断の見出し・計画の案・入れるものを伝える）。質問は増えない・自動の見直しは既存の上限の中: ${cand.slice(0, 300)}`);
  //   未実現の委任の間は、計画の AI が足した保存禁止も構造だけでは委任の実現と区別できない（黙って必須にせず、黙って消さずに判断の候補に出す）
  assert(g1 && !g1.requiredEffects.some(e => e.effect === 'block-save') && /「金額」「明細」の保存を止める/.test(cand), `S5-5: 未実現の委任の間に計画の AI が足した保存禁止も判断の候補（必須の効果に入れない・通常表示に計画の案として出す）: ${cand.slice(0, 300)}`);
});
await section(async () => {
  //   C3: 推奨の無い判断（Q_WARN の推奨を空にした）を委ねて採用。委任のターンで警告の要件（A1 に結び付く）を足す＝委任は実現済み。
  //   混入した保存禁止（別 ID の R7）は計画の AI の追加として外れ、委ねた警告は残る（以前は推奨の無い委任があると計画の AI の追加がすべて delegated になった）
  planCalls.length = 0;
  const Q_NOREC = { ...Q_WARN, recommendation: '' };
  const sf = (args) => { const r = scopeScript(args); if (!r) return r; if (args.utterance === REQ) r.proposal.decisions = [Q_NOREC]; return r; };
  const gen = recordingGenerate(['good']);
  const x = makeConvC({ scriptFn: sf, labels: LABELS, generate: gen, planImpl: planImplOf({ refs: REFS_MAIN }) });
  await x.c.send(REQ); await x.c.send(DELEGATE_U);
  const asks = x.calls.ask.length;
  await x.c.send('採用します');
  const v = x.c.activePlan();
  const sco = scopeOf(x);
  const r7 = sco.requirements.find(q => q.id === 'R7') || {};
  const g1 = gen.seen.filter(g => g.cid === 'C1' && g.version === v.version)[0];
  assert(x.c.draftDecisions().some(d => d.kind === 'delegated' && d.noRecommendation) && r7.basis === 'planner' && r7.inScope === false && r7.out === 'adds-effect' && strippedOf(v).some(st => st.effect === 'block-save') && g1 && JSON.stringify(effKeys(g1.requiredEffects)) === JSON.stringify(['amount:lock', 'memo:warn']), `S5-6: 推奨の無い委任があっても、混入した保存禁止（R7）は planner として範囲外・外れる。委ねた警告（R6）は残る: ${JSON.stringify({ r7: [r7.basis, r7.inScope, r7.out], req: g1 && effKeys(g1.requiredEffects) })}`);
  assert(x.calls.ask.length === asks && x.calls.propose.length === 2 && !possibleOf(v).length, 'S5-7: 質問は増えない・委任は実現済みなので可能性の扱いは無い');
});

// =========================================================
console.log('\n--- §S7. 決定事項の結び付き decisionRefs（印がある Gateway は結び付けた警告だけ delegated・混入した保存禁止は外す。印の無い Gateway は possible のまま） ---');
const markOn = (x) => { x.services.plannerRequirementOps = () => ['decisionRefs']; return x; };
/** 印がある Gateway の要件の操作の形（strict の必須＝すべての操作に decisionRefs の配列）。refOf(op) = その操作の decisionRefs */
const withRefs = (ops, refOf) => ops.map(op => ({ ...op, decisionRefs: refOf(op) || [] }));
/** 計画の AI に送られた決定事項のうち、委ねた判断（delegated: true）の id（key を渡すとその判断だけ） */
const delegatedIdOf = (decisions, key = null) => ((decisions || []).find(d => d && d.delegated === true && (!key || d.key === key)) || {}).id || null;
const isWarnAdd = (op) => op.op === 'add' && (op.effects || []).includes('warn');
const reqRowOf = (sco, pred) => (sco.requirements || []).find(pred) || {};
await section(async () => {
  //   部品: health の印・計画の AI に送る決定事項の委ねた印・要件の操作の decisionRefs の取り込み（update で上書きされても結び付きは要件に残す）
  const { KTAiAnswers, KTContext } = T;
  const health = (ops) => { const h = clone(K.HEALTH); if (ops) h.registry.toolkit['change-planner'].requirementOps = ops; return h; };
  const capOn = T.KTAiClient.capabilityFromHealth(health(['decisionRefs'])), capOff = T.KTAiClient.capabilityFromHealth(health(null));
  assert(JSON.stringify((capOn.features['change-planner'] || {}).requirementOps) === '["decisionRefs"]' && !(capOff.features['change-planner'] || {}).requirementOps, `S7-0a: health の change-planner の requirementOps（decisionRefs の印）を読む（印の無い古い Gateway は無し）: ${JSON.stringify(capOn.features['change-planner'])}`);
  const cd = KTContext.compactDecisions ? KTContext.compactDecisions([{ id: 'D1', topic: 'other', source: 'chat', status: 'answered', answer: '出す', delegated: true }, { id: 'D2', topic: 'other', source: 'chat', status: 'answered', answer: '部長' }]) : [];
  const cdG = KTContext.compactDecisions ? KTContext.compactDecisions([{ id: 'D1', topic: 'other', source: 'chat', status: 'answered', answer: '出す', delegated: true }], { answeredOnly: true }) : [{ delegated: true }];
  assert(cd.length === 2 && cd[0].delegated === true && !('delegated' in cd[1]) && cdG.length === 1 && !('delegated' in cdG[0]), `S7-0b: 計画の AI に送る決定事項は委ねた判断の印（delegated: true）を残す（生成には送らない・印の無い決定事項は今までと同じ）: ${JSON.stringify({ cd, cdG })}`);
  const lg = KTAiAnswers.createLedger('p');
  const ch1 = KTAiAnswers.applyRequirementOps(lg, [{ op: 'add', target: '備考', behavior: '警告を出す', decision: 'proposed', planRefs: ['C1'], effects: ['warn'], decisionRefs: [' D2 ', 'D2', 'x1', 'D3'] }], { version: 1 });
  const e1 = lg.requirements[0];
  const ch2 = KTAiAnswers.applyRequirementOps(lg, [{ op: 'update', id: e1.id, target: '備考', behavior: '警告を出す', decision: 'proposed', planRefs: ['C1'], effects: ['warn'], decisionRefs: [] }], { version: 2 });
  const refs2 = e1.decisionRefs ? [...e1.decisionRefs] : null;
  KTAiAnswers.applyRequirementOps(lg, [{ op: 'update', id: e1.id, target: '備考', behavior: '警告を出す', decision: 'proposed', planRefs: ['C1'], effects: ['warn'] }], { version: 3 });
  assert(JSON.stringify(ch1.decisionRefs && ch1.decisionRefs.get(e1.id)) === '["D2","D3"]' && JSON.stringify(refs2) === '[]' && ch2.decisionRefs && JSON.stringify(ch2.decisionRefs.get(e1.id)) === '[]' && JSON.stringify(e1.decisionRefs) === '[]' && !('decisionRefs' in KTAiAnswers.requirementsForContext(lg)[0]), `S7-0c: 要件の操作の decisionRefs を取り込む（D の形だけ・重複なし。update は上書き・項目が無ければ前の値。Gateway に戻す要件には付けない）: ${JSON.stringify({ add: ch1.decisionRefs && ch1.decisionRefs.get(e1.id), upd: refs2, now: e1.decisionRefs })}`);
  const lg2 = KTAiAnswers.createLedger('p2');
  KTAiAnswers.recordAnswer(lg2, { topics: ['other'], answer: '出す', source: 'chat', version: 1, delegated: true });
  KTAiAnswers.recordAnswer(lg2, { topics: ['approver'], answer: '部長です', source: 'chat', version: 1 });
  const dfc = KTAiAnswers.decisionsForContext(lg2);
  assert(dfc.length === 2 && dfc.find(d => d.answer === '出す').delegated === true && !('delegated' in dfc.find(d => d.answer === '部長です')), `S7-0d: 計画の系列の台帳の決定事項も委ねた印を送る（値で答えた決定事項は今までと同じ）: ${JSON.stringify(dfc.map(d => [d.id, d.answer, d.delegated]))}`);
});
/** 仮案: 委任のターンで要件を作らない（未実現の委任。§S5 の C2 と同じ）。計画: 最初の計画で委ねた警告（warn）を足し、混入した保存禁止も足す。印があれば decisionRefs を付ける */
const S7_SF = (args) => { const r = scopeScript(args); if (!r) return r; if (args.utterance === DELEGATE_U) r.turn.requirementOps = []; return r; };
const s7Plan = ({ mark, linkWarn = true, linkSuggestion = false }) => (args) => {
  const r = planImplOf({ refs: { R1: REFS_MAIN.R1, R3: REFS_MAIN.R3, R4: REFS_MAIN.R4, R5: REFS_MAIN.R5 } })(args);
  if (!args.revision) r.turn.requirementOps = [...r.turn.requirementOps, { ...WARN_PLAN_OP }];
  const dw = delegatedIdOf(args.decisions, 'lock.warn');
  //   linkSuggestion: 計画の AI が任意の提案の扱いの要件（R4 明細の保存禁止）の update にも委ねた判断の id を付ける（結び付けで採用の根拠を変えないことの確認）
  if (mark) r.turn.requirementOps = withRefs(r.turn.requirementOps, (op) => (((isWarnAdd(op) && linkWarn) || (linkSuggestion && op.op === 'update' && op.id === 'R4')) && dw ? [dw] : []));
  return r;
};
await section(async () => {
  //   印がある Gateway: 混入した保存禁止（decisionRefs []）は外れる。委ねた警告（decisionRefs [委ねた判断の id]）は、採用の時点にその判断の動作の構造が無い
  //   （委任のターンで要件を作らない）ので AI の id だけでは上げず、判断の候補（再検証前の指示 §1。以前の期待「delegated で残る」を直した）
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const x = markOn(makeConvC({ scriptFn: S7_SF, labels: LABELS, generate: gen, planImpl: s7Plan({ mark: true }) }));
  await x.c.send(REQ); await x.c.send(DELEGATE_U);
  const asks = x.calls.ask.length;
  await x.c.send('採用します');
  const v = x.c.activePlan();
  const v1 = (v && x.c.planHistory().find(z => z.planId === v.planId && z.version === 1)) || null;
  const sco = scopeOf(x);
  const dId = delegatedIdOf(planCalls[0] && planCalls[0].decisions, 'lock.warn');
  const warnReq = reqRowOf(sco, q => q.createdBy === 'plan' && (q.effects || []).includes('warn'));
  const saveReq = reqRowOf(sco, q => q.createdBy === 'plan' && (q.effects || []).includes('block-save'));
  assert(!!dId && sco.decisionRefs === true && warnReq.basis === 'planner' && !warnReq.via && warnReq.inScope === false && warnReq.out === 'candidate' && (warnReq.candidate || {}).via === 'decisionRefs' && ((warnReq.candidate || {}).decisionIds || []).includes(dId) && (warnReq.decisionLinks || []).some(l => l.id === dId && l.kind === 'delegated' && l.verdict === 'unverified'),
    `S7-1: 委ねた判断の id（${dId}）を付けた警告は、採用の時点にその判断の構造が無いので上げない（判断の候補・結び付きは unverified で残す）: ${JSON.stringify({ mode: sco.decisionRefs, warn: [warnReq.id, warnReq.basis, warnReq.via, warnReq.inScope, warnReq.out, warnReq.candidate, warnReq.decisionLinks] })}`);
  assert(saveReq.basis === 'planner' && saveReq.inScope === false && saveReq.out === 'adds-effect' && saveReq.stripped === true && !(saveReq.decisionLinks || []).length && sco.delegationOpen === true && candidatesOf(v).length === 1 && candidatesOf(v)[0].items.every(it => it.effect === 'warn'),
    `S7-2: decisionRefs [] の混入した保存禁止は planner として範囲外（台帳で外・計画から外した）。委任は実現していない（判断の候補は警告だけ）: ${JSON.stringify({ save: [saveReq.id, saveReq.basis, saveReq.inScope, saveReq.out, saveReq.stripped], open: sco.delegationOpen, cand: candidatesOf(v) })}`);
  assert(!!v1 && noSave(v1.plan) && noSave(v1.gatewayPlan) && noSave(v && v.plan) && noSave(v && v.gatewayPlan) && strippedOf(v1).some(s => (s.requirementIds || []).includes(saveReq.id)) && !effectsOfCust(((v && v.plan.customizations) || []).find(c => c.customizationId === 'C1')).includes('memo:warn') && strippedOf(v).some(s => s.field === 'memo' && s.effect === 'warn' && s.reason === 'candidate'),
    `S7-3: 保存禁止は v.plan と v.gatewayPlan の両方から外す（最初の計画・自動の見直しの版とも）。判断の候補の警告も計画から外す（reason candidate）: ${JSON.stringify({ v1: v1 && strippedOf(v1).map(s => `${s.customizationId}:${s.field}:${s.effect}:${s.reason}`), c1: v && effectsOfCust((v.plan.customizations || []).find(c => c.customizationId === 'C1')) })}`);
  const g1 = gen.seen.filter(g => g.cid === 'C1' && v && g.version === v.version)[0] || null;
  assert(!!g1 && JSON.stringify(effKeys(g1.requiredEffects)) === JSON.stringify(['amount:lock']) && !effectsOfCust(g1.customization).some(k => /block-save|warn/.test(k)), `S7-4: 生成の必須の効果は編集不可だけ（保存禁止も、確かめられない警告も黙って入れない）: ${JSON.stringify(g1 && g1.requiredEffects.map(e => [e.field, e.effect, e.requirementIds]))}`);
  const html = finalHtml(x), shut = shutOfS(html);
  const cand = (shut.match(/判断が残っています[\s\S]*?入れるものを伝えてください/) || [''])[0];
  assert(x.calls.ask.length === asks && x.calls.propose.length === 2 && planCalls.length === 1 && !/委ねた判断を実現するために計画が足した可能性がある動作/.test(html) && /依頼に無い可能性がある動作/.test(html) && /おまかせにした「備考の警告」は、計画の案と結び付けを確かめられないため、まだ入れていません。計画の案: 「備考」に警告を出す。入れるものを伝えてください/.test(cand) && !/保存/.test(cand),
    `S7-5: 質問は増えない・説明を直すための自動の見直しは無い（§3）・外した保存禁止は詳細の「依頼に無い可能性がある動作」・委ねた警告は通常表示に判断の候補（黙って消さない）: ${JSON.stringify({ plans: planCalls.length, asks: x.calls.ask.length, cand: cand.slice(0, 200) })}`);
});
await section(async () => {
  //   印の無い古い Gateway（同じ計画の AI。decisionRefs は返らない）: 未実現の委任の間の計画の AI の追加は判断の候補（再検証前の指示 §1。以前の「外さずに残し、
  //   詳細に出す」possible を直した）。委ねた警告も混入した保存禁止も黙って入れず・黙って消さず、通常表示に一度に出す。自動の見直しの引き金にしない
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const x = makeConvC({ scriptFn: S7_SF, labels: LABELS, generate: gen, planImpl: s7Plan({ mark: false }) });
  await x.c.send(REQ); await x.c.send(DELEGATE_U);
  await x.c.send('採用します');
  const v = x.c.activePlan();
  const sco = scopeOf(x);
  const warnReq = reqRowOf(sco, q => q.createdBy === 'plan' && (q.effects || []).includes('warn'));
  const saveReq = reqRowOf(sco, q => q.createdBy === 'plan' && (q.effects || []).includes('block-save'));
  const html = finalHtml(x);
  const cand = (shutOfS(html).match(/判断が残っています[\s\S]{0,400}/) || [''])[0];
  const g1 = gen.seen.filter(g => g.cid === 'C1' && v && g.version === v.version)[0] || null;
  assert(sco.decisionRefs !== true && sco.delegationOpen === true && warnReq.basis === 'planner' && warnReq.out === 'candidate' && saveReq.out === 'candidate' && saveReq.inScope === false && warnReq.inScope === false && !!g1 && JSON.stringify(effKeys(g1.requiredEffects)) === JSON.stringify(['amount:lock'])
    && /おまかせにした「備考の警告」は、計画の案と結び付けを確かめられないため、まだ入れていません。計画の案: /.test(cand) && /「備考」に警告を出す/.test(cand) && /保存を止める/.test(cand) && !/委ねた判断を実現するために計画が足した可能性がある動作/.test(html) && planCalls.length <= 2,
    `S7-6: 印の無い Gateway: 未実現の委任の間の計画の AI の追加は判断の候補（必須の効果に入れない・通常表示に一度に出す）: ${JSON.stringify({ mode: sco.decisionRefs, open: sco.delegationOpen, warn: [warnReq.basis, warnReq.out], save: [saveReq.out, saveReq.inScope], plans: planCalls.length, cand: cand.slice(0, 200) })}`);
});
await section(async () => {
  //   印がある Gateway で、計画の AI が委ねた警告に決定事項の id を付けなかった: 決定事項の id の無い計画の AI の追加は planner として今までどおり判定する（可能性の扱いにしない）
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const x = markOn(makeConvC({ scriptFn: S7_SF, labels: LABELS, generate: gen, planImpl: s7Plan({ mark: true, linkWarn: false }) }));
  await x.c.send(REQ); await x.c.send(DELEGATE_U);
  await x.c.send('採用します');
  const v = x.c.activePlan();
  const sco = scopeOf(x);
  const warnReq = reqRowOf(sco, q => q.createdBy === 'plan' && (q.effects || []).includes('warn'));
  assert(warnReq.basis === 'planner' && warnReq.inScope === false && warnReq.out === 'adds-effect' && !warnReq.possible && sco.delegationOpen === true && !possibleOf(v).length, `S7-7: 結び付けなかった計画の AI の追加は planner として判定（委任が未実現でも可能性の扱いにしない）: ${JSON.stringify({ warn: [warnReq.basis, warnReq.inScope, warnReq.out, warnReq.possible], open: sco.delegationOpen })}`);
});
await section(async () => {
  //   印がある Gateway で、計画の AI が任意の提案の扱いの要件（R4。採用の既定から外した明細の保存禁止）の update にも委ねた判断の id を付けた:
  //   結び付けで採用の根拠を変えない（suggestion のまま範囲外・計画から外す。判断の候補にもしない）
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const x = markOn(makeConvC({ scriptFn: S7_SF, labels: LABELS, generate: gen, planImpl: s7Plan({ mark: true, linkSuggestion: true }) }));
  await x.c.send(REQ); await x.c.send(DELEGATE_U);
  await x.c.send('採用します');
  const v = x.c.activePlan();
  const sco = scopeOf(x);
  const r4 = reqRowOf(sco, q => q.id === 'R4');
  const warnReq = reqRowOf(sco, q => q.createdBy === 'plan' && (q.effects || []).includes('warn'));
  const g1 = gen.seen.filter(g => g.cid === 'C1' && v && g.version === v.version)[0] || null;
  assert(r4.basis === 'suggestion' && r4.inScope === false && r4.out === 'suggestion' && !r4.candidate && warnReq.out === 'candidate' && noSave(v && v.plan) && !!g1 && !effKeys(g1.requiredEffects).some(k => /block-save/.test(k)) && !candidatesOf(v).some(g => g.items.some(it => (it.requirementIds || []).includes('R4'))),
    `S7-7b: 任意の提案の扱いの要件は、計画の AI が委ねた判断の id を付けても範囲外のまま（保存禁止は計画と必須の効果に入らない・判断の候補にもしない）: ${JSON.stringify({ r4: [r4.basis, r4.inScope, r4.out, r4.decisionLinks], warn: warnReq.out, req: g1 && effKeys(g1.requiredEffects) })}`);
});
//   計画の段階の「おすすめで」（reviseWith の delegatedWork の置き換え）: 最初の計画が確認事項（備考の警告を出すか）を返し、利用者が「おすすめで」と答える。
//   その差分更新で計画の AI が委ねた警告と混入した保存禁止を足す（自動の見直しでは足さない）
const Q_PLAN_TEXT = '差戻し後に備考が空のとき警告を出しますか';
const Q_PLAN = (rec) => ({ id: 'Q1', question: Q_PLAN_TEXT, topic: 'other', impact: '差戻し後の入力の案内が変わります', options: ['出す', '出さない'], recommendation: rec ? '出す' : '', priority: 'later', reason: '' });
const stageFields = (after) => [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: ST_OK, effects: after ? ['lock', 'block-save'] : ['lock'] }, ...(after ? [{ code: 'items', access: 'CONTROL', condition: ST_OK, effects: ['block-save'] }, { code: 'memo', access: 'CONTROL', condition: 'ステータス in ("作成中")', effects: ['warn'] }] : [])];
const SAVE_PLAN_OP = { op: 'add', target: '金額と明細', condition: '承認済み', behavior: '金額・明細の変更を保存時に止める（おすすめの後）', exceptions: [], decision: 'proposed', disposition: 'adopted', sourceQuotes: [], planRefs: ['C1', 'C2'], effects: ['block-save'], note: '' };
const S7P_SF = (args) => { const r = scopeScript(args); if (r && args.utterance === REQ) r.proposal.decisions = []; return r; };
const planStage = ({ mark, rec }) => (args) => {
  const r = planImplOf({ ids: ['C1', 'C2'], refs: { R1: { planRefs: ['C1', 'C2'], effects: ['lock'] }, R3: { planRefs: ['C1', 'C2'], effects: [] }, R5: { planRefs: ['P1'], effects: [] } } })(args);
  const n = planCalls.length, after = n >= 2;
  for (const pl of [r.plan, r.gatewayPlan]) { for (const c of pl.customizations) c.fields = stageFields(after); pl.questions = after ? [] : [Q_PLAN(rec)]; pl.assessment = { summary: after ? '承認済みでは金額を編集不可にし、差戻し後に備考が空なら警告を出します。' : '承認済みでは金額を編集不可にします。' }; }
  r.turn.requirementOps = [...r.turn.requirementOps.filter(op => op.op === 'update'), ...(n === 2 ? [{ ...WARN_PLAN_OP }, { ...SAVE_PLAN_OP }] : [])];
  const did = delegatedIdOf(args.decisions);
  if (mark) r.turn.requirementOps = withRefs(r.turn.requirementOps, (op) => (isWarnAdd(op) && did ? [did] : []));
  return r;
};
for (const rec of [true, false]) for (const mark of [true, false]) {
  await section(async () => {
    const tag = `${rec ? '推奨を採用' : '推奨の無い確認事項の委任'}・${mark ? '印あり' : '印なし'}`;
    planCalls.length = 0;
    const gen = recordingGenerate(['good']);
    const x0 = makeConvC({ scriptFn: S7P_SF, labels: LABELS, generate: gen, planImpl: planStage({ mark, rec }) });
    const x = mark ? markOn(x0) : x0;
    await x.c.send(REQ);
    await x.c.send('採用します');
    const v1 = x.c.activePlan();
    const open1 = ((v1 && v1.openQuestions) || []).map(q => q.text);
    const r = await x.c.send('おすすめで');
    const v = x.c.activePlan();
    const sco = scopeOf(x);
    const p1 = planCalls[1] || { decisions: [], revision: false };
    const sentD = (p1.decisions || []).filter(d => d.delegated === true);
    const warnReq = reqRowOf(sco, q => q.createdBy === 'revise' && (q.effects || []).includes('warn'));
    const saveReq = reqRowOf(sco, q => q.createdBy === 'revise' && (q.effects || []).includes('block-save'));
    const g1 = gen.seen.filter(g => g.cid === 'C1' && v && g.version === v.version)[0] || null;
    const html = finalHtml(x);
    assert(open1.includes(Q_PLAN_TEXT) && r.intent === (rec ? 'ANSWER' : 'REVISE_PLAN') && p1.revision === true && !!v && v.version >= 2 && (sco.planDelegations || []).length === 1 && (sco.planDelegations[0] || {}).source === (rec ? 'answer' : 'no-recommendation'), `S7-8（${tag}）: 前提: 最初の計画の確認事項に「おすすめで」→ 計画の差分更新・計画の段階の委任を台帳に 1 件: ${JSON.stringify({ open1, intent: r.intent, pd: sco.planDelegations })}`);
    if (mark) {
      const did = (sentD[0] || {}).id;
      assert(sentD.length === 1 && (rec ? sentD[0].answer === '出す' : (sentD[0].question === Q_PLAN_TEXT && sentD[0].topic === 'other' && sentD[0].source === 'chat' && sentD[0].status === 'answered' && /^D[0-9]+$/.test(sentD[0].id))), `S7-9（${tag}）: 計画の AI に委ねた判断として送る（推奨を採用した決定事項・推奨の無い確認事項の委任は委ねた判断の決定事項）: ${JSON.stringify(sentD)}`);
      //   再検証前の指示 §1: 計画の段階の委任（key の無い決定事項）は採用の時点の構造が無いので、AI の id だけでは上げない（判断の候補）。以前の期待「delegated で残る」を直した
      const cand = (shutOfS(html).match(/判断が残っています[\s\S]{0,300}/) || [''])[0];
      assert(warnReq.basis === 'planner' && warnReq.inScope === false && warnReq.out === 'candidate' && (warnReq.decisionLinks || []).some(l => l.id === did && l.verdict === 'unverified') && saveReq.basis === 'planner' && saveReq.inScope === false && saveReq.stripped === true && sco.delegationOpen === true && /おまかせにした「[^」]+」は、計画の案と結び付けを確かめられないため、まだ入れていません。計画の案: 「備考」に警告を出す/.test(cand),
        `S7-10（${tag}）: 委ねた警告（decisionRefs [${did}]）は判断の候補（通常表示に出す）、混入した保存禁止（decisionRefs []）は planner として外れる: ${JSON.stringify({ warn: [warnReq.id, warnReq.basis, warnReq.inScope, warnReq.out], save: [saveReq.id, saveReq.basis, saveReq.inScope, saveReq.stripped], open: sco.delegationOpen, cand: cand.slice(0, 160) })}`);
      assert(noSave(v.plan) && noSave(v.gatewayPlan) && !!g1 && JSON.stringify(effKeys(g1.requiredEffects)) === JSON.stringify(['amount:lock']) && x.calls.ask.length === 0 && planCalls.length === 2, `S7-11（${tag}）: v.plan・v.gatewayPlan・生成の必須の効果に保存禁止も確かめられない警告も無い（質問なし・説明を直すための自動の見直しは無い）: ${JSON.stringify({ req: g1 && effKeys(g1.requiredEffects), plans: planCalls.length })}`);
    } else {
      const cand = (shutOfS(html).match(/判断が残っています[\s\S]{0,400}/) || [''])[0];
      assert(!sentD.some(d => d.question === Q_PLAN_TEXT && !rec) && warnReq.basis === 'planner' && warnReq.out === 'candidate' && saveReq.out === 'candidate' && saveReq.inScope === false && sco.delegationOpen === true && /「備考」に警告を出す/.test(cand) && /保存を止める/.test(cand) && !/委ねた判断を実現するために計画が足した可能性がある動作/.test(html) && planCalls.length === 2 && !!g1 && JSON.stringify(effKeys(g1.requiredEffects)) === JSON.stringify(['amount:lock']),
        `S7-12（${tag}）: 印の無い Gateway: 計画の段階の委任の版の計画の AI の追加は判断の候補（必須の効果に入れない・通常表示に一度に出す・自動の見直しの引き金にしない）: ${JSON.stringify({ warn: [warnReq.basis, warnReq.out], save: [saveReq.out, saveReq.inScope], open: sco.delegationOpen, plans: planCalls.length, cand: cand.slice(0, 200) })}`);
    }
  });
}
await section(async () => {
  //   画面: health の印を読み（services.plannerRequirementOps）、実際の Planner Context の決定事項に委ねた判断の印を残す（台本の「おすすめで」は推奨の無い判断を委ねる）
  for (const mark of [true, false]) {
    const h = clone(K.HEALTH_V); if (mark) h.registry.toolkit['change-planner'].requirementOps = ['decisionRefs'];
    const seen = [];
    const pi = K.planImplOf(K.PLAN_V1);
    const m = K.mount({ health: h, planImpl: (a) => { seen.push(clone((a.ctx && a.ctx.decisions) || [])); return pi(a); } });
    await K.ticks();
    const v = await K.adoptOnScreen(m); await K.ticks(8);
    const sc = (typeof m.conv().requirementScope === 'function' ? m.conv().requirementScope() : null) || {};
    assert(!!v && sc.decisionRefs === mark && (seen[0] || []).some(d => d.delegated === true) && (seen[0] || []).every(d => !('key' in d)), `S7-13（${mark ? '印あり' : '印なし'}）: 画面は health の decisionRefs の印を読み（${mark}）、Planner Context の決定事項に委ねた判断の印を残す: ${JSON.stringify({ mode: sc.decisionRefs, decisions: (seen[0] || []).map(d => [d.id, d.delegated]) })}`);
  }
});

// =========================================================
console.log('\n--- §S8. 結び付けの誤りの影響を狭める（実現済みの決定事項への結び付きは根拠に数えない・結び付きで上がった要件の効果は詳細に出す） ---');
const VALUE_U = '備考の警告は出してください';
const B_WARN_U = '差戻し後に備考が空なら警告を出す';
const S8_REST = { approach: { standard: ['ステータス「部長承認待ち」の追加'], js: ['承認済みの金額の編集不可（PC・モバイル）'] }, cannot: ['明細の行の追加・削除ボタン自体は止められません'] };
const S8_BEHAVIORS = () => [B(B_LOCK_U, 'user'), B(B_BACK_U, 'user'), B(B_CHECK_U, 'user'), B(B_SAVE_AI, 'ai'), B(B_STATUS_AI, 'ai'), B(B_WARN_U, 'user')];
/** 計画の AI に送られた決定事項のうち、値で答えた「出す」の決定事項の id（最初の計画は仮案の判断の id・見直しは台帳の決定事項の id） */
const valueIdOf = (decisions) => ((decisions || []).find(d => d && d.delegated !== true && d.answer === '出す') || {}).id || null;
const isSaveAdd = (op) => op.op === 'add' && (op.effects || []).includes('block-save');
const linkedOf = (v) => (v && Array.isArray(v.scopeLinked) ? v.scopeLinked : []);
const LINKED_RE = /決定事項の実現として計画が足した動作（([0-9]+) 件）/;
/** 最終案の詳細の「決定事項の実現として計画が足した動作」の折りたたみの中の文（無ければ ''） */
const linkedText = (html) => stripC((String(html).match(/<details class="kt-ai-tech kt-ai-final-scope-linked"[\s\S]*?<\/details>/) || [''])[0]);
const shutOf = (html) => stripC(html.replace(/<details[\s\S]*?<\/details>/g, ''));
/**
 * 仮案の台本: 判断「備考の警告」に値で答える（委任なし）。realize = 'key'（1 回目の仮案で警告の要件が判断 Q1 に結び付き、答えのターンで decided に直す＝判断の key:<key> で実現済み）/
 *   'none'（答えのターンで要件を作らない＝未実現）/ 'loose'（probe-mislink2 の形。答えのターンで警告の要件を作るが判断・前提の key に結び付かない＝構造では判定できない）
 */
const s8Script = (realize) => (args) => {
  const r = scopeScript(args);
  if (args.utterance === REQ && realize === 'key') { r.turn.requirementOps = [...r.turn.requirementOps, req('add', { ...R_WARN, decision: 'undecided', disposition: 'unresolved', sourceQuotes: [], planRefs: ['Q1'], effects: ['warn'] })]; return r; }
  if (args.utterance !== VALUE_U) return r;
  const ops = realize === 'key' ? [req('update', { id: 'R6', ...R_WARN, decision: 'decided', sourceQuotes: [VALUE_U], planRefs: ['B6'], effects: ['warn'] })]
    : realize === 'loose' ? [req('add', { ...R_WARN, decision: 'decided', sourceQuotes: [VALUE_U], planRefs: ['B1'], effects: ['warn'] })] : [];
  return { reply: '備考の警告を出します。', intent: 'update', proposal: { behaviors: S8_BEHAVIORS(), assumptions: [], decisions: [], ...S8_REST },
    turn: { ops: [], answers: [{ id: K.idBy(args.previous && args.previous.decisions, d => d.key === 'lock.warn'), kind: 'value', text: '出す', quote: '出してください' }], requirementOps: ops } };
};
/** 計画の偽物: 混入した保存禁止（最初の計画・自動の見直しのどちらでも足す）に、値で答えた決定事項の id を decisionRefs で付ける（誤った結び付け）。ほかの操作は [] */
const s8PlanValue = ({ refs }) => (args) => {
  const r = planImplOf({ refs })(args);
  const did = valueIdOf(args.decisions);
  r.turn.requirementOps = withRefs(r.turn.requirementOps, (op) => (isSaveAdd(op) && did ? [did] : []));
  return r;
};
const S8_REFS = { R1: REFS_MAIN.R1, R3: REFS_MAIN.R3, R4: REFS_MAIN.R4, R5: REFS_MAIN.R5 };
await section(async () => {
  //   部品: requirementScopeOf の linked（D の実現の結び付き（verdict match）で範囲内に上がった要件が、それを除いた範囲内の要件の効果に無い効果を足すもの。外さない）
  const scopeFn = typeof KTAiConversation.requirementScopeOf === 'function' ? KTAiConversation.requirementScopeOf : null;
  const plan = { customizations: [{ customizationId: 'C1', fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: ST_OK, effects: ['lock', 'block-save'] }, { code: 'items', access: 'CONTROL', condition: ST_OK, effects: ['block-save'] }, { code: 'memo', access: 'CONTROL', condition: 'ステータス in ("作成中")', effects: ['warn'] }] }] };
  const rq = (id, o) => ({ id, target: '', condition: '', behavior: 'x', decision: 'proposed', planRefs: ['C1'], ...o });
  const R1 = rq('R1', { target: '金額', decision: 'decided', effects: ['lock'], scope: { basis: 'explicit' } });
  const R2 = rq('R2', { target: '備考', effects: ['warn'], scope: { basis: 'delegated', via: 'decisionRefs' }, decisionLinks: [{ id: 'D1', kind: 'delegated', verdict: 'match' }] });
  const R3 = rq('R3', { target: '金額と明細', effects: ['block-save'], scope: { basis: 'item-user', via: 'decisionRefs' }, decisionLinks: [{ id: 'D2', kind: 'user', verdict: 'match' }, { id: 'D1', kind: 'delegated', verdict: 'mismatch' }] });
  const R4 = rq('R4', { target: '備考', effects: ['warn'], scope: { basis: 'delegated' } });
  const run = (reqs) => { const s = scopeFn ? scopeFn(reqs, plan, { labels: LABELS }) || {} : {}; return { s, linked: Array.isArray(s.linked) ? s.linked.map(x => `${x.customizationId}:${x.field}:${x.effect}:${(x.requirementIds || []).join('|')}:${(x.decisionIds || []).join('|')}`).sort() : null }; };
  const a = run([R1, R2, R3]);
  assert(JSON.stringify(a.linked) === JSON.stringify(['C1:amount:block-save:R3:D2', 'C1:items:block-save:R3:D2', 'C1:memo:warn:R2:D1']) && a.s.inIds && a.s.inIds.has('R2') && a.s.inIds.has('R3') && (a.s.linked.find(x => x.field === 'memo').links || []).some(l => l.id === 'D1' && l.kind === 'delegated'), `S8-0a: D の実現の結び付きで上がった要件の効果のうち、それを除いた範囲内の要件の効果に無いものを linked に返す（対象が決まればそのフィールド・決まらなければ計画のその効果のフィールド。D の実現でない結び付き（mismatch）の id は入れない。決定事項の種類も持つ。外さない）: ${JSON.stringify(a.linked)}`);
  const b = run([R1, R2, R3, R4]);
  assert(JSON.stringify(b.linked) === JSON.stringify(['C1:amount:block-save:R3:D2', 'C1:items:block-save:R3:D2']), `S8-0b: 結び付きで上がっていない範囲内の要件（仮案の委ねた判断に結び付いた警告）が持つ効果は linked にしない: ${JSON.stringify(b.linked)}`);
  const c = run([R1, rq('R5', { target: '金額', decision: 'decided', scope: { basis: 'explicit' } }), R2]);
  assert(Array.isArray(c.linked) && c.linked.length === 0, `S8-0c: effects を持たない範囲内の要件が結び付く customization は判定しない（linked なし）: ${JSON.stringify(c.linked)}`);
  //   部品: D の実現の照合（decisionLinkVerdictOf）。X(D) の (フィールド, 効果) にすべて入るときだけ match。効果が違う・フィールドが違えば mismatch。X(D) が空なら unverified
  const V = typeof KTAiConversation.decisionLinkVerdictOf === 'function' ? KTAiConversation.decisionLinkVerdictOf : () => null;
  const fieldOf = (t) => ({ 備考: 'memo', 金額: 'amount', 明細: 'items' }[t] || null);
  const X = [{ target: '備考', effects: ['warn'] }];
  assert(V({ target: '備考', effects: ['warn'] }, X, fieldOf) === 'match' && V({ target: '金額と明細', effects: ['block-save'] }, X, fieldOf) === 'mismatch' && V({ target: '金額', effects: ['warn'] }, X, fieldOf) === 'mismatch' && V({ target: '備考', effects: ['warn', 'block-save'] }, X, fieldOf) === 'mismatch' && V({ target: '備考', effects: ['warn'] }, [], fieldOf) === 'unverified' && V({ target: '備考欄', effects: ['warn'] }, X, fieldOf) === 'match',
    'S8-0d: D の実現の照合は採用の時点の組 X(D) の (フィールド, 効果) だけ（別の効果・別のフィールド・余分な効果は mismatch、X(D) が空は unverified、対象が決まらなければ効果だけの組として比べる）');
});
await section(async () => {
  //   (a) probe-mislink2 の形（値で答えた D1 は仮案の段階で警告の要件に実現済み＝判断の key:<key>）で、計画の AI が混入した保存禁止に decisionRefs [D1] を付ける
  //   → 保存禁止は X(D1)（備考の警告）に無いので D1 の実現にしない（mismatch）。印がある Gateway でも planner として外れる（v.plan・v.gatewayPlan・台帳・生成の必須の効果）
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const x = markOn(makeConvC({ scriptFn: s8Script('key'), labels: LABELS, generate: gen, planImpl: s8PlanValue({ refs: { ...S8_REFS, R6: REFS_MAIN.R6 } }) }));
  await x.c.send(REQ); await x.c.send(VALUE_U);
  const asks = x.calls.ask.length;
  await x.c.send('採用します');
  const v = x.c.activePlan();
  const v1 = (v && x.c.planHistory().find(z => z.planId === v.planId && z.version === 1)) || null;
  const sco = scopeOf(x);
  const did = valueIdOf(planCalls[0] && planCalls[0].decisions);
  const r6 = reqRowOf(sco, q => q.id === 'R6');
  const saves = (sco.requirements || []).filter(q => ['plan', 'plan-auto'].includes(q.createdBy) && (q.effects || []).includes('block-save'));
  assert(!!did && sco.decisionRefs === true && r6.basis === 'explicit' && r6.inScope === true && saves.length === 1, `S8-1 前提: 値で答えた決定事項（${did}）を送り、仮案の段階の警告の要件（R6）は範囲内。混入した保存禁止は最初の計画の 1 件（§3: 自動の見直しは無い）: ${JSON.stringify({ did, r6: [r6.basis, r6.inScope], saves: saves.map(q => q.id) })}`);
  assert(saves.length === 1 && saves.every(q => q.basis === 'planner' && !q.via && q.inScope === false && q.out === 'adds-effect' && q.stripped === true && (q.decisionLinks || []).some(l => l.id === did && l.kind === 'user' && l.verdict === 'mismatch')) && !candidatesOf(v).length, `S8-2: X(D) に無い効果の結び付き（mismatch）は採用の根拠に数えない（保存禁止は planner として範囲外・外した。D は実現済みなので判断の候補にもしない）: ${JSON.stringify(saves.map(q => [q.id, q.basis, q.via, q.inScope, q.out, q.stripped, q.decisionLinks]))}`);
  const g1 = gen.seen.filter(g => g.cid === 'C1' && v && g.version === v.version)[0] || null;
  assert(!!v1 && noSave(v1.plan) && noSave(v1.gatewayPlan) && noSave(v && v.plan) && noSave(v && v.gatewayPlan) && !!g1 && JSON.stringify(effKeys(g1.requiredEffects)) === JSON.stringify(['amount:lock', 'memo:warn']) && !effectsOfCust(g1.customization).some(k => /block-save/.test(k)), `S8-3: 保存禁止は v.plan と v.gatewayPlan（最初の計画・自動の見直しの版）と生成の必須の効果に無い。値で答えた警告は残る: ${JSON.stringify({ v1: v1 && strippedOf(v1).map(s => `${s.customizationId}:${s.field}:${s.effect}`), req: g1 && effKeys(g1.requiredEffects) })}`);
  const html = finalHtml(x);
  assert(sco.linked === 0 && !linkedOf(v).length && !LINKED_RE.test(html) && !/計画で足した:|判断が残っています/.test(shutOf(html)) && /依頼に無い可能性がある動作/.test(html) && x.calls.ask.length === asks && planCalls.length === 1, `S8-4: 結び付きで上がった要件は無い（「計画で足した」「判断が残っています」は出さない・外した保存禁止は「依頼に無い可能性がある動作」）。質問は増えない・自動の見直しは 1 回: ${JSON.stringify({ linked: sco.linked, plans: planCalls.length })}`);
});
await section(async () => {
  //   (a') probe-mislink2 のそのままの形（答えのターンの警告の要件が判断・前提の key に結び付かない）: X(D) が空で D の実現かを構造で確かめられない。
  //   保存禁止は AI の id だけでは上げず（範囲外・計画から外す）、判断の候補として通常表示に出す（黙って入れない・黙って消さない）
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const x = markOn(makeConvC({ scriptFn: s8Script('loose'), labels: LABELS, generate: gen, planImpl: s8PlanValue({ refs: { ...S8_REFS, R6: REFS_MAIN.R6 } }) }));
  await x.c.send(REQ); await x.c.send(VALUE_U); await x.c.send('採用します');
  const v = x.c.activePlan();
  const sco = scopeOf(x);
  const save = reqRowOf(sco, q => q.createdBy === 'plan' && (q.effects || []).includes('block-save'));
  const g1 = gen.seen.filter(g => g.cid === 'C1' && v && g.version === v.version)[0] || null;
  const cand = (shutOf(finalHtml(x)).match(/判断が残っています[\s\S]*?入れるものを伝えてください/) || [''])[0];
  assert(save.inScope === false && save.out === 'candidate' && !!g1 && !effKeys(g1.requiredEffects).some(k => /block-save/.test(k)) && /決めた「備考の警告」について計画が足した動作は、結び付けを確かめられないため、まだ入れていません。計画の案: 「金額」「明細」の保存を止める。入れるものを伝えてください/.test(cand),
    `S8-5: 構造で確かめられない結び付けの保存禁止は上げず（必須の効果に入れない）、通常表示に判断の候補として出す（決めたことの見出し・計画の案）: ${JSON.stringify({ save: [save.id, save.basis, save.inScope, save.out], cand: cand.slice(0, 200) })}`);
});
await section(async () => {
  //   (b) 構造の無い値で答えた決定事項（答えのターンで要件を作らない）に、計画の AI が保存禁止を結び付ける → AI の id だけでは上げず、判断の候補
  //   （以前の期待「先の 1 件は item-user に上がり、後の 1 件は realized」を、順序に依存しない扱いに直した）。
  //   §3（2026-10-17）: 2 件目は、以前は説明を直すための自動の見直しの計画が足していた。その見直しは無くなったので、利用者の修正の差分更新が足す 2 件目で確かめる
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const x = markOn(makeConvC({ scriptFn: s8Script('none'), labels: LABELS, generate: gen, planImpl: s8PlanValue({ refs: S8_REFS }) }));
  await x.c.send(REQ); await x.c.send(VALUE_U); await x.c.send('採用します');
  const v = x.c.activePlan();
  const sco = scopeOf(x);
  const did = valueIdOf(planCalls[0] && planCalls[0].decisions);
  const save1 = reqRowOf(sco, q => q.createdBy === 'plan' && (q.effects || []).includes('block-save'));
  assert(!!did && save1.basis === 'planner' && !save1.via && save1.inScope === false && save1.out === 'candidate' && (save1.decisionLinks || []).some(l => l.id === did && l.kind === 'user' && l.verdict === 'unverified'), `S8-6: 構造の無い値で答えた決定事項（${did}）への結び付きだけでは上げない（判断の候補）: ${JSON.stringify({ save1: [save1.id, save1.basis, save1.via, save1.inScope, save1.out, save1.decisionLinks] })}`);
  const html = finalHtml(x);
  const cand = (shutOf(html).match(/判断が残っています[\s\S]*?入れるものを伝えてください/) || [''])[0];
  const g1 = gen.seen.filter(g => g.cid === 'C1' && v && g.version === v.version)[0] || null;
  assert(sco.linked === 0 && candidatesOf(v).length === 1 && /決めた「備考の警告」について計画が足した動作は、結び付けを確かめられないため、まだ入れていません。計画の案: 「金額」「明細」の保存を止める。入れるものを伝えてください/.test(cand) && !/\bD[0-9]+\b|\bR[0-9]+\b|\bC[0-9]+\b/.test(cand) && !!g1 && !effKeys(g1.requiredEffects).some(k => /block-save/.test(k)),
    `S8-8: 判断の候補は通常表示に一度に出す（決めたことの見出し・フィールドの名前・効果の言葉。番号は出さない）。必須の効果には入れない: ${JSON.stringify({ linked: sco.linked, cand: cand.slice(0, 200) })}`);
  await x.c.send('警告の文は「備考を入力してください」にして');
  const save2 = reqRowOf(scopeOf(x), q => q.createdBy === 'revise' && (q.effects || []).includes('block-save'));
  assert(planCalls.length === 2 && !!save2.id && save2.id !== save1.id && save2.basis === 'planner' && save2.out === 'candidate' && (save2.decisionLinks || []).some(l => l.id === did && l.verdict === 'unverified'), `S8-7: 差分更新で別の要件が同じ決定事項に結び付けても、先の要件と同じ扱い（順序で変えない）: ${JSON.stringify({ plans: planCalls.length, save2: [save2.id, save2.basis, save2.out, save2.decisionLinks] })}`);
});
await section(async () => {
  //   (c) 構造の無い委任（S7_SF）に計画の AI が委ねた警告を結び付ける → 判断の候補（以前の期待「delegated で残り詳細に出る」を直した）。混入した保存禁止は外れる
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const x = markOn(makeConvC({ scriptFn: S7_SF, labels: LABELS, generate: gen, planImpl: s7Plan({ mark: true }) }));
  await x.c.send(REQ); await x.c.send(DELEGATE_U); await x.c.send('採用します');
  const v = x.c.activePlan();
  const sco = scopeOf(x);
  const dId = delegatedIdOf(planCalls[0] && planCalls[0].decisions, 'lock.warn');
  const warnReq = reqRowOf(sco, q => q.createdBy === 'plan' && (q.effects || []).includes('warn'));
  const saveReq = reqRowOf(sco, q => q.createdBy === 'plan' && (q.effects || []).includes('block-save'));
  const g1 = gen.seen.filter(g => g.cid === 'C1' && v && g.version === v.version)[0] || null;
  assert(warnReq.basis === 'planner' && warnReq.out === 'candidate' && (warnReq.decisionLinks || []).some(l => l.id === dId && l.verdict === 'unverified') && saveReq.basis === 'planner' && saveReq.stripped === true && noSave(v && v.plan) && !!g1 && JSON.stringify(effKeys(g1.requiredEffects)) === JSON.stringify(['amount:lock']), `S8-9: 構造の無い委任に結び付けた警告は判断の候補（必須の効果に入れない）・混入した保存禁止は外れる: ${JSON.stringify({ warn: [warnReq.basis, warnReq.out, warnReq.decisionLinks], save: [saveReq.basis, saveReq.stripped], req: g1 && effKeys(g1.requiredEffects) })}`);
  const html = finalHtml(x);
  const cand = (shutOf(html).match(/判断が残っています[\s\S]*?入れるものを伝えてください/) || [''])[0];
  assert(sco.linked === 0 && !LINKED_RE.test(html) && /おまかせにした「備考の警告」は、計画の案と結び付けを確かめられないため、まだ入れていません。計画の案: 「備考」に警告を出す。入れるものを伝えてください/.test(cand), `S8-10: 委ねた警告は通常表示に判断の候補として出す（黙って消さない。保存禁止は候補に入れない）: ${JSON.stringify({ linked: sco.linked, cand: cand.slice(0, 200) })}`);
});
/**
 * (d1)〜(d3) の計画の偽物: 最初の計画で委ねた警告（warns の操作。既定は WARN_PLAN_OP 1 つ）と混入した保存禁止を足し、どちらにも委ねた判断の id を decisionRefs で付ける。
 *   warnFirst = 操作の順（警告 → 保存禁止 / 保存禁止 → 警告）。自動の見直しでは警告を足さない（保存禁止は足し直す・同じく結び付ける）
 */
//   link = false（(d4)・前の確認の K-5）: どちらにも決定事項の id を付けない（decisionRefs []）
const dPlan = ({ warnFirst, warns = [WARN_PLAN_OP], refs = S8_REFS, link = true }) => (args) => {
  const r = planImplOf({ refs })(args);
  const dw = delegatedIdOf(args.decisions, 'lock.warn') || delegatedIdOf(args.decisions);
  const ops = r.turn.requirementOps;
  const warn = args.revision ? [] : warns.map(w => ({ ...w }));
  const ordered = [...ops.filter(op => op.op === 'update'), ...(warnFirst ? [...warn, ...ops.filter(isSaveAdd)] : [...ops.filter(isSaveAdd), ...warn]), ...ops.filter(op => op.op !== 'update' && !isSaveAdd(op))];
  r.turn.requirementOps = withRefs(ordered, (op) => (link && dw && (isWarnAdd(op) || isSaveAdd(op)) ? [dw] : []));
  return r;
};
/** (d1)・(d3) の仮案: 1 回目の仮案で警告の要件（undecided・warn・planRefs Q1）が判断「備考の警告」に結び付き、委任のターンでは要件を作らない（採用の時点に判断の構造がある） */
const D1_SF = (args) => { const r = scopeScript(args); if (!r) return r; if (args.utterance === REQ) r.turn.requirementOps = [...r.turn.requirementOps, req('add', { ...R_WARN, decision: 'undecided', disposition: 'unresolved', sourceQuotes: [], planRefs: ['Q1'], effects: ['warn'] })]; if (args.utterance === DELEGATE_U) r.turn.requirementOps = []; return r; };
/** 結果の要約（順序の比較に使う。要件の id は作った順で変わるので、効果で見分ける） */
const dSummaryOf = (x, gen) => {
  const v = x.c.activePlan();
  const sco = scopeOf(x);
  const rows = (sco.requirements || []).filter(q => ['plan', 'plan-auto'].includes(q.createdBy) && (q.effects || []).length);
  const tag = (q) => `${q.createdBy}:${(q.effects || []).join('+')}:${(q.planRefs || []).join('+')}`;
  const g = (cid) => { const s = gen.seen.filter(z => z.cid === cid && v && z.version === v.version)[0]; return s ? effKeys(s.requiredEffects) : null; };
  const fin = v && v.final ? v.final : null;
  return { reqs: rows.map(q => `${tag(q)}=${q.basis}/${q.via || ''}/${q.inScope}/${q.out || ''}/${(q.decisionLinks || []).map(l => l.verdict).join(',')}`).sort(), c1: g('C1'), c2: g('C2'), plan: v ? effectsOfCust((v.plan.customizations || []).find(c => c.customizationId === 'C1')).sort() : null,
    planAdds: fin && fin.scopeOut ? [...(fin.scopeOut.planAdds || [])] : null, candidates: fin && fin.scopeOut ? [...(fin.scopeOut.candidates || [])] : null, plans: planCalls.length };
};
const dOrders = {};
for (const warnFirst of [true, false]) {
  await section(async () => {
    //   (d1) 採用の時点に判断の構造がある形: 委ねた警告（X(D) に入る）は D の実現（delegated・必須の効果）、混入した保存禁止（X(D) に無い）は外れる。どちらの順でも同じ
    const tag = warnFirst ? '警告 → 保存禁止' : '保存禁止 → 警告';
    planCalls.length = 0;
    const gen = recordingGenerate(['good']);
    const x = markOn(makeConvC({ scriptFn: D1_SF, labels: LABELS, generate: gen, planImpl: dPlan({ warnFirst }) }));
    await x.c.send(REQ); await x.c.send(DELEGATE_U); await x.c.send('採用します');
    const v = x.c.activePlan();
    const sco = scopeOf(x);
    const dId = delegatedIdOf(planCalls[0] && planCalls[0].decisions, 'lock.warn');
    const warnReq = reqRowOf(sco, q => q.createdBy === 'plan' && (q.effects || []).includes('warn'));
    const saveReq = reqRowOf(sco, q => q.createdBy === 'plan' && (q.effects || []).includes('block-save'));
    const r6 = reqRowOf(sco, q => q.id === 'R6');
    const g1 = gen.seen.filter(g => g.cid === 'C1' && v && g.version === v.version)[0] || null;
    assert(!!dId && r6.basis === 'delegated' && warnReq.basis === 'delegated' && warnReq.via === 'decisionRefs' && warnReq.inScope === true && (warnReq.decisionLinks || []).some(l => l.id === dId && l.verdict === 'match') && !!g1 && JSON.stringify(effKeys(g1.requiredEffects)) === JSON.stringify(['amount:lock', 'memo:warn']) && g1.requiredEffects.some(e => e.field === 'memo' && e.effect === 'warn' && (e.requirementIds || []).includes(warnReq.id)),
      `S8-11（${tag}）: 委ねた警告は D の実現（delegated・範囲内・生成の必須の効果に警告の要件の id つき）: ${JSON.stringify({ dId, warn: [warnReq.id, warnReq.basis, warnReq.via, warnReq.inScope, warnReq.decisionLinks], req: g1 && effKeys(g1.requiredEffects) })}`);
    assert(saveReq.basis === 'planner' && !saveReq.via && saveReq.inScope === false && saveReq.out === 'adds-effect' && saveReq.stripped === true && (saveReq.decisionLinks || []).some(l => l.id === dId && l.verdict === 'mismatch') && noSave(v && v.plan) && noSave(v && v.gatewayPlan) && !candidatesOf(v).length,
      `S8-12（${tag}）: 混入した保存禁止は X(D) に無いので D の実現にしない（planner として範囲外・計画から外す。判断の候補にもしない）: ${JSON.stringify({ save: [saveReq.id, saveReq.basis, saveReq.via, saveReq.inScope, saveReq.out, saveReq.stripped, saveReq.decisionLinks] })}`);
    const html = finalHtml(x), shut = shutOf(html);
    const sec = (shut.match(/仮案からの補足[\s\S]*?(?=この案の制約|確認できないこと|残る判断|動作テスト環境へ反映|$)/) || [''])[0];
    assert(/計画で足した: 「備考」に警告を出します（おまかせにした「備考の警告」の実現として）/.test(sec) && !/保存/.test((sec.match(/計画で足した:[^\n]*/) || [''])[0]) && !/判断が残っています/.test(shut) && /依頼に無い「[^」]*保存の停止」は入れていません/.test(shut),
      `S8-13（${tag}）: 計画で残した業務上の追加は、通常表示の「仮案からの補足」に対象・動作・理由を短く出す（外した保存禁止は「依頼に無い」の 1 行だけ）: ${sec.slice(0, 240)}`);
    dOrders[warnFirst ? 'wf' : 'sf'] = dSummaryOf(x, gen);
  });
}
await section(async () => {
  assert(!!dOrders.wf && !!dOrders.sf && JSON.stringify(dOrders.wf) === JSON.stringify(dOrders.sf), `S8-14: (d1) 警告 → 保存禁止 と 保存禁止 → 警告 で結果が同じ（要件の根拠・範囲・生成の必須の効果・計画・通常表示の追加と候補）: ${JSON.stringify(dOrders)}`);
});
const dOrders2 = {};
for (const warnFirst of [true, false]) {
  await section(async () => {
    //   (d2) 採用の時点に判断の構造が無い形（今の S7_SF の素材）: どちらも AI の id だけでは上げず、通常表示に判断の候補として両方を一度に出す（委ねた警告を黙って消さない・保存禁止を黙って入れない）
    const tag = warnFirst ? '警告 → 保存禁止' : '保存禁止 → 警告';
    planCalls.length = 0;
    const gen = recordingGenerate(['good']);
    const x = markOn(makeConvC({ scriptFn: S7_SF, labels: LABELS, generate: gen, planImpl: dPlan({ warnFirst }) }));
    await x.c.send(REQ); await x.c.send(DELEGATE_U);
    const asks = x.calls.ask.length;
    await x.c.send('採用します');
    const v = x.c.activePlan();
    const sco = scopeOf(x);
    const warnReq = reqRowOf(sco, q => q.createdBy === 'plan' && (q.effects || []).includes('warn'));
    const saveReq = reqRowOf(sco, q => q.createdBy === 'plan' && (q.effects || []).includes('block-save'));
    const g1 = gen.seen.filter(g => g.cid === 'C1' && v && g.version === v.version)[0] || null;
    assert([warnReq, saveReq].every(q => q.basis === 'planner' && !q.via && q.inScope === false && q.out === 'candidate' && (q.decisionLinks || []).some(l => l.verdict === 'unverified')) && !!g1 && JSON.stringify(effKeys(g1.requiredEffects)) === JSON.stringify(['amount:lock']) && noSave(v && v.plan),
      `S8-15（${tag}）: 構造の無い委任に結び付けた警告も保存禁止も上げない（判断の候補・必須の効果に入れない）: ${JSON.stringify({ warn: [warnReq.basis, warnReq.inScope, warnReq.out], save: [saveReq.basis, saveReq.inScope, saveReq.out], req: g1 && effKeys(g1.requiredEffects) })}`);
    const html = finalHtml(x), shut = shutOf(html);
    const cands = shut.match(/おまかせにした「備考の警告」は/g) || [];
    const cand = (shut.match(/判断が残っています[\s\S]*?入れるものを伝えてください/) || [''])[0];
    assert(cands.length === 1 && /おまかせにした「備考の警告」は、計画の案と結び付けを確かめられないため、まだ入れていません。計画の案: 「備考」に警告を出す／「金額」「明細」の保存を止める。入れるものを伝えてください/.test(cand) && x.calls.ask.length === asks && x.calls.propose.length === 2,
      `S8-16（${tag}）: 通常表示に判断が残っていることを一度に示す（1 つの文に両方の計画の案。別のカード・質問は増やさない）: ${cand.slice(0, 260)}`);
    dOrders2[warnFirst ? 'wf' : 'sf'] = dSummaryOf(x, gen);
  });
}
await section(async () => {
  assert(!!dOrders2.wf && !!dOrders2.sf && JSON.stringify(dOrders2.wf) === JSON.stringify(dOrders2.sf), `S8-17: (d2) 警告 → 保存禁止 と 保存禁止 → 警告 で結果が同じ: ${JSON.stringify(dOrders2)}`);
});
await section(async () => {
  //   (d3) 元の動作を複数の要件で実現する形: 委ねた警告を PC（C1）とモバイル（C2）の 2 つの要件で実現する（どちらも X(D) に入る）→ 両方 D の実現として残る（先の 1 つだけにしない）
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const warns = [{ ...WARN_PLAN_OP, behavior: '備考が空なら警告を出す（PC）', planRefs: ['C1'] }, { ...WARN_PLAN_OP, behavior: '備考が空なら警告を出す（モバイル）', planRefs: ['C2'] }];
  const x = markOn(makeConvC({ scriptFn: D1_SF, labels: LABELS, generate: gen, planImpl: dPlan({ warnFirst: true, warns }) }));
  await x.c.send(REQ); await x.c.send(DELEGATE_U); await x.c.send('採用します');
  const v = x.c.activePlan();
  const sco = scopeOf(x);
  const ws = (sco.requirements || []).filter(q => q.createdBy === 'plan' && (q.effects || []).includes('warn'));
  const g1 = gen.seen.filter(g => g.cid === 'C1' && v && g.version === v.version)[0] || null;
  const g2 = gen.seen.filter(g => g.cid === 'C2' && v && g.version === v.version)[0] || null;
  const html = finalHtml(x);
  assert(ws.length === 2 && ws.every(q => q.basis === 'delegated' && q.via === 'decisionRefs' && q.inScope === true) && !!g1 && !!g2 && effKeys(g1.requiredEffects).includes('memo:warn') && effKeys(g2.requiredEffects).includes('memo:warn') && g1.requiredEffects.some(e => e.effect === 'warn' && (e.requirementIds || []).includes(ws.find(q => q.planRefs.includes('C1')).id)) && g2.requiredEffects.some(e => e.effect === 'warn' && (e.requirementIds || []).includes(ws.find(q => q.planRefs.includes('C2')).id)) && noSave(v && v.plan) && /計画で足した: 「備考」に警告を出します（おまかせにした「備考の警告」の実現として）/.test(shutOf(html)),
    `S8-18: 委ねた警告を PC とモバイルの 2 つの要件で実現 → 両方 D の実現（PC とモバイルの生成の必須の効果に警告）。保存禁止は外れる: ${JSON.stringify({ ws: ws.map(q => [q.id, q.basis, q.planRefs]), c1: g1 && effKeys(g1.requiredEffects), c2: g2 && effKeys(g2.requiredEffects) })}`);
});
//   (d4) 前の確認の K-5（2026-10-10）: 判断の構造がある委任（D1_SF。採用の時点の組 X(D) = 備考・警告。仮案の警告の要件は判断に結び付くだけで customization に結び付かない＝
//   まだ範囲内の要件で実現されていない）で、計画の AI が委ねた警告と混入した保存禁止を、どちらも決定事項の id を付けずに（decisionRefs []）足す。
//   警告の (フィールド, 効果) は X(D) にすべて入るので D の実現（委ねた判断 → delegated・構造の照合）、保存禁止は X(D) に無いので今までどおり planner として外れる。
//   AI の id にも操作の順にも頼らない（どちらの順でも同じ）。印の無い Gateway（decisionRefs が返らない）でも同じ
const dOrders4 = {};
for (const [mark, warnFirst] of [[true, true], [true, false], [false, true]]) {
  await section(async () => {
    const tag = `${mark ? '印あり・id なし' : '印なし'}・${warnFirst ? '警告 → 保存禁止' : '保存禁止 → 警告'}`;
    planCalls.length = 0;
    const gen = recordingGenerate(['good']);
    const conv = makeConvC({ scriptFn: D1_SF, labels: LABELS, generate: gen, planImpl: dPlan({ warnFirst, link: false }) });
    const x = mark ? markOn(conv) : conv;
    await x.c.send(REQ); await x.c.send(DELEGATE_U);
    const asks = x.calls.ask.length;
    await x.c.send('採用します');
    const v = x.c.activePlan();
    const sco = scopeOf(x);
    const warnReq = reqRowOf(sco, q => q.createdBy === 'plan' && (q.effects || []).includes('warn'));
    const saves = (sco.requirements || []).filter(q => ['plan', 'plan-auto'].includes(q.createdBy) && (q.effects || []).includes('block-save'));
    const g1 = gen.seen.filter(g => g.cid === 'C1' && v && g.version === v.version)[0] || null;
    const g2 = gen.seen.filter(g => g.cid === 'C2' && v && g.version === v.version)[0] || null;
    assert(!!warnReq.id && warnReq.basis === 'delegated' && warnReq.via === 'structure' && warnReq.inScope === true && !warnReq.stripped && (warnReq.decisionLinks || []).length === 1 && warnReq.decisionLinks.every(l => l.kind === 'delegated' && l.verdict === 'match' && l.source === 'structure')
      && [g1, g2].every(g => !!g && JSON.stringify(effKeys(g.requiredEffects)) === JSON.stringify(['amount:lock', 'memo:warn']) && g.requiredEffects.some(e => e.field === 'memo' && e.effect === 'warn' && (e.requirementIds || []).includes(warnReq.id))),
      `S8-19（${tag}）: id を付けずに足した委ねた警告は、採用の時点の組 X(D)（備考・警告）にすべて入るので D の実現（delegated・構造の照合・範囲内・PC とモバイルの生成の必須の効果に警告の要件の id つき）: ${JSON.stringify({ warn: [warnReq.id, warnReq.basis, warnReq.via, warnReq.inScope, warnReq.decisionLinks], c1: g1 && effKeys(g1.requiredEffects), c2: g2 && effKeys(g2.requiredEffects) })}`);
    assert(saves.length >= 1 && saves.every(q => q.basis === 'planner' && !q.via && q.inScope === false && q.out === 'adds-effect' && q.stripped === true && !(q.decisionLinks || []).some(l => l.verdict === 'match')) && noSave(v && v.plan) && noSave(v && v.gatewayPlan) && !candidatesOf(v).length,
      `S8-20（${tag}）: id を付けずに足した混入した保存禁止は X(D) に無いので D の実現にしない（planner として範囲外・v.plan と v.gatewayPlan から外す・判断の候補にもしない）: ${JSON.stringify({ saves: saves.map(q => [q.id, q.createdBy, q.basis, q.via, q.inScope, q.out, q.stripped]) })}`);
    const html = finalHtml(x), shut = shutOf(html);
    const sec = (shut.match(/仮案からの補足[\s\S]*?(?=この案の制約|確認できないこと|残る判断|動作テスト環境へ反映|$)/) || [''])[0];
    assert(/計画で足した: 「備考」に警告を出します（おまかせにした「備考の警告」の実現として）/.test(sec) && !/保存/.test((sec.match(/計画で足した:[^\n]*/) || [''])[0]) && !/判断が残っています/.test(shut) && /依頼に無い「[^」]*保存の停止」は入れていません/.test(shut) && !/依頼に無い「[^」]*警告」/.test(shut) && x.calls.ask.length === asks && x.calls.propose.length === 2,
      `S8-21（${tag}）: 通常表示の「仮案からの補足」に「計画で足した」警告を出す（外した保存禁止は「依頼に無い」の 1 行だけ。警告は「依頼に無い」に入れない）。質問・仮案の作り直しは増えない: ${sec.slice(0, 260)}`);
    if (mark) dOrders4[warnFirst ? 'wf' : 'sf'] = dSummaryOf(x, gen);
  });
}
await section(async () => {
  assert(!!dOrders4.wf && !!dOrders4.sf && JSON.stringify(dOrders4.wf) === JSON.stringify(dOrders4.sf), `S8-22: (d4) id を付けない 警告 → 保存禁止 と 保存禁止 → 警告 で結果が同じ（要件の根拠・範囲・生成の必須の効果・計画・通常表示の追加と候補）: ${JSON.stringify(dOrders4)}`);
});
await section(async () => {
  //   (d4) の部品: 構造の照合は、まだ範囲内の要件で実現されていない決定事項だけ。計画の AI が仮案の警告の要件（委任・範囲内）を customization に結び付けて実現したら
  //   （D は実現済み）、id を付けずに別の customization に足した警告は今までどおり planner として判定する（外れる）
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const r6Refs = { ...S8_REFS, R6: { planRefs: ['C1'], effects: ['warn'] } };
  const x = markOn(makeConvC({ scriptFn: D1_SF, labels: LABELS, generate: gen, planImpl: dPlan({ warnFirst: true, link: false, refs: r6Refs, warns: [{ ...WARN_PLAN_OP, behavior: '備考が空なら警告を出す（モバイル）', planRefs: ['C2'] }] }) }));
  await x.c.send(REQ); await x.c.send(DELEGATE_U); await x.c.send('採用します');
  const v = x.c.activePlan();
  const sco = scopeOf(x);
  const r6 = reqRowOf(sco, q => q.id === 'R6');
  const warnReq = reqRowOf(sco, q => q.createdBy === 'plan' && (q.effects || []).includes('warn'));
  const g1 = gen.seen.filter(g => g.cid === 'C1' && v && g.version === v.version)[0] || null;
  assert(r6.basis === 'delegated' && r6.inScope === true && JSON.stringify(r6.planRefs) === '["C1"]' && !!warnReq.id && warnReq.basis === 'planner' && !warnReq.via && !(warnReq.decisionLinks || []).length && warnReq.inScope === false && warnReq.out === 'adds-effect' && !!g1 && effKeys(g1.requiredEffects).includes('memo:warn'),
    `S8-23: D が範囲内の要件（仮案の警告の要件を C1 に結び付けた）で実現済みなら、構造の照合はしない（id の無い C2 の警告は planner として判定）: ${JSON.stringify({ r6: [r6.basis, r6.planRefs], warn: [warnReq.id, warnReq.basis, warnReq.via, warnReq.inScope, warnReq.out, warnReq.decisionLinks] })}`);
});

// =========================================================
console.log('\n--- §S6. 画面: 範囲外を外した customization の生成に渡す requirement の文 ---');
await section(async () => {
  //   レビューの指摘 row1 の D（2026-10-09）: 計画の AI の customization の文（「…保存も止める」）は範囲外の動作を含む。外した customization では、生成工程に送る
  //   customization の requirement と「満たすべき要件」の customization の行を、範囲内の結び付く要件の文（台帳の値）で組み立てた文にする（自然文は読まない）
  const REQ_S = '承認待ちでは金額を変更できなくして';
  const scriptS = ({ utterance: u }) => (u === REQ_S ? { reply: '承認待ちでは金額を編集不可にします。', intent: 'propose', proposal: { behaviors: [B('承認待ちでは金額を変更できなくする', 'user')], assumptions: [], decisions: [], approach: { standard: [], js: ['承認待ちの金額の編集不可'] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [req('add', { target: '金額', condition: '承認待ち', behavior: '金額を編集不可にする', sourceQuotes: [REQ_S], planRefs: ['B1'], effects: ['lock'] })] } } : null);
  const CUST_TEXT = '承認待ちでは金額を編集不可にし、金額の変更を保存時にも止める';
  const rawS = (goal) => { const b = K.PLAN_V1(goal); const c = K.custLock('amount', { requirement: CUST_TEXT, fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock', 'block-save'] }] }); return { ...b, plan: { ...b.plan, solution: 'CUSTOMIZATION', assessment: { ...b.plan.assessment, summary: '承認待ちでは金額を編集不可にし、保存時にも止める計画です。' }, steps: [mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { title: 'JavaScript', solution: 'CUSTOMIZATION' })], customizations: [c] }, turn: { reply: '保存時にも止める計画です。', requirementOps: [{ op: 'update', id: 'R1', target: '金額', condition: '承認待ち', behavior: '金額を編集不可にする', exceptions: [], decision: 'decided', disposition: 'adopted', sourceQuotes: [REQ_S], planRefs: ['C1'], effects: ['lock'], note: '' }], utteranceCoverage: [] } }; };
  const sg = K.screenGenerate({ field: 'amount', targetFile: 'amountLock.js' });
  const m = K.mount({ health: K.HEALTH_V, scriptFn: scriptS, planImpl: K.planImplOf(rawS), generateImpl: sg.impl });
  await K.ticks();
  await m.panel.send(REQ_S); await K.ticks(10);
  await m.panel.send('採用します'); await K.ticks(30);
  const v = m.conv().activePlan();
  const ctx = sg.calls.slice(-1)[0] || null;
  const reqRow = ctx && ctx.verification && Array.isArray(ctx.verification.requirementIds) ? ctx.verification.requirementIds.find(rr => rr.id === 'C1') : null;
  const custText = ctx && ctx.customization ? String(ctx.customization.requirement || '') : '';
  assert(v && strippedOf(v).some(st => st.field === 'amount' && st.effect === 'block-save' && st.reason === 'unattributed') && sg.calls.length >= 1 && ctx, `前提: 画面で範囲外の保存禁止（fields[].effects だけ）を外して生成した: ${JSON.stringify({ stripped: strippedOf(v), gen: sg.calls.length })}`);
  assert(custText.includes(REQ_S) && !custText.includes('保存') && reqRow && reqRow.text.includes(REQ_S) && !/保存/.test(reqRow.text) && v.plan.customizations[0].requirement === CUST_TEXT, `S6-1: 生成工程に送る customization の requirement と「満たすべき要件」の customization の行は、範囲内の要件の文（利用者の原文の引用）。計画の文は書き換えない: ${JSON.stringify({ custText, reqRow })}`);
  assert(ctx && (ctx.verification.requiredEffects || []).every(e => e.effect !== 'block-save'), 'S6-2: 必須の効果にも保存禁止は無い');
});

// =========================================================
console.log('\n--- §S6b. 画面: ［残りの JavaScript を作る］（GENERATE_CODE）で作り直した版も、範囲の記録と生成に渡す requirement の文を引き継ぐ（K-4・2026-10-10） ---');
await section(async () => {
  //   AI版 sandbox/test/scenarios.mjs §7j の前の known() の K-4: GENERATE_CODE は計画の写し（元の版の外した後の計画）で版を上げる。上げた版で照合し直すと
  //   外す効果がもう無いので記録が空になり、生成に渡す requirement が計画の元の文（範囲外の「保存時にも止める」を含む）に戻っていた。
  //   最初の生成が時間切れで止まった最終案から［残りの JavaScript を作る］（m.panel.generate）で作り直す（計画の AI は呼ばない）
  const REQ_S = '承認待ちでは金額を変更できなくして';
  const scriptS = ({ utterance: u }) => (u === REQ_S ? { reply: '承認待ちでは金額を編集不可にします。', intent: 'propose', proposal: { behaviors: [B('承認待ちでは金額を変更できなくする', 'user')], assumptions: [], decisions: [], approach: { standard: [], js: ['承認待ちの金額の編集不可'] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [req('add', { target: '金額', condition: '承認待ち', behavior: '金額を編集不可にする', sourceQuotes: [REQ_S], planRefs: ['B1'], effects: ['lock'] })] } } : null);
  const CUST_TEXT = '承認待ちでは金額を編集不可にし、金額の変更を保存時にも止める';
  const rawS = (goal) => { const b = K.PLAN_V1(goal); const c = K.custLock('amount', { requirement: CUST_TEXT, fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock', 'block-save'] }] }); return { ...b, plan: { ...b.plan, solution: 'CUSTOMIZATION', assessment: { ...b.plan.assessment, summary: '承認待ちでは金額を編集不可にし、保存時にも止める計画です。' }, steps: [mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { title: 'JavaScript', solution: 'CUSTOMIZATION' })], customizations: [c] }, turn: { reply: '保存時にも止める計画です。', requirementOps: [{ op: 'update', id: 'R1', target: '金額', condition: '承認待ち', behavior: '金額を編集不可にする', exceptions: [], decision: 'decided', disposition: 'adopted', sourceQuotes: [REQ_S], planRefs: ['C1'], effects: ['lock'], note: '' }], utteranceCoverage: [] } }; };
  const sg = K.screenGenerate({ field: 'amount', targetFile: 'amountLock.js' });
  const sent = [];   // 生成工程に送った Context（時間切れにした最初の 1 回も含む）
  let timedOut = 0;
  const genImpl = async (a) => {
    sent.push(clone(a.ctx));
    if (!timedOut) { timedOut += 1; throw new T.KTAiClient.AiClientError({ code: T.KTAiClient.ERROR_CODES.TIMEOUT, message: 'AI サービスが応答しませんでした（テストの時間切れ）' }); }
    return sg.impl(a);
  };
  const m = K.mount({ health: K.HEALTH_V, scriptFn: scriptS, planImpl: K.planImplOf(rawS), generateImpl: genImpl });
  await K.ticks();
  await m.panel.send(REQ_S); await K.ticks(10);
  await m.panel.send('採用します'); await K.ticks(30);
  const v0 = m.conv().activePlan();
  const scoped = v0 && v0.scopeRequirementText ? v0.scopeRequirementText.C1 : null;
  const recOf = (v) => (v ? JSON.stringify({ stripped: v.scopeStripped || null, issues: v.scopeIssues || null, candidates: v.scopeCandidates || null, reqText: v.scopeRequirementText || null, linked: v.scopeLinked || null }) : null);
  const rec0 = recOf(v0);
  const sco0 = scopeOf({ c: m.conv() }, v0 && v0.planId);
  assert(v0 && timedOut === 1 && sent.length === 1 && !(v0.generated && v0.generated.C1 && v0.generated.C1.status === 'verified') && strippedOf(v0).some(st => st.field === 'amount' && st.effect === 'block-save' && st.reason === 'unattributed') && typeof scoped === 'string' && scoped.includes(REQ_S) && !/保存/.test(scoped) && sent[0].customization.requirement === scoped,
    `前提: 範囲外の保存禁止を外した版で、最初の生成（範囲内の要件の文で送った）は時間切れで止まった: ${JSON.stringify({ version: v0 && v0.version, stripped: strippedOf(v0), scoped, sent: sent.map(x => x.customization.requirement) })}`);
  const plans0 = m.calls.plan.length;
  await m.panel.send('コードを作って'); await K.ticks(30);
  const v1 = m.conv().activePlan();
  const ctx1 = sent.length > 1 ? sent[sent.length - 1] : null;
  const custText = ctx1 && ctx1.customization ? String(ctx1.customization.requirement || '') : '';
  const reqRow = ctx1 && ctx1.verification && Array.isArray(ctx1.verification.requirementIds) ? ctx1.verification.requirementIds.find(rr => rr.id === 'C1') : null;
  assert(v1 && v0 && v1 !== v0 && v1.planId === v0.planId && v1.version === v0.version + 1 && m.calls.plan.length === plans0 && !!ctx1 && ctx1.plan && ctx1.plan.version === v1.version,
    `S6b-1 前提: ［残りの JavaScript を作る］は計画の AI を呼ばずに版を上げ、上げた版で C1 を生成し直した: ${JSON.stringify({ versions: [v0 && v0.version, v1 && v1.version], plans: m.calls.plan.length - plans0, gen: sent.length })}`);
  assert(custText === scoped && reqRow && reqRow.text.includes(REQ_S) && !/保存/.test(reqRow.text) && v1 && v1.plan.customizations[0].requirement === CUST_TEXT,
    `S6b-2: 作り直した版の生成に渡す customization の requirement と「満たすべき要件」の行は、範囲内の要件の文のまま（計画の元の文「…保存時にも止める」に戻らない。計画の文は書き換えない）: ${JSON.stringify({ custText, reqRow })}`);
  assert(v1 && recOf(v1) === rec0 && strippedOf(v1).length === strippedOf(v0).length && (ctx1.verification.requiredEffects || []).every(e => e.effect !== 'block-save'),
    `S6b-3: 作り直した版は元の版の範囲の記録（外した効果・説明に残りうる customization・判断の候補・生成に渡す requirement の文・決定事項の実現として足した動作）を引き継ぐ。必須の効果にも保存禁止は無い: ${JSON.stringify({ v0: rec0, v1: recOf(v1) })}`);
  const sco1 = scopeOf({ c: m.conv() }, v1 && v1.planId);
  assert(sco0.scopeStripped > 0 && sco1.scopeStripped === sco0.scopeStripped && sco1.scopeIssues === sco0.scopeIssues,
    `S6b-4: 読み取り（requirementScope。その系列の最新の版）の外した効果・説明に残りうる customization の数も、作り直した版で 0 に戻らない: ${JSON.stringify({ before: [sco0.scopeStripped, sco0.scopeIssues], after: [sco1.scopeStripped, sco1.scopeIssues] })}`);
});

// =========================================================
console.log('\n--- §S9. 画面: 判断の候補は最終案の通常表示と承認の欄の確認項目に一度に出す（再検証前の指示 §1・§2） ---');
await section(async () => {
  //   仮案の判断「案件名の警告」を「そちらで決めて」と委ね（要件は作らない）、計画の AI が警告を proposed で足す（印の無い Gateway・未実現の委任）。
  //   警告は黙って入れず（生成の必須の効果に入らない）、黙って消さず（最終案の通常表示と承認の欄の確認項目に同じ文を一度に出す）。別のカード・質問は増えない
  const REQ_9 = '承認待ちでは金額を変更できなくして';
  const DEL_9 = '案件名の警告を出すかは、そちらで決めてください';
  const Q9 = Q('lock.warn', '案件名の警告', '差戻し後に案件名が空のとき警告を出しますか', ['出す', '出さない'], '出す', '差戻し後の入力の案内が変わります', false);
  const B9 = B('承認待ちでは金額を変更できなくする', 'user');
  const script9 = ({ utterance: u, previous: p }) => {
    if (u === REQ_9) return { reply: '承認待ちでは金額を編集不可にします。', intent: 'propose', proposal: { behaviors: [B9], assumptions: [], decisions: [Q9], approach: { standard: [], js: ['承認待ちの金額の編集不可'] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [req('add', { target: '金額', condition: '承認待ち', behavior: '金額を編集不可にする', sourceQuotes: [REQ_9], planRefs: ['B1'], effects: ['lock'] })] } };
    if (u === DEL_9) return { reply: '案件名の警告は出す形で進めます。', intent: 'update', proposal: { behaviors: [B9], assumptions: [A('lock.warn', '案件名の警告', '差戻し後に案件名が空なら警告を出す', '出さないこともできます')], decisions: [], approach: { standard: [], js: ['承認待ちの金額の編集不可'] }, cannot: [] }, turn: { ops: [], answers: [{ id: K.idBy(p && p.decisions, d => d.key === 'lock.warn'), kind: 'delegated', text: '', quote: DEL_9 }], requirementOps: [] } };
    return null;
  };
  const raw9 = (goal) => { const b = K.PLAN_V1(goal); const c = K.custLock('amount', { requirement: '承認待ちでは金額を編集不可にし、差戻し後に案件名が空なら警告を出す', fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock'] }, { code: 'case_name', access: 'CONTROL', condition: 'ステータス in ("作成中")', effects: ['warn'] }] });
    return { ...b, plan: { ...b.plan, solution: 'CUSTOMIZATION', assessment: { ...b.plan.assessment, summary: '承認待ちでは金額を編集不可にします。' }, steps: [mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { title: 'JavaScript', solution: 'CUSTOMIZATION' })], customizations: [c] },
      turn: { reply: '承認待ちでは金額を編集不可にします。', requirementOps: [{ op: 'update', id: 'R1', target: '金額', condition: '承認待ち', behavior: '金額を編集不可にする', exceptions: [], decision: 'decided', disposition: 'adopted', sourceQuotes: [REQ_9], planRefs: ['C1'], effects: ['lock'], note: '' }, { op: 'add', target: '案件名', condition: '差戻し後', behavior: '案件名が空なら警告を出す', exceptions: [], decision: 'proposed', disposition: 'adopted', sourceQuotes: [], planRefs: ['C1'], effects: ['warn'], note: '' }], utteranceCoverage: [] } }; };
  const sg = K.screenGenerate({ field: 'amount', targetFile: 'amountLock.js' });
  const m = K.mount({ health: K.HEALTH_V, scriptFn: script9, planImpl: K.planImplOf(raw9), generateImpl: sg.impl });
  await K.ticks();
  await m.panel.send(REQ_9); await K.ticks(10);
  await m.panel.send(DEL_9); await K.ticks(10);
  const asks = m.calls.ask.length;
  await m.panel.send('採用します'); await K.ticks(30);
  const v = m.conv().activePlan();
  const ctx = sg.calls.slice(-1)[0] || null;
  await K.waitUntil(() => m.panel.finalPrecheck().status === 'ready', 60);
  const pre = m.panel.finalPrecheck();
  const confs = ((pre.items && pre.items.confirmations) || []).map(x => (typeof x === 'string' ? x : x.text));
  const chat = stripC(m.chat().replace(/<details[\s\S]*?<\/details>/g, ''));
  const SENT = 'おまかせにした「案件名の警告」は、計画の案と結び付けを確かめられないため、まだ入れていません。計画の案: 「案件名」に警告を出す。入れるものを伝えてください';
  assert(!!v && candidatesOf(v).length === 1 && !!ctx && (ctx.verification.requiredEffects || []).every(e => e.effect !== 'warn') && v.final && FS.readyOf(v), `S9-1 前提: 画面で委ねた警告（計画の AI の proposed）は判断の候補（生成の必須の効果に入らない・最終案は承認できる）: ${JSON.stringify({ cand: v && candidatesOf(v), req: ctx && ctx.verification.requiredEffects })}`);
  const changedSec = (chat.match(/仮案からの補足[\s\S]*?(?=この案の制約|確認できないこと|残る判断|動作テスト環境へ反映|$)/) || [''])[0];
  assert(changedSec.includes(`判断が残っています${SENT}`) && changedSec.split(SENT).length === 2 && confs.filter(t => t === `判断が残っています（この最終案には入っていません）: ${SENT}`).length === 1 && m.calls.ask.length === asks && m.msgs().filter(x => x.type === 'FINAL').length === 1,
    `S9-2: 最終案の通常表示（仮案からの補足）と承認の欄の確認項目に、判断が残っていることを同じ文で 1 回ずつ示す（別のカード・質問は増えない）: ${JSON.stringify({ confs, sec: changedSec.slice(0, 260) })}`);
});

// =========================================================
console.log('\n--- §S10（2026-10-18）採用内容の欠落の区別: 仮案の id の振り直しで、結び付きの欠落だけを理由に黙って入れない・黙って消さない ---');
//   仮案の AI は項目の id を毎回 B1… と振り直す。要件が記録した planRefs は、その要件を操作したターンの id のまま（別の項目の id と同じ文字になることもある）。
//   結び付きは台帳の「仮案の項目 id → 要件 id」の対応（同じ文の項目・利用者の言い換え・判断の key・そのターンの要件の操作で引き継ぐ）だけで決める（文の似ているかは見ない・AI を呼ばない）。
//   区別: (a) 未採用の任意の提案は計画に入れない（理由を出さない。設計どおり）／(b) 採用した内容を引き継げない（結び付きが切れた）ときは、計画に入れず・取り消さず、
//   最終案に「結び付かない提案」として件数を出す／(c) 書き込み手順に必要な値が無い手順は、反映の分類 NO_VALUES で止める（ai-flow-redesign の §7p・0b8e38e）
await section(async () => {
  const U1 = '承認待ちでは金額を編集できないようにしたい';
  const LOCK = B('承認待ちでは金額を編集できないようにする', 'user');
  const ITEMS = B('明細の金額も承認待ちでは編集できないようにする', 'ai');
  const SUG = B('保存するときに確認のメッセージを出す', 'suggestion');
  const R_LOCK = req('add', { target: '金額', condition: '承認待ち', behavior: '編集できないようにする', sourceQuotes: [U1], planRefs: ['B1'], effects: ['lock'] });
  const R_ITEMS = (ref) => req('add', { target: '明細', condition: '承認待ち', behavior: '明細の金額も編集できないようにする', decision: 'proposed', sourceQuotes: [], planRefs: [ref], effects: ['lock'] });
  const R_SUG = (ref) => req('add', { target: '保存', condition: '', behavior: '確認のメッセージを出す', decision: 'proposed', sourceQuotes: [], planRefs: [ref] });
  const turn1 = (behaviors, ops) => ({ reply: '仮案です。', intent: 'propose', proposal: { behaviors, assumptions: [], decisions: [], approach: { standard: [], js: ['JavaScript で制御する'] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: ops } });
  const turn2 = (behaviors, ops = []) => ({ reply: '仮案を直しました。', intent: 'update', proposal: { behaviors, assumptions: [], decisions: [], approach: { standard: [], js: ['JavaScript で制御する'] }, cannot: [] }, turn: { ops, answers: [], requirementOps: [] } });
  const run = async (t1, t2) => {
    const sent = [];
    const scriptFn = ({ utterance: u }) => (u === U1 ? t1 : /保存/.test(u) ? t2 : null);
    const x = makeConvC({ scriptFn, planImpl: (args) => { sent.push((args.requirements || []).map(r => r.id)); return K.planJs(args); } });
    await x.c.send(U1);
    await x.c.send('保存の確認も入れて');
    const r = await x.c.send('この案で進めて');
    const v = x.c.activePlan();
    const decisionOf = (id) => (x.c.requirements(v.planId).find(q => q.id === id) || {}).decision || null;
    return { r, v, sent: sent[0] || [], unlinked: ((v && v.final && v.final.unlinkedReqs) || []).map(u => u.requirementId), unconfirmed: ((v && v.final && v.final.unconfirmedReqs) || []).map(u => u.requirementId), decisionOf };
  };
  //   (1) 2 回目の仮案で任意の提案が間に入り、AI の項目（明細の編集不可）が B2 → B3 にずれた。R2 の planRefs は B2 のまま（今は任意の提案の id）
  const a = await run(turn1([LOCK, ITEMS], [R_LOCK, R_ITEMS('B2')]), turn2([LOCK, SUG, ITEMS]));
  assert(a.r.intent === 'ADOPT_DRAFT' && a.sent.includes('R2') && a.unconfirmed.includes('R2') && !a.unlinked.includes('R2'),
    `S10-1: 採用した AI の項目の要件は、記録した planRefs が今は任意の提案の id でも、台帳の対応で採用の範囲に入り、計画の AI に渡す（担当の確認の対象。黙って消さない）: ${JSON.stringify({ sent: a.sent, unconfirmed: a.unconfirmed, unlinked: a.unlinked })}`);
  //   (2) 逆: 記録した planRefs は今は利用者の項目の id だが、台帳の対応では任意の提案だけに結び付く → 未採用の任意の提案（計画に入れない・理由は出さない）
  const b = await run(turn1([SUG, LOCK], [{ ...R_LOCK, planRefs: ['B2'] }, R_SUG('B1')]), turn2([LOCK, SUG]));
  assert(b.r.intent === 'ADOPT_DRAFT' && !b.sent.includes('R2') && !b.unlinked.includes('R2') && !b.unconfirmed.includes('R2') && b.decisionOf('R2') === 'proposed',
    `S10-2: 台帳の対応で任意の提案だけに結び付く要件は、記録した planRefs が利用者の項目の id を指しても計画に入れない（未採用の任意の提案。取り消しもしない）: ${JSON.stringify({ sent: b.sent, unlinked: b.unlinked, unconfirmed: b.unconfirmed })}`);
  //   (3) 利用者が任意の提案を入れると伝え（adopt）、AI が項目の文を言い換えた。要件の操作は無い（対応が切れる）→ 前の「任意の提案」の根拠のまま黙って外さない
  const c = await run(turn1([LOCK, SUG], [R_LOCK, R_SUG('B2')]), turn2([LOCK, B('保存時に確認メッセージを表示する', 'user')], [{ id: 'B2', op: 'adopt', text: '', quote: '保存の確認も入れて' }]));
  assert(c.r.intent === 'ADOPT_DRAFT' && !c.sent.includes('R2') && c.unlinked.includes('R2') && c.decisionOf('R2') === 'proposed',
    `S10-3: 採用した内容を引き継げない（項目の文が変わり対応が切れた）要件は、計画に入れず・取り消さず、最終案に「結び付かない提案」として出す（入れるかは利用者が伝える）: ${JSON.stringify({ sent: c.sent, unlinked: c.unlinked, decision: c.decisionOf('R2') })}`);
  //   (4) AI が 2 回目の仮案から項目を黙って落とした（利用者は断っていない）→ 前の採用の根拠のまま、もう見えない項目の要件を計画に入れない
  const d = await run(turn1([LOCK, ITEMS], [R_LOCK, R_ITEMS('B2')]), turn2([LOCK]));
  assert(d.r.intent === 'ADOPT_DRAFT' && !d.sent.includes('R2') && d.unlinked.includes('R2') && d.decisionOf('R2') === 'proposed',
    `S10-4: 仮案から消えた項目の要件は、採用の時点に結び付く項目が無いので計画に入れず・取り消さず、最終案に「結び付かない提案」として出す: ${JSON.stringify({ sent: d.sent, unlinked: d.unlinked, decision: d.decisionOf('R2') })}`);
});

console.log(`\n${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
