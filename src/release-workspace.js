/* Release workspace: explicit user actions, service outcomes, and one execution record.
 * No requirement-text interpretation or verification-case aggregation belongs here.
 */
'use strict';

const KTReleaseWorkspace = (() => {
  const consultation = () => typeof KTBusinessConsultation !== 'undefined' ? KTBusinessConsultation : require('./release-business-consultation.js').KTBusinessConsultation;
  const business = () => typeof KTBusinessContract !== 'undefined' ? KTBusinessContract : require('./release-business-contract.js').KTBusinessContract;
  const businessView = () => typeof KTBusinessView !== 'undefined' ? KTBusinessView : require('./release-business-view.js').KTBusinessView;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
  async function hash(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(stable(value));
    const bytes = new TextEncoder().encode(text);
    return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  // Counts come only from the service. Missing fields are unknown, never zero.
  const countOf = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const usageCountsOf = value => value && typeof value === 'object' ? Object.fromEntries(['limit', 'used', 'reserved', 'remaining'].map(key => [key, countOf(value[key])])) : null;
  function usageOf(value) {
    if (!value || typeof value !== 'object') return null;
    const common = { plan: typeof value.plan === 'string' ? value.plan : '', yyyymm: typeof value.yyyymm === 'string' ? value.yyyymm : '', resetsAt: typeof value.resetsAt === 'string' && Number.isFinite(Date.parse(value.resetsAt)) ? value.resetsAt : null, timeZone: 'Asia/Tokyo' };
    if (value.version === 4) {
      const costs = value.operationCosts;
      if (!costs || costs.consultation !== 1 || costs.document !== 2 || costs.final !== 3 || (costs.business !== undefined && costs.business !== 10) || (costs.diagnosis !== undefined && costs.diagnosis !== 3)) return null;
      const price = value.price && countOf(value.price.monthlyJpy) != null && value.price.taxIncluded === true ? { monthlyJpy: value.price.monthlyJpy, taxIncluded: true } : null;
      return { version: 4, ...common, credits: usageCountsOf(value.credits), ...(value.giftCredits?{giftCredits:usageCountsOf(value.giftCredits),monthlyCredits:usageCountsOf(value.monthlyCredits)}:{}), operationCosts: { consultation: 1, document: 2, final: 3, ...(costs.business === 10 ? { business: 10 } : {}), ...(costs.diagnosis === 3 ? { diagnosis: 3 } : {}) }, price, ...(value.options?.multiDomain === true ? { options: { multiDomain: true } } : {}) };
    }
    if (value.version === 3) return { version: 3, ...common, credits: usageCountsOf(value.credits) };
    if (value.version === 2 && value.buckets && typeof value.buckets === 'object') {
      const buckets = {};
      for (const key of ['consultation', 'creation']) {
        const b = value.buckets[key];
        buckets[key] = usageCountsOf(b);
      }
      return { version: 2, ...common, buckets };
    }
    if (value.version != null && value.version !== 1) return null;
    const limit = countOf(value.monthlyLimit), used = countOf(value.usedThisMonth), remaining = countOf(value.remainingThisMonth);
    if (limit == null && used == null && remaining == null) return null;
    return { version: 1, ...common, monthlyLimit: limit, usedThisMonth: used, remainingThisMonth: remaining ?? (limit != null && used != null ? Math.max(0, limit - used) : null) };
  }
  const usageExpired = (usage, now = Date.now()) => !!usage?.resetsAt && Date.parse(usage.resetsAt) <= now;
  const usageBucket = (usage, bucket) => [3, 4].includes(usage?.version) ? usage.credits : usage?.version === 2 ? usage.buckets?.[bucket === 'document' || bucket === 'final' ? 'creation' : bucket] : null;
  const creditCost = (usage, bucket) => usage?.version === 4 ? usage.operationCosts?.[bucket === 'creation' ? 'final' : bucket === 'credits' ? 'consultation' : bucket] ?? null : 1;
  const usageBlocked = (usage, bucket, now) => {
    if (usageExpired(usage, now)) return false;
    if (usage?.version === 1) return usage.remainingThisMonth === 0;
    const remaining = usageBucket(usage, bucket)?.remaining, required = creditCost(usage, bucket);
    return remaining != null && required != null && remaining < required;
  };
  const finalBundleAvailable = (plan, now = Date.now()) => plan?.finalBundle?.version === 1 && typeof plan.finalBundle.id === 'string' && !!plan.finalBundle.id && Date.parse(plan.finalBundle.expiresAt) > now;
  const usageReserved = (usage, bucket) => { const b = usageBucket(usage, bucket), needed = creditCost(usage, bucket); return b?.remaining != null && needed != null && b.remaining < needed && b.used != null && b.limit != null && b.limit - b.used >= needed && b.reserved > 0; };
  const quotaErrorDetail = error => error?.details?.error?.detail || error?.detail?.error?.detail || error?.details || error?.detail || {};
  const isReservedError = error => { const detail = quotaErrorDetail(error); return detail.reason === 'QUOTA_RESERVED' || usageReserved(usageOf(detail.usage), detail.operation || detail.bucket); };
  const usageResetText = usage => usage?.resetsAt ? new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(usage.resetsAt)) + '（日本時間）' : '未確認';
  const usagePlanLabel = usage => (({ 'toolkit-light': [3, 4].includes(usage?.version) ? 'SOLO' : 'ライト', 'toolkit-standard': [3, 4].includes(usage?.version) ? 'TEAM' : 'スタンダード', 'toolkit-business': 'Business', 'toolkit-welcome':'初回プレゼント' })[usage?.plan] || '契約プラン') + (usage?.version === 4 && usage?.options?.multiDomain === true ? (usage?.plan === 'toolkit-business' ? '（MULTI込み）' : ' ＋ MULTI') : '');
  function monthlyLimitText(error) {
    const detail = quotaErrorDetail(error);
    const usage = usageOf(detail.usage), shared = [3, 4].includes(usage?.version) || detail.bucket === 'credits';
    const label = shared ? 'クレジット' : ({ consultation: '相談', creation: '作成' }[detail.bucket] || 'AI利用') + '回数', reset = shared ? '利用枠' : '回数';
    if (isReservedError(error)) return `${label}は処理中の要求などのため確保されています。完了後に［接続を更新］で残数を確認してください。会話・作成済みの内容は残っています。コピー・保存・反映・元に戻す操作は引き続き利用できます。`;
    if (usage?.version === 4 && usage.credits?.remaining > 0) {
      const needed = countOf(detail.requiredCredits) ?? creditCost(usage, detail.operation || detail.bucket);
      return `この操作に必要な${needed == null ? '' : needed}${label}が足りません（残り${usage.credits.remaining}クレジット）。［接続］で利用状況を確認してください。会話・作成済みの内容は残っています。`;
    }
    if(usage?.plan==='toolkit-welcome')return '初回プレゼントのクレジットを使い切りました。続ける場合はAIプランを選べます。自動課金はありません。無料機能と保存済みの回答は引き続き利用できます。';
    return `今月の${label}の上限に達しました。${usage?.resetsAt ? reset + 'の更新は' + usageResetText(usage) + 'です。' : '［接続］で' + reset + 'の更新日を確認してください。'}会話・作成済みの内容は残っています。コピー・保存・反映・元に戻す操作は引き続き利用できます。`;
  }
  function budgetLimitText(error) {
    const outer = quotaErrorDetail(error), d = outer.budget?.reason ? outer.budget : outer;
    const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v.toLocaleString('en-US',{maximumFractionDigits:6}) : null;
    const need = number(d.boundUsd ?? d.needUsd), remaining = number(d.remainingUsd ?? d.allowanceUsd);
    const before = d.stage === 'first' || (!d.stage && ['limit','calls'].includes(d.reason));
    const stopped = before ? 'AIには送信していません。' : 'この操作を停止しました。';
    if (d.reason === 'over-allowance' || d.reason === 'limit') return '今回のAI呼び出しに必要な費用枠を確保できません。' + (need !== null ? '事前確保の上限額は約'+need+'米ドル' : '必要額は未確認') + (remaining !== null ? '、今回使える残額は'+remaining+'米ドルです。' : 'です。') + '確保額は実費ではなく、入力と最大出力を含む保守的な見積もりです。'+stopped+'［接続］で上限を確認してください。';
    if (d.reason === 'calls') return 'AI呼び出し回数の残りが足りません。'+(number(d.needCalls)!==null?'必要'+number(d.needCalls)+'回・残り'+(number(d.remainingCalls)??'未確認')+'回。':'')+stopped;
    if (['unknown-model','unknown-bound'].includes(d.reason)) return '今回のAI費用を確認できないため停止しました。モデルの料金設定と見積もり処理を確認してください。'+stopped;
    return '費用または回数の上限を確認できず、作成を止めました。詳細は未確認です。［接続］で利用状況を確認してください。';
  }
  const stampOf = base => base?.stamp?.fingerprint || base?.stamp || base?.fingerprint || null;
  const errorOf = e => ({ code: e?.code || 'ERROR', message: e?.code === 'MONTHLY_LIMIT_EXCEEDED' ? monthlyLimitText(e) : e?.code === 'BUDGET_EXCEEDED' ? budgetLimitText(e) : e?.code === 'MODEL_OUTPUT_INVALID' ? ((e?.details?.error?.detail || e?.details)?.reason === 'EXCESSIVE_JSON_WHITESPACE' ? 'AIの回答で空白の繰り返しを検出したため、受信を止めました。結果は未完成のため採用していません。設定を減らす必要があるとは限りません。会話を保存し、回答形式を確認してください。再実行するとAIを呼び直します。' : (e?.details?.error?.detail || e?.details)?.reason === 'OUTPUT_TRUNCATED' ? 'AIの回答が出力上限に達し、途中で終了しました。結果は未完成のため採用していません。設定を減らす必要があるとは限りません。会話を保存し、出力上限と回答量の調整を確認してください。再実行するとAIを呼び直します。' : 'AIの応答形式を確認できなかったため、処理を止めました。問題の詳細を確認してください。') : e?.message || '処理を完了できませんでした。', detail: clone(e?.details || null) });
  const busyPhases = new Set(['recovering', 'consulting', 'building', 'preparing', 'applying', 'rolling-back', 'checking-result']);
  const SESSION_VERSION = 'release-workspace-session-1';
  const savedStateKeys = ['responseRecovery', 'phase', 'taskId', 'version', 'goal', 'requestPurpose', 'consultationTarget', 'proposalTarget', 'adoptedTarget', 'proposal', 'proposalPending', 'selectedSuggestionIds', 'questionIdFloor', 'answers', 'adopted', 'plan', 'artifacts', 'resultRunId', 'messages', 'explanations', 'explanationId', 'error'];
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const pick = (value, keys) => value == null ? null : Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  // Saved content is a document, never a credential store or an execution snapshot.
  // Nested specs and evidence may use any field code, including token/password.
  // Keep their JSON exactly; transport data is excluded by domain allowlists.
  function historyData(value) {
    if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(historyData);
    if (!object(value)) throw new Error('保存できない内容があります。');
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, historyData(item)]));
  }
  const savedError = error => {
    const saved = historyData(pick(error, ['code', 'message', 'operation']));
    if (error?.code === 'CONTEXT_TOO_LARGE') {
      const d = error.detail;
      if (['INPUT_BYTES', 'INPUT_FACTS', 'EXPANDED_BYTES'].includes(d?.reason)) saved.detail = { reason: d.reason, ...Object.fromEntries(['bytes', 'count', 'limit'].filter(k => Number.isSafeInteger(d[k]) && d[k] >= 0).map(k => [k, d[k]])) };
      return saved;
    }
    if (error?.code === 'BUDGET_EXCEEDED') {
      const outer = error.detail?.error?.detail || error.detail || {}, d = outer.budget?.reason ? outer.budget : outer;
      saved.detail = Object.fromEntries(['boundUsd','needUsd','allowanceUsd','remainingUsd','spentUsd','needCalls','remainingCalls','limitUsd','maxCalls','bodyBytes','maxOutputTokens'].filter(k=>typeof d[k]==='number'&&Number.isFinite(d[k])&&d[k]>=0).map(k=>[k,d[k]]));
      for (const k of ['reason','stage']) if (typeof d[k]==='string' && /^[a-z-]{1,60}$/.test(d[k])) saved.detail[k]=d[k];
      return saved;
    }
    if (error?.code !== 'MODEL_OUTPUT_INVALID') return saved;
    const detail = error.detail?.error?.detail || error.detail;
    // Persist validation identifiers, never response bodies, transport headers or model text.
    const identifier = (value, pattern, max) => typeof value === 'string' && value.length <= max && pattern.test(value) ? value : null;
    const code = value => identifier(value, /^[A-Z][A-Z0-9_]*$/, 100);
    const rows = values => (Array.isArray(values) ? values : []).slice(0, 30).map(row => ({
      code: code(row?.code), path: identifier(row?.path, /^[A-Za-z0-9_.$\[\]-]+$/, 200)
    })).filter(row => row.code || row.path);
    const diagnostic = { errors: rows(detail?.errors), warnings: rows(detail?.warnings), reason: code(detail?.reason) };
    if (diagnostic.errors.length || diagnostic.warnings.length || diagnostic.reason) saved.detail = diagnostic;
    return saved;
  };
  const savedGenerated = result => {
    if (!result) return null;
    const value = historyData(pick(result, ['strategy', 'targetFile', 'summary', 'code', 'body', 'patch', 'events', 'fields', 'apis', 'assumptions', 'warnings', 'coverage', 'verification', 'artifactOutcome', 'error', 'decline']));
    if (result.generated) value.generated = savedGenerated(result.generated);
    if (value.error) value.error = savedError(value.error);
    return value;
  };
  const savedRow = row => historyData(pick(row, ['id', 'stepId', 'title', 'label', 'name', 'targetFile', 'status', 'message', 'partial']));
  const savedResult = value => {
    if (!value) return null;
    const result = historyData(pick(value, ['status', 'written', 'message', 'recoveryState', 'retryable', 'reasons']));
    if (Array.isArray(value.rows)) result.rows = value.rows.map(savedRow);
    for (const key of ['settings', 'files']) {
      if (Array.isArray(value[key])) result[key] = value[key].map(savedRow);
      else if (object(value[key])) result[key] = { ...historyData(pick(value[key], ['status', 'message'])), steps: (value[key].steps || []).map(savedRow) };
    }
    if (value.error) result.error = savedError(value.error);
    return result;
  };
  const savedRun = run => ({
    ...historyData(pick(run, ['id', 'at', 'taskId', 'goal', 'status'])), archived: true,
    prepared: run.prepared ? { changes: historyData(run.prepared.changes || []), confirmations: historyData(run.prepared.confirmations || []), reasons: historyData(run.prepared.reasons || []) } : null,
    result: savedResult(run.result), ...(run.rollback ? { rollback: savedResult(run.rollback) } : {})
  });
  const appOf = value => value?.appId ?? value?.data?.appId ?? value?.current?.appId ?? value?.inputs?.data?.appId ?? null;
  const environmentOf = value => value?.env ?? value?.current?.env ?? null;
  // Same verification inputs as the execution adapter; only their digest is saved.
  async function verificationFingerprint(base) {
    const value = base?.current;
    if (!value) return null;
    return hash('release-verification:' + JSON.stringify(stable({ fields: value.fields?.properties || {},
      status: { enable: value.status?.enable ?? false, states: value.status?.states ?? null, actions: value.status?.actions ?? null },
      scope: value.customize?.scope ?? null,
      files: (value.files || []).map(f => ({ target: f.target, name: f.name, text: f.text ?? null, sourceAvailable: f.sourceAvailable === true })),
      registrations: Object.fromEntries(['desktop', 'mobile'].map(target => [target, (value.customize?.[target]?.js || []).map(f => ({ type: f.type, name: f.file?.name ?? f.name ?? null, url: f.url ?? null }))])) })));
  }
  function sessionState(state) {
    const saved = historyData(pick(state, savedStateKeys));
    saved.proposal = historyData(pick(state.proposal, ['behaviors', 'assumptions', 'decisions', 'approach', 'cannot']));
    saved.adopted = historyData(pick(state.adopted, ['behaviors', 'assumptions', 'decisions', 'approach', 'cannot']));
    saved.plan = historyData(pick(state.plan, ['goal', 'assessment', 'solution', 'relevantFields', 'proposedFields', 'steps', 'customizations', 'alternatives', 'questions', 'unknowns', 'impact', 'planId', 'finalBundle', 'generationInput']));
    saved.messages = state.messages.map(m => historyData(pick(m, ['id', 'role', 'text', 'facts', 'requestPurpose', 'consultationTarget', 'explanationId', 'businessIntent'])));
    saved.explanations = state.explanations.map(e => historyData(pick(e, ['id', 'title', 'sections', 'unknowns', 'facts', 'createdAt', 'version', 'requestPurpose', 'accepted', 'diagnosisSource', 'kind', 'schemaVersion', 'snapshot', 'businessUnderstanding', 'sourceScope'])));
    saved.artifacts = state.artifacts.map(a => ({ ...historyData(pick(a, ['customizationId', 'title'])), ...(a.result ? { result: savedGenerated(a.result) } : {}), ...(a.error ? { error: savedError(a.error) } : {}) }));
    for (const key of ['businessContext','businessArchive','businessMode','businessResult','businessSelectedIds','businessReviewRequired','businessPlanContext','businessInvalid','businessAnswerDrafts','businessPlanRequests','businessPlanSelectedIds']) if (Object.hasOwn(state,key)) saved[key] = historyData(state[key]);
    saved.error = savedError(state.error);
    saved.runs = state.runs.map(savedRun);
    return saved;
  }
  function validSession(payload) {
    const s = payload?.state, integer = n => Number.isSafeInteger(n) && n >= 0;
    if (!object(payload) || ![SESSION_VERSION,'release-workspace-session-2'].includes(payload.version) || !object(s) || !integer(payload.sequence) || !Array.isArray(payload.pendingPlanQuestions)) return false;
    // Older saved conversations predate response recovery; keep them readable.
    if (!savedStateKeys.filter(key => key !== 'responseRecovery').concat('runs').every(key => Object.hasOwn(s, key))) return false;
    const arrays = (value, keys) => keys.every(key => value[key] == null || Array.isArray(value[key]));
    if (!['idle', 'proposal', 'blocked', 'incomplete', 'review', 'unchanged', 'result', 'rollback-confirm', ...busyPhases].includes(s.phase) ||
      !integer(s.taskId) || !s.taskId || !integer(s.version) || !integer(s.questionIdFloor) || typeof s.goal !== 'string' ||
      !['consultation', 'document', 'ideation'].includes(s.requestPurpose) || typeof s.proposalPending !== 'boolean') return false;
    if (!['selectedSuggestionIds', 'answers', 'messages', 'explanations', 'artifacts', 'runs'].every(key => Array.isArray(s[key]))) return false;
    if (s.selectedSuggestionIds.some(id => typeof id !== 'string') || s.answers.some(a => !object(a) || typeof a.id !== 'string' || typeof a.answer !== 'string')) return false;
    if (s.messages.some(m => !object(m) || !integer(m.id) || !m.id || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string' || !arrays(m, ['facts']))) return false;
    if (s.explanations.some(e => !object(e) || !/^explanation-[1-9][0-9]*$/.test(e.id) || typeof e.title !== 'string' || !Array.isArray(e.sections))) return false;
    if (s.explanations.some(e => !arrays(e, ['unknowns', 'facts']) || e.sections.some(section => !object(section) || !arrays(section, ['paragraphs', 'items', 'evidenceIds']) || (section.table != null && (!object(section.table) || !Array.isArray(section.table.columns) || !Array.isArray(section.table.rows)))))) return false;
    if (s.explanations.some(e => e.kind === 'business-understanding' && (business().validateSnapshot(e.snapshot, { generatable: false }).length || (e.businessUnderstanding != null && business().validateOutput(e.businessUnderstanding, e.snapshot).length)))) return false;
    if (new Set(s.messages.map(m => m.id)).size !== s.messages.length || new Set(s.explanations.map(e => e.id)).size !== s.explanations.length) return false;
    if (s.explanationId !== null && !s.explanations.some(e => e.id === s.explanationId)) return false;
    for (const key of ['consultationTarget', 'proposalTarget', 'adoptedTarget']) if (s[key] !== null && consultationTargetOf(s[key]) === false) return false;
    for (const key of ['proposal', 'adopted']) if (s[key] !== null && (!object(s[key]) || !Array.isArray(s[key].behaviors) || !Array.isArray(s[key].decisions) || !arrays(s[key], ['assumptions', 'cannot']) || s[key].behaviors.some(b => !object(b) || typeof b.id !== 'string' || typeof b.text !== 'string'))) return false;
    if (s.plan !== null && (!object(s.plan) || !Array.isArray(s.plan.steps) || !Array.isArray(s.plan.customizations) || !Array.isArray(s.plan.questions) ||
      s.plan.steps.some(step => !object(step) || typeof step.id !== 'string' || typeof step.actionType !== 'string') || s.plan.customizations.some(c => !object(c) || typeof c.customizationId !== 'string'))) return false;
    if (s.plan && (!payload.baseline || !arrays(s.plan, ['relevantFields', 'proposedFields', 'alternatives', 'unknowns', 'impact']))) return false;
    if (s.artifacts.some(a => !object(a) || typeof a.customizationId !== 'string' || (a.result != null && !object(a.result)))) return false;
    if (s.runs.some(r => !object(r) || typeof r.id !== 'string' || !integer(r.taskId) || !r.taskId || typeof r.goal !== 'string' || !['running', 'complete', 'partial', 'failed', 'unknown'].includes(r.status))) return false;
    if (s.runs.some(r => (r.prepared != null && (!object(r.prepared) || !arrays(r.prepared, ['changes', 'confirmations', 'reasons']))) || [r.result, r.rollback].some(result => result != null && (!object(result) || !arrays(result, ['rows', 'reasons']) || ['settings', 'files'].some(key => result[key] != null && !Array.isArray(result[key]) && (!object(result[key]) || !arrays(result[key], ['steps']))))))) return false;
    if (new Set(s.runs.map(r => r.id)).size !== s.runs.length || (s.resultRunId !== null && !s.runs.some(r => r.id === s.resultRunId))) return false;
    if (payload.pendingPlanQuestions.some(q => !object(q))) return false;
    if (payload.baseline !== null && (!object(payload.baseline) || typeof payload.baseline.stamp !== 'string' || !payload.baseline.stamp ||
      (payload.baseline.appId !== null && typeof payload.baseline.appId !== 'string') || (payload.baseline.environment !== null && typeof payload.baseline.environment !== 'string') ||
      (payload.baseline.verificationFingerprint !== null && !/^[a-f0-9]{64}$/.test(payload.baseline.verificationFingerprint)))) return false;
    return true;
  }
  const questions = (proposal, answers = []) => (proposal?.decisions || []).filter(q => q.blocking && !q.answer && !answers.some(a => a.id === q.id && a.answer));
  const generatedBody = result => { const g = result?.generated || result; return g?.strategy === 'EXTEND_EXISTING_JS' ? g.body || '' : g?.code || ''; };
  const generatedResultAvailable = result => result?.artifactOutcome?.state === 'ready' ||
    (result?.artifactOutcome?.state === 'unverified' && !!generatedBody(result).trim());
  // Rechecking never regenerates code or reuses an approval. It is available only
  // while this task has no execution and every required artifact is complete.
  const canReprepare = state => !!state.plan && !state.proposalPending &&
    ['blocked', 'incomplete'].includes(state.phase) &&
    !(state.runs || []).some(run => run.taskId === state.taskId) &&
    !(state.plan.questions || []).some(q => q && q.blocking !== false) &&
    (state.plan.customizations || []).every(c => (state.artifacts || []).some(a => a.customizationId === c.customizationId && a.result?.artifactOutcome?.state === 'ready')) &&
    (['BASE_CHANGED', 'APPROVAL_CHANGED', 'BASE_UNAVAILABLE'].includes(state.error?.code) || state.prepared?.ok === false);
  // Only service states and error codes choose recovery actions; prose is not interpreted.
  function creationStateOf(state) {
    const artifacts = state.artifacts || [], unfinished = artifacts.filter(a => a.result?.artifactOutcome?.state !== 'ready');
    const codes = new Set([state.error?.code, ...unfinished.map(a => a.error?.code || a.result?.error?.code)]);
    const unverified = unfinished.some(a => a.result?.artifactOutcome?.state === 'unverified') ||
      ['SANDBOX_OUTDATED', 'SANDBOX_UNAVAILABLE', 'REQUIRED_EFFECTS_UNRESOLVED', 'CONDITION_SOURCE_UNVERIFIABLE', 'OUTCOME_REQUIRED', 'ARTIFACT_MISMATCH', 'BODY_MISMATCH'].some(code => codes.has(code));
    const declined = codes.has('GENERATION_DECLINED') || unfinished.some(a => a.result?.artifactOutcome?.reasonCodes?.includes('GENERATION_DECLINED'));
    const reserved = [state.error, ...unfinished.map(a => a.error)].some(e => e?.code === 'MONTHLY_LIMIT_EXCEEDED' && isReservedError(e));
    const kind = unverified ? 'unverified' : declined ? 'declined' : reserved ? 'reserved' : (codes.has('BUDGET_EXCEEDED') || codes.has('MONTHLY_LIMIT_EXCEEDED')) ? 'limit' :
      unfinished.some(a => a.result?.artifactOutcome?.state === 'failed') ? 'failed' :
      unfinished.some(a => a.error) ? 'interrupted' : 'incomplete';
    return { kind, canResume: !!state.plan && !state.proposalPending && state.phase === 'incomplete' &&
      !declined && (!unverified || artifacts.some(a => a.result?.artifactOutcome?.state === 'unverified' && generatedResultAvailable(a.result)) &&
        (state.plan.customizations || []).some(c =>
        !artifacts.some(a => a.customizationId === c.customizationId && generatedResultAvailable(a.result))) &&
        !unfinished.some(a => a.result?.artifactOutcome?.state === 'unverified' && !generatedResultAvailable(a.result))) &&
      !(state.plan.questions || []).some(q => q && q.blocking !== false) };
  }
  // Selection is a local draft, never an adoption or a new interpretation of text.
  function suggestionRequest(state) {
    const ids = new Set(state.selectedSuggestionIds || []);
    const items = (state.proposal?.behaviors || []).filter(b => b.origin === 'suggestion' && ids.has(b.id));
    return items.length ? '選んだ追加提案を現在の案に取り込み、案を更新してください。\n\n' + items.map(b => '- ' + b.text).join('\n') : '';
  }
  // Alternatives are suggestions, not selected operations. Follow explicit IDs only.
  function mainPlan(value) {
    const plan = clone(value), excluded = new Set((plan.alternatives || []).flatMap(a => a.stepIds || []));
    const alternatives = plan.steps.filter(s => s.alternativeId || excluded.has(s.id));
    plan.steps = plan.steps.filter(s => !s.alternativeId && !excluded.has(s.id));
    const idOf = s => s.actionType === 'CUSTOMIZATION_REQUIRED' ? s.spec?.customizationId : null;
    const mainIds = new Set(plan.steps.map(idOf).filter(Boolean));
    const alternativeIds = new Set(alternatives.map(idOf).filter(Boolean));
    plan.customizations = (plan.customizations || []).filter(c => !c.alternativeId && (!alternativeIds.has(c.customizationId) || mainIds.has(c.customizationId)));
    plan.questions = [...(plan.questions || []), ...plan.customizations.flatMap(c => c.questions || [])];
    return plan;
  }
  const explanationBody = e => e?.kind === 'business-understanding' ? businessView().historyBody(e) : e ? clone({ title: e.title, sections: e.sections, unknowns: e.unknowns }) : null;
  // A selected identifier is an explicit UI reference, not an interpretation of the request.
  function consultationTargetOf(value) {
    if (value == null) return null;
    if (value.environment !== 'preview' || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 300) return false;
    if (['field', 'event'].includes(value.type)) {
      if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 300 ||
          !['string', 'number'].includes(typeof value.appId) || !String(value.appId).trim() || String(value.appId).length > 100) return false;
      return { type: value.type, id: value.id, name: value.name, appId: String(value.appId), environment: 'preview' };
    }
    if (value.type !== 'FILE' || !['desktop', 'mobile'].includes(value.target)) return false;
    return { name: value.name, target: value.target, type: 'FILE', environment: 'preview',
      ...(typeof value.fileKey === 'string' ? { fileKey: value.fileKey } : {}), ...(value.revision != null ? { revision: String(value.revision) } : {}) };
  }
  function resolveConsultationTarget(target, base) {
    if (!target) return null;
    const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
    if (base.env !== 'preview') fail('CONSULTATION_ENVIRONMENT', '相談する対象の動作テスト環境を確認できません。');
    if (['field', 'event'].includes(target.type)) {
      if (String(base.appId) !== target.appId) fail('CONSULTATION_ENVIRONMENT', '選択した対象と現在のアプリが一致しません。対象を選び直してください。');
      let name = target.id;
      if (target.type === 'field') {
        const collect = properties => Object.values(properties || {}).flatMap(field => [field, ...(field.type === 'SUBTABLE' ? collect(field.fields) : [])]);
        const matches = collect(base.data?.fields).filter(field => field.code === target.id);
        if (matches.length !== 1) fail('CONSULTATION_TARGET_CHANGED', '相談するフィールドを現在の設定で一つに特定できません。フィールドを選び直してください。');
        name = matches[0].label || matches[0].code;
      }
      // Event references are resolved by the existing scanner in context creation.
      // Missing evidence remains unverified; it is not proof that an event is unused.
      return { type: target.type, id: target.id, name, appId: target.appId, environment: 'preview', revision: String(base.revision?.preview ?? '') };
    }
    const matches = (base.files || []).filter(f => f.type === 'FILE' && f.name === target.name && f.target === target.target);
    if (matches.length !== 1) fail('CONSULTATION_TARGET_CHANGED', `相談する「${target.name}」（${target.target === 'mobile' ? 'モバイル' : 'PC'}）を一つに特定できません。ファイルを選び直してください。`);
    const file = matches[0];
    if (file.sourceAvailable === false || typeof file.text !== 'string' || !file.fileKey) fail('CONSULTATION_SOURCE_UNAVAILABLE', `相談する「${target.name}」の現在の本文を取得できません。`);
    return { name: file.name, target: file.target, type: 'FILE', environment: 'preview', fileKey: String(file.fileKey), revision: String(base.revision?.preview ?? '') };
  }
  function create({ services, loadBase, execution, scope = null, now = () => Date.now(), onChange = null } = {}) {
    if (!services || !loadBase || !execution) throw new Error('作業に必要な部品がありません。');
    const state = { responseRecovery: null, phase: 'idle', taskId: 1, version: 0, goal: '', requestPurpose: 'consultation', consultationTarget: null, proposalTarget: null, adoptedTarget: null, proposal: null, proposalPending: false, selectedSuggestionIds: [], questionIdFloor: 0, answers: [], adopted: null, plan: null, artifacts: [], prepared: null, runs: [], resultRunId: null, messages: [], explanations: [], explanationId: null, error: null, progress: '', rollback: null };
    Object.assign(state, { businessContext: null, businessArchive: [], businessMode: 'understand', businessResult: null, businessSelectedIds: [], businessReviewRequired: false, businessPlanContext: null, businessInvalid: null, businessAnswerDrafts: {}, businessPlanRequests: null, businessPlanSelectedIds: [] });
    const sourceScopeFor = (snapshot, fresh) => scope && String(snapshot?.appId ?? fresh?.appId) === String(scope.appId) ? { domain: scope.domain, appId: String(scope.appId), environment: snapshot?.environment || fresh?.env, startedAt: snapshot?.startedAt || new Date(now()).toISOString(), completedAt: snapshot?.completedAt || new Date(now()).toISOString(), revision: String(snapshot?.revision ?? fresh?.revision?.preview ?? ''), snapshotId: snapshot?.snapshotId || 'document-source-' + sequence } : null;
    let base = null, controller = null, epoch = 0, sequence = 0, pendingPlanQuestions = [], cancelDocument = null, restoringSession = false, restoredBaseline = null, documentPhase = null;
    const fingerprints = new WeakMap(), fingerprintTasks = new WeakMap();
    const listeners = new Set(onChange ? [onChange] : []);
    const emit = () => { const snapshot = clone(state); for (const fn of listeners) { try { fn(snapshot); } catch (e) { console.error(e); } } };
    const set = values => { Object.assign(state, values); emit(); };
    const available = () => !restoringSession && !busyPhases.has(state.phase);
    const message = (role, text, facts = null) => { const entry = { id: ++sequence, role, text, ...(facts ? { facts: clone(facts) } : {}) }; state.messages.push(entry); return entry; };
    const changeRequests = () => state.messages.filter(m => m.role === 'user' && (!m.requestPurpose || m.requestPurpose === 'consultation') && (!m.businessIntent || m.businessIntent === 'desired_change'));
    const businessProposalInput = () => { if(!state.businessPlanContext)return {};const context=consultation().wire(state.businessPlanContext);context.statements=context.statements.filter(s=>s.kind!=='desired_change'||state.businessPlanSelectedIds.includes(s.statementId));return {businessMode:'improve',businessContext:context}; };
    const requestTargets = () => state.businessPlanRequests ? state.businessPlanRequests.map(text=>({text,target:null})) : changeRequests().map(m => ({ text: m.text, target: clone(m.consultationTarget || null) }));
    const invalidate = () => { state.prepared = null; state.rollback = null; };
    async function getBase(reason) {
      const fresh = await loadBase({ reason });
      if (!fresh?.ok || !stampOf(fresh)) throw Object.assign(new Error(fresh?.message || '動作テスト環境の設定を取得できませんでした。'), { code: 'BASE_UNAVAILABLE' });
      const fingerprintTask = verificationFingerprint(fresh).then(value => { fingerprints.set(fresh, value); if (base === fresh) emit(); return value; }).catch(() => null);
      fingerprintTasks.set(fresh, fingerprintTask);
      return fresh;
    }
    async function activity(phase, work, failurePhase = 'blocked') {
      if (!available()) return false;
      const ticket = ++epoch;
      controller = new AbortController();
      set({ phase, error: null });
      try { await work(controller.signal, () => ticket === epoch); return true; }
      catch (e) { if (ticket === epoch) {
        const error = errorOf(e);
        if (phase === 'consulting') error.message += ['BUDGET_EXCEEDED', 'MONTHLY_LIMIT_EXCEEDED'].includes(error.code) ? ' 案は更新していません。利用可能になってから、相談内容をもう一度送信してください。' : ' 案は更新していません。相談内容をもう一度送信してください。';
        set({ phase: failurePhase, error, progress: '' });
      } return false; }
      finally { if (ticket === epoch) controller = null; }
    }
    async function validateArtifact(result, customization) {
      const outcome = result?.artifactOutcome;
      if (!outcome || outcome.version !== 'artifact-outcome-1' || !['ready', 'incomplete', 'unverified', 'failed'].includes(outcome.state)) throw Object.assign(new Error('AIサービスから検証結果を受け取れませんでした。接続先を確認してください。'), { code: 'OUTCOME_REQUIRED' });
      if (outcome.scope?.customizationId && outcome.scope.customizationId !== customization.customizationId) throw Object.assign(new Error('別の変更に対する検証結果を受け取りました。'), { code: 'ARTIFACT_MISMATCH' });
      if (outcome.state === 'ready') {
        const code = generatedBody(result), digest = await hash(code);
        const verification = result.verification || result.generated?.verification;
        if (outcome.scope?.customizationId !== customization.customizationId) throw Object.assign(new Error('検証結果と変更の対象が一致しません。'), { code: 'ARTIFACT_MISMATCH' });
        if (!code || !outcome.verifiedBodyHash || verification?.bodyHash !== outcome.verifiedBodyHash || !Array.isArray(outcome.operations) || !outcome.operations.length || outcome.operations.some(op => op.contentHash !== digest || op.bodyHash !== outcome.verifiedBodyHash)) throw Object.assign(new Error('検証した内容と登録する内容の一致を確認できませんでした。'), { code: 'BODY_MISMATCH' });
      }
      return { customizationId: customization.customizationId, title: customization.requirement || customization.customizationId, result: clone(result) };
    }
    async function build(signal, live) {
      const all = state.plan.customizations || [];
      const input = state.plan.generationInput || { answers: state.answers, requests: state.businessPlanRequests || changeRequests().map(m => m.text), version: state.version };
      for (const c of all) {
        if (!live()) return;
        const old = state.artifacts.find(a => a.customizationId === c.customizationId);
        if (generatedResultAvailable(old?.result)) continue;
        set({ progress: c.requirement || 'JavaScriptを作成しています。' });
        try {
          const result = await services.generate({ customization: clone(c), plan: clone(state.plan), proposal: clone(state.adopted), answers: clone(input.answers), requests: clone(input.requests), version: input.version, base, signal,
            onProgress: p => { if (live() && p?.stage) set({ progress: p.stage === 'repair' ? 'JavaScriptを修正しています。' : p.stage === 'verify' ? 'JavaScriptを確認しています。' : c.requirement }); } });
          if (!live()) return;
          const artifact = await validateArtifact(result, c);
          if (!live()) return;
          state.artifacts = state.artifacts.filter(a => a.customizationId !== c.customizationId).concat(artifact);
          emit();
          // An unverified generated file is still a result. Finish the remaining
          // files; incomplete verification must not silently drop their generation.
          if (!generatedResultAvailable(artifact.result)) break;
        } catch (e) {
          if (!live()) return;
          state.artifacts = state.artifacts.filter(a => a.customizationId !== c.customizationId).concat({ customizationId: c.customizationId, title: c.requirement, error: errorOf(e) });
          set({ phase: 'incomplete', error: errorOf(e), progress: '' });
          return;
        }
      }
      if (!live()) return;
      const unfinished = all.some(c => !state.artifacts.some(a => a.customizationId === c.customizationId && a.result?.artifactOutcome?.state === 'ready'));
      if (unfinished) { set({ phase: 'incomplete', progress: '' }); return; }
      await prepareInner(live);
    }
    async function prepareInner(live = () => true, acceptFresh = false) {
      if ((state.plan?.customizations || []).some(c => !state.artifacts.some(a => a.customizationId === c.customizationId && a.result?.artifactOutcome?.state === 'ready'))) {
        set({ phase: 'incomplete', prepared: null, progress: '' }); return;
      }
      set({ phase: 'preparing', progress: '反映する内容を確認しています。' });
      const fresh = await getBase('prepare');
      if (!live()) return;
      if (!acceptFresh && stampOf(fresh) !== stampOf(base)) { set({ phase: 'blocked', prepared: null, error: { code: 'BASE_CHANGED', message: '作成中に設定が変わりました。最新の設定で確認し直してください。' }, progress: '' }); return; }
      if (restoredBaseline) { await fingerprintTasks.get(fresh); if (!live()) return; }
      if (restoredBaseline && state.artifacts.length && stampOf(fresh) !== restoredBaseline.stamp &&
        (!restoredBaseline.verificationFingerprint || fingerprints.get(fresh) !== restoredBaseline.verificationFingerprint)) {
        set({ phase: 'blocked', prepared: null, progress: '', error: { code: 'VERIFICATION_CONTEXT_CHANGED', message: 'JavaScriptの検証に使った設定が変わりました。最新の設定で変更案を作り直してください。' } }); return;
      }
      const prepared = await execution.prepare({ plan: clone(state.plan), artifacts: clone(state.artifacts), base: fresh, ...(acceptFresh ? { previousBase: restoredBaseline ? fresh : base } : {}) });
      if (!live()) return;
      const signature = await hash({ plan: state.plan, artifacts: state.artifacts, baseStamp: stampOf(fresh), changes: prepared.changes, confirmations: prepared.confirmations });
      if (!live()) return;
      prepared.baseStamp = stampOf(fresh); prepared.signature = signature;
      // A rejected recheck must not become the basis of the old verification.
      if (prepared.ok) { base = fresh; restoredBaseline = null; }
      set({ prepared, progress: '', phase: !prepared.ok ? 'blocked' : prepared.changes?.length ? 'review' : 'unchanged' });
    }
    let recoveryAction=null, replayResult=null;
    const liveServices=services;
    services={...liveServices,...Object.fromEntries(['propose','plan','generate'].map(kind=>[kind,async input=>{
      if(replayResult) {
        if(replayResult.used||kind!==replayResult.record.kind)throw Object.assign(new Error('回答を回収しました。続きの作成は内容を確認してから実行してください。'),{code:'RECOVERY_COMPLETE'});
        if(liveServices.validateRecovery&&!(await liveServices.validateRecovery(kind,input,replayResult.record)))throw Object.assign(new Error('依頼時から設定や内容が変わっています。元の会話・設定で回答を取り直してください。'),{code:'RECOVERY_INPUT_CHANGED'});
        replayResult.used=true;return clone(replayResult.value);
      }
      const before=kind==='propose'?recoveryAction?.before:exportSession();
      if(before){before.state.responseRecovery=null;if(kind!=='propose'){before.state.phase=kind==='plan'?'proposal':'incomplete';before.state.error=null;}}
      const action=kind==='plan'?'adopt':kind==='generate'?'resume':recoveryAction?.action;
      const args=kind==='propose'?recoveryAction?.args:[];
      let prepared=null;
      try {
        const value=await liveServices[kind]({...input,onRecoveryPrepared:async record=>{
          if(before&&action){prepared={action,args:historyData(args),before:clone(before),record:historyData(record)};set({responseRecovery:prepared});}
        }});
        if(prepared&&state.responseRecovery?.record.body===prepared.record.body)set({responseRecovery:null});
        return value;
      }catch(e){
        if(prepared&&(!e.recovery||e.tokenStage))set({responseRecovery:null});
        throw e;
      }
    }]))};
    async function recoverable(action,args,fn) {
      args=args.slice();while(args.length&&args[args.length-1]===undefined)args.pop();
      if(!available())return false;
      if(state.responseRecovery){set({error:{code:'RESULT_RECOVERY_REQUIRED',message:'前の回答を取り直すか、再取得を終了してから新しい依頼を送ってください。'}});return false;}
      const before=exportSession();before.state.responseRecovery=null;
      recoveryAction={action,args:historyData(args),before};
      try{return await fn(...args);}finally{recoveryAction=null;}
    }
    async function recoverResponse() {
      if(!available()||!state.responseRecovery||!liveServices.recover)return false;
      const pending=clone(state.responseRecovery),current=exportSession();
      const action={send,adopt,resume,updateSuggestions}[pending.action];
      if(!action||!validSession(pending.before)){set({error:{code:'RESULT_RECOVERY_INVALID',message:'保存した再取得情報を確認できません。'}});return false;}
      set({phase:'recovering',progress:'保存済みの回答を取り直しています。AIは呼びません。',error:null});
      try {
        const value=await liveServices.recover(pending.record);
        set({phase:current.state.phase,progress:''});
        if(!(await restoreSession(pending.before)))throw new Error('元の会話を復元できませんでした。');
        replayResult={record:pending.record,value,used:false};
        await action(...pending.args);
        if(!replayResult.used)throw new Error(state.error?.message||'回答を会話に戻せませんでした。');
        set({responseRecovery:null});return true;
      }catch(e){
        set({phase:current.state.phase,progress:''});await restoreSession(current);
        set({responseRecovery:pending,error:errorOf(e)});return false;
      }finally{replayResult=null;}
    }
    const matchesProposal = reference => reference?.taskId === state.taskId && reference?.version === state.version;
    function selectSuggestion(id, checked, reference) {
      if (!matchesProposal(reference) || state.phase !== 'proposal' || state.proposalPending || !available() || typeof checked !== 'boolean') return false;
      const items = (state.proposal?.behaviors || []).filter(b => b.id === id && b.origin === 'suggestion' && typeof b.text === 'string' && b.text.trim());
      if (items.length !== 1) return false;
      const selected = new Set(state.selectedSuggestionIds);
      if (checked) selected.add(id); else selected.delete(id);
      set({ selectedSuggestionIds: [...selected] }); return true;
    }
    async function updateSuggestions(reference) {
      if (!matchesProposal(reference) || state.phase !== 'proposal' || state.proposalPending || !available()) return false;
      const request = suggestionRequest(state);
      return request ? send(request, { requestPurpose: 'consultation', requireProposalUpdate: true, consultationTarget: state.proposalTarget }) : false;
    }
    async function send(text, { requestPurpose = state.requestPurpose, requireProposalUpdate = false, consultationTarget = state.consultationTarget, environmentComparison = null, diagnosis = false, businessSnapshot = null, businessWorkflow = false } = {}) {
      const value = String(text || '').trim(); if (!value || !available()) return false;
      if (state.runs.some(r => r.status === 'running')) return false;
      if (state.businessContext && requestPurpose === 'consultation' && !requireProposalUpdate) return sendBusiness(value);
      if (!['consultation', 'document', 'ideation'].includes(requestPurpose)) return false;
      if (environmentComparison && requestPurpose !== 'document') return false;
      if(businessSnapshot&&businessWorkflow&&requestPurpose==='document'&&!diagnosis&&!environmentComparison){
        const readiness=business().workflowEligibility(businessSnapshot,{question:value});
        if(readiness.mode!=='analyze-all'){
          if(readiness.mode==='material-only')saveBusinessSnapshot(businessSnapshot);
          set({error:{code:'BUSINESS_MATERIAL_ONLY',message:readiness.reasons.join('。')+' AI分析は実行していません。全体図と根拠付き資料を確認・保存できます。'}});return false;
        }
      }
      if (businessSnapshot && (requestPurpose !== 'document' || diagnosis || environmentComparison || business().validateSnapshot(businessSnapshot,{workflow:businessWorkflow}).length)) return false;
      if (businessSnapshot) businessSnapshot = clone(businessSnapshot);
      if(businessSnapshot&&businessWorkflow&&!state.explanations.some(e=>e.snapshot&&JSON.stringify(e.snapshot)===JSON.stringify(businessSnapshot)&&!e.businessUnderstanding))saveBusinessSnapshot(businessSnapshot);
      if (diagnosis && (requestPurpose !== 'ideation' || environmentComparison || consultationTarget)) return false;
      const selectedTarget = consultationTargetOf(consultationTarget); if (selectedTarget === false) return false;
      const readOnly = requestPurpose !== 'consultation', ideation = requestPurpose === 'ideation';
      const operationLabel = businessSnapshot ? '業務工程の整理' : diagnosis ? 'アプリの診断' : ideation ? 'アイディア出し' : '資料の作成';
      if (!diagnosis && !businessSnapshot) state.requestPurpose = requestPurpose;
      let resolvedTarget = null, userMessage = null, baseScopeMatched = false;
      const unresolved = state.proposalPending;
      // Suspend actions before any consultation. Restore only when the service
      // explicitly reports no proposal change; failed revisions stay retired.
      const previousWork = clone({ phase: !readOnly && state.phase === 'rollback-confirm' ? 'result' : state.phase, plan: state.plan,
        adopted: state.adopted, adoptedTarget: state.adoptedTarget, artifacts: state.artifacts, prepared: state.prepared, error: state.error, progress: state.progress });
      const previousBase = base;
      const discussion = state.messages.map(m => ({ role: m.role, text: m.text, requestPurpose: m.requestPurpose || 'consultation',
        ...(m.explanationId ? { accepted: false } : {}),
        explanation: m.explanationId ? explanationBody(state.explanations.find(e => e.id === m.explanationId)) : null }));
      const originalRequestHistory = state.goal ? { initialRequest: state.goal, status: 'history-only' } : null;
      // The plan goal is historical input, not the adopted specification. Keep typed
      // placement/conditions and source provenance; never recover them from prose.
      const currentPlanSummaryOf = fresh => previousWork.plan ? JSON.stringify({ status: previousWork.phase,
        source: { appId: String(previousBase?.appId ?? previousBase?.data?.appId ?? ''), environment: previousBase?.env || null,
          revision: previousBase?.revision?.preview ?? null, baseStamp: stampOf(previousBase), matchesCurrentBase: stampOf(previousBase) === stampOf(fresh) },
        steps: clone(previousWork.plan.steps), proposedFields: clone(previousWork.plan.proposedFields || []),
        customizations: clone(previousWork.plan.customizations || []), questions: clone(previousWork.plan.questions || []), unknowns: clone(previousWork.plan.unknowns || []),
        artifacts: previousWork.artifacts.map(a => ({ title: a.title, state: a.result?.artifactOutcome?.state || 'failed', message: a.result?.artifactOutcome?.message || a.error?.message })),
        preparation: previousWork.prepared ? { ok: previousWork.prepared.ok, changes: clone(previousWork.prepared.changes), reasons: clone(previousWork.prepared.reasons), confirmations: clone(previousWork.prepared.confirmations) } : null }) : null;
      const run = state.runs.findLast(r => r.taskId === state.taskId);
      const currentResultSummary = run ? JSON.stringify({ status: run.status, version: run.approval?.version,
        message: run.result?.message, written: run.result?.written, plannedChanges: run.prepared?.changes, rows: run.result?.rows, reasons: run.result?.reasons,
        rollback: run.rollback ? { status: run.rollback.status, message: run.rollback.message, reasons: run.rollback.reasons,
          settings: run.rollback.settings ? { status: run.rollback.settings.status, steps: run.rollback.settings.steps?.map(s => ({ title: s.title, status: s.status, message: s.message })) } : null,
          files: run.rollback.files ? { status: run.rollback.files.status, steps: run.rollback.files.steps?.map(s => ({ title: s.name, status: s.status, message: s.message })) } : null } : null }) : null;
      const requestProposal = (signal, fresh) => {
        const oldApp = previousBase?.appId ?? previousBase?.data?.appId, newApp = fresh.appId ?? fresh.data?.appId;
        if (previousBase && ((oldApp != null && newApp != null && String(oldApp) !== String(newApp)) ||
            (previousBase.env && fresh.env && previousBase.env !== fresh.env))) {
          throw Object.assign(new Error('会話の対象と取得したアプリ・環境が一致しません。元のアプリで続けるか、新しい会話を始めてください。'), { code: 'CONSULTATION_ENVIRONMENT' });
        }
        baseScopeMatched = true;
        resolvedTarget = resolveConsultationTarget(selectedTarget, fresh);
        const currentTarget = state.consultationTarget;
        if (resolvedTarget?.type === 'field' && currentTarget?.type === 'field'
            && currentTarget.id === resolvedTarget.id && currentTarget.appId === resolvedTarget.appId
            && currentTarget.environment === resolvedTarget.environment) currentTarget.name = resolvedTarget.name;
        userMessage.consultationTarget = clone(resolvedTarget);
        return services.propose({ text: value, requestPurpose, ...(requestPurpose==='consultation'?businessProposalInput():{}), diagnosis, environmentComparison: clone(environmentComparison), consultationTarget: clone(resolvedTarget), requestTargets: requestTargets(), discussion, originalRequestHistory, acceptedProposal: previousWork.adopted, currentPlanSummary: currentPlanSummaryOf(fresh), currentResultSummary, previous: clone(state.proposal), questionIdFloor: state.questionIdFloor, pendingPlanQuestions: clone(pendingPlanQuestions), answers: clone(state.answers), requests: state.businessPlanRequests || changeRequests().map(m => m.text), base: fresh, signal });
      };
      if (readOnly) {
        // Document and ideation actions cannot revise a plan, even if their AI request fails.
        // Keep normal chat's failed-revision guard separate from this read-only operation.
        const previous = { ...previousWork, rollback: clone(state.rollback), proposalPending: unresolved };
        let fresh = null, completed = false;
        const restore = (error = null) => {
          const activePlan = previous.plan && previous.phase !== 'result' && previous.phase !== 'rollback-confirm';
          const changedBase = activePlan && baseScopeMatched && fresh && stampOf(fresh) !== stampOf(previousBase);
          // A retained plan keeps its own baseline, including after application.
          base = previous.plan || !baseScopeMatched ? previousBase : fresh || previousBase;
          set({ ...previous, error: error || (['document', 'ideation'].includes(previous.error?.operation) ? null : previous.error), ...(changedBase ? { phase: 'blocked', prepared: null,
            error: { code: 'BASE_CHANGED', message: (error ? error.message + ' ' : '') + operationLabel + 'の間に設定が変わりました。変更案を最新の設定で確認し直してください。' } } : {}) });
        };
        const stop = () => restore({ code: 'CANCELLED', operation: requestPurpose, message: operationLabel + 'を中断しました。変更案はそのまま残っています。' });
        cancelDocument = stop; documentPhase = previous.phase;
        userMessage = message('user', value); userMessage.requestPurpose = requestPurpose; userMessage.consultationTarget = clone(selectedTarget);
        try {
          await activity('consulting', async (signal, live) => {
            try {
              fresh = businessSnapshot ? null : await getBase('consult');
              if (!live()) return;
              const response = businessSnapshot ? await services.propose({ text: value, requestPurpose: 'document', businessSnapshot, businessWorkflow, signal }) : await requestProposal(signal, fresh);
              if (!live()) return;
              if (!response || typeof response.reply !== 'string' || response.intent !== 'question' || response.proposalUnchanged !== true ||
                  (businessSnapshot ? response.explanation != null || (businessWorkflow && response.businessUnderstanding?.schemaVersion!=='business-workflow-1') || business().validateOutput(response.businessUnderstanding, businessSnapshot,{requireAllStages:businessWorkflow}).length || response.adoptQuote || ['ops','answers','requirementOps'].some(k => !Array.isArray(response.turn?.[k]) || response.turn[k].length) : !response.explanation || typeof response.explanation.title !== 'string' || !Array.isArray(response.explanation.sections) || !response.explanation.sections.length)) {
                throw Object.assign(new Error(businessWorkflow ? '全工程の有効な分析結果を受け取れませんでした。全体図と根拠付き資料は会話に残っています。自動再試行は行いません。' : diagnosis ? 'AIサービスから診断結果を受け取れませんでした。もう一度診断してください。' : ideation ? 'AIサービスからアイディアを受け取れませんでした。もう一度依頼してください。' : 'AIサービスから資料の本文を受け取れませんでした。資料の作成をもう一度依頼してください。'), { code: ideation ? 'IDEATION_RESPONSE_INVALID' : 'DOCUMENT_RESPONSE_INVALID' });
              }
              const explanation = { ...(businessSnapshot ? { kind: 'business-understanding', schemaVersion: response.businessUnderstanding.schemaVersion, snapshot: clone(businessSnapshot), businessUnderstanding: clone(response.businessUnderstanding), title: response.businessUnderstanding.schemaVersion==='business-workflow-1'?'業務工程の整理':'業務ルールの候補', sections: [], unknowns: [] } : clone(response.explanation)), sourceScope: sourceScopeFor(businessSnapshot,fresh), id: 'explanation-' + (++sequence), facts: clone(response.facts || []), createdAt: now(), version: state.version, requestPurpose, accepted: false, ...(diagnosis ? { diagnosisSource: { appId: String(fresh.appId), environment: fresh.env, revision: fresh.revision?.preview ?? null, loadedAt: fresh.loadedAt ?? null } } : {}) };
              state.explanations.push(explanation);
              message('assistant', response.reply, response.facts); state.messages.at(-1).requestPurpose = requestPurpose;
              state.messages.at(-1).explanationId = explanation.id;
              state.explanationId = explanation.id;
              completed = true;
              restore();
            } catch (error) {
              if (live()) { const failure = errorOf(error); failure.operation = requestPurpose; failure.message = (businessSnapshot ? '業務工程を整理できませんでした。' : diagnosis ? 'アプリを診断できませんでした。' : ideation ? 'アイディアを作成できませんでした。' : '資料を作成できませんでした。') + failure.message; restore(failure); }
            }
          }, previous.phase);
        } finally { if (cancelDocument === stop) { cancelDocument = null; documentPhase = null; } }
        return completed;
      }
      if(state.businessPlanRequests)state.businessPlanRequests=state.businessPlanRequests.concat(value);
      invalidate(); userMessage = message('user', value); userMessage.requestPurpose = requestPurpose; userMessage.consultationTarget = clone(selectedTarget);
      // Retire the previous plan before a revision starts, including failed requests.
      pendingPlanQuestions = clone(state.plan?.questions || pendingPlanQuestions);
      Object.assign(state, { plan: null, adopted: null, adoptedTarget: null, artifacts: [], proposalPending: true, selectedSuggestionIds: [] });
      return activity('consulting', async (signal, live) => {
        const fresh = await getBase('consult');
        if (!live()) return;
        const response = await requestProposal(signal, fresh);
        if (!live()) return;
        if (!response || typeof response.reply !== 'string') throw new Error('AIサービスの返答を受け取れませんでした。');
        message('assistant', response.reply, response.facts); state.messages.at(-1).requestPurpose = requestPurpose;
        if (response.proposalUnchanged === true && ['question', 'smalltalk', 'unclear'].includes(response.intent)) {
          let explanationId = state.explanationId;
          if (response.explanation) {
            const explanation = { ...(businessSnapshot ? { kind: 'business-understanding', schemaVersion: response.businessUnderstanding.schemaVersion, snapshot: clone(businessSnapshot), businessUnderstanding: clone(response.businessUnderstanding), title: response.businessUnderstanding.schemaVersion==='business-workflow-1'?'業務工程の整理':'業務ルールの候補', sections: [], unknowns: [] } : clone(response.explanation)), id: 'explanation-' + (++sequence), facts: clone(response.facts || []), createdAt: now(), version: state.version, requestPurpose, accepted: false };
            state.explanations.push(explanation); explanationId = explanation.id;
            state.messages.at(-1).explanationId = explanation.id;
          }
          const activePlan = previousWork.plan && previousWork.phase !== 'result';
          const changedBase = activePlan && stampOf(fresh) !== stampOf(previousBase);
          base = previousWork.plan ? previousBase : fresh;
          set({ ...previousWork, proposalPending: unresolved || requireProposalUpdate, explanationId, ...(changedBase ? { phase: 'blocked', prepared: null,
            error: { code: 'BASE_CHANGED', message: '説明を確認している間に設定が変わりました。変更案を最新の設定で確認し直してください。' } } : {}) });
          return;
        }
        if (!state.goal) state.goal = value;
        state.explanationId = null;
        for (const answer of response.turn?.answers || []) {
          const question = (state.proposal?.decisions || []).find(q => q.id === answer.id) || state.answers.find(a => a.id === answer.id);
          if (question && answer.text) state.answers = state.answers.filter(a => a.id !== answer.id).concat({ id: answer.id, key: question.key, label: question.label, question: question.question || question.text || question.label, answer: answer.text, kind: answer.kind });
        }
        const rejected = new Set((response.turn?.ops || []).filter(o => o.op === 'reject').map(o => o.id));
        state.answers = state.answers.filter(a => !rejected.has(a.id));
        if (response.proposal && !response.proposalUnchanged) { state.proposal = clone(response.proposal); state.proposalTarget = clone(resolvedTarget); state.version++; }
        // Retired question identifiers are never reused within the same conversation.
        state.questionIdFloor = Math.max(state.questionIdFloor, ...(state.proposal?.decisions || []).concat(state.answers).map(q => /^Q[1-9][0-9]{0,2}$/.test(q.id) ? Number(q.id.slice(1)) : 0));
        base = fresh; restoredBaseline = null; pendingPlanQuestions = [];
        // Model intent never authorizes plan generation or a kintone write.
        set({ phase: state.proposal ? 'proposal' : 'idle', plan: null, adopted: null, artifacts: [], proposalPending: response.proposal && !response.proposalUnchanged ? false : unresolved || requireProposalUpdate });
      }, state.proposal ? 'proposal' : 'idle');
    }
    async function adopt() {
      if (state.businessReviewRequired) { set({error:{code:'BUSINESS_REVIEW_REQUIRED',message:'運用の前提が変わりました。変更希望を整理し、最新の設定で仮案を相談してください。'}}); return false; }
      if (!state.proposal || state.proposalPending || state.selectedSuggestionIds.length || questions(state.proposal, state.answers).length || !available() || (state.plan && state.runs.some(r => r.archived && r.taskId === state.taskId))) return false;
      invalidate(); pendingPlanQuestions = []; state.requestPurpose = 'consultation'; state.plan = null; state.adopted = clone(state.proposal); state.adoptedTarget = clone(state.proposalTarget); state.artifacts = [];
      // Optional ideas are not adopted by the general create action.
      state.adopted.behaviors = (state.adopted.behaviors || []).filter(b => b.origin !== 'suggestion');
      return activity('building', async (signal, live) => {
        const fresh = await getBase('plan');
        if (!live()) return;
        if (state.businessPlanContext) { const checked=await compareBusiness(state.businessPlanContext,signal); if (!live()) return; if (consultation().compare(state.businessPlanContext.freshness.source,checked.source).some(r=>r.status==='changed') || !consultation().equal(checked.preview.evidence.map(e=>({kind:e.kind,value:e.value,active:e.active})),state.businessPlanContext.freshness.preview.evidence.map(e=>({kind:e.kind,value:e.value,active:e.active}))) || checked.rows.some(r=>r.status==='unavailable'&&(state.businessPlanContext.snapshot?consultation().selectedRules(state.businessPlanContext).some(rule=>rule.evidenceRefs.some(ref=>state.businessPlanContext.snapshot.evidence.find(e=>e.evidenceId===ref.evidenceId)?.category===r.category)):r.comparison==='environment')) || String(fresh.revision?.preview)!==checked.preview.revision) { state.businessReviewRequired=true; throw Object.assign(new Error('相談後に設定が変わったか、照合できません。仮案を確認し直してください。'),{code:'BUSINESS_REVIEW_REQUIRED'}); } }
        base = fresh; restoredBaseline = null;
        set({ progress: '変更の計画を作成しています。' });
        const adoptedTarget = resolveConsultationTarget(state.adoptedTarget, fresh);
        const response = await services.plan({ proposal: clone(state.adopted), consultationTarget: adoptedTarget, requestTargets: requestTargets(), goal: state.goal, answers: clone(state.answers), requests: state.businessPlanRequests || changeRequests().map(m => m.text), businessPremises: state.businessPlanContext?.statements.filter(s=>s.kind==='current_operation'&&s.state==='recorded'&&!(state.businessPlanContext.attachmentExcludedIds||[]).includes(s.statementId)).map(s=>({statementId:s.statementId,text:s.text})) || [], version: state.version, base, signal });
        if (!live()) return;
        const plan = response?.plan;
        if (!plan || !Array.isArray(plan.steps) || !Array.isArray(plan.customizations || [])) throw new Error('変更の計画を受け取れませんでした。');
        state.plan = mainPlan(plan);
        // Resume the adopted request, even after a separate explanation or document.
        state.plan.generationInput = { answers: clone(state.answers), requests: state.businessPlanRequests || changeRequests().map(m => m.text), version: state.version };
        if (state.plan.questions.some(q => q && q.blocking !== false)) { set({ phase: 'blocked', progress: '', error: { code: 'PLAN_QUESTION', message: '変更案を作るために確認が必要です。内容を相談で伝えてください。' } }); return; }
        await build(signal, live);
      }, 'incomplete');
    }
    async function resume() {
      if (state.businessReviewRequired) { set({error:{code:'BUSINESS_REVIEW_REQUIRED',message:'運用の前提が変わりました。変更希望を整理し、最新の設定で仮案を相談してください。'}}); return false; }
      if (!creationStateOf(state).canResume || state.runs.some(r => r.archived && r.taskId === state.taskId)) return false;
      return activity('building', async (signal, live) => {
        const fresh = await getBase('resume');
        if (!live()) return;
        if (stampOf(fresh) !== stampOf(base)) throw Object.assign(new Error('設定が変わったため、残りだけを作成できません。最新の設定で変更案を作り直してください。'), { code: 'BASE_CHANGED' });
        base = fresh; restoredBaseline = null;
        await build(signal, live);
      }, 'incomplete');
    }
    async function reprepare() {
      if (state.businessReviewRequired) { set({error:{code:'BUSINESS_REVIEW_REQUIRED',message:'運用の前提が変わりました。変更希望を整理し、最新の設定で仮案を相談してください。'}}); return false; }
      if (!canReprepare(state) || !available()) return false;
      invalidate();
      return activity('preparing', async (_, live) => prepareInner(live, true));
    }
    async function apply() {
      if (state.businessReviewRequired) { set({error:{code:'BUSINESS_REVIEW_REQUIRED',message:'運用の前提が変わりました。変更希望を整理し、最新の設定で仮案を相談してください。'}}); return false; }
      if (state.phase !== 'review' || !state.prepared?.ok) return false;
      const approved = clone(state.prepared);
      return activity('applying', async (_, live) => {
        const fresh = await getBase('execute');
        if (!live()) return;
        if (stampOf(fresh) !== approved.baseStamp) { set({ phase: 'blocked', prepared: null, error: { code: 'BASE_CHANGED', message: '確認後に設定が変わりました。この案は反映していません。最新の設定で確認し直してください。' } }); return; }
        const checked = await execution.prepare({ plan: clone(state.plan), artifacts: clone(state.artifacts), base: fresh });
        const sig = await hash({ plan: state.plan, artifacts: state.artifacts, baseStamp: stampOf(fresh), changes: checked.changes, confirmations: checked.confirmations });
        if (!checked.ok || sig !== approved.signature) { set({ phase: 'blocked', prepared: null, error: { code: 'APPROVAL_CHANGED', message: '承認した内容と反映する内容が一致しないため、反映していません。変更案を確認し直してください。' } }); return; }
        const run = { id: `run-${state.taskId}-${++sequence}`, at: now(), taskId: state.taskId, goal: state.goal, status: 'running', approval: { version: state.version, signature: sig, baseStamp: approved.baseStamp }, prepared: checked, result: null };
        state.runs.push(run); emit();
        try {
          run.result = await execution.apply({ prepared: checked, onProgress: progress => { run.progress = progress; emit(); } });
          run.status = run.result?.status || 'unknown';
        } catch (e) { run.status = 'unknown'; run.result = { status: 'unknown', written: null, message: '反映の結果を確認できません。再度反映せず、現在の状態を確認してください。', error: errorOf(e) }; }
        set({ phase: 'result', resultRunId: run.id, prepared: null, progress: '' });
      }, 'blocked');
    }
    async function recheckRun(runId, kind) {
      const run = state.runs.find(r => r.id === runId), restoring = kind === 'rollback';
      const value = restoring ? run?.rollback : run?.result, method = restoring ? 'recheckRollback' : 'recheckApply';
      if (!run || run.archived || (restoring ? value?.status : run.status) !== 'unknown' || (!restoring && run.rollback) || !available() || typeof execution[method] !== 'function') return false;
      const previous = { phase: state.phase, resultRunId: state.resultRunId, progress: state.progress, error: clone(state.error) };
      const currentRun = run.taskId === state.taskId && state.phase === 'result' && (!state.resultRunId || state.resultRunId === run.id);
      const label = restoring ? '復元' : '反映';
      return activity('checking-result', async (_, live) => {
        set({ progress: label + '結果を確認しています。' });
        let checked;
        try { checked = await execution[method](clone(run)); }
        catch (e) { checked = { ...clone(value), status: 'unknown', message: label + 'の結果を確認できません。設定は変更していません。', error: errorOf(e) }; }
        if (!live()) return;
        if (!checked || !['complete', 'partial', 'failed', 'unknown'].includes(checked.status)) {
          checked = { ...clone(value), status: 'unknown', message: label + 'の確認結果を受け取れませんでした。設定は変更していません。' };
        }
        if (restoring) run.rollback = clone(checked);
        else { run.result = clone(checked); run.status = checked.status; }
        set(currentRun ? { phase: 'result', resultRunId: run.id, progress: '', error: null, ...(restoring ? { rollback: null } : {}) } : previous);
      }, previous.phase);
    }
    const recheckApply = runId => recheckRun(runId, 'apply');
    const recheckRollback = runId => recheckRun(runId, 'rollback');
    async function requestRollback(runId) {
      const run = state.runs.find(r => r.id === runId);
      if (!run || run.archived || run.status === 'unknown' || !run.result?.written || run.result?.retryable === false || run.rollback?.status === 'complete' || !available()) return false;
      return activity('preparing', async (_, live) => {
        const prepared = await execution.prepareRollback(clone(run));
        if (!live()) return;
        set({ phase: 'rollback-confirm', rollback: { runId, prepared }, progress: '' });
      }, 'result');
    }
    async function rollback(runId) {
      if (state.phase !== 'rollback-confirm' || state.rollback?.runId !== runId || !state.rollback.prepared?.ok) return false;
      const run = state.runs.find(r => r.id === runId), prepared = clone(state.rollback.prepared);
      if (!run || run.archived) return false;
      return activity('rolling-back', async () => {
        try { run.rollback = await execution.rollback({ run: clone(run), prepared, onProgress: p => { run.progress = p; emit(); } }); }
        catch (e) { run.rollback = { status: 'unknown', message: '戻した結果を確認できません。', error: errorOf(e) }; }
        set({ phase: 'result', resultRunId: run.id, rollback: null });
      }, 'result');
    }
    async function startBusiness(id,ruleId=null) {
      if(!available())return false;
      try {
        const doc=state.explanations.find(e=>e.id===id);const h=await consultation().create(doc,scope,ruleId);
        if(!available())return false;
        if(state.businessContext?.handoffId===h.handoffId){await consultation().verify(state.businessContext,scope);return true;}
        if(state.businessContext)state.businessArchive.push(clone(state.businessContext));
        const old=state.businessArchive.findLast(x=>x?.analysisId===h.analysisId&&x.analysisHash===h.analysisHash);
        if(old)await consultation().verify(old,scope);
        set({businessContext:old?{...clone(old),selection:clone(h.selection),handoffId:h.handoffId}:h,businessMode:'understand',businessResult:null,businessSelectedIds:[],businessInvalid:null,explanationId:null,requestPurpose:'consultation',consultationTarget:null});return true;
      }catch(e){set({error:errorOf(e)});return false;}
    }
    function recordBusiness(input) {
      if(!available()||!state.businessContext||state.businessInvalid)return false;
      try {const h=consultation().record(state.businessContext,input,new Date(now()).toISOString());
        if(state.adopted||state.plan){state.businessReviewRequired=true;invalidate();}
        set({businessContext:h,businessResult:state.businessResult});return true;
      }catch(e){set({error:errorOf(e)});return false;}
    }
    function withdrawBusiness(id){if(!available()||!state.businessContext)return false;const s=state.businessContext.statements.find(x=>x.statementId===id);if(!s)return false;s.state='withdrawn';state.businessSelectedIds=state.businessSelectedIds.filter(x=>x!==id);if(state.plan||state.adopted){state.businessReviewRequired=true;invalidate();}emit();return true;}
    function selectBusinessChange(id,selected){if(!available())return false;const s=state.businessContext?.statements.find(x=>x.statementId===id&&x.kind==='desired_change'&&x.state==='recorded');if(!s||(state.businessContext.attachmentExcludedIds||[]).includes(id))return false;const ids=new Set(state.businessSelectedIds);selected?ids.add(id):ids.delete(id);set({businessSelectedIds:[...ids]});return true;}
    function setBusinessMode(mode){if(!available()||!state.businessContext||!['understand','improve'].includes(mode))return false;set({businessMode:mode});return true;}
    async function compareBusiness(h,signal){
      if(typeof services.readBusinessSnapshot!=='function')throw new Error('現在の設定を照合する取得処理がありません。');
      const source=await services.readBusinessSnapshot(h.sourceScope.environment,signal);
      const preview=h.sourceScope.environment==='preview'?source:await services.readBusinessSnapshot('preview',signal);
      return consultation().assess(h,source,preview);
    }
    async function checkBusiness(){if(!available()||!state.businessContext)return false;const previous=state.phase;let ok=false;await activity('consulting',async(signal,live)=>{await consultation().verify(state.businessContext,scope);const fresh=await compareBusiness(state.businessContext,signal);if(!live())return;state.businessContext.freshness=fresh;state.businessContext.freshness.acknowledged=false;for(const record of state.businessContext.statements)if(consultation().active(record)&&fresh.status!=='unchanged')record.reviewState='needs_review';set({phase:previous});ok=true;},previous);return ok;}
    function acknowledgeBusiness(){if(!available()||!state.businessContext||state.businessContext.freshness.status==='unchecked')return false;state.businessContext.freshness.acknowledged=true;for(const record of state.businessContext.statements)if(consultation().active(record))record.reviewState='current';emit();return true;}
    async function sendBusiness(value) {
      if(state.businessInvalid)return false;
      const previous={phase:state.phase,error:clone(state.error),progress:state.progress};let completed=false,retired=false;
      const h=state.businessContext,mode=state.businessMode;
      if(!['understand','improve'].includes(mode))return false;
      if(mode==='improve'&&!state.businessSelectedIds.length){set({error:{code:'BUSINESS_CHANGE_REQUIRED',message:'仮案へ渡す変更希望を選んでください。'}});return false;}
      const stop=()=>set({...previous,...(retired?{phase:state.proposal?'proposal':'idle'}:{}),error:{code:'CANCELLED',message:'相談を中断しました。元資料と運用記録は残っています。'}});
      cancelDocument=stop;documentPhase=previous.phase;
      try{await activity('consulting',async(signal,live)=>{
        try {
          await consultation().verify(h,scope);if(!live())return;
          if(mode==='understand') {
            const m=message('user',value);m.requestPurpose='consultation';m.businessIntent='understand';h.messages.push({id:String(m.id),role:'user',text:value});
            consultation().context(h,value); // Size/structure guard before transport.
            const response=await services.propose({text:value,requestPurpose:'consultation',businessMode:'understand',businessContext:clone(h),signal});if(!live())return;
            if(response?.proposalUnchanged!==true)throw new Error('業務確認の応答に変更なしの確認情報がありません。');
            const issues=consultation().responseIssues(response,consultation().wire(h));
            if(issues.length)throw new Error('業務確認の応答を確認できません：'+issues[0].path+'：'+issues[0].message);
            const answer=message('assistant',response.reply);answer.businessIntent='understand';answer.requestPurpose='consultation';h.messages.push({id:String(answer.id),role:'assistant',text:JSON.stringify({reply:response.reply,businessConsultation:response.businessConsultation})});
            state.businessResult=clone(response.businessConsultation);state.businessResult.questions.forEach((q,i)=>{q.questionId='response:'+answer.id+':'+i;});h.questionHistory=(h.questionHistory||[]).concat(clone(state.businessResult.questions));completed=true;set({...previous,error:null});
          } else {
            const old=clone(h.freshness),freshness=await compareBusiness(h,signal);if(!live())return;
            h.freshness=freshness;
            const relevant=new Set(consultation().selectedRules(h).flatMap(r=>r.evidenceRefs.map(ref=>h.snapshot.evidence.find(e=>e.evidenceId===ref.evidenceId)?.category)).filter(Boolean));
            if(h.sourceKind==='reference_document') for(const c of business().CATEGORIES)relevant.add(c);
            if(freshness.rows.some(r=>r.status==='unavailable'&&relevant.has(r.category)))throw new Error('変更に関係する設定を照合できません。根拠の取得状態を確認してください。');
            const comparisonChanged=freshness.status==='changed'&&(!old.acknowledged||!consultation().equal(old.rows,freshness.rows)||!old.preview||consultation().compare(old.preview,freshness.preview).some(r=>r.status!=='unchanged')||!old.source||consultation().compare(old.source,freshness.source).some(r=>r.status==='changed'));
            if(comparisonChanged){set({...previous,error:{code:'BUSINESS_SOURCE_CHANGED',message:'分析時点との相違があります。照合結果を確認してから、変更希望を送信してください。'}});return;}
            const chosen=h.statements.filter(s=>state.businessSelectedIds.includes(s.statementId)&&s.state==='recorded'&&s.kind==='desired_change');
            if(!chosen.length)throw new Error('有効な変更希望を選んでください。');
            const current=await getBase('consult');if(!live())return;
            if(String(current.appId)!==h.sourceScope.appId||current.env!=='preview'||String(current.revision?.preview)!==freshness.preview.revision)throw new Error('照合後に設定が変わりました。もう一度確認してください。');
            const context=consultation().wire(h);context.statements=context.statements.filter(s=>s.kind!=='desired_change'||chosen.some(c=>c.statementId===s.statementId));
            const text=chosen.map(s=>s.text).join('\n');
            // Only this explicit selection retires the previous proposal. Free-form understanding is never a requirement.
            retired=true;invalidate();Object.assign(state,{plan:null,adopted:null,adoptedTarget:null,artifacts:[],proposalPending:true,selectedSuggestionIds:[]});
            const m=message('user',text);m.businessIntent='desired_change';m.requestPurpose='consultation';
            const response=await services.propose({text,requestPurpose:'consultation',businessMode:'improve',businessContext:context,previous:clone(state.proposal),questionIdFloor:state.questionIdFloor,base:current,requests:chosen.map(s=>s.text),answers:[],discussion:[],signal});if(!live())return;
            if(!response?.proposal||response.proposalUnchanged||!['propose','update'].includes(response.intent))throw new Error('変更希望から仮案を作成できませんでした。希望を確認してください。');
            state.proposal=clone(response.proposal);state.proposalTarget=null;state.version++;state.answers=[];state.questionIdFloor=Math.max(state.questionIdFloor,...(state.proposal.decisions||[]).map(q=>/^Q[1-9][0-9]*$/.test(q.id)?Number(q.id.slice(1)):0));state.goal=text;state.businessPlanContext=clone(h);state.businessPlanRequests=chosen.map(s=>s.text);state.businessPlanSelectedIds=chosen.map(s=>s.statementId);state.businessReviewRequired=false;base=current;state.businessArchive.push(clone(h));state.businessContext=null;state.businessMode='understand';state.businessResult=null;
            const reply=message('assistant',response.reply,response.facts);reply.businessIntent='desired_change';
            completed=true;set({phase:'proposal',proposalPending:false,error:null,explanationId:null});
          }
        }catch(e){if(live())set({phase:mode==='improve'&&state.proposalPending?(state.proposal?'proposal':'idle'):previous.phase,error:errorOf(e),progress:''});}
      },previous.phase);}finally{if(cancelDocument===stop){cancelDocument=null;documentPhase=null;}}
      return completed;
    }

    function exportSession() {
      const appId = appOf(base), environment = environmentOf(base);
      const persistent = { ...state, ...(documentPhase && state.phase === 'consulting' ? { phase: documentPhase } : {}) };
      if (['rollback-confirm', 'rolling-back'].includes(persistent.phase) && state.rollback?.runId) persistent.resultRunId = state.rollback.runId;
      return { version: state.businessContext || state.businessArchive.length || state.explanations.some(e=>e.sourceScope) ? 'release-workspace-session-2' : SESSION_VERSION, state: sessionState(persistent), sequence,
        pendingPlanQuestions: historyData(pendingPlanQuestions),
        baseline: base ? { stamp: stampOf(base), appId: appId == null ? null : String(appId), environment,
          verificationFingerprint: restoredBaseline?.verificationFingerprint ?? fingerprints.get(base) ?? null } : null };
    }
    async function restoreSession(payload, { shouldContinue = () => true } = {}) {
      if (!available() || typeof shouldContinue !== 'function') return false;
      let saved;
      try { saved = clone(payload); if (!validSession(saved)) return false; } catch (_) { return false; }
      restoringSession = true;
      try {
        // A fresh settings read is also the access check. Do not replace the current
        // conversation, emit, call AI, prepare, or write until it succeeds.
        const fresh = await getBase('history-open'), baseline = saved.baseline;
        if (!shouldContinue()) return false;
        await fingerprintTasks.get(fresh);
        if (!shouldContinue()) return false;
        if (baseline && ((baseline.appId !== null && String(appOf(fresh)) !== baseline.appId) ||
            (baseline.environment !== null && environmentOf(fresh) !== baseline.environment))) return false;
        const next = { responseRecovery:null, businessContext:null, businessArchive:[], businessMode:'understand', businessResult:null, businessSelectedIds:[], businessReviewRequired:false, businessPlanContext:null, businessInvalid:null, businessAnswerDrafts:{}, businessPlanRequests:null, businessPlanSelectedIds:[], ...sessionState(saved.state) };
        if (!Array.isArray(next.businessArchive) || !Array.isArray(next.businessSelectedIds) || !['understand','improve'].includes(next.businessMode)) return false;
        if (next.businessContext) { try { await consultation().verify(next.businessContext,scope);if(next.businessResult&&consultation().validateOutput(next.businessResult,consultation().wire(next.businessContext)).length)throw new Error('保存した相談の根拠参照を確認できません'); } catch(e) { next.businessInvalid=e.message; next.businessReviewRequired=true; next.businessMode='understand'; } }
        for (const artifact of next.artifacts) {
          if (artifact.result?.artifactOutcome?.state !== 'ready') continue;
          const customization = next.plan?.customizations.find(c => c.customizationId === artifact.customizationId);
          if (!customization) return false;
          await validateArtifact(artifact.result, customization);
          if (!shouldContinue()) return false;
        }
        Object.assign(next, { prepared: null, rollback: null, progress: '' });
        for (const run of next.runs) {
          if (run.status === 'running') {
            run.status = 'unknown'; run.result = { ...run.result, status: 'unknown', written: null,
              message: '反映中に画面が閉じられたため、結果を確認できません。同じ変更を再度反映せず、現在の設定を確認してください。' };
          }
          if (saved.state.phase === 'rolling-back' && run.id === (saved.state.resultRunId || next.runs.at(-1)?.id))
            run.rollback = { ...run.rollback, status: 'unknown', message: '復元中に画面が閉じられたため、結果を確認できません。現在の設定を確認してください。' };
        }
        const currentRun = next.runs.find(r => r.id === next.resultRunId) || next.runs.findLast(r => r.taskId === next.taskId);
        if (currentRun && ['result', 'applying', 'rolling-back', 'rollback-confirm', 'checking-result'].includes(next.phase)) {
          next.phase = 'result'; next.resultRunId = currentRun.id;
        } else if (next.phase === 'consulting' && next.requestPurpose === 'consultation') {
          next.proposalPending = true; next.phase = next.proposal ? 'proposal' : 'idle';
          next.error = { code: 'CANCELLED', message: '相談の完了を確認できません。相談内容をもう一度送信してください。' };
        } else if (next.plan) {
          const ready = next.plan.customizations.every(c => next.artifacts.some(a => a.customizationId === c.customizationId && a.result?.artifactOutcome?.state === 'ready'));
          if (ready && !next.plan.questions.some(q => q && q.blocking !== false)) {
            next.phase = 'blocked'; next.error = { code: baseline && stampOf(fresh) !== baseline.stamp ? 'BASE_CHANGED' : 'APPROVAL_CHANGED',
              message: '保存した変更案を開きました。反映する前に、最新の設定で内容を確認し直してください。' };
          } else if (next.plan.questions.some(q => q && q.blocking !== false)) next.phase = 'blocked';
          else {
            next.phase = 'incomplete';
            if (baseline && stampOf(fresh) !== baseline.stamp) next.error = { code: 'BASE_CHANGED', message: '保存後に設定が変わりました。最新の設定で変更案を作り直してください。' };
          }
        } else if (busyPhases.has(next.phase) || ['review', 'unchanged', 'rollback-confirm'].includes(next.phase)) next.phase = next.proposal ? 'proposal' : 'idle';
        const nextQuestions = historyData(saved.pendingPlanQuestions);
        const nextSequence = [...next.messages.map(m => m.id), ...next.explanations.map(e => Number(e.id.split('-').at(-1))), ...next.runs.map(r => Number(r.id.split('-').at(-1)) || 0)].reduce((maximum, id) => Math.max(maximum, id), Math.max(sequence, saved.sequence));
        if (!Number.isSafeInteger(nextSequence) || !shouldContinue()) return false;
        ++epoch; controller?.abort(); controller = null; cancelDocument = null; documentPhase = null;
        pendingPlanQuestions = nextQuestions; sequence = nextSequence;
        restoredBaseline = baseline;
        base = baseline ? { ok: true, stamp: baseline.stamp, appId: baseline.appId, env: baseline.environment } : fresh;
        Object.assign(state, next);
        emit(); return true;
      } catch (_) { return false; }
      finally { restoringSession = false; }
    }
    function saveBusinessSnapshot(snapshot) {
        if (!available() || business().validateSnapshot(snapshot, { generatable: false }).length) return false;
        const doc = { id: 'explanation-' + (++sequence), kind: 'business-understanding', schemaVersion: 'business-understanding-1', snapshot: clone(snapshot), sourceScope: sourceScopeFor(snapshot,null), businessUnderstanding: null, title: '業務工程の全体図と根拠付き資料', sections: [], unknowns: [], facts: [], createdAt: now(), version: state.version, requestPurpose: 'document', accepted: false };
        state.explanations.push(doc); set({ explanationId: doc.id }); return true;
      }
    return {
      getState: () => clone(state), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      savedBusinessAnalyses(environment) {
        if(restoringSession||!scope||!['production','preview'].includes(environment))return [];
        return state.explanations.filter(e=>e.businessUnderstanding?.schemaVersion==='business-workflow-1'&&e.sourceScope?.domain===scope.domain&&e.sourceScope?.appId===String(scope.appId)&&e.snapshot?.appId===String(scope.appId)&&e.sourceScope?.environment===environment&&e.snapshot?.environment===environment&&business().validateSnapshot(e.snapshot,{generatable:false}).length===0&&business().validateOutput(e.businessUnderstanding,e.snapshot,{requireAllStages:true}).length===0).reverse().map(e=>({id:e.id,revision:e.snapshot.revision,completedAt:e.snapshot.completedAt,title:e.title}));
      },
      saveBusinessSnapshot,
      getBusinessDraft(id) { const h=state.businessContext;return h ? state.businessAnswerDrafts[h.analysisId+':'+h.analysisHash+':'+id]||'' : ''; },
      setBusinessDraft(id,value) { if(!available()||!state.businessContext||typeof value!=='string'||value.length>2000)return false; const key=state.businessContext.analysisId+':'+state.businessContext.analysisHash+':'+id;state.businessAnswerDrafts[key]=value;emit();return true; },
      attachBusinessStatement(id,attached) { if(!available()||!state.businessContext)return false;const s=state.businessContext.statements.find(s=>s.statementId===id);if(!s||s.kind==='open_question')return false;const excluded=new Set(state.businessContext.attachmentExcludedIds||[]);attached?excluded.delete(id):excluded.add(id);state.businessContext.attachmentExcludedIds=[...excluded];if(!attached)state.businessSelectedIds=state.businessSelectedIds.filter(x=>x!==id);emit();return true; },
      startBusiness, recordBusiness, withdrawBusiness, selectBusinessChange, setBusinessMode, checkBusiness, acknowledgeBusiness,
      closeBusiness() { if (!available()) return false; if(state.businessContext) state.businessArchive.push(clone(state.businessContext)); set({businessContext:null,businessMode:'understand',businessResult:null}); return true; },
      exportSession, restoreSession, recoverResponse, discardResponseRecovery() { if(!available())return false;set({responseRecovery:null,error:null});return true; }, send:(...args)=>recoverable('send',args,send), selectSuggestion, updateSuggestions:(...args)=>recoverable('updateSuggestions',args,updateSuggestions), adopt:(...args)=>recoverable('adopt',args,adopt), resume:(...args)=>recoverable('resume',args,resume), reprepare, apply, requestRollback, rollback, recheckApply, recheckRollback,
      setRequestPurpose(value) { if (!available() || !['consultation', 'document', 'ideation'].includes(value)) return false; set({ requestPurpose: value }); return true; },
      setConsultationTarget(value) { if (!available()) return false; const target = consultationTargetOf(value); if (target === false) return false; set({ consultationTarget: target, ...(target ? { requestPurpose: 'consultation' } : {}) }); return true; },
      showExplanation(id) { if (restoringSession || !state.explanations.some(e => e.id === id)) return false; set({ explanationId: id }); return true; },
      showChanges() { if (restoringSession) return false; set({ explanationId: null }); return true; },
      async prepare() { if (state.businessReviewRequired) return false; if (!state.plan || state.proposalPending || state.runs.some(r => r.archived && r.taskId === state.taskId) || !available()) return false; return activity('preparing', async (_, live) => prepareInner(live)); },
      cancelRollback() { if (restoringSession || state.phase !== 'rollback-confirm') return false; set({ phase: 'result', rollback: null }); return true; },
      newTask() { if (!available()) return false; Object.assign(state,{ businessContext:null,businessArchive:[],businessMode:'understand',businessResult:null,businessSelectedIds:[],businessReviewRequired:false,businessPlanContext:null,businessInvalid:null,businessAnswerDrafts:{},businessPlanRequests:null,businessPlanSelectedIds:[] }); ++epoch; base = null; restoredBaseline = null; pendingPlanQuestions = []; Object.assign(state, { responseRecovery: null, phase: 'idle', taskId: state.taskId + 1, version: 0, goal: '', requestPurpose: 'consultation', consultationTarget: null, proposalTarget: null, adoptedTarget: null, proposal: null, proposalPending: false, selectedSuggestionIds: [], questionIdFloor: 0, answers: [], adopted: null, plan: null, artifacts: [], prepared: null, messages: [], explanations: [], explanationId: null, error: null, progress: '', rollback: null }); emit(); return true; },
      cancel() {
        if (!['consulting','building','preparing'].includes(state.phase)) return false;
        const consulting = state.phase === 'consulting';
        ++epoch; controller?.abort(); controller = null;
        if (consulting && cancelDocument) { const stop = cancelDocument; cancelDocument = null; documentPhase = null; stop(); return true; }
        invalidate();
        // send() already retired the previous plan and retained pending questions.
        set({ phase: state.plan ? 'incomplete' : state.proposal ? 'proposal' : 'idle', progress: '', error: { code: 'CANCELLED', message: consulting ? '相談を中断しました。案は更新していません。' : state.artifacts.length ? '作成を中断しました。作成途中の内容は残っています。' : '作成を中断しました。反映はしていません。' } }); return true;
      },
    };
  }
  return { create, hash, stampOf, generatedBody, questions, canReprepare, creationStateOf, suggestionRequest, usageOf, usageExpired, usageBlocked, usageReserved, creditCost, finalBundleAvailable, usageResetText, usagePlanLabel, monthlyLimitText };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseWorkspace };
