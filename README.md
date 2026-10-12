# Traceify

Traceify turns one long text, Markdown file, or webpage into an editable knowledge graph with bidirectional source mapping, evidence chains, confidence-aware relationships, and clickable original-source details.

## Skill layout

- `SKILL.md` — core workflow and scope
- `references/graph-contract.md` — stable JSON contract for nodes, edges, mappings, evidence chains, suggestions, and sync state
- `agents/openai.yaml` — Codex display metadata

## Supported first-version inputs

- Pasted text
- Markdown files
- Webpage URLs

One source produces one graph. Mapping is paragraph-first and can refine to sentences or webpage fragments when needed.
