import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { startSidebarInjector } from '../sidecars/archive_manager/sidebar_injector.mjs';

const MAIN_PAGE = {
  type: 'page',
  url: 'file:///app/index.html',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/main',
};

function mockSidebarEnvironment(t, {
  hasPort = true,
  pages = [MAIN_PAGE],
  waitForMount = async () => {},
  ownerTimestamp,
  onMount = () => {},
} = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;
  const existsMock = t.mock.method(fs, 'existsSync', (path) => {
    if (typeof path === 'string' && basename(path) === 'DevToolsActivePort') return hasPort;
    return originalExistsSync(path);
  });
  const readMock = t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (typeof path === 'string' && basename(path) === 'DevToolsActivePort') return '9333\n';
    return originalReadFileSync(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    existsMock.mock.restore();
    readMock.mock.restore();
    syncBuiltinESMExports();
  });

  t.mock.method(http, 'get', (_options, onResponse) => {
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = new EventEmitter();
      onResponse(response);
      response.emit('data', JSON.stringify(pages));
      response.emit('end');
    });
    return request;
  });

  const badgeCounts = [];
  const operations = [];
  const window = { __agArchiveNavOwnerTs: ownerTimestamp };
  const document = {
    getElementById(id) {
      if (id !== 'ag-archive-nav-btn') return null;
      return { remove: () => operations.push('remove') };
    },
  };
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor() {
      queueMicrotask(() => this.onopen());
    }

    async send(message) {
      const { id, params } = JSON.parse(message);
      const count = params.expression.match(/"archivedCount":(\d+)\}\)$/);
      if (count) {
        operations.push('mount');
        badgeCounts.push(Number(count[1]));
        await waitForMount();
        onMount(params.expression);
      } else {
        runInNewContext(params.expression, { window, document });
      }
      this.onmessage({ data: JSON.stringify({ id, result: { result: { value: 'ok' } } }) });
    }

    close() {}
  };
  t.after(() => { globalThis.WebSocket = originalWebSocket; });

  async function advance(ms) {
    t.mock.timers.tick(ms);
    await setImmediate();
  }

  return { advance, badgeCounts, operations };
}

test('skips archive counting when there is no debugging port', async (t) => {
  const { advance } = mockSidebarEnvironment(t, { hasPort: false });
  const getCount = t.mock.fn(async () => 3);
  const { invalidateCount } = startSidebarInjector(getCount);

  await advance(500);
  await advance(2500);
  invalidateCount();
  await setImmediate();
  assert.equal(getCount.mock.callCount(), 0);
});

test('waits for a usable CDP page before archive counting', async (t) => {
  const pages = [
    { ...MAIN_PAGE, type: 'iframe' },
    { ...MAIN_PAGE, url: 'devtools://devtools/bundled/inspector.html' },
  ];
  const { advance, badgeCounts } = mockSidebarEnvironment(t, { pages });
  const getCount = t.mock.fn(async () => 3);
  startSidebarInjector(getCount);

  await advance(500);
  assert.equal(getCount.mock.callCount(), 0);

  pages.push(MAIN_PAGE);
  await advance(2000);
  assert.equal(getCount.mock.callCount(), 1);
  assert.deepEqual(badgeCounts, [3]);
});

test('reuses the archive count until its TTL expires', async (t) => {
  const { advance, badgeCounts } = mockSidebarEnvironment(t);
  let count = 4;
  const getCount = t.mock.fn(async () => count);
  startSidebarInjector(getCount);

  await advance(500);
  count = 5;
  await advance(2000);
  assert.equal(getCount.mock.callCount(), 1);
  assert.deepEqual(badgeCounts, [4, 4]);

  await advance(10_000);
  assert.equal(getCount.mock.callCount(), 2);
  assert.equal(badgeCounts.at(-1), 5);
});

test('retains the last good badge count after a temporary failure', async (t) => {
  const { advance, badgeCounts } = mockSidebarEnvironment(t);
  let getCount = () => 4;
  startSidebarInjector(async () => getCount());

  await advance(500);
  getCount = () => { throw new Error('temporary failure'); };
  await advance(12_000);
  assert.equal(badgeCounts.at(-1), 4);
  assert.equal(badgeCounts.length, 2);

  getCount = () => 0;
  await advance(10_000);
  assert.equal(badgeCounts.at(-1), 0);
});

test('invalidating the count refreshes the mounted badge without waiting for a poll', async (t) => {
  const { advance, badgeCounts } = mockSidebarEnvironment(t);
  let count = 4;
  const { invalidateCount } = startSidebarInjector(async () => count);
  await advance(500);

  count = 5;
  invalidateCount();
  await setImmediate();
  assert.deepEqual(badgeCounts, [4, 5]);
});

test('invalidations during a read coalesce into a fresh read', async (t) => {
  const { advance, badgeCounts } = mockSidebarEnvironment(t);
  const pendingCount = Promise.withResolvers();
  let read = () => pendingCount.promise;
  const getCount = t.mock.fn(async () => read());
  const { invalidateCount } = startSidebarInjector(getCount);
  await advance(500);

  read = () => 5;
  invalidateCount();
  invalidateCount();
  pendingCount.resolve(4);
  await setImmediate();

  assert.equal(getCount.mock.callCount(), 2);
  assert.deepEqual(badgeCounts, [5]);
});

test('a count read that finishes after cleanup cannot mount a badge', async (t) => {
  const { advance, operations } = mockSidebarEnvironment(t);
  const pendingCount = Promise.withResolvers();
  const getCount = t.mock.fn(() => pendingCount.promise);
  const { cleanup, invalidateCount } = startSidebarInjector(getCount);
  await advance(500);

  await cleanup();
  pendingCount.resolve(4);
  invalidateCount();
  await setImmediate();
  await advance(2500);

  assert.equal(getCount.mock.callCount(), 1);
  assert.deepEqual(operations, ['remove']);
});

test('cleanup removes the badge after an in-flight mount settles', async (t) => {
  const pendingMount = Promise.withResolvers();
  const { advance, operations } = mockSidebarEnvironment(t, {
    waitForMount: () => pendingMount.promise,
  });
  const { cleanup } = startSidebarInjector(async () => 4);
  await advance(500);
  assert.deepEqual(operations, ['mount']);

  const cleaned = cleanup();
  await setImmediate();
  const operationsDuringMount = [...operations];
  pendingMount.resolve();
  await cleaned;

  assert.deepEqual(operationsDuringMount, ['mount']);
  assert.deepEqual(operations, ['mount', 'remove']);
});

test('cleanup leaves the button owned by a newer sidecar instance', async (t) => {
  const { operations } = mockSidebarEnvironment(t, {
    ownerTimestamp: Number.MAX_SAFE_INTEGER,
  });
  const { cleanup } = startSidebarInjector(async () => 4);

  await cleanup();

  assert.deepEqual(operations, []);
});

test('mounts a concise locale-aware sidebar entry and updates it on language switch', async (t) => {
  const makeElement = () => ({
    attributes: {},
    children: [],
    style: {},
    handlers: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key] ?? null; },
    appendChild(child) { this.children.push(child); },
    addEventListener(event, handler) { this.handlers[event] = handler; },
  });
  const nav = makeElement();
  const labelNode = makeElement();
  labelNode.id = 'ag-archive-nav-label';
  let tabClicks = 0;
  const existingTab = {
    id: 'existing-tab',
    innerText: '会话管理 (Session Manager)',
    getAttribute: (key) => key === 'role' ? 'tab' : null,
    getBoundingClientRect: () => ({ x: 240, y: 115, width: 180, height: 30 }),
    click() { tabClicks++; },
  };
  const pageDocument = {
    getElementById(id) {
      if (id === 'ag-archive-nav-label') return nav.children.length ? labelNode : null;
      return nav.children[0]?.children.find((element) => element.id === id) || (nav.children[0]?.id === id ? nav.children[0] : null);
    },
    querySelector: (selector) => selector.includes('automations-button') ? { parentElement: nav } : null,
    querySelectorAll: () => [existingTab],
    createElement: makeElement,
  };
  const { advance } = mockSidebarEnvironment(t, {
    onMount: (expression) => runInNewContext(expression, { window: {}, document: pageDocument }),
  });
  let currentLang = 'zh-CN';
  const { invalidateCount } = startSidebarInjector(async () => 4, () => currentLang);
  await advance(500);
  const [button] = nav.children;
  assert.equal(button.attributes['aria-label'], '会话管理');
  assert.equal(labelNode.textContent, '会话管理');
  assert.equal(button.children[1].title, '当前有 4 条已归档会话');

  currentLang = 'en';
  invalidateCount();
  await setImmediate();
  assert.equal(button.attributes['aria-label'], 'Session Manager');
  assert.equal(labelNode.textContent, 'Session Manager');
  assert.equal(button.children[1].title, '4 archived sessions');

  await button.handlers.click();
  assert.equal(tabClicks, 1);
});
