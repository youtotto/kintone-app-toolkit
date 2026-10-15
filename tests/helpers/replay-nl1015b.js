// 2026-10-15 §12.31 の保存済みの素材（tests/fixtures/nl1015b-final.js）を、会話コントローラ（偽 services）で再生する部品（有料の AI は使わない）。
//   依頼 → 修正コメント → ［採用］（「採用します」）→ 計画（保存した計画・確認・計画の返答）→ 生成 3 本（保存した生成結果と検証の結果）→ 最終案。
//   生成の検査（KTCodeReview.review）は画面の generate と同じ引数（要件の台帳 requirementsInScope と担当の集まり planOwners）で今の Toolkit が計算する。
//   画面の準備（反映の前の確認）の JavaScript の再検査は jsRecheckOf と同じ引数（existingOnly・要件の台帳・担当の集まり）で recheckOf が計算する。
//
// 使い方:
//   const R = createReplay(T, K);
//   const x = await R.run();                 // 最終案まで（x.c.activePlan().final）
//   const left = R.leftHtml(x, { pre });     // 左の最終案のカード（App 353 のフィールドの名前と数値の単位で描く）
//   const right = R.rightHtml(x);            // 右の「変更内容」
//   const rv = R.recheckOf(x, 'C2');         // 反映の前の確認の再検査
//   オプション: run({ mutate }) = 生成の応答を変える関数 (cid, generated) => generated / run({ ownersOff: true }) = 検査に担当の集まりを渡さない（この修正の前の流れ）
'use strict';
const F = require('../fixtures/nl1015b-final.js');
const RP = require('../fixtures/p21-bfc-replay.js');

function createReplay(T, K) {
  const { KTAiChatUi, KTCodeReview, KTDeps, KTContext } = T;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fieldsN = KTDeps.normalizeFields(RP.FIELDS);
  const LABELS = Object.fromEntries(fieldsN.map(f => [f.code, f.label || f.code]));
  const NUMBERS = Object.fromEntries(fieldsN.filter(f => f.rawType === 'NUMBER' || f.rawType === 'CALC').map(f => [f.code, { type: f.rawType, unit: f.raw && typeof f.raw.unit === 'string' ? f.raw.unit : '', unitPosition: f.raw && f.raw.unitPosition === 'BEFORE' ? 'BEFORE' : 'AFTER' }]));
  const COLUMNS = Object.fromEntries(fieldsN.filter(f => f.parent).map(f => [f.code, f.parent]));
  const READONLY = [...KTContext.readOnlyFieldCodes(fieldsN)];
  const state = (name, index) => ({ name, index: String(index), assignee: { type: 'ONE', entities: [] } });
  const DATA = { appId: '353', fields: clone(RP.FIELDS), status: { enable: true, states: { '作成中': state('作成中', 0), '承認待ち': state('承認待ち', 1), '承認済み': state('承認済み', 2) }, actions: [] }, layout: [] };
  const reqOp = (r) => K.req('add', { target: r.target, condition: r.condition, behavior: r.behavior, exceptions: clone(r.exceptions || []), sourceQuotes: clone(r.sourceQuotes || []), planRefs: clone(r.planRefs || []), effects: clone(r.effects || []), decision: r.decision, disposition: r.disposition });
  const proposalOf = (p) => ({ behaviors: clone(p.behaviors), assumptions: clone(p.assumptions), decisions: clone(p.decisions), approach: clone(p.approach), cannot: clone(p.cannot) });
  /** 仮案の台本（reqMutate = 要件の台帳の要件を変える関数。わざと担当を外す回帰用 / proposalMutate = 仮案の項目を変える関数） */
  const scriptOf = (reqMutate = null, proposalMutate = null) => ({ utterance: u }) => {
    const ops = (p) => p.requirements.map(r => (reqMutate ? reqMutate(clone(r)) : r)).map(reqOp);
    const prop = (p) => (proposalMutate ? proposalMutate(proposalOf(p)) : proposalOf(p));
    if (u === F.REQUEST) { const p = F.PROPOSE[0]; return { reply: p.reply, intent: 'propose', proposal: prop(p), turn: { ops: [], answers: [], requirementOps: ops(p) } }; }
    if (u === F.COMMENT) { const p = F.PROPOSE[1]; return { reply: p.reply, intent: 'update', proposal: prop(p), turn: { ops: clone(p.ops).map(o => ({ ...o, quote: '' })), answers: clone(p.answers).map(a => ({ ...a, quote: '承認者は今の作業者の指定のままでよいです。' })), requirementOps: ops(p) } }; }
    return null;
  };
  /** 計画の偽物（planMutate = 計画を変える関数。PC とモバイルで違う計画の回帰用） */
  const planImplOf = (planMutate = null) => () => ({ plan: planMutate ? planMutate(clone(F.PLAN)) : clone(F.PLAN), ctx: clone(F.PLAN_CTX), review: clone(F.PLAN_REVIEW), gatewayPlan: F.GATEWAY_PLAN ? clone(F.GATEWAY_PLAN) : null, turn: { reply: F.PLAN_REPLY, requirementOps: [], utteranceCoverage: [] } });
  const custOf = (v, cid) => (v.plan.customizations || []).find(c => c && c.customizationId === cid) || null;
  const srcOf = (s) => (s.existingSource ? { name: s.existingSource.name, target: s.existingSource.target, text: s.existingSource.text } : null);

  /**
   * mutate(cid, generated) = 生成の応答を変える / verificationMutate(cid, verification) = 検証の結果を変える /
   * throwFor = { cid: code }（その JavaScript の最初の生成で code の失敗を投げる。2 回目からは保存した結果）/ ownersOff = 検査に担当の集まりを渡さない（この修正の前の検査）
   */
  async function run({ mutate = null, verificationMutate = null, planMutate = null, reqMutate = null, proposalMutate = null, throwFor = null, ownersOff = false } = {}) {
    const holder = {};
    const calls = [];
    const thrown = new Set();
    const generate = { calls, impl: async (args) => {
      const cid = args.customizationId, s = F.GENERATED[cid], v = args.version;
      calls.push({ cid, planOwners: args.planOwners ? [...args.planOwners] : null, requiredEffects: clone(args.requiredEffects || []) });
      if (throwFor && throwFor[cid] && !thrown.has(cid)) { thrown.add(cid); throw Object.assign(new Error(`テスト: ${throwFor[cid]}`), { code: throwFor[cid] }); }
      const generated = mutate ? mutate(cid, clone(s.generated)) : clone(s.generated);
      //   画面の generate と同じ: 要件の台帳（採用範囲の中）と担当の集まり（会話が渡したもの）
      const review = KTCodeReview.review({ generated, customization: custOf(v, cid), plan: v.plan, data: clone(DATA), scan: null, existingSource: srcOf(s), provenance: null, requirements: holder.x.c.requirementsInScope(v.planId, v.plan), ...(ownersOff ? {} : { planOwners: args.planOwners }) });
      const verification = verificationMutate ? verificationMutate(cid, clone(s.verification)) : clone(s.verification);
      return { ok: true, generated, review, ctx: { size: { approxTokens: 1000 } }, existingSource: s.existingSource ? clone(s.existingSource) : null, inputHash: s.inputHash, verification, candidateHash: s.candidateHash, requirementIds: clone(s.requirementIds), relatedOmitted: [] };
    } };
    const x = K.makeConvC({ planImpl: planImplOf(planMutate), generate, scriptFn: scriptOf(reqMutate, proposalMutate), labels: LABELS });
    holder.x = x;
    x.services.tableColumns = () => clone(COLUMNS);
    x.services.readOnlyFields = () => [...READONLY];
    x.services.jsFiles = () => clone(F.JS_FILES);
    const r1 = await x.c.send(F.REQUEST);
    const r2 = await x.c.send(F.COMMENT);
    const r3 = await x.c.send('採用します');
    await K.ticks(4);
    Object.assign(x, { sends: [r1, r2, r3] });
    return x;
  }
  const viewOf = (x, extra = {}) => ({ plans: new Map(x.c.planHistory().map(z => [`${z.planId}:${z.version}`, z])), activePlan: x.c.activePlan(), answerState: x.c.answerContext(), ledger: x.c.ledger(), answers: new Map(), labels: LABELS, numbers: NUMBERS, ...extra });
  /** 左の最終案のカード。pre = 反映の前の確認（finalPre）の状態と項目（省略すると準備の前） */
  const leftHtml = (x, { pre = null } = {}) => { const v = x.c.activePlan(); return KTAiChatUi.messageHtml(x.finals().slice(-1)[0], viewOf(x, pre ? { finalPre: { planId: v.planId, version: v.version, status: pre.status || 'ready', reasons: pre.reasons || [], items: pre.items || {} } } : {})); };
  const rightHtml = (x, { numbers = NUMBERS } = {}) => KTAiChatUi.changeSummaryHtml(x.c.activePlan(), { open: x.c.answerContext().open, labels: LABELS, numbers });
  /** 反映の前の確認の JavaScript の再検査（画面の jsRecheckOf と同じ引数。ownersOff = 要件の台帳と担当の集まりを渡さない＝この修正の前） */
  const recheckOf = (x, cid, { ownersOff = false } = {}) => {
    const v = x.c.activePlan(), g = v.generated[cid];
    let rv = KTCodeReview.review({ generated: g.generated, customization: custOf(v, cid), plan: v.plan, data: clone(DATA), scan: null, existingSource: g.existingSource ? { name: g.existingSource.name, target: g.existingSource.target, text: g.existingSource.text } : null, provenance: null, existingOnly: true, ...(ownersOff ? {} : { requirements: x.c.requirementsInScope(v.planId, v.plan || null), planOwners: x.c.planOwnerIds(v) }) });
    if (g.verification && ((Array.isArray(g.requiredEffects) && g.requiredEffects.length) || g.verification.behavior)) rv = KTCodeReview.attachBehavior(rv, g.verification, { requiredEffects: g.requiredEffects || [], customization: custOf(v, cid), omitted: g.relatedOmitted || [], effectCheck: g.effectCheck != null ? g.effectCheck === true : T.ktEffectCheckCapable ? T.ktEffectCheckCapable(x.services.generatorFeatures() || []) : true });
    return rv;
  };
  return { F, LABELS, NUMBERS, COLUMNS, READONLY, DATA, run, leftHtml, rightHtml, recheckOf, viewOf };
}

module.exports = { createReplay };
