/* One working surface for consultation, change review, and execution results.
 * It displays service/execution results. It does not interpret requirement text.
 */
'use strict';

const KTReleaseView = (() => {
  const workspace = typeof KTReleaseWorkspace !== 'undefined' ? KTReleaseWorkspace : require('./release-workspace.js').KTReleaseWorkspace;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const textOf = value => typeof value === 'string' ? value : value?.message || value?.title || value?.text || value?.description || value?.label || value?.name || '';
  const bodyOf = result => {
    const generated = result?.generated || result || {};
    return generated.strategy === 'EXTEND_EXISTING_JS' ? generated.body : generated.code;
  };
  const list = (rows, className = '') => rows?.length ? `<ul class="${className}">${rows.map(row => `<li>${esc(textOf(row))}</li>`).join('')}</ul>` : '';
  const platformsOf = artifact => [...new Set((artifact?.result?.artifactOutcome?.operations || []).map(op => op.targetPlatform))].map(p => p === 'desktop' ? 'PC' : p === 'mobile' ? 'モバイル' : '').filter(Boolean).join('・');
  const busy = new Set(['consulting', 'building', 'preparing', 'applying', 'rolling-back', 'checking-result']);
  const phaseText = { idle: '相談', consulting: '相談', proposal: '仮案の確認', building: '変更案の作成', preparing: '反映内容の確認', review: '変更内容の確認', incomplete: '作成途中', unchanged: '変更なし', blocked: '内容の確認', applying: '反映中', result: '反映結果', 'rollback-confirm': '戻す内容の確認', 'rolling-back': '元の状態へ戻しています', 'checking-result': '復元結果を確認しています。' };
  const stageOf = (phase, historical) => historical ? 'result' : ({
    proposal: 'proposal', consulting: 'working', building: 'working', preparing: 'working', applying: 'working', 'rolling-back': 'working', 'checking-result': 'working',
    review: 'review', result: 'result', incomplete: 'attention', blocked: 'attention', 'rollback-confirm': 'attention', unchanged: 'result'
  }[phase] || 'empty');
  const stageLabel = { proposal: ['01', '提案を相談する'], working: ['↻', '処理中'], review: ['02', '反映前の確認'], result: ['▤', '結果'], attention: ['!', '確認が必要です'], empty: ['○', 'ここに変更案を表示します'], explanation: ['≡', '説明を読む'] };
  const activity = '<span class="ktr-activity" aria-hidden="true"><i></i><i></i><i></i></span>';
  const draftActions = new Set(['adopt', 'resume', 'apply', 'rollback', 'reprepare', 'update-suggestions']);
  const draftPending = options => !!options.smalltalk?.getState().open || !!String(options.draft || '').trim() || !!options.sending;
  const draftNotice = options => `<p class="ktr-note" data-release-draft-note${draftPending(options) ? '' : ' hidden'}>${options.smalltalk?.getState().open ? '変更案の操作は、アプリの相談に戻ってから行ってください。' : '入力した内容を送信するか、消してから操作してください。'}</p>`;
  const button = (action, label, { primary = false, disabled = false, blockedByDraft = false, id = '', extra = '' } = {}) => `<button type="button" data-release-action="${action}"${id ? ` data-release-id="${esc(id)}"` : ''}${draftActions.has(action) ? ` data-release-base-disabled="${disabled}"` : ''} class="${primary ? 'ktr-primary' : 'ktr-secondary'}"${disabled || blockedByDraft ? ' disabled' : ''}${extra}>${esc(label)}</button>`;
  function connectionOf(options) { try { return (typeof options.connection === 'function' ? options.connection() : options.connection) || {}; } catch (_) { return { connected: false, message: '接続の状態を確認できません。' }; } }
  const sharedCredits = usage => usage?.version === 3 || usage?.version === 4;
  const documentBlocked = conn => (conn.canDocument ?? conn.canCreate) === false;
  const resumeBlocked = conn => (conn.canResume ?? conn.canCreate) === false;
  function quotaNotice(conn, operation) {
    const bucket = operation === 'document' ? 'document' : operation === 'final' ? 'creation' : 'consultation';
    if (workspace.usageReserved(conn.usage, bucket)) return '処理中の分を確保しています。完了後に［接続を更新］で残数を確認してください。';
    if (conn.usage?.version === 4) {
      const needed = conn.usage.operationCosts?.[operation] ?? (operation === 'document' ? 2 : operation === 'final' ? 3 : 1);
      const remaining = conn.usage.credits?.remaining;
      return 'この操作には' + needed + 'クレジット必要です。' + (remaining == null ? '' : '残りは' + remaining + 'クレジットです。') + '［接続］で利用状況と更新日を確認できます。';
    }
    return '今月の' + (sharedCredits(conn.usage) ? 'クレジット' : (operation === 'document' || operation === 'final' ? '作成' : '相談') + '回数') + 'の上限です。［接続］で更新日を確認できます。';
  }
  function historyStatusHtml(options) {
    let status;
    try { status = typeof options.historyStatus === 'function' ? options.historyStatus() : options.historyStatus; }
    catch (_) { status = { state: 'unavailable', message: '保存の状態を確認できません。' }; }
    if (!status?.state) return '';
    const labels = { saving: '保存中…', saved: '保存済み', error: '保存できません', unavailable: '保存を利用できません', loading: '読み込み中…' };
    const label = labels[status.state];
    if (!label) return '';
    const detail = [label, status.completed ? '完了' : '', status.pinned ? '保護中' : ''].filter(Boolean).join('・');
    const failed = status.state === 'error' || status.state === 'unavailable';
    const message = status.message || (failed ? '保存した会話を開いて、保存の状態を確認してください。' : detail);
    const indicator = '<span class="ktr-history-status" data-release-history-state="' + esc(status.state) + '" role="' + (failed ? 'alert' : 'status') + '">' + esc(detail) + '</span>';
    return failed ? '<details class="ktr-history-status-detail" data-release-panel="history-status"><summary>' + indicator + '</summary><div class="ktr-history-status-message"><p>' + esc(message) + '</p></div></details>' : '<span title="' + esc(message) + '">' + indicator + '</span>';
  }
  function usageHtml(value) {
    const usage = workspace.usageOf(value), count = n => n == null ? '未確認' : n + '回';
    if (!usage) return '<p class="ktr-note">利用状況は未確認です。［接続を更新］で確認できます。</p>';
    const expired = workspace.usageExpired(usage), shared = sharedCredits(usage), creditCount = n => n == null ? '未確認' : String(n);
    const price = usage.version === 4 && Number.isSafeInteger(usage.price?.monthlyJpy) && usage.price.monthlyJpy >= 0 && usage.price.taxIncluded === true ? `<p data-usage-price>月額 ${usage.price.monthlyJpy.toLocaleString('ja-JP')}円（税込）</p>` : '';
    const rows = shared ? `<p data-usage-credits><strong>クレジット</strong> 残り ${expired ? '更新待ち' : creditCount(usage.credits?.remaining)} / 月 ${creditCount(usage.credits?.limit)}<small>（利用済み ${creditCount(usage.credits?.used)}・確保中 ${creditCount(usage.credits?.reserved)}）</small></p>` : usage.version === 2 ? ['consultation', 'creation'].map(key => {
      const b = usage.buckets[key];
      return `<p data-usage-bucket="${key}"><strong>${key === 'consultation' ? '相談' : '作成'}</strong> 残り ${expired ? '更新待ち' : count(b?.remaining)} / 月 ${count(b?.limit)}<small>（利用済み ${count(b?.used)}・確保中 ${count(b?.reserved)}）</small></p>`;
    }).join('') : `<p data-usage-legacy>AI利用 残り ${expired ? '更新待ち' : count(usage.remainingThisMonth)} / 月 ${count(usage.monthlyLimit)}（利用済み ${count(usage.usedThisMonth)}）</p>`;
    return `<p data-usage-plan>${esc(workspace.usagePlanLabel(usage))}</p>${price}<p class="ktr-note">${shared ? 'クレジット' : '回数'}は契約全体で共有します。</p>${rows}<p class="ktr-note" data-usage-reset>${shared ? '利用枠' : '回数'}の更新：${esc(workspace.usageResetText(usage))}${expired ? '。［接続を更新］で今月の利用状況を取得してください。' : ''}</p>`;
  }
  function usageDetailsHtml(value) {
    const usage = workspace.usageOf(value);
    if (usage?.version === 4) return '<p>相談・仮案の作成や修正は1回につき1クレジット、資料の作成や修正は1回につき2クレジットです。</p><p>［この案で作成］は最終案一式で3クレジットです。設定変更だけの場合もJavaScriptを含む場合も同額で、JavaScriptの本数による追加消費はありません。</p><p>計画ができた時点で3クレジットが確定します（確認事項が残る計画も含みます）。同じ案のコード作成・自動修復・確認では追加消費しません。内容を変えて作り直す場合は別の作成です。1会話全体が定額という意味ではありません。</p><p>同じ案のコード作成は計画から30日以内、各JavaScriptで初回を含め3回までです。計画の確定後に通信が切れ、結果が届かなかった場合も消費済みになることがあります。計画から作り直す場合は別途3クレジットです。</p><p>閲覧・選択・コピー・保存・自動復旧・無料の設定比較・反映・元に戻す操作そのものは0クレジットです。残数には処理中の確保分も反映されています。</p>';
    if (usage?.version === 3) return '<p>相談・提案・アイディア、資料の作成・修正、変更計画、コード生成は、処理1件につき共通の1クレジットを使います。</p><p>［この案で作成］は計画1件と、その後のコード生成ごとに1件です。計画1件＋コード生成2件なら合計3クレジットです。必要な生成件数は計画後に決まるため、1クリックが必ず1クレジットという意味ではありません。</p><p>同じ処理内の自動修復・確認では追加消費しません。閲覧・コピー・保存・反映・元に戻す操作は0クレジットです。残数には処理中の確保分も反映されています。</p>';
    return '<p>通常の相談・変更の提案・アイディアは、送信1回につき相談1回です。資料の作成・修正は、送信1回につき作成1回です。</p><p>［この案で作成］では計画の作成に作成1回、その後のコード生成の要求ごとに作成1回を使います。コードの件数は計画を作った後に決まるため、全体の回数は事前には確定しません。サービス内部の修正・確認で回数は増えません。</p><p>コピー・保存・反映・元に戻す操作では回数を使いません。残数には処理中などの確保分も反映されています。</p>';
  }
  function factsHtml(messages) {
    return (messages || []).filter(m => m.role !== 'user' && Array.isArray(m.facts) && m.facts.length).map(m => `<details data-release-panel="facts-${esc(m.id)}"><summary>この返答の根拠</summary><ul>${m.facts.map((f, index) => `<li>${esc(f.text || f.statement || f.description || f.summary || f.title || '')}${f.value != null ? `<details data-release-panel="fact-value-${esc(m.id)}-${index}"><summary>設定の内容</summary><pre class="ktr-fact-value">${esc(typeof f.value === 'string' ? f.value : JSON.stringify(f.value, null, 2))}</pre></details>` : ''}</li>`).join('')}</ul><p class="ktr-note">この返答を作成したときの情報です。</p></details>`).join('');
  }

  const explanationFacts = (document, section) => {
    const ids = new Set(section.evidenceIds || []);
    return (document.facts || []).filter(fact => ids.has(fact.id));
  };
  function explanationEvidence(document, section, index) {
    const facts = explanationFacts(document, section);
    if (!facts.length) return '';
    return `<details data-release-panel="explanation-facts-${esc(document.id)}-${index}"><summary>この説明の根拠</summary><p class="ktr-note">説明作成時の設定です。現在の設定とは異なる場合があります。</p><ul>${facts.map((fact, at) => `<li><strong>${esc(fact.id)}</strong> ${esc(textOf(fact) || fact.statement || fact.summary || '')}${fact.value != null ? `<details data-release-panel="explanation-value-${esc(document.id)}-${index}-${at}"><summary>設定の内容</summary><pre class="ktr-fact-value">${esc(typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value, null, 2))}</pre></details>` : ''}</li>`).join('')}</ul></details>`;
  }
  function explanationHtml(document) {
    return `<article class="ktr-section ktr-explanation" data-release-explanation="${esc(document.id)}"><h2>${esc(document.title || 'アプリの説明')}</h2><div class="ktr-actions">${button('copy-explanation', '本文をコピー', { id: document.id })}${button('download-explanation', 'Markdownで保存', { id: document.id })}</div>${document.diagnosisSource ? `<p class="ktr-note">動作テスト環境・アプリ ${esc(document.diagnosisSource.appId)}・設定の版 ${esc(document.diagnosisSource.revision ?? "不明")}（${esc(document.diagnosisSource.loadedAt ?? "取得時刻不明")}）の診断です。手元の未登録編集や実際の画面の動作は含みません。選んだ項目は相談欄に入り、送信するまでAIを呼びません。</p>` : ""}${(document.sections || []).map((section, index) => {
      const table = section.table;
      const tableHtml = table?.columns?.length ? `<div class="ktr-table-scroll" tabindex="0" role="region" aria-label="${esc(section.heading || '説明の表')}"><table><thead><tr>${table.columns.map(column => `<th scope="col">${esc(column)}</th>`).join('')}</tr></thead><tbody>${(table.rows || []).map(row => `<tr>${table.columns.map((_, at) => `<td>${esc(row[at])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '';
      return `<section class="ktr-explanation-section">${section.heading ? `<h3>${esc(section.heading)}</h3>` : ''}${(section.paragraphs || []).map(paragraph => `<p>${esc(paragraph)}</p>`).join('')}${list(section.items || [])}${tableHtml}${explanationEvidence(document, section, index)}${document.diagnosisSource && section.evidenceIds?.length ? button("consult-diagnosis", "改善を相談する", { id: document.id, extra: ` data-release-section="${index}"` }) : ""}</section>`;
    }).join('')}${document.unknowns?.length ? `<section class="ktr-explanation-unknowns"><h3>確認できていないこと</h3>${list(document.unknowns)}</section>` : ''}</article>`;
  }
  // Export structured display content as Markdown; do not ask AI to rewrite it.
  const markdownText = value => String(value ?? '').replace(/[\\`*_{}\[\]()#+.!|<>-]/g, ch => '\\' + ch);
  function explanationMarkdown(document) {
    if (!document) return '';
    const lines = ['# ' + markdownText(document.title || 'アプリの説明').replace(/\r?\n/g, ' '), ''];
    if (document.diagnosisSource) lines.push('動作テスト環境・アプリ ' + markdownText(document.diagnosisSource.appId) + '・設定の版 ' + markdownText(document.diagnosisSource.revision ?? '不明') + '（' + markdownText(document.diagnosisSource.loadedAt ?? '取得時刻不明') + '）の診断。実際の動作と手元の未登録編集は未確認です。', '');
    for (const section of document.sections || []) {
      if (section.heading) lines.push('## ' + markdownText(section.heading).replace(/\r?\n/g, ' '), '');
      for (const paragraph of section.paragraphs || []) lines.push(markdownText(paragraph), '');
      for (const item of section.items || []) lines.push('- ' + markdownText(item).replace(/\r?\n/g, '\n  '));
      if (section.items?.length) lines.push('');
      const table = section.table, cell = value => markdownText(value).replace(/\r?\n/g, '<br>');
      if (table?.columns?.length) {
        lines.push('| ' + table.columns.map(cell).join(' | ') + ' |', '| ' + table.columns.map(() => '---').join(' | ') + ' |');
        for (const row of table.rows || []) lines.push('| ' + table.columns.map((_, at) => cell(row[at])).join(' | ') + ' |');
        lines.push('');
      }
      const facts = explanationFacts(document, section);
      if (facts.length) {
        lines.push('### 根拠（説明作成時の設定）', '');
        for (const fact of facts) {
          lines.push('- ' + markdownText(fact.id) + '：' + markdownText(textOf(fact) || fact.statement || fact.summary || '').replace(/\r?\n/g, '\n  '));

        }
        lines.push('');
      }
    }
    if (document.unknowns?.length) lines.push('## 確認できていないこと', '', ...document.unknowns.map(item => '- ' + markdownText(item).replace(/\r?\n/g, '\n  ')), '');
    return lines.join('\n').trimEnd() + '\n';
  }
  function explanationNavigation(state, explanation, historical) {
    const documents = state.explanations || [], latest = documents.at(-1);
    if (!latest) return '';
    const disabled = busy.has(state.phase);
    return `<div class="ktr-document-navigation"><nav class="ktr-document-tabs" aria-label="表示する内容">${button('show-explanation', '説明', { id: explanation?.id || latest.id, disabled, extra: ` aria-pressed="${!!explanation && !historical}"` })}${button('show-changes', '変更案', { disabled, extra: ` aria-pressed="${!explanation && !historical}"` })}</nav>${documents.length > 1 ? `<details data-release-panel="explanation-history"><summary>これまでの説明</summary><ul>${documents.map((document, index) => `<li>${button('show-explanation', `${index + 1}. ${document.title || 'アプリの説明'}`, { id: document.id, disabled, extra: ` aria-current="${document.id === explanation?.id ? 'true' : 'false'}"` })}</li>`).join('')}</ul></details>` : ''}</div>`;
  }

  const consultationLabel = target => target.type === 'field'
    ? (target.name === target.id ? target.id : target.name + '（' + target.id + '）') + ' / フィールド'
    : target.type === 'event' ? target.id + ' / イベント'
    : target.name + '（' + (target.target === 'mobile' ? 'モバイル' : 'PC') + '）';
  function historyHtml(messages) {
    if (!messages?.length) return '<p class="ktr-empty-chat">変更したいことや、アプリについて知りたいことを教えてください。</p>';
    return `<ol class="ktr-messages">${messages.map(m => `<li class="ktr-message ${m.role === 'user' ? 'ktr-user' : ''}"><span class="ktr-speaker">${m.role === 'user' ? 'あなた' : 'AI'}</span>${m.consultationTarget ? `<span class="ktr-note"> / ${esc(consultationLabel(m.consultationTarget))}</span>` : ''}<p>${esc(m.text)}</p>${m.role !== 'user' ? factsHtml([m]) : ''}</li>`).join('')}</ol>`;
  }
  function composer(state, options = {}) {
    const conn = connectionOf(options), disabled = busy.has(state.phase) || conn.connected === false || conn.available === false || !!options.historical || !!options.switching;
    const document = state.requestPurpose === 'document', ideation = state.requestPurpose === 'ideation';
    const quotaBlocked = document ? documentBlocked(conn) : conn.canConsult === false, shared = sharedCredits(conn.usage), bundled = conn.usage?.version === 4;
    const purpose = document || ideation ? `<div class="ktr-request-purpose"><span class="ktr-note">${document ? '資料の修正を相談中です。変更案はそのまま残ります。' : '検討用のアイディアです。変更案にはまだ取り込んでいません。'}</span>${button('focus-consultation', '変更を相談する', { disabled })}</div>` : '';
    return `<form class="ktr-composer" data-release-form="consult" data-release-purpose="${esc(state.requestPurpose || 'consultation')}">${purpose}<label for="kt-release-input">変更したいこと、質問、修正内容</label>${state.consultationTarget ? `<div class="ktr-consult-target"><span>相談の対象：${esc(consultationLabel(state.consultationTarget))}</span>${button('clear-consultation-target', '対象を外す', { disabled })}<small>${state.consultationTarget.type === 'FILE' ? '送信時に取得する登録済みコードを使います。手元の編集は送信しません。' : '送信時に動作テスト環境の設定・登録済みコードと依存関係を取得し直します。手元の編集は送信しません。'}</small></div>` : ''}<textarea id="kt-release-input" rows="2" placeholder="${document ? '例：引継ぎ資料にまとめて。説明を短くするなど、資料の修正も依頼できます。' : ideation ? '例：このアプリの入力を楽にする工夫をいくつか考えて。' : '例：このアプリの仕組みを教えて。変更したいことも相談できます。'}"${disabled ? ' disabled' : ''}>${esc(options.draft || '')}</textarea><div class="ktr-compose-actions"><span class="ktr-note">${options.historical ? '過去の反映記録を表示中です。現在の作業に戻ると入力できます。' : quotaBlocked ? quotaNotice(conn, document ? 'document' : 'consultation') : (shared ? '送信ごとに' + (bundled && document ? 2 : 1) + 'クレジット' : document ? '送信ごとに作成1回' : '送信ごとに相談1回') + '・Enterで送信'}</span>${button('send', '送信', { primary: true, disabled: disabled || quotaBlocked })}</div></form>`;
  }
  function proposalHtml(state, options) {
    const p = options.proposal || state.proposal || {}, answered = new Map((state.answers || []).filter(a => a.answer).map(a => [a.id, a.answer]));
    const pending = (p.decisions || []).filter(q => q.blocking && !q.answer && !answered.has(q.id));
    const behaviors = (p.behaviors || []).filter(b => b.origin !== 'suggestion'), suggestions = (p.behaviors || []).filter(b => b.origin === 'suggestion');
    const latest = (state.messages || []).filter(m => m.role !== 'user').at(-1);
    const conn = connectionOf(options), selected = new Set(state.selectedSuggestionIds || []);
    const suggestionEditable = !options.readOnly && !options.sending && state.phase === 'proposal' && !state.proposalPending;
    const suggestionRef = ` data-release-task="${esc(state.taskId)}" data-release-version="${esc(state.version)}"`;
    return `<section class="ktr-section"><h2>${options.readOnly ? '参照中の案' : '仮案を確認してください'}</h2>${behaviors.length ? list(behaviors) : !suggestions.length && latest?.text ? `<p class="ktr-lead">${esc(latest.text)}</p>` : ''}
      ${suggestions.length ? `<section data-release-panel="suggestions"><h3>あわせて検討できること</h3><p class="ktr-note">必要なものだけ選べます。チェックするだけでは、案の更新やAIの呼び出しは行いません。</p><div class="ktr-suggestion-choices">${suggestions.map(item => `<label class="ktr-suggestion-choice"><input type="checkbox" data-release-suggestion="${esc(item.id)}"${suggestionRef}${selected.has(item.id) ? ' checked' : ''}${!suggestionEditable ? ' disabled' : ''}><span>${esc(textOf(item))}</span></label>`).join('')}</div>${!options.readOnly ? `<div class="ktr-actions">${button('update-suggestions', '選んだ内容で案を更新', { primary: selected.size > 0, disabled: !suggestionEditable || !selected.size || conn.connected === false || conn.available === false, blockedByDraft: draftPending(options), extra: suggestionRef })}</div>${selected.size ? '<p class="ktr-note">選んだ追加提案は、案を更新してから内容を確認してください。</p>' : ''}` : ''}</section>` : ''}
      ${p.assumptions?.length ? `<h3>この案の前提</h3>${list(p.assumptions)}` : ''}${p.cannot?.length ? `<h3>この案の制約</h3>${list(p.cannot)}` : ''}
      ${(p.decisions || []).filter(q => !q.answer && !answered.has(q.id)).map(q => `<div class="ktr-question"><h3>${esc(q.question || q.label || '確認したいこと')}</h3>${!options.readOnly && q.options?.length ? `<div class="ktr-actions">${q.options.map(o => button('answer', textOf(o), { extra: ` data-release-answer="${esc(textOf(o))}"` })).join('')}</div>` : ''}${!options.readOnly && q.blocking ? '<p class="ktr-note">回答を送ってから、仮案を確かめてください。</p>' : ''}</div>`).join('')}
      ${state.answers?.length ? `<h3>決めたこと</h3>${list(state.answers.map(a => ({ text: [a.label, a.answer].filter(Boolean).join('：') })))}` : ''}
      ${!options.readOnly && state.proposalPending ? `<p class="ktr-note">送信した内容を案に反映できていません。${['BUDGET_EXCEEDED', 'MONTHLY_LIMIT_EXCEEDED'].includes(state.error?.code) ? '利用状況を確認し、利用可能になってから相談内容をもう一度送信してください。' : '相談内容をもう一度送信し、更新された案を確認してください。'}</p>` : ''}
      ${options.readOnly ? '<p class="ktr-note">処理中のため、この案の採用や反映はできません。</p>' : `<div class="ktr-actions">${button('adopt', 'この案で作成', { primary: true, disabled: !!state.proposalPending || selected.size > 0 || pending.length > 0 || conn.connected === false || conn.available === false || conn.canPlan === false || conn.canCreate === false, blockedByDraft: draftPending(options) })}</div>${draftNotice(options)}<p class="ktr-note">${conn.usage?.version === 4 ? (conn.canCreate === false ? quotaNotice(conn, 'final') : '最終案の作成は3クレジットです。JavaScriptの本数による追加消費はありません。') : conn.usage?.version === 3 ? '必要なクレジットは計画の内容で変わります。［接続］で数え方を確認できます。' : '計画の作成に作成1回、その後のコード生成の要求ごとに作成1回を使います。全体の回数は計画の内容で変わります。'}この操作では、kintoneの設定やJavaScriptは変更しません。</p>`}</section>`;
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
      return `<li><strong>${esc(title)}</strong>${change.placementDescription ? `<p class="ktr-note">${esc(change.placementDescription)}</p>` : ''}${change.description && change.description !== title ? `<p>${esc(change.description)}</p>` : ''}${values.length || change.technicalSummary ? `<details data-release-panel="change-${esc(change.id || index)}"><summary>設定の詳細（技術者向け）</summary>${change.technicalSummary ? `<p>${esc(change.technicalSummary)}</p>` : ''}${values.map(([label, value]) => `<h4>${label}</h4><pre class="ktr-setting-values">${esc(JSON.stringify(value, null, 2))}</pre>`).join('')}</details>` : ''}</li>`;
    }).join('')}</ul>`;
  }
  function reviewHtml(state, options) {
    const prep = state.prepared || {};
    return `<section class="ktr-section"><h2>今回反映する内容</h2>${changesHtml(prep.changes || [])}
      ${prep.unchanged?.length ? `<h3>変更しない内容</h3>${list(prep.unchanged.map(item => ({ text: [item.title, item.message].filter(Boolean).join('：') })))}` : ''}
      ${state.adopted?.assumptions?.length ? `<h3>この案の前提</h3>${list(state.adopted.assumptions)}` : ''}
      ${state.adopted?.cannot?.length ? `<h3>この案の制約</h3>${list(state.adopted.cannot)}` : ''}
      ${provisionalsHtml(state.plan?.provisionals)}${noticesHtml(state)}
      ${prep.confirmations?.length ? `<div class="ktr-confirmations"><h3>反映前に確認してください</h3>${list(prep.confirmations)}</div>` : ''}
      <p>反映先は動作テスト環境です。運用環境は変更しません。</p>
      ${(state.artifacts || []).length ? '<p class="ktr-note">作成したJavaScriptの検証は完了しています。実際の画面での動作は反映後に確かめます。</p>' : ''}
      <div class="ktr-actions">${button('apply', '動作テスト環境に反映', { primary: true, disabled: !prep.ok, blockedByDraft: draftPending(options) })}</div>${draftNotice(options)}</section>`;
  }
  function provisionalsHtml(rows) {
    const choices = (rows || []).filter(row => row && typeof row.choice === 'string' && row.choice.trim());
    return choices.length ? `<section><h3>計画で決めたこと</h3><p class="ktr-note">変更案を作る際にAIが決めた内容です。変更したい点は、反映前に相談してください。</p><ul>${choices.map((row, index) => `<li><span>${esc(row.choice)}</span>${row.reason ? `<p class="ktr-note">${esc(row.reason)}</p>` : ''}${row.changeHint ? `<details data-release-panel="plan-choice-${index}"><summary>変更したいとき</summary><p>${esc(row.changeHint)}</p></details>` : ''}</li>`).join('')}</ul></section>` : '';
  }
  // Display the service's existing explanation fields. These do not create blockers
  // or additional approval steps; only identical strings are deduplicated.
  function noticesHtml(state) {
    const seen = new Set((state.adopted?.cannot || []).concat(state.adopted?.assumptions || []).map(textOf));
    const unknowns = [...new Set((state.plan?.unknowns || []).map(textOf).filter(text => text && !seen.has(text)))];
    for (const text of unknowns) seen.add(text);
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
    return `${unknowns.length ? `<section class="ktr-explanation-unknowns"><h3>確認できていないこと</h3>${list(unknowns)}</section>` : ''}${notes.size ? `<section><h3>前提と注意点</h3><ul>${[...notes].map(([text, sources]) => `<li><span>${esc(text)}</span><p class="ktr-note">説明元：${esc([...sources].join('／'))}</p></li>`).join('')}</ul></section>` : ''}${impact.length ? `<details data-release-panel="plan-explanation"><summary>計画の説明を見る</summary>${list(impact)}</details>` : ''}`;
  }
  function declineHtml(artifacts) {
    return artifacts.filter(a => a.result?.error?.detail).map(a => {
      const detail = a.result.error.detail;
      const texts = [detail.summary, detail.reason, ...(detail.warnings || []), ...(detail.coverage || []).map(row => row.note)].map(textOf).filter(Boolean);
      return texts.length ? `<section><h3>作成できなかった理由（AIの説明）</h3>${list([...new Set(texts)])}</section>` : '';
    }).join('');
  }
  const reprepareHtml = options => `<div class="ktr-actions">${button('reprepare', '最新の設定で確認し直す', { primary: true, blockedByDraft: draftPending(options) })}</div>${draftNotice(options)}<p class="ktr-note">AIは呼び出さず、現在の変更案を確認し直します。kintoneへの反映は行いません。</p>`;
  const creationMessages = {
    incomplete: { title: '作成途中です', label: '作成途中', help: '残りを作成してから、全体を確認します。', action: '残りを作成' },
    interrupted: { title: '作成を完了できませんでした', label: '作成未完了', help: '接続などの原因を確認してから、未完了の内容を作成し直せます。', action: '未完了の内容を作成し直す' },
    failed: { title: '検証で不一致がありました', label: '検証不一致', help: '作成したコードの検証に通りませんでした。理由を確認し、相談で内容を修正するか、未完了の内容を作成し直してください。', action: '未完了の内容を作成し直す' },
    unverified: { title: '検証できない内容があります', label: '検証できません', help: 'コードの誤りとは判定していません。表示された理由を確認してください。内容の修正が必要な場合は相談欄から伝えられます。検証できない原因が残る間は、同じ内容を作成し直しません。' },
    declined: { title: '作成できない内容があります', label: '作成できません', help: 'AIが作成しなかった理由を確認し、変更したい内容を相談欄から伝えてください。' },
    reserved: { title: '処理中の分を確保しています', label: '利用枠を確保中', help: '完了後に［接続を更新］で残数を確認してください。', action: '未完了の作成を再開' },
    limit: { title: 'AIの利用上限に達しました', label: '利用上限', help: '接続画面で利用状況を確認してください。利用可能になったら、未完了の内容だけ作成を再開できます。', action: '未完了の作成を再開' }
  };
  function creationMessage(state) {
    if (workspace.canReprepare(state)) return { title: '反映内容の確認が必要です', label: '反映内容の確認' };
    if (!state.plan) return { title: '計画を作成できませんでした', label: '計画未完了' };
    return creationMessages[workspace.creationStateOf(state).kind];
  }
  function incompleteHtml(state, options) {
    if (workspace.canReprepare(state)) return `<section class="ktr-section"><h2>反映内容の確認が必要です</h2><p>作成した変更案は残っています。現在の設定で反映できるか確認してください。</p>${reprepareHtml(options)}</section>`;
    if (!state.plan) return `<section class="ktr-section"><h2>計画を作成できませんでした</h2><p>この案の作成は完了していません。${workspace.creationStateOf(state).kind === 'reserved' ? '処理が終わったら［接続を更新］で残数を確認してください。' : state.error?.code === 'MONTHLY_LIMIT_EXCEEDED' ? '利用枠の更新日を［接続］で確認してください。' : '相談で内容を修正するか、もう一度作成してください。'}</p><div class="ktr-actions">${button('adopt', 'もう一度作成', { primary: true, disabled: !state.proposal || connectionOf(options).canCreate === false, blockedByDraft: draftPending(options) })}</div>${draftNotice(options)}</section>`;
    const artifacts = state.artifacts || [], all = state.plan?.customizations || [];
    const finished = artifacts.filter(a => a.result?.artifactOutcome?.state === 'ready');
    const unfinished = all.filter(c => !finished.some(a => a.customizationId === c.customizationId));
    const recovery = workspace.creationStateOf(state), wording = creationMessages[recovery.kind];
    const reasons = artifacts.filter(a => a.result?.artifactOutcome?.state !== 'ready').map(a => ({ message: a.result?.artifactOutcome?.message || a.error?.message || '作成が終わっていません。' }));
    return `<section class="ktr-section"><h2>${wording.title}</h2><p>${finished.length ? '完成した内容は残っています。' : '現在の案は残っています。'}${wording.help}</p>${finished.length ? `<h3>できた内容</h3>${list(finished)}` : ''}${unfinished.length ? `<h3>確認が必要な内容</h3>${list(unfinished.map(c => ({ title: c.requirement || c.customizationId })))}` : ''}${list(reasons, 'ktr-reasons')}${declineHtml(artifacts)}${recovery.canResume ? `<div class="ktr-actions">${['limit', 'reserved'].includes(recovery.kind) ? button('connect', '利用状況を確認する') : ''}${button('resume', wording.action, { primary: true, disabled: resumeBlocked(connectionOf(options)), blockedByDraft: draftPending(options) })}</div>${draftNotice(options)}` : ['limit', 'reserved'].includes(recovery.kind) ? `<div class="ktr-actions">${button('connect', '利用状況を確認する', { primary: true })}</div>` : `<div class="ktr-actions">${button('focus-consultation', '相談欄で内容を修正する', { primary: true })}</div>`}</section>`;
  }
  function runHtml(run, options = {}, historical = false) {
    if (!run) return '<p>反映の記録はありません。</p>';
    const result = run.rollback || run.result || {}, status = result.status || run.status;
    const title = run.rollback ? status === 'complete' ? '反映前の状態に戻しました' : '元に戻した結果を確認してください' : ({ complete: '動作テスト環境に反映しました', partial: '一部だけ反映しました', failed: '反映できませんでした', unknown: '反映の結果を確認できません', running: '反映しています' }[status] || '反映結果');
    const recoveryLimited = (run.result?.settings?.steps || []).some(s =>
      (['APPLIED', 'VERIFIED', 'VERIFY_FAILED'].includes(s.status) || s.partial) &&
      run.prepared?.settings?.steps?.find(p => p.stepId === s.stepId)?.prepared?.irreversible);
    const canRestore = !run.archived && run.status !== 'unknown' && !!run.result?.written && run.result?.retryable !== false && run.rollback?.retryable !== false && !['complete', 'unknown'].includes(run.rollback?.status) && !recoveryLimited;
    const changes = run.prepared?.changes || [], platforms = new Set(changes.map(change => change.targetPlatform || (change.kind === 'javascript' ? change.target : null)).filter(Boolean));
    const checkDesktop = platforms.has('desktop') || changes.some(change => change.kind === 'setting' || (!change.kind && !change.targetPlatform));
    const checkMobile = platforms.has('mobile');
    const rows = Array.isArray(result.rows) ? result.rows : [...(Array.isArray(result.settings) ? result.settings : []), ...(Array.isArray(result.files) ? result.files : [])];
    return `<section class="ktr-section"><h2>${esc(title)}</h2>${result.message ? `<p class="ktr-lead">${esc(result.message)}</p>` : ''}
      ${run.archived ? '<p class="ktr-note">保存した反映結果です。現在の状態や、元に戻せることを保証するものではありません。</p>' : ''}${list(result.reasons || [], 'ktr-reasons')}
      ${status === 'complete' && !run.rollback ? list(run.prepared?.changes || []) : ''}
      ${status !== 'complete' && rows.length ? `<h3>処理ごとの結果</h3>${list(rows.map(row => ({ message: [row.title || row.label || row.stepId || row.targetFile || row.name || '変更', row.message || ({ applied: '反映済み', verified: '確認済み', complete: '完了', failed: '未完了', skipped: '未実施', unknown: '結果を確認できません', PENDING: '未実施', APPLIED: '反映済み', FAILED: '未完了', VERIFIED: '確認済み' }[row.status] || '')].filter(Boolean).join('：') })))}` : ''}
      ${!run.rollback && status === 'complete' && checkDesktop ? '<p>PCの動作は、動作テスト環境を開いて確認してください。</p>' : ''}
      ${!run.rollback && status === 'complete' && checkMobile ? '<p>モバイルの動作は、動作テスト環境では確認できません。モバイル画面での確認は別途必要です。</p>' : ''}
      ${recoveryLimited ? '<p>フィールドの削除・選択肢の変更を含むため、この反映は、この画面から自動では元に戻せません。保管したデータと現在の設定を確認してください。</p>' : ''}
      ${status === 'unknown' ? `<p>${run.rollback ? 'もう一度戻す前に、現在の状態を確認してください。' : '同じ変更をもう一度反映せず、現在の設定を確認してください。'}</p>` : ''}
      <div class="ktr-actions">${historical ? button('current', '現在の作業に戻る', { primary: true }) : `${status === 'complete' && !run.rollback && checkDesktop && typeof options.onOpenPreview === 'function' ? button('preview', '動作テスト環境を開く', { primary: true }) : ''}${button('new-task', '別の変更を相談する')}`}${!run.archived && !run.rollback && status === 'unknown' ? button('recheck-apply', '反映結果を確認する', { primary: true, id: run.id, disabled: !!options.operationBusy }) : ''}${!run.archived && run.rollback?.status === 'unknown' ? button('recheck-rollback', '復元結果を確認する', { primary: true, id: run.id, disabled: !!options.operationBusy }) : ''}${canRestore ? button('request-rollback', 'この反映の変更を戻す', { id: run.id, disabled: !!options.operationBusy }) : ''}</div></section>`;
  }
  function rollbackHtml(state, options) {
    const rollback = state.rollback || {}, run = (state.runs || []).find(r => r.id === rollback.runId), prep = rollback.prepared || {};
    if (run?.archived) return runHtml(run, options);
    return `<section class="ktr-section"><h2>この反映の変更を戻します</h2><p>対象は動作テスト環境の次の変更です。運用環境は変更しません。</p>${list(prep.changes || run?.prepared?.changes || [])}${prep.restoredChanges?.length ? `<h3>すでに戻した変更</h3>${list(prep.restoredChanges)}<p class="ktr-note">これらは今回の復元に含めません。</p>` : ''}${list(prep.reasons || [], 'ktr-reasons')}${prep.confirmations?.length ? `<div class="ktr-confirmations"><h3>戻す前に確認してください</h3>${list(prep.confirmations)}</div>` : ''}<div class="ktr-actions">${button('rollback', '反映前の状態に戻す', { primary: true, disabled: !prep.ok, blockedByDraft: draftPending(options), id: rollback.runId })}${button('cancel-rollback', '戻さずに閉じる')}</div>${draftNotice(options)}</section>`;
  }
  function diagnosticHtml(error) {
    if (error?.code !== 'MODEL_OUTPUT_INVALID') return '';
    const detail = error.detail?.error?.detail || error.detail;
    const rows = [...(Array.isArray(detail?.errors) ? detail.errors : []), ...(Array.isArray(detail?.warnings) ? detail.warnings : [])]
      .map(row => ['code', 'path', 'message'].map(key => typeof row?.[key] === 'string' ? row[key] : '').filter(Boolean).join('：')).filter(Boolean);
    return rows.length ? '<details data-release-panel="response-diagnostics"><summary>問題の詳細（技術者向け）</summary>' + list(rows) + '</details>' : '';
  }
  function headerNoticeHtml(state, options, conn, historical, codePanel) {
    const rows = [];
    if (state.error?.message && !historical && (codePanel.open || !(state.phase === 'incomplete' && (state.artifacts || []).some(a => a.error?.message === state.error.message || a.result?.artifactOutcome?.message === state.error.message)))) rows.push({ kind: 'error', code: state.error.code, message: state.error.message });
    if (conn.connected === false || conn.available === false) rows.push({ kind: 'connection', message: conn.message || 'AIサービスへ接続してください。' });
    if (options.notice) rows.push({ kind: 'notice', message: options.notice });
    if (!rows.length) return '';
    const first = rows[0], label = first.kind === 'error' ? first.code === 'MONTHLY_LIMIT_EXCEEDED' ? 'AIの利用状況を確認してください' : first.code === 'BUDGET_EXCEEDED' ? 'AIの利用上限に達しました' : '処理を完了できませんでした' : first.kind === 'connection' ? '接続を確認してください' : 'お知らせ';
    return `<details class="ktr-header-notice" data-release-panel="header-notice" data-release-notice="${esc(JSON.stringify(rows))}"><summary><span role="${first.kind === 'error' ? 'alert' : 'status'}">${esc(label)}</span>${rows.length > 1 ? `<small>ほか${rows.length - 1}件</small>` : ''}</summary><div class="ktr-header-notice-body" tabindex="0" aria-label="通知の詳細">${rows.map(row => `<section><p${row.kind === 'error' ? ' class="ktr-error"' : ''}>${esc(row.message)}</p>${row.kind === 'connection' ? button('connect', '接続する') : ''}</section>`).join('')}${button('close-notice', '通知を閉じる')}</div></details>`;
  }
  function chatModeHtml(state, options, smalltalk) {
    if (!options.smalltalk) return '<h2 class="ktr-pane-title">相談</h2>';
    const disabled = busy.has(state.phase) || !!options.sending || !!smalltalk?.pending;
    return '<div class="ktr-chat-mode" role="group" aria-label="チャットの種類">' +
      button('smalltalk-close', 'アプリの相談', { disabled, extra: ' aria-pressed="' + !smalltalk?.open + '"' }) +
      button('smalltalk-open', '雑談', { disabled, extra: ' aria-pressed="' + !!smalltalk?.open + '"' }) +
      '<span class="ktr-note">' + (smalltalk?.open ? 'クレジット消費なし・月300回まで（契約全体）' : '設定をもとに相談') + '</span></div>';
  }
  function smalltalkHtml(s, conn) {
    const disabled=s.pending||conn.canSmalltalk!==true;
    const quota=s.usage;
    const count=quota ? '今月 '+quota.monthly.used+'/'+quota.monthly.limit+'回（契約全体で共有）' : 'スターター・スタンダード共通で1契約につき月300回。1日制限はありません。毎月1日（日本時間）に更新します。送信開始後は中断しても1回に数えます。';
    const exhausted=quota&&quota.monthly.remaining===0;
    const resets=exhausted ? new Date(quota.monthly.resetsAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})+'（日本時間）から利用できます。' : '';
    return '<p class="ktr-note">アプリの設定は送りません。入力した文章と直近3往復までの雑談をAIへ送ります。</p><details data-release-panel="smalltalk-quota"><summary>無料枠について</summary><p>'+esc(count)+'</p><p>'+esc(resets)+'</p></details>'+
      '<div class="ktr-chat-log" aria-label="雑談の記録"><div class="ktr-messages">'+s.turns.map(t=>'<article class="ktr-message ktr-user"><strong>あなた</strong><p style="white-space:pre-wrap">'+esc(t.user)+'</p></article>'+(t.reply?'<article class="ktr-message ktr-assistant"><strong>AI</strong><p style="white-space:pre-wrap">'+esc(t.reply)+'</p>'+(t.handoff?'<p class="ktr-note">雑談ではアプリの設定を確認していません。設定に合わせた変更案は、この画面の［アプリの相談］で作れます。</p>'+button('smalltalk-handoff','この話をアプリの相談へ',{id:t.id,disabled:s.pending})+'<p class="ktr-note">下書きを入れるだけです。通常の相談で送信すると1クレジットを使います。</p>':'')+'</article>':'')).join('')+(s.pending?'<div class="ktr-chat-pending" role="status">'+activity+'返答を考えています</div>':'')+'</div></div>'+
      (s.error?'<p class="ktr-error" role="alert">'+esc(s.error)+'</p>':'')+(exhausted?'<p class="ktr-note">'+esc(resets)+'</p>':'')+
      (conn.canSmalltalk!==true?'<p class="ktr-note">雑談には対応したAIサービスと有効なToolkit契約での接続が必要です。</p>':'')+
      '<div class="ktr-composer"><label for="kt-smalltalk-input">雑談（100文字以内）</label><textarea id="kt-smalltalk-input" '+(s.pending?'disabled':'')+' placeholder="ちょっとひと息、話してみましょう">'+esc(s.draft)+'</textarea><div class="ktr-compose-actions"><span>100文字以内・クレジット消費なし</span>'+button(s.pending?'smalltalk-cancel':'smalltalk-send',s.pending?'中断する':'送信',{primary:!s.pending,disabled:!s.pending&&disabled})+'</div></div>';
  }
  function render(state, options = {}) {
    const smalltalk = options.smalltalk?.getState();
    const conn = connectionOf(options), last = (state.runs || []).at(-1), historical = options.selectedRunId ? (state.runs || []).find(r => r.id === options.selectedRunId) : null;
    const codePanel = typeof options.codePanelState === 'function' ? options.codePanelState() : {};
    const creation = state.phase === 'incomplete' ? creationMessage(state) : null;
    const currentPhaseText = state.phase === 'checking-result' ? state.progress || phaseText[state.phase] : phaseText[state.phase];
    const codeAttention = codePanel.open && !historical ? (creation?.title || (state.phase === 'blocked' ? '反映前の確認が完了していません。' : '')) : '';
    const explanation = !historical ? (state.explanations || []).find(item => item.id === state.explanationId) : null;
    let body = '';
    if (historical) body = runHtml(historical, { ...options, operationBusy: busy.has(state.phase) }, true);
    else if (busy.has(state.phase)) body = `<section class="ktr-section ktr-progress" aria-live="polite"><div class="ktr-working-heading">${activity}<h2>${esc(state.phase === 'consulting' ? '返答を考えています' : currentPhaseText)}</h2></div><p role="status">${esc(state.progress || (state.phase === 'consulting' ? '返答を作成しています。' : '処理を進めています。'))}</p>${['consulting', 'building', 'preparing'].includes(state.phase) ? button('cancel', '中断する') : '<p class="ktr-note">処理が終わるまで、この画面を開いたままにしてください。</p>'}</section>${explanation ? explanationHtml(explanation) : state.adopted || state.proposal ? proposalHtml(state, { ...options, readOnly: true, proposal: state.adopted || state.proposal }) : ''}`;
    else if (explanation) body = explanationHtml(explanation);
    else if (state.phase === 'proposal') body = proposalHtml(state, options);
    else if (state.phase === 'review') body = reviewHtml(state, options);
    else if (state.phase === 'incomplete') body = incompleteHtml(state, options);
    else if (state.phase === 'unchanged') body = `<section class="ktr-section"><h2>反映する変更はありません</h2><p>確認した範囲は、現在の内容で実現しています。設定やJavaScriptの登録は行いません。</p>${list(state.adopted?.behaviors || [])}<div class="ktr-actions">${button('new-task', '別の変更を相談する', { primary: true })}</div></section>`;
    else if (state.phase === 'blocked') body = `<section class="ktr-section"><h2>内容を確認してください</h2>${list([...new Map((state.prepared?.reasons || []).map(r => [textOf(r), r])).values()], 'ktr-reasons')}${state.error?.code === 'PLAN_QUESTION' ? list((state.plan?.questions || []).map(question => ({ text: typeof question === 'string' ? question : question.question || textOf(question) }))) : ''}<p>現在の内容は反映していません。変更や回答は相談欄に入力してください。</p>${workspace.canReprepare(state) ? reprepareHtml(options) : ''}</section>`;
    else if (state.phase === 'result') body = runHtml((state.runs || []).find(run => run.id === state.resultRunId) || last, options);
    else if (state.phase === 'rollback-confirm') body = rollbackHtml(state, options);
    else body = '<section class="ktr-section"><h2>変更案</h2><p class="ktr-note">相談すると、ここに案を表示します。内容を確認してから動作テスト環境に反映します。</p></section>';
    const stage = explanation && !busy.has(state.phase) ? 'explanation' : stageOf(state.phase, !!historical), [stageIcon, stageTitle] = stageLabel[stage];
    const support = historical || explanation ? '' : `${diagnosticHtml(state.error)}${codeHtml(state)}${verificationHtml(state)}`;
    const runHistory = !explanation && state.runs?.length ? `<details data-release-panel="runs"><summary>これまでの反映</summary><ul>${state.runs.map((run, index) => `<li>${button('history', run.goal || `反映 ${index + 1}`, { id: run.id })} <span>${esc(run.rollback?.status === 'complete' ? '元に戻し済み' : ({ complete: '反映済み', partial: '一部反映', failed: '未完了', unknown: '結果未確認' }[run.status] || '処理中'))}</span></li>`).join('')}</ul></details>` : '';
    return `<div class="ktr-workspace${codePanel.open ? ' ktr-code-open' : ''}" data-release-phase="${esc(state.phase)}"><style>${styles}</style><div class="ktr-content"><header class="ktr-header"><div class="ktr-heading"><div class="ktr-title-line"><strong>${esc(options.appName || 'アプリの相談')}</strong>${headerNoticeHtml(state, options, conn, historical, codePanel)}</div><div class="ktr-heading-meta"><span class="ktr-environment">動作テスト環境</span><div data-release-history-status>${historyStatusHtml(options)}</div></div></div><div class="ktr-header-tools"><span class="ktr-phase">${esc(historical ? '過去の反映記録' : stage === 'explanation' ? '説明' : creation?.label || currentPhaseText || '相談')}</span><nav class="ktr-tools" aria-label="補助操作">${codePanel.available ? button('code', codePanel.open ? '変更案・結果を見る' : 'コード・差分を見る', { extra: ' aria-expanded="' + !!codePanel.open + '" aria-controls="' + esc(codePanel.id) + '"' }) : ''}${button('connect', '接続')}${button('diagnose', 'アプリを診断', { disabled: !!smalltalk?.open || busy.has(state.phase) || conn.connected === false || conn.available === false || conn.canConsult === false || conn.canDiagnose !== true || !!options.sending || !!historical, extra: ' title="' + (conn.canDiagnose !== true ? '診断には対応したAIサービスへの接続が必要です' : sharedCredits(conn.usage) ? '現在の設定をAIで確認します（1クレジット）' : '現在の設定をAIで確認します（相談1回）') + '"' })}${button('documents', '資料を作る', {disabled: !!smalltalk?.open})}${button('pending-changes', '未反映の変更を見る')}${button('details', 'アプリの情報を見る')}${typeof options.onHistory === 'function' ? button('saved-history', '保存した会話', { disabled: busy.has(state.phase) || !!options.sending || !!options.switching }) : ''}</nav></div></header>
      <div class="ktr-layout"><section class="ktr-conversation" aria-label="相談">${chatModeHtml(state, options, smalltalk)}${smalltalk?.open ? smalltalkHtml(smalltalk, conn) : `${codeAttention ? `<aside class="ktr-code-attention" role="status"><p>${esc(codeAttention)}</p>${button('code', '変更案・結果を見る')}</aside>` : ''}${codePanel.open && busy.has(state.phase) ? `<div class="ktr-code-progress" role="status">${activity}<span>${esc(state.progress || (state.phase === 'consulting' ? '返答を作成しています。' : phaseText[state.phase]))}</span>${['consulting', 'building', 'preparing'].includes(state.phase) ? button('cancel', '中断する') : ''}</div>` : ''}<div class="ktr-chat-log" data-release-panel="conversation" tabindex="0" aria-label="相談の記録">${historyHtml(state.messages)}${state.phase === 'consulting' && !historical && !codePanel.open ? `<div class="ktr-chat-pending" role="status">${activity}<span>返答を待っています</span></div>` : ''}</div>${composer(state, { ...options, historical: !!historical })}`}</section><main class="ktr-current"${codePanel.open ? ' hidden' : ''} aria-label="説明・変更案・反映結果" data-release-stage="${stage}">${explanationNavigation(state, explanation, historical)}<header class="ktr-stage-header"><span class="ktr-stage-icon" aria-hidden="true">${stageIcon}</span><span>${esc(historical ? '過去の反映記録' : stageTitle)}</span></header>${body}${support || runHistory ? `<div class="ktr-support">${support}${runHistory}</div>` : ''}</main></div></div></div>`;
  }
  function create(host, options = {}) {
    if (!host || !options.controller) throw new Error('作業面を表示するための情報がありません。');
    const controller = options.controller;
    let draft = '', selectedRunId = null, notice = '', disposed = false, sending = false, switching = false;
    const expanded = new Set(), displayListeners = new Set(), draftListeners = new Set();
    let previousPhase = controller.getState().phase, previousRunId = null, previousMessageCount = 0, previousExplanationId = null, previousSmalltalkSignature = null;
    function draw(state = controller.getState()) {
      if (disposed) return;
      const smallState=options.smalltalk?.getState(), smallSignature=smallState?.open ? smallState.turns.length+':'+smallState.turns.filter(t=>t.reply!==null).length+':'+smallState.pending : null;
      const modeFocus = host.ownerDocument?.activeElement?.closest?.('.ktr-chat-mode button')?.dataset.releaseAction;
      const smallInput = host.querySelector?.('#kt-smalltalk-input'), smallFocused = smallInput && host.ownerDocument?.activeElement === smallInput;
      const smallSelection = smallFocused ? [smallInput.selectionStart, smallInput.selectionEnd] : null;
      const input = host.querySelector?.('#kt-release-input'), focused = !!input && host.ownerDocument?.activeElement === input;
      if (input) draft = input.value;
      const selection = focused ? [input.selectionStart, input.selectionEnd] : null;
      const activeSuggestion = host.ownerDocument?.activeElement?.dataset;
      const suggestionFocus = activeSuggestion?.releaseSuggestion ? { id: activeSuggestion.releaseSuggestion, task: activeSuggestion.releaseTask, version: activeSuggestion.releaseVersion } : null;
      const log = host.querySelector?.('.ktr-chat-log'), current = host.querySelector?.('.ktr-current'), layoutTop = host.querySelector?.('.ktr-layout')?.scrollTop || 0, contentTop = host.querySelector?.('.ktr-content')?.scrollTop || 0;
      const logTop = log?.scrollTop || 0, followMessages = !log || log.scrollHeight - log.clientHeight - logTop < 24;
      const currentTop = previousPhase === state.phase && previousRunId === selectedRunId && previousExplanationId === state.explanationId ? current?.scrollTop || 0 : 0;
      const previousNotice = host.querySelector?.('[data-release-panel="header-notice"]');
      const noticeFocus = Array.from(previousNotice?.querySelectorAll('summary,[tabindex],button') || []).indexOf(host.ownerDocument?.activeElement);
      const noticeTop = previousNotice?.querySelector('.ktr-header-notice-body')?.scrollTop || 0;
      // Preserve the borrowed editor, its model and focus across conversation redraws.
      const codePanel = options.codePanelElement?.();
      const codeFocus = codePanel?.contains(host.ownerDocument?.activeElement) ? host.ownerDocument.activeElement : null;
      codePanel?.remove();
      host.innerHTML = render(state, { ...options, draft, sending: sending || switching || !!options.smalltalk?.getState().pending, switching, selectedRunId, notice });
      if (codePanel) host.querySelector('.ktr-layout').appendChild(codePanel);
      codeFocus?.focus?.({ preventScroll: true });
      const nextNotice = host.querySelector?.('[data-release-panel="header-notice"]'), sameNotice = nextNotice?.dataset.releaseNotice === previousNotice?.dataset.releaseNotice;
      if (!sameNotice) expanded.delete('header-notice');
      host.querySelectorAll?.('details[data-release-panel]').forEach(el => { if (expanded.has(el.dataset.releasePanel)) el.open = true; });
      if (noticeFocus >= 0 && nextNotice) (sameNotice && nextNotice.open ? nextNotice.querySelectorAll('summary,[tabindex],button')[noticeFocus] : nextNotice.querySelector('summary'))?.focus?.({ preventScroll: true });
      if (sameNotice && nextNotice?.open) nextNotice.querySelector('.ktr-header-notice-body').scrollTop = noticeTop;
      const nextInput = host.querySelector?.('#kt-release-input');
      if (nextInput) nextInput.value = draft;
      if (modeFocus) host.querySelector('[data-release-action="' + modeFocus + '"]')?.focus({ preventScroll: true });
      const nextSmall=host.querySelector?.('#kt-smalltalk-input');
      if(smallFocused&&nextSmall&&!nextSmall.disabled){nextSmall.focus({preventScroll:true});nextSmall.setSelectionRange?.(...smallSelection);}
      if (focused && nextInput && !nextInput.disabled) { nextInput.focus({ preventScroll: true }); if (selection && typeof nextInput.setSelectionRange === 'function') nextInput.setSelectionRange(...selection); }
      if (suggestionFocus) {
        const checkbox = Array.from(host.querySelectorAll?.('[data-release-suggestion]') || []).find(el => el.dataset.releaseSuggestion === suggestionFocus.id && el.dataset.releaseTask === suggestionFocus.task && el.dataset.releaseVersion === suggestionFocus.version);
        if (checkbox && !checkbox.disabled) checkbox.focus?.({ preventScroll: true });
      }
      const nextLog = host.querySelector?.('.ktr-chat-log'), nextCurrent = host.querySelector?.('.ktr-current');
      if (nextLog) nextLog.scrollTop = followMessages && (state.messages?.length !== previousMessageCount || previousPhase !== state.phase || smallSignature !== previousSmalltalkSignature) ? nextLog.scrollHeight : logTop;
      if (nextCurrent) nextCurrent.scrollTop = currentTop;
      const nextLayout = host.querySelector?.('.ktr-layout'); if (nextLayout) nextLayout.scrollTop = layoutTop;
      const nextContent = host.querySelector?.('.ktr-content'); if (nextContent) nextContent.scrollTop = contentTop;
      for (const listener of displayListeners) listener();
      previousSmalltalkSignature = smallSignature; previousPhase = state.phase; previousRunId = selectedRunId; previousExplanationId = state.explanationId; previousMessageCount = state.messages?.length || 0;
    }
    // Autosave status changes must not replace the composer during IME input.
    function updateHistoryStatus() {
      if (disposed) return;
      const slot = host.querySelector?.('[data-release-history-status]');
      if (!slot) return;
      const markup = historyStatusHtml(options);
      if (slot.innerHTML === markup) return;
      const previous = slot.querySelector('details'), wasOpen = !!previous?.open;
      const hadFocus = !!previous && previous.querySelector('summary') === host.ownerDocument?.activeElement;
      const scrollTop = previous?.querySelector('.ktr-history-status-message')?.scrollTop || 0;
      slot.innerHTML = markup;
      const next = slot.querySelector('details');
      if (next && wasOpen) { next.open = true; expanded.add('history-status'); }
      else expanded.delete('history-status');
      if (next && hadFocus) next.querySelector('summary')?.focus?.({ preventScroll: true });
      if (next?.open) { const message = next.querySelector('.ktr-history-status-message'); if (message) message.scrollTop = scrollTop; }
    }
    function updateDraftGuard() {
      const pending = draftPending({ draft, smalltalk: options.smalltalk, sending: sending || switching });
      host.querySelectorAll?.('[data-release-base-disabled]').forEach(el => { el.disabled = el.dataset.releaseBaseDisabled === 'true' || pending; });
      host.querySelectorAll?.('[data-release-draft-note]').forEach(el => { el.hidden = !pending; });
      const state = controller.getState();
      host.querySelectorAll?.('[data-release-suggestion]').forEach(el => { el.disabled = sending || switching || !!selectedRunId || state.phase !== 'proposal' || state.proposalPending || Number(el.dataset.releaseTask) !== state.taskId || Number(el.dataset.releaseVersion) !== state.version; });
    }
    function setDraft(value) {
      if (disposed) return false;
      const next = String(value ?? ''), changed = next !== draft;
      draft = next;
      const input = host.querySelector?.('#kt-release-input');
      if (input && input.value !== draft) input.value = draft;
      updateDraftGuard();
      if (changed) for (const listener of draftListeners) listener(draft);
      return changed;
    }
    function inputChanged(event) { if(event.target?.id==='kt-smalltalk-input'){options.smalltalk?.setDraft(event.target.value);return;} if (event.target?.id === 'kt-release-input') setDraft(event.target.value); }
    function canSend(purpose = controller.getState().requestPurpose) {
      const state = controller.getState(), conn = connectionOf(options);
      return !disposed && !options.smalltalk?.getState().open && !options.smalltalk?.getState().pending && !sending && !switching && !busy.has(state.phase) && !state.runs?.some(run => run.id === selectedRunId) && conn.connected !== false && conn.available !== false && (purpose === 'document' ? !documentBlocked(conn) : conn.canConsult !== false);
    }
    async function send(request, onStart, suggestionReference = null, requestOptions = null) {
      const fromDocument = typeof request === 'string' && !suggestionReference;
      const explicitPurpose = requestOptions?.diagnosis ? 'ideation' : 'document';
      if (!canSend(fromDocument ? explicitPurpose : controller.getState().requestPurpose)) return false;
      const input = host.querySelector?.('#kt-release-input'), fromTemplate = typeof request === 'string' && !suggestionReference;
      const value = String(suggestionReference ? workspace.suggestionRequest(controller.getState()) : fromTemplate ? request : input?.value ?? draft).trim();
      if (!value) return false;
      sending = true; updateDraftGuard();
      let cleared = false, sentTaskId = null;
      const restoreInput = () => {
        const activeInput = host.querySelector?.('#kt-release-input');
        if (!cleared || disposed || controller.getState().taskId !== sentTaskId || String(activeInput?.value ?? draft).trim()) return;
        setDraft(value);
      };
      try {
        if (typeof options.beforeSend === 'function' && await options.beforeSend() === false) return false;
        const conn = connectionOf(options);
        if (disposed || busy.has(controller.getState().phase) || conn.connected === false || conn.available === false || ((fromTemplate ? explicitPurpose : controller.getState().requestPurpose) === 'document' ? documentBlocked(conn) : conn.canConsult === false)) return false;
        if (suggestionReference && (controller.getState().taskId !== suggestionReference.taskId || controller.getState().version !== suggestionReference.version)) return false;
        if (suggestionReference && String(host.querySelector?.('#kt-release-input')?.value ?? draft).trim()) return false;
        if (!fromTemplate) { cleared = true; sentTaskId = controller.getState().taskId; setDraft(''); }
        selectedRunId = null; notice = '';
        onStart?.();
        const sent = suggestionReference ? await controller.updateSuggestions(suggestionReference) : await controller.send(value, fromTemplate ? { ...requestOptions, requestPurpose: explicitPurpose } : undefined);
        if (sent === false) restoreInput();
        return sent !== false;
      } catch (error) { restoreInput(); throw error; } finally { sending = false; updateDraftGuard(); }
    }
    async function act(action, id, target = {}) {
      if (disposed || switching) return;
      const state = controller.getState();
      if(action==='smalltalk-cancel')return options.smalltalk?.cancel();
      if(options.smalltalk?.getState().pending)return;
      if(action==='smalltalk-open'||action==='smalltalk-close'){
        if(sending||busy.has(state.phase))return;
        if (action === 'smalltalk-close' && options.smalltalk?.getState().open) return options.smalltalk.close();
        if (action === 'smalltalk-open' && !options.smalltalk?.getState().open) return options.smalltalk?.toggle();
        return;
      }
      if(action==='smalltalk-send')return sendSmalltalk();
      if(action==='smalltalk-handoff'){
        if(sending||busy.has(state.phase))return;
        if(draft.trim()){notice='元の相談欄の入力は残しています。内容を整理してから移してください。';draw();return;}
        const text=options.smalltalk?.handoff(id);if(!text)return;
        options.smalltalk.close();controller.setConsultationTarget(null);controller.setRequestPurpose('consultation');setDraft(text);return;
      }
      if(options.smalltalk?.getState().open && (draftActions.has(action)||['diagnose','documents','send'].includes(action)))return;
      if (draftActions.has(action) && draftPending({ draft: host.querySelector?.('#kt-release-input')?.value ?? draft, sending })) return;
      if (action === 'send') return send();
      if (action === 'diagnose') {
        if (connectionOf(options).canDiagnose !== true) return;
        return send('このアプリの設定と登録済みJavaScriptを診断してください。確認が必要な点と、任意の改善案を分けてください。', null, null, { diagnosis: true, consultationTarget: null });
      }
      if (action === 'consult-diagnosis') {
        if (!canSend('consultation') || String(host.querySelector?.('#kt-release-input')?.value ?? draft).trim()) {
          notice = '相談欄の入力は残しています。送信するか内容を整理してから、改善する項目を選んでください。'; draw(); return;
        }
        const document = state.explanations.find(e => e.id === id), index = Number(target.dataset?.releaseSection);
        const section = Number.isInteger(index) && index >= 0 ? document?.sections?.[index] : null;
        if (!document?.diagnosisSource || !section?.evidenceIds?.length) return;
        const excerpt = explanationMarkdown({ title: section.heading, sections: [section], unknowns: document.unknowns, facts: document.facts });
        controller.setConsultationTarget(null);
        controller.setRequestPurpose('consultation');
        setDraft('次の診断項目について改善を相談したいです。まだ変更は採用していません。現在の設定を確認し、変更範囲・順序・未確認事項・変更後の確認項目を整理してください。ほかの診断項目は取り込まないでください。\n\n' + '診断の取得元：動作テスト環境・アプリ ' + document.diagnosisSource.appId + '・設定の版 ' + (document.diagnosisSource.revision ?? '不明') + '。取得後の変更は未確認です。\n\n' + excerpt);
        host.querySelector?.('#kt-release-input')?.focus?.(); return;
      }
      if (action === 'adopt' && connectionOf(options).canCreate === false) return;
      if (action === 'resume' && resumeBlocked(connectionOf(options))) return;
      if (action === 'focus-consultation') { if (!busy.has(state.phase)) { controller.setRequestPurpose('consultation'); host.querySelector?.('#kt-release-input')?.focus?.(); } return; }
      if (action === 'code') {
        const opened = options.onToggleCode?.();
        if (opened === false) host.querySelector?.('[data-release-action="code"]')?.focus?.({ preventScroll: true });
        return;
      }
      if (action === 'clear-consultation-target' && !sending) return controller.setConsultationTarget(null);
      if (action === 'update-suggestions') return send(undefined, undefined, { taskId: Number(target.dataset?.releaseTask), version: Number(target.dataset?.releaseVersion) });
      if (action === 'current') { selectedRunId = null; notice = ''; draw(); return; }
      if (action === 'history') { selectedRunId = id; draw(); return; }
      if (action === 'show-explanation' || action === 'show-changes') {
        if (busy.has(state.phase)) return;
        selectedRunId = null; notice = '';
        return action === 'show-explanation' ? controller.showExplanation(id) : controller.showChanges();
      }
      if (action === 'copy-explanation' || action === 'download-explanation') {
        const document = (state.explanations || []).find(item => item.id === id);
        if (!document) return;
        const markdown = explanationMarkdown(document);
        if (action === 'copy-explanation') {
          if (typeof options.onCopy !== 'function') { notice = '説明の本文を選択してコピーしてください。'; draw(); return; }
          await options.onCopy(markdown); notice = '説明をコピーしました。';
        } else {
          if (typeof options.onDownload !== 'function') return;
          await options.onDownload('アプリの説明.md', markdown, 'text/markdown;charset=utf-8'); notice = '説明を保存しました。';
        }
        draw(); return;
      }
      if (action === 'answer') { controller.setRequestPurpose('consultation'); setDraft(target.dataset?.releaseAnswer || ''); host.querySelector?.('#kt-release-input')?.focus?.(); return; }
      if (action === 'new-task') {
        if (sending || busy.has(state.phase)) return;
        try {
          const pending = typeof options.onNewTask === 'function' ? options.onNewTask() : true;
          switching = true; draw();
          if (await pending === false) return false;
          if (disposed || sending || busy.has(controller.getState().phase)) return false;
          setDraft(''); selectedRunId = null; notice = '';
          return controller.newTask();
        } finally { switching = false; draw(); }
      }
      if (action === 'saved-history') {
        if (sending || busy.has(state.phase)) return;
        return options.onHistory?.();
      }
      if (action === 'cancel-rollback') return controller.cancelRollback();
      if (action === 'request-rollback') { selectedRunId = null; return controller.requestRollback(id); }
      if (action === 'rollback') return controller.rollback(id);
      if (action === 'reprepare') return controller.reprepare();
      if (action === 'recheck-apply') return controller.recheckApply(id);
      if (action === 'recheck-rollback') return controller.recheckRollback(id);
      if (['adopt', 'resume', 'apply', 'cancel'].includes(action)) { notice = ''; return controller[action](); }
      if (action === 'copy-code' || action === 'download-code') {
        const artifact = state.artifacts.find(a => a.customizationId === id), result = artifact?.result;
        const body = bodyOf(result);
        if (typeof body !== 'string') return;
        if (action === 'copy-code') { if (typeof options.onCopy !== 'function') { notice = 'コードを選択してコピーしてください。'; draw(); return; } await options.onCopy(body); notice = 'コードをコピーしました。'; }
        else { if (typeof options.onDownload !== 'function') return; await options.onDownload(result.generated?.targetFile || result.targetFile || 'customization.js', body); notice = 'ファイルを保存しました。'; }
        draw(); return;
      }
      if (action === 'pending-changes') return options.onPendingChanges?.();
      if (action === 'documents') return options.onDocuments?.({ request: send, canRequest: () => canSend('document'), hasDraft: () => !!String(host.querySelector?.('#kt-release-input')?.value ?? draft).trim() });
      const handlers = { connect: options.onConnect, 'refresh-connection': options.onRefreshConnection, details: options.onDetails, preview: options.onOpenPreview };
      if (typeof handlers[action] === 'function') { await handlers[action](); draw(); }
    }
    async function sendSmalltalk() {
      const doc = host.ownerDocument;
      let returnFocus = true;
      const movedAway = event => {
        if (!event.target?.closest?.('#kt-smalltalk-input,[data-release-action="smalltalk-send"]')) returnFocus = false;
      };
      // Only return focus for this send; do not interrupt another interaction while waiting.
      for (const name of ['pointerdown', 'focusin', 'keydown']) doc.addEventListener(name, movedAway);
      try {
        const sent = await options.smalltalk?.submit();
        const input = host.querySelector?.('#kt-smalltalk-input');
        if (sent && returnFocus && !disposed && options.smalltalk?.getState().open && input && !input.disabled && input.getClientRects().length && doc.visibilityState !== 'hidden' && doc.hasFocus()) input.focus({ preventScroll: true });
      } finally {
        for (const name of ['pointerdown', 'focusin', 'keydown']) doc.removeEventListener(name, movedAway);
      }
    }
    function closeNotice() {
      const panel = host.querySelector?.('[data-release-panel="header-notice"]');
      if (panel) { panel.open = false; expanded.delete('header-notice'); panel.querySelector('summary')?.focus?.({ preventScroll: true }); }
    }
    async function clicked(event) {
      const target = event.target?.closest?.('[data-release-action]') || (event.target?.dataset?.releaseAction ? event.target : null);
      if (!target || target.disabled) return;
      event.preventDefault?.();
      if (target.dataset.releaseAction === 'close-notice') { closeNotice(); return; }
      try { await act(target.dataset.releaseAction, target.dataset.releaseId, target); } catch (error) { notice = error?.message || '操作を完了できませんでした。'; draw(); }
    }
    function suggestionChanged(event) {
      const target = event.target;
      if (!target?.dataset?.releaseSuggestion || target.disabled || disposed || sending || switching || selectedRunId) return;
      controller.selectSuggestion(target.dataset.releaseSuggestion, target.checked === true, { taskId: Number(target.dataset.releaseTask), version: Number(target.dataset.releaseVersion) });
    }
    function keydown(event) { if(event.target?.id==='kt-smalltalk-input'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault?.();sendSmalltalk();return;} if (event.key === 'Escape' && event.target?.closest?.('.ktr-header-notice')) { event.preventDefault?.(); closeNotice(); return; } if (event.target?.id === 'kt-release-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault?.(); send().catch(error => { notice = error.message; draw(); }); } }
    function toggled(event) { const key = event.target?.dataset?.releasePanel; if (key) { if (event.target.open) expanded.add(key); else expanded.delete(key); } }
    host.addEventListener('click', clicked);
    host.addEventListener('input', inputChanged);
    host.addEventListener('change', suggestionChanged);
    host.addEventListener('keydown', keydown);
    host.addEventListener('toggle', toggled, true);
    const unsubscribe = controller.subscribe(draw);
    draw();
    return { updateHistoryStatus, newTask: () => act('new-task'), canSwitchSession() { return !options.smalltalk?.getState().pending && !disposed && !sending && !switching && !busy.has(controller.getState().phase); }, resetDisplay() { if (disposed) return; selectedRunId = null; notice = ''; expanded.clear(); draw(); }, getDraft: () => String(host.querySelector?.('#kt-release-input')?.value ?? draft), setDraft, subscribeDraft(fn) { draftListeners.add(fn); return () => draftListeners.delete(fn); }, canRequestDocument: () => canSend('document'), requestDocument: (text, sendOptions) => send(text, null, null, sendOptions), render: draw, getSelectedRunId: () => selectedRunId, subscribeDisplay(fn) { displayListeners.add(fn); return () => displayListeners.delete(fn); }, onVisible() { draw(); }, canFocusConsultation() { return !options.smalltalk?.getState().pending && !disposed && !sending && !switching && !selectedRunId && !busy.has(controller.getState().phase); }, focusConsultation(text) { if(options.smalltalk?.getState().open)options.smalltalk.close(); const input = host.querySelector?.('#kt-release-input'); if (input && !input.value.trim()) { setDraft(text); } input?.focus?.(); }, dispose() { disposed = true; displayListeners.clear(); draftListeners.clear(); unsubscribe(); host.removeEventListener?.('click', clicked); host.removeEventListener?.('input', inputChanged); host.removeEventListener?.('change', suggestionChanged); host.removeEventListener?.('keydown', keydown); host.removeEventListener?.('toggle', toggled, true); } };
  }
  const styles = `
    .ktr-workspace,.kt-release-dialog{--ktr-text:var(--kt-text,#253247);--ktr-muted:var(--kt-muted,#58677d);--ktr-line:var(--kt-line,#dbe2ec);--ktr-paper:var(--kt-paper,#fff);--ktr-soft:var(--kt-soft,#f5f7fb);--ktr-accent:var(--kt-accent,#285fbd);--ktr-primary:var(--kt-primary,#285fbd);--ktr-warning:var(--kt-warning,#805c15);--ktr-danger:var(--kt-danger,#9d3d22);--ktr-success:var(--kt-success,#24634f);color:var(--ktr-text);background:var(--ktr-paper);font:14px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;box-sizing:border-box;overflow-wrap:anywhere}
    .ktr-consult-target{padding:8px;border:1px solid var(--ktr-line);border-radius:6px;margin:8px 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap}.ktr-consult-target small{flex-basis:100%;color:var(--ktr-muted)}
    .ktr-workspace{flex:0 0 auto;width:100%;height:100%;max-width:none;min-width:0;min-height:0;margin:0;padding:clamp(14px,1.5%,20px);overflow:hidden;container:ktr-workspace / inline-size}.ktr-content{display:flex;flex-direction:column;width:100%;height:100%;max-width:none;min-width:0;min-height:0;margin:0 auto}.ktr-header{flex:none}.ktr-layout{flex:1;min-height:0;min-width:0;overflow:auto}.ktr-conversation,.ktr-current{min-width:0;min-height:0}.ktr-conversation{display:flex;flex-direction:column}.ktr-workspace .ktr-pane-title{font-size:16px;margin:0 0 12px;flex:none}.ktr-chat-log{flex:1 1 auto;min-height:180px;max-height:42dvh;overflow:auto;scrollbar-gutter:stable}.ktr-current{border-top:1px solid var(--ktr-line);padding-top:24px;margin-top:24px;scrollbar-gutter:stable}.ktr-empty-chat{color:var(--ktr-muted)}.ktr-header-tools{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap}.ktr-tools{display:flex;gap:6px;flex-wrap:wrap}.ktr-workspace .ktr-tools button{font-size:12px;padding:6px 10px}
    .ktr-workspace *,.kt-release-dialog *{box-sizing:border-box}.ktr-workspace h2,.kt-release-dialog h2{font-size:20px;line-height:1.4;margin:0 0 14px}.ktr-workspace h3,.kt-release-dialog h3{font-size:15px;margin:20px 0 8px}.ktr-workspace p,.kt-release-dialog p{margin:8px 0 14px;white-space:pre-wrap}.ktr-workspace ul,.ktr-workspace ol{margin:8px 0 18px;padding-left:24px}.ktr-workspace li{margin:7px 0}
    .ktr-heading-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ktr-history-status{font-size:11px;color:var(--ktr-muted)}.ktr-history-status[data-release-history-state="error"],.ktr-history-status[data-release-history-state="unavailable"]{color:var(--ktr-danger)}.ktr-workspace .ktr-history-status-detail{margin:0;font-size:11px}.ktr-workspace .ktr-history-status-detail>summary{padding:0}.ktr-history-status-message{position:absolute;z-index:5;left:0;top:calc(100% - 8px);width:min(420px,100%);max-height:30dvh;overflow:auto;padding:12px;border:1px solid var(--ktr-line);border-radius:8px;background:var(--ktr-paper);box-shadow:0 6px 20px #0002}.ktr-history-status-message>p{margin:0;font-size:12px}
    .ktr-heading{min-width:0}.ktr-title-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ktr-workspace .ktr-header-notice{margin:0;min-width:0;max-width:100%;font-size:12px;color:var(--ktr-muted)}.ktr-workspace .ktr-header-notice>summary{display:flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid var(--ktr-line);border-radius:6px;cursor:pointer;list-style:none}.ktr-header-notice>summary::-webkit-details-marker{display:none}.ktr-header-notice>summary:after{content:'▾';color:var(--ktr-muted)}.ktr-header-notice[open]>summary:after{content:'▴'}.ktr-header-notice>summary [role="alert"]{color:var(--ktr-danger)}.ktr-header-notice>summary small{font-size:inherit;white-space:nowrap}
    .ktr-header-notice-body{position:absolute;z-index:5;top:calc(100% - 8px);left:0;width:min(520px,100%);max-height:35dvh;overflow:auto;padding:14px;border:1px solid var(--ktr-line);border-radius:8px;background:var(--ktr-paper);color:var(--ktr-text);box-shadow:0 6px 20px #0002;font-size:13px;overflow-wrap:anywhere}.ktr-header-notice-body section+section{border-top:1px solid var(--ktr-line);padding-top:8px}.ktr-header-notice-body .ktr-error{max-height:none;padding:0;border:0;background:transparent;margin:0 0 12px}.ktr-header-notice-body button{font-size:12px}
    .ktr-header{position:relative;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--ktr-line);padding-bottom:10px;margin-bottom:14px}.ktr-header strong{font-size:16px}.ktr-environment{display:block;font-size:12px;color:var(--ktr-muted)}.ktr-phase{font-size:12px;color:var(--ktr-muted);white-space:nowrap;padding:3px 8px;background:var(--ktr-soft);border-radius:5px}.ktr-section{padding-bottom:12px}.ktr-lead{font-size:15px}.ktr-note{font-size:12px;color:var(--ktr-muted)}
    .ktr-actions,.ktr-compose-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:16px 0 8px}.ktr-compose-actions{justify-content:space-between}.ktr-workspace button,.kt-release-dialog button{font:inherit;line-height:1.4;padding:7px 12px;border:1px solid var(--ktr-line);border-radius:6px;cursor:pointer;background:var(--ktr-paper);color:var(--ktr-text);max-width:100%;overflow-wrap:anywhere}.ktr-workspace button.ktr-primary,.kt-release-dialog button.ktr-primary{color:#fff;background:var(--ktr-primary);border-color:var(--ktr-primary);font-weight:600}.ktr-workspace button:disabled,.kt-release-dialog button:disabled{opacity:.5;cursor:default}.ktr-workspace button:focus-visible,.ktr-workspace textarea:focus-visible,.ktr-workspace summary:focus-visible,.kt-release-dialog :is(button,textarea,select,summary):focus-visible{outline:3px solid #83b6fb;outline-offset:3px}
    .ktr-workspace button:hover:not(:disabled),.kt-release-dialog button:hover:not(:disabled){background:var(--ktr-soft)}.ktr-workspace button.ktr-primary:hover:not(:disabled),.kt-release-dialog button.ktr-primary:hover:not(:disabled),.kt-release-dialog [data-document-create]:hover:not(:disabled){background:#204e9c}.ktr-composer:focus-within{border-color:var(--ktr-accent)}
    .ktr-request-purpose{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px}
    .ktr-chat-mode{display:flex;align-items:center;gap:4px;flex-wrap:wrap;flex:none;margin:0 0 12px}.ktr-workspace .ktr-chat-mode button{padding:6px 12px;border-color:transparent;border-radius:7px}.ktr-workspace .ktr-chat-mode button[aria-pressed="true"]{background:var(--ktr-soft);border-color:var(--ktr-line);color:var(--ktr-accent);font-weight:600}.ktr-chat-mode .ktr-note{margin:0 0 0 8px;font-size:12px}
    .ktr-composer{flex:none;margin:12px 0 0;padding:10px;border:1px solid var(--kt-input-line,#c2cddd);border-radius:12px;background:var(--ktr-paper)}.ktr-composer label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.ktr-composer textarea{display:block;width:100%;min-height:64px;max-height:120px;resize:vertical;padding:6px;font:inherit;border:0;border-radius:5px;color:var(--ktr-text);background:var(--ktr-paper)}.ktr-composer .ktr-compose-actions{margin:6px 0 0;gap:6px}.ktr-composer .ktr-compose-actions button{padding:7px 14px}.ktr-confirmations,.ktr-question,.ktr-notice{padding:14px 16px;border:1px solid var(--ktr-line);border-radius:7px;background:var(--ktr-soft);margin:16px 0}.ktr-confirmations h3,.ktr-question h3{margin-top:0}.ktr-error{max-height:24dvh;overflow:auto;padding:12px 16px;border-left:3px solid var(--ktr-danger);background:color-mix(in srgb,var(--ktr-danger) 9%,var(--ktr-paper));color:var(--ktr-danger)}.ktr-reasons{color:var(--ktr-danger)}.ktr-progress{padding:0 0 24px}
    .ktr-support{border-top:1px solid var(--ktr-line);margin-top:22px;padding-top:10px}.ktr-workspace .ktr-support-heading{display:none;font-size:15px;margin:0 0 12px;color:var(--ktr-muted)}.ktr-workspace details,.kt-release-dialog details{margin:8px 0}.ktr-workspace summary,.kt-release-dialog summary{cursor:pointer;padding:9px 0;color:var(--ktr-muted)}.ktr-workspace details[open]>summary,.kt-release-dialog details[open]>summary{font-weight:600;color:var(--ktr-text)}.ktr-workspace .ktr-messages{list-style:none;padding:0 8px 0 0;margin:0;display:flex;flex-direction:column;gap:20px}.ktr-workspace .ktr-message{max-width:94%;margin:0;padding:10px 12px;align-self:flex-start}.ktr-workspace .ktr-message.ktr-user{align-self:flex-end;padding:12px 16px;background:color-mix(in srgb,var(--ktr-accent) 9%,var(--ktr-paper));border-radius:14px 14px 4px 14px}.ktr-message p{margin:6px 0 0;line-height:1.75}.ktr-speaker{font-size:12px;font-weight:600;color:var(--ktr-muted)}.ktr-code{padding:12px 0 20px}.ktr-code pre,.ktr-setting-values,.ktr-fact-value{white-space:pre-wrap;word-break:break-word;font:12px/1.6 ui-monospace,monospace;background:var(--ktr-soft);border:1px solid var(--ktr-line);border-radius:6px;padding:14px}
    .kt-release-dialog{width:min(640px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);padding:24px;margin:auto;border:1px solid var(--ktr-line);border-radius:10px;overflow:auto;overscroll-behavior:contain}.kt-release-dialog.ktr-dialog-wide{width:min(960px,calc(100vw - 32px))}.kt-release-dialog::backdrop{background:rgba(15,23,42,.38)}.ktr-dialog-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}.kt-release-dialog .ktr-dialog-header h2{font-size:20px;margin:0}.kt-release-dialog [data-close]{flex:none;white-space:nowrap}.kt-release-dialog :is(textarea,select){font:inherit;max-width:100%;min-width:0;padding:9px 10px;border:1px solid var(--kt-input-line,#c2cddd);border-radius:6px;color:var(--ktr-text);background:var(--ktr-paper)}.kt-release-dialog textarea{width:100%}.kt-release-dialog pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}
    .ktr-template-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:10px;border:0;padding:0;margin:20px 0}.ktr-template-grid legend{font-weight:650;margin-bottom:10px}.kt-release-dialog .ktr-template-choice{display:flex;align-items:flex-start;gap:10px;padding:14px;margin:0;border:1px solid var(--ktr-line);border-radius:8px;cursor:pointer;background:var(--ktr-paper)}.ktr-template-choice:has(input:checked){border-color:var(--ktr-accent);background:var(--ktr-soft)}.ktr-template-choice input{flex:none;margin:4px 0;width:auto}.ktr-template-choice strong{display:block;margin-bottom:5px}.ktr-template-choice small{display:block;line-height:1.6;color:var(--ktr-muted)}.kt-release-dialog [data-document-create]{margin:12px 0;padding:10px 20px;color:#fff;background:var(--ktr-primary);border:1px solid var(--ktr-primary);border-radius:6px}.kt-release-dialog [data-document-create]:disabled{opacity:.5;cursor:not-allowed}.kt-release-dialog [data-offline-materials]{border-top:1px solid var(--ktr-line);padding-top:16px;margin-top:16px}.kt-release-dialog [data-document-status]{font-size:13px;color:var(--ktr-muted)}
    .ktr-suggestion-choices{display:grid;gap:8px;margin:12px 0}.ktr-suggestion-choice{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border:1px solid var(--ktr-line);border-radius:8px;cursor:pointer;background:var(--ktr-paper)}.ktr-suggestion-choice:has(input:checked){border-color:var(--ktr-accent);background:var(--ktr-soft)}.ktr-suggestion-choice:has(input:disabled){cursor:default}.ktr-suggestion-choice input{flex:none;width:18px;height:18px;margin:3px 0;accent-color:var(--ktr-accent)}.ktr-suggestion-choice span{min-width:0;overflow-wrap:anywhere}.ktr-suggestion-choice input:focus-visible{outline:3px solid #83b6fb;outline-offset:3px}
    .ktr-document-navigation{margin:0 0 18px}.ktr-document-tabs{display:flex;gap:8px;flex-wrap:wrap}.ktr-workspace .ktr-document-tabs button[aria-pressed="true"]{border-color:var(--ktr-accent);background:color-mix(in srgb,var(--ktr-accent) 9%,var(--ktr-paper));color:var(--ktr-accent);font-weight:650}.ktr-document-navigation>details>ul{list-style:none;padding:0}.ktr-explanation-section{margin:24px 0;padding-bottom:8px}.ktr-explanation-section>h3{font-size:18px}.ktr-explanation-unknowns{border-left:3px solid var(--ktr-warning);padding:4px 16px;background:color-mix(in srgb,var(--ktr-warning) 9%,var(--ktr-paper))}.ktr-table-scroll{max-width:100%;overflow:auto;margin:16px 0}.ktr-table-scroll:focus-visible{outline:3px solid #83b6fb;outline-offset:2px}.ktr-explanation table,#kt-toolkit .ktr-explanation table{width:100%;min-width:360px;border-collapse:collapse;font-size:13px}.ktr-explanation th,.ktr-explanation td,#kt-toolkit .ktr-explanation th,#kt-toolkit .ktr-explanation td{text-align:left;vertical-align:top;border:1px solid var(--ktr-line);padding:9px 10px;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--ktr-paper);color:var(--ktr-text);position:static;top:auto}.ktr-explanation th,#kt-toolkit .ktr-explanation th{background:var(--ktr-soft);font-weight:650}[data-release-stage="explanation"] .ktr-stage-header{background:color-mix(in srgb,var(--ktr-success) 9%,var(--ktr-paper));color:var(--ktr-success)}
    .ktr-stage-header{display:flex;align-items:center;gap:8px;margin-bottom:16px;padding:9px 12px;border-radius:6px;background:var(--ktr-soft);color:var(--ktr-muted);font-weight:650;font-size:13px}.ktr-stage-icon{display:grid;place-items:center;width:22px;height:22px;flex:none;border-radius:5px;background:var(--ktr-paper);font-size:13px}
    [data-release-stage="proposal"] .ktr-stage-header{background:color-mix(in srgb,var(--ktr-accent) 9%,var(--ktr-paper));color:var(--ktr-accent)}[data-release-stage="review"] .ktr-stage-header{background:color-mix(in srgb,var(--ktr-warning) 9%,var(--ktr-paper));color:var(--ktr-warning)}[data-release-stage="result"] .ktr-stage-header{background:color-mix(in srgb,var(--ktr-success) 9%,var(--ktr-paper));color:var(--ktr-success)}[data-release-stage="attention"] .ktr-stage-header{background:color-mix(in srgb,var(--ktr-danger) 9%,var(--ktr-paper));color:var(--ktr-danger)}
    [data-release-stage="proposal"]>.ktr-section>ul:first-of-type{list-style:none;padding:0;counter-reset:proposal}.ktr-current[data-release-stage="proposal"]>.ktr-section>ul:first-of-type>li{counter-increment:proposal;padding:14px 16px 14px 46px;position:relative;border:1px solid var(--ktr-line);border-radius:6px;background:var(--ktr-paper);margin:10px 0}.ktr-current[data-release-stage="proposal"]>.ktr-section>ul:first-of-type>li::before{content:counter(proposal);position:absolute;left:16px;top:14px;font-weight:700;color:var(--ktr-accent)}
    [data-release-stage="review"] .ktr-changes{list-style:none;padding:0;border-left:3px solid var(--ktr-warning)}.ktr-current[data-release-stage="review"] .ktr-changes>li{margin:0;padding:14px 16px;border-bottom:1px solid var(--ktr-line)}.ktr-changes p:last-child{margin-bottom:0}
    .ktr-working-heading{display:flex;align-items:center;gap:14px}.ktr-working-heading h2{margin:0}.ktr-progress{padding:18px;border:1px solid var(--ktr-line);border-radius:8px;background:var(--ktr-soft);margin-bottom:18px}.ktr-progress>p{margin-top:16px}.ktr-chat-pending{display:flex;align-items:center;gap:12px;padding:18px 12px;color:var(--ktr-muted);font-size:13px}
    .ktr-activity{display:inline-flex;align-items:center;gap:5px;min-height:22px;flex:none}.ktr-activity i{display:block;width:7px;height:7px;border-radius:50%;background:var(--ktr-accent);animation:ktr-pulse 1.4s ease-in-out infinite}.ktr-activity i:nth-child(2){animation-delay:.18s}.ktr-activity i:nth-child(3){animation-delay:.36s}@keyframes ktr-pulse{0%,70%,100%{opacity:.35;transform:translateY(0)}35%{opacity:1;transform:translateY(-4px)}}@media(prefers-reduced-motion:reduce){.ktr-activity i{animation:none;opacity:1}}
    @container ktr-workspace (min-width:960px){.ktr-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.08fr);grid-template-rows:minmax(0,1fr);gap:24px;overflow:hidden}.ktr-chat-log{min-height:0;max-height:none;overscroll-behavior:contain}.ktr-conversation{overflow:hidden}.ktr-current{border-top:0;border-left:1px solid var(--ktr-line);padding:0 8px 0 24px;margin:0;overflow:auto}}
    .ktr-code-slot{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;border-left:1px solid var(--ktr-line);padding-left:24px}.ktr-code-slot[hidden]{display:none}.ktr-code-open .ktr-current{display:none}.ktr-code-progress{display:flex;flex:none;gap:10px;align-items:center;flex-wrap:wrap;max-height:30%;overflow:auto;padding:10px;margin-bottom:8px;background:var(--ktr-soft);border-radius:6px}.ktr-code-progress>span:not(.ktr-activity){flex:1;min-width:120px;font-size:13px}
    .ktr-code-attention{flex:none;margin-bottom:12px;padding:12px;border-left:3px solid var(--ktr-warning);border-radius:4px;background:color-mix(in srgb,var(--ktr-warning) 9%,var(--ktr-paper))}.ktr-code-attention>p{margin:0 0 8px}
    @container ktr-workspace (max-width:959px){.ktr-code-slot{height:70dvh;min-height:420px;border-left:0;border-top:1px solid var(--ktr-line);padding:16px 0 0;margin-top:24px}}
    @media(max-height:700px){@container ktr-workspace (max-width:959px){.ktr-content{overflow:auto}.ktr-layout{flex:none;overflow:visible}}}
    @media(max-width:560px){.ktr-workspace{padding:14px}.ktr-header{gap:8px;align-items:flex-start;flex-direction:column}.ktr-header-tools{justify-content:flex-start;gap:8px}.ktr-workspace h2{font-size:19px}.ktr-actions .ktr-primary{width:100%}.ktr-compose-actions{align-items:flex-end}.ktr-phase{white-space:normal;text-align:right}.kt-release-dialog{padding:16px}.ktr-dialog-header{gap:8px}.kt-release-dialog .ktr-dialog-header h2{font-size:18px}.kt-release-dialog label{display:block;margin:8px 0}.kt-release-dialog label>select{display:block;width:100%;margin-top:4px}}
  `;
  return { create, usageHtml, usageDetailsHtml, render, escape: esc, explanationMarkdown };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseView };
