// A tiny async cache around a slow fetch. Each key should only be fetched once.
export function createCache(fetchValue) {
  const store = new Map();
  let fetches = 0;
  async function get(key) {
    if (store.has(key)) return store.get(key);
    fetches++;
    const value = await fetchValue(key);
    store.set(key, value);
    return value;
  }
  return { get, fetchCount: () => fetches };
}
