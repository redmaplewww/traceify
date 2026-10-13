# Traceify smoke-test report

Run date: 2026-10-13 (Asia/Shanghai)

This suite checks the first-version input boundary and the graph contract against four different source shapes. The current Traceify deliverable is an agent skill, so semantic graph quality is reviewed through the expected node/edge shape below; the runner verifies source acquisition, segmentation signals, and short-source handling.

## Results

| Case | Source shape | Observed input signal | Expected graph behavior | Result |
|---|---|---:|---|---|
| Long article | Wikipedia, `History of the Internet` | 59 headings, 160 paragraph units, 1.33 MB HTML | Preserve section hierarchy; create paragraph-first mappings; connect historical stages into an evidence chain | PASS |
| Tweet | Public GitHub Status post | 1 post unit, 89-character description, exact `x.com` URL | Keep one compact claim/source unit; do not invent paragraph structure; retain the post URL and excerpt | PASS |
| Paper | arXiv abstract page, `Attention Is All You Need` | 15 headings, 3 paragraph units, 43.6 KB HTML | Separate problem, method, contribution and result claims; map each claim back to the paper page | PASS |
| User manual | Python Tutorial | 9 headings, 13 paragraph units, 37.3 KB HTML | Preserve instructional hierarchy; map concepts, procedures and prerequisites to the relevant sections | PASS |

## Expected graph checks

### Long article

The graph should form a historical chain such as foundations → packet switching → ARPANET and related networks → TCP/IP and DNS → World Wide Web → Web 2.0 and social/mobile use. Section nodes should remain distinct from claim nodes, while each claim keeps a paragraph or section locator.

### Tweet

The graph should stay intentionally small: a source/post node, an incident claim node, and an evidence edge such as `reports`. A single post must not be inflated into a fake outline or a set of unsupported relationships.

### Paper

The paper graph should distinguish the sequence-modeling problem, self-attention, the Transformer architecture, parallelization, training efficiency and reported results. Citation and result claims should preserve the arXiv source page as their evidence anchor.

### User manual

The graph should expose the manual's progression from introduction and interpreter basics through control flow, data structures, modules, I/O, errors, classes and standard-library usage. Procedure nodes should map back to the relevant tutorial section rather than only to the page as a whole.

## Re-run

From the repository root:

```bash
python tests/run_smoke.py
```

The runner fetches the four public sources, extracts headings/paragraph signals, uses the X `og:description` field for the short post, and exits non-zero if any source yields no usable content unit. It does not store source pages in the repository.

## Scope note

This is an input and contract smoke test. It does not claim that a deterministic parser alone can judge semantic relation quality; that part remains the model-driven Traceify workflow and should be reviewed through the generated node evidence, confidence, and reverse mappings.
