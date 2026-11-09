import {checkConnection, clampPosition} from './agentloop-canvas.js';
import {inferModules} from './modules.js';

export const clone = value => structuredClone(value);
export const liveNodes = w => w.graph.nodes.filter(n=>n.status!=='deleted');
export const liveEdges = w => w.graph.edges.filter(e=>e.status!=='deleted' && e.status!=='broken');
export const newId = prefix => `${prefix}-${crypto.randomUUID()}`;
export const emptyWorkspace = () => ({schema_version:2,id:'default',source:{id:'s-source',kind:'text',title:'我的知识图谱',locator:'手动输入',content_hash:'',status:'complete',segments:[]},graph:{nodes:[],edges:[]},layout:{positions:{},zoom:1,grouping_mode:'auto',module_layout_version:1},mappings:[],outline:[],evidence_chains:[],pending_suggestions:[],sync:{state:'local_pending'}});

export function normalize(input) {
  const w=clone(input);
  w.schema_version=2; w.source.segments??=[];
  w.layout??={positions:{},zoom:1}; w.layout.positions??={}; w.layout.zoom??=1;
  w.layout.grouping_mode ??= Array.isArray(w.graph.groups) ? 'manual' : 'auto';
  w.graph.groups ??= [];
  w.pending_suggestions??=[]; w.evidence_chains??=[];
  w.graph.nodes.forEach((n,i)=>{
    n.locked_fields??=[]; n.source_refs??=[]; n.versions??={ai:null,user:null};
    n.summary??=''; n.content??=''; n.status??='confirmed';
    w.layout.positions[n.id]??=clampPosition({x:70+(i%4)*285,y:70+Math.floor(i/4)*160});
  });
  w.graph.edges.forEach(e=>{e.source_refs??=[];e.locked_fields??=[];e.relation_basis??='';e.status??='confirmed';});
  return derive(w);
}

export function sourceRef(w, segment) {
  return {source_id:w.source.id,granularity:'paragraph',locator:segment.id,excerpt:segment.text,overview:segment.text.slice(0,120)};
}

/** Rebuild all linked views from the same stable IDs. DFS visits each node once. */
export function derive(w) {
  const nodes=liveNodes(w), ids=new Set(nodes.map(n=>n.id));
  w.graph.edges.forEach(e=>{if(e.status!=='deleted' && (!ids.has(e.from)||!ids.has(e.to)))e.status='broken';});
  const edges=liveEdges(w), incoming=new Set(edges.map(e=>e.to)), visited=new Set();
  const children=new Map(nodes.map(n=>[n.id,[]]));
  edges.forEach(e=>children.get(e.from)?.push(e.to));
  const outline=[];
  function visit(id,depth) {
    if(visited.has(id))return;
    visited.add(id);outline.push({node_id:id,depth});
    (children.get(id)||[]).forEach(next=>visit(next,depth+1));
  }
  nodes.filter(n=>!incoming.has(n.id)).forEach(n=>visit(n.id,0));
  nodes.forEach(n=>visit(n.id,0));w.outline=outline;
  const mappings=new Map();
  for(const [items,key] of [[nodes,'node_ids'],[edges,'edge_ids']]) for(const item of items) for(const ref of item.source_refs||[]) {
    const k=`${ref.source_id}:${ref.locator}`;
    if(!mappings.has(k))mappings.set(k,{source_ref:ref,node_ids:[],edge_ids:[]});
    if(!mappings.get(k)[key].includes(item.id))mappings.get(k)[key].push(item.id);
  }
  w.mappings=[...mappings.values()];
  const previous=new Map(w.evidence_chains.map(c=>[c.id,c]));
  for(const e of edges) {
    const refs=uniqueRefs([...(e.source_refs||[]),...nodes.find(n=>n.id===e.to).source_refs]);
    previous.set(`chain-${e.id}`,{id:`chain-${e.id}`,node_ids:[e.from,e.to],edge_ids:[e.id],source_refs:refs,status:refs.length?'complete':'unsubstantiated'});
  }
  const edgeIds=new Set(edges.map(e=>e.id));
  for(const c of previous.values()) if(c.edge_ids.some(id=>!edgeIds.has(id))||c.node_ids.some(id=>!ids.has(id)))c.status='broken';
  w.evidence_chains=[...previous.values()];
  if (w.layout.grouping_mode === 'auto') w.graph.groups = inferModules(w);
  return w;
}
export function uniqueRefs(refs) {return [...new Map(refs.map(r=>[`${r.source_id}:${r.locator}`,r])).values()];}
export function addNode(w,label,kind='concept',position) {
  if(w.graph.nodes.length>=500)throw Error('工作区已达到 500 个节点（含历史节点），请新建一份图谱');
  if(!label.trim())throw Error('请填写节点名称');
  const n={id:newId('n'),label:label.trim().slice(0,180),kind,summary:'',content:'',confidence:null,provenance:'user_edited',source_refs:[],versions:{ai:null,user:label.trim()},status:'confirmed',locked_fields:['label','kind'],field_provenance:{label:'user'}};
  w.graph.nodes.push(n);w.layout.positions[n.id]=clampPosition(position||{x:80+(liveNodes(w).length%4)*270,y:90+Math.floor(liveNodes(w).length/4)*150});
  derive(w);return n;
}
export function addDraftNode(w,kind,position) {
  const names={concept:'概念',claim:'观点',evidence:'证据',section:'章节',entity:'实体',other:'节点'};
  const base=`新${names[kind]||'节点'}`;
  let label=base,index=2;
  while(w.graph.nodes.some(n=>n.status!=='deleted'&&n.label===label))label=`${base} ${index++}`;
  const node=addNode(w,label,kind,position);
  node.draft_label=label;node.needs_details=true;node.auto_fill_pending=true;
  node.field_provenance.label='placeholder';
  return node;
}
export function canEnrich(w,kind,id) {
  if(kind==='node')return liveNodes(w).some(n=>n.id===id&&!n.needs_details);
  const edge=liveEdges(w).find(e=>e.id===id);
  return Boolean(edge&&[edge.from,edge.to].every(nodeId=>canEnrich(w,'node',nodeId)));
}
/** Drafts are saved immediately; only named objects enter the automatic queue. */
export function takeAutoEnrichments(w) {
  const targets=[];
  for(const [kind,items]of [['node',liveNodes(w)],['edge',liveEdges(w)]])for(const item of items){
    if(item.auto_fill_pending&&canEnrich(w,kind,item.id)){
      item.auto_fill_pending=false;targets.push({kind,id:item.id});
    }
  }
  return targets;
}
export function addEdge(w,from,to,relation='关联') {
  if(w.graph.edges.length>=2000)throw Error('工作区已达到 2000 条关系（含历史关系）');
  const error=checkConnection(w.graph.nodes,w.graph.edges,from,to,relation.trim());
  if(error)throw Error(error);
  const e={id:newId('e'),from,to,relation:relation.trim()||'关联',relation_basis:'',confidence:null,provenance:'user_edited',source_refs:[],status:'confirmed',locked_fields:relation.trim()?['relation']:[],field_provenance:{relation:'user'}};
  w.graph.edges.push(e);derive(w);return e;
}
export function editItem(w,kind,id,patch) {
  const item=(kind==='node'?w.graph.nodes:w.graph.edges).find(n=>n.id===id);
  if(!item||item.status==='deleted')throw Error('对象已删除');
  if('label' in patch&&!patch.label.trim())throw Error('节点名称不能为空');
  if('relation' in patch&&!patch.relation.trim())throw Error('关系名称不能为空');
  for(const [field,value]of Object.entries(patch)) if(JSON.stringify(item[field])!==JSON.stringify(value)) {
    item[field]=value;item.locked_fields=[...new Set([...(item.locked_fields||[]),field])];
    item.field_provenance={...item.field_provenance,[field]:'user'};
  }
  item.provenance='user_edited';
  if(kind==='node'&&item.needs_details&&'label' in patch&&patch.label.trim()){
    item.needs_details=false;item.field_provenance={...item.field_provenance,label:'user'};
  }
  if(item.versions)item.versions.user=JSON.stringify(patch);
  derive(w);return item;
}
export function deleteItem(w,kind,id) {
  const item=(kind==='node'?w.graph.nodes:w.graph.edges).find(n=>n.id===id);
  if(!item)return;
  item.status='deleted';
  if(kind==='node')w.graph.edges.forEach(e=>{if(e.from===id||e.to===id)e.status='broken';});
  derive(w);
}
export function mergeNodes(w,from,to) {
  if(from===to)throw Error('请选择另一个合并目标');
  const source=liveNodes(w).find(n=>n.id===from),target=liveNodes(w).find(n=>n.id===to);
  if(!source||!target)throw Error('合并节点已不存在');
  target.source_refs=uniqueRefs([...target.source_refs,...source.source_refs]);
  target.aliases=[...new Set([...(target.aliases||[]),source.label])];
  if(!target.summary)target.summary=source.summary;
  if(source.content)target.content=[target.content,source.content].filter(Boolean).join('\n\n');
  source.status='deleted';source.merged_into=to;
  const seen=new Set();
  for(const e of w.graph.edges) {
    if(e.status==='deleted')continue;
    if(e.from===from)e.from=to;if(e.to===from)e.to=to;
    const key=JSON.stringify([e.from,e.to,e.relation]);
    if(e.from===e.to||seen.has(key))e.status='deleted';else seen.add(key);
  }
  derive(w);
}
export function targetSignature(w,kind,id) {
  const item=(kind==='node'?w.graph.nodes:w.graph.edges).find(n=>n.id===id);
  return JSON.stringify([w.source.content_hash,kind,id,item?.label,item?.relation,item?.from,item?.to,item?.status]);
}
/** Only unfilled, unlocked fields are accepted. AI-added edges remain proposals. */
export function applyEnrichment(w,kind,id,response,signature) {
  if(signature!==targetSignature(w,kind,id))throw Error('目标或原文已修改，已保留手动内容。请重新补充。');
  const item=(kind==='node'?w.graph.nodes:w.graph.edges).find(n=>n.id===id);
  if(!item||item.status==='deleted')throw Error('目标已删除，已忽略补充结果');
  const allowed=kind==='node'?['summary','content']:['relation_basis'];
  let changed=0;const fields={};
  for(const field of allowed) if(!item[field]&&!item.locked_fields?.includes(field)&&response.fields[field]) {
    item[field]=response.fields[field];fields[field]=response.mode;changed++;
  }
  if(!item.source_refs.length&&!item.locked_fields?.includes('source_refs')&&response.source_refs.length) {
    item.source_refs=uniqueRefs(response.source_refs);fields.source_refs=response.mode;changed++;
  }
  item.field_provenance={...item.field_provenance,...fields};
  if(changed){item.review_state='pending';item.enrichment_mode=response.mode;}
  item.enrichment_note=response.note||'';
  if(item.versions)item.versions.ai=JSON.stringify(response.fields);
  for(const suggestion of response.suggested_edges||[]) {
    const duplicate=w.pending_suggestions.some(s=>s.from===suggestion.from&&s.to===suggestion.to&&s.relation===suggestion.relation);
    if(!duplicate)w.pending_suggestions.push({...suggestion,id:newId('suggestion'),status:'pending',suggested_action:'add'});
  }
  derive(w);return changed;
}
export class History {
  constructor(){this.past=[];this.future=[];}
  push(before){this.past.push(clone(before));if(this.past.length>60)this.past.shift();this.future=[];}
  undo(current){if(!this.past.length)return null;this.future.push(clone(current));return this.past.pop();}
  redo(current){if(!this.future.length)return null;this.past.push(clone(current));return this.future.pop();}
}
