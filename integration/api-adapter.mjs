/** Route Traceify's fixed API paths into a host application's namespace. */
export function createHostFetch({
  apiBase = '/api',
  assetBase = '.',
  fetchImpl = globalThis.fetch.bind(globalThis)
} = {}) {
  function join(base, suffix) {
    return base.replace(/\/+$/, '') + '/' + suffix.replace(/^\/+/, '');
  }
  return function hostFetch(input, options = {}) {
    let target = input;
    if (typeof input === 'string' && input.startsWith('/api/')) {
      target = join(apiBase, input.slice(5));
    } else if (input === '/demo.json') {
      target = join(assetBase, 'demo.json');
    }
    return fetchImpl(target, {credentials: 'same-origin', ...options});
  };
}
