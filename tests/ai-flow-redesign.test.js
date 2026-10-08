// 会話フローの再設計 段階 B（仮案の会話。設計書 §2.1〜2.3・§2.7、契約 13 §11）: 要望 → 仮案 → 返事（採用／一部採用／不採用／修正／相談／雑談）
//
// 検証内容:
//   §B0 仮案の応答の検証と正規化（KTAiClient.validateProposal）・仮案の Context（KTContext.buildProposal）・決定的な前段（classifyDraft）
//   §B1 会話コントローラ（偽 services.propose。発言の文で台本を引く）で R01〜R08 と「ありがとう」「うーん」を 1 本の会話として固定する
//        R01 仮案 1 つ・先に必要な判断 1 件 / R02 中間の扱いを 1 問・数字は不変 / R03 期限の日数と休業日を別の key で記録・以後は再質問しない /
//        R04 通知先と条件の両方が動作と要件に残る / R05 決定事項に統合・同じ範囲を再確認しない / R06「おすすめで」は推奨を採用（おまかせ）・再要求なし /
//        R08 質問は仮案を変えず計画を作らない / 相づちは何も変えない / R07「通知は不要、期限は 5 営業日、ほかは採用」を 1 回で不採用・変更・採用（intent adopt）
//   §B2 画面（mountAiWorkspace の偽 client。health に proposal・ask / propose は SSE を模擬）: 部分表示 → 仮案のカード（ボタン・回答欄・内部の番号を出さない）→
//        回答欄 → 決定事項に記録してから AI へ → ［一部採用］は案内だけ → ［採用］で従来の計画へ（要件の台帳と仮案の対応を引き継ぐ）/ 能力が無ければ従来の流れ
//   §B3 独立レビューの指摘（2026-10-07）: 採用 → 計画の失敗で open に戻る・［再試行］は「採用します」で仮案から作り直す / 計画の AI に要件と決定事項を構造化して渡し
//        合成文を台帳に入れない / 不採用の要件の取り消しは項目 id の対応（補助は内容の文字の重なり 7 割）/ 回答済みの key の再出現は「再確認」/ intent propose は新しい仮案 /
//        採用語（承認します・確定・それで・お願いします）と相づち（はい・OK）の分類 / 仮案の応答待ちの質問は並べて答える
//   §B4 画面: 採用 → 計画の失敗 → 右の見出し・詳細・カードの文 → ［再試行］→ 計画ができたら畳む / 回答欄（data-dkey）のフォーカスの復元
//   §B6 段階 B 修正後の確認（2026-10-07）: 仮案で答えた決定事項が最初の計画（revision 無し）の Context に入り、計画の系列の台帳に回答済みとして入る（計画の AI の再質問は
//        openQuestions に出ず reasked に記録・差分更新でも decisions に入る）/ 仮案の AI の応答待ち中はカードのボタン・回答欄を出さず案内だけ / 版の表示用の goal は依頼文の 1 行目
//        （Gateway へ送る goal は 2 行のまま）/ 最終案の作成中の質問の要約は「採用した仮案（最終案を作成中）」/ 仮案が無いときの相づち・制止・短い否定は PROPOSE にしない（言い切りは 8 字以上）
//
// 実行方法: node tests/ai-flow-redesign.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const T = loadToolkit();
const { KTDeps, KTScan, KTContext, KTAiClient, KTAiAnswers, KTAiConversation, KTAiChatUi, KTAiWorkspaceViewModel: VM, mountAiWorkspace } = T;
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');

const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
const clone = (v) => JSON.parse(JSON.stringify(v));
/** 会話に内部の番号・英字のコードが出ていないか（仮案の項目の id・key・requestId） */
const INTERNAL = /\b[BAQ][0-9]+\b|approval\.|deadline\.|notify\.|lock\.|scope\.|requestId|\bR[0-9]+「|\bE[0-9]+\b/;
const outsideDetails = (html) => String(html).replace(/<details[\s\S]*?<\/details>/g, '');

// ---- 入力（ai-two-pane と同じ形）----
function buildInputs() {
  const data = FX.makeData();
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  const fieldRows = fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType }));
  const scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files: FX.files, fields: fieldRows, deps, skippedUrlFiles: FX.skippedUrlFiles });
  scan.results = KTScan.analyze({ fields: fieldRows, files: FX.files.filter(f => f.kind === 'js'), snippet: { before: 24, after: 48 } });
  KTDeps.mergeScannerEdges(deps, scan);
  KTDeps.applyIncomingRefs(deps, FX.incoming);
  return { data, deps, scan, incoming: FX.incoming };
}
const INPUTS = buildInputs();

// ---- 仮案の台本（発言の文で引く。項目の id は前回の仮案から key / 文で探す） ----
const META = { requestId: 'pp-1', usage: { usedThisMonth: 2, monthlyLimit: 20 }, normalization: { warnings: [] }, ai: { model: 'm', latencyMs: 40, streamed: true, firstTextMs: 9, usage: { input_tokens: 2000, output_tokens: 500, input_tokens_details: { cached_tokens: 300 }, output_tokens_details: { reasoning_tokens: 50 } } } };
const B = (text, origin = 'ai') => ({ text, origin });
const A = (key, label, text, changeHint = '') => ({ key, label, text, changeHint });
const Q = (key, label, question, options, recommendation, impact, blocking) => ({ key, label, question, options, recommendation, impact, blocking });
const APPROVER = A('approval.approver_field', '承認者の指定方法', '承認者はユーザー選択フィールド「課長承認者」「部長承認者」を新設して指定する', '既存のフィールドを使うこともできます');
const ROUTE = A('approval.route', '承認の順序', '課長承認の後に部長承認（順番は固定）', '同時承認にもできます');
const BASE = A('deadline.base', '期限の起算日', '期限は申請日の翌営業日から数える', '申請日当日から数えることもできます');
const CSV = A('scope.csv_api', 'CSV・API の扱い', 'CSV の読み込みと API 経由の更新は使わない前提（画面の操作だけを制御する）', '使う場合は別の対策が要ります');
const Q_THRESHOLD = Q('approval.threshold', '部長承認の条件', '部長承認は金額に関係なく常に必要ですか、一定金額以上のときだけですか', ['常に必要', '一定金額以上のときだけ'], '一定金額以上のときだけ', '承認ルートの分岐と、金額の条件の設定が変わります', true);
const Q_MIDDLE = Q('approval.threshold_middle', '中間の金額の扱い', '100円以上100万円未満の申請に部長承認は必要ですか', ['必要', '不要'], '不要', '中間の金額の承認ルートが変わります', true);
const Q_DAYS = Q('deadline.days', '承認の期限', '承認の期限は申請から何営業日にしますか', ['3営業日', '5営業日', '7営業日'], '5営業日', '期限超過の判定日が変わります', false);
const Q_HOLIDAYS = Q('deadline.holidays', '休業日の扱い', '期限の計算で会社独自の休業日を考慮しますか', ['考慮する', '考慮しない'], '考慮しない', '期限の日付の計算方法が変わります', false);
const Q_LOCK = Q('lock.scope', '編集不可の対象', '申請中に編集できなくする対象は全員ですか、申請者以外ですか', ['全員', '申請者以外'], '全員', '申請者が申請中に修正できるかが変わります', false);
const Q_TIMING = Q('notify.timing', '部長への通知のタイミング', '部長への通知は課長承認の直後に送りますか、期限の前日に送りますか', ['課長承認の直後', '期限の前日'], '', '部長が気づく時点が変わります', true);
const B_SELECT = B('申請時に課長と部長の承認者をユーザー選択で指定する', 'user');
const B_ROUTE = B('承認は課長 → 部長の順に進み、それぞれの承認者だけが承認できる');
const B_UNDER = B('100円未満の申請は部長承認を省く', 'user');
const B_OVER = B('100万円以上の申請は部長承認を必要とする', 'user');
const B_NOTIFY_TO = B('承認依頼の通知は現在の承認者へ送る', 'user');
const B_NOTIFY_IF = B('課長承認中で100万円以上の申請は部長にも通知する', 'user');
const B_LOCK = B('申請中のレコードは編集できないようにする', 'user');
const STD = ['プロセス管理のステータス（申請中・課長承認待ち・部長承認待ち・承認済み）と承認アクション', '承認者フィールドの追加'];
const req = (op, o) => ({ op, target: '', condition: '', behavior: '', exceptions: [], decision: 'decided', disposition: 'adopted', sourceQuotes: [], planRefs: [], note: '', ...o });
const idBy = (list, pred) => { const x = (list || []).find(pred); return x ? x.id : null; };
const reqIdBy = (reqs, re) => (reqs || []).filter(r => r.decision !== 'revoked' && re.test(`${r.condition} ${r.behavior}`)).map(r => r.id);
/**
 * 台本: utterance と前回の仮案・要件から Gateway の応答（契約の形）を作る。見つからなければ null（テストの失敗にする）
 */
function script({ utterance: u, previous: p, requirements: reqs }) {
  const prevB = (p && p.behaviors) || [], prevA = (p && p.assumptions) || [], prevD = (p && p.decisions) || [];
  if (/課長・部長の承認者を選ぶ運用/.test(u)) return { reply: '課長と部長を申請ごとに選んで承認する流れにできます。承認ルートはプロセス管理で、承認者の指定はユーザー選択フィールドで行います。部長承認を金額で分けるかだけ先に決めてください。', intent: 'propose',
    proposal: { behaviors: [B_SELECT, B_ROUTE], assumptions: [APPROVER, ROUTE], decisions: [Q_THRESHOLD], approach: { standard: STD, js: [] }, cannot: [] },
    turn: { ops: [], answers: [], requirementOps: [req('add', { target: '承認', condition: '申請時', behavior: '課長と部長の承認者を選んで承認する', sourceQuotes: ['課長・部長の承認者を選ぶ運用にしたい'], planRefs: ['B1'] })] } };
  if (/100円未満は部長不要/.test(u)) return { reply: '100円未満は部長承認なし、100万円以上は部長承認ありで進めます。その間（100円以上100万円未満）の扱いだけ決めてください。期限と休業日は、あとで決めても進められます。', intent: 'update',
    proposal: { behaviors: [B_SELECT, B_ROUTE, B_UNDER, B_OVER], assumptions: [APPROVER, ROUTE], decisions: [Q_MIDDLE, Q_DAYS, Q_HOLIDAYS], approach: { standard: STD, js: [] }, cannot: [] },
    turn: { ops: [{ id: idBy(prevB, b => /課長と部長の承認者/.test(b.text)), op: 'adopt', text: '', quote: '' }], answers: [{ id: idBy(prevD, d => d.key === 'approval.threshold'), kind: 'value', text: '100円未満は不要、100万円以上は必要', quote: '100円未満は部長不要、100万円以上は必要' }],
      requirementOps: [req('add', { target: '部長承認', condition: '100万円以上', behavior: '部長承認を必要とする', sourceQuotes: ['100万円以上は必要'], planRefs: ['B4'] }), req('add', { target: '部長承認', condition: '100円未満', behavior: '部長承認を省く', sourceQuotes: ['100円未満は部長不要'], planRefs: ['B3'] })] } };
  if (/7営業日/.test(u) && /休業日/.test(u)) return { reply: '期限は 7 営業日、会社独自の休業日は考慮しない前提で進めます。残りは中間の金額の扱いだけです。', intent: 'update',
    proposal: { behaviors: [B_SELECT, B_ROUTE, B_UNDER, B_OVER], assumptions: [APPROVER, ROUTE, A('deadline.days', '承認の期限', '承認の期限は申請から 7 営業日（土日祝のみ除く）', '日数は変えられます'), BASE], decisions: [Q_MIDDLE], approach: { standard: STD, js: [] }, cannot: [] },
    turn: { ops: [], answers: [{ id: idBy(prevD, d => d.key === 'deadline.days'), kind: 'value', text: '7営業日', quote: '7営業日' }, { id: idBy(prevD, d => d.key === 'deadline.holidays'), kind: 'value', text: '会社独自の休業日は考慮しない', quote: '会社独自の休業日は今回はなし' }],
      requirementOps: [req('add', { target: '承認の期限', condition: '申請から', behavior: '7 営業日以内に承認する（土日祝のみ除く）', sourceQuotes: ['7営業日'], planRefs: ['A3'] })] } };
  if (/現在の承認者へ/.test(u)) return { reply: '承認依頼の通知は現在の承認者に送り、課長承認中で 100 万円以上の申請は部長にも通知します。', intent: 'update',
    proposal: { behaviors: [B_SELECT, B_ROUTE, B_UNDER, B_OVER, B_NOTIFY_TO, B_NOTIFY_IF], assumptions: [APPROVER, ROUTE, A('deadline.days', '承認の期限', '承認の期限は申請から 7 営業日（土日祝のみ除く）', '日数は変えられます'), BASE], decisions: [Q_MIDDLE], approach: { standard: [...STD, '承認依頼の通知（レコードの条件通知）'], js: [] }, cannot: [] },
    turn: { ops: [], answers: [], requirementOps: [req('add', { target: '通知', condition: '承認依頼のとき', behavior: '現在の承認者へ通知する', sourceQuotes: ['現在の承認者へ'], planRefs: ['B5'] }), req('add', { target: '通知', condition: '課長承認中で100万円以上', behavior: '部長にも通知する', sourceQuotes: ['課長承認中で100万円以上なら部長にも通知'], planRefs: ['B6'] })] } };
  if (/申請中は編集不可/.test(u)) return { reply: '申請中はレコードを編集できないようにします（JavaScript で制御）。CSV・API 経由の更新は使わない前提で、画面の操作だけを対象にします。編集不可の対象が全員か申請者以外かだけ決めてください。', intent: 'update',
    proposal: { behaviors: [B_SELECT, B_ROUTE, B_UNDER, B_OVER, B_NOTIFY_TO, B_NOTIFY_IF, B_LOCK], assumptions: [APPROVER, ROUTE, A('deadline.days', '承認の期限', '承認の期限は申請から 7 営業日（土日祝のみ除く）', '日数は変えられます'), BASE, CSV], decisions: [Q_MIDDLE, Q_LOCK], approach: { standard: [...STD, '承認依頼の通知（レコードの条件通知）'], js: ['申請中のステータスでフィールドの編集を止める（レコード編集画面）'] }, cannot: [] },
    turn: { ops: [], answers: [], requirementOps: [req('add', { target: 'レコードの編集', condition: '申請中', behavior: '編集できないようにする', sourceQuotes: ['申請中は編集不可'], planRefs: ['B7'] })] } };
  if (/^全員で/.test(u)) return { reply: '申請中は全員が編集できないようにします。部長への通知のタイミングだけ決めてください。', intent: 'update',
    proposal: { behaviors: [B_SELECT, B_ROUTE, B_UNDER, B_OVER, B_NOTIFY_TO, B_NOTIFY_IF, B_LOCK], assumptions: [APPROVER, ROUTE, A('deadline.days', '承認の期限', '承認の期限は申請から 7 営業日（土日祝のみ除く）', '日数は変えられます'), BASE, CSV], decisions: [Q_MIDDLE, Q_TIMING], approach: { standard: [...STD, '承認依頼の通知（レコードの条件通知）'], js: ['申請中のステータスでフィールドの編集を止める（レコード編集画面）'] }, cannot: [] },
    turn: { ops: [], answers: [{ id: idBy(prevD, d => d.key === 'lock.scope'), kind: 'value', text: '全員', quote: '全員で' }], requirementOps: [] } };
  if (/おすすめで/.test(u)) return { reply: '中間の金額はおすすめどおり部長承認なしで進めます。部長への通知のタイミングだけ決めてください。', intent: 'update',
    proposal: { behaviors: [B_SELECT, B_ROUTE, B_UNDER, B_OVER, B_NOTIFY_TO, B_NOTIFY_IF, B_LOCK], assumptions: [APPROVER, ROUTE, A('deadline.days', '承認の期限', '承認の期限は申請から 7 営業日（土日祝のみ除く）', '日数は変えられます'), BASE, CSV, A('approval.threshold_middle', '中間の金額', '100円以上100万円未満は部長承認なし（おすすめ）', '必要にもできます')], decisions: [Q_TIMING], approach: { standard: [...STD, '承認依頼の通知（レコードの条件通知）'], js: ['申請中のステータスでフィールドの編集を止める（レコード編集画面）'] }, cannot: [] },
    turn: { ops: [], answers: [], requirementOps: [] } };
  if (/違いが気になる/.test(u)) return { reply: '5 営業日にすると、7 営業日より 2 営業日早く期限超過の判定になります。承認者への通知の時点は変わりません。', intent: 'question', proposal: { behaviors: [], assumptions: [], decisions: [], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } };
  if (/通知は不要/.test(u)) return { reply: '通知は外し、期限は 5 営業日に変えて、ほかは採用します。', intent: 'adopt',
    proposal: { behaviors: [B_SELECT, { ...B_ROUTE, origin: 'user' }, B_UNDER, B_OVER, B_LOCK], assumptions: [APPROVER, ROUTE, A('deadline.days', '承認の期限', '承認の期限は申請から 5 営業日（土日祝のみ除く）', '日数は変えられます'), BASE, CSV, A('approval.threshold_middle', '中間の金額', '100円以上100万円未満は部長承認なし（おすすめ）', '必要にもできます')], decisions: [], approach: { standard: STD, js: ['申請中のステータスでフィールドの編集を止める（レコード編集画面）'] }, cannot: [] },
    turn: {
      ops: [
        ...prevB.filter(b => /通知/.test(b.text)).map(b => ({ id: b.id, op: 'reject', text: '', quote: '通知は不要' })),
        { id: idBy(prevA, a => a.key === 'deadline.days'), op: 'modify', text: '承認の期限は申請から 5 営業日（土日祝のみ除く）', quote: '期限は5営業日' },
        ...prevD.filter(d => d.key === 'notify.timing').map(d => ({ id: d.id, op: 'reject', text: '', quote: '通知は不要' })),
        ...prevB.filter(b => !/通知/.test(b.text)).map(b => ({ id: b.id, op: 'adopt', text: '', quote: 'ほかは採用' })),
      ],
      answers: [],
      requirementOps: [
        ...reqIdBy(reqs, /通知/).map(id => req('revoke', { id, sourceQuotes: ['通知は不要'] })),
        ...reqIdBy(reqs, /営業日/).map(id => req('update', { id, target: '承認の期限', condition: '申請から', behavior: '5 営業日以内に承認する（土日祝のみ除く）', sourceQuotes: ['期限は5営業日'], planRefs: ['A3'] })),
      ],
    } };
  return null;
}
/** 契約の形の応答 → Toolkit の client.propose が返す形（validateProposal を通す） */
const normalized = (raw, requestId = 'pp-1') => { const v = KTAiClient.validateProposal({ ok: true, contractVersion: '2.1', meta: META, ...raw }); if (!v.ok) throw new Error(`台本の形が不正: ${v.errors[0].message}`); return { ...v.normalized, requestId, clientWarnings: v.warnings }; };

// =========================================================
(async () => {
console.log('\n--- §B0. 仮案の応答の検証と正規化・仮案の Context・決定的な前段 ---');
await section(async () => {
  const raw = { ok: true, contractVersion: '2.1', meta: META, reply: ' 結論です。 ', intent: 'adopt',
    proposal: { behaviors: [{ id: 'x9', text: '動作 1', origin: 'user' }, { id: 'x8', text: '', origin: 'ai' }, { text: '動作 2', origin: 'bogus' }], assumptions: [{ key: 'Deadline Days', label: 'l', text: '前提', changeHint: '' }, { key: 'deadline_days', text: '前提 2' }],
      decisions: [{ key: '期限', question: 'Q1?', blocking: true, options: ['a', 'b', 'c', 'd', 'e', 'f'] }, { key: 'k2', question: 'Q2?', blocking: true }, { key: 'k3', question: 'Q3?', blocking: true }, { key: 'k4', question: '' }], approach: { standard: ['s'], js: ['j'] }, cannot: ['c'] },
    turn: { ops: [{ id: 'B1', op: 'adopt' }, { id: 'Q1', op: 'modify', text: 'x' }, { id: 'Q2', op: 'reject' }, { id: 'B2', op: 'modify', text: '' }, { id: 'A1', op: 'nope' }], answers: [{ id: 'Q1', kind: 'value', text: '' }, { id: 'Q2', kind: 'delegated', text: '' }, { id: 'B1', kind: 'value', text: 'x' }], requirementOps: [{ op: 'add', behavior: 'b' }] } };
  const v = KTAiClient.validateProposal(raw);
  const n = v.normalized;
  assert(v.ok && n.reply === '結論です。' && n.proposal.behaviors.map(b => b.id).join(',') === 'B1,B2' && n.proposal.behaviors[1].origin === 'ai', `B0-1: id は B1… に振り直し・空の項目は外す・origin は user / ai: ${JSON.stringify(n.proposal.behaviors)}`);
  assert(n.proposal.assumptions.map(a => a.key).join(',') === 'deadline_days,deadline_days_2' && n.proposal.decisions.map(d => d.key).join(',') === 'other,k2,k3', `B0-2: key の正規化（小文字・空白は _）と重複（_2）・空は other: ${n.proposal.assumptions.map(a => a.key)} / ${n.proposal.decisions.map(d => d.key)}`);
  assert(n.proposal.decisions.filter(d => d.blocking).length === 2 && n.proposal.decisions[0].options.length === 5 && n.intent === 'update', `B0-3: blocking は 2 件まで・options は 5 件・blocking が残る adopt は update に: ${n.intent}`);
  assert(n.turn.ops.map(o => `${o.id}:${o.op}`).join(',') === 'B1:adopt,Q2:reject' && n.turn.answers.map(a => `${a.id}:${a.kind}`).join(',') === 'Q2:delegated' && n.turn.requirementOps.length === 1, `B0-4: 判断への ops は reject だけ・空の modify と語彙外の op は外す・空の value の answer は外す: ${JSON.stringify(n.turn)}`);
  assert(v.warnings.some(w => w.code === 'PROPOSAL_BLOCKING_LIMIT') && v.warnings.some(w => w.code === 'PROPOSAL_KEY_DUPLICATE') && v.warnings.some(w => w.code === 'PROPOSAL_ADOPT_WITH_BLOCKING') && v.warnings.some(w => w.code === 'PROPOSAL_OP_ON_DECISION'), `B0-5: 直した点は clientWarnings に残す: ${v.warnings.map(w => w.code).join(',')}`);
  const v2 = KTAiClient.validateProposal({ ok: true, contractVersion: '2.1', meta: META, reply: 'r', intent: 'bogus', proposal: {}, turn: { ops: [{ id: 'B1', op: 'adopt' }] } });
  assert(v2.ok && v2.normalized.intent === 'unclear' && v2.normalized.proposalUnchanged === true && v2.normalized.turn.ops.length === 0, 'B0-6: 語彙外の intent は unclear（仮案を変えない。turn は外す）');
  assert(!KTAiClient.validateProposal({ ok: true, contractVersion: '2.1', meta: META, reply: '', intent: 'propose' }).ok && !KTAiClient.validateProposal({ ok: false }).ok, 'B0-7: reply が無い・ok でないときは失敗');
  // 仮案の Context: KTContext v1 の形・conversation.mode・facts を絞る（目安 12k 字）
  const ctx = KTContext.buildProposal({ utterance: '金額が100万円以上なら部長承認にして、承認後は金額を編集できなくしたい', previous: null, requirements: [], decisions: [{ id: 'dd1', key: 'deadline.days', label: '期限', answer: '7営業日', kind: 'value' }], data: INPUTS.data, deps: INPUTS.deps, scan: INPUTS.scan, incoming: INPUTS.incoming, options: { now: '2026-10-07T00:00:00.000Z' } });
  assert(ctx.contextVersion === '1' && ctx.question.startsWith('金額が100万円以上') && ctx.conversation.mode === 'proposal' && ctx.conversation.proposal === null && ctx.conversation.decisions[0].key === 'deadline.days' && Array.isArray(ctx.conversation.requirements), 'B0-8: KTContext v1 の形で question = 今回の発言・conversation = { mode proposal, proposal, decisions, requirements }');
  const kinds = new Set(ctx.facts.map(f => f.kind));
  assert(ctx.facts.every((f, i) => f.id === `E${i + 1}`) && kinds.has('overview') && ctx.facts.some(f => f.kind === 'field' && f.field && f.field.code === 'amount') && kinds.has('js-file') && ctx.size.chars <= 12000 && ctx.size.chars >= 2000, `B0-9: 根拠ID は E1…・概要・関連フィールド（金額）・既存 JS の要約を含み 12k 字以内: ${ctx.size.chars} 字 / ${[...kinds].join(',')}`);
  assert(!ctx.conversation.brief && !ctx.planContext && JSON.stringify(ctx.facts).length < JSON.stringify(KTContext.buildPlan({ goal: ctx.question, data: INPUTS.data, deps: INPUTS.deps, scan: INPUTS.scan, incoming: INPUTS.incoming }).facts).length, 'B0-10: brief / planContext は付けない。計画の Context より小さい');
  // 決定的な前段
  const c = KTAiConversation.classifyDraft;
  const noDraft = { activePlan: null, draft: null, draftDecisions: [] };
  const open = { activePlan: null, draftDecisions: [], draft: { id: 'd1', status: 'open', items: { behaviors: [], assumptions: [], decisions: [{ id: 'Q1', key: 'k', question: 'q', recommendation: 'rec', blocking: true }], approach: { standard: [], js: [] }, cannot: [] } } };
  const openNoRec = { ...open, draft: { ...open.draft, items: { ...open.draft.items, decisions: [{ id: 'Q1', key: 'k', question: 'q', recommendation: '', blocking: true }] } } };
  assert(c('課長・部長の承認者を選ぶ運用にしたい', noDraft)?.intent === 'PROPOSE' && c('このフィールドは何に使ってる？', noDraft) === null && c('ありがとう', noDraft) === null && c('反映して', noDraft) === null && c('承認済みでは金額を編集不可', noDraft)?.intent === 'PROPOSE', 'B0-11: 計画も仮案も無い: 依頼は PROPOSE・質問 / 相づち / 操作の命令は従来');
  assert(c('ありがとう', open)?.reason === 'DRAFT_SMALLTALK' && c('うーん', open)?.reason === 'DRAFT_SMALLTALK' && c('5営業日にすると何が変わる？', open) === null, 'B0-12: 仮案が open: 相づちは何もしない・質問文だけは従来の QA');
  assert(c('それでお願いします', open)?.intent === 'DRAFT_REPLY' && c('それでお願いします', { ...open, draftDecisions: [{ key: 'k', answer: 'x' }] })?.intent === 'ADOPT_DRAFT' && c('採用します', { ...open, draftDecisions: [{ key: 'k', answer: 'x' }] })?.reason === 'ADOPT_WORDS', 'B0-13: 明確な採用語: 先に必要な判断が残っていれば AI に聞き直させ、無ければ ADOPT_DRAFT');
  assert(c('おすすめで', open)?.intent === 'ADOPT_DRAFT' && c('おすすめで', open)?.delegated[0].kind === 'delegated' && c('おすすめで', openNoRec)?.reason === 'DELEGATE_WITH_OPEN', 'B0-14:「おすすめで」: 推奨を採用（おまかせ）。推奨の無い先に必要な判断が残れば AI へ');
  assert(c('通知は不要、期限は5営業日、ほかは採用', open)?.intent === 'DRAFT_REPLY' && c('この案は採用しません', open)?.intent === 'DRAFT_REPLY' && c('ほかは採用で', open)?.intent === 'DRAFT_REPLY', 'B0-15: 修正の語を含む文・不採用は DRAFT_REPLY（AI に読ませる）');
  assert(c('何か', { ...noDraft, activePlan: { status: 'ACTIVE' } }) === null && c('採用します', { ...open, activePlan: { status: 'ACTIVE' } }) === null, 'B0-16: 計画があるときは従来どおり（null）');
});

// =========================================================
console.log('\n--- §B1. 会話コントローラ: R01〜R08 と「ありがとう」「うーん」を 1 本の会話として（偽 services.propose） ---');
/**
 * 偽 services。withPlan = true で services.plan を付ける（既定は計画を作らない応答）。planImpl で差し替え（x.planImpl = … で後から変えられる）。
 * proposeGate を渡すと、仮案の AI の応答を途中で止められる（応答待ちの間の発言の検証）。台本は scriptFn（既定は script）
 */
function makeConv({ features = ['requirements', 'brief', 'stream', 'proposal'], withPlan = false, planImpl = null, proposeGate = null, scriptFn = script } = {}) {
  const calls = { propose: [], ask: [], plan: [] };
  let t = 1000;
  const x = { planImpl };
  const services = {
    conversationFeatures: () => features,
    revisionModes: () => ['full'],
    async propose(args) {
      calls.propose.push({ utterance: args.utterance, previous: clone(args.previous), decisions: clone(args.decisions), requirements: clone(args.requirements), working: args.working });
      const raw = scriptFn(args);
      if (!raw) return { ok: false, reason: 'NO_SCRIPT', message: `台本がありません: ${args.utterance}` };
      t += 3000; if (typeof args.onText === 'function') args.onText(raw.reply.slice(0, 12)); await tick();
      if (proposeGate) await proposeGate.p;
      t += 4000; if (typeof args.onText === 'function') args.onText(raw.reply);
      return { ok: true, proposal: normalized(raw, `pp-${calls.propose.length}`), ctx: { facts: [] }, perf: { baseWaitMs: 0, contextMs: 5, requestMs: 7000 } };
    },
    async ask(args) { calls.ask.push({ question: args.question, conversation: clone(args.conversation) }); t += 2000; return { ok: true, answer: { answer: '5 営業日にすると判定が 2 営業日早くなります。', facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx: { facts: [] } }; },
    readiness() { return null; },
    ...(withPlan || planImpl ? { async plan(args) { calls.plan.push({ goal: args.goal, decisions: clone(args.decisions ?? null), requirements: clone(args.requirements ?? null), revision: args.revision ? true : false }); t += 30000; return x.planImpl ? x.planImpl(args) : { plan: null, message: '（テスト: 計画は作らない）', reason: 'TEST' }; } } : {}),
  };
  const c = KTAiConversation.create({ services, now: () => '2026-10-07T00:00:00.000Z', clock: () => t });
  Object.assign(x, { c, calls, services, kinds: () => c.messages().map(m => m.data?.kind || m.type), last: () => c.messages()[c.messages().length - 1], draft: () => c.draft(), ledger: (id) => c.state.ledgers.get(id) || null });
  return x;
}
/** 計画の AI の成功の応答（最小の計画。turn に coverage 無し） */
const planOk = (args) => ({ plan: { goal: args.goal, assessment: { summary: '承認の流れを設定します。' }, steps: [], customizations: [], provisionals: [], questions: [] }, ctx: null, review: null, gatewayPlan: null, turn: { reply: '計画を作りました。', requirementOps: [], utteranceCoverage: [] } });
const planFail = () => ({ plan: null, message: '計画を作れませんでした（テスト）', reason: 'TEST' });
const planThrow = () => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); };
const gateMk = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
await section(async () => {
  const x = makeConv();
  const { c, calls } = x;
  const draft = () => c.draft();
  const keys = () => c.draftDecisions().map(d => d.key);
  const openKeys = () => (draft().items.decisions || []).map(d => d.key);
  const behaviorTexts = () => draft().items.behaviors.map(b => b.text);
  const reqs = () => c.requirements();
  assert(c.proposalOn() === true && c.classify('課長・部長の承認者を選ぶ運用にしたい').intent === 'PROPOSE', 'R01-0: health の conversation に proposal があるので仮案の経路');

  // R01
  const r1 = await c.send('課長・部長の承認者を選ぶ運用にしたい');
  assert(r1.ok && r1.intent === 'PROPOSE' && calls.propose.length === 1 && calls.plan.length === 0 && calls.propose[0].previous === null && calls.propose[0].decisions.length === 0, 'R01-1: 新しい依頼は仮案の AI へ（計画の AI・先回りの返答は呼ばない。前回の仮案は null）');
  assert(draft() && draft().status === 'open' && draft().rev === 1 && draft().request === '課長・部長の承認者を選ぶ運用にしたい' && draft().items.behaviors.length === 2 && draft().items.decisions.filter(d => d.blocking).length === 1 && draft().items.decisions.length === 1, `R01-2: 仮案 1 つ・先に必要な判断 1 件: ${JSON.stringify(draft().items.decisions.map(d => d.key))}`);
  const cards = c.messages().filter(m => m.type === 'DRAFT');
  assert(cards.length === 1 && cards[0].data.draftId === draft().id && cards[0].data.rev === 1 && /課長と部長を申請ごとに選んで/.test(cards[0].data.reply), 'R01-3: 仮案のカード（MSG.DRAFT）が 1 枚');
  assert(reqs().length === 1 && reqs()[0].decision === 'decided' && /課長と部長の承認者/.test(reqs()[0].behavior), `R01-4: 要件は仮案の台帳（鍵は仮案の id）に decided で入る: ${JSON.stringify(reqs())}`);
  const t1 = c.metrics().timings.slice(-1)[0];
  assert(t1.intent === 'PROPOSE' && t1.firstTextMs === 3000 && t1.doneMs === 7000 && t1.aiCalls === 1 && t1.calls[0].kind === 'propose' && t1.ai && t1.ai.model === 'm' && t1.ai.outputTokens === 500, `R01-5: 計測（firstTextMs / doneMs / ai）: ${JSON.stringify(t1)}`);
  assert(!c.messages().some(m => m.type === 'LOADING'), 'R01-6: 逐次表示の吹き出しは完了で外れる');

  // R02
  const r2 = await c.send('100円未満は部長不要、100万円以上は必要');
  assert(r2.ok && r2.intent === 'DRAFT_REPLY' && calls.propose.length === 2 && calls.propose[1].previous && calls.propose[1].previous.decisions[0].id === 'Q1' && calls.propose[1].previous.behaviors.length === 2, 'R02-1: 返事は前回の仮案（id 付き）と一緒に仮案の AI へ');
  assert(draft().rev === 2 && openKeys().join(',') === 'approval.threshold_middle,deadline.days,deadline.holidays' && draft().items.decisions.filter(d => d.blocking).length === 1 && behaviorTexts().some(s => /100円未満/.test(s)) && behaviorTexts().some(s => /100万円以上/.test(s)), `R02-2: 中間の扱いだけ 1 問（先に必要）・数字は不変: ${openKeys()} / ${behaviorTexts().join('｜')}`);
  assert(keys().includes('approval.threshold') && c.draftDecisions().find(d => d.key === 'approval.threshold').answer === '100円未満は不要、100万円以上は必要' && draft().items.behaviors[0].origin === 'user', 'R02-3: 前回の判断への回答は key 付きの決定事項に・採用した項目は origin user');
  assert(reqs().filter(r => r.decision !== 'revoked').length === 3 && c.messages().filter(m => m.type === 'DRAFT').length === 2, 'R02-4: 要件 3 件・仮案のカードは新しい 1 枚（前のカードは畳む側）');
  const prevCard = c.messages().filter(m => m.type === 'DRAFT')[0];
  assert(/kt-ai-old-card/.test(KTAiChatUi.messageHtml(prevCard, { draft: draft(), draftDecisions: c.draftDecisions() })) && /前の仮案 — このあと直した案があります/.test(KTAiChatUi.messageHtml(prevCard, { draft: draft(), draftDecisions: c.draftDecisions() })), 'R02-5: 前の仮案のカードは 1 行に畳む');

  // R03
  const r3 = await c.send('7営業日で。会社独自の休業日は今回はなし');
  assert(r3.ok && r3.intent === 'DRAFT_REPLY' && c.draftDecisions().find(d => d.key === 'deadline.days')?.answer === '7営業日' && c.draftDecisions().find(d => d.key === 'deadline.holidays')?.answer === '会社独自の休業日は考慮しない', `R03-1: 期限の日数と休業日を別の key で記録: ${JSON.stringify(c.draftDecisions().map(d => [d.key, d.answer]))}`);
  assert(openKeys().join(',') === 'approval.threshold_middle' && draft().items.assumptions.some(a => a.key === 'deadline.days'), 'R03-2: 回答済みの判断は仮案から消え、前提（7 営業日）になる');

  // R04
  const r4 = await c.send('現在の承認者へ。課長承認中で100万円以上なら部長にも通知');
  assert(r4.ok && behaviorTexts().some(s => /現在の承認者へ/.test(s)) && behaviorTexts().some(s => /課長承認中で100万円以上/.test(s)) && reqs().some(r => /現在の承認者/.test(r.behavior)) && reqs().some(r => /課長承認中で100万円以上/.test(r.condition) && /部長にも通知/.test(r.behavior)), `R04-1: 通知先と条件の両方が動作と要件に残る: ${behaviorTexts().slice(-2).join('｜')}`);
  assert(calls.propose[3].decisions.map(d => d.key).sort().join(',') === 'approval.threshold,deadline.days,deadline.holidays' && calls.propose[3].requirements.length >= 4, 'R04-2: 仮案の AI には決定事項（key 付き）と要件の台帳を毎回渡す');

  // R05
  await c.send('申請中は編集不可にして。CSV・APIは使わない');
  assert(openKeys().join(',') === 'approval.threshold_middle,lock.scope' && draft().items.assumptions.some(a => a.key === 'scope.csv_api') && draft().items.approach.js.length === 1, 'R05-1: 編集不可は JavaScript の進め方・CSV / API は前提として保持（判断にはしない）');
  const r5 = await c.send('全員で');
  assert(r5.ok && r5.intent === 'DRAFT_REPLY' && c.draftDecisions().find(d => d.key === 'lock.scope')?.answer === '全員' && openKeys().join(',') === 'approval.threshold_middle,notify.timing', 'R05-2:「全員で」は決定事項に統合され、同じ範囲（編集不可の対象）は再確認しない');

  // R06
  const r6 = await c.send('おすすめで');
  const mid = c.draftDecisions().find(d => d.key === 'approval.threshold_middle');
  assert(r6.ok && r6.intent === 'DRAFT_REPLY' && r6.reason === 'DELEGATE_WITH_OPEN' && mid && mid.kind === 'delegated' && mid.answer === '不要', `R06-1:「おすすめで」は推奨のある判断を採用（おまかせ）。推奨の無い先に必要な判断が残るので AI に残りだけ聞かせる: ${JSON.stringify(mid)}`);
  assert(calls.propose[6].decisions.some(d => d.key === 'approval.threshold_middle' && d.kind === 'delegated') && openKeys().join(',') === 'notify.timing' && draft().status === 'open', 'R06-2: おまかせの決定事項を AI に渡し、再要求されない（残りは通知のタイミングだけ）');
  const nPropose6 = calls.propose.length, rev6 = draft().rev, nReq6 = reqs().length;

  // R08（質問は従来の QA。仮案の要約を文脈に添える）
  const r8 = await c.send('5営業日にすると何が変わる？');
  assert(r8.ok && r8.intent === 'ASK' && calls.ask.length === 1 && calls.plan.length === 0 && calls.propose.length === nPropose6 && draft().rev === rev6, 'R08-1: 質問は仮案を変えず、計画の作成を始めない（質問の AI へ）');
  const cv = calls.ask[0].conversation;
  assert(cv.plan && /採用前の仮案/.test(cv.plan.summary) && cv.plan.questions.some(q => /部長への通知/.test(q.question)) && cv.plan.provisionals.some(p => p.topic === 'deadline.days') && cv.requirements.length === nReq6, `R08-2: 質問の AI に仮案の要約（動作・前提・残る判断・要件）を添える: ${JSON.stringify(cv.plan).slice(0, 160)}`);
  // 質問の形ではないが AI が相談（question）と読んだ発言: 仮案は変えない（proposalUnchanged）
  const r8b = await c.send('5営業日と7営業日の違いが気になる');
  assert(r8b.ok && r8b.intent === 'DRAFT_REPLY' && r8b.draft && r8b.draft.unchanged === true && draft().rev === rev6 && x.last().data?.kind === 'draft-reply' && /2 営業日早く/.test(x.last().text) && c.messages().filter(m => m.type === 'DRAFT').length === 7, 'R08-3: AI が相談と読んだときは仮案も要件も変えず、返事だけ（新しいカードは出さない）');

  // 相づち
  const ra = await c.send('ありがとう');
  const rb = await c.send('うーん');
  assert(ra.intent === 'GENERAL' && ra.reason === 'DRAFT_SMALLTALK' && rb.reason === 'DRAFT_SMALLTALK' && calls.propose.length === nPropose6 + 1 && draft().rev === rev6 && reqs().length === nReq6 && c.draftDecisions().length === 5, 'R-相づち:「ありがとう」「うーん」は AI を呼ばず、仮案・要件・決定事項を変えない');
  assert(/いつでもどうぞ/.test(x.last().text) && !INTERNAL.test(x.last().text), '相づちへの返事は短い案内だけ');

  // R07
  const r7 = await c.send('通知は不要、期限は5営業日、ほかは採用');
  assert(r7.ok && r7.intent === 'DRAFT_REPLY' && r7.draft && r7.draft.intent === 'adopt' && draft().status === 'adopted' && draft().adoptedBy === 'AI_ADOPT', `R07-1: 1 回の発言で不採用・変更・採用（intent adopt）→ 仮案は adopted: ${JSON.stringify(r7.draft)} / ${draft().status}`);
  const h = draft().history.slice(-1)[0];
  assert(h.applied.rejected.length === 2 && h.applied.modified.length === 1 && h.applied.adopted.length >= 3 && h.applied.dismissed.length === 1, `R07-2: 適用した返事（不採用 2・変更 1・採用 3 以上・不要になった判断 1）: ${JSON.stringify(h.applied)}`);
  assert(draft().rejected.length === 2 && draft().rejected.every(r => /通知/.test(r.text)) && !behaviorTexts().some(s => /通知/.test(s)) && draft().items.decisions.length === 0, 'R07-3: 不採用の項目は仮案から外れ、不採用として残る');
  const revoked = reqs().filter(r => r.decision === 'revoked');
  assert(revoked.length === 2 && revoked.every(r => /通知/.test(`${r.condition}${r.behavior}`)) && reqs().some(r => r.decision !== 'revoked' && /5 営業日/.test(r.behavior)) && !reqs().some(r => r.decision !== 'revoked' && /7 営業日/.test(r.behavior)), `R07-4: 通知の要件は revoke・期限の要件は 5 営業日に更新: ${JSON.stringify(reqs().map(r => [r.id, r.decision, r.behavior]))}`);
  assert(c.draftDecisions().find(d => d.key === 'deadline.days')?.answer === '承認の期限は申請から 5 営業日（土日祝のみ除く）' && c.draftDecisions().find(d => d.key === 'deadline.days').history.length === 1, 'R07-5: key のある前提の変更は、同じ key の決定事項も更新（前の答えは履歴に）');
  assert(x.last().data?.kind === 'draft-adopted' && /この案で進めます/.test(x.last().text) && calls.plan.length === 0, 'R07-6: services.plan が無いときは採用の案内だけ（最終案の作成は段階 C）');
  const t7 = c.metrics().timings.slice(-1)[0];
  assert(t7.intent === 'DRAFT_REPLY' && t7.ackMs != null && t7.firstTextMs === 3000 && t7.doneMs >= 7000, `R07-7: 計測: ${JSON.stringify({ intent: t7.intent, ackMs: t7.ackMs, firstTextMs: t7.firstTextMs, doneMs: t7.doneMs })}`);
  // 以後の台本で再質問が無かったこと（R03 / R05 / R06 の key）
  //   記録済みの決定事項（AI に渡す decisions）の key が、同じ呼び出しの前回の仮案の判断に残っていないこと（Toolkit が回答済みの key を仮案から外す）
  const reasked = calls.propose.flatMap((p, i) => { const done = new Set(p.decisions.map(d => d.key)); return (p.previous ? p.previous.decisions : []).filter(d => done.has(d.key)).map(d => `${i}:${d.key}`); });
  assert(reasked.length === 0 && calls.propose.slice(-1)[0].decisions.map(d => d.key).sort().join(',') === 'approval.threshold,approval.threshold_middle,deadline.days,deadline.holidays,lock.scope', `R03/R05: 回答済みの key は以後の仮案に判断として出ない（決定事項は 5 件を毎回渡す）: ${reasked.join(',')}`);
  // 表示: 内部の番号・key を出さない
  const view = { draft: draft(), draftDecisions: c.draftDecisions(), draftAnswers: new Map() };
  const html = c.messages().filter(m => m.type === 'DRAFT').map(m => KTAiChatUi.messageHtml(m, view)).join('');
  //   内部の番号・key の検査は details の中も含める（services.plan が無い採用は「採用しました（最終案はこのあと作ります）」）
  assert(!INTERNAL.test(html.replace(/data-[a-z]+="[^"]*"/g, '')) && /仮案 — 採用しました（最終案はこのあと作ります）/.test(html) && !/採用して最終案を作っています/.test(html), `表示: 内部の番号・key を出さない（details の中も）・採用した仮案は 1 行に畳む: ${(html.replace(/data-[a-z]+="[^"]*"/g, '').match(INTERNAL) || [])[0]}`);
  // 右ペインの詳細
  const sum = KTAiChatUi.draftSummaryHtml(draft(), { decisions: c.draftDecisions() });
  assert(/必要な判断/.test(sum) && sum.indexOf('必要な判断') < sum.indexOf('実現する動作') && /不採用にした項目/.test(sum) && /進め方/.test(sum) && /判断の経緯/.test(sum) && !INTERNAL.test(sum.replace(/data-[a-z]+="[^"]*"/g, '')), '右の詳細: 必要な判断を先に・不採用・進め方・判断の経緯');
});
// 採用の引き継ぎ（services.plan があるとき: 段階 B では従来の計画の作成へ。goal に採用した方針と決定事項）
await section(async () => {
  const x = makeConv({ withPlan: true });
  const { c, calls } = x;
  await c.send('課長・部長の承認者を選ぶ運用にしたい');
  await c.send('100円未満は部長不要、100万円以上は必要');
  const r = await c.send('採用します');
  assert(r.intent === 'DRAFT_REPLY' && r.reason === 'ADOPT_WITH_OPEN' && calls.plan.length === 0, '採用-1: 先に必要な判断が残る間は「採用します」でも採用にしない（AI に聞き直させる。台本が無いのでここでは失敗）');
  const x2 = makeConv({ withPlan: true });
  await x2.c.send('課長・部長の承認者を選ぶ運用にしたい');
  await x2.c.send('100円未満は部長不要、100万円以上は必要');
  await x2.c.send('7営業日で。会社独自の休業日は今回はなし');
  const r2 = await x2.c.send('おすすめで');
  //   goal は元の依頼文 ＋ 採用した方針 1 行だけ（決定事項・前提・不採用の長文は合成しない。決定事項と要件は構造化して渡す）。計画を作れなかったので仮案は open のまま
  const p0 = x2.calls.plan[0];
  assert(r2.intent === 'ADOPT_DRAFT' && r2.reason === 'DELEGATE' && x2.calls.plan.length === 1 && x2.c.draft().status === 'open' && x2.c.draft().planFailed && p0.goal.startsWith('課長・部長の承認者を選ぶ運用にしたい\n採用した方針:') && !/決定事項:|前提（変えてよい点）|不採用/.test(p0.goal) && p0.goal.length < 600, `採用-2:「おすすめで」で残る判断が無ければ採用 → 計画の依頼（goal は依頼文 ＋ 方針 1 行。失敗したら open のまま）: ${p0.goal.slice(0, 200)}`);
  const t = x2.c.metrics().timings.slice(-1)[0];
  assert(t.intent === 'ADOPT_DRAFT' && t.ackMs != null && t.calls.some(k => k.kind === 'plan'), `採用-3: 計測（ADOPT_DRAFT・calls に plan）: ${JSON.stringify({ intent: t.intent, calls: t.calls.map(k => k.kind) })}`);
  const dec = p0.decisions || [];
  assert(dec.length === 4 && dec.every((d, i) => d.id === `D${i + 1}` && d.source === 'chat' && d.status === 'answered') && dec.find(d => d.key === 'approval.threshold').topic === 'approver' && dec.find(d => d.key === 'deadline.days').topic === 'timing' && dec.find(d => d.key === 'deadline.holidays').topic === 'timing' && dec.find(d => d.key === 'approval.threshold_middle').delegated === true && !/おまかせ/.test(dec.find(d => d.key === 'approval.threshold_middle').answer) && dec.every(d => d.kind === 'question' && d.question), `採用-4: 決定事項は計画の AI に構造化して渡す（id D…・topic は key から・おまかせは別の印）: ${JSON.stringify(dec)}`);
  assert(Array.isArray(p0.requirements) && p0.requirements.length >= 4 && p0.requirements.every(r => /^R[0-9]+$/.test(r.id)) && p0.requirements.some(r => r.decision === 'decided' && /課長と部長の承認者/.test(r.behavior)), `採用-5: 要件の台帳も渡す: ${JSON.stringify(p0.requirements.map(r => [r.id, r.decision]))}`);
});
// 能力が無いときは従来の流れ（仮案の経路に入らない）
await section(async () => {
  const x = makeConv({ features: ['requirements', 'brief'], withPlan: true });
  const r = await x.c.send('課長・部長の承認者を選ぶ運用にしたい');
  assert(x.c.proposalOn() === false && r.intent === 'PLAN' && x.calls.propose.length === 0 && x.calls.plan.length === 1 && x.c.draft() === null, 'B5-1: health に proposal が無ければ従来の計画の経路（services.propose を呼ばない）');
  const y = makeConv({ features: ['requirements', 'brief', 'proposal'], withPlan: true });
  y.services.propose = undefined;
  const ry = await y.c.send('課長・部長の承認者を選ぶ運用にしたい');
  assert(y.c.proposalOn() === false && ry.intent === 'PLAN', 'B5-2: services.propose が無くても従来の経路');
});

// =========================================================
console.log('\n--- §B2. 画面: 偽 client（health に proposal・SSE の部分表示・カードのボタン・回答欄・採用で従来の計画へ） ---');
const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'], conversation: ['requirements', 'brief', 'stream', 'proposal'] }, 'change-planner': { implemented: true, promptVersions: ['1'] }, 'customization-generator': { implemented: true, promptVersions: ['1'] } } }, usage: { monthlyLimit: 20, usedThisMonth: 1 } };
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], customizationId: null, ...o });
const mkStep = (id, actionType, targetKind, targetRef, sp, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' }, ...extra });
const PLAN_META = { requestId: 'pl-1', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm', latencyMs: 30, usage: { input_tokens: 500, output_tokens: 200 } }, usage: { usedThisMonth: 1, monthlyLimit: 20 } };
const PLAN_V1 = (goal) => ({ ok: true, contractVersion: '2.1', meta: PLAN_META, plan: { goal, assessment: { summary: '承認者の一覧を追加します。', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps: [mkStep('P1', 'ADD_VIEW', 'VIEW', '承認待ち一覧', { name: '承認待ち一覧', fields: ['owner', 'case_name'], filterCond: 'owner in (LOGINUSER())', sort: 'due_date asc' }, { title: '一覧「承認待ち一覧」を追加' })], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED' } });
const answerFor = (ctx, text) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'qa-1', usage: { usedThisMonth: 2, monthlyLimit: 20 }, normalization: { warnings: [] } }, answer: text, facts: [], analysis: [], recommendations: [], unknowns: [] });
const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
function mount({ health = HEALTH, proposeGate = null, planImpl = null, generateImpl = null, extra = null } = {}) {
  const storage = makeStorage();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const calls = { ask: [], plan: [], propose: [] };
  const clock = { t: 1000000 };
  const mx = { planImpl };   // 計画の client の差し替え（失敗・途中で止める。null なら PLAN_V1 を返す）
  const client = {
    async getHealth() { return health; },
    async ask({ ctx, requestId }) { calls.ask.push({ ctx }); const v = KTAiClient.validateAnswer(answerFor(ctx, '答えです。'), ctx); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
    async plan({ ctx, requestId }) { calls.plan.push({ ctx }); clock.t += 30000; if (mx.planImpl) return mx.planImpl({ ctx, requestId }); const v = KTAiClient.validatePlan(PLAN_V1(ctx.goal), ctx); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
    async propose({ ctx, requestId, onText = null }) {
      calls.propose.push({ ctx, stream: typeof onText === 'function' });
      const raw = script({ utterance: ctx.question, previous: ctx.conversation.proposal, requirements: ctx.conversation.requirements });
      if (!raw) throw new Error(`台本がありません: ${ctx.question}`);
      // SSE を模擬: 最初の文字 → （止める）→ 全文
      clock.t += 2500; if (onText) onText(raw.reply.slice(0, 10));
      if (proposeGate) await proposeGate.p;
      clock.t += 4500; if (onText) onText(raw.reply);
      return normalized(raw, requestId);
    },
    async generate(a) { if (generateImpl) return generateImpl(a); throw new Error('not used'); },
  };
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner,customization-generator', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const mock = makeKintoneMock(INPUTS.data, { jsSources: [] });
  const panel = mountAiWorkspace(host, { getInputs: () => INPUTS, copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow, executor: { api: mock.api, appId: '341' }, now: () => clock.t, clock: () => clock.t, ...(extra || {}) });
  const $ = (id) => host.querySelector(`#${id}`);
  return Object.assign(mx, { host, panel, $, calls, clock, mock, conv: () => panel.conversation(), chat: () => $('kt-ai-chat').innerHTML, msgs: () => panel.conversation().state.messages });
}
const clickChat = (m, act, extra = {}) => m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act, ...extra } } });
await section(async () => {
  const g = gate();
  const m = mount({ proposeGate: g });
  await ticks();
  const p = m.panel.send('課長・部長の承認者を選ぶ運用にしたい');
  await ticks(8);
  const during = m.chat();
  assert(m.calls.propose.length === 1 && m.calls.propose[0].stream === true && /kt-ai-streaming/.test(during) && /課長と部長を申請/.test(during) && !/kt-ai-draft-card/.test(during) && !/kt-ai-plan-card/.test(during), `B2-1: 仮案の AI の reply は SSE で部分表示（仮案のカード・変更案はまだ出ない）: ${during.slice(0, 200)}`);
  assert(/data-status="drafting">仮案を作成中</.test(m.$('kt-ai-ws-state').innerHTML) && m.conv().state.working === 'PROPOSE', `B2-1b: 右の見出しは「仮案を作成中」（応答待ちの間）: ${m.$('kt-ai-ws-state').innerHTML}`);
  // 応答待ちの間の発言: 質問は並べて答える（入力欄は空に）、それ以外は入力欄に残す（案内）
  m.$('kt-ai-input').value = 'CSVにも効きますか？';
  const rq1 = await m.panel.send('CSVにも効きますか？', { source: 'composer' });
  await ticks(4);
  assert(rq1 && rq1.asked === true && m.calls.ask.length === 1 && m.$('kt-ai-input').value === '' && m.calls.propose.length === 1, `B2-1c: 仮案の応答待ちの質問は並べて答える（入力欄は空に）: ${JSON.stringify(rq1)}`);
  m.$('kt-ai-input').value = '通知は不要';
  const rq2 = await m.panel.send('通知は不要', { source: 'composer' });
  assert(rq2 === null && m.$('kt-ai-input').value === '通知は不要' && /仮案を作っています。この文は仮案ができてから/.test(m.$('kt-ai-composer-note') ? m.$('kt-ai-composer-note').textContent : m.host.innerHTML), 'B2-1d: 仮案の応答待ちの返事・指示は入力欄に残し、案内を出す');
  g.open(); await p; await ticks(8);
  const ctx0 = m.calls.propose[0].ctx;
  assert(ctx0.conversation.mode === 'proposal' && ctx0.question === '課長・部長の承認者を選ぶ運用にしたい' && ctx0.conversation.proposal === null && Array.isArray(ctx0.facts) && ctx0.facts[0].id === 'E1' && ctx0.size.chars <= 12000 && !ctx0.planContext && ctx0.conversation.brief === undefined, `B2-2: 送った Context は KTContext.buildProposal（mode proposal・絞った facts）: ${ctx0.size.chars} 字`);
  const chat = m.chat();
  const card = (chat.match(/<div class="kt-ai-card kt-ai-draft-card[\s\S]*?まだ何も反映していません[\s\S]*?<\/div>/) || [''])[0];
  assert(/仮案ができました。/.test(chat) && /実現する動作/.test(chat) && /判断が必要な点/.test(chat) && /先に決めたいこと/.test(chat) && /おすすめ：一定金額以上のときだけ/.test(chat) && /こちらの提案で進める点が 2 件あります/.test(chat), 'B2-3: 仮案のカード: 結論 → 実現する動作 → 判断が必要な点（おすすめ）→ 前提');
  assert(/data-act="draft-adopt"[^>]*>採用</.test(chat) && /data-act="draft-partial"[^>]*>一部採用</.test(chat) && /data-act="draft-reject"[^>]*>不採用</.test(chat) && /data-act="draft-answer"[^>]*>回答を送る</.test(chat) && /class="kt-ai-qa-input kt-ai-draft-input" data-dkey="/.test(chat), 'B2-4: 入力の補助ボタン［採用］［一部採用］［不採用］と回答欄（カードの中）');
  //   仮案のカードは details の中（前提・判断の経緯）も含めて検査する（質問の答えのカードの「詳細情報」の requestId は従来の監査用の表示なので、会話全体は details の外で見る）
  const draftHtmlAll = m.msgs().filter(x => x.type === 'DRAFT').map(x => KTAiChatUi.messageHtml(x, { draft: m.conv().draft(), draftDecisions: m.conv().draftDecisions(), draftAnswers: new Map() })).join('').replace(/data-[a-z]+="[^"]*"/g, '');
  assert(!INTERNAL.test(outsideDetails(chat).replace(/data-[a-z]+="[^"]*"/g, '')) && !INTERNAL.test(draftHtmlAll) && /<details/.test(draftHtmlAll) && !/kt-ai-plan-card/.test(chat) && !/kt-ai-questions-card/.test(chat) && !/kt-ai-streaming/.test(chat), `B2-5: 会話に内部の番号・key を出さない（仮案のカードは details の中も）。確認事項のカード・変更案のカードは出ない: ${(draftHtmlAll.match(INTERNAL) || outsideDetails(chat).replace(/data-[a-z]+="[^"]*"/g, '').match(INTERNAL) || [])[0]}`);
  const sum = m.$('kt-ai-change-summary').innerHTML;
  assert(/必要な判断（1 件）/.test(sum) && /先に必要/.test(sum) && /実現する動作/.test(sum) && /こちらの提案で進める点/.test(sum) && /進め方/.test(sum) && m.$('kt-ai-pane-plan-empty').style.display === 'none', `B2-6: 右「変更内容」に仮案の詳細（必要な判断を先に）: ${sum.slice(0, 160)}`);
  assert(/data-status="draft">仮案</.test(m.$('kt-ai-ws-state').innerHTML), `B2-7: 右の見出しの状態: 仮案: ${m.$('kt-ai-ws-state').innerHTML}`);
  const t1 = m.panel.metrics().timings.slice(-1)[0];
  assert(t1.intent === 'PROPOSE' && t1.firstTextMs === 2500 && t1.doneMs === 7000 && t1.ai && t1.ai.model === 'm' && t1.perf && t1.perf.requestMs === 7000, `B2-8: 計測（画面の時計）: ${JSON.stringify({ intent: t1.intent, firstTextMs: t1.firstTextMs, doneMs: t1.doneMs, perf: t1.perf })}`);
  // ［一部採用］は入力欄に案内を出すだけ
  await clickChat(m, 'draft-partial', { draft: m.conv().draft().id });
  assert(/変えたい点を書いてください/.test(m.$('kt-ai-input').placeholder) && m.calls.propose.length === 1, 'B2-9:［一部採用］は入力欄の案内だけ（送らない）');
  // 回答欄 → 決定事項に記録してから AI へ
  const d1 = m.conv().draft();
  const q = d1.items.decisions[0];
  await m.$('kt-ai-chat').dispatch({ type: 'input', target: { dataset: { dkey: `${d1.id}:${q.key}`, draft: d1.id, did: q.id }, value: '100円未満は部長不要、100万円以上は必要' } });
  await clickChat(m, 'draft-answer', { draft: d1.id });
  await ticks(10);
  const ctx1 = m.calls.propose[1].ctx;
  const userMsgs = m.msgs().filter(x => x.type === 'USER');
  assert(m.calls.propose.length === 2 && ctx1.conversation.decisions.some(x => x.key === 'approval.threshold' && x.answer === '100円未満は部長不要、100万円以上は必要') && /100円未満は部長不要/.test(ctx1.question) && ctx1.conversation.proposal.behaviors.length === 2 && ctx1.conversation.proposal.decisions.length === 0, 'B2-10: 回答欄の回答は決定事項（key 付き）に記録してから、「回答: …」を含む発言として仮案の AI へ（回答済みの判断は前回の仮案から外す）');
  assert(userMsgs.slice(-1)[0].data?.displayText === '判断が必要な点への回答です。' && /判断が必要な点への回答です。/.test(m.chat()) && !/100円以上100万円未満の申請に部長承認は必要ですか[\s\S]*100円以上100万円未満の申請に部長承認は必要ですか[\s\S]*100円以上100万円未満/.test(outsideDetails(m.chat())), 'B2-11: 吹き出しは「判断が必要な点への回答です。」だけ');
  assert(m.conv().draft().rev === 2 && /仮案を直しました。/.test(m.chat()) && (m.chat().match(/kt-ai-draft-card is-old/g) || []).length === 1 && /前の仮案 — このあと直した案があります/.test(m.chat()) && /決めたこと：/.test(m.chat()), 'B2-12: 仮案のカードは置き換え（前の仮案は 1 行に畳む）。決めたことを示す');
  // ［採用］: 先に必要な判断（中間の金額）が残る → AI に聞き直させる（台本が無いので失敗の表示。採用にはならない）
  // → 残りの判断に答えてから採用
  await m.panel.send('7営業日で。会社独自の休業日は今回はなし'); await ticks(8);
  await m.panel.send('おすすめで'); await ticks(12);
  const dAfter = m.conv().draft();
  assert(dAfter.status === 'adopted' && m.calls.plan.length === 1 && m.calls.propose.length === 3 && m.conv().activePlan() && m.conv().activePlan().fromDraft && m.conv().activePlan().fromDraft.id === dAfter.id, `B2-13:「おすすめで」で残る判断が無ければ採用 → 従来の計画の作成へ（版に fromDraft）: ${dAfter.status} / plan ${m.calls.plan.length}`);
  assert(/採用した方針:/.test(m.calls.plan[0].ctx.goal) && m.conv().requirements().some(r => /課長と部長の承認者/.test(r.behavior)) && m.conv().requirements().length >= 4, 'B2-14: 要件の台帳は仮案の id から計画の planId へ引き継ぐ。goal に採用した方針');
  const chat2 = m.chat();
    // 段階 C: 採用 → 計画 → 最終案のカード（変更案のカード・確認事項・仕様の案内は出さない）
  assert(/仮案 — 採用して最終案を作りました/.test(chat2) && !/採用して最終案を作っています/.test(chat2) && /kt-ai-final-card/.test(chat2) && !/kt-ai-plan-card/.test(chat2) && !/data-act="draft-adopt"/.test(chat2) && /この案で進めます/.test(chat2) && dAfter.planId === m.conv().activePlan().planId, 'B2-15: 採用した仮案は 1 行に畳み（「採用して最終案を作りました」）、最終案のカードが出る（変更案のカードは出ない・仮案のボタンは消える）');
  //   採用した仮案からの計画の Context: 要件の台帳は渡る。合成した依頼文は台帳の利用者の原文に入らない（未解決の要件も出ない）
  const lgP = m.conv().state.ledgers.get(m.conv().activePlan().planId);
  assert(Array.isArray(m.calls.plan[0].ctx.requirements) && m.calls.plan[0].ctx.requirements.length >= 4 && !(lgP.userTexts || []).some(s => /採用した方針/.test(s)) && !m.msgs().some(x => x.data?.kind === 'requirements-unresolved'), `B2-14b: 要件は Context に渡り、合成文は台帳に入らない: ${JSON.stringify(lgP.userTexts)}`);
  assert(/<h3>/.test(m.$('kt-ai-change-summary').innerHTML) && !/仮案（採用前）/.test(m.$('kt-ai-change-summary').innerHTML) && /data-status="ready">未反映</.test(m.$('kt-ai-ws-state').innerHTML), 'B2-16: 右は従来の変更内容の要約に戻る・状態は未反映');
  const tA = m.panel.metrics().timings.slice(-1)[0];
  assert(tA.intent === 'ADOPT_DRAFT' && tA.calls.map(c => c.kind).join(',') === 'plan' && tA.doneMs >= 30000, `B2-17: 採用の計測（calls に plan・doneMs）: ${JSON.stringify({ intent: tA.intent, calls: tA.calls.map(c => c.kind), doneMs: tA.doneMs })}`);
  // 計画ができた後は従来どおり（仮案の経路に入らない）
  const r = await m.panel.send('一覧の名前は承認待ちにして'); await ticks(8);
  assert(r && r.intent === 'REVISE_PLAN' && m.calls.propose.length === 3, 'B2-18: 計画がある（最終案の後）は従来の修正の経路');
});
// ［採用］［不採用］のボタンの文・新しい会話で仮案が消える
await section(async () => {
  const m = mount();
  await ticks();
  await m.panel.send('課長・部長の承認者を選ぶ運用にしたい'); await ticks(8);
  await clickChat(m, 'draft-adopt', { draft: m.conv().draft().id }); await ticks(8);
  const u = m.msgs().filter(x => x.type === 'USER').slice(-1)[0];
  assert(u.text === '採用します' && m.conv().draft().status === 'open' && m.calls.plan.length === 0, 'B2-19:［採用］は「採用します」を送る。先に必要な判断が残る間は採用にならない（AI に聞き直させる）');
  await clickChat(m, 'draft-reject', { draft: m.conv().draft().id }); await ticks(8);
  const u2 = m.msgs().filter(x => x.type === 'USER').slice(-1)[0];
  assert(u2.text === 'この案は採用しません' && m.conv().draft().status === 'open', 'B2-20:［不採用］は「この案は採用しません」を送る（AI が別の方向を聞き返す経路）');
  await clickChat(m, 'new-conv'); await ticks();
  assert(m.conv().draft() === null && m.conv().draftDecisions().length === 0 && m.$('kt-ai-change-summary').innerHTML === '' && /未作成/.test(m.$('kt-ai-ws-state').innerHTML), 'B2-21:［新しい会話］で仮案・決定事項・右の詳細は消える');
});
// 能力が無い health では従来の流れ（画面）
await section(async () => {
  const h = clone(HEALTH); h.registry.toolkit['assistant-qa'].conversation = ['requirements', 'brief', 'stream'];
  const m = mount({ health: h });
  await ticks();
  await m.panel.send('課長・部長の承認者を選ぶ運用にしたい'); await ticks(10);
  assert(m.calls.propose.length === 0 && m.calls.plan.length === 1 && m.conv().draft() === null && /kt-ai-plan-card/.test(m.chat()) && !/kt-ai-draft-card/.test(m.chat()), 'B5-3: health に proposal が無い画面は従来の計画の流れ（仮案のカードは出ない）');
});

// =========================================================
console.log('\n--- §B3. 独立レビューの指摘（2026-10-07）: 採用 → 計画の失敗 / 構造化した引き継ぎ / 不採用の取り消し / 再確認 / 新しい依頼 / 分類 / 応答待ち ---');
// 1. 採用 → 計画の作成の失敗で行き止まりにならない（open に戻る・履歴・［再試行］は「採用します」で仮案から作り直す・古い決定事項は新しい仮案に引き継がない）
await section(async () => {
  const x = makeConv({ planImpl: planFail });
  const { c, calls } = x;
  await c.send('課長・部長の承認者を選ぶ運用にしたい');
  await c.send('100円未満は部長不要、100万円以上は必要');
  await c.send('7営業日で。会社独自の休業日は今回はなし');
  const r = await c.send('おすすめで');
  const d = c.draft();
  const err = c.messages().filter(m => m.type === 'ERROR').slice(-1)[0];
  assert(r.intent === 'ADOPT_DRAFT' && r.ok === false && d.status === 'open' && d.planning === false && d.planFailed && d.planFailed.attempt === 1 && d.history.slice(-1)[0].kind === 'plan-failed' && !c.activePlan(), `B3-1: 計画を作れなかったら仮案は open に戻り、履歴に失敗を残す: ${d.status} / ${JSON.stringify(d.planFailed)}`);
  assert(err && err.data.retryText === '採用します' && err.data.intent === 'ADOPT_DRAFT' && /計画を作れませんでした（テスト）/.test(err.text), `B3-2: 失敗のカードの［再試行］は「採用します」（ADOPT_DRAFT）: ${JSON.stringify(err && err.data)}`);
  const view = { draft: d, draftDecisions: c.draftDecisions(), draftAnswers: new Map() };
  const cardHtml = KTAiChatUi.messageHtml(c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], view);
  assert(/仮案 — 採用（変更案の作成に失敗。再試行できます）/.test(cardHtml) && /data-act="draft-adopt"/.test(cardHtml) && !/kt-ai-old-card/.test(cardHtml), 'B3-3: 失敗した後の仮案のカードは開いたまま（もう一度採用できる）で、失敗したことを見出しに出す');
  const sumHtml = KTAiChatUi.draftSummaryHtml(d, { decisions: c.draftDecisions(), working: null });
  assert(/採用（変更案の作成に失敗。再試行できます）/.test(sumHtml) && !/最終案を作っています/.test(sumHtml) && /採用 → 変更案の作成に失敗/.test(sumHtml), 'B3-4: 右の詳細は失敗の文（「最終案を作っています」は出さない）。判断の経緯に失敗を残す');
  // ［再試行］（UI の handleAct 'retry' と同じ経路）: 仮案から作り直す（利用者の発言「おすすめで」を依頼文にしない）
  const rr = await c.send(err.data.retryText, { intentOverride: err.data.intent });
  assert(rr.intent === 'ADOPT_DRAFT' && calls.plan.length === 2 && calls.plan[1].goal === calls.plan[0].goal && calls.plan[1].goal.startsWith('課長・部長の承認者を選ぶ運用にしたい') && calls.plan[1].decisions.length === 4 && c.draft().planFailed.attempt === 2, `B3-5: ［再試行］は仮案（draftGoal ＋ 決定事項・要件）から作り直す: ${calls.plan[1].goal.slice(0, 60)}`);
  // もう一度「採用します」と言っても同じ（質問の AI に流れない）
  const ra = await c.send('採用します');
  assert(ra.intent === 'ADOPT_DRAFT' && ra.reason === 'ADOPT_WORDS' && calls.plan.length === 3 && calls.ask.length === 0, `B3-6: 失敗の後の「採用します」は採用（質問の AI に流れない）: ${ra.intent}/${ra.reason}`);
  // 計画の AI が直ったら: 採用 → adopted（計画が登録できた後）・畳んだカードの文・台帳に合成文が入らない・未解決の要件が出ない
  x.planImpl = planOk;
  const ok = await c.send('採用します');
  const d2 = c.draft(), v = c.activePlan();
  assert(ok.ok && d2.status === 'adopted' && d2.planId === v.planId && !d2.planFailed && v.fromDraft && v.fromDraft.id === d2.id && c.messages().some(m => m.type === 'FINAL') && !c.messages().some(m => m.type === 'PLAN'), `B3-7: 計画ができたら仮案は adopted（計画の登録の後）。段階 C: 会話には最終案のカード（変更案のカードは出さない）: ${d2.status}`);
  const lgP = c.state.ledgers.get(v.planId);
  assert(!(lgP.userTexts || []).some(s => /採用した方針|決定事項:/.test(s)) && !c.messages().some(m => m.data?.kind === 'requirements-unresolved') && c.requirements().every(r => r.decision !== 'undecided') && calls.plan[3].requirements.some(r => /課長と部長の承認者/.test(r.behavior)), `B3-8: 合成した依頼文は台帳の利用者の原文に入らず、未解決の要件も作らない: ${JSON.stringify(lgP.userTexts)}`);
  const cardDone = KTAiChatUi.messageHtml(c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], { draft: d2, draftDecisions: c.draftDecisions() });
  assert(/仮案 — 採用して最終案を作りました/.test(cardDone) && /kt-ai-old-card/.test(cardDone), 'B3-9: 最終案ができた後の仮案のカードは「仮案 — 採用して最終案を作りました」に畳む');
  const t = c.metrics().timings.slice(-1)[0];
  assert(t.intent === 'ADOPT_DRAFT' && t.calls.map(k => k.kind).join(',') === 'plan', 'B3-10: 計測は従来どおり（calls に plan）');
});
// 1b. 計画の AI の例外（タイムアウト）でも同じ（open に戻る・再試行は ADOPT_DRAFT）。AI の intent adopt の経路（DRAFT_REPLY）でも
await section(async () => {
  const x = makeConv({ planImpl: planThrow });
  const { c, calls } = x;
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし', '現在の承認者へ。課長承認中で100万円以上なら部長にも通知', '申請中は編集不可にして。CSV・APIは使わない', '全員で', 'おすすめで']) await c.send(s);
  const r7 = await c.send('通知は不要、期限は5営業日、ほかは採用');
  const d = c.draft();
  const err = c.messages().filter(m => m.type === 'ERROR').slice(-1)[0];
  assert(r7.intent === 'DRAFT_REPLY' && r7.ok === false && r7.error && r7.error.code === 'TIMEOUT' && d.status === 'open' && d.planFailed && calls.plan.length === 1, `B3-11: AI の intent adopt → 計画の例外でも仮案は open に戻る: ${d.status} / ${JSON.stringify(r7.error)}`);
  assert(err.data.retryText === '採用します' && err.data.intent === 'ADOPT_DRAFT' && err.data.retryable === true, `B3-12: 例外の失敗カードの［再試行］も「採用します」（ADOPT_DRAFT）: ${JSON.stringify(err.data)}`);
  const rr = await c.send(err.data.retryText, { intentOverride: err.data.intent });
  assert(rr.intent === 'ADOPT_DRAFT' && calls.plan.length === 2 && calls.plan[1].goal === calls.plan[0].goal && calls.plan[1].requirements.some(r => r.decision === 'revoked') && calls.plan[1].decisions.length === 5, `B3-13: ［再試行］は仮案から作り直す（取り消し済みの要件も渡す）: ${JSON.stringify(calls.plan[1].requirements.map(r => [r.id, r.decision]))}`);
});
// 1c. AI の intent adopt の経路でも、計画を作っている間は working PLAN（右の見出し「最終案を作成中」。右の詳細の「最終案を作っています」はその間だけ）
await section(async () => {
  const g = gateMk();
  const x = makeConv({ planImpl: async () => { await g.p; return planFail(); } });
  const { c } = x;
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし', '現在の承認者へ。課長承認中で100万円以上なら部長にも通知', '申請中は編集不可にして。CSV・APIは使わない', '全員で', 'おすすめで']) await c.send(s);
  const p = c.send('通知は不要、期限は5営業日、ほかは採用');
  await ticks(8);
  const d = c.draft();
  const ws = VM.workStatus({ version: null, working: c.state.working, draft: d });
  const cardMid = KTAiChatUi.messageHtml(c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], { draft: d, draftDecisions: c.draftDecisions() });
  assert(c.isBusy() && c.state.working === 'PLAN' && d.planning === true && d.status === 'open' && ws.key === 'finalizing' && ws.label === '最終案を作成中', `B3-14: AI の intent adopt で計画を作っている間は working PLAN・右の見出し「最終案を作成中」: ${c.state.working} / ${JSON.stringify(ws)}`);
  assert(/仮案 — 採用して最終案を作っています/.test(cardMid) && !/data-act="draft-adopt"/.test(cardMid) && /最終案を作っています/.test(KTAiChatUi.draftSummaryHtml(d, { decisions: c.draftDecisions(), working: 'PLAN' })) && !/最終案を作っています/.test(KTAiChatUi.draftSummaryHtml(d, { decisions: c.draftDecisions(), working: null })), 'B3-15: 作っている間はカードを畳み、右の詳細の「最終案を作っています」は working PLAN のときだけ');
  const rq = await c.send('一覧の名前は承認待ちにして');
  assert(rq && rq.queued === true && rq.reason === 'QUEUED_DURING_PLAN', 'B3-16: 作っている間の指示は従来どおり積む');
  g.open(); await p; await ticks(4);
  assert(c.state.working === null && c.draft().status === 'open' && c.draft().planFailed && VM.workStatus({ version: null, working: null, draft: c.draft() }).key === 'draft', 'B3-17: 失敗の後は working null・見出しは「仮案」に戻る');
});
// 2. 計画ができたときの引き継ぎ: 合成文を台帳に入れない（S5 の再現）・requirements と decisions が渡る
await section(async () => {
  const x = makeConv({ planImpl: planOk });
  const { c, calls } = x;
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし', '現在の承認者へ。課長承認中で100万円以上なら部長にも通知', '申請中は編集不可にして。CSV・APIは使わない', '全員で', 'おすすめで']) await c.send(s);
  const before = c.requirements().map(r => r.id);
  const r7 = await c.send('通知は不要、期限は5営業日、ほかは採用');
  const v = c.activePlan(), d = c.draft();
  const p0 = calls.plan[0];
  assert(r7.ok && v && d.status === 'adopted' && d.adoptedBy === 'AI_ADOPT' && d.planId === v.planId, `B3-18: 1 文で不採用・変更・採用 → 計画 → adopted: ${d.status}/${d.adoptedBy}`);
  assert(p0.goal.split('\n').length === 2 && p0.goal.startsWith('課長・部長の承認者を選ぶ運用にしたい') && /^採用した方針: /.test(p0.goal.split('\n')[1]) && !/通知/.test(p0.goal.split('\n')[1]) && !/決定事項|前提|不採用/.test(p0.goal), `B3-19: goal は依頼文 ＋ 採用した方針 1 行（不採用の通知は入らない）: ${p0.goal}`);
  assert(p0.decisions.length === 5 && p0.decisions.find(x => x.key === 'deadline.days').answer === '承認の期限は申請から 5 営業日（土日祝のみ除く）' && p0.decisions.find(x => x.key === 'lock.scope').answer === '全員' && p0.requirements.filter(r => r.decision === 'revoked').length === 2 && p0.requirements.some(r => r.decision !== 'revoked' && /5 営業日/.test(r.behavior)), `B3-20: 決定事項（5 件・最新の答え）と要件（取り消し 2 件を含む）を渡す: ${JSON.stringify(p0.decisions.map(x => [x.key, x.answer]))}`);
  const lgP = c.state.ledgers.get(v.planId);
  assert(c.requirements().map(r => r.id).join() === before.join() && !c.requirements().some(r => r.decision === 'undecided') && !(lgP.userTexts || []).some(s => /採用した方針/.test(s)) && !c.messages().some(m => m.data?.kind === 'requirements-unresolved'), `B3-21: 計画のターンで要件が増えない（合成文を未解決の要件にしない）・台帳の原文に合成文が無い: ${JSON.stringify(lgP.userTexts)}`);
});
// 4. 不採用の要件の取り消しは仮案の項目 id → 要件 id の対応で（id で引けないときだけ内容の文字の重なりで補う。短い動作の包含では取り消さない）
await section(async () => {
  const scriptRj = ({ utterance: u, previous: p }) => {
    const prevB = (p && p.behaviors) || [];
    if (/承認者を選ぶ/.test(u)) return { reply: '仮案です。', intent: 'propose', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user'), B('承認依頼のとき部長に通知する'), B('期限超過のとき申請者へ催促する')], assumptions: [], decisions: [], approach: { standard: ['プロセス管理'], js: [] }, cannot: [] },
      turn: { ops: [], answers: [], requirementOps: [
        req('add', { target: '承認', condition: '申請時', behavior: '承認者を選ぶ', sourceQuotes: ['承認者を選ぶ'], planRefs: ['B1'] }),
        req('add', { target: '通知', condition: '承認依頼のとき', behavior: '通知する', decision: 'proposed', planRefs: ['B2'] }),
        req('add', { target: '催促', condition: '期限超過のとき', behavior: '申請者へ催促する', decision: 'proposed' }),
        req('add', { target: '催促', condition: '', behavior: '催促する', decision: 'proposed' }),
      ] } };
    if (/文言を変えて/.test(u)) return { reply: '文言を変えました。', intent: 'update', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user'), B('承認依頼のとき部長に通知する'), B('期限超過のとき申請者へ催促する')], assumptions: [A('notify.text', '通知の文言', '通知の文言は「承認をお願いします」', '変えられます')], decisions: [], approach: { standard: ['プロセス管理'], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } };
    if (/通知も催促も不要/.test(u)) return { reply: '通知と催促を外して採用します。', intent: 'adopt', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [], decisions: [], approach: { standard: ['プロセス管理'], js: [] }, cannot: [] },
      turn: { ops: [...prevB.filter(b => /通知|催促/.test(b.text)).map(b => ({ id: b.id, op: 'reject', text: '', quote: '通知も催促も不要' })), ...prevB.filter(b => !/通知|催促/.test(b.text)).map(b => ({ id: b.id, op: 'adopt', text: '', quote: 'ほかは採用' }))], answers: [], requirementOps: [] } };
    return null;
  };
  const x = makeConv({ scriptFn: scriptRj });
  const { c } = x;
  await c.send('課長・部長の承認者を選ぶ運用にしたい');
  const lg = x.ledger(c.draft().id);
  assert(JSON.stringify(lg.itemReqs) === JSON.stringify({ B1: ['R1'], B2: ['R2'] }), `B3-22: 要件の add の planRefs から「仮案の項目 id → 要件 id」の対応を台帳に持つ: ${JSON.stringify(lg.itemReqs)}`);
  await c.send('通知の文言を変えて');   // 項目の id は振り直されるが、同じ文の項目に対応を引き継ぐ
  assert(c.draft().rev === 2 && JSON.stringify(lg.itemReqs) === JSON.stringify({ B1: ['R1'], B2: ['R2'] }), `B3-23: 仮案を直しても（id の振り直し）同じ文の項目に対応を引き継ぐ: ${JSON.stringify(lg.itemReqs)}`);
  const r = await c.send('通知も催促も不要、ほかは採用');
  const reqs = c.requirements();
  const byId = (id) => reqs.find(e => e.id === id);
  assert(r.ok && byId('R1').decision === 'decided' && byId('R2').decision === 'revoked' && byId('R3').decision === 'revoked' && byId('R4').decision !== 'revoked', `B3-24: 不採用 → id の対応で R2 を取り消し、対応の無い R3 は内容の文字の重なり（7 割）で取り消し、短い動作だけの R4（「催促する」）は取り消さない: ${JSON.stringify(reqs.map(e => [e.id, e.decision]))}`);
  const raw = KTAiAnswers.requirementsOf(lg);
  assert(raw.find(e => e.id === 'R2').revokedBy.by === 'id' && raw.find(e => e.id === 'R3').revokedBy.by === 'overlap', `B3-25: 取り消しの根拠（id / overlap）を要件に残す: ${JSON.stringify(raw.map(e => [e.id, e.revokedBy && e.revokedBy.by]))}`);
});
// 6. 回答済みの key の判断を AI がもう一度出したら「再確認」（前の答えを添える。答えると同じ key を置き換える）。同じターンで答えたばかりの key は出さない
await section(async () => {
  const QD = Q('deadline.days', '承認の期限', '承認の期限は申請から何営業日にしますか', ['5営業日', '7営業日'], '5営業日', '期限超過の判定日が変わります', false);
  const scriptRc = ({ utterance: u, previous: p }) => {
    const prevD = (p && p.decisions) || [];
    if (/承認者を選ぶ/.test(u)) return { reply: '仮案です。', intent: 'propose', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [], decisions: [QD], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } };
    // 回答 → 決定事項に。AI が同じターンに同じ key の判断をまだ出している（読み落とし）→ 出さない
    if (/^7営業日/.test(u)) return { reply: '7 営業日で進めます。', intent: 'update', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [], decisions: [QD], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [{ id: idBy(prevD, d => d.key === 'deadline.days'), kind: 'value', text: '7営業日', quote: '7営業日' }], requirementOps: [] } };
    // 後のターンで AI が理由をつけて同じ key を出した → 再確認
    if (/起算日/.test(u)) return { reply: '起算日を翌営業日にすると期限が 1 日延びます。日数を確認させてください。', intent: 'update', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [A('deadline.base', '起算日', '期限は申請日の翌営業日から数える', '')], decisions: [{ ...QD, question: '起算日を翌営業日にしても、期限は 7 営業日のままでよいですか' }], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } };
    if (/^5営業日/.test(u)) return { reply: '5 営業日にします。', intent: 'update', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [A('deadline.base', '起算日', '期限は申請日の翌営業日から数える', ''), A('deadline.days', '期限', '期限は 5 営業日', '')], decisions: [], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [{ id: idBy(prevD, d => d.key === 'deadline.days'), kind: 'value', text: '5営業日', quote: '5営業日' }], requirementOps: [] } };
    return null;
  };
  const x = makeConv({ scriptFn: scriptRc });
  const { c, calls } = x;
  await c.send('課長・部長の承認者を選ぶ運用にしたい');
  await c.send('7営業日で');
  assert(c.draftDecisions().find(d => d.key === 'deadline.days').answer === '7営業日' && c.draft().items.decisions.length === 0 && c.draft().history.slice(-1)[0].hiddenDecisions.join() === 'deadline.days', 'B3-26: 同じターンで答えたばかりの key を AI がまだ出していたら出さない（hidden）');
  await c.send('起算日は翌営業日にして');
  const d = c.draft();
  const rc = d.items.decisions[0];
  const open = KTAiConversation.openDraftDecisions(d, c.draftDecisions());
  assert(d.items.decisions.length === 1 && rc.reconfirm === true && rc.previousAnswer === '7営業日' && open.length === 1 && open[0].key === 'deadline.days' && c.draftDecisions().length === 1, `B3-27: 後のターンで回答済みの key をもう一度出したら「再確認」として残す（決定事項は置き換えない）: ${JSON.stringify(rc)}`);
  const cardHtml = KTAiChatUi.messageHtml(c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], { draft: d, draftDecisions: c.draftDecisions(), draftAnswers: new Map() });
  assert(/再確認：前の答えは「7営業日」です/.test(cardHtml) && /data-dkey="/.test(cardHtml) && /再確認：前の答えは「7営業日」/.test(KTAiChatUi.draftSummaryHtml(d, { decisions: c.draftDecisions() })), 'B3-28: カードと右の詳細に「再確認」と前の答えを出す（回答欄あり。hidden で隠さない）');
  await c.send('5営業日にします');
  const prevSent = calls.propose[3].previous;
  const dd = c.draftDecisions().find(x => x.key === 'deadline.days');
  assert(prevSent.decisions.length === 1 && prevSent.decisions[0].key === 'deadline.days' && dd.answer === '5営業日' && dd.history.length === 1 && dd.history[0].answer === '7営業日' && KTAiConversation.openDraftDecisions(c.draft(), c.draftDecisions()).length === 0 && c.draftDecisions().length === 1, `B3-29: 再確認の判断は previous に残して AI へ渡し、答えたら同じ key を置き換える（前の答えは履歴に）: ${JSON.stringify(dd)}`);
});
// 7. 前回の仮案があるのに intent が propose なら新しい仮案（前の仮案は superseded。決定事項は引き継がない。前のカードは「前の仮案（別の依頼）」）
await section(async () => {
  const scriptNew = ({ utterance: u, previous: p }) => {
    const prevD = (p && p.decisions) || [];
    if (/承認者を選ぶ/.test(u)) return { reply: '仮案です。', intent: 'propose', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [], decisions: [Q_DAYS], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [req('add', { target: '承認', condition: '申請時', behavior: '承認者を選ぶ', sourceQuotes: ['承認者を選ぶ'], planRefs: ['B1'] })] } };
    if (/^7営業日/.test(u)) return { reply: '7 営業日で進めます。', intent: 'update', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [A('deadline.days', '期限', '期限は 7 営業日', '')], decisions: [], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [{ id: idBy(prevD, d => d.key === 'deadline.days'), kind: 'value', text: '7営業日', quote: '7営業日' }], requirementOps: [] } };
    if (/一覧も/.test(u)) return { reply: '一覧の仮案です。', intent: 'propose', proposal: { behaviors: [B('承認待ち一覧を追加する', 'user')], assumptions: [], decisions: [Q_DAYS], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [req('add', { target: '一覧', condition: '', behavior: '承認待ち一覧を追加する', sourceQuotes: ['一覧も作りたい'], planRefs: ['B1'] })] } };
    return null;
  };
  const x = makeConv({ scriptFn: scriptNew });
  const { c, calls } = x;
  await c.send('課長・部長の承認者を選ぶ運用にしたい');
  await c.send('7営業日で');
  const old = c.draft();
  const oldCard = c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0];
  const r = await c.send('承認待ちの一覧も作りたい');
  const d = c.draft();
  assert(r.intent === 'DRAFT_REPLY' && r.draft.intent === 'propose' && d.id !== old.id && d.rev === 1 && d.request === '承認待ちの一覧も作りたい' && old.status === 'superseded' && old.supersededBy && c.draftDecisions().length === 0 && d.items.decisions.length === 1, `B3-30: intent propose なら新しい仮案（新しい id・request は今回の発言）。前の仮案は superseded・決定事項は引き継がない: ${d.id !== old.id} / ${old.status} / ${c.draftDecisions().length}`);
  assert(c.requirements().length === 1 && /一覧/.test(c.requirements()[0].behavior) && calls.propose[2].previous && calls.propose[2].previous.behaviors.length === 1, 'B3-31: 要件の台帳も新しい仮案のもの（前の仮案は AI に previous として渡した上で、AI が別の依頼と読んだ）');
  const html = KTAiChatUi.messageHtml(oldCard, { draft: d, draftDecisions: c.draftDecisions() });
  assert(/前の仮案（別の依頼）/.test(html) && /kt-ai-old-card/.test(html) && !/data-act="draft-adopt"/.test(html), 'B3-32: 前の仮案のカードは「前の仮案（別の依頼）」に畳む');
  // 新しい仮案の判断（期限）は、前の仮案での答え（7 営業日）が引き継がれないので未回答
  assert(KTAiConversation.openDraftDecisions(d, c.draftDecisions()).length === 1 && calls.propose[2].decisions.length === 1, 'B3-33: 新しい仮案の AI の呼び出しには前の決定事項を渡すが（AI が同じ依頼の続きと読む余地）、新しい仮案になったら持ち越さない');
});
// 8. 分類: 仮案が open のときの採用語と相づち・NO_PLAN の案内文
await section(async () => {
  const c = KTAiConversation.classifyDraft;
  const noOpen = { activePlan: null, draftDecisions: [], draft: { id: 'd1', status: 'open', items: { behaviors: [], assumptions: [], decisions: [], approach: { standard: [], js: [] }, cannot: [] } } };
  const withOpen = { ...noOpen, draft: { ...noOpen.draft, items: { ...noOpen.draft.items, decisions: [{ id: 'Q1', key: 'k', question: 'q', recommendation: '', blocking: true }] } } };
  const adoptWords = ['承認します', '確定', 'それで', 'お願いします', 'よろしくお願いします', '採用します', 'それでお願いします', 'これで確定で'];
  assert(adoptWords.every(s => c(s, noOpen)?.intent === 'ADOPT_DRAFT' && c(s, noOpen)?.reason === 'ADOPT_WORDS') && adoptWords.every(s => c(s, withOpen)?.reason === 'ADOPT_WITH_OPEN'), `B3-34: 採用語（承認します・確定・それで・お願いします・よろしくお願いします）は採用（先に必要な判断が残れば AI に聞き直させる）: ${adoptWords.map(s => `${s}:${c(s, noOpen)?.intent}/${c(s, noOpen)?.reason}`).join(' ')}`);
  assert(['はい', 'OK', 'ok', 'うん', '了解'].every(s => c(s, noOpen)?.reason === 'DRAFT_SMALLTALK' && c(s, noOpen)?.ack === true) && c('ありがとう', noOpen)?.reason === 'DRAFT_SMALLTALK' && !c('ありがとう', noOpen)?.ack, 'B3-35:「はい」「OK」単独は相づち（採用ではない。採用の言い方を案内する）');
  assert(c('通知は不要でお願いします', noOpen)?.intent === 'DRAFT_REPLY' && c('承認してください', noOpen)?.intent === 'ADOPT_DRAFT' && c('反映して', noOpen) === null && c('お願いします', { activePlan: null, draft: null, draftDecisions: [] }) === null, 'B3-36: 修正の語があれば AI へ・反映の命令は従来・仮案が無ければ「お願いします」は従来の相づち');
  const x = makeConv({ withPlan: true });
  await x.c.send('課長・部長の承認者を選ぶ運用にしたい');
  const n = x.calls.propose.length;
  const r1 = await x.c.send('はい');
  assert(r1.reason === 'DRAFT_SMALLTALK' && x.calls.propose.length === n && x.calls.plan.length === 0 && /採用するときは「採用します」/.test(x.last().text), `B3-37:「はい」は AI を呼ばず採用の言い方を案内: ${x.last().text}`);
  const r2 = await x.c.send('反映して');
  assert(r2.intent === 'GENERAL' && r2.reason === 'NO_PLAN' && /仮案への返事（採用・変えたい点・質問）/.test(x.last().text) && x.calls.plan.length === 0, `B3-38: 仮案 open のときの NO_PLAN の案内は仮案への返事を促す: ${x.last().text}`);
});
// 10. 仮案の AI の応答待ちの間: 質問は並べて答え、それ以外は入力欄に残す（null）。見出しは「仮案を作成中」
await section(async () => {
  const g = gateMk();
  const x = makeConv({ proposeGate: g });
  const { c, calls } = x;
  const p = c.send('課長・部長の承認者を選ぶ運用にしたい');
  await ticks(4);
  const ws = VM.workStatus({ version: null, working: c.state.working, draft: c.draft() });
  assert(c.isBusy() && c.canQueue() && c.state.working === 'PROPOSE' && c.state.workInbox && c.state.workInbox.kind === 'PROPOSE' && ws.key === 'drafting' && ws.label === '仮案を作成中', `B3-39: 応答待ちの間は working PROPOSE・見出し「仮案を作成中」: ${JSON.stringify(ws)}`);
  const rq = await c.send('CSVにも効きますか？');
  const rr = await c.send('通知は不要');
  const rg = await c.send('ありがとう');
  assert(rq && rq.asked === true && rq.reason === 'ASKED_WHILE_BUSY' && calls.ask.length === 1 && rr === null && rg === null, `B3-40: 質問は並べて答え（質問の AI へ）、返事・相づちは入力欄に残す（null）: ${JSON.stringify(rq)} / ${rr} / ${rg}`);
  assert(calls.ask[0].conversation.working === null && calls.ask[0].conversation.plan === null, 'B3-41: 質問の AI に渡す working は Gateway の語彙（null）。仮案はまだ無い');
  assert(/仮案を作っています。質問にはすぐ答えます/.test(KTAiChatUi.busyHintText('PROPOSE')) && /この文は仮案ができてから/.test(KTAiChatUi.busyHintText('PROPOSE', { accepted: false })), 'B3-42: 入力欄の案内（応答待ち）');
  g.open(); await p; await ticks(4);
  assert(c.draft() && c.draft().rev === 1 && c.state.workInbox === null && c.state.working === null && c.messages().filter(m => m.type === 'DRAFT').length === 1 && c.messages().some(m => m.data?.kind === 'aside-answer'), 'B3-43: 応答の後は仮案 1 枚・質問の答えのカード・作業の受け口は空');
});

// =========================================================
console.log('\n--- §B4. 画面: 採用 → 計画の失敗 → 再試行 / 回答欄のフォーカス ---');
await section(async () => {
  const pg = gateMk();
  const m = mount({ planImpl: async () => { await pg.p; throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); } });
  await ticks();
  await m.panel.send('課長・部長の承認者を選ぶ運用にしたい'); await ticks(8);
  await m.panel.send('100円未満は部長不要、100万円以上は必要'); await ticks(8);
  await m.panel.send('7営業日で。会社独自の休業日は今回はなし'); await ticks(8);
  const p = m.panel.send('おすすめで'); await ticks(10);
  assert(/data-status="finalizing">最終案を作成中</.test(m.$('kt-ai-ws-state').innerHTML) && /最終案を作っています/.test(m.$('kt-ai-change-summary').innerHTML) && /仮案 — 採用して最終案を作っています/.test(m.chat()) && !/data-act="draft-adopt"/.test(m.chat()), `B4-1: 計画を作っている間: 右の見出し「最終案を作成中」・右の詳細「最終案を作っています」・カードは畳む: ${m.$('kt-ai-ws-state').innerHTML}`);
  pg.open(); await p; await ticks(8);
  const err = m.msgs().filter(x => x.type === 'ERROR').slice(-1)[0];
  assert(m.conv().draft().status === 'open' && /data-status="draft">仮案</.test(m.$('kt-ai-ws-state').innerHTML) && /採用（変更案の作成に失敗。再試行できます）/.test(m.$('kt-ai-change-summary').innerHTML) && !/最終案を作っています/.test(m.$('kt-ai-change-summary').innerHTML), `B4-2: 失敗の後: 仮案は open・右の見出し「仮案」・右の詳細に失敗の文: ${m.$('kt-ai-ws-state').innerHTML}`);
  assert(err && err.data.intent === 'ADOPT_DRAFT' && err.data.retryText === '採用します' && /data-act="retry"/.test(m.chat()) && /仮案 — 採用（変更案の作成に失敗。再試行できます）/.test(m.chat()) && /data-act="draft-adopt"/.test(m.chat()), 'B4-3: 失敗のカードに［再試行］（採用します）・仮案のカードは開いたまま（採用のボタンあり）');
  await clickChat(m, 'retry', { text: err.data.retryText, intent: err.data.intent }); await ticks(8);
  assert(m.calls.plan.length === 2 && m.calls.plan[1].ctx.goal === m.calls.plan[0].ctx.goal && m.conv().draft().status === 'open' && m.conv().draft().planFailed.attempt === 2, 'B4-4: ［再試行］は仮案から作り直す（同じ依頼文）。また失敗したら open のまま');
  m.planImpl = null;   // 計画の AI が直った
  const u = m.msgs().filter(x => x.type === 'USER').length;
  await clickChat(m, 'draft-adopt', { draft: m.conv().draft().id }); await ticks(10);
  const d = m.conv().draft(), v = m.conv().activePlan();
  assert(m.msgs().filter(x => x.type === 'USER').length === u + 1 && v && d.status === 'adopted' && d.planId === v.planId && /仮案 — 採用して最終案を作りました/.test(m.chat()) && /kt-ai-final-card/.test(m.chat()) && /data-status="ready">未反映</.test(m.$('kt-ai-ws-state').innerHTML) && /<h3>/.test(m.$('kt-ai-change-summary').innerHTML), `B4-5: ［採用］でもう一度 → 計画ができたら adopted・最終案のカード・右は変更内容に: ${d.status} / ${m.$('kt-ai-ws-state').innerHTML}`);
  // 回答欄（data-dkey）のフォーカスの復元: 描き直しの前に入力中だった回答欄へ戻す（Toolkit の sandbox の document.activeElement を仮に置く）
  const el = { dataset: { dkey: 'x:k' }, selectionStart: 2, focused: false, caret: null, focus() { this.focused = true; }, setSelectionRange(a) { this.caret = a; } };
  const chatEl = m.$('kt-ai-chat');
  const prevQSA = chatEl.querySelectorAll;
  const sbDoc = T.__sandbox.document;
  chatEl.querySelectorAll = (sel) => (sel === '.kt-ai-qa-input' ? [el] : []);
  sbDoc.activeElement = el;
  try { await m.panel.send('ありがとう'); await ticks(4); } finally { delete sbDoc.activeElement; chatEl.querySelectorAll = prevQSA; }
  assert(el.focused === true && el.caret === 2, 'B4-6: 仮案の回答欄（data-dkey）に入力中なら、描き直しの後にフォーカスとカーソルを戻す');
});

// =========================================================
console.log('\n--- §B6. 段階 B 修正後の確認（2026-10-07）: 決定事項が最初の計画に届く / 応答待ちのボタン / 表示用の goal / 作成中の要約 / 仮案が無いときの判定 ---');
/** 計画の AI が、仮案で答えた論点（期限の日数）をもう一度質問し、新しい論点（指定する画面）も質問する計画 */
const PLAN_QS = [{ id: 'Q1', question: '承認の期限は申請から何営業日にしますか', topic: 'timing' }, { id: 'Q2', question: '承認者はどの画面で指定しますか', topic: 'location' }];
const planReask = (args) => { const r = planOk(args); return { ...r, plan: { ...r.plan, questions: PLAN_QS } }; };
// 1. 会話: 採用 → 最初の計画の services.plan に決定事項（構造化）→ 計画の AI が同じ論点を質問しても openQuestions に出ない（reasked に記録）→ 台帳に回答済みとして入る → 差分更新でも decisions に入る
await section(async () => {
  const x = makeConv({ planImpl: planReask });
  const { c, calls } = x;
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) await c.send(s);
  const r = await c.send('おすすめで');
  const v = c.activePlan();
  assert(r.ok && r.intent === 'ADOPT_DRAFT' && v && calls.plan.length === 1 && !calls.plan[0].revision && Array.isArray(calls.plan[0].decisions) && calls.plan[0].decisions.length === 4 && calls.plan[0].decisions.some(d => d.key === 'deadline.days' && d.answer === '7営業日'), `B6-1: 採用 → 最初の計画（revision 無し）の services.plan に仮案で答えた決定事項（4 件）を渡す: ${JSON.stringify((calls.plan[0] || {}).decisions)}`);
  const openTexts = (v.openQuestions || []).map(q => q.text), reasked = (v.reaskedQuestions || []).map(q => q.text);
  assert(openTexts.join('|') === '承認者はどの画面で指定しますか' && reasked.join('|') === '承認の期限は申請から何営業日にしますか', `B6-2: 計画の AI が仮案で答えた論点（期限の日数）をもう一度質問しても openQuestions に出ない（reasked に記録）。新しい論点だけ残る: open=${openTexts.join('|')} / reasked=${reasked.join('|')}`);
  const lg = c.ledger(v.planId);
  const carried = lg.filter(e => e.draftKey);
  assert(carried.length === 4 && carried.every(e => e.status === 'answered' && e.source === 'chat' && e.appliedInVersion === 1 && e.question && e.kind === 'question') && carried.find(e => e.draftKey === 'deadline.days').topics.join() === 'timing' && carried.find(e => e.draftKey === 'approval.threshold').topics.join() === 'approver' && carried.find(e => e.draftKey === 'approval.threshold').label === '部長承認の条件' && carried.find(e => e.draftKey === 'approval.threshold_middle').delegated === true && !carried.find(e => e.draftKey === 'deadline.days').delegated, `B6-3: 仮案の決定事項は計画の系列の台帳に回答済み（topics は key から・label・question・answer・delegated の印・最初の版に入れた）として入る: ${JSON.stringify(carried.map(e => [e.draftKey, e.topics, e.label, e.answer, e.delegated || false, e.appliedInVersion]))}`);
  assert(!c.messages().some(m => m.data?.kind === 'answers-ack') && c.answerContext().open.length === 1 && c.answerContext().open[0].text === '承認者はどの画面で指定しますか', `B6-4: 台帳に入れた決定事項は「まだ変更案に入っていない回答」にならず、未回答は新しい論点の 1 件だけ: ${JSON.stringify(c.answerContext().open.map(q => q.text))}`);
  // 表示用の goal（確認 3）: 版の goal は仮案の依頼文（1 行目）。Gateway へ送った goal（goalSent）は依頼文 ＋ 採用した方針の 2 行のまま
  assert(v.goal === '課長・部長の承認者を選ぶ運用にしたい' && v.goalSent === calls.plan[0].goal && v.goalSent.split('\n').length === 2 && /^採用した方針: /.test(v.goalSent.split('\n')[1]), `B6-5: 版の表示用の goal は仮案の依頼文の 1 行目。Gateway へ送る goal は今のまま（2 行）: ${JSON.stringify({ goal: v.goal, goalSent: v.goalSent })}`);
  // 差分更新: 送る goal は goalSent・決定事項（仮案の分を含む）を渡す
  const rr = await c.send('一覧の名前は承認待ちにして');
  const p1 = calls.plan[1];
  assert(rr.ok && rr.intent === 'REVISE_PLAN' && calls.plan.length === 2 && p1.revision === true && p1.goal === v.goalSent && (p1.decisions || []).some(d => d.topic === 'timing' && d.answer === '7営業日') && (p1.decisions || []).some(d => d.topic === 'approver' && d.answer === '100円未満は不要、100万円以上は必要') && (p1.decisions || []).length >= 4, `B6-6: 以後の差分更新でも仮案の決定事項が decisionsForContext に入り、goal は Gateway へ送ったもの（2 行）のまま: ${JSON.stringify({ goal: p1.goal.split('\n').length, decisions: (p1.decisions || []).map(d => [d.topic, d.answer]) })}`);
  const v2 = c.activePlan();
  assert(v2.version === 2 && v2.goal === '課長・部長の承認者を選ぶ運用にしたい' && v2.goalSent === v.goalSent && v2.fromDraft && v2.fromDraft.id === c.draft().id, `B6-7: 次の版も表示用の goal は 1 行目のまま（fromDraft を引き継ぐ）: ${JSON.stringify({ goal: v2.goal, version: v2.version })}`);
});
// 1b. 画面: Gateway に送る Planner Context（KTContextUi.generatePlan の ctx）に decisions が入る・右の見出しは依頼文の 1 行目・計画の AI の再質問は出ない
await section(async () => {
  const planWithQs = ({ ctx, requestId }) => { const raw = PLAN_V1(ctx.goal); raw.plan.questions = PLAN_QS; const v = KTAiClient.validatePlan(raw, ctx); if (!v.ok) throw new Error(v.errors[0].message); return { ...v.normalized, requestId, clientWarnings: v.warnings }; };
  const m = mount({ planImpl: planWithQs });
  await ticks();
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) { await m.panel.send(s); await ticks(8); }
  await m.panel.send('おすすめで'); await ticks(12);
  const ctx = m.calls.plan[0] && m.calls.plan[0].ctx;
  const v = m.conv().activePlan();
  assert(v && ctx && !ctx.revision && Array.isArray(ctx.decisions) && ctx.decisions.length === 4 && ctx.decisions.every((d, i) => d.id === `D${i + 1}` && d.source === 'chat' && d.status === 'answered' && d.answer) && ctx.decisions.some(d => d.topic === 'timing' && d.answer === '7営業日') && ctx.decisions.some(d => d.topic === 'approver' && /部長承認/.test(d.question || '')), `B6-8: 採用後の最初の計画の Planner Context（Gateway に送る形）に decisions（D1…・topic・question・answer）が入る: ${JSON.stringify(ctx && ctx.decisions)}`);
  assert(ctx.goal.split('\n').length === 2 && v.goal === '課長・部長の承認者を選ぶ運用にしたい' && /<h3>課長・部長の承認者を選ぶ運用にしたい<\/h3>/.test(m.$('kt-ai-change-summary').innerHTML) && !/<h3>[^<]*採用した方針/.test(m.$('kt-ai-change-summary').innerHTML), `B6-9: 右ペインの見出しは依頼文の 1 行目（合成の 2 行にならない）。Context の goal は 2 行のまま: ${(m.$('kt-ai-change-summary').innerHTML.match(/<h3>[^<]*<\/h3>/) || [])[0]}`);
  const openTexts = (v.openQuestions || []).map(q => q.text), reasked = (v.reaskedQuestions || []).map(q => q.text);
  assert(openTexts.join('|') === '承認者はどの画面で指定しますか' && reasked.join('|') === '承認の期限は申請から何営業日にしますか' && !/承認の期限は申請から何営業日にしますか[\s\S]*data-qkey/.test(outsideDetails(m.chat())) && /後で決めてよいことが 1 件あります/.test(m.chat()) && !/承認者はどの画面で指定しますか[\s\S]*data-qkey/.test(outsideDetails(m.chat())) && /承認者はどの画面で指定しますか/.test(m.$('kt-ai-change-summary').innerHTML + m.$('kt-ai-spec').innerHTML + (m.$('kt-ai-questions') ? m.$('kt-ai-questions').innerHTML : '')), `B6-10（反証 B6: 最終案のカードは先に決めたいことだけ。後で決めてよい質問は件数と右ペイン）: 画面でも、仮案で答えた論点の再質問は確認事項に出ず、新しい論点だけ出る: open=${openTexts.join('|')} / reasked=${reasked.join('|')}`);
});
// 2. 画面: 仮案の AI の応答待ち中（working PROPOSE）は、仮案のカードの［採用］［一部採用］［不採用］と回答欄を出さず、短い案内を出す（カードは畳まない）
await section(async () => {
  const gm = { p: Promise.resolve() };   // 1 回目の仮案は止めない。2 回目の返事の応答だけ止める
  const m = mount({ proposeGate: gm });
  await ticks();
  await m.panel.send('課長・部長の承認者を選ぶ運用にしたい'); await ticks(8);
  const before = m.chat();
  assert(/data-act="draft-adopt"/.test(before) && /data-dkey="/.test(before) && !/仮案の返事を待っています/.test(before), 'B6-11: 応答を待っていないときは［採用］と回答欄がある');
  const g = gate(); gm.p = g.p;
  const p = m.panel.send('100円未満は部長不要、100万円以上は必要'); await ticks(8);
  const during = m.chat();
  const cardDuring = (during.match(/<div class="kt-ai-card kt-ai-draft-card[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
  assert(m.conv().state.working === 'PROPOSE' && !/data-act="draft-adopt"|data-act="draft-partial"|data-act="draft-reject"|data-act="draft-answer"/.test(during) && !/data-dkey="/.test(during) && /kt-ai-draft-card is-waiting/.test(during) && /仮案の返事を待っています/.test(during) && !/kt-ai-draft-card is-old/.test(during) && !INTERNAL.test(outsideDetails(during).replace(/data-[a-z]+="[^"]*"/g, '')), `B6-12: 応答待ち中は［採用］［一部採用］［不採用］と回答欄を出さず、「仮案の返事を待っています」の案内だけ（カードは畳まない）: ${cardDuring.slice(0, 160)}`);
  const users = m.msgs().filter(x => x.type === 'USER').length;
  await clickChat(m, 'draft-adopt', { draft: m.conv().draft().id }); await ticks(4);
  assert(m.msgs().filter(x => x.type === 'USER').length === users && m.calls.plan.length === 0 && m.calls.propose.length === 2, 'B6-13: 応答待ち中に古いカードの［採用］が押されても、送らない（計画も作らない）');
  g.open(); await p; await ticks(8);
  const after = m.chat();
  assert(m.conv().draft().rev === 2 && /data-act="draft-adopt"/.test(after) && /data-dkey="/.test(after) && !/仮案の返事を待っています/.test(after) && (after.match(/kt-ai-draft-card is-old/g) || []).length === 1, 'B6-14: 応答が届いたら新しいカードに［採用］と回答欄が戻り、前のカードは 1 行に畳む');
  const viewNoWorking = KTAiChatUi.messageHtml(m.msgs().filter(x => x.type === 'DRAFT').slice(-1)[0], { draft: m.conv().draft(), draftDecisions: m.conv().draftDecisions(), draftAnswers: new Map() });
  const viewWorking = KTAiChatUi.messageHtml(m.msgs().filter(x => x.type === 'DRAFT').slice(-1)[0], { draft: m.conv().draft(), draftDecisions: m.conv().draftDecisions(), draftAnswers: new Map(), working: 'PROPOSE' });
  assert(/data-act="draft-adopt"/.test(viewNoWorking) && !/data-act="draft-adopt"/.test(viewWorking) && /仮案の返事を待っています/.test(viewWorking) && /data-act="draft-adopt"/.test(KTAiChatUi.messageHtml(m.msgs().filter(x => x.type === 'DRAFT').slice(-1)[0], { draft: m.conv().draft(), draftDecisions: m.conv().draftDecisions(), draftAnswers: new Map(), working: 'PLAN' })), 'B6-15: draftCardHtml は view.working が PROPOSE のときだけ押せないボタンを出さない（PLAN は draft.planning で判定）');
});
// 4. 採用して最終案を作っている間の、質問の AI に渡す仮案の要約は「採用した仮案（最終案を作成中）」
await section(async () => {
  const g = gateMk();
  const x = makeConv({ planImpl: async () => { await g.p; return planOk({ goal: 'g' }); } });
  const { c, calls } = x;
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) await c.send(s);
  const p = c.send('おすすめで');
  await ticks(6);
  const rq = await c.send('CSVにも効きますか？');
  const cv = calls.ask.slice(-1)[0].conversation;
  assert(rq && rq.asked === true && c.draft().planning === true && cv.plan && /^採用した仮案（最終案を作成中）: /.test(cv.plan.summary) && !/採用前の仮案/.test(cv.plan.summary) && cv.working === 'PLAN', `B6-16: 最終案を作っている間の質問には「採用した仮案（最終案を作成中）」の要約を添える: ${cv.plan && cv.plan.summary.slice(0, 60)} / ${cv.working}`);
  g.open(); await p; await ticks(4);
  assert(c.activePlan() && c.draft().status === 'adopted', 'B6-17: 計画ができたら adopted（要約は計画に切り替わる）');
  const y = makeConv();
  await y.c.send('課長・部長の承認者を選ぶ運用にしたい');
  await y.c.send('5営業日にすると何が変わる？');
  assert(/^採用前の仮案（まだ計画ではありません）: /.test(y.calls.ask[0].conversation.plan.summary), 'B6-18: 採用前は従来どおり「採用前の仮案（まだ計画ではありません）」');
});
// 5. 仮案が無いときの PROPOSE 判定: 相づち・制止・短い否定は従来の判定へ。言い切りの長さの条件は 8 字以上
await section(async () => {
  const cd = KTAiConversation.classifyDraft;
  const noDraft = { activePlan: null, draft: null, draftDecisions: [] };
  const notReq = ['問題ありません', 'ちょっと待って', 'やめる', 'やっぱりやめる', 'この案は採用しません', '結構です', '採用しません', 'やめて', '大丈夫です', '不採用で', '違います', 'いいえ'];
  assert(notReq.every(s => cd(s, noDraft) === null), `B6-19: 仮案が無いとき、相づち・制止・短い否定は PROPOSE にしない（従来の判定へ）: ${notReq.map(s => `${s}:${cd(s, noDraft)?.intent || 'null'}`).join(' ')}`);
  assert(cd('承認者は部長', noDraft) === null && cd('承認者は部長固定', noDraft)?.intent === 'PROPOSE' && cd('承認済みでは金額を編集不可', noDraft)?.intent === 'PROPOSE' && cd('通知は不要', noDraft)?.intent === 'PROPOSE' && cd('一覧も作りたい', noDraft)?.intent === 'PROPOSE', 'B6-20: 言い切りは 8 字以上で依頼と読む（要望の語があれば短くても依頼）');
  const open = { activePlan: null, draftDecisions: [], draft: { id: 'd1', status: 'open', items: { behaviors: [], assumptions: [], decisions: [], approach: { standard: [], js: [] }, cannot: [] } } };
  assert(cd('この案は採用しません', open)?.intent === 'DRAFT_REPLY' && cd('やっぱりやめる', open)?.intent === 'DRAFT_REPLY' && cd('問題ありません', open)?.intent === 'ADOPT_DRAFT', 'B6-21: 仮案が open のときの判定は変えない（不採用・やめるは AI へ、問題ありませんは採用語）');
  // 従来の会話の経路（仮案が無い）: 「ちょっと待って」で仮案の AI を呼ばない
  const x = makeConv({ withPlan: true });
  const r = await x.c.send('ちょっと待って');
  assert(r.intent !== 'PROPOSE' && x.calls.propose.length === 0 && x.calls.plan.length === 0, `B6-22: 「ちょっと待って」は仮案の AI も計画の AI も呼ばない: ${r.intent}/${r.reason}`);
});

// =========================================================
console.log('\n--- §C. 段階 C: 最終案のパイプライン（R09 R10 R11 R16 R17 R18 R19 R21）と待ち時間の表示（C3b）。2026-10-08: 生成工程の verification を返す偽の生成 ---');
//   偽 services: plan（JS ありの計画。金額の効果は lock）/ generate（Gateway の customization-generator の偽物。Toolkit が固定した必須の効果を受け取り、
//   候補の性質（has: フィールドごとに実装している効果・fails: 動作テストで不合格になる効果）から requiredEffects の status と behavior の結果を返す。
//   修復は生成工程の 1 依頼の中で済んだものとして repairs に記録）。Toolkit は模擬を実行せず、代表条件も作らず、修復も依頼しない
const RP = require('./fixtures/p21-bfc-replay.js');
const { KTCodeReview } = T;
const DATA_C = { appId: '353', fields: clone(RP.FIELDS), status: { enable: true, states: { '作成中': { name: '作成中', index: '0', assignee: { type: 'ONE', entities: [] } }, '承認待ち': { name: '承認待ち', index: '1', assignee: { type: 'ONE', entities: [] } }, '承認済み': { name: '承認済み', index: '2', assignee: { type: 'ONE', entities: [] } } }, actions: [] }, layout: [] };
const LABELS_C = { amount: '金額', 'ステータス': 'ステータス', memo: '備考' };
const custOf = (effects, o = {}) => ({ customizationId: 'C1', requirement: '承認待ちでは金額を編集不可にする', whyStandardInsufficient: 'ステータスで切り替えるアクセス権は無い', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', ...(effects ? { effects } : {}) }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [], ...o });
const CUST_C1 = custOf(['lock']);
const ST_C = "record['ステータス'] && record['ステータス'].value === '承認待ち'";
const handlerC = (body, evs = ['app.record.edit.show']) => `(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(evs)}, function (event) {\n    const record = event.record;\n${body}\n    return event;\n  });\n})();`;
const GOOD = handlerC(`    if (${ST_C}) record['amount'].disabled = true;`);
const BAD = handlerC("    record['amount'].disabled = true;\n    record['amount'].error = '確認してください';");
const WARN = handlerC(`    record['amount'].error = (${ST_C}) ? '承認待ちの金額です' : null;`);
const VALUE = handlerC(`    if (${ST_C}) record['amount'].value = 0;`);
const LOCKSAVE = `(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (${ST_C}) record['amount'].disabled = true;\n    return event;\n  });\n  kintone.events.on(['app.record.edit.submit'], function (event) {\n    const record = event.record;\n    if (${ST_C}) event.error = '承認待ちのレコードは保存できません';\n    return event;\n  });\n})();`;
/** 候補（偽の生成工程が最後に返したもの）と、その性質 */
const CAND = {
  good: { code: GOOD, has: { amount: ['lock'] } },
  bad: { code: BAD, has: { amount: ['lock', 'warn'] }, fails: ['amount|lock'], failMsg: '承認待ちの編集画面で、エラー表示のため編集不可が取り消されました' },
  warn: { code: WARN, has: { amount: ['warn'] } },
  value: { code: VALUE, has: { amount: ['set-value'] } },
  lockonly: { code: GOOD, has: { amount: ['lock'] } },
  locksave: { code: LOCKSAVE, has: { amount: ['lock', 'block-save'] } },
};
const EXPECT_OF = { lock: 'lock', warn: 'warn', 'block-save': 'block-save', 'set-value': 'set-value', 'show-hide': 'show-hide' };
/** 偽の生成工程の verification（契約 20 §5・§0c.3 の 5 の形）。env = 動作テストを実行できない理由（timeout など）。supported:false は旧い接続先（requiredEffects・behavior を返さない） */
function fakeVerification(cand, requiredEffects, { env = null, repairs = 0, stoppedBy = null, supported = true, candidateHash, dropCaseFor = null } = {}) {
  const req = Array.isArray(requiredEffects) ? requiredEffects : [];
  const has = (x) => (cand.has[x.field] || []).includes(x.effect);
  const re = req.map(x => ({ requirementId: x.requirementId, field: x.field, effect: x.effect, status: has(x) ? 'present' : 'missing' }));
  const uniq = [...new Map(req.map(x => [`${x.field}|${x.effect}`, x])).values()].filter(x => `${x.field}|${x.effect}` !== dropCaseFor);
  const cases = uniq.map((x, i) => {
    if (env) return { id: `K${i + 1}`, requirementId: x.requirementId, field: x.field, effect: x.effect, expect: EXPECT_OF[x.effect], verdict: 'not-run', observed: null, message: '隔離環境で実行できませんでした' };
    const fail = !has(x) || (cand.fails || []).includes(`${x.field}|${x.effect}`);
    return { id: `K${i + 1}`, requirementId: x.requirementId, field: x.field, effect: x.effect, expect: EXPECT_OF[x.effect], verdict: fail ? 'fail' : 'pass', observed: {}, message: fail ? (cand.failMsg || `${x.field} は期待した動きになりませんでした`) : '期待どおり' };
  });
  const missing = re.filter(x => x.status === 'missing');
  const machine = [{ name: 'syntax', ok: true, severity: 'info', message: '構文エラーなし' }, { name: 'modern-js', ok: true, severity: 'info', message: '新しいコードに var はありません' }, ...(supported && req.length ? [{ name: 'required-effects', ok: !missing.length, severity: missing.length ? 'block' : 'info', message: missing.length ? `要件未達（${missing.map(x => `${x.field}: ${x.effect}`).join('、')}の処理がありません）` : '必須の効果の処理があります' }] : [])];
  return { version: '1', candidateHash, sameAsPrevious: false, passed: !machine.some(m => !m.ok && m.severity === 'block'), machine,
    ...(supported ? { requiredEffects: re, behavior: { status: env ? 'not-run' : cases.some(c => c.verdict === 'fail') ? 'failed' : 'passed', reason: env, cases } } : {}),
    repairs: { count: repairs, reasons: [], stoppedBy }, unverified: ['実機での動作'] };
}
/** JS ありの計画（C1）。questions / cust / turn（requirementOps）/ gatewayPlan で変える */
const planJs = (args, { questions = [], cust = CUST_C1, summary = '承認待ちでは金額を編集不可にします。', requirementOps = [], gatewayPlan = null } = {}) => ({
  plan: { goal: args.goal, assessment: { summary }, steps: [{ id: 'C1', actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: null, title: 'JavaScript', spec: { customizationId: 'C1' }, dependsOn: [] }], customizations: [clone(cust)], provisionals: [{ id: 'V1', choice: '編集不可の間は入力欄を灰色にする', changeHint: '' }], questions, unknowns: [], impact: [{ targetRef: 'amount', description: '承認待ちの間、金額は変更できません' }], solution: 'CUSTOMIZATION' },
  ctx: null, gatewayPlan, turn: { reply: '計画を作りました。承認待ちの間だけ金額を編集不可にします。', requirementOps, utteranceCoverage: [] },
  review: { base: { baseVersion: '1', env: 'preview', ok: true, fingerprint: 'fp-1', revision: { preview: '10' } }, steps: [{ stepId: 'C1', status: 'VALID', safety: 'PLAN_ONLY', customization: clone(cust), codeGeneration: { supported: true, strategy: cust.strategy, reason: null }, issues: [] }], executionReadiness: { safeSteps: [], reviewSteps: [], blockedSteps: [], planOnlySteps: ['C1'] }, warnings: [] },
});
/**
 * 偽の生成（Gateway の customization-generator）。sequence = 呼び出しごとの候補（CAND のキー）。repairs / stoppedBy = 生成工程の 1 依頼の中の修復。
 * 呼び出しごとに Toolkit が渡した必須の効果（requiredEffects）・feedback の有無を記録する
 */
function makeGenerate({ sequence = ['good'], gate = null, env = null, repairs = 0, stoppedBy = null, supported = true, dropCaseFor = null, existingSource = null, generatedOf = null } = {}) {
  const calls = [];
  const impl = async (args) => {
    const n = calls.length;
    calls.push({ cid: args.customizationId, feedback: args.feedback ? clone(args.feedback) : null, verification: !!args.verification, requiredEffects: clone(args.requiredEffects || null), previous: args.previous ? { candidateHash: args.previous.candidateHash } : null });
    if (gate) await gate.p;
    const which = sequence[Math.min(n, sequence.length - 1)];
    const cand = CAND[which];
    const cust = (args.version.plan.customizations || []).find(x => x.customizationId === args.customizationId) || CUST_C1;
    const generated0 = generatedOf ? generatedOf(cust) : null;
    //   画面の generate と同じく、新しいコードの var などの記法は Toolkit の自動修正を通す（KTModernJs.fixGenerated）
    const generated = generated0 ? (T.KTModernJs.fixGenerated({ generated: generated0, existingSource }).generated || generated0) : { strategy: 'NEW_JS_FILE', targetFile: 'lock.js', summary: '承認待ちでは金額を編集不可にします。', code: cand.code, patch: null, events: cust.events, fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '', text: cust.requirement }] };
    const review = KTCodeReview.review({ generated, customization: cust, plan: args.version.plan, data: clone(DATA_C), scan: null, existingSource });
    const candidateHash = KTJsSim.candidateHashOf({ strategy: generated.strategy, targetFile: generated.targetFile, code: generated.code, patch: generated.patch, customizationId: 'C1' });
    return { ok: true, generated, review, ctx: { size: { approxTokens: 1000 } }, existingSource, inputHash: `h${n}`, verification: fakeVerification(cand, args.requiredEffects, { env, repairs, stoppedBy, supported, candidateHash, dropCaseFor }), candidateHash, requirementIds: [{ id: 'C1', kind: 'customization', text: cust.requirement }] };
  };
  return { impl, calls };
}
const { KTJsSim } = T;
/** 段階 C の偽 services（仮案 → 採用 → 計画 → 生成と検証（生成工程）→ 最終案） */
function makeConvC({ planImpl = (args) => planJs(args), generate = makeGenerate(), feedback = true, storage = null, planGate = null, materials = '見ている設定: ステータス 3 件・通知 0 件・既存の JavaScript 0 ファイル', supported = true } = {}) {
  const calls = { propose: [], plan: [], ask: [] };
  let t = 1000;
  const x = { planImpl };
  const services = {
    conversationFeatures: () => ['requirements', 'brief', 'stream', 'proposal'], revisionModes: () => ['full'],
    generatorFeatures: () => ['requirementId', 'cases', ...(feedback ? ['feedback'] : []), ...(supported ? ['requiredEffects'] : [])], feedbackSupported: () => feedback, plannerFeatures: () => ['reply'],
    materials: () => materials,
    fieldLabels: () => LABELS_C,
    async customizeRevision() { return '42'; },
    async propose(args) { calls.propose.push({ utterance: args.utterance }); const raw = script(args); if (!raw) return { ok: false, reason: 'NO_SCRIPT', message: `台本がありません: ${args.utterance}` }; t += 3000; if (typeof args.onText === 'function') args.onText(raw.reply.slice(0, 12)); await tick(); t += 4000; if (typeof args.onText === 'function') args.onText(raw.reply); return { ok: true, proposal: normalized(raw, `pp-${calls.propose.length}`), ctx: { facts: [] }, perf: { baseWaitMs: 0, contextMs: 5, requestMs: 7000 } }; },
    async ask(args) { calls.ask.push({ question: args.question }); t += 2000; return { ok: true, answer: { answer: '答えです。', facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx: { facts: [] } }; },
    async plan(args) { calls.plan.push({ goal: args.goal, revision: !!args.revision, onText: typeof args.onText === 'function', request: args.revision ? args.revision.request : null, focus: args.revision && Array.isArray(args.revision.focus) ? [...args.revision.focus] : null }); if (typeof args.onText === 'function') { t += 3000; args.onText('承認待ちの間だけ金額を'); } if (planGate) await planGate.p; t += 27000; if (typeof args.onText === 'function') args.onText('承認待ちの間だけ金額を編集不可にします。'); return x.planImpl(args); },
    async generate(args) { t += 20000; return generate.impl(args); },
    readiness() { return null; },
  };
  const c = KTAiConversation.create({ services, now: () => '2026-10-07T00:00:00.000Z', clock: () => t, storage });
  Object.assign(x, { c, calls, services, gen: generate, clock: () => t, advance: (ms) => { t += ms; }, kinds: () => c.messages().map(m => m.data?.kind || m.type), finals: () => c.messages().filter(m => m.type === 'FINAL'), last: () => c.messages()[c.messages().length - 1] });
  return x;
}
const adoptC = async (x) => { for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) await x.c.send(s); return x.c.send('おすすめで'); };
const finalHtml = (x, m = x.finals().slice(-1)[0]) => KTAiChatUi.messageHtml(m, { plans: new Map(x.c.planHistory().map(v => [`${v.planId}:${v.version}`, v])), activePlan: x.c.activePlan(), answerState: x.c.answerContext(), ledger: x.c.ledger(), answers: new Map() });
const stripC = (h) => String(h).replace(/<br\s*\/?>/g, '\n').replace(/<\/(div|li)>/g, '\n').replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
// ---- R09: 仮案の採用 → JS 仕様の別確認なしで最終案（計画 → 自動確定 → 生成と検証（生成工程の 1 依頼）→ 1 枚のカード。外部反映はしない）----
await section(async () => {
  const x = makeConvC();
  const r = await adoptC(x);
  const v = x.c.activePlan(), d = x.c.draft();
  assert(r.ok && r.intent === 'ADOPT_DRAFT' && v && d.status === 'adopted' && d.finalAt && v.final && x.finals().length === 1, `R09-1: 採用 → 計画 → 最終案のカード 1 枚: ${JSON.stringify(x.kinds())}`);
  assert(v.spec && v.spec.status === 'CONFIRMED' && v.spec.autoConfirmed === true && v.spec.customizeRevision === '42' && !x.c.messages().some(m => m.type === 'SPEC' || m.data?.kind === 'spec-intro' || m.data?.kind === 'spec-confirm-hint'), `R09-2: JS の仕様は自動で確定（customizeRevision を記録）。［この仕様で確定］の案内・仕様カードは出さない: ${JSON.stringify(v.spec && { status: v.spec.status, rev: v.spec.customizeRevision })}`);
  assert(!x.c.messages().some(m => m.type === 'PLAN' || m.type === 'CODE' || ['plan-summary', 'review-summary', 'questions', 'provisionals', 'code-intro', 'confirm-generate'].includes(m.data?.kind)), `R09-3: 変更案の要約・確認事項・提案・コードの案内は別のカードにしない（最終案に統合）: ${JSON.stringify(x.kinds())}`);
  const sent = x.gen.calls[0] && x.gen.calls[0].requiredEffects;
  assert(x.gen.calls.length === 1 && x.gen.calls[0].verification === true && !x.gen.calls[0].feedback && JSON.stringify(sent) === JSON.stringify([{ requirementId: 'C1', field: 'amount', effect: 'lock', events: ['app.record.edit.show'], condition: 'ステータス in ("承認待ち")' }]) && v.generated.C1 && v.generated.C1.status === 'verified' && v.generated.C1.verdict.status === 'verified', `R09-4: 生成工程への依頼は 1 回（必須の効果を固定して渡す・修復は依頼しない）→ 検証済み: ${JSON.stringify({ gen: x.gen.calls.length, sent, status: v.generated.C1 && v.generated.C1.status })}`);
  assert(v.final.approvable === true && v.final.customizations[0].status === 'verified' && v.final.behaviors.length >= 1 && v.final.changed.rejected.length === 0 && v.final.verification.behavior.status === 'passed' && v.final.verification.behavior.counts.pass === v.final.verification.behavior.cases.length && v.final.verification.effects.length === 1 && v.final.verification.effects[0].structure === 'present', `R09-5: 最終案は承認できる（動作・変わった点・検証の区分）: ${JSON.stringify({ approvable: v.final.approvable, behaviors: v.final.behaviors, beh: v.final.verification.behavior })}`);
  const tm = x.c.metrics().timings.slice(-1)[0];
  assert(tm.intent === 'ADOPT_DRAFT' && tm.calls.map(k => k.kind).join(',') === 'plan,generate' && tm.calls.every(k => typeof k.ms === 'number') && tm.finalMs >= 49000 && v.final.timing.planMs === 30000 && v.final.timing.generateMs === 20000 && !('simMs' in v.final.timing), `R09-6: 計測（calls に plan / generate と区間の時間・最終案までの時間。模擬の区間は無い）: ${JSON.stringify({ calls: tm.calls.map(k => [k.kind, k.ms]), finalMs: tm.finalMs, timing: v.final.timing })}`);
  assert(v.final.usage.aiCalls === 2 && v.final.usage.repairs === 0 && x.c.metrics().aiCalls >= 2, `R09-7: AI の呼び出し回数（Toolkit からの修復の依頼は 0）: ${JSON.stringify(v.final.usage)}`);
  assert(!x.c.messages().some(m => m.type === 'LOADING') && x.c.progress() === null, 'R09-8: 進みのカードは完了で消える（記録には残さない）');
  const html = finalHtml(x);
  assert(/最終案ができました。/.test(html) && /最終的にどう動くか/.test(html) && /仮案から変わった点/.test(html) && /反映先と主な影響/.test(html) && /検証の区分/.test(html) && /data-act="final-approve"/.test(html) && !/disabled>この内容で反映する/.test(html) && /まだ何も反映していません/.test(html), `R09-9: 最終案のカード: 7 つの要素と［この内容で反映する］: ${html.replace(/<[^>]*>/g, '｜').slice(0, 300)}`);
  // 反映先の JavaScript のファイル名（例「lock.js」）は利用者に見せる名前なので、内部の番号の照合から外す
  const visibleC = outsideDetails(html).replace(/data-[a-z]+="[^"]*"/g, '').replace(/[\w.-]+\.js\b/g, '（ファイル名）');
  assert(/lock\.js/.test(html) && !INTERNAL.test(visibleC) && !/\bC1\b|\bP1\b|candidateHash|sim-control|required-effects|block-save|\bamount\b/.test(visibleC), `R09-10: カードに内部の番号・処理名・フィールドコードを出さない（反映先のファイル名は出す）: ${(visibleC.match(INTERNAL) || visibleC.match(/\bamount\b|required-effects/) || [])[0]}`);
  const draftCard = KTAiChatUi.messageHtml(x.c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], { draft: d, draftDecisions: x.c.draftDecisions() });
  assert(/仮案 — 採用して最終案を作りました/.test(draftCard) && /kt-ai-old-card/.test(draftCard), 'R09-11: 仮案のカードは 1 行に畳む');
});
// ---- R17: 最初の候補の欠陥は生成工程の 1 依頼の中で修復済み → 検証済みの最終案を 1 つ提示（Toolkit は修復を依頼しない・失敗候補への判断を求めない）----
await section(async () => {
  const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], repairs: 1 }) });
  await adoptC(x);
  const v = x.c.activePlan();
  assert(x.gen.calls.length === 1 && !x.gen.calls[0].feedback && v.generated.C1.status === 'verified' && v.final.approvable && x.finals().length === 1, `R17-1: 生成工程が中で直した候補 → Toolkit からの追加の呼び出しなしで検証済みの最終案 1 つ: ${JSON.stringify({ gen: x.gen.calls.length, status: v.generated.C1.status })}`);
  assert(!x.c.messages().some(m => m.type === 'CODE' || m.type === 'ERROR' || m.data?.kind === 'generate-repeat' || m.data?.kind === 'code-intro'), `R17-3: 検査途中の候補を「完成」と出さない・採用不可のカードを出さない: ${JSON.stringify(x.kinds())}`);
  assert(v.final.usage.repairs === 0 && v.final.usage.gatewayRepairs === 1 && v.final.customizations[0].gatewayRepairs === 1 && /生成工程の修復 1 回/.test(finalHtml(x)) && /生成工程で 1 回修復/.test(finalHtml(x)), `R17-4: 生成工程の修復回数を記録し、詳細に出す: ${JSON.stringify(v.final.usage)}`);
});
// ---- R19: 生成工程の修復の上限で直らない → 未解決の理由と次の方針を 1 回まとめ、反映可能な完成品として出さない（Toolkit は再依頼しない）----
await section(async () => {
  const y = makeConvC({ generate: makeGenerate({ sequence: ['bad'], repairs: 2, stoppedBy: 'limit' }) });
  await adoptC(y);
  const vy = y.c.activePlan();
  assert(y.gen.calls.length === 1 && !y.gen.calls[0].feedback && vy.generated.C1.status === 'unresolved' && vy.generated.C1.verdict.kind === 'behavior-fail' && vy.generated.C1.verdict.stoppedBy === 'limit', `R19-1: 生成工程が上限まで修復して直らない → Toolkit は追加で呼ばない（1 回だけ）: ${JSON.stringify({ calls: y.gen.calls.length, verdict: vy.generated.C1.verdict })}`);
  assert(vy.final && vy.final.approvable === false && /反映できる完成品になっていない/.test(vy.final.blockingReason) && vy.final.cannot.some(c => c.kind === 'unresolved' && /生成工程で修復を 2 回行いましたが/.test(c.text) && /同じ依頼のまま作り直しても結果は変わりません/.test(c.next)) && y.finals().length === 1, `R19-3: 未解決の理由と次の方針を最終案に 1 回まとめ、承認できる完成品としては出さない: ${JSON.stringify(vy.final.cannot)}`);
  const ap = y.c.approveFinal({ planId: vy.planId, version: vy.version });
  assert(ap.ok === false && ap.reason === 'NOT_APPROVABLE' && !vy.approval, 'R19-4: 未解決の最終案は承認できない');
  const html = finalHtml(y);
  assert(/disabled>この内容で反映する/.test(html) && /次の方針/.test(html) && (html.match(/kt-ai-final-card/g) || []).length === 1, `R19-5: カードの［この内容で反映する］は押せず、理由と次の方針が 1 回だけ: ${html.replace(/<[^>]*>/g, '｜').slice(0, 300)}`);
  assert(!y.c.messages().some(m => m.type === 'ERROR' || m.data?.kind === 'generate-repeat'), 'R19-6: 同じ採用不可カードを連続表示しない（エラーカードも出さない）');
  const tmZ = y.c.metrics().timings.slice(-1)[0];
  assert(tmZ.calls.map(k => k.kind).join(',') === 'plan,generate' && vy.final.usage.aiCalls === 2 && vy.final.usage.gatewayRepairs === 2, `R19-9: 計測の記録（計画・生成。Toolkit の修復の依頼は無い）: ${JSON.stringify({ calls: tmZ.calls.map(k => k.kind), usage: vy.final.usage })}`);
});
// ---- R10: 確認事項（blocking の質問）と JS 仕様: 回答先・次の操作は最終案のカード 1 つ。回答済みの質問は別カードで残らない ----
await section(async () => {
  const Q = [{ id: 'Q1', question: '承認待ちの間、申請者本人も編集できなくしますか', topic: 'scope', priority: 'blocking', options: ['全員', '申請者以外'] }];
  const x = makeConvC({ planImpl: (args) => planJs(args, { questions: args.revision ? [] : Q }) });
  await adoptC(x);
  const v1 = x.c.activePlan();
  assert(v1.final && v1.final.approvable === false && /先に決めたいことが 1 件/.test(v1.final.blockingReason) && v1.final.questions.length === 1 && !x.c.messages().some(m => m.data?.kind === 'questions'), `R10-1: 先に必要な判断は最終案のカードの中（確認事項のカードは出さない）。承認はまだできない: ${JSON.stringify({ q: v1.final.questions.map(q => q.text), kinds: x.kinds() })}`);
  const html1 = finalHtml(x);
  assert(/残る判断（1 件）/.test(html1) && /申請者本人も編集できなくしますか/.test(html1) && /class="kt-ai-qa-input" data-qkey="/.test(html1) && /data-act="answer-questions"/.test(html1) && /disabled>この内容で反映する/.test(html1), `R10-2: 回答欄と［回答を送る］はこのカードだけ・反映のボタンは押せない: ${html1.replace(/<[^>]*>/g, '｜').slice(0, 300)}`);
  const r = await x.c.send('確認事項への回答です。\n・承認待ちの間、申請者本人も編集できなくしますか → 全員', { intentOverride: 'ANSWER', answerPayload: { source: 'answer-card', items: [{ key: 'Q1', answer: '全員' }] } });
  const v2 = x.c.activePlan();
  assert(r.ok && v2.version === 2 && v2.final && v2.final.approvable === true && v2.final.questions.length === 0 && x.finals().length === 2 && x.calls.plan.length === 2 && x.calls.plan[1].revision, `R10-3: 回答 → 差分更新 → 新しい最終案（残る判断なし・承認できる）: ${JSON.stringify({ version: v2.version, q: v2.final.questions, plans: x.calls.plan.length })}`);
  const old = KTAiChatUi.messageHtml(x.finals()[0], { plans: new Map(x.c.planHistory().map(v => [`${v.planId}:${v.version}`, v])), activePlan: v2, answerState: x.c.answerContext(), ledger: x.c.ledger(), answers: new Map() });
  assert(/前の最終案 — このあと直した案があります/.test(old) && /kt-ai-old-card/.test(old) && !/data-qkey=/.test(old) && !/data-act="final-approve"/.test(old) && !/残る判断/.test(finalHtml(x)), 'R10-4: 前の最終案は 1 行に畳み、回答済みの質問は別のカードで残らない');
  assert(x.gen.calls.length === 1 && v2.generated.C1.reused === true, 'R10-5: 実装仕様が変わらなければ JavaScript は作り直さず、検証結果も流用する（計画の AI だけ 1 回）');
});
// ---- R11 / R18: 最終案の生成中の追加指示 → 完了後に差分更新 → 変わった customization だけ作り直し → 最終案を置き換えて「変わった点」を出す ----
await section(async () => {
  const g = gateMk();
  const CUST_V2 = custOf(['lock'], {});
  CUST_V2.fields[1].condition = 'ステータス in ("承認待ち", "承認済み")';
  const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], gate: g }) });
  const p = adoptC(x);
  await ticks(10);
  assert(x.c.isBusy() && x.c.state.working === 'FINAL' && x.c.state.workInbox && x.c.state.workInbox.kind === 'FINAL' && VM.workStatus({ version: x.c.activePlan(), working: 'FINAL' }).label === '最終案を作成中', `R11-1: 生成中は working FINAL・見出し「最終案を作成中」: ${x.c.state.working}`);
  const rq = await x.c.send('通知は外して');
  assert(rq && rq.queued === true && rq.reason === 'QUEUED_DURING_FINAL' && x.c.messages().some(m => m.data?.kind === 'answers-ack' && /いま作っている最終案ができてから/.test(m.text)), `R11-2: 生成中の指示は積んで受領を出す: ${JSON.stringify(rq)}`);
  const ra = await x.c.send('CSVにも効きますか？');
  assert(ra && ra.asked === true && x.calls.ask.length === 1, 'R11-3: 生成中の質問は並べて答える');
  g.open(); await p; await ticks(12);
  const v2 = x.c.activePlan();
  assert(v2 && v2.version === 2 && x.calls.plan.length === 2 && /通知は外して/.test(x.calls.plan[1].request) && x.finals().length === 2 && x.gen.calls.length === 1 && v2.generated.C1.reused === true, `R11-4: 完了後に差分更新 → 実装仕様が同じ C1 は作り直さない → 最終案を置き換え（重複生成しない）: ${JSON.stringify({ version: v2 && v2.version, plans: x.calls.plan.length, gen: x.gen.calls.length })}`);
  assert(v2.final.changedSince && v2.final.changedSince.reused.includes('C1') && /通知は外して/.test(v2.final.changedSince.revisionRequest) && /最終案を直しました。/.test(finalHtml(x)) && /変わった点/.test(finalHtml(x)) && /入れた指示: 通知は外して/.test(finalHtml(x)), `R11-5: 最終案のカードに「変わった点」（入れた指示・作り直した / そのままの JavaScript）: ${JSON.stringify(v2.final.changedSince)}`);
  assert(x.c.messages().filter(m => m.data?.kind === 'answers-ack').every(m => m.data.stage === 'done'), 'R11-6: 受領は「変更案に入れました」になる');
  // R18: 実装仕様（条件）が変われば候補も検証結果も流用しない（作り直して、新しい条件の必須の効果で検証し直す）
  const y = makeConvC({ planImpl: (args) => planJs(args, { cust: args.revision ? CUST_V2 : CUST_C1 }) });
  await adoptC(y);
  await y.c.send('承認済みでも金額は編集不可にして');
  const vy = y.c.activePlan();
  assert(vy.version === 2 && y.gen.calls.length === 2 && vy.generated.C1.reused !== true && vy.final.changedSince.regenerated.includes('C1') && y.gen.calls[1].requiredEffects[0].condition === 'ステータス in ("承認待ち", "承認済み")', `R18-1: 実装仕様（条件）が変わった → 作り直して、新しい条件の必須の効果で検証し直す（前の合格は流用しない）: ${JSON.stringify({ gen: y.gen.calls.length, cond: y.gen.calls[1] && y.gen.calls[1].requiredEffects })}`);
  // R18: 既存コードが変わった → 流用しない
  const z = makeConvC({ planImpl: (args) => planJs(args) });
  let hashNow = 'aaaa0000';
  z.services.existingHash = async () => hashNow;
  await adoptC(z);
  hashNow = 'bbbb1111';
  await z.c.send('一覧の名前は承認待ちにして');
  assert(z.c.activePlan().version === 2 && z.gen.calls.length === 2, `R18-3: 統合先の既存コードの指紋が変わった → 流用せず作り直す: ${z.gen.calls.length}`);
});
// ---- R16 / C4: 承認の記録と無効化（版・planHash・基準の stamp・customizeRevision・候補の hash） ----
await section(async () => {
  const x = makeConvC();
  await adoptC(x);
  const v = x.c.activePlan();
  const ap = x.c.approveFinal({ planId: v.planId, version: v.version });
  assert(ap.ok && v.approval && v.approval.planId === v.planId && v.approval.version === 1 && v.approval.planHash === KTAiConversation.planHashOf(v) && v.approval.baseStamp.fingerprint === 'fp-1' && v.approval.customizeRevision === '42' && v.approval.candidates.C1 === v.generated.C1.candidateHash && v.approval.approvedAt, `R16-1: 承認レコード: ${JSON.stringify(v.approval)}`);
  assert(x.c.approvalValid().ok === true && KTAiConversation.approvalValid(v, { baseStamp: { fingerprint: 'fp-1' } }).ok && x.c.messages().some(m => m.data?.kind === 'approved'), 'R16-2: 承認は有効（同じ基準）');
  assert(KTAiConversation.approvalValid(v, { baseStamp: { fingerprint: 'fp-2' } }).reason === 'BASE_CHANGED', 'R16-3: 基準の設定（stamp）が変われば無効');
  const html = finalHtml(x);
  assert(/承認済み。/.test(html) && !/data-act="final-approve"/.test(html), 'R16-4: 承認後のカードは「承認済み」（ボタンは消える）');
  await x.c.send('一覧の名前は承認待ちにして');
  const v2 = x.c.activePlan();
  assert(v2.version === 2 && !v2.approval && x.c.approvalValid().reason === 'NOT_APPROVED' && KTAiConversation.approvalValid(v).reason === 'SUPERSEDED', `R16-5: 新しい版には承認を引き継がない（古い版は置き換わり）: ${x.c.approvalValid().reason}`);
  x.c.approveFinal({ planId: v2.planId, version: v2.version });
  const a2 = JSON.parse(JSON.stringify(v2.approval));
  v2.generated.C1 = { ...v2.generated.C1, candidateHash: 'ffffffffffffffff' };
  assert(KTAiConversation.approvalValid(v2).reason === 'CANDIDATE_CHANGED', 'R16-6: 候補の hash が変わった（再生成）→ 無効');
  v2.generated.C1 = { ...v2.generated.C1, candidateHash: a2.candidates.C1 };
  v2.plan.assessment.summary = '変えた';
  assert(KTAiConversation.approvalValid(v2).reason === 'PLAN_CHANGED', 'R16-7: 計画の中身が変わった → 無効');
  v2.plan.assessment.summary = '承認待ちでは金額を編集不可にします。';
  v2.spec.customizeRevision = '43';
  assert(KTAiConversation.approvalValid(v2).reason === 'REVISION_CHANGED', 'R16-8: customize の revision が変わった → 無効');
  v2.spec.customizeRevision = '42';
  assert(KTAiConversation.approvalValid(v2).ok, '前提: 戻せば有効');
  x.c.markStale('取り直しで設定の違いを見つけました。');
  assert(!v2.approval && x.c.messages().some(m => m.data?.kind === 'approval-revoked') && v2.status === 'STALE', 'R16-9: 動作テスト環境の基準が変わったら承認を外す（markStale）');
});
// ---- R21: 確認済みの範囲を正しく伝える（機械検査 / 必須の動作 / 動作テスト（隔離環境の模擬）/ 実機は未確認） ----
await section(async () => {
  const x = makeConvC();
  await adoptC(x);
  const v = x.c.activePlan(), fin = v.final;
  const html = finalHtml(x), text = stripC(html);
  assert(/機械検査: 生成工程の検査 3 項目・Toolkit の形式確認 \d+ 項目/.test(text) && /業務上の動作の確認ではありません/.test(text) && /必須の動作（1 件）/.test(text) && /✓ 「金額」: 編集できない — 処理あり・動作テストで合格/.test(text) && /動作テスト（隔離環境の模擬・代表条件 1 件）: 合格 1・不合格 0・実行できない 0/.test(text) && /実機は未確認です。/.test(text) && /動作テスト環境で確かめること/.test(text), `R21-1: 検証の区分を分けて出す（機械検査・必須の動作・動作テスト・実機は未確認）: ${(text.match(/検証の区分[\s\S]{0,400}/) || [''])[0]}`);
  assert(!/動作確認済み/.test(html) && !/実機で確認済み/.test(html) && !/検査を通過しています（動作は未確認）/.test(html), 'R21-2: 機械検査の通過を「動作確認済み」「実機で確認済み」とは書かない');
  assert(fin.verification.howTo.length >= 1 && fin.verification.howTo.length <= 4 && fin.verification.howTo.every(s => /動作テスト環境|保存/.test(s)) && v.generated.C1.review.registration.unverified.some(u => u.code === 'BEHAVIOR_VERIFIED' && /実機（動作テスト環境）では未確認/.test(u.message)) && !v.generated.C1.review.registration.unverified.some(u => u.code === 'RUNTIME_NOT_RUN'), `R21-3: 実機で確かめることは 1〜4 行・登録の未確認は「生成工程の動作テストで確認（実機は未確認）」: ${JSON.stringify(fin.verification.howTo)}`);
  assert((html.match(/data-qkey=/g) || []).length === 0, 'R21-4: 利用者に内部の項目を答えさせない（回答欄は残る判断だけ）');
});
// ---- C3b: 待ち時間の体験（偽の時計で経過と段階の遷移・目安の保存と読み戻し・完了後にカードが消える・AI の説明の逐次表示） ----
await section(async () => {
  const storage = makeStorage();
  const pg = gateMk();
  const x = makeConvC({ planGate: pg, storage });
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) await x.c.send(s);
  const p = x.c.send('おすすめで');
  await ticks(6);
  const pm = x.c.progress();
  const lastM = x.last();
  assert(pm && lastM.type === 'LOADING' && lastM.data.kind === 'progress' && pm.title === '最終案を作っています' && pm.stages.map(s => `${s.key}:${s.state}`).join(',') === 'plan:active,summarize:todo', `C3b-1: 進みの 1 枚カード（計画 → まとめ。生成の段階は計画ができてから足す）: ${JSON.stringify(pm && pm.stages.map(s => [s.key, s.state]))}`);
  let html = KTAiChatUi.progressInnerHtml(lastM);
  assert(/最終案を作っています（経過 0:03・目安 約 51 秒）/.test(html) && /● 計画を作成中（経過 3 秒）/.test(html) && /○ まとめ/.test(html) && /見ている設定: ステータス 3 件・通知 0 件・既存の JavaScript 0 ファイル/.test(html) && /質問はいまでも並行して答えます。追加の指示は、できあがった最終案に入れます/.test(html), `C3b-2: 見出し（経過・目安は「約」）・段階の一覧・見ている材料・待っている間にできることの案内: ${html.replace(/<[^>]*>/g, '｜')}`);
  assert(/AI の説明/.test(html) && /kt-ai-streaming/.test(html) && /承認待ちの間だけ金額を/.test(html) && x.calls.plan[0].onText === true, 'C3b-3: 計画の AI の説明（reply）を SSE で先に流す（能力 stream: reply があるとき onText を渡す）');
  x.advance(5000); x.c.tickProgress();
  html = KTAiChatUi.progressInnerHtml(x.last());
  assert(/経過 0:08/.test(html) && /計画を作成中（経過 8 秒）/.test(html) && x.c.messages().filter(m => m.type === 'LOADING').length === 1, `C3b-4: 1 秒ごとの描き直し（偽の時計で 3 秒 → 8 秒）: ${html.replace(/<[^>]*>/g, '｜').slice(0, 120)}`);
  pg.open(); await p; await ticks(8);
  assert(!x.c.messages().some(m => m.type === 'LOADING') && x.c.progress() === null && x.finals().length === 1, 'C3b-5: 完了したら進みのカードは最終案のカードに置き換わり、記録には残らない');
  const saved = JSON.parse(storage.getItem('ktAi.timing.v1'));
  assert(saved && saved.plan && saved.plan.n === 1 && saved.plan.avg === 35000 && saved.generate && saved.generate.avg === 20000 && !saved.sim && saved.summarize, `C3b-6: 段階ごとの実測を目安として保存（計画 35 秒・生成と検証 20 秒。模擬の段階は無い）: ${JSON.stringify(saved)}`);
  const pg2 = gateMk();
  const y = makeConvC({ planGate: pg2, storage });
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) await y.c.send(s);
  const p2 = y.c.send('おすすめで'); await ticks(6);
  assert(/目安 約 36 秒/.test(KTAiChatUi.progressInnerHtml(y.last())), `C3b-7: 2 回目は保存した目安（計画 35 秒 ＋ まとめ）: ${KTAiChatUi.progressInnerHtml(y.last()).replace(/<[^>]*>/g, '｜').slice(0, 80)}`);
  pg2.open(); await p2; await ticks(8);
  const prAfter = JSON.parse(storage.getItem('ktAi.timing.v1'));
  assert(prAfter.plan.n === 2 && prAfter.plan.avg === 32500, `C3b-8: 実測が溜まるほど平均に近づく（件数 2。1 回目 35 秒・2 回目 30 秒 → 平均 32.5 秒）: ${JSON.stringify(prAfter.plan)}`);
  const z = makeConvC({ storage: makeStorage() });
  const gateP = gateMk();
  const propose0 = z.services.propose;
  z.services.propose = async (args) => { const onText = args.onText; if (onText) onText('課長と部長を申請ごとに'); await gateP.p; return propose0({ ...args, onText: null }); };
  const p3 = z.c.send('課長・部長の承認者を選ぶ運用にしたい'); await ticks(4);
  const ph = KTAiChatUi.progressInnerHtml(z.last());
  assert(z.last().type === 'LOADING' && z.last().data.kind === 'progress' && /仮案を考えています（経過 0:00・目安 約 10 秒）/.test(ph) && /● 仮案を考えています（経過/.test(ph) && !/考える中/.test(ph) && /仮案への返事や追加の指示は、仮案ができてから送ってください/.test(ph) && !/最終案に入れます/.test(ph) && /kt-ai-streaming/.test(ph) && /課長と部長を申請ごとに/.test(ph), `C3b-9: 仮案の間も同じ形（目安 約 10 秒・reply の逐次表示）: ${ph.replace(/<[^>]*>/g, '｜').slice(0, 160)}`);
  gateP.open(); await p3; await ticks(4);
  assert(!z.c.messages().some(m => m.type === 'LOADING') && z.c.draft() && z.c.draft().rev === 1, 'C3b-10: 仮案ができたらカードは消える');
  // これから確かめる条件の予告: 生成工程の結果が届く前は必須の効果の一覧（○）、届いたら代表条件ごとの結果（✓ / ×）。最終案の検証の区分にそのまま使う
  const gs = gateMk();
  const w = makeConvC({ generate: makeGenerate({ sequence: ['good'], gate: gs }) });
  const p4 = adoptC(w); await ticks(12);
  const prW = w.c.progress();
  const phW = prW ? KTAiChatUi.progressInnerHtml(w.last()) : '';
  assert(prW && prW.stages.find(s => s.key === 'generate') && prW.stages.find(s => s.key === 'generate').state === 'active' && !prW.stages.some(s => s.key === 'sim') && prW.checklist.length === 1 && prW.checklist.every(c => c.state === 'todo') && /これから確かめる条件（生成工程の動作テスト）/.test(phW) && /○ 「金額」: 編集できない/.test(phW) && /生成・検証しています（生成工程）/.test(phW), `C3b-11: 必須の効果のチェックリストを先に出す（○。模擬の段階は無い）: ${JSON.stringify(prW && prW.checklist)} ${phW.replace(/<[^>]*>/g, '｜').slice(0, 200)}`);
  gs.open(); await p4; await ticks(8);
  const vw = w.c.activePlan();
  assert(vw.final.verification.behavior.cases.length === 1 && vw.final.verification.behavior.cases.every(c => c.verdict === 'pass') && /「金額」: 編集できない/.test(vw.final.verification.behavior.cases[0].label), `C3b-12: 結果が出たら代表条件ごとの結果になり、最終案の検証の区分にそのまま使う: ${JSON.stringify(vw.final.verification.behavior.cases)}`);
  const pgR = { p: Promise.resolve() };
  const rv = makeConvC({ planGate: pgR });
  await adoptC(rv);
  const gR = gateMk(); pgR.p = gR.p;
  const pRv = rv.c.send('一覧の名前は承認待ちにして'); await ticks(6);
  const hR = KTAiChatUi.progressInnerHtml(rv.last());
  assert(rv.c.progress() && rv.c.progress().title === '最終案を直しています' && /● 計画を修正中/.test(hR) && /○ まとめ/.test(hR) && /AI の説明/.test(hR) && /承認待ちの間だけ金額を/.test(hR) && rv.calls.plan[1].revision === true && rv.calls.plan[1].onText === true && rv.c.messages().filter(m => m.type === 'LOADING').length === 1, `C3b-13: 差分更新も進みの 1 枚カード（計画を修正 → まとめ）と AI の説明の逐次表示: ${hR.replace(/<[^>]*>/g, '｜').slice(0, 160)}`);
  gR.open(); await pRv; await ticks(8);
  assert(rv.c.progress() === null && !rv.c.messages().some(m => m.type === 'LOADING') && rv.c.activePlan().version === 2 && rv.finals().length === 2, 'C3b-14: 差分更新の最終案ができたらカードは消える（記録に残さない）');
  const rf = makeConvC({ planImpl: (args) => (args.revision ? { plan: null, message: '計画を作れませんでした（テスト）', reason: 'TEST' } : planJs(args)) });
  await adoptC(rf);
  await rf.c.send('一覧の名前は承認待ちにして');
  assert(rf.c.progress() === null && !rf.c.messages().some(m => m.type === 'LOADING') && rf.c.messages().some(m => m.type === 'ERROR'), 'C3b-15: 差分更新の失敗では進みのカードを片づけ、失敗のカードだけ出す');
});
// ---- 画面: 最終案のカードの［この内容で反映する］→ 承認（偽 client。計画は設定の手順だけ）----
await section(async () => {
  const m = mount();
  await ticks();
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) { await m.panel.send(s); await ticks(8); }
  await m.panel.send('おすすめで'); await ticks(14);
  const v = m.conv().activePlan();
  assert(v && v.final && m.msgs().some(x => x.type === 'FINAL') && /kt-ai-final-card/.test(m.chat()) && !/kt-ai-plan-card/.test(m.chat()) && /data-act="final-approve"/.test(m.chat()), `画面-1: 採用 → 最終案のカード（設定の手順だけの計画でも 1 枚）: ${JSON.stringify(m.msgs().map(x => x.data?.kind || x.type))}`);
  assert(/data-status="ready">未反映</.test(m.$('kt-ai-ws-state').innerHTML) && !m.$('kt-ai-spec').innerHTML.includes('confirm-spec'), '画面-2: 右の見出しは「未反映」。仕様カードに［この仕様で確定］は無い');
  const e0 = await m.panel.startExecutor(); await ticks(2);
  assert(e0 === null && m.msgs().some(x => x.data?.kind === 'approval-required'), `画面-2b: 承認の前は反映の準備をしない: ${JSON.stringify(m.msgs().slice(-1).map(x => [x.data?.kind, x.text]))}`);
  await clickChat(m, 'final-approve', { plan: v.planId, version: String(v.version) }); await ticks(4);
  assert(v.approval && m.conv().approvalValid().ok && /承認済み。/.test(m.chat()) && m.msgs().some(x => x.data?.kind === 'approved'), `画面-3: ［この内容で反映する］→ 承認レコード（右の「反映」から準備へ）: ${JSON.stringify(v.approval && Object.keys(v.approval))}`);
  const e1 = await m.panel.startExecutor(); await ticks(4);
  assert(e1 && e1.status === 'PREPARED' && (e1.steps || []).some(st => st.status === 'PENDING'), `画面-3b: 承認の後は手順が承認済みのまま最終確認へ（手順ごとに承認し直さない）: ${JSON.stringify(e1 && { status: e1.status, steps: (e1.steps || []).map(st => st.status) })}`);
  m.panel.cancelExecutor();
  await m.panel.send('一覧の名前は承認待ちにして'); await ticks(10);
  assert(m.conv().activePlan().version === 2 && !m.conv().activePlan().approval && m.conv().approvalValid().reason === 'NOT_APPROVED', '画面-4: 承認の後に計画が変わったら、新しい版は承認し直し（R16）');
  const n0 = m.msgs().filter(x => x.data?.kind === 'approval-required').length;
  const e2 = await m.panel.startExecutor(); await ticks(2);
  assert(e2 === null && m.msgs().filter(x => x.data?.kind === 'approval-required').length === n0 + 1, '画面-5: 新しい版は承認し直すまで反映の準備をしない');
});

// ---- 段階 C-1 の反証レビュー（指示との一致 A1〜A7・B1〜B7 / 正しさ C1〜C5）の回帰 ----
// 指示 A1 / 追加指示 §4（e）: 採用直後の計画作成中の指示 → 最終案は 1 回だけ（生成も 1 回）。待ちの表示は進みのカード 1 枚
await section(async () => {
  const pg = gateMk();
  const x = makeConvC({ planGate: pg });
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) await x.c.send(s);
  const p = x.c.send('おすすめで'); await ticks(6);
  const rq = await x.c.send('通知は外して');
  const plan0 = x.services.plan;
  let loadingsAtRevise = null, stagesAtRevise = null;
  x.services.plan = async (args) => { if (args.revision) { loadingsAtRevise = x.c.messages().filter(m => m.type === 'LOADING').map(m => m.data?.kind || m.text); stagesAtRevise = x.c.progress() && x.c.progress().stages.map(s => `${s.key}:${s.state}`).join(','); } return plan0(args); };
  pg.open(); await p; await ticks(20);
  const tm = x.c.metrics().timings.slice(-1)[0];
  assert(rq && rq.queued === true && x.finals().length === 1 && x.calls.plan.length === 2 && x.gen.calls.length === 1 && JSON.stringify(loadingsAtRevise) === '["progress"]' && /revise:active/.test(stagesAtRevise || '') && tm.calls.map(k => k.kind).join(',') === 'plan,plan,generate', `指示 A1: 計画作成中の指示 → 指示を入れた計画で最終案を 1 回だけ作る（承認できるカードは 1 枚・待ちの表示は進みのカード 1 枚）: ${JSON.stringify({ finals: x.finals().length, gen: x.gen.calls.length, loadings: loadingsAtRevise, stages: stagesAtRevise, calls: tm.calls.map(k => k.kind) })}`);
  assert(x.c.messages().find(m => m.data?.kind === 'draft-adopted').text === 'この案で進めます。設定の手順と JavaScript を含む最終案を作っています。kintone にはまだ何も反映していません。', '指示 B7: 採用時の文は計画に JavaScript があるときだけ「JavaScript を含む」');
  // 追加指示 §4（e）: 最終案の生成中に 2 つの指示 → 生成は 1 回・最終案は 2 枚（最初の版と、指示をまとめた版）・古い版で新しい版を上書きしない
  const g2 = gateMk();
  const y = makeConvC({ generate: makeGenerate({ sequence: ['good'], gate: g2 }) });
  const py = adoptC(y); await ticks(10);
  await y.c.send('通知は外して'); await y.c.send('一覧の名前は承認待ちにして');
  g2.open(); await py; await ticks(16);
  const vy = y.c.activePlan();
  assert(y.gen.calls.length === 1 && y.finals().length === 2 && vy.version === 2 && y.calls.plan.length === 2 && /通知は外して/.test(y.calls.plan[1].request) && /一覧の名前は承認待ちにして/.test(y.calls.plan[1].request) && y.c.planHistory().filter(v => v.final).length === 2 && y.c.planHistory()[0].status === 'SUPERSEDED', `追加指示 §4（e）: 生成中の 2 つの指示は 1 回の差分更新にまとめ、最終案の重複生成と古い版の上書きをしない: ${JSON.stringify({ gen: y.gen.calls.length, finals: y.finals().length, version: vy.version, plans: y.calls.plan.length })}`);
});
// 指示 A2: Toolkit が生成できない customization（外部連携）は実現できない点・反映先に出し、承認できない
await section(async () => {
  const CUST_EXT = { ...CUST_C1, requirement: '承認されたら Slack に通知する', implementation: 'EXTERNAL_INTEGRATION', apis: ['kintone.proxy'], fields: [{ code: 'ステータス', access: 'READ' }], events: ['app.record.detail.process.proceed'] };
  const x = makeConvC({ planImpl: (args) => { const r = planJs(args, { cust: CUST_EXT, summary: '承認されたら Slack に通知します。' }); r.review.steps[0].codeGeneration = { supported: false, strategy: 'NEW_JS_FILE', reason: '外部連携のコードは Toolkit では生成しません' }; return r; } });
  await adoptC(x);
  const v = x.c.activePlan(), html = stripC(finalHtml(x));
  assert(x.gen.calls.length === 0 && v.final.approvable === false && v.final.cannot.some(c => c.kind === 'unsupported' && /Slack に通知する/.test(c.text) && /外部連携のコードは Toolkit では生成しません/.test(c.text)) && /Toolkit では作れない JavaScript/.test(html) && !/JavaScript は無く、設定の変更だけです/.test(html) && /最終案（反映できない点があります）/.test(html) && x.c.approveFinal({ planId: v.planId, version: v.version }).ok === false, `指示 A2: 生成できない customization を「設定の変更だけ」として承認させない: ${JSON.stringify(v.final.cannot)}`);
});
// 指示 A3: 担当の無い決まった要件が増えたら、JavaScript を流用せずに作り直す（計画の AI が customization を変えなくても）
await section(async () => {
  const x = makeConvC();
  await adoptC(x);
  x.planImpl = (args) => { const r = planJs(args); if (args.revision && /^承認済みでも/.test(args.revision.request)) r.turn = { ...r.turn, requirementOps: [{ op: 'add', target: '金額', condition: '承認済み', behavior: '編集不可にする', exceptions: [], decision: 'decided', disposition: 'adopted', sourceQuotes: ['承認済みでも金額は編集不可にして'], planRefs: [], effects: ['lock'], note: '' }] }; return r; };
  await x.c.send('承認済みでも金額は編集不可にして');
  const v2 = x.c.activePlan();
  // 担当の無い決まった要件 → 自動で 1 回だけ計画の差分更新（担当は付かない）→ その版で作り直す（前の検証結果を流用しない）
  assert(v2.version === 3 && x.calls.plan.length === 3 && x.gen.calls.length === 2 && v2.generated.C1.reused !== true && v2.final.approvable === false && /計画に担当が無いものが 1 件/.test(v2.final.blockingReason), `指示 A3: 担当の無い要件（planRefs が計画に無い）が増えた → 自動の差分更新 1 回の後、全部の JavaScript を作り直す（前の検証結果を流用しない）: ${JSON.stringify({ version: v2.version, plans: x.calls.plan.length, gen: x.gen.calls.length, reused: v2.generated.C1.reused })}`);
  const y = makeConvC();
  await adoptC(y);
  await y.c.send('通知は外して');
  assert(y.gen.calls.length === 1 && y.c.activePlan().generated.C1.reused === true, '指示 A3: 決まっていない指示だけでは作り直さない（R11）');
});
// 指示 A7: 実行できない手順（BLOCKED）があれば承認できない / B6: 残る判断は先に決めたいことだけ
await section(async () => {
  const y = makeConvC({ planImpl: (args) => { const r = planJs(args); r.plan.steps.unshift({ id: 'P1', actionType: 'ADD_FIELD', targetKind: 'FIELD', targetRef: 'x', title: 'フィールド追加', spec: {}, dependsOn: [] }); r.review.steps.unshift({ stepId: 'P1', status: 'INVALID', safety: 'BLOCKED', issues: [{ code: 'X', message: 'フィールドの型が指定されていません' }] }); r.review.executionReadiness = { safeSteps: [], reviewSteps: [], blockedSteps: ['P1'], planOnlySteps: ['C1'] }; return r; } });
  await adoptC(y);
  const vy = y.c.activePlan();
  assert(vy.final.approvable === false && vy.final.blockedSteps.length === 1 && vy.final.cannot.some(c => c.kind === 'blocked' && /実行できない手順: フィールド追加（フィールドの型が指定されていません）/.test(c.text)) && /実行できない設定の手順が 1 件/.test(vy.final.blockingReason), `指示 A7: 実行できない手順があれば承認できない（手順の名前と理由）: ${JSON.stringify(vy.final.cannot)}`);
  const Qs = [{ id: 'Q1', question: '承認待ちの間、申請者本人も編集できなくしますか', topic: 'scope', priority: 'blocking', options: ['全員', '申請者以外'] }, ...['灰色の表示色は既定のままでよいですか', 'モバイルでも同じ制御にしますか', 'CSV 読み込みでも止めますか', '一覧の編集でも止めますか'].map((q, i) => ({ id: `Q${i + 2}`, question: q, topic: `t${i}`, priority: 'later', options: [] }))];
  const x = makeConvC({ planImpl: (args) => planJs(args, { questions: Qs }) });
  await adoptC(x);
  const html = finalHtml(x);
  assert((html.match(/kt-ai-qa-input/g) || []).length === 1 && /残る判断（1 件）/.test(html) && /後で決めてよいことが 4 件あります/.test(html) && !/モバイルでも同じ制御にしますか/.test(html), `指示 B6: 最終案のカードの回答欄は先に決めたいことだけ: ${(stripC(html).match(/残る判断[^\n]*/) || [])[0]}`);
});
// 指示 B1 / B2 / 追加指示 §4（f）: 最終案までの時間は採用から（内訳より短くならない）。測っていない段階は 0 秒と出さない
await section(async () => {
  const storage = makeStorage();
  const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], repairs: 1 }), storage });
  await adoptC(x);
  const tmg = x.c.activePlan().final.timing;
  assert(tmg.totalMs >= tmg.planMs + tmg.generateMs && tmg.totalMs === x.c.metrics().timings.slice(-1)[0].finalMs, `指示 B1: 最終案までの時間 ≧ 内訳の合計（採用から。finalMs と同じ起点）: ${JSON.stringify(tmg)}`);
  const saved = JSON.parse(storage.getItem('ktAi.timing.v1'));
  assert(saved.generate.n === 1 && saved.generate.avg === 20000 && !saved.sim, `指示 B2: 生成と検証の目安は 1 件 1 回: ${JSON.stringify(saved)}`);
  // 生成が無い最終案（設定の手順だけ・生成できない）: 生成の時間は「0 秒」と出さない
  const CUST_EXT = { ...CUST_C1, implementation: 'EXTERNAL_INTEGRATION', fields: [{ code: 'ステータス', access: 'READ' }] };
  const y = makeConvC({ planImpl: (args) => { const r = planJs(args, { cust: CUST_EXT }); r.review.steps[0].codeGeneration = { supported: false, strategy: 'NEW_JS_FILE', reason: '外部連携のコードは Toolkit では生成しません' }; return r; } });
  await adoptC(y);
  const ty = y.c.activePlan().final.timing, hy = stripC(finalHtml(y));
  assert(ty.generateMs === null && ty.planMs === 30000 && /最終案まで 30 秒（計画 30 秒）/.test(hy) && !/生成・検証 0 秒|模擬 0 秒|生成 0 秒/.test(hy), `追加指示 §4（f）: 測っていない段階（生成）は 0 秒と出さない: ${JSON.stringify(ty)} ${(hy.match(/最終案まで[^\n]*/) || [''])[0]}`);
});
// 指示 B4: 生成に失敗したときのカード / B7: 「まだ何も反映していません」は 1 回・トークン・保存の行
await section(async () => {
  const x = makeConvC({ generate: { calls: [], impl: async () => ({ ok: false, reason: 'UPSTREAM_ERROR', message: 'AI の応答を取得できませんでした（UPSTREAM_ERROR）' }) } });
  await adoptC(x);
  const h = stripC(finalHtml(x));
  assert(/最終案（反映できない点があります）/.test(h) && !/最終案ができました。/.test(h) && !/新しい JavaScript「」/.test(h) && /生成できなかったため、ファイルはまだありません/.test(h) && /機械検査: 実行できませんでした/.test(h) && !/検査 0 項目/.test(h), `指示 B4: 生成の失敗 → 見出しを分ける・ファイル名が空の行を出さない・検査 0 項目と言わない: ${h.replace(/\n+/g, ' ⏎ ').slice(0, 400)}`);
  const y = makeConvC();
  await adoptC(y);
  const hy = finalHtml(y);
  assert((hy.match(/まだ何も反映していません/g) || []).length === 1 && !/token/.test(hy) && !y.c.activePlan().final.verification.howTo.some(s => /保存/.test(s)), `指示 B7: 「まだ何も反映していません」は 1 回・英語の token を出さない・編集制限の JavaScript では保存の確認の行を出さない: ${JSON.stringify(y.c.activePlan().final.verification.howTo)}`);
});
// 指示 B5: 対応範囲の重複と矛盾（担当が計画に無い要件は 1 行・「ほかの手順で扱います」と言わない）
await section(async () => {
  const gen = makeGenerate({ sequence: ['good'] });
  const impl0 = gen.impl;
  gen.impl = async (args) => { const r = await impl0(args); r.generated = { ...r.generated, coverage: [{ requirementId: 'C1', status: 'MET', note: '', text: CUST_C1.requirement }, { requirementId: 'R4', status: 'OUT_OF_SCOPE', note: '期限はプロセス管理と通知の設定で扱う', text: '7 営業日以内に承認する' }] }; r.review = KTCodeReview.review({ generated: r.generated, customization: CUST_C1, plan: args.version.plan, data: clone(DATA_C), scan: null, existingSource: null, requirements: [{ id: 'R4', planRefs: ['A3'] }] }); return r; };
  const x = makeConvC({ generate: gen });
  await adoptC(x);
  const h = stripC(finalHtml(x));
  assert((h.match(/7 営業日以内に承認する/g) || []).length === 1 && /担当が計画にありません（計画全体の確認に残します）: 7 営業日以内に承認する/.test(h) && !/計画の他の手順・JavaScript で扱います/.test(h), `指示 B5: 担当の無い要件は 1 行で「担当が計画にありません」: ${JSON.stringify(x.c.activePlan().final.outOfScope)}`);
});
// 正しさ C4 / C3（会話）: 計画の後に基準が変わったら承認せず STALE に（作り直しを案内）。承認の取り消し
await section(async () => {
  const x = makeConvC();
  await adoptC(x);
  const v = x.c.activePlan();
  const r = x.c.approveFinal({ planId: v.planId, version: v.version, baseStamp: { fingerprint: 'fp-2' } });
  assert(r.ok === false && r.reason === 'BASE_CHANGED' && !v.approval && v.status === 'STALE' && /作り直してください/.test(r.message) && x.c.messages().some(m => m.data?.kind === 'stale'), `正しさ C4: 計画を作った後に基準が変わった → 承認せず計画を STALE にして作り直しを案内: ${JSON.stringify(r)}`);
  const y = makeConvC();
  await adoptC(y);
  const vy = y.c.activePlan();
  const ok = y.c.approveFinal({ planId: vy.planId, version: vy.version, baseStamp: { fingerprint: 'fp-1' } });
  assert(ok.ok && vy.approval.baseStamp.fingerprint === 'fp-1' && Array.isArray(vy.approval.confirmations.C1), '正しさ C2: 承認に、そのときの確認の項目（customization ごと）を記録する');
  assert(KTAiConversation.approvalValid(vy, { baseStamp: { revision: '10' } }).reason === 'BASE_UNKNOWN', '指示 C2: 承認に基準の指紋があるのに今の指紋が取れなければ、照合を黙って飛ばさない');
  assert(y.c.revokeApproval(vy, '設定の手順が途中で止まりました。') === true && !vy.approval && y.c.messages().some(m => m.data?.kind === 'approval-revoked'), '正しさ C3: 承認の取り消し（設定の手順が止まったとき画面が呼ぶ）');
});
// 正しさ C5: 同じ platform の他の既存 JS・設定・計画の新設（動作テストの環境の指紋）が変われば流用しない
await section(async () => {
  const z = makeConvC();
  let env = 'env-1';
  z.services.simEnvKey = async () => env;
  await adoptC(z);
  await z.c.send('一覧の名前は承認待ちにして');
  assert(z.gen.calls.length === 1 && z.c.activePlan().generated.C1.reused === true, '前提: 環境の指紋が同じなら流用する');
  env = 'env-2';
  await z.c.send('一覧の並びは申請日の順にして');
  assert(z.gen.calls.length === 2 && z.c.activePlan().generated.C1.reused !== true, `正しさ C5: 環境の指紋が変わった → 流用せず作り直して検証し直す: ${z.gen.calls.length}`);
});
// 正しさ C3（画面）: 設定の手順が途中で止まったら、承認の基準を進めず承認を外す
await section(async () => {
  const m = mount();
  await ticks();
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) { await m.panel.send(s); await ticks(8); }
  await m.panel.send('おすすめで'); await ticks(14);
  const v = m.conv().activePlan();
  await clickChat(m, 'final-approve', { plan: v.planId, version: String(v.version) }); await ticks(4);
  const e1 = await m.panel.startExecutor(); await ticks(4);
  m.mock.ctl.failPut = 'views';
  await m.panel.confirmExecutor(); await ticks(8);
  assert(v.approval === undefined && m.msgs().some(x => x.data?.kind === 'approval-revoked') && e1 && e1.status === 'PREPARED', `正しさ C3: 設定の手順が止まったら承認を外す: ${JSON.stringify({ approval: !!v.approval, kinds: m.msgs().slice(-4).map(x => x.data?.kind || x.type) })}`);
});
// 指示 B7: 未解決のカードにコード片・フィールドコード・「候補」を出さない（生成工程の修復の上限で止まった最終案）。検査の文は詳細表示に
await section(async () => {
  const y = makeConvC({ generate: makeGenerate({ sequence: ['bad'], repairs: 2, stoppedBy: 'limit' }) });
  await adoptC(y);
  const full = finalHtml(y);
  const h = outsideDetails(full).replace(/<[^>]*>/g, '｜');
  assert(y.c.activePlan().final.approvable === false && !/record\[|\.disabled\s*=|（（/.test(h) && !/「amount」|\bamount\b/.test(h) && !/候補/.test(h) && /取り消/.test(full), `指示 B7: 未解決の理由・機械検査の行にコード片とフィールドコードを出さない（検査の文は詳細表示）: ${(h.match(/[^｜]*(record\[|amount|候補)[^｜]*/) || [''])[0]}`);
});

// =========================================================
console.log('\n--- §D. 段階 C-1 への追加指示（2026-10-08）§5 の回帰: 編集不可・警告・保存禁止を区別して引き継ぎ、未確認と不合格を混同しない ---');
const effectsSent = (x, n = 0) => (x.gen.calls[n] && x.gen.calls[n].requiredEffects ? [...new Set(x.gen.calls[n].requiredEffects.map(e => `${e.field}:${e.effect}`))].sort().join(',') : null);
// D1: 編集不可が必要、候補は警告だけ → 要件未達。承認・反映可能な最終案にしない（必須の効果は lock のまま渡し、警告に下げない）
await section(async () => {
  const x = makeConvC({ generate: makeGenerate({ sequence: ['warn'], repairs: 2, stoppedBy: 'limit' }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  assert(effectsSent(x) === 'amount:lock' && e.status === 'unresolved' && e.verdict.kind === 'missing' && /要件未達（「金額」: 編集できないようにする）/.test(e.verdict.reason), `D1-1: 編集不可が必要で候補は警告だけ → 要件未達（必須の効果は lock のまま）: ${JSON.stringify({ sent: effectsSent(x), verdict: e.verdict })}`);
  const ap = x.c.approveFinal({ planId: v.planId, version: v.version });
  assert(v.final.approvable === false && ap.ok === false && ap.reason === 'NOT_APPROVABLE' && !v.approval && x.gen.calls.length === 1, `D1-2: 承認できない（Toolkit から修復の再依頼もしない）: ${JSON.stringify(ap)}`);
  assert(e.review.status === 'BLOCKED' && e.review.registration.blockers.some(b => b.code === 'required-effects') && !e.review.registration.confirmations.some(c => c.code === 'required-effects'), 'D1-3: 形式確認でも登録不可（required-effects は「確認」ではない。確認を押して通せない）');
  const text = stripC(finalHtml(x));
  assert(/× 「金額」: 編集できない — 処理なし（要件未達）/.test(text) && /disabled>この内容で反映する/.test(finalHtml(x)), `D1-4: 検証の区分に必須の動作の未達を出す: ${(text.match(/必須の動作[\s\S]{0,120}/) || [''])[0]}`);
});
// D2: 編集不可が必要、候補は値の変更だけ → 要件未達（編集不可と同一視しない）
await section(async () => {
  const x = makeConvC({ generate: makeGenerate({ sequence: ['value'] }) });
  await adoptC(x);
  const e = x.c.activePlan().generated.C1;
  assert(effectsSent(x) === 'amount:lock' && e.status === 'unresolved' && e.verdict.kind === 'missing' && x.c.activePlan().final.approvable === false, `D2: 編集不可が必要で候補は値の変更だけ → 要件未達: ${JSON.stringify(e.verdict)}`);
});
// D3: 警告だけ必要、候補は警告を出し編集・保存を許可 → この要件について合格。編集不可を追加要求しない（BFC / p21 の警告の回帰を警告の要件として維持）
await section(async () => {
  const CUST_W = { ...clone(RP.CUSTOMIZATION), fields: [{ code: 'amount', access: 'CONTROL', condition: RP.CUSTOMIZATION.fields[0].condition, effects: ['warn'] }] };
  const existing = { name: 'dealLock.js', target: 'desktop', text: RP.DEAL_LOCK };
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_W, summary: '金額が 100 万円を超えたら警告します（保存は止めません）。' }), generate: makeGenerate({ sequence: ['warn'], existingSource: existing, generatedOf: () => clone(RP.GENERATED) }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  assert(effectsSent(x) === 'amount:warn' && !x.gen.calls[0].requiredEffects.some(r => r.effect === 'lock'), `D3-1: 警告の要件は warn だけを渡す（編集不可を足さない）: ${effectsSent(x)}`);
  assert(e.status === 'verified' && v.final.approvable === true && e.review.status !== 'BLOCKED' && !e.review.checks.some(ch => /^sim-warning-only/.test(ch.name)), `D3-2: 警告を出し編集・保存を許可する候補は合格（承認できる）: ${JSON.stringify({ status: e.status, verdict: e.verdict, review: e.review.status, blocks: e.review.checks.filter(ch => !ch.ok && ch.severity === 'block').map(ch => ch.name) })}`);
  assert(v.final.verification.howTo.some(s => /保存/.test(s)), 'D3-3: 警告の要件では「保存は止まらない」ことを実機で確かめる行を出す（構造化した効果から）');
});
// D4: 保存禁止が必要、候補は画面の編集禁止だけ → 保存禁止を別に検証して要件未達（画面制御だけで代用しない）
await section(async () => {
  const CUST_S = custOf(['block-save'], { requirement: '承認待ちでは保存できないようにする', events: ['app.record.edit.show', 'app.record.edit.submit'] });
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_S }), generate: makeGenerate({ sequence: ['lockonly'] }) });
  await adoptC(x);
  const e = x.c.activePlan().generated.C1;
  assert(effectsSent(x) === 'amount:block-save' && e.status === 'unresolved' && e.verdict.kind === 'missing' && /保存を止める/.test(e.verdict.reason) && x.c.activePlan().final.approvable === false, `D4: 保存禁止の要件は block-save として渡し、編集禁止だけの候補は要件未達: ${JSON.stringify({ sent: effectsSent(x), verdict: e.verdict })}`);
});
// D5: 編集不可と保存禁止が両方必要 → 両方の期待を保持し、それぞれ検証する
await section(async () => {
  const CUST_B = custOf(['lock', 'block-save'], { requirement: '承認待ちでは編集も保存もできないようにする', events: ['app.record.edit.show', 'app.record.edit.submit'] });
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_B }), generate: makeGenerate({ sequence: ['lockonly'] }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1, rows = v.final.verification.effects;
  assert(effectsSent(x) === 'amount:block-save,amount:lock' && rows.length === 2 && rows.find(r => r.effect === 'lock').structure === 'present' && rows.find(r => r.effect === 'lock').behavior === 'pass' && rows.find(r => r.effect === 'block-save').structure === 'missing' && e.status === 'unresolved' && v.final.approvable === false, `D5-1: 両方を渡し、編集不可は合格・保存禁止は未達として別々に判定: ${JSON.stringify({ sent: effectsSent(x), rows })}`);
  const y = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_B }), generate: makeGenerate({ sequence: ['locksave'] }) });
  await adoptC(y);
  const vy = y.c.activePlan();
  assert(vy.generated.C1.status === 'verified' && vy.final.approvable === true && vy.final.verification.behavior.cases.length === 2 && vy.final.verification.behavior.cases.every(c => c.verdict === 'pass'), `D5-2: 両方の処理がある候補は、両方の代表条件で合格して承認できる: ${JSON.stringify(vy.final.verification.behavior)}`);
});
// D6: 判定に必要な内部情報が欠けている（旧い計画: CONTROL で effects 無し）→ 台帳の要件の効果から補う。補えなければ準備未完了（利用者に聞かない）
await section(async () => {
  const OLD = custOf(null);
  const op = { op: 'add', target: '金額', condition: '承認待ち', behavior: '編集できないようにする', exceptions: [], decision: 'proposed', disposition: 'adopted', sourceQuotes: [], planRefs: ['C1'], effects: ['lock'], note: '' };
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: OLD, requirementOps: args.revision ? [] : [op] }) });
  await adoptC(x);
  const v = x.c.activePlan();
  assert(effectsSent(x) === 'amount:lock' && x.gen.calls[0].requiredEffects.some(r => /^R\d+$/.test(r.requirementId)) && v.generated.C1.status === 'verified' && v.final.approvable === true, `D6-1: 計画の効果が無い（旧形式）→ 台帳の要件の効果（lock）で補って渡す: ${JSON.stringify(x.gen.calls[0] && x.gen.calls[0].requiredEffects)}`);
  const y = makeConvC({ planImpl: (args) => planJs(args, { cust: OLD }) });
  await adoptC(y);
  const vy = y.c.activePlan();
  const asksBefore = y.calls.ask.length, proposesBefore = y.calls.propose.length;
  assert(y.gen.calls.length === 0 && vy.generated.C1.status === 'not-ready' && /必須の動作を特定できません（「金額」で/.test(vy.generated.C1.verdict.reason) && vy.final.approvable === false && /必要な動作.*特定できない/.test(vy.final.blockingReason) && y.calls.ask.length === asksBefore && y.calls.propose.length === proposesBefore && !(vy.openQuestions || []).length, `D6-2: 補えなければ生成を呼ばずに準備未完了（同じ要望を利用者に聞き直さない）: ${JSON.stringify({ gen: y.gen.calls.length, verdict: vy.generated.C1.verdict, reason: vy.final.blockingReason })}`);
  // 純関数: 対象のフィールドが特定できる要件はそのフィールドだけ・計画の効果が要件より弱いときは要件の効果も必須に足す（警告で編集不可を満たしたことにしない）
  const plan2 = { customizations: [{ customizationId: 'C1', events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', effects: ['warn'] }, { code: 'memo', access: 'CONTROL' }] }] };
  const r2 = KTAiConversation.requiredEffectsOf(plan2, 'C1', [{ id: 'R1', target: '金額', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects: ['lock'] }, { id: 'R2', target: '備考', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects: ['show-hide'] }], { labels: LABELS_C });
  assert(JSON.stringify(r2.effects.map(e => `${e.requirementId}:${e.field}:${e.effect}`).sort()) === JSON.stringify(['C1:amount:warn', 'C1:memo:show-hide', 'R1:amount:lock', 'R2:memo:show-hide']) && r2.unresolved.length === 0, `D6-3: 要件の効果は計画より弱めない・対象のフィールドで補う: ${JSON.stringify(r2)}`);
  const r3 = KTAiConversation.requiredEffectsOf({ customizations: [{ customizationId: 'C1', events: [], fields: [{ code: 'amount', access: 'WRITE' }, { code: 'memo', access: 'CONTROL' }] }] }, 'C1', []);
  assert(JSON.stringify(r3) === JSON.stringify({ effects: [{ requirementId: 'C1', field: 'amount', effect: 'set-value', events: [], condition: '' }], unresolved: [{ field: 'memo' }] }), `D6-4: 互換（WRITE → set-value）と未特定（CONTROL で効果も台帳も無い）: ${JSON.stringify(r3)}`);
});
// D7: 検査環境の制約で実行できない → コード不合格にも合格にも読み替えず、無駄な修復を呼ばない（準備未完了の理由は環境）
await section(async () => {
  const x = makeConvC({ generate: makeGenerate({ sequence: ['good'], env: 'timeout' }) });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  assert(x.gen.calls.length === 1 && !x.gen.calls[0].feedback && e.status === 'not-run' && e.verdict.kind === 'environment' && /動作テストを実行できませんでした（環境: 時間内に終わりませんでした）/.test(e.verdict.reason) && /誤りとは判定していません/.test(e.verdict.reason) && !/要件未達/.test(e.verdict.reason), `D7-1: not-run → 環境の理由で準備未完了（修復は呼ばない・不合格と言わない）: ${JSON.stringify({ calls: x.gen.calls.length, verdict: e.verdict })}`);
  assert(v.final.approvable === false && /環境の制約です/.test(v.final.blockingReason) && x.c.approveFinal({ planId: v.planId, version: v.version }).ok === false, `D7-2: 未確認を合格に読み替えない（承認できない）: ${v.final.blockingReason}`);
  const nr = e.review.checks.find(ch => ch.name === 'behavior-not-run');
  assert(nr && nr.severity === 'block' && nr.noRepair === true && nr.environment === true && e.review.checks.find(ch => ch.name === 'required-effects').ok === true, `D7-3: 形式確認の取り込み: 必須の効果の処理はあり、動作テストは環境で未実行（修復の対象にしない印）: ${JSON.stringify(nr)}`);
  const text = stripC(finalHtml(x));
  assert(/動作テスト（隔離環境の模擬・代表条件 1 件）: 合格 0・不合格 0・実行できない 1（環境: 時間内に終わりませんでした）/.test(text) && /未確認 「金額」: 編集できない — 処理あり・動作テストを実行できません（環境）/.test(text), `D7-4: カードは「実行できない（環境）」として出す: ${(text.match(/必須の動作[\s\S]{0,200}/) || [''])[0]}`);
  // 動作テストは passed だが必須の効果の代表条件が無い → 未確認（合格に読み替えない）
  const y = makeConvC({ generate: makeGenerate({ sequence: ['good'], dropCaseFor: 'amount|lock' }) });
  await adoptC(y);
  assert(y.c.activePlan().generated.C1.status === 'unverified' && y.c.activePlan().final.approvable === false, `D7-5: 必須の効果に代表条件が無い → 未確認で準備未完了: ${JSON.stringify(y.c.activePlan().generated.C1.verdict)}`);
});
// D8: 基準取得失敗・古い候補・機能非対応 → 照合の省略や旧承認の流用で反映できない
await section(async () => {
  const x = makeConvC();
  await adoptC(x);
  const v = x.c.activePlan();
  const r0 = x.c.approveFinal({ planId: v.planId, version: v.version, baseStamp: null });
  assert(r0.ok === false && r0.reason === 'BASE_UNKNOWN' && !v.approval, `D8-1: 基準を取得できない（null）→ 照合を飛ばさず承認しない: ${JSON.stringify(r0)}`);
  const r1 = x.c.approveFinal({ planId: v.planId, version: v.version, baseStamp: { revision: '10' } });
  assert(r1.ok === false && r1.reason === 'BASE_UNKNOWN', 'D8-2: 基準の指紋が無い → 承認しない');
  x.c.approveFinal({ planId: v.planId, version: v.version, baseStamp: { fingerprint: 'fp-1' } });
  assert(KTAiConversation.approvalValid(v, { baseStamp: null }).reason === 'BASE_UNKNOWN' && KTAiConversation.approvalValid(v, { baseStamp: { fingerprint: 'fp-1' } }).ok, 'D8-3: 反映の直前に基準が取れない（null）→ BASE_UNKNOWN（以前は undefined で照合を飛ばした）');
  const noFp = { ...v, approval: { ...v.approval, baseStamp: null } };
  assert(KTAiConversation.approvalValid(noFp, { baseStamp: { fingerprint: 'fp-1' } }).reason === 'BASE_UNKNOWN', 'D8-4: 承認に基準の指紋が無いのに照合を飛ばさない');
  const oldHash = v.generated.C1.candidateHash;
  v.generated.C1 = { ...v.generated.C1, candidateHash: 'eeeeeeeeeeeeeeee' };
  assert(KTAiConversation.approvalValid(v, { baseStamp: { fingerprint: 'fp-1' } }).reason === 'CANDIDATE_CHANGED', 'D8-5: 古い候補（承認の後に候補が変わった）→ 旧承認を流用しない');
  v.generated.C1 = { ...v.generated.C1, candidateHash: oldHash };
  // 機能非対応（requiredEffects・behavior を返さない旧い接続先）: 既知の競合を「確認」に下げず、反映できる最終案にしない
  const y = makeConvC({ supported: false, generate: makeGenerate({ sequence: ['bad'], supported: false }) });
  await adoptC(y);
  const vy = y.c.activePlan(), ey = vy.generated.C1;
  assert(y.gen.calls.length === 1 && ey.status === 'unsupported' && vy.final.approvable === false && /接続先（生成工程）が必須の動作の確認に対応していない/.test(vy.final.blockingReason) && ey.review.status === 'BLOCKED' && ey.review.checks.some(ch => ch.name === 'error-cancels-edit' && ch.severity === 'block'), `D8-6: 機能非対応 → 準備未完了・既知の競合（error-cancels-edit）は登録不可のまま: ${JSON.stringify({ status: ey.status, checks: ey.review.checks.filter(ch => !ch.ok).map(ch => `${ch.name}/${ch.severity}`) })}`);
  // HEAD で登録不可だった 4 通りは、動作テストの結果が無い・実行できない・旧い接続先のどれでも登録不可のまま（合格のときだけ確認に下げる）
  const EDIT = ['app.record.edit.show'];
  const LOCK = `    if (${ST_C}) record['amount'].disabled = true;`;
  const H4 = (body) => `(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(EDIT)}, function (event) {\n    const record = event.record;\n${body}\n    return event;\n  });\n})();`;
  const four = {
    'same-handler-unconditional-error': H4(`${LOCK}\n    record['amount'].error = '注意';`),
    'same-condition-both': H4(`    if (${ST_C}) { record['amount'].disabled = true; record['amount'].error = '承認待ち'; }`),
    'two-handlers-same-file': `(function(){ 'use strict'; kintone.events.on(${JSON.stringify(EDIT)}, function(event){ const record = event.record; ${LOCK.trim()} return event; }); kintone.events.on(${JSON.stringify(EDIT)}, function(event){ event.record['amount'].error = '注意'; return event; }); })();`,
    'record-level-event-error': H4(`${LOCK}\n    if (${ST_C}) event.error = '承認待ちです';`),
  };
  const REQ = [{ requirementId: 'C1', field: 'amount', effect: 'lock', events: EDIT, condition: '' }];
  const verOf = (mode) => (mode === 'legacy' ? { version: '0', legacy: true, machine: [] } : mode === 'not-run' ? { requiredEffects: [{ requirementId: 'C1', field: 'amount', effect: 'lock', status: 'present' }], behavior: { status: 'not-run', reason: 'unavailable', cases: [] } } : { requiredEffects: [{ requirementId: 'C1', field: 'amount', effect: 'lock', status: 'present' }] });
  const out = [];
  for (const [k, code] of Object.entries(four)) {
    const g = { strategy: 'NEW_JS_FILE', targetFile: 'lock.js', summary: 's', code, patch: null, events: EDIT, fields: [{ code: 'amount', access: 'CONTROL' }], apis: [] };
    const rv = KTCodeReview.review({ generated: g, customization: CUST_C1, plan: null, data: clone(DATA_C), scan: null, existingSource: null });
    for (const mode of ['none', 'legacy', 'not-run', 'no-behavior']) {
      const merged = mode === 'none' ? rv : KTCodeReview.attachBehavior(rv, verOf(mode), { requiredEffects: REQ, customization: CUST_C1 });
      out.push([k, mode, merged.registration.verdict]);
    }
  }
  assert(out.every(r => r[2] === 'BLOCKED'), `D8-7: HEAD で登録不可の 4 通りは、動作テストの結果が無い・実行できない・旧い接続先で確認に下がらない: ${JSON.stringify(out.filter(r => r[2] !== 'BLOCKED'))}`);
});
// D9: 採用済み要件に担当が無い → 最終案から消さず、自動で 1 回だけ計画の差分更新（その要件を focus に）に戻す
await section(async () => {
  const OWN = { op: 'add', target: '承認', condition: '', behavior: '7 営業日以内に承認する', exceptions: [], decision: 'decided', disposition: 'unresolved', sourceQuotes: ['7営業日で'], planRefs: [], effects: [], note: '' };
  // (a) 差分更新で担当（C1）が付く → 承認できる最終案 1 つ
  let hold = null;
  const ridNow = () => { const vv = hold && hold.c.activePlan(); return vv ? (hold.c.requirements(vv.planId).find(r => r.behavior === OWN.behavior) || {}).id : null; };
  const x = makeConvC({ planImpl: (args) => planJs(args, { gatewayPlan: { plan: true }, requirementOps: args.revision ? [{ ...OWN, op: 'update', id: ridNow(), planRefs: ['C1'], disposition: 'adopted' }] : [OWN] }) });
  hold = x;
  await adoptC(x);
  const v = x.c.activePlan();
  const rid = (x.c.requirements(v.planId).find(r => r.behavior === '7 営業日以内に承認する') || {}).id;
  assert(rid && x.calls.plan.length === 2 && x.calls.plan[1].revision && x.calls.plan[1].focus && x.calls.plan[1].focus.includes(rid) && /計画の担当（設定の手順か JavaScript）がありません/.test(x.calls.plan[1].request) && /7営業日で/.test(x.calls.plan[1].request), `D9-1: 担当の無い決まった要件（扱い未定の unresolved も）→ 自動で計画の差分更新（その要件を focus に）: ${JSON.stringify(x.calls.plan.map(p => ({ rev: p.revision, focus: p.focus })))}`);
  assert(x.finals().length === 1 && v.version === 2 && v.final.approvable === true && x.gen.calls.length === 1, `D9-2: 担当が付いた版で最終案を 1 回だけ作る（前の版の最終案は作らない）: ${JSON.stringify({ finals: x.finals().length, version: v.version, gen: x.gen.calls.length, reason: v.final.blockingReason })}`);
  // (b) 差分更新でも担当が付かない → 最終案に「担当が計画にありません」として出し準備未完了（自動の依頼は 1 回だけ）
  const y = makeConvC({ planImpl: (args) => planJs(args, { gatewayPlan: { plan: true }, requirementOps: args.revision ? [] : [OWN] }) });
  await adoptC(y);
  const vy = y.c.activePlan();
  const hy = stripC(finalHtml(y));
  assert(y.calls.plan.length === 2 && y.finals().length === 1 && vy.final.approvable === false && /計画に担当が無いものが 1 件/.test(vy.final.blockingReason) && /担当が計画にありません（計画全体の確認に残します）: 7営業日で/.test(hy), `D9-3: それでも担当が無ければ最終案から消さずに理由を出す（自動の差分更新は 1 回だけ）: ${JSON.stringify({ plans: y.calls.plan.length, finals: y.finals().length, reason: vy.final.blockingReason })}`);
  const ap = y.c.approveFinal({ planId: vy.planId, version: vy.version });
  assert(ap.ok === false && ap.reason === 'NOT_APPROVABLE', 'D9-4: 担当の無い決まった要件が残る最終案は承認できない');
});

// D10（画面）: 偽 client（health の customization-generator.verification に requiredEffects）で、Generator Context に必須の効果と既存 JS の本文（伏字）を渡し、
//   代表条件は送らない。生成工程の結果で最終案 → 承認 → 登録の準備（登録前の再検査は生成工程の結果の取り込み。Toolkit は模擬を実行しない）。
//   基準の取得に失敗したら、承認を流用して登録の準備に進まない（BASE_UNKNOWN）。動作テストが環境で実行できなければ承認できない
const { makeEnvGetter } = require('./helpers/dev-base-fake.js');
await section(async () => {
  const HEALTH_V = clone(HEALTH);
  HEALTH_V.registry.toolkit['customization-generator'].verification = ['requirementId', 'feedback', 'requiredEffects'];
  const CUST_S = { customizationId: 'C1', requirement: '承認待ちでは案件名を編集できないようにする', whyStandardInsufficient: 'ステータスで切り替えるアクセス権は無い', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'case_name', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', effects: ['lock'] }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [] };
  const planResp = (goal) => { const b = PLAN_V1(goal); return { ...b, plan: { ...b.plan, solution: 'CUSTOMIZATION', assessment: { ...b.plan.assessment, summary: '承認待ちでは案件名を編集できないようにします。' }, steps: [mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { title: 'JavaScript', solution: 'CUSTOMIZATION' })], customizations: [CUST_S] } }; };
  const CODE_S = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認待ち') record['case_name'].disabled = true;\n    return event;\n  });\n})();";
  const run = async ({ env = null, baseFailAfterApprove = false } = {}) => {
    const genCtx = [];
    let baseFail = false;
    const loadDevBase = async () => { if (baseFail) return { ok: false, status: 'FETCH_FAILED', message: '動作テスト環境の設定を取得できませんでした（テスト）', loadedAt: '2026-10-08T00:00:00.000Z', errors: [] }; const FXF = require('./fixtures/ai-context-app.js').files; const g = makeEnvGetter({ preview: clone(INPUTS.data), production: clone(INPUTS.data), files: { '20261001000000AAAA': FXF[0].text, '20261001000000BBBB': FXF[1].text, '20261001000000DDDD': FXF[2].text } }); return T.KTDevBase.load({ appId: '341', getImpl: g.getImpl, download: g.download, now: () => new Date('2026-10-08T00:00:00Z') }); };
    const generateImpl = async ({ ctx, requestId }) => {
      genCtx.push(clone(ctx));
      const req = (ctx.verification && ctx.verification.requiredEffects) || [];
      const candidateHash = KTJsSim.candidateHashOf({ strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', code: CODE_S, customizationId: 'C1' });
      const resp = { ok: true, contractVersion: '2.1', meta: { requestId, gateway: { product: 'toolkit', feature: 'customization-generator', promptVersion: '1', contextVersion: 'customization-1' }, normalization: { warnings: [] }, ai: { model: 'm' } }, generated: { strategy: 'NEW_JS_FILE', targetFile: 'caseLock.js', summary: '承認待ちでは案件名を編集できないようにします。', code: CODE_S, patch: null, events: ['app.record.edit.show'], fields: [{ code: 'case_name', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '' }] }, verification: fakeVerification({ code: CODE_S, has: { case_name: ['lock'] } }, req, { env, candidateHash }) };
      const v = KTAiClient.validateGenerated(resp, ctx);
      if (!v.ok) throw new Error(JSON.stringify(v.errors));
      return { ...v.normalized, requestId };
    };
    const m = mount({ health: HEALTH_V, planImpl: ({ ctx, requestId }) => { const v = KTAiClient.validatePlan(planResp(ctx.goal), ctx); if (!v.ok) throw new Error(JSON.stringify(v.errors)); return { ...v.normalized, requestId, clientWarnings: v.warnings }; }, generateImpl, extra: { loadDevBase } });
    await ticks();
    for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) { await m.panel.send(s); await ticks(8); }
    await m.panel.send('おすすめで'); await ticks(20);
    return { m, genCtx, setBaseFail: (b) => { baseFail = b; } };
  };
  const { m, genCtx, setBaseFail } = await run();
  const v = m.conv().activePlan();
  const vf = genCtx[0] && genCtx[0].verification;
  assert(genCtx.length === 1 && vf && JSON.stringify(vf.requiredEffects) === JSON.stringify([{ requirementId: 'C1', field: 'case_name', effect: 'lock', events: ['app.record.edit.show'], condition: 'ステータス in ("承認待ち")' }]) && !('cases' in vf) && Array.isArray(vf.relatedFiles) && vf.relatedFiles.map(f => f.name).join(',') === 'common.js' && !/sk_live_0123456789abcdef0123/.test(vf.relatedFiles[0].text) && /case_name/.test(vf.relatedFiles[0].text), `D10-1: Generator Context に必須の効果と、そのフィールドを参照する既存 JS（同じ platform・秘密情報は伏字）を渡し、代表条件は送らない: ${JSON.stringify(vf && { re: vf.requiredEffects, files: (vf.relatedFiles || []).map(f => f.name), cases: 'cases' in vf })}`);
  assert(v && v.final && v.final.approvable === true && v.generated.C1.status === 'verified' && v.generated.C1.verification.behavior.status === 'passed', `D10-2: 生成工程の結果（必須の効果・動作テスト）で最終案は承認できる: ${JSON.stringify(v && v.final && { approvable: v.final.approvable, reason: v.final.blockingReason, status: v.generated.C1 && v.generated.C1.status })}`);
  await clickChat(m, 'final-approve', { plan: v.planId, version: String(v.version) }); await ticks(4);
  assert(v.approval && v.approval.baseStamp && v.approval.baseStamp.fingerprint, `D10-3: 承認に基準の指紋を記録: ${JSON.stringify(v.approval && v.approval.baseStamp)}`);
  const pr = await m.panel.startJsRegister(v); await ticks(4);
  assert(pr && pr.status === 'PREPARED' && pr.verdict !== 'BLOCKED', `D10-4: 登録前の再検査は生成工程の結果の取り込み（模擬は実行しない）で、登録の準備まで進む: ${JSON.stringify(pr && { status: pr.status, verdict: pr.verdict, blockers: pr.blockers })}`);
  m.panel.cancelJsRegister();
  setBaseFail(true);
  const pr2 = await m.panel.startJsRegister(v); await ticks(4);
  assert(pr2 && pr2.status === 'BLOCKED' && (pr2.blockers || []).some(b => b.code === 'APPROVAL_REQUIRED' && /確かめられませんでした/.test(b.message)) && KTAiConversation.approvalValid(v, { baseStamp: null }).reason === 'BASE_UNKNOWN', `D10-5: 基準を取得できない → 照合を飛ばさず、承認を流用して登録の準備に進まない: ${JSON.stringify(pr2 && pr2.blockers)}`);
  // 動作テストが環境で実行できない → 承認できない（［この内容で反映する］は押せない）
  const r2 = await run({ env: 'unavailable' });
  const v2 = r2.m.conv().activePlan();
  assert(v2 && v2.final && v2.final.approvable === false && v2.generated.C1.status === 'not-run' && r2.genCtx.length === 1 && /disabled>この内容で反映する/.test(r2.m.chat()) && /動作テストを実行できませんでした（環境: 動作テストの環境を使えませんでした）/.test(stripC(r2.m.chat())), `D10-6: 動作テストが環境で実行できない → 生成は 1 回のまま・承認できない・理由は環境: ${JSON.stringify(v2 && v2.final && { approvable: v2.final.approvable, reason: v2.final.blockingReason })}`);
});

console.log(`\n${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
