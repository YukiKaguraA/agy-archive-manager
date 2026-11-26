import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(new URL('../sidecars/archive_manager/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function createPanel(fetch) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        style: {}, handlers: {},
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(event, handler) { this.handlers[event] = handler; },
        querySelectorAll() { return []; },
        appendChild() {},
      });
    }
    return elements.get(id);
  }

  const context = createContext({
    document: { body: { contains: () => true }, getElementById: element },
    window: {
      addEventListener() {},
      sidecar: { fetch: async (path, req) => ({
        ok: true, json: async () => fetch(path, JSON.parse(req.body)),
      }) },
    },
  });
  const run = (code) => runInContext(code, context);
  run(script.replace('    loadList();\n    window.addEventListener', '    window.addEventListener'));
  run("renderList = () => {}; renderPreview = () => { updatePreviewHeaderState(); };");
  run("showToast = (message, label, action) => { globalThis.toast = { message, label, action }; };");
  return { element, run };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('opening another preview clears previous data and disables the delete button', async () => {
  const response = deferred();
  const { element, run } = createPanel(() => response.promise);
  run("state.previewData = { id: 'old', title: 'old' };");
  element('pvDeleteBtn').handlers.click();
  const request = run("openPreview('new')");
  assert.equal(run('state.previewData'), null);
  assert.equal(run('state.pendingDeleteId'), null);
  assert.equal(element('pvDeleteBtn').disabled, true);
  response.resolve({ id: 'new', title: 'new' });
  await request;
  assert.equal(element('pvDeleteBtn').disabled, false);
});

test('a late preview response cannot replace the most recently selected session', async () => {
  const replies = { A: deferred(), B: deferred() };
  const { run } = createPanel((_, { conversationId }) => replies[conversationId].promise);
  const first = run("openPreview('A')");
  const second = run("openPreview('B')");
  replies.B.resolve({ id: 'B' });
  await second;
  replies.A.resolve({ id: 'A' });
  await first;
  assert.equal(run('state.previewData.id'), 'B');
});

test('failed preview stays disabled and cannot target the previous session', async () => {
  const { run, element } = createPanel(async () => { throw new Error('offline'); });
  run("state.previewData = { id: 'old', title: 'old' };");
  await run("openPreview('new')");
  assert.equal(run('state.previewData'), null);
  assert.equal(element('pvDeleteBtn').disabled, true);
  element('pvDeleteBtn').handlers.click();
  assert.equal(run('state.pendingDeleteId'), null);
});

test('a late list response cannot become the input to stale cleanup', async () => {
  const replies = { active: deferred(), stale: deferred() };
  const requests = [];
  const { element, run } = createPanel((url, payload) => {
    if (url === '/api/conversations') return replies[payload.tab].promise;
    requests.push(payload);
    return { succeeded: [], failed: [], unchanged: [], changes: [] };
  });
  const old = run("state.tab = 'active'; loadList()");
  const latest = run("state.tab = 'stale'; state.staleDays = 14; loadList()");
  assert.equal(element('archiveAllStaleBtn').disabled, true);
  replies.stale.resolve({ items: [{ id: 'stale' }] });
  await latest;
  replies.active.resolve({ items: [{ id: 'recent' }] });
  await old;
  assert.equal(run('state.items[0].id'), 'stale');
  assert.equal(element('archiveAllStaleBtn').disabled, false);
  await element('archiveAllStaleBtn').handlers.click({ currentTarget: element('archiveAllStaleBtn') });
  assert.deepEqual(requests[0], { conversationIds: ['stale'], archived: true, staleDays: 14 });
});

test('a failed list refresh disables stale cleanup and bulk actions', async () => {
  const { element, run } = createPanel(async () => { throw new Error('offline'); });
  run("state.tab = 'stale'; state.items = [{ id:'old' }]; state.checkedIds.add('old'); updateBatchBar();");
  await run('loadList()');
  assert.equal(run('state.items.length'), 0);
  assert.equal(element('archiveAllStaleBtn').disabled, true);
  assert.equal(element('batchArchiveBtn').disabled, true);
  assert.equal(element('batchRestoreBtn').disabled, true);
});

test('partial batch failure is visible and undo sends only the recorded changes', async () => {
  const requests = [];
  const changes = [{ id: 'active', previousArchived: false, archived: true }];
  const { run } = createPanel((path, body) => {
    if (path === '/api/conversations') return { items: [] };
    requests.push(body);
    if (body.undo) return { succeeded: ['active'], unchanged: [], failed: [], changes: [] };
    return {
      succeeded: ['active'],
      unchanged: ['archived'],
      failed: [{ id: 'blocked', error: '会话正在运行' }],
      changes,
    };
  });
  await run("setConversationsArchived(['active','archived','blocked'], true)");
  assert.match(run('toast.message'), /成功 1 条.*失败 1 条.*会话正在运行/);
  assert.equal(run('toast.label'), '撤回');
  await run('toast.action()');
  assert.deepEqual(requests[1], { undo: changes });
});

test('preview displays its transcript source and any warning', async () => {
  const { element, run } = createPanel(async () => ({
    id: 'A', title: 'A', source: 'fts', warnings: ['正文仅来自索引片段'],
  }));
  await run("openPreview('A')");
  assert.match(element('pvSource').textContent, /索引.*正文仅来自索引片段/);
  assert.equal(element('pvSource').hidden, false);
});

test('preview hides source status bar for healthy full transcripts', async () => {
  const { element, run } = createPanel(async () => ({
    id: 'A', title: 'A', source: 'transcript_full', warnings: [],
  }));
  await run("openPreview('A')");
  assert.equal(element('pvSource').hidden, true);
  assert.equal(element('pvSource').textContent, '');
});


test('undo is offered while the post-mutation list refresh is pending', async () => {
  const refresh = deferred();
  const { run } = createPanel((path) => {
    if (path === '/api/conversations') return refresh.promise;
    return { succeeded: ['A'], unchanged: [], failed: [],
      changes: [{ id: 'A', previousArchived: false, archived: true }] };
  });
  const archive = run("setConversationsArchived(['A'], true)");
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(run('globalThis.toast?.label'), '撤回');
    assert.equal(run('state.archivePending'), false);
  } finally {
    refresh.resolve({ items: [] });
    await archive;
  }
});

test('an archive result supersedes a preview that was requested before the archive', async () => {
  const oldPreview = deferred();
  const native = deferred();
  let previews = 0;
  const { run } = createPanel((path) => {
    if (path === '/api/set-archived') return native.promise;
    if (path === '/api/conversations') return { items: [] };
    if (++previews === 1) return oldPreview.promise;
    return { id: 'A', archived: true };
  });
  const preview = run("openPreview('A')");
  const archive = run("setConversationsArchived(['A'], true)");
  native.resolve({ succeeded: ['A'], unchanged: [], failed: [],
    changes: [{ id: 'A', previousArchived: false, archived: true }] });
  await archive;
  oldPreview.resolve({ id: 'A', archived: false });
  await preview;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run('state.previewData.archived'), true);
});

test('an unchanged archive result corrects an out-of-date preview state', async () => {
  const { run } = createPanel((path) => path === '/api/set-archived'
    ? { succeeded: [], unchanged: ['A'], failed: [], changes: [] }
    : { items: [] });
  run("state.selectedId = 'A'; state.previewData = { id: 'A', archived: false };");
  await run("setConversationsArchived(['A'], true)");
  assert.equal(run('state.previewData.archived'), true);
});


test('the previous undo button is disabled during a second archive request', async () => {
  const reply = deferred();
  const { run, element } = createPanel((path) => path === '/api/conversations'
    ? { items: [] }
    : reply.promise);
  const undoButton = element('toastAction');
  undoButton.textContent = '撤回';
  undoButton.disabled = false;
  const archive = run("setConversationsArchived(['B'], true)");
  try {
    assert.equal(undoButton.disabled, true);
  } finally {
    reply.resolve({ succeeded: [], unchanged: ['B'], failed: [], changes: [] });
    await archive;
  }
});

