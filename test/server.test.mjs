import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'archive-manager-test-'));
const agyDir = join(home, '.gemini', 'antigravity');
const dataDir = join(home, 'data');
const metaFile = join(dataDir, 'meta.json');
const dbFile = join(agyDir, 'conversation_summaries.db');
const routes = new Map();
let archivedCount;
let invalidations;
let conversations;
let requests;
let failures;
let afterUpdate;
let ignoredUpdates;
let sparseUpdates;

const testBindings = Symbol.for('archive-manager-test');
globalThis[testBindings] = {
  routes,
  registerCount: (callback) => { archivedCount = callback; },
  invalidateCount: () => { invalidations++; },
};

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'sidecar_sdk') {
      return { url: `data:text/javascript,${encodeURIComponent(`
        export class SidecarApp {
          page() {}
          api(path, handler) { globalThis[Symbol.for('archive-manager-test')].routes.set(path, handler); }
          run() {}
        }`)}`, shortCircuit: true };
    }
    if (specifier === './sidebar_injector.mjs' && context.parentURL?.endsWith('/server.mjs')) {
      return { url: `data:text/javascript,${encodeURIComponent(`
        export function startSidebarInjector(callback) {
          const tools = globalThis[Symbol.for('archive-manager-test')];
          tools.registerCount(callback);
          return { cleanup() {}, invalidateCount: tools.invalidateCount };
        }`)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, request) => {
  const method = new URL(url).pathname.split('/').at(-1);
  const input = JSON.parse(request.body);
  requests.push({ method, input });
  if (failures.has(`${method}:${input.conversationId || ''}`)) {
    return Response.json({ message: 'request rejected' }, { status: 500 });
  }
  const conv = conversations.get(input.conversationId);
  if (method === 'ListConversations') return Response.json({ conversations: [...conversations.values()] });
  if (method === 'GetConversation') return Response.json(conv?.topLevel ? conv : { conversation: conv });
  if (method === 'UpdateConversation') {
    if (!ignoredUpdates.has(input.conversationId)) Object.assign(conv.annotations, input.annotations);
    afterUpdate?.(input.conversationId);
    if (sparseUpdates.has(input.conversationId)) {
      return Response.json({ conversation: { id: conv.id, state: conv.state } });
    }
    return Response.json(conv);
  }
  if (method === 'DeleteConversation') conversations.delete(input.conversationId);
  return Response.json({});
};

for (const key of ['HOME', 'USERPROFILE', 'ANTIGRAVITY_EXECUTABLE_DATA_DIR']) {
  process.env[key] = key === 'ANTIGRAVITY_EXECUTABLE_DATA_DIR' ? dataDir : home;
}
await import('../sidecars/archive_manager/server.mjs');
hooks.deregister();

beforeEach(() => {
  conversations = new Map();
  requests = [];
  failures = new Set();
  ignoredUpdates = new Set();
  sparseUpdates = new Set();
  afterUpdate = null;
  invalidations = 0;
  for (const file of [metaFile, dbFile, join(dataDir, 'meta.json.tmp')]) {
    rmSync(file, { force: true });
  }
});

after(() => {
  globalThis.fetch = originalFetch;
  delete globalThis[testBindings];
  rmSync(home, { force: true, recursive: true });
});

function addConversation(id, { archived = false, pinned = false, starred = false, days = 14, runState = 'RUN_STATE_IDLE', parentConversationId } = {}) {
  conversations.set(id, {
    id,
    annotations: { archived, pinned, starred, title: id },
    metadata: { parentConversationId },
    state: { runState, updateTime: new Date(Date.now() - days * 86400000).toISOString() },
  });
}

function call(path, input) {
  return routes.get(`/api/${path}`)(input);
}

function mutationIds(method) {
  return requests.filter((request) => request.method === method).map((request) => request.input.conversationId);
}

test('archive records only actual changes and keeps per-item failures', async () => {
  addConversation('active');
  addConversation('archived', { archived: true });
  addConversation('failed');
  addConversation('running', { runState: 'RUN_STATE_RUNNING' });
  addConversation('unknown', { runState: null });
  failures.add('UpdateConversation:failed');

  const result = await call('set-archived', {
    conversationIds: ['active', 'archived', 'failed', 'running', 'unknown', 'active', 'missing'],
    archived: true,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.succeeded, ['active']);
  assert.deepEqual(result.unchanged, ['archived']);
  assert.deepEqual(result.failed.map(({ id }) => id), ['failed', 'running', 'unknown', 'missing']);
  assert.deepEqual(result.changes, [{ id: 'active', previousArchived: false, archived: true }]);
  assert.deepEqual(mutationIds('UpdateConversation'), ['active', 'failed']);
  assert.equal(invalidations, 1);
});

test('archive serializes concurrent requests so only one records the same transition', async () => {
  addConversation('same');
  const input = { conversationIds: ['same'], archived: true };

  const [first, second] = await Promise.all([call('set-archived', input), call('set-archived', input)]);

  assert.deepEqual(first.changes, [{ id: 'same', previousArchived: false, archived: true }]);
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.unchanged, ['same']);
  assert.deepEqual(mutationIds('UpdateConversation'), ['same']);
  assert.equal(invalidations, 1);
});

test('undo restores each recorded prior state, skips already-restored IDs and rejects invalid records', async () => {
  addConversation('restore', { archived: true, runState: 'RUN_STATE_RUNNING' });
  addConversation('rearchive');
  addConversation('already-restored');
  await assert.rejects(call('set-archived', {
    undo: [{ id: 'rearchive', previousArchived: false, archived: false }],
  }));
  const result = await call('set-archived', { undo: [
    { id: 'restore', previousArchived: false, archived: true },
    { id: 'rearchive', previousArchived: true, archived: false },
    { id: 'already-restored', previousArchived: false, archived: true },
  ] });

  assert.equal(result.ok, true);
  assert.equal(result.archived, null);
  assert.deepEqual(result.succeeded, ['restore', 'rearchive']);
  assert.deepEqual(result.unchanged, ['already-restored']);
  assert.deepEqual(result.changes, [
    { id: 'restore', previousArchived: true, archived: false },
    { id: 'rearchive', previousArchived: false, archived: true },
  ]);
  assert.deepEqual(mutationIds('UpdateConversation'), ['restore', 'rearchive']);
});

test('stale candidates are rechecked against the same native eligibility used by the list', async () => {
  addConversation('eligible');
  addConversation('already', { archived: true });
  addConversation('pinned', { pinned: true });
  addConversation('starred', { starred: true });
  addConversation('running', { runState: 'RUN_STATE_CANCELLING' });
  addConversation('recent', { days: 2 });
  addConversation('unknown', { runState: 'RUN_STATE_FUTURE' });
  addConversation('child', { parentConversationId: 'eligible' });

  const list = await call('conversations', { tab: 'stale', staleDays: 7 });
  assert.deepEqual(list.items.map(({ id }) => id), ['eligible']);
  assert.equal(list.counts.stale, 1);
  const result = await call('set-archived', { conversationIds: [...conversations.keys()], archived: true, staleDays: 7 });
  assert.deepEqual(result.succeeded, ['eligible']);
  assert.deepEqual(result.failed.map(({ id }) => id), ['already', 'pinned', 'starred', 'running', 'recent', 'unknown', 'child']);
  assert.deepEqual(mutationIds('UpdateConversation'), ['eligible']);
});

test('later stale candidates are refreshed when native state changes during a batch', async () => {
  addConversation('first');
  addConversation('pinned-during-batch');
  addConversation('started-during-batch');
  addConversation('became-recent');
  afterUpdate = (id) => {
    if (id !== 'first') return;
    conversations.get('pinned-during-batch').annotations.pinned = true;
    conversations.get('started-during-batch').state.runState = 'RUN_STATE_RUNNING';
    conversations.get('became-recent').state.updateTime = new Date().toISOString();
  };

  const result = await call('set-archived', { conversationIds: [...conversations.keys()], archived: true, staleDays: 7 });

  assert.deepEqual(result.succeeded, ['first']);
  assert.deepEqual(result.failed.map(({ id }) => id), ['pinned-during-batch', 'started-during-batch', 'became-recent']);
  assert.deepEqual(mutationIds('UpdateConversation'), ['first']);
});

test('an update response with unchanged native state does not create an undo record', async () => {
  addConversation('ignored');
  ignoredUpdates.add('ignored');

  const result = await call('set-archived', { conversationIds: ['ignored'], archived: true });

  assert.deepEqual(result.failed.map(({ id }) => id), ['ignored']);
  assert.deepEqual(result.succeeded, []);
  assert.deepEqual(result.changes, []);
  assert.equal(invalidations, 0);
});

test('an update reply without archive annotations is confirmed through a targeted read', async () => {
  addConversation('ignored-restore', { archived: true });
  addConversation('successful-archive');
  ignoredUpdates.add('ignored-restore');
  sparseUpdates.add('ignored-restore');
  sparseUpdates.add('successful-archive');

  const restore = await call('set-archived', { conversationIds: ['ignored-restore'], archived: false });
  const archive = await call('set-archived', { conversationIds: ['successful-archive'], archived: true });

  assert.deepEqual(restore.failed.map(({ id }) => id), ['ignored-restore']);
  assert.deepEqual(restore.changes, []);
  assert.deepEqual(archive.changes, [{ id: 'successful-archive', previousArchived: false, archived: true }]);
  assert.deepEqual(mutationIds('GetConversation'), ['ignored-restore', 'ignored-restore', 'successful-archive', 'successful-archive']);
  assert.equal(invalidations, 1);
});

test('delete only accepts an explicit idle state in either existing native response shape', async () => {
  addConversation('missing', { runState: null });
  addConversation('unknown', { runState: 'RUN_STATE_FUTURE' });
  addConversation('running', { runState: 'RUN_STATE_CANCELLING' });
  addConversation('idle');
  addConversation('top-level');
  conversations.get('top-level').topLevel = true;

  for (const id of ['missing', 'unknown', 'running', 'absent']) {
    await assert.rejects(call('delete', { conversationId: id }));
  }
  assert.equal((await call('delete', { conversationId: 'idle' })).ok, true);
  assert.equal((await call('delete', { conversationId: 'top-level' })).ok, true);
  assert.deepEqual(mutationIds('DeleteConversation'), ['idle', 'top-level']);
  assert.equal(invalidations, 2);
});

test('damaged metadata stays on disk and surfaces a warning on reads and successful deletes', async () => {
  addConversation('damaged');
  const damaged = '{"conversations": {"damaged": {"tags": [1]}}}';
  writeFileSync(metaFile, damaged);

  const list = await call('conversations', { tab: 'all' });
  assert.equal(list.items.length, 1);
  assert.ok(list.warnings.some((warning) => /meta\.json/.test(warning)));
  await assert.rejects(call('meta/update', { conversationId: 'damaged', note: 'new' }), /meta\.json/);
  const updated = await call('meta/update', { conversationId: 'damaged', pinned: true });
  assert.equal(updated.ok, true);
  const deleted = await call('delete', { conversationId: 'damaged' });
  assert.equal(deleted.ok, true);
  assert.ok(deleted.warnings.some((warning) => /meta\.json/.test(warning)));
  assert.equal(readFileSync(metaFile, 'utf8'), damaged);
});

test('metadata preserves valid extra fields and avoids creating a file for annotation-only updates', async () => {
  addConversation('meta');
  await call('meta/update', { conversationId: 'meta', pinned: true });
  assert.equal(existsSync(metaFile), false);

  const store = { schema: 1, conversations: { meta: { tags: ['existing'], extra: 'keep' }, other: { note: 'retain' } } };
  writeFileSync(metaFile, JSON.stringify(store));
  const unrelatedTemp = join(dataDir, 'meta.json.tmp');
  writeFileSync(unrelatedTemp, 'unrelated');
  await call('meta/update', { conversationId: 'meta', note: ' updated ' });

  store.conversations.meta.note = 'updated';
  assert.deepEqual(JSON.parse(readFileSync(metaFile, 'utf8')), store);
  assert.equal(readFileSync(unrelatedTemp, 'utf8'), 'unrelated');
  assert.deepEqual(readdirSync(dataDir).sort(), ['meta.json', 'meta.json.tmp']);
});

test('sidebar count uses only native conversations and propagates upstream errors', async () => {
  addConversation('visible', { archived: true });
  addConversation('child', { archived: true, parentConversationId: 'visible' });
  addConversation('active');
  mkdirSync(agyDir, { recursive: true });
  writeFileSync(dbFile, 'invalid sqlite');
  writeFileSync(metaFile, 'invalid meta');

  assert.equal(await archivedCount(), 1);
  assert.deepEqual(requests.map(({ method }) => method), ['ListConversations']);
  failures.add('ListConversations:');
  await assert.rejects(archivedCount(), /request rejected/);
});

function writeTranscript(id, filename, steps) {
  const path = join(agyDir, 'brain', id, '.system_generated', 'logs', filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, steps.map((step) => typeof step === 'string' ? step : JSON.stringify(step)).join('\n'));
}

function user(step_index, content) {
  return { type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index, content };
}

function reply(step_index, content) {
  return { type: 'PLANNER_RESPONSE', step_index, content };
}

test('preview merges compatible partial transcripts without repeating text or leaking tool steps', async () => {
  addConversation('merge');
  writeTranscript('merge', 'transcript_full.jsonl', [user(0, '<USER_REQUEST>First</USER_REQUEST>'), '{ broken', reply(4, 'Last')]);
  writeTranscript('merge', 'transcript.jsonl', [user(0, 'First'), reply(1, 'Recovered'), { type: 'TOOL_CALL', content: 'secret' }, '{ broken']);

  const preview = await call('preview', { conversationId: 'merge' });
  assert.equal(preview.source, 'transcript_full+transcript');
  assert.deepEqual(preview.messages.map(({ content }) => content), ['First', 'Recovered', 'Last']);
  assert.ok(preview.warnings.some((warning) => /transcript_full.*1/.test(warning)));
  assert.ok(preview.warnings.some((warning) => /transcript\.jsonl.*1/.test(warning)));
  const exp = await call('export', { conversationId: 'merge' });
  assert.ok(exp.markdown.includes(preview.source));
  for (const warning of preview.warnings) assert.ok(exp.markdown.includes(warning));
  assert.ok(!exp.markdown.includes('secret'));
});

test('preview keeps readable full transcript text when overlapping indexes conflict', async () => {
  addConversation('conflict');
  writeTranscript('conflict', 'transcript_full.jsonl', [user(0, 'Different'), '{ broken']);
  writeTranscript('conflict', 'transcript.jsonl', [user(0, 'First'), reply(1, 'Recovered')]);

  const preview = await call('preview', { conversationId: 'conflict' });
  assert.equal(preview.source, 'transcript_full');
  assert.deepEqual(preview.messages.map(({ content }) => content), ['Different']);
  assert.ok(preview.warnings.some((warning) => /无法可靠对齐/.test(warning)));
});

test('preview keeps the longer full answer when a compatible compact log clips it and supplies extra text', async () => {
  addConversation('clipped-answer');
  const fullAnswer = 'Long answer. The remaining details are available in the complete text.';
  writeTranscript('clipped-answer', 'transcript_full.jsonl', [user(0, 'First'), reply(2, fullAnswer), '{ broken']);
  writeTranscript('clipped-answer', 'transcript.jsonl', [user(0, 'First'), reply(2, 'Long answer.'), user(3, 'Extra')]);

  const preview = await call('preview', { conversationId: 'clipped-answer' });
  assert.equal(preview.source, 'transcript_full+transcript');
  assert.deepEqual(preview.messages.map(({ content }) => content), ['First', fullAnswer, 'Extra']);
  assert.ok(preview.warnings.some((warning) => /不完整/.test(warning)));
});

test('preview aligns middle-truncated compact transcripts without false warnings', async () => {
  const fullAnswer = 'Start of a long answer.\nMiddle body that was removed in compact logs.\nEnd of the long answer.';
  const compactAnswer = 'Start of a long answer.\n<truncated 46 bytes>\nEnd of the long answer.';

  addConversation('mid-trunc-clean');
  writeTranscript('mid-trunc-clean', 'transcript_full.jsonl', [user(0, 'First'), reply(2, fullAnswer)]);
  writeTranscript('mid-trunc-clean', 'transcript.jsonl', [user(0, 'First'), reply(2, compactAnswer)]);
  const clean = await call('preview', { conversationId: 'mid-trunc-clean' });
  assert.equal(clean.source, 'transcript_full');
  assert.deepEqual(clean.messages.map(({ content }) => content), ['First', fullAnswer]);
  assert.deepEqual(clean.warnings, []);

  addConversation('mid-trunc-merge');
  writeTranscript('mid-trunc-merge', 'transcript_full.jsonl', [user(0, 'First'), reply(2, fullAnswer), '{ broken']);
  writeTranscript('mid-trunc-merge', 'transcript.jsonl', [user(0, 'First'), reply(2, compactAnswer), user(3, 'Recovered')]);
  const merged = await call('preview', { conversationId: 'mid-trunc-merge' });
  assert.equal(merged.source, 'transcript_full+transcript');
  assert.deepEqual(merged.messages.map(({ content }) => content), ['First', fullAnswer, 'Recovered']);
  assert.ok(!merged.warnings.some((warning) => /无法可靠对齐/.test(warning)));
});

test('FTS fallback identifies indexed excerpts as potentially incomplete', async () => {
  addConversation('fts');
  mkdirSync(agyDir, { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE conversations_fts (conversation_id, chunk_index, user_body, agent_body)');
  db.prepare('INSERT INTO conversations_fts VALUES (?, ?, ?, ?)').run('fts', 0, 'User excerpt', 'Agent excerpt');
  db.close();

  const preview = await call('preview', { conversationId: 'fts' });
  assert.equal(preview.source, 'fts');
  assert.deepEqual(preview.messages.map(({ content }) => content), ['User excerpt', 'Agent excerpt']);
  assert.ok(preview.warnings.some((warning) => /不完整/.test(warning)));
});

test('preview can report an unreadable index without claiming indexed content', async () => {
  addConversation('unreadable-preview');
  mkdirSync(dbFile, { recursive: true });
  try {
    const preview = await call('preview', { conversationId: 'unreadable-preview' });
    assert.equal(preview.source, 'none');
    assert.deepEqual(preview.messages, []);
    assert.ok(preview.warnings.some((warning) => /无法读取全文索引/.test(warning)));
  } finally {
    rmdirSync(dbFile);
  }
});

test('same-day exports use exclusive filenames and preserve successive snapshots', async () => {
  const id = 'exported';
  addConversation(id);
  writeTranscript(id, 'transcript_full.jsonl', [user(0, 'Earlier content')]);
  const first = await call('export', { conversationId: id, saveToDisk: true });
  writeTranscript(id, 'transcript_full.jsonl', [user(0, 'Later content')]);
  const [second, third] = await Promise.all([
    call('export', { conversationId: id, saveToDisk: true }),
    call('export', { conversationId: id, saveToDisk: true }),
  ]);

  assert.equal(new Set([first.filename, second.filename, third.filename]).size, 3);
  assert.equal(readFileSync(first.savedPath, 'utf8'), first.markdown);
  assert.equal(readFileSync(second.savedPath, 'utf8'), second.markdown);
  assert.ok(first.markdown.includes('Earlier content'));
  assert.ok(second.markdown.includes('Later content'));
});
