#!/usr/bin/env node
// Renders the README hero screenshots (light + dark) from the real panel source.
// The panel runs against a mock `window.sidecar.fetch` with fictional demo data,
// and Antigravity host theme variables are emulated per theme.
//
// Usage: node tools/render-hero.mjs [--browser <path-to-chrome-or-edge>]
// Output: hero and panel screenshots in docs/screenshots.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const panelHtml = readFileSync(join(root, 'sidecars/archive_manager/index.html'), 'utf8');
const outDir = join(root, 'docs/screenshots');

const WIDTH = 1000;
const HEIGHT = 640;
const SCALE = 2;

const themes = {
  light: {
    '--background': '#f8fafc', '--card': '#ffffff', '--sidebar': '#f1f5f9',
    '--foreground': '#0f172a', '--muted-foreground': '#64748b', '--border': '#e2e8f0',
    '--primary': '#6366f1', '--primary-foreground': '#ffffff', 'color-scheme': 'light',
  },
  dark: {
    '--background': '#0b0e14', '--card': '#121620', '--sidebar': '#0f131b',
    '--foreground': '#e2e8f0', '--muted-foreground': '#8b95a7', '--border': '#232a37',
    '--primary': '#818cf8', '--primary-foreground': '#0b0e14', 'color-scheme': 'dark',
  },
};

function findBrowser() {
  const i = process.argv.indexOf('--browser');
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('No Chrome/Edge found. Pass --browser <path> or set CHROME_PATH.');
  return hit;
}

// Fictional demo data, shaped like the real /api responses.
function mockScript() {
  const now = Date.now();
  const h = 3600_000;
  const item = (id, title, project, hoursAgo, steps, extra = {}) => ({
    id, title, project, projectKey: 'project:' + project, projectLabel: project, stepCount: steps,
    lastModifiedMs: now - hoursAgo * h, lastModified: new Date(now - hoursAgo * h).toISOString(),
    archived: false, pinned: false, starred: false, isRunning: false, tags: [], note: '', summary: '', matchSnippet: '',
    ...extra,
  });
  const items = [
    item('c1', 'Antigravity Sidecar 架构与 API 调研', 'demo-workspace', 2, 42,
      { pinned: true, starred: true, tags: ['架构', 'Sidecar'], note: '已确认官方 ConversationService Connect API 调用规范' }),
    item('c2', 'Multi-Agent Task Orchestration Pipeline', 'agent-sdk', 3, 86, { pinned: true, isRunning: true, tags: ['Workflow'] }),
    item('c3', 'TypeScript AST Refactoring Helper', 'demo-workspace', 6, 64, { starred: true, tags: ['TypeScript'] }),
    item('c4', 'Docker Compose Local Dev Environment', 'infra-kit', 26, 29, { tags: ['Docker'] }),
    item('c5', 'README 美化与双主题主图', 'archive-manager', 30, 18, { tags: ['Docs'] }),
    item('c6', 'Sidecar 安装与自定义端口笔记', 'demo-workspace', 96, 33, { archived: true, tags: ['Sidecar'] }),
    item('c7', 'Sidecar 导出目录验证', 'archive-manager', 120, 19, { archived: true, tags: ['Sidecar'] }),
  ];
  const messages = [
    { role: 'user', timestamp: '2026-11-26 15:10:12',
      content: '帮我梳理一下 Antigravity 插件 Sidecar 的进程生命周期、本地只读索引以及官方 ConversationService API 的调用方式。' },
    { role: 'assistant', timestamp: '2026-11-26 15:11:05', content: [
      '已经帮你完整梳理好 **Antigravity Sidecar 架构要点**，核心分为以下四层：',
      '',
      '### 1. Sidecar 托管与通信协议',
      '- 宿主会依据 `sidecars/<id>/sidecar.json` 自动拉起 Node.js 进程，并注入 `ANTIGRAVITY_LS_ADDRESS`。',
      '- 前端页面通过内置 `/preload.js` 提供的 `window.sidecar.fetch(...)` 安全访问本地 API。',
      '',
      '### 2. 官方 ConversationService Connect 接口',
      '- `ListConversations`：拉取全量活跃与已归档会话元信息及置顶/星标状态。',
      '- `UpdateConversation`：原地更新 `archived`、`pinned`、`starred` 与重命名 `title`。',
      '- `DeleteConversation`：先核验 `runState`，拦截运行中会话防止误删。',
      '',
      '### 3. 本地只读索引与正文读取策略',
      '- 检索摘要：以只读模式打开 `conversation_summaries.db` 中的 `conversations_fts` 虚表。',
      '- 正文预览：优先解析 `transcript_full.jsonl`，缺失时回退 `transcript.jsonl` 与 FTS 分片。',
      '',
      '### 4. 数据持久化隔离',
      '- 原生标签写入后读回核对，个人备注在 Sidecar 数据目录原子保存。',
    ].join('\n') },
  ];
  const stats = Object.fromEntries(items.map((item, i) => [item.id, {
    turnCount: 8 + i, turnStatus: 'complete', fileCount: 3 + i, sizeBytes: 230000 * (i + 1), storageStatus: 'complete',
  }]));
  const previews = Object.fromEntries(items.map((x) => [x.id,
    { ...x, source: 'transcript_full', warnings: [], messageCount: messages.length, messages }]));
  return `<script>
    (() => {
      const items = ${JSON.stringify(items)};
      const previews = ${JSON.stringify(previews)};
      const stats = ${JSON.stringify(stats)};
      const counts = { archived: 2, active: 5, starred: 2, stale: 0, all: items.length, trash: 0 };
      const api = {
        '/api/preferences': () => ({
          language: 'zh-CN',
          exportDir: '~/Documents/Antigravity-Exports',
          defaultExportDir: '~/Documents/Antigravity-Exports',
          trashRetentionDays: 7,
          trashSummary: { totalCount: 0, expiredCount: 0 },
        }),
        '/api/conversations': ({ tab, query, projectKey }) => {
          const filtered = items.filter(item => item.archived === (tab === 'archived') &&
            (!query || item.title.toLowerCase().includes(query.toLowerCase())));
          const scoped = projectKey ? filtered.filter(item => item.projectKey === projectKey) : filtered;
          const groupMap = new Map();
          for (const it of filtered) {
            const existing = groupMap.get(it.projectKey);
            if (!existing) {
              groupMap.set(it.projectKey, { key: it.projectKey, label: it.projectLabel, total: 1, lastModified: it.lastModified, lastModifiedMs: it.lastModifiedMs });
            } else {
              existing.total++;
              if (it.lastModifiedMs > existing.lastModifiedMs) {
                existing.lastModified = it.lastModified;
                existing.lastModifiedMs = it.lastModifiedMs;
              }
            }
          }
          const groups = [...groupMap.values()]
            .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs)
            .map(({ key, label, total, lastModified }) => ({ key, label, total, lastModified }));
          return { items: projectKey ? scoped : [], groups, counts, warnings: [], snapshotId: tab + ':' + (query || ''),
            groupOptions: [], page: 1, pageSize: 50, total: scoped.length,
            allTags: [...new Set(items.flatMap(item => item.tags))] };
        },
        '/api/preview': ({ conversationId }) => previews[conversationId],
        '/api/conversation-stats': ({ conversationIds }) => ({ stats: Object.fromEntries(conversationIds.map(id => [id, stats[id]])) }),
      };
      window.sidecar = { fetch: async (path, req) => {
        const data = api[path] ? api[path](JSON.parse(req?.body || '{}')) : { ok: true };
        return { ok: true, status: 200, json: async () => data };
      } };
    })();
  </script>`;
}
function buildPage(theme, view) {
  const vars = Object.entries(themes[theme]).map(([k, v]) => `${k}: ${v};`).join(' ');
  const head = `<style>:root { ${vars} } *, *::before, *::after { transition: none !important; animation: none !important; }</style>${mockScript()}`;
  const autoOpen = view === 'archived' ? `<script>
    setTimeout(() => document.querySelector('[data-tab=archived]').click(), 250);
    setTimeout(() => {
      const search = document.querySelector('#searchInput');
      search.value = 'Sidecar';
      search.dispatchEvent(new Event('input'));
    }, 550);
    setTimeout(() => openPreview('c6'), 1150);
  </script>` : `<script>
    if (${view === 'workspaces'}) {
      setTimeout(() => document.querySelector('.workspace-toggle[aria-expanded=false]')?.click(), 250);
    }
    setTimeout(() => openPreview('c1'), 450);
  </script>`;
  return panelHtml
    .replace('<script src="/preload.js"></script>', head)
    .replace(/<\/body>/i, `${autoOpen}</body>`);
}

const browser = findBrowser();
const work = mkdtempSync(join(tmpdir(), 'am-hero-'));
try {
  const screenshots = [
    ['hero-light', 'light', 'active'], ['hero-dark', 'dark', 'active'],
    ['preview-main', 'light', 'workspaces'], ['preview-archived', 'light', 'archived'],
  ];
  for (const [name, theme, view] of screenshots) {
    const page = join(work, `${name}.html`);
    writeFileSync(page, buildPage(theme, view));
    const out = join(outDir, `${name}.png`);
    execFileSync(browser, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      `--user-data-dir=${join(work, 'profile')}`,
      `--window-size=${WIDTH},${HEIGHT}`, `--force-device-scale-factor=${SCALE}`,
      '--virtual-time-budget=4000', `--screenshot=${out}`, pathToFileURL(page).href,
    ], { stdio: 'inherit' });
    console.log(`[OK] ${out}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
