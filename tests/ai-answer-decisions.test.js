// 会話の応答性（2026-10-05）: 確認事項への短い回答と、決定事項の引き継ぎ（KTAiAnswers・会話コントローラの ANSWER）
//
// 検証内容（状態遷移。AI の振る舞いは固定した会話ケースで別に評価する）:
//   A 解釈: 「PCだけ」「部長です」「保存時です」を対応する確認事項への回答にする / 複数の回答 / 対応先が決まらない回答は確定しない /
//          修正の依頼・質問・計画の語に触れる文は回答にしない / 回答済みの言い直しと変更の区別
//   B 台帳: 版が変わっても決定事項を引き継ぐ / 言い換えた再質問を出さない（記録する）/ 一部の論点だけ答えた質問は未回答 /
//          AI の再確認（decisionRef）だけ理由つきで出す / 回答の変更は履歴に残す / AI の仮定は決定事項にしない
//   C 会話: 受領の表示が計画の完成より先（AI 呼び出しは増えない）/ 決定事項を Planner に送る（Q 番号を使わない）/ 前の回答を保つ /
//          「やっぱりモバイルも必要」で更新 / 対応先の確認では AI を呼ばない / 失敗・キャンセル・遅れた応答 / 生成にも決定事項 / 計測
//   D Context: Planner は revision と一緒にだけ・Generator は回答済みだけ / validatePlan は回答済みの PC / モバイルで platform を空にしない
//
//   C-1 第 3 段（2026-10-08）: 会話の節は新しい流れ（依頼 → 仮案 → 採用 → 計画 → 最終案）の上で確かめる。最初の計画は仮案の採用で作り（startPlan）、
//          確認事項への回答は最終案の確認事項への回答（ANSWER）として試す。置き換えた古い確認の流れ（質問カード・対応先を聞き返すカード answer-target・
//          仕様の確定・従来の生成）を前提にした期待は外し、対応する新しい流れの回帰（tests/ai-flow-redesign.test.js の F4・F7 など）を各節に書いた
//
// 実行方法: node tests/ai-answer-decisions.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTDeps, KTContext, KTAiClient, KTAiConversation, KTAiAnswers, KTPlanReview, KTAiChatUi } = T;
// 新しい流れの共有の部品（仮案の応答の正規化・生成工程の能力の印）
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');

const DATA = FX.makeData();
const DEPS = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
const step = (id, actionType, targetKind, targetRef, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' }, ...extra });
const qs = (...texts) => texts.map((t, i) => (typeof t === 'string' ? { id: `Q${i + 1}`, question: t, reason: '', relatedEvidenceIds: [] } : { id: `Q${i + 1}`, reason: '', relatedEvidenceIds: [], ...t }));
const planWith = (questions, extra = {}) => ({ goal: '金額が大きい案件に注意を出したい', solution: 'STANDARD', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: ['AI の推測: 対象は PC だけだろう'] }, relevantFields: [], proposedFields: [], steps: [step('P1', 'ADD_VIEW', 'VIEW', '高額案件', { name: '高額案件', fields: ['amount'] })], alternatives: [], impact: [], questions, unknowns: ['承認者は未定'], planConfidence: 'NEEDS_CONFIRMATION', customizations: [], ...extra });
const QP = '対象は PC だけですか？モバイルでも使いますか？';
const QS = '金額が大きいとき、保存を止めますか？';
const QA = '承認者は誰にしますか？';
const QT = 'チェックはいつ行いますか？';
const QP2 = 'スマートフォンからの入力も対象に含めますか？';   // 同じ論点（PC / モバイル）の言い換え
const isRequest = (c) => /ではなく|じゃなく|にして|使って|いらない|不要|やめ|外して/.test(c);

/** 最初の依頼の文（仮案の依頼）。採用すると計画の AI が plans の 1 つめを返す */
const GOAL0 = '金額が大きい案件に注意を出したい';
/** 仮案の台本: 依頼の文を実現する動作にした仮案（判断・要件は無い。採用まで 1 往復） */
const draftRaw = (u) => ({ reply: `「${u}」を実現する変更案にできます。`, intent: 'propose', proposal: { behaviors: [{ text: u, origin: 'user' }], assumptions: [], decisions: [], approach: { standard: ['一覧の追加'], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } });
/** C-1 第 3 段: 依頼 → 仮案 →「これで進めて」で採用 → 最初の計画（以前は依頼の文から直接、計画を作っていた） */
const startPlan = async (c) => { await c.send(GOAL0); return c.send('これで進めて'); };
/**
 * 会話コントローラ（fake services）。plans: 呼ばれた順に返す計画（足りなければ最後）。gate を開くまで応答を待たせられる。
 * clock は services.plan が 60 秒進める（受領の表示までの時間と、計画の完成までの時間を分けて測れる）
 *   C-1 第 3 段: 仮案の能力（conversationFeatures の proposal・services.propose）と、生成工程の能力の印（generatorFeatures）を持つ接続先
 */
function makeConv(plans, { fail = null, review = true } = {}) {
  const calls = { plan: [], generate: [], propose: [], ask: [] };
  let t = 1000;
  let gate = null;
  const ctl = {
    hold() { let open; const p = new Promise(r => { open = r; }); gate = { p, open }; return () => { gate = null; open(); }; },
    fail,
  };
  const services = {
    conversationFeatures: () => ['requirements', 'stream', 'proposal', 'itemIds'],
    generatorFeatures: () => ['requirementId', ...K.GEN_EFFECT_FEATURES, ...K.GEN_CURRENT_FEATURES],
    async propose(args) { calls.propose.push({ utterance: args.utterance }); return { ok: true, proposal: K.normalized(draftRaw(args.utterance), `pp-${calls.propose.length}`, null, args), ctx: { facts: [] } }; },
    async plan(args) {
      calls.plan.push({ goal: args.goal, revision: args.revision ? JSON.parse(JSON.stringify({ ...args.revision, previousPlan: null })) : null, decisions: JSON.parse(JSON.stringify(args.decisions || null)), ackAtCall: c ? c.messages().filter(m => m.data?.kind === 'answers-ack').length : 0, aiCallsAtCall: c && typeof c.metrics === "function" ? c.metrics().aiCalls : null });
      if (gate) await gate.p;
      t += 60000;
      if (args.signal && args.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      if (ctl.fail) { const f = ctl.fail; ctl.fail = null; const e = new Error(f); e.code = f; throw e; }
      const p = JSON.parse(JSON.stringify(plans[Math.min(calls.plan.length - 1, plans.length - 1)]));
      return { plan: p, ctx: null, review: review ? KTPlanReview.review({ plan: p, data: DATA, deps: DEPS, scan: null, incoming: null }) : null, decisionsMeta: args.decisions && args.decisions.length ? { version: '1', received: args.decisions.length } : null };
    },
    async generate(args) { calls.generate.push({ customizationId: args.customizationId, decisions: JSON.parse(JSON.stringify(args.decisions)) }); return { ok: true, generated: { code: '// x' }, review: { status: 'PASS', coverage: { notAchieved: [] } } }; },
    // H: 質問の AI に渡した会話の文脈（conversationContext の写し）を残す
    async ask(args) { calls.ask.push({ question: args.question, conversation: JSON.parse(JSON.stringify(args.conversation || null)) }); return { ok: true, answer: { answer: 'A', facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx: { facts: [] } }; },
    async explain() { return { answer: 'E', facts: [], analysis: [], recommendations: [], unknowns: [] }; },
    readiness(v) { return { approved: 0, executable: 0, unsupported: 0, blocked: 0, undecided: v.plan.steps.length }; },
  };
  const c = KTAiConversation.create({ services, now: () => '2026-10-05T00:00:00.000Z', clock: () => t });
  return { c, calls, ctl, last: () => c.messages()[c.messages().length - 1], kinds: () => c.messages().map(m => m.data?.kind || m.type) };
}
const open = (c) => c.answerContext().open.map(q => q.text);
const answered = (c) => c.ledger().filter(e => e.status === 'answered');
const tick = () => new Promise(r => setTimeout(r, 0));
/** C-1 第 3 段: 今の版の最終案のカード（会話の最後の FINAL）の HTML。最終案が無ければ null */
const finalCard = (c) => { const m = [...c.messages()].reverse().find(x => x.type === 'FINAL'); return m ? KTAiChatUi.messageHtml(m, { plans: new Map(c.planHistory().map(v => [`${v.planId}:${v.version}`, v])), activePlan: c.activePlan(), answerState: c.answerContext(), ledger: c.ledger(), answers: new Map() }) : null; };
/** 今の版の最終案に出る確認事項の文（質問カードの代わり）。最終案が無ければ null */
const finalQuestionsText = (c) => { const v = c.activePlan(); return v && v.final ? (v.final.questions || []).map(q => q.text).join(' / ') : null; };

(async () => {
/** 節ごとに実行する（修正前の版で RED を確かめるとき、無い関数の例外で残りの節を止めない） */async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.message}`); } }
// =========================================================
console.log('\n--- A. 回答の解釈（KTAiAnswers.interpret・決定的） ---');
await section(async () => {
  const Q = (key, text) => ({ key, text, topics: KTAiAnswers.questionTopics({ text }) });
  const O = [Q('Q1', QP), Q('Q2', QS), Q('Q3', QA), Q('Q4', QT)];
  const it = (text, open = O, decided = []) => KTAiAnswers.interpret({ text, open, decided, isRequest });
  assert(KTAiAnswers.questionTopics({ text: QP }).join() === 'platform' && KTAiAnswers.questionTopics({ text: QP2 }).join() === 'platform' && KTAiAnswers.questionTopics({ text: QS }).join() === 'save_block' && KTAiAnswers.questionTopics({ text: QA }).join() === 'approver' && KTAiAnswers.questionTopics({ text: QT }).join() === 'timing', '論点: PC / モバイル（言い換えも同じ）・保存を止めるか・承認者・タイミング');
  const a1 = it('PCだけ');
  assert(a1.kind === 'answers' && a1.answers.length === 1 && a1.answers[0].key === 'Q1' && a1.answers[0].clause === 'PCだけ', `「PCだけ」は PC / モバイルの質問への回答: ${JSON.stringify(a1)}`);
  assert(it('部長です').answers[0]?.key === 'Q3' && it('保存時です').answers[0]?.key === 'Q4', '「部長です」は承認者、「保存時です」はタイミング（「保存」の語でも保存を止めるかの質問にはしない）');
  const m = it('PCだけ。保存は止めない');
  assert(m.kind === 'answers' && m.answers.map(x => `${x.key}:${x.clause}`).join() === 'Q1:PCだけ,Q2:保存は止めない', `複数の回答（文で分ける）: ${JSON.stringify(m.answers)}`);
  const m2 = it('PCだけ、保存は止めない');
  assert(m2.answers.map(x => x.key).join() === 'Q1,Q2', '読点で論点の違う部分を並べても、それぞれの回答');
  const x = it('PCだけ。保存は止めない', [Q('Q1', QP)]);
  assert(x.kind === 'answers' && x.answers.length === 1 && x.extras.length === 1 && x.extras[0].clause === '保存は止めない', '質問の無い論点の文は「追加の条件」（捨てない・別の質問に当てない）');
  const u = it('はい', [Q('Q2', QS), Q('Q5', '承認の設定も必要ですか？')]);
  assert(u.kind === 'unclear' && u.answers.length === 0 && u.unresolved.length === 1 && u.unresolved[0].candidates.join() === 'Q2,Q5', `対応先が 2 つある「はい」は確定しない（候補を返す）: ${JSON.stringify(u)}`);
  const u2 = it('PCだけ', [Q('Q1', QP), Q('Q6', 'モバイルでは一覧にも表示しますか？')]);
  assert(u2.kind === 'unclear' && u2.unresolved[0].candidates.length === 2, '同じ論点の質問が 2 つあれば、どちらへの回答か確定しない');
  const one = it('はい', [Q('Q2', QS)]);
  assert(one.kind === 'answers' && one.answers[0].key === 'Q2', '未回答が 1 つなら「はい」はその質問への回答');
  assert(it('更新状況は3段階ではなく5段階にして').kind === 'none' && it('PCだけですか？').kind === 'none' && it('ありがとう').kind === 'none', '修正の依頼（言い方）・質問・挨拶は回答にしない（従来の経路へ）');
  const dec = [{ id: 'd1', topics: ['platform'], answer: 'PCだけ' }];
  assert(it('PCだけ', [], dec).kind === 'restated' && it('やっぱりモバイルも必要', [], dec).kind === 'answers' && it('やっぱりモバイルも必要', [], dec).updates[0].decisionId === 'd1', '決定済みの論点: 同じ答えは「記録済み」、変更の言い方（やっぱり・も必要）は決定事項の更新');
  assert(it('PCの画面で金額を赤くして', [], dec).kind === 'none', '決定済みの論点に触れるだけの依頼（変更の言い方でない）は回答の変更にしない');
  assert(KTAiAnswers.platformValueOf('PCだけ').join() === 'desktop' && KTAiAnswers.platformValueOf('スマホだけ').join() === 'mobile' && KTAiAnswers.platformValueOf('やっぱりモバイルも必要').join() === 'desktop,mobile' && KTAiAnswers.platformValueOf('モバイルは不要').join() === 'desktop' && KTAiAnswers.platformValueOf('部長です') === null, 'PC / モバイルの値は言い切れるときだけ（決められなければ null。推測で補わない）');
  // classifyIntent: 確認事項がある計画への短い答えは ANSWER。確認事項が無ければ従来どおり
  const v = { planId: 'p', version: 1, status: 'ACTIVE', plan: planWith(qs(QP, QS)), review: { steps: [] } };
  const st = { activePlan: v, ledgers: new Map() };
  const cls = (t, s = st) => KTAiConversation.classifyIntent(t, s);
  assert(cls('PCだけ').intent === 'ANSWER' && cls('PCだけ').reason === 'ANSWERS' && cls('いいえ').reason === 'ANSWER_TARGET_UNCLEAR', 'classifyIntent: 「PCだけ」は ANSWER（AMBIGUOUS にしない）・対応先が決まらない「いいえ」も ANSWER（対応先を聞く）');
  const stA = { activePlan: { ...v, plan: planWith(qs(QP, QA)) }, ledgers: new Map() };
  assert(cls('はい').intent === 'REQUEST_PREVIEW' && cls('これで進めて').intent === 'REQUEST_PREVIEW' && cls('部長でお願いします', stA).intent === 'ANSWER' && cls('部長でお願いします').intent === 'ANSWER', '進める言葉（「はい」「これで進めて」）は確認事項があっても回答にしない（承認・反映の意図を取り違えない）。文末の「お願いします」だけでは進める言葉にしない（承認者の質問が無ければ「部長」は追加の条件）');
  assert(cls('更新状況は3段階ではなく5段階にして').intent === 'REVISE_PLAN' && cls('これで進めたい').intent === 'REQUEST_PREVIEW' && cls('P1って何してる？').intent === 'EXPLAIN_PLAN' && cls('このフィールドは何に使ってる？').intent === 'ASK', '従来の判定は変えない（修正の依頼・進める・説明・質問）');
  const noQ = { activePlan: { ...v, plan: planWith([]) }, ledgers: new Map() };
  assert(cls('PCだけ', noQ).intent !== 'ANSWER', '確認事項も決定事項も無い計画への短い文は回答にしない（短い文をすべて計画の修正・回答へ押し込まない）');
});

// =========================================================
console.log('\n--- B. 台帳（版をまたぐ決定事項・再質問・再確認・履歴） ---');
await section(async () => {
  const lg = KTAiAnswers.createLedger('p');
  const s1 = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs(QP, QS, QA))), { version: 1 });
  assert(s1.open.length === 3 && s1.reasked.length === 0 && lg.entries.every(e => e.status === 'open'), 'v1: 確認事項 3 件はどれも未回答（計画の前提・AI の推測は決定事項にしない）');
  const qp = s1.open.find(q => q.text === QP);
  KTAiAnswers.recordAnswer(lg, { entryId: qp.entryId, topics: qp.topics, answer: 'PCだけ', source: 'chat', question: QP, version: 1, at: 't1' });
  const s2 = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs(QS, QP2, QA))), { version: 2 });
  assert(s2.open.map(q => q.text).join('|') === `${QS}|${QA}` && s2.reasked.length === 1 && s2.reasked[0].text === QP2, `v2: 番号が振り直され言い換えた PC / モバイルの質問は出さない（再質問として記録）: ${JSON.stringify(s2.reasked)}`);
  const s2b = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs({ question: 'このデバイスで使いますか', topic: 'device' }))), { version: 3 });
  assert(s2b.reasked.length === 1, 'AI が付けた topic（device）も語彙の論点（platform）にそろえて照合する');
  const both = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs('モバイルでは表示する場所をどこにしますか？'))), { version: 4 });
  assert(both.open.length === 1 && both.reasked.length === 0, '一部の論点（PC / モバイル）だけ答えた質問（表示する場所も聞く）は未回答のまま出す');
  const re = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs({ question: 'モバイルの入力欄にも同じ注意が必要になりますが、PCだけでよいですか？', decisionRef: 'D1', reason: '依頼に「外出先でも」とあり、PCだけの回答と合わない' }))), { version: 5 });
  const d1 = lg.entries.find(e => e.answer === 'PCだけ');
  assert(re.open.length === 1 && re.open[0].reconfirm === true && d1.status === 'reconfirm' && /外出先/.test(d1.reconfirmReason), 'AI が決定事項（D1）を理由つきで再確認したときだけ質問に出す（決定事項は「再確認」）');
  KTAiAnswers.recordAnswer(lg, { entryId: d1.id, topics: ['platform'], answer: 'やっぱりモバイルも必要', source: 'chat', version: 5, at: 't2' });
  const ds = KTAiAnswers.decisionsForContext(lg);
  const dp = ds.find(d => d.topic === 'platform');
  assert(dp && dp.answer === 'やっぱりモバイルも必要' && dp.previousAnswer === 'PCだけ' && dp.value.join() === 'desktop,mobile' && dp.status === 'answered' && d1.history.length === 1 && d1.history[0].answer === 'PCだけ', `回答の変更: 新しい回答が正・前の回答は履歴（previousAnswer）: ${JSON.stringify(dp)}`);
  assert(ds.every(d => ['chat', 'answer-card'].includes(d.source) && /^D[1-9]/.test(d.id)), '決定事項の出典は利用者の入力（チャット / 回答欄）だけ。番号は D1…（版ごとの Q 番号と別）');
});

// =========================================================
console.log('\n--- C0. 再現ケース（修正前と共通の API だけで確かめる）: 「PCだけ」を確認事項への回答として扱い、聞き直さない ---');
await section(async () => {
  const { c, calls } = makeConv([planWith(qs(QP, QS, QA)), planWith(qs(QS, QP2, QA))]);
  await startPlan(c);
  let userActions = 1;
  let r = await c.send('PCだけ');
  const after = c.messages().slice(-3).map(m => m.text).join(' / ');
  assert(r.intent === 'ANSWER' && !/何についてでしょうか/.test(after) && calls.plan.length === 2 && c.activePlan().version === 2, `「PCだけ」→ 回答として計画を作り直す（用途の選び直し・言い直しが要らない）: intent=${r.intent} / ${after.slice(0, 120)}`);
  // 修正前は「何についてでしょうか」→ 利用者が［計画の修正］を選び直していた（同じ文をもう一度送る）
  if (r.intent === 'AMBIGUOUS') { userActions += 1; r = await c.send('PCだけ', { intentOverride: 'REVISE_PLAN' }); }
  //   C-1 第 3 段: 確認事項は質問カード（kind questions。削除）ではなく最終案のカードに出る
  const lastQ = finalQuestionsText(c);
  assert(c.activePlan() && c.activePlan().version === 2 && lastQ !== null && /金額が大きいとき/.test(lastQ) && !/スマートフォン/.test(lastQ) && !/スマートフォン/.test(finalCard(c)), `作り直した計画 v2 で、答えた論点（PC / モバイル）を言い換えて聞き直さない（最終案の確認事項）: ${lastQ}`);
  assert(userActions === 1 && calls.plan.length === 2, `計画の作り直しまでの利用者の操作は 1 回・AI の呼び出しは作り直しの 1 回（操作 ${userActions} 回）`);
});

// =========================================================
console.log('\n--- C1. 会話:「PCだけ」→ 受領の表示 → 作り直し（決定事項を送る）→ 言い換えた再質問を出さない ---');
await section(async () => {
  const V1 = planWith(qs(QP, QS, QA));
  const V2 = planWith(qs(QS, QP2, QA, QT));                  // 番号が振り直され、PC / モバイルを言い換えて聞き直す
  const V3 = planWith(qs(QS, QP2, QT));                      // 承認者に答えた後
  const V4 = planWith(qs(QS, QP2));                          // タイミングに答えた後
  const V5 = planWith(qs(QS));                               // 「やっぱりモバイルも必要」の後
  const { c, calls, last, kinds } = makeConv([V1, V2, V3, V4, V5, V5]);
  await startPlan(c);
  assert(c.activePlan().version === 1 && open(c).length === 3 && answered(c).length === 0 && c.decisions().length === 0, 'v1: 確認事項 3 件。AI の推測（uncertainties / unknowns）は決定事項にしない');
  //   C-1 第 3 段: 仮案の AI・最初の計画の AI の呼び出しと採用の往復（aiBase・rtBase）の後からの増え方で数える
  const aiBase = c.metrics().aiCalls, rtBase = c.metrics().roundTrips;
  const r1 = await c.send('PCだけ');
  const ack = c.messages().find(m => m.data?.kind === 'answers-ack');
  assert(r1.intent === 'ANSWER' && r1.ok && ack && ack.role === 'toolkit' && /PC \/ モバイル：PCだけ/.test(ack.text) && /計画を作り直しています/.test(ack.text) && /計画全体を作り直します/.test(ack.text) && !/1 分前後|十数秒|約\s*[0-9]+\s*(秒|分)/.test(ack.text) && /kintone にはまだ何も反映していません/.test(ack.text) && !/v2/.test(ack.text), `受領の表示: 理解した内容・作り直しの種類（計画全体）・未反映（計画の完成・反映と区別できる）。§0f.5 の 3: 根拠の無い待ち時間の文（1 分前後）は出さない: ${ack && ack.text}`);
  assert(calls.plan.length === 2 && calls.plan[1].ackAtCall === 1 && calls.plan[1].aiCallsAtCall === aiBase + 1, '受領の表示は AI を呼ぶ前に出る（AI の呼び出しは作り直しの 1 回だけ。受領のための呼び出しは無い）');
  const ackIdx = c.messages().indexOf(ack), planIdx = c.messages().findIndex(m => m.type === 'FINAL' && m.data.version === 2);
  assert(ackIdx >= 0 && planIdx > ackIdx && ack.data.stage === 'done', '受領の表示 → 計画 v2 の最終案の順（作り直しが終わると受領の表示は done。C-1 第 3 段: 変更案のカード PLAN は最終案のカード FINAL に置き換わった）');
  const p2 = calls.plan[1];
  assert(p2.revision && /質問「対象は PC だけですか？モバイルでも使いますか？」）：PCだけ/.test(p2.revision.request) && !/\bQ[0-9]+\b/.test(p2.revision.request) && /まだ答えていない確認事項：「金額が大きいとき、保存を止めますか？」、「承認者は誰にしますか？」/.test(p2.revision.request), `作り直しの依頼文: 質問文で書き、Q 番号を使わない・未回答も伝える: ${p2.revision.request}`);
  assert(p2.decisions.length === 1 && p2.decisions[0].topic === 'platform' && p2.decisions[0].answer === 'PCだけ' && p2.decisions[0].value.join() === 'desktop' && p2.decisions[0].source === 'chat' && p2.decisions[0].status === 'answered', `決定事項を構造化して送る: ${JSON.stringify(p2.decisions)}`);
  const v2 = c.activePlan();
  assert(v2.version === 2 && !open(c).includes(QP2) && open(c).length === 3 && c.metrics().reasked === 1 && (v2.reaskedQuestions || []).some(q => q.text === QP2), `v2: 言い換えた PC / モバイルの質問は出さない（再質問として数え、版に記録する。C-1 第 3 段: 会話に出さない通知 kind reasked は作らなくなった）: open=${open(c).join(' / ')}`);
  //   C-1 第 3 段: 確認事項の案内は質問カード（kind questions）ではなく最終案のカード
  const qCard = finalCard(c);
  assert(qCard && !/スマートフォン/.test(qCard) && /件あります/.test(qCard) && !/スマートフォン/.test(finalQuestionsText(c)), '確認事項の案内（最終案のカード）にも再質問を出さない');
  assert(v2.review && Array.isArray(v2.review.steps) && v2.review.steps.length === 1 && v2.final, '回答から作った版も Toolkit Review を通る（回答済みでも検証を省かない。C-1 第 3 段: Review の会話のカード REVIEW は作らず、版の review と最終案に入る）');
  // 別の質問に答えても、前の決定事項を保つ
  await c.send('部長です');
  const p3 = calls.plan[2];
  assert(p3.decisions.map(d => `${d.topic}:${d.answer}`).join() === 'platform:PCだけ,approver:部長です' && /承認者（質問「承認者は誰にしますか？」）：部長です/.test(p3.revision.request) && !/PCだけ/.test(p3.revision.request), `「部長です」→ 承認者。前の決定事項（PCだけ）も一緒に送る（依頼文は新しい回答だけ）: ${JSON.stringify(p3.decisions)}`);
  await c.send('保存時です');
  assert(calls.plan[3].decisions.some(d => d.topic === 'timing' && d.answer === '保存時です') && calls.plan[3].decisions.length === 3 && c.activePlan().version === 4, '「保存時です」→ タイミング（3 件の決定事項を保つ）');
  // 回答の変更
  await c.send('やっぱりモバイルも必要');
  const p5 = calls.plan[4];
  const dp = p5.decisions.find(d => d.topic === 'platform');
  const ack5 = [...c.messages()].reverse().find(m => m.data?.kind === 'answers-ack');
  assert(dp.answer === 'やっぱりモバイルも必要' && dp.previousAnswer === 'PCだけ' && dp.value.join() === 'desktop,mobile' && /前の回答「PCだけ」から変更/.test(ack5.text) && /PC \/ モバイルを変更：やっぱりモバイルも必要（前の回答：PCだけ）/.test(p5.revision.request), `「やっぱりモバイルも必要」→ 決定事項を更新（前の回答は履歴）: ${JSON.stringify(dp)}`);
  assert(p5.decisions.length === 3 && c.ledger().filter(e => e.topics.includes('platform') && e.status === 'answered').length === 1, '同じ論点の決定事項は 1 件（置き換え。重複して矛盾した決定を送らない）');
  // 記録済みの言い直しは作り直さない
  const n = calls.plan.length;
  const rr = await c.send('部長です');
  assert(rr.intent === 'ANSWER' && rr.reason === 'ANSWER_RESTATED' && calls.plan.length === n && /その内容は、いま直している変更案に入れます|前の回答と同じです/.test(last().text) && !/記録済み/.test(last().text), '前の回答の言い直しは、そう伝えて AI を呼ばない（「記録済み」の語は使わない）');
  // 計測: 受領の表示までと完成までを分けて測る（latencyMs は AI の応答全体。ここは画面の側）
  const mt = c.metrics();
  const ans = mt.timings.filter(x => x.intent === 'ANSWER' && x.aiCalls === 1);
  assert(ans.length === 4 && ans.every(x => x.ackMs === 0 && x.doneMs === 60000 && x.ok) && mt.roundTrips === rtBase + 4 && mt.answersRecorded === 4 && mt.aiCalls === aiBase + 4, `計測: 受領の表示まで（ackMs）と計画の完成まで（doneMs）・AI の呼び出し・往復の回数: ${JSON.stringify({ ans, roundTrips: mt.roundTrips, aiCalls: mt.aiCalls })}`);
  assert(kinds().filter(k => k === 'answers-ack').length === 4, '回答ごとに受領の表示が 1 つ');
});

// =========================================================
console.log('\n--- C2. 会話: 複数の回答・対応先が決まらない回答（確定せず、その部分だけ聞く。AI を呼ばない） ---');
await section(async () => {
  const V1 = planWith(qs(QP, QS, '承認の設定も必要ですか？'));
  const { c, calls, last } = makeConv([V1, planWith(qs('承認の設定も必要ですか？')), planWith([])]);
  await startPlan(c);
  await c.send('PCだけ。保存は止めない');
  assert(calls.plan.length === 2 && calls.plan[1].decisions.map(d => `${d.topic}:${d.answer}`).join() === 'platform:PCだけ,save_block:保存は止めない', `複数の回答を 1 回の作り直しで両方記録して送る: ${JSON.stringify(calls.plan[1].decisions)}`);
  // v2 で残った未回答は 1 つ（語彙に無い論点）→「不要です」はその質問への回答
  const r = await c.send('不要です');
  const d = calls.plan[2] && calls.plan[2].decisions.find(x => x.answer === '不要です');
  assert(r.reason === 'ANSWERS' && calls.plan.length === 3 && d && d.topic === 'other' && d.question === '承認の設定も必要ですか？' && calls.plan[2].decisions.length === 3, `未回答が 1 つなら、論点の無い「不要です」もその質問への回答（語彙に無い論点は other・質問文を添える）: ${JSON.stringify(calls.plan[2] && calls.plan[2].decisions)}`);
  assert(!last().data || last().data.kind !== 'answer-target', '対応先が 1 つに決まるときは聞き返さない');
});
// C-1 第 3 段（2026-10-08）: 未回答が 2 つある状態の「いいえ」に対応先を聞き返すカード（answer-target）と、対応先の選択（pendingClarification）は削除した。
//   聞き返さずに、決定事項に記録しないまま候補の確認事項を添えて計画の AI に渡す新しい流れの回帰は tests/ai-flow-redesign.test.js の F4-1・F4-2
//   （計測は unresolvedAnswers・聞き返しの回数 clarifications は増えない）と F7-1（pendingClarification が無い）
await section(async () => {
  // 理解できた部分は記録し、決まらない部分は決定事項にしないで計画の AI に渡す（C-1 第 3 段: 以前は決まらない部分だけ対応先を聞き返した）
  const V1 = planWith(qs(QP, QS, '承認の設定も必要ですか？'));
  const { c, calls, last } = makeConv([V1, planWith([])]);
  await startPlan(c);
  const r = await c.send('PCだけ。いいえ');
  const req = calls.plan[1] && calls.plan[1].revision ? calls.plan[1].revision.request : '';
  assert(r.reason === 'ANSWERS' && calls.plan.length === 2 && answered(c).map(e => e.answer).join() === 'PCだけ' && !c.messages().some(m => m.data?.kind === 'answer-target') && /PC \/ モバイル（質問「対象は PC だけですか？モバイルでも使いますか？」）：PCだけ/.test(req) && /そのほかの記述：いいえ（どの確認事項への回答か決められなかった答え。候補の確認事項: /.test(req), `理解できた部分（PCだけ）は記録し、対応先が決まらない部分（いいえ）は記録せずに計画の AI へ渡す（聞き返さない）: ${req}`);
  assert(calls.plan[1].decisions.length === 1 && calls.plan[1].decisions[0].topic === 'platform' && calls.plan[1].decisions[0].answer === 'PCだけ' && !calls.plan[1].decisions.some(d => d.answer === 'いいえ') && c.metrics().unresolvedAnswers === 1 && last().type === 'FINAL', '記録した回答（PCだけ）は決定事項として一緒に送り、決まらない「いいえ」は決定事項にしない');
});

// =========================================================
console.log('\n--- C3. 会話: 失敗・キャンセル・遅れた応答（回答を失わない・古い応答で新しい会話や決定事項を上書きしない） ---');
await section(async () => {
  const { c, calls, ctl, last } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS))]);
  await startPlan(c);
  ctl.fail = 'TIMEOUT';
  const r = await c.send('PCだけ');
  const ack = c.messages().find(m => m.data?.kind === 'answers-ack');
  assert(!r.ok && ack.data.stage === 'failed' && /完了していません（失敗しました）/.test(ack.text) && /回答は記録したままです/.test(ack.text) && last().type === 'ERROR' && c.activePlan().version === 1, `作り直しの失敗: 受領の表示を「未完了」に書き換え、回答は記録したまま: ${ack.text}`);
  assert(answered(c).length === 1 && answered(c)[0].appliedInVersion === null && c.decisions()[0].answer === 'PCだけ', '失敗しても決定事項は残る（まだ計画に入っていない）');
  await c.send('更新状況は3段階ではなく5段階にして');
  assert(calls.plan.length === 3 && calls.plan[2].revision.request === '更新状況は3段階ではなく5段階にして' && calls.plan[2].decisions[0].answer === 'PCだけ' && answered(c)[0].appliedInVersion === 2, '次の修正の依頼で、記録したままの回答も送り、その版に入ったと記録する（修正の依頼の文は原文のまま）');
});
await section(async () => {
  const { c, ctl } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS))]);
  await startPlan(c);
  const release = ctl.hold();
  const ac = new AbortController();
  const p = c.send('PCだけ', { signal: ac.signal });
  await tick(); ac.abort(); release();
  const r = await p;
  const ack = c.messages().find(m => m.data?.kind === 'answers-ack');
  assert(r.cancelled && ack.data.stage === 'cancelled' && /取り消しました/.test(ack.text) && answered(c).length === 1 && c.activePlan().version === 1, 'キャンセル: 受領の表示を「取り消し」に書き換え、回答は記録したまま・計画は v1 のまま');
});
await section(async () => {
  const { c, ctl, calls } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS))]);
  await startPlan(c);
  const release = ctl.hold();
  const p = c.send('PCだけ');
  await tick();
  c.startNew();
  release();
  const r = await p;
  assert(r.discarded && c.planHistory().length === 0 && c.ledger().length === 0 && c.messages().length === 0 && c.metrics().aiCalls === 0 && calls.plan.length === 2, '送信中に新しい会話: 遅れて返った応答・受領の表示・決定事項を新しい会話に入れない');
});
await section(async () => {
  const { c, ctl } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS))]);
  await startPlan(c);
  const v1 = c.activePlan();
  const release = ctl.hold();
  const p = c.send('PCだけ');
  await tick();
  const vX = c.registerPlan({ plan: planWith(qs(QS)), basedOn: v1 });   // 送信中に別の経路で版が進んだ
  release();
  const r = await p;
  assert(r.discarded && c.activePlan() === vX && c.planHistory().length === 2 && answered(c)[0].appliedInVersion === null, '送信中に別の版が最新になった: 古い版から作った応答で上書きしない（回答はまだ計画に入っていない扱い）');
});

// =========================================================
console.log('\n--- C4. 会話: コード生成にも決定事項（回答済みだけ）・未反映の回答があれば生成しない ---');
// C-1 第 3 段（2026-10-08）: JavaScript は最終案のパイプラインが計画の版ごとに作る（以前は仕様の確定 confirmSpec の後に「C1 のコードを作って」で作った。
//   仕様の確定は tests/ai-flow-redesign.test.js の F7-1・F7-3 のとおり無い）。生成に渡す決定事項は、その版の最終案を作るときの生成の呼び出しで確かめる
await section(async () => {
  //   必須の効果（warn）を持たせる（効果の無い CONTROL は計画の自動の差分更新に回り、版が 1 つ増える。tests/ai-flow-redesign.test.js の D6・D11）
  const cust = (platform, questions = []) => ({ customizationId: 'C1', requirement: '金額が100万円を超えたら注意を出す', whyStandardInsufficient: '標準では出せない', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform, events: ['app.record.create.show'], fields: [{ code: 'amount', access: 'CONTROL', effects: ['warn'] }], apis: ['kintone.events.on'], existingFiles: [], risks: [], questions, dependsOn: [], evidenceIds: [], confidence: 'INFERRED' });
  const V1 = planWith(qs(QP), { solution: 'CUSTOMIZATION', steps: [], customizations: [cust([])] });
  const V2 = planWith([], { solution: 'CUSTOMIZATION', steps: [], customizations: [cust(['desktop'])] });
  const { c, calls } = makeConv([V1, V2], { review: false });
  await startPlan(c);
  await c.send('PCだけ');
  const v2 = c.activePlan();
  assert(v2.version === 2 && v2.decisionsSent.length === 1 && (v2.decisionConflicts || []).length === 0, 'v2: 送った決定事項を版に持つ（計画の対象 PC と決定事項が合う）');
  //   v1 の最終案の生成（回答の前・決定事項 0 件）と、v2 の最終案の生成（回答の後）の 2 回
  const g2 = calls.generate[calls.generate.length - 1];
  assert(calls.generate.length === 2 && calls.generate[0].decisions.length === 0 && g2.decisions.length === 1 && g2.decisions[0].topic === 'platform' && g2.decisions[0].answer === 'PCだけ' && v2.final, `生成にも同じ決定事項（回答済み）を渡す（v2 の最終案の生成）: ${JSON.stringify(calls.generate.map(g => g.decisions))}`);
});
await section(async () => {
  const cust = (platform) => ({ customizationId: 'C1', requirement: 'r', whyStandardInsufficient: 'w', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform, events: ['app.record.create.show'], fields: [], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [], confidence: 'INFERRED' });
  const V1 = planWith(qs(QP), { solution: 'CUSTOMIZATION', steps: [], customizations: [cust(['desktop', 'mobile'])] });
  const { c, calls, ctl, last } = makeConv([V1, planWith([], { solution: 'CUSTOMIZATION', steps: [], customizations: [cust(['desktop', 'mobile'])] })], { review: false });
  await startPlan(c);
  ctl.fail = 'TIMEOUT';
  await c.send('PCだけ');
  const nGen = calls.generate.length;   // v1 の最終案の生成（回答の前）
  await c.send('C1 のコードを作って', { intentOverride: 'GENERATE_CODE' });
  assert(nGen === 1 && calls.generate.length === nGen && last().data?.kind === 'generate-pending-answers' && /PCだけ/.test(last().text), '計画に入っていない回答があれば生成しない（回答を無視したコードを作らない。最終案の作り直しもしない）');
  await c.send('金額の表示はそのまま', { intentOverride: 'REVISE_PLAN' });
  const v2 = c.activePlan();
  assert(v2.version === 2 && v2.decisionConflicts.length === 1 && v2.decisionConflicts[0].plan.join() === 'desktop,mobile' && c.messages().some(m => m.data?.kind === 'decision-conflict' && /PCだけ/.test(m.text)) && c.metrics().platformConflicts === 1, '計画の対象（PC・モバイル）が決定事項（PCだけ）と合わなければ知らせる（計画をそのまま信じない）');
});

// =========================================================
console.log('\n--- D. Context と応答の受け取り（KTContext / KTAiClient.receive） ---');
await section(async () => {
  const decisions = [
    { id: 'D1', topic: 'platform', label: 'PC / モバイル', question: QP, answer: 'PCだけ', source: 'chat', status: 'answered', kind: 'question', value: ['desktop'] },
    { id: 'D2', topic: 'approver', label: '承認者', question: QA, answer: '部長です', source: 'answer-card', status: 'reconfirm', kind: 'question', reconfirmReason: 'r' },
    { id: 'X1', topic: 'platform', answer: 'AI の推測', source: 'ai', status: 'answered' },
  ];
  const rev = { basedOnVersion: 1, request: '確認事項への回答です。', previousPlan: planWith(qs(QP)), previousRequests: [] };
  const ctx = KTContext.buildPlan({ goal: 'g', data: DATA, deps: DEPS, scan: null, incoming: null, options: { revision: rev, decisions } });
  assert(Array.isArray(ctx.decisions) && ctx.decisions.map(d => d.id).join() === 'D1,D2' && ctx.decisions[0].value.join() === 'desktop', `Planner Context: 決定事項は revision と一緒に送る（形の不正・利用者の入力でないものは落とす）: ${JSON.stringify(ctx.decisions)}`);
  const ctx0 = KTContext.buildPlan({ goal: 'g', data: DATA, deps: DEPS, scan: null, incoming: null, options: { decisions } });
  // 再設計 段階 B（2026-10-07・契約 16）: 仮案で答えた決定事項は、採用後の最初の計画（revision 無し）にも載せる（以前は revision と一緒のときだけ）
  assert(Array.isArray(ctx0.decisions) && ctx0.decisions.map(d => d.id).join() === 'D1,D2' && !('revision' in ctx0), `Planner Context: 新しい計画（revision 無し）にも渡された決定事項を載せる（形の不正・利用者の入力でないものは落とす）: ${JSON.stringify(ctx0.decisions)}`);
  const ctx00 = KTContext.buildPlan({ goal: 'g', data: DATA, deps: DEPS, scan: null, incoming: null, options: {} });
  assert(!('decisions' in ctx00), 'Planner Context: 決定事項が無ければ decisions を付けない');
  const r2 = KTContext.compactRevision({ basedOnVersion: 1, request: 'あ'.repeat(2100), previousPlan: planWith([]) });
  assert(r2.request.length === 2000, `依頼文は Gateway の上限（2000 文字）ちょうどに収める（以前は 2001 文字で INVALID_CONTEXT）: ${r2.request.length}`);
  const custObj = { customizationId: 'C1', requirement: 'r', whyStandardInsufficient: 'w', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: ['desktop'], events: ['app.record.create.show'], fields: [], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [], confidence: 'INFERRED' };
  const g = KTContext.buildGenerator({ customization: custObj, plan: planWith([], { customizations: [custObj] }), planId: 'p', version: 2, data: DATA, deps: DEPS, decisions });
  assert(Array.isArray(g.decisions) && g.decisions.map(d => d.id).join() === 'D1', 'Generator Context: 回答済みの決定事項だけ（再確認中は送らない）');
  //   簡素化（2026-10-17）: 回答済みの PC / モバイルの再質問を外す・platform を決定事項で補う・質問しながら両方なら空にする正規化は、Gateway の validate-plan
  //   （worker/test/cases/decisions.mjs・change-planner.mjs・plan-patch.mjs で確かめる）が必ず通すので、Toolkit の validatePlan ではやり直さない
  const resp = (platform, questions) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'r', decisions: { version: '1', received: 1 } }, plan: { goal: 'g', solution: 'CUSTOMIZATION', assessment: { summary: '' }, relevantFields: [], proposedFields: [], steps: [], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', customizations: [{ ...custObj, platform, questions }] } });
  const ctxD = { ...KTContext.buildPlan({ goal: 'g', data: DATA, deps: DEPS, scan: null, incoming: null, options: { revision: rev, decisions: [{ ...decisions[0], value: ['desktop', 'mobile'], answer: 'モバイルも必要' }] } }) };
  void ctxD;
  const a = KTAiClient.receive('plan', resp(['desktop', 'mobile'], ['PC とモバイルの両方で必要ですか？']));
  assert(a.customizations[0].platform.join() === 'desktop,mobile' && a.customizations[0].questions.length === 1 && a.decisionsMeta.received === 1, 'receive: Gateway の計画（platform・質問）をそのまま返し、決定事項の受け取りの証（meta.decisions）を decisionsMeta に運ぶ');
  const b = KTAiClient.receive('plan', resp([], []));
  const n = KTAiClient.receive('plan', { ...resp(['desktop', 'mobile'], ['PC とモバイルの両方で必要ですか？']), meta: { requestId: 'r' } });
  assert(b.customizations[0].platform.length === 0 && n.customizations[0].platform.join() === 'desktop,mobile' && n.decisionsMeta === null, 'receive: 決定事項で platform を補わず、質問しながら両方でも空にしない（どちらも Gateway の validate-plan の仕事）');
});

// =========================================================
console.log('\n--- E. レビューで見つかった不具合の回帰（解釈） ---');
await section(async () => {
  const v = (questions) => ({ activePlan: { planId: 'p', version: 1, status: 'ACTIVE', plan: planWith(questions), review: { steps: [] } }, ledgers: new Map() });
  const cls = (t, s) => KTAiConversation.classifyIntent(t, s);
  const one = v(qs('更新状況の選択肢は 3 段階でよいですか'));
  for (const t of ['これでお願いします', 'この計画でお願いします', 'この内容でお願いします', 'このままでお願いします', 'そのままでお願いします', '動作テストでお願いします', '反映でお願いします', '実行でお願いします', 'はい、それでお願いします', 'それでお願いします']) assert(cls(t, one).intent === 'REQUEST_PREVIEW', `I1: 進める言葉は未回答の確認事項があっても回答にしない:「${t}」→ ${cls(t, one).intent}`);
  const many = v(qs(QP, QS, QA, QT, { question: '注意はどこに表示しますか？', topic: 'location' }));
  for (const t of ['どこに表示されるの', 'いつチェックされるの', '承認者は誰がいい', '部長って誰のこと', 'PCだけだと何が変わる', 'モバイルだとどうなる']) assert(cls(t, many).intent !== 'ANSWER', `I2: 「？」の無い疑問文も回答にしない:「${t}」→ ${cls(t, many).intent}`);
  for (const [t, want] of [['モバイルでも使います', 'desktop,mobile'], ['スマホも', 'desktop,mobile'], ['モバイルもです', 'desktop,mobile'], ['スマホからも入力します', 'desktop,mobile'], ['モバイル対応は不要', 'desktop'], ['スマホでは使わない', 'desktop'], ['モバイルでは使いません', 'desktop'], ['モバイルの通知はいらない', 'null'], ['携帯番号は必須にして', 'null'], ['モバイルで使います', 'null'], ['スマホだけ', 'mobile'], ['PCです', 'desktop']]) {
    const got = KTAiAnswers.platformValueOf(t);
    assert((got ? got.join() : 'null') === want, `I3: platformValueOf「${t}」→ ${want}（片側にするのは言い切れるときだけ）: ${got}`);
  }
  const reqs = v(qs(QP, QA));
  assert(cls('新しい承認者は作らず既存の承認者を使って', reqs).intent === 'REVISE_PLAN' && cls('100万円以上なら部長承認を追加したい', reqs).intent !== 'ANSWER' && cls('契約終了30日前に担当者へ通知したい', reqs).intent !== 'ANSWER' && cls('モバイルでは金額を非表示にして', reqs).intent !== 'ANSWER' && cls('携帯番号は必須にして', reqs).intent !== 'ANSWER', 'I4: 修正の依頼・新しい要望は、論点の語があっても回答にしない');
  const single = v(qs(QP));
  assert(cls('いや、P2はいらない', single).intent !== 'ANSWER' && cls('いいえ、P1は外して', single).intent !== 'ANSWER', 'I4: 「いや、P2はいらない」のように YESNO の後ろが依頼なら回答にしない');
  assert(cls('PCだけにして', single).intent === 'ANSWER' && cls('部長にしてください', reqs).intent === 'ANSWER' && cls('PCだけ。保存は止めない', v(qs(QP, QS))).intent === 'ANSWER' && cls('いいえ、不要です', v(qs(QS))).intent === 'ANSWER', 'I4: 回答の言い方（「PCだけにして」「部長にしてください」「いいえ、不要です」）は回答のまま');
  const cond = KTAiAnswers.interpret({ text: '100万円以上なら、保存を止める', open: [{ key: 'Q2', text: QS, topics: ['save_block'] }], decided: [], isRequest });
  assert(cond.kind === 'answers' && cond.answers.length === 1 && cond.answers[0].clause === '100万円以上なら、保存を止める' && cond.extras.length === 0, `I7: 「〜なら、…」は条件と本文に分けない: ${JSON.stringify(cond)}`);
  const dec = [{ id: 'd1', topics: ['platform'], answer: 'PCだけ', status: 'answered' }];
  assert(KTAiAnswers.interpret({ text: 'PCだけです', open: [], decided: dec, isRequest }).kind === 'restated', 'I8: 語尾だけ違う言い直し（「PCだけです」）は記録済み（作り直さない）');
  assert(KTAiAnswers.interpret({ text: 'モバイルの通知はいらない', open: [], decided: dec, isRequest }).kind === 'none' && KTAiAnswers.interpret({ text: 'モバイルは不要', open: [], decided: [{ ...dec[0], answer: 'モバイルも必要' }], isRequest }).kind === 'answers', 'I6: 論点に触れるだけの修正の依頼は決定事項の更新にしない（「モバイルは不要」のように論点についての答えだけの文は更新）');
});

// C-1 第 4 段（2026-10-09・K-1）: 決定済みの論点の語（承認者の「部長」「決裁」）を含むだけの名前の変更の依頼は、答えの変更にしない。
//   答えの変更にするのは、節の論点がすべて決定事項の論点に入っているときか、論点の語と語尾を除いた残りが短いときだけ。決定事項を置き換えず、計画の修正の依頼に回す
//   （再現: scratchpad rv9a/repro-k1.mjs。最終案の後に送ると、前は承認者の答えがこの文に置き換わり「承認者を変更」と出た）
await section(async () => {
  const K1 = '部長承認待ちの名前は「部長決裁待ち」に変えてください';
  const decA = [{ id: 'd1', topics: ['approver'], answer: '今の「承認待ち」と同じ作業者', status: 'answered' }];
  const it1 = KTAiAnswers.interpret({ text: K1, open: [], decided: decA, isRequest });
  assert(it1.kind === 'none' && !it1.updates.length && KTAiAnswers.restatesDecision(K1, ['approver']) === false, `K1-1: 名前の変更の依頼は決定事項（承認者）の答えの変更にしない: ${JSON.stringify(it1)}`);
  //   今の答えの変更（論点についての答えだけの文・変更の言い方で論点が決定事項に収まる文）は従来どおり
  const decP = [{ id: 'd1', topics: ['platform'], answer: 'PCだけ', status: 'answered' }];
  assert(KTAiAnswers.interpret({ text: 'やっぱり両方', open: [], decided: decP, isRequest }).updates.length === 1 && KTAiAnswers.interpret({ text: 'やっぱりモバイルも必要', open: [], decided: decP, isRequest }).updates.length === 1 && KTAiAnswers.interpret({ text: '課長に変えて', open: [], decided: [{ id: 'd1', topics: ['approver'], answer: '部長です', status: 'answered' }], isRequest }).updates.length === 1,
    'K1-2: 「やっぱり両方」「やっぱりモバイルも必要」「課長に変えて」は答えの変更のまま');
  //   会話: 承認者に答えた後、名前の変更の依頼を送る → 決定事項は変わらず、計画の修正の依頼（revision.request）に原文が入る
  const { c, calls } = makeConv([planWith(qs(QA)), planWith([]), planWith([])]);
  await startPlan(c);
  await c.send('部長です');
  await c.send(K1);
  const last = calls.plan[calls.plan.length - 1];
  const ap = c.ledger().filter(e => (e.topics || []).includes('approver'));
  assert(calls.plan.length === 3 && last.revision && String(last.revision.request).includes(K1) && ap.length === 1 && ap[0].status === 'answered' && ap[0].answer === '部長です' && (last.decisions || []).some(d => d.topic === 'approver' && d.answer === '部長です' && !d.previousAnswer),
    `K1-3: 決定事項（承認者「部長です」）は変わらず、依頼は計画の修正に回る: ${JSON.stringify({ n: calls.plan.length, request: last.revision && last.revision.request, ledger: ap.map(e => [e.status, e.answer]), decisions: last.decisions })}`);
});

// =========================================================
console.log('\n--- F. レビューで見つかった不具合の回帰（台帳・状態） ---');
await section(async () => {
  // I5: 文脈の語を含む質問（AI の topic は save_block）に答えたら閉じる
  const { c, calls } = makeConv([planWith(qs({ question: '保存時に金額が100万円以上なら保存を止めますか？', topic: 'save_block' }, QA)), planWith([])]);
  await startPlan(c);
  await c.send('止めてください');
  assert(calls.plan.length === 2 && !/まだ答えていない確認事項：「保存時/.test(calls.plan[1].revision.request) && calls.plan[1].decisions[0].topic === 'save_block', `I5: AI の topic で対応づけ、答えた質問は閉じる（未回答に残さない）: ${calls.plan[1] && calls.plan[1].revision.request}`);
});
await section(async () => {
  // S1: 同じ送信の「追加の条件」が、記録したばかりの回答を置き換えない
  const { c, calls } = makeConv([planWith(qs(QP, QA)), planWith([])]);
  await startPlan(c);
  await c.send('部長です。不在時は課長');
  const ds = calls.plan[1].decisions;
  assert(ds.length === 2 && ds.some(d => d.topic === 'approver' && d.answer === '部長です' && !d.previousAnswer) && ds.some(d => d.kind === 'condition' && d.answer === '不在時は課長'), `S1: 回答「部長です」は残り、「不在時は課長」は別の条件: ${JSON.stringify(ds)}`);
  const { c: c2, calls: k2 } = makeConv([planWith(qs(QP)), planWith([])]);
  await startPlan(c2);
  await c2.send('PCだけ。モバイルは保存時にチェック');
  const p2 = k2.plan[1].decisions.filter(d => d.topic === 'platform' && d.value);
  assert(p2.length === 1 && p2[0].value.join() === 'desktop', `S1: 後ろの条件文で PC / モバイルの値が反転しない: ${JSON.stringify(k2.plan[1].decisions)}`);
});
await section(async () => {
  // S2 / G4: 再確認に答えないまま AI が取り下げたら、回答済みに戻る（生成にも渡る）。再確認中の版では生成に渡さない
  const cust = (platform) => ({ customizationId: 'C1', requirement: 'r', whyStandardInsufficient: 'w', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform, events: ['app.record.create.show'], fields: [], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [], confidence: 'INFERRED' });
  const V1 = planWith(qs(QP), { solution: 'CUSTOMIZATION', steps: [], customizations: [cust([])] });
  const V2 = planWith(qs({ question: '外出先でも入力するとのことですが、PCだけでよいですか？', decisionRef: 'D1', reason: '依頼に「外出先でも」とある' }), { solution: 'CUSTOMIZATION', steps: [], customizations: [cust(['desktop'])] });
  const V3 = planWith([], { solution: 'CUSTOMIZATION', steps: [], customizations: [cust(['desktop'])] });
  const { c, calls } = makeConv([V1, V2, V3], { review: false });
  await startPlan(c);
  await c.send('PCだけ');
  assert(c.ledger().find(e => e.answer === 'PCだけ').status === 'reconfirm', 'v2: AI が D1 の再確認を求める');
  //   C-1 第 3 段: v2 の JavaScript は v2 の最終案を作るときに生成する（仕様の確定と「C1 のコードを作って」は不要）。呼び出しは v1・v2 の最終案の 2 回
  const v2 = c.activePlan();
  const g2 = calls.generate[calls.generate.length - 1];
  assert(calls.generate.length === 2 && v2.decisionsSent.length === 1 && g2.decisions.length === 0, `G4: 再確認中の決定事項は生成に渡さない（送った時点の写しではなく台帳の今の状態で絞る）: ${JSON.stringify(calls.generate.map(g => g.decisions))}`);
  await c.send('金額の表示は赤字にして', { intentOverride: 'REVISE_PLAN' });
  assert(c.ledger().find(e => e.answer === 'PCだけ').status === 'answered' && c.activePlan().version === 3, 'S2: 次の版で AI が再確認を取り下げたら、記録した回答のまま回答済みに戻る');
});
await section(async () => {
  // S3c / G3: 再確認の質問に、決定事項の論点に触れない答え（確認・補足）を返したら、元の回答を保って補足として記録する
  const V2 = planWith(qs({ question: '「部長」を指定するユーザー選択フィールドがありません。どのフィールドで指定しますか？', decisionRef: 'D1', reason: 'facts に無い' }));
  const { c, calls } = makeConv([planWith(qs(QA)), V2, planWith([])]);
  await startPlan(c);
  await c.send('部長です');
  const q = c.answerContext().open[0];
  assert(q && q.reconfirm, 'v2: 存在の確認の質問（decisionRef D1）');
  await c.send('「承認者フィールドを使う」', { intentOverride: 'ANSWER', answerPayload: { source: 'answer-card', items: [{ key: q.key, answer: '承認者フィールドを使う' }] } });
  const ds = calls.plan[2].decisions;
  assert(ds.some(d => d.id === 'D1' && d.answer === '部長です' && d.status === 'answered' && !d.previousAnswer) && ds.some(d => d.kind === 'condition' && d.answer === '承認者フィールドを使う' && /ユーザー選択フィールド/.test(d.question || '')), `G3: 元の回答（部長です）は変更扱いにせず、答えは質問への補足として記録: ${JSON.stringify(ds)}`);
});
await section(async () => {
  // S3b: 同じ論点の質問が 2 つあるときの「部長です」は、回答先を聞き返さず、計画の AI に確認事項の文脈で読ませる（2026-10-05。
  //   聞き返すのは「はい」「いいえ」の答えだけ）。回答欄で対応先を選んだら、選ばなかった方は未回答のまま
  const QD = { question: '代理の承認者は誰にしますか？', topic: 'approver' };
  const { c, calls, last } = makeConv([planWith(qs({ question: QA, topic: 'approver' }, QD)), planWith(qs({ question: QA, topic: 'approver' }, QD)), planWith([])]);
  await startPlan(c);
  const r1 = KTAiConversation.classifyIntent('部長です', c.state);
  await c.send('部長です');
  //   C-1 第 3 段: 対応先の確認（pendingClarification）は無くなった（tests/ai-flow-redesign.test.js の F7-1）。聞き返しのカードが無いことで確かめる
  assert(r1.reason === 'TURN' && last().data?.kind !== 'answer-target' && !c.messages().some(m => m.data?.kind === 'answer-target') && calls.plan.length === 2 && /部長です/.test(calls.plan[1].revision.request || ''), `S3b: 同じ論点の質問が 2 つでも、論点の語を含む答えは聞き返さず計画の AI に読ませる: ${JSON.stringify({ r: r1.reason, req: calls.plan[1] && calls.plan[1].revision.request })}`);
  const target = c.answerContext().open.find(x => x.text === QA);
  await c.send(`「部長です」は「${QA}」への回答です。`, { intentOverride: 'ANSWER', answerPayload: { source: 'chat', items: [{ key: target.key, answer: '部長です' }], remaining: [] } });
  assert(/まだ答えていない確認事項：「代理の承認者は誰にしますか？」/.test(calls.plan[2].revision.request), `S3b: 選ばなかった同じ論点の質問は未回答のまま伝える: ${calls.plan[2].revision.request}`);
});
await section(async () => {
  // S4: 作り直しの失敗・キャンセルの後に同じ回答を送り直すと、作り直す（「記録済み」で止めない）
  const { c, calls, ctl } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS))]);
  await startPlan(c);
  ctl.fail = 'TIMEOUT';
  await c.send('PCだけ');
  assert(KTAiConversation.classifyIntent('PCだけ', c.state).reason === 'ANSWER_PENDING', 'S4: 計画に入っていない回答の言い直しは ANSWER_PENDING（AI を使う送信。同意の確認を通る）');
  const r = await c.send('PCだけ');
  assert(r.ok && calls.plan.length === 3 && c.activePlan().version === 2 && answered(c)[0].appliedInVersion === 2 && !/そのほかの記述：PCだけ/.test(calls.plan[2].revision.request), `S4: 同じ回答の送り直しで作り直し、回答はその版に入る: ${calls.plan[2] && calls.plan[2].revision.request}`);
});
await section(async () => {
  // S6: 同じ論点の新しい回答が古い決定事項をすべて言い直したら、古い方は置き換え（PC / モバイルの決定事項は 1 件）
  const { c, calls } = makeConv([planWith(qs(QP)), planWith(qs({ question: 'モバイルでも保存を止めますか？', topic: 'save_block' })), planWith([])]);
  await startPlan(c);
  await c.send('PCだけ');
  const q = c.answerContext().open[0];
  await c.send('回答', { intentOverride: 'ANSWER', answerPayload: { source: 'answer-card', items: [{ key: q.key, answer: 'やっぱりモバイルも必要で、保存は止める' }] } });
  const plat = calls.plan[2].decisions.filter(d => d.topic === 'platform');
  assert(plat.length === 1 && plat[0].value.join() === 'desktop,mobile' && plat[0].previousAnswer === 'PCだけ' && c.ledger().some(e => e.status === 'superseded' && e.answer === 'PCだけ'), `S6: PC / モバイルの決定事項は 1 件（新しい回答・前の回答は履歴）: ${JSON.stringify(calls.plan[2].decisions)}`);
});
await section(async () => {
  // S7: 作り直しの間に別の経路で計画が最新になったら、待ちの表示を片づけ、受領の表示は「置き換わった」にする
  //   C-1 第 3 段: 最終案の差分更新（reviseWith の finalRevise）は読み込み中の表示（loading）を使わず進みのカードを出す。その場合も、置き換わりは
  //   superseded にする（「失敗しました（［再試行］…）」にしない）
  const { c, ctl } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS))]);
  await startPlan(c);
  const v1 = c.activePlan();
  const release = ctl.hold();
  const p = c.send('PCだけ');
  await tick();
  c.registerPlan({ plan: planWith(qs(QS)), basedOn: v1 });
  release();
  await p;
  const ack = c.messages().find(m => m.data?.kind === 'answers-ack');
  assert(!c.messages().some(m => m.type === 'LOADING') && ack.data.stage === 'superseded' && /置き換わった/.test(ack.text) && !/再試行/.test(ack.text), `S7: LOADING を残さない・［再試行］を約束しない: ${ack.text}`);
});
await section(async () => {
  // S8: 対応先が決まらない答えが 2 件あっても、同じ送信の「そのほかの記述」を失わない
  //   C-1 第 3 段: 対応先を 1 件ずつ選ぶ確認（answer-target・pendingClarification）は削除した（tests/ai-flow-redesign.test.js の F4・F7-1）。
  //   決まらない答えは決定事項にせず、そのほかの記述と一緒に 1 回の作り直しで計画の AI に渡す
  const { c, calls } = makeConv([planWith(qs(QS, '承認の設定も必要ですか？', '通知も必要ですか？')), planWith([])]);
  await startPlan(c);
  await c.send('いいえ。不要です。金額の表示はそのまま');
  const req = calls.plan[1] && calls.plan[1].revision ? calls.plan[1].revision.request : '';
  assert(calls.plan.length === 2 && /そのほかの記述：金額の表示はそのまま/.test(req) && /そのほかの記述：いいえ（どの確認事項への回答か決められなかった答え/.test(req) && /そのほかの記述：不要です（どの確認事項への回答か決められなかった答え/.test(req), `S8: 対応先が決まらない 2 件と、そのほかの記述を 1 回の作り直しで送る: ${req}`);
  assert(answered(c).length === 0 && !calls.plan[1].decisions.some(d => ['いいえ', '不要です'].includes(d.answer)) && c.metrics().unresolvedAnswers === 2 && !c.messages().some(m => m.data?.kind === 'answer-target'), 'S8: 対応先が決まらない答えは決定事項にしない（聞き返さない）');
});

// =========================================================
console.log('\n--- G. 再レビューで見つかった不具合の回帰 ---');
await section(async () => {
  const v = (questions) => ({ activePlan: { planId: 'p', version: 1, status: 'ACTIVE', plan: planWith(questions), review: { steps: [] } }, ledgers: new Map() });
  const cls = (t, s) => KTAiConversation.classifyIntent(t, s);
  const st = v(qs(QP, QA, { question: '注意はどこに表示しますか？', topic: 'location' }, QT));
  for (const t of ['PCの画面で金額を赤くして', '顧客一覧から住所を取り込みたい', '部長の承認が終わったら担当者にメールしたい', '入力時に顧客コードから顧客名を表示したい']) assert(cls(t, st).intent !== 'ANSWER', `R1: 論点の語を含むだけの依頼は回答にしない:「${t}」→ ${cls(t, st).intent}`);
  const keep = [['保存を止めてください', v(qs(QS))], ['部長でお願いします', v(qs(QA))], ['PCだけでいいです', v(qs(QP))], ['詳細画面の上', v(qs({ question: '注意はどこに表示しますか？', topic: 'location' }))], ['エラーにして保存させない', v(qs(QS))], ['両方', v(qs(QP))]];
  for (const [t, s] of keep) assert(cls(t, s).intent === 'ANSWER', `R1: 回答の言い方は回答のまま:「${t}」→ ${cls(t, s).intent}`);
  assert(KTAiAnswers.interpret({ text: '両方', open: [{ key: 'Q1', text: QS, topics: ['save_block'] }, { key: 'Q2', text: QP, topics: ['platform'] }], decided: [], isRequest }).answers.length === 0, 'R1: 「両方」は PC / モバイル以外の質問も残っているときは PC / モバイルの答えにしない');
});
await section(async () => {
  // R2: 「やっぱり両方」で PC / モバイルの決定事項を更新する（論点の語が無くても）
  const { c, calls } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS)), planWith([])]);
  await startPlan(c);
  await c.send('PCだけ');
  const r = await c.send('やっぱり両方');
  const d = calls.plan[2] && calls.plan[2].decisions.find(x => x.topic === 'platform');
  assert(r.intent === 'ANSWER' && d && d.value.join() === 'desktop,mobile' && d.previousAnswer === 'PCだけ', `R2: 「やっぱり両方」は PC / モバイルの決定事項の更新: ${JSON.stringify(d)}`);
});
await section(async () => {
  // E1（固定会話の評価で発見）: 質問の無い論点についての答えだけの文（「保存は止めない」）は追加の条件として記録して作り直す（選び直しを要らなくする）
  const { c, calls } = makeConv([planWith(qs(QP, QT)), planWith(qs(QT)), planWith([])]);
  await startPlan(c);
  await c.send('PCだけ');
  const r = await c.send('保存は止めない');
  assert(r.intent === 'ANSWER' && calls.plan.length === 3 && calls.plan[2].decisions.some(d => d.kind === 'condition' && d.topic === 'save_block' && d.answer === '保存は止めない') && /追加の条件：保存は止めない/.test(calls.plan[2].revision.request), `E1: 「保存は止めない」は追加の条件として作り直す: ${r.intent} ${calls.plan[2] && calls.plan[2].revision.request}`);
  const st = { activePlan: c.activePlan(), ledgers: c.state.ledgers };
  assert(KTAiConversation.classifyIntent('モバイルの通知はいらない', st).intent !== 'ANSWER' && KTAiConversation.classifyIntent('保存時の警告の文言を変えて', st).intent !== 'ANSWER', 'E1: 論点の語を含むだけの依頼は従来どおり（条件にしない）');
});
await section(async () => {
  // R2b: 決定済みの論点を修正の依頼で言い直したら、新しい依頼が正（古い決定事項を送り続けない）。PC / モバイルは範囲をはっきり言う文のときだけ
  const { c, calls } = makeConv([planWith(qs(QT, QP)), planWith([]), planWith([]), planWith([])]);
  await startPlan(c);
  await c.send('保存時です。PCだけ');
  await c.send('保存時と金額の変更時', { intentOverride: 'REVISE_PLAN' });
  assert(!calls.plan[2].decisions.some(d => d.topic === 'timing') && calls.plan[2].decisions.some(d => d.topic === 'platform' && d.answer === 'PCだけ'), `R2b: 「保存時と金額の変更時」の後は、古いタイミングの決定事項を送らない（PC / モバイルは残る）: ${JSON.stringify(calls.plan[2].decisions)}`);
  await c.send('PCの画面で金額を赤くして', { intentOverride: 'REVISE_PLAN' });
  assert(calls.plan[3].decisions.some(d => d.topic === 'platform' && d.answer === 'PCだけ'), 'R2b: 「PCの画面で…」のように PC に触れるだけの依頼では、PC / モバイルの決定事項を外さない');
});
await section(async () => {
  // R3: 別の論点への答えに「PC」の語が入るだけでは PC / モバイルの決定事項を置き換えない
  const { c, calls } = makeConv([planWith(qs(QP)), planWith(qs({ question: '注意はどこに表示しますか？', topic: 'location' })), planWith([])]);
  await startPlan(c);
  await c.send('PCとモバイルの両方です');
  await c.send('PCでは金額欄の横です');
  const ds = calls.plan[2].decisions;
  const plat = ds.filter(x => x.topic === 'platform');
  assert(plat.length === 1 && plat[0].value.join() === 'desktop,mobile' && ds.some(x => x.topic === 'location' && !x.value && !x.previousAnswer) && !c.messages().some(m => m.data?.kind === 'decision-conflict'), `R3: PC / モバイルの決定事項は両方のまま、表示する場所は別の決定事項: ${JSON.stringify(ds)}`);
});
await section(async () => {
  // R4: 「やっぱり…」は追加の条件より質問への答えの項目を更新する
  const { c, calls } = makeConv([planWith(qs(QP)), planWith([]), planWith([])]);
  await startPlan(c);
  await c.send('PCだけ。モバイルは保存時にチェック');
  await c.send('やっぱりモバイルも必要');
  const ds = calls.plan[2].decisions;
  assert(ds.some(x => x.kind === 'question' && x.topic === 'platform' && x.answer === 'やっぱりモバイルも必要' && x.previousAnswer === 'PCだけ') && ds.some(x => x.kind === 'condition' && x.answer === 'モバイルは保存時にチェック'), `R4: 質問への答え（PCだけ）を更新し、条件は残す: ${JSON.stringify(ds)}`);
});
await section(async () => {
  // R5: 再確認の質問に変更の言い方で答えたら、決定事項の変更
  const V2 = planWith(qs({ question: '部長の承認が既存の流れと重なります。承認者は部長でよいですか？', decisionRef: 'D1', reason: '既存の承認と重なる' }));
  const { c, calls } = makeConv([planWith(qs(QA)), V2, planWith([])]);
  await startPlan(c);
  await c.send('部長です');
  const q = c.answerContext().open[0];
  await c.send('回答', { intentOverride: 'ANSWER', answerPayload: { source: 'answer-card', items: [{ key: q.key, answer: '部長ではなく課長です' }] } });
  const d1 = calls.plan[2].decisions.find(x => x.id === 'D1');
  assert(d1 && d1.answer === '部長ではなく課長です' && d1.previousAnswer === '部長です' && d1.status === 'answered', `R5: 「部長ではなく課長です」は D1 の変更: ${JSON.stringify(calls.plan[2].decisions)}`);
});
await section(async () => {
  // R6: 同じ決定事項を指す再確認の質問が 2 つあっても、回答欄のキーは別（版と Q 番号）
  //   C-1 第 3 段: 回答欄は最終案のカードの「残る判断」（先に決めたいこと priority blocking）だけに出る（R10）ので、2 つとも blocking にする
  const V2 = planWith(qs({ question: '承認者は部長でよいですか？', decisionRef: 'D1', reason: 'r1', priority: 'blocking' }, { question: '代理の承認者も部長でよいですか？', decisionRef: 'D1', reason: 'r2', priority: 'blocking' }));
  const { c } = makeConv([planWith(qs(QA)), V2]);
  await startPlan(c);
  await c.send('部長です');
  const v2 = c.activePlan();
  const html = KTAiChatUi.chatHtml(c.messages(), { plans: new Map(c.planHistory().map(x => [`${x.planId}:${x.version}`, x])), activePlan: v2, answers: new Map(), answerState: c.answerContext(), ledger: c.ledger() }, { showAll: true });
  const keys = [...html.matchAll(/data-qkey="([^"]+)"/g)].map(m => m[1]);
  assert(keys.length === 2 && new Set(keys).size === 2 && keys.every(k => k.includes(':2:')), `R6: 再確認の質問の回答欄は別々のキー（版と Q 番号）: ${keys.join(' / ')}`);
});
await section(async () => {
  // R7: 対応先の決まらない部分とそのほかの記述も送る（黙って捨てない・確定しない）
  //   C-1 第 3 段: 対応先を聞き返して待つ状態（pendingClarification）は無くなった（tests/ai-flow-redesign.test.js の F4・F7-1）。
  //   決まらない「いいえ」は、その送信の作り直しでそのほかの記述として送る。次の回答（PCだけ）でも「いいえ」を決定事項にしない
  const { c, calls } = makeConv([planWith(qs(QP, QS, '承認の設定も必要ですか？')), planWith(qs(QP, QS, '承認の設定も必要ですか？')), planWith([])]);
  await startPlan(c);
  await c.send('いいえ。金額の表示はそのまま');
  const req = calls.plan[1] && calls.plan[1].revision.request;
  assert(calls.plan.length === 2 && /そのほかの記述：金額の表示はそのまま/.test(req) && /そのほかの記述：いいえ/.test(req) && !calls.plan[1].decisions.some(d => d.answer === 'いいえ') && !c.messages().some(m => m.data?.kind === 'answer-target'), `R7: 対応先の決まらない「いいえ」は決定事項にせず、そのほかの記述として送る: ${req}`);
  await c.send('PCだけ');
  assert(calls.plan.length === 3 && calls.plan[2].decisions.some(d => d.topic === 'platform' && d.answer === 'PCだけ') && !calls.plan[2].decisions.some(d => d.answer === 'いいえ'), `R7: 続けて答えても、決まらなかった「いいえ」は決定事項にならない: ${JSON.stringify(calls.plan[2] && calls.plan[2].decisions)}`);
});
await section(async () => {
  // R8: 同じ論点の別の質問は、片方に答えても「変更」にも「再質問」にもしない
  const QD = { question: '代理の承認者は誰にしますか？', topic: 'approver' };
  const { c, calls, last } = makeConv([planWith(qs({ question: QA, topic: 'approver' }, QD)), planWith(qs(QD)), planWith([])]);
  await startPlan(c);
  const target = c.answerContext().open.find(x => x.text === QA);
  await c.send('選択', { intentOverride: 'ANSWER', answerPayload: { source: 'chat', items: [{ key: target.key, answer: '部長です' }], remaining: [] } });
  assert(open(c).includes(QD.question) && c.metrics().reasked === 0, `R8: 次の版で聞かれた同じ論点のまだ答えていない質問は、再質問として隠さない: open=${open(c).join(' / ')}`);
  await c.send('課長です');
  const ds = calls.plan[2].decisions.filter(d => d.topic === 'approver');
  assert(ds.length === 2 && ds.some(d => d.answer === '部長です' && !d.previousAnswer) && ds.some(d => d.answer === '課長です' && !d.previousAnswer), `R8: 別の質問への答えは前の回答を置き換えない: ${JSON.stringify(ds)}`);
});
await section(async () => {
  // R9: AI が再確認を取り下げて回答済みに戻った決定事項は、その版の生成に渡す
  //   C-1 第 3 段: 最終案のパイプラインは、customization が同じなら検証済みの JavaScript を流用する（canReuse）。ただし前の生成に渡さなかった決定事項
  //   （v2 で再確認中だった D1）が回答済みに戻ったとき・答えが変わったときは流用せず、v3 の生成に D1 を渡す（決定事項が増えただけなら流用する。R10・R11）
  const cust = (platform) => ({ customizationId: 'C1', requirement: 'r', whyStandardInsufficient: 'w', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform, events: ['app.record.create.show'], fields: [], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [], confidence: 'INFERRED' });
  const V2 = planWith(qs({ question: '外出先でも入力するとのことですが、PCだけでよいですか？', decisionRef: 'D1', reason: 'r' }), { solution: 'CUSTOMIZATION', steps: [], customizations: [cust(['desktop'])] });
  const V3 = planWith([], { solution: 'CUSTOMIZATION', steps: [], customizations: [cust(['desktop'])] });
  const { c, calls } = makeConv([planWith(qs(QP), { solution: 'CUSTOMIZATION', steps: [], customizations: [cust([])] }), V2, V3], { review: false });
  await startPlan(c);
  await c.send('PCだけ');
  await c.send('金額の表示は赤字にして', { intentOverride: 'REVISE_PLAN' });
  //   C-1 第 3 段: v3 の JavaScript は v3 の最終案を作るときに生成する（仕様の確定と「C1 のコードを作って」は不要）
  const v3 = c.activePlan();
  const g3 = calls.generate[calls.generate.length - 1];
  assert(v3.version === 3 && v3.final && calls.generate.length === 3 && g3.decisions.some(d => d.id === 'D1' && d.status === 'answered' && !d.reconfirmReason), `R9: 回答済みに戻った D1 を、その版（v3）の生成に渡す: ${JSON.stringify(calls.generate.map(g => g.decisions))}`);
});

// =========================================================
console.log('\n--- H. 質問の AI に渡す未回答の確認事項（2026-10-23）: 画面の未回答（answerContext。台帳の項目の今の status）と同じ判定で作る ---');
//   版の写し（v.openQuestions）は計画の版を登録した時点（registerPlan の syncQuestions の結果）のままで、その後に回答欄・チャットで答えても変わらない。
//   回答してから作り直しが終わるまでの間（H1）と、作り直しが失敗した後（H2）の質問で、答えた質問を未回答として質問の AI に送っていた
const askedPlan = (calls) => calls.ask[0] && calls.ask[0].conversation && calls.ask[0].conversation.plan;
const askedQuestions = (calls) => (askedPlan(calls) && askedPlan(calls).questions || []).map(x => x.question);
await section(async () => {
  // H1: 回答を記録 → 作り直しの途中（計画の AI の応答待ち）に質問 → 質問の AI に渡す plan.questions は画面の未回答と同じ
  const { c, calls, ctl } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS))]);
  await startPlan(c);
  const release = ctl.hold();
  const p = c.send('PCだけ');
  await tick();
  const v1 = c.activePlan();
  assert(c.isBusy() && v1.version === 1 && answered(c).length === 1 && open(c).join('|') === QS && (v1.openQuestions || []).map(q => q.text).join('|') === `${QP}|${QS}`, `前提: 回答を記録して作り直しの途中。画面の未回答は保存の質問だけ・版の写し（openQuestions）には PC / モバイルの質問が残る: open=${open(c).join(' / ')}`);
  const q = await c.send('このフィールドは何に使ってる？');
  await tick();
  assert(q && q.asked === true && calls.ask.length === 1 && askedPlan(calls) && askedPlan(calls).version === 1, `前提: 作り直しの途中の質問は作業と並べて質問の AI へ（今の計画 v1 を渡す）: ${JSON.stringify({ asked: q && q.asked, asks: calls.ask.length, version: askedPlan(calls) && askedPlan(calls).version })}`);
  assert(askedQuestions(calls).join('|') === QS && !askedQuestions(calls).includes(QP), `H1: 質問の AI に渡す未回答の確認事項は画面の未回答と同じ（答えた PC / モバイルの質問を未回答として送らない）: ${JSON.stringify(askedQuestions(calls))}`);
  release(); await p; await tick();
  assert(c.activePlan().version === 2 && open(c).join('|') === QS, '後始末: 作り直しは v2 で終わり、未回答は保存の質問だけ');
});
await section(async () => {
  // H2: 作り直しが失敗した後（版は v1 のまま・回答は記録したまま）の質問
  const { c, calls, ctl } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS))]);
  await startPlan(c);
  ctl.fail = 'TIMEOUT';
  const r = await c.send('PCだけ');
  assert(!r.ok && !c.isBusy() && c.activePlan().version === 1 && answered(c).length === 1 && open(c).join('|') === QS, `前提: 作り直しの失敗。版は v1 のまま・回答は記録したまま（画面の未回答は保存の質問だけ）: open=${open(c).join(' / ')}`);
  const q = await c.send('このフィールドは何に使ってる？');
  assert(q && q.intent === 'ASK' && calls.ask.length === 1 && askedPlan(calls) && askedPlan(calls).version === 1 && askedQuestions(calls).join('|') === QS, `H2: 失敗の後の質問にも、答えた質問を未回答として送らない: ${JSON.stringify(askedQuestions(calls))}`);
});
await section(async () => {
  // H3: 回答の無い計画（最初の版のまま）の質問は今までどおり、その版の確認事項をすべて渡す（判定をそろえても減らない）
  const { c, calls } = makeConv([planWith(qs(QP, QS))]);
  await startPlan(c);
  const q = await c.send('このフィールドは何に使ってる？');
  assert(q && q.intent === 'ASK' && calls.ask.length === 1 && askedQuestions(calls).join('|') === `${QP}|${QS}` && askedPlan(calls).questions.every(x => /^Q[0-9]+$/.test(x.id)), `H3: 答えていない確認事項はすべて渡す（id と question の形は変えない）: ${JSON.stringify(askedPlan(calls).questions)}`);
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
