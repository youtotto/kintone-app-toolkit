// KTContext.buildPlan（AI Change Planner の Planner Context。contextVersion "planner-1"）
//
// 検証内容（Phase 7 §36）:
//   - 単一フィールドの goal / 複数フィールドの goal / プロセス＋通知 / 不足フィールド / 既存の再利用候補 / 曖昧な候補（同じラベル）
//   - 新規提案が必要な goal（一致する既存が無い）/ ルックアップの拡張 / リマインダー / JS の影響 / 他アプリからの参照
//   - 大規模アプリ（フィールド 300 件）でのサイズ・省略（truncation）/ dictionary / 決定性 / full DEPS を送らない / 秘密情報の伏字
//
// 実行方法: node tests/ai-planner-context.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { KTDeps, KTScan, KTContext } = loadToolkit();
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');

function buildInputs({ withScan = true, withIncoming = true, mutate = null } = {}) {
  const data = FX.makeData();
  if (mutate) mutate(data);
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  let scan = null;
  if (withScan) {
    scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files: FX.files, fields: fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType })), deps, skippedUrlFiles: FX.skippedUrlFiles });
    KTDeps.mergeScannerEdges(deps, scan);
  }
  if (withIncoming) KTDeps.applyIncomingRefs(deps, FX.incoming);
  return { data, deps, scan, incoming: withIncoming ? FX.incoming : null };
}
const plan = (goal, inputs = buildInputs(), options = {}) => KTContext.buildPlan({ goal, ...inputs, options: { now: '2026-10-02T00:00:00.000Z', ...options } });
const fieldFact = (ctx, code) => ctx.facts.find(f => f.kind === 'field' && f.field?.code === code);
const cand = (ctx, code) => ctx.retrieval.fields.find(c => c.code === code);

(async () => {
console.log('\n--- 1. 構造・決定性 ---');
{
  const ctx = plan('担当者が設定されたら本人に通知したい');
  assert(ctx.contextVersion === 'planner-1' && ctx.goal === '担当者が設定されたら本人に通知したい' && ctx.app && !ctx.app.fields && Array.isArray(ctx.facts) && ctx.dictionary && ctx.retrieval && ctx.coverage && ctx.truncation && ctx.size, 'planner-1 の構造（goal / app / facts / dictionary / retrieval / coverage / truncation / size）');
  assert(ctx.facts.every((f, i) => f.id === `E${i + 1}`) && new Set(ctx.facts.map(f => f.key)).size === ctx.facts.length, '根拠ID は E1.. の連番・key は一意');
  const kinds = [...new Set(ctx.facts.map(f => f.kind))];
  assert(['overview', 'field', 'process-state', 'process-action', 'notification', 'reminder', 'view', 'record-acl', 'field-acl', 'app-action', 'dependency', 'js-reference', 'incoming-reference'].every(k => kinds.includes(k)), `既存資産の種別が揃う（${kinds.join(',')}）`);
  const again = plan('担当者が設定されたら本人に通知したい');
  assert(JSON.stringify(ctx) === JSON.stringify(again), '同じ入力なら同じ Context（決定的）');
  assert(ctx.facts.filter(f => f.kind === 'field').length === KTDeps.normalizeFields(FX.makeData().fields).length, '全フィールドの軽量情報（code / label / type / required / options / lookup / 計算式）が facts に入る');
  const d = ctx.dictionary;
  assert(d.fieldCodes.includes('amount') && d.fieldLabels.includes('担当者') && d.statuses.join(',') === '未処理,承認待ち,完了' && d.processActions.includes('申請する') && d.notifications.includes('perRecord#1') && d.reminders.includes('reminder#1') && d.views.includes('承認待ち') && d.appActions.includes('見積を作成') && d.jsFiles.length >= 2, 'dictionary: 既存識別子の一覧（幻覚検出用）');
  assert(!JSON.stringify(ctx).includes('sk_live_') && !JSON.stringify(ctx).includes('abcdefgh12345678ZZZZ'), '秘密情報らしき文字列は含まない');
  assert(!('edges' in ctx) && !('nodes' in ctx) && !JSON.stringify(ctx).includes('"sourceType"'), 'full DEPS（edges / nodes）は送らない');
  assert(ctx.size.approxTokens < 30000, `サイズは 30k tokens 未満（${ctx.size.approxTokens}）`);
}

console.log('\n--- 2. retrieval（goal → 関連候補）---');
{
  const ctx = plan('担当者が設定されたら本人に通知したい');
  assert(cand(ctx, 'owner') && cand(ctx, 'owner').score >= 10 && cand(ctx, 'owner').evidenceId === fieldFact(ctx, 'owner').id, '単一フィールド: 「担当者」(owner) が最上位候補で根拠ID 付き');
  assert(ctx.retrieval.settings.includes('notification') && ctx.retrieval.matchedTerms.some(t => t.key === '担当者'), '通知のヒント・一致した語');
  const notif = ctx.facts.filter(f => f.kind === 'notification');
  assert(notif.length >= 3 && notif.some(f => f.notification?.target?.code === 'owner'), '通知の facts（既存の owner 宛て通知を含む）');
}
{
  const ctx = plan('金額が100万円以上なら部長承認を追加して、承認されたら営業担当者に通知したい');
  const top = ctx.retrieval.fields.slice(0, 5).map(c => c.code);
  assert(top.includes('amount') && top.includes('owner') && cand(ctx, 'approver'), `複数フィールド: 金額 / 担当者 / 承認者が候補（${top.join(',')}）`);
  assert(ctx.retrieval.settings.includes('process-state') && ctx.retrieval.settings.includes('notification'), 'プロセス＋通知のヒント');
  const states = ctx.facts.filter(f => f.kind === 'process-state');
  assert(states.map(f => f.state?.name).join(',') === '未処理,承認待ち,完了' && states[1].state.assignees.some(e => e.type === 'FIELD_ENTITY' && e.code === 'approver'), 'ステータスは index 順・作業者（FIELD_ENTITY approver）付き');
  assert(ctx.facts.some(f => f.kind === 'process-action' && f.action?.filterCond.includes('amount')), 'プロセスアクションの条件式');
  assert(!ctx.dictionary.fieldCodes.includes('部長承認者') && !ctx.dictionary.fieldLabels.includes('部長承認者'), '不足フィールド: 「部長承認者」は既存に無い（AI が新規提案する余地。dictionary で判定できる）');
}
{
  const ctx = plan('承認時に責任者にも通知したい');
  const users = ctx.retrieval.fields.filter(c => c.type === 'USER_SELECT').map(c => c.code);
  assert(users.length >= 3 && users.includes('owner') && users.includes('approver') && users.includes('pic_sales'), `曖昧な候補: ユーザー選択フィールドが複数候補に残る（${users.join(',')}。勝手に 1 つへ決めない）`);
  assert(cand(ctx, 'approver') && cand(ctx, 'approver').reasons.some(r => r.includes('承認')), '既存の再利用候補: 「承認者」が「承認」の語で候補に上がる');
}
{
  const ctx = plan('製品の在庫数を管理したい');
  assert(ctx.retrieval.fields.every(c => c.score < 10), '一致する既存フィールドが無い goal: 完全一致の候補は無い（新規提案が必要になる）');
  assert(ctx.facts.filter(f => f.kind === 'field').length > 0, 'それでも全フィールドの一覧は送る');
}
{
  const ctx = plan('顧客マスタから住所と電話番号も自動で取得したい');
  const lk = fieldFact(ctx, 'customer_lookup');
  assert(cand(ctx, 'customer_lookup') && lk.field.lookup && lk.field.lookup.app === String(FX.CUSTOMER_APP) && lk.field.lookup.mappings.length === 2 && lk.statement.includes('項目を取得'), 'ルックアップの拡張: 既存ルックアップ（コピー元アプリ・取得項目）が候補と facts に入る');
  assert(ctx.retrieval.settings.includes('app-link') && ctx.facts.some(f => f.kind === 'app-link'), 'アプリ間連携のヒントと facts');
  assert(!ctx.dictionary.fieldCodes.some(c => /address|tel|phone/.test(c)), 'コピー先（住所・電話番号）は既存に無い');
}
{
  const ctx = plan('契約終了日の30日前に担当者へ通知したい');
  assert(ctx.retrieval.settings.includes('reminder') && ctx.facts.some(f => f.kind === 'reminder' && f.reminder.timing.code === 'due_date' && f.reminder.timing.daysLater === '-1'), 'リマインダー: 既存リマインダー（基準フィールド・日数）が facts に入る');
  assert(cand(ctx, 'due_date') && cand(ctx, 'owner'), 'DATE 型と担当者が候補');
}

console.log('\n--- 3. 影響（JS・他アプリ）・省略 ---');
{
  const ctx = plan('顧客コードの入力方法を変えたい');
  const js = ctx.facts.filter(f => f.kind === 'js-reference' && f.target?.id === 'customer_code');
  assert(js.length >= 2 && js.every(f => f.relevance >= 4), 'JS の影響: 関連フィールドを参照する JavaScript が高い関連度で入る');
  const inc = ctx.facts.filter(f => f.kind === 'incoming-reference');
  assert(inc.length >= 2 && inc.every(f => f.statement.includes('他アプリからの被参照')), '他アプリからの参照（ルックアップ・関連レコード）');
  const dep = ctx.facts.filter(f => f.kind === 'dependency' && f.target?.id === 'customer_code');
  assert(dep.length >= 3, '依存関係は関連フィールドのものを優先して入れる');
  const noJs = plan('顧客コードの入力方法を変えたい', buildInputs({ withScan: false, withIncoming: false }));
  assert(noJs.coverage.javascript === false && noJs.coverage.incoming === false && !noJs.facts.some(f => f.kind === 'js-reference'), '未解析のときは coverage false・JS facts 無し');
}
{
  // 大規模アプリ: フィールド 300 件・通知 40 件
  const inputs = buildInputs({ mutate: (data) => {
    for (let i = 0; i < 300; i++) data.fields[`extra_${i}`] = { type: i % 3 === 0 ? 'NUMBER' : 'SINGLE_LINE_TEXT', code: `extra_${i}`, label: `追加項目${i}`, noLabel: false, required: false };
    data.generalNotify.notifications = Array.from({ length: 40 }, (_, i) => ({ entity: { type: 'USER', code: `u${i}` }, includeSubs: false, recordAdded: true, recordEdited: false, commentAdded: false, statusChanged: false, fileImported: false }));
  } });
  const ctx = plan('金額が100万円以上なら部長承認を追加したい', inputs);
  assert(ctx.truncation.applied && ctx.truncation.sections.some(s => s.name === 'facts.field' || s.name === 'facts') && ctx.truncation.sections.some(s => s.name === 'facts.notification.general'), `大規模アプリ: 省略を truncation に記録（${ctx.truncation.sections.map(s => s.name).join(',')}）`);
  assert(ctx.size.bytes <= KTContext.PLANNER_LIMITS.maxBytes && ctx.size.approxTokens < 30000, `サイズ上限内（${ctx.size.bytes} bytes / ${ctx.size.approxTokens} tokens）`);
  assert(fieldFact(ctx, 'amount') && cand(ctx, 'amount'), '関連フィールド（金額）は省略されず残る');
  assert(ctx.dictionary.fieldCodes.length === 300 + KTDeps.normalizeFields(FX.makeData().fields).length, 'dictionary は省略しない（全フィールドコード）');
  const small = plan('金額が100万円以上なら部長承認を追加したい', inputs, { limits: { maxBytes: 16 * 1024 } });
  assert(small.size.bytes < ctx.size.bytes && small.facts.length < ctx.facts.length && small.facts.some(f => f.kind === 'overview') && fieldFact(small, 'amount') && small.dictionary.fieldCodes.length === ctx.dictionary.fieldCodes.length, 'バイト上限を下げると facts を関連度順に減らす。overview・関連フィールド・dictionary は残る');
}

console.log('\n--- 4. 出力（無料: Prompt / Markdown）---');
{
  const ctx = plan('契約更新を管理して、終了30日前に担当者へ通知したい');
  const md = KTContext.toPlannerMarkdown(ctx);
  const pr = KTContext.toPlannerPrompt(ctx);
  assert(md.includes('Change Planner Context') && md.includes('**実現したいこと**') && md.includes('[E1]') && md.includes('### field'), 'Markdown: 実現したいこと・facts（根拠ID）');
  assert(pr.includes('既存のフィールド・設定だけで実現できないか') && pr.includes('JavaScript カスタマイズは最後の手段') && pr.includes('## 実現したいこと'), 'Prompt: 考える順序・標準機能優先の指示');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
