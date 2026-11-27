import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(new URL('../sidecars/archive_manager/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function createPanel(fetch, language, { renderCards = false, IntersectionObserver } = {}) {
  const elements = new Map();
  const windowHandlers = {};
  function makeElement() {
    return {
      style: { setProperty() {} }, dataset: {}, handlers: {}, children: [], textContent: '',
      set innerHTML(value) { this.children = []; this.markup = value; },
      get innerHTML() { return this.markup; },
      focus() { context.document.activeElement = this; },
      getBoundingClientRect() { return { top: 10, bottom: 12, height: 2 }; },
      scrollBy() { this.scrolled = (this.scrolled ?? 0) + 1; },
      removeAttribute(name) { delete this[name]; },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(event, handler) { this.handlers[event] = handler; },
      querySelectorAll() { return []; },
      querySelector(selector) {
        if (!this.namedChildren) this.namedChildren = new Map();
        if (!this.namedChildren.has(selector)) this.namedChildren.set(selector, makeElement());
        return this.namedChildren.get(selector);
      },
      appendChild(child) { this.children.push(child); },
      insertBefore(child, before) { const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, child); },
    };
  }
  function element(id) {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  }

  const context = createContext({
    navigator: { language }, queueMicrotask, IntersectionObserver,
    setTimeout() {}, clearTimeout() {},
    document: {
      body: { contains: () => true },
      documentElement: {
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
      },
      getElementById: element,
      createElement: makeElement, querySelectorAll: () => [],
    },
    window: {
      addEventListener(event, handler) { windowHandlers[event] = handler; },
      sidecar: { fetch: async (path, req) => ({
        ok: true, json: async () => fetch(path, JSON.parse(req.body)),
      }) },
    },
  });
  const run = (code) => runInContext(code, context);
  run(script.replace(/    (?:loadList|initializePanel)\(\);\r?\n    window.addEventListener/, '    window.addEventListener'));
  if (!renderCards) run("renderList = () => {};");
  run("renderPreview = () => { updatePreviewHeaderState(); };");
  run(`const originalShowToast = showToast;
    showToast = (...args) => {
      originalShowToast(...args);
      globalThis.toast = {
        message: $('toastText').textContent,
        label: $('toastAction').textContent,
        action: $('toastAction').onclick,
      };
    };`);
  return { element, run, windowHandlers };
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
    ['zh-TW', 'en', 'zh-TW', 'en'],
    ['zh-TW', null, 'zh-TW', 'zh-TW'],
    ['zh-Hant', null, 'zh-TW', 'zh-TW'],
    ['zh-HK', null, 'zh-TW', 'zh-TW'],
    ['zh-MO', null, 'zh-TW', 'zh-TW'],
    ['zh-Hans-TW', null, 'zh-CN', 'zh-CN'],
    ['zh-Hant-CN', null, 'zh-TW', 'zh-TW'],
    ['ja-JP', null, 'ja', 'ja'],
    ['ja', 'zh-CN', 'ja', 'zh-CN'],
    ['en-US', 'ja', 'en', 'ja'],
    ['en-US', 'zh-TW', 'en', 'zh-TW'],
    ['ko-KR', null, 'en', 'en'],
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
      ? { items: [{ id: 'A' }], warnings: ['List warning.'], groupOptions: [{ key: 'group:old', label: 'Native group' }] }
      : oldList.promise;
    return body.locale === 'en'
      ? { id: 'A', title: '项目原名', source: 'fts', warnings: ['Index fallback.'] }
      : oldPreview.promise;
  });
  run("state.tab = 'all'; state.query = '术语'; state.tag = '标签';");
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
    grouped: true, tab: 'all', query: '术语', groupKey: '', tag: '标签',
    sort: 'updated', staleDays: 7, searchMode: 'literal', page: 1, pageSize: 50,
    includeMatchingIds: false, snapshotId: null, searchClientId: run('searchClientId'), searchSequence: 2, locale: 'en',
  });
  const option = element('groupSelect').children[0];
  assert.equal(option.value, 'group:old');
  assert.equal(option.textContent, 'Native group');
  assert.equal(element('groupSelect').hidden, false);
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
    if (path === '/api/trash') return deletion.promise;
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
  assert.equal(requests.filter(([path]) => path === '/api/trash').length, 1);
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
    if (!body.projectKey) return { groups: [{ key: 'one', label: 'One', total: 51 }], snapshotId: 'first' };
    return { page: body.page, total: 51, items: [{ id: body.page === 2 ? 'B' : 'A', title: 'sample', archived: true }] };
  }, 'en', { renderCards: true });
  await run('loadList()');
  assert.equal(calls[0].pageSize, 50);
  run('state.batchMode = true');
  element('selectAllBtn').handlers.click();
  const pager = element('listPane').children[0].children[1].children.at(-1);
  await pager.children.at(-1).handlers.click();
  assert.equal(calls[2].snapshotId, 'first');
  assert.equal(calls[2].page, 2);
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
    if (path === '/api/trash') { submitted.push(body.conversationIds); return {succeeded:['A'], failed:[], warnings:[]}; }
    return {items:[{id:'A', title:'First', archived:true}],page:1,total:1};
  });
  run("state.tab = 'archived'; state.batchMode = true");
  await run('loadList()');
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

test('keywords highlight matches multiple non-adjacent terms without corrupting HTML tags and updates preview on mode switch', async () => {
  let renderPreviewCalls = 0;
  const { element, run } = createPanel(() => ({ items: [] }));
  run('renderPreview = () => { globalThis.__renderPreviewCalls = (globalThis.__renderPreviewCalls || 0) + 1; };');
  run("state.searchMode = 'keywords';");
  const highlighted = run(`highlightText('<span>alpha middle beta</span> <a href="https://example.com">beta link</a> <code>alpha</code>', 'alpha beta')`);
  assert.equal(highlighted, '<span><mark>alpha</mark> middle <mark>beta</mark></span> <a href="https://example.com"><mark>beta</mark> link</a> <code><mark>alpha</mark></code>');
  const tagSafe = run(`highlightText('<a href="https://example.com">href text</a>', 'href a')`);
  assert.equal(tagSafe, '<a href="https://example.com"><mark>href</mark> text</a>');
  run("state.previewData = { id: 'p1', messages: [] };");
  await element('searchModeSelect').handlers.change({ target: { value: 'literal' } });
  renderPreviewCalls = run('globalThis.__renderPreviewCalls');
  assert.equal(renderPreviewCalls, 1);
  assert.equal(run('state.searchMode'), 'literal');
});

test('groupSelect hides without native groups and vanished active filters keep fallback selections', async () => {
  let payload = {
    items: [],
    groupOptions: [{ key: 'ungrouped', label: 'Ungrouped' }],
    allTags: ['t1'],
  };
  const { element, run } = createPanel(() => payload);
  await run('loadList()');
  assert.equal(element('groupSelect').hidden, true);

  payload = {
    items: [],
    groupOptions: [{ key: 'group:eng', label: 'eng' }, { key: 'ungrouped', label: 'Ungrouped' }],
    allTags: [],
  };
  run("state.tag = 'goneTag'; state.groupKey = 'group:gone';");
  await run('loadList()');
  assert.equal(element('groupSelect').hidden, false);
  assert.equal(element('groupSelect').value, 'group:gone');
  assert.equal(element('groupSelect').children.at(-1).value, 'group:gone');
  assert.equal(element('tagSelect').value, 'goneTag');
  assert.equal(element('tagSelect').children.at(-1).value, 'goneTag');
});

test('Active is the first tab and the default list query keeps unarchived chats', async () => {
  const tabs = [...html.matchAll(/class="(tab-btn[^"]*)" data-tab="([^"]+)"/g)].map(([, style, tab]) => [style, tab]);
  assert.deepEqual(tabs.map(([, tab]) => tab), ['active', 'archived', 'starred', 'all', 'stale', 'trash']);
  assert.deepEqual(tabs.filter(([style]) => style.split(' ').includes('active')).map(([, tab]) => tab), ['active']);
  const chats = [{ id: 'idle', archived: false }, { id: 'running', archived: false, isRunning: true }, { id: 'old', archived: true }];
  const { run } = createPanel((path, body) => {
    if (path === '/api/preferences') return { language: null };
    assert.equal(body.tab, 'active');
    assert.equal(body.page, 1);
    if (!body.projectKey) return { groups: [{ key: 'one', label: 'One', total: 2 }], snapshotId: 'snapshot' };
    return { items: chats.filter(chat => !chat.archived) };
  });
  await run('initializePanel()');
  assert.equal(run("state.items.map(chat => chat.id).join(',')"), 'idle,running');
  assert.match(run("t('activeTab')"), /活跃/);
});

test('the four panel dictionaries fully cover the same set of strings and functions', () => {
  const { run } = createPanel(() => ({}));
  assert.deepEqual(Array.from(run('Object.keys(messages)')), ['zh-CN', 'en', 'zh-TW', 'ja']);
  for (const locale of ['en', 'zh-TW', 'ja']) {
    assert.equal(run("Object.keys(messages['zh-CN']).sort().join()"), run("Object.keys(messages['" + locale + "']).sort().join()"));
    assert.equal(run("Object.entries(messages['" + locale + "']).every(([key,value]) => typeof value === typeof messages['zh-CN'][key] && !!value)"), true);
  }
});

test('switching to a new locale keeps the selected archive view on refresh', async () => {
  const calls = [];
  const { element, run } = createPanel((path, body) => {
    calls.push([path, body]);
    if (path === '/api/preferences') return { language: body.language };
    return { items: [] };
  });
  run("state.tab = 'archived'");
  for (const [locale, label] of [['zh-TW', '使用者'], ['ja', 'ユーザー']]) {
    element('languageSelect').value = locale;
    await element('languageSelect').handlers.change();
    assert.equal(run('document.documentElement.lang'), locale);
    assert.match(run("t('userRole')"), new RegExp(label));
    assert.equal(calls.at(-1)[1].tab, 'archived');
    assert.equal(calls.at(-1)[1].locale, locale);
  }
});

test('grouped list requests only the newest workspace until another is expanded and resets after search', async () => {
  const calls = [];
  const { run, element } = createPanel((path, body) => {
    if (path === '/api/conversation-stats') return { stats: {} };
    calls.push(body);
    if (!body.projectKey) return { groups: [
      { key: 'old', label: 'Same', total: 51, lastModified: '2026-11-01' },
      { key: 'new', label: 'Same', total: 1, lastModified: '2026-11-02' },
    ], snapshotId: 'root' };
    return { items: [{ id: body.projectKey }], total: body.projectKey === 'old' ? 51 : 1, page: body.page };
  }, 'en', { renderCards: true });
  await run('loadList()');
  assert.equal(calls[0].grouped, true);
  assert.deepEqual(calls.map(call => call.projectKey), [undefined, 'new']);
  assert.equal(calls[1].snapshotId, 'root');
  const firstGroup = element('listPane').children[0].children[0];
  assert.equal(firstGroup.type, 'button');
  assert.equal(firstGroup['aria-expanded'], false);
  await firstGroup.handlers.click();
  assert.equal(firstGroup['aria-expanded'], true);
  assert.equal(calls[2].projectKey, 'old');
  assert.equal(calls[2].snapshotId, 'root');
  firstGroup.handlers.click();
  await run("state.query = 'needle'; loadList()");
  assert.deepEqual(calls.slice(-2).map(call => call.projectKey).sort(), ['new', 'old']);
  await run("state.query = ''; loadList()");
  assert.equal(run('state.items.map(i => i.id).join()'), 'new');
});

test('settings hides the session surfaces and preserves the search and tab', async () => {
  const { element, run } = createPanel(() => ({ groups: [] }));
  run("state.query = 'needle'; state.tab = 'trash'");
  element('settingsBtn').handlers.click();
  assert.equal(element('libraryTools').hidden, true);
  assert.equal(element('mainSplit').hidden, true);
  element('libraryBtn').handlers.click();
  assert.equal(element('libraryTools').hidden, false);
  assert.equal(run('state.query'), 'needle');
  assert.equal(run('state.tab'), 'trash');
});

test('statistics describe partial counts and retain precise byte totals', () => {
  const { run } = createPanel(() => ({}), 'en');
  assert.match(run("formatTurns({turnCount: 2, turnStatus: 'partial'})"), /at least 2/i);
  assert.match(run("formatStorage({fileCount: 3, sizeBytes: 1048576, storageStatus: 'partial'}).label"), /3.*1 MiB.*partial/i);
  assert.match(run("formatStorage({fileCount: 3, sizeBytes: 1048576, storageStatus: 'partial'}).title"), /1,048,576/);
});

test('statistics are requested for intersecting cards only and discard work after switching surfaces', async () => {
  let observer;
  const old = deferred();
  const calls = [];
  class Observer {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const { run, element } = createPanel((path, body) => {
    if (path === '/api/conversation-stats') {
      calls.push(body);
      return calls.length === 1 ? old.promise : {
        stats: { a: { turnCount: 3, turnStatus: 'complete' } },
      };
    }
    if (!body.projectKey) return { snapshotId: 'current', groups: [{ key: 'one', label: 'One', total: 2 }] };
    return { items: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], total: 2 };
  }, 'en', { IntersectionObserver: Observer, renderCards: true });
  await run('loadList()');
  const firstCard = () => element('listPane').children[0].children[1].children[0];
  assert.equal(calls.length, 0);
  observer.callback([{ target: firstCard(), isIntersecting: true }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls[0], { conversationIds: ['a'], snapshotId: 'current', locale: 'en' });
  element('settingsBtn').handlers.click();
  element('libraryBtn').handlers.click();
  observer.callback([{ target: firstCard(), isIntersecting: true }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(firstCard().querySelector('.card-turns').textContent, '3 turns');
  old.resolve({ stats: { a: { turnCount: 9, turnStatus: 'complete' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(firstCard().querySelector('.card-turns').textContent, '3 turns');
});

test('trash only exposes restore and permanent delete and displays a failing item by name', async () => {
  const actions = [];
  const { run, element } = createPanel((path, body) => {
    if (path === '/api/preview') return { id: 'A', title: 'A', archived: true, trashedAt: 1400000000000, purgeAt: 1400604800000 };
    if (path === '/api/conversations') return { groups: [] };
    actions.push([path, body.conversationIds]);
    return { succeeded: [], failed: [{ id: 'A', error: 'Still running' }] };
  }, 'zh-CN');
  run("state.tab = 'trash'");
  await run("openPreview('A')");
  assert.equal(element('pvOpenBtn').hidden, true);
  assert.equal(element('pvRenameBtn').hidden, true);
  assert.match(element('pvTrashInfo').textContent, /自动清理时间/);
  element('pvDeleteBtn').handlers.click();
  assert.match(element('deleteModalDesc').textContent, /彻底删除.*1.*条/);
  await element('deleteConfirmBtn').handlers.click();
  assert.deepEqual(actions[0], ['/api/purge-trash', ['A']]);
  assert.match(element('batchDetails').textContent, /A.*Still running/);
  await element('pvArchiveToggleBtn').handlers.click({});
  assert.deepEqual(actions[1], ['/api/restore-trash', ['A']]);
});

test('a page from a different snapshot refreshes workspace headers before showing any cards', async () => {
  let snapshot = 'old';
  const calls = [];
  const { run } = createPanel((path, body) => {
    calls.push(body);
    if (!body.projectKey) return { snapshotId: snapshot, groups: [{ key: 'one', label: snapshot, total: 1 }] };
    if (snapshot === 'old') {
      snapshot = 'new';
      return { snapshotId: snapshot, items: [{ id: 'out-of-date' }], total: 1 };
    }
    return { snapshotId: snapshot, items: [{ id: 'current' }], total: 1 };
  });
  await run('loadList()');
  assert.equal(run('state.groups[0].label'), 'new');
  assert.equal(run('state.items[0].id'), 'current');
  assert.equal(calls[2].snapshotId, null);
});

test('clearSearchBtn precedes searchModeSelect, stale button shows total count, and settings skips focus refresh', async () => {
  assert.ok(html.indexOf('id="clearSearchBtn"') < html.indexOf('id="searchModeSelect"'));
  let convCalls = 0;
  let focusHandler = null;
  const elements = new Map();
  function makeEl() {
    return {
      style: {}, dataset: {}, handlers: {}, children: [], textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute(n, v) { this[n] = v; },
      removeAttribute(n) { delete this[n]; },
      addEventListener(ev, fn) { this.handlers[ev] = fn; },
      querySelectorAll() { return []; },
      appendChild(c) { this.children.push(c); },
      focus() {},
    };
  }
  const el = id => {
    if (!elements.has(id)) elements.set(id, makeEl());
    return elements.get(id);
  };
  const { createContext, runInContext } = await import('node:vm');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const ctx = createContext({
    navigator: { language: 'en' },
    setTimeout() {}, clearTimeout() {},
    document: {
      body: { contains: () => true }, documentElement: {}, getElementById: el,
      createElement: makeEl, querySelectorAll: () => [],
    },
    window: {
      addEventListener(ev, fn) { if (ev === 'focus') focusHandler = fn; },
      sidecar: { fetch: async (path) => {
        if (path === '/api/conversations') {
          convCalls++;
          return { ok: true, json: async () => ({ groups: [], items: [{ id: 's1' }], matchingIds: ['s1', 's2', 's3'] }) };
        }
        return { ok: true, json: async () => ({ language: 'en' }) };
      } },
    },
  });
  runInContext(script.replace(/    initializePanel\(\);\r?\n    window\.addEventListener/, '    window.addEventListener'), ctx);
  runInContext("state.tab = 'stale'; state.locale = 'en';", ctx);
  await runInContext('loadList()', ctx);
  assert.match(el('archiveAllStaleBtn').textContent, /\(3\)$/);

  const beforeFocus = convCalls;
  el('languageSelect').disabled = false;
  el('settingsBtn').handlers.click();
  focusHandler();
  assert.equal(convCalls, beforeFocus);
});

test('settings reads and writes export and retention preferences independently', async () => {
  const requests = [];
  const preferences = {
    language: 'en', exportDir: 'D:\\Exports', defaultExportDir: 'D:\\Default',
    trashRetentionDays: 7, trashSummary: { totalCount: 4, expiredCount: 1 },
  };
  const { element, run } = createPanel((path, body) => {
    if (path === '/api/conversations') return { groups: [] };
    requests.push([path, body]);
    return { ...preferences, ...body, ...(body.trashRetentionDays ? { dueCount: 3 } : {}) };
  }, 'en');
  await run('initializePanel()');
  assert.equal(element('exportDirInput').value, preferences.exportDir);
  assert.match(element('trashSummary').textContent, /4.*1/);
  element('exportDirInput').value = 'relative';
  await element('exportDirForm').handlers.submit({ preventDefault() {} });
  assert.equal(requests.length, 1);
  element('exportDirInput').value = 'D:\\Another';
  await element('exportDirForm').handlers.submit({ preventDefault() {} });
  assert.deepEqual(requests.at(-1), ['/api/preferences', { exportDir: 'D:\\Another', locale: 'en' }]);
  element('trashRetentionInput').value = '3';
  await element('trashRetentionForm').handlers.submit({ preventDefault() {} });
  assert.deepEqual(requests.at(-1), ['/api/preferences', { trashRetentionDays: 3, locale: 'en' }]);
  assert.match(element('trashSettingsStatus').textContent, /3.*next/i);
});

test('first workspace follows recency within assigned groups and scrolls once', async () => {
  const groups = [
    { key: 'old', label: 'Old', total: 1, lastModified: '2026-01-01' },
    { key: 'new', label: 'New', total: 1, lastModified: '2026-02-01' },
    { key: 'unassigned', label: 'No project', total: 1, lastModified: '2026-03-01' },
  ];
  const { element, run } = createPanel((_, body) => body.projectKey ? { items: [] } : { groups }, 'en', { renderCards: true });
  const pane = element('listPane');
  pane.getBoundingClientRect = () => ({ top: 0, bottom: 6, height: 6 });
  await run('loadList()');
  let toggles = pane.children.map(section => section.children[0]);
  assert.deepEqual(toggles.map(toggle => toggle['aria-expanded']), [false, true, false]);
  assert.match(toggles[1].children[0].innerHTML, /<svg .*workspace-folder/);
  assert.equal(pane.scrolled, 1);
  await run('loadList()');
  toggles = element('listPane').children.map(section => section.children[0]);
  assert.equal(toggles[1]['aria-expanded'], true);
  assert.equal(pane.scrolled, 1);
});

test('logs are enabled for either kind of preview and target the loaded conversation', async () => {
  const requests = [];
  const { element, run } = createPanel((path, body) => {
    requests.push([path, body]);
    return path === '/api/preview' ? { id: body.conversationId } : { ok: true };
  }, 'en');
  for (const tab of ['active', 'trash']) {
    await run(`state.tab = '${tab}'; openPreview('${tab}')`);
    assert.equal(element('pvRevealLogsBtn').disabled, false);
    await element('pvRevealLogsBtn').handlers.click();
    assert.deepEqual(requests.at(-1), ['/api/reveal-logs', { conversationId: tab, locale: 'en' }]);
  }
});

test('match navigation wraps, expands a folded message, and handles F3 outside inputs', () => {
  const { element, run, windowHandlers } = createPanel(() => ({}), 'en');
  const classes = new Set(['is-folded', 'is-collapsed']);
  const expand = {};
  const block = {
    classList: { contains: key => classes.has(key), remove: (...keys) => keys.forEach(key => classes.delete(key)) },
    querySelector: () => expand,
  };
  const makeMark = () => ({
    classList: new Set(),
    closest: () => block,
    getBoundingClientRect() { return { top: 20, bottom: 22, height: 2 }; },
  });
  const marks = [makeMark(), makeMark()];
  for (const mark of marks) mark.classList.remove = mark.classList.delete.bind(mark.classList);
  element('pvMessages').querySelectorAll = selector => selector === 'mark' ? marks : [];
  run("state.query = 'needle'; state.previewData = { id: 'A' }; stepPreviewMatch(1);");
  assert.equal(element('pvMatchNav').hidden, false);
  assert.equal(element('pvMatchCount').textContent, 'Match 1 / 2');
  assert.equal(classes.size, 0);
  assert.match(expand.textContent, /collapse|fold/i);
  assert.equal(element('pvMessages').scrolled, 1);
  assert.equal(marks[0].classList.has('is-current-match'), true);
  const key = { key: 'F3', shiftKey: true, target: { closest: () => null }, preventDefault() { this.handled = true; } };
  windowHandlers.keydown(key);
  assert.equal(key.handled, true);
  assert.equal(element('pvMatchCount').textContent, 'Match 2 / 2');
  assert.equal(marks[0].classList.has('is-current-match'), false);
  windowHandlers.keydown({ ...key, target: { closest: () => ({}) } });
  assert.equal(element('pvMatchCount').textContent, 'Match 2 / 2');
  element('pvNextMatchBtn').handlers.click();
  assert.equal(element('pvMatchCount').textContent, 'Match 1 / 2');
  run("state.query = ''; stepPreviewMatch(1);");
  assert.equal(element('pvMatchNav').hidden, true);
});

test('manual sweep reads a fresh count, requires confirmation, and bounds the request', async () => {
  const requests = [];
  const latest = { trashRetentionDays: 7, trashSummary: { totalCount: 5, expiredCount: 2 } };
  const { element } = createPanel((path, body) => {
    requests.push([path, body]);
    if (path === '/api/preferences') return latest;
    if (path === '/api/conversations') return { groups: [] };
    return { purged: ['A'], skipped: [{ id: 'B' }], failed: [], trashSummary: { totalCount: 4, expiredCount: 1 } };
  }, 'en');
  const dialog = element('sweepDialog');
  dialog.showModal = () => {};
  dialog.close = () => {};
  const click = () => element('sweepTrashBtn').handlers.click();
  const close = async value => {
    await new Promise(resolve => setImmediate(resolve));
    dialog.onsubmit({ preventDefault() {}, submitter: { value } });
  };
  const cancelled = click();
  await close('cancel');
  await cancelled;
  assert.match(element('sweepDescription').textContent, /delete 2/);
  assert.deepEqual(requests.map(([path]) => path), ['/api/preferences']);
  const confirmed = click();
  await close('confirm');
  await confirmed;
  assert.deepEqual(requests[2], ['/api/sweep-trash', { maxExpiredCount: 2, expectedRetentionDays: 7, locale: 'en' }]);
  assert.match(element('trashSummary').textContent, /4.*1/);
  assert.match(element('trashSettingsStatus').textContent, /Removed 1 .* Skipped 1/);
});

test('gliders, icon-only refresh button, flat dot status badges, and reveal-logs error toast work cleanly', async () => {
  assert.equal(html.includes('class="brand"'), false);
  assert.ok(html.includes('id="primaryGlider"'));
  assert.ok(html.includes('id="tabsGlider"'));
  assert.equal(/id="refreshBtn"[^>]*data-i18n="refresh"/.test(html), false);

  const { element, run } = createPanel(async (path, body) => {
    if (path === '/api/preview') return { id: body.conversationId, title: 'Chat' };
    if (path === '/api/reveal-logs') throw new Error('Raw log directory not found');
    return {};
  }, 'en', { renderCards: true });

  await run("openPreview('c1')");
  await element('pvRevealLogsBtn').handlers.click();
  assert.equal(run('globalThis.toast?.message'), 'Raw log directory not found');

  const pane = element('listPane');
  for (const [tab, item, cls] of [
    ['active', { id: 'a1', title: 'Active', archived: false }, 'pill-active'],
    ['active', { id: 'r1', title: 'Run', archived: false, isRunning: true }, 'pill-run'],
    ['archived', { id: 'z1', title: 'Done', archived: true }, 'pill-archived'],
    ['trash', { id: 't1', title: 'Trash', archived: true, trashedAt: 1000, purgeAt: 2000 }, 'pill-trash'],
  ]) {
    run(`state.tab = '${tab}'; renderCard($('listPane'), ${JSON.stringify(item)});`);
    const card = pane.children.at(-1);
    assert.match(card.innerHTML, new RegExp(`class="pill pill-status ${cls}"`));
  }
});

test('card tags move below actions, search input drops inner double outline, and appearance/update settings save', async () => {
  assert.match(html, /\.search-box input:focus,\s*\.search-box input:focus-visible\s*\{\s*outline:\s*none;/);

  const requests = [];
  const { element, run } = createPanel(async (path, body) => {
    requests.push([path, body]);
    if (path === '/api/conversations') return { groups: [] };
    if (path === '/api/preferences') {
      return {
        language: 'en', exportDir: 'D:\\Exports', defaultExportDir: 'D:\\Default',
        trashRetentionDays: 7, themeAccent: 'host', fontScale: 'md', pluginUpdateMode: 'manual',
        trashSummary: { totalCount: 0, expiredCount: 0 }, ...body,
      };
    }
    if (path === '/api/update-status' || path === '/api/check-update') {
      return {
        currentVersion: '2.3.3', latestVersion: '2.5.0', updateAvailable: true,
        installMode: 'archive', updateMode: 'manual',
        releaseUrl: 'https://github.com/YukiKaguraA/agy-archive-manager/releases/tag/v2.5.0',
        checkedAtMs: 1700000000000,
      };
    }
    if (path === '/api/apply-update') {
      return { ok: true, message: 'Updated to v2.5.0. Reloading sidecar…' };
    }
    return {};
  }, 'en', { renderCards: true });

  await run('initializePanel()');
  run("renderCard($('listPane'), { id: 'c1', title: 'Tagged', archived: false, tags: ['alpha', 'beta'] });");
  const taggedHtml = element('listPane').children.at(-1).innerHTML;
  const metaIdx = taggedHtml.indexOf('class="card-meta"');
  const actionsIdx = taggedHtml.indexOf('class="card-actions"');
  const tagsIdx = taggedHtml.indexOf('class="card-tags"');
  const tagPillIdx = taggedHtml.indexOf('#alpha');
  assert.ok(metaIdx >= 0 && actionsIdx > metaIdx && tagsIdx > actionsIdx && tagPillIdx > tagsIdx);

  await element('themeAccentPicker').handlers.click({
    target: { closest: () => ({ dataset: { accent: 'emerald' }, disabled: false }) },
  });
  assert.equal(run("document.documentElement.attrs['data-theme-accent']"), 'emerald');
  assert.deepEqual(requests.at(-1), ['/api/preferences', { themeAccent: 'emerald', locale: 'en' }]);

  await element('fontScaleControl').handlers.click({
    target: { closest: () => ({ dataset: { fontScale: 'lg' }, disabled: false }) },
  });
  assert.equal(run("document.documentElement.attrs['data-font-scale']"), 'lg');
  assert.deepEqual(requests.at(-1), ['/api/preferences', { fontScale: 'lg', locale: 'en' }]);

  element('updateModeSelect').value = 'auto';
  await element('updateModeSelect').handlers.change();
  assert.deepEqual(requests.at(-1), ['/api/preferences', { pluginUpdateMode: 'auto', locale: 'en' }]);

  await element('checkUpdateBtn').handlers.click();
  assert.equal(element('updateLatestVersion').textContent, 'v2.5.0');
  assert.equal(element('applyUpdateBtn').hidden, false);
  assert.equal(element('updateDot').hidden, false);

  await element('applyUpdateBtn').handlers.click();
  assert.match(element('updateStatusFeedback').textContent, /v2\.5\.0/);
});

test('statistics load lazily, discard superseded responses, remember the subview and reuse per-session results', async () => {
  const requests = [];
  const slow = deferred();
  const { run, element, windowHandlers } = createPanel((path, { conversationId: id }) => {
    requests.push([path, id]);
    if (path === '/api/preview') return { id, title: id, messages: [] };
    if (id === 'A') return slow.promise;
    return { conversationId: id, telemetry: { source: 'none' }, files: { items: [] } };
  });
  await run("openPreview('A')");
  assert.deepEqual(requests, [['/api/preview', 'A']]);
  const pending = run("selectPreviewTab('stats')");
  assert.equal(element('pvRawBtn').disabled, true);
  assert.equal(element('pvCollapseAllBtn').disabled, true);
  const key = { key: 'F3', target: {}, preventDefault() { throw Error('unexpected shortcut'); } };
  element('pvMatchNav').hidden = false;
  windowHandlers.keydown(key);
  await run("openPreview('B')");
  await new Promise(resolve => setImmediate(resolve));
  slow.resolve({ conversationId: 'A' });
  await pending;
  assert.equal(run('state.detailStats.conversationId'), 'B');
  assert.equal(run('state.previewTab'), 'stats');
  await run("selectPreviewTab('content')");
  assert.equal(element('pvRawBtn').disabled, false);
  await run("selectPreviewTab('stats')");
  assert.equal(requests.filter(([path,id]) => path.endsWith('detail-stats') && id === 'B').length, 1);
  await run("invalidateDetailCache()");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.filter(([path,id]) => path.endsWith('detail-stats') && id === 'B').length, 2);
});

test('tag navigation uses counts, clears incompatible filters and can select an archived-only tag', async () => {
  const tag = { name: 'archive-only', activeCount: 0, archivedCount: 1, totalCount: 1, starredCount: 0 };
  const { run, element } = createPanel((path, data) => {
    if (path === '/api/tags') return { summary: {}, tags: [tag] };
    if (path === '/api/conversations') return { items: [], allTags: [tag.name] };
    throw Error(path);
  });
  await run("showSurface('tags')");
  assert.equal(element('mainSplit').hidden, true);
  assert.equal(element('tagsPane').hidden, false);
  run("state.query='unrelated'; state.groupKey='other';");
  await run("selectInventoryTag(state.tagInventory.tags[0])");
  assert.equal(run('state.tab'), 'all');
  assert.equal(run('state.query + state.groupKey'), '');
  assert.equal(run('state.surface'), 'library');
  assert.equal(element('tagSelect').value, tag.name);
  run("state.tab='archived'");
  await run("selectInventoryTag(state.tagInventory.tags[0])");
  assert.equal(run('state.tab'), 'archived');
});

test('tag mutation keeps filter and preview synchronized and reports partial failures', async () => {
  const calls = [];
  let tag = 'first';
  const { element, run } = createPanel((path, data) => {
    calls.push([path, data]);
    if (path === '/api/tags/rename' || path === '/api/tags/delete') {
      tag = data.newTag || '';
      return { succeeded: ['session'], skipped: [{ id: 'other', error: 'Conflict' }], failed: [] };
    }
    if (path === '/api/tags') return { tags: tag ? [{ name: tag, totalCount: 1 }] : [], summary: {} };
    if (path === '/api/conversations') return { items: [], allTags: tag ? [tag] : [] };
    if (path === '/api/preview') return { id: 'session', title: 'Session', tags: tag ? [tag] : [] };
    throw Error(path);
  });
  await run("openPreview('session')");
  await run("showSurface('tags')");
  run("state.tag='first'; openTagDialog(state.tagInventory.tags[0], 'rename')");
  element('tagDialogInput').value = 'second';
  run('tagDialogHint()');
  await run("submitTagAction({preventDefault(){}})");
  assert.equal(run('state.tag'), 'second');
  assert.equal(run('state.previewData.tags.join()'), 'second');
  assert.match(element('tagsReport').textContent, /other · Conflict/);
  run("openTagDialog(state.tagInventory.tags[0], 'delete')");
  await run("submitTagAction({preventDefault(){}})");
  assert.equal(run('state.tag'), '');
  assert.equal(run('state.previewData.tags.length'), 0);
  assert.equal(calls.filter(([p]) => p === '/api/preview').length, 3);
});

test('file reveal sends only confirmed file paths and renders untrusted tool and file labels as text', async () => {
  const calls = [];
  const { run, element } = createPanel((path,data) => { calls.push([path, data]); return {}; });
  run("state.detailStats = {tools:{byName:[{name:'<script>',count:1}]}, files:{items:[{name:'<img>',path:'ok',exists:true},{path:'missing',exists:false},{path:'unknown',exists:null}]}}; renderDetailStats()");
  assert.match(element('pvStatsView').innerHTML, /&lt;script&gt;/);
  assert.match(element('pvStatsView').innerHTML, /&lt;img&gt;/);
  for (const index of [0,1,2]) {
    await element('pvStatsView').handlers.click({target:{closest: selector => selector === '[data-reveal]' ? {dataset:{reveal:String(index)}} : null}});
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/reveal-file');
  assert.equal(calls[0][1].path, 'ok');
  assert.equal(calls[0][1].isFile, true);
});
