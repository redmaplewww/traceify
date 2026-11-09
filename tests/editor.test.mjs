import test from 'node:test';
import assert from 'node:assert/strict';
import {edgeLabelPosition} from '../web/agentloop-canvas.js';
import {inferModules, arrangeModules, moduleFrames} from '../web/modules.js';
import {emptyWorkspace,addNode,addDraftNode,addEdge,editItem,deleteItem,derive,mergeNodes,History,targetSignature,applyEnrichment,sourceRef,clone,canEnrich,takeAutoEnrichments} from '../web/graph.js';

function fixture(){const w=emptyWorkspace();w.source.content_hash='baseline';w.source.segments=[{id:'s-1',text:'协议让不同网络互联。'}];return w;}

test('dense graph captions stay in positive coordinates without covering obstacles', () => {
  const obstacles = [{x: 0, y: 0, width: 700, height: 700}];
  const caption = edgeLabelPosition({x: 232, y: 64}, {x: 20, y: 64}, obstacles, [], 600, 60);
  assert.ok(caption.bounds.x >= 8);
  assert.ok(caption.bounds.y > 700);
  assert.ok(Number.isFinite(caption.x) && Number.isFinite(caption.y));
  assert.deepEqual(caption.anchor, {x: 126, y: 64});
});

test('nested module frames enclose descendants and follow moved nodes', () => {
  const w = fixture();
  const a = addNode(w, '主题'), b = addNode(w, '模块节点'), c = addNode(w, '子模块节点');
  w.layout.grouping_mode = 'manual';
  w.graph.groups = [
    {id: 'g-root', label: '总主题', parent_id: null, node_ids: [a.id]},
    {id: 'g-module', label: '模块', parent_id: 'g-root', node_ids: [b.id]},
    {id: 'g-child', label: '子模块', parent_id: 'g-module', node_ids: [c.id]}
  ];
  arrangeModules(w);
  const before = moduleFrames(w);
  for (const frame of before.filter(frame => frame.parent_id)) {
    const parent = before.find(candidate => candidate.id === frame.parent_id);
    assert.ok(parent.x <= frame.x && parent.y < frame.y);
    assert.ok(parent.x + parent.width >= frame.x + frame.width);
    assert.ok(parent.y + parent.height >= frame.y + frame.height);
  }
  assert.equal(before.find(frame => frame.id === 'g-root').member_ids.length, 3);
  const childBefore = before.find(frame => frame.id === 'g-child');
  w.layout.positions[c.id].x += 100;
  const childAfter = moduleFrames(w).find(frame => frame.id === 'g-child');
  assert.equal(childAfter.x, childBefore.x + 100);
});

test('inferred module membership is stable across position changes', () => {
  const w = fixture();
  const nodes = ['主题', '协议', '网络', '依据', '结论'].map(label => addNode(w, label));
  nodes.slice(1).forEach((node, index) => addEdge(w, nodes[index].id, node.id));
  const before = inferModules(w);
  assert.ok(before.length >= 2);
  for (const position of Object.values(w.layout.positions)) position.x += 300;
  assert.deepEqual(inferModules(w), before);
});
test('manual fields and explicitly cleared fields are never overwritten by enrichment',()=>{
  const w=fixture(),n=addNode(w,'协议');editItem(w,'node',n.id,{summary:'人工摘要'});editItem(w,'node',n.id,{content:'写入后清空'});editItem(w,'node',n.id,{content:''});
  const signature=targetSignature(w,'node',n.id);
  applyEnrichment(w,'node',n.id,{mode:'model',fields:{summary:'错误覆盖',content:'错误覆盖'},source_refs:[sourceRef(w,w.source.segments[0])],suggested_edges:[]},signature);
  assert.equal(n.label,'协议');assert.equal(n.summary,'人工摘要');assert.equal(n.content,'');assert.equal(n.source_refs[0].locator,'s-1');
});
test('stale AI response cannot recreate deleted nodes or fill renamed targets',()=>{
  const w=fixture(),n=addNode(w,'原名称'),signature=targetSignature(w,'node',n.id);
  editItem(w,'node',n.id,{label:'新名称'});
  const response={mode:'model',fields:{content:'旧上下文'},source_refs:[],suggested_edges:[]};
  assert.throws(()=>applyEnrichment(w,'node',n.id,response,signature),/已修改/);
  const next=targetSignature(w,'node',n.id);deleteItem(w,'node',n.id);
  assert.throws(()=>applyEnrichment(w,'node',n.id,response,next));assert.equal(n.status,'deleted');
});
test('deletion keeps broken evidence and undo restores both node and relation',()=>{
  const w=fixture(),a=addNode(w,'协议'),b=addNode(w,'网络'),edge=addEdge(w,a.id,b.id,'支持');
  a.source_refs=[sourceRef(w,w.source.segments[0])];b.source_refs=[sourceRef(w,w.source.segments[0])];derive(w);
  const h=new History();h.push(w);deleteItem(w,'node',b.id);
  assert.equal(edge.status,'broken');assert.equal(w.evidence_chains[0].status,'broken');assert.equal(w.evidence_chains[0].source_refs.length,1);
  const restored=h.undo(w);assert.equal(restored.graph.nodes[1].status,'confirmed');assert.equal(restored.graph.edges[0].status,'confirmed');
  assert.equal(h.redo(restored).graph.nodes[1].status,'deleted');
});
test('cycles terminate, and merges retain evidence without self or duplicate edges',()=>{
  const w=fixture(),a=addNode(w,'A'),b=addNode(w,'B'),c=addNode(w,'C');
  addEdge(w,a.id,b.id,'支持');addEdge(w,b.id,a.id,'依赖');addEdge(w,c.id,b.id,'支持');
  a.source_refs=[sourceRef(w,w.source.segments[0])];derive(w);assert.equal(w.outline.length,3);
  mergeNodes(w,a.id,b.id);assert.equal(a.status,'deleted');assert.equal(b.source_refs.length,1);
  assert.equal(w.graph.edges.filter(e=>e.status==='confirmed').length,1);assert.equal(w.outline.length,2);
});
test('stable IDs survive layout and semantic edits; invalid endpoints are refused',()=>{
  const w=fixture(),a=addNode(w,'A'),b=addNode(w,'B'),edge=addEdge(w,a.id,b.id,'关联'),id=edge.id;
  assert.throws(()=>addEdge(w,a.id,b.id,'关联'),/已经存在/);assert.throws(()=>addEdge(w,a.id,'missing','关联'),/不存在/);
  assert.throws(()=>addEdge(w,a.id,a.id,'关联'),/另一个/);editItem(w,'edge',id,{relation:'支持'});w.layout.positions[a.id]={x:1000,y:2000};derive(w);
  assert.equal(edge.id,id);assert.deepEqual(w.outline.map(n=>n.node_id),[a.id,b.id]);
});
test('AI candidate edges remain separate until the user accepts them',()=>{
  const w=fixture(),a=addNode(w,'A'),b=addNode(w,'B');
  applyEnrichment(w,'node',a.id,{mode:'model',fields:{summary:'建议解释'},source_refs:[],suggested_edges:[{from:a.id,to:b.id,relation:'支持',source_refs:[]}]},targetSignature(w,'node',a.id));
  assert.equal(w.graph.edges.length,0);assert.equal(w.pending_suggestions.length,1);assert.equal(a.review_state,'pending');assert.equal(a.field_provenance.summary,'model');
});
test('dropped components exist immediately but only named drafts enter automatic enrichment',()=>{
  const w=fixture(),a=addDraftNode(w,'concept',{x:321,y:456}),b=addDraftNode(w,'concept',{x:600,y:456});
  assert.equal(w.graph.nodes.length,2);assert.notEqual(a.label,b.label);assert.equal(a.needs_details,true);
  assert.deepEqual(w.layout.positions[a.id],{x:321,y:456});assert.deepEqual(takeAutoEnrichments(w),[]);
  const edge=addEdge(w,a.id,b.id,'关联');edge.auto_fill_pending=true;
  editItem(w,'node',a.id,{label:'协议'});assert.deepEqual(takeAutoEnrichments(w),[{kind:'node',id:a.id}]);
  assert.equal(canEnrich(w,'edge',edge.id),false);
  editItem(w,'node',b.id,{label:'网络'});
  assert.deepEqual(takeAutoEnrichments(w),[{kind:'node',id:b.id},{kind:'edge',id:edge.id}]);
  assert.deepEqual(takeAutoEnrichments(w),[]);
});
test('unnamed drafts survive normalize and restore without triggering model requests',()=>{
  const w=fixture(),a=addDraftNode(w,'evidence',{x:80,y:160}),h=new History();h.push(w);
  editItem(w,'node',a.id,{label:'事实证据'});takeAutoEnrichments(w);
  const restored=h.undo(w);assert.equal(restored.graph.nodes[0].needs_details,true);assert.equal(restored.graph.nodes[0].auto_fill_pending,true);assert.deepEqual(takeAutoEnrichments(restored),[]);
});
