// 会話の応答性（2026-10-05）: 入力欄の保護（送った文と、送った後に書いた下書きを分ける）
//
// 検証内容（mountAiWorkspace・fake DOM。AI client は応答を待たせられる fake）:
//   - 送信を受け付けた時点で入力欄から送った文を外し、応答を待つ間も入力欄に書ける（長い時間入力不可にしない）
//   - 成功・失敗・キャンセル・新しい会話（遅れた応答）で、待つ間に書いた下書きを消さない・上書きしない
//   - 失敗・キャンセルで入力欄が空なら送った文を戻す（従来どおり。直して送れる）
//   - ［再試行］・回答欄・panel.send など入力欄以外からの送信は入力欄に触れない
//   - 応答待ちに送ろうとしたら送らず、下書きを残したことを伝える
//   - C-1 第 3 段（2026-10-08）: 回答欄の試験は、最終案のカードの回答欄（新しい流れ。tests/helpers/new-flow.js）の上で行う
//
// 実行方法: node tests/ai-chat-draft.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const T = loadToolkit();
const { KTDeps, KTAiClient, mountAiWorkspace } = T;
//   C-1 第 3 段（2026-10-08）: 回答欄（6 の後半・7）は新しい流れ（仮案 → 採用 → 最終案のカードの回答欄）の上で試す（共有の部品）
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');

const DATA = FX.makeData();
const DEPS = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], addMappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
const step = (id, actionType, targetKind, targetRef, sp = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PREVIEW_SUPPORTED', supported: true, reason: 'x' } });
const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] } } }, usage: { monthlyLimit: 200, usedThisMonth: 1 } };
const META = { requestId: 'pl-d', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 200 } };
const planResp = (ctx, keepQ2 = false) => ({ ok: true, contractVersion: '2.1', meta: META, plan: { goal: ctx.goal, solution: 'STANDARD', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], gaps: [], evidenceIds: [] }, relevantFields: [], proposedFields: [], steps: [step('P1', 'ADD_VIEW', 'VIEW', '高額案件', { name: '高額案件', fields: ['amount'] })], alternatives: [], impact: [], questions: ctx.revision ? (keepQ2 ? [{ id: 'Q1', question: '一覧に表示する項目は金額だけでよいですか？', topic: 'other' }] : []) : [{ id: 'Q1', question: '高額とはいくらからですか？', topic: 'threshold' }, { id: 'Q2', question: '一覧に表示する項目は金額だけでよいですか？', topic: 'other' }], unknowns: [], planConfidence: 'INFERRED', customizations: [] } });
const answerResp = (ctx) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'qa-1', usage: { usedThisMonth: 2, monthlyLimit: 200 }, normalization: { warnings: [] } }, answer: 'このフィールドはルックアップのコピー先です。', facts: ctx.facts.length ? [{ text: 'fact', evidenceIds: [ctx.facts[0].id] }] : [], analysis: [], recommendations: [], unknowns: [] });
const Q = 'このフィールドは何に使ってる？';
/** 回答欄のキー（台帳の項目。修正前の版は版と Q 番号） */
const qkeyOf = (m, v, key) => { const c = m.panel.conversation(); const q = typeof c.answerContext === 'function' ? c.answerContext().open.find(x => x.key === key) : null; return q && q.entryId ? `${v.planId}:e:${q.entryId}` : `${v.planId}:${v.version}:${key}`; };
const ticks = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

/** AI タブを mount する。hold() で応答を止め、release() で返す。failNext に code を入れると次の 1 回を失敗させる */
function mount({ keepQ2 = false } = {}) {
  const calls = [];
  const ctl = { held: false, waiters: [], failNext: null };
  const wait = (signal) => new Promise((res, rej) => {
    if (!ctl.held) return res();
    ctl.waiters.push(res);
    if (signal) signal.addEventListener('abort', () => { const e = new Error('キャンセルしました'); e.name = 'AbortError'; e.code = 'CANCELLED'; rej(e); });
  });
  const failMaybe = () => { if (ctl.failNext) { const code = ctl.failNext; ctl.failNext = null; const e = new Error('AI プロバイダが応答しませんでした'); e.code = code; throw e; } };
  const client = {
    async getHealth() { return HEALTH; },
    async plan({ ctx, requestId, signal }) { calls.push({ kind: 'plan', ctx }); await wait(signal); failMaybe(); const v = KTAiClient.validatePlan(planResp(ctx, keepQ2), ctx); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
    async ask({ ctx, requestId, signal }) { calls.push({ kind: 'ask', ctx }); await wait(signal); failMaybe(); const v = KTAiClient.validateAnswer(answerResp(ctx), ctx); return { ...v.normalized, requestId: v.normalized.requestId || requestId, clientWarnings: v.warnings }; },
  };
  const storage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' }); settings.setConsent(true);
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const host = makeFakeHost();
  const panel = mountAiWorkspace(host, { getInputs: () => ({ data: DATA, deps: DEPS, scan: null, incoming: null }), copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false }, executor: { api: makeKintoneMock(DATA).api, appId: '310' } });
  const $ = (id) => host.querySelector(`#${id}`);
  return {
    panel, $, calls, ctl,
    hold() { ctl.held = true; },
    release() { ctl.held = false; const w = ctl.waiters.splice(0); w.forEach(f => f()); },
    input: () => $('kt-ai-input'),
    type(t) { $('kt-ai-input').value = t; },
    send() { return $('kt-ai-send').dispatch('click'); },
    enter() { return $('kt-ai-input').dispatch({ type: 'keydown', key: 'Enter' }); },
    act(dataset) { return $('kt-ai-chat').dispatch({ type: 'click', target: { dataset } }); },
    msgs: () => panel.conversation().messages(),
    last: () => { const m = panel.conversation().messages(); return m[m.length - 1]; },
    note: () => $('kt-ai-composer-note').textContent || '',
  };
}

(async () => {
await new Promise(r => setTimeout(r, 0));
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.message}`); } }

// =========================================================
console.log('\n--- 1. 成功: 送信を受け付けたら入力欄から外し、待つ間に書いた下書きは応答の後も残る ---');
await section(async () => {
  const m = mount(); await ticks();
  m.hold();
  m.type(Q); await m.send(); await ticks();
  assert(m.input().value === '' && m.input().disabled === false && m.$('kt-ai-send').disabled === true && m.panel.conversation().isBusy(), `受け付けた時点で入力欄から送った文を外し、入力欄は書ける（送信ボタンだけ止める）: value=${JSON.stringify(m.input().value)} disabled=${m.input().disabled}`);
  assert(/次の文を書いておけます/.test(m.note()), `応答待ちの案内: ${m.note()}`);
  m.type('次に聞きたいこと（下書き）');
  m.release(); await ticks();
  assert(m.last().type === 'ANSWER' && m.input().value === '次に聞きたいこと（下書き）', `成功しても、待つ間に書いた下書きは消さない: ${JSON.stringify(m.input().value)}`);
  m.type(Q); await m.send(); await ticks();
  assert(m.input().value === '' && m.calls.length === 2, '下書きが無ければ、成功の後の入力欄は空（従来どおり）');
});

// =========================================================
console.log('\n--- 2. 失敗: 下書きを上書きしない。入力欄が空なら送った文を戻す ---');
await section(async () => {
  const m = mount(); await ticks();
  m.hold(); m.ctl.failNext = 'UPSTREAM_ERROR';
  m.type(Q); await m.send(); await ticks();
  m.type('書きかけの別の質問');
  m.release(); await ticks();
  assert(m.last().type === 'ERROR' && m.last().data.retryText === Q && m.input().value === '書きかけの別の質問', `失敗: 待つ間に書いた下書きを、送った文で上書きしない（送った文はエラーの［再試行］に残る）: ${JSON.stringify(m.input().value)}`);
  m.type(''); m.ctl.failNext = 'UPSTREAM_ERROR';
  m.type(Q); await m.send(); await ticks();
  assert(m.last().type === 'ERROR' && m.input().value === Q, '失敗: 入力欄が空なら送った文を戻す（直して送れる。従来どおり）');
});

// =========================================================
console.log('\n--- 3. キャンセル: 下書きを残す。入力欄が空なら送った文を戻す ---');
await section(async () => {
  const m = mount(); await ticks();
  m.hold();
  m.type(Q); await m.send(); await ticks();
  await m.$('kt-ai-cancel').dispatch('click'); await ticks();
  assert(m.msgs().some(x => x.data && x.data.kind === 'cancelled') && m.input().value === Q && !m.panel.conversation().isBusy(), `キャンセル: 入力欄が空なら送った文を戻す: ${JSON.stringify(m.input().value)}`);
  m.type(Q); await m.send(); await ticks();
  m.type('キャンセルの後に送るつもりの文');
  await m.$('kt-ai-cancel').dispatch('click'); await ticks();
  assert(m.input().value === 'キャンセルの後に送るつもりの文', 'キャンセル: 待つ間に書いた下書きは残す（送った文で上書きしない）');
  m.release(); await ticks();
});

// =========================================================
console.log('\n--- 4. 送信中に新しい会話: 遅れた応答を入れず、下書きは残す ---');
await section(async () => {
  const m = mount(); await ticks();
  m.hold();
  m.type(Q); await m.send(); await ticks();
  m.type('新しい会話で聞くこと');
  await m.act({ act: 'new-conv' }); m.release(); await ticks();
  assert(m.msgs().length === 0 && m.input().value === '新しい会話で聞くこと', `新しい会話: 前の会話の応答を入れず、下書きは残す: msgs=${m.msgs().length} value=${JSON.stringify(m.input().value)}`);
});

// =========================================================
console.log('\n--- 5. 応答待ちに送ろうとしたとき: 送らず、下書きを残したことを伝える ---');
await section(async () => {
  const m = mount(); await ticks();
  m.hold();
  m.type(Q); await m.send(); await ticks();
  m.type('もう一つの質問'); await m.enter(); await ticks();
  assert(m.calls.length === 1 && m.input().value === 'もう一つの質問' && /下書きとして残しています/.test(m.note()), `応答待ちの Enter: 要求を重ねず、入力欄の文を残し、その旨を表示: ${m.note()}`);
  m.release(); await ticks();
  assert(m.input().value === 'もう一つの質問' && !/下書きとして残しています/.test(m.note()), '応答が届いたら案内は消え、下書きはそのまま送れる');
});

// =========================================================
console.log('\n--- 6. 入力欄以外からの送信は入力欄に触れない（［再試行］・回答欄・panel.send） ---');
await section(async () => {
  const m = mount(); await ticks();
  m.ctl.failNext = 'UPSTREAM_ERROR';
  m.type(Q); await m.send(); await ticks();
  const err = m.last();
  m.type('別の下書き');
  await m.act({ act: 'retry', text: err.data.retryText, intent: err.data.intent }); await ticks();
  assert(m.calls.length === 2 && m.last().type === 'ANSWER' && m.input().value === '別の下書き', `［再試行］: 入力欄の下書きを上書きしない（以前は入力欄に送った文を入れてから送り、成功で空にしていた）: ${JSON.stringify(m.input().value)}`);
  m.type('panel.send の間に書いた下書き');
  await m.panel.send(Q); await ticks();
  assert(m.calls.length === 3 && m.input().value === 'panel.send の間に書いた下書き', 'panel.send（入力欄以外）: 成功しても入力欄を空にしない');
});
//   C-1 第 3 段（2026-10-08）: 回答欄は最終案のカードの中だけ（ai-flow-redesign R10-2）。古い確認事項のカードの代わりに、
//   仮案 → 採用 → 最終案（先に決めたい判断つき）まで共有の部品で進め、その回答欄から送る
/** 最終案の計画（画面の偽 client）: 最初は先に決めたい判断 Q1・Q2。keepQ2 なら作り直しの後も Q2 の質問だけ残す（番号は Q1 に振り直す） */
const QS_FINAL = [{ id: 'Q1', question: '高額とはいくらからですか？', topic: 'threshold', priority: 'blocking' }, { id: 'Q2', question: '一覧に表示する項目は金額だけでよいですか？', topic: 'other', priority: 'blocking' }];
const finalPlanImpl = (keepQ2) => ({ ctx, requestId }) => { const raw = K.PLAN_V1(ctx.goal); raw.plan.questions = ctx.revision ? (keepQ2 ? [{ ...QS_FINAL[1], id: 'Q1' }] : []) : QS_FINAL.map(q => ({ ...q })); const v = KTAiClient.validatePlan(raw, ctx); if (!v.ok) throw new Error(v.errors[0].message); return { ...v.normalized, requestId, clientWarnings: v.warnings }; };
/** 共有の部品の画面に、この試験の入力欄の操作を足す */
const mountFinal = async ({ keepQ2 = false } = {}) => {
  const k = K.mount({ planImpl: finalPlanImpl(keepQ2) });
  await ticks();
  const v1 = await K.adoptOnScreen(k);
  const m = { panel: k.panel, $: k.$, input: () => k.$('kt-ai-input'), type(t) { k.$('kt-ai-input').value = t; }, act(dataset) { return k.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset } }); } };
  return { m, k, v1 };
};
await section(async () => {
  const { m, v1 } = await mountFinal();
  assert(v1 && v1.final && v1.final.questions.length === 2 && /data-act="answer-questions"/.test(m.$('kt-ai-chat').innerHTML), `前提: 最終案のカードに先に決めたい判断 2 件の回答欄がある: ${v1 && v1.final && v1.final.questions.length}`);
  m.type('回答とは別に書いている依頼');
  await m.$('kt-ai-chat').dispatch({ type: 'input', target: { dataset: { qkey: qkeyOf(m, v1, 'Q1') }, value: '100万円以上' } });
  await m.act({ act: 'answer-questions', plan: v1.planId, version: String(v1.version) }); await ticks(12);
  assert(m.panel.conversation().activePlan().version === 2 && m.input().value === '回答とは別に書いている依頼', `回答欄から送って計画が v2 になっても、入力欄の下書きは消さない: ${JSON.stringify(m.input().value)}`);
});

// =========================================================
console.log('\n--- 7. 回答欄の下書き: 別の質問に答えて計画の版が進んでも、まだ送っていない回答欄の下書きは残る ---');
await section(async () => {
  const { m, v1 } = await mountFinal({ keepQ2: true });
  // Q2 の回答欄に書きかけ（まだ送らない）→ チャット欄で Q1 に答える（v2 では番号が振り直され、Q2 の質問は Q1 になる）
  await m.$('kt-ai-chat').dispatch({ type: 'input', target: { dataset: { qkey: qkeyOf(m, v1, 'Q2') }, value: '金額と案件名' } });
  await m.panel.send('100万円以上です'); await ticks(12);
  const v2 = m.panel.conversation().activePlan();
  const html = m.$('kt-ai-chat').innerHTML;
  assert(v2.version === 2 && (html.match(/class="kt-ai-qa-input"/g) || []).length === 1 && />金額と案件名<\/textarea>/.test(html), `新しい版の同じ質問（番号は Q1 に変わった）の回答欄に、書きかけの回答が残る: v=${v2.version}`);
});
await section(async () => {
  const m = mount(); await ticks();
  m.type('APIキー: a1B2c3D4e5f6 を使って会計システムに送って');
  await m.send(); await ticks();
  assert(m.calls.length === 0 && m.input().value === 'APIキー: a1B2c3D4e5f6 を使って会計システムに送って', '秘密情報らしい文は送らず、入力欄に残す（従来どおり）');
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
