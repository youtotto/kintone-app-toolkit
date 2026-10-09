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
//   §S3 利用者が明示採用した保存禁止（decided）は残る
//   §S4 範囲外を外した最終案は承認を止めない（詳細に「依頼に無い可能性がある動作」）
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
const planImplOf = (opts) => (args) => { planCalls.push({ revision: !!args.revision, goal: args.goal, request: args.revision ? args.revision.request : null, requirements: clone(args.requirements || []), previousPlan: args.revision ? clone(args.revision.previousPlan || null) : null }); return contaminatedPlan(args, { ...opts, label: `計画 ${planCalls.length}` }); };

(async () => {
// =========================================================
console.log('\n--- §S0. 採用範囲の判定（requirementScopeOf） ---');
await section(async () => {
  const { requirementScopeOf } = KTAiConversation;
  const P = { customizations: [{ customizationId: 'C1' }, { customizationId: 'C2' }, { customizationId: 'C3' }] };
  const r = (id, basis, effects, planRefs, decision = 'proposed') => ({ id, decision, planRefs, ...(effects ? { effects } : {}), ...(basis ? { scope: { basis } } : {}) });
  const sc = requirementScopeOf([
    r('R1', 'explicit', ['lock'], ['C1', 'C2'], 'decided'), r('R2', 'item-user', ['warn'], ['C1']), r('R3', 'assumption', ['set-value'], ['C2']), r('R4', 'delegated', ['show-hide'], ['C1']),
    r('R5', 'suggestion', ['block-save'], ['C1']), r('R6', 'item-ai', [], ['P1']), r('R7', 'planner', null, ['P1']), r('R8', 'planner', ['block-save'], ['C1', 'C2']),
    r('R9', 'planner', ['lock'], ['C1']), r('R10', 'planner', ['block-save'], ['C3']), r('R11', 'item-ai', ['block-save'], ['B4']), r('R12', null, ['block-save'], ['C2']),
    { id: 'R13', decision: 'revoked', planRefs: ['C1'], effects: ['block-save'], scope: { basis: 'planner' } },
  ], P);
  assert(['R1', 'R2', 'R3', 'R4'].every(id => sc.inIds.has(id)) && sc.out.get('R5').reason === 'suggestion', `S0-1: 明示・利用者の項目・前提・委任は中、任意の提案は外: ${JSON.stringify([...sc.out])}`);
  assert(sc.inIds.has('R6') && sc.inIds.has('R7') && sc.inIds.has('R9'), 'S0-2: 実現の手順（効果 []）・効果を持たない古い形・範囲内に同じ効果がある要件は中');
  assert(sc.out.get('R8') && sc.out.get('R8').reason === 'adds-effect' && JSON.stringify(sc.out.get('R8').customizationIds) === JSON.stringify(['C1', 'C2']) && JSON.stringify(sc.out.get('R8').effects) === JSON.stringify(['block-save']) && sc.out.get('R12') && sc.out.get('R12').reason === 'adds-effect', `S0-3: 範囲内の要件に無い効果を足す計画の AI の要件・根拠の無い古い要件（unlinked）は外: ${JSON.stringify([...sc.out])}`);
  assert(sc.undetermined.has('C3') && sc.inIds.has('R10') && sc.inIds.has('R11') && !sc.inIds.has('R13') && !sc.out.has('R13'), 'S0-4: 範囲内の要件に効果が無い customization（C3）に結び付く・customization に結び付かない要件は判定できないので中。取り消し済みは判定しない');
  const sc2 = requirementScopeOf([r('R1', 'explicit', ['lock'], ['C1'], 'decided'), r('R2', 'explicit', ['block-save'], ['C3'], 'decided'), r('R3', 'planner', ['block-save'], ['C1', 'C3'])], P);
  assert(sc2.out.get('R3') && JSON.stringify(sc2.out.get('R3').customizationIds) === JSON.stringify(['C1']) && sc2.eIn.get('C3').has('block-save'), `S0-5: 範囲内の入力チェック（C3 の block-save）がある customization では足さず、ほかの customization（C1）で足すなら外（外すのは C1 の分だけ）: ${JSON.stringify([...sc2.out])}`);
  const sc3 = requirementScopeOf([r('R1', 'explicit', null, ['C1'], 'decided'), r('R2', 'planner', ['block-save'], ['C1'])], P);
  assert(sc3.undetermined.has('C1') && sc3.inIds.has('R2'), 'S0-6: 範囲内に効果を持たない（古い形の）要件が結び付く customization は判定できない（中に残す）');
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
  const sco = x.c.requirementScope(d.id);
  const basisOf = (id) => (sco.requirements.find(r => r.id === id) || {}).basis;
  assert(['R1', 'R2', 'R3'].every(id => basisOf(id) === 'explicit') && basisOf('R4') === 'suggestion' && basisOf('R5') === 'item-ai' && sco.requirements.every(r => r.createdBy === 'proposal') && !sco.adopted, `S1-4: 仮案の要件の採用の根拠（明示・任意の提案の扱い・ai の補足）と作った段階: ${JSON.stringify(sco.requirements.map(r => [r.id, r.basis, r.createdBy]))}`);
  const r = await x.c.send('採用します');
  const p0 = planCalls[0] || null;
  assert(r.intent === 'ADOPT_DRAFT' && x.calls.propose.length === 1 && p0 && !p0.goal.includes(B_SAVE_AI) && p0.goal.includes(B_STATUS_AI) && p0.goal.includes(B_LOCK_U), `S1-5: ［採用］の依頼文（採用した方針）に任意の提案の扱いにした保存禁止は入らない（ai の補足は入る）: ${p0 && p0.goal}`);
  assert(!p0.requirements.some(q => q.id === 'R4') && p0.requirements.some(q => q.id === 'R5' && q.decision === 'proposed') && p0.requirements.filter(q => q.decision === 'revoked').length === 0, `S1-6: その要件は計画の AI に渡さない（実現の手順の要件は渡す）: ${JSON.stringify(p0.requirements.map(q => [q.id, q.decision]))}`);
  const sc1 = x.c.requirementScope();
  assert(sc1.adopted && sc1.adoption.items.B4 === 'suggestion' && sc1.adoption.items.B5 === 'ai' && sc1.adoption.suggestionItems.includes('B4'), `S1-7: 採用の時点の記録（項目の種類・任意の提案の項目）: ${JSON.stringify(sc1.adoption)}`);
});
// =========================================================
console.log('\n--- §S2. 計画の応答・自動の見直し・差分更新が未採用の保存禁止を戻す ---');
await section(async () => {
  planCalls.length = 0;
  const gen = recordingGenerate(['good']);
  const x = makeConvC({ scriptFn: scopeScript, labels: LABELS, generate: gen, planImpl: planImplOf({ refs: REFS_MAIN }) });
  await x.c.send(REQ);
  await x.c.send(DELEGATE_U);
  const asksBefore = x.calls.ask.length;
  const r = await x.c.send('採用します');
  const v2 = x.c.activePlan();
  const v1 = x.c.planHistory().find(v => v.planId === v2.planId && v.version === 1);
  assert(r.intent === 'ADOPT_DRAFT' && planCalls.length === 2 && !planCalls[0].revision && planCalls[1].revision && v2.version === 2, `S2-0: 採用 → 最初の計画 → 範囲外を外した customization を自動の見直し 1 回（既存の上限の中）→ 最終案: ${JSON.stringify(planCalls.map(p => p.revision))}`);
  // 最初の計画の版（v1）: 計画と Gateway の計画の両方から外す。効果の無くなった CONTROL は READ。C3（入力チェックの移植）は残す
  const fieldOf = (pl, cid, code) => ((pl.customizations || []).find(c => c.customizationId === cid) || { fields: [] }).fields.find(f => f.code === code) || null;
  const noSave = (pl) => ['C1', 'C2'].every(cid => !effectsOfCust((pl.customizations || []).find(c => c.customizationId === cid)).some(k => /block-save/.test(k)));
  assert(noSave(v1.plan) && noSave(v1.gatewayPlan) && fieldOf(v1.plan, 'C1', 'items').access === 'READ' && fieldOf(v1.gatewayPlan, 'C2', 'items').access === 'READ' && JSON.stringify(fieldOf(v1.plan, 'C1', 'amount').effects) === JSON.stringify(['lock']), `S2-1: 計画の返答の未採用の保存禁止を v.plan と v.gatewayPlan の両方から外す（金額は編集不可だけ・明細は読み取りだけ）: ${JSON.stringify({ c1: effectsOfCust(v1.plan.customizations[0]), gw: effectsOfCust(v1.gatewayPlan.customizations[0]) })}`);
  assert(JSON.stringify(fieldOf(v1.plan, 'C3', 'amount').effects) === JSON.stringify(['block-save']) && JSON.stringify(fieldOf(v1.gatewayPlan, 'C3', 'amount').effects) === JSON.stringify(['block-save']) && v1.plan.steps.length === 4 && v1.plan.customizations.length === 3, 'S2-2: C3（既存の入力チェックの移植）の block-save・手順・customization は消さない');
  assert(JSON.stringify(v1.scopeStripped.map(s => `${s.customizationId}:${s.field}:${s.effect}`).sort()) === JSON.stringify(['C1:amount:block-save', 'C1:items:block-save', 'C2:amount:block-save', 'C2:items:block-save']) && v1.scopeStripped.every(s => s.requirementIds.includes('R7')) && v1.scopeStripped.some(s => s.requirementIds.includes('R4')) && v1.scopeIssues.map(i => i.customizationId).join() === 'C1,C2', `S2-3: 外した効果と出どころの要件（別 ID の追加 R7・update で付け替えた R4）を記録: ${JSON.stringify(v1.scopeStripped)}`);
  // 台帳: 外になる（台帳の decision は変えない）。計画の AI へは revoked として渡す（任意の提案の扱いの要件は渡さない）
  const p1 = planCalls[1];
  const sentOf = (id) => (p1.requirements.find(q => q.id === id) || null);
  assert(sentOf('R7') && sentOf('R7').decision === 'revoked' && !sentOf('R4') && sentOf('R5') && sentOf('R5').decision === 'proposed' && sentOf('R6') && sentOf('R6').decision === 'proposed' && sentOf('R8') && sentOf('R8').decision === 'proposed' && sentOf('R1').decision === 'decided', `S2-4: 自動の見直しに送る要件: 範囲外の追加は revoked・任意の提案の扱いは渡さない・委任した設定と実現の手順はそのまま: ${JSON.stringify(p1.requirements.map(q => [q.id, q.decision]))}`);
  assert(/外してください/.test(p1.request) && /C1: amount \/ block-save/.test(p1.request) && /R7/.test(p1.request) && !/effects（\[\{ effect/.test(p1.request) && /block-save/.test(p1.request), `S2-5: 自動の見直しの依頼文に構造化した「外す」指示（customization・フィールド・効果・要件）: ${p1.request}`);
  assert(noSaveIn(p1.previousPlan) && JSON.stringify(fieldOf(p1.previousPlan, 'C3', 'amount').effects) === JSON.stringify(['block-save']), 'S2-6: 自動の見直しの土台の計画（previousPlan）にも未採用の保存禁止は無い（外した後の計画。C3 の入力チェックは残る）');
  // 自動の見直しでも同じ提案が戻る → 同じく外す
  assert(noSave(v2.plan) && noSave(v2.gatewayPlan) && v2.scopeStripped.length === 4 && v2.scopeStripped.every(s => s.requirementIds.includes('R9')), `S2-7: 自動の見直しで戻った保存禁止（別 ID の R9）も外す: ${JSON.stringify(v2.scopeStripped)}`);
  // 生成: 必須の効果と customization に block-save が無い（C1・C2）。委任した警告は残る。C3 の入力チェックの移植は残る
  const genV2 = gen.seen.filter(g => g.version === 2);
  const g1 = genV2.find(g => g.cid === 'C1'), g2 = genV2.find(g => g.cid === 'C2'), g3 = genV2.find(g => g.cid === 'C3');
  assert(g1 && g2 && g3 && JSON.stringify(effKeys(g1.requiredEffects)) === JSON.stringify(['amount:lock', 'memo:warn']) && JSON.stringify(effKeys(g2.requiredEffects)) === JSON.stringify(['amount:lock', 'memo:warn']) && !effectsOfCust(g1.customization).some(k => /block-save/.test(k)) && !effectsOfCust(g2.customization).some(k => /block-save/.test(k)), `S2-8: 生成に渡す必須の効果と customization に未採用の保存禁止が無い（委任した警告は残る）: ${JSON.stringify(genV2.map(g => [g.cid, effKeys(g.requiredEffects), effectsOfCust(g.customization)]))}`);
  assert(g3 && JSON.stringify(effKeys(g3.requiredEffects)) === JSON.stringify(['amount:block-save']) && JSON.stringify(effectsOfCust(g3.customization)) === JSON.stringify(['amount:block-save']), `S2-9: C3（既存の入力チェックの移植）の block-save は残る: ${JSON.stringify(g3 && g3.requiredEffects)}`);
  assert(g1.requiredEffects.some(e => e.field === 'memo' && e.effect === 'warn' && (e.requirementIds || []).includes('R6')) && g1.requiredEffects.some(e => e.field === 'amount' && e.effect === 'lock' && (e.requirementIds || []).includes('R1')), `S2-10: 委任した設定（R6・警告）と利用者の編集不可（R1）は要件の id つきで必須の効果に残る: ${JSON.stringify(g1.requiredEffects.map(e => [e.field, e.effect, e.requirementIds]))}`);
  // 台帳の読み取り（本文なし）
  const sco = x.c.requirementScope();
  const row = (id) => sco.requirements.find(q => q.id === id) || {};
  assert(row('R1').basis === 'explicit' && row('R6').basis === 'delegated' && row('R5').basis === 'item-ai' && row('R5').inScope && row('R6').inScope && row('R4').basis === 'suggestion' && !row('R4').inScope && row('R7').basis === 'planner' && row('R7').createdBy === 'plan' && !row('R7').inScope && row('R7').out === 'adds-effect' && row('R9').createdBy === 'plan-auto' && row('R8').basis === 'planner' && row('R8').inScope && row('R7').stripped === true && row('R9').stripped === true && row('R1').stripped === false && sco.scopeStripped === 4 && sco.scopeIssues === 2, `S2-11: 台帳の読み取り（根拠・作った段階・範囲・外したか・外した数）: ${JSON.stringify(sco.requirements.map(q => [q.id, q.decision, q.basis, q.createdBy, q.inScope, q.out, q.stripped]))}`);
  assert(!JSON.stringify(sco).includes(R_SAVE.behavior) && !JSON.stringify(sco).includes(REQ), 'S2-12: 読み取りは本文（要件の文・利用者の発言）を返さない');
  const ids = x.c.requirementsInScope(v2.planId).map(q => q.id);
  assert(!ids.includes('R4') && !ids.includes('R7') && !ids.includes('R9') && ['R1', 'R2', 'R3', 'R5', 'R6', 'R8'].every(id => ids.includes(id)), `S2-13: 生成の「満たすべき要件」（画面の requirementIds）に使う範囲内の要件: ${ids.join(',')}`);
  // 最終案: 範囲外の要件を「担当が計画にありません」に出さない。詳細に「依頼に無い可能性がある動作」
  const html = finalHtml(x);
  assert(!JSON.stringify(v2.final.outOfScope).includes('保存を止める') && /依頼に無い可能性がある動作（2 件）/.test(html) && /<details class="kt-ai-tech kt-ai-final-scope-out"/.test(html) && /「金額」を保存を止める/.test(stripC(html)), `S2-14: 最終案は範囲外の要件を担当なしに出さず、詳細に外した動作を出す: ${(stripC(html).match(/依頼に無い可能性[\s\S]{0,200}/) || [''])[0]}`);
  // 質問が増えない
  assert(x.calls.ask.length === asksBefore && x.calls.propose.length === 2 && !(v2.openQuestions || []).length && !x.c.messages().some(m => m.data && /question/.test(String(m.data.kind || ''))), 'S2-15: 範囲外の保存禁止を利用者に断らせない（質問・仮案の作り直しを増やさない）');
  // 差分更新でも同じ提案が戻る → 同じく外す。自動の見直しはもう依頼しない（同じ customization は系列ごとに 1 回）
  const genBefore = gen.seen.length;
  await x.c.send('警告の文は「備考を入力してください」にして');
  const v3 = x.c.activePlan();
  const p2 = planCalls[2];
  assert(planCalls.length === 3 && p2.revision && !/外してください/.test(p2.request) && v3.version === 3 && noSave(v3.plan) && noSave(v3.gatewayPlan) && v3.scopeStripped.length === 4 && v3.scopeStripped.every(s => s.requirementIds.includes('R11')), `S2-16: 差分更新で戻った保存禁止も外す（自動の見直しは増やさない）: ${JSON.stringify({ plans: planCalls.length, stripped: v3.scopeStripped })}`);
  assert(['R7', 'R9'].every(id => (p2.requirements.find(q => q.id === id) || {}).decision === 'revoked') && !p2.requirements.some(q => q.id === 'R4') && noSaveIn(p2.previousPlan), `S2-17: 差分更新に送る要件でも範囲外は revoked・土台の計画にも保存禁止は無い: ${JSON.stringify(p2.requirements.map(q => [q.id, q.decision]))}`);
  const genV3 = gen.seen.slice(genBefore);
  assert(genV3.every(g => g.cid === 'C3' || !g.requiredEffects.some(e => e.effect === 'block-save')) && genV3.every(g => !effectsOfCust(g.customization).some(k => /^(amount|items):block-save$/.test(k)) || g.cid === 'C3') && JSON.stringify(effKeys((x.c.activePlan().generated.C1 || {}).requiredEffects)) === JSON.stringify(['amount:lock', 'memo:warn']) && JSON.stringify(effKeys((x.c.activePlan().generated.C3 || {}).requiredEffects)) === JSON.stringify(['amount:block-save']), `S2-18: 差分更新の後の生成（作り直し・流用）でも必須の効果に未採用の保存禁止が無い: ${JSON.stringify(genV3.map(g => [g.cid, effKeys(g.requiredEffects)]))}`);
  assert(x.calls.ask.length === asksBefore && x.calls.propose.length === 2 && !(v3.openQuestions || []).length && v3.goalSent === planCalls[0].goal && p2.goal === planCalls[0].goal, 'S2-19: 差分更新でも質問は増えない・送る goal は Toolkit が最初に送ったもの');
});
function noSaveIn(pl) { return !!pl && (pl.customizations || []).filter(c => c.customizationId !== 'C3').every(c => !effectsOfCust(c).some(k => /block-save/.test(k))); }

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
  assert(!/任意の提案（入れるときは伝えてください）/.test(card) && card.includes(B_SAVE_AI) && (x.c.requirementScope(d.id).requirements.find(q => q.id === 'R4') || {}).basis === 'explicit', 'S3-1: 「明細の保存も止めて」で採用した保存禁止は利用者の要件（explicit）になり、本体に出る');
  await x.c.send('採用します');
  const v = x.c.activePlan();
  assert(planCalls[0].goal.includes(B_SAVE_AI) && planCalls[0].requirements.some(q => q.id === 'R4' && q.decision === 'decided') && !v.scopeStripped.length && !(v.scopeIssues || []).length && planCalls.length === 1, `S3-2: 依頼文・計画の AI に渡す要件に入り、計画の返答から外さない（自動の見直しも起きない）: ${JSON.stringify({ stripped: v.scopeStripped, plans: planCalls.length })}`);
  const g1 = gen.seen.find(g => g.cid === 'C1');
  assert(g1 && effKeys(g1.requiredEffects).includes('amount:block-save') && effKeys(g1.requiredEffects).includes('items:block-save') && g1.requiredEffects.some(e => e.effect === 'block-save' && (e.requirementIds || []).includes('R4')), `S3-3: 生成の必須の効果に利用者が採用した保存禁止が残る: ${JSON.stringify(g1 && effKeys(g1.requiredEffects))}`);
  assert((x.c.requirementScope().requirements.find(q => q.id === 'R7') || {}).inScope === true, 'S3-4: 同じ効果を足す計画の AI の要件も範囲内（利用者の保存禁止と同じ効果）');
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
  assert(planCalls.length === 2 && v.scopeStripped.length === 2 && v.generated.C1.status === 'verified' && v.final.approvable === true && x.c.approveFinal({ planId: v.planId, version: v.version }).ok === true, `S4-1: 範囲外を外した最終案は、ほかに理由が無ければ承認できる（依頼に無い可能性がある動作は承認を止めない）: ${JSON.stringify({ stripped: v.scopeStripped.length, status: v.generated.C1.status, reasons: v.final.readiness })}`);
  assert(JSON.stringify(effKeys(gen.seen.slice(-1)[0].requiredEffects)) === JSON.stringify(['amount:lock']), 'S4-2: 必須の効果は利用者の編集不可だけ');
  const html = finalHtml(x);
  assert(/依頼に無い可能性がある動作（2 件）/.test(html) && /計画の説明の文に残っている可能性があります/.test(html) && !/依頼に無い可能性/.test(html.replace(/<details[\s\S]*?<\/details>/g, '')), 'S4-3: 「依頼に無い可能性がある動作」は詳細（折りたたみ）の中だけに出す');
});

console.log(`\n${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
