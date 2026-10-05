// 複雑な指示を取りこぼさない・確認の基準（2026-10-05 第 3 段）: 発言の振り分け・要件の台帳・質問の部分を同時に答える・仮の案・確定して作る
//
// 検証内容（状態遷移。AI の振る舞いと待ち時間は staging の代表会話で別に計測する: AI版 docs/release/toolkit-ai-conversation-eval.md）:
//   C 振り分け: 質問とそれ以外が混ざった発言（質問の部分は同時に質問の AI へ）/ 操作の語が要件の文に混ざっているだけなら操作にしない
//      （「副部長が承認します」は反映へ進む言葉ではない・「取り消します」は元に戻す操作ではない）/ 命令だけの文は従来どおり / 「…変えて、コードも作って」/
//      修正できる計画があるときの自由な文は計画の AI へ（「修正ですか、新しい計画ですか」と聞き返さない）/ 挨拶・質問だけの文は計画を作り直さない
//   F 会話: 計画の AI の要件の操作を台帳へ（根拠の無い決定は提案に下げる・取り消しは今回の発言に根拠が要る・取り消しも計画の AI に渡す）/
//      扱いが示されなかった文は未解決の要件として残し知らせる / 返答（理解した内容）と要件の変化を計画の前に出す / 質問の部分は同時に答え、計画の AI には
//      「質問には別に答える」/ 質問の AI に会話の現在の要件と計画を渡す / 仮の案 / 確定して作る（古い版のコードを作らない）/ 確認事項の追加の項目
//
// 実行方法: node tests/ai-requirements.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { KTDeps, KTAiConversation, KTAiAnswers, KTPlanReview } = loadToolkit();
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');

const DATA = FX.makeData();
const DEPS = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
const I = KTAiConversation.INTENT;
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
const step = (id, actionType, targetKind, targetRef, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' }, ...extra });
const qs = (...texts) => texts.map((t, i) => (typeof t === 'string' ? { id: `Q${i + 1}`, question: t, reason: '', relatedEvidenceIds: [] } : { id: `Q${i + 1}`, reason: '', relatedEvidenceIds: [], ...t }));
const cust = (o = {}) => ({ customizationId: 'C1', requirement: '金額が100万円を超えたら警告を出す', whyStandardInsufficient: '入力中の警告は標準設定に無い', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: ['desktop'], events: ['app.record.create.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [], ...o });
const CSTEP = step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', '', { customizationId: 'C1' }, { solution: 'CUSTOMIZATION' });
const planWith = (questions, extra = {}) => ({ goal: '金額が100万円を超えたら画面に警告を出したい', solution: 'HYBRID', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps: [step('P1', 'ADD_VIEW', 'VIEW', '高額案件', { name: '高額案件', fields: ['amount'] }), CSTEP], alternatives: [], impact: [], questions, unknowns: [], planConfidence: 'NEEDS_CONFIRMATION', customizations: [cust()], provisionals: [], ...extra });
const QP = { question: '対象は PC だけですか？モバイルでも使いますか？', topic: 'platform' };
const QS = { question: '金額が大きいとき、保存を止めますか？', topic: 'save_block' };
const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };
const OP = (o = {}) => ({ op: 'add', id: '', target: '金額フィールド', condition: '', behavior: 'x', exceptions: [], decision: 'decided', disposition: 'adopted', sourceQuotes: [], planRefs: ['C1'], note: '', ...o });
/**
 * 会話（fake services）。steps[n] = 計画の n+1 回目の呼び出しの { plan, turn }。ask は呼ばれた引数を記録して答える
 */
function makeConv(steps, { askAnswer = 'JavaScript は画面の操作だけで動き、CSV の読み込みでは動きません。' } = {}) {
  const calls = { plan: [], ask: [], generate: 0 };
  let t = 1000;
  // hold(): 次の計画・生成の呼び出しを待たせる / holdAsk(): 次の質問の呼び出しを待たせる
  const gates = [], askGates = [];
  const ctl = { hold() { let o; gates.push(new Promise(r => { o = r; })); return o; }, holdAsk() { let o; askGates.push(new Promise(r => { o = r; })); return o; } };
  const services = {
    async plan(args) {
      const n = calls.plan.length;
      calls.plan.push(JSON.parse(JSON.stringify({ goal: args.goal, revision: args.revision || null, requirements: args.requirements || null, decisions: args.decisions || null })));
      const g = gates.shift(); if (g) await g;
      const s = steps[Math.min(n, steps.length - 1)];
      // fail: 計画を作れなかった応答 / cancel: 取り消し（例外）
      if (s.fail) return JSON.parse(JSON.stringify(s.fail));
      if (s.cancel) throw Object.assign(new Error('取り消しました'), { name: 'AbortError', code: 'CANCELLED' });
      const p = JSON.parse(JSON.stringify(s.plan));
      t += 15000;
      return { plan: p, ctx: { facts: [] }, review: KTPlanReview.review({ plan: p, data: DATA, deps: DEPS, scan: null, incoming: null }), gatewayPlan: { ...JSON.parse(JSON.stringify(p)), gw: n + 1 }, revisionMeta: args.revision ? { requested: args.revision.mode || 'full', mode: args.revision.mode || 'full', fallbackReason: null } : null, turn: s.turn || null };
    },
    revisionModes: () => ['full', 'patch'],
    conversationFeatures: () => ['requirements', 'brief'],
    async ask(args) { const ga = askGates.shift(); if (ga) await ga; calls.ask.push(JSON.parse(JSON.stringify({ question: args.question, conversation: args.conversation || null }))); return { ok: true, answer: { answer: askAnswer, facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx: { facts: [] } }; },
    async generate() { const g = gates.shift(); if (g) await g; calls.generate++; return { ok: true, generated: { code: '' }, review: { status: 'OK', checks: [] } }; },
    readiness(v) { return { approved: 0, executable: 0, unsupported: 0, blocked: 0, undecided: v.plan.steps.length }; },
  };
  const c = KTAiConversation.create({ services, now: () => '2026-10-05T00:00:00.000Z', clock: () => t });
  const kinds = () => c.messages().map(m => m.data?.kind || m.type);
  const byKind = (k) => c.messages().filter(m => m.data?.kind === k);
  return { c, calls, ctl, kinds, byKind, ledger: () => c.state.ledgers.get(c.activePlan().planId) };
}

(async () => {
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e}`); } }

// =========================================================
console.log('\n--- C. 振り分け（文の形と、はっきりした操作の命令だけを正規表現で決める） ---');
await section(async () => {
  const v = { planId: 'p', version: 1, status: 'ACTIVE', plan: planWith(qs(QP, QS)), review: { steps: [] }, spec: { status: 'DRAFT', version: 1 } };
  const st = { activePlan: v, ledgers: new Map() };
  const cls = (t, s = st) => KTAiConversation.classifyIntent(t, s);
  const e1 = cls('PCだけ。保存は止めない。ところでCSVの読み込みにも効きますか？');
  assert(e1.intent === I.ANSWER && e1.reason === 'ANSWERS' && /CSV/.test(e1.askText || '') && e1.answers.answers.length === 2, `C1: 回答＋条件＋質問 → 回答（PC・保存の 2 つ）と、質問の部分は同時に質問の AI へ（以前は全体が ASK で回答が失われた）: ${JSON.stringify({ intent: e1.intent, askText: e1.askText, n: e1.answers && e1.answers.answers.length })}`);
  const e5 = cls('部長が不在のときは副部長が承認します');
  assert(e5.intent === I.REVISE_PLAN && e5.reason === 'TURN', `C2: 「副部長が承認します」は反映へ進む言葉ではない → 計画の AI へ（以前は REQUEST_PREVIEW で代理の指示が落ちた）: ${e5.intent}/${e5.reason}`);
  const withExec = { ...st, activeExecution: { executionId: 'x', written: true, rolledBack: false } };
  const e3 = cls('警告の文の指定は取り消します。文はおまかせで', withExec);
  assert(e3.intent === I.REVISE_PLAN && e3.reason === 'TURN', `C3: 「指定は取り消します」は元に戻す操作ではない → 計画の AI へ（以前は GENERAL で何もしなかった）: ${e3.intent}/${e3.reason}`);
  assert(cls('反映して').intent === I.REQUEST_PREVIEW && cls('これで進めて').intent === I.REQUEST_PREVIEW && cls('全部承認').intent === I.REQUEST_PREVIEW && cls('元に戻して', withExec).intent === I.REQUEST_ROLLBACK && cls('やっぱり元に戻して', withExec).intent === I.REQUEST_ROLLBACK && cls('コードを作って').intent === I.GENERATE_CODE && cls('C1 のコードを作って').intent === I.GENERATE_CODE, 'C4: 命令だけの文は従来どおり（反映へ進む・元に戻す・コードを作る）');
  const e10 = cls('100万円ちょうども警告の対象に変えて、コードも作って');
  assert(e10.intent === I.REVISE_PLAN && e10.reason === 'TURN_THEN_GENERATE' && e10.alsoGenerate === true, `C5: 「条件を変えて、コードも作って」→ 先に計画を更新して検証し、最新の仕様でコードを作る（以前は「仕様を直してから作りますか？」）: ${e10.intent}/${e10.reason}`);
  assert(cls('ありがとう').intent === I.GENERAL, 'C6: 挨拶は計画の AI を呼ばない');
  const np = cls('金額チェックを入れたい。CSVにも効きますか？', { activePlan: null, ledgers: new Map() });
  assert(np.intent === I.PLAN && /CSV/.test(np.askText || ''), `C7: 計画が無いときの依頼＋質問 → 計画を作り、質問の部分は同時に答える: ${np.intent} ${np.askText}`);
  const onlyQ = cls('この警告は一覧画面でも出ますか？');
  assert([I.ASK, I.EXPLAIN_PLAN].includes(onlyQ.intent), `C8: 質問だけの文は計画を作り直さない（ASK / 説明）: ${onlyQ.intent}`);
  const nr = cls('契約終了30日前に担当者へ通知したい');
  assert(nr.intent === I.REVISE_PLAN && nr.reason === 'TURN', 'C9: 修正できる計画があるときの新しい要望は、聞き返さずに計画の AI へ（要件として追加）');
});

// =========================================================
console.log('\n--- F. 会話（要件の台帳・質問の部分を同時に・返答と要件の変化・仮の案・確定して作る） ---');
await section(async () => {
  // F1: 回答＋条件＋質問。質問の部分は同時に質問の AI（会話の要件と計画つき）、回答の部分は差分で更新（計画の AI に「質問には別に答える」）
  const goal = '金額が100万円を超えたら画面に警告を出したい';
  const t1 = { reply: '金額が100万円を超えたら警告を出す計画にしました。', requirementOps: [OP({ condition: '金額が100万円を超える', behavior: '画面に警告を出す', sourceQuotes: ['金額が100万円を超えたら画面に警告を出したい'] })], utteranceCoverage: [{ quote: goal, as: 'requirement', refs: [], note: '' }] };
  const t2 = { reply: 'PC だけにし、保存は止めないようにしました。', requirementOps: [OP({ target: '作成・編集画面', behavior: 'PC だけで動く', sourceQuotes: ['PCだけ'] }), OP({ behavior: '保存は止めない', sourceQuotes: ['保存は止めない'] })], utteranceCoverage: [{ quote: 'PCだけ', as: 'answer', refs: [], note: '' }, { quote: '保存は止めない', as: 'answer', refs: [], note: '' }] };
  const { c, calls, byKind, ledger } = makeConv([{ plan: planWith(qs(QP, QS)), turn: t1 }, { plan: planWith([]), turn: t2 }]);
  await c.send(goal);
  const lg1 = ledger();
  assert(KTAiAnswers.requirementsOf(lg1).map(e => `${e.id}:${e.decision}`).join() === 'R1:decided' && byKind('turn-reply').length === 1 && byKind('requirements-changes').length === 1, `F1: 最初の依頼の要件を台帳へ（根拠の発言は依頼の文）・返答と要件の変化を出す: ${JSON.stringify(KTAiAnswers.requirementsOf(lg1).map(e => e.id + ':' + e.decision))}`);
  await c.send('PCだけ。保存は止めない。ところでCSVの読み込みにも効きますか？');
  await ticks();
  const rev = calls.plan[1].revision;
  const aq = calls.ask.find(a => /CSV/.test(a.question));
  assert(calls.ask.length === 2 && calls.ask[0].conversation.brief === true && aq && aq.conversation && aq.conversation.requirements.some(r => r.id === 'R1') && aq.conversation.plan && aq.conversation.working === 'REVISE', `F1: 質問の部分は同時に質問の AI へ（会話の現在の要件と計画・作業中を渡す。1 回目は最初の計画の先回りの返答）: ${JSON.stringify(calls.ask.map(a => ({ q: a.question.slice(0, 12), w: a.conversation && a.conversation.working })))}`);
  assert(rev.mode === 'patch' && rev.questionsAnsweredSeparately === true && Array.isArray(rev.utterances) && /PCだけ/.test(rev.utterances[0]) && !/CSV/.test(rev.utterances[0]) && calls.plan[1].requirements.some(r => r.id === 'R1'), `F1: 回答の部分は差分で更新し、計画の AI には要件と今回の発言・「質問には別に答える」を渡す: ${JSON.stringify({ mode: rev.mode, sep: rev.questionsAnsweredSeparately, utt: rev.utterances })}`);
  assert(c.messages().some(m => m.data?.kind === 'aside-answer' && /CSV/.test(m.text)) && c.activePlan().version === 2 && KTAiAnswers.requirementsOf(ledger()).length === 3, 'F1: 質問への答えを出し、計画は v2 に更新・要件は 3 件（回答の 2 つが要件にも入る）');
  assert(c.metrics().asideAsks === 2 && c.metrics().requirementOps === 3, `F1: 計測（同時に答えた質問・要件の操作）: ${JSON.stringify({ asideAsks: c.metrics().asideAsks, requirementOps: c.metrics().requirementOps })}`);
});
await section(async () => {
  // F2: 根拠の発言が利用者の文に無い「決定」は提案に下げる・扱いが示されなかった文は未解決として残す
  const goal = '見積の金額チェックを入れたいです。100万円を超える場合は警告だけ出して、保存はそのまま通してください。あと、明細の小計の合計と金額がずれていたら知らせてほしいです。';
  const t1 = { reply: '金額のチェックと警告の計画にしました。', requirementOps: [OP({ condition: '100万円を超える', behavior: '警告だけ出し、保存は止めない', sourceQuotes: ['100万円を超える場合は警告だけ出して'] }), OP({ behavior: '承認者は部長', sourceQuotes: ['部長が承認する'] })], utteranceCoverage: [{ quote: '見積の金額チェックを入れたいです', as: 'requirement', refs: [], note: '' }, { quote: '100万円を超える場合は警告だけ出して、保存はそのまま通してください', as: 'requirement', refs: [], note: '' }] };
  const { c, byKind, ledger } = makeConv([{ plan: planWith([]), turn: t1 }]);
  await c.send(goal);
  const reqs = KTAiAnswers.requirementsOf(ledger());
  assert(reqs[0].decision === 'decided' && reqs[1].decision === 'proposed', `F2: 利用者の文に無い根拠の「決定」は提案（proposed）に下げる: ${reqs.map(e => e.decision).join()}`);
  const un = reqs.filter(e => e.disposition === 'unresolved' && e.origin === 'toolkit');
  assert(un.length === 1 && /明細の小計の合計と金額がずれていたら/.test(un[0].behavior) && byKind('requirements-unresolved').length === 1 && /計画に入っていない可能性がある指示/.test(byKind('requirements-unresolved')[0].text), `F2: 計画の AI が扱いを示さなかった文は、黙って捨てずに未解決の要件として残し知らせる: ${JSON.stringify(un.map(e => e.behavior))}`);
  assert(c.metrics().unresolvedClauses === 1, 'F2: 計測（扱いが示されなかった文）');
});
await section(async () => {
  // F3: 取り消し（今回の発言に根拠が要る）。取り消した要件も計画の AI に渡す（戻させない）
  const goal = '金額が100万円を超えたら画面に警告を出したい';
  const t1 = { reply: 'r', requirementOps: [OP({ behavior: '警告の文は「高額案件です」', sourceQuotes: ['金額が100万円を超えたら画面に警告を出したい'] })], utteranceCoverage: [{ quote: goal, as: 'requirement', refs: [], note: '' }] };
  const t2 = { reply: '警告の文の指定を取り消しました。', requirementOps: [OP({ op: 'revoke', id: 'R1', behavior: '', sourceQuotes: ['警告の文の指定は取り消します'] })], utteranceCoverage: [{ quote: '警告の文の指定は取り消します', as: 'revocation', refs: ['R1'], note: '' }, { quote: '文はおまかせで', as: 'revocation', refs: ['R1'], note: '' }] };
  const t3 = { reply: 'x', requirementOps: [OP({ op: 'revoke', id: 'R1', behavior: '', sourceQuotes: ['警告の文の指定は取り消します'] })], utteranceCoverage: [] };
  const { c, calls, byKind, ledger } = makeConv([{ plan: planWith([]), turn: t1 }, { plan: planWith([]), turn: t2 }, { plan: planWith([]), turn: t3 }]);
  await c.send(goal);
  await c.send('警告の文の指定は取り消します。文はおまかせで');
  const r1 = KTAiAnswers.requirementsOf(ledger()).find(e => e.id === 'R1');
  assert(r1.decision === 'revoked' && r1.history.length === 1 && byKind('requirements-changes').some(m => /取り消し R1/.test(m.text)), `F3: 今回の発言に根拠のある取り消しは要件を取り消し済みにする（消さずに残す・履歴）: ${r1.decision}`);
  await c.send('一覧の列に金額を足して');
  assert(calls.plan[2].requirements.some(r => r.id === 'R1' && r.decision === 'revoked'), 'F3: 取り消した要件も計画の AI に渡す（戻させない）');
  const lg = KTAiAnswers.createLedger('x');
  KTAiAnswers.applyRequirementOps(lg, [OP({ behavior: 'a', sourceQuotes: ['abc def'] })], { version: 1, userTexts: ['abc def'], utterances: ['abc def'] });
  const r = KTAiAnswers.applyRequirementOps(lg, [OP({ op: 'revoke', id: 'R1', sourceQuotes: ['abc def'] })], { version: 2, userTexts: ['abc def', '別の文'], utterances: ['別の文'] });
  assert(!r.revoked.length && KTAiAnswers.requirementsOf(lg)[0].decision === 'decided', 'F3: 今回の発言に根拠の無い取り消しは適用しない（AI が勝手に要件を消さない）');
});
await section(async () => {
  // F4: 「条件を変えて、コードも作って」→ 計画を更新 → ［この変更で確定してコードを作る］。古い版の仕様でコードを作らない
  const { c, calls, byKind } = makeConv([{ plan: planWith([]) }, { plan: planWith([], { customizations: [cust({ requirement: '金額が100万円以上なら警告を出す', fields: [{ code: 'amount', access: 'CONTROL', condition: 'amount >= "1000000"' }] })] }) }]);
  await c.send('金額が100万円を超えたら画面に警告を出したい');
  const v1 = c.activePlan(); c.confirmSpec({ planId: v1.planId, version: v1.version });
  await c.send('100万円ちょうども警告の対象に変えて、コードも作って');
  const card = byKind('confirm-generate')[0];
  assert(calls.generate === 0 && c.activePlan().version === 2 && card && card.data.version === 2 && c.activePlan().spec.status === 'DRAFT' && calls.plan[1].revision.mode === 'patch', 'F4: 先に計画を更新して検証し、変わった仕様を確かめてから作る 1 回の操作を出す（古い仕様のコードは作らない）');
});
await section(async () => {
  // F5: 「部長が不在のときは副部長が承認します」は計画の AI へ（反映へ進まない）。仮の案を出す
  const t2 = { reply: '代理の承認者を副部長にしました。', requirementOps: [OP({ target: '承認（プロセス管理）', condition: '部長が不在のとき', behavior: '副部長が代わりに承認する', sourceQuotes: ['部長が不在のときは副部長が承認します'] })], utteranceCoverage: [{ quote: '部長が不在のときは副部長が承認します', as: 'requirement', refs: [], note: '' }] };
  const { c, calls, byKind, kinds } = makeConv([{ plan: planWith([]) }, { plan: planWith([], { provisionals: [{ id: 'A1', topic: 'location', choice: '警告は金額欄に表示', reason: '入力中に気づける', changeHint: '別の場所にしたいときは伝えてください' }] }), turn: t2 }]);
  await c.send('100万円以上の案件は承認を必須にしたい');
  await c.send('部長が不在のときは副部長が承認します');
  assert(calls.plan.length === 2 && !kinds().includes('preview-ready') && byKind('turn-reply').some(m => /副部長/.test(m.text)) && byKind('requirements-changes').some(m => /副部長が代わりに承認する/.test(m.text)), 'F5: 代理の承認者の指示は計画の AI へ（反映へ進む言葉にしない）・返答と要件の変化を出す');
  assert(byKind('provisionals').length === 1 && /仮の案で進めています/.test(byKind('provisionals')[0].text) && /警告は金額欄に表示/.test(byKind('provisionals')[0].text), 'F5: 後から変えられる点は仮の案として知らせる（質問しない）');
});
await section(async () => {
  // F6: 確認事項の追加の項目（答えで何が変わるか・候補・推奨・先に聞くか）を台帳の確認事項に持ち回る
  const lg = KTAiAnswers.createLedger('q');
  const s = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs({ question: '100万円以上の承認者は誰にしますか？', topic: 'approver', impact: '承認の流れの作業者が変わる', options: ['部長', '課長'], recommendation: '部長（金額が大きいため）', priority: 'blocking' }, { question: '警告の文は何にしますか？', topic: 'other', priority: 'later' }))), { version: 1 });
  assert(s.open[0].priority === 'blocking' && s.open[0].impact === '承認の流れの作業者が変わる' && s.open[0].options.join() === '部長,課長' && /部長/.test(s.open[0].recommendation) && s.open[1].priority === 'later', `F6: 確認事項に答えで変わること・候補・推奨・先に聞くかを持たせる: ${JSON.stringify(s.open.map(q => q.priority))}`);
});

// =========================================================
console.log('\n--- W. 作業中も会話を続ける（最初の計画・コードの生成の途中の質問と指示・先回りの返答） ---');
await section(async () => {
  // W1 / W2: 最初の計画の作成中。質問はすぐ答え（今の要件と計画: 作成中）、指示はためて、計画を版として出す前に差分で続けて入れる
  const t1 = { reply: '警告の計画を作りました。', requirementOps: [OP({ condition: '金額が100万円を超える', behavior: '警告を出す', sourceQuotes: ['金額が100万円を超えたら画面に警告を出したい'] })], utteranceCoverage: [] };
  const t2 = { reply: '100万円ちょうども対象にしました。', requirementOps: [OP({ op: 'update', id: 'R1', condition: '金額が100万円以上', behavior: '警告を出す', sourceQuotes: ['100万円ちょうども警告の対象にして'] })], utteranceCoverage: [{ quote: '100万円ちょうども警告の対象にして', as: 'requirement', refs: ['R1'], note: '' }] };
  const { c, calls, ctl, byKind, ledger } = makeConv([{ plan: planWith([]), turn: t1 }, { plan: planWith([], { customizations: [cust({ fields: [{ code: 'amount', access: 'CONTROL', condition: 'amount >= "1000000"' }] })] }), turn: t2 }]);
  const open = ctl.hold();
  const p = c.send('金額が100万円を超えたら画面に警告を出したい');
  await ticks();
  assert(calls.ask.length === 1 && calls.ask[0].conversation.brief === true && calls.ask[0].conversation.working === 'PLAN' && byKind('plan-brief').length === 1, `W1: 計画の完成を待たせない: 理解した目的・方向・未決事項を先に返す（先回りの返答）: ${JSON.stringify(calls.ask.map(a => a.conversation && a.conversation.brief))}`);
  const q = await c.send('ところで、このアプリには今いくつJavaScriptが入っていますか？');
  await ticks();
  assert(q && q.asked === true && calls.ask.length === 2 && calls.ask[1].conversation.working === 'PLAN' && calls.ask[1].conversation.plan === null && byKind('aside-answer').length === 1 && c.planHistory().length === 0, 'W1: 作成中の質問はすぐ答える（作業は止めない・作成中と伝え、前の計画を今の計画として渡さない）。以前は受け付けず下書きのまま');
  const ch = await c.send('100万円ちょうども警告の対象にして');
  assert(ch && ch.queued === true && byKind('answers-ack').some(m => m.data.work === 'PLAN' && /いま作っている計画に、続けて入れます/.test(m.text)), 'W2: 作成中の指示は受け付けてためる（受領の表示）');
  open(); await p; await ticks();
  const vs = c.planHistory();
  assert(vs.length === 1 && vs[0].version === 1 && vs[0].basedOnVersion === 0 && calls.plan.length === 2 && calls.plan[1].revision.mode === 'patch' && /100万円ちょうども/.test(calls.plan[1].revision.utterances[0]), `W2: 指示の入っていない計画は出さず、差分で続けて入れた版だけを v1 として出す: ${JSON.stringify(vs.map(v => v.version))}`);
  const r1 = KTAiAnswers.requirementsOf(ledger()).find(e => e.id === 'R1');
  assert(r1 && r1.condition === '金額が100万円以上' && r1.history.length === 1 && byKind('answers-ack').every(m => m.data.stage === 'done') && c.messages().some(m => /作成中に受け付けた指示も入れました/.test(m.text)), 'W2: 要件は続けた作業で更新（履歴に前の条件）・受領は「入れました」・告知は「作成中に受け付けた指示も入れました」');
  // 順番: 先回りの返答 → 作成中の質問の答え → 計画
  const idx = (k) => c.messages().findIndex(m => (m.data?.kind || m.type) === k);
  assert(idx('plan-brief') < idx('aside-answer') && idx('aside-answer') < idx('PLAN'), 'W2: 先回りの返答と作成中の質問の答えは、計画より先に出る');
});
await section(async () => {
  // W3: コードの生成中の指示 → 生成の後に計画へ（前の仕様のコードは登録の対象にしない）→［この変更で確定してコードを作る］。生成を止めたり繰り返したりしない
  const { c, calls, ctl, byKind } = makeConv([{ plan: planWith([]) }, { plan: planWith([], { customizations: [cust({ requirement: '金額が100万円以上なら警告' })] }) }]);
  await c.send('金額が100万円を超えたら画面に警告を出したい');
  const v1 = c.activePlan(); c.confirmSpec({ planId: v1.planId, version: v1.version });
  const open = ctl.hold();
  const g = c.send('コードを作って');
  await ticks();
  const ch = await c.send('警告は100万円ちょうども対象にして');
  assert(ch && ch.queued === true && byKind('answers-ack').some(m => m.data.work === 'GENERATE'), 'W3: コードの生成中の指示も受け付けてためる');
  const q = await c.send('この警告は一覧画面でも出ますか？');
  assert(q && q.asked === true, 'W3: 生成中の質問はすぐ答える');
  open(); await g; await ticks();
  assert(calls.generate === 1 && c.activePlan().version === 2 && v1.status === 'SUPERSEDED' && byKind('generated-stale').length === 1 && byKind('confirm-generate').some(m => m.data.version === 2), `W3: 生成は 1 回だけ（止めない・繰り返さない）、生成の後に計画を v2 にし、前の仕様のコードは登録の対象にしない・確定して作る操作を出す: ${JSON.stringify({ gen: calls.generate, v: c.activePlan().version })}`);
});
await section(async () => {
  // W4: 先回りの返答が計画より後に届いたら出さない（計画より古い理解を後から出さない）
  const { c, ctl, byKind } = makeConv([{ plan: planWith([]) }], { askHold: true });
  const openAsk = ctl.holdAsk();
  await c.send('金額が100万円を超えたら画面に警告を出したい');
  openAsk(); await ticks();
  assert(byKind('plan-brief').length === 0 && c.planHistory().length === 1, 'W4: 計画の後に届いた先回りの返答は出さない');
});

await section(async () => {
  // W5: 作成中の指示を続けて入れた v1 の表示: 版として出さなかった計画の返答は出さない・この版で追加した要件は「追加」だけ（「変更」に重ねない）
  const t1 = { reply: '100万円を超えたら警告を出す計画にしました（100万円ちょうどは対象外）。', requirementOps: [OP({ condition: '金額が100万円を超える', behavior: '警告を出す', sourceQuotes: ['金額が100万円を超えたら画面に警告を出したい'] })], utteranceCoverage: [] };
  const t2 = { reply: '100万円ちょうども対象にしました。', requirementOps: [OP({ op: 'update', id: 'R1', condition: '金額が100万円以上', behavior: '警告を出す', sourceQuotes: ['100万円ちょうども警告の対象にして'] })], utteranceCoverage: [{ quote: '100万円ちょうども警告の対象にして', as: 'requirement', refs: ['R1'], note: '' }] };
  const { c, ctl, byKind } = makeConv([{ plan: planWith([]), turn: t1 }, { plan: planWith([]), turn: t2 }]);
  const open = ctl.hold();
  const p = c.send('金額が100万円を超えたら画面に警告を出したい');
  await ticks();
  await c.send('100万円ちょうども警告の対象にして');
  open(); await p; await ticks();
  const reply = byKind('turn-reply').map(m => m.text).join(' / ');
  const changes = byKind('requirements-changes').map(m => m.text).join(' / ');
  assert(reply === '100万円ちょうども対象にしました。' && /追加 R1/.test(changes) && !/変更 R1/.test(changes), `W5: 出さなかった計画の返答（「ちょうどは対象外」）を出さず、R1 は「追加」だけ: ${reply} ｜ ${changes}`);
});

// =========================================================
console.log('\n--- R. 差分レビューの指摘（失敗・前の計画・作成中の文の形・誤判定・根拠の照合・見逃し・上限） ---');
await section(async () => {
  // R1（H1）: 最初の計画を作れなかったら、作成中の先回りの返答だけを残さず、エラーを出して ok:false（入力欄に依頼の文を戻せる）
  const { c, kinds } = makeConv([{ fail: { ok: false, reason: 'DEV_BASE_UNAVAILABLE', message: '動作テスト環境を取得できませんでした' } }]);
  const r = await c.send('金額が100万円を超えたら画面に警告を出したい');
  const err = c.messages().find(m => m.type === 'ERROR');
  assert(r.ok === false && err && /動作テスト環境を取得できませんでした/.test(err.text) && err.data.retryText === '金額が100万円を超えたら画面に警告を出したい' && c.planHistory().length === 0, `R1: 計画を作れなかったときはエラーを出す（以前は ok:true で先回りの返答だけが残った）: ${JSON.stringify({ ok: r.ok, kinds: kinds() })}`);
});
await section(async () => {
  // R2（H2）: 反映済みの前の計画がある状態で新しい計画を作り、その作成中に受けた指示も入れる（以前は「置き換わった」として新しい計画ごと捨てた）
  const { c, calls, ctl } = makeConv([{ plan: planWith([]) }]);
  await c.send('金額が100万円を超えたら画面に警告を出したい');
  const old = c.activePlan(); old.status = 'EXECUTED';
  const open = ctl.hold();
  const p = c.send('契約終了30日前に担当者へ通知したい');
  await ticks();
  const q = await c.send('土日は除いてほしい');
  open(); const r = await p; await ticks();
  const hist = c.planHistory().map(v => `${v.planId === old.planId ? 'old' : 'new'}:v${v.version}`);
  assert(q && q.queued === true && r.ok === true && !r.superseded && hist.join() === 'old:v1,new:v1' && c.activePlan().planId !== old.planId && calls.plan.length === 3 && /土日は除いて/.test(calls.plan[2].revision.utterances[0]), `R2: 前の計画が反映済みでも、新しい計画の作成中の指示を入れた v1 を出す: ${JSON.stringify({ hist, ok: r.ok, superseded: r.superseded })}`);
});
await section(async () => {
  // R3（H3）: 作成中に受けた指示を続けて入れる作業が失敗しても、できていた最初の計画は v1 として出す（入っていないのはその指示だけ。再試行はその指示の原文で）
  const { c, ctl, byKind } = makeConv([{ plan: planWith([]) }, { fail: { ok: false, reason: 'ERROR', message: '計画の修正に失敗しました' } }, { plan: planWith([]) }]);
  const open = ctl.hold();
  const p = c.send('金額が100万円を超えたら画面に警告を出したい');
  await ticks();
  await c.send('100万円ちょうども警告の対象にして');
  open(); const r = await p; await ticks();
  const err = c.messages().find(m => m.type === 'ERROR');
  assert(r.ok === false && c.planHistory().length === 1 && c.activePlan().version === 1 && err && err.data.retryText === '100万円ちょうども警告の対象にして' && err.data.intent === I.REVISE_PLAN && byKind('answers-ack').every(m => m.data.stage === 'failed'), `R3: 続けた作業の失敗でも最初の計画は v1。指示の受領は「失敗」・再試行は指示の原文: ${JSON.stringify({ hist: c.planHistory().length, retry: err && err.data.retryText })}`);
  const rr = await c.send(err.data.retryText, { intentOverride: err.data.intent });
  assert(rr.ok === true && c.activePlan().version === 2, 'R3: 再試行で、その指示を v1 に入れた v2 ができる（以前は「修正する計画がありません」）');
  // 取り消し（例外）でも同じ
  const k = makeConv([{ plan: planWith([]) }, { cancel: true }]);
  const open2 = k.ctl.hold();
  const p2 = k.c.send('金額が100万円を超えたら画面に警告を出したい');
  await ticks();
  await k.c.send('100万円ちょうども警告の対象にして');
  open2(); const r2 = await p2; await ticks();
  assert(r2.cancelled === true && k.c.planHistory().length === 1 && k.c.activePlan().version === 1, `R3: 続けた作業を取り消しても、最初の計画は v1: ${JSON.stringify({ cancelled: r2.cancelled, hist: k.c.planHistory().length })}`);
});
await section(async () => {
  // R4（H4）: 計画が無い最初の作成中は、文の形だけで分ける: 質問でない文（回答の形の短い指示も）はためて計画に入れる。版になる前の土台に続けて入れている間も同じ
  const { c, calls, ctl } = makeConv([{ plan: planWith([]) }, { plan: planWith([]) }, { plan: planWith([]) }]);
  const open = ctl.hold();
  const p = c.send('金額が100万円を超えたら画面に警告を出したい');
  await ticks();
  const outs = [];
  for (const t of ['保存は止めない', 'PCだけ', '承認者は部長', '警告の文は「高額です」']) outs.push(await c.send(t));
  const asked = await c.send('警告は一覧画面でも出ますか？');
  const op = await c.send('反映して');
  const hold2 = ctl.hold();
  open(); await ticks();
  const more = await c.send('モバイルも対象にして');
  hold2(); await p; await ticks();
  assert(outs.every(o => o && o.queued === true) && asked && asked.asked === true && op === null && calls.plan.length === 3, `R4: 「保存は止めない」「PCだけ」などはためる（以前は質問の AI へ回り計画に入らなかった）・質問はすぐ答える・反映の命令は作業の後に: ${JSON.stringify(outs.map(o => o && o.reason))}`);
  assert(more && more.queued === true && /保存は止めない/.test(calls.plan[1].revision.utterances.join()) && /モバイルも対象に/.test(calls.plan[2].revision.utterances.join()) && c.planHistory().length === 1, `R4: 版になる前の土台に続けて入れている間の指示もためて、次の作業で入れる: ${JSON.stringify(calls.plan.map(x => x.revision && x.revision.utterances))}`);
  assert(calls.ask.filter(a => !a.conversation.brief).map(a => a.question).join() === '警告は一覧画面でも出ますか？', 'R4: 質問の AI に回したのは質問だけ（先回りの返答を除く）');
});
await section(async () => {
  // R5（H5）: 文の質問の判定は文末の形で決める。文の途中の「している」「わかる」で指示を質問にしない
  const isQ = KTAiConversation.isQuestionSentence;
  assert(!isQ('完了している案件にも警告を出して') && !isQ('わかるように赤字で表示して') && !isQ('何件でも登録できるようにして') && isQ('CSVにも効きますか？') && isQ('承認者は誰がいい') && isQ('どこに表示されるの') && isQ('このフィールドは何に使ってる'), 'R5: 文末の形で質問か決める（「完了している案件にも警告を出して」は指示）');
  const t2 = { reply: 'r', requirementOps: [], utteranceCoverage: [] };
  const { c, calls } = makeConv([{ plan: planWith(qs(QP, QS)) }, { plan: planWith(qs(QS)), turn: t2 }]);
  await c.send('金額が100万円を超えたら画面に警告を出したい');
  await c.send('PCだけ。完了している案件にも警告を出して');
  await ticks();
  assert(calls.plan.length === 2 && /完了している案件にも警告を出して/.test(calls.plan[1].revision.utterances.join()) && !calls.ask.some(a => /完了している/.test(a.question)), `R5: 回答＋指示の発言は、指示の部分も計画の AI に渡す（質問の AI に回さない）: ${JSON.stringify(calls.plan[1].revision.utterances)}`);
});
await section(async () => {
  // R6（M1）: 挨拶・相づちは計画の AI を呼ばない。挨拶＋質問は質問として答える（計画を作り直さない）
  const v = { planId: 'p', version: 1, status: 'ACTIVE', plan: planWith(qs(QP)), review: { steps: [] } };
  const st = { activePlan: v, ledgers: new Map() };
  const cls = (t) => KTAiConversation.classifyIntent(t, st);
  const gs = ['ありがとうございました', '了解しました', 'わかりました', 'よろしくお願いします', 'うーん', 'なるほど', '承知しました。ありがとうございます'];
  assert(gs.every(t => cls(t).intent === I.GENERAL), `R6: 挨拶・相づちは計画の AI へ回さない: ${JSON.stringify(gs.map(t => cls(t).intent))}`);
  assert([I.ASK, I.EXPLAIN_PLAN].includes(cls('ありがとう。CSVにも効きますか？').intent) && [I.ASK, I.EXPLAIN_PLAN].includes(cls('なるほど。では一覧画面でも出ますか？').intent), 'R6: 挨拶＋質問は質問として答える');
  const { c, calls } = makeConv([{ plan: planWith([]) }]);
  await c.send('金額が100万円を超えたら画面に警告を出したい');
  await c.send('了解しました');
  assert(calls.plan.length === 1 && c.activePlan().version === 1, 'R6: 「了解しました」で計画を作り直さない（以前は v2 ができた）');
});
await section(async () => {
  // R7（M2）: 命令＋質問の発言は、命令を実行し、質問は同時に答える
  const v = { planId: 'p', version: 1, status: 'ACTIVE', plan: planWith([]), review: { steps: [] }, spec: { status: 'CONFIRMED', version: 1 } };
  const cls = (t) => KTAiConversation.classifyIntent(t, { activePlan: v, ledgers: new Map() });
  const a = cls('これで進めて。CSVにも効きますか？'), b = cls('コードを作って。CSVにも効きますか？');
  assert(a.intent === I.REQUEST_PREVIEW && /CSV/.test(a.askText) && b.intent === I.GENERATE_CODE && /CSV/.test(b.askText), `R7: 命令の判定は質問の文を除いた部分で行う: ${a.intent} ${b.intent}`);
  const { c, calls } = makeConv([{ plan: planWith([]) }]);
  await c.send('金額が100万円を超えたら画面に警告を出したい');
  const v1 = c.activePlan(); c.confirmSpec({ planId: v1.planId, version: v1.version });
  await c.send('コードを作って。CSVにも効きますか？');
  await ticks();
  assert(calls.generate === 1 && calls.plan.length === 1 && calls.ask.some(a2 => /CSV/.test(a2.question)), `R7: コードを作り（計画は作り直さない）、質問は同時に答える: ${JSON.stringify({ gen: calls.generate, plans: calls.plan.length })}`);
});
await section(async () => {
  // R8（M8）: 名詞＋「取り消して / 元に戻して」は、修正できる計画があれば計画の修正（反映の取り消しではない）。命令だけの文は従来どおり
  const v = { planId: 'p', version: 1, status: 'ACTIVE', plan: planWith([]), review: { steps: [] }, spec: { status: 'CONFIRMED', version: 1 } };
  const st = { activePlan: v, ledgers: new Map(), activeExecution: { executionId: 'x', written: true, rolledBack: false } };
  const cls = (t) => KTAiConversation.classifyIntent(t, st);
  assert(['警告を取り消して', '通知を取り消して', '金額を元に戻して', 'P2は取り消して'].every(t => cls(t).intent === I.REVISE_PLAN), `R8: 要件・手順の取り消しは計画の修正: ${JSON.stringify(['警告を取り消して', 'P2は取り消して'].map(t => cls(t).intent))}`);
  assert(cls('元に戻して').intent === I.REQUEST_ROLLBACK && cls('C1 のコードを作り直して').intent === I.GENERATE_CODE && cls('反映でお願いします').intent === I.REQUEST_PREVIEW && cls('今すぐ反映して').intent === I.REQUEST_PREVIEW, 'R8: 命令だけの文は従来どおり（元に戻す・作り直す・反映）');
});
await section(async () => {
  // R9（M3）: 取り消しの根拠は 4 文字以上か発言の 1 文そのもの。取り消し済みの要件は、今回の発言に根拠が無ければ戻さない
  const lg = KTAiAnswers.createLedger('x');
  const goal = '金額が100万円を超えたら警告を出したい';
  KTAiAnswers.applyRequirementOps(lg, [OP({ behavior: '警告を出す', sourceQuotes: [goal] }), OP({ behavior: '金額を赤字にする', sourceQuotes: [goal] })], { version: 1, userTexts: [goal], utterances: [goal] });
  const u2 = '一覧の列に金額を足して';
  const r1 = KTAiAnswers.applyRequirementOps(lg, [OP({ op: 'revoke', id: 'R1', sourceQuotes: ['金額'] })], { version: 2, userTexts: [goal, u2], utterances: [u2] });
  assert(!r1.revoked.length && KTAiAnswers.requirementsOf(lg)[0].decision === 'decided', 'R9: 「金額」（2 文字）だけを根拠に取り消さない');
  const u3 = '赤字はやめて';
  const r2 = KTAiAnswers.applyRequirementOps(lg, [OP({ op: 'revoke', id: 'R2', sourceQuotes: ['赤字はやめて'] })], { version: 3, userTexts: [goal, u3], utterances: [u3] });
  assert(r2.revoked.length === 1, 'R9: 発言の 1 文そのものなら短くても取り消せる');
  const u4 = '警告の文を変えて';
  const r3 = KTAiAnswers.applyRequirementOps(lg, [OP({ op: 'update', id: 'R2', behavior: '金額を赤字にする', sourceQuotes: [goal] })], { version: 4, userTexts: [goal, u3, u4], utterances: [u4] });
  assert(!r3.updated.length && KTAiAnswers.requirementsOf(lg)[1].decision === 'revoked', 'R9: 取り消し済みへの update は、今回の発言に根拠が無ければ外す（AI が取り消し済みを戻さない）');
  const u5 = 'やっぱり金額は赤字にして';
  const r4 = KTAiAnswers.applyRequirementOps(lg, [OP({ op: 'update', id: 'R2', behavior: '金額を赤字にする', sourceQuotes: [u5] })], { version: 5, userTexts: [goal, u5], utterances: [u5] });
  assert(r4.updated.length === 1 && KTAiAnswers.requirementsOf(lg)[1].decision === 'decided', 'R9: 利用者が戻すと言えば戻す');
});
await section(async () => {
  // R10（M4）: AI 自身の質問文を引用しても「利用者の決定」にしない（Toolkit が組み立てた依頼文は利用者の文として数えない）
  const t2 = { reply: 'r', requirementOps: [OP({ behavior: '保存を止める', sourceQuotes: ['金額が大きいとき、保存を止めますか'] })], utteranceCoverage: [{ quote: 'いいえ', as: 'answer', refs: [], note: '' }] };
  const { c, calls, ledger } = makeConv([{ plan: planWith(qs(QS)) }, { plan: planWith([]), turn: t2 }]);
  await c.send('金額が100万円を超えたら画面に警告を出したい');
  await c.send('いいえ');
  const e = KTAiAnswers.requirementsOf(ledger()).find(x => x.behavior === '保存を止める');
  assert(/保存を止めますか/.test(calls.plan[1].revision.request) && e && e.decision === 'proposed' && !e.sourceQuotes.length, `R10: 確認事項の文の引用は根拠にならない（提案に下げる）: ${e && e.decision}`);
});
await section(async () => {
  // R11（M5）: 扱いが示されなかった部分の見逃し（読点・句読点の無い節）と誤検出（丁寧な語尾・質問の文）
  const U = KTAiAnswers.uncoveredClauses;
  const isQuestion = KTAiConversation.isQuestionSentence;
  assert(U(['保存は止めないでください'], [{ quote: '保存は止めない', as: 'answer' }], [], { isQuestion }).length === 0 && U(['PCだけでお願いします'], [{ quote: 'PCだけ', as: 'answer' }], [], { isQuestion }).length === 0, 'R11: 丁寧な語尾だけが残っても未解決にしない');
  assert(U(['部長が承認します。ところでCSVの読み込みにも効きますか？'], [{ quote: '部長が承認します', as: 'requirement' }], [], { isQuestion }).length === 0, 'R11: 質問の文は未解決にしない（質問の AI が答える）');
  const m1 = U(['金額が100万円を超えたら画面に警告を出して保存は止めずに赤字にもして'], [{ quote: '金額が100万円を超えたら画面に警告を出して保存は止めずに', as: 'requirement' }], [OP({ condition: '金額が100万円を超える', behavior: '画面に警告を出し、保存は止めない', sourceQuotes: ['金額が100万円を超えたら画面に警告を出して保存は止めずに'] })], { isQuestion });
  const m2 = U(['100万円以上なら部長、未満なら課長が承認して、モバイルも対象'], [{ quote: '100万円以上なら部長、未満なら課長が承認して', as: 'requirement' }], [OP({ condition: '100万円以上', behavior: '部長が承認する' })], { isQuestion });
  const m3 = U(['承認者は部長にして、却下されたら担当者に通知して、ただし土日は除いて'], [{ quote: '承認者は部長にして、却下されたら担当者に通知して', as: 'requirement' }], [OP({ condition: '却下されたとき', behavior: '担当者に通知する' })], { isQuestion });
  assert(m1.join() === '赤字にもして' && m2.join() === 'モバイルも対象' && m3.join() === 'ただし土日は除いて', `R11: 引用が覆わない節（読点の後・句読点の無い文の後半）を見逃さない: ${JSON.stringify([m1, m2, m3])}`);
  const para = U(['部長が承認、ただし不在なら副部長'], [{ quote: '部長が承認', as: 'requirement' }], [OP({ condition: '部長が不在のとき', behavior: '副部長が承認する' })], { isQuestion });
  assert(para.length === 0, `R11: 言い換えて構造化した節（例外）は扱った部分とみなす: ${JSON.stringify(para)}`);
});
await section(async () => {
  // R12（M6）: 対応先を聞き返す回答でも、質問の部分は同時に答える
  const { c, calls, byKind } = makeConv([{ plan: planWith(qs({ question: '金額が大きいとき、保存を止めますか？', topic: 'save_block' }, { question: '承認者にメールで通知しますか？', topic: 'notify' })) }]);
  await c.send('金額が100万円を超えたら画面に警告を出したい');
  await c.send('いいえ。CSVの読み込みにも効きますか？');
  await ticks();
  assert(byKind('answer-target').length === 1 && calls.ask.some(a => /CSV/.test(a.question)), `R12: 対応先の聞き返しと、質問への答えの両方: ${JSON.stringify({ target: byKind('answer-target').length, asks: calls.ask.map(a => a.question.slice(0, 10)) })}`);
});
await section(async () => {
  // R13（M7）: 並べて走らせた質問の答えを待たずに、計画ができたら次の入力を受け付ける
  const { c, ctl } = makeConv([{ plan: planWith(qs(QP, QS)) }, { plan: planWith(qs(QS)) }]);
  await c.send('金額が100万円を超えたら画面に警告を出したい');
  await ticks();
  const openAsk = ctl.holdAsk();
  await c.send('PCだけ。ところでCSVの読み込みにも効きますか？');
  const busyAfter = c.isBusy();
  openAsk(); await ticks();
  assert(busyAfter === false && c.activePlan().version === 2 && c.messages().some(m => m.data?.kind === 'aside-answer'), `R13: 計画ができたら入力を受け付け、質問の答えは届いたときに出す: ${JSON.stringify({ busyAfter })}`);
});
await section(async () => {
  // R14（L1・L2）: 上限は取り消し済みを数えず、超えた分は知らせる。根拠の無い update で内容が同じなら、利用者の決定を下げない
  const lg = KTAiAnswers.createLedger('x');
  const u = 'たくさんの要件';
  const many = Array.from({ length: 41 }, (_, i) => OP({ behavior: `要件 ${i + 1}`, sourceQuotes: [u] }));
  const r = KTAiAnswers.applyRequirementOps(lg, many, { version: 1, userTexts: [u], utterances: [u] });
  assert(r.added.length === 40 && r.overflow === 1 && KTAiAnswers.addUnresolvedRequirement(lg, '扱いの示されなかった文', { version: 1 }) === null, `R14: 41 件目は記録できないことを数で返す: ${r.overflow}`);
  for (const e of KTAiAnswers.requirementsOf(lg).slice(0, 3)) e.decision = 'revoked';
  const r2 = KTAiAnswers.applyRequirementOps(lg, [OP({ behavior: '新しい要件', sourceQuotes: [u] })], { version: 2, userTexts: [u], utterances: [u] });
  const sent = KTAiAnswers.requirementsForContext(lg);
  assert(r2.added.length === 1 && sent.length === 40 && sent.filter(x => x.decision !== 'revoked').length === 38 && sent.some(x => x.behavior === '新しい要件'), `R14: 取り消し済みは上限に数えない・送るときは有効な要件を先に入れる: ${JSON.stringify({ added: r2.added.length, sent: sent.length })}`);
  const lg2 = KTAiAnswers.createLedger('y');
  KTAiAnswers.applyRequirementOps(lg2, [OP({ target: '作成画面', behavior: 'PC だけで動く', sourceQuotes: ['PCだけ'] })], { version: 1, userTexts: ['PCだけ'], utterances: ['PCだけ'] });
  const r3 = KTAiAnswers.applyRequirementOps(lg2, [OP({ op: 'update', id: 'R1', target: '作成画面', behavior: 'PC だけで動く', sourceQuotes: [], planRefs: ['C1'] })], { version: 2, userTexts: ['PCだけ', '一覧も'], utterances: ['一覧も'] });
  assert(r3.updated.length === 1 && KTAiAnswers.requirementsOf(lg2)[0].decision === 'decided' && r3.downgraded.length === 0, 'R14: 根拠の無い update でも内容が同じなら利用者の決定のまま');
  const r4 = KTAiAnswers.applyRequirementOps(lg2, [OP({ op: 'update', id: 'R1', target: '作成画面', behavior: 'PC とモバイルで動く', sourceQuotes: [] })], { version: 3, userTexts: ['PCだけ', '一覧も'], utterances: ['一覧も'] });
  assert(r4.updated.length === 1 && KTAiAnswers.requirementsOf(lg2)[0].decision === 'proposed', 'R14: 根拠の無い内容の変更は AI の提案');
  // 会話: 上限に達したことを画面に出す
  const t1 = { reply: 'r', requirementOps: Array.from({ length: 41 }, (_, i) => OP({ behavior: `要件 ${i + 1}`, sourceQuotes: ['金額が100万円を超えたら画面に警告を出したい'] })), utteranceCoverage: [{ quote: '金額が100万円を超えたら画面に警告を出したい', as: 'requirement', refs: [], note: '' }] };
  const { c, byKind } = makeConv([{ plan: planWith([]), turn: t1 }]);
  await c.send('金額が100万円を超えたら画面に警告を出したい');
  assert(byKind('requirements-overflow').length === 1 && /上限（40 件/.test(byKind('requirements-overflow')[0].text), 'R14: 上限で記録できなかった指示があることを知らせる（黙って落とさない）');
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
