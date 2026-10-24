// 接続先の能力の印は接続時の 1 回の確認で確かめる（2026-10-23・評価の記録 §12.61。偽の kintone・偽の Gateway の health。有料の AI は呼ばない）
//
// 検証内容: 今の Toolkit が使う受け渡しの印（会話 conversation・計画 revisionModes / stream / requirementOps・生成 verification / stream）が欠ける接続先は、
//   接続時の能力の確認（KTAiClient.capabilityFromHealth）でその機能を使えないと示す（CAPABILITY_OUTDATED・足りない印）。使う場所ごとの印の分岐・
//   古い形の応答の読み替え・印の無い接続先のための代わりの経路（「接続先が非対応」で止める古い流れ）は Toolkit に無い。
//   §C1 能力の確認（純関数）: 印がそろえば使える。会話・計画・生成のどれか 1 つでも欠ければその機能だけ使えない（理由 CAPABILITY_OUTDATED・lacking に印）
//   §C2 画面: 会話の印が欠ける接続先では、依頼を送っても仮案・計画の AI を呼ばず、理由の文が出る（仮案・変更案のカードは出ない・書き込み 0）
//   §C3 画面: 生成の印が欠ける接続先では、仮案の採用から計画までは進むが生成工程を呼ばず、反映できる最終案にならない（書き込み 0）
//   §C4 受け取り（KTAiClient.receive）: 契約の関所（ok・契約の版・必須の本文）だけ。Gateway が正規化した形をそのまま返す（旧い形・入口の上限・派生の欄は作らない）
//
// 実行方法: node tests/ai-capability-marks.test.js（KT_SRC=<別ビルド> で別の版に対して走らせる）
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { KTAiClient } = T;
const { assert, state } = makeAssert();
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
const clone = (x) => JSON.parse(JSON.stringify(x));
const cap = (h) => KTAiClient.capabilityFromHealth(h);
const OUTDATED = KTAiClient.ERROR_CODES.CAPABILITY_OUTDATED;
const withoutQa = (mark) => { const h = clone(K.HEALTH_V); h.registry.toolkit['assistant-qa'].conversation = h.registry.toolkit['assistant-qa'].conversation.filter(x => x !== mark); return h; };
const withoutPlanner = (key, mark) => { const h = clone(K.HEALTH_V); h.registry.toolkit['change-planner'][key] = h.registry.toolkit['change-planner'][key].filter(x => x !== mark); return h; };
const withoutGen = (mark) => { const h = clone(K.HEALTH_V); const g = h.registry.toolkit['customization-generator']; g.verification = g.verification.filter(x => x !== mark); return h; };

(async () => {
console.log('\n--- §C1 能力の確認（純関数）: 印がそろえば使える・欠ければその機能だけ使えない ---');
await section(async () => {
  const full = cap(K.HEALTH_V);
  assert(full.available === true && full.features['assistant-qa'].available === true && full.features['change-planner'].available === true && full.features['customization-generator'].available === true,
    `C1-1: 今の AI サービスの印がそろった health は会話・計画・生成を使える: ${JSON.stringify(Object.fromEntries(Object.entries(full.features).map(([k, v]) => [k, [v.available, v.reason]])))}`);
  assert(OUTDATED === 'CAPABILITY_OUTDATED' && /この Toolkit に必要な機能に対応していません/.test(KTAiClient.errorText(OUTDATED)) && KTAiClient.errorCategory(OUTDATED) === 'version', 'C1-2: 符号 CAPABILITY_OUTDATED・利用者に見せる文・種類（version）');
  for (const mark of KTAiClient.CONVERSATION_MARKS) {
    const c = cap(withoutQa(mark));
    assert(c.available === false && c.reason === OUTDATED && c.features['assistant-qa'].available === false && JSON.stringify(c.features['assistant-qa'].lacking) === JSON.stringify([mark]) && c.features['change-planner'].available === true && c.features['customization-generator'].available === true,
      `C1-3（conversation に ${mark} が無い）: 会話を使えない（全体も available false）。計画・生成の判定は変えない: ${JSON.stringify({ available: c.available, reason: c.reason, lacking: c.features['assistant-qa'].lacking })}`);
  }
  for (const [key, mark] of [['revisionModes', 'patch'], ['stream', 'reply'], ['requirementOps', 'decisionRefs']]) {
    const c = cap(withoutPlanner(key, mark));
    assert(c.available === true && c.features['change-planner'].available === false && c.features['change-planner'].reason === OUTDATED && JSON.stringify(c.features['change-planner'].lacking) === JSON.stringify([mark]) && c.features['assistant-qa'].available === true,
      `C1-4（change-planner の ${key} に ${mark} が無い）: 計画だけ使えない（会話は使える）: ${JSON.stringify(c.features['change-planner'])}`);
  }
  const genRequired = [...K.GEN_EFFECT_FEATURES, ...K.GEN_CURRENT_FEATURES, 'requirementId'];
  for (const mark of genRequired) {
    const c = cap(withoutGen(mark));
    assert(c.available === true && c.features['customization-generator'].available === false && c.features['customization-generator'].reason === OUTDATED && JSON.stringify(c.features['customization-generator'].lacking) === JSON.stringify([mark]) && c.features['change-planner'].available === true,
      `C1-5（customization-generator の verification に ${mark} が無い）: 生成だけ使えない: ${JSON.stringify(c.features['customization-generator'])}`);
  }
  const noProgress = clone(K.HEALTH_V); noProgress.registry.toolkit['customization-generator'].stream = [];
  const cp = cap(noProgress);
  assert(cp.features['customization-generator'].available === false && JSON.stringify(cp.features['customization-generator'].lacking) === '["progress"]', `C1-6（stream に progress が無い）: 生成を使えない: ${JSON.stringify(cp.features['customization-generator'])}`);
  const none = clone(K.HEALTH_V); delete none.registry.toolkit['customization-generator'].verification;
  const cn = cap(none);
  assert(cn.features['customization-generator'].available === false && cn.features['customization-generator'].lacking.length === genRequired.length, `C1-7（verification の印が無い）: 足りない印をすべて挙げる: ${cn.features['customization-generator'].lacking.length}`);
  //   契約に無い（entitlement に無い）生成は、印ではなく NOT_ENTITLED のまま（印の確認は使える機能にだけ掛ける）
  const notEnt = clone(K.HEALTH_V); notEnt.entitlements[0].features = ['assistant-qa', 'change-planner'];
  assert(cap(notEnt).features['customization-generator'].reason === KTAiClient.ERROR_CODES.NOT_ENTITLED, 'C1-8: 契約に無い機能の理由は NOT_ENTITLED のまま（印の確認はしない）');
});

console.log('\n--- §C2 画面: 会話の印が欠ける接続先では、依頼を送っても AI を呼ばない ---');
await section(async () => {
  const m = K.mount({ health: withoutQa('proposal') });
  await K.ticks();
  const status = m.$('kt-ai-paid-status').innerHTML;
  await m.panel.send('課長・部長の承認者を選ぶ運用にしたい'); await K.ticks(10);
  const text = K.stripC(m.chat()) + K.stripC(m.$('kt-ai-paid-status').innerHTML);
  assert(m.calls.propose.length === 0 && m.calls.plan.length === 0 && m.calls.ask.length === 0 && m.conv().draft() === null && m.conv().activePlan() === null && !/kt-ai-draft-card|kt-ai-plan-card/.test(m.chat()) && !m.mock.calls.some(c => /^(PUT|POST) /.test(c)),
    `C2-1: 仮案・計画・質問の AI を呼ばず、仮案・変更案のカードは出ず、書き込み 0: ${JSON.stringify({ propose: m.calls.propose.length, plan: m.calls.plan.length, ask: m.calls.ask.length, writes: m.mock.calls.filter(c => /^(PUT|POST) /.test(c)) })}`);
  assert(/この Toolkit に必要な機能に対応していません/.test(text) || /この Toolkit に必要な機能に対応していません/.test(K.stripC(status)), `C2-2: 理由の文（接続先が必要な機能に対応していない。版が古いとは言い切らない）が画面に出る: ${(text.match(/.{0,80}対応していません.{0,40}/) || [K.stripC(status).slice(0, 160)])[0]}`);
});

console.log('\n--- §C3 画面: 生成の印が欠ける接続先では、AI サービスを呼ばず、反映できる最終案にならない ---');
await section(async () => {
  const gen = K.screenGenerate({ field: 'case_name', targetFile: 'caseLock.js' });
  const m = K.mount({ health: withoutGen('registrationSelect'), planImpl: K.planImplOf(K.screenPlan('js')), generateImpl: gen.impl });
  await K.ticks();
  const v = await K.adoptOnScreen(m); await K.ticks(20);
  const ready = !!(v && v.final && m.conv().finalReadiness(v).ready);
  assert(m.calls.plan.length === 1 && gen.calls.length === 0 && !!v && ready === false && !m.mock.calls.some(c => c === 'PUT customize' || c === 'POST file'),
    `C3-1: 仮案の採用から計画までは進む（計画の AI 1 回）が、AI サービスは呼ばず（0 回）、反映できる最終案にならない・登録しない: ${JSON.stringify({ plan: m.calls.plan.length, gen: gen.calls.length, final: !!(v && v.final), ready, status: v && v.generated && v.generated.C1 && v.generated.C1.status })}`);
  //   独立レビュー（中 2）: 生成だけが使えないときの理由も契約の文（NOT_ENTITLED の文）ではなく、接続先の更新が必要という文
  const chat3 = K.stripC(m.chat());
  const e3 = v && v.generated && v.generated.C1;
  assert(e3 && e3.status === 'failed' && e3.failure && e3.failure.reason === 'CAPABILITY_OUTDATED' && /この Toolkit に必要な機能に対応していません/.test(chat3) && !/この契約では|契約内容を確認/.test(chat3),
    `C3-2: 生成を使えない理由は CAPABILITY_OUTDATED の文（契約の文にしない）: ${JSON.stringify({ failure: e3 && e3.failure, text: (chat3.match(/.{0,60}組み合わせて使えません.{0,30}/) || [])[0] })}`);
});

console.log('\n--- §C4 受け取り（KTAiClient.receive）: 契約の関所だけ。AI サービスの形をそのまま ---');
await section(async () => {
  const ver = { version: '1', bodyHash: '0123456789abcdef', passed: true, machine: [{ name: 'syntax', ok: true, severity: 'info', message: 'ok' }], requiredEffects: [{ requirementId: 'C1', requirementIds: ['C1'], field: 'amount', effect: 'lock', status: 'present', check: 'behavior', checkReason: 'conditional', checkReasons: ['conditional', 'nested'] }],
    behavior: { status: 'not-run', reason: 'unavailable', cases: [{ id: 'K1', requirementIds: ['C1'], field: 'amount', effect: 'lock', expect: 'lock', side: 'match', verdict: 'not-run', reason: 'existing-unrunnable', details: { files: [{ name: 'biz.js', kinds: ['network'], apis: ['kintone.api'] }], values: ['a'] } }], conditions: null, uncheckedScope: [{ key: 'k', text: '確かめない範囲' }], truncated: 3 }, repairs: { count: 0, reasons: [], stoppedBy: null, notRepaired: [{ reason: 'x', count: 0 }] } };
  const body = { ok: true, contractVersion: '2.1', meta: { requestId: 'g-1', usage: { usedThisMonth: 1, monthlyLimit: 20 }, normalization: { warnings: [{ code: 'W' }] }, ai: { model: 'm' }, budget: { allowanceUsd: 1 }, aiRepair: { usage: {} }, timing: { totalMs: 5 } },
    generated: { strategy: 'NEW_JS_FILE', targetFile: 'a.js', code: 'x', coverage: [{ requirementId: 'C1', status: 'MET', text: 't', note: '', limitCode: 'SUBTABLE_ROWS' }], patterns: 'bad', extraField: 1 }, verification: ver };
  const g = KTAiClient.receive('generated', body, { requestId: 'fallback' });
  assert(JSON.stringify(g.verification) === JSON.stringify(ver) && g.extraField === 1 && g.patterns === 'bad' && g.coverage[0].limitCode === 'SUBTABLE_ROWS' && g.requestId === 'g-1' && g.usage.monthlyLimit === 20 && g.gatewayWarnings.length === 1 && g.budgetMeta.allowanceUsd === 1 && g.aiRepair && g.timing.totalMs === 5 && g.clientWarnings.length === 0,
    `C4-1: 生成の応答は AI サービスの形をそのまま返す（白リスト・上限・派生の欄（fileKinds・conditionsNotRun・checkReason の配列化）は作らない）。meta は読み手の形に: ${JSON.stringify(Object.keys(g))}`);
  const thrown = (kind, r) => { try { KTAiClient.receive(kind, r); return null; } catch (e) { return `${e.code}:${e.message}`; } };
  assert(/INVALID_RESPONSE/.test(thrown('generated', { ...body, verification: { machine: [] } })) && /INVALID_RESPONSE/.test(thrown('generated', { ...body, generated: { ...body.generated, strategy: 'EXTEND_EXISTING_JS', patch: null } })) && /INVALID_RESPONSE/.test(thrown('generated', { ...body, generated: { strategy: 'NEW_JS_FILE', code: '' } })) && /UNSUPPORTED_CONTRACT_VERSION/.test(thrown('generated', { ...body, contractVersion: '9' })) && /INVALID_RESPONSE/.test(thrown('generated', null)) && /INVALID_RESPONSE/.test(thrown('proposal', { ok: true, contractVersion: '2.1', meta: {}, reply: 'r', proposal: {} })),
    'C4-2: 関所: 検証結果（machine・requiredEffects）が無い・統合なのに patch が無い・code が無い・契約の版が違う・応答が無い・仮案に turn が無い → AiClientError');
  //   独立レビュー（中 1）: 統合の本文（body）を合成できなかった正常な応答（Gateway は body null・機械検査の patch の block で ok:true）は関所を通し、形式確認の patch の確認で止める
  const noBody = KTAiClient.receive('generated', { ...body, generated: { ...body.generated, strategy: 'EXTEND_EXISTING_JS', patch: { baseHash: 'x', operations: [{ type: 'APPEND', content: 'y' }] }, body: null } });
  assert(noBody.body === null && noBody.strategy === 'EXTEND_EXISTING_JS', 'C4-2b: 統合で本文を合成できなかった応答（body null）は関所を通す（登録できないことは KTCodeReview の patch の確認が出す）');
  const p = KTAiClient.receive('plan', { ok: true, contractVersion: '2.1', meta: { requestId: 'p-1', decisions: { received: 1 }, revision: { mode: 'patch' }, requirements: { received: 2 } }, plan: { goal: 'g', assessment: { summary: 's' }, steps: [{ id: 'P1', validation: { status: 'invalid', issues: ['x'] } }], customizations: [{ customizationId: 'C1', implementation: 'SASS' }] }, turn: { requirementOps: [] } });
  assert(p.goal === 'g' && p.steps[0].validation.issues[0] === 'x' && p.customizations[0].implementation === 'SASS' && p.decisionsMeta.received === 1 && p.revisionMeta.mode === 'patch' && p.requirementsMeta.received === 2 && p.turn && p.gatewayPlan && p.gatewayPlan !== p && JSON.stringify(p.gatewayPlan.steps) === JSON.stringify(p.steps) && !Object.keys(p).includes('gatewayPlan'),
    'C4-3: 計画の応答は plan をそのまま（語彙外の値も読み直さない）。meta の決定事項・修正の方式・要件の受け取りを運び、gatewayPlan は列挙しない写し');
  const pr = KTAiClient.receive('proposal', { ok: true, contractVersion: '2.1', meta: { requestId: 'pp-1', proposalUnchanged: true }, reply: 'r', intent: 'question', adoptQuote: '', proposal: { behaviors: [{ id: 'B1', text: 'x', origin: 'suggestion' }] }, turn: { ops: [{ id: 'Q1', op: 'adopt' }] } });
  assert(pr.proposalUnchanged === true && pr.intent === 'question' && pr.proposal.behaviors[0].origin === 'suggestion' && pr.turn.ops.length === 1 && pr.adoptQuote === '', 'C4-4: 仮案の応答は仮案・turn・adoptQuote をそのまま（整理は AI サービスの validate-proposal-response）。proposalUnchanged は meta から');
  const a = KTAiClient.receive('answer', { ok: true, contractVersion: '2.1', meta: {}, answer: '本文 [E999]', facts: [{ text: 'f', evidenceIds: ['E999'] }], answerEvidenceIds: ['E999'] }, { requestId: 'q-1' });
  assert(a.answer === '本文 [E999]' && a.facts[0].evidenceIds[0] === 'E999' && a.requestId === 'q-1', 'C4-5: 回答の応答は本文・根拠 ID をそのまま（除去は AI サービスの validate-response）。meta に requestId が無ければ呼び出しの requestId');
  assert(!('validateGenerated' in KTAiClient) && !('normalizeVerification' in KTAiClient) && !('validatePlan' in KTAiClient) && !('validateProposal' in KTAiClient) && !('validateAnswer' in KTAiClient) && !('normalizeUpstream' in KTAiClient) && !('BEHAVIOR_CASES_MAX' in KTAiClient) && !('normalizeLegacyErrorCode' in KTAiClient),
    'C4-6: 入口の再検証・正規化・旧い符号の読み替えの口は無い');
});

console.log(`\n${state.failed ? 'FAILED' : 'PASS'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
