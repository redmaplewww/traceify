import {NODE_WIDTH, NODE_HEIGHT, edgePath, edgeLabelPosition, clampPosition, bindCanvas} from './agentloop-canvas.js';
import {icon} from './icons.js';
import {MODULE_COLORS, inferModules, moduleFrames, nodeModule, arrangeModules} from './modules.js';
import {clone, normalize, derive, emptyWorkspace, liveNodes, liveEdges, addDraftNode, addEdge, editItem, deleteItem, mergeNodes, History, targetSignature, applyEnrichment, sourceRef, canEnrich, takeAutoEnrichments} from './graph.js';

const $=id=>document.getElementById(id);
const html=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={concept:'概念',claim:'观点',entity:'实体',section:'章节',evidence:'证据',other:'其他'};
const colors={concept:'#3673c8',claim:'#9866b8',entity:'#557e9c',section:'#be8340',evidence:'#248b79',other:'#77849a'};
const CACHE='traceify-workspace-v2';
let w,version=0,generation=0,dirty=false,saving=false,conflict=false,saveTimer,retryCount=0;
let selection=null,outlineMode='components',inspectorTab='details',activeSegment=null,search='',zoom=1,history=new History();
let settings={configured:false},dragBefore=null,wirePreview=null,inspectorDirty=false,toastTimer,canvasController=null;
const tasks=new Map();
let captionBounds = [];
let moduleBounds = [];
const formDrafts = new Map();
const DRAFT_CACHE = CACHE + '-property-drafts';
const captionMeasure = document.createElement('canvas').getContext('2d');
captionMeasure.font = '14px "Segoe UI", "Microsoft YaHei", sans-serif';

function draftSource() {
  return `${w.id}:${w.source.content_hash || w.source.id}:${w.source.title}`;
}
function draftKey(kind, id) {
  return `${draftSource()}:${kind}:${id}`;
}
function activeFormDrafts() {
  return [...formDrafts.entries()].filter(([, draft]) => {
    const items = draft.kind === 'node' ? w.graph.nodes : w.graph.edges;
    return draft.source === draftSource() && items.some(item => item.id === draft.id && item.status !== 'deleted');
  });
}
function persistFormDrafts() {
  try {
    localStorage.setItem(DRAFT_CACHE, JSON.stringify([...formDrafts.entries()]));
    cache();
  } catch {
    error('属性草稿暂存失败。请保持页面打开并点击保存修改。');
  }
}
function trackFormDraft(event) {
  const field = event.target;
  const form = event.currentTarget;
  const kind = form.dataset.kind;
  const id = form.dataset.id;
  const source = form.dataset.source;
  const allowed = ['label', 'kind', 'summary', 'content', 'relation', 'relation_basis', 'source_refs'];
  const items = kind === 'node' ? w.graph.nodes : w.graph.edges;
  const item = items.find(candidate => candidate.id === id && candidate.status !== 'deleted');
  if (!allowed.includes(field.name) || !item || source !== draftSource()) return;
  const key = draftKey(kind, id);
  const draft = formDrafts.get(key) || {
    source, kind, id, fields: {}
  };
  let value = field.value;
  let original = item[field.name] ?? '';
  if (field.name === 'source_refs') {
    value = [...form.querySelectorAll('input[name=source_refs]:checked')].map(input => input.value).sort();
    original = item.source_refs.map(ref => ref.locator).sort();
  }
  if (field.name === 'label' && item.needs_details) original = '';
  if (JSON.stringify(value) === JSON.stringify(original)) delete draft.fields[field.name];
  else draft.fields[field.name] = value;
  if (Object.keys(draft.fields).length) formDrafts.set(key, draft);
  else formDrafts.delete(key);
  inspectorDirty = Boolean(selection && formDrafts.has(draftKey(selection.kind, selection.id)));
  persistFormDrafts();
  saveStatus(dirty ? '图谱修改待保存' : `已保存 · v${version}`);
  const notice = $('draft-notice');
  if (notice) {
    notice.hidden = !inspectorDirty;
    notice.textContent = '属性草稿已暂存，点击保存修改应用到图谱';
  }
}
function submitFormDrafts(entries = activeFormDrafts()) {
  if (!entries.length) return true;
  for (const [, draft] of entries) {
    const title = draft.fields[draft.kind === 'node' ? 'label' : 'relation'];
    if (typeof title === 'string' && !title.trim()) {
      select(draft.kind, draft.id);
      toast('请填写名称，再保存属性修改。');
      focusInspector(draft.kind === 'node' ? 'label' : 'relation');
      return false;
    }
  }
  entries.forEach(([key]) => formDrafts.delete(key));
  const succeeded = commit(() => {
    for (const [, draft] of entries) {
      const patch = {};
      for (const [field, value] of Object.entries(draft.fields)) {
        if (field === 'source_refs') {
          patch.source_refs = w.source.segments.filter(segment => value.includes(segment.id)).map(segment => sourceRef(w, segment));
        } else if (['label', 'kind', 'summary', 'content', 'relation', 'relation_basis'].includes(field)) {
          patch[field] = String(value).trim();
        }
      }
      editItem(w, draft.kind, draft.id, patch);
    }
  }, '属性修改已保存');
  if (!succeeded) entries.forEach(([key, draft]) => formDrafts.set(key, draft));
  persistFormDrafts();
  return succeeded;
}

function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4300);}
function error(message){$('error-banner').textContent=message;$('error-banner').hidden=!message;}
async function api(path,options={}){
  const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...options.headers}});
  let body;try{body=await response.json();}catch{throw Error('服务返回格式异常，手动内容已保留');}
  if(!response.ok){const e=Error(body.error||'请求失败');e.status=response.status;e.latest=body.latest_version;throw e;}
  return body;
}
function cache(){
  try{localStorage.setItem(CACHE,JSON.stringify({workspace:w,base_version:version,dirty,generation,selection,saved_at:new Date().toISOString()}));}
  catch{error('浏览器恢复副本保存失败。请保持页面打开并点击保存，将内容写入本机工作区。');}
}
function saveStatus(message){
  if (w && activeFormDrafts().length && message.startsWith('已保存')) {
    message = `属性草稿 · ${activeFormDrafts().length} 项待保存`;
  }
  $('save-status').textContent=message;
  $('save-status').dataset.state=message.includes('冲突')?'conflict':message.includes('失败')||message.includes('离线')?'error':message.includes('保存中')?'saving':message.includes('已保存')?'saved':'pending';
}
function scheduleSave(){dirty=true;w.sync={...w.sync,state:'local_pending'};cache();saveStatus('本地修改 · 待保存');clearTimeout(saveTimer);if(!conflict)saveTimer=setTimeout(()=>save(),500);}
async function save(){
  clearTimeout(saveTimer);if(!w||conflict)return;
  if(saving)return;
  if(!dirty){saveStatus(`已保存 · v${version}`);return;}
  saving=true;saveStatus('保存中…');const at=generation,snapshot=clone(w);
  snapshot.sync={state:'synced',last_synced_at:new Date().toISOString(),retry_count:0,conflicts:[]};
  try{
    const result=await api('/api/workspace',{method:'PUT',body:JSON.stringify({expected_version:version,workspace:snapshot})});
    version=result.version;retryCount=0;dirty=at!==generation;w.sync={...snapshot.sync,state:dirty?'local_pending':'synced'};cache();
    saveStatus(dirty?'还有修改待保存':`已保存 · v${version}`);
  }catch(e){
    dirty=true;w.sync={...w.sync,state:e.status===409?'conflict':'retrying'};
    if(e.status===409){conflict=true;$('conflict-banner').hidden=false;saveStatus('版本冲突 · 本地已保留');}
    else{saveStatus('保存失败 · 本地已保留');if(retryCount<3){retryCount++;saveTimer=setTimeout(()=>save(),1500*retryCount);}else error(e.message+'。点击保存可重试。');}
    cache();
  }finally{saving=false;if(dirty&&!conflict&&retryCount===0)saveTimer=setTimeout(()=>save(),300);}
}
function commit(action,message,options={}){
  const before=clone(w);let automatic=[];
  try{action();derive(w);if($('auto-fill').checked)automatic=takeAutoEnrichments(w);}catch(e){w=before;toast(e.message);return false;}
  history.push(before);generation++;scheduleSave();render(options);if(message)toast(message);
  if(automatic.length)queueMicrotask(()=>automatic.forEach(t=>void enrich(t.kind,t.id,settings.configured?'model':'source')));
  return true;
}
function current(){return selection?(selection.kind==='node'?w.graph.nodes:w.graph.edges).find(n=>n.id===selection.id&&n.status!=='deleted'):null;}
function select(kind,id,show=true){
  const changed=selection?.id!==id||selection?.kind!==kind;
  selection={kind,id};
  if(show)inspectorTab='details';
  if(show)setPanel('right');
  if(changed||show){inspectorDirty=formDrafts.has(draftKey(kind,id));renderInspector();}
  updateSelection();renderEdges();renderOutline();updateAssist();
}
function updateSelection(){
  const mapping=activeSegment?w.mappings.find(m=>m.source_ref.locator===activeSegment):null;
  document.querySelectorAll('[data-node]').forEach(el=>{
    const n=w.graph.nodes.find(n=>n.id===el.dataset.node);
    el.classList.toggle('selected',selection?.kind==='node'&&selection.id===el.dataset.node||Boolean(mapping?.node_ids.includes(el.dataset.node)));
    el.classList.toggle('dim',Boolean(search&&!n.label.toLowerCase().includes(search)));
  });
}
function nodePosition(id){return w.layout.positions[id]||{x:80,y:80};}
function nodeColor(node) {
  if (node.kind === 'concept' && w.graph.groups?.length && node.id === liveNodes(w)[0]?.id) return '#5267d9';
  if (node.kind === 'concept') return nodeModule(w, node.id)?.color || colors.concept;
  return colors[node.kind] || colors.other;
}
function renderModules() {
  moduleBounds = moduleFrames(w);
  $('module-layer').innerHTML = moduleBounds.map(group => `
    <section class="module-frame ${group.parent_id ? 'nested-module' : 'root-module'}" data-module="${html(group.id)}"
      style="left:${group.x}px;top:${group.y}px;width:${group.width}px;height:${group.height}px;--module-color:${/^#[0-9a-f]{6}$/i.test(group.color) ? group.color : '#788cae'}"
      aria-label="${html(group.label)}，${group.member_ids.length}个节点">
      <div class="module-header" title="${html(group.basis || '用户整理的模块')}"><i></i><strong>${html(group.label)}</strong><span class="module-count">${group.member_ids.length} 个节点</span></div>
    </section>`).join('');
}
function assignNodeModule(nodeId, groupId) {
  w.layout.grouping_mode = 'manual';
  for (const group of w.graph.groups) group.node_ids = group.node_ids.filter(id => id !== nodeId);
  const target = w.graph.groups.find(group => group.id === groupId);
  if (target) target.node_ids.push(nodeId);
}
function renderEdges() {
  renderModules();
  const nodes = new Map(liveNodes(w).map(node => [node.id, node]));
  const obstacles = [...nodes.values()].map(node => {
    const position = nodePosition(node.id);
    return {x: position.x - 6, y: position.y - 6, width: NODE_WIDTH + 12, height: NODE_HEIGHT + 12};
  });
  obstacles.push(...moduleBounds.map(group => ({x: group.x + 8, y: group.y + 4, width: group.width - 16, height: 24 / zoom})));
  const occupied = [];
  const captions = [];
  let markup = '<defs><marker id="arrow" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto"><path d="M0,0 L12,6 L0,12" fill="context-stroke"/></marker></defs>';
  for (const edge of liveEdges(w)) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    const a = nodePosition(edge.from), b = nodePosition(edge.to);
    const from = {x: a.x + NODE_WIDTH, y: a.y + NODE_HEIGHT / 2};
    const to = {x: b.x, y: b.y + NODE_HEIGHT / 2};
    const selected = selection?.kind === 'edge' && selection.id === edge.id;
    const related = selection?.kind === 'node' && [edge.from, edge.to].includes(selection.id);
    const muted = selection?.kind === 'node' && !related;
    const state = `${selected ? 'selected' : ''} ${related ? 'related' : ''} ${muted ? 'muted' : ''}`;
    const path = edgePath(from, to);
    const label = edge.relation.length > 14 ? edge.relation.slice(0, 14) + '…' : edge.relation;
    const width = (captionMeasure.measureText(label).width + 16) / zoom;
    const height = 24 / zoom;
    const caption = edgeLabelPosition(from, to, obstacles, occupied, width, height);
    occupied.push(caption.bounds);
    const description = `${nodes.get(edge.from).label} → ${nodes.get(edge.to).label}：${edge.relation}`;
    markup += `<g class="edge-group ${state}"><path class="edge-line ${selected ? 'selected' : ''} ${related ? 'related' : ''} ${edge.review_state === 'pending' ? 'pending' : ''}" d="${path}" marker-end="url(#arrow)"/><path class="edge-hit" data-edge="${html(edge.id)}" d="${path}" tabindex="0" role="button" aria-label="关系：${html(description)}"><title>${html(description)}</title></path></g>`;
    const leader = Math.hypot(caption.x - caption.anchor.x, caption.y - caption.anchor.y) * zoom > 14
      ? `<path class="caption-leader" d="M ${caption.anchor.x} ${caption.anchor.y} L ${caption.x} ${caption.y}"/>` : '';
    captions.push(`<g class="edge-group ${state}">${leader}<g class="edge-caption" data-edge="${html(edge.id)}" transform="translate(${caption.x} ${caption.y})"><title>${html(description)}</title><rect x="${-width / 2}" y="${-height / 2}" width="${width}" height="${height}" rx="${6 / zoom}"/><text class="edge-label" style="font-size:${14 / zoom}px" data-edge="${html(edge.id)}">${html(label)}</text></g></g>`);
  }
  if (wirePreview) {
    const position = nodePosition(wirePreview.from);
    markup += `<path class="edge-preview" d="${edgePath({x: position.x + NODE_WIDTH, y: position.y + NODE_HEIGHT / 2}, wirePreview.point)}"/>`;
  }
  $('edge-layer').innerHTML = markup + captions.join('');
  captionBounds = occupied;
  const worldWidth = Math.max(parseFloat($('world').style.width), ...occupied.map(rect => rect.x + rect.width + 50), ...moduleBounds.map(rect => rect.x + rect.width + 30));
  const worldHeight = Math.max(parseFloat($('world').style.height), ...occupied.map(rect => rect.y + rect.height + 50), ...moduleBounds.map(rect => rect.y + rect.height + 30));
  $('world').style.width = worldWidth + 'px';
  $('world').style.height = worldHeight + 'px';
  $('world-frame').style.width = worldWidth * zoom + 'px';
  $('world-frame').style.height = worldHeight * zoom + 'px';
  $('edge-layer').setAttribute('width', worldWidth);
  $('edge-layer').setAttribute('height', worldHeight);
}

function renderCanvas(){
  const nodes=liveNodes(w);
  const width=Math.max(1500,...nodes.map(n=>nodePosition(n.id).x+420));
  const height=Math.max(1050,...nodes.map(n=>nodePosition(n.id).y+300));
  $('world').style.setProperty('--graph-scale', zoom);
  $('world').style.setProperty('--text-scale', Math.min(1, zoom));
  $('world').classList.toggle('overview', zoom < .9);
  $('world').style.width=width+'px';$('world').style.height=height+'px';$('world').style.transform=`scale(${zoom})`;
  $('world-frame').style.width=width*zoom+'px';$('world-frame').style.height=height*zoom+'px';
  $('edge-layer').setAttribute('width',width);$('edge-layer').setAttribute('height',height);
  $('node-layer').innerHTML=nodes.map(n=>{
    const p=nodePosition(n.id),color=nodeColor(n);
    const pending=n.review_state==='pending';
    return `<article class="graph-node ${n.needs_details?'draft':''} ${w.graph.groups?.length && n.id === nodes[0].id ? 'root-node' : ''}" data-node="${html(n.id)}" data-kind="${html(n.kind)}" title="${html(n.label)}" style="left:${p.x}px;top:${p.y}px;--node-color:${color}" tabindex="0" role="button" aria-label="节点：${html(n.label)}"><button class="node-port input" data-input="${html(n.id)}" aria-label="连接到${html(n.label)}的输入端"></button><div class="node-title">${icon(Object.hasOwn(colors,n.kind)&&n.kind!=='other'?n.kind:'plus')}<strong>${html(n.label)}</strong></div><div class="node-meta"><span class="node-kind"><i aria-hidden="true"></i>${html(names[n.kind]||'其他')}</span><span class="${pending?'unverified':''}">${n.needs_details?'点击填写内容':pending?(n.enrichment_mode==='model'?'AI 待核验':'原文待核验'):n.source_refs.length?`${n.source_refs.length} 处原文`:'待关联原文'}</span></div><button class="node-port output" data-output="${html(n.id)}" aria-label="从${html(n.label)}的输出端连线"></button></article>`;
  }).join('');
  $('canvas-empty').hidden=nodes.length>0;$('graph-count').textContent=`${nodes.length} 个节点 · ${liveEdges(w).length} 条关系`;
  $('zoom-label').textContent=Math.round(zoom*100)+'%';renderEdges();updateSelection();
}
function renderOutline(){
  $('show-components').classList.toggle('active',outlineMode==='components');
  $('component-library').hidden=outlineMode!=='components';$('outline').hidden=outlineMode==='components';
  $('show-outline').classList.toggle('active',outlineMode==='outline');$('show-chains').classList.toggle('active',outlineMode==='chains');
  syncSegmented();
  const libraryOpen = !document.querySelector('.workspace').classList.contains('library-collapsed');
  for (const [id, mode] of [['show-components', 'components'], ['show-outline', 'outline'], ['show-chains', 'chains']]) {
    $(id).classList.toggle('active', libraryOpen && outlineMode === mode);
    $(id).setAttribute('aria-pressed', String(libraryOpen && outlineMode === mode));
  }
  document.querySelectorAll('[data-library-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.libraryMode === outlineMode);
    button.setAttribute('aria-pressed', String(button.dataset.libraryMode === outlineMode));
  });
  $('library-title').textContent = {components: '节点组件', outline: '层级大纲', chains: '证据链路'}[outlineMode];
  if(outlineMode==='components')return;
  if(outlineMode==='chains'){
    const by=new Map(w.graph.nodes.map(n=>[n.id,n]));
    $('outline').innerHTML=w.evidence_chains.map(c=>`<div class="chain-item"><button data-chain="${html(c.id)}">${c.node_ids.map(id=>html(by.get(id)?.label||'已删除节点')).join(' → ')}</button><small>${c.status==='broken'?'断链 · 历史依据仍保留':c.status==='complete'?`${c.source_refs.length} 个原文依据`:'待补充原文依据'}</small></div>`).join('')||'<p class="no-results">建立关系后，这里会显示对应证据链。</p>';
    return;
  }
  const by=new Map(liveNodes(w).map(n=>[n.id,n]));
  $('outline').innerHTML=w.outline.filter(item=>by.get(item.node_id)?.label.toLowerCase().includes(search)).map(item=>{
    const n=by.get(item.node_id);
    return `<button class="outline-item ${selection?.id===n.id?'active':''}" data-outline="${html(n.id)}" style="padding-left:${7+Math.min(item.depth,6)*12}px"><i class="tiny-dot" style="background:${colors[n.kind]||colors.other}"></i><span>${html(n.label)}</span></button>`;
  }).join('')||'<p class="no-results">没有匹配节点。可以添加一个新想法。</p>';
}
function fieldOrigin(item,field){return item.field_provenance?.[field]&&item.field_provenance[field]!=='user'?`<span class="field-origin">${item.field_provenance[field]==='model'?'AI 补充':'摘自原文'}</span>`:'';}
function renderInspector() {
  $('tab-details').classList.toggle('active', inspectorTab === 'details');
  $('tab-source').classList.toggle('active', inspectorTab === 'source');
  syncSegmented();
  if (inspectorTab === 'source') {
    $('inspector').innerHTML = `<p class="source-intro">点击段落，查看它在图谱中对应的节点与关系。</p>${activeSegment ? '<div class="active-segment-note">当前段落对应的节点已高亮</div>' : ''}<div id="source-segments">${w.source.segments.map(segment => `<button type="button" class="source-segment ${activeSegment === segment.id ? 'active' : ''} ${segment.tag?.startsWith('h') ? 'heading' : ''}" data-segment="${html(segment.id)}"><span class="segment-id">${html(segment.id)}</span>${html(segment.text)}</button>`).join('') || '<p class="muted">导入一份原文，便可把节点与段落连接起来。</p>'}</div>`;
    return;
  }
  const item = current();
  if (!item) {
    $('inspector').innerHTML = `<div class="empty-inspector">${icon('network')}<strong>选中一个节点</strong><p>在这里展开想法，查看来源，继续连接你的知识。</p></div>`;
    return;
  }
  const node = selection.kind === 'node';
  const key = draftKey(selection.kind, item.id);
  const draft = formDrafts.get(key);
  inspectorDirty = Boolean(draft);
  const values = {...item, ...draft?.fields};
  const label = draft?.fields.label ?? (item.needs_details ? '' : item.label);
  const kind = node ? values.kind : 'other';
  const color = node ? nodeColor({...item, kind}) : '#657dba';
  const kindIcon = node && Object.hasOwn(colors, kind) && kind !== 'other' ? kind : node ? 'plus' : 'connect';
  const references = item.source_refs.map(ref => `<button type="button" class="evidence-link" data-reference="${html(ref.locator)}">${html(ref.overview || ref.excerpt.slice(0, 140))}</button>`).join('');
  const selectedRefs = draft?.fields.source_refs ?? item.source_refs.map(ref => ref.locator);
  const picks = w.source.segments.map(segment => `<label><input type="checkbox" name="source_refs" value="${html(segment.id)}" ${selectedRefs.includes(segment.id) ? 'checked' : ''}>${html(segment.text.slice(0, 78))}${segment.text.length > 78 ? '…' : ''}</label>`).join('');
  const by = new Map(w.graph.nodes.map(n => [n.id, n]));
  $('inspector').innerHTML = `
    <div class="inspector-identity" style="--node-color:${color}">
      <div class="identity-icon">${icon(kindIcon)}</div>
      <div><h2 title="${html(node ? item.label : item.relation)}">${html(node ? item.label : item.relation)}</h2>
        <div class="detail-heading"><span class="type-badge">${node ? html(names[kind] || '节点') : '知识关系'}</span><span class="confidence">${typeof item.confidence === 'number' ? `置信度 ${Math.round(item.confidence * 100)}%` : '置信度待评估'}</span></div>
        ${item.review_state === 'pending' ? '<span class="review-badge">补充内容待核验</span>' : ''}
      </div>
    </div>
    <section class="detail-section evidence-section"><h3>${icon('source')}原文依据 <span>${item.source_refs.length}</span>${fieldOrigin(item, 'source_refs')}</h3><div class="evidence-list">${references || '<p class="muted">尚未关联原文，可在下方手动选择，或点击匹配原文。</p>'}</div></section>
    ${node && item.needs_details ? '<p class="draft-node-note">节点已建立。填写名称并保存，助手会继续补充空白。</p>' : ''}
    <form class="detail-form" id="detail-form" data-kind="${selection.kind}" data-id="${html(item.id)}" data-source="${html(draftSource())}">
      ${node ? `<div class="form-grid"><label>节点名称<input name="label" value="${html(label)}" placeholder="${html(item.draft_label || '节点名称')}" required maxlength="180" autocomplete="off"></label><label>类型<select name="kind">${Object.entries(names).map(([value, name]) => `<option value="${value}" ${kind === value ? 'selected' : ''}>${name}</option>`).join('')}</select></label></div><label>简述${fieldOrigin(item, 'summary')}<textarea name="summary" placeholder="用一句话说明这个节点…">${html(values.summary)}</textarea></label><label>补充内容${fieldOrigin(item, 'content')}<textarea class="long" name="content" placeholder="记录解释，或让助手填充空白…">${html(values.content)}</textarea></label>` : `<p class="muted">${html(by.get(item.from)?.label)} → ${html(by.get(item.to)?.label)}</p><label>关系名称<input name="relation" value="${html(values.relation)}" required maxlength="180" list="relation-names" autocomplete="off"></label><label>关系依据${fieldOrigin(item, 'relation_basis')}<textarea class="long" name="relation_basis" placeholder="它们为什么相连？…">${html(values.relation_basis)}</textarea></label>`}
      <details><summary>手动选择原文段落</summary><div class="source-picker">${picks || '<p class="muted">暂无原文段落</p>'}</div></details>
      <div class="form-actions"><button class="primary" type="submit">保存修改</button>${item.review_state === 'pending' ? '<button id="mark-reviewed" type="button">已核验</button>' : ''}<button class="danger quiet" type="button" id="delete-item">删除</button><p class="draft-status" id="draft-notice" ${draft ? '' : 'hidden'}>属性草稿已暂存，点击保存修改应用到图谱</p></div>
    </form>
    ${item.enrichment_note ? `<p class="details-note">${html(item.enrichment_note)}</p>` : ''}
    ${node ? `<section class="detail-section module-settings"><h3>所属模块</h3><p class="details-note">依据原文章节与已有连线分组，可调整归属，也可新建子模块。</p><select id="node-module" aria-label="所属模块"><option value="">暂不归入模块</option>${(w.graph.groups || []).map(group => `<option value="${html(group.id)}" ${nodeModule(w, item.id)?.id === group.id ? 'selected' : ''}>${group.parent_id ? '↳ ' : ''}${html(group.label)}</option>`).join('')}</select><details class="new-module"><summary>新建模块或子模块</summary><label>模块名称<input id="module-name" maxlength="180" placeholder="例如：核心原理…"></label><label>上一级模块<select id="module-parent" aria-label="上一级模块"><option value="">顶层模块</option>${(w.graph.groups || []).map(group => `<option value="${html(group.id)}" ${nodeModule(w, item.id)?.id === group.id ? 'selected' : ''}>${html(group.label)}</option>`).join('')}</select></label><button id="create-module" type="button">创建并移入</button></details></section><details class="detail-section merge-details"><summary>合并到另一个节点</summary><div class="merge-row"><select id="merge-target" aria-label="合并目标">${liveNodes(w).filter(n => n.id !== item.id).map(n => `<option value="${html(n.id)}">${html(n.label)}</option>`).join('')}</select><button type="button" id="merge-node">合并</button></div><p class="details-note">保留来源并转接关系，可撤销。</p></details>` : ''}`;
  $('detail-form').addEventListener('input', trackFormDraft);
  $('detail-form').addEventListener('change', trackFormDraft);
  $('detail-form').onsubmit = event => {
    event.preventDefault();
    const entry = formDrafts.get(key);
    if (entry) submitFormDrafts([[key, entry]]);
  };
  $('delete-item').onclick = () => {
    const old = {...selection};
    if (commit(() => deleteItem(w, old.kind, old.id), '已删除，可撤销')) {
      selection = null;
      render();
    }
  };
  if ($('mark-reviewed')) $('mark-reviewed').onclick = () => commit(() => {current().review_state = 'reviewed';}, '已标记为人工核验');
  if (node) {
    $('node-module').onchange = event => {
      const groupId = event.target.value;
      commit(() => assignNodeModule(item.id, groupId), '模块归属已更新');
    };
    $('create-module').onclick = () => {
      const label = $('module-name').value.trim();
      const parent = $('module-parent').value || null;
      if (!label) { $('module-name').focus(); return; }
      commit(() => {
        if (w.graph.groups.length >= 500) throw Error('当前图谱最多支持500个模块');
        let ancestor = parent, depth = 1;
        while (ancestor) {
          if (++depth > 32) throw Error('模块层级最多支持32级');
          ancestor = w.graph.groups.find(group => group.id === ancestor)?.parent_id;
        }
        const id = `g-${crypto.randomUUID()}`;
        w.graph.groups.push({id, label, parent_id: parent, node_ids: [], color: MODULE_COLORS[w.graph.groups.length % MODULE_COLORS.length], provenance: 'user_edited'});
        assignNodeModule(item.id, id);
      }, '模块已创建，可继续把其他节点移入');
    };
  }
  if (node) $('merge-node').onclick = () => {
    const target = $('merge-target').value;
    if (!target) return;
    const entry = formDrafts.get(key);
    if (entry && !submitFormDrafts([[key, entry]])) return;
    if (commit(() => mergeNodes(w, item.id, target), '节点已合并，可撤销')) {
      selection = {kind: 'node', id: target};
      render();
    }
  };
}

function renderSuggestions(){
  const by=new Map(liveNodes(w).map(n=>[n.id,n]));
  $('suggestions').innerHTML=w.pending_suggestions.filter(s=>s.status==='pending').map(s=>`<div class="suggestion"><strong>建议关系</strong><p>${html(by.get(s.from)?.label||'已删除节点')} → ${html(by.get(s.to)?.label||'已删除节点')} · ${html(s.relation)}</p><p>${html(s.relation_basis)}</p><button data-accept="${html(s.id)}">加入图谱</button><button data-reject="${html(s.id)}">忽略</button></div>`).join('');
}
function updateAssist(){
  $('model-status').textContent=settings.configured?settings.model:'模型未配置';
  $('model-status').title=settings.configured?settings.model:'模型未配置，可在右上角设置';
  const busy=selection&&tasks.has(`${selection.kind}:${selection.id}`);
  $('ai-fill').disabled=!current()||!settings.configured||Boolean(busy);
  $('ai-fill').innerHTML=`${icon('spark')}${busy?'补充中…':'AI 补充'}`;
  $('ai-fill').setAttribute('aria-busy',String(Boolean(busy)));
  $('ai-fill').title=settings.configured?'补充当前对象的空白字段':'请先打开模型设置';
  $('configure-model').hidden = settings.configured;
  $('source-match').disabled=!current()||Boolean(busy);$('cancel-ai').hidden=!tasks.size;
}
function render({preserveInspector=false}={}){
  $('document-title').textContent=w.source.title;$('source-title').textContent=w.source.title;
  $('source-url').hidden=!/^https?:\/\//i.test(w.source.locator||'');if(!$('source-url').hidden)$('source-url').href=w.source.locator;
  $('source-count').textContent=`${w.source.segments.length} 个原文段落 · ${w.evidence_chains.filter(c=>c.status==='broken').length} 条历史断链`;
  $('undo').disabled=!history.past.length;$('redo').disabled=!history.future.length;
  renderCanvas();renderOutline();if(!preserveInspector||!inspectorDirty)renderInspector();renderSuggestions();updateAssist();
}
function focusNode(id){
  const p=nodePosition(id),viewport=$('viewport');
  viewport.scrollTo({left:Math.max(0,(p.x+NODE_WIDTH/2)*zoom-viewport.clientWidth/2),top:Math.max(0,(p.y+NODE_HEIGHT/2)*zoom-viewport.clientHeight/2),behavior:'smooth'});
}
function setTab(tab) { inspectorTab = tab; renderInspector(); }
function focusInspector(field){
  $('inspector').scrollTop=0;
  const input=$('detail-form')?.elements[field];input?.focus({preventScroll:true});input?.select();
}
function createDraft(kind='concept',position=null){
  canvasController?.cancelConnection();
  const viewport=$('viewport');
  let at=position;
  if(!at){
    const columns=Math.max(1,Math.floor(((viewport.clientWidth||600)/zoom-60)/(NODE_WIDTH+40)));
    for(let i=0;i<600;i++){
      const candidate={x:viewport.scrollLeft/zoom+40+(i%columns)*(NODE_WIDTH+40),y:viewport.scrollTop/zoom+40+Math.floor(i/columns)*(NODE_HEIGHT+40)};
      const occupied=liveNodes(w).some(n=>{const p=nodePosition(n.id);return Math.abs(p.x-candidate.x)<NODE_WIDTH+20&&Math.abs(p.y-candidate.y)<NODE_HEIGHT+20;});
      if(!occupied){at=candidate;break;}
    }
  }
  let node;
  if(commit(()=>{node=addDraftNode(w,kind,at);node.auto_fill_pending=$('auto-fill').checked;},'节点已建立，在右侧填写内容')){select('node',node.id);if(!position)focusNode(node.id);focusInspector('label');}
}
function connectDirect(from,to){
  let edge;
  if(commit(()=>{edge=addEdge(w,from,to,'关联');edge.auto_fill_pending=$('auto-fill').checked;},'关系已建立，可在右侧修改名称和依据')){select('edge',edge.id);focusInspector('relation');}
}
function showComponents(){
  outlineMode='components';renderOutline();setPanel('left');
}
async function enrich(kind,id,mode){
  if(!canEnrich(w,kind,id)){toast(kind==='node'?'先在侧栏填写节点名称并保存，再补充内容':'请先给关系两端的节点填写名称');return;}
  const key=`${kind}:${id}`;if(tasks.has(key)){toast('这个对象正在补充中');return;}
  if(mode==='model'&&!settings.configured){$('open-settings').click();return;}
  const controller=new AbortController(),signature=targetSignature(w,kind,id);tasks.set(key,controller);updateAssist();
  $('assist-status').textContent=mode==='model'?'AI 正在补充解释和原文依据…':'正在查找原文中的相关段落…';
  try{
    const result=await api('/api/assist',{method:'POST',signal:controller.signal,body:JSON.stringify({workspace:clone(w),target:{kind,id},mode})});
    if(controller.signal.aborted)return;
    if(inspectorDirty&&selection?.id===id)throw Error('你正在编辑内容，请先保存修改，再重新补充。');
    let changed=0;
    const ok=commit(()=>{changed=applyEnrichment(w,kind,id,result,signature);},null,{preserveInspector:selection?.id!==id});
    if(ok){$('assist-status').textContent=changed?`${mode==='model'?'AI':'原文匹配'}已补充 ${changed} 个空白字段。人工内容保持不变，请核验依据。`:result.note||'没有可补充的空白字段。';toast(changed?'补充完成，已标明来源':result.note||'没有需要补充的空白');}
    else $('assist-status').textContent='目标已变化，已保留手动内容。请重新补充。';
  }catch(e){$('assist-status').textContent=e.name==='AbortError'?'已取消补充，手动内容已保留。':e.message;}
  finally{tasks.delete(key);updateAssist();}
}
function restoreHistory(direction){
  const next=history[direction](w);if(!next)return;w=normalize(next);generation++;inspectorDirty=false;
  if (w.graph.groups?.length) w.layout.module_layout_version = 1;
  if(!current())selection=null;zoom=w.layout.zoom||1;scheduleSave();render();toast(direction==='undo'?'已撤销':'已重做');
}
function setZoom(value){zoom=Math.max(.4,Math.min(1.6,value));w.layout.zoom=zoom;generation++;scheduleSave();renderCanvas();}
function fit() {
  const nodes = liveNodes(w);
  if (!nodes.length) return;
  w.layout.view_mode = 'overview';
  const rectangles = nodes.map(node => ({...nodePosition(node.id), width: NODE_WIDTH, height: NODE_HEIGHT}));
  const bounds = [...rectangles, ...captionBounds, ...moduleBounds];
  const left = Math.min(...bounds.map(rect => rect.x));
  const top = Math.min(...bounds.map(rect => rect.y));
  const width = Math.max(...bounds.map(rect => rect.x + rect.width)) - left;
  const height = Math.max(...bounds.map(rect => rect.y + rect.height)) - top;
  setZoom(Math.min(($('viewport').clientWidth - 70) / width, ($('viewport').clientHeight - 70) / height, 1.2));
  const updated = [...rectangles, ...captionBounds, ...moduleBounds];
  const visibleLeft = Math.min(...updated.map(rect => rect.x));
  const visibleTop = Math.min(...updated.map(rect => rect.y));
  $('viewport').scrollTo({left: Math.max(0, visibleLeft * zoom - 30), top: Math.max(0, visibleTop * zoom - 30)});
}

document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>button.closest('dialog').close());
$('add-node').onclick = () => createDraft('concept');
$('empty-add').onclick = () => createDraft('concept');
$('add-edge').onclick=()=>{if(selection?.kind==='node'){canvasController?.startConnection(selection.id);setPanel('canvas');}toast('从节点右侧圆点拖到另一个节点，松开即建立关系。');};
$('auto-fill').onchange=()=>{if($('auto-fill').checked)commit(()=>{},'已开启：填写名称后自动补充空白');};
$('undo').onclick=()=>restoreHistory('undo');$('redo').onclick=()=>restoreHistory('redo');
$('save-now').onclick = () => {
  if (!submitFormDrafts()) return;
  retryCount = 0; error(''); void save();
};
$('arrange-modules').onclick = () => {
  if (commit(() => {
    if (w.layout.grouping_mode === 'auto' || !w.graph.groups.length) w.graph.groups = inferModules(w);
    arrangeModules(w);
  }, '已按模块整理，多级框会随节点移动。可撤销布局')) fit();
};
$('mobile-arrange').onclick = () => { $('arrange-modules').click(); setPanel('canvas'); };
$('readable-view').onclick = () => { w.layout.view_mode = 'reading'; setZoom(1); if (selection?.kind === 'node') focusNode(selection.id); };
$('zoom-in').onclick=()=>setZoom(zoom+.1);$('zoom-out').onclick=()=>setZoom(zoom-.1);$('fit-view').onclick=fit;
function syncSegmented(){document.querySelectorAll('.segmented button').forEach(button=>button.setAttribute('aria-pressed',String(button.classList.contains('active'))));}
$('toggle-library').onclick=()=>setPaneVisibility('left',!document.querySelector('.workspace').classList.contains('library-collapsed'));
$('toggle-inspector').onclick=()=>setPaneVisibility('right',!document.querySelector('.workspace').classList.contains('inspector-collapsed'));
$('search').oninput=event=>{search=event.target.value.trim().toLowerCase();if(search)outlineMode='outline';renderOutline();updateSelection();};
$('show-components').onclick=showComponents;
$('show-outline').onclick = () => { outlineMode = 'outline'; setPanel('left'); renderOutline(); };
$('show-chains').onclick = () => { outlineMode = 'chains'; setPanel('left'); renderOutline(); };
document.querySelectorAll('[data-library-mode]').forEach(button => {
  button.onclick = () => { outlineMode = button.dataset.libraryMode; renderOutline(); };
});
$('close-library').onclick = () => setPaneVisibility('left', true);
$('close-inspector').onclick = () => setPaneVisibility('right', true);
$('rail-settings').onclick = () => $('open-settings').click();
$('configure-model').onclick = () => $('open-settings').click();
$('mobile-import').onclick = () => $('open-source').click();
$('mobile-search').oninput = event => {
  $('search').value = event.target.value;
  $('search').dispatchEvent(new Event('input'));
};
$('tab-details').onclick=()=>setTab('details');$('tab-source').onclick=()=>setTab('source');$('view-source').onclick=()=>{setTab('source');setPanel('right');};
$('ai-fill').onclick=()=>{if(selection)void enrich(selection.kind,selection.id,'model');};
$('source-match').onclick=()=>{if(selection)void enrich(selection.kind,selection.id,'source');};
$('cancel-ai').onclick=()=>tasks.forEach(controller=>controller.abort());
$('outline').onclick=event=>{
  const node=event.target.closest('[data-outline]');if(node){select('node',node.dataset.outline);focusNode(node.dataset.outline);setPanel('canvas');}
  const chain=event.target.closest('[data-chain]');if(chain){const c=w.evidence_chains.find(c=>c.id===chain.dataset.chain);if(c.status==='broken'){toast('这条链路已断开，原文依据仍保留。可撤销删除或重新连接节点。');return;}select('edge',c.edge_ids[0]);focusNode(c.node_ids[0]);setPanel('right');}
};
$('inspector').addEventListener('click',event=>{
  const ref=event.target.closest('[data-reference]');if(ref){activeSegment=ref.dataset.reference;setTab('source');document.querySelector(`[data-segment="${activeSegment}"]`)?.scrollIntoView({block:'center',behavior:'smooth'});}
  const segment=event.target.closest('[data-segment]');if(segment){
    activeSegment=segment.dataset.segment;const mapping=w.mappings.find(m=>m.source_ref.locator===activeSegment);
    if(mapping?.node_ids.length){selection={kind:'node',id:mapping.node_ids[0]};focusNode(selection.id);}
    else if(mapping?.edge_ids.length)selection={kind:'edge',id:mapping.edge_ids[0]};
    updateSelection();renderEdges();renderOutline();updateAssist();
    document.querySelectorAll('[data-segment]').forEach(el=>el.classList.toggle('active',el.dataset.segment===activeSegment));
    toast(mapping?`已定位 ${mapping.node_ids.length} 个节点、${mapping.edge_ids.length} 条关系`:'这个段落尚未关联节点，可在节点详情中手动关联');
  }
});
$('suggestions').onclick=event=>{
  const accept=event.target.closest('[data-accept]'),reject=event.target.closest('[data-reject]');
  if(accept)commit(()=>{const s=w.pending_suggestions.find(s=>s.id===accept.dataset.accept);const e=addEdge(w,s.from,s.to,s.relation);e.relation_basis=s.relation_basis;e.source_refs=clone(s.source_refs);e.provenance='ai_suggestion';e.review_state='pending';e.enrichment_mode='model';s.status='accepted';},'已加入建议关系，请核验原文依据');
  if(reject)commit(()=>{w.pending_suggestions.find(s=>s.id===reject.dataset.reject).status='rejected';},'已忽略建议');
};
function setPaneVisibility(panel,collapsed){
  const library=panel==='left',workspace=document.querySelector('.workspace');
  workspace.classList.toggle(library?'library-collapsed':'inspector-collapsed',collapsed);
  const button=$(library?'toggle-library':'toggle-inspector'),label=`${collapsed?'展开':'收起'}${library?'组件':'详情'}面板`;
  button.setAttribute('aria-expanded',String(!collapsed));button.setAttribute('aria-label',label);button.title=label;
  const pane=$(library?'library-pane':'details-pane');
  // Narrow screens use panel tabs. Hidden desktop panels leave the tab order.
  pane.inert=collapsed&&window.matchMedia('(min-width:761px)').matches;
  if (w) renderOutline();
}
function setPanel(panel){
  const workspace=document.querySelector('.workspace');workspace.dataset.panel=panel;
  if(panel==='left'||panel==='right')setPaneVisibility(panel,false);
  document.querySelectorAll('button[data-panel]').forEach(el=>{const active=el.dataset.panel===panel;el.classList.toggle('active',active);el.setAttribute('aria-pressed',String(active));});
}
window.matchMedia('(min-width:761px)').addEventListener('change',()=>{
  const workspace=document.querySelector('.workspace');
  setPaneVisibility('left',workspace.classList.contains('library-collapsed'));
  setPaneVisibility('right',workspace.classList.contains('inspector-collapsed'));
});
document.querySelectorAll('.mobile-tabs button').forEach(button=>button.onclick=()=>setPanel(button.dataset.panel));
$('open-source').onclick=()=>{$('source-form').reset();$('source-dialog').showModal();};
$('source-file').onchange=async event=>{const file=event.target.files[0];if(!file)return;if(file.size>1_500_000){toast('请使用小于 1.5MB 的文本文件');return;}$('source-form').elements.content.value=await file.text();$('source-form').elements.title.value=file.name;};
$('source-form').onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget,text=form.elements.content.value.trim();
  if(text.length>1_000_000){toast('原文最多支持一百万字，请拆分后导入');return;}
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  const next=emptyWorkspace();next.source.title=form.elements.title.value.trim();next.source.content_hash=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
  next.source.segments=text.split(/\n\s*\n/).filter(s=>s.trim()).map((s,i)=>({id:`s-${i+1}`,tag:/^#{1,6}\s/.test(s)?'h2':'p',text:s.trim()}));
  if(next.source.segments.length>5000||next.source.segments.some(s=>s.text.length>50000)){toast('段落过多或单段过长，请增加空行并拆分原文');return;}
  if(commit(()=>{w=next;selection=null;activeSegment=null;zoom=1;},'原文已载入，可以开始建立节点'))$('source-dialog').close();
};
$('load-demo').onclick=async()=>{try{const next=await(await fetch('/demo.json')).json();if(commit(()=>{w=normalize(next);selection=null;activeSegment=null;zoom=.8;w.layout.zoom=zoom;},'已载入示例，操作可撤销')){$('source-dialog').close();fit();}}catch{toast('示例无法读取，请检查本机服务');}};
$('open-settings').onclick=async()=>{
  try{settings=await api('/api/settings');}catch(e){toast(e.message);return;}
  const f=$('settings-form');f.reset();f.elements.base_url.value=settings.base_url;f.elements.model.value=settings.model;
  $('settings-message').textContent=settings.has_key?'已有进程内密钥，留空沿用。':'可以填写密钥；本地模型可留空。';$('settings-dialog').showModal();
};
$('settings-form').onsubmit=async event=>{
  event.preventDefault();const f=event.currentTarget;
  try{settings=await api('/api/settings',{method:'POST',body:JSON.stringify({base_url:f.elements.base_url.value,model:f.elements.model.value,api_key:f.elements.api_key.value,clear_key:f.elements.clear_key.checked})});f.elements.api_key.value='';$('settings-dialog').close();updateAssist();toast('模型设置已保存到服务进程内存');}
  catch(e){$('settings-message').textContent=e.message;f.elements.api_key.value='';}
};
$('settings-dialog').addEventListener('close',()=>{$('settings-form').elements.api_key.value='';});
$('keep-local').onclick=async()=>{try{const latest=await api('/api/workspace');version=latest.version;conflict=false;$('conflict-banner').hidden=true;dirty=true;cache();await save();}catch(e){error(e.message);}};
$('load-remote').onclick=async()=>{
  try{localStorage.setItem(CACHE+'-before-conflict',JSON.stringify({workspace:w,base_version:version}));const remote=await api('/api/workspace');w=normalize(remote.workspace);version=remote.version;dirty=false;conflict=false;history=new History();selection=null;zoom=w.layout.zoom;$('conflict-banner').hidden=true;cache();render();saveStatus(`已保存 · v${version}`);toast('已载入服务端版本。原本地内容保留在浏览器冲突恢复副本。');}
  catch(e){error(e.message);}
};
window.addEventListener('keydown',event=>{
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !document.querySelector('dialog[open]')) {
    event.preventDefault(); $('save-now').click(); return;
  }
  const typing=event.target.closest('input,textarea,select,[contenteditable=true]');if(typing||document.querySelector('dialog[open]'))return;
  if (event.key === '/' && window.matchMedia('(min-width:761px)').matches) {
    event.preventDefault(); $('search').focus(); return;
  }
  if (event.key === ' ' && event.target.matches('[data-node], [data-edge]')) {
    event.preventDefault();
    const target = event.target;
    select(target.hasAttribute('data-node') ? 'node' : 'edge', target.dataset.node || target.dataset.edge);
    return;
  }
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();restoreHistory(event.shiftKey?'redo':'undo');}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();$('save-now').click();}
  if(event.key==='Delete'&&selection){event.preventDefault();const selected={...selection};commit(()=>deleteItem(w,selected.kind,selected.id),'已删除，可撤销');selection=null;render();}
  if(event.key==='Enter'&&event.target.closest('[data-node]')&&!event.target.closest('.node-port')){select('node',event.target.closest('[data-node]').dataset.node);setPanel('right');}
  if(event.key==='Enter'&&event.target.closest('[data-edge]')){select('edge',event.target.closest('[data-edge]').dataset.edge);setPanel('right');}
  const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
  if(delta&&event.target.closest('[data-node]')){event.preventDefault();const id=event.target.closest('[data-node]').dataset.node;commit(()=>{const p=nodePosition(id),step=event.shiftKey?10:1;w.layout.positions[id]=clampPosition({x:p.x+delta[0]*step,y:p.y+delta[1]*step});});document.querySelector(`[data-node="${id}"]`)?.focus();}
});
window.addEventListener('beforeunload',event=>{if(dirty || (w && activeFormDrafts().length)){cache();persistFormDrafts();event.preventDefault();event.returnValue='';}});

async function boot(){
  try{
    const [remote,config]=await Promise.all([api('/api/workspace'),api('/api/settings')]);
    w=normalize(remote.workspace);version=remote.version;settings=config;
    try{const local=JSON.parse(localStorage.getItem(CACHE)||'null');if(local?.dirty&&local.workspace){w=normalize(local.workspace);dirty=true;generation=local.generation||1;selection=local.selection;conflict=local.base_version!==version;if(conflict){$('conflict-banner').hidden=false;saveStatus('已恢复本地修改 · 版本冲突');}else{saveStatus('已恢复本地未保存修改');scheduleSave();}toast('已恢复上次未保存的手动修改');}else saveStatus(`已保存 · v${version}`);}catch{error('浏览器恢复副本无法读取，已载入服务端工作区。');}
  }catch(e){
    try{const local=JSON.parse(localStorage.getItem(CACHE)||'null');w=normalize(local?.workspace||await(await fetch('/demo.json')).json());version=local?.base_version||0;dirty=Boolean(local?.dirty);}catch{w=emptyWorkspace();}
    error(e.message+'。如直接打开了文件，请运行 python traceify/server.py 后访问本机地址。');saveStatus('离线 · 本地保留');
  }
  try {
    const storedDrafts = JSON.parse(localStorage.getItem(DRAFT_CACHE) || '[]');
    for (const [key, draft] of storedDrafts) {
      if (draft && ['node', 'edge'].includes(draft.kind) && draft.fields && typeof draft.fields === 'object') {
        formDrafts.set(key, draft);
      }
    }
    const local = JSON.parse(localStorage.getItem(CACHE) || 'null');
    if (!selection && local?.selection) selection = local.selection;
  } catch { error('部分属性草稿无法恢复，请检查本地恢复副本。'); }
  if (!current()) selection = liveNodes(w).length ? {kind: 'node', id: liveNodes(w)[0].id} : null;
  const firstModuleLayout = w.graph.groups.length > 0 && !w.layout.module_layout_version;
  if (firstModuleLayout) {
    history.push(clone(w));
    arrangeModules(w);
    generation++;
    scheduleSave();
  }
  w.layout.module_layout_version ??= 1;
  zoom = w.layout.view_mode === 'overview' ? w.layout.zoom || 1 : Math.max(.95, w.layout.zoom || 1);
  w.layout.zoom = zoom;
  const workspace = document.querySelector('.workspace');
  workspace.classList.toggle('library-collapsed', liveNodes(w).length > 0);
  workspace.classList.toggle('inspector-collapsed', window.matchMedia('(max-width:1250px)').matches || !selection);
  setPaneVisibility('left', workspace.classList.contains('library-collapsed'));
  setPaneVisibility('right', workspace.classList.contains('inspector-collapsed'));
  render();
  saveStatus(dirty ? '图谱修改待保存' : `已保存 · v${version}`);
  canvasController=bindCanvas({viewport:$('viewport'),world:$('world'),scale:()=>zoom,select,
    move(id,position,finished,cancelled){
      if(position){if(!dragBefore)dragBefore=clone(w);w.layout.positions[id]=position;const node=document.querySelector(`[data-node="${id}"]`);if(node){node.style.left=position.x+'px';node.style.top=position.y+'px';}renderEdges();return;}
      if(cancelled&&dragBefore){w=dragBefore;renderCanvas();}
      else if(finished&&dragBefore){history.push(dragBefore);generation++;scheduleSave();render();}
      else if(dragBefore){w=dragBefore;renderCanvas();}
      dragBefore=null;
    },connect:connectDirect,preview:(from,point)=>{wirePreview=from?{from,point}:null;renderEdges();},
    connectionState(from,target){
      $('world').classList.toggle('connecting',Boolean(from));
      document.querySelectorAll('[data-node]').forEach(el=>{el.classList.toggle('connection-source',el.dataset.node===from);el.classList.toggle('connection-target',el.dataset.node===target&&target!==from);});
      $('canvas-hint').textContent=from?'拖到另一个节点松开即可连接 · Esc 取消':'拖入组件新建 · 从圆点拖出关系 · 点击节点或连线编辑';
    },
    panEnd(){if(!w)return;w.layout.viewport={left:$('viewport').scrollLeft,top:$('viewport').scrollTop};cache();},
  });
  $('viewport').addEventListener('dragover',event=>{if(![...event.dataTransfer.types].includes('application/x-agentloop-node-kind'))return;event.preventDefault();event.dataTransfer.dropEffect='copy';$('viewport').classList.add('drop-ready');});
  $('viewport').addEventListener('dragleave',event=>{if(!$('viewport').contains(event.relatedTarget))$('viewport').classList.remove('drop-ready');});
  $('viewport').addEventListener('drop',event=>{event.preventDefault();$('viewport').classList.remove('drop-ready');const kind=event.dataTransfer.getData('application/x-agentloop-node-kind');if(!Object.hasOwn(names,kind))return;const rect=$('world').getBoundingClientRect();createDraft(kind,{x:(event.clientX-rect.left)/zoom-NODE_WIDTH/2,y:(event.clientY-rect.top)/zoom-NODE_HEIGHT/2});});
  $('viewport').addEventListener('dblclick',event=>{if(event.target.closest('[data-node],[data-edge],button'))return;const rect=$('world').getBoundingClientRect();createDraft('concept',{x:(event.clientX-rect.left)/zoom-NODE_WIDTH/2,y:(event.clientY-rect.top)/zoom-NODE_HEIGHT/2});});
  document.querySelectorAll('[data-node-kind]').forEach(button=>{button.onclick=()=>createDraft(button.dataset.nodeKind);button.ondragstart=event=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('application/x-agentloop-node-kind',button.dataset.nodeKind);button.classList.add('dragging');};button.ondragend=()=>{button.classList.remove('dragging');$('viewport').classList.remove('drop-ready');};});
  // Keep saved/readable zoom on entry; fitting every node is an explicit action.
  requestAnimationFrame(()=>{
    if (firstModuleLayout) {
      fit();
      toast('已补充多级模块并整理布局，撤销可恢复原位置');
    } else if(w.layout.viewport) $('viewport').scrollTo(w.layout.viewport.left,w.layout.viewport.top);
    else $('viewport').scrollTo(0,0);
  });
}
void boot();
