import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createConversationStats } from '../sidecars/archive_manager/conversation-stats.mjs';

const full = 'brain/synthetic/.system_generated/logs/transcript_full.jsonl';
const compact = 'brain/synthetic/.system_generated/logs/transcript.jsonl';
const user = (step_index) => ({ type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index });
const jsonl = (...steps) => steps.map((step) => JSON.stringify(step)).join('\n') + '\n';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-stats-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agy = join(root, 'agy');
  await mkdir(agy);
  async function write(path, contents) {
    const target = join(agy, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
    return Buffer.byteLength(contents);
  }
  return { agy, root, write, stats: createConversationStats(agy) };
}

test('storage counts one regular-file list across owned locations', async (t) => {
  const { stats, write } = await fixture(t);
  const included = [
    ['conversations/synthetic.db', 'abc'],
    ['conversations/synthetic.db-wal', 'defg'],
    ['annotations/synthetic.pbtxt', '你好'],
    ['brain/synthetic/note.md', 'a'],
    ['brain/synthetic/.user_uploaded/upload.txt', 'bb'],
    ['brain/synthetic/scratch/scratch.txt', 'ccc'],
    ['brain/synthetic/.system_generated/logs/debug.log', 'dddd'],
  ];
  let bytes = 0;
  for (const [path, contents] of included) bytes += await write(path, contents);
  for (const path of [
    'conversations/synthetic.pb', 'conversations/synthetic.db-shm',
    'conversation_summaries.db', 'conversations/another.db', 'workspace/synthetic.md',
    'brain/synthetic/.system_generated/steps/1/output.txt', 'brain/synthetic/project/code.js',
  ]) await write(path, 'excluded');
  assert.deepEqual(await stats('synthetic'), {
    turnCount: null, turnStatus: 'unavailable', fileCount: included.length,
    sizeBytes: bytes, storageStatus: 'complete',
  });
  assert.equal(await stats('missing'), null);
});

test('streamed logs deduplicate explicit user steps and include a final unanswered prompt', async (t) => {
  const { stats, write } = await fixture(t);
  const tool = { type: 'TOOL_CALL', step_index: 1 };
  await write(full, jsonl(user(0), tool, { ...tool, step_index: 2 }, user(4)));
  await write(compact, jsonl(user(0), tool, { ...user(3), source: 'SYSTEM' }, user(4)));
  const result = await stats('synthetic');
  assert.equal(result.turnCount, 2);
  assert.equal(result.turnStatus, 'complete');
});

test('damaged full logs produce a lower bound using readable compact steps', async (t) => {
  const { stats, write } = await fixture(t);
  await write(full, jsonl(user(0)) + '{incomplete\n');
  await write(compact, jsonl(user(0), user(3)));
  const result = await stats('synthetic');
  assert.equal(result.turnCount, 2);
  assert.equal(result.turnStatus, 'partial');
});

test('compact-only logs give a lower bound and wholly unreadable logs give no count', async (t) => {
  const { stats, write } = await fixture(t);
  await write(compact, jsonl(user(0)));
  assert.equal((await stats('synthetic')).turnStatus, 'partial');
  await write(compact, 'broken');
  const result = await stats('synthetic');
  assert.equal(result.turnCount, null);
  assert.equal(result.turnStatus, 'unavailable');
});

test('caches revalidate changed transcripts and storage files on each request', async (t) => {
  const { agy, stats, write } = await fixture(t);
  const initialSize = await write(full, jsonl(user(0)));
  assert.equal((await stats('synthetic')).sizeBytes, initialSize);
  const path = 'brain/synthetic/scratch/item.txt';
  await write(path, 'short');
  assert.equal((await stats('synthetic')).sizeBytes, initialSize + 5);
  await write(path, 'longer text');
  assert.equal((await stats('synthetic')).sizeBytes, initialSize + 11);
  await rm(join(agy, path));
  const nextSize = await write(full, jsonl(user(0), user(1)));
  const result = await stats('synthetic');
  assert.equal(result.fileCount, 1);
  assert.equal(result.sizeBytes, nextSize);
  assert.equal(result.turnCount, 2);
  await rm(join(agy, full));
  assert.equal((await stats('synthetic')).turnCount, null);
});

test('rewriting a transcript without changing its byte count invalidates cached turns', async (t) => {
  const { agy, stats, write } = await fixture(t);
  const before = await write(full, jsonl(user(0)));
  await utimes(join(agy, full), 1, 1);
  assert.equal((await stats('synthetic')).turnCount, 1);
  const step = { ...user(0), source: 'BACKEND' };
  const after = await write(full, jsonl(step).trimEnd().padEnd(before - 1) + '\n');
  await utimes(join(agy, full), 2, 2);
  assert.equal(after, before);
  assert.equal((await stats('synthetic')).turnCount, 0);
});

test('overlapping requests finish across several scheduled scan slots', async (t) => {
  const { stats, write } = await fixture(t);
  const ids = Array.from({ length: 12 }, (_, i) => `session-${i}`);
  for (const [i, id] of ids.entries()) {
    await write(`conversations/${id}.pb`, 'x'.repeat(i));
  }
  const pending = ids.flatMap((id) => [stats(id), stats(id)]);
  const results = await Promise.all(pending);
  assert.deepEqual(results.map((result) => result.sizeBytes), ids.flatMap((_, i) => [i, i]));
});

test('invalid IDs and linked paths do not expose files outside the session', async (t) => {
  const { agy, root, stats, write } = await fixture(t);
  const external = join(root, 'external');
  await mkdir(join(external, 'logs'), { recursive: true });
  await writeFile(join(external, 'logs', 'transcript_full.jsonl'), jsonl(user(0)));
  await write('conversations/synthetic.pb', 'old');
  await mkdir(join(agy, 'brain', 'synthetic'), { recursive: true });
  await symlink(external, join(agy, 'brain', 'synthetic', '.system_generated'), 'junction');
  assert.equal(await stats('../external'), null);
  assert.equal(await stats('external:stream'), null);
  assert.deepEqual(await stats('synthetic'), {
    turnCount: null, turnStatus: 'unavailable', fileCount: 1,
    sizeBytes: 3, storageStatus: 'partial',
  });
});

test('an oversized transcript line does not hide subsequent readable prompts', async (t) => {
  const { stats, write } = await fixture(t);
  await write(full, jsonl({ type: 'TOOL_CALL', content: 'x'.repeat(2 * 1024 * 1024) }, user(7)));
  const result = await stats('synthetic');
  assert.equal(result.turnCount, 1);
  assert.equal(result.turnStatus, 'partial');
});
