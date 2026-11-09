/** Adapted from AgentLoop 0.3.41 (recovered build, commit 6af9320).
 * Retains port gestures, pointer capture, stable edge IDs and cubic edge paths.
 * Knowledge graphs use expandable positive coordinates and semantic relations.
 */
export const NODE_WIDTH = 212;
export const NODE_HEIGHT = 88;
export function clampPosition(point) {
  return {x: Math.round(Math.min(100000,Math.max(20, point.x))), y: Math.round(Math.min(100000,Math.max(20, point.y)))};
}
export function edgePath(a, b) {
  const bend = Math.max(45, Math.min(180, Math.abs(b.x - a.x) * .45));
  return `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`;
}

/** Place a caption near its cubic path without covering nodes or earlier captions. */
export function edgeLabelPosition(from, to, obstacles, occupied, width, height) {
  const bend = Math.max(45, Math.min(180, Math.abs(to.x - from.x) * .45));
  const rectangles = [...obstacles, ...occupied];
  const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;
  for (const offset of [0, -24, 24, -48, 48, -80, 80, -120, 120]) {
    for (const t of [.5, .35, .65, .2, .8]) {
      const u = 1 - t;
      const x = u ** 3 * from.x + 3 * u * u * t * (from.x + bend) +
        3 * u * t * t * (to.x - bend) + t ** 3 * to.x;
      const curveY = u ** 3 * from.y + 3 * u * u * t * from.y +
        3 * u * t * t * to.y + t ** 3 * to.y;
      const y = curveY + offset;
      const bounds = {x: x - width / 2, y: y - height / 2, width, height};
      if (bounds.x < 8 || bounds.y < 8) continue;
      if (!rectangles.some(rect => overlaps(bounds, rect))) {
        return {x, y, bounds, anchor: {x, y: curveY}};
      }
    }
  }
  // Dense graphs still get a readable caption, linked back to its curve.
  const x = Math.max(width / 2 + 8, (from.x + to.x) / 2);
  const bottom = Math.max(from.y, to.y, ...rectangles.map(rect => rect.y + rect.height));
  const y = bottom + height / 2 + 12;
  return {
    x, y, bounds: {x: x - width / 2, y: y - height / 2, width, height},
    anchor: {x: (from.x + to.x) / 2, y: (from.y + to.y) / 2}
  };
}
export function checkConnection(nodes, edges, from, to, relation) {
  const ids = new Set(nodes.filter(n => n.status !== 'deleted').map(n => n.id));
  if (!ids.has(from) || !ids.has(to)) return '连线端点已不存在';
  if (from === to) return '请选择另一个节点';
  if (edges.some(e => e.status !== 'deleted' && e.from === from && e.to === to && e.relation === relation)) return '相同关系已经存在';
  return null;
}

/** Bind once to stable containers so a render never loses pointer capture. */
export function bindCanvas({viewport, world, scale, select, move, connect, preview, panEnd, connectionState=()=>{}}) {
  let drag = null, wire = null, pan = null, pending = null, suppressClick = false;
  const point = event => {
    const rect = world.getBoundingClientRect();
    return {x:(event.clientX - rect.left) / scale(), y:(event.clientY - rect.top) / scale()};
  };
  world.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const output = event.target.closest('[data-output]');
    const input = event.target.closest('[data-input]');
    const node = event.target.closest('[data-node]');
    if (output) {
      event.preventDefault();
      wire = {from:output.dataset.output, start:point(event), moved:false, pointer:event.pointerId};
      pending=null;connectionState(wire.from,null);
      world.setPointerCapture(event.pointerId);
    } else if (input || event.target.closest('[data-edge]')) return;
    else if (node && !event.target.closest('button')) {
      event.preventDefault();
      select('node', node.dataset.node, false);
      drag = {id:node.dataset.node, start:point(event), x:parseFloat(node.style.left), y:parseFloat(node.style.top), moved:false, pointer:event.pointerId};
      world.setPointerCapture(event.pointerId);
    }
  });
  viewport.addEventListener('pointerdown', event => {
    if (event.button || event.target.closest('[data-node], [data-edge], button')) return;
    if(pending){pending=null;preview(null,null);connectionState(null,null);}
    pan = {pointer:event.pointerId, x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};
    viewport.setPointerCapture(event.pointerId);
  });
  world.addEventListener('pointermove', event => {
    if (drag && drag.pointer === event.pointerId) {
      const p = point(event), next = clampPosition({x:drag.x+p.x-drag.start.x,y:drag.y+p.y-drag.start.y});
      drag.moved ||= Math.abs(next.x-drag.x)+Math.abs(next.y-drag.y)>3;
      move(drag.id,next,false);
    }
    if (wire && wire.pointer === event.pointerId) {
      const p=point(event);
      wire.moved ||= Math.hypot(p.x-wire.start.x,p.y-wire.start.y)>5;
      preview(wire.from,p);
      const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-node]');
      connectionState(wire.from,target?.dataset.node||null);
    }
  });
  viewport.addEventListener('pointermove', event => {
    if (!pan || pan.pointer !== event.pointerId) return;
    viewport.scrollLeft=pan.left-(event.clientX-pan.x);
    viewport.scrollTop=pan.top-(event.clientY-pan.y);
  });
  function finish(event, cancelled=false) {
    if (drag) {
      const d=drag; drag=null;
      move(d.id,null,!cancelled && d.moved,cancelled);
      suppressClick=d.moved;
      if (!d.moved && !cancelled) select('node',d.id,true);
    }
    if (wire) {
      const w=wire; wire=null; preview(null,null);
      if (!cancelled && w.moved) {
        const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-input],[data-node]');
        pending=null;connectionState(null,null);
        if (target) connect(w.from,target.dataset.input||target.dataset.node);
      } else if (!cancelled) {pending=w.from;connectionState(pending,null);}
      else {pending=null;connectionState(null,null);}
      suppressClick=w.moved;
    }
    pan=null; panEnd?.();
    setTimeout(()=>{suppressClick=false;},0);
  }
  viewport.addEventListener('pointerup',e=>finish(e));
  viewport.addEventListener('pointercancel',e=>finish(e,true));
  world.addEventListener('click', event => {
    if (suppressClick) return;
    const output=event.target.closest('[data-output]');
    if(output){pending=output.dataset.output;connectionState(pending,null);return;}
    const input=event.target.closest('[data-input]');
    if (input && pending) {const from=pending; pending=null;connectionState(null,null); connect(from,input.dataset.input);}
    const edge=event.target.closest('[data-edge]');
    if (edge) select('edge',edge.dataset.edge,true);
  });
  const cancelConnection=()=>{pending=null;wire=null;preview(null,null);connectionState(null,null);};
  window.addEventListener('keydown',event=>{if(event.key==='Escape')cancelConnection();});
  return {cancelConnection,startConnection(id){cancelConnection();pending=id;connectionState(id,null);}};
}
