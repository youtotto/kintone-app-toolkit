/* Settings-only download from the already acquired application snapshot.
 * Config Lens supplies category definitions and response validation.
 * No network, AI, code analysis, file-body backup or restoration is performed. */
'use strict';
const KTReleaseSettingsExport = (() => {
  const Lens = typeof KTConfigLensCompare !== 'undefined' ? KTConfigLensCompare : require('./vendor/config-lens-compare.js').KTConfigLensCompare;
  const Diff = typeof KTReleaseEnvironmentDiff !== 'undefined' ? KTReleaseEnvironmentDiff : require('./release-environment-diff.js').KTReleaseEnvironmentDiff;
  const LABELS = Object.freeze({ production: '運用環境', preview: '動作テスト環境' });
  // The required shape alone omits optional general settings. These are the
  // documented settings fields; transport/authentication data is never copied.
  const GENERAL_KEYS = ['name', 'description', 'icon', 'theme', 'titleField', 'enableThumbnails',
    'enableBulkDeletion', 'enableComments', 'enableDuplicateRecord', 'enableInlineRecordEditing',
    'firstMonthOfFiscalYear', 'numberPrecision'];
  const NOT_INCLUDED = Object.freeze([
    'JavaScript・CSS・アイコンのファイル本体（登録情報だけを保存します）',
    'URL指定ファイルの配信内容、プラグイン内部の設定',
    'カテゴリー、言語別の名称、Webhook、APIトークン',
    'レコードの内容、手元で編集してまだ登録していないコード'
  ]);
  const clone = value => JSON.parse(JSON.stringify(value));
  const rev = value => (typeof value === 'string' && /^\d+$/.test(value)) || (Number.isSafeInteger(value) && value >= 0) ? String(value) : null;
  const fail = (code, message) => { throw Object.assign(new Error(message), { code: 'SETTINGS_EXPORT_' + code }); };
  function timestamp(value, label) {
    const date = new Date(value);
    if (value == null || !Number.isFinite(date.getTime())) fail('SOURCE', label + 'を確認できません。設定を取り直してください。');
    return date.toISOString();
  }
  function create(base, options = {}) {
    const environment = options.environment, label = LABELS[environment];
    if (!label) fail('ENVIRONMENT', '保存する環境を選んでください。');
    const appId = String(base?.appId ?? '');
    if (base?.env !== 'preview' || !/^\d+$/.test(appId) ||
        options.appId != null && String(options.appId) !== appId) {
      fail('SOURCE', '保存するアプリの設定を確認できません。設定を取り直してください。');
    }
    if (base.stale || base.paused || ['stale', 'loading', 'cancelled', 'paused'].includes(String(base.status || '').toLowerCase())) {
      fail('STALE', '設定の取得が完了していないか、取得後に設定が変わっています。設定を取り直してください。');
    }
    const data = environment === 'preview' ? base.data : base.productionData;
    if (data?.appId != null && String(data.appId) !== appId || data?.env != null && data.env !== environment) {
      fail('SOURCE', '別のアプリまたは環境の設定が含まれているため保存できません。設定を取り直してください。');
    }
    const domain = String(options.domain || '');
    if (!/^[a-z0-9.-]+$/i.test(domain) || !domain.includes('.')) fail('SOURCE', '保存元のドメインを確認できません。');
    const capturedAt = timestamp(base.loadedAt, '設定の取得日時');
    const savedAt = timestamp(options.savedAt ?? Date.now(), '保存日時');
    const inputs = base.comparisonInputs?.[environment];
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) fail('UNAVAILABLE', label + 'の設定を取得できていません。設定を取り直してください。');
    const errors = Array.isArray(base.errors) ? base.errors : [];
    const failed = new Set(errors.filter(error => error.env === environment).map(error => error.what));
    const versions = new Set(Object.values(Diff.SOURCE_KEYS).filter(key => !failed.has(key))
      .map(key => rev(inputs[key]?.revision)).filter(Boolean));
    const expected = rev(base.revision?.[environment]);
    if (expected) versions.add(expected);
    if (versions.size > 1) fail('STALE', label + 'の設定の版が取得中に変わったため保存できません。設定を取り直してください。');
    const revision = [...versions][0];
    if (!revision) fail('UNAVAILABLE', label + 'の設定の版を確認できません。設定を取り直してください。');

    const settings = {}, coverage = [];
    for (const category of Lens.CATEGORIES) {
      const key = Diff.SOURCE_KEYS[category.id], value = inputs[key];
      const row = { id: category.id, key, label: category.label, status: 'unavailable', reasons: [] };
      if (!value || failed.has(key)) {
        row.reasons.push(label + 'の「' + category.label + '」を取得できていないため保存していません。');
      } else {
        try {
          Lens.validateResponse(category, value);
          // File-list structure is part of the settings, even though bodies are
          // deliberately outside this settings-only download.
          if (category.id === 'customize') Lens.settingFiles(category, value);
          const keys = category.id === 'general' ? GENERAL_KEYS : Object.keys(category.shape);
          settings[key] = Object.fromEntries(['revision', ...keys].filter(name => Object.hasOwn(value, name)).map(name => [name, clone(value[name])]));
          row.status = 'included';
          if (category.id === 'actions' && Object.values(value.actions).some(action => action?.destApp == null || action?.mappings == null)) {
            row.status = 'partial';
            row.reasons.push('コピー先や対応する項目に取得できない部分があります。取得できた設定だけを保存しています。');
          }
        } catch (error) {
          row.reasons.push('「' + category.label + '」の取得結果が必要な形式を満たしていないため保存していません。');
        }
      }
      coverage.push(row);
    }
    if (!Object.keys(settings).length) fail('UNAVAILABLE', label + 'に保存できる設定がありません。設定を取り直してください。');
    const unavailable = coverage.filter(row => row.status !== 'included'), complete = !unavailable.length;
    const document = {
      format: 'kintone-toolkit-settings', formatVersion: 1,
      description: '取得できたアプリ設定の保存用JSONです。ファイル本体やレコードを含む完全なバックアップではなく、このファイルから復元する機能はありません。',
      source: { domain, appId, environment, environmentLabel: label, revision, capturedAt }, savedAt,
      settings, coverage,
      completeness: complete ? 'all-supported-settings-included' : 'partial-settings',
      notIncluded: [...NOT_INCLUDED]
    };
    const filename = 'kintone-settings-' + appId + '-' + environment + '-r' + revision + '-' + savedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') + '.json';
    return { filename, text: JSON.stringify(document, null, 2) + '\n', document, complete, unavailable };
  }
  return { create, NOT_INCLUDED };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseSettingsExport };
