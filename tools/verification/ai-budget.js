// Offline verification only. Not included in the public UserScript.
  const KTAiBudget = (() => {
    const { AiClientError, ERROR_CODES } = KTAiClient;
    const CONFIG_PREFIX = 'ktAi.budget.v1', LEDGER_PREFIX = 'ktAi.budgetLedger.v1', LEDGER_VERSION = 1;
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    /** OpenAI Standard単価（2026-10-27、米ドル/100万token）。予約は読取割引に頼らず書込の最大単価を使う。 */
    const PRICES = Object.freeze({
      'gpt-6-astra': Object.freeze({ input: 10, output: 50, cachedInput: 1, cacheWrite30m: 12.5, cacheWrite12h: 25, longThreshold: 272000 }),
      'gpt-6.1-sol': Object.freeze({ input: 2, output: 10, cachedInput: 0.1, cacheWrite30m: 2.5, cacheWrite12h: 5, longThreshold: 272000 }),
      'gpt-6-luna': Object.freeze({ input: 0.1, output: 0.5, cachedInput: 0.01, cacheWrite30m: 0.125, cacheWrite12h: 0.25, longThreshold: 272000 }),
      'gpt-6.1-terra': Object.freeze({ input: 1, output: 5, cachedInput: 0.05, cacheWrite30m: 1.25, cacheWrite12h: 2.5, longThreshold: 272000 }),
    });
    /** 送る要求の種類 → Gateway の feature（表に無い種類は送らない） */
    const FEATURE_OF = Object.freeze({ ask: 'assistant-qa', propose: 'assistant-qa', plan: 'change-planner', generate: 'customization-generator' });
    /** feature ごとのモデル（health の limits が無い古い Gateway のとき。staging の値） */
    const DEFAULT_MODEL = Object.freeze({ 'assistant-qa': 'gpt-6.1-sol', 'change-planner': 'gpt-6.1-sol', 'customization-generator': 'gpt-6.1-sol' });
    /** 出力の上限（staging の値: 会話 4,000・計画 48,000・生成 32,000）。health の limits.features[].maxOutputTokens があればその値（Gateway が実際に使う上限） */
    const OUTPUT_LIMITS = Object.freeze({ 'assistant-qa': 4000, 'change-planner': 48000, 'customization-generator': 32000 });
    /** 1 回の要求の中の AI の呼び出しの最大（会話・仮案 1・計画の全体 1・差分 2（差分 → 全体）・生成 1 ＋ 修復 2）。health の maxAiCalls があれば大きい方（計画の全体は 1 のまま） */
    const MAX_CALLS = Object.freeze({ ask: 1, propose: 1, 'plan-full': 1, 'plan-patch': 2, generate: 3 });
    /**
     * Gatewayの固定指示とschemaのバイト数に余裕を足した推定。2026-10-27の固定素材測定を反映。
     * 本文の実サイズはGatewayで確認する。Toolkit側の値を実際の入力上界と保証しない。
     */
    const PROMPT_BYTES = Object.freeze({ ask: 18000, propose: 55000, 'plan-full': 110000, 'plan-patch': 120000, generate: 40000 });
    /** 送る Context は Gateway で字下げ・カタログが足される（計画で約 1.25 倍）。入力 token はバイト数 / 2（実機の計画で実際の約 2 倍）。修復の入力には前の出力と指摘が足される */
    const CTX_FACTOR = 1.3, BYTES_PER_TOKEN = 2, REPAIR_EXTRA_TOKENS = 4000;
    const STATUSES = Object.freeze(['in-flight', 'done', 'partial-unknown', 'unknown', 'released']);
    const round6 = (x) => Math.round(Number(x) * 1e6) / 1e6;
    const num = (v) => (v == null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));
    const safeJson = (v) => { try { return JSON.stringify(v) || ''; } catch (e) { return ''; } };
    const utf8Bytes = (s) => {
      const t = String(s || '');
      if (typeof TextEncoder !== 'undefined') { try { return new TextEncoder().encode(t).length; } catch (e) { } }
      let n = 0; for (const ch of t) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return n;
    };
    /** 単価（表のモデル名か、その日付つきの版 name-YYYY-MM-DD）。表に無ければ null */
    function priceOf(model) {
      const m = typeof model === 'string' ? model.trim() : '';
      if (!m) return null;
      if (own(PRICES, m)) return PRICES[m];
      const d = /^(.+)-\d{4}-\d{2}-\d{2}$/.exec(m);
      return d && own(PRICES, d[1]) ? PRICES[d[1]] : null;
    }
    /** healthで明示されたtierを使う。古いhealthの未指定だけStandardとして扱う。 */
    const SERVICE_TIER_FACTORS = Object.freeze({ default: 1, fast: 2, priority: 2 });
    function tierPriceOf(model, serviceTier = null) {
      const price = priceOf(model), factor = serviceTier == null ? 1 : SERVICE_TIER_FACTORS[serviceTier];
      if (!price || !factor || !own(SERVICE_TIER_FACTORS, serviceTier == null ? 'default' : serviceTier)) return null;
      return factor === 1 ? price : { ...price, input: price.input * factor, output: price.output * factor,
        cachedInput: price.cachedInput * factor, cacheWrite30m: price.cacheWrite30m * factor, cacheWrite12h: price.cacheWrite12h * factor };
    }
    const boundUsdOf = (price, input, output) => {
      const long = input > price.longThreshold;
      return Math.ceil(input * price.cacheWrite12h * (long ? 2 : 1) + output * price.output * (long ? 1.5 : 1)) / 1e6;
    };
    // Missing or inconsistent cache details are unknown, never zero-priced.
    function usageCostUsd(price, c) {
      if (!price || !c) return null;
      const counts = [c.input, c.output, c.cached, c.cacheWrite, c.cacheWrite30m, c.cacheWrite12h];
      if (!counts.every(n => Number.isSafeInteger(n) && n >= 0) || c.cached + c.cacheWrite > c.input || c.cacheWrite30m + c.cacheWrite12h !== c.cacheWrite || (c.reasoning != null && c.reasoning > c.output)) return null;
      const long = c.input > price.longThreshold;
      const inputCost = (c.input - c.cached - c.cacheWrite) * price.input + c.cached * price.cachedInput + c.cacheWrite30m * price.cacheWrite30m + c.cacheWrite12h * price.cacheWrite12h;
      const micro = Math.ceil(inputCost * (long ? 2 : 1) + c.output * price.output * (long ? 1.5 : 1));
      return Number.isSafeInteger(micro) ? micro / 1e6 : null;
    }
    /**
     * 次の要求の最大費用（キャッシュの割引なし）。kind = ask / propose / plan / generate。ctx = 送る Context（バイト数だけを使う）。
     *   limits = health の limits（limitsFromHealth の形。features[feature] の model・maxOutputTokens・maxAiCalls）。表に無いモデル・種類は ok: false
     * @returns {{ ok:true, kind, feature, mode, model, price, maxOutputTokens, ctxBytes, calls:Array<{kind,input,output,usd}>, maxCalls, maxUsd, maxCallUsd } | { ok:false, reason, ... }}
     */
    function requestModelOf(feature, lf, ctx) {
      const purpose = feature !== 'assistant-qa' ? null : ctx?.businessSnapshot || ctx?.focus?.target?.type === 'business-understanding' ? 'business' : ctx?.focus?.target?.type === 'app-diagnosis' ? 'diagnosis' : ['consultation', 'document', 'ideation'].includes(ctx?.requestPurpose) ? ctx.requestPurpose : null;
      const model = purpose && lf?.modelsByPurpose?.[purpose] || lf?.model;
      return typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_MODEL[feature];
    }
    function requestServiceTierOf(feature, lf, ctx) {
      const purpose = feature !== 'assistant-qa' ? null : ctx?.businessSnapshot || ctx?.focus?.target?.type === 'business-understanding' ? 'business' : ctx?.focus?.target?.type === 'app-diagnosis' ? 'diagnosis' : ['consultation', 'document', 'ideation'].includes(ctx?.requestPurpose) ? ctx.requestPurpose : null;
      const tier = purpose && lf?.serviceTiersByPurpose && own(lf.serviceTiersByPurpose, purpose) ? lf.serviceTiersByPurpose[purpose] : lf?.serviceTier;
      return tier == null ? null : typeof tier === 'string' ? tier.trim() : '';
    }
    function estimate({ kind, ctx = null, limits = null, ctxBytes = null } = {}) {
      const feature = typeof kind === 'string' && own(FEATURE_OF, kind) ? FEATURE_OF[kind] : null;
      if (!feature) return { ok: false, reason: 'unknown-feature', kind: String(kind || '').slice(0, 40) };
      const lfs = limits && limits.features && typeof limits.features === 'object' ? limits.features : null;
      const lf = lfs && lfs[feature] && typeof lfs[feature] === 'object' ? lfs[feature] : null;
      const model = requestModelOf(feature, lf, ctx);
      if (!priceOf(model)) return { ok: false, reason: 'unknown-model', kind, feature, model: String(model || '').slice(0, 60) };
      const serviceTier = requestServiceTierOf(feature, lf, ctx), price = tierPriceOf(model, serviceTier);
      if (!price) return { ok: false, reason: 'unknown-service-tier', kind, feature, model, serviceTier };
      //   レビューの指摘（2026-10-09・費用の見積もり）: 出力の上限は health の limits.features[feature].maxOutputTokens（Gateway が実際に使う上限）があればその値、
      //   無ければ表の値（以前は大きい方）。応答の設定の上限がこの値を超えたら以後を止める（settle が見積もりに使った値と比べる）
      const purpose = feature !== 'assistant-qa' ? null : ctx?.businessSnapshot || ctx?.focus?.target?.type === 'business-understanding' ? 'business' : ctx?.focus?.target?.type === 'app-diagnosis' ? 'diagnosis' : ctx?.requestPurpose;
      const hOut = lf ? num(lf.maxOutputTokensByPurpose?.[purpose] ?? lf.maxOutputTokens) : null;
      const maxOut = hOut && hOut > 0 ? Math.ceil(hOut) : OUTPUT_LIMITS[feature];
      const hCallsRaw = lf ? num(lf.maxAiCalls) : null;
      const hCalls = hCallsRaw && hCallsRaw > 0 ? Math.floor(hCallsRaw) : 0;
      const bytes = num(ctxBytes) != null ? num(ctxBytes) : utf8Bytes(safeJson(aiInputOf(ctx)));
      const inTok = (key) => Math.ceil((PROMPT_BYTES[key] + CTX_FACTOR * bytes) / BYTES_PER_TOKEN);
      const patch = kind === 'plan' && !!(ctx && ctx.revision && ctx.revision.mode === 'patch');
      const mode = kind === 'plan' ? (patch ? 'plan-patch' : 'plan-full') : kind;
      let calls = [];
      if (kind === 'generate') {
        const n = Math.max(MAX_CALLS.generate, hCalls), i0 = inTok('generate');
        calls.push({ kind: 'generate', input: i0, output: maxOut });
        for (let i = 1; i < n; i++) calls.push({ kind: 'repair', input: i0 + maxOut + REPAIR_EXTRA_TOKENS, output: maxOut });
      } else if (patch) {
        const n = Math.max(MAX_CALLS['plan-patch'], hCalls);
        calls.push({ kind: 'plan-patch', input: inTok('plan-patch'), output: maxOut });
        for (let i = 1; i < n; i++) calls.push({ kind: 'plan-full', input: inTok('plan-full'), output: maxOut });
      } else {
        const n = kind === 'plan' ? MAX_CALLS['plan-full'] : Math.max(MAX_CALLS[kind], hCalls);
        for (let i = 0; i < n; i++) calls.push({ kind: mode, input: inTok(mode), output: maxOut });
      }
      calls = calls.map(c => ({ ...c, usd: boundUsdOf(price, c.input, c.output) }));
      return { ok: true, kind, feature, mode, model, serviceTier, price: { input: price.input, output: price.output, ...(price.cachedInput != null ? { cachedInput: price.cachedInput } : {}) }, maxOutputTokens: maxOut, ctxBytes: bytes, calls, maxCalls: calls.length, maxUsd: round6(calls.reduce((s, c) => s + c.usd, 0)), maxCallUsd: Math.max(...calls.map(c => c.usd)) };
    }
    /** Gateway の上界の式のメッセージ 1 つあたりのバイト数（worker の budget.mjs の MESSAGE_OVERHEAD_BYTES と同じ）と、1 回の呼び出しのメッセージの数（指示と本文） */
    const MESSAGE_OVERHEAD_BYTES = 64, MESSAGES_PER_CALL = 2;
    /** 修復・全体の作り直しの入力に足す前回の出力（出力の上限の token 数 × このバイト数）と、指摘・失敗の情報の余裕（バイト） */
    const PREV_OUTPUT_BYTES_PER_TOKEN = 2, RETRY_EXTRA_BYTES = 8000;
    /** 送る Context を Gateway が provider への本文に入れる形（字下げ 1 の JSON を、さらに本文の JSON の文字列として入れる）のバイト数。Toolkit の推定（Gateway は一部だけを入れることもある） */
    /** 2026-10-21: 見積もりに使う Context（AI に渡す部分）。生成の Context の動作テストに使う既存 JS の本文（verification.relatedFiles[].text）は生成の AI の指示文に入らないので数えない
     *   （Gateway の validate-generator-context が Context の上限から除くものと同じ。要求の大きさとは別。AI版 契約 20 §21） */
    const aiInputOf = (ctx) => (ctx && typeof ctx === 'object' && ctx.verification && typeof ctx.verification === 'object' && Array.isArray(ctx.verification.relatedFiles) ? { ...ctx, verification: { ...ctx.verification, relatedFiles: ctx.verification.relatedFiles.map(f => (f && typeof f === 'object' && typeof f.text === 'string' ? { ...f, text: '' } : f)) } } : ctx);
    const gatewayBodyBytesOf = (ctx) => { const c = aiInputOf(ctx); let s = ''; try { s = JSON.stringify(JSON.stringify(c === undefined ? null : c, null, 1)) || ''; } catch (e) { s = safeJson(c); } return utf8Bytes(s); };
    /**
     * 再検証前の確認（並行の要求・2026-10-10）: 印のある Gateway（enforcement gateway）に渡す allowanceUsd の上限にする「この要求の上界の見積もり」。
     *   Gateway の上界の式（worker の budget.mjs: (provider に送る本文のバイト数 ＋ 64 × メッセージの数) × 入力の単価 / 1e6 ＋ 出力の上限 × 出力の単価 / 1e6）に寄せた
     *   Toolkit の推定（Gateway が強制する値ではない。provider に送る本文を Toolkit は見られない）:
     *   入力 = 送る Context を Gateway が本文に入れる形のバイト数（gatewayBodyBytesOf。1 token を 1 バイト以上とみる Gateway と同じく、バイト数をそのまま token 数とする）
     *   ＋ 指示と出力の schema の大きさの保守的な定数（PROMPT_BYTES）＋ 64 × 2。出力 = 出力の上限（health の limits があればその値）。
     *   呼び出し = 内部の呼び出しの最大（estimate と同じ: 計画の差分 → 全体の作り直し・生成 ＋ 修復）。修復・作り直しの入力には前回の出力（出力の上限 × 2 バイト）と余裕を足す。
     *   キャッシュの割引なし。金額は呼び出しごとに 1e-6 米ドルへ切り上げ
     * @returns {{ ok:true, kind, mode, model, maxOutputTokens, bodyBytes, calls:Array<{kind,inputBytes,output,usd}>, maxCalls, maxUsd } | { ok:false, reason }}
     */
    function gatewayBound({ kind, ctx = null, limits = null, bodyBytes = null } = {}) {
      const e = estimate({ kind, ctx, limits, ctxBytes: 0 });
      if (!e.ok) return e;
      const price = tierPriceOf(e.model, e.serviceTier);
      const body = num(bodyBytes) != null ? num(bodyBytes) : gatewayBodyBytesOf(ctx);
      const patch = kind === 'plan' && !!(ctx && ctx.revision && ctx.revision.mode === 'patch');
      const maxOut = e.maxOutputTokens;
      const over = MESSAGE_OVERHEAD_BYTES * MESSAGES_PER_CALL;
      const first = PROMPT_BYTES[e.mode] + body + over;
      const retry = (base) => base + RETRY_EXTRA_BYTES;
      const calls = [];
      if (kind === 'generate') {
        calls.push({ kind: 'generate', inputBytes: first });
        for (let i = 1; i < e.maxCalls; i++) calls.push({ kind: 'repair', inputBytes: retry(first + maxOut * PREV_OUTPUT_BYTES_PER_TOKEN) });
      } else if (patch) {
        calls.push({ kind: 'plan-patch', inputBytes: first });
        for (let i = 1; i < e.maxCalls; i++) calls.push({ kind: 'plan-full', inputBytes: retry(PROMPT_BYTES['plan-full'] + body + over) });
      } else {
        for (let i = 0; i < e.maxCalls; i++) calls.push({ kind: e.mode, inputBytes: first });
      }
      const out = calls.map(c => ({ ...c, output: maxOut, usd: boundUsdOf(price, c.inputBytes, maxOut) }));
      return { ok: true, kind, mode: e.mode, model: e.model, serviceTier: e.serviceTier, maxOutputTokens: maxOut, bodyBytes: body, calls: out, maxCalls: out.length, maxUsd: round6(out.reduce((s, c) => s + c.usd, 0)) };
    }
    /** 検証の上限で送らない例外（BUDGET_EXCEEDED。details.budget = { reason, needUsd, remainingUsd, needCalls, remainingCalls, limitUsd, maxCalls, ... }） */
    function budgetError(reason, info = {}) {
      const budget = { reason, ...info };
      return new AiClientError({ code: ERROR_CODES.BUDGET_EXCEEDED, message: KTAiClient.errorText(ERROR_CODES.BUDGET_EXCEEDED, { details: { budget } }), details: { budget } });
    }
    /**
     * AI を呼ぶ前に止まった失敗か（確保を解放してよい）。認証・契約・版・送信データの拒否・月次の上限・Gateway 自身のレート制限（detail に制限の情報がある）・
     *   Toolkit が送る前に止めたもの（検証の上限・Context が無い・接続が無い）。応答を受けた後の Toolkit の検証の失敗（details.errors）は AI を呼んだ後
     */
    const PRE_AI_CODES = new Set(['AUTH_INVALID_TOKEN', 'AUTH_TOKEN_EXPIRED', 'AUTH_DOMAIN_MISMATCH', 'PRODUCT_NOT_ENTITLED', 'FEATURE_NOT_ENTITLED', 'FEATURE_NOT_IMPLEMENTED', 'UNKNOWN_PROMPT_VERSION', 'UNSUPPORTED_CONTRACT_VERSION', 'INVALID_ENVELOPE', 'INVALID_CONTEXT', 'PAYLOAD_TOO_LARGE', 'MONTHLY_LIMIT_EXCEEDED', 'BUDGET_EXCEEDED', 'CONDITION_SOURCE_UNVERIFIABLE', 'REQUIRED_EFFECTS_UNRESOLVED', 'SANDBOX_OUTDATED', 'SANDBOX_UNAVAILABLE', 'NO_CONTEXT', 'SESSION_EXPIRED', 'NOT_CONNECTED', 'NO_CONFIG']);
    /** Gateway のエラーの本文の error.detail（無ければ null） */
    const gatewayDetailOf = (e) => { const d = e && e.details && e.details.error && typeof e.details.error === 'object' ? e.details.error.detail : null; return d && typeof d === 'object' && !Array.isArray(d) ? d : null; };
    /**
     * 再検証前の確認（時間切れの記録・2026-10-10）: Gateway のエラーの本文の費用の記録（形を確かめる前の値）。error.detail.budget（detail が object のとき）と、
     *   detail が文字列の応答（502 UPSTREAM_ERROR detail "timeout"。detail を変えないため）の error.budget の両方を読む（detail.budget を先に）。無ければ null
     */
    const gatewayBudgetRawOf = (e) => {
      const d = gatewayDetailOf(e);
      if (d && d.budget && typeof d.budget === 'object') return d.budget;
      const er = e && e.details && e.details.error && typeof e.details.error === 'object' ? e.details.error : null;
      return er && er.budget && typeof er.budget === 'object' && !Array.isArray(er.budget) ? er.budget : null;
    };
    /**
     * 2026-10-10（再検証前の指示 §4）: Gateway の BUDGET_EXCEEDED が AI を呼んだ後のものか（stage が first でない＝計画の差分の後の全体の作り直しを止めたなど、
     *   または費用の記録（detail.budget・error.budget）に呼び出しの記録がある）。AI を呼んだ後なら確保を解放しない（費用の記録で精算する）
     */
    const gatewayBudgetAfterAi = (e) => { const d = gatewayDetailOf(e); const b = gatewayBudgetRawOf(e); return !!((d && typeof d.stage === 'string' && d.stage !== 'first') || (b && Array.isArray(b.calls) && b.calls.length > 0)); };
    function preAiOf(e) {
      if (!e || typeof e !== 'object') return false;
      const code = typeof e.code === 'string' ? e.code : '';
      //   2026-10-15（ページ期限切れへの対応）: Access Token の取得・更新で止まった（KTAiClient の request が付ける tokenStage）。要求は Gateway へ送っていないので、
      //   有料の呼び出しを 1 回実行した扱いにしない（確保を解放する）。ページの有効期限（PAGE_EXPIRED）での接続の更新の失敗もここに入る
      if (e.tokenStage === true) return true;
      if (e.details && Array.isArray(e.details.errors)) return false;
      if (code === ERROR_CODES.BUDGET_EXCEEDED && gatewayBudgetAfterAi(e)) return false;
      if (PRE_AI_CODES.has(code)) return true;
      if (code === 'RATE_LIMITED') { const d = e.details && e.details.error ? e.details.error.detail : null; return !!(d && typeof d === 'object'); }
      return false;
    }
    /** 検証の上限で送らなかった（Toolkit が止めた・Gateway が最初の呼び出しの前に止めた）。Gateway が AI を呼んだ後に止めたものは送った要求 */
    const notSentOf = (e) => !!(e && typeof e === 'object' && e.code === ERROR_CODES.BUDGET_EXCEEDED && !gatewayBudgetAfterAi(e));
    /**
     * 再検証前の確認（並行の要求・2026-10-10）: Gateway が最初の呼び出しの前に、渡した allowanceUsd を上界が超えるので止めた（BUDGET_EXCEEDED・stage first・AI を呼んでいない）か。
     *   渡した額を増やせば通りうるもの（理由が over-allowance か無い）だけ。表に無いモデル・上界を計算できない（unknown-model / unknown-bound）・Toolkit が止めたものは false
     */
    const gatewayFirstOverOf = (e) => {
      if (!e || typeof e !== 'object' || e.code !== ERROR_CODES.BUDGET_EXCEEDED || gatewayBudgetAfterAi(e)) return false;
      const d = gatewayDetailOf(e);
      return !!(d && d.stage === 'first' && (d.reason == null || d.reason === 'over-allowance'));
    };
    /**
     * 2026-10-10（再検証前の指示 §4）: Gateway の費用の記録 meta.budget（エラーの本文では error.detail.budget）= { allowanceUsd, spentUsd, complete, calls: [{ kind, boundUsd, costUsd|null }] }。
     *   形が正しいときだけ返す（無ければ null）。金額は有限・0 以上
     */
    function budgetMetaOf(m) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
      const fin = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
      if (!fin(m.spentUsd) || !Array.isArray(m.calls) || typeof m.complete !== 'boolean') return null;
      const calls = m.calls.filter(c => c && typeof c === 'object').slice(0, 20).map(c => ({ kind: typeof c.kind === 'string' ? c.kind.slice(0, 40) : null, boundUsd: fin(c.boundUsd) ? c.boundUsd : null, costUsd: fin(c.costUsd) ? c.costUsd : null, ...(typeof c.model === 'string' ? { model: c.model.slice(0, 60) } : {}), ...serviceTierAuditOf(c), ...(typeof c.costReason === 'string' ? { costReason: c.costReason.slice(0, 80) } : {}), ...(c.usage ? { usage: tokensOfUsage(c.usage) } : {}), ...(KTReleaseUsageDiagnostics.sanitize(c.usageDiagnostics) ? { usageDiagnostics: KTReleaseUsageDiagnostics.sanitize(c.usageDiagnostics) } : {}) }));
      return { allowanceUsd: fin(m.allowanceUsd) ? m.allowanceUsd : null, spentUsd: m.spentUsd, complete: m.complete === true && calls.every(c => c.costUsd != null), calls };
    }
    /**
     * 2026-10-10（再検証前の指示 §4）: この要求の費用の上限を Gateway が強制できるか。health の limits.budgetAllowance（version 1）があり、その feature のモデル（limits.features の model、
     *   無ければ表の既定）が印の models にあるときだけ 'gateway'（envelope に budget: { allowanceUsd } を付ける）。それ以外は 'estimate'（Toolkit の推定による送信制限だけ。上限の強制は無い）
     */
    function enforcementOf(limits, kind, ctx = null) {
      const ba = limits && limits.budgetAllowance && typeof limits.budgetAllowance === 'object' ? limits.budgetAllowance : null;
      if (!ba || ba.version !== 1 || !Array.isArray(ba.models)) return 'estimate';
      const feature = typeof kind === 'string' && own(FEATURE_OF, kind) ? FEATURE_OF[kind] : null;
      if (!feature) return 'estimate';
      const lf = limits.features && limits.features[feature] && typeof limits.features[feature] === 'object' ? limits.features[feature] : null;
      const model = requestModelOf(feature, lf, ctx);
      const base = (m) => { const d = /^(.+)-\d{4}-\d{2}-\d{2}$/.exec(String(m || '')); return d ? d[1] : String(m || ''); };
      return ba.models.some(m => m === model || base(m) === base(model)) ? 'gateway' : 'estimate';
    }
    /** Provider/Gatewayの使用量。欠けたキャッシュ内訳は0ではなくnull。 */
    function tokensOfUsage(u) {
      if (!u || typeof u !== 'object') return null;
      const count = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
      const pick = (o, keys) => { for (const key of keys) if (own(o, key)) return o[key]; };
      const input = count(pick(u, ['input_tokens', 'prompt_tokens', 'inputTokens']));
      const output = count(pick(u, ['output_tokens', 'completion_tokens', 'outputTokens']));
      if (input == null || output == null) return null;
      const d = u.input_tokens_details || u.prompt_tokens_details || {}, wd = d.cache_write_tokens_details || {};
      const cached = count(own(d, 'cached_tokens') ? d.cached_tokens : pick(u, ['cache_read_input_tokens', 'cachedTokens']));
      const cacheWrite = count(own(d, 'cache_write_tokens') ? d.cache_write_tokens : u.cacheWriteTokens);
      const ttlCount = (key, alias) => own(wd, key) ? count(wd[key]) : own(u, alias) ? count(u[alias]) : cacheWrite === 0 ? 0 : null;
      const cacheWrite30m = ttlCount('ttl_30m_tokens', 'cacheWriteTokens30m');
      const cacheWrite12h = ttlCount('ttl_12h_tokens', 'cacheWriteTokens12h');
      const od = u.output_tokens_details || u.completion_tokens_details || {};
      const reasoning = count(own(od, 'reasoning_tokens') ? od.reasoning_tokens : u.reasoningTokens);
      return { input, cached, output, cacheWrite, cacheWrite30m, cacheWrite12h, reasoning };
    }
    /**
     * 応答 → 1 回の要求の中の AI の呼び出しごとの token（分からない呼び出しは null）。生成は meta.timing の calls（呼び出しごと。無ければ最初の生成と最後の修復と修復の回数）、
     *   計画は差分から全体に切り替えたとき差分の試み（patchAttempt）と全体の 2 回、ほかは 1 回
     */
    function callsOf(kind, r) {
      if (!r || typeof r !== 'object') return [null];
      const first = tokensOfUsage(r.ai && r.ai.usage);
      if (kind === 'generate') {
        const tm = r.timing && typeof r.timing === 'object' ? r.timing : null;
        const declared = tm && tm.ai ? num(tm.ai.count) : null;
        const tc = tm && Array.isArray(tm.calls) ? tm.calls.filter(c => c && typeof c === 'object') : [];
        let out;
        if (tc.length) {
          out = tc.map(c => tokensOfUsage(c));
        } else {
          const nRep = num(r.verification && r.verification.repairs && r.verification.repairs.count) || 0;
          out = [first];
          if (nRep > 0) { for (let i = 1; i < nRep; i++) out.push(null); out.push(tokensOfUsage(r.aiRepair && r.aiRepair.usage)); }
        }
        while (declared != null && out.length < declared) out.push(null);
        return out;
      }
      if (kind === 'plan') {
        const rm = r.revisionMeta && typeof r.revisionMeta === 'object' ? r.revisionMeta : null;
        if (rm && rm.patchAttempt && typeof rm.patchAttempt === 'object') return [tokensOfUsage(rm.patchAttempt.usage), first];
      }
      return [first];
    }
    const serviceTierAuditOf = (meta) => {
      const audit = Object.fromEntries(['requestedServiceTier', 'serviceTier'].filter(key => meta && own(meta, key)).map(key => [key, typeof meta[key] === 'string' ? meta[key].slice(0, 40) : null]));
      const requested = meta?.settings?.requestedServiceTier;
      if (audit.requestedServiceTier == null && requested != null) audit.requestedServiceTier = typeof requested === 'string' ? requested.slice(0, 40) : null;
      return audit;
    };
    /** ローカル精算の呼び出しごとのtier。最後の修復のtierを前の呼び出しに流用しない。 */
    function callTierMetadataOf(kind, r, count) {
      let source = [r?.ai];
      if (kind === 'generate') {
        const tc = Array.isArray(r?.timing?.calls) ? r.timing.calls.filter(c => c && typeof c === 'object') : [];
        if (tc.length) source = tc;
        else if (count > 1) source = [r?.ai, ...Array(Math.max(0, count - 2)).fill(null), r?.aiRepair];
      } else if (kind === 'plan' && r?.revisionMeta?.patchAttempt) source = [r.revisionMeta.patchAttempt, r?.ai];
      return Array.from({ length: count }, (_, i) => serviceTierAuditOf(source[i]));
    }
    const configKeyOf = (host) => `${CONFIG_PREFIX}.${host}`;
    const ledgerKeyOf = (host, id) => `${LEDGER_PREFIX}.${host}.${id}`;
    /** 再検証前の指示 §3（2026-10-10）: このページ（タブ）で検証の上限が一度有効だった印の sessionStorage のキー（値は設定の id と作った日時だけ） */
    const ARMED_PREFIX = 'ktAi.budgetArmed.v1';
    const armedKeyOf = (host) => `${ARMED_PREFIX}.${host}`;
    function parseConfig(raw) {
      let j = null; try { j = JSON.parse(raw); } catch (e) { return null; }
      if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
      const id = typeof j.id === 'string' ? j.id.trim() : '';
      const limitUsd = num(j.limitUsd), maxCalls = num(j.maxCalls);
      const createdAt = typeof j.createdAt === 'string' ? j.createdAt.trim() : '';
      if (!/^[A-Za-z0-9._:-]{1,64}$/.test(id) || limitUsd == null || limitUsd < 0 || maxCalls == null || maxCalls < 0 || !Number.isInteger(maxCalls) || !createdAt || createdAt.length > 64) return null;
      return { id, limitUsd, maxCalls, createdAt };
    }
    //   レビューの指摘 row7（2026-10-09）: 費用が確定していない記録（進行中・終了不明・一部不明）は costUsd が null・costComplete false・costKnownUsd = 確認できた分。
    //   前の形の記録（costUsd が数・costKnownUsd が無い）も読む
    const validEntry = (e) => !!e && typeof e === 'object' && typeof e.key === 'string' && STATUSES.includes(e.status) && num(e.reservedUsd) != null && e.reservedUsd >= 0 && num(e.reservedCalls) != null && e.reservedCalls >= 0
      && ((num(e.costUsd) != null && e.costUsd >= 0) || (e.costUsd === null && e.costComplete === false)) && (e.costKnownUsd === undefined || (num(e.costKnownUsd) != null && e.costKnownUsd >= 0)) && Array.isArray(e.calls);
    /** 記録の確認できた費用（費用が確定していない記録は確認できた分だけ。前の形の記録は costUsd） */
    const knownCostOf = (e) => (e ? (num(e.costKnownUsd) ?? num(e.costUsd) ?? 0) : 0);
    function parseLedger(raw, config) {
      let j = null; try { j = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'ledger-broken' }; }
      if (!j || typeof j !== 'object' || j.version !== LEDGER_VERSION || !Array.isArray(j.entries)) return { ok: false, reason: 'ledger-broken' };
      if (j.id !== config.id || j.configCreatedAt !== config.createdAt) return { ok: false, reason: 'ledger-mismatch' };
      if (!j.entries.every(validEntry)) return { ok: false, reason: 'ledger-broken' };
      return { ok: true, ledger: { version: LEDGER_VERSION, id: j.id, configCreatedAt: j.configCreatedAt, entries: j.entries, stopped: j.stopped && typeof j.stopped === 'object' ? j.stopped : null } };
    }
    /** 記録の合計。unknown は費用未確定の総数。costUnknown は成功応答受領済み、completionUnknown は終了未確認（旧記録を含む）。金額・回数の制限は従来どおり。 */
    function totalsOf(ledger, { sessionId = null } = {}) {
      let recordedUsd = 0, reservedUsd = 0, usedCalls = 0, unknown = 0, costUnknown = 0, completionUnknown = 0, inFlight = 0, done = 0;
      for (const e of (ledger && Array.isArray(ledger.entries) ? ledger.entries : [])) {
        if (!e || e.status === 'released') continue;
        recordedUsd += knownCostOf(e);
        reservedUsd += e.reservedUsd || 0;
        //   再検証前の指示 §4: Gateway の費用の記録（gatewayCalls）がある要求は、その呼び出しの数も数える（token の記録の数より多ければそちら）
        usedCalls += e.status === 'done' || e.status === 'partial-unknown' ? Math.max(e.calls.length, Array.isArray(e.gatewayCalls) ? e.gatewayCalls.length : 0) : (e.reservedCalls || 0);
        if (e.status === 'unknown' || e.status === 'partial-unknown' || (e.status === 'in-flight' && e.sessionId !== sessionId)) {
          unknown += 1;
          // 応答の受領と費用の確定は別。旧記録や切断から成功を推測しない。
          if (e.responseState === 'succeeded' && e.status !== 'in-flight') costUnknown += 1;
          else completionUnknown += 1;
        }
        else if (e.status === 'in-flight') inFlight += 1;
        else if (e.status === 'done') done += 1;
      }
      return { recordedUsd: round6(recordedUsd), reservedUsd: round6(reservedUsd), usedCalls, unknown, costUnknown, completionUnknown, inFlight, done };
    }
    const nowIso = (nowFn) => { try { return new Date(nowFn()).toISOString(); } catch (e) { return null; } };
    const newSessionId = () => `p-${(typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)}`;
    const codeOf = (e) => { const c = e && typeof e.code === 'string' ? e.code : e && e.name === 'AbortError' ? 'CANCELLED' : 'ERROR'; return /^[A-Z][A-Z0-9_]{0,39}$/.test(c) ? c : 'ERROR'; };
    /**
     * @param {object} p storage（localStorage 互換。既定は localStorage）/ host（既定 location.host）/ locks（Web Locks。既定 navigator.locks。無ければこのタブの中だけ）/
     *   now（ms）/ sessionId（このページの印。読み込み直しで進行中のまま残った記録を見分ける）/
     *   session（sessionStorage 互換。既定は sessionStorage。このページ（タブ）で検証の上限が一度有効だった印を持つ。本文・金額は入れない）
     */
    function create({ storage = undefined, session = undefined, host = undefined, locks = undefined, now = () => Date.now(), sessionId = null } = {}) {
      //   再検証前の指示 §3（2026-10-10）: 保存領域そのものを取れない（localStorage の参照が例外）は「設定を読めない」（予算を使わない通常の利用と見なさない）
      let storageThrew = false;
      const st0 = storage !== undefined ? storage : (() => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { storageThrew = true; return null; } })();
      const ss0 = session !== undefined ? session : (() => { try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch (e) { return null; } })();
      const h = host !== undefined ? String(host || '') : (typeof location !== 'undefined' ? String(location.host || '') : '');
      const lockApi = locks !== undefined ? locks : ((typeof navigator !== 'undefined' && navigator && navigator.locks && typeof navigator.locks.request === 'function') ? navigator.locks : null);
      const sid = sessionId || newSessionId();
      const configKey = configKeyOf(h);
      const armedKey = armedKeyOf(h);
      const LOCK_NAME = `ktAi.budget:${h}`;
      let seq = 0, configurationFailure = null;
      const listeners = new Set();
      const notify = () => { for (const fn of [...listeners]) { try { fn(); } catch (e) { } } };
      const withLock = (fn) => (lockApi ? Promise.resolve(lockApi.request(LOCK_NAME, { mode: 'exclusive' }, async () => fn())) : Promise.resolve().then(fn));
      //   再検証前の指示 §3: このページで検証の上限が一度有効だった印（このページのメモリと sessionStorage。中身は設定の id と作った日時だけ）。
      //   sessionStorage を読めない・書けないときはメモリだけ（読み込み直しでは消える）
      let armedMem = null;
      const armedOf = () => {
        if (armedMem) return armedMem;
        try { const raw = ss0 ? ss0.getItem(armedKey) : null; const j = raw ? JSON.parse(raw) : null; if (j && typeof j === 'object' && typeof j.id === 'string') return { id: j.id, createdAt: typeof j.createdAt === 'string' ? j.createdAt : '' }; } catch (e) { }
        return null;
      };
      const arm = (config) => {
        if (armedMem && armedMem.id === config.id && armedMem.createdAt === config.createdAt) return;
        armedMem = { id: config.id, createdAt: config.createdAt };
        try { if (ss0) ss0.setItem(armedKey, JSON.stringify(armedMem)); } catch (e) { }
      };
      /**
       * 設定と記録 → { mode: disabled | broken | on }。
       *   disabled = 予算を使わない通常の利用（設定のキーが無く、読取に成功し、このページで一度も有効になっていない。今と同じ）。
       *   broken = 送らない: 設定の形が正しくない・記録を読めない／壊れている・設定と合わない、と、再検証前の指示 §3（2026-10-10）の「予算を使う検証で状態を確かめられない」
       *   （設定の読取の例外 config-unreadable・このページで一度有効だった設定が消えた config-missing）。設定の読取の例外で上限なしの送信に戻さない
       */
      function storedState() {
        if (!st0) return storageThrew || armedOf() ? { mode: 'broken', reason: 'config-unreadable' } : { mode: 'disabled' };
        let raw = null;
        try { raw = st0.getItem(configKey); } catch (e) { return { mode: 'broken', reason: 'config-unreadable' }; }
        if (raw == null) return armedOf() ? { mode: 'broken', reason: 'config-missing' } : { mode: 'disabled' };
        const config = parseConfig(raw);
        if (!config) return { mode: 'broken', reason: 'config-invalid' };
        arm(config);
        let lraw = null;
        try { lraw = st0.getItem(ledgerKeyOf(h, config.id)); } catch (e) { return { mode: 'broken', reason: 'ledger-unreadable', config }; }
        if (lraw == null) return { mode: 'on', config, ledger: { version: LEDGER_VERSION, id: config.id, configCreatedAt: config.createdAt, entries: [], stopped: null } };
        const pl = parseLedger(lraw, config);
        return pl.ok ? { mode: 'on', config, ledger: pl.ledger } : { mode: 'broken', reason: pl.reason, config };
      }
      const readState = () => configurationFailure ? { mode: 'broken', reason: configurationFailure } : storedState();
      const writeLedger = (config, ledger) => {
        try { st0.setItem(ledgerKeyOf(h, config.id), JSON.stringify(ledger)); } catch (e) { throw budgetError('ledger-write'); }
      };
      /** 新規の検証枠を設定する。旧記録を消さず、進行中の要求がある間は切り替えない。 */
      const configure = ({ limitUsd, maxCalls } = {}, mayConfigure = () => true) => withLock(() => {
        if (!mayConfigure()) throw budgetError('conversation-active');
        const id = `b-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${now().toString(36)}-${Math.random().toString(36).slice(2)}-${++seq}`}`;
        const config = parseConfig(JSON.stringify({ id, limitUsd, maxCalls, createdAt: nowIso(now) }));
        if (!config) throw budgetError('config-invalid');
        const previous = storedState();
        if (previous.mode === 'on' && previous.ledger.entries.some(e => e.status === 'in-flight')) throw budgetError('in-flight');
        try {
          if (!st0 || previous.mode === 'broken') throw budgetError(previous.reason || 'config-unreadable');
          const key = ledgerKeyOf(h, config.id);
          if (config.id === previous.config?.id || st0.getItem(key) != null) throw budgetError('config-write');
          const ledger = { version: LEDGER_VERSION, id: config.id, configCreatedAt: config.createdAt, entries: [], stopped: null };
          writeLedger(config, ledger);
          if (st0.getItem(key) !== JSON.stringify(ledger)) throw budgetError('ledger-write');
          st0.setItem(configKey, JSON.stringify(config));
          const saved = storedState();
          if (saved.mode !== 'on' || JSON.stringify(saved.config) !== JSON.stringify(config)) throw budgetError(saved.reason || 'config-write');
          configurationFailure = null;
          notify();
          return summary();
        } catch (e) {
          configurationFailure = e?.details?.budget?.reason || 'config-write';
          notify();
          throw budgetError(configurationFailure);
        }
      });
      /**
       * 送信の直前の確保（記録に in-flight を書く）。超えるなら BUDGET_EXCEEDED を投げる。無効なら null。
       *   enforcement 'estimate'（印の無い Gateway）: 確保額 = Toolkit の推定の最大費用（推定。provider に送る入力をこの値以下に制限してはいない＝上限の強制は無い）。
       *   enforcement 'gateway'（再検証前の指示 §4。health の limits.budgetAllowance）: 残り = 上限 − 記録済みの費用（不明は確保額で数える）− ほかの進行中・終了不明の確保額。
       *   再検証前の確認（並行の要求・2026-10-10）: allowanceUsd = min(残り, capUsd（この要求の上界の見積もり gatewayBound。無ければ残り）) を Gateway に渡し
       *   （Gateway が provider に送る要求の上界で呼び出しの前に確かめ、超える呼び出しをしない）、この要求の確保額 = allowanceUsd（残り全額を 1 つの要求で確保しない）。残りが 0 なら送らない。
       *   aboveUsd（送り直し）: 残り（capUsd は使わない）が aboveUsd より大きいときだけ確保し、そうでなければ { skipped: true }（記録を書かない）
       */
      const reserve = ({ requestId = null, kind, est, enforcement = 'estimate', capUsd = null, aboveUsd = null }) => withLock(() => {
        const s = readState();
        if (s.mode === 'disabled') return null;
        //   状態を確かめられない（再検証前の指示 §3 の設定の消失・読取の例外を含む）→ 送らない。見出しの行も描き直す（設定の消失は記録を書かないので知らせる）
        if (s.mode === 'broken') { notify(); throw budgetError(s.reason); }
        const { config, ledger } = s;
        if (ledger.stopped) throw budgetError('stopped', { stopReason: ledger.stopped.reason || null });
        //   読み込み直し（このページの外）で進行中のまま残った記録は、終了不明として数える（確保は解放しない）
        let relabeled = 0;
        for (const e of ledger.entries) if (e.status === 'in-flight' && e.sessionId !== sid) { e.status = 'unknown'; e.reason = 'NOT_SETTLED'; relabeled += 1; }
        if (relabeled) { writeLedger(config, ledger); notify(); }
        const t = totalsOf(ledger, { sessionId: sid });
        const remainingUsd = round6(config.limitUsd - t.recordedUsd - t.reservedUsd);
        const remainingCalls = config.maxCalls - t.usedCalls;
        const gw = enforcement === 'gateway';
        const info = { kind, mode: gw ? 'gateway' : 'estimate', ...(gw ? {} : { needUsd: est.maxUsd }), remainingUsd, needCalls: est.maxCalls, remainingCalls, limitUsd: config.limitUsd, maxCalls: config.maxCalls };
        if (gw ? !(remainingUsd > 1e-6) : est.maxUsd > remainingUsd + 1e-9) throw budgetError('limit', info);
        if (est.maxCalls > remainingCalls) throw budgetError('calls', info);
        const floor6 = (x) => Math.floor(Math.round(Number(x) * 1e9) / 1e3) / 1e6;
        const cap = gw && aboveUsd == null && num(capUsd) != null && capUsd > 0 ? num(capUsd) : null;
        const allowanceUsd = gw ? floor6(cap != null ? Math.min(remainingUsd, cap) : remainingUsd) : null;
        if (gw && aboveUsd != null && !(allowanceUsd > num(aboveUsd) + 1e-6)) return { skipped: true, remainingUsd };
        const key = `${sid}:${++seq}`;
        ledger.entries.push({ key, requestId: typeof requestId === 'string' ? requestId.slice(0, 80) : null, feature: est.feature, kind, mode: est.mode, enforcement: gw ? 'gateway' : 'estimate', ...(gw ? { allowanceUsd } : {}), sessionId: sid, startedAt: nowIso(now), endedAt: null, status: 'in-flight', reservedUsd: gw ? allowanceUsd : est.maxUsd, reservedCalls: est.maxCalls, maxCallUsd: est.maxCallUsd, estimatedModel: est.model, estimatedServiceTier: est.serviceTier ?? null, maxOutputTokens: est.maxOutputTokens, ctxBytes: est.ctxBytes, model: null, calls: [], costUsd: null, costKnownUsd: 0, costComplete: false, costCachedUsd: null, reason: null });
        writeLedger(config, ledger);
        notify();
        return { key, enforcement: gw ? 'gateway' : 'estimate', ...(gw ? { allowanceUsd } : {}) };
      });
      /**
       * 再検証前の指示 §4: Gateway の費用の記録（meta.budget・エラーの detail.budget）で精算する。complete なら done（費用 = spentUsd・確保 0）。
       *   そうでなければ確認できた費用（costUsd のある呼び出し）を記録し、費用が分からない呼び出しはその呼び出しの上界（boundUsd）を確保に残す（呼び出しの記録どおり）。
       *   spentUsd が渡した allowanceUsd を超えていたら（取り決めと合わない）以後を止める
       */
      const settleByMeta = (e, ledger, bm, kind) => {
        const maxCalls0 = e.reservedCalls;
        const known = bm.calls.filter(c => c.costUsd != null);
        //   費用が分からない呼び出しの上界（boundUsd が無ければ渡した allowanceUsd）
        const unknownBound = round6(bm.calls.filter(c => c.costUsd == null).reduce((s2, c) => s2 + (c.boundUsd != null ? c.boundUsd : (e.allowanceUsd || 0)), 0));
        e.gatewayCalls = bm.calls.map(c => ({ ...c }));
        if (bm.calls.some(c => own(c, 'usage'))) e.calls = bm.calls.map(c => c.usage || null);
        e.costKnownUsd = bm.complete ? round6(bm.spentUsd) : round6(known.reduce((s2, c) => s2 + c.costUsd, 0));
        e.status = bm.complete ? 'done' : known.length ? 'partial-unknown' : 'unknown';
        e.costComplete = e.status === 'done'; e.costUsd = e.costComplete ? e.costKnownUsd : null;
        if (e.status === 'done') { e.reservedUsd = 0; e.reservedCalls = bm.calls.length; }
        else if (bm.calls.length) { e.reservedUsd = round6(e.allowanceUsd != null ? Math.min(e.allowanceUsd, unknownBound) : unknownBound); e.reservedCalls = bm.calls.length; }
        //   呼び出しの記録が無い不完全な記録は、確保（渡した allowanceUsd）を残す（0 にしない）
        let stop = null;
        if (e.allowanceUsd != null && bm.spentUsd > e.allowanceUsd + 1e-6) stop = { reason: 'over-allowance' };
        else if (bm.calls.length > maxCalls0) stop = { reason: 'calls', calls: bm.calls.length };
        if (stop && !ledger.stopped) ledger.stopped = { ...stop, at: nowIso(now), kind };
      };
      /** 記録の 1 件を書き換える（記録を読めなければ何もしない。確保は残ったまま = 保守的） */
      const update = (key, fn) => withLock(() => {
        const s = readState();
        if (s.mode !== 'on') return null;
        const e = s.ledger.entries.find(x => x.key === key);
        if (!e) return null;
        fn(e, s.ledger);
        writeLedger(s.config, s.ledger);
        notify();
        return { ...e };
      });
      /**
       * 応答で精算: 呼び出しごとの token がそろえば done（確保を解放）、一部が無ければ partial-unknown（無い分の確保を残す）、無ければ unknown（確保を残す）。
       *   応答のモデルが単価の表に無い・表より高い、出力の上限が見積もりより大きい、呼び出しが見積もりの最大より多いときは、以後の送信を止める（stopped）
       */
      //   再検証前の指示 §4: 上限を Gateway に渡した要求（enforcement gateway）は Gateway の費用の記録（meta.budget）で精算する（出力の上限は Gateway の上界に含まれる）。
      //   記録が無ければ取り決めと合わないので以後を止め、今までの token の精算をする（確保は渡した allowanceUsd のまま残りうる＝保守的）
      const settle = (key, { kind, response }) => update(key, (e, ledger) => {
        e.responseState = 'succeeded'; // 成功応答を受領した事実だけを保存。費用不明分の確保は維持する。
        const calls = callsOf(kind, response);
        const ai = response && response.ai && typeof response.ai === 'object' ? response.ai : null;
        const model = ai && typeof ai.model === 'string' && ai.model.trim() ? ai.model.trim().slice(0, 60) : null;
        const est = priceOf(e.estimatedModel);
        const got = model ? priceOf(model) : est;
        const gw = e.enforcement === 'gateway';
        const bm = gw ? budgetMetaOf(response && response.budgetMeta) : null;
        Object.assign(e, serviceTierAuditOf(ai));
        if (gw && bm) {
          e.endedAt = nowIso(now); e.model = model;
          e.calls = calls.map(c => c ? { ...c } : null);
          e.costCachedUsd = null; // 旧い読取割引だけの参考値を作らず、書込を含むGatewayの合計を使う。
          settleByMeta(e, ledger, bm, kind);
          e.reason = null;
          if (model && (!got || (est && (got.input > est.input || got.output > est.output))) && !ledger.stopped) ledger.stopped = { reason: 'model', model, at: nowIso(now), kind };
          return;
        }
        let stop = null;
        if (gw) stop = { reason: 'no-budget-meta' };
        if (!stop && model && (!got || (est && (got.input > est.input || got.output > est.output)))) stop = { reason: 'model', model };
        const mo = ai && ai.settings ? num(ai.settings.maxOutputTokens) : null;
        if (!stop && !gw && mo != null && mo > e.maxOutputTokens) stop = { reason: 'output-limit', maxOutputTokens: mo };
        if (!stop && calls.length > e.reservedCalls) stop = { reason: 'calls', calls: calls.length };
        const tierMetadata = callTierMetadataOf(kind, response, calls.length);
        const estimatedPrice = tierPriceOf(e.estimatedModel, e.estimatedServiceTier);
        const prices = tierMetadata.map(meta => {
          const explicitTier = e.estimatedServiceTier != null || meta.requestedServiceTier != null;
          if (explicitTier && meta.serviceTier == null) return null;
          return tierPriceOf(model || e.estimatedModel, meta.serviceTier);
        });
        if (!stop && tierMetadata.some((meta, i) => meta.serviceTier != null && (!prices[i] || (estimatedPrice && (prices[i].input > estimatedPrice.input || prices[i].output > estimatedPrice.output))))) stop = { reason: 'service-tier' };
        const priced = !(stop && ['model', 'service-tier'].includes(stop.reason));
        e.endedAt = nowIso(now); e.model = model;
        e.calls = calls.map(c => c ? { ...c } : null);
        e.callServiceTiers = tierMetadata;
        //   レビューの指摘 row7: 確認できた費用（costKnownUsd）と、費用が確定したか（costComplete）。確定していない記録の costUsd は null（0 と読ませない）
        const costs = calls.map((c, i) => priced ? usageCostUsd(prices[i], c) : null);
        const knownCosts = costs.filter(c => c != null);
        const knownUsd = round6(knownCosts.reduce((sum, cost) => sum + cost, 0));
        e.costCachedUsd = null;
        const nullN = calls.length - knownCosts.length;
        e.status = !priced || !knownCosts.length ? 'unknown' : nullN ? 'partial-unknown' : 'done';
        e.costKnownUsd = knownUsd; e.costComplete = e.status === 'done'; e.costUsd = e.costComplete ? knownUsd : null;
        if (e.status === 'done') { e.reservedUsd = 0; e.reservedCalls = calls.length; }
        else if (e.status === 'partial-unknown') { e.reservedUsd = round6(Math.min(e.reservedUsd, nullN * (e.maxCallUsd || 0))); e.reservedCalls = calls.length; }
        e.reason = knownCosts.length ? null : prices.some(p => !p) ? 'INCOMPLETE_SERVICE_TIER' : 'INCOMPLETE_USAGE';
        if (stop && !ledger.stopped) ledger.stopped = { ...stop, at: nowIso(now), kind };
      });
      /** 失敗で精算: AI を呼ぶ前に止まったものだけ解放し、それ以外（中断・時間切れ・切断・AI を呼んだ後のエラー）は終了不明（確保を残す） */
      //   再検証前の指示 §4: Gateway が最初の呼び出しの前に上限で止めた（BUDGET_EXCEEDED stage first）は AI を呼んでいないので解放。上限を渡した要求で、AI を呼んだ後の
      //   エラーの本文に Gateway の費用の記録（error.detail.budget）があれば、それで精算する（無ければ今までどおり終了不明・確保を残す）
      //   再検証前の確認（時間切れの記録・2026-10-10）: 費用の記録は error.detail.budget と、detail が文字列の応答（502 UPSTREAM_ERROR detail "timeout"）の error.budget の両方を読み、
      //   記録された上界で精算する（確保を渡した allowanceUsd の全額のまま残さない。使用量の分からない呼び出しはその上界を確保に残す）
      const fail = (key, err) => update(key, (e, ledger) => {
        e.endedAt = nowIso(now); e.reason = codeOf(err);
        if (preAiOf(err)) { e.status = 'released'; e.reservedUsd = 0; e.reservedCalls = 0; e.costUsd = 0; e.costKnownUsd = 0; e.costComplete = true; return; }
        const bm = e.enforcement === 'gateway' ? budgetMetaOf(gatewayBudgetRawOf(err)) : null;
        if (bm) { settleByMeta(e, ledger, bm, e.kind); e.reason = codeOf(err); return; }
        e.status = 'unknown'; e.costUsd = null; e.costKnownUsd = num(e.costKnownUsd) ?? 0; e.costComplete = false;
      });
      /** 送る前に止めた（確保の直後に取り消された）: 解放 */
      const release = (key, code = 'CANCELLED') => update(key, (e) => { e.endedAt = nowIso(now); e.reason = code; e.status = 'released'; e.reservedUsd = 0; e.reservedCalls = 0; e.costUsd = 0; e.costKnownUsd = 0; e.costComplete = true; });
      //   再検証前の指示 §4: 最後に包んだ client の health の limits（見出しの行で、Gateway が上限を強制するか・推定による送信制限だけかを分けて出す）
      let lastLimits = null;
      function summary() {
        const s = readState();
        if (s.mode === 'disabled') return { enabled: false };
        if (s.mode === 'broken') return { enabled: true, ok: false, reason: s.reason };
        const t = totalsOf(s.ledger, { sessionId: sid });
        const L = lastLimits ? lastLimits() : null;
        const modes = [...new Set(['ask', 'plan', 'generate'].map(k => enforcementOf(L, k)))];
        return { enabled: true, ok: true, id: s.config.id, limitUsd: s.config.limitUsd, maxCalls: s.config.maxCalls, ...t, stopped: s.ledger.stopped ? { ...s.ledger.stopped } : null, enforcement: modes.length === 1 ? modes[0] : 'mixed' };
      }
      /**
       * session.client を包む（ask / propose / plan / generate の直前に確保、応答で精算）。設定が無ければ素通し（今と同じ）。
       *   limits = health の limits（関数でもよい）。有効なときは直接の送信の失敗から kintone.proxy で送り直さない（noProxyFallback）。
       *   再検証前の指示 §3: 各送信の前に設定を読み直す（予算を使う検証で状態を確かめられなければ送信 0 件。readState）。
       *   再検証前の指示 §4: health に limits.budgetAllowance があり、その feature のモデルが印にあれば、envelope に budget: { allowanceUsd } を付ける（確保額 = allowanceUsd）
       */
      function wrap(client, { limits = null } = {}) {
        if (!client || typeof client !== 'object') return client;
        const lim = () => { try { return typeof limits === 'function' ? limits() : limits; } catch (e) { return null; } };
        lastLimits = lim;
        //   再検証前の確認（並行の要求・2026-10-10）: 印のある Gateway には allowanceUsd = min(残り, この要求の上界の見積もり gatewayBound) を渡す（作業中の質問と計画の更新が
        //   並ぶ発言で、先の要求が残りを全部確保して後の要求が残り 0 で止まらない。並ぶ要求の allowance の合計は残りを超えない）。Gateway が最初の呼び出しの前に上界で止めたら
        //   （gatewayFirstOverOf。AI を呼んでいない）確保を解放し、残りがその allowance より大きければ allowanceUsd = 残り で 1 回だけ送り直す（それでも超えれば止める）
        const run = (kind) => async (p = {}) => {
          if (readState().mode === 'disabled') return client[kind](p);
          const requestId = p && p.requestId ? p.requestId : KTAiClient.newRequestId();
          const L = lim();
          const est = estimate({ kind, ctx: p ? p.ctx : null, limits: L });
          if (!est.ok) throw budgetError(est.reason, { kind, ...(est.model ? { model: est.model } : {}) });
          const enforcement = enforcementOf(L, kind, p?.ctx);
          const gb = enforcement === 'gateway' ? gatewayBound({ kind, ctx: p ? p.ctx : null, limits: L }) : null;
          const analysis = typeof KTAnalysisInput !== 'undefined' && KTAnalysisInput.analysis(p?.ctx);
          // Analysis is one call. Let the server check its actual compact prompt
          // against the remaining allowance, not a client approximation cap.
          let res = await reserve({ requestId, kind, est, enforcement, capUsd: !analysis && gb && gb.ok ? gb.maxUsd : null });
          if (!res) return client[kind](p);
          for (let resent = false; ; resent = true) {
            if (p && p.signal && p.signal.aborted) { try { await release(res.key, 'CANCELLED'); } catch (x) { } throw new AiClientError({ code: ERROR_CODES.CANCELLED, message: '送信をキャンセルしました' }); }
            let r;
            try { r = await client[kind]({ ...p, requestId, onRecoveryPrepared: record => p?.onRecoveryPrepared?.({...record,budgetKey:res.key}), noProxyFallback: true, ...(res.enforcement === 'gateway' ? { budget: { allowanceUsd: res.allowanceUsd } } : {}) }); }
            catch (e) {
              try { await fail(res.key, e); } catch (x) { }
              if(e.recovery)e.recovery.budgetKey=res.key;
              if (!analysis && !resent && res.enforcement === 'gateway' && gatewayFirstOverOf(e)) {
                let again = null;
                try { again = await reserve({ requestId, kind, est, enforcement, aboveUsd: res.allowanceUsd }); } catch (x) { again = null; }
                if (again && !again.skipped && again.key) { res = again; continue; }
              }
              throw e;
            }
            try { await settle(res.key, { kind, response: r }); } catch (x) { }
            return r;
          }
        };
        return { ...client, ask: run('ask'), propose: run('propose'), plan: run('plan'), generate: run('generate') };
      }
      return {
        configKey, ledgerKey: () => { const s = readState(); return s.config ? ledgerKeyOf(h, s.config.id) : null; }, sessionId: sid,
        enabled: () => readState().mode !== 'disabled', state: () => readState().mode, readState, summary, configure,
        reserve, settle, fail, release, wrap,
        subscribe(fn) { if (typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn); },
      };
    }
    /** 見出しの 1 行（予算が有効なときだけ。金額と回数だけ。内部の値は出さない） */
    //   再検証前の指示 §4（2026-10-10）: Gateway が要求ごとに上限を強制するか（budgetAllowance の印）、Toolkit の推定による送信制限だけか（上限の強制は無い）を分けて書く
    const ENFORCEMENT_JA = Object.freeze({ gateway: '（AI サービスが要求ごとに上限を強制）', estimate: '（推定による送信制限・上限の強制は無い）', mixed: '（一部の要求は推定による送信制限・上限の強制は無い）' });
    function summaryText(s) {
      if (!s || !s.enabled) return '';
      const usd = KTAiClient.usdText;
      if (!s.ok) return s.reason === 'config-unreadable' || s.reason === 'config-missing' ? '費用の上限: 設定を確かめられないため、AI に送りません' : '費用の上限: 設定または記録を読めないため、AI に送りません';
      const mode = ENFORCEMENT_JA[s.enforcement] || '';
      const pending = [s.costUnknown ? `応答完了・費用未確定 ${s.costUnknown} 件` : '', (s.completionUnknown ?? s.unknown) ? `終了不明 ${s.completionUnknown ?? s.unknown} 件` : ''].filter(Boolean);
      const pendingText = pending.length ? `（${pending.join('・')}）` : '';
      if (s.stopped) return `費用の上限${mode}: 見積もりの表・上限の取り決めと合わない応答があったため、以後の送信を止めています（記録済み 約 ${usd(s.recordedUsd)} 米ドル・確保中 約 ${usd(s.reservedUsd)} 米ドル）${pendingText}`;
      return `費用の上限${mode}: 記録済み 約 ${usd(s.recordedUsd)} 米ドル・確保中 約 ${usd(s.reservedUsd)} 米ドル${pendingText} ／ 上限 ${usd(s.limitUsd)} 米ドル・AI の呼び出し ${s.usedCalls} / ${s.maxCalls} 回`;
    }
    return { CONFIG_PREFIX, LEDGER_PREFIX, ARMED_PREFIX, LEDGER_VERSION, PRICES, FEATURE_OF, DEFAULT_MODEL, OUTPUT_LIMITS, MAX_CALLS, PROMPT_BYTES, CTX_FACTOR, BYTES_PER_TOKEN, REPAIR_EXTRA_TOKENS, STATUSES,
      MESSAGE_OVERHEAD_BYTES, MESSAGES_PER_CALL, PREV_OUTPUT_BYTES_PER_TOKEN, RETRY_EXTRA_BYTES,
      priceOf, estimate, gatewayBound, gatewayBodyBytesOf, callsOf, tokensOfUsage, preAiOf, notSentOf, gatewayFirstOverOf, budgetMetaOf, enforcementOf, totalsOf, knownCostOf, parseConfig, budgetError, configKeyOf, ledgerKeyOf, armedKeyOf, summaryText, create };
  })();
