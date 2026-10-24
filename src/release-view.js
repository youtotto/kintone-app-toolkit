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
  const button = (action, label, { primary = false, disabled = false, id = '', extra = '' } = {}) => `<button type="button" data-release-action="${action}"${id ? ` data-release-id="${esc(id)}"` : ''} class="${primary ? 'ktr-primary' : 'ktr-secondary'}"${disabled ? ' disabled' : ''}${extra}>${esc(label)}</button>`;
  function connectionOf(options) { try { return (typeof options.connection === 'function' ? options.connection() : options.connection) || {}; } catch (_) { return { connected: false, message: '接続の状態を確認できません。' }; } }
  function factsHtml(messages) {
    return (messages || []).filter(m => m.role !== 'user' && Array.isArray(m.facts) && m.facts.length).map(m => `<details data-release-panel="facts-${esc(m.id)}"><summary>この返答の根拠</summary><ul>${m.facts.map((f, index) => `<li>${esc(f.text || f.statement || f.description || f.summary || f.title || '')}${f.value != null ? `<details data-release-panel="fact-value-${esc(m.id)}-${index}"><summary>設定の内容</summary><pre class="ktr-fact-value">${esc(typeof f.value === 'string' ? f.value : JSON.stringify(f.value, null, 2))}</pre></details>` : ''}</li>`).join('')}</ul><p class="ktr-note">この返答を作成したときの情報です。</p></details>`).join('');
  }
  function historyHtml(messages, open = false) {
    if (!messages?.length) return '';
    return `<details data-release-panel="conversation"${open ? ' open' : ''}><summary>相談の記録</summary><ol class="ktr-messages">${messages.map(m => `<li class="ktr-message ${m.role === 'user' ? 'ktr-user' : ''}"><span class="ktr-speaker">${m.role === 'user' ? 'あなた' : 'Toolkit'}</span><p>${esc(m.text)}</p>${m.role !== 'user' ? factsHtml([m]) : ''}</li>`).join('')}</ol></details>`;
  }
  function composer(state, options = {}) {
    const conn = connectionOf(options), disabled = busy.has(state.phase) || conn.connected === false || conn.available === false;
    return `<form class="ktr-composer" data-release-form="consult"><label for="kt-release-input">変更したいこと、質問、修正内容</label><textarea id="kt-release-input" rows="3" placeholder="今の動きと、どう変えたいかを教えてください。"${disabled ? ' disabled' : ''}>${esc(options.draft || '')}</textarea><div class="ktr-compose-actions"><span class="ktr-note">Enterで送信・Shift＋Enterで改行</span>${button('send', '送信', { primary: state.phase !== 'proposal' || !!options.consult, disabled })}</div></form>`;
  }
  function proposalHtml(state, options) {
    const p = state.proposal || {}, answered = new Map((state.answers || []).filter(a => a.answer).map(a => [a.id, a.answer]));
    const pending = (p.decisions || []).filter(q => q.blocking && !q.answer && !answered.has(q.id));
    const latest = (state.messages || []).filter(m => m.role !== 'user').at(-1);
    const conn = connectionOf(options);
    return `<section class="ktr-section"><h2>仮案を確認してください</h2>${p.behaviors?.length ? list(p.behaviors) : latest?.text ? `<p class="ktr-lead">${esc(latest.text)}</p>` : ''}
      ${p.assumptions?.length ? `<h3>この案の前提</h3>${list(p.assumptions)}` : ''}${p.cannot?.length ? `<h3>この案の制約</h3>${list(p.cannot)}` : ''}
      ${(p.decisions || []).filter(q => !q.answer && !answered.has(q.id)).map(q => `<div class="ktr-question"><h3>${esc(q.question || q.label || '確認したいこと')}</h3>${q.options?.length ? `<div class="ktr-actions">${q.options.map(o => button('answer', textOf(o), { extra: ` data-release-answer="${esc(textOf(o))}"` })).join('')}</div>` : ''}${q.blocking ? '<p class="ktr-note">回答を送ってから、仮案を確かめてください。</p>' : ''}</div>`).join('')}
      ${state.answers?.length ? `<h3>決めたこと</h3>${list(state.answers.map(a => ({ text: [a.label, a.answer].filter(Boolean).join('：') })))}` : ''}
      ${factsHtml(latest ? [latest] : [])}<div class="ktr-actions">${button('adopt', 'この案で作成', { primary: true, disabled: pending.length > 0 || conn.connected === false || conn.available === false || conn.canPlan === false })}</div>
      <p class="ktr-note">この操作では、kintoneの設定やJavaScriptは変更しません。</p></section>`;
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
  function reviewHtml(state) {
    const prep = state.prepared || {};
    return `<section class="ktr-section"><h2>今回反映する内容</h2>${changesHtml(prep.changes || [])}
      ${prep.unchanged?.length ? `<h3>変更しない内容</h3>${list(prep.unchanged.map(item => ({ text: [item.title, item.message].filter(Boolean).join('：') })))}` : ''}
      ${state.adopted?.assumptions?.length ? `<h3>この案の前提</h3>${list(state.adopted.assumptions)}` : ''}
      ${state.adopted?.cannot?.length ? `<h3>この案の制約</h3>${list(state.adopted.cannot)}` : ''}
      ${noticesHtml(state)}
      ${prep.confirmations?.length ? `<div class="ktr-confirmations"><h3>反映前に確認してください</h3>${list(prep.confirmations)}</div>` : ''}
      <p>反映先は動作テスト環境です。運用環境は変更しません。</p>
      ${(state.artifacts || []).length ? '<p class="ktr-note">作成したJavaScriptの検証は完了しています。実際の画面での動作は反映後に確かめます。</p>' : ''}
      <div class="ktr-actions">${button('apply', '動作テスト環境に反映', { primary: true, disabled: !prep.ok })}${button('consult', '内容を相談する')}</div></section>`;
  }
  // Display the service's existing explanation fields. These do not create blockers
  // or additional approval steps; only identical strings are deduplicated.
  function noticesHtml(state) {
    const seen = new Set((state.adopted?.cannot || []).concat(state.adopted?.assumptions || []).map(textOf));
    const groups = [];
    const add = (title, rows) => {
      const texts = rows.map(textOf).filter(text => text && !seen.has(text) && seen.add(text));
      if (texts.length) groups.push(`<div>${title ? `<h4>${esc(title)}</h4>` : ''}${list(texts)}</div>`);
    };
    add('', (state.plan?.impact || []).map(item => typeof item === 'string' ? item : item.description || item.message || ''));
    for (const c of state.plan?.customizations || []) {
      const a = (state.artifacts || []).find(item => item.customizationId === c.customizationId);
      const g = a?.result?.generated || a?.result || {};
      add(c.requirement || '', [...(c.risks || []), ...(g.assumptions || []), ...(g.warnings || [])]);
    }
    return groups.length ? `<section><h3>作成時の補足</h3><p class="ktr-note">AIが説明した前提と注意点です。</p>${groups.join('')}</section>` : '';
  }
  function declineHtml(artifacts) {
    return artifacts.filter(a => a.result?.error?.detail).map(a => {
      const detail = a.result.error.detail;
      const texts = [detail.summary, detail.reason, ...(detail.warnings || []), ...(detail.coverage || []).map(row => row.note)].map(textOf).filter(Boolean);
      return texts.length ? `<section><h3>作成できなかった理由（AIの説明）</h3>${list([...new Set(texts)])}</section>` : '';
    }).join('');
  }
  function incompleteHtml(state) {
    const artifacts = state.artifacts || [], all = state.plan?.customizations || [];
    const finished = artifacts.filter(a => a.result?.artifactOutcome?.state === 'ready');
    const unfinished = all.filter(c => !finished.some(a => a.customizationId === c.customizationId));
    const reasons = artifacts.filter(a => a.result?.artifactOutcome?.state !== 'ready').map(a => ({ message: a.result?.artifactOutcome?.message || a.error?.message || '作成が終わっていません。' }));
    return `<section class="ktr-section"><h2>作成途中です</h2><p>完成した内容は残っています。残りを作成してから、全体を確認します。</p>${finished.length ? `<h3>できた内容</h3>${list(finished)}` : ''}${unfinished.length ? `<h3>残っている内容</h3>${list(unfinished.map(c => ({ title: c.requirement || c.customizationId })))}` : ''}${list(reasons, 'ktr-reasons')}${declineHtml(artifacts)}<div class="ktr-actions">${button('resume', '残りを作成', { primary: true, disabled: !state.plan })}${button('consult', '内容を相談する')}</div></section>`;
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
  function rollbackHtml(state) {
    const rollback = state.rollback || {}, run = (state.runs || []).find(r => r.id === rollback.runId), prep = rollback.prepared || {};
    return `<section class="ktr-section"><h2>この反映の変更を戻します</h2><p>対象は動作テスト環境の次の変更です。運用環境は変更しません。</p>${list(run?.prepared?.changes || [])}${list(prep.reasons || [], 'ktr-reasons')}${prep.confirmations?.length ? `<div class="ktr-confirmations"><h3>戻す前に確認してください</h3>${list(prep.confirmations)}</div>` : ''}<div class="ktr-actions">${button('rollback', '反映前の状態に戻す', { primary: true, disabled: !prep.ok, id: rollback.runId })}${button('cancel-rollback', '戻さずに閉じる')}</div></section>`;
  }
  function render(state, options = {}) {
    const conn = connectionOf(options), last = (state.runs || []).at(-1), historical = options.selectedRunId ? (state.runs || []).find(r => r.id === options.selectedRunId) : null;
    const consulting = options.consult && !busy.has(state.phase), notice = options.notice || '';
    let body = '';
    if (historical) body = runHtml(historical, { ...options, operationBusy: busy.has(state.phase) }, true);
    else if (consulting) body = `<section class="ktr-section"><h2>内容を相談する</h2>${button('current', '変更内容の確認に戻る')}</section>${historyHtml(state.messages, true)}${composer(state, options)}`;
    else if (busy.has(state.phase)) body = `<section class="ktr-section ktr-progress" aria-live="polite"><h2>${esc(phaseText[state.phase])}</h2><p role="status">${esc(state.progress || (state.phase === 'consulting' ? '返答を作成しています。' : '処理を進めています。'))}</p>${['consulting', 'building', 'preparing'].includes(state.phase) ? button('cancel', '中断する') : '<p class="ktr-note">処理が終わるまで、この画面を開いたままにしてください。</p>'}</section>`;
    else if (state.phase === 'proposal') body = proposalHtml(state, options) + composer(state, options);
    else if (state.phase === 'review') body = reviewHtml(state);
    else if (state.phase === 'incomplete') body = incompleteHtml(state);
    else if (state.phase === 'unchanged') body = `<section class="ktr-section"><h2>反映する変更はありません</h2><p>確認した範囲は、現在の内容で実現しています。設定やJavaScriptの登録は行いません。</p>${list(state.adopted?.behaviors || [])}<div class="ktr-actions">${button('consult', '内容を相談する')}${button('new-task', '別の変更を相談する', { primary: true })}</div></section>`;
    else if (state.phase === 'blocked') body = `<section class="ktr-section"><h2>内容を確認してください</h2>${list(state.prepared?.reasons || [], 'ktr-reasons')}${state.error?.code === 'PLAN_QUESTION' ? list((state.plan?.questions || []).map(question => ({ text: typeof question === 'string' ? question : question.question || textOf(question) }))) : ''}<p>現在の内容は反映していません。</p><div class="ktr-actions">${button('consult', '内容を相談する', { primary: true })}</div></section>`;
    else if (state.phase === 'result') body = runHtml((state.runs || []).find(run => run.id === state.resultRunId) || last, options);
    else if (state.phase === 'rollback-confirm') body = rollbackHtml(state);
    else body = `<section class="ktr-section"><h2>アプリの変更を相談する</h2><p>変更したい動きと、今のまま残したいことを教えてください。内容を確認してから動作テスト環境に反映します。</p></section>${composer(state, options)}`;
    const support = historical || consulting ? '' : `${historyHtml(state.messages)}${codeHtml(state)}${verificationHtml(state)}`;
    const runHistory = state.runs?.length ? `<details data-release-panel="runs"><summary>これまでの反映</summary><ul>${state.runs.map((run, index) => `<li>${button('history', run.goal || `反映 ${index + 1}`, { id: run.id })} <span>${esc(run.rollback?.status === 'complete' ? '元に戻し済み' : ({ complete: '反映済み', partial: '一部反映', failed: '未完了', unknown: '結果未確認' }[run.status] || '処理中'))}</span></li>`).join('')}</ul></details>` : '';
    const withDetails = !consulting && !!(support || runHistory) && (!!historical || ['review', 'incomplete', 'unchanged', 'blocked', 'applying', 'result', 'rollback-confirm', 'rolling-back'].includes(state.phase));
    return `<div class="ktr-workspace" data-release-phase="${esc(state.phase)}"><style>${styles}</style><div class="ktr-content"><header class="ktr-header"><div><strong>${esc(options.appName || 'アプリの変更')}</strong><span class="ktr-environment">動作テスト環境</span></div><span class="ktr-phase">${esc(historical ? '過去の反映記録' : phaseText[state.phase] || '相談')}</span></header>
      ${conn.connected === false || conn.available === false ? `<aside class="ktr-notice"><p>${esc(conn.message || 'AIサービスへ接続してください。')}</p>${button('connect', '接続する')}</aside>` : ''}
      ${notice ? `<p class="ktr-notice" role="status">${esc(notice)}</p>` : ''}${state.error?.message && !historical && !(state.phase === 'incomplete' && (state.artifacts || []).some(a => a.error?.message === state.error.message || a.result?.artifactOutcome?.message === state.error.message)) ? `<p class="ktr-error" role="alert">${esc(state.error.message)}</p>` : ''}
      <div class="ktr-layout${withDetails ? ' ktr-layout-with-details' : ''}"><main>${body}</main><aside class="ktr-support" aria-label="記録と詳しい内容"><h2 class="ktr-support-heading">記録と詳しい内容</h2>${support}${runHistory}<details data-release-panel="connection"><summary>接続</summary><p>${esc(conn.message || (conn.connected === false ? '未接続です。' : '接続設定は、ここから確認できます。'))}</p><div class="ktr-actions">${button('connect', '接続を確認する')}${button('refresh-connection', '接続を更新')}</div></details><div class="ktr-footer">${button('free-context', '資料を作成')}${button('details', 'アプリの情報を見る')}</div></aside></div></div></div>`;
  }
  function create(host, options = {}) {
    if (!host || !options.controller) throw new Error('作業面を表示するための情報がありません。');
    const controller = options.controller;
    let draft = '', consult = false, selectedRunId = null, notice = '', disposed = false, sending = false;
    const expanded = new Set();
    let previousPhase = controller.getState().phase;
    function draw(state = controller.getState()) {
      if (disposed) return;
      const input = host.querySelector?.('#kt-release-input'), focused = !!input && host.ownerDocument?.activeElement === input;
      if (input) draft = input.value;
      if (draft && ['review', 'incomplete', 'unchanged'].includes(state.phase) && previousPhase !== state.phase && focused) { consult = true; notice = '変更案の作成が終わりました。入力内容は残っています。'; }
      const selection = focused ? [input.selectionStart, input.selectionEnd] : null;
      previousPhase = state.phase;
      host.innerHTML = render(state, { ...options, draft, consult, selectedRunId, notice });
      host.querySelectorAll?.('details[data-release-panel]').forEach(el => { if (expanded.has(el.dataset.releasePanel)) el.open = true; });
      const nextInput = host.querySelector?.('#kt-release-input');
      if (nextInput) nextInput.value = draft;
      if (focused && nextInput && !nextInput.disabled) { nextInput.focus(); if (selection && typeof nextInput.setSelectionRange === 'function') nextInput.setSelectionRange(...selection); }
    }
    function inputChanged(event) { if (event.target?.id === 'kt-release-input') draft = event.target.value; }
    async function send() {
      if (sending) return;
      const input = host.querySelector?.('#kt-release-input');
      const value = String(input?.value ?? draft).trim();
      if (!value) return;
      sending = true;
      try {
        if (typeof options.beforeSend === 'function' && await options.beforeSend() === false) return;
        draft = ''; if (input) input.value = ''; consult = false; selectedRunId = null; notice = '';
        await controller.send(value);
      } finally { sending = false; }
    }
    async function act(action, id, target = {}) {
      const state = controller.getState();
      if (action === 'send') return send();
      if (action === 'consult') { consult = true; selectedRunId = null; draw(); host.querySelector?.('#kt-release-input')?.focus?.(); return; }
      if (action === 'current') { consult = false; selectedRunId = null; notice = ''; draw(); return; }
      if (action === 'history') { selectedRunId = id; consult = false; draw(); return; }
      if (action === 'answer') { draft = target.dataset?.releaseAnswer || ''; const input = host.querySelector?.('#kt-release-input'); if (input) { input.value = draft; input.focus?.(); } return; }
      if (action === 'new-task') { draft = ''; selectedRunId = null; consult = false; notice = ''; return controller.newTask(); }
      if (action === 'cancel-rollback') return controller.cancelRollback();
      if (action === 'request-rollback') { selectedRunId = null; return controller.requestRollback(id); }
      if (action === 'rollback') return controller.rollback(id);
      if (['adopt', 'resume', 'apply', 'cancel'].includes(action)) { consult = false; notice = ''; return controller[action](); }
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
    .ktr-workspace{flex:0 0 auto;width:100%;max-width:none;min-width:0;min-height:100%;margin:0;padding:clamp(14px,2%,24px);container:ktr-workspace / inline-size}.ktr-content{width:100%;max-width:1320px;min-width:0;margin:0 auto}.ktr-layout>main,.ktr-support{min-width:0}.ktr-layout:not(.ktr-layout-with-details){max-width:1040px;margin:0 auto}
    .ktr-workspace *,.kt-release-dialog *{box-sizing:border-box}.ktr-workspace h2,.kt-release-dialog h2{font-size:22px;line-height:1.4;margin:0 0 16px}.ktr-workspace h3,.kt-release-dialog h3{font-size:15px;margin:20px 0 8px}.ktr-workspace p,.kt-release-dialog p{margin:8px 0 14px;white-space:pre-wrap}.ktr-workspace ul,.ktr-workspace ol{margin:8px 0 18px;padding-left:24px}.ktr-workspace li{margin:7px 0}
    .ktr-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;border-bottom:1px solid var(--ktr-line);padding-bottom:16px;margin-bottom:24px}.ktr-header strong{font-size:16px}.ktr-environment{display:block;font-size:12px;color:var(--ktr-muted)}.ktr-phase{font-size:12px;color:var(--ktr-muted);white-space:nowrap;padding:3px 8px;background:var(--ktr-soft);border-radius:5px}.ktr-section{padding-bottom:12px}.ktr-lead{font-size:15px}.ktr-note{font-size:12px;color:var(--ktr-muted)}
    .ktr-actions,.ktr-compose-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:20px 0 8px}.ktr-compose-actions{justify-content:space-between}.ktr-workspace button,.kt-release-dialog button{font:inherit;line-height:1.4;padding:9px 14px;border:1px solid var(--ktr-line);border-radius:6px;cursor:pointer;background:var(--ktr-paper);color:var(--ktr-text);max-width:100%;overflow-wrap:anywhere}.ktr-workspace button.ktr-primary,.kt-release-dialog button.ktr-primary{color:#fff;background:var(--ktr-accent);border-color:var(--ktr-accent);font-weight:600}.ktr-workspace button:disabled,.kt-release-dialog button:disabled{opacity:.5;cursor:default}.ktr-workspace button:focus-visible,.ktr-workspace textarea:focus-visible,.ktr-workspace summary:focus-visible,.kt-release-dialog :is(button,textarea,select,summary):focus-visible{outline:3px solid #83b6fb;outline-offset:3px}
    .ktr-composer{margin:22px 0 10px}.ktr-composer label{display:block;font-weight:600;margin-bottom:8px}.ktr-composer textarea{display:block;width:100%;min-height:95px;resize:vertical;padding:12px;font:inherit;border:1px solid #aebccf;border-radius:7px;color:var(--ktr-text);background:var(--ktr-paper)}.ktr-confirmations,.ktr-question,.ktr-notice{padding:14px 16px;border:1px solid var(--ktr-line);border-radius:7px;background:var(--ktr-soft);margin:16px 0}.ktr-confirmations h3,.ktr-question h3{margin-top:0}.ktr-error{padding:12px 16px;border-left:3px solid #b74826;background:#fff2e9;color:#783418}.ktr-reasons{color:#783418}.ktr-progress{padding:24px 0 32px}
    .ktr-support{border-top:1px solid var(--ktr-line);margin-top:22px;padding-top:10px}.ktr-workspace .ktr-support-heading{display:none;font-size:15px;margin:0 0 12px;color:var(--ktr-muted)}.ktr-workspace details,.kt-release-dialog details{margin:8px 0}.ktr-workspace summary,.kt-release-dialog summary{cursor:pointer;padding:9px 0;color:var(--ktr-muted)}.ktr-workspace details[open]>summary,.kt-release-dialog details[open]>summary{font-weight:600;color:var(--ktr-text)}.ktr-messages{list-style:none;padding:0!important}.ktr-message{border-bottom:1px solid var(--ktr-line);padding:12px 0}.ktr-message.ktr-user{padding:12px 16px;background:var(--ktr-soft);border-radius:6px}.ktr-speaker{font-size:12px;font-weight:600;color:var(--ktr-muted)}.ktr-code{padding:12px 0 20px}.ktr-code pre,.ktr-setting-values,.ktr-fact-value{white-space:pre-wrap;word-break:break-word;font:12px/1.6 ui-monospace,monospace;background:var(--ktr-soft);border:1px solid var(--ktr-line);border-radius:6px;padding:14px}.ktr-footer{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}.ktr-footer button{font-size:12px;color:var(--ktr-muted)}
    .kt-release-dialog{width:min(640px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);padding:24px;margin:auto;border:1px solid var(--ktr-line);border-radius:10px;overflow:auto;overscroll-behavior:contain}.kt-release-dialog.ktr-dialog-wide{width:min(960px,calc(100vw - 32px))}.kt-release-dialog::backdrop{background:rgba(15,23,42,.38)}.ktr-dialog-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}.kt-release-dialog .ktr-dialog-header h2{font-size:20px;margin:0}.kt-release-dialog [data-close]{flex:none;white-space:nowrap}.kt-release-dialog :is(textarea,select){font:inherit;max-width:100%;min-width:0;padding:9px 10px;border:1px solid #aebccf;border-radius:6px;color:var(--ktr-text);background:var(--ktr-paper)}.kt-release-dialog textarea{width:100%}.kt-release-dialog pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}
    @container ktr-workspace (min-width:1040px){.ktr-layout-with-details{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);align-items:start;gap:28px}.ktr-layout-with-details>.ktr-support{border-top:0;border-left:1px solid var(--ktr-line);margin-top:0;padding:0 0 0 24px}.ktr-layout-with-details .ktr-support-heading{display:block}}
    @media(max-width:560px){.ktr-workspace{padding:14px}.ktr-header{gap:8px}.ktr-workspace h2{font-size:19px}.ktr-actions .ktr-primary{width:100%}.ktr-compose-actions{align-items:flex-end}.ktr-phase{white-space:normal;text-align:right}.kt-release-dialog{padding:16px}.ktr-dialog-header{gap:8px}.kt-release-dialog .ktr-dialog-header h2{font-size:18px}.kt-release-dialog label{display:block;margin:8px 0}.kt-release-dialog label>select{display:block;width:100%;margin-top:4px}}
  `;
  return { create, render, escape: esc };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseView };
