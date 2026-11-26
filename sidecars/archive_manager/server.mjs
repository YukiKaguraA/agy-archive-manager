import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SidecarApp } from 'sidecar_sdk';
import { getRequestLanguage, isSupportedLanguage, t, UNASSIGNED_PROJECT, withRequestLocale } from './server-locale.mjs';
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
    throw new Error(t('upstreamFailed', method, msg));
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
          (Object.hasOwn(entry, 'note') && typeof entry.note !== 'string')) {
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

function parseWorkspaceName(workspaceUrisRaw) {
  if (!workspaceUrisRaw) return '';
  try {
    const arr = JSON.parse(workspaceUrisRaw);
    if (Array.isArray(arr) && arr.length > 0) {
      const decoded = decodeURIComponent(String(arr[0]).replace(/^file:\/\/\/?/i, ''));
      const clean = decoded.replace(/[\\/]+$/, '');
      const parts = clean.split(/[\\/]/).filter(Boolean);
      return parts[parts.length - 1] || clean;
    }
  } catch {}
  return '';
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
function loadDbStatsMap() {
  const map = new Map();
  let db;
  try {
    db = openReadOnlyDb();
    if (!db) return map;
    const rows = db
      .prepare(`SELECT conversation_id, step_count, workspace_uris, preview FROM conversation_summaries`)
      .all();
    for (const r of rows) {
      map.set(r.conversation_id, {
        stepCount: Number(r.step_count) || 0,
        workspaceName: parseWorkspaceName(r.workspace_uris),
        preview: (r.preview || '').trim(),
      });
    }
  } catch {} finally {
    db?.close();
  }
  return map;
}

// Combine native ConversationService state, SQLite stats, and local notes/tags.
async function loadAllConversations() {
  const [nativeList, dbStats] = await Promise.all([
    listAllNativeConversations(),
    Promise.resolve(loadDbStatsMap()),
  ]);

  const projectMap = loadProjectMap();
  const { store: metaStore, warnings } = readMetaForDisplay();
  const nowMs = Date.now();
  const items = [];

  for (const c of nativeList) {
    const id = c.id;
    const md = c.metadata || {};
    const ann = c.annotations || {};
    const st = c.state || {};
    const dbInfo = dbStats.get(id) || {};
    const localMeta = metaStore.conversations[id] || {};

    const projectId = md.projectId || '';
    const projectName =
      projectMap.get(projectId) ||
      dbInfo.workspaceName ||
      (projectId === 'outside-of-project' ? '' : projectId);

    // Prefer local tags override when user explicitly manages tags (supports clearing to empty cleanly),
    // otherwise fall back to native annotations.tags / metadata.tags.
    const nativeTags = [
      ...(Array.isArray(ann.tags) ? ann.tags : []),
      ...(Array.isArray(md.tags) ? md.tags : []),
    ];
    const tags = Array.isArray(localMeta.tags)
      ? localMeta.tags
      : [...new Set(nativeTags.map((t) => String(t).trim()).filter(Boolean))];

    const title = (ann.title || st.summary || dbInfo.preview || t('untitled')).trim();

    items.push({
      id,
      title,
      summary: (st.summary || dbInfo.preview || '').trim(),
      stepCount: dbInfo.stepCount || 0,
      createTime: md.createTime || '',
      ...getConversationStatus(c, nowMs),
      project: projectName || UNASSIGNED_PROJECT,
      projectLabel: projectName || t('unassignedProject'),
      projectId,
      tags,
      note: typeof localMeta.note === 'string' ? localMeta.note : '',
    });
  }

  return { items, warnings };
}

function searchBodiesInDb(queryLower) {
  const db = openReadOnlyDb();
  const hitMap = new Map();
  if (!db || !queryLower) return hitMap;
  try {
    const rows = db
      .prepare(`SELECT conversation_id, title, user_body, agent_body FROM conversations_fts`)
      .all();
    for (const r of rows) {
      if (hitMap.has(r.conversation_id)) continue;
      for (const field of [r.user_body, r.agent_body, r.title]) {
        if (!field || typeof field !== 'string') continue;
        const idx = field.toLowerCase().indexOf(queryLower);
        if (idx !== -1) {
          const start = Math.max(0, idx - 36);
          const end = Math.min(field.length, idx + queryLower.length + 72);
          const snippet =
            (start > 0 ? '…' : '') +
            field.slice(start, end).replace(/\s+/g, ' ').trim() +
            (end < field.length ? '…' : '');
          hitMap.set(r.conversation_id, snippet);
          break;
        }
      }
    }
  } catch {} finally {
    db.close();
  }
  return hitMap;
}

async function getArchivedCount() {
  const all = await listAllNativeConversations();
  return all.filter((c) => c.annotations?.archived === true && !c.metadata?.parentConversationId).length;
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
  const { items, warnings } = await loadAllConversations();
  const conv = items.find((c) => c.id === conversationId);
  if (!conv) throw new Error(t('conversationNotFound', conversationId));

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
  lines.push(`- **Conversation ID**: \`${previewData.id}\``);
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
    const label = m.role === 'user' ? '## 👤 User' : '## 🤖 Assistant';
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

registerApi('/api/conversations', async (data) => {
  const tab = String(data.tab || 'archived');
  const query = String(data.query || '').trim();
  const queryLower = query.toLowerCase();
  const projectFilter = String(data.project || '').trim();
  const tagFilter = String(data.tag || '').trim();
  const sortBy = String(data.sort || 'updated');
  const staleDays = Math.max(1, Number(data.staleDays) || 7);
  const collator = new Intl.Collator(getRequestLanguage());

  const { items, warnings } = await loadAllConversations();
  const baseList = items.filter((c) => !c.isSubagent);
  const stale = baseList.filter((c) => !getStaleExclusion(c, staleDays));

  const projectLabels = new Map();
  const tagsSet = new Set();
  for (const c of baseList) {
    // A real project can share the legacy fallback value. Retain its actual name in the filter.
    if (!projectLabels.has(c.project) || c.project === c.projectLabel) projectLabels.set(c.project, c.projectLabel);
    for (const t of c.tags) tagsSet.add(t);
  }

  const counts = {
    archived: baseList.filter((c) => c.archived).length,
    active: baseList.filter((c) => !c.archived).length,
    starred: baseList.filter((c) => c.starred).length,
    stale: stale.length,
    all: baseList.length,
  };

  let filtered = baseList;
  if (tab === 'archived') filtered = filtered.filter((c) => c.archived);
  else if (tab === 'active') filtered = filtered.filter((c) => !c.archived);
  else if (tab === 'starred') filtered = filtered.filter((c) => c.starred);
  else if (tab === 'stale') filtered = stale;

  if (projectFilter) {
    filtered = filtered.filter((c) => c.project === projectFilter);
  }
  if (tagFilter) {
    filtered = filtered.filter((c) => c.tags.includes(tagFilter));
  }

  if (queryLower) {
    const bodyHits = searchBodiesInDb(queryLower);
    filtered = filtered
      .map((c) => {
        const titleHit = c.title.toLowerCase().includes(queryLower);
        const summaryHit = c.summary.toLowerCase().includes(queryLower);
        const projHit = c.project.toLowerCase().includes(queryLower) || c.projectLabel.toLowerCase().includes(queryLower);
        const tagHit = c.tags.some((t) => t.toLowerCase().includes(queryLower));
        const noteHit = c.note.toLowerCase().includes(queryLower);
        const idHit = c.id.toLowerCase().includes(queryLower);
        const snippet = bodyHits.get(c.id) || '';
        if (!titleHit && !summaryHit && !projHit && !tagHit && !noteHit && !idHit && !snippet) return null;
        return { ...c, matchSnippet: snippet };
      })
      .filter(Boolean);
  }

  filtered.sort((a, b) => {
    // Keep pinned conversations at top in active/all views when sorting by updated
    if (sortBy === 'updated' && (tab === 'active' || tab === 'all')) {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    }
    if (sortBy === 'steps') return b.stepCount - a.stepCount || b.lastModifiedMs - a.lastModifiedMs;
    if (sortBy === 'title') return collator.compare(a.title, b.title);
    return b.lastModifiedMs - a.lastModifiedMs;
  });

  return {
    items: filtered,
    counts,
    projects: [...projectLabels.keys()].sort((a, b) => collator.compare(projectLabels.get(a), projectLabels.get(b))),
    projectLabels: Object.fromEntries(projectLabels),
    allTags: [...tagsSet].sort(collator.compare),
    warnings,
  };
});

registerApi('/api/preview', async (data) => {
  const id = String(data.conversationId || '').trim();
  if (!id) throw new Error(t('missingConversationId'));
  return loadConversationPreview(id);
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
  for (const op of ops) {
    const { id, expectedArchived } = op;
    try {
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
      await updateNativeAnnotations(id, { archived: op.archived });
      result.succeeded.push(id);
      result.changes.push({ id, previousArchived, archived: op.archived });
    } catch (err) {
      result.failed.push({ id, error: err.message });
    }
  }
  if (result.changes.length) invalidateCount();
  result.ok = result.failed.length === 0;
  return result;
}));

// Native update of title, pinned, starred, tags + local note persistence
registerApi('/api/meta/update', serializeMutation(async (data) => {
  const id = String(data.conversationId || '').trim();
  if (!id) throw new Error(t('missingConversationId'));

  const nativeAnn = {};
  if (typeof data.title === 'string' && data.title.trim()) nativeAnn.title = data.title.trim().slice(0, 160);
  if (typeof data.starred === 'boolean') nativeAnn.starred = data.starred;
  if (typeof data.pinned === 'boolean') nativeAnn.pinned = data.pinned;

  let cleanTags = null;
  if (Array.isArray(data.tags)) {
    cleanTags = [...new Set(data.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
    if (cleanTags.length > 0) {
      nativeAnn.tags = cleanTags;
    }
  }

  const updateLocal = cleanTags !== null || typeof data.note === 'string';
  if (typeof data.archived === 'boolean') {
    const current = await getNativeConversation(id);
    if (getKnownArchiveState(current) !== data.archived) {
      if (data.archived) requireIdle(getConversationStatus(current), 'archive');
      nativeAnn.archived = data.archived;
    }
  }

  if (Object.keys(nativeAnn).length > 0) {
    if (updateLocal) readMetaStore();
    await updateNativeAnnotations(id, nativeAnn);
    if (Object.hasOwn(nativeAnn, 'archived')) invalidateCount();
  }

  const { store, warnings } = updateLocal ? { store: readMetaStore(), warnings: [] } : readMetaForDisplay();
  const prev = store.conversations[id] || {};
  const next = { ...prev };
  if (updateLocal) {
    if (cleanTags !== null) next.tags = cleanTags;
    if (typeof data.note === 'string') {
      next.note = data.note.trim().slice(0, 500);
      if (!next.note) delete next.note;
    }
    if (Object.keys(next).length) store.conversations[id] = next;
    else delete store.conversations[id];
    writeMetaStore(store);
  }

  return {
    ok: true,
    conversationId: id,
    annotations: nativeAnn,
    meta: {
      tags: cleanTags !== null ? cleanTags : prev.tags || [],
      note: next.note || '',
    },
    warnings,
  };
}));

// Native permanent delete requires an explicit idle state.
registerApi('/api/delete', serializeMutation(async (data) => {
  const id = String(data.conversationId || '').trim();
  if (!id) throw new Error(t('missingConversationId'));
  const current = await getNativeConversation(id);
  requireIdle(getConversationStatus(current), 'delete');
  await callConversationService('DeleteConversation', { conversationId: id });
  invalidateCount();

  const warnings = [];
  try {
    const store = readMetaStore();
    if (Object.hasOwn(store.conversations, id)) {
      delete store.conversations[id];
      writeMetaStore(store);
    }
  } catch (err) {
    warnings.push(err.message);
  }
  return { ok: true, deletedId: id, warnings };
}));

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
    return readLanguagePreference() || 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

const { cleanup: cleanupSidebar, invalidateCount } = startSidebarInjector(getArchivedCount, getSidebarLanguage);

process.on('SIGTERM', async () => {
  await cleanupSidebar();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await cleanupSidebar();
  process.exit(0);
});
