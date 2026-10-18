// 会話と提案を人が判断できる形にする（2026-10-14 の指示書 §7 の 1〜8。有料の AI は使わない）
//
// 検証内容:
//   §H1 仮案のカード（左）は AI の返答と選択だけ。実現する動作・任意の提案・こちらの提案で進める点・決めたこと・回答欄は右の「変更内容」の仮案の詳細にあり、
//        右の回答欄で答えると決定事項（台帳）に記録してから仮案の AI へ送る（既存の経路）
//   §H2 採用の直後: 「この案で進めます…」の別の文は無く、進みのカードの見出しは「この案で最終案を作っています」（JavaScript の無い計画は「この案で設定の最終案を作っています」）。
//        段階の名前は作っているものの名前（計画を作っています → 計画を作りました → 「{手順の title}」を作っています）。「kintone にはまだ何も反映していません」は進みのカードに 1 回だけ
//   §H3 作成途中（C1・C2 検証済み・C3 時間切れ）: 見出し「作成途中」、できたもの・止めたもの・理由・残り 1 件・［残りの JavaScript を作る］。理由は 1 回だけ。
//        「最終案を直しました」「変わった点」「検証の区分」は無い。右の「変更内容」に JavaScript の状態（できた・できた・作成中）。上限で止めたときはボタン無効と文。
//        押すと計画の AI 0 回で C3 だけ作り、承認できる最終案になる（判定は変えない）
//   §H4 完成した最終案（3 本とも検証済み）: 反映できるかの 1 文（「この内容で反映できます。」は承認の欄の準備が整ったときだけ）→ この案で実現すること（採用した仮案の動作・既存の設定の変更）
//        → この案の制約（行の追加・削除）→ 仮案からの補足（計画の返答・計画で決めた点。無ければ見出しごと出さない）→ 残る判断（先に決めたいことだけ）→ ボタンと反映先の文 →
//        反映の前の確認は折りたたみ。検証の明細・反映先と主な影響・変わった点・「まだ何も反映していません」は左に無く、右の「変更内容」に（確かめたこと 1 行＋明細。実機未確認は 1 回）
//   §H5 止める根拠の維持: 模擬テスト不合格は承認できないまま、理由と次の方針が「確認できないこと／反映を止めている理由」に出る。移植元の本文を渡せないときは「確かめられません」（不可能と書かない）
//   §H6 原因の分類: 生成していない JavaScript の効果の行は「まだ作っていません」（not-generated）。接続先が本当に非対応（effectsCapable false）のときだけ「接続先が確認に非対応」
//   §H7 別の短い依頼（設定の変更だけ。画面）: 仮案は返答と選択、最終案に JavaScript の状態・制約の節が無く、「この内容で反映できます。」と反映先の文、質問の重複が無い
//   §H8 すべての新しい文（左の通常表示・右の「変更内容」）に内部の語（INTERNAL_IN_CHAT）が無い
//
// 実行方法: node tests/ai-human-readable.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
//   簡素化（2026-10-17）: 反映できるかは、最新の版なら会話の今の判定、前の版なら最終案の記録で確かめる（tests/helpers/final-state.js）
const FS = require('./helpers/final-state.js');
const { gwCandidateHash } = require('./helpers/gw-hash.js');
const T = loadToolkit();
const { KTAiConversation, KTAiChatUi, KTAiClient } = T;
const { assert, state } = makeAssert();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { ticks, clone, makeConvC, makeGenerate, stripC, finalHtml, gateMk, B, A } = K;
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
const I = KTAiConversation.INTENT;
// tests/ai-two-pane.test.js の INTERNAL_IN_CHAT と同じ（内部の番号・処理の通知）
const INTERNAL_IN_CHAT = /\bv[0-9]+\b|requestId|\bR[0-9]+「|\bQ[0-9]+[：:]|\[E[0-9]+\]|［\s*E[0-9]+|【\s*E[0-9]+|\[\s*E[0-9]+\s*[・、,]|Toolkit Review|Code Review|VERIFIED|snapshot|受け付けました|台帳|を検証しました|kt-ai-who">(Toolkit|SYSTEM)</;
const outsideDetails = (html) => String(html).replace(/<details[\s\S]*?<\/details>/g, '');
const visible = (html) => stripC(outsideDetails(html));
const count = (s, re) => (String(s).match(re) || []).length;

// ---- 部品: 計画の手順に業務の名前（title）を付けた 3 本の JavaScript（PC の編集制御・モバイルの編集制御・モバイルの入力チェック）----
const TITLES = { C1: 'PCの編集制御', C2: 'モバイルの編集制御', C3: 'モバイルの入力チェック' };
const CUST = { C1: K.custOf(['lock']), C2: K.custOf(['lock'], { customizationId: 'C2', requirement: '承認済みではモバイルでも金額を編集不可にする' }), C3: K.custOf(['lock'], { customizationId: 'C3', requirement: 'モバイルの入力チェックを残す' }) };
const planJs3 = (args) => {
  const r = K.planJs(args, { cust: CUST.C1 });
  r.plan.steps[0].title = TITLES.C1;
  for (const cid of ['C2', 'C3']) {
    r.plan.steps.push({ id: cid, actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: null, title: TITLES[cid], spec: { customizationId: cid }, dependsOn: [] });
    r.plan.customizations.push(clone(CUST[cid]));
    r.review.steps.push({ stepId: cid, status: 'VALID', safety: 'PLAN_ONLY', customization: clone(CUST[cid]), codeGeneration: { supported: true, strategy: 'NEW_JS_FILE', reason: null }, issues: [] });
    r.review.executionReadiness.planOnlySteps.push(cid);
  }
  return r;
};
const planJs1 = (args) => { const r = K.planJs(args, { cust: CUST.C1 }); r.plan.steps[0].title = TITLES.C1; return r; };
const aiErr = (code) => new KTAiClient.AiClientError({ code, message: `テスト: ${code}` });
/** 偽の生成工程（cid ごとの振る舞い。'good' = 検証済み / 'throw:<code>' = その code を投げる / 'gate' = gates[cid] が開くまで待つ）。ai-realrun-abort の stagedGenerate と同じ作法 */
function stagedGenerate(plan, { gates = {} } = {}) {
  const base = makeGenerate({ sequence: ['good'] });
  const seen = [], n = {};
  const impl = async (args) => {
    const cid = args.customizationId;
    n[cid] = (n[cid] || 0) + 1;
    const list = plan[cid] || ['good'];
    const what = list[Math.min(n[cid] - 1, list.length - 1)];
    seen.push({ cid, what });
    if (/^throw:/.test(what)) throw aiErr(what.slice(6));
    if (what === 'gate') await gates[cid].p;
    return base.impl(args);
  };
  return { impl, calls: base.calls, seen, count: (cid) => seen.filter(x => x.cid === cid).length };
}
const sendUntilAdopt = async (x) => { for (const s of K.REQUESTS.slice(0, 3)) await x.c.send(s); return x.c.send(K.REQUESTS[3]); };
const pressRest = (x) => x.c.send('コードを作って', { intentOverride: I.GENERATE_CODE, displayText: '残りの JavaScript を作る' });
const restButtonOf = (h) => { const m = /<button[^>]*data-act="choice"[^>]*data-intent="GENERATE_CODE"[^>]*>([^<]*)<\/button>/.exec(h); return m ? { html: m[0], disabled: /\sdisabled/.test(m[0]) } : null; };

(async () => {
// =========================================================
console.log('\n--- §H1. 仮案のカード（左）は AI の返答と選択だけ。動作・判断・前提・決めたこと・回答欄は右 ---');
await section(async () => {
  const m = K.mount();
  await ticks();
  await m.panel.send('課長・部長の承認者を選ぶ運用にしたい'); await ticks(10);
  const chat = m.chat(), sum = m.$('kt-ai-change-summary').innerHTML;
  const card = (chat.match(/<div class="kt-ai-card kt-ai-draft-card[\s\S]*?data-act="draft-reject"[\s\S]*?<\/div>/) || [''])[0];
  assert(card && /仮案ができました。/.test(card) && /課長と部長を申請ごとに選んで承認する流れにできます/.test(card) && /data-act="draft-adopt"[^>]*>採用</.test(card) && /data-act="draft-partial"[^>]*>一部採用</.test(card) && /data-act="draft-reject"[^>]*>不採用</.test(card) && /返事や質問は、そのまま入力欄に書いてください。/.test(card), `H1-1: 左は見出し・AI の返答・［採用］［一部採用］［不採用］・自由入力の案内 1 行: ${stripC(card).replace(/\s+/g, ' ').slice(0, 300)}`);
  const LEFT_NG = /実現する動作|判断が必要な点|必要な判断|こちらの提案で進める点|任意の提案|決めたこと|対応できない範囲|まだ何も反映していません|data-dkey=|data-act="draft-answer"/;
  assert(!LEFT_NG.test(chat), `H1-2: 左に動作の一覧・判断・前提・任意の提案・決めたこと・回答欄・「まだ何も反映していません」は無い: ${(chat.match(LEFT_NG) || [''])[0]}`);
  assert(/必要な判断（1 件）/.test(sum) && /部長承認は金額に関係なく常に必要ですか/.test(sum) && /先に必要/.test(sum) && /おすすめ：一定金額以上のときだけ/.test(sum) && /class="kt-ai-qa-input kt-ai-draft-input" data-dkey="/.test(sum) && /data-act="draft-answer"[^>]*>回答を送る</.test(sum) && /実現する動作/.test(sum) && /こちらの提案で進める点/.test(sum) && /申請時に課長と部長の承認者をユーザー選択で指定する/.test(sum), `H1-3: 右の「変更内容」の仮案の詳細に必要な判断（回答欄と［回答を送る］）・実現する動作・こちらの提案で進める点: ${stripC(sum).replace(/\s+/g, ' ').slice(0, 300)}`);
  assert(!INTERNAL_IN_CHAT.test(outsideDetails(chat).replace(/data-[a-z]+="[^"]*"/g, '')) && !INTERNAL_IN_CHAT.test(outsideDetails(sum).replace(/data-[a-z]+="[^"]*"/g, '')), `H1-4: 左右とも内部の語が無い: ${(outsideDetails(chat + sum).replace(/data-[a-z]+="[^"]*"/g, '').match(INTERNAL_IN_CHAT) || [''])[0]}`);
  // 右の回答欄で答える → 決定事項（台帳）に記録してから仮案の AI へ（既存の経路。入力は右のペインの input・クリックは plan ペインの onPaneClick）
  const d1 = m.conv().draft();
  const q = d1.items.decisions[0];
  await m.$('kt-ai-change-summary').dispatch({ type: 'input', target: { dataset: { dkey: `${d1.id}:${q.key}`, draft: d1.id, did: q.id }, value: '100円未満は部長不要、100万円以上は必要' } });
  await m.$('kt-ai-pane-plan').dispatch({ type: 'click', target: { dataset: { act: 'draft-answer', draft: d1.id } } });
  await ticks(10);
  const ctx1 = m.calls.propose[1] && m.calls.propose[1].ctx;
  assert(m.calls.propose.length === 2 && ctx1 && ctx1.conversation.decisions.some(x => x.key === 'approval.threshold' && x.answer === '100円未満は部長不要、100万円以上は必要') && m.conv().draftDecisions().some(x => x.key === 'approval.threshold') && m.conv().draft().rev === 2, `H1-5: 右の回答欄の答えは決定事項（key 付き）に記録してから仮案の AI へ送る（既存の経路）: ${JSON.stringify({ propose: m.calls.propose.length, decisions: m.conv().draftDecisions().map(x => x.key), rev: m.conv().draft().rev })}`);
  const chat2 = m.chat(), sum2 = m.$('kt-ai-change-summary').innerHTML;
  assert(/仮案を直しました。/.test(chat2) && !/決めたこと/.test(chat2) && /<b>決めたこと<\/b>/.test(sum2) && /100円未満は部長不要、100万円以上は必要/.test(sum2), 'H1-6: 直した仮案のカードも返答と選択だけ。決めたことは右の「変更内容」');
});
await section(async () => {
  // 任意の提案（origin suggestion）と対応できない範囲も左には出ず、右の仮案の詳細に出る（部品だけで描く）
  const items = { behaviors: [B('承認済みでは金額を編集できなくする', 'user'), B('承認済みになったら申請者に通知する', 'suggestion')], assumptions: [A('lock.scope', '対象', '編集できなくするのは全員', '申請者以外にもできます')], decisions: [], approach: { standard: [], js: ['金額の編集不可'] }, cannot: ['明細の行の追加・削除は止められません'] };
  const draft = { id: 'd-sug', rev: 1, status: 'open', request: '承認済みでは金額を編集できなくして', items, history: [], rejected: [] };
  const msg = { id: 'm1', type: 'DRAFT', role: 'assistant', text: '', at: '', data: { draftId: 'd-sug', rev: 1, reply: '承認済みのレコードでは金額を編集できなくします。通知は任意の提案として添えます。', items } };
  const card = KTAiChatUi.messageHtml(msg, { draft, draftDecisions: [] });
  const pane = KTAiChatUi.draftSummaryHtml(draft, { decisions: [] });
  assert(/承認済みのレコードでは金額を編集できなくします。/.test(card) && !card.includes('承認済みになったら申請者に通知する') && !/任意の提案（入れるときは伝えてください）|こちらの提案で進める点|対応できない範囲|実現する動作/.test(card) && /data-act="draft-adopt"/.test(card), 'H1-7: 任意の提案・前提・対応できない範囲・動作の一覧は左に出ない');
  assert(/任意の提案（入れるときは伝えてください）/.test(pane) && pane.includes('承認済みになったら申請者に通知する') && /こちらの提案で進める点/.test(pane) && /対応できない範囲/.test(pane) && /明細の行の追加・削除は止められません/.test(pane) && /残っている判断はありません/.test(pane) && !/data-act="draft-answer"/.test(pane), 'H1-8: 右の仮案の詳細にはそのまま（判断が無ければ回答欄と［回答を送る］は出ない）');
});

// =========================================================
console.log('\n--- §H2. 採用の直後: 別の文は無く、進みのカードの見出しと段階の名前。「まだ何も反映していません」は 1 回 ---');
await section(async () => {
  const pg = gateMk(), gg = { C1: gateMk() };
  const gen = stagedGenerate({ C1: ['gate', 'good'] }, { gates: gg });
  const x = makeConvC({ planImpl: planJs1, generate: gen, planGate: pg });
  for (const s of K.REQUESTS.slice(0, 3)) await x.c.send(s);
  const p = x.c.send(K.REQUESTS[3]);
  await ticks(6);
  const pm0 = x.c.progress();
  const h0 = KTAiChatUi.progressInnerHtml(x.last());
  assert(pm0 && x.last().data && x.last().data.kind === 'progress' && pm0.title === 'この案で最終案を作っています' && /この案で最終案を作っています（経過/.test(h0) && /● 計画を作っています/.test(h0) && /○ まとめ/.test(h0), `H2-1: 採用の直後は進みのカード 1 枚（見出し「この案で最終案を作っています」・段階「計画を作っています」）: ${stripC(h0).replace(/\s+/g, ' ').slice(0, 200)}`);
  assert(!x.c.messages().some(m => m.data && m.data.kind === 'draft-adopted') && !x.c.messages().some(m => /この案で進めます/.test(String(m.text || ''))), 'H2-2: 「この案で進めます。…」の別の文は出さない');
  assert(count(h0, /kintone にはまだ何も反映していません/g) === 1 && !x.c.messages().some(m => m.type !== 'LOADING' && /まだ何も反映していません/.test(String(m.text || ''))), 'H2-3: 「kintone にはまだ何も反映していません」は進みのカードの案内行に 1 回だけ');
  pg.open(); await K.waitUntil(() => gen.count('C1') > 0, 80); await ticks(2);
  const pm1 = x.c.progress();
  const h1 = KTAiChatUi.progressInnerHtml(x.last());
  const rows = (h1.match(/<div class="kt-ai-progress-stage[^"]*"[^>]*>[\s\S]*?<\/div>/g) || []).map(stripC).join(' ');
  assert(pm1 && pm1.stages.map(s => `${s.key}:${s.state}`).join(',') === 'plan:done,generate:active,summarize:todo' && /✓ 計画を作りました/.test(rows) && /● 「PCの編集制御」を作っています（1 \/ 1・経過/.test(rows) && /○ まとめ/.test(rows) && pm1.stages.some(s => s.key === 'generate' && s.label === 'JavaScript を作る（1 本）') && !/生成工程|生成・検証/.test(rows), `H2-4: 計画ができたら「計画を作りました」、生成の段階は「{手順の title}」を作っています（段階の行に内部の工程名は出さない）: ${rows.replace(/\s+/g, ' ').slice(0, 240)}`);
  assert(count(h1, /kintone にはまだ何も反映していません/g) === 1 && !INTERNAL_IN_CHAT.test(stripC(h1)), 'H2-5: 生成中も案内行は 1 回・内部の語は無い');
  gg.C1.open(); await p; await ticks(6);
  const v = x.c.activePlan();
  assert(x.c.progress() === null && v && v.final && FS.readyOf(v) === true && x.finals().length === 1, 'H2-6: 完了したら進みのカードは最終案のカードに置き換わる（流れは変えない）');
});
await section(async () => {
  // JavaScript の無い計画: 計画ができた時点で見出しを「この案で設定の最終案を作っています」に（最終案を作る間の見出し。buildFinal が services.fieldLabels を呼ぶ時点で確かめる）
  const pg = gateMk();
  const x = makeConvC({ planImpl: K.planOk, planGate: pg });
  let titleAtBuild = null;
  const labels0 = x.services.fieldLabels;
  x.services.fieldLabels = () => { const pr = x.c.progress(); if (pr) titleAtBuild = pr.title; return labels0(); };
  for (const s of K.REQUESTS.slice(0, 3)) await x.c.send(s);
  const p = x.c.send(K.REQUESTS[3]);
  await ticks(6);
  const t0 = x.c.progress() && x.c.progress().title;
  pg.open(); await p; await ticks(6);
  assert(t0 === 'この案で最終案を作っています' && titleAtBuild === 'この案で設定の最終案を作っています' && !x.c.messages().some(m => m.data && m.data.kind === 'draft-adopted') && x.c.activePlan() && x.c.activePlan().final, `H2-7: JavaScript の無い計画は、計画ができたら見出しを「この案で設定の最終案を作っています」に: ${JSON.stringify({ t0, titleAtBuild })}`);
});

// =========================================================
console.log('\n--- §H3. 作成途中（C1・C2 検証済み・C3 時間切れ）: 短いカードと右の JavaScript の状態 ---');
await section(async () => {
  const gen = stagedGenerate({ C1: ['good'], C2: ['good'], C3: ['throw:TIMEOUT', 'good'] });
  const x = makeConvC({ planImpl: planJs3, generate: gen });
  await sendUntilAdopt(x);
  const v = x.c.activePlan();
  assert(v.generated.C1.status === 'verified' && v.generated.C2.status === 'verified' && v.generated.C3.status === 'failed' && v.generated.C3.failure.stop === 'timeout' && v.final.incomplete && v.final.incomplete.stoppedAt === 'C3' && FS.readyOf(v) === false, `前提: C1・C2 は検証済み・C3 で止めた: ${JSON.stringify(v.final.incomplete)}`);
  const h = finalHtml(x), vis = visible(h), all = stripC(h);
  const b = restButtonOf(h);
  assert(/^\s*AI\s*作成途中\s/.test(vis) && /PCの編集制御・モバイルの編集制御はできました。モバイルの入力チェックの作成中に、AIの応答が時間切れになりました。/.test(vis) && /完成した分は残っています。残り 1 件から再開できます。/.test(vis) && b && !b.disabled && /data-text="コードを作って"/.test(b.html), `H3-1: 見出し「作成途中」・できたもの・止めたもの・理由・残り 1 件・［残りの JavaScript を作る］: ${vis.replace(/\s+/g, ' ').slice(0, 300)}`);
  assert(count(all, /時間切れ/g) === 1 && !/手を付けていません|作れませんでした|確認できないことがあります/.test(vis), 'H3-2: 理由の文はカードの中に 1 回だけ（未着手・失敗の文は該当が無ければ出さない）');
  const OLD = /最終案を直しました|最終案（|未完成|変わった点|検証の区分|最終的にどう動くか|反映先と主な影響|実現できない点|動作テスト環境へ反映|JavaScript を作っている途中で止めました|まだ作っていない JavaScript が|押すと、計画は作り直さずに/;
  assert(!OLD.test(all), `H3-3: 最終案の全文・古い見出し・理由と次の操作の繰り返しは無い: ${(all.match(OLD) || [''])[0]}`);
  assert(!INTERNAL_IN_CHAT.test(vis) && !/\bC[123]\b|TIMEOUT|lock\.js/.test(vis), `H3-4: 内部の番号・値・ファイル名は出さない: ${(vis.match(/\bC[123]\b|TIMEOUT|lock\.js/) || [''])[0]}`);
  const sum = KTAiChatUi.changeSummaryHtml(v, { open: [], labels: {} });
  const st = (sum.match(/<ul class="kt-ai-sum-js-state">[\s\S]*?<\/ul>/) || [''])[0];
  assert(/JavaScript の状態/.test(sum) && /<li>PCの編集制御：できた（検証済み）<\/li><li>モバイルの編集制御：できた（検証済み）<\/li><li>モバイルの入力チェック：作成中（止めた）<\/li>/.test(st), `H3-5: 右の「変更内容」の先頭に JavaScript の状態（できた・できた・作成中）: ${stripC(st).replace(/\s+/g, ' ')}`);
  const ap = x.c.approveFinal(K.approveArgs(v));
  assert(ap.ok === false && ap.reason === 'NOT_APPROVABLE', 'H3-6: 作成途中は承認できないまま（判定は変えない）');
  const r2 = await pressRest(x);
  const v2 = x.c.activePlan();
  const sum2 = KTAiChatUi.changeSummaryHtml(v2, {});
  assert(r2.ok && x.calls.plan.length === 1 && gen.count('C3') === 2 && gen.count('C1') === 1 && v2.generated.C3.status === 'verified' && FS.readyOf(v2) === true && !v2.final.incomplete && /モバイルの入力チェック：できた（検証済み）/.test(sum2), `H3-7: ［残りの JavaScript を作る］→ 計画の AI 0 回で C3 だけ作り、承認できる最終案（右の状態も「できた」に）: ${JSON.stringify({ plans: x.calls.plan.length, seen: gen.seen.map(s => s.cid) })}`);
  const old = KTAiChatUi.messageHtml(x.finals()[0], { plans: new Map(x.c.planHistory().map(vv => [`${vv.planId}:${vv.version}`, vv])), activePlan: x.c.activePlan(), answers: new Map() });
  assert(/kt-ai-final-card is-old/.test(old) && /前の作成途中の案 — このあと直した案があります/.test(old) && !/data-act="choice"/.test(old), 'H3-8: 前の作成途中のカードは 1 行に畳み、ボタンは出さない');
});
await section(async () => {
  // C2 で止めて C3 は未着手: 未着手の文と残り 2 件
  const gen = stagedGenerate({ C1: ['good'], C2: ['throw:TIMEOUT', 'good'], C3: ['good'] });
  const x = makeConvC({ planImpl: planJs3, generate: gen });
  await sendUntilAdopt(x);
  const vis = visible(finalHtml(x));
  assert(/PCの編集制御はできました。モバイルの編集制御の作成中に、AIの応答が時間切れになりました。モバイルの入力チェックは手を付けていません。/.test(vis) && /残り 2 件から再開できます/.test(vis), `H3-9: 未着手は「手を付けていません」の 1 文・残りは 2 件: ${vis.replace(/\s+/g, ' ').slice(0, 300)}`);
  const sum = KTAiChatUi.changeSummaryHtml(x.c.activePlan(), {});
  assert(/PCの編集制御：できた（検証済み）/.test(sum) && /モバイルの編集制御：作成中（止めた）/.test(sum) && /モバイルの入力チェック：まだ作っていません/.test(sum), 'H3-10: 右の状態は できた・作成中・まだ作っていません');
});
await section(async () => {
  // 最初の C1 で止めた: 「まだできた JavaScript はありません。」（「完成した分は残っています」は言わない）
  const gen = stagedGenerate({ C1: ['throw:TIMEOUT', 'good'], C2: ['good'], C3: ['good'] });
  const x = makeConvC({ planImpl: planJs3, generate: gen });
  await sendUntilAdopt(x);
  const vis = visible(finalHtml(x));
  assert(/まだできた JavaScript はありません。PCの編集制御の作成中に、AIの応答が時間切れになりました。モバイルの編集制御・モバイルの入力チェックは手を付けていません。/.test(vis) && /残り 3 件から再開できます/.test(vis) && !/完成した分は残っています/.test(vis), `H3-11: できた JavaScript が無いときの文: ${vis.replace(/\s+/g, ' ').slice(0, 300)}`);
});
await section(async () => {
  // 上限で止めた: ボタンは無効・2 行目は「上限を見直すまで、続きは送りません。」・理由は 1 回
  const gen = stagedGenerate({ C1: ['good'], C2: ['good'], C3: ['throw:BUDGET_EXCEEDED'] });
  const x = makeConvC({ planImpl: planJs3, generate: gen });
  await sendUntilAdopt(x);
  const v = x.c.activePlan();
  const h = finalHtml(x), vis = visible(h), b = restButtonOf(h);
  assert(v.final.incomplete && v.final.incomplete.kind === 'budget' && b && b.disabled && /モバイルの入力チェックの作成中に、利用の上限（予算・回数）に達しました/.test(vis) && /上限を見直すまで、続きは送りません。/.test(vis) && !/残り [0-9]+ 件/.test(vis) && count(stripC(h), /利用の上限/g) === 1 && !/押せません/.test(vis), `H3-12: 上限で止めたときはボタン無効・「上限を見直すまで、続きは送りません。」・理由は 1 回: ${vis.replace(/\s+/g, ' ').slice(0, 300)}`);
});

await section(async () => {
  // 画面: 同じ版のまま生成の結果が変わっても、右の「変更内容」の JavaScript の状態を描き直す（できた／作成中）。左は作成途中のカード
  const { m: m1 } = await K.mountFinal({ kind: 'js' });
  const sum1 = m1.$('kt-ai-change-summary').innerHTML;
  assert(/JavaScript の状態/.test(sum1) && /<li>JavaScript：できた（検証済み）<\/li>/.test(sum1), `H3-13: 画面の右の「変更内容」に検証済みの JavaScript の状態: ${stripC(sum1).replace(/\s+/g, ' ').slice(0, 160)}`);
  const m2 = K.mount({ health: K.HEALTH_V, planImpl: K.planImplOf(K.screenPlan('js')), generateImpl: async () => { throw aiErr('TIMEOUT'); } });
  await ticks();
  const v2 = await K.adoptOnScreen(m2); await ticks(20);
  const sum2 = m2.$('kt-ai-change-summary').innerHTML, chat2 = stripC(m2.chat());
  assert(v2 && v2.final && v2.final.incomplete && /<li>JavaScript：作成中（止めた）<\/li>/.test(sum2) && /作成途中/.test(chat2) && /JavaScriptの作成中に、AIの応答が時間切れになりました。/.test(chat2) && !/未完成/.test(chat2), `H3-14: 画面で止めたときは右の状態が「作成中（止めた）」、左は作成途中のカード: ${stripC(sum2).replace(/\s+/g, ' ').slice(0, 160)}`);
});

// ---- 第 2 段（指示書 §7 の 4〜8）の部品 ----
/** 右の「変更内容」（計画がある版）。左の最終案のカードから外した節（最終的にどう動くか・反映する内容・できないこと・確認できないこと・確かめたこと）はここ */
const rightOf = (x, v = x.c.activePlan()) => KTAiChatUi.changeSummaryHtml(v, {});
/** data 属性（内部の id）を除いた HTML（内部の語の照合用） */
const noData = (h) => String(h).replace(/data-[a-z-]+="[^"]*"/g, '');
/** 生成の結果に Toolkit の確認（SUBTABLE_ROWS: セルを編集不可にしても明細の行の追加・削除は止まらない）を足す偽の生成工程 */
const withRowLimit = (gen) => ({ ...gen, impl: async (args) => { const r = await gen.impl(args); r.review = { ...r.review, coverage: { achieved: [], notAchieved: [{ code: 'SUBTABLE_ROWS', message: '明細の行の追加・削除は止められません（入力欄だけ編集できなくなります）' }], outOfScope: [], unowned: [] } }; return r; } });
/** 最終案のカードを、承認の欄の準備（画面が渡す finalPre）の状態を指定して描く（ai-flow-redesign の R09-9b と同じ作法） */
const PRE_ITEMS = { target: '動作テスト環境（このアプリ）。運用環境には反映しません', settings: [], process: ['ステータス「部長承認待ち」を追加'], existing: [], duplicate: [], files: ['＋ lock.js（PC）新規追加'], keep: [], deferred: [], confirmations: ['確認項目の例'], warnings: [], manual: [] };
const finalWithPre = (x, status, { reasons = [], items = PRE_ITEMS } = {}) => { const v = x.c.activePlan(), fm = x.finals().slice(-1)[0]; return KTAiChatUi.messageHtml(fm, { plans: new Map(x.c.planHistory().map(z => [`${z.planId}:${z.version}`, z])), activePlan: v, answerState: x.c.answerContext(), ledger: x.c.ledger(), answers: new Map(), finalPre: { planId: v.planId, version: v.version, status, reasons, items } }); };
const applyBtn = (h) => { const b = /<button[^>]*data-act="final-approve"([^>]*)>([^<]*)<\/button><span[^>]*>([^<]*)<\/span>/.exec(h); return b ? { disabled: /\sdisabled/.test(b[1]), note: b[3] } : null; };
const statusOf = (h) => { const m = /<div class="kt-ai-final-status"[^>]*>([^<]*)<\/div>/.exec(h); return m ? m[1] : null; };
//   2026-10-15（最終案の重複と担当未定の食い違い §1・§4）: 添え書きは反映するものに合わせる（JavaScript だけ・設定だけの最終案に「設定の手順 → JavaScript の順」と出さない）
const APPLY_NOTE = '承認すると動作テスト環境へ JavaScript を反映します（運用環境は変更しません）。反映後に、動作テスト環境の画面で動作を確認します。';
const APPLY_NOTE_SETTINGS = '承認すると動作テスト環境へ設定の手順を反映します（運用環境は変更しません）。反映後に、動作テスト環境の画面で動作を確認します。';
/** 左の最終案のカードに出さない節（右の「変更内容」へ移したもの・消したもの） */
const LEFT_MOVED = /最終的にどう動くか|反映先と主な影響|検証の区分|仮案から変わった点|変わった点|機械検査:|必須の動作（|模擬テスト（代表条件|代表条件の一覧|まだ確かめていないこと|まだ何も反映していません|token|対応範囲外|担当が計画にありません|実現できない点/;
const Q_BLOCK = { id: 'Q1', question: '承認待ちの間、申請者本人も編集できなくしますか', topic: 'scope', priority: 'blocking', options: ['全員', '申請者以外'] };
const Q_LATER = { id: 'Q2', question: '灰色の表示色は既定のままでよいですか', topic: 'style', priority: 'later', options: ['はい', 'いいえ'] };
/** 新しい文（左・右）を集めて最後に内部の語を照合する（§H8） */
const SHOWN = [];
const keep = (tag, left, right) => SHOWN.push({ tag, left: noData(outsideDetails(left)), right: noData(right) });

// =========================================================
console.log('\n--- §H4. 完成した最終案（3 本とも検証済み）: 反映できるかの 1 文・実現すること・制約・補足・残る判断・ボタンと反映先。検証の明細は右 ---');
await section(async () => {
  const gen = withRowLimit(stagedGenerate({ C1: ['good'], C2: ['good'], C3: ['good'] }));
  const x = makeConvC({ planImpl: planJs3, generate: gen });
  await sendUntilAdopt(x);
  const v = x.c.activePlan(), fin = v.final;
  assert(fin && !fin.incomplete && ['C1', 'C2', 'C3'].every(c => v.generated[c].status === 'verified') && FS.readyOf(fin) === true && fin.adoptedBehaviors.includes('申請時に課長と部長の承認者をユーザー選択で指定する') && fin.constraints.length === 1 && /明細（テーブル）の行の追加・削除は防ぎません/.test(fin.constraints[0].text) && JSON.stringify(fin.supplements) === JSON.stringify(['編集不可の間は入力欄を灰色にする']) && fin.blockers.length === 0, `前提: 3 本とも検証済みで承認できる。材料（採用した動作・制約 1 件・補足 1 件・止める理由なし）: ${JSON.stringify({ approvable: fin && FS.readyOf(fin), adopted: fin && fin.adoptedBehaviors, constraints: fin && fin.constraints, supplements: fin && fin.supplements, blockers: fin && fin.blockers })}`);
  // 準備の前（finalPre が無い）・準備中・準備が整った、の 3 つの状態
  const h0 = finalHtml(x), hRun = finalWithPre(x, 'running'), hReady = finalWithPre(x, 'ready');
  assert(statusOf(h0) === '反映の前の準備を待っています…' && applyBtn(h0) && applyBtn(h0).disabled && !/この内容で反映できます/.test(h0), `H4-1: 準備の前は「反映の前の準備を待っています…」で押せない（「反映できます」は言わない）: ${statusOf(h0)}`);
  assert(/^反映の前の準備をしています/.test(statusOf(hRun) || '') && applyBtn(hRun).disabled && !/この内容で反映できます/.test(hRun), `H4-2: 準備中は準備の文で押せない: ${statusOf(hRun)}`);
  assert(statusOf(hReady) === 'この内容で反映できます。' && !applyBtn(hReady).disabled && applyBtn(hReady).note === APPLY_NOTE && (stripC(hReady).match(/この内容で反映できます。/g) || []).length === 1, `H4-3: 準備が整うと「この内容で反映できます。」（1 回）とボタン、反映先と順序・反映後の確認先の添え書き: ${JSON.stringify({ status: statusOf(hReady), btn: applyBtn(hReady) })}`);
  const vis = stripC(outsideDetails(hReady));
  const iHead = vis.indexOf('最終案ができました。'), iStatus = vis.indexOf('この内容で反映できます。'), iDo = vis.indexOf('この案で実現すること'), iCon = vis.indexOf('この案の制約'), iSup = vis.indexOf('仮案からの補足'), iBtn = vis.indexOf('動作テスト環境へ反映');
  assert(iHead >= 0 && iHead < iStatus && iStatus < iDo && iDo < iCon && iCon < iSup && iSup < iBtn, `H4-4: 見出し → 反映できます → この案で実現すること → この案の制約 → 仮案からの補足 → ボタン の順: ${JSON.stringify([iHead, iStatus, iDo, iCon, iSup, iBtn])}`);
  assert(/申請時に課長と部長の承認者をユーザー選択で指定する/.test(vis) && /100万円以上の申請は部長承認を必要とする/.test(vis) && !/承認待ちでは金額を編集不可にします/.test(vis), 'H4-5: 「この案で実現すること」は採用した仮案の動作（計画・生成の要約の文は右）');
  assert((vis.match(/行の追加・削除は防ぎません/g) || []).length === 1 && vis.includes('明細（テーブル）の行の追加・削除は防ぎません（PC）。入力欄（セル）の編集不可だけでは止められず、行のボタンを隠す API は Toolkit がまだ扱っていません。') && !/入力欄だけ編集できなくなります/.test(vis), `H4-6: 「この案の制約」に行の追加・削除（PC・モバイルで同じ内容は 1 行。制約の文は残る範囲だけ。2026-10-15 §4(b)）: ${(vis.match(/この案の制約[\s\S]{0,200}/) || [''])[0]}`);
  //   2026-10-15（最終案の重複と担当未定の食い違い §1）: 計画の返答（計画の要約）は再掲しない。採用の後に具体的になった判断（計画で決めた点）だけ
  assert(/計画で決めた点: 編集不可の間は入力欄を灰色にする/.test(vis) && !/計画を作りました。承認待ちの間だけ金額を編集不可にします。/.test(stripC(hReady)) && !/kt-ai-final-reply/.test(hReady), 'H4-7: 「仮案からの補足」は計画で決めた点だけ（計画の返答は再掲しない）');
  assert(/<details class="kt-ai-tech kt-ai-final-pre"[^>]*><summary>反映の前の確認（書き込みなし）<\/summary>/.test(hReady) && !/プロセス管理の変更|確認項目の例/.test(vis) && /プロセス管理の変更/.test(stripC(hReady)) && /確認項目の例/.test(stripC(hReady)), 'H4-8: 「反映の前の確認（書き込みなし）」は折りたたみ（中身は開くと見える）');
  assert(!LEFT_MOVED.test(vis) && !/残る判断|確認できないこと|反映を止めている理由/.test(vis), `H4-9: 左に検証の明細・反映先と主な影響・変わった点・「まだ何も反映していません」・残る判断（無い）は出ない: ${(vis.match(LEFT_MOVED) || [''])[0]}`);
  const right = rightOf(x), rt = stripC(right);
  assert(/JavaScript の状態/.test(right) && (rt.match(/できた（検証済み）/g) || []).length === 3 && /承認待ちでは金額を編集不可にします/.test(rt) && /反映する内容/.test(right) && /新しい JavaScript「lock\.js」を登録/.test(rt) && /できないこと/.test(right) && /明細（テーブル）の行の追加・削除は防ぎません（PC）。/.test(rt) && !/確認できないこと/.test(right), `H4-10: 右の「変更内容」に JavaScript の状態・計画の要約・反映する内容・できないこと（担当の決まっていない要件は無いので「確認できないこと」は無い）: ${rt.replace(/\s+/g, ' ').slice(0, 300)}`);
  const line = (right.match(/<div class="kt-ai-sum-verified">([^<]*)<\/div>/) || [])[1] || '';
  assert(line === '構文と対象の照合、模擬テストで必須の動作を確認しました。実機は未確認です。' && /<details class="kt-ai-tech kt-ai-sum-verification"><summary>検証の明細<\/summary>/.test(right) && /機械検査: 生成工程の検査/.test(rt) && /必須の動作（/.test(rt) && /✓ 「金額」（PC）: 編集できない — 処理あり・模擬テストで合格/.test(rt) && /代表条件の一覧/.test(rt) && /反映した後、動作テスト環境で確かめること/.test(rt) && (rt.match(/実機は未確認です/g) || []).length === 1, `H4-11: 右の「確かめたこと」は 1 行＋明細（実機未確認は 1 回）: ${JSON.stringify({ line, n: (rt.match(/実機は未確認です/g) || []).length })}`);
  keep('H4', hReady, right);
});
await section(async () => {
  // 先に決めたい質問が残る最終案: 「残る判断」は blocking だけ（後で決めてよいことは件数だけ）。反映できるかの 1 文は止めている理由
  const x = makeConvC({ planImpl: (args) => { const r = planJs3(args); r.plan.questions = [Q_BLOCK, Q_LATER]; return r; }, generate: stagedGenerate({ C1: ['good'], C2: ['good'], C3: ['good'] }) });
  await sendUntilAdopt(x);
  const v = x.c.activePlan(), fin = v.final;
  const h = finalHtml(x), vis = stripC(outsideDetails(h));
  assert(FS.readyOf(fin) === false && /先に決めたいことが 1 件/.test(FS.reasonOf(fin)) && statusOf(h) === FS.reasonOf(fin) && applyBtn(h).disabled && !/この内容で反映できます/.test(h), `H4-12: 先に決めたいことが残ると、1 文は止めている理由でボタンは押せない: ${statusOf(h)}`);
  assert(/残る判断（1 件）/.test(vis) && (vis.match(/承認待ちの間、申請者本人も編集できなくしますか/g) || []).length === 1 && /後で決めてよいことが 1 件あります/.test(vis) && !/灰色の表示色は既定のままでよいですか/.test(vis) && /<textarea class="kt-ai-qa-input"/.test(h) && /data-act="answer-questions"/.test(h), `H4-13: 残る判断は先に決めたいことだけ（1 回）。後で決めてよいことは件数だけ。回答欄は今のまま: ${(vis.match(/残る判断[\s\S]{0,200}/) || [''])[0]}`);
  keep('H4-q', h, rightOf(x));
});
await section(async () => {
  // 計画で決めた点も計画の返答も無い最終案: 「仮案からの補足」は見出しごと出ない。制約も無ければ「この案の制約」も出ない
  const x = makeConvC({ planImpl: (args) => { const r = planJs1(args); r.plan.provisionals = []; r.turn.reply = ''; return r; }, generate: stagedGenerate({ C1: ['good'] }) });
  await sendUntilAdopt(x);
  const h = finalHtml(x), vis = stripC(outsideDetails(h));
  assert(FS.readyOf(x.c.activePlan()) === true && !/仮案からの補足/.test(h) && !/この案の制約/.test(h) && /この案で実現すること/.test(vis) && /動作テスト環境へ反映/.test(vis), `H4-14: 補足・制約が無ければ見出しごと出さない: ${vis.replace(/\s+/g, ' ').slice(0, 240)}`);
  keep('H4-nosup', h, rightOf(x));
});
await section(async () => {
  // 既存の設定を変える手順（Toolkit Review の変更前後）は「この案で実現すること」に 1 文（見落とすと業務の結果が変わる変更は左にも残す）
  const withUpdate = (args) => { const r = planJs1(args); r.plan.steps.push({ id: 'P2', actionType: 'UPDATE_VIEW', targetKind: 'VIEW', targetRef: '承認待ち一覧', title: '一覧「承認待ち一覧」の絞り込みを変更', spec: { name: '承認待ち一覧' }, dependsOn: [] }); r.review.steps.push({ stepId: 'P2', status: 'VALID', safety: 'REVIEW', diff: { human: ['絞り込み: なし → ステータスが「承認待ち」'] }, issues: [] }); r.review.executionReadiness.reviewSteps.push('P2'); return r; };
  const x = makeConvC({ planImpl: withUpdate, generate: stagedGenerate({ C1: ['good'] }) });
  await sendUntilAdopt(x);
  const fin = x.c.activePlan().final, vis = stripC(outsideDetails(finalHtml(x)));
  //   レビュー 1（2026-10-14）: fin.existingChanges は構造化した材料（kind・title・name・from・to・filterCond）。Toolkit Review の diff.human（✎・Before・After）は左に連結しない。
  //   プロセス管理以外の既存の設定の変更は「今ある設定を変えます: {手順}（変更前後は右の「変更内容」）」の 1 文
  const ex = fin.existingChanges[0];
  //   2026-10-15（追加の指示 2）: 採用した動作があっても一律に隠さない。この一覧の絞り込みの変更は採用した要件（承認者の選び方・部長承認の金額・期限）で説明されない
  //   （explained false）ので、左の「この案で実現すること」に 1 文で残し、右で変更前後を確かめられる。採用した動作が無い最終案でも同じ 1 文
  const v0 = x.c.activePlan(), v0b = { ...v0, final: { ...fin, adoptedBehaviors: [] } };
  const visNoAdopt = stripC(outsideDetails(KTAiChatUi.finalCardHtml({ type: 'FINAL', data: { planId: v0.planId, version: v0.version } }, { plans: new Map([[`${v0.planId}:${v0.version}`, v0b]]), activePlan: v0b, answerState: x.c.answerContext(), answers: new Map() })));
  const LINE15 = /今ある設定を変えます: 一覧「承認待ち一覧」の絞り込みを変更（変更前後は右の「変更内容」）/;
  assert(fin.existingChanges.length === 1 && ex && ex.kind === 'UPDATE_VIEW' && ex.title === '一覧「承認待ち一覧」の絞り込みを変更' && ex.name === '承認待ち一覧' && ex.explained === false && fin.adoptedBehaviors.length > 0 && LINE15.test(vis) && !/絞り込み: なし →|✎|Before|After/.test(vis) && vis.indexOf('この案で実現すること') < vis.indexOf('今ある設定を変えます') && vis.indexOf('今ある設定を変えます') < vis.indexOf('動作テスト環境へ反映') && /一覧「承認待ち一覧」の絞り込みを変更/.test(stripC(rightOf(x)))
    && LINE15.test(visNoAdopt), `H4-15: 採用した要件で説明されない既存の設定の変更は、採用した動作があっても「この案で実現すること」に 1 文（構造化した材料から。Review の変更前後の行は連結しない）: ${JSON.stringify(fin.existingChanges)}`);
  keep('H4-upd', finalHtml(x), rightOf(x));
});
await section(async () => {
  // レビュー 1（2026-10-14）: UPDATE_PROCESS で条件が付く → 左は「今ある操作「申請する」は、{条件の文}のときだけ使えるようになります」。
  //   Toolkit Review の diff.human（'✎ アクション「申請する」を変更' / 'Before: …' / 'After: … [amount < 1000000]'）の ✎・Before・After・amount は左に出さず、「申請する」と「金額」が出る
  const withProcess = (args) => {
    const r = planJs1(args);
    r.plan.steps.push({ id: 'P3', actionType: 'UPDATE_PROCESS', targetKind: 'PROCESS', targetRef: '申請する', title: 'アクション「申請する」の条件を変更', spec: { name: '申請する', from: '未処理', to: '承認待ち', filterCond: 'amount < 1000000' }, dependsOn: [] });
    r.review.steps.push({ stepId: 'P3', status: 'NEEDS_CONFIRMATION', safety: 'REVIEW', diff: { changeType: 'UPDATE', changeKind: 'ACTION_CONDITION', target: { kind: 'PROCESS_ACTION', id: '申請する' }, before: { name: '申請する', from: '未処理', to: '承認待ち', filterCond: '' }, after: { name: '申請する', from: '未処理', to: '承認待ち', filterCond: 'amount < 1000000' }, human: ['✎ アクション「申請する」を変更', 'Before: 未処理 → 承認待ち（条件なし）', 'After: 未処理 → 承認待ち [amount < 1000000]'] }, issues: [] });
    r.review.executionReadiness.reviewSteps.push('P3');
    return r;
  };
  const x = makeConvC({ planImpl: withProcess, generate: stagedGenerate({ C1: ['good'] }) });
  await sendUntilAdopt(x);
  const v = x.c.activePlan(), fin = v.final;
  const h = KTAiChatUi.messageHtml(x.finals().slice(-1)[0], { plans: new Map(x.c.planHistory().map(z => [`${z.planId}:${z.version}`, z])), activePlan: v, answerState: x.c.answerContext(), ledger: x.c.ledger(), answers: new Map(), labels: K.LABELS_C });
  const vis = stripC(outsideDetails(h));
  const ex = fin.existingChanges[0];
  assert(fin.existingChanges.length === 1 && ex && ex.kind === 'UPDATE_PROCESS' && ex.name === '申請する' && ex.from === '未処理' && ex.to === '承認待ち' && ex.filterCond === 'amount < 1000000' && ex.targetKind === 'PROCESS_ACTION', `H4-16: 既存の操作の変更は構造化した材料（name・from・to・filterCond）: ${JSON.stringify(ex)}`);
  //   2026-10-15（追加の指示 2・見直しの反映）: 採用した要件は「100万円以上は部長承認を必要とする」だけで、既存の操作「申請する」を 100万円未満の側に絞る変更は
  //   どの要件も言っていない（反対側の境界。説明済みと確かめられない）→ 採用した動作があっても左に 1 文で残す（右の「何が変わるか」にも変更前後。元の式は詳細）。
  //   採用した動作が無い最終案でも左に 1 文（数値のフィールドの種類と単位があれば「100万円未満」）
  const rt16 = KTAiChatUi.changeSummaryHtml(v, { labels: K.LABELS_C, numbers: { amount: { type: 'NUMBER', unit: '円', unitPosition: 'AFTER' } } });
  const vNo = { ...v, final: { ...fin, adoptedBehaviors: [] } };
  const visNo = stripC(outsideDetails(KTAiChatUi.finalCardHtml({ type: 'FINAL', data: { planId: v.planId, version: v.version } }, { plans: new Map([[`${v.planId}:${v.version}`, vNo]]), activePlan: vNo, answerState: x.c.answerContext(), answers: new Map(), labels: K.LABELS_C, numbers: { amount: { type: 'NUMBER', unit: '円', unitPosition: 'AFTER' } } })));
  assert(ex.explained === false && (vis.match(/今ある操作「申請する」は、「金額」が1000000未満のときだけ使えるようになります/g) || []).length === 1 && !/✎|Before|After|amount|\[/.test(vis) && /After: 未処理 → 承認待ち\s*（条件: 「金額」が100万円未満）/.test(stripC(outsideDetails(rt16))) && /<details class="kt-ai-tech kt-ai-sum-cond"[^>]*><summary>条件式（実行される式）<\/summary>変更後: <code>amount &lt; 1000000<\/code><\/details>/.test(rt16)
    && /今ある操作「申請する」は、「金額」が100万円未満のときだけ使えるようになります/.test(visNo) && !/✎|Before|After|amount|\[/.test(visNo) && visNo.indexOf('この案で実現すること') < visNo.indexOf('今ある操作「申請する」'), `H4-16b: 採用した要件が言っていない既存の操作の変更（反対側の境界）は、採用した動作があっても左に 1 文（右に変更前後・元の式は詳細）。採用した動作が無くても左に「今ある操作「申請する」は、…のときだけ使えるようになります」: ${JSON.stringify([ex.explained, (vis.match(/今ある操作[^\n]{0,80}/g) || [])])} ${(visNo.match(/今ある操作[^\n]{0,80}/) || [''])[0]}`);
  //   条件を文にできない形（kintone の関数など）→ 「既存の操作「申請する」の使える条件が変わります（右の「変更内容」）」（採用した動作が無い最終案の左）
  const v2 = { ...v, final: { ...fin, adoptedBehaviors: [], existingChanges: [{ ...ex, filterCond: 'owner in (LOGINUSER()) and memo like "急ぎ"' }] } };
  const text2 = KTAiChatUi.finalCardHtml({ type: 'FINAL', data: { planId: v.planId, version: v.version } }, { plans: new Map([[`${v.planId}:${v.version}`, v2]]), activePlan: v2, answerState: x.c.answerContext(), answers: new Map(), labels: K.LABELS_C });
  assert(/既存の操作「申請する」の使える条件が変わります（右の「変更内容」）/.test(stripC(text2)) && !/LOGINUSER|owner|memo/.test(stripC(outsideDetails(text2))), `H4-16c: 条件を文にできないときは「使える条件が変わります（右の「変更内容」）」: ${(stripC(text2).match(/既存の操作[^\n]{0,80}|今ある操作[^\n]{0,80}/) || [''])[0]}`);
  keep('H4-proc', h, rightOf(x));
});
await section(async () => {
  // レビュー 5（2026-10-14）: モバイルの JavaScript があるとき、右の「確かめたこと」の 1 行に確認先（運用環境のモバイル画面か実機）を 1 回だけ添え、明細では繰り返さない
  //   モバイルの確認先の文は Toolkit の登録の確認（KTCodeReview の MOBILE_RUNTIME_NOT_VERIFIABLE。platform に mobile があるとき）が fin.verification.unverified に入れる。
  //   ここでは検証済みの最終案の材料にその文を足して、右の「変更内容」の表示だけを確かめる（判定と材料の作り方は変えていない）
  const x = makeConvC({ planImpl: planJs1, generate: stagedGenerate({ C1: ['good'] }) });
  await sendUntilAdopt(x);
  const v = x.c.activePlan(), fin = v.final;
  const reg = T.KTCodeReview.review({ generated: v.generated.C1.generated, customization: { ...clone(v.plan.customizations[0]), platform: ['mobile'] }, plan: v.plan, data: clone(K.DATA_C), scan: null, existingSource: null });
  const mobileMsg = ((reg.registration && reg.registration.unverified) || []).map(u => u.message).find(m => /モバイルの画面は kintone の動作テスト環境に無い/.test(m)) || '';
  const v2 = { ...v, final: { ...fin, verification: { ...fin.verification, unverified: [...fin.verification.unverified, mobileMsg] } } };
  const right = KTAiChatUi.changeSummaryHtml(v2, {}), rt = stripC(right);
  const line = (right.match(/<div class="kt-ai-sum-verified">([^<]*)<\/div>/) || [])[1] || '';
  assert(mobileMsg && !/運用環境のモバイル画面/.test(stripC(rightOf(x))) && line === '構文と対象の照合、模擬テストで必須の動作を確認しました。実機は未確認です（モバイルは運用環境のモバイル画面か実機で確かめます）。' && count(rt, /運用環境のモバイル画面/g) === 1 && !/モバイルの画面は kintone の動作テスト環境に無い/.test(rt) && count(rt, /実機は未確認です/g) === 1, `H4-17: モバイルの確認先は「確かめたこと」の 1 行に 1 回（明細では繰り返さない。PC だけなら添えない）: ${JSON.stringify({ line, n: count(rt, /運用環境のモバイル画面/g), msg: mobileMsg.slice(0, 40) })}`);
  keep('H4-mobile', finalHtml(x), right);
});
await section(async () => {
  // レビュー 6（2026-10-14）: 受け付けた指示あり＋上限（budget）で止めた作成途中のカード: ［受け付けた指示を計画に入れる］は無効で、注記は「上の理由で押せません。」（理由はカードの中で 1 回だけ）
  const gates = { C3: K.gate() };
  const gen = stagedGenerate({ C1: ['good'], C2: ['good'], C3: ['good'] });
  const realImpl = gen.impl; let first = true;
  gen.impl = async (args) => { if (args.customizationId === 'C3' && first) { first = false; await gates.C3.p; gen.seen.push({ cid: 'C3', what: 'throw:BUDGET_EXCEEDED' }); throw aiErr('BUDGET_EXCEEDED'); } return realImpl(args); };
  const x = makeConvC({ planImpl: planJs3, generate: gen });
  for (const s of K.REQUESTS.slice(0, 3)) await x.c.send(s);
  const p = x.c.send(K.REQUESTS[3]);
  await ticks(30);
  const q = await x.c.send('明細の金額も同じ条件で編集できないようにして');
  gates.C3.open(); await p; await ticks(6);
  const v = x.c.activePlan(), fin = v.final;
  const h = finalHtml(x), vis = visible(h);
  const pendBtn = /<button[^>]*data-act="choice"[^>]*data-intent="REVISE_PLAN"[^>]*>/.exec(h);
  assert(q && q.queued === true && fin && fin.incomplete && fin.incomplete.kind === 'budget' && Array.isArray(fin.pendingInstructions) && fin.pendingInstructions.length === 1, `前提: 生成中に受け付けた指示 1 件・上限で止めた: ${JSON.stringify({ queued: q && q.queued, inc: fin && fin.incomplete, pend: fin && fin.pendingInstructions && fin.pendingInstructions.length })}`);
  assert(pendBtn && /\sdisabled/.test(pendBtn[0]) && /上の理由で押せません。/.test(vis) && !/達したため、押せません/.test(vis) && count(stripC(h), /利用の上限/g) === 1 && /モバイルの入力チェックの作成中に、利用の上限（予算・回数）に達しました/.test(vis) && /上限を見直すまで、続きは送りません。/.test(vis), `H3-15: 受け付けた指示あり＋上限: ボタンは無効・注記は「上の理由で押せません。」・理由はカードの中で 1 回: ${vis.replace(/\s+/g, ' ').slice(0, 320)}`);
  keep('H3-budget-pend', h, rightOf(x));
});
await section(async () => {
  // レビュー 8（2026-10-14）: 作成途中のカードに、検証済みの JavaScript の「コードを見る（手順の名前）」と、残る判断（先に決めたい質問の回答欄）を付ける（承認の欄は付けない）
  const gen = stagedGenerate({ C1: ['good'], C2: ['good'], C3: ['throw:TIMEOUT', 'good'] });
  const x = makeConvC({ planImpl: (args) => { const r = planJs3(args); r.plan.questions = [Q_BLOCK, Q_LATER]; return r; }, generate: gen });
  await sendUntilAdopt(x);
  const v = x.c.activePlan();
  const h = finalHtml(x), vis = visible(h);
  const codeBtns = [...h.matchAll(/<button[^>]*data-act="open-code"\s+data-cid="([^"]+)"[^>]*>([^<]*)<\/button>/g)];
  assert(v.final.incomplete && v.final.incomplete.stoppedAt === 'C3' && codeBtns.length === 2 && codeBtns.map(m => m[1]).join(',') === 'C1,C2' && codeBtns.map(m => m[2]).join('・') === 'コードを見る（PCの編集制御）・コードを見る（モバイルの編集制御）' && !/lock\.js/.test(vis), `H3-16: 作成途中のカードに検証済みの JavaScript だけ「コードを見る（手順の名前）」（止めた C3 には無い。ファイル名は出さない）: ${JSON.stringify(codeBtns.map(m => [m[1], m[2]]))}`);
  assert(/作成途中/.test(vis) && /残る判断（1 件）/.test(vis) && /承認待ちの間、申請者本人も編集できなくしますか/.test(vis) && /<textarea class="kt-ai-qa-input"/.test(h) && /data-act="answer-questions"/.test(h) && !/灰色の表示色/.test(vis) && /後で決めてよいことが 1 件あります/.test(vis) && !/data-act="final-approve"|動作テスト環境へ反映/.test(h), `H3-17: 作成途中のカードに残る判断（先に決めたいことだけ・回答欄）。承認の欄は無い: ${(vis.match(/残る判断[\s\S]{0,160}/) || [''])[0]}`);
  const rt = stripC(rightOf(x));
  assert(/モバイルの入力チェック：作成中（止めた）/.test(rt) && !/確認できないこと[\s\S]*「モバイルの入力チェック」/.test(rt), 'H3-18: 右の「確認できないこと」に止めた JavaScript（stopped）の行は出ない（状態「作成中（止めた）」で分かる）');
  keep('H3-code-q', h, rightOf(x));
});

// =========================================================
console.log('\n--- §H5. 止める根拠の維持: 模擬テスト不合格は承認できないまま理由を出す。条件が分からないときは「確かめていません」（不可能と書かない） ---');
await section(async () => {
  const x = makeConvC({ planImpl: planJs1, generate: makeGenerate({ sequence: ['bad'] }) });
  await sendUntilAdopt(x);
  const v = x.c.activePlan(), fin = v.final, e = v.generated.C1;
  const h = finalHtml(x), vis = stripC(outsideDetails(h));
  const ap = x.c.approveFinal(K.approveArgs(v));
  assert(e.status === 'unresolved' && FS.readyOf(fin) === false && ap.ok === false && ap.reason === 'NOT_APPROVABLE' && applyBtn(h).disabled && statusOf(h) === FS.reasonOf(fin) && !/この内容で反映できます/.test(h), `H5-1: 模擬テストで不合格の最終案は承認できないまま（判定は変えない）。1 文は止めている理由: ${JSON.stringify({ status: e.status, ok: ap.ok, line: statusOf(h) })}`);
  const sec5 = (vis.match(/確認できないこと／反映を止めている理由[\s\S]*?(?=動作テスト環境へ反映)/) || [''])[0];
  //   レビュー 4（2026-10-14）: 行の先頭はファイル名ではなく計画の手順の title（「PCの編集制御」）
  assert(fin.blockers.length >= 1 && fin.blockers[0].kind === 'unresolved' && /「PCの編集制御」: /.test(sec5) && !/lock\.js」: /.test(sec5) && sec5.includes(e.verdict.reason) && /次の方針: /.test(sec5) && sec5.includes(e.verdict.next), `H5-2: 理由（verdict.reason）と次の方針（next）が「確認できないこと／反映を止めている理由」に残る（先頭は手順の名前）: ${sec5.replace(/\s+/g, ' ').slice(0, 300)}`);
  const rt = stripC(rightOf(x));
  //   レビュー 2・11（2026-10-14）: 右の JavaScript の状態は「模擬テストで不合格」。右の「確認できないこと」にも理由と次の方針が 1 行ずつ（作成途中のときも読めるように）
  const rightSec = (rt.match(/確認できないこと[\s\S]*?(?=確かめたこと|$)/) || [''])[0];
  assert(/PCの編集制御：模擬テストで不合格/.test(rt) && /確認できないこと/.test(rightOf(x)) && rightSec.includes(e.verdict.reason) && /次の方針: /.test(rightSec) && rightSec.includes(e.verdict.next) && count(rt, new RegExp(e.verdict.reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) === 1, `H5-2b: 右の状態は「模擬テストで不合格」、右の「確認できないこと」に理由と次の方針（1 回）: ${rightSec.replace(/\s+/g, ' ').slice(0, 300)}`);
  assert(/模擬テストで不合格が 1 件あります。実機は未確認です。/.test(rt) && /× 「金額」（PC）: 編集できない — 処理あり・模擬テストで不合格/.test(rt) && /反映できない点が残っているため、まだ実機で確かめる段階ではありません/.test(rt) && !/反映した後、動作テスト環境で確かめること/.test(rt), `H5-3: 右の「確かめたこと」は不合格の件数、明細に不合格の行。実機で確かめる案内は出さない: ${(rt.match(/確かめたこと[\s\S]{0,200}/) || [''])[0]}`);
  keep('H5-bad', h, rightOf(x));
});
await section(async () => {
  // 既存の入力チェックの移植で、移植元の本文を生成に渡せない（no-source）: 「同じ条件かを確かめられません」と書き、不可能と断定しない（ai-port-and-table-change の P3-6 と同じ fixture）
  const F = require('./fixtures/nl1010-port.js');
  const LABELS = { amount: '金額', 'ステータス': 'ステータス', items: '明細', item_name: '品名', qty: '数量', unit_price: '単価', subtotal: '小計' };
  const U_PORT = '今ある入力チェックはモバイルでも同じように使いたい';
  const portScript = ({ utterance }) => (utterance === U_PORT ? { reply: 'PC の入力チェックを、モバイルでも同じ判定で動くようにします。', intent: 'propose', proposal: { behaviors: [B('PC の既存の入力チェックを、モバイルでも同じ判定で動かす', 'user')], assumptions: [], decisions: [], approach: { standard: [], js: ['既存の入力チェックのモバイルへの移植'] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [K.req('add', { target: '入力チェック', condition: '', behavior: '既存の入力チェックをモバイルでも同じ判定で使う', sourceQuotes: [U_PORT], planRefs: ['B1'], effects: [] })] } } : null);
  const portPlan = (args) => {
    const c = { ...clone(F.CUSTOMIZATIONS.find(z => z.customizationId === 'C3')), dependsOn: [], evidenceIds: [] };
    const plan = { goal: args.goal, assessment: { summary: 'PC の入力チェックをモバイルへ移します。' }, steps: [{ id: 'C3', actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: null, title: 'モバイルの入力チェック', spec: { customizationId: 'C3' }, dependsOn: [] }], customizations: [clone(c)], provisionals: [], questions: [], unknowns: [], impact: [], solution: 'CUSTOMIZATION' };
    return { plan, ctx: null, gatewayPlan: clone(plan), turn: { reply: 'PC の入力チェックをモバイルへ移します。', requirementOps: [], utteranceCoverage: [] }, review: { base: { baseVersion: '1', env: 'preview', ok: true, fingerprint: 'fp-1', revision: { preview: '10' } }, steps: [{ stepId: 'C3', status: 'VALID', safety: 'PLAN_ONLY', customization: clone(c), codeGeneration: { supported: true, strategy: 'NEW_JS_FILE', reason: null }, issues: [] }], executionReadiness: { safeSteps: [], reviewSteps: [], blockedSteps: [], planOnlySteps: ['C3'] }, warnings: [] } };
  };
  const gen = makeGenerate();
  const x = makeConvC({ scriptFn: portScript, labels: LABELS, generate: gen, planImpl: portPlan });
  x.services.jsFiles = () => [{ name: 'dealLock.js', target: 'desktop', events: ['app.record.create.show', 'app.record.edit.show'], fields: ['amount', 'ステータス'], source: false }, { name: 'dealValidate.js', target: 'desktop', events: ['app.record.create.submit', 'app.record.edit.submit'], fields: ['amount'], source: false }];
  await x.c.send(U_PORT); await x.c.send('採用します');
  const v = x.c.activePlan(), e = v && v.generated && v.generated.C3, fin = v && v.final;
  const h = finalHtml(x), vis = stripC(outsideDetails(h));
  assert(e && e.status === 'not-ready' && e.verdict.kind === 'effects-unknown' && gen.calls.length === 0 && FS.readyOf(fin) === false && applyBtn(h).disabled, `前提: 移植元の本文を渡せない → 生成を呼ばず準備未完了（判定は変えない）: ${JSON.stringify(e && e.verdict && [e.status, e.verdict.kind])}`);
  const sec5 = (vis.match(/確認できないこと／反映を止めている理由[\s\S]*?(?=動作テスト環境へ反映)/) || [''])[0];
  //   レビュー 3（2026-10-14）: 「…移植元の本文を取れない（読めない）ので、同じ条件かは確かめていません」の形（不可能と読める「確かめられません」は使わない。判定 not-ready・approvable false は不変）
  assert(/移植元の本文を取れない/.test(sec5) && /同じ条件かは確かめていません/.test(sec5) && /次の方針: /.test(sec5) && !/確かめられません|不可能|できません。$/.test(sec5.replace(/\s+/g, '')) && /移植元の本文を取れない（読めない）ので確かめていません/.test(statusOf(h) || '') && !/確かめられない/.test(statusOf(h) || ''), `H5-4: 条件が分からないときは「取れないので、同じ条件かは確かめていません」と理由・次の方針（不可能と断定しない）: ${sec5.replace(/\s+/g, ' ').slice(0, 300)}`);
  const rtPort = stripC(rightOf(x));
  assert(/モバイルの入力チェック：確認できないことがあります/.test(rtPort) && /確認できないこと/.test(rightOf(x)) && /同じ条件かは確かめていません/.test((rtPort.match(/確認できないこと[\s\S]*?(?=確かめたこと|$)/) || [''])[0]), 'H5-5: 右の JavaScript の状態は「確認できないことがあります」、右の「確認できないこと」に理由（レビュー 11）');
  keep('H5-port', h, rightOf(x));
});

await section(async () => {
  // 統合テストの指摘 15（2026-10-14）: 「作った JavaScript の誤りとは判定していません」（同じ意味の「生成したコードの…」を含む）は fin.blockers の 1 行で 1 回だけ
  //   （模擬テストの入力の不正などの not-run の行。理由の文・末尾・次の方針で繰り返さない。判定の文 verdict.reason / next は変えない）
  const x = makeConvC({ planImpl: planJs1, generate: makeGenerate({ sequence: ['good'], env: 'case-invalid', caseReason: 'case-invalid' }) });
  await sendUntilAdopt(x);
  const v = x.c.activePlan(), fin = v.final, e = v.generated.C1;
  const row = (fin.blockers || []).find(b => b.kind === 'not-run');
  const ONCE = /(?:作った JavaScript |生成したコード)の誤りとは判定してい/g;
  assert(e.status === 'not-run' && FS.readyOf(fin) === false && count(`${e.verdict.reason}${e.verdict.next}`, ONCE) >= 2 && row && count(`${row.text}${row.next}`, ONCE) === 1 && /模擬テストを実行できませんでした/.test(row.text) && /修復は依頼していません/.test(row.next), `H5-6: 反映を止める理由の行では「誤りとは判定していません」は 1 回（判定の文はそのまま）: ${JSON.stringify(row && [row.text, row.next])}`);
  const vis = stripC(outsideDetails(finalHtml(x)));
  const sec = (vis.match(/確認できないこと／反映を止めている理由[\s\S]*?(?=動作テスト環境へ反映)/) || [''])[0];
  const rightSec = (stripC(rightOf(x)).match(/確認できないこと[\s\S]*?(?=確かめたこと|$)/) || [''])[0];
  assert(count(sec, ONCE) === 1 && count(rightSec, ONCE) === 1, `H5-6b: 左の行・右の「確認できないこと」の行でも 1 回ずつ: ${JSON.stringify({ left: count(sec, ONCE), right: count(rightSec, ONCE) })}`);
  keep('H5-notrun', finalHtml(x), rightOf(x));
});
await section(async () => {
  // 統合テストの指摘 14（2026-10-14）: 「確かめたこと」の 1 行は、設計上 skip した代表条件（対象外・category scope の not-run）を「実行できていません」に数えない。
  //   環境・材料不足で実行できなかった not-run だけを件数に出す（必要なら「対象外の条件は除く」と添える）
  const x = makeConvC({ planImpl: planJs1, generate: stagedGenerate({ C1: ['good'] }) });
  await sendUntilAdopt(x);
  const fin = x.c.activePlan().final, beh = fin.verification.behavior;
  const withCases = (extra) => ({ ...fin, verification: { ...fin.verification, behavior: { ...beh, status: 'not-run', cases: [...beh.cases, ...extra], counts: { pass: beh.counts.pass, fail: 0, notRun: extra.length } } } });
  const scopeCase = { label: '「金額」: 編集できない（作成画面）', verdict: 'not-run', message: '', reason: '対象外: その確かめ方に当たるイベントが計画にありません', category: 'scope' };
  const envCase = { label: '「金額」: 編集できない（編集画面）', verdict: 'not-run', message: '', reason: '環境: 隔離環境が使えません', category: 'env' };
  const l1 = KTAiChatUi.verificationLineOf(withCases([scopeCase, scopeCase]));
  const l2 = KTAiChatUi.verificationLineOf(withCases([scopeCase, envCase]));
  assert(l1 === '構文と対象の照合、模擬テストで必須の動作を確認しました（対象外の条件は除く）。実機は未確認です。' && !/実行できていません/.test(l1), `H4-18: 対象外の not-run だけなら「実行できていません」と数えない: ${l1}`);
  assert(/模擬テストの代表条件 1 件は実行できていません（対象外の条件は除く）。実機は未確認です。$/.test(l2), `H4-18b: 環境の not-run だけを件数に出す: ${l2}`);
  //   生成工程の理由が対象外（no-event。category scope）で全部 not-run のとき（判定は not-run のまま）: 実行できなかったように読ませない
  const y = makeConvC({ planImpl: planJs1, generate: makeGenerate({ sequence: ['good'], env: 'no-event', caseReason: 'no-event' }) });
  await sendUntilAdopt(y);
  const finY = y.c.activePlan().final, l3 = KTAiChatUi.verificationLineOf(finY);
  assert(FS.readyOf(finY) === false && finY.verification.behavior.cases.every(c => c.verdict === 'not-run' && c.category === 'scope') && /模擬テストで確かめた代表条件はありません（対象外の条件 2 件は除く）/.test(l3) && !/実行できていません/.test(l3), `H4-18c: 全部が対象外の not-run のとき: ${JSON.stringify({ l3, cats: finY.verification.behavior.cases.map(c => c.category) })}`);
});
await section(async () => {
  // 統合テストの指摘 13（2026-10-14）: 計画の AI の影響の文は右の「影響範囲」に 1 回（「反映する内容」は設定の手順の件数と JavaScript の登録先の行だけ。二重に並べない）
  const x = makeConvC({ planImpl: planJs1, generate: stagedGenerate({ C1: ['good'] }) });
  await sendUntilAdopt(x);
  const right = rightOf(x), rt = stripC(right);
  const rows = KTAiChatUi.impactRowsOf(x.c.activePlan().final);
  assert(count(rt, /承認待ちの間、金額は変更できません/g) === 1 && /影響範囲/.test(right) && /反映する内容/.test(right) && rows.length === 2 && /設定の変更はありません/.test(rows[0]) && /新しい JavaScript「lock\.js」を登録/.test(rows[1]) && rows.every(r => !/承認待ちの間、金額は変更できません/.test(r)), `H4-19: 影響の文は「影響範囲」に 1 回。「反映する内容」は件数とファイルの行だけ: ${JSON.stringify({ n: count(rt, /承認待ちの間、金額は変更できません/g), rows })}`);
  keep('H4-impact', finalHtml(x), right);
});

// =========================================================
console.log('\n--- §H6. 原因の分類: 生成していない JavaScript の効果の行は「まだ作っていません」。接続先が本当に非対応のときだけ「非対応」 ---');
await section(async () => {
  const gen = stagedGenerate({ C1: ['good'], C2: ['good'], C3: ['throw:TIMEOUT', 'good'] });
  const x = makeConvC({ planImpl: planJs3, generate: gen });
  await sendUntilAdopt(x);
  const v = x.c.activePlan(), fin = v.final;
  const eff = fin.verification.effects;
  assert(fin.incomplete && eff.some(r => r.structure === 'not-generated' && r.behavior === 'untested') && !eff.some(r => r.structure === 'unsupported') && eff.some(r => r.structure === 'present' && r.behavior === 'pass'), `H6-1: 止めた JavaScript の効果の行は not-generated（接続先の非対応にしない）。できた JavaScript の行は合格のまま: ${JSON.stringify(eff.map(r => [r.structure, r.behavior]))}`);
  const rt = stripC(rightOf(x));
  assert(/－ 「金額」（PC）: 編集できない — まだ作っていません・作っていないので確かめていません/.test(rt) && /✓ 「金額」（PC）: 編集できない — 処理あり・模擬テストで合格/.test(rt) && !/接続先が確認に非対応|模擬テストの結果なし/.test(rt), `H6-2: 右の検証の明細は「まだ作っていません」「作っていないので確かめていません」: ${(rt.match(/必須の動作（[\s\S]{0,260}/) || [''])[0]}`);
  const v2 = v; const ap = x.c.approveFinal(K.approveArgs(v2));
  assert(ap.ok === false, 'H6-3: 分類を直しても作成途中の判定は変わらない（承認できない）');
  keep('H6-stop', finalHtml(x), rightOf(x));
});
await section(async () => {
  // 接続先（生成工程）が今の生成の受け渡しに対応していない（health の印が足りない）。2026-10-18: 生成の前の確認で生成を依頼しない（有料の生成をしない）。
  //   作っていないので効果の行は「まだ作っていません」。止めている理由（接続先が非対応）は左の理由と右の JavaScript の状態に出す。承認できない
  const x = makeConvC({ supported: false, generate: makeGenerate({ sequence: ['good'], supported: false }) });
  await sendUntilAdopt(x);
  const v = x.c.activePlan(), fin = v.final, e = v.generated.C1;
  const rt = stripC(rightOf(x)), vis = stripC(outsideDetails(finalHtml(x)));
  assert(x.gen.calls.length === 0 && e.status === 'unsupported' && e.verdict.capability === 'generator' && FS.readyOf(fin) === false && fin.verification.effects.length > 0 && fin.verification.effects.every(r => r.structure === 'not-generated') && /まだ作っていません/.test(rt), `H6-4: 接続先が今の受け渡しに非対応 → 生成を依頼しない（効果の行は「まだ作っていません」）: ${JSON.stringify({ gen: x.gen.calls.length, st: e.status, eff: fin.verification.effects.map(r => r.structure) })}`);
  assert(/確認できないこと／反映を止めている理由/.test(vis) && /接続先（生成工程）が今の Toolkit の生成の受け渡し/.test(vis), `H6-5: 左には止めている理由として接続先の非対応が出る: ${(vis.match(/確認できないこと[\s\S]{0,200}/) || [''])[0]}`);
  //   レビュー 2（2026-10-14）: 右の JavaScript の状態は status ごとの語（unsupported → この接続先では確かめる検査ができません）
  assert(/JavaScript：この接続先では確かめる検査ができません/.test(rt) && !/確認できないことがあります/.test(rt), `H6-6: 右の JavaScript の状態は「この接続先では確かめる検査ができません」: ${(rt.match(/JavaScript の状態[\s\S]{0,80}/) || [''])[0]}`);
  keep('H6-cap', finalHtml(x), rightOf(x));
});

// =========================================================
console.log('\n--- §H7. 別の短い依頼（設定の変更だけ・JavaScript なし。画面）: 同じ構成が自然に読める ---');
await section(async () => {
  const { m, v } = await K.mountFinal({ kind: 'settings' });
  const pre = await K.prepareOnScreen(m);
  const chat = m.chat(), sum = m.$('kt-ai-change-summary').innerHTML;
  const fc = chat.slice(chat.indexOf('class="kt-ai-card kt-ai-final-card"')), fcText = stripC(outsideDetails(fc));
  assert(v && v.final && v.final.customizations.length === 0 && FS.readyOf(v) === true && pre.ready === true, `前提: 設定の変更だけの計画（一覧の追加）で最終案ができ、承認の欄の準備が整った: ${JSON.stringify({ ready: pre.ready, st: pre.pre && pre.pre.status })}`);
  assert(/前の仮案 — このあと直して採用しました/.test(chat) && /仮案 — 採用済み/.test(chat) && !/最終案を作りました/.test(chat) && /課長と部長を申請ごとに選んで承認する流れにできます/.test(chat) && !/実現する動作|こちらの提案で進める点|任意の提案|対応できない範囲|data-act="draft-answer"/.test(chat), 'H7-1: 仮案のカード（採用済みは 1 行に畳む）は返答と選択だけ（同じ構成）');
  assert(/最終案ができました。/.test(fcText) && /この内容で反映できます。/.test(fcText) && pre.button && !pre.button.disabled && pre.button.note === APPLY_NOTE_SETTINGS && /この案で実現すること/.test(fcText), `H7-2: 最終案は「この内容で反映できます。」と反映先の文（設定だけなので「設定の手順を反映」・運用環境は変更しない・反映後の確認先）: ${fcText.replace(/\s+/g, ' ').slice(0, 300)}`);
  assert(!/JavaScript の状態|この案の制約|JavaScript を作/.test(fc + sum) && !/仮案からの補足/.test(fc) && !LEFT_MOVED.test(fcText), `H7-3: JavaScript が無い計画に JavaScript の状態・制約の節は無く、補足も無ければ出さない: ${(fcText.match(LEFT_MOVED) || [''])[0]}`);
  assert(/JavaScript は無く、設定の変更だけです/.test(sum) && /反映する内容/.test(sum) && /設定の手順 1 件（Toolkit から自動で反映できるのは 1 件）/.test(stripC(sum)) && /何が変わるか（Toolkit が確かめた変更前後）/.test(sum), `H7-4: 右の「変更内容」に確かめたこと（JavaScript は無い）・反映する内容・何が変わるか: ${stripC(sum).replace(/\s+/g, ' ').slice(0, 240)}`);
  const left = stripC(outsideDetails(chat));
  assert((left.match(/部長承認は金額に関係なく常に必要ですか/g) || []).length === 0 && (left.match(/この内容で反映できます。/g) || []).length === 1 && (left.match(/kintone にはまだ何も反映していません/g) || []).length <= 1, `H7-5: 左に重複した質問・重複した「反映できます」は無い: ${JSON.stringify({ q: (left.match(/部長承認は金額に関係なく常に必要ですか/g) || []).length })}`);
  keep('H7', chat, sum);
});

// =========================================================
// ---- §H9 / §H9b の部品: 明細（テーブル items）の列（品名・数量・単価）を承認済みで編集不可にする JavaScript。計画の AI は明細の要件（R1）を「行の追加・削除は止められない」として
//   対応できない（unsupported）とし、CSV の保存の要件（R2）も対応できないとした。生成の AI は R1 を PARTIAL（limitCode SUBTABLE_ROWS）と申告し、Toolkit の構造の検査（SUBTABLE_ROWS）も出る。
//   make({ effects: false }) は生成工程の verification に必須の動作の結果（requiredEffects・behavior）を付けない（効果の結果が無い接続先。§H9b）
const H9K = (() => {
  const LABELS_T = { ...K.LABELS_C, items: '明細', item_name: '品名', qty: '数量', unit_price: '単価', subtotal: '小計' };
  const Q_T = ['承認済みでは明細を編集できないようにして', 'CSV の読み込みでも保存を止めたい'];
  const U_T = `${Q_T[0]}。${Q_T[1]}`;
  const scriptT = ({ utterance }) => (utterance === U_T ? { reply: '承認済みのレコードでは明細のセルを編集できないようにします。CSV の読み込みの保存は計画で確かめます。', intent: 'propose',
    proposal: { behaviors: [B('承認済みでは明細を編集できないようにする', 'user'), B('CSV の読み込みでも保存を止める', 'user')], assumptions: [], decisions: [], approach: { standard: [], js: ['承認済みでは明細のセルの編集を止める'] }, cannot: [] },
    turn: { ops: [], answers: [], requirementOps: [K.req('add', { target: '明細', condition: '承認済み', behavior: '編集できないようにする', sourceQuotes: [Q_T[0]], planRefs: ['B1'], effects: ['lock'] }), K.req('add', { target: '保存', condition: 'CSV の読み込み', behavior: '保存を止める', sourceQuotes: [Q_T[1]], planRefs: ['B2'], effects: ['block-save'] })] } } : null);
  const ST_DONE = "record['ステータス'] && record['ステータス'].value === '承認済み'";
  const TABLE3 = K.handlerC(`    if (${ST_DONE}) {\n      record['items'].value.forEach(function (row) {\n        row.value['item_name'].disabled = true;\n        row.value['qty'].disabled = true;\n        row.value['unit_price'].disabled = true;\n      });\n    }`);
  const COLS = ['item_name', 'qty', 'unit_price'];
  const CUST_T3 = K.custOf(null, { requirement: '承認済みでは明細（items）のセルを編集できないようにする', fields: [{ code: 'ステータス', access: 'READ' }, ...COLS.map(code => ({ code, access: 'CONTROL', condition: 'ステータス in ("承認済み")', effects: ['lock'] }))] });
  const planT = (args) => K.planJs(args, { cust: CUST_T3, summary: '承認済みでは明細のセルを編集できないようにします。', requirementOps: [
    K.req('update', { id: 'R1', target: '明細', condition: '承認済み', behavior: '編集できないようにする', disposition: 'unsupported', note: '行の追加・削除は止められないため', sourceQuotes: [Q_T[0]], planRefs: ['C1'], effects: ['lock'] }),
    K.req('update', { id: 'R2', target: '保存', condition: 'CSV の読み込み', behavior: '保存を止める', disposition: 'unsupported', note: 'CSV の読み込みでは JavaScript が動かないため', sourceQuotes: [Q_T[1]], planRefs: [], effects: ['block-save'] }),
  ] });
  const REQ_TEXT_FULL = 'PC: 承認済み。PC・モバイルの両方：明細を編集できないようにする';
  //   2026-10-16（説明文を読みやすくする）: 実現した部分の条件は、満たした必須の動作の構造化した条件式（ステータス in ("承認済み")）の文。制約の行は「本体（画面）。理由。」
  const SENT = '「ステータス」が「承認済み」の場合、明細の品名・数量・単価を編集できなくします（PC）。';
  const ROWS = '明細の行の追加・削除は防ぎません';
  const ROW_LINE = '明細の行の追加・削除は防ぎません（PC）。入力欄（セル）の編集不可だけでは止められず、行のボタンを隠す API は Toolkit がまだ扱っていません。';
  const make = ({ effects = true } = {}) => {
    const genT = { calls: [], impl: async (args) => {
      genT.calls.push(args.customizationId);
      const cust = args.version.plan.customizations[0];
      const generated = { strategy: 'NEW_JS_FILE', targetFile: 'tableLock.js', summary: '承認済みでは明細のセルを編集できないようにします。', code: TABLE3, patch: null, events: ['app.record.edit.show'], fields: COLS.map(code => ({ code, access: 'CONTROL' })), apis: [], assumptions: [], warnings: [],
        coverage: [{ requirementId: 'C1', status: 'MET', note: '', text: cust.requirement }, { requirementId: 'R1', status: 'PARTIAL', note: '行の追加・削除は止められません', text: REQ_TEXT_FULL, limitCode: 'SUBTABLE_ROWS' }] };
      const review = T.KTCodeReview.review({ generated, customization: cust, plan: args.version.plan, data: clone(K.DATA_C), scan: null, existingSource: null, requirements: [{ id: 'R1', planRefs: ['C1'] }, { id: 'R2', planRefs: [] }] });
      const candidateHash = gwCandidateHash({ strategy: 'NEW_JS_FILE', targetFile: 'tableLock.js', code: TABLE3, patch: null, customizationId: 'C1' });
      return { ok: true, generated, review, ctx: { size: { approxTokens: 1000 } }, existingSource: null, inputHash: 'hT', verification: K.fakeVerification({ code: TABLE3, has: { item_name: ['lock'], qty: ['lock'], unit_price: ['lock'] } }, args.requiredEffects, { candidateHash, supported: effects }), candidateHash, requirementIds: [{ id: 'C1', kind: 'customization', text: cust.requirement }] };
    } };
    const x = makeConvC({ scriptFn: scriptT, labels: LABELS_T, planImpl: planT, generate: genT });
    x.services.tableColumns = () => ({ item_name: 'items', qty: 'items', unit_price: 'items', subtotal: 'items' });
    x.services.readOnlyFields = () => ['subtotal'];
    return { x, genT };
  };
  return { Q_T, U_T, REQ_TEXT_FULL, SENT, ROWS, ROW_LINE, make };
})();

// =========================================================
console.log('\n--- §H9. 部分対応を「できないこと」に丸ごと入れない（2026-10-15 §4(b)）: 実現した部分は実現することへ・制約は残る範囲だけ・計画では対応できないとされた要件は実現のある要件では出さない ---');
await section(async () => {
  const { Q_T, U_T, REQ_TEXT_FULL, SENT, ROWS, ROW_LINE } = H9K;
  const { x, genT } = H9K.make();
  await x.c.send(U_T);
  await x.c.send('採用します');
  const v = x.c.activePlan(), fin = v && v.final, e = v && v.generated && v.generated.C1;
  const na = e && e.review && e.review.coverage ? e.review.coverage.notAchieved : [];
  const reqsT = v ? x.c.requirements(v.planId) : [];
  assert(fin && e && e.status === 'verified' && genT.calls.length === 1 && x.calls.plan.length === 1 && na.some(r => r.code === 'SUBTABLE_ROWS' && JSON.stringify(r.tables) === '["items"]') && na.some(r => r.code === 'AI_PARTIAL' && r.requirementId === 'R1' && r.limit === 'SUBTABLE_ROWS') && reqsT.some(r => r.id === 'R1' && r.decision === 'decided' && r.disposition === 'unsupported') && reqsT.some(r => r.id === 'R2' && r.decision === 'decided' && r.disposition === 'unsupported'), `前提: セルは検証済み・構造の SUBTABLE_ROWS（テーブル items）と AI の PARTIAL（R1・limitCode）・計画は R1 / R2 を対応できないとした: ${JSON.stringify({ st: e && e.status, na: na.map(r => [r.code, r.requirementId, r.tables, r.limit]), reqs: reqsT.map(r => [r.id, r.decision, r.disposition]) })}`);
  const h = finalHtml(x), vis = stripC(outsideDetails(h)), right = rightOf(x), rt = stripC(right);
  const doSec =(vis.match(/この案で実現すること[\s\S]*?(?=この案の制約|仮案からの補足|動作テスト環境へ反映)/) || [''])[0];
  //   2026-10-15（最終案の重複と担当未定の食い違い §1）: 実現した部分の 1 文（列の名前の列挙を含む）は右の「最終的にどう動くか」だけ。左は採用した仮案の動作で言う（重ねない）
  assert(!fin.adoptedBehaviors.includes(SENT) && fin.behaviors.includes(SENT) && !doSec.includes(SENT) && /承認済みでは明細を編集できないようにする/.test(doSec) && (vis.match(/を編集できなくします/g) || []).length === 0 && rt.includes('最終的にどう動くか') && rt.indexOf(SENT) > rt.indexOf('最終的にどう動くか'), `H9-1: 実現した部分（満たした必須の動作）は右の「最終的にどう動くか」に 1 文（左は採用した動作だけ）: ${doSec.replace(/\s+/g, ' ').slice(0, 240)} ／ behaviors: ${JSON.stringify(fin && fin.behaviors)}`);
  const conSec =(vis.match(/この案の制約[\s\S]*?(?=仮案からの補足|動作テスト環境へ反映)/) || [''])[0];
  assert(fin.constraints.some(c => c.kind === 'coverage' && c.text === ROWS && c.requirementId === 'R1') && fin.constraints.filter(c => c.kind === 'coverage').length === 1 && conSec.includes(ROW_LINE) && !/PC・モバイルの両方|承認済み。/.test(vis) && !vis.includes(REQ_TEXT_FULL) && !/行の追加・削除は止められません/.test(vis), `H9-2: 制約はテーブルの名前で「残る範囲」だけ（AI の PARTIAL の行は構造の行にまとめ、要件の全文は付けない）: ${conSec.replace(/\s+/g, ' ').slice(0, 300)}`);
  assert(!fin.cannot.some(c => c.kind === 'req-unsupported' && c.requirementId === 'R1') && !vis.includes(`計画では対応できないとされた要件: ${Q_T[0]}`) && !rt.includes(`計画では対応できないとされた要件: ${Q_T[0]}`), `H9-3: 実現のある要件（R1）は「計画では対応できないとされた要件」に出さない: ${(vis.match(/計画では対応できないとされた要件[^\n]*/g) || []).join(' / ')}`);
  const unsup = fin.cannot.find(c => c.kind === 'req-unsupported' && c.requirementId === 'R2');
  assert(unsup && unsup.text === `計画では対応できないとされた要件: ${Q_T[1]}（理由: CSV の読み込みでは JavaScript が動かないため）` && conSec.includes(unsup.text), `H9-4: 何も実現していない要件（R2）は今の文で残る: ${JSON.stringify(unsup)}`);
  const ap = x.c.approveFinal(K.approveArgs(v));
  assert(FS.readyOf(fin) === true && fin.blockers.length === 0 && ap.ok === true && !/確認できないこと／反映を止めている理由/.test(vis), `H9-5: 承認の可否は変わらない（判定は表示で変えない）: ${JSON.stringify({ approvable: FS.readyOf(fin), blockers: fin.blockers, ap })}`);
  keep('H9', h, right);
});

// =========================================================
console.log('\n--- §H9b. 実現した部分の 1 文を作れない変形（効果の結果が無い接続先 = verification に requiredEffects が無い。2026-10-15 レビューの反映 T5）: 計画では対応できないとされた要件は今の文で残す ---');
await section(async () => {
  //   §H9 と同じ依頼・計画・生成の AI の申告（R1 PARTIAL・limitCode SUBTABLE_ROWS・構造の SUBTABLE_ROWS）。違いは生成工程の verification に必須の動作の結果（requiredEffects・behavior）が無いこと。
  //   満たした必須の動作が分からないので実現した部分の 1 文は作れず、R1 は「計画では対応できないとされた要件」に残る（未達を見失わない）。承認の可否は接続先の非対応で決まる（表示では変えない）
  const { Q_T, U_T, ROWS } = H9K;
  const { x, genT } = H9K.make({ effects: false });
  await x.c.send(U_T);
  await x.c.send('採用します');
  const v = x.c.activePlan(), fin = v && v.final, e = v && v.generated && v.generated.C1;
  const na = e && e.review && e.review.coverage ? e.review.coverage.notAchieved : [];
  assert(fin && e && genT.calls.length === 1 && !(e.verification && e.verification.requiredEffects) && na.some(r => r.code === 'SUBTABLE_ROWS') && na.some(r => r.code === 'AI_PARTIAL' && r.requirementId === 'R1'), `前提: 生成工程の verification に必須の動作の結果が無い。構造の SUBTABLE_ROWS と AI の PARTIAL（R1）は §H9 と同じ: ${JSON.stringify({ st: e && e.status, re: !!(e && e.verification && e.verification.requiredEffects), na: na.map(r => [r.code, r.requirementId]) })}`);
  const h = finalHtml(x), vis = stripC(h), right = rightOf(x), rt = stripC(right);
  assert(!fin.behaviors.some(s => /を編集できなくします/.test(s)) && !fin.adoptedBehaviors.some(s => /を編集できなくします/.test(s)) && !/を編集できなくします/.test(vis + rt), `H9b-1: 満たした必須の動作が分からないので、実現した部分の 1 文は作らない: ${JSON.stringify(fin.behaviors)}`);
  const unsupR1 = fin.cannot.find(c => c.kind === 'req-unsupported' && c.requirementId === 'R1');
  assert(unsupR1 && unsupR1.text === `計画では対応できないとされた要件: ${Q_T[0]}（理由: 行の追加・削除は止められないため）` && fin.cannot.some(c => c.kind === 'req-unsupported' && c.requirementId === 'R2'), `H9b-2: 文を作れなかった PARTIAL の要件（R1）は「計画では対応できないとされた要件」に今の文で残る（R2 も今のまま）: ${JSON.stringify(fin.cannot.filter(c => c.kind === 'req-unsupported').map(c => [c.requirementId, c.text]))}`);
  assert(fin.constraints.some(c => c.kind === 'coverage' && c.text === ROWS && c.requirementId === 'R1') && !vis.includes(H9K.REQ_TEXT_FULL), `H9b-3: 制約の行（テーブルの名前の「残る範囲」）は §H9 と同じ: ${JSON.stringify(fin.constraints.map(c => [c.kind, c.requirementId, c.text]))}`);
  assert(e.status === 'unsupported' && FS.readyOf(fin) === false && fin.blockers.some(b => b.kind === 'unsupported' && /接続先/.test(b.text)) && x.c.approveFinal(K.approveArgs(v)).ok === false, `H9b-4: 承認の可否は接続先の非対応（必須の動作の結果が無い）で決まる（表示では変えない）: ${JSON.stringify({ st: e.status, approvable: FS.readyOf(fin), blockers: fin.blockers.map(b => [b.kind, b.text]) })}`);
  keep('H9b', h, right);
});

// =========================================================
console.log('\n--- §H10. 待ち時間の総経過は壁時計のまま（2026-10-15 §4(c)。凍結の時間を引かない） ---');
await section(async () => {
  const pg = gateMk();
  const x = makeConvC({ planImpl: planJs1, generate: stagedGenerate({ C1: ['good'] }), planGate: pg });
  for (const s of K.REQUESTS.slice(0, 3)) await x.c.send(s);
  const p = x.c.send(K.REQUESTS[3]);
  await ticks(6);
  x.advance(600000);   // 計画の応答待ちの間に 10 分（隠れたタブの凍結を模す）
  x.c.tickProgress();
  const h0 = stripC(KTAiChatUi.progressInnerHtml(x.last()));
  pg.open(); await p; await ticks(6);
  const v = x.c.activePlan(), fin = v && v.final, tm = fin && fin.timing;
  const dy = stripC(finalHtml(x));
  assert(/経過 10 分/.test(h0) && tm && tm.totalMs === 650000 && tm.planMs === 630000 && tm.generateMs === 20000 && tm.totalMs === x.c.metrics().timings.slice(-1)[0].finalMs && /最終案まで 10 分 50 秒（計画 10 分 30 秒・生成・検証 20 秒）/.test(dy), `H10-1: 進みのカードの経過と最終案までの時間は壁時計（10 分の停止を引かない）: ${JSON.stringify({ h0: (h0.match(/経過[^）]*/) || [''])[0], tm })}`);
});

// =========================================================
console.log('\n--- §H11. 詳細（時間と AI の利用）: 仮案の返答の時間と、Gateway の処理時間との差が 10 秒以上のときだけ分ける（2026-10-15 §4(d)） ---');
await section(async () => {
  const planG = (args) => { const r = planJs1(args); r.plan.ai = { model: 'm', latencyMs: 2000, usage: { input_tokens: 500, output_tokens: 200 } }; return r; };
  const base = stagedGenerate({ C1: ['good'] });
  const gen = { calls: base.calls, impl: async (args) => { const r = await base.impl(args); r.generated.timing = { version: '1', totalMs: 15000, ai: { count: 1, ms: 14000, repairs: 0 }, calls: [{ kind: 'generate', attempt: 0, ms: 14000, ok: true, inputTokens: 1000, outputTokens: 300 }], behavior: { ms: 500, runs: 1, calls: 2 } }; return r; } };
  const x = makeConvC({ planImpl: planG, generate: gen });
  //   AI の adopt で計画が始まる送信（同じ送信に仮案の返答 propose を含む）: 「おすすめで」で中間の判断を決めてから「通知は不要、期限は5営業日、ほかは採用」
  for (const s of K.REQUESTS.slice(0, 3)) await x.c.send(s);
  await x.c.send('おすすめで');
  const r = await x.c.send('通知は不要、期限は5営業日、ほかは採用');
  const v = x.c.activePlan(), fin = v && v.final, tm = fin && fin.timing;
  const detail = stripC((finalHtml(x).match(/<details class="kt-ai-tech"[^>]*><summary>詳細（時間と AI の利用）<\/summary>[\s\S]*?<\/details>/) || [''])[0]);
  assert(r.ok && r.draft && r.draft.intent === 'adopt' && fin && FS.readyOf(fin) === true && tm.proposeMs === 7000 && tm.planMs === 30000 && tm.generateMs === 20000 && tm.gatewayMs && tm.gatewayMs.plan === 2000 && tm.gatewayMs.generate === 15000 && tm.gatewayMs.planAuto === null && tm.calls.find(c => c.kind === 'plan').gatewayMs === 2000 && tm.calls.find(c => c.kind === 'generate').gatewayMs === 15000 && tm.totalMs >= tm.proposeMs + tm.planMs + tm.generateMs, `H11-1: fin.timing に仮案の返答（proposeMs）と部ごとの Gateway の処理時間（gatewayMs）が入り、総経過は壁時計（部の和以上）: ${JSON.stringify(tm)}`);
  assert(/最終案まで 57 秒（仮案の返答 7 秒、計画 30 秒（Gateway の処理 2 秒・画面への反映までの遅れ 28 秒）、生成・検証 20 秒）/.test(detail) && !/生成・検証 20 秒（/.test(detail) && !/秒・計画|秒）・生成/.test(detail), `H11-2: 差が 10 秒以上の計画だけ分けて書き、差が小さい生成は今のまま。仮案の返答も部に出す（総経過と部が合う）。括弧の分割がある部があれば外側の区切りは「、」（2026-10-15 T6）: ${detail.replace(/\s+/g, ' ').slice(0, 220)}`);
  //   Gateway の処理時間が分からない（古い Gateway: ai が無い・生成工程の timing が無い）ときは今のまま（分けない）。仮案の返答の無い送信では出さない
  const y = makeConvC({ planImpl: planJs1, generate: stagedGenerate({ C1: ['good'] }) });
  await sendUntilAdopt(y);
  const ty = y.c.activePlan().final.timing, dy = stripC(finalHtml(y));
  assert(ty.gatewayMs.plan === null && ty.gatewayMs.generate === null && ty.proposeMs === null && /最終案まで 50 秒（計画 30 秒・生成・検証 20 秒）/.test(dy) && !/Gateway の処理|画面への反映までの遅れ|仮案の返答/.test(dy), `H11-3: Gateway の処理時間が分からなければ今のまま（分けない・仮案の返答の無い送信では出さない）: ${(dy.match(/最終案まで[^\n]*/) || [''])[0]}`);
  keep('H11', finalHtml(x), rightOf(x));
});

// =========================================================
console.log('\n--- §H8. すべての新しい文（左の通常表示・右の「変更内容」）に内部の語が無い ---');
await section(async () => {
  for (const s of SHOWN) {
    assert(!INTERNAL_IN_CHAT.test(s.left), `H8-${s.tag}: 左に内部の語が無い: ${(s.left.match(INTERNAL_IN_CHAT) || [''])[0]}`);
    assert(!INTERNAL_IN_CHAT.test(s.right), `H8-${s.tag}: 右に内部の語が無い: ${(s.right.match(INTERNAL_IN_CHAT) || [''])[0]}`);
  }
});

console.log(`\n${state.failed === 0 ? 'ALL PASSED' : 'FAILED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed === 0 ? 0 : 1);
})();
