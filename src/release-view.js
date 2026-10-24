/* One working surface for consultation, change review, and execution results.
 * It displays service/execution results. It does not interpret requirement text.
 */
'use strict';

const KTReleaseView = (() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const textOf = value => typeof value === 'string' ? value : value?.message || value?.title || value?.text || value?.description || value?.label || value?.name || '';
  const bodyOf = result => {
    const generated = result?.generated || result || {};
    return generated.strategy === 'EXTEND_EXISTING_JS' ? generated.body : generated.code;
  };
  const list = (rows, className = '') => rows?.length ? `<ul class="${className}">${rows.map(row => `<li>${esc(textOf(row))}</li>`).join('')}</ul>` : '';
  const platformsOf = artifact => [...new Set((artifact?.result?.artifactOutcome?.operations || []).map(op => op.targetPlatform))].map(p => p === 'desktop' ? 'PC' : p === 'mobile' ? 'モバイル' : '').filter(Boolean).join('・');
  const busy = new Set(['consulting', 'building', 'preparing', 'applying', 'rolling-back']);
  const phaseText = { idle: '相談', consulting: '相談', proposal: '仮案の確認', building: '変更案の作成', preparing: '反映内容の確認', review: '変更内容の確認', incomplete: '作成途中', unchanged: '変更なし', blocked: '内容の確認', applying: '反映中', result: '反映結果', 'rollback-confirm': '戻す内容の確認', 'rolling-back': '元の状態へ戻しています' };
  const draftActions = new Set(['adopt', 'resume', 'apply', 'rollback']);
  const draftPending = options => !!String(options.draft || '').trim() || !!options.sending;
  const draftNotice = options => `<p class="ktr-note" data-release-draft-note${draftPending(options) ? '' : ' hidden'}>入力した内容を送信するか、消してから操作してください。</p>`;
  const button = (action, label, { primary = false, disabled = false, blockedByDraft = false, id = '', extra = '' } = {}) => `<button type="button" data-release-action="${action}"${id ? ` data-release-id="${esc(id)}"` : ''}${draftActions.has(action) ? ` data-release-base-disabled="${disabled}"` : ''} class="${primary ? 'ktr-primary' : 'ktr-secondary'}"${disabled || blockedByDraft ? ' disabled' : ''}${extra}>${esc(label)}</button>`;
  function connectionOf(options) { try { return (typeof options.connection === 'function' ? options.connection() : options.connection) || {}; } catch (_) { return { connected: false, message: '接続の状態を確認できません。' }; } }
  function factsHtml(messages) {
    return (messages || []).filter(m => m.role !== 'user' && Array.isArray(m.facts) && m.facts.length).map(m => `<details data-release-panel="facts-${esc(m.id)}"><summary>この返答の根拠</summary><ul>${m.facts.map((f, index) => `<li>${esc(f.text || f.statement || f.description || f.summary || f.title || '')}${f.value != null ? `<details data-release-panel="fact-value-${esc(m.id)}-${index}"><summary>設定の内容</summary><pre class="ktr-fact-value">${esc(typeof f.value === 'string' ? f.value : JSON.stringify(f.value, null, 2))}</pre></details>` : ''}</li>`).join('')}</ul><p class="ktr-note">この返答を作成したときの情報です。</p></details>`).join('');
  }
  function historyHtml(messages) {
    if (!messages?.length) return '<p class="ktr-empty-chat">変更したい動きと、今のまま残したいことを教えてください。</p>';
    return `<ol class="ktr-messages">${messages.map(m => `<li class="ktr-message ${m.role === 'user' ? 'ktr-user' : ''}"><span class="ktr-speaker">${m.role === 'user' ? 'あなた' : 'Toolkit'}</span><p>${esc(m.text)}</p>${m.role !== 'user' ? factsHtml([m]) : ''}</li>`).join('')}</ol>`;
  }
  function composer(state, options = {}) {
    const conn = connectionOf(options), disabled = busy.has(state.phase) || conn.connected === false || conn.available === false || !!options.historical;
    return `<form class="ktr-composer" data-release-form="consult"><label for="kt-release-input">変更したいこと、質問、修正内容</label><textarea id="kt-release-input" rows="2" placeholder="今の動きと、どう変えたいかを教えてください。"${disabled ? ' disabled' : ''}>${esc(options.draft || '')}</textarea><div class="ktr-compose-actions"><span class="ktr-note">${options.historical ? '過去の反映記録を表示中です。現在の作業に戻ると入力できます。' : 'Enterで送信・Shift＋Enterで改行'}</span>${button('send', '送信', { primary: true, disabled })}</div></form>`;
  }
  function proposalHtml(state, options) {
    const p = options.proposal || state.proposal || {}, answered = new Map((state.answers || []).filter(a => a.answer).map(a => [a.id, a.answer]));
    const pending = (p.decisions || []).filter(q => q.blocking && !q.answer && !answered.has(q.id));
    const latest = (state.messages || []).filter(m => m.role !== 'user').at(-1);
    const conn = connectionOf(options);
    return `<section class="ktr-section"><h2>${options.readOnly ? '参照中の案' : '仮案を確認してください'}</h2>${p.behaviors?.length ? list(p.behaviors) : latest?.text ? `<p class="ktr-lead">${esc(latest.text)}</p>` : ''}
      ${p.assumptions?.length ? `<h3>この案の前提</h3>${list(p.assumptions)}` : ''}${p.cannot?.length ? `<h3>この案の制約</h3>${list(p.cannot)}` : ''}
      ${(p.decisions || []).filter(q => !q.answer && !answered.has(q.id)).map(q => `<div class="ktr-question"><h3>${esc(q.question || q.label || '確認したいこと')}</h3>${!options.readOnly && q.options?.length ? `<div class="ktr-actions">${q.options.map(o => button('answer', textOf(o), { extra: ` data-release-answer="${esc(textOf(o))}"` })).join('')}</div>` : ''}${!options.readOnly && q.blocking ? '<p class="ktr-note">回答を送ってから、仮案を確かめてください。</p>' : ''}</div>`).join('')}
      ${state.answers?.length ? `<h3>決めたこと</h3>${list(state.answers.map(a => ({ text: [a.label, a.answer].filter(Boolean).join('：') })))}` : ''}
      ${options.readOnly ? '<p class="ktr-note">処理中のため、この案の採用や反映はできません。</p>' : `<div class="ktr-actions">${button('adopt', 'この案で作成', { primary: true, disabled: pending.length > 0 || conn.connected === false || conn.available === false || conn.canPlan === false, blockedByDraft: draftPending(options) })}</div>${draftNotice(options)}<p class="ktr-note">この操作では、kintoneの設定やJavaScriptは変更しません。</p>`}</section>`;
  }
  function codeHtml(state) {
    const artifacts = (state.artifacts || []).filter(a => typeof bodyOf(a.result) === 'string');
    if (!artifacts.length) return '';
    return `<details data-release-panel="code"><summary>JavaScriptを見る</summary>${artifacts.map(a => {
      const r = a.result, body = bodyOf(r), targetFile = r.generated?.targetFile || r.targetFile || 'customization.js';
      return `<article class="ktr-code"><h3>${esc(a.title || 'JavaScript')}</h3>${platformsOf(a) ? `<p class="ktr-note">${platformsOf(a)}</p>` : ''}<div class="ktr-actions">${button('copy-code', 'コードをコピー', { id: a.customizationId })}${button('download-code', 'ファイルで保存', { id: a.customizationId })}</div><pre><code>${esc(body)}</code></pre><p class="ktr-note">ファイル名: ${esc(targetFile)}</p></article>`;
    }).join('')}</details>`;
  }
  function verificationHtml(state) {
    const artifacts = state.artifacts || [];
    if (!artifacts.length) return '';
    const labels = { ready: '検証が完了しました。', incomplete: '作成が終わっていません', unverified: '必要な検証を完了できません', failed: '検証で不一致がありました' };
    return `<details data-release-panel="verification"><summary>確かめたこと</summary>${artifacts.map(a => {
      const outcome = a.result?.artifactOutcome;
      return `<h3>${esc(a.title || 'JavaScript')}</h3><p>${esc(outcome ? outcome.state === 'ready' ? outcome.message || labels.ready : labels[outcome.state] || '結果を確認できません' : '作成が終わっていません')}</p>${outcome?.message && outcome.state !== 'ready' ? `<p>${esc(outcome.message)}</p>` : ''}${a.error?.message ? `<p>${esc(a.error.message)}</p>` : ''}`;
    }).join('')}<p>kintoneの実際の画面での動作は、反映後に確かめます。</p></details>`;
  }
  function changesHtml(changes) {
    if (!changes?.length) return '';
    return `<ul class="ktr-changes">${changes.map((change, index) => {
      if (typeof change === 'string') return `<li>${esc(change)}</li>`;
      const title = textOf(change);
      if (change.kind === 'javascript') {
        const platform = { desktop: 'PC用', mobile: 'モバイル用' }[change.target];
        const operation = { ADD_FILE: '追加します', REPLACE_FILE: '置き換えます' }[change.operation] || '登録します';
        const detail = [platform, change.file ? `「${change.file}」を${operation}。` : 'JavaScriptを登録します。'].filter(Boolean).join('の');
        return `<li><strong>${esc(title)}</strong><p class="ktr-note">${esc(detail)}</p></li>`;
      }
      const values = [['変更前', change.before], ['変更後', change.after]].filter(([, value]) => value != null);
      return `<li><strong>${esc(title)}</strong>${change.description && change.description !== title ? `<p>${esc(change.description)}</p>` : ''}${values.length || change.technicalSummary ? `<details data-release-panel="change-${esc(change.id || index)}"><summary>設定の詳細（技術者向け）</summary>${change.technicalSummary ? `<p>${esc(change.technicalSummary)}</p>` : ''}${values.map(([label, value]) => `<h4>${label}</h4><pre class="ktr-setting-values">${esc(JSON.stringify(value, null, 2))}</pre>`).join('')}</details>` : ''}</li>`;
    }).join('')}</ul>`;
  }
  function reviewHtml(state, options) {
    const prep = state.prepared || {};
    return `<section class="ktr-section"><h2>今回反映する内容</h2>${changesHtml(prep.changes || [])}
      ${prep.unchanged?.length ? `<h3>変更しない内容</h3>${list(prep.unchanged.map(item => ({ text: [item.title, item.message].filter(Boolean).join('：') })))}` : ''}
      ${state.adopted?.assumptions?.length ? `<h3>この案の前提</h3>${list(state.adopted.assumptions)}` : ''}
      ${state.adopted?.cannot?.length ? `<h3>この案の制約</h3>${list(state.adopted.cannot)}` : ''}
      ${noticesHtml(state)}
      ${prep.confirmations?.length ? `<div class="ktr-confirmations"><h3>反映前に確認してください</h3>${list(prep.confirmations)}</div>` : ''}
      <p>反映先は動作テスト環境です。運用環境は変更しません。</p>
      ${(state.artifacts || []).length ? '<p class="ktr-note">作成したJavaScriptの検証は完了しています。実際の画面での動作は反映後に確かめます。</p>' : ''}
      <div class="ktr-actions">${button('apply', '動作テスト環境に反映', { primary: true, disabled: !prep.ok, blockedByDraft: draftPending(options) })}</div>${draftNotice(options)}</section>`;
  }
  // Display the service's existing explanation fields. These do not create blockers
  // or additional approval steps; only identical strings are deduplicated.
  function noticesHtml(state) {
    const seen = new Set((state.adopted?.cannot || []).concat(state.adopted?.assumptions || []).map(textOf));
    const notes = new Map(), customizations = state.plan?.customizations || [];
    const platformOf = c => (c.platform || []).map(p => ({ desktop: 'PC', mobile: 'モバイル' }[p] || p)).join('・');
    for (const c of customizations) {
      const a = (state.artifacts || []).find(item => item.customizationId === c.customizationId);
      const g = a?.result?.generated || a?.result || {};
      const platform = platformOf(c), sharedPlatform = customizations.filter(other => platformOf(other) === platform).length > 1;
      const source = [platform, sharedPlatform || !platform ? g.targetFile || c.requirement : ''].filter(Boolean).join('：') || 'JavaScript';
      for (const text of [...(c.risks || []), ...(g.assumptions || []), ...(g.warnings || [])].map(textOf).filter(text => text && !seen.has(text))) {
        if (!notes.has(text)) notes.set(text, new Set());
        notes.get(text).add(source);
      }
    }
    // Impact descriptions also contain change summaries. Keep their original text
    // available without repeating it as a warning or interpreting its meaning.
    const impact = (state.plan?.impact || []).map(item => typeof item === 'string' ? item : item.description || item.message || '').filter(Boolean);
    return `${notes.size ? `<section><h3>前提と注意点</h3><ul>${[...notes].map(([text, sources]) => `<li><span>${esc(text)}</span><p class="ktr-note">説明元：${esc([...sources].join('／'))}</p></li>`).join('')}</ul></section>` : ''}${impact.length ? `<details data-release-panel="plan-explanation"><summary>計画の説明を見る</summary>${list(impact)}</details>` : ''}`;
  }
  function declineHtml(artifacts) {
    return artifacts.filter(a => a.result?.error?.detail).map(a => {
      const detail = a.result.error.detail;
      const texts = [detail.summary, detail.reason, ...(detail.warnings || []), ...(detail.coverage || []).map(row => row.note)].map(textOf).filter(Boolean);
      return texts.length ? `<section><h3>作成できなかった理由（AIの説明）</h3>${list([...new Set(texts)])}</section>` : '';
    }).join('');
  }
  function incompleteHtml(state, options) {
    const artifacts = state.artifacts || [], all = state.plan?.customizations || [];
    const finished = artifacts.filter(a => a.result?.artifactOutcome?.state === 'ready');
    const unfinished = all.filter(c => !finished.some(a => a.customizationId === c.customizationId));
    const reasons = artifacts.filter(a => a.result?.artifactOutcome?.state !== 'ready').map(a => ({ message: a.result?.artifactOutcome?.message || a.error?.message || '作成が終わっていません。' }));
    return `<section class="ktr-section"><h2>作成途中です</h2><p>完成した内容は残っています。残りを作成してから、全体を確認します。</p>${finished.length ? `<h3>できた内容</h3>${list(finished)}` : ''}${unfinished.length ? `<h3>残っている内容</h3>${list(unfinished.map(c => ({ title: c.requirement || c.customizationId })))}` : ''}${list(reasons, 'ktr-reasons')}${declineHtml(artifacts)}<div class="ktr-actions">${button('resume', '残りを作成', { primary: true, disabled: !state.plan, blockedByDraft: draftPending(options) })}</div>${draftNotice(options)}</section>`;
  }
  function runHtml(run, options = {}, historical = false) {
    if (!run) return '<p>反映の記録はありません。</p>';
    const result = run.rollback || run.result || {}, status = result.status || run.status;
    const title = run.rollback ? status === 'complete' ? '反映前の状態に戻しました' : '元に戻した結果を確認してください' : ({ complete: '動作テスト環境に反映しました', partial: '一部だけ反映しました', failed: '反映できませんでした', unknown: '反映の結果を確認できません', running: '反映しています' }[status] || '反映結果');
    const canRestore = !!run.result?.written && run.rollback?.status !== 'complete';
    const rows = Array.isArray(result.rows) ? result.rows : [...(Array.isArray(result.settings) ? result.settings : []), ...(Array.isArray(result.files) ? result.files : [])];
    return `<section class="ktr-section"><h2>${esc(title)}</h2>${result.message ? `<p class="ktr-lead">${esc(result.message)}</p>` : ''}
      ${status === 'complete' && !run.rollback ? list(run.prepared?.changes || []) : ''}
      ${status !== 'complete' && rows.length ? `<h3>処理ごとの結果</h3>${list(rows.map(row => ({ message: [row.title || row.label || row.stepId || row.targetFile || row.name || '変更', row.message || ({ applied: '反映済み', verified: '確認済み', complete: '完了', failed: '未完了', skipped: '未実施', unknown: '結果を確認できません', PENDING: '未実施', APPLIED: '反映済み', FAILED: '未完了', VERIFIED: '確認済み' }[row.status] || '')].filter(Boolean).join('：') })))}` : ''}
      ${!run.rollback && status === 'complete' ? '<p>動作テスト環境を開き、変更した操作を確かめてください。</p>' : ''}
      ${status === 'unknown' ? '<p>同じ変更をもう一度反映せず、現在の設定を確認してください。</p>' : ''}
      <div class="ktr-actions">${historical ? button('current', '現在の作業に戻る', { primary: true }) : `${status === 'complete' && !run.rollback && typeof options.onOpenPreview === 'function' ? button('preview', '動作テスト環境を開く', { primary: true }) : ''}${button('new-task', '別の変更を相談する')}`}${canRestore ? button('request-rollback', 'この反映の変更を戻す', { id: run.id, disabled: !!options.operationBusy }) : ''}</div></section>`;
  }
  function rollbackHtml(state, options) {
    const rollback = state.rollback || {}, run = (state.runs || []).find(r => r.id === rollback.runId), prep = rollback.prepared || {};
    return `<section class="ktr-section"><h2>この反映の変更を戻します</h2><p>対象は動作テスト環境の次の変更です。運用環境は変更しません。</p>${list(run?.prepared?.changes || [])}${list(prep.reasons || [], 'ktr-reasons')}${prep.confirmations?.length ? `<div class="ktr-confirmations"><h3>戻す前に確認してください</h3>${list(prep.confirmations)}</div>` : ''}<div class="ktr-actions">${button('rollback', '反映前の状態に戻す', { primary: true, disabled: !prep.ok, blockedByDraft: draftPending(options), id: rollback.runId })}${button('cancel-rollback', '戻さずに閉じる')}</div>${draftNotice(options)}</section>`;
  }
  function render(state, options = {}) {
    const conn = connectionOf(options), last = (state.runs || []).at(-1), historical = options.selectedRunId ? (state.runs || []).find(r => r.id === options.selectedRunId) : null;
    const notice = options.notice || '';
    let body = '';
    if (historical) body = runHtml(historical, { ...options, operationBusy: busy.has(state.phase) }, true);
    else if (busy.has(state.phase)) body = `<section class="ktr-section ktr-progress" aria-live="polite"><h2>${esc(phaseText[state.phase])}</h2><p role="status">${esc(state.progress || (state.phase === 'consulting' ? '返答を作成しています。' : '処理を進めています。'))}</p>${['consulting', 'building', 'preparing'].includes(state.phase) ? button('cancel', '中断する') : '<p class="ktr-note">処理が終わるまで、この画面を開いたままにしてください。</p>'}</section>${state.adopted || state.proposal ? proposalHtml(state, { ...options, readOnly: true, proposal: state.adopted || state.proposal }) : ''}`;
    else if (state.phase === 'proposal') body = proposalHtml(state, options);
    else if (state.phase === 'review') body = reviewHtml(state, options);
    else if (state.phase === 'incomplete') body = incompleteHtml(state, options);
    else if (state.phase === 'unchanged') body = `<section class="ktr-section"><h2>反映する変更はありません</h2><p>確認した範囲は、現在の内容で実現しています。設定やJavaScriptの登録は行いません。</p>${list(state.adopted?.behaviors || [])}<div class="ktr-actions">${button('new-task', '別の変更を相談する', { primary: true })}</div></section>`;
    else if (state.phase === 'blocked') body = `<section class="ktr-section"><h2>内容を確認してください</h2>${list(state.prepared?.reasons || [], 'ktr-reasons')}${state.error?.code === 'PLAN_QUESTION' ? list((state.plan?.questions || []).map(question => ({ text: typeof question === 'string' ? question : question.question || textOf(question) }))) : ''}<p>現在の内容は反映していません。変更や回答は相談欄に入力してください。</p></section>`;
    else if (state.phase === 'result') body = runHtml((state.runs || []).find(run => run.id === state.resultRunId) || last, options);
    else if (state.phase === 'rollback-confirm') body = rollbackHtml(state, options);
    else body = '<section class="ktr-section"><h2>変更案</h2><p class="ktr-note">相談すると、ここに案を表示します。内容を確認してから動作テスト環境に反映します。</p></section>';
    const support = historical ? '' : `${codeHtml(state)}${verificationHtml(state)}`;
    const runHistory = state.runs?.length ? `<details data-release-panel="runs"><summary>これまでの反映</summary><ul>${state.runs.map((run, index) => `<li>${button('history', run.goal || `反映 ${index + 1}`, { id: run.id })} <span>${esc(run.rollback?.status === 'complete' ? '元に戻し済み' : ({ complete: '反映済み', partial: '一部反映', failed: '未完了', unknown: '結果未確認' }[run.status] || '処理中'))}</span></li>`).join('')}</ul></details>` : '';
    return `<div class="ktr-workspace" data-release-phase="${esc(state.phase)}"><style>${styles}</style><div class="ktr-content"><header class="ktr-header"><div><strong>${esc(options.appName || 'アプリの変更')}</strong><span class="ktr-environment">動作テスト環境</span></div><div class="ktr-header-tools"><span class="ktr-phase">${esc(historical ? '過去の反映記録' : phaseText[state.phase] || '相談')}</span><nav class="ktr-tools" aria-label="補助操作">${button('connect', '接続')}${button('free-context', '資料を作成')}${button('details', 'アプリの情報を見る')}</nav></div></header>
      ${conn.connected === false || conn.available === false ? `<aside class="ktr-notice"><p>${esc(conn.message || 'AIサービスへ接続してください。')}</p>${button('connect', '接続する')}</aside>` : ''}
      ${notice ? `<p class="ktr-notice" role="status">${esc(notice)}</p>` : ''}${state.error?.message && !historical && !(state.phase === 'incomplete' && (state.artifacts || []).some(a => a.error?.message === state.error.message || a.result?.artifactOutcome?.message === state.error.message)) ? `<p class="ktr-error" role="alert">${esc(state.error.message)}</p>` : ''}
      <div class="ktr-layout"><section class="ktr-conversation" aria-label="相談"><h2 class="ktr-pane-title">相談</h2><div class="ktr-chat-log" data-release-panel="conversation" tabindex="0" aria-label="相談の記録">${historyHtml(state.messages)}</div>${composer(state, { ...options, historical: !!historical })}</section><main class="ktr-current" aria-label="変更案と反映結果">${body}${support || runHistory ? `<div class="ktr-support">${support}${runHistory}</div>` : ''}</main></div></div></div>`;
  }
  function create(host, options = {}) {
    if (!host || !options.controller) throw new Error('作業面を表示するための情報がありません。');
    const controller = options.controller;
    let draft = '', selectedRunId = null, notice = '', disposed = false, sending = false;
    const expanded = new Set();
    let previousPhase = controller.getState().phase, previousRunId = null, previousMessageCount = 0;
    function draw(state = controller.getState()) {
      if (disposed) return;
      const input = host.querySelector?.('#kt-release-input'), focused = !!input && host.ownerDocument?.activeElement === input;
      if (input) draft = input.value;
      const selection = focused ? [input.selectionStart, input.selectionEnd] : null;
      const log = host.querySelector?.('.ktr-chat-log'), current = host.querySelector?.('.ktr-current'), layoutTop = host.querySelector?.('.ktr-layout')?.scrollTop || 0;
      const logTop = log?.scrollTop || 0, followMessages = !log || log.scrollHeight - log.clientHeight - logTop < 24;
      const currentTop = previousPhase === state.phase && previousRunId === selectedRunId ? current?.scrollTop || 0 : 0;
      host.innerHTML = render(state, { ...options, draft, sending, selectedRunId, notice });
      host.querySelectorAll?.('details[data-release-panel]').forEach(el => { if (expanded.has(el.dataset.releasePanel)) el.open = true; });
      const nextInput = host.querySelector?.('#kt-release-input');
      if (nextInput) nextInput.value = draft;
      if (focused && nextInput && !nextInput.disabled) { nextInput.focus({ preventScroll: true }); if (selection && typeof nextInput.setSelectionRange === 'function') nextInput.setSelectionRange(...selection); }
      const nextLog = host.querySelector?.('.ktr-chat-log'), nextCurrent = host.querySelector?.('.ktr-current');
      if (nextLog) nextLog.scrollTop = followMessages && state.messages?.length !== previousMessageCount ? nextLog.scrollHeight : logTop;
      if (nextCurrent) nextCurrent.scrollTop = currentTop;
      const nextLayout = host.querySelector?.('.ktr-layout'); if (nextLayout) nextLayout.scrollTop = layoutTop;
      previousPhase = state.phase; previousRunId = selectedRunId; previousMessageCount = state.messages?.length || 0;
    }
    function updateDraftGuard() {
      const pending = draftPending({ draft, sending });
      host.querySelectorAll?.('[data-release-base-disabled]').forEach(el => { el.disabled = el.dataset.releaseBaseDisabled === 'true' || pending; });
      host.querySelectorAll?.('[data-release-draft-note]').forEach(el => { el.hidden = !pending; });
    }
    function inputChanged(event) { if (event.target?.id === 'kt-release-input') { draft = event.target.value; updateDraftGuard(); } }
    async function send() {
      const state = controller.getState(), conn = connectionOf(options);
      if (sending || busy.has(state.phase) || state.runs?.some(run => run.id === selectedRunId) || conn.connected === false || conn.available === false) return;
      const input = host.querySelector?.('#kt-release-input');
      const value = String(input?.value ?? draft).trim();
      if (!value) return;
      sending = true; updateDraftGuard();
      try {
        if (typeof options.beforeSend === 'function' && await options.beforeSend() === false) return;
        if (busy.has(controller.getState().phase)) return;
        draft = ''; const activeInput = host.querySelector?.('#kt-release-input'); if (activeInput) activeInput.value = ''; selectedRunId = null; notice = '';
        await controller.send(value);
      } finally { sending = false; updateDraftGuard(); }
    }
    async function act(action, id, target = {}) {
      const state = controller.getState();
      if (draftActions.has(action) && draftPending({ draft: host.querySelector?.('#kt-release-input')?.value ?? draft, sending })) return;
      if (action === 'send') return send();
      if (action === 'current') { selectedRunId = null; notice = ''; draw(); return; }
      if (action === 'history') { selectedRunId = id; draw(); return; }
      if (action === 'answer') { draft = target.dataset?.releaseAnswer || ''; const input = host.querySelector?.('#kt-release-input'); if (input) { input.value = draft; input.focus?.(); } updateDraftGuard(); return; }
      if (action === 'new-task') { draft = ''; const input = host.querySelector?.('#kt-release-input'); if (input) input.value = ''; selectedRunId = null; notice = ''; return controller.newTask(); }
      if (action === 'cancel-rollback') return controller.cancelRollback();
      if (action === 'request-rollback') { selectedRunId = null; return controller.requestRollback(id); }
      if (action === 'rollback') return controller.rollback(id);
      if (['adopt', 'resume', 'apply', 'cancel'].includes(action)) { notice = ''; return controller[action](); }
      if (action === 'copy-code' || action === 'download-code') {
        const artifact = state.artifacts.find(a => a.customizationId === id), result = artifact?.result;
        const body = bodyOf(result);
        if (typeof body !== 'string') return;
        if (action === 'copy-code') { if (typeof options.onCopy !== 'function') { notice = 'コードを選択してコピーしてください。'; draw(); return; } await options.onCopy(body); notice = 'コードをコピーしました。'; }
        else { if (typeof options.onDownload !== 'function') return; await options.onDownload(result.generated?.targetFile || result.targetFile || 'customization.js', body); notice = 'ファイルを保存しました。'; }
        draw(); return;
      }
      const handlers = { connect: options.onConnect, 'refresh-connection': options.onRefreshConnection, 'free-context': options.onFreeContext, details: options.onDetails, preview: options.onOpenPreview };
      if (typeof handlers[action] === 'function') { await handlers[action](); draw(); }
    }
    async function clicked(event) {
      const target = event.target?.closest?.('[data-release-action]') || (event.target?.dataset?.releaseAction ? event.target : null);
      if (!target || target.disabled) return;
      event.preventDefault?.();
      try { await act(target.dataset.releaseAction, target.dataset.releaseId, target); } catch (error) { notice = error?.message || '操作を完了できませんでした。'; draw(); }
    }
    function keydown(event) { if (event.target?.id === 'kt-release-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault?.(); send().catch(error => { notice = error.message; draw(); }); } }
    function toggled(event) { const key = event.target?.dataset?.releasePanel; if (key) { if (event.target.open) expanded.add(key); else expanded.delete(key); } }
    host.addEventListener('click', clicked);
    host.addEventListener('input', inputChanged);
    host.addEventListener('keydown', keydown);
    host.addEventListener('toggle', toggled, true);
    const unsubscribe = controller.subscribe(draw);
    draw();
    return { render: draw, onVisible() { draw(); }, dispose() { disposed = true; unsubscribe(); host.removeEventListener?.('click', clicked); host.removeEventListener?.('input', inputChanged); host.removeEventListener?.('keydown', keydown); host.removeEventListener?.('toggle', toggled, true); } };
  }
  const styles = `
    .ktr-workspace,.kt-release-dialog{--ktr-text:#202b3d;--ktr-muted:#536176;--ktr-line:#d9e1eb;--ktr-paper:#fff;--ktr-soft:#f5f7fa;--ktr-accent:#215bb8;color:var(--ktr-text);background:var(--ktr-paper);font:14px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;box-sizing:border-box;overflow-wrap:anywhere}
    .ktr-workspace{flex:0 0 auto;width:100%;height:100%;max-width:none;min-width:0;min-height:0;margin:0;padding:clamp(14px,1.5%,20px);overflow:hidden;container:ktr-workspace / inline-size}.ktr-content{display:flex;flex-direction:column;width:100%;height:100%;max-width:none;min-width:0;min-height:0;margin:0 auto}.ktr-content>.ktr-notice,.ktr-content>.ktr-error,.ktr-header{flex:none}.ktr-layout{flex:1;min-height:0;min-width:0;overflow:auto}.ktr-conversation,.ktr-current{min-width:0;min-height:0}.ktr-conversation{display:flex;flex-direction:column}.ktr-workspace .ktr-pane-title{font-size:18px;margin:0 0 12px;flex:none}.ktr-chat-log{flex:1 1 auto;min-height:180px;max-height:42dvh;overflow:auto;scrollbar-gutter:stable}.ktr-current{border-top:1px solid var(--ktr-line);padding-top:24px;margin-top:24px;scrollbar-gutter:stable}.ktr-empty-chat{color:var(--ktr-muted)}.ktr-header-tools{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap}.ktr-tools{display:flex;gap:6px;flex-wrap:wrap}.ktr-workspace .ktr-tools button{font-size:12px;padding:6px 10px}
    .ktr-workspace *,.kt-release-dialog *{box-sizing:border-box}.ktr-workspace h2,.kt-release-dialog h2{font-size:22px;line-height:1.4;margin:0 0 16px}.ktr-workspace h3,.kt-release-dialog h3{font-size:15px;margin:20px 0 8px}.ktr-workspace p,.kt-release-dialog p{margin:8px 0 14px;white-space:pre-wrap}.ktr-workspace ul,.ktr-workspace ol{margin:8px 0 18px;padding-left:24px}.ktr-workspace li{margin:7px 0}
    .ktr-header{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--ktr-line);padding-bottom:10px;margin-bottom:14px}.ktr-header strong{font-size:16px}.ktr-environment{display:block;font-size:12px;color:var(--ktr-muted)}.ktr-phase{font-size:12px;color:var(--ktr-muted);white-space:nowrap;padding:3px 8px;background:var(--ktr-soft);border-radius:5px}.ktr-section{padding-bottom:12px}.ktr-lead{font-size:15px}.ktr-note{font-size:12px;color:var(--ktr-muted)}
    .ktr-actions,.ktr-compose-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:20px 0 8px}.ktr-compose-actions{justify-content:space-between}.ktr-workspace button,.kt-release-dialog button{font:inherit;line-height:1.4;padding:9px 14px;border:1px solid var(--ktr-line);border-radius:6px;cursor:pointer;background:var(--ktr-paper);color:var(--ktr-text);max-width:100%;overflow-wrap:anywhere}.ktr-workspace button.ktr-primary,.kt-release-dialog button.ktr-primary{color:#fff;background:var(--ktr-accent);border-color:var(--ktr-accent);font-weight:600}.ktr-workspace button:disabled,.kt-release-dialog button:disabled{opacity:.5;cursor:default}.ktr-workspace button:focus-visible,.ktr-workspace textarea:focus-visible,.ktr-workspace summary:focus-visible,.kt-release-dialog :is(button,textarea,select,summary):focus-visible{outline:3px solid #83b6fb;outline-offset:3px}
    .ktr-composer{flex:none;margin:12px 0 0;padding:10px;border:1px solid #aebccf;border-radius:12px;background:var(--ktr-paper)}.ktr-composer label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.ktr-composer textarea{display:block;width:100%;min-height:64px;max-height:120px;resize:vertical;padding:6px;font:inherit;border:0;border-radius:5px;color:var(--ktr-text);background:var(--ktr-paper)}.ktr-composer .ktr-compose-actions{margin:6px 0 0;gap:6px}.ktr-composer .ktr-compose-actions button{padding:7px 14px}.ktr-confirmations,.ktr-question,.ktr-notice{padding:14px 16px;border:1px solid var(--ktr-line);border-radius:7px;background:var(--ktr-soft);margin:16px 0}.ktr-confirmations h3,.ktr-question h3{margin-top:0}.ktr-error{padding:12px 16px;border-left:3px solid #b74826;background:#fff2e9;color:#783418}.ktr-reasons{color:#783418}.ktr-progress{padding:0 0 24px}
    .ktr-support{border-top:1px solid var(--ktr-line);margin-top:22px;padding-top:10px}.ktr-workspace .ktr-support-heading{display:none;font-size:15px;margin:0 0 12px;color:var(--ktr-muted)}.ktr-workspace details,.kt-release-dialog details{margin:8px 0}.ktr-workspace summary,.kt-release-dialog summary{cursor:pointer;padding:9px 0;color:var(--ktr-muted)}.ktr-workspace details[open]>summary,.kt-release-dialog details[open]>summary{font-weight:600;color:var(--ktr-text)}.ktr-workspace .ktr-messages{list-style:none;padding:0 8px 0 0;margin:0;display:flex;flex-direction:column;gap:20px}.ktr-workspace .ktr-message{max-width:94%;margin:0;padding:10px 12px;align-self:flex-start}.ktr-workspace .ktr-message.ktr-user{align-self:flex-end;padding:12px 16px;background:#eef4fd;border-radius:14px 14px 4px 14px}.ktr-message p{margin:6px 0 0;line-height:1.75}.ktr-speaker{font-size:12px;font-weight:600;color:var(--ktr-muted)}.ktr-code{padding:12px 0 20px}.ktr-code pre,.ktr-setting-values,.ktr-fact-value{white-space:pre-wrap;word-break:break-word;font:12px/1.6 ui-monospace,monospace;background:var(--ktr-soft);border:1px solid var(--ktr-line);border-radius:6px;padding:14px}
    .kt-release-dialog{width:min(640px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);padding:24px;margin:auto;border:1px solid var(--ktr-line);border-radius:10px;overflow:auto;overscroll-behavior:contain}.kt-release-dialog.ktr-dialog-wide{width:min(960px,calc(100vw - 32px))}.kt-release-dialog::backdrop{background:rgba(15,23,42,.38)}.ktr-dialog-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}.kt-release-dialog .ktr-dialog-header h2{font-size:20px;margin:0}.kt-release-dialog [data-close]{flex:none;white-space:nowrap}.kt-release-dialog :is(textarea,select){font:inherit;max-width:100%;min-width:0;padding:9px 10px;border:1px solid #aebccf;border-radius:6px;color:var(--ktr-text);background:var(--ktr-paper)}.kt-release-dialog textarea{width:100%}.kt-release-dialog pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}
    @container ktr-workspace (min-width:960px){.ktr-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.08fr);grid-template-rows:minmax(0,1fr);gap:24px;overflow:hidden}.ktr-chat-log{min-height:0;max-height:none;overscroll-behavior:contain}.ktr-conversation{overflow:hidden}.ktr-current{border-top:0;border-left:1px solid var(--ktr-line);padding:0 8px 0 24px;margin:0;overflow:auto}}
    @media(max-width:560px){.ktr-workspace{padding:14px}.ktr-header{gap:8px;align-items:flex-start;flex-direction:column}.ktr-header-tools{justify-content:flex-start;gap:8px}.ktr-workspace h2{font-size:19px}.ktr-actions .ktr-primary{width:100%}.ktr-compose-actions{align-items:flex-end}.ktr-phase{white-space:normal;text-align:right}.kt-release-dialog{padding:16px}.ktr-dialog-header{gap:8px}.kt-release-dialog .ktr-dialog-header h2{font-size:18px}.kt-release-dialog label{display:block;margin:8px 0}.kt-release-dialog label>select{display:block;width:100%;margin-top:4px}}
  `;
  return { create, render, escape: esc };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseView };
