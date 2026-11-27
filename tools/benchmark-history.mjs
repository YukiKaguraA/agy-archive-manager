// node tools/benchmark-history.mjs [--only baseline|candidate|both] [--samples 20] [--baseline 7522523]
// Each sample measures a fresh process and a repeat using the snapshot token returned to the panel.
// OS file caches stay warm. Times include JSON response serialization, exclude worker startup and fixture creation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const script = fileURLToPath(import.meta.url);
const repo = dirname(dirname(script));
const size = 10_000;
const chunks = 10;
const pageSize = 50;
const targetedId = idFor(42);
const cases = {
  list: {},
  chinese: { query: '膜', every: 17, text: '空间膜结构' },
  code: { query: 'node::get()', every: 19, text: 'node::get()' },
  substring: { query: 'rmaliz', every: 23, text: 'Normalization' },
  keywords: { query: 'cobalt kernel', every: 29, text: 'cobalt kernel', mode: 'keywords' },
  preview: {},
};

function idFor(i) {
  return 'conversation-' + String(i).padStart(5, '0');
}

function nativeConversation(i) {
  return {
    id: idFor(i),
    annotations: { title: 'Discussion ' + i, archived: i % 5 === 0, tags: ['topic-' + (i % 8)] },
    metadata: { projectId: 'project-' + (i % 12) },
    state: { runState: 'RUN_STATE_IDLE', updateTime: new Date(Date.UTC(2025, 0, 1) + i * 60000).toISOString() },
  };
}

function generateDatabase(home) {
  const agyDir = join(home, '.gemini', 'antigravity');
  mkdirSync(agyDir, { recursive: true });
  const db = new DatabaseSync(join(agyDir, 'conversation_summaries.db'));
  try {
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY, step_count INTEGER, workspace_uris TEXT, preview TEXT);
      CREATE VIRTUAL TABLE conversations_fts USING fts5(
        conversation_id UNINDEXED, chunk_index UNINDEXED, title, user_body, agent_body, tokenize='unicode61');
      BEGIN;
    `);
    const summary = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)');
    const chunk = db.prepare('INSERT INTO conversations_fts VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < size; i++) {
      const id = idFor(i);
      const title = 'Discussion ' + i;
      const labels = Object.values(cases).filter(({ every }) => every && i % every === 0).map(({ text }) => text);
      // Single-token decoys exercise keyword AND. Duplicate chunks exercise conversation deduplication.
      if (i % cases.keywords.every !== 0) labels.push(i % 2 ? 'cobalt' : 'kernel');
      summary.run(id, chunks * 2, '[]', 'Synthetic project notes ' + i);
      for (let j = 0; j < chunks; j++) {
        const body = 'Sample ' + i + '/' + j + '. The team compared results from the previous review and recorded findings.';
        const markers = j === 2 || j === 8 ? ' ' + labels.join(' ') : '';
        chunk.run(id, j, title, body + (i % 2 ? markers : ''), 'Review complete. ' + body + (i % 2 ? '' : markers));
      }
    }
    db.exec('COMMIT');
    assert.equal(db.prepare('SELECT count(*) AS n FROM conversations_fts').get().n, size * chunks);
  } finally {
    db.close();
  }
}

function extractBaseline(home, revision) {
  const dir = join(home, 'baseline');
  mkdirSync(dir);
  const prefix = 'sidecars/archive_manager/';
  const files = execFileSync('git', ['ls-tree', '--name-only', revision + ':' + prefix.slice(0, -1)], { cwd: repo, encoding: 'utf8' });
  for (const file of files.split(/\r?\n/).filter((name) => name.endsWith('.mjs'))) {
    writeFileSync(join(dir, file), execFileSync('git', ['show', revision + ':' + prefix + file], { cwd: repo }));
  }
  return join(dir, 'server.mjs');
}

async function bindRoutes(home, server) {
  assert.equal(homedir(), home, 'Worker must use the synthetic home');
  const routes = new Map();
  const counts = { ListConversations: 0, GetConversation: 0 };
  globalThis.__benchmarkRoutes = routes;
  const modules = {
    sidecar_sdk: 'export class SidecarApp { page() {} api(path, handler) { globalThis.__benchmarkRoutes.set(path, handler); } run() {} }',
    './sidebar_injector.mjs': 'export function startSidebarInjector() { return { cleanup() {}, invalidateCount() {} }; }',
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (Object.hasOwn(modules, specifier)) {
        return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
  globalThis.fetch = async (url, request) => {
    const method = new URL(url).pathname.split('/').at(-1);
    const input = JSON.parse(request.body);
    assert.ok(Object.hasOwn(counts, method), 'Unexpected native method ' + method);
    counts[method]++;
    if (method === 'GetConversation') {
      assert.equal(input.conversationId, targetedId);
      return Response.json({ conversation: nativeConversation(42) });
    }
    const start = Number(input.pageToken || 0);
    const end = Math.min(size, start + Math.min(100, input.pageSize));
    assert.ok(end > start, 'Native pagination must advance');
    const conversations = Array.from({ length: end - start }, (_, offset) => nativeConversation(start + offset));
    return Response.json({ conversations, nextPageToken: end < size ? String(end) : '' });
  };
  try {
    await import(pathToFileURL(server).href);
  } finally {
    hooks.deregister();
  }
  return { routes, counts };
}

function firstRequest(name) {
  if (name === 'preview') return { conversationId: targetedId, locale: 'en' };
  const { query = '', mode = 'literal' } = cases[name];
  return { tab: 'all', page: 1, pageSize, locale: 'en', query, searchMode: mode };
}

function expectedIds(name) {
  const every = cases[name].every || 1;
  return Array.from({ length: Math.ceil(size / every) }, (_, i) => idFor(i * every));
}

async function verify(name, candidate, handler, counts) {
  const input = firstRequest(name);
  const first = await handler(input);
  if (name === 'preview') {
    assert.equal(first.id, targetedId);
    assert.equal(first.source, 'fts');
    assert.equal(first.messageCount, chunks * 2);
    if (candidate) assert.deepEqual(counts, { ListConversations: 0, GetConversation: 1 });
    return { source: first.source, messages: first.messageCount, native: counts };
  }
  const expected = expectedIds(name);
  const ids = first.items.map((item) => item.id);
  let pages = 1;
  if (candidate) {
    assert.ok(first.snapshotId, 'Missing snapshotId');
    assert.equal(first.total, expected.length);
    assert.equal(ids.length, Math.min(expected.length, pageSize));
    const repeat = await handler({ ...input, snapshotId: first.snapshotId });
    assert.equal(repeat.snapshotId, first.snapshotId);
    assert.deepEqual(repeat.items.map((item) => item.id), ids);
    for (let page = 2; page <= Math.ceil(expected.length / pageSize); page++) {
      const result = await handler({ ...input, page, snapshotId: first.snapshotId });
      assert.equal(result.snapshotId, first.snapshotId);
      assert.equal(result.total, expected.length);
      assert.equal(result.items.length, Math.min(pageSize, expected.length - ids.length));
      ids.push(...result.items.map((item) => item.id));
      pages++;
    }
  }
  assert.equal(new Set(ids).size, ids.length, 'Repeated conversation ID');
  assert.deepEqual(ids.sort(), expected, 'Result IDs disagree with the fixture');
  return { hits: ids.length, pages, firstPageItems: first.items.length, native: counts };
}

async function worker(home, server, build, name, operation) {
  const { routes, counts } = await bindRoutes(home, server);
  const handler = routes.get(name === 'preview' ? '/api/preview' : '/api/conversations');
  assert.ok(handler);
  if (operation === 'verify') return verify(name, build === 'candidate', handler, counts);
  const input = firstRequest(name);
  async function timed(request) {
    const start = performance.now();
    const payload = await handler(request);
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    return { ms: performance.now() - start, bytes, snapshotId: payload.snapshotId };
  }
  const cold = await timed(input);
  const hot = await timed(cold.snapshotId ? { ...input, snapshotId: cold.snapshotId } : input);
  return { cold: cold.ms, hot: hot.ms, peakMiB: process.resourceUsage().maxRSS / 1024, bytes: hot.bytes };
}

function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return [0.5, 0.95].map((q) => Number(sorted[Math.ceil(q * sorted.length) - 1].toFixed(2)));
}

function runBuild(home, build, server, samples) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ANTIGRAVITY_EXECUTABLE_DATA_DIR: join(home, 'data'),
    ANTIGRAVITY_LS_ADDRESS: 'synthetic.invalid', ANTIGRAVITY_CSRF_TOKEN: '' };
  const output = {};
  for (const name of Object.keys(cases)) {
    function run(operation) {
      const result = execFileSync(process.execPath, [script, '--worker', home, server, build, name, operation],
        { env, encoding: 'utf8', windowsHide: true });
      return JSON.parse(result);
    }
    const verification = run('verify');
    const timings = Array.from({ length: samples }, () => run('time'));
    output[name] = {
      coldMsP50P95: percentiles(timings.map((n) => n.cold)),
      hotMsP50P95: percentiles(timings.map((n) => n.hot)),
      peakMiB: Number(Math.max(...timings.map((n) => n.peakMiB)).toFixed(1)),
      responseBytes: timings[0].bytes, ...verification,
    };
    console.error(build + ' ' + name + ' ' + JSON.stringify(output[name]));
  }
  return output;
}

function main() {
  const { values } = parseArgs({ options: {
    only: { type: 'string', default: 'both' },
    samples: { type: 'string', default: '20' },
    baseline: { type: 'string', default: '7522523' },
  } });
  assert.ok(['baseline', 'candidate', 'both'].includes(values.only), 'Invalid --only');
  const samples = Number(values.samples);
  assert.ok(Number.isInteger(samples) && samples > 0, 'Invalid --samples');
  const home = mkdtempSync(join(tmpdir(), 'archive-history-bench-'));
  try {
    generateDatabase(home);
    const report = { node: process.version, sqlite: process.versions.sqlite, platform: process.platform + '-' + process.arch,
      baselineRevision: values.baseline, samples, conversations: size, bodyChunks: size * chunks };
    if (values.only !== 'candidate') report.baseline = runBuild(home, 'baseline', extractBaseline(home, values.baseline), samples);
    if (values.only !== 'baseline') report.candidate = runBuild(home, 'candidate', join(repo, 'sidecars/archive_manager/server.mjs'), samples);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') {
  console.log(JSON.stringify(await worker(...process.argv.slice(3))));
} else {
  main();
}
