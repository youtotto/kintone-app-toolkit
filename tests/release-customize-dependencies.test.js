'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTReleaseCustomize: C } = require('../src/release-customize.js');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const clone = value => JSON.parse(JSON.stringify(value));
const field = (code, type = 'NUMBER', extra = {}) => ({ code, label: code, type, ...extra });
const source = code => "kintone.events.on('app.record.edit.show', function(event){event.record['" + code + "'].disabled=true;return event;});";
function baseOf() {
  const files = [
    { env: 'preview', target: 'desktop', kind: 'js', type: 'FILE', name: 'lock.js', fileKey: 'pc', sourceAvailable: true, text: source('amount') },
    { env: 'preview', target: 'mobile', kind: 'js', type: 'FILE', name: 'lock.js', fileKey: 'mobile', sourceAvailable: true, text: source('amount') },
    { env: 'preview', target: 'desktop', kind: 'js', type: 'FILE', name: 'other.js', fileKey: 'other', sourceAvailable: true, text: source('memo') }
  ];
  return {
    ok: true, env: 'preview', appId: '398', loadedAt: '2026-10-26T01:00:00Z', revision: { preview: '12', production: '10' }, errors: [], files,
    data: { appId: '398', fields: { amount: field('amount'), memo: field('memo', 'SINGLE_LINE_TEXT'),
      total: field('total', 'CALC', { expression: 'amount*2', label: '合計' }),
      items: field('items', 'SUBTABLE', { fields: { qty: field('qty'), subtotal: field('subtotal', 'CALC', { expression: 'qty*2' }) } }) },
      layout: [], settings: { name: '検証用' }, status: { states: {}, actions: [] }, customize: {
        desktop: { js: files.filter(f => f.target === 'desktop').map(f => ({ type: 'FILE', file: { name: f.name, fileKey: f.fileKey } })), css: [] },
        mobile: { js: [{ type: 'FILE', file: { name: 'lock.js', fileKey: 'mobile' } }], css: [] } } }
  };
}
const documentOf = extra => ({ environment: 'preview', target: 'desktop', kind: 'js', name: 'lock.js', fileKey: 'pc', registeredText: source('amount'), text: 'UNSAVED', ...extra });
const snapshotOf = base => C.createDependencySnapshot(base || baseOf(), T.KTDevBase.analyze);
const infoOf = (snapshot, extra = {}) => C.dependencyInfoOf({ appId: '398', document: documentOf(), fieldCode: 'amount', snapshot, ...extra });

test('実Deps/Scannerを同じ取得単位から一度だけ使い、PC/mobile参照と計算式を表示する', () => {
  const base = baseOf(), before = JSON.stringify(base);
  let count = 0;
  const snapshot = C.createDependencySnapshot(base, current => { count++; return T.KTDevBase.analyze(current); });
  assert.equal(snapshot.status, 'ready'); assert.equal(count, 1);
  const info = infoOf(snapshot);
  assert.equal(info.status, 'ready'); assert.equal(info.loadedAt, base.loadedAt);
  assert.equal(info.environment, 'preview'); assert.equal(info.revision, '12');
  assert.deepEqual(info.jsReferences.map(ref => [ref.target, ref.name, ref.current]), [['desktop', 'lock.js', true], ['mobile', 'lock.js', false]]);
  assert.ok(info.jsReferences.every(ref => ref.lines.length && ref.confidence.length));
  assert.equal(info.formulaReferences.length, 1); assert.equal(info.formulaReferences[0].code, 'total');
  assert.equal(info.formulaReferences[0].expression, 'amount*2');
  assert.deepEqual(info.formulaReferences[0].confidence, ['LIKELY']);
  assert.equal(JSON.stringify(base), before);
  const next = infoOf(snapshot, { fieldCode: 'qty' });
  assert.equal(next.field.parent, 'items'); assert.equal(next.formulaReferences[0].code, 'subtotal');
  assert.equal(count, 1, 'フィールド選択を変えても解析し直さない');
  info.jsReferences[0].lines.push(999); info.fields[0].label = 'changed';
  assert.ok(!JSON.stringify(snapshot).includes('999')); assert.ok(!JSON.stringify(snapshot).includes('changed'));
});
test('古い解析、運用環境、外部アプリ情報を新しい取得結果へ混ぜない', () => {
  const base = baseOf();
  base.deps = { edges: [{ sourceName: 'STALE' }] }; base.scan = { results: [{ code: 'STALE' }] };
  base.productionData = { fields: { bad: field('PRODUCTION') } };
  base.productionFiles = [{ text: 'PRODUCTION' }]; base.incoming = { refs: ['STALE'] };
  base.data.relatedApps = { 99: { name: 'OTHERAPP' } }; base.data.plugins = ['PLUGIN'];
  const snapshot = C.createDependencySnapshot(base, current => {
    assert.equal(current.productionData, undefined); assert.equal(current.productionFiles, undefined);
    assert.equal(current.incoming, null); assert.equal(current.deps, null); assert.equal(current.scan, null);
    assert.deepEqual(current.data.relatedApps, {}); assert.equal(current.data.plugins, null);
    return T.KTDevBase.analyze(current);
  });
  assert.equal(snapshot.status, 'ready');
  assert.ok(!/STALE|PRODUCTION|OTHERAPP|PLUGIN/.test(JSON.stringify(snapshot)));
});
test('アプリ・環境・鮮度が異なる依存情報は使わない', () => {
  const snapshot = snapshotOf();
  for (const extra of [{ appId: '999' }, { document: documentOf({ environment: 'production' }) }]) {
    const info = infoOf(snapshot, extra);
    assert.equal(info.status, 'unavailable'); assert.deepEqual(info.jsReferences, []); assert.deepEqual(info.formulaReferences, []);
  }
  assert.equal(infoOf(snapshot, { stale: true }).status, 'stale');
  for (const mutate of [s => delete s.environment, s => delete s.scan.meta.source, s => s.scan.meta.scannedAt = 'OLDER', s => s.deps.meta.appId = '999']) {
    const bad = clone(snapshot); mutate(bad); assert.equal(infoOf(bad).status, 'unavailable');
  }
  const doc = documentOf({ fileKey: 'different', registeredText: 'different', text: source('amount') });
  const different = infoOf(snapshot, { document: doc });
  assert.equal(different.status, 'ready'); assert.ok(different.documentNotice, '手編集が一致しても登録済み本文との一致と扱わない');
});
test('定義との完全一致だけを選び、ラベルや部分一致やコードの式を解釈しない', () => {
  const snapshot = snapshotOf();
  for (const code of ['amoun', ' amount ', "record['amount']", '合計', 'notFound']) {
    const info = infoOf(snapshot, { fieldCode: code }); assert.equal(info.status, 'unresolved'); assert.equal(info.field, null);
  }
  assert.equal(infoOf(snapshot, { fieldCode: '' }).status, 'select-field');
  assert.equal(infoOf(snapshot, { document: documentOf({ isNew: true, fileKey: null, text: source('memo') }), fieldCode: 'memo' }).status, 'ready');
});
test('取得失敗・URL・取得元不明の本文を未解析として残す', () => {
  const base = baseOf();
  base.files.push({ env: 'preview', target: 'desktop', kind: 'js', type: 'URL', name: 'url.js', sourceAvailable: false });
  base.files.push({ env: 'preview', target: 'desktop', kind: 'js', type: 'FILE', name: 'failed.js', fileKey: 'f', sourceAvailable: false });
  base.files.push({ env: 'production', target: 'desktop', kind: 'js', type: 'FILE', name: 'wrong.js', fileKey: 'w', sourceAvailable: true, text: source('amount') });
  base.files.push({ target: 'desktop', kind: 'js', type: 'FILE', name: 'unknown.js', fileKey: 'u', sourceAvailable: true, text: source('amount') });
  base.errors = [{ env: 'preview', what: 'reports', label: 'グラフ', code: 'DENIED' }];
  const info = infoOf(snapshotOf(base));
  assert.equal(info.status, 'ready'); assert.equal(info.jsReferences.length, 2);
  assert.equal(info.unavailableFiles.length, 4); assert.equal(info.missingSettings[0].label, 'グラフ');
  const html = C.renderDependencyInfo(info);
  assert.match(html, /本文を取得できていません/); assert.match(html, /グラフを取得できていません/);
  assert.match(html, /依存関係がないとは限りません/); assert.match(html, /編集中のコードは解析していません/);
});
test('解析自体の失敗・取得不能を参照ゼロの成功にしない', () => {
  for (const analyze of [() => { throw Error('failed'); }, current => { T.KTDevBase.analyze(current); current.analysisError = 'failed'; },
    current => { T.KTDevBase.analyze(current); current.scan.meta.source = 'production'; }]) {
    const snapshot = C.createDependencySnapshot(baseOf(), analyze);
    assert.equal(snapshot.status, 'unavailable');
    const info = infoOf(snapshot); assert.equal(info.status, 'unavailable');
    assert.doesNotMatch(C.renderDependencyInfo(info), /参照が見つかりません/);
  }
  for (const extra of [{ ok: false }, { env: 'production' }, { loadedAt: null }, { appId: null }, { data: { appId: '999' } }]) {
    let count = 0;
    const snapshot = C.createDependencySnapshot({ ...baseOf(), ...extra }, () => { count++; });
    assert.equal(count, 0); assert.equal(snapshot.status, 'unavailable');
  }
});
test('参照する他JSも同じ登録本文に照合し、同名の曖昧さと式の方向を守る', () => {
  const snapshot = snapshotOf();
  snapshot.scan.files.find(file => file.target === 'mobile').text = 'stale';
  snapshot.deps.edges.push({ sourceType: 'FIELD', sourceId: 'total', targetType: 'FIELD', targetId: 'amount', relationType: 'LOOKUP_KEY', context: { settingType: 'CALC' } });
  snapshot.deps.edges.push({ sourceType: 'FIELD', sourceId: 'memo', targetType: 'FIELD', targetId: 'amount', relationType: 'REFERENCES', context: { settingType: 'CALC' } });
  snapshot.deps.edges.push({ sourceType: 'FIELD', sourceId: 'total', targetType: 'FIELD', targetId: 'amount', relationType: 'REFERENCES', context: { settingType: 'CALC', appId: '999' } });
  const info = infoOf(snapshot);
  assert.equal(info.jsReferences.length, 1); assert.equal(info.unavailableFiles[0].target, 'mobile');
  assert.equal(info.formulaReferences.length, 1);
  const duplicate = snapshotOf(); duplicate.scan.files.push(clone(duplicate.scan.files.find(file => file.target === 'mobile')));
  const ambiguous = infoOf(duplicate);
  assert.equal(ambiguous.jsReferences.length, 1); assert.ok(ambiguous.unavailableFiles.some(file => file.target === 'mobile'));
});
test('表示は名前・式・理由をエスケープし、空の範囲を無依存と断定しない', () => {
  const snapshot = snapshotOf(), info = infoOf(snapshot, { fieldCode: 'memo' });
  info.field.label = '<img src=x onerror=alert(1)>';
  info.jsReferences[0].name = '<script>alert(1)</script>';
  info.formulaReferences = [{ label: '<b>', code: 'x"onmouseover', expression: '<script>x</script>', confidence: [] }];
  info.unavailableFiles.push({ name: '<script>', target: 'desktop', reason: '<img>' });
  const html = C.renderDependencyInfo(info);
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img')); assert.match(html, /&lt;script&gt;/);
  const empty = infoOf(snapshot, { fieldCode: 'total' });
  assert.equal(empty.status, 'ready'); assert.deepEqual(empty.jsReferences, []); assert.deepEqual(empty.formulaReferences, []);
  assert.match(C.renderDependencyInfo(empty), /取得できた範囲では参照が見つかりませんでした/);
  assert.doesNotMatch(C.renderDependencyInfo(empty), /依存関係はありません/);
});

test('手編集を保持した古いコードでも依存更新後の登録済み参照を読める', () => {
  const document = documentOf({ text: 'KEEP UNSAVED WORK' }), before = JSON.stringify(document);
  const newer = baseOf();
  newer.files[0].fileKey = 'updated-pc'; newer.files[0].text = source('memo');
  newer.loadedAt = '2026-10-26T02:00:00Z'; newer.revision.preview = '13';
  for (let update = 0; update < 2; update++) {
    const snapshot = snapshotOf(newer);
    const oldField = infoOf(snapshot, { document });
    assert.equal(oldField.status, 'ready'); assert.equal(oldField.fields.length, 6);
    assert.deepEqual(oldField.jsReferences.map(ref => ref.target), ['mobile']);
    assert.equal(oldField.formulaReferences[0].code, 'total');
    const currentField = infoOf(snapshot, { document, fieldCode: 'memo' });
    assert.equal(currentField.jsReferences.length, 2);
    assert.ok(currentField.documentNotice);
    const html = C.renderDependencyInfo(currentField);
    assert.match(html, /このフィールドを使うJavaScript/); assert.match(html, /このフィールドを使う計算式/);
    assert.match(html, /開いているコードと今回取得した登録済みコードの一致は確認できていません/);
    assert.equal(JSON.stringify(document), before, '編集中のコードを上書きしない');
  }
});

const eventInfoOf = (snapshot, extra = {}) => C.dependencyInfoOf({ appId: '398', document: documentOf(), referenceKind: 'event', eventName: 'app.record.edit.show', snapshot, ...extra });

test('イベントは既存Scannerの結果を同じ取得単位で使い、PC/mobile名と直接/推定を分ける', () => {
  const base = baseOf();
  base.files[1].text = base.files[1].text.replace('app.record.edit.show', 'mobile.app.record.edit.show');
  base.files[2].text = "const events=['app.record.edit.show']; kintone.events.on(events, function(event){ return event; });";
  let analyses = 0;
  const snapshot = C.createDependencySnapshot(base, current => { analyses++; T.KTDevBase.analyze(current); });
  const before = JSON.stringify(snapshot), document = documentOf(), draft = JSON.stringify(document);
  const info = eventInfoOf(snapshot, { document });
  assert.equal(info.status, 'ready'); assert.equal(info.kind, 'event');
  assert.deepEqual(info.events, [{name:'app.record.edit.show'}, {name:'mobile.app.record.edit.show'}]);
  assert.deepEqual(info.jsReferences.map(ref => [ref.target,ref.name,ref.current,ref.direct]),
    [['desktop','lock.js',true,true],['desktop','other.js',false,false]]);
  assert.ok(info.jsReferences.every(ref => ref.lines.length === 0), '元の解析にないイベント行番号は作らない');
  assert.deepEqual(info.formulaReferences, []);
  const mobile = eventInfoOf(snapshot, { eventName: 'mobile.app.record.edit.show' });
  assert.deepEqual(mobile.jsReferences.map(ref => [ref.target,ref.name,ref.current]), [['mobile','lock.js',false]]);
  assert.equal(analyses, 1, '選択で解析を追加しない');
  assert.equal(JSON.stringify(snapshot), before); assert.equal(JSON.stringify(document), draft);
  info.events[0].name='changed'; info.jsReferences[0].name='changed';
  assert.equal(JSON.stringify(snapshot), before, '表示結果を書き換えても取得済み結果は変わらない');
  const html = C.renderDependencyInfo(eventInfoOf(snapshot));
  assert.match(html, /このイベントを使うJavaScript/); assert.match(html, /登録の記述あり/); assert.match(html, /既存の解析による推定/);
  assert.match(html, /開いているファイル/); assert.doesNotMatch(html, /このフィールドを使う計算式|[0-9]行目/);
});

test('イベントもアプリ・環境・鮮度の確認を共用し、未確認の結果を表示しない', () => {
  const snapshot = snapshotOf();
  for (const extra of [{appId:'999'}, {environment:'production'}, {stale:true}]) {
    const info = eventInfoOf(snapshot,extra);
    assert.notEqual(info.status,'ready'); assert.deepEqual(info.events,[]); assert.deepEqual(info.jsReferences,[]);
  }
  for (const mutate of [s=>s.scan.meta.scannedAt='older',s=>s.scan.meta.source='production',s=>s.scan.meta.appId='999',s=>s.deps.meta.appId='999']) {
    const bad=clone(snapshot); mutate(bad);
    const info=eventInfoOf(bad); assert.equal(info.status,'unavailable'); assert.deepEqual(info.events,[]);
  }
  const failed = C.createDependencySnapshot(baseOf(), () => { throw Error('scan failed'); });
  assert.equal(eventInfoOf(failed).status,'unavailable');
});

test('イベントの参照元も本文の取得・登録元・同名の曖昧さを確認する', () => {
  const base=baseOf();
  base.files.push({env:'preview',target:'desktop',kind:'js',type:'URL',name:'remote.js',sourceAvailable:false});
  base.files.push({env:'production',target:'desktop',kind:'js',type:'FILE',name:'wrong.js',sourceAvailable:true,text:source('memo')});
  const snapshot=snapshotOf(base);
  snapshot.scan.files.find(file=>file.name==='other.js').text='different source';
  snapshot.scan.files.push(clone(snapshot.scan.files.find(file=>file.target==='mobile')));
  const info=eventInfoOf(snapshot);
  assert.equal(info.status,'ready'); assert.deepEqual(info.jsReferences.map(ref=>ref.target+':'+ref.name),['desktop:lock.js']);
  assert.equal(info.unavailableFiles.length,4);
  assert.match(C.renderDependencyInfo(info),/URL指定の本文は未確認|同じ環境の本文か確認できません/);
  const changed = documentOf({fileKey:'changed',registeredText:'changed',text:'KEEP DRAFT'});
  const different = eventInfoOf(snapshot,{document:changed});
  assert.equal(different.status,'ready'); assert.ok(different.documentNotice); assert.equal(changed.text,'KEEP DRAFT');
});

test('イベント選択は既存の完全一致だけを使い、式・部分一致や未確認のイベントを補わない', () => {
  const snapshot=snapshotOf();
  for(const eventName of ['edit.show',' app.record.edit.show ',"'app.record.edit.show'",'mobile.app.record.edit.show','app.record.edit']) {
    const info=eventInfoOf(snapshot,{eventName}); assert.equal(info.status,'unresolved'); assert.equal(info.event,null); assert.deepEqual(info.jsReferences,[]);
  }
  const empty=eventInfoOf(snapshot,{eventName:''});
  assert.equal(empty.status,'select-event'); assert.deepEqual(empty.events,[{name:'app.record.edit.show'}]);
  const absent=clone(snapshot); absent.scan.fileEvents={};
  const noEvent=eventInfoOf(absent); assert.equal(noEvent.status,'unresolved'); assert.deepEqual(noEvent.events,[]);
});

test('イベント名・ファイル名をエスケープし、実行と行番号は保証しない', () => {
  const info=eventInfoOf(snapshotOf());
  info.event.name='<img src=x>';
  info.jsReferences[0].name='<script>alert(1)</script>';
  const html=C.renderDependencyInfo(info);
  assert.doesNotMatch(html,/<img|<script/); assert.match(html,/&lt;img/); assert.match(html,/&lt;script&gt;/);
  assert.match(html,/イベントの行番号は既存の解析結果に含まれていません/);
  assert.match(html,/実際の動作は未確認/); assert.match(html,/編集中のコードは解析していません/);
});
