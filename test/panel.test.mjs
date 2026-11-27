import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(new URL('../sidecars/archive_manager/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function createPanel(fetch, language) {
  const elements = new Map();
  function makeElement() {
    return {
      style: {}, dataset: {}, handlers: {}, children: [], textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(event, handler) { this.handlers[event] = handler; },
      querySelectorAll() { return []; },
      appendChild(child) { this.children.push(child); },
    };
  }
  function element(id) {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  }

  const context = createContext({
    navigator: { language },
    setTimeout() {}, clearTimeout() {},
    document: {
      body: { contains: () => true }, documentElement: {}, getElementById: element,
      createElement: makeElement, querySelectorAll: () => [],
    },
    window: {
      addEventListener() {},
      sidecar: { fetch: async (path, req) => ({
        ok: true, json: async () => fetch(path, JSON.parse(req.body)),
      }) },
    },
  });
  const run = (code) => runInContext(code, context);
  run(script.replace(/    (?:loadList|initializePanel)\(\);\r?\n    window.addEventListener/, '    window.addEventListener'));
  run("renderList = () => {}; renderPreview = () => { updatePreviewHeaderState(); };");
  run(`const originalShowToast = showToast;
    showToast = (...args) => {
      originalShowToast(...args);
      globalThis.toast = {
        message: $('toastText').textContent,
        label: $('toastAction').textContent,
        action: $('toastAction').onclick,
      };
    };`);
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
  assert.deepEqual(requests[0], { conversationIds: ['stale'], archived: true, staleDays: 14, locale: 'zh-CN' });
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
  assert.deepEqual(requests[1], { undo: changes, locale: 'zh-CN' });
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
  run("showToast(() => '已归档', 'undo', () => {})");
  const archive = run("setConversationsArchived(['B'], true)");
  try {
    assert.equal(undoButton.disabled, true);
  } finally {
    reply.resolve({ succeeded: [], unchanged: ['B'], failed: [], changes: [] });
    await archive;
  }
});

test('the first list request uses the saved language or the WebView default', async () => {
  for (const [webViewLanguage, saved, initialLocale, expected] of [
    ['zh-TW', 'en', 'zh-CN', 'en'],
    ['en-US', null, 'en', 'en'],
    [undefined, null, 'zh-CN', 'zh-CN'],
  ]) {
    const requests = [];
    const { element, run } = createPanel((path, body) => {
      requests.push([path, body.locale]);
      if (path === '/api/preferences') return { language: saved };
      return { items: [] };
    }, webViewLanguage);
    await run('initializePanel()');
    assert.equal(element('languageSelect').value, expected);
    assert.equal(run('document.documentElement.lang'), expected);
    assert.deepEqual(requests, [['/api/preferences', initialLocale], ['/api/conversations', expected]]);
  }
});

test('switching language reloads the current filters and preview without accepting earlier responses', async () => {
  const oldList = deferred();
  const oldPreview = deferred();
  const requests = [];
  const { element, run } = createPanel((path, body) => {
    requests.push([path, body]);
    if (path === '/api/preferences') return { language: body.language };
    if (path === '/api/conversations') return body.locale === 'en'
      ? { items: [{ id: 'A' }], warnings: ['List warning.'], projectOptions: [{ key: 'project:old', label: 'No project' }] }
      : oldList.promise;
    return body.locale === 'en'
      ? { id: 'A', title: '项目原名', source: 'fts', warnings: ['Index fallback.'] }
      : oldPreview.promise;
  });
  run("state.tab = 'all'; state.query = '术语'; state.projectKey = 'project:old'; state.tag = '标签';");
  const listRequest = run('loadList()');
  const previewRequest = run("openPreview('A')");
  element('languageSelect').value = 'en';
  await element('languageSelect').handlers.change();
  oldList.resolve({ items: [], warnings: ['旧警告'] });
  oldPreview.resolve({ id: 'A', title: '旧标题', warnings: ['旧正文警告'] });
  await Promise.all([listRequest, previewRequest]);
  assert.deepEqual(requests[2], ['/api/preferences', { language: 'en', locale: 'en' }]);
  const preview = requests.find(([path, body]) => path === '/api/preview' && body.locale === 'en');
  assert.deepEqual(preview?.[1], { conversationId: 'A', locale: 'en' });
  const list = requests.find(([path, body]) => path === '/api/conversations' && body.locale === 'en');
  assert.deepEqual(list?.[1], {
    tab: 'all', query: '术语', projectKey: 'project:old', groupKey: '', tag: '标签',
    sort: 'updated', staleDays: 7, searchMode: 'literal', page: 1, pageSize: 50,
    includeMatchingIds: false, snapshotId: null, searchClientId: run('searchClientId'), searchSequence: 2, locale: 'en',
  });
  const option = element('projectSelect').children[0];
  assert.equal(option.value, 'project:old');
  assert.equal(option.textContent, 'No project');
  assert.equal(element('projectSelect').value, 'project:old');
  assert.equal(element('listWarning').textContent, 'List warning.');
  assert.equal(element('pvTitle').textContent, '项目原名');
  assert.match(element('pvSource').textContent, /Index.*Index fallback\./);
});

test('language change keeps Undo available in the selected language', async () => {
  const requests = [];
  const changes = [{ id: 'A', previousArchived: false, archived: true }];
  const { element, run } = createPanel((path, body) => {
    if (path === '/api/preferences') return { language: body.language };
    if (path === '/api/conversations') return { items: [] };
    requests.push(body);
    return { succeeded: ['A'], unchanged: [], failed: [], changes };
  });
  await run("setConversationsArchived(['A'], true)");
  assert.equal(element('toastAction').textContent, '撤回');
  element('languageSelect').value = 'en';
  await element('languageSelect').handlers.change();
  assert.equal(element('toastAction').textContent, 'Undo');
  assert.equal(element('toastAction').disabled, false);
  await element('toastAction').onclick();
  assert.deepEqual(requests[1], { undo: changes, locale: 'en' });
});

test('a failed language save leaves the previous language and Undo available', async () => {
  const requests = [];
  const changes = [{ id: 'A', previousArchived: false, archived: true }];
  const { element, run } = createPanel((path, body) => {
    requests.push([path, body]);
    if (path === '/api/preferences') throw new Error('offline');
    if (path === '/api/conversations') return { items: [] };
    return { succeeded: ['A'], unchanged: [], failed: [], changes };
  });
  await run("setConversationsArchived(['A'], true)");
  element('languageSelect').value = 'en';
  await element('languageSelect').handlers.change();
  assert.equal(element('languageSelect').value, 'zh-CN');
  assert.equal(element('languageSelect').disabled, false);
  assert.match(element('languageStatus').textContent, /未能保存界面语言/);
  assert.equal(element('toastAction').textContent, '撤回');
  await element('toastAction').onclick();
  assert.deepEqual(requests.find(([, body]) => body.undo), ['/api/set-archived', { undo: changes, locale: 'zh-CN' }]);
});

test('a rename completed during a language refresh supersedes the preview snapshot', async () => {
  const rename = deferred();
  const englishPreview = deferred();
  const { element, run } = createPanel((path, body) => {
    if (path === '/api/preferences') return { language: body.language };
    if (path === '/api/conversations') return { items: [] };
    if (path === '/api/meta/update') return rename.promise;
    if (body.locale === 'en') return englishPreview.promise;
    return { id: 'A', title: '原来的标题' };
  });
  await run("openPreview('A')");
  const updating = run("updateNativeAnnotation('A', { title: '新标题' }, 'renamed')");
  element('languageSelect').value = 'en';
  const switching = element('languageSelect').handlers.change();
  await new Promise((resolve) => setImmediate(resolve));
  rename.resolve({});
  await updating;
  englishPreview.resolve({ id: 'A', title: '原来的标题' });
  await switching;
  assert.equal(element('pvTitle').textContent, '新标题');
});


test('switching language keeps a pending deletion locked until the request finishes', async () => {
  const deletion = deferred();
  const requests = [];
  const { element, run } = createPanel((path, body) => {
    requests.push([path, body]);
    if (path === '/api/preferences') return { language: body.language };
    if (path === '/api/conversations') return { items: [] };
    if (path === '/api/delete') return deletion.promise;
    return { id: 'A', title: 'Session A', source: 'fts', warnings: [body.locale === 'en' ? 'Index only.' : '仅索引'] };
  });

  await run("openPreview('A')");
  element('pvDeleteBtn').handlers.click();
  const pending = element('deleteConfirmBtn').handlers.click();
  try {
    element('languageSelect').value = 'en';
    await element('languageSelect').handlers.change();
    assert.equal(requests.some(([path, body]) => path === '/api/preview' && body.locale === 'en'), false);
    assert.equal(element('pvDeleteBtn').disabled, true);
    assert.equal(run('state.previewData'), null);
  } finally {
    deletion.reject(new Error('Delete request failed'));
    await pending;
  }
  assert.equal(element('pvDeleteBtn').disabled, false);
  assert.match(element('pvSource').textContent, /Index only\./);
  assert.equal(requests.filter(([path]) => path === '/api/delete').length, 1);
});

test('English brand uses Session Manager and timestamps format in local timezone', () => {
  const { run } = createPanel(() => ({ items: [] }), 'en-US');
  run("applyLocale('en')");
  assert.equal(run('document.title'), 'Session Manager');
  const formatted = run("formatTimestamp('2026-11-26T10:30:00Z')");
  assert.ok(formatted.length > 0);
  assert.equal(formatted.includes('UTC'), false);
});

test('paging counts conversations and retains cross-page checked chats until filters change', async () => {
  const calls = [];
  const { element, run } = createPanel((path, body) => {
    calls.push(body);
    return { page: body.page, total: 51, snapshotId: 'first', items: [{ id: body.page === 2 ? 'B' : 'A', title: 'sample', archived: true }] };
  });
  await run('loadList()');
  assert.equal(calls[0].pageSize, 50);
  run('state.batchMode = true');
  element('selectAllBtn').handlers.click();
  await element('nextPageBtn').handlers.click();
  assert.equal(calls[1].snapshotId, 'first');
  element('selectAllBtn').handlers.click();
  assert.deepEqual(Array.from(run('state.checkedIds')), ['A','B']);
  await element('groupSelect').handlers.change({target:{value:'ungrouped'}});
  assert.equal(calls.at(-1).page, 1);
  assert.equal(calls.at(-1).groupKey, 'ungrouped');
  assert.equal(run('state.checkedIds.size'), 0);
});

test('bulk deletion freezes confirmed IDs and cancellation sends no mutation', async () => {
  const submitted = [];
  const { element, run } = createPanel((path, body) => {
    if (path === '/api/delete-batch') { submitted.push(body.conversationIds); return {deleted:['A'], skipped:[], failed:[], warnings:[]}; }
    return {items:[{id:'A', title:'First', archived:true}],page:1,total:1};
  });
  await run('loadList()');
  run('state.batchMode = true');
  element('selectAllBtn').handlers.click();
  element('batchDeleteBtn').handlers.click();
  element('deleteCancelBtn').handlers.click();
  assert.equal(submitted.length, 0);
  element('batchDeleteBtn').handlers.click();
  run("state.checkedIds.add('late')");
  await Promise.all([element('deleteConfirmBtn').handlers.click(), element('deleteConfirmBtn').handlers.click()]);
  assert.deepEqual(submitted, [['A']]);
});

test('idle cleanup includes all matching chats beyond the current page', async () => {
  const archived = [];
  const { element, run } = createPanel((path, body) => {
    if (path.endsWith('/set-archived')) {archived.push(...body.conversationIds); return {succeeded:[],unchanged:[],failed:[],changes:[]};}
    return {items:[{id:'A'}], page:1,total:51,matchingIds:['A','B']};
  });
  run("state.tab = 'stale'");
  await run('loadList()');
  await element('archiveAllStaleBtn').handlers.click({currentTarget:element('archiveAllStaleBtn')});
  assert.deepEqual(archived, ['A','B']);
});
