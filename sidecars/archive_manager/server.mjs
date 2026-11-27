import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SidecarApp } from 'sidecar_sdk';
import { DEFAULT_LANGUAGE, getRequestLanguage, isSupportedLanguage, t, UNASSIGNED_PROJECT, withRequestLocale } from './server-locale.mjs';
import { filterSearch, beginSearch } from './search.mjs';
import { createConversationStats } from './conversation-stats.mjs';
import { startSidebarInjector } from './sidebar_injector.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const AGY_DIR = join(HOME, '.gemini', 'antigravity');
const SUMMARIES_DB = join(AGY_DIR, 'conversation_summaries.db');
const BRAIN_DIR = join(AGY_DIR, 'brain');
const PROJECTS_DIR = join(HOME, '.gemini', 'config', 'projects');
const DATA_DIR =
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
  join(AGY_DIR, 'sidecar_data', 'archive-manager', 'archive_manager', 'data');
const META_FILE = join(DATA_DIR, 'meta.json');
const PREFERENCES_FILE = join(DATA_DIR, 'preferences.json');
const EXPORT_DIR = join(HOME, 'Documents', 'Antigravity-Exports');
const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TRASH_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const inspectConversation = createConversationStats(AGY_DIR);

const LS_ADDRESS = process.env.ANTIGRAVITY_LS_ADDRESS || 'localhost:5387';
const CSRF_TOKEN = process.env.ANTIGRAVITY_CSRF_TOKEN || '';

mkdirSync(DATA_DIR, { recursive: true });

// Guard against EPIPE on stdio pipes
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', (err) => {
    if (err?.code === 'EPIPE') return;
  });
}

// Internal Antigravity ConversationService Connect HTTP+JSON client
async function callConversationService(method, body = {}) {
  const url = `http://${LS_ADDRESS}/product.v1.ConversationService/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'x-antigravity-csrf-token': CSRF_TOKEN,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const msg = parsed?.message || parsed?.error || text || `HTTP ${res.status}`;
    const err = new Error(t('upstreamFailed', method, msg));
    err.notFound = parsed?.code === 'not_found';
    throw err;
  }
  if (!isRecord(parsed) || Object.hasOwn(parsed, 'raw')) {
    throw new Error(t('upstreamInvalidResponse', method));
  }
  return parsed;
}

async function listAllNativeConversations() {
  const all = new Map();
  const seenTokens = new Set();
  let pageToken = '';
  do {
    const req = { pageSize: 100, includeArchived: true };
    if (pageToken) req.pageToken = pageToken;
    const res = await callConversationService('ListConversations', req);
    const batch = res.conversations ?? [];
    if (!Array.isArray(batch) || batch.some((conversation) => typeof conversation?.id !== 'string' || !conversation.id)) {
      throw new Error(t('upstreamInvalidList'));
    }
    for (const conversation of batch) all.set(conversation.id, conversation);
    pageToken = res.nextPageToken ?? '';
    if (typeof pageToken !== 'string' || seenTokens.has(pageToken)) {
      throw new Error(t('upstreamInvalidPageToken'));
    }
    if (pageToken) seenTokens.add(pageToken);
  } while (pageToken);
  return [...all.values()];
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validTrashRecord(trash) {
  return isRecord(trash) && typeof trash.previousArchived === 'boolean' &&
    Number.isSafeInteger(trash.trashedAt) && trash.trashedAt > 0 &&
    trash.trashedAt <= 8640000000000000 - TRASH_RETENTION_MS &&
    [undefined, 'moving', 'restoring'].includes(trash.phase);
}

function inTrash(entry) {
  return Boolean(entry?.trash && entry.trash.phase !== 'moving');
}

function readMetaStore() {
  let raw;
  try {
    raw = readFileSync(META_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { conversations: Object.create(null) };
    throw new Error(t('metaRead'), { cause: err });
  }

  try {
    const store = JSON.parse(raw);
    if (!isRecord(store) || !isRecord(store.conversations)) throw new Error(t('metaInvalidShape'));
    for (const entry of Object.values(store.conversations)) {
      if (!isRecord(entry) ||
          (Object.hasOwn(entry, 'tags') && (!Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== 'string'))) ||
          (Object.hasOwn(entry, 'note') && typeof entry.note !== 'string') ||
          (Object.hasOwn(entry, 'trash') && !validTrashRecord(entry.trash))) {
        throw new Error(t('metaInvalidEntry'));
      }
    }
    return { ...store, conversations: Object.assign(Object.create(null), store.conversations) };
  } catch (err) {
    throw new Error(t('metaInvalid'), { cause: err });
  }
}

function readMetaForDisplay() {
  try {
    return { store: readMetaStore(), warnings: [] };
  } catch (err) {
    return { store: { conversations: Object.create(null) }, warnings: [err.message] };
  }
}

function writeSidecarJson(file, store) {
  const tempFile = join(DATA_DIR, `${basename(file, '.json')}-${randomUUID()}.tmp`);
  let ownsTemp = false;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const handle = openSync(tempFile, 'wx');
    ownsTemp = true;
    try {
      writeFileSync(handle, JSON.stringify(store, null, 2), 'utf8');
    } finally {
      closeSync(handle);
    }
    renameSync(tempFile, file);
    ownsTemp = false;
  } finally {
    if (ownsTemp) {
      try { unlinkSync(tempFile); } catch {}
    }
  }
}

function writeMetaStore(store) {
  try {
    writeSidecarJson(META_FILE, store);
  } catch (err) {
    throw new Error(t('metaWrite'), { cause: err });
  }
}

function readLanguagePreference() {
  let raw;
  try {
    raw = readFileSync(PREFERENCES_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(t('preferencesRead'), { cause: err });
  }

  let store;
  try {
    store = JSON.parse(raw);
  } catch (err) {
    throw new Error(t('preferencesInvalid'), { cause: err });
  }
  if (!isSupportedLanguage(store?.language)) throw new Error(t('preferencesInvalid'));
  return store.language;
}

function loadProjectMap() {
  const map = new Map();
  if (!existsSync(PROJECTS_DIR)) return map;
  try {
    for (const file of readdirSync(PROJECTS_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const obj = JSON.parse(readFileSync(join(PROJECTS_DIR, file), 'utf8'));
        const id = obj.id || obj.projectId || file.replace(/\.json$/i, '');
        const name = obj.name || obj.displayName || obj.title || '';
        if (id && name) map.set(id, name);
      } catch {}
    }
  } catch {}
  return map;
}

function workspaceFromIndex(raw) {
  try {
    const first = JSON.parse(raw)?.[0];
    if (typeof first !== 'string' || !first) return {};
    let path = first;
    try { path = decodeURIComponent(first); } catch {}
    return { workspaceUri: first, workspaceName: path.split(/[\\/]/).filter(Boolean).at(-1) || first };
  } catch { return {}; }
}

function parseIsoMs(tsStr) {
  if (!tsStr) return 0;
  const s = String(tsStr).trim();
  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : 0;
}

function getConversationStatus(conversation, nowMs = Date.now()) {
  const annotations = conversation.annotations || {};
  const metadata = conversation.metadata || {};
  const state = conversation.state || {};
  const { runState = null } = state;
  const lastModified = state.updateTime || metadata.createTime || '';
  const lastModifiedMs = parseIsoMs(lastModified);
  const idleDays = lastModifiedMs > 0 ? Math.max(0, Math.floor((nowMs - lastModifiedMs) / 86400000)) : 0;
  return {
    archived: annotations.archived === true,
    pinned: annotations.pinned === true,
    starred: annotations.starred === true,
    runState,
    isRunning: runState === 'RUN_STATE_RUNNING' || runState === 'RUN_STATE_CANCELLING',
    isSubagent: Boolean(metadata.parentConversationId),
    lastModified,
    lastModifiedMs,
    idleDays,
  };
}

function getStaleExclusion(status, staleDays) {
  if (status.isSubagent) return t('staleSubagent');
  if (status.archived) return t('staleArchived');
  if (status.pinned) return t('stalePinned');
  if (status.starred) return t('staleStarred');
  if (status.isRunning) return t('staleRunning');
  if (status.runState !== 'RUN_STATE_IDLE') return t('staleUnknown');
  if (status.idleDays < staleDays) return t('staleRecent', staleDays);
  return '';
}

function stripUserPromptWrappers(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw;
  const m = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (m) {
    text = m[1];
  } else {
    text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
    text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
    text = text.replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '');
  }
  return text.trim();
}

function openReadOnlyDb() {
  if (!existsSync(SUMMARIES_DB)) return null;
  return new DatabaseSync(SUMMARIES_DB, { readOnly: true });
}

// Read step_count and workspace fallback from read-only SQLite summary index
function loadDbStatsMap(id) {
  const map = new Map();
  let db;
  try {
    db = openReadOnlyDb();
    if (!db) return map;
    const columns = db.prepare('PRAGMA table_info(conversation_summaries)').all();
    const groupColumn = columns.some(column => column.name === 'group_id') ? ', group_id' : '';
    const sql = 'SELECT conversation_id, step_count, workspace_uris, preview' + groupColumn + ' FROM conversation_summaries';
    const rows = id === undefined ? db.prepare(sql).iterate() : db.prepare(sql + ' WHERE conversation_id = ?').iterate(id);
    for (const r of rows) {
      map.set(r.conversation_id, {
        stepCount: Number(r.step_count) || 0,
        ...workspaceFromIndex(r.workspace_uris),
        groupId: r.group_id,
        preview: (r.preview || '').trim(),
      });
    }
  } catch {} finally {
    db?.close();
  }
  return map;
}

function normalizeTags(tags) {
  return [...new Set(tags.filter(tag => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean))];
}

function nativeTagsOf(conversation) {
  const annotations = conversation.annotations?.tags;
  const metadata = conversation.metadata?.tags;
  return normalizeTags([...(Array.isArray(annotations) ? annotations : []), ...(Array.isArray(metadata) ? metadata : [])]);
}

function sameTags(left, right) {
  return left.length === right.length && left.every(tag => right.includes(tag));
}

function conversationItem(c, projectMap, dbInfo, localMeta, nowMs) {
  const md = c.metadata || {};
  const ann = c.annotations || {};
  const st = c.state || {};
  const projectId = md.projectId || '';
  const assigned = projectId && projectId !== 'outside-of-project';
  const projectName = projectMap.get(projectId) || dbInfo.workspaceName || (assigned ? projectId : '');
  const projectKey = assigned ? 'project:' + projectId : dbInfo.workspaceUri ? 'workspace:' + dbInfo.workspaceUri : 'unassigned';
  const groupId = [ann.conversationGroupId, ann.groupId, md.conversationGroupId, md.groupId, c.groupId, dbInfo.groupId]
    .find(id => typeof id === 'string' && id.trim())?.trim() || '';
  const nativeTags = nativeTagsOf(c);
  const localTags = Array.isArray(localMeta.tags) ? normalizeTags(localMeta.tags) : null;
  const trashedAt = inTrash(localMeta) ? localMeta.trash.trashedAt : null;
  return {
    id: c.id,
    title: (ann.title || st.summary || dbInfo.preview || t('untitled')).trim(),
    summary: (st.summary || dbInfo.preview || '').trim(),
    stepCount: dbInfo.stepCount || 0,
    createTime: md.createTime || '',
    ...getConversationStatus(c, nowMs),
    project: projectName || UNASSIGNED_PROJECT,
    projectLabel: projectName || t('unassignedProject'),
    projectId, projectKey,
    groupId, groupKey: groupId ? 'group:' + groupId : 'ungrouped',
    groupLabel: groupId || t('ungrouped'),
    tags: localTags ?? nativeTags,
    nativeTags, localTags,
    tagConflict: localTags !== null && !sameTags(localTags, nativeTags),
    note: localMeta.note || '',
    trashedAt,
    purgeAt: trashedAt === null ? null : trashedAt + TRASH_RETENTION_MS,
  };
}

async function loadConversationData(id) {
  // Older targeted replies omit the ID. unpackConversation has already rejected a different returned ID.
  const nativeList = id === undefined ? await listAllNativeConversations() : [{ ...await getNativeConversation(id), id }];
  const dbStats = loadDbStatsMap(id);
  const projectMap = loadProjectMap();
  const { store, warnings } = readMetaForDisplay();
  const nowMs = Date.now();
  const items = nativeList.map(c => conversationItem(c, projectMap, dbStats.get(c.id) || {}, store.conversations[c.id] || {}, nowMs));
  return { items, warnings };
}

// A client passes its snapshot token between pages. Legacy unpaged calls always load fresh data.
const snapshots = new Map();
let snapshotGeneration = 0;
function invalidateSnapshots() {
  snapshotGeneration++;
  snapshots.clear();
}

async function loadSnapshot(data, paged) {
  const locale = getRequestLanguage();
  const prior = snapshots.get(data.snapshotId);
  if (paged && !data.refresh && prior?.locale === locale) return prior;
  const generation = snapshotGeneration;
  const { items, warnings } = await loadConversationData();
  const visible = items.filter(c => !c.isSubagent);
  const snapshot = { id: randomUUID(), locale, items: visible, ids: new Set(visible.map(c => c.id)), warnings, results: new Map() };
  if (paged && generation === snapshotGeneration) {
    snapshots.set(snapshot.id, snapshot);
    if (snapshots.size > 6) snapshots.delete(snapshots.keys().next().value);
  }
  return snapshot;
}

async function getArchivedCount() {
  const all = await listAllNativeConversations();
  const { store } = readMetaForDisplay();
  return all.filter(c => c.annotations?.archived === true && !c.metadata?.parentConversationId &&
    !inTrash(store.conversations[c.id])).length;
}

function readTranscript(logsDir, source, warnings) {
  const filename = `${source}.jsonl`;
  let raw;
  try {
    raw = readFileSync(join(logsDir, filename), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') warnings.push(t('transcriptUnreadable', filename));
    return null;
  }

  const messages = [];
  let badLines = 0;
  let indexable = true;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const step = JSON.parse(line);
      if (!isRecord(step) || typeof step.type !== 'string') throw new Error(t('transcriptInvalidRecord'));
      const user = step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT';
      if (!user && step.type !== 'PLANNER_RESPONSE') continue;
      if (step.content == null) continue;
      if (typeof step.content !== 'string') throw new Error(t('transcriptInvalidText'));
      const content = user ? stripUserPromptWrappers(step.content) : step.content.trim();
      if (!content) continue;
      const index = step.step_index;
      if (!Number.isSafeInteger(index) || index < 0 || (messages.length && index <= messages.at(-1).stepIndex)) {
        indexable = false;
      }
      messages.push({
        role: user ? 'user' : 'assistant',
        stepIndex: index ?? messages.length,
        timestamp: typeof step.created_at === 'string' ? step.created_at : '',
        content,
      });
    } catch {
      badLines++;
    }
  }
  if (badLines) warnings.push(t('transcriptMalformed', filename, badLines));
  return { source, messages, indexable };
}

const COMPACT_TRUNCATION_RE = /\r?\n<truncated \d+ bytes>\r?\n/;

function isCompatibleCompactText(fullText, compactText) {
  if (fullText.startsWith(compactText)) return true;
  const match = compactText.match(COMPACT_TRUNCATION_RE);
  if (!match) return false;
  const head = compactText.slice(0, match.index);
  const tail = compactText.slice(match.index + match[0].length);
  return fullText.length >= head.length + tail.length && fullText.startsWith(head) && fullText.endsWith(tail);
}

function mergeTranscripts(full, compact) {
  if (!full.indexable || !compact.indexable) return null;
  const indexed = new Map(full.messages.map((message) => [message.stepIndex, message]));
  const fullText = new Set(full.messages.map(({ role, content }) => JSON.stringify([role, content])));
  let shared = false;
  for (const message of compact.messages) {
    const original = indexed.get(message.stepIndex);
    if (!original) {
      // Repeated text with a different index may mean the compact log was reindexed.
      if (fullText.has(JSON.stringify([message.role, message.content]))) return null;
      indexed.set(message.stepIndex, message);
      continue;
    }
    // Compact logs can clip the end or elide the middle. Keep the full text when either aligns.
    if (message.role !== original.role || !isCompatibleCompactText(original.content, message.content) ||
        (message.timestamp && original.timestamp && message.timestamp !== original.timestamp)) {
      return null;
    }
    shared = true;
  }
  return shared ? [...indexed.values()].sort((a, b) => a.stepIndex - b.stepIndex) : null;
}

function loadFtsPreview(conversationId, warnings) {
  const messages = [];
  let db;
  try {
    db = openReadOnlyDb();
    if (db) {
      const chunks = db.prepare(`
        SELECT chunk_index, user_body, agent_body
        FROM conversations_fts
        WHERE conversation_id = ?
        ORDER BY chunk_index ASC
      `).all(conversationId);
      for (const chunk of chunks) {
        const user = stripUserPromptWrappers(chunk.user_body);
        const assistant = (chunk.agent_body || '').trim();
        if (user) messages.push({ role: 'user', stepIndex: messages.length, timestamp: '', content: user });
        if (assistant) messages.push({ role: 'assistant', stepIndex: messages.length, timestamp: '', content: assistant });
      }
    }
  } catch {
    warnings.push(t('ftsUnreadable'));
  } finally {
    db?.close();
  }
  warnings.push(t(messages.length ? 'ftsOnly' : 'transcriptMissing'));
  return { source: messages.length ? 'fts' : 'none', messages };
}

function loadTranscript(conversationId, warnings) {
  const logsDir = join(BRAIN_DIR, conversationId, '.system_generated', 'logs');
  const full = readTranscript(logsDir, 'transcript_full', warnings);
  const compact = readTranscript(logsDir, 'transcript', warnings);
  if (full?.messages.length && compact?.messages.length) {
    const merged = mergeTranscripts(full, compact);
    if (merged && merged.length > full.messages.length) {
      warnings.push(t('transcriptMerged'));
      return { source: 'transcript_full+transcript', messages: merged };
    }
    if (!merged) {
      warnings.push(t('transcriptConflict'));
    }
  }
  if (full?.messages.length) return full;
  if (compact?.messages.length) return compact;
  return loadFtsPreview(conversationId, warnings);
}

async function loadConversationPreview(conversationId) {
  const { items: [conv], warnings } = await loadConversationData(conversationId);
  const { source, messages } = loadTranscript(conversationId, warnings);
  if (source === 'transcript') warnings.push(t('transcriptCompact'));

  return {
    ...conv,
    source,
    warnings,
    messageCount: messages.length,
    messages,
  };
}

function buildMarkdownExport(previewData) {
  const lines = [];
  lines.push(`# ${previewData.title}`);
  lines.push('');
  lines.push(`- **${t('exportConversationId')}**: \`${previewData.id}\``);
  lines.push(`- **${t('exportProject')}**: ${previewData.projectLabel}`);
  lines.push(`- **${t('exportArchiveStatus')}**: ${t(previewData.archived ? 'exportArchived' : 'exportUnarchived')}`);
  if (previewData.pinned) lines.push(`- **${t('exportPinStatus')}**: ${t('exportPinned')}`);
  if (previewData.starred) lines.push(`- **${t('exportStarStatus')}**: ${t('exportStarred')}`);
  if (previewData.lastModified) lines.push(`- **${t('exportUpdated')}**: ${previewData.lastModified}`);
  if (previewData.tags?.length) lines.push(`- **${t('exportTags')}**: ${previewData.tags.map((tag) => `#${tag}`).join(' ')}`);
  if (previewData.note) lines.push(`- **${t('exportNote')}**: ${previewData.note}`);
  lines.push(`- **${t('exportSource')}**: \`${previewData.source}\``);
  for (const warning of previewData.warnings) lines.push(`- **${t('exportWarning')}**: ${warning}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const m of previewData.messages) {
    const label = m.role === 'user' ? `## 👤 ${t('exportUser')}` : `## 🤖 ${t('exportAssistant')}`;
    const ts = m.timestamp ? ` _(${m.timestamp})_` : '';
    lines.push(`${label}${ts}`);
    lines.push('');
    lines.push(m.content);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function sanitizeFilename(name) {
  const cleaned = String(name || 'conversation')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'conversation';
}

function saveMarkdownSnapshot(stem, markdown) {
  mkdirSync(EXPORT_DIR, { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const filename = `${stem}${attempt > 1 ? `-${attempt}` : ''}.md`;
    const savedPath = join(EXPORT_DIR, filename);
    let handle;
    try {
      handle = openSync(savedPath, 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    try {
      try {
        writeFileSync(handle, markdown, 'utf8');
      } finally {
        closeSync(handle);
      }
    } catch (err) {
      try { unlinkSync(savedPath); } catch {}
      throw err;
    }
    return { filename, savedPath };
  }
}

// Start Sidecar HTTP app
const app = new SidecarApp();

function registerApi(path, handler) {
  app.api(path, withRequestLocale(handler));
}

// Keep each native mutation and its initial-state check in the same queue.
let pendingMutation = Promise.resolve();
function serializeMutation(handler) {
  return (data = {}) => {
    const result = pendingMutation.then(() => handler(data));
    pendingMutation = result.catch(() => {});
    return result;
  };
}

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf8'));

registerApi('/api/preferences', async (data) => {
  if (!Object.hasOwn(data, 'language')) return { language: readLanguagePreference() };
  const { language } = data;
  if (!isSupportedLanguage(language)) throw new Error(t('invalidLanguage'));
  try {
    writeSidecarJson(PREFERENCES_FILE, { language });
  } catch (err) {
    throw new Error(t('preferencesWrite'), { cause: err });
  }
  invalidateCount();
  return { language };
});

function optionsOf(items, key, label, collator) {
  const options = new Map(items.map(item => [item[key], item[label]]));
  const labels = new Map();
  for (const name of options.values()) labels.set(name, (labels.get(name) || 0) + 1);
  return [...options].map(([key, label]) => ({
    key, label: labels.get(label) > 1 ? label + ' (' + key + ')' : label,
  }))
    .sort((a, b) => collator.compare(a.label, b.label) || compareId(a.key, b.key));
}

function compareId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedItems(items, tab, sort, collator) {
  return items.sort((a, b) => {
    if (sort === 'updated' && (tab === 'active' || tab === 'all') && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const time = b.lastModifiedMs - a.lastModifiedMs;
    if (sort === 'steps') return b.stepCount - a.stepCount || time || compareId(a.id, b.id);
    if (sort === 'title') return collator.compare(a.title, b.title) || compareId(a.id, b.id);
    return time || compareId(a.id, b.id);
  });
}

function groupByWorkspace(items, collator) {
  const groups = new Map();
  const labels = new Map(optionsOf(items, 'projectKey', 'projectLabel', collator)
    .map(({ key, label }) => [key, label]));
  for (const item of items) {
    const key = item.projectKey;
    if (!groups.has(key)) groups.set(key, { key, label: labels.get(key), lastModifiedMs: 0, lastModified: '', items: [] });
    const group = groups.get(key);
    group.items.push(item);
    if (item.lastModifiedMs > group.lastModifiedMs) {
      group.lastModifiedMs = item.lastModifiedMs;
      group.lastModified = item.lastModified;
    }
  }
  const summaries = [...groups.values()].sort((a, b) => b.lastModifiedMs - a.lastModifiedMs ||
    collator.compare(a.label, b.label) || compareId(a.key, b.key))
    .map(({ key, label, lastModified, items }) => ({ key, label, lastModified, total: items.length }));
  return { groups, summaries };
}

registerApi('/api/conversations', async (data) => {
  const tab = String(data.tab || 'archived');
  const query = String(data.query || '').trim().toLowerCase();
  const searchMode = data.searchMode === 'keywords' ? 'keywords' : 'literal';
  const projectKey = String(data.projectKey || '');
  const grouped = data.grouped === true;
  const filterProjectKey = grouped ? '' : projectKey;
  const groupKey = String(data.groupKey || '');
  const project = String(data.project || '').trim();
  const tag = String(data.tag || '').trim();
  const sort = String(data.sort || 'updated');
  const staleDays = Math.max(1, Number(data.staleDays) || 7);
  const paged = grouped || data.page !== undefined || data.pageSize !== undefined;
  const signal = beginSearch(data.searchClientId, data.searchSequence);
  const cancelled = { cancelled: true, items: [] };
  if (signal?.aborted) return cancelled;
  const snapshot = await loadSnapshot(data, paged);
  if (signal?.aborted) return cancelled;
  const key = JSON.stringify([tab, query, searchMode, filterProjectKey, groupKey, project, tag, sort, staleDays, grouped]);
  let result = snapshot.results.get(key);
  if (!result) {
    const collator = new Intl.Collator(snapshot.locale);
    const recycled = snapshot.items.filter(c => c.trashedAt !== null);
    const all = snapshot.items.filter(c => c.trashedAt === null);
    const scope = tab === 'trash' ? recycled : all;
    const stale = all.filter(c => !getStaleExclusion(c, staleDays));
    const counts = { all: all.length, archived: 0, active: 0, starred: 0, stale: stale.length, trash: recycled.length };
    const projectLabels = new Map();
    const tags = new Set();
    for (const c of all) {
      counts[c.archived ? 'archived' : 'active']++;
      if (c.starred) counts.starred++;
      if (!projectLabels.has(c.project) || c.project === c.projectLabel) projectLabels.set(c.project, c.projectLabel);
    }
    for (const c of scope) for (const value of c.tags) tags.add(value);
    let filtered = (tab === 'stale' ? stale : scope).filter(c =>
      (tab !== 'archived' || c.archived) && (tab !== 'active' || !c.archived) && (tab !== 'starred' || c.starred) &&
      (!filterProjectKey || c.projectKey === filterProjectKey) && (filterProjectKey || !project || c.project === project) &&
      (!groupKey || c.groupKey === groupKey) && (!tag || c.tags.includes(tag)));
    const warnings = [...snapshot.warnings];
    if (query) {
      const search = await filterSearch(filtered, query, searchMode, SUMMARIES_DB, signal);
      if (signal?.aborted) return cancelled;
      filtered = search.items;
      if (search.warning) warnings.push(t(search.warning));
    }
    const items = sortedItems(filtered, tab, sort, collator);
    result = {
      items,
      workspace: grouped ? groupByWorkspace(items, collator) : null,
      counts, warnings, projectLabels: Object.fromEntries(projectLabels),
      projects: [...projectLabels.keys()].sort((a, b) => collator.compare(projectLabels.get(a), projectLabels.get(b))),
      projectOptions: optionsOf(scope, 'projectKey', 'projectLabel', collator),
      groupOptions: optionsOf(scope, 'groupKey', 'groupLabel', collator),
      allTags: [...tags].sort(collator.compare),
    };
    if (paged) {
      snapshot.results.set(key, result);
      if (snapshot.results.size > 4) snapshot.results.delete(snapshot.results.keys().next().value);
    }
  }

  const { items, workspace, ...metadata } = result;
  const pageItems = grouped ? workspace.groups.get(projectKey)?.items ?? [] : items;
  const total = grouped && !projectKey ? items.length : pageItems.length;
  const pageSize = paged ? Math.max(1, Math.min(500, Math.floor(Number(data.pageSize)) || 50)) : total;
  const pageCount = paged ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const page = paged ? Math.min(pageCount, Math.max(1, Math.floor(Number(data.page)) || 1)) : 1;
  return {
    ...(grouped && projectKey ? {} : metadata),
    page, pageSize, total, snapshotId: snapshot.id,
    items: paged ? pageItems.slice((page - 1) * pageSize, page * pageSize) : pageItems,
    ...(grouped && !projectKey ? { groups: workspace.summaries } : {}),
    ...(tab === 'stale' && data.includeMatchingIds === true ? { matchingIds: (projectKey ? pageItems : items).map(c => c.id) } : {}),
  };
});

registerApi('/api/preview', async (data) => {
  const id = String(data.conversationId || '').trim();
  if (!id) throw new Error(t('missingConversationId'));
  return loadConversationPreview(id);
});

registerApi('/api/conversation-stats', async (data) => {
  if (!Array.isArray(data.conversationIds) || data.conversationIds.length > 50) {
    throw new Error(t('invalidStatsRequest'));
  }
  const ids = data.conversationIds.length ? trashIds(data) : [];
  if (!ids.length) return { stats: {} };
  const snapshot = await loadSnapshot(data, true);
  const stats = await Promise.all(ids.filter(id => snapshot.ids.has(id)).map(async id => [
    id, await inspectConversation(id) ?? {
      turnCount: null, turnStatus: 'unavailable', fileCount: null, sizeBytes: null, storageStatus: 'unavailable',
    },
  ]));
  return { stats: Object.fromEntries(stats) };
});

function parseArchiveRequest(data) {
  if (Object.hasOwn(data, 'undo')) {
    if (!Array.isArray(data.undo) || !data.undo.length ||
        ['conversationIds', 'conversationId', 'archived', 'staleDays'].some((key) => Object.hasOwn(data, key))) {
      throw new Error(t('invalidUndoRequest'));
    }
    const targets = new Map();
    for (const change of data.undo) {
      const id = typeof change?.id === 'string' ? change.id.trim() : '';
      if (!id || typeof change.previousArchived !== 'boolean' || typeof change.archived !== 'boolean' ||
          change.previousArchived === change.archived) {
        throw new Error(t('invalidUndoRecord'));
      }
      if (targets.has(id) && targets.get(id).archived !== change.previousArchived) {
        throw new Error(t('conflictingUndo', id));
      }
      targets.set(id, { id, archived: change.previousArchived, expectedArchived: change.archived });
    }
    const ops = [...targets.values()];
    const archived = ops.every((op) => op.archived === ops[0].archived) ? ops[0].archived : null;
    return { ops, archived };
  }

  const ids = Array.isArray(data.conversationIds) ? data.conversationIds : [data.conversationId];
  const uniqueIds = [...new Set(ids.map((id) => typeof id === 'string' ? id.trim() : '').filter(Boolean))];
  if (!uniqueIds.length) throw new Error(t('missingConversationId'));
  if (typeof data.archived !== 'boolean') throw new Error(t('missingArchiveState'));
  const { archived, staleDays } = data;
  if (Object.hasOwn(data, 'staleDays') && (!archived || !Number.isInteger(staleDays) || staleDays < 1)) {
    throw new Error(t('missingStaleDays'));
  }
  return { ops: uniqueIds.map((id) => ({ id, archived })), archived, staleDays };
}

function getKnownArchiveState(conversation) {
  if (conversation.annotations != null && !isRecord(conversation.annotations)) {
    throw new Error(t('unknownArchiveState'));
  }
  const archived = conversation.annotations?.archived;
  // The native archive annotation is optional. An absent annotation is unarchived.
  if (archived !== undefined && typeof archived !== 'boolean') throw new Error(t('unknownArchiveState'));
  return archived === true;
}

function unpackConversation(response, id) {
  const conversation = response.conversation ?? response;
  if (!isRecord(conversation) || (conversation.id !== undefined && conversation.id !== id) ||
      (conversation.id === undefined && !isRecord(conversation.state) && !isRecord(conversation.annotations))) {
    throw new Error(t('unknownConversation'));
  }
  return conversation;
}

async function getNativeConversation(id) {
  return unpackConversation(await callConversationService('GetConversation', { conversationId: id }), id);
}

async function updateNativeAnnotations(id, annotations) {
  const reply = await callConversationService('UpdateConversation', { conversationId: id, annotations });
  if (!Object.hasOwn(annotations, 'archived')) return;

  const repliedAnnotations = (reply.conversation ?? reply).annotations;
  const hasArchiveState = isRecord(repliedAnnotations) && Object.hasOwn(repliedAnnotations, 'archived') &&
    typeof repliedAnnotations.archived === 'boolean';
  const updated = hasArchiveState ? unpackConversation(reply, id) : await getNativeConversation(id);
  if (getKnownArchiveState(updated) !== annotations.archived) {
    throw new Error(t('unexpectedArchiveState'));
  }
}

function requireIdle(status, operation) {
  if (status.isRunning) throw new Error(t(operation === 'archive' ? 'runningArchive' : 'runningDelete'));
  if (status.runState !== 'RUN_STATE_IDLE') {
    throw new Error(t(operation === 'archive' ? 'unknownArchive' : 'unknownDelete'));
  }
}

// Single or batch native archive / restore via ConversationService.UpdateConversation.
registerApi('/api/set-archived', serializeMutation(async (data) => {
  const { ops, archived, staleDays } = parseArchiveRequest(data);
  const result = { ok: true, archived, succeeded: [], unchanged: [], failed: [], changes: [] };
  const { conversations } = readMetaStore();
  for (const op of ops) {
    const { id, expectedArchived } = op;
    try {
      if (conversations[id]?.trash) throw new Error(t('restoreFromTrash'));
      // Earlier operations in a batch may take time. Read each candidate just before its update.
      const current = await getNativeConversation(id);
      const previousArchived = getKnownArchiveState(current);
      const status = getConversationStatus(current);
      if (staleDays !== undefined) {
        const exclusion = getStaleExclusion(status, staleDays);
        if (exclusion) throw new Error(exclusion);
      }
      if (previousArchived === op.archived) {
        result.unchanged.push(id);
        continue;
      }
      if (expectedArchived !== undefined && previousArchived !== expectedArchived) {
        throw new Error(t('undoStateChanged'));
      }
      if (op.archived) requireIdle(status, 'archive');
      try {
        await updateNativeAnnotations(id, { archived: op.archived });
      } finally {
        // Even an error can follow a successful host write.
        invalidateSnapshots();
      }
      result.succeeded.push(id);
      result.changes.push({ id, previousArchived, archived: op.archived });
    } catch (err) {
      result.failed.push({ id, error: err.message });
    }
  }
  if (result.changes.length) {
    invalidateCount();
  }
  result.ok = result.failed.length === 0;
  return result;
}));

function completeNativeIdentity(conv, id) {
  return conv.id === id && typeof conv.state?.runState === 'string' && conv.state.runState.length > 0;
}

async function verifiedNativeTags(id) {
  const conv = await getNativeConversation(id);
  const ann = conv.annotations;
  const md = conv.metadata;
  const invalidFields = [ann, md].some(record =>
    record !== undefined && (!isRecord(record) || (Object.hasOwn(record, 'tags') &&
      (!Array.isArray(record.tags) || record.tags.some(tag => typeof tag !== 'string')))));
  if (!completeNativeIdentity(conv, id) || invalidFields || (!ann && !Array.isArray(md?.tags))) {
    throw new Error(t('unconfirmedTags'));
  }
  return nativeTagsOf(conv);
}

registerApi('/api/meta/update', serializeMutation(async (data) => {
  const id = String(data.conversationId || '').trim();
  if (!id) throw new Error(t('missingConversationId'));
  const resolution = data.tagResolution;
  if (resolution !== undefined && !['native', 'local'].includes(resolution)) throw new Error(t('invalidTagResolution'));
  if (data.tags !== undefined && (!Array.isArray(data.tags) || data.tags.some(tag => typeof tag !== 'string'))) {
    throw new Error(t('invalidTags'));
  }
  const managesTags = Array.isArray(data.tags) || resolution !== undefined;
  const writesNote = typeof data.note === 'string';
  const { store, warnings } = managesTags || writesNote ? { store: readMetaStore(), warnings: [] } : readMetaForDisplay();
  const prev = store.conversations[id] || {};
  const next = { ...prev };
  const nativeAnn = {};
  let nativeTags;
  if (typeof data.title === 'string' && data.title.trim()) nativeAnn.title = data.title.trim().slice(0, 160);
  if (typeof data.starred === 'boolean') nativeAnn.starred = data.starred;
  if (typeof data.pinned === 'boolean') nativeAnn.pinned = data.pinned;

  if (resolution === 'native') {
    nativeTags = await verifiedNativeTags(id);
  } else if (resolution === 'local') {
    if (!Array.isArray(prev.tags)) throw new Error(t('missingLocalTags'));
    nativeAnn.tags = normalizeTags(prev.tags);
  } else if (Array.isArray(data.tags)) {
    nativeAnn.tags = normalizeTags(data.tags).slice(0, 20);
  }
  if (typeof data.archived === 'boolean') {
    if (prev.trash) throw new Error(t('restoreFromTrash'));
    const current = await getNativeConversation(id);
    if (getKnownArchiveState(current) !== data.archived) {
      if (data.archived) requireIdle(getConversationStatus(current), 'archive');
      nativeAnn.archived = data.archived;
    }
  }
  if (Object.keys(nativeAnn).length) {
    try {
      await updateNativeAnnotations(id, nativeAnn);
    } finally {
      invalidateSnapshots();
    }
    if (Object.hasOwn(nativeAnn, 'archived')) invalidateCount();
  }
  if (Object.hasOwn(nativeAnn, 'tags')) {
    nativeTags = await verifiedNativeTags(id);
    if (!sameTags(nativeTags, nativeAnn.tags)) throw new Error(t('unconfirmedTags'));
  }
  if (managesTags) delete next.tags;
  if (writesNote) {
    next.note = data.note.trim().slice(0, 500);
    if (!next.note) delete next.note;
  }
  if (JSON.stringify(next) !== JSON.stringify(prev)) {
    if (Object.keys(next).length) store.conversations[id] = next;
    else delete store.conversations[id];
    writeMetaStore(store);
    invalidateSnapshots();
  }
  return {
    ok: true, conversationId: id, annotations: nativeAnn,
    meta: {
      tags: nativeTags ?? next.tags ?? [],
      ...(nativeTags === undefined ? {} : { nativeTags, tagConflict: false }),
      note: next.note || '',
    },
    warnings,
  };
}));

function trashIds(data) {
  const ids = data.conversationIds ?? [data.conversationId];
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error(t('missingConversationId'));
  }
  return [...new Set(ids.map(id => id.trim()))];
}

function invalidateTrashViews() {
  invalidateSnapshots();
  invalidateCount();
}

function saveTrash(store, id, trash) {
  const entry = { ...store.conversations[id] };
  if (trash) entry.trash = trash;
  else delete entry.trash;
  if (Object.keys(entry).length) store.conversations[id] = entry;
  else delete store.conversations[id];
  writeMetaStore(store);
  invalidateTrashViews();
}

function trashFailure(code, key, detail) {
  const reason = t(key);
  return Object.assign(new Error(detail ? reason + ' (' + detail + ')' : reason), { code });
}

async function checkedTrashConversation(id, requireIdentity = false) {
  const current = await getNativeConversation(id);
  const status = getConversationStatus(current);
  const metadata = current.metadata;
  if (requireIdentity && (current.id !== id || !isRecord(metadata) || !isRecord(current.annotations) ||
      (metadata.parentConversationId !== undefined && typeof metadata.parentConversationId !== 'string'))) {
    throw new Error(t('unknownConversation'));
  }
  if (status.isSubagent) throw trashFailure('subagent', 'deleteSubagent');
  requireIdle(status, 'delete');
  return getKnownArchiveState(current);
}

async function restoreTrashed(id) {
  const store = readMetaStore();
  const entry = store.conversations[id];
  if (!inTrash(entry)) throw trashFailure('not_in_trash', 'notInTrash');
  const archived = await checkedTrashConversation(id);
  const { trashedAt, previousArchived } = entry.trash;
  if (archived !== previousArchived) {
    saveTrash(store, id, { trashedAt, previousArchived, phase: 'restoring' });
    await updateNativeAnnotations(id, { archived: previousArchived });
  }
  saveTrash(store, id, null);
}

async function moveToTrash(id, archivedOnly) {
  const store = readMetaStore();
  const entry = store.conversations[id];
  if (inTrash(entry)) {
    if (entry.trash.phase === 'restoring') throw trashFailure('restore_pending', 'restoreFromTrash');
    return;
  }
  const archived = await checkedTrashConversation(id);
  if (archivedOnly && !archived) throw trashFailure('not_archived', 'deleteArchivedOnly');
  const previousArchived = entry?.trash?.previousArchived ?? archived;
  if (!archived) {
    saveTrash(store, id, { previousArchived, trashedAt: Date.now(), phase: 'moving' });
    await updateNativeAnnotations(id, { archived: true });
  }
  saveTrash(store, id, { previousArchived, trashedAt: Date.now() });
}

async function purgeTrashed(id, warnings) {
  const store = readMetaStore();
  const trash = store.conversations[id]?.trash;
  if (!trash || trash.phase !== undefined) throw trashFailure('not_in_trash', 'notInTrash');

  let present = true;
  try {
    if (!await checkedTrashConversation(id, true)) throw trashFailure('not_archived', 'deleteArchivedOnly');
  } catch (err) {
    if (!err.notFound) throw err;
    present = false;
  }

  if (present) {
    let writeError;
    try {
      await callConversationService('DeleteConversation', { conversationId: id });
    } catch (err) {
      writeError = err;
    }
    invalidateTrashViews();
    try {
      const current = await getNativeConversation(id);
      if (!completeNativeIdentity(current, id)) throw new Error(t('unknownConversation'));
    } catch (err) {
      if (!err.notFound) throw trashFailure('unknown_outcome', 'deleteUnknown', err.message);
      if (writeError) warnings.push(t('deleteRecovered', id, writeError.message));
      present = false;
    }
    if (present) throw trashFailure('delete_failed', 'deleteRemains', writeError?.message);
  }

  delete store.conversations[id];
  writeMetaStore(store);
  invalidateTrashViews();
}

async function applyTrashOperations(ids, operation) {
  const result = { ok: true, succeeded: [], failed: [], warnings: [] };
  for (const id of ids) {
    try {
      await operation(id, result.warnings);
      result.succeeded.push(id);
    } catch (err) {
      result.failed.push({ id, error: err.message, code: err.code || (err.notFound ? 'already_gone' : 'operation_failed') });
    }
  }
  result.ok = result.failed.length === 0;
  return result;
}

registerApi('/api/trash', serializeMutation(data => applyTrashOperations(trashIds(data), id => moveToTrash(id, false))));
registerApi('/api/restore-trash', serializeMutation(data => applyTrashOperations(trashIds(data), restoreTrashed)));
registerApi('/api/purge-trash', serializeMutation(data => applyTrashOperations(trashIds(data), purgeTrashed)));

// Keep old entry points reversible when a panel from an earlier version is still open.
registerApi('/api/delete-batch', serializeMutation(async data => {
  const result = await applyTrashOperations(trashIds(data), id => moveToTrash(id, true));
  return { ...result, deleted: result.succeeded, skipped: [], failed: result.failed.map(issue => ({ ...issue, reason: issue.error })) };
}));

registerApi('/api/delete', serializeMutation(async data => {
  const [id] = trashIds({ conversationId: data.conversationId });
  await moveToTrash(id, false);
  return { ok: true, deletedId: id, warnings: [] };
}));

async function reconcileTrashMove(id) {
  const store = readMetaStore();
  const { previousArchived } = store.conversations[id].trash;
  const archived = await checkedTrashConversation(id);
  const trash = archived ? { previousArchived, trashedAt: Date.now() } : null;
  saveTrash(store, id, trash);
}

export function sweepTrash(now = Date.now()) {
  return enqueueTrashSweep(now);
}

const enqueueTrashSweep = serializeMutation(async now => {
  const { conversations } = readMetaStore();
  const pending = Object.entries(conversations).filter(([, entry]) => entry.trash?.phase);
  const settled = await applyTrashOperations(pending.map(([id]) => id), async id => {
    try {
      if (conversations[id].trash.phase === 'moving') await reconcileTrashMove(id);
      else await restoreTrashed(id);
    } catch (err) {
      if (!err.notFound) throw err;
      saveTrash(readMetaStore(), id, null);
    }
  });
  const expired = Object.entries(conversations).filter(([, { trash }]) =>
    trash && !trash.phase && trash.trashedAt + TRASH_RETENTION_MS <= now);
  const purged = await applyTrashOperations(expired.map(([id]) => id), purgeTrashed);
  return { settled, purged };
});

function scheduleTrashSweep() {
  sweepTrash()
    .catch(err => console.warn('[archive-manager] ' + err.message))
    .finally(() => setTimeout(scheduleTrashSweep, TRASH_SWEEP_INTERVAL_MS).unref());
}

registerApi('/api/export', async (data) => {
  const id = String(data.conversationId || '').trim();
  if (!id) throw new Error(t('missingConversationId'));
  const previewData = await loadConversationPreview(id);
  const markdown = buildMarkdownExport(previewData);
  const dateTag = new Date().toISOString().slice(0, 10);
  const stem = `${dateTag}_${sanitizeFilename(previewData.title)}_${sanitizeFilename(id.slice(0, 8))}`;

  if (data.saveToDisk) {
    return { ok: true, ...saveMarkdownSnapshot(stem, markdown), markdown };
  }
  return { ok: true, filename: `${stem}.md`, markdown };
});

registerApi('/api/reveal-file', async (data) => {
  const target = resolve(String(data.path || EXPORT_DIR));
  if (!existsSync(target)) throw new Error(t('pathNotFound', target));
  if (process.platform === 'win32') {
    const isFile = Boolean(data.isFile);
    const psCmd = isFile
      ? 'Start-Process -FilePath explorer.exe -ArgumentList (\'/select,"\' + $env:AGY_REVEAL_PATH + \'"\')'
      : 'Start-Process -FilePath explorer.exe -ArgumentList (\'"\' + $env:AGY_REVEAL_PATH + \'"\')';
    await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], {
      env: { ...process.env, AGY_REVEAL_PATH: target },
      windowsHide: true,
      timeout: 15000,
    });
  } else if (process.platform === 'darwin') {
    const isFile = Boolean(data.isFile);
    await execFileAsync('open', isFile ? ['-R', target] : [target], { timeout: 15000 });
  } else {
    const isFile = Boolean(data.isFile);
    await execFileAsync('xdg-open', [isFile ? dirname(target) : target], { timeout: 15000 });
  }
  return { ok: true, path: target };
});

app.run();

function getSidebarLanguage() {
  try {
    return readLanguagePreference() || DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

const { cleanup: cleanupSidebar, invalidateCount } = startSidebarInjector(getArchivedCount, getSidebarLanguage);
scheduleTrashSweep();

process.on('SIGTERM', async () => {
  await cleanupSidebar();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await cleanupSidebar();
  process.exit(0);
});
