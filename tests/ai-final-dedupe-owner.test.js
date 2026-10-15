// 最終案の重複と「担当未定」の食い違いを直す（2026-10-15 の指示 §1〜§4。有料の AI は使わない）
//
// 検証内容:
//   §D1 保存済みの素材の再生（AI版 評価の記録 §12.31・App 353。tests/fixtures/nl1015b-final.js）: 依頼 → 修正コメント → ［採用］→ 計画 → 生成 3 本 → 最終案。
//        左の最終案のカードは同じ業務の変更を 1 回だけ（採用した動作 4 行・制約 1 行・計画で決めた点）。AI の実装の言い方・列の列挙・「申請する」の行・計画の返答の再掲は左に無い。
//        PC とモバイルで同じ制御は右に 1 文。条件は「100万円未満」、元の式は右の詳細だけ。コードのボタンは役割の名前。「反映できます」は準備が整ったときだけ。
//        担当未定は左・右・反映の前の確認のどこにも無い（原因: 検査が要件の担当を採用した仮案の項目で引いていなかった・反映の前の再検査に要件を渡していなかった。
//        修正の前の引数では同じ素材で「担当範囲外とされた要件…」が出ることも確かめる）
//   §D2 PC とモバイルで本当に違う部分（モバイルだけ単価を外した計画）は画面ごとの文のまま残し、左にも出す
//   §D3 条件の文: 同じフィールド・同じ値の「<= と !=」は「未満」に（整数・小数）。まとめられない形（値・フィールドが違う・or）はまとめない。!= は「以外」。in の括弧
//   §D4 担当: 採用した仮案の項目が担当の要件は担当未定にしない。わざと担当を外した要件（計画にも仮案にも無い項目・任意の提案だけ）は今までどおり反映を止める。
//        計画全体で扱う要件を生成の AI が担当外・一部と言い、計画のどの手順で実現するかが書かれていないときは、左・右・反映の前の確認に同じ文（反映は止めない）。
//        別の JavaScript が満たした（MET）と申告した要件には出さない
//   §D5 区分を混同しない: この JavaScript の一部達成（制約）・計画全体の確認・まだ作っていない（作成途中。反映できますと言わない・残りから再開できる）・模擬テストを実行できない（確認できないこと）
//   §D6 設定だけの短い変更: 決まった文の残り・空の見出しが無い
//
// 実行方法: node tests/ai-final-dedupe-owner.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTAiConversation, KTAiChatUi, KTCodeReview } = T;
const { assert, state } = makeAssert();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { createReplay } = require('./helpers/replay-nl1015b.js');
const R = createReplay(T, K);
const F = R.F;
const { stripC, clone } = K;
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
const I = KTAiConversation.INTENT;
const outside = (h) => String(h).replace(/<details[\s\S]*?<\/details>/g, '');
const vis = (h) => stripC(outside(h)).replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const count = (s, t) => String(s).split(t).length - 1;
const secOf = (text, head, nexts) => { const i = text.indexOf(head); if (i < 0) return ''; const rest = text.slice(i + head.length); const ends = nexts.map(n => rest.indexOf(n)).filter(n => n >= 0); return rest.slice(0, ends.length ? Math.min(...ends) : rest.length); };
const LEFT_SECTIONS = ['この案で実現すること', 'この案の制約', '仮案からの補足', '確認できないこと／反映を止めている理由', '残る判断', 'コードを見る', '動作テスト環境へ反映'];
const ADOPTED = F.PROPOSE[1].behaviors.filter(b => b.origin === 'user').map(b => b.text);
const AI_ITEM = F.PROPOSE[1].behaviors.find(b => b.origin === 'ai').text;
const ROWS = '「明細」の行の追加・削除は止まりません（セルの編集不可だけでは止められないため。行のボタンを隠す API は Toolkit がまだ扱っていません）';
const REALIZED = '「明細」の品名・数量・単価のセルを編集できなくなります';
const READY = { status: 'ready', items: { target: '動作テスト環境（このアプリ）。運用環境には反映しません', confirmations: [] } };
const OWNERLESS_RE = /担当するか決まっていません|担当が計画にありません|担当が計画に見つかりません|担当範囲外とされた要件/;
const INTERNAL = /\b[RBCP][0-9]+\b|requestId|PLAN_OWNER|AI_OUT_OF_SCOPE|coverage-owner|SUBTABLE_ROWS|requirementId|planOwners/;
/** 反映の前の確認の確認項目（3 本の JavaScript の再検査。画面の jsRecheckOf と同じ引数）の画面の文 */
const precheckTexts = (x, o = {}) => ['C1', 'C2', 'C3'].flatMap(cid => (R.recheckOf(x, cid, o).registration.confirmations || []).map(c => c.screenText));
/** 生成の応答の coverage を差し替える mutate（cid → coverage を返す関数） */
const withCoverage = (map) => (cid, g) => (map[cid] ? { ...g, coverage: map[cid](clone(g.coverage)) } : g);

(async () => {
// =========================================================
console.log('\n--- §D1. 保存済みの素材の再生（§12.31）: 左は同じ業務の変更を 1 回だけ・担当未定は左右と反映の前の確認のどこにも無い ---');
await section(async () => {
  const x = await R.run();
  const v = x.c.activePlan(), fin = v && v.final;
  assert(x.sends.map(r => r && r.intent).join(',') === `${I.PROPOSE},${I.DRAFT_REPLY},${I.ADOPT_DRAFT}` && x.calls.plan.length === 1 && x.gen.calls.length === 3 && fin && !fin.incomplete && ['C1', 'C2', 'C3'].every(c => v.generated[c].status === 'verified') && fin.approvable === true && ['C1', 'C2', 'C3'].every(c => JSON.stringify(v.generated[c].requiredEffects) === JSON.stringify(F.GENERATED[c].requiredEffects)),
    `D1-1: 前提（再生）: 仮案 2 回 → 採用 → 計画 1 回 → 生成 3 本（必須の動作は実機と同じ）→ 承認できる最終案: ${JSON.stringify({ sends: x.sends.map(r => r && r.intent), plan: x.calls.plan.length, gen: x.gen.calls.length, st: v && Object.values(v.generated || {}).map(e => e.status), approvable: fin && fin.approvable })}`);
  const owners = x.gen.calls[0].planOwners || [];
  assert(x.gen.calls.every(c => Array.isArray(c.planOwners)) && ['B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'C3', 'P1'].every(id => owners.includes(id)) && !owners.includes('B6') && JSON.stringify(x.c.planOwnerIds(v)) === JSON.stringify(owners),
    `D1-2: 生成の検査に、準備の判定と同じ担当の集まりを渡す（採用した仮案の項目・計画の手順・JavaScript。任意の提案 B6 は含めない）: ${JSON.stringify(owners)}`);
  const h0 = R.leftHtml(x), hReady = R.leftHtml(x, { pre: READY }), L = vis(hReady), right = R.rightHtml(x), RT = stripC(right).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'), RV = vis(right);
  const doSec = secOf(L, 'この案で実現すること', LEFT_SECTIONS.slice(1));
  assert(ADOPTED.length === 4 && ADOPTED.every(t => count(doSec, t) === 1 && count(L, t) === 1) && doSec.split('\n').map(s => s.trim()).filter(Boolean).length === 4,
    `D1-3: 「この案で実現すること」は利用者の依頼の動作 4 行（各 1 回）だけ: ${doSec.replace(/\s+/g, ' ')}`);
  assert(!L.includes(AI_ITEM) && count(RV, AI_ITEM) === 1 && /アクションを整え|既存の編集制御に統合/.test(RV) && !/アクションを整え|既存の編集制御に統合|既存ファイルに統合/.test(L),
    `D1-4: 要件に結び付かない AI の項目（実装の言い方「アクションを整え、既存の編集制御に統合する」）は左に無く、右の「最終的にどう動くか」に 1 回: ${AI_ITEM}`);
  assert(!/品名|数量|単価|のセルを編集できなくなります/.test(L) && count(RV, `${REALIZED}（PC・モバイル）`) === 1 && !RV.includes(`${REALIZED}（PC）`) && !RV.includes(`${REALIZED}（モバイル）`) && fin.behaviors.includes(`${REALIZED}（PC・モバイル）`),
    `D1-5: 列の列挙（品名・数量・単価）は左に無く、右に PC とモバイルをまとめた 1 文: ${(RV.match(/[^\n]*セルを編集できなくなります[^\n]*/g) || []).join(' / ')}`);
  const before = F.BEFORE_LEFT, gone = before.filter(t => !ADOPTED.includes(t));
  assert(gone.length === 4 && gone.every(t => !L.includes(t)) && before.filter(t => ADOPTED.includes(t)).every(t => count(L, t) === 1),
    `D1-5b: §12.31 の実機の左にあった 4 行（AI の実装の言い方・PC とモバイルで分かれた列の列挙 2 行・崩れた条件の文）は無く、利用者の依頼の動作 4 行は 1 回ずつ: ${JSON.stringify(gone.filter(t => L.includes(t)))}`);
  assert(!/今ある操作|申請する|1000000|でもない/.test(L) && /After: 作成中 → 承認待ち\s*（条件: 「金額」が100万円未満）/.test(RV) && /アクション「部長へ申請する」: 作成中 → 部長承認待ち\s*（条件: 「金額」が100万円以上）/.test(RV) && !/amount|1000000/.test(RV) && RT.includes('変更後: amount <= "1000000" and amount != "1000000"') && RT.includes('変更後: amount >= "1000000"'),
    `D1-6: 「申請する」の変更は左に重ねず、右の変更前後に「100万円未満」。実行される元の式は右の詳細だけ（実行する条件は変えない）: ${(RV.match(/After:[^\n]*/) || [''])[0]}`);
  assert(v.plan.steps.find(s => s.id === 'P2').spec.filterCond === 'amount <= "1000000" and amount != "1000000"' && v.review.steps.find(s => s.stepId === 'P2').diff.after.filterCond === 'amount <= "1000000" and amount != "1000000"', 'D1-6b: 計画と確認の変更後の条件式（実行される式）は変えていない');
  assert(count(L, ROWS) === 1 && /この案の制約\s*PC・モバイル: 「明細」の行の追加・削除は止まりません/.test(L) && count(RV, ROWS) === 1 && fin.constraints.length === 1,
    `D1-7: 行の追加・削除の制約は左の通常表示に 1 回・右の「できないこと」に 1 回（PC・モバイルで 1 行）: ${JSON.stringify(fin.constraints)}`);
  const supSec = secOf(L, '仮案からの補足', LEFT_SECTIONS.filter(s => s !== '仮案からの補足' && s !== 'この案で実現すること' && s !== 'この案の制約'));
  assert(!supSec.includes(F.PLAN_REPLY.slice(0, 20)) && !L.includes(F.PLAN_REPLY.slice(0, 20)) && !/kt-ai-final-reply/.test(hReady) && v.plan.provisionals.every(p => count(supSec, p.choice) === 1) && fin.changed.revision === false,
    `D1-8: 仮案からの補足に計画の返答（計画の要約）の再掲は無く、採用の後に計画で決めた点（3 件）だけ: ${supSec.replace(/\s+/g, ' ').slice(0, 300)}`);
  //   担当（§3）: R3 は C2 の検査で計画全体で扱う要件（明細の行を理由にした一部達成 = 構造の制約と同じ）。担当未定は左・右・反映の前の確認のどこにも無い
  const c2 = v.generated.C2.review.coverage;
  assert(c2.unowned.length === 0 && c2.planUnconfirmed.length === 0 && c2.outOfScope.length === 1 && c2.outOfScope[0].code === 'PLAN_OWNER' && c2.outOfScope[0].rowLimit === true && !v.generated.C2.review.checks.some(ch => ch.name === 'coverage-owner') && !fin.blockers.length && fin.outOfScope.every(r => r.owned),
    `D1-9: R3（PC・モバイルの金額と明細を編集不可・planRefs は仮案の項目 B2）は C2 の検査で担当あり（PLAN_OWNER・rowLimit）。担当未定・確認の行は無い: ${JSON.stringify({ un: c2.unowned, oos: c2.outOfScope.map(o => [o.code, o.owner, o.rowLimit]), blockers: fin.blockers })}`);
  const pre = precheckTexts(x), preBefore = precheckTexts(x, { ownersOff: true });
  assert(!OWNERLESS_RE.test(L) && !OWNERLESS_RE.test(RT) && !/確認できないこと/.test(L + RV) && pre.length === 1 && /既存のファイルの 2 行が置き換え・削除されます/.test(pre[0]) && !pre.some(t => OWNERLESS_RE.test(t)),
    `D1-10: 左・右・反映の前の確認のどれにも担当未定が無い（反映の前の確認の確認項目は既存の行の置き換えの 1 件）: ${JSON.stringify(pre)}`);
  assert(preBefore.some(t => /担当範囲外とされた要件「承認済み。PCとモバイルの両方：金額と明細を編集不可にする」の担当が計画に見つかりません/.test(t)),
    `D1-11: 原因の再現: 反映の前の再検査に要件の台帳と担当の集まりを渡さない（修正の前の画面の引数）と、同じ素材で「担当範囲外とされた要件…計画に見つかりません」が出る: ${JSON.stringify(preBefore)}`);
  const btns = [...hReady.matchAll(/<button[^>]*data-act="open-code"\s+data-cid="([^"]+)"[^>]*>([^<]*)<\/button>/g)].map(m => [m[1], m[2]]);
  assert(JSON.stringify(btns) === JSON.stringify([['C1', 'コードを見る（PCの編集制御）'], ['C2', 'コードを見る（モバイルの編集制御）'], ['C3', 'コードを見る（モバイルの入力チェック）']]) && !/[\w.-]+\.js\b/.test(L),
    `D1-12: ［コードを見る］は役割の名前（計画の画面と効果から。ファイル名は出さない）: ${JSON.stringify(btns)}`);
  const status = (h) => (/<div class="kt-ai-final-status"[^>]*>([^<]*)<\/div>/.exec(h) || [])[1] || null;
  const hRun = R.leftHtml(x, { pre: { status: 'running', items: {} } }), hBlocked = R.leftHtml(x, { pre: { status: 'blocked', reasons: ['テストの止まる理由'], items: {} } });
  assert(!/反映できます/.test(vis(h0)) && !/反映できます/.test(vis(hRun)) && !/この内容で反映できます/.test(vis(hBlocked)) && status(hReady) === 'この内容で反映できます。' && count(L, 'この内容で反映できます。') === 1 && fin.impact.settings.auto === 5 && /承認すると動作テスト環境へ反映します（設定の手順 → JavaScript の順。運用環境は変更しません）/.test(L),
    `D1-13: 「この内容で反映できます。」は承認の欄の準備が整った（ready）ときだけ（準備の前・準備中・止まる理由がある間は言わない）: ${JSON.stringify([status(h0), status(hRun), status(hBlocked), status(hReady)])}`);
  const detail = stripC(right);
  assert(/モバイルの編集制御・モバイルの入力チェック: 動作テスト環境にはモバイルの画面が無いため、反映した後もここでは確かめられません（運用環境のモバイル画面か実機で確かめます）/.test(detail) && !/モバイルの画面が無い/.test(L),
    'D1-14: モバイルの実機での確かめ方は、右の検証の明細に役割の名前で（左には出さない）');
  assert(!INTERNAL.test(L) && !INTERNAL.test(RV), `D1-15: 左右の通常表示に内部の番号・コードの語が無い: ${(L.match(INTERNAL) || RV.match(INTERNAL) || [''])[0]}`);
  //   この修正の前の検査の結果を流用したとき（検査に担当の集まりを渡していない）も、最終案の担当の判定は同じ（台帳の planRefs と準備の判定の集まりで引き直す）
  const y = await R.run({ ownersOff: true });
  const fy = y.c.activePlan().final, Ly = vis(R.leftHtml(y, { pre: READY })), Ry = stripC(R.rightHtml(y));
  assert(y.c.activePlan().generated.C2.review.coverage.unowned.length === 1 && fy.approvable === true && !fy.blockers.length && fy.outOfScope.every(r => r.owned && r.rowLimit) && !OWNERLESS_RE.test(Ly) && !OWNERLESS_RE.test(Ry) && Ly === L,
    `D1-16: 修正の前の形の検査（R3 を担当なしにした結果）を流用しても、左右の表示と判定は同じ（担当未定にしない）: ${JSON.stringify({ blockers: fy.blockers, oos: fy.outOfScope })}`);
});

// =========================================================
console.log('\n--- §D2. PC とモバイルで本当に違う部分は画面ごとの文のまま残す ---');
await section(async () => {
  //   モバイルの編集制御（C2）の計画から単価を外す（PC は品名・数量・単価、モバイルは品名・数量）
  const x = await R.run({ planMutate: (plan) => { const c2 = plan.customizations.find(c => c.customizationId === 'C2'); c2.fields = c2.fields.filter(f => f.code !== 'unit_price'); return plan; } });
  const v = x.c.activePlan(), fin = v.final;
  const L = vis(R.leftHtml(x, { pre: READY })), RV = vis(R.rightHtml(x));
  assert(fin && fin.approvable === true && fin.behaviors.includes(`${REALIZED}（PC）`) && fin.behaviors.includes('「明細」の品名・数量のセルを編集できなくなります（モバイル）') && !fin.behaviors.some(b => /（PC・モバイル）/.test(b)),
    `D2-1: 列が違うので PC とモバイルの文はまとめない: ${JSON.stringify(fin && fin.behaviors.filter(b => /セル/.test(b)))}`);
  assert(L.includes(`${REALIZED}（PC）`) && L.includes('「明細」の品名・数量のセルを編集できなくなります（モバイル）') && RV.includes('「明細」の品名・数量のセルを編集できなくなります（モバイル）'),
    'D2-2: 本当に違う部分は判断に関わるので、左の「この案で実現すること」にも画面ごとの文で出す');
});

// =========================================================
console.log('\n--- §D3. 条件の文（意味が確実に同じときだけまとめる・数値の表記・以外） ---');
await section(async () => {
  const L3 = { amount: '金額', qty: '数量', 'ステータス': 'ステータス' };
  const ui = (c) => L3[c] || c;
  const N = { amount: { type: 'NUMBER', unit: '円', unitPosition: 'AFTER' }, qty: { type: 'NUMBER', unit: '', unitPosition: 'BEFORE' }, price_usd: { type: 'NUMBER', unit: '$', unitPosition: 'BEFORE' } };
  const cs = (c, n = N) => KTAiChatUi.condSentenceOf(c, ui, n);
  assert(cs('amount <= "1000000" and amount != "1000000"') === '「金額」が100万円未満' && cs('amount != "1000000" and amount <= "1000000"') === '「金額」が100万円未満' && cs('amount >= "1000000" and amount != "1000000"') === '「金額」が100万円より大きい',
    `D3-1: 同じフィールド・同じ値の「<=」と「!=」は「未満」（順序に関係なく）。「>=」と「!=」は「より大きい」: ${cs('amount <= "1000000" and amount != "1000000"')}`);
  assert(cs('amount <= "1000000.5" and amount != "1000000.5"') === '「金額」が1,000,000.5円未満' && cs('amount < 12345') === '「金額」が12,345円未満' && cs('amount >= "10000"') === '「金額」が1万円以上' && cs('amount >= "150000000"') === '「金額」が1億5000万円以上' && cs('price_usd >= 100') === '「price_usd」が$100以上',
    `D3-2: 数値のフィールドの値: 整数で 1 万の倍数は「万・億」、それ以外は 3 桁区切り、小数はそのまま。単位は前後の指定どおり: ${cs('amount <= "1000000.5" and amount != "1000000.5"')}`);
  assert(cs('amount <= "1000000.0" and amount != "1000000"') === '「金額」が100万円未満' && cs('amount > "-0"') === '「金額」が0円より大きい' && cs('amount >= "1000000000000"') === '「金額」が1,000,000,000,000円以上' && cs('amount >= "100000000000"') === '「金額」が1,000億円以上',
    `D3-2b: 数として等しい値（1000000.0 と 1000000）はまとめる・-0 は 0・1 兆以上は 3 桁区切り（「万・億」にしない）: ${cs('amount >= "1000000000000"')}`);
  assert(cs('amount <= "1000000" and amount != "999999"') === '「金額」が100万円以下、かつ「金額」が999,999円以外' && cs('amount <= "1000000" and qty != "1000000"') === '「金額」が100万円以下、かつ「数量」が100万以外' && cs('amount <= "1000000" or amount != "1000000"') === '「金額」が100万円以下、または「金額」が100万円以外',
    `D3-3: 値が違う・フィールドが違う・or が混じるときはまとめない: ${cs('amount <= "1000000" and amount != "999999"')}`);
  assert(cs('amount <= "1000000" and amount != "1000000"', null) === '「金額」が「1000000」未満' && cs('ステータス != "完了"') === '「ステータス」が「完了」以外' && cs('ステータス not in ("完了", "却下")') === '「ステータス」が「完了」・「却下」以外' && cs('ステータス in ("承認待ち")') === '「ステータス」が「承認待ち」' && cs('owner in (LOGINUSER()) and memo like "急ぎ"') === '',
    'D3-4: フィールドの種類が分からなければ値はそのまま（まとめは同じ）。!= / not in は「以外」（「でもないのとき」と崩れない）。in の括弧を読む。関数の条件は文にしない（呼ぶ側が別の文）');
  const ex = { kind: 'UPDATE_PROCESS', title: '既存の申請を課長承認向けに絞る', name: '申請する', from: '作成中', to: '承認待ち', filterCond: 'amount <= "1000000" and amount != "1000000"', targetKind: 'PROCESS_ACTION' };
  assert(KTAiChatUi.existingChangeTextOf(ex, ui, N) === '今ある操作「申請する」は、「金額」が100万円未満のときだけ使えるようになります' && KTAiChatUi.existingChangeTextOf({ ...ex, filterCond: 'amount != "0"' }, ui, N) === '今ある操作「申請する」は、「金額」が0円以外のときだけ使えるようになります',
    'D3-5: 既存の操作の文（採用した動作の無い最終案の左）も同じ変換（「100万円未満のときだけ」・「…以外のときだけ」）');
});

// =========================================================
console.log('\n--- §D4. 担当: 採用した仮案の項目は担当あり・わざと外した担当は反映を止める・計画全体の確認は同じ文 ---');
await section(async () => {
  //   わざと担当を外す: R4（既存の入力チェック）の planRefs を計画にも仮案にも無い項目に
  for (const [tag, refs] of [['計画にも仮案にも無い項目', ['B9']], ['任意の提案だけ', ['B6']]]) {
    const x = await R.run({ reqMutate: (r) => (r.id === 'R4' ? { ...r, planRefs: refs } : r) });
    const v = x.c.activePlan(), fin = v.final;
    const L = vis(R.leftHtml(x, { pre: READY })), RV = vis(R.rightHtml(x));
    const line = '「今ある入力チェックは残して、PCとモバイルの両方で使いたい」は、この計画のどの手順・JavaScript が担当するか決まっていません';
    assert(fin && fin.approvable === false && fin.blockers.some(b => b.kind === 'ownerless' && b.text === line) && L.includes(line) && RV.includes(`${line}（決まった要件なので、反映を止めています）`) && !/この内容で反映できます/.test(L) && /disabled>動作テスト環境へ反映/.test(R.leftHtml(x, { pre: READY })),
      `D4-1（${tag}）: わざと担当を外した決まった要件は、今までどおり反映を止め、左右に同じ要件の行（担当未定）: ${JSON.stringify(fin && { approvable: fin.approvable, blockers: fin.blockers.map(b => b.kind) })}`);
  }
  //   計画全体で扱う要件（R4 の planRefs は仮案の項目 B3）を、生成の AI が担当外と言い（C3）、ほかの JavaScript も満たしたと言わない（C1 の R4 MET を外す）
  const line4 = '「PCとモバイルの入力・保存時：既存の入力チェックを維持して両方で利用できるようにする」は、作った JavaScript では担当外とされました。計画のどの手順で実現するかは書かれていません';
  const x = await R.run({ mutate: withCoverage({ C1: (cov) => cov.filter(c => c.requirementId !== 'R4'), C3: (cov) => cov.map(c => (c.requirementId === 'R4' ? { ...c, status: 'OUT_OF_SCOPE', note: '入力チェックの維持は計画の別の手順で扱う' } : c)) }) });
  const v = x.c.activePlan(), fin = v.final;
  const L = vis(R.leftHtml(x, { pre: READY })), RV = vis(R.rightHtml(x)), pre = precheckTexts(x);
  assert(fin.approvable === true && fin.blockers.some(b => b.kind === 'plan-scope' && b.text === line4) && count(L, line4) === 1 && count(RV, line4) === 1 && pre.filter(t => t === line4).length === 1 && !OWNERLESS_RE.test(L + RV + pre.join('')) && v.generated.C3.review.coverage.unowned.length === 0,
    `D4-2: 計画全体で扱う要件を生成の AI が担当外と言い、どの手順で実現するかが書かれていない → 左・右・反映の前の確認に同じ文 1 回（担当未定とは言わない・反映は止めない）: ${JSON.stringify({ blockers: fin.blockers, pre })}`);
  //   一部だけ（明細の行以外の理由）: R3 を C2 が PARTIAL（理由はインライン編集）と言い、C1 も R3 を満たしたと言わない
  const line3 = '「承認済み。PCとモバイルの両方：金額と明細を編集不可にする」は、作った JavaScript では一部だけ満たすとされました。残りを計画のどの手順で実現するかは書かれていません';
  const y = await R.run({ mutate: withCoverage({ C1: (cov) => cov.filter(c => c.requirementId !== 'R3'), C2: (cov) => cov.map(c => (c.requirementId === 'R3' ? { requirementId: 'R3', requirement: c.requirement, text: c.text, status: 'PARTIAL', note: 'PC の一覧のインライン編集は担当外' } : c)) }) });
  const fy = y.c.activePlan().final, Ly = vis(R.leftHtml(y, { pre: READY })), Ry = vis(R.rightHtml(y)), prey = precheckTexts(y);
  assert(fy.approvable === true && count(Ly, line3) === 1 && count(Ry, line3) === 1 && prey.filter(t => t === line3).length === 1 && count(Ly, ROWS) === 1,
    `D4-3: 一部だけ（明細の行以外の理由）も同じ文で 3 か所に 1 回ずつ。明細の行の制約は別に 1 回: ${JSON.stringify(prey)}`);
  //   別の JavaScript（C1）が R3 を満たしたと申告していても、C2 の一部の申告の確認は消さない（AI の申告だけで確認を消さない。反映の前の確認は JavaScript ごとの検査なので、
  //   消すと 3 か所が食い違う。独立レビュー M1）。承認できるかは変えない
  const z = await R.run({ mutate: withCoverage({ C2: (cov) => cov.map(c => (c.requirementId === 'R3' ? { requirementId: 'R3', requirement: c.requirement, text: c.text, status: 'PARTIAL', note: 'PC の一覧のインライン編集は担当外' } : c)) }) });
  const fz = z.c.activePlan().final, prez = precheckTexts(z);
  assert(fz.approvable === true && fz.blockers.filter(b => b.kind === 'plan-scope').length === 1 && count(vis(R.leftHtml(z, { pre: READY })), line3) === 1 && count(vis(R.rightHtml(z)), line3) === 1 && prez.filter(t => t === line3).length === 1,
    `D4-4: 別の JavaScript の MET の申告では確認を消さず、左・右・反映の前の確認に同じ文 1 回ずつ: ${JSON.stringify({ blockers: fz.blockers.map(b => b.kind), pre: prez })}`);
  //   独立レビュー H1: 要件の担当がその JavaScript 自身（R4 の planRefs が C3）なのに、C3 が担当外と申告した → 担当未定にせず、左・右・反映の前の確認に同じ self の文
  const lineSelf = '「PCとモバイルの入力・保存時：既存の入力チェックを維持して両方で利用できるようにする」は、担当の JavaScript では担当外とされました。どこで実現するかは計画に書かれていません';
  const s1 = await R.run({ reqMutate: (r) => (r.id === 'R4' ? { ...r, planRefs: ['C3'] } : r), mutate: withCoverage({ C1: (cov) => cov.filter(c => c.requirementId !== 'R4'), C3: (cov) => cov.map(c => (c.requirementId === 'R4' ? { ...c, status: 'OUT_OF_SCOPE', note: '移植だけを担当' } : c)) }) });
  const fs1 = s1.c.activePlan().final, pres1 = precheckTexts(s1), Ls1 = vis(R.leftHtml(s1, { pre: READY })), Rs1 = vis(R.rightHtml(s1));
  assert(fs1.approvable === true && count(Ls1, lineSelf) === 1 && count(Rs1, lineSelf) === 1 && pres1.filter(t => t === lineSelf).length === 1 && !OWNERLESS_RE.test(Ls1 + Rs1 + pres1.join('')) && s1.c.activePlan().generated.C3.review.coverage.unowned.some(u => u.owner === 'self'),
    `D4-5: その JavaScript 自身が担当の要件を担当外と申告したときも、左・右・反映の前の確認に同じ文 1 回ずつ（担当未定と言わない・左右から消さない）: ${JSON.stringify({ blockers: fs1.blockers.map(b => b.text), pre: pres1 })}`);
  //   この修正の前の検査の結果（担当の集まり・要件の台帳なしで作った検査）を流用しても、左右は同じ self の文
  const s1b = await R.run({ ownersOff: true, reqMutate: (r) => (r.id === 'R4' ? { ...r, planRefs: ['C3'] } : r), mutate: withCoverage({ C1: (cov) => cov.filter(c => c.requirementId !== 'R4'), C3: (cov) => cov.map(c => (c.requirementId === 'R4' ? { ...c, status: 'OUT_OF_SCOPE', note: '移植だけを担当' } : c)) }) });
  assert(count(vis(R.leftHtml(s1b, { pre: READY })), lineSelf) === 1 && count(vis(R.rightHtml(s1b)), lineSelf) === 1, 'D4-5b: 前の形の検査の結果でも、左右は同じ self の文（台帳の planRefs で自分の担当と分かる）');
  //   独立レビュー M2: 同じ要件を 2 つの JavaScript が違う申告（C1 は担当外・C3 は未達）→ 左右も反映の前の確認と同じく、それぞれの文を 1 回ずつ
  const line4b = '「PCとモバイルの入力・保存時：既存の入力チェックを維持して両方で利用できるようにする」は、作った JavaScript では満たしていないとされました。計画のどの手順で実現するかは書かれていません';
  const m2 = await R.run({ mutate: withCoverage({ C1: (cov) => cov.map(c => (c.requirementId === 'R4' ? { ...c, status: 'OUT_OF_SCOPE', note: '' } : c)), C3: (cov) => cov.map(c => (c.requirementId === 'R4' ? { ...c, status: 'NOT_MET', note: '' } : c)) }) });
  const fm2 = m2.c.activePlan().final, prem2 = precheckTexts(m2), Lm2 = vis(R.leftHtml(m2, { pre: READY })), Rm2 = vis(R.rightHtml(m2));
  assert([line4, line4b].every(t => count(Lm2, t) === 1 && count(Rm2, t) === 1 && prem2.filter(p => p === t).length === 1) && fm2.blockers.filter(b => b.kind === 'plan-scope').length === 2,
    `D4-6: 同じ要件の違う申告は、左・右・反映の前の確認でそれぞれ 1 回ずつ（3 か所が同じ）: ${JSON.stringify(prem2)}`);
  //   独立レビュー M3: 計画が対応できないとした要件（disposition unsupported）を担当外と申告 → 計画全体の確認は出さず、「計画では対応できないとされた要件」だけ
  const m3 = await R.run({ reqMutate: (r) => (r.id === 'R4' ? { ...r, disposition: 'unsupported' } : r), mutate: withCoverage({ C1: (cov) => cov.filter(c => c.requirementId !== 'R4'), C3: (cov) => cov.filter(c => c.requirementId !== 'R4').concat([{ requirementId: 'R4', text: 'PCとモバイルの入力・保存時：既存の入力チェックを維持して両方で利用できるようにする', status: 'OUT_OF_SCOPE', note: '' }]) }) });
  const fm3 = m3.c.activePlan().final, prem3 = precheckTexts(m3), Lm3 = vis(R.leftHtml(m3, { pre: READY }));
  assert(fm3 && !fm3.blockers.some(b => b.kind === 'plan-scope') && !prem3.some(t => /計画のどの手順で実現するかは書かれていません/.test(t)) && !/計画のどの手順で実現するかは書かれていません/.test(Lm3) && fm3.cannot.some(c => c.kind === 'req-unsupported' && c.requirementId === 'R4') && /計画では対応できないとされた要件/.test(Lm3),
    `D4-7: 計画が対応できないとした要件には計画全体の確認を重ねない（「計画では対応できないとされた要件」だけ）: ${JSON.stringify({ blockers: fm3 && fm3.blockers.map(b => b.kind), pre: prem3 })}`);
});

// =========================================================
console.log('\n--- §D5. 区分を混同しない（この JavaScript の一部達成・計画全体の確認・まだ作っていない・模擬テストを実行できない） ---');
await section(async () => {
  //   この JavaScript の一部達成（C2 自身の要件 C2 を PARTIAL・理由は一覧の画面）→ 残る範囲は「この案の制約」（モバイル）。自分の要件が必須の動作に結び付くので、
  //   今までの規則（§0c.6）どおり反映できない理由にも出る（担当未定・計画全体の確認にはしない。判定は変えていない）
  const x = await R.run({ mutate: withCoverage({ C2: (cov) => cov.map(c => (c.requirementId === 'C2' ? { ...c, status: 'PARTIAL', note: '一覧の画面のセルは対象外' } : c)) }) });
  const fin = x.c.activePlan().final, L = vis(R.leftHtml(x, { pre: READY }));
  const conSec = secOf(L, 'この案の制約', LEFT_SECTIONS.slice(2));
  assert(fin.constraints.some(c => c.kind === 'coverage' && c.text === '一覧の画面のセルは対象外' && JSON.stringify(c.platforms) === '["mobile"]') && conSec.includes('モバイル: 一覧の画面のセルは対象外') && !fin.blockers.some(b => b.kind === 'plan-scope' || b.kind === 'ownerless') && fin.blockers.some(b => b.kind === 'unresolved') && fin.approvable === false && x.c.activePlan().generated.C2.status === 'unresolved' && !OWNERLESS_RE.test(L),
    `D5-1: この JavaScript の一部達成は残る範囲を「この案の制約」に（今までの規則どおり反映できない理由にも出る）。担当未定・計画全体の確認にしない: ${JSON.stringify({ constraints: fin.constraints, blockers: fin.blockers.map(b => b.kind) })}`);
  //   まだ作っていない（C3 が時間切れ）→ 作成途中のカード（反映できますと言わない）→ ［残りの JavaScript を作る］で C3 だけ作って完成
  const y = await R.run({ throwFor: { C3: 'TIMEOUT' } });
  const vy = y.c.activePlan(), fy = vy.final, hy = R.leftHtml(y, { pre: READY }), Ly = vis(hy), Ry = vis(R.rightHtml(y));
  assert(fy && fy.incomplete && fy.incomplete.stoppedAt === 'C3' && fy.approvable === false && /作成途中/.test(Ly) && !/反映できます|最終案ができました/.test(Ly) && !/data-act="final-approve"/.test(hy) && /既存の入力チェックをモバイルへ移植：作成中（止めた）/.test(Ry) && !OWNERLESS_RE.test(Ly + Ry) && !/この案の制約/.test(Ly),
    `D5-2: まだ作っていない JavaScript があるときは作成途中（承認・反映の操作は無い）。止めた JavaScript は「作成中（止めた）」で、担当未定・制約と混同しない: ${Ly.replace(/\s+/g, ' ').slice(0, 260)}`);
  const n0 = y.gen.calls.length;
  await y.c.send('コードを作って', { intentOverride: I.GENERATE_CODE, displayText: '残りの JavaScript を作る' }); await K.ticks(4);
  const vz = y.c.activePlan(), fz = vz.final, Lz = vis(R.leftHtml(y, { pre: READY }));
  assert(y.gen.calls.length === n0 + 1 && y.gen.calls[y.gen.calls.length - 1].cid === 'C3' && y.calls.plan.length === 1 && fz && !fz.incomplete && fz.approvable === true && ['C1', 'C2', 'C3'].every(c => vz.generated[c].status === 'verified') && ADOPTED.every(t => count(Lz, t) === 1) && count(Lz, ROWS) === 1 && !OWNERLESS_RE.test(Lz) && /この内容で反映できます。/.test(Lz),
    `D5-3: ［残りの JavaScript を作る］で C3 だけ作り（計画の AI は呼ばない）、完成した最終案は §D1 と同じ形: ${JSON.stringify({ gen: y.gen.calls.map(c => c.cid), plan: y.calls.plan.length, approvable: fz && fz.approvable })}`);
  //   模擬テストを実行できない（C2 の verification の behavior が not-run）→ 確認できないこと（未確認）。担当未定・制約と混同しない
  const w = await R.run({ verificationMutate: (cid, ver) => (cid === 'C2' ? { ...ver, behavior: { ...ver.behavior, status: 'not-run', reason: 'timeout', cases: ver.behavior.cases.map(c => ({ ...c, verdict: 'not-run', reason: 'timeout', message: '隔離環境で実行できませんでした' })) } } : ver) });
  const fw = w.c.activePlan().final, Lw = vis(R.leftHtml(w, { pre: READY })), Rw = vis(R.rightHtml(w));
  assert(fw && fw.approvable === false && fw.blockers.some(b => b.kind === 'not-run') && !fw.blockers.some(b => ['ownerless', 'plan-scope'].includes(b.kind)) && !OWNERLESS_RE.test(Lw + Rw) && !fw.constraints.some(c => /実行できません|隔離環境/.test(c.text)) && /確認できないこと/.test(Lw) && /確認できないこと/.test(Rw) && /模擬テスト/.test(stripC(R.rightHtml(w))) && !/この内容で反映できます/.test(Lw),
    `D5-4: 模擬テストを実行できないときは検証の区分（確認できないこと・確かめたこと）で示し、担当未定・制約と混同しない: ${JSON.stringify({ approvable: fw && fw.approvable, blockers: fw && fw.blockers.map(b => [b.kind, b.text.slice(0, 60)]) })}`);
});

// =========================================================
console.log('\n--- §D6. 設定だけの短い変更: 決まった文の残り・空の見出しが無い ---');
await section(async () => {
  const step = K.mkStep('P1', 'ADD_VIEW', 'VIEW', '承認待ち一覧', { name: '承認待ち一覧', fields: ['owner'], filterCond: 'ステータス in ("承認待ち")', sort: null }, { title: '一覧「承認待ち一覧」を追加' });
  const planImpl = (args) => ({ plan: { goal: args.goal, assessment: { summary: '承認待ちの一覧を追加します。' }, steps: [step], customizations: [], provisionals: [], questions: [], unknowns: [], impact: [], solution: 'STANDARD' }, ctx: null, gatewayPlan: null, turn: { reply: '一覧を追加する計画を作りました。', requirementOps: [], utteranceCoverage: [] },
    review: { base: { baseVersion: '1', env: 'preview', ok: true, fingerprint: 'fp-1', revision: { preview: '10' } }, steps: [{ stepId: 'P1', status: 'VALID', safety: 'SAFE', diff: { before: null, after: { name: '承認待ち一覧', filterCond: 'ステータス in ("承認待ち")' }, human: ['＋ 一覧「承認待ち一覧」（条件: ステータス in ("承認待ち")）'] }, issues: [] }], executionReadiness: { safeSteps: ['P1'], reviewSteps: [], blockedSteps: [], planOnlySteps: [] }, warnings: [] } });
  const x = K.makeConvC({ planImpl });
  await K.adoptC(x);
  const v = x.c.activePlan(), fin = v && v.final;
  const hReady = KTAiChatUi.messageHtml(x.finals().slice(-1)[0], { plans: new Map(x.c.planHistory().map(z => [`${z.planId}:${z.version}`, z])), activePlan: v, answerState: x.c.answerContext(), ledger: x.c.ledger(), answers: new Map(), finalPre: { planId: v.planId, version: v.version, status: 'ready', reasons: [], items: {} } });
  const L = vis(hReady);
  //   空の見出し: 見出しの直後に中身が無い（次の見出しかボタンが続く）
  const heads = ['この案で実現すること', 'この案の制約', '仮案からの補足', '確認できないこと／反映を止めている理由'];
  const empty = heads.filter(hd => L.includes(hd) && !secOf(L, hd, LEFT_SECTIONS.filter(s => s !== hd)).trim());
  assert(fin && fin.approvable === true && !empty.length && !/この案の制約|コードを見る|JavaScript|まだ何も反映していません|入れていません|（詳細）|担当|計画を作りました/.test(L) && /この案で実現すること/.test(L) && count(L, 'この内容で反映できます。') === 1 && !/仮案からの補足/.test(L) === !(fin.supplements || []).length,
    `D6-1: 設定だけの短い変更の左のカードに空の見出し・JavaScript の文・決まった文の残り（「入れていません」「計画の返答」など）が無い: ${L.replace(/\s+/g, ' ').slice(0, 400)}`);
  assert(/承認すると動作テスト環境へ設定の手順を反映します（運用環境は変更しません）/.test(L), 'D6-2: 設定だけの最終案の反映ボタンの添え書きは「設定の手順を反映します」（「設定の手順 → JavaScript の順」と言わない）');
});

// =========================================================
console.log('\n--- §D8. 既存の設定の変更: 採用した仮案が標準の設定の変更を言っていなかったときは左にも出す（利用者の想定と違う変更） ---');
await section(async () => {
  //   §12.31 の素材の仮案から approach.standard（プロセス管理の設定）を外す。計画は今までどおり「申請する」の条件を変える
  const x = await R.run({ proposalMutate: (p) => ({ ...p, approach: { ...p.approach, standard: [] } }) });
  const fin = x.c.activePlan().final, L = vis(R.leftHtml(x, { pre: READY }));
  assert(fin && fin.draftStandard === false && fin.adoptedBehaviors.length === 4 && /今ある操作「申請する」は、「金額」が100万円未満のときだけ使えるようになります/.test(L) && !/でもない|1000000/.test(L),
    `D8-1: 仮案が標準の設定の変更を言っていなければ、既存の操作の変更を左に 1 文（「100万円未満のときだけ」）: ${(L.match(/今ある操作[^\n]*/) || [''])[0]}`);
  const y = await R.run();
  assert(y.c.activePlan().final.draftStandard === true && !/今ある操作/.test(vis(R.leftHtml(y, { pre: READY }))), 'D8-2: 仮案が標準の設定の変更を言っていた（§12.31）ときは左に重ねない');
});

// =========================================================
console.log('\n--- §D7. 画面: 反映の前の確認の再検査も、生成の検査と同じ要件の台帳と担当の集まりで担当を引く（左のカード・右の変更内容と同じ文） ---');
await section(async () => {
  //   台本の要件 R4（7 営業日以内に承認する）の planRefs は仮案の項目 A3。生成の AI が担当外と申告する（計画にこの期限を実現する手順は無い）
  const { m, v } = await K.mountFinal({ kind: 'js', coverage: [{ requirementId: 'C1', status: 'MET', note: '' }, { requirementId: 'R4', status: 'OUT_OF_SCOPE', note: '期限はプロセス管理の設定で扱う', text: '7 営業日以内に承認する' }] });
  const { pre } = await K.prepareOnScreen(m);
  const line = '「7 営業日以内に承認する」は、作った JavaScript では担当外とされました。計画のどの手順で実現するかは書かれていません';
  const confs = (pre && pre.items && Array.isArray(pre.items.confirmations) ? pre.items.confirmations : []).map(c => (c && typeof c === 'object' ? c.text : String(c)));
  const fin = v && v.final, chat = m.chat(), L = vis(chat), RV = vis(KTAiChatUi.changeSummaryHtml(m.conv().activePlan(), {}));
  const ledgerR4 = m.conv().requirements(v.planId).find(r => r.id === 'R4');
  //   反映の前の確認の確認項目は、同じ文の後ろに確かめ方（HOW_TO_CHECK の coverage-owner）を括弧で添える
  assert(ledgerR4 && JSON.stringify(ledgerR4.planRefs) === '["A3"]' && fin && fin.approvable === true && pre && pre.status === 'ready' && confs.filter(t => t === `${line}（計画のどの手順で扱われているかを変更内容の「何が変わるか」で確かめ、扱われていなければ計画を直す）`).length === 1 && !confs.some(t => OWNERLESS_RE.test(t)) && count(L, line) === 1 && count(RV, line) === 1 && !OWNERLESS_RE.test(L + RV),
    `D7-1: 画面の反映の前の確認の確認項目・左のカード・右の変更内容に同じ文 1 回ずつ（「担当範囲外とされた要件…計画に見つかりません」は出ない。反映は止めない）: ${JSON.stringify({ planRefs: ledgerR4 && ledgerR4.planRefs, approvable: fin && fin.approvable, status: pre && pre.status, confs })}`);
});

console.log(`\n${state.failed === 0 ? 'ALL PASSED' : 'FAILED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed === 0 ? 0 : 1);
})();
