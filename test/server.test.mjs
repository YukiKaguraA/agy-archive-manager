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
const preferencesFile = join(dataDir, 'preferences.json');
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
let deleteReply;
let getReply;

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
  if (method === 'GetConversation' && getReply) return getReply(input.conversationId);
  if (method === 'GetConversation') return conv ? Response.json(conv.topLevel ? conv : { conversation: conv }) : Response.json({ code: 'not_found' }, { status: 404 });
  if (method === 'UpdateConversation') {
    if (!ignoredUpdates.has(input.conversationId)) Object.assign(conv.annotations, input.annotations);
    afterUpdate?.(input.conversationId);
    if (sparseUpdates.has(input.conversationId)) {
      return Response.json({ conversation: { id: conv.id, state: conv.state } });
    }
    return Response.json(conv);
  }
  if (method === 'DeleteConversation') {
    if (deleteReply) return deleteReply(input.conversationId);
    conversations.delete(input.conversationId);
  }
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
  deleteReply = null;
  getReply = null;
  invalidations = 0;
  for (const file of [metaFile, preferencesFile, dbFile, join(dataDir, 'meta.json.tmp')]) {
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

test('language preference persists in a separate file and rejects unsupported values', async () => {
  const existingNotes = JSON.stringify({ conversations: { 'note-id': { note: '保留备注' } } });
  writeFileSync(metaFile, existingNotes);
  assert.deepEqual(await call('preferences', { locale: 'en' }), { language: null });
  assert.equal(existsSync(preferencesFile), false);

  assert.deepEqual(await call('preferences', { language: 'en' }), { language: 'en' });
  assert.deepEqual(JSON.parse(readFileSync(preferencesFile, 'utf8')), { language: 'en' });
  assert.deepEqual(await call('preferences', { locale: 'zh-CN' }), { language: 'en' });
  for (const language of ['fr', 'EN', null, 1, ['en']]) {
    await assert.rejects(call('preferences', { locale: 'en', language }), /Unsupported language/);
  }
  assert.deepEqual(await call('preferences', {}), { language: 'en' });
  assert.deepEqual(await call('preferences', { locale: 'en', language: 'zh-CN' }), { language: 'zh-CN' });
  assert.deepEqual(JSON.parse(readFileSync(preferencesFile, 'utf8')), { language: 'zh-CN' });
  assert.equal(readFileSync(metaFile, 'utf8'), existingNotes);
  assert.deepEqual(readdirSync(dataDir).sort(), ['meta.json', 'preferences.json']);
});

test('invalid preference data stays on disk until a valid language is saved', async () => {
  const invalid = '{"language":"invalid"}';
  writeFileSync(preferencesFile, invalid);
  await assert.rejects(call('preferences', { locale: 'en' }), /Invalid language preferences.*preferences\.json/);
  assert.equal(readFileSync(preferencesFile, 'utf8'), invalid);
  assert.deepEqual(await call('preferences', { language: 'en' }), { language: 'en' });
  assert.deepEqual(await call('preferences', {}), { language: 'en' });
});

test('concurrent requests keep independent languages in archive and delete safety errors', async () => {
  addConversation('running', { runState: 'RUN_STATE_RUNNING' });
  addConversation('pinned', { pinned: true });
  addConversation('upstream-error');
  failures.add('UpdateConversation:upstream-error');

  const archive = { conversationIds: ['pinned', 'upstream-error'], archived: true, staleDays: 7 };
  const [english, chinese] = await Promise.all([
    call('set-archived', { ...archive, locale: 'en' }),
    call('set-archived', { ...archive, locale: 'zh-CN' }),
    assert.rejects(call('delete', { conversationId: 'running', locale: 'en' }), /Stop it before deleting/),
    assert.rejects(call('delete', { conversationId: 'running' }), /请先停止后再删除/),
  ]);
  assert.deepEqual(english.failed, [
    { id: 'pinned', error: 'The conversation is pinned' },
    { id: 'upstream-error', error: 'ConversationService.UpdateConversation failed: request rejected' },
  ]);
  assert.deepEqual(chinese.failed, [
    { id: 'pinned', error: '会话已置顶' },
    { id: 'upstream-error', error: 'ConversationService.UpdateConversation 失败: request rejected' },
  ]);
  assert.deepEqual(mutationIds('DeleteConversation'), []);
});

test('project labels and fallback titles follow the request without changing project filter values', async () => {
  addConversation('outside');
  delete conversations.get('outside').annotations.title;
  addConversation('named');
  conversations.get('named').annotations.title = '未命名会话';
  conversations.get('named').metadata.projectId = '实际项目';

  const [english, chinese] = await Promise.all([
    call('conversations', { tab: 'all', locale: 'en' }),
    call('conversations', { tab: 'all', locale: 'unsupported' }),
  ]);
  assert.deepEqual(new Set(english.projects), new Set(chinese.projects));
  assert.deepEqual(english.projects, ['未归属项目', '实际项目']);
  assert.deepEqual(chinese.projects, ['实际项目', '未归属项目']);
  assert.equal(english.projectLabels['未归属项目'], 'No project');
  assert.equal(chinese.projectLabels['未归属项目'], '未归属项目');
  const outside = english.items.find(({ id }) => id === 'outside');
  assert.equal(outside.project, '未归属项目');
  assert.equal(outside.projectLabel, 'No project');
  assert.equal(outside.title, 'Untitled conversation');
  const named = english.items.find(({ id }) => id === 'named');
  assert.equal(named.projectLabel, '实际项目');
  assert.equal(named.title, '未命名会话');
  for (const query of ['未归属项目', 'no project']) {
    const result = await call('conversations', { tab: 'all', locale: 'en', project: outside.project, query });
    assert.deepEqual(result.items.map(({ id }) => id), ['outside']);
  }
});

test('title and tag sorting follow the requested language', async () => {
  addConversation('alpha');
  conversations.get('alpha').annotations.tags = ['Alpha'];
  addConversation('china');
  Object.assign(conversations.get('china').annotations, { title: '中国', tags: ['中国'] });

  const [english, chinese] = await Promise.all([
    call('conversations', { tab: 'all', sort: 'title', locale: 'en' }),
    call('conversations', { tab: 'all', sort: 'title' }),
  ]);
  assert.deepEqual(english.items.map(({ id }) => id), ['alpha', 'china']);
  assert.deepEqual(chinese.items.map(({ id }) => id), ['china', 'alpha']);
  assert.deepEqual(english.allTags, ['Alpha', '中国']);
  assert.deepEqual(chinese.allTags, ['中国', 'Alpha']);
});

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

test('English export translates its labels and warnings while preserving saved Chinese snapshots', async () => {
  const id = 'bilingual-export';
  addConversation(id, { archived: true, pinned: true, starred: true });
  conversations.get(id).annotations.title = '保留标题';
  writeFileSync(metaFile, JSON.stringify({ conversations: { [id]: { tags: ['测试标签'], note: '用户备注' } } }));
  writeTranscript(id, 'transcript.jsonl', [user(0, '保留用户消息'), reply(1, '保留助手回答'), '{ broken']);

  const chinese = await call('export', { conversationId: id, saveToDisk: true });
  const english = await call('export', { conversationId: id, locale: 'en', saveToDisk: true });

  assert.match(chinese.markdown, /\*\*所属项目\*\*: 未归属项目/);
  for (const phrase of [
    '**Project**: No project', '**Archive status**: Archived', '**Pin status**: Pinned',
    '**Star status**: Starred', '**Last updated**:', '**Tags**: #测试标签', '**Note**: 用户备注',
    '**Transcript source**: `transcript`', '**Warning**: This transcript is from the compact log and may be incomplete',
    '**Warning**: Could not parse 1 line in transcript.jsonl. The transcript may be incomplete',
    '# 保留标题', '## 👤 User', '保留用户消息', '## 🤖 Assistant', '保留助手回答',
  ]) {
    assert.ok(english.markdown.includes(phrase), phrase);
  }
  assert.notEqual(english.filename, chinese.filename);
  assert.equal(readFileSync(chinese.savedPath, 'utf8'), chinese.markdown);
  assert.equal(readFileSync(english.savedPath, 'utf8'), english.markdown);
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

test('snapshot pages reuse native listing, deterministic ties and full filtered stale IDs', async () => {
  for (let n = 66; n >= 0; n--) {
    const id = String(n).padStart(3, '0');
    addConversation(id);
    conversations.get(id).state.updateTime = '2020-03-01T00:00:00Z';
    conversations.get(id).annotations.tags = n < 61 ? ['filter'] : ['excluded'];
  }
  const input = { tab: 'stale', locale: 'en', tag: 'filter', page: 1 };
  const first = await call('conversations', input);
  assert.equal(first.items.length, 50);
  assert.equal(first.pageSize, 50);
  assert.equal(first.total, 61);
  assert.equal(first.items[0].id, '000');
  assert.equal(first.matchingIds, undefined);
  assert.deepEqual(first.allTags, ['excluded', 'filter']);
  const second = await call('conversations', { ...input, page: 2, snapshotId: first.snapshotId, includeMatchingIds: true });
  assert.equal(second.items[0].id, '050');
  assert.equal(second.snapshotId, first.snapshotId);
  assert.equal(second.matchingIds.length, 61);
  assert.equal(second.counts.all, 67);
  assert.equal(mutationIds('ListConversations').length, 1);
  const chinese = await call('conversations', { ...input, snapshotId: first.snapshotId, locale: 'zh-CN' });
  assert.notEqual(chinese.snapshotId, first.snapshotId);
  await call('meta/update', { conversationId: '010', note: 'changed' });
  const changed = await call('conversations', { ...input, snapshotId: first.snapshotId });
  assert.notEqual(changed.snapshotId, first.snapshotId);
  const refreshed = await call('conversations', { ...input, refresh: true, snapshotId: changed.snapshotId });
  assert.notEqual(refreshed.snapshotId, changed.snapshotId);
  assert.equal((await call('conversations', { tab: 'all' })).items.length, 67);
});

test('stable project keys distinguish duplicate names and raw group IDs filter independently', async () => {
  const dir = join(home, '.gemini', 'config', 'projects');
  mkdirSync(dir, { recursive: true });
  for (const id of ['p1', 'p2']) {
    writeFileSync(join(dir, id + '.json'), JSON.stringify({ id, name: 'shared' }));
    addConversation(id);
    conversations.get(id).metadata.projectId = id;
    conversations.get(id).annotations.groupId = 'engineering';
  }
  mkdirSync(agyDir, { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE conversation_summaries (conversation_id, step_count, workspace_uris, preview)');
  const put = db.prepare('INSERT INTO conversation_summaries VALUES (?,0,?,?)');
  for (const path of ['file:///a/shared', 'file:///b/shared']) {
    addConversation(path);
    put.run(path, JSON.stringify([path]), '');
  }
  db.close();
  addConversation('outside');
  const data = { tab: 'all', page: 1, locale: 'en' };
  const result = await call('conversations', data);
  assert.deepEqual(new Set(result.projectOptions.map(x => x.key)), new Set(['project:p1','project:p2','workspace:file:///a/shared','workspace:file:///b/shared','unassigned']));
  assert.equal(new Set(result.projectOptions.map(x => x.label)).size, 5);
  assert.deepEqual(new Set(result.groupOptions.map(x => x.key)), new Set(['group:engineering','ungrouped']));
  const filtered = await call('conversations', { ...data, snapshotId: result.snapshotId, groupKey: 'group:engineering', projectKey: 'project:p1' });
  assert.deepEqual(filtered.items.map(x => x.groupId), ['engineering']);
  assert.deepEqual(filtered.items.map(x => x.id), ['p1']);
  assert.equal((await call('conversations', { ...data, project: 'shared' })).items.length, 4);
});

test('preview and export target one native conversation even if enumeration fails', async () => {
  addConversation('single');
  failures.add('ListConversations:');
  assert.equal((await call('preview', { conversationId: 'single' })).id, 'single');
  assert.match((await call('export', { conversationId: 'single' })).markdown, /single/);
  assert.equal(mutationIds('ListConversations').length, 0);
  assert.deepEqual(mutationIds('GetConversation'), ['single', 'single']);
});

test('literal and keyword body searches combine metadata and chunks with fixed candidates', async () => {
  mkdirSync(agyDir, { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id UNINDEXED, chunk_index UNINDEXED, title, user_body, agent_body)');
  const add = db.prepare('INSERT INTO conversations_fts VALUES (?, ?, ?, ?, ?)');
  for (const id of ['hit','decoy','outside']) {
    addConversation(id, { archived: id !== 'outside' });
    conversations.get(id).annotations.groupId = 'blueprint';
  }
  add.run('hit', 0, '', '结构计算std::vector<T> apple', '');
  add.run('hit', 1, '', '', 'orange');
  add.run('decoy', 0, '', 'apple', '');
  add.run('outside', 0, '', 'apple orange', '');
  db.close();
  const search = async (query, searchMode) => (await call('conversations', { tab: 'archived', query, searchMode })).items.map(x => x.id);
  assert.deepEqual(await search('构计', 'literal'), ['hit']);
  assert.deepEqual(await search('d::vector<', 'literal'), ['hit']);
  assert.deepEqual(await search('blueprint apple orange', 'keywords'), ['hit']);
  assert.deepEqual(await search('orange apple', 'literal'), []);
  assert.deepEqual(await search('" OR *', 'keywords'), []);
  assert.deepEqual(await search('blueprint', 'literal'), ['decoy','hit'].sort((a,b) => {
    const time = id => Date.parse(conversations.get(id).state.updateTime);
    return time(b)-time(a) || a.localeCompare(b);
  }));
  rmSync(dbFile);
  assert.deepEqual(new Set(await search('blueprint', 'keywords')), new Set(['decoy','hit']));
});

test('tag reconciliation preserves notes and local override until a native read verifies changes', async () => {
  addConversation('tagged');
  conversations.get('tagged').annotations.tags = ['host'];
  writeFileSync(metaFile, JSON.stringify({ conversations: { tagged: { tags: ['local'], note: 'preserved', extra: 3 } } }));
  const list = async () => (await call('conversations', { tab: 'all' })).items[0];
  assert.equal((await list()).tagConflict, true);
  assert.deepEqual((await list()).nativeTags, ['host']);
  ignoredUpdates.add('tagged');
  await assert.rejects(call('meta/update', { conversationId: 'tagged', tagResolution: 'local' }));
  assert.equal((await list()).tagConflict, true);
  ignoredUpdates.clear();
  await call('meta/update', { conversationId: 'tagged', tagResolution: 'local' });
  assert.deepEqual(conversations.get('tagged').annotations.tags, ['local']);
  assert.deepEqual(JSON.parse(readFileSync(metaFile)).conversations.tagged, { note: 'preserved', extra: 3 });
  await call('meta/update', { conversationId: 'tagged', tags: [] });
  assert.deepEqual(conversations.get('tagged').annotations.tags, []);
  writeFileSync(metaFile, JSON.stringify({ conversations: { tagged: { tags: ['old'], note: 'keep' } } }));
  const writes = mutationIds('UpdateConversation').length;
  const resolved = await call('meta/update', { conversationId: 'tagged', tagResolution: 'native' });
  assert.equal(mutationIds('UpdateConversation').length, writes);
  assert.deepEqual(resolved.meta, { tags: [], nativeTags: [], tagConflict: false, note: 'keep' });
  assert.equal((await list()).tagConflict, false);
});

test('batch deletion rechecks each archived ordinary idle ID and distinguishes uncertain replies', async () => {
  for (const id of ['a','changed','remains','ambiguous','lost-reply','child']) addConversation(id, { archived: true });
  conversations.get('child').metadata.parentConversationId = 'a';
  addConversation('active');
  deleteReply = id => {
    if (id === 'a') conversations.get('changed').state.runState = 'RUN_STATE_RUNNING';
    if (id !== 'remains') conversations.delete(id);
    if (id === 'ambiguous') failures.add('GetConversation:ambiguous');
    return id === 'lost-reply' || id === 'remains' ? Response.json({message:'lost'}, {status:500}) : Response.json({});
  };
  const result = await call('delete-batch', {conversationIds:['a','missing','changed','active','child','remains','ambiguous','lost-reply','a']});
  assert.deepEqual(result.deleted, ['a','lost-reply']);
  assert.deepEqual(result.skipped.map(x => x.code), ['already_gone','running','not_archived','subagent']);
  assert.deepEqual(result.failed.map(x => [x.id,x.code,x.retryable]), [['remains','delete_failed',true],['ambiguous','unknown_outcome',false]]);
  assert.ok(result.warnings.length);
  assert.deepEqual(mutationIds('DeleteConversation'), ['a','remains','ambiguous','lost-reply']);
  await assert.rejects(call('delete-batch', { tab: 'archived' }));
});

test('a newer request can interrupt a running literal scan for just its panel', async () => {
  mkdirSync(agyDir, { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE conversations_fts(conversation_id, title, user_body, agent_body)');
  const insert = db.prepare('INSERT INTO conversations_fts VALUES (?,?,?,?)');
  addConversation('scan');
  db.exec('BEGIN');
  for (let i=0; i<2000; i++) insert.run('scan', '', 'a'.repeat(100), '');
  db.exec('COMMIT');
  db.close();
  const data = { tab:'all', page:1 };
  const initial = await call('conversations', data);
  const current = { ...data, snapshotId: initial.snapshotId, searchClientId:'first' };
  const old = call('conversations', {...current, query:'absent', searchSequence:1});
  await new Promise(resolve => setImmediate(resolve));
  const fresh = call('conversations', {...current, query:'scan', searchSequence:2});
  assert.equal((await old).cancelled,true);
  assert.deepEqual((await fresh).items.map(x=>x.id), ['scan']);
  const late = await call('conversations', {...current, query:'late', searchSequence:1});
  assert.equal(late.cancelled,true);
});

test('host group annotation and optional group_id index fallback survive legacy summary schemas', async () => {
  mkdirSync(agyDir, { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE conversation_summaries (conversation_id, step_count, workspace_uris, preview, group_id)');
  for (const id of ['annotated','indexed']) {
    addConversation(id);
    db.prepare('INSERT INTO conversation_summaries VALUES (?, 7, NULL, NULL, ?)').run(id, 'old-group');
  }
  db.close();
  conversations.get('annotated').annotations.conversationGroupId = 'new-group';
  const result = await call('conversations', { tab:'all', groupKey:'group:old-group' });
  assert.deepEqual(result.items.map(item => item.id), ['indexed']);
  const preview = await call('preview', { conversationId:'annotated' });
  assert.equal(preview.groupId,'new-group');
  assert.equal(preview.stepCount,7);
});

test('literal search preserves body snippets on metadata hits, without matching reserved filter keys', async () => {
  addConversation('searchable');
  conversations.get('searchable').annotations.title = 'A label';
  mkdirSync(agyDir, { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE conversations_fts(conversation_id, title, user_body, agent_body)');
  db.prepare('INSERT INTO conversations_fts VALUES(?,?,?,?)').run('searchable','','the label in the body','');
  db.close();
  const result = await call('conversations', { tab:'all', query:'label' });
  assert.match(result.items[0].matchSnippet,/in the body/);
  assert.deepEqual((await call('conversations', { tab:'all', query:'unassigned' })).items, []);
});

test('native tag display preserves both annotation and legacy metadata tags', async () => {
  addConversation('two-sources');
  conversations.get('two-sources').annotations.tags = ['annotation'];
  conversations.get('two-sources').metadata.tags = ['metadata','annotation'];
  assert.deepEqual((await call('conversations', { tab:'all' })).items[0].nativeTags, ['annotation','metadata']);
});

test('generic HTTP 404 and a malformed success response do not confirm a deletion', async () => {
  for (const id of ['route-404','malformed-reply']) addConversation(id,{archived:true});
  const seen = new Set();
  getReply = id => {
    if (seen.has(id)) {
      return id === 'route-404' ? Response.json({}, { status:404 }) : Response.json({ id });
    }
    seen.add(id);
    return Response.json(conversations.get(id));
  };
  writeFileSync(metaFile,JSON.stringify({ conversations:{ 'route-404':{note:'keep'}, 'malformed-reply':{note:'keep'} } }));
  const result = await call('delete-batch',{conversationIds:[...conversations.keys()]});
  assert.deepEqual(result.deleted,[]);
  assert.deepEqual(result.failed.map(entry=>entry.code),['unknown_outcome','unknown_outcome']);
  assert.equal(Object.keys(JSON.parse(readFileSync(metaFile)).conversations).length,2);
});

test('accept host tags rejects sparse and malformed readbacks without dropping a local override', async () => {
  addConversation('unsafe-tag');
  const store = JSON.stringify({ conversations:{ 'unsafe-tag': { tags:[], note:'keep' } } });
  for (const reply of [
    {id:'unsafe-tag',annotations:{}},
    {id:'unsafe-tag',state:{},annotations:{}},
    {id:'unsafe-tag',state:{runState:'RUN_STATE_IDLE'},metadata:{tags:[42]}},
    {id:'unsafe-tag',state:{runState:'RUN_STATE_IDLE'},annotations:[],metadata:{tags:[]}},
  ]) {
    writeFileSync(metaFile,store);
    getReply = () => Response.json(reply);
    await assert.rejects(call('meta/update',{conversationId:'unsafe-tag',tagResolution:'native'}));
    assert.equal(readFileSync(metaFile,'utf8'),store);
  }
});

test('top-level ID-less targeted replies still support legacy preview, export and single delete', async () => {
  addConversation('legacy-shape');
  const native = {annotations:{title:'Legacy title'}, metadata:{}, state:{runState:'RUN_STATE_IDLE'}};
  getReply = id => conversations.has(id) ? Response.json(native) : Response.json({code:'not_found'},{status:404});
  const preview = await call('preview',{conversationId:'legacy-shape'});
  assert.equal(preview.id,'legacy-shape');
  assert.equal(preview.title,'Legacy title');
  assert.match((await call('export',{conversationId:'legacy-shape'})).markdown,/legacy-shape/);
  assert.equal((await call('delete',{conversationId:'legacy-shape'})).deletedId,'legacy-shape');
  assert.deepEqual(mutationIds('DeleteConversation'),['legacy-shape']);
});

test('keyword search falls back to streamed chunks when the FTS5 index lacks column query support', async () => {
  mkdirSync(agyDir, { recursive: true });
  addConversation('reduced-index');
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id UNINDEXED, title, user_body, agent_body, detail=none)");
  const add = db.prepare('INSERT INTO conversations_fts VALUES(?,?,?,?)');
  add.run('reduced-index','','apple','');
  add.run('reduced-index','','','orange');
  db.close();
  const result = await call('conversations',{tab:'all',query:'apple orange',searchMode:'keywords',locale:'en'});
  assert.deepEqual(result.items.map(item=>item.id),['reduced-index']);
  assert.ok(result.warnings.some(warning=>warning.includes('Keyword indexing')));
});

test('a malformed edit cannot silently clear native tags', async () => {
  addConversation('typed');
  conversations.get('typed').annotations.tags = ['keep'];
  for (const tags of [[123], 'tag']) {
    await assert.rejects(call('meta/update',{conversationId:'typed',tags}));
  }
  assert.deepEqual(mutationIds('UpdateConversation'),[]);
  assert.deepEqual(conversations.get('typed').annotations.tags,['keep']);
});
