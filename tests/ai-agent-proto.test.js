// 共通の会話・調査・変更案の仕組み（試作 2026-10-06）: KTAgent（共通）・KTAgentDomains（分野の部品。最初は通知）・KTAgentDemo（模擬応答）・KTAgentUi
//
// 検証内容（決定的。AI は使わない。自然な言い回しの理解の質は、実 AI の確認で別に確かめる）:
//   A 条件の保持: 回答・委任・追加・質問・取り消しが混ざっても、基準日時・間隔・停止条件・宛先・例外を会話から変更案まで保つ。
//     「承認待ちになった日時」を「更新日時」に置き換えた案は、Toolkit Review を通っても条件の照合で「要確認」にし、違う点を伝えて 1 回だけ作り直す
//   B 聞き直さない・必要な確認は残す: 決まった項目の確認事項は足さない（数を残す）。宛先が決まらない例外の確認は残す。質問・相づち・意図の分からない発言は案を作り直さない
//   C 古い案・未検証の案を反映の候補にしない: 作成中に条件が変わった案は「古い条件の案」。候補は、いまの条件の版で作って照合を通った最新の案だけ
//   D 計測: 意味のある返答までの時間・変更案までの時間・AI の呼び出し回数・設定の読み取り回数を発言ごとに残す
//   E 変更プレビューは書き込まない（Executor の準備まで。書き込みの関数は呼べない）。変更不要で完了できる
//   F 同じ仕組みが、分野の部品を足すだけでフィールドの変更・JS の修正にも使える（確認用の小さな部品）
//   G 会話を理解する担当の応答の正規化（根拠の無い決定は仮の案・根拠の無い取り消しは捨てる・意図が更新でない発言は条件を変えない）
//   H Toolkit Review: プロセス管理のアクションの実行時のイベントでの値の記録（WRITE）は「編集できない画面」にしない（公式で確認）
//   I 画面: 通常の入口は会話・入力欄・送信だけ（会話の方式・例の発言・模擬応答・計測は出さない。検証用の画面も作らない）。試作の変更案のカードは短い返答と最新の 1 枚
//
// 実行方法: node tests/ai-agent-proto.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const fs = require('fs');
const path = require('path');
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const T = loadToolkit();
const { KTDeps, KTScan, KTPlanReview, KTAgent, KTAgentDomains, KTAgentUi, mountAiWorkspace } = T;
const { KTAgentDemo } = require('./helpers/agent-demo.js');   // 模擬応答はテスト専用（本体に入れない）
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const P = KTAgent.PSTATUS;

const APPROVAL_JS = [
  "(() => {",
  "  'use strict';",
  "  const TOKEN = 'sk_live_0123456789abcdef0123';",
  "  kintone.events.on(['app.record.create.submit', 'app.record.edit.submit'], (event) => {",
  "    const r = event.record;",
  "    if (Number(r.amount.value) >= 1000000 && !r.approver.value.length) r.approver.error = '承認者を入れてください';",
  "    return event;",
  "  });",
  "})();",
].join('\n');
function inputs() {
  const data = FX.makeData();
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  const fields = fieldsN.filter(f => f.type !== 'SUBTABLE').map(f => ({ code: f.code, label: f.label, type: f.rawType }));
  const files = [...FX.files, { name: 'approvalCheck.js', target: 'desktop', kind: 'js', text: APPROVAL_JS }];
  const scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files, fields, deps, skippedUrlFiles: FX.skippedUrlFiles });
  KTDeps.mergeScannerEdges(deps, scan);
  return { data, deps, scan };
}
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

/** 模擬の会話の仕組み（模擬応答・実物の Toolkit Review・実物の変更プレビュー（模擬の kintone））。plan の前で止める gate を差し込める */
function setup({ drift = 'first', domains = KTAgentDomains.all, turn = null, plan = null } = {}) {
  const ip = inputs();
  const mock = makeKintoneMock(ip.data);
  const demo = KTAgentDemo.createServices({ getInputs: () => ip, delays: { turn: 0, plan: 0 }, drift });
  let now = 0;
  const ctl = { planGate: null, planCalls: [], turnCalls: [] };
  const services = {
    async turn(payload) { ctl.turnCalls.push(payload); now += 700; return turn ? turn(payload, ip) : demo.turn(payload); },
    async plan(args) { ctl.planCalls.push(args); if (ctl.planGate) await ctl.planGate.p; now += 5000; return plan ? plan(args, ip) : demo.plan(args); },
    review: (p) => KTPlanReview.review({ plan: p, ...ip }),
    prepare: (p, rv) => KTAgent.preview({ plan: p, review: rv, api: mock.api, appId: '310' }),
  };
  const eng = KTAgent.create({ services, domains, getInputs: () => ip, clock: () => now });
  return { eng, ip, mock, ctl, demo, say: async (text) => { const r = await eng.send(text); await eng.idle(); return r; } };
}
const SAY = (id, data) => KTAgentDemo.SCRIPT.find(s => s.id === id).say(data);
const cond = (eng, key) => KTAgent.conditionOf(eng.ledger(), key);
const writes = (mock) => mock.calls.filter(c => !/^GET/.test(c));

(async () => {
async function section(name, fn) { console.log(`\n--- ${name} ---`); try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }

await section('A/B/C/D/E 通知の相談を最後まで（模擬応答）', async () => {
  const S = setup();
  const data = S.ip.data;
  // 1. 質問: 設定を読み足して答える。条件も変更案も作らない
  await S.say(SAY('ask', data));
  const m1 = S.eng.metrics()[0];
  assert(m1.intent === 'question' && m1.calls.filter(c => /^turn/.test(c.role)).length === 2 && !S.eng.latestProposal() && S.eng.ledger().rev === 0, `A1: 質問は設定を読み足して（2 回）答え、条件と変更案は変えない: ${m1.intent} calls=${m1.calls.map(c => c.role)}`);
  const reply1 = S.eng.state.messages.filter(m => m.type === 'reply').pop().text;
  assert(/リマインダー/.test(reply1) && /（設定）/.test(reply1) && S.eng.state.reads.has('setting:notifications') && S.eng.state.messages.some(m => m.type === 'notice' && /調べています/.test(m.text)), `A1: 読み足した設定から答える（確かめ方つき）・「調べています」: ${reply1}`);

  // 2. 依頼（回答・委任・例外・止める条件が 1 つの発言に混ざる）
  await S.say(SAY('request', data));
  const lg = S.eng.ledger();
  const base = cond(S.eng, 'notification.base_datetime'), time = cond(S.eng, 'notification.time_of_day');
  assert(base && base.origin === 'delegated' && base.value.kind === 'status-entered' && base.value.status === '承認待ち' && /更新日時は編集でも変わる/.test(base.reason), `A2: 「数え方はおまかせ」は委任。選んだ案（承認待ちになった日時）と前提を残す: ${JSON.stringify(base && { o: base.origin, v: base.value })}`);
  assert(cond(S.eng, 'notification.interval')?.value.days === 3 && cond(S.eng, 'notification.recipients')?.value.only === true && cond(S.eng, 'notification.stop_condition')?.value.status === '承認待ち' && cond(S.eng, 'notification.exceptions')?.value.items[0].cond === 'amount >= "1000000"', 'A2: 間隔・宛先（作業者だけ）・止める条件・金額の例外を条件として残す');
  assert(time && time.origin === 'ai' && time.value.time === '09:00', `A2: 指定の無い時刻は AI の仮の案（決定と区別）: ${time && time.origin}`);
  const ps = S.eng.proposals();
  const v1 = ps[0], v2 = ps[1];
  assert(ps.length === 2 && v1.status === P.NEEDS_ATTENTION && v1.checks.some(c => c.key === 'notification.base_datetime' && c.status === 'mismatch' && c.actual === '更新日時'), `A3: 更新日時に置き換えた案は、Toolkit Review を通っても条件の照合で要確認: ${v1 && v1.status} ${JSON.stringify(v1 && v1.checks.map(c => `${c.key}:${c.status}`))}`);
  assert((v1.review.steps || []).every(r => r.status === 'VALID'), `A3（前提）: 置き換えた案は Toolkit Review では問題なし（形式の検証だけでは合格にしない理由）: ${v1.review.steps.map(r => r.status)}`);
  assert(v2 && v2.repairs === 1 && /条件と違った/.test(v2.log.join(' ')) && v2.checks.find(c => c.key === 'notification.base_datetime')?.status === 'ok' && S.ctl.planCalls[1].repair && S.ctl.planCalls[1].repair.notes.some(n => /更新日時/.test(n)), `A3: 違う点を伝えて 1 回だけ作り直し、基準日時は「承認待ちになった日時」（記録用の日時フィールドとアクションの実行時の記録）: ${v2 && JSON.stringify(v2.checks.map(c => `${c.key}:${c.status}`))}`);
  assert(['notification.interval', 'notification.time_of_day', 'notification.stop_condition', 'notification.recipients'].every(k => v2.checks.find(c => c.key === k)?.status === 'ok'), 'A3: 間隔・時刻・止める条件・宛先（作業者だけ）は案と一致');
  // 宛先が決まらない例外の確認は残す（必要な確認）。候補にはしない
  const q = lg.questions.find(x => x.status === 'open' && /上長/.test(x.text));
  assert(q && v2.status === P.NEEDS_ATTENTION && v2.checks.find(c => c.key === 'notification.exceptions')?.status === 'pending' && !S.eng.candidate(), `B1: 上長が誰か決まらない例外は「確認待ち」。確認事項として残し、候補にしない: ${v2.status} ${q && q.text}`);
  const m2 = S.eng.metrics()[1];
  assert(m2.replyMs != null && m2.proposalMs != null && m2.replyMs < m2.proposalMs && m2.calls.filter(c => /^turn/.test(c.role)).length === 2 && m2.calls.filter(c => /^plan/.test(c.role)).length === 2 && m2.calls.some(c => c.role === 'plan-repair'), `D1: 発言ごとに、返答までの時間・変更案までの時間・呼び出しの回数（会話 2・変更案 2（作り直し 1））: ${JSON.stringify({ r: m2.replyMs, p: m2.proposalMs, c: m2.calls.map(c => c.role) })}`);

  // 3. 相づち・意図の分からない発言は、条件も変更案も変えない
  const revBefore = lg.rev, nP = S.eng.proposals().length, nQ = lg.questions.length;
  await S.say(SAY('thanks', data));
  await S.say(SAY('hmm', data));
  assert(lg.rev === revBefore && S.eng.proposals().length === nP && lg.questions.length === nQ && S.ctl.planCalls.length === 2, `B2: 「ありがとう」「うーん」で案を作り直さない・新しい条件や必須の質問を作らない: rev ${lg.rev} proposals ${S.eng.proposals().length}`);

  // 4. 確認事項に答える → 例外の宛先が決まり、検証済みの案（反映の候補）と変更プレビュー
  await S.say(SAY('boss', data));
  const v3 = S.eng.latestProposal();
  assert(lg.questions.find(x => x.id === q.id).status === 'answered' && cond(S.eng, 'notification.exceptions').value.items[0].to.field === 'approver', 'A4: 上長は承認者フィールド（確認事項は答え済み・例外の宛先が決まる）');
  assert(v3.status === P.READY && S.eng.candidate() === v3 && v3.checks.every(c => c.status === 'ok'), `C1: いまの条件で照合を通った最新の案だけが反映の候補: ${v3.status} ${JSON.stringify(v3.checks.map(c => `${c.key}:${c.status}`))}`);
  assert(v3.preview && v3.preview.ok && v3.preview.prepared && v3.preview.prepared.status === 'PREPARED' && v3.preview.writesBlocked === 0 && writes(S.mock).length === 0 && v3.preview.reads > 0, `E1: 変更プレビューは動作テスト環境を読むだけ（書き込み 0 回）: ${v3.preview && v3.preview.prepared && v3.preview.prepared.status} writes=${writes(S.mock)}`);
  assert(v3.preview.steps.some(s => /リマインダー/.test(s.summary || '') && /approver/.test(s.summary || '')) && v3.preview.steps.some(s => s.actionType === 'CUSTOMIZATION_REQUIRED' && s.status === 'UNSUPPORTED'), 'E1: プレビューに例外のリマインダー（承認者にも）と、JS（次の段階）');
  assert(!v3.review.steps.some(r => (r.issues || []).some(i => i.code === 'JS_SCREEN_MISMATCH')), 'H1: アクションの実行時に日時を記録する JS は「編集できない画面」にしない');
  for (const old of S.eng.proposals().filter(x => x !== v3)) assert(S.eng.candidate() !== old, `C1: 古い版 ${old.id} は候補ではない`);

  // 5. 作っている途中に、時刻の変更と質問をまとめて送る → さらに例外を取り消す（作成中の案は古い条件の案になり、使わない）
  S.ctl.planGate = gate();
  const pMixed = S.eng.send(SAY('mixed', data));
  await ticks();
  assert(S.eng.isDrafting() && !S.eng.candidate(), 'C2: 条件が変わったら、作り直しの間は候補が無い（前の検証済みの案を候補に残さない）');
  const v4 = S.eng.latestProposal();
  const pRevoke = S.eng.send(SAY('revoke', data));
  await ticks();
  assert(cond(S.eng, 'notification.exceptions') === null && lg.conditions.some(c => c.key === 'notification.exceptions' && c.status === 'revoked'), 'A5: 作っている途中の取り消しも受け付ける');
  S.ctl.planGate.open(); S.ctl.planGate = null;
  await pMixed; await pRevoke; await S.eng.idle();
  const v5 = S.eng.latestProposal();
  assert(v4.status === P.STALE && v5 !== v4 && v5.status === P.READY && S.eng.candidate() === v5 && v5.rev === lg.rev, `C2: 作成中に条件が変わった案は「古い条件の案」で候補にしない。いまの条件で作り直す: v4=${v4.status} v5=${v5.status}`);
  assert(cond(S.eng, 'notification.time_of_day').value.time === '08:00' && cond(S.eng, 'notification.time_of_day').origin === 'user' && cond(S.eng, 'notification.base_datetime').origin === 'delegated' && cond(S.eng, 'notification.interval').value.days === 3 && cond(S.eng, 'notification.recipients').value.only === true, 'A5: 時刻は利用者の決定に変わり、ほかの条件（基準日時・間隔・宛先）は保つ');
  assert(!v5.plan.steps.some(s => /amount/.test(s.spec?.filterCond || '')) && v5.checks.every(c => c.status === 'ok'), 'A5: 取り消した例外のリマインダーは案に無い');
  const mixedReply = S.eng.state.messages.filter(m => m.type === 'reply').map(m => m.text).find(t => /8:00/.test(t));
  assert(mixedReply && /更新日時は、レコードを編集するたびに/.test(mixedReply) && /一般的な知識/.test(mixedReply), 'B3: 1 つの発言の質問にも答える（確かめ方を分ける）');
  // 取り消した例外のリマインダーが残る案は照合で要確認
  const leftover = KTAgentDomains.notification.checkConditions({ steps: [...v5.plan.steps, { id: 'PX', actionType: 'ADD_REMINDER', title: '残り', spec: { filterCond: 'ステータス in ("承認待ち") and amount >= "1000000"', targets: [] } }], proposedFields: v5.plan.proposedFields, customizations: v5.plan.customizations }, KTAgent.activeConditions(lg), data, { revoked: lg.conditions.filter(c => c.status === 'revoked') });
  assert(leftover.some(c => c.status === 'mismatch' && /取り消した/.test(c.expected)), 'C3: 取り消した条件が残る案は「要確認」');

  // 6. 方式の違いを利用者が受け入れる（更新日時で数える）→ その条件で案を作る
  await S.say(SAY('accept-updated', data));
  const v6 = S.eng.latestProposal();
  assert(cond(S.eng, 'notification.base_datetime').origin === 'user' && cond(S.eng, 'notification.base_datetime').value.field === '更新日時' && v6.status === P.READY && !v6.plan.steps.some(s => s.actionType === 'ADD_FIELD') && v6.plan.steps.find(s => s.actionType === 'ADD_REMINDER').spec.timingField === '更新日時', `A6: 利用者が更新日時で良いと決めたら、その条件で作る（記録用のフィールドと JS は要らない）: ${v6.status}`);
  assert(lg.reaskBlocked >= 0 && writes(S.mock).length === 0, 'E1: 会話全体で書き込み 0 回');
  const m = S.eng.metrics();
  assert(m.every(t => t.replyMs != null) && m.filter(t => t.proposalMs != null).length >= 4, `D1: すべての発言に返答までの時間。変更案を作った発言には変更案までの時間: ${m.map(t => `${t.intent}:${t.replyMs}/${t.proposalMs}`).join(' ')}`);
});

await section('B 決まった項目は聞き直さない（変更案を作る担当の確認事項）', async () => {
  const S = setup({ drift: 'never', plan: async (args, ip) => { const p = KTAgentDemo.buildNotificationPlan({ conditions: args.conditions, data: ip.data }); p.questions = [...p.questions, { id: 'QX', question: '催促の通知先は誰にしますか？', topic: 'notify_target', options: ['作業者だけ', '作業者と申請者'], recommendation: '作業者と申請者' }, { id: 'QY', question: '休日も通知しますか？', topic: 'other', options: [], recommendation: '' }]; return { ok: true, plan: p }; } });
  await S.say(SAY('request', S.ip.data));
  const lg = S.eng.ledger();
  assert(!lg.questions.some(q => /通知先は誰/.test(q.text)) && lg.reaskBlocked >= 1, `B4: 宛先が決まっているので「通知先は誰？」は足さない（止めた数を残す）: ${lg.reaskBlocked}`);
  assert(lg.questions.some(q => /休日も通知/.test(q.text) && q.status === 'open'), 'B4: 項目の決まらない業務の判断は確認事項として残す');
  const n = lg.questions.length;
  await S.say(SAY('mixed', S.ip.data));
  assert(lg.questions.length === n, `B4: 作り直しても同じ確認事項を重ねない: ${lg.questions.length}`);
});

await section('E 変更不要で完了', async () => {
  const S = setup();
  const say = SAY('existing', S.ip.data);
  assert(/「期限」の1日前の09:00に「担当者」へ知らせたい/.test(say), `前提: アプリのリマインダーから例の発言を作る: ${say}`);
  await S.say(say);
  const p = S.eng.latestProposal();
  assert(p && p.status === P.NO_CHANGE && /期限前日のリマインド/.test(p.notes[0]) && S.ctl.planCalls.length === 0 && !S.eng.candidate(), `E2: 既存のリマインダーで足りるときは「変更不要」で完了（変更案を作る AI を呼ばない・反映の候補も無い）: ${p && p.status}`);
});

await section('G 会話を理解する担当の応答の正規化', async () => {
  const slots = KTAgentDomains.slotsOf();
  const u = '3日たったら作業者だけに知らせて';
  const n = KTAgent.normalizeTurn({ intent: 'update', reply: 'r', ops: [
    { op: 'set', key: 'notification.interval', valueJson: '{"days":3}', origin: 'user', quote: '3日たったら' },
    { op: 'set', key: 'notification.recipients', valueJson: '{"kind":"assignee","only":true}', origin: 'user', quote: '（言い換え）作業者のみ' },
    { op: 'revoke', key: 'notification.exceptions', quote: '' },
    { op: 'set', key: 'notification.unknown', valueJson: '{}', quote: '3日' },
    { op: 'set', key: 'notification.time_of_day', valueJson: '{"time":"09:05"}', quote: '' },
    { op: 'set', key: 'custom.休日', valueJson: '"除く"', origin: 'user', quote: '作業者だけ' },
  ], answers: [{ questionId: 'Q9', kind: 'value', text: 'x' }], reads: [{ kind: 'setting', ref: 'setting:process' }, { kind: 'web', ref: 'https://example.com' }], needProposal: true }, { slots, questions: [], utterance: u });
  assert(n.ops.length === 3 && n.ops[0].origin === 'user' && n.ops[1].origin === 'ai' && n.ops[2].key === 'custom.休日', `G1: 根拠の無い「決定」は仮の案に下げる・知らない項目と形の合わない値（09:05）と根拠の無い取り消しは捨てる: ${JSON.stringify(n.ops.map(o => `${o.key}:${o.origin}`))}`);
  assert(n.answers.length === 0 && n.reads.length === 1 && n.reads[0].ref === 'setting:process' && n.warnings.length >= 4, 'G1: 知らない確認事項への答え・目録に無い種類の読み足しは捨て、理由を残す');
  const q = KTAgent.normalizeTurn({ intent: 'question', reply: 'r', ops: [{ op: 'set', key: 'notification.interval', valueJson: '{"days":3}', quote: '3日たったら' }], goal: 'x', needProposal: true }, { slots, utterance: u });
  const un = KTAgent.normalizeTurn({ intent: 'whatever', reply: 'r', ops: [{ op: 'set', key: 'notification.interval', valueJson: '{"days":3}', quote: '3日たったら' }], needProposal: true }, { slots, utterance: u });
  assert(q.ops.length === 0 && q.goal === null && q.needProposal === false && un.intent === 'unclear' && un.ops.length === 0 && un.needProposal === false, 'G2: 質問・意図の分からない発言は条件・目的・変更案を変えない');
  const z = KTAgent.normalizeTurn({ intent: 'update', reply: 'r', ops: [{ op: 'set', key: 'notification.interval', valueJson: '{"days":3}', quote: '３日 たったら' }] }, { slots, utterance: u });
  assert(z.ops[0].origin === 'user', 'G3: 根拠の照合は全角半角・空白の違いを無視する');
  // 利用者の決定を仮の案で上書きしない
  const lg = KTAgent.createLedger();
  KTAgent.applyTurn(lg, { intent: 'update', ops: [{ op: 'set', key: 'notification.time_of_day', label: '時刻', text: '8:00', value: { time: '08:00' }, origin: 'user', quote: '8時' }], answers: [] });
  const r = KTAgent.applyTurn(lg, { intent: 'update', ops: [{ op: 'set', key: 'notification.time_of_day', label: '時刻', text: '9:00', value: { time: '09:00' }, origin: 'ai', quote: '' }], answers: [] });
  assert(!r.changed && KTAgent.conditionOf(lg, 'notification.time_of_day').value.time === '08:00' && lg.rev === 1, 'G4: 利用者の決定は AI の仮の案で上書きしない（版も進めない）');
});

await section('F 同じ仕組みでフィールドの変更・JS の修正（確認用の小さな分野の部品）', async () => {
  // フィールド: 必須にする
  const fieldDomain = {
    id: 'field', title: 'フィールド',
    slots: { 'field.required': { label: '必須', hint: '{"code":"amount","required":true}', validate: (v) => (v && typeof v.code === 'string' && typeof v.required === 'boolean' ? { ok: true, value: { code: v.code, required: v.required } } : { ok: false, reason: 'code と required' }) } },
    specs: [], planLines: () => [],
    checkConditions(plan, conds) { return conds.map(c => { const st = (plan.steps || []).find(s => s.actionType === 'UPDATE_FIELD' && s.targetRef === c.value.code); return { key: c.key, label: c.label, status: st && st.spec.required === c.value.required ? 'ok' : 'mismatch', expected: `${c.value.code} 必須=${c.value.required}`, actual: st ? `必須=${st.spec.required}` : '（手順なし）' }; }); },
  };
  const S = setup({ domains: [fieldDomain],
    turn: (p) => (p.utterance === '金額を必須にして' ? { intent: 'update', reply: '金額を必須にします。', ops: [{ op: 'set', key: 'field.required', label: '必須', text: '金額（amount）を必須', valueJson: '{"code":"amount","required":true}', origin: 'user', quote: '金額を必須にして' }], needProposal: true } : { intent: 'unclear', reply: '?' }),
    plan: async (args) => ({ ok: true, plan: { planVersion: '1', requestId: 'f', goal: '', assessment: { summary: '金額を必須にする' }, relevantFields: [], proposedFields: [], steps: [{ id: 'P1', actionType: 'UPDATE_FIELD', targetKind: 'FIELD', targetRef: args.conditions[0].value.code, targetExists: true, title: '金額を必須にする', proposal: { summary: '', details: [] }, spec: { required: true }, dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternatives: [] }], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED' } }) });
  await S.say('金額を必須にして');
  const p = S.eng.latestProposal();
  assert(p.status === P.READY && S.eng.candidate() === p && p.preview.prepared && writes(S.mock).length === 0, `F1: フィールドの変更も同じ会話・照合・変更プレビューで進む（分野の部品を足すだけ）: ${p.status} ${p.notes}`);
  // JS: 既存の JS を読み足して、その JS に足す案（読み足した本文は伏字・使い回す）
  const jsDomain = {
    id: 'js', title: 'JavaScript',
    slots: { 'js.target': { label: '直す JavaScript', hint: '{"file":"approvalCheck.js"}', validate: (v) => (v && typeof v.file === 'string' ? { ok: true, value: { file: v.file } } : { ok: false, reason: 'file' }) } },
    specs: [], planLines: () => [],
    checkConditions(plan, conds) { return conds.map(c => { const cu = (plan.customizations || []).find(x => (x.existingFiles || []).some(f => f.name === c.value.file)); return { key: c.key, label: c.label, status: cu && cu.strategy === 'EXTEND_EXISTING_JS' ? 'ok' : 'mismatch', expected: c.value.file, actual: cu ? cu.strategy : '（なし）' }; }); },
  };
  const S2 = setup({ domains: [jsDomain],
    turn: (p) => {
      if (!p.followup) return { intent: 'update', reply: 'JavaScript を読みます。', reads: [{ kind: 'js', ref: 'js:desktop:approvalCheck.js', reason: '今の処理' }] };
      const body = p.reads[0].content;
      return { intent: 'update', reply: `今の approvalCheck.js は保存のときに承認者を確かめています（コード）。${/sk_live/.test(body) ? 'NG' : ''}`, ops: [{ op: 'set', key: 'js.target', label: '直す JavaScript', text: 'approvalCheck.js', valueJson: '{"file":"approvalCheck.js"}', origin: 'user', quote: 'approvalCheck.js' }], needProposal: true };
    },
    plan: async () => ({ ok: true, plan: { planVersion: '1', requestId: 'j', goal: '', assessment: { summary: '' }, relevantFields: [], proposedFields: [], steps: [{ id: 'C1', actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: '', targetExists: null, title: 'approvalCheck.js に足す', proposal: { summary: '', details: [] }, spec: { customizationId: 'C1' }, dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternatives: [], solution: 'CUSTOMIZATION', execution: { mode: 'PLAN_ONLY', supported: false, reason: 'JS' } }], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', solution: 'CUSTOMIZATION', customizations: [{ customizationId: 'C1', requirement: '金額が500万円以上なら部長も必須', whyStandardInsufficient: '条件つきの必須は標準に無い', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.create.submit', 'app.record.edit.submit'], fields: [{ code: 'amount', access: 'READ' }], apis: [], existingFiles: [{ name: 'approvalCheck.js', target: 'desktop' }], risks: [], questions: [], dependsOn: [] }] } }) });
  await S2.say('approvalCheck.js の承認者のチェックに、金額が500万円以上なら部長も必須を足して');
  const read = S2.eng.state.reads.get('js:desktop:approvalCheck.js');
  const p2 = S2.eng.latestProposal();
  assert(read && read.basis === 'code' && !/sk_live_0123456789abcdef0123/.test(read.content) && /approver/.test(read.content), 'F2: JS の本文を目録から読み足す（秘密情報らしい文字列は伏字）');
  assert(!/NG/.test(S2.eng.state.messages.filter(m => m.type === 'reply').pop().text) && p2.status === P.READY && p2.checks[0].status === 'ok', `F2: JS の修正も同じ会話・照合で進む: ${p2.status}`);
  // 分野の言い回しに依存しない: 共通の部分（KTAgent）の本文に、通知・承認などの分野の語が無い
  const src = fs.readFileSync(process.env.KT_SRC || path.join(__dirname, '..', 'kintoneAppToolkit.user.js'), 'utf8');
  const core = src.slice(src.indexOf('  const KTAgent = (() => {'), src.indexOf('  const KTAgentUi = (() => {'));
  // kintone の設定の目録（SETTING_REFS: 通知・プロセス管理などの設定の種類）は全分野で共通の語彙なので外す
  const code = core.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*\*)/.test(l) && !/ref: 'setting:/.test(l)).join('\n');
  assert(core.length > 1000 && !/通知|リマインダー|承認|ステータス|reminder|notification/.test(code), 'F3: 共通の部分（KTAgent）のコードは分野の語に依存しない（分野の知識は KTAgentDomains）');
});

await section('H Toolkit Review: アクションの実行時のイベントでの値の記録', async () => {
  const ip = inputs();
  const mk = (events, fields) => ({ planVersion: '1', requestId: 'h', goal: '', assessment: { summary: '' }, relevantFields: [], proposedFields: [], steps: [{ id: 'C1', actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: '', targetExists: null, title: 'C1', proposal: { summary: '', details: [] }, spec: { customizationId: 'C1' }, dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternatives: [], solution: 'CUSTOMIZATION', execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' } }], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', solution: 'CUSTOMIZATION', customizations: [{ customizationId: 'C1', requirement: '記録する', whyStandardInsufficient: 'x', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events, fields, apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [] }] });
  const codes = (p) => KTPlanReview.review({ plan: p, ...ip }).steps[0].issues.map(i => i.code);
  assert(!codes(mk(['app.record.detail.process.proceed'], [{ code: 'due_date', access: 'WRITE' }])).includes('JS_SCREEN_MISMATCH'), 'H2: process.proceed での WRITE は合う（公式: event.record の値を変えて event を返すと書き換えられる）');
  assert(codes(mk(['app.record.detail.process.proceed'], [{ code: 'due_date', access: 'CONTROL' }])).includes('JS_SCREEN_MISMATCH'), 'H2: 入力欄の操作（CONTROL）は process.proceed では合わない');
  assert(codes(mk(['app.record.detail.show'], [{ code: 'due_date', access: 'WRITE' }])).includes('JS_SCREEN_MISMATCH'), 'H2: 詳細の表示（detail.show）での WRITE は従来どおり合わない');
  // 通知先の［作業者］（公式: アプリの条件通知・レコードの条件通知・リマインダーとも、プロセス管理が有効なら選べる）
  const rem = (targets) => ({ planVersion: '1', requestId: 'r', goal: '', assessment: { summary: '' }, relevantFields: [], proposedFields: [], steps: [{ id: 'P1', actionType: 'ADD_REMINDER', targetKind: 'REMINDER', targetRef: 'x', targetExists: null, title: 'x', proposal: { summary: '', details: [] }, spec: { name: '承認待ちのまま3日', timingField: '更新日時', daysLater: 3, time: '09:00', filterCond: 'ステータス in ("承認待ち")', targets, fields: [], assignees: [], events: [], mappings: [], options: [] }, dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternatives: [] }], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED' });
  const prepOf = async (data) => { const p = rem(['FIELD_ENTITY:作業者']); const rv = KTPlanReview.review({ plan: p, data, deps: null }); const m = makeKintoneMock(data); return T.KTPlanExecutor.prepare(KTPlanReview.executorOutput(p, rv, ['P1']), { api: m.api, appId: '310' }); };
  const on = await prepOf(ip.data);
  const offData = inputs().data; (offData.fields.properties || offData.fields)['作業者'].enabled = false;
  const off = await prepOf(offData);
  assert(on.status === 'PREPARED' && on.steps[0].status === 'PENDING', `H3: プロセス管理が有効なら、リマインダーの通知先に作業者を使える（以前は「通知先に使えない」で止まった）: ${on.status} ${on.steps[0].reason}`);
  assert(off.steps[0].reason === 'RECIPIENT_FIELD_INVALID' && /プロセス管理が有効でない/.test(off.steps[0].message), 'H3: プロセス管理が無効なら作業者は通知先に使えない');
});

await section('I 画面（通常の入口は会話・入力欄・送信だけ。試作の変更案のカードは短い返答と最新の 1 枚・詳細）', async () => {
  const S = setup();
  await S.say(SAY('request', S.ip.data));
  const html = KTAgentUi.messagesHtml(S.eng, { mode: 'demo' });
  const cards = html.split('class="kt-agent-proposal"').length - 1;
  const outside = html.replace(/<details[\s\S]*?<\/details>/g, '');
  assert(cards === 1 && /おまかせ/.test(html) && /提案/.test(html) && !/仮の案/.test(html) && /決定/.test(html), `I1: 変更案のカードは 1 枚・条件に出どころ（決定・おまかせ・提案。「仮の案」の語は使わない）: cards=${cards}`);
  assert(!/\bV1\b|\bQ\d\b|\bC\d+\b|E\d+/.test(outside) && /過去の版/.test(html) && /V1（条件の版/.test(html), 'I1: 内部の番号・過去の版は詳細の中だけ');
  assert(/確認したいこと/.test(outside) && /上長/.test(outside), 'I1: 必要な確認はカードに出す');
  assert(S.eng.metrics().every(m => m.replyMs != null && Array.isArray(m.calls)), 'I2: 計測は会話の仕組みの中に残す（画面には出さない）');

  // 通常の入口（2026-10-06 利用者の指示）: 会話の方式・例の発言・再現・計測を出さない。開いた直後から自分の言葉を書ける。［新しい会話］は 1 か所
  const ip = inputs();
  const host = makeFakeHost();
  const mock = makeKintoneMock(ip.data);
  const panel = mountAiWorkspace(host, { getInputs: () => ip, copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, executor: { api: mock.api, appId: '310' }, devMode: false });
  const $ = (id) => host.querySelector(`#${id}`);
  const page = host.innerHTML;
  assert(!/会話の方式|例の発言|kt-ai-agent-bar|模擬応答|計測/.test(page) && !/会話の方式|例の発言|模擬応答/.test($('kt-ai-chat').innerHTML), 'I3: 通常の画面に、会話の方式・例の発言・模擬応答・計測が無い');
  assert(/このアプリについて、相談したいことや変更したいことを入力してください/.test($('kt-ai-chat').innerHTML) && /placeholder="このアプリについて、相談したいことや変更したいことを入力してください"/.test(page), 'I3: 初期表示と入力欄の案内');
  assert((page.match(/>新しい会話</g) || []).length === 1, `I3: ［新しい会話］は 1 か所: ${(page.match(/>新しい会話</g) || []).length}`);
  assert(!/data-pane="dev"|kt-ai-pane-dev|kt-agent-dev/.test(page + $('kt-ai-drawer-tabs').innerHTML) && typeof panel.agent === 'undefined' && typeof T.KTAgentDemo === 'undefined', 'I3: 本体に試作の検証用の画面・模擬応答の台本は無い');
  assert(!/data-pane="context"[^>]*style="display:none;"/.test(host.querySelector('#kt-ai-drawer-tabs').innerHTML), 'I6: 接続機能の無い環境では「Context」を出す（そこだけが使える機能）');
});

await section('JS の書き方（新しい部品に var が無い）', async () => {
  const src = fs.readFileSync(process.env.KT_SRC || path.join(__dirname, '..', 'kintoneAppToolkit.user.js'), 'utf8');
  const a = src.indexOf('  const KTAgentDomains = (() => {'), b = src.indexOf('  const KTAiWorkspaceViewModel = (() => {');
  const part = src.slice(a, b);
  assert(a > 0 && b > a && !/(^|[^\w.$-])var\s+[\w$]/m.test(part.replace(/var\(--[\w-]+/g, '')), 'J1: 試作の部品は const / let だけ（var を使わない）');
});

console.log(`\n${state.failed ? 'FAILED' : 'OK'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
