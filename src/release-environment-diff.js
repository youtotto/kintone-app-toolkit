/* Unpublished application settings: production -> preview.
 * Config Lens owns structural comparison. This adapter only supplies already
 * acquired KTDevBase responses, provenance and decoded JavaScript text.
 * No request, AI call, conversation interpretation or local editor parsing. */
'use strict';
const KTReleaseEnvironmentDiff = (() => {
  const Lens = typeof KTConfigLensCompare !== 'undefined' ? KTConfigLensCompare : require('./vendor/config-lens-compare.js').KTConfigLensCompare;
  const SOURCE_KEYS = Object.freeze({ fields: 'fields', layout: 'layout', views: 'views', process: 'status',
    notifyApp: 'generalNotify', notifyRecord: 'perRecordNotify', notifyReminder: 'reminderNotify',
    aclApp: 'appAcl', aclRecord: 'recordAcl', aclField: 'fieldAcl', general: 'settings', reports: 'reports',
    actions: 'actions', customize: 'customize', plugins: 'appPlugins', notes: 'adminNotes' });
  const LIMITATIONS = Object.freeze([
    '取得した設定を、運用環境から動作テスト環境への変更として比較しています。変更した理由や承認の有無は分かりません。',
    'JavaScriptの本文は取得したテキストを比較しています。元のバイト列・文字コードの一致は確かめていません。',
    'URL指定のファイル、CSS、アイコンの内容と、プラグイン内部の設定は比較していません。',
    'カテゴリー、言語別の名称、Webhook、APIトークン、レコードの内容と実際の動作は比較していません。',
    '手元で編集してまだ登録していないコードは、環境間の変更一覧に含めません。'
  ]);
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const revision = value => typeof value === 'string' && /^\d+$/.test(value) || Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  const sourceOf = base => ({ appId: String(base?.appId ?? ''), loadedAt: base?.loadedAt ?? null,
    productionEnvironment: 'production', previewEnvironment: 'preview',
    productionRevision: revision(base?.revision?.production), previewRevision: revision(base?.revision?.preview) });
  function staleReasons(base, inputs, source) {
    const reasons = [];
    if (base?.env !== 'preview' || !source.appId) reasons.push('比較元のアプリまたは環境を確認できません。');
    if (base?.stale || base?.status === 'stale' || base?.status === 'loading' || base?.status === 'cancelled') reasons.push('設定の取得が完了していないか、取得後に設定が変わっています。');
    for (const env of ['production', 'preview']) {
      const data = env === 'preview' ? base?.data : base?.productionData;
      if (data?.appId != null && String(data.appId) !== source.appId) reasons.push('別のアプリの設定が含まれているため比較できません。');
      const revisions = new Set(Object.values(inputs?.[env] || {}).map(value => revision(value?.revision)).filter(Boolean));
      const expected = source[env + 'Revision'];
      if (expected) revisions.add(expected);
      if (revisions.size > 1) reasons.push((env === 'preview' ? '動作テスト環境' : '運用環境') + 'の設定の版が取得中に変わったため比較できません。設定を取り直してください。');
    }
    return [...new Set(reasons)];
  }
  // File keys are environment-specific. Equality tokens represent exact decoded
  // text, not a hash, byte count, approval or assertion about original bytes.
  function fileInputs(base) {
    const tokens = new Map(), hashes = new Map(), conflicted = new Set();
    for (const [env, files] of [['production', base?.productionFiles], ['preview', base?.files]]) {
      for (const file of files || []) {
        if (file?.env !== env || file.type !== 'FILE' || file.kind !== 'js' || !['desktop', 'mobile'].includes(file.target) || file.sourceAvailable !== true || typeof file.text !== 'string' || !file.fileKey) continue;
        if (!tokens.has(file.text)) tokens.set(file.text, '取得した本文 ' + (tokens.size + 1));
        const key = env + ':' + file.fileKey, token = tokens.get(file.text);
        if (hashes.has(key) && hashes.get(key) !== token) conflicted.add(key);
        hashes.set(key, token);
      }
    }
    for (const key of conflicted) hashes.delete(key);
    return hashes;
  }
  function fileResponse(category, response, env) {
    const copy = clone(response);
    for (const entry of Lens.settingFiles(category, copy)) {
      if (typeof entry.file?.fileKey === 'string') entry.file.fileKey = env + ':' + entry.file.fileKey;
    }
    return copy;
  }
  function publicValue(value) {
    if (Array.isArray(value)) return value.map(publicValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key === 'contentHash' ? 'contentComparison' : key, publicValue(item)]));
  }
  function entryOf(entry) {
    return { categoryId: entry.categoryId, code: entry.code, label: entry.label,
      kind: entry.before === undefined ? 'added' : entry.after === undefined ? 'deleted' : entry.kind,
      before: publicValue(entry.before), after: publicValue(entry.after),
      rows: entry.rows.map(row => ({ path: row.path.map(key => key === 'contentHash' ? 'contentComparison' : key), before: publicValue(row.before), after: publicValue(row.after) })) };
  }
  function changedCode(base, customization, hashes) {
    if (!customization || !['ok', 'partial'].includes(customization.status)) return [];
    const input = base.comparisonInputs;
    const read = (entry, env, target) => {
      if (!entry) return null;
      const name = entry.type === 'FILE' ? entry.file?.name : entry.url;
      const files = env === 'preview' ? base.files : base.productionFiles;
      const found = entry.type === 'FILE' && hashes.has(env + ':' + entry.file?.fileKey)
        ? (files || []).find(file => file.env === env && file.target === target && file.kind === 'js' && file.type === 'FILE' && file.fileKey === entry.file?.fileKey && file.sourceAvailable === true && typeof file.text === 'string') : null;
      return { environment: env, name: String(name || ''), type: entry.type,
        contentStatus: found ? 'available' : 'unavailable', text: found ? found.text : null };
    };
    const result = [];
    for (const target of ['desktop', 'mobile']) {
      const beforeFiles = input.production.customize[target].js, afterFiles = input.preview.customize[target].js;
      for (let index = 0; index < Math.max(beforeFiles.length, afterFiles.length); index++) {
        const before = read(beforeFiles[index], 'production', target), after = read(afterFiles[index], 'preview', target);
        if (before && after && before.contentStatus === 'available' && after.contentStatus === 'available' && before.text === after.text) continue;
        const contentKnown = [before, after].filter(Boolean).every(file => file.contentStatus === 'available');
        result.push({ target, position: index + 1, kind: !before ? 'added' : !after ? 'deleted' : contentKnown ? 'changed' : 'unknown',
          comparison: contentKnown ? 'decoded-text-exact' : 'unavailable', before, after });
      }
    }
    return result;
  }
  function compare(base) {
    const source = sourceOf(base), inputs = base?.comparisonInputs, stale = staleReasons(base, inputs, source), hashes = fileInputs(base);
    const categories = Lens.CATEGORIES.map(category => {
      const key = SOURCE_KEYS[category.id], before = inputs?.production?.[key], after = inputs?.preview?.[key];
      const failed = (base?.errors || []).filter(error => error.what === key && ['production', 'preview'].includes(error.env));
      if (stale.length) return { id: category.id, label: category.label, status: 'stale', warnings: [...stale], entries: [] };
      if (!before || !after || failed.length) {
        const missing = ['production', 'preview'].filter(env => !inputs?.[env]?.[key] || failed.some(error => error.env === env));
        return { id: category.id, label: category.label, status: 'unavailable',
          warnings: missing.map(env => (env === 'preview' ? '動作テスト環境' : '運用環境') + 'の「' + category.label + '」を取得できていないため比較していません。'), entries: [] };
      }
      try {
        let live = before, preview = after;
        if (['general', 'customize'].includes(category.id)) {
          live = fileResponse(category, before, 'production'); preview = fileResponse(category, after, 'preview');
        }
        const result = Lens.compareCategory(category, live, preview, hashes), warnings = [...result.warnings];
        if (category.id === 'customize' && [before, after].some(data => ['desktop', 'mobile'].some(device => ['js', 'css'].some(kind => data[device][kind].some(file => file?.type === 'URL'))))) {
          warnings.push('URL指定のファイルは登録先だけを比較しています。配信される内容は確認していません。');
        }
        return { id: category.id, label: category.label, status: warnings.length ? 'partial' : result.state,
          warnings: [...new Set(warnings)], entries: result.entries.map(entryOf),
          productionRevision: result.liveRevision, previewRevision: result.previewRevision };
      } catch (error) {
        return { id: category.id, label: category.label, status: 'unavailable', warnings: ['「' + category.label + '」の取得結果が比較に必要な形式を満たしていません。設定を取り直してください。'], entries: [] };
      }
    });
    const entries = categories.flatMap(category => category.entries), unavailable = categories.filter(category => category.status !== 'ok')
      .map(category => ({ categoryId: category.id, label: category.label, status: category.status, reasons: category.warnings }));
    const availableCount = categories.filter(category => ['ok', 'partial'].includes(category.status)).length;
    return { status: stale.length ? 'stale' : !availableCount ? 'unavailable' : unavailable.length ? 'partial' : 'ok',
      source, categories, entries, unavailable, codeChanges: changedCode(base, categories.find(category => category.id === 'customize'), hashes), limitations: [...LIMITATIONS] };
  }
  function toLegacySummary(result) {
    const kindOf = { fields: 'field', layout: 'layout', views: 'view', process: 'process', customize: 'javascript',
      notifyApp: 'notification', notifyRecord: 'notification', notifyReminder: 'reminder', aclApp: 'acl', aclRecord: 'acl', aclField: 'acl', general: 'settings', reports: 'report', actions: 'action', plugins: 'plugin', notes: 'notes' };
    const items = result.entries.map(entry => ({ kind: kindOf[entry.categoryId] || entry.categoryId, id: String(entry.code),
      change: { added: 'PREVIEW_ONLY', deleted: 'PRODUCTION_ONLY', changed: 'CHANGED' }[entry.kind], label: entry.label,
      message: (result.categories.find(category => category.id === entry.categoryId)?.label || entry.categoryId) + '「' + entry.label + '」：' + ({ added: '追加', deleted: '削除', changed: '変更' }[entry.kind]),
      categoryId: entry.categoryId }));
    const byKind = {}; for (const item of items) byKind[item.kind] = (byKind[item.kind] || 0) + 1;
    return { available: ['ok', 'partial'].includes(result.status), complete: result.status === 'ok', status: result.status,
      items, counts: { total: items.length, byKind }, coverage: result.unavailable,
      reason: result.unavailable.length ? '取得できた範囲の比較です。比較できていない設定があります。' : null };
  }
  const pathLabel = path => path.map(key => key === 'contentComparison' ? '本文（取得したテキスト）' : Lens.displayName(key)).join(' / ');
  const formatValue = (value, path = []) => Lens.format(value, path);
  return { compare, toLegacySummary, pathLabel, formatValue, SOURCE_KEYS };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseEnvironmentDiff };
