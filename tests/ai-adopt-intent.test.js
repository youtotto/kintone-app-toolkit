// 修正コメントを採用として扱わない（2026-10-15 §3.2。有料の AI は使わない。Gateway の応答は模擬）
//
// 検証内容:
//   §A1（2026-10-23・§12.61 で削除）: 進行の語句（adoptQuote）の照合（空・発言に無い adopt → update）は Gateway の validate-proposal-response が同じ発言で行う（AI版 worker/test/cases/toolkit-proposal.mjs）。Toolkit は繰り返さない。
//        キーが無い古い Gateway では今のまま（adopt のまま）。照合は空白・句読点を除いた部分一致・2 文字以上
//   §A2 (1) 修正の指示だけの発言「承認者は今のまま、ステータスを一つ追加してください」+ 模擬 update → 計画 0・仮案が更新・［採用］が残る。
//        同じ発言に模擬が adopt（adoptQuote ""）→ Toolkit が update に下げ、計画 0。adoptQuote が発言に無い語句でも同じ。古い Gateway（キー無し）の adopt は今のまま採用
//   §A3 (2)「この案で進めて」→ 計画 1 回（既存の語句の経路 = AI を呼ばない）。AI の経路（模擬 adopt + adoptQuote「この案で進めて」が発言にある）でも計画 1 回
//   §A4 (3)「承認者は今のままで。この内容で進めて」+ 模擬 adopt + ops modify + adoptQuote → ops が反映されてから計画 1 回だけ
//   §A5 (4) 開いている質問に「はい」→ DRAFT_REPLY で AI へ（模擬 answers）→ 回答が記録・計画 0。「おまかせ」→ recommended が記録・計画 0・［採用］が残る・質問を増やさない・返答は 1 文
//   §A6 (5) 判別できない発言 + 模擬 update → 仮案の更新だけ・「採用ですか」の文が無い
//   §A7 classifyDraft の決定的な前段: 「おすすめで」だけは記録だけ（GENERAL / DELEGATE_ONLY）・進行の語句と組なら採用・素の「はい」は開いている判断があれば DRAFT_REPLY。
//        2026-10-15 レビューの反映 T3: 委ねる言い方と同じ文の「進めて（ください）」（DRAFT_ADOPT の進めての語群）は進行の語句（「おまかせで進めてください」→ 記録した上で採用。A5-7・A7-6・A7-7）
//
// 実行方法: node tests/ai-adopt-intent.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTAiConversation, KTAiClient, KTAiChatUi } = T;
const { assert, state } = makeAssert();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { makeConvC, B, A, Q, req, idBy, META, stripC } = K;
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
const I = KTAiConversation.INTENT;
// tests/ai-two-pane.test.js の INTERNAL_IN_CHAT と同じ（内部の番号・処理の通知）
const INTERNAL_IN_CHAT = /\bv[0-9]+\b|requestId|\bR[0-9]+「|\bQ[0-9]+[：:]|\[E[0-9]+\]|［\s*E[0-9]+|【\s*E[0-9]+|\[\s*E[0-9]+\s*[・、,]|Toolkit の確認|Code Review|VERIFIED|snapshot|受け付けました|台帳|を検証しました|kt-ai-who">(Toolkit|SYSTEM)</;

// ---- 部品: 短い仮案（承認済みでは金額を編集できないようにする）と、場合ごとの Gateway の模擬の応答 ----
const U0 = '承認済みのレコードは金額を編集できないようにしたい';
const U_FIX = '承認者は今のまま、ステータスを一つ追加してください';
const U_BOTH = '承認者は今のままで。この内容で進めて';
const U_AI_ADOPT = 'よさそうなので、この案で進めて';
const U_VAGUE = '金額の編集はそのままでもいい気がする';
const B_LOCK = B('承認済みでは金額を編集できないようにする', 'user');
const A_APPROVER = A('approval.approver', '承認者', '承認者は今のまま（課長）', '部長に変えることもできます');
const Q_SCOPE = Q('lock.scope', '編集不可の対象', '申請者本人も編集できなくしますか', ['全員', '申請者以外'], '全員', '申請者が承認済みの後に直せるかが変わります', false);
const empty = () => ({ behaviors: [], assumptions: [], decisions: [], approach: { standard: [], js: [] }, cannot: [] });
const noTurn = () => ({ ops: [], answers: [], requirementOps: [] });
/**
 * 模擬の Gateway の台本。mode = 応答の種類:
 *   update（修正の指示は update。adoptQuote ""）/ adopt-empty（修正の指示に adopt・adoptQuote ""）/ adopt-foreign（adopt・adoptQuote は発言に無い語句）/
 *   adopt-legacy（adopt・adoptQuote キー無し = 古い Gateway）/ both（修正 ＋ 進行: adopt・ops modify・adoptQuote「この内容で進めて」）/
 *   ai-adopt（進行の語句を AI が読んだ: adopt・adoptQuote「この案で進めて」）/ answer（「はい」を開いている判断への答えに）/ vague（判別できない: update・仮案は同じ）
 * withQuestion = 最初の仮案に開いている判断（推奨あり）を付ける
 */
function scriptOf({ mode = 'update', withQuestion = false } = {}) {
  return ({ utterance: u, previous: p }) => {
    const prevA = (p && p.assumptions) || [], prevD = (p && p.decisions) || [];
    if (u === U0) return { reply: '承認済みのレコードでは金額を編集できないようにします。承認者は今のままにします。', intent: 'propose', adoptQuote: '', proposal: { behaviors: [B_LOCK], assumptions: [A_APPROVER], decisions: withQuestion ? [Q_SCOPE] : [], approach: { standard: [], js: ['承認済みのステータスで金額の編集を止める'] }, cannot: [] },
      turn: { ops: [], answers: [], requirementOps: [req('add', { target: '金額', condition: '承認済み', behavior: '編集できないようにする', sourceQuotes: [U0], planRefs: ['B1'], effects: ['lock'] })] } };
    const fixed = { behaviors: [B_LOCK, B('ステータスを一つ追加する', 'user')], assumptions: [A_APPROVER], decisions: withQuestion ? [Q_SCOPE] : [], approach: { standard: ['ステータスの追加'], js: ['承認済みのステータスで金額の編集を止める'] }, cannot: [] };
    const fixOps = [{ id: idBy(prevA, a => a.key === 'approval.approver'), op: 'adopt', text: '', quote: '承認者は今のまま' }];
    const fixReq = [req('add', { target: 'ステータス', condition: '', behavior: 'ステータスを一つ追加する', sourceQuotes: ['ステータスを一つ追加してください'], planRefs: ['B2'] })];
    if (u === U_FIX) {
      if (mode === 'adopt-legacy') return { reply: '承認者は今のまま、ステータスを一つ追加します。', intent: 'adopt', proposal: fixed, turn: { ops: fixOps, answers: [], requirementOps: fixReq } };
      const adoptish = mode === 'adopt-empty' || mode === 'adopt-foreign';
      return { reply: '承認者は今のまま、ステータスを一つ追加します。', intent: adoptish ? 'adopt' : 'update', adoptQuote: mode === 'adopt-foreign' ? 'この案で進めて' : '', proposal: fixed, turn: { ops: fixOps, answers: [], requirementOps: fixReq } };
    }
    if (u === U_BOTH) return { reply: '承認者は今のままで進めます。', intent: 'adopt', adoptQuote: 'この内容で進めて', proposal: { ...fixed, behaviors: [B_LOCK], assumptions: [A('approval.approver', '承認者', '承認者は今のまま（課長。変更しない）', '')], approach: { standard: [], js: ['承認済みのステータスで金額の編集を止める'] } },
      turn: { ops: [{ id: idBy(prevA, a => a.key === 'approval.approver'), op: 'modify', text: '承認者は今のまま（課長。変更しない）', quote: '承認者は今のままで' }], answers: [], requirementOps: [] } };
    if (u === U_AI_ADOPT) return { reply: 'この案で進めます。', intent: 'adopt', adoptQuote: 'この案で進めて', proposal: { behaviors: [B_LOCK], assumptions: [A_APPROVER], decisions: [], approach: { standard: [], js: ['承認済みのステータスで金額の編集を止める'] }, cannot: [] }, turn: noTurn() };
    if (u === 'はい') return { reply: '申請者本人も編集できなくします。', intent: 'update', adoptQuote: '', proposal: { behaviors: [B_LOCK], assumptions: [A_APPROVER, A('lock.scope', '編集不可の対象', '申請者本人も編集できなくする（全員）', '申請者以外にもできます')], decisions: [], approach: { standard: [], js: ['承認済みのステータスで金額の編集を止める'] }, cannot: [] },
      turn: { ops: [], answers: [{ id: idBy(prevD, d => d.key === 'lock.scope'), kind: 'value', text: '全員', quote: 'はい' }], requirementOps: [] } };
    if (u === U_VAGUE) return { reply: '金額の編集を止める案のままにしています。変えたい点があれば書いてください。', intent: 'update', adoptQuote: '', proposal: { behaviors: [B_LOCK], assumptions: [A_APPROVER], decisions: withQuestion ? [Q_SCOPE] : [], approach: { standard: [], js: ['承認済みのステータスで金額の編集を止める'] }, cannot: [] }, turn: noTurn() };
    return null;
  };
}
/** 会話コントローラ（偽 services。計画は K.planJs。生成は既定の検証済みの候補） */
const convOf = (o = {}) => makeConvC({ scriptFn: scriptOf(o), planImpl: o.planImpl || ((args) => K.planJs(args)) });
/** 最新の仮案のカードの HTML（［採用］の有無を見る） */
const draftCardOf = (x) => { const m = x.c.messages().filter(mm => mm.type === 'DRAFT').slice(-1)[0]; return m ? KTAiChatUi.messageHtml(m, { draft: x.c.draft(), draftDecisions: x.c.draftDecisions(), draftAnswers: new Map() }) : ''; };
const chatOf = (x) => KTAiChatUi.chatHtml(x.c.messages(), { draft: x.c.draft(), draftDecisions: x.c.draftDecisions(), draftAnswers: new Map() });
const outsideDetails = (html) => String(html).replace(/<details[\s\S]*?<\/details>/g, '');

(async () => {
// =========================================================

// =========================================================
console.log('\n--- §A2. (1) 修正の指示だけの発言は採用にしない（模擬 update。模擬 adopt の下げは AI サービスの仕事） ---');
await section(async () => {
  const x = convOf({ mode: 'update' });
  await x.c.send(U0);
  const d1 = x.c.draft();
  assert(d1 && d1.status === 'open' && d1.rev === 1 && x.calls.plan.length === 0 && /data-act="draft-adopt"/.test(draftCardOf(x)), '前提: 最初の仮案（rev 1・［採用］あり）');
  const r = await x.c.send(U_FIX);
  const d2 = x.c.draft();
  assert(r.ok && r.intent === I.DRAFT_REPLY && r.draft && r.draft.intent === 'update' && d2.status === 'open' && d2.rev === 2 && d2.items.behaviors.some(b => /ステータスを一つ追加する/.test(b.text)) && x.calls.plan.length === 0 && x.calls.propose.length === 2, `A2-1: 修正の指示 + 模擬 update → 計画の呼び出し 0・仮案が更新（rev 2）: ${JSON.stringify({ intent: r.intent, draft: r.draft, plan: x.calls.plan.length })}`);
  assert(/data-act="draft-adopt"/.test(draftCardOf(x)) && !/仮案 — 採用済み/.test(chatOf(x)) && !INTERNAL_IN_CHAT.test(outsideDetails(chatOf(x)).replace(/data-[a-z]+="[^"]*"/g, '')), 'A2-2: ［採用］が残る（採用済みの見出しは無い）・内部の語は無い');
});

// =========================================================
console.log('\n--- §A3. (2)「この案で進めて」→ 計画 1 回（既存の語句の経路でも、AI の経路の adopt + adoptQuote でも） ---');
await section(async () => {
  const x = convOf({ mode: 'update' });
  await x.c.send(U0);
  const r = await x.c.send('この案で進めて');
  const v = x.c.activePlan();
  assert(r.ok && r.intent === I.ADOPT_DRAFT && r.reason === 'ADOPT_WORDS' && x.calls.propose.length === 1 && x.calls.plan.length === 1 && x.c.draft().status === 'adopted' && v && v.final, `A3-1: 既存の進行の語句は AI を呼ばずに採用 → 計画 1 回: ${JSON.stringify({ intent: r.intent, reason: r.reason, propose: x.calls.propose.length, plan: x.calls.plan.length })}`);
  const y = convOf({ mode: 'ai-adopt' });
  await y.c.send(U0);
  const ry = await y.c.send(U_AI_ADOPT);
  assert(ry.ok && ry.intent === I.DRAFT_REPLY && ry.draft && ry.draft.intent === 'adopt' && y.calls.propose.length === 2 && y.calls.plan.length === 1 && y.c.draft().status === 'adopted' && y.c.draft().adoptedBy === 'AI_ADOPT', `A3-2: AI の経路（模擬 adopt + adoptQuote「この案で進めて」が発言にある）でも計画 1 回: ${JSON.stringify({ intent: ry.intent, draft: ry.draft, plan: y.calls.plan.length })}`);
  assert(/仮案 — 採用済み/.test(chatOf(y)) && !/最終案を作りました|最終案を作っています/.test((chatOf(y).match(/仮案 — 採用済み[^<]*/) || [''])[0]), `A3-3: 採用した仮案の見出しは「仮案 — 採用済み」（2026-10-15 §4(a)）: ${(chatOf(y).match(/仮案 — 採用済み[^<]*/) || [''])[0]}`);
});

// =========================================================
console.log('\n--- §A4. (3) 修正と進行の両方「承認者は今のままで。この内容で進めて」→ ops を反映してから計画 1 回だけ ---');
await section(async () => {
  const seen = [];
  const x = convOf({ mode: 'both', planImpl: (args) => { seen.push({ assumption: x.c.draft().items.assumptions[0].text, rev: x.c.draft().rev }); return K.planJs(args); } });
  await x.c.send(U0);
  const r = await x.c.send(U_BOTH);
  const d = x.c.draft(), h = d.history.slice(-1)[0];
  assert(r.ok && r.intent === I.DRAFT_REPLY && r.draft && r.draft.intent === 'adopt' && x.calls.plan.length === 1 && d.status === 'adopted' && d.rev === 2, `A4-1: 修正と進行の両方 → adopt（計画 1 回だけ）: ${JSON.stringify({ intent: r.intent, draft: r.draft, plan: x.calls.plan.length, status: d.status })}`);
  assert(h && h.applied.modified.length === 1 && d.items.assumptions[0].text === '承認者は今のまま（課長。変更しない）' && seen.length === 1 && seen[0].rev === 2 && seen[0].assumption === '承認者は今のまま（課長。変更しない）', `A4-2: ops（modify）が仮案に反映されてから計画を呼ぶ: ${JSON.stringify({ applied: h && h.applied, seen })}`);
});

// =========================================================
console.log('\n--- §A5. (4) 開いている質問への「はい」は AI へ（回答の記録・計画 0）。「おまかせ」は推奨を記録するだけ（計画 0・［採用］が残る・質問を増やさない） ---');
await section(async () => {
  const x = convOf({ mode: 'answer', withQuestion: true });
  await x.c.send(U0);
  const open0 = KTAiConversation.openDraftDecisions(x.c.draft(), x.c.draftDecisions());
  assert(open0.length === 1 && open0[0].key === 'lock.scope', '前提: 開いている判断 1 件（推奨あり）');
  const r = await x.c.send('はい');
  const dec = x.c.draftDecisions().find(d => d.key === 'lock.scope');
  assert(r.ok && r.intent === I.DRAFT_REPLY && r.reason === 'ACK_WITH_OPEN' && x.calls.propose.length === 2 && dec && dec.kind === 'value' && dec.answer === '全員' && x.calls.plan.length === 0 && x.c.draft().status === 'open' && KTAiConversation.openDraftDecisions(x.c.draft(), x.c.draftDecisions()).length === 0, `A5-1: 素の「はい」は開いている判断への答えとして AI へ（模擬 answers）→ 回答が記録・計画 0: ${JSON.stringify({ intent: r.intent, reason: r.reason, dec, plan: x.calls.plan.length })}`);
  const seenPlan = [];
  const y = convOf({ mode: 'answer', withQuestion: true, planImpl: (args) => { seenPlan.push(Array.isArray(args.decisions) ? args.decisions : []); return K.planJs(args); } });
  await y.c.send(U0);
  const ry = await y.c.send('おまかせ');
  const decY = y.c.draftDecisions().find(d => d.key === 'lock.scope');
  const card = draftCardOf(y), chat = chatOf(y);
  assert(ry.ok && ry.intent === I.GENERAL && ry.reason === 'DELEGATE_ONLY' && y.calls.propose.length === 1 && y.calls.plan.length === 0 && decY && decY.kind === 'delegated' && decY.answer === '全員' && y.c.draft().status === 'open' && y.c.draft().rev === 1, `A5-2:「おまかせ」は推奨（recommended）を決定事項に記録するだけ（AI も計画も呼ばない・仮案は open のまま）: ${JSON.stringify({ intent: ry.intent, reason: ry.reason, dec: decY, plan: y.calls.plan.length })}`);
  assert(/data-act="draft-adopt"/.test(card) && KTAiConversation.openDraftDecisions(y.c.draft(), y.c.draftDecisions()).length === 0 && y.last().text === 'おすすめの内容で決めました。' && y.last().data && y.last().data.kind === 'draft-delegated' && !/[？?]/.test(y.last().text), `A5-3: ［採用］が残る・開いている判断は 0・返答は 1 文「おすすめの内容で決めました。」（質問はしない）: ${y.last().text}`);
  const right = KTAiChatUi.draftSummaryHtml(y.c.draft(), { decisions: y.c.draftDecisions() });
  assert(/<b>決めたこと<\/b>/.test(right) && /編集不可の対象 → 全員（おまかせ）/.test(stripC(right)) && /残っている判断はありません/.test(right) && !INTERNAL_IN_CHAT.test(outsideDetails(chat).replace(/data-[a-z]+="[^"]*"/g, '')), `A5-4: 右の仮案の詳細に「決めたこと」（おまかせ）が入り、必要な判断は残らない。会話に内部の語は無い: ${stripC(right).replace(/\s+/g, ' ').slice(0, 200)}`);
  //   「おまかせ」の後に「採用します」で採用（記録した推奨は委ねた印で計画の AI に渡る）
  const ra = await y.c.send('採用します');
  const dec2 = seenPlan.length ? seenPlan[0] : [];
  assert(ra.ok && ra.intent === I.ADOPT_DRAFT && y.calls.plan.length === 1 && y.c.draft().status === 'adopted' && dec2.some(d => d.label === '編集不可の対象' && d.delegated === true), `A5-5: そのあとの「採用します」で採用 → 計画 1 回（おまかせの判断は委ねた印で渡る）: ${JSON.stringify({ intent: ra.intent, plan: y.calls.plan.length, dec: dec2.map(d => [d.label, d.delegated]) })}`);
  //   開いている判断が無い「おまかせ」は AI に読ませる（update と判断する）
  const z = convOf({ mode: 'vague' });
  await z.c.send(U0);
  const rz = z.c.classify('おまかせ');
  assert(rz.intent === I.DRAFT_REPLY && rz.reason === 'DELEGATE_NO_OPEN', `A5-6: 開いている判断が無い「おまかせ」は AI に読ませる（DRAFT_REPLY）: ${JSON.stringify(rz)}`);
  //   2026-10-15（レビューの反映 T3）: 委ねる言い方と「進めて（ください）」が同じ文にある「おまかせで進めてください」は、委ねた判断（推奨）を記録した上で採用（計画 1 回・仮案の AI は呼ばない）
  const seenPlan2 = [];
  const w = convOf({ mode: 'answer', withQuestion: true, planImpl: (args) => { seenPlan2.push(Array.isArray(args.decisions) ? args.decisions : []); return K.planJs(args); } });
  await w.c.send(U0);
  const rw = await w.c.send('おまかせで進めてください');
  const decW = w.c.draftDecisions().find(d => d.key === 'lock.scope');
  assert(rw.ok && rw.intent === I.ADOPT_DRAFT && rw.reason === 'DELEGATE' && w.calls.propose.length === 1 && w.calls.plan.length === 1 && w.c.draft().status === 'adopted' && decW && decW.kind === 'delegated' && decW.answer === '全員' && seenPlan2.length === 1 && seenPlan2[0].some(d => d.label === '編集不可の対象' && d.delegated === true), `A5-7:「おまかせで進めてください」（委ねる言い方 ＋ 進めて）は、委ねた回答（推奨）を記録した上で採用 → 計画 1 回（仮案の AI は呼ばない。委ねた判断は委ねた印で渡る）: ${JSON.stringify({ intent: rw.intent, reason: rw.reason, propose: w.calls.propose.length, plan: w.calls.plan.length, dec: decW })}`);
});

// =========================================================
console.log('\n--- §A6. (5) 判別できない発言 + 模擬 update → 仮案の更新だけ（「採用ですか」と聞き返さない） ---');
await section(async () => {
  const x = convOf({ mode: 'vague' });
  await x.c.send(U0);
  const r = await x.c.send(U_VAGUE);
  const chat = stripC(outsideDetails(chatOf(x)));
  assert(r.ok && r.intent === I.DRAFT_REPLY && r.draft && r.draft.intent === 'update' && x.calls.plan.length === 0 && x.c.draft().status === 'open' && x.c.draft().rev === 2 && /data-act="draft-adopt"/.test(draftCardOf(x)), `A6-1: 判別できない発言は仮案の更新だけ（計画 0・［採用］が残る）: ${JSON.stringify({ intent: r.intent, draft: r.draft, plan: x.calls.plan.length })}`);
  assert(!/採用ですか|採用しますか|採用でよろしいですか/.test(chat) && !INTERNAL_IN_CHAT.test(chat), `A6-2: 「採用ですか」と聞き返す文は無い: ${(chat.match(/採用ですか|採用しますか/) || [''])[0]}`);
});

// =========================================================
console.log('\n--- §A7. classifyDraft の決定的な前段（新しいキーワードは足していない: 既存の DRAFT_ADOPT / AGREEMENT / ADOPT / DRAFT_ACK / DRAFT_REVISE だけ） ---');
await section(async () => {
  const c = KTAiConversation.classifyDraft;
  const open = { activePlan: null, draftDecisions: [], draft: { id: 'd1', status: 'open', items: { behaviors: [], assumptions: [], decisions: [{ id: 'Q1', key: 'k', question: 'q', recommendation: 'rec', blocking: true }], approach: { standard: [], js: [] }, cannot: [] } } };
  const noOpen = { ...open, draft: { ...open.draft, items: { ...open.draft.items, decisions: [] } } };
  const openNoRec = { ...open, draft: { ...open.draft, items: { ...open.draft.items, decisions: [{ id: 'Q1', key: 'k', question: 'q', recommendation: '', blocking: true }] } } };
  const only = ['おすすめで', 'おまかせ', 'おまかせします', '全部おまかせで', 'おすすめでお願いします', 'じゃあ、おすすめで'];
  assert(only.every(s => c(s, open)?.intent === 'GENERAL' && c(s, open)?.reason === 'DELEGATE_ONLY' && c(s, open)?.delegated.length === 1 && c(s, open)?.delegated[0].answer === 'rec'), `A7-1: 委ねる言い方だけは記録だけ（GENERAL / DELEGATE_ONLY）: ${only.map(s => `${s}:${c(s, open)?.intent}/${c(s, open)?.reason}`).join(' ')}`);
  assert(only.every(s => c(s, noOpen)?.intent === 'DRAFT_REPLY' && c(s, noOpen)?.reason === 'DELEGATE_NO_OPEN') && only.every(s => c(s, openNoRec)?.intent === 'DRAFT_REPLY' && c(s, openNoRec)?.reason === 'DELEGATE_WITH_OPEN'), 'A7-2: 開いている判断が無い・推奨の無い判断だけの「おまかせ」は AI に読ませる（DRAFT_REPLY）');
  const both = ['おまかせします。この案で進めて', 'おすすめで。この案で進めて', 'おすすめで。採用します', 'はい、おまかせで。それでお願いします'];
  assert(both.every(s => c(s, open)?.intent === 'ADOPT_DRAFT' && c(s, open)?.reason === 'DELEGATE' && c(s, open)?.delegated.length === 1) && both.every(s => c(s, openNoRec)?.intent === 'DRAFT_REPLY' && c(s, openNoRec)?.reason === 'DELEGATE_WITH_OPEN'), `A7-3: 委ねる言い方と進行の語句の組は、記録した上で採用（推奨の無い先に必要な判断が残れば AI へ）: ${both.map(s => `${s}:${c(s, open)?.intent}/${c(s, open)?.reason}`).join(' ')}`);
  assert(['はい', 'OK', 'ok', 'うん', '了解'].every(s => c(s, open)?.intent === 'DRAFT_REPLY' && c(s, open)?.reason === 'ACK_WITH_OPEN') && ['はい', 'OK', 'うん', '了解'].every(s => c(s, noOpen)?.intent === 'GENERAL' && c(s, noOpen)?.reason === 'DRAFT_SMALLTALK' && c(s, noOpen)?.ack === true), 'A7-4: 素の「はい」「OK」は開いている判断があれば DRAFT_REPLY、無ければ今のまま相づち（採用の言い方を案内）');
  assert(['この案で進めて', '採用します', 'それでお願いします'].every(s => c(s, noOpen)?.intent === 'ADOPT_DRAFT' && c(s, noOpen)?.reason === 'ADOPT_WORDS' && !('delegated' in c(s, noOpen))) && ['承認者は今のまま、ステータスを一つ追加してください', '承認者は今のままで。この内容で進めて', '通知は不要でお願いします'].every(s => c(s, noOpen)?.intent === 'DRAFT_REPLY'), 'A7-5: 既存の進行の語句の経路は変えない（採用）。修正の語・修正と進行の混在は AI に読ませる');
  //   2026-10-15（レビューの反映 T3）: 委ねる言い方の文でも、同じ文に DRAFT_ADOPT の「進めて」の語群があれば進行の語句（記録した上で採用）。「お願いします」「します」「いいです」だけは記録だけ
  const goWith = ['おまかせで進めてください', 'おまかせで進めて下さい', 'おすすめで進めて', 'はい、おまかせで進めてください'];
  const onlyDelegate = ['おすすめでお願いします', 'おまかせします', 'おまかせでいいです', 'おすすめでよろしくお願いします'];
  assert(goWith.every(s => c(s, open)?.intent === 'ADOPT_DRAFT' && c(s, open)?.reason === 'DELEGATE' && c(s, open)?.delegated.length === 1 && c(s, open)?.delegated[0].answer === 'rec') && goWith.every(s => c(s, openNoRec)?.intent === 'DRAFT_REPLY' && c(s, openNoRec)?.reason === 'DELEGATE_WITH_OPEN'), `A7-6: 委ねる言い方と同じ文の「進めて（ください）」は、委ねた判断を記録した上で採用（推奨の無い先に必要な判断が残れば AI へ）: ${goWith.map(s => `${s}:${c(s, open)?.intent}/${c(s, open)?.reason}`).join(' ')}`);
  assert(onlyDelegate.every(s => c(s, open)?.intent === 'GENERAL' && c(s, open)?.reason === 'DELEGATE_ONLY'), `A7-7: 「進めて」の無い委ねる言い方（お願いします・します・いいです・よろしくお願いします）は記録だけ（A7-1 と同じ）: ${onlyDelegate.map(s => `${s}:${c(s, open)?.intent}/${c(s, open)?.reason}`).join(' ')}`);
});

console.log(`\n${state.failed === 0 ? 'ALL PASSED' : 'FAILED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed === 0 ? 0 : 1);
})();
