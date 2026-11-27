import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

const panels = new Map();

export function beginSearch(client, sequence) {
  if (typeof client !== 'string' || !client || !Number.isSafeInteger(sequence)) return undefined;
  const last = panels.get(client);
  if (last && last.sequence > sequence) return AbortSignal.abort();
  last?.controller.abort();
  const controller = new AbortController();
  panels.delete(client);
  panels.set(client, { sequence, controller });
  if (panels.size > 64) {
    const oldest = panels.keys().next().value;
    panels.get(oldest).controller.abort();
    panels.delete(oldest);
  }
  return controller.signal;
}

function readBodies(data, signal) {
  if (signal?.aborted) return Promise.resolve({ hits: [] });
  return new Promise(resolve => {
    const worker = new Worker(new URL('./search-worker.mjs', import.meta.url), { workerData: data });
    const finish = result => {
      signal?.removeEventListener('abort', cancel);
      resolve(result);
    };
    const cancel = () => {
      void worker.terminate();
      finish({ hits: [] });
    };
    signal?.addEventListener('abort', cancel, { once: true });
    worker.once('message', finish);
    worker.once('error', () => finish({ hits: [], warning: 'ftsUnreadable' }));
    worker.once('exit', () => finish({ hits: [] }));
    if (signal?.aborted) cancel();
  });
}

export async function filterSearch(items, query, mode, dbPath, signal) {
  const words = mode === 'keywords' ? [...new Set(query.split(/\s+/u))] : [query];
  const matches = new Map();
  const pending = [];
  for (const item of items) {
    const fields = [item.id, item.title, item.summary, item.projectId, item.project, item.projectLabel,
      item.groupId, item.groupLabel, item.note, ...item.tags].map(value => value.toLowerCase());
    const missing = words.filter(word => !fields.some(field => field.includes(word)));
    if (!missing.length) matches.set(item.id, '');
    // Literal search also supplies body snippets for a match already found in metadata.
    if (mode === 'literal' || missing.length) pending.push([item.id, mode === 'literal' ? words : missing]);
  }
  let warning;
  if (pending.length && existsSync(dbPath)) {
    const bodies = await readBodies({ pending, words, mode, dbPath }, signal);
    for (const [id, snippet] of bodies.hits) matches.set(id, snippet);
    warning = bodies.warning;
  } else if (pending.length) {
    warning = 'ftsUnreadable';
  }
  return { items: items.filter(item => matches.has(item.id)).map(item => ({ ...item, matchSnippet: matches.get(item.id) })), warning };
}
