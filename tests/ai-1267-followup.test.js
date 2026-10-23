// §12.67（2026-10-23）: §12.66 の実機の 1 会話（staging・App 353・枠 nl-20261023）の素材で確かめた不具合の回帰テスト。
//   1. モバイルの生成の辞退（GENERATION_DECLINED）で、Gateway の detail にある説明（coverage の要件と状態・note・AI の要約 summary）を最終案まで落とさず届ける
//      （前は detail.reason（note をつないだ文）だけで、要件・状態・summary が表示に出なかった）。応答に無い説明は補わない
//   2. 統合（EXTEND_EXISTING_JS）で統合後の本文が既存の本文と同じ JavaScript は「変更なし」（検証は通っている・登録しない）。
//      前は「できた（検証済み）」「既存の「dealLock.js」に統合」と出し、同じ内容への置き換え（REPLACE_FILE）の登録に進んだ
//   3. 最終案の詳細の費用は、集計の区間（採用から最終案まで）を書き、Gateway の費用の記録（meta.budget / error.detail.budget。台帳と同じ記録）があればそれで出す。
//      前は辞退の呼び出し（token の内訳なし・費用は error.detail.budget にある）を「使用量が不明・費用は未確定」と数え、見出し（台帳）と食い違って見えた
//   4. Health の見出しに「運用環境の設定」（仮案の作業の基準は動作テスト環境。件数の違いは正常な違い）
// 実行方法: node tests/ai-1267-followup.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const FS = require('./helpers/final-state.js');
const { createNewFlowKit } = require('./helpers/new-flow.js');
const T2 = loadToolkit();
const { KTScan, KTCodeReview, KTAiClient, KTAiConversation, KTAiChatUi, KTJsExecutor } = T2;
const { assert, state } = makeAssert();
const K = createNewFlowKit(T2);
const { makeConvC, makeGenerate, planJs, custOf, adoptC, finalHtml, stripC, DATA_C, ST_C, clone } = K;

(async () => {
// =========================================================
console.log('\n--- 1. 辞退の説明: Gateway の detail（coverage の要件と状態・note・AI の要約）を落とさない ---');
{
  const NOTE = '明細行の追加・削除を防ぐ制約は、合意済みの「明細行の追加・削除は防がない」と矛盾するため実装しません';
  const SUMMARY = '既存の mobile-approved-field-lock.js が承認済みの金額と明細セルの編集不可を実装済みのため、変更を作りませんでした。';
  const REQ = '承認済みのモバイル編集画面で金額と明細セルを編集不可にし、明細行の追加・削除は防がない';
  const eOf = (detail) => ({ details: { error: { code: 'GENERATION_DECLINED', detail } } });
  const t1 = KTAiClient.declineReasonOf(eOf({ reason: NOTE, coverage: [{ requirementId: 'C2', requirement: REQ, status: 'PARTIAL', note: NOTE }], warnings: [], summary: SUMMARY }));
  assert(t1 === `「${REQ}」は一部だけ満たす: ${NOTE}／AI の要約: ${SUMMARY}`, `1-1 要件・状態（一部だけ満たす）・note・AI の要約を「／」でつなぐ: ${t1}`);
  const t2 = KTAiClient.declineReasonOf(eOf({ reason: NOTE, coverage: [{ requirement: REQ, status: 'NOT_MET', note: NOTE }], warnings: [] }));
  assert(t2 === `「${REQ}」は満たせない: ${NOTE}`, `1-2 summary が無ければ「AI の要約」を作らない（応答に無い説明は補わない）: ${t2}`);
  const t3 = KTAiClient.declineReasonOf(eOf({ reason: 'items が許可されたフィールドに無いため実装できません', coverage: [], warnings: [] }));
  assert(t3 === 'items が許可されたフィールドに無いため実装できません', `1-3 coverage に note が無ければ従来の reason: ${t3}`);
  assert(KTAiClient.declineReasonOf(eOf({ reason: '', coverage: [{ requirement: REQ, status: 'PARTIAL', note: '' }], warnings: [] })) === null
    && KTAiClient.declineReasonOf({ details: { error: { code: 'GENERATION_DECLINED' } } }) === null && KTAiClient.declineReasonOf(null) === null,
    '1-4 説明が何も無ければ null（もっともらしい説明を補わない）');
  const long = KTAiClient.declineReasonOf(eOf({ reason: NOTE, coverage: [{ requirement: REQ, status: 'PARTIAL', note: 'あ'.repeat(400) }], summary: 'い'.repeat(400) }));
  assert(typeof long === 'string' && long.length <= 600 && long.includes('あ'.repeat(300)) && !long.includes('あ'.repeat(301)) && /AI の要約: い+$/.test(long), `1-5 note は 300 字・summary は 300 字・全体は 600 字で切る: ${long && long.length}`);
  const many = KTAiClient.declineReasonOf(eOf({ reason: 'r', coverage: Array.from({ length: 6 }, (_, i) => ({ requirement: `R${i + 1}`, status: 'NOT_MET', note: `n${i + 1}` })) }));
  assert(typeof many === 'string' && many.split('／').length === 4 && many.includes('「R4」は満たせない: n4') && !many.includes('n5'), `1-6 coverage は先頭 4 件まで: ${many}`);
}

// =========================================================
console.log('\n--- 2. 統合後の本文が既存と同じ JavaScript: 登録する変更は無い（KTJsExecutor.changeFromGenerated）---');
const EXISTING = `(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (${ST_C}) record['amount'].disabled = true;\n    return event;\n  });\n})();\n`;
const SNIPPET = `    if (${ST_C}) record['amount'].disabled = true;`;
const SRC = { name: 'lock.js', target: 'desktop', text: EXISTING };
const CUST_X = custOf(['lock'], { strategy: 'EXTEND_EXISTING_JS', existingFiles: [{ name: 'lock.js', target: 'desktop', reason: '同じ画面で金額を既に制御しているため統合する' }] });
//   §12.66 の PC の生成と同じ形: patch は同じ内容への置き換え（REPLACE）で、生成工程が合成した本文（body）は既存と同じ
const genSame = () => ({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'lock.js', summary: '既存の編集不可の処理を維持します。', code: SNIPPET, patch: { baseHash: KTScan.hashText(EXISTING), operations: [{ type: 'REPLACE', anchor: SNIPPET, content: SNIPPET }] }, body: EXISTING, events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: ['kintone.events.on'], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '' }] });
const ADDED = "    record['amount'].error = null;";
const BODY_DIFF = EXISTING.replace('    return event;', `${ADDED}\n    return event;`);
const genDiff = () => ({ ...genSame(), summary: '金額のエラー表示を消します。', code: ADDED, patch: { baseHash: KTScan.hashText(EXISTING), operations: [{ type: 'INSERT_BEFORE', anchor: '    return event;', content: ADDED }] }, body: BODY_DIFF });
{
  const reviewOf = (g) => KTCodeReview.review({ generated: g, customization: CUST_X, plan: null, data: clone(DATA_C), scan: null, existingSource: SRC });
  const same = KTJsExecutor.changeFromGenerated({ customization: CUST_X, generated: genSame(), review: reviewOf(genSame()), existingSource: SRC });
  assert(same && same.ok === false && same.reason === 'JS_UNCHANGED' && same.unchanged === true && same.name === 'lock.js' && /統合後の本文が既存と同じ/.test(same.message), `2-1 同じ本文 → JS_UNCHANGED（登録する変更を作らない）: ${JSON.stringify(same)}`);
  const diff = KTJsExecutor.changeFromGenerated({ customization: CUST_X, generated: genDiff(), review: reviewOf(genDiff()), existingSource: SRC });
  assert(diff && diff.ok === true && diff.change && diff.change.kind === 'REPLACE_FILE' && diff.change.name === 'lock.js' && diff.change.content === BODY_DIFF && diff.change.baseHash === KTScan.hashText(EXISTING), `2-2 本文が違えば今までどおり既存ファイルの更新（REPLACE_FILE）: ${JSON.stringify(diff && diff.ok ? [diff.change.kind, diff.change.name] : diff)}`);
  const blocked = KTJsExecutor.changeFromGenerated({ customization: CUST_X, generated: genSame(), review: { ...reviewOf(genSame()), status: KTCodeReview.STATUS.BLOCKED }, existingSource: SRC });
  assert(blocked && blocked.ok === false && blocked.reason === 'CODE_REVIEW_BLOCKED', `2-3 同じ本文でも形式確認で採用不可なら、その理由が先（変更なしで隠さない）: ${blocked && blocked.reason}`);
  const noSrc = KTJsExecutor.changeFromGenerated({ customization: CUST_X, generated: genSame(), review: reviewOf(genSame()), existingSource: null });
  assert(noSrc && noSrc.ok === false && noSrc.reason === 'JS_SOURCE_UNAVAILABLE', `2-4 統合先の本文が無ければ今までどおり JS_SOURCE_UNAVAILABLE: ${noSrc && noSrc.reason}`);
}

// =========================================================
console.log('\n--- 3. 会話: 統合後の本文が既存と同じ JavaScript は「変更なし」（検証済み・登録しない）。反映する変更が無ければボタンを出さない ---');
{
  const run = async (generatedOf, sequence = ['good']) => {
    const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_X, summary: '承認待ちでは金額を編集不可にします。' }), generate: makeGenerate({ sequence, existingSource: SRC, generatedOf }) });
    await adoptC(x);
    const v = x.c.activePlan();
    const html = finalHtml(x);
    return { x, v, e: v.generated.C1, fin: v.final, html, text: stripC(html) };
  };
  const s = await run(genSame);
  assert(s.e && s.e.status === 'verified' && s.e.unchanged === true && s.e.verification && s.e.verification.bound === true,
    `3-1 検証は通り（bound）、統合後の本文が既存と同じなので unchanged: ${JSON.stringify({ status: s.e && s.e.status, unchanged: s.e && s.e.unchanged, bound: s.e && s.e.verification && s.e.verification.bound, verdict: s.e && s.e.verdict })}`);
  const fc = s.fin && Array.isArray(s.fin.customizations) ? s.fin.customizations.find(c => c.customizationId === 'C1') : null;
  assert(fc && fc.status === 'verified' && fc.unchanged === true && fc.targetFile === 'lock.js', `3-2 最終案の記録（fin.customizations）に unchanged: ${JSON.stringify(fc)}`);
  const rows = KTAiChatUi.impactRowsOf(s.fin);
  assert(rows.some(r => r === '「lock.js」は変更なし（統合後の本文が既存と同じため登録しません）') && !rows.some(r => /既存の「lock\.js」に統合/.test(r)), `3-3 右の反映先: 「lock.js」は変更なし（「既存に統合」と言わない）: ${JSON.stringify(rows)}`);
  const summary = stripC(KTAiChatUi.changeSummaryHtml(s.v, {}));
  assert(/できた（検証済み・既存の本文と同じため登録しません）/.test(summary), '3-4 右の「変更内容」の JavaScript の状態: できた（検証済み・既存の本文と同じため登録しません）');
  //   会話だけ（画面の準備の照合が無い）の状態の行は「反映の前の準備を待っています…」のまま。反映の注（APPLY_NOTE）とボタンの有無で確かめる
  assert(!/data-act="final-approve"/.test(s.html) && /反映する変更はありません（設定の変更なし。JavaScript は統合後の本文が既存と同じため登録しません）。/.test(s.text) && !/承認すると動作テスト環境へ JavaScript を反映します/.test(s.text),
    `3-5 最終案のカード: ［動作テスト環境へ反映］を出さず「反映する変更はありません」（「承認すると JavaScript を反映します」と言わない）: ${s.text.split('\n').filter(l => /反映/.test(l)).join(' | ').slice(0, 300)}`);
  assert(FS.readyOf(s.v) === true && !(s.fin.cannot || []).length, `3-6 判定は変えない（検証済み・反映できない点は無い。採用内容や検証を弱めていない）: ${JSON.stringify({ ready: FS.readyOf(s.v), cannot: s.fin.cannot })}`);
  const ex = KTJsExecutor.changeFromGenerated({ customization: s.e.customization, generated: s.e.generated, review: s.e.review, existingSource: s.e.existingSource });
  assert(ex && ex.ok === false && ex.reason === 'JS_UNCHANGED', `3-7 この版の生成結果から登録の変更を作っても JS_UNCHANGED（同じ比較）: ${ex && ex.reason}`);
  const d = await run(genDiff);
  const dSummary = stripC(KTAiChatUi.changeSummaryHtml(d.v, {}));
  assert(d.e && d.e.status === 'verified' && d.e.unchanged === false && /data-act="final-approve"/.test(d.html) && /承認すると動作テスト環境へ JavaScript を反映します/.test(d.text) && !/反映する変更はありません/.test(d.text)
    && KTAiChatUi.impactRowsOf(d.fin).some(r => /既存の「lock\.js」に統合/.test(r)) && /できた（検証済み）/.test(dSummary) && !/登録しません/.test(dSummary),
    `3-8 本文が違えば今までどおり（統合の行・反映のボタンと注）: ${JSON.stringify({ unchanged: d.e && d.e.unchanged, rows: KTAiChatUi.impactRowsOf(d.fin), ready: FS.readyOf(d.v), lines: d.text.split('\n').filter(l => /反映/.test(l)).join(' | ').slice(0, 200) })}`);
  // 独立レビュー 中-1（2026-10-23）: 本文が既存と同じでも、検証に通っていなければ「変更なし」にしない（未解決の理由が先。登録しない理由を 2 つ並べない）
  const u = await run(genSame, ['bad']);
  const uRows = KTAiChatUi.impactRowsOf(u.fin), uSummary = stripC(KTAiChatUi.changeSummaryHtml(u.v, {}));
  const uFin = u.fin && Array.isArray(u.fin.customizations) ? u.fin.customizations.find(c => c.customizationId === 'C1') : null;
  assert(u.e && u.e.status !== 'verified' && u.e.unchanged === false && uFin && uFin.unchanged === false
    && !uRows.some(r => /変更なし/.test(r)) && uRows.some(r => /既存の「lock\.js」に統合/.test(r)) && !/登録しません/.test(uSummary)
    && /data-act="final-approve"/.test(u.html) && !/反映する変更はありません/.test(u.text) && FS.readyOf(u.v) === false,
    `3-9 本文が既存と同じでも検証に通っていなければ「変更なし」にしない（未解決の理由が先・ボタンは従来どおり）: ${JSON.stringify({ status: u.e && u.e.status, unchanged: u.e && u.e.unchanged, rows: uRows })}`);
  // 独立レビュー 中-2: 変更なし（検証済み）1 件＋未完成 1 件の混在では「反映する変更はありません」と言わない（従来の止める理由とボタン）。本当の変更との混在は変更なしの行と登録の行が並ぶ
  const CUST_Y = custOf(['lock'], { customizationId: 'C2', requirement: '承認待ちでは作成画面でも金額を編集不可にする', events: ['app.record.create.show'] });
  const NEW_CODE = `(function () {\n  'use strict';\n  kintone.events.on(['app.record.create.show'], function (event) {\n    const record = event.record;\n    if (${ST_C}) record['amount'].disabled = true;\n    return event;\n  });\n})();\n`;
  const genNew = () => ({ strategy: 'NEW_JS_FILE', targetFile: 'lock2.js', summary: '作成画面でも編集不可にします。', code: NEW_CODE, patch: null, events: ['app.record.create.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: ['kintone.events.on'], assumptions: [], warnings: [], coverage: [{ requirementId: 'C2', status: 'MET', note: '' }] });
  const planTwo = (args) => {
    const r = planJs(args, { cust: CUST_X, summary: '承認待ちでは金額を編集不可にします。' });
    r.plan.steps.push({ id: 'C2', actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: null, title: 'JavaScript 2', spec: { customizationId: 'C2' }, dependsOn: [] });
    r.plan.customizations.push(clone(CUST_Y));
    r.review.steps.push({ stepId: 'C2', status: 'VALID', safety: 'PLAN_ONLY', customization: clone(CUST_Y), codeGeneration: { supported: true, strategy: 'NEW_JS_FILE', reason: null }, issues: [] });
    return r;
  };
  const runTwo = async (sequence) => {
    const x = makeConvC({ planImpl: planTwo, generate: makeGenerate({ sequence, existingSource: SRC, generatedOf: (cust) => (cust.customizationId === 'C1' ? genSame() : genNew()) }) });
    await adoptC(x);
    const v = x.c.activePlan();
    const html = finalHtml(x);
    return { x, v, fin: v.final, html, text: stripC(html), rows: KTAiChatUi.impactRowsOf(v.final) };
  };
  const mb = await runTwo(['good', 'bad']);
  assert(mb.v.generated.C1 && mb.v.generated.C1.status === 'verified' && mb.v.generated.C1.unchanged === true && mb.v.generated.C2 && mb.v.generated.C2.status !== 'verified' && FS.readyOf(mb.v) === false
    && /data-act="final-approve"/.test(mb.html) && !/反映する変更はありません/.test(mb.text) && mb.rows.some(r => r === '「lock.js」は変更なし（統合後の本文が既存と同じため登録しません）') && mb.rows.some(r => /lock2\.js/.test(r)),
    `3-10 変更なし 1 件＋未完成 1 件: 「反映する変更はありません」と言わず、従来の止める理由とボタン: ${JSON.stringify({ c2: mb.v.generated.C2 && mb.v.generated.C2.status, rows: mb.rows, lines: mb.text.split('\n').filter(l => /反映/.test(l)).join(' | ').slice(0, 200) })}`);
  const mg = await runTwo(['good', 'good']);
  const g1 = mg.v.generated.C1, g2 = mg.v.generated.C2;
  const exC1 = KTJsExecutor.changeFromGenerated({ customization: g1.customization, generated: g1.generated, review: g1.review, existingSource: g1.existingSource });
  const exC2 = KTJsExecutor.changeFromGenerated({ customization: g2.customization, generated: g2.generated, review: g2.review, existingSource: null, existingNames: ['lock.js'] });
  assert(g1.unchanged === true && g2.status === 'verified' && g2.unchanged === false && FS.readyOf(mg.v) === true
    && /data-act="final-approve"/.test(mg.html) && /承認すると動作テスト環境へ JavaScript を反映します/.test(mg.text) && !/反映する変更はありません/.test(mg.text)
    && mg.rows.some(r => r === '「lock.js」は変更なし（統合後の本文が既存と同じため登録しません）') && mg.rows.some(r => /新しい JavaScript「lock2\.js」を登録/.test(r))
    && exC1 && exC1.reason === 'JS_UNCHANGED' && exC2 && exC2.ok === true && exC2.change.kind === 'ADD_FILE',
    `3-11 変更なし 1 件＋本当の変更 1 件: 変更なしの行と登録の行が並び、ボタンと注は JavaScript の反映・登録の変更は本当の変更だけ: ${JSON.stringify({ rows: mg.rows, c1: exC1 && exC1.reason, c2: exC2 && exC2.ok && exC2.change.kind })}`);
}

// =========================================================
console.log('\n--- 4. 最終案の使用量（finalUsageOf）: Gateway の費用の記録がある呼び出しは、その費用で数える ---');
{
  const U = KTAiConversation.finalUsageOf;
  const plan = { kind: 'plan', end: 'ok', ai: { inputTokens: 58207, outputTokens: 6389 }, gatewayCostUsd: 0.141318, ms: 98000 };
  const genDeclined = { kind: 'generate', end: 'error', code: 'GENERATION_DECLINED', gatewayCostUsd: 0.036372, ms: 20000 };
  const u1 = U({ calls: [plan, genDeclined], asides: [], aiCalls: 2 });
  assert(u1.sentCalls === 2 && u1.measured === 1 && u1.usageUnknown === 1 && u1.costUnknown === 0 && u1.gatewayCostCalls === 2 && u1.gatewayCostUsd === 0.17769 && u1.tokens.input === 58207 && u1.tokens.output === 6389,
    `4-1 計画（token あり）＋辞退（token なし・Gateway の費用あり）: 費用は 2 回とも確定（costUnknown 0）: ${JSON.stringify(u1)}`);
  const u2 = U({ calls: [plan, { ...genDeclined, gatewayCostUsd: undefined }], asides: [], aiCalls: 2 });
  assert(u2.usageUnknown === 1 && u2.costUnknown === 1 && u2.gatewayCostCalls === 1 && u2.gatewayCostUsd === 0.141318, `4-2 Gateway の費用の記録が無い辞退は、今までどおり費用も不明: ${JSON.stringify({ usageUnknown: u2.usageUnknown, costUnknown: u2.costUnknown, calls: u2.gatewayCostCalls })}`);
  const genOk = { kind: 'generate', end: 'ok', repairs: 0, genEstimate: { measured: true, input: 15410, output: 841, costUsd: 0.0392 }, gatewayCostUsd: 0.03923 };
  const u3 = U({ calls: [plan, genOk, genDeclined], asides: [], aiCalls: 3 });
  assert(u3.sentCalls === 3 && u3.measured === 2 && u3.usageUnknown === 1 && u3.costUnknown === 0 && u3.gatewayCostCalls === 3 && u3.gatewayCostUsd === 0.21692 && u3.tokens.input === 58207 + 15410,
    `4-3 §12.66 の形（計画 1・生成の成功 1・辞退 1）: 確認できた token は 2 回分、費用は 3 回とも Gateway の記録: ${JSON.stringify({ gw: u3.gatewayCostUsd, calls: u3.gatewayCostCalls, unknown: [u3.usageUnknown, u3.costUnknown] })}`);
  const u4 = U({ calls: [plan], asides: [{ kind: 'ask', pending: true }], aiCalls: 3 });
  assert(u4.sentCalls === 3 && u4.usageUnknown === 2 && u4.costUnknown === 2 && u4.gatewayCostCalls === 1, `4-4 回答待ちの質問・記録の無い呼び出しは費用も不明に数える: ${JSON.stringify({ sent: u4.sentCalls, unknown: [u4.usageUnknown, u4.costUnknown] })}`);
}

// =========================================================
console.log('\n--- 5. 会話: 計画の応答に Gateway の費用の記録・生成は辞退（PARTIAL・summary・budget）→ 最終案の詳細と「反映できない点」 ---');
{
  const GCTX = { contextVersion: 'customization-1', customization: { customizationId: 'C1', strategy: 'NEW_JS_FILE' } };
  const reply = (status, body) => async () => ({ status, body: JSON.stringify(body) });
  const aiClient = (transport) => KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 't.cybozu.com', transport, timeoutMs: 150 });
  const budgetOf = (spentUsd, calls) => ({ allowanceUsd: 0.5, spentUsd, complete: true, calls });
  const NOTE = '明細行の追加・削除を防ぐ制約は、合意済みの「明細行の追加・削除は防がない」と矛盾するため実装しません';
  const SUMMARY = '既存の JavaScript が承認済みの金額と明細セルの編集不可を実装済みのため、変更を作りませんでした。';
  const REQ = '承認済みのモバイル編集画面で金額と明細セルを編集不可にし、明細行の追加・削除は防がない';
  const detailOf = (withBudget) => ({ reason: NOTE, coverage: [{ requirementId: 'C1', requirement: REQ, status: 'PARTIAL', note: NOTE }], warnings: [], summary: SUMMARY, ...(withBudget ? { budget: budgetOf(0.036372, [{ kind: 'generate', boundUsd: 0.2, costUsd: 0.036372 }]) } : {}) });   // 本物の Gateway は AI を呼んだ時点で calls に 1 件積む（独立レビュー 軽-7）
  const run = async (withBudget) => {
    const planImpl = (args) => { const r = planJs(args); r.plan.ai = { model: 'm', usage: { input_tokens: 58207, output_tokens: 6389 } }; if (withBudget) r.plan.budgetMeta = budgetOf(0.141318, [{ kind: 'plan', boundUsd: 0.3, costUsd: 0.141318 }]); return r; };
    //   本物の services.generate と同じく、送った要求の失敗には呼び出しの記録（callTrace。tagCallError）を付ける（無いと会話は「送る前の失敗（notSent）」と数える）
    const gen = { calls: [], impl: async () => {
      try { await aiClient(reply(422, { ok: false, contractVersion: '2.1', error: { code: 'GENERATION_DECLINED', message: 'GENERATION_DECLINED', requestId: 'gen-d', detail: detailOf(withBudget) } })).generate({ ctx: GCTX, requestId: 'gen-d' }); }
      catch (e) { if (e && typeof e === 'object' && !e.callTrace) e.callTrace = { requestId: 'gen-d', limitMs: 150, transport: null, via: 'direct', progress: null }; throw e; }
      throw new Error('unreachable');
    } };
    const x = makeConvC({ planImpl, generate: gen });
    await adoptC(x);
    const v = x.c.activePlan();
    const all = stripC(finalHtml(x));
    return { x, v, e: v.generated.C1, usage: v.final.usage, line: all.split('\n').find(s => /AI の呼び出し/.test(s)) || '', all };
  };
  const a = await run(true);
  assert(a.e && a.e.status === 'failed' && a.e.failure && a.e.failure.reason === 'GENERATION_DECLINED' && a.e.failure.aiReason === `「${REQ}」は一部だけ満たす: ${NOTE}／AI の要約: ${SUMMARY}`,
    `5-1 辞退の記録: AI の説明に要件・状態（一部だけ満たす）・note・AI の要約: ${JSON.stringify(a.e && a.e.failure)}`);
  assert(a.all.includes('一部だけ満たす') && a.all.includes(`AI の要約: ${SUMMARY}`) && /AI はこの依頼に対するコード生成を行いませんでした/.test(a.all) && FS.readyOf(a.v) === false,
    '5-2 最終案のカードの「反映できない点」に同じ説明が出る（辞退を合格に変えない）');
  assert(a.usage && a.usage.gatewayCostCalls === 2 && a.usage.gatewayCostUsd === 0.17769 && a.usage.costUnknown === 0 && a.usage.usageUnknown === 1, `5-3 使用量: 2 回とも Gateway の費用の記録（0.141318 + 0.036372）: ${JSON.stringify(a.usage)}`);
  assert(a.line === '採用から最終案までの AI の呼び出し 2 回（内部を含め最大 4 回）。うち 1 回は token の内訳が分かりません（費用は Gateway の記録で確定）。確認できた分 入力 58207 / 出力 6389 トークン・費用 約 0.1777 米ドル（Gateway の記録）',
    `5-4 最終案の詳細: 区間（採用から最終案まで）・token の内訳が無い回・費用は Gateway の記録（表示は見出しと同じ 4 桁。集計の値は 0.17769）: ${a.line}`);
  const b = await run(false);
  assert(b.usage && b.usage.gatewayCostCalls === 0 && b.usage.costUnknown === 1
    && b.line === '採用から最終案までの AI の呼び出し 2 回（内部を含め最大 4 回）。うち 1 回は使用量が不明のため、費用は未確定です。確認できた分 入力 58207 / 出力 6389 トークン・約 0.1803 米ドル（キャッシュの割引なし）',
    `5-5 Gateway の費用の記録が無ければ今までどおり「使用量が不明・費用は未確定」: ${b.line}`);
}

// =========================================================
console.log('\n--- 6. Health の見出し ---');
{
  const src = fs.readFileSync(process.env.KT_SRC || path.join(__dirname, '..', 'kintoneAppToolkit.user.js'), 'utf8');
  assert(src.includes('App Health <span style="opacity:.7;font-weight:400">(Read-only・運用環境の設定)</span>'), '6-1 Health の見出しに「運用環境の設定」（仮案の作業の基準は動作テスト環境。件数の違いは正常な違い）');
}

console.log(`\n${state.failed === 0 ? 'ALL PASSED' : 'FAILED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
