/* Raw application facts and explicitly accepted input. No text matching or code analysis. */
'use strict';
const KTReleaseContext = (() => {
  const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));
  const entries = x => Object.values(x || {});
  function fieldsOf(properties, parent = null) {
    return entries(properties).flatMap(f => [{ code: f.code, label: f.label || f.code, type: f.type,
      ...(parent ? { subtable: parent } : {}), ...(f.required != null ? { required: f.required } : {}),
      ...(f.options ? { options: Object.keys(f.options) } : {}), ...(f.type === 'SUBTABLE' ? { columns: Object.keys(f.fields || {}) } : {}) },
      ...(f.type === 'SUBTABLE' ? fieldsOf(f.fields, f.code) : [])]);
  }
  const appOf = base => ({ id: String(base.appId ?? base.data?.appId ?? ''), name: base.data?.appName || base.data?.name || null });
  const statusesOf = base => entries(base.data?.status?.states).map(x => x.name);
  function sizeCheck(ctx, limit) {
    if (new TextEncoder().encode(JSON.stringify(ctx)).length > limit) throw Object.assign(new Error('このアプリの設定は一度に送れる量を超えています。内容を省略して変更案を作ることはできません。'), { code: 'CONTEXT_TOO_LARGE' });
    return ctx;
  }
  function factsOf(base) {
    const data = base.data || {}, facts = [];
    const add = (kind, statement, value, extra = {}) => facts.push({ id: 'E' + (facts.length + 1), kind, confidence: 'CERTAIN', statement, value: clone(value), ...extra });
    add('environment', '動作テスト環境の設定です。レコードの内容は含みません。', { revision: base.revision, app: appOf(base) });
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
      if (!['fields', 'appId', 'appName', 'name'].includes(key) && value != null) add(key, (labels[key] || key) + 'の現在の設定', value);
    }
    for (const file of base.files || []) {
      const available = file.sourceAvailable !== false && typeof file.text === 'string';
      add('js-file', '登録済みファイル「' + file.name + '」', { id: file.fileKey || file.id, name: file.name, target: file.target, type: file.type, source: available ? file.text : null, sourceAvailable: available },
        { confidence: available ? 'CERTAIN' : 'NOT_ANALYZED' });
    }
    if (facts.length > 500) throw Object.assign(new Error('アプリの設定が多いため、この会話では全体を確認できません。設定の一部を省略して変更案を作ることはできません。'), { code: 'CONTEXT_TOO_LARGE' });
    return facts;
  }
  const coverageOf = base => ({ fields: true, dependencies: false, javascript: (base.files || []).every(f => f.sourceAvailable !== false), incoming: false, plugins: false, recordData: false });
  function dictionaryOf(base) {
    const fields = fieldsOf(base.data?.fields), data = base.data || {};
    return { fieldCodes: fields.map(f => f.code), fieldLabels: fields.map(f => f.label), fieldTypes: Object.fromEntries(fields.map(f => [f.code, f.type])),
      statuses: statusesOf(base), processActions: (data.status?.actions || []).map(a => a.name), views: Object.keys(data.views?.views || data.views || {}).filter(k => k !== 'revision'),
      appActions: Object.keys(data.actions?.actions || data.actions || {}).filter(k => k !== 'revision'), jsFiles: (base.files || []).map(f => f.name),
      notifications: [...(data.generalNotify?.notifications || []).map((_, i) => 'general#' + (i + 1)), ...(data.perRecordNotify?.notifications || []).flatMap((n, i) => ['perRecord#' + (i + 1), ...(n.title ? [n.title] : [])])],
      reminders: (data.reminderNotify?.notifications || []).flatMap((n, i) => ['reminder#' + (i + 1), ...(n.title ? [n.title] : [])]),
      reports: Object.keys(data.reports?.reports || data.reports || {}).filter(k => k !== 'revision') };
  }
  function proposal({ text, previous, pendingPlanQuestions = [], answers = [], requests = [], base }) {
    return sizeCheck({ contextVersion: '1', releaseContract: 'release-workspace-1', clientCapabilities: ['formLayoutPlacement', 'fieldMaintenance'], question: text, app: appOf(base),
      focus: { resolution: 'none', target: null, candidates: [] }, facts: factsOf(base), coverage: coverageOf(base), truncation: { applied: false, sections: [] },
      conversation: { mode: 'proposal', proposal: clone(previous), pendingPlanQuestions: clone(pendingPlanQuestions), decisions: clone(answers), requirements: [], working: null, userRequests: clone(requests),
        itemIdFloor: { Q: Math.max(0, ...answers.filter(a => /^Q[1-9][0-9]{0,2}$/.test(a.id)).map(a => Number(a.id.slice(1)))) } } }, 256 * 1024);
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
  function plan({ proposal: accepted, answers = [], goal, requests = [], version, base }) {
    return sizeCheck({ contextVersion: 'planner-1', releaseContract: 'release-workspace-1', clientCapabilities: ['formLayoutPlacement', 'fieldMaintenance'], goal, app: appOf(base), facts: factsOf(base), dictionary: dictionaryOf(base),
      coverage: coverageOf(base), truncation: { applied: false, sections: [] }, decisions: planDecisions(answers), requirements: [], userRequests: clone(requests),
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
