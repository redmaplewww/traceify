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
    groups: []                  # nested visual modules with stable IDs
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
  confidence: 0..1 | null       # null when confidence has not been assessed
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
  confidence: 0..1 | null
  provenance: extracted | ai_suggestion | user_edited
  source_refs: [source_ref]
  status: confirmed | pending | broken | deleted

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

## Nested module groups

```yaml
group:
  id: g-core
  label: Core concepts
  node_ids: [n-1, n-2]          # direct members, children add their members recursively
  parent_id: g-topic           # null for a top-level container
  color: "#4779c8"
  provenance: extracted | source_structure | graph_structure | user_edited
  basis: string               # source section or explanation of logical association
```

Group IDs are unique within `graph.groups`. Parent references form an acyclic hierarchy of at most 32 levels. Members reference existing graph node IDs. Render each group as a labeled semi-transparent background frame enclosing direct nodes and child groups. Module membership and semantic edges have separate storage. A group carries its own basis and provenance.

For older workspaces, the editor derives initial groups from source headings and existing connectivity. The initial arrangement is recorded in undo history. `layout.module_layout_version` records activation, and `layout.grouping_mode` selects `auto` or `manual`. Choosing a module or creating a submodule switches membership management to manual. `layout.view_mode` stores `reading` or `overview`. The module arrangement action is reversible. Group frames follow current node positions and hierarchy.

An outline item points to node IDs. An evidence-chain item stores an ordered path of node/edge IDs ending in one or more source references. `mappings` is the reverse index used when a source excerpt is selected. A broken chain keeps its historical IDs and evidence so it can be undone or relinked. Each sync conflict should retain the local value, remote value, affected stable ID, and resolution status.

## Interactive editor extensions (schema_version: 2)

The local editor accepts the original fields and adds `source.segments` (stable paragraph IDs and authoritative text), `layout.positions` (node ID -> x/y), `layout.zoom`, and `layout.viewport`. Layout changes never create knowledge relations. Existing demo data is converted at the web boundary; the original demonstrations remain unchanged.

Nodes and edges may carry `locked_fields`, `field_provenance` (`user`, `model`, `source`), `review_state` (`pending`, `reviewed`), `enrichment_mode` and `enrichment_note`. Explicitly edited or cleared fields are protected. AI may fill empty unlocked summary/content/basis and source references; it cannot rename user nodes or change endpoints. The structure is immediately available for manual editing, while generated content retains a pending review marker. Suggested new edges remain outside graph.edges until accepted.

For this paragraph-based editor, source_ref.locator equals the source.segments ID and excerpt must exactly match that paragraph. Model-returned unknown source IDs are discarded, and authoritative excerpts are built on the server, not accepted from model text. AI responses are rejected when the target name, relationship, endpoints, deletion state or source hash changed.

The server stores `{version, workspace}`. Saves include expected_version; mismatches return HTTP 409. The client retains its complete local value and the server retains the remote snapshot; the UI currently supports whole-workspace keep-local/load-remote resolution, not per-field merging. Broken historical chains remain visible. A chain can be `complete`, `unsubstantiated`, or `broken`; complete only means source references exist, not that the semantic claim has been proved.

Drag-created nodes also retain `draft_label`, `needs_details`, and `auto_fill_pending`. A component drop immediately creates a stable node and saves its position; its default label is a placeholder and no model request is made. Explicitly naming the node clears needs_details. Automatic enrichment consumes eligible pending flags once, including edges whose endpoints have both been named. Drafts are valid saved workspace objects and participate in undo/redo. Direct port drops create edges immediately with the editable relation `关联`; no creation modal is required.

