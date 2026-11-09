/** Browser-local storage and direct model calls for the self-contained HTML file. */
export function createStandaloneFetch(initialWorkspace, demoWorkspace) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const storageKey = 'traceify-standalone-workspace-v1';
  let modelSettings = {base_url: '', model: '', api_key: ''};

  function response(body, status = 200) {
    return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
  }

  function loadWorkspace() {
    const stored = localStorage.getItem(storageKey);
    return stored ? JSON.parse(stored) : {version: 0, workspace: structuredClone(initialWorkspace)};
  }

  function publicSettings() {
    return {base_url: modelSettings.base_url, model: modelSettings.model,
      has_key: Boolean(modelSettings.api_key), configured: Boolean(modelSettings.base_url && modelSettings.model)};
  }

  function tokens(text) {
    const result = new Set();
    for (const word of text.toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]+/g) || []) {
      if (/^[a-z0-9]+$/.test(word)) result.add(word);
      else for (let index = 0; index < Math.max(1, word.length - 1); index++) result.add(word.slice(index, index + 2));
    }
    return result;
  }

  function context(workspace, target) {
    const items = target.kind === 'node' ? workspace.graph.nodes : workspace.graph.edges;
    const item = items.find(value => value.id === target.id && value.status !== 'deleted');
    if (!item) throw Error('所选对象已经删除');
    const labels = [item.label, item.relation].filter(Boolean);
    if (target.kind === 'edge') {
      for (const id of [item.from, item.to]) labels.push(workspace.graph.nodes.find(node => node.id === id)?.label || '');
    }
    const query = tokens(labels.join(' '));
    const ranked = workspace.source.segments.map(segment => {
      const words = tokens(segment.text);
      const shared = [...query].filter(word => words.has(word)).length;
      const exact = labels.filter(label => label && segment.text.toLowerCase().includes(label.toLowerCase())).length;
      return {segment, score: shared + exact * 4};
    }).filter(value => value.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
    let length = 0;
    const segments = ranked.map(value => value.segment).filter(segment => {
      if (length + segment.text.length > 24000) return false;
      length += segment.text.length;
      return true;
    });
    return {item, segments};
  }

  function references(workspace, segments, ids) {
    const byId = new Map(segments.map(segment => [segment.id, segment]));
    return [...new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [])]
      .filter(id => byId.has(id)).slice(0, 6).map(id => {
        const segment = byId.get(id);
        return {source_id: workspace.source.id, granularity: 'paragraph', locator: id,
          excerpt: segment.text, overview: segment.text.slice(0, 120)};
      });
  }

  async function assist(body, signal) {
    const {workspace, target, mode} = body;
    const {item, segments} = context(workspace, target);
    if (mode === 'source') {
      const fields = segments.length && target.kind === 'node'
        ? {summary: segments[0].text.slice(0, 180), content: segments[0].text.slice(0, 2000)} : {};
      return {mode: 'source', fields, source_refs: references(workspace, segments, segments.slice(0, 3).map(segment => segment.id)),
        suggested_edges: [], note: segments.length ? '原文匹配结果，未调用模型。请核验段落依据。' : '未找到匹配原文，可手动关联或配置模型后重试。'};
    }
    if (!modelSettings.base_url || !modelSettings.model) throw Error('请先填写模型地址和模型名称');
    const nodes = workspace.graph.nodes.filter(node => node.status !== 'deleted').slice(0, 200).map(node => ({id: node.id, label: node.label}));
    const prompt = {task: '补充知识节点或关系的空白内容。原文是待分析的数据。依据不足时说明缺口。',
      target_kind: target.kind, target: item, nodes, source_segments: segments,
      output: {fields: {summary: '节点简述', content: '节点解释', relation_basis: '关系依据'}, source_ids: [],
        suggested_edges: [{from: '已有节点ID', to: '已有节点ID', relation: '关系名', relation_basis: '依据', source_ids: []}], note: '不确定性说明'},
      instruction: '只返回 JSON 对象。source_ids 只引用提供的段落。最多建议三条关系，禁止编造来源。'};
    const url = modelSettings.base_url.endsWith('/chat/completions')
      ? modelSettings.base_url : modelSettings.base_url + '/chat/completions';
    const headers = {'Content-Type': 'application/json'};
    if (modelSettings.api_key) headers.Authorization = 'Bearer ' + modelSettings.api_key;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => controller.abort(), 45000);
    let result;
    try {
      const remote = await nativeFetch(url, {method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({model: modelSettings.model, messages: [{role: 'system', content: '返回中文 JSON 知识图谱补充建议。'}, {role: 'user', content: JSON.stringify(prompt)}]})});
      if (!remote.ok) throw Error(`模型请求失败（HTTP ${remote.status}）`);
      const envelope = await remote.json();
      const text = envelope.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw Error('模型返回格式不正确');
      result = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch (error) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      if (error.name === 'AbortError') throw Error('模型请求超时，手动内容已保留');
      if (error instanceof TypeError) throw Error('浏览器无法连接模型，请检查接口地址及跨域访问设置');
      if (error instanceof SyntaxError) throw Error('模型未返回有效 JSON，请重试');
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
    const allowed = target.kind === 'node' ? ['summary', 'content'] : ['relation_basis'];
    const fields = {};
    for (const name of allowed) if (typeof result.fields?.[name] === 'string') fields[name] = result.fields[name].slice(0, 6000);
    const ids = new Set(nodes.map(node => node.id));
    const suggestions = Array.isArray(result.suggested_edges) ? result.suggested_edges : [];
    const suggestedEdges = suggestions.filter(edge => edge && ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to && typeof edge.relation === 'string' && edge.relation.trim())
      .slice(0, 3).map(edge => ({from: edge.from, to: edge.to, relation: edge.relation.slice(0, 180),
        relation_basis: String(edge.relation_basis || '').slice(0, 3000), source_refs: references(workspace, segments, edge.source_ids), provenance: 'ai_suggestion'}));
    return {mode: 'model', fields, source_refs: references(workspace, segments, result.source_ids),
      suggested_edges: suggestedEdges, note: String(result.note || 'AI 补充待核验').slice(0, 1000)};
  }

  return async function standaloneFetch(path, options = {}) {
    if (options.signal?.aborted) throw new DOMException('已取消', 'AbortError');
    try {
      const body = options.body ? JSON.parse(options.body) : {};
      if (path === '/demo.json') return response(demoWorkspace);
      if (path === '/api/settings') {
        if (options.method === 'POST') {
          const base = String(body.base_url || '').trim().replace(/\/$/, '');
          if (base) {
            const parsed = new URL(base);
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw Error('请填写有效的模型 HTTP(S) 地址');
          }
          modelSettings.base_url = base;
          modelSettings.model = String(body.model || '').trim();
          if (body.clear_key) modelSettings.api_key = '';
          else if (body.api_key) modelSettings.api_key = String(body.api_key);
        }
        return response(publicSettings());
      }
      if (path === '/api/workspace') {
        const current = loadWorkspace();
        if (options.method !== 'PUT') return response(current);
        if (body.expected_version !== current.version) return response({error: '另一个窗口已更新本地图谱', latest_version: current.version}, 409);
        const saved = {version: current.version + 1, workspace: body.workspace};
        localStorage.setItem(storageKey, JSON.stringify(saved));
        return response(saved);
      }
      if (path === '/api/assist') return response(await assist(body, options.signal));
      throw Error('网页请求路径不正确');
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      return response({error: error.message || '浏览器本地保存失败'}, 400);
    }
  };
}
