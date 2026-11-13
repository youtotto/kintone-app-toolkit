/* Read-only, allowlisted cost diagnostics. Does not settle, reserve, configure or send requests. */
'use strict';
const KTReleaseBudgetReport = (() => {
  const usageDiagnostics = typeof KTReleaseUsageDiagnostics !== 'undefined' ? KTReleaseUsageDiagnostics : require('./release-usage-diagnostics.js').KTReleaseUsageDiagnostics;
  const SCHEMA = 'toolkit-budget-report-1';
  const obj = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const own = (value, key) => obj(value) && Object.prototype.hasOwnProperty.call(value, key);
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
  const count = value => number(value) != null && Number.isSafeInteger(value) ? value : null;
  const oneOf = (value, values) => values.includes(value) ? value : null;
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const id = (value, prefix) => typeof value === 'string' && new RegExp('^(?:' + prefix + '-)?' + uuid + '$', 'i').test(value) ? value : null;
  const model = value => typeof value === 'string' && /^gpt-(?:6-astra|6-luna|6\.1-sol|6\.1-terra|4\.1(?:-mini|-nano)?|4o(?:-mini)?|5(?:-mini|-nano)?)(?:-\d{4}-\d{2}-\d{2})?$/.test(value) ? value : null;
  const tier = value => oneOf(value, ['default', 'fast', 'priority']);
  const date = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    const ms = Date.parse(value); return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  };
  const REASONS = Object.freeze({
    'usage-totals-unknown': '入力または出力の利用量が確認できません。',
    'cache-usage-unknown': 'キャッシュの読み取り・書き込みの利用量が確認できません。',
    'cache-write-ttl-unknown': 'キャッシュ書き込みの保持期間別の内訳が確認できません。',
    'usage-inconsistent': '利用量の合計と内訳が一致せず、費用を計算できません。',
    'service-tier-missing': '応答に料金区分の記録がなく、適用された単価を確認できません。',
    'service-tier-unknown': '応答の料金区分に対応する単価を確認できません。',
    'unknown-model': '応答モデルに対応する単価を確認できません。',
    'cost-invalid': '費用の計算結果が有効な数値ではありません。',
    'INCOMPLETE_USAGE': '費用を計算するための利用量の情報が不足しています。',
    'INCOMPLETE_SERVICE_TIER': '適用された料金区分または単価を確認できません。',
    'unknown': '費用未確定の詳しい理由は、この記録では確認できません。',
  });
  const reason = value => typeof value === 'string' && own(REASONS, value) ? value : 'unknown';
  const STATUS = Object.freeze({
    'succeeded-cost-unsettled': '応答完了・費用未確定',
    'completion-unknown': '終了不明・費用未確定',
    'in-flight': '進行中',
    'cost-confirmed': '費用の見積もり確定済み',
    'released': '未送信・確保解放済み',
  });
  const FAILURES = Object.freeze({
    'read-failed': '費用の確認情報を読み取れません。',
    'inconsistent-state': '読み取り中に検証枠または記録が変わったため、確認情報を表示できません。',
    'invalid-record': '費用記録の形式を確認できません。',
  });
  const first = (value, keys) => { for (const key of keys) if (own(value, key)) return value[key]; return undefined; };
  function usage(value) {
    const v = obj(value) ? value : {}, d = obj(v.input_tokens_details) ? v.input_tokens_details : obj(v.prompt_tokens_details) ? v.prompt_tokens_details : {};
    const wd = obj(d.cache_write_tokens_details) ? d.cache_write_tokens_details : {}, od = obj(v.output_tokens_details) ? v.output_tokens_details : obj(v.completion_tokens_details) ? v.completion_tokens_details : {};
    const direct = (keys, nested, key) => { const found = keys.find(k => own(v, k)); return count(found ? v[found] : nested?.[key]); };
    return {
      inputTokens: count(first(v, ['input', 'inputTokens', 'input_tokens', 'prompt_tokens'])),
      outputTokens: count(first(v, ['output', 'outputTokens', 'output_tokens', 'completion_tokens'])),
      cachedTokens: direct(['cached', 'cachedTokens', 'cache_read_input_tokens'], d, 'cached_tokens'),
      cacheWriteTokens: direct(['cacheWrite', 'cacheWriteTokens'], d, 'cache_write_tokens'),
      cacheWriteTokens30m: direct(['cacheWrite30m', 'cacheWriteTokens30m'], wd, 'ttl_30m_tokens'),
      cacheWriteTokens12h: direct(['cacheWrite12h', 'cacheWriteTokens12h'], wd, 'ttl_12h_tokens'),
      reasoningTokens: direct(['reasoning', 'reasoningTokens'], od, 'reasoning_tokens'),
    };
  }
  function capture(budget, { now = () => Date.now() } = {}) {
    let capturedAt = null;
    try { const ms = now(); if (typeof ms === 'number' && Number.isFinite(ms)) capturedAt = new Date(ms).toISOString(); } catch { /* Clock failure does not invent a date. */ }
    const base = { schemaVersion: SCHEMA, capturedAt, scope: 'active-budget' };
    const failed = errorReason => ({ ...base, mode: 'unreadable', status: 'unreadable', errorReason, budget: null, totals: null, entries: [] });
    try {
      if (!budget || typeof budget.readState !== 'function' || typeof budget.summary !== 'function') return failed('read-failed');
      const state = budget.readState(), original = JSON.stringify(state), summary = budget.summary();
      // A different tab may settle the same allowance between these reads.
      if (JSON.stringify(budget.readState()) !== original) return failed('inconsistent-state');
      if (!obj(state) || !obj(summary)) return failed('invalid-record');
      if (state.mode === 'disabled' && summary.enabled === false) return { ...base, mode: 'disabled', status: 'disabled', errorReason: null, budget: null, totals: null, entries: [] };
      if (state.mode !== 'on' || summary.ok !== true || summary.enabled !== true) return failed(state.mode === 'broken' ? 'read-failed' : 'inconsistent-state');
      const { config, ledger } = state;
      if (!obj(config) || !obj(ledger) || !Array.isArray(ledger.entries)) return failed('invalid-record');
      if (typeof config.id !== 'string' || !config.id || config.id !== summary.id || config.id !== ledger.id || (ledger.configCreatedAt != null && config.createdAt !== ledger.configCreatedAt)) return failed('inconsistent-state');
      if (ledger.entries.some(e => !obj(e) || !['in-flight', 'done', 'partial-unknown', 'unknown', 'released'].includes(e.status) || !Array.isArray(e.calls) || (e.gatewayCalls != null && !Array.isArray(e.gatewayCalls)))) return failed('invalid-record');
      const entries = ledger.entries.map((e, index) => {
        const confirmed = e.costComplete !== false && e.status === 'done' && number(e.costUsd) != null;
        const currentInFlight = e.status === 'in-flight' && typeof budget.sessionId === 'string' && e.sessionId === budget.sessionId;
        const status = e.status === 'released' ? 'released' : currentInFlight ? 'in-flight' : confirmed ? 'cost-confirmed' : e.responseState === 'succeeded' && e.status !== 'in-flight' ? 'succeeded-cost-unsettled' : 'completion-unknown';
        const source = Array.isArray(e.gatewayCalls) && e.gatewayCalls.length ? e.gatewayCalls : e.calls;
        const gateway = Array.isArray(e.gatewayCalls) && e.gatewayCalls.length > 0;
        const calls = source.map((raw, i) => {
          const c = obj(raw) ? raw : {}, perCallTiers = Array.isArray(e.callServiceTiers);
          const ct = perCallTiers ? (obj(e.callServiceTiers[i]) ? e.callServiceTiers[i] : {}) : source.length === 1 ? e : {};
          const callCost = gateway ? number(c.costUsd) : null;
          const costStatus = !gateway && confirmed ? 'breakdown-unrecorded' : callCost != null ? 'cost-confirmed' : 'unsettled';
          const callReason = costStatus !== 'unsettled' ? null : reason(gateway ? c.costReason : e.reason);
          return { index: i + 1, kind: oneOf(gateway ? c.kind : e.kind, ['ask', 'qa', 'propose', 'proposal', 'plan', 'plan-full', 'plan-patch', 'generate', 'repair']),
            model: model(gateway ? c.model : source.length === 1 ? e.model : null), requestedServiceTier: tier(gateway ? c.requestedServiceTier : ct.requestedServiceTier ?? (!perCallTiers && source.length === 1 ? e.estimatedServiceTier : null)),
            serviceTier: tier(gateway ? c.serviceTier : ct.serviceTier), usage: usage(gateway ? c.usage : raw),
            boundUsd: gateway ? number(c.boundUsd) : null, costUsd: callCost, costStatus, costReason: callReason, usageDiagnostics: gateway ? usageDiagnostics.sanitize(c.usageDiagnostics) : null };
        });
        return { index: index + 1, requestId: id(e.requestId, 'tk'), kind: oneOf(e.kind, ['ask', 'propose', 'plan', 'generate']),
          feature: oneOf(e.feature, ['assistant-qa', 'change-planner', 'customization-generator']), startedAt: date(e.startedAt), endedAt: date(e.endedAt),
          status, responseState: e.responseState === 'succeeded' ? 'succeeded' : null,
          costComplete: confirmed || (e.status === 'released' && e.costComplete === true), costUsd: confirmed || (e.status === 'released' && e.costComplete === true) ? number(e.costUsd) : null,
          knownUsd: number(e.costKnownUsd) ?? (confirmed ? number(e.costUsd) : null), reservedUsd: number(e.reservedUsd), reservedCalls: count(e.reservedCalls), allowanceUsd: number(e.allowanceUsd),
          model: model(e.model), estimatedModel: model(e.estimatedModel), requestedServiceTier: tier(e.requestedServiceTier ?? e.estimatedServiceTier), serviceTier: tier(e.serviceTier),
          costReason: status === 'cost-confirmed' || status === 'released' || status === 'in-flight' ? null : reason(e.reason), calls };
      });
      return { ...base, mode: 'active', status: entries.length ? 'ok' : 'empty', errorReason: null,
        budget: { id: id(config.id, 'b'), createdAt: date(config.createdAt), limitUsd: number(config.limitUsd), maxCalls: count(config.maxCalls) },
        totals: { knownUsd: number(summary.recordedUsd), reservedUsd: number(summary.reservedUsd), usedCalls: count(summary.usedCalls), costUnknownCount: count(summary.costUnknown), completionUnknownCount: count(summary.completionUnknown), inFlightCount: count(summary.inFlight) }, entries };
    } catch { return failed('read-failed'); }
  }
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const amount = value => number(value) == null ? '未確認' : String(Math.round(value * 1e6) / 1e6) + ' 米ドル';
  const integer = value => count(value) == null ? '未確認' : String(value);
  const text = value => value == null ? '未確認' : escape(value);
  function html(report) {
    if (!obj(report) || report.schemaVersion !== SCHEMA || !['active', 'disabled', 'unreadable'].includes(report.mode)) return '<p>費用の確認情報を読み取れません。未確認の費用を0とは判断しません。</p>';
    if (report.mode === 'disabled') return '<p>検証用の費用枠が有効ではないため、確認情報はありません。</p>';
    if (report.mode === 'unreadable') return '<p>' + (own(FAILURES, report.errorReason) ? FAILURES[report.errorReason] : FAILURES['read-failed']) + '未確認の費用を0とは判断しません。</p>';
    const b = report.budget || {}, t = report.totals || {}, entries = Array.isArray(report.entries) ? report.entries : [];
    const usageLabels = { inputTokens: '入力', outputTokens: '出力', cachedTokens: 'キャッシュ読取', cacheWriteTokens: 'キャッシュ書込', cacheWriteTokens30m: '書込30分', cacheWriteTokens12h: '書込12時間', reasoningTokens: '推論' };
    let result = '<p>現在の検証枠は同じドメインで共通です。会話・アプリ単位の集計ではありません。</p><p>検証枠：' + text(id(b.id, 'b')) + '<br>上限：' + amount(b.limitUsd) + '／呼び出し：' + integer(t.usedCalls) + ' / ' + integer(b.maxCalls) + ' 回</p><p>既知の見積もり費用：' + amount(t.knownUsd) + '／保守的な確保額：' + amount(t.reservedUsd) + '</p><p>確保額は上限管理用の額で、実際の請求額ではありません。未確定の費用を0として扱いません。</p>';
    if (!entries.length) result += '<p>この検証枠には要求の記録がありません。</p>';
    for (const e of entries) {
      if (!obj(e)) continue;
      result += '<details class="ktr-budget-report-entry"><summary>要求 ' + integer(e.index) + '：' + (own(STATUS, e.status) ? STATUS[e.status] : '状態未確認') + '</summary><p>要求ID：' + text(id(e.requestId, 'tk')) + '<br>開始：' + text(date(e.startedAt)) + '／終了：' + text(date(e.endedAt)) + '<br>既知の見積もり費用：' + amount(e.knownUsd) + '／保守的な確保額：' + amount(e.reservedUsd) + '</p><p>応答モデル：' + text(model(e.model)) + '／見積もり時モデル：' + text(model(e.estimatedModel)) + '<br>要求した料金区分：' + text(tier(e.requestedServiceTier)) + '／応答の料金区分：' + text(tier(e.serviceTier)) + '</p>';
      if (e.costReason != null && !(Array.isArray(e.calls) && e.calls.some(c => obj(c) && c.costReason != null && reason(c.costReason) !== 'unknown'))) result += '<p>' + REASONS[reason(e.costReason)] + '</p>';
      for (const c of Array.isArray(e.calls) ? e.calls : []) {
        if (!obj(c)) continue;
        const unrecorded = c.costStatus === 'breakdown-unrecorded';
        result += '<details><summary>呼び出し ' + integer(c.index) + '：' + (unrecorded ? '呼び出し別の費用内訳は未記録（要求全体は見積もり確定済み）' : number(c.costUsd) == null ? '費用未確定' : '費用の見積もり確認済み') + '</summary><p>モデル：' + text(model(c.model)) + '<br>要求した料金区分：' + text(tier(c.requestedServiceTier)) + '／応答の料金区分：' + text(tier(c.serviceTier)) + '<br>費用の見積もり：' + (unrecorded ? '未記録（要求全体で確認）' : amount(c.costUsd)) + '／呼び出しの費用上限（見積もり）：' + amount(c.boundUsd) + '</p>';
        if (!unrecorded && number(c.costUsd) == null) result += '<p>' + REASONS[reason(c.costReason)] + '</p>';
        if (c.usageDiagnostics != null || ['cache-write-ttl-unknown', 'cache-usage-unknown', 'usage-inconsistent'].includes(c.costReason)) result += usageDiagnostics.html(c.usageDiagnostics);
        result += '<dl>' + Object.entries(usageLabels).map(([key, label]) => '<dt>' + label + '</dt><dd>' + integer(c.usage?.[key]) + '</dd>').join('') + '</dl></details>';
      }
      result += '</details>';
    }
    return result + '<p>取得日時：' + text(date(report.capturedAt)) + '。保存した時点の記録であり、その後の請求情報との照合は行っていません。</p>';
  }
  return { capture, html };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseBudgetReport };
