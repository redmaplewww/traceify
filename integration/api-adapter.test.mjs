import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostFetch} from './api-adapter.mjs';

test('host prefixes route both API and bundled demo requests', async () => {
  const requests = [];
  const fetch = createHostFetch({
    apiBase: '/my-app/api/traceify/', assetBase: '/my-app/tools/traceify/',
    fetchImpl: async (input, options) => { requests.push([input, options]); return 'ok'; }
  });
  assert.equal(await fetch('/api/workspace'), 'ok');
  await fetch('/api/settings');
  await fetch('/demo.json');
  assert.deepEqual(requests.map(request => request[0]), [
    '/my-app/api/traceify/workspace', '/my-app/api/traceify/settings', '/my-app/tools/traceify/demo.json'
  ]);
  assert.equal(requests[0][1].credentials, 'same-origin');
});

test('host routing preserves cancellation, credentials, headers, and response identity', async () => {
  const controller = new AbortController();
  const headers = {'X-Workspace-ID': 'test-workspace'};
  const response = {status: 409};
  let captured;
  const fetch = createHostFetch({fetchImpl: async (...args) => { captured = args; return response; }});
  assert.equal(await fetch('/api/workspace', {method: 'PUT', body: '{}', headers,
    credentials: 'include', signal: controller.signal}), response);
  assert.equal(captured[1].signal, controller.signal);
  assert.equal(captured[1].headers, headers);
  assert.equal(captured[1].credentials, 'include');
  assert.equal(captured[1].body, '{}');
  await fetch('https://example.invalid/assets/icon.svg');
  assert.equal(captured[0], 'https://example.invalid/assets/icon.svg');
});
