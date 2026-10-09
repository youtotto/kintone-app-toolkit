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
//   §S7 決定事項の結び付き decisionRefs（設計 §0f.2 の 9・契約 16 §12。前の確認の newProblems の medium）: 印（health の change-planner の requirementOps）がある
//        Gateway では、未実現の委任があっても、計画の AI が委ねた判断の id を decisionRefs に付けた警告だけを delegated（範囲内）にし、decisionRefs [] の混入した
//        保存禁止は外す（v.plan・v.gatewayPlan・台帳・生成の必須の効果）。印の無い古い Gateway は今の possible の扱い（外さずに詳細に出す）。
//        計画の段階の「おすすめで」（推奨を採用・推奨の無い確認事項の委任）でも同じ（reviseWith の delegatedWork の置き換え）。画面の health の印と送る決定事項の印
//
//   修正前の版（KT_SRC）でも例外で止めずに各 assert を評価する（読み取りの関数が無い版では空の読み取りで落ちる）。§S2 は最初の計画・自動の見直し・差分更新の
//   3 つの section に分けている（前の section が落ちても後の assert を評価する）
//
// 実行方法: node tests/ai-realrun-scope.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTAiConversation, KTAiChatUi } = T;
const { assert, state } = makeAssert();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { clone, B, A, Q, req, mkStep, makeConvC, makeGenerate, stripC, finalHtml } = K;
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
const LABELS = { ...K.LABELS_C, items: '明細' };
//   レビューの指摘 row2（2026-10-09）: 修正前の版（読み取りの関数・記録が無い）でも例外で止めない読み取り
const EMPTY_SCOPE = { adopted: false, adoption: null, requirements: [], scopeStripped: 0, scopeIssues: 0, stripped: [], possible: [], delegationOpen: null };
const scopeOf = (x, id) => (x && x.c && typeof x.c.requirementScope === 'function' ? x.c.requirementScope(id) : null) || EMPTY_SCOPE;
const inScopeIdsOf = (x, planId) => (typeof x.c.requirementsInScope === 'function' ? x.c.requirementsInScope(planId) : x.c.requirements(planId)).map(q => q.id);
const strippedOf = (v) => (v && Array.isArray(v.scopeStripped) ? v.scopeStripped : []);
const issuesOf = (v) => (v && Array.isArray(v.scopeIssues) ? v.scopeIssues : []);
const possibleOf = (v) => (v && Array.isArray(v.scopePossible) ? v.scopePossible : []);

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
  const upd = (id, base) => { const x = refs[id]; const r = sent.get(id) || { ...base, exceptions: [], decision: 'proposed' }; return { op: 'update', id, target: r.target, condition: r.condition, behavior: r.behavior, exceptions: r.exceptions || [], decision: r.decision === 'revoked' ? 'proposed' : r.decision, disposition: 'adopted', sourceQuotes: [], planRefs: x.planRefs, effects: x.effects, note: '' }; };
  const BASES = { R1: R_LOCK, R2: R_BACK, R3: R_CHECK, R4: R_SAVE, R5: R_STATUS, R6: R_WARN };
  const ops = [
    ...Object.keys(refs).map(id => upd(id, BASES[id])),
    // 別 ID の proposed の要件（対象は金額と明細・保存禁止。C1・C2 に結び付く）
    { op: 'add', target: saveTarget, condition: '承認済み', behavior: `金額・明細の変更を保存時に止める（${label}）`, exceptions: [], decision: 'proposed', disposition: 'adopted', sourceQuotes: [], planRefs: ids.filter(id => id !== 'C3'), effects: ['block-save'], note: '' },
    // 依頼を実現するための手順（効果 []。計画の AI が足した提案）
    { op: 'add', target: 'プロセス管理', condition: '', behavior: `部長承認待ちへ進むアクションを追加する（${label}）`, exceptions: [], decision: 'proposed', disposition: 'adopted', sourceQuotes: [], planRefs: ['P1'], effects: [], note: '' },
  ];
  return { plan, ctx: null, gatewayPlan: clone(plan), turn: { reply: '明細の行の追加・削除ボタン自体は止められないため、承認済みではセルを編集不可にし、行の変更を含む変更は保存時に検出して止める計画です。', requirementOps: ops, utteranceCoverage: [] },
    review: { base: { baseVersion: '1', env: 'preview', ok: true, fingerprint: 'fp-1', revision: { preview: '10' } }, steps: custs.map(c => ({ stepId: c.customizationId, status: 'VALID', safety: 'PLAN_ONLY', customization: clone(c), codeGeneration: { supported: true, strategy: c.strategy, reason: null }, issues: [] })), executionReadiness: { safeSteps: [], reviewSteps: [], blockedSteps: [], planOnlySteps: custs.map(c => c.customizationId) }, warnings: [] } };
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
  const requirementScopeOf = (...a) => { const s = scopeFn ? scopeFn(...a) || {} : {}; return { inIds: s.inIds || new Set(), out: s.out || new Map(), eIn: s.eIn || new Map(), undetermined: s.undetermined || new Set(), eInField: s.eInField || null, noMaterial: s.noMaterial || new Map(), possible: s.possible || new Map() }; };
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
  const sc5 = requirementScopeOf([r('R1', 'explicit', ['lock'], ['C1'], 'decided'), r('R2', 'planner', ['warn'], ['C1'])], P, { delegationOpen: true });
  assert(sc5.inIds.has('R2') && sc5.possible.get('R2') && sc5.possible.get('R2').reason === 'delegation' && !sc5.out.has('R2') && requirementScopeOf([r('R1', 'explicit', ['lock'], ['C1'], 'decided'), r('R2', 'planner', ['warn'], ['C1'])], P).out.has('R2'), 'S0-8: 未実現の委任があるときだけ、E_in に無い効果を足す計画の AI の要件を外さずに「委任の実現の可能性」として中に残す（無ければ今までどおり外）');
  //   §0f.2 の 9（2026-10-09）: 計画の段階の委任は、その版（possibleSince）より後に作った・直した計画の AI の追加だけを可能性の扱いにする（前の版で外した追加を戻さない）
  const sc6 = requirementScopeOf([r('R1', 'explicit', ['lock'], ['C1'], 'decided'), { ...r('R2', 'planner', ['block-save'], ['C1']), createdIn: 1, updatedIn: 1 }, { ...r('R3', 'planner', ['warn'], ['C1']), createdIn: 3, updatedIn: 3 }, { ...r('R4', 'planner', ['block-save'], ['C1']), createdIn: 1, updatedIn: 3 }], P, { delegationOpen: true, possibleSince: 3 });
  assert(sc6.out.has('R2') && !!sc6.possible.get('R3') && !!sc6.possible.get('R4') && !sc6.possible.has('R2'), `S0-9: 計画の段階の委任（possibleSince 3）: 前の版の追加（R2）は今までどおり外・その版より後に作った・直した追加（R3・R4）だけが可能性: ${JSON.stringify({ out: [...sc6.out.keys()], possible: [...sc6.possible.keys()] })}`);
});

// =========================================================
console.log('\n--- §S1. 仮案の段階: 効果を足す ai の項目は任意の提案の節へ ---');
await section(async () => {
  planCalls.length = 0;
  const x = makeConvC({ scriptFn: scopeScript, labels: LABELS, planImpl: planImplOf({ refs: REFS_MAIN }) });
  await x.c.send(REQ);
  const d = x.c.draft();
  const card = KTAiChatUi.messageHtml(x.c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], { draft: d, draftDecisions: x.c.draftDecisions() });
  const [mainPart, sugPart = ''] = card.split('任意の提案（入れるときは伝えてください）');
  assert(sugPart.includes(B_SAVE_AI) && !mainPart.includes(B_SAVE_AI) && mainPart.includes(B_STATUS_AI) && mainPart.includes(B_LOCK_U), `S1-1: 利用者の要件に無い保存禁止を足す ai の項目は任意の提案の節に出す（効果を足さない ai の項目は本体）: ${stripC(card).slice(0, 500)}`);
  assert(/（AI が補足・採用すると入ります）/.test(mainPart) && !/（提案）/.test(card) && !/（AI が補足/.test(sugPart), 'S1-2: 採用に入る ai の項目の印は「（AI が補足・採用すると入ります）」（「（提案）」は出さない）');
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
  const v2 = x.c.activePlan();
  const v1 = (v2 && x.c.planHistory().find(v => v.planId === v2.planId && v.version === 1)) || null;
  Object.assign(S2, { asksBefore, v1, v2 });
  assert(r.intent === 'ADOPT_DRAFT' && planCalls.length === 2 && !planCalls[0].revision && planCalls[1].revision && !!v2 && v2.version === 2, `S2-0: 採用 → 最初の計画 → 範囲外を外した customization を自動の見直し 1 回（既存の上限の中）→ 最終案: ${JSON.stringify(planCalls.map(p => p.revision))}`);
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
  //   §S2 の 2 つ目: 自動の見直し（最初の計画の section の会話を続けて使う）
  const { x, gen, v2, asksBefore } = S2;
  const p1 = S2.planCalls ? S2.planCalls[1] : null;
  if (!x || !v2 || !p1) { assert(false, `S2-4: 前提: 自動の見直しの依頼と最終案の版がある: ${JSON.stringify({ x: !!x, v2: !!v2, p1: !!p1 })}`); return; }
  // 台帳: 外になる（台帳の decision は変えない）。計画の AI へは revoked として渡す（任意の提案の扱いの要件は渡さない）
  const sentOf = (id) => (p1.requirements.find(q => q.id === id) || null);
  assert(sentOf('R7') && sentOf('R7').decision === 'revoked' && !sentOf('R4') && sentOf('R5') && sentOf('R5').decision === 'proposed' && sentOf('R6') && sentOf('R6').decision === 'proposed' && sentOf('R8') && sentOf('R8').decision === 'proposed' && sentOf('R1').decision === 'decided', `S2-4: 自動の見直しに送る要件: 範囲外の追加は revoked・任意の提案の扱いは渡さない・委任した設定と実現の手順はそのまま: ${JSON.stringify(p1.requirements.map(q => [q.id, q.decision]))}`);
  assert(/外してください/.test(p1.request) && /C1: amount \/ block-save/.test(p1.request) && /R7/.test(p1.request) && !/effects（\[\{ effect/.test(p1.request) && /block-save/.test(p1.request), `S2-5: 自動の見直しの依頼文に構造化した「外す」指示（customization・フィールド・効果・要件）: ${p1.request}`);
  assert(/assessment\.summary/.test(p1.request) && /reply/.test(p1.request) && /書き直して/.test(p1.request), `S2-5b: 「外す」指示に計画の要約（assessment.summary）と返答（reply）の書き直しも含める（レビューの指摘 row1 の D）: ${String(p1.request || '').slice(0, 300)}`);
  assert(noSaveIn(p1.previousPlan) && JSON.stringify(fieldOf(p1.previousPlan, 'C3', 'amount').effects) === JSON.stringify(['block-save']), 'S2-6: 自動の見直しの土台の計画（previousPlan）にも未採用の保存禁止は無い（外した後の計画。C3 の入力チェックは残る）');
  // 自動の見直しでも同じ提案が戻る → 同じく外す
  assert(noSave(v2.plan) && noSave(v2.gatewayPlan) && strippedOf(v2).length === 4 && strippedOf(v2).every(s => s.requirementIds.includes('R9')), `S2-7: 自動の見直しで戻った保存禁止（別 ID の R9）も外す: ${JSON.stringify(strippedOf(v2))}`);
  // 生成: 必須の効果と customization に block-save が無い（C1・C2）。委任した警告は残る。C3 の入力チェックの移植は残る
  const genV2 = gen.seen.filter(g => g.version === 2);
  const g1 = genV2.find(g => g.cid === 'C1'), g2 = genV2.find(g => g.cid === 'C2'), g3 = genV2.find(g => g.cid === 'C3');
  assert(g1 && g2 && g3 && JSON.stringify(effKeys(g1.requiredEffects)) === JSON.stringify(['amount:lock', 'memo:warn']) && JSON.stringify(effKeys(g2.requiredEffects)) === JSON.stringify(['amount:lock', 'memo:warn']) && !effectsOfCust(g1.customization).some(k => /block-save/.test(k)) && !effectsOfCust(g2.customization).some(k => /block-save/.test(k)), `S2-8: 生成に渡す必須の効果と customization に未採用の保存禁止が無い（委任した警告は残る）: ${JSON.stringify(genV2.map(g => [g.cid, effKeys(g.requiredEffects), effectsOfCust(g.customization)]))}`);
  assert(g3 && JSON.stringify(effKeys(g3.requiredEffects)) === JSON.stringify(['amount:block-save']) && JSON.stringify(effectsOfCust(g3.customization)) === JSON.stringify(['amount:block-save']), `S2-9: C3（既存の入力チェックの移植）の block-save は残る: ${JSON.stringify(g3 && g3.requiredEffects)}`);
  assert(!!g1 && g1.requiredEffects.some(e => e.field === 'memo' && e.effect === 'warn' && (e.requirementIds || []).includes('R6')) && g1.requiredEffects.some(e => e.field === 'amount' && e.effect === 'lock' && (e.requirementIds || []).includes('R1')), `S2-10: 委任した設定（R6・警告）と利用者の編集不可（R1）は要件の id つきで必須の効果に残る: ${JSON.stringify(g1 ? g1.requiredEffects.map(e => [e.field, e.effect, e.requirementIds]) : null)}`);
  // 台帳の読み取り（本文なし）
  const sco = scopeOf(x);
  const row = (id) => sco.requirements.find(q => q.id === id) || {};
  assert(row('R1').basis === 'explicit' && row('R6').basis === 'delegated' && row('R5').basis === 'item-ai' && row('R5').inScope && row('R6').inScope && row('R4').basis === 'suggestion' && !row('R4').inScope && row('R7').basis === 'planner' && row('R7').createdBy === 'plan' && !row('R7').inScope && row('R7').out === 'adds-effect' && row('R9').createdBy === 'plan-auto' && row('R8').basis === 'planner' && row('R8').inScope && row('R7').stripped === true && row('R9').stripped === true && row('R1').stripped === false && sco.scopeStripped === 4 && sco.scopeIssues === 2, `S2-11: 台帳の読み取り（根拠・作った段階・範囲・外したか・外した数）: ${JSON.stringify(sco.requirements.map(q => [q.id, q.decision, q.basis, q.createdBy, q.inScope, q.out, q.stripped]))}`);
  assert(!JSON.stringify(sco).includes(R_SAVE.behavior) && !JSON.stringify(sco).includes(REQ), 'S2-12: 読み取りは本文（要件の文・利用者の発言）を返さない');
  const ids = inScopeIdsOf(x, v2.planId);
  assert(!ids.includes('R4') && !ids.includes('R7') && !ids.includes('R9') && ['R1', 'R2', 'R3', 'R5', 'R6', 'R8'].every(id => ids.includes(id)), `S2-13: 生成の「満たすべき要件」（画面の requirementIds）に使う範囲内の要件: ${ids.join(',')}`);
  // 最終案: 範囲外の要件を「担当が計画にありません」に出さない。詳細に「依頼に無い可能性がある動作」
  const html = finalHtml(x);
  assert(!JSON.stringify((v2.final || {}).outOfScope || []).includes('保存を止める') && /依頼に無い可能性がある動作（2 件）/.test(html) && /<details class="kt-ai-tech kt-ai-final-scope-out"/.test(html) && /「金額」を保存を止める/.test(stripC(html)), `S2-14: 最終案は範囲外の要件を担当なしに出さず、詳細に外した動作を出す: ${(stripC(html).match(/依頼に無い可能性[\s\S]{0,200}/) || [''])[0]}`);
  // 質問が増えない
  assert(x.calls.ask.length === asksBefore && x.calls.propose.length === 2 && !(v2.openQuestions || []).length && !x.c.messages().some(m => m.data && /question/.test(String(m.data.kind || ''))), 'S2-15: 範囲外の保存禁止を利用者に断らせない（質問・仮案の作り直しを増やさない）');
});
await section(async () => {
  //   §S2 の 3 つ目: 差分更新（同じ会話を続けて使う）
  const { x, gen, asksBefore } = S2;
  if (!x || !x.c.activePlan()) { assert(false, 'S2-16: 前提: 差分更新する最終案がある'); return; }
  // 差分更新でも同じ提案が戻る → 同じく外す。自動の見直しはもう依頼しない（同じ customization は系列ごとに 1 回）
  const genBefore = gen.seen.length;
  const plansBefore = planCalls.length;
  await x.c.send('警告の文は「備考を入力してください」にして');
  const v3 = x.c.activePlan();
  const p2 = planCalls[plansBefore] || { revision: false, request: '', requirements: [], previousPlan: null, goal: null };
  assert(planCalls.length === 3 && p2.revision && !/外してください/.test(p2.request) && v3.version === 3 && noSave(v3.plan) && noSave(v3.gatewayPlan) && strippedOf(v3).length === 4 && strippedOf(v3).every(s => s.requirementIds.includes('R11')), `S2-16: 差分更新で戻った保存禁止も外す（自動の見直しは増やさない）: ${JSON.stringify({ plans: planCalls.length, stripped: strippedOf(v3) })}`);
  assert(['R7', 'R9'].every(id => (p2.requirements.find(q => q.id === id) || {}).decision === 'revoked') && !p2.requirements.some(q => q.id === 'R4') && noSaveIn(p2.previousPlan), `S2-17: 差分更新に送る要件でも範囲外は revoked・土台の計画にも保存禁止は無い: ${JSON.stringify(p2.requirements.map(q => [q.id, q.decision]))}`);
  const genV3 = gen.seen.slice(genBefore);
  assert(genV3.every(g => g.cid === 'C3' || !g.requiredEffects.some(e => e.effect === 'block-save')) && genV3.every(g => !effectsOfCust(g.customization).some(k => /^(amount|items):block-save$/.test(k)) || g.cid === 'C3') && JSON.stringify(effKeys(((x.c.activePlan().generated || {}).C1 || {}).requiredEffects)) === JSON.stringify(['amount:lock', 'memo:warn']) && JSON.stringify(effKeys(((x.c.activePlan().generated || {}).C3 || {}).requiredEffects)) === JSON.stringify(['amount:block-save']), `S2-18: 差分更新の後の生成（作り直し・流用）でも必須の効果に未採用の保存禁止が無い: ${JSON.stringify(genV3.map(g => [g.cid, effKeys(g.requiredEffects)]))}`);
  assert(x.calls.ask.length === asksBefore && x.calls.propose.length === 2 && !(v3.openQuestions || []).length && v3.goalSent === planCalls[0].goal && p2.goal === planCalls[0].goal, 'S2-19: 差分更新でも質問は増えない・送る goal は Toolkit が最初に送ったもの');
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
  assert(effectsOfCust(c3).includes('amount:block-save') && issuesOf(v1).filter(i => i.kind !== 'delegation').map(i => i.customizationId).join() === 'C1,C2', 'S2a-2: 判定できない customization（C3 の入力チェックの移植）は外さない。外した C1・C2 は自動の見直しの対象（scopeIssues）');
  const p1 = planCalls[1] || null;
  assert(planCalls.length === 2 && p1 && p1.revision && /外してください/.test(p1.request) && /C1: amount \/ block-save \/ 根拠の要件なし/.test(p1.request) && /根拠の要件が無い効果は外してください/.test(p1.request), `S2a-3: 同じ 1 回の自動の見直しで「根拠の要件が無い効果を外す」と依頼（既存の上限の中）: ${p1 && p1.request}`);
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
  assert(!/任意の提案（入れるときは伝えてください）/.test(card) && card.includes(B_SAVE_AI) && (scopeOf(x, d.id).requirements.find(q => q.id === 'R4') || {}).basis === 'explicit', 'S3-1: 「明細の保存も止めて」で採用した保存禁止は利用者の要件（explicit）になり、本体に出る');
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
  assert(r7.inScope === true && strippedOf(v).some(s => s.field === 'amount' && s.effect === 'block-save') && !strippedOf(v).some(s => s.field === 'items') && v.final && !(v.final.readiness && (v.final.readiness.reasons || []).some(x => /特定できません/.test(String(x.text || '')))) && x.calls.ask.length === 0 && planCalls.length === 2, `S3-7: 金額に広げた保存禁止は外して詳細に出す。必須の動作を特定できない理由は出ない・質問は増えない・自動の見直しは 1 回だけ: ${JSON.stringify({ stripped: strippedOf(v).map(s => `${s.customizationId}:${s.field}:${s.effect}`), reasons: v.final && v.final.readiness && v.final.readiness.reasons, plans: planCalls.length })}`);
});

// =========================================================
console.log('\n--- §S4. 範囲外を外した最終案は承認を止めない ---');
await section(async () => {
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  //   C1 のイベントは表示だけ（偽の生成工程の候補は表示のイベントだけを登録する）
  const x = makeConvC({ scriptFn: scopeScript, labels: LABELS, generate: gen, planImpl: planImplOf({ ids: ['C1'], desktopEvents: ['app.record.edit.show'], refs: { R1: { planRefs: ['C1'], effects: ['lock'] }, R4: { planRefs: ['C1'], effects: ['block-save'] }, R5: { planRefs: ['P1'], effects: [] } } }) });
  await x.c.send(REQ);
  await x.c.send('採用します');
  const v = x.c.activePlan();
  assert(planCalls.length === 2 && strippedOf(v).length === 2 && v.generated?.C1?.status === 'verified' && v.final?.approvable === true && x.c.approveFinal({ planId: v.planId, version: v.version }).ok === true, `S4-1: 範囲外を外した最終案は、ほかに理由が無ければ承認できる（依頼に無い可能性がある動作は承認を止めない）: ${JSON.stringify({ stripped: strippedOf(v).length, status: v.generated?.C1?.status, reasons: v.final?.readiness })}`);
  assert(JSON.stringify(effKeys((gen.seen.slice(-1)[0] || {}).requiredEffects)) === JSON.stringify(['amount:lock']), 'S4-2: 必須の効果は利用者の編集不可だけ');
  const html = finalHtml(x);
  assert(/依頼に無い可能性がある動作（2 件）/.test(html) && /計画の説明の文に残っている可能性があります/.test(html) && !/依頼に無い可能性/.test(html.replace(/<details[\s\S]*?<\/details>/g, '')), 'S4-3: 「依頼に無い可能性がある動作」は詳細（折りたたみ）の中だけに出す');
  //   レビューの指摘 row1 の D: 通常表示の「最終的にどう動くか」の近くに、名前で書いた短い 1 行（計画の説明の文が外した動作を言っていても、入れていないと分かる）
  const outside = stripC(html.replace(/<details[\s\S]*?<\/details>/g, ''));
  const iBeh = outside.indexOf('最終的にどう動くか'), iNote = outside.indexOf('依頼に無い「金額・明細の保存の停止」は入れていません（詳細）'), iChanged = outside.indexOf('仮案から変わった点');
  assert(iBeh >= 0 && iNote > iBeh && (iChanged < 0 || iNote < iChanged) && !/block-save|\bamount\b|\bitems\b/.test(outside.slice(iNote, iNote + 60)), `S4-4: 通常表示の「最終的にどう動くか」の中に「依頼に無い「金額・明細の保存の停止」は入れていません（詳細）」（フィールドは名前・効果は画面の言葉）: ${outside.slice(Math.max(0, iBeh), iBeh + 300)}`);
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
  //   C2: 委任のターンで要件を作らない（既定の台本の「おすすめで」と同じ）。計画の AI が委ねられた警告を proposed（warn・C1/C2）で足す。
  //   未実現の委任があるので、E_in に無い効果を足す計画の AI の要件は外さずに「判定できない（委任の実現の可能性）」として残し、最終案の詳細に出す
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
  assert(sco.delegationOpen === true && warnReq.basis === 'planner' && warnReq.inScope === true && warnReq.possible === 'delegation' && g1 && g1.requiredEffects.some(e => e.field === 'memo' && e.effect === 'warn' && (e.requirementIds || []).includes(warnReq.id)), `S5-3: 委ねた警告（計画の AI が proposed で足した）は外さずに必須の効果に残る（委任の実現の可能性）: ${JSON.stringify({ open: sco.delegationOpen, warn: [warnReq.id, warnReq.basis, warnReq.inScope, warnReq.possible], req: g1 && g1.requiredEffects.map(e => [e.field, e.effect, e.requirementIds]) })}`);
  const html = finalHtml(x), shut = stripC(html.replace(/<details[\s\S]*?<\/details>/g, ''));
  assert(/委ねた判断を実現するために計画が足した可能性がある動作（[0-9]+ 件）/.test(html) && /「備考」を警告を出す/.test(stripC(html)) && !/委ねた判断を実現するために/.test(shut) && issuesOf(v).some(i => i.kind === 'delegation') && planCalls.length === 1 && x.calls.ask.length === asks, `S5-4: 最終案の詳細（折りたたみ）に「委ねた判断を実現するために計画が足した可能性がある動作」。自動の見直しは依頼しない・質問は増えない: ${(stripC(html).match(/委ねた判断を実現するために[\s\S]{0,200}/) || [''])[0]}`);
  //   未実現の委任の間は、計画の AI が足した保存禁止も構造だけでは委任の実現と区別できない（外さずに詳細に出す。設計 §0f.2 の 7 の既知の限界）
  assert(possibleOf(v).some(st => st.effect === 'block-save') && /「金額」を保存を止める|「明細」を保存を止める/.test((stripC(html).match(/委ねた判断を実現するために[\s\S]{0,400}/) || [''])[0]), 'S5-5: 未実現の委任の間に計画の AI が足した保存禁止は、判定できないとして残し、詳細に出す（黙って必須にしない）');
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
  //   印がある Gateway: 委ねた警告（decisionRefs [委ねた判断の id]）は delegated で残り、混入した保存禁止（decisionRefs []）は外れる
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
  assert(!!dId && sco.decisionRefs === true && warnReq.basis === 'delegated' && warnReq.via === 'decisionRefs' && warnReq.inScope === true && !warnReq.possible && (warnReq.decisionLinks || []).some(l => l.id === dId && l.kind === 'delegated'), `S7-1: 委ねた判断の id（${dId}）を decisionRefs に付けた警告の要件は delegated（範囲内・可能性の扱いではない）: ${JSON.stringify({ mode: sco.decisionRefs, warn: [warnReq.id, warnReq.basis, warnReq.via, warnReq.inScope, warnReq.possible, warnReq.decisionLinks] })}`);
  assert(saveReq.basis === 'planner' && saveReq.inScope === false && saveReq.out === 'adds-effect' && saveReq.stripped === true && !(saveReq.decisionLinks || []).length && sco.delegationOpen === false && !(sco.possible || []).length && !possibleOf(v).length, `S7-2: decisionRefs [] の混入した保存禁止は planner として範囲外（台帳で外・計画から外した）。委任は結び付きで実現済み・可能性の扱いは無い: ${JSON.stringify({ save: [saveReq.id, saveReq.basis, saveReq.inScope, saveReq.out, saveReq.stripped], open: sco.delegationOpen, possible: sco.possible })}`);
  assert(!!v1 && noSave(v1.plan) && noSave(v1.gatewayPlan) && noSave(v && v.plan) && noSave(v && v.gatewayPlan) && strippedOf(v1).some(s => (s.requirementIds || []).includes(saveReq.id)) && effectsOfCust(((v && v.plan.customizations) || []).find(c => c.customizationId === 'C1')).includes('memo:warn'), `S7-3: 保存禁止は v.plan と v.gatewayPlan の両方から外す（最初の計画・自動の見直しの版とも）。委ねた警告は計画に残る: ${JSON.stringify({ v1: v1 && strippedOf(v1).map(s => `${s.customizationId}:${s.field}:${s.effect}`), c1: v && effectsOfCust((v.plan.customizations || []).find(c => c.customizationId === 'C1')) })}`);
  const g1 = gen.seen.filter(g => g.cid === 'C1' && v && g.version === v.version)[0] || null;
  assert(!!g1 && JSON.stringify(effKeys(g1.requiredEffects)) === JSON.stringify(['amount:lock', 'memo:warn']) && g1.requiredEffects.some(e => e.field === 'memo' && e.effect === 'warn' && (e.requirementIds || []).includes(warnReq.id)) && !effectsOfCust(g1.customization).some(k => /block-save/.test(k)), `S7-4: 生成の必須の効果は編集不可と委ねた警告（警告の要件の id つき）だけ。保存禁止は無い: ${JSON.stringify(g1 && g1.requiredEffects.map(e => [e.field, e.effect, e.requirementIds]))}`);
  const html = finalHtml(x);
  assert(x.calls.ask.length === asks && x.calls.propose.length === 2 && planCalls.length === 2 && !/委ねた判断を実現するために計画が足した可能性がある動作/.test(html) && /依頼に無い可能性がある動作/.test(html), `S7-5: 質問は増えない・自動の見直しは既存の上限の 1 回・最終案の詳細は「依頼に無い可能性がある動作」（可能性の扱いの節は出さない）: ${JSON.stringify({ plans: planCalls.length, asks: x.calls.ask.length })}`);
});
await section(async () => {
  //   印の無い古い Gateway（同じ計画の AI。decisionRefs は返らない）: 今の possible の扱い（委ねた警告も混入した保存禁止も外さずに残し、最終案の詳細に出す）
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
  assert(sco.decisionRefs !== true && sco.delegationOpen === true && warnReq.basis === 'planner' && warnReq.possible === 'delegation' && saveReq.possible === 'delegation' && saveReq.inScope === true && !strippedOf(v).length && possibleOf(v).some(s => s.effect === 'block-save') && /委ねた判断を実現するために計画が足した可能性がある動作/.test(html) && planCalls.length === 1, `S7-6: 印の無い Gateway は今の possible の扱い（外さずに詳細に出す・自動の見直しはしない）: ${JSON.stringify({ mode: sco.decisionRefs, open: sco.delegationOpen, warn: [warnReq.basis, warnReq.possible], save: [saveReq.possible, saveReq.inScope], plans: planCalls.length })}`);
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
  //   結び付けで採用の根拠を変えない（suggestion のまま範囲外・計画から外す）。委ねた警告は delegated で残る
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
  assert(r4.basis === 'suggestion' && r4.inScope === false && r4.out === 'suggestion' && warnReq.basis === 'delegated' && noSave(v && v.plan) && !!g1 && !effKeys(g1.requiredEffects).some(k => /block-save/.test(k)), `S7-7b: 任意の提案の扱いの要件は、計画の AI が委ねた判断の id を付けても範囲外のまま（保存禁止は計画と必須の効果に入らない）: ${JSON.stringify({ r4: [r4.basis, r4.inScope, r4.out, r4.decisionLinks], warn: warnReq.basis, req: g1 && effKeys(g1.requiredEffects) })}`);
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
      assert(warnReq.basis === 'delegated' && warnReq.via === 'decisionRefs' && warnReq.inScope === true && (warnReq.decisionLinks || []).some(l => l.id === did) && saveReq.basis === 'planner' && saveReq.inScope === false && saveReq.stripped === true && sco.delegationOpen === false && !possibleOf(v).length, `S7-10（${tag}）: 委ねた警告（decisionRefs [${did}]）は delegated で残り、混入した保存禁止（decisionRefs []）は planner として外れる: ${JSON.stringify({ warn: [warnReq.id, warnReq.basis, warnReq.inScope], save: [saveReq.id, saveReq.basis, saveReq.inScope, saveReq.stripped], open: sco.delegationOpen })}`);
      assert(noSave(v.plan) && noSave(v.gatewayPlan) && !!g1 && JSON.stringify(effKeys(g1.requiredEffects)) === JSON.stringify(['amount:lock', 'memo:warn']) && g1.requiredEffects.some(e => e.field === 'memo' && (e.requirementIds || []).includes(warnReq.id)) && x.calls.ask.length === 0 && planCalls.length === 3, `S7-11（${tag}）: v.plan・v.gatewayPlan・生成の必須の効果に保存禁止が無く、委ねた警告は残る（質問なし・自動の見直しは 1 回）: ${JSON.stringify({ req: g1 && effKeys(g1.requiredEffects), plans: planCalls.length })}`);
    } else {
      assert(!sentD.some(d => d.question === Q_PLAN_TEXT && !rec) && warnReq.basis === 'planner' && warnReq.possible === 'delegation' && saveReq.possible === 'delegation' && saveReq.inScope === true && sco.delegationOpen === true && possibleOf(v).some(s => s.effect === 'block-save') && /委ねた判断を実現するために計画が足した可能性がある動作/.test(html) && planCalls.length === 2 && !!g1 && effKeys(g1.requiredEffects).includes('memo:warn'), `S7-12（${tag}）: 印の無い Gateway は今の possible の扱い（計画の段階の委任の版の計画の AI の追加を外さずに残し、最終案の詳細に出す）: ${JSON.stringify({ warn: [warnReq.basis, warnReq.possible], save: [saveReq.possible, saveReq.inScope], open: sco.delegationOpen, plans: planCalls.length })}`);
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
console.log('\n--- §S6. 画面: 範囲外を外した customization の生成に渡す requirement の文 ---');
await section(async () => {
  //   レビューの指摘 row1 の D（2026-10-09）: 計画の AI の customization の文（「…保存も止める」）は範囲外の動作を含む。外した customization では、生成工程に送る
  //   customization の requirement と「満たすべき要件」の customization の行を、範囲内の結び付く要件の文（台帳の値）で組み立てた文にする（自然文は読まない）
  const REQ_S = '承認待ちでは金額を変更できなくして';
  const scriptS = ({ utterance: u }) => (u === REQ_S ? { reply: '承認待ちでは金額を編集不可にします。', intent: 'propose', proposal: { behaviors: [B('承認待ちでは金額を変更できなくする', 'user')], assumptions: [], decisions: [], approach: { standard: [], js: ['承認待ちの金額の編集不可'] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [req('add', { target: '金額', condition: '承認待ち', behavior: '金額を編集不可にする', sourceQuotes: [REQ_S], planRefs: ['B1'], effects: ['lock'] })] } } : null);
  const CUST_TEXT = '承認待ちでは金額を編集不可にし、金額の変更を保存時にも止める';
  const rawS = (goal) => { const b = K.PLAN_V1(goal); const c = K.custLock('amount', { requirement: CUST_TEXT, fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock', 'block-save'] }] }); return { ...b, plan: { ...b.plan, solution: 'CUSTOMIZATION', assessment: { ...b.plan.assessment, summary: '承認待ちでは金額を編集不可にし、保存時にも止める計画です。' }, steps: [mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { title: 'JavaScript', solution: 'CUSTOMIZATION' })], customizations: [c] }, turn: { reply: '保存時にも止める計画です。', requirementOps: [{ op: 'update', id: 'R1', target: '金額', condition: '承認待ち', behavior: '金額を編集不可にする', exceptions: [], decision: 'decided', disposition: 'adopted', sourceQuotes: [REQ_S], planRefs: ['C1'], effects: ['lock'], note: '' }], utteranceCoverage: [] } }; };
  const sg = K.screenGenerate({ field: 'amount', targetFile: 'amountLock.js' });
  const m = K.mount({ health: K.HEALTH_V, scriptFn: scriptS, planImpl: K.planImplOf(rawS), generateImpl: sg.impl, liveBase: true });
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

console.log(`\n${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
