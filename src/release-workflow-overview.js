/* Local reading controls for the process overview. Never updates the consultation or saved analysis. */
'use strict';
const KTWorkflowOverview = (() => {
  const D = typeof KTWorkflowDiagram !== 'undefined' ? KTWorkflowDiagram : require('./release-workflow-diagram.js').KTWorkflowDiagram;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  function scaleFor(width, height, availableWidth, zoom = '1') {
    if (!(width > 0 && height > 0 && availableWidth > 0)) return null;
    return ['1','1.5','2'].includes(zoom) ? Number(zoom) : 1;
  }
  function mount(root, initial = {}) {
    if (!root) return null;
    const canvas = root.querySelector('.ktr-workflow-overview-canvas'), svg = root.querySelector('.ktr-workflow-overview-svg');
    if (!canvas || !svg) return null;
    const picker = root.querySelector('[data-workflow-overview-picker]'), zoomPicker = root.querySelector('[data-workflow-overview-zoom]');
    const summary = root.querySelector('[data-workflow-overview-selection]'), clear = root.querySelector('[data-workflow-overview-clear]');
    const nodeElements = Array.from(svg.querySelectorAll('[data-workflow-overview-node]'));
    const edgeElements = Array.from(svg.querySelectorAll('[data-workflow-overview-actions]'));
    const nodes = nodeElements.map(el => ({key:el.dataset.workflowOverviewNode,name:el.dataset.workflowOverviewName,target:el.dataset.workflowOverviewTarget || null,missing:el.classList.contains('ktr-workflow-overview-missing')}));
    const edges = edgeElements.map(el => ({from:el.dataset.workflowOverviewFrom,to:el.dataset.workflowOverviewTo,ids:el.dataset.workflowOverviewActions.split(' ').filter(Boolean)}));
    let selected = nodes.some(n => n.key === initial.selected) ? initial.selected : null;
    let zoom = ['1','1.5','2'].includes(initial.zoom) ? initial.zoom : '1', disposed = false;
    const width = Number(svg.dataset.naturalWidth), height = Number(svg.dataset.naturalHeight);
    const map = root.querySelector('[data-workflow-minimap]'), viewport = root.querySelector('[data-workflow-map-viewport]'), wide = root.querySelector('[data-workflow-wide]');
    let expanded = false, drag = null;
    const clamp = (value,max) => Math.max(0,Math.min(value,Math.max(0,max)));
    function syncMap() {
      if(disposed || !viewport || !canvas.clientWidth)return;
      const box = viewportFor(width,height,Number(zoom),canvas.clientWidth,canvas.clientHeight,canvas.scrollLeft,canvas.scrollTop);
      for(const [key,value] of Object.entries(box))viewport.setAttribute(key,String(value));
    }
    function move(left,top) {
      canvas.scrollLeft=clamp(left,width*Number(zoom)-canvas.clientWidth);
      canvas.scrollTop=clamp(top,height*Number(zoom)-canvas.clientHeight);
      syncMap();
    }
    function centerNode() {
      const node=nodeElements.find(el=>el.dataset.workflowOverviewNode===selected), rect=node?.querySelector('rect');
      if(!rect || !canvas.clientWidth)return;
      move((Number(rect.getAttribute('x'))+Number(rect.getAttribute('width'))/2)*Number(zoom)-canvas.clientWidth/2,
        (Number(rect.getAttribute('y'))+Number(rect.getAttribute('height'))/2)*Number(zoom)-canvas.clientHeight/2);
    }
    function mapMove(event) {
      const point=mapPoint(width,height,map.getBoundingClientRect(),event.clientX,event.clientY);
      move(point.x*Number(zoom)-canvas.clientWidth/2,point.y*Number(zoom)-canvas.clientHeight/2);
    }
    function toggleWide() {
      const cx=canvas.scrollLeft+canvas.clientWidth/2,cy=canvas.scrollTop+canvas.clientHeight/2;
      expanded=!expanded;root.dataset.workflowExpanded=String(expanded);
      if(wide){wide.textContent=expanded?'元の幅に戻す':'図を広く見る';wide.setAttribute('aria-expanded',String(expanded));}
      size();move(cx-canvas.clientWidth/2,cy-canvas.clientHeight/2);
    }
    const win = root.ownerDocument?.defaultView;
    let measuredWidth = null, measuredHeight = null, resizeFrame = null;
    function size() {
      measuredWidth = canvas.clientWidth;measuredHeight=canvas.clientHeight;
      const scale = scaleFor(width,height,measuredWidth,zoom);
      if (scale === null) return;
      const nextWidth = width * scale + 'px', nextHeight = height * scale + 'px';
      if(svg.style.width !== nextWidth)svg.style.width = nextWidth;
      if(svg.style.height !== nextHeight)svg.style.height = nextHeight;
      canvas.dataset.workflowOverviewMode = zoom;
      syncMap();
    }
    function paint() {
      const around = D.neighborhood(nodes,edges,selected), prev = new Set(around.previous.map(n => n.key)), next = new Set(around.next.map(n => n.key));
      root.dataset.workflowHasSelection = String(!!around.selected);
      nodeElements.forEach(el => {
        const key = el.dataset.workflowOverviewNode;
        const focus = key === selected ? 'selected' : prev.has(key) && next.has(key) ? 'both' : prev.has(key) ? 'previous' : next.has(key) ? 'next' : 'unrelated';
        el.dataset.workflowFocus = around.selected ? focus : '';
        el.querySelector('[data-workflow-overview-select]')?.setAttribute('aria-pressed',String(key === selected));
      });
      edgeElements.forEach(el => {
        const incoming = el.dataset.workflowOverviewTo === selected, outgoing = el.dataset.workflowOverviewFrom === selected;
        el.dataset.workflowFocus = around.selected ? incoming && outgoing ? 'both' : incoming ? 'incoming' : outgoing ? 'outgoing' : 'unrelated' : '';
      });
      for(const el of map?.querySelectorAll('[data-workflow-map-node]') || [])el.dataset.workflowFocus=el.dataset.workflowMapNode===selected?'selected':'';
      if (picker) picker.value = selected || '';
      if (zoomPicker) zoomPicker.value = zoom;
      if (clear) clear.disabled = !selected;
      if (!summary) return;
      if (!around.selected) { summary.innerHTML = '<p class="ktr-note">工程を選ぶと、その工程と直接つながる前後を強調します。主図の工程名は縮小せず表示しています。</p>'; return; }
      const nodeLabel = n => (n.missing ? '未取得：' : '') + n.name;
      const connections = (label,items) => '<div class="ktr-workflow-neighbors"><strong>'+label+'（'+items.length+'）</strong><span tabindex="0" aria-label="'+label+'の一覧">'+(items.length ? items.map(n => '<button type="button" data-workflow-overview-select="'+esc(n.key)+'">'+esc(nodeLabel(n))+(n.key === selected ? '（同じ工程）' : '')+'</button>').join('') : '<span class="ktr-note">取得した遷移に該当なし</span>')+'</span></div>';
      const arrow = '<span class="ktr-workflow-focus-arrow" aria-hidden="true"></span>';
      const current = '<div class="ktr-workflow-focus-current"><strong>選択した工程</strong><div><strong>'+esc(nodeLabel(around.selected))+'</strong>'+(around.selected.target ? '<a class="ktr-workflow-overview-detail" href="#'+esc(around.selected.target)+'">工程の詳細を見る</a>' : '<span>状態の定義は未取得です</span>')+'</div></div>';
      summary.innerHTML = '<div class="ktr-workflow-focus-heading"><strong>前後のつながり</strong><span>工程を押すと、その前後へ移動できます</span></div><div class="ktr-workflow-focus-flow">'+connections('前工程',around.previous)+(around.previous.length?arrow:'<span></span>')+current+(around.next.length?arrow:'<span></span>')+connections('次工程',around.next)+'</div><p class="ktr-note">設定上の直接のつながりです。分岐の条件・担当・入力・通知は各工程の詳細で確認できます。</p>';
    }
    function select(key) { if (disposed) return; selected = nodes.some(n => n.key === key) ? key : null; paint(); centerNode(); }
    function setZoom(value) { if (disposed || !['1','1.5','2'].includes(value)) return; const cx=(canvas.scrollLeft+canvas.clientWidth/2)/Number(zoom),cy=(canvas.scrollTop+canvas.clientHeight/2)/Number(zoom);zoom = value; size();move(cx*Number(zoom)-canvas.clientWidth/2,cy*Number(zoom)-canvas.clientHeight/2);if(zoomPicker)zoomPicker.value=zoom; }
    function click(event) {
      if(expanded && event.target?.closest?.('.ktr-workflow-overview-detail'))toggleWide();
      if(event.target?.closest?.('[data-workflow-wide]')){event.preventDefault();event.stopPropagation();toggleWide();return;}
      const pan=event.target?.closest?.('[data-workflow-pan]');
      if(pan){event.preventDefault();event.stopPropagation();const key=pan.dataset.workflowPan;move(canvas.scrollLeft+({left:-240,right:240}[key]||0),canvas.scrollTop+({up:-180,down:180}[key]||0));return;}
      const button = event.target?.closest?.('[data-workflow-overview-select]');
      if (button && root.contains(button)) { event.preventDefault(); event.stopPropagation(); const pickerHadFocus = button.closest('.ktr-workflow-neighbors'); select(button.dataset.workflowOverviewSelect); if(pickerHadFocus)picker?.focus({preventScroll:true}); return; }
      if (event.target?.closest?.('[data-workflow-overview-clear]')) { event.preventDefault(); event.stopPropagation(); select(null); picker?.focus({preventScroll:true}); }
    }
    function change(event) {
      if(event.target === picker) { event.stopPropagation(); select(picker.value); }
      if(event.target === zoomPicker) { event.stopPropagation(); setZoom(zoomPicker.value); }
    }
    function keydown(event) {
      if(event.key==='Escape' && expanded){event.preventDefault();event.stopPropagation();toggleWide();wide?.focus({preventScroll:true});return;}
      if(event.target===canvas && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key)){
        event.preventDefault();event.stopPropagation();
        if(event.key==='Home')move(0,0);
        else move(canvas.scrollLeft+({ArrowLeft:-120,ArrowRight:120}[event.key]||0),canvas.scrollTop+({ArrowUp:-100,ArrowDown:100}[event.key]||0));return;
      }
      const node = event.target?.closest?.('a[data-workflow-overview-select]');
      if(node && ['Enter',' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); select(node.dataset.workflowOverviewSelect); }
      if(event.key === 'Escape' && selected) { event.preventDefault(); event.stopPropagation(); select(null); picker?.focus({preventScroll:true}); }
    }
    function pointerdown(event) {
      if(event.button!==0)return;
      const area=event.target?.closest?.('[data-workflow-minimap],.ktr-workflow-overview-canvas');
      if(!area || (area===canvas && event.target?.closest?.('a')))return;
      drag={area,id:event.pointerId,x:event.clientX,y:event.clientY,left:canvas.scrollLeft,top:canvas.scrollTop};
      area.setPointerCapture?.(event.pointerId);if(area===map)mapMove(event);event.preventDefault();
    }
    function pointermove(event) {
      if(!drag || drag.id!==event.pointerId)return;
      if(drag.area===map)mapMove(event);else move(drag.left-(event.clientX-drag.x),drag.top-(event.clientY-drag.y));
    }
    function pointerup(event) {if(drag?.id===event.pointerId){drag.area.releasePointerCapture?.(event.pointerId);drag=null;}}
    root.addEventListener('pointerdown',pointerdown);root.addEventListener('pointermove',pointermove);root.addEventListener('pointerup',pointerup);root.addEventListener('pointercancel',pointerup);
    canvas.addEventListener?.('scroll',syncMap);
    root.addEventListener('click',click); root.addEventListener('change',change); root.addEventListener('keydown',keydown);
    paint(); size();
    move(Number(initial.left)||0,Number(initial.top)||0);
    const Observer = win?.ResizeObserver;
    // Resize the map viewport after layout settles; never shrink the main diagram.
    const observer = Observer ? new Observer(() => {
      if(disposed || (canvas.clientWidth === measuredWidth && canvas.clientHeight === measuredHeight) || resizeFrame !== null)return;
      if(win.requestAnimationFrame)resizeFrame=win.requestAnimationFrame(() => { resizeFrame=null;if(!disposed)size(); });
      else size();
    }) : null;
    observer?.observe(canvas);
    return {select,setZoom,getState:()=>({selected,zoom,left:canvas.scrollLeft,top:canvas.scrollTop}),dispose(){ disposed=true;drag=null;observer?.disconnect();canvas.removeEventListener?.('scroll',syncMap);root.removeEventListener('pointerdown',pointerdown);root.removeEventListener('pointermove',pointermove);root.removeEventListener('pointerup',pointerup);root.removeEventListener('pointercancel',pointerup);if(resizeFrame!==null)win?.cancelAnimationFrame?.(resizeFrame);root.removeEventListener('click',click);root.removeEventListener('change',change);root.removeEventListener('keydown',keydown); }};
  }
  function viewportFor(width,height,scale,clientWidth,clientHeight,left,top) {
    const w=Math.min(width,clientWidth/scale),h=Math.min(height,clientHeight/scale);
    return {x:Math.max(0,Math.min(left/scale,width-w)),y:Math.max(0,Math.min(top/scale,height-h)),width:w,height:h};
  }
  function mapPoint(width,height,rect,x,y) {
    const scale=Math.min(rect.width/width,rect.height/height);
    return {x:Math.max(0,Math.min(width,(x-rect.left-(rect.width-width*scale)/2)/scale)),y:Math.max(0,Math.min(height,(y-rect.top-(rect.height-height*scale)/2)/scale))};
  }
  return {mount,scaleFor,viewportFor,mapPoint};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTWorkflowOverview };
