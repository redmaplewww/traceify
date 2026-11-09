# Traceify test fixtures

The manifest lists public source URLs only. The runner fetches them at test time and keeps the source text out of the repository.

The short-post case is a public GitHub Status post; its direct URL is retained so the source mapping can be checked against the exact post.

## Editor regression checks

Run from the repository root.

```sh
node --test tests/editor.test.mjs integration/api-adapter.test.mjs
python tests/test_editor_api.py
python -m pip install -r requirements-tests.txt
python -m playwright install chromium
python tests/browser_editor.py
python tests/browser_drag.py
python tests/browser_design.py
python tests/browser_modules.py
```

These 58 checks use isolated workspaces and a local protocol test model.
The design and module checks load examples/accepted-workspace.json.
Browser screenshots are written to ../output/playwright relative to this repository.
