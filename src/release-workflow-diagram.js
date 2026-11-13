/* Deterministic SVG of acquired process transitions. No AI or external layout dependency. */
'use strict';
const KTWorkflowDiagram = (() => {
  let sequence = 0;
  const nextId = () => 'workflow-' + (++sequence);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Count Unicode code points; never cut a surrogate pair or discard long labels.
  const linesOf = (value, width = 16) => String(value ?? '').split(/\r?\n/).flatMap(line => {
    const chars = Array.from(line), out = [];
    for (let i = 0; i < chars.length; i += width) out.push(chars.slice(i, i + width).join(''));
    return out.length ? out : [''];
  });
  function layout(states, actions, { compact = false } = {}) {
    const nodes = states.map((e, i) => ({ evidence: e, key: e.evidenceId, name: String(e.value.name), order: i, missing: false }));
    const byName = new Map(nodes.map(n => [n.name, n]));
    // Malformed/imported snapshots still show each action, without pretending an endpoint was acquired.
    const endpoint = name => {
      name = String(name ?? '');
      if (!byName.has(name)) { const n = { evidence: null, key: 'missing-' + byName.size, name, order: nodes.length, missing: true }; nodes.push(n); byName.set(name, n); }
      return byName.get(name);
    };
    const edges = actions.map((e, i) => ({ evidence: e, order: i, from: endpoint(e.value.from), to: endpoint(e.value.to), lines: linesOf(e.value.name, 12) }));
    const outgoing = new Map(nodes.map(n => [n, []]));
    for (const e of edges) outgoing.get(e.from).push(e);
    // DFS back edges are excluded only while assigning ranks, never from the displayed graph.
    const colors = new Map(), forward = new Set();
    const visit = n => {
      colors.set(n, 1);
      for (const e of outgoing.get(n)) {
        if (e.from === e.to || colors.get(e.to) === 1) continue;
        forward.add(e);
        if (!colors.has(e.to)) visit(e.to);
      }
      colors.set(n, 2);
    };
    const hasIncoming = new Set(edges.filter(e => e.from !== e.to).map(e => e.to));
    for (const n of [...nodes.filter(n => !hasIncoming.has(n)), ...nodes]) if (!colors.has(n)) visit(n);
    const indegree = new Map(nodes.map(n => [n, 0]));
    for (const e of forward) indegree.set(e.to, indegree.get(e.to) + 1);
    const queue = nodes.filter(n => indegree.get(n) === 0);
    nodes.forEach(n => { n.rank = 0; n.lines = linesOf((n.missing ? '未取得：' : '') + n.name, compact ? 10 : 12); n.w = compact ? 168 : 200; n.h = compact ? Math.max(52, n.lines.length * 18 + 20) : Math.max(80, n.lines.length * 18 + 44); });
    while (queue.length) {
      const n = queue.shift();
      for (const e of outgoing.get(n)) if (forward.has(e)) {
        e.to.rank = Math.max(e.to.rank, n.rank + 1);
        indegree.set(e.to, indegree.get(e.to) - 1);
        if (!indegree.get(e.to)) { queue.push(e.to); queue.sort((a, b) => a.order - b.order); }
      }
    }
    const ranks = Array.from({ length: Math.max(0, ...nodes.map(n => n.rank)) + 1 }, () => []);
    nodes.forEach(n => ranks[n.rank].push(n));
    const outer = edges.filter(e => e.to.rank !== e.from.rank + 1);
    // Reuse outer lanes only for disjoint vertical spans.
    const lanes = [];
    for (const e of outer) {
      const span = [Math.min(e.from.rank, e.to.rank), Math.max(e.from.rank, e.to.rank)];
      let lane = lanes.findIndex(list => list.every(([lo, hi]) => span[1] < lo || span[0] > hi));
      if (lane < 0) { lane = lanes.length; lanes.push([]); }
      lanes[lane].push(span); e.lane = lane;
    }
    const nodeWidth = compact ? 168 : 200, stride = nodeWidth + 28, laneGap = compact ? 12 : 16;
    const left = (compact ? 20 : 30) + lanes.length * laneGap;
    const contentWidth = Math.max(1, ...ranks.map(row => row.length)) * stride - 28;
    let y = 24;
    for (let rank = 0; rank < ranks.length; rank++) {
      const row = ranks[rank], rowHeight = Math.max(compact ? 52 : 80, ...row.map(n => n.h));
      const entering = outer.filter(e => e.to.rank === rank), targets = [...new Set(entering.map(e => e.to))];
      // Enter above the row, never through sibling states. Only edges with the
      // same destination may share an entry band, so independent returns stay distinct.
      y += Math.max(0, targets.length - 1) * 14;
      for (const e of entering) e.entryY = y - 12 - targets.indexOf(e.to) * 14;
      row.forEach((n, i) => { n.x = left + (contentWidth - (row.length * stride - 28)) / 2 + i * stride; n.y = y; });
      if (compact) {
        const bandEdges = edges.filter(e => e.from.rank === rank), sources = [...new Set(bandEdges.map(e => e.from))];
        // Only branches from the same state share a horizontal band. Independent transitions stay distinct.
        for (const e of bandEdges) e.midY = y + rowHeight + 24 + sources.indexOf(e.from) * 14;
        y += rowHeight + 52 + Math.max(0, sources.length - 1) * 14; continue;
      }
      let band = y + rowHeight + 20;
      for (const e of edges.filter(e => e.from.rank === rank)) {
        e.labelY = band + 13;
        e.labelHeight = e.lines.length * 17 + 8;
        e.midY = band + e.labelHeight + 6;
        band += e.labelHeight + 14;
      }
      y = Math.max(y + rowHeight + 76, band + 30);
    }
    const width = left + contentWidth + 30;
    for (const e of edges) {
      const a = e.from, b = e.to;
      e.kind = a === b ? 'self' : b.rank <= a.rank ? 'return' : 'forward';
      e.labelX = a.x + 12; e.labelWidth = a.w - 24;
      if (e.lane != null) {
        const laneX = left - laneGap - e.lane * laneGap;
        // Back/long/self actions use the outer lane and the destination's clear
        // entry band before reaching its top edge; no other state is crossed.
        e.path = `M ${a.x + a.w / 2 - (compact ? 8 : 0)} ${a.y + a.h} V ${e.midY} H ${laneX} V ${e.entryY} H ${b.x + b.w / 2 + (compact ? 8 : 0)} V ${b.y}`;
      } else {
        const sx = a.x + a.w / 2 - (compact ? 8 : 0), tx = b.x + b.w / 2 + (compact ? 8 : 0);
        e.path = `M ${sx} ${a.y + a.h} V ${e.midY} H ${tx} V ${b.y}`;
      }
    }
    return { nodes, edges, width, height: Math.max(140, y) };
  }
  function render({ states = [], actions = [], prefix = nextId(), disabled = false, stateTarget = () => null, actionTarget = () => null } = {}) {
    if (!states.length && !actions.length) return '';
    const graph = layout(states, actions), marker = prefix + '-arrow', title = prefix + '-diagram-title', note = prefix + '-diagram-note';
    const tspans = (lines, x, y, step) => lines.map((text, i) => '<tspan x="' + x + '" y="' + (y + i * step) + '">' + escape(text) + '</tspan>').join('');
    const edgeHtml = graph.edges.map(e => {
      const id = e.evidence.evidenceId, href = actionTarget(e.evidence);
      const label = '<rect x="' + (e.labelX - 4) + '" y="' + (e.labelY - 13) + '" width="' + e.labelWidth + '" height="' + e.labelHeight + '" rx="4" fill="white"/><text x="' + e.labelX + '" y="' + e.labelY + '" font-size="13" fill="currentColor">' + tspans(e.lines, e.labelX, e.labelY, 17) + '</text>';
      return '<g class="ktr-workflow-diagram-edge" data-workflow-edge="' + escape(id) + '" data-workflow-from="' + escape(e.from.name) + '" data-workflow-to="' + escape(e.to.name) + '" data-workflow-edge-kind="' + e.kind + '"><title>' + escape(e.evidence.value.name + '：' + e.from.name + ' → ' + e.to.name) + '</title><path d="' + e.path + '" fill="none" stroke="currentColor" stroke-width="1.6" marker-end="url(#' + escape(marker) + ')"/>' + (href ? '<a class="ktr-workflow-diagram-label" href="#' + escape(href) + '" tabindex="0" aria-label="' + escape(e.evidence.value.name + 'の設定を確認') + '">' + label + '</a>' : label) + '</g>';
    }).join('');
    const nodeHtml = graph.nodes.map(n => {
      const t = n.evidence ? stateTarget(n.evidence) : null;
      const hint = n.missing ? '状態設定は未取得' : t?.kind === 'stage' ? 'クリックで工程の説明' : 'クリックで設定の説明';
      const content = '<rect x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h + '" rx="10" fill="white" stroke="currentColor" stroke-width="1.6"' + (n.missing ? ' stroke-dasharray="5 3"' : '') + '/><text x="' + (n.x + 14) + '" y="' + (n.y + 26) + '" font-size="14" fill="currentColor">' + tspans(n.lines, n.x + 14, n.y + 26, 18) + '</text><text x="' + (n.x + 14) + '" y="' + (n.y + n.h - 12) + '" font-size="11" fill="currentColor">' + escape(hint) + '</text>';
      return '<g class="ktr-workflow-diagram-node' + (n.missing ? ' ktr-workflow-diagram-missing' : '') + '" data-workflow-node="' + escape(n.key) + '"><title>' + escape(n.name + '／' + hint) + '</title>' + (t?.id ? '<a href="#' + escape(t.id) + '" tabindex="0" data-workflow-node-target="' + escape(t.kind) + '" aria-label="' + escape(n.name + '：' + hint) + '">' + content + '</a>' : content) + '</g>';
    }).join('');
    return '<div class="ktr-workflow-diagram"' + (disabled ? ' data-workflow-diagram-disabled="true"' : '') + '><div class="ktr-workflow-diagram-toolbar"><label>図の倍率 <select data-workflow-scale aria-label="図の倍率"><option value="0.5">50%</option><option value="0.75">75%</option><option value="1" selected>100%</option><option value="1.25">125%</option><option value="1.5">150%</option></select></label><small>図をスクロールできます</small></div><div class="ktr-workflow-diagram-scroll" data-workflow-diagram-scroll tabindex="0" aria-label="プロセスの遷移図"><svg class="ktr-workflow-diagram-svg" data-workflow-diagram data-natural-width="' + graph.width + '" data-natural-height="' + graph.height + '" width="' + graph.width + '" height="' + graph.height + '" viewBox="0 0 ' + graph.width + ' ' + graph.height + '" role="group" aria-labelledby="' + escape(title) + '" aria-describedby="' + escape(note) + '" xmlns="http://www.w3.org/2000/svg"><title id="' + escape(title) + '">' + (disabled ? '参考：無効なプロセス定義の遷移図' : '設定から確認したプロセスの遷移図') + '</title><desc id="' + escape(note) + '">' + graph.nodes.filter(n => !n.missing).length + 'ステータス、' + graph.edges.length + 'アクション。矢印は設定された遷移です。配置順は実行順を保証しません。設定の全件一覧も図の下で確認できます。</desc><defs><marker id="' + escape(marker) + '" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor"/></marker></defs>' + edgeHtml + nodeHtml + '</svg></div></div>';
  }
  // Direct neighbors only. A self-loop belongs to both directions, while each
  // original edge (and every supporting action ID) remains in relatedEdges once.
  function neighborhood(nodes = [], edges = [], selectedKey) {
    const selected = nodes.find(node => node.key === selectedKey) || null;
    if (!selected) return { selected: null, previous: [], next: [], relatedEdges: [] };
    const relatedEdges = edges.filter(edge => edge.from === selectedKey || edge.to === selectedKey);
    const previous = new Set(relatedEdges.filter(edge => edge.to === selectedKey).map(edge => edge.from));
    const next = new Set(relatedEdges.filter(edge => edge.from === selectedKey).map(edge => edge.to));
    return { selected, previous: nodes.filter(node => previous.has(node.key)), next: nodes.filter(node => next.has(node.key)), relatedEdges };
  }
  function renderOverview({ states = [], actions = [], stages = [], prefix = nextId(), stateTarget = () => null, stageTarget = () => null } = {}) {
    // One line per directed connection. All underlying action IDs remain available in details.
    const grouped = new Map();
    for (const action of actions) {
      const key = JSON.stringify([action.value.from, action.value.to]);
      if (!grouped.has(key)) grouped.set(key, { ...action, actionIds: [], value: { ...action.value } });
      grouped.get(key).actionIds.push(action.evidenceId);
    }
    let html = '<div class="ktr-workflow-summary" data-workflow-overview>';
    if (states.length || actions.length) {
      const graph = layout(states, [...grouped.values()], { compact: true }), marker = prefix + '-overview-arrow', title = prefix + '-overview-title';
      const edges = graph.edges.map(e => '<g class="ktr-workflow-overview-edge" data-workflow-overview-actions="' + escape(e.evidence.actionIds.join(' ')) + '" data-workflow-overview-from="' + escape(e.from.key) + '" data-workflow-overview-to="' + escape(e.to.key) + '"><title>' + escape(e.from.name + ' → ' + e.to.name + '／' + e.evidence.actionIds.length + '操作。条件は詳細で確認') + '</title><path d="' + e.path + '" marker-end="url(#' + escape(marker) + ')"/></g>').join('');
      const nodes = graph.nodes.map(n => {
        const target = n.evidence ? stateTarget(n.evidence)?.id || '' : '';
        const label = (n.missing ? '未取得：' : '') + n.name + '：前後のつながりを強調';
        const content = '<rect x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h + '" rx="8"/><text>' + n.lines.map((line,i) => '<tspan x="' + (n.x + n.w / 2) + '" y="' + (n.y + (n.h - n.lines.length * 18) / 2 + 14 + i * 18) + '">' + escape(line) + '</tspan>').join('') + '</text>';
        return '<g class="ktr-workflow-overview-node' + (n.missing ? ' ktr-workflow-overview-missing' : '') + '" data-workflow-overview-node="' + escape(n.key) + '" data-workflow-overview-name="' + escape(n.name) + '" data-workflow-overview-target="' + escape(target) + '"><title>' + escape(n.missing ? n.name + '：状態の定義は未取得' : label) + '</title><a' + (target ? ' href="#' + escape(target) + '"' : '') + ' data-workflow-overview-select="' + escape(n.key) + '" tabindex="0" role="button" aria-pressed="false" aria-label="' + escape(label) + '">' + content + '</a></g>';
      }).join('');
      const picker = '<label>強調する工程 <select data-workflow-overview-picker aria-label="強調する工程"><option value="">工程を選ぶ</option>' + graph.nodes.map(n => '<option value="' + escape(n.key) + '">' + escape((n.missing ? '未取得：' : '') + n.name) + '</option>').join('') + '</select></label>';
      const zoom = '<label>主図の倍率 <select data-workflow-overview-zoom aria-label="主図の倍率"><option value="1" selected>100%</option><option value="1.5">150%</option><option value="2">200%</option></select></label>';
      const minimap = '<div class="ktr-workflow-minimap-row"><div><strong>全体の案内図</strong><p class="ktr-note">青い枠が主図の表示範囲です。案内図を押すと移動できます。</p></div><svg class="ktr-workflow-minimap" data-workflow-minimap viewBox="0 0 '+graph.width+' '+graph.height+'" role="img" aria-label="全工程と主図の表示範囲">'+graph.edges.map(e=>'<path d="'+e.path+'"/>').join('')+graph.nodes.map(n=>'<rect data-workflow-map-node="'+escape(n.key)+'" x="'+n.x+'" y="'+n.y+'" width="'+n.w+'" height="'+n.h+'"/>').join('')+'<rect data-workflow-map-viewport x="0" y="0" width="0" height="0"/></svg></div>';
      html += '<div class="ktr-workflow-overview-graph" data-workflow-overview-root><p class="ktr-note">標準ステータスのつながり（設定の事実）</p><div class="ktr-workflow-overview-toolbar">' + picker + zoom + '<button type="button" data-workflow-overview-clear>強調を解除</button><button type="button" data-workflow-wide aria-expanded="false">図を広く見る</button><span class="ktr-workflow-pan-controls" aria-label="主図の移動"><button type="button" data-workflow-pan="left" aria-label="主図を左へ移動">←</button><button type="button" data-workflow-pan="up" aria-label="主図を上へ移動">↑</button><button type="button" data-workflow-pan="down" aria-label="主図を下へ移動">↓</button><button type="button" data-workflow-pan="right" aria-label="主図を右へ移動">→</button></span></div>'+minimap+'<p class="ktr-note">主図はドラッグ・スクロール・矢印キーで移動できます。工程を選ぶと、その位置へ移動します。</p><div class="ktr-workflow-overview-canvas" tabindex="0" aria-label="業務工程の主図。矢印キーで表示範囲を移動"><svg class="ktr-workflow-overview-svg" data-natural-width="' + graph.width + '" data-natural-height="' + graph.height + '" width="' + graph.width + '" height="' + graph.height + '" viewBox="0 0 ' + graph.width + ' ' + graph.height + '" role="group" aria-labelledby="' + escape(title) + '" xmlns="http://www.w3.org/2000/svg"><title id="' + escape(title) + '">業務工程の概要図</title><defs><marker id="' + escape(marker) + '" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z"/></marker></defs>' + edges + nodes + '</svg></div><div class="ktr-workflow-overview-selection" data-workflow-overview-selection aria-live="polite"></div><p class="ktr-note">矢印は遷移設定があることを示します。工程を選ぶと、直接つながる前後の工程を強調します。操作・実行条件・担当は各工程の詳細で確認してください。常に進めることや、表示順での実行を意味しません。</p>';
      if (graph.nodes.some(n => n.missing)) html += '<p class="ktr-note">破線の工程は状態の定義が未取得です。操作の参照先を示しており、その工程を確認済みとは判断しません。</p>';
      html += '</div>';
    }
    if (stages.length) {
      html += '<div class="ktr-workflow-overview-unlinked"><p class="ktr-note">' + (states.length ? '標準プロセスとの対応が未特定の工程' : '設定から推測した工程') + '。工程間の順序・つながりは未確認のため、矢印は付けていません。</p><div class="ktr-workflow-overview-map">' + stages.map(r => '<a class="ktr-workflow-overview-stage" data-workflow-overview-node="' + escape(r.ruleId) + '" href="#' + escape(stageTarget(r)) + '"><strong>' + escape(r.stageName) + '</strong><span>詳細を見る</span></a>').join('') + '</div></div>';
    }
    if (!states.length && !actions.length && !stages.length) html += '<p>図にできる工程はまだ特定されていません。取得状態と設定の詳細を確認してください。</p>';
    return html + '</div>';
  }
  return { nextId, linesOf, layout, render, renderOverview, neighborhood };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTWorkflowDiagram };
