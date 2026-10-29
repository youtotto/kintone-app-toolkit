/* Current application facts, existing Deps results and explicitly accepted input.
 * Reuse the existing analysis; never interpret the conversation here. */
'use strict';
const KTReleaseContext = (() => {
  const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));
  const entries = x => Object.values(x || {});
  const sameFileEnvironment = (file, base) => file.env == null || file.env === base.env;
  function fieldsOf(properties, parent = null) {
    return entries(properties).flatMap(f => [{ code: f.code, label: f.label || f.code, type: f.type,
      ...(parent ? { subtable: parent } : {}), ...(f.lookup ? { lookup: true, lookupMappings: clone(f.lookup.fieldMappings || []) } : {}), ...(typeof f.expression === 'string' ? { expression: f.expression } : {}), ...(f.required != null ? { required: f.required } : {}),
      ...(f.options ? { options: Object.keys(f.options) } : {}), ...(f.type === 'SUBTABLE' ? { columns: Object.keys(f.fields || {}) } : {}) },
      ...(f.type === 'SUBTABLE' ? fieldsOf(f.fields, f.code) : [])]);
  }
  const appOf = base => ({ id: String(base.appId ?? base.data?.appId ?? ''), name: base.data?.appName || base.data?.name || null });
  const statusesOf = base => entries(base.data?.status?.states).map(x => x.name);
  function sizeCheck(ctx, limit) {
    if (new TextEncoder().encode(JSON.stringify(ctx)).length > limit) throw Object.assign(new Error('このアプリの設定と相談の記録は、一度に送れる量を超えています。内容を省略して送信することはできません。'), { code: 'CONTEXT_TOO_LARGE' });
    return ctx;
  }
  function dependencyContext(base, tools, consultationTarget = null) {
    const provenance = { environment: base.env || null, appId: String(base.appId ?? ''), revision: base.revision?.preview ?? null, loadedAt: base.loadedAt ?? null };
    const missingSettings = (base.errors || []).filter(e => e.env === 'preview').map(e => ({ key: e.what, label: e.label, code: e.code ?? null }));
    const unavailableFiles = (base.files || []).filter(f => !sameFileEnvironment(f, base) || f.type !== 'FILE' || f.sourceAvailable === false || typeof f.text !== 'string')
      .map(f => ({ name: f.name, target: f.target, reason: !sameFileEnvironment(f, base) ? 'environment-mismatch' : f.type === 'URL' ? 'url' : 'unavailable' }));
    const summary = { ...provenance, status: 'unavailable', analyzedAt: null, missingSettings, unavailableFiles,
      unchecked: ['動的に組み立てるフィールド名など、静的な解析で特定できない参照', 'URL指定のファイルとCSSの本文', 'プラグインの内部処理',
        '他アプリからこのアプリへの参照', '参照先アプリの設定や処理との整合性', 'レコードの内容と実際の画面での動作'] };
    if (consultationTarget?.type === 'event') summary.event = { name: consultationTarget.id, status: 'unavailable', references: 0,
      unchecked: ['動的に組み立てるイベント名と登録処理', '実際の呼び出し順、非同期の完了順と同じ値の上書き'] };
    let facts = [];
    if (tools && base.ok && base.env === 'preview') {
      // Never use Deps/scan/incoming caches or production file bodies. In particular,
      // a fingerprint does not cover every setting, so do not cache these results.
      const current = { ok: true, env: 'preview', appId: base.appId, loadedAt: base.loadedAt,
        data: { ...clone(base.data), relatedApps: {}, plugins: null }, files: clone((base.files || []).filter(f => sameFileEnvironment(f, base))), incoming: null, deps: null, scan: null };
      try {
        tools.analyze(current);
        if (current.analysisError || !current.deps || !current.scan) throw new Error('DEPENDENCIES_UNAVAILABLE');
        facts = current.deps.edges.map(edge => ({ ...tools.factFromEdge(current.deps, edge, 'uses'),
          kind: edge.sourceType === 'CUSTOMIZE' ? 'js-reference' : 'dependency',
          basis: edge.sourceType === 'CUSTOMIZE' ? 'code' : 'setting', provenance: clone(provenance) }));
        const unresolved = { fields: current.deps.meta?.unknownJsRefs || [], statuses: current.deps.meta?.unknownJsStatuses || [] };
        if (unresolved.fields.length || unresolved.statuses.length) facts.push({ kind: 'js-unresolved-reference', confidence: 'UNCERTAIN', basis: 'code', provenance: clone(provenance),
          statement: 'JavaScript内に、今回のフィールドやステータスの定義と照合できなかった参照の候補があります。実際の動作や変更の必要性は未確認です。', value: clone(unresolved) });
        if (summary.event) {
          const scan = current.scan, files = current.files;
          const coherent = String(scan.meta?.appId) === provenance.appId && scan.meta?.source === 'preview'
            && scan.meta?.scannedAt === base.loadedAt && scan.fileEvents && typeof scan.fileEvents === 'object';
          if (coherent) {
            for (const file of files) {
              if (file.type !== 'FILE' || file.sourceAvailable === false || typeof file.text !== 'string') continue;
              const matching = files.filter(f => f.target === file.target && f.name === file.name);
              const scanned = (scan.files || []).filter(f => f.target === file.target && f.name === file.name && f.kind === 'js');
              if (matching.length !== 1 || scanned.length !== 1 || scanned[0].note || scanned[0].text !== file.text) {
                summary.event.unchecked.push((file.target === 'mobile' ? 'モバイル' : 'PC') + ' / ' + file.name + 'の登録内容と解析結果を一つに特定できません');
                continue;
              }
              const rows = scan.fileEvents[file.target + ':js:' + file.name] || [];
              const refs = Array.isArray(rows) ? rows.filter(row => (typeof row === 'string' ? row : row?.name) === consultationTarget.id) : [];
              if (!refs.length) continue;
              const direct = refs.some(row => typeof row === 'string' || row.direct === true);
              facts.push({ kind: 'js-event-reference', confidence: direct ? 'LIKELY' : 'UNCERTAIN', basis: 'code', provenance: clone(provenance),
                statement: '登録済みファイル「' + file.name + '」にイベント「' + consultationTarget.id + '」の' + (direct ? '登録の記述があります。' : '登録の候補があります。') + '実際の実行や他の処理との影響は未確認です。',
                value: { event: consultationTarget.id, direct, file: { name: file.name, target: file.target, id: file.fileKey || file.id } } });
              summary.event.references++;
            }
            summary.event.status = summary.event.references ? 'references-found' : 'not-found';
          }
        }
        summary.status = 'analyzed'; summary.analyzedAt = current.deps.meta?.scannerMergedAt || current.deps.meta?.generatedAt || null;
      } catch (_) {
        // Failure is not an empty, successful graph. Raw settings remain available.
        facts = []; summary.unchecked.unshift('依存関係の解析結果を取得できませんでした');
        if (summary.event) { summary.event.status = 'unavailable'; summary.event.references = 0; }
      }
    } else summary.unchecked.unshift('今回の取得結果から依存関係を解析していません');
    facts.push({ kind: 'dependency-coverage', confidence: 'NOT_ANALYZED',
      statement: summary.status === 'analyzed'
        ? '依存関係は、今回取得できた動作テスト環境の設定とJavaScript本文だけから調べたものです。確かさと未確認の範囲を確認してください。参照が見つからないことは、依存関係が無い証明ではありません。'
        : '今回の依存関係の解析結果は取得できていません。依存関係が無いとは判断せず、取得できた設定や本文と未確認の範囲を分けて説明してください。',
      value: summary });
    return { facts, analyzed: summary.status === 'analyzed' };
  }
  const selectedTarget = target => target ? ['field', 'event'].includes(target.type)
    ? { type: target.type, id: target.id, name: target.name, appId: target.appId, environment: target.environment, revision: target.revision }
    : { name: target.name, target: target.target, type: 'FILE', environment: 'preview', fileKey: target.fileKey, revision: target.revision } : null;
  const fileSubject = target => target ? { type: 'javascript', sourceId: target.target + ':js:' + target.name, name: target.name, target: target.target, customizationType: 'FILE', sourceAvailable: true } : null;
  function factsOf(base, dependencies = { facts: [] }, requestTargets = [], consultationTarget = null) {
    const data = base.data || {}, facts = [];
    const add = (kind, statement, value, extra = {}) => facts.push({ id: 'E' + (facts.length + 1), kind, confidence: 'CERTAIN', statement, value: clone(value), ...extra });
    add('environment', '動作テスト環境の設定です。レコードの内容は含みません。', { environment: base.env || null, revision: base.revision?.preview ?? null, loadedAt: base.loadedAt ?? null, app: appOf(base) });
    // The small `field` descriptor is for the typed dictionary; `value` retains
    // the complete source definition (formula, lookup mappings, defaults, etc.).
    const addFields = (properties, parent = null) => {
      for (const raw of entries(properties)) {
        const field = fieldsOf({ field: raw }, parent)[0];
        add('field', 'フィールド「' + field.label + '」の設定', raw, { field });
        if (raw.type === 'SUBTABLE') addFields(raw.fields, raw.code);
      }
    };
    addFields(data.fields);
    const labels = { status: 'プロセス管理', views: '一覧', generalNotify: 'アプリの条件通知', perRecordNotify: 'レコードの条件通知', reminderNotify: 'リマインダーの条件通知', actions: 'アプリアクション', layout: 'フォーム', reports: 'グラフ', settings: 'アプリの設定', appAcl: 'アプリのアクセス権', recordAcl: 'レコードのアクセス権', fieldAcl: 'フィールドのアクセス権', appPlugins: 'プラグイン', customize: 'JavaScript / CSS カスタマイズ' };
    for (const [key, value] of Object.entries(data)) {
      if (key === 'relatedApps' && Object.keys(value || {}).length) {
        add(key, '参照先アプリの定義は、別途取得した運用環境の情報です。対象アプリの動作テスト環境と同じ時点・同じ環境の情報ではありません。', value,
          { confidence: Object.values(value).some(app => app?.error) ? 'NOT_ANALYZED' : 'CERTAIN',
            provenance: { environment: 'production', loadedAt: base.relatedLoadedAt ?? null } });
      } else if (!['fields', 'appId', 'appName', 'name', 'plugins', 'relatedApps', 'adminNotes'].includes(key) && value != null) add(key, (labels[key] || key) + 'の現在の設定', value);
    }
    for (const file of base.files || []) {
      const available = sameFileEnvironment(file, base) && file.sourceAvailable !== false && typeof file.text === 'string';
      add('js-file', '登録済みファイル「' + file.name + '」', { id: file.fileKey || file.id, name: file.name, target: file.target, type: file.type, source: available ? file.text : null, sourceAvailable: available },
        { confidence: available ? 'CERTAIN' : 'NOT_ANALYZED' });
    }
    for (const fact of dependencies.facts) facts.push({ ...clone(fact), id: 'E' + (facts.length + 1) });
    if (['field', 'event'].includes(consultationTarget?.type)) add('consultation-target', '今回、利用者が変更の影響を相談するために選択した対象です。選択しただけでは変更の依頼や採用にはなりません。', selectedTarget(consultationTarget));
    if (requestTargets.some(request => request.target)) add('consultation-history', '相談を送ったときに利用者が選択していた対象です。各発言の対象を示す履歴であり、変更の採用や現在の設定・本文を示すものではありません。現在の設定と登録済みファイルの情報を参照してください。',
      requestTargets.map(request => ({ text: request.text, target: selectedTarget(request.target) })));
    if (facts.length > 500) throw Object.assign(new Error('アプリの設定が多いため、この会話では全体を確認できません。設定の一部を省略して変更案を作ることはできません。'), { code: 'CONTEXT_TOO_LARGE' });
    return facts;
  }
  const coverageOf = (base, dependencies) => ({ adminNotes: false, fields: true, dependencies: dependencies.analyzed, javascript: (base.files || []).every(f => sameFileEnvironment(f, base) && f.type === 'FILE' && f.sourceAvailable !== false && typeof f.text === 'string'), incoming: false, plugins: false, recordData: false });
  function dictionaryOf(base) {
    const fields = fieldsOf(base.data?.fields), data = base.data || {};
    return { fieldCodes: fields.map(f => f.code), fieldLabels: fields.map(f => f.label), fieldTypes: Object.fromEntries(fields.map(f => [f.code, f.type])),
      statuses: statusesOf(base), processActions: (data.status?.actions || []).map(a => a.name), views: Object.keys(data.views?.views || data.views || {}).filter(k => k !== 'revision'),
      appActions: Object.keys(data.actions?.actions || data.actions || {}).filter(k => k !== 'revision'), jsFiles: (base.files || []).map(f => f.name),
      notifications: [...(data.generalNotify?.notifications || []).map((_, i) => 'general#' + (i + 1)), ...(data.perRecordNotify?.notifications || []).flatMap((n, i) => ['perRecord#' + (i + 1), ...(n.title ? [n.title] : [])])],
      reminders: (data.reminderNotify?.notifications || []).flatMap((n, i) => ['reminder#' + (i + 1), ...(n.title ? [n.title] : [])]),
      reports: Object.keys(data.reports?.reports || data.reports || {}).filter(k => k !== 'revision') };
  }
  function proposal({ text, requestPurpose = 'consultation', consultationTarget = null, requestTargets = [], previous, questionIdFloor = 0, pendingPlanQuestions = [], answers = [], requests = [], discussion = [], originalRequestHistory = null, acceptedProposal = null, currentPlanSummary = null, currentResultSummary = null, base, environmentComparison = null }, dependencyTools = null) {
    const comparison = environmentComparison ? (typeof KTReleaseEnvironmentView !== 'undefined' ? KTReleaseEnvironmentView : require('./release-environment-view.js').KTReleaseEnvironmentView).context(base, environmentComparison) : null;
    const dependencies = comparison ? { facts: [] } : dependencyContext(base, dependencyTools, consultationTarget);
    const focus = consultationTarget ? { resolution: 'resolved', target: consultationTarget.type === 'FILE'
      ? { ...selectedTarget(consultationTarget), type: 'file', id: consultationTarget.target + ':js:' + consultationTarget.name }
      : selectedTarget(consultationTarget), candidates: [] } : { resolution: 'none', target: null, candidates: [] };
    return sizeCheck({ contextVersion: '1', releaseContract: 'release-workspace-1', requestPurpose, clientCapabilities: ['formLayoutPlacement', 'fieldMaintenance', 'appExplanation'], question: text, app: appOf(base),
      focus: comparison ? { resolution: 'resolved', target: { type: 'environment-diff', id: 'production->preview' }, candidates: [] } : focus, facts: comparison ? comparison.facts : factsOf(base, dependencies, requestTargets, consultationTarget), coverage: comparison ? comparison.coverage : coverageOf(base, dependencies), truncation: { applied: false, sections: [] },
      conversation: { mode: 'proposal', originalRequestHistory: clone(originalRequestHistory), discussion: clone(discussion), acceptedProposal: clone(acceptedProposal), currentPlanSummary, currentResultSummary, proposal: clone(previous), pendingPlanQuestions: clone(pendingPlanQuestions), decisions: clone(answers), requirements: [], working: null, userRequests: clone(requests),
        itemIdFloor: { Q: Math.max(0, questionIdFloor, ...answers.filter(a => /^Q[1-9][0-9]{0,2}$/.test(a.id)).map(a => Number(a.id.slice(1)))) } } }, 256 * 1024);
  }
  // Proposal answers retain Q identifiers. The planner/generator contract uses D
  // identifiers; derive that identifier only, never infer a topic from the answer.
  function planDecisions(answers) {
    return answers.map(a => {
      if (!/^Q[1-9][0-9]{0,2}$/.test(a.id)) throw Object.assign(new Error('回答した確認事項の識別子を引き継げません。'), { code: 'DECISION_ID_INVALID' });
      return { id: 'D' + a.id.slice(1), sourceQuestionId: a.id, topic: 'other', source: 'chat', status: 'answered', kind: 'question',
        label: a.label, answer: a.answer, ...(a.question ? { question: a.question } : {}), ...(a.kind === 'delegated' ? { delegated: true } : {}) };
    });
  }
  function plan({ proposal: accepted, consultationTarget = null, requestTargets = [], answers = [], goal, requests = [], version, base }, dependencyTools = null) {
    const dependencies = dependencyContext(base, dependencyTools, consultationTarget);
    return sizeCheck({ contextVersion: 'planner-1', releaseContract: 'release-workspace-1', clientCapabilities: ['formLayoutPlacement', 'fieldMaintenance'], goal, app: appOf(base), facts: factsOf(base, dependencies, requestTargets, consultationTarget), dictionary: dictionaryOf(base),
      coverage: coverageOf(base, dependencies), truncation: { applied: false, sections: [] }, decisions: planDecisions(answers), requirements: [], userRequests: clone(requests),
      ...(consultationTarget?.type === 'FILE' ? { subject: fileSubject(consultationTarget) } : {}),
      acceptedProposal: { revision: version, proposal: clone(accepted) } }, 384 * 1024);
  }
  function generator({ customization, plan, proposal: accepted, answers = [], requests = [], version, base }) {
    const c = clone(customization), allFields = fieldsOf(base.data?.fields), files = base.files || [], existingFiles = c.existingFiles || [];
    let existingFile = null;
    if (c.strategy === 'EXTEND_EXISTING_JS') {
      if (existingFiles.length !== 1) throw Object.assign(new Error('変更する既存のファイルを一つに特定できません。'), { code: 'FILE_TARGET_UNRESOLVED' });
      const ref = existingFiles[0], matches = files.filter(f => f.name === ref.name && f.target === ref.target && f.type === 'FILE');
      if (matches.length !== 1 || matches[0].sourceAvailable === false || !matches[0].text) throw Object.assign(new Error('変更する既存のファイルの本文を取得できません。'), { code: 'FILE_UNAVAILABLE' });
      const f = matches[0];
      existingFile = { id: f.fileKey || f.id, name: f.name, target: f.target, hash: f.hash, source: f.text };
    }
    // Planned names come from typed plan fields; no replacement inside natural-language strings.
    const proposed = (plan.proposedFields || []).map(p => ({ code: p.suggestedCode, label: p.label, type: p.type, temporaryId: p.temporaryId, proposed: true, ...(p.options ? { options: clone(p.options) } : {}) }));
    const map = new Map(proposed.map(p => [p.temporaryId, p.code]));
    c.fields = (c.fields || []).map(f => ({ ...f, code: map.get(f.code) || f.code }));
    const plannedFields = proposed.map(f => ({ code: f.code, label: f.label, type: f.type, stepId: (plan.steps || []).find(s => s.actionType === 'ADD_FIELD' && (s.targetRef === f.temporaryId || s.spec?.fieldCode === f.temporaryId || s.spec?.fieldCode === f.code))?.id || '' }));
    const plannedStatuses = (plan.steps || []).filter(s => s.actionType === 'ADD_PROCESS_STATUS').map(s => ({ name: s.spec?.name || s.spec?.status?.name, stepId: s.id })).filter(x => x.name);
    const removed = new Set((plan.steps || []).filter(s => s.actionType === 'DELETE_FIELD').map(s => s.targetRef));
    const fields = allFields.filter(f => !removed.has(f.code)).map(f => {
      const update = (plan.steps || []).find(s => s.actionType === 'UPDATE_FIELD' && s.targetRef === f.code)?.spec;
      return update?.optionEdits ? { ...f, options: update.optionEdits.items.map(i => i.label) } : f;
    }).concat(proposed), dictionary = dictionaryOf(base);
    dictionary.fieldCodes = fields.map(f => f.code); dictionary.fieldTypes = Object.fromEntries(fields.map(f => [f.code, f.type]));
    dictionary.statuses = [...new Set([...dictionary.statuses, ...plannedStatuses.map(s => s.name)])];
    const relatedFiles = files.filter(f => f.type === 'FILE' && f.sourceAvailable !== false && typeof f.text === 'string').map(f => ({ name: f.name, target: f.target, text: f.text }));
    const relatedOmitted = files.filter(f => f.type !== 'FILE' || f.sourceAvailable === false || typeof f.text !== 'string').map(f => ({ name: f.name, target: f.target, events: null, reason: f.type === 'URL' ? 'url' : 'unavailable' }));
    const requirementIds = (plan.requirements || []).map(r => ({ id: r.id, kind: r.kind, text: r.text }));
    const ctx = { contextVersion: 'customization-1', releaseContract: 'release-workspace-1', app: appOf(base), customization: c, fields, dictionary, existingFile,
      ...(accepted ? { acceptedProposal: { revision: version, assumptions: clone(accepted.assumptions || []), cannot: clone(accepted.cannot || []) } } : {}),
      otherFiles: relatedFiles.filter(f => f.name !== existingFile?.name || f.target !== existingFile?.target).map(f => ({ name: f.name, target: f.target, source: f.text })),
      plan: { planId: plan.planId || 'release-plan', version, goal: plan.goal, standardSteps: clone(plan.steps), otherCustomizations: (plan.customizations || []).filter(x => x.customizationId !== c.customizationId).map(x => ({ customizationId: x.customizationId, requirement: x.requirement, platform: x.platform })), userRequests: clone(requests) },
      decisions: planDecisions(answers), planned: { fields: plannedFields, statuses: plannedStatuses },
      verification: { requirementIds, relatedFiles, relatedOmitted, appFields: fields },
      constraints: { platform: c.platform, noNetwork: true, noSecrets: true, allowedEvents: c.events, allowedFields: dictionary.fieldCodes, allowedApis: c.apis, patchOnly: c.strategy === 'EXTEND_EXISTING_JS' } };
    // Fail visibly before sending an oversized request; do not silently remove dependencies.
    sizeCheck({ ...ctx, verification: { ...ctx.verification, relatedFiles: relatedFiles.map(f => ({ ...f, text: '' })) } }, 256 * 1024);
    return ctx;
  }
  return { proposal, plan, generator, factsOf, fieldsOf, dictionaryOf };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseContext };
