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
  //   2026-10-15（追加の指示 1）: 台本の要件（100万円以上は部長承認・100円未満は部長承認を省く・7 営業日の期限）を設定の手順で実現する（一覧だけの計画では要件の実現が足りないので反映を止める）
  const routeSteps = [K.mkStep('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ申請する', { name: '部長へ申請する', from: '作成中', to: '部長承認待ち', filterCond: 'amount >= "1000000"' }, { title: '100万円以上は部長へ申請' }),
    K.mkStep('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長承認を省いて承認する', { name: '部長承認を省いて承認する', from: '承認待ち', to: '承認済み', filterCond: 'amount < "100"' }, { title: '100円未満は部長承認を省く' }),
    K.mkStep('P4', 'ADD_REMINDER', 'REMINDER', '承認の期限', { name: '承認の期限', timingField: '申請日', daysLater: 7 }, { title: '承認の期限（7 営業日）を知らせる' })];
  const planImpl = (args) => ({ plan: { goal: args.goal, assessment: { summary: '承認待ちの一覧を追加します。' }, steps: [step, ...routeSteps], customizations: [], provisionals: [], questions: [], unknowns: [], impact: [], solution: 'STANDARD' }, ctx: null, gatewayPlan: null, turn: { reply: '一覧を追加する計画を作りました。', requirementOps: [], utteranceCoverage: [] },
    review: { base: { baseVersion: '1', env: 'preview', ok: true, fingerprint: 'fp-1', revision: { preview: '10' } }, steps: [{ stepId: 'P1', status: 'VALID', safety: 'SAFE', diff: { before: null, after: { name: '承認待ち一覧', filterCond: 'ステータス in ("承認待ち")' }, human: ['＋ 一覧「承認待ち一覧」（条件: ステータス in ("承認待ち")）'] }, issues: [] }], executionReadiness: { safeSteps: ['P1', 'P2', 'P3', 'P4'], reviewSteps: [], blockedSteps: [], planOnlySteps: [] }, warnings: [] } });
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
console.log('\n--- §D8. 既存の設定の変更（追加の指示 2）: 採用した動作があっても一律に隠さない。採用した要件で説明済みの変更だけ左に重ねず、説明済みと確かめられない変更は左にも短く残す ---');
await section(async () => {
  //   (1) 説明済み: §12.31 の「申請する」の条件（amount <= 1000000 and != 1000000）は「金額が100万円未満・以上」の要件（R1 / R2）の値（100万円・金額）をすべて持つ → 左に重ねない（右に変更前後）
  const y = await R.run();
  const fy = y.c.activePlan().final, Ly = vis(R.leftHtml(y, { pre: READY })), Ry = vis(R.rightHtml(y));
  assert(fy.existingChanges.length === 1 && fy.existingChanges[0].name === '申請する' && fy.existingChanges[0].explained === true && !/今ある操作|申請する/.test(Ly) && /アクション「申請する」を変更/.test(Ry) && /After: 作成中 → 承認待ち\s*（条件: 「金額」が100万円未満）/.test(Ry),
    `D8-1: 採用した要件で説明済みの既存の操作の変更（「申請する」の条件）は左に重ねず、右の変更前後で確かめられる: ${JSON.stringify(fy.existingChanges.map(c => [c.name, c.explained, c.changed]))}`);
  //   (2) 説明済みでない: 計画が既存の操作「差し戻す」を実行できる人を変える（採用した仮案にも要件にも無い）→ 採用した動作があっても左に 1 文で残し、右で変更前後を確かめられる
  const P6 = { id: 'P6', actionType: 'UPDATE_PROCESS', targetKind: 'PROCESS_ACTION', targetRef: '差し戻す', title: '差し戻すを実行できる人を変更', spec: { name: '差し戻す', from: '承認待ち', to: '作成中', executableUsers: ['USER:user.approver'] }, dependsOn: [] };
  const before6 = { name: '差し戻す', from: '承認待ち', to: '作成中', filterCond: '', type: 'PRIMARY', executableUsers: [] }, after6 = { ...before6, executableUsers: [{ type: 'USER', code: 'user.approver' }] };
  const x = await R.run({ planMutate: (plan) => { plan.steps.push(clone(P6)); return plan; }, reviewMutate: (rv) => { rv.steps.push({ stepId: 'P6', status: 'VALID', safety: 'REVIEW', diff: { changeType: 'UPDATE', changeKind: 'ACTION_EXECUTABLE_USERS', target: { kind: 'PROCESS_ACTION', id: '差し戻す' }, before: before6, after: after6, human: ['✎ アクション「差し戻す」を変更', 'Before: 実行できる人: （なし）', 'After: 実行できる人: USER:user.approver'] }, issues: [] }); return rv; } });
  const fx = x.c.activePlan().final, Lx = vis(R.leftHtml(x, { pre: READY })), Rx = vis(R.rightHtml(x));
  const ch6 = fx.existingChanges.find(c => c.name === '差し戻す'), line6 = '今ある操作「差し戻す」を実行できる人が変わります（変更前後は右の「変更内容」）';
  assert(fx.adoptedBehaviors.length === 4 && ch6 && ch6.explained === false && JSON.stringify(ch6.changed) === '["executableUsers"]' && count(Lx, line6) === 1 && !/今ある操作「申請する」/.test(Lx) && /アクション「差し戻す」を変更/.test(Rx) && !/進むようになります/.test(Lx),
    `D8-2: 採用した要件に無い既存の操作の変更（「差し戻す」を実行できる人）は、採用した動作があっても左に 1 文で残す（説明済みの「申請する」は重ねない）。実行できる人だけの変更を「進むようになります」と言わない: ${JSON.stringify({ changes: fx.existingChanges.map(c => [c.name, c.explained, c.changed]), left: (Lx.match(/今ある操作[^\n]*/g) || []) })}`);
  //   (3) 見直しの MEDIUM 6: 「申請する」の条件（説明済み）と実行できる人（説明できない）を同じ手順で変える → 左は実行できる人の 1 文だけ（条件の文は重ねない）
  const withP2 = (o) => (rv) => { const st = rv.steps.find(s => s.stepId === 'P2'); st.diff = { ...st.diff, after: { ...st.diff.after, ...(o.after || {}) }, before: { ...st.diff.before, ...(o.before || {}) } }; return rv; };
  const z = await R.run({ reviewMutate: withP2({ after: { executableUsers: [{ type: 'USER', code: 'user.approver' }] } }) });
  const fz = z.c.activePlan().final, Lz = vis(R.leftHtml(z, { pre: READY })), chz = fz.existingChanges.find(c => c.name === '申請する');
  const lineU = '今ある操作「申請する」を実行できる人が変わります（変更前後は右の「変更内容」）';
  assert(chz && chz.explained === false && JSON.stringify(chz.changed) === '["filterCond","executableUsers"]' && JSON.stringify(chz.unexplained) === '["executableUsers"]' && count(Lz, lineU) === 1 && !/今ある操作「申請する」は、/.test(Lz),
    `D8-3: 一部の項目だけ説明済みの変更は、説明できない項目（実行できる人）だけを左に 1 文で残す: ${JSON.stringify({ ch: chz && [chz.changed, chz.unexplained], left: (Lz.match(/今ある操作[^\n]*/g) || []) })}`);
  //   (4) 見直しの MEDIUM 7: 承認の流れの要件と同じ値（100万円以上・金額）を持つ通知の変更は、種類が違うので説明済みにしない（左に残す）
  const P7 = { id: 'P7', actionType: 'UPDATE_NOTIFICATION', targetKind: 'NOTIFICATION', targetRef: '高額案件通知', title: '通知「高額案件通知」の通知先を変更', spec: { name: '高額案件通知', filterCond: 'amount >= "1000000"', targets: ['USER:user.director'] }, dependsOn: [] };
  const b7 = { id: 'perRecord#1', scope: 'perRecord', title: '高額案件通知', filterCond: 'amount >= "1000000"', targets: ['USER:user.manager'] }, a7 = { ...b7, targets: ['USER:user.director'] };
  const w = await R.run({ planMutate: (plan) => { plan.steps.push(clone(P7)); return plan; }, reviewMutate: (rv) => { rv.steps.push({ stepId: 'P7', status: 'VALID', safety: 'REVIEW', diff: { changeType: 'UPDATE', target: { kind: 'NOTIFICATION', id: 'perRecord#1' }, before: b7, after: a7, human: ['✎ 通知「高額案件通知」を変更'] }, issues: [] }); return rv; } });
  const fw = w.c.activePlan().final, Lw = vis(R.leftHtml(w, { pre: READY })), ch7 = fw.existingChanges.find(c => c.kind === 'UPDATE_NOTIFICATION');
  assert(ch7 && ch7.explained === false && count(Lw, '今ある設定を変えます: 通知「高額案件通知」の通知先を変更（変更前後は右の「変更内容」）') === 1 && fw.existingChanges.find(c => c.name === '申請する').explained === true,
    `D8-4: 同じ値を持っていても種類の違う手順（通知）の変更は、承認の流れの要件で説明済みにしない: ${JSON.stringify({ ch: ch7 && [ch7.explained, ch7.changed], left: (Lw.match(/今ある設定を変えます[^\n]*/g) || []) })}`);
  //   (5) 見直しの LOW 8: 名前だけの変更は名前の変更として言う（汎用の文にしない）
  const nm = await R.run({ reviewMutate: withP2({ before: { filterCond: 'amount <= "1000000" and amount != "1000000"' }, after: { name: '課長へ申請する' } }) });
  const Ln = vis(R.leftHtml(nm, { pre: READY })), chn = nm.c.activePlan().final.existingChanges.find(c => c.kind === 'UPDATE_PROCESS');
  assert(chn && JSON.stringify(chn.changed) === '["name"]' && chn.explained === false && count(Ln, '今ある操作「申請する」の名前が「課長へ申請する」に変わります') === 1,
    `D8-5: 名前だけの変更は「名前が変わります」と言う: ${JSON.stringify({ ch: chn && [chn.changed, chn.explained], left: (Ln.match(/今ある操作[^\n]*/g) || []) })}`);
  //   (6) 見直しの再確認の残り（MEDIUM 7）: 同じ境界（100万円以上）を持つ関係の無い既存の操作「経理へ回す」の条件の変更は、境界を持つ設定の手順がほかにもある（部長へ申請する）ので説明済みにしない
  const P8 = { id: 'P8', actionType: 'UPDATE_PROCESS', targetKind: 'PROCESS_ACTION', targetRef: '経理へ回す', title: 'アクション「経理へ回す」の条件を変更', spec: { name: '経理へ回す', from: '承認済み', to: '経理確認', filterCond: 'amount >= "1000000"' }, dependsOn: [] };
  const b8 = { name: '経理へ回す', from: '承認済み', to: '経理確認', filterCond: '', type: 'PRIMARY', executableUsers: [] }, a8 = { ...b8, filterCond: 'amount >= "1000000"' };
  const e8 = await R.run({ planMutate: (plan) => { plan.steps.push(clone(P8)); return plan; }, reviewMutate: (rv) => { rv.steps.push({ stepId: 'P8', status: 'VALID', safety: 'REVIEW', diff: { changeType: 'UPDATE', changeKind: 'ACTION_CONDITION', target: { kind: 'PROCESS_ACTION', id: '経理へ回す' }, before: b8, after: a8, human: ['✎ アクション「経理へ回す」を変更'] }, issues: [] }); return rv; } });
  const f8 = e8.c.activePlan().final, L8 = vis(R.leftHtml(e8, { pre: READY })), ch8 = f8.existingChanges.find(c => c.name === '経理へ回す');
  assert(ch8 && ch8.explained === false && count(L8, '今ある操作「経理へ回す」は、「金額」が100万円以上のときだけ使えるようになります') === 1 && f8.existingChanges.find(c => c.name === '申請する').explained === true,
    `D8-6: 同じ境界を持つ関係の無い既存の操作の条件の変更は説明済みにせず左に 1 文（「申請する」は説明済みのまま）: ${JSON.stringify({ ch: ch8 && [ch8.explained, ch8.changed], left: (L8.match(/今ある操作[^\n]*/g) || []) })}`);
  //   (7) 見直しの再確認の残り（LOW 8）: 計画の確認に変更前後が無い既存の操作でも、手順が実行できる人を指定するなら左で言う
  const e9 = await R.run({ planMutate: (plan) => { const st = plan.steps.find(x => x.id === 'P2'); st.spec.executableUsers = ['USER:user.approver']; return plan; }, reviewMutate: (rv) => { rv.steps = rv.steps.filter(x => x.stepId !== 'P2'); return rv; } });
  const L9 = vis(R.leftHtml(e9, { pre: READY })), ch9 = e9.c.activePlan().final.existingChanges.find(c => c.name === '申請する');
  assert(ch9 && ch9.explained === false && /今ある操作「申請する」の実行できる人の指定も含みます（変更前後は右の「変更内容」）/.test(L9),
    `D8-7: 変更前後の無い既存の操作でも、実行できる人の指定を左で言う: ${JSON.stringify({ ch: ch9 && [ch9.explained, ch9.specPeople], left: (L9.match(/今ある操作[^\n]*/g) || []) })}`);
});

// =========================================================
console.log('\n--- §D9. 仮案の採用を実装担当の代わりにしない（追加の指示 1）: 実現する手順・JavaScript を外すと、仮案の項目に結び付いたままでも反映できない ---');
await section(async () => {
  const drop = (cid) => (plan) => { plan.customizations = plan.customizations.filter(c => c.customizationId !== cid); plan.steps = plan.steps.filter(s => s.id !== cid); return plan; };
  //   (1) モバイルの入力チェック（C3: 既存の dealValidate.js のモバイルへの移植）を外す。R4（既存の入力チェックを PC とモバイルで使う）は仮案の項目 B3 に結び付いたまま。
  //   ほかの JavaScript（PC の編集制御・モバイルの編集制御）は dealValidate.js を使わないので、モバイルの分を実現するものが無い（要望の実質的な欠落）
  const x = await R.run({ planMutate: drop('C3') });
  const v = x.c.activePlan(), fin = v.final, L = vis(R.leftHtml(x, { pre: READY })), RV = vis(R.rightHtml(x));
  const r4 = x.c.requirements(v.planId).find(r => r.id === 'R4');
  const line4 = '「今ある入力チェックは残して、PCとモバイルの両方で使いたい」を実現する計画の手順・JavaScript が足りません（計画に無いもの: モバイル）';
  assert(r4 && JSON.stringify(r4.planRefs) === '["B3"]' && r4.decision === 'decided' && r4.disposition === 'adopted' && fin.approvable === false && x.c.approveFinal({ planId: v.planId, version: v.version }).ok === false
    && fin.blockers.some(b => b.kind === 'ownerless' && b.text === line4) && count(L, line4) === 1 && RV.includes(`${line4}（決まった要件なので、反映を止めています）`) && !/この内容で反映できます/.test(L) && /disabled>動作テスト環境へ反映/.test(R.leftHtml(x, { pre: READY })) && x.calls.plan.length === 2,
    `D9-1: 実現する JavaScript（モバイルの入力チェック）を外すと、要件が採用した仮案の項目に結び付いたままでも欠落として反映を止める（自動の見直しは今までどおり 1 回。警告だけにしない）: ${JSON.stringify({ approvable: fin.approvable, blockers: fin.blockers.map(b => b.text), planRefs: r4 && r4.planRefs })}`);
  //   (2) モバイルの編集制御（C2）を外す。R3（PC とモバイルで金額と明細を編集不可）は PC の JavaScript（C1）だけが実現する → 一部だけ（PC）を全体の実現にしない。
  //   C1 の生成の AI は R3 を満たしたと申告しているが、その申告では担当にしない
  const y = await R.run({ planMutate: drop('C2') });
  const vy = y.c.activePlan(), fy = vy.final, Ly = vis(R.leftHtml(y, { pre: READY }));
  const line3 = '「承認済みでは金額と明細を変更できなくし、差戻し後は再編集できるようにして」を実現する計画の手順・JavaScript が足りません（計画に無いもの: モバイル）';
  assert(fy.approvable === false && fy.blockers.some(b => b.kind === 'ownerless' && b.text === line3) && count(Ly, line3) === 1 && (vy.generated.C1.review.coverage.met || []).some(m => m.requirementId === 'R3'),
    `D9-2: PC だけが実現しモバイルが欠けた要件は、全体を満たした扱いにしない（生成の AI の満たしたという申告では担当にしない）: ${JSON.stringify(fy.blockers.map(b => b.text))}`);
  //   (3) 別の形で実現している: 「申請する」「部長へ申請する」の条件を別の書き方（amount < 1000000 / amount > 999999）にしても、100万円の境界は同じ手順が持つので担当不在にしない
  const z = await R.run({ planMutate: (plan) => { for (const s of plan.steps) { if (s.id === 'P2') s.spec.filterCond = 'amount < "1000000"'; if (s.id === 'P3') s.spec.filterCond = 'amount > "999999"'; } return plan; } });
  const fz = z.c.activePlan().final;
  assert(fz.approvable === true && !fz.blockers.some(b => b.kind === 'ownerless') && z.calls.plan.length === 1, `D9-3: 同じ要件を別の書き方の手順で実現していれば担当不在にしない（自動の見直しもしない）: ${JSON.stringify({ approvable: fz.approvable, blockers: fz.blockers.map(b => b.kind) })}`);
  //   (4) 別の JavaScript が実現している: モバイルの入力チェックを C3 でなく C2（モバイルの編集制御）が移植元 dealValidate.js を使って担う計画 → R4 は担当不在にしない
  //   （C2 の保存済みのコードに入力チェックは無いので、必須の動作の検証で止まる。ここで確かめるのは担当の判定だけ）
  const w = await R.run({ planMutate: (plan) => { const c2 = plan.customizations.find(c => c.customizationId === 'C2'); const c3 = plan.customizations.find(c => c.customizationId === 'C3'); c2.existingFiles = clone(c3.existingFiles); drop('C3')(plan); return plan; } });
  const fw = w.c.activePlan().final;
  assert(!fw.blockers.some(b => b.kind === 'ownerless') && !(fw.outOfScope || []).some(r => !r.owned), `D9-4: 同じ要件を別の JavaScript（移植元を使うモバイルの JavaScript）が担えば担当不在にしない: ${JSON.stringify(fw.blockers.map(b => [b.kind, b.text.slice(0, 50)]))}`);
  //   見直しの反証（2026-10-15）。remap = 計画の AI が n 回目の呼び出し（1 = 自動の見直し）で、要件の対応づけ（planRefs）だけを付け替える（計画は変えない）
  const remap = (id, refs, at = 1) => (n, args) => (n !== at ? [] : (args.requirements || []).filter(r => r && r.id === id).map(r => ({ op: 'update', id: r.id, target: r.target || '', condition: r.condition || '', behavior: r.behavior, exceptions: clone(r.exceptions || []), decision: r.decision, disposition: r.disposition || 'adopted', sourceQuotes: clone(r.sourceQuotes || []), planRefs: refs, note: '', ...(Array.isArray(r.effects) ? { effects: clone(r.effects) } : {}) })));
  const blockTexts = (xx) => xx.c.activePlan().final.blockers.map(b => b.text);
  const lineOf = (quote, what) => `「${quote}」を実現する計画の手順・JavaScript が足りません（計画に無いもの: ${what}）`;
  const reqOf = (xx, id) => xx.c.requirements(xx.c.activePlan().planId).find(r => r.id === id);
  //   (5) 見直しの HIGH 1: C3 を外したまま、自動の見直しで計画の AI が R4 の対応づけだけを C1（PC の編集制御）・C2（モバイルの編集制御。移植元を使わない）に付け替える
  //   → 対応づけた要素に既存の入力チェック（dealValidate.js）のモバイルの分を持つものが無いので、反映を止めたまま（対応づけだけで構造の欠落を消さない）
  const h1 = await R.run({ planMutate: drop('C3'), planOps: remap('R4', ['C1']) });
  const h1b = await R.run({ planMutate: drop('C3'), planOps: remap('R4', ['C2']) });
  assert([h1, h1b].every(xx => xx.c.activePlan().final.approvable === false && blockTexts(xx).includes(line4) && xx.calls.plan.length === 2) && JSON.stringify(reqOf(h1, 'R4').planRefs) === '["C1"]' && JSON.stringify(reqOf(h1b, 'R4').planRefs) === '["C2"]',
    `D9-5: 自動の見直しで計画の AI が要件の対応づけだけを別の JavaScript に付け替えても、構造の欠落（モバイルの入力チェック）は消えず反映を止める: ${JSON.stringify([h1, h1b].map(xx => ({ approvable: xx.c.activePlan().final.approvable, refs: reqOf(xx, 'R4').planRefs, blockers: blockTexts(xx) })))}`);
  //   (6) 数の境界の向き: 「申請する」の条件（100万円未満の側。P2）を外すと、100万円を持つのは「部長へ申請する」（100万円以上の側。P3）だけ → R2 は足りない。逆に P3 を外すと R1 が足りない。
  //   P2 を外したまま計画の AI が R2 を P3 に付け替えても、P3 の条件は 100万円未満の側を通さないので足りないまま
  const dP2 = await R.run({ planMutate: (plan) => { plan.steps = plan.steps.filter(s => s.id !== 'P2'); return plan; } });
  const dP3 = await R.run({ planMutate: (plan) => { plan.steps = plan.steps.filter(s => s.id !== 'P3'); return plan; } });
  const dP2r = await R.run({ planMutate: (plan) => { plan.steps = plan.steps.filter(s => s.id !== 'P2'); return plan; }, planOps: remap('R2', ['P3']) });
  const line2 = lineOf('100万円未満は課長承認にしたい', '100万円未満'), line1 = lineOf('100万円以上は部長承認', '100万円以上');
  assert(dP2.c.activePlan().final.approvable === false && blockTexts(dP2).includes(line2) && !blockTexts(dP2).includes(line1) && dP3.c.activePlan().final.approvable === false && blockTexts(dP3).includes(line1) && !blockTexts(dP3).includes(line2)
    && dP2r.c.activePlan().final.approvable === false && blockTexts(dP2r).includes(line2) && JSON.stringify(reqOf(dP2r, 'R2').planRefs) === '["P3"]',
    `D9-6: 金額の境界は条件の向きまで確かめる（100万円未満の側を外す → R2、以上の側を外す → R1 が足りない。反対側の手順への付け替えでは消えない）: ${JSON.stringify({ P2: blockTexts(dP2), P3: blockTexts(dP3), P2remap: blockTexts(dP2r) })}`);
  //   (7) 2026-10-16（判定の責任範囲を絞る）: 明確な欠落と確認材料不足を分ける。構造で確かめられる欠落だけ反映を止め、確認材料不足は止めず計画の自動の見直しもしない
  //   a. ステータス名だけ（「承認済みになったとき申請者に通知する」）→ 確認材料不足（値が無い。通知の語から設定の種類を求めない）→ 反映は止めず、右に中立の 1 文
  const setR = (id, o) => (r) => (r.id === id ? { ...r, ...o } : r);
  const ha = await R.run({ reqMutate: setR('R5', { target: '通知', condition: '承認済みになったとき', behavior: '申請者に通知する', effects: [] }) });
  const quote5 = reqOf(ha, 'R5').sourceQuotes[0];
  //   b. 構造化した効果（編集不可）があるのにフィールドの語が無く、編集不可を持つ JavaScript が計画に無い（C1・C2 を外した）→ 明確な欠落（編集の禁止）
  const hb = await R.run({ reqMutate: setR('R3', { target: '', behavior: '編集できないようにする', effects: ['lock'] }), planMutate: (plan) => drop('C2')(drop('C1')(plan)) });
  //   c. 効果の構造が無い「金額を編集不可」（PC とモバイルの両方）で、PC に金額を扱うものが何も無い（C1・C2 を外した。モバイルの C3 だけが金額を扱う）→ 明確な欠落（PC）
  const hc = await R.run({ reqMutate: setR('R3', { target: '', behavior: '金額を編集不可にする', effects: [] }), planMutate: (plan) => drop('C2')(drop('C1')(plan)) });
  //   d. 効果の構造が無い新しい動作（「単価が0のときは保存を止める」）で、名前の挙がった既存のファイルを使う JavaScript（C3）を外した → 証拠はアプリにある既存のファイルだけ
  //      ＝確認材料不足（文から保存の停止を補って合否を決めない）→ 反映は止めず、自動の見直しもしない
  const hd = await R.run({ reqMutate: setR('R4', { behavior: '単価が0のときは保存を止める', effects: [] }), planMutate: drop('C3') });
  const quote3 = '承認済みでは金額と明細を変更できなくし、差戻し後は再編集できるようにして', quote4 = '今ある入力チェックは残して、PCとモバイルの両方で使いたい';
  const unconfLine = (q) => `「${q}」は、計画の構造からは実現を確かめていません（反映した後に動作テスト環境で確かめてください）`;
  const rightHas = (xx, q) => count(vis(R.rightHtml(xx)), `${unconfLine(q)}（この点では反映を止めていません）`) === 1;
  const leftLacks = (xx, q) => !vis(R.leftHtml(xx, { pre: READY })).includes(unconfLine(q));
  const passes = (xx) => xx.c.activePlan().final.approvable === true && !blockTexts(xx).length && xx.calls.plan.length === 1;
  assert(passes(ha) && rightHas(ha, quote5) && leftLacks(ha, quote5)
    && hb.c.activePlan().final.approvable === false && blockTexts(hb).includes(lineOf(quote3, '編集の禁止'))
    && hc.c.activePlan().final.approvable === false && blockTexts(hc).includes(lineOf(quote3, 'PC'))
    && passes(hd) && rightHas(hd, quote4),
    `D9-7: 構造で確かめられる欠落（構造化した効果を持つ JavaScript が無い・要件の言う画面に何も無い）だけ反映を止め、ステータス名だけ・効果の構造の無い新しい動作は確認材料不足（止めない・自動の見直しなし・右に中立の 1 文）: ${JSON.stringify({ a: [ha.c.activePlan().final.approvable, blockTexts(ha), ha.calls.plan.length], b: blockTexts(hb), c: blockTexts(hc), d: [hd.c.activePlan().final.approvable, blockTexts(hd), hd.calls.plan.length] })}`);
  //   (8) 見直しの LOW 5: 「モバイルは対象外」の否定はモバイルを求める語に数えない（C3 を外しても R4 は PC の既存のファイルで足りる）
  const hn = await R.run({ reqMutate: setR('R4', { condition: 'PCの入力・保存時（モバイルは対象外）' }), planMutate: drop('C3') });
  assert(hn.c.activePlan().final.approvable === true && !blockTexts(hn).length && hn.calls.plan.length === 1, `D9-8: 「モバイルは対象外」は画面の要求に数えない: ${JSON.stringify(blockTexts(hn))}`);
  //   (9) 2026-10-16（判定の責任範囲を絞る §3）: 維持・不追加の制限（「新しい入力チェックは追加しない」）は新しい実装の担当を求めない。変更の差分に違反が無ければ
  //   専用の手順・JavaScript が無いだけで止めず、計画の自動の見直しも呼ばない（確認材料不足として右に中立の 1 文）
  const neg = { target: '', condition: '', behavior: '新しい入力チェックは追加しない', effects: [] };
  const m3 = await R.run({ reqMutate: setR('R6', neg) });
  const quote6 = reqOf(m3, 'R6').sourceQuotes[0];
  assert(passes(m3) && rightHas(m3, quote6) && leftLacks(m3, quote6),
    `D9-9: 維持・不追加の要件は、専用の手順・JavaScript が無いだけで止めず、自動の見直しも呼ばない: ${JSON.stringify({ approvable: m3.c.activePlan().final.approvable, blockers: blockTexts(m3), plan: m3.calls.plan.length })}`);
  //   (10) 2026-10-16（判定の責任範囲を絞る §2・§6 の 3）: 効果の構造が無い要件は、文の語句（「変更できない」「保存を止める」「そのまま残し」）から効果・維持を補って合否を決めない。
  //   別の効果の JavaScript（C3 の保存の停止）が金額を扱うだけ・名前の挙がった既存のファイルがアプリにあるだけ → 確認材料不足（止めない・自動の見直しなし）
  const hv1 = await R.run({ reqMutate: setR('R3', { target: '', condition: '承認済み', behavior: '金額を変更できないようにする', effects: [] }), planMutate: (plan) => drop('C2')(drop('C1')(plan)) });
  const hv2 = await R.run({ reqMutate: setR('R4', { target: 'dealValidate.js', condition: '保存時', behavior: '今の入力チェックはそのまま残し、単価が0のときも保存を止める', effects: [] }), planMutate: drop('C3') });
  assert(passes(hv1) && rightHas(hv1, quote3) && passes(hv2) && rightHas(hv2, quote4),
    `D9-10: 効果の構造が無い要件は文から効果・維持を補わず、確認材料不足として止めない（自動の見直しなし）: ${JSON.stringify({ v1: [hv1.c.activePlan().final.approvable, blockTexts(hv1), hv1.calls.plan.length], v2: [hv2.c.activePlan().final.approvable, blockTexts(hv2), hv2.calls.plan.length] })}`);
  //   (11) 「承認者は今の作業者の指定のままにする」（値の無い維持の要件）も止めない（確認材料不足。「のまま」の語で維持できたとも決めない）
  const keep6 = await R.run({ reqMutate: setR('R6', { target: '', condition: '', behavior: '承認者は今の作業者の指定のままにする', effects: [] }) });
  assert(passes(keep6) && rightHas(keep6, reqOf(keep6, 'R6').sourceQuotes[0]), `D9-11: 値の無い維持の要件は止めない（確認材料不足）: ${JSON.stringify(blockTexts(keep6))}`);
});

// =========================================================
console.log('\n--- §D10. 判定の責任範囲（2026-10-16）: 明確な欠落・検証の不一致・確認材料不足を分け、確認材料不足だけで止めない・有料の見直しへ送らない ---');
await section(async () => {
  const drop = (cid) => (plan) => { plan.customizations = plan.customizations.filter(c => c.customizationId !== cid); plan.steps = plan.steps.filter(s => s.id !== cid); return plan; };
  const blockTexts = (xx) => xx.c.activePlan().final.blockers.map(b => b.text);
  const lineOf = (quote, what) => `「${quote}」を実現する計画の手順・JavaScript が足りません（計画に無いもの: ${what}）`;
  const quote3 = '承認済みでは金額と明細を変更できなくし、差戻し後は再編集できるようにして';
  //   (1) 実装を除く（§D9-1・2・6 と B5 の続き）: 計画の AI が要件を結び付けていた JavaScript が計画から外れ、ほかに証拠が無い → 明確な欠落（参照先が消えた）
  const dang = await R.run({ planOps: (n, args) => (n !== 0 ? [] : (args.requirements || []).filter(r => r && r.id === 'R6').map(r => ({ op: 'update', id: r.id, target: r.target || '', condition: '', behavior: '承認者の指定は今のままにする', exceptions: [], decision: r.decision, disposition: 'adopted', sourceQuotes: clone(r.sourceQuotes || []), planRefs: ['B4', 'C9'], note: '', effects: [] }))) });
  assert(dang.c.activePlan().final.approvable === false && blockTexts(dang).some(t => t.endsWith('（計画に無いもの: 対応づけられていた手順・JavaScript（計画から外れました））')) && dang.calls.plan.length === 2,
    `D10-1: 対応づけられていた手順・JavaScript が計画から外れ、ほかに証拠が無い要件は明確な欠落として止める（自動の見直し 1 回）: ${JSON.stringify({ blockers: blockTexts(dang), plan: dang.calls.plan.length })}`);
  //   (2) 構造化した効果が違う: 「編集不可」（R3 の effects lock）が必要なのに、計画の JavaScript は同じフィールドに「保存の停止」しか持たない → 明確な欠落（編集の禁止）
  const eff = await R.run({ planMutate: (plan) => { for (const c of plan.customizations.filter(c => ['C1', 'C2'].includes(c.customizationId))) for (const f of c.fields) if ((f.effects || []).some(e => e.effect === 'lock')) f.effects = [{ effect: 'block-save', condition: '' }]; return plan; } });
  assert(eff.c.activePlan().final.approvable === false && blockTexts(eff).includes(lineOf(quote3, '編集の禁止')), `D10-2: 構造化した効果が違う（編集不可が必要なのに保存の停止だけ）は通さない: ${JSON.stringify(blockTexts(eff))}`);
  //   (3)・(4) 効果の構造が無い要件・維持・不追加の要件は §D9-7・9〜11（止めない・自動の見直しなし）。
  //   (4) 未採用の検査の追加: 計画の AI の対応づけがあれば、採用範囲の判定（requirementScopeOf）が計画の足した「数量の保存の停止」を範囲外として外し、知らせる。
  //   対応づけの無い計画（§12.31 の形）では範囲を判定できず外れない（既存の限界。その検査は必須の動作として生成の検証に回る）
  const clone2 = (x) => JSON.parse(JSON.stringify(x));
  const MAP = { R1: ['P3'], R2: ['P2'], R3: ['C1', 'C2'], R4: ['C1', 'C3'], R5: ['P1'], R6: ['P1', 'P2'] };
  const mapOps = (n, args) => (n !== 0 ? [] : (args.requirements || []).filter(r => r && MAP[r.id]).map(r => ({ op: 'update', id: r.id, target: r.target || '', condition: r.condition || '', behavior: r.behavior, exceptions: clone2(r.exceptions || []), decision: r.decision, disposition: r.disposition || 'adopted', sourceQuotes: clone2(r.sourceQuotes || []), planRefs: MAP[r.id], note: '', ...(Array.isArray(r.effects) ? { effects: clone2(r.effects) } : {}) })));
  const addEff = (cid, field, effect) => (plan) => { const c = plan.customizations.find(z => z.customizationId === cid); const f = c.fields.find(z => z.code === field); f.effects = [...(f.effects || []), { effect, condition: '' }]; return plan; };
  const neg = (r) => (r.id === 'R6' ? { ...r, target: '', condition: '', behavior: '新しい入力チェックは追加しない', effects: [] } : r);
  const add4 = await R.run({ reqMutate: neg, planOps: mapOps, planMutate: addEff('C2', 'qty', 'block-save') });
  const add4n = await R.run({ reqMutate: neg, planMutate: addEff('C2', 'qty', 'block-save') });
  const so4 = add4.c.activePlan().final.scopeOut || {}, so4n = add4n.c.activePlan().final.scopeOut || {};
  assert(so4.notice === '依頼に無い「数量の保存の停止」は入れていません（詳細）' && (so4n.lines || []).length === 0,
    `D10-4: 未採用の検査の追加は、計画の AI の対応づけがあれば採用範囲の判定で外して知らせる（対応づけが無いと判定できない＝既存の限界の記録）: ${JSON.stringify({ mapped: so4, unmapped: so4n })}`);
  //   (5) 同じ動作・違う言い回し: 採用した構造（値・効果・対象）と成果物は同じまま要件の文を言い換えても、合否と計画の呼び出しの回数は §D1 と同じ
  const para = await R.run({ reqMutate: (r) => (r.id === 'R2' ? { ...r, condition: '金額が1,000,000円未満', behavior: '課長の承認とする' } : r.id === 'R3' ? { ...r, behavior: '金額と明細を変更できないようにする' } : r.id === 'R4' ? { ...r, behavior: '今の入力チェックを引き続きPCとモバイルで使う' } : r) });
  assert(para.c.activePlan().final.approvable === true && !blockTexts(para).length && para.calls.plan.length === 1 && !(para.c.activePlan().final.unconfirmedReqs || []).length,
    `D10-5: 言い回しを変えても合否と自動の見直しの回数は変わらない: ${JSON.stringify({ approvable: para.c.activePlan().final.approvable, blockers: blockTexts(para), plan: para.calls.plan.length })}`);
  //   (6) 警告の合意の有無（台本の模擬の利用者の発言。実際の会話の記録ではない）: 利用者が「警告も出して」と言い、計画の AI がその要件を構造化した効果（warn）で記録した → 警告を持たない JavaScript では明確な欠落・生成の検証の不一致で止める。
  //   計画の AI が依頼に無い警告を JavaScript に足した → 採用範囲を超えた計画として外す（対応づけがあるとき。警告に実装を合わせることを正解にしない）
  let addedU = false;
  const U = K.req('add', { target: '金額', condition: '承認待ち', behavior: '画面に警告を出す', sourceQuotes: ['警告も出して'], planRefs: ['C1'], effects: ['warn'] });
  const xa = K.makeConvC({ planImpl: (args) => K.planJs(args, { requirementOps: args.revision && !addedU ? (addedU = true, [U]) : [] }) });
  await K.adoptC(xa); await xa.c.send('警告も出して');
  const va = xa.c.activePlan(), ra = xa.c.requirements(va.planId).find(r => r.behavior === '画面に警告を出す');
  const warnB = va.final.blockers.map(b => b.text);
  const w6 = await R.run({ planOps: mapOps, planMutate: addEff('C1', 'amount', 'warn') });
  const so6 = w6.c.activePlan().final.scopeOut || {};
  assert(ra && ra.decision === 'decided' && JSON.stringify(ra.effects) === '["warn"]' && va.final.approvable === false && warnB.includes('「警告も出して」を実現する計画の手順・JavaScript が足りません（計画に無いもの: 警告）') && warnB.filter(t => /警告も出して/.test(t)).length === 1 && warnB.some(t => /要件未達/.test(t))
    && so6.notice === '依頼に無い「金額の警告」は入れていません（詳細）',
    `D10-6: 合意した警告の実装漏れは止め（構造の欠落と検証の不一致）、計画の AI が勝手に足した警告は採用範囲の外として外す: ${JSON.stringify({ agreed: warnB, unagreed: so6 })}`);
  //   (7) 表示: 確認材料不足は右の「確認できないこと」に 1 回（反映を止めていないと添える）、左の通常表示と反映を止める理由には出さない。反映の前の確認（生成の検査・登録前の再検査）の
  //   計画全体の確認も同じ文（implementationGaps）
  const ux = await R.run({ reqMutate: neg });
  const vux = ux.c.activePlan(), q6 = ux.c.requirements(vux.planId).find(r => r.id === 'R6').sourceQuotes[0];
  const lineU = `「${q6}」は、計画の構造からは実現を確かめていません（反映した後に動作テスト環境で確かめてください）`;
  assert(ux.c.implementationGaps(vux).R6 === lineU && count(vis(R.rightHtml(ux)), `${lineU}（この点では反映を止めていません）`) === 1 && !vis(R.leftHtml(ux, { pre: READY })).includes(lineU) && /この内容で反映できます/.test(vis(R.leftHtml(ux, { pre: READY }))) && !vux.final.blockers.length,
    `D10-7: 確認材料不足は右に 1 回・左は「反映できます」のまま・反映の前の確認と同じ文: ${JSON.stringify({ gap: ux.c.implementationGaps(vux), blockers: vux.final.blockers.map(b => b.text) })}`);
});

// =========================================================
console.log('\n--- §D11. 依頼・採用内容から計画への引き継ぎ（2026-10-16）: 採用した要件の構造・決めたこと・根拠の発言が計画の呼び出しへ渡り、取り込みで消えない ---');
await section(async () => {
  const clone3 = (x) => JSON.parse(JSON.stringify(x));
  //   (1) 要求: §12.31 の実際の素材（仮案 rev 2・要件 R1〜R6・決めたこと 2 件）を会話に通し、計画の呼び出しに渡る引数（requirements・decisions・goal）を見る（計画の AI は呼ばない）
  const seen = [];
  const x = await R.run({ planOps: (n, args) => { seen.push({ n, goal: args.goal, requirements: clone3(args.requirements || []), decisions: clone3(args.decisions || []) }); return []; } });
  const a0 = seen[0] || {};
  const pick = (r) => JSON.stringify([r.id, r.target, r.condition, r.behavior, r.decision, r.planRefs, r.effects || [], r.sourceQuotes]);
  const want = (F.LEDGER_REQUIREMENTS || []).map(pick), got = (a0.requirements || []).map(pick);
  const sugText = '任意の追加案：承認済みの明細の行追加・削除を保存時に検出して保存を止める。';
  assert(JSON.stringify(got) === JSON.stringify(want) && (a0.decisions || []).length === 2 && (a0.decisions || []).every(d => d.answer === '今の「承認待ち」の作業者指定を使用する。') && /採用した方針: /.test(a0.goal || '') && !String(a0.goal || '').includes(sugText.slice(0, 12)) && seen.length === 1,
    `D11-1: 採用した要件（対象・条件・動作・決定の状態・仮案の項目への結び付き・構造化した効果・根拠の発言）と決めたこと 2 件が、そのまま計画の呼び出しに渡る。任意の提案（未採用）は採用した方針に入らない: ${JSON.stringify({ diff: got.filter((g, i) => g !== want[i]), decisions: (a0.decisions || []).map(d => [d.label, d.answer]), goal: String(a0.goal || '').slice(-120) })}`);
  //   (2) 取り込み: 計画の AI が R3 の担当だけを付け替え、内容は同じ・根拠は前の発言を写しただけ・効果を省いた（Gateway は省いた effects を [] にして渡す）update を返した
  //   → 採用した効果（編集不可）と決定の状態を消さない。承認できるかは見ない（計画の AI が R3 を JavaScript に対応づけると、対象が金額・明細の 2 つの要件から
  //   必須の動作のフィールドを 1 つに決められない既存の別の制約で止まる。評価の記録 §12.35 の残る限界）
  const remapR3 = (n, args) => (n !== 0 ? [] : (args.requirements || []).filter(r => r && r.id === 'R3').map(r => ({ op: 'update', id: r.id, target: r.target, condition: r.condition, behavior: r.behavior, exceptions: clone3(r.exceptions || []), decision: 'decided', disposition: 'adopted', sourceQuotes: clone3(r.sourceQuotes || []), planRefs: ['C1', 'C2'], decisionRefs: [], effects: [], note: '' })));
  const y = await R.run({ planOps: remapR3 });
  const r3 = y.c.requirements(y.c.activePlan().planId).find(r => r.id === 'R3');
  assert(r3 && JSON.stringify(r3.effects) === '["lock"]' && r3.decision === 'decided' && JSON.stringify(r3.planRefs) === '["C1","C2"]',
    `D11-2: 内容を変えない update（担当の付け替えだけ・効果を省いた）では、採用した効果と決定の状態を消さない: ${JSON.stringify({ r3: r3 && [r3.decision, r3.planRefs, r3.effects] })}`);
  //   (3) 内容を変える update（動作の言い換え）は計画の AI の変更として操作の値にする（今回の発言に根拠が無いので AI の提案に下げる。前の内容は台帳の履歴に残る）。
  //   取り込みで勝手に元の値を残して「採用済み」に見せない
  const rewriteR3 = (n, args) => (n !== 0 ? [] : (args.requirements || []).filter(r => r && r.id === 'R3').map(r => ({ op: 'update', id: r.id, target: r.target, condition: r.condition, behavior: '金額と明細を変更できないようにする', exceptions: clone3(r.exceptions || []), decision: 'decided', disposition: 'adopted', sourceQuotes: [], planRefs: ['C1', 'C2'], decisionRefs: [], effects: [], note: '' })));
  const z = await R.run({ planOps: rewriteR3 });
  const z3 = z.c.requirements(z.c.activePlan().planId).find(r => r.id === 'R3');
  assert(z3 && z3.decision === 'proposed' && JSON.stringify(z3.effects) === '[]' && z3.behavior === '金額と明細を変更できないようにする',
    `D11-3: 内容を変える根拠の無い update は計画の AI の変更として記録する（AI の提案。元の値を残して採用済みに見せない）: ${JSON.stringify(z3 && [z3.decision, z3.effects, z3.behavior])}`);
  //   (4) 構造の無い要件に効果を足さない: 台本の要件（効果を持たない）は、計画の呼び出しにも効果の無いまま渡る（推定した効果を足さない）。計画の呼び出しは 1 回
  const w = K.makeConvC({ planImpl: (args) => K.planJs(args) });
  let reqsSent = null;
  const planW = w.services.plan;
  w.services.plan = async (args) => { if (!reqsSent) reqsSent = clone3(args.requirements || []); return planW(args); };
  await K.adoptC(w);
  assert(Array.isArray(reqsSent) && reqsSent.length > 0 && reqsSent.every(r => !('effects' in r) || (Array.isArray(r.effects) && !r.effects.length)) && w.calls.plan.length === 1,
    `D11-4: 構造化した効果の無い要件に、要求の組み立てで効果を足さない（計画の呼び出し 1 回）: ${JSON.stringify({ effects: (reqsSent || []).map(r => [r.id, r.effects]), plan: w.calls.plan.length })}`);
});
// =========================================================
console.log('\n--- §D7. 画面: 反映の前の確認の再検査も、生成の検査と同じ要件の台帳と担当の集まりで担当を引く（左のカード・右の変更内容と同じ文） ---');
await section(async () => {
  //   台本の要件 R4（7 営業日以内に承認する）を、計画の AI は JavaScript C1 に対応づける（画面の偽の計画の AI の要件の対応づけ）。生成の AI（C1）は R4 を担当外と申告する
  //   → 担当の JavaScript 自身の担当外の申告（self の文）。反映の前の再検査に要件の台帳と担当の集まりが渡っていなければ「担当範囲外とされた要件…計画に見つかりません」になる
  const { m, v } = await K.mountFinal({ kind: 'js', coverage: [{ requirementId: 'C1', status: 'MET', note: '' }, { requirementId: 'R4', status: 'OUT_OF_SCOPE', note: '期限はプロセス管理の設定で扱う', text: '7 営業日以内に承認する' }] });
  const { pre } = await K.prepareOnScreen(m);
  const line = '「7 営業日以内に承認する」は、担当の JavaScript では担当外とされました。どこで実現するかは計画に書かれていません';
  const confs = (pre && pre.items && Array.isArray(pre.items.confirmations) ? pre.items.confirmations : []).map(c => (c && typeof c === 'object' ? c.text : String(c)));
  const fin = v && v.final, chat = m.chat(), L = vis(chat), RV = vis(KTAiChatUi.changeSummaryHtml(m.conv().activePlan(), {}));
  const ledgerR4 = m.conv().requirements(v.planId).find(r => r.id === 'R4');
  //   反映の前の確認の確認項目は、同じ文の後ろに確かめ方（HOW_TO_CHECK の coverage-owner）を括弧で添える
  assert(ledgerR4 && JSON.stringify(ledgerR4.planRefs) === '["C1"]' && fin && fin.approvable === true && pre && pre.status === 'ready' && confs.filter(t => t === `${line}（計画のどの手順で扱われているかを変更内容の「何が変わるか」で確かめ、扱われていなければ計画を直す）`).length === 1 && !confs.some(t => OWNERLESS_RE.test(t)) && count(L, line) === 1 && count(RV, line) === 1 && !OWNERLESS_RE.test(L + RV),
    `D7-1: 画面の反映の前の確認の確認項目・左のカード・右の変更内容に同じ文 1 回ずつ（「担当範囲外とされた要件…計画に見つかりません」は出ない。反映は止めない）: ${JSON.stringify({ planRefs: ledgerR4 && ledgerR4.planRefs, approvable: fin && fin.approvable, status: pre && pre.status, confs })}`);
});

console.log(`\n${state.failed === 0 ? 'ALL PASSED' : 'FAILED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed === 0 ? 0 : 1);
})();
