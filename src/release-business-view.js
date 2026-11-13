/* Deterministic display/export of settings and structured hypotheses. */
'use strict';
const KTBusinessView = (() => {
  const C=typeof KTBusinessContract!=='undefined'?KTBusinessContract:require('./release-business-contract.js').KTBusinessContract;
  const D=typeof KTWorkflowDiagram!=='undefined'?KTWorkflowDiagram:require('./release-workflow-diagram.js').KTWorkflowDiagram;
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
  // Translate only a complete, recognized expression. Quoted values are never rewritten.
  function readableCondition(raw,s){
    if(!raw)return '追加条件なし';
    if(typeof raw!=='string'||raw.length>20000)return null;
    const fields=new Map();
    for(const e of s?.evidence||[])if(e.kind==='field'&&e.value?.code&&e.value?.label){
      const {code,label}=e.value;fields.set(code,fields.has(code)&&fields.get(code)!==label?null:label);
    }
    const tokens=[],re=/\s*("(?:[^"\\]|\\.)*"|>=|<=|!=|[()=<>]|-?\d+(?:\.\d+)?|[^\s()=<>!",]+)/gy;
    let pos=0,m;
    while(pos<raw.length){if(!raw.slice(pos).trim())break;re.lastIndex=pos;m=re.exec(raw);if(!m)return null;tokens.push(m[1]);pos=re.lastIndex;if(tokens.length>512)return null;}
    let at=0;
    const word=w=>tokens[at]===w;
    const atom=depth=>{
      if(depth>16)throw Error('depth');
      if(word('(')){at++;const inner=expr(depth+1);if(!word(')'))throw Error('group');at++;return '（'+inner+'）';}
      const label=fields.get(tokens[at++]);if(!label)throw Error('field');
      let op=tokens[at++];if(op==='not'){if(!word('like'))throw Error('operator');at++;op='not like';}
      if(!['=','!=','>','<','>=','<=','like','not like'].includes(op))throw Error('operator');
      const token=tokens[at++];if(!token)throw Error('value');
      let value;if(token.startsWith('"'))value='「'+JSON.parse(token)+'」';else if(/^-?\d+(?:\.\d+)?$/.test(token))value=token;else throw Error('value');
      if((op==='like'||op==='not like')&&!token.startsWith('"'))throw Error('keyword');
      const field='「'+label+'」';
      if(op==='like'||op==='not like')return field+'に'+value+(op==='like'?'を含む':'を含まない');
      return field+'が'+value+({'=':'と等しい','!=':'と等しくない','>':'より大きい','<':'より小さい','>=':'以上','<=':'以下'}[op]);
    };
    const and=depth=>{const parts=[atom(depth)];while(word('and')){at++;parts.push(atom(depth));}return parts.join(' かつ ');};
    const expr=depth=>{const parts=[and(depth)];while(word('or')){at++;parts.push(and(depth));}return parts.length>1?parts.map(x=>x.includes(' かつ ')?'（'+x+'）':x).join(' または '):parts[0];};
    try{const result=expr(0);return at===tokens.length?result:null;}catch{return null;}
  }
  function conditionHtml(raw,s){
    const readable=readableCondition(raw,s);
    if(!raw)return escape('追加条件なし');
    if(readable===null)return '<span>条件式（原文）：'+escape(raw)+'</span>';
    return '<span class="ktr-condition-readable">'+escape(readable)+'</span><details class="ktr-condition-original"><summary>条件式の原文</summary><code>'+escape(raw)+'</code></details>';
  }
  function description(e) {
    const v=e.value;let condition='',action='',people='';
    if(e.kind==='javascript'){condition=v.name+'／'+v.target+'／読み込み順 '+(v.order+1)+'／適用 '+v.scope;action='本文：'+({success:'取得済み（静的な読解のみ）',failed:'取得失敗',not_requested:'未取得',url_excluded:'URL指定の本文は対象外',size_exceeded:'取得上限超過',cancelled:'取得中断'}[v.bodyStatus]);people='実行結果・利用者の作業義務は未確認';}
    if(e.kind==='plugin'){condition=v.name+'（'+v.id+'）';action=v.enabled?'有効':'無効';people='名称を手掛かりにする補助根拠。設定・内部処理は未確認';}
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
    return '<p>'+escape(source(s))+'</p><div class="ktr-table-scroll"><table><thead><tr><th>種類</th><th>取得状態・有効状態</th><th>件数</th></tr></thead><tbody>'+s.categories.map(c=>'<tr><td>'+escape(C.LABELS[C.CATEGORIES.indexOf(c.category)])+'</td><td>'+escape(status(c))+'</td><td>'+escape(c.itemCount??'未確認')+'</td></tr>').join('')+'</tbody></table></div><h3>設定から確認できたこと</h3><div class="ktr-table-scroll" tabindex="0"><table><thead><tr><th>種類</th><th>対象・条件</th><th>通知内容・動作・許可</th><th>対象者</th><th>取得状態・有効状態</th></tr></thead><tbody>'+s.evidence.map(e=>{const d=description(e);return '<tr><td>'+escape(e.label)+'</td><td>'+(e.kind==='process_action'?escape(e.value.from+' → '+e.value.to+'／実行条件：')+conditionHtml(e.value.filterCond,s):escape(d.condition))+'</td><td style="white-space:pre-wrap">'+escape(d.action)+'</td><td>'+escape(d.people)+'</td><td>'+escape(status(s.categories.find(c=>c.category===e.category)))+'</td></tr>';}).join('')+'</tbody></table></div><details><summary>設定の原文を確認</summary>'+s.evidence.map(e=>evidenceHtml(e)).join('')+'</details><h3>確認できていない範囲</h3><ul>'+s.limitations.map(l=>'<li>'+escape(l.message)+'</li>').join('')+'</ul>';
  }
  const relationLabel={notification_target:'通知先',assignee:'作業者候補',action_executor:'アクション実行可能者',view_allowed:'閲覧許可対象',edit_allowed:'編集許可対象',other_permission:'権限の設定対象'};
  function relations(p,s){return p.settingRelations.map(r=>{const e=s.evidence.find(e=>e.evidenceId===r.evidenceRef.evidenceId),v=e&&C.pointer(e.value,r.evidenceRef.pointer);const commenter=e?.kind==='comment_notification'&&r.relation==='notification_target'&&r.evidenceRef.pointer===null&&v?.notifyToCommenter===true;return relationLabel[r.relation]+'：'+(commenter?'そのレコードのコメント投稿者':v?.entity?target(v):'対象未確認');}).join('、');}
  // Workflow v2 is deliberately separate: saved v1 hypotheses retain their original presentation.
  const isWorkflow=o=>o?.schemaVersion==='business-workflow-1';
  const unassignedLabel={insufficient_clues:'推測材料が不足',conflicting_clues:'材料の整合性が未確認',context_only:'補助資料',output_limit:'出力上限のため未整理'};
  const inputLabel={input:'入力',check:'確認',automatic:'自動処理'};
  const workflowNotice='工程の説明・担当・タイミングは設定からの推測です。通知先や編集許可は担当義務を意味せず、個人別の実効権限と実際の操作は未確認です。';
  const evidenceOf=(s,id)=>s.evidence.find(e=>e.evidenceId===id);
  const refText=refs=>(refs||[]).map(r=>r.evidenceId+(r.pointer===null?'（全体）':r.pointer)).join('、')||'根拠未特定・要確認';
  const evidenceLink=(id,prefix='workflow-source')=>'<a href="#'+escape(prefix+'-'+id)+'">'+escape(id)+'</a>';
  const refsHtml=(refs,prefix='workflow-source')=>refs?.length?refs.map(r=>evidenceLink(r.evidenceId,prefix)+escape(r.pointer===null?'（全体）':r.pointer)).join('、'):'根拠未特定・要確認';
  const notificationKinds=['notification_general','notification_record','notification_reminder','comment_notification'];
  function notificationFacts(n,s){
    return [...new Set((n.evidenceRefs||[]).map(r=>r.evidenceId))].map(id=>evidenceOf(s,id)).filter(e=>e&&notificationKinds.includes(e.kind));
  }
  function inputFacts(r,s){
    return [...new Set((r.inputs||[]).flatMap(i=>i.evidenceRefs.map(ref=>ref.evidenceId)))].map(id=>evidenceOf(s,id)).filter(e=>e?.kind==='field');
  }
  function fieldFactText(e){
    const v=e.value;
    return v.label+'（'+v.code+'）／'+v.type+'／'+(v.required===true?'アプリ全体で必須':v.required===false?'アプリ全体の必須指定なし':'必須指定は未取得')+(typeof v.expression==='string'&&v.expression?'／計算式：'+v.expression:'');
  }
  function processModel(s){
    const category=s.categories.find(c=>c.category==='process');
    const acquired=category?.acquisition==='success',enabled=acquired&&category.activation==='enabled';
    const states=acquired?s.evidence.filter(e=>e.kind==='process_state'):[];
    const actions=acquired?s.evidence.filter(e=>e.kind==='process_action'):[];
    const disabled=acquired&&category.activation==='disabled';
    return {category,states,actions,enabled,disabled,
      title:disabled?'参考：無効なプロセス定義':enabled?'設定の事実：有効なプロセス定義':'プロセス設定の取得状態',
      note:!acquired?'プロセス設定は'+(category?status(category):'未取得')+'です。「設定なし」とは判断できません。'
        :category.presence==='empty'?'取得済み・明示設定なし。標準プロセスの工程・遷移は確認できません。'
        :disabled?'この定義は無効です。現行の工程やJavaScriptの操作と接続して解釈しません。'
        :'取得時点の設定の事実です。表示順は進行順を意味しません。分岐・差し戻し・同じ状態への遷移もすべて記載しています。'};
  }
  function processHtml(s,{scope=D.nextId(),output=null}={}){
    const p=processModel(s),prefix=scope+'-workflow-process',link=e=>evidenceLink(e.evidenceId,prefix);
    const stateRow=e=>scope+'-process-state-'+e.evidenceId,actionRow=e=>scope+'-process-action-'+e.evidenceId;
    const stateTarget=e=>{const rule=p.enabled&&e.active===true&&output?.rules.find(r=>r.processStateId===e.evidenceId);return rule?{id:scope+'-workflow-stage-'+rule.ruleId,kind:'stage'}:{id:stateRow(e),kind:'setting'};};
    let html='<section class="ktr-explanation-section ktr-workflow-process" data-process-status="'+escape(p.disabled?'disabled':p.enabled?'enabled':p.category?.acquisition||'not_requested')+'"><h3>'+escape(p.title)+'</h3><p>'+escape(p.note)+'</p>';
    html+=D.render({states:p.states,actions:p.actions,prefix:scope+'-process-diagram',disabled:p.disabled,stateTarget,actionTarget:actionRow});
    if(p.states.length||p.actions.length)html+='<p>状態をクリックすると、対応する工程の説明または設定の説明に移動します。矢印は取得したアクションだけを示し、工程の推測からは追加しません。</p><details class="ktr-workflow-process-list"><summary>ステータス・遷移の設定一覧（'+p.states.length+'状態・'+p.actions.length+'遷移）</summary>';
    if(p.states.length)html+='<h4>ステータス（'+p.states.length+'件）</h4><div class="ktr-table-scroll" tabindex="0"><table><thead><tr><th>ステータス・表示順</th><th>作業者設定</th><th>根拠</th></tr></thead><tbody>'+p.states.map(e=>{const d=description(e);return '<tr id="'+escape(stateRow(e))+'" data-process-state="'+escape(e.evidenceId)+'"><td>'+escape(e.value.name)+'<br><small>表示順：'+escape(e.value.index)+'</small></td><td>'+escape(d.action)+'<br>'+escape(d.people)+'</td><td>'+link(e)+'</td></tr>';}).join('')+'</tbody></table></div>';
    if(p.actions.length)html+='<h4>アクション・遷移（'+p.actions.length+'件）</h4><div class="ktr-table-scroll" tabindex="0"><table><thead><tr><th>遷移元 → 遷移先</th><th>操作・実行条件</th><th>実行者の設定</th><th>根拠</th></tr></thead><tbody>'+p.actions.map(e=>{const d=description(e);return '<tr id="'+escape(actionRow(e))+'" data-process-action="'+escape(e.evidenceId)+'"><td>'+escape(e.value.from)+' → '+escape(e.value.to)+'</td><td>'+escape(e.value.name)+'<br>'+conditionHtml(e.value.filterCond,s)+'</td><td>'+escape(d.action)+'<br>'+escape(d.people)+'</td><td>'+link(e)+'</td></tr>';}).join('')+'</tbody></table></div>';
    if(p.states.length||p.actions.length)html+='</details><details><summary>プロセス設定の原文・取得元</summary>'+[...p.states,...p.actions].map(e=>evidenceHtml(e,prefix)).join('')+'</details>';
    return html+'</section>';
  }
  function processBinding(r,s){
    const p=processModel(s),e=r.processStateId&&evidenceOf(s,r.processStateId);
    return p.enabled&&e?.kind==='process_state'&&e.active===true
      ?'対応する標準ステータス（設定の事実）：'+e.value.name+'／根拠 '+e.evidenceId
      :'標準プロセスとの対応は未特定です。工程名やJavaScriptの操作だけから状態遷移は断定しません。';
  }
  function workflowHtml(o,s,ruleAction=()=>''){
    if(!o)return '';
    const scope=D.nextId(),p=processModel(s),overviewId=scope+'-overview',stageId=r=>scope+'-workflow-stage-'+r.ruleId;
    const boundState=r=>p.enabled?p.states.find(e=>e.evidenceId===r.processStateId&&e.active===true):null;
    const boundRule=e=>o.rules.find(r=>boundState(r)?.evidenceId===e.evidenceId);
    const settingId=e=>scope+'-workflow-setting-stage-'+e.evidenceId;
    const stateDestination=e=>{const r=boundRule(e);return r?stageId(r):settingId(e);};
    // A state is joined only by its validated ID. Names and display order never imply a workflow.
    const cards=p.enabled?p.states.filter(e=>e.active===true).map(e=>({state:e,rule:boundRule(e)})):[];
    cards.push(...o.rules.filter(r=>!boundState(r)).map(rule=>({rule,state:null})));
    const backToOverview=()=>'<a class="ktr-workflow-back" href="#'+escape(overviewId)+'">概要図に戻る</a>';
    const row=(label,body)=>'<div class="ktr-workflow-card-row"><dt>'+label+'</dt><dd>'+body+'</dd></div>';
    const citation=refs=>'<small class="ktr-workflow-citation">根拠：'+refs+'</small>';
    // Group only by source identity. Different wording is retained, never treated as equivalent.
    const noticeUses=new Map(),questionUses=new Map(),noticeInterpretationUses=new Map();
    const exactNoticeKey=n=>JSON.stringify(n);
    const exactQuestionKey=q=>JSON.stringify([q.question,q.whyItMatters,questionKey(q)]);
    const questionKey=q=>JSON.stringify([...new Set(q.relatedEvidenceRefs.map(ref=>JSON.stringify([ref.evidenceId,ref.pointer])))].sort());
    for(const r of o.rules){
      for(const n of r.notifications){const key=exactNoticeKey(n);noticeInterpretationUses.set(key,[...(noticeInterpretationUses.get(key)||[]),{rule:r,notice:n}]);}
      for(const id of new Set(r.notifications.flatMap(n=>notificationFacts(n,s).map(e=>e.evidenceId))))noticeUses.set(id,[...(noticeUses.get(id)||[]),r]);
      r.questions.forEach((q,index)=>{if(!q.relatedEvidenceRefs.length)return;const key=questionKey(q);questionUses.set(key,[...(questionUses.get(key)||[]),{rule:r,question:q,index}]);});
    }
    const sharedInterpretationGroups=[...noticeInterpretationUses.values()].filter(items=>new Set(items.map(x=>x.rule.ruleId)).size>1&&notificationFacts(items[0].notice,s).length);
    const sharedInterpretationKeys=new Set(sharedInterpretationGroups.map(items=>exactNoticeKey(items[0].notice)));
    const sharedNotices=new Map([...noticeUses].filter(([,rules])=>rules.length>1));
    const sharedQuestions=[...questionUses.values()].filter(items=>new Set(items.map(x=>x.rule.ruleId)).size>1);
    const sharedQuestionBySource=new Map();
    sharedQuestions.forEach((items,group)=>items.forEach((item,index)=>sharedQuestionBySource.set(item.rule.ruleId+':'+item.index,{group,index:items.findIndex(other=>exactQuestionKey(other.question)===exactQuestionKey(item.question))})));
    const sharedPrefix=scope+'-workflow-shared-source',noticeId=id=>scope+'-shared-notice-'+id,questionId=(group,index)=>scope+'-shared-question-'+group+'-'+index;
    const stageLinks=rules=>rules.map(r=>'<a href="#'+escape(stageId(r))+'">'+escape(r.stageName)+'</a>').join('、');
    const notificationSetting=(e,prefix)=>{const d=description(e);return '<div><strong>通知設定の事実 '+evidenceLink(e.evidenceId,prefix)+'</strong><p>条件・タイミング：'+escape(d.condition)+'<br>宛先：'+escape(d.people)+'<br>'+escape(d.action)+'</p></div>';};
    const questionBody=(q,prefix)=>escape(q.question)+'<p>'+escape(q.whyItMatters)+citation(refsHtml(q.relatedEvidenceRefs,prefix))+'</p>';
    const actionFacts=(e,direction)=>{
      const v=e.value,d=description(e),name=direction==='in'?v.from:v.to;
      const match=p.states.find(x=>x.active===true&&x.value.name===name);
      const stateText=match?'<a href="#'+escape(stateDestination(match))+'">'+escape(name)+'</a>':escape(name)+'（状態の定義は未取得）';
      return '<li data-workflow-card-action="'+escape(e.evidenceId)+'"><strong>'+escape(v.name)+'</strong> — '+(direction==='in'?'遷移元：':'遷移先：')+stateText+
        '<br>条件：'+conditionHtml(v.filterCond,s)+'<br>'+escape(d.action)+'／'+escape(d.people)+citation(evidenceLink(e.evidenceId,scope+'-workflow-process'))+'</li>';
    };
    const stateFacts=e=>{
      const d=description(e),outgoing=p.actions.filter(a=>a.value.from===e.value.name),incoming=p.actions.filter(a=>a.value.to===e.value.name);
      return '<div class="ktr-workflow-card-facts"><h5>プロセス設定の事実</h5><p>対応する標準ステータス（設定の事実）：'+escape(e.value.name)+citation(evidenceLink(e.evidenceId,scope+'-workflow-process'))+'</p><p>'+escape(d.action)+'／'+escape(d.people)+'</p>'+
        '<h5>この状態からの操作・遷移先</h5>'+(outgoing.length?'<ul>'+outgoing.map(a=>actionFacts(a,'out')).join('')+'</ul>':'<p>取得した定義に、この状態からの遷移はありません。業務の完了を意味するとは限りません。</p>')+
        '<details class="ktr-workflow-incoming"><summary>この状態に入る操作（'+incoming.length+'件）</summary>'+(incoming.length?'<ul>'+incoming.map(a=>actionFacts(a,'in')).join('')+'</ul>':'<p>取得した定義に、この状態へ入る遷移はありません。業務の開始時点は未確認です。</p>')+'</details></div>';
    };
    const ruleCard=(r,state)=>{
      const prefix=scope+'-workflow-'+r.ruleId,links=refs=>refsHtml(refs,prefix);
      const participants=r.participants.length?r.participants.map(person=>'<p>役割の候補：'+escape(person.roleHypothesis)+'<br>設定上の関係（事実）：'+escape(relations(person,s))+citation(links(person.settingRelations.map(x=>x.evidenceRef)))+'</p>').join(''):'<p>担当者は未特定・要確認です。</p>';
      const inputSettings=inputFacts(r,s);
      const inputs=(r.inputs?.length?'<ul>'+r.inputs.map(i=>'<li><strong>'+escape(inputLabel[i.kind]||'要確認')+'</strong>（推測）：'+escape(i.interpretation)+citation(links(i.evidenceRefs))+'</li>').join('')+'</ul>':'<p>入力・確認・自動処理は未特定・要確認です。</p>')+(inputSettings.length?'<details class="ktr-workflow-input-facts"><summary>参照した項目の設定（事実）</summary><p>アプリ全体の必須指定は、この工程での入力義務・担当・時期を意味しません。</p><ul>'+inputSettings.map(e=>'<li>'+escape(fieldFactText(e))+citation(evidenceLink(e.evidenceId,prefix))+'</li>').join('')+'</ul></details>':'');
      const noticeFacts=[...new Set(r.notifications.flatMap(n=>notificationFacts(n,s).map(e=>e.evidenceId)))].map(id=>evidenceOf(s,id));
      const noticeInterpretation=n=>'<p>工程との関連（推測）：'+escape(n.interpretation)+citation(links(n.evidenceRefs))+'</p>';
      const sharedInterpretations=r.notifications.filter(n=>!sharedInterpretationKeys.has(exactNoticeKey(n))&&notificationFacts(n,s).some(e=>sharedNotices.has(e.evidenceId)));
      const notifications=r.notifications?.length?'<div class="ktr-workflow-notification">'+(noticeFacts.length?noticeFacts.map(e=>{
        if(!sharedNotices.has(e.evidenceId))return notificationSetting(e,prefix);
        const d=description(e);return '<p class="ktr-workflow-shared-notice-ref" data-workflow-shared-notice-ref="'+escape(e.evidenceId)+'"><strong>設定：'+escape(d.condition)+'</strong><br>宛先：'+escape(d.people)+'<br><a href="#'+escape(noticeId(e.evidenceId))+'">共通の通知設定・根拠 '+escape(e.evidenceId)+'</a></p>';
      }).join(''):'<p>対応する通知設定の条件・宛先・時刻は未特定・要確認です。</p>')+
        r.notifications.filter(n=>!sharedInterpretations.includes(n)&&!sharedInterpretationKeys.has(exactNoticeKey(n))).map(noticeInterpretation).join('')+
        (sharedInterpretations.length?'<details class="ktr-workflow-notification-interpretation"><summary>この工程との関連・注意点（推測）</summary>'+sharedInterpretations.map(noticeInterpretation).join('')+'</details>':'')+'</div>':'<p>この工程と結び付く通知は未特定・要確認です。</p>';
      // Keep every generated statement and citation; folding changes presentation only.
      const refs=[...r.evidenceRefs,...r.trigger.evidenceRefs,...r.nextAction.evidenceRefs,...r.inputs.flatMap(x=>x.evidenceRefs),...r.notifications.flatMap(x=>x.evidenceRefs),...r.participants.flatMap(x=>x.settingRelations.map(y=>y.evidenceRef)),...r.questions.flatMap(x=>x.relatedEvidenceRefs)];
      return '<section id="'+escape(stageId(r))+'" class="ktr-explanation-section ktr-workflow-stage ktr-workflow-card" data-workflow-rule="'+escape(r.ruleId)+'"><header><small class="ktr-workflow-card-kind">'+(state?'標準プロセスに対応する工程':'設定から推測した工程')+'</small><h4>'+escape(r.stageName)+'</h4><p>工程の意味（推測）：'+escape(r.inference)+'</p></header>'+
        (!state?'<p class="ktr-note">'+escape(processBinding(r,s))+'</p>':'')+
        '<dl class="ktr-workflow-card-rows">'+row('担当者',participants)+row('開始タイミング','<p>推測：'+escape(r.trigger.interpretation)+citation(links(r.trigger.evidenceRefs))+'</p>')+row('入力・確認',inputs)+row('通知',notifications)+row('次へ進む条件・操作','<p>推測：'+escape(r.nextAction.interpretation)+citation(links(r.nextAction.evidenceRefs))+'</p>')+'</dl>'+
        (state?stateFacts(state):'')+
        '<details class="ktr-workflow-questions"><summary>確認事項（'+r.questions.length+'件）</summary>'+(r.questions.length?'<ul>'+r.questions.map((q,index)=>{const shared=sharedQuestionBySource.get(r.ruleId+':'+index);return shared?'<li><a href="#'+escape(questionId(shared.group,shared.index))+'">同じ設定に関する確認 '+(shared.group+1)+' — この工程の質問へ</a></li>':'<li>'+questionBody(q,prefix)+'</li>';}).join('')+'</ul>':'<p>個別の確認事項は生成されていません。実際の運用を確認済みという意味ではありません。</p>')+'</details>'+
        '<details data-business-rule="'+escape(r.ruleId)+'"><summary>推測の理由・根拠確認</summary><p>推測の理由：'+escape(r.reasoning)+'</p><p>'+links(r.evidenceRefs)+'</p>'+[...new Set(refs.map(x=>x.evidenceId))].map(id=>evidenceOf(s,id)).filter(Boolean).map(e=>evidenceHtml(e,prefix)).join('')+'</details>'+ruleAction(r.ruleId)+backToOverview()+'</section>';
    };
    const settingCard=e=>'<section id="'+escape(settingId(e))+'" class="ktr-explanation-section ktr-workflow-stage ktr-workflow-card" data-workflow-setting-stage="'+escape(e.evidenceId)+'"><header><small class="ktr-workflow-card-kind">設定のみ・業務の説明は未整理</small><h4>'+escape(e.value.name)+'</h4></header><p>この状態に対応する業務の説明は未整理です。担当・入力・通知・業務上の次の行動は要確認です。</p>'+stateFacts(e)+backToOverview()+'</section>';
    let html='<section id="'+escape(overviewId)+'" class="ktr-workflow-overview"><h3>概要図</h3><p class="ktr-note">'+(p.enabled?'工程を選ぶと前後のつながりを強調します。担当・入力・通知は［工程の詳細を見る］から確認できます。':'工程を選ぶと、その工程の担当・入力・通知などの詳細へ移動します。')+'</p>';
    if(!p.enabled)html+='<p class="ktr-note">'+escape(p.disabled?'標準プロセス管理は無効です。以下は取得済み設定から推測した工程です。':p.note)+'</p>';
    html+=D.renderOverview({states:p.enabled?p.states.filter(e=>e.active===true):[],actions:p.enabled?p.actions.filter(e=>e.active===true):[],stages:o.rules.filter(r=>!boundState(r)),prefix:scope,stateTarget:e=>({id:stateDestination(e)}),stageTarget:stageId})+'</section>';
    html+='<h3>工程ごとの詳細</h3><p class="ktr-note">'+escape(workflowNotice)+'通知の配信結果、JSの実行結果、プラグイン内部も未確認です。 未特定・未取得は設定なしを意味しません。通知設定がないとは判断しません。</p><p class="ktr-note">表示順は実行順ではありません。各工程の条件と、設定にある遷移先を確認してください。</p>'+(o.noRuleReason?'<p>'+escape(o.noRuleReason)+'</p>':'');
    if(cards.length)html+='<div class="ktr-workflow-cards">'+cards.map(({rule,state})=>rule?ruleCard(rule,state):settingCard(state)).join('')+'</div>';
    if(sharedNotices.size||sharedQuestions.length){
      html+='<section class="ktr-workflow-shared"><h3>複数の工程で参照する設定・確認</h3>';
      if(sharedNotices.size)html+='<details class="ktr-workflow-shared-notices"><summary>共通の通知設定（'+sharedNotices.size+'件）</summary><p>同じ通知設定を一度だけ示します。通知先は担当者とは限らず、配信結果は未確認です。共通の解釈もここにまとめ、工程ごとに異なる関連・注意点は各工程に保持しています。</p>'+[...sharedNotices].map(([id,rules])=>{const e=evidenceOf(s,id);return '<section id="'+escape(noticeId(id))+'" data-workflow-shared-notice="'+escape(id)+'">'+notificationSetting(e,sharedPrefix)+'<p>参照している工程：'+stageLinks(rules)+'</p>'+sharedInterpretationGroups.filter(items=>notificationFacts(items[0].notice,s)[0].evidenceId===id).map(items=>'<p class="ktr-workflow-shared-interpretation">工程との関連（推測）：'+escape(items[0].notice.interpretation)+citation(refsHtml(items[0].notice.evidenceRefs,scope+'-workflow-'+items[0].rule.ruleId))+'<br>対象工程：'+stageLinks(items.map(item=>item.rule))+'</p>').join('')+evidenceHtml(e,sharedPrefix)+'</section>';}).join('')+'</details>';
      if(sharedQuestions.length)html+='<details class="ktr-workflow-shared-questions"><summary>同じ設定に関する確認事項（'+sharedQuestions.length+'組）</summary><p>同じ根拠を参照する質問をまとめています。工程ごとの違いを残しており、同じ意味の質問とは限りません。質問・理由・根拠が全て同じものは一度だけ示します。回答・下書きは工程ごとに保持します。</p>'+sharedQuestions.map((items,group)=>'<section><h4>確認 '+(group+1)+'</h4><ul>'+items.map((item,index)=>{if(items.findIndex(other=>exactQuestionKey(other.question)===exactQuestionKey(item.question))!==index)return '';const identical=items.filter(other=>exactQuestionKey(other.question)===exactQuestionKey(item.question));return '<li id="'+escape(questionId(group,index))+'" data-workflow-source-question="'+escape(item.rule.ruleId+':'+item.index)+'"><strong>'+stageLinks(identical.map(other=>other.rule))+'</strong>'+identical.slice(1).map(other=>'<span data-workflow-source-question="'+escape(other.rule.ruleId+':'+other.index)+'"></span>').join('')+'<br>'+questionBody(item.question,sharedPrefix)+'</li>';}).join('')+'</ul></section>').join('')+
        [...new Set(sharedQuestions.flatMap(items=>items.flatMap(item=>item.question.relatedEvidenceRefs.map(ref=>ref.evidenceId))))].filter(id=>!sharedNotices.has(id)).map(id=>evidenceOf(s,id)).filter(Boolean).map(e=>evidenceHtml(e,sharedPrefix)).join('')+'</details>';
      html+=backToOverview()+'</section>';
    }
    if(o.unassignedEvidence.length)html+='<details class="ktr-workflow-unassigned"><summary>工程に整理していない設定（'+o.unassignedEvidence.length+'件）</summary><ul>'+o.unassignedEvidence.map(u=>'<li>'+evidenceLink(u.evidenceId,scope+'-workflow-unassigned')+' '+escape(evidenceOf(s,u.evidenceId)?.label)+'：'+escape(unassignedLabel[u.reason])+'</li>').join('')+'</ul>'+o.unassignedEvidence.map(u=>evidenceOf(s,u.evidenceId)).filter(Boolean).map(e=>evidenceHtml(e,scope+'-workflow-unassigned')).join('')+'</details>';
    const referenceStatus=p.category?.acquisition==='success'?p.states.length+'状態・'+p.actions.length+'遷移':(p.category?status(p.category):'未取得')+'・件数未確認';
    html+='<details class="ktr-workflow-reference"><summary>'+escape(p.disabled?'参考：無効なプロセス定義':p.enabled?'補足：プロセス全体の図・設定一覧':'プロセス設定の取得状態')+'（'+escape(referenceStatus)+'）</summary>'+processHtml(s,{scope,output:o})+'</details>';
    return html;
  }
  function workflowSections(o,s){
    const section=(heading,paragraphs=[],items=[])=>({heading,paragraphs,items,table:null,evidenceIds:[]});
    const sections=[section('工程の読み方',[workflowNotice,'表示順は実行順ではありません。',source(s)])];
    if(o.noRuleReason)sections.push(section('工程を特定できない理由',[o.noRuleReason]));
    for(const r of o.rules){
      const items=[...r.participants.map(p=>'担当者の候補：'+p.roleHypothesis+'／設定上の関係（事実）：'+relations(p,s)+'／根拠：'+refText(p.settingRelations.map(x=>x.evidenceRef)))];
      if(!r.participants.length)items.push('担当者は未特定・要確認です。操作する人の役割や作業義務は確定できません。');
      if(r.inputs?.length)items.push(...r.inputs.map(i=>(inputLabel[i.kind]||i.kind)+'（推測）：'+i.interpretation+'／根拠：'+refText(i.evidenceRefs)));
      else items.push('入力・確認・自動処理は未特定・要確認です。');
      if(r.notifications?.length)for(const n of r.notifications){items.push('通知と工程の関連（推測）：'+n.interpretation+'／根拠：'+refText(n.evidenceRefs));const facts=notificationFacts(n,s);if(!facts.length)items.push('通知設定の条件・宛先・時刻は未特定・要確認です。設定がないとは判断しません。');for(const e of facts){const d=description(e);items.push('通知設定の事実 '+e.evidenceId+'：条件・タイミング '+d.condition+'／宛先 '+d.people+'／'+d.action);}}
      else items.push('この工程と結び付く通知は未特定・要確認です。通知設定がないとは判断しません。');
      items.push(...r.questions.map(q=>'確認事項：'+q.question+'／理由：'+q.whyItMatters+'／関連する根拠：'+refText(q.relatedEvidenceRefs)));
      sections.push(section(r.ruleId+' '+r.stageName,['工程の意味（推測）：'+r.inference,'推測の理由：'+r.reasoning,'根拠の組み合わせ：'+r.basis+'／'+refText(r.evidenceRefs),processBinding(r,s)+'／対応設定ID：'+(r.processStateId||'未特定'),'開始タイミング（推測）：'+r.trigger.interpretation+'／根拠：'+refText(r.trigger.evidenceRefs),'次へ進む条件・操作（推測）：'+r.nextAction.interpretation+'／根拠：'+refText(r.nextAction.evidenceRefs)],items));
    }
    const p=processModel(s);sections.push(section(p.title,[p.note],p.states.map(e=>{const d=description(e);return 'ステータス '+e.evidenceId+'：'+e.value.name+'／表示順 '+e.value.index+'／'+d.action+'／'+d.people+'／取得元 '+e.source.pointer+'／版 '+e.source.revision+'／取得日時 '+e.source.fetchedAt;}).concat(p.actions.map(e=>{const d=description(e);return '遷移 '+e.evidenceId+'：'+d.condition+'／'+d.action+'／'+d.people+'／取得元 '+e.source.pointer+'／版 '+e.source.revision+'／取得日時 '+e.source.fetchedAt;}))));
    if(o.unassignedEvidence.length)sections.push(section('工程に整理していない設定',[],o.unassignedEvidence.map(u=>u.evidenceId+' '+evidenceOf(s,u.evidenceId)?.label+'：'+unassignedLabel[u.reason])));
    const used=[...new Set(o.rules.flatMap(r=>r.evidenceRefs.map(x=>x.evidenceId)).concat(o.unassignedEvidence.map(x=>x.evidenceId)))];
    sections.push(section('工程の根拠と取得元（設定の事実）',[],used.map(id=>evidenceOf(s,id)).filter(Boolean).map(e=>{const d=description(e);return e.evidenceId+' '+e.label+'：'+d.condition+'／'+d.action+'／'+d.people+'／取得元 '+e.source.pointer+'／版 '+e.source.revision+'／取得日時 '+e.source.fetchedAt;})));
    return sections;
  }
  function workflowMarkdown(doc){
    const s=doc.snapshot,o=doc.businessUnderstanding,lines=['# '+md(doc.title||'業務工程の確認'),''];
    for(const section of workflowSections(o,s))lines.push('## '+md(section.heading),'',...section.paragraphs.flatMap(p=>[md(p),'']),...section.items.map(i=>'- '+md(i)),'');
    lines.push('## 設定の取得状態','',...s.categories.map(c=>'- '+md(C.LABELS[C.CATEGORIES.indexOf(c.category)]+'：'+status(c)+'／件数 '+(c.itemCount??'未確認'))),'','## 根拠の原文一覧（設定の事実）','');
    for(const e of s.evidence){const d=description(e);lines.push('### '+md(e.evidenceId+' '+e.label+(e.active===false?'（無効）':'')),'',md(d.condition),'',md(d.action),'',md(d.people),'','取得元：'+md(e.source.pointer)+'／設定の版 '+md(e.source.revision)+'／取得日時 '+md(e.source.fetchedAt),'','原文：','',...JSON.stringify(e.value,null,2).split('\n').map(l=>'    '+l),'');}
    lines.push('## 確認できていない範囲','',...s.limitations.map(l=>'- '+md(l.message)),'');return lines.join('\n');
  }
  function workflowHistoryBody(doc){
    const s=doc.snapshot,o=doc.businessUnderstanding;
    // Generic discussion history carries an index, not the full workflow contract.
    // HTML, Markdown, the saved document and dedicated businessContext retain the details.
    const metadata=(label,value)=>{const text=label+String(value??'未確認');return text.length<=600?text:label+'（長いため索引では省略。保存資料で原文を確認してください。）';};
    return {title:'過去の業務工程の索引',sections:[
      {heading:'取得元と収録範囲',paragraphs:['一般会話の履歴には工程の索引だけを渡しています。工程名の表示順は実際の進行順を意味しません。'],items:[metadata('対象環境：',env(s)),metadata('アプリ：',s.appId),metadata('設定の版：',s.revision),metadata('取得日時：',s.startedAt),'工程数：'+o.rules.length],table:null,evidenceIds:[]},
      {heading:'工程の索引（全'+o.rules.length+'件）',paragraphs:o.rules.length?[]:[o.noRuleReason||'工程は特定されていません。'],items:o.rules.map(r=>r.ruleId+' '+r.stageName),table:null,evidenceIds:[]}
    ],unknowns:['過去の工程の推測であり、現在の設定や業務上の確定事項ではありません。','入力・確認内容、通知、次へ進む条件・操作、根拠原文、無効プロセスの詳細、個別確認事項、取得できていない範囲の詳細はこの索引には含まれません。詳細は保存資料または専用の工程相談で確認してください。']};
  }

  function materialHtml(s){
    const readiness=C.workflowEligibility(s);
    const note=readiness.mode==='analyze-all'?(processModel(s).enabled?'AIによる工程の説明は未作成です。上限内のため、有効なプロセスは全工程をまとめて分析できます。':'AIによる工程の説明は未作成です。取得した設定を横断して工程を推測できますが、有効なプロセスを確認できないため全工程の網羅は確認できません。'):'AIによる工程の説明は未作成です。'+readiness.reasons.join('。');
    return '<section class="ktr-workflow-material"><h3>全体図と根拠付き資料（設定の事実）</h3><p>'+escape(note)+'</p><p>設定の図と原文を整理した資料です。AIによる業務の意味付けは含みません。無効なプロセスは参考情報として区別します。</p>'+processHtml(s)+'</section>';
  }
  function materialMarkdown(s){
    const readiness=C.workflowEligibility(s),p=processModel(s);
    const lines=['## 全体図と根拠付き資料（設定の事実）','','AIによる工程の説明は未作成です。',...readiness.reasons.map(md),'',md(p.title),md(p.note),''];
    if(p.states.length){
      const ids=new Map(p.states.map((e,i)=>[e.value.name,'S'+(i+1)]));
      // Numeric Mermaid labels avoid injecting setting text as diagram syntax. Names resolve below.
      lines.push('```mermaid','flowchart LR',...p.states.map((e,i)=>'  S'+(i+1)+'["'+e.evidenceId+'"]'));
      for(const e of p.actions){const from=ids.get(e.value.from),to=ids.get(e.value.to);if(from&&to)lines.push('  '+from+' -->|'+e.evidenceId+'| '+to);}
      lines.push('```','',...p.states.map(e=>'- '+md(e.evidenceId+'：'+e.value.name)),...p.actions.map(e=>'- '+md(e.evidenceId+'：'+e.value.from+' → '+e.value.to+'／操作：'+e.value.name)),'');
    }
    return lines;
  }
  function outputHtml(o,s,ruleAction=()=>'') {
    if(isWorkflow(o))return workflowHtml(o,s,ruleAction);
    if(!o)return s?materialHtml(s):'';
    return '<h3>推測した業務ルール候補</h3>'+(o.noRuleReason?'<p>'+escape(o.noRuleReason)+'</p>':'')+o.rules.map(r=>'<section class="ktr-explanation-section"><h4>'+escape(r.inference)+'</h4><p>推測の理由：'+escape(r.reasoning)+'</p><h4>関係者・役割</h4>'+r.participants.map(p=>'<p>役割の候補：'+escape(p.roleHypothesis)+'<br>設定上の関係：'+escape(relations(p,s))+'</p>').join('')+'<h4>発生条件・次の行動</h4><p>'+escape(r.trigger.interpretation)+'</p><p>'+escape(r.nextAction.interpretation)+'</p><h4>確認事項</h4><ul>'+r.questions.map(q=>'<li>'+escape(q.question)+'<br>'+escape(q.whyItMatters)+'</li>').join('')+'</ul>'+ruleAction(r.ruleId)+'<details data-business-rule="'+escape(r.ruleId)+'"><summary>根拠を見る</summary>'+[...new Set(r.evidenceRefs.map(x=>x.evidenceId))].map(id=>evidenceHtml(s.evidence.find(e=>e.evidenceId===id),r.ruleId)).join('')+'</details></section>').join('')+
    (o.unassignedEvidence.length?'<details><summary>候補に整理していない設定（'+o.unassignedEvidence.length+'件）</summary><ul>'+o.unassignedEvidence.map(u=>'<li>'+escape(s.evidence.find(e=>e.evidenceId===u.evidenceId)?.label)+'：'+escape({insufficient_clues:'推測材料が不足',conflicting_clues:'材料の整合性が未確認',context_only:'補助資料',output_limit:'出力上限のため未整理'}[u.reason])+'</li>').join('')+'</ul></details>':'');
  }
  function markdown(doc) {
    if(isWorkflow(doc.businessUnderstanding))return workflowMarkdown(doc);
    const s=doc.snapshot,o=doc.businessUnderstanding;const lines=['# '+md(doc.title||'業務ルールの確認'),'',md(source(s)),''];
    if(!o)lines.push(...materialMarkdown(s));
    lines.push('## 設定の取得状態','');
    for(const c of s.categories)lines.push('- '+md(C.LABELS[C.CATEGORIES.indexOf(c.category)]+'：'+status(c)+'／件数 '+(c.itemCount??'未確認')));
    lines.push('','## 設定から確認できたこと','');
    for(const e of s.evidence){const d=description(e);lines.push('### '+md(e.evidenceId+' '+e.label+(e.active===false?'（無効）':'')),'',md(d.condition),'',md(d.action),'',md(d.people),'','取得元：'+md(e.source.pointer)+'／設定の版 '+md(e.source.revision),'','原文：','',...JSON.stringify(e.value,null,2).split('\n').map(l=>'    '+l),'');}
    if(o){lines.push('## 推測した業務ルール候補','');if(o.noRuleReason)lines.push(md(o.noRuleReason),'');for(const r of o.rules){lines.push('### '+md(r.inference),'','推測の理由：'+md(r.reasoning),'','根拠：'+md(r.evidenceRefs.map(x=>x.evidenceId+(x.pointer||'')).join('、')),'','関係者・役割：',...r.participants.map(p=>'- '+md(p.roleHypothesis+'（役割の候補）。設定上の関係：'+relations(p,s))),'','発生条件：'+md(r.trigger.interpretation),'','次の行動：'+md(r.nextAction.interpretation),'','確認事項：',...r.questions.map(q=>'- '+md(q.question+' '+q.whyItMatters)),'');}if(o.unassignedEvidence.length)lines.push('## 候補に整理していない設定','',...o.unassignedEvidence.map(u=>'- '+md(u.evidenceId+' '+s.evidence.find(e=>e.evidenceId===u.evidenceId)?.label+'：'+({insufficient_clues:'推測材料が不足',conflicting_clues:'整合性が未確認',context_only:'補助資料',output_limit:'出力上限のため未整理'}[u.reason]))),'');}
    lines.push('## 確認できていない範囲','',...s.limitations.map(l=>'- '+md(l.message)),'');return lines.join('\n');
  }
  function historyBody(doc){
    if(isWorkflow(doc.businessUnderstanding))return workflowHistoryBody(doc);
    const o=doc.businessUnderstanding,s=doc.snapshot;
    return {title:'過去の業務ルール候補（'+env(s)+'・版 '+s.revision+'）',sections:o?.rules.length?o.rules.map(r=>({heading:'推測：'+r.ruleId,paragraphs:[r.inference,r.reasoning,r.trigger.interpretation,r.nextAction.interpretation],items:[...r.participants.map(p=>p.roleHypothesis),...r.questions.map(q=>q.question)],table:null,evidenceIds:[]})):[{heading:'取得時点の記録',paragraphs:[o?.noRuleReason||'設定一覧を保存しました。業務ルール候補は未生成です。'],items:[],table:null,evidenceIds:[]}],unknowns:['過去の候補であり、現在の設定や業務上の確定事項ではありません。']};
  }
  return {escape,description,source,materialHtml,inventoryHtml,outputHtml,markdown,historyBody,workflowHtml,processHtml,readableCondition,conditionHtml};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTBusinessView };
