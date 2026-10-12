---
name: traceify
description: Turn one long text, Markdown file, or webpage into an editable knowledge graph with bidirectional source mapping, an outline/evidence chain, and confidence-aware node details. Use when the user wants to discover and inspect relationships inside a body of knowledge.
---

# Traceify workflow

Use this skill when the user supplies one source and asks for a structured graph, architecture view, outline, evidence chain, or linked explanation. One source produces one graph in the first version; do not merge multiple sources unless the user explicitly asks for a later extension.

## Core behavior

1. Ingest pasted text, a Markdown file, or a webpage URL. Preserve the original source and stable location markers. If a URL cannot be fetched, keep the URL as an unresolved source and say which portion could not be read.
2. Segment the source by paragraph. Refine a segment to a sentence or webpage fragment only when a paragraph contains distinct claims or the user asks for finer mapping.
3. Extract meaningful concepts, claims, entities, sections, and evidence as nodes. Infer edges freely from the source; choose relation labels that describe the evidence instead of forcing a fixed ontology. Never present an unsupported inference as a source fact.
4. For every node and edge, retain source references, a concise summary, the relation basis, confidence, and provenance (`extracted`, `ai_suggestion`, or `user_edited`). Keep low-confidence relations visible but visually weaker and mark them for confirmation.
5. Keep graph-to-source and source-to-graph links. Selecting a graph item should reveal its source excerpt and selecting an excerpt should reveal the linked graph items. Use stable IDs so edits do not break links.
6. Present the result as three linked views when the host supports them: hierarchical outline, architecture graph, and source/details. Also provide an evidence-chain view that follows claims from higher-level themes to source fragments. If no interactive canvas is available, render a Mermaid graph plus stable-ID detail records that can be edited and re-rendered.
7. When the user adds a node or edge, first create a pending AI suggestion containing related source fragments, a fragment overview, proposed content, relation basis, and confidence. Let the user accept, edit, reject, or leave each suggestion pending; allow batch acceptance for suggestions attached to one node. A pending suggestion is not part of the confirmed graph.
8. On confirmed edits, update graph, mappings, outline, and evidence chain together. Preserve both AI and user versions when a user edits an AI result, and use the user version as current. When an item is deleted, retain its source evidence and mark affected chains as broken so the user can undo or relink it.
9. Treat synchronization as real-time when supported. On failure, keep local edits, retry in the background, and mark conflicts. The local version remains visible while the user reviews a local-versus-remote diff and handles items individually.
10. If parsing is interrupted or input fails, retain the original source and all generated partial results. Allow retry and continued editing rather than discarding work. Save the graph and its evidence inside the workspace; export formats are outside the first version.

## Output contract

Read [references/graph-contract.md](references/graph-contract.md) when creating or updating graph data. Every response or saved workspace should expose the graph, outline, evidence chains, source mappings, pending suggestions, and sync state using that contract. Keep the user-facing explanation concise and point to the source evidence behind each important relationship.

## Scope boundary

Keep relation types adaptive, paragraph-first mapping, one source per graph, workspace save, and the three core views. Do not add multi-source merge, export pipelines, fixed ontology management, or platform-specific accessibility and keyboard behavior unless the user explicitly expands the scope.
