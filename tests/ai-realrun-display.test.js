// 実機確認（2026-10-09）で見つかった通常表示の内部の値と、根拠の無い時間の目安の回帰（設計 §0f.5 の 3・利用者の指示 §5 の表の 8 行目。有料の AI は使わない）
//
// 素材は実機の 2 会話目の文（仮案の reply・動作の「［E12・E16］」「金額（amount）」「明細（items）」「（memo）」、承認の欄の重複の handler の確認項目
// 「app.record.edit.show」、作業者のログイン名、進みのカードの「目安 約 50 秒」「約 1 分」）。
//
// 検証内容:
//   §V1 根拠の番号の除去（全角・半角の括弧すべて。KTAiConversation.stripEvidenceRefs 1 か所）と、AI の文のフィールドのコードの付け替え
//        （displayLabels。「名前（コード）」は名前に・PC・CSV などの短い語はコードと見なさない）。イベント名の画面の言葉（KTJsCatalog.eventJa）
//   §V2 仮案のカード（会話）: 通常表示・詳細表示のどちらにも根拠の番号・フィールドのコードを出さない。順番は 方針 → 動作 → 判断、前提は件数にかかわらず畳み、
//        対応できない範囲は件数の見出しで畳む。draft.items（次の仮案の AI に送る前回の仮案）は書き換えない
//   §V3 右のペインの仮案の詳細: 本文に根拠の番号・コードを出さず、根拠（番号と Toolkit が確かめた事実）は詳細「根拠」にだけ。対応できない範囲の全文
//   §V4 画面: 仮案の会話のカード・右のペイン・根拠を開く（showEvidence）
//   §V5 進みのカード: 見出しは経過だけで「残り時間は未推定」（保存した実測・既定値の目安を出さない）。AI の説明にも名前の付け替えと根拠の番号の除去。
//        根拠の無い時間の文（「1 分前後」「十数秒ほど」）が画面に出る文に残っていない
//   §V6 計画の自動の見直しで進みのカードを作り直さない（見出しは「最終案を作っています」のまま・経過は採用から・段階に「計画の自動の見直し」）
//   §V7 承認の欄の確認項目（重複の handler）: 画面の言葉（イベント名・handler を出さない）。元の文は詳細に残る。承認の照合の key・code・指紋の文は元のまま
//   §V8 作業者: ログイン中の利用者は名前・ログイン中でない利用者はログイン名を残す（承認者を確かめる情報を消さない）
//   §V9 最終案の動作の文（計画の AI の要約）も、根拠の番号を外し、PC などの短い語を書き換えない
//   §V10 AI の文のログイン名をフィールドの名前に書き換えない（V8-6。仮案のカード・右のペイン・進みのカード・最終案）。作業者の内部の表記（USER: など）は画面の表記・
//        通知の内部の番号（general#N など）は Context の事実の言葉（H-1・H-2）。承認の欄の適用範囲・PC / モバイルは画面の言葉（H-3・H-4）。
//        右のペインの変更内容（changeSummaryHtml）の計画の AI の文（影響範囲・JavaScript の文）も同じ変換（H-5・H-6）
//
// 実行方法: node tests/ai-realrun-display.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTAiConversation, KTAiChatUi, KTJsCatalog, KTCodeReview, KTContext, KTScan, KTAiClient } = T;
const { assert, state } = makeAssert();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { tick, ticks, clone, B, A, Q, makeConvC, planJs, custOf, stripC, finalHtml, mkStep, makeStorage, gateMk } = K;
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }

// ---- 通常表示に残ってはいけない値 ----
const EVIDENCE = /［\s*E[0-9]+|【\s*E[0-9]+|\[\s*E[0-9]+|[（(]\s*E[0-9]+|\bE[0-9]+\b/;
const CODES = /[（(]\s*(amount|items|memo|item_name)\s*[）)]|\bamount\b|\bitems\b|\bmemo\b|\bitem_name\b/;
const EVENTS = /(mobile\.)?app\.record\.|\bhandler\b/;
const ESTIMATE = /目安|約\s*[0-9]+\s*(秒|分)|1 分前後|十数秒/;
const outsideDetails = (html) => String(html).replace(/<details[\s\S]*?<\/details>/g, '');
/** 畳んだ状態で見える部分（詳細表示は見出し（summary）だけ） */
const collapsed = (html) => String(html).replace(/<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>[\s\S]*?<\/details>/g, '$1');
const noAttrs = (html) => String(html).replace(/\s(data-[a-z-]+|class|style|id|placeholder|title)="[^"]*"/g, '');
const visible = (html) => stripC(noAttrs(html));
const firstHit = (s, ...res) => { for (const re of res) { const m = String(s).match(re); if (m) return m[0]; } return ''; };
/** フィールドのラベル（実機の案件管理 App 353 と同じコード。PC・CSV は「短い語をコードと見なさない」ことを確かめるため） */
const LABELS = { ...K.LABELS_C, items: '明細', item_name: '品名', PC: '端末区分', CSV: 'CSV取込' };

// ---- 実機の 2 会話目の仮案（文はそのまま。origin は実機の画面と同じ）----
const REQ = '100万円以上は部長承認、100万円未満は課長承認にしたい。承認済みでは金額と明細を変更できなくし、差戻し後は再編集できるようにして。今ある入力チェックは残して、PCとモバイルの両方で使いたい';
const COMMENT = '承認者は今の作業者の指定のままでよいです。既存の「承認待ち」を課長承認に使い、部長承認用のステータスを1つだけ追加してください。';
const REPLY1 = '金額（amount）が100万円以上なら部長承認、100万円未満なら課長承認に分岐します［E12・E16］。承認済みでは金額（amount）と明細（items）を編集不可にし、差戻し後は再編集できるようにします。';
const B1 = '金額（amount）が100万円以上なら部長承認、100万円未満なら課長承認に分岐する。';
const B2 = '「承認済み」では金額（amount）と明細（items）を変更できなくする［E12・E16］。';
const B3 = '差戻し後は金額と明細を再編集できるようにする。';
const B4 = '既存の入力チェックを維持し、承認ルート・編集制限・入力チェックをPCとモバイルの両方で利用できるようにする。';
const B5 = '差戻し後は「備考」（memo）に理由を書けるようにし、承認済みでは memo を編集不可にする。';
const QIMPACT = '部長承認の作業者の指定が変わります［E16］';
const A1 = '既存の「承認待ち」を課長承認に使う［E18］';
const CANNOT = '明細（items）の行の追加・削除ボタン自体は止められません［E12］';
const draftOf = (extra = []) => ({
  behaviors: [B(B1, 'user'), B(B2, 'user'), B(B3, 'user'), B(B4, 'user'), B(B5, 'ai'), ...extra],
  assumptions: [A('approval.reuse', '既存のステータス', A1, '新しいステータスを 2 つ作ることもできます（E11）'), A('approval.order', '承認の順', '課長承認の後に部長承認（金額で分岐）【E7】', '')],
  approach: { standard: ['ステータス「部長承認待ち」の追加［E7］'], js: ['承認済みの金額（amount）と明細（items）の編集不可（PC・モバイル）'] },
  cannot: [CANNOT],
});
const realScript = ({ utterance: u }) => {
  if (u === REQ) return { reply: REPLY1, intent: 'propose',
    proposal: { ...draftOf(), decisions: [Q('approval.assignee', '承認者の指定', '課長・部長の承認者はどう指定しますか？', ['今の作業者の指定のまま', 'ユーザー選択フィールドを追加（approver）'], '今の作業者の指定のまま', QIMPACT, true)] },
    turn: { ops: [], answers: [], requirementOps: [] } };
  if (u === COMMENT) return { reply: '承認者は今の「承認待ち」の作業者の指定を使います［E11］。', intent: 'update',
    proposal: { ...draftOf([B('承認者は現在の「承認待ち」の作業者指定を維持し、追加する部長承認用ステータスにも同じ指定を使う。', 'user')]), decisions: [] },
    turn: { ops: [], answers: [], requirementOps: [] } };
  return null;
};
/** 仮案の依頼で送った Context の facts（実機の番号と同じ E11・E12・E16・E18 を含む） */
const FACTS = [
  { id: 'E7', kind: 'overview', statement: 'プロセス管理は有効（ステータス: 作成中 → 承認待ち → 承認済み）', confidence: 'CERTAIN' },
  { id: 'E11', kind: 'process-state', statement: 'ステータス「承認待ち」の作業者は ユーザー「approver@example.com」', confidence: 'CERTAIN' },
  { id: 'E12', kind: 'field', statement: 'フィールド「明細」（コード items・SUBTABLE）はフォームに存在する', confidence: 'CERTAIN' },
  { id: 'E16', kind: 'js-file', statement: 'JavaScript「dealLock.js」（PC）: イベント app.record.edit.show', confidence: 'CERTAIN' },
  { id: 'E18', kind: 'process-action', statement: 'プロセスアクション「承認する」: 「承認待ち」→「承認済み」', confidence: 'CERTAIN' },
  { id: 'E20', kind: 'notification', statement: '引かれていない事実（根拠に出さない）', confidence: 'CERTAIN' },
];
const realConv = (o = {}) => {
  const x = makeConvC({ scriptFn: realScript, labels: LABELS, ...o });
  const p0 = x.services.propose;
  x.previous = [];
  x.services.propose = async (args) => { x.previous.push(args.previous ? clone(args.previous) : null); const r = await p0(args); return r && r.ok ? { ...r, ctx: { facts: clone(FACTS) } } : r; };
  return x;
};
const cardOf = (x, m) => KTAiChatUi.messageHtml(m, { draft: x.c.draft(), draftDecisions: x.c.draftDecisions(), draftAnswers: new Map(), labels: LABELS });

(async () => {
// =========================================================
console.log('\n--- §V1. 根拠の番号の除去（全角・半角）・AI の文のフィールドのコードの付け替え・イベント名の画面の言葉 ---');
await section(async () => {
  const { stripEvidenceRefs: strip, evidenceRefsIn, displayLabels } = KTAiConversation;
  const forms = ['（E12）', '(E12)', '［E12・E16］', '[E12]', '[E12・E16]', '【E3】', '（E12、E16）', '［E12〜E16］', '（E12, E16）', '［ E12 ・ E16 ］', '（dictionary.status.approval）'];
  const bad = forms.filter(f => strip(`分岐します${f}。`) !== '分岐します。');
  assert(!bad.length, `V1-1: 根拠の番号は全角・半角の （）()［］[]【】 と区切り（・、,〜）のどれでも外す: ${JSON.stringify(bad.map(f => [f, strip(`分岐します${f}。`)]))}`);
  assert(strip('E12 は根拠の番号ではない文') === 'E12 は根拠の番号ではない文' && JSON.stringify(evidenceRefsIn(REPLY1, QIMPACT, A1, 'E99 は括弧の外')) === JSON.stringify(['E12', 'E16', 'E18']), `V1-2: 括弧の外の語は外さない・番号は括弧の中だけを順に拾う: ${JSON.stringify(evidenceRefsIn(REPLY1, QIMPACT, A1, 'E99 は括弧の外'))}`);
  assert(KTAiChatUi.answerCardHtml({ type: 'ANSWER', data: { answer: { answer: '承認待ちの作業者は課長です［E11・E12］。', facts: [], analysis: [], recommendations: [], unknowns: [] } } }).indexOf('［E11') < 0, 'V1-3: 質問の答えのカード（会話）も同じ規則で全角の番号を外す');
  const cases = [
    [B1, '金額が100万円以上なら部長承認、100万円未満なら課長承認に分岐する。'],
    ['「承認済み」では金額（amount）と明細（items）を変更できなくする', '「承認済み」では金額と明細を変更できなくする'],
    ['「備考」（memo）を必須にし、承認済みでは memo を編集不可', '「備考」を必須にし、承認済みでは「備考」を編集不可'],
    ['明細（items）の品名（item_name）', '明細の品名'],
    ['対象（amount）', '対象（金額）'],
    ['PCとモバイルの両方で使う。CSV 読み込みも止める（PC）', 'PCとモバイルの両方で使う。CSV 読み込みも止める（PC）'],
    ['端末区分（PC）は対象外', '端末区分は対象外'],
    ["record['amount'].disabled = true と amount.value", "record['amount'].disabled = true と amount.value"],
  ];
  const wrong = cases.filter(([s, want]) => displayLabels(s, LABELS) !== want).map(([s, want]) => ({ s, want, got: displayLabels(s, LABELS) }));
  assert(!wrong.length, `V1-4: 「名前（コード）」は名前に・括弧の中だけのコードと裸のコードは名前に・PC / CSV（短い大文字の語）とコード片は書き換えない: ${JSON.stringify(wrong)}`);
  const evs = ['app.record.edit.show', 'mobile.app.record.edit.submit', 'app.record.create.change.amount', 'app.record.detail.process.proceed'].map(KTJsCatalog.eventJa);
  assert(JSON.stringify(evs) === JSON.stringify(['編集画面を開いたとき（PC）', '編集画面で保存するとき（モバイル）', '作成画面で値を変えたとき（PC）', 'レコード詳細画面でアクションを実行するとき（PC）']) && !evs.some(x => EVENTS.test(x) || CODES.test(x)), `V1-5: イベント名は画面とタイミングの言葉（値の変更のフィールドのコードも出さない）: ${JSON.stringify(evs)}`);
});

// =========================================================
console.log('\n--- §V2・§V3. 仮案のカード（会話）と右のペインの仮案の詳細 ---');
await section(async () => {
  const x = realConv();
  await x.c.send(REQ);
  const d = x.c.draft();
  const m = x.c.messages().filter(mm => mm.type === 'DRAFT').slice(-1)[0];
  assert(d && d.rev === 1 && m, '前提: 実機の文の仮案ができた');
  const html = cardOf(x, m);
  const vis = visible(html), visOut = visible(outsideDetails(html));
  assert(!EVIDENCE.test(vis) && !CODES.test(vis), `V2-1: 仮案のカードは通常表示・詳細表示のどちらにも根拠の番号（［E12・E16］など）とフィールドのコード（（amount）・（items）・memo）を出さない: ${firstHit(vis, EVIDENCE, CODES)}`);
  assert(/金額が100万円以上なら部長承認/.test(vis) && /金額と明細を編集不可にし/.test(vis) && /「備考」に理由を書けるようにし、承認済みでは「備考」を編集不可にする/.test(vis) && /PCとモバイルの両方で利用できるようにする/.test(vis) && !/端末区分/.test(vis), `V2-2: 名前に付け替えた文は残る（結論・動作・AI の補足）。「PCとモバイル」の PC はフィールドのコードと見なさない: ${vis.replace(/\s+/g, ' ').slice(0, 400)}`);
  assert(/答えで変わること：部長承認の作業者の指定が変わります/.test(vis) && /ユーザー選択フィールドを追加（承認者）|ユーザー選択フィールドを追加（approver）/.test(vis), `V2-3: 判断の「答えで変わること」の根拠の番号も外す（候補の文はそのまま読める）: ${(vis.match(/答えで変わること[^\n]*/) || [''])[0]}`);
  //   §0f.5 の 3（C1）: 方針 → 動作 → 判断。前提は件数（2 件）にかかわらず畳む。対応できない範囲は件数の見える見出しで畳む
  const iPolicy = vis.indexOf('金額が100万円以上なら部長承認、100万円未満なら課長承認に分岐します'), iBeh = vis.indexOf('実現する動作'), iDec = vis.indexOf('判断が必要な点'), iAsm = vis.indexOf('こちらの提案で進める点'), iCan = vis.indexOf('対応できない範囲が 1 件あります');
  assert(iPolicy >= 0 && iPolicy < iBeh && iBeh < iDec && iDec < iAsm && iAsm < iCan, `V2-4: 順番は 方針 → 実現する動作 → 判断が必要な点 → 前提 → 対応できない範囲: ${JSON.stringify({ iPolicy, iBeh, iDec, iAsm, iCan })}`);
  const asm = (html.match(/<details class="kt-ai-draft-assumptions"[^>]*>[\s\S]*?<\/details>/) || [''])[0];
  const can = (html.match(/<details class="kt-ai-draft-cannot"[^>]*>[\s\S]*?<\/details>/) || [''])[0];
  const visShut = visible(collapsed(html));
  assert(asm && !/<details[^>]*\sopen/.test(asm) && /こちらの提案で進める点が 2 件あります/.test(visShut) && !visShut.includes('既存の「承認待ち」を課長承認に使う') && vis.includes('既存の「承認待ち」を課長承認に使う'), `V2-5: 前提は 2 件でも畳む（見出しの件数は見える・本文は開いたときだけ）: ${asm.slice(0, 160)}`);
  assert(can && !/<details[^>]*\sopen/.test(can) && /対応できない範囲が 1 件あります/.test(visShut) && /全文は右の「変更内容」/.test(visShut) && !visShut.includes('行の追加・削除ボタン自体は止められません') && /border-left:3px solid #b26a00/.test(can), `V2-6: 対応できない範囲は件数の見える見出しで畳む（橙の線は残す。全文は右のペイン）: ${can.slice(0, 200)}`);
  assert(/（AI が補足・採用すると入ります）/.test(vis) && !/（提案）/.test(vis), 'V2-7: AI が補った動作の印は「（AI が補足・採用すると入ります）」（任意の提案と紛らわしい「（提案）」は出さない）');
  //   draft.items は書き換えない（次の仮案の AI に前回の仮案として送る。描画のときだけ変換する）
  assert(d.items.behaviors[0].text === B1 && d.items.behaviors[1].text === B2 && d.items.cannot[0] === CANNOT && d.reply === REPLY1 && m.data.items.behaviors[1].text === B2, 'V2-8: 会話の仮案（draft.items・カードの data）の文は元のまま（描画のときだけ付け替える）');
  await x.c.send(COMMENT);
  const prev = x.previous[1];
  assert(prev && prev.behaviors && prev.behaviors.some(b => b.text === B1) && prev.behaviors.some(b => b.text === B2) && x.c.draft().rev === 2, `V2-9: 次の仮案の AI に送る前回の仮案は元の文のまま: ${JSON.stringify(prev && prev.behaviors && prev.behaviors.map(b => b.text).slice(0, 2))}`);
  const html2 = cardOf(x, x.c.messages().filter(mm => mm.type === 'DRAFT').slice(-1)[0]);
  const vis2 = visible(html2);
  assert(!EVIDENCE.test(vis2) && !CODES.test(vis2) && /承認者は今の「承認待ち」の作業者の指定を使います。/.test(vis2), `V2-10: 直した仮案（rev 2）のカードも同じ: ${firstHit(vis2, EVIDENCE, CODES)}`);
  // ---- §V3 右のペイン ----
  const d2 = x.c.draft();
  const sum = KTAiChatUi.draftSummaryHtml(d2, { decisions: x.c.draftDecisions(), labels: LABELS });
  const ev = (sum.match(/<details class="kt-ai-tech kt-ai-draft-evidence"[^>]*>[\s\S]*?<\/details>/) || [''])[0];
  const body = visible(sum.replace(ev, ''));
  assert(!EVIDENCE.test(body) && !CODES.test(body), `V3-1: 右のペインの本文（判断・動作・前提・進め方・対応できない範囲・判断の経緯）に根拠の番号とフィールドのコードを出さない: ${firstHit(body, EVIDENCE, CODES)}`);
  assert(/明細の行の追加・削除ボタン自体は止められません/.test(body) && /既存の「承認待ち」を課長承認に使う/.test(body) && /承認済みの金額と明細の編集不可（PC・モバイル）/.test(body), 'V3-2: 対応できない範囲・前提・進め方の全文は右のペインに出る（名前に付け替えた文）');
  const evText = visible(ev);
  assert(ev && /根拠（Toolkit が確かめた設定 [0-9]+ 件）/.test(evText) && /E11/.test(evText) && /E12/.test(evText) && /E16/.test(evText) && /E18/.test(evText) && /E7/.test(evText) && /フィールド「明細」（コード items・SUBTABLE）はフォームに存在する/.test(evText) && /イベント app\.record\.edit\.show/.test(evText) && !/E20|引かれていない事実/.test(evText) && /data-eid="E12"/.test(ev), `V3-3: 根拠は右のペインの詳細「根拠」だけに、引かれた番号と Toolkit が確かめた事実の文（元の表記のまま）。引かれていない事実は出さない: ${evText.replace(/\s+/g, ' ').slice(0, 300)}`);
  assert(JSON.stringify(d2.evidence.map(e => e.id)) === JSON.stringify(['E11', 'E12', 'E16', 'E18', 'E7']) && x.c.messages().filter(mm => mm.type === 'DRAFT').slice(-1)[0].data.ctxFacts.map(f => f.id).join(',') === 'E11,E12,E16,E18,E7', `V3-4: 引かれた根拠（出てきた順）を仮案と仮案のメッセージ（showEvidence が引く）に持つ: ${JSON.stringify(d2.evidence.map(e => e.id))}`);
  assert(!/kt-ai-draft-evidence/.test(html2) && !/data-eid=/.test(html2), 'V3-5: 会話の仮案のカードには根拠の一覧を出さない（詳細表示の中にも）');
});

// =========================================================
console.log('\n--- §V4. 画面: 仮案の会話のカード・右のペイン・根拠を開く ---');
await section(async () => {
  const m = K.mount({ scriptFn: realScript });
  await ticks();
  await m.panel.send(REQ); await ticks(10);
  const chat = m.chat();
  const card = (chat.match(/<div class="kt-ai-card kt-ai-draft-card[\s\S]*?まだ何も反映していません[\s\S]*?<\/div>/) || [''])[0];
  const vis = visible(chat);
  //   画面のラベルは動作テスト環境の基準のフィールド（金額 = amount）。この画面の基準に無い items・memo はそのまま（コードと決められない語は推測で置き換えない）
  assert(card && !EVIDENCE.test(vis) && !/[（(]\s*amount\s*[）)]|\bamount\b/.test(vis) && /金額が100万円以上なら部長承認/.test(vis), `V4-1: 画面の会話の仮案のカードに根拠の番号と（amount）を出さない（画面が今の基準のラベルを渡す）: ${firstHit(vis, EVIDENCE, /[（(]\s*amount\s*[）)]|\bamount\b/)}`);
  const sum = m.$('kt-ai-change-summary').innerHTML;
  const ev = (sum.match(/<details class="kt-ai-tech kt-ai-draft-evidence"[^>]*>[\s\S]*?<\/details>/) || [''])[0];
  const ctxFacts = m.calls.propose[0].ctx.facts;
  const e12 = ctxFacts.find(f => f.id === 'E12');
  assert(ev && e12 && visible(ev).includes(e12.statement) && !EVIDENCE.test(visible(sum.replace(ev, ''))), `V4-2: 右のペインの詳細「根拠」に、送った Context の事実（E12 など）の文。本文には番号を出さない: ${visible(ev).replace(/\s+/g, ' ').slice(0, 200)}`);
  const fact = m.panel.showEvidence('E16');
  assert(fact && fact.id === 'E16' && fact.statement === ctxFacts.find(f => f.id === 'E16').statement, 'V4-3: 根拠の番号から事実を開ける（仮案のメッセージの ctxFacts を引く）');
  //   右のペインの根拠の番号のボタン（data-eid）を押すと、根拠の詳細を開く（既存の右のペインのクリックの処理）
  await m.$('kt-ai-pane-plan').dispatch({ type: 'click', target: { dataset: { eid: 'E12' } } }); await ticks(2);
  assert(m.$('kt-ai-fact-detail').innerHTML.includes(e12.statement), `V4-4: 右のペインの根拠のボタンから事実の詳細を開ける: ${m.$('kt-ai-fact-detail').innerHTML.slice(0, 120)}`);
});

// =========================================================
console.log('\n--- §V5. 進みのカード: 経過と「残り時間は未推定」・AI の説明の付け替え・根拠の無い時間の文 ---');
await section(async () => {
  //   実機の「目安 約 50 秒」: 1 会話目の計画の実測（49.6 秒）が端末に保存されていた。保存した実測があっても残り時間を推定しない
  const storage = makeStorage();
  storage.setItem('ktAi.timing.v1', JSON.stringify({ plan: { avg: 49567, n: 1 }, summarize: { avg: 1000, n: 1 }, revise: { avg: 40000, n: 1 }, generate: { avg: 15671, n: 1 } }));
  const pg = gateMk();
  const x = makeConvC({ storage, planGate: pg, labels: LABELS });
  const plan0 = x.services.plan;
  //   計画の AI の説明（実機の reply の逐次表示の文）
  x.services.plan = async (args) => { if (typeof args.onText === 'function') args.onText('明細（items）の行追加・削除ボタン自体は止められないため［E12・E16］、承認済みではセルを編集不可にし、行の変更を含む変更は保存時に検出して止める計画です。'); return plan0({ ...args, onText: null }); };
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) await x.c.send(s);
  const p = x.c.send('おすすめで'); await ticks(6);
  const pm = x.c.messages().find(mm => mm.data && mm.data.kind === 'progress');
  x.advance(134000); x.c.tickProgress();
  const h = KTAiChatUi.progressInnerHtml(pm, { labels: LABELS });
  const vh = visible(h);
  assert(pm && /最終案を作っています（経過 2:1[0-9]）/.test(vh) && /残り時間は未推定/.test(vh) && !ESTIMATE.test(vh), `V5-1: 見出しは経過だけ・2 行目に「残り時間は未推定」（保存した実測 49.6 秒から「目安 約 50 秒」を出さない。経過が長くても隠さない）: ${vh.replace(/\s+/g, ' ').slice(0, 160)}`);
  assert(/● 計画を作成中（経過 2 分 1[0-9] 秒）/.test(vh) && /○ まとめ/.test(vh), `V5-2: 段階の行（段階と経過）は残す: ${vh.replace(/\s+/g, ' ').slice(0, 200)}`);
  assert(/明細の行追加・削除ボタン自体は止められないため、承認済みではセルを編集不可にし/.test(vh) && !EVIDENCE.test(vh) && !CODES.test(vh), `V5-3: 進みのカードの AI の説明も、フィールドのコードを名前に・根拠の番号を外す: ${firstHit(vh, EVIDENCE, CODES)}`);
  //   データに目安の値（estimateMs）が残っていても表示には使わない（実機の「約 1 分」の形）
  const fake = { type: 'LOADING', data: { kind: 'progress', progress: { title: '最終案を直しています', startedAt: 0, now: 137600, estimateMs: 87500, stages: [{ key: 'revise', label: '計画を修正', state: 'done', elapsedMs: 27000 }, { key: 'generate', label: 'JavaScript を生成・検証（生成工程）', activeLabel: 'JavaScript を生成・検証しています（生成工程）', state: 'active', startedAt: 30000, n: 1, m: 3, estimateMs: 47013 }], aiText: '', checklist: [], materials: '', hint: '' } } };
  const vf = visible(KTAiChatUi.progressInnerHtml(fake));
  assert(/最終案を直しています（経過 2:17）/.test(vf) && /残り時間は未推定/.test(vf) && !ESTIMATE.test(vf) && /JavaScript を生成・検証しています（生成工程）（1 \/ 3・経過 1 分 47 秒）/.test(vf), `V5-4: 目安の値が残っていても「約 1 分」を出さない（何件目と経過は出す。経過は見出しと同じく秒の切り捨て）: ${vf.replace(/\s+/g, ' ')}`);
  pg.open(); await p; await ticks(8);
  const saved = JSON.parse(storage.getItem('ktAi.timing.v1'));
  assert(saved.plan.n === 2 && x.c.progress() === null, `V5-5: 段階の実測は記録に残す（表示には使わない）: ${JSON.stringify(saved.plan)}`);
  //   根拠の無い時間の文（会話の受領の記録・読み込み中の文）がソースの文字列に残っていない（コメントを除く）
  //   レビューの指摘 row8（2026-10-09）: 走らせている版（KT_SRC があればその版）のソースを読む（修正前の版で RED を確かめられるように）
  const src = require('fs').readFileSync(process.env.KT_SRC || require('path').join(__dirname, '..', 'kintoneAppToolkit.user.js'), 'utf8');
  const lines = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).map(l => l.replace(/\s\/\/\s.*$/, '')).filter(l => /1 分前後|十数秒|目安 \$\{|・目安/.test(l));
  assert(!lines.length, `V5-6: 「1 分前後」「十数秒ほど」「目安 約 N 秒」を画面に出す文が残っていない: ${lines.map(l => l.trim().slice(0, 120)).join(' ／ ')}`);
});

// =========================================================
console.log('\n--- §V6. 計画の自動の見直しで進みのカードを作り直さない（経過を 0 に戻さない） ---');
await section(async () => {
  //   I5-1 と同じ形（効果を特定できない customization → 同じ送信の中で 1 回だけ計画の自動の差分更新）
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: custOf(null), gatewayPlan: { plan: true } }) });
  const seen = [];
  const plan0 = x.services.plan;
  x.services.plan = async (args) => {
    const pr = x.c.progress();
    const pm = x.c.messages().find(mm => mm.data && mm.data.kind === 'progress') || null;
    seen.push({ revision: !!args.revision, title: pr && pr.title, startedAt: pr && pr.startedAt, mid: pm && pm.id, stages: pr ? pr.stages.map(s => `${s.key}:${s.state}`).join(',') : '', loadings: x.c.messages().filter(mm => mm.type === 'LOADING').length, head: pm ? visible(KTAiChatUi.progressInnerHtml(pm)) : '' });
    return plan0(args);
  };
  await K.adoptC(x);
  const [s0, s1] = seen;
  assert(seen.length === 2 && s0 && !s0.revision && s1 && s1.revision, `前提: 最初の計画と、計画の自動の見直し（差分更新）の 2 回: ${JSON.stringify(seen.map(s => s.revision))}`);
  assert(s1.title === '最終案を作っています' && s1.startedAt === s0.startedAt && s1.mid === s0.mid && s1.loadings === 1, `V6-1: 自動の見直しは同じ進みのカード（見出しは「最終案を作っています」のまま・開始の時刻も同じ・カードは 1 枚）: ${JSON.stringify({ t0: s0.title, t1: s1.title, a0: s0.startedAt, a1: s1.startedAt, loadings: s1.loadings })}`);
  assert(/plan-auto:active/.test(s1.stages) && /計画を自動で見直しています/.test(s1.head) && /最終案を作っています（経過 0:3[0-9]）/.test(s1.head) && !/最終案を直しています/.test(s1.head), `V6-2: 段階に「計画の自動の見直し」を足し、見出しの経過は採用からのまま（0 に戻さない）: ${s1.stages} ｜ ${s1.head.replace(/\s+/g, ' ').slice(0, 160)}`);
  const v = x.c.activePlan();
  assert(x.c.progress() === null && v && v.final && x.finals().length === 1 && v.final.timing.planAutoMs != null, 'V6-3: 最終案ができたらカードは消える（最終案は 1 枚・自動の見直しの時間は記録に残る）');
});

// =========================================================
console.log('\n--- §V7. 承認の欄の確認項目（重複の handler）: 画面の言葉・元の文は詳細・照合の key と指紋は元のまま ---');
await section(async () => {
  //   実機の 1 会話目と同じ形（既存の dealLock.js が app.record.edit.show を登録・統合したコードが同じイベントに別の handler を足す）: Phase 21 BF-C の記録
  const RP = K.RP;
  const data = require('./fixtures/ai-context-app.js').makeData();
  data.fields = clone(RP.FIELDS);
  const srcL = { name: 'dealLock.js', target: 'desktop', text: RP.DEAL_LOCK };
  const gL = T.KTModernJs.fixGenerated({ generated: RP.GENERATED, existingSource: srcL });
  const rv = KTCodeReview.review({ generated: gL.generated, customization: RP.CUSTOMIZATION, plan: null, data, scan: null, existingSource: srcL });
  const dup = rv.registration.confirmations.find(x => x.code === 'duplicate-handler');
  assert(dup && /app\.record\.edit\.show/.test(dup.message) && /handler/.test(dup.message), `前提: 検査の元の文はイベント名と handler を含む（実機の承認の欄に出た文）: ${dup && dup.message}`);
  assert(dup && !EVENTS.test(dup.screenText) && /既存の「dealLock\.js」が/.test(dup.screenText) && /編集画面を開いたとき（PC）/.test(dup.screenText) && /別の処理を足します/.test(dup.screenText) && dup.howToCheck === KTCodeReview.HOW_TO_CHECK['duplicate-handler'] && /既存の処理と今回の処理の両方が動く/.test(dup.howToCheck), `V7-1: 確認項目の画面の言葉（統合先のファイル名と画面・タイミング。イベント名・handler なし）と、重複の handler の確かめ方: ${dup && dup.screenText} ｜ ${dup && dup.howToCheck}`);
  assert(dup.id === 'duplicate-handler#1' && dup.code === 'duplicate-handler', 'V7-2: 確認項目の id・code（承認の照合に使う）は元のまま');
  const fallback = KTCodeReview.confirmScreenText({ message: dup.message });
  assert(!EVENTS.test(fallback) && /編集画面を開いたとき（PC）/.test(fallback), `V7-3: 画面の言葉の無い古い記録も、元の文のイベント名・handler を置き換えて出す: ${fallback}`);
  //   最終案のカードの承認の欄（確認項目は { text, detail }。文字列の項目もそのまま受ける）
  const x = makeConvC();
  await K.adoptC(x);
  const va = x.c.activePlan(), fm = x.finals().slice(-1)[0];
  const confText = `${dup.screenText}（${dup.howToCheck}）`;
  const htmlReady = KTAiChatUi.messageHtml(fm, { plans: new Map(x.c.planHistory().map(z => [`${z.planId}:${z.version}`, z])), activePlan: va, answerState: x.c.answerContext(), ledger: x.c.ledger(), answers: new Map(), finalPre: { planId: va.planId, version: va.version, status: 'ready', reasons: [], items: { target: '動作テスト環境（このアプリ）。運用環境には反映しません', settings: [], process: [], existing: [], duplicate: [], files: ['✎ dealLock.js（PC）既存ファイルを更新（同じ位置）'], keep: [], deferred: [], confirmations: [{ text: confText, detail: dup.message }, '文字列の確認項目'], warnings: [], manual: [] } } });
  const out = visible(outsideDetails(htmlReady)), all = visible(htmlReady);
  assert(/確認項目（この承認で確認済みとして扱います）/.test(out) && out.includes(dup.screenText) && /文字列の確認項目/.test(out) && !EVENTS.test(out), `V7-4: 承認の欄の確認項目は画面の言葉（通常表示にイベント名・handler を出さない）: ${firstHit(out, EVENTS)}`);
  assert(all.includes(dup.message) && /元の検査の文/.test(all), 'V7-5: 元の文（イベント名入り）は承認の欄の詳細に残る');
});
await section(async () => {
  //   画面: 承認の欄の準備（書き込みなし）→ 確認項目 → ［動作テスト環境へ反映］で承認と登録（照合の key・指紋の文は元のまま。登録は動作テスト環境のモックだけ）
  const ST_S = "record['ステータス'] && record['ステータス'].value === '承認待ち'";
  const one = (field) => `  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (${ST_S}) record['${field}'].disabled = true;\n    return event;\n  });`;
  const dupCode = (field) => `(function () {\n  'use strict';\n${one(field)}\n${one(field)}\n})();`;
  const calls = [];
  const dupGenerate = async ({ ctx, requestId }) => {
    calls.push(1);
    const field = 'case_name', targetFile = 'caseLock.js', code = dupCode(field);
    const req0 = (ctx.verification && ctx.verification.requiredEffects) || [];
    const candidateHash = KTScan.candidateHashOf({ strategy: 'NEW_JS_FILE', targetFile, code, customizationId: 'C1' });
    const resp = { ok: true, contractVersion: '2.1', meta: { requestId, gateway: { product: 'toolkit', feature: 'customization-generator', promptVersion: '1', contextVersion: 'customization-1' }, normalization: { warnings: [] }, ai: { model: 'm' } }, generated: { strategy: 'NEW_JS_FILE', targetFile, summary: '承認待ちでは案件名を編集できないようにします。', code, patch: null, events: ['app.record.edit.show'], fields: [{ code: field, access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '' }] }, verification: K.fakeVerification({ code, has: { [field]: ['lock'] } }, req0, { candidateHash }) };
    const vv = KTAiClient.validateGenerated(resp, ctx);
    if (!vv.ok) throw new Error(JSON.stringify(vv.errors));
    return { ...vv.normalized, requestId };
  };
  const m = K.mount({ health: K.HEALTH_V, planImpl: K.planImplOf(K.screenPlan('js')), generateImpl: dupGenerate, liveBase: true });
  await ticks();
  const v = await K.adoptOnScreen(m);
  await ticks(20);
  await K.waitUntil(() => ['ready', 'blocked', 'unavailable'].includes(m.panel.finalPrecheck().status), 80); await ticks(2);
  const pre = m.panel.finalPrecheck();
  const conf = (pre.items && pre.items.confirmations) || [];
  const dupC = conf.find(c => c && typeof c === 'object' && /2 回登録/.test(c.text || ''));
  assert(v && v.final && calls.length === 1 && pre.status === 'ready' && dupC, `前提: 生成したコードが同じイベントを 2 回登録 → 承認の欄の準備が終わり、確認項目がある: ${JSON.stringify({ status: pre.status, conf })}`);
  assert(dupC && /同じタイミング（編集画面を開いたとき（PC））の処理を 2 回登録しています/.test(dupC.text) && /既存の処理と今回の処理の両方が動く/.test(dupC.text) && !EVENTS.test(dupC.text) && /app\.record\.edit\.show/.test(dupC.detail), `V7-6: 画面の承認の欄の確認項目は画面の言葉（元の文は detail）: ${JSON.stringify(dupC)}`);
  const chatOut = visible(outsideDetails(m.chat()));
  assert(chatOut.includes('同じタイミング（編集画面を開いたとき（PC））の処理を 2 回登録しています') && !EVENTS.test(chatOut), `V7-7: 会話の最終案のカード（通常表示）に app.record.edit.show・handler が出ない: ${firstHit(chatOut, EVENTS)}`);
  const r = await K.applyOnScreen(m);
  const ap = r.v.approval;
  const fpConf = ap && ap.precheck && ap.precheck.fingerprint && ap.precheck.fingerprint.js ? ap.precheck.fingerprint.js.confirmations : [];
  assert(r.run && r.run.ok && fpConf.length >= 1 && fpConf.some(c => c.key === 'C1:duplicate-handler#1' && /app\.record\.edit\.show/.test(c.message)) && Array.isArray(ap.confirmations.C1) && ap.confirmations.C1.includes('duplicate-handler') && r.writes.some(w => /customize/.test(w)), `V7-8: 承認の照合の key（C1:duplicate-handler#1）・code と指紋の文（元の文）は変えずに、承認と登録が通る（書き込みは動作テスト環境のモックだけ）: ${JSON.stringify({ ok: r.run && r.run.ok, fpConf, writes: r.writes })}`);
});

// =========================================================
console.log('\n--- §V8. 作業者: ログイン中の利用者は名前・それ以外はログイン名を残す ---');
await section(async () => {
  const st = mkStep('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認待ち', { name: '部長承認待ち', assignees: ['USER:approver@example.com', 'USER:manager@example.com'] }, { title: 'ステータス「部長承認待ち」を追加' });
  const plan = { goal: 'g', assessment: { summary: '金額（amount）が 100 万円以上なら部長承認に分岐します。' }, steps: [st], customizations: [], impact: [], unknowns: [] };
  const review = { steps: [{ stepId: 'P1', diff: { before: null, after: { name: '部長承認待ち', assignees: [{ type: 'USER', code: 'approver@example.com' }, { type: 'USER', code: 'manager@example.com' }] }, human: ['＋ ステータス「部長承認待ち」（作業者: USER:approver@example.com, USER:manager@example.com・次のユーザーから作業者を選択）'] } }] };
  const txt = stripC(KTAiChatUi.changeSummaryHtml({ goal: 'g', plan, review }, { labels: { amount: '金額' }, users: { 'approver@example.com': '承認 太郎' } }));
  assert(txt.includes('作業者: ユーザー「承認 太郎」, ユーザー（manager@example.com）') && !txt.includes('approver@example.com') && !/USER:/.test(txt), `V8-1: ログイン中の利用者（approver）は名前・名前が分からない利用者（manager）はログイン名を残す（承認者を確かめる情報を消さない）: ${txt.replace(/\s+/g, ' ').slice(0, 300)}`);
  const txt0 = stripC(KTAiChatUi.changeSummaryHtml({ goal: 'g', plan, review }, { labels: { amount: '金額' } }));
  assert(txt0.includes('作業者: ユーザー（approver@example.com）, ユーザー（manager@example.com）'), 'V8-2: 名前が分からなければ（ログイン中の利用者の情報が無い）、今までどおりログイン名');
  assert(KTContext.entityJaText({ type: 'USER', code: 'approver@example.com' }, null, { 'approver@example.com': '承認 太郎' }) === 'ユーザー「承認 太郎」' && KTContext.entityJaText({ type: 'GROUP', code: 'approver@example.com' }, null, { 'approver@example.com': '承認 太郎' }) === 'グループ（approver@example.com）' && KTContext.entityJaText({ type: 'USER', code: 'x' }) === 'ユーザー（x）', 'V8-3: 名前に替えるのはユーザーだけ（グループ・組織のコードは替えない）');
  //   画面: ログイン中の利用者（kintone.getLoginUser の代わりに loginUser）で右のペインの作業者を名前にする
  const PROC = (goal) => { const b = K.PLAN_V1(goal); return { ...b, plan: { ...b.plan, steps: [mkStep('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認待ち', { name: '部長承認待ち', assignees: ['USER:approver@example.com', 'USER:manager@example.com'] }, { title: 'ステータス「部長承認待ち」を追加' })] } }; };
  const m = K.mount({ planImpl: K.planImplOf(PROC), extra: { loginUser: () => ({ id: '7', code: 'approver@example.com', name: '承認 太郎' }) } });
  await ticks();
  const v = await K.adoptOnScreen(m); await ticks(8);
  const sum = stripC(m.$('kt-ai-change-summary').innerHTML);
  assert(v && v.plan && /ユーザー「承認 太郎」/.test(sum) && /ユーザー（manager@example\.com）/.test(sum) && !/approver@example\.com/.test(sum), `V8-4: 画面の右のペインの作業者（ログイン中の利用者は名前・ほかはログイン名）: ${(sum.replace(/\s+/g, ' ').match(/作業者[^）]*）[^）]*）/) || [sum.replace(/\s+/g, ' ').slice(0, 300)])[0]}`);
  //   ログイン中でない利用者のログイン名は、フィールドのコード（この画面の基準に approver＝承認者 がある）に書き換えずにそのまま残す
  const m2 = K.mount({ planImpl: K.planImplOf(PROC), extra: { loginUser: () => ({ id: '8', code: 'manager@example.com', name: '部長 花子' }) } });
  await ticks();
  await K.adoptOnScreen(m2); await ticks(8);
  const sum2 = stripC(m2.$('kt-ai-change-summary').innerHTML);
  assert(/ユーザー（approver@example\.com）/.test(sum2) && /ユーザー「部長 花子」/.test(sum2) && !/「承認者」@/.test(sum2), `V8-5: ログイン中でない利用者のログイン名は欠けずに残る（approver をフィールド「承認者」に書き換えない）: ${(sum2.replace(/\s+/g, ' ').match(/作業者[^）]*）[^）]*）/) || [sum2.replace(/\s+/g, ' ').slice(0, 300)])[0]}`);
});

// =========================================================
console.log('\n--- §V9. 最終案の動作の文（計画の AI の要約）も根拠の番号を外し、短い語を書き換えない ---');
await section(async () => {
  const x = makeConvC({ labels: LABELS, planImpl: (args) => planJs(args, { summary: '承認済みでは金額（amount）を編集不可にします［E12・E16］。PCとモバイルの両方で使います。' }) });
  await K.adoptC(x);
  const v = x.c.activePlan();
  const beh = v.final.behaviors.join(' ／ ');
  assert(v.final && /承認済みでは金額を編集不可にします。/.test(beh) && /PCとモバイルの両方で使います。/.test(beh) && !EVIDENCE.test(beh) && !CODES.test(beh) && !/端末区分/.test(beh), `V9-1: 最終案の「最終的にどう動くか」も根拠の番号（全角）を外し、PC をフィールドのコードと見なさない: ${beh}`);
  const out = visible(outsideDetails(finalHtml(x)));
  assert(!EVIDENCE.test(out) && !ESTIMATE.test(out), `V9-2: 最終案のカードの通常表示に根拠の番号・時間の目安を出さない: ${firstHit(out, EVIDENCE, ESTIMATE)}`);
});

// =========================================================
console.log('\n--- §V10. AI の文のログイン名・作業者の表記・通知の番号（レビューの指摘 row8）と承認の欄の適用範囲・モバイル ---');
//   素材: フィールドのコード approver（承認者）とログイン名 approver@example.com が同じ語を含む（実機の画面の基準と同じ）。AI の文に作業者の内部の表記
//   USER:user.approver と、Toolkit が Context に付けた通知の番号 general#3 が入る
const LABELS_U = { ...LABELS, approver: '承認者', manager: '部長' };
const REQ_U = '部長承認を追加したい';
const REPLY_U = '部長承認の作業者は manager@example.com、課長承認は今の approver@example.com のままにします。';
const B_U = '部長承認待ちの作業者を manager@example.com にし、承認待ちは approver@example.com のままにする。';
const SUM_U = '課長承認は approver@example.com のまま、general#3 はステータス変更時に作業者 USER:user.approver へ通知します。';
const STREAM_U = '承認待ちの作業者 approver@example.com はそのままにし、perRecord#2 の通知先 GROUP:sales も変えない計画です。';
const scriptU = ({ utterance: u }) => (u === REQ_U ? { reply: REPLY_U, intent: 'propose', proposal: { behaviors: [B(B_U, 'user')], assumptions: [], decisions: [], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } } : null);
const LOGIN_BROKEN = /「承認者」@|「部長」@|USER:|GROUP:|ORGANIZATION:|general#\d|perRecord#\d|reminder#\d/;
await section(async () => {
  const pg = gateMk();
  const x = makeConvC({ scriptFn: scriptU, labels: LABELS_U, planGate: pg, planImpl: (args) => planJs(args, { summary: SUM_U }) });
  const plan0 = x.services.plan;
  x.services.plan = async (args) => { if (typeof args.onText === 'function') args.onText(STREAM_U); return plan0({ ...args, onText: null }); };
  await x.c.send(REQ_U);
  const d = x.c.draft();
  const cardU = visible(KTAiChatUi.messageHtml(x.c.messages().filter(mm => mm.type === 'DRAFT').slice(-1)[0], { draft: d, draftDecisions: x.c.draftDecisions(), draftAnswers: new Map(), labels: LABELS_U }));
  const pane = visible(KTAiChatUi.draftSummaryHtml(d, { decisions: x.c.draftDecisions(), labels: LABELS_U }));
  assert(cardU.includes('課長承認は今の approver@example.com のままにします') && cardU.includes('manager@example.com') && !LOGIN_BROKEN.test(cardU), `V8-6a: 仮案のカード（会話）の AI の文のログイン名は、フィールドのコード（approver＝承認者）に書き換えずに残す: ${firstHit(cardU, LOGIN_BROKEN, /[^\n]*@example\.com[^\n]*/)}`);
  assert(pane.includes('承認待ちは approver@example.com のままにする') && !LOGIN_BROKEN.test(pane), `V8-6b: 右のペインの仮案の詳細でもログイン名を残す: ${firstHit(pane, LOGIN_BROKEN, /[^\n]*@example\.com[^\n]*/)}`);
  const p = x.c.send('採用します'); await ticks(8);
  const pm = x.c.messages().find(mm => mm.data && mm.data.kind === 'progress');
  const prog = pm ? visible(KTAiChatUi.progressInnerHtml(pm, { labels: LABELS_U })) : '';
  assert(pm && prog.includes('承認待ちの作業者 approver@example.com はそのままにし') && /レコードの条件通知（2 件目）の通知先グループ（sales）も変えない/.test(prog) && !LOGIN_BROKEN.test(prog), `V8-6c・H-1: 進みのカードの AI の説明: ログイン名を残し、通知の番号は Context の事実の言葉・作業者の表記は画面の表記: ${prog.replace(/\s+/g, ' ').slice(0, 300)}`);
  pg.open(); await p; await ticks(8);
  const v = x.c.activePlan();
  const beh = (v && v.final ? v.final.behaviors : []).join(' ／ ');
  assert(v && v.final && beh.includes('課長承認は approver@example.com のまま') && /アプリの条件通知（3 件目）はステータス変更時に作業者ユーザー（user\.approver）へ通知します/.test(beh) && !LOGIN_BROKEN.test(beh), `V8-6d・H-2: 最終案の動作の文: ログイン名を残し、general#3 は「アプリの条件通知（3 件目）」、USER:user.approver は「ユーザー（user.approver）」（ログイン名は残す）: ${beh}`);
  const out = visible(outsideDetails(finalHtml(x)));
  assert(!LOGIN_BROKEN.test(out) && out.includes('approver@example.com'), `V8-6e: 最終案のカードの通常表示にも壊れたログイン名・内部の表記を出さない: ${firstHit(out, LOGIN_BROKEN)}`);
  //   描画のときだけ（計画の要約・仮案の文の元の値は変えない）
  assert(v.plan.assessment.summary === SUM_U && d.reply === REPLY_U && d.items.behaviors[0].text === B_U, 'V8-6f: 計画と仮案の元の文は書き換えない（描画のときだけ）');
});
await section(async () => {
  //   承認の欄（画面）: 適用範囲（ALL）・Mobile は画面の言葉（全員・モバイル）
  const { m } = await K.mountFinal({ kind: 'js' });
  await K.waitUntil(() => ['ready', 'blocked', 'unavailable'].includes(m.panel.finalPrecheck().status), 80); await ticks(2);
  const pre = m.panel.finalPrecheck();
  const keep = ((pre.items && pre.items.keep) || []).join(' ／ ');
  const chatOut = visible(outsideDetails(m.chat()));
  assert(pre.status === 'ready' && /PC：.*　モバイル：/.test(keep) && /適用範囲（全員）は変更しません/.test(keep) && !/Mobile|ALL/.test(keep) && /適用範囲（全員）/.test(chatOut) && !/適用範囲（ALL）|Mobile：/.test(chatOut), `H-3: 承認の欄の適用範囲と PC / モバイルの件数は画面の言葉: ${keep}`);
  assert(KTAiChatUi.customizeScopeJa('ALL') === '全員' && KTAiChatUi.customizeScopeJa('ADMIN') === 'アプリの管理者だけ' && KTAiChatUi.customizeScopeJa('NONE') === '適用しない', 'H-4: 適用範囲の画面の言葉の表');
});
await section(async () => {
  //   前の確認の display の［partly］の残り（2026-10-09）: 右のペインの変更内容（changeSummaryHtml）の計画の AI の文（影響範囲の impact・JavaScript の requirement）にも
  //   displayLabels と同じ変換（通知の内部の番号は Context の事実の言葉・作業者の内部の表記は画面の表記。ログイン名は残し、フィールドの名前に書き換えない）
  const REQ_TEXT = '承認待ちでは approver@example.com 以外は金額（amount）を編集不可にし、USER:user.approver に通知する';
  const plan = { goal: 'g', assessment: { summary: 's' }, steps: [mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { title: 'JavaScript' })], customizations: [{ customizationId: 'C1', stepId: 'C1', requirement: REQ_TEXT, strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.edit.show'], fields: [] }], impact: [{ description: SUM_U }, { description: STREAM_U }], unknowns: [] };
  const sum = stripC(KTAiChatUi.changeSummaryHtml({ goal: 'g', plan, review: null }, { labels: LABELS_U }));
  assert(/アプリの条件通知（3 件目）はステータス変更時に作業者ユーザー（user\.approver）へ通知します/.test(sum) && /レコードの条件通知（2 件目）の通知先グループ（sales）も変えない/.test(sum) && sum.includes('課長承認は approver@example.com のまま') && sum.includes('approver@example.com 以外は') && /ユーザー（user\.approver）に通知する/.test(sum) && !LOGIN_BROKEN.test(sum), `H-5: 右のペインの変更内容の影響範囲と JavaScript の文: 通知の番号は Context の事実の言葉・作業者の表記は画面の表記・ログイン名は残す: ${firstHit(sum, LOGIN_BROKEN, /[^\n]*general#[^\n]*/, /[^\n]*条件通知[^\n]*/)}`);
  const sumU = stripC(KTAiChatUi.changeSummaryHtml({ goal: 'g', plan, review: null }, { labels: LABELS_U, users: { 'user.approver': '承認 太郎' } }));
  assert(/作業者ユーザー「承認 太郎」へ通知します/.test(sumU) && !LOGIN_BROKEN.test(sumU), `H-6: ログイン中の利用者なら名前（右のペインの作業者の表示と同じ）: ${firstHit(sumU, /[^\n]*承認 太郎[^\n]*/, LOGIN_BROKEN)}`);
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
