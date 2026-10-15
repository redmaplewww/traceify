# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- First-version skill: turn one source (pasted text, Markdown file, or webpage URL) into an editable knowledge graph.
- Bidirectional graph ↔ source mapping, paragraph-first with sentence / webpage-fragment refinement.
- Evidence chains from high-level themes down to source fragments.
- Confidence-aware relations with relation basis and visible-but-weaker low-confidence edges.
- Pending AI suggestion workflow: accept, edit, reject, or batch-accept per node.
- Three linked views (outline, architecture graph, source/details) with a Mermaid fallback.
- Workspace persistence with sync states (synced / local_pending / retrying / conflict) and undoable broken chains.
- Cross-format smoke suite in `tests/` covering article, short post, paper page, and documentation inputs.

<!-- [Unreleased]: https://github.com/redmaplewww/traceify/compare/v0.1.0...HEAD
-->
