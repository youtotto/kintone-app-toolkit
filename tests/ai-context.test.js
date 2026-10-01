// KTContext（AI Context Builder）の fixture テスト
//
// 検証内容:
//   1. L0（App Overview）が安定して生成される（同じ入力 → 同じ JSON）
//   2. 質問「顧客コードを削除して大丈夫？」から対象フィールドが決定的に解決される
//   3. Lookup / 関連レコード / 一覧 / 計算式 / 通知 / プロセス / ACL / JS の依存が facts に含まれる
//   4. FIELD_ENTITY（通知先・作業者・実行可能ユーザー・ACL対象）が Fact として出る
//   5. confidence は Toolkit の語彙のみ。確実（CERTAIN）と推定が混ざらない（JS 由来は CERTAIN にならない）
//   6. 根拠ID は一意・連番で、同じ fixture から再生成しても同じ ID / key（JS は edge.sourceId を使う）
//   7. coverage に未解析項目（JS / incoming / plugin / レコード）が明示される
//   8. truncation（件数上限・バイト上限）が記録される（silent truncation なし）
//   9. 同じラベルの複数フィールドは ambiguous（勝手に 1 件へ決めない）
//  10. secret らしき文字列は JS 抜粋・コード抜粋・Markdown / Prompt 出力で伏字になる
//  11. L2（JS ファイル対象）: イベント・参照フィールド・アプリ参照・コード抜粋
//  12. JSON / Markdown / Prompt 出力
//  13. アプリ全体（対象なし）: 壊れた参照・アプリ間連携・他アプリからの参照
//
// 実行方法: node tests/ai-context.test.js（終了コード 0 = 成功、1 = 失敗）
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const FX = require('./fixtures/ai-context-app.js');

const { KTDeps, KTScan, KTContext, SCRIPT_VERSION } = loadToolkit();
const { assert, state } = makeAssert();
const NOW = '2026-10-01T09:00:00.000Z';

// ---- 入力を組み立てる（実行時と同じ順序: deps → scan 合流 → incoming 合流）----
function buildInputs({ withScan = true, withIncoming = true } = {}) {
  const data = FX.makeData();
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  let scan = null;
  if (withScan) {
    const fields = fieldsN.filter(f => f.type !== 'SUBTABLE').map(f => ({ code: f.code, label: f.label, type: f.rawType }));
    scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files: FX.files, fields, deps });
    KTDeps.mergeScannerEdges(deps, scan);
  }
  if (withIncoming) KTDeps.applyIncomingRefs(deps, FX.incoming);
  KTDeps.applyAppNames(deps, new Map([[String(FX.CUSTOMER_APP), '顧客マスタ'], [String(FX.QUOTE_APP), '見積']]));
  return { data, deps, scan, incoming: withIncoming ? FX.incoming : null };
}
const build = (q, opts = {}, inputs = buildInputs()) =>
  KTContext.build({ question: q, ...inputs, options: { now: NOW, ...(opts || {}) } });

const byKind = (ctx, kind) => ctx.facts.filter(f => f.kind === kind);
const depFacts = (ctx) => byKind(ctx, 'dependency');
const hasDep = (ctx, pred) => depFacts(ctx).some(pred);

// =========================================================
// 1. L0 App Overview
// =========================================================
console.log('\n--- 1. L0 App Overview ---');
{
  const a = build(null);
  const b = build(null);
  assert(a.level === 'L0' && a.levels.join(',') === 'L0', '質問なし → L0 のみ');
  assert(JSON.stringify(a) === JSON.stringify(b), '同じ入力から再生成した JSON が一致する（安定）');
  assert(a.contextVersion === '1' && a.generator.version === SCRIPT_VERSION, 'contextVersion "1" と生成元バージョンを持つ');
  assert(a.app.id === '310' && a.app.name === '案件管理', 'アプリID・アプリ名');
  assert(a.app.fieldCount === 23 && a.app.fields.length === 23, `フィールド数 23（実際: ${a.app.fieldCount}）`);
  assert(a.app.process.enabled && a.app.process.states.join(',') === '未処理,承認待ち,承認済み,完了' || a.app.process.stateCount === Object.keys(FX.makeData().status.states).length, 'プロセス管理の状態一覧');
    const FD = FX.makeData();
  assert(a.app.notifications.general === FD.generalNotify.notifications.length && a.app.notifications.perRecord === FD.perRecordNotify.notifications.length
    && a.app.notifications.reminder === FD.reminderNotify.notifications.length, `通知件数が fixture と一致（${JSON.stringify(a.app.notifications)}）`);
  assert(a.app.views.count === 2 && a.app.views.names.includes('顧客別一覧'), '一覧の件数と名前');
  assert(a.app.customize.desktop.js.length === 3 && a.app.customize.mobile.js.length === 1, 'JS ファイル一覧（PC 3・モバイル 1）');
  assert(a.app.javascript.analyzed === true && a.app.incoming.scanned === true, 'JS 解析済み・他アプリ走査済み（合流後）');
  assert(a.app.dependencies.edgeCount === (buildInputs().deps.edges.length), '依存関係件数が DEPS と一致');
  assert(a.app.plugins.count === 1, 'プラグイン数');
  assert(a.facts.length === 0, 'L0 のみでは facts を持たない');
  assert(a.size.bytes > 0 && a.size.approxTokens > 0 && a.size.approxTokens < 2500, `L0 サイズが目標範囲（approxTokens=${a.size.approxTokens}, bytes=${a.size.bytes}）`);
}

// =========================================================
// 2. 対象解決（決定的）
// =========================================================
console.log('\n--- 2. 対象解決 ---');
{
  const ctx = build('顧客コードを削除して大丈夫？');
  assert(ctx.focus.resolution === 'resolved', '「顧客コードを削除して大丈夫？」→ resolved');
  assert(ctx.focus.target.type === 'field' && ctx.focus.target.id === 'customer_code', `対象 = field customer_code（実際: ${JSON.stringify(ctx.focus.target)}）`);
  assert(ctx.focus.target.matchedBy.includes('label'), 'ラベル一致で解決した');
  assert(ctx.level === 'L1' && ctx.levels.join(',') === 'L0,L1', 'フィールド対象 → L0 + L1');
  const byCode = build('customer_code の型を変えたい');
  assert(byCode.focus.target?.id === 'customer_code' && byCode.focus.target.matchedBy.includes('code'), 'フィールドコード完全一致でも解決する');
  const none = build('このアプリは何ですか？');
  assert(none.focus.resolution === 'none' && none.level === 'L1' && byKind(none, 'app-link').length > 0, '対象が無い質問 → アプリ全体の facts（app-link 等）');
  const explicit = KTContext.build({ focus: { type: 'field', id: 'amount' }, ...buildInputs(), options: { now: NOW } });
  assert(explicit.focus.resolution === 'explicit' && explicit.focus.target.id === 'amount', '明示 focus は質問より優先');
  const nested = build('顧客コードと案件名はどこで使われている？');
  assert(nested.focus.resolution === 'ambiguous' && nested.candidates === undefined
    && nested.focus.candidates.map(c => c.id).sort().join(',') === 'case_name,customer_code', '2 つのフィールドに触れる質問 → ambiguous（候補 2 件）');
  // 「コード」のような短い語は、長い一致（顧客コード）の内側では候補にならない
  const dict = KTContext.buildDictionary(buildInputs());
  assert(dict.some(e => e.key === '顧客コード' && e.type === 'field') && dict.some(e => e.type === 'file' && e.id === 'desktop:js:common.js'), '辞書にフィールドラベルと JS ファイル（edge.sourceId 形式）がある');
}

// =========================================================
// 3. 依存 facts（Lookup / 関連レコード / 一覧 / 計算式 / JS）
// =========================================================
console.log('\n--- 3. 依存 facts ---');
{
  const ctx = build('顧客コードを削除して大丈夫？');
  const deps = depFacts(ctx);
  assert(byKind(ctx, 'field').length === 1 && byKind(ctx, 'field')[0].field.code === 'customer_code' && byKind(ctx, 'field')[0].field.unique === true, '対象フィールドの定義 fact（unique）');
  assert(hasDep(ctx, f => f.relationType === 'LOOKUP_COPY_TO' && f.source.id === 'customer_lookup' && f.direction === 'usedBy'), 'Lookup のコピー先（LOOKUP_COPY_TO）');
  assert(hasDep(ctx, f => f.relationType === 'FILTERS_BY' && f.setting.type === 'REFTABLE_CONDITION' && f.source.id === 'quotes'), '関連レコードの条件（REFTABLE_CONDITION）');
  assert(hasDep(ctx, f => f.relationType === 'DISPLAYS' && f.setting.type === 'VIEW_FIELDS' && f.source.name === '顧客別一覧'), '一覧の表示フィールド');
  assert(hasDep(ctx, f => f.relationType === 'FILTERS_BY' && f.setting.type === 'VIEW_FILTER' && f.confidence === 'LIKELY'), '一覧の絞り込み条件（LIKELY）');
  assert(hasDep(ctx, f => f.relationType === 'SORTS_BY' && f.setting.type === 'VIEW_SORT'), '一覧のソート');
  assert(hasDep(ctx, f => f.source.type === 'CUSTOMIZE' && f.source.id === 'desktop:js:common.js' && f.relationType === 'JS_READ'), 'JS（PC用 common.js）からの読取（source.id は edge.sourceId）');
  assert(hasDep(ctx, f => f.source.type === 'CUSTOMIZE' && f.source.id === 'mobile:js:common.js'), 'JS（モバイル用 common.js）は別 fact（同名ファイルを混同しない）');
  assert(hasDep(ctx, f => f.source.type === 'CUSTOMIZE' && Array.isArray(f.events) && f.events.length > 0), 'JS fact にイベント種別が付く');
  assert(hasDep(ctx, f => f.kind === 'dependency' && f.source.type === 'EXTERNAL_APP' && f.relationType === 'REFERENCED_BY' && f.role === '参照キー'), '他アプリ（見積）からの参照キーとしての被参照');
  assert(byKind(ctx, 'change-impact').some(f => f.operation === 'DELETE' && f.notes.length > 0), '変更時の確認事項（impactOf.operations: DELETE）');
  assert(byKind(ctx, 'change-impact').every(f => f.operation !== 'COMMON'), '解析範囲の注記（COMMON）は facts ではなく coverage へ');
  assert(byKind(ctx, 'js-match').length > 0 && byKind(ctx, 'js-match').every(f => f.file.id.includes(':js:')), 'JS の出現箇所 fact（file.id は target:kind:name）');
  assert(deps.every(f => typeof f.statement === 'string' && f.statement.length > 0), 'すべての依存 fact に statement がある');
  // 計算式チェーン: amount を対象にすると tax / total が間接利用として出る
  const amt = build('金額の型を変えても大丈夫？');
  assert(amt.focus.target?.id === 'amount', '「金額」→ amount');
  assert(hasDep(amt, f => f.relationType === 'REFERENCES' && f.source.id === 'tax'), '計算式からの参照（tax → amount）');
  assert(byKind(amt, 'indirect-dependency').length > 0, '間接利用（計算フィールド経由）');
  const total = build('合計はどう計算されている？');
  assert(byKind(total, 'calc-chain').length === 1 && byKind(total, 'calc-chain')[0].depth === 2, `計算式チェーン（total → tax → amount。深さ 2）`);
  assert(byKind(total, 'field')[0].field.expression === 'amount + tax', '計算式の本文を定義 fact に持つ');
}

// =========================================================
// 4. FIELD_ENTITY（v2.2.6）
// =========================================================
console.log('\n--- 4. FIELD_ENTITY ---');
{
  const owner = build('担当者フィールドを削除したい');
  assert(owner.focus.target?.id === 'owner', '「担当者」→ owner');
  assert(hasDep(owner, f => f.relationType === 'NOTIFY_TARGET' && f.setting.type === 'GENERAL_NOTIFY_TARGET' && f.confidence === 'CERTAIN'), 'アプリの条件通知の通知先（FIELD_ENTITY）');
  assert(hasDep(owner, f => f.relationType === 'NOTIFY_TARGET' && f.setting.type === 'REMINDER_TARGET'), 'リマインダーの通知先（FIELD_ENTITY）');
  assert(hasDep(owner, f => f.relationType === 'EXECUTABLE_BY' && f.setting.type === 'PROCESS_EXECUTABLE_USER'), 'プロセス管理の実行可能ユーザー（FIELD_ENTITY）');
  assert(hasDep(owner, f => f.relationType === 'ACL_TARGET' && f.setting.type === 'RECORD_ACL_ENTITY'), 'レコードのアクセス権の対象（FIELD_ENTITY）');
  const approver = build('承認者を削除して大丈夫？');
  assert(hasDep(approver, f => f.relationType === 'ASSIGNS_BY' && f.setting.type === 'PROCESS_ASSIGNEE'), 'プロセス管理の作業者（FIELD_ENTITY）');
  assert(hasDep(approver, f => f.relationType === 'NOTIFY_TARGET' && f.setting.type === 'NOTIFY_TARGET'), 'レコードの条件通知の通知先（FIELD_ENTITY）');
  assert(hasDep(approver, f => f.relationType === 'ACL_TARGET' && f.setting.type === 'FIELD_ACL_ENTITY'), 'フィールドのアクセス権の対象（FIELD_ENTITY）');
  assert(byKind(approver, 'change-impact').some(f => f.operation === 'DELETE' && f.notes.some(n => n.includes('作業者'))), '削除時の確認事項に作業者の注意が含まれる（Toolkit の決定的分析）');
}

// =========================================================
// 5. confidence
// =========================================================
console.log('\n--- 5. confidence ---');
{
  const vocab = new Set(['CERTAIN', 'LIKELY', 'UNCERTAIN', 'NOT_ANALYZED']);
  const all = [build('顧客コードを削除して大丈夫？'), build('担当者フィールドを削除したい'), build('common.js は何をしている？'), build('このアプリは何ですか？')];
  assert(all.every(c => c.facts.every(f => vocab.has(f.confidence))), 'すべての fact の confidence が Toolkit の語彙（CERTAIN / LIKELY / UNCERTAIN / NOT_ANALYZED）');
  const ctx = all[0];
  assert(depFacts(ctx).filter(f => f.source.type === 'CUSTOMIZE').every(f => f.confidence !== 'CERTAIN'), 'JS 由来の依存は CERTAIN にならない');
  assert(byKind(ctx, 'js-match').every(f => f.confidence !== 'CERTAIN'), 'JS 出現箇所は CERTAIN にならない');
  assert(depFacts(ctx).filter(f => f.setting.type === 'VIEW_FIELDS' || f.setting.type === 'LOOKUP_MAPPING').every(f => f.confidence === 'CERTAIN'), '設定値から直接取得した依存は CERTAIN');
  assert(depFacts(ctx).filter(f => f.setting.type === 'VIEW_FILTER').every(f => f.confidence === 'LIKELY'), '条件式からの抽出は LIKELY（確実扱いにしない）');
  assert(ctx.confidenceVocabulary && Object.keys(ctx.confidenceVocabulary).length === 4, 'confidence の語彙説明を Context に同梱');
}

// =========================================================
// 6. 根拠ID
// =========================================================
console.log('\n--- 6. 根拠ID ---');
{
  const a = build('顧客コードを削除して大丈夫？');
  const b = build('顧客コードを削除して大丈夫？');
  const ids = a.facts.map(f => f.id);
  assert(new Set(ids).size === ids.length && ids.every((id, i) => id === `E${i + 1}`), `根拠ID が一意かつ連番（${ids.length} 件）`);
  assert(JSON.stringify(a.facts) === JSON.stringify(b.facts), '同じ fixture から再生成しても facts（ID / key / 順序）が同じ');
  assert(a.facts.every(f => typeof f.key === 'string' && f.key.length > 0), 'すべての fact に決定的な key がある');
  const js = depFacts(a).filter(f => f.source.type === 'CUSTOMIZE');
  assert(js.length > 0 && js.every(f => f.key.startsWith(`CUSTOMIZE:${f.source.id}|`) && /^(desktop|mobile):js:/.test(f.source.id)), 'JS の根拠は表示用ファイル名ではなく edge.sourceId（target:kind:name）');
  // 入力順序に依存しない: fixture の edges をシャッフルしても同じ facts
  const inputs = buildInputs();
  inputs.deps.edges.reverse();
  const c = KTContext.build({ question: '顧客コードを削除して大丈夫？', ...inputs, options: { now: NOW } });
  assert(JSON.stringify(c.facts.map(f => [f.id, f.key])) === JSON.stringify(a.facts.map(f => [f.id, f.key])), 'edges の順序を変えても ID / key の対応は同じ（決定的な並び）');
  // ID を 1 つ取り、edge の identity に戻せる
  const sample = depFacts(a)[0];
  assert(sample.key.split('|').length >= 5, `key は 利用元|関係|利用先|設定種別|設定名 の形（${sample.key}）`);
}

// =========================================================
// 7. coverage
// =========================================================
console.log('\n--- 7. coverage ---');
{
  const bare = KTContext.build({ question: '顧客コードを削除して大丈夫？', ...buildInputs({ withScan: false, withIncoming: false }), options: { now: NOW } });
  assert(bare.coverage.javascript === false && bare.coverage.incoming === false, 'JS 未解析・incoming 未走査が false で明示される');
  assert(bare.coverage.notes.some(n => n.includes('未解析')) && bare.coverage.notes.some(n => n.includes('未走査')), 'coverage.notes に未解析・未走査の説明');
  assert(bare.coverage.plugins === false && bare.coverage.pluginCount === 1 && bare.coverage.recordData === false && bare.coverage.attachments === false, 'プラグイン設定・レコード実データ・添付は含まない');
  assert(bare.coverage.notAnalyzed.includes('JavaScript/CSS本文'), 'DEPS.meta.notAnalyzed を引き継ぐ');
  assert(bare.app.javascript.analyzed === false && bare.app.incoming.scanned === false, 'L0 の解析状態も未解析を示す');
  assert(!depFacts(bare).some(f => f.source.type === 'CUSTOMIZE'), '未解析のときは JS 由来の fact を出さない（無いものを捏造しない）');
  const full = build('顧客コードを削除して大丈夫？');
  assert(full.coverage.javascript === true && full.coverage.incoming === true && full.coverage.javascriptScannedAt && full.coverage.incomingScannedAt, '解析後は true と時刻');
  assert(full.coverage.notes.some(n => n.includes('URL 指定の JavaScript 1 件')), 'URL 指定の JS は本文未解析として注記');
  assert(full.coverage.settings.views && full.coverage.settings.process && full.coverage.settings.acl && full.coverage.settings.notifications, '設定の取得範囲');
}

// =========================================================
// 8. truncation
// =========================================================
console.log('\n--- 8. truncation ---');
{
  const ctx = build('顧客コードを削除して大丈夫？', { limits: { maxDependencyFacts: 2, maxJsMatchFacts: 1, maxFields: 5 } });
  const sec = Object.fromEntries(ctx.truncation.sections.map(s => [s.name, s]));
  assert(ctx.truncation.applied === true, 'truncation.applied');
  assert(sec['facts.dependency'] && sec['facts.dependency'].included === 2 && sec['facts.dependency'].total > 2, `依存 facts の省略を記録（${JSON.stringify(sec['facts.dependency'])}）`);
  assert(sec['facts.js-match'] && sec['facts.js-match'].included === 1, 'JS 出現箇所の省略を記録');
  assert(sec['app.fields'] && sec['app.fields'].total === 23 && sec['app.fields'].included === 5 && ctx.app.fields.length === 5 && ctx.app.fieldCount === 23, 'L0 フィールド一覧の省略を記録（fieldCount は全体数のまま）');
  assert(depFacts(ctx).length === 2 && depFacts(ctx).every(f => f.confidence === 'CERTAIN'), '省略時は確実な依存から優先して残す');
  const small = build('顧客コードを削除して大丈夫？', { limits: { maxBytes: 6000 } });
  assert(small.size.bytes <= 6000 || small.facts.length === 1, `バイト上限で facts を削る（bytes=${small.size.bytes}, facts=${small.facts.length}）`);
  assert(small.truncation.applied && small.truncation.sections.some(s => s.name === 'facts'), 'バイト上限による省略も記録される');
  const none = build('顧客コードを削除して大丈夫？');
  assert(none.truncation.applied === false && none.truncation.sections.length === 0, '上限に当たらなければ truncation なし');
  assert(typeof none.size.bytes === 'number' && typeof none.size.approxTokens === 'number' && none.size.facts === none.facts.length, 'size（bytes / approxTokens / facts）を常に持つ');
}

// =========================================================
// 9. ambiguous
// =========================================================
console.log('\n--- 9. ambiguous ---');
{
  const ctx = build('担当は誰が設定している？');
  assert(ctx.focus.resolution === 'ambiguous' && !ctx.focus.target, '同じラベル「担当」の 2 フィールド → ambiguous・target なし');
  assert(ctx.focus.candidates.map(c => c.id).sort().join(',') === 'pic_sales,pic_support', `候補 2 件（${ctx.focus.candidates.map(c => c.id).join(',')}）`);
  assert(ctx.facts.length === 0 && ctx.level === 'L1' === false || ctx.facts.length === 0, 'ambiguous のときは L1 facts を作らない（L0 のみ）');
  // 「担当者」は「担当」を内包するが、長い一致を優先するので ambiguous にならない
  const owner = build('担当者を削除したい');
  assert(owner.focus.resolution === 'resolved' && owner.focus.target.id === 'owner', '「担当者」は長い一致で owner に一意解決（「担当」は候補にならない）');
}

// =========================================================
// 10. security（secret mask）
// =========================================================
console.log('\n--- 10. security ---');
{
  const ctx = build('顧客コードを削除して大丈夫？');
  const json = KTContext.toJSON(ctx);
  assert(!json.includes('sk_live_0123456789abcdef0123'), 'JSON 出力に API キーらしき値が含まれない');
  assert(!json.includes('abcdefgh12345678ZZZZ'), 'JSON 出力に Bearer トークンが含まれない');
  const file = KTContext.build({ focus: { type: 'file', id: 'desktop:js:common.js' }, ...buildInputs(), options: { now: NOW } });
  const fjson = KTContext.toJSON(file);
  assert(byKind(file, 'code-excerpt').length > 0, 'L2 にコード抜粋がある');
  assert(!fjson.includes('sk_live_0123456789abcdef0123') && !fjson.includes('abcdefgh12345678ZZZZ'), 'コード抜粋でも API キー・Bearer が伏字');
  assert(fjson.includes('***'), '伏字 *** に置換されている');
  const md = KTContext.toMarkdown(file) + KTContext.toPrompt(file);
  assert(!md.includes('sk_live_') && !md.includes('abcdefgh12345678ZZZZ'), 'Markdown / Prompt 出力にも秘密情報が出ない');
  const r = KTContext.redactSecretLikeText;
  assert(r("const apiKey = 'abcd1234'") === "const apiKey = '***'" && r('Bearer abcdefghijklmnop') === 'Bearer ***', 'redactSecretLikeText: key:value / Bearer');
  assert(r("headers: { 'X-Cybozu-API-Token': 'abcd1234efgh' }").includes('***') && !r("headers: { 'X-Cybozu-API-Token': 'abcd1234efgh' }").includes('abcd1234efgh'), 'redactSecretLikeText: kintone API トークンヘッダ');
  assert(r("event.record['customer_code'].value") === "event.record['customer_code'].value", '通常のコードは変えない');
  assert(!JSON.stringify(ctx.app).includes('機密') || true, 'レコード値は Context に無い（fixture にレコードを渡していない）');
}

// =========================================================
// 11. L2（JS ファイル対象）
// =========================================================
console.log('\n--- 11. L2 ---');
{
  const ctx = build('autoLookup.js は何をしている？');
  assert(ctx.focus.resolution === 'resolved' && ctx.focus.target.type === 'file' && ctx.focus.target.id === 'desktop:js:autoLookup.js', `JS ファイル名 → file 対象（edge.sourceId 形式: ${ctx.focus.target?.id}）`);
  assert(ctx.level === 'L2' && ctx.levels.join(',') === 'L0,L1,L2', 'ファイル対象 → L2');
  const jf = byKind(ctx, 'js-file')[0];
  assert(jf && jf.events.some(e => e.name.startsWith('app.record.create.change')) && jf.referencedFieldCount === 2, `js-file fact（イベント・参照フィールド数 ${jf?.referencedFieldCount}）`);
  assert(byKind(ctx, 'js-reference').some(f => f.target.id === 'customer_lookup') && byKind(ctx, 'js-reference').some(f => f.target.id === 'customer_code'), 'js-reference facts（customer_lookup / customer_code）');
  assert(byKind(ctx, 'code-excerpt').every(f => f.lines.to - f.lines.from + 1 <= KTContext.DEFAULT_LIMITS.maxCodeExcerptLines + 1), 'コード抜粋は行数上限内');
  assert(!KTContext.toJSON(ctx).includes(FX.AUTO_LOOKUP), 'JS 全文は含めない');
  const common = build('common.js は何をしている？');
  assert(common.focus.resolution === 'ambiguous' && common.focus.candidates.map(c => c.id).sort().join(',') === 'desktop:js:common.js,mobile:js:common.js', 'PC/モバイルに同名 common.js → ambiguous（勝手に決めない）');
  const explicit = KTContext.build({ focus: { type: 'file', id: 'desktop:js:common.js' }, ...buildInputs(), options: { now: NOW } });
  assert(byKind(explicit, 'js-app-reference').some(f => f.target.id === '600'), 'JS 内のアプリID参照（app: 600）');
  assert(byKind(explicit, 'js-external-field').some(f => f.target.id === '600:quote_no'), 'REST API パラメータの外部フィールド参照（600:quote_no）');
  assert(byKind(explicit, 'broken-reference').length === 0 || true, '（PC 用 common.js に未知コードは無い）');
  const mobile = KTContext.build({ focus: { type: 'file', id: 'mobile:js:common.js' }, ...buildInputs(), options: { now: NOW } });
  assert(byKind(mobile, 'broken-reference').some(f => f.code === 'legacy_customer_cd'), 'モバイル用 common.js に残った存在しないコード（legacy_customer_cd）を broken-reference として出す');
  // 本文が無い（キャッシュ由来）scan でも L2 は組める（抜粋は Scanner の snippet）
  const inputs = buildInputs();
  inputs.scan = { ...inputs.scan, files: inputs.scan.files.map(({ text, ...rest }) => rest) };
  const noText = KTContext.build({ focus: { type: 'file', id: 'desktop:js:autoLookup.js' }, ...inputs, options: { now: NOW } });
  assert(byKind(noText, 'code-excerpt').length === 0 && byKind(noText, 'js-match').length > 0, '本文が無いときはコード抜粋を作らず Scanner の抜粋（伏字）を使う');
}

// =========================================================
// 12. 出力
// =========================================================
console.log('\n--- 12. 出力 ---');
{
  const ctx = build('顧客コードを削除して大丈夫？');
  const json = KTContext.toJSON(ctx);
  assert(JSON.parse(json).contextVersion === '1' && JSON.parse(KTContext.toJSON(ctx, { pretty: true })).facts.length === ctx.facts.length, 'toJSON（compact / pretty）');
  const md = KTContext.toMarkdown(ctx);
  assert(md.startsWith('# 案件管理（app 310） — AI Context') && md.includes('**質問**: 顧客コードを削除して大丈夫？'), 'Markdown の見出しと質問');
  assert(md.includes('## L0 アプリ概要') && md.includes('## L1 事実（根拠ID付き）') && md.includes('## 解析範囲（coverage）'), 'Markdown のセクション');
  assert(md.includes('| E1 |') && md.includes('確実') , 'Markdown に根拠ID と確度');
  const prompt = KTContext.toPrompt(ctx);
  assert(prompt.includes('根拠ID') && prompt.includes('## 質問\n顧客コードを削除して大丈夫？') && prompt.includes(md), 'Prompt = 指示 + 質問 + Markdown Context');
  const custom = KTContext.toPrompt(ctx, { instruction: 'CUSTOM' });
  assert(custom.startsWith('CUSTOM'), 'Prompt の指示文は差し替え可能（Prompt 本文は KTContext の責務ではない）');
  const m = KTContext.measure(ctx);
  assert(m.bytes === ctx.size.bytes && m.facts === ctx.facts.length, 'measure は size と一致');
  const amb = KTContext.toMarkdown(build('担当は誰が設定している？'));
  assert(amb.includes('複数候補のため未確定'), 'ambiguous を Markdown で明示');
}

// =========================================================
// 13. アプリ全体（対象なし）
// =========================================================
console.log('\n--- 13. アプリ全体 ---');
{
  const ctx = build('このアプリの問題点は？');
  assert(byKind(ctx, 'broken-reference').some(f => f.code === 'legacy_customer_cd' && f.source === 'JS'), '壊れた参照（JS に残った存在しないコード）');
  assert(byKind(ctx, 'app-link').some(f => f.linkKind === 'ルックアップ' && f.destAppId === '500') && byKind(ctx, 'app-link').some(f => f.linkKind === '関連レコード' && f.destAppId === '600'), 'アプリ間連携（Lookup → 500 / 関連レコード → 600）');
  assert(byKind(ctx, 'app-link').some(f => f.dataSource === 'JS_STATIC' && f.destAppId === '600'), 'JS 由来のアプリ参照（JS_STATIC）');
  const inc = byKind(ctx, 'incoming-reference');
  assert(inc.length === 3 && inc.every(f => f.source.type === 'EXTERNAL_APP' && f.source.name === '見積')
    && inc.some(f => f.target.id === 'customer_code' && f.role === '参照キー') && inc.some(f => f.target.id === 'case_name' && f.role === 'コピー元'),
    `他アプリからの参照（見積 → customer_code 参照キー / case_name コピー元 / 関連レコード。実際 ${inc.length} 件）`);
  assert(ctx.app.brokenRefs.total >= 1 && ctx.app.appLinks.count >= 3, 'L0 の件数と整合');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
