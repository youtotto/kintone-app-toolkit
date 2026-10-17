// 会話フローの再設計 段階 B（仮案の会話。設計書 §2.1〜2.3・§2.7、契約 13 §11）: 要望 → 仮案 → 返事（採用／一部採用／不採用／修正／相談／雑談）
//
// 検証内容:
//   §B0 仮案の応答の検証と正規化（KTAiClient.validateProposal）・仮案の Context（KTContext.buildProposal）・決定的な前段（classifyDraft）
//   §B1 会話コントローラ（偽 services.propose。発言の文で台本を引く）で R01〜R08 と「ありがとう」「うーん」を 1 本の会話として固定する
//        R01 仮案 1 つ・先に必要な判断 1 件 / R02 中間の扱いを 1 問・数字は不変 / R03 期限の日数と休業日を別の key で記録・以後は再質問しない /
//        R04 通知先と条件の両方が動作と要件に残る / R05 決定事項に統合・同じ範囲を再確認しない / R06「おすすめで」は推奨を採用（おまかせ）・再要求なし /
//        R08 質問は仮案を変えず計画を作らない / 相づちは何も変えない / R07「通知は不要、期限は 5 営業日、ほかは採用」を 1 回で不採用・変更・採用（intent adopt）
//   §B2 画面（mountAiWorkspace の偽 client。health に proposal・ask / propose は SSE を模擬）: 部分表示 → 仮案のカード（ボタン・回答欄・内部の番号を出さない）→
//        回答欄 → 決定事項に記録してから AI へ → ［一部採用］は案内だけ → ［採用］で従来の計画へ（要件の台帳と仮案の対応を引き継ぐ）/ 能力が無ければ従来の流れ
//   §B3 独立レビューの指摘（2026-10-07）: 採用 → 計画の失敗で open に戻る・［再試行］は「採用します」で仮案から作り直す / 計画の AI に要件と決定事項を構造化して渡し
//        合成文を台帳に入れない / 不採用の要件の取り消しは項目 id の対応（補助は内容の文字の重なり 7 割）/ 回答済みの key の再出現は「再確認」/ intent propose は新しい仮案 /
//        採用語（承認します・確定・それで・お願いします）と相づち（はい・OK）の分類 / 仮案の応答待ちの質問は並べて答える
//   §B4 画面: 採用 → 計画の失敗 → 右の見出し・詳細・カードの文 → ［再試行］→ 計画ができたら畳む / 回答欄（data-dkey）のフォーカスの復元
//   §B6 段階 B 修正後の確認（2026-10-07）: 仮案で答えた決定事項が最初の計画（revision 無し）の Context に入り、計画の系列の台帳に回答済みとして入る（計画の AI の再質問は
//        openQuestions に出ず reasked に記録・差分更新でも decisions に入る）/ 仮案の AI の応答待ち中はカードのボタン・回答欄を出さず案内だけ / 版の表示用の goal は依頼文の 1 行目
//        （Gateway へ送る goal は 2 行のまま）/ 最終案の作成中の質問の要約は「採用した仮案（最終案を作成中）」/ 仮案が無いときの相づち・制止・短い否定は PROPOSE にしない（言い切りは 8 字以上）
//   §C・§D・§0d・§E（段階 C・C-1）: 最終案のパイプライン・必須の効果・生成工程の結果の取り込み・承認と反映の準備
//   §F（C-1 第 3 段・2026-10-08）: 入口を新しい流れに寄せ、置き換えた古い確認の流れ（質問カード・仕様の確定・確定してコードを作る・従来の生成）を削除した後の回帰
//   部品（台本・偽の計画と生成工程・会話の偽 services・画面の偽 client）は tests/helpers/new-flow.js（ほかのテストの移し替えにも使う）
//
// 実行方法: node tests/ai-flow-redesign.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { gwCandidateHash, gwHashOfCtx } = require('./helpers/gw-hash.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const T = loadToolkit();
const { KTDeps, KTScan, KTContext, KTAiClient, KTAiAnswers, KTAiConversation, KTAiChatUi, KTAiWorkspaceViewModel: VM, mountAiWorkspace } = T;
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');

// 新しい流れの共有の部品（tests/helpers/new-flow.js。台本・偽の計画と生成工程・会話の偽 services・画面の偽 client）
const { createNewFlowKit } = require('./helpers/new-flow.js');
const KIT = createNewFlowKit(T);
const { tick, ticks, clone, buildInputs, INPUTS, META, B, A, Q, APPROVER, ROUTE, BASE, CSV, Q_THRESHOLD, Q_MIDDLE, Q_DAYS, Q_HOLIDAYS, Q_LOCK, Q_TIMING, B_SELECT, B_ROUTE, B_UNDER, B_OVER, B_NOTIFY_TO, B_NOTIFY_IF, B_LOCK, STD, req, idBy, reqIdBy, script, normalized, planOk, planFail, planThrow, gateMk, HEALTH, spec, mkStep, PLAN_META, PLAN_V1, answerFor, makeStorage, gate, mount, clickChat, RP, KTCodeReview, DATA_C, LABELS_C, custOf, CUST_C1, ST_C, handlerC, GOOD, BAD, WARN, VALUE, LOCKSAVE, CAND, GEN_EFFECT_FEATURES, GW_SCOPE, EXPECT_OF, NOMATCH_OF, fakeVerification, planJs, makeGenerate, makeConvC, adoptC, finalHtml, stripC } = KIT;
/** 2026-10-14（会話の設計し直し）: 最終的にどう動くか・反映先と主な影響・検証の区分・変わった点は右の「変更内容」（changeSummaryHtml）に移した */
const rightOf = (x, v = x.c.activePlan()) => KTAiChatUi.changeSummaryHtml(v, {});
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
/** 会話に内部の番号・英字のコードが出ていないか（仮案の項目の id・key・requestId） */
const INTERNAL = /\b[BAQ][0-9]+\b|approval\.|deadline\.|notify\.|lock\.|scope\.|requestId|\bR[0-9]+「|\bE[0-9]+\b/;
const outsideDetails = (html) => String(html).replace(/<details[\s\S]*?<\/details>/g, '');



// =========================================================
(async () => {
console.log('\n--- §B0. 仮案の応答の検証と正規化・仮案の Context・決定的な前段 ---');
await section(async () => {
  const raw = { ok: true, contractVersion: '2.1', meta: META, reply: ' 結論です。 ', intent: 'adopt',
    proposal: { behaviors: [{ id: 'x9', text: '動作 1', origin: 'user' }, { id: 'x8', text: '', origin: 'ai' }, { text: '動作 2', origin: 'bogus' }], assumptions: [{ key: 'Deadline Days', label: 'l', text: '前提', changeHint: '' }, { key: 'deadline_days', text: '前提 2' }],
      decisions: [{ key: '期限', question: 'Q1?', blocking: true, options: ['a', 'b', 'c', 'd', 'e', 'f'] }, { key: 'k2', question: 'Q2?', blocking: true }, { key: 'k3', question: 'Q3?', blocking: true }, { key: 'k4', question: '' }], approach: { standard: ['s'], js: ['j'] }, cannot: ['c'] },
    turn: { ops: [{ id: 'B1', op: 'adopt' }, { id: 'Q1', op: 'modify', text: 'x' }, { id: 'Q2', op: 'reject' }, { id: 'B2', op: 'modify', text: '' }, { id: 'A1', op: 'nope' }], answers: [{ id: 'Q1', kind: 'value', text: '' }, { id: 'Q2', kind: 'delegated', text: '' }, { id: 'B1', kind: 'value', text: 'x' }], requirementOps: [{ op: 'add', behavior: 'b' }] } };
  const v = KTAiClient.validateProposal(raw);
  const n = v.normalized;
  assert(v.ok && n.reply === '結論です。' && n.proposal.behaviors.map(b => b.id).join(',') === 'B1,B2' && n.proposal.behaviors[1].origin === 'ai', `B0-1: id は B1… に振り直し・空の項目は外す・origin は user / ai: ${JSON.stringify(n.proposal.behaviors)}`);
  assert(n.proposal.assumptions.map(a => a.key).join(',') === 'deadline_days,deadline_days_2' && n.proposal.decisions.map(d => d.key).join(',') === 'other,k2,k3', `B0-2: key の正規化（小文字・空白は _）と重複（_2）・空は other: ${n.proposal.assumptions.map(a => a.key)} / ${n.proposal.decisions.map(d => d.key)}`);
  assert(n.proposal.decisions.filter(d => d.blocking).length === 2 && n.proposal.decisions[0].options.length === 5 && n.intent === 'update', `B0-3: blocking は 2 件まで・options は 5 件・blocking が残る adopt は update に: ${n.intent}`);
  assert(n.turn.ops.map(o => `${o.id}:${o.op}`).join(',') === 'B1:adopt,Q2:reject' && n.turn.answers.map(a => `${a.id}:${a.kind}`).join(',') === 'Q2:delegated' && n.turn.requirementOps.length === 1, `B0-4: 判断への ops は reject だけ・空の modify と語彙外の op は外す・空の value の answer は外す: ${JSON.stringify(n.turn)}`);
  assert(v.warnings.some(w => w.code === 'PROPOSAL_BLOCKING_LIMIT') && v.warnings.some(w => w.code === 'PROPOSAL_KEY_DUPLICATE') && v.warnings.some(w => w.code === 'PROPOSAL_ADOPT_WITH_BLOCKING') && v.warnings.some(w => w.code === 'PROPOSAL_OP_ON_DECISION'), `B0-5: 直した点は clientWarnings に残す: ${v.warnings.map(w => w.code).join(',')}`);
  const v2 = KTAiClient.validateProposal({ ok: true, contractVersion: '2.1', meta: META, reply: 'r', intent: 'bogus', proposal: {}, turn: { ops: [{ id: 'B1', op: 'adopt' }] } });
  assert(v2.ok && v2.normalized.intent === 'unclear' && v2.normalized.proposalUnchanged === true && v2.normalized.turn.ops.length === 0, 'B0-6: 語彙外の intent は unclear（仮案を変えない。turn は外す）');
  assert(!KTAiClient.validateProposal({ ok: true, contractVersion: '2.1', meta: META, reply: '', intent: 'propose' }).ok && !KTAiClient.validateProposal({ ok: false }).ok, 'B0-7: reply が無い・ok でないときは失敗');
  // 仮案の Context: KTContext v1 の形・conversation.mode・facts を絞る（目安 12k 字）
  const ctx = KTContext.buildProposal({ utterance: '金額が100万円以上なら部長承認にして、承認後は金額を編集できなくしたい', previous: null, requirements: [], decisions: [{ id: 'dd1', key: 'deadline.days', label: '期限', answer: '7営業日', kind: 'value' }], data: INPUTS.data, deps: INPUTS.deps, scan: INPUTS.scan, incoming: INPUTS.incoming, options: { now: '2026-10-07T00:00:00.000Z' } });
  assert(ctx.contextVersion === '1' && ctx.question.startsWith('金額が100万円以上') && ctx.conversation.mode === 'proposal' && ctx.conversation.proposal === null && ctx.conversation.decisions[0].key === 'deadline.days' && Array.isArray(ctx.conversation.requirements), 'B0-8: KTContext v1 の形で question = 今回の発言・conversation = { mode proposal, proposal, decisions, requirements }');
  const kinds = new Set(ctx.facts.map(f => f.kind));
  assert(ctx.facts.every((f, i) => f.id === `E${i + 1}`) && kinds.has('overview') && ctx.facts.some(f => f.kind === 'field' && f.field && f.field.code === 'amount') && kinds.has('js-file') && ctx.size.chars <= 12000 && ctx.size.chars >= 2000, `B0-9: 根拠ID は E1…・概要・関連フィールド（金額）・既存 JS の要約を含み 12k 字以内: ${ctx.size.chars} 字 / ${[...kinds].join(',')}`);
  assert(!ctx.conversation.brief && !ctx.planContext && JSON.stringify(ctx.facts).length < JSON.stringify(KTContext.buildPlan({ goal: ctx.question, data: INPUTS.data, deps: INPUTS.deps, scan: INPUTS.scan, incoming: INPUTS.incoming }).facts).length, 'B0-10: brief / planContext は付けない。計画の Context より小さい');
  // 決定的な前段
  const c = KTAiConversation.classifyDraft;
  const noDraft = { activePlan: null, draft: null, draftDecisions: [] };
  const open = { activePlan: null, draftDecisions: [], draft: { id: 'd1', status: 'open', items: { behaviors: [], assumptions: [], decisions: [{ id: 'Q1', key: 'k', question: 'q', recommendation: 'rec', blocking: true }], approach: { standard: [], js: [] }, cannot: [] } } };
  const openNoRec = { ...open, draft: { ...open.draft, items: { ...open.draft.items, decisions: [{ id: 'Q1', key: 'k', question: 'q', recommendation: '', blocking: true }] } } };
  assert(c('課長・部長の承認者を選ぶ運用にしたい', noDraft)?.intent === 'PROPOSE' && c('このフィールドは何に使ってる？', noDraft) === null && c('ありがとう', noDraft) === null && c('反映して', noDraft) === null && c('承認済みでは金額を編集不可', noDraft)?.intent === 'PROPOSE', 'B0-11: 計画も仮案も無い: 依頼は PROPOSE・質問 / 相づち / 操作の命令は従来');
  assert(c('ありがとう', open)?.reason === 'DRAFT_SMALLTALK' && c('うーん', open)?.reason === 'DRAFT_SMALLTALK' && c('5営業日にすると何が変わる？', open) === null, 'B0-12: 仮案が open: 相づちは何もしない・質問文だけは従来の QA');
  assert(c('それでお願いします', open)?.intent === 'DRAFT_REPLY' && c('それでお願いします', { ...open, draftDecisions: [{ key: 'k', answer: 'x' }] })?.intent === 'ADOPT_DRAFT' && c('採用します', { ...open, draftDecisions: [{ key: 'k', answer: 'x' }] })?.reason === 'ADOPT_WORDS', 'B0-13: 明確な採用語: 先に必要な判断が残っていれば AI に聞き直させ、無ければ ADOPT_DRAFT');
  assert(c('おすすめで', open)?.intent === 'GENERAL' && c('おすすめで', open)?.reason === 'DELEGATE_ONLY' && c('おすすめで', open)?.delegated[0].kind === 'delegated' && c('おすすめで', openNoRec)?.reason === 'DELEGATE_WITH_OPEN' && c('おすすめで。この案で進めて', open)?.intent === 'ADOPT_DRAFT' && c('おすすめで。この案で進めて', open)?.reason === 'DELEGATE' && c('おすすめで。この案で進めて', open)?.delegated[0].kind === 'delegated', 'B0-14（2026-10-15 §3.2）:「おすすめで」だけは推奨の回答を記録するだけ（採用しない）。推奨の無い先に必要な判断だけなら AI へ。進行の語句（この案で進めて）が同時にあれば記録した上で採用');
  assert(c('通知は不要、期限は5営業日、ほかは採用', open)?.intent === 'DRAFT_REPLY' && c('この案は採用しません', open)?.intent === 'DRAFT_REPLY' && c('ほかは採用で', open)?.intent === 'DRAFT_REPLY', 'B0-15: 修正の語を含む文・不採用は DRAFT_REPLY（AI に読ませる）');
  assert(c('何か', { ...noDraft, activePlan: { status: 'ACTIVE' } }) === null && c('採用します', { ...open, activePlan: { status: 'ACTIVE' } }) === null, 'B0-16: 計画があるときは従来どおり（null）');
});

// =========================================================
console.log('\n--- §B1. 会話コントローラ: R01〜R08 と「ありがとう」「うーん」を 1 本の会話として（偽 services.propose） ---');
/**
 * 偽 services。withPlan = true で services.plan を付ける（既定は計画を作らない応答）。planImpl で差し替え（x.planImpl = … で後から変えられる）。
 * proposeGate を渡すと、仮案の AI の応答を途中で止められる（応答待ちの間の発言の検証）。台本は scriptFn（既定は script）
 */
//   2026-10-15（追加の指示 1）: autoMap = 偽の計画の AI が要件の対応づけ（requirementOps）を返す（K.withPlannerMapping。わざと担当を欠いた回帰は false）
function makeConv({ features = ['requirements', 'brief', 'stream', 'proposal'], withPlan = false, planImpl = null, proposeGate = null, scriptFn = script, autoMap = true } = {}) {
  const calls = { propose: [], ask: [], plan: [] };
  let t = 1000;
  const x = { planImpl };
  const services = {
    conversationFeatures: () => features,
    revisionModes: () => ['full'],
    async propose(args) {
      calls.propose.push({ utterance: args.utterance, previous: clone(args.previous), decisions: clone(args.decisions), requirements: clone(args.requirements), working: args.working });
      const raw = scriptFn(args);
      if (!raw) return { ok: false, reason: 'NO_SCRIPT', message: `台本がありません: ${args.utterance}` };
      t += 3000; if (typeof args.onText === 'function') args.onText(raw.reply.slice(0, 12)); await tick();
      if (proposeGate) await proposeGate.p;
      t += 4000; if (typeof args.onText === 'function') args.onText(raw.reply);
      return { ok: true, proposal: normalized(raw, `pp-${calls.propose.length}`), ctx: { facts: [] }, perf: { baseWaitMs: 0, contextMs: 5, requestMs: 7000 } };
    },
    async ask(args) { calls.ask.push({ question: args.question, conversation: clone(args.conversation) }); t += 2000; return { ok: true, answer: { answer: '5 営業日にすると判定が 2 営業日早くなります。', facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx: { facts: [] } }; },
    readiness() { return null; },
    ...(withPlan || planImpl ? { async plan(args) { calls.plan.push({ goal: args.goal, decisions: clone(args.decisions ?? null), requirements: clone(args.requirements ?? null), revision: args.revision ? true : false }); t += 30000; const r0 = x.planImpl ? x.planImpl(args) : { plan: null, message: '（テスト: 計画は作らない）', reason: 'TEST' }; const r = r0 && typeof r0.then === 'function' ? await r0 : r0; return autoMap ? KIT.withPlannerMapping(r, args.requirements) : r; } } : {}),
  };
  const c = KTAiConversation.create({ services, now: () => '2026-10-07T00:00:00.000Z', clock: () => t });
  Object.assign(x, { c, calls, services, kinds: () => c.messages().map(m => m.data?.kind || m.type), last: () => c.messages()[c.messages().length - 1], draft: () => c.draft(), ledger: (id) => c.state.ledgers.get(id) || null });
  return x;
}
await section(async () => {
  const x = makeConv();
  const { c, calls } = x;
  const draft = () => c.draft();
  const keys = () => c.draftDecisions().map(d => d.key);
  const openKeys = () => (draft().items.decisions || []).map(d => d.key);
  const behaviorTexts = () => draft().items.behaviors.map(b => b.text);
  const reqs = () => c.requirements();
  assert(c.proposalOn() === true && c.classify('課長・部長の承認者を選ぶ運用にしたい').intent === 'PROPOSE', 'R01-0: health の conversation に proposal があるので仮案の経路');

  // R01
  const r1 = await c.send('課長・部長の承認者を選ぶ運用にしたい');
  assert(r1.ok && r1.intent === 'PROPOSE' && calls.propose.length === 1 && calls.plan.length === 0 && calls.propose[0].previous === null && calls.propose[0].decisions.length === 0, 'R01-1: 新しい依頼は仮案の AI へ（計画の AI・先回りの返答は呼ばない。前回の仮案は null）');
  assert(draft() && draft().status === 'open' && draft().rev === 1 && draft().request === '課長・部長の承認者を選ぶ運用にしたい' && draft().items.behaviors.length === 2 && draft().items.decisions.filter(d => d.blocking).length === 1 && draft().items.decisions.length === 1, `R01-2: 仮案 1 つ・先に必要な判断 1 件: ${JSON.stringify(draft().items.decisions.map(d => d.key))}`);
  const cards = c.messages().filter(m => m.type === 'DRAFT');
  assert(cards.length === 1 && cards[0].data.draftId === draft().id && cards[0].data.rev === 1 && /課長と部長を申請ごとに選んで/.test(cards[0].data.reply), 'R01-3: 仮案のカード（MSG.DRAFT）が 1 枚');
  assert(reqs().length === 1 && reqs()[0].decision === 'decided' && /課長と部長の承認者/.test(reqs()[0].behavior), `R01-4: 要件は仮案の台帳（鍵は仮案の id）に decided で入る: ${JSON.stringify(reqs())}`);
  const t1 = c.metrics().timings.slice(-1)[0];
  assert(t1.intent === 'PROPOSE' && t1.firstTextMs === 3000 && t1.doneMs === 7000 && t1.aiCalls === 1 && t1.calls[0].kind === 'propose' && t1.ai && t1.ai.model === 'm' && t1.ai.outputTokens === 500, `R01-5: 計測（firstTextMs / doneMs / ai）: ${JSON.stringify(t1)}`);
  assert(!c.messages().some(m => m.type === 'LOADING'), 'R01-6: 逐次表示の吹き出しは完了で外れる');

  // R02
  const r2 = await c.send('100円未満は部長不要、100万円以上は必要');
  assert(r2.ok && r2.intent === 'DRAFT_REPLY' && calls.propose.length === 2 && calls.propose[1].previous && calls.propose[1].previous.decisions[0].id === 'Q1' && calls.propose[1].previous.behaviors.length === 2, 'R02-1: 返事は前回の仮案（id 付き）と一緒に仮案の AI へ');
  assert(draft().rev === 2 && openKeys().join(',') === 'approval.threshold_middle,deadline.days,deadline.holidays' && draft().items.decisions.filter(d => d.blocking).length === 1 && behaviorTexts().some(s => /100円未満/.test(s)) && behaviorTexts().some(s => /100万円以上/.test(s)), `R02-2: 中間の扱いだけ 1 問（先に必要）・数字は不変: ${openKeys()} / ${behaviorTexts().join('｜')}`);
  assert(keys().includes('approval.threshold') && c.draftDecisions().find(d => d.key === 'approval.threshold').answer === '100円未満は不要、100万円以上は必要' && draft().items.behaviors[0].origin === 'user', 'R02-3: 前回の判断への回答は key 付きの決定事項に・採用した項目は origin user');
  assert(reqs().filter(r => r.decision !== 'revoked').length === 3 && c.messages().filter(m => m.type === 'DRAFT').length === 2, 'R02-4: 要件 3 件・仮案のカードは新しい 1 枚（前のカードは畳む側）');
  const prevCard = c.messages().filter(m => m.type === 'DRAFT')[0];
  assert(/kt-ai-old-card/.test(KTAiChatUi.messageHtml(prevCard, { draft: draft(), draftDecisions: c.draftDecisions() })) && /前の仮案 — このあと直した案があります/.test(KTAiChatUi.messageHtml(prevCard, { draft: draft(), draftDecisions: c.draftDecisions() })), 'R02-5: 前の仮案のカードは 1 行に畳む');

  // R03
  const r3 = await c.send('7営業日で。会社独自の休業日は今回はなし');
  assert(r3.ok && r3.intent === 'DRAFT_REPLY' && c.draftDecisions().find(d => d.key === 'deadline.days')?.answer === '7営業日' && c.draftDecisions().find(d => d.key === 'deadline.holidays')?.answer === '会社独自の休業日は考慮しない', `R03-1: 期限の日数と休業日を別の key で記録: ${JSON.stringify(c.draftDecisions().map(d => [d.key, d.answer]))}`);
  assert(openKeys().join(',') === 'approval.threshold_middle' && draft().items.assumptions.some(a => a.key === 'deadline.days'), 'R03-2: 回答済みの判断は仮案から消え、前提（7 営業日）になる');

  // R04
  const r4 = await c.send('現在の承認者へ。課長承認中で100万円以上なら部長にも通知');
  assert(r4.ok && behaviorTexts().some(s => /現在の承認者へ/.test(s)) && behaviorTexts().some(s => /課長承認中で100万円以上/.test(s)) && reqs().some(r => /現在の承認者/.test(r.behavior)) && reqs().some(r => /課長承認中で100万円以上/.test(r.condition) && /部長にも通知/.test(r.behavior)), `R04-1: 通知先と条件の両方が動作と要件に残る: ${behaviorTexts().slice(-2).join('｜')}`);
  assert(calls.propose[3].decisions.map(d => d.key).sort().join(',') === 'approval.threshold,deadline.days,deadline.holidays' && calls.propose[3].requirements.length >= 4, 'R04-2: 仮案の AI には決定事項（key 付き）と要件の台帳を毎回渡す');

  // R05
  await c.send('申請中は編集不可にして。CSV・APIは使わない');
  assert(openKeys().join(',') === 'approval.threshold_middle,lock.scope' && draft().items.assumptions.some(a => a.key === 'scope.csv_api') && draft().items.approach.js.length === 1, 'R05-1: 編集不可は JavaScript の進め方・CSV / API は前提として保持（判断にはしない）');
  const r5 = await c.send('全員で');
  assert(r5.ok && r5.intent === 'DRAFT_REPLY' && c.draftDecisions().find(d => d.key === 'lock.scope')?.answer === '全員' && openKeys().join(',') === 'approval.threshold_middle,notify.timing', 'R05-2:「全員で」は決定事項に統合され、同じ範囲（編集不可の対象）は再確認しない');

  // R06
  const r6 = await c.send('おすすめで');
  const mid = c.draftDecisions().find(d => d.key === 'approval.threshold_middle');
  assert(r6.ok && r6.intent === 'GENERAL' && r6.reason === 'DELEGATE_ONLY' && mid && mid.kind === 'delegated' && mid.answer === '不要' && x.last().data?.kind === 'draft-delegated' && x.last().text === 'おすすめの内容で決めました。', `R06-1（2026-10-15 §3.2）:「おすすめで」は推奨のある判断に推奨の回答を記録するだけ（採用しない・AI を呼ばない・返答は 1 文）: ${JSON.stringify({ intent: r6.intent, reason: r6.reason, mid, last: x.last().text })}`);
  assert(calls.propose.length === 6 && openKeys().join(',') === 'approval.threshold_middle,notify.timing' && KTAiConversation.openDraftDecisions(draft(), c.draftDecisions()).map(d => d.key).join(',') === 'notify.timing' && draft().status === 'open' && !/[？?]/.test(x.last().text), 'R06-2: 仮案の項目は変えず（AI を呼ばない）、おまかせの判断は決定事項で閉じる（開いている判断は通知のタイミングだけ）。仮案は open のまま・質問を増やさない');
  const nPropose6 = calls.propose.length, rev6 = draft().rev, nReq6 = reqs().length;

  // R08（質問は従来の QA。仮案の要約を文脈に添える）
  const r8 = await c.send('5営業日にすると何が変わる？');
  assert(r8.ok && r8.intent === 'ASK' && calls.ask.length === 1 && calls.plan.length === 0 && calls.propose.length === nPropose6 && draft().rev === rev6, 'R08-1: 質問は仮案を変えず、計画の作成を始めない（質問の AI へ）');
  const cv = calls.ask[0].conversation;
  assert(cv.plan && /採用前の仮案/.test(cv.plan.summary) && cv.plan.questions.some(q => /部長への通知/.test(q.question)) && cv.plan.provisionals.some(p => p.topic === 'deadline.days') && cv.requirements.length === nReq6, `R08-2: 質問の AI に仮案の要約（動作・前提・残る判断・要件）を添える: ${JSON.stringify(cv.plan).slice(0, 160)}`);
  // 質問の形ではないが AI が相談（question）と読んだ発言: 仮案は変えない（proposalUnchanged）
  const r8b = await c.send('5営業日と7営業日の違いが気になる');
  assert(r8b.ok && r8b.intent === 'DRAFT_REPLY' && r8b.draft && r8b.draft.unchanged === true && draft().rev === rev6 && x.last().data?.kind === 'draft-reply' && /2 営業日早く/.test(x.last().text) && c.messages().filter(m => m.type === 'DRAFT').length === 6, 'R08-3: AI が相談と読んだときは仮案も要件も変えず、返事だけ（新しいカードは出さない。「おすすめで」の記録だけの返事もカードを増やさない）');

  // 相づち
  const ra = await c.send('ありがとう');
  const rb = await c.send('うーん');
  assert(ra.intent === 'GENERAL' && ra.reason === 'DRAFT_SMALLTALK' && rb.reason === 'DRAFT_SMALLTALK' && calls.propose.length === nPropose6 + 1 && draft().rev === rev6 && reqs().length === nReq6 && c.draftDecisions().length === 5, 'R-相づち:「ありがとう」「うーん」は AI を呼ばず、仮案・要件・決定事項を変えない');
  assert(/いつでもどうぞ/.test(x.last().text) && !INTERNAL.test(x.last().text), '相づちへの返事は短い案内だけ');

  // R07
  const r7 = await c.send('通知は不要、期限は5営業日、ほかは採用');
  assert(r7.ok && r7.intent === 'DRAFT_REPLY' && r7.draft && r7.draft.intent === 'adopt' && draft().status === 'adopted' && draft().adoptedBy === 'AI_ADOPT', `R07-1: 1 回の発言で不採用・変更・採用（intent adopt）→ 仮案は adopted: ${JSON.stringify(r7.draft)} / ${draft().status}`);
  const h = draft().history.slice(-1)[0];
  assert(h.applied.rejected.length === 2 && h.applied.modified.length === 1 && h.applied.adopted.length >= 3 && h.applied.dismissed.length === 1, `R07-2: 適用した返事（不採用 2・変更 1・採用 3 以上・不要になった判断 1）: ${JSON.stringify(h.applied)}`);
  assert(draft().rejected.length === 2 && draft().rejected.every(r => /通知/.test(r.text)) && !behaviorTexts().some(s => /通知/.test(s)) && draft().items.decisions.length === 0, 'R07-3: 不採用の項目は仮案から外れ、不採用として残る');
  const revoked = reqs().filter(r => r.decision === 'revoked');
  assert(revoked.length === 2 && revoked.every(r => /通知/.test(`${r.condition}${r.behavior}`)) && reqs().some(r => r.decision !== 'revoked' && /5 営業日/.test(r.behavior)) && !reqs().some(r => r.decision !== 'revoked' && /7 営業日/.test(r.behavior)), `R07-4: 通知の要件は revoke・期限の要件は 5 営業日に更新: ${JSON.stringify(reqs().map(r => [r.id, r.decision, r.behavior]))}`);
  assert(c.draftDecisions().find(d => d.key === 'deadline.days')?.answer === '承認の期限は申請から 5 営業日（土日祝のみ除く）' && c.draftDecisions().find(d => d.key === 'deadline.days').history.length === 1, 'R07-5: key のある前提の変更は、同じ key の決定事項も更新（前の答えは履歴に）');
  //   レビュー 7（2026-10-14）: 「kintone にはまだ何も反映していません」は進みのカードの案内行に 1 回だけ（採用の案内では言わない）
  assert(x.last().data?.kind === 'draft-adopted' && /この案で進めます/.test(x.last().text) && !/kintone にはまだ何も反映していません/.test(x.last().text) && calls.plan.length === 0, 'R07-6: services.plan が無いときは採用の案内だけ（最終案の作成は段階 C。「まだ何も反映していません」は繰り返さない）');
  const t7 = c.metrics().timings.slice(-1)[0];
  assert(t7.intent === 'DRAFT_REPLY' && t7.ackMs != null && t7.firstTextMs === 3000 && t7.doneMs >= 7000, `R07-7: 計測: ${JSON.stringify({ intent: t7.intent, ackMs: t7.ackMs, firstTextMs: t7.firstTextMs, doneMs: t7.doneMs })}`);
  // 以後の台本で再質問が無かったこと（R03 / R05 / R06 の key）
  //   記録済みの決定事項（AI に渡す decisions）の key が、同じ呼び出しの前回の仮案の判断に残っていないこと（Toolkit が回答済みの key を仮案から外す）
  const reasked = calls.propose.flatMap((p, i) => { const done = new Set(p.decisions.map(d => d.key)); return (p.previous ? p.previous.decisions : []).filter(d => done.has(d.key)).map(d => `${i}:${d.key}`); });
  assert(reasked.length === 0 && calls.propose.slice(-1)[0].decisions.map(d => d.key).sort().join(',') === 'approval.threshold,approval.threshold_middle,deadline.days,deadline.holidays,lock.scope', `R03/R05: 回答済みの key は以後の仮案に判断として出ない（決定事項は 5 件を毎回渡す）: ${reasked.join(',')}`);
  // 表示: 内部の番号・key を出さない
  const view = { draft: draft(), draftDecisions: c.draftDecisions(), draftAnswers: new Map() };
  const html = c.messages().filter(m => m.type === 'DRAFT').map(m => KTAiChatUi.messageHtml(m, view)).join('');
  //   内部の番号・key の検査は details の中も含める（services.plan が無い採用は「採用しました（最終案はこのあと作ります）」）
  assert(!INTERNAL.test(html.replace(/data-[a-z]+="[^"]*"/g, '')) && /仮案 — 採用済み/.test(html) && !/採用して最終案を作っています/.test(html), `表示: 内部の番号・key を出さない（details の中も）・採用した仮案は 1 行に畳む: ${(html.replace(/data-[a-z]+="[^"]*"/g, '').match(INTERNAL) || [])[0]}`);
  // 右ペインの詳細
  const sum = KTAiChatUi.draftSummaryHtml(draft(), { decisions: c.draftDecisions() });
  assert(/必要な判断/.test(sum) && sum.indexOf('必要な判断') < sum.indexOf('実現する動作') && /不採用にした項目/.test(sum) && /進め方/.test(sum) && /判断の経緯/.test(sum) && !INTERNAL.test(sum.replace(/data-[a-z]+="[^"]*"/g, '')), '右の詳細: 必要な判断を先に・不採用・進め方・判断の経緯');
});
// 採用の引き継ぎ（services.plan があるとき: 段階 B では従来の計画の作成へ。goal に採用した方針と決定事項）
await section(async () => {
  const x = makeConv({ withPlan: true });
  const { c, calls } = x;
  await c.send('課長・部長の承認者を選ぶ運用にしたい');
  await c.send('100円未満は部長不要、100万円以上は必要');
  const r = await c.send('採用します');
  assert(r.intent === 'DRAFT_REPLY' && r.reason === 'ADOPT_WITH_OPEN' && calls.plan.length === 0, '採用-1: 先に必要な判断が残る間は「採用します」でも採用にしない（AI に聞き直させる。台本が無いのでここでは失敗）');
  const x2 = makeConv({ withPlan: true });
  await x2.c.send('課長・部長の承認者を選ぶ運用にしたい');
  await x2.c.send('100円未満は部長不要、100万円以上は必要');
  await x2.c.send('7営業日で。会社独自の休業日は今回はなし');
  const r2 = await x2.c.send('おすすめで。この案で進めて');
  //   goal は元の依頼文 ＋ 採用した方針 1 行だけ（決定事項・前提・不採用の長文は合成しない。決定事項と要件は構造化して渡す）。計画を作れなかったので仮案は open のまま
  const p0 = x2.calls.plan[0];
  assert(r2.intent === 'ADOPT_DRAFT' && r2.reason === 'DELEGATE' && x2.calls.plan.length === 1 && x2.c.draft().status === 'open' && x2.c.draft().planFailed && p0.goal.startsWith('課長・部長の承認者を選ぶ運用にしたい\n採用した方針:') && !/決定事項:|前提（変えてよい点）|不採用/.test(p0.goal) && p0.goal.length < 600, `採用-2:「おすすめで。この案で進めて」（委ねる言い方 ＋ 進行の語句）で残る判断が無ければ採用 → 計画の依頼（goal は依頼文 ＋ 方針 1 行。失敗したら open のまま）: ${p0.goal.slice(0, 200)}`);
  const t = x2.c.metrics().timings.slice(-1)[0];
  assert(t.intent === 'ADOPT_DRAFT' && t.ackMs != null && t.calls.some(k => k.kind === 'plan'), `採用-3: 計測（ADOPT_DRAFT・calls に plan）: ${JSON.stringify({ intent: t.intent, calls: t.calls.map(k => k.kind) })}`);
  const dec = p0.decisions || [];
  assert(dec.length === 4 && dec.every((d, i) => d.id === `D${i + 1}` && d.source === 'chat' && d.status === 'answered') && dec.find(d => d.key === 'approval.threshold').topic === 'approver' && dec.find(d => d.key === 'deadline.days').topic === 'timing' && dec.find(d => d.key === 'deadline.holidays').topic === 'timing' && dec.find(d => d.key === 'approval.threshold_middle').delegated === true && !/おまかせ/.test(dec.find(d => d.key === 'approval.threshold_middle').answer) && dec.every(d => d.kind === 'question' && d.question), `採用-4: 決定事項は計画の AI に構造化して渡す（id D…・topic は key から・おまかせは別の印）: ${JSON.stringify(dec)}`);
  assert(Array.isArray(p0.requirements) && p0.requirements.length >= 4 && p0.requirements.every(r => /^R[0-9]+$/.test(r.id)) && p0.requirements.some(r => r.decision === 'decided' && /課長と部長の承認者/.test(r.behavior)), `採用-5: 要件の台帳も渡す: ${JSON.stringify(p0.requirements.map(r => [r.id, r.decision]))}`);
});
// C-1 第 3 段（2026-10-08）: 仮案の能力が無い接続先は、古い流れに入らず「接続先が非対応」で止める（質問には今の assistant-qa の通常の返事で答える。計画・生成・登録には進まない）
await section(async () => {
  const x = makeConv({ features: ['requirements', 'brief'], withPlan: true });
  const r = await x.c.send('課長・部長の承認者を選ぶ運用にしたい');
  assert(x.c.proposalOn() === false && r.intent === 'GENERAL' && r.reason === 'UNSUPPORTED_CONNECTION' && x.calls.propose.length === 0 && x.calls.plan.length === 0 && x.c.draft() === null && x.c.activePlan() === null && /接続先が非対応です（仮案と最終案の流れに対応した接続先が必要です）/.test(x.last().text), `B5-1: health に proposal が無ければ「接続先が非対応」で止める（仮案の AI も計画の AI も呼ばない）: ${JSON.stringify({ intent: r.intent, reason: r.reason, plan: x.calls.plan.length })}`);
  const y = makeConv({ features: ['requirements', 'brief', 'proposal'], withPlan: true });
  y.services.propose = undefined;
  const ry = await y.c.send('課長・部長の承認者を選ぶ運用にしたい');
  assert(y.c.proposalOn() === false && ry.reason === 'UNSUPPORTED_CONNECTION' && y.calls.plan.length === 0, 'B5-2: services.propose が無くても「接続先が非対応」（従来の計画の経路に入らない）');
  // 質問は今の assistant-qa の通常の返事で答える。ボタン・［再試行］から意図を指定しても計画・生成には進まない
  const rq = await x.c.send('このフィールドは何に使ってる？');
  const ro = await x.c.send('新しい変更案にして', { intentOverride: 'PLAN' });
  const rg = await x.c.send('コードを作って', { intentOverride: 'GENERATE_CODE' });
  const rv = await x.c.send('一覧の名前を変えて', { intentOverride: 'REVISE_PLAN' });
  assert(rq.intent === 'ASK' && x.calls.ask.length === 1 && [ro, rg, rv].every(z => z.reason === 'UNSUPPORTED_CONNECTION') && x.calls.plan.length === 0 && x.calls.propose.length === 0, `B5-2b: 質問は答え、意図を指定した計画・生成・修正も「接続先が非対応」: ${JSON.stringify([rq.intent, ro.reason, rg.reason, rv.reason])}`);
  assert(x.c.classify('課長・部長の承認者を選ぶ運用にしたい').reason === 'UNSUPPORTED_CONNECTION', 'B5-2c: 画面の同意の判定に使う分類も「接続先が非対応」（AI を使う依頼として同意を求めない）');
});

// =========================================================
console.log('\n--- §B2. 画面: 偽 client（health に proposal・SSE の部分表示・カードのボタン・回答欄・採用で従来の計画へ） ---');
await section(async () => {
  const g = gate();
  const m = mount({ proposeGate: g });
  await ticks();
  const p = m.panel.send('課長・部長の承認者を選ぶ運用にしたい');
  await ticks(8);
  const during = m.chat();
  assert(m.calls.propose.length === 1 && m.calls.propose[0].stream === true && /kt-ai-streaming/.test(during) && /課長と部長を申請/.test(during) && !/kt-ai-draft-card/.test(during) && !/kt-ai-plan-card/.test(during), `B2-1: 仮案の AI の reply は SSE で部分表示（仮案のカード・変更案はまだ出ない）: ${during.slice(0, 200)}`);
  assert(/data-status="drafting">仮案を作成中</.test(m.$('kt-ai-ws-state').innerHTML) && m.conv().state.working === 'PROPOSE', `B2-1b: 右の見出しは「仮案を作成中」（応答待ちの間）: ${m.$('kt-ai-ws-state').innerHTML}`);
  // 応答待ちの間の発言: 質問は並べて答える（入力欄は空に）、それ以外は入力欄に残す（案内）
  m.$('kt-ai-input').value = 'CSVにも効きますか？';
  const rq1 = await m.panel.send('CSVにも効きますか？', { source: 'composer' });
  await ticks(4);
  assert(rq1 && rq1.asked === true && m.calls.ask.length === 1 && m.$('kt-ai-input').value === '' && m.calls.propose.length === 1, `B2-1c: 仮案の応答待ちの質問は並べて答える（入力欄は空に）: ${JSON.stringify(rq1)}`);
  m.$('kt-ai-input').value = '通知は不要';
  const rq2 = await m.panel.send('通知は不要', { source: 'composer' });
  assert(rq2 === null && m.$('kt-ai-input').value === '通知は不要' && /仮案を作っています。この文は仮案ができてから/.test(m.$('kt-ai-composer-note') ? m.$('kt-ai-composer-note').textContent : m.host.innerHTML), 'B2-1d: 仮案の応答待ちの返事・指示は入力欄に残し、案内を出す');
  g.open(); await p; await ticks(8);
  const ctx0 = m.calls.propose[0].ctx;
  assert(ctx0.conversation.mode === 'proposal' && ctx0.question === '課長・部長の承認者を選ぶ運用にしたい' && ctx0.conversation.proposal === null && Array.isArray(ctx0.facts) && ctx0.facts[0].id === 'E1' && ctx0.size.chars <= 12000 && !ctx0.planContext && ctx0.conversation.brief === undefined, `B2-2: 送った Context は KTContext.buildProposal（mode proposal・絞った facts）: ${ctx0.size.chars} 字`);
  const chat = m.chat();
  //   2026-10-14 の設計し直し（指示書 §1.1・§3）: 会話の仮案のカードは AI の返答と選択だけ。実現する動作・判断（回答欄）・前提は右の「変更内容」の仮案の詳細（B2-6）
  const card = (chat.match(/<div class="kt-ai-card kt-ai-draft-card[\s\S]*?data-act="draft-adopt"[\s\S]*?<\/div>/) || [''])[0];
  assert(/仮案ができました。/.test(chat) && /課長と部長を申請ごとに選んで承認する流れにできます/.test(chat) && !/実現する動作/.test(chat) && !/判断が必要な点/.test(chat) && !/先に決めたいこと/.test(chat) && !/こちらの提案で進める点/.test(chat) && !/まだ何も反映していません/.test(chat), 'B2-3: 仮案のカードは AI の返答と選択だけ（動作・判断・前提は右の「変更内容」。2026-10-14）');
  assert(/data-act="draft-adopt"[^>]*>採用</.test(chat) && /data-act="draft-partial"[^>]*>一部採用</.test(chat) && /data-act="draft-reject"[^>]*>不採用</.test(chat) && !/data-act="draft-answer"/.test(chat) && !/data-dkey="/.test(chat) && /返事や質問は、そのまま入力欄に書いてください。/.test(chat), 'B2-4: 入力の補助ボタン［採用］［一部採用］［不採用］と自由入力の案内 1 行（回答欄は右の仮案の詳細。2026-10-14）');
  //   仮案のカードは details の中（前提・判断の経緯）も含めて検査する（質問の答えのカードの「詳細情報」の requestId は従来の監査用の表示なので、会話全体は details の外で見る）
  const draftHtmlAll = m.msgs().filter(x => x.type === 'DRAFT').map(x => KTAiChatUi.messageHtml(x, { draft: m.conv().draft(), draftDecisions: m.conv().draftDecisions(), draftAnswers: new Map() })).join('').replace(/data-[a-z]+="[^"]*"/g, '');
  assert(!INTERNAL.test(outsideDetails(chat).replace(/data-[a-z]+="[^"]*"/g, '')) && !INTERNAL.test(draftHtmlAll) && !/kt-ai-plan-card/.test(chat) && !/kt-ai-questions-card/.test(chat) && !/kt-ai-streaming/.test(chat), `B2-5: 会話に内部の番号・key を出さない（仮案のカードの全体。2026-10-14: カードに details は無くなった）。確認事項のカード・変更案のカードは出ない: ${(draftHtmlAll.match(INTERNAL) || outsideDetails(chat).replace(/data-[a-z]+="[^"]*"/g, '').match(INTERNAL) || [])[0]}`);
  const sum = m.$('kt-ai-change-summary').innerHTML;
  assert(/必要な判断（1 件）/.test(sum) && /先に必要/.test(sum) && /実現する動作/.test(sum) && /こちらの提案で進める点/.test(sum) && /進め方/.test(sum) && /おすすめ：一定金額以上のときだけ/.test(sum) && /data-act="draft-answer"[^>]*>回答を送る</.test(sum) && /class="kt-ai-qa-input kt-ai-draft-input" data-dkey="/.test(sum) && m.$('kt-ai-pane-plan-empty').style.display === 'none', `B2-6: 右「変更内容」に仮案の詳細（必要な判断を先に。2026-10-14: 回答欄と［回答を送る］もここ）: ${sum.slice(0, 160)}`);
  assert(/data-status="draft">仮案</.test(m.$('kt-ai-ws-state').innerHTML), `B2-7: 右の見出しの状態: 仮案: ${m.$('kt-ai-ws-state').innerHTML}`);
  const t1 = m.panel.metrics().timings.slice(-1)[0];
  assert(t1.intent === 'PROPOSE' && t1.firstTextMs === 2500 && t1.doneMs === 7000 && t1.ai && t1.ai.model === 'm' && t1.perf && t1.perf.requestMs === 7000, `B2-8: 計測（画面の時計）: ${JSON.stringify({ intent: t1.intent, firstTextMs: t1.firstTextMs, doneMs: t1.doneMs, perf: t1.perf })}`);
  // ［一部採用］は入力欄に案内を出すだけ
  await clickChat(m, 'draft-partial', { draft: m.conv().draft().id });
  assert(/変えたい点を書いてください/.test(m.$('kt-ai-input').placeholder) && m.calls.propose.length === 1, 'B2-9:［一部採用］は入力欄の案内だけ（送らない）');
  // 回答欄 → 決定事項に記録してから AI へ
  const d1 = m.conv().draft();
  const q = d1.items.decisions[0];
  //   2026-10-14: 回答欄は右の「変更内容」（kt-ai-change-summary）にあるので、入力はそこへ（送るボタンの処理は同じ handleAct）
  await m.$('kt-ai-change-summary').dispatch({ type: 'input', target: { dataset: { dkey: `${d1.id}:${q.key}`, draft: d1.id, did: q.id }, value: '100円未満は部長不要、100万円以上は必要' } });
  await clickChat(m, 'draft-answer', { draft: d1.id });
  await ticks(10);
  const ctx1 = m.calls.propose[1].ctx;
  const userMsgs = m.msgs().filter(x => x.type === 'USER');
  assert(m.calls.propose.length === 2 && ctx1.conversation.decisions.some(x => x.key === 'approval.threshold' && x.answer === '100円未満は部長不要、100万円以上は必要') && /100円未満は部長不要/.test(ctx1.question) && ctx1.conversation.proposal.behaviors.length === 2 && ctx1.conversation.proposal.decisions.length === 0, 'B2-10: 回答欄の回答は決定事項（key 付き）に記録してから、「回答: …」を含む発言として仮案の AI へ（回答済みの判断は前回の仮案から外す）');
  assert(userMsgs.slice(-1)[0].data?.displayText === '判断が必要な点への回答です。' && /判断が必要な点への回答です。/.test(m.chat()) && !/100円以上100万円未満の申請に部長承認は必要ですか[\s\S]*100円以上100万円未満の申請に部長承認は必要ですか[\s\S]*100円以上100万円未満/.test(outsideDetails(m.chat())), 'B2-11: 吹き出しは「判断が必要な点への回答です。」だけ');
  assert(m.conv().draft().rev === 2 && /仮案を直しました。/.test(m.chat()) && (m.chat().match(/kt-ai-draft-card is-old/g) || []).length === 1 && /前の仮案 — このあと直した案があります/.test(m.chat()) && !/決めたこと：/.test(m.chat()) && /<b>決めたこと<\/b>/.test(m.$('kt-ai-change-summary').innerHTML), 'B2-12: 仮案のカードは置き換え（前の仮案は 1 行に畳む）。決めたことは右の「変更内容」に示す（2026-10-14）');
  // ［採用］: 先に必要な判断（中間の金額）が残る → AI に聞き直させる（台本が無いので失敗の表示。採用にはならない）
  // → 残りの判断に答えてから採用
  await m.panel.send('7営業日で。会社独自の休業日は今回はなし'); await ticks(8);
  await m.panel.send('おすすめで。この案で進めて'); await ticks(12);
  const dAfter = m.conv().draft();
  assert(dAfter.status === 'adopted' && m.calls.plan.length === 1 && m.calls.propose.length === 3 && m.conv().activePlan() && m.conv().activePlan().fromDraft && m.conv().activePlan().fromDraft.id === dAfter.id, `B2-13:「おすすめで」で残る判断が無ければ採用 → 従来の計画の作成へ（版に fromDraft）: ${dAfter.status} / plan ${m.calls.plan.length}`);
  assert(/採用した方針:/.test(m.calls.plan[0].ctx.goal) && m.conv().requirements().some(r => /課長と部長の承認者/.test(r.behavior)) && m.conv().requirements().length >= 4, 'B2-14: 要件の台帳は仮案の id から計画の planId へ引き継ぐ。goal に採用した方針');
  const chat2 = m.chat();
    // 段階 C: 採用 → 計画 → 最終案のカード（変更案のカード・確認事項・仕様の案内は出さない）
  assert(/仮案 — 採用済み/.test(chat2) && !/最終案を作っています|最終案を作りました/.test(chat2) && /kt-ai-final-card/.test(chat2) && !/kt-ai-plan-card/.test(chat2) && !/data-act="draft-adopt"/.test(chat2) && !/この案で進めます/.test(chat2) && dAfter.planId === m.conv().activePlan().planId, 'B2-15: 採用した仮案は 1 行に畳み（「仮案 — 採用済み」。2026-10-15 §4(a)）、最終案のカードが出る（変更案のカードは出ない・仮案のボタンは消える・採用直後の別の文「この案で進めます」は出さない: 2026-10-14）');
  //   採用した仮案からの計画の Context: 要件の台帳は渡る。合成した依頼文は台帳の利用者の原文に入らない（未解決の要件も出ない）
  const lgP = m.conv().state.ledgers.get(m.conv().activePlan().planId);
  assert(Array.isArray(m.calls.plan[0].ctx.requirements) && m.calls.plan[0].ctx.requirements.length >= 4 && !(lgP.userTexts || []).some(s => /採用した方針/.test(s)) && !m.msgs().some(x => x.data?.kind === 'requirements-unresolved'), `B2-14b: 要件は Context に渡り、合成文は台帳に入らない: ${JSON.stringify(lgP.userTexts)}`);
  assert(/<h3>/.test(m.$('kt-ai-change-summary').innerHTML) && !/仮案（採用前）/.test(m.$('kt-ai-change-summary').innerHTML) && /data-status="ready">未反映</.test(m.$('kt-ai-ws-state').innerHTML), 'B2-16: 右は従来の変更内容の要約に戻る・状態は未反映');
  const tA = m.panel.metrics().timings.slice(-1)[0];
  assert(tA.intent === 'ADOPT_DRAFT' && tA.calls.map(c => c.kind).join(',') === 'plan' && tA.doneMs >= 30000, `B2-17: 採用の計測（calls に plan・doneMs）: ${JSON.stringify({ intent: tA.intent, calls: tA.calls.map(c => c.kind), doneMs: tA.doneMs })}`);
  // 計画ができた後は従来どおり（仮案の経路に入らない）
  const r = await m.panel.send('一覧の名前は承認待ちにして'); await ticks(8);
  assert(r && r.intent === 'REVISE_PLAN' && m.calls.propose.length === 3, 'B2-18: 計画がある（最終案の後）は従来の修正の経路');
});
// ［採用］［不採用］のボタンの文・新しい会話で仮案が消える
await section(async () => {
  const m = mount();
  await ticks();
  await m.panel.send('課長・部長の承認者を選ぶ運用にしたい'); await ticks(8);
  await clickChat(m, 'draft-adopt', { draft: m.conv().draft().id }); await ticks(8);
  const u = m.msgs().filter(x => x.type === 'USER').slice(-1)[0];
  assert(u.text === '採用します' && m.conv().draft().status === 'open' && m.calls.plan.length === 0, 'B2-19:［採用］は「採用します」を送る。先に必要な判断が残る間は採用にならない（AI に聞き直させる）');
  await clickChat(m, 'draft-reject', { draft: m.conv().draft().id }); await ticks(8);
  const u2 = m.msgs().filter(x => x.type === 'USER').slice(-1)[0];
  assert(u2.text === 'この案は採用しません' && m.conv().draft().status === 'open', 'B2-20:［不採用］は「この案は採用しません」を送る（AI が別の方向を聞き返す経路）');
  await clickChat(m, 'new-conv'); await ticks();
  assert(m.conv().draft() === null && m.conv().draftDecisions().length === 0 && m.$('kt-ai-change-summary').innerHTML === '' && /未作成/.test(m.$('kt-ai-ws-state').innerHTML), 'B2-21:［新しい会話］で仮案・決定事項・右の詳細は消える');
});
// C-1 第 3 段（2026-10-08）: 能力が無い health の画面も「接続先が非対応」で止める（従来の計画の流れ・変更案のカードは無い）
await section(async () => {
  const h = clone(HEALTH); h.registry.toolkit['assistant-qa'].conversation = ['requirements', 'brief', 'stream'];
  const m = mount({ health: h });
  await ticks();
  await m.panel.send('課長・部長の承認者を選ぶ運用にしたい'); await ticks(10);
  assert(m.calls.propose.length === 0 && m.calls.plan.length === 0 && m.conv().draft() === null && /接続先が非対応です/.test(m.chat()) && !/kt-ai-plan-card/.test(m.chat()) && !/kt-ai-draft-card/.test(m.chat()), 'B5-3: health に proposal が無い画面は「接続先が非対応」（計画の AI を呼ばない・仮案のカードも変更案のカードも出ない）');
});

// =========================================================
console.log('\n--- §B3. 独立レビューの指摘（2026-10-07）: 採用 → 計画の失敗 / 構造化した引き継ぎ / 不採用の取り消し / 再確認 / 新しい依頼 / 分類 / 応答待ち ---');
// 1. 採用 → 計画の作成の失敗で行き止まりにならない（open に戻る・履歴・［再試行］は「採用します」で仮案から作り直す・古い決定事項は新しい仮案に引き継がない）
await section(async () => {
  const x = makeConv({ planImpl: planFail });
  const { c, calls } = x;
  await c.send('課長・部長の承認者を選ぶ運用にしたい');
  await c.send('100円未満は部長不要、100万円以上は必要');
  await c.send('7営業日で。会社独自の休業日は今回はなし');
  const r = await c.send('おすすめで。この案で進めて');
  const d = c.draft();
  const err = c.messages().filter(m => m.type === 'ERROR').slice(-1)[0];
  assert(r.intent === 'ADOPT_DRAFT' && r.ok === false && d.status === 'open' && d.planning === false && d.planFailed && d.planFailed.attempt === 1 && d.history.slice(-1)[0].kind === 'plan-failed' && !c.activePlan(), `B3-1: 計画を作れなかったら仮案は open に戻り、履歴に失敗を残す: ${d.status} / ${JSON.stringify(d.planFailed)}`);
  assert(err && err.data.retryText === '採用します' && err.data.intent === 'ADOPT_DRAFT' && /計画を作れませんでした（テスト）/.test(err.text), `B3-2: 失敗のカードの［再試行］は「採用します」（ADOPT_DRAFT）: ${JSON.stringify(err && err.data)}`);
  const view = { draft: d, draftDecisions: c.draftDecisions(), draftAnswers: new Map() };
  const cardHtml = KTAiChatUi.messageHtml(c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], view);
  assert(/仮案 — 採用（変更案の作成に失敗。再試行できます）/.test(cardHtml) && /data-act="draft-adopt"/.test(cardHtml) && !/kt-ai-old-card/.test(cardHtml), 'B3-3: 失敗した後の仮案のカードは開いたまま（もう一度採用できる）で、失敗したことを見出しに出す');
  const sumHtml = KTAiChatUi.draftSummaryHtml(d, { decisions: c.draftDecisions(), working: null });
  assert(/採用（変更案の作成に失敗。再試行できます）/.test(sumHtml) && !/最終案を作っています/.test(sumHtml) && /採用 → 変更案の作成に失敗/.test(sumHtml), 'B3-4: 右の詳細は失敗の文（「最終案を作っています」は出さない）。判断の経緯に失敗を残す');
  // ［再試行］（UI の handleAct 'retry' と同じ経路）: 仮案から作り直す（利用者の発言「おすすめで」を依頼文にしない）
  const rr = await c.send(err.data.retryText, { intentOverride: err.data.intent });
  assert(rr.intent === 'ADOPT_DRAFT' && calls.plan.length === 2 && calls.plan[1].goal === calls.plan[0].goal && calls.plan[1].goal.startsWith('課長・部長の承認者を選ぶ運用にしたい') && calls.plan[1].decisions.length === 4 && c.draft().planFailed.attempt === 2, `B3-5: ［再試行］は仮案（draftGoal ＋ 決定事項・要件）から作り直す: ${calls.plan[1].goal.slice(0, 60)}`);
  // もう一度「採用します」と言っても同じ（質問の AI に流れない）
  const ra = await c.send('採用します');
  assert(ra.intent === 'ADOPT_DRAFT' && ra.reason === 'ADOPT_WORDS' && calls.plan.length === 3 && calls.ask.length === 0, `B3-6: 失敗の後の「採用します」は採用（質問の AI に流れない）: ${ra.intent}/${ra.reason}`);
  // 計画の AI が直ったら: 採用 → adopted（計画が登録できた後）・畳んだカードの文・台帳に合成文が入らない・未解決の要件が出ない
  x.planImpl = planOk;
  const ok = await c.send('採用します');
  const d2 = c.draft(), v = c.activePlan();
  assert(ok.ok && d2.status === 'adopted' && d2.planId === v.planId && !d2.planFailed && v.fromDraft && v.fromDraft.id === d2.id && c.messages().some(m => m.type === 'FINAL') && !c.messages().some(m => m.type === 'PLAN'), `B3-7: 計画ができたら仮案は adopted（計画の登録の後）。段階 C: 会話には最終案のカード（変更案のカードは出さない）: ${d2.status}`);
  const lgP = c.state.ledgers.get(v.planId);
  assert(!(lgP.userTexts || []).some(s => /採用した方針|決定事項:/.test(s)) && !c.messages().some(m => m.data?.kind === 'requirements-unresolved') && c.requirements().every(r => r.decision !== 'undecided') && calls.plan[3].requirements.some(r => /課長と部長の承認者/.test(r.behavior)), `B3-8: 合成した依頼文は台帳の利用者の原文に入らず、未解決の要件も作らない: ${JSON.stringify(lgP.userTexts)}`);
  const cardDone = KTAiChatUi.messageHtml(c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], { draft: d2, draftDecisions: c.draftDecisions() });
  assert(/仮案 — 採用済み/.test(cardDone) && !/最終案を作りました/.test(cardDone) && /kt-ai-old-card/.test(cardDone), 'B3-9: 最終案ができた後の仮案のカードは「仮案 — 採用済み」に畳む（「最終案を作りました」は出さない。2026-10-15 §4(a)）');
  const t = c.metrics().timings.slice(-1)[0];
  assert(t.intent === 'ADOPT_DRAFT' && t.calls.map(k => k.kind).join(',') === 'plan', 'B3-10: 計測は従来どおり（calls に plan）');
});
// 1b. 計画の AI の例外（タイムアウト）でも同じ（open に戻る・再試行は ADOPT_DRAFT）。AI の intent adopt の経路（DRAFT_REPLY）でも
await section(async () => {
  const x = makeConv({ planImpl: planThrow });
  const { c, calls } = x;
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし', '現在の承認者へ。課長承認中で100万円以上なら部長にも通知', '申請中は編集不可にして。CSV・APIは使わない', '全員で', 'おすすめで']) await c.send(s);
  const r7 = await c.send('通知は不要、期限は5営業日、ほかは採用');
  const d = c.draft();
  const err = c.messages().filter(m => m.type === 'ERROR').slice(-1)[0];
  assert(r7.intent === 'DRAFT_REPLY' && r7.ok === false && r7.error && r7.error.code === 'TIMEOUT' && d.status === 'open' && d.planFailed && calls.plan.length === 1, `B3-11: AI の intent adopt → 計画の例外でも仮案は open に戻る: ${d.status} / ${JSON.stringify(r7.error)}`);
  assert(err.data.retryText === '採用します' && err.data.intent === 'ADOPT_DRAFT' && err.data.retryable === true, `B3-12: 例外の失敗カードの［再試行］も「採用します」（ADOPT_DRAFT）: ${JSON.stringify(err.data)}`);
  const rr = await c.send(err.data.retryText, { intentOverride: err.data.intent });
  assert(rr.intent === 'ADOPT_DRAFT' && calls.plan.length === 2 && calls.plan[1].goal === calls.plan[0].goal && calls.plan[1].requirements.some(r => r.decision === 'revoked') && calls.plan[1].decisions.length === 5, `B3-13: ［再試行］は仮案から作り直す（取り消し済みの要件も渡す）: ${JSON.stringify(calls.plan[1].requirements.map(r => [r.id, r.decision]))}`);
});
// 1c. AI の intent adopt の経路でも、計画を作っている間は working PLAN（右の見出し「最終案を作成中」。右の詳細の「最終案を作っています」はその間だけ）
await section(async () => {
  const g = gateMk();
  const x = makeConv({ planImpl: async () => { await g.p; return planFail(); } });
  const { c } = x;
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし', '現在の承認者へ。課長承認中で100万円以上なら部長にも通知', '申請中は編集不可にして。CSV・APIは使わない', '全員で', 'おすすめで']) await c.send(s);
  const p = c.send('通知は不要、期限は5営業日、ほかは採用');
  await ticks(8);
  const d = c.draft();
  const ws = VM.workStatus({ version: null, working: c.state.working, draft: d });
  const cardMid = KTAiChatUi.messageHtml(c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], { draft: d, draftDecisions: c.draftDecisions() });
  assert(c.isBusy() && c.state.working === 'PLAN' && d.planning === true && d.status === 'open' && ws.key === 'finalizing' && ws.label === '最終案を作成中', `B3-14: AI の intent adopt で計画を作っている間は working PLAN・右の見出し「最終案を作成中」: ${c.state.working} / ${JSON.stringify(ws)}`);
  assert(/仮案 — 採用済み（最終案を作っています）/.test(cardMid) && !/data-act="draft-adopt"/.test(cardMid) && /最終案を作っています/.test(KTAiChatUi.draftSummaryHtml(d, { decisions: c.draftDecisions(), working: 'PLAN' })) && !/最終案を作っています/.test(KTAiChatUi.draftSummaryHtml(d, { decisions: c.draftDecisions(), working: null })), 'B3-15: 作っている間はカードを畳み、右の詳細の「最終案を作っています」は working PLAN のときだけ');
  const rq = await c.send('一覧の名前は承認待ちにして');
  assert(rq && rq.queued === true && rq.reason === 'QUEUED_DURING_PLAN', 'B3-16: 作っている間の指示は従来どおり積む');
  //   2026-10-15（レビューの反映 T2）: 作っている間の進行の語句だけの発言（「採用します」）は変更前と同じ経路（いま進めている文と違うので修正として積む。同意として扱わない）。
  //   委ねる言い方と進行の語句が同じ発言に並ぶ「おすすめで。この案で進めて」は同意（修正として積まない）
  const nAgree = c.messages().filter(m => m.data?.kind === 'agree-while-plan').length;
  const rq2 = await c.send('採用します');
  assert(rq2 && rq2.queued === true && rq2.reason === 'QUEUED_DURING_PLAN' && c.messages().filter(m => m.data?.kind === 'agree-while-plan').length === nAgree, `B3-16b: 作っている間の「採用します」は変更前と同じ経路（修正として積む。同意の案内は出さない）: ${JSON.stringify({ queued: rq2 && rq2.queued, reason: rq2 && rq2.reason })}`);
  const rq3 = await c.send('おすすめで。この案で進めて');
  assert(rq3 && rq3.queued === false && rq3.reason === 'AGREED_WHILE_PLAN' && c.messages().filter(m => m.data?.kind === 'agree-while-plan').length === nAgree + 1, `B3-16c: 作っている間の「おすすめで。この案で進めて」（委ねる言い方 ＋ 進行の語句）は同意（修正として積まない）: ${JSON.stringify({ queued: rq3 && rq3.queued, reason: rq3 && rq3.reason })}`);
  g.open(); await p; await ticks(4);
  assert(c.state.working === null && c.draft().status === 'open' && c.draft().planFailed && VM.workStatus({ version: null, working: null, draft: c.draft() }).key === 'draft', 'B3-17: 失敗の後は working null・見出しは「仮案」に戻る');
});
// 2. 計画ができたときの引き継ぎ: 合成文を台帳に入れない（S5 の再現）・requirements と decisions が渡る
await section(async () => {
  const x = makeConv({ planImpl: planOk });
  const { c, calls } = x;
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし', '現在の承認者へ。課長承認中で100万円以上なら部長にも通知', '申請中は編集不可にして。CSV・APIは使わない', '全員で', 'おすすめで']) await c.send(s);
  const before = c.requirements().map(r => r.id);
  const r7 = await c.send('通知は不要、期限は5営業日、ほかは採用');
  const v = c.activePlan(), d = c.draft();
  const p0 = calls.plan[0];
  assert(r7.ok && v && d.status === 'adopted' && d.adoptedBy === 'AI_ADOPT' && d.planId === v.planId, `B3-18: 1 文で不採用・変更・採用 → 計画 → adopted: ${d.status}/${d.adoptedBy}`);
  assert(p0.goal.split('\n').length === 2 && p0.goal.startsWith('課長・部長の承認者を選ぶ運用にしたい') && /^採用した方針: /.test(p0.goal.split('\n')[1]) && !/通知/.test(p0.goal.split('\n')[1]) && !/決定事項|前提|不採用/.test(p0.goal), `B3-19: goal は依頼文 ＋ 採用した方針 1 行（不採用の通知は入らない）: ${p0.goal}`);
  assert(p0.decisions.length === 5 && p0.decisions.find(x => x.key === 'deadline.days').answer === '承認の期限は申請から 5 営業日（土日祝のみ除く）' && p0.decisions.find(x => x.key === 'lock.scope').answer === '全員' && p0.requirements.filter(r => r.decision === 'revoked').length === 2 && p0.requirements.some(r => r.decision !== 'revoked' && /5 営業日/.test(r.behavior)), `B3-20: 決定事項（5 件・最新の答え）と要件（取り消し 2 件を含む）を渡す: ${JSON.stringify(p0.decisions.map(x => [x.key, x.answer]))}`);
  const lgP = c.state.ledgers.get(v.planId);
  assert(c.requirements().map(r => r.id).join() === before.join() && !c.requirements().some(r => r.decision === 'undecided') && !(lgP.userTexts || []).some(s => /採用した方針/.test(s)) && !c.messages().some(m => m.data?.kind === 'requirements-unresolved'), `B3-21: 計画のターンで要件が増えない（合成文を未解決の要件にしない）・台帳の原文に合成文が無い: ${JSON.stringify(lgP.userTexts)}`);
});
// 4. 不採用の要件の取り消しは仮案の項目 id → 要件 id の対応で（id で引けないときだけ内容の文字の重なりで補う。短い動作の包含では取り消さない）
await section(async () => {
  const scriptRj = ({ utterance: u, previous: p }) => {
    const prevB = (p && p.behaviors) || [];
    if (/承認者を選ぶ/.test(u)) return { reply: '仮案です。', intent: 'propose', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user'), B('承認依頼のとき部長に通知する'), B('期限超過のとき申請者へ催促する')], assumptions: [], decisions: [], approach: { standard: ['プロセス管理'], js: [] }, cannot: [] },
      turn: { ops: [], answers: [], requirementOps: [
        req('add', { target: '承認', condition: '申請時', behavior: '承認者を選ぶ', sourceQuotes: ['承認者を選ぶ'], planRefs: ['B1'] }),
        req('add', { target: '通知', condition: '承認依頼のとき', behavior: '通知する', decision: 'proposed', planRefs: ['B2'] }),
        req('add', { target: '催促', condition: '期限超過のとき', behavior: '申請者へ催促する', decision: 'proposed' }),
        req('add', { target: '催促', condition: '', behavior: '催促する', decision: 'proposed' }),
      ] } };
    if (/文言を変えて/.test(u)) return { reply: '文言を変えました。', intent: 'update', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user'), B('承認依頼のとき部長に通知する'), B('期限超過のとき申請者へ催促する')], assumptions: [A('notify.text', '通知の文言', '通知の文言は「承認をお願いします」', '変えられます')], decisions: [], approach: { standard: ['プロセス管理'], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } };
    if (/通知も催促も不要/.test(u)) return { reply: '通知と催促を外して採用します。', intent: 'adopt', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [], decisions: [], approach: { standard: ['プロセス管理'], js: [] }, cannot: [] },
      turn: { ops: [...prevB.filter(b => /通知|催促/.test(b.text)).map(b => ({ id: b.id, op: 'reject', text: '', quote: '通知も催促も不要' })), ...prevB.filter(b => !/通知|催促/.test(b.text)).map(b => ({ id: b.id, op: 'adopt', text: '', quote: 'ほかは採用' }))], answers: [], requirementOps: [] } };
    return null;
  };
  const x = makeConv({ scriptFn: scriptRj });
  const { c } = x;
  await c.send('課長・部長の承認者を選ぶ運用にしたい');
  const lg = x.ledger(c.draft().id);
  assert(JSON.stringify(lg.itemReqs) === JSON.stringify({ B1: ['R1'], B2: ['R2'] }), `B3-22: 要件の add の planRefs から「仮案の項目 id → 要件 id」の対応を台帳に持つ: ${JSON.stringify(lg.itemReqs)}`);
  await c.send('通知の文言を変えて');   // 項目の id は振り直されるが、同じ文の項目に対応を引き継ぐ
  assert(c.draft().rev === 2 && JSON.stringify(lg.itemReqs) === JSON.stringify({ B1: ['R1'], B2: ['R2'] }), `B3-23: 仮案を直しても（id の振り直し）同じ文の項目に対応を引き継ぐ: ${JSON.stringify(lg.itemReqs)}`);
  const r = await c.send('通知も催促も不要、ほかは採用');
  const reqs = c.requirements();
  const byId = (id) => reqs.find(e => e.id === id);
  assert(r.ok && byId('R1').decision === 'decided' && byId('R2').decision === 'revoked' && byId('R3').decision === 'revoked' && byId('R4').decision !== 'revoked', `B3-24: 不採用 → id の対応で R2 を取り消し、対応の無い R3 は内容の文字の重なり（7 割）で取り消し、短い動作だけの R4（「催促する」）は取り消さない: ${JSON.stringify(reqs.map(e => [e.id, e.decision]))}`);
  const raw = KTAiAnswers.requirementsOf(lg);
  assert(raw.find(e => e.id === 'R2').revokedBy.by === 'id' && raw.find(e => e.id === 'R3').revokedBy.by === 'overlap', `B3-25: 取り消しの根拠（id / overlap）を要件に残す: ${JSON.stringify(raw.map(e => [e.id, e.revokedBy && e.revokedBy.by]))}`);
});
// 6. 回答済みの key の判断を AI がもう一度出したら「再確認」（前の答えを添える。答えると同じ key を置き換える）。同じターンで答えたばかりの key は出さない
await section(async () => {
  const QD = Q('deadline.days', '承認の期限', '承認の期限は申請から何営業日にしますか', ['5営業日', '7営業日'], '5営業日', '期限超過の判定日が変わります', false);
  const scriptRc = ({ utterance: u, previous: p }) => {
    const prevD = (p && p.decisions) || [];
    if (/承認者を選ぶ/.test(u)) return { reply: '仮案です。', intent: 'propose', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [], decisions: [QD], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } };
    // 回答 → 決定事項に。AI が同じターンに同じ key の判断をまだ出している（読み落とし）→ 出さない
    if (/^7営業日/.test(u)) return { reply: '7 営業日で進めます。', intent: 'update', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [], decisions: [QD], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [{ id: idBy(prevD, d => d.key === 'deadline.days'), kind: 'value', text: '7営業日', quote: '7営業日' }], requirementOps: [] } };
    // 後のターンで AI が理由をつけて同じ key を出した → 再確認
    if (/起算日/.test(u)) return { reply: '起算日を翌営業日にすると期限が 1 日延びます。日数を確認させてください。', intent: 'update', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [A('deadline.base', '起算日', '期限は申請日の翌営業日から数える', '')], decisions: [{ ...QD, question: '起算日を翌営業日にしても、期限は 7 営業日のままでよいですか' }], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } };
    if (/^5営業日/.test(u)) return { reply: '5 営業日にします。', intent: 'update', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [A('deadline.base', '起算日', '期限は申請日の翌営業日から数える', ''), A('deadline.days', '期限', '期限は 5 営業日', '')], decisions: [], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [{ id: idBy(prevD, d => d.key === 'deadline.days'), kind: 'value', text: '5営業日', quote: '5営業日' }], requirementOps: [] } };
    return null;
  };
  const x = makeConv({ scriptFn: scriptRc });
  const { c, calls } = x;
  await c.send('課長・部長の承認者を選ぶ運用にしたい');
  await c.send('7営業日で');
  assert(c.draftDecisions().find(d => d.key === 'deadline.days').answer === '7営業日' && c.draft().items.decisions.length === 0 && c.draft().history.slice(-1)[0].hiddenDecisions.join() === 'deadline.days', 'B3-26: 同じターンで答えたばかりの key を AI がまだ出していたら出さない（hidden）');
  await c.send('起算日は翌営業日にして');
  const d = c.draft();
  const rc = d.items.decisions[0];
  const open = KTAiConversation.openDraftDecisions(d, c.draftDecisions());
  assert(d.items.decisions.length === 1 && rc.reconfirm === true && rc.previousAnswer === '7営業日' && open.length === 1 && open[0].key === 'deadline.days' && c.draftDecisions().length === 1, `B3-27: 後のターンで回答済みの key をもう一度出したら「再確認」として残す（決定事項は置き換えない）: ${JSON.stringify(rc)}`);
  const cardHtml = KTAiChatUi.messageHtml(c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], { draft: d, draftDecisions: c.draftDecisions(), draftAnswers: new Map() });
  //   2026-10-14 の設計し直し: 回答欄と「再確認」は右の仮案の詳細（会話のカードは返答と選択だけ）
  const sumHtml28 = KTAiChatUi.draftSummaryHtml(d, { decisions: c.draftDecisions() });
  assert(!/再確認/.test(cardHtml) && !/data-dkey="/.test(cardHtml) && /再確認：前の答えは「7営業日」です/.test(sumHtml28) && /data-dkey="/.test(sumHtml28) && /data-act="draft-answer"/.test(sumHtml28), 'B3-28: 右の詳細に「再確認」と前の答えと回答欄を出す（hidden で隠さない。会話のカードには出さない）');
  await c.send('5営業日にします');
  const prevSent = calls.propose[3].previous;
  const dd = c.draftDecisions().find(x => x.key === 'deadline.days');
  assert(prevSent.decisions.length === 1 && prevSent.decisions[0].key === 'deadline.days' && dd.answer === '5営業日' && dd.history.length === 1 && dd.history[0].answer === '7営業日' && KTAiConversation.openDraftDecisions(c.draft(), c.draftDecisions()).length === 0 && c.draftDecisions().length === 1, `B3-29: 再確認の判断は previous に残して AI へ渡し、答えたら同じ key を置き換える（前の答えは履歴に）: ${JSON.stringify(dd)}`);
});
// 7. 前回の仮案があるのに intent が propose なら新しい仮案（前の仮案は superseded。決定事項は引き継がない。前のカードは「前の仮案（別の依頼）」）
await section(async () => {
  const scriptNew = ({ utterance: u, previous: p }) => {
    const prevD = (p && p.decisions) || [];
    if (/承認者を選ぶ/.test(u)) return { reply: '仮案です。', intent: 'propose', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [], decisions: [Q_DAYS], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [req('add', { target: '承認', condition: '申請時', behavior: '承認者を選ぶ', sourceQuotes: ['承認者を選ぶ'], planRefs: ['B1'] })] } };
    if (/^7営業日/.test(u)) return { reply: '7 営業日で進めます。', intent: 'update', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [A('deadline.days', '期限', '期限は 7 営業日', '')], decisions: [], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [{ id: idBy(prevD, d => d.key === 'deadline.days'), kind: 'value', text: '7営業日', quote: '7営業日' }], requirementOps: [] } };
    if (/一覧も/.test(u)) return { reply: '一覧の仮案です。', intent: 'propose', proposal: { behaviors: [B('承認待ち一覧を追加する', 'user')], assumptions: [], decisions: [Q_DAYS], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [req('add', { target: '一覧', condition: '', behavior: '承認待ち一覧を追加する', sourceQuotes: ['一覧も作りたい'], planRefs: ['B1'] })] } };
    return null;
  };
  const x = makeConv({ scriptFn: scriptNew });
  const { c, calls } = x;
  await c.send('課長・部長の承認者を選ぶ運用にしたい');
  await c.send('7営業日で');
  const old = c.draft();
  const oldCard = c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0];
  const r = await c.send('承認待ちの一覧も作りたい');
  const d = c.draft();
  assert(r.intent === 'DRAFT_REPLY' && r.draft.intent === 'propose' && d.id !== old.id && d.rev === 1 && d.request === '承認待ちの一覧も作りたい' && old.status === 'superseded' && old.supersededBy && c.draftDecisions().length === 0 && d.items.decisions.length === 1, `B3-30: intent propose なら新しい仮案（新しい id・request は今回の発言）。前の仮案は superseded・決定事項は引き継がない: ${d.id !== old.id} / ${old.status} / ${c.draftDecisions().length}`);
  assert(c.requirements().length === 1 && /一覧/.test(c.requirements()[0].behavior) && calls.propose[2].previous && calls.propose[2].previous.behaviors.length === 1, 'B3-31: 要件の台帳も新しい仮案のもの（前の仮案は AI に previous として渡した上で、AI が別の依頼と読んだ）');
  const html = KTAiChatUi.messageHtml(oldCard, { draft: d, draftDecisions: c.draftDecisions() });
  assert(/前の仮案（別の依頼）/.test(html) && /kt-ai-old-card/.test(html) && !/data-act="draft-adopt"/.test(html), 'B3-32: 前の仮案のカードは「前の仮案（別の依頼）」に畳む');
  // 新しい仮案の判断（期限）は、前の仮案での答え（7 営業日）が引き継がれないので未回答
  assert(KTAiConversation.openDraftDecisions(d, c.draftDecisions()).length === 1 && calls.propose[2].decisions.length === 1, 'B3-33: 新しい仮案の AI の呼び出しには前の決定事項を渡すが（AI が同じ依頼の続きと読む余地）、新しい仮案になったら持ち越さない');
});
// 8. 分類: 仮案が open のときの採用語と相づち・NO_PLAN の案内文
await section(async () => {
  const c = KTAiConversation.classifyDraft;
  const noOpen = { activePlan: null, draftDecisions: [], draft: { id: 'd1', status: 'open', items: { behaviors: [], assumptions: [], decisions: [], approach: { standard: [], js: [] }, cannot: [] } } };
  const withOpen = { ...noOpen, draft: { ...noOpen.draft, items: { ...noOpen.draft.items, decisions: [{ id: 'Q1', key: 'k', question: 'q', recommendation: '', blocking: true }] } } };
  const adoptWords = ['承認します', '確定', 'それで', 'お願いします', 'よろしくお願いします', '採用します', 'それでお願いします', 'これで確定で'];
  assert(adoptWords.every(s => c(s, noOpen)?.intent === 'ADOPT_DRAFT' && c(s, noOpen)?.reason === 'ADOPT_WORDS') && adoptWords.every(s => c(s, withOpen)?.reason === 'ADOPT_WITH_OPEN'), `B3-34: 採用語（承認します・確定・それで・お願いします・よろしくお願いします）は採用（先に必要な判断が残れば AI に聞き直させる）: ${adoptWords.map(s => `${s}:${c(s, noOpen)?.intent}/${c(s, noOpen)?.reason}`).join(' ')}`);
  assert(['はい', 'OK', 'ok', 'うん', '了解'].every(s => c(s, noOpen)?.reason === 'DRAFT_SMALLTALK' && c(s, noOpen)?.ack === true) && c('ありがとう', noOpen)?.reason === 'DRAFT_SMALLTALK' && !c('ありがとう', noOpen)?.ack, 'B3-35:「はい」「OK」単独は相づち（採用ではない。採用の言い方を案内する）');
  assert(c('通知は不要でお願いします', noOpen)?.intent === 'DRAFT_REPLY' && c('承認してください', noOpen)?.intent === 'ADOPT_DRAFT' && c('反映して', noOpen) === null && c('お願いします', { activePlan: null, draft: null, draftDecisions: [] }) === null, 'B3-36: 修正の語があれば AI へ・反映の命令は従来・仮案が無ければ「お願いします」は従来の相づち');
  const x = makeConv({ withPlan: true });
  await x.c.send('課長・部長の承認者を選ぶ運用にしたい');
  const n = x.calls.propose.length;
  const r1 = await x.c.send('はい');
  assert(r1.intent === 'DRAFT_REPLY' && r1.reason === 'ACK_WITH_OPEN' && x.calls.propose.length === n + 1 && x.calls.plan.length === 0, `B3-37（2026-10-15 §3.2）: 開いている判断があれば「はい」はその判断への答えとして AI に読ませる（台本が無いのでここでは失敗）: ${r1.intent}/${r1.reason}`);
  await x.c.send('100円未満は部長不要、100万円以上は必要'); await x.c.send('7営業日で。会社独自の休業日は今回はなし'); await x.c.send('おすすめで');
  const n2 = x.calls.propose.length;
  const r1b = await x.c.send('はい');
  assert(r1b.reason === 'DRAFT_SMALLTALK' && x.calls.propose.length === n2 && x.calls.plan.length === 0 && /採用するときは「採用します」/.test(x.last().text), `B3-37b: 開いている判断が無ければ「はい」は AI を呼ばず採用の言い方を案内: ${x.last().text}`);
  const r2 = await x.c.send('反映して');
  assert(r2.intent === 'GENERAL' && r2.reason === 'NO_PLAN' && /仮案への返事（採用・変えたい点・質問）/.test(x.last().text) && x.calls.plan.length === 0, `B3-38: 仮案 open のときの NO_PLAN の案内は仮案への返事を促す: ${x.last().text}`);
});
// 10. 仮案の AI の応答待ちの間: 質問は並べて答え、それ以外は入力欄に残す（null）。見出しは「仮案を作成中」
await section(async () => {
  const g = gateMk();
  const x = makeConv({ proposeGate: g });
  const { c, calls } = x;
  const p = c.send('課長・部長の承認者を選ぶ運用にしたい');
  await ticks(4);
  const ws = VM.workStatus({ version: null, working: c.state.working, draft: c.draft() });
  assert(c.isBusy() && c.canQueue() && c.state.working === 'PROPOSE' && c.state.workInbox && c.state.workInbox.kind === 'PROPOSE' && ws.key === 'drafting' && ws.label === '仮案を作成中', `B3-39: 応答待ちの間は working PROPOSE・見出し「仮案を作成中」: ${JSON.stringify(ws)}`);
  const rq = await c.send('CSVにも効きますか？');
  const rr = await c.send('通知は不要');
  const rg = await c.send('ありがとう');
  assert(rq && rq.asked === true && rq.reason === 'ASKED_WHILE_BUSY' && calls.ask.length === 1 && rr === null && rg === null, `B3-40: 質問は並べて答え（質問の AI へ）、返事・相づちは入力欄に残す（null）: ${JSON.stringify(rq)} / ${rr} / ${rg}`);
  assert(calls.ask[0].conversation.working === null && calls.ask[0].conversation.plan === null, 'B3-41: 質問の AI に渡す working は Gateway の語彙（null）。仮案はまだ無い');
  assert(/仮案を作っています。質問にはすぐ答えます/.test(KTAiChatUi.busyHintText('PROPOSE')) && /この文は仮案ができてから/.test(KTAiChatUi.busyHintText('PROPOSE', { accepted: false })), 'B3-42: 入力欄の案内（応答待ち）');
  g.open(); await p; await ticks(4);
  assert(c.draft() && c.draft().rev === 1 && c.state.workInbox === null && c.state.working === null && c.messages().filter(m => m.type === 'DRAFT').length === 1 && c.messages().some(m => m.data?.kind === 'aside-answer'), 'B3-43: 応答の後は仮案 1 枚・質問の答えのカード・作業の受け口は空');
});

// =========================================================
console.log('\n--- §B4. 画面: 採用 → 計画の失敗 → 再試行 / 回答欄のフォーカス ---');
await section(async () => {
  const pg = gateMk();
  const m = mount({ planImpl: async () => { await pg.p; throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); } });
  await ticks();
  await m.panel.send('課長・部長の承認者を選ぶ運用にしたい'); await ticks(8);
  await m.panel.send('100円未満は部長不要、100万円以上は必要'); await ticks(8);
  await m.panel.send('7営業日で。会社独自の休業日は今回はなし'); await ticks(8);
  const p = m.panel.send('おすすめで。この案で進めて'); await ticks(10);
  assert(/data-status="finalizing">最終案を作成中</.test(m.$('kt-ai-ws-state').innerHTML) && /最終案を作っています/.test(m.$('kt-ai-change-summary').innerHTML) && /仮案 — 採用済み（最終案を作っています）/.test(m.chat()) && !/data-act="draft-adopt"/.test(m.chat()), `B4-1: 計画を作っている間: 右の見出し「最終案を作成中」・右の詳細「最終案を作っています」・カードは畳む: ${m.$('kt-ai-ws-state').innerHTML}`);
  pg.open(); await p; await ticks(8);
  const err = m.msgs().filter(x => x.type === 'ERROR').slice(-1)[0];
  assert(m.conv().draft().status === 'open' && /data-status="draft">仮案</.test(m.$('kt-ai-ws-state').innerHTML) && /採用（変更案の作成に失敗。再試行できます）/.test(m.$('kt-ai-change-summary').innerHTML) && !/最終案を作っています/.test(m.$('kt-ai-change-summary').innerHTML), `B4-2: 失敗の後: 仮案は open・右の見出し「仮案」・右の詳細に失敗の文: ${m.$('kt-ai-ws-state').innerHTML}`);
  assert(err && err.data.intent === 'ADOPT_DRAFT' && err.data.retryText === '採用します' && /data-act="retry"/.test(m.chat()) && /仮案 — 採用（変更案の作成に失敗。再試行できます）/.test(m.chat()) && /data-act="draft-adopt"/.test(m.chat()), 'B4-3: 失敗のカードに［再試行］（採用します）・仮案のカードは開いたまま（採用のボタンあり）');
  await clickChat(m, 'retry', { text: err.data.retryText, intent: err.data.intent }); await ticks(8);
  assert(m.calls.plan.length === 2 && m.calls.plan[1].ctx.goal === m.calls.plan[0].ctx.goal && m.conv().draft().status === 'open' && m.conv().draft().planFailed.attempt === 2, 'B4-4: ［再試行］は仮案から作り直す（同じ依頼文）。また失敗したら open のまま');
  m.planImpl = null;   // 計画の AI が直った
  const u = m.msgs().filter(x => x.type === 'USER').length;
  await clickChat(m, 'draft-adopt', { draft: m.conv().draft().id }); await ticks(10);
  const d = m.conv().draft(), v = m.conv().activePlan();
  assert(m.msgs().filter(x => x.type === 'USER').length === u + 1 && v && d.status === 'adopted' && d.planId === v.planId && /仮案 — 採用済み/.test(m.chat()) && /kt-ai-final-card/.test(m.chat()) && /data-status="ready">未反映</.test(m.$('kt-ai-ws-state').innerHTML) && /<h3>/.test(m.$('kt-ai-change-summary').innerHTML), `B4-5: ［採用］でもう一度 → 計画ができたら adopted・最終案のカード・右は変更内容に: ${d.status} / ${m.$('kt-ai-ws-state').innerHTML}`);
  // 回答欄（data-dkey）のフォーカスの復元: 描き直しの前に入力中だった回答欄へ戻す（Toolkit の sandbox の document.activeElement を仮に置く）
  const el = { dataset: { dkey: 'x:k' }, selectionStart: 2, focused: false, caret: null, focus() { this.focused = true; }, setSelectionRange(a) { this.caret = a; } };
  const chatEl = m.$('kt-ai-chat');
  const prevQSA = chatEl.querySelectorAll;
  const sbDoc = T.__sandbox.document;
  chatEl.querySelectorAll = (sel) => (sel === '.kt-ai-qa-input' ? [el] : []);
  sbDoc.activeElement = el;
  try { await m.panel.send('ありがとう'); await ticks(4); } finally { delete sbDoc.activeElement; chatEl.querySelectorAll = prevQSA; }
  assert(el.focused === true && el.caret === 2, 'B4-6: 仮案の回答欄（data-dkey）に入力中なら、描き直しの後にフォーカスとカーソルを戻す');
});

// =========================================================
console.log('\n--- §B6. 段階 B 修正後の確認（2026-10-07）: 決定事項が最初の計画に届く / 応答待ちのボタン / 表示用の goal / 作成中の要約 / 仮案が無いときの判定 ---');
/** 計画の AI が、仮案で答えた論点（期限の日数）をもう一度質問し、新しい論点（指定する画面）も質問する計画 */
const PLAN_QS = [{ id: 'Q1', question: '承認の期限は申請から何営業日にしますか', topic: 'timing' }, { id: 'Q2', question: '承認者はどの画面で指定しますか', topic: 'location' }];
const planReask = (args) => { const r = planOk(args); return { ...r, plan: { ...r.plan, questions: PLAN_QS } }; };
// 1. 会話: 採用 → 最初の計画の services.plan に決定事項（構造化）→ 計画の AI が同じ論点を質問しても openQuestions に出ない（reasked に記録）→ 台帳に回答済みとして入る → 差分更新でも decisions に入る
await section(async () => {
  const x = makeConv({ planImpl: planReask });
  const { c, calls } = x;
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) await c.send(s);
  const r = await c.send('おすすめで。この案で進めて');
  const v = c.activePlan();
  assert(r.ok && r.intent === 'ADOPT_DRAFT' && v && calls.plan.length === 1 && !calls.plan[0].revision && Array.isArray(calls.plan[0].decisions) && calls.plan[0].decisions.length === 4 && calls.plan[0].decisions.some(d => d.key === 'deadline.days' && d.answer === '7営業日'), `B6-1: 採用 → 最初の計画（revision 無し）の services.plan に仮案で答えた決定事項（4 件）を渡す: ${JSON.stringify((calls.plan[0] || {}).decisions)}`);
  const openTexts = (v.openQuestions || []).map(q => q.text), reasked = (v.reaskedQuestions || []).map(q => q.text);
  assert(openTexts.join('|') === '承認者はどの画面で指定しますか' && reasked.join('|') === '承認の期限は申請から何営業日にしますか', `B6-2: 計画の AI が仮案で答えた論点（期限の日数）をもう一度質問しても openQuestions に出ない（reasked に記録）。新しい論点だけ残る: open=${openTexts.join('|')} / reasked=${reasked.join('|')}`);
  const lg = c.ledger(v.planId);
  const carried = lg.filter(e => e.draftKey);
  assert(carried.length === 4 && carried.every(e => e.status === 'answered' && e.source === 'chat' && e.appliedInVersion === 1 && e.question && e.kind === 'question') && carried.find(e => e.draftKey === 'deadline.days').topics.join() === 'timing' && carried.find(e => e.draftKey === 'approval.threshold').topics.join() === 'approver' && carried.find(e => e.draftKey === 'approval.threshold').label === '部長承認の条件' && carried.find(e => e.draftKey === 'approval.threshold_middle').delegated === true && !carried.find(e => e.draftKey === 'deadline.days').delegated, `B6-3: 仮案の決定事項は計画の系列の台帳に回答済み（topics は key から・label・question・answer・delegated の印・最初の版に入れた）として入る: ${JSON.stringify(carried.map(e => [e.draftKey, e.topics, e.label, e.answer, e.delegated || false, e.appliedInVersion]))}`);
  assert(!c.messages().some(m => m.data?.kind === 'answers-ack') && c.answerContext().open.length === 1 && c.answerContext().open[0].text === '承認者はどの画面で指定しますか', `B6-4: 台帳に入れた決定事項は「まだ変更案に入っていない回答」にならず、未回答は新しい論点の 1 件だけ: ${JSON.stringify(c.answerContext().open.map(q => q.text))}`);
  // 表示用の goal（確認 3）: 版の goal は仮案の依頼文（1 行目）。Gateway へ送った goal（goalSent）は依頼文 ＋ 採用した方針の 2 行のまま
  assert(v.goal === '課長・部長の承認者を選ぶ運用にしたい' && v.goalSent === calls.plan[0].goal && v.goalSent.split('\n').length === 2 && /^採用した方針: /.test(v.goalSent.split('\n')[1]), `B6-5: 版の表示用の goal は仮案の依頼文の 1 行目。Gateway へ送る goal は今のまま（2 行）: ${JSON.stringify({ goal: v.goal, goalSent: v.goalSent })}`);
  // 差分更新: 送る goal は goalSent・決定事項（仮案の分を含む）を渡す
  const rr = await c.send('一覧の名前は承認待ちにして');
  const p1 = calls.plan[1];
  assert(rr.ok && rr.intent === 'REVISE_PLAN' && calls.plan.length === 2 && p1.revision === true && p1.goal === v.goalSent && (p1.decisions || []).some(d => d.topic === 'timing' && d.answer === '7営業日') && (p1.decisions || []).some(d => d.topic === 'approver' && d.answer === '100円未満は不要、100万円以上は必要') && (p1.decisions || []).length >= 4, `B6-6: 以後の差分更新でも仮案の決定事項が decisionsForContext に入り、goal は Gateway へ送ったもの（2 行）のまま: ${JSON.stringify({ goal: p1.goal.split('\n').length, decisions: (p1.decisions || []).map(d => [d.topic, d.answer]) })}`);
  const v2 = c.activePlan();
  assert(v2.version === 2 && v2.goal === '課長・部長の承認者を選ぶ運用にしたい' && v2.goalSent === v.goalSent && v2.fromDraft && v2.fromDraft.id === c.draft().id, `B6-7: 次の版も表示用の goal は 1 行目のまま（fromDraft を引き継ぐ）: ${JSON.stringify({ goal: v2.goal, version: v2.version })}`);
});
// 1b. 画面: Gateway に送る Planner Context（KTContextUi.generatePlan の ctx）に decisions が入る・右の見出しは依頼文の 1 行目・計画の AI の再質問は出ない
await section(async () => {
  const planWithQs = ({ ctx, requestId }) => { const raw = PLAN_V1(ctx.goal); raw.plan.questions = PLAN_QS; const v = KTAiClient.validatePlan(raw, ctx); if (!v.ok) throw new Error(v.errors[0].message); return { ...v.normalized, requestId, clientWarnings: v.warnings }; };
  const m = mount({ planImpl: planWithQs });
  await ticks();
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) { await m.panel.send(s); await ticks(8); }
  await m.panel.send('おすすめで。この案で進めて'); await ticks(12);
  const ctx = m.calls.plan[0] && m.calls.plan[0].ctx;
  const v = m.conv().activePlan();
  assert(v && ctx && !ctx.revision && Array.isArray(ctx.decisions) && ctx.decisions.length === 4 && ctx.decisions.every((d, i) => d.id === `D${i + 1}` && d.source === 'chat' && d.status === 'answered' && d.answer) && ctx.decisions.some(d => d.topic === 'timing' && d.answer === '7営業日') && ctx.decisions.some(d => d.topic === 'approver' && /部長承認/.test(d.question || '')), `B6-8: 採用後の最初の計画の Planner Context（Gateway に送る形）に decisions（D1…・topic・question・answer）が入る: ${JSON.stringify(ctx && ctx.decisions)}`);
  assert(ctx.goal.split('\n').length === 2 && v.goal === '課長・部長の承認者を選ぶ運用にしたい' && /<h3>課長・部長の承認者を選ぶ運用にしたい<\/h3>/.test(m.$('kt-ai-change-summary').innerHTML) && !/<h3>[^<]*採用した方針/.test(m.$('kt-ai-change-summary').innerHTML), `B6-9: 右ペインの見出しは依頼文の 1 行目（合成の 2 行にならない）。Context の goal は 2 行のまま: ${(m.$('kt-ai-change-summary').innerHTML.match(/<h3>[^<]*<\/h3>/) || [])[0]}`);
  const openTexts = (v.openQuestions || []).map(q => q.text), reasked = (v.reaskedQuestions || []).map(q => q.text);
  assert(openTexts.join('|') === '承認者はどの画面で指定しますか' && reasked.join('|') === '承認の期限は申請から何営業日にしますか' && !/承認の期限は申請から何営業日にしますか[\s\S]*data-qkey/.test(outsideDetails(m.chat())) && /後で決めてよいことが 1 件あります/.test(m.chat()) && !/承認者はどの画面で指定しますか[\s\S]*data-qkey/.test(outsideDetails(m.chat())) && /承認者はどの画面で指定しますか/.test(m.$('kt-ai-change-summary').innerHTML + m.$('kt-ai-spec').innerHTML + (m.$('kt-ai-questions') ? m.$('kt-ai-questions').innerHTML : '')), `B6-10（反証 B6: 最終案のカードは先に決めたいことだけ。後で決めてよい質問は件数と右ペイン）: 画面でも、仮案で答えた論点の再質問は確認事項に出ず、新しい論点だけ出る: open=${openTexts.join('|')} / reasked=${reasked.join('|')}`);
});
// 2. 画面: 仮案の AI の応答待ち中（working PROPOSE）は、仮案のカードの［採用］［一部採用］［不採用］と回答欄を出さず、短い案内を出す（カードは畳まない）
await section(async () => {
  const gm = { p: Promise.resolve() };   // 1 回目の仮案は止めない。2 回目の返事の応答だけ止める
  const m = mount({ proposeGate: gm });
  await ticks();
  await m.panel.send('課長・部長の承認者を選ぶ運用にしたい'); await ticks(8);
  const before = m.chat();
  //   2026-10-14 の設計し直し: 回答欄は右の「変更内容」の仮案の詳細（応答待ちの間はそこでも出さない）
  assert(/data-act="draft-adopt"/.test(before) && !/data-dkey="/.test(before) && /data-dkey="/.test(m.$('kt-ai-change-summary').innerHTML) && !/仮案の返事を待っています/.test(before), 'B6-11: 応答を待っていないときは［採用］（会話）と回答欄（右の仮案の詳細）がある');
  const g = gate(); gm.p = g.p;
  const p = m.panel.send('100円未満は部長不要、100万円以上は必要'); await ticks(8);
  const during = m.chat();
  const cardDuring = (during.match(/<div class="kt-ai-card kt-ai-draft-card[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
  assert(m.conv().state.working === 'PROPOSE' && !/data-act="draft-adopt"|data-act="draft-partial"|data-act="draft-reject"|data-act="draft-answer"/.test(during) && !/data-dkey="/.test(during) && !/data-dkey="|data-act="draft-answer"/.test(m.$('kt-ai-change-summary').innerHTML) && /kt-ai-draft-card is-waiting/.test(during) && /仮案の返事を待っています/.test(during) && !/kt-ai-draft-card is-old/.test(during) && !INTERNAL.test(outsideDetails(during).replace(/data-[a-z]+="[^"]*"/g, '')), `B6-12: 応答待ち中は［採用］［一部採用］［不採用］と回答欄を出さず、「仮案の返事を待っています」の案内だけ（カードは畳まない）: ${cardDuring.slice(0, 160)}`);
  const users = m.msgs().filter(x => x.type === 'USER').length;
  await clickChat(m, 'draft-adopt', { draft: m.conv().draft().id }); await ticks(4);
  assert(m.msgs().filter(x => x.type === 'USER').length === users && m.calls.plan.length === 0 && m.calls.propose.length === 2, 'B6-13: 応答待ち中に古いカードの［採用］が押されても、送らない（計画も作らない）');
  g.open(); await p; await ticks(8);
  const after = m.chat();
  assert(m.conv().draft().rev === 2 && /data-act="draft-adopt"/.test(after) && /data-dkey="/.test(m.$('kt-ai-change-summary').innerHTML) && !/仮案の返事を待っています/.test(after) && (after.match(/kt-ai-draft-card is-old/g) || []).length === 1, 'B6-14: 応答が届いたら新しいカードに［採用］と回答欄が戻り、前のカードは 1 行に畳む');
  const viewNoWorking = KTAiChatUi.messageHtml(m.msgs().filter(x => x.type === 'DRAFT').slice(-1)[0], { draft: m.conv().draft(), draftDecisions: m.conv().draftDecisions(), draftAnswers: new Map() });
  const viewWorking = KTAiChatUi.messageHtml(m.msgs().filter(x => x.type === 'DRAFT').slice(-1)[0], { draft: m.conv().draft(), draftDecisions: m.conv().draftDecisions(), draftAnswers: new Map(), working: 'PROPOSE' });
  assert(/data-act="draft-adopt"/.test(viewNoWorking) && !/data-act="draft-adopt"/.test(viewWorking) && /仮案の返事を待っています/.test(viewWorking) && /data-act="draft-adopt"/.test(KTAiChatUi.messageHtml(m.msgs().filter(x => x.type === 'DRAFT').slice(-1)[0], { draft: m.conv().draft(), draftDecisions: m.conv().draftDecisions(), draftAnswers: new Map(), working: 'PLAN' })), 'B6-15: draftCardHtml は view.working が PROPOSE のときだけ押せないボタンを出さない（PLAN は draft.planning で判定）');
});
// 4. 採用して最終案を作っている間の、質問の AI に渡す仮案の要約は「採用した仮案（最終案を作成中）」
await section(async () => {
  const g = gateMk();
  const x = makeConv({ planImpl: async () => { await g.p; return planOk({ goal: 'g' }); } });
  const { c, calls } = x;
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) await c.send(s);
  const p = c.send('おすすめで。この案で進めて');
  await ticks(6);
  const rq = await c.send('CSVにも効きますか？');
  const cv = calls.ask.slice(-1)[0].conversation;
  assert(rq && rq.asked === true && c.draft().planning === true && cv.plan && /^採用した仮案（最終案を作成中）: /.test(cv.plan.summary) && !/採用前の仮案/.test(cv.plan.summary) && cv.working === 'PLAN', `B6-16: 最終案を作っている間の質問には「採用した仮案（最終案を作成中）」の要約を添える: ${cv.plan && cv.plan.summary.slice(0, 60)} / ${cv.working}`);
  g.open(); await p; await ticks(4);
  assert(c.activePlan() && c.draft().status === 'adopted', 'B6-17: 計画ができたら adopted（要約は計画に切り替わる）');
  const y = makeConv();
  await y.c.send('課長・部長の承認者を選ぶ運用にしたい');
  await y.c.send('5営業日にすると何が変わる？');
  assert(/^採用前の仮案（まだ計画ではありません）: /.test(y.calls.ask[0].conversation.plan.summary), 'B6-18: 採用前は従来どおり「採用前の仮案（まだ計画ではありません）」');
});
// 5. 仮案が無いときの PROPOSE 判定: 相づち・制止・短い否定は従来の判定へ。言い切りの長さの条件は 8 字以上
await section(async () => {
  const cd = KTAiConversation.classifyDraft;
  const noDraft = { activePlan: null, draft: null, draftDecisions: [] };
  const notReq = ['問題ありません', 'ちょっと待って', 'やめる', 'やっぱりやめる', 'この案は採用しません', '結構です', '採用しません', 'やめて', '大丈夫です', '不採用で', '違います', 'いいえ'];
  assert(notReq.every(s => cd(s, noDraft) === null), `B6-19: 仮案が無いとき、相づち・制止・短い否定は PROPOSE にしない（従来の判定へ）: ${notReq.map(s => `${s}:${cd(s, noDraft)?.intent || 'null'}`).join(' ')}`);
  assert(cd('承認者は部長', noDraft) === null && cd('承認者は部長固定', noDraft)?.intent === 'PROPOSE' && cd('承認済みでは金額を編集不可', noDraft)?.intent === 'PROPOSE' && cd('通知は不要', noDraft)?.intent === 'PROPOSE' && cd('一覧も作りたい', noDraft)?.intent === 'PROPOSE', 'B6-20: 言い切りは 8 字以上で依頼と読む（要望の語があれば短くても依頼）');
  const open = { activePlan: null, draftDecisions: [], draft: { id: 'd1', status: 'open', items: { behaviors: [], assumptions: [], decisions: [], approach: { standard: [], js: [] }, cannot: [] } } };
  assert(cd('この案は採用しません', open)?.intent === 'DRAFT_REPLY' && cd('やっぱりやめる', open)?.intent === 'DRAFT_REPLY' && cd('問題ありません', open)?.intent === 'ADOPT_DRAFT', 'B6-21: 仮案が open のときの判定は変えない（不採用・やめるは AI へ、問題ありませんは採用語）');
  // 従来の会話の経路（仮案が無い）: 「ちょっと待って」で仮案の AI を呼ばない
  const x = makeConv({ withPlan: true });
  const r = await x.c.send('ちょっと待って');
  assert(r.intent !== 'PROPOSE' && x.calls.propose.length === 0 && x.calls.plan.length === 0, `B6-22: 「ちょっと待って」は仮案の AI も計画の AI も呼ばない: ${r.intent}/${r.reason}`);
});

// =========================================================
console.log('\n--- §C. 段階 C: 最終案のパイプライン（R09 R10 R11 R16 R17 R18 R19 R21）と待ち時間の表示（C3b）。2026-10-08: 生成工程の verification を返す偽の生成 ---');
//   偽 services: plan（JS ありの計画。金額の効果は lock）/ generate（Gateway の customization-generator の偽物。Toolkit が固定した必須の効果を受け取り、
//   候補の性質（has: フィールドごとに実装している効果・fails: 動作テストで不合格になる効果）から requiredEffects の status と behavior の結果を返す。
//   修復は生成工程の 1 依頼の中で済んだものとして repairs に記録）。Toolkit は模擬を実行せず、代表条件も作らず、修復も依頼しない
// ---- R09: 仮案の採用 → JS 仕様の別確認なしで最終案（計画 → 自動確定 → 生成と検証（生成工程の 1 依頼）→ 1 枚のカード。外部反映はしない）----
await section(async () => {
  const x = makeConvC();
  const r = await adoptC(x);
  const v = x.c.activePlan(), d = x.c.draft();
  assert(r.ok && r.intent === 'ADOPT_DRAFT' && v && d.status === 'adopted' && d.finalAt && v.final && x.finals().length === 1, `R09-1: 採用 → 計画 → 最終案のカード 1 枚: ${JSON.stringify(x.kinds())}`);
  assert(v.spec && v.spec.status === 'CONFIRMED' && v.spec.autoConfirmed === true && v.spec.customizeRevision === '42' && !x.c.messages().some(m => m.type === 'SPEC' || m.data?.kind === 'spec-intro' || m.data?.kind === 'spec-confirm-hint'), `R09-2: JS の仕様は自動で確定（customizeRevision を記録）。［この仕様で確定］の案内・仕様カードは出さない: ${JSON.stringify(v.spec && { status: v.spec.status, rev: v.spec.customizeRevision })}`);
  assert(!x.c.messages().some(m => m.type === 'PLAN' || m.type === 'CODE' || ['plan-summary', 'review-summary', 'questions', 'provisionals', 'code-intro', 'confirm-generate'].includes(m.data?.kind)), `R09-3: 変更案の要約・確認事項・提案・コードの案内は別のカードにしない（最終案に統合）: ${JSON.stringify(x.kinds())}`);
  const sent = x.gen.calls[0] && x.gen.calls[0].requiredEffects;
  assert(x.gen.calls.length === 1 && x.gen.calls[0].verification === true && !x.gen.calls[0].feedback && JSON.stringify(sent) === JSON.stringify([{ requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect: 'lock', events: ['app.record.edit.show'], condition: 'ステータス in ("承認待ち")' }]) && v.generated.C1 && v.generated.C1.status === 'verified' && v.generated.C1.verdict.status === 'verified', `R09-4: 生成工程への依頼は 1 回（必須の効果を固定して渡す・修復は依頼しない）→ 検証済み: ${JSON.stringify({ gen: x.gen.calls.length, sent, status: v.generated.C1 && v.generated.C1.status })}`);
  assert(v.final.approvable === true && v.final.customizations[0].status === 'verified' && v.final.behaviors.length >= 1 && v.final.changed.rejected.length === 0 && v.final.verification.behavior.status === 'passed' && v.final.verification.behavior.counts.pass === v.final.verification.behavior.cases.length && v.final.verification.effects.length === 1 && v.final.verification.effects[0].structure === 'present', `R09-5: 最終案は承認できる（動作・変わった点・検証の区分）: ${JSON.stringify({ approvable: v.final.approvable, behaviors: v.final.behaviors, beh: v.final.verification.behavior })}`);
  const tm = x.c.metrics().timings.slice(-1)[0];
  assert(tm.intent === 'ADOPT_DRAFT' && tm.calls.map(k => k.kind).join(',') === 'plan,generate' && tm.calls.every(k => typeof k.ms === 'number') && tm.finalMs >= 49000 && v.final.timing.planMs === 30000 && v.final.timing.generateMs === 20000 && !('simMs' in v.final.timing), `R09-6: 計測（calls に plan / generate と区間の時間・最終案までの時間。模擬の区間は無い）: ${JSON.stringify({ calls: tm.calls.map(k => [k.kind, k.ms]), finalMs: tm.finalMs, timing: v.final.timing })}`);
  assert(v.final.usage.aiCalls === 2 && v.final.usage.repairs === 0 && x.c.metrics().aiCalls >= 2, `R09-7: AI の呼び出し回数（Toolkit からの修復の依頼は 0）: ${JSON.stringify(v.final.usage)}`);
  assert(!x.c.messages().some(m => m.type === 'LOADING') && x.c.progress() === null, 'R09-8: 進みのカードは完了で消える（記録には残さない）');
  const html = finalHtml(x);
  assert(/最終案ができました。/.test(html) && /この案で実現すること/.test(html) && /仮案からの補足/.test(html) && !/最終的にどう動くか|反映先と主な影響|検証の区分|まだ何も反映していません/.test(html) && /承認待ちでは金額を編集不可にします。/.test(rightOf(x)) && /反映する内容/.test(rightOf(x)) && /確かめたこと/.test(rightOf(x)) && /data-act="final-approve"[^>]*disabled>動作テスト環境へ反映/.test(html) && /反映の前の準備を待っています/.test(html), `R09-9（2026-10-14: 最終的にどう動くか・反映先と主な影響・検証の区分は右の「変更内容」へ）: 最終案のカード: 見出し・実現すること・補足と［動作テスト環境へ反映］（承認の欄の準備（書き込みなし）が終わるまでは押せない）: ${html.replace(/<[^>]*>/g, '｜').slice(0, 300)}`);
  //   §0e.1（2026-10-09）: 承認の欄の準備が終わると（画面が view.finalPre を渡す）、重要事項をまとめて出し、ボタンを押せる
  { const fm = x.finals().slice(-1)[0], va = x.c.activePlan();
    const htmlReady = KTAiChatUi.messageHtml(fm, { plans: new Map(x.c.planHistory().map(z => [`${z.planId}:${z.version}`, z])), activePlan: va, answerState: x.c.answerContext(), ledger: x.c.ledger(), answers: new Map(), finalPre: { planId: va.planId, version: va.version, status: 'ready', reasons: [], items: { target: '動作テスト環境（このアプリ）。運用環境には反映しません', settings: [], process: ['ステータス「部長承認待ち」を追加'], existing: [], duplicate: [], files: ['＋ lock.js（PC）新規追加（3 番目・末尾）'], keep: [], deferred: [], confirmations: ['確認項目の例'], warnings: [], manual: [] } } });
    const tReady = stripC(htmlReady);
    assert(!/disabled>動作テスト環境へ反映/.test(htmlReady) && /反映の前の確認（書き込みなし）/.test(tReady) && /プロセス管理の変更/.test(tReady) && /追加・置き換える JavaScript/.test(tReady) && /確認項目（この承認で確認済みとして扱います）/.test(tReady) && /対象: 動作テスト環境/.test(tReady) && /承認すると動作テスト環境へ JavaScript を反映します（運用環境は変更しません）/.test(tReady) && !/設定の手順 → JavaScript の順/.test(tReady) && /この内容で反映できます。/.test(tReady), `R09-9b（2026-10-15: JavaScript だけの最終案の添え書きは「JavaScript を反映」）: 承認の欄の準備が終わると、重要事項（プロセスの変更・追加するファイル・確認項目・対象の環境）をまとめて出し、［動作テスト環境へ反映］を押せる: ${tReady.slice(-600)}`); }
  // 2026-10-15（最終案の重複と担当未定の食い違い §2）: ［コードを見る（…）］は JavaScript の役割の名前（計画の画面と効果から。例「PCの編集制御」）。
  //   ファイル名は通常表示に出さない（反映の前の確認の一覧に出る）
  const visibleC = outsideDetails(html).replace(/data-[a-z]+="[^"]*"/g, '');
  assert(/コードを見る（PCの編集制御）/.test(html) && !/[\w.-]+\.js\b/.test(visibleC) && !INTERNAL.test(visibleC) && !/\bC1\b|\bP1\b|candidateHash|sim-control|required-effects|block-save|\bamount\b/.test(visibleC), `R09-10: カードに内部の番号・処理名・フィールドコード・ファイル名を出さない（コードのボタンは役割の名前）: ${(visibleC.match(INTERNAL) || visibleC.match(/\bamount\b|required-effects|[\w.-]+\.js\b/) || [])[0]}`);
  const draftCard = KTAiChatUi.messageHtml(x.c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], { draft: d, draftDecisions: x.c.draftDecisions() });
  assert(/仮案 — 採用済み/.test(draftCard) && /kt-ai-old-card/.test(draftCard), 'R09-11: 仮案のカードは 1 行に畳む（「仮案 — 採用済み」）');
});
// ---- R17: 最初の候補の欠陥は生成工程の 1 依頼の中で修復済み → 検証済みの最終案を 1 つ提示（Toolkit は修復を依頼しない・失敗候補への判断を求めない）----
await section(async () => {
  const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], repairs: 1 }) });
  await adoptC(x);
  const v = x.c.activePlan();
  assert(x.gen.calls.length === 1 && !x.gen.calls[0].feedback && v.generated.C1.status === 'verified' && v.final.approvable && x.finals().length === 1, `R17-1: 生成工程が中で直した候補 → Toolkit からの追加の呼び出しなしで検証済みの最終案 1 つ: ${JSON.stringify({ gen: x.gen.calls.length, status: v.generated.C1.status })}`);
  assert(!x.c.messages().some(m => m.type === 'CODE' || m.type === 'ERROR' || m.data?.kind === 'generate-repeat' || m.data?.kind === 'code-intro'), `R17-3: 検査途中の候補を「完成」と出さない・採用不可のカードを出さない: ${JSON.stringify(x.kinds())}`);
  assert(v.final.usage.repairs === 0 && v.final.usage.gatewayRepairs === 1 && v.final.customizations[0].gatewayRepairs === 1 && /生成工程の修復 1 回/.test(finalHtml(x)) && /生成工程で 1 回修復/.test(rightOf(x)), `R17-4: 生成工程の修復回数を記録し、詳細に出す: ${JSON.stringify(v.final.usage)}`);
});
// ---- R19: 生成工程の修復の上限で直らない → 未解決の理由と次の方針を 1 回まとめ、反映可能な完成品として出さない（Toolkit は再依頼しない）----
await section(async () => {
  const y = makeConvC({ generate: makeGenerate({ sequence: ['bad'], repairs: 2, stoppedBy: 'limit' }) });
  await adoptC(y);
  const vy = y.c.activePlan();
  assert(y.gen.calls.length === 1 && !y.gen.calls[0].feedback && vy.generated.C1.status === 'unresolved' && vy.generated.C1.verdict.kind === 'behavior-fail' && vy.generated.C1.verdict.stoppedBy === 'limit', `R19-1: 生成工程が上限まで修復して直らない → Toolkit は追加で呼ばない（1 回だけ）: ${JSON.stringify({ calls: y.gen.calls.length, verdict: vy.generated.C1.verdict })}`);
  assert(vy.final && vy.final.approvable === false && /反映できる完成品になっていない/.test(vy.final.blockingReason) && vy.final.cannot.some(c => c.kind === 'unresolved' && /生成工程で修復を 2 回行いましたが/.test(c.text) && /同じ依頼のまま作り直しても結果は変わりません/.test(c.next)) && y.finals().length === 1, `R19-3: 未解決の理由と次の方針を最終案に 1 回まとめ、承認できる完成品としては出さない: ${JSON.stringify(vy.final.cannot)}`);
  const ap = y.c.approveFinal({ planId: vy.planId, version: vy.version });
  assert(ap.ok === false && ap.reason === 'NOT_APPROVABLE' && !vy.approval, 'R19-4: 未解決の最終案は承認できない');
  const html = finalHtml(y);
  assert(/disabled>動作テスト環境へ反映/.test(html) && /次の方針/.test(html) && (html.match(/kt-ai-final-card/g) || []).length === 1, `R19-5: カードの［この内容で反映する］は押せず、理由と次の方針が 1 回だけ: ${html.replace(/<[^>]*>/g, '｜').slice(0, 300)}`);
  assert(!y.c.messages().some(m => m.type === 'ERROR' || m.data?.kind === 'generate-repeat'), 'R19-6: 同じ採用不可カードを連続表示しない（エラーカードも出さない）');
  const tmZ = y.c.metrics().timings.slice(-1)[0];
  assert(tmZ.calls.map(k => k.kind).join(',') === 'plan,generate' && vy.final.usage.aiCalls === 2 && vy.final.usage.gatewayRepairs === 2, `R19-9: 計測の記録（計画・生成。Toolkit の修復の依頼は無い）: ${JSON.stringify({ calls: tmZ.calls.map(k => k.kind), usage: vy.final.usage })}`);
});
// ---- R10: 確認事項（blocking の質問）と JS 仕様: 回答先・次の操作は最終案のカード 1 つ。回答済みの質問は別カードで残らない ----
await section(async () => {
  const Q = [{ id: 'Q1', question: '承認待ちの間、申請者本人も編集できなくしますか', topic: 'scope', priority: 'blocking', options: ['全員', '申請者以外'] }];
  const x = makeConvC({ planImpl: (args) => planJs(args, { questions: args.revision ? [] : Q }) });
  await adoptC(x);
  const v1 = x.c.activePlan();
  assert(v1.final && v1.final.approvable === false && /先に決めたいことが 1 件/.test(v1.final.blockingReason) && v1.final.questions.length === 1 && !x.c.messages().some(m => m.data?.kind === 'questions'), `R10-1: 先に必要な判断は最終案のカードの中（確認事項のカードは出さない）。承認はまだできない: ${JSON.stringify({ q: v1.final.questions.map(q => q.text), kinds: x.kinds() })}`);
  const html1 = finalHtml(x);
  assert(/残る判断（1 件）/.test(html1) && /申請者本人も編集できなくしますか/.test(html1) && /class="kt-ai-qa-input" data-qkey="/.test(html1) && /data-act="answer-questions"/.test(html1) && /disabled>動作テスト環境へ反映/.test(html1), `R10-2: 回答欄と［回答を送る］はこのカードだけ・反映のボタンは押せない: ${html1.replace(/<[^>]*>/g, '｜').slice(0, 300)}`);
  const r = await x.c.send('確認事項への回答です。\n・承認待ちの間、申請者本人も編集できなくしますか → 全員', { intentOverride: 'ANSWER', answerPayload: { source: 'answer-card', items: [{ key: 'Q1', answer: '全員' }] } });
  const v2 = x.c.activePlan();
  assert(r.ok && v2.version === 2 && v2.final && v2.final.approvable === true && v2.final.questions.length === 0 && x.finals().length === 2 && x.calls.plan.length === 2 && x.calls.plan[1].revision, `R10-3: 回答 → 差分更新 → 新しい最終案（残る判断なし・承認できる）: ${JSON.stringify({ version: v2.version, q: v2.final.questions, plans: x.calls.plan.length })}`);
  const old = KTAiChatUi.messageHtml(x.finals()[0], { plans: new Map(x.c.planHistory().map(v => [`${v.planId}:${v.version}`, v])), activePlan: v2, answerState: x.c.answerContext(), ledger: x.c.ledger(), answers: new Map() });
  assert(/前の最終案 — このあと直した案があります/.test(old) && /kt-ai-old-card/.test(old) && !/data-qkey=/.test(old) && !/data-act="final-approve"/.test(old) && !/残る判断/.test(finalHtml(x)), 'R10-4: 前の最終案は 1 行に畳み、回答済みの質問は別のカードで残らない');
  assert(x.gen.calls.length === 1 && v2.generated.C1.reused === true, 'R10-5: 実装仕様が変わらなければ JavaScript は作り直さず、検証結果も流用する（計画の AI だけ 1 回）');
});
// ---- R11 / R18: 最終案の生成中の追加指示 → 完了後に差分更新 → 変わった customization だけ作り直し → 最終案を置き換えて「変わった点」を出す ----
await section(async () => {
  const g = gateMk();
  const CUST_V2 = custOf(['lock'], {});
  CUST_V2.fields[1].condition = 'ステータス in ("承認待ち", "承認済み")';
  const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], gate: g }) });
  const p = adoptC(x);
  await ticks(10);
  assert(x.c.isBusy() && x.c.state.working === 'FINAL' && x.c.state.workInbox && x.c.state.workInbox.kind === 'FINAL' && VM.workStatus({ version: x.c.activePlan(), working: 'FINAL' }).label === '最終案を作成中', `R11-1: 生成中は working FINAL・見出し「最終案を作成中」: ${x.c.state.working}`);
  const rq = await x.c.send('通知は外して');
  assert(rq && rq.queued === true && rq.reason === 'QUEUED_DURING_FINAL' && x.c.messages().some(m => m.data?.kind === 'answers-ack' && /いま作っている最終案ができてから/.test(m.text)), `R11-2: 生成中の指示は積んで受領を出す: ${JSON.stringify(rq)}`);
  const ra = await x.c.send('CSVにも効きますか？');
  assert(ra && ra.asked === true && x.calls.ask.length === 1, 'R11-3: 生成中の質問は並べて答える');
  g.open(); await p; await ticks(12);
  const v2 = x.c.activePlan();
  assert(v2 && v2.version === 2 && x.calls.plan.length === 2 && /通知は外して/.test(x.calls.plan[1].request) && x.finals().length === 2 && x.gen.calls.length === 1 && v2.generated.C1.reused === true, `R11-4: 完了後に差分更新 → 実装仕様が同じ C1 は作り直さない → 最終案を置き換え（重複生成しない）: ${JSON.stringify({ version: v2 && v2.version, plans: x.calls.plan.length, gen: x.gen.calls.length })}`);
  assert(v2.final.changedSince && v2.final.changedSince.reused.includes('C1') && /通知は外して/.test(v2.final.changedSince.revisionRequest) && /最終案を直しました。/.test(finalHtml(x)) && /前の最終案から変わった点/.test(rightOf(x)) && /入れた指示: 通知は外して/.test(rightOf(x)) && !/入れた指示/.test(finalHtml(x)), `R11-5: 最終案のカードに「変わった点」（入れた指示・作り直した / そのままの JavaScript）: ${JSON.stringify(v2.final.changedSince)}`);
  assert(x.c.messages().filter(m => m.data?.kind === 'answers-ack').every(m => m.data.stage === 'done'), 'R11-6: 受領は「変更案に入れました」になる');
  // R18: 実装仕様（条件）が変われば候補も検証結果も流用しない（作り直して、新しい条件の必須の効果で検証し直す）
  const y = makeConvC({ planImpl: (args) => planJs(args, { cust: args.revision ? CUST_V2 : CUST_C1 }) });
  await adoptC(y);
  await y.c.send('承認済みでも金額は編集不可にして');
  const vy = y.c.activePlan();
  assert(vy.version === 2 && y.gen.calls.length === 2 && vy.generated.C1.reused !== true && vy.final.changedSince.regenerated.includes('C1') && y.gen.calls[1].requiredEffects[0].condition === 'ステータス in ("承認待ち", "承認済み")', `R18-1: 実装仕様（条件）が変わった → 作り直して、新しい条件の必須の効果で検証し直す（前の合格は流用しない）: ${JSON.stringify({ gen: y.gen.calls.length, cond: y.gen.calls[1] && y.gen.calls[1].requiredEffects })}`);
  // R18: 既存コードが変わった → 流用しない
  const z = makeConvC({ planImpl: (args) => planJs(args) });
  let hashNow = 'aaaa0000';
  z.services.existingHash = async () => hashNow;
  await adoptC(z);
  hashNow = 'bbbb1111';
  await z.c.send('一覧の名前は承認待ちにして');
  assert(z.c.activePlan().version === 2 && z.gen.calls.length === 2, `R18-3: 統合先の既存コードの指紋が変わった → 流用せず作り直す: ${z.gen.calls.length}`);
});
// ---- R16 / C4: 承認の記録と無効化（版・planHash・基準の stamp・候補の hash） ----
await section(async () => {
  const x = makeConvC();
  await adoptC(x);
  const v = x.c.activePlan();
  const ap = x.c.approveFinal({ planId: v.planId, version: v.version });
  assert(ap.ok && v.approval && v.approval.planId === v.planId && v.approval.version === 1 && v.approval.planHash === KTAiConversation.planHashOf(v) && v.approval.baseStamp.fingerprint === 'fp-1' && !('customizeRevision' in v.approval) && v.approval.candidates.C1 === v.generated.C1.candidateHash && v.approval.approvedAt, `R16-1: 承認レコード: ${JSON.stringify(v.approval)}`);
  assert(x.c.approvalValid().ok === true && KTAiConversation.approvalValid(v, { baseStamp: { fingerprint: 'fp-1' } }).ok && !x.c.messages().some(m => m.data?.kind === 'approved'), 'R16-2: 承認は有効（同じ基準）。承認だけの通知は出さない（簡素化 2026-10-17: 承認と反映は［動作テスト環境へ反映］1 回の操作）');
  assert(KTAiConversation.approvalValid(v, { baseStamp: { fingerprint: 'fp-2' } }).reason === 'BASE_CHANGED', 'R16-3: 基準の設定（stamp）が変われば無効');
  const html = finalHtml(x);
  assert(/承認済み。/.test(html) && !/data-act="final-approve"/.test(html), 'R16-4: 承認後のカードは「承認済み」（ボタンは消える）');
  await x.c.send('一覧の名前は承認待ちにして');
  const v2 = x.c.activePlan();
  assert(v2.version === 2 && !v2.approval && x.c.approvalValid().reason === 'NOT_APPROVED' && KTAiConversation.approvalValid(v).reason === 'SUPERSEDED', `R16-5: 新しい版には承認を引き継がない（古い版は置き換わり）: ${x.c.approvalValid().reason}`);
  x.c.approveFinal({ planId: v2.planId, version: v2.version });
  const a2 = JSON.parse(JSON.stringify(v2.approval));
  v2.generated.C1 = { ...v2.generated.C1, candidateHash: 'ffffffffffffffff' };
  assert(KTAiConversation.approvalValid(v2).reason === 'CANDIDATE_CHANGED', 'R16-6: 候補の hash が変わった（再生成）→ 無効');
  v2.generated.C1 = { ...v2.generated.C1, candidateHash: a2.candidates.C1 };
  v2.plan.assessment.summary = '変えた';
  assert(KTAiConversation.approvalValid(v2).reason === 'PLAN_CHANGED', 'R16-7: 計画の中身が変わった → 無効');
  v2.plan.assessment.summary = '承認待ちでは金額を編集不可にします。';
  //   R16-8（customize の revision の照合 REVISION_CHANGED）は 2026-10-17 に削除した（承認の後のカスタマイズの変更は R16-3 の基準の指紋で止まる）
  assert(KTAiConversation.approvalValid(v2).ok, '前提: 戻せば有効');
  x.c.markStale('取り直しで設定の違いを見つけました。');
  assert(!v2.approval && x.c.messages().some(m => m.data?.kind === 'approval-revoked') && v2.status === 'STALE', 'R16-9: 動作テスト環境の基準が変わったら承認を外す（markStale）');
});
// ---- R21: 確認済みの範囲を正しく伝える（機械検査 / 必須の動作 / 動作テスト（隔離環境の模擬）/ 実機は未確認） ----
await section(async () => {
  const x = makeConvC();
  await adoptC(x);
  const v = x.c.activePlan(), fin = v.final;
  const html = rightOf(x), text = stripC(html);   // 2026-10-14: 検証の区分は右の「変更内容」の「確かめたこと」の明細
  assert(/機械検査: 生成工程の検査 3 項目・Toolkit の形式確認 \d+ 項目/.test(text) && /業務上の動作の確認ではありません/.test(text) && /必須の動作（1 件）/.test(text) && /✓ 「金額」（PC）: 編集できない — 処理あり・模擬テストで合格/.test(text) && /模擬テスト（代表条件 2 件）: 合格 2・不合格 0・実行できない 0/.test(text) && /実機は未確認です。/.test(text) && /動作テスト環境で確かめること/.test(text), `R21-1: 検証の区分を分けて出す（機械検査・必須の動作・動作テスト・実機は未確認）: ${(text.match(/検証の区分[\s\S]{0,400}/) || [''])[0]}`);
  assert(!/動作確認済み/.test(html) && !/実機で確認済み/.test(html) && !/検査を通過しています（動作は未確認）/.test(html), 'R21-2: 機械検査の通過を「動作確認済み」「実機で確認済み」とは書かない');
  assert(fin.verification.howTo.length >= 1 && fin.verification.howTo.length <= 4 && fin.verification.howTo.every(s => /動作テスト環境|保存/.test(s)) && v.generated.C1.review.registration.unverified.some(u => u.code === 'BEHAVIOR_VERIFIED' && /実機（動作テスト環境）では未確認/.test(u.message)) && !v.generated.C1.review.registration.unverified.some(u => u.code === 'RUNTIME_NOT_RUN'), `R21-3: 実機で確かめることは 1〜4 行・登録の未確認は「生成工程の模擬テストで確認（実機は未確認）」: ${JSON.stringify(fin.verification.howTo)}`);
  assert((html.match(/data-qkey=/g) || []).length === 0, 'R21-4: 利用者に内部の項目を答えさせない（回答欄は残る判断だけ）');
});
// ---- C3b: 待ち時間の体験（偽の時計で経過と段階の遷移・目安の保存と読み戻し・完了後にカードが消える・AI の説明の逐次表示） ----
await section(async () => {
  const storage = makeStorage();
  const pg = gateMk();
  const x = makeConvC({ planGate: pg, storage });
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) await x.c.send(s);
  const p = x.c.send('おすすめで。この案で進めて');
  await ticks(6);
  const pm = x.c.progress();
  const lastM = x.last();
  assert(pm && lastM.type === 'LOADING' && lastM.data.kind === 'progress' && pm.title === 'この案で最終案を作っています' && pm.stages.map(s => `${s.key}:${s.state}`).join(',') === 'plan:active,summarize:todo', `C3b-1: 進みの 1 枚カード（計画 → まとめ。生成の段階は計画ができてから足す）: ${JSON.stringify(pm && pm.stages.map(s => [s.key, s.state]))}`);
  let html = KTAiChatUi.progressInnerHtml(lastM);
  //   §0f.5 の 3（2026-10-09）: 見出しは経過だけ。段階の平均から残り時間を推定しない（「残り時間は未推定」。根拠の無い「目安 約 N 秒」は出さない）
  assert(/最終案を作っています（経過 0:03）/.test(html) && /残り時間は未推定/.test(html) && !/目安|約\s*[0-9]+\s*(秒|分)/.test(html) && /● 計画を作っています（経過 3 秒）/.test(html) && (html.match(/kintone にはまだ何も反映していません/g) || []).length === 1 && /○ まとめ/.test(html) && /見ている設定: ステータス 3 件・通知 0 件・既存の JavaScript 0 ファイル/.test(html) && /質問はいまでも並行して答えます。追加の指示は、できあがった最終案に入れます/.test(html), `C3b-2: 見出し（経過と「残り時間は未推定」。目安は出さない）・段階の一覧・見ている材料・待っている間にできることの案内:${html.replace(/<[^>]*>/g, '｜')}`);
  assert(/AI の説明/.test(html) && /kt-ai-streaming/.test(html) && /承認待ちの間だけ金額を/.test(html) && x.calls.plan[0].onText === true, 'C3b-3: 計画の AI の説明（reply）を SSE で先に流す（能力 stream: reply があるとき onText を渡す）');
  x.advance(5000); x.c.tickProgress();
  html = KTAiChatUi.progressInnerHtml(x.last());
  assert(/経過 0:08/.test(html) && /計画を作っています（経過 8 秒）/.test(html) && x.c.messages().filter(m => m.type === 'LOADING').length === 1, `C3b-4: 1 秒ごとの描き直し（偽の時計で 3 秒 → 8 秒）: ${html.replace(/<[^>]*>/g, '｜').slice(0, 120)}`);
  pg.open(); await p; await ticks(8);
  assert(!x.c.messages().some(m => m.type === 'LOADING') && x.c.progress() === null && x.finals().length === 1, 'C3b-5: 完了したら進みのカードは最終案のカードに置き換わり、記録には残らない');
  const saved = JSON.parse(storage.getItem('ktAi.timing.v1'));
  assert(saved && saved.plan && saved.plan.n === 1 && saved.plan.avg === 35000 && saved.generate && saved.generate.avg === 20000 && !saved.sim && saved.summarize, `C3b-6: 段階ごとの実測を目安として保存（計画 35 秒・生成と検証 20 秒。模擬の段階は無い）: ${JSON.stringify(saved)}`);
  const pg2 = gateMk();
  const y = makeConvC({ planGate: pg2, storage });
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) await y.c.send(s);
  const p2 = y.c.send('おすすめで。この案で進めて'); await ticks(6);
  { const h7 = KTAiChatUi.progressInnerHtml(y.last());
    assert(/最終案を作っています（経過 0:03）/.test(h7) && /残り時間は未推定/.test(h7) && !/目安|約\s*[0-9]+\s*(秒|分)/.test(h7), `C3b-7: 2 回目も、保存した実測（計画 35 秒）から残り時間を推定しない（「残り時間は未推定」。実測は記録に残す: C3b-8）: ${h7.replace(/<[^>]*>/g, '｜').slice(0, 80)}`); }
  pg2.open(); await p2; await ticks(8);
  const prAfter = JSON.parse(storage.getItem('ktAi.timing.v1'));
  assert(prAfter.plan.n === 2 && prAfter.plan.avg === 32500, `C3b-8: 実測が溜まるほど平均に近づく（件数 2。1 回目 35 秒・2 回目 30 秒 → 平均 32.5 秒）: ${JSON.stringify(prAfter.plan)}`);
  const z = makeConvC({ storage: makeStorage() });
  const gateP = gateMk();
  const propose0 = z.services.propose;
  z.services.propose = async (args) => { const onText = args.onText; if (onText) onText('課長と部長を申請ごとに'); await gateP.p; return propose0({ ...args, onText: null }); };
  const p3 = z.c.send('課長・部長の承認者を選ぶ運用にしたい'); await ticks(4);
  const ph = KTAiChatUi.progressInnerHtml(z.last());
  assert(z.last().type === 'LOADING' && z.last().data.kind === 'progress' && /仮案を考えています（経過 0:00）/.test(ph) && /残り時間は未推定/.test(ph) && !/目安|約\s*[0-9]+\s*(秒|分)/.test(ph) && /● 仮案を考えています（経過/.test(ph) && !/考える中/.test(ph) && /仮案への返事や追加の指示は、仮案ができてから送ってください/.test(ph) && !/最終案に入れます/.test(ph) && /kt-ai-streaming/.test(ph) && /課長と部長を申請ごとに/.test(ph), `C3b-9: 仮案の間も同じ形（経過と「残り時間は未推定」・reply の逐次表示）:${ph.replace(/<[^>]*>/g, '｜').slice(0, 160)}`);
  gateP.open(); await p3; await ticks(4);
  assert(!z.c.messages().some(m => m.type === 'LOADING') && z.c.draft() && z.c.draft().rev === 1, 'C3b-10: 仮案ができたらカードは消える');
  // これから確かめる条件の予告: 生成工程の結果が届く前は必須の効果の一覧（○）、届いたら代表条件ごとの結果（✓ / ×）。最終案の検証の区分にそのまま使う
  const gs = gateMk();
  const w = makeConvC({ generate: makeGenerate({ sequence: ['good'], gate: gs }) });
  const p4 = adoptC(w); await ticks(12);
  const prW = w.c.progress();
  const phW = prW ? KTAiChatUi.progressInnerHtml(w.last()) : '';
  assert(prW && prW.stages.find(s => s.key === 'generate') && prW.stages.find(s => s.key === 'generate').state === 'active' && !prW.stages.some(s => s.key === 'sim') && prW.checklist.length === 1 && prW.checklist.every(c => c.state === 'todo') && /これから確かめる条件（生成工程の模擬テスト）/.test(phW) && /○ 「金額」: 編集できない/.test(phW) && /「JavaScript」を作っています/.test(phW), `C3b-11（2026-10-14: 生成の段階の名前は計画の手順の title）: 必須の効果のチェックリストを先に出す（○。模擬の段階は無い）: ${JSON.stringify(prW && prW.checklist)} ${phW.replace(/<[^>]*>/g, '｜').slice(0, 200)}`);
  gs.open(); await p4; await ticks(8);
  const vw = w.c.activePlan();
  assert(vw.final.verification.behavior.cases.length === 2 && vw.final.verification.behavior.cases.every(c => c.verdict === 'pass') && /「金額」: 編集できない/.test(vw.final.verification.behavior.cases[0].label) && /「金額」: 編集できる/.test(vw.final.verification.behavior.cases[1].label), `C3b-12: 結果が出たら代表条件ごとの結果になり、最終案の検証の区分にそのまま使う: ${JSON.stringify(vw.final.verification.behavior.cases)}`);
  const pgR = { p: Promise.resolve() };
  const rv = makeConvC({ planGate: pgR });
  await adoptC(rv);
  const gR = gateMk(); pgR.p = gR.p;
  const pRv = rv.c.send('一覧の名前は承認待ちにして'); await ticks(6);
  const hR = KTAiChatUi.progressInnerHtml(rv.last());
  assert(rv.c.progress() && rv.c.progress().title === '最終案を直しています' && /● 計画を修正中/.test(hR) && /○ まとめ/.test(hR) && /AI の説明/.test(hR) && /承認待ちの間だけ金額を/.test(hR) && rv.calls.plan[1].revision === true && rv.calls.plan[1].onText === true && rv.c.messages().filter(m => m.type === 'LOADING').length === 1, `C3b-13: 差分更新も進みの 1 枚カード（計画を修正 → まとめ）と AI の説明の逐次表示: ${hR.replace(/<[^>]*>/g, '｜').slice(0, 160)}`);
  gR.open(); await pRv; await ticks(8);
  assert(rv.c.progress() === null && !rv.c.messages().some(m => m.type === 'LOADING') && rv.c.activePlan().version === 2 && rv.finals().length === 2, 'C3b-14: 差分更新の最終案ができたらカードは消える（記録に残さない）');
  const rf = makeConvC({ planImpl: (args) => (args.revision ? { plan: null, message: '計画を作れませんでした（テスト）', reason: 'TEST' } : planJs(args)) });
  await adoptC(rf);
  await rf.c.send('一覧の名前は承認待ちにして');
  assert(rf.c.progress() === null && !rf.c.messages().some(m => m.type === 'LOADING') && rf.c.messages().some(m => m.type === 'ERROR'), 'C3b-15: 差分更新の失敗では進みのカードを片づけ、失敗のカードだけ出す');
});
// ---- 画面: 最終案のカードの［この内容で反映する］→ 承認（偽 client。計画は設定の手順だけ）----
await section(async () => {
  const m = mount();
  await ticks();
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) { await m.panel.send(s); await ticks(8); }
  await m.panel.send('おすすめで。この案で進めて'); await ticks(14);
  const v = m.conv().activePlan();
  assert(v && v.final && m.msgs().some(x => x.type === 'FINAL') && /kt-ai-final-card/.test(m.chat()) && !/kt-ai-plan-card/.test(m.chat()) && /data-act="final-approve"/.test(m.chat()), `画面-1: 採用 → 最終案のカード（設定の手順だけの計画でも 1 枚）: ${JSON.stringify(m.msgs().map(x => x.data?.kind || x.type))}`);
  assert(/data-status="ready">未反映</.test(m.$('kt-ai-ws-state').innerHTML) && !m.$('kt-ai-spec').innerHTML.includes('confirm-spec'), '画面-2: 右の見出しは「未反映」。仕様カードに［この仕様で確定］は無い');
  const e0 = await m.panel.startExecutor(); await ticks(2);
  assert(e0 === null && m.msgs().some(x => x.data?.kind === 'approval-required'), `画面-2b: 承認の前は反映の準備をしない: ${JSON.stringify(m.msgs().slice(-1).map(x => [x.data?.kind, x.text]))}`);
  //   §0e.1（2026-10-09）: 承認の欄の準備（書き込みなし）が終わると押せる。［動作テスト環境へ反映］1 回で承認（準備の結果の指紋つき）と反映
  const r3 = await KIT.applyOnScreen(m);
  assert(r3.pre.status === 'ready' && r3.pre.items.settings.length === 1 && r3.button && r3.button.label === '動作テスト環境へ反映' && !r3.button.disabled && v.approval && v.approval.precheck && v.approval.precheck.fingerprint && v.approval.precheck.fingerprint.settings && /承認済み。/.test(m.chat()) && !m.msgs().some(x => x.data?.kind === 'approved') && r3.cardCount === 1, `画面-3: ［動作テスト環境へ反映］→ 承認レコード（承認の欄の準備の指紋つき）と反映を 1 回で（承認の通知は出さず結果のカード 1 枚）: ${JSON.stringify(v.approval && Object.keys(v.approval))}`);
  assert(r3.run.ok && r3.exec.execution.steps.some(st => st.stepId === 'P1' && st.status === 'VERIFIED') && JSON.stringify(r3.writes) === '["PUT views"]', `画面-3b: 承認の後は手順が承認済みのまま反映（手順ごとに承認し直さない）: ${JSON.stringify(r3.exec.execution && r3.exec.execution.steps.map(st => st.status))}`);
  //   承認の後に計画が変わったら承認し直し（R16）: 反映していない承認（承認の記録）で確かめる
  const m2 = mount();
  await ticks();
  const v21 = await KIT.adoptOnScreen(m2); await ticks(6);
  assert(m2.conv().approveFinal({ planId: v21.planId, version: v21.version }).ok, '前提: 承認の記録');
  await m2.panel.send('一覧の名前は承認待ちにして'); await ticks(10);
  assert(m2.conv().activePlan().version === 2 && !m2.conv().activePlan().approval && m2.conv().approvalValid().reason === 'NOT_APPROVED', '画面-4: 承認の後に計画が変わったら、新しい版は承認し直し（R16）');
  const n0 = m2.msgs().filter(x => x.data?.kind === 'approval-required').length;
  const e2 = await m2.panel.startExecutor(); await ticks(2);
  assert(e2 === null && m2.msgs().filter(x => x.data?.kind === 'approval-required').length === n0 + 1 && KIT.writesOf(m2).length === 0, '画面-5: 新しい版は承認し直すまで反映の準備をしない');
});

// ---- 段階 C-1 の反証レビュー（指示との一致 A1〜A7・B1〜B7 / 正しさ C1〜C5）の回帰 ----
// 指示 A1 / 追加指示 §4（e）: 採用直後の計画作成中の指示 → 最終案は 1 回だけ（生成も 1 回）。待ちの表示は進みのカード 1 枚
await section(async () => {
  const pg = gateMk();
  const x = makeConvC({ planGate: pg });
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) await x.c.send(s);
  const p = x.c.send('おすすめで。この案で進めて'); await ticks(6);
  const rq = await x.c.send('通知は外して');
  const plan0 = x.services.plan;
  let loadingsAtRevise = null, stagesAtRevise = null;
  x.services.plan = async (args) => { if (args.revision) { loadingsAtRevise = x.c.messages().filter(m => m.type === 'LOADING').map(m => m.data?.kind || m.text); stagesAtRevise = x.c.progress() && x.c.progress().stages.map(s => `${s.key}:${s.state}`).join(','); } return plan0(args); };
  pg.open(); await p; await ticks(20);
  const tm = x.c.metrics().timings.slice(-1)[0];
  assert(rq && rq.queued === true && x.finals().length === 1 && x.calls.plan.length === 2 && x.gen.calls.length === 1 && JSON.stringify(loadingsAtRevise) === '["progress"]' && /revise:active/.test(stagesAtRevise || '') && tm.calls.map(k => k.kind).join(',') === 'plan,plan,generate', `指示 A1: 計画作成中の指示 → 指示を入れた計画で最終案を 1 回だけ作る（承認できるカードは 1 枚・待ちの表示は進みのカード 1 枚）: ${JSON.stringify({ finals: x.finals().length, gen: x.gen.calls.length, loadings: loadingsAtRevise, stages: stagesAtRevise, calls: tm.calls.map(k => k.kind) })}`);
  //   2026-10-14 の設計し直し（指示書 §1.3）: 採用直後の別の文は出さない（見出しは進みのカード。JavaScript の有無による見出しは ai-human-readable §H2）
  assert(!x.c.messages().some(m => m.data?.kind === 'draft-adopted') && !x.c.messages().some(m => /この案で進めます/.test(String(m.text || ''))), '指示 B7: 採用直後の別の文「この案で進めます…」は出さない（進みのカードの見出しに吸収）');
  // 追加指示 §4（e）: 最終案の生成中に 2 つの指示 → 生成は 1 回・最終案は 2 枚（最初の版と、指示をまとめた版）・古い版で新しい版を上書きしない
  const g2 = gateMk();
  const y = makeConvC({ generate: makeGenerate({ sequence: ['good'], gate: g2 }) });
  const py = adoptC(y); await ticks(10);
  await y.c.send('通知は外して'); await y.c.send('一覧の名前は承認待ちにして');
  g2.open(); await py; await ticks(16);
  const vy = y.c.activePlan();
  assert(y.gen.calls.length === 1 && y.finals().length === 2 && vy.version === 2 && y.calls.plan.length === 2 && /通知は外して/.test(y.calls.plan[1].request) && /一覧の名前は承認待ちにして/.test(y.calls.plan[1].request) && y.c.planHistory().filter(v => v.final).length === 2 && y.c.planHistory()[0].status === 'SUPERSEDED', `追加指示 §4（e）: 生成中の 2 つの指示は 1 回の差分更新にまとめ、最終案の重複生成と古い版の上書きをしない: ${JSON.stringify({ gen: y.gen.calls.length, finals: y.finals().length, version: vy.version, plans: y.calls.plan.length })}`);
});
// 指示 A2: Toolkit が生成できない customization（外部連携）は実現できない点・反映先に出し、承認できない
await section(async () => {
  const CUST_EXT = { ...CUST_C1, requirement: '承認されたら Slack に通知する', implementation: 'EXTERNAL_INTEGRATION', apis: ['kintone.proxy'], fields: [{ code: 'ステータス', access: 'READ' }], events: ['app.record.detail.process.proceed'] };
  const x = makeConvC({ planImpl: (args) => { const r = planJs(args, { cust: CUST_EXT, summary: '承認されたら Slack に通知します。' }); r.review.steps[0].codeGeneration = { supported: false, strategy: 'NEW_JS_FILE', reason: '外部連携のコードは Toolkit では生成しません' }; return r; } });
  await adoptC(x);
  const v = x.c.activePlan(), html = stripC(finalHtml(x));
  assert(x.gen.calls.length === 0 && v.final.approvable === false && v.final.cannot.some(c => c.kind === 'unsupported' && /Slack に通知する/.test(c.text) && /外部連携のコードは Toolkit では生成しません/.test(c.text)) && /Toolkit では作れない JavaScript/.test(html) && !/JavaScript は無く、設定の変更だけです/.test(html) && /最終案（反映できない点があります）/.test(html) && x.c.approveFinal({ planId: v.planId, version: v.version }).ok === false, `指示 A2: 生成できない customization を「設定の変更だけ」として承認させない: ${JSON.stringify(v.final.cannot)}`);
});
// 指示 A3: 決まった要件が増えたら、JavaScript を流用せずに作り直す（計画の AI が customization を変えなくても）
await section(async () => {
  const x = makeConvC();
  await adoptC(x);
  x.planImpl = (args) => { const r = planJs(args); if (args.revision && /^承認済みでも/.test(args.revision.request)) r.turn = { ...r.turn, requirementOps: [{ op: 'add', target: '金額', condition: '承認済み', behavior: '編集不可にする', exceptions: [], decision: 'decided', disposition: 'adopted', sourceQuotes: ['承認済みでも金額は編集不可にして'], planRefs: [], effects: ['lock'], note: '' }] }; return r; };
  await x.c.send('承認済みでも金額は編集不可にして');
  const v2 = x.c.activePlan();
  //   簡素化 C（2026-10-16）: 計画が手順・JavaScript に対応づけていない決まった要件（planRefs []）は「担当なし」で止めず、自動の見直しも呼ばない（確認の限界。右に件数の 1 行）。
  //   C1 が同じ編集不可（承認待ち）を持つだけでは、この要件（承認済み）の実現にしない（対応づけが無いと、生成の検証にこの要件の効果が渡らない）。作り直しはそのまま
  const r5 = x.c.requirements(v2.planId).find(r => r.condition === '承認済み' && r.behavior === '編集不可にする');
  assert(!!r5 && v2.version === 2 && x.calls.plan.length === 2 && x.gen.calls.length === 2 && v2.generated.C1.reused !== true && v2.final.approvable === true && !v2.final.blockers.some(b => b.kind === 'ownerless') && (v2.final.unconfirmedReqs || []).some(u => u.requirementId === r5.id) && /計画の構造からは実現を確かめていない要件が 1 件あります/.test(stripC(rightOf(x))),
    `指示 A3: 決まった要件（計画に対応づけていない）が増えた → 自動の見直しはせず、全部の JavaScript を作り直す（前の検証結果を流用しない）。その要件は確認の限界: ${JSON.stringify({ version: v2.version, plans: x.calls.plan.length, gen: x.gen.calls.length, reused: v2.generated.C1.reused, approvable: v2.final.approvable, unconf: (v2.final.unconfirmedReqs || []).map(u => u.requirementId) })}`);
  const y = makeConvC();
  await adoptC(y);
  await y.c.send('通知は外して');
  assert(y.gen.calls.length === 1 && y.c.activePlan().generated.C1.reused === true, '指示 A3: 決まっていない指示だけでは作り直さない（R11）');
});
// 指示 A7: 実行できない手順（BLOCKED）があれば承認できない / B6: 残る判断は先に決めたいことだけ
await section(async () => {
  const y = makeConvC({ planImpl: (args) => { const r = planJs(args); r.plan.steps.unshift({ id: 'P1', actionType: 'ADD_FIELD', targetKind: 'FIELD', targetRef: 'x', title: 'フィールド追加', spec: {}, dependsOn: [] }); r.review.steps.unshift({ stepId: 'P1', status: 'INVALID', safety: 'BLOCKED', issues: [{ code: 'X', message: 'フィールドの型が指定されていません' }] }); r.review.executionReadiness = { safeSteps: [], reviewSteps: [], blockedSteps: ['P1'], planOnlySteps: ['C1'] }; return r; } });
  await adoptC(y);
  const vy = y.c.activePlan();
  assert(vy.final.approvable === false && vy.final.blockedSteps.length === 1 && vy.final.cannot.some(c => c.kind === 'blocked' && /実行できない手順: フィールド追加（フィールドの型が指定されていません）/.test(c.text)) && /実行できない設定の手順が 1 件/.test(vy.final.blockingReason), `指示 A7: 実行できない手順があれば承認できない（手順の名前と理由）: ${JSON.stringify(vy.final.cannot)}`);
  const Qs = [{ id: 'Q1', question: '承認待ちの間、申請者本人も編集できなくしますか', topic: 'scope', priority: 'blocking', options: ['全員', '申請者以外'] }, ...['灰色の表示色は既定のままでよいですか', 'モバイルでも同じ制御にしますか', 'CSV 読み込みでも止めますか', '一覧の編集でも止めますか'].map((q, i) => ({ id: `Q${i + 2}`, question: q, topic: `t${i}`, priority: 'later', options: [] }))];
  const x = makeConvC({ planImpl: (args) => planJs(args, { questions: Qs }) });
  await adoptC(x);
  const html = finalHtml(x);
  assert((html.match(/kt-ai-qa-input/g) || []).length === 1 && /残る判断（1 件）/.test(html) && /後で決めてよいことが 4 件あります/.test(html) && !/モバイルでも同じ制御にしますか/.test(html), `指示 B6: 最終案のカードの回答欄は先に決めたいことだけ: ${(stripC(html).match(/残る判断[^\n]*/) || [])[0]}`);
});
// 指示 B1 / B2 / 追加指示 §4（f）: 最終案までの時間は採用から（内訳より短くならない）。測っていない段階は 0 秒と出さない
await section(async () => {
  const storage = makeStorage();
  const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], repairs: 1 }), storage });
  await adoptC(x);
  const tmg = x.c.activePlan().final.timing;
  assert(tmg.totalMs >= tmg.planMs + tmg.generateMs && tmg.totalMs === x.c.metrics().timings.slice(-1)[0].finalMs, `指示 B1: 最終案までの時間 ≧ 内訳の合計（採用から。finalMs と同じ起点）: ${JSON.stringify(tmg)}`);
  const saved = JSON.parse(storage.getItem('ktAi.timing.v1'));
  assert(saved.generate.n === 1 && saved.generate.avg === 20000 && !saved.sim, `指示 B2: 生成と検証の目安は 1 件 1 回: ${JSON.stringify(saved)}`);
  // 生成が無い最終案（設定の手順だけ・生成できない）: 生成の時間は「0 秒」と出さない
  const CUST_EXT = { ...CUST_C1, implementation: 'EXTERNAL_INTEGRATION', fields: [{ code: 'ステータス', access: 'READ' }] };
  const y = makeConvC({ planImpl: (args) => { const r = planJs(args, { cust: CUST_EXT }); r.review.steps[0].codeGeneration = { supported: false, strategy: 'NEW_JS_FILE', reason: '外部連携のコードは Toolkit では生成しません' }; return r; } });
  await adoptC(y);
  const ty = y.c.activePlan().final.timing, hy = stripC(finalHtml(y));
  assert(ty.generateMs === null && ty.planMs === 30000 && /最終案まで 30 秒（計画 30 秒）/.test(hy) && !/生成・検証 0 秒|模擬 0 秒|生成 0 秒/.test(hy), `追加指示 §4（f）: 測っていない段階（生成）は 0 秒と出さない: ${JSON.stringify(ty)} ${(hy.match(/最終案まで[^\n]*/) || [''])[0]}`);
});
// 指示 B4: 生成に失敗したときのカード / B7: 「まだ何も反映していません」は 1 回・トークン・保存の行
await section(async () => {
  const x = makeConvC({ generate: { calls: [], impl: async () => ({ ok: false, reason: 'UPSTREAM_ERROR', message: 'AI の応答を取得できませんでした（UPSTREAM_ERROR）' }) } });
  await adoptC(x);
  const h = stripC(finalHtml(x)), hr = stripC(rightOf(x));
  assert(/最終案（反映できない点があります）/.test(h) && !/最終案ができました。/.test(h) && !/新しい JavaScript「」/.test(h + hr) && /生成できなかったため、ファイルはまだありません/.test(hr) && /機械検査: 実行できませんでした/.test(hr) && !/検査 0 項目/.test(h + hr), `指示 B4: 生成の失敗 → 見出しを分ける・ファイル名が空の行を出さない・検査 0 項目と言わない: ${h.replace(/\n+/g, ' ⏎ ').slice(0, 400)}`);
  const y = makeConvC();
  await adoptC(y);
  const hy = finalHtml(y);
  assert((hy.match(/まだ何も反映していません/g) || []).length === 0 && !/token/.test(hy) && !y.c.activePlan().final.verification.howTo.some(s => /保存/.test(s)), `指示 B7（2026-10-14: 最終案のカードには出さず、進みのカードの案内行に 1 回）: 「まだ何も反映していません」は 0 回・英語の token を出さない・編集制限の JavaScript では保存の確認の行を出さない: ${JSON.stringify(y.c.activePlan().final.verification.howTo)}`);
});
// 指示 B5: 対応範囲の重複と矛盾（担当が計画に無い要件は 1 行・「ほかの手順で扱います」と言わない）
await section(async () => {
  //   2026-10-15（追加の指示 1: 仮案の採用を実装担当の代わりにしない）: R4（申請から 7 営業日以内に承認）の planRefs は採用した仮案の項目 A3 だけで、計画（承認待ちの金額の編集不可の
  //   JavaScript C1）にこの期限を実現する手順・JavaScript は無い。計画の AI はほかの要件（R1〜R3）を C1 に対応づけ、R4 は対応づけない。生成の AI は R4 を担当外と申告する。
  //   採用の記録（A3）は実現の証拠にしない。簡素化 C（2026-10-16）: 以前は「7 営業日」を実現する手順・JavaScript が足りない決まった要件として反映を止め、自動の見直しを 1 回起こした。
  //   期限は今のプロセス管理・通知の設定で満たしていることがあり、構造からは区別できないので止めない・自動の見直しもしない。生成の AI の担当外の申告は、計画全体で扱う要件の確認
  //   （plan-scope。反映は止めない）として右の「確認できないこと」に 1 回出し、同じ要件を確認の限界の件数の行に重ねない。「ほかの手順で扱います」とは言わない。
  //   検査に担当の集まりを渡さない（この修正の前の検査の結果を流用した）ときと、渡したときで同じ
  for (const withOwners of [false, true]) {
    const gen = makeGenerate({ sequence: ['good'] });
    const impl0 = gen.impl;
    gen.impl = async (args) => { const r = await impl0(args); r.generated = { ...r.generated, coverage: [{ requirementId: 'C1', status: 'MET', note: '', text: CUST_C1.requirement }, { requirementId: 'R4', status: 'OUT_OF_SCOPE', note: '期限はプロセス管理と通知の設定で扱う', text: '7 営業日以内に承認する' }] }; r.review = KTCodeReview.review({ generated: r.generated, customization: CUST_C1, plan: args.version.plan, data: clone(DATA_C), scan: null, existingSource: null, requirements: [{ id: 'R4', planRefs: ['A3'] }], ...(withOwners ? { planOwners: args.planOwners } : {}) }); return r; };
    const x = makeConvC({ generate: gen, autoMap: false, planImpl: (args) => KIT.withPlannerMapping(planJs(args), (args.requirements || []).filter(q => !/営業日/.test(q.behavior || ''))) });
    await adoptC(x);
    const v = x.c.activePlan(), fin = v.final;
    const h = stripC(finalHtml(x)), hr = stripC(rightOf(x));
    const line = '「7 営業日以内に承認する」は、作った JavaScript では担当外とされました。計画のどの手順で実現するかは書かれていません';
    const r4 = x.c.requirements(v.planId).find(r => /営業日/.test(r.behavior));
    assert(r4 && JSON.stringify(r4.planRefs) === '["A3"]' && x.c.requirements(v.planId).filter(r => r.id !== r4.id && r.decision !== 'revoked').every(r => (r.planRefs || []).includes('C1')) && fin.approvable === true
      && !fin.blockers.some(b => b.kind === 'ownerless') && fin.blockers.filter(b => b.kind === 'plan-scope').length === 1 && fin.blockers.some(b => b.kind === 'plan-scope' && b.text === line && b.requirementId === r4.id && /この点では反映を止めていません/.test(b.next))
      && !(fin.unconfirmedReqs || []).some(u => u.requirementId === r4.id) && (hr.match(new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length === 1
      && !/計画の他の手順・JavaScript で扱います|計画の構造からは実現を確かめていない要件/.test(h + hr) && x.calls.plan.length === 1,
      `指示 B5（簡素化 C: 実現する手順が無い採用済みの要件は止めず、生成の AI の担当外の申告を右に 1 回。自動の見直しなし）${withOwners ? '・検査に担当の集まりを渡す' : '・前の検査の結果'}: ${JSON.stringify({ blockers: fin.blockers, approvable: fin.approvable, plans: x.calls.plan.length })}`);
  }
});
// 正しさ C4 / C3（会話）: 計画の後に基準が変わったら承認せず STALE に（作り直しを案内）。承認の取り消し
await section(async () => {
  const x = makeConvC();
  await adoptC(x);
  const v = x.c.activePlan();
  const r = x.c.approveFinal({ planId: v.planId, version: v.version, baseStamp: { fingerprint: 'fp-2' } });
  assert(r.ok === false && r.reason === 'BASE_CHANGED' && !v.approval && v.status === 'STALE' && /作り直してください/.test(r.message) && x.c.messages().some(m => m.data?.kind === 'stale'), `正しさ C4: 計画を作った後に基準が変わった → 承認せず計画を STALE にして作り直しを案内: ${JSON.stringify(r)}`);
  const y = makeConvC();
  await adoptC(y);
  const vy = y.c.activePlan();
  const ok = y.c.approveFinal({ planId: vy.planId, version: vy.version, baseStamp: { fingerprint: 'fp-1' } });
  assert(ok.ok && vy.approval.baseStamp.fingerprint === 'fp-1' && Array.isArray(vy.approval.confirmations.C1), '正しさ C2: 承認に、そのときの確認の項目（customization ごと）を記録する');
  assert(KTAiConversation.approvalValid(vy, { baseStamp: { revision: '10' } }).reason === 'BASE_UNKNOWN', '指示 C2: 承認に基準の指紋があるのに今の指紋が取れなければ、照合を黙って飛ばさない');
  assert(y.c.revokeApproval(vy, '設定の手順が途中で止まりました。') === true && !vy.approval && y.c.messages().some(m => m.data?.kind === 'approval-revoked'), '正しさ C3: 承認の取り消し（設定の手順が止まったとき画面が呼ぶ）');
});
// 正しさ C5: 同じ platform の他の既存 JS・設定・計画の新設（動作テストの環境の指紋）が変われば流用しない
await section(async () => {
  const z = makeConvC();
  let env = 'env-1';
  z.services.simEnvKey = async () => env;
  await adoptC(z);
  await z.c.send('一覧の名前は承認待ちにして');
  assert(z.gen.calls.length === 1 && z.c.activePlan().generated.C1.reused === true, '前提: 環境の指紋が同じなら流用する');
  env = 'env-2';
  await z.c.send('一覧の並びは申請日の順にして');
  assert(z.gen.calls.length === 2 && z.c.activePlan().generated.C1.reused !== true, `正しさ C5: 環境の指紋が変わった → 流用せず作り直して検証し直す: ${z.gen.calls.length}`);
});
// 正しさ C3（画面）: 設定の手順が途中で止まったら、承認の基準を進めず承認を外す
await section(async () => {
  const m = mount();
  await ticks();
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) { await m.panel.send(s); await ticks(8); }
  await m.panel.send('おすすめで。この案で進めて'); await ticks(14);
  const v = m.conv().activePlan();
  const r = await KIT.applyOnScreen(m, { before: () => { m.mock.ctl.failPut = 'views'; } });
  assert(v.approval === undefined && m.msgs().some(x => x.data?.kind === 'approval-revoked') && r.exec.prepared && r.exec.prepared.status === 'PREPARED' && r.run.stage === 'stopped' && /設定の手順が途中で止まりました/.test(r.card) && !/動作テスト環境へ反映しました/.test(r.card), `正しさ C3: 設定の手順が止まったら承認を外す（結果のカードに止まったことと次の手）: ${JSON.stringify({ approval: !!v.approval, kinds: m.msgs().slice(-4).map(x => x.data?.kind || x.type) })}`);
});
// 指示 B7: 未解決のカードにコード片・フィールドコード・「候補」を出さない（生成工程の修復の上限で止まった最終案）。検査の文は詳細表示に
await section(async () => {
  const y = makeConvC({ generate: makeGenerate({ sequence: ['bad'], repairs: 2, stoppedBy: 'limit' }) });
  await adoptC(y);
  const full = finalHtml(y);
  const h = outsideDetails(full).replace(/<[^>]*>/g, '｜');
  assert(y.c.activePlan().final.approvable === false && !/record\[|\.disabled\s*=|（（/.test(h) && !/「amount」|\bamount\b/.test(h) && !/候補/.test(h) && /取り消/.test(full), `指示 B7: 未解決の理由・機械検査の行にコード片とフィールドコードを出さない（検査の文は詳細表示）: ${(h.match(/[^｜]*(record\[|amount|候補)[^｜]*/) || [''])[0]}`);
});

// =========================================================
console.log('\n--- §D. 段階 C-1 への追加指示（2026-10-08）§5 の回帰: 編集不可・警告・保存禁止を区別して引き継ぎ、未確認と不合格を混同しない ---');
const effectsSent = (x, n = 0) => (x.gen.calls[n] && x.gen.calls[n].requiredEffects ? [...new Set(x.gen.calls[n].requiredEffects.map(e => `${e.field}:${e.effect}`))].sort().join(',') : null);
// D1: 編集不可が必要、候補は警告だけ → 要件未達。承認・反映可能な最終案にしない（必須の効果は lock のまま渡し、警告に下げない）
await section(async () => {
  const x = makeConvC({ generate: makeGenerate({ sequence: ['warn'], repairs: 2, stoppedBy: 'limit' }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  assert(effectsSent(x) === 'amount:lock' && e.status === 'unresolved' && e.verdict.kind === 'missing' && /要件未達（「金額」: 編集できないようにする）/.test(e.verdict.reason), `D1-1: 編集不可が必要で候補は警告だけ → 要件未達（必須の効果は lock のまま）: ${JSON.stringify({ sent: effectsSent(x), verdict: e.verdict })}`);
  const ap = x.c.approveFinal({ planId: v.planId, version: v.version });
  assert(v.final.approvable === false && ap.ok === false && ap.reason === 'NOT_APPROVABLE' && !v.approval && x.gen.calls.length === 1, `D1-2: 承認できない（Toolkit から修復の再依頼もしない）: ${JSON.stringify(ap)}`);
  assert(e.review.status === 'BLOCKED' && e.review.registration.blockers.some(b => b.code === 'required-effects') && !e.review.registration.confirmations.some(c => c.code === 'required-effects'), 'D1-3: 形式確認でも登録不可（required-effects は「確認」ではない。確認を押して通せない）');
  const text = stripC(rightOf(x));
  assert(/× 「金額」（PC）: 編集できない — 処理なし（要件未達）/.test(text) && /disabled>動作テスト環境へ反映/.test(finalHtml(x)), `D1-4: 検証の区分に必須の動作の未達を出す: ${(text.match(/必須の動作[\s\S]{0,120}/) || [''])[0]}`);
});
// D2: 編集不可が必要、候補は値の変更だけ → 要件未達（編集不可と同一視しない）
await section(async () => {
  const x = makeConvC({ generate: makeGenerate({ sequence: ['value'] }) });
  await adoptC(x);
  const e = x.c.activePlan().generated.C1;
  assert(effectsSent(x) === 'amount:lock' && e.status === 'unresolved' && e.verdict.kind === 'missing' && x.c.activePlan().final.approvable === false, `D2: 編集不可が必要で候補は値の変更だけ → 要件未達: ${JSON.stringify(e.verdict)}`);
});
// D3: 警告だけ必要、候補は警告を出し編集・保存を許可 → この要件について合格。編集不可を追加要求しない（BFC / p21 の警告の回帰を警告の要件として維持）
await section(async () => {
  const CUST_W = { ...clone(RP.CUSTOMIZATION), fields: [{ code: 'amount', access: 'CONTROL', condition: RP.CUSTOMIZATION.fields[0].condition, effects: ['warn'] }] };
  const existing = { name: 'dealLock.js', target: 'desktop', text: RP.DEAL_LOCK };
  //   §5 の 3 行目（警告を出し編集・保存を許可する候補）を確かめるため、生成した AI の申告は MET にする（記録した BFC の候補の PARTIAL の申告は D3-4 で別に確かめる）
  const GEN_MET = () => { const g = KIT.gwModernized(RP.GENERATED); g.coverage = g.coverage.map(cv => ({ ...cv, status: 'MET' })); return g; };
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_W, summary: '金額が 100 万円を超えたら警告します（保存は止めません）。' }), generate: makeGenerate({ sequence: ['warn'], existingSource: existing, generatedOf: GEN_MET }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  assert(effectsSent(x) === 'amount:warn' && !x.gen.calls[0].requiredEffects.some(r => r.effect === 'lock'), `D3-1: 警告の要件は warn だけを渡す（編集不可を足さない）: ${effectsSent(x)}`);
  assert(e.status === 'verified' && v.final.approvable === true && e.review.status !== 'BLOCKED' && !e.review.checks.some(ch => /^sim-warning-only/.test(ch.name)), `D3-2: 警告を出し編集・保存を許可する候補は合格（承認できる）: ${JSON.stringify({ status: e.status, verdict: e.verdict, review: e.review.status, blocks: e.review.checks.filter(ch => !ch.ok && ch.severity === 'block').map(ch => ch.name) })}`);
  assert(v.final.verification.howTo.some(s => /保存/.test(s)), 'D3-3: 警告の要件では「保存は止まらない」ことを実機で確かめる行を出す（構造化した効果から）');
  // D3-4（§0c.6）: 同じ候補でも、生成した AI が警告の要件を PARTIAL と申告した（既存の処理が編集不可にしている間は警告しない）。
  //   簡素化 B（2026-10-17）: 以前は Toolkit が「必須の効果に結び付く要件の PARTIAL」を要件未達（登録不可）に上げていた（coverage-unmet・partialRequired）。
  //   今は生成工程の機械検査の coverage（review。自分の要件の PARTIAL）が承認の欄の確認事項にする（Toolkit は判定を作り直さない）。修復は依頼しない
  const y = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_W, summary: '金額が 100 万円を超えたら警告します（保存は止めません）。' }), generate: makeGenerate({ sequence: ['warn'], existingSource: existing, generatedOf: () => KIT.gwModernized(RP.GENERATED) }) });
  await adoptC(y);
  const vy = y.c.activePlan(), ey = vy.generated.C1;
  assert(ey.status === 'verified' && ey.review.registration.verdict === 'NEEDS_CONFIRMATION' && ey.review.registration.confirmations.some(c => c.code === 'coverage' && /一部だけ/.test(c.message)) && !ey.review.checks.some(ch => ch.name === 'coverage-unmet' || ch.partialRequired) && vy.final.approvable === true && y.gen.calls.length === 1 && !y.gen.calls[0].feedback,
    `D3-4: 自分の要件の PARTIAL（AI の申告）は、生成工程の coverage の確認事項（Toolkit は要件未達に上げない・修復を依頼しない）: ${JSON.stringify({ status: ey.status, verdict: ey.review.registration.verdict, conf: ey.review.registration.confirmations.map(c => c.code), gen: y.gen.calls.length })}`);
});
// D4: 保存禁止が必要、候補は画面の編集禁止だけ → 保存禁止を別に検証して要件未達（画面制御だけで代用しない）
await section(async () => {
  const CUST_S = custOf(['block-save'], { requirement: '承認待ちでは保存できないようにする', events: ['app.record.edit.show', 'app.record.edit.submit'] });
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_S }), generate: makeGenerate({ sequence: ['lockonly'] }) });
  await adoptC(x);
  const e = x.c.activePlan().generated.C1;
  assert(effectsSent(x) === 'amount:block-save' && e.status === 'unresolved' && e.verdict.kind === 'missing' && /保存を止める/.test(e.verdict.reason) && x.c.activePlan().final.approvable === false, `D4: 保存禁止の要件は block-save として渡し、編集禁止だけの候補は要件未達: ${JSON.stringify({ sent: effectsSent(x), verdict: e.verdict })}`);
});
// D5: 編集不可と保存禁止が両方必要 → 両方の期待を保持し、それぞれ検証する
await section(async () => {
  const CUST_B = custOf(['lock', 'block-save'], { requirement: '承認待ちでは編集も保存もできないようにする', events: ['app.record.edit.show', 'app.record.edit.submit'] });
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_B }), generate: makeGenerate({ sequence: ['lockonly'] }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1, rows = v.final.verification.effects;
  assert(effectsSent(x) === 'amount:block-save,amount:lock' && rows.length === 2 && rows.find(r => r.effect === 'lock').structure === 'present' && rows.find(r => r.effect === 'lock').behavior === 'pass' && rows.find(r => r.effect === 'block-save').structure === 'missing' && e.status === 'unresolved' && v.final.approvable === false, `D5-1: 両方を渡し、編集不可は合格・保存禁止は未達として別々に判定: ${JSON.stringify({ sent: effectsSent(x), rows })}`);
  const y = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_B }), generate: makeGenerate({ sequence: ['locksave'] }) });
  await adoptC(y);
  const vy = y.c.activePlan();
  assert(vy.generated.C1.status === 'verified' && vy.final.approvable === true && vy.final.verification.behavior.cases.length >= 4 && ['lock', 'block-save'].every(ef => ['match', 'nomatch'].every(sd => vy.generated.C1.verification.behavior.cases.some(c => c.effect === ef && c.side === sd && c.verdict === 'pass'))) && vy.final.verification.behavior.cases.every(c => c.verdict === 'pass'), `D5-2: 両方の処理がある候補は、両方の代表条件で合格して承認できる: ${JSON.stringify(vy.final.verification.behavior)}`);
});
// D6: 判定に必要な内部情報が欠けている（旧い計画: CONTROL で effects 無し）→ 台帳の要件の効果から補う。補えなければ準備未完了（利用者に聞かない）
await section(async () => {
  const OLD = custOf(null);
  const op = { op: 'add', target: '金額', condition: '承認待ち', behavior: '編集できないようにする', exceptions: [], decision: 'proposed', disposition: 'adopted', sourceQuotes: [], planRefs: ['C1'], effects: ['lock'], note: '' };
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: OLD, requirementOps: args.revision ? [] : [op] }) });
  await adoptC(x);
  const v = x.c.activePlan();
  assert(effectsSent(x) === 'amount:lock' && x.gen.calls[0].requiredEffects.some(r => (r.requirementIds || []).some(id => /^R\d+$/.test(id))) && v.generated.C1.status === 'verified' && v.final.approvable === true, `D6-1: 計画の効果が無い（旧形式）→ 台帳の要件の効果（lock）で補って渡す: ${JSON.stringify(x.gen.calls[0] && x.gen.calls[0].requiredEffects)}`);
  const y = makeConvC({ planImpl: (args) => planJs(args, { cust: OLD }) });
  await adoptC(y);
  const vy = y.c.activePlan();
  const asksBefore = y.calls.ask.length, proposesBefore = y.calls.propose.length;
  assert(y.gen.calls.length === 0 && vy.generated.C1.status === 'not-ready' && /必須の動作を特定できません（「金額」で/.test(vy.generated.C1.verdict.reason) && vy.final.approvable === false && /必要な動作.*特定できない/.test(vy.final.blockingReason) && y.calls.ask.length === asksBefore && y.calls.propose.length === proposesBefore && !(vy.openQuestions || []).length, `D6-2: 補えなければ生成を呼ばずに準備未完了（同じ要望を利用者に聞き直さない）: ${JSON.stringify({ gen: y.gen.calls.length, verdict: vy.generated.C1.verdict, reason: vy.final.blockingReason })}`);
  // 純関数: 対象のフィールドが特定できる要件はそのフィールドだけ・計画の効果が要件より弱いときは要件の効果も必須に足す（警告で編集不可を満たしたことにしない）
  const plan2 = { customizations: [{ customizationId: 'C1', events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', effects: ['warn'] }, { code: 'memo', access: 'CONTROL' }] }] };
  const r2 = KTAiConversation.requiredEffectsOf(plan2, 'C1', [{ id: 'R1', target: '金額', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects: ['lock'] }, { id: 'R2', target: '備考', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects: ['show-hide'] }], { labels: LABELS_C });
  //   §0c.6: 同じ field・effect・events・condition の組は 1 件（要件の id は requirementIds）。展開すると従来と同じ 4 組
  assert(JSON.stringify(r2.effects.flatMap(e => e.requirementIds.map(id => `${id}:${e.field}:${e.effect}`)).sort()) === JSON.stringify(['C1:amount:warn', 'C1:memo:show-hide', 'R1:amount:lock', 'R2:memo:show-hide']) && r2.effects.length === 3 && r2.unresolved.length === 0, `D6-3: 要件の効果は計画より弱めない・対象のフィールドで補う（同じ組は 1 件にまとめる）: ${JSON.stringify(r2)}`);
  const r3 = KTAiConversation.requiredEffectsOf({ customizations: [{ customizationId: 'C1', events: [], fields: [{ code: 'amount', access: 'WRITE' }, { code: 'memo', access: 'CONTROL' }] }] }, 'C1', []);
  assert(JSON.stringify(r3) === JSON.stringify({ effects: [{ requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect: 'set-value', events: [], condition: '' }], unresolved: [{ field: 'memo', reason: 'field-unspecified' }], delegated: [], notPossible: [] }), `D6-4: 互換（WRITE → set-value）と未特定（CONTROL で効果も台帳も無い）: ${JSON.stringify(r3)}`);
});
// D7: 検査環境の制約で実行できない → コード不合格にも合格にも読み替えず、無駄な修復を呼ばない（準備未完了の理由は環境）
await section(async () => {
  const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], env: 'timeout' }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  assert(x.gen.calls.length === 1 && !x.gen.calls[0].feedback && e.status === 'not-run' && e.verdict.kind === 'environment' && /模擬テストを実行できませんでした（環境: 時間内に終わりませんでした）/.test(e.verdict.reason) && /誤りとは判定していません/.test(e.verdict.reason) && !/要件未達/.test(e.verdict.reason), `D7-1: not-run → 環境の理由で準備未完了（修復は呼ばない・不合格と言わない）: ${JSON.stringify({ calls: x.gen.calls.length, verdict: e.verdict })}`);
  assert(v.final.approvable === false && /環境の制約です/.test(v.final.blockingReason) && x.c.approveFinal({ planId: v.planId, version: v.version }).ok === false, `D7-2: 未確認を合格に読み替えない（承認できない）: ${v.final.blockingReason}`);
  const nr = e.review.checks.find(ch => ch.name === 'behavior-not-run');
  assert(nr && nr.severity === 'block' && nr.noRepair === true && nr.environment === true && e.review.checks.find(ch => ch.name === 'required-effects').ok === true, `D7-3: 形式確認の取り込み: 必須の効果の処理はあり、動作テストは環境で未実行（修復の対象にしない印）: ${JSON.stringify(nr)}`);
  const text = stripC(rightOf(x));
  assert(/模擬テスト（代表条件 2 件）: 合格 0・不合格 0・実行できない 2（環境: 時間内に終わりませんでした）/.test(text) && /未確認 「金額」（PC）: 編集できない — 処理あり・模擬テストを実行できません（環境）/.test(text), `D7-4: カードは「実行できない（環境）」として出す: ${(text.match(/必須の動作[\s\S]{0,200}/) || [''])[0]}`);
  // 動作テストは passed だが必須の効果の代表条件が無い → 未確認（合格に読み替えない）
  const y = makeConvC({ generate: makeGenerate({ sequence: ['good'], dropCaseFor: 'amount|lock' }) });
  await adoptC(y);
  assert(y.c.activePlan().generated.C1.status === 'unverified' && y.c.activePlan().final.approvable === false, `D7-5: 必須の効果に代表条件が無い → 未確認で準備未完了: ${JSON.stringify(y.c.activePlan().generated.C1.verdict)}`);
});
// D8: 基準取得失敗・古い候補・機能非対応 → 照合の省略や旧承認の流用で反映できない
await section(async () => {
  const x = makeConvC();
  await adoptC(x);
  const v = x.c.activePlan();
  const r0 = x.c.approveFinal({ planId: v.planId, version: v.version, baseStamp: null });
  assert(r0.ok === false && r0.reason === 'BASE_UNKNOWN' && !v.approval, `D8-1: 基準を取得できない（null）→ 照合を飛ばさず承認しない: ${JSON.stringify(r0)}`);
  const r1 = x.c.approveFinal({ planId: v.planId, version: v.version, baseStamp: { revision: '10' } });
  assert(r1.ok === false && r1.reason === 'BASE_UNKNOWN', 'D8-2: 基準の指紋が無い → 承認しない');
  x.c.approveFinal({ planId: v.planId, version: v.version, baseStamp: { fingerprint: 'fp-1' } });
  assert(KTAiConversation.approvalValid(v, { baseStamp: null }).reason === 'BASE_UNKNOWN' && KTAiConversation.approvalValid(v, { baseStamp: { fingerprint: 'fp-1' } }).ok, 'D8-3: 反映の直前に基準が取れない（null）→ BASE_UNKNOWN（以前は undefined で照合を飛ばした）');
  const noFp = { ...v, approval: { ...v.approval, baseStamp: null } };
  assert(KTAiConversation.approvalValid(noFp, { baseStamp: { fingerprint: 'fp-1' } }).reason === 'BASE_UNKNOWN', 'D8-4: 承認に基準の指紋が無いのに照合を飛ばさない');
  const oldHash = v.generated.C1.candidateHash;
  v.generated.C1 = { ...v.generated.C1, candidateHash: 'eeeeeeeeeeeeeeee' };
  assert(KTAiConversation.approvalValid(v, { baseStamp: { fingerprint: 'fp-1' } }).reason === 'CANDIDATE_CHANGED', 'D8-5: 古い候補（承認の後に候補が変わった）→ 旧承認を流用しない');
  v.generated.C1 = { ...v.generated.C1, candidateHash: oldHash };
  // 機能非対応（requiredEffects・behavior を返さない旧い接続先）: 既知の競合を「確認」に下げず、反映できる最終案にしない
  //   §0d.4（2026-10-08）: Toolkit の業務の推定による判定（error-cancels-edit）は削除した。旧い接続先では、生成工程の結果（必須の効果・模擬テスト）が返らないこと
  //   （返却の欠落）を Toolkit が検出して登録不可にする（required-effects の block・修復しない印 noRepair）。既知の競合の候補も「確認」に下がらない
  const y = makeConvC({ supported: false, generate: makeGenerate({ sequence: ['bad'], supported: false }) });
  await adoptC(y);
  const vy = y.c.activePlan(), ey = vy.generated.C1;
  const apY = y.c.approveFinal({ planId: vy.planId, version: vy.version, baseStamp: { fingerprint: 'fp-1' } });
  assert(y.gen.calls.length === 1 && ey.status === 'unsupported' && vy.final.approvable === false && /接続先（生成工程）が必須の動作の確認に対応していない/.test(vy.final.blockingReason) && ey.review.status === 'BLOCKED' && ey.review.registration.verdict === 'BLOCKED' && ey.review.checks.some(ch => ch.name === 'required-effects' && !ch.ok && ch.severity === 'block' && ch.noRepair === true) && apY.ok === false && !vy.approval, `D8-6: 機能非対応 → 準備未完了・既知の競合の候補も生成工程の結果の欠落で登録不可のまま（確認に下げない・承認できない）: ${JSON.stringify({ status: ey.status, verdict: ey.review.registration.verdict, checks: ey.review.checks.filter(ch => !ch.ok).map(ch => `${ch.name}/${ch.severity}`), ap: apY })}`);
  //   今の契約の接続先（health の印 effectCheck あり）: 生成工程は既知の競合を check behavior（candidate-error-same-event）にする。
  //   模擬テストの環境が使えなければ準備未完了（機械検査で足りる効果として合格に数えない）、模擬テストで不合格なら未解決（どちらも承認できない）
  const GEN_EC = [...GEN_EFFECT_FEATURES, 'effectCheck'];
  const z = makeConvC({ supported: GEN_EC, generate: makeGenerate({ sequence: ['badChecked'], env: 'unavailable' }) });
  await adoptC(z);
  const vz = z.c.activePlan(), ez = vz.generated.C1;
  const itZ = ez.review.effects && ez.review.effects.items.find(i => i.field === 'amount' && i.effect === 'lock');
  assert(ez.status === 'not-run' && vz.final.approvable === false && ez.review.registration.verdict === 'BLOCKED' && ez.review.checks.some(ch => ch.name === 'behavior-not-run' && ch.severity === 'block' && ch.noRepair === true) && itZ && itZ.check === 'behavior' && itZ.checkReason.includes('candidate-error-same-event') && itZ.checkedBy !== 'machine' && /error と編集不可の両方/.test(ez.verdict.reason) && z.gen.calls.length === 1 && z.c.approveFinal({ planId: vz.planId, version: vz.version, baseStamp: { fingerprint: 'fp-1' } }).ok === false, `D8-6b: 今の契約の接続先で既知の競合（check behavior）を模擬テストで確かめられない → 準備未完了（機械検査の合格に数えない・修復しない・承認できない）: ${JSON.stringify({ status: ez.status, verdict: ez.review.registration.verdict, item: itZ && { check: itZ.check, checkReason: itZ.checkReason, checkedBy: itZ.checkedBy }, reason: ez.verdict.reason })}`);
  const w = makeConvC({ supported: GEN_EC, generate: makeGenerate({ sequence: ['badChecked'] }) });
  await adoptC(w);
  const vw = w.c.activePlan(), ew = vw.generated.C1;
  assert(ew.status === 'unresolved' && ew.verdict.kind === 'behavior-fail' && vw.final.approvable === false && ew.review.registration.verdict === 'BLOCKED' && ew.review.checks.some(ch => ch.name === 'behavior-fail' && ch.severity === 'block' && /取り消/.test(ch.message)) && w.c.approveFinal({ planId: vw.planId, version: vw.version, baseStamp: { fingerprint: 'fp-1' } }).ok === false, `D8-6c: 今の契約の接続先で既知の競合が模擬テストで不合格（error で編集不可が取り消される）→ 未解決・登録不可（承認できない）: ${JSON.stringify({ status: ew.status, verdict: ew.verdict && ew.verdict.kind, checks: ew.review.checks.filter(ch => !ch.ok).map(ch => `${ch.name}/${ch.severity}`) })}`);
  // HEAD で登録不可だった 4 通りは、動作テストの結果が無い・実行できない・不合格・旧い接続先のどれでも登録不可のまま（合格のときだけ登録の準備に進める）
  //   §0d.4（2026-10-08）: 生成工程の結果を通さない静的な形式確認だけの形（旧 mode none）は、Toolkit の業務の推定による判定（error-cancels-edit）を試していたので外した。
  //   既知の競合の判定は生成工程（Gateway の required-effects.mjs §0d.1 S7 の check behavior・隔離環境の sandbox/test/run.mjs §3 R13 の cancelledByError・
  //   cross-toolkit.mjs の 5-3 と 12-9）が持つ。ここでは、今の契約の Gateway が 4 通りすべてに返す形（check behavior・checkReason candidate-error-same-event・
  //   イベントごとに present。AI版の verify-generated.mjs の machineChecks で確かめた分類）で、模擬テストが実行できない（gw-not-run）・不合格（gw-fail）も登録不可のままであることを足す
  const EDIT = ['app.record.edit.show'];
  const LOCK = `    if (${ST_C}) record['amount'].disabled = true;`;
  const H4 = (body) => `(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(EDIT)}, function (event) {\n    const record = event.record;\n${body}\n    return event;\n  });\n})();`;
  const four = {
    'same-handler-unconditional-error': H4(`${LOCK}\n    record['amount'].error = '注意';`),
    'same-condition-both': H4(`    if (${ST_C}) { record['amount'].disabled = true; record['amount'].error = '承認待ち'; }`),
    'two-handlers-same-file': `(function(){ 'use strict'; kintone.events.on(${JSON.stringify(EDIT)}, function(event){ const record = event.record; ${LOCK.trim()} return event; }); kintone.events.on(${JSON.stringify(EDIT)}, function(event){ event.record['amount'].error = '注意'; return event; }); })();`,
    'record-level-event-error': H4(`${LOCK}\n    if (${ST_C}) event.error = '承認待ちです';`),
  };
  const REQ = [{ requirementId: 'C1', field: 'amount', effect: 'lock', events: EDIT, condition: '' }];
  const GW_RE = { requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect: 'lock', status: 'present', check: 'behavior', checkReason: ['candidate-error-same-event', 'nested'], events: [{ event: EDIT[0], status: 'present' }] };
  const gwCase = (verdict, o = {}) => ({ id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', side: 'match', kind: 'match', event: EDIT[0], verdict, observed: verdict === 'fail' ? {} : null, message: verdict === 'fail' ? '承認待ちの編集画面で、エラー表示のため編集不可が取り消されました' : '隔離環境で実行できませんでした', ...o });
  const verOf = (mode) => (mode === 'legacy' ? { version: '0', legacy: true, machine: [] }
    : mode === 'not-run' ? { requiredEffects: [{ requirementId: 'C1', field: 'amount', effect: 'lock', status: 'present' }], behavior: { status: 'not-run', reason: 'unavailable', cases: [] } }
    : mode === 'gw-not-run' ? { version: '1', passed: true, machine: [], requiredEffects: [clone(GW_RE)], behavior: { status: 'not-run', reason: 'unavailable', cases: [gwCase('not-run', { reason: 'unavailable' })] } }
    : mode === 'gw-fail' ? { version: '1', passed: true, machine: [], requiredEffects: [clone(GW_RE)], behavior: { status: 'failed', reason: null, cases: [gwCase('fail')] } }
    : { requiredEffects: [{ requirementId: 'C1', field: 'amount', effect: 'lock', status: 'present' }] });
  const out = [];
  for (const [k, code] of Object.entries(four)) {
    const g = { strategy: 'NEW_JS_FILE', targetFile: 'lock.js', summary: 's', code, patch: null, events: EDIT, fields: [{ code: 'amount', access: 'CONTROL' }], apis: [] };
    const rv = KTCodeReview.review({ generated: g, customization: CUST_C1, plan: null, data: clone(DATA_C), scan: null, existingSource: null });
    for (const mode of ['legacy', 'not-run', 'no-behavior', 'gw-not-run', 'gw-fail']) {
      //   印 effectCheck の有無の両方で確かめる（印があっても check behavior の効果は機械検査の合格に数えない）
      for (const effectCheck of [false, true]) {
        const merged = KTCodeReview.attachBehavior(rv, verOf(mode), { requiredEffects: REQ, customization: CUST_C1, effectCheck });
        out.push([k, mode, merged.registration.verdict, effectCheck]);
      }
    }
  }
  assert(out.length === 40 && out.every(r => r[2] === 'BLOCKED'), `D8-7: HEAD で登録不可の 4 通りは、動作テストの結果が無い・実行できない・不合格・旧い接続先で確認に下がらない: ${JSON.stringify(out.filter(r => r[2] !== 'BLOCKED'))}`);
});
// D9: 採用済み要件に計画の対応づけが無い → 最終案から消さず、確認の限界として右に出す（止めない・自動の見直しなし）。
//   簡素化 C（2026-10-16）: 以前は「担当なし」で止め、自動で 1 回だけ計画の差分更新（その要件を focus に）に戻した。期限は今の設定で満たしていることがあり、構造からは区別できない
await section(async () => {
  const OWN = { op: 'add', target: '承認', condition: '', behavior: '7 営業日以内に承認する', exceptions: [], decision: 'decided', disposition: 'unresolved', sourceQuotes: ['7営業日で'], planRefs: [], effects: [], note: '' };
  // (a) 差分更新なら担当（C1）を付ける計画の AI でも、差分更新を依頼しない → 承認できる最終案 1 つ（その要件は確認の限界）
  let hold = null;
  const ridNow = () => { const vv = hold && hold.c.activePlan(); return vv ? (hold.c.requirements(vv.planId).find(r => r.behavior === OWN.behavior) || {}).id : null; };
  const x = makeConvC({ planImpl: (args) => planJs(args, { gatewayPlan: { plan: true }, requirementOps: args.revision ? [{ ...OWN, op: 'update', id: ridNow(), planRefs: ['C1'], disposition: 'adopted' }] : [OWN] }) });
  hold = x;
  await adoptC(x);
  const v = x.c.activePlan();
  const rid = (x.c.requirements(v.planId).find(r => r.behavior === '7 営業日以内に承認する') || {}).id;
  assert(rid && x.calls.plan.length === 1 && !x.calls.plan[0].revision && (v.final.unconfirmedReqs || []).some(u => u.requirementId === rid), `D9-1: 計画に対応づけていない決まった要件（扱い未定の unresolved も）→ 自動の差分更新をせず、確認の限界: ${JSON.stringify({ plans: x.calls.plan.map(p => ({ rev: p.revision, focus: p.focus })), unconf: (v.final.unconfirmedReqs || []).map(u => u.requirementId) })}`);
  assert(x.finals().length === 1 && v.version === 1 && v.final.approvable === true && x.gen.calls.length === 1, `D9-2: 最終案を 1 回だけ作る（確認の限界では止めない）: ${JSON.stringify({ finals: x.finals().length, version: v.version, gen: x.gen.calls.length, reason: v.final.blockingReason })}`);
  // (b) 差分更新でも担当を付けない計画の AI → 最終案に確認の限界として出す（右に件数の 1 行・要件の文は［詳しく］。左には出さない。承認できる）
  const y = makeConvC({ planImpl: (args) => planJs(args, { gatewayPlan: { plan: true }, requirementOps: args.revision ? [] : [OWN] }) });
  await adoptC(y);
  const vy = y.c.activePlan();
  const hy = stripC(finalHtml(y));
  assert(y.calls.plan.length === 1 && y.finals().length === 1 && vy.final.approvable === true && !vy.final.blockers.some(b => b.kind === 'ownerless') && /計画の構造からは実現を確かめていない要件が 1 件あります/.test(stripC(rightOf(y))) && stripC(rightOf(y)).includes('「7営業日で」は、計画の構造からは実現を確かめていません') && !/7営業日で/.test(hy), `D9-3: 計画に対応づけていない決まった要件は最終案から消さず、右の確認の限界に出す（自動の差分更新なし）: ${JSON.stringify({ plans: y.calls.plan.length, finals: y.finals().length, reason: vy.final.blockingReason })}`);
  const ap = y.c.approveFinal({ planId: vy.planId, version: vy.version });
  assert(ap.ok === true, `D9-4: 確認の限界の要件が残る最終案も承認できる（反映した後に動作テスト環境で確かめる）: ${JSON.stringify(ap)}`);
});

// D10（画面）: 偽 client（health の customization-generator.verification に requiredEffects）で、Generator Context に必須の効果と既存 JS の本文（伏字）を渡し、
//   代表条件は送らない。生成工程の結果で最終案 → 承認 → 登録の準備（登録前の再検査は生成工程の結果の取り込み。Toolkit は模擬を実行しない）。
//   基準の取得に失敗したら、承認を流用して登録の準備に進まない（BASE_UNKNOWN）。動作テストが環境で実行できなければ承認できない
const { makeEnvGetter } = require('./helpers/dev-base-fake.js');
await section(async () => {
  const HEALTH_V = clone(HEALTH);
  HEALTH_V.registry.toolkit['customization-generator'].verification = ['requirementId', 'feedback', ...GEN_EFFECT_FEATURES];
  const CUST_S = { customizationId: 'C1', requirement: '承認待ちでは案件名を編集できないようにする', whyStandardInsufficient: 'ステータスで切り替えるアクセス権は無い', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'case_name', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock'] }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [] };
  const planResp = (goal) => { const b = PLAN_V1(goal); return { ...b, plan: { ...b.plan, solution: 'CUSTOMIZATION', assessment: { ...b.plan.assessment, summary: '承認待ちでは案件名を編集できないようにします。' }, steps: [mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { title: 'JavaScript', solution: 'CUSTOMIZATION' })], customizations: [CUST_S] } }; };
  const CODE_S = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認待ち') record['case_name'].disabled = true;\n    return event;\n  });\n})();";
  const run = async ({ env = null, baseFailAfterApprove = false } = {}) => {
    const genCtx = [];
    let baseFail = false;
    const loadDevBase = async () => { if (baseFail) return { ok: false, status: 'FETCH_FAILED', message: '動作テスト環境の設定を取得できませんでした（テスト）', loadedAt: '2026-10-08T00:00:00.000Z', errors: [] }; const FXF = require('./fixtures/ai-context-app.js').files; const g = makeEnvGetter({ preview: clone(INPUTS.data), production: clone(INPUTS.data), files: { '20261001000000AAAA': FXF[0].text, '20261001000000BBBB': FXF[1].text, '20261001000000DDDD': FXF[2].text } }); return T.KTDevBase.load({ appId: '341', getImpl: g.getImpl, download: g.download, now: () => new Date('2026-10-08T00:00:00Z') }); };
    const generateImpl = async ({ ctx, requestId }) => {
      genCtx.push(clone(ctx));
      const req = (ctx.verification && ctx.verification.requiredEffects) || [];
      const candidateHash = gwCandidateHash({ strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', code: CODE_S, customizationId: 'C1' });
      const resp = { ok: true, contractVersion: '2.1', meta: { requestId, gateway: { product: 'toolkit', feature: 'customization-generator', promptVersion: '1', contextVersion: 'customization-1' }, normalization: { warnings: [] }, ai: { model: 'm' } }, generated: { strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', summary: '承認待ちでは案件名を編集できないようにします。', code: CODE_S, patch: null, events: ['app.record.edit.show'], fields: [{ code: 'case_name', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '' }] }, verification: fakeVerification({ code: CODE_S, has: { case_name: ['lock'] } }, req, { env, candidateHash }) };
      const v = KTAiClient.validateGenerated(resp, ctx);
      if (!v.ok) throw new Error(JSON.stringify(v.errors));
      return { ...v.normalized, requestId };
    };
    const m = mount({ health: HEALTH_V, planImpl: ({ ctx, requestId }) => { const v = KTAiClient.validatePlan(planResp(ctx.goal), ctx); if (!v.ok) throw new Error(JSON.stringify(v.errors)); return { ...v.normalized, requestId, clientWarnings: v.warnings }; }, generateImpl, extra: { loadDevBase } });
    await ticks();
    for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) { await m.panel.send(s); await ticks(8); }
    await m.panel.send('おすすめで。この案で進めて'); await ticks(20);
    return { m, genCtx, setBaseFail: (b) => { baseFail = b; } };
  };
  const { m, genCtx, setBaseFail } = await run();
  const v = m.conv().activePlan();
  const vf = genCtx[0] && genCtx[0].verification;
  assert(genCtx.length === 1 && vf && JSON.stringify(vf.requiredEffects) === JSON.stringify([{ requirementId: 'C1', requirementIds: ['C1'], field: 'case_name', effect: 'lock', events: ['app.record.edit.show'], condition: 'ステータス in ("承認待ち")' }]) && !('cases' in vf) && Array.isArray(vf.relatedFiles) && vf.relatedFiles.map(f => f.name).join(',') === 'common.js' && !/sk_live_0123456789abcdef0123/.test(vf.relatedFiles[0].text) && /case_name/.test(vf.relatedFiles[0].text), `D10-1: Generator Context に必須の効果と、そのフィールドを参照する既存 JS（同じ platform・秘密情報は伏字）を渡し、代表条件は送らない: ${JSON.stringify(vf && { re: vf.requiredEffects, files: (vf.relatedFiles || []).map(f => f.name), cases: 'cases' in vf })}`);
  assert(v && v.final && v.final.approvable === true && v.generated.C1.status === 'verified' && v.generated.C1.verification.behavior.status === 'passed', `D10-2: 生成工程の結果（必須の効果・動作テスト）で最終案は承認できる: ${JSON.stringify(v && v.final && { approvable: v.final.approvable, reason: v.final.blockingReason, status: v.generated.C1 && v.generated.C1.status })}`);
  //   §0e.1: 基準を取得できない → 照合を飛ばさない（承認の欄の準備の後、押す前に取得できなくなった場合。何も書き込まずに止め、承認を外す）
  const rF = await run();
  const vF = rF.m.conv().activePlan();
  const r5 = await KIT.applyOnScreen(rF.m, { before: () => rF.setBaseFail(true) });
  assert(r5.button && !r5.button.disabled && r5.run.stage === 'stopped' && !r5.run.written && r5.writes.length === 0 && !vF.approval && /確かめられませんでした/.test(r5.card) && !rF.m.mock.calls.some(c => c === 'PUT customize'), `D10-5: 基準を取得できない → 照合を飛ばさず、承認を流用して反映・登録に進まない（書き込み 0・承認を外す）: ${r5.card.slice(0, 200)}`);
  const r4 = await KIT.applyOnScreen(m);
  const pr = m.panel.jsExecState().prepared;
  assert(v.approval && v.approval.baseStamp && v.approval.baseStamp.fingerprint, `D10-3: 承認に基準の指紋を記録: ${JSON.stringify(v.approval && v.approval.baseStamp)}`);
  assert(pr && pr.status === 'PREPARED' && r4.run.ok && m.panel.jsExecState().execution.status === 'DONE', `D10-4: 登録前の再検査は生成工程の結果の取り込み（模擬は実行しない）で、登録まで進む: ${JSON.stringify(pr && { status: pr.status, blockers: pr.blockers })}`);
  // 動作テストが環境で実行できない → 承認できない（［この内容で反映する］は押せない）
  const r2 = await run({ env: 'unavailable' });
  const v2 = r2.m.conv().activePlan();
  assert(v2 && v2.final && v2.final.approvable === false && v2.generated.C1.status === 'not-run' && r2.genCtx.length === 1 && /disabled>動作テスト環境へ反映/.test(r2.m.chat()) && /模擬テストを実行できませんでした（環境: 模擬テストの環境を使えませんでした）/.test(stripC(r2.m.chat())), `D10-6: 動作テストが環境で実行できない → 生成は 1 回のまま・承認できない・理由は環境: ${JSON.stringify(v2 && v2.final && { approvable: v2.final.approvable, reason: v2.final.blockingReason })}`);
});

// ---- §0c.6（2026-10-08）: 段階 C-1 の独立レビュー（効果の区別・隔離環境と完了条件）の再現と回帰 ----
const flatEffects = (r) => r.effects.flatMap(e => e.requirementIds.map(id => `${id}:${e.field}:${e.effect}`)).sort();
const REQ_LOCK = [{ requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect: 'lock', events: ['app.record.edit.show'], condition: '' }];
const VER_LOCK_OK = { requiredEffects: [{ requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect: 'lock', status: 'present' }], behavior: { status: 'passed', reason: null, cases: [{ id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', event: 'app.record.edit.show', side: 'match', verdict: 'pass', message: '期待どおり' }] } };   // §0c.9: 代表条件はイベントと side を持つ
// D11（レビュー mis.cjs の A・B）: 要件の対象は計画のすべてのフィールド（READ を含む）から構造で特定する。特定できない・担当するフィールドが無ければ、ほかのフィールドに配らず unresolved
await section(async () => {
  const labels = { amount: '金額', memo: '備考', status: 'ステータス' };
  const planA = { customizations: [{ customizationId: 'C1', events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'READ' }, { code: 'memo', access: 'CONTROL', effects: ['warn'] }] }] };
  const rA = KTAiConversation.requiredEffectsOf(planA, 'C1', [{ id: 'R1', target: '金額', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects: ['lock'] }], { labels });
  assert(JSON.stringify(flatEffects(rA)) === JSON.stringify(['C1:memo:warn']) && rA.unresolved.length === 1 && rA.unresolved[0].field === 'amount' && rA.unresolved[0].effect === 'lock' && rA.unresolved[0].reason === 'no-owner-field' && rA.unresolved[0].access === 'READ', `D11-1（mis A）: 要件は金額の編集不可・計画は金額を READ → 備考に編集不可を付けず、金額は「担当するフィールドが無い」で unresolved: ${JSON.stringify(rA)}`);
  const planB = { customizations: [{ customizationId: 'C1', events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', effects: ['warn'] }, { code: 'memo', access: 'CONTROL', effects: ['show-hide'] }] }] };
  const rB = KTAiConversation.requiredEffectsOf(planB, 'C1', [{ id: 'R1', target: '金額フィールド', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects: ['lock'] }], { labels });
  assert(JSON.stringify(flatEffects(rB)) === JSON.stringify(['C1:amount:warn', 'C1:memo:show-hide']) && !rB.effects.some(e => e.effect === 'lock') && rB.unresolved.length === 1 && rB.unresolved[0].reason === 'target-unresolved' && rB.unresolved[0].requirementId === 'R1', `D11-2（mis B）: 要件の対象がラベルと完全には一致しない → 表示の切り替えだけの備考に編集不可を付けず unresolved: ${JSON.stringify(rB)}`);
  // 会話: unresolved → 自動で計画の差分更新を 1 回（効果と対象を決めさせる）→ それでも残れば準備未完了（生成を呼ばない・利用者に聞き直さない）
  const opA = { op: 'add', target: '金額', condition: '承認待ち', behavior: '編集できないようにする', exceptions: [], decision: 'proposed', disposition: 'adopted', sourceQuotes: [], planRefs: ['C1'], effects: ['lock'], note: '' };
  const CUST_A = custOf(null, { fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'READ' }, { code: 'memo', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['warn'] }] });
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_A, gatewayPlan: { plan: true }, requirementOps: args.revision ? [] : [opA] }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  assert(x.calls.plan.length === 2 && x.calls.plan[1].revision && /effects/.test(x.calls.plan[1].request) && x.calls.plan[1].focus.includes('C1') && x.gen.calls.length === 0 && e.status === 'not-ready' && /担当するフィールドが計画にありません（「金額」は計画では読み取りだけです）/.test(e.verdict.reason) && /1 回自動で依頼しました/.test(e.verdict.next) && v.final.approvable === false && x.finals().length === 1, `D11-3: unresolved → 自動の差分更新は 1 回 → 準備未完了（生成しない・最終案は 1 回）: ${JSON.stringify({ plans: x.calls.plan.map(p => ({ rev: p.revision, focus: p.focus })), gen: x.gen.calls.length, verdict: e.verdict })}`);
  const y = makeConvC({ planImpl: (args) => planJs(args, { cust: args.revision ? custOf(['lock']) : CUST_A, requirementOps: args.revision ? [] : [opA] }) });
  await adoptC(y);
  const vy = y.c.activePlan();
  assert(y.calls.plan.length === 2 && vy.version === 2 && y.gen.calls.length === 1 && effectsSent(y) === 'amount:lock' && vy.generated.C1.status === 'verified' && vy.final.approvable === true && y.finals().length === 1, `D11-4: 差分更新で計画が金額に編集不可を置けば、その版で最終案を 1 回だけ作る: ${JSON.stringify({ plans: y.calls.plan.length, gen: y.gen.calls.length, sent: effectsSent(y) })}`);
});
// D12（レビュー tk.cjs）: 計画で新設するフィールドの必須の効果は、固定する時点で採番後のコードに変換し、照合も同じコード（Gateway が全部合格なら照合も合格）
await section(async () => {
  const plan = { proposedFields: [{ temporaryId: 'NEW_FIELD_1', suggestedCode: 'approver_note', label: '承認メモ', type: 'SINGLE_LINE_TEXT' }], steps: [{ id: 'P1', actionType: 'ADD_FIELD', targetRef: 'NEW_FIELD_1', title: '承認メモを追加', spec: {} }], customizations: [{ customizationId: 'C1', requirement: '承認済みでは承認メモを編集不可', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.edit.show', 'app.record.edit.change.NEW_FIELD_1'], fields: [{ code: 'NEW_FIELD_1', access: 'CONTROL', effects: [{ effect: 'lock', condition: 'ステータス in ("承認済み") and NEW_FIELD_1 != ""' }] }, { code: 'ステータス', access: 'READ', effects: [] }] }] };
  const req = KTAiConversation.requiredEffectsOf(plan, 'C1', [], { labels: LABELS_C });
  const e0 = req.effects[0] || {};
  assert(req.effects.length === 1 && e0.field === 'approver_note' && /approver_note != ""/.test(e0.condition) && !/NEW_FIELD_1/.test(JSON.stringify(req)) && e0.events.includes('app.record.edit.change.approver_note'), `D12-1: 必須の効果のフィールド・条件・イベントは採番後のコード: ${JSON.stringify(req)}`);
  const ctx = KTContext.buildGenerator({ customization: plan.customizations[0], plan, planId: 'p', version: 1, data: clone(DATA_C), verification: { requirementIds: [], requiredEffects: req.effects } });
  assert(ctx.verification.requiredEffects[0].field === 'approver_note' && ctx.verification.requiredEffects[0].condition === e0.condition && ctx.verification.appFields.some(f => f.code === 'approver_note' && f.planned) && ctx.verification.appFields.some(f => f.code === 'memo') && ctx.verification.appFields.some(f => f.subtable === 'items'), `D12-2: Generator Context の必須の効果も同じコード・隔離環境に渡すフィールドはアプリのすべてのフィールド（テーブルの列は subtable）と新設のフィールド: ${JSON.stringify({ re: ctx.verification.requiredEffects, n: ctx.verification.appFields.length })}`);
  const ver = { requiredEffects: [{ requirementId: 'C1', requirementIds: ['C1'], field: 'approver_note', effect: 'lock', status: 'present' }], behavior: { status: 'passed', reason: null, cases: ['app.record.edit.show', 'app.record.edit.change.approver_note'].flatMap((ev, i) => [{ id: `K${i * 2 + 1}`, requirementIds: ['C1'], field: 'approver_note', effect: 'lock', expect: 'lock', event: ev, side: 'match', verdict: 'pass' }, { id: `K${i * 2 + 2}`, requirementIds: ['C1'], field: 'approver_note', effect: 'lock', expect: 'not-locked', event: ev, side: 'nomatch', verdict: 'pass' }]) } };   // §0c.9: イベントごとに合う・合わない
  const er = KTCodeReview.effectResults(ver, req.effects);
  assert(er.ok && er.items.length === 1 && er.items[0].structure === 'present' && er.items[0].behavior === 'pass', `D12-3: Gateway が返したコードと保持したコードが同じなので照合も合格（以前は unknown / untested で準備未完了）: ${JSON.stringify(er.items.map(i => [i.field, i.structure, i.behavior]))}`);
});
// D13（レビュー dup.cjs・dup.mjs）: 同じ field・effect・events・condition の組は 1 件にまとめ、要件の id は requirementIds に持つ（C1 と R… で同じ代表条件を重ねない）
await section(async () => {
  const EV = ['app.record.create.show', 'app.record.edit.show', 'app.record.create.submit', 'app.record.edit.submit'];
  const plan = { customizations: [{ customizationId: 'C1', events: EV, fields: [{ code: 'amount', access: 'CONTROL', effects: ['lock', 'block-save'], condition: 'ステータス in ("承認済み")' }, { code: 'memo', access: 'CONTROL', effects: ['warn'], condition: 'amount >= 100' }, { code: 'ステータス', access: 'READ', effects: [] }] }] };
  const ledger = [{ id: 'R1', target: '金額', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects: ['lock', 'block-save'] }, { id: 'R2', target: '備考', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects: ['warn'] }];
  const r = KTAiConversation.requiredEffectsOf(plan, 'C1', ledger, { labels: LABELS_C });
  const keys = r.effects.map(e => `${e.field}|${e.effect}|${e.events.join(',')}|${e.condition}`);
  assert(r.effects.length === 3 && new Set(keys).size === 3 && r.effects.every(e => e.requirementIds.length === 2 && e.requirementIds[0] === 'C1') && JSON.stringify(flatEffects(r)) === JSON.stringify(['C1:amount:block-save', 'C1:amount:lock', 'C1:memo:warn', 'R1:amount:block-save', 'R1:amount:lock', 'R2:memo:warn']), `D13-1: 必須の効果は 3 件（重複なし・requirementIds は C1 と要件の id）: ${JSON.stringify(r.effects.map(e => [e.field, e.effect, e.requirementIds]))}`);
  const ctx = KTContext.buildGenerator({ customization: { customizationId: 'C1', requirement: 'r', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: EV, fields: plan.customizations[0].fields }, plan, planId: 'p', version: 1, data: clone(DATA_C), verification: { requirementIds: [], requiredEffects: r.effects } });
  assert(ctx.verification.requiredEffects.length === 3 && ctx.verification.requiredEffects.every(e => Array.isArray(e.requirementIds) && e.requirementIds.length === 2 && e.requirementId === 'C1'), `D13-2: Generator Context にも同じ 3 件（requirementIds 付き）: ${JSON.stringify(ctx.verification.requiredEffects.map(e => [e.field, e.effect, e.requirementIds]))}`);
  // 会話: dup.mjs（金額と備考を承認待ちで編集不可・金額は保存も止める。台帳にも同じ要件）→ 生成工程に渡す必須の効果は 3 件
  const CUST_D = custOf(null, { events: ['app.record.edit.show', 'app.record.edit.submit'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock', 'block-save'] }, { code: 'memo', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock'] }] });
  const ops = [{ op: 'add', target: '金額', condition: '承認待ち', behavior: '編集も保存もできないようにする', exceptions: [], decision: 'proposed', disposition: 'adopted', sourceQuotes: [], planRefs: ['C1'], effects: ['lock', 'block-save'], note: '' }, { op: 'add', target: '備考', condition: '承認待ち', behavior: '編集できないようにする', exceptions: [], decision: 'proposed', disposition: 'adopted', sourceQuotes: [], planRefs: ['C1'], effects: ['lock'], note: '' }];
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_D, requirementOps: args.revision ? [] : ops }), generate: makeGenerate({ sequence: ['locksave'] }) });
  await adoptC(x);
  const sent = x.gen.calls[0] && x.gen.calls[0].requiredEffects;
  assert(sent && sent.length === 3 && new Set(sent.map(e => `${e.field}|${e.effect}`)).size === 3 && sent.every(e => e.requirementIds.length === 2), `D13-3: 会話から生成工程へ渡す必須の効果も 3 件（同じ組を C1 と R… で重ねない）: ${JSON.stringify(sent && sent.map(e => [e.field, e.effect, e.requirementIds]))}`);
});
// D14（レビュー B2・§0c.6。C-1 第 3 段（2026-10-08）で新しい流れに移し替え）: 必須の効果を生成工程で確かめていない JavaScript は登録しない。
//   仮案の能力が無い接続先は「接続先が非対応」で計画・生成・登録に進まない（従来の流れの登録の止め REQUIRED_EFFECTS_UNVERIFIED は、最終案の承認が無ければ
//   登録の準備をしない止めに置き換えた）。仮案の流れでは、生成工程が必須の効果に非対応なら最終案を承認できず、既知の競合・要件未達は承認できず、
//   合格した候補だけが承認 → 登録の準備（PREPARED）に進む
await section(async () => {
  const hLegacy = clone(HEALTH); hLegacy.registry.toolkit['assistant-qa'].conversation = ['requirements', 'brief', 'stream'];
  const CUST_L = { customizationId: 'C1', requirement: '承認待ちでは案件名を編集できないようにする', whyStandardInsufficient: 'ステータスで切り替えるアクセス権は無い', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'case_name', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock'] }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [] };
  const planRespL = (goal) => { const b = PLAN_V1(goal); return { ...b, plan: { ...b.plan, solution: 'CUSTOMIZATION', assessment: { ...b.plan.assessment, summary: '承認待ちでは案件名を編集できないようにします。' }, steps: [mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { title: 'JavaScript', solution: 'CUSTOMIZATION' })], customizations: [CUST_L] } }; };
  const LOCK_L = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認待ち') record['case_name'].disabled = true;\n    return event;\n  });\n})();";
  const CONFLICT_L = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認待ち') record['case_name'].disabled = true;\n    record['case_name'].error = '確認してください';\n    return event;\n  });\n})();";
  //   cand = 偽の生成工程の候補の性質に足すもの（fails・failMsg・check。今の契約の Gateway の結果を返すときに使う）
  const run = async ({ proposal = true, capable = false, code = LOCK_L, has = ['lock'], cand = {} } = {}) => {
    const h = clone(proposal ? HEALTH : hLegacy);
    if (capable) h.registry.toolkit['customization-generator'].verification = ['requirementId', ...(Array.isArray(capable) ? capable : GEN_EFFECT_FEATURES)];
    const genCtx = [];
    const generateImpl = async ({ ctx, requestId }) => {
      genCtx.push(clone(ctx));
      const req = (ctx.verification && ctx.verification.requiredEffects) || [];
      const resp = { ok: true, contractVersion: '2.1', meta: { requestId, gateway: { product: 'toolkit', feature: 'customization-generator', promptVersion: '1', contextVersion: 'customization-1' }, normalization: { warnings: [] }, ai: { model: 'm' } }, generated: { strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', summary: '承認待ちでは案件名を編集できないようにします。', code, patch: null, events: ['app.record.edit.show'], fields: [{ code: 'case_name', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '' }] }, ...(req.length ? { verification: fakeVerification({ code, has: { case_name: has }, ...cand }, req, { candidateHash: gwHashOfCtx(ctx, { strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', code, patch: null }) }) } : {}) };
      const vv = KTAiClient.validateGenerated(resp, ctx);
      if (!vv.ok) throw new Error(JSON.stringify(vv.errors));
      return { ...vv.normalized, requestId };
    };
    const m = mount({ health: h, planImpl: ({ ctx, requestId }) => { const vv = KTAiClient.validatePlan(planRespL(ctx.goal), ctx); if (!vv.ok) throw new Error(JSON.stringify(vv.errors)); return { ...vv.normalized, requestId, clientWarnings: vv.warnings }; }, generateImpl });
    await ticks();
    for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) { await m.panel.send(s); await ticks(8); }
    await m.panel.send('おすすめで。この案で進めて'); await ticks(16);
    const v = m.conv().activePlan();
    //   §0e.1: 承認できる最終案は［動作テスト環境へ反映］1 回で承認と登録。承認できない最終案は登録の準備の部品を直接呼んでも止まる
    const applied = v && v.final && v.final.approvable ? await KIT.applyOnScreen(m) : null;
    const pr = v ? (applied ? m.panel.jsExecState().prepared : await m.panel.startJsRegister(v)) : null; await ticks(4);
    const blockText = JSON.stringify((pr && pr.blockers) || []);
    return { m, v, pr, applied, genCtx, blockText, cannotText: JSON.stringify(v && v.final ? v.final.cannot : []), draft: m.conv().draft() };
  };
  const a = await run({ proposal: false });
  assert(a.v === null && a.genCtx.length === 0 && a.m.calls.plan.length === 0 && a.pr === null && /接続先が非対応/.test(a.m.chat()) && !a.m.mock.calls.some(c => c === 'PUT customize'), `D14-1: 仮案の能力が無い接続先 →「接続先が非対応」で計画・生成・登録に進まない: ${JSON.stringify({ plan: a.m.calls.plan.length, gen: a.genCtx.length })}`);
  //   仮案から作っていない計画（Context ペインの「変更計画を作成」など）に生成コードがあっても、最終案の承認が無いので登録の準備をしない（従来の流れの登録を残さない）
  const legacyV = a.m.conv().registerPlan({ plan: clone(planRespL('承認待ちでは案件名を編集できないようにしたい').plan), ctx: null, review: null });
  legacyV.generated = { C1: { generated: { strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', code: LOCK_L, patch: null, events: ['app.record.edit.show'], fields: [{ code: 'case_name', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [] }, review: KTCodeReview.review({ generated: { strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', code: LOCK_L, patch: null, events: ['app.record.edit.show'], fields: [{ code: 'case_name', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [] }, customization: CUST_L, plan: null, data: clone(INPUTS.data), scan: null, existingSource: null }), existingSource: null } };
  const prL = await a.m.panel.startJsRegister(legacyV); await ticks(4);
  assert(prL && prL.status === 'BLOCKED' && prL.blockers.some(b => b.code === 'APPROVAL_REQUIRED') && !a.m.mock.calls.some(c => c === 'PUT customize'), `D14-1b: 仮案から作っていない計画の JavaScript は、最終案の承認が無いので登録しない（APPROVAL_REQUIRED）: ${JSON.stringify(prL && prL.blockers)}`);
  //   §0d.4（2026-10-08）: 既知の競合の判定は Toolkit の形式確認（error-cancels-edit）から生成工程へ移した。今の契約の Gateway は check behavior
  //   （checkReason candidate-error-same-event）にして模擬テストで確かめ、error で編集不可が取り消されれば不合格を返す（隔離環境の sandbox/test/run.mjs §3 R13）。
  //   Toolkit はその明示された失敗を取り込んで承認・登録しない。旧い接続先（生成工程が必須の効果に非対応）では結果の欠落（接続先が非対応）で承認しない
  const b0 = await run({ code: CONFLICT_L });
  const b = await run({ capable: true, code: CONFLICT_L, has: ['lock', 'warn'], cand: { fails: ['case_name|lock'], failMsg: '承認待ちの編集画面で、エラー表示のため編集不可が取り消されました', check: { 'case_name|lock': { check: 'behavior', checkReason: ['candidate-error-same-event', 'nested'], raw: true } } } });
  assert(b0.v && b0.v.final && b0.v.final.approvable === false && b0.v.generated.C1.status === 'unsupported' && b0.pr && b0.pr.status === 'BLOCKED' && !b0.m.mock.calls.some(c => c === 'PUT customize') && b.v.final.approvable === false && /取り消/.test(b.cannotText) && b.pr && b.pr.status === 'BLOCKED' && /APPROVAL_REQUIRED/.test(b.blockText) && !b.m.mock.calls.some(c => c === 'PUT customize'), `D14-2: 既知の競合（同じ handler の無条件の error と disabled）は承認・登録できない（今の契約の接続先では模擬テストの不合格・旧い接続先では結果の欠落）: ${b.cannotText.slice(0, 300)}`);
  const c = await run({ capable: true });
  const sentL = c.genCtx[0] && c.genCtx[0].verification && c.genCtx[0].verification.requiredEffects;
  assert(c.draft && c.draft.status === 'adopted' && sentL && sentL.length === 1 && sentL[0].field === 'case_name' && sentL[0].effect === 'lock' && c.v.final.approvable === true && c.v.approval && c.pr && c.pr.status === 'PREPARED' && c.applied && c.applied.run.ok && c.m.mock.calls.includes('PUT customize'), `D14-3: 仮案の流れで接続先が対応していれば必須の効果を渡し、合格した候補は［動作テスト環境へ反映］1 回で承認と登録まで進む: ${JSON.stringify({ sent: sentL, status: c.pr && c.pr.status, blockers: c.pr && c.pr.blockers })}`);
  const d = await run({ capable: true, has: ['warn'] });
  assert(d.v.final.approvable === false && /要件未達/.test(d.cannotText) && d.pr && d.pr.status === 'BLOCKED' && !d.m.mock.calls.some(c2 => c2 === 'PUT customize'), `D14-4: 生成工程が要件未達（編集不可が必要で警告だけ）を返した → 承認・登録しない: ${d.cannotText.slice(0, 300)}`);
});
// D15（レビュー B3・§0c.6）: 生成した AI の要件の達成の申告（PARTIAL・NOT_MET）。SUBTABLE_ROWS（計画の構造で分かる制約）は実現できない点として承認を止めない
//   簡素化 B（2026-10-17）: 以前は Toolkit が申告を検査にしていた（coverage-unmet。NOT_MET は登録不可・必須の効果に結び付く PARTIAL は要件未達に上げる）。
//   今は生成工程の機械検査の coverage（review。自分の要件の NOT_MET・PARTIAL）が承認の欄の確認事項にし、Toolkit は判定を作り直さない。
//   Toolkit は申告を計画の構造に対応づけ（範囲内・範囲外・担当）、明細の行の印（limitCode SUBTABLE_ROWS）を付けるだけ（最終案の「実現できない点」の文に使う）
await section(async () => {
  const gen = (code, coverage, fields = [{ code: 'amount', access: 'CONTROL' }]) => ({ strategy: 'NEW_JS_FILE', targetFile: 'lock.js', summary: 's', code, patch: null, events: ['app.record.edit.show'], fields, apis: [], assumptions: [], warnings: [], coverage });
  const GW_COV = { name: 'coverage', ok: false, severity: 'review', message: 'この JavaScript の要件のうち満たせないと申告されたものがあります: 一部だけ「承認待ちでは金額を編集不可にする」（申請者本人を除く条件は入れていません）' };
  const rvP = KTCodeReview.review({ generated: gen(GOOD, [{ requirementId: 'C1', status: 'PARTIAL', note: '申請者本人を除く条件は入れていません', text: '承認待ちでは金額を編集不可にする' }]), customization: CUST_C1, plan: null, data: clone(DATA_C), scan: null, existingSource: null });
  const m1 = KTCodeReview.attachBehavior(rvP, { ...VER_LOCK_OK, machine: [GW_COV] }, { requiredEffects: REQ_LOCK, customization: CUST_C1 });
  assert(!rvP.checks.some(ch => ch.name === 'coverage-unmet') && m1.registration.verdict === 'NEEDS_CONFIRMATION' && m1.registration.confirmations.some(x => x.code === 'coverage' && /一部だけ/.test(x.message) && x.howToCheck) && !m1.checks.some(ch => ch.partialRequired) && m1.registration.blockers.length === 0,
    `D15-1（簡素化 B）: 自分の要件の PARTIAL は、生成工程の coverage の確認事項（Toolkit は要件未達に上げない）: ${JSON.stringify(m1.checks.filter(ch => !ch.ok).map(ch => [ch.name, ch.severity]))}`);
  const rvO = KTCodeReview.review({ generated: gen(GOOD, [{ requirementId: 'C1', status: 'MET', note: '', text: 'x' }, { requirementId: 'P1', status: 'PARTIAL', note: '一覧の並び順は別の手順', text: '一覧の並び順' }]), customization: CUST_C1, plan: { steps: [{ id: 'P1', actionType: 'ADD_VIEW', title: '一覧' }], customizations: [CUST_C1] }, data: clone(DATA_C), scan: null, existingSource: null });
  const m3 = KTCodeReview.attachBehavior(rvO, VER_LOCK_OK, { requiredEffects: REQ_LOCK, customization: CUST_C1 });
  assert(m3.registration.verdict !== 'BLOCKED' && !m3.checks.some(ch => ch.partialRequired), `D15-2: 必須の効果に結び付かない（ほかの手順の）PARTIAL は要件未達にしない: ${JSON.stringify(m3.checks.filter(ch => !ch.ok).map(ch => [ch.name, ch.severity]))}`);
  // 明細のセルを編集不可にする計画で、生成工程が kintone の制約の印（coverage の limitCode SUBTABLE_ROWS）を付けた PARTIAL → SUBTABLE_ROWS（計画の構造）として実現できない点に出し、承認は止めない
  //   C-1 第 3 段（2026-10-08）: AI の申告の文（note の「行の追加・削除」）は読まない（ROW_LIMIT_RE は削除した）
  const CUST_T = custOf(null, { requirement: '承認待ちでは明細（items）のセルを編集不可にする', fields: [{ code: 'ステータス', access: 'READ' }, { code: 'items', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock'] }] });
  const TABLE = handlerC(`    if (${ST_C}) {\n      record['items'].value.forEach(function (row) {\n        row.value['qty'].disabled = true;\n      });\n    }`);
  const rvT = KTCodeReview.review({ generated: gen(TABLE, [{ requirementId: 'C1', status: 'PARTIAL', note: 'セルは編集不可にしますが、行の追加・削除は JavaScript では止められません', text: '承認待ちでは明細を編集不可', limitCode: 'SUBTABLE_ROWS' }], [{ code: 'items', access: 'CONTROL' }]), customization: CUST_T, plan: null, data: clone(DATA_C), scan: null, existingSource: null });
  const REQ_T = [{ requirementId: 'C1', requirementIds: ['C1'], field: 'items', effect: 'lock', events: ['app.record.edit.show'], condition: '' }];
  const VER_T = { requiredEffects: [{ requirementId: 'C1', field: 'items', effect: 'lock', status: 'present' }], behavior: { status: 'passed', reason: null, cases: [{ id: 'K1', requirementIds: ['C1'], field: 'items', effect: 'lock', expect: 'lock', event: 'app.record.edit.show', side: 'match', verdict: 'pass' }] } };
  const m2 = KTCodeReview.attachBehavior(rvT, VER_T, { requiredEffects: REQ_T, customization: CUST_T });
  const apT = rvT.coverage.notAchieved.find(x => x.code === 'AI_PARTIAL');
  assert(rvT.coverage.notAchieved.some(x => x.code === 'SUBTABLE_ROWS' && !x.fromLimitCode) && apT && apT.limit === 'SUBTABLE_ROWS' && m2.registration.verdict !== 'BLOCKED', `D15-3: limitCode SUBTABLE_ROWS の PARTIAL は「実現できない点」の印（登録不可にしない）: ${JSON.stringify({ ap: apT, verdict: m2.registration.verdict })}`);
  // D15-4: 同じ申告の文でも limitCode が無い（印の無い接続先・生成工程が制約と判定しない）PARTIAL は、文を読んで明細の行の制約にしない（印を付けない）
  const rvN = KTCodeReview.review({ generated: gen(TABLE, [{ requirementId: 'C1', status: 'PARTIAL', note: 'セルは編集不可にしますが、行の追加・削除は JavaScript では止められません', text: '承認待ちでは明細を編集不可' }], [{ code: 'items', access: 'CONTROL' }]), customization: CUST_T, plan: null, data: clone(DATA_C), scan: null, existingSource: null });
  const apN = rvN.coverage.notAchieved.find(x => x.code === 'AI_PARTIAL');
  assert(apN && !apN.limit && !rvN.checks.some(ch => ch.name === 'coverage-unmet'), `D15-4: limitCode の無い PARTIAL は申告の文（行の追加・削除）を読んで明細の行の制約にしない: ${JSON.stringify(apN)}`);
  // D15-5: NOT_MET の明細の行の印も limitCode だけで決める（文では決めない）。登録の可否は生成工程の coverage（Toolkit は検査にしない）
  const rvM = KTCodeReview.review({ generated: gen(TABLE, [{ requirementId: 'C1', status: 'NOT_MET', note: '行の追加・削除は止められません', text: '明細の行を増やせないようにする', limitCode: 'SUBTABLE_ROWS' }], [{ code: 'items', access: 'CONTROL' }]), customization: CUST_T, plan: null, data: clone(DATA_C), scan: null, existingSource: null });
  const rvM0 = KTCodeReview.review({ generated: gen(TABLE, [{ requirementId: 'C1', status: 'NOT_MET', note: '行の追加・削除は止められません', text: '明細の行を増やせないようにする' }], [{ code: 'items', access: 'CONTROL' }]), customization: CUST_T, plan: null, data: clone(DATA_C), scan: null, existingSource: null });
  const nM = rvM.coverage.notAchieved.find(x => x.code === 'AI_NOT_MET'), nM0 = rvM0.coverage.notAchieved.find(x => x.code === 'AI_NOT_MET');
  assert(nM && nM.limit === 'SUBTABLE_ROWS' && nM0 && !nM0.limit && ![rvM, rvM0].some(r => r.checks.some(ch => ch.name === 'coverage-unmet')), `D15-5: NOT_MET の明細の行の印は limitCode があるときだけ（Toolkit は検査にしない）: ${JSON.stringify({ nM, nM0 })}`);
  // D15-6: 入口（validateGenerated）は coverage の limitCode を落とさない（語彙は英大文字の語だけ）
  const vg = KTAiClient.validateGenerated({ ok: true, contractVersion: '2.1', generated: { strategy: 'NEW_JS_FILE', targetFile: 'a.js', code: 'x', coverage: [{ requirementId: 'C1', status: 'PARTIAL', note: 'n', limitCode: 'SUBTABLE_ROWS' }, { requirementId: 'C2', status: 'PARTIAL', note: 'n', limitCode: 'ないよう' }] } }, null);
  assert(vg.ok && vg.normalized.coverage[0].limitCode === 'SUBTABLE_ROWS' && !('limitCode' in vg.normalized.coverage[1]), `D15-6: validateGenerated は limitCode を保つ（語彙外は落とす）: ${JSON.stringify(vg.normalized && vg.normalized.coverage)}`);
});
// D16（レビュー B4・§0c.6）: READ 以外のフィールドがあるのに必須の効果が 0 件なら特定できない（準備未完了）。READ だけの JavaScript は止めない
await section(async () => {
  const r0 = KTAiConversation.requiredEffectsOf({ customizations: [{ customizationId: 'C1', events: [], fields: [{ code: 'amount', access: 'READ' }, { code: 'ステータス', access: 'READ' }] }] }, 'C1', [{ id: 'R1', target: '金額', decision: 'decided', disposition: 'adopted', planRefs: ['C1'] }]);
  const r1 = KTAiConversation.requiredEffectsOf({ customizations: [{ customizationId: 'C1', events: [], fields: [{ code: 'memo', access: 'SHOW_HIDE' }] }] }, 'C1', []);
  const r2 = KTAiConversation.requiredEffectsOf({ customizations: [{ customizationId: 'C1', events: [], fields: [{ code: 'amount', access: 'CONTROL', effects: [] }] }] }, 'C1', []);
  assert(r0.effects.length === 0 && r0.unresolved.length === 0 && r1.effects.length === 0 && r1.unresolved.length === 1 && r1.unresolved[0].reason === 'none' && r2.unresolved.length === 1 && r2.unresolved[0].reason === 'field-unspecified', `D16-1: READ だけは止めない・READ 以外があって効果 0 件は none・効果 [] の CONTROL は未特定: ${JSON.stringify({ r0, r1, r2 })}`);
  // 会話: 計画の効果も台帳も無い → 自動の差分更新 1 回 → 準備未完了。最終案は「必要な動作を特定できない」で承認できない
  const y = makeConvC({ planImpl: (args) => planJs(args, { cust: custOf(null), gatewayPlan: { plan: true } }) });
  await adoptC(y);
  const vy = y.c.activePlan();
  assert(y.calls.plan.length === 2 && y.calls.plan[1].focus.includes('C1') && y.gen.calls.length === 0 && vy.generated.C1.status === 'not-ready' && vy.final.approvable === false && vy.final.readiness.reasons.some(r => r.kind === 'effects-unknown') && y.c.metrics().effectRevisions === 1, `D16-2: 効果を特定できない → 自動の差分更新 1 回 → 準備未完了: ${JSON.stringify({ plans: y.calls.plan.length, reasons: vy.final.readiness.reasons })}`);
  // 必須の効果が生成工程の上限（20 件）を超える → 黙って落とさず、生成を呼ばずに準備未完了（件数の上限）
  const many = custOf(null, { fields: [{ code: 'ステータス', access: 'READ' }, ...Array.from({ length: 21 }, (_, i) => ({ code: `f${i + 1}`, access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock'] }))] });
  const z = makeConvC({ planImpl: (args) => planJs(args, { cust: many }) });
  await adoptC(z);
  const vz = z.c.activePlan();
  assert(z.gen.calls.length === 0 && vz.generated.C1.status === 'not-ready' && vz.generated.C1.verdict.kind === 'effects-limit' && vz.final.readiness.reasons.some(r => r.kind === 'effects-limit') && !vz.final.readiness.reasons.some(r => r.kind === 'effects-unknown') && vz.final.approvable === false, `D16-3: 必須の効果が 21 件 → 生成を呼ばずに準備未完了（件数の上限）: ${JSON.stringify({ gen: z.gen.calls.length, verdict: vz.generated.C1.verdict, reasons: vz.final.readiness.reasons })}`);
});
// D17（レビュー A2・§3・§0c.6）: 動作テストに渡せなかった既存 JS（Toolkit が外した・Gateway が落とした）が同じイベントを登録していれば、その効果は合格でも verified にしない
await section(async () => {
  const LIM = KTContext.RELATED_FILES;
  //   §0c.7（2026-10-08）: 1 ファイルの上限はやめ、4 件・合計 131,072 文字（伏字にした後の文字数）だけ（Gateway と同じ値）
  assert(LIM.max === 4 && LIM.totalChars === 131072 && !('maxChars' in LIM), `D17-0: 上限は Gateway と同じ（4 件・合計 131,072 文字・1 ファイルの上限なし）: ${JSON.stringify(LIM)}`);
  const er1 = KTCodeReview.effectResults(VER_LOCK_OK, REQ_LOCK, { omitted: [{ name: 'ext5.js', target: 'desktop', reason: 'limit', events: ['app.record.edit.show'] }] });
  const er2 = KTCodeReview.effectResults(VER_LOCK_OK, REQ_LOCK, { omitted: [{ name: 'list.js', target: 'desktop', reason: 'limit', events: ['app.record.index.show'] }] });
  const er3 = KTCodeReview.effectResults(VER_LOCK_OK, REQ_LOCK, { omitted: [{ name: 'luxon.min.js', target: 'desktop', reason: 'url', events: [] }] });
  const er4 = KTCodeReview.effectResults({ requiredEffects: VER_LOCK_OK.requiredEffects, behavior: { status: 'not-run', reason: 'partial', cases: [{ id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', verdict: 'not-run', reason: 'related-file-omitted', message: '' }] } }, REQ_LOCK);
  assert(!er1.ok && er1.notRun.length === 1 && er1.reasonCategory === 'existing' && er1.reason === 'related-file-omitted' && er1.omittedHit[0].name === 'ext5.js' && er2.ok && er3.ok && !er4.ok && er4.reasonCategory === 'existing', `D17-1: 同じイベントの既存 JS を渡せなかった → 未確認（既存 JS の区分）。関係しないイベント・イベントを登録しない外部のライブラリ（events []）は止めない。Gateway の related-file-omitted も同じ: ${JSON.stringify({ er1: [er1.ok, er1.reasonCategory], er2: er2.ok, er3: er3.ok, er4: [er4.ok, er4.reasonCategory] })}`);
  const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], relatedOmitted: [{ name: 'big.js', target: 'desktop', reason: 'limit', events: ['app.record.edit.show'] }] }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  //   §0c.9（2026-10-08）: 送れなかった既存 JS（件数の上限）は計画を直しても解けない → 操作を出さず「対応できない範囲」（理由とファイル名。詳細は詳細表示）
  assert(e.status === 'not-run' && e.verdict.kind === 'out-of-reach' && e.verdict.unfixable === true && !e.verdict.fix && !v.final.fix && /対応できない範囲/.test(e.verdict.reason) && /既存の JavaScript/.test(e.verdict.reason) && /「big\.js」/.test(e.verdict.reason) && /計画を直しても解けない/.test(e.verdict.next) && e.verdict.details.some(d => /「big\.js」: 模擬テストに渡せる既存の JavaScript の件数・文字数の上限/.test(d)) && !/実機/.test(e.verdict.next) && !/環境の制約/.test(v.final.blockingReason) && /既存の JavaScript と一緒の動き/.test(v.final.blockingReason) && !/実機で確かめる/.test(v.final.blockingReason) && v.final.approvable === false && x.gen.calls.length === 1 && !x.gen.calls[0].feedback, `D17-2: 送れなかった既存 JS が同じイベント → 動作テストは合格でも反映できない（理由は既存 JS・§0c.9: 対応できない範囲として出し操作は出さない（実機で確かめるとも出さない）・修復は依頼しない）: ${JSON.stringify({ status: e.status, verdict: e.verdict, reason: v.final.blockingReason })}`);
  // Generator Context: relatedFiles は 4 件まで・送れなかったものは relatedOmitted で Gateway にも知らせる
  const files = [1, 2, 3, 4, 5].map(i => ({ name: `f${i}.js`, target: 'desktop', text: `/* ${i} */` }));
  const ctx = KTContext.buildGenerator({ customization: CUST_C1, plan: { customizations: [CUST_C1] }, planId: 'p', version: 1, data: clone(DATA_C), verification: { requirementIds: [], requiredEffects: REQ_LOCK, relatedFiles: files, relatedOmitted: [{ name: 'f6.js', target: 'desktop', reason: 'limit', events: ['app.record.edit.show'] }] } });
  assert(ctx.verification.relatedFiles.length === 4 && ctx.verification.relatedOmitted.length === 1 && ctx.verification.relatedOmitted[0].name === 'f6.js' && ctx.verification.relatedOmitted[0].events[0] === 'app.record.edit.show', `D17-3: Generator Context の relatedFiles は 4 件まで・relatedOmitted を渡す: ${JSON.stringify({ n: ctx.verification.relatedFiles.length, omitted: ctx.verification.relatedOmitted })}`);
});
// D18（レビュー A8・§0c.6 の理由の語彙）: 実行できなかった理由は区分ごとに理由と次の方針を変える（環境 / 条件の形 / 件数の上限 / 既存の JavaScript / 機械検査で未実行 / 対象外）
await section(async () => {
  const run = async (o) => { const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], ...o }) }); await adoptC(x); return x; };
  const c1 = await run({ env: 'condition-unparsed' });
  const e1 = c1.c.activePlan().generated.C1, f1 = c1.c.activePlan().final;
  assert(e1.status === 'not-run' && e1.verdict.kind === 'condition' && /条件の形/.test(e1.verdict.reason) && /計画の条件/.test(e1.verdict.next) && !/環境/.test(e1.verdict.reason) && !/環境の制約/.test(f1.blockingReason) && /計画の条件を直します/.test(f1.blockingReason) && c1.gen.calls.length === 1, `D18-1: 条件を読めない → 「条件の形」・次の方針は計画を直す（環境とは言わない）: ${JSON.stringify({ verdict: e1.verdict, reason: f1.blockingReason })}`);
  const c2 = await run({ env: 'limit' });
  const e2 = c2.c.activePlan().generated.C1;
  assert(e2.verdict.kind === 'limit' && /件数の上限/.test(e2.verdict.reason) && /分けるか/.test(e2.verdict.next), `D18-2: 代表条件の上限 → 「件数の上限」・次の方針は計画を分ける・絞る: ${JSON.stringify(e2.verdict)}`);
  //   §0c.10（2026-10-08）: existing は隔離環境で競合を観測したときだけ（次の手は計画を直す）。既存 JS の handler の例外（旧い名前 existing-exception・existing-unrunnable）は
  //   計画を直しても解けないので、操作を出さず「対応できない範囲」（実機で確かめるとは出さない）
  const c3 = await run({ env: 'existing' });
  assert(c3.c.activePlan().generated.C1.verdict.kind === 'existing' && /計画を直します/.test(c3.c.activePlan().generated.C1.verdict.next) && !/実機/.test(c3.c.activePlan().generated.C1.verdict.next), `D18-3: 既存 JS との競合 → 「既存の JavaScript」・次の方針は計画を直す（実機で確かめるとは出さない）: ${JSON.stringify(c3.c.activePlan().generated.C1.verdict)}`);
  const c3b = await run({ env: 'existing-exception' });
  const v3b = c3b.c.activePlan().generated.C1.verdict;
  assert(v3b.kind === 'out-of-reach' && !v3b.fix && !c3b.c.activePlan().final.fix && /対応できない範囲/.test(v3b.reason) && !/実機/.test(v3b.next), `D18-3b: 既存 JS の handler の例外（旧い名前）→ 操作なしの「対応できない範囲」: ${JSON.stringify(v3b)}`);
  const c4 = await run({ sequence: ['warn'], env: 'machine-blocked' });
  const e4 = c4.c.activePlan().generated.C1, nr4 = e4.review.checks.find(ch => ch.name === 'behavior-not-run');
  assert(e4.verdict.kind === 'missing' && nr4 && nr4.category === 'machine' && !nr4.environment && !/環境/.test(nr4.message) && /機械検査/.test(nr4.message), `D18-4: 要件未達で動作テストは機械検査で未実行 → 詳細に「環境」と並べない: ${JSON.stringify({ verdict: e4.verdict.kind, check: nr4 })}`);
  const c5 = await run({ extraCases: [{ id: 'K9', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', verdict: 'not-run', reason: 'not-on-create', message: '' }] });
  assert(c5.c.activePlan().generated.C1.status === 'verified' && c5.c.activePlan().final.approvable === true, `D18-5: 対象外（作成画面に当たらない）の代表条件は判定に数えない（ほかの代表条件が合格なら合格）: ${JSON.stringify(c5.c.activePlan().generated.C1.verdict)}`);
  const c6 = await run({ env: 'unknown-reason-x' });
  const h6 = outsideDetails(finalHtml(c6));
  assert(c6.c.activePlan().generated.C1.verdict.kind === 'other' && !/unknown-reason-x/.test(h6) && c6.c.activePlan().generated.C1.verdict.details.some(d => /unknown-reason-x/.test(d)), `D18-6: 語彙外の理由は「そのほか」・理由の名前は詳細表示だけ: ${JSON.stringify(c6.c.activePlan().generated.C1.verdict)}`);
});
// D18-7: 理由の語彙（契約 20 §13・§0c.6）を区分ごとに持つ
assert(Object.entries({ env: ['timeout', 'memory', 'internal', 'unavailable', 'not-configured'], condition: ['condition-unparsed'], limit: ['limit'], existing: ['existing', 'related-file-omitted', 'existing-lock-unverified'], machine: ['machine-blocked', 'patch-not-applicable'], scope: ['no-event', 'not-on-create', 'no-cases'] }).every(([cat, rs]) => rs.every(r => KTAiConversation.BEHAVIOR_REASONS[r] && KTAiConversation.BEHAVIOR_REASONS[r].category === cat && KTAiConversation.REASON_CATEGORY[cat].next)), 'D18-7: §0c.6 の理由の語彙（環境・条件の形・件数・既存 JS・機械検査で未実行・対象外）を区分と次の方針つきで持つ（other-platform は §0c.7 で条件の形に移した。D22 で確かめる）');
// D19（レビュー B5）: 本文を解析できない（unchecked）は missing（要件未達）ではなく未確認として表示する
await section(async () => {
  const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], statusOverride: 'unchecked' }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1, text = stripC(rightOf(x));
  assert(e.status === 'unverified' && /解析できませんでした/.test(e.verdict.reason) && !/要件未達/.test(e.verdict.reason) && v.final.verification.effects[0].structure === 'unchecked' && /解析できません（未確認）/.test(text) && !/処理なし（要件未達）/.test(text) && v.final.approvable === false, `D19: unchecked → 未確認（要件未達と表示しない・反映はできない）: ${JSON.stringify({ status: e.status, verdict: e.verdict })}`);
});
// D20（レビュー 8・§0c.6 の担当）: 担当は構造（planRefs）だけで決める。生成 AI の coverage の MET は担当として数えない
//   簡素化 C（2026-10-16）: 対応づけの無い決まった要件は止めずに確認の限界にする。MET の申告でその確認を消さない（実現した扱いにしない）
await section(async () => {
  const OWN2 = { op: 'add', target: '承認', condition: '', behavior: '7 営業日以内に承認する', exceptions: [], decision: 'decided', disposition: 'unresolved', sourceQuotes: ['7営業日で'], planRefs: [], effects: [], note: '' };
  let hold = null;
  const genMET = (cust) => ({ strategy: 'NEW_JS_FILE', targetFile: 'lock.js', summary: '承認待ちでは金額を編集不可にします。', code: GOOD, patch: null, events: cust.events, fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '', text: cust.requirement }, ...hold.c.requirements(hold.c.activePlan().planId).filter(r => r.behavior === OWN2.behavior).map(r => ({ requirementId: r.id, status: 'MET', note: '', text: r.behavior }))] });
  const y = makeConvC({ planImpl: (args) => planJs(args, { requirementOps: args.revision ? [] : [OWN2] }), generate: makeGenerate({ generatedOf: genMET }) });
  hold = y;
  await adoptC(y);
  const vy = y.c.activePlan();
  const metIds = (vy.generated.C1.generated.coverage || []).filter(cv => cv.status === 'MET').map(cv => cv.requirementId);
  const rid20 = (y.c.requirements(vy.planId).find(r => r.behavior === OWN2.behavior) || {}).id;
  assert(!!rid20 && metIds.includes(rid20) && vy.final.approvable === true && (vy.final.unconfirmedReqs || []).some(u => u.requirementId === rid20) && y.calls.plan.length === 1, `D20: AI が MET と申告しても planRefs の無い決まった要件は実現した扱いにしない（確認の限界のまま。止めない）: ${JSON.stringify({ metIds, unconf: (vy.final.unconfirmedReqs || []).map(u => u.requirementId), plans: y.calls.plan.length })}`);
});
// D21（レビュー B6）: 警告の「保存は止めない」代表条件の説明は構造化した値から作る（作成画面・編集画面を取り違えた説明を出さない）
await section(async () => {
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: custOf(['warn'], { requirement: '承認待ちでは金額に警告を出す（保存は止めない）' }), summary: '承認待ちでは金額に警告を出します（保存は止めません）。' }), generate: makeGenerate({ sequence: ['warn'], extraCases: [{ id: 'K2', requirementIds: ['C1'], field: 'amount', effect: 'warn', expect: 'save-allowed', event: 'app.record.edit.submit', note: '作成画面の空のレコードで編集画面で保存する', verdict: 'pass', message: '期待どおり' }] }) });
  await adoptC(x);
  const html = rightOf(x), text = stripC(html);
  assert(x.c.activePlan().generated.C1.status === 'verified' && /「金額」: 警告が出ても保存できる（保存は止めない）/.test(text) && !/作成画面の空のレコードで編集画面で保存する/.test(text), `D21: 「保存は止めない」の代表条件は「警告が出ても保存できる」と出し、取り違えた説明を出さない: ${JSON.stringify(x.c.activePlan().final.verification.behavior.cases)}`);
});
// 追加指示 §5 の表の 9 行は、§0c.6 の修正の後も上の D1〜D9 で同じ期待のまま確かめている（期待値は弱めていない。D3 は AI の申告を MET にした候補で 3 行目を確かめ、PARTIAL の申告は D3-4 で要件未達）
// ---- §0c.7（2026-10-08）: 3 回目の独立レビュー（効果の区別・担当間の契約・隔離環境）の再現と回帰 ----
// D22（レビュー rv3/tk.cjs の T-c・T-e・T-f・T-g・T-i の再現）: Toolkit の純関数の結果が §0c.7 の決定どおり
await section(async () => {
  const labels = { amount: '金額', memo: '備考', 'ステータス': 'ステータス' };
  // T-c（A7）: 計画の amount は「いつでも」の値の設定と条件つきの編集不可・フィールドの condition は空。台帳の保存禁止は計画に無い → 「いつでも」にせず condition-unknown
  const planC = { customizations: [{ customizationId: 'C1', strategy: 'NEW_JS_FILE', events: ['app.record.edit.show', 'app.record.edit.submit'], fields: [{ code: 'amount', access: 'CONTROL', effects: [{ effect: 'set-value', condition: '' }, { effect: 'lock', condition: 'ステータス in ("承認済")' }] }] }] };
  const rc = KTAiConversation.requiredEffectsOf(planC, 'C1', [{ id: 'R1', target: 'amount', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects: ['block-save'], condition: '承認済みのとき' }], { labels });
  assert(!rc.effects.some(e => e.effect === 'block-save') && rc.unresolved.length === 1 && rc.unresolved[0].reason === 'condition-unknown' && rc.unresolved[0].requirementId === 'R1' && rc.unresolved[0].effect === 'block-save', `D22-1（T-c・A7）: 要件から足す保存禁止の条件が分からない → 「いつでも」にせず unresolved（condition-unknown）: ${JSON.stringify(rc)}`);
  // 条件つきの効果が無いフィールド（フィールドの condition も空）は、従来どおり計画の「いつでも」で足す（条件が分からないとはしない）
  const planC2 = { customizations: [{ customizationId: 'C1', strategy: 'NEW_JS_FILE', events: ['app.record.edit.submit'], fields: [{ code: 'amount', access: 'CONTROL', effects: [{ effect: 'lock', condition: '' }] }] }] };
  const rc2 = KTAiConversation.requiredEffectsOf(planC2, 'C1', [{ id: 'R1', target: 'amount', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects: ['block-save'] }], { labels });
  assert(rc2.unresolved.length === 0 && rc2.effects.some(e => e.effect === 'block-save' && e.condition === '' && e.requirementIds.includes('R1')), `D22-2: 条件つきの効果が無いフィールドには、計画の「いつでも」のまま足す: ${JSON.stringify(rc2)}`);
  // T-e（B2）: no-other-value は対象外（判定に数えない）
  const req1 = [{ requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect: 'warn', events: ['app.record.edit.show', 'app.record.edit.submit'], condition: 'amount >= 1000000' }];
  const verE = { requiredEffects: [{ requirementIds: ['C1'], field: 'amount', effect: 'warn', status: 'present' }], behavior: { status: 'not-run', reason: 'no-other-value', cases: [
    //   §0c.9: イベントごとに合う・合わない（保存のイベントの合う側は警告の保存 save-allowed）。保存のイベントの「合わない」は作れない（no-other-value・対象外）
    { id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'warn', expect: 'warn', event: 'app.record.edit.show', side: 'match', verdict: 'pass' }, { id: 'K2', requirementIds: ['C1'], field: 'amount', effect: 'warn', expect: 'not-warned', event: 'app.record.edit.show', side: 'nomatch', verdict: 'pass' },
    { id: 'K3', requirementIds: ['C1'], field: 'amount', effect: 'warn', expect: 'save-allowed', kind: 'warn-save', event: 'app.record.edit.submit', side: 'match', verdict: 'pass' },
    { id: 'S1', requirementIds: ['C1'], field: 'amount', effect: 'warn', expect: 'save-allowed', event: 'app.record.edit.submit', side: 'nomatch', verdict: 'not-run', reason: 'no-other-value', reasonCategory: 'out-of-scope' }] } };
  const ee = KTCodeReview.effectResults(verE, req1);
  assert(ee.ok && ee.items[0].behavior === 'pass' && KTAiConversation.BEHAVIOR_REASONS['no-other-value'].category === 'scope', `D22-3（T-e・B2）: no-other-value は対象外（そのほか・停止にしない）: ${JSON.stringify({ ok: ee.ok, items: ee.items.map(i => [i.behavior, i.notRunReasons]), cat: ee.reasonCategory })}`);
  // T-f（B1）: 送れなかった既存 JS の events が null（分からない）→ その platform のすべての必須の効果を verified にしない。[]（外部のライブラリ）は止めない
  const req2 = [{ requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect: 'lock', events: ['app.record.edit.show'], condition: 'ステータス = "承認済"' }];
  const verF = { requiredEffects: [{ requirementIds: ['C1'], field: 'amount', effect: 'lock', status: 'present' }], behavior: { status: 'passed', reason: null, cases: [{ id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', event: 'app.record.edit.show', side: 'match', verdict: 'pass' }, { id: 'K2', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'not-locked', event: 'app.record.edit.show', side: 'nomatch', verdict: 'pass' }] } };
  const efNull = KTCodeReview.effectResults(verF, req2, { omitted: [{ name: 'biz.js', target: 'desktop', reason: 'url', events: null }] });
  const efMob = KTCodeReview.effectResults(verF, req2, { omitted: [{ name: 'm.js', target: 'mobile', reason: 'no-source', events: null }] });
  const efLib = KTCodeReview.effectResults(verF, req2, { omitted: [{ name: 'luxon.min.js', target: 'desktop', reason: 'url', events: [] }] });
  assert(!efNull.ok && efNull.items[0].behavior === 'not-run' && efNull.reasonCategory === 'existing' && efNull.reason === 'related-file-omitted' && efNull.omittedHit[0].name === 'biz.js' && efMob.ok && efLib.ok, `D22-4（T-f・B1・隔離 7）: events null は同じ platform の全部の効果を verified にしない・別の platform と [] は止めない: ${JSON.stringify({ nul: [efNull.ok, efNull.reasonCategory], mob: efMob.ok, lib: efLib.ok })}`);
  // T-g（A4）: 既存 JS の区分の次の手は「計画を直す」（実機で確かめるとは出さない）
  const verG = { requiredEffects: verF.requiredEffects, behavior: { status: 'not-run', reason: 'existing', cases: [{ id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', verdict: 'not-run', reason: 'existing' }, { id: 'K2', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'not-locked', verdict: 'pass' }] } };
  const eg = KTCodeReview.effectResults(verG, req2);
  const nextG = KTAiConversation.REASON_CATEGORY[eg.reasonCategory].next;
  assert(!eg.ok && eg.reasonCategory === 'existing' && /計画を直します/.test(nextG) && /既存の JavaScript に統合する/.test(nextG) && /既存の処理を見直す/.test(nextG) && !/実機/.test(nextG), `D22-5（T-g・A4）: 既存 JS の区分の次の手は計画を直す: ${nextG}`);
  // T-i（B3）: Gateway が other-platform で返した代表条件は「条件の形」で判定に数える（PC だけ合格でも verified にしない）
  const req4 = [{ requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect: 'lock', events: ['app.record.edit.show', 'mobile.app.record.edit.show'], condition: 'ステータス = "承認済"' }];
  const verI = { requiredEffects: verF.requiredEffects, behavior: { status: 'not-run', reason: 'other-platform', cases: [
    { id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', event: 'app.record.edit.show', verdict: 'pass' },
    { id: 'K3', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', event: 'mobile.app.record.edit.show', verdict: 'not-run', reason: 'other-platform' }] } };
  const ei = KTCodeReview.effectResults(verI, req4);
  assert(!ei.ok && ei.items[0].behavior === 'not-run' && ei.reasonCategory === 'condition' && KTAiConversation.BEHAVIOR_REASONS['other-platform'].category === 'condition', `D22-6（T-i・B3）: other-platform は条件の形で判定に数える（verified にしない）: ${JSON.stringify({ ok: ei.ok, items: ei.items.map(i => [i.behavior, i.notRunReasons]), cat: ei.reasonCategory })}`);
  // 理由の語彙: unsupported-feature（機械検査の BigInt など）は環境、ignored（記録だけ）は合格に数えない
  assert(KTAiConversation.BEHAVIOR_REASONS['unsupported-feature'].category === 'env' && KTAiConversation.BEHAVIOR_REASONS.ignored && KTAiConversation.BEHAVIOR_REASONS.ignored.category !== 'scope', 'D22-7（B2）: 理由の語彙に unsupported-feature（環境）と ignored（合格に数えない）を持つ');
});
// D23（A5・効果ごとのイベント）: 計画の効果の events を読む（無ければ customization の events）。保存だけの警告と画面の編集不可を同じ customization に持てる
await section(async () => {
  const plan = { proposedFields: [{ temporaryId: 'NEW_FIELD_1', suggestedCode: 'approver_note', label: '承認メモ', type: 'SINGLE_LINE_TEXT' }], customizations: [{ customizationId: 'C1', requirement: 'r', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.edit.show', 'app.record.edit.submit', 'app.record.edit.change.NEW_FIELD_1'], fields: [
    { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済")', effects: [{ effect: 'lock', condition: '', events: ['app.record.edit.show'] }] },
    { code: 'memo', access: 'CONTROL', effects: [{ effect: 'warn', condition: 'memo = ""', events: ['app.record.edit.submit'] }] },
    { code: 'NEW_FIELD_1', access: 'CONTROL', effects: [{ effect: 'set-value', condition: '', events: ['app.record.edit.change.NEW_FIELD_1'] }] },
    { code: 'ステータス', access: 'READ', effects: [] }] }] };
  const r = KTAiConversation.requiredEffectsOf(plan, 'C1', [], { labels: LABELS_C });
  const of = (f, e) => r.effects.find(x => x.field === f && x.effect === e) || {};
  assert(r.unresolved.length === 0 && JSON.stringify(of('amount', 'lock').events) === JSON.stringify(['app.record.edit.show']) && JSON.stringify(of('memo', 'warn').events) === JSON.stringify(['app.record.edit.submit']) && JSON.stringify(of('approver_note', 'set-value').events) === JSON.stringify(['app.record.edit.change.approver_note']), `D23-1: 必須の効果のイベントは効果ごと（保存だけの警告は保存だけ・新設フィールドの change は採番後のコード）: ${JSON.stringify(r.effects.map(x => [x.field, x.effect, x.events]))}`);
  const ctx = KTContext.buildGenerator({ customization: plan.customizations[0], plan, planId: 'p', version: 1, data: clone(DATA_C), verification: { requirementIds: [], requiredEffects: r.effects } });
  const cf = (code) => ctx.customization.fields.find(f => f.code === code) || {};
  assert(JSON.stringify(cf('memo').effects) === JSON.stringify([{ effect: 'warn', condition: 'memo = ""', events: ['app.record.edit.submit'] }]) && JSON.stringify(cf('approver_note').effects[0].events) === JSON.stringify(['app.record.edit.change.approver_note']) && ctx.customization.events.includes('app.record.edit.change.approver_note'), `D23-2: Generator Context の customization.fields[].effects にも効果ごとのイベント（採番後のコード）: ${JSON.stringify(ctx.customization.fields)}`);
  // 計画の正規化: 効果のイベントが customization の events に無ければ足して記録する
  const CUSTV = { customizationId: 'C1', requirement: '備考が空なら保存のときに確認', whyStandardInsufficient: 'w', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'case_name', access: 'CONTROL', effects: [{ effect: 'warn', condition: '', events: ['app.record.edit.submit'] }] }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [] };
  const b = PLAN_V1('g');
  const pv = KTAiClient.validatePlan({ ...b, plan: { ...b.plan, solution: 'CUSTOMIZATION', steps: [mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { title: 'JavaScript', solution: 'CUSTOMIZATION' })], customizations: [CUSTV] } }, { goal: 'g' });
  const nc = pv.ok ? pv.normalized.customizations[0] : null;
  assert(nc && nc.events.includes('app.record.edit.submit') && JSON.stringify(nc.fields[0].effects) === JSON.stringify([{ effect: 'warn', condition: '', events: ['app.record.edit.submit'] }]) && pv.warnings.some(w => w.code === 'CUSTOMIZATION_EFFECT_EVENTS_ADDED'), `D23-3: 効果のイベントは customization の events に足し、正規化の記録を残す: ${JSON.stringify({ ok: pv.ok, events: nc && nc.events, warnings: (pv.warnings || []).map(w => w.code) })}`);
  // 会話: 保存だけの警告と画面の編集不可を同じ customization に持つ計画 → 生成工程に渡す必須の効果はイベントが効果ごと（以前は全部の効果に customization の events）
  const CUST_M = custOf(null, { events: ['app.record.edit.show', 'app.record.edit.submit'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: [{ effect: 'lock', condition: '', events: ['app.record.edit.show'] }] }, { code: 'memo', access: 'CONTROL', effects: [{ effect: 'warn', condition: 'memo = ""', events: ['app.record.edit.submit'] }] }] });
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_M }), generate: makeGenerate({ sequence: ['locksave'] }) });
  await adoptC(x);
  const sent = (x.gen.calls[0] && x.gen.calls[0].requiredEffects) || [];
  assert(sent.length === 2 && JSON.stringify(sent.find(e => e.field === 'memo').events) === JSON.stringify(['app.record.edit.submit']) && JSON.stringify(sent.find(e => e.field === 'amount').events) === JSON.stringify(['app.record.edit.show']), `D23-4: 会話から生成工程へ渡す必須の効果も効果ごとのイベント: ${JSON.stringify(sent.map(e => [e.field, e.effect, e.events]))}`);
});
// D24（B3・他の platform）: 効果のイベントを候補の platform に絞る。別の platform のイベントは同じフィールド・効果を担当するその platform の customization に任せる。担当が無ければ unresolved（other-platform）
await section(async () => {
  const EV2 = ['app.record.edit.show', 'mobile.app.record.edit.show'];
  const extPc = { customizationId: 'C1', requirement: 'r', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop', 'mobile'], existingFiles: [{ name: 'common.js', target: 'desktop' }], events: EV2, fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済")', effects: [{ effect: 'lock', condition: '' }] }, { code: 'ステータス', access: 'READ', effects: [] }] };
  const r1 = KTAiConversation.requiredEffectsOf({ customizations: [extPc] }, 'C1', [], { labels: LABELS_C });
  assert(r1.effects.length === 1 && JSON.stringify(r1.effects[0].events) === JSON.stringify(['app.record.edit.show']) && r1.unresolved.length === 1 && r1.unresolved[0].reason === 'other-platform' && JSON.stringify(r1.unresolved[0].platforms) === JSON.stringify(['mobile']), `D24-1: EXTEND の PC のファイルにモバイルのイベント・モバイルの担当なし → PC のイベントだけ必須にし、モバイルは unresolved（other-platform）: ${JSON.stringify(r1)}`);
  const mob = { customizationId: 'C2', requirement: 'r', strategy: 'NEW_JS_FILE', platform: ['mobile'], events: ['mobile.app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済")', effects: [{ effect: 'lock', condition: '' }] }] };
  const r2 = KTAiConversation.requiredEffectsOf({ customizations: [extPc, mob] }, 'C1', [], { labels: LABELS_C });
  const r3 = KTAiConversation.requiredEffectsOf({ customizations: [extPc, mob] }, 'C2', [], { labels: LABELS_C });
  assert(r2.unresolved.length === 0 && JSON.stringify(r2.effects[0].events) === JSON.stringify(['app.record.edit.show']) && r2.delegated.length === 1 && r2.delegated[0].customizationId === 'C2' && r3.unresolved.length === 0 && JSON.stringify(r3.effects[0].events) === JSON.stringify(['mobile.app.record.edit.show']), `D24-2: モバイルを担当する別の customization（C2）があれば任せる（C1 は PC だけ・C2 はモバイルで確かめる）: ${JSON.stringify({ c1: r2, c2: r3.effects })}`);
  // 会話: 担当の無い other-platform → 自動の差分更新 1 回 → それでも残れば準備未完了（生成しない・理由は読み込まれない画面）
  const CUST_P = custOf(null, { events: ['app.record.edit.show', 'mobile.app.record.edit.show'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock'] }] });
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_P, gatewayPlan: { plan: true } }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  assert(x.calls.plan.length === 2 && x.calls.plan[1].revision && /other-platform/.test(x.calls.plan[1].request) && x.gen.calls.length === 0 && e.status === 'not-ready' && /読み込まれない画面（モバイル）/.test(e.verdict.reason) && /1 回自動で依頼しました/.test(e.verdict.next) && v.final.approvable === false && x.finals().length === 1, `D24-3: 担当の無い別の platform のイベント → 自動の差分更新 1 回 → 準備未完了: ${JSON.stringify({ plans: x.calls.plan.length, gen: x.gen.calls.length, verdict: e.verdict })}`);
  // 会話: 生成工程が other-platform を返した → 「条件の形」の区分で準備未完了。次の手は読み込まれる画面の見直し（環境・実機とは言わない）
  const y = makeConvC({ generate: makeGenerate({ sequence: ['good'], env: 'other-platform' }) });
  await adoptC(y);
  const ey = y.c.activePlan().generated.C1, fy = y.c.activePlan().final;
  assert(ey.status === 'not-run' && ey.verdict.category === 'condition' && /その画面（PC \/ モバイル）を担当する JavaScript/.test(ey.verdict.next) && /読み込まれない画面/.test(fy.blockingReason) && !/環境の制約/.test(fy.blockingReason) && !/実機/.test(ey.verdict.next) && fy.approvable === false && y.gen.calls.length === 1, `D24-4: other-platform の not-run → 条件の形・次の手は画面の担当の見直し: ${JSON.stringify({ verdict: ey.verdict, reason: fy.blockingReason })}`);
});
// D25（A7・会話）: 要件から足す効果の条件が分からない → 自動の差分更新 1 回 → それでも残れば準備未完了（「いつでも」の期待で生成しない）
await section(async () => {
  const CUST_K = custOf(null, { events: ['app.record.edit.show', 'app.record.edit.submit'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', effects: [{ effect: 'set-value', condition: '' }, { effect: 'lock', condition: 'ステータス in ("承認待ち")' }] }] });
  const opK = { op: 'add', target: '金額', condition: '承認待ち', behavior: '保存できないようにする', exceptions: [], decision: 'proposed', disposition: 'adopted', sourceQuotes: [], planRefs: ['C1'], effects: ['block-save'], note: '' };
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_K, gatewayPlan: { plan: true }, requirementOps: args.revision ? [] : [opK] }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  assert(x.calls.plan.length === 2 && /condition-unknown/.test(x.calls.plan[1].request) && x.gen.calls.length === 0 && e.status === 'not-ready' && /どの条件で行うかが計画にありません/.test(e.verdict.reason) && v.final.approvable === false, `D25: 条件の分からない追加の効果 → 自動の差分更新 1 回 → 準備未完了（生成しない）: ${JSON.stringify({ plans: x.calls.plan.length, gen: x.gen.calls.length, verdict: e.verdict })}`);
});
// D26（A4・次の手）: 承認できない状態で「実機で確かめる」を次の手に出さない（区分を問わない。カード・準備未完了の理由・登録の判定の文）
await section(async () => {
  for (const env of ['existing', 'related-file-omitted', 'timeout', 'condition-unparsed', 'limit']) {
    const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], env }) });
    await adoptC(x);
    const v = x.c.activePlan(), e = v.generated.C1, text = stripC(finalHtml(x)) + stripC(rightOf(x));
    const unv = (e.review.registration.unverified || []).map(u => u.message).join('／');
    assert(v.final.approvable === false && !/実機で確かめ|実機（動作テスト環境）で確かめ/.test(`${e.verdict.next}${v.final.blockingReason}`) && !/反映した後、動作テスト環境で確かめること/.test(text) && /反映できない点が残っているため、まだ実機で確かめる段階ではありません/.test(text) && !/登録した後、動作テスト環境で確かめてください/.test(unv), `D26（${env}）: 承認できない最終案に「実機で確かめる」「反映した後に確かめること」「登録した後に確かめる」を出さない: ${JSON.stringify({ next: e.verdict.next, reason: v.final.blockingReason, unv })}`);
  }
  const ok = makeConvC();
  await adoptC(ok);
  assert(ok.c.activePlan().final.approvable === true && /反映した後、動作テスト環境で確かめること/.test(stripC(rightOf(ok))), 'D26-ok: 承認できる最終案には、反映した後に実機で確かめることを出す（従来どおり）');
});
// D27（B4・能力の見分け）: health の customization-generator.verification に 6 つの印がすべてあるときだけ新しい形で送る。欠ければ「接続先が非対応」
await section(async () => {
  assert(GEN_EFFECT_FEATURES.every(f => ['requiredEffects', 'effectGroups', 'relatedOmitted', 'appFields', 'saveDialog', 'reasonCategory', 'caseSide', 'eventCases', 'loadFaithful', 'registrationCheck', 'emptyCase', 'hideCondition', 'registrationCounts', 'caseCoverage', 'cancelCheck', 'limitCode', 'scopeList', 'tableRowChange', 'caseInvalid'].includes(f)) && GEN_EFFECT_FEATURES.length === 19, 'D27-0: 印は requiredEffects・effectGroups・relatedOmitted・appFields・saveDialog・reasonCategory・caseSide（§0c.9）・eventCases・loadFaithful・registrationCheck・emptyCase・hideCondition（§0c.10）・registrationCounts・caseCoverage（§0c.11）・cancelCheck・limitCode（C-1 第 3 段）・scopeList（C-1 第 4 段）・tableRowChange・caseInvalid（2026-10-10）');
  //   2026-10-10（誤った検証による修復の繰り返しを止める §5.2）: 17 個 → 19 個。テーブル自体の変更の組み立て（tableRowChange）と壊れた入力の not-run（caseInvalid）が無い Gateway は、
  //   壊れた模擬テストの入力で正しい候補を不合格にして修復を繰り返す形のままなので、新しい形として受け入れない（前の期待 17 個はこの不具合の前の契約）
  // 会話: 印が requiredEffects だけ（3d7adb6 の段階の Gateway）→ 結果が返っても「接続先が非対応」で準備未完了
  const x = makeConvC({ supported: ['requiredEffects'] });
  await adoptC(x);
  const e = x.c.activePlan().generated.C1;
  assert(e.status === 'unsupported' && e.verdict.kind === 'capability' && /接続先/.test(e.verdict.reason) && x.c.activePlan().final.approvable === false, `D27-1: 印が欠ける接続先 → 接続先が非対応（準備未完了）: ${JSON.stringify(e.verdict)}`);
  for (const miss of ['effectGroups', 'relatedOmitted', 'appFields', 'saveDialog', 'reasonCategory']) {
    const y = makeConvC({ supported: GEN_EFFECT_FEATURES.filter(f => f !== miss) });
    await adoptC(y);
    assert(y.c.activePlan().generated.C1.status === 'unsupported', `D27-2（${miss} が無い）: 1 つでも欠ければ接続先が非対応`);
  }
  //   簡素化 B（2026-10-16）: 生成工程の検証結果が無い（検証を返さない接続先。画面の generate が作る古い形 legacy）は、必須の動作が無い JavaScript（読み取りだけ）でも
  //   Toolkit の形式確認だけで検証済みにしない（以前は必須の効果が無いと、この判定を通り抜けて検証済みになった）
  const CUST_READ = { ...CUST_C1, requirement: '詳細画面でステータスを読む', events: ['app.record.detail.show'], fields: [{ code: 'ステータス', access: 'READ' }] };
  const CODE_READ = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.detail.show'], function (event) {\n    const st = event.record['ステータス'].value;\n    return event;\n  });\n})();";
  const genRead = (shape) => {
    const g = makeGenerate({ generatedOf: (cust) => ({ strategy: 'NEW_JS_FILE', targetFile: 'read.js', summary: '詳細画面でステータスを読みます。', code: CODE_READ, patch: null, events: cust.events, fields: [{ code: 'ステータス', access: 'READ' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '', text: cust.requirement }] }) });
    const impl0 = g.impl;
    g.impl = async (args) => { const r = await impl0(args); return { ...r, verification: shape === 'none' ? undefined : { version: '0', candidateHash: r.verification.candidateHash, sameAsPrevious: false, passed: true, machine: [], repairs: { count: 0, reasons: [], stoppedBy: null }, unverified: [], legacy: true } }; };
    return g;
  };
  for (const shape of ['none', 'legacy']) {
    const z = makeConvC({ generate: genRead(shape), planImpl: (args) => planJs(args, { cust: CUST_READ, summary: '詳細画面でステータスを読みます。' }) });
    await adoptC(z);
    const vz = z.c.activePlan(), ez = vz.generated.C1;
    assert(z.gen.calls.length === 1 && !(ez.requiredEffects || []).length && ez.status === 'unsupported' && ez.verdict.kind === 'capability' && /検証結果を返さない/.test(ez.verdict.reason) && vz.final.approvable === false && z.c.approveFinal({ planId: vz.planId, version: vz.version }).ok === false,
      `D27-3（${shape === 'none' ? '検証結果が無い' : '古い形の合格'}）: 必須の動作が無い JavaScript でも、生成工程の検証結果が無ければ検証済みにしない（承認できない）: ${JSON.stringify({ status: ez.status, verdict: ez.verdict, req: ez.requiredEffects })}`);
  }
  //   簡素化 B（2026-10-17）: 検証結果と受け取った候補の結び付き。会話は受け取った候補（と送った既存ファイルの本文）から Gateway と同じ計算で指紋を作り、
  //   検証結果の指紋と一致したときだけ合格の材料にする（承認・登録もこの指紋に結び付ける）
  const genBind = (mutate) => { const g = makeGenerate({ sequence: ['good'] }); const impl0 = g.impl; g.impl = async (args) => mutate(await impl0(args)); return g; };
  const bindCases = [
    ['別の候補の検証結果（指紋が違う）', (r) => ({ ...r, verification: { ...r.verification, candidateHash: 'ffffffffffffffff' } })],
    ['指紋の無い検証結果', (r) => { const { candidateHash, ...rest } = r.verification; void candidateHash; return { ...r, verification: rest }; }],
    ['検証の後に候補（コード）だけが違う', (r) => ({ ...r, generated: { ...r.generated, code: `${r.generated.code}\n// 検証の後に変わった行` } })],
  ];
  for (const [name, mutate] of bindCases) {
    const xb = makeConvC({ generate: genBind(mutate) });
    await adoptC(xb);
    const vb = xb.c.activePlan(), eb = vb.generated.C1;
    assert(eb.status === 'unresolved' && eb.verdict.kind === 'verification-mismatch' && eb.verification.bound === false && vb.final.approvable === false && xb.c.approveFinal({ planId: vb.planId, version: vb.version }).ok === false,
      `D27-4（${name}）: 検証結果が受け取った候補と結び付かなければ合格にしない（承認できない）: ${JSON.stringify({ status: eb.status, kind: eb.verdict.kind, bound: eb.verification.bound })}`);
  }
  const xok = makeConvC();
  await adoptC(xok);
  const eok = xok.c.activePlan().generated.C1;
  const hok = await KTScan.gatewayCandidateHashOf({ strategy: eok.generated.strategy, targetFile: eok.generated.targetFile, code: eok.generated.code, patch: eok.generated.patch, baseHash: null, customizationId: 'C1' });
  assert(eok.verification.bound === true && eok.candidateHash === hok && eok.verification.candidateHash === hok && eok.status === 'verified' && xok.c.activePlan().final.approvable === true,
    `D27-5: 結び付いた検証結果（受け取った候補から作った指紋 = 検証結果の指紋）は合格の材料にし、承認の指紋もこの値: ${JSON.stringify({ bound: eok.verification.bound, hash: [eok.candidateHash, eok.verification.candidateHash, hok] })}`);
});
// D28（A6・B1・隔離 7・画面）: 動作テストに送る既存 JS の選び方と上限（4 件・合計 131,072 文字。1 ファイルの上限は無い）・送れなかった既存 JS の events（分からなければ null・外部のライブラリは []）
await section(async () => {
  const CUST_S = { customizationId: 'C1', requirement: '承認待ちでは案件名を編集できないようにする', whyStandardInsufficient: 'ステータスで切り替えるアクセス権は無い', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'case_name', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock'] }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [] };
  const planResp = (goal) => { const b = PLAN_V1(goal); return { ...b, plan: { ...b.plan, solution: 'CUSTOMIZATION', assessment: { ...b.plan.assessment, summary: '承認待ちでは案件名を編集できないようにします。' }, steps: [mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { title: 'JavaScript', solution: 'CUSTOMIZATION' })], customizations: [CUST_S] } }; };
  const CODE_S = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認待ち') record['case_name'].disabled = true;\n    return event;\n  });\n})();";
  /** 既存 JS（編集画面で案件名を読む。padTo 文字まで関数の定義で伸ばす。同じ文字の長い並びは秘密情報らしい文字列として伏字になるので使わない） */
  const bigJs = (name, padTo) => { let t = `(function () {\n  kintone.events.on('app.record.edit.show', function (event) {\n    var v = event.record['case_name'].value; // ${name}\n    return event;\n  });\n})();\n`; for (let i = 0; t.length < padTo; i++) t += `function ${name.replace(/[^a-z0-9]/g, '')}_f${i}(r) { return r + ${i}; }\n`; return t; };
  /** アプリ解析の入力（既存の fixture に既存 JS を足す。URL 指定は登録設定にだけ足す）。足した本文は偽の kintone にも持たせる（srcOf。作業の基準は動作テスト環境のファイルから作る） */
  const srcOf = new WeakMap();
  const inputsWith = (extraFiles, extraUrls = []) => {
    const data = clone(INPUTS.data);
    for (const f of extraFiles) data.customize.desktop.js.push({ type: 'FILE', file: { contentType: 'text/javascript', fileKey: `K-${f.name}`, name: f.name, size: String(f.text.length) } });
    for (const u of extraUrls) data.customize.desktop.js.push({ type: 'URL', url: u });
    const fieldsN = KTDeps.normalizeFields(data.fields);
    const deps = KTDeps.buildDependencyData(data, fieldsN);
    const fieldRows = fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType }));
    const files = [...FX.files, ...extraFiles.map(f => ({ name: f.name, target: 'desktop', kind: 'js', text: f.text }))];
    const scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files, fields: fieldRows, deps, skippedUrlFiles: FX.skippedUrlFiles });
    scan.results = KTScan.analyze({ fields: fieldRows, files: files.filter(f => f.kind === 'js'), snippet: { before: 24, after: 48 } });
    KTDeps.mergeScannerEdges(deps, scan);
    const out = { data, deps, scan, incoming: FX.incoming };
    srcOf.set(out, files.filter(x => x.kind === 'js').map(x => ({ name: x.name, target: x.target || 'desktop', text: x.text })));
    return out;
  };
  //   envReason: 偽の生成工程が返す動作テストの not-run の理由（§0c.9 の次の手の分け方の画面の回帰）
  const run = async (inputs, { health = null, envReason = null } = {}) => {
    const HEALTH_V = clone(HEALTH);
    HEALTH_V.registry.toolkit['customization-generator'].verification = health || ['requirementId', 'feedback', ...GEN_EFFECT_FEATURES];
    const genCtx = [];
    const generateImpl = async ({ ctx, requestId }) => {
      genCtx.push(clone(ctx));
      const req = (ctx.verification && ctx.verification.requiredEffects) || [];
      const candidateHash = gwCandidateHash({ strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', code: CODE_S, customizationId: 'C1' });
      const resp = { ok: true, contractVersion: '2.1', meta: { requestId, gateway: { product: 'toolkit', feature: 'customization-generator', promptVersion: '1', contextVersion: 'customization-1' }, normalization: { warnings: [] }, ai: { model: 'm' } }, generated: { strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', summary: '承認待ちでは案件名を編集できないようにします。', code: CODE_S, patch: null, events: ['app.record.edit.show'], fields: [{ code: 'case_name', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '' }] }, ...(req.length ? { verification: fakeVerification({ code: CODE_S, has: { case_name: ['lock'] } }, req, { candidateHash, ...(envReason ? { env: envReason, caseReason: envReason } : {}) }) } : {}) };
      const v = KTAiClient.validateGenerated(resp, ctx);
      if (!v.ok) throw new Error(JSON.stringify(v.errors));
      return { ...v.normalized, requestId };
    };
    const m = mount({ health: HEALTH_V, planImpl: ({ ctx, requestId }) => { const v = KTAiClient.validatePlan(planResp(ctx.goal), ctx); if (!v.ok) throw new Error(JSON.stringify(v.errors)); return { ...v.normalized, requestId, clientWarnings: v.warnings }; }, generateImpl, extra: { getInputs: () => inputs, executor: { api: makeKintoneMock(inputs.data, { jsSources: srcOf.get(inputs) || [] }).api, appId: '341' } } });
    await ticks();
    for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) { await m.panel.send(s); await ticks(8); }
    await m.panel.send('おすすめで。この案で進めて'); await ticks(20);
    return { m, genCtx, v: m.conv().activePlan() };
  };
  // 1) 96 KiB の既存 JS（以前は 1 ファイル 64 KiB の上限で外していた）→ 送る。Cybozu CDN の luxon（Field Scanner が別のホストとして本文を取らなかった）は外部のライブラリ（events []）
  const big = { name: 'big.js', text: bigJs('big', 96 * 1024) };
  const a = await run(inputsWith([big]));
  const va = a.genCtx[0] && a.genCtx[0].verification;
  assert(va && va.relatedFiles.some(f => f.name === 'big.js' && f.text.length >= 96 * 1024) && !(va.relatedOmitted || []).some(f => f.name === 'big.js') && JSON.stringify((va.relatedOmitted || []).find(f => f.name === 'luxon.min.js')) === JSON.stringify({ name: 'luxon.min.js', target: 'desktop', reason: 'url', events: [] }) && a.v.final.approvable === true, `D28-1: 64〜128 KiB の既存 JS も送る（1 ファイルの上限なし）・外部のライブラリは events []・承認できる: ${JSON.stringify(va && { files: va.relatedFiles.map(f => [f.name, f.text.length]), omitted: va.relatedOmitted, approvable: a.v.final.approvable, reason: a.v.final.blockingReason })}`);
  assert(va && Array.isArray(va.appFields) && va.appFields.length >= 20 && va.appFields.every(f => Object.keys(f).every(k => ['code', 'type', 'label', 'subtable', 'planned', 'readOnly', 'required', 'options'].includes(k))) && va.appFields.some(f => f.readOnly === true), `D28-2: appFields は code・type・label・subtable・planned・readOnly・options の形（§0c.8: readOnly を送る）: ${JSON.stringify(va && va.appFields.slice(0, 3))}`);
  // 2) 合計が 131,072 文字を超える → 超えたファイルは limit（イベントは解析で分かる edit.show）→ その効果は verified にしない
  const big2 = { name: 'big2.js', text: bigJs('big2', 40 * 1024) };
  const b = await run(inputsWith([big, big2]));
  const vb = b.genCtx[0] && b.genCtx[0].verification;
  const om2 = vb && (vb.relatedOmitted || []).find(f => f.name === 'big2.js');
  assert(vb && vb.relatedFiles.reduce((n, f) => n + f.text.length, 0) <= 131072 && om2 && om2.reason === 'limit' && JSON.stringify(om2.events) === JSON.stringify(['app.record.edit.show']) && b.v.generated.C1.status === 'not-run' && b.v.generated.C1.verdict.category === 'existing' && b.v.generated.C1.verdict.kind === 'out-of-reach' && !b.v.generated.C1.verdict.fix && /「big2\.js」/.test(b.v.generated.C1.verdict.reason), `D28-3: 合計 131,072 文字を超えた分は limit（イベントは解析の結果）→ verified にしない・§0c.9: 計画を直しても解けないので対応できない範囲（操作なし）: ${JSON.stringify({ files: vb && vb.relatedFiles.map(f => [f.name, f.text.length]), om2, verdict: b.v.generated.C1.verdict })}`);
  // 3) 同じホスト（kintone の画面と同じ）の URL 指定の既存 JS は本文もイベントも分からない → events null（その platform のすべて）→ verified にしない
  const c = await run(inputsWith([], ['https://t.cybozu.com/k/api/js/biz.js']));
  const vc = c.genCtx[0] && c.genCtx[0].verification;
  const om3 = vc && (vc.relatedOmitted || []).find(f => f.name === 'biz.js');
  assert(om3 && om3.reason === 'url' && om3.events === null && c.v.generated.C1.status === 'not-run' && c.v.generated.C1.verdict.category === 'existing' && /「https:\/\/t\.cybozu\.com\/k\/api\/js\/biz\.js」/.test(c.v.generated.C1.verdict.reason) && c.v.generated.C1.verdict.kind === 'out-of-reach' && c.v.final.approvable === false, `D28-4: 同じホストの URL 指定の既存 JS は events null → 必須の効果を verified にしない: ${JSON.stringify({ om3, verdict: c.v.generated.C1.verdict })}`);
  // 4) 印が欠ける接続先（appFields が無い）→ 必須の効果も既存 JS も送らない（旧い形にも送らない）→ 接続先が非対応
  const d = await run(inputsWith([]), { health: ['requirementId', 'feedback', 'requiredEffects', 'effectGroups', 'relatedOmitted', 'saveDialog', 'reasonCategory'] });
  const vd = d.genCtx[0] && d.genCtx[0].verification;
  assert(d.genCtx.length === 1 && vd && !vd.requiredEffects && !vd.relatedFiles && !vd.appFields && d.v.generated.C1.status === 'unsupported' && d.v.final.approvable === false, `D28-5: health に appFields の印が無い → 新しい形で送らず、接続先が非対応: ${JSON.stringify({ keys: vd && Object.keys(vd), status: d.v.generated.C1.status })}`);
  // 5) §0c.8（A3・scen の E3a）: 画面と別のホストの URL 指定の業務 JS（自社のサーバー）も events null → verified にしない（画面とホストが違うかどうかでは決めない）
  const e6 = await run(inputsWith([], ['https://biz.example.co.jp/kintone/biz.js']));
  const ve6 = e6.genCtx[0] && e6.genCtx[0].verification;
  const om6 = ve6 && (ve6.relatedOmitted || []).find(f => f.name === 'biz.js');
  assert(om6 && om6.reason === 'url' && om6.events === null && e6.v.generated.C1.status === 'not-run' && e6.v.generated.C1.verdict.category === 'existing' && e6.v.final.approvable === false && JSON.stringify((ve6.relatedOmitted || []).find(f => f.name === 'luxon.min.js').events) === '[]', `D28-6（E3a）: 別のホストの URL 指定の業務 JS は events null（Cybozu CDN の luxon は []）→ 承認できない: ${JSON.stringify({ om: ve6 && ve6.relatedOmitted, verdict: e6.v.generated.C1.verdict })}`);
  // 画面（§0c.8 B1）: 最終案のカードに［計画を直すよう依頼する］（data-act choice）。押すと（画面の handleAct）利用者の修正と同じ経路で計画の差分更新 → 最終案を作り直す
  //   §0c.9（2026-10-08）: URL で読み込む業務 JS は計画を直しても解けない → カードに［計画を直すよう依頼する］を出さず、対応できない範囲（URL 全体のファイル名）を出す
  assert(!e6.v.final.fix && !/data-fix="revise"/.test(e6.m.chat()) && /対応できない範囲/.test(e6.m.chat()) && /https:\/\/biz\.example\.co\.jp\/kintone\/biz\.js/.test(e6.m.chat()) && e6.v.generated.C1.verdict.kind === 'out-of-reach', `D28-7: URL の業務 JS は操作を出さず「対応できない範囲」として理由とファイル名を出す: ${JSON.stringify(e6.v.generated.C1.verdict)}`);
  //   既存 JS との競合が観測された（existing）は計画を直せば解ける → カードに［計画を直すよう依頼する］。押すと（画面の handleAct）利用者の修正と同じ経路で計画の差分更新 → 最終案を作り直す
  const e7 = await run(inputsWith([]), { envReason: 'existing' });
  const fx = e7.v.final.fix;
  const vBefore = e7.m.conv().activePlan().version;
  assert(fx && fx.kind === 'revise' && /data-act="choice"[^>]*data-fix="revise"/.test(e7.m.chat()) && /existing/.test(fx.text) && /既存の JavaScript に統合する/.test(fx.text), `D28-7b: 既存 JS との競合が観測された → 画面の最終案のカードに［計画を直すよう依頼する］が出る（依頼の文に理由の語）: ${JSON.stringify(fx)}`);
  await clickChat(e7.m, 'choice', { text: fx.text, intent: fx.intent || 'REVISE_PLAN', display: fx.display }); await ticks(20);
  assert(e7.m.conv().activePlan().version === vBefore + 1 && e7.genCtx.length === 2 && e7.m.conv().activePlan().final, `D28-8: 画面のボタンで計画の差分更新（新しい版）→ 最終案を作り直す: ${JSON.stringify({ version: e7.m.conv().activePlan().version, gen: e7.genCtx.length })}`);
});
// D29（契約の形）: Generator Context の relatedOmitted は reason を url・no-source・limit・other に限り（too-large・gateway-dropped は送らない）、events null を保つ。appFields は 2000 件・options は 50 件まで
await section(async () => {
  const ctx = KTContext.buildGenerator({ customization: CUST_C1, plan: { customizations: [CUST_C1] }, planId: 'p', version: 1, data: clone(DATA_C), verification: { requirementIds: [], requiredEffects: REQ_LOCK, relatedFiles: [], relatedOmitted: [{ name: 'a.js', target: 'desktop', reason: 'url', events: null }, { name: 'b.js', target: 'desktop', reason: 'too-large', events: ['app.record.edit.show'] }, { name: 'c.js', target: 'desktop', reason: 'gateway-dropped', events: null }, { name: 'd.js', target: 'mobile', reason: 'no-source', events: [] }] } });
  assert(JSON.stringify(ctx.verification.relatedOmitted) === JSON.stringify([{ name: 'a.js', target: 'desktop', reason: 'url', events: null }, { name: 'd.js', target: 'mobile', reason: 'no-source', events: [] }]), `D29-1: reason は 4 つの語彙だけ・events null は null のまま送る: ${JSON.stringify(ctx.verification.relatedOmitted)}`);
  const many = clone(DATA_C);
  for (let i = 0; i < 2100; i++) many.fields[`f${i}`] = { type: 'SINGLE_LINE_TEXT', code: `f${i}`, label: `項目${i}` };
  many.fields.kubun = { type: 'RADIO_BUTTON', code: 'kubun', label: '区分', options: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`o${i}`, { label: `o${i}`, index: String(i) }])) };
  const ctx2 = KTContext.buildGenerator({ customization: CUST_C1, plan: { customizations: [CUST_C1] }, planId: 'p', version: 1, data: many, verification: { requirementIds: [], requiredEffects: REQ_LOCK } });
  const kb = ctx2.verification.appFields.find(f => f.code === 'kubun');
  const ctx3 = KTContext.buildGenerator({ customization: CUST_C1, plan: { customizations: [CUST_C1] }, planId: 'p', version: 1, data: Object.assign(clone(DATA_C), { fields: { ...clone(DATA_C).fields, kubun: many.fields.kubun } }), verification: { requirementIds: [], requiredEffects: REQ_LOCK } });
  const kb3 = ctx3.verification.appFields.find(f => f.code === 'kubun');
  assert(ctx2.verification.appFields.length === 2000 && kb3 && kb3.options.length === 50 && kb3.options[0] === 'o0' && kb3.options[49] === 'o49' && !ctx2.fields.some(f => f.code === 'f1'), `D29-2: appFields は 2000 件まで・選択肢は kintone の並び順で 50 件まで・生成の AI に渡す fields には入れない: ${JSON.stringify({ n: ctx2.verification.appFields.length, kb: kb ? kb.options.length : null, kb3: kb3 && kb3.options.length })}`);
});
// 追加指示 §5 の表の 9 行は、§0c.7 の修正の後も上の D1〜D9 で同じ期待のまま確かめている（期待値は弱めていない。D17-2・D18-3 は §0c.7 の決定で次の手の文だけを変えた）

// ---- §0c.8（2026-10-08）: 4 回目の独立レビュー（効果の区別・担当間の契約）の再現と回帰 ----
console.log('\n--- §0c.8: 4 回目の独立レビューの回帰（URL 指定の既存 JS・合う側の合格・台帳の要件の条件・readOnly・次の手の操作・テーブルの列・語彙）---');
/** 最終案のカードの［計画を直すよう依頼する］［作り直しを依頼する］（data-act choice）の属性を取り出す（HTML の文字参照を戻す） */
const unescAttr = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const fixButtonOf = (html) => {
  const m = /<button[^>]*data-act="choice"[^>]*data-fix="([^"]*)"[^>]*>([^<]*)<\/button>/.exec(String(html));
  if (!m) return null;
  const tag = m[0];
  const at = (name) => { const r = new RegExp(`data-${name}="([^"]*)"`).exec(tag); return r ? unescAttr(r[1]) : null; };
  return { kind: m[1], label: unescAttr(m[2]), text: at('text'), intent: at('intent'), display: at('display') };
};
// D30（A3・scen の E3a）: URL 指定の既存 JS の events は既定で null。[] は既知のライブラリの配布元だけ（画面とホストが違うかどうかでは決めない）
await section(async () => {
  //   §0d.3（2026-10-08）の決定で期待値を変えた: cdn.jsdelivr.net（/npm/ を含む）と unpkg.com は既知の配布元から外した（npm で配布された業務の JS を [] で素通りさせない）。
  //   cdnjs.cloudflare.com は /ajax/libs/ だけ
  const lib = ['https://js.cybozu.com/luxon/3.4.4/luxon.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/dayjs/1.11.10/dayjs.min.js', 'https://code.jquery.com/jquery-3.7.1.min.js', 'https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js'];
  const biz = ['https://biz.example.co.jp/kintone/biz.js', 'https://someone.github.io/kintone/biz.js', 'https://cdn.jsdelivr.net/gh/someone/repo@main/biz.js', 'https://ajax.googleapis.com/other/biz.js', 'https://t.cybozu.com/k/api/js/biz.js', '/k/api/js/biz.js', 'https://js.cybozu.com.example.net/biz.js',
    'https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.min.js', 'https://cdn.jsdelivr.net/npm/@acme/kintone-biz@1.0.0/biz.js', 'https://unpkg.com/lodash@4.17.21/lodash.min.js', 'https://cdnjs.cloudflare.com/other/biz.js'];
  assert(lib.every(u => KTScan.isKnownLibraryUrl(u)) && biz.every(u => !KTScan.isKnownLibraryUrl(u)), `D30-1: 既知のライブラリの配布元だけ真（§0d.3: js.cybozu.com・cdnjs の /ajax/libs/・code.jquery.com・Google の /ajax/libs/ だけ。jsDelivr・unpkg・自社のサーバー・GitHub Pages・kintone と同じホストは偽）: ${JSON.stringify(biz.filter(u => KTScan.isKnownLibraryUrl(u)))}`);
  // scen の E3a: 自社のサーバーの業務 JS（編集画面で別フィールドに error を出す。本文は取れない）。Toolkit の選び方（画面の generate と同じ関数）で events null → 動作テストが合格でも verified にしない
  const selOf = (url) => KTContext.relatedFilesFor(KTScan.summarizeFiles(null, { customize: { desktop: { js: [{ type: 'URL', url }] } } }), { targets: ['desktop'], requiredEffects: REQ_LOCK });
  const sBiz = selOf('https://biz.example.co.jp/kintone/biz.js'), sLib = selOf('https://js.cybozu.com/luxon/3.4.4/luxon.min.js');
  const VER_E3A = { requiredEffects: VER_LOCK_OK.requiredEffects, behavior: { status: 'passed', reason: null, cases: [{ id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', event: 'app.record.edit.show', side: 'match', verdict: 'pass' }, { id: 'K2', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'not-locked', event: 'app.record.edit.show', side: 'nomatch', verdict: 'pass' }] } };
  const eBiz = KTCodeReview.effectResults(VER_E3A, REQ_LOCK, { omitted: sBiz.relatedOmitted }), eLib = KTCodeReview.effectResults(VER_E3A, REQ_LOCK, { omitted: sLib.relatedOmitted });
  assert(JSON.stringify(sBiz.relatedOmitted) === JSON.stringify([{ name: 'biz.js', target: 'desktop', reason: 'url', events: null, url: 'https://biz.example.co.jp/kintone/biz.js' }]) && !eBiz.ok && eBiz.reasonCategory === 'existing' && eBiz.reason === 'related-file-omitted' && JSON.stringify(sLib.relatedOmitted[0].events) === '[]' && eLib.ok, `D30-2（scen の E3a）: 自社のサーバーの URL 指定の JS は events null で passed にならない・Cybozu CDN は [] で止めない: ${JSON.stringify({ biz: sBiz.relatedOmitted, eBiz: [eBiz.ok, eBiz.reasonCategory], lib: sLib.relatedOmitted, eLib: eLib.ok })}`);
});
// D31（A2）: 条件つきの効果は「合う」側（期待が lock / warn / block-save / set-value / 表示の切り替え）の合格が 1 件以上あるときだけ合格。condition-value-unknown は条件の形
await section(async () => {
  const REQ_C = [{ requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect: 'lock', events: ['app.record.edit.show'], condition: 'ステータス in ("部長承認待ち")' }];
  const RE_P = [{ requirementIds: ['C1'], field: 'amount', effect: 'lock', status: 'present' }];
  const casesOf = (...cs) => ({ requiredEffects: RE_P, behavior: { status: cs.some(c => c.verdict === 'not-run') ? 'not-run' : 'passed', reason: null, cases: cs.map((c, i) => ({ id: `K${i + 1}`, requirementIds: ['C1'], field: 'amount', effect: 'lock', event: 'app.record.edit.show', ...c })) } });
  // scen2 の E9b: 「合う」は no-other-value（旧い Gateway）で作れず、「合わない」だけ合格
  const e1 = KTCodeReview.effectResults(casesOf({ expect: 'lock', verdict: 'not-run', reason: 'no-other-value' }, { expect: 'not-locked', verdict: 'pass' }), REQ_C);
  // 新しい Gateway: 「合う」は condition-value-unknown
  const e2 = KTCodeReview.effectResults(casesOf({ expect: 'lock', verdict: 'not-run', reason: 'condition-value-unknown' }, { expect: 'not-locked', verdict: 'pass' }), REQ_C);
  // 「合わない」だけが返った（合う側のケースが無い）
  const e3 = KTCodeReview.effectResults(casesOf({ expect: 'not-locked', verdict: 'pass' }), REQ_C);
  // 合う側の合格がある → 合格（no-other-value の「合わない」側は従来どおり対象外）
  const e4 = KTCodeReview.effectResults(casesOf({ expect: 'lock', verdict: 'pass' }, { expect: 'not-locked', verdict: 'not-run', reason: 'no-other-value' }), REQ_C);
  // 条件の無い効果は「合う」側だけで合格
  const e5 = KTCodeReview.effectResults(VER_LOCK_OK, REQ_LOCK);
  assert(!e1.ok && e1.items[0].behavior === 'not-run' && e1.items[0].notRunReasons.includes('condition-value-unknown') && e1.reasonCategory === 'condition' && !e2.ok && e2.reasonCategory === 'condition' && e2.reason === 'condition-value-unknown' && !e3.ok && e3.items[0].notRunReasons.includes('condition-value-unknown') && e4.ok && e5.ok, `D31-1（scen2 の E9b）: 合う側の合格が無い条件つきの効果は合格にしない（条件の形: condition-value-unknown）・合う側の合格があれば合格・条件の無い効果は従来どおり: ${JSON.stringify({ e1: [e1.ok, e1.items[0].notRunReasons, e1.reasonCategory], e2: [e2.ok, e2.reason], e3: [e3.ok, e3.items[0].notRunReasons], e4: e4.ok, e5: e5.ok })}`);
  // 表示の切り替え（show-hide）・保存を止める・警告・値の設定の「合う」側も同じ語彙（Gateway の behavior-cases の pos）
  const reqOf = (effect) => [{ requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect, events: ['app.record.edit.show'], condition: 'amount > 10' }];
  const verOf = (effect, expect) => ({ requiredEffects: [{ requirementIds: ['C1'], field: 'amount', effect, status: 'present' }], behavior: { status: 'passed', reason: null, cases: [{ id: 'K1', requirementIds: ['C1'], field: 'amount', effect, expect, event: 'app.record.edit.show', verdict: 'pass' }, { id: 'K2', requirementIds: ['C1'], field: 'amount', effect, expect: 'nomatch-side', event: 'app.record.edit.show', side: 'nomatch', verdict: 'pass' }] } });   // §0c.9: 条件つきは「合わない」の合格も要る
  assert([['warn', 'warn'], ['block-save', 'block-save'], ['set-value', 'set-value'], ['show-hide', 'show-hide'], ['show-hide', 'hidden']].every(([ef, ex]) => KTCodeReview.effectResults(verOf(ef, ex), reqOf(ef)).ok) && [['warn', 'not-warned'], ['block-save', 'save-allowed'], ['set-value', 'value-unchanged']].every(([ef, ex]) => !KTCodeReview.effectResults(verOf(ef, ex), reqOf(ef)).ok), 'D31-2: 合う側の期待（lock・warn・block-save・set-value・show-hide・hidden）の合格だけを数える（合わない側・保存できるの合格だけでは合格にしない）');
  assert(KTAiConversation.BEHAVIOR_REASONS['condition-value-unknown'] && KTAiConversation.BEHAVIOR_REASONS['condition-value-unknown'].category === 'condition' && KTAiConversation.BEHAVIOR_REASONS['no-other-value'].category === 'scope', 'D31-3（語彙）: condition-value-unknown は条件の形（判定に数える）・no-other-value は対象外のまま（「合わない」側だけ）');
  // 会話: 合う側を作れなかった最終案は準備未完了（条件の形）・次の手は計画を直す（操作あり）
  const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], dropCaseFor: 'amount|lock', extraCases: [{ id: 'K2', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'not-locked', event: 'app.record.edit.show', side: 'nomatch', verdict: 'pass', message: '期待どおり' }, { id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', event: 'app.record.edit.show', side: 'match', verdict: 'not-run', reason: 'no-other-value', message: '条件の値「承認待ち」の代表のレコードを作れません' }] }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  assert(e.status === 'not-run' && e.verdict.category === 'condition' && e.verdict.fix === 'revise' && v.final.approvable === false && v.final.fix && v.final.fix.kind === 'revise', `D31-4: 会話でも合う側の合格が無ければ準備未完了（条件の形）・次の手は計画を直す操作: ${JSON.stringify({ status: e.status, verdict: e.verdict, fix: v.final.fix && v.final.fix.kind })}`);
});
// D32（A6・rv4/a7b.cjs）: 台帳の要件に条件があり、計画のフィールドに構造化した条件が無ければ condition-unknown（unresolved）。効果の無い CONTROL を補うときも同じ
await section(async () => {
  const labels = { amount: '金額' };
  // a7b の 1: 計画の amount は「いつでも」の値の設定だけ（condition なし）。台帳の R1 は「承認済みのとき保存禁止」→ 保存禁止を「いつでも」で足さない
  const plan = { customizations: [{ customizationId: 'C1', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.edit.show', 'app.record.edit.submit'], fields: [{ code: 'ステータス', access: 'READ', effects: [] }, { code: 'amount', access: 'CONTROL', effects: [{ effect: 'set-value', condition: '' }] }] }] };
  const r1 = KTAiConversation.requiredEffectsOf(plan, 'C1', [{ id: 'R1', target: 'amount', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects: ['block-save'], condition: '承認済みのとき', behavior: '保存できない' }], { labels });
  // a7b の 2: 効果の無い CONTROL を「承認済みのとき編集不可」の要件で補う → lock を「いつでも」にしない
  const plan2 = { customizations: [{ customizationId: 'C1', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', effects: [] }] }] };
  const r2 = KTAiConversation.requiredEffectsOf(plan2, 'C1', [{ id: 'R1', target: '金額', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects: ['lock'], condition: '承認済みのとき', behavior: '編集不可' }], { labels });
  // 計画がその効果を「いつでも」で置いている（条件を落とした）・台帳の要件には条件がある → condition-unknown
  const plan3 = { customizations: [{ customizationId: 'C1', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', effects: [{ effect: 'lock', condition: '' }] }] }] };
  const r3 = KTAiConversation.requiredEffectsOf(plan3, 'C1', [{ id: 'R1', target: 'amount', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects: ['lock'], condition: '承認済みのとき' }], { labels });
  // フィールドに構造化した条件があれば、その条件で足す（従来どおり）
  const plan4 = { customizations: [{ customizationId: 'C1', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済")', effects: [] }] }] };
  const r4 = KTAiConversation.requiredEffectsOf(plan4, 'C1', [{ id: 'R1', target: 'amount', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects: ['lock'], condition: '承認済みのとき' }], { labels });
  const cu = (r, e) => r.unresolved.some(u => u.reason === 'condition-unknown' && u.effect === e && u.requirementId === 'R1');
  assert(cu(r1, 'block-save') && !r1.effects.some(e => e.effect === 'block-save') && cu(r2, 'lock') && !r2.effects.some(e => e.effect === 'lock') && cu(r3, 'lock') && r4.unresolved.length === 0 && r4.effects.some(e => e.effect === 'lock' && e.condition === 'ステータス in ("承認済")' && e.requirementIds.includes('R1')), `D32（a7b）: 台帳の要件に条件があり計画に構造化した条件が無ければ condition-unknown（「いつでも」にしない）。フィールドに条件があればその条件: ${JSON.stringify({ r1: r1.unresolved, r2: r2.unresolved, r3: r3.unresolved, r4: r4.effects })}`);
});
// D33（B2）: appFields の readOnly（ルックアップのコピー先・計算・自動計算の文字列・レコード番号などのシステムの値）
await section(async () => {
  const data = clone(DATA_C);
  data.fields = { ...data.fields, rec_no: { type: 'RECORD_NUMBER', code: 'rec_no', label: 'レコード番号' }, calc1: { type: 'CALC', code: 'calc1', label: '計算', expression: 'amount * 2' }, auto1: { type: 'SINGLE_LINE_TEXT', code: 'auto1', label: '自動計算', expression: 'amount & "円"' }, plain1: { type: 'SINGLE_LINE_TEXT', code: 'plain1', label: '文字列', expression: '' }, lk: { type: 'SINGLE_LINE_TEXT', code: 'lk', label: '顧客コード', lookup: { relatedApp: { app: '9' }, relatedKeyField: 'code', fieldMappings: [{ field: 'lk_name', relatedField: 'name' }] } }, lk_name: { type: 'SINGLE_LINE_TEXT', code: 'lk_name', label: '顧客名' } };
  const ctx = KTContext.buildGenerator({ customization: CUST_C1, plan: { customizations: [CUST_C1] }, planId: 'p', version: 1, data, verification: { requirementIds: [], requiredEffects: REQ_LOCK } });
  const ro = (code) => { const f = ctx.verification.appFields.find(x => x.code === code); return !!(f && f.readOnly === true); };
  assert(['rec_no', 'calc1', 'auto1', 'lk_name'].every(ro) && !['plain1', 'lk', 'amount'].some(ro), `D33: 入力できないフィールドだけ readOnly: true（ルックアップのキー・自動計算でない文字列・数値には付けない）: ${JSON.stringify(ctx.verification.appFields.filter(f => f.readOnly).map(f => f.code))}`);
});
// D34（B1）: 「計画を直す」が次の手のときは、構造化した理由から作った修正の依頼を最終案のカードの操作 1 つで通常の計画の差分更新に送れる（自動では送らない）。
//   候補が隔離環境で動かせない機能を使ったときは作り直しの操作。承認できない状態で、誰も実行しない次の手の文を残さない
await section(async () => {
  // 1) 既存 JS（送れなかった big.js が同じイベント）→［計画を直すよう依頼する］。押すまで計画の AI を呼ばない。押すと利用者の修正と同じ経路で差分更新 → 最終案を作り直す
  //   §0c.9（2026-10-08）: 送れなかった既存 JS（件数の上限）は計画を直しても解けない → 操作を出さない（対応できない範囲）
  const x0 = makeConvC({ generate: makeGenerate({ sequence: ['good'], relatedOmitted: [{ name: 'big.js', target: 'desktop', reason: 'limit', events: ['app.record.edit.show'] }] }) });
  await adoptC(x0);
  assert(x0.c.activePlan().final.approvable === false && !fixButtonOf(finalHtml(x0)) && !x0.c.activePlan().final.fix && /対応できない範囲/.test(stripC(finalHtml(x0))), 'D34-0: 送れなかった既存 JS（件数の上限）→ 操作を出さず「対応できない範囲」');
  //   既存 JS との競合が観測された（existing）は計画を直せば解ける → ［計画を直すよう依頼する］
  const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], env: 'existing', caseReason: 'existing' }) });
  await adoptC(x);
  const v = x.c.activePlan(), html = finalHtml(x);
  const b = fixButtonOf(html);
  assert(v.final.approvable === false && x.calls.plan.length === 1 && b && b.kind === 'revise' && b.label === '計画を直すよう依頼する' && b.intent === 'REVISE_PLAN' && /existing/.test(b.text) && /「金額」/.test(b.text) && /既存の JavaScript に統合する/.test(b.text) && !/実機/.test(b.text), `D34-1: 既存 JS の区分 → カードに［計画を直すよう依頼する］（ファイル名・フィールドのラベル・理由の語を添えた依頼の文）。自動では送らない: ${JSON.stringify({ plans: x.calls.plan.length, b })}`);
  const plansBefore = x.calls.plan.length, finalsBefore = x.finals().length;
  await x.c.send(b.text, { intentOverride: b.intent, displayText: b.display });   // 画面の handleAct('choice') と同じ（sendChat → conv.send(text, { intentOverride })）
  const last = x.calls.plan[x.calls.plan.length - 1];
  assert(x.calls.plan.length === plansBefore + 1 && last.revision === true && last.request.includes('existing') && x.finals().length === finalsBefore + 1 && x.gen.calls.length === 2, `D34-2: 操作 1 つで通常の計画の差分更新（revision）に送られ、最終案を作り直す: ${JSON.stringify({ plans: x.calls.plan.length, revision: last.revision, finals: x.finals().length, gen: x.gen.calls.length })}`);
  // 2) 条件の形・件数・代表条件なし（no-cases → untested）・other-platform も同じ操作。no-cases は「確かめられるようになってから」と言わない
  for (const o of [{ env: 'condition-unparsed' }, { env: 'limit' }, { env: 'other-platform' }, { env: 'condition-value-unknown' }, { dropCaseFor: 'amount|lock' }]) {
    const y = makeConvC({ generate: makeGenerate({ sequence: ['good'], ...o }) });
    await adoptC(y);
    const vy = y.c.activePlan(), ey = vy.generated.C1, by = fixButtonOf(finalHtml(y));
    assert(vy.final.approvable === false && by && by.kind === 'revise' && by.intent === 'REVISE_PLAN' && /計画を直してください/.test(by.text) && /［計画を直すよう依頼する］/.test(ey.verdict.next) && !/確かめられるようになってから|使えるようになってから/.test(ey.verdict.next) && y.calls.plan.length === 1, `D34-3（${JSON.stringify(o)}）: 計画を直す区分は［計画を直すよう依頼する］を出す（次の手の文もその操作を指す）: ${JSON.stringify({ verdict: ey.verdict, b: by && by.kind })}`);
  }
  // 3) 候補が隔離環境で動かせない機能（unsupported・unsupported-feature）→［作り直しを依頼する］。押すと依頼の文が生成の入力に入る（同じ入力の再生成の案内とぶつからない）
  for (const env of ['unsupported', 'unsupported-feature']) {
    const z = makeConvC({ generate: makeGenerate({ sequence: ['good'], env }) });
    await adoptC(z);
    const vz = z.c.activePlan(), ez = vz.generated.C1, bz = fixButtonOf(finalHtml(z));
    assert(vz.final.approvable === false && ez.verdict.fix === 'regenerate' && bz && bz.kind === 'regenerate' && bz.label === '作り直しを依頼する' && bz.intent === 'REVISE_PLAN' && /BigInt/.test(bz.text) && /作り直して/.test(bz.text) && /［作り直しを依頼する］/.test(ez.verdict.next) && !/使えるようになってから/.test(ez.verdict.next) && z.calls.plan.length === 1, `D34-4（${env}）: 隔離環境で動かせない機能 → ［作り直しを依頼する］（自動では送らない）: ${JSON.stringify({ verdict: ez.verdict, b: bz })}`);
    await z.c.send(bz.text, { intentOverride: bz.intent, displayText: bz.display });
    assert(z.calls.plan.length === 2 && z.calls.plan[1].revision && z.gen.calls.length === 2, `D34-5（${env}）: 作り直しの操作は計画の差分更新として送られ、JavaScript を作り直す: ${JSON.stringify({ plans: z.calls.plan.length, gen: z.gen.calls.length })}`);
  }
  //   依頼の文は生成の入力（userRequests）に入るので、同じ入力の再生成を AI を呼ばずに案内する規則（generatorInputHash の一致）には当たらない
  const h1 = KTContext.generatorInputHash(KTContext.buildGenerator({ customization: CUST_C1, plan: { customizations: [CUST_C1] }, planId: 'p', version: 1, data: clone(DATA_C), userRequests: ['g'], options: { now: '2026-10-08T00:00:00.000Z' } }));
  const h2 = KTContext.generatorInputHash(KTContext.buildGenerator({ customization: CUST_C1, plan: { customizations: [CUST_C1] }, planId: 'p', version: 1, data: clone(DATA_C), userRequests: ['g', '作り直しの依頼'], options: { now: '2026-10-08T00:00:00.000Z' } }));
  assert(h1 && h2 && h1 !== h2, 'D34-6: 作り直しの依頼の文は生成の入力の指紋を変える（同じ入力の再生成の案内とぶつからない）');
  // 4) 承認できる最終案・環境の制約（時間切れ）にはこの操作を出さない（環境は作り直しても変わらないので修復も依頼もしない）
  const ok = makeConvC();
  await adoptC(ok);
  const t = makeConvC({ generate: makeGenerate({ sequence: ['good'], env: 'timeout' }) });
  await adoptC(t);
  assert(ok.c.activePlan().final.approvable === true && !ok.c.activePlan().final.fix && !fixButtonOf(finalHtml(ok)) && !t.c.activePlan().final.fix && !fixButtonOf(finalHtml(t)), 'D34-7: 承認できる最終案・環境の制約（時間切れ）には次の手の操作を出さない');
  // 5) 要件未達（修復の上限の後）・必須の動作を特定できない（自動の差分更新 1 回の後）も、次の手は操作で実行できる
  const u = makeConvC({ generate: makeGenerate({ sequence: ['warn'] }) });
  await adoptC(u);
  const bu = fixButtonOf(finalHtml(u));
  const CUST_K = custOf(null, { events: ['app.record.edit.show', 'app.record.edit.submit'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', effects: [{ effect: 'set-value', condition: '' }, { effect: 'lock', condition: 'ステータス in ("承認待ち")' }] }] });
  const opK = { op: 'add', target: '金額', condition: '承認待ち', behavior: '保存できないようにする', exceptions: [], decision: 'proposed', disposition: 'adopted', sourceQuotes: [], planRefs: ['C1'], effects: ['block-save'], note: '' };
  const k = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_K, gatewayPlan: { plan: true }, requirementOps: args.revision ? [] : [opK] }) });
  await adoptC(k);
  const bk = fixButtonOf(finalHtml(k));
  assert(bu && bu.kind === 'revise' && /処理がありません（要件未達）/.test(bu.text) && bk && bk.kind === 'revise' && /condition-unknown/.test(bk.text) && k.calls.plan.length === 2 && /［計画を直すよう依頼する］/.test(k.c.activePlan().generated.C1.verdict.next), `D34-8: 要件未達・必須の動作を特定できない（自動の差分更新 1 回の後）も［計画を直すよう依頼する］: ${JSON.stringify({ bu: bu && bu.kind, bk: bk && bk.text })}`);
});
// D35（テーブルの列の表示切り替え）: 必須の効果にせず「実現できない点」に出す（SUBTABLE_ROWS と同じく承認は止めない）
await section(async () => {
  const plan = { customizations: [{ customizationId: 'C1', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'ステータス', access: 'READ', effects: [] }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: [{ effect: 'lock', condition: '' }] }, { code: 'qty', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: [{ effect: 'show-hide', condition: '' }] }] }] };
  const r = KTAiConversation.requiredEffectsOf(plan, 'C1', [{ id: 'R1', target: 'qty', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects: ['show-hide'], condition: '' }], { labels: { qty: '数量' }, columns: { qty: 'items' } });
  assert(r.effects.length === 1 && r.effects[0].field === 'amount' && r.unresolved.length === 0 && r.notPossible.length === 1 && r.notPossible[0].field === 'qty' && r.notPossible[0].table === 'items' && r.notPossible[0].requirementIds.includes('R1'), `D35-1: テーブルの列の表示切り替えは必須の効果にしない（notPossible）: ${JSON.stringify(r)}`);
  const only = { customizations: [{ customizationId: 'C1', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'qty', access: 'SHOW_HIDE', effects: [{ effect: 'show-hide', condition: '' }] }] }] };
  const r2 = KTAiConversation.requiredEffectsOf(only, 'C1', [], { columns: { qty: 'items' } });
  assert(r2.effects.length === 0 && r2.unresolved.length === 0 && r2.notPossible.length === 1, `D35-2: 列の表示切り替えだけの JavaScript でも「必須の動作が 0 件（特定できない）」にしない: ${JSON.stringify(r2)}`);
  // 会話: 実現できない点に出し、ほかの必須の効果（金額の編集不可）が合格なら承認できる。代表条件なし（untested）の「確かめられるようになってから」は出さない
  const CUST_T = custOf(null, { fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock'] }, { code: 'qty', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['show-hide'] }] });
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_T }) });
  x.services.tableColumns = () => ({ qty: 'items' });
  await adoptC(x);
  const v = x.c.activePlan(), text = stripC(finalHtml(x));
  const sent = (x.gen.calls[0] && x.gen.calls[0].requiredEffects) || [];
  assert(!sent.some(e => e.field === 'qty') && v.final.approvable === true && v.final.cannot.some(c => c.kind === 'limit' && /テーブル/.test(c.text) && /表示・非表示を切り替えられません/.test(c.text)) && /この案の制約/.test(text) && !/確かめられるようになってから/.test(text), `D35-3: 会話では列の表示切り替えを生成工程の必須の効果に送らず、実現できない点に出す（承認は止めない）: ${JSON.stringify({ sent: sent.map(e => [e.field, e.effect]), approvable: v.final.approvable, cannot: v.final.cannot })}`);
});
// D36（日付の条件・語彙）: 条件の形の次の手は「単純な比較に直す」ではなく、代表条件を作れる形に直す依頼（日付の比較は Gateway が解く）。
//   承認できない区分（環境以外）の次の手の文はどれも操作を指す
assert(!/単純な比較/.test(KTAiConversation.REASON_CATEGORY.condition.next) && /［計画を直すよう依頼する］/.test(KTAiConversation.REASON_CATEGORY.condition.next) && ['existing', 'condition', 'limit', 'scope'].every(c => KTAiConversation.REASON_CATEGORY[c].fix === 'revise' && /［計画を直すよう依頼する］/.test(KTAiConversation.REASON_CATEGORY[c].next)) && ['unsupported', 'unsupported-feature'].every(r => KTAiConversation.BEHAVIOR_REASONS[r].fix === 'regenerate') && KTAiConversation.BEHAVIOR_REASONS['no-cases'].fix === 'revise', 'D36: 条件の形の次の手は「単純な比較に直す」と言わない・計画を直す区分と作り直しの理由は操作を持つ');
// =========================================================
console.log('\n--- §D37〜D41. 5 回目のレビュー後の決定（§0c.9・2026-10-08）: 動作テストの結果を切らない・二重の安全・次の手の分け方・URL のファイルの見分け ---');
const EV_E = 'app.record.edit.show', EV_I = 'app.record.index.edit.show', EV_C = 'app.record.create.show';
/** §0c.9 の回帰用: 必須の効果と、効果のイベントごとの合う・合わない（Gateway の caseSide の形）の代表条件 */
const reqLockOf = (field, events, condition = 'amount >= 100') => ({ requirementId: 'C1', requirementIds: ['C1'], field, effect: 'lock', events, condition });
const caseOf = (id, field, event, side, verdict = 'pass', o = {}) => ({ id, requirementIds: ['C1'], field, effect: 'lock', expect: side === 'match' ? 'lock' : 'not-locked', event, side, kind: side, platform: 'desktop', verdict, message: verdict === 'pass' ? '期待どおり' : `${field} は期待した動きになりませんでした`, ...o });
const fullCases = (fields, events, cond = true) => fields.flatMap(f => events.flatMap(ev => (cond ? ['match', 'nomatch'] : ['match']).map(sd => caseOf(`${f}-${ev}-${sd}`, f, ev, sd))));
const verOfCases = (fields, cases, status = null) => ({ version: '1', candidateHash: '0123456789abcdef', passed: true, machine: [], requiredEffects: fields.map(f => ({ requirementIds: ['C1'], field: f, effect: 'lock', status: 'present' })), behavior: { status: status || (cases.some(c => c.verdict === 'fail') ? 'failed' : cases.every(c => c.verdict === 'pass') ? 'passed' : 'not-run'), reason: null, cases } });

// D37（効果レビュー A1・最重要）: 動作テストの結果を入口で切らない。Gateway の最大以上を受け、それでも切ったら印を付けて合格にしない。behavior.status が passed でなければ合格にしない
await section(async () => {
  const F6 = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'];
  const req6 = F6.map(f => reqLockOf(f, [EV_E, EV_I, EV_C]));
  //   rv5/s5.mjs の F1: 6 フィールドの lock（3 画面 × 合う・合わない = 36 件）に、同じ形の代表条件を足して 48 件を超える。f6 の一覧の編集の「合う」（42 件目より後ろ）だけ fail
  const base = fullCases(F6, [EV_E, EV_I, EV_C]);
  const filler = F6.flatMap(f => [EV_E, EV_C].map(ev => caseOf(`${f}-${ev}-in`, f, ev, 'match')));
  const cases1 = [...base.filter(c => c.id !== `f6-${EV_I}-match`), ...filler, caseOf(`f6-${EV_I}-match`, 'f6', EV_I, 'match', 'fail')];
  const n1 = KTAiClient.normalizeVerification(verOfCases(F6, cases1));
  const er1 = KTCodeReview.effectResults(n1, req6);
  assert(cases1.length > 40 && n1.behavior.cases.length === cases1.length && !n1.behavior.truncated && n1.behavior.status === 'failed' && !er1.ok && er1.failed.length === 1 && er1.failed[0].field === 'f6', `D37-1（rv5 F1）: 40 件を超える代表条件を入口で切らない。末尾の fail で合格にしない: ${JSON.stringify({ sent: cases1.length, kept: n1.behavior.cases.length, ok: er1.ok, failed: er1.failed.map(i => i.field) })}`);
  assert(KTAiClient.BEHAVIOR_CASES_MAX >= 192 + 100, `D37-2: 入口の上限は Gateway の最大（platform ごとに 96 件の実行と skipped。PC とモバイルで 192 件＋skipped）以上: ${KTAiClient.BEHAVIOR_CASES_MAX}`);
  //   rv5/s5.mjs の F2・f1c.mjs の F1c: 末尾に condition-value-unknown・limit（skipped）があっても見落とさない
  const cases2 = [...base.filter(c => c.id !== `f6-${EV_I}-match`), ...filler, { ...caseOf('S1', 'f6', EV_I, 'match', 'not-run'), kind: null, reason: 'condition-value-unknown', reasonCategory: 'condition', details: { field: 'ステータス', label: 'ステータス', values: ['部長承認'] } }];
  const n2 = KTAiClient.normalizeVerification(verOfCases(F6, cases2));
  const er2 = KTCodeReview.effectResults(n2, req6);
  const s1 = n2.behavior.cases[n2.behavior.cases.length - 1];
  assert(!er2.ok && er2.notRun.length === 1 && er2.notRun[0].field === 'f6' && er2.reasonCategory === 'condition' && er2.reason === 'condition-value-unknown' && s1.side === 'match' && s1.platform === 'desktop' && JSON.stringify(s1.details.values) === '["部長承認"]', `D37-3（rv5 F2）: 末尾の condition-value-unknown を見落とさない・side / platform / details を落とさない: ${JSON.stringify({ ok: er2.ok, cat: er2.reasonCategory, s1 })}`);
  const cases3 = [...base.filter(c => c.id !== `f6-${EV_I}-match`), ...filler, { ...caseOf('S2', 'f6', EV_I, 'match', 'not-run'), kind: null, reason: 'limit', reasonCategory: 'limit' }];
  const er3 = KTCodeReview.effectResults(KTAiClient.normalizeVerification(verOfCases(F6, cases3)), req6);
  assert(!er3.ok && er3.reasonCategory === 'limit' && er3.notRun.some(i => i.field === 'f6' && i.notRunReasons.includes('limit')), `D37-4（rv5 F1c）: 件数の上限（limit）の代表条件が Toolkit に届き、合格にしない（以前は 40 件で切って RUNTIME_UNVERIFIED）: ${JSON.stringify({ ok: er3.ok, cat: er3.reasonCategory })}`);
  //   それでも上限を超えた → truncated の印・合格にしない（理由は件数の上限）
  const huge = Array.from({ length: KTAiClient.BEHAVIOR_CASES_MAX + 5 }, (_, i) => caseOf(`K${i}`, 'f1', [EV_E, EV_I, EV_C][i % 3], i % 2 ? 'nomatch' : 'match'));
  const n4 = KTAiClient.normalizeVerification(verOfCases(['f1'], huge));
  const er4 = KTCodeReview.effectResults(n4, [reqLockOf('f1', [EV_E, EV_I, EV_C])]);
  assert(n4.behavior.truncated === true && n4.behavior.totalCases === huge.length && n4.behavior.cases.length === KTAiClient.BEHAVIOR_CASES_MAX && !er4.ok && er4.items[0].behavior === 'not-run' && er4.items[0].notRunReasons.includes('limit') && er4.reasonCategory === 'limit', `D37-5: 上限を超えて切ったら truncated の印を付け、合格にしない（件数の上限）: ${JSON.stringify({ truncated: n4.behavior.truncated, ok: er4.ok, items: er4.items.map(i => [i.behavior, i.notRunReasons]) })}`);
  //   behavior.status が passed でない（照合できない代表条件に原因がある・食い違い）→ 合格にしない
  const req1 = [reqLockOf('f1', [EV_E])];
  const allPass = fullCases(['f1'], [EV_E]);
  const er5 = KTCodeReview.effectResults(verOfCases(['f1'], allPass, 'failed'), req1);
  const er6 = KTCodeReview.effectResults(verOfCases(['f1'], [...allPass, { ...caseOf('X1', 'zz', EV_E, 'match', 'not-run'), effect: 'warn', reason: 'timeout' }], 'not-run'), req1);
  //   対象外（作れない確かめ方）だけの not-run は止めない（作れない確かめ方で、正しい候補を止め続けない）
  const er7 = KTCodeReview.effectResults(verOfCases(['f1'], [...allPass, { ...caseOf('S3', 'f1', EV_E, 'nomatch', 'not-run'), reason: 'no-other-value' }], 'not-run'), req1);
  assert(!er5.ok && er5.items[0].behavior === 'not-run' && er5.statusOk === false && !er6.ok && er6.items[0].behavior === 'not-run' && er6.items[0].notRunReasons.includes('timeout') && er7.ok && er7.statusOk === true, `D37-6: behavior.status が passed でなければ合格にしない（対象外だけの not-run は代表条件ごとの判定に任せる）: ${JSON.stringify({ e5: [er5.ok, er5.items[0].behavior], e6: [er6.ok, er6.items[0].notRunReasons], e7: er7.ok })}`);
  //   会話: 40 件を超える結果の最後の fail → 承認できない（修復の上限の後の要件未達）
  const extra = Array.from({ length: 45 }, (_, i) => ({ id: `P${i}`, requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', event: EV_E, side: 'match', kind: 'match', verdict: 'pass', message: '期待どおり' }));
  const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], extraCases: [...extra, { id: 'P99', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', event: EV_E, side: 'match', kind: 'match', verdict: 'fail', message: '期待した動きになりませんでした' }] }) });
  await adoptC(x);
  const v = x.c.activePlan();
  assert(v.generated.C1.status === 'unresolved' && v.generated.C1.verdict.kind === 'behavior-fail' && v.final.approvable === false, `D37-7: 会話でも 40 件より後ろの fail で承認できる最終案にしない: ${JSON.stringify({ status: v.generated.C1.status, verdict: v.generated.C1.verdict && v.generated.C1.verdict.kind })}`);
});

// D38（効果レビュー A2〜A5・§0c.9 の二重の安全）: 必須の効果ごとに、効果のイベントのそれぞれで「合う」の合格、条件つきなら「合わない」の合格も 1 件以上。
//   足りなければ確かめていない（条件の形・件数の上限）。§0d.4（2026-10-08）で Toolkit の静的な block（conditional-control）とその引き下げは削除した（D38-5 の注を参照）
await section(async () => {
  const req = [reqLockOf('amount', [EV_E, EV_I], 'ステータス in ("承認待ち")')];
  const all = fullCases(['amount'], [EV_E, EV_I]);
  const ok = KTCodeReview.effectResults(verOfCases(['amount'], all), req);
  const noNeg = KTCodeReview.effectResults(verOfCases(['amount'], all.filter(c => !(c.event === EV_I && c.side === 'nomatch'))), req);
  const noPos = KTCodeReview.effectResults(verOfCases(['amount'], all.filter(c => !(c.event === EV_I && c.side === 'match'))), req);
  assert(ok.ok && !noNeg.ok && noNeg.items[0].behavior === 'not-run' && noNeg.items[0].notRunReasons[0] === 'case-coverage' && noNeg.reasonCategory === 'condition' && JSON.stringify(noNeg.items[0].lacking) === JSON.stringify([{ event: EV_I, side: 'nomatch' }]) && !noPos.ok && JSON.stringify(noPos.items[0].lacking) === JSON.stringify([{ event: EV_I, side: 'match' }]), `D38-1（rv5 F5）: イベントごとの合う・合わないが揃わなければ確かめていない（条件の形）: ${JSON.stringify({ ok: ok.ok, noNeg: noNeg.items[0], noPos: noPos.items[0].lacking })}`);
  //   合う側の合格は「合う側の期待」の語だけ（同じ side match でも not-locked の確かめでは数えない）
  const wrongPos = KTCodeReview.effectResults(verOfCases(['amount'], all.map(c => (c.event === EV_I && c.side === 'match' ? { ...c, expect: 'not-locked' } : c))), req);
  assert(!wrongPos.ok && wrongPos.items[0].behavior === 'not-run', 'D38-2: 合う側は期待が合う側の語（lock など）の合格だけを数える');
  //   作れないと Gateway が示した側（対象外の not-run）だけ免除する: 合わない側の no-other-value・作成画面の「合う」の not-on-create
  const waiveNeg = KTCodeReview.effectResults(verOfCases(['amount'], [...all.filter(c => !(c.event === EV_I && c.side === 'nomatch')), { ...caseOf('S1', 'amount', EV_I, 'nomatch', 'not-run'), reason: 'no-other-value' }]), req);
  const reqC = [reqLockOf('amount', [EV_E, EV_C], 'ステータス in ("承認待ち")')];
  const allC = fullCases(['amount'], [EV_E, EV_C]).filter(c => !(c.event === EV_C && c.side === 'match'));
  const waivePos = KTCodeReview.effectResults(verOfCases(['amount'], [...allC, { ...caseOf('S2', 'amount', EV_C, 'match', 'not-run'), reason: 'not-on-create' }]), reqC);
  const noWaive = KTCodeReview.effectResults(verOfCases(['amount'], allC), reqC);
  const notWaivedByCvu = KTCodeReview.effectResults(verOfCases(['amount'], [...allC, { ...caseOf('S3', 'amount', EV_C, 'match', 'not-run'), reason: 'no-other-value' }]), reqC);
  assert(waiveNeg.ok && waivePos.ok && !noWaive.ok && noWaive.items[0].notRunReasons[0] === 'case-coverage' && !notWaivedByCvu.ok, `D38-3: 免除は Gateway が「その側を作れない」と示したときだけ（合わない側は対象外の理由、合う側は not-on-create・no-event）。示さずに欠けていれば確かめていない: ${JSON.stringify({ waiveNeg: waiveNeg.ok, waivePos: waivePos.ok, noWaive: noWaive.ok, cvu: notWaivedByCvu.ok })}`);
  //   条件の無い効果は「合う」だけ。警告の保存のイベントは、条件に合うレコードの「保存は止めない」（警告の保存）が合う側
  const reqU = [reqLockOf('amount', [EV_E, EV_I], '')];
  const okU = KTCodeReview.effectResults(verOfCases(['amount'], fullCases(['amount'], [EV_E, EV_I], false)), reqU);
  const missU = KTCodeReview.effectResults(verOfCases(['amount'], fullCases(['amount'], [EV_E], false)), reqU);
  const reqW = [{ requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect: 'warn', events: [EV_E, 'app.record.edit.submit'], condition: 'amount >= 100' }];
  const wc = (id, event, side, expect, o = {}) => ({ id, requirementIds: ['C1'], field: 'amount', effect: 'warn', expect, event, side, verdict: 'pass', message: '', ...o });
  const verW = { requiredEffects: [{ requirementIds: ['C1'], field: 'amount', effect: 'warn', status: 'present' }], behavior: { status: 'passed', reason: null, cases: [wc('W1', EV_E, 'match', 'warn'), wc('W2', EV_E, 'nomatch', 'not-warned'), wc('W3', 'app.record.edit.submit', 'match', 'save-allowed', { kind: 'warn-save' }), wc('W4', 'app.record.edit.submit', 'nomatch', 'save-allowed')] } };
  assert(okU.ok && !missU.ok && JSON.stringify(missU.items[0].lacking) === JSON.stringify([{ event: EV_I, side: 'match' }]) && KTCodeReview.effectResults(verW, reqW).ok, 'D38-4: 条件の無い効果は合う側だけ（イベントごと）・警告の保存のイベントは「保存は止めない」が合う側');
  //   §0d.4（2026-10-08）: 静的な block（conditional-control）と、模擬テストの合格でそれを確認に下げる処理は削除した（Toolkit の業務の推定による判定）。
  //   条件の外の編集不可は、生成工程の代表条件の「合わない」側（expect not-locked）が不合格を返す（AI版 worker/test/cases/required-effects.mjs の
  //   「lock: 条件に合う（承認済）→ lock・合わない（作成中）→ not-locked」と「A3 F5（本物の隔離環境）: 一覧の編集だけ条件を見ずに編集不可にする誤った候補 → 一覧の編集の「合わない」で failed」）。
  //   Toolkit に残るのは、イベントごとの合う・合わないが揃わないこと（返却の欠落）と、明示された不合格を登録不可にすること（rv5 F5 の候補で確かめる）
  const UNCOND = handlerC("    record['amount'].disabled = true;", [EV_E, EV_I]);
  const CUST_I = custOf(['lock'], { events: [EV_E, EV_I] });
  const rv = KTCodeReview.review({ generated: { strategy: 'NEW_JS_FILE', targetFile: 'lock.js', summary: 's', code: UNCOND, patch: null, events: [EV_E, EV_I], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '', text: 'x' }] }, customization: CUST_I, plan: null, data: clone(DATA_C), scan: null, existingSource: null });
  const mPart = KTCodeReview.attachBehavior(rv, verOfCases(['amount'], all.filter(c => !(c.event === EV_I && c.side === 'nomatch'))), { requiredEffects: req, customization: CUST_I });
  //   今の契約の Gateway がこの候補に返す結果: 一覧の編集の「合わない」（編集できるはずのレコード）で不合格
  const mFail = KTCodeReview.attachBehavior(rv, verOfCases(['amount'], all.map(c => (c.event === EV_I && c.side === 'nomatch' ? { ...c, verdict: 'fail', message: '条件に合わないレコードで「金額」が編集できなくなりました' } : c))), { requiredEffects: req, customization: CUST_I });
  assert(mPart.registration.verdict === 'BLOCKED' && mPart.checks.some(ch => ch.name === 'behavior-not-run' && ch.category === 'condition') && mFail.registration.verdict === 'BLOCKED' && mFail.checks.some(ch => ch.name === 'behavior-fail' && ch.severity === 'block' && /編集できなくなりました/.test(ch.message)) && !mFail.effects.ok, `D38-5（rv5 F5）: 条件の外の編集不可の候補は、イベントごとの合う・合わないが揃わなければ準備未完了（条件の形）、生成工程の「合わない」の不合格なら登録不可: ${JSON.stringify({ part: mPart.registration.verdict, fail: mFail.registration.verdict, failChecks: mFail.checks.filter(ch => !ch.ok).map(ch => ch.name) })}`);
  //   会話: 一覧の編集の「合わない」が返らない → 準備未完了（条件の形）・次の手は［計画を直すよう依頼する］
  const y = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_I }), generate: makeGenerate({ sequence: ['good'], dropCaseFor: 'amount|lock', extraCases: all.filter(c => !(c.event === EV_I && c.side === 'nomatch')), generatedOf: (cust) => ({ strategy: 'NEW_JS_FILE', targetFile: 'lock.js', summary: '承認待ちでは金額を編集不可にします。', code: handlerC(`    if (${ST_C}) record['amount'].disabled = true;`, [EV_E, EV_I]), patch: null, events: cust.events, fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '', text: cust.requirement }] }) }) });
  await adoptC(y);
  const vy = y.c.activePlan(), ey = vy.generated.C1;
  assert(ey.status === 'not-run' && ey.verdict.category === 'condition' && ey.verdict.reasonKey === 'case-coverage' && ey.verdict.fix === 'revise' && vy.final.approvable === false && vy.final.fix && vy.final.fix.kind === 'revise' && /条件に合うレコード・合わないレコードで確かめた結果が揃わない/.test(vy.final.fix.text) && !/case-coverage/.test(vy.final.fix.text), `D38-7: 会話でもイベントごとの確かめが揃わなければ準備未完了（条件の形）・次の手は計画を直す操作: ${JSON.stringify({ status: ey.status, verdict: ey.verdict })}`);
});

// D39（§0c.9 の次の手の分け方）: 計画を直せば解ける理由は［計画を直すよう依頼する］、計画を直しても解けない理由（existing-unverifiable・URL / 本文の無い既存 JS・件数の上限）は
//   操作を出さず「対応できない範囲」として理由とファイル名（通常画面は短く、詳細は詳細表示）
await section(async () => {
  const R = KTAiConversation.BEHAVIOR_REASONS;
  assert(R['existing-unverifiable'] && R['existing-unverifiable'].category === 'existing' && R['existing-unverifiable'].unfixable === true && R['related-file-omitted'].unfixable === true && !R.existing.unfixable && !R['condition-unparsed'].unfixable && !R['other-platform'].unfixable && !R['condition-value-unknown'].unfixable, 'D39-1: 語彙に existing-unverifiable（既存 JS・計画を直しても解けない）を入れ、related-file-omitted も解けない理由。既存 JS との競合（existing）・条件の形は解ける理由');
  //   既存 JS の読み込みを再現できない（Gateway の details.files にファイル名）→ 操作なし・対応できない範囲
  const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], dropCaseFor: 'amount|lock', extraCases: [
    { id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', event: EV_E, side: 'match', verdict: 'not-run', reason: 'existing-unverifiable', reasonCategory: 'existing', details: { files: ['common.js'] }, message: '既存の JavaScript の読み込みを再現できません' },
    { id: 'K2', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'not-locked', event: EV_E, side: 'nomatch', verdict: 'not-run', reason: 'existing-unverifiable', reasonCategory: 'existing', details: { files: ['common.js'] }, message: '既存の JavaScript の読み込みを再現できません' }] }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1, html = finalHtml(x);
  const outside = stripC(outsideDetails(html));
  assert(e.status === 'not-run' && e.verdict.kind === 'out-of-reach' && !e.verdict.fix && !v.final.fix && !fixButtonOf(html) && /対応できない範囲/.test(e.verdict.reason) && /「common\.js」/.test(e.verdict.reason) && e.verdict.details.some(d => /「common\.js」: その画面で登録する処理を確かめられません/.test(d)) && /existing-unverifiable/.test(e.verdict.details.join('\n')) && !/existing-unverifiable/.test(outside) && /対応できない範囲/.test(outside) && v.final.approvable === false && x.gen.calls.length === 1 && !x.gen.calls[0].feedback, `D39-2: existing-unverifiable → 操作を出さず「対応できない範囲」（ファイル名は通常画面・理由の語は詳細表示）・修復も依頼しない: ${JSON.stringify({ verdict: e.verdict, fix: v.final.fix })}`);
  assert(/対応できない範囲です。計画を直しても解けない/.test(v.final.blockingReason) && !/実機で確かめ/.test(v.final.blockingReason), `D39-3: 準備未完了の理由も「対応できない範囲」（実機で確かめるとは出さない）: ${v.final.blockingReason}`);
  //   解ける理由と解けない理由が同じ JavaScript に混ざる → 解けない理由を優先して操作を出さない（計画を直しても承認できる最終案にならない）
  const y = makeConvC({ generate: makeGenerate({ sequence: ['good'], dropCaseFor: 'amount|lock', relatedOmitted: [{ name: 'biz.js', target: 'desktop', reason: 'url', events: null, url: 'https://intra.example.co.jp/biz.js' }], extraCases: [
    { id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', event: EV_E, side: 'match', verdict: 'not-run', reason: 'condition-unparsed', message: '' }] }) });
  await adoptC(y);
  const ey = y.c.activePlan().generated.C1;
  assert(ey.verdict.kind === 'out-of-reach' && !ey.verdict.fix && !y.c.activePlan().final.fix && /「https:\/\/intra\.example\.co\.jp\/biz\.js」/.test(ey.verdict.reason) && ey.verdict.details.some(d => /URL で読み込むファイル/.test(d)), `D39-4: 解けない理由が混ざれば操作を出さない（URL のファイルは URL 全体で出す）: ${JSON.stringify(ey.verdict)}`);
  //   解ける理由だけ（既存 JS との競合が観測された・条件の形・other-platform・condition-value-unknown）は［計画を直すよう依頼する］
  for (const env of ['existing', 'condition-unparsed', 'other-platform', 'condition-value-unknown']) {
    const z = makeConvC({ generate: makeGenerate({ sequence: ['good'], env, caseReason: env }) });
    await adoptC(z);
    const ez = z.c.activePlan().generated.C1;
    assert(ez.verdict.fix === 'revise' && !ez.verdict.unfixable && z.c.activePlan().final.fix && z.c.activePlan().final.fix.kind === 'revise' && fixButtonOf(finalHtml(z)), `D39-5（${env}）: 計画を直せば解ける理由は［計画を直すよう依頼する］: ${JSON.stringify(ez.verdict)}`);
  }
  //   condition-value-unknown の値（Gateway の details.values）を依頼の文に添える（入口で details を落とさない）
  const w = makeConvC({ generate: makeGenerate({ sequence: ['good'], dropCaseFor: 'amount|lock', extraCases: [
    { id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', event: EV_E, side: 'match', verdict: 'not-run', reason: 'condition-value-unknown', details: { field: 'ステータス', label: 'ステータス', values: ['部長承認待ち'] }, message: '条件に合うレコードを作れません' },
    { id: 'K2', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'not-locked', event: EV_E, side: 'nomatch', verdict: 'pass', message: '期待どおり' }] }) });
  await adoptC(w);
  const fw = w.c.activePlan().final.fix;
  assert(fw && fw.kind === 'revise' && /「部長承認待ち」/.test(fw.text), `D39-6: condition-value-unknown の値（details.values）を計画を直す依頼の文に添える: ${JSON.stringify(fw)}`);
});

// D40（効果レビュー A8・隔離 4）: URL のファイルは URL 全体で区別する（末尾の名前でまとめない）。既知の配布元の判定は URL を解析し、userinfo のある URL は外し、正規化した後の pathname で比べる
await section(async () => {
  const data = { customize: { desktop: { js: [{ type: 'URL', url: 'https://cdnjs.cloudflare.com/ajax/libs/somelib/1.0.0/main.js' }, { type: 'URL', url: 'https://intra.example.co.jp/kintone/main.js' }, { type: 'FILE', file: { name: 'main.js', fileKey: 'fk1' } }] } } };
  const files = KTScan.summarizeFiles({ files: [{ name: 'main.js', target: 'desktop', kind: 'js', text: "kintone.events.on('app.record.index.show', function (e) { return e; });" }] }, data);
  const mains = files.filter(f => f.name === 'main.js');
  assert(mains.length === 3 && mains.filter(f => f.url).length === 2 && mains.find(f => !f.url).sourceAvailable === true && mains.filter(f => f.url).every(f => !f.sourceAvailable), `D40-1（rv5 F8a）: 同じ名前の URL のファイル 2 つと FILE 1 つを別々に持つ（FILE の本文を URL のファイルに付けない）: ${JSON.stringify(mains.map(f => [f.url || 'FILE', f.sourceAvailable]))}`);
  const sel = KTContext.relatedFilesFor(files, { targets: ['desktop'], requiredEffects: REQ_LOCK });
  const omUrl = sel.relatedOmitted.filter(f => f.reason === 'url');
  assert(omUrl.length === 2 && omUrl.find(f => /cdnjs/.test(f.url)).events.length === 0 && omUrl.find(f => /intra/.test(f.url)).events === null, `D40-2: relatedOmitted も URL ごと（既知の配布元は []・自社のサーバーは null）: ${JSON.stringify(omUrl)}`);
  const er = KTCodeReview.effectResults(VER_LOCK_OK, REQ_LOCK, { omitted: sel.relatedOmitted });
  assert(!er.ok && er.reason === 'related-file-omitted' && er.omittedHit.some(f => f.url === 'https://intra.example.co.jp/kintone/main.js'), `D40-3（rv5 F8a）: 自社のサーバーの同じ名前の JS を既知のライブラリとしてまとめて素通りさせない: ${JSON.stringify({ ok: er.ok, hit: er.omittedHit })}`);
  //   統合先（FILE の main.js）と同じ名前の URL のファイルは統合先として外さない
  const sel2 = KTContext.relatedFilesFor(files, { targets: ['desktop'], requiredEffects: REQ_LOCK, existing: { name: 'main.js', target: 'desktop' } });
  assert(sel2.relatedOmitted.filter(f => f.reason === 'url').length === 2 && !sel2.relatedFiles.some(f => f.name === 'main.js'), `D40-4: 統合先は URL 全体でも見る（同じ名前の URL のファイルを統合先と取り違えない）: ${JSON.stringify(sel2)}`);
  //   Generator Context には url を送らない（契約の形のまま。Toolkit の表示用）
  const ctx = KTContext.buildGenerator({ customization: CUST_C1, plan: { customizations: [CUST_C1] }, planId: 'p', version: 1, data: clone(DATA_C), verification: { requirementIds: [], requiredEffects: REQ_LOCK, relatedFiles: [], relatedOmitted: sel.relatedOmitted } });
  assert(ctx.verification.relatedOmitted.every(f => !('url' in f)) && ctx.verification.relatedOmitted.filter(f => f.name === 'main.js' && f.reason === 'url').length === 2 && ctx.verification.relatedOmitted.filter(f => f.name === 'main.js' && f.reason === 'other').length === 1, `D40-5: Generator Context の relatedOmitted は契約の形（name・target・reason・events）のまま: ${JSON.stringify(ctx.verification.relatedOmitted)}`);
  //   抜け道（隔離 4）: userinfo・/npm/../gh/・%2e%2e・既定以外の port は既知の配布元にしない。正規化しても /npm/ の中なら既知
  const bad = ['https://js.cybozu.com@evil.example/biz.js', 'https://cdn.jsdelivr.net/npm/../gh/acme/x.js', 'https://cdn.jsdelivr.net/npm/%2e%2e/gh/acme/x.js', 'https://user:pw@unpkg.com/x.js', 'https://cdn.jsdelivr.net:8443/npm/x.js', 'https://ajax.googleapis.com/ajax/libs/../../other/x.js', 'ftp://js.cybozu.com/x.js', 'https://js.cybozu.com./x.js'];
  //   §0d.3: jsDelivr・unpkg は既知の配布元から外したので、正規化の確かめは cdnjs の /ajax/libs/ と code.jquery.com の既定の port で行う
  const good = ['https://JS.CYBOZU.COM/luxon/3.4.4/luxon.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/a/../b/x.js', 'https://code.jquery.com:443/jquery-3.7.1.min.js'];
  assert(bad.every(u => !KTScan.isKnownLibraryUrl(u)) && good.every(u => KTScan.isKnownLibraryUrl(u)), `D40-6（隔離 4）: 既知の配布元の判定は URL を解析して比べる（userinfo・.. の抜け道を塞ぐ）: ${JSON.stringify({ bad: bad.filter(u => KTScan.isKnownLibraryUrl(u)), good: good.filter(u => !KTScan.isKnownLibraryUrl(u)) })}`);
});

// D41（§0c.9・health の印）: caseSide を新しい形の印に加える。欠ける接続先は「接続先が非対応」（side の無い結果で二重の安全を判定しない）
await section(async () => {
  const x = makeConvC({ supported: GEN_EFFECT_FEATURES.filter(f => f !== 'caseSide') });
  await adoptC(x);
  const e = x.c.activePlan().generated.C1;
  assert(e.status === 'unsupported' && x.c.activePlan().final.approvable === false, `D41: health に caseSide が無い → 新しい形で送らず「接続先が非対応」: ${JSON.stringify({ status: e.status, sent: x.gen.calls[0] && x.gen.calls[0].requiredEffects })}`);
});
// D42（結合の回帰で見つけた食い違い・2026-10-08）: Gateway の existing-unverifiable / unsupported（読み込み）の details.files は契約 20 §13 の [{ name, kinds[] }]。
//   入口（normalizeVerification）でオブジェクトの要素を落とすと、「対応できない範囲」にファイル名が出ない。名前（文字列）として残す
await section(async () => {
  const EV = 'app.record.edit.show';
  const raw = { version: '1', candidateHash: '0123456789abcdef', passed: true, machine: [], requiredEffects: [{ requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect: 'lock', status: 'present' }],
    behavior: { status: 'not-run', reason: 'existing-unverifiable', cases: [{ id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', event: EV, side: 'match', kind: 'match', platform: 'desktop', verdict: 'not-run', reason: 'existing-unverifiable', reasonCategory: 'existing', details: { files: [{ name: 'e.js', kinds: ['stub-callback'] }, 'f.js'] }, message: 'x' }] },
    repairs: { count: 0, reasons: [], stoppedBy: null }, unverified: [] };
  const n = KTAiClient.normalizeVerification(raw);
  assert(JSON.stringify(n.behavior.cases[0].details.files) === '["e.js","f.js"]', `D42: details.files のオブジェクトの要素は name の文字列として残す（文字列の要素はそのまま）: ${JSON.stringify(n.behavior.cases[0].details)}`);
});
// D43（§0c.10・隔離レビュー A1）: kintone.events.on を呼んでいるのに第 1 引数を解けないファイル（イベント名を組み立てる・別名で登録する）に eventsUnresolved の印を付け、
//   同じ platform なら必須の効果に関係が見えなくても動作テストに送る。送れなければ relatedOmitted の events null（その platform の代表条件は verified にしない）
await section(async () => {
  const REQ_AL = [reqLockOf('amount', [EV_E, EV_I], 'ステータス in ("承認済み")')];
  const VER_AL = verOfCases(['amount'], fullCases(['amount'], [EV_E, EV_I]));
  const X1 = "(function(){ 'use strict'; var screens = ['edit', 'index.edit']; kintone.events.on(screens.map(function (s) { return `app.record.${s}.show`; }), function (e) { e.record.memo.error = '備考を確認してください'; return e; }); })();";
  const X1B = "(function(){ const P = 'app.record.'; kintone.events.on([P + 'edit.show', P + 'index.edit.show'], function (e) { e.record.memo.error = 'x'; return e; }); })();";
  const ALIAS = "(function(){ const on = kintone.events.on; on('app.record.edit.show', function (e) { e.record.memo.error = 'x'; return e; }); })();";
  const LIT = "(function(){ kintone.events.on('app.record.detail.show', function (e) { return e; }); })();";
  const R = KTScan.eventRegistrationsOf;
  assert(R(X1).unresolved && R(X1).reasons.includes('dynamic-event-name') && !R(X1B).unresolved && JSON.stringify(R(X1B).events) === JSON.stringify([EV_E, EV_I]) && R(ALIAS).unresolved && R(ALIAS).reasons.includes('events-reference') && !R(LIT).unresolved && JSON.stringify(R(LIT).events) === '["app.record.detail.show"]' && !R("window.CommonUtil = {};").unresolved && R("const k = kintone; k.events.on('app.record.edit.show', function (e) { return e; });").unresolved && !R("(function (kintone) { kintone.events.on('app.record.edit.show', function (e) { return e; }); })(kintone);").unresolved && R("var evs = ['app.record.detail.show']; evs.push('app.record.edit.show'); kintone.events.on(evs, function (e) { return e; });").unresolved,
    `D43-1: 登録の第 1 引数を構文解析で読む（組み立て・別名・書き換える配列は読めない。リテラル・連結・const は読める。§0c.11 で Gateway と同じ理由の名前）: ${JSON.stringify({ X1: R(X1), X1B: R(X1B), ALIAS: R(ALIAS) })}`);
  //   簡素化 B（2026-10-16）: 同梱の acorn の使い先はこの登録の読み取りだけになった（記法の検査 KTModernJs は削除）。kintone のページには AMD の define（define.amd）が
  //   あるが、同梱の acorn は define に登録されず、登録を読める（以前は ai-modern-js の M6 が KTModernJs で確かめていた）
  const regsOnPage = loadToolkit({ pageDefine: true }).KTScan.eventRegistrationsOf;
  assert(!regsOnPage(LIT).unresolved && JSON.stringify(regsOnPage(LIT).events) === '["app.record.detail.show"]' && !regsOnPage(LIT).reasons.includes('no-parser'), `D43-0: ページに AMD の define があっても、同梱の acorn で登録を読める: ${JSON.stringify(regsOnPage(LIT))}`);
  const dataOf = (names) => ({ customize: { desktop: { js: names.map(n => ({ type: 'FILE', file: { name: n, fileKey: `k-${n}` } })) }, mobile: { js: [] } } });
  const filesOf = (list) => KTScan.summarizeFiles({ files: list.map(([name, text]) => ({ name, target: 'desktop', kind: 'js', text })) }, dataOf(list.map(([n]) => n)));
  const f1 = filesOf([['memo-check.js', X1], ['memo-check2.js', X1B], ['memo-alias.js', ALIAS]]);
  const sel1 = KTContext.relatedFilesFor(f1, { targets: ['desktop'], requiredEffects: REQ_AL });
  assert(f1.find(f => f.name === 'memo-check.js').eventsUnresolved === true && f1.find(f => f.name === 'memo-alias.js').eventsUnresolved === true && !f1.find(f => f.name === 'memo-check2.js').eventsUnresolved && f1.find(f => f.name === 'memo-check2.js').events.includes(EV_I)
    && ['memo-check.js', 'memo-check2.js', 'memo-alias.js'].every(n => sel1.relatedFiles.some(f => f.name === n)) && sel1.relatedFiles.find(f => f.name === 'memo-check.js').events === null,
    `D43-2（rv6s X1・X1b）: 第 1 引数を解けないファイルは印を付けて送る・連結のイベント名は読めたイベントとして選ぶ: ${JSON.stringify({ files: f1.map(f => [f.name, f.eventsUnresolved || false, f.events]), sent: sel1.relatedFiles.map(f => [f.name, f.events]), omitted: sel1.relatedOmitted })}`);
  //   送れない（件数の上限）→ relatedOmitted の events null → 動作テストが合格でも verified にしない（related-file-omitted）
  const many = filesOf([1, 2, 3, 4, 5].map(i => [`alias${i}.js`, ALIAS.replace("'x'", `'x${i}'`)]));
  const sel2 = KTContext.relatedFilesFor(many, { targets: ['desktop'], requiredEffects: REQ_AL });
  const er2 = KTCodeReview.effectResults(VER_AL, REQ_AL, { omitted: sel2.relatedOmitted });
  assert(sel2.relatedFiles.length === 4 && sel2.relatedOmitted.length === 1 && sel2.relatedOmitted[0].reason === 'limit' && sel2.relatedOmitted[0].events === null && !er2.ok && er2.items[0].notRunReasons.includes('related-file-omitted'), `D43-3: 印のあるファイルを送れなければ events null → 合格でも verified にしない: ${JSON.stringify({ sent: sel2.relatedFiles.length, omitted: sel2.relatedOmitted, er: er2.items[0] })}`);
  //   本文の無いキャッシュ（Field Scanner の slim な payload）でも、解析の記録（fileEventsUnresolved）で印を付ける
  const scan = KTScan.buildPayload({ appId: '353', fields: [], files: [{ name: 'memo-check.js', target: 'desktop', kind: 'js', text: X1 }, { name: 'memo-check2.js', target: 'desktop', kind: 'js', text: X1B }], scannedAt: '2026-10-08T00:00:00.000Z' });
  const slim = { ...scan, files: scan.files.map(f => ({ name: f.name, target: f.target, kind: f.kind })) };
  const f3 = KTScan.summarizeFiles(slim, dataOf(['memo-check.js', 'memo-check2.js']));
  const sel3 = KTContext.relatedFilesFor(f3, { targets: ['desktop'], requiredEffects: REQ_AL });
  assert(scan.fileEventsUnresolved && scan.fileEventsUnresolved['desktop:js:memo-check.js'] === true && !scan.fileEventsUnresolved['desktop:js:memo-check2.js'] && scan.fileEvents['desktop:js:memo-check2.js'].some(e => e.name === EV_I)
    && f3.find(f => f.name === 'memo-check.js').eventsUnresolved === true && sel3.relatedOmitted.find(f => f.name === 'memo-check.js').events === null && JSON.stringify(sel3.relatedOmitted.find(f => f.name === 'memo-check2.js').events.slice().sort()) === JSON.stringify([EV_E, EV_I]),
    `D43-4: 本文の無いキャッシュでも印を使う（送れないので events null）・連結のイベント名も解析の記録に残す: ${JSON.stringify({ unres: scan.fileEventsUnresolved, omitted: sel3.relatedOmitted })}`);
});

// D44（§0c.10・隔離レビュー A5）: 同じ platform で送らなかった本文ありのファイル（必須の効果に関係しないもの）も relatedOmitted（reason other、events は解析の結果・登録が無ければ []）として送る。
//   events [] のファイルは代表条件を止めない（Gateway は候補が知らない名前を読んだときだけ related-file-omitted にする）。Gateway に送るのは 50 件まで（other は後ろ）
await section(async () => {
  const REQ_AL = [reqLockOf('amount', [EV_E, EV_I], 'ステータス in ("承認済み")')];
  const VER_AL = verOfCases(['amount'], fullCases(['amount'], [EV_E, EV_I]));
  const COMMON = "window.CommonUtil = { isLocked: function (r) { return r['ステータス'] && r['ステータス'].value === '承認済み'; } };";
  const DETAIL = "(function(){ kintone.events.on('app.record.detail.show', function (e) { return e; }); })();";
  const data = { customize: { desktop: { js: [{ type: 'FILE', file: { name: 'common.js', fileKey: 'k1' } }, { type: 'FILE', file: { name: 'detail.js', fileKey: 'k2' } }] }, mobile: { js: [{ type: 'FILE', file: { name: 'm.js', fileKey: 'k3' } }] } } };
  const files = KTScan.summarizeFiles({ files: [{ name: 'common.js', target: 'desktop', kind: 'js', text: COMMON }, { name: 'detail.js', target: 'desktop', kind: 'js', text: DETAIL }, { name: 'm.js', target: 'mobile', kind: 'js', text: COMMON }] }, data);
  const sel = KTContext.relatedFilesFor(files, { targets: ['desktop'], requiredEffects: REQ_AL });
  const other = sel.relatedOmitted.filter(f => f.reason === 'other');
  assert(!sel.relatedFiles.length && other.length === 2 && JSON.stringify(other.find(f => f.name === 'common.js').events) === '[]' && JSON.stringify(other.find(f => f.name === 'detail.js').events) === '["app.record.detail.show"]' && !sel.relatedOmitted.some(f => f.name === 'm.js'),
    `D44-1（rv6s Y2e）: 送らなかった本文ありのファイルは reason other（events は解析の結果・登録が無ければ []）。別の platform のファイルは入れない: ${JSON.stringify(sel.relatedOmitted)}`);
  const er = KTCodeReview.effectResults(VER_AL, REQ_AL, { omitted: sel.relatedOmitted });
  assert(er.ok && !er.omittedHit.length, `D44-2: events [] / 関係しないイベントの other は代表条件を止めない: ${JSON.stringify({ ok: er.ok, hit: er.omittedHit })}`);
  //   Generator Context: other は後ろにして 50 件まで（limit・url などの送れなかった関係のあるファイルを先に残す）
  const many = [...Array.from({ length: 52 }, (_, i) => ({ name: `o${i}.js`, target: 'desktop', reason: 'other', events: [] })), { name: 'big.js', target: 'desktop', reason: 'limit', events: null }];
  const ctx = KTContext.buildGenerator({ customization: CUST_C1, plan: { customizations: [CUST_C1] }, planId: 'p', version: 1, data: clone(DATA_C), verification: { requirementIds: [], requiredEffects: REQ_LOCK, relatedFiles: [], relatedOmitted: many } });
  assert(ctx.verification.relatedOmitted.length === 50 && ctx.verification.relatedOmitted[0].name === 'big.js' && ctx.verification.relatedOmitted[0].events === null && ctx.verification.relatedOmitted.filter(f => f.reason === 'other').length === 49, `D44-3: Generator Context の relatedOmitted は 50 件まで・other は後ろ: ${JSON.stringify(ctx.verification.relatedOmitted.slice(0, 2))}`);
  //   画面の generate と同じ経路（会話）でも、other は判定を止めない（承認できる最終案のまま）
  const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], relatedOmitted: [{ name: 'common.js', target: 'desktop', reason: 'other', events: [] }] }) });
  await adoptC(x);
  assert(x.c.activePlan().generated.C1.status === 'verified' && x.c.activePlan().final.approvable === true, `D44-4: 関係しない共通ファイル（other・events []）だけなら承認できる最終案のまま: ${JSON.stringify(x.c.activePlan().generated.C1.verdict)}`);
});

// D45（§0c.10 の理由の分け方）: existing（競合を観測した）は［計画を直すよう依頼する］、existing-unrunnable（既存 JS の handler を動かせない）と existing-unverifiable（登録が読めない・消えた）は
//   操作なしの「対応できない範囲」。details.files の名前と種類（fileKinds）を詳細表示に出す。候補の unsupported の作り直しの依頼の文に details.apis の API の名前を入れる
await section(async () => {
  const R = KTAiConversation.BEHAVIOR_REASONS;
  assert(R['existing-unrunnable'] && R['existing-unrunnable'].category === 'existing' && R['existing-unrunnable'].unfixable === true && !R.existing.unfixable && R['existing-unverifiable'].unfixable === true && R['empty-by-existing'] && R['empty-by-existing'].category === 'scope', 'D45-1: 語彙に existing-unrunnable（既存 JS・計画を直しても解けない）と empty-by-existing（対象外）を入れる。existing は解ける理由のまま');
  //   入口: details.files の { name, kinds[], apis[] } は名前の文字列のまま、種類と API の名前は fileKinds に残す
  const raw = { version: '1', candidateHash: '0123456789abcdef', passed: true, machine: [], requiredEffects: [{ requirementIds: ['C1'], field: 'amount', effect: 'lock', status: 'present' }],
    behavior: { status: 'not-run', reason: 'existing-unrunnable', cases: [{ id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', event: EV_E, side: 'match', kind: 'match', platform: 'desktop', verdict: 'not-run', reason: 'existing-unrunnable', details: { files: [{ name: 'biz.js', kinds: ['network'], apis: ['kintone.api'] }] }, message: 'x' }] },
    repairs: { count: 0, reasons: [], stoppedBy: null }, unverified: [] };
  const n = KTAiClient.normalizeVerification(raw);
  assert(JSON.stringify(n.behavior.cases[0].details.files) === '["biz.js"]' && JSON.stringify(n.behavior.cases[0].details.fileKinds) === JSON.stringify([{ name: 'biz.js', kinds: ['network'], apis: ['kintone.api'] }]), `D45-2: 入口は files の名前と、種類・API の名前（fileKinds）を残す: ${JSON.stringify(n.behavior.cases[0].details)}`);
  //   会話: existing-unrunnable → 操作なし・対応できない範囲・詳細にファイルの名前と種類
  const unrun = (reason, details) => [
    { id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', event: EV_E, side: 'match', verdict: 'not-run', reason, reasonCategory: 'existing', details, message: '既存の JavaScript の処理を動かせません' },
    { id: 'K2', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'not-locked', event: EV_E, side: 'nomatch', verdict: 'not-run', reason, reasonCategory: 'existing', details, message: '既存の JavaScript の処理を動かせません' }];
  const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], dropCaseFor: 'amount|lock', extraCases: unrun('existing-unrunnable', { files: ['biz.js'], fileKinds: [{ name: 'biz.js', kinds: ['network'], apis: ['kintone.api'] }] }) }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1, html = finalHtml(x);
  assert(e.verdict.kind === 'out-of-reach' && e.verdict.reasonKey === 'existing-unrunnable' && !e.verdict.fix && !v.final.fix && !fixButtonOf(html) && /「biz\.js」/.test(e.verdict.reason) && e.verdict.details.some(d => /「biz\.js」: その画面の処理（handler）を隔離環境で動かせません（種類: 通信（network）／API: kintone\.api）/.test(d)) && !/実機で確かめ/.test(v.final.blockingReason),
    `D45-3（rv6e G19）: 既存 JS の handler を動かせない → 操作なしの「対応できない範囲」・詳細にファイルの名前と種類: ${JSON.stringify(e.verdict)}`);
  //   existing-unverifiable も同じく操作なし（種類を詳細に）
  const y = makeConvC({ generate: makeGenerate({ sequence: ['good'], dropCaseFor: 'amount|lock', extraCases: unrun('existing-unverifiable', { files: ['memo-check.js'], fileKinds: [{ name: 'memo-check.js', kinds: ['first-arg'], apis: [] }] }) }) });
  await adoptC(y);
  const ey = y.c.activePlan().generated.C1;
  assert(ey.verdict.kind === 'out-of-reach' && !ey.verdict.fix && ey.verdict.details.some(d => /「memo-check\.js」: その画面で登録する処理を確かめられません.*種類: 登録のイベント名を本文から読めない（first-arg）/.test(d)), `D45-4: existing-unverifiable → 操作なし・詳細に種類: ${JSON.stringify(ey.verdict)}`);
  //   候補の unsupported（隔離環境の都合）: 作り直しの依頼の文に原因の API の名前（details.apis）を入れる
  const w = makeConvC({ generate: makeGenerate({ sequence: ['good'], dropCaseFor: 'amount|lock', extraCases: [
    { id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', event: EV_E, side: 'match', verdict: 'not-run', reason: 'unsupported', details: { apis: ['Date.prototype.toLocaleDateString'] }, message: '隔離環境で扱えない書き方・機能があります' },
    { id: 'K2', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'not-locked', event: EV_E, side: 'nomatch', verdict: 'not-run', reason: 'unsupported', details: { apis: ['Date.prototype.toLocaleDateString'] }, message: '隔離環境で扱えない書き方・機能があります' }] }) });
  await adoptC(w);
  const fw = w.c.activePlan().final.fix;
  assert(fw && fw.kind === 'regenerate' && /原因の API: Date\.prototype\.toLocaleDateString/.test(fw.text) && /その書き方・機能（Date\.prototype\.toLocaleDateString）を使わない形で/.test(fw.text), `D45-5（rv6e G20）: 作り直しの依頼の文に原因の API の名前を入れる: ${JSON.stringify(fw)}`);
});

// D46（§0c.10・効果レビュー 1）: 必須の効果に lock が無いフィールド（警告だけ）を編集不可にする候補は、承認・登録できない。
//   lock のフィールドでも、効果のイベントの一部（変更のイベント）で条件の外を編集不可にする候補は、承認・登録できない。
//   §0d.4（2026-10-08）: Toolkit の静的な block（conditional-control・error-cancels-edit の lockNotRequired）と、模擬テストの合格で確認に下げる処理（fieldVerified）は削除した。
//   今の契約の Gateway は、警告の効果に「編集不可にしていない」（kind warn-unlocked・expect not-locked）を customization の保存以外のすべてのイベント（変更のイベントを含む）で作り、
//   誤った候補には不合格を返す（AI版 worker/test/cases/required-effects.mjs の「§0c.10 G10（本物の隔離環境）」「A5 F6」「A5 E7」）。条件つきの lock を変更のイベントで
//   戻さない候補は機械検査 lock-revert の block（同「§0d.1 G4」）。Toolkit はその明示された失敗と、変更のイベントの代表条件を作らない旧い Gateway（health の印 eventCases が無い）を
//   検出して承認・登録しない。下の Gateway の結果の形は、AI版の verify-generated.mjs（machineChecks）と behavior-cases.mjs で同じ候補・同じ計画から確かめたもの
await section(async () => {
  const EV_CH = 'app.record.edit.change.amount';
  const CUST_W = custOf(null, { requirement: '承認待ちなら備考に警告・100 万以上なら金額に警告', events: [EV_E, EV_CH], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'memo', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: [{ effect: 'warn', condition: '', events: [EV_E] }] }, { code: 'amount', access: 'CONTROL', condition: 'amount >= 1000000', effects: [{ effect: 'warn', condition: '', events: [EV_CH] }] }] });
  const G10 = `(function () {\n  'use strict';\n  kintone.events.on(['${EV_E}'], function (event) {\n    const record = event.record;\n    if (${ST_C}) record['memo'].error = '承認待ちです';\n    return event;\n  });\n  kintone.events.on(['${EV_CH}'], function (event) {\n    const record = event.record;\n    if (Number(record['amount'].value) >= 1000000) record['amount'].error = '高額です';\n    record['memo'].disabled = true;\n    return event;\n  });\n})();`;
  const gen = { strategy: 'NEW_JS_FILE', targetFile: 'warn.js', summary: 's', code: G10, patch: null, events: [EV_E, EV_CH], fields: [{ code: 'memo', access: 'CONTROL' }, { code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '', text: 'x' }] };
  const rv = KTCodeReview.review({ generated: gen, customization: CUST_W, plan: null, data: clone(DATA_C), scan: null, existingSource: null });
  const REQ_W = [{ requirementId: 'C1', requirementIds: ['C1'], field: 'memo', effect: 'warn', events: [EV_E], condition: 'ステータス in ("承認待ち")' }, { requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect: 'warn', events: [EV_CH], condition: 'amount >= 1000000' }];
  const wc = (id, field, event, side, expect) => ({ id, requirementIds: ['C1'], field, effect: 'warn', expect, event, side, kind: side, verdict: 'pass', message: '期待どおり' });
  //   警告の「編集不可にしていない」（warn-unlocked）。今の契約の Gateway は、備考の分を金額の変更のイベントで「合う」「合わない」の両方に作る（この候補では不合格）
  const WU_MSG = '金額を変更すると「備考」が編集できなくなりました（警告だけの要件です）';
  const wu = (id, field, event, side, verdict) => ({ id, requirementIds: ['C1'], field, effect: 'warn', expect: 'not-locked', event, side, kind: 'warn-unlocked', verdict, observed: {}, message: verdict === 'fail' ? WU_MSG : '期待どおり' });
  const WU_CASES = [wu('W5', 'memo', EV_CH, 'match', 'fail'), wu('W6', 'memo', EV_CH, 'nomatch', 'fail'), wu('W7', 'amount', EV_E, 'match', 'pass'), wu('W8', 'amount', EV_E, 'nomatch', 'pass')];
  const gwW = (x) => ({ requirementIds: ['C1'], field: x.field, effect: 'warn', status: 'present', check: 'behavior', checkReason: ['effect-kind', 'conditional'], events: x.events.map(ev => ({ event: ev, status: 'present' })) });
  const VER_W = { version: '1', candidateHash: '0123456789abcdef', passed: true, machine: [], requiredEffects: REQ_W.map(gwW), behavior: { status: 'failed', reason: null, cases: [wc('W1', 'memo', EV_E, 'match', 'warn'), wc('W2', 'memo', EV_E, 'nomatch', 'not-warned'), wc('W3', 'amount', EV_CH, 'match', 'warn'), wc('W4', 'amount', EV_CH, 'nomatch', 'not-warned'), ...WU_CASES] } };
  const m = KTCodeReview.attachBehavior(rv, VER_W, { requiredEffects: REQ_W, customization: CUST_W, effectCheck: true });
  const memoI = m.effects.items.find(i => i.field === 'memo'), amountI = m.effects.items.find(i => i.field === 'amount');
  const bf = m.checks.find(ch => ch.name === 'behavior-fail' && !ch.ok);
  assert(!m.effects.ok && memoI && memoI.behavior === 'fail' && amountI && amountI.behavior === 'pass' && bf && bf.severity === 'block' && /備考/.test(bf.message) && m.registration.verdict === 'BLOCKED',
    `D46-1（rv6e G10）: 警告だけのフィールドを編集不可にする候補は、生成工程の「編集不可にしていない」の不合格で登録不可（要件違反。警告の合格で通さない）: ${JSON.stringify({ ok: m.effects.ok, memo: memoI && memoI.behavior, amount: amountI && amountI.behavior, bf: bf && bf.message, verdict: m.registration.verdict })}`);
  //   lock のフィールドでも、条件の外の編集不可が変更のイベント（備考の変更）にある候補。Toolkit が固定する必須の効果は customization のイベントの両方
  const CUST_L = custOf(['lock'], { events: [EV_E, 'app.record.edit.change.memo'] });
  const LCODE = `(function () {\n  'use strict';\n  kintone.events.on(['${EV_E}'], function (event) {\n    const record = event.record;\n    if (${ST_C}) record['amount'].disabled = true;\n    return event;\n  });\n  kintone.events.on(['app.record.edit.change.memo'], function (event) {\n    const record = event.record;\n    record['amount'].disabled = true;\n    return event;\n  });\n})();`;
  const rvL = KTCodeReview.review({ generated: { ...gen, targetFile: 'lock.js', code: LCODE, events: [EV_E, 'app.record.edit.change.memo'], fields: [{ code: 'amount', access: 'CONTROL' }] }, customization: CUST_L, plan: null, data: clone(DATA_C), scan: null, existingSource: null });
  const REQ_L = KTAiConversation.requiredEffectsOf({ customizations: [CUST_L] }, 'C1', [], { labels: LABELS_C }).effects;
  const EV_M = 'app.record.edit.change.memo';
  //   (i) 今の契約の Gateway: 機械検査 lock-revert の block（修復の上限まで直らなかった）・模擬テストは機械検査の不合格のため未実行（machine-blocked）
  const VER_L = { version: '1', candidateHash: '0123456789abcdef', passed: false, machine: [{ name: 'lock-revert', ok: false, severity: 'block', message: '条件つきの編集不可を変更のイベントで設定していますが、条件が外れたときに戻していません' }], requiredEffects: [{ requirementIds: ['C1'], field: 'amount', effect: 'lock', status: 'present', check: 'behavior', checkReason: ['conditional', 'nested'], events: [{ event: EV_E, status: 'present' }, { event: EV_M, status: 'present' }] }], behavior: { status: 'not-run', reason: 'machine-blocked', cases: fullCases(['amount'], [EV_E, EV_M]).map(c => ({ ...c, verdict: 'not-run', reason: 'machine-blocked', message: '機械検査の不合格が残っているので実行していません' })) } };
  const mL = KTCodeReview.attachBehavior(rvL, VER_L, { requiredEffects: REQ_L, customization: CUST_L, effectCheck: true });
  //   (ii) 変更のイベントの代表条件が返らない（効果のイベントの一部だけで合格）→ 確かめていない（返却の欠落）
  const mL2 = KTCodeReview.attachBehavior(rvL, verOfCases(['amount'], fullCases(['amount'], [EV_E])), { requiredEffects: REQ_L, customization: CUST_L, effectCheck: true });
  assert(REQ_L.length === 1 && JSON.stringify(REQ_L[0].events) === JSON.stringify([EV_E, EV_M]) && mL.registration.verdict === 'BLOCKED' && mL.checks.some(ch => ch.name === 'behavior-not-run' && ch.category === 'machine') && mL2.registration.verdict === 'BLOCKED' && !mL2.effects.ok && JSON.stringify(mL2.effects.items[0].lacking) === JSON.stringify([{ event: EV_M, side: 'match' }, { event: EV_M, side: 'nomatch' }]),
    `D46-2: 変更のイベントで条件の外を編集不可にする候補は、生成工程の機械検査の不合格（模擬テストは未実行）でも、そのイベントの代表条件が返らなくても登録不可: ${JSON.stringify({ events: REQ_L.map(e => e.events), verdict: mL.registration.verdict, verdict2: mL2.registration.verdict, lacking: mL2.effects.items[0] && mL2.effects.items[0].lacking })}`);
  //   会話: 警告だけのフィールドを編集不可にする候補は承認できない（未確認ではなく、模擬テストで期待どおりに動かなかった問題として計画の見直しの対象）
  CAND.g10 = { code: G10, has: { memo: ['warn'], amount: ['warn'] } };
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_W, summary: '承認待ちなら備考に警告を出します。' }), generate: makeGenerate({ sequence: ['g10'], generatedOf: () => clone(gen), extraCases: WU_CASES }) });
  await adoptC(x);
  const vx = x.c.activePlan(), ex = vx.generated.C1;
  assert(ex.status === 'unresolved' && ex.verdict.kind === 'behavior-fail' && ex.verdict.fix === 'revise' && vx.final.approvable === false && ex.review.checks.some(ch => ch.name === 'behavior-fail' && ch.severity === 'block' && /備考/.test(ch.message)) && x.c.approveFinal({ planId: vx.planId, version: vx.version, baseStamp: { fingerprint: 'fp-1' } }).ok === false, `D46-3（rv6e G10）: 会話でも承認できない（模擬テストの不合格・次の手は計画を直す操作）: ${JSON.stringify({ status: ex.status, verdict: ex.verdict && ex.verdict.kind, approvable: vx.final.approvable })}`);
  //   変更のイベントの「編集不可にしていない」を作らない旧い Gateway（health の印 eventCases が無い）は、警告がすべて合格でも新しい形として受け入れない（接続先が非対応）
  const xo = makeConvC({ supported: GEN_EFFECT_FEATURES.filter(f => f !== 'eventCases'), planImpl: (args) => planJs(args, { cust: CUST_W, summary: '承認待ちなら備考に警告を出します。' }), generate: makeGenerate({ sequence: ['g10'], generatedOf: () => clone(gen) }) });
  await adoptC(xo);
  const vxo = xo.c.activePlan(), exo = vxo.generated.C1;
  assert(exo.status === 'unsupported' && vxo.final.approvable === false, `D46-4: 変更のイベントの代表条件を作らない旧い接続先（印 eventCases が無い）では、警告の合格だけで承認できる最終案にしない: ${JSON.stringify({ status: exo.status, approvable: vxo.final.approvable })}`);
  delete CAND.g10;
});
// D47（§0c.10 の確かめない範囲・C-1 第 4 段 2026-10-09）: 最終案の詳細表示に、生成工程（Gateway）が返した模擬テストの条件（behavior.conditions）と
//   確かめていない範囲（behavior.uncheckedScope）を、その文のまま出す。Toolkit は一覧を持たない（前の固定の日時「正午」と固定の一覧は Gateway の定数と食い違った）。
//   通常の画面には出さない。反映は動作テスト環境から始まり、実機での確かめは動作テスト環境で行うことも詳細に書く
await section(async () => {
  const x = makeConvC();
  await adoptC(x);
  const html = rightOf(x);   // 2026-10-14: 模擬テストの条件と確かめていない範囲は右の「変更内容」の検証の明細
  const all = stripC(html), outside = stripC(outsideDetails(html));
  const scopeText = all.slice(all.indexOf('模擬テストの条件と確かめていない範囲'), all.indexOf('反映は動作テスト環境から始まります'));
  const lines = scopeText.split('\n').map(l => l.trim()).filter(Boolean);
  const shown = (t) => lines.includes(`・${t}`);
  assert(x.c.activePlan().final.approvable === true && /kt-ai-final-scope/.test(html) && [...GW_SCOPE.conditions, ...GW_SCOPE.uncheckedScope].every(shown) && /実機での確かめは、動作テスト環境で行ってください/.test(all) && ![...GW_SCOPE.conditions, ...GW_SCOPE.uncheckedScope].some(t => outside.includes(t)) && !/確かめていない範囲/.test(outside),
    `D47: 生成工程が返した模擬テストの条件と確かめていない範囲を、文のまま詳細表示だけに出す: ${JSON.stringify({ lines, outside: outside.slice(0, 300) })}`);
  //   Toolkit の古い固定の文（正午の時計・固定の一覧）は出さない
  assert(!/正午|固定の模擬の利用者|固定の時計が正午/.test(all) && !/URL で読み込む業務の JavaScript（本文を取得していません）/.test(all), `D47-2: Toolkit の古い固定の文は出さない: ${scopeText.slice(0, 400)}`);
  //   入口（normalizeVerification）は Gateway の behavior.conditions・uncheckedScope を落とさない（要素は文字列か { text }。同じ文は 1 つ）
  const nv = KTAiClient.normalizeVerification({ version: '1', candidateHash: '0123456789abcdef', passed: true, machine: [], behavior: { status: 'passed', reason: null, cases: [], conditions: ['日時: 朝 8 時', { key: 'user', text: '利用者: 1 人' }, '日時: 朝 8 時'], uncheckedScope: [{ key: 'ai-error-rate', text: '生成した AI の誤り方' }] } });
  assert(JSON.stringify(nv.behavior.conditions) === JSON.stringify(['日時: 朝 8 時', '利用者: 1 人']) && JSON.stringify(nv.behavior.uncheckedScope) === JSON.stringify(['生成した AI の誤り方']), `D47-3: 入口は条件と確かめていない範囲の文を保つ: ${JSON.stringify(nv.behavior)}`);
  //   印 scopeList がある接続先でも、条件と範囲が返っていなければ「接続先から返っていません」と出す（古い固定の文で埋めない）
  const y = makeConvC({ generate: makeGenerate({ scope: false }) });
  await adoptC(y);
  const ally = stripC(rightOf(y));
  assert(/模擬テストの条件は接続先から返っていません/.test(ally) && !/正午|固定の模擬の利用者/.test(ally) && !GW_SCOPE.conditions.some(t => ally.includes(t)) && !GW_SCOPE.uncheckedScope.some(t => ally.includes(t)), `D47-4: 条件が返っていない接続先では「接続先から返っていません」: ${ally.slice(ally.indexOf('模擬テストの条件'), ally.indexOf('模擬テストの条件') + 200)}`);
  //   生成工程が隔離環境の応答を得ていない（conditions が null）ときは、入口で conditionsNotRun の印だけを持ち、カードは「実行していないため条件はありません」と出す
  //   （確かめていない範囲は返った文をそのまま出す。条件を推測して出さない）
  const nv0 = KTAiClient.normalizeVerification({ version: '1', candidateHash: '0123456789abcdef', passed: true, machine: [], behavior: { status: 'not-run', reason: 'unavailable', cases: [], conditions: null, uncheckedScope: [{ key: 'ai-error-rate', text: '生成 AI の誤り方' }] } });
  const z = makeConvC({ generate: makeGenerate({ env: 'unavailable', scope: { conditionsNotRun: true, uncheckedScope: ['テストの確かめない範囲 3'] } }) });
  await adoptC(z);
  const allz = stripC(rightOf(z));
  assert(nv0.behavior.conditionsNotRun === true && !('conditions' in nv0.behavior) && JSON.stringify(nv0.behavior.uncheckedScope) === JSON.stringify(['生成 AI の誤り方']) && /模擬テストを隔離環境で実行していないため、模擬テストの条件はありません/.test(allz) && /・テストの確かめない範囲 3/.test(allz) && !/接続先から返っていません/.test(allz),
    `D47-5: 隔離環境の応答が無い（conditions null）ときは「実行していないため条件はありません」: ${JSON.stringify({ nv0: nv0.behavior, card: allz.slice(allz.indexOf('模擬テストの条件と'), allz.indexOf('模擬テストの条件と') + 200) })}`);
});

// D48（§0c.10 の show-hide の向き）: show-hide の condition は隠す条件。代表条件の表示は、条件に合うレコードで「表示されない」、合わないレコードで「表示される」
await section(async () => {
  CAND.sh = { code: handlerC(`    kintone.app.record.setFieldShown('amount', !(${ST_C}));`), has: { amount: ['show-hide'] } };
  const CUST_S = custOf(['show-hide']);
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_S, summary: '承認待ちでは金額を隠します。' }), generate: makeGenerate({ sequence: ['sh'] }) });
  await adoptC(x);
  const all = stripC(rightOf(x));
  assert(/表示されない（隠す条件に合う）/.test(all) && /表示される（隠す条件に合わない）/.test(all), `D48: show-hide の代表条件は隠す条件の向きで表示する: ${all.slice(all.indexOf('代表条件'), all.indexOf('代表条件') + 300)}`);
  delete CAND.sh;
});
// D49（§0c.10・§0c.11・health の印）: Gateway の eventCases・loadFaithful・registrationCheck・emptyCase・hideCondition・registrationCounts・caseCoverage のどれかが欠ける接続先は「接続先が非対応」
//   （理由の分け方・警告の「編集不可にしていない」・show-hide の向きが Toolkit の判定と食い違うので、新しい形として受け入れない）
//   C-1 第 3 段（2026-10-08）: cancelCheck（候補の error による既存 JS の編集不可の取り消し・existing-lock-unverified）と limitCode（coverage の制約の符号）も同じ
//   C-1 第 4 段（2026-10-09）: scopeList（模擬テストの条件と確かめていない範囲を返す）も同じ
await section(async () => {
  const out = [];
  for (const mark of ['eventCases', 'loadFaithful', 'registrationCheck', 'emptyCase', 'hideCondition', 'registrationCounts', 'caseCoverage', 'cancelCheck', 'limitCode', 'scopeList']) {
    const x = makeConvC({ supported: GEN_EFFECT_FEATURES.filter(f => f !== mark) });
    await adoptC(x);
    out.push([mark, x.c.activePlan().generated.C1.status, x.c.activePlan().final.approvable]);
  }
  assert(out.every(r => r[1] === 'unsupported' && r[2] === false), `D49: §0c.9・§0c.10・§0c.11 の印が欠ける接続先は「接続先が非対応」: ${JSON.stringify(out)}`);
});
// D50（§0c.11・効果レビュー 6・rv7e P18）: 保存だけの警告（そのフィールドの効果がすべて保存のイベントだけの warn）は、保存の handler で確認のダイアログを出すだけで満たせる。
//   簡素化 B（2026-10-17）: 計画で制御するフィールドがコードに現れるかの判定（Toolkit の planned-fields と、保存だけの警告の例外）は削除した。処理の有無は生成工程の
//   必須の効果（効果のイベントごとの処理の形）が決め、Toolkit はその結果（present・missing・unchecked・非対応）を取り込む
await section(async () => {
  const EV_S = 'app.record.edit.submit';
  const CUST_SW = custOf([{ effect: 'warn', condition: '', events: [EV_S] }], { requirement: '承認待ちでは保存のときに確認する（保存は止めない）', events: [EV_S] });
  CAND.saveconfirm = { code: handlerC(`    if ((${ST_C}) && !window.confirm('承認待ちです。保存しますか？')) return false;`, [EV_S]), has: { amount: ['warn'] } };
  CAND.saveconfirmr = { code: handlerC(`    if ((${ST_C}) && !window.confirm('承認待ちです（金額: ' + record['amount'].value + '）。保存しますか？')) return false;`, [EV_S]), has: { amount: ['warn'] } };
  const run = async (cust, o = {}) => { const x = makeConvC({ planImpl: (args) => planJs(args, { cust, summary: '承認待ちでは保存のときに確認します（保存は止めません）。' }), generate: makeGenerate({ sequence: [o.cand || 'saveconfirm'], ...(o.gen || {}) }) }); await adoptC(x); const v = x.c.activePlan(), e = v.generated.C1; return { v, e, pf: e.review.checks.find(ch => ch.name === 'planned-fields') || null, re: e.review.checks.find(ch => ch.name === 'required-effects') || null }; };
  const a = await run(CUST_SW);
  assert(a.v.final.approvable === true && a.e.status === 'verified' && !a.pf && a.re && a.re.ok && !a.e.review.checks.some(ch => !ch.ok && ch.severity === 'block'),
    `D50-1（rv7e P18）: 保存だけの警告で確認のダイアログだけの正しい候補は承認できる（Toolkit は planned-fields を作らない・必須の効果は生成工程の present）: ${JSON.stringify({ status: a.e.status, approvable: a.v.final.approvable, pf: a.pf, blocks: a.e.review.checks.filter(ch => !ch.ok && ch.severity === 'block').map(ch => ch.name) })}`);
  //   対照（rv7e P18r）: フィールドを文に入れる候補も承認できる
  const r = await run(CUST_SW, { cand: 'saveconfirmr' });
  assert(r.v.final.approvable === true && r.e.status === 'verified' && !r.pf, `D50-2（rv7e P18r）: フィールドを文に入れる候補も承認できる: ${JSON.stringify({ status: r.e.status, pf: r.pf })}`);
  //   同じフィールドに画面の編集不可もある → 編集不可の処理が無いことは生成工程の必須の効果（missing）で止める
  const CUST_WL = custOf([{ effect: 'warn', condition: '', events: [EV_S] }, { effect: 'lock', condition: '', events: ['app.record.edit.show'] }], { requirement: '承認待ちでは金額を編集不可にし、保存のときに確認する', events: ['app.record.edit.show', EV_S] });
  const b = await run(CUST_WL);
  assert(b.v.final.approvable === false && !b.pf && b.re && !b.re.ok && b.re.severity === 'block', `D50-3: ほかの効果（lock）の処理が無ければ、生成工程の必須の効果の missing で止める: ${JSON.stringify({ status: b.e.status, re: b.re })}`);
  //   表示のイベントの警告（保存だけではない）→ 表示のイベントの処理が無いことは、生成工程の必須の効果（効果のイベントごとの処理の形）が missing で返す
  const CUST_WS = custOf([{ effect: 'warn', condition: '', events: ['app.record.edit.show', EV_S] }], { requirement: '承認待ちでは金額に警告を出す', events: ['app.record.edit.show', EV_S] });
  const c = await run(CUST_WS, { gen: { statusOverride: 'missing' } });
  assert(c.v.final.approvable === false && !c.pf && c.re && !c.re.ok && c.re.severity === 'block', `D50-4: 表示のイベントの警告の処理が無ければ、生成工程の必須の効果の missing で止める: ${JSON.stringify({ status: c.e.status, re: c.re })}`);
  //   Gateway が present を返さない（unchecked）→ 確かめられていないので止める
  const d = await run(CUST_SW, { gen: { statusOverride: 'unchecked' } });
  assert(d.v.final.approvable === false && !d.pf && d.re && !d.re.ok && d.re.severity === 'block', `D50-5: 必須の効果が present でない（unchecked）なら止める: ${JSON.stringify({ status: d.e.status, re: d.re })}`);
  //   純関数: 生成工程が非対応（requiredEffects を返さない）なら、必須の効果を確かめられないので止める（Toolkit の形式確認は planned-fields を作らない）
  const rv = KTCodeReview.review({ generated: { strategy: 'NEW_JS_FILE', targetFile: 'w.js', summary: 's', code: CAND.saveconfirm.code, patch: null, events: [EV_S], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [] }, customization: CUST_SW, plan: null, data: clone(DATA_C), scan: null, existingSource: null });
  const req = [{ requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect: 'warn', events: [EV_S], condition: 'ステータス in ("承認待ち")' }];
  const old = KTCodeReview.attachBehavior(rv, { version: '1', candidateHash: '0123456789abcdef', passed: true, machine: [] }, { requiredEffects: req, customization: CUST_SW });
  const re1 = old.checks.find(ch => ch.name === 'required-effects');
  assert(!rv.checks.some(ch => ch.name === 'planned-fields') && re1 && !re1.ok && re1.severity === 'block' && /対応していない/.test(re1.message), `D50-6: 生成工程が必須の効果の確認に非対応なら止める（Toolkit は planned-fields を作らない）: ${JSON.stringify({ re1 })}`);
  delete CAND.saveconfirm; delete CAND.saveconfirmr;
});
// D51（§0c.11・隔離レビュー 2）: アプリ解析の登録の印（eventsUnresolved）は、契約 20 §13 の登録の照合（Gateway の staticRegistrationsOf）と同じ言葉で決める。
//   計算した添字の kintone・window / globalThis / self 以外からの .kintone・eval / Function（文字列のタイマー）・const の配列の書き換え・ループの中の登録は読めない。
//   呼び出しの場所ごとのイベントの回数（counts）も返す。読めないファイルは同じ platform なら動作テストに送る（送れなければ events null）
await section(async () => {
  const R = KTScan.eventRegistrationsOf;
  const H = "function (e) { e.record.amount.error = 'x'; return e; }";
  const EVS = "['app.record.edit.show','app.record.index.edit.show']";
  const cases = [
    ['R2（window の計算した添字）', `(function(){ if (location.hostname !== 'a.cybozu.com') return; window['kintone'].events.on(${EVS}, ${H}); })();`, ['kintone-computed']],
    ['計算した添字（名前を連結）', `(function(){ var k = 'kin' + 'tone'; window[k].events.on(${EVS}, ${H}); })();`, ['kintone-computed']],
    ['R2e（top.kintone）', `(function(){ if (kintone.getLoginUser().code !== 'admin') return; top.kintone.events.on(${EVS}, ${H}); })();`, ['kintone-foreign']],
    ['this.kintone', `this.kintone.events.on(${EVS}, ${H});`, ['kintone-foreign']],
    ['R2d（eval の文字列）', `(function(){ if (kintone.getLoginUser().code !== 'admin') return; eval("kintone.events.on('app.record.edit.show', function (e) { return e; })"); })();`, ['eval-reference']],
    ['new Function', `(function(){ new Function("kintone.events.on('app.record.edit.show', function (e) { return e; })")(); })();`, ['eval-reference']],
    ['文字列のタイマー', `(function(){ setTimeout("kintone.events.on('app.record.edit.show', function (e) { return e; })", 0); })();`, ['eval-reference']],
    ['R10（const の配列に push）', `(function(){ const E = ['app.record.detail.show']; if (kintone.getLoginUser().code === 'admin') E.push('app.record.edit.show'); kintone.events.on(E, ${H}); })();`, ['mutable-array']],
    ['R10b（添字への代入）', `(function(){ const E = ['app.record.detail.show']; if (location.hostname === 'a.cybozu.com') E[0] = 'app.record.edit.show'; kintone.events.on(E, ${H}); })();`, ['mutable-array']],
    ['関数への受け渡し', `(function(){ const E = ['app.record.detail.show']; addMore(E); kintone.events.on(E, ${H}); })();`, ['mutable-array']],
    ['ループの中の登録', `(function(){ for (var i = 0; i < 2; i++) { kintone.events.on('app.record.edit.show', ${H}); } })();`, ['in-loop']],
    ['var の変数', `(function(){ var E = ['app.record.edit.show']; kintone.events.on(E, ${H}); })();`, ['dynamic-event-name']],
    ['即時実行でない関数の中', `function init(){ kintone.events.on('app.record.edit.show', ${H}); } init();`, ['not-top-level']],
    ['handler の中の登録', `kintone.events.on('app.record.detail.show', function (e) { kintone.events.on('app.record.edit.show', ${H}); return e; });`, ['nested-registration']],
    ['window.kintone.events', `(function(){ window.kintone.events.on('app.record.edit.show', ${H}); })();`, ['events-reference']],
    ['kintone.events.off', `(function(){ kintone.events.on('app.record.edit.show', ${H}); kintone.events.off('app.record.edit.show'); })();`, ['events-off']],
  ];
  const bad = cases.filter(([, text, want]) => { const r = R(text); return !(r.unresolved && JSON.stringify(r.reasons) === JSON.stringify(want)); }).map(([id, text]) => [id, R(text)]);
  assert(!bad.length, `D51-1: 読めない形は契約と同じ理由の名前で unresolved: ${JSON.stringify(bad)}`);
  //   読める形（対照）と回数: R1（同じイベントに 2 つの登録。片方は利用者で分岐）は読めて、回数は呼び出しの場所ごと。typeof・instanceof・Function.prototype の参照は読める
  const r1 = R(`(function(){ kintone.events.on(${EVS}, function (e) { return e; }); if (kintone.getLoginUser().code === 'admin') { kintone.events.on(${EVS}, ${H}); } })();`);
  const r5 = R(`(function(){ const P = 'app.record.'; const E = [P + 'edit.show', P + 'index.edit.show']; kintone.events.on(E, ${H}); })();`);
  const rt = R(`(function(){ if (typeof Function === 'function' && x instanceof Function) {} var f = Function.prototype.call; if (typeof kintone === 'undefined' || !window.kintone) return; kintone.events.on('app.record.edit.show', ${H}); })();`);
  const ri = R(`(function (kintone) { kintone.events.on('app.record.edit.show', ${H}); })(window.kintone);`);
  assert(!r1.unresolved && JSON.stringify(r1.counts) === JSON.stringify({ 'app.record.edit.show': 2, 'app.record.index.edit.show': 2 }) && !r5.unresolved && JSON.stringify(r5.events) === JSON.stringify(['app.record.edit.show', 'app.record.index.edit.show']) && !rt.unresolved && !ri.unresolved,
    `D51-2: 読める形（同じイベントの 2 つの登録・const の連結・判定の位置・即時実行の関数の引数 kintone）と、呼び出しの場所ごとの回数: ${JSON.stringify({ r1, r5, rt, ri })}`);
  //   共通の関数だけのファイル（kintone も events も無い）は読める（登録なし）。構文エラーは kintone と events を含むときだけ読めない（Toolkit だけの扱い）
  const rc = R("window.KtCommon = { isBlank: function (v) { return v == null || v === ''; } };");
  const rp = R("kintone.events.on('app.record.edit.show', function (e) { return e; ");
  assert(!rc.unresolved && !rc.events.length && rp.unresolved && JSON.stringify(rp.reasons) === '["parse-error"]' && !R('var x = ;').unresolved, `D51-3: 登録の無いファイル・構文エラーの扱い: ${JSON.stringify({ rc, rp })}`);
  //   読めないファイルは同じ platform なら必須の効果に関係が見えなくても送る（R10: 静的には詳細画面だけに見えるが、管理者のときは編集画面にも登録する）
  const REQ_AL = [reqLockOf('amount', [EV_E, EV_I], 'ステータス in ("承認済み")')];
  const R10 = cases.find(c => /^R10（/.test(c[0]))[1];
  const files = KTScan.summarizeFiles({ files: [{ name: 'r10.js', target: 'desktop', kind: 'js', text: R10 }] }, { customize: { desktop: { js: [{ type: 'FILE', file: { name: 'r10.js', fileKey: 'k' } }] }, mobile: { js: [] } } });
  const sel = KTContext.relatedFilesFor(files, { targets: ['desktop'], requiredEffects: REQ_AL });
  assert(files[0].eventsUnresolved === true && sel.relatedFiles.some(f => f.name === 'r10.js' && f.events === null), `D51-4（rv7s R10）: 書き換える配列のファイルは印を付けて送る: ${JSON.stringify({ f: files[0].eventsUnresolved, sent: sel.relatedFiles.map(f => [f.name, f.events]) })}`);
});
// 追加指示 §5 の表の 9 行は、§0c.8・§0c.9 の修正の後も上の D1〜D9 で同じ期待のまま確かめている（期待値は弱めていない。§0c.9 では偽の生成工程の代表条件を、イベントごとの合う・合わない（side）の形にしただけ）

// =========================================================
// §0d（2026-10-08）: C-1 の範囲の固定（toolkit-ai-flow-redesign.md §0d.1・§0d.3）の Toolkit の担当の回帰。
//   E1 効果ごとの確かめ方の受け取り（check・checkReason・events を入口で落とさない／check: machine は構造の照合だけで合格に数える／印 effectCheck が無ければ今の厳しい判定）
//   E2 会話: sc-gate の S1（条件の無い lock）は隔離環境なしで承認できる・S1b（一覧の編集で処理が無い）・S2（条件つき）・S7（同じイベントの error と編集不可）は承認できない
//   E3 準備未完了の理由: 模擬テストが要る効果は checkReason から「この効果は模擬テストで確かめる必要があります（…）。模擬テストの環境が使えないため、まだ反映できません」と一度にまとめる
//   E4 検証の後の書き換えをやめる: 生成工程が検証した候補と登録する候補（candidateHash・本文）が同じ。var は書き換えず反映直前の形式確認で止める
//   E5 既知の配布元: jsDelivr・unpkg は null（npm の業務 JS を素通りさせない）
//   E6 appFields の required
//   E7 保存禁止を event.error で実装した正しい候補（S4）を planned-fields で止めない
//   E8 表示: 未確認の一覧・「模擬テスト」と「動作テスト環境」の呼び分け・反映の結果のカードに実機が未確認と確かめ方
console.log('\n--- §0d. C-1 の範囲の固定（2026-10-08）: 効果ごとの確かめ方・準備未完了の理由・検証の後の書き換え・既知の配布元・required・保存禁止・表示 ---');
const EV_SH = ['app.record.edit.show', 'app.record.index.edit.show'];
const reqE = (field, effect, events, condition = '') => ({ requirementId: 'C1', requirementIds: ['C1'], field, effect, events, condition });
/** 生成工程の requiredEffects の 1 件（§0d.1 の形: check・checkReason・events[{ event, status }]） */
const gwE = (field, effect, check, evs, o = {}) => ({ requirementIds: ['C1'], field, effect, status: o.status || 'present', ...(check ? { check } : {}), ...(o.checkReason ? { checkReason: o.checkReason } : {}), events: evs.map(e => (typeof e === 'string' ? { event: e, status: 'present' } : e)) });
/** 隔離環境が無い（binding 無し）ときの代表条件（すべて not-run・unavailable） */
const casesNR = (rows, reason = 'unavailable', verdict = 'not-run') => rows.flatMap(([field, effect, events, cond]) => events.flatMap(ev => (cond ? ['match', 'nomatch'] : ['match']).map(side => ({ id: `${field}-${effect}-${ev}-${side}`, requirementIds: ['C1'], field, effect, expect: side === 'match' ? EXPECT_OF[effect] : NOMATCH_OF[effect], event: ev, side, kind: side, platform: 'desktop', verdict, ...(verdict === 'not-run' ? { reason } : {}), message: verdict === 'pass' ? '期待どおり' : verdict === 'fail' ? `${field} は期待した動きになりませんでした` : '隔離環境で実行できませんでした' }))));
const verE = (re, cases, status = 'not-run', reason = 'unavailable', extra = {}) => KTAiClient.normalizeVerification({ version: '1', candidateHash: '0123456789abcdef', passed: true, machine: [], requiredEffects: re, behavior: { status, reason, cases }, repairs: { count: 0, reasons: [], stoppedBy: null }, unverified: ['実機での動作（生成工程の記録）'], ...extra });
const GEN_EFFECT_CHECK = [...GEN_EFFECT_FEATURES, 'effectCheck'];

// E1: 入口と効果ごとの判定（純関数）
await section(async () => {
  const raw = { version: '1', candidateHash: '0123456789abcdef', passed: true, machine: [], requiredEffects: [
    { requirementIds: ['C1'], field: 'amount', effect: 'lock', status: 'present', check: 'machine', checkReason: [], events: [{ event: EV_SH[0], status: 'present' }, { event: EV_SH[1], status: 'present' }] },
    { requirementIds: ['C1'], field: 'memo', effect: 'warn', status: 'present', check: 'behavior', checkReason: ['warn', 'condition'], events: [{ event: EV_SH[0], status: 'present' }, { foo: 1 }, 'x'] },
    { requirementIds: ['C1'], field: 'customer', effect: 'set-value', status: 'present', check: 'auto' },
  ], behavior: { status: 'not-run', reason: 'unavailable', cases: [] } };
  const n = KTAiClient.normalizeVerification(raw);
  const [a, b, c] = n.requiredEffects;
  assert(a.check === 'machine' && a.events.length === 2 && a.events.every(e => e.status === 'present') && !('checkReason' in a) && b.check === 'behavior' && JSON.stringify(b.checkReason) === '["warn","condition"]' && b.events.length === 1 && !('check' in c) && !('events' in c),
    `E1-1: 入口（normalizeVerification）は check・checkReason・events を落とさない（語彙外の check は持たない・形の違う events の要素は落とす）: ${JSON.stringify(n.requiredEffects)}`);
  //   生成工程の形（checkReason は先頭の理由の文字列・checkReasons はすべて・events の status に other-platform / not-on-create）も落とさない
  const n2 = KTAiClient.normalizeVerification({ version: '1', requiredEffects: [{ requirementIds: ['C1'], field: 'amount', effect: 'lock', status: 'present', check: 'behavior', checkReason: 'conditional', checkReasons: ['conditional', 'nested'], events: [{ event: EV_SH[0], status: 'present' }, { event: 'mobile.app.record.edit.show', status: 'other-platform' }, { event: 'app.record.create.show', status: 'not-on-create' }, { event: 'x', status: 'odd' }] }] });
  const a2 = n2.requiredEffects[0];
  assert(JSON.stringify(a2.checkReason) === '["conditional","nested"]' && JSON.stringify(a2.events.map(e => e.status)) === '["present","other-platform","not-on-create","missing"]',
    `E1-1b: checkReason（文字列）と checkReasons（配列）をまとめ、events の status は生成工程の語のまま（語彙外は missing。present に読み替えない）: ${JSON.stringify(a2)}`);
  // S1: 条件の無い lock（編集・一覧の編集）。隔離環境なし（not-run・unavailable）
  const REQ_S1 = [reqE('amount', 'lock', EV_SH)];
  const V_S1 = verE([gwE('amount', 'lock', 'machine', EV_SH)], casesNR([['amount', 'lock', EV_SH, false]]));
  const on = KTCodeReview.effectResults(V_S1, REQ_S1, { effectCheck: true });
  const off = KTCodeReview.effectResults(V_S1, REQ_S1, {});
  assert(on.ok === true && on.items[0].behavior === 'pass' && on.items[0].checkedBy === 'machine' && on.machineChecked.length === 1 && off.ok === false && off.items[0].behavior === 'not-run' && off.notRun.length === 1,
    `E1-2（S1）: check: machine・イベントごとに present・Toolkit の condition が空 → 模擬テストが not-run でも合格（印 effectCheck が無ければ今の厳しい判定のまま）: ${JSON.stringify({ on: [on.ok, on.items[0].behavior, on.items[0].checkedBy], off: [off.ok, off.items[0].behavior] })}`);
  // S1b: 一覧の編集で処理が無い（イベントごとの missing）・イベントが返らない → 合格にしない（check が machine と返っても）
  const V_S1b = verE([gwE('amount', 'lock', 'machine', [EV_SH[0], { event: EV_SH[1], status: 'missing' }])], casesNR([['amount', 'lock', EV_SH, false]]));
  const V_S1c = verE([gwE('amount', 'lock', 'machine', [EV_SH[0]])], casesNR([['amount', 'lock', EV_SH, false]]));
  const V_S1d = verE([{ requirementIds: ['C1'], field: 'amount', effect: 'lock', status: 'present', check: 'machine' }], casesNR([['amount', 'lock', EV_SH, false]]));
  const rb = KTCodeReview.effectResults(V_S1b, REQ_S1, { effectCheck: true }), rc = KTCodeReview.effectResults(V_S1c, REQ_S1, { effectCheck: true }), rd = KTCodeReview.effectResults(V_S1d, REQ_S1, { effectCheck: true });
  assert(!rb.ok && !rc.ok && !rd.ok && [rb, rc, rd].every(r => r.items[0].behavior === 'not-run' && !r.items[0].checkedBy),
    `E1-3（S1b）: 効果のイベントのどれかに missing がある・present が無い・events が返らない → 機械検査で足りるとは数えない: ${JSON.stringify([rb.ok, rc.ok, rd.ok])}`);
  // S2: Toolkit が固定した condition がある → 生成工程が machine と返しても合格にしない（構造の照合）
  const REQ_S2 = [reqE('amount', 'lock', EV_SH, 'ステータス in ("承認待ち")')];
  const r2 = KTCodeReview.effectResults(verE([gwE('amount', 'lock', 'machine', EV_SH)], casesNR([['amount', 'lock', EV_SH, true]])), REQ_S2, { effectCheck: true });
  assert(!r2.ok && r2.items[0].behavior === 'not-run' && !r2.items[0].checkedBy, `E1-4（S2）: 条件つきの効果は、生成工程の check が machine でも模擬テストの合格が要る: ${JSON.stringify([r2.ok, r2.items[0].behavior])}`);
  // S7: check: behavior（同じイベントの error と編集不可）→ 合格にしない。理由の語は効果に写す
  const REQ_S7 = [reqE('amount', 'lock', [EV_SH[0]]), reqE('memo', 'warn', [EV_SH[0]])];
  const r7 = KTCodeReview.effectResults(verE([gwE('amount', 'lock', 'behavior', [EV_SH[0]], { checkReason: ['candidate-error-same-event'] }), gwE('memo', 'warn', 'behavior', [EV_SH[0]], { checkReason: ['warn'] })], casesNR([['amount', 'lock', [EV_SH[0]], false], ['memo', 'warn', [EV_SH[0]], false]])), REQ_S7, { effectCheck: true });
  assert(!r7.ok && r7.notRun.length === 2 && r7.items.every(i => i.check === 'behavior') && JSON.stringify(r7.items[0].checkReason) === '["candidate-error-same-event"]',
    `E1-5（S7）: check: behavior の効果は模擬テストの合格が要る（理由の語を効果に写す）: ${JSON.stringify(r7.items.map(i => [i.field, i.check, i.checkReason, i.behavior]))}`);
  // 隔離環境が使えて fail → 不合格（machine の効果でも）
  const rf = KTCodeReview.effectResults(verE([gwE('amount', 'lock', 'machine', EV_SH)], casesNR([['amount', 'lock', EV_SH, false]], null, 'fail'), 'failed', null), REQ_S1, { effectCheck: true });
  assert(!rf.ok && rf.failed.length === 1 && rf.items[0].behavior === 'fail', `E1-6: check: machine の効果も、模擬テストが動いて不合格なら不合格: ${JSON.stringify([rf.ok, rf.items[0].behavior])}`);
  // 二重の安全: 渡せなかった既存 JS・入口で切った・照合できない代表条件の未確認・既存 JS の理由は、machine でも合格にしない
  const ro = KTCodeReview.effectResults(V_S1, REQ_S1, { effectCheck: true, omitted: [{ name: 'biz.js', target: 'desktop', reason: 'url', events: null }] });
  const big = { ...V_S1, behavior: { ...V_S1.behavior, truncated: true } };
  const rt = KTCodeReview.effectResults(big, REQ_S1, { effectCheck: true });
  const stray = verE([gwE('amount', 'lock', 'machine', EV_SH)], [...casesNR([['amount', 'lock', EV_SH, false]]), ...casesNR([['owner', 'warn', [EV_SH[0]], false]])]);
  const rs = KTCodeReview.effectResults(stray, REQ_S1, { effectCheck: true });
  const rx = KTCodeReview.effectResults(verE([gwE('amount', 'lock', 'machine', EV_SH)], casesNR([['amount', 'lock', EV_SH, false]], 'existing-unverifiable')), REQ_S1, { effectCheck: true });
  assert(!ro.ok && ro.items[0].notRunReasons.includes('related-file-omitted') && !rt.ok && !rs.ok && !rx.ok && rx.items[0].notRunReasons.includes('existing-unverifiable'),
    `E1-7: 渡せなかった既存 JS・入口で切った結果・照合できない代表条件の未確認・既存 JS の理由（existing-unverifiable）は machine でも合格にしない: ${JSON.stringify([ro.ok, rt.ok, rs.ok, rx.ok])}`);
  // 混在: lock は machine・warn は behavior（模擬テストなし）→ 全体は合格にしない。未確認は warn だけ
  const rm = KTCodeReview.effectResults(verE([gwE('amount', 'lock', 'machine', [EV_SH[0]]), gwE('memo', 'warn', 'behavior', [EV_SH[0]], { checkReason: ['warn'] })], casesNR([['amount', 'lock', [EV_SH[0]], false], ['memo', 'warn', [EV_SH[0]], false]])), [reqE('amount', 'lock', [EV_SH[0]]), reqE('memo', 'warn', [EV_SH[0]])], { effectCheck: true });
  assert(!rm.ok && rm.notRun.length === 1 && rm.notRun[0].field === 'memo' && rm.items.find(i => i.field === 'amount').checkedBy === 'machine', `E1-8: machine と behavior の混在では、behavior の効果の未確認が残る（全体は合格にしない）: ${JSON.stringify(rm.items.map(i => [i.field, i.behavior, i.checkedBy]))}`);
  // attachBehavior の表示の文: 機械検査で確認（模擬テストは未実施）。模擬テストで確かめたとは書かない
  const rv0 = { checks: [{ name: 'syntax', ok: true, severity: 'info', message: '構文エラーなし' }], status: 'OK', finalCode: 'x', registration: { platform: ['desktop'] } };
  const att = KTCodeReview.attachBehavior(rv0, V_S1, { requiredEffects: REQ_S1, customization: { platform: ['desktop'] }, effectCheck: true });
  const bh = att.checks.find(ch => ch.name === 'behavior');
  const reg = att.registration.unverified.find(u => u.code === 'BEHAVIOR_VERIFIED');
  assert(att.status === 'OK' && bh && /機械検査で確認しました（模擬テストは未実施）/.test(bh.message) && !/模擬テストで必須の動作を確かめました/.test(bh.message) && reg && /機械検査で確認しました（模擬テストは未実施）/.test(reg.message) && /実機（動作テスト環境）では未確認/.test(reg.message),
    `E1-9: 取り込みの文は「機械検査で確認（模擬テストは未実施）」（模擬テストで確かめたとは書かない・実機は未確認）: ${JSON.stringify({ st: att.status, bh: bh && bh.message, reg: reg && reg.message })}`);
  const attOff = KTCodeReview.attachBehavior(rv0, V_S1, { requiredEffects: REQ_S1, customization: { platform: ['desktop'] } });
  assert(attOff.status === 'BLOCKED' && attOff.checks.some(ch => ch.name === 'behavior-not-run' && ch.environment), `E1-10: 印 effectCheck の無い接続先では、今の厳しい判定のまま（behavior-not-run で登録不可）: ${attOff.status}`);
});

/** 偽の生成工程（§0d.1 の形の verification を返す）。verOf(requiredEffects) で requiredEffects と behavior を作る */
function makeGenE(code, verOf, { targetFile = 'c1.js' } = {}) {
  const calls = [];
  const impl = async (args) => {
    calls.push({ requiredEffects: clone(args.requiredEffects || null), feedback: args.feedback || null });
    const c = (args.version.plan.customizations || []).find(x => x.customizationId === args.customizationId);
    const generated = { strategy: 'NEW_JS_FILE', targetFile, summary: c.requirement, code, patch: null, events: c.events, fields: c.fields.filter(f => f.access !== 'READ').map(f => ({ code: f.code, access: f.access })), apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '', text: c.requirement }] };
    const review = KTCodeReview.review({ generated, customization: c, plan: args.version.plan, data: clone(DATA_C), scan: null, existingSource: null });
    const candidateHash = gwCandidateHash({ strategy: 'NEW_JS_FILE', targetFile, code, patch: null, customizationId: 'C1' });
    const raw = verOf(args.requiredEffects || []);
    const verification = KTAiClient.normalizeVerification({ version: '1', passed: true, machine: [{ name: 'syntax', ok: true, severity: 'info', message: '構文エラーなし' }], repairs: { count: 0, reasons: [], stoppedBy: null }, unverified: ['既存の JavaScript との実行順と相互作用は実機で確かめてください'], ...raw, candidateHash });
    return { ok: true, generated, review, ctx: { size: { approxTokens: 1000 } }, existingSource: null, inputHash: `h${calls.length}`, verification, candidateHash, requirementIds: [{ id: 'C1', kind: 'customization', text: c.requirement }] };
  };
  return { impl, calls };
}
const custE = (fields, events, requirement = '金額を編集できないようにする') => ({ ...custOf(null), requirement, events, fields });
const lockAll = (evs) => `(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(evs)}, function (event) {\n    const record = event.record;\n    record['amount'].disabled = true;\n    return event;\n  });\n})();`;
// E2: 会話（仮案 → 採用 → 計画 → 生成工程 → 最終案）。隔離環境が無い（not-run・unavailable）
await section(async () => {
  const CUST_S1 = custE([{ code: 'amount', access: 'CONTROL', condition: '', effects: [{ effect: 'lock', condition: '', events: [] }] }], EV_SH);
  const verS1 = (req) => ({ requiredEffects: req.map(r => gwE(r.field, r.effect, 'machine', r.events)), behavior: { status: 'not-run', reason: 'unavailable', cases: casesNR(req.map(r => [r.field, r.effect, r.events, !!r.condition])) } });
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_S1, summary: '金額を編集できないようにします。' }), generate: makeGenE(lockAll(EV_SH), verS1), supported: GEN_EFFECT_CHECK });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  const html = finalHtml(x), text = stripC(rightOf(x));
  assert(e && e.status === 'verified' && v.final.approvable === true && x.gen.calls.length === 1 && e.review.effects.machineChecked.length === 1 && JSON.stringify(x.gen.calls[0].requiredEffects.map(r => [r.field, r.effect, r.events, r.condition])) === JSON.stringify([['amount', 'lock', EV_SH, '']]),
    `E2-1（sc-gate S1）: 条件の無い lock は、隔離環境なしでも機械検査で足りる（承認できる）: ${JSON.stringify({ status: e && e.status, verdict: e && e.verdict, reason: v.final.blockingReason })}`);
  assert(/✓ 「金額」（PC）: 編集できない — 処理あり・機械検査で確認（模擬テストは未実施）/.test(text) && /機械検査で確認した必須の動作は、模擬テストの結果を待たずに反映できる扱いにしています/.test(text) && !/模擬テストで合格/.test(text) && !/動作確認済|実機確認済/.test(text),
    `E2-2: 最終案のカードは「機械検査で確認（模擬テストは未実施）」と出す（模擬テストの合格・動作確認済みとは書かない）: ${(text.match(/必須の動作[\s\S]{0,300}/) || [''])[0]}`);
  const ap = x.c.approveFinal({ planId: v.planId, version: v.version });
  assert(ap.ok === true && v.approval && v.approval.candidates && Object.values(v.approval.candidates).includes(e.candidateHash), `E2-3: 承認は生成工程が検証した候補（candidateHash）に結び付く: ${JSON.stringify({ ap, cands: v.approval && v.approval.candidates })}`);
  // 印 effectCheck の無い接続先では、今の厳しい判定のまま（承認できない・理由は環境）
  const y = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_S1, summary: '金額を編集できないようにします。' }), generate: makeGenE(lockAll(EV_SH), verS1) });
  await adoptC(y);
  const vy = y.c.activePlan(), ey = vy.generated.C1;
  assert(ey && ey.status === 'not-run' && vy.final.approvable === false && y.gen.calls.length === 1, `E2-4: health の印に effectCheck が無い接続先では、machine の効果も模擬テストの合格が要る（今の厳しい判定）: ${JSON.stringify({ status: ey && ey.status, reason: vy.final.blockingReason })}`);
  // S1b: 一覧の編集で処理が無い（生成工程のイベントごとの missing）→ 承認できない
  const verS1b = (req) => ({ requiredEffects: req.map(r => gwE(r.field, r.effect, 'machine', [r.events[0], ...r.events.slice(1).map(ev => ({ event: ev, status: 'missing' }))])), behavior: { status: 'not-run', reason: 'unavailable', cases: casesNR(req.map(r => [r.field, r.effect, r.events, false])) } });
  //   sc-gate の S1b と同じ候補（一覧の編集の handler は登録するが、編集不可にしない）。Toolkit の形式確認では止まらず、生成工程のイベントごとの missing で止まる
  const S1B_CODE = ["(function () {", "  'use strict';", "  kintone.events.on('app.record.edit.show', function (event) {", "    event.record['amount'].disabled = true;", "    return event;", "  });", "  kintone.events.on('app.record.index.edit.show', function (event) {", "    return event;", "  });", '})();'].join('\n');
  const z = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_S1, summary: '金額を編集できないようにします。' }), generate: makeGenE(S1B_CODE, verS1b), supported: GEN_EFFECT_CHECK });
  await adoptC(z);
  const vz = z.c.activePlan();
  assert(vz.final.approvable === false && vz.generated.C1.status === 'not-run' && !vz.generated.C1.review.effects.machineChecked.length, `E2-5（sc-gate S1b）: 効果のイベントの一部に処理が無い候補は、隔離環境なしで承認できない: ${JSON.stringify({ status: vz.generated.C1.status, reason: vz.final.blockingReason })}`);
});
// E3: 準備未完了の理由（模擬テストが要る効果を、模擬テストの環境が使えないために確かめられない）
await section(async () => {
  // S2: 条件つき lock（生成工程は check: behavior・checkReason condition）
  const CUST_S2 = custE([{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: [{ effect: 'lock', condition: '', events: [] }] }], EV_SH, '承認待ちでは金額を編集できないようにする');
  const verB = (reasons) => (req) => ({ requiredEffects: req.map(r => gwE(r.field, r.effect, 'behavior', r.events, { checkReason: reasons[r.effect] || ['condition'] })), behavior: { status: 'not-run', reason: 'unavailable', cases: casesNR(req.map(r => [r.field, r.effect, r.events, !!r.condition])) } });
  const CODE_S2 = `(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(EV_SH)}, function (event) {\n    const record = event.record;\n    if (${ST_C}) record['amount'].disabled = true;\n    return event;\n  });\n})();`;
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_S2 }), generate: makeGenE(CODE_S2, verB({ lock: ['conditional'] })), supported: GEN_EFFECT_CHECK });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  assert(e.status === 'not-run' && v.final.approvable === false && /この効果は模擬テストで確かめる必要があります（条件つき）/.test(e.verdict.reason) && /模擬テストの環境が使えないため、まだ反映できません/.test(e.verdict.reason) && /対象: 「金額」: 編集できない/.test(e.verdict.reason) && /この効果は模擬テストで確かめる必要があります（条件つき）/.test(v.final.blockingReason) && x.gen.calls.length === 1 && !x.gen.calls[0].feedback,
    `E3-1（sc-gate S2）: 条件つきの効果は模擬テストが要る → 隔離環境なしでは承認できない。理由は checkReason から 1 つにまとめ、修復は依頼しない: ${JSON.stringify({ reason: e.verdict.reason, final: v.final.blockingReason })}`);
  // S7: 同じ表示のイベントで lock と error（既知の競合）。生成工程の checkReason と Toolkit の形式確認の既知の競合から理由を出す（「環境の制約」とだけ言わない）
  const CUST_S7 = custE([{ code: 'amount', access: 'CONTROL', condition: '', effects: [{ effect: 'lock', condition: '', events: [] }] }, { code: 'memo', access: 'CONTROL', condition: '', effects: [{ effect: 'warn', condition: '', events: [] }] }], ['app.record.edit.show'], '金額を編集不可にし、備考に警告を出す');
  const CODE_S7 = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    record['amount'].disabled = true;\n    record['memo'].error = '確認してください';\n    return event;\n  });\n})();";
  const y = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_S7, summary: '金額を編集不可にし、備考に警告を出します。' }), generate: makeGenE(CODE_S7, verB({ lock: ['candidate-error-same-event'], warn: ['effect-kind'] })), supported: GEN_EFFECT_CHECK });
  await adoptC(y);
  const vy = y.c.activePlan(), ey = vy.generated.C1;
  const envReasons = vy.final.readiness.reasons.filter(r => r.kind === 'environment');
  assert(ey.status === 'not-run' && vy.final.approvable === false && /同じ表示のイベントで error と編集不可の両方を設定している/.test(ey.verdict.reason) && /警告/.test(ey.verdict.reason) && /模擬テストの環境が使えないため、まだ反映できません/.test(vy.final.blockingReason) && !/環境の制約です/.test(vy.final.blockingReason) && envReasons.length === 1 && y.gen.calls.length === 1,
    `E3-2（sc-gate S7）: 同じイベントの error と編集不可は「環境の制約」とだけ出さず、模擬テストが要る理由を一度にまとめて出す（承認できない）: ${JSON.stringify({ reason: ey.verdict.reason, final: vy.final.blockingReason, env: envReasons.length })}`);
  const html = finalHtml(y);
  assert(/disabled>動作テスト環境へ反映/.test(html) && /この効果は模擬テストで確かめる必要があります/.test(stripC(html)), 'E3-3: 最終案のカードの理由にも同じ文を出し、［この内容で反映する］は押せない');
});
// E4: 検証の後の書き換えをやめる（§0d.3）。画面の generate（偽 client）で、生成工程が返したコードと candidateHash のまま最終案・承認・登録の準備まで進む
await section(async () => {
  const HEALTH_E = clone(HEALTH);
  HEALTH_E.registry.toolkit['customization-generator'].verification = ['requirementId', 'feedback', ...GEN_EFFECT_CHECK];
  const CUST_K = { customizationId: 'C1', requirement: '承認待ちでは案件名を編集できないようにする', whyStandardInsufficient: 'ステータスで切り替えるアクセス権は無い', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'case_name', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock'] }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [] };
  const planResp = (goal) => { const b = PLAN_V1(goal); return { ...b, plan: { ...b.plan, solution: 'CUSTOMIZATION', assessment: { ...b.plan.assessment, summary: '承認待ちでは案件名を編集できないようにします。' }, steps: [mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { title: 'JavaScript', solution: 'CUSTOMIZATION' })], customizations: [CUST_K] } }; };
  const CODE_K = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認待ち') record['case_name'].disabled = true;\n    return event;\n  });\n})();";
  const run = async (code) => {
    const sent = [];
    const loadDevBase = async () => { const FXF = require('./fixtures/ai-context-app.js').files; const g = makeEnvGetter({ preview: clone(INPUTS.data), production: clone(INPUTS.data), files: { '20261001000000AAAA': FXF[0].text, '20261001000000BBBB': FXF[1].text, '20261001000000DDDD': FXF[2].text } }); return T.KTDevBase.load({ appId: '341', getImpl: g.getImpl, download: g.download, now: () => new Date('2026-10-08T00:00:00Z') }); };
    const generateImpl = async ({ ctx, requestId }) => {
      const req = (ctx.verification && ctx.verification.requiredEffects) || [];
      const candidateHash = gwCandidateHash({ strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', code, customizationId: 'C1' });
      sent.push({ code, candidateHash, appFields: ctx.verification && ctx.verification.appFields });
      const resp = { ok: true, contractVersion: '2.1', meta: { requestId, gateway: { product: 'toolkit', feature: 'customization-generator', promptVersion: '1', contextVersion: 'customization-1' }, normalization: { warnings: [] }, ai: { model: 'm' } }, generated: { strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', summary: '承認待ちでは案件名を編集できないようにします。', code, patch: null, events: ['app.record.edit.show'], fields: [{ code: 'case_name', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '' }] }, verification: fakeVerification({ code, has: { case_name: ['lock'] } }, req, { candidateHash }) };
      const v = KTAiClient.validateGenerated(resp, ctx);
      if (!v.ok) throw new Error(JSON.stringify(v.errors));
      return { ...v.normalized, requestId };
    };
    const m = mount({ health: HEALTH_E, planImpl: ({ ctx, requestId }) => { const v = KTAiClient.validatePlan(planResp(ctx.goal), ctx); if (!v.ok) throw new Error(JSON.stringify(v.errors)); return { ...v.normalized, requestId, clientWarnings: v.warnings }; }, generateImpl, extra: { loadDevBase } });
    await ticks();
    for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) { await m.panel.send(s); await ticks(8); }
    await m.panel.send('おすすめで。この案で進めて'); await ticks(20);
    return { m, sent };
  };
  const { m, sent } = await run(CODE_K);
  const v = m.conv().activePlan(), e = v && v.generated && v.generated.C1;
  //   簡素化 B（2026-10-17）: Toolkit が受け取った候補から Gateway と同じ計算で作った指紋（会話の照合と同じ関数）
  const localHash = e ? await KTScan.gatewayCandidateHashOf({ strategy: e.generated.strategy, targetFile: e.generated.targetFile, code: e.generated.code, patch: e.generated.patch, baseHash: null, customizationId: 'C1' }) : null;
  assert(e && e.status === 'verified' && e.generated.code === CODE_K && !e.generated.toolkitModernJs && e.candidateHash === sent[0].candidateHash && e.verification.candidateHash === sent[0].candidateHash && localHash === sent[0].candidateHash && v.final.approvable === true,
    `E4-1: 生成工程が検証したコード・candidateHash のまま最終案になる（Toolkit は書き換えない）: ${JSON.stringify({ status: e && e.status, same: e && e.generated.code === CODE_K, hash: [e && e.candidateHash, sent[0] && sent[0].candidateHash, localHash] })}`);
  const rE = await KIT.applyOnScreen(m);   // §0e.1: ［動作テスト環境へ反映］1 回で承認と登録
  const pr = m.panel.jsExecState().prepared;
  const chg = pr && Array.isArray(pr.changes) ? pr.changes : [];
  assert(pr && pr.status === 'PREPARED' && chg.length === 1 && chg[0].contentHash === KTScan.hashText(CODE_K) && v.approval && Object.values(v.approval.candidates || {}).includes(sent[0].candidateHash),
    `E4-2: 承認と登録の準備も同じ候補（登録する本文の指紋 = 生成工程が検証したコードの指紋）: ${JSON.stringify({ status: pr && pr.status, n: chg.length, h: chg[0] && chg[0].contentHash, want: KTScan.hashText(CODE_K) })}`);
  const up = [...m.mock.st.files.values()].find(f => f.name === 'caseLock.js');
  const chat = stripC(m.chat());
  assert(up && up.content === CODE_K && rE.run.ok && /動作テスト環境へ反映しました。/.test(rE.card) && /JavaScript: ＋ caseLock\.js（PC） を登録/.test(rE.card) && /実機（動作テスト環境）での動作はまだ確かめていません。/.test(chat) && /確かめ方:/.test(chat) && /動作テスト環境で、条件に合うレコードと合わないレコードを開いて/.test(chat),
    `E4-3（E8 の (c) を兼ねる）: 登録した本文は検証したコードそのまま・登録の結果のカードに実機（動作テスト環境）が未確認であることと確かめ方: ${JSON.stringify({ up: !!up, same: up && up.content === CODE_K, tail: chat.slice(-500) })}`);
  // var を含むコード（記法の修正を通っていない）: 書き換えず、生成工程の機械検査（modern-js）の block で止める（候補は生成工程の候補のまま）。
  //   簡素化 B（2026-10-16）: Toolkit の写しの「反映直前の形式確認（記法）」は削除した（Toolkit は記法を確かめない）
  const VAR_K = CODE_K.replace('const record = event.record;', 'var record = event.record;');
  const r2 = await run(VAR_K);
  const v2 = r2.m.conv().activePlan(), e2 = v2 && v2.generated && v2.generated.C1;
  const mj = e2 && e2.verification && (e2.verification.machine || []).find(ch => ch.name === 'modern-js' && !ch.ok);
  assert(e2 && e2.generated.code === VAR_K && e2.candidateHash === r2.sent[0].candidateHash && e2.status === 'unresolved' && e2.verdict.kind === 'machine' && mj && mj.severity === 'block' && !e2.review.checks.some(ch => ch.name === 'modern-js' && !ch.gateway) && e2.review.checks.some(ch => ch.name === 'modern-js' && ch.gateway && ch.severity === 'block') && v2.final.approvable === false,
    `E4-4: var を含む候補は書き換えず（candidateHash も生成工程のまま）、生成工程の機械検査の block で止める: ${JSON.stringify({ status: e2 && e2.status, same: e2 && e2.generated.code === VAR_K, mj: mj && mj.message })}`);
  //   簡素化 B（2026-10-17）: 登録の直前にも、登録する候補の指紋を Gateway と同じ計算で作り直して、生成工程の検証結果・承認の指紋に照らす。
  //   承認の欄の準備の前に候補だけが変わった（検証結果と承認の指紋はそのまま）→ 承認・登録の準備で止まり、動作テスト環境に書き込まない
  const r5 = await run(CODE_K);
  const v5 = r5.m.conv().activePlan(), e5 = v5 && v5.generated && v5.generated.C1;
  const rE5 = await KIT.applyOnScreen(r5.m, { before: async () => { e5.generated = { ...e5.generated, code: `${CODE_K}\n// 検証の後に変わった行` }; } });
  const pr5 = r5.m.panel.jsExecState().prepared, pre5 = r5.m.panel.finalPrecheck();
  const mism5 = JSON.stringify([pr5 && pr5.blockers, pre5, rE5.run && rE5.run.error]).includes('VERIFICATION_MISMATCH') || JSON.stringify([pr5, pre5]).includes('生成工程が検証した候補と、登録しようとしている候補が一致しません');
  assert(e5 && e5.verification && e5.verification.bound === true && mism5 && ![...r5.m.mock.st.files.values()].some(f => f.name === 'caseLock.js') && !rE5.writes.some(w => /putPreviewCustomize|uploadFile/.test(String(w && (w.op || w.kind || w)))),
    `E4-5: 検証の後に候補が変わったら、登録の直前の照合（VERIFICATION_MISMATCH）で止め、書き込まない: ${JSON.stringify({ blockers: pr5 && pr5.blockers, pre: pre5 && { status: pre5.status, reasons: pre5.reasons }, writes: rE5.writes })}`);
  // E6: appFields の required（アプリの設定で必須の項目）
  const af = sent[0].appFields || [];
  const reqCodes = Object.values(INPUTS.data.fields).filter(f => f && f.required === true).map(f => f.code);
  assert(af.length > 0 && reqCodes.length > 0 && reqCodes.every(c => af.some(f => f.code === c && f.required === true)) && af.filter(f => f.required === true).every(f => reqCodes.includes(f.code)),
    `E6-1: Generator Context の appFields に、アプリの設定で必須の項目だけ required: true を付ける: ${JSON.stringify({ req: reqCodes, sent: af.filter(f => f.required).map(f => f.code) })}`);
});
// E5: 既知の配布元（§0d.3）: jsDelivr・unpkg は null（その platform の必須の効果を確かめていないものとして止める）
await section(async () => {
  assert(['https://cdn.jsdelivr.net/npm/@acme/kintone-biz@1.0.0/biz.js', 'https://unpkg.com/@acme/kintone-biz@1.0.0/biz.js', 'https://cdnjs.cloudflare.com/other/biz.js'].every(u => !KTScan.isKnownLibraryUrl(u)) && ['https://js.cybozu.com/luxon/3.4.4/luxon.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/dayjs/1.11.10/dayjs.min.js', 'https://code.jquery.com/jquery-3.7.1.min.js', 'https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js'].every(u => KTScan.isKnownLibraryUrl(u)),
    'E5-1: [] にするのは js.cybozu.com・cdnjs の /ajax/libs/・code.jquery.com・Google の /ajax/libs/ だけ（jsDelivr・unpkg・cdnjs の別のパスは null）');
  const data = { customize: { desktop: { js: [{ type: 'URL', url: 'https://cdn.jsdelivr.net/npm/@acme/kintone-biz@1.0.0/biz.js' }, { type: 'URL', url: 'https://js.cybozu.com/luxon/3.4.4/luxon.min.js' }] }, mobile: { js: [] } } };
  const files = KTScan.summarizeFiles({ files: [] }, data);
  const sel = KTContext.relatedFilesFor(files, { targets: ['desktop'], requiredEffects: [reqE('amount', 'lock', EV_SH)] });
  const npm = sel.relatedOmitted.find(f => /jsdelivr/.test(f.url || '')), lux = sel.relatedOmitted.find(f => /luxon/.test(f.url || ''));
  const V = verE([gwE('amount', 'lock', 'machine', EV_SH)], casesNR([['amount', 'lock', EV_SH, false]]));
  const er = KTCodeReview.effectResults(V, [reqE('amount', 'lock', EV_SH)], { effectCheck: true, omitted: sel.relatedOmitted });
  assert(npm && npm.events === null && lux && Array.isArray(lux.events) && lux.events.length === 0 && !er.ok && er.items[0].notRunReasons.includes('related-file-omitted') && er.omittedHit.some(f => /jsdelivr/.test(f.url || '')),
    `E5-2: npm で配布された業務の JS（jsDelivr）は events null で、machine の効果でも合格にしない（related-file-omitted）: ${JSON.stringify({ npm, lux, ok: er.ok })}`);
});
// E6（純関数）: appFields の required（計画で新設する項目は proposedFields の required）
await section(async () => {
  const data = clone(DATA_C);
  data.fields.memo = { ...data.fields.memo, required: true };
  const plan = { customizations: [CUST_C1], proposedFields: [{ temporaryId: 'NEW_FIELD_1', suggestedCode: 'approver', label: '承認者', type: 'USER_SELECT', required: true }], steps: [{ id: 'P1', actionType: 'ADD_FIELD', targetKind: 'FIELD', targetRef: 'NEW_FIELD_1', title: '承認者を追加', spec: {} }] };
  const ctx = KTContext.buildGenerator({ customization: CUST_C1, plan, planId: 'p', version: 1, data, verification: { requirementIds: [], requiredEffects: REQ_LOCK, relatedFiles: [], relatedOmitted: [] } });
  const af = ctx.verification.appFields;
  const memo = af.find(f => f.code === 'memo'), amount = af.find(f => f.code === 'amount'), appr = af.find(f => f.code === 'approver');
  assert(memo && memo.required === true && amount && !('required' in amount) && appr && appr.planned === true && appr.required === true, `E6-2: 必須の項目だけ required: true（必須でない項目には付けない・新設は計画の required）: ${JSON.stringify({ memo, amount, appr })}`);
});
// E7: 保存禁止を event.error で実装した正しい候補（sc-gate の S4）を止めない
//   簡素化 B（2026-10-17）: 計画で制御するフィールドがコードに現れるかの判定（Toolkit の planned-fields）は削除した。処理の有無は生成工程の必須の効果が決める
await section(async () => {
  const CUST_S4 = custE([{ code: 'memo', access: 'CONTROL', condition: '', effects: [{ effect: 'block-save', condition: '', events: [] }] }], ['app.record.edit.submit'], '編集画面の保存を止める');
  const CODE_S4 = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.submit'], function (event) {\n    event.error = '保存できません';\n    return event;\n  });\n})();";
  const verS4 = (ok) => (req) => ({ requiredEffects: req.map(r => gwE(r.field, r.effect, 'behavior', r.events, { checkReason: ['effect-kind'] })), behavior: ok ? { status: 'passed', reason: null, cases: casesNR(req.map(r => [r.field, r.effect, r.events, false]), null, 'pass') } : { status: 'not-run', reason: 'unavailable', cases: casesNR(req.map(r => [r.field, r.effect, r.events, false])) } });
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_S4, summary: '編集画面の保存を止めます。' }), generate: makeGenE(CODE_S4, verS4(true)), supported: GEN_EFFECT_CHECK });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  const raw = KTCodeReview.review({ generated: { strategy: 'NEW_JS_FILE', targetFile: 'c1.js', summary: '', code: CODE_S4, patch: null, events: CUST_S4.events, fields: [{ code: 'memo', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [] }, customization: CUST_S4, plan: v.plan, data: clone(DATA_C), scan: null, existingSource: null });
  assert(!raw.checks.some(ch => ch.name === 'planned-fields') && !e.review.checks.some(ch => ch.name === 'planned-fields') && e.status === 'verified' && v.final.approvable === true,
    `E7-1（sc-gate S4）: 保存のイベントの event.error で保存を止める正しい候補は、必須の効果が present なら承認できる（Toolkit は planned-fields を作らない）: ${JSON.stringify({ status: e.status, reason: v.final.blockingReason })}`);
  // 模擬テストの環境が無いとき: 「模擬テストが要る（保存を止める）」で準備未完了
  const y = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_S4, summary: '編集画面の保存を止めます。' }), generate: makeGenE(CODE_S4, verS4(false)), supported: GEN_EFFECT_CHECK });
  await adoptC(y);
  const vy = y.c.activePlan(), ey = vy.generated.C1;
  assert(vy.final.approvable === false && ey.status === 'not-run' && !ey.review.registration.blockers.some(b => b.code === 'planned-fields') && /この効果は模擬テストで確かめる必要があります（保存を止める）/.test(ey.verdict.reason),
    `E7-2: 隔離環境が無いときは、模擬テストが要る理由（保存を止める）で準備未完了: ${JSON.stringify({ status: ey.status, reason: ey.verdict.reason, blockers: ey.review.registration.blockers.map(b => b.code) })}`);
  // 生成工程の必須の効果が present でない → 生成工程の結果（missing）で止める
  const rvX = KTCodeReview.attachBehavior(raw, verE([gwE('memo', 'block-save', 'behavior', ['app.record.edit.submit'], { status: 'missing' })], casesNR([['memo', 'block-save', ['app.record.edit.submit'], false]], null, 'pass'), 'passed', null), { requiredEffects: [reqE('memo', 'block-save', ['app.record.edit.submit'])], customization: CUST_S4, effectCheck: true });
  assert(rvX.checks.some(ch => ch.name === 'required-effects' && !ch.ok && ch.severity === 'block') && !rvX.checks.some(ch => ch.name === 'planned-fields'), 'E7-3: 生成工程の必須の効果が present でなければ、その結果（missing）で止める');
});
// E8: 表示（sc-display の (a)(b)）: 最終案のカードに未確認の一覧を出す・生成工程の隔離環境は「模擬テスト」、kintone のプレビューは「動作テスト環境」
await section(async () => {
  const x = makeConvC();
  await adoptC(x);
  const v = x.c.activePlan();
  const html = rightOf(x), all = stripC(html), outside = stripC(outsideDetails(finalHtml(x)));
  assert(v.final.verification.unverified.length > 0 && /kt-ai-final-unverified/.test(html) && /まだ確かめていないこと（\d+ 件）/.test(all) && v.final.verification.unverified.every(u => all.includes(u)) && /実機での動作/.test(all) && !/まだ確かめていないこと/.test(outside),
    `E8-1（(a)。2026-10-14: 右の「変更内容」の検証の明細に）: 未確認の一覧（fin.verification.unverified）を出す: ${JSON.stringify(v.final.verification.unverified)}`);
  assert(/模擬テスト（代表条件 2 件）: 合格 2・不合格 0・実行できない 0/.test(all) && !/動作テスト（隔離環境/.test(all) && !/プレビュー環境/.test(all) && /動作テスト環境で確かめること/.test(all) && /反映は動作テスト環境から始まります/.test(all) && !/動作確認済|実機確認済/.test(all),
    `E8-2（(b)）: 生成工程の隔離環境は「模擬テスト」、kintone のプレビューは「動作テスト環境」（「プレビュー環境」を混ぜない）: ${(all.match(/検証の区分[\s\S]{0,500}/) || [''])[0]}`);
  //   本体の利用者に見える文に「動作テスト（隔離環境の模擬）」「プレビュー環境」が残っていない（コメントは除く）
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'kintoneAppToolkit.user.js'), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).map(l => l.replace(/\s\/\/\s.*$/, ''));
  const left = src.filter(l => /動作テスト（隔離環境|プレビュー環境/.test(l));
  assert(left.length === 0, `E8-3: 本体の文に「動作テスト（隔離環境の模擬）」「プレビュー環境」が残っていない: ${JSON.stringify(left.map(l => l.trim().slice(0, 120)))}`);
});
// E9（C-1 第 2 段・2026-10-08）: 本番の経路から呼ばれない処理の削除（設計 §0d.4）。
//   簡素化 B（2026-10-17）: 候補の hash は Gateway の candidateHashOf と同じ計算（KTScan.gatewayCandidateHashOf。SHA-256）にした（以前の KTScan.candidateHashOf は別の方式で、
//   Gateway の指紋と比べられなかった）。実機の記録（2026-10-15 の 1 会話の C1〜C3。統合を含む）の Gateway の指紋と一致し、改行の違いと操作の余分な項目を数えない
await section(async () => {
  const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  const H = KTScan.gatewayCandidateHashOf;
  const REC = require('./fixtures/nl1015b-final.js').GENERATED;
  const recRows = [];
  for (const [cid, e] of Object.entries(REC)) recRows.push([cid, await H({ strategy: e.generated.strategy, targetFile: e.generated.targetFile, code: e.generated.code, patch: e.generated.patch, baseHash: e.existingSource && typeof e.existingSource.text === 'string' ? KTScan.hashText(e.existingSource.text) : null, customizationId: cid }), e.verification.candidateHash]);
  assert(recRows.length === 3 && recRows.every(([, a, b]) => a && a === b) && KTScan.candidateHashOf === undefined, `E9-1: 候補の指紋は実機の記録の Gateway の指紋と一致する（統合の C1 を含む。別の方式の指紋は削除）: ${JSON.stringify(recRows)}`);
  const cases = [
    [{ strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', code: 'a' + CR + LF + 'b', customizationId: 'C1' }, { strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', code: 'a' + LF + 'b', customizationId: 'C1' }, '改行が CRLF と LF'],
    [{ strategy: 'EXTEND_EXISTING_JS', targetFile: 'old.js', code: '', patch: { baseHash: 'abcd1234', operations: [{ type: 'insertAfter', anchor: 'x' + CR + LF, content: 'y', extra: 1 }] }, baseHash: 'deadbeef', customizationId: 'C2' }, { strategy: 'EXTEND_EXISTING_JS', targetFile: 'old.js', code: '', patch: { baseHash: 'abcd1234', operations: [{ type: 'insertAfter', anchor: 'x' + LF, content: 'y' }] }, baseHash: 'deadbeef', customizationId: 'C2' }, '既存のファイルへの patch（操作の余分な項目は数えない）'],
  ];
  for (const [a, b, name] of cases) { const ha = await H(a), hb = await H(b); assert(!!ha && ha === hb && ha === gwCandidateHash(a), `E9-1: 候補の指紋は同じ候補で同じ値（${name}）・テストの部品の計算とも同じ: ${ha} / ${hb}`); }
  assert((await H({ strategy: 'NEW_JS_FILE', targetFile: 'a.js', code: 'x', customizationId: 'C1' })) !== (await H({ strategy: 'NEW_JS_FILE', targetFile: 'a.js', code: 'x', customizationId: 'C2' })) && (await H({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'a.js', code: 'x', baseHash: '1', customizationId: 'C1' })) !== (await H({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'a.js', code: 'x', baseHash: '2', customizationId: 'C1' })), 'E9-1: customizationId と送った既存ファイルの本文の指紋が違えば、違う指紋になる');
  // 消した処理が残っていない（試作のエージェント・模擬実行の本体・模擬の取り込み・試作の接続・修復の往復の残骸）
  assert(T.KTJsSim === undefined && T.KTAgent === undefined && T.KTAgentDomains === undefined && T.KTAgentUi === undefined, 'E9-2: KTJsSim・KTAgentDomains・KTAgent・KTAgentUi は本体に無い');
  assert(typeof KTCodeReview.attachSim === 'undefined' && typeof KTCodeReview.simRan === 'undefined' && typeof KTCodeReview.attachBehavior === 'function', 'E9-3: KTCodeReview.attachSim・simRan は無い（生成工程の検証結果の取り込み attachBehavior は残す）');
  assert(KTAiClient.FEATURE_AGENT_TURN === undefined && KTAiClient.AGENT_TURN_PROMPT_VERSION === undefined && typeof KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 't.cybozu.com', transport: async () => ({}) }).agentTurn === 'undefined', 'E9-4: 試作の会話を理解する担当（agent-turn）の接続は無い');
  assert(!('sim' in KTAiConversation.TIMING_DEFAULTS), 'E9-5: 段階ごとの目安に模擬の段階は無い');
  // buildGenerator は修復の依頼（feedback）と Toolkit が作る代表条件（cases）を渡されても Context に入れない
  const c = { customizationId: 'C1', requirement: '承認待ちでは金額を編集不可にする', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [] };
  const ctx = KTContext.buildGenerator({ customization: c, plan: { customizations: [c], steps: [] }, data: clone(DATA_C), verification: { requirementIds: [{ id: 'C1', kind: 'customization', text: 'x' }], cases: [{ id: 'K1', event: 'app.record.edit.show' }] }, feedback: { candidateHash: 'h', failures: [{ kind: 'simulation', message: 'x' }], previous: { code: 'x' } } });
  assert(ctx && ctx.verification && !('cases' in ctx.verification) && !('feedback' in ctx), `E9-6: Generator Context に cases・feedback を入れない: ${JSON.stringify({ verification: ctx && ctx.verification && Object.keys(ctx.verification), feedback: ctx && 'feedback' in ctx })}`);
});
// 追加指示 §5 の表の 9 行（D1〜D9）は、§0d の修正の後も上の D1〜D9 で同じ期待のまま確かめている（期待値は弱めていない。表示の言い方だけ §0d.3 の決定で
// 「動作テスト（隔離環境の模擬）」を「模擬テスト」に変えた。D3 の偽の生成工程は、記法の修正を検証の前に生成工程の側で行う形にした（Toolkit は書き換えない））


// =========================================================
// §F. C-1 第 3 段（2026-10-08・設計 §0d.4）: 入口を新しい流れに寄せ、置き換えた古い確認の流れを削除した後の回帰。
//   F1 Customize タブの相談は仮案の流れ（相談中の JavaScript の文脈を仮案の依頼に渡す）/ F2 最終案の後の「コードを作って」・右の［コードを作る］は最終案の作り直し（版を上げる）だけ /
//   F3「…変えて、コードも作って」は最終案を直すだけ（確定してコードを作るカードは出ない）/ F4 対応先の決まらない回答は聞き返さずに計画の AI へ /
//   F5 仮案から作っていない計画は直さない・作らない / F6 最終案の後の新しい依頼も仮案から / F7 削除した古い確認の流れが残っていない /
//   F8 生成工程の candidate-cancels-existing-lock の fail をほかの fail と同じく取り込む（Toolkit の error-cancels-other-js は削除）/
//   F9 limitCode は health の印 'limitCode' がある接続先のときだけ使う / F10 反映の依頼は最終案の承認へ案内する
console.log('\n--- §F. C-1 第 3 段: 入口を新しい流れに寄せ、古い確認の流れを削除した後の回帰 ---');
// F1: Customize タブの相談（subject）→ 仮案（PROPOSE）。相談中の JavaScript を仮案の依頼に渡す（従来の DISCUSS_JS の計画には入らない）
await section(async () => {
  const calls = { propose: [], plan: 0 };
  const services = { conversationFeatures: () => ['requirements', 'stream', 'proposal'], async propose(args) { calls.propose.push(args); return { ok: false, reason: 'TEST', message: '（テスト: 仮案は作らない）' }; }, async plan() { calls.plan += 1; return { plan: null }; }, async ask() { return { ok: true, answer: { answer: '答えです。', facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx: { facts: [] } }; }, readiness() { return null; } };
  const c = KTAiConversation.create({ services, now: () => '2026-10-08T00:00:00.000Z', clock: () => 0 });
  const seed = KTContext.buildConsultationSeed({ data: INPUTS.data, deps: INPUTS.deps, scan: INPUTS.scan, file: { name: 'common.js', target: 'desktop', type: 'FILE', fileKey: 'dl:common', size: '100' }, sourceText: null, appName: '案件管理' });
  const st = c.startConsultation(seed);
  const r = await c.send('承認済みでは金額を編集不可');
  assert(st.ok && r.intent === 'PROPOSE' && r.reason === 'CONSULTATION' && calls.propose.length === 1 && calls.propose[0].subject && calls.propose[0].subject.name === 'common.js' && calls.plan === 0, `F1-1: Customize タブの相談は仮案の流れ（相談中の JavaScript を仮案の依頼に渡す・計画の AI は呼ばない）: ${JSON.stringify({ intent: r.intent, reason: r.reason, subject: calls.propose[0] && calls.propose[0].subject && calls.propose[0].subject.name })}`);
  assert(c.classify('金額を編集不可に').intent === 'PROPOSE' && KTAiConversation.INTENT.DISCUSS_JS === undefined, 'F1-2: 相談中の短い指示（6 文字以上）も仮案へ。DISCUSS_JS の意図は無い');
  //   仮案の Context: 相談中の JavaScript の要約を事実に入れ（同じファイルの js-file の事実は 1 件）、操作するフィールドを関連候補に入れる
  const sub = KTContext.compactSubject({ sourceId: 'desktop:js:common.js', name: 'common.js', target: 'desktop', customizationType: 'FILE', sourceAvailable: true, events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }, { code: 'due_date', access: 'READ' }] });
  const ctxP = KTContext.buildProposal({ utterance: '承認済みでは編集不可にしたい', data: INPUTS.data, deps: INPUTS.deps, scan: INPUTS.scan, incoming: INPUTS.incoming, options: { subject: sub } });
  const sf = ctxP.facts.filter(f => f.key === 'JSFILE:desktop:common.js');
  assert(sf.length === 1 && /相談中の JavaScript「common\.js」/.test(sf[0].statement) && /amount/.test(sf[0].statement) && ctxP.facts.some(f => f.kind === 'field' && JSON.stringify(f).includes('"amount"')) && ctxP.size.chars <= 12000, `F1-3: 仮案の Context に相談中の JavaScript の要約（1 件）と操作するフィールド: ${JSON.stringify(sf.map(f => f.statement))}`);
  //   画面: Customize タブの［AIに相談］→ 送信 → 仮案の AI の Context に相談中の JavaScript
  const m = mount();
  await ticks();
  m.panel.consult(seed); await ticks(2);
  await m.panel.send('承認済みでは金額を編集不可'); await ticks(8);
  const pctx = m.calls.propose[0] && m.calls.propose[0].ctx;
  assert(pctx && pctx.conversation.mode === 'proposal' && pctx.facts.some(f => /相談中の JavaScript「common\.js」/.test(f.statement)) && m.calls.plan.length === 0, `F1-4: 画面の相談も仮案の AI へ（Context に相談中の JavaScript）: ${pctx ? pctx.facts.length : 'なし'}`);
});
// F2: 最終案の後の「コードを作って」は最終案の作り直し（同じ計画の新しい版。検証済みでない JavaScript だけ生成工程で作り直す。計画の AI は呼ばない）
await section(async () => {
  let n = 0;
  const base = makeGenerate({ sequence: ['good'] });
  const gen = { calls: base.calls, impl: async (args) => { n += 1; if (n === 1) return { ok: false, reason: 'UPSTREAM_ERROR', message: 'AI の応答を取得できませんでした（テスト）' }; return base.impl(args); } };
  const x = makeConvC({ generate: gen });
  await adoptC(x);
  const v1 = x.c.activePlan();
  assert(v1.version === 1 && v1.generated.C1.status === 'failed' && v1.final.approvable === false && x.finals().length === 1, `F2-0: 前提: 最初の生成は失敗して最終案は承認できない: ${v1.generated.C1.status}`);
  const plans0 = x.calls.plan.length;
  const r = await x.c.send('コードを作って');
  const v2 = x.c.activePlan();
  assert(r.ok && r.intent === 'GENERATE_CODE' && v2.version === 2 && v2.planId === v1.planId && v1.status === 'SUPERSEDED' && n === 2 && x.calls.plan.length === plans0 && v2.generated.C1.status === 'verified' && v2.final.approvable === true && x.finals().length === 2 && Array.isArray(r.regenerated) && r.regenerated.includes('C1'), `F2-1:「コードを作って」→ 同じ計画の新しい版で最終案を作り直す（計画の AI は呼ばない・失敗した JavaScript だけ作り直す）: ${JSON.stringify({ v: v2.version, n, plans: x.calls.plan.length, st: v2.generated.C1.status })}`);
  assert(v2.final.changedSince && v2.final.changedSince.regenerated.includes('C1') && /JavaScript の作り直し/.test(v2.final.changedSince.revisionRequest) && /最終案を直しました。/.test(finalHtml(x)) && /前の最終案 — このあと直した案があります/.test(KTAiChatUi.messageHtml(x.finals()[0], { plans: new Map(x.c.planHistory().map(v => [`${v.planId}:${v.version}`, v])), activePlan: v2 })), 'F2-2: 最終案のカードは置き換え（変わった点: JavaScript の作り直し）・前の最終案は 1 行に畳む');
  assert(!x.c.messages().some(m => ['CODE', 'SPEC'].includes(m.type) || ['code-intro', 'spec-intro', 'customization-choices', 'generate-extra-choices', 'confirm-generate', 'spec-required', 'source-unavailable', 'generate-repeat'].includes(m.data?.kind)), `F2-3: 最終案のカードを通らない生成のカード（コード・仕様・選択・確定して作る）は出ない: ${JSON.stringify(x.kinds())}`);
  // 承認の後に「コードを作って」: 検証済みだけなら作り直さない（同じ入力なら同じ結果）。承認もそのまま
  x.c.approveFinal({ planId: v2.planId, version: v2.version });
  const r2 = await x.c.send('コードを作って');
  assert(r2.intent === 'GENERATE_CODE' && x.c.activePlan() === v2 && v2.approval && n === 2 && x.last().data?.kind === 'generate-verified', `F2-4: 検証済みの JavaScript だけなら作り直さず案内だけ（版も承認も変えない）: ${x.last().data?.kind}`);
  // 「C1 のコードを作り直して。金額を変更したときにも切り替わるように」（生成の指示に要望が付いた文）は最終案を直す依頼（REVISE_PLAN）。要望を捨てない
  const cls = x.c.classify('C1 のコードを作り直して。金額を変更したときにも切り替わるように');
  assert(cls.intent === 'REVISE_PLAN' && cls.reason === 'TURN_THEN_GENERATE' && KTAiConversation.extraRequestIn === undefined, `F2-5: 生成の指示に付いた要望は最終案を直す依頼（従来の「内容を直してから作る / このまま作る」の選択は無い）: ${cls.intent}/${cls.reason}`);
  // 画面: 右の確認結果の［コードを作る］（data-act generate）も同じ入口。設定の手順だけの最終案では作る JavaScript が無いと答える
  const m = mount({ generateImpl: async () => { throw new Error('生成は呼ばない'); } });
  await ticks();
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) { await m.panel.send(s); await ticks(8); }
  await m.panel.send('おすすめで。この案で進めて'); await ticks(14);
  const vS = m.conv().activePlan();
  await clickChat(m, 'generate', { cid: 'C1' }); await ticks(6);
  assert(vS && vS.final && m.conv().activePlan() === vS && m.msgs().some(z => z.data?.kind === 'generate-not-needed') && !m.msgs().some(z => z.type === 'CODE'), 'F2-6: 右の［コードを作る］も最終案の作り直しの入口（作る JavaScript が無ければ案内だけ。版は変えない）');
  const noFinal = makeConvC();
  const rn = await noFinal.c.send('コードを作って');
  assert(rn.intent === 'GENERAL' && rn.reason === 'NO_PLAN', `F2-7: 最終案が無いときの「コードを作って」は生成しない: ${rn.reason}`);
});
// F3:「…変えて、コードも作って」は最終案を直す（JavaScript は最終案のパイプラインが作る。［この変更で確定してコードを作る］のカードは出ない）
await section(async () => {
  const CUST_V2 = custOf(['lock'], {});
  CUST_V2.fields[1].condition = 'ステータス in ("承認待ち", "承認済み")';
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: args.revision ? CUST_V2 : CUST_C1 }) });
  await adoptC(x);
  const r = await x.c.send('承認済みでも金額は編集不可にして、コードも作って');
  const v2 = x.c.activePlan();
  assert(r.intent === 'REVISE_PLAN' && r.reason === 'TURN_THEN_GENERATE' && v2.version === 2 && x.finals().length === 2 && x.gen.calls.length === 2 && v2.generated.C1.status === 'verified' && !x.c.messages().some(m => m.data?.kind === 'confirm-generate' || m.type === 'CODE'), `F3-1: 計画を直した版の JavaScript は最終案のパイプラインで作り直す（確定して作るカードは出ない）: ${JSON.stringify(x.kinds())}`);
});
// F4: 対応先が決まらない回答（確認事項が 2 件あるときの「いいえ」）は、対応先を聞き返すカードを出さず、候補の確認事項を添えて計画の AI に渡す（決定事項には記録しない）
await section(async () => {
  const Qs = [{ id: 'Q1', question: '承認待ちの間、申請者本人も編集できなくしますか', topic: 'scope', priority: 'later', options: ['はい', 'いいえ'] }, { id: 'Q2', question: 'モバイルでも同じ制御にしますか', topic: 'platform', priority: 'later', options: ['はい', 'いいえ'] }];
  const x = makeConvC({ planImpl: (args) => planJs(args, { questions: args.revision ? [] : Qs }) });
  await adoptC(x);
  assert(x.c.classify('いいえ').reason === 'ANSWER_TARGET_UNCLEAR', '前提: 確認事項が 2 件あるときの「いいえ」は対応先が決まらない');
  const r = await x.c.send('いいえ');
  const req = x.calls.plan.slice(-1)[0];
  assert(r.ok && r.intent === 'ANSWER' && x.c.activePlan().version === 2 && req.revision && /いいえ（どの確認事項への回答か決められなかった答え。候補の確認事項: 「承認待ちの間、申請者本人も編集できなくしますか」、「モバイルでも同じ制御にしますか」）/.test(req.request) && !x.c.messages().some(m => m.data?.kind === 'answer-target') && x.c.pendingClarification === undefined && !x.c.ledger().some(e => e.answer === 'いいえ'), `F4-1: 対応先を聞き返さず、候補を添えて計画の AI に渡す（決定事項に記録しない）: ${req.request}`);
  assert(x.c.metrics().unresolvedAnswers === 1 && x.c.metrics().clarifications === 0, 'F4-2: 計測は「対応先を決められず計画の AI に渡した答え」（unresolvedAnswers）。聞き返しの回数（clarifications）は増えない');
});
// F5: 仮案から作っていない計画（Context ペインの「変更計画を作成」・registerPlan）は、会話で回答を入れない・JavaScript を作らない。
//   修正の依頼はその発言を新しい依頼として仮案から作る（同じ依頼を送り直しても進めない行き止まりを作らない）
await section(async () => {
  const x = makeConvC();
  const vL = x.c.registerPlan({ plan: planJs({ goal: '承認待ちでは金額を編集不可' }).plan, ctx: null, review: null });
  assert(!x.c.messages().some(m => ['PLAN', 'REVIEW', 'SPEC'].includes(m.type) || ['plan-summary', 'review-summary', 'questions', 'provisionals', 'spec-intro'].includes(m.data?.kind)), `F5-1: 計画を登録しても、変更案のカード・確認事項・提案・仕様の案内は出ない（announcePlan の従来の分岐は削除）: ${JSON.stringify(x.kinds())}`);
  const rs = [await x.c.send('コードを作って'), await x.c.send('全員', { intentOverride: 'ANSWER' })];
  assert(rs.every(r => r.intent === 'GENERAL' && r.reason === 'LEGACY_PLAN') && x.calls.plan.length === 0 && x.gen.calls.length === 0 && x.c.activePlan() === vL && /仮案と最終案の流れで作ったものではない/.test(x.last().text), `F5-2: 仮案から作っていない計画には回答を入れない・JavaScript を作らない: ${JSON.stringify(rs.map(r => r.reason))}`);
  const rv = await x.c.send('一覧の名前は承認待ちにして');
  assert(rv.intent === 'PROPOSE' && rv.reason === 'NEW_REQUEST_LEGACY_PLAN' && x.calls.propose.length === 1 && x.calls.propose[0].utterance === '一覧の名前は承認待ちにして' && x.calls.plan.length === 0, `F5-3: 修正の依頼は新しい依頼として仮案の AI へ（計画の AI でその計画を直さない）: ${JSON.stringify({ intent: rv.intent, reason: rv.reason })}`);
});
// F6: 最終案の後の新しい依頼（「新しい変更案にする」の選択・反映済みの後の依頼）も仮案から（afterPlan。仮案への返事を前の計画の修正と取り違えない）
await section(async () => {
  const x = makeConvC();
  await adoptC(x);
  const v1 = x.c.activePlan();
  const r = await x.c.send('課長・部長の承認者を選ぶ運用にしたい', { intentOverride: 'PLAN' });
  const d2 = x.c.draft();
  assert(r.intent === 'PROPOSE' && d2 && d2.status === 'open' && d2.afterPlan === v1.planId && x.c.activePlan() === v1, `F6-1:「新しい変更案にする」は仮案から（前の計画の id を afterPlan に持つ）: ${JSON.stringify({ intent: r.intent, after: d2 && d2.afterPlan })}`);
  const c2 = x.c.classify('100円未満は部長不要、100万円以上は必要');
  assert(c2.intent === 'DRAFT_REPLY', `F6-2: その仮案への返事は前の計画の修正（REVISE_PLAN）にしない: ${c2.intent}`);
  await x.c.send('100円未満は部長不要、100万円以上は必要'); await x.c.send('7営業日で。会社独自の休業日は今回はなし');
  const ra = await x.c.send('おすすめで。この案で進めて');
  const v2 = x.c.activePlan();
  assert(ra.intent === 'ADOPT_DRAFT' && v2 && v2.planId !== v1.planId && v2.fromDraft && v2.fromDraft.id === d2.id && v2.final && x.c.draft().status === 'adopted', `F6-3: 採用すると新しい計画の系列で最終案を作る: ${JSON.stringify({ intent: ra.intent, same: v2 && v2.planId === v1.planId })}`);
  assert(x.c.classify('一覧の名前は承認待ちにして').intent === 'REVISE_PLAN', 'F6-4: 採用の後は、その最終案の修正に戻る');
});
// F7: 置き換えた古い確認の流れが残っていない（仕様の確定・質問カード・対応先の選択・確定してコードを作る・従来の生成・先回りの返答）
await section(async () => {
  const x = makeConvC();
  assert(typeof x.c.confirmSpec === 'undefined' && typeof x.c.pendingClarification === 'undefined' && KTAiConversation.INTENT.CONFIRM_SPEC === undefined && KTAiConversation.MSG.SPEC === undefined && KTAiConversation.MSG.CODE === undefined, 'F7-1: 会話に仕様の確定・対応先の確認・仕様とコードのカードの種類は無い');
  assert(['specChatCardHtml', 'codeCardHtml', 'questionsCardHtml', 'planCardHtml', 'reviewCardHtml', 'questionList'].every(k => KTAiChatUi[k] === undefined) && typeof KTAiChatUi.specCardHtml === 'function', 'F7-2: 仕様のカード・コードのカード・確認事項のカード・変更案のカードの描画は無い（右の仕様の閲覧 specCardHtml は残す）');
  await adoptC(x);
  const sp = KTAiChatUi.specCardHtml(x.c.activePlan());
  assert(!/data-act="(confirm-spec|confirm-generate|generate|revise-spec)"/.test(sp) && /最終案の一部です/.test(sp), 'F7-3: 右の仕様は閲覧だけ（［この仕様で確定］［確定してコードを作る］［JavaScript を生成］［仕様を修正］は無い）');
  const m = mount();
  assert(typeof m.panel.confirmSpec === 'undefined', 'F7-4: 画面に仕様の確定（confirmSpec）は無い');
  const askCalls = [];
  const y = makeConvC();
  const ask0 = y.services.ask; y.services.ask = async (a) => { askCalls.push(a); return ask0(a); };
  await adoptC(y);
  assert(!askCalls.some(a => a.conversation && a.conversation.brief) && !y.c.messages().some(mm => mm.data?.kind === 'plan-brief'), 'F7-5: 先回りの返答（assistant-qa の brief）は使わない');
});
// F8: 生成工程が候補の error による既存 JS の編集不可の取り消し（cause candidate-cancels-existing-lock）を fail で返したら、ほかの fail と同じく未解決（承認できない）。
//   Toolkit の形式確認の error-cancels-other-js・errorGuarded は削除した（同じ判定を二重に持たない）
await section(async () => {
  const CANCEL = { id: 'KX', requirementIds: ['C1'], field: 'amount', effect: 'warn', expect: 'warn', event: 'app.record.edit.show', side: 'match', kind: 'match', verdict: 'fail', cause: 'candidate-cancels-existing-lock', details: { cancelledExisting: ['amount'] }, message: '承認待ちの編集画面を開いたところ、生成したコードが同じイベントでエラーを表示したため、既存の JavaScript が設定した金額の編集不可が kintone の規則で取り消されました' };
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: custOf(['warn']) }), generate: makeGenerate({ sequence: ['warn'], extraCases: [CANCEL] }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  assert(e.status === 'unresolved' && e.verdict.kind === 'behavior-fail' && v.final.approvable === false && /取り消されました/.test(JSON.stringify(v.final.cannot)) && x.c.approveFinal({ planId: v.planId, version: v.version }).ok === false && e.verification.behavior.cases.some(y => y.cause === 'candidate-cancels-existing-lock'), `F8-1: candidate-cancels-existing-lock の fail は未解決（承認できない）: ${JSON.stringify({ st: e.status, kind: e.verdict && e.verdict.kind })}`);
  const WARN_SHOW = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const f = event.record['amount'];\n    f.error = Number(f.value || 0) > 1000000 ? '100万円を超えています' : null;\n    return event;\n  });\n})();";
  const DEAL = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    if (event.record['ステータス'].value === '承認済み') event.record['amount'].disabled = true;\n    return event;\n  });\n})();";
  const data2 = FX.makeData();
  const fieldsN = KTDeps.normalizeFields(data2.fields);
  const scan2 = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files: [{ name: 'dealLock.js', target: 'desktop', kind: 'js', text: DEAL }], fields: fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType })), deps: KTDeps.buildDependencyData(data2, fieldsN) });
  const custW = { customizationId: 'C1', requirement: '100万円を超えたら警告', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }] };
  const rv = KTCodeReview.review({ generated: { strategy: 'NEW_JS_FILE', targetFile: 'warn.js', code: WARN_SHOW, patch: null, events: custW.events, fields: custW.fields, apis: [] }, customization: custW, plan: null, data: data2, scan: scan2, existingSource: null });
  assert(!rv.checks.some(ch => ch.name === 'error-cancels-other-js') && typeof KTCodeReview.kintoneFieldOps === 'undefined', `F8-2: Toolkit の形式確認に error-cancels-other-js・errorGuarded は無い（生成工程の模擬テストの fail で扱う）: ${JSON.stringify(rv.checks.filter(ch => !ch.ok).map(ch => ch.name))}`);
  //   C-1 第 3 段（2026-10-08）: 既存 JS の編集不可の条件（承認済みなど）が隔離環境の代表条件で成り立たず、取り消しを観測できない → 生成工程は
  //   existing-lock-unverified の not-run を返す。Toolkit は既存 JS の区分で準備未完了（合格にしない・修復を依頼しない）にし、
  //   ［計画を直すよう依頼する］の文を構造化した値（details.files のファイル名）から作る
  const R = KTAiConversation.BEHAVIOR_REASONS['existing-lock-unverified'];
  assert(R && R.category === 'existing' && R.fix === 'revise' && !R.unfixable && R.readiness && KTAiConversation.REASON_CATEGORY.existing.next, 'F8-3: 理由の語彙に existing-lock-unverified（区分 既存 JS・次の手は計画を直す・計画を直せば解ける）がある');
  //   代表条件は生成工程の応答の形（details.files は [{ name, kinds }]・details.fields）を入口の正規化（normalizeVerification）に通したもの
  const UNV_RAW = { id: 'KU', requirementIds: ['C1'], field: 'amount', effect: 'warn', expect: 'warn', event: 'app.record.edit.show', side: 'match', kind: 'match', verdict: 'not-run', reason: 'existing-lock-unverified', details: { files: [{ name: 'dealLock.js', kinds: ['lock-same-event'] }], fields: ['amount'] }, message: '既存の JavaScript が同じ画面で編集不可を設定しています。模擬テストでは確かめられません' };
  const UNV = KTAiClient.normalizeVerification({ version: '1', candidateHash: '0123456789abcdef', passed: true, machine: [], behavior: { status: 'not-run', reason: 'partial', cases: [UNV_RAW] } }).behavior.cases[0];
  assert(UNV.reason === 'existing-lock-unverified' && JSON.stringify(UNV.details.files) === '["dealLock.js"]', `F8-3b: 入口の正規化は existing-lock-unverified の理由とファイル名を落とさない: ${JSON.stringify(UNV)}`);
  const y = makeConvC({ planImpl: (args) => planJs(args, { cust: custOf(['warn']) }), generate: makeGenerate({ sequence: ['warn'], extraCases: [UNV] }) });
  await adoptC(y);
  const vy = y.c.activePlan(), ey = vy.generated.C1, fy = vy.final.fix;
  assert(ey.status === 'not-run' && ey.verdict.category === 'existing' && ey.verdict.reasonKey === 'existing-lock-unverified' && ey.verdict.fix === 'revise' && !ey.verdict.unfixable && /「dealLock\.js」/.test(ey.verdict.reason) && /作った JavaScript の誤りとは判定していません/.test(ey.verdict.reason)
    && vy.final.approvable === false && y.c.approveFinal({ planId: vy.planId, version: vy.version }).ok === false && y.gen.calls.length === 1 && !/実機で確かめ/.test(`${ey.verdict.next}${vy.final.blockingReason}`)
    && vy.final.blockingReason === R.readiness,
  `F8-4: existing-lock-unverified → 既存 JS の区分で準備未完了（承認できない・修復を呼ばない・ファイル名を出す）: ${JSON.stringify({ st: ey.status, verdict: ey.verdict, reason: vy.final.blockingReason, gen: y.gen.calls.length })}`);
  assert(fy && fy.kind === 'revise' && fy.text.includes('警告を変更・保存のイベントで出すか、既存の JavaScript（dealLock.js）に統合する形に計画を直してください') && !fy.text.includes('既存の処理との役割分担を見直してください') && fixButtonOf(finalHtml(y)),
    `F8-5: ［計画を直すよう依頼する］の文は構造化した値（details.files）から「警告を変更・保存のイベントで出すか、既存の JavaScript（ファイル名）に統合する形」と作る: ${JSON.stringify(fy)}`);
  //   C-1 第 4 段（2026-10-09・ledger U1）: BF-C のように、既存の編集不可がある所（details.files）が候補自身の統合先（EXTEND_EXISTING_JS の targetFile）だけなら、
  //   統合しても生成工程は統合先の元の本文を既存 JS として数えるので解決しない。「統合する」の案は出さず、警告の効果のイベントを変更・保存のイベントだけにする
  //   （確かめられなかった代表条件のフィールドとイベント）と具体的に書く
  const CUST_W = { ...clone(RP.CUSTOMIZATION), fields: [{ code: 'amount', access: 'CONTROL', condition: RP.CUSTOMIZATION.fields[0].condition, effects: ['warn'] }] };
  const GEN_MET = () => { const g = KIT.gwModernized(RP.GENERATED); g.coverage = g.coverage.map(cv => ({ ...cv, status: 'MET' })); return g; };
  const runOwn = async (extra) => { const z = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_W, summary: '金額が 100 万円を超えたら警告します（保存は止めません）。' }), generate: makeGenerate({ sequence: ['warn'], existingSource: { name: 'dealLock.js', target: 'desktop', text: RP.DEAL_LOCK }, generatedOf: GEN_MET, extraCases: extra }) }); await adoptC(z); const v = z.c.activePlan(); return { z, v, e: v.generated.C1, f: v.final.fix }; };
  const own = await runOwn([UNV]);
  assert(RP.GENERATED.strategy === 'EXTEND_EXISTING_JS' && RP.GENERATED.targetFile === 'dealLock.js' && own.e.status === 'not-run' && own.v.final.approvable === false && own.f && own.f.kind === 'revise'
    && own.f.text.includes('警告は画面を開いたときには出さず、値を変えたとき・保存するときだけにしてください（「金額」の警告: 編集画面を開いたときの警告をやめる）') && !/app\.record\./.test(own.f.text) && !/existing-lock-unverified/.test(own.f.text) && !own.f.text.includes('統合する形に計画を直してください')
    && /値を変えたとき・保存するときだけ/.test(own.e.verdict.next) && !/app\.record\./.test(own.e.verdict.next) && !/統合する形に計画を直します/.test(own.e.verdict.next) && own.z.gen.calls.length === 1,
    `F8-6（ledger U1）: 既存の編集不可が候補自身の統合先だけなら、統合の案を出さず効果のイベントで具体的に書く: ${JSON.stringify({ st: own.e.status, next: own.e.verdict && own.e.verdict.next, fix: own.f })}`);
  //   統合先のほかの既存 JS にも編集不可があるときは、そのファイルへの統合の案も残す（統合先の分は効果のイベントで書く）
  const UNV2 = KTAiClient.normalizeVerification({ version: '1', candidateHash: '0123456789abcdef', passed: true, machine: [], behavior: { status: 'not-run', reason: 'partial', cases: [{ ...UNV_RAW, id: 'KU2', details: { files: [{ name: 'otherLock.js', kinds: ['lock-same-event'] }], fields: ['amount'] } }] } }).behavior.cases[0];
  const mixed = await runOwn([UNV2]);
  assert(mixed.f && mixed.f.text.includes('既存の JavaScript（otherLock.js）に統合する形に計画を直してください') && !mixed.f.text.includes('統合する形にしても解決しません'),
    `F8-7: ほかの既存 JS（統合先でない）に編集不可があるときは、従来どおりそのファイルの統合の案を出す: ${JSON.stringify(mixed.f)}`);
});
// F9: coverage の limitCode は health の customization-generator.verification に 'limitCode' の印がある接続先のときだけ使う（印が無ければ落とし、PARTIAL は要件未達のまま）
await section(async () => {
  const CUST_L = { customizationId: 'C1', requirement: '承認待ちでは案件名を編集できないようにする', whyStandardInsufficient: 'ステータスで切り替えるアクセス権は無い', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'case_name', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock'] }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [] };
  const planRespL = (goal) => { const b = PLAN_V1(goal); return { ...b, plan: { ...b.plan, solution: 'CUSTOMIZATION', steps: [mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { title: 'JavaScript', solution: 'CUSTOMIZATION' })], customizations: [CUST_L] } }; };
  const LOCK_L = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認待ち') record['case_name'].disabled = true;\n    return event;\n  });\n})();";
  const run = async (features) => {
    const h = clone(HEALTH); h.registry.toolkit['customization-generator'].verification = ['requirementId', ...features];
    const generateImpl = async ({ ctx, requestId }) => {
      const req = (ctx.verification && ctx.verification.requiredEffects) || [];
      const resp = { ok: true, contractVersion: '2.1', meta: { requestId, gateway: { product: 'toolkit', feature: 'customization-generator', promptVersion: '1', contextVersion: 'customization-1' }, normalization: { warnings: [] }, ai: { model: 'm' } }, generated: { strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', summary: 's', code: LOCK_L, patch: null, events: ['app.record.edit.show'], fields: [{ code: 'case_name', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'PARTIAL', note: '行の追加・削除は止められません', limitCode: 'SUBTABLE_ROWS' }] }, ...(req.length ? { verification: fakeVerification({ code: LOCK_L, has: { case_name: ['lock'] } }, req, { candidateHash: gwHashOfCtx(ctx, { strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', code: LOCK_L, patch: null }) }) } : {}) };
      const vv = KTAiClient.validateGenerated(resp, ctx);
      return { ...vv.normalized, requestId };
    };
    const m = mount({ health: h, planImpl: ({ ctx, requestId }) => { const vv = KTAiClient.validatePlan(planRespL(ctx.goal), ctx); return { ...vv.normalized, requestId, clientWarnings: vv.warnings }; }, generateImpl });
    await ticks();
    for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) { await m.panel.send(s); await ticks(8); }
    await m.panel.send('おすすめで。この案で進めて'); await ticks(16);
    return m.conv().activePlan();
  };
  const vOn = await run(GEN_EFFECT_FEATURES);
  const vOff = await run(GEN_EFFECT_FEATURES.filter(f => f !== 'limitCode'));
  const decl = (v) => (v && v.generated && v.generated.C1 && v.generated.C1.review && v.generated.C1.review.coverage ? v.generated.C1.review.coverage.declared : []);
  assert(decl(vOn).some(d => d.limitCode === 'SUBTABLE_ROWS') && !decl(vOff).some(d => d.limitCode), `F9-1: limitCode は health の印 'limitCode' がある接続先のときだけ使い、無ければ落とす: ${JSON.stringify({ on: decl(vOn), off: decl(vOff) })}`);
});
// F10: 最終案の流れの「これで進めて」（反映の依頼）は、承認の前なら最終案の承認へ案内する（手順ごとの承認・仕様の確定へは案内しない）
await section(async () => {
  const x = makeConvC();
  await adoptC(x);
  const r = await x.c.send('これで進めて');
  assert(r.intent === 'REQUEST_PREVIEW' && x.last().data?.kind === 'preview-needs-approval' && /［動作テスト環境へ反映］/.test(x.last().text), `F10-1: 承認の前の反映の依頼は最終案の承認へ案内: ${x.last().text}`);
  const rj = await x.c.send('JS を登録して');
  assert(rj.intent === 'REQUEST_JS_PREVIEW' && x.last().data?.kind === 'js-preview-needs-approval', `F10-2: 承認の前の JavaScript の登録の依頼も承認へ案内: ${x.last().data?.kind}`);
});

// F11: 共有の部品（tests/helpers/new-flow.js）で新しい流れを最後まで通す（依頼 → 仮案 → 採用 → 計画 → 生成 → 最終案 → 承認 → 反映の準備）。
//   ほかのテストを移し替えるときの土台。会話コントローラ（偽 services）と画面（偽 client）の両方
await section(async () => {
  const x = makeConvC();
  const r = await adoptC(x);
  const ap = KIT.approveC(x);
  const v = x.c.activePlan();
  assert(r.intent === 'ADOPT_DRAFT' && v.final && v.final.approvable && ap.ok && x.c.approvalValid().ok && KIT.REQUESTS.length === 4, `F11-1: 会話コントローラ: 採用 → 最終案 → 承認（共有の部品）: ${JSON.stringify({ intent: r.intent, ok: ap.ok })}`);
  const CUST_S = { customizationId: 'C1', requirement: '承認待ちでは案件名を編集できないようにする', whyStandardInsufficient: 'ステータスで切り替えるアクセス権は無い', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'case_name', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock'] }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [] };
  const LOCK_S = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認待ち') record['case_name'].disabled = true;\n    return event;\n  });\n})();";
  const h = clone(HEALTH); h.registry.toolkit['customization-generator'].verification = ['requirementId', ...GEN_EFFECT_FEATURES];
  const planResp = (goal) => { const b = PLAN_V1(goal); return { ...b, plan: { ...b.plan, solution: 'HYBRID', steps: [...b.plan.steps, mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { title: 'JavaScript', solution: 'CUSTOMIZATION' })], customizations: [CUST_S] } }; };
  const generateImpl = async ({ ctx, requestId }) => {
    const req = (ctx.verification && ctx.verification.requiredEffects) || [];
    const resp = { ok: true, contractVersion: '2.1', meta: { requestId, gateway: { product: 'toolkit', feature: 'customization-generator', promptVersion: '1', contextVersion: 'customization-1' }, normalization: { warnings: [] }, ai: { model: 'm' } }, generated: { strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', summary: '承認待ちでは案件名を編集できないようにします。', code: LOCK_S, patch: null, events: ['app.record.edit.show'], fields: [{ code: 'case_name', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '' }] }, ...(req.length ? { verification: fakeVerification({ code: LOCK_S, has: { case_name: ['lock'] } }, req, { candidateHash: gwHashOfCtx(ctx, { strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', code: LOCK_S, patch: null }) }) } : {}) };
    const vv = KTAiClient.validateGenerated(resp, ctx);
    return { ...vv.normalized, requestId };
  };
  const m = mount({ health: h, planImpl: ({ ctx, requestId }) => { const vv = KTAiClient.validatePlan(planResp(ctx.goal), ctx); return { ...vv.normalized, requestId, clientWarnings: vv.warnings }; }, generateImpl });
  await ticks();
  const vS = await KIT.adoptOnScreen(m);
  const out = await KIT.prepareOnScreen(m);
  assert(vS && vS.final && vS.final.approvable && out.ready && !out.approved && out.exec && out.exec.status === 'PREPARED' && out.js && out.js.status === 'PREPARED' && out.button && !out.button.disabled && KIT.writesOf(m).length === 0, `F11-2: 画面: 標準設定と JavaScript の最終案 → 承認の欄の準備（設定の手順と JavaScript の登録の準備。書き込みはしない・まだ承認しない）→［動作テスト環境へ反映］を押せる: ${JSON.stringify({ ready: out.ready, exec: out.exec && out.exec.status, js: out.js && out.js.status, reasons: out.pre && out.pre.reasons })}`);
  assert(!m.msgs().some(z => ['PLAN', 'SPEC', 'CODE', 'REVIEW'].includes(z.type) || ['questions', 'provisionals', 'spec-intro', 'code-intro', 'confirm-generate', 'answer-target'].includes(z.data?.kind)), `F11-3: 標準設定と JavaScript が混在しても、確認質問・JS 仕様・コードのカードを往復しない（最終案のカード 1 枚）: ${JSON.stringify(m.msgs().map(z => z.data?.kind || z.type))}`);
});

// =========================================================
console.log('\n--- §G. C-1 第 4 段（2026-10-09）: 使用量の範囲・PC とモバイルの行・計画の AI の文のフィールド名 ---');
// G1（K-2）: 最終案のカードの使用量（トークン・米ドル）は AI の呼び出しの回数と同じ範囲（計画の AI の分も足す）。単価は生成と同じ §10 の単価（入力 $2・出力 $10 / 100 万）
//   §0f.4 の 6（2026-10-09）で強めた: 生成の使用量が未取得のときは、計画の分を「確認できた分」として出し、使用量が不明の回数と「費用は未確定」を明示する
//   （以前は一部だけの合計を「使用量 … 約 X 米ドル」と全体のように出していた。K > 0 なら合計と言わない）
await section(async () => {
  const x = makeConvC({ planImpl: (args) => { const r = planJs(args); r.plan.ai = { model: 'm', usage: { input_tokens: 35550, output_tokens: 3000 } }; return r; } });
  await adoptC(x);
  const u = x.c.activePlan().final.usage;
  const all = stripC(finalHtml(x));
  const line = (all.split('\n').find(s => /AI の呼び出し/.test(s)) || '');
  assert(u && u.tokens.input === 35550 && u.tokens.output === 3000 && u.costUsd === 0.1011 && u.measured === 1 && u.aiCalls >= 2 && u.sentCalls === u.aiCalls && u.usageUnknown === 1
    && /AI の呼び出し 2 回（内部を含め最大 2 回）。うち 1 回は使用量が不明のため、費用は未確定です。確認できた分 入力 35550 \/ 出力 3000 トークン・約 0\.1011 米ドル（キャッシュの割引なし）/.test(line)
    && !/合計/.test(line) && !/使用量 入力 35550/.test(line),
    `G1（K-2・§0f.4 の 6）: 使用量に計画の AI の分を足し、生成の使用量が未取得なら「確認できた分」と不明の回数・費用は未確定を出す（合計と言わない）: ${JSON.stringify(u)} / ${line}`);
  //   すべての呼び出しの使用量が分かったときだけ「合計」（不明の文を出さない）
  const base = makeGenerate({ sequence: ['good'] });
  const gen = { calls: base.calls, impl: async (args) => { const r = await base.impl(args); return { ...r, generated: { ...r.generated, ai: { model: 'g', usage: { input_tokens: 5000, output_tokens: 800 } } } }; } };
  const y = makeConvC({ planImpl: (args) => { const r = planJs(args); r.plan.ai = { model: 'm', usage: { input_tokens: 35550, output_tokens: 3000 } }; return r; }, generate: gen });
  await adoptC(y);
  const u2 = y.c.activePlan().final.usage;
  const line2 = (stripC(finalHtml(y)).split('\n').find(s => /AI の呼び出し/.test(s)) || '');
  assert(u2 && u2.usageUnknown === 0 && u2.measured === 2 && /合計 入力 40550 \/ 出力 3800 トークン・約 0\.1191 米ドル（キャッシュの割引なし）/.test(line2) && !/不明|未確定/.test(line2),
    `G1-2: すべての呼び出しの使用量が分かったときだけ合計を出す: ${JSON.stringify(u2)} / ${line2}`);
});
// G2（K-3）: 必須の動作の行に PC / モバイルを付け、同じ内容を 2 回出さない。実現できない点の行も PC / モバイルを付け、同じ内容は 1 行にまとめる
await section(async () => {
  const twoPlats = (args) => {
    const b = planJs(args);
    const c1 = clone(CUST_C1), c2 = { ...clone(CUST_C1), customizationId: 'C2', platform: ['mobile'], events: CUST_C1.events.map(ev => `mobile.${ev}`) };
    b.plan.steps = [b.plan.steps[0], { ...clone(b.plan.steps[0]), id: 'C2', spec: { customizationId: 'C2' } }];
    b.plan.customizations = [c1, c2];
    b.review.steps = [b.review.steps[0], { ...clone(b.review.steps[0]), stepId: 'C2', customization: clone(c2) }];
    b.review.executionReadiness.planOnlySteps = ['C1', 'C2'];
    return b;
  };
  const x = makeConvC({ planImpl: twoPlats });
  await adoptC(x);
  const fin = x.c.activePlan().final;
  const all = stripC(rightOf(x));
  const rows = all.split('\n').filter(l => /「金額」（(?:PC|モバイル)）: 編集できない —/.test(l));
  assert(fin.verification.effects.length === 2 && JSON.stringify(fin.verification.effects.map(e => e.platforms)) === JSON.stringify([['desktop'], ['mobile']]) && rows.length === 2 && rows.some(l => l.includes('（PC）')) && rows.some(l => l.includes('（モバイル）')),
    `G2-1（K-3）: 必須の動作の行は PC / モバイルを付けて 1 行ずつ: ${JSON.stringify({ effects: fin.verification.effects, rows })}`);
  //   PC とモバイルの JavaScript が同じ理由で作れなかった → 実現できない点は 1 行にまとめて「PC・モバイル」と付ける
  const y = makeConvC({ planImpl: twoPlats, generate: { impl: async () => ({ ok: false, reason: 'GENERATE_BLOCKED', message: 'blocked' }), calls: [] } });
  await adoptC(y);
  const finY = y.c.activePlan().final;
  const failRows = finY.cannot.filter(r => r.kind === 'failed');
  const allY = stripC(finalHtml(y));
  assert(failRows.length === 1 && JSON.stringify(failRows[0].platforms) === JSON.stringify(['desktop', 'mobile']) && (allY.match(/JavaScript を生成できませんでした/g) || []).length === 1 && /PC・モバイル: JavaScript を生成できませんでした/.test(allY),
    `G2-2（K-3）: 同じ内容の実現できない点は 1 行にまとめ、PC・モバイルを付ける: ${JSON.stringify(finY.cannot)}`);
});
// G3: 最終案の「最終的にどう動くか」などの計画の AI の文に入ったフィールドのコードは、既存の表示用の変換（フィールドの名前）を通す
await section(async () => {
  const x = makeConvC({ planImpl: (args) => planJs(args, { summary: '承認待ちでは amount を編集不可にします。' }) });
  await adoptC(x);
  const fin = x.c.activePlan().final;
  assert(fin.behaviors.some(b => b.includes('「金額」を編集不可にします')) && !fin.behaviors.some(b => /\bamount\b/.test(b)), `G3: 計画の AI の文のフィールドのコードは名前に直す: ${JSON.stringify(fin.behaviors)}`);
});

// =========================================================
console.log('\n--- §H. §0e.1（2026-10-09）: 反映の操作を一度にする（承認の欄の準備 → ［動作テスト環境へ反映］1 回 → 結果のカード 1 枚）。モックの API・画面のボタンで結果まで ---');
//   画面に描いた右の「反映」の HTML を記録する（準備・最終確認の段（［動作テスト環境へ反映］の最終確認 kt-ai-exec-go・登録の確認 kt-ai-jsreg-go）を一度も出していないことを確かめる）
const paneSpy = (() => {
  const seen = { execGo: 0, jsGo: 0 };
  const CU = T.KTContextUi, CH = T.KTAiChatUi;
  const ex0 = CU.executorHtml, js0 = CH.jsRegisterPaneHtml;
  CU.executorHtml = (...a) => { const h = ex0(...a); if (/id="kt-ai-exec-go"/.test(h)) seen.execGo++; return h; };
  CH.jsRegisterPaneHtml = (...a) => { const h = js0(...a); if (/id="kt-ai-jsreg-go"/.test(h)) seen.jsGo++; return h; };
  return { reset() { seen.execGo = 0; seen.jsGo = 0; }, seen };
})();
const finalCardText = (m) => { const h = m.chat(); const i = h.indexOf('class="kt-ai-card kt-ai-final-card"'); const j = h.indexOf('kt-ai-final-apply-card'); return stripC(i >= 0 ? h.slice(i, j > i ? j : undefined) : ''); };
const wsLabel = (m) => stripC(m.$('kt-ai-ws-state').innerHTML).trim();
// H1: 混在（標準設定と JavaScript）の成功。新設フィールドに依存する JavaScript は承認の欄で「設定の反映の後に確かめる」と出し、設定の後に登録される。利用者の確認は 1 回
await section(async () => {
  paneSpy.reset();
  const { m, v } = await KIT.mountFinal({ kind: 'mixed' });
  assert(v && v.final && v.final.approvable === true && v.generated.C1.status === 'verified', `H1-0: 前提: 混在の最終案（承認メモの追加・一覧の追加・承認メモを編集不可にする JavaScript）: ${JSON.stringify(v && v.final && v.final.blockingReason)}`);
  let preChat = '';
  const r = await KIT.applyOnScreen(m, { before: () => { preChat = stripC(m.chat()); } });
  assert(r.pre.status === 'ready' && r.pre.items.settings.length === 2 && r.pre.items.files.join() === '＋ memoLock.js（PC）新規追加（4 番目・末尾）' && r.pre.items.deferred.length === 1 && /フィールド「承認メモ」を前提にしています。設定の反映の後に、その存在を確かめてから登録します/.test(r.pre.items.deferred[0]) && r.button && !r.button.disabled && r.pre.reasons.length === 0, `H1-1: 承認の欄: 書き込みをしない準備を自動で走らせ、反映する設定 2 件・追加する JavaScript・「設定の反映の後に確かめる」依存を出す（依存では止めない）: ${JSON.stringify(r.pre)}`);
  assert(/反映の前の確認（書き込みなし）/.test(preChat) && /反映する設定の手順: 2 件/.test(preChat) && /＋ memoLock\.js（PC）新規追加/.test(preChat) && /設定の反映の後に確かめること/.test(preChat) && /対象: 動作テスト環境/.test(preChat) && !/承認メモフィールドを追加/.test(preChat), 'H1-2: 押す前の最終案のカードの承認の欄に重要事項（設定の件数・追加するファイル・依存・対象の環境）を出す（追加だけの手順の本文は会話に出さない）');
  const w = r.writes;
  assert(r.run && r.run.stage === 'done' && r.run.ok && !r.run.partial && JSON.stringify(w) === '["POST fields","PUT views","POST file","PUT customize"]' && m.mock.st.fields.approval_memo && m.mock.st.views['承認待ち一覧'], `H1-3: ［動作テスト環境へ反映］1 回で、標準設定を依存順に実行 → JavaScript を登録（新設のフィールドを作ってから、そのフィールドに依存する JavaScript を登録する）: ${JSON.stringify(w)}`);
  const jsP = r.js.prepared, chg = (jsP && jsP.changes) || [];
  assert(jsP && jsP.status === 'PREPARED' && !(jsP.blockers || []).length && chg.length === 1 && chg[0].dependsOn.fields.some(f => f.code === 'approval_memo') && !chg[0].deferredDependsOn && (jsP.warnings || []).some(x => x.code === 'CUSTOMIZE_REVISION_ADVANCED') && r.js.execution.status === 'DONE' && r.js.execution.steps[0].status === 'VERIFIED', `H1-4: 実行のときの JavaScript の準備は依存の存在を確かめ（DEPENDENCY_NOT_APPLIED にならない）、設定の書き込みで進んだ revision は内容が同じなので止めない（不具合 B）・登録後の照合も一致: ${JSON.stringify({ blockers: jsP && jsP.blockers, warnings: jsP && jsP.warnings && jsP.warnings.map(x => x.code), st: r.js.execution && r.js.execution.steps.map(s => [s.status, s.reason]) })}`);
  const exSteps = r.exec.execution.steps.map(s => [s.stepId, s.status]);
  assert(JSON.stringify(exSteps) === '[["P1","VERIFIED"],["P2","VERIFIED"],["C1","UNSUPPORTED"]]' && v.approval && !m.msgs().some(x => x.data && ['approval-revoked', 'js-register-skipped'].includes(x.data.kind)), `H1-5: 設定の成否は実行した手順だけで判定する（JavaScript の手順 C1 は数えない。不具合 A）: ${JSON.stringify(exSteps)}`);
  assert(r.cardCount === 1 && /動作テスト環境へ反映しました。/.test(r.card) && /標準設定: ✓ 2 件を反映（反映後の確認で一致）/.test(r.card) && /JavaScript: ＋ memoLock\.js（PC） を登録（反映後の確認 ✓ 1 \/ 1 件一致）/.test(r.card) && !/kt-ai-execution-card|kt-ai-js-execution-card/.test(m.chat()) && m.msgs().filter(x => x.type === 'EXECUTION' || x.type === 'JS_EXECUTION').length === 2 && wsLabel(m) === '反映済み', `H1-6: 結果は 1 枚のカード（標準設定と JavaScript）・右の見出しは「反映済み」: ${r.card.slice(0, 300)}`);
  assert(!/まだ何も反映していません/.test(finalCardText(m)) && /承認済み。/.test(finalCardText(m)) && /反映の結果は下のカード/.test(finalCardText(m)), 'H1-7: 反映の後、最終案のカードに「まだ何も反映していません」を出さない');
  assert(paneSpy.seen.execGo === 0 && paneSpy.seen.jsGo === 0 && m.msgs().filter(x => x.type === 'USER').length === KIT.REQUESTS.length, `H1-8: 同じ最終案で利用者の確認は 1 回（右の「反映」の最終確認・登録の確認の段は一度も出さない。会話で承認を求めない）: ${JSON.stringify(paneSpy.seen)}`);
  assert(/data-act="js-rollback"/.test(r.cardHtml) && !/data-act="rollback"/.test(r.cardHtml) && /JavaScript を先に戻してから設定を戻します/.test(r.card), 'H1-9: 復元の案内は JavaScript を先に（設定の［戻す］は JavaScript を戻した後に出す）');
});
// H2: JavaScript の登録の失敗 → 一部だけ反映（設定は反映・JavaScript は未登録）を明記し、右の見出しは「一部反映（要確認）」。設定は既存の部品で戻せる
await section(async () => {
  const { m, v } = await KIT.mountFinal({ kind: 'mixed' });
  const r = await KIT.applyOnScreen(m, { before: () => { m.mock.ctl.failUpload = 'GENERIC'; } });
  assert(r.run.stage === 'stopped' && r.run.partial === true && r.run.settings.written && !r.run.js.registered && JSON.stringify(r.writes) === '["POST fields","PUT views","POST file"]' && m.mock.st.fields.approval_memo, `H2-1: 設定は反映・JavaScript のアップロードで失敗（PUT はしない）: ${JSON.stringify(r.writes)}`);
  assert(/一部だけ反映しました（要確認）。/.test(r.card) && !/動作テスト環境へ反映しました。/.test(r.card) && /標準設定: ✓ 2 件を反映/.test(r.card) && /JavaScript: 未登録（ファイルのアップロードに失敗しました/.test(r.card) && /次の手: 設定は反映済みです。/.test(r.card) && !/実機（動作テスト環境）での動作はまだ確かめていません/.test(r.card), `H2-2: 結果のカードに一部だけ反映したことを明記（一括で成功したとは書かない）と次の手: ${r.card.slice(0, 400)}`);
  assert(wsLabel(m) === '一部反映（要確認）' && /data-status="partial"/.test(m.$('kt-ai-ws-state').innerHTML) && !v.approval && m.msgs().some(x => x.data?.kind === 'approval-revoked') && !/まだ何も反映していません/.test(finalCardText(m)), `H2-3: 右の見出しは「一部反映（要確認）」・承認は外す・最終案のカードに「まだ何も反映していません」を出さない: ${wsLabel(m)}`);
  //   C-1 後の仕上げの確認（2026-10-09）: 一部だけ反映した後、最終案のカードに承認の欄と押しても進まないボタンを戻さない。取り消しの知らせは結果のカードの次の手に合わせる
  const fct = finalCardText(m);
  const revoked = m.msgs().filter(x => x.data?.kind === 'approval-revoked').map(x => String(x.text || ''));
  assert(!/反映の前の確認（書き込みなし）/.test(fct) && !/押すと、上の内容を承認して/.test(fct) && /この最終案はもう一度反映できません/.test(fct) && !/data-act="final-approve"/.test(m.chat().split('kt-ai-final-written')[0].slice(-4000) + '') && revoked.length > 0 && revoked.every(t => t.includes('次の手は下の結果のカードにまとめています。') && !/もう一度承認してください/.test(t) && !/[、。] /.test(t)), `H2-3b: 一部だけ反映の後は承認の欄とボタンを出さず、取り消しの知らせは結果のカードの次の手に合わせる（余分な空白なし）: ${JSON.stringify({ card: fct.slice(-300), revoked })}`);
  assert(/data-act="rollback"/.test(r.cardHtml) && !/data-act="js-rollback"/.test(r.cardHtml) && m.panel.unrevertedPreviewChange() === true, 'H2-4: JavaScript は登録していないので、設定の［変更前の状態に戻す］だけを出す');
  const exId = r.exec.execution.executionId;
  await clickChat(m, 'rollback', { execution: exId }); await ticks(8);
  assert(m.panel.executorState().stage === 'rollback-confirm' && /id="kt-ai-exec-rollback-go"/.test(m.$('kt-ai-exec').innerHTML), 'H2-5: 結果のカードの［設定を変更前の状態に戻す］→ 既存の復元の確認（現在の設定の照合・書き込みなし）');
  await m.$('kt-ai-pane-exec').dispatch({ type: 'click', target: { id: 'kt-ai-exec-rollback-go' } }); await ticks(12);
  assert(m.panel.executorState().stage === 'rolled-back' && !m.mock.st.fields.approval_memo && !m.mock.st.views['承認待ち一覧'] && wsLabel(m) === '元に戻し済み' && /設定は変更前の状態に戻し済み|（変更前の状態に戻し済み）/.test(stripC(m.chat())) && m.panel.unrevertedPreviewChange() === false, `H2-6: 戻すと設定は変更前の状態に戻り、右の見出しは「元に戻し済み」: ${wsLabel(m)}`);
});
// H3: 新設するフィールドの手順が失敗 → JavaScript は登録しない（依存の確かめを消さない）。JavaScript 単体の準備の照合も残す
await section(async () => {
  const { m, v } = await KIT.mountFinal({ kind: 'mixed' });
  const r = await KIT.applyOnScreen(m, { before: () => { m.mock.ctl.failAddField = 'approval_memo'; } });
  assert(r.run.stage === 'stopped' && !r.run.written && !r.run.js.registered && /設定の手順が途中で止まったため、登録していません/.test(r.card) && /設定の手順が途中で止まりました/.test(r.card) && !r.writes.some(x => /customize|file/.test(x)) && !v.approval, `H3-1: 新設の手順が失敗したら JavaScript は登録しない（承認を外す）: ${JSON.stringify(r.writes)}`);
  //   部品の照合: 設定を反映する前に、新設のフィールドに依存する JavaScript を（承認の欄の準備ではなく）登録の準備にかけると DEPENDENCY_NOT_APPLIED で止まる
  const { m: m2, v: v2 } = await KIT.mountFinal({ kind: 'mixed' });
  await KIT.prepareOnScreen(m2);
  m2.conv().approveFinal({ planId: v2.planId, version: v2.version });
  const pj = await m2.panel.startJsRegister(v2); await ticks(4);
  assert(pj && pj.status === 'BLOCKED' && pj.blockers.some(b => b.code === 'DEPENDENCY_NOT_APPLIED') && !KIT.writesOf(m2).length, `H3-2: 依存の確かめ（DEPENDENCY_NOT_APPLIED）は消していない（承認の欄の準備だけが「設定の反映の後に確かめる」にする）: ${JSON.stringify(pj && pj.blockers.map(b => b.code))}`);
});
// H4: 承認の欄の準備の後に動作テスト環境・JavaScript の設定・候補が変わった → 止めて変わった点をまとめ、承認を外す（何も書き込まない）
await section(async () => {
  // (a) 動作テスト環境の設定（フィールド）が変わった → 基準が変わったので止める（最終案の作り直しへ）
  { const { m, v } = await KIT.mountFinal({ kind: 'mixed' });
    const r = await KIT.applyOnScreen(m, { before: async () => { await m.mock.api.addPreviewFields('341', { other_note: { type: 'SINGLE_LINE_TEXT', code: 'other_note', label: '別の担当者が足したメモ' } }); } });
    assert(r.run.stage === 'stopped' && !r.run.written && JSON.stringify(r.writes) === '["POST fields"]' && !m.mock.st.fields.approval_memo && !v.approval && /何も書き込まずに止めました/.test(r.card) && /変わった点/.test(r.card) && /承認の欄の準備の後に変わりました/.test(r.card) && /同じ依頼をもう一度送ると、最新の設定で最終案を作り直します/.test(r.card), `H4-1: 承認の後（押した直後の確かめ）に動作テスト環境の設定が変わった → 書き込まずに止め、変わった点と次の手を出す（書き込みは別の担当者のフィールドだけ）: ${r.card.slice(0, 400)}`); }
  // (b) JavaScript / CSS の設定が変わった → 設定の手順も書き込まずに止める。設定の内容が変わったので基準の指紋も変わり、最終案は作り直しの扱い（STALE）になる
  { const { m, v } = await KIT.mountFinal({ kind: 'mixed' });
    const r = await KIT.applyOnScreen(m, { before: async () => {
      const cur = await m.mock.api.getPreviewCustomize('341');
      const up = await m.mock.api.uploadFile('manual.js', '// manual', 'text/javascript');
      const keep = (l) => l.map(e => (e.type === 'URL' ? { type: 'URL', url: e.url } : { type: 'FILE', file: { fileKey: e.file.fileKey } }));
      await m.mock.api.putPreviewCustomize('341', { app: 341, scope: cur.scope, desktop: { js: [...keep(cur.desktop.js), { type: 'FILE', file: { fileKey: up } }], css: keep(cur.desktop.css) }, mobile: { js: keep(cur.mobile.js), css: keep(cur.mobile.css) } }, cur.revision);
    } });
    assert(r.run.stage === 'stopped' && !r.run.written && JSON.stringify(r.writes) === '["POST file","PUT customize"]' && !m.mock.st.fields.approval_memo && !v.approval && /JavaScript \/ CSS の一覧または適用範囲が、承認の欄の準備の後に変わりました/.test(r.card) && /動作テスト環境の設定が、承認の欄の準備の後に変わりました/.test(r.card) && /最新の設定で最終案を作り直します/.test(r.card) && m.msgs().some(x => x.data?.kind === 'approval-revoked'), `H4-2: JavaScript の設定が変わった → 標準設定も書き込まずに止め、変わった点（一覧・基準）と作り直しの次の手を出し承認を外す: ${r.card.slice(0, 400)}`);
    assert(v.status === 'STALE' && /仕様確定の後に設定が変更されています/.test(r.card) && KIT.applyButtonOf(m) && KIT.applyButtonOf(m).disabled, `H4-3: 止めた後の最終案は作り直しの扱いで押せない。変わった点に revision の変更（照合 STALE_CUSTOMIZATION の理由）も出す: ${v.status}`);
    const r2 = await KIT.applyOnScreen(m);
    assert(r2.run === r.run && r2.writes.length === 0 && !v.approval, 'H4-4: 押せない状態で押しても承認・書き込みをしない'); }
  // (c) 承認の欄の準備の後に JavaScript の候補が変わった → 承認しない（準備をやり直してから押してもらう）
  { const { m, v } = await KIT.mountFinal({ kind: 'mixed' });
    const r = await KIT.applyOnScreen(m, { before: () => { v.generated.C1 = { ...v.generated.C1, candidateHash: 'f'.repeat(16) }; } });
    assert(!v.approval && r.run === null && r.writes.length === 0 && /最終案の内容（JavaScript の候補・動作テスト環境の設定・却下した手順）が変わりました/.test(stripC(m.chat())) && m.panel.finalPrecheck().notice, `H4-5: 候補が変わった → 承認せず（書き込み 0）、承認の欄に変わったことを出して準備をやり直す: ${m.panel.finalPrecheck().notice}`); }
});
// H5: 準備中・止まる理由があるときは［動作テスト環境へ反映］を押せず、理由を出す
await section(async () => {
  const g = gateMk();
  const { m, v } = await (async () => {
    const gen = KIT.screenGenerate({});
    const mm = mount({ health: KIT.HEALTH_V, planImpl: KIT.planImplOf(KIT.screenPlan('mixed')), generateImpl: gen.impl });
    //   運用環境の一覧の取得（設定の手順の準備 KTPlanExecutor.prepare だけが使う）を止めておき、承認の欄の準備を途中で待たせる
    const o = mm.mock.api.getProductionViews; mm.mock.api.getProductionViews = async (...a) => { await g.p; return o.apply(mm.mock.api, a); };
    await ticks();
    for (const s of KIT.REQUESTS) { await mm.panel.send(s); await ticks(10); }
    await ticks(30);
    return { m: mm, v: mm.conv().activePlan() };
  })();
  const b0 = KIT.applyButtonOf(m);
  assert(v && v.final && v.final.approvable && m.panel.finalPrecheck().status === 'running' && b0 && b0.disabled && /kt-ai-final-status" data-can-apply="0"/.test(m.chat()) && /反映の前の準備をしています/.test(stripC(m.chat())), `H5-1: 準備中は［動作テスト環境へ反映］を押せず、準備中であることを出す: ${JSON.stringify({ st: m.panel.finalPrecheck().status, b0 })}`);
  await clickChat(m, 'final-approve', { plan: v.planId, version: String(v.version) }); await ticks(4);
  assert(!v.approval && KIT.writesOf(m).length === 0 && /反映の前の準備がまだ終わっていません/.test(stripC(m.chat())), 'H5-2: 準備中に押しても承認・書き込みをしない（押せなかったことを承認の欄に出す）');
  g.open(); await KIT.waitUntil(() => m.panel.finalPrecheck().status === 'ready', 60);
  assert(KIT.applyButtonOf(m) && !KIT.applyButtonOf(m).disabled, 'H5-3: 準備が終わると押せる');
  //   止まる理由: 別の担当者が同じフィールドを先に足した → 作業の基準の取り直しで準備をやり直し、理由を出して押せない
  await m.mock.api.addPreviewFields('341', { approval_memo: { type: 'SINGLE_LINE_TEXT', code: 'approval_memo', label: '承認メモ' } });
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { dataset: { act: 'refresh-base' } } });
  await KIT.waitUntil(() => m.panel.finalPrecheck().status === 'blocked', 80); await ticks(2);
  const b1 = KIT.applyButtonOf(m), pre = m.panel.finalPrecheck();
  assert(pre.status === 'blocked' && pre.reasons.length > 0 && b1 && b1.disabled && stripC(m.chat()).includes(pre.reasons[0]) && /反映の前の確認で止まる理由があるため/.test(stripC(m.chat())) && /kt-ai-final-pre-blocked/.test(m.chat()) && KIT.writesOf(m).length === 1, `H5-4: 準備で止まる理由があるときは押せず、理由を出す: ${JSON.stringify(pre.reasons)}`);
});
// H6: KTJsExecutor.prepare の部品: 承認の前の準備（deferDependencies）と、内容の比較（expectedContent。不具合 B の置き換え。照合は消さない）
await section(async () => {
  const { KTJsExecutor } = T;
  const mk = makeKintoneMock(INPUTS.data);
  const ch = (dep) => ({ changeId: 'c1', customizationId: 'C1', strategy: 'NEW_JS_FILE', kind: 'ADD_FILE', target: 'desktop', name: 'memoLock.js', content: '// x', contentHash: T.KTScan.hashText('// x'), bytes: 4, registration: { verdict: 'RUNTIME_UNVERIFIED', blockers: [], confirmations: [], unverified: [], codeHash: T.KTScan.hashText('// x') }, dependsOn: dep });
  const dep = { statuses: [], fields: [{ code: 'approval_memo', label: '承認メモ', stepId: 'P1', title: '承認メモフィールドを追加' }] };
  const p0 = await KTJsExecutor.prepare({ appId: '341', changes: [ch(dep)] }, { api: mk.api });
  const p1 = await KTJsExecutor.prepare({ appId: '341', changes: [ch(dep)], deferDependencies: true }, { api: mk.api });
  const p2 = await KTJsExecutor.prepare({ appId: '341', changes: [ch({ statuses: [], fields: [{ code: 'approval_memo' }] })], deferDependencies: true }, { api: mk.api });
  assert(p0.status === 'BLOCKED' && p0.blockers[0].code === 'DEPENDENCY_NOT_APPLIED' && p1.status === 'PREPARED' && p1.deferred.length === 1 && p1.deferred[0].code === 'DEPENDENCY_AFTER_SETTINGS' && p1.changes[0].status === 'PENDING' && p2.status === 'BLOCKED' && p2.blockers[0].code === 'DEPENDENCY_NOT_APPLIED', `H6-1: 依存の確かめは残し、承認の前の準備だけ「設定の反映の後に確かめる」にする（計画の手順が新設するものに限る）: ${JSON.stringify([p0.blockers, p1.deferred, p2.blockers].map(x => x.map(y => y.code)))}`);
  const cz = await mk.api.getPreviewCustomize('341');
  const fp = KTJsExecutor.contentFingerprint(KTJsExecutor.snapshotOf(cz));
  await mk.api.addPreviewFields('341', { approval_memo: { type: 'SINGLE_LINE_TEXT', code: 'approval_memo', label: '承認メモ' } }, cz.revision);
  const q1 = await KTJsExecutor.prepare({ appId: '341', changes: [ch(dep)], expectedRevision: cz.revision, expectedContent: fp }, { api: mk.api });
  const q0 = await KTJsExecutor.prepare({ appId: '341', changes: [ch(dep)], expectedRevision: cz.revision }, { api: mk.api });
  const cz2 = await mk.api.getPreviewCustomize('341');
  const up = await mk.api.uploadFile('manual.js', '// m', 'text/javascript');
  const keep = (l) => l.map(e => (e.type === 'URL' ? { type: 'URL', url: e.url } : { type: 'FILE', file: { fileKey: e.file.fileKey } }));
  await mk.api.putPreviewCustomize('341', { app: 341, scope: cz2.scope, desktop: { js: [...keep(cz2.desktop.js), { type: 'FILE', file: { fileKey: up } }], css: keep(cz2.desktop.css) }, mobile: { js: keep(cz2.mobile.js), css: keep(cz2.mobile.css) } }, cz2.revision);
  const q2 = await KTJsExecutor.prepare({ appId: '341', changes: [ch(dep)], expectedRevision: cz.revision, expectedContent: fp }, { api: mk.api });
  assert(q1.status === 'PREPARED' && q1.warnings.some(w => w.code === 'CUSTOMIZE_REVISION_ADVANCED') && q0.status === 'BLOCKED' && q0.blockers.some(b => b.code === 'STALE_CUSTOMIZATION') && q2.status === 'BLOCKED' && q2.blockers.some(b => b.code === 'STALE_CUSTOMIZATION' && b.detail && b.detail.content), `H6-2: 設定の書き込みで revision だけが進んだ → 内容が同じなので止めない。内容（JS / CSS の一覧）が変われば STALE_CUSTOMIZATION（照合は残す）。内容の指紋が無い呼び出しは従来どおり revision で止める: ${JSON.stringify([q1.status, q0.status, q2.status])}`);
});

// =========================================================
// §I（C-1 後の仕上げ・2026-10-09・設計 §0e.2〜§0e.4）: 任意の提案は本来の依頼を止めない・通常表示の内部の値・待ち時間の区間の記録
console.log('\n--- §I. 任意の提案（origin suggestion）・通常表示の内部の値・待ち時間の記録 ---');
const SUG_REQ = '経費の申請が承認済みになったら金額を編集できなくしたい';
const SUG_MAIN = '承認済みのレコードでは金額を編集できなくする';
const SUG_NOTIFY = '承認済みになったら申請者に通知する';
/** 任意の提案（通知）を 1 件付ける仮案の台本。「通知も入れて」で user に・「通知はいりません。ほかは採用」で不採用と採用 */
const sugScript = ({ utterance: u }) => {
  const rest = { assumptions: [], approach: { standard: [], js: ['金額の編集不可'] }, cannot: ['明細の行の追加・削除は JavaScript では止められません'] };
  const qTarget = Q('lock.target', '編集できなくする人', '編集できなくする対象は全員ですか？', ['全員', '申請者以外'], '全員', '編集できる人が変わります', false);
  if (u === SUG_REQ) return { reply: '承認済みのレコードでは金額を編集できなくします。通知は入れると便利なので、任意の提案として添えます。', intent: 'propose',
    proposal: { behaviors: [B(SUG_MAIN, 'user'), B(SUG_NOTIFY, 'suggestion')], decisions: [qTarget], ...rest },
    turn: { ops: [], answers: [], requirementOps: [req('add', { target: '金額', condition: '承認済み', behavior: '金額を編集できなくする', sourceQuotes: [SUG_REQ], planRefs: ['B1'] }), req('add', { target: '申請者', condition: '承認済み', behavior: '申請者に通知する', decision: 'proposed', disposition: 'unresolved', sourceQuotes: [], planRefs: ['B2'] })] } };
  if (/通知も入れて/.test(u)) return { reply: '通知も入れます。', intent: 'update', proposal: { behaviors: [B(SUG_MAIN, 'user'), B(SUG_NOTIFY, 'user')], decisions: [qTarget], ...rest }, turn: { ops: [{ id: 'B2', op: 'adopt', quote: '通知も入れて' }], answers: [], requirementOps: [] } };
  if (/通知はいりません/.test(u)) return { reply: '通知は入れずに、ほかは採用します。', intent: 'adopt', proposal: { behaviors: [B(SUG_MAIN, 'user')], decisions: [], ...rest }, turn: { ops: [{ id: 'B2', op: 'reject', quote: '通知はいりません' }, { id: 'B1', op: 'adopt', quote: 'ほかは採用' }], answers: [], requirementOps: [] } };
  return null;
};
// I1: 「採用します」だけでは任意の提案は計画に入らない（依頼文・要件・最終案）。カードと右のペインは本体と分ける・断る例文を出さない・回答必須の質問にしない
await section(async () => {
  const x = makeConv({ planImpl: planOk, scriptFn: sugScript });
  const { c, calls } = x;
  const v0 = KTAiClient.validateProposal({ ok: true, contractVersion: '2.1', meta: META, ...sugScript({ utterance: SUG_REQ }) });
  assert(v0.ok && v0.normalized.proposal.behaviors.map(b => b.origin).join(',') === 'user,suggestion' && KTAiClient.validateProposal({ ok: true, contractVersion: '2.1', meta: META, reply: 'r', intent: 'propose', proposal: { behaviors: [{ text: 'x', origin: 'other' }] }, turn: {} }).normalized.proposal.behaviors[0].origin === 'ai', 'I1-1: validateProposal は origin suggestion を残す（語彙外は ai）');
  await c.send(SUG_REQ);
  const d = c.draft();
  const card = KTAiChatUi.messageHtml(c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], { draft: d, draftDecisions: c.draftDecisions() });
  const mainPart = card.split('任意の提案（入れるときは伝えてください）')[0];
  const pane = KTAiChatUi.draftSummaryHtml(d, { decisions: c.draftDecisions() });
  //   2026-10-14 の設計し直し: 会話の仮案のカードは AI の返答と選択だけ（本体の動作も任意の提案も右の仮案の詳細: I1-3）
  assert(!/任意の提案（入れるときは伝えてください）/.test(card) && !card.includes(SUG_NOTIFY) && !card.includes(SUG_MAIN) && !mainPart.includes(SUG_NOTIFY) && /承認済みのレコードでは金額を編集できなくします。/.test(card) && !/通知は不要/.test(card) && /data-act="draft-adopt"/.test(card), `I1-2: 仮案のカードは AI の返答と選択だけ（任意の提案の一覧は出さない）・不要な提案を断る例文を出さない: ${stripC(card).slice(0, 400)}`);
  assert(/任意の提案（入れるときは伝えてください）/.test(pane) && !pane.split('任意の提案（入れるときは伝えてください）')[0].includes(SUG_NOTIFY), 'I1-3: 右のペインの仮案の詳細も任意の提案を本体と分ける');
  const tP = c.metrics().timings.slice(-1)[0];
  const userMsg = c.messages().filter(m => m.type === 'USER').slice(-1)[0];
  assert(tP.intent === 'PROPOSE' && tP.userMsgId === userMsg.id && tP.draftRev === 1 && Number.isFinite(tP.draftMs) && tP.draftMs >= tP.firstTextMs, `I1-4: 区間の記録: 送信と発言の対応（userMsgId）・仮案がそろった時間と版（draftMs・draftRev）: ${JSON.stringify({ u: tP.userMsgId, id: userMsg.id, draftMs: tP.draftMs, draftRev: tP.draftRev, first: tP.firstTextMs })}`);
  const r = await c.send('採用します');
  const p0 = calls.plan[0], v = c.activePlan();
  assert(r.intent === 'ADOPT_DRAFT' && calls.propose.length === 1 && p0 && !/通知/.test(p0.goal) && p0.goal.includes(SUG_MAIN), `I1-5: 「採用します」だけで任意の提案は計画の依頼文に入らない（AI を呼ばずに採用）: ${p0 && p0.goal}`);
  assert(p0.requirements.some(q => /金額を編集できなくする/.test(q.behavior)) && !p0.requirements.some(q => /申請者に通知/.test(q.behavior)), `I1-6: 任意の提案だけに結び付く AI の提案の要件は計画の AI に渡さない（利用者の要件は渡す）: ${JSON.stringify(p0.requirements.map(q => [q.behavior, q.decision]))}`);
  assert(v && v.final && !JSON.stringify(v.final).includes('申請者に通知') && !(v.final.changed.rejected || []).length, `I1-7: 最終案に任意の提案は出ない（担当が無い要件・外した点のどちらにも）: ${JSON.stringify(v && v.final && { changed: v.final.changed, cannot: v.final.cannot })}`);
  const tA = c.metrics().timings.slice(-1)[0];
  assert(tA.intent === 'ADOPT_DRAFT' && tA.draftMs === null && tA.userMsgId === c.messages().filter(m => m.type === 'USER').slice(-1)[0].id, 'I1-8: 採用の送信は仮案の時間（draftMs）を持たない（区間を混ぜない）');
});
// I2: 入れると言った提案は入る（仮案の AI が user にする。既存の自然文の返事の処理）。Gateway が suggestion を出さない接続先には ai として送る
await section(async () => {
  const x = makeConv({ planImpl: planOk, scriptFn: sugScript, features: ['requirements', 'brief', 'stream', 'proposal', 'suggestion'] });
  const { c, calls } = x;
  await c.send(SUG_REQ);
  await c.send('通知も入れて');
  assert(calls.propose[1].previous.behaviors[1].origin === 'suggestion' && c.draft().items.behaviors.every(b => b.origin === 'user'), `I2-1: health に suggestion がある接続先には前回の仮案の任意の提案をそのまま送る・入れると言えば user: ${JSON.stringify(calls.propose[1].previous.behaviors)}`);
  await c.send('採用します');
  assert(calls.plan[0] && calls.plan[0].goal.includes(SUG_NOTIFY), `I2-2: 入れると言った提案は計画の依頼文に入る: ${calls.plan[0] && calls.plan[0].goal}`);
  const y = makeConv({ planImpl: planOk, scriptFn: sugScript });
  await y.c.send(SUG_REQ);
  await y.c.send('通知も入れて');
  assert(y.calls.propose[1].previous.behaviors[1].origin === 'ai', 'I2-3: health に suggestion が無い接続先には ai として送る（語彙外で 422 にしない）');
});
// I3: 任意の提案を断ったとき、最終案の「仮案から変わった点」に「外した」と出さない
await section(async () => {
  const x = makeConv({ planImpl: planOk, scriptFn: sugScript });
  const { c, calls } = x;
  await c.send(SUG_REQ);
  const r = await c.send('通知はいりません。ほかは採用');
  const v = c.activePlan();
  assert(r.intent === 'DRAFT_REPLY' && c.draft().status === 'adopted' && calls.plan.length === 1 && !/通知/.test(calls.plan[0].goal) && v.final && !(v.final.changed.rejected || []).length, `I3-1: 入れなかった提案は「外した」に出さない: ${JSON.stringify(v && v.final && v.final.changed)}`);
  const html = KTAiChatUi.messageHtml(c.messages().filter(m => m.type === 'FINAL').slice(-1)[0], { plans: new Map(c.planHistory().map(p => [`${p.planId}:${p.version}`, p])), activePlan: v });
  assert(!/外した: /.test(html), 'I3-2: 最終案のカードにも「外した」は出ない');
});
// I4: 生成の呼び出しの AI の値・修復の回数と修復の分の token・生成工程の時間（meta.timing）を記録し、費用の見積もりに修復の分を足す
await section(async () => {
  const TM = { version: '1', totalMs: 41000, ai: { count: 3, ms: 39000, repairs: 2 }, calls: [{ kind: 'generate', attempt: 0, ms: 20000, ok: true, inputTokens: 5000, outputTokens: 800 }, { kind: 'repair', attempt: 1, ms: 9000, ok: true, inputTokens: 6000, outputTokens: 900 }, { kind: 'repair', attempt: 2, ms: 10000, ok: false, inputTokens: 6500, outputTokens: 950 }], behavior: { ms: 1200, runs: 2, calls: 6 } };
  const vg = KTAiClient.validateGenerated({ ok: true, contractVersion: '2.1', meta: { ai: { model: 'g', usage: { input_tokens: 5000, output_tokens: 800 } }, aiRepair: { model: 'g', usage: { input_tokens: 6500, output_tokens: 950 } }, timing: { ...TM, calls: [...TM.calls, { kind: 'bogus', ms: -1, ok: 'x', inputTokens: 'n' }] } }, generated: { strategy: 'NEW_JS_FILE', targetFile: 'a.js', code: 'x' } }, null);
  const nt = vg.normalized && vg.normalized.timing;
  assert(vg.ok && vg.normalized.aiRepair && vg.normalized.aiRepair.usage.output_tokens === 950 && nt && nt.totalMs === 41000 && nt.ai.repairs === 2 && nt.calls.length === 4 && nt.calls[3].kind === 'generate' && nt.calls[3].ms === null && nt.calls[3].inputTokens === null && nt.behavior.runs === 2, `I4-1: validateGenerated は aiRepair と生成工程の時間を落とさない（数値・種類だけに整える）: ${JSON.stringify(nt)}`);
  const vOld = KTAiClient.validateGenerated({ ok: true, contractVersion: '2.1', generated: { strategy: 'NEW_JS_FILE', targetFile: 'a.js', code: 'x' } }, null);
  assert(vOld.ok && vOld.normalized.timing === null && vOld.normalized.aiRepair === null, 'I4-2: 古い Gateway（timing・aiRepair 無し）は null');
  const { generationEstimate } = KTAiConversation;
  const eAll = generationEstimate({ generated: { ai: { usage: { input_tokens: 5000, output_tokens: 800 } }, timing: TM } });
  const eLast = generationEstimate({ generated: { ai: { usage: { input_tokens: 5000, output_tokens: 800 } }, aiRepair: { usage: { input_tokens: 6500, output_tokens: 950 } }, verification: { repairs: { count: 2 } } } });
  const eNone = generationEstimate({ generated: { ai: { usage: { input_tokens: 5000, output_tokens: 800 } } } });
  assert(eAll.input === 17500 && eAll.output === 2650 && eAll.repairs.count === 2 && eAll.repairs.measured === 'all' && eAll.costUsd === 0.0615 && eLast.input === 11500 && eLast.repairs.measured === 'last' && eLast.repairs.count === 2 && eNone.input === 5000 && !eNone.repairs, `I4-3: 生成の費用の見積もりに修復の分を足す（timing があれば全回・無ければ最後の修復の分だけ）: ${JSON.stringify({ eAll, eLast, eNone })}`);
  const base = makeGenerate({ sequence: ['good'] });
  const gen = { calls: base.calls, impl: async (args) => { const r = await base.impl(args); return { ...r, generated: { ...r.generated, ai: { model: 'g', latencyMs: 20000, usage: { input_tokens: 5000, output_tokens: 800 } }, aiRepair: { model: 'g', usage: { input_tokens: 6500, output_tokens: 950 } }, timing: TM } }; } };
  const x = makeConvC({ generate: gen });
  await adoptC(x);
  const v = x.c.activePlan();
  const tm = x.c.metrics().timings.slice(-1)[0];
  const g = tm.calls.find(k => k.kind === 'generate');
  assert(g && g.ai && g.ai.model === 'g' && g.ai.inputTokens === 5000 && g.ai.latencyMs === 20000 && g.repairs === 2 && g.repairTokens.input === 12500 && g.repairTokens.output === 1850 && g.repairTokens.measured === 'all' && g.gatewayTiming && g.gatewayTiming.behavior.ms === 1200 && g.genEstimate.input === 17500, `I4-4: 生成の呼び出しの記録に AI の値・修復の回数と token・生成工程の時間: ${JSON.stringify(g && { ai: g.ai, repairs: g.repairs, rt: g.repairTokens, est: g.genEstimate })}`);
  assert(v.final.usage.repairs === 2 && v.final.usage.repairTokens.input === 12500 && v.final.timing.calls.find(k => k.kind === 'generate').repairs === 2 && /うち修復 入力 12500/.test(finalHtml(x)), `I4-5: 最終案の使用量と時間の内訳に修復の分: ${JSON.stringify({ usage: v.final.usage, calls: v.final.timing.calls })}`);
});
// I5: 計画の自動の差分更新は kind 'plan-auto'（最終案の時間の内訳も planAutoMs で分ける）。再生成の理由は changedSince.reasons
await section(async () => {
  const y = makeConvC({ planImpl: (args) => planJs(args, { cust: custOf(null), gatewayPlan: { plan: true } }) });
  await adoptC(y);
  const t = y.c.metrics().timings.slice(-1)[0];
  const vy = y.c.activePlan();
  assert(t.calls.map(k => k.kind).join(',') === 'plan,plan-auto' && vy.final.timing.planAutoMs != null && vy.final.timing.planMs != null && vy.final.timing.calls.some(k => k.kind === 'plan-auto'), `I5-1: 自動の差分更新は plan-auto: ${JSON.stringify({ calls: t.calls.map(k => k.kind), timing: vy.final.timing })}`);
  const CUST_V2 = custOf(['lock'], {});
  CUST_V2.fields[1].condition = 'ステータス in ("承認待ち", "承認済み")';
  const z = makeConvC({ planImpl: (args) => planJs(args, { cust: args.revision ? CUST_V2 : CUST_C1 }) });
  await adoptC(z);
  await z.c.send('承認済みでも金額は編集不可にして');
  const vz = z.c.activePlan();
  assert(vz.version === 2 && vz.final.changedSince && vz.final.changedSince.regenerated.includes('C1') && JSON.stringify(vz.final.changedSince.reasons) === JSON.stringify([{ customizationId: 'C1', reason: 'customization' }]), `I5-2: 再生成の理由（実装仕様が変わった）を changedSince.reasons に: ${JSON.stringify(vz.final.changedSince)}`);
  const w = makeConvC({ planImpl: (args) => planJs(args) });
  await adoptC(w);
  await w.c.send('一覧の名前は承認待ちにして');
  const vw = w.c.activePlan();
  assert(vw.version === 2 && vw.generated.C1.reused === true && Array.isArray(vw.final.changedSince.reasons) && vw.final.changedSince.reasons.length === 0, `I5-3: 流用したときは理由を持たない: ${JSON.stringify(vw.final.changedSince)}`);
});
// I6: 通常表示の内部の値（§0e.3）: 右のペインの変更内容は作業者（USER:…）・条件式・フィールドのコードを画面の言葉に（構造化した値と既存の変換）。固定の文の英語の語を言い換える
await section(async () => {
  const st = mkStep('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認待ち', { name: '部長承認待ち', assignees: ['USER:user.approver'] }, { title: '部長承認待ちを追加' });
  const ac = mkStep('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長承認へ', { name: '部長承認へ', from: '申請中', to: '部長承認待ち', filterCond: 'amount >= "1000000"' }, { title: '部長承認へ進むアクション' });
  const plan = { goal: 'g', assessment: { summary: '金額（amount）が大きいときだけ部長が承認します。' }, steps: [st, ac], customizations: [], impact: [{ description: 'amount を条件に使う既存の通知に影響します' }], unknowns: [] };
  const review = { steps: [
    { stepId: 'P1', diff: { before: null, after: { name: '部長承認待ち', assignees: [{ type: 'USER', code: 'user.approver' }] }, human: ['＋ ステータス「部長承認待ち」（作業者: USER:user.approver・1 人）'] } },
    { stepId: 'P2', diff: { before: null, after: { name: '部長承認へ', from: ['申請中'], to: '部長承認待ち', filterCond: 'amount >= "1000000"' }, human: ['＋ アクション「部長承認へ」: 申請中 → 部長承認待ち [amount >= "1000000"]'] } },
  ] };
  //   2026-10-15（最終案の重複と担当未定の食い違い §2）: 条件式は文に（数値のフィールドの種類と単位があれば「100万円以上」）。実行される元の式は詳細（条件式（実行される式））にだけ残す
  const html = KTAiChatUi.changeSummaryHtml({ goal: 'g', plan, review }, { labels: { amount: '金額' }, numbers: { amount: { type: 'NUMBER', unit: '円', unitPosition: 'AFTER' } } });
  const outside = String(html).replace(/<details[\s\S]*?<\/details>/g, '');
  const txt = stripC(outside).replace(/&gt;/g, '>').replace(/&lt;/g, '<');
  const raw = stripC((String(html).match(/<details class="kt-ai-tech kt-ai-sum-cond"[\s\S]*?<\/details>/) || [''])[0]).replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"');
  const plainHtml = KTAiChatUi.changeSummaryHtml({ goal: 'g', plan, review }, { labels: { amount: '金額' } });
  assert(txt.includes('作業者: ユーザー（user.approver）') && txt.includes('（条件: 「金額」が100万円以上）') && txt.includes('「金額」を条件に使う既存の通知') && txt.includes('金額が大きいときだけ') && !/USER:|\bamount\b/.test(txt) && raw.includes('変更後: amount >= "1000000"') && stripC(plainHtml).includes('（条件: 「金額」が「1000000」以上）'), `I6-1: 変更内容の作業者・条件式・影響の行・要約のフィールドのコードを画面の言葉に（元の式は詳細だけ。数値の種類が分からなければ値はそのまま）: ${txt.replace(/\s+/g, ' ').slice(0, 500)} ／ ${raw}`);
  assert(KTContext.entityJaText({ type: 'GROUP', code: 'sales' }) === 'グループ（sales）' && KTContext.entityJaText({ type: 'FIELD_ENTITY', code: 'owner' }, { owner: '担当者' }) === 'フィールド「担当者」' && KTContext.entityJaText({ type: 'CREATOR' }) === '作成者', 'I6-2: 作業者・通知先の表記（KTContext.entityJaText）');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'kintoneAppToolkit.user.js'), 'utf8');
  assert(!src.includes('（kintone の JavaScript の disabled はセルにだけ効き') && !src.includes('（disabled はセルの編集だけに効き') && !/処理（handler）の直下/.test(src) && !/step を 1 回の更新にまとめます/.test(src) && !/snapshot として保持します/.test(src), 'I6-3: 固定の文の英語の語（disabled・handler・step・snapshot）を言い換えた');
});

console.log(`\n${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
