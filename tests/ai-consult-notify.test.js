// 通知の相談（2026-10-05）: 通常の相談でも取得済みの関連設定の詳細を使う・確かめ方で断定の強さを分ける・短い答えと根拠の詳細・「おすすめで」で進める
//
// 検証内容（決定的。AI の答えの質は staging と実機で別に確かめる: AI版 docs/release/toolkit-ai-conversation-eval.md §9）:
//   N 関連設定の詳細: 通知の相談の質問・先回りの返答の Context に、通知 3 種（通知先・下位組織・イベント・条件・タイミング）・プロセス管理・
//     通知とプロセス管理が使うフィールドを扱う JavaScript（解析結果を入口にたどる）を入れる。通知以外の質問は変えない。対象が複数でも選ばせない。
//     設定の候補を選び直しても対象を保つ。確かめ方（設定 / コード）。通知を取得できていないときは「無い」と書かない
//   A 答えの表示: 本文は短い答えだけ。確かめた事実・見立て・おすすめ・読み取れなかったことは「根拠と詳細」に。事実に確かめ方の印
//   D 「おすすめで」: 計画の確認事項は推奨の案を回答にする（推奨の無いものは残す）。相談の答えの後なら、そのおすすめで計画を作る
//
// 実行方法: node tests/ai-consult-notify.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const T = loadToolkit();
const { KTDeps, KTScan, KTContext, KTContextUi, KTAiConversation, KTAiAnswers, KTPlanReview, KTAiChatUi } = T;
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const I = KTAiConversation.INTENT;

// 承認者と金額を扱う JavaScript（通知・プロセス管理が使うフィールドを扱う JS をたどれるか）
const APPROVAL_JS = [
  "(() => {",
  "  'use strict';",
  "  kintone.events.on(['app.record.create.submit', 'app.record.edit.submit'], (event) => {",
  "    const r = event.record;",
  "    if (Number(r.amount.value) >= 1000000 && !r.approver.value.length) r.approver.error = '承認者を入れてください';",
  "    return event;",
  "  });",
  "})();",
].join('\n');
function inputs({ extraJs = true } = {}) {
  const data = FX.makeData();
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  const fields = fieldsN.filter(f => f.type !== 'SUBTABLE').map(f => ({ code: f.code, label: f.label, type: f.rawType }));
  const files = [...FX.files, ...(extraJs ? [{ name: 'approvalCheck.js', target: 'desktop', kind: 'js', text: APPROVAL_JS }] : [])];
  const scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files, fields, deps, skippedUrlFiles: FX.skippedUrlFiles });
  KTDeps.mergeScannerEdges(deps, scan);
  return { data, deps, scan };
}
const gen = (question, o = {}) => KTContextUi.generate({ targetType: o.targetType || 'app', targetId: o.targetId || null, question, inputs: o.inputs || inputs(), ...(o.topicText ? { topicText: o.topicText } : {}) });

(async () => {
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e}`); } }

console.log('\n--- N. 通知の相談: 関連設定の詳細 ---');
await section(async () => {
  const g = gen('承認漏れを防ぐ通知はある？');
  const kinds = new Set(g.ctx.facts.map(f => f.kind));
  const st = (k) => g.ctx.facts.filter(f => f.kind === k).map(f => f.statement).join(' / ');
  assert(g.ok && ['notification', 'reminder', 'process-state', 'process-action'].every(k => kinds.has(k)) && JSON.stringify(g.ctx.topics) === '["notification"]', `N1: 通知の相談に通知 3 種・プロセス管理の事実を入れる: ${[...kinds].join(',')}`);
  assert(/組織「sales_dept」（下位組織を含む）/.test(st('notification')) && /レコードの追加/.test(st('notification')) && /条件 「amount >= "1000000"」/.test(st('notification')) && /コメントの書き込み者への通知: する/.test(st('notification')), `N1: 通知先・下位組織・イベント・条件まで入れる（以前は件数だけ）: ${st('notification').slice(0, 200)}`);
  assert(/「due_date」の 1 日前 09:00/.test(st('reminder')) && /作業者は .*フィールド「approver」/.test(st('process-state')), `N1: リマインダーのタイミング（1 日前）・プロセス管理の作業者: ${st('reminder').slice(0, 120)}`);
  const js = g.ctx.facts.filter(f => f.kind === 'js-file' || f.kind === 'code-excerpt' || f.kind === 'js-reference');
  assert(js.some(f => f.kind === 'js-file' && /approvalCheck\.js/.test(f.statement)) && js.some(f => f.kind === 'code-excerpt') && !g.ctx.facts.some(f => f.kind === 'js-file' && /autoLookup/.test(f.statement)), `N1: 通知・プロセス管理が使うフィールドを扱う JS だけをたどって入れる（抜粋つき）: ${js.map(f => f.kind).join(',')}`);
  const plain = gen('このアプリのフィールドの数は？');
  assert(plain.ok && !plain.ctx.facts.some(f => ['notification', 'reminder'].includes(f.kind)) && !plain.ctx.topics, 'N1: 通知以外の質問には入れない（今までどおり）');
});
await section(async () => {
  // 確かめ方: 設定は書かない（設定として扱う）・JavaScript の種類は種類がコード・JavaScript からの依存関係は basis code
  const g = gen('金額を使っている通知と JavaScript は？');
  const dep = g.ctx.facts.find(f => f.kind === 'dependency' && (f.source?.type === 'CUSTOMIZE'));
  const noti = g.ctx.facts.find(f => f.kind === 'notification');
  const jsf = g.ctx.facts.find(f => f.kind === 'js-file');
  assert(g.ok && noti && !noti.basis && (!jsf || !jsf.basis) && (!dep || dep.basis === 'code'), `N2: 確かめ方（設定は書かない・JS の種類は種類で分かる・JS からの依存関係は code）: ${JSON.stringify({ noti: noti && noti.basis, jsf: jsf && jsf.basis, dep: dep && dep.basis })}`);
  const fieldQ = KTContext.build({ question: 'amount を消して大丈夫？', ...inputs(), options: {} });
  const depJs = fieldQ.facts.find(f => f.kind === 'dependency' && f.source?.type === 'CUSTOMIZE');
  assert(depJs && depJs.basis === 'code', `N2: フィールドの質問でも、JavaScript からの依存関係はコードの読解: ${depJs && depJs.basis}`);
});
await section(async () => {
  // 対象が複数（通知とフィールド）でも、通知の相談なら選ばせずにまとめて入れる。通知以外は従来どおり候補を選ぶ
  const g = gen('高額案件の登録の通知と金額の関係は？');
  assert(g.ok && g.ctx.focus.resolution === 'none' && g.ctx.facts.some(f => f.kind === 'notification') && g.ctx.facts.some(f => f.kind === 'field'), `N3: 通知の相談は対象を選ばせない（通知とフィールドの事実をまとめて）: ${g.ok}/${g.reason}`);
  const amb = gen('金額と合計はどう違う？');
  assert(!amb.ok && amb.reason === 'ambiguous', 'N3: 通知以外の曖昧な質問は従来どおり候補を選ぶ');
  // 設定の候補を選び直したときは対象を保つ（以前は捨てて照合し直し、同じ候補に戻った）
  const picked = gen('高額案件の登録の通知と金額の関係は？', { targetType: 'setting', targetId: 'NOTIFICATION:perRecord:0' });
  assert(picked.ok && picked.ctx.focus.resolution === 'explicit' && picked.ctx.facts.some(f => f.kind === 'notification'), `N3: 設定の候補を選んだら対象を保つ: ${picked.ok && picked.ctx.focus.resolution}`);
});
await section(async () => {
  // 先回りの返答（依頼の文を話題として渡す。質問は空）でも、通知の相談なら関連設定を入れる
  const g = gen('', { topicText: '期限前に担当者へリマインドしたい' });
  assert(g.ok && g.ctx.level === 'L1' && g.ctx.facts.some(f => f.kind === 'reminder'), `N4: 先回りの返答にも関連設定を入れる: ${g.ctx.level}`);
  // 通知を取得できていないときは「無い」と書かない
  const ip = inputs(); ip.data.generalNotify = null; ip.data.perRecordNotify = null; ip.data.reminderNotify = null;
  const u = gen('通知はある？', { inputs: ip });
  assert(u.ctx.facts.some(f => f.key === 'NOTIFY:(unavailable)' && f.confidence === 'NOT_ANALYZED') && !u.ctx.facts.some(f => f.key === 'NOTIFY:(none)'), 'N4: 通知を取得できていないときは「取得できていない（無いとは限らない）」');
});
await section(async () => {
  // N5: 種類ごとの有無（実機: 「リマインダーが無い」の根拠にアプリの条件通知の fact を挙げていた）
  const ip = inputs(); ip.data.reminderNotify = { ...ip.data.reminderNotify, notifications: [] }; ip.data.perRecordNotify = null;
  const g = gen('承認漏れを防ぐ通知はある？', { inputs: ip });
  const none = g.ctx.facts.find(f => f.key === 'REMINDER:(none)');
  const un = g.ctx.facts.find(f => f.key === 'NOTIFY:perRecord:(unavailable)');
  assert(g.ok && none && none.kind === 'reminder' && none.confidence === 'CERTAIN' && /リマインダーは設定されていない/.test(none.statement), `N5: 取得できて空の種類は「設定されていない」（リマインダーの事実として）: ${none && none.statement}`);
  assert(un && un.confidence === 'NOT_ANALYZED' && /取得できていない（無いとは限らない）/.test(un.statement) && !g.ctx.facts.some(f => f.key === 'NOTIFY:general:(none)'), `N5: 取得できなかった種類は「取得できていない」。設定のある種類には付けない: ${un && un.statement}`);
  const all = gen('承認漏れを防ぐ通知はある？');
  assert(!all.ctx.facts.some(f => /:\(none\)$|:\(unavailable\)$/.test(f.key || '')), 'N5: 3 種とも設定があるときは付けない');
});

console.log('\n--- A. 答えの表示 ---');
await section(async () => {
  const a = { requestId: 'r1', answer: '承認待ちになったときの通知はありません。承認者へ通知を足すのがおすすめです。', facts: [{ text: '承認待ちの作業者は承認者フィールド', evidenceIds: ['E11'] }, { text: 'approvalCheck.js は承認者が空なら保存を止めるコードがある', evidenceIds: ['E30'] }], analysis: [{ text: '一般的には…', evidenceIds: [] }], recommendations: [{ text: '承認待ちのとき承認者へ通知', evidenceIds: ['E11'] }], unknowns: [] };
  const ctxFacts = [{ id: 'E11', kind: 'process-state' }, { id: 'E30', kind: 'js-file' }];
  const html = KTContextUi.answerHtml(a, { ctxFacts });
  const body = html.split('<details')[0];
  assert(/承認待ちになったときの通知はありません/.test(body) && !/このアプリで確かめた事実|おすすめ<\/b>|見立て/.test(body) && /根拠と詳細（確かめた事実 2 件）/.test(html), 'A1: 本文は短い答えだけ。事実・見立て・おすすめは「根拠と詳細」に');
  assert(/作業者は承認者フィールド<span class="kt-ai-basis" data-basis="setting"[^>]*>（設定）/.test(html) && /保存を止めるコードがある<span class="kt-ai-basis" data-basis="code"[^>]*>（コード）/.test(html) && !/読み取れなかったこと/.test(html), 'A1: 事実に確かめ方の印（設定 / コード）。読み取れなかったことが無ければ出さない');
});

console.log('\n--- D. 「おすすめで」で進める ---');
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
const step = (id, actionType, targetKind, targetRef, sp = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' } });
const planWith = (questions) => ({ goal: '承認漏れを防ぎたい', solution: 'STANDARD', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps: [step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '', {})], alternatives: [], impact: [], questions, unknowns: [], planConfidence: 'NEEDS_CONFIRMATION', customizations: [], provisionals: [] });
function makeConv(steps, { askResult = null } = {}) {
  const DATA = FX.makeData();
  const DEPS = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
  const calls = { plan: [], ask: [] };
  const services = {
    async plan(args) { const n = calls.plan.length; calls.plan.push(JSON.parse(JSON.stringify({ goal: args.goal, revision: args.revision || null, decisions: args.decisions || null }))); const p = JSON.parse(JSON.stringify(steps[Math.min(n, steps.length - 1)])); return { plan: p, ctx: { facts: [] }, review: KTPlanReview.review({ plan: p, data: DATA, deps: DEPS, scan: null, incoming: null }), gatewayPlan: { ...p }, revisionMeta: null, turn: null }; },
    revisionModes: () => ['full', 'patch'], conversationFeatures: () => ['requirements'],
    async ask(args) { calls.ask.push({ question: args.question }); return askResult || { ok: true, answer: { answer: '承認待ちのときの通知はありません。承認者へ通知するのがおすすめです。', facts: [], analysis: [], recommendations: [{ text: '承認待ちになったら作業者（承認者）へ通知する', evidenceIds: [] }], unknowns: [] }, ctx: { facts: [] } }; },
    readiness(v) { return { approved: 0, executable: 0, unsupported: 0, blocked: 0, undecided: v.plan.steps.length }; },
  };
  const c = KTAiConversation.create({ services, now: () => '2026-10-05T00:00:00.000Z', clock: () => 1000 });
  return { c, calls, ledger: () => c.state.ledgers.get(c.activePlan().planId) };
}
await section(async () => {
  // D1: 計画の確認事項: 推奨のあるものは推奨の案を回答に。推奨の無いもの（業務の判断）は残す
  const qs = [{ id: 'Q1', question: '通知先は誰にしますか？', reason: '', relatedEvidenceIds: [], topic: 'notify_target', recommendation: '承認待ちの作業者（承認者）', options: ['承認者', '部長'], priority: 'blocking' },
    { id: 'Q2', question: '承認されなかった案件はどうしますか？', reason: '', relatedEvidenceIds: [], topic: 'other', recommendation: '', options: [], priority: 'later' }];
  const { c, calls, ledger } = makeConv([planWith(qs), planWith([qs[1]])]);
  await c.send('承認漏れを防ぎたい');
  const cls = c.classify('おすすめで');
  assert(cls.intent === I.ANSWER && cls.reason === 'ADOPT_RECOMMENDATIONS' && cls.adoptItems.length === 1, `D1: 「おすすめで」は推奨のある確認事項への回答: ${cls.intent}/${cls.reason}`);
  assert(c.classify('おすすめでお願いします').reason === 'ADOPT_RECOMMENDATIONS' && c.classify('残りはおまかせで').reason === 'ADOPT_RECOMMENDATIONS', 'D1: 「おすすめでお願いします」「残りはおまかせで」も（反映へ進む言葉にしない）');
  await c.send('おすすめで');
  const rec = ledger().entries.find(e => /承認待ちの作業者/.test(e.answer || ''));
  const q2 = ledger().entries.find(e => e.questionKey === 'Q2' || /承認されなかった/.test(e.question || ''));
  assert(rec && calls.plan.length === 2 && (calls.plan[1].decisions || []).some(d => /おすすめの案: 承認待ちの作業者/.test(d.answer)) && (!q2 || !q2.answer), `D1: 推奨の案を回答として記録し、計画の AI に決定事項として渡す。推奨の無い質問は残す: ${JSON.stringify((calls.plan[1].decisions || []).map(d => d.answer))}`);
});
await section(async () => {
  // D2: 相談の答えの後の「おすすめで」: 相談の内容とおすすめで計画を作る
  const { c, calls } = makeConv([planWith([])]);
  await c.send('承認待ちの案件を見落とさないようにするには？');
  assert(calls.ask.length === 1 && c.planHistory().length === 0, '前提: 質問の AI が答える（計画は作らない）');
  const cls = c.classify('おすすめで');
  assert(cls.intent === I.PLAN && cls.reason === 'ADOPT_CONSULTATION' && /承認待ちの案件を見落とさない/.test(cls.goal) && /作業者（承認者）へ通知する/.test(cls.goal), `D2: 相談の答えの後の「おすすめで」は、相談とおすすめで計画: ${cls.intent}/${cls.reason}`);
  assert(c.classify('その案でお願いします').reason === 'ADOPT_CONSULTATION', 'D2: 「その案でお願いします」も');
  await c.send('おすすめで');
  assert(calls.plan.length === 1 && /相談の答えのおすすめで進めたい/.test(calls.plan[0].goal) && c.planHistory().length === 1, `D2: 計画の依頼は相談とおすすめ: ${calls.plan[0] && calls.plan[0].goal}`);
  // 相談の答えが無いとき（いきなり「おすすめで」）は計画を作らない
  const k = makeConv([planWith([])]);
  const r = k.c.classify('おすすめで');
  assert(r.reason !== 'ADOPT_CONSULTATION' && r.intent !== I.PLAN, `D2: 相談の答えが無いときの「おすすめで」は計画にしない: ${r.intent}/${r.reason}`);
});

await section(async () => {
  // D3: 実機（App 353）の会話: 確認事項（数え方・通知先）への短い答え「3日で、作業者だけでいいです。数え方はおすすめで」は、
  //   回答先を聞き返さず、計画の AI に原文のまま渡す（前回の確認事項は推奨つきで渡し、「数え方はおすすめで」を推奨の採用として読ませる）
  const qs = [{ id: 'Q1', question: '「承認待ちのまま何日」は、何を基準に数えますか？', reason: '', relatedEvidenceIds: [], topic: 'status_condition', recommendation: '承認待ちに入ってからの日数（更新日時を基準にする）', options: ['承認待ちに入ってから', '作成日から'], priority: 'blocking' },
    { id: 'Q2', question: '催促の通知先は誰にしますか？', reason: '', relatedEvidenceIds: [], topic: 'notify_target', recommendation: '作業者と申請者の両方', options: ['作業者だけ', '作業者と申請者'], priority: 'blocking' }];
  const { c, calls } = makeConv([planWith(qs), planWith([])]);
  await c.send('承認漏れを防ぎたい');
  const say = '3日で、作業者だけでいいです。数え方はおすすめで';
  const cls = c.classify(say);
  await c.send(say);
  const rev = calls.plan[1] && calls.plan[1].revision;
  const kinds = c.messages().map(m => m.data?.kind || m.type);
  assert(cls.intent === I.REVISE_PLAN && cls.reason === 'TURN' && !kinds.includes('answer-target') && !c.pendingClarification(), `D3: 確認事項への短い答えは聞き返さず、計画の AI に読ませる: ${cls.intent}/${cls.reason}`);
  // 前回の計画の要約（Gateway に送る previousPlan）に推奨を入れる（以前は id・question・reason だけで、「おすすめで」の中身を計画の AI が読めなかった）
  const cq = KTContext.compactPlan(planWith(qs)).questions;
  assert(rev && (rev.utterances || [rev.request]).some(u => u === say) && cq.length === 2 && /更新日時を基準/.test(cq[0].recommendation || '') && cq[1].recommendation === '作業者と申請者の両方', `D3: 発言は原文のまま・前回の確認事項の要約は推奨つき: ${JSON.stringify(cq)}`);
  assert(!('recommendation' in KTContext.compactPlan(planWith([{ ...qs[0], recommendation: '' }])).questions[0]), 'D3: 推奨の無い確認事項には付けない');
  // 「はい」「いいえ」だけの答えは、確認事項が複数なら従来どおり回答先を聞く
  const k = makeConv([planWith(qs)]);
  await k.c.send('承認漏れを防ぎたい');
  assert(k.c.classify('いいえ').reason === 'ANSWER_TARGET_UNCLEAR', 'D3: 「いいえ」だけは回答先を聞く（文脈からも決められない）');
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
