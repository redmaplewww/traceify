import {NODE_WIDTH, NODE_HEIGHT} from './agentloop-canvas.js';

export const MODULE_COLORS = ['#4779c8', '#9465c7', '#d18a32', '#289883', '#cc668c', '#508fae'];

function moduleHash(value) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

/** A source chapter is an auditable grouping hint, including for older graphs. */
function sourceChapters(workspace, nodes) {
  const sectionAt = new Map();
  const headings = new Map();
  let chapter = null;
  for (const segment of workspace.source.segments || []) {
    if (/^h[12]$/.test(segment.tag)) {
      chapter = segment.id;
      headings.set(chapter, segment.text.replace(/^#+\s*/, '').trim());
    }
    sectionAt.set(segment.id, chapter);
  }
  const memberships = new Map();
  for (const node of nodes) {
    const direct = node.source_refs.find(ref => headings.has(ref.locator));
    if (direct) {
      memberships.set(node.id, direct.locator);
      continue;
    }
    const votes = new Map();
    for (const ref of node.source_refs) {
      const section = sectionAt.get(ref.locator);
      if (section) votes.set(section, (votes.get(section) || 0) + 1);
    }
    const best = [...votes].sort((a, b) => b[1] - a[1])[0];
    if (best) memberships.set(node.id, best[0]);
  }
  return {headings, memberships};
}

/** Infer visual communities from source chapters and actual graph connections. */
export function inferModules(workspace) {
  const nodes = workspace.graph.nodes.filter(node => node.status !== 'deleted');
  const edges = workspace.graph.edges.filter(edge => !['deleted', 'broken'].includes(edge.status));
  if (nodes.length < 2) return [];
  const incoming = new Set(edges.map(edge => edge.to));
  const root = nodes.length >= 4 ? nodes.find(node => !incoming.has(node.id)) : null;
  const members = nodes.filter(node => node !== root);
  const indices = new Map(members.map((node, index) => [node.id, index]));
  const {headings, memberships} = sourceChapters(workspace, members);
  const weights = new Map();
  function addWeight(a, b, weight) {
    if (a === undefined || b === undefined || a === b) return;
    const key = `${Math.min(a, b)},${Math.max(a, b)}`;
    weights.set(key, (weights.get(key) || 0) + weight);
  }
  edges.forEach(edge => addWeight(indices.get(edge.from), indices.get(edge.to), 1));
  for (let a = 0; a < members.length; a++) {
    for (let b = a + 1; b < members.length; b++) {
      if (memberships.has(members[a].id) && memberships.get(members[a].id) === memberships.get(members[b].id)) {
        addWeight(a, b, 2);
      }
    }
  }
  const connections = [...weights].map(([key, weight]) => ({pair: key.split(',').map(Number), weight}));
  const totalWeight = connections.reduce((sum, edge) => sum + edge.weight, 0);
  if (!totalWeight) return [];
  const degrees = members.map(() => 0);
  connections.forEach(({pair: [a, b], weight}) => {degrees[a] += weight; degrees[b] += weight;});
  const communities = new Map(members.map((node, index) => [index, {indices: [index], degree: degrees[index]}]));
  const owners = members.map((node, index) => index);
  while (communities.size > 1) {
    const between = new Map();
    for (const {pair, weight} of connections) {
      const [a, b] = pair.map(index => owners[index]);
      if (a === b) continue;
      const key = `${Math.min(a, b)},${Math.max(a, b)}`;
      between.set(key, (between.get(key) || 0) + weight);
    }
    let best = null;
    let bestGain = 0;
    for (const [key, weight] of between) {
      const [a, b] = key.split(',').map(Number);
      const gain = weight / totalWeight - communities.get(a).degree * communities.get(b).degree / (2 * totalWeight ** 2);
      if (gain > bestGain + 1e-9) {best = [a, b]; bestGain = gain;}
    }
    if (!best) break;
    const [a, b] = best;
    const target = communities.get(a), other = communities.get(b);
    target.indices.push(...other.indices);
    target.degree += other.degree;
    other.indices.forEach(index => {owners[index] = a;});
    communities.delete(b);
  }
  const clusters = [...communities.values()].filter(group => group.indices.length >= 2)
    .sort((a, b) => Math.min(...a.indices) - Math.min(...b.indices));
  if (!clusters.length) return [];
  const grouped = new Set(clusters.flatMap(group => group.indices));
  const rootId = 'g-auto-root';
  const result = [{id: rootId, label: (workspace.source.title || '知识结构').slice(0, 180), parent_id: null,
    node_ids: [...(root ? [root.id] : []), ...members.filter((node, index) => !grouped.has(index)).map(node => node.id)],
    color: '#788cae', provenance: 'graph_structure', basis: '原文主题下的模块与节点'}];
  clusters.forEach((community, index) => {
    const ids = community.indices.sort((a, b) => a - b).map(position => members[position].id);
    const sections = new Map();
    ids.forEach(id => {
      const section = memberships.get(id);
      if (section) sections.set(section, (sections.get(section) || 0) + 1);
    });
    const section = [...sections].sort((a, b) => b[1] - a[1])[0]?.[0];
    const representative = [...community.indices].sort((a, b) => degrees[b] - degrees[a])[0];
    const anchors = community.indices.filter(position => members[position].source_refs.some(ref => headings.has(ref.locator)));
    const topic = anchors.sort((a, b) => degrees[b] - degrees[a])[0] ?? representative;
    result.push({id: `g-auto-${moduleHash(ids.join('|'))}`, label: members[topic].label.slice(0, 180),
      parent_id: rootId, node_ids: ids, color: MODULE_COLORS[index % MODULE_COLORS.length],
      provenance: section ? 'source_structure' : 'graph_structure',
      basis: section ? '依据原文章节与已有连线整理' : '依据已有节点关联整理'});
  });
  return result;
}

export function nodeModule(workspace, nodeId) {
  const groups = workspace.graph.groups || [];
  return [...groups].reverse().find(group => group.node_ids.includes(nodeId)) || null;
}

/** Parent bounds enclose both direct nodes and nested child modules. */
export function moduleFrames(workspace) {
  const nodes = new Map(workspace.graph.nodes.filter(node => node.status !== 'deleted').map(node => [node.id, node]));
  const groups = workspace.graph.groups || [];
  const frames = new Map();
  const visiting = new Set();
  function resolve(group) {
    if (frames.has(group.id)) return frames.get(group.id);
    if (visiting.has(group.id)) return null;
    visiting.add(group.id);
    const children = groups.filter(child => child.parent_id === group.id).map(resolve).filter(Boolean);
    const rectangles = group.node_ids.filter(id => nodes.has(id)).map(id => ({
      ...workspace.layout.positions[id], width: NODE_WIDTH, height: NODE_HEIGHT
    }));
    rectangles.push(...children);
    visiting.delete(group.id);
    if (!rectangles.length) return null;
    const x = Math.max(8, Math.min(...rectangles.map(rect => rect.x)) - 24);
    const y = Math.max(8, Math.min(...rectangles.map(rect => rect.y)) - 48);
    const right = Math.max(...rectangles.map(rect => rect.x + rect.width)) + 24;
    const bottom = Math.max(...rectangles.map(rect => rect.y + rect.height)) + 24;
    const nodeIds = new Set([...group.node_ids.filter(id => nodes.has(id)), ...children.flatMap(child => child.member_ids)]);
    const frame = {...group, x, y, width: right - x, height: bottom - y, member_ids: [...nodeIds]};
    frames.set(group.id, frame);
    return frame;
  }
  groups.forEach(resolve);
  return [...frames.values()].sort((a, b) => b.width * b.height - a.width * a.height);
}

/** A deliberate, undoable arrangement makes module boundaries spatially coherent. */
export function arrangeModules(workspace) {
  const groups = workspace.graph.groups || [];
  const live = workspace.graph.nodes.filter(node => node.status !== 'deleted');
  const placed = new Set();
  const visiting = new Set();
  function arrange(group, x, y, columns = 2) {
    if (visiting.has(group.id)) return {width: 0, height: 0};
    visiting.add(group.id);
    const children = groups.filter(child => child.parent_id === group.id);
    const childIds = new Set(children.flatMap(child => moduleFrames(workspace).find(frame => frame.id === child.id)?.member_ids || []));
    const direct = group.node_ids.filter(id => !placed.has(id) && !childIds.has(id) && live.some(node => node.id === id));
    let cursorY = y + 48;
    let width = 260;
    for (let index = 0; index < direct.length; index++) {
      workspace.layout.positions[direct[index]] = {x: x + 24 + index % columns * 260, y: cursorY + Math.floor(index / columns) * 132};
      placed.add(direct[index]);
    }
    if (direct.length) {
      cursorY += Math.ceil(direct.length / columns) * 132;
      width = Math.min(columns, direct.length) * 260;
    }
    let cursorX = x + 24;
    let rowHeight = 0;
    children.forEach((child, index) => {
      if (index && index % 2 === 0) {cursorY += rowHeight + 36; cursorX = x + 24; rowHeight = 0;}
      const wideLastRow = children.length > 2 && children.length % 2 === 1 && index === children.length - 1;
      const size = arrange(child, cursorX, cursorY, wideLastRow ? 4 : 2);
      cursorX += size.width + 36;
      width = Math.max(width, cursorX - x - 12);
      rowHeight = Math.max(rowHeight, size.height);
    });
    visiting.delete(group.id);
    return {width: width + 24, height: cursorY - y + rowHeight + 24};
  }
  let y = 24;
  groups.filter(group => !group.parent_id || !groups.some(parent => parent.id === group.parent_id)).forEach(group => {
    const size = arrange(group, 24, y);
    y += size.height + 36;
  });
  live.filter(node => !placed.has(node.id)).forEach((node, index) => {
    workspace.layout.positions[node.id] = {x: 72 + index % 4 * 260, y: y + Math.floor(index / 4) * 132};
  });
  workspace.layout.module_layout_version = 1;
}
