# Traceify graph contract

Use stable IDs (`n-...`, `e-...`, `s-...`) across edits. The contract is intentionally small so it can be rendered as JSON, Markdown, Mermaid, or an interactive canvas.

```yaml
workspace:
  id: string
  source:
    id: s-source
    kind: text | markdown | webpage
    title: string
    locator: string              # file path, URL, or input label
    content_hash: string
    status: complete | partial | failed
  graph:
    nodes: []
    edges: []
  mappings: []                  # source -> graph reverse index
  outline: []
  evidence_chains: []
  pending_suggestions: []
  sync:
    state: synced | local_pending | retrying | conflict
    last_synced_at: string|null
    retry_count: integer
    conflicts: []
```

```yaml
node:
  id: n-1
  label: string
  kind: concept | claim | entity | section | evidence | other
  summary: string
  content: string
  provenance: extracted | ai_suggestion | user_edited
  confidence: 0..1
  source_refs: [source_ref]
  versions:
    ai: string|null
    user: string|null
  status: confirmed | pending | deleted | broken

edge:
  id: e-1
  from: n-1
  to: n-2
  relation: string
  relation_basis: string
  confidence: 0..1
  provenance: extracted | ai_suggestion | user_edited
  source_refs: [source_ref]
  status: confirmed | pending | broken

source_ref:
  source_id: s-source
  granularity: paragraph | sentence | webpage_fragment
  locator: string                # paragraph index, line range, sentence index, or CSS/text fragment
  excerpt: string
  overview: string
```

```yaml
mapping:
  source_ref: source_ref
  node_ids: [n-1]
  edge_ids: [e-1]
```

Suggestions use the same node/edge fields plus `status: pending` and `suggested_action: add | update | relink`. They must include the source fragments and explanation that led to the suggestion. Keep pending suggestions separate from confirmed graph items.

An outline item points to node IDs. An evidence-chain item stores an ordered path of node/edge IDs ending in one or more source references. `mappings` is the reverse index used when a source excerpt is selected. A broken chain keeps its historical IDs and evidence so it can be undone or relinked. Each sync conflict should retain the local value, remote value, affected stable ID, and resolution status.

