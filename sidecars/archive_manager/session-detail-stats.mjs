import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, parse, relative, resolve, sep, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isSafeConversationId } from './conversation-stats.mjs';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 128 * MAX_LINE_BYTES;
const MAX_LEDGER_STEPS = 100000;
const MAX_CONCURRENT_SCANS = 4;
const FLAG_COMPACTION = 1;
const FLAG_IMAGE = 2;
const FLAG_SPEED_SAMPLE = 8;
const FLAG_REVERTED = 64;
const STAT_OPTIONS = { bigint: true };

const CATEGORIES = {
  read: ['read_file', 'view_file', 'view_file_outline', 'view_code_item', 'list_dir', 'list_resources', 'read_resource'],
  write: ['write_file', 'edit_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'apply_patch'],
  terminal: ['run_command', 'command_status', 'send_command_input', 'manage_task'],
  search: ['search_web', 'grep_search', 'find_by_name', 'read_url_content', 'search_marketplace'],
  subagent: ['invoke_subagent', 'define_subagent', 'send_message', 'manage_subagents', 'swarm', 'run_workflow'],
  mcp: ['call_mcp_tool'],
  other: [],
};
const CATEGORY_BY_TOOL = new Map(Object.entries(CATEGORIES).flatMap(([category, names]) =>
  names.map(name => [name, category])));
const WRITE_TOOLS = new Set(['write_file', 'write_to_file']);
const KINDS = ['workspace', 'artifact', 'scratch'];

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function countChars(content) {
  let count = 0;
  for (const char of content) count++;
  return count;
}

function cleanContent(raw) {
  if (typeof raw !== 'string') return '';
  const request = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/iu);
  const source = request?.[1] ?? raw;
  return source.replace(/<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>[\s\S]*?<\/\1>/giu, '').trim();
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function telemetryAccumulator(source) {
  const models = new Map();
  const summary = {
    source, stepCount: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0,
    thinkingTokens: null, responseTokens: null, totalTokens: 0, cacheHitRate: null,
    avgTokPerSec: null, avgTtftSec: null, peakContextTokens: null, contextLimitTokens: null,
    peakContextRatio: null, compactionCount: null, revertedStepCount: null,
  };
  return {
    summary,
    add({ input, cache, output, thinking, response, model }) {
      summary.stepCount++;
      summary.inputTokens += input ?? 0;
      summary.cacheReadTokens += cache ?? 0;
      summary.outputTokens += output ?? 0;
      if (thinking != null) summary.thinkingTokens = (summary.thinkingTokens ?? 0) + thinking;
      if (response != null) summary.responseTokens = (summary.responseTokens ?? 0) + response;
      const total = (input ?? 0) + (cache ?? 0) + (output ?? 0);
      summary.totalTokens += total;
      if (model) {
        if (!models.has(model)) models.set(model, { name: model, steps: 0, totalTokens: 0 });
        const entry = models.get(model);
        entry.steps++;
        entry.totalTokens += total;
      }
    },
    result() {
      if (!summary.stepCount) return { source: 'none' };
      const input = summary.inputTokens + summary.cacheReadTokens;
      return {
        ...summary, cacheHitRate: input > 0 ? summary.cacheReadTokens / input : null,
        models: [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name)),
      };
    },
  };
}

function unwrapArgString(raw) {
  if (typeof raw !== 'string') return '';
  let value = raw.trim();
  for (let i = 0; i < 2 && value.startsWith('"') && value.endsWith('"'); i++) {
    try {
      const unwrapped = JSON.parse(value);
      if (typeof unwrapped !== 'string') break;
      value = unwrapped.trim();
    } catch {
      break;
    }
  }
  return value.length <= 32767 && !/[\x00-\x1f\x7f"]/u.test(value) ? value : '';
}

function hasWindowsSyntax(path) {
  return /^[A-Za-z]:|^[\\/]{2}/u.test(path);
}

function classifyPath(path, session, metadata) {
  const part = relative(session, path);
  if (isAbsolute(path) && part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)) {
    const top = part.split(sep)[0].toLowerCase();
    if (top === 'scratch') return 'scratch';
    if (top !== '.system_generated') return 'artifact';
  }
  return metadata != null ? 'artifact' : 'workspace';
}

function modelName(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim().slice(0, 256);
}

function collectSteps(session) {
  let userChars = 0;
  let assistantChars = 0;
  let unindexedTurns = 0;
  let plannerSteps = 0;
  let assistantReplies = 0;
  let errorSteps = 0;
  let first = Infinity;
  let last = -Infinity;
  const userSteps = new Set();
  const categories = new Map(Object.keys(CATEGORIES).map(key => [key, 0]));
  const byName = new Map();
  const paths = new Map();
  const transcriptTelemetry = telemetryAccumulator('transcript');

  function recordTool(call) {
    if (typeof call?.name !== 'string' || !call.name.trim()) return;
    const tool = call.name.trim().slice(0, 256);
    const key = tool.toLowerCase();
    const args = record(call.args) ? call.args : {};
    const category = CATEGORY_BY_TOOL.get(key) ?? (key.startsWith('mcp_') ? 'mcp' : 'other');
    const server = modelName(args.ServerName);
    const method = modelName(args.ToolName);
    const name = key === 'call_mcp_tool' && server && method ? `mcp:${server}/${method}` : tool;
    categories.set(category, categories.get(category) + 1);
    if (!byName.has(name)) byName.set(name, { name, category, count: 0 });
    byName.get(name).count++;

    if (category !== 'write') return;
    const arg = ['Path', 'TargetFile', 'AbsolutePath', 'file_path', 'path']
      .map(key => unwrapArgString(args[key])).find(Boolean);
    if (!arg) return;
    const winSyntax = hasWindowsSyntax(arg) || process.platform === 'win32';
    const path = winSyntax ? win32.normalize(arg) : normalize(arg);
    const identity = process.platform === 'win32' ? path.toLowerCase() : path;
    const kind = classifyPath(path, session, Object.hasOwn(args, 'ArtifactMetadata') ? args.ArtifactMetadata : undefined);
    if (!paths.has(identity)) paths.set(identity, {
      path, name: (winSyntax ? win32.basename(path) : basename(path)) || path,
      kind, writes: 0, edits: 0, totalOps: 0, exists: null,
    });
    const item = paths.get(identity);
    if (item.kind === 'workspace' && kind === 'artifact') item.kind = kind;
    item[WRITE_TOOLS.has(key) ? 'writes' : 'edits']++;
    item.totalOps++;
  }

  return {
    add(step) {
      if (typeof step.created_at === 'string') {
        const time = Date.parse(step.created_at);
        if (Number.isFinite(time)) {
          first = Math.min(first, time);
          last = Math.max(last, time);
        }
      }
      if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT') {
        if (Number.isSafeInteger(step.step_index) && step.step_index >= 0) {
          if (userSteps.has(step.step_index)) return;
          userSteps.add(step.step_index);
        } else {
          unindexedTurns++;
        }
        userChars += countChars(cleanContent(step.content));
      } else if (step.type === 'ERROR_MESSAGE') {
        errorSteps++;
      } else if (step.type === 'PLANNER_RESPONSE') {
        plannerSteps++;
        const content = cleanContent(step.content);
        if (content) {
          assistantReplies++;
          assistantChars += countChars(content);
        }
        if (Array.isArray(step.tool_calls)) for (const call of step.tool_calls) recordTool(call);
        const input = numeric(step.input_tokens);
        const cache = numeric(step.cache_read_tokens);
        const output = numeric(step.output_tokens);
        if (input !== null || cache !== null || output !== null) {
          transcriptTelemetry.add({ input, cache, output, model: modelName(step.model) });
        }
      }
    },
    async result(available, storage) {
      const count = value => available ? value : null;
      const totalCalls = [...categories.values()].reduce((total, n) => total + n, 0);
      const items = [...paths.values()].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
        b.totalOps - a.totalOps || a.path.localeCompare(b.path));
      for (const item of items.slice(0, 100)) item.exists = await checkLocalFile(item.path);
      const files = { totalUnique: items.length, workspaceCount: 0, artifactCount: 0, scratchCount: 0, items };
      for (const item of items) files[item.kind + 'Count']++;
      return {
        overview: {
          userTurns: count(userSteps.size + unindexedTurns), assistantReplies: count(assistantReplies),
          plannerSteps: count(plannerSteps), errorSteps: count(errorSteps), userChars: count(userChars),
          assistantChars: count(assistantChars), firstTimestamp: first === Infinity ? null : new Date(first).toISOString(),
          lastTimestamp: last === -Infinity ? null : new Date(last).toISOString(),
          activeSpanMs: first === Infinity ? null : last - first,
          fileCount: storage?.fileCount ?? null, sizeBytes: storage?.sizeBytes ?? null,
          storageStatus: storage?.storageStatus ?? 'unavailable',
        },
        tools: {
          totalCalls,
          categories: [...categories].map(([key, count]) => ({ key, count, share: totalCalls ? count / totalCalls : 0 })),
          byName: [...byName.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        },
        files,
        telemetry: transcriptTelemetry.result(),
      };
    },
  };
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function unchangedFile(a, b) {
  return sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function readTranscript(root, id, filename, add) {
  const parents = [];
  let directory = root;
  let handle;
  let rows = 0;
  let malformed = 0;
  let limited = false;
  let interrupted = false;
  let fragments = [];
  let lineBytes = 0;

  function finishLine() {
    if (lineBytes > MAX_LINE_BYTES) {
      limited = true;
    } else if (lineBytes) {
      const text = Buffer.concat(fragments, lineBytes).toString('utf8').trim();
      if (text) {
        let step;
        try { step = JSON.parse(text); } catch {}
        if (typeof step?.type === 'string') {
          rows++;
          add(step);
        } else {
          malformed++;
        }
      }
    }
    fragments = [];
    lineBytes = 0;
  }

  try {
    for (const child of ['', 'brain', id, '.system_generated', 'logs']) {
      directory = join(directory, child);
      const stat = await lstat(directory, STAT_OPTIONS);
      if (!stat.isDirectory()) throw new Error('Invalid log directory');
      parents.push({ directory, stat });
    }
    const path = join(directory, filename);
    const stat = await lstat(path, STAT_OPTIONS);
    if (!stat.isFile()) throw new Error('Invalid transcript');
    for (const parent of parents) {
      const current = await lstat(parent.directory, STAT_OPTIONS);
      if (!current.isDirectory() || !sameFile(parent.stat, current)) throw new Error('Log path changed');
    }
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat(STAT_OPTIONS);
    if (!opened.isFile() || !unchangedFile(stat, opened)) throw new Error('Transcript changed');

    const buffer = Buffer.allocUnsafe(64 * 1024);
    const limit = Number(stat.size > BigInt(MAX_SCAN_BYTES) ? BigInt(MAX_SCAN_BYTES) : stat.size);
    let truncated = stat.size > BigInt(MAX_SCAN_BYTES);
    let position = 0;
    while (position < limit) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit - position), position);
      if (!bytesRead) {
        truncated = true;
        break;
      }
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;
      while (start < bytesRead) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? bytesRead : newline;
        lineBytes += end - start;
        if (lineBytes > MAX_LINE_BYTES) fragments = [];
        else if (end > start) fragments.push(Buffer.from(chunk.subarray(start, end)));
        if (newline >= 0) finishLine();
        start = end + 1;
      }
    }
    if (!truncated) finishLine();
    limited ||= truncated;
    interrupted = !unchangedFile(stat, await handle.stat(STAT_OPTIONS));
  } catch (error) {
    interrupted = error.code !== 'ENOENT' || Boolean(handle);
  } finally {
    await handle?.close().catch(() => { interrupted = true; });
  }
  return { rows, malformed, limited, interrupted };
}

async function checkLocalFile(path) {
  // The log can contain foreign paths, UNC shares, device paths or redirections via symlink.
  if (!isAbsolute(path) || /^[\\/]{2}/u.test(path) ||
      (process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/u.test(path) || path.slice(2).includes(':')))) {
    return null;
  }
  const root = parse(path).root;
  let current = root;
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  if (!parts.length) return false;
  try {
    for (const [index, part] of parts.entries()) {
      if (process.platform === 'win32' && /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:[. ]|$)/iu.test(part)) {
        return null;
      }
      current = join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) return null;
      if (index === parts.length - 1) return stat.isFile();
      if (!stat.isDirectory()) return false;
    }
  } catch (error) {
    return error.code === 'ENOENT' ? false : null;
  }
  return null;
}

async function readLedger(dbPath, id) {
  if (!await checkLocalFile(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;');
    const schema = db.prepare('SELECT value FROM ledger_meta WHERE key = ?').get('schema_version');
    if (schema?.value !== '1') return null;
    const matching = db.prepare('SELECT cascade_id FROM conversations WHERE lower_id = ? LIMIT 2').all(id.toLowerCase());
    if (matching.length !== 1 || matching[0].cascade_id?.toLowerCase() !== id.toLowerCase()) return null;

    const ledger = telemetryAccumulator('usage-monitor');
    const summary = ledger.summary;
    summary.compactionCount = 0;
    summary.revertedStepCount = 0;
    let duration = 0;
    let outputAtSpeed = 0;
    let ttft = 0;
    let ttftCount = 0;
    let readBytes = 0;
    const rows = db.prepare(`
      SELECT pos,
             CASE WHEN length(CAST(accounting_json AS BLOB)) <= ? THEN accounting_json END AS accounting_json,
             CASE WHEN length(CAST(detail_json AS BLOB)) <= ? THEN detail_json END AS detail_json,
             length(CAST(detail_json AS BLOB)) AS detail_bytes
      FROM steps
      WHERE cascade_id = ?
      ORDER BY pos ASC LIMIT ?
    `).iterate(MAX_LINE_BYTES, MAX_LINE_BYTES, matching[0].cascade_id, MAX_LEDGER_STEPS + 1);
    for (const { accounting_json, detail_json, detail_bytes } of rows) {
      if (typeof accounting_json !== 'string' || detail_bytes > MAX_LINE_BYTES || summary.stepCount >= MAX_LEDGER_STEPS) return null;
      readBytes += Buffer.byteLength(accounting_json) + (detail_bytes ?? 0);
      if (readBytes > MAX_SCAN_BYTES) return null;
      const a = JSON.parse(accounting_json);
      if (!Array.isArray(a) || a.length < 19) return null;
      const detail = detail_json ? JSON.parse(detail_json) : null;
      if (detail != null && !record(detail)) return null;
      const flags = Number.isSafeInteger(a[2]) ? a[2] : 0;
      const compaction = Boolean(flags & FLAG_COMPACTION);
      const reverted = Boolean(flags & FLAG_REVERTED);
      const image = Boolean(flags & FLAG_IMAGE);
      const output = numeric(a[11]);
      const input = numeric(a[9]);
      const cache = numeric(a[10]);
      ledger.add({ input, cache, output, thinking: numeric(a[12]), response: numeric(a[13]),
        model: modelName(a[6], a[4], a[3]) });
      if (compaction) summary.compactionCount++;
      if (reverted) {
        summary.revertedStepCount++;
        continue;
      }

      const seconds = numeric(a[14]);
      if ((flags & FLAG_SPEED_SAMPLE) && seconds > 0 && output > 0) {
        duration += seconds;
        outputAtSpeed += output;
      }
      const latency = numeric(a[16]) ?? numeric(detail?.ttftSec);
      if (latency > 0) {
        ttft += latency;
        ttftCount++;
      }
      if (!compaction && !image) {
        const contextLimit = numeric(detail?.reportedContextLimitTokens);
        if (contextLimit > 0) summary.contextLimitTokens = contextLimit;
        const context = numeric(detail?.contextBreakdown?.totalTokens) || numeric(detail?.estimatedContextTokens) ||
          (input ?? 0) + (cache ?? 0);
        if (context > 0) summary.peakContextTokens = Math.max(summary.peakContextTokens ?? 0, context);
      }
    }
    if (!summary.stepCount) return null;
    if (duration > 0) summary.avgTokPerSec = outputAtSpeed / duration;
    if (ttftCount > 0) summary.avgTtftSec = ttft / ttftCount;
    if (summary.peakContextTokens !== null && summary.contextLimitTokens > 0) {
      summary.peakContextRatio = summary.peakContextTokens / summary.contextLimitTokens;
    }
    return ledger.result();
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

export function createSessionDetailStats(agyDir, { inspectConversation, usageMonitorDbPath } = {}) {
  const root = resolve(agyDir);
  const dbPath = usageMonitorDbPath ?? join(root, 'sidecar_data', 'usage-monitor', 'panel', 'data', 'trajectory_store.sqlite');
  const pending = new Map();
  const queue = [];
  let running = 0;

  async function scan(id) {
    const storageRequest = Promise.resolve().then(() => inspectConversation?.(id)).catch(() => null);
    const session = join(root, 'brain', id);
    const warnings = [];
    let source = 'transcript_full';
    let steps = collectSteps(session);
    let diagnostics = await readTranscript(root, id, 'transcript_full.jsonl', steps.add);
    if (!diagnostics.rows) {
      source = 'transcript';
      steps = collectSteps(session);
      const compact = await readTranscript(root, id, 'transcript.jsonl', steps.add);
      diagnostics = { rows: compact.rows, malformed: diagnostics.malformed + compact.malformed,
        limited: diagnostics.limited || compact.limited, interrupted: diagnostics.interrupted || compact.interrupted };
      if (compact.rows) warnings.push('detailTranscriptCompact');
    }
    const available = diagnostics.rows > 0;
    if (!available) warnings.push('detailTranscriptUnavailable');
    if (diagnostics.malformed) warnings.push('detailTranscriptMalformed');
    if (diagnostics.limited || diagnostics.interrupted) warnings.push('detailTranscriptLimited');
    const storage = await storageRequest;
    if (inspectConversation && storage?.storageStatus !== 'complete') warnings.push('detailStorageUnavailable');
    const result = await steps.result(available, storage);
    const telemetry = await readLedger(dbPath, id);
    return {
      conversationId: id,
      status: !available ? 'unavailable' : warnings.length ? 'partial' : 'complete',
      source: available ? source : 'none',
      warnings,
      malformedLines: diagnostics.malformed,
      ...result,
      telemetry: telemetry ?? result.telemetry,
    };
  }

  return async id => {
    if (!isSafeConversationId(id)) return null;
    if (pending.has(id)) return pending.get(id);
    const scheduled = (async () => {
      if (running < MAX_CONCURRENT_SCANS) running++;
      else await new Promise(resume => queue.push(resume));
      try {
        return await scan(id);
      } finally {
        pending.delete(id);
        if (queue.length) queue.shift()();
        else running--;
      }
    })();
    pending.set(id, scheduled);
    return scheduled;
  };
}
