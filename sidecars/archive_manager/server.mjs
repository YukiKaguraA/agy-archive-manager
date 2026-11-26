import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SidecarApp } from 'sidecar_sdk';
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

// Official Antigravity v2.35.0 ConversationService Connect HTTP+JSON client
async function callConversationService(method, body = {}) {
  const url = `http://${LS_ADDRESS}/product.v1.ConversationService/${method}`;
  const res = await fetch(url, {
    method: 'POST',
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
    throw new Error(`ConversationService.${method} 失败: ${msg}`);
  }
  return parsed;
}

async function listAllNativeConversations() {
  const all = [];
  let pageToken = '';
  for (let page = 0; page < 50; page++) {
    const req = { pageSize: 100, includeArchived: true };
    if (pageToken) req.pageToken = pageToken;
    const res = await callConversationService('ListConversations', req);
    const batch = Array.isArray(res.conversations) ? res.conversations : [];
    all.push(...batch);
    if (!res.nextPageToken || batch.length === 0) break;
    pageToken = res.nextPageToken;
  }
  return all;
}

function readMetaStore() {
  try {
    if (existsSync(META_FILE)) {
      const parsed = JSON.parse(readFileSync(META_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return { conversations: parsed.conversations || {} };
      }
    }
  } catch {}
  return { conversations: {} };
}

function writeMetaStore(store) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(META_FILE, JSON.stringify(store, null, 2), 'utf8');
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
  const db = openReadOnlyDb();
  if (!db) return map;
  try {
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
    db.close();
  }
  return map;
}

// Combine official ConversationService (authoritative state) + SQLite stats + local notes/tags
async function loadAllConversations() {
  const [nativeList, dbStats] = await Promise.all([
    listAllNativeConversations(),
    Promise.resolve(loadDbStatsMap()),
  ]);

  const projectMap = loadProjectMap();
  const metaStore = readMetaStore();
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
      (projectId === 'outside-of-project' || !projectId ? '未归属项目' : projectId);

    const lastModified = st.updateTime || md.createTime || '';
    const lastModifiedMs = parseIsoMs(lastModified);
    const idleDays = lastModifiedMs > 0 ? Math.max(0, Math.floor((nowMs - lastModifiedMs) / 86400000)) : 0;

    // Prefer local tags override when user explicitly manages tags (supports clearing to empty cleanly),
    // otherwise fall back to native annotations.tags / metadata.tags.
    const nativeTags = [
      ...(Array.isArray(ann.tags) ? ann.tags : []),
      ...(Array.isArray(md.tags) ? md.tags : []),
    ];
    const tags = Array.isArray(localMeta.tags)
      ? localMeta.tags
      : [...new Set(nativeTags.map((t) => String(t).trim()).filter(Boolean))];

    const title = (ann.title || st.summary || dbInfo.preview || '未命名会话').trim();

    items.push({
      id,
      title,
      summary: (st.summary || dbInfo.preview || '').trim(),
      stepCount: dbInfo.stepCount || 0,
      createTime: md.createTime || '',
      lastModified,
      lastModifiedMs,
      idleDays,
      archived: Boolean(ann.archived),
      pinned: Boolean(ann.pinned),
      starred: Boolean(ann.starred),
      runState: st.runState || 'RUN_STATE_IDLE',
      isRunning: st.runState === 'RUN_STATE_RUNNING' || st.runState === 'RUN_STATE_CANCELLING',
      project: projectName,
      projectId,
      isSubagent: Boolean(md.parentConversationId),
      tags,
      note: typeof localMeta.note === 'string' ? localMeta.note : '',
    });
  }

  return items;
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

async function getArchivedCountSafe() {
  try {
    const all = await loadAllConversations();
    return all.filter((c) => c.archived && !c.isSubagent).length;
  } catch {
    return 0;
  }
}

async function loadConversationPreview(conversationId) {
  const all = await loadAllConversations();
  const conv = all.find((c) => c.id === conversationId);
  if (!conv) {
    throw new Error(`未找到会话: ${conversationId}`);
  }

  const messages = [];
  let source = 'transcript';

  const logsDir = join(BRAIN_DIR, conversationId, '.system_generated', 'logs');
  const candidates = [
    { path: join(logsDir, 'transcript_full.jsonl'), label: 'transcript_full' },
    { path: join(logsDir, 'transcript.jsonl'), label: 'transcript' },
  ];

  for (const cand of candidates) {
    if (!existsSync(cand.path)) continue;
    try {
      const raw = readFileSync(cand.path, 'utf8');
      const lines = raw.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const step = JSON.parse(line);
          if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT') {
            const cleaned = stripUserPromptWrappers(step.content || '');
            if (cleaned) {
              messages.push({
                role: 'user',
                stepIndex: step.step_index ?? messages.length,
                timestamp: step.created_at || '',
                content: cleaned,
              });
            }
          } else if (step.type === 'PLANNER_RESPONSE') {
            const text = (step.content || '').trim();
            if (text) {
              messages.push({
                role: 'assistant',
                stepIndex: step.step_index ?? messages.length,
                timestamp: step.created_at || '',
                content: text,
              });
            }
          }
        } catch {}
      }
      if (messages.length > 0) {
        source = cand.label;
        break;
      }
    } catch {}
  }

  if (messages.length === 0) {
    source = 'fts';
    const db = openReadOnlyDb();
    if (db) {
      try {
        const chunks = db
          .prepare(
            `SELECT chunk_index, user_body, agent_body
             FROM conversations_fts
             WHERE conversation_id = ?
             ORDER BY chunk_index ASC`
          )
          .all(conversationId);
        let idx = 0;
        for (const ch of chunks) {
          const u = (ch.user_body || '').trim();
          const a = (ch.agent_body || '').trim();
          if (u) messages.push({ role: 'user', stepIndex: idx++, timestamp: '', content: u });
          if (a) messages.push({ role: 'assistant', stepIndex: idx++, timestamp: '', content: a });
        }
      } finally {
        db.close();
      }
    }
  }

  return {
    ...conv,
    source,
    messageCount: messages.length,
    messages,
  };
}

function buildMarkdownExport(previewData) {
  const lines = [];
  lines.push(`# ${previewData.title}`);
  lines.push('');
  lines.push(`- **Conversation ID**: \`${previewData.id}\``);
  lines.push(`- **所属项目**: ${previewData.project}`);
  lines.push(`- **归档状态**: ${previewData.archived ? '已归档' : '未归档'}`);
  if (previewData.pinned) lines.push(`- **置顶状态**: 已置顶`);
  if (previewData.starred) lines.push(`- **收藏状态**: 已星标收藏`);
  if (previewData.lastModified) lines.push(`- **最后更新**: ${previewData.lastModified}`);
  if (previewData.tags?.length) lines.push(`- **标签**: ${previewData.tags.map((t) => `#${t}`).join(' ')}`);
  if (previewData.note) lines.push(`- **备注**: ${previewData.note}`);
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

// Start Sidecar HTTP app
const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf8'));

app.api('/api/conversations', async (data = {}) => {
  const tab = String(data.tab || 'archived');
  const query = String(data.query || '').trim();
  const queryLower = query.toLowerCase();
  const projectFilter = String(data.project || '').trim();
  const tagFilter = String(data.tag || '').trim();
  const sortBy = String(data.sort || 'updated');
  const staleDays = Math.max(1, Number(data.staleDays) || 7);

  const baseList = (await loadAllConversations()).filter((c) => !c.isSubagent);

  const projectsSet = new Set();
  const tagsSet = new Set();
  for (const c of baseList) {
    if (c.project) projectsSet.add(c.project);
    for (const t of c.tags) tagsSet.add(t);
  }

  const counts = {
    archived: baseList.filter((c) => c.archived).length,
    active: baseList.filter((c) => !c.archived).length,
    starred: baseList.filter((c) => c.starred).length,
    stale: baseList.filter((c) => !c.archived && !c.starred && !c.pinned && !c.isRunning && c.idleDays >= staleDays).length,
    all: baseList.length,
  };

  let filtered = baseList;
  if (tab === 'archived') filtered = filtered.filter((c) => c.archived);
  else if (tab === 'active') filtered = filtered.filter((c) => !c.archived);
  else if (tab === 'starred') filtered = filtered.filter((c) => c.starred);
  else if (tab === 'stale') {
    filtered = filtered.filter((c) => !c.archived && !c.starred && !c.pinned && !c.isRunning && c.idleDays >= staleDays);
  }

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
        const projHit = c.project.toLowerCase().includes(queryLower);
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
    if (sortBy === 'title') return a.title.localeCompare(b.title, 'zh-CN');
    return b.lastModifiedMs - a.lastModifiedMs;
  });

  return {
    items: filtered,
    counts,
    projects: [...projectsSet].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    allTags: [...tagsSet].sort((a, b) => a.localeCompare(b, 'zh-CN')),
  };
});

app.api('/api/preview', async (data = {}) => {
  const id = String(data.conversationId || '').trim();
  if (!id) throw new Error('缺少 conversationId');
  return loadConversationPreview(id);
});

// Single or batch native archive / restore via official ConversationService.UpdateConversation
app.api('/api/set-archived', async (data = {}) => {
  const ids = Array.isArray(data.conversationIds)
    ? data.conversationIds.map((x) => String(x || '').trim()).filter(Boolean)
    : data.conversationId
      ? [String(data.conversationId).trim()]
      : [];
  if (!ids.length) throw new Error('缺少 conversationId');
  const archived = Boolean(data.archived);

  const succeeded = [];
  const failed = [];
  for (const id of ids) {
    try {
      await callConversationService('UpdateConversation', {
        conversationId: id,
        annotations: { archived },
      });
      succeeded.push(id);
    } catch (err) {
      failed.push({ id, error: err.message });
    }
  }
  return { ok: failed.length === 0, archived, succeeded, failed };
});

// Native update of title, pinned, starred, tags + local note persistence
app.api('/api/meta/update', async (data = {}) => {
  const id = String(data.conversationId || '').trim();
  if (!id) throw new Error('缺少 conversationId');

  const nativeAnn = {};
  if (typeof data.title === 'string' && data.title.trim()) nativeAnn.title = data.title.trim().slice(0, 160);
  if (typeof data.starred === 'boolean') nativeAnn.starred = data.starred;
  if (typeof data.pinned === 'boolean') nativeAnn.pinned = data.pinned;
  if (typeof data.archived === 'boolean') nativeAnn.archived = data.archived;

  let cleanTags = null;
  if (Array.isArray(data.tags)) {
    cleanTags = [...new Set(data.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
    if (cleanTags.length > 0) {
      nativeAnn.tags = cleanTags;
    }
  }

  if (Object.keys(nativeAnn).length > 0) {
    await callConversationService('UpdateConversation', {
      conversationId: id,
      annotations: nativeAnn,
    });
  }

  const store = readMetaStore();
  const prev = store.conversations[id] || {};
  const next = { ...prev };
  if (cleanTags !== null) next.tags = cleanTags;
  if (typeof data.note === 'string') next.note = data.note.trim().slice(0, 500);

  if (next.tags === undefined && !next.note) {
    delete store.conversations[id];
  } else {
    store.conversations[id] = next;
  }
  writeMetaStore(store);

  return {
    ok: true,
    conversationId: id,
    annotations: nativeAnn,
    meta: {
      tags: cleanTags !== null ? cleanTags : prev.tags || [],
      note: next.note || '',
    },
  };
});

// Official permanent delete with active-run protection
app.api('/api/delete', async (data = {}) => {
  const id = String(data.conversationId || '').trim();
  if (!id) throw new Error('缺少 conversationId');
  const cur = await callConversationService('GetConversation', { conversationId: id });
  const runState = cur?.conversation?.state?.runState || cur?.state?.runState;
  if (runState === 'RUN_STATE_RUNNING' || runState === 'RUN_STATE_CANCELLING') {
    throw new Error('该会话正在运行中，请先停止后再删除');
  }
  await callConversationService('DeleteConversation', { conversationId: id });
  const store = readMetaStore();
  if (store.conversations[id]) {
    delete store.conversations[id];
    writeMetaStore(store);
  }
  return { ok: true, deletedId: id };
});

app.api('/api/export', async (data = {}) => {
  const id = String(data.conversationId || '').trim();
  if (!id) throw new Error('缺少 conversationId');
  const previewData = await loadConversationPreview(id);
  const markdown = buildMarkdownExport(previewData);
  const dateTag = new Date().toISOString().slice(0, 10);
  const filename = `${dateTag}_${sanitizeFilename(previewData.title)}_${id.slice(0, 8)}.md`;

  if (data.saveToDisk) {
    mkdirSync(EXPORT_DIR, { recursive: true });
    const fullPath = join(EXPORT_DIR, filename);
    writeFileSync(fullPath, markdown, 'utf8');
    return { ok: true, filename, savedPath: fullPath, markdown };
  }
  return { ok: true, filename, markdown };
});

app.api('/api/reveal-file', async (data = {}) => {
  const target = resolve(String(data.path || EXPORT_DIR));
  if (!existsSync(target)) throw new Error(`路径不存在: ${target}`);
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

const cleanupSidebar = startSidebarInjector(getArchivedCountSafe);

process.on('SIGTERM', async () => {
  await cleanupSidebar();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await cleanupSidebar();
  process.exit(0);
});
