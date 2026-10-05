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
  // フィールドはラベルとコードの両方で書く（2026-10-05 差分レビュー: DATA.fields の形を読み違え、コードだけになっていた）
  assert(/「期限（due_date）」の 1 日前 09:00/.test(st('reminder')) && /作業者は .*フィールド「承認者（approver）」/.test(st('process-state')) && /フィールド「承認者（approver）」/.test(st('notification')), `N1: リマインダーのタイミング（1 日前）・プロセス管理の作業者（ラベルとコード）: ${st('reminder').slice(0, 120)}`);
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
  // ctl.fail = 'TIMEOUT' で次の計画の呼び出しを失敗させる。ctl.hold() で計画の呼び出しを止め、戻り値の関数で再開する（作業中の発言を試す）
  const ctl = { fail: null, gate: null, hold() { let open; ctl.gate = new Promise(r => { open = r; }); return () => { ctl.gate = null; open(); }; } };
  const services = {
    async plan(args) {
      const n = calls.plan.length; calls.plan.push(JSON.parse(JSON.stringify({ goal: args.goal, revision: args.revision || null, decisions: args.decisions || null })));
      if (ctl.gate) await ctl.gate;
      if (ctl.fail) { const f = ctl.fail; ctl.fail = null; const e = new Error(f); e.code = f; throw e; }
      const p = JSON.parse(JSON.stringify(steps[Math.min(n, steps.length - 1)]));
      return { plan: p, ctx: { facts: [] }, review: KTPlanReview.review({ plan: p, data: DATA, deps: DEPS, scan: null, incoming: null }), gatewayPlan: { ...p }, revisionMeta: null, turn: null };
    },
    revisionModes: () => ['full', 'patch'], conversationFeatures: () => ['requirements'],
    async ask(args) { calls.ask.push({ question: args.question }); if (ctl.askGate) await ctl.askGate; return askResult || { ok: true, answer: { answer: '承認待ちのときの通知はありません。承認者へ通知するのがおすすめです。', facts: [], analysis: [], recommendations: [{ text: '承認待ちになったら作業者（承認者）へ通知する', evidenceIds: [] }], unknowns: [] }, ctx: { facts: [] } }; },
    readiness(v) { return { approved: 0, executable: 0, unsupported: 0, blocked: 0, undecided: v.plan.steps.length }; },
  };
  const c = KTAiConversation.create({ services, now: () => '2026-10-05T00:00:00.000Z', clock: () => 1000 });
  return { c, calls, ctl, ledger: () => c.state.ledgers.get(c.activePlan().planId) };
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
  // 推奨の文そのものを回答にする（前置き「おすすめの案: 」を付けない。確認の言い方の聞き直しを隠す判定・再確認の変更の判定がそのまま働く）
  assert(rec && calls.plan.length === 2 && (calls.plan[1].decisions || []).some(d => d.answer === '承認待ちの作業者（承認者）') && (!q2 || !q2.answer), `D1: 推奨の案を回答として記録し、計画の AI に決定事項として渡す。推奨の無い質問は残す: ${JSON.stringify((calls.plan[1].decisions || []).map(d => d.answer))}`);
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

console.log('\n--- R. 差分レビューの指摘（2026-10-05）: 話題の判定・大きさ・関係する JS・伏字・設定の対象・確かめ方・文言 ---');
// フィールドを足したアプリ（「メールアドレス」「連絡先」「お知らせ」のように、通知の語を含むラベル）
function inputsWith(extraFields = {}, { files: extraFiles = [], mutate = null } = {}) {
  const data = FX.makeData();
  Object.assign(data.fields, extraFields);
  if (mutate) mutate(data);
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  const fields = fieldsN.filter(f => f.type !== 'SUBTABLE').map(f => ({ code: f.code, label: f.label, type: f.rawType }));
  const scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files: [...FX.files, ...extraFiles], fields, deps, skippedUrlFiles: FX.skippedUrlFiles });
  KTDeps.mergeScannerEdges(deps, scan);
  return { data, deps, scan };
}
const fld = (type, code, label) => ({ type, code, label, noLabel: false, required: false });
const LABEL_FIELDS = { email: fld('LINK', 'email', 'メールアドレス'), contact: fld('SINGLE_LINE_TEXT', 'contact', '連絡先'), info: fld('MULTI_LINE_TEXT', 'info', 'お知らせ') };
const isNotify = (g) => !!(g.ctx && JSON.stringify(g.ctx.topics || []) === '["notification"]' && g.ctx.facts.some(f => f.kind === 'notification'));
await section(async () => {
  // R1: フィールドの名前として出てくる語（メールアドレス・期限・お知らせ・連絡先）だけでは通知の相談にしない（以前は Context が約 2 倍になった）
  const ip = inputsWith(LABEL_FIELDS);
  const plainQs = ['メールアドレスを消しても大丈夫？', '期限の型は？', 'お知らせ欄を必須にしたい', '連絡先フィールドはどこで使われている？'];
  const wrong = plainQs.filter(q => isNotify(gen(q, { inputs: ip })));
  assert(!wrong.length, `R1: フィールドの名前だけの質問は通知の相談にしない: ${wrong.join(' / ')}`);
  const amb = gen('連絡先と担当はどう違う？', { inputs: ip });
  assert(!amb.ok && amb.reason === 'ambiguous', `R1: 「連絡先と担当はどう違う？」は従来どおり候補を選ぶ: ${amb.ok}/${amb.reason}`);
  // フィールドの名前と一緒でも、通知の語が残れば通知の相談
  const notifyQs = ['期限の前日にリマインドしたい', 'メールアドレスに通知を送りたい', '担当者にメールで連絡する設定はある？'];
  const missed = notifyQs.filter(q => !isNotify(gen(q, { inputs: ip })));
  assert(!missed.length, `R1: 通知の語が残る質問は通知の相談: ${missed.join(' / ')}`);
});
await section(async () => {
  // R2: 通知の語を含まない通知の相談の言い方（届かない・見逃し・放置・対応漏れ・締切）
  const qs = ['承認依頼が届かないと言われた。原因は？', '承認の見逃しを防ぎたい', '対応漏れを防ぎたい', '承認待ちのまま放置されている案件に気づけるようにしたい', '締切が近づいたら担当者に教えてほしい'];
  const missed = qs.filter(q => !isNotify(gen(q)));
  assert(!missed.length, `R2: 届かない・見逃し・放置・対応漏れ・締切も通知の相談: ${missed.join(' / ')}`);
  assert(!isNotify(gen('このアプリの一覧を整理したい')), 'R2: 通知と関係の無い相談には入れない');
});
// 通知・ステータス・アクションの多いアプリ（大きさの上限・削る順）
function bigNotifyInputs({ targets = 12 } = {}) {
  return inputsWith({}, { mutate: (data) => {
    const tg = (i) => Array.from({ length: targets }, (_, k) => ({ entity: { type: 'USER', code: `user_${i}_${k}_${'x'.repeat(10)}` }, includeSubs: false }));
    const cond = (i) => Array.from({ length: 12 }, (_, k) => `amount > "${i * 100 + k}"`).join(' and ');
    data.generalNotify = { ...data.generalNotify, notifications: Array.from({ length: 30 }, (_, i) => ({ entity: { type: 'USER', code: `gen_user_${i}` }, includeSubs: false, recordAdded: true, recordEdited: true, commentAdded: false, statusChanged: true, fileImported: false })) };
    data.perRecordNotify = { ...data.perRecordNotify, notifications: Array.from({ length: 30 }, (_, i) => ({ filterCond: cond(i), title: `条件通知 ${i}`, targets: tg(i) })) };
    data.reminderNotify = { ...data.reminderNotify, notifications: Array.from({ length: 20 }, (_, i) => ({ timing: { code: 'due_date', daysLater: -1, time: '09:00' }, filterCond: cond(i), title: `リマインダー ${i}`, targets: tg(i) })) };
    const states = {}; for (let i = 0; i < 25; i++) states[`状態${i}`] = { name: `状態${i}`, index: String(i), assignee: { type: 'ONE', entities: [{ entity: { type: 'FIELD_ENTITY', code: 'approver' }, includeSubs: false }] } };
    data.status = { enable: true, states, actions: Array.from({ length: 40 }, (_, i) => ({ name: `アクション${i}`, from: `状態${i % 25}`, to: `状態${(i + 1) % 25}`, filterCond: cond(i), executableUser: { entities: [] } })), revision: '1' };
  } });
}
await section(async () => {
  // R3: 通知の相談の Context は既定で 64 KiB まで（以前は上限が無く、通知の多いアプリで Gateway の 256 KiB を超えて拒否された）。
  //   削るときは優先度の低い種類から（概要は残す）。プロセス管理の切り捨ても記録する
  const g = gen('承認漏れを防ぐ通知はある？', { inputs: bigNotifyInputs() });
  const kinds = new Set(g.ctx.facts.map(f => f.kind));
  const secs = (g.ctx.truncation.sections || []).map(s => s.name);
  assert(g.ok && g.ctx.size.bytes <= 64 * 1024 && g.ctx.size.budgetBytes === 64 * 1024, `R3: 通知の多いアプリでも 64 KiB 以内: ${g.ctx.size.bytes} bytes / ${g.ctx.facts.length} 件`);
  assert(kinds.has('overview') && kinds.has('notification') && kinds.has('reminder') && kinds.has('process-state'), `R3: 概要・通知・リマインダー・プロセス管理は残る（以前は概要の 7 件が先に落ちた）: ${[...kinds].join(',')}`);
  assert(secs.includes('facts') && secs.includes('facts.process-state') && secs.includes('facts.process-action'), `R3: 削った分・プロセス管理の切り捨てを記録する: ${secs.join(',')}`);
  const ids = g.ctx.facts.map(f => f.id);
  assert(ids.every((id, i) => id === `E${i + 1}`), 'R3: 削った後も根拠ID は E1 から連番');
  // 同じ条件を文と構造の両方に持たない（160 文字以下なら文だけ）・通知先の列挙は 8 件まで
  // 通知先の列挙の上限は S1 で確かめる（上限で削る順を変えたため、ここの通知は削られることがある）
  const small = gen('承認漏れを防ぐ通知はある？');
  const sp = small.ctx.facts.find(f => f.key === 'NOTIFY:perRecord#1');
  assert(sp && !('filterCond' in sp.notification) && /条件 「amount >= "1000000"」/.test(sp.statement), 'R3: 短い条件は文だけに書く（構造に重ねない）');
  // 通知以外の質問は上限を設けない（今までどおり）
  const plain = gen('金額の型は？', { inputs: bigNotifyInputs() });
  assert(plain.ctx.size.budgetBytes !== 64 * 1024 && !plain.ctx.topics, 'R3: 通知以外の質問の Context は変えない');
});
// 通知・プロセス管理が使うフィールド（approver）を、ファイルの後ろの方で扱う JS（前に関係ない参照が多い）・Webhook の URL と 2 行に分けたトークン
const SET_APPROVER_JS = [
  "(() => {",                                                                       // 1
  "  'use strict';",                                                               // 2
  "  kintone.events.on(['app.record.create.show'], (event) => {",                   // 3
  "    const a = event.record['case_name'].value;",                                 // 4
  "    const b = event.record['customer_code'].value;",                             // 5
  "    const c = event.record['secret_memo'].value;",                               // 6
  "    const d = event.record['pic_sales'].value;",                                 // 7
  "    event.record['case_name'].value = a + b;",                                   // 8
  "    event.record['customer_code'].value = b;",                                   // 9
  "    event.record['secret_memo'].value = c;",                                     // 10
  "    console.log(d);",                                                            // 11
  "    return event;",                                                              // 12
  "  });",                                                                         // 13
  "  // ---",                                                                      // 14
  "  // ---",                                                                      // 15
  "  // ---",                                                                      // 16
  "  // ---",                                                                      // 17
  "  // ---",                                                                      // 18
  "  // ---",                                                                      // 19
  "  // ---",                                                                      // 20
  "  // ---",                                                                      // 21
  "  // ---",                                                                      // 22
  "  // ---",                                                                      // 23
  "  const SLACK_URL = 'https://hooks.slack.com/services/T01ABCDEF/B02GHIJKL/Zx9Qw8Er7Ty6Ui5Op4As3Df2';", // 24
  "  const API_TOKEN =",                                                            // 25
  "    'Abc123Def456Ghi789Jkl012Mno345';",                                          // 26
  "  kintone.events.on('app.record.edit.submit', (event) => {",                     // 27
  "    // 承認者を入れる",                                                           // 28
  "    event.record['approver'].value = [{ code: 'boss' }];",                       // 29
  "    return event;",                                                              // 30
  "  });",                                                                         // 31
  "})();",                                                                         // 32
].join('\n');
await section(async () => {
  // R4: 関係する JS の要点と抜粋は、通知・プロセス管理が使うフィールド（approver）の参照と行を優先する。ほぼ同じ範囲の抜粋を 2 つ出さない
  const ip = inputsWith({}, { files: [{ name: 'setApprover.js', target: 'desktop', kind: 'js', text: SET_APPROVER_JS }] });
  const g = gen('承認漏れを防ぐ通知はある？', { inputs: ip });
  const mine = (f) => (f.file?.name === 'setApprover.js') || /setApprover\.js/.test(f.statement || '');
  const ex = g.ctx.facts.filter(f => f.kind === 'code-excerpt' && mine(f));
  assert(g.ok && ex.some(f => /29: +event\.record\['approver'\]/.test(f.text)), `R4: 抜粋に承認者を入れる行（29 行目）がある: ${ex.map(f => `${f.lines.from}-${f.lines.to}`).join(',')}`);
  assert(g.ctx.facts.some(f => f.kind === 'js-reference' && mine(f) && /approver|承認者/.test(f.statement)), 'R4: 要点に承認者の参照がある');
  const overlap = ex.some((a, i) => ex.some((b, j) => i < j && a.lines.from <= b.lines.to && b.lines.from <= a.lines.to));
  assert(!overlap, `R4: 抜粋の範囲が重ならない: ${ex.map(f => `${f.lines.from}-${f.lines.to}`).join(',')}`);
  // R5: Webhook の URL と 2 行に分けたトークンを伏字にする（行番号は変えない）
  const all = JSON.stringify(g.ctx);
  assert(!all.includes('Zx9Qw8Er7Ty6Ui5Op4As3Df2') && !all.includes('Abc123Def456Ghi789Jkl012Mno345'), 'R5: 抜粋に Webhook の URL の秘密の部分・2 行に分けたトークンを残さない');
  assert(ex.some(f => /24: .*hooks\.slack\.com\/services\/\*\*\*/.test(f.text) && /26: +'\*\*\*'/.test(f.text)), `R5: 伏字にしても行番号はずれない: ${(ex.find(f => /24:/.test(f.text)) || {}).text}`);
  const r = KTContext.redactSecretLikeText;
  assert(!r("const API_TOKEN =\n  'Abc123Def456Ghi789Jkl012Mno345';").includes('Abc123') && r("const API_TOKEN =\n  'Abc123Def456Ghi789Jkl012Mno345';").split('\n').length === 2
    && !r("fetch('https://hooks.slack.com/services/T01ABCDEF/B02GHIJKL/Zx9Qw8Er7Ty6Ui5Op4As3Df2')").includes('Zx9Qw8') && !r("url + '?token=abcd1234efgh5678'").includes('abcd1234'), 'R5: redactSecretLikeText（名前の続く鍵・2 行・Webhook・URL のトークン）');
});
await section(async () => {
  // R6: 設定（ステータス・一覧）の候補を選ぶと、その設定の中身を入れる（以前は概要の 7 件だけ）
  const st = gen('承認待ちと金額の関係は？', { targetType: 'setting', targetId: 'PROCESS_STATE:承認待ち' });
  const vw = gen('顧客別一覧の条件は？', { targetType: 'setting', targetId: 'VIEW:101' });
  assert(st.ok && st.ctx.facts.some(f => f.kind === 'dependency' && f.relationType === 'ASSIGNS_BY') && st.ctx.facts.some(f => f.kind === 'process-state') && st.ctx.facts.some(f => f.kind === 'process-action'), `R6: ステータスを選ぶと作業者・ステータス・アクションの事実が入る: ${[...new Set(st.ctx.facts.map(f => f.kind))].join(',')}`);
  assert(vw.ok && vw.ctx.facts.filter(f => f.kind === 'dependency').length >= 3, `R6: 一覧を選ぶと、表示・条件・ソートに使うフィールドの事実が入る: ${vw.ctx.facts.filter(f => f.kind === 'dependency').length}`);
});
await section(async () => {
  // R7: JavaScript から読んだ事実（存在しないコードの参照・JS の静的解析によるアプリ参照）は確かめ方がコード。取得できていない事実には印を付けない
  const g = gen('承認漏れを防ぐ通知はある？');
  const br = g.ctx.facts.find(f => f.kind === 'broken-reference' && f.source === 'JS');
  const al = g.ctx.facts.find(f => f.kind === 'app-link' && f.dataSource === 'JS_STATIC');
  assert(br && br.basis === 'code' && al && al.basis === 'code', `R7: JS の壊れた参照・JS のアプリ参照は basis code: ${br && br.basis}/${al && al.basis}`);
  const setLink = g.ctx.facts.find(f => f.kind === 'app-link' && f.dataSource !== 'JS_STATIC');
  assert(!setLink || !setLink.basis, 'R7: 設定のアプリ参照（ルックアップ等）は設定のまま');
  const a = { requestId: 'r', answer: 'x', facts: [{ text: '存在しないコード', evidenceIds: [br.id] }, { text: '取得できていない', evidenceIds: ['E900'] }], analysis: [], recommendations: [], unknowns: [] };
  const html = KTContextUi.answerHtml(a, { ctxFacts: [...g.ctx.facts, { id: 'E900', kind: 'notification', confidence: 'NOT_ANALYZED' }] });
  assert(/存在しないコード<span class="kt-ai-basis" data-basis="code"/.test(html) && !/取得できていない<span class="kt-ai-basis"/.test(html), 'R7: 画面の印は（コード）。取得できていない事実には印を付けない');
});
await section(async () => {
  // R8: 名指しした JS ファイル・4 件目以降のフィールドを黙って捨てない（候補をまとめるとき）
  const g = gen('autoLookup.js と承認者の通知の関係は？');
  assert(g.ok && g.ctx.facts.some(f => f.kind === 'js-file' && /autoLookup\.js/.test(f.statement)), `R8: 名指ししたファイルの要点を入れる: ${g.ok}/${g.reason}`);
  const g2 = gen('通知の条件に 顧客コード・案件名・金額・承認者 を使いたい');
  const secs = (g2.ctx.truncation.sections || []).map(s => s.name);
  assert(g2.ok && (g2.ctx.focus.candidates.filter(c => c.type === 'field').length <= 3 || secs.includes('facts.candidates.field')), `R8: 上限で入れなかった候補を記録する: ${secs.join(',')}`);
});
await section(async () => {
  // R9: 一部の種類だけ取得できなかったとき、概要は「0 件」ではなく「取得できていない」・解析範囲にも書く
  const ip = inputs(); ip.data.perRecordNotify = null;
  const g = gen('承認漏れを防ぐ通知はある？', { inputs: ip });
  const ov = g.ctx.facts.find(f => f.key === 'OVERVIEW|dependencies');
  assert(g.ctx.app.notifications.perRecord === null && /レコードの条件通知は取得できていない/.test(ov.statement) && JSON.stringify(g.ctx.coverage.settings.notificationsMissing) === '["perRecord"]', `R9: 概要・解析範囲に取得できていない種類: ${ov && ov.statement}`);
});
await section(async () => {
  // R10: 事実の文の言い回し（イベント・通知先が空の行は「通知されない」・日数と時間の組み合わせ）・共通管理のカスタマイズ項目
  const ip = inputs();
  ip.data.generalNotify.notifications.push({ entity: { type: 'USER', code: 'u9' }, includeSubs: false, recordAdded: false, recordEdited: false, commentAdded: false, statusChanged: false, fileImported: false });
  ip.data.reminderNotify.notifications.push({ timing: { code: 'due_date', daysLater: -1, hoursLater: -3 }, filterCond: '', title: '前日の 3 時間前', targets: [{ entity: { type: 'USER', code: 'u1' } }] });
  ip.data.reminderNotify.notifications.push({ timing: { code: 'due_date', daysLater: 0, hoursLater: -2 }, filterCond: '', title: '2 時間前', targets: [] });
  ip.data.status.states['承認待ち'].assignee.entities.push({ entity: { type: 'CUSTOM_FIELD', code: '上長' }, includeSubs: false });
  const g = gen('承認漏れを防ぐ通知はある？', { inputs: ip });
  const st = g.ctx.facts.map(f => f.statement).join('\n');
  assert(/ユーザー「u9」への通知だが、通知するイベントの指定が無い（このままでは通知されない）/.test(st), 'R10: イベントの指定が無い通知は「通知されない」と書く');
  assert(/の 1 日と 3 時間前に/.test(st) && /の 2 時間前に、通知先が無い（このままでは通知されない）/.test(st) && !/当日2 時間前/.test(st), `R10: 日数と時間の組み合わせ・通知先が無いリマインダー: ${st.split('\n').filter(x => /リマインダー/.test(x)).join(' / ')}`);
  assert(/共通管理のカスタマイズ項目「上長」/.test(st) && !/フィールド「上長」/.test(st), 'R10: CUSTOM_FIELD は共通管理のカスタマイズ項目（アプリのフィールドと書かない）');
});

console.log('\n--- E. 差分レビューの指摘（2026-10-05）: 「おすすめで」の経路 ---');
const QREC = (o) => ({ id: 'Q1', question: '通知先は誰にしますか？', reason: '', relatedEvidenceIds: [], topic: 'notify_target', recommendation: '承認待ちの作業者（承認者）', options: [], priority: 'blocking', ...o });
const tick2 = () => new Promise(r => setTimeout(r, 0));
await section(async () => {
  // E1: 再確認の質問に「おすすめで」→ 決定事項の変更（前の回答を正として残さない・追加の条件にしない）
  const { c, calls, ledger } = makeConv([planWith([QREC({ question: '承認者は誰にしますか？', topic: 'approver', recommendation: '' })]),
    planWith([QREC({ question: '部長の承認は既存の流れと重なります。承認者は課長にしますか？', topic: 'approver', decisionRef: 'D1', reason: '既存の承認と重なる', recommendation: '課長' })]), planWith([])]);
  await c.send('承認漏れを防ぎたい');
  const q = c.answerContext().open[0];
  await c.send('回答', { intentOverride: 'ANSWER', answerPayload: { source: 'answer-card', items: [{ key: q.key, answer: '部長です' }] } });
  assert(c.answerContext().open.some(x => x.reconfirm), '前提: 再確認の質問が出ている');
  await c.send('おすすめで');
  const ds = calls.plan[2] && calls.plan[2].decisions || [];
  assert(ds.some(d => d.answer === '課長' && d.previousAnswer === '部長です') && !ds.some(d => d.answer === '部長です') && !ds.some(d => /おすすめ/.test(d.answer)), `E1: 再確認の質問への「おすすめで」は決定事項の変更: ${JSON.stringify(ds.map(d => [d.answer, d.previousAnswer, d.kind]))}`);
});
await section(async () => {
  // E2: 計画の作り直しの途中の「おすすめで」も記録して、次の作業に入れる（以前は「記録できる内容がありません」で断っていた）
  const qs = [QREC({ id: 'Q1' }), QREC({ id: 'Q2', question: '何日たったら催促しますか？', topic: 'threshold', recommendation: '3 日' })];
  const { c, calls, ctl, ledger } = makeConv([planWith(qs), planWith([qs[1]]), planWith([])]);
  await c.send('承認漏れを防ぎたい');
  const k1 = c.answerContext().open.find(x => x.id === 'Q1' || /通知先/.test(x.text)).key;
  const rel = ctl.hold();
  const p = c.send('回答', { intentOverride: 'ANSWER', answerPayload: { source: 'answer-card', items: [{ key: k1, answer: '承認者' }] } });
  await tick2(); await tick2();
  const r = await c.send('おすすめで');
  rel(); await p; for (let i = 0; i < 6; i++) await tick2();
  assert(r && r.ok && r.queued && ledger().entries.some(e => e.answer === '3 日'), `E2: 作業中の「おすすめで」は推奨の案を記録して積む: ${JSON.stringify(r && { ok: r.ok, reason: r.reason, queued: r.queued })}`);
  assert(calls.plan.some(x => (x.decisions || []).some(d => d.answer === '3 日')), 'E2: 次の作業で計画の AI に渡す');
});
await section(async () => {
  // E3: 相談の後の「おすすめで」で計画の作成が失敗 → ［再試行］でも、打ち直しでも、相談の内容とおすすめで計画を作る
  const { c, calls, ctl } = makeConv([planWith([])]);
  await c.send('承認待ちの案件を見落とさないようにするには？');
  ctl.fail = 'TIMEOUT';
  await c.send('おすすめで');
  const err = c.messages().filter(m => m.type === 'ERROR' || m.data?.retryText).pop();
  assert(calls.plan.length === 1 && err && err.data.retryText, `前提: 計画の作成が失敗した: ${calls.plan.length}`);
  await c.send(err.data.retryText, { intentOverride: err.data.intent });
  assert(calls.plan.length === 2 && /相談の答えのおすすめで進めたい/.test(calls.plan[1].goal) && /見落とさない/.test(calls.plan[1].goal), `E3: ［再試行］でも相談の内容とおすすめで計画を作る: ${calls.plan[1] && calls.plan[1].goal}`);
  const k = makeConv([planWith([])]);
  await k.c.send('承認待ちの案件を見落とさないようにするには？');
  k.ctl.fail = 'TIMEOUT';
  await k.c.send('おすすめで');
  const r2 = k.c.classify('おすすめで');
  assert(r2.reason === 'ADOPT_CONSULTATION' && /見落とさない/.test(r2.goal), `E3: 失敗の後に打ち直した「おすすめで」も相談のおすすめで計画: ${r2.intent}/${r2.reason}`);
});
await section(async () => {
  // E4: 自然な委ね方（前置きの相づち・いろいろな語尾）も委ねる言い方。質問が混ざっても、質問は同時に答える
  const { c } = makeConv([planWith([])]);
  await c.send('承認待ちの案件を見落とさないようにするには？');
  const says = ['じゃあおすすめで', 'うん、おすすめで', 'では、おすすめで', 'おすすめでいいよ', 'おすすめでOKです', 'おすすめで構いません', 'おまかせでお願い', 'おまかせで大丈夫です', 'お任せいたします', 'お任せで進めてください', 'おすすめの通りで', 'AIのおすすめで', 'おすすめ通りにして'];
  const ng = says.filter(s => c.classify(s).reason !== 'ADOPT_CONSULTATION');
  assert(!ng.length, `E4: 委ねる言い方の違いでも相談のおすすめで計画: ${ng.join(' / ')}`);
  const notAdopt = ['おすすめは？', 'おすすめの通知の種類を教えて'].filter(s => c.classify(s).reason === 'ADOPT_CONSULTATION');
  assert(!notAdopt.length, `E4: おすすめを聞く質問は委ねる言い方にしない: ${notAdopt.join(' / ')}`);
  // 「ありがとう」を挟んでも、直前の相談の答えを使う
  await c.send('ありがとう');
  assert(c.classify('おすすめで').reason === 'ADOPT_CONSULTATION', 'E4: 相づちを挟んでも相談のおすすめで計画');
  // 推奨のある確認事項 2 件の計画: 前置き・質問の混在でも推奨の案を回答に（どの確認事項か選ばせない）
  const qs = [QREC({ id: 'Q1' }), QREC({ id: 'Q2', question: '何日たったら催促しますか？', topic: 'threshold', recommendation: '3 日' })];
  const k = makeConv([planWith(qs)]);
  await k.c.send('承認漏れを防ぎたい');
  const a = k.c.classify('じゃあおすすめで'), b = k.c.classify('おすすめで。通知はいつ届きますか？');
  assert(a.reason === 'ADOPT_RECOMMENDATIONS' && a.adoptItems.length === 2 && b.reason === 'ADOPT_RECOMMENDATIONS' && /いつ届きますか/.test(b.askText || ''), `E4: 計画の確認事項でも（質問は同時に答える）: ${a.reason}/${b.reason}/${b.askText}`);
});
await section(async () => {
  // E5: 確認事項の無い計画の後の相談 →「おすすめで」: 修正の依頼に相談のおすすめを添える（計画の AI に「おすすめで」だけを渡さない）
  const { c, calls } = makeConv([planWith([]), planWith([])]);
  await c.send('承認漏れを防ぎたい');
  await c.send('承認待ちの案件を見落とさないようにするには？');
  const cls = c.classify('おすすめで');
  await c.send('おすすめで');
  const rev = calls.plan[1] && calls.plan[1].revision;
  assert(cls.intent === I.REVISE_PLAN && cls.reason === 'ADOPT_CONSULTATION_REVISE' && rev && /相談の答えのおすすめで進めたい: 承認待ちになったら作業者（承認者）へ通知する/.test(rev.request) && JSON.stringify(rev.utterances || []) === '["おすすめで"]', `E5: 修正の依頼に相談のおすすめ・発言は原文のまま: ${cls.reason} / ${rev && rev.request}`);
});
await section(async () => {
  // E6: 推奨の無い確認事項（業務の判断）だけが残っているときの「おすすめで」は、回答にせず、その判断が要ると伝える（AI は呼ばない）
  const { c, calls, ledger } = makeConv([planWith([QREC({ question: '承認されなかった案件はどうしますか？', topic: 'other', recommendation: '' })])]);
  await c.send('承認漏れを防ぎたい');
  const cls = c.classify('おすすめで');
  await c.send('おすすめで');
  const last = c.messages()[c.messages().length - 1];
  assert(cls.reason === 'ADOPT_NO_RECOMMENDATION' && calls.plan.length === 1 && !ledger().entries.some(e => e.answer) && /承認されなかった案件はどうしますか/.test(last.text) && /推奨がありません/.test(last.text), `E6: 業務の判断は残し、答えが要ると伝える: ${cls.reason} / ${last.text}`);
});
await section(async () => {
  // E7: 最初の計画の作成中の「おすすめで」は同意と同じ（作り直しを増やさない）
  const { c, calls, ctl } = makeConv([planWith([])]);
  const rel = ctl.hold();
  const p = c.send('承認漏れを防ぎたい');
  await tick2(); await tick2();
  const r = await c.send('おすすめで');
  rel(); await p; for (let i = 0; i < 6; i++) await tick2();
  assert(r && r.reason === 'AGREED_WHILE_PLAN' && calls.plan.length === 1, `E7: 作成中の「おすすめで」は計画の呼び出しを増やさない: ${r && r.reason} / ${calls.plan.length}`);
});
await section(async () => {
  // E8: 確認事項 1 つへの委ねる答え（「数え方はおすすめで」）は、その確認事項の推奨の文を回答にする
  const qs = [QREC({ id: 'Q1', question: '経過期間は、どの時点から数えますか？', topic: 'timing', recommendation: '更新日時から数える' }), QREC({ id: 'Q2', question: '起算日から何日後に通知しますか？', topic: 'threshold', recommendation: '3 日後' })];
  const { c, calls } = makeConv([planWith(qs), planWith([])]);
  await c.send('承認漏れを防ぎたい');
  await c.send('5日で、数え方はおすすめで');
  const ds = (calls.plan[1] && calls.plan[1].decisions) || [];
  assert(ds.some(d => d.answer === '更新日時から数える') && ds.some(d => /5日/.test(d.answer)) && !ds.some(d => /おすすめ/.test(d.answer)), `E8: 「数え方はおすすめで」は推奨の文を回答に: ${JSON.stringify(ds.map(d => d.answer))}`);
});
await section(async () => {
  // E9: チャットに出す計画の要約から根拠ID・内部の語を外す（右の「計画」には残る）
  const p = planWith([]); p.assessment.summary = '現在は通知がありません（E44、dictionary.reminders）。決定事項D1の推奨の数え方、D2の暦日3日を反映しました。（E42〜E44）';
  const { c } = makeConv([p]);
  await c.send('承認漏れを防ぎたい');
  const msg = c.messages().find(m => /変更計画を作成しました/.test(m.text || ''));
  assert(msg && !/E44|dictionary|D1|D2/.test(msg.text) && /決定事項の推奨の数え方、暦日3日を反映しました/.test(msg.text) && /E44/.test(c.activePlan().plan.assessment.summary), `E9: チャットの要約から根拠ID・内部の語を外す: ${msg && msg.text}`);
});

console.log('\n--- S. 2 回目の差分レビューの指摘（2026-10-05）: 削る順・話題の語・抜粋・伏字・設定の対象・「おすすめで」 ---');
await section(async () => {
  // S1: 上限で削っても、質問の対象のフィールド・リマインダー・ステータス・アクションは 0 件にならない（以前は件数の少ない種類から丸ごと消えた）
  const g = gen('金額の通知を見直したい', { inputs: bigNotifyInputs() });
  const cnt = (k) => g.ctx.facts.filter(f => f.kind === k).length;
  const secs = (g.ctx.truncation.sections || []).map(s => s.name);
  assert(g.ok && g.ctx.size.bytes <= 64 * 1024 && g.ctx.facts.some(f => f.key === 'FIELD:amount') && ['reminder', 'process-state', 'process-action', 'notification'].every(k => cnt(k) >= 1), `S1: 対象のフィールドと中心の種類は残る: ${JSON.stringify({ field: cnt('field'), n: cnt('notification'), r: cnt('reminder'), s: cnt('process-state'), a: cnt('process-action'), bytes: g.ctx.size.bytes })}`);
  assert(secs.includes('facts.notification') || secs.includes('facts.reminder') || secs.includes('facts.process-action'), `S1: 種類ごとに削った件数を記録する: ${secs.join(',')}`);
  const g2 = gen('承認漏れを防ぐ通知はある？', { inputs: bigNotifyInputs() });
  const c2 = (k) => g2.ctx.facts.filter(f => f.kind === k).length;
  assert(['reminder', 'process-state', 'process-action', 'notification'].every(k => c2(k) >= 3), `S1: 承認漏れの相談でも、どの種類も数件ずつ残る: ${JSON.stringify(['notification', 'reminder', 'process-state', 'process-action'].map(c2))}`);
  // 通知先の列挙は 8 件まで（残りは件数）
  const one = inputsWith({}, { mutate: (data) => { data.perRecordNotify.notifications[0].targets = Array.from({ length: 12 }, (_, k) => ({ entity: { type: 'USER', code: `u${k}` }, includeSubs: false })); } });
  const pr = gen('承認漏れを防ぐ通知はある？', { inputs: one }).ctx.facts.find(f => f.key === 'NOTIFY:perRecord#1');
  assert(pr && /ほか 4 件/.test(pr.statement) && pr.notification.targets.length === 8 && pr.notification.targetCount === 12 && !('filterCond' in pr.notification), `S1: 通知先の列挙は 8 件まで・条件は文だけに書く: ${pr && pr.statement.slice(-60)}`);
});
await section(async () => {
  // S2: 「届」「放置」「処理忘れ」だけでは通知の相談にしない。「期限が近づいたら教えて」は通知の相談（フィールドの名前の語でも、フィールドそのものの質問でなければ除かない）
  const not = ['注文が届いたら在庫を増やしたい', '届け先の住所フィールドを追加したい', '放置自転車の管理アプリにしたい', '処理忘れのチェックリストを作りたい', '納品物が届いた日を記録できる？'];
  const wrong = not.filter(q => isNotify(gen(q)));
  assert(!wrong.length, `S2: 通知と関係の無い「届」「放置」は通知の相談にしない: ${wrong.join(' / ')}`);
  const amb = gen('荷物が届いたら担当と金額はどうなる？');
  assert(!amb.ok && amb.reason === 'ambiguous', `S2: 通知以外の曖昧な質問は候補を選ぶ: ${amb.ok}/${amb.reason}`);
  const yes = ['期限が近づいたら担当者に教えてほしい', '期限切れを防ぎたい', '期限を過ぎた案件は担当と上長にわかる？'];
  const missed = yes.filter(q => !isNotify(gen(q)));
  assert(!missed.length, `S2: 期限（フィールドの名前）を入口にした知らせ方の相談は通知の相談: ${missed.join(' / ')}`);
  const g = gen('期限が近づいたら担当者に教えてほしい');
  assert(g.ok && g.ctx.facts.some(f => f.kind === 'reminder' && /期限（due_date）/.test(f.statement)), 'S2: 候補を選ばせず、リマインダーの詳細を入れる');
});
await section(async () => {
  // S3: 抜粋をまとめるとき、行の後ろも残す（重ならず、まとめた範囲に入る）。ファイル対象の common.js の抜粋に 12 行目の kintone.api がある
  const ip = inputs();
  const g = KTContext.build({ focus: { type: 'file', id: 'desktop:js:common.js' }, ...ip, options: {} });
  const ex = g.facts.filter(f => f.kind === 'code-excerpt');
  assert(ex.some(f => /12: +kintone\.api\(/.test(f.text)), `S3: アプリ参照の直後の kintone.api の行が抜粋に入る: ${ex.map(f => `${f.lines.from}-${f.lines.to}`).join(',')}`);
  const overlap = ex.some((a, i) => ex.some((b, j) => i < j && a.lines.from <= b.lines.to && b.lines.from <= a.lines.to));
  assert(!overlap, 'S3: 抜粋の範囲は重ならない');
});
await section(async () => {
  // S4: 伏字で普通のコードを消さない・行をずらさない（値は改行をまたがない）。よく知られた形の鍵・日本語の鍵の名前は伏字
  const r = KTContext.redactSecretLikeText;
  const a = r("console.log('token:', token);\nconst x = 1;\nr.approver.value = [{ code: 'boss' }];\n// 'end'");
  assert(/r\.approver\.value = \[\{ code: 'boss' \}\]/.test(a) && a.split('\n').length === 4, `S4: 「'token:'」の後ろの行を消さない: ${JSON.stringify(a)}`);
  const b = r("// check bearer\n  kintone.events.on('app.record.create.show', f);");
  assert(b.split('\n').length === 2 && /kintone\.events\.on/.test(b), `S4: 行末の bearer で行がずれない: ${JSON.stringify(b)}`);
  const c = r("const MAPS = 'AIzaSyA1234567890abcdefghijklmnopqrstuv';\nconst AWS_ID = 'AKIAIOSFODNN7EXAMPLE';\n// パスワード：P@ssw0rd!2026");
  assert(!/AIzaSyA1234|AKIAIOSFODNN7|P@ssw0rd/.test(c) && c.split('\n').length === 3, `S4: Google・AWS の鍵・日本語の鍵の名前を伏字: ${JSON.stringify(c)}`);
  assert(r("const API_TOKEN =\n  'Abc123Def456Ghi789Jkl012Mno345';").split('\n').length === 2 && !r("const API_TOKEN =\n  'Abc123Def456Ghi789Jkl012Mno345';").includes('Abc123'), 'S4: 2 行に分けたトークンは引き続き伏字');
});
await section(async () => {
  // S5: 設定の依存関係の上限では、条件・ソートを表示フィールドより先に残す。設定についての壊れた参照も入れる。上限の外のステータスでも選んだものは入れる
  const g = KTContext.build({ focus: { type: 'setting', id: 'VIEW:101' }, ...inputs(), options: { limits: { maxDependencyFacts: 2 } } });
  const rels = g.facts.filter(f => f.kind === 'dependency').map(f => f.relationType);
  assert(rels.length === 2 && !rels.includes('DISPLAYS'), `S5: 上限 2 件でも条件・ソートを先に残す: ${rels.join(',')}`);
  const ip = inputsWith({}, { mutate: (data) => { data.views.views['承認待ち'].filterCond = 'ステータス in ("承認中")'; } });
  const vb = gen('承認待ち一覧に何も出ないのはなぜ？', { targetType: 'setting', targetId: 'VIEW:102', inputs: ip });
  assert(vb.ok && vb.ctx.facts.some(f => f.kind === 'broken-reference' && /承認中/.test(f.statement)), `S5: 選んだ設定の壊れた参照を入れる: ${vb.ctx && vb.ctx.facts.filter(f => f.kind === 'broken-reference').map(f => f.statement).join(' / ')}`);
  const st = gen('状態22 の作業者は？', { targetType: 'setting', targetId: 'PROCESS_STATE:状態22', inputs: bigNotifyInputs() });
  assert(st.ok && st.ctx.facts.some(f => f.kind === 'process-state' && /「状態22」/.test(f.statement)), 'S5: 上限の外のステータスでも、選んだものは入れる');
});
await section(async () => {
  // S6: 一部の種類だけ取得できないとき、Markdown・無料のプロンプトも「取得できていない」と書く
  const ip = inputs(); ip.data.perRecordNotify = null;
  const g = gen('承認漏れを防ぐ通知はある？', { inputs: ip });
  const md = KTContext.toMarkdown(g.ctx);
  assert(/レコード 取得できていない/.test(md) && !/レコード 0・/.test(md), `S6: Markdown の概要の行: ${(md.match(/- 一覧[^\n]*/) || [''])[0]}`);
});
await section(async () => {
  // S7: 委ねる言い方（「提案で」「提案を採用して」「ご提案のとおりで」「おすすめ案で」「おすすめのままで」「あなたに任せます」）。頼む言い方（「提案して」「おすすめして」）は委ねない
  const { c } = makeConv([planWith([])]);
  await c.send('承認待ちの案件を見落とさないようにするには？');
  const yes = ['提案で', '提案を採用して', '提案でお願いします', 'ご提案のとおりで', 'おすすめ案で', 'おすすめのままで', 'あなたに任せます', 'AIに任せます', 'おすすめ通りにして'];
  const ng = yes.filter(s => c.classify(s).reason !== 'ADOPT_CONSULTATION');
  assert(!ng.length, `S7: 委ねる言い方: ${ng.join(' / ')}`);
  const no = ['提案して', 'おすすめして', 'あなたに任せたい作業がある', '別の案を提案して'].filter(s => c.classify(s).reason === 'ADOPT_CONSULTATION');
  assert(!no.length, `S7: 頼む言い方は委ねない: ${no.join(' / ')}`);
});
await section(async () => {
  // S8: 「承認者は、部長に任せます」は人に任せる業務の答え（分けない）。「数え方はおすすめで、5日」は語の順に関係なく両方に答える
  const qs = [QREC({ id: 'Q1', question: '通知先は誰にしますか？' }), QREC({ id: 'Q2', question: '承認者は誰にしますか？', topic: 'approver', recommendation: '課長' })];
  const { c, calls } = makeConv([planWith(qs), planWith([])]);
  await c.send('承認漏れを防ぎたい');
  await c.send('承認者は、部長に任せます');
  const ds = (calls.plan[1] && calls.plan[1].decisions) || [];
  assert(ds.some(d => d.answer === '承認者は、部長に任せます') && !ds.some(d => d.answer === '承認者は'), `S8: 人に任せる答えは 1 つの回答: ${JSON.stringify(ds.map(d => d.answer))}`);
  const qs2 = [QREC({ id: 'Q1', question: '経過期間は、どの時点から数えますか？', topic: 'timing', recommendation: '更新日時から数える' }), QREC({ id: 'Q2', question: '起算日から何日後に通知しますか？', topic: 'threshold', recommendation: '3 日後' })];
  const k = makeConv([planWith(qs2), planWith([])]);
  await k.c.send('承認漏れを防ぎたい');
  await k.c.send('数え方はおすすめで、5日');
  const ds2 = (k.calls.plan[1] && k.calls.plan[1].decisions) || [];
  assert(k.calls.plan.length === 2 && ds2.some(d => d.answer === '更新日時から数える') && ds2.some(d => /5日/.test(d.answer)) && !k.c.messages().some(m => m.data?.kind === 'answer-target'), `S8: 委ねる部分が先でも両方に答える: ${JSON.stringify(ds2.map(d => d.answer))}`);
});
await section(async () => {
  // S9: 推奨の無い確認事項への「残りはおすすめで」は回答にしない（確認事項は残し、答えが要ると伝える）
  const qs = [QREC({ id: 'Q1', question: '承認されなかった案件はどうしますか？', topic: 'other', recommendation: '' }), QREC({ id: 'Q2', question: '何日たったら催促しますか？', topic: 'threshold', recommendation: '3 日' })];
  const { c, calls, ledger } = makeConv([planWith(qs), planWith([qs[0]])]);
  await c.send('承認漏れを防ぎたい');
  await c.send('5日で、残りはおすすめで');
  const ds = (calls.plan[1] && calls.plan[1].decisions) || [];
  const msg = c.messages().find(m => m.data?.kind === 'adopt-no-recommendation');
  assert(ds.some(d => /5日/.test(d.answer)) && !ds.some(d => /おすすめ/.test(d.answer)) && msg && /承認されなかった案件はどうしますか/.test(msg.text) && c.answerContext().open.some(q => /承認されなかった/.test(q.text)), `S9: 業務の判断は残す: ${JSON.stringify(ds.map(d => d.answer))} / ${msg && msg.text}`);
});
await section(async () => {
  // S10: 計画の後の相談に「おすすめで。承認者は誰になりますか？」→ 質問の文で決定事項を置き換えない。推奨の無い確認事項より、直前の相談のおすすめを使う
  const { c, calls } = makeConv([planWith([QREC({ question: '承認者は誰にしますか？', topic: 'approver', recommendation: '' })]), planWith([]), planWith([])]);
  await c.send('承認漏れを防ぎたい');
  const q = c.answerContext().open[0];
  await c.send('回答', { intentOverride: 'ANSWER', answerPayload: { source: 'answer-card', items: [{ key: q.key, answer: '部長です' }] } });
  await c.send('承認待ちの案件を見落とさないようにするには？');
  await c.send('おすすめで。承認者は誰になりますか？');
  const last = calls.plan[calls.plan.length - 1];
  assert(calls.plan.length === 3 && (last.decisions || []).some(d => d.answer === '部長です') && /相談の答えのおすすめで進めたい/.test(last.revision.request), `S10: 決定事項は残り、相談のおすすめを添える: ${JSON.stringify((last.decisions || []).map(d => [d.answer, d.status]))}`);
  const k = makeConv([planWith([QREC({ question: '承認されなかった案件はどうしますか？', topic: 'other', recommendation: '' })])]);
  await k.c.send('承認漏れを防ぎたい');
  await k.c.send('承認待ちの案件を見落とさないようにするには？');
  assert(k.c.classify('おすすめで').reason === 'ADOPT_CONSULTATION_REVISE', 'S10: 推奨の無い確認事項が残っていても、直前の相談のおすすめを使う');
});
await section(async () => {
  // S11: 計画の後の相談への「おすすめで」が失敗 →［再試行］でも相談のおすすめを添える（発言は原文）
  const { c, calls, ctl } = makeConv([planWith([]), planWith([])]);
  await c.send('承認漏れを防ぎたい');
  await c.send('承認待ちの案件を見落とさないようにするには？');
  ctl.fail = 'TIMEOUT';
  await c.send('おすすめで');
  const err = c.messages().filter(m => m.data?.retryText).pop();
  await c.send(err.data.retryText, err.data.intent ? { intentOverride: err.data.intent } : {});
  const last = calls.plan[calls.plan.length - 1];
  assert(calls.plan.length === 3 && /相談の答えのおすすめで進めたい/.test(last.revision.request) && JSON.stringify(last.revision.utterances || []) === '["おすすめで"]', `S11: ［再試行］でも相談のおすすめ: ${last.revision.request}`);
});
await section(async () => {
  // S12: 質問の混在: 推奨の無い確認事項だけの計画で質問の AI は 1 回だけ・作業中でも質問の部分に答える
  const { c, calls } = makeConv([planWith([QREC({ question: '承認されなかった案件はどうしますか？', topic: 'other', recommendation: '' })])]);
  await c.send('承認漏れを防ぎたい');
  const n0 = calls.ask.length;
  await c.send('おすすめで。通知はいつ届きますか？');
  for (let i = 0; i < 4; i++) await tick2();
  assert(calls.ask.length - n0 === 1, `S12: 質問の AI は 1 回: ${calls.ask.length - n0}`);
  const qs = [QREC({ id: 'Q1' }), QREC({ id: 'Q2', question: '何日たったら催促しますか？', topic: 'threshold', recommendation: '3 日' })];
  const k = makeConv([planWith(qs), planWith([qs[1]]), planWith([])]);
  await k.c.send('承認漏れを防ぎたい');
  const k1 = k.c.answerContext().open.find(x => /通知先/.test(x.text)).key;
  const rel = k.ctl.hold();
  const p = k.c.send('回答', { intentOverride: 'ANSWER', answerPayload: { source: 'answer-card', items: [{ key: k1, answer: '承認者' }] } });
  await tick2(); await tick2();
  const a0 = k.calls.ask.length;
  await k.c.send('おすすめで。通知はいつ届きますか？');
  rel(); await p; for (let i = 0; i < 6; i++) await tick2();
  assert(k.calls.ask.length - a0 >= 1, 'S12: 作業中でも質問の部分に答える');
});
await section(async () => {
  // S13: チャットの要約で、フィールドコードの D1・D2 は消さない（「決定事項」を含む文の番号だけ外す）
  const p = planWith([]); p.assessment.summary = '日付フィールド D2 の値を初期値にします。D2の値が空のときは通知しません。決定事項D1の推奨、D3の作業者を反映しました。';
  const { c } = makeConv([p]);
  await c.send('承認漏れを防ぎたい');
  const msg = c.messages().find(m => /変更計画を作成しました/.test(m.text || ''));
  assert(msg && /日付フィールド D2 の値を初期値にします/.test(msg.text) && /D2の値が空のときは通知しません/.test(msg.text) && /決定事項の推奨、作業者を反映しました/.test(msg.text), `S13: ${msg && msg.text}`);
});

console.log('\n--- T. 3 回目の差分レビューの指摘（2026-10-05）: 通知の範囲ごとに削る・フィールドの名前の語・「はい」「いいえ」・抜粋・伏字・遅れて届いた答え ---');
await section(async () => {
  // T1: 上限で削っても、レコードの条件通知・アプリの条件通知のどちらも残る（以前は並びの後ろのレコードの条件通知が先に 0 件）
  for (const q of ['金額の通知を見直したい', '承認者に通知が届かない原因は？', '承認漏れを防ぐ通知はある？']) {
    const g = gen(q, { inputs: bigNotifyInputs() });
    const pr = g.ctx.facts.filter(f => String(f.key).startsWith('NOTIFY:perRecord#')).length, ge = g.ctx.facts.filter(f => String(f.key).startsWith('NOTIFY:general#')).length;
    const st = ['reminder', 'process-state', 'process-action'].map(k => g.ctx.facts.filter(f => f.kind === k).length);
    assert(g.ok && pr >= 2 && ge >= 2 && st.every(x => x >= 2) && g.ctx.size.bytes <= 64 * 1024, `T1: 「${q}」でも各範囲が 2 件以上残る: ${JSON.stringify({ perRecord: pr, general: ge, st })}`);
  }
});
await section(async () => {
  // T2: フィールドの名前の語だけの質問は、知らせ方・時期の言い方が無ければ通知の相談にしない。「通知」というフィールドの設定の相談は通知の相談
  const ip = inputsWith(LABEL_FIELDS);
  const not = ['期限の計算式は？', '期限で並べ替えたい', '期限を一覧に表示したい', 'メールアドレスは何に使っている？', '連絡先を一覧に表示したい', 'お知らせ欄を広くしたい'];
  const wrong = not.filter(q => isNotify(gen(q, { inputs: ip })));
  assert(!wrong.length, `T2: フィールドの名前だけの質問は通知の相談にしない: ${wrong.join(' / ')}`);
  const amb = gen('期限と担当者の関係は？', { inputs: ip });
  assert(!amb.ok && amb.reason === 'ambiguous', `T2: 「期限と担当者の関係は？」は候補を選ぶ: ${amb.ok}/${amb.reason}`);
  const ip2 = inputsWith({ notify_flag: fld('CHECK_BOX', 'notify_flag', '通知') });
  assert(isNotify(gen('通知の設定を見直したい', { inputs: ip2 })) && !isNotify(gen('通知フィールドの型は？', { inputs: ip2 })), 'T2: 「通知」というフィールドがあっても、通知の設定の相談は通知の相談（フィールドの型の質問は違う）');
});
await section(async () => {
  // T3: 「いいえ」は残りの確認事項に割り当てない（どの確認事項への答えか決められない）
  const qs = [QREC({ id: 'Q1', question: '既存のメール通知は残しますか？', topic: 'other', recommendation: '' }), QREC({ id: 'Q2', question: '何日たったら催促しますか？', topic: 'threshold', recommendation: '3 日' })];
  const { c, calls } = makeConv([planWith(qs), planWith([])]);
  await c.send('承認漏れを防ぎたい');
  await c.send('いいえ。5日で');
  const ds = (calls.plan[1] && calls.plan[1].decisions) || [];
  assert(!ds.some(d => d.answer === 'いいえ'), `T3: 「いいえ」を別の確認事項の回答にしない: ${JSON.stringify(ds.map(d => d.answer))}`);
});
await section(async () => {
  // T4: まとめた抜粋の文は範囲の最後の行まで入る（途中で切れて範囲の表記と食い違わない）
  const ip = inputsWith({}, { files: [{ name: 'setApprover.js', target: 'desktop', kind: 'js', text: SET_APPROVER_JS }] });
  const g = KTContext.build({ focus: { type: 'file', id: 'desktop:js:setApprover.js' }, ...ip, options: {} });
  const ex = g.facts.filter(f => f.kind === 'code-excerpt');
  const bad = ex.filter(f => !new RegExp(`(^|\\n)${f.lines.to}: `).test(f.text));
  assert(ex.length && !bad.length, `T4: 抜粋の文に範囲の最後の行がある: ${bad.map(f => `${f.lines.from}-${f.lines.to}`).join(',')}`);
  // 日本語の鍵の名前は、値が引用符で囲まれていても伏字
  const r = KTContext.redactSecretLikeText;
  assert(!/P@ssw0rd/.test(r("const パスワード = 'P@ssw0rd!2026';")) && !/abc1234567/.test(r('// トークン: "abc1234567xyz"')), 'T4: 日本語の鍵の名前（引用符つきの値）も伏字');
});
await section(async () => {
  // T5: 「5日で、数え方は提案で」・「あなたに任せる」「任せる」「おすすめでお願いできますか？」「おすすめでいこう」
  const qs2 = [QREC({ id: 'Q1', question: '経過期間は、どの時点から数えますか？', topic: 'timing', recommendation: '更新日時から数える' }), QREC({ id: 'Q2', question: '起算日から何日後に通知しますか？', topic: 'threshold', recommendation: '3 日後' })];
  const k = makeConv([planWith(qs2), planWith([])]);
  await k.c.send('承認漏れを防ぎたい');
  await k.c.send('5日で、数え方は提案で');
  const ds2 = (k.calls.plan[1] && k.calls.plan[1].decisions) || [];
  assert(ds2.some(d => d.answer === '更新日時から数える') && ds2.some(d => /5日/.test(d.answer)), `T5: 「数え方は提案で」も推奨の文を回答に: ${JSON.stringify(ds2.map(d => d.answer))}`);
  const { c } = makeConv([planWith([])]);
  await c.send('承認待ちの案件を見落とさないようにするには？');
  const ng = ['あなたに任せる', '任せる', 'おすすめでお願いできますか？', 'おすすめでいこう'].filter(s => c.classify(s).reason !== 'ADOPT_CONSULTATION');
  assert(!ng.length, `T5: 委ねる言い方: ${ng.join(' / ')}`);
});
await section(async () => {
  // T6: 計画の作成中に聞いた質問の答えが計画の後に遅れて届いても、それを「直前の相談」にしない（計画の確認事項の推奨を使う）
  const qs = [QREC({ id: 'Q1' })];
  const { c, calls, ctl } = makeConv([planWith(qs), planWith([])]);
  let openAsk; const askGate = new Promise(r => { openAsk = r; });
  const relPlan = ctl.hold();
  ctl.askGate = askGate;
  const p = c.send('承認漏れを防ぎたい');
  await tick2(); await tick2();
  await c.send('ところで、ステータスの更新の通知は誰に届きますか？');
  relPlan(); await p; for (let i = 0; i < 4; i++) await tick2();
  openAsk(); for (let i = 0; i < 6; i++) await tick2();
  const kinds = c.messages().map(m => m.type);
  const planAt = kinds.lastIndexOf('PLAN'), ansAt = kinds.lastIndexOf('ANSWER');
  const r = c.classify('おすすめで');
  assert(planAt >= 0 && (ansAt < planAt || r.reason === 'ADOPT_RECOMMENDATIONS'), `T6: 遅れて届いた答えではなく、計画の確認事項の推奨を使う: ${r.reason} / plan ${planAt} answer ${ansAt}`);
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
