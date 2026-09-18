/** Escape user input before using it inside a RegExp. */
export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive exact-match regex for a user-supplied string. */
export function exactInsensitive(value) {
  return new RegExp(`^${escapeRegex(value)}$`, 'i');
}

/** Run async `fn` over `items` with at most `limit` in flight. */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}
