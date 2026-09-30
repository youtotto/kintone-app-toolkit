// 依存関係解析：通知先・作業者・アクセス権の「フィールド指定（FIELD_ENTITY）」の回帰テスト
//
// 背景:
//   通知先・作業者・アクセス権の対象は、kintone API では entity: { type, code } で返り、
//   フィールドを指定した場合の type は 'FIELD_ENTITY'（code = フィールドコード）。
//   従来は entity.type === 'FIELD' で判定しており、kintone が返す実値と一致しないため
//   フィールド指定の依存エッジが1本も生成されていなかった（'FIELD' は内部モデルのノード種別、および
//   アプリアクションの mappings[].srcType の値であって、entity.type の値ではない）。
//   あわせて、アプリの条件通知（general）の通知先と、プロセス管理の「作業者以外でも実行できるアクション」の
//   実行可能ユーザーは、フィールド指定があっても解析対象に入っていなかった。
//
// 検証内容:
//   1. レコードの条件通知：フィールド指定の通知先が依存として生成される
//   2. リマインダー：フィールド指定の通知先が依存として生成される
//   3. アプリの条件通知：フィールド指定の通知先が依存として生成される
//   4. プロセス管理：作業者のフィールド指定が依存として生成される
//   5. プロセス管理：実行可能ユーザーのフィールド指定が依存として生成される
//   6. レコードのアクセス権：対象のフィールド指定が依存として生成される
//   7. フィールドのアクセス権：対象のフィールド指定が依存として生成される
//   8. FIELD_ENTITY 以外（USER / GROUP / ORGANIZATION / CREATOR / CUSTOM_FIELD）は依存にならず、既存のエッジは変わらない
//   9. 変更影響（impactOf）・使用箇所（usageMapFromEdges）に反映される
//  10. 存在しない参照（findBrokenRefs）・アプリ間依存（buildAppLinks）に意図しない影響がない
//  11. 依存モデル（edges）だけから「通知設定から参照／作業者指定に利用／アクセス権に利用」を機械的に引ける
//
// 実行方法:
//   node tests/field-entity-deps.test.js
//   （終了コード 0 = 成功、1 = 失敗）
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const FX = require('./fixtures/field-entity-app.js');

// ---- 実スクリプトを sandbox に読み込み、KTDeps を取り出す ----
const SRC = path.join(__dirname, '..', 'kintoneAppToolkit.user.js');
let code = fs.readFileSync(SRC, 'utf8');
const lastClose = code.lastIndexOf('})();');
if (lastClose < 0) throw new Error('IIFE close not found');
code = code.slice(0, lastClose) + '\n  globalThis.__TEST__ = { KTDeps };\n' + code.slice(lastClose);

const noop = () => { };
const fakeStorage = { getItem: () => null, setItem: noop, removeItem: noop };
const sandbox = {
  console, setTimeout, clearTimeout,
  setInterval: () => 0, clearInterval: noop, // waitReady のポーリングは動かさない
  localStorage: fakeStorage, sessionStorage: fakeStorage,
  navigator: {},
  document: {
    createElement: () => ({ style: {}, setAttribute: noop, addEventListener: noop, appendChild: noop }),
    querySelector: () => null, getElementById: () => null,
    head: { appendChild: noop }, body: { appendChild: noop, removeChild: noop },
    documentElement: { matches: () => false },
    addEventListener: noop,
  },
  matchMedia: () => ({ matches: false, addEventListener: noop }),
  location: { host: 'test.cybozu.com', origin: 'https://test.cybozu.com' },
  requestIdleCallback: noop,
  ResizeObserver: class { observe() { } disconnect() { } },
  addEventListener: noop, removeEventListener: noop,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'kintoneAppToolkit.user.js' });
const { KTDeps } = sandbox.__TEST__;

// ---- テストユーティリティ ----
let failed = 0;
const assert = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failed++;
};
const buildDeps = (data) => KTDeps.buildDependencyData(data, KTDeps.normalizeFields(data.fields));

/** 条件（キーの一致）に合うエッジを返す。settingType / settingName / missing は context から引く */
const CONTEXT_KEYS = ['settingType', 'settingName', 'missing'];
const findEdges = (deps, q) => deps.edges.filter(e => Object.entries(q).every(([k, v]) =>
  (CONTEXT_KEYS.includes(k) ? e.context?.[k] : e[k]) === v));
const one = (deps, q) => findEdges(deps, q).length === 1;

// フィールド指定（entity）から生成されるエッジの設定種別
const ENTITY_SETTING_TYPES = [
  'GENERAL_NOTIFY_TARGET', 'NOTIFY_TARGET', 'REMINDER_TARGET',
  'PROCESS_ASSIGNEE', 'PROCESS_EXECUTABLE_USER',
  'RECORD_ACL_ENTITY', 'FIELD_ACL_ENTITY',
];
const isEntityEdge = (e) => ENTITY_SETTING_TYPES.includes(e.context?.settingType);
const sig = (e) => [e.sourceType, e.sourceId, e.relationType, `${e.targetType}:${e.targetId}`, e.context?.settingType, e.confidence].join(' | ');
const sigs = (edges) => edges.map(sig).sort();

/** DATA 内のすべての entity（{ type, code }）を書き換える（fixture の変形用） */
const mapEntities = (data, fn) => {
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    if (v.entity && typeof v.entity === 'object' && 'type' in v.entity) v.entity = fn(v.entity);
    Object.values(v).forEach(walk);
  };
  walk(data);
  return data;
};
const countEntities = (data, type) => {
  let n = 0;
  mapEntities(data, (en) => { if (en.type === type) n++; return en; });
  return n;
};

const deps = buildDeps(FX.makeData());

// =========================================================
// 0. fixture の前提（kintone API が返す実値で検証していること）
// =========================================================
console.log('\n--- 0. fixture の前提 ---');
assert(countEntities(FX.makeData(), 'FIELD_ENTITY') === 11, `fixture のフィールド指定（FIELD_ENTITY）は 11 件（実際: ${countEntities(FX.makeData(), 'FIELD_ENTITY')}）`);
assert(countEntities(FX.makeData(), 'FIELD') === 0, "fixture に kintone が返さない値（entity.type: 'FIELD'）を含めていない");

// =========================================================
// 1. レコードの条件通知（/k/v1/app/notifications/perRecord.json）
// =========================================================
console.log('\n--- 1. Notification: レコードの条件通知の通知先 ---');
{
  const q = { sourceType: 'NOTIFICATION', sourceId: 'perRecord:0', relationType: 'NOTIFY_TARGET', targetType: 'FIELD', settingType: 'NOTIFY_TARGET' };
  assert(one(deps, { ...q, targetId: 'approver' }), '通知先 FIELD_ENTITY: approver → NOTIFY_TARGET エッジが 1 本できる');
  assert(one(deps, { ...q, targetId: 'owner_org' }), '通知先 FIELD_ENTITY: owner_org（組織選択・includeSubs: true）→ NOTIFY_TARGET エッジが 1 本できる');
  const e = findEdges(deps, { ...q, targetId: 'approver' })[0];
  assert(e?.confidence === 'CERTAIN' && !e?.context?.missing, '設定値として明示されたフィールドなので確度は CERTAIN（missing なし）');
  assert(e?.sourceName === '高額案件の登録' && e?.context?.settingName === '高額案件の登録' && e?.targetName === '承認者',
    `どの通知のどのフィールドかが分かる（実際: ${e?.sourceName} → ${e?.targetName}）`);
  assert(findEdges(deps, { sourceId: 'perRecord:0', settingType: 'NOTIFY_TARGET' }).length === 2,
    '同じ通知の USER（user1）は通知先エッジにならない（フィールド指定の 2 件だけ）');
  assert(findEdges(deps, { sourceId: 'perRecord:1', relationType: 'NOTIFY_TARGET' }).length === 0,
    '通知先が GROUP / ORGANIZATION だけの通知からは通知先エッジを作らない');
  assert(one(deps, { sourceId: 'perRecord:1', relationType: 'FILTERS_BY', targetId: 'owner', settingType: 'NOTIFY_CONDITION' })
    && one(deps, { sourceId: 'perRecord:0', relationType: 'FILTERS_BY', targetId: 'amount', settingType: 'NOTIFY_CONDITION' }),
    '条件式からのエッジ（FILTERS_BY）は従来どおり');
}

// =========================================================
// 2. リマインダーの条件通知（/k/v1/app/notifications/reminder.json）
// =========================================================
console.log('\n--- 2. Notification: リマインダーの通知先 ---');
{
  const q = { sourceType: 'NOTIFICATION', sourceId: 'reminder:0', relationType: 'NOTIFY_TARGET', targetType: 'FIELD', settingType: 'REMINDER_TARGET' };
  assert(one(deps, { ...q, targetId: 'owner' }), '通知先 FIELD_ENTITY: owner → NOTIFY_TARGET（REMINDER_TARGET）エッジが 1 本できる');
  assert(one(deps, { ...q, targetId: 'owner_group' }), '通知先 FIELD_ENTITY: owner_group（グループ選択）→ エッジが 1 本できる');
  assert(findEdges(deps, { sourceId: 'reminder:0', settingType: 'REMINDER_TARGET' }).every(e => e.confidence === 'CERTAIN'), '確度は CERTAIN');
  assert(one(deps, { sourceId: 'reminder:0', relationType: 'REMINDER_TIMING', targetId: 'due_date' })
    && one(deps, { sourceId: 'reminder:0', relationType: 'FILTERS_BY', targetId: 'amount', settingType: 'REMINDER_CONDITION' }),
    '基準日時（REMINDER_TIMING）・条件式（FILTERS_BY）のエッジは従来どおり');
}

// =========================================================
// 3. アプリの条件通知（/k/v1/app/notifications/general.json）
// =========================================================
console.log('\n--- 3. Notification: アプリの条件通知の通知先 ---');
{
  const q = { sourceType: 'NOTIFICATION', sourceId: 'general', relationType: 'NOTIFY_TARGET', targetType: 'FIELD', settingType: 'GENERAL_NOTIFY_TARGET' };
  assert(one(deps, { ...q, targetId: '作成者' }), '通知先 FIELD_ENTITY: 作成者（システムフィールド）→ NOTIFY_TARGET エッジが 1 本できる');
  assert(one(deps, { ...q, targetId: 'owner' }), '通知先 FIELD_ENTITY: owner → NOTIFY_TARGET エッジが 1 本できる');
  assert(findEdges(deps, { sourceId: 'general' }).length === 2, 'USER / GROUP / ORGANIZATION の行は通知先エッジにならない（フィールド指定の 2 件だけ）');
  assert(findEdges(deps, { sourceId: 'general' }).every(e => e.confidence === 'CERTAIN' && !e.context.missing && e.sourceName === 'アプリの条件通知'),
    '確度は CERTAIN、設定名は「アプリの条件通知」');
  const node = deps.nodes.find(n => n.id === 'NOTIFICATION:general');
  assert(!!node && node.kind === 'general', 'NOTIFICATION:general ノードが生成される');

  // 取得できなかった（null）／通知先が無い場合はノードもエッジも作らない（例外にもならない）
  const d0 = FX.makeData(); d0.generalNotify = null;
  const d1 = FX.makeData(); d1.generalNotify = { notifications: [], notifyToCommenter: true, revision: '1' };
  assert(!buildDeps(d0).nodes.some(n => n.id === 'NOTIFICATION:general') && !buildDeps(d1).nodes.some(n => n.id === 'NOTIFICATION:general'),
    'アプリの条件通知を取得できない／通知先が 0 件のときはノードを作らない');
}

// =========================================================
// 4. プロセス管理：作業者（/k/v1/app/status.json の states.<名前>.assignee）
// =========================================================
console.log('\n--- 4. Process Assignee: 作業者のフィールド指定 ---');
{
  const q = { sourceType: 'PROCESS_STATE', sourceId: '承認待ち', relationType: 'ASSIGNS_BY', targetType: 'FIELD', settingType: 'PROCESS_ASSIGNEE' };
  assert(one(deps, { ...q, targetId: 'approver' }), '作業者 FIELD_ENTITY: approver → ASSIGNS_BY エッジが 1 本できる');
  const e = findEdges(deps, { ...q, targetId: 'approver' })[0];
  assert(e?.confidence === 'CERTAIN' && !e?.context?.missing && e?.context?.settingName === '承認待ち', '確度は CERTAIN、設定名はステータス名');
  assert(findEdges(deps, { relationType: 'ASSIGNS_BY' }).length === 1,
    '同じステータスの USER / GROUP / ORGANIZATION / CREATOR / CUSTOM_FIELD は作業者エッジにならない（フィールド指定の 1 件だけ）');
  assert(findEdges(deps, { sourceType: 'PROCESS_STATE', sourceId: '未処理' }).length === 0
    && findEdges(deps, { sourceType: 'PROCESS_STATE', sourceId: '完了' }).length === 0,
    '作業者が未設定（entities: []）のステータスからはエッジを作らない');

  // プロセス管理が無効なアプリでは、従来どおりプロセス管理由来のエッジを作らない
  const off = FX.makeData(); off.status.enable = false;
  assert(buildDeps(off).edges.every(x => x.sourceType !== 'PROCESS_STATE' && x.sourceType !== 'PROCESS_ACTION'),
    'プロセス管理が無効（enable: false）のときは作業者エッジを作らない（従来どおり）');
}

// =========================================================
// 5. プロセス管理：実行可能ユーザー（actions[].executableUser。type: SECONDARY のみ）
// =========================================================
console.log('\n--- 5. Process: 「作業者以外でも実行できるアクション」の実行可能ユーザー ---');
{
  const q = { sourceType: 'PROCESS_ACTION', sourceId: '取り下げる:2', relationType: 'EXECUTABLE_BY', targetType: 'FIELD', settingType: 'PROCESS_EXECUTABLE_USER' };
  assert(one(deps, { ...q, targetId: 'owner' }), '実行可能ユーザー FIELD_ENTITY: owner → EXECUTABLE_BY エッジが 1 本できる');
  assert(findEdges(deps, { ...q, targetId: 'owner' })[0]?.confidence === 'CERTAIN', '確度は CERTAIN');
  assert(findEdges(deps, { relationType: 'EXECUTABLE_BY' }).length === 1,
    'USER（user2）・executableUser.entities が空（PRIMARY）・executableUser なし のアクションからは作らない');
  assert(findEdges(deps, { relationType: 'ASSIGNS_BY', targetId: 'owner' }).length === 0,
    '実行可能ユーザーを「作業者（ASSIGNS_BY）」として扱わない（別の関係として区別する）');
  assert(one(deps, { sourceType: 'PROCESS_ACTION', sourceId: '申請する:0', relationType: 'FILTERS_BY', targetId: 'amount', settingType: 'PROCESS_CONDITION' }),
    'アクションの実行条件からのエッジ（FILTERS_BY）は従来どおり');
}

// =========================================================
// 6. レコードのアクセス権（/k/v1/record/acl.json）
// =========================================================
console.log('\n--- 6. Record ACL: 対象のフィールド指定 ---');
{
  const q = { sourceType: 'ACL', sourceId: 'record:0', relationType: 'ACL_TARGET', targetType: 'FIELD', settingType: 'RECORD_ACL_ENTITY' };
  assert(one(deps, { ...q, targetId: '更新者' }), '対象 FIELD_ENTITY: 更新者（システムフィールド）→ ACL_TARGET エッジが 1 本できる');
  assert(one(deps, { ...q, targetId: 'owner' }), '対象 FIELD_ENTITY: owner → ACL_TARGET エッジが 1 本できる');
  assert(findEdges(deps, { sourceId: 'record:0', settingType: 'RECORD_ACL_ENTITY' }).every(e => e.confidence === 'CERTAIN' && !e.context.missing), '確度は CERTAIN');
  assert(findEdges(deps, { sourceId: 'record:0', settingType: 'RECORD_ACL_ENTITY' }).length === 2, '同じルールの ORGANIZATION は対象エッジにならない');
  assert(findEdges(deps, { sourceType: 'ACL', sourceId: 'record:1' }).length === 0, '対象が GROUP だけ・条件なしのルールからはエッジを作らない');
  assert(one(deps, { sourceId: 'record:0', relationType: 'ACL_CONDITION', targetId: 'amount', settingType: 'RECORD_ACL_CONDITION' }),
    '条件式からのエッジ（ACL_CONDITION）は従来どおり');
}

// =========================================================
// 7. フィールドのアクセス権（/k/v1/field/acl.json）
// =========================================================
console.log('\n--- 7. Field ACL: 対象のフィールド指定 ---');
{
  const q = { sourceType: 'ACL', sourceId: 'field:0', relationType: 'ACL_TARGET', targetType: 'FIELD' };
  assert(one(deps, { ...q, targetId: 'approver', settingType: 'FIELD_ACL_ENTITY' }), '対象 FIELD_ENTITY: approver → ACL_TARGET（FIELD_ACL_ENTITY）エッジが 1 本できる');
  assert(findEdges(deps, { ...q, targetId: 'approver', settingType: 'FIELD_ACL_ENTITY' })[0]?.confidence === 'CERTAIN', '確度は CERTAIN');
  assert(findEdges(deps, { settingType: 'FIELD_ACL_ENTITY' }).length === 1, 'USER / GROUP / ORGANIZATION は対象エッジにならない（フィールド指定の 1 件だけ）');
  assert(one(deps, { ...q, targetId: 'amount', settingType: 'FIELD_ACL_TARGET' })
    && one(deps, { sourceType: 'ACL', sourceId: 'field:1', targetId: 'secret_memo', settingType: 'FIELD_ACL_TARGET' }),
    'アクセス権を設定するフィールドそのもの（FIELD_ACL_TARGET）のエッジは従来どおり');
  assert(findEdges(deps, { sourceId: 'field:0', targetId: 'amount', settingType: 'FIELD_ACL_ENTITY' }).length === 0,
    '権限の設定対象（rights[].code）と、権限を与える相手（entity）を取り違えない');
}

// =========================================================
// 8. FIELD_ENTITY 以外の entity と、既存のエッジ
// =========================================================
console.log('\n--- 8. 非FIELD_ENTITY: USER / GROUP / ORGANIZATION / CREATOR / CUSTOM_FIELD ---');
// フィールド指定以外から生成されるエッジ（従来から生成されていたもの）。修正の前後で変わらないこと。
const NON_ENTITY_EDGES = [
  'ACL | field:0 | ACL_TARGET | FIELD:amount | FIELD_ACL_TARGET | CERTAIN',
  'ACL | field:1 | ACL_TARGET | FIELD:secret_memo | FIELD_ACL_TARGET | CERTAIN',
  'ACL | record:0 | ACL_CONDITION | FIELD:amount | RECORD_ACL_CONDITION | LIKELY',
  'ACTION | 5520 | ACTION_MAPS_FROM | FIELD:case_name | ACTION_MAPPING | CERTAIN',
  'ACTION | 5520 | APP_REFERENCE | APP:311 | ACTION | CERTAIN',
  'NOTIFICATION | perRecord:0 | FILTERS_BY | FIELD:amount | NOTIFY_CONDITION | LIKELY',
  'NOTIFICATION | perRecord:1 | FILTERS_BY | FIELD:owner | NOTIFY_CONDITION | LIKELY',
  'NOTIFICATION | reminder:0 | FILTERS_BY | FIELD:amount | REMINDER_CONDITION | LIKELY',
  'NOTIFICATION | reminder:0 | REMINDER_TIMING | FIELD:due_date | REMINDER_TIMING | CERTAIN',
  'PROCESS_ACTION | 申請する:0 | FILTERS_BY | FIELD:amount | PROCESS_CONDITION | LIKELY',
].sort();
{
  const entityEdges = deps.edges.filter(isEntityEdge);
  assert(entityEdges.length === 11, `フィールド指定由来のエッジは FIELD_ENTITY の件数と同じ 11 本（実際: ${entityEdges.length}）`);
  assert(entityEdges.every(e => e.targetType === 'FIELD' && e.confidence === 'CERTAIN' && !e.context.missing),
    'フィールド指定由来のエッジはすべて 実在する FIELD 宛て・CERTAIN');

  const NOT_FIELDS = ['user1', 'user2', 'sales_group', 'sales_dept', 'everyone', 'supervisor'];
  assert(!deps.edges.some(e => NOT_FIELDS.includes(e.targetId)),
    'ユーザー・グループ・組織・カスタマイズ項目のコードをフィールドコードとして扱わない');
  assert(deps.edges.every(e => e.targetId != null && e.targetId !== '' && e.targetId !== 'null'),
    'CREATOR（code: null）から宛先の無いエッジを作らない');
  assert(!deps.nodes.some(n => NOT_FIELDS.includes(String(n.id).replace(/^FIELD:/, ''))), 'ユーザー等のコードの FIELD ノードを増やさない');
  assert(!deps.edges.some(e => e.sourceType === 'ACL' && !/^(record|field):\d+$/.test(e.sourceId)),
    'アプリのアクセス権（フィールド指定なし。CREATOR を含む）からはエッジを作らない');

  assert(JSON.stringify(sigs(deps.edges.filter(e => !isEntityEdge(e)))) === JSON.stringify(NON_ENTITY_EDGES),
    'フィールド指定以外のエッジ（条件式・基準日時・ACL対象・アクション）は従来どおり 10 本');

  // FIELD_ENTITY をすべて USER に置き換える（code は同じ文字列のまま）
  //   → ログイン名がフィールドコードと同じ文字列でも、type が USER ならフィールドへの依存にしない
  const asUser = buildDeps(mapEntities(FX.makeData(), en => (en.type === 'FIELD_ENTITY' ? { type: 'USER', code: en.code } : en)));
  assert(asUser.edges.filter(isEntityEdge).length === 0, 'type が USER なら、code がフィールドコードと同じ文字列でもエッジを作らない');
  assert(JSON.stringify(sigs(asUser.edges)) === JSON.stringify(NON_ENTITY_EDGES), 'フィールド指定が無いアプリでは、生成されるエッジは従来と同じ');
  for (const t of ['GROUP', 'ORGANIZATION', 'CUSTOM_FIELD']) {
    const d = buildDeps(mapEntities(FX.makeData(), en => (en.type === 'FIELD_ENTITY' ? { type: t, code: en.code } : en)));
    assert(d.edges.filter(isEntityEdge).length === 0, `type が ${t} ならエッジを作らない`);
  }
  // 'FIELD' は内部モデルのノード種別（と、アプリアクションの srcType）であり、kintone API の entity.type の値ではない
  const asField = buildDeps(mapEntities(FX.makeData(), en => (en.type === 'FIELD_ENTITY' ? { type: 'FIELD', code: en.code } : en)));
  assert(asField.edges.filter(isEntityEdge).length === 0, "entity.type: 'FIELD'（kintone API が返さない値）はフィールド指定として扱わない");
  // entity や code が欠けたデータでも例外にしない
  const broken = FX.makeData();
  broken.perRecordNotify.notifications[0].targets.push({}, { entity: null }, { entity: { type: 'FIELD_ENTITY' } }, { entity: { type: 'FIELD_ENTITY', code: '' } });
  broken.recordAcl.rights[0].entities.push(null);
  let threw = false;
  let dBroken = null;
  try { dBroken = buildDeps(broken); } catch (e) { threw = true; }
  assert(!threw && dBroken.edges.filter(isEntityEdge).length === 11, 'entity / code が欠けた要素があっても例外にせず、エッジも増やさない');

  // アプリアクションの srcType: 'FIELD' は別の語彙として従来どおり扱う
  assert(one(deps, { sourceType: 'ACTION', sourceId: '5520', relationType: 'ACTION_MAPS_FROM', targetId: 'case_name' })
    && findEdges(deps, { relationType: 'ACTION_MAPS_FROM' }).length === 1,
    "アプリアクションの mappings[].srcType: 'FIELD' は転記元エッジになる／RECORD_URL はならない（従来どおり）");
}

// =========================================================
// 9. 変更影響（impactOf）・使用箇所（usageMapFromEdges）への反映
// =========================================================
console.log('\n--- 9. impactOf / usageMapFromEdges ---');
{
  const rolesOf = (imp) => imp.direct.map(d => `${d.category}/${d.role}/${d.confidence}`).sort();
  const owner = KTDeps.impactOf(deps, 'owner');
  assert(owner.counts.direct === 5, `owner: 直接利用 5 件（実際: ${owner.counts.direct}）`);
  assert(JSON.stringify(rolesOf(owner)) === JSON.stringify([
    'アクセス権/ACL対象/CERTAIN', 'プロセス管理/実行可能ユーザー/CERTAIN',
    '通知/条件/LIKELY', '通知/通知先/CERTAIN', '通知/通知先/CERTAIN',
  ]), `owner: 通知先×2・条件・実行可能ユーザー・ACL対象 が役割つきで分かる（実際: ${rolesOf(owner).join(', ')}）`);
  assert(owner.direct.some(d => d.title === '通知「アプリの条件通知」' && d.role === '通知先')
    && owner.direct.some(d => d.title === '通知「期限前日のリマインド」' && d.role === '通知先')
    && owner.direct.some(d => d.title === 'プロセス管理「取り下げる」' && d.role === '実行可能ユーザー')
    && owner.direct.some(d => d.title === 'アクセス権「レコードACL#1」' && d.role === 'ACL対象'),
    'owner: どの設定から参照されているかが表示名で分かる');

  const approver = KTDeps.impactOf(deps, 'approver');
  assert(JSON.stringify(rolesOf(approver)) === JSON.stringify(['アクセス権/ACL対象/CERTAIN', 'プロセス管理/作業者/CERTAIN', '通知/通知先/CERTAIN']),
    `approver: 通知先・作業者・ACL対象 の 3 件（実際: ${rolesOf(approver).join(', ')}）`);
  const del = (approver.operations.find(o => o.key === 'DELETE') || { notes: [] }).notes.join(' ');
  assert(/プロセス管理の作業者に指定されています/.test(del), 'approver: 削除時の確認事項に「プロセス管理の作業者に指定されています」が出る');
  assert(/アクセス権の設定に使われています/.test(del), 'approver: 削除時の確認事項に「アクセス権の設定に使われています」が出る');
  assert(/直接 3 件/.test(del), 'approver: 削除時の件数表示が 直接 3 件 になる');
  const ownerDel = (owner.operations.find(o => o.key === 'DELETE') || { notes: [] }).notes.join(' ');
  assert(!/プロセス管理の作業者に指定されています/.test(ownerDel), 'owner: 実行可能ユーザーであって作業者ではないので、作業者の注意書きは出さない');

  assert(KTDeps.impactOf(deps, '作成者').counts.direct === 1 && KTDeps.impactOf(deps, '更新者').counts.direct === 1,
    'システムフィールド（作成者・更新者）も通知先／アクセス権の対象として計上される');
  assert(KTDeps.impactOf(deps, 'owner_org').counts.direct === 1 && KTDeps.impactOf(deps, 'owner_group').counts.direct === 1,
    '組織選択・グループ選択フィールドも通知先として計上される');
  assert(KTDeps.impactOf(deps, 'secret_memo').counts.direct === 1 && KTDeps.impactOf(deps, 'due_date').counts.direct === 1,
    'フィールド指定に関係しないフィールドの件数は従来どおり');

  const usage = KTDeps.usageMapFromEdges(deps.edges);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  assert(eq(usage.owner, ['通知', 'プロセス管理', 'アクセス権']), `使用箇所 owner = 通知・プロセス管理・アクセス権（実際: ${JSON.stringify(usage.owner)}）`);
  assert(eq(usage.approver, ['通知', 'プロセス管理', 'アクセス権']), `使用箇所 approver = 通知・プロセス管理・アクセス権（実際: ${JSON.stringify(usage.approver)}）`);
  assert(eq(usage.owner_org, ['通知']) && eq(usage['作成者'], ['通知']) && eq(usage['更新者'], ['アクセス権']),
    '使用箇所 owner_org = 通知／作成者 = 通知／更新者 = アクセス権');
  assert(eq(usage.amount, ['通知', 'プロセス管理', 'アクセス権']) && eq(usage.case_name, ['アプリアクション']), '条件式・アクション由来の使用箇所は従来どおり');
}

// =========================================================
// 10. 存在しない参照（findBrokenRefs）・アプリ間依存（buildAppLinks）・グラフ・出力
// =========================================================
console.log('\n--- 10. findBrokenRefs / buildAppLinks / グラフ / 出力 ---');
{
  assert(KTDeps.findBrokenRefs(deps).length === 0, '実在するフィールドを指定している限り、「存在しない参照」は増えない');

  // フィールド指定先がフォームに存在しない（設定値として明示されたコードが無い）場合は、従来の仕組みどおり検出する
  const gone = buildDeps(mapEntities(FX.makeData(), en => (en.type === 'FIELD_ENTITY' ? { type: 'FIELD_ENTITY', code: 'former_owner' } : en)));
  const rows = KTDeps.findBrokenRefs(gone);
  const roles = [...new Set(rows.map(r => r.role))].sort();
  assert(rows.length > 0 && rows.every(r => r.code === 'former_owner' && r.source === 'SETTING' && r.confidence === 'CERTAIN'),
    `フォームに無いコードのフィールド指定は「存在しない参照（確実）」として検出する（実際: ${rows.length} 件）`);
  assert(JSON.stringify(roles) === JSON.stringify([
    'アプリの条件通知の通知先（フィールド指定）',
    'フィールドのアクセス権（フィールド指定）',
    'プロセス管理のアクションの実行可能ユーザー（フィールド指定）',
    'プロセス管理の作業者（フィールド指定）',
    'リマインダーの通知先（フィールド指定）',
    'レコードのアクセス権（フィールド指定）',
    '条件通知の通知先（フィールド指定）',
  ].sort()), `7 種類の設定箇所すべてに、どの設定の項目かが分かる表示名が付く（実際: ${roles.join(' / ')}）`);
  // ユーザー・グループ等のコードは、フォームに無くても「存在しない参照」にしない
  assert(!KTDeps.findBrokenRefs(deps).some(r => ['user1', 'sales_group', 'sales_dept', 'supervisor'].includes(r.code)),
    'ユーザー・グループ・組織・カスタマイズ項目のコードを「存在しないフィールド」として報告しない');

  const links = KTDeps.buildAppLinks(deps, FX.APP_ID);
  assert(links.length === 1 && links[0].kind === 'アプリアクション' && links[0].destAppId === '311' && links[0].note === '1項目を転記',
    `アプリ間依存（buildAppLinks）はアプリアクションの 1 行のまま（実際: ${links.length} 行）`);

  const sub = KTDeps.buildSubgraph(deps, { focusId: 'FIELD:approver', scopes: [], depth: 1 });
  const ids = sub.nodes.map(n => n.id).sort();
  assert(JSON.stringify(ids) === JSON.stringify(['ACL:field:0', 'FIELD:approver', 'NOTIFICATION:perRecord:0', 'PROCESS_STATE:承認待ち'].sort()),
    `依存グラフ: approver を起点にすると 通知・プロセス管理・アクセス権 のノードに届く（実際: ${ids.join(', ')}）`);
  assert(sub.nodes.every(n => deps.nodes.includes(n)), 'グラフのノードはすべて依存データ上のノードとして解決できる（IDだけの仮ノードにならない）');

  const csv = KTDeps.toCSV(deps);
  assert(/"PROCESS_STATE","承認待ち","承認待ち","ASSIGNS_BY","作業者","FIELD","approver","承認者","PROCESS_ASSIGNEE"/.test(csv),
    'CSV 出力に作業者のフィールド指定が含まれる');
  const json = JSON.parse(KTDeps.toJSON(deps));
  assert(json.edges.filter(isEntityEdge).length === 11, 'JSON 出力にフィールド指定由来の 11 エッジが含まれる');
  const md = KTDeps.toMarkdown(deps, { fields: KTDeps.normalizeFields(FX.makeData().fields), onlyUsed: true });
  assert(md.includes('- [プロセス管理] プロセス管理「承認待ち」 — 作業者 〔確実〕')
    && md.includes('- [通知] 通知「アプリの条件通知」 — 通知先 〔確実〕')
    && md.includes('- [アクセス権] アクセス権「レコードACL#1」 — ACL対象 〔確実〕'),
    'Markdown レポートの利用箇所に 通知先・作業者・アクセス権 のフィールド指定が出る');
  assert(KTDeps.searchEdges(deps, '承認者 作業者').total === 1, '横断検索「承認者 作業者」で作業者のフィールド指定が見つかる');
}

// =========================================================
// 11. 依存モデルだけから事実を機械的に引ける（AI向けの専用データは足さない）
// =========================================================
console.log('\n--- 11. 依存モデル（edges）から事実を機械的に取得できる ---');
{
  // 利用側を想定した最小の読み取り：既存のエッジ形式（sourceType / relationType / context）だけを使う
  const factsOf = (d, fieldCode) => {
    const into = d.edges.filter(e => e.targetType === 'FIELD' && e.targetId === fieldCode);
    return {
      referencedByNotification: into.filter(e => e.sourceType === 'NOTIFICATION'),
      usedAsNotifyTarget: into.filter(e => e.relationType === 'NOTIFY_TARGET'),
      usedAsAssignee: into.filter(e => e.relationType === 'ASSIGNS_BY'),
      usedInAcl: into.filter(e => e.sourceType === 'ACL'),
    };
  };
  const approver = factsOf(deps, 'approver');
  assert(approver.referencedByNotification.length === 1 && approver.usedAsNotifyTarget.length === 1, '「approver は通知設定から（通知先として）参照されている」を取得できる');
  assert(approver.usedAsAssignee.length === 1, '「approver は作業者指定に利用されている」を取得できる');
  assert(approver.usedInAcl.length === 1, '「approver はアクセス権に利用されている」を取得できる');
  const owner = factsOf(deps, 'owner');
  assert(owner.referencedByNotification.length === 3 && owner.usedAsNotifyTarget.length === 2,
    'owner: 通知設定からの参照 3 件のうち、通知先としての指定が 2 件・条件式が 1 件と区別できる');
  assert(owner.usedAsAssignee.length === 0 && owner.usedInAcl.length === 1, 'owner: 作業者指定には使われていない／アクセス権には使われている と区別できる');
  const caseName = factsOf(deps, 'case_name');
  assert(caseName.referencedByNotification.length + caseName.usedAsAssignee.length + caseName.usedInAcl.length === 0,
    'case_name: 通知・作業者・アクセス権のいずれにも使われていないと判定できる');

  // 根拠として示せる情報（どの設定の・どの項目か・確度）がエッジに揃っている
  const evidence = [...approver.usedAsNotifyTarget, ...approver.usedAsAssignee, ...approver.usedInAcl];
  assert(evidence.every(e => e.sourceType && e.sourceId && e.sourceName && e.relationType
    && e.context && e.context.settingType && e.context.settingName && e.confidence === 'CERTAIN'),
    '各エッジに 根拠（設定の種別・ID・名前・設定種別・確度）が揃っている');
  const ids = deps.edges.filter(isEntityEdge).map(e => `${e.sourceType}:${e.sourceId}`);
  assert(ids.every(id => deps.nodes.some(n => n.id === id)), 'フィールド指定由来のエッジの参照元は、すべて依存データ上のノードに対応する');
  // 再生成しても同じ結果になる（根拠として安定している）
  assert(JSON.stringify(sigs(buildDeps(FX.makeData()).edges)) === JSON.stringify(sigs(deps.edges)), '同じ設定からは同じエッジが再現される');
}

console.log(failed ? `\n${failed} test(s) FAILED` : '\nAll tests passed');
process.exit(failed ? 1 : 0);
