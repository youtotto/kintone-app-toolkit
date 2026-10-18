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
// C-1 第 3 段（2026-10-08・設計 §0d.4）: 古い確認の流れ（最初の依頼から直接の計画・先回りの返答・変更案のカード・要件の変化の知らせ・提案のカード・
//   対応先の聞き返し・仕様の確定・［この変更で確定してコードを作る］）は削除した。会話の試験は新しい流れ（依頼 → 仮案 → 採用 → 計画 → 生成 → 最終案）の上で行う:
//   最初の依頼は仮案の台本（tests/helpers/new-flow.js の 4 発言）で採用まで進め、steps[0] は採用の後の最初の計画、steps[1] 以降は最終案の後の差分更新。
//   台本の仮案で要件が 4 件（R1〜R4）入るので、この試験の要件の番号は R5 から（rid）。消した古い流れの期待は、置き換えた新しい流れの回帰
//   （tests/ai-flow-redesign.test.js の R01〜R21・B 系・F 系）に対応を書いた
//
// 実行方法: node tests/ai-requirements.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
//   簡素化（2026-10-17）: 反映できるかは、最新の版なら会話の今の判定、前の版なら最終案の記録で確かめる（tests/helpers/final-state.js）
const FS = require('./helpers/final-state.js');
const { createNewFlowKit } = require('./helpers/new-flow.js');
const T = loadToolkit();
const { KTDeps, KTAiConversation, KTAiAnswers, KTPlanReview, KTAiChatUi } = T;
const K = createNewFlowKit(T);
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');

const DATA = FX.makeData();
const DEPS = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
const I = KTAiConversation.INTENT;
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
const step = (id, actionType, targetKind, targetRef, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' }, ...extra });
const qs = (...texts) => texts.map((t, i) => (typeof t === 'string' ? { id: `Q${i + 1}`, question: t, reason: '', relatedEvidenceIds: [] } : { id: `Q${i + 1}`, reason: '', relatedEvidenceIds: [], ...t }));
const cust = (o = {}) => ({ customizationId: 'C1', requirement: '金額が100万円を超えたら警告を出す', whyStandardInsufficient: '入力中の警告は標準設定に無い', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', condition: 'amount > "1000000"', effects: ['warn'] }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [], ...o });
const CSTEP = step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', '', { customizationId: 'C1' }, { solution: 'CUSTOMIZATION' });
const planWith = (questions, extra = {}) => ({ goal: '金額が100万円を超えたら画面に警告を出したい', solution: 'HYBRID', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps: [step('P1', 'ADD_VIEW', 'VIEW', '高額案件', { name: '高額案件', fields: ['amount'] }), CSTEP], alternatives: [], impact: [], questions, unknowns: [], planConfidence: 'NEEDS_CONFIRMATION', customizations: [cust()], provisionals: [], ...extra });
const QP = { question: '対象は PC だけですか？モバイルでも使いますか？', topic: 'platform' };
const QS = { question: '金額が大きいとき、保存を止めますか？', topic: 'save_block' };
const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };
const OP = (o = {}) => ({ op: 'add', id: '', target: '金額フィールド', condition: '', behavior: 'x', exceptions: [], decision: 'decided', disposition: 'adopted', sourceQuotes: [], planRefs: ['C1'], note: '', ...o });
/** 台本の仮案（K.REQUESTS の 4 発言）で台帳に入る要件の数（R1〜R4）。この試験の計画の AI の要件は R5 から */
const BASE_REQS = 4;
const rid = (n) => `R${BASE_REQS + n}`;
/**
 * 会話（fake services）。C-1 第 3 段（2026-10-08）: 新しい流れ（仮案 → 採用 → 計画 → 生成工程 → 最終案）の偽 services。
 *   仮案は共有の部品の台本（K.script）。steps[n] = 計画の n+1 回目の呼び出しの { plan, turn }（steps[0] は採用の後の最初の計画、以降は差分更新）。
 *   生成は共有の部品の偽の生成工程（警告の候補）。generate を渡すとその実装を使う。ask は呼ばれた引数を記録して答える。
 *   実効（customization の effects）を計画に入れているので、必須の効果を補う自動の差分更新は起きない（計画の呼び出しの回数は従来どおり）
 */
function makeConv(steps, { askAnswer = 'JavaScript は画面の操作だけで動き、CSV の読み込みでは動きません。', askResult = null, generate = null } = {}) {
  const calls = { plan: [], ask: [], generate: 0, propose: [] };
  let t = 1000;
  // hold(): 次の計画・生成の呼び出しを待たせる / holdAsk(): 次の質問の呼び出しを待たせる
  const gates = [], askGates = [];
  const ctl = { hold() { let o; gates.push(new Promise(r => { o = r; })); return o; }, holdAsk() { let o; askGates.push(new Promise(r => { o = r; })); return o; } };
  const gen = generate || K.makeGenerate({ sequence: ['warn'] });
  const services = {
    async propose(args) { calls.propose.push({ utterance: args.utterance }); const raw = K.script(args); if (!raw) return { ok: false, reason: 'NO_SCRIPT', message: `台本がありません: ${args.utterance}` }; t += 3000; return { ok: true, proposal: K.normalized(raw, `pp-${calls.propose.length}`), ctx: { facts: [] } }; },
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
      //   2026-10-15（追加の指示 1）: 偽の計画の AI は要件の対応づけ（requirementOps）を返す（K.withPlannerMapping。turn に要件の操作があればそのまま・s.noAutoMap なら返さない）
      return K.withPlannerMapping({ plan: p, ctx: { facts: [] }, review: KTPlanReview.review({ plan: p, data: DATA, deps: DEPS, scan: null, incoming: null }), gatewayPlan: { ...JSON.parse(JSON.stringify(p)), gw: n + 1 }, revisionMeta: args.revision ? { requested: args.revision.mode || 'full', mode: args.revision.mode || 'full', fallbackReason: null } : null, turn: s.turn || null, ...(s.noAutoMap ? { noAutoMap: true } : {}) }, args.requirements, { merge: true });
    },
    revisionModes: () => ['full', 'patch'],
    conversationFeatures: () => ['requirements', 'stream', 'proposal'],
    generatorFeatures: () => ['requirementId', 'cases', 'feedback', ...K.GEN_EFFECT_FEATURES, K.GEN_NETWORK_FEATURE], plannerFeatures: () => ['reply'],
    materials: () => '見ている設定: 一覧 1 件・既存の JavaScript 0 ファイル', fieldLabels: () => K.LABELS_C, async customizeRevision() { return '42'; },
    async ask(args) { const ga = askGates.shift(); if (ga) await ga; calls.ask.push(JSON.parse(JSON.stringify({ question: args.question, conversation: args.conversation || null }))); if (askResult) { const x = askResult(args); if (x) return x; } return { ok: true, answer: { answer: askAnswer, facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx: { facts: [] } }; },
    async generate(args) { const g = gates.shift(); if (g) await g; calls.generate++; t += 20000; return gen.impl(args); },
    readiness(v) { return { approved: 0, executable: 0, unsupported: 0, blocked: 0, undecided: v.plan.steps.length }; },
  };
  const c = KTAiConversation.create({ services, now: () => '2026-10-05T00:00:00.000Z', clock: () => t });
  const kinds = () => c.messages().map(m => m.data?.kind || m.type);
  const byKind = (k) => c.messages().filter(m => m.data?.kind === k);
  const finals = () => c.messages().filter(m => m.type === 'FINAL');
  return { c, calls, ctl, kinds, byKind, finals, ledger: () => c.state.ledgers.get(c.activePlan().planId) };
}
/** 台本の 3 発言で仮案を作る（4 発言目の「おすすめで」で採用する前まで） */
const draftUntilAdopt = async (x) => { for (const s of K.REQUESTS.slice(0, 3)) await x.c.send(s); };
/** 台本の 4 発言で仮案 → 採用 → 計画（steps[0]）→ 生成 → 最終案まで進める */
const adopt = async (x) => { await draftUntilAdopt(x); await x.c.send(K.REQUESTS[3]); await ticks(); return x.c.activePlan(); };
/** 最終案のカードの文（タグを外す） */
const finalText = (x) => K.stripC(K.finalHtml(x));
/** 2026-10-14（会話の設計し直し）: 検証の区分・反映する内容は右の「変更内容」 */
const rightText = (x) => K.stripC(KTAiChatUi.changeSummaryHtml(x.c.activePlan(), {}));

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
  //   C-1 第 3 段（2026-10-08）: 最初の依頼は仮案 → 採用 → 最終案。回答＋条件＋質問は最終案の後の発言で確かめる。
  //   最初の依頼の要件を台帳に入れることは仮案の台帳（ai-flow-redesign R01-4・B2-14）、最初の計画の返答と要件の変化の知らせ（削除した）は
  //   最終案のカードの「変わった点」（R11-5）、先回りの返答（brief）は削除した（F7-5）
  const t2 = { reply: 'PC だけにし、保存は止めないようにしました。', requirementOps: [OP({ target: '作成・編集画面', behavior: 'PC だけで動く', sourceQuotes: ['PCだけ'] }), OP({ behavior: '保存は止めない', sourceQuotes: ['保存は止めない'] })], utteranceCoverage: [{ quote: 'PCだけ', as: 'answer', refs: [], note: '' }, { quote: '保存は止めない', as: 'answer', refs: [], note: '' }] };
  const x = makeConv([{ plan: planWith(qs(QP, QS)) }, { plan: planWith([]), turn: t2 }]);
  const { c, calls, ledger } = x;
  const v1 = await adopt(x);
  const base = KTAiAnswers.requirementsOf(ledger());
  assert(v1 && v1.final && v1.fromDraft && base.length === BASE_REQS && base.every(e => e.decision === 'decided') && calls.ask.length === 0 && calls.plan.length === 1, `前提: 仮案の要件（4 件・decided）は採用の後も計画の台帳にあり、最終案ができる。先回りの返答（質問の AI）は呼ばない: ${JSON.stringify(base.map(e => e.id + ':' + e.decision))}`);
  const ops0 = c.metrics().requirementOps;
  await c.send('PCだけ。保存は止めない。ところでCSVの読み込みにも効きますか？');
  await ticks();
  const rev = calls.plan[1].revision;
  const aq = calls.ask.find(a => /CSV/.test(a.question));
  assert(calls.ask.length === 1 && aq && aq.conversation && aq.conversation.requirements.some(r => r.id === 'R1') && aq.conversation.plan && aq.conversation.working === 'REVISE' && !aq.conversation.brief, `F1: 質問の部分は同時に質問の AI へ（会話の現在の要件と計画・作業中を渡す）: ${JSON.stringify(calls.ask.map(a => ({ q: a.question.slice(0, 12), w: a.conversation && a.conversation.working })))}`);
  assert(rev.mode === 'patch' && rev.questionsAnsweredSeparately === true && Array.isArray(rev.utterances) && /PCだけ/.test(rev.utterances[0]) && !/CSV/.test(rev.utterances[0]) && calls.plan[1].requirements.some(r => r.id === 'R1'), `F1: 回答の部分は差分で更新し、計画の AI には要件と今回の発言・「質問には別に答える」を渡す: ${JSON.stringify({ mode: rev.mode, sep: rev.questionsAnsweredSeparately, utt: rev.utterances })}`);
  assert(c.messages().some(m => m.data?.kind === 'aside-answer' && /CSV/.test(m.text)) && c.activePlan().version === 2 && c.activePlan().final && KTAiAnswers.requirementsOf(ledger()).length === BASE_REQS + 2, 'F1: 質問への答えを出し、計画は v2（最終案を置き換え）に更新・要件は 2 件増える（回答の 2 つが要件にも入る）');
  assert(c.metrics().asideAsks === 1 && c.metrics().requirementOps === ops0 + 2, `F1: 計測（同時に答えた質問・要件の操作）: ${JSON.stringify({ asideAsks: c.metrics().asideAsks, requirementOps: c.metrics().requirementOps - ops0 })}`);
});
await section(async () => {
  // F2: 根拠の発言が利用者の文に無い「決定」は提案に下げる・扱いが示されなかった文は未解決として残す（最終案の後の発言で確かめる）
  const goal = '見積の金額チェックを入れたいです。100万円を超える場合は警告だけ出して、保存はそのまま通してください。あと、明細の小計の合計と金額がずれていたら知らせてほしいです。';
  const t2 = { reply: '金額のチェックと警告の計画にしました。', requirementOps: [OP({ condition: '100万円を超える', behavior: '警告だけ出し、保存は止めない', sourceQuotes: ['100万円を超える場合は警告だけ出して'] }), OP({ behavior: '承認者は部長', sourceQuotes: ['部長が承認する'] })], utteranceCoverage: [{ quote: '見積の金額チェックを入れたいです', as: 'requirement', refs: [], note: '' }, { quote: '100万円を超える場合は警告だけ出して、保存はそのまま通してください', as: 'requirement', refs: [], note: '' }] };
  const x = makeConv([{ plan: planWith([]) }, { plan: planWith([]), turn: t2 }]);
  const { c, ledger } = x;
  await adopt(x);
  const un0 = c.metrics().unresolvedClauses;
  await c.send(goal); await ticks();
  const reqs = KTAiAnswers.requirementsOf(ledger()).slice(BASE_REQS);
  assert(reqs[0] && reqs[0].decision === 'decided' && reqs[1] && reqs[1].decision === 'proposed', `F2: 利用者の文に無い根拠の「決定」は提案（proposed）に下げる: ${reqs.map(e => e.decision).join()}`);
  const un = reqs.filter(e => e.disposition === 'unresolved' && e.origin === 'toolkit');
  assert(un.length === 1 && /明細の小計の合計と金額がずれていたら/.test(un[0].behavior), `F2: 計画の AI が扱いを示さなかった文は、黙って捨てずに未解決の要件として台帳に残す: ${JSON.stringify(un.map(e => e.behavior))}`);
  //   2026-10-06 の会話の知らせ（「変更案に入っていない可能性がある指示があります：「…」」・「入れる場合は、そのように伝えてください」）は、C-1 第 3 段で
  //   要件の変化の知らせと一緒に削除し、最終案のカードに「変更案に入っていない可能性がある指示」として出す（承認は止めない）。
  //   会話の知らせか、最終案のカードのどちらかに出れば合格（「入れた指示」の行は除いて確かめる）
  const fin = finalText(x).replace(/入れた指示: [^\n]*/g, '');
  const told = c.messages().some(m => /変更案に入っていない可能性がある指示があります：「[^」]*明細の小計の合計と金額がずれていたら/.test(m.text || '') && !KTAiChatUi.isHiddenMessage(m)) || (/明細の小計の合計と金額がずれていたら/.test(fin) && /入っていない|扱いが決まっていない|未解決/.test(fin));
  assert(told, `F2: 扱いが示されなかった文を利用者に知らせる（会話の知らせ、または最終案のカード）: ${fin.slice(0, 200)}`);
  assert(/変更案に入っていない可能性がある指示/.test(fin) && /明細の小計の合計と金額がずれていたら/.test(fin) && FS.readyOf(x.c.activePlan()) === true, `F2: 最終案のカードで「変更案に入っていない可能性がある指示」として知らせる（承認は止めない）: ${fin.slice(0, 300)}`);
  assert(c.metrics().unresolvedClauses === un0 + 1, 'F2: 計測（扱いが示されなかった文）');
});
await section(async () => {
  // F3: 取り消し（今回の発言に根拠が要る）。取り消した要件も計画の AI に渡す（戻させない）（最終案の後の発言で確かめる）
  //   C-1 第 3 段: 要件の変化の会話の知らせ（「取り消し R1」）は削除した（最終案のカードの「変わった点」: ai-flow-redesign R11-5）。台帳の取り消しと履歴は今のまま
  const add = '警告の文は「高額案件です」にして';
  const t2 = { reply: 'r', requirementOps: [OP({ behavior: '警告の文は「高額案件です」', sourceQuotes: [add] })], utteranceCoverage: [{ quote: add, as: 'requirement', refs: [], note: '' }] };
  const t3 = { reply: '警告の文の指定を取り消しました。', requirementOps: [OP({ op: 'revoke', id: rid(1), behavior: '', sourceQuotes: ['警告の文の指定は取り消します'] })], utteranceCoverage: [{ quote: '警告の文の指定は取り消します', as: 'revocation', refs: [rid(1)], note: '' }, { quote: '文はおまかせで', as: 'revocation', refs: [rid(1)], note: '' }] };
  const t4 = { reply: 'x', requirementOps: [OP({ op: 'revoke', id: rid(1), behavior: '', sourceQuotes: ['警告の文の指定は取り消します'] })], utteranceCoverage: [] };
  const x = makeConv([{ plan: planWith([]) }, { plan: planWith([]), turn: t2 }, { plan: planWith([]), turn: t3 }, { plan: planWith([]), turn: t4 }]);
  const { c, calls, ledger } = x;
  await adopt(x);
  await c.send(add); await ticks();
  await c.send('警告の文の指定は取り消します。文はおまかせで'); await ticks();
  const r1 = KTAiAnswers.requirementsOf(ledger()).find(e => e.id === rid(1));
  assert(r1 && r1.decision === 'revoked' && r1.history.length === 1, `F3: 今回の発言に根拠のある取り消しは要件を取り消し済みにする（消さずに残す・履歴）: ${r1 && r1.decision}`);
  await c.send('一覧の列に金額を足して'); await ticks();
  assert(calls.plan[3].requirements.some(r => r.id === rid(1) && r.decision === 'revoked'), 'F3: 取り消した要件も計画の AI に渡す（戻させない）');
  const lg = KTAiAnswers.createLedger('x');
  KTAiAnswers.applyRequirementOps(lg, [OP({ behavior: 'a', sourceQuotes: ['abc def'] })], { version: 1, userTexts: ['abc def'], utterances: ['abc def'] });
  const r = KTAiAnswers.applyRequirementOps(lg, [OP({ op: 'revoke', id: 'R1', sourceQuotes: ['abc def'] })], { version: 2, userTexts: ['abc def', '別の文'], utterances: ['別の文'] });
  assert(!r.revoked.length && KTAiAnswers.requirementsOf(lg)[0].decision === 'decided', 'F3: 今回の発言に根拠の無い取り消しは適用しない（AI が勝手に要件を消さない）');
});
await section(async () => {
  // F4: 「条件を変えて、コードも作って」→ 計画を更新してから、変わった仕様で JavaScript を作る。古い版の仕様でコードを作らない
  //   C-1 第 3 段: ［この変更で確定してコードを作る］のカード（confirm-generate）と仕様の確定は削除した。計画を直した版の JavaScript は最終案のパイプラインが
  //   作り直す（ai-flow-redesign F3-1）。ここでは、作り直しが新しい条件の仕様で行われること（古い仕様のコードを使わない）を確かめる
  const CUST_GE = cust({ requirement: '金額が100万円以上なら警告を出す', fields: [{ code: 'amount', access: 'CONTROL', condition: 'amount >= "1000000"', effects: ['warn'] }] });
  const x = makeConv([{ plan: planWith([]) }, { plan: planWith([], { customizations: [CUST_GE] }) }]);
  const { c, calls } = x;
  await adopt(x);
  const g0 = calls.generate;
  const r = await c.send('100万円ちょうども警告の対象に変えて、コードも作って'); await ticks();
  const v2 = c.activePlan();
  const req2 = (v2.generated && v2.generated.C1 && v2.generated.C1.requiredEffects) || [];
  assert(r.intent === I.REVISE_PLAN && r.reason === 'TURN_THEN_GENERATE' && v2.version === 2 && calls.plan[1].revision.mode === 'patch' && calls.generate === g0 + 1 && v2.generated.C1.reused !== true && req2.some(e => e.condition === 'amount >= "1000000"') && v2.final && !c.messages().some(m => m.data?.kind === 'confirm-generate'), `F4: 先に計画を更新し、変わった仕様（100万円以上）で JavaScript を作り直して最終案を置き換える（古い仕様のコードは使わない）: ${JSON.stringify({ v: v2.version, gen: calls.generate - g0, req: req2.map(e => e.condition) })}`);
  // 実機（2026-10-05）で見つけた: 「コードも作って」が要件「コードを生成する」になった。発言は原文のまま渡し、コードの生成は Toolkit が計画の後に行うと伝える
  assert(calls.plan[1].revision.request === '100万円ちょうども警告の対象に変えて、コードも作って' && calls.plan[1].revision.generateAfter === true, `F4: 発言は原文のまま・コードの生成は計画の後と伝える（generateAfter）: ${JSON.stringify(calls.plan[1].revision)}`);
});
await section(async () => {
  // F5: 「部長が不在のときは副部長が承認します」は計画の AI へ（反映へ進まない）。後から変えられる点を知らせる（最終案の後の発言で確かめる）
  //   C-1 第 3 段: 返答・要件の変化の会話の知らせと、提案のカード（provisionals）は削除した。返答と提案は最終案のカードの「仮案から変わった点と理由」に出る
  //   （ai-flow-redesign R09-3: 提案は別のカードにしない）。カードの文の形（見出し 1 行 ＋ 1 件 1 行）の期待は消した
  const t2 = { reply: '代理の承認者を副部長にしました。', requirementOps: [OP({ target: '承認（プロセス管理）', condition: '部長が不在のとき', behavior: '副部長が代わりに承認する', sourceQuotes: ['部長が不在のときは副部長が承認します'] })], utteranceCoverage: [{ quote: '部長が不在のときは副部長が承認します', as: 'requirement', refs: [], note: '' }] };
  const x = makeConv([{ plan: planWith([]) }, { plan: planWith([], { provisionals: [{ id: 'A1', topic: 'location', choice: '警告は金額欄に表示', reason: '入力中に気づける', changeHint: '別の場所にしたいときは伝えてください' }] }), turn: t2 }]);
  const { c, calls, kinds, byKind, ledger } = x;
  await adopt(x);
  const r = await c.send('部長が不在のときは副部長が承認します'); await ticks();
  const fin = finalText(x);
  assert(r.intent === I.REVISE_PLAN && calls.plan.length === 2 && !kinds().includes('preview-ready') && /代理の承認者を副部長にしました/.test(fin) && KTAiAnswers.requirementsOf(ledger()).some(e => /副部長が代わりに承認する/.test(e.behavior) && e.decision === 'decided') && !byKind('requirements-changes').length, 'F5: 代理の承認者の指示は計画の AI へ（反映へ進む言葉にしない）・返答を最終案のカードに出し、要件を台帳に記録する');
  assert(/仮案からの補足[\s\S]*計画で決めた点: 警告は金額欄に表示/.test(fin) && !/仮の案/.test(fin) && !byKind('provisionals').length && !c.messages().some(m => m.data?.kind === 'questions'), `F5: 後から変えられる点（計画が決めた提案）は最終案のカードで知らせる（質問しない・別のカードにしない）: ${(fin.match(/仮案からの補足[^\n]*/) || [''])[0]}`);
});
await section(async () => {
  // F6: 確認事項の追加の項目（答えで何が変わるか・候補・推奨・先に聞くか）を台帳の確認事項に持ち回る
  const lg = KTAiAnswers.createLedger('q');
  const s = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs({ question: '100万円以上の承認者は誰にしますか？', topic: 'approver', impact: '承認の流れの作業者が変わる', options: ['部長', '課長'], recommendation: '部長（金額が大きいため）', priority: 'blocking' }, { question: '警告の文は何にしますか？', topic: 'other', priority: 'later' }))), { version: 1 });
  assert(s.open[0].priority === 'blocking' && s.open[0].impact === '承認の流れの作業者が変わる' && s.open[0].options.join() === '部長,課長' && /部長/.test(s.open[0].recommendation) && s.open[1].priority === 'later', `F6: 確認事項に答えで変わること・候補・推奨・先に聞くかを持たせる: ${JSON.stringify(s.open.map(q => q.priority))}`);
});
await section(async () => {
  // F7（2026-10-06）: 要件の変化は通常の会話に出さないが、対応できないことがあるときだけ知らせる（要件の番号は出さない）（最終案の後の発言で確かめる）
  //   C-1 第 3 段: 会話の要件の変化の知らせ（requirements-changes）は削除した。対応できない要件は最終案のカードの「実現できない点」に出る（追加指示 §4）
  const goal = '金額が100万円を超えたら画面に警告を出し、CSV の読み込みでも保存を止めたい';
  const t2 = { reply: '画面の警告の計画にしました。', requirementOps: [OP({ condition: '金額が100万円を超える', behavior: '画面に警告を出す', sourceQuotes: [goal] }), OP({ condition: 'CSV の読み込み', behavior: '保存を止める', disposition: 'unsupported', note: 'CSV の読み込みでは JavaScript が動かないため', sourceQuotes: [goal] })], utteranceCoverage: [{ quote: goal, as: 'requirement', refs: [], note: '' }] };
  const x = makeConv([{ plan: planWith([]) }, { plan: planWith([]), turn: t2 }]);
  await adopt(x);
  await x.c.send(goal); await ticks();
  const fin = finalText(x);
  const cannotLine = (fin.match(/この案の制約[^\n]*/) || [''])[0];   // 2026-10-14: 計画では対応できないとされた要件は「この案の制約」
  assert(/計画では対応できないとされた要件/.test(cannotLine) && /CSV の読み込み/.test(cannotLine) && !/R\d/.test(fin) && !FS.readyOf(x.c.activePlan()) === false, `F7: 対応できないことがある要件を知らせる（最終案のカードの「実現できない点」・要件の番号なし）: ${cannotLine}`);
  //   理由（計画の AI の note）は、最終案のカードの「実現できない点」に添える（以前は会話の知らせに出ていた）
  assert(/CSV の読み込みでは JavaScript が動かないため/.test(cannotLine), `F7: 対応できない理由を添える（理由つき）: ${cannotLine}`);
  // 対応できないことが無い要件の変化は出さない（chatHtml も数えない）
  const k = makeConv([{ plan: planWith([]) }, { plan: planWith([]), turn: { reply: 'r', requirementOps: [OP({ behavior: '画面に警告を出す', sourceQuotes: [goal] })], utteranceCoverage: [{ quote: goal, as: 'requirement', refs: [], note: '' }] } }]);
  await adopt(k);
  await k.c.send(goal); await ticks();
  const chat = KTAiChatUi.chatHtml(k.c.messages()).replace(/<[^>]+>/g, ' ');
  assert(KTAiAnswers.requirementsOf(k.ledger()).some(e => e.behavior === '画面に警告を出す') && !/要件：/.test(chat) && !/追加 R\d/.test(chat) && !/計画では対応できないとされた要件/.test(finalText(k)), `F7: 対応できないことが無い要件の変化は台帳に記録するだけ（会話・最終案のカードに出さない）: ${(finalText(k).match(/実現できない点[^\n]*/) || [''])[0]}`);
});

// =========================================================
console.log('\n--- W. 作業中も会話を続ける（最初の計画・コードの生成の途中の質問と指示・先回りの返答） ---');
await section(async () => {
  // W1 / W2: 最初の計画の作成中。質問はすぐ答え（今の要件と計画: 作成中）、指示はためて、計画を版として出す前に差分で続けて入れる
  //   C-1 第 3 段（2026-10-08）: 最初の計画は仮案の採用の後に作る（working PLAN）。その作成中で確かめる。
  //   先回りの返答（plan-brief）は削除した（ai-flow-redesign F7-5）。変更案のカード（planCardHtml）と要約の記録（plan-summary）も削除した（F7-2・R09-3）。
  //   指示を入れた計画で最終案を 1 回だけ作ることは ai-flow-redesign の「指示 A1」でも守る
  const t1 = { reply: '警告の計画を作りました。', requirementOps: [OP({ condition: '金額が100万円を超える', behavior: '警告を出す', sourceQuotes: [K.REQUESTS[0]] })], utteranceCoverage: [] };
  const t2 = { reply: '100万円ちょうども対象にしました。', requirementOps: [OP({ op: 'update', id: rid(1), condition: '金額が100万円以上', behavior: '警告を出す', sourceQuotes: ['100万円ちょうども警告の対象にして'] })], utteranceCoverage: [{ quote: '100万円ちょうども警告の対象にして', as: 'requirement', refs: [rid(1)], note: '' }] };
  const x = makeConv([{ plan: planWith([]), turn: t1 }, { plan: planWith([], { customizations: [cust({ fields: [{ code: 'amount', access: 'CONTROL', condition: 'amount >= "1000000"', effects: ['warn'] }] })] }), turn: t2 }]);
  const { c, calls, ctl, byKind, ledger } = x;
  await draftUntilAdopt(x);
  const open = ctl.hold();
  const p = c.send(K.REQUESTS[3]);
  await ticks();
  assert(c.isBusy() && c.state.working === 'PLAN' && calls.ask.length === 0 && byKind('plan-brief').length === 0, `前提: 採用の後の計画の作成中（working PLAN）。先回りの返答は無い: ${c.state.working}`);
  const q = await c.send('ところで、このアプリには今いくつJavaScriptが入っていますか？');
  await ticks();
  const qc = calls.ask[0] && calls.ask[0].conversation;
  assert(q && q.asked === true && calls.ask.length === 1 && qc && qc.working === 'PLAN' && qc.plan && /^採用した仮案（最終案を作成中）/.test(qc.plan.summary) && byKind('aside-answer').length === 1 && c.planHistory().length === 0, `W1: 作成中の質問はすぐ答える（作業は止めない・作成中と伝え、前の計画を今の計画として渡さない: 渡すのは採用した仮案で「最終案を作成中」と書く）: ${qc && qc.plan && qc.plan.summary.slice(0, 30)}`);
  const ch = await c.send('100万円ちょうども警告の対象にして');
  // 2026-10-06: 受け付けた・入れた の知らせは会話に出さない（記録には残る。まだ変更案に入っていないときだけ出す）
  assert(ch && ch.queued === true && byKind('answers-ack').some(m => m.data.work === 'PLAN' && /いま作っている計画に、続けて入れます/.test(m.text) && KTAiChatUi.isHiddenMessage(m)), 'W2: 作成中の指示は受け付けてためる（受領は記録に残し、会話には出さない）');
  open(); await p; await ticks();
  const vs = c.planHistory();
  assert(vs.length === 1 && vs[0].version === 1 && vs[0].basedOnVersion === 0 && calls.plan.length === 2 && calls.plan[1].revision.mode === 'patch' && /100万円ちょうども/.test(calls.plan[1].revision.utterances[0]) && x.finals().length === 1 && vs[0].final, `W2: 指示の入っていない計画は出さず、差分で続けて入れた版だけを v1 として出す（最終案は 1 枚）: ${JSON.stringify(vs.map(v => v.version))}`);
  const r1 = KTAiAnswers.requirementsOf(ledger()).find(e => e.id === rid(1));
  const acksW2 = byKind('answers-ack');
  assert(r1 && r1.condition === '金額が100万円以上' && r1.history.length === 1 && acksW2.length && acksW2.every(m => m.data.stage === 'done' && /変更案に入れました/.test(m.text)), `W2: 要件は続けた作業で更新（履歴に前の条件）・受領は「変更案に入れました」: ${acksW2.map(m => m.text).join(' / ')}`);
  // 順番: 作成中の質問の答え → 最終案
  const idx = (k) => c.messages().findIndex(m => (m.data?.kind || m.type) === k);
  assert(idx('aside-answer') >= 0 && idx('aside-answer') < idx('FINAL'), 'W2: 作成中の質問の答えは、最終案より先に出る');
});
await section(async () => {
  // W3: コードの生成中の指示 → 生成の後に計画へ（前の仕様のコードは使わない）。生成を止めたり繰り返したりしない
  //   C-1 第 3 段: 仕様の確定と従来の生成は削除した。生成は採用の後の最終案のパイプラインで行う（working FINAL）。その生成中で確かめる。
  //   前の仕様のコードの知らせ（generated-stale）と［この変更で確定してコードを作る］（confirm-generate）は削除した。生成の後の差分更新で
  //   変わった JavaScript を作り直す（ai-flow-redesign R11-1〜R11-6・R18-1）
  const x = makeConv([{ plan: planWith([]) }, { plan: planWith([], { customizations: [cust({ requirement: '金額が100万円以上なら警告', fields: [{ code: 'amount', access: 'CONTROL', condition: 'amount >= "1000000"', effects: ['warn'] }] })] }) }]);
  const { c, calls, ctl, byKind } = x;
  await draftUntilAdopt(x);
  const gPlan = ctl.hold(), gGen = ctl.hold();
  const g = c.send(K.REQUESTS[3]);
  await ticks(); gPlan(); await ticks(10);
  const v1 = c.activePlan();
  assert(c.isBusy() && c.state.working === 'FINAL' && v1 && calls.plan.length === 1, `前提: 計画ができて生成中（working FINAL）: ${c.state.working}`);
  const ch = await c.send('警告は100万円ちょうども対象にして');
  assert(ch && ch.queued === true && byKind('answers-ack').some(m => m.data.work === 'FINAL'), `W3: コードの生成中の指示も受け付けてためる: ${JSON.stringify(byKind('answers-ack').map(m => m.data.work))}`);
  const q = await c.send('この警告は一覧画面でも出ますか？');
  assert(q && q.asked === true, 'W3: 生成中の質問はすぐ答える');
  gGen(); await g; await ticks(12);
  const v2 = c.activePlan();
  const req2 = (v2.generated && v2.generated.C1 && v2.generated.C1.requiredEffects) || [];
  assert(calls.generate === 2 && v2.version === 2 && v1.status === 'SUPERSEDED' && v2.generated.C1.reused !== true && req2.some(e => e.condition === 'amount >= "1000000"') && x.finals().length === 2 && !byKind('generated-stale').length && !byKind('confirm-generate').length, `W3: 生成は止めずに 1 回で終え、生成の後に計画を v2 にし、v2 は新しい仕様で作り直す（前の仕様のコードは使わない）: ${JSON.stringify({ gen: calls.generate, v: v2.version })}`);
});
//   W4（先回りの返答が計画より後に届いたら出さない）: C-1 第 3 段で先回りの返答（assistant-qa の brief・plan-brief）そのものを削除した。
//   対応する回帰: ai-flow-redesign の F7-5（先回りの返答は使わない）・R01-1（新しい依頼は仮案の AI へ。先回りの返答は呼ばない）

await section(async () => {
  // W5: 作成中の指示を続けて入れた v1 の表示: 版として出さなかった計画の返答は出さない（採用の後の計画の作成中で確かめる）
  //   C-1 第 3 段: 要件の変化の会話の知らせ（「追加 R1」）は削除した（最終案のカードの「変わった点」: ai-flow-redesign R11-5）。
  //   返答は最終案のカードの「仮案から変わった点と理由」に出るので、そこに版として出さなかった計画の返答が混ざらないことを確かめる
  const t1 = { reply: '100万円を超えたら警告を出す計画にしました（100万円ちょうどは対象外）。', requirementOps: [OP({ condition: '金額が100万円を超える', behavior: '警告を出す', sourceQuotes: [K.REQUESTS[0]] })], utteranceCoverage: [] };
  const t2 = { reply: '100万円ちょうども対象にしました。', requirementOps: [OP({ op: 'update', id: rid(1), condition: '金額が100万円以上', behavior: '警告を出す', sourceQuotes: ['100万円ちょうども警告の対象にして'] })], utteranceCoverage: [{ quote: '100万円ちょうども警告の対象にして', as: 'requirement', refs: [rid(1)], note: '' }] };
  const x = makeConv([{ plan: planWith([]), turn: t1 }, { plan: planWith([]), turn: t2 }]);
  const { c, ctl, ledger } = x;
  await draftUntilAdopt(x);
  const open = ctl.hold();
  const p = c.send(K.REQUESTS[3]);
  await ticks();
  await c.send('100万円ちょうども警告の対象にして');
  open(); await p; await ticks();
  const fin = finalText(x);
  const added = KTAiAnswers.requirementsOf(ledger()).filter(e => e.behavior === '警告を出す');
  assert(/100万円ちょうども対象にしました。/.test(fin) && !/100万円ちょうどは対象外/.test(fin) && added.length === 1 && added[0].id === rid(1), `W5: 出さなかった計画の返答（「ちょうどは対象外」）を最終案のカードに出さず、要件は 1 件（続けた作業で更新）: ${(fin.match(/仮案から変わった点と理由[^\n]*\n?[^\n]*/) || [''])[0]}`);
});

// =========================================================
console.log('\n--- R. 差分レビューの指摘（失敗・前の計画・作成中の文の形・誤判定・根拠の照合・見逃し・上限） ---');
//   R1（H1。最初の計画を作れなかったら、先回りの返答だけを残さずエラーを出して ok:false・［再試行］に依頼の文）: C-1 第 3 段で最初の依頼から直接に計画を作る経路と
//   先回りの返答を削除した。採用の後の計画の失敗の回帰: ai-flow-redesign の B3-1（計画を作れなかったら仮案は open に戻り、履歴に失敗を残す）・
//   B3-2（失敗のカードの［再試行］は「採用します」）・B3-11 / B3-12（例外のときも同じ）・F7-5（先回りの返答は使わない）
await section(async () => {
  // R2（H2）: 反映済みの前の計画がある状態で新しい計画を作り、その作成中に受けた指示も入れる（以前は「置き換わった」として新しい計画ごと捨てた）
  //   C-1 第 3 段: 反映済みの後の新しい依頼は仮案から（afterPlan。ai-flow-redesign F6-1）。その仮案の採用の後の計画の作成中で確かめる
  const x = makeConv([{ plan: planWith([]) }]);
  const { c, calls, ctl } = x;
  await adopt(x);
  const old = c.activePlan(); old.status = 'EXECUTED';
  await draftUntilAdopt(x);
  const d2 = c.draft();
  const open = ctl.hold();
  const p = c.send(K.REQUESTS[3]);
  await ticks();
  const q = await c.send('土日は除いてほしい');
  open(); const r = await p; await ticks();
  const hist = c.planHistory().map(v => `${v.planId === old.planId ? 'old' : 'new'}:v${v.version}`);
  assert(d2 && d2.afterPlan === old.planId && q && q.queued === true && r.ok === true && !r.superseded && hist.join() === 'old:v1,new:v1' && c.activePlan().planId !== old.planId && calls.plan.length === 3 && /土日は除いて/.test(calls.plan[2].revision.utterances[0]), `R2: 前の計画が反映済みでも、新しい計画の作成中の指示を入れた v1 を出す: ${JSON.stringify({ hist, ok: r.ok, superseded: r.superseded })}`);
});
await section(async () => {
  // R3（H3）: 作成中に受けた指示を続けて入れる作業が失敗しても、できていた最初の計画は v1 として出す（入っていないのはその指示だけ。再試行はその指示の原文で）
  //   C-1 第 3 段: 最初の計画は仮案の採用の後に作る。その作成中で確かめる
  const x = makeConv([{ plan: planWith([]) }, { fail: { ok: false, reason: 'ERROR', message: '計画の修正に失敗しました' } }, { plan: planWith([]) }]);
  const { c, ctl, byKind } = x;
  await draftUntilAdopt(x);
  const open = ctl.hold();
  const p = c.send(K.REQUESTS[3]);
  await ticks();
  await c.send('100万円ちょうども警告の対象にして');
  open(); const r = await p; await ticks();
  const err = c.messages().find(m => m.type === 'ERROR');
  // 2026-10-06: 失敗した受領（まだ変更案に入っていない）は会話に出す
  assert(r.ok === false && c.planHistory().length === 1 && c.activePlan().version === 1 && c.activePlan().final && err && err.data.retryText === '100万円ちょうども警告の対象にして' && !err.data.intent && byKind('answers-ack').length && byKind('answers-ack').every(m => m.data.stage === 'failed' && !KTAiChatUi.isHiddenMessage(m) && /まだ変更案に入っていません/.test(KTAiChatUi.messageHtml(m))), `R3: 続けた作業の失敗でも最初の計画は v1（最終案も出す）。指示の受領は「失敗」（まだ変更案に入っていないと会話に出す）・再試行は指示の原文（振り分け直す）: ${JSON.stringify({ hist: c.planHistory().length, retry: err && err.data.retryText, intent: err && err.data.intent, ack: byKind('answers-ack').map(m => KTAiChatUi.messageHtml(m).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) })}`);
  const rr = await c.send(err.data.retryText, { intentOverride: err.data.intent }); await ticks();
  assert(rr.ok === true && c.activePlan().version === 2, 'R3: 再試行で、その指示を v1 に入れた v2 ができる（以前は「修正する計画がありません」）');
  // 取り消し（例外）でも同じ
  const k = makeConv([{ plan: planWith([]) }, { cancel: true }]);
  await draftUntilAdopt(k);
  const open2 = k.ctl.hold();
  const p2 = k.c.send(K.REQUESTS[3]);
  await ticks();
  await k.c.send('100万円ちょうども警告の対象にして');
  open2(); const r2 = await p2; await ticks();
  assert(r2.cancelled === true && k.c.planHistory().length === 1 && k.c.activePlan().version === 1, `R3: 続けた作業を取り消しても、最初の計画は v1: ${JSON.stringify({ cancelled: r2.cancelled, hist: k.c.planHistory().length })}`);
});
await section(async () => {
  // R4（H4）: 計画が無い最初の作成中は、文の形だけで分ける: 質問でない文（回答の形の短い指示も）はためて計画に入れる。版になる前の土台に続けて入れている間も同じ
  //   C-1 第 3 段: 最初の計画は仮案の採用の後に作る。その作成中で確かめる
  const x = makeConv([{ plan: planWith([]) }, { plan: planWith([]) }, { plan: planWith([]) }]);
  const { c, calls, ctl } = x;
  await draftUntilAdopt(x);
  const open = ctl.hold();
  const p = c.send(K.REQUESTS[3]);
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
  assert(more && more.queued === true && /保存は止めない/.test(calls.plan[1].revision.utterances.join()) && /モバイルも対象に/.test(calls.plan[2].revision.utterances.join()) && c.planHistory().length === 1, `R4: 版になる前の土台に続けて入れている間の指示もためて、次の作業で入れる: ${JSON.stringify(calls.plan.map(y => y.revision && y.revision.utterances))}`);
  assert(calls.ask.map(a => a.question).join() === '警告は一覧画面でも出ますか？', 'R4: 質問の AI に回したのは質問だけ（先回りの返答は無い）');
});
await section(async () => {
  // R5（H5）: 文の質問の判定は文末の形で決める。文の途中の「している」「わかる」で指示を質問にしない
  const isQ = KTAiConversation.isQuestionSentence;
  assert(!isQ('完了している案件にも警告を出して') && !isQ('わかるように赤字で表示して') && !isQ('何件でも登録できるようにして') && isQ('CSVにも効きますか？') && isQ('承認者は誰がいい') && isQ('どこに表示されるの') && isQ('このフィールドは何に使ってる'), 'R5: 文末の形で質問か決める（「完了している案件にも警告を出して」は指示）');
  //   C-1 第 3 段: 会話は最終案の後の発言で確かめる
  const t2 = { reply: 'r', requirementOps: [], utteranceCoverage: [] };
  const x = makeConv([{ plan: planWith(qs(QP, QS)) }, { plan: planWith(qs(QS)), turn: t2 }]);
  const { c, calls } = x;
  await adopt(x);
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
  //   C-1 第 3 段: 会話は最終案の後の発言で確かめる
  const x = makeConv([{ plan: planWith([]) }]);
  const { c, calls } = x;
  await adopt(x);
  await c.send('了解しました'); await ticks();
  assert(calls.plan.length === 1 && c.activePlan().version === 1, 'R6: 「了解しました」で計画を作り直さない（以前は v2 ができた）');
});
await section(async () => {
  // R7（M2）: 命令＋質問の発言は、命令を実行し、質問は同時に答える
  const v = { planId: 'p', version: 1, status: 'ACTIVE', plan: planWith([]), review: { steps: [] }, spec: { status: 'CONFIRMED', version: 1 } };
  const cls = (t) => KTAiConversation.classifyIntent(t, { activePlan: v, ledgers: new Map() });
  const a = cls('これで進めて。CSVにも効きますか？'), b = cls('コードを作って。CSVにも効きますか？');
  assert(a.intent === I.REQUEST_PREVIEW && /CSV/.test(a.askText) && b.intent === I.GENERATE_CODE && /CSV/.test(b.askText), `R7: 命令の判定は質問の文を除いた部分で行う: ${a.intent} ${b.intent}`);
  //   C-1 第 3 段: 仕様の確定と従来の生成は削除した。最終案の後の「コードを作って」は最終案の作り直し（ai-flow-redesign F2-1）。
  //   最初の生成を失敗させ、作り直す JavaScript がある最終案で確かめる（検証済みだけなら作り直さない: F2-4）
  let n = 0;
  const base = K.makeGenerate({ sequence: ['warn'] });
  const gen = { calls: base.calls, impl: async (args) => { n += 1; if (n === 1) return { ok: false, reason: 'UPSTREAM_ERROR', message: 'AI の応答を取得できませんでした（テスト）' }; return base.impl(args); } };
  const x = makeConv([{ plan: planWith([]) }], { generate: gen });
  const { c, calls } = x;
  const v1 = await adopt(x);
  const g0 = calls.generate;
  assert(v1 && v1.generated.C1 && v1.generated.C1.status === 'failed', `前提: 最初の生成は失敗（作り直す JavaScript がある）: ${v1 && v1.generated.C1 && v1.generated.C1.status}`);
  await c.send('コードを作って。CSVにも効きますか？');
  await ticks();
  assert(calls.generate === g0 + 1 && calls.plan.length === 1 && c.activePlan().version === 2 && c.activePlan().generated.C1.status === 'verified' && calls.ask.some(a2 => /CSV/.test(a2.question)), `R7: コードを作り（計画は作り直さない）、質問は同時に答える: ${JSON.stringify({ gen: calls.generate - g0, plans: calls.plan.length })}`);
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
  // R10（M4）: AI 自身の質問文を引用しても「利用者の決定」にしない（Toolkit が組み立てた依頼文は利用者の文として数えない）（最終案の後の回答で確かめる）
  const t2 = { reply: 'r', requirementOps: [OP({ behavior: '保存を止める', sourceQuotes: ['金額が大きいとき、保存を止めますか'] })], utteranceCoverage: [{ quote: 'いいえ', as: 'answer', refs: [], note: '' }] };
  const x = makeConv([{ plan: planWith(qs(QS)) }, { plan: planWith([]), turn: t2 }]);
  const { c, calls, ledger } = x;
  await adopt(x);
  await c.send('いいえ'); await ticks();
  const e = KTAiAnswers.requirementsOf(ledger()).find(y => y.behavior === '保存を止める');
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
  // R12（M6）: 対応先の決まらない回答でも、質問の部分は同時に答える（最終案の後の回答で確かめる）
  //   C-1 第 3 段: 対応先を聞き返すカード（answer-target）は削除した。候補の確認事項を添えて計画の AI に渡す（ai-flow-redesign F4-1・F4-2）
  const x = makeConv([{ plan: planWith(qs({ question: '金額が大きいとき、保存を止めますか？', topic: 'save_block' }, { question: '承認者にメールで通知しますか？', topic: 'notify' })) }, { plan: planWith([]) }]);
  const { c, calls, byKind } = x;
  await adopt(x);
  await c.send('いいえ。CSVの読み込みにも効きますか？');
  await ticks();
  assert(byKind('answer-target').length === 0 && calls.plan.length === 2 && /候補の確認事項/.test(calls.plan[1].revision.request) && calls.ask.some(a => /CSV/.test(a.question)), `R12: 対応先は聞き返さずに計画の AI へ渡し、質問の部分は同時に答える: ${JSON.stringify({ target: byKind('answer-target').length, asks: calls.ask.map(a => a.question.slice(0, 10)) })}`);
});
await section(async () => {
  // R13（M7）: 並べて走らせた質問の答えを待たずに、計画ができたら次の入力を受け付ける（最終案の後の発言で確かめる）
  const x = makeConv([{ plan: planWith(qs(QP, QS)) }, { plan: planWith(qs(QS)) }]);
  const { c, ctl } = x;
  await adopt(x);
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
  // 会話: 上限に達したことを画面に出す（C-1 第 3 段: 最終案の後の発言で確かめる。台本の仮案の要件 4 件があるので、41 件の追加のうち 5 件が上限を超える）
  const u2 = '要件をたくさん追加して';
  const t2 = { reply: 'r', requirementOps: Array.from({ length: 41 }, (_, i) => OP({ behavior: `要件 ${i + 1}`, sourceQuotes: [u2] })), utteranceCoverage: [{ quote: u2, as: 'requirement', refs: [], note: '' }] };
  const x = makeConv([{ plan: planWith([]) }, { plan: planWith([]), turn: t2 }]);
  await adopt(x);
  await x.c.send(u2); await ticks();
  const ov = x.byKind('requirements-overflow');
  assert(ov.length === 1 && /上限（40 件/.test(ov[0].text) && ov[0].data.count === 41 - (40 - BASE_REQS) && !KTAiChatUi.isHiddenMessage(ov[0]), `R14: 上限で記録できなかった指示があることを知らせる（黙って落とさない）: ${ov.map(m => m.data.count).join()}`);
});
await section(async () => {
  // R15: 作業中の質問の対象を決められないときは、普通の質問と同じく候補を選んでもらう（エラーにしない。作業は続ける）
  //   C-1 第 3 段: 採用の後の計画の作成中で確かめる（先回りの返答は削除した）
  const amb = { ok: false, reason: 'ambiguous', candidates: [{ type: 'field', id: 'amount', label: '金額（amount）' }, { type: 'field', id: 'total', label: '合計（total）' }], message: '対象を特定できませんでした。' };
  const x = makeConv([{ plan: planWith([]) }], { askResult: () => amb });
  const { c, ctl, byKind } = x;
  await draftUntilAdopt(x);
  const open = ctl.hold();
  const p = c.send(K.REQUESTS[3]);
  await ticks();
  await c.send('金額と合計はどう違いますか？');
  await ticks();
  open(); await p; await ticks();
  assert(byKind('candidates').length === 1 && byKind('candidates')[0].data.candidates.length === 2 && !c.messages().some(m => m.type === 'ERROR') && c.planHistory().length === 1 && c.activePlan().final, 'R15: 作業中の質問の対象の候補を出す（エラーにしない）・計画（最終案）はできる');
});
//   R16（実機 2026-10-05。仕様が未確定のまま「C1 のコードを作って」→ 仕様カード → 確定。確定のカードを 2 枚続けて出さない）: C-1 第 3 段で仕様の確定
//   （confirmSpec・会話の仕様カード・spec-confirmed の知らせ）を削除した。JavaScript の仕様は最終案のパイプラインが自動で確定する。対応する回帰:
//   ai-flow-redesign の R09-2（JS の仕様は自動で確定・［この仕様で確定］は無い）・F7-1（会話に仕様の確定は無い）・F7-3（右の仕様は閲覧だけ）・
//   F2-7（最終案が無いときの「コードを作って」は生成しない）
// =========================================================
console.log('\n--- G. 「…変えて、コードも作って」の命令の節（実機 2026-10-05 と差分レビューの指摘） ---');
await section(async () => {
  // G1: コードを作る依頼（目的語つき）がある変更は、言い方・区切り方によらず「計画を更新してから作る」。発言は切り取らない（原文のまま計画の AI へ）
  const v = { planId: 'p', version: 1, status: 'ACTIVE', plan: planWith([]), review: { steps: [] }, spec: { status: 'DRAFT', version: 1 } };
  const cls = (t) => KTAiConversation.classifyIntent(t, { activePlan: v, ledgers: new Map() });
  const ttg = ['条件を変えて、コードも作って', '条件を変えて、コードも作成して', '条件を変えて、コードを再生成して', '条件を変えて、コードも作ってほしい', '条件を変えて、あわせてコードも作って',
    '条件を変えて、C1 のコードも作って', '条件を変えてコードも作って', '条件を変えて コードも作って', '条件を変えて.コードも作って', 'コードも作って、条件を変えて', '改めてコードを作って、条件も変えて',
    '保存は止めないでコードも作って', '条件を変えて、コードも作ってもらえる？', '警告の文は「高額案件です」に変えて、修正後のコードも作って', '条件を変えて、コードも作って。CSVにも効きますか？'];
  const bad = ttg.map(t => ({ t, r: cls(t).reason })).filter(x => x.r !== 'TURN_THEN_GENERATE');
  assert(!bad.length, `G1: コードを作る依頼つきの変更は、計画を更新してから作る（言い方・区切り方・依頼の問いの形によらない）: ${JSON.stringify(bad)}`);
  const notCode = ['見積書をPDFで生成して', '管理番号を自動で生成して', '承認者は部長にして'];
  const bad2 = notCode.map(t => ({ t, c: cls(t) })).filter(x => x.c.alsoGenerate || x.c.intent === I.GENERATE_CODE);
  assert(!bad2.length && cls('見積書をPDFで生成して').reason === 'TURN', `G1: 目的語がコードでない「生成して」は要件の文（計画の AI へ。コードの依頼にしない）: ${JSON.stringify(bad2.map(x => ({ t: x.t, i: x.c.intent, r: x.c.reason })))}`);
  const mixed = cls('条件を変えて、コードも作って。CSVにも効きますか？');
  assert(mixed.decisionText === '条件を変えて' && mixed.restText === '条件を変えて、コードも作って。' && /CSV/.test(mixed.askText || ''), `G1: 決定事項の置き換えには質問の文とコードを作る命令の節を除いた部分、再試行には質問の文を除いた部分を使う: ${mixed.decisionText}`);
  assert(cls('コードを作った？').intent !== I.GENERATE_CODE && cls('コードはもう作ってある？').intent !== I.GENERATE_CODE, 'G1: 状態を聞く問い（「コードを作った？」）は命令ではない');
  assert(!KTAiConversation.isQuestionSentence('保存を止めてもらえる？') && !KTAiConversation.isQuestionSentence('コードも作ってくれますか？') && KTAiConversation.isQuestionSentence('違いを教えてもらえる？'), 'G1: 依頼の問いの形（〜してもらえる？）は質問ではなく依頼（「教えてもらえる？」は質問）');
});
await section(async () => {
  // G2: コードを作る命令だけの文は、言い方によらず GENERATE_CODE（計画を見直さない）
  const v = { planId: 'p', version: 1, status: 'ACTIVE', plan: planWith([]), review: { steps: [] }, spec: { status: 'CONFIRMED', version: 1 } };
  const cls = (t) => KTAiConversation.classifyIntent(t, { activePlan: v, ledgers: new Map() });
  const ts = ['コードを作って', 'コードを作成して', 'コードも作成して', 'コードを作ってほしい', 'コードも作ってもらえる？', 'C1 のコードを作成してください', 'コードを再生成して', 'コードを書き出して',
    '改めてコードを作って', '再度コードを作って', 'コードを作っていただけますか？', 'コードを作ってくれませんか', '最新のコードを作って', '修正後のコードを作って'];
  const bad = ts.map(t => ({ t, i: cls(t).intent })).filter(x => x.i !== I.GENERATE_CODE);
  assert(!bad.length, `G2: 命令だけの文は言い方によらずコードの生成（計画は見直さない）: ${JSON.stringify(bad)}`);
  assert(cls('顧客コードを生成して').intent !== I.GENERATE_CODE, 'G2: 「顧客コードを生成して」はコードの生成の命令ではない');
});
await section(async () => {
  // G3: 作り直しの途中に受け付けた「…変えて、コードも作って」: 原文のまま積み、計画の AI にはコードの生成は計画の後と伝える（最終案の後の差分更新で確かめる）
  //   C-1 第 3 段: 作業の後の［この変更で確定してコードを作る］（confirm-generate）は削除した。JavaScript は最終案のパイプラインが作る（ai-flow-redesign F3-1）
  const x = makeConv([{ plan: planWith([]) }, { plan: planWith([]) }, { plan: planWith([]) }]);
  const { c, calls, ctl, byKind } = x;
  await adopt(x);
  const open = ctl.hold();
  const p = c.send('100万円ちょうども警告の対象に変えて');
  await ticks();
  const q = await c.send('警告の文は「高額案件です」に変えて、コードも作って');
  open(); await p; await ticks();
  assert(q && q.queued === true && calls.plan.length === 3 && calls.plan[2].revision.request === '修正の依頼：警告の文は「高額案件です」に変えて、コードも作って' && calls.plan[2].revision.generateAfter === true && !calls.plan[1].revision.generateAfter, `G3: 作り直しの途中の「…コードも作って」は、その指示を入れる作業だけに generateAfter: ${JSON.stringify(calls.plan.map(y => y.revision && y.revision.generateAfter))}`);
  assert(x.finals().length === 2 && c.activePlan().final && !byKind('confirm-generate').length, `G3: 作業の後は最終案を置き換える（確定して作るカードは出さない）: ${x.finals().length}`);
});
await section(async () => {
  // G4: 最初の計画の作成中に受け付けた「…変えて、コードも作って」も同じ（v1 に入れる）。依頼の問いの形（〜もらえる？）も指示としてためる
  //   C-1 第 3 段: 採用の後の計画の作成中で確かめる。v1 の後の［この変更で確定してコードを作る］は削除した（JavaScript は最終案のパイプラインが作る: R09-4）
  const x = makeConv([{ plan: planWith([]) }, { plan: planWith([]) }]);
  const { c, calls, ctl, byKind } = x;
  await draftUntilAdopt(x);
  const open = ctl.hold();
  const p = c.send(K.REQUESTS[3]);
  await ticks();
  const q = await c.send('100万円ちょうども警告の対象に変えて、コードも作ってもらえる？');
  open(); await p; await ticks();
  assert(q && q.queued === true && calls.plan.length === 2 && calls.plan[1].revision.request === '修正の依頼：100万円ちょうども警告の対象に変えて、コードも作ってもらえる？' && calls.plan[1].revision.generateAfter === true && c.planHistory().length === 1 && x.finals().length === 1 && !byKind('confirm-generate').length, `G4: 作成中の「…コードも作ってもらえる？」はためて v1 に入れる（最終案は 1 枚）: ${JSON.stringify(calls.plan[1] && calls.plan[1].revision)}`);
});
await section(async () => {
  // G5: 「…変えて、コードも作って」の作り直しの途中に同じ文をもう一度送っても積まない（二重の作り直しにしない）（最終案の後の差分更新で確かめる）
  const x = makeConv([{ plan: planWith([]) }, { plan: planWith([]) }, { plan: planWith([]) }]);
  const { c, calls, ctl } = x;
  await adopt(x);
  const open = ctl.hold();
  const p = c.send('警告の文は「高額案件です」に変えて、コードも作って');
  await ticks();
  const again = await c.send('警告の文は「高額案件です」に変えて、コードも作って');
  open(); await p; await ticks();
  assert(again && again.queued === false && calls.plan.length === 2, `G5: 同じ文の二重の送信は積まない（計画の呼び出し 2 回）: ${JSON.stringify({ again: again && again.reason, plans: calls.plan.length })}`);
});
await section(async () => {
  // G6: 「…変えて、コードも作って」の作り直しが失敗したら、再試行は元の発言を振り分け直す（コードの生成は計画の後と伝える）（最終案の後の差分更新で確かめる）
  //   C-1 第 3 段: 再試行の後の［この変更で確定してコードを作る］は削除した（最終案を置き換える: ai-flow-redesign F3-1）
  const x = makeConv([{ plan: planWith([]) }, { fail: { ok: false, reason: 'ERROR', message: '計画の修正に失敗しました' } }, { plan: planWith([]) }]);
  const { c, calls } = x;
  await adopt(x);
  await c.send('100万円ちょうども警告の対象に変えて、コードも作って'); await ticks();
  const err = c.messages().filter(m => m.type === 'ERROR').slice(-1)[0];
  assert(err && err.data.retryText === '100万円ちょうども警告の対象に変えて、コードも作って' && !err.data.intent, `G6: 再試行の文は元の発言（意図は振り分け直す）: ${JSON.stringify(err && { t: err.data.retryText, i: err.data.intent })}`);
  await c.send(err.data.retryText, { intentOverride: err.data.intent || null }); await ticks();
  assert(calls.plan.length === 3 && calls.plan[2].revision.generateAfter === true && c.activePlan().version === 2 && x.finals().length === 2 && !c.messages().some(m => m.data?.kind === 'confirm-generate'), `G6: 再試行でも generateAfter を付け、最終案を置き換える: ${JSON.stringify(calls.plan[2] && calls.plan[2].revision.generateAfter)}`);
});
await section(async () => {
  // G7: 作り直しの版のカードにも Toolkit が付けた「修正の依頼：」を出さない（最終案の後の差分更新で確かめる）
  //   C-1 第 3 段: 変更案のカード（planCardHtml）は削除した（ai-flow-redesign F7-2）。作り直しの版は最終案のカードで「最終案を直しました。」と出し、
  //   版の番号を出さない（R09-10）。カードの「変わった点」の入れた指示に Toolkit が付けた「修正の依頼：」が出ないことを、置き換えた最終案のカードで確かめる
  const x = makeConv([{ plan: planWith([]) }, { plan: planWith([]) }, { plan: planWith([]) }]);
  const { c, ctl } = x;
  await adopt(x);
  const open = ctl.hold();
  const p = c.send('警告の文は「高額案件です」に変えて');
  await ticks();
  await c.send('PC だけで動くようにして');
  open(); await p; await ticks();
  const v = c.activePlan();
  const html = finalText(x);
  assert(/最終案を直しました。/.test(html) && !/v\d/.test(html.replace(/[A-Za-z0-9_.-]*\.js/g, '')), `G7: 作り直しの版のカードは「最終案を直しました。」（版の番号を出さない）: ${html.slice(0, 120)}`);
  assert(!/修正の依頼：/.test(html), `G7: 最終案のカードの「変わった点」に Toolkit が付けた「修正の依頼：」を出さない: ${(html.match(/入れた指示: [^\n]*(\n[^\n]*)?/) || [''])[0]}`);
  const reqs = (v.revisionRequests || []).join(' ');
  assert(/警告の文は「高額案件です」に変えて/.test(reqs) && /PC だけで動くようにして/.test(reqs), `G7: カードに出さなくても、2 つの指示は版の修正の依頼の履歴に残る: ${JSON.stringify(v.revisionRequests)}`);
});
await section(async () => {
  // G8: 質問の文で決定事項を置き換えない（TURN でも、質問を除いた部分で置き換えを判断する）（最終案の後の回答で確かめる）
  const x = makeConv([{ plan: planWith(qs(QP, QS)) }, { plan: planWith(qs(QS)) }, { plan: planWith(qs(QS)) }]);
  const { c, ledger } = x;
  await adopt(x);
  await c.send('PCだけ'); await ticks();
  const dPlat = () => ledger().entries.find(e => e.topics.includes('platform') && e.answer);
  assert(dPlat() && dPlat().status === 'answered', '前提: PC / モバイルは「PCだけ」で回答済み');
  await c.send('警告は赤字にして。モバイルでも出ますか？'); await ticks();
  assert(dPlat().status === 'answered', `G8: 質問の文（モバイルでも出ますか？）で PC だけの決定事項を置き換えない: ${dPlat().status}`);
});
await section(async () => {
  // G0（実機 2026-10-05）: Gateway に送る作り直しの情報（compactRevision の後）にも generateAfter が残る（以前はここで落ち、計画の AI が「コードを作成する」を要件にした）
  const { KTContext } = require('./helpers/load-toolkit.js').loadToolkit();
  const rev = KTContext.compactRevision({ basedOnVersion: 1, request: '警告の文を変えて、コードも作って', previousPlan: { steps: [], summary: {} }, mode: 'patch', utterances: ['警告の文を変えて、コードも作って'], generateAfter: true });
  const rev0 = KTContext.compactRevision({ basedOnVersion: 1, request: '警告の文を変えて', previousPlan: { steps: [], summary: {} } });
  assert(rev.generateAfter === true && !('generateAfter' in rev0), `G0: 作り直しの情報に generateAfter を残す（印が無ければ送らない）: ${JSON.stringify({ a: rev.generateAfter, b: rev0.generateAfter })}`);
  const { KTContextUi } = require('./helpers/load-toolkit.js').loadToolkit();
  const first = KTContextUi.generatePlan({ goal: '金額が大きいときに警告を出したい。コードも作って', inputs: { data: DATA, deps: DEPS }, generateAfter: true });
  const first0 = KTContextUi.generatePlan({ goal: '金額が大きいときに警告を出したい', inputs: { data: DATA, deps: DEPS } });
  assert(first.ok && first.ctx.generateAfter === true && !('generateAfter' in first0.ctx), 'G0: 最初の計画の Context にも generateAfter を載せる（印が無ければ載せない）');
});
await section(async () => {
  // G9: 作業中に受け付けた「…変えて、コードも作って」を入れる作業が失敗したら、再試行はその原文を振り分け直す（コードの依頼を落とさない）（最終案の後の差分更新で確かめる）
  //   C-1 第 3 段: 再試行の後の［この変更で確定してコードを作る］は削除した（最終案を置き換える）
  const x = makeConv([{ plan: planWith([]) }, { plan: planWith([]) }, { fail: { ok: false, reason: 'ERROR', message: '計画の修正に失敗しました' } }, { plan: planWith([]) }]);
  const { c, calls, ctl } = x;
  await adopt(x);
  const open = ctl.hold();
  const p = c.send('100万円ちょうども警告の対象に変えて');
  await ticks();
  await c.send('警告の文は「高額案件です」に変えて、コードも作って');
  open(); await p; await ticks();
  const err = c.messages().filter(m => m.type === 'ERROR').slice(-1)[0];
  assert(err && err.data.retryText === '警告の文は「高額案件です」に変えて、コードも作って' && !err.data.intent && c.activePlan().version === 2, `G9: 作業中に受けた指示の作業の失敗: 再試行はその原文（振り分け直す）: ${JSON.stringify(err && { t: err.data.retryText, i: err.data.intent })}`);
  await c.send(err.data.retryText, { intentOverride: err.data.intent || null }); await ticks();
  assert(calls.plan.length === 4 && calls.plan[3].revision.generateAfter === true && c.activePlan().version === 3 && c.activePlan().final && !c.messages().some(m => m.data?.kind === 'confirm-generate'), 'G9: 再試行で計画を更新し、最終案を置き換える');
});
await section(async () => {
  // G10: 作り直した計画に JavaScript が無ければ、コードは作らないことを知らせる（コードの依頼を黙って捨てない）（最終案の後の差分更新で確かめる）
  //   C-1 第 3 段: 会話の知らせ（generate-not-needed）の代わりに、最終案のカードの検証の区分が「JavaScript は無く、設定の変更だけです」と出す
  const x = makeConv([{ plan: planWith([]) }, { plan: planWith([], { customizations: [], steps: [step('P1', 'ADD_VIEW', 'VIEW', '高額案件', { name: '高額案件', fields: ['amount'] })], solution: 'STANDARD' }) }]);
  const { c, calls, byKind } = x;
  await adopt(x);
  const g0 = calls.generate;
  await c.send('警告はやめて一覧だけにして、コードも作って'); await ticks();
  const v2 = c.activePlan();
  assert(v2.version === 2 && v2.final && v2.final.customizations.length === 0 && /JavaScript は無く、設定の変更だけです/.test(rightText(x)) && calls.generate === g0 && byKind('confirm-generate').length === 0, `G10: JavaScript の無い計画では、コードは作らないと知らせる（最終案のカード）: ${JSON.stringify({ v: v2.version, gen: calls.generate - g0 })}`);
});
//   G11（コードの生成中に受け付けた「…変えて、C2 のコードも作って」→［この変更で確定してコードを作る］の対象を C2 にする）: C-1 第 3 段で確定して作るカード
//   （confirm-generate）を削除した。生成中の指示は完了後に差分更新し、変わった JavaScript だけを作り直して最終案を置き換える。対応する回帰:
//   ai-flow-redesign の R11-2〜R11-5（生成中の指示 → 完了後に差分更新 → 実装仕様が同じものは作り直さない）・R18-1（実装仕様が変わったものだけ作り直す）・F3-1
await section(async () => {
  // W6（実機 2026-10-05）: 作業中の入力欄の案内は作業の種類ごと。最初の計画の作成中に「作り直しています」・質問は「応答の後に」と出さない
  const h = KTAiChatUi.busyHintText;
  assert(/^計画を作っています。質問にはすぐ答えます/.test(h('PLAN')) && /できた計画に続けて入れます/.test(h('PLAN')) && /^コードを作っています/.test(h('GENERATE')) && /^計画を作り直しています/.test(h('REVISE'))
    && ![h('PLAN'), h('GENERATE'), h('REVISE')].some(x => /応答の後に送れます/.test(x)) && /下書きとして残しています/.test(h('PLAN', { accepted: false })) && /^計画を作っています/.test(h('PLAN', { accepted: false })), `W6: 作業の種類ごとの案内: ${h('PLAN')} ｜ ${h('PLAN', { accepted: false })}`);
});
await section(async () => {
  // W7（実機 2026-10-05）: 最初の計画の作成中の同意（「その案でお願いします。」）は修正の依頼として積まない（計画の AI を余計に呼ばない）
  //   C-1 第 3 段: 最初の計画は仮案の採用の後に作る。その作成中で確かめる
  const x = makeConv([{ plan: planWith([]) }, { plan: planWith([]) }]);
  const { c, calls, ctl, byKind } = x;
  await draftUntilAdopt(x);
  const open = ctl.hold();
  const p = c.send(K.REQUESTS[3]);
  await ticks();
  const a = await c.send('その案でお願いします。');
  const b = await c.send('その方向でいいです');
  const op = await c.send('それで進めて');   // 反映へ進む命令は作業の後に（下書きに残す。計画ができた後に送れば反映の確認へ）
  open(); await p; await ticks();
  assert(a && a.reason === 'AGREED_WHILE_PLAN' && b && b.reason === 'AGREED_WHILE_PLAN' && calls.plan.length === 1 && op === null && byKind('agree-while-plan').length === 2 && !byKind('answers-ack').length && c.planHistory().length === 1, `W7: 作成中の同意は積まない（計画の呼び出し 1 回）: ${JSON.stringify({ a: a && a.reason, plans: calls.plan.length })}`);
  // 同意に見えても指示がある文は積む
  const k = makeConv([{ plan: planWith([]) }, { plan: planWith([]) }]);
  await draftUntilAdopt(k);
  const open2 = k.ctl.hold();
  const p2 = k.c.send(K.REQUESTS[3]);
  await ticks();
  const d = await k.c.send('部長宛てでお願いします');
  open2(); await p2; await ticks();
  assert(d && d.queued === true && k.calls.plan.length === 2, 'W7: 「部長宛てでお願いします」は指示としてためる');
});
// =========================================================
console.log('\n--- G2. 3 回目の差分レビューの指摘（依頼の問いの形・コードについての質問・複合語・計画が無いとき・コードの依頼を残す） ---');
await section(async () => {
  const v = { planId: 'p', version: 1, status: 'ACTIVE', plan: planWith([]), review: { steps: [] }, spec: { status: 'CONFIRMED', version: 1 } };
  const withExec = { activePlan: v, ledgers: new Map(), activeExecution: { executionId: 'x', written: true, rolledBack: false } };
  const cls = (t, s = { activePlan: v, ledgers: new Map() }) => KTAiConversation.classifyIntent(t, s);
  const isQ = KTAiConversation.isQuestionSentence;
  // 依頼の問いの形: 変更・操作は依頼、説明・情報を求めるもの・疑問の語・「〜か確認して」は質問
  assert(!isQ('保存を止めてもらえる？') && !isQ('反映してもらえますか？') && isQ('今の計画の手順を見せてもらえる？') && isQ('調べてもらえますか？') && isQ('ご説明いただけますか？') && isQ('誰が承認してくれる？') && isQ('保存が止まるか確認してもらえますか？'), 'G2-1: 依頼の問いの形は、変更・操作のときだけ依頼（説明・情報・疑問の語・「〜か確認して」は質問）');
  assert(cls('反映してもらえますか？').intent === I.REQUEST_PREVIEW && cls('元に戻してもらえる？', withExec).intent === I.REQUEST_ROLLBACK, 'G2-2: 操作の命令を依頼の問いの形で言っても、操作の案内（計画を作り直さない）');
  // コードについての質問は、コードの生成にも計画の作り直しにもしない
  const qs2 = ['コードを作った？', 'コードを作れますか？', 'コードを作る必要はありますか？', 'コードを作ってある？'];
  const bad = qs2.map(t => ({ t, c: cls(t) })).filter(x => x.c.intent === I.GENERATE_CODE || x.c.reason === 'TURN_THEN_GENERATE' || x.c.alsoGenerate);
  assert(!bad.length, `G2-3: コードについての質問は質問として答える: ${JSON.stringify(bad.map(x => ({ t: x.t, i: x.c.intent, r: x.c.reason })))}`);
  // 複合語の「…コード」・否定・保留はコードの依頼ではない。「プログラムも作って」はコードの依頼
  const notCode = ['顧客コードを生成して', 'QRコードを作って', '商品コードも出して', '条件を変えて、コードを作るのはまだ待って', '条件を変えて、JSを作らずに標準で'];
  const bad2 = notCode.map(t => ({ t, c: cls(t) })).filter(x => x.c.alsoGenerate);
  assert(!bad2.length && cls('条件を変えて、プログラムも作って').reason === 'TURN_THEN_GENERATE' && cls('プログラムを作って').intent === I.GENERATE_CODE, `G2-4: 複合語・否定・保留はコードの依頼にしない（プログラムは依頼）: ${JSON.stringify(bad2.map(x => x.t))}`);
  // 計画が無い・反映済みの計画の後の「…したい。コードも作って」は新しい計画（コードの依頼は計画の後）
  const np = cls('金額が大きいときに警告を出したい。コードも作ってもらえますか？', { activePlan: null, ledgers: new Map() });
  const ex = cls('金額が大きいときに警告を出したい。コードも作って', { activePlan: { ...v, status: 'EXECUTED' }, ledgers: new Map() });
  assert(np.intent === I.PLAN && np.alsoGenerate === true && ex.intent === I.PLAN && ex.alsoGenerate === true, `G2-5: 計画が無い・反映済みのときのコードの依頼つきの依頼は新しい計画: ${np.intent}/${ex.intent}`);
});
//   G2-6（最初の依頼に「コードも作って」→ 計画の AI に generateAfter を伝え、計画の後に［この変更で確定してコードを作る］）: C-1 第 3 段で最初の依頼は仮案へ、
//   確定して作るカードは削除した。JavaScript は採用の後の最終案のパイプラインが作る。対応する回帰: ai-flow-redesign の R09-1（採用 → 計画 → 最終案のカード 1 枚）・
//   R09-4（生成工程への依頼は 1 回）・F2-3（最終案を通らない生成のカードは出ない）。最終案の後の「…コードも作って」の generateAfter は上の F4・G3・G6 で守る
//   G2-7（作り直しが失敗したらコードの依頼（pendingGenerate）を残し、次の計画の後に確定して作る操作を出す）: C-1 第 3 段で pendingGenerate と
//   確定して作る操作を削除した。失敗の後は［再試行］が元の発言を振り分け直し（generateAfter を付ける）、計画を直した版の JavaScript は最終案のパイプラインが作る。
//   対応する回帰: 上の G6・G9（再試行でも generateAfter）・ai-flow-redesign の F3-1（計画を直した版の JavaScript は最終案のパイプラインで作り直す）
await section(async () => {
  // G2-8: コードの生成中に計画を変えて JavaScript が無くなったら、コードは作らないと知らせる（生成の経路も同じ処理）
  //   C-1 第 3 段: 採用の後の最終案の生成中（working FINAL）で確かめる。会話の知らせ（generate-not-needed）の代わりに、置き換えた最終案のカードが
  //   「JavaScript は無く、設定の変更だけです」と出す（生成中の指示の扱いは ai-flow-redesign R11-2〜R11-4）
  const std = planWith([], { customizations: [], steps: [step('P1', 'ADD_VIEW', 'VIEW', '高額案件', { name: '高額案件', fields: ['amount'] })], solution: 'STANDARD' });
  const x = makeConv([{ plan: planWith([]) }, { plan: std }]);
  const { c, calls, ctl, byKind } = x;
  await draftUntilAdopt(x);
  const gPlan = ctl.hold(), gGen = ctl.hold();
  const g = c.send(K.REQUESTS[3]);
  await ticks(); gPlan(); await ticks(10);
  const q = await c.send('警告はやめて一覧だけにして');
  gGen(); await g; await ticks(12);
  const v2 = c.activePlan();
  assert(q && q.queued === true && q.reason === 'QUEUED_DURING_FINAL' && v2.version === 2 && v2.final && v2.final.customizations.length === 0 && /JavaScript は無く、設定の変更だけです/.test(rightText(x)) && calls.generate === 1 && byKind('confirm-generate').length === 0, `G2-8: 生成中の変更で JavaScript が無くなったら、コードは作らないと知らせる（最終案のカード）: ${JSON.stringify({ v: v2.version, gen: calls.generate })}`);
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
