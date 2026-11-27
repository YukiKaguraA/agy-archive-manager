import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
export function isSafeConversationId(id) {
  return typeof id === 'string' && SAFE_ID.test(id) && !WINDOWS_DEVICE.test(id);
}
const FULL_LOG = 'transcript_full.jsonl';
const COMPACT_LOG = 'transcript.jsonl';
const MAX_CACHED_TURNS = 2048;
const MAX_CONCURRENT_SCANS = 4;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_LOG_BYTES = 128 * 1024 * 1024;
const STAT_OPTIONS = { bigint: true };

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

async function inspect(path, type, onFailure, expected = false) {
  try {
    const stat = await lstat(path, STAT_OPTIONS);
    if (type === 'file' ? stat.isFile() : stat.isDirectory()) return { path, stat };
    onFailure();
  } catch (error) {
    if (expected || error.code !== 'ENOENT') onFailure();
  }
  return null;
}

async function inventory(root, id) {
  const logs = new Map();
  let fileCount = 0;
  let sizeBytes = 0n;
  let found = false;
  let interrupted = false;
  let logsInterrupted = false;
  const failed = () => { interrupted = true; };
  const logsFailed = () => { failed(); logsInterrupted = true; };
  const add = (file) => {
    if (file) {
      found = true;
      fileCount++;
      sizeBytes += file.stat.size;
    }
  };
  const child = (parent, name, type, onFailure = failed) =>
    parent && inspect(join(parent.path, name), type, onFailure);

  async function list(directory, onFailure = failed, collectLogs = false) {
    if (!directory) return;
    try {
      const entries = await opendir(directory.path);
      for await (const entry of entries) {
        if (entry.isDirectory()) continue;
        const transcript = collectLogs && (entry.name === FULL_LOG || entry.name === COMPACT_LOG);
        if (!entry.isFile() && !transcript) continue;
        const file = await inspect(join(directory.path, entry.name), 'file', onFailure, true);
        add(file);
        if (transcript && file) logs.set(entry.name, file);
      }
    } catch {
      onFailure();
    }
  }

  const base = await inspect(root, 'directory', logsFailed);
  const conversations = await child(base, 'conversations', 'directory');
  const database = await child(conversations, `${id}.db`, 'file');
  if (database) {
    add(database);
    add(await child(conversations, `${id}.db-wal`, 'file'));
  } else {
    add(await child(conversations, `${id}.pb`, 'file'));
  }
  const annotations = await child(base, 'annotations', 'directory');
  add(await child(annotations, `${id}.pbtxt`, 'file'));
  const brain = await child(base, 'brain', 'directory', logsFailed);
  const session = await child(brain, id, 'directory', logsFailed);
  if (session) found = true;
  await list(session);
  await list(await child(session, '.user_uploaded', 'directory'));
  await list(await child(session, 'scratch', 'directory'));
  const generated = await child(session, '.system_generated', 'directory', logsFailed);
  const logDirectory = await child(generated, 'logs', 'directory', logsFailed);
  await list(logDirectory, logsFailed, true);

  return {
    found, interrupted, fileCount, sizeBytes, logs, logsInterrupted,
    logParents: [base, brain, session, generated, logDirectory].filter(Boolean),
  };
}

async function readLog(file, parents, userSteps) {
  let handle;
  let readable = false;
  let hasUser = false;
  let incomplete = false;
  let retryable = false;
  let fragments = [];
  let lineBytes = 0;

  function finishLine() {
    if (lineBytes > MAX_LINE_BYTES) {
      incomplete = true;
    } else if (lineBytes) {
      const line = Buffer.concat(fragments, lineBytes).toString('utf8').trim();
      if (line) {
        try {
          const step = JSON.parse(line);
          if (typeof step?.type !== 'string') throw new Error('Invalid transcript step');
          readable = true;
          if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT') {
            hasUser = true;
            if (Number.isSafeInteger(step.step_index) && step.step_index >= 0) {
              userSteps.add(step.step_index);
            } else {
              incomplete = true;
            }
          }
        } catch {
          incomplete = true;
        }
      }
    }
    fragments = [];
    lineBytes = 0;
  }

  try {
    for (const parent of parents) {
      const stat = await lstat(parent.path, STAT_OPTIONS);
      if (!stat.isDirectory() || stat.dev !== parent.stat.dev || stat.ino !== parent.stat.ino) {
        throw new Error('Log directory changed');
      }
    }
    const expected = fingerprint(file.stat);
    const current = await lstat(file.path, STAT_OPTIONS);
    if (!current.isFile() || fingerprint(current) !== expected) throw new Error('Log changed');
    handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat(STAT_OPTIONS);
    if (!opened.isFile() || fingerprint(opened) !== expected) throw new Error('Log changed');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const limit = Number(file.stat.size > BigInt(MAX_LOG_BYTES) ? BigInt(MAX_LOG_BYTES) : file.stat.size);
    let skippedTail = file.stat.size > BigInt(MAX_LOG_BYTES);
    let position = 0;
    while (position < limit) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit - position), position);
      if (!bytesRead) {
        skippedTail = true;
        break;
      }
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;
      while (start < bytesRead) {
        const newline = chunk.indexOf(10, start);
        const end = newline === -1 ? bytesRead : newline;
        lineBytes += end - start;
        if (lineBytes <= MAX_LINE_BYTES) {
          if (start !== end) fragments.push(Buffer.from(chunk.subarray(start, end)));
        } else {
          fragments = [];
        }
        if (newline !== -1) finishLine();
        start = end + 1;
      }
    }
    if (!skippedTail) finishLine();
    incomplete ||= skippedTail;
    retryable = fingerprint(await handle.stat(STAT_OPTIONS)) !== expected;
  } catch {
    retryable = true;
  } finally {
    await handle?.close().catch(() => { retryable = true; });
  }
  return { readable, hasUser, incomplete: incomplete || retryable, retryable };
}

export function createConversationStats(agyDir) {
  const root = resolve(agyDir);
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let running = 0;

  async function scan(id) {
    const snapshot = await inventory(root, id);
    const { found, interrupted, fileCount, sizeBytes, logs, logsInterrupted, logParents } = snapshot;
    if (!found && !interrupted) return null;
    const fullFile = logs.get(FULL_LOG);
    const compactFile = logs.get(COMPACT_LOG);
    const signature = [fullFile, compactFile].map((file) => file && fingerprint(file.stat)).join('|');
    const hit = cache.get(id);
    cache.delete(id);
    let turns;
    if (!logsInterrupted && hit?.signature === signature) {
      cache.set(id, hit);
      turns = hit.turns;
    } else {
      const userSteps = new Set();
      const full = fullFile && await readLog(fullFile, logParents, userSteps);
      const fullCount = userSteps.size;
      const compact = compactFile && await readLog(compactFile, logParents, userSteps);
      const count = Math.max(userSteps.size, Number(Boolean(full?.hasUser || compact?.hasUser)));
      const complete = full?.readable && !full.incomplete && !compact?.incomplete &&
        !logsInterrupted && userSteps.size === fullCount;
      turns = complete ? { turnCount: count, turnStatus: 'complete' }
        : count ? { turnCount: count, turnStatus: 'partial' }
          : { turnCount: null, turnStatus: 'unavailable' };
      if (!logsInterrupted && !full?.retryable && !compact?.retryable && (fullFile || compactFile)) {
        cache.set(id, { signature, turns });
        if (cache.size > MAX_CACHED_TURNS) cache.delete(cache.keys().next().value);
      }
    }

    const hasStorage = fileCount > 0 || (found && !interrupted);
    return {
      ...turns,
      fileCount: hasStorage ? fileCount : null,
      sizeBytes: hasStorage ? Number(sizeBytes) : null,
      storageStatus: interrupted ? 'partial' : 'complete',
    };
  }

  return async (id) => {
    if (!isSafeConversationId(id)) return null;
    if (pending.has(id)) return pending.get(id);
    const scheduled = (async () => {
      if (running < MAX_CONCURRENT_SCANS) {
        running++;
      } else {
        await new Promise((resume) => queue.push(resume));
      }
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
