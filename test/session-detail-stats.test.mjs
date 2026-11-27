import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createSessionDetailStats } from '../sidecars/archive_manager/session-detail-stats.mjs';

const id = 'Synthetic';
const logsDir = `brain/${id}/.system_generated/logs`;
const full = `${logsDir}/transcript_full.jsonl`;
const compact = `${logsDir}/transcript.jsonl`;
const user = (step_index, content, created_at) => ({ type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index, content, created_at });
const planner = (fields = {}) => ({ type: 'PLANNER_RESPONSE', ...fields });
const jsonl = (...rows) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const call = (name, args = {}) => ({ name, args });
const storage = { fileCount: 17, sizeBytes: 4096, storageStatus: 'complete' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'session-detail-test-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const agy = join(root, 'agy');
  const ledger = join(agy, 'fixture.sqlite');
  await mkdir(agy);
  async function write(path, data = 'exists') {
    const target = join(agy, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    return target;
  }
  const stats = createSessionDetailStats(agy, {
    usageMonitorDbPath: ledger,
    inspectConversation: async () => storage,
  });
  return { agy, root, stats, ledger, write };
}

test('streams detail metrics, seven-category tool counts and native transcript token fallback', async t => {
  const { stats, write } = await fixture(t);
  await write(full, jsonl(
    user(0, '<USER_REQUEST>你好😀</USER_REQUEST><ADDITIONAL_METADATA>noise</ADDITIONAL_METADATA>', '2026-06-02T06:00:00Z'),
    user(0, 'duplicate'),
    user(-1, '<USER_SETTINGS_CHANGE>x</USER_SETTINGS_CHANGE>second'),
    { ...user(2, 'not explicit'), source: 'SYSTEM' },
    planner({
      content: 'answer',
      created_at: '2026-06-02T07:15:00Z',
      input_tokens: 40, cache_read_tokens: 60, output_tokens: 20, model: 'Model A',
      tool_calls: [
        call('view_file'), call('edit_file'), call('run_command'), call('search_web'),
        call('invoke_subagent'), call('call_mcp_tool', { ServerName: 'docs', ToolName: 'find' }),
        call('mcp_source_query'), call('generate_image'),
      ],
    }),
    planner({ input_tokens: 10, model: 'Model B' }),
    { type: 'ERROR_MESSAGE', created_at: '2026-06-02T07:30:00Z' },
  ));
  const result = await stats(id);
  assert.equal(result.status, 'complete');
  assert.equal(result.source, 'transcript_full');
  assert.deepEqual(result.overview, {
    userTurns: 2, assistantReplies: 1, plannerSteps: 2, errorSteps: 1,
    userChars: 9, assistantChars: 6,
    firstTimestamp: '2026-06-02T06:00:00.000Z', lastTimestamp: '2026-06-02T07:30:00.000Z',
    activeSpanMs: 5400000, ...storage,
  });
  assert.equal(result.tools.totalCalls, 8);
  assert.deepEqual(Object.fromEntries(result.tools.categories.map(({ key, count }) => [key, count])),
    { read: 1, write: 1, terminal: 1, search: 1, subagent: 1, mcp: 2, other: 1 });
  assert.ok(result.tools.byName.some(tool => tool.name === 'mcp:docs/find' && tool.category === 'mcp'));
  assert.equal(result.telemetry.source, 'transcript');
  assert.equal(result.telemetry.totalTokens, 130);
  assert.ok(Math.abs(result.telemetry.cacheHitRate - 60 / 110) < 1e-9);
  assert.equal(result.telemetry.avgTokPerSec, null);
  assert.equal(result.telemetry.thinkingTokens, null);
  assert.deepEqual(result.telemetry.models.map(model => model.name), ['Model A', 'Model B']);
});

test('prioritizes full logs and falls back to compact with partial markers for damage and oversized lines', async t => {
  const { stats, write } = await fixture(t);
  await write(full, 'invalid\n');
  await write(compact, jsonl(planner({})) + '"'.padEnd(1024 * 1024 + 1, 'x') + '\n' + jsonl(user(3, 'usable')));
  const result = await stats(id);
  assert.equal(result.status, 'partial');
  assert.equal(result.source, 'transcript');
  assert.equal(result.overview.userTurns, 1);
  assert.equal(result.telemetry.source, 'none');
  assert.ok(result.warnings.includes('detailTranscriptCompact'));
  assert.ok(result.warnings.includes('detailTranscriptLimited'));
  const damaged = jsonl(user(0, 'full')) + '{broken\n';
  await write(full, damaged);
  const recovered = await stats(id);
  assert.equal(recovered.status, 'partial');
  assert.equal(recovered.source, 'transcript_full');
  assert.equal(recovered.malformedLines, 1);
  assert.ok(recovered.warnings.includes('detailTranscriptMalformed'));
});

test('normalizes planned write paths, classifies artifacts and scratch, and checks only local files', async t => {
  const { agy, stats, write } = await fixture(t);
  const workspace = await write('workspace/file.js');
  const artifact = await write(`brain/${id}/artifact.md`);
  const scratch = join(agy, 'brain', id, 'scratch', 'script.js');
  const disposable = await write('workspace/metadata.txt');
  const editPath = process.platform === 'win32' ? workspace.replace(/file\.js$/u, 'FILE.JS') : workspace;
  await write(compact, jsonl(planner({
    tool_calls: [
      call('write_file', { Path: JSON.stringify(JSON.stringify(workspace)) }),
      call('edit_file', { file_path: editPath }),
      call('replace_file_content', { TargetFile: artifact }),
      call('apply_patch', { path: scratch }),
      call('write_to_file', { AbsolutePath: disposable, ArtifactMetadata: {} }),
      call('write_file', { path: 'relative.md' }),
      call('edit_file', { path: '\\\\network.example.invalid\\share\\file.txt' }),
    ],
  })));
  const { files } = await stats(id);
  assert.deepEqual([files.totalUnique, files.workspaceCount, files.artifactCount, files.scratchCount], [6, 3, 2, 1]);
  assert.deepEqual(files.items[0], {
    path: workspace, name: 'file.js', kind: 'workspace', writes: 1, edits: 1, totalOps: 2, exists: true,
  });
  assert.equal(files.items.find(item => item.path === artifact).kind, 'artifact');
  assert.equal(files.items.find(item => item.path === scratch).exists, false);
  assert.equal(files.items.find(item => item.path === 'relative.md').exists, null);
  assert.equal(files.items.find(item => item.name === 'file.txt').exists, null);
});

test('rejects invalid IDs and never follows linked log ancestors or output parents', async t => {
  const { agy, root, stats, write } = await fixture(t);
  const outside = join(root, 'outside');
  await mkdir(join(outside, 'logs'), { recursive: true });
  await writeFile(join(outside, 'logs', 'transcript_full.jsonl'), jsonl(user(0, 'outside')));
  await writeFile(join(outside, 'file.txt'), 'outside');
  const session = join(agy, 'brain', id);
  await mkdir(session, { recursive: true });
  await symlink(outside, join(session, '.system_generated'), 'junction');
  const result = await stats(id);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.overview.userTurns, null);
  for (const bad of ['../outside', 'nul', 'session:alternate', '']) assert.equal(await stats(bad), null);
  await rm(join(session, '.system_generated'));
  const outputLink = join(agy, 'output-link');
  await symlink(outside, outputLink, 'junction');
  await write(full, jsonl(planner({ tool_calls: [call('edit_file', { Path: join(outputLink, 'file.txt') })] })));
  assert.equal((await stats(id)).files.items[0].exists, null);
});

test('limits existence checks to the first hundred sorted paths', async t => {
  const { agy, stats, write } = await fixture(t);
  const tool_calls = Array.from({ length: 101 }, (_, i) =>
    call('write_file', { path: join(agy, String(i).padStart(3, '0') + '.txt') }));
  await write(full, jsonl(planner({ tool_calls })));
  const { files } = await stats(id);
  assert.equal(files.totalUnique, 101);
  assert.equal(files.items.filter(item => item.exists === false).length, 100);
  assert.equal(files.items[100].exists, null);
});

function writeLedger(path, { version = '1', rows = [], missingSteps = false } = {}) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE ledger_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE conversations (cascade_id TEXT PRIMARY KEY, lower_id TEXT, step_count INTEGER);
    `);
    db.prepare('INSERT INTO ledger_meta VALUES (?, ?)').run('schema_version', version);
    db.prepare('INSERT INTO conversations VALUES (?, ?, ?)').run(id, id.toLowerCase(), rows.length);
    if (!missingSteps) {
      db.exec('CREATE TABLE steps(cascade_id TEXT, pos INTEGER, accounting_json TEXT, detail_json TEXT)');
      const insert = db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)');
      rows.forEach(([accounting, detail], i) => insert.run(id, i, JSON.stringify(accounting), JSON.stringify(detail ?? {})));
    }
  } finally {
    db.close();
  }
}

function accounting(flags, model, input, cache, output, thinking, duration, ttft) {
  return [1, 0, flags, '', '', '', model, '', '', input, cache, output, thinking, output - thinking,
    duration, 0, ttft, 0, 0, 0, 0];
}

test('uses matching SQLite ledger records and aggregates weighted rates, context and models', async t => {
  const { stats, write, ledger } = await fixture(t);
  await write(full, jsonl(planner({ content: 'complete', input_tokens: 20000 })));
  writeLedger(ledger, { rows: [
    [accounting(8, 'Model A', 40, 60, 30, 20, 3, 2), { estimatedContextTokens: 120, reportedContextLimitTokens: 500 }],
    [accounting(0, 'Model B', 10, 20, 60, 0, 1, null), { contextBreakdown: { totalTokens: 200 }, reportedContextLimitTokens: 400, ttftSec: 4 }],
    [accounting(1 | 8, 'Model A', 20, 10, 10, 5, 1, null), { estimatedContextTokens: 10000 }],
    [accounting(64 | 8, 'Model A', 2, 0, 1000, 0, 1, 100), { estimatedContextTokens: 20000 }],
    [accounting(2, 'Model B', 1, 0, 2, 0, 1, null), { estimatedContextTokens: 7000, reportedContextLimitTokens: 100 }],
  ] });
  const result = await stats(id);
  const telemetry = result.telemetry;
  assert.equal(result.status, 'complete');
  assert.equal(telemetry.source, 'usage-monitor');
  assert.equal(telemetry.totalTokens, 1265);
  assert.equal(telemetry.thinkingTokens, 25);
  assert.equal(telemetry.avgTokPerSec, 10);
  assert.equal(telemetry.avgTtftSec, 3);
  assert.equal(telemetry.peakContextTokens, 200);
  assert.equal(telemetry.contextLimitTokens, 400);
  assert.equal(telemetry.peakContextRatio, 0.5);
  assert.equal(telemetry.compactionCount, 1);
  assert.equal(telemetry.revertedStepCount, 1);
  assert.deepEqual(telemetry.models.map(model => [model.name, model.steps]), [['Model A', 3], ['Model B', 2]]);
  assert.equal((await stats('different')).telemetry.source, 'none');
});

test('ledger schema mismatches, malformed tuples and database corruption fall back silently', async t => {
  const { stats, write, ledger } = await fixture(t);
  await write(full, jsonl(planner({ output_tokens: 12 })));
  async function verifyFallback() {
    const result = await stats(id);
    assert.equal(result.status, 'complete');
    assert.equal(result.telemetry.source, 'transcript');
    assert.equal(result.telemetry.totalTokens, 12);
  }
  for (const options of [{ version: '8' }, { missingSteps: true }, { rows: [[[1, 2]]] }]) {
    writeLedger(ledger, options);
    await verifyFallback();
    await rm(ledger);
  }
  await write('fixture.sqlite', 'not sqlite');
  await verifyFallback();
});
