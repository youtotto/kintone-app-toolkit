/* Saved settings -> one current environment. Structural comparison stays in
 * Config Lens; imported files never become execution plans or AI requests. */
'use strict';
const KTReleaseSettingsCompare = (() => {
  const Lens = typeof KTConfigLensCompare !== 'undefined' ? KTConfigLensCompare : require('./vendor/config-lens-compare.js').KTConfigLensCompare;
  const Diff = typeof KTReleaseEnvironmentDiff !== 'undefined' ? KTReleaseEnvironmentDiff : require('./release-environment-diff.js').KTReleaseEnvironmentDiff;
  const Export = typeof KTReleaseSettingsExport !== 'undefined' ? KTReleaseSettingsExport : require('./release-settings-export.js').KTReleaseSettingsExport;
  const MAX_BYTES = 10 * 1024 * 1024;
  const LABELS = { production: '運用環境', preview: '動作テスト環境' };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = message => { throw Object.assign(new Error(message), { code: 'SETTINGS_COMPARE_FILE' }); };
  const date = value => typeof value === 'string' && Number.isFinite(new Date(value).getTime());
  function parse(text) {
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BYTES) fail('設定ファイルは10MB以下のJSONを選んでください。');
    let doc;
    try { doc = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { fail('JSONを読み取れません。Toolkitの［設定を保存］で保存したファイルを選んでください。'); }
    if (!object(doc) || doc.format !== 'kintone-toolkit-settings') fail('Toolkitで保存した設定ファイルではありません。');
    if (doc.formatVersion !== 1) fail('この設定ファイルの形式の版には対応していません。');
    const source = doc.source;
    if (!object(source) || typeof source.domain !== 'string' || !/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(source.domain) ||
        !/^\d+$/.test(String(source.appId ?? '')) || !Object.hasOwn(LABELS, source.environment) ||
        !/^\d+$/.test(String(source.revision ?? '')) || !date(source.capturedAt) || !date(doc.savedAt)) {
      fail('保存元のアプリ・環境・設定の版・日時を確認できません。');
    }
    if (!object(doc.settings) || !Array.isArray(doc.coverage)) fail('設定と取得範囲の記録がありません。');
    const seen = new Set();
    for (const row of doc.coverage) {
      if (!object(row) || typeof row.id !== 'string' || seen.has(row.id) || !['included', 'partial', 'unavailable'].includes(row.status)) fail('取得範囲の記録が正しくありません。');
      seen.add(row.id);
      const key = Object.hasOwn(Diff.SOURCE_KEYS, row.id) ? Diff.SOURCE_KEYS[row.id] : null;
      if (key && row.key !== key) fail('設定と取得範囲の対応が一致しません。');
      const value = key && doc.settings[key];
      if (key && row.status !== 'unavailable' && value?.revision != null && String(value.revision) !== String(source.revision)) fail('保存された設定の版が混在しています。');
    }
    // Keep only supported data. File-provided instructions, labels and status
    // summaries are not used as authority for comparison or sent to an AI.
    return {
      format: doc.format, formatVersion: 1,
      source: { domain: source.domain.toLowerCase(), appId: String(source.appId), environment: source.environment,
        revision: String(source.revision), capturedAt: source.capturedAt }, savedAt: doc.savedAt,
      settings: Object.fromEntries(Object.values(Diff.SOURCE_KEYS).filter(key => Object.hasOwn(doc.settings, key)).map(key => [key, doc.settings[key]])),
      coverage: doc.coverage.filter(row => Object.hasOwn(Diff.SOURCE_KEYS, row.id)).map(row => ({ id: row.id, key: row.key, status: row.status }))
    };
  }
  function validateFields(properties) {
    const pending = [properties], codes = new Map();
    while (pending.length) {
      const fields = pending.pop();
      if (!object(fields)) throw new Error('FIELDS');
      for (const [key, field] of Object.entries(fields)) {
        if (!object(field) || typeof field.type !== 'string' || !field.type ||
            typeof field.code !== 'string' || field.code !== key || codes.has(key)) throw new Error('FIELDS');
        codes.set(key, field);
        if (Object.hasOwn(field, 'fields')) pending.push(field.fields);
      }
    }
    return codes;
  }
  function fieldInputs(before, after, warnings) {
    const copies = [before, after].map(clone), maps = copies.map(data => validateFields(data.properties));
    for (const code of new Set([...maps[0].keys(), ...maps[1].keys()])) {
      const fields = maps.map(map => map.get(code));
      for (const key of ['lookup', 'referenceTable']) if (fields.some(field => field?.[key] === null)) {
        // These API nulls mean the referenced application's settings were
        // inaccessible. Keep known field changes, never infer removal here.
        for (const field of fields.filter(Boolean)) delete field[key];
        warnings.push('「' + code + '」の' + (key === 'lookup' ? 'ルックアップ' : '関連レコード一覧') + 'の設定を取得できない側があるため、その部分は比較していません。');
      }
    }
    return copies;
  }
  function namedCollection(category, data) {
    const copy = clone(data), names = new Set();
    for (const item of Object.values(copy[category.collection])) {
      if (!object(item) || typeof item.name !== 'string' || !item.name || names.has(item.name)) throw new Error('NAME');
      names.add(item.name); delete item.id;
    }
    return copy;
  }
  function actionInputs(category, before, after) {
    const copies = [before, after].map(clone);
    const maps = copies.map(data => new Map(Object.values(data.actions).map(action => [String(action?.[category.key]), action])));
    // Missing permission-dependent properties are unknown, not deletions.
    for (const [key, a] of maps[0]) {
      const b = maps[1].get(key);
      if (!a || !b) continue;
      for (const property of ['destApp', 'mappings']) if (a[property] == null || b[property] == null) {
        delete a[property]; delete b[property];
      }
    }
    return copies;
  }
  function compare(document, base, options = {}) {
    const current = Export.create(base, { environment: options.environment, domain: options.domain }).document;
    const crossApp = document.source.domain.toLowerCase() !== current.source.domain.toLowerCase() || document.source.appId !== current.source.appId;
    const source = { comparisonType: 'saved-settings', appId: current.source.appId, loadedAt: current.source.capturedAt,
      before: { ...document.source }, after: { ...current.source }, savedAt: document.savedAt, crossApp,
      beforeLabel: '保存ファイル（' + LABELS[document.source.environment] + '）',
      afterLabel: '現在のアプリ（' + LABELS[current.source.environment] + '）' };
    const categories = Lens.CATEGORIES.map(category => {
      const key = Diff.SOURCE_KEYS[category.id];
      const beforeCoverage = document.coverage.find(row => row.id === category.id);
      const afterCoverage = current.coverage.find(row => row.id === category.id);
      const before = document.settings[key], after = current.settings[key];
      const unavailable = warnings => ({ id: category.id, label: category.label, status: 'unavailable', warnings, entries: [] });
      const missing = [];
      if (!beforeCoverage || beforeCoverage.status === 'unavailable' || !before) missing.push('保存ファイルに「' + category.label + '」の取得済み設定がないため比較していません。');
      if (!afterCoverage || afterCoverage.status === 'unavailable' || !after) missing.push('現在のアプリの「' + category.label + '」を取得できていないため比較していません。');
      if (missing.length) return unavailable(missing);
      try {
        Lens.validateResponse(category, before); Lens.validateResponse(category, after);
        let config = category, a = before, b = after;
        const fieldWarnings = [];
        if (category.id === 'fields') [a, b] = fieldInputs(a, b, fieldWarnings);
        if (crossApp && ['views', 'reports', 'actions'].includes(category.id)) {
          a = namedCollection(category, a); b = namedCollection(category, b); config = { ...category, key: 'name' };
        }
        if (category.id === 'actions') [a, b] = actionInputs(config, a, b);
        const compared = Lens.compareCategory(config, a, b);
        // Config Lens's file warnings assume a fresh network read can recover
        // bodies. Settings exports intentionally do not contain those bodies.
        const warnings = ['general', 'customize'].includes(category.id) ? [] : [...compared.warnings, ...fieldWarnings];
        if (['general', 'customize'].includes(category.id) && [before, after].some(value => Lens.settingFiles(category, value).length)) {
          warnings.push('保存ファイルにはファイル本体がないため、登録情報だけを比較しています。本文の一致は確認していません。');
        }
        if (category.id === 'customize' && [before, after].some(value => ['desktop', 'mobile'].some(device => ['js', 'css'].some(kind => value[device][kind].some(file => file.type === 'URL'))))) {
          warnings.push('URL指定のファイルは登録先だけを比較しています。配信される内容は確認していません。');
        }
        if ([beforeCoverage, afterCoverage].some(row => row.status === 'partial')) warnings.push('一部の設定を取得できていません。取得できた範囲だけを比較しています。');
        return { id: category.id, label: category.label, status: warnings.length ? 'partial' : 'ok',
          warnings: [...new Set(warnings)], entries: compared.entries.map(entry => ({ ...entry,
            kind: entry.before === undefined ? 'added' : entry.after === undefined ? 'deleted' : entry.kind })) };
      } catch (e) {
        return unavailable([e.message === 'NAME' ? '別アプリの項目を名前で対応づけられません。名前がないか重複しています。' :
          '「' + category.label + '」の設定が比較に必要な形式を満たしていないため比較していません。']);
      }
    });
    const entries = categories.flatMap(category => category.entries);
    const unavailable = categories.filter(category => category.status !== 'ok').map(category => ({
      categoryId: category.id, label: category.label, status: category.status, reasons: category.warnings
    }));
    const limitations = [
      '保存ファイルを左、現在のアプリの取得済み設定を右に表示します。設定の変更や復元は行いません。',
      'フィールドはフィールドコードで比較します。コードが変わった項目は削除・追加として表示し、同じ項目かどうかは推定しません。',
      'JavaScript・CSS・アイコンは登録情報だけが対象です。ファイル本体やURL先の内容、プラグイン内部の設定は比較していません。',
      'カテゴリー、言語別の名称、Webhook、APIトークン、レコードの内容と実際の動作は比較していません。',
      '手元で編集してまだ登録していないコードは比較に含めません。'
    ];
    if (crossApp) limitations.push(
      '別アプリの比較です。追加・変更・削除は設定の違いを表し、変更履歴や実行する操作ではありません。',
      '一覧・グラフ・アプリアクションは一意の名前で対応づけ、アプリごとに異なる内部IDを比較から除いています。',
      '関連アプリの参照先は自動で対応づけません。参照先アプリIDの違いはそのまま表示します。別ドメインの同じ利用者・組織コードも、同じ対象かは確認していません。'
    );
    return { status: !categories.some(category => ['ok', 'partial'].includes(category.status)) ? 'unavailable' : unavailable.length ? 'partial' : 'ok',
      source, categories, entries, unavailable, codeChanges: [], limitations };
  }
  return { parse, compare, MAX_BYTES };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseSettingsCompare };
