// 会話の応答性（2026-10-05 第 2 段）: 計画の差分更新・作り直しの途中の追加の指示・質問の誤抑制
//
// 検証内容（状態遷移。AI の振る舞いと待ち時間は staging の固定会話で別に計測する）:
//   P 差分の依頼: 回答の後の作り直しは、前の版の Gateway の計画を土台に revision.mode 'patch'（回答に関係する箇所を focus に）で送る /
//      全体に戻す設定（revisionMode 'full'）・自由な修正の依頼は全体 / 受領の表示の待ち時間の文（差分なら十数秒）/ 根拠ID の付け替え /
//      Gateway の計画は列挙しない（全体の作り直しで二重に送らない）/ 版の作り方（patch / full）を記録する
//   Q 処理中の追加の指示: 作り直しの途中の回答・修正の依頼を受け付けて受領を出す / 終わった作業の結果は最新の計画として出さず、続けてまとめて入れる /
//      最後の版にすべての指示が入る（古い結果で最新の指示を上書きしない）/ 途中の失敗・取り消しはそこまでの版・未反映の指示は記録したまま /
//      新しい会話・別の版・質問・新しい依頼・対応先の確認が要る回答は受け付けない / 上限 / 計測（指示ごとの待ち時間）/ 画面の送信
//   S 質問の誤抑制: 回答済みの論点の別の点の質問（代理の承認者・保存を止めずに出す方法・いつチェックするか）は出す（回答済みの内容を添える）/
//      同じ内容の聞き直しだけ出さない（出さなかった質問の文を案内に出す）/ PC / モバイルだけを聞く質問の判定は Gateway と同じ
//   C-1 第 3 段（2026-10-08）: 古い確認の流れは削除した。最初の依頼は仮案 → 採用 → 計画（start）にし、差分更新・受付箱・台帳は仮案から作った計画の上で確かめる
//
// 実行方法: node tests/ai-responsiveness.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { createNewFlowKit } = require('./helpers/new-flow.js');
const T = loadToolkit();
const { KTDeps, KTContext, KTAiClient, KTAiConversation, KTAiAnswers, KTPlanReview, KTAiChatUi } = T;
const K = createNewFlowKit(T);
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');

const DATA = FX.makeData();
const DEPS = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
const step = (id, actionType, targetKind, targetRef, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' }, ...extra });
const qs = (...texts) => texts.map((t, i) => (typeof t === 'string' ? { id: `Q${i + 1}`, question: t, reason: '', relatedEvidenceIds: [] } : { id: `Q${i + 1}`, reason: '', relatedEvidenceIds: [], ...t }));
//   C-1 第 3 段（2026-10-08）: 最終案の流れでは、効果（effects）の無い JavaScript は計画の自動の差分更新を 1 回起こす（計画の呼び出しの順がずれる）ため、
//   フィールドに効果と条件を置く（この試験の対象は差分更新の依頼と受付箱で、生成は対象外。services.generate は置かない）
const cust = (o = {}) => ({ customizationId: 'C1', requirement: '金額が100万円を超えたら警告を出す', whyStandardInsufficient: '入力中の警告は標準設定に無い', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: [], events: ['app.record.create.show'], fields: [{ code: 'amount', access: 'CONTROL', condition: 'amount > 1000000', effects: ['warn'] }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [], ...o });
const planWith = (questions, extra = {}) => ({ goal: '金額が大きい案件に注意を出したい', solution: 'STANDARD', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps: [step('P1', 'ADD_VIEW', 'VIEW', '高額案件', { name: '高額案件', fields: ['amount'] })], alternatives: [], impact: [], questions, unknowns: [], planConfidence: 'NEEDS_CONFIRMATION', customizations: [], ...extra });
const QP = '対象は PC だけですか？モバイルでも使いますか？';
const QS = '金額が大きいとき、保存を止めますか？';
const QA = '承認者は誰にしますか？';
const QT = 'チェックはいつ行いますか？';
const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await tick(); };

/**
 * 会話コントローラ（fake services）。plans: 呼ばれた順に返す計画（足りなければ最後）。各呼び出しは hold() で待たせられる。
 * 戻り値に Gateway の計画（gatewayPlan）と版の作り方（revisionMeta）を付ける。revisionModes は health の値
 *   C-1 第 3 段（2026-10-08）: 古い確認の流れ（依頼から直接計画を作る）は削除したため、接続先は仮案に対応した形（conversation に proposal）にする。
 *   最初の依頼は仮案（services.propose。決めることの無い仮案）→「これで進めて」で採用 → 計画（plans の 1 つ目）→ 最終案。以降の回答・修正の依頼と
 *   作り直しの途中の受け付け（受付箱）は、仮案から作った計画の上で確かめる（start を使う）
 */
function makeConv(plans, { revisionModes = ['full', 'patch'], revisionMode, failAt = null } = {}) {
  const calls = [];
  let t = 1000, gates = [];
  const ctl = { hold() { let open; const p = new Promise(r => { open = r; }); gates.push(p); return open; }, failAt };
  const services = {
    conversationFeatures: () => ['requirements', 'stream', 'proposal'],
    async propose(args) {
      const raw = { reply: '金額の大きい案件に注意を出す流れにできます。', intent: 'propose', proposal: { behaviors: [K.B(args.utterance, 'user')], assumptions: [], decisions: [], approach: { standard: ['高額案件の一覧を追加する'], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } };
      return { ok: true, proposal: K.normalized(raw), ctx: { facts: [] }, perf: {} };
    },
    async plan(args) {
      const n = calls.length + 1;
      calls.push({ n, goal: args.goal, revision: args.revision ? JSON.parse(JSON.stringify(args.revision)) : null, decisions: JSON.parse(JSON.stringify(args.decisions || null)), baseCtx: args.baseCtx || null });
      const g = gates.shift(); if (g) await g;
      t += args.revision && args.revision.mode === 'patch' ? 12000 : 60000;
      if (args.signal && args.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      if (ctl.failAt === n) { const e = new Error('UPSTREAM_ERROR'); e.code = 'UPSTREAM_ERROR'; throw e; }
      const p = JSON.parse(JSON.stringify(plans[Math.min(n - 1, plans.length - 1)]));
      return { plan: p, ctx: { facts: [], n }, review: KTPlanReview.review({ plan: p, data: DATA, deps: DEPS, scan: null, incoming: null }), decisionsMeta: args.decisions && args.decisions.length ? { version: '1', received: args.decisions.length } : null, gatewayPlan: { ...JSON.parse(JSON.stringify(p)), gw: n }, revisionMeta: args.revision ? { requested: args.revision.mode === 'patch' ? 'patch' : 'full', mode: args.revision.mode === 'patch' ? 'patch' : 'full', fallbackReason: null } : null };
    },
    revisionModes: () => revisionModes,
    async ask() { const g = gates.shift(); if (g) await g; return { ok: true, answer: { answer: 'A', facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx: { facts: [] } }; },
    readiness(v) { return { approved: 0, executable: 0, unsupported: 0, blocked: 0, undecided: v.plan.steps.length }; },
  };
  const c = KTAiConversation.create({ services, now: () => '2026-10-05T00:00:00.000Z', clock: () => t, ...(revisionMode ? { revisionMode } : {}) });
  return { c, calls, ctl, acks: () => c.messages().filter(m => m.data?.kind === 'answers-ack'), kinds: () => c.messages().map(m => m.data?.kind || m.type) };
}
/** 依頼 → 仮案 →「これで進めて」で採用 → 計画（v1）と最終案。採用の結果を返す（従来の c.send(依頼) の置き換え） */
async function start(c, text) {
  const r1 = await c.send(text);
  if (!r1 || r1.intent !== 'PROPOSE') throw new Error(`仮案になりませんでした: ${JSON.stringify(r1 && { intent: r1.intent, reason: r1.reason })}`);
  return c.send('これで進めて');
}
const versions = (c) => c.planHistory().map(v => v.version);
/**
 * 作業を待たせて送り、作業中に会話に出ている読み込み中の文を返す（2026-10-06: 受領の記録は会話に出さないため、待ち時間は読み込み中の文で伝える）
 */
async function sendHeld(x, text, opts) {
  const open = x.ctl.hold();
  const p = x.c.send(text, opts);
  await ticks();
  const loading = x.c.messages().filter(m => m.type === 'LOADING' && !KTAiChatUi.isHiddenMessage(m)).map(m => m.text).join(' / ');
  open(); const r = await p; await ticks();
  return { r, loading };
}

(async () => {
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 2).join(' / ') : e}`); } }

// =========================================================
console.log('\n--- P. 計画の差分更新の依頼（回答の後は変わる箇所だけ） ---');
await section(async () => {
  const v1 = planWith(qs(QP, QS), { customizations: [cust({ questions: [] })] });
  const x = makeConv([v1, planWith(qs(QS))]);
  const { c, calls, acks } = x;
  await start(c, '金額が大きい案件に注意を出したい');
  assert(c.activePlan().gatewayPlan && c.activePlan().gatewayPlan.gw === 1, 'P1: 版に Gateway の計画（次の差分の土台）を持つ');
  const { loading } = await sendHeld(x, 'PCだけ');
  const r = calls[1].revision;
  assert(r.mode === 'patch' && r.previousPlan.gw === 1 && Array.isArray(r.focus) && r.focus.includes('Q1') && calls[1].baseCtx && calls[1].baseCtx.n === 1, `P1: 回答の後の作り直しは mode patch・前の版の Gateway の計画・回答した質問（Q1）を focus・前の版の Context: ${JSON.stringify({ mode: r.mode, focus: r.focus })}`);
  // 2026-10-06: 受領の記録は会話に出さない。待ち時間は作業中の読み込み中の文で伝える（記録の文も同じ待ち時間）
  //   C-1 第 3 段（2026-10-08）: 最終案の流れの作業中の表示は進みの 1 枚カード（目安は実測。ai-flow-redesign の C3b-13）。
  //   差分か全体かで変わる待ち時間の文は、受領の記録（answers-ack）に残る
  assert(/変わる箇所だけを作り直します。十数秒ほどかかります/.test(acks()[0].text) && !/1 分前後/.test(acks()[0].text) && loading === '最終案を直しています', `P1: 受領の記録は差分の待ち時間（十数秒）・作業中の表示は進みの 1 枚カード: ${loading} ｜ ${acks()[0].text}`);
  assert(c.activePlan().revisionMeta?.mode === 'patch' && c.metrics().revisionModes.slice(-1)[0].mode === 'patch', 'P1: 版の作り方（patch）を版と計測に記録する');
  await c.send('更新状況は3段階ではなく5段階にして');
  // 2026-10-05 第 3 段で変更: 自由な修正の依頼も差分（大きな変更は Gateway が同じ依頼の中で全体の作り直しに切り替える）
  assert(calls[2].revision.mode === 'patch' && calls[2].revision.previousPlan.gw === 2 && !calls[2].revision.focus, `P2: 自由な修正の依頼も差分（前の版の Gateway の計画を土台に・回答の focus は付けない）: ${JSON.stringify({ mode: calls[2].revision.mode, focus: calls[2].revision.focus })}`);
});
await section(async () => {
  const x = makeConv([planWith(qs(QP, QS)), planWith(qs(QS))], { revisionMode: 'full' });
  const { c, calls, acks } = x;
  await start(c, '金額が大きい案件に注意を出したい');
  const { loading } = await sendHeld(x, 'PCだけ');
  assert(!calls[1].revision.mode && /1 分前後/.test(acks()[0].text) && loading === '最終案を直しています', `P3: revisionMode full（評価の対照・戻すとき）はいつも全体の作り直し（受領の記録は 1 分前後・作業中の表示は進みの 1 枚カード）: ${loading}`);
});
await section(async () => {
  const x = makeConv([planWith(qs(QP, QS)), planWith(qs(QS))], { revisionModes: ['full'] });
  const { c, calls, acks } = x;
  await start(c, '金額が大きい案件に注意を出したい');
  const { loading } = await sendHeld(x, 'PCだけ');
  assert(calls[1].revision.mode === 'patch' && /1 分前後/.test(acks()[0].text) && !/十数秒/.test(acks()[0].text) && loading === '最終案を直しています', `P4: health が patch を示さない古い Gateway では、差分を頼んでも全体を作り直す前提の文（古い Gateway は mode を無視する。受領の記録の文）: ${loading}`);
});
await section(async () => {
  // 根拠ID の付け替え（Context は作り直しのたびに予算で facts を削って番号を振り直す）
  const from = { facts: [{ id: 'E1', key: 'a' }, { id: 'E2', key: 'b' }, { id: 'E3', key: 'c' }] };
  const to = { facts: [{ id: 'E1', key: 'b' }, { id: 'E2', key: 'c' }] };
  const p = { assessment: { summary: 's', usableExistingFields: [{ fieldCode: 'x', evidenceIds: ['E1', 'E2'] }], usableExistingSettings: [] }, steps: [{ id: 'P1', evidenceIds: ['E2', 'E3'] }], customizations: [{ customizationId: 'C1', evidenceIds: ['E3'] }], questions: [{ id: 'Q1', relatedEvidenceIds: ['E1'] }], impact: [], relevantFields: [], proposedFields: [] };
  const m = KTContext.remapPlanEvidence(p, from, to);
  assert(m.steps[0].evidenceIds.join() === 'E1,E2' && m.assessment.usableExistingFields[0].evidenceIds.join() === 'E1' && m.customizations[0].evidenceIds.join() === 'E2' && m.questions[0].relatedEvidenceIds.join() === '' && p.steps[0].evidenceIds.join() === 'E2,E3', `P5: 根拠ID を fact の key で今回の番号に付け替え、無いものは外す（元の計画は変えない）: ${JSON.stringify(m.steps[0].evidenceIds)}`);
  const rev = KTContext.compactRevision({ basedOnVersion: 1, request: 'r', previousPlan: { steps: [], summary: {} }, mode: 'patch', focus: ['C1', 'Q2', 'C1-1', 'x', 'C1 を直して'] });
  assert(rev.mode === 'patch' && rev.focus.join() === 'C1,Q2,C1-1' && !('mode' in KTContext.compactRevision({ basedOnVersion: 1, request: 'r', previousPlan: { steps: [], summary: {} }, mode: 'diff' })), 'P6: Context の revision は mode（patch / full）と focus（id の形だけ）を持つ');
});
await section(async () => {
  // KTAiClient: Gateway の計画は列挙しない（JSON に入らない＝全体の作り直しで前の版の計画として二重に送らない）・版の作り方を返す
  const ctx = KTContext.buildPlan({ goal: '金額が大きい案件に注意を出したい', data: DATA, deps: DEPS });
  const raw = { ok: true, contractVersion: KTAiClient.CONTRACT_VERSION || '2.1', meta: { requestId: 'r1', revision: { requested: 'patch', mode: 'patch', fallbackReason: null } }, plan: planWith(qs(QP)) };
  const v = KTAiClient.validatePlan(raw, ctx);
  assert(v.ok && v.normalized.revisionMeta.mode === 'patch', 'P7: validatePlan は meta.revision を revisionMeta として返す');
  const transport = async () => ({ status: 200, ok: true, json: async () => raw, text: async () => JSON.stringify(raw), headers: { get: () => null } });
  let out = null;
  try { const client = KTAiClient.createAiClient({ apiBase: 'https://gw.test', getToken: async () => 'T', transport: async (req) => ({ status: 200, body: JSON.stringify(raw), headers: {} }) }); out = await client.plan({ ctx }); } catch (e) { out = { err: e.message }; }
  assert(out && out.gatewayPlan && out.gatewayPlan.goal === raw.plan.goal && !JSON.stringify(out).includes('"gatewayPlan"'), `P7: client.plan は Gateway の計画を列挙しないプロパティで返す: ${out && out.err ? out.err : 'ok'}`);
});

// =========================================================
console.log('\n--- Q. 作り直しの途中の追加の指示（受け付けて、まとめて入れる） ---');
await section(async () => {
  // 「PCだけ」の作り直しの途中に「保存は止めない」→ 受け付け、作業が終わったら続けて入れる。登録する版は 1 つ（両方入り）
  const { c, calls, ctl, acks, kinds } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS)), planWith(qs())]);
  await start(c, '金額が大きい案件に注意を出したい');
  const aiCalls0 = c.metrics().aiCalls;   // 仮案と最初の計画（採用まで）の呼び出し
  const open1 = ctl.hold();
  const p = c.send('PCだけ');
  await ticks();
  assert(c.isBusy() && c.canQueue() && c.job() && c.job().version === 1, 'Q1: 作り直しの途中は、回答・修正の依頼を受け付けられる（作業中の版と何回目の作業か）');
  const q = await c.send('保存は止めない');
  // 2026-10-06: 受け付けた・入れた の知らせは記録に残し、会話には出さない（まだ変更案に入っていないときだけ出す）
  assert(q && q.ok && q.queued && acks().length === 2 && acks()[1].data.stage === 'queued' && /続けて計画に入れます/.test(acks()[1].text) && KTAiChatUi.isHiddenMessage(acks()[1]) && calls.length === 2, `Q1: 途中の回答は受け付けて受領を記録する（会話には出さない。AI はすぐには呼ばない）: ${acks()[1] && acks()[1].text}`);
  open1(); await p; await ticks();
  assert(calls.length === 3 && /保存は止めない/.test(calls[2].revision.request) && !/PCだけ/.test(calls[2].revision.request) && calls[2].revision.previousPlan.gw === 2 && calls[2].revision.mode === 'patch' && calls[2].decisions.some(d => d.answer === 'PCだけ') && calls[2].decisions.some(d => d.answer === '保存は止めない'), `Q1: 続けて入れる作業は、後の指示だけを依頼文にし、前の作業の結果を土台にする（決定事項はすべて送る）: ${calls[2] && calls[2].revision.request}`);
  assert(JSON.stringify(versions(c)) === '[1,2]' && c.activePlan().plan.questions.length === 0, `Q1: 登録する版は最後の 1 つだけ（途中の結果は最新の計画として出さない）: ${JSON.stringify(versions(c))}`);
  assert(c.ledger().filter(e => e.status === 'answered').every(e => e.appliedInVersion === 2), 'Q1: 両方の回答が v2 に入った');
  // 2026-10-06: 会話の文に版の番号を出さない（「変更計画 v2 に入れました」→「変更案に入れました」）。入った版は記録（appliedInVersion）で確かめる
  assert(acks().every(m => m.data.stage === 'done' && (m.data.queued ? KTAiChatUi.isHiddenMessage(m) : (/変更案に入れました。/.test(KTAiChatUi.messageHtml(m)) && !/受け付けました/.test(KTAiChatUi.messageHtml(m))))) && /変更案に入れました/.test(acks()[1].text) && /kintone にはまだ何も反映していません/.test(acks()[1].text) && !/v\d/.test(acks()[1].text), `Q1: 受領の記録は両方とも完了（後の指示は「変更案に入れました」・版の番号は出さない。入れた知らせは会話に出さない）: ${acks()[1] && acks()[1].text}`);
  const mt = c.metrics();
  assert(mt.queuedAccepted === 1 && mt.chainedJobs === 1 && mt.instructionWaits.length === 2 && mt.instructionWaits.every(w => w.waitMs > 0) && mt.aiCalls - aiCalls0 === 2, `Q1: 計測（受け付けた数・続けた作業・指示ごとの待ち時間）: ${JSON.stringify({ q: mt.queuedAccepted, ch: mt.chainedJobs, w: mt.instructionWaits })}`);
  //   C-1 第 3 段（2026-10-08）: 変更案のカード（PLAN）は削除した。版ごとのカードは最終案のカード（FINAL）1 枚
  assert(kinds().filter(k => k === 'FINAL').length === 2 && !kinds().includes('PLAN'), 'Q1: 最終案のカードは v1 と最後の v2 だけ');
});
await section(async () => {
  // 古い結果で最新の指示を上書きしない: 「PCだけ」の途中に「やっぱりモバイルも必要」→ PC だけの結果は版にしない。最後の版の決定事項はモバイルも
  const { c, calls, ctl, acks } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS), { customizations: [cust({ platform: ['desktop'] })] }), planWith(qs(QS), { customizations: [cust({ platform: ['desktop', 'mobile'] })] })]);
  await start(c, '金額が大きい案件に注意を出したい');
  const open1 = ctl.hold();
  const p = c.send('PCだけ');
  await ticks();
  const q = await c.send('やっぱりモバイルも必要');
  assert(q && q.queued, 'Q2: 途中の回答の変更も受け付ける');
  open1(); await p; await ticks();
  const d = calls[2].decisions.find(x => x.topic === 'platform');
  assert(d && d.answer === 'やっぱりモバイルも必要' && d.previousAnswer === 'PCだけ' && d.value.join() === 'desktop,mobile', `Q2: 続けて入れる作業には新しい回答（前の回答つき）を送る: ${JSON.stringify(d)}`);
  assert(JSON.stringify(versions(c)) === '[1,2]' && c.activePlan().plan.customizations[0].platform.join() === 'desktop,mobile' && !c.activePlan().decisionConflicts.length, 'Q2: PC だけの途中の結果は版にしない（最後の版はモバイルも・食い違いの案内も出ない）');
  assert(c.planHistory().every(v => !(v.plan.customizations || []).some(x => x.platform.join() === 'desktop')), 'Q2: PC だけの計画は一度も最新の計画として登録しない');
});
await section(async () => {
  // 続けて入れる作業が失敗: 先の作業の結果を版にし（先の回答は入った）、後の回答は記録したまま「入っていない」
  const { c, ctl, acks, kinds } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS)), planWith(qs())], { failAt: 3 });
  await start(c, '金額が大きい案件に注意を出したい');
  const open1 = ctl.hold();
  const p = c.send('PCだけ');
  await ticks();
  await c.send('保存は止めない');
  open1(); const r = await p; await ticks();
  const lg = c.ledger();
  assert(JSON.stringify(versions(c)) === '[1,2]' && lg.find(e => e.answer === 'PCだけ').appliedInVersion === 2 && lg.find(e => e.answer === '保存は止めない').appliedInVersion == null, `Q3: 続けた作業の失敗では、先の作業の結果を v2 にし、後の回答は記録したまま: ${JSON.stringify(lg.map(e => [e.answer, e.appliedInVersion]))}`);
  // 2026-10-06: 会話に出すのは、まだ変更案に入っていない方（失敗）だけ
  const failedHtml = KTAiChatUi.messageHtml(acks()[1]);
  assert(acks()[0].data.stage === 'done' && acks()[1].data.stage === 'failed' && /完了していません/.test(acks()[1].text) && (acks()[0].data.queued ? KTAiChatUi.isHiddenMessage(acks()[0]) : (/変更案に入れました。/.test(KTAiChatUi.messageHtml(acks()[0])) && !/受け付けました/.test(KTAiChatUi.messageHtml(acks()[0])))) && /保存は止めない/.test(failedHtml) && /まだ変更案に入っていません（作り直しに失敗しました）/.test(failedHtml) && /［再試行］/.test(failedHtml) && kinds().includes('ERROR') && r && r.ok === false, `Q3: 受領は先が完了・後が失敗（失敗した方だけ「まだ変更案に入っていません」と会話に出す。エラーと再試行）: ${failedHtml.replace(/<[^>]+>/g, '')}`);
  assert(c.answerContext().pending === 1, 'Q3: 後の回答は「まだ計画に入っていない回答」として残る（次の送信・再試行で入れる）');
});
await section(async () => {
  // 続けて入れる作業の取り消し（［キャンセル］）: 先の結果を版に、後の指示は取り消し
  const { c, ctl, acks } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS)), planWith(qs())]);
  await start(c, '金額が大きい案件に注意を出したい');
  const ac = new AbortController();
  const open1 = ctl.hold(); const open2 = ctl.hold();
  const p = c.send('PCだけ', { signal: ac.signal });
  await ticks();
  await c.send('保存は止めない');
  open1(); await ticks(6);
  assert(c.isBusy() && c.job() && c.job().n === 2, 'Q4: 先の作業の後、続けて 2 回目の作業をしている');
  ac.abort(); open2(); const r = await p; await ticks();
  assert(JSON.stringify(versions(c)) === '[1,2]' && acks()[0].data.stage === 'done' && acks()[1].data.stage === 'cancelled' && (acks()[0].data.queued ? KTAiChatUi.isHiddenMessage(acks()[0]) : (/変更案に入れました。/.test(KTAiChatUi.messageHtml(acks()[0])) && !/受け付けました/.test(KTAiChatUi.messageHtml(acks()[0])))) && /まだ変更案に入っていません（作り直しを取り消しました）/.test(KTAiChatUi.messageHtml(acks()[1])) && r && r.cancelled, `Q4: 取り消したら、先の結果は v2・後の指示は取り消し（取り消した方だけ会話に出す）: ${JSON.stringify(acks().map(m => m.data.stage))}`);
});
await section(async () => {
  // 新しい会話・別の版が最新になった: 途中の結果も続けた作業も入れない
  const { c, ctl, acks } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS))]);
  await start(c, '金額が大きい案件に注意を出したい');
  const open1 = ctl.hold();
  const p = c.send('PCだけ');
  await ticks();
  await c.send('保存は止めない');
  c.registerPlan({ plan: planWith(qs('別の質問ですか？')), ctx: null, review: null, basedOn: c.activePlan() });
  open1(); await p; await ticks();
  assert(c.activePlan().plan.questions[0].question === '別の質問ですか？' && acks().every(m => m.data.stage === 'superseded' && /まだ変更案に入っていません（作り直しの間に変更案が置き換わりました）/.test(KTAiChatUi.messageHtml(m))), `Q5: 別の経路で版が最新になったら、途中の結果を入れず、受領は「置き換わった」（まだ変更案に入っていないと会話に出す）: ${JSON.stringify(acks().map(m => m.data.stage))}`);
  const x = makeConv([planWith(qs(QP, QS)), planWith(qs(QS))]);
  await start(x.c, '金額が大きい案件に注意を出したい');
  const o = x.ctl.hold();
  const p2 = x.c.send('PCだけ');
  await ticks();
  await x.c.send('保存は止めない');
  x.c.startNew();
  o(); await p2; await ticks();
  assert(x.c.planHistory().length === 0 && x.c.messages().length === 0 && x.calls.length === 2 && !x.c.canQueue(), 'Q6: 作り直しの途中に新しい会話にしたら、続けて入れる作業はしない');
});
await section(async () => {
  // 受け付けないもの: 対応先の確認が要る回答・秘密情報（2026-10-05 第 3 段で変更: 作り直しの途中の質問は、作業と並べてすぐ答える）
  const { c, ctl } = makeConv([planWith(qs(QP, QS, '承認の設定も必要ですか？')), planWith(qs(QS))]);
  await start(c, '金額が大きい案件に注意を出したい');
  const open1 = ctl.hold();
  const p = c.send('PCだけ');
  await ticks();
  const qa = await c.send('このフィールドは何に使ってる？');
  await ticks();
  const n0 = c.messages().length;
  assert(qa && qa.asked === true && c.messages().some(m => m.data?.kind === 'aside-answer'), 'Q7: 作り直しの途中の質問は、作業と並べてすぐ答える（作業は止めない。以前は受け付けず下書きのまま）');
  assert(await c.send('はい') === null && await c.send('Webhook は https://hooks.slack.com/services/T000/B000/XXXX です') === null && c.messages().length === n0, 'Q7: 対応先の決まらない「はい」・秘密情報は受け付けない（下書きとして残す。会話に出さない）');
  const re = await c.send('PCだけ');
  assert(re && !re.queued && /いま直している変更案に入れています/.test(c.messages()[c.messages().length - 1].text), 'Q8: 作り直しに入っている回答の言い直しは積まない（いま入れていると伝える）');
  open1(); await p; await ticks();
  const a = makeConv([planWith(qs(QP))]);
  await start(a.c, '金額が大きい案件に注意を出したい');
  const oa = a.ctl.hold();
  const pa = a.c.send('このフィールドは何に使ってる？');
  await ticks();
  assert(a.c.isBusy() && !a.c.canQueue() && await a.c.send('PCだけ') === null, 'Q7: 質問の応答待ち（計画の作り直しでない）は受け付けない（従来どおり）');
  oa(); await pa;
});
await section(async () => {
  // 修正の依頼を途中に受け付けたら、続けて入れる作業に入れる（2026-10-05 第 3 段で変更: 修正の依頼を含むときも差分）
  const { c, calls, ctl, acks } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS)), planWith(qs(QS))]);
  await start(c, '金額が大きい案件に注意を出したい');
  const open1 = ctl.hold();
  const p = c.send('PCだけ');
  await ticks();
  const q = await c.send('一覧の名前は「高額」にして');
  assert(q && q.queued && q.intent === 'REVISE_PLAN' && /修正の依頼を受け付けました/.test(acks()[1].text), 'Q9: 途中の修正の依頼も受け付ける');
  open1(); await p; await ticks();
  assert(calls.length === 3 && calls[2].revision.mode === 'patch' && /修正の依頼：一覧の名前は「高額」にして/.test(calls[2].revision.request) && acks()[1].data.stage === 'done' && JSON.stringify(versions(c)) === '[1,2]', `Q9: 修正の依頼を含む続けた作業も差分・依頼文に入れる: ${calls[2] && calls[2].revision.request}`);
  const hist = c.activePlan().revisionRequests;
  assert(hist.length === 1 && /PC \/ モバイル/.test(hist[0]) && /一覧の名前/.test(hist[0]), 'Q9: 版の修正の依頼の履歴には、続けた作業の依頼文もまとめて残す（次の全体の作り直しで「反映済み」として送る）');
});
await section(async () => {
  // 上限: 作業のたびに新しい指示が来ても、続ける作業は 4 回まで。超えた指示は記録したまま「まだ入っていない」
  const { c, ctl, acks } = makeConv([planWith(qs(QP, QS, QA, QT, '一覧は必要ですか？'))]);
  await start(c, '金額が大きい案件に注意を出したい');
  const opens = [ctl.hold(), ctl.hold(), ctl.hold(), ctl.hold()];
  const p = c.send('PCだけ');
  const more = ['保存は止めない', '部長です', '保存時です', '一覧は不要です'];
  for (let i = 0; i < 4; i++) { await ticks(); await c.send(more[i]); opens[i](); }
  await p; await ticks();
  assert(JSON.stringify(versions(c)) === '[1,2]' && acks().slice(-1)[0].data.stage === 'pending' && /まだ計画に入っていません/.test(acks().slice(-1)[0].text) && /まだ変更案に入っていません（続けて入れられる数を超えました）/.test(KTAiChatUi.messageHtml(acks().slice(-1)[0])) && c.metrics().chainedJobs === 3, `Q10: 続ける作業は 4 回まで（超えた指示は記録したまま・まだ変更案に入っていないと会話に出す）: ${JSON.stringify(acks().map(m => m.data.stage))}`);
});
await section(async () => {
  // 途中で答えた回答は、途中の結果が同じ質問を聞いても「AI がもう一度確認してきた」と数えない
  const lg = KTAiAnswers.createLedger('p');
  const s1 = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs(QS, QA))), { version: 1 });
  const snap = lg.rev;
  KTAiAnswers.recordAnswer(lg, { entryId: s1.open.find(q => q.text === QS).entryId, topics: ['save_block'], answer: '止めない', source: 'chat', question: QS, version: 1 });
  const s2 = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs(QS, QA))), { version: 2, answeredAfter: snap });
  assert(s2.reasked.length === 0 && s2.open.map(q => q.text).join() === QA, 'Q11: 作り直しの途中に答えた回答で、同じ質問を出さないが「聞き直し」とは数えない');
  const s3 = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs(QS, QA))), { version: 3 });
  assert(s3.reasked.length === 1, 'Q11: 作り直しの前に答えた回答なら、従来どおり聞き直しとして数える');
});

// =========================================================
console.log('\n--- S. 質問の誤抑制（回答済みの論点の別の点の質問を消さない） ---');
await section(async () => {
  const lg = KTAiAnswers.createLedger('p');
  const s1 = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs({ question: QA, topic: 'approver' }))), { version: 1 });
  KTAiAnswers.recordAnswer(lg, { entryId: s1.open[0].entryId, topics: ['approver'], answer: '部長です', source: 'chat', question: QA, version: 1 });
  const proxy = '部長が不在のときの代理の承認者は誰にしますか？';
  const s2 = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs({ question: proxy, topic: 'approver' }))), { version: 2 });
  assert(s2.open.length === 1 && s2.open[0].text === proxy && s2.reasked.length === 0 && s2.open[0].related && s2.open[0].related[0].answer === '部長です', `S1: 「部長です」の後の代理の承認者の質問は出す（回答済みの内容を添える。以前は再質問として消えた）: ${JSON.stringify(s2)}`);
  const s2b = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs({ question: proxy, topic: 'other' }))), { version: 3 });
  assert(s2b.open.length === 1 && s2b.reasked.length === 0, 'S1: AI の topic が other（文の語彙で承認者）でも出す');
  const s3 = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs({ question: '承認者は誰にしますか', topic: 'approver' }))), { version: 4 });
  assert(s3.open.length === 0 && s3.reasked.length === 1, 'S2: 同じ内容の聞き直し（回答した質問とほぼ同じ文）は出さない');
});
await section(async () => {
  // 論点の膨らみ: 「保存時に金額が100万円以上なら保存を止めますか？」に「止めてください」→ 後の「チェックはいつ」「100万円ちょうどは」は出す
  const lg = KTAiAnswers.createLedger('p');
  const Q0 = '保存時に金額が100万円以上なら保存を止めますか？';
  const s1 = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith([], { customizations: [cust({ questions: [Q0] })] })), { version: 1 });
  KTAiAnswers.recordAnswer(lg, { entryId: s1.open[0].entryId, topics: s1.open[0].topics, answer: '止めてください', source: 'chat', question: Q0, version: 1 });
  const s2 = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs(QT, '100万円ちょうども対象にしますか？'))), { version: 2 });
  assert(s2.open.length === 2 && s2.reasked.length === 0, `S3: 答えていないタイミング・しきい値の質問は出す（以前は回答した質問の語の論点で消えた）: ${JSON.stringify(s2.reasked)}`);
  // 追加の条件は質問を隠さない
  const lg2 = KTAiAnswers.createLedger('q');
  KTAiAnswers.recordAnswer(lg2, { topics: ['save_block'], answer: '保存は止めない', source: 'chat', kind: 'condition', version: 1 });
  const s4 = KTAiAnswers.syncQuestions(lg2, KTAiAnswers.questionList(planWith(qs({ question: '保存は止めずに、注意のメッセージだけ出しますか？それとも確認ダイアログを出しますか？', topic: 'save_block' }))), { version: 2 });
  assert(s4.open.length === 1 && s4.reasked.length === 0, 'S4: 追加の条件（保存は止めない）では、保存を止めずにどう出すかの質問を隠さない');
});
await section(async () => {
  // PC / モバイル: 回答済みの後に外すのは PC / モバイルだけを聞く質問。別の点は出す
  const lg = KTAiAnswers.createLedger('p');
  const s1 = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs(QP))), { version: 1 });
  KTAiAnswers.recordAnswer(lg, { entryId: s1.open[0].entryId, topics: ['platform'], answer: 'PCだけ', source: 'chat', question: QP, version: 1 });
  const keep = ['PCの画面では金額欄の横と画面上部のどちらに表示しますか？', 'モバイルで入力している場合もチェックしますか？'];
  const drop = ['スマートフォンからの入力も対象に含めますか？', 'PC とモバイルの両方で必要ですか？'];
  const s2 = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs(...keep.map(q => ({ question: q, topic: 'platform' })), ...drop.map(q => ({ question: q, topic: 'platform' }))))), { version: 2 });
  assert(s2.open.map(q => q.text).join('|') === keep.join('|') && s2.reasked.map(q => q.text).join('|') === drop.join('|'), `S5: PC / モバイルだけを聞く質問だけ出さない（場所・別の点は出す）: open=${JSON.stringify(s2.open.map(q => q.text))}`);
  // validatePlan（customizations の質問）も同じ
  const ctx = { facts: [], dictionary: { fieldCodes: ['amount'] }, decisions: [{ id: 'D1', topic: 'platform', status: 'answered', answer: 'PCだけ', value: ['desktop'] }] };
  const r = KTAiClient.validatePlan({ ok: true, contractVersion: KTAiClient.CONTRACT_VERSION || '2.1', meta: {}, plan: planWith([], { customizations: [cust({ questions: [...keep, ...drop] })] }) }, ctx);
  assert(r.ok && r.normalized.customizations[0].questions.join('|') === keep.join('|'), `S5: validatePlan も別の点を聞く質問を残す（以前は「必要・対象・いる」の語で外した）: ${JSON.stringify(r.normalized && r.normalized.customizations[0].questions)}`);
});
await section(async () => {
  // Gateway の isPurePlatformQuestion と同じ例で同じ結果
  const pure = ['PC とモバイルの両方で必要ですか？', 'モバイル版は不要ですか？', 'モバイルでも使いますか？', 'スマートフォンからの入力も対象に含めますか？', 'PCだけでよいですか？', 'kintone モバイルアプリとスマホのブラウザのどちらで使いますか？', 'このデバイスで使いますか'];
  const other = ['モバイルで入力している場合も保存を止めますか？', 'モバイルで入力している場合もチェックしますか？', 'モバイルでも同じメッセージを出す必要がありますか？', 'PCの画面では金額欄の横と画面上部のどちらに表示しますか？', 'スマホのレコード詳細画面でも警告を出す必要がありますか？', 'PC とモバイルで文言を変える必要がありますか？', 'モバイルで使っている端末は iPhone ですか？', '保存を止めますか？', 'モバイルでは金額の入力欄を小さく表示しますか？'];
  assert(pure.every(q => KTAiClient.isPurePlatformQuestion(q)) && other.every(q => !KTAiClient.isPurePlatformQuestion(q)), `S6: PC / モバイルだけを聞く質問の判定（Gateway と同じ例）: ${JSON.stringify([...pure.filter(q => !KTAiClient.isPurePlatformQuestion(q)), ...other.filter(q => KTAiClient.isPurePlatformQuestion(q))])}`);
});
await section(async () => {
  // 会話: 別の点の質問が出ていれば、「課長です」はその質問への回答（以前は隠れた質問のせいで D1「部長」を置き換えた）。聞き直しは文を案内に出す
  const { c } = makeConv([planWith(qs({ question: QA, topic: 'approver' })), planWith(qs({ question: '部長が不在のときの代理の承認者は誰にしますか？', topic: 'approver' }, { question: QA, topic: 'approver' })), planWith(qs())]);
  await start(c, '金額が大きい案件に注意を出したい');
  await c.send('部長です');
  assert(c.answerContext().open.map(q => q.text).join() === '部長が不在のときの代理の承認者は誰にしますか？', 'S7: v2 で代理の承認者の質問は出る（同じ承認者の質問は出さない）');
  // 2026-10-06: AI の再質問を出さなかった経緯（reasked）は記録に残し、通常の会話には出さない
  //   C-1 第 3 段（2026-10-08）: 記録の知らせ（kind 'reasked'）は announcePlan の従来の分岐と一緒に削除した。記録は版（reaskedQuestions）と計測（reaskedLog）に残る
  const v2s = c.activePlan();
  assert((v2s.reaskedQuestions || []).map(q => q.text).join() === '承認者は誰にしますか？' && c.metrics().reaskedLog.some(e => e.version === v2s.version && e.text === '承認者は誰にしますか？') && !c.messages().some(m => m.data?.kind === 'reasked') && !/出さなかった質問/.test(KTAiChatUi.chatHtml(c.messages())),`S7: 出さなかった聞き直しの質問の文を記録に残す（版と計測。会話には出さない）: ${JSON.stringify(v2s.reaskedQuestions)}`);
  //   確認事項のカード（questionsCardHtml）は削除した（ai-flow-redesign の F7-2）。関係する回答済みの内容は、未回答の確認事項の related として台帳に残る
  const rel = (c.answerContext().open[0] || {}).related || [];
  assert(rel.some(x => x.answer === '部長です'), `S7: 未回答の確認事項（代理の承認者）に、関係する回答済みの内容（承認者 → 部長です）を添える: ${JSON.stringify(rel)}`);
  await c.send('課長です');
  const ds = c.decisions();
  assert(ds.some(d => d.answer === '部長です') && ds.some(d => d.answer === '課長です' && /代理/.test(d.question || '')), `S7: 「課長です」は代理の質問への回答（D1「部長です」は残る）: ${JSON.stringify(ds.map(d => [d.id, d.answer, d.question]))}`);
});

// =========================================================
console.log('\n--- R. 差分レビューの指摘（処理中の受け付け・まとめて反映・質問の判定） ---');
await section(async () => {
  // R1: 作り直しの途中の回答に含まれる依頼の部分（そのほかの記述）も、次の作業の依頼文に入れる（以前は捨てた）
  const { c, calls, ctl, acks } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS)), planWith(qs())]);
  await start(c, '金額が大きい案件に注意を出したい');
  const o = ctl.hold();
  const p = c.send('PCだけ');
  await ticks();
  const q = await c.send('保存は止めない。一覧の名前は「高額」にして');
  assert(q && q.queued && /そのほかの記述：一覧の名前は「高額」にして/.test(acks()[1].text), `R1: 受領の表示に依頼の部分も出す: ${acks()[1] && acks()[1].text}`);
  o(); await p; await ticks();
  assert(calls.length === 3 && /保存は止めない/.test(calls[2].revision.request) && /そのほかの記述：一覧の名前は「高額」にして/.test(calls[2].revision.request) && acks()[1].data.stage === 'done', `R1: 依頼の部分を続けた作業の依頼文に入れる: ${calls[2] && calls[2].revision.request}`);
});
await section(async () => {
  // R2: 同じ修正の依頼（［再試行］・二重クリック）は積まない / R3: 対応先の確認の選択は作り直しの後に
  const { c, calls, ctl } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS))]);
  await start(c, '金額が大きい案件に注意を出したい');
  const o = ctl.hold();
  const p = c.send('一覧「担当者別」に期日の列を追加して', { intentOverride: 'REVISE_PLAN' });
  await ticks();
  const d = await c.send('一覧「担当者別」に期日の列を追加して', { intentOverride: 'REVISE_PLAN' });
  assert(d && !d.queued && /同じ修正は、いま変更案に入れているところです/.test(c.messages()[c.messages().length - 1].text), 'R2: いまの作業と同じ修正の依頼は積まない');
  //   R3（対応先の確認の選択は作り直しの途中は受け付けない）は削除した: 対応先の確認（answer-target）は C-1 第 3 段で削除した
  //   （対応先を聞き返さず、候補を添えて計画の AI に渡す。ai-flow-redesign の F4-1・F4-2）
  o(); await p; await ticks();
  assert(calls.length === 2, `R2: 計画の呼び出しは 1 回だけ（以前は同じ依頼でもう 1 回）: ${calls.length - 1}`);
});
await section(async () => {
  // R4: 上限に当たったら、受け付けた修正の依頼は決定事項を変えない（入れていないので）。受領は「まだ入っていません」
  const { c, ctl, acks } = makeConv([planWith(qs(QP, QS, QA, QT, '一覧は必要ですか？'))]);
  await start(c, '金額が大きい案件に注意を出したい');
  const opens = [ctl.hold(), ctl.hold(), ctl.hold(), ctl.hold()];
  const p = c.send('PCだけ');
  const more = ['保存は止めない', '部長です', '保存時です'];
  for (let i = 0; i < 3; i++) { await ticks(); await c.send(more[i]); opens[i](); }
  await ticks();
  await c.send('チェックは保存時と金額の変更時にして', { intentOverride: 'REVISE_PLAN' });
  opens[3](); await p; await ticks();
  const timing = c.ledger().find(e => e.answer === '保存時です');
  assert(timing && timing.status === 'answered' && acks().slice(-1)[0].data.stage === 'pending', `R4: 上限で入れなかった修正の依頼は、決定事項「保存時です」を置き換えない: ${timing && timing.status} / ${acks().slice(-1)[0].data.stage}`);
});
await section(async () => {
  // R5: 依頼文の上限に収まらない修正の依頼は、次の作業に回す（黙って切り捨てて「入れました」と言わない）
  const { c, calls, ctl, acks } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS)), planWith(qs(QS)), planWith(qs())]);
  await start(c, '金額が大きい案件に注意を出したい');
  const o1 = ctl.hold(); const o2 = ctl.hold();
  const p = c.send('PCだけ');
  await ticks();
  await c.send(`一覧の説明を変えて：${'あ'.repeat(1880)}`, { intentOverride: 'REVISE_PLAN' });
  await c.send('高額案件の一覧に締め切りの列を追加して', { intentOverride: 'REVISE_PLAN' });
  o1(); await ticks(6); o2(); await p; await ticks();
  assert(calls.length === 4 && /締め切りの列/.test(calls[3].revision.request) && !/締め切りの列/.test(calls[2].revision.request) && acks().every(m => m.data.stage === 'done'), `R5: 入りきらない依頼は次の作業で入れる: calls=${calls.length} ${JSON.stringify(acks().map(m => m.data.stage))}`);
});
await section(async () => {
  // R6: 続けた作業の取り消し: 先の版は登録・案内は「途中までの内容は変更案に入れました」（版の番号は出さない）・再試行の対象は入らなかった指示
  const { c, ctl } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS)), planWith(qs())]);
  await start(c, '金額が大きい案件に注意を出したい');
  const ac = new AbortController();
  const o1 = ctl.hold(); const o2 = ctl.hold();
  const p = c.send('PCだけ', { signal: ac.signal });
  await ticks();
  await c.send('保存は止めない');
  o1(); await ticks(6);
  ac.abort(); o2(); const r = await p; await ticks();
  const n = c.messages().find(m => m.data?.kind === 'cancelled');
  assert(r && r.partial && r.partial.version === 2 && c.activePlan().version === 2 && n && /途中までの内容は変更案に入れました/.test(n.text) && /そのあとに送った指示は、まだ入っていません/.test(n.text) && !/v\d/.test(n.text) && /保存は止めない/.test(n.data.text) && !/PCだけ/.test(n.data.text), `R6: 取り消しの案内と、入らなかった指示: ${n && n.text} / ${n && n.data.text}`);
});
await section(async () => {
  // R7: 回答に関係する箇所（focus）は最初の作業だけに付ける
  const { c, calls, ctl } = makeConv([planWith(qs(QP, QS)), planWith(qs(QS)), planWith(qs())]);
  await start(c, '金額が大きい案件に注意を出したい');
  const o = ctl.hold();
  const p = c.send('PCだけ');
  await ticks();
  await c.send('保存は止めない');
  o(); await p; await ticks();
  assert(calls[1].revision.focus && calls[1].revision.focus.length && calls[2].revision.mode === 'patch' && !calls[2].revision.focus, 'R7: 続けた作業には、前の版の質問番号の focus を付けない');
});
await section(async () => {
  // S8〜S13: 同じ質問の判定（レビューの例）
  const answer = (lg, q, a, topic = null) => { const s = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs(topic ? { question: q, topic } : q))), { version: 1 }); KTAiAnswers.recordAnswer(lg, { entryId: s.open[0].entryId, topics: s.open[0].topics, answer: a, source: 'chat', question: q, version: 1 }); };
  const next = (lg, list, v = 2) => KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs(...list))), { version: v });
  let lg = KTAiAnswers.createLedger('a'); answer(lg, '承認者は部長と課長のどちらにしますか？', '部長です', 'approver');
  let s = next(lg, [{ question: '承認者は部長と課長のどちらにしますか？', topic: 'approver' }]);
  assert(s.reasked.length === 1 && !s.open.length, 'S8: 回答の語を含む元の質問と同じ文は聞き直し（以前は「別の点」として出た）');
  lg = KTAiAnswers.createLedger('b'); answer(lg, QA, '部長です', 'approver');
  s = next(lg, [{ question: '承認者は部長でよいですか？', topic: 'approver' }, { question: '部長が不在のときの代理の承認者は誰にしますか？', topic: 'approver' }]);
  assert(s.reasked.map(q => q.text).join() === '承認者は部長でよいですか？' && s.open.map(q => q.text).join() === '部長が不在のときの代理の承認者は誰にしますか？', `S9: 回答の語を含む確認の言い方は聞き直し・回答を踏まえた別の点は出す: open=${JSON.stringify(s.open.map(q => q.text))}`);
  lg = KTAiAnswers.createLedger('c');
  const s1 = KTAiAnswers.syncQuestions(lg, KTAiAnswers.questionList(planWith(qs({ question: '3日前に通知しますか？', topic: 'timing' }, { question: '1日前に通知しますか？', topic: 'timing' }))), { version: 1 });
  KTAiAnswers.recordAnswer(lg, { entryId: s1.open[0].entryId, topics: s1.open[0].topics, answer: 'はい', source: 'chat', question: '3日前に通知しますか？', version: 1 });
  s = next(lg, [{ question: '1日前に通知しますか？', topic: 'timing' }]);
  assert(s.open.length === 1 && s.reasked.length === 0 && s.open[0].entryId === s1.open[1].entryId, 'S10: 数字だけ違う前の版の未回答の質問は、その項目のまま出す');
  lg = KTAiAnswers.createLedger('d');
  KTAiAnswers.recordAnswer(lg, { topics: ['platform'], answer: 'モバイルは不要', source: 'chat', kind: 'condition', version: 1 });
  s = next(lg, [{ question: 'モバイルでも使いますか？', topic: 'platform' }]);
  assert(s.reasked.length === 1, 'S11: PC / モバイルの値が決まる追加の条件（モバイルは不要）の後の、PC / モバイルだけの質問は聞き直し');
  lg = KTAiAnswers.createLedger('e'); answer(lg, '金額が100万円以上のとき、保存を止めますか？', '止めてください', 'save_block');
  s = next(lg, [{ question: '保存を止めますか？', topic: 'save_block' }]);
  assert(s.reasked.length === 1, 'S12: 条件を省いただけの短い質問は同じ質問');
  const pureQ = ['PC と モバイルの両方で必要ですか？', 'PCだけでよろしいですか？', 'PCとモバイルの両方で使いますか、それともPCだけですか？', 'スマートフォンからも利用する想定ですか？', '対象の端末を教えてください（PC / モバイル / 両方）'];
  const otherQ = ['モバイルではどの画面に表示しますか？', 'モバイルでは何を表示しますか？', 'PCとモバイルで同じ表示にしますか？', 'モバイルでは入力画面でも表示しますか？', 'モバイルではどの操作を対象にしますか？'];
  assert(pureQ.every(x => KTAiClient.isPurePlatformQuestion(x)) && otherQ.every(x => !KTAiClient.isPurePlatformQuestion(x)), `S13: 空白・確認の言い方は PC / モバイルだけの質問、場所・内容・操作を聞く質問は別の点: ${JSON.stringify([...pureQ.filter(x => !KTAiClient.isPurePlatformQuestion(x)), ...otherQ.filter(x => KTAiClient.isPurePlatformQuestion(x))])}`);
});


// =========================================================
console.log('\n--- T. 実機（App 353）で見つかった回答の判定（統合先の質問への「〜にまとめて」） ---');
await section(async () => {
  // T1: 統合先のファイルを聞く質問への「〜にまとめて」「〜に入れて」「〜に寄せて」は回答（以前は文末の「て」で依頼と見なし、
  //     「何についてでしょうか」と聞き返した。［現在の計画を修正する］を選ぶと全体の作り直しで 52 秒かかった）
  const QW = '警告は作成・編集画面で金額を変更したときに出せばよいですか。詳細画面や一覧画面でも必要ですか？';
  const QF = 'PC用の既存処理へ統合する場合、入力中の制御を扱うdealLock.jsを統合先にしてよいですか。それともdealValidate.jsへまとめたいですか？';
  const isRequest = (c) => /ではなく|じゃなく|にして|使って|いらない|不要|やめ|外して|入れて|つけて|付けて/.test(c);
  const O1 = [{ key: 'Q2', text: QW, topics: KTAiAnswers.questionTopics({ text: QW }) }, { key: 'Q4', text: QF, topics: KTAiAnswers.questionTopics({ text: QF }) }];
  const O2 = [{ key: 'Q2', text: QW, topics: KTAiAnswers.questionTopics({ text: QW, topic: 'screens' }) }, { key: 'Q4', text: QF, topics: KTAiAnswers.questionTopics({ text: QF, topic: 'integration_target' }) }];
  const it = (text, open) => KTAiAnswers.interpret({ text, open, decided: [], isRequest });
  const yes = ['統合先はdealValidate.jsにまとめて', 'dealValidate.jsにまとめて', 'dealValidate.jsに入れて', 'dealLock.jsに寄せて', 'dealValidate.jsにまとめてください'];
  const bad = yes.flatMap(t => [O1, O2].map((o, i) => ({ t, i, r: it(t, o) }))).filter(x => !(x.r.kind === 'answers' && x.r.answers.length === 1 && x.r.answers[0].key === 'Q4'));
  assert(!bad.length, `T1: 統合先の質問への「〜にまとめて」は Q4 への回答（AI の topic の有無どちらも）: ${JSON.stringify(bad.map(x => [x.t, x.i, x.r.kind]))}`);
  // T2: 中身を足す依頼（「〜に金額チェックを入れて」）・表示の仕方の依頼（「金額欄の下にまとめて表示して」）は回答にしない
  const no = ['dealValidate.jsに金額チェックを入れて', '金額欄の下にまとめて表示して', 'PCの画面で金額を赤くして'];
  const wrong = no.filter(t => it(t, O1).kind !== 'none');
  assert(!wrong.length, `T2: 内容を足す依頼・表示の仕方の依頼は回答にしない: ${JSON.stringify(wrong)}`);
  // T3: 会話: 聞き返さずに回答として受け付け、差分（patch・回答した質問を focus）で作り直す
  const { c, calls, acks, kinds } = makeConv([planWith(qs(QW, QF), { customizations: [cust()] }), planWith(qs(QW), { customizations: [cust()] })]);
  await start(c, '金額が100万円を超えたら画面に警告を出したい');
  const cls = KTAiConversation.classifyIntent('統合先はdealValidate.jsにまとめて', { activePlan: c.activePlan(), ledgers: new Map() });
  await c.send('統合先はdealValidate.jsにまとめて');
  assert(cls.intent === 'ANSWER' && calls.length === 2 && calls[1].revision.mode === 'patch' && (calls[1].revision.focus || []).includes('Q2') && acks().length === 1 && !kinds().includes('choices'), `T3: 聞き返さずに回答として差分で作り直す: ${JSON.stringify({ intent: cls.intent, reason: cls.reason, calls: calls.length, mode: calls[1] && calls[1].revision.mode, focus: calls[1] && calls[1].revision.focus, kinds: kinds().slice(-3) })}`);
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
