/* Deterministic display/export of settings and structured hypotheses. */
'use strict';
const KTBusinessView = (() => {
  const C=typeof KTBusinessContract!=='undefined'?KTBusinessContract:require('./release-business-contract.js').KTBusinessContract;
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const md=s=>String(s??'').replace(/[\\\x60*_{}\[\]()#+.!|<>-]/g,c=>'\\'+c);
  const status=c=>({not_requested:'未取得',loading:'取得中',success:'取得済み',forbidden:'権限不足で取得不可',failed:'取得失敗',cancelled:'取得中断'}[c.acquisition]||'不明')+
    (c.acquisition==='success'?'・'+({present:'設定あり',empty:'明示設定なし',unknown:'内容不明'}[c.presence])+(c.activation==='disabled'?'・無効':c.activation==='enabled'?'・有効':''):'');
  const env=s=>s.environment==='production'?'運用環境':'動作テスト環境（未反映の設定を含む場合があります）';
  const source=s=>env(s)+'・アプリ '+s.appId+'・設定の版 '+(s.revision??'未確認')+'・取得日時 '+s.startedAt+'。取得時点の設定であり、実際の業務を確認したものではありません。';
  const entity=x=>x?(x.type==='FIELD_ENTITY'?'フィールドで指定：':({USER:'ユーザー：',GROUP:'グループ：',ORGANIZATION:'組織：',CREATOR:'アプリ作成者',CUSTOM_FIELD:'カスタマイズ項目：'}[x.type]||x.type+'：'))+(x.code??''):'対象未確認';
  const target=t=>entity(t.entity)+(t.includeSubs?'（下位組織を含む）':'');
  const eventLabels=['追加','編集','コメント追加','ステータス更新','ファイル読み込み'];
  const rightsLabels=['アプリ設定変更','閲覧','追加','編集','削除','読み込み','書き出し'];
  const boolText=(v,keys,labels)=>keys.map((k,i)=>labels[i]+'：'+(v[k]===true?'許可':v[k]===false?'不許可':'不明')).join('、');
  function description(e) {
    const v=e.value;let condition='',action='',people='';
    if(e.kind==='field'){condition=v.label+'（'+v.code+'）';action=v.type+(v.parent?'／テーブル '+v.parent:'');}
    if(e.kind==='notification_general'){condition=C.EVENTS.filter(k=>v[k]).map(k=>eventLabels[C.EVENTS.indexOf(k)]).join('・')||'通知する操作の指定なし';action='通知文は適用対象外';people=target(v);}
    if(e.kind==='comment_notification'){condition='コメント追加';action='コメント投稿者へ通知';people='そのレコードのコメント投稿者';}
    if(['notification_record','notification_reminder'].includes(e.kind)){condition=v.filterCond||'追加の絞り込み条件なし';action='通知文：'+(v.title||'設定なし');people=v.targets.map(target).join('、')||'通知先の指定なし';if(v.timing){condition+='／基準 '+v.timing.code+'、'+v.timing.daysLater+'日後'+(v.timing.hoursLater!==undefined?'、'+v.timing.hoursLater+'時間後':'')+(v.timing.time!==undefined?'、時刻 '+v.timing.time:'')+(v.timezone?'、'+v.timezone:'');}}
    if(e.kind==='process_state'){condition=v.name;action='作業者方式：'+({ONE:'候補から選択',ALL:'全員',ANY:'いずれか一人'}[v.assignee.type]||'未解釈');people=v.assignee.entities.map(target).join('、')||'作業者の指定なし';}
    if(e.kind==='process_action'){condition=v.from+' → '+v.to+'／実行条件：'+(v.filterCond||'追加条件なし');action=v.name+'／'+({PRIMARY:'作業者のアクション',SECONDARY:'作業者以外でも実行できるアクション'}[v.type]||'実行対象は未解釈');people=v.executableUser?v.executableUser.entities.map(target).join('、')||'レコードを閲覧できる利用者':'実行前ステータスの作業者設定を参照';}
    if(e.kind==='acl_app'){condition='アプリ全体';action=boolText(v,C.APP_RIGHTS,rightsLabels);people=target(v);}
    if(e.kind==='acl_record'||e.kind==='acl_field'){condition=e.kind==='acl_record'?v.filterCond||'追加の絞り込み条件なし':v.code;action=v.entities.map((t,i)=>(i+1)+'. '+target(t)+'：'+(e.kind==='acl_record'?boolText(t,['viewable','editable','deletable'],['閲覧','編集','削除']):({READ:'閲覧のみ',WRITE:'閲覧・編集',NONE:'閲覧・編集不可'}[t.accessibility]||'未解釈'))).join('\n');people='設定順を保持（個人別の実効権限は未検証）';}
    return {condition,action,people};
  }
  function evidenceHtml(e,prefix='business') {
    const d=description(e);
    return '<details id="'+escape(prefix+'-'+e.evidenceId)+'" data-business-evidence="'+escape(e.evidenceId)+'"><summary>'+escape(e.label)+(e.active===false?'（無効）':'')+'</summary><p>'+escape(d.condition)+'</p><p style="white-space:pre-wrap">'+escape(d.action)+'</p><p>'+escape(d.people)+'</p><p>取得元：'+escape(e.source.pointer)+'／設定の版 '+escape(e.source.revision??'未確認')+'</p><pre class="ktr-fact-value">'+escape(JSON.stringify(e.value,null,2))+'</pre></details>';
  }
  function inventoryHtml(s) {
    if(!s)return '<p>［設定を確認］で取得した設定を表示します。AIは呼びません。</p>';
    return '<p>'+escape(source(s))+'</p><div class="ktr-table-scroll"><table><thead><tr><th>種類</th><th>取得状態・有効状態</th><th>件数</th></tr></thead><tbody>'+s.categories.map(c=>'<tr><td>'+escape(C.LABELS[C.CATEGORIES.indexOf(c.category)])+'</td><td>'+escape(status(c))+'</td><td>'+escape(c.itemCount??'未確認')+'</td></tr>').join('')+'</tbody></table></div><h3>設定から確認できたこと</h3><div class="ktr-table-scroll" tabindex="0"><table><thead><tr><th>種類</th><th>対象・条件</th><th>通知内容・動作・許可</th><th>対象者</th><th>取得状態・有効状態</th></tr></thead><tbody>'+s.evidence.map(e=>{const d=description(e);return '<tr><td>'+escape(e.label)+'</td><td>'+escape(d.condition)+'</td><td style="white-space:pre-wrap">'+escape(d.action)+'</td><td>'+escape(d.people)+'</td><td>'+escape(status(s.categories.find(c=>c.category===e.category)))+'</td></tr>';}).join('')+'</tbody></table></div><details><summary>設定の原文を確認</summary>'+s.evidence.map(e=>evidenceHtml(e)).join('')+'</details><h3>確認できていない範囲</h3><ul>'+s.limitations.map(l=>'<li>'+escape(l.message)+'</li>').join('')+'</ul>';
  }
  const relationLabel={notification_target:'通知先',assignee:'作業者候補',action_executor:'アクション実行可能者',view_allowed:'閲覧許可対象',edit_allowed:'編集許可対象',other_permission:'権限の設定対象'};
  function relations(p,s){return p.settingRelations.map(r=>{const e=s.evidence.find(e=>e.evidenceId===r.evidenceRef.evidenceId),v=e&&C.pointer(e.value,r.evidenceRef.pointer);return relationLabel[r.relation]+'：'+(v?.entity?target(v):'対象未確認');}).join('、');}
  function outputHtml(o,s) {
    if(!o)return '';
    return '<h3>推測した業務ルール候補</h3>'+(o.noRuleReason?'<p>'+escape(o.noRuleReason)+'</p>':'')+o.rules.map(r=>'<section class="ktr-explanation-section"><h4>'+escape(r.inference)+'</h4><p>推測の理由：'+escape(r.reasoning)+'</p><h4>関係者・役割</h4>'+r.participants.map(p=>'<p>役割の候補：'+escape(p.roleHypothesis)+'<br>設定上の関係：'+escape(relations(p,s))+'</p>').join('')+'<h4>発生条件・次の行動</h4><p>'+escape(r.trigger.interpretation)+'</p><p>'+escape(r.nextAction.interpretation)+'</p><h4>確認事項</h4><ul>'+r.questions.map(q=>'<li>'+escape(q.question)+'<br>'+escape(q.whyItMatters)+'</li>').join('')+'</ul><details data-business-rule="'+escape(r.ruleId)+'"><summary>根拠を見る</summary>'+[...new Set(r.evidenceRefs.map(x=>x.evidenceId))].map(id=>evidenceHtml(s.evidence.find(e=>e.evidenceId===id),r.ruleId)).join('')+'</details></section>').join('')+
    (o.unassignedEvidence.length?'<details><summary>候補に整理していない設定（'+o.unassignedEvidence.length+'件）</summary><ul>'+o.unassignedEvidence.map(u=>'<li>'+escape(s.evidence.find(e=>e.evidenceId===u.evidenceId)?.label)+'：'+escape({insufficient_clues:'推測材料が不足',conflicting_clues:'材料の整合性が未確認',context_only:'補助資料',output_limit:'出力上限のため未整理'}[u.reason])+'</li>').join('')+'</ul></details>':'');
  }
  function markdown(doc) {
    const s=doc.snapshot,o=doc.businessUnderstanding;const lines=['# '+md(doc.title||'業務ルールの確認'),'',md(source(s)),'','## 設定の取得状態',''];
    for(const c of s.categories)lines.push('- '+md(C.LABELS[C.CATEGORIES.indexOf(c.category)]+'：'+status(c)+'／件数 '+(c.itemCount??'未確認')));
    lines.push('','## 設定から確認できたこと','');
    for(const e of s.evidence){const d=description(e);lines.push('### '+md(e.evidenceId+' '+e.label+(e.active===false?'（無効）':'')),'',md(d.condition),'',md(d.action),'',md(d.people),'','取得元：'+md(e.source.pointer)+'／設定の版 '+md(e.source.revision),'','原文：','',...JSON.stringify(e.value,null,2).split('\n').map(l=>'    '+l),'');}
    if(o){lines.push('## 推測した業務ルール候補','');if(o.noRuleReason)lines.push(md(o.noRuleReason),'');for(const r of o.rules){lines.push('### '+md(r.inference),'','推測の理由：'+md(r.reasoning),'','根拠：'+md(r.evidenceRefs.map(x=>x.evidenceId+(x.pointer||'')).join('、')),'','関係者・役割：',...r.participants.map(p=>'- '+md(p.roleHypothesis+'（役割の候補）。設定上の関係：'+relations(p,s))),'','発生条件：'+md(r.trigger.interpretation),'','次の行動：'+md(r.nextAction.interpretation),'','確認事項：',...r.questions.map(q=>'- '+md(q.question+' '+q.whyItMatters)),'');}if(o.unassignedEvidence.length)lines.push('## 候補に整理していない設定','',...o.unassignedEvidence.map(u=>'- '+md(u.evidenceId+' '+s.evidence.find(e=>e.evidenceId===u.evidenceId)?.label+'：'+({insufficient_clues:'推測材料が不足',conflicting_clues:'整合性が未確認',context_only:'補助資料',output_limit:'出力上限のため未整理'}[u.reason]))),'');}
    lines.push('## 確認できていない範囲','',...s.limitations.map(l=>'- '+md(l.message)),'');return lines.join('\n');
  }
  function historyBody(doc){
    const o=doc.businessUnderstanding,s=doc.snapshot;
    return {title:'過去の業務ルール候補（'+env(s)+'・版 '+s.revision+'）',sections:o?.rules.length?o.rules.map(r=>({heading:'推測：'+r.ruleId,paragraphs:[r.inference,r.reasoning,r.trigger.interpretation,r.nextAction.interpretation],items:[...r.participants.map(p=>p.roleHypothesis),...r.questions.map(q=>q.question)],table:null,evidenceIds:[]})):[{heading:'取得時点の記録',paragraphs:[o?.noRuleReason||'設定一覧を保存しました。業務ルール候補は未生成です。'],items:[],table:null,evidenceIds:[]}],unknowns:['過去の候補であり、現在の設定や業務上の確定事項ではありません。']};
  }
  return {escape,description,source,inventoryHtml,outputHtml,markdown,historyBody};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTBusinessView };
