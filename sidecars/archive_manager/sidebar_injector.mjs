// Mounts a native-styled "会话管理" quick-entry button in Antigravity's left sidebar
// right below "个性化定制" (Customizations), with a live archived-count badge.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const INSTANCE_TS = Date.now();
const INTERVAL_MS = 2500;
const COUNT_TTL_MS = 10_000;

function getCandidatePortFiles() {
  const home = homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    return [
      join(appData, 'Antigravity', 'DevToolsActivePort'),
      join(appData, 'Antigravity IDE', 'DevToolsActivePort'),
    ];
  }
  if (process.platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support');
    return [
      join(base, 'Antigravity', 'DevToolsActivePort'),
      join(base, 'Antigravity IDE', 'DevToolsActivePort'),
    ];
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
  return [
    join(xdg, 'Antigravity', 'DevToolsActivePort'),
    join(xdg, 'Antigravity IDE', 'DevToolsActivePort'),
  ];
}

function fetchJson(port, resourcePath, timeoutMs = 3000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: resourcePath, timeout: timeoutMs },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolvePromise(JSON.parse(raw));
          } catch (err) {
            rejectPromise(err);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', rejectPromise);
  });
}

function evalCdp(wsUrl, expression, timeoutMs = 5000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      rejectPromise(new Error('timeout'));
    }, timeoutMs);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: false },
      }));
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        if (msg.id !== 1 || settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolvePromise(msg?.result?.result?.value);
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rejectPromise(err);
        }
      }
    };
    ws.onerror = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    };
  });
}

async function discoverMainPages() {
  for (const file of getCandidatePortFiles()) {
    if (!existsSync(file)) continue;
    try {
      const port = Number(readFileSync(file, 'utf8').trim().split(/\r?\n/)[0]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      const list = await fetchJson(port, '/json/list', 3000);
      if (!Array.isArray(list)) continue;
      const pages = list.filter(
        (t) =>
          t &&
          t.type === 'page' &&
          typeof t.webSocketDebuggerUrl === 'string' &&
          /^ws:\/\/(127\.0\.0\.1|localhost):\d+\//.test(t.webSocketDebuggerUrl) &&
          !/^(devtools|data):/i.test(t.url || '')
      );
      if (pages.length > 0) return pages;
    } catch {}
  }
  return [];
}

function mountLeftSidebarButton(payload) {
  if (window.__agArchiveNavOwnerTs && payload.instanceTs < window.__agArchiveNavOwnerTs) {
    return 'superseded';
  }
  window.__agArchiveNavOwnerTs = payload.instanceTs;

  const autoBtn = document.querySelector('[data-testid="automations-button"]');
  const navContainer = autoBtn?.parentElement;
  if (!navContainer) return 'no-nav';

  const isEn = payload.language === 'en';
  const buttonLabel = isEn ? 'Session Manager' : '会话管理';
  let btn = document.getElementById('ag-archive-nav-btn');
  if (btn && btn.getAttribute('data-ver') !== '5') {
    btn.remove();
    btn = null;
  }

  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'ag-archive-nav-btn';
    btn.type = 'button';
    btn.setAttribute('data-ver', '5');
    btn.setAttribute('aria-label', buttonLabel);
    btn.title = buttonLabel;
    btn.setAttribute('data-testid', 'archive-manager-nav-button');
    btn.setAttribute('translate', 'no');
    btn.className = autoBtn.className || 'agy-button agy-button-custom inline-flex items-center font-medium';
    btn.style.cssText = 'width:100%;justify-content:space-between;cursor:pointer;';

    const leftWrap = document.createElement('span');
    leftWrap.style.cssText = 'display:inline-flex;align-items:center;gap:8px;min-width:0;';
    leftWrap.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.85;">' +
      '<rect x="2" y="3" width="20" height="5" rx="1.5"/>' +
      '<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/>' +
      '<line x1="10" y1="13" x2="14" y2="13"/>' +
      '</svg>' +
      '<span id="ag-archive-nav-label" class="truncate"></span>';

    const badge = document.createElement('span');
    badge.id = 'ag-archive-nav-badge';
    badge.style.cssText =
      'font-size:11px;line-height:1;padding:2px 6px;border-radius:999px;' +
      'background:var(--secondary, rgba(128,128,128,0.16));color:var(--muted-foreground, inherit);' +
      'font-variant-numeric:tabular-nums;margin-left:auto;opacity:0.85;';

    btn.appendChild(leftWrap);
    btn.appendChild(badge);

    const PANEL_LABELS = ['会话管理 (Session Manager)', '会话管理', '归档会话', 'Session Manager', 'Archive Manager', 'archive-manager'];

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function findMenuItemByText(keywords) {
      const candidates = [
        ...document.querySelectorAll('[role="menuitem"], [role="option"], [data-radix-collection-item], [cmdk-item], button'),
      ];
      for (const el of candidates) {
        if (el.id === 'ag-archive-nav-btn' || el.closest?.('#ag-archive-nav-btn')) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const txt = (el.innerText || '').trim();
        if (!txt || txt.length > 40) continue;
        for (const kw of keywords) {
          if (txt === kw || txt.includes(kw)) return el;
        }
      }
      return null;
    }

    function findExistingPanelTab() {
      const btns = [...document.querySelectorAll('button, [role="tab"]')];
      for (const el of btns) {
        if (el.id === 'ag-archive-nav-btn' || el.closest?.('#ag-archive-nav-btn')) continue;
        if (typeof navContainer.contains === 'function' && navContainer.contains(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const txt = (el.innerText || el.getAttribute?.('title') || el.getAttribute?.('aria-label') || '').trim();
        if (!txt || txt.length > 48) continue;
        const isTab = el.getAttribute?.('role') === 'tab' || Boolean(el.closest?.('[role="tablist"]'));
        if (isTab ? (r.y < 0 || r.y > 180) : (r.y < 0 || r.y > 160 || r.x < 180)) continue;
        if (PANEL_LABELS.includes(txt) || PANEL_LABELS.some((kw) => txt.includes(kw))) return el;
      }
      return null;
    }

    btn.addEventListener('click', async () => {
      const existingTab = findExistingPanelTab();
      if (existingTab) {
        existingTab.click();
        return;
      }

      let plusBtn = document.querySelector('[data-testid="side-panel-new-tab-button"]');
      if (!plusBtn || plusBtn.getBoundingClientRect().width === 0) {
        const toggleBtn = document.querySelector('[data-testid="toggle-aux-sidebar"]');
        if (toggleBtn) {
          toggleBtn.click();
          await sleep(180);
        }
        const tabAfterOpen = findExistingPanelTab();
        if (tabAfterOpen) {
          tabAfterOpen.click();
          return;
        }
        plusBtn = document.querySelector('[data-testid="side-panel-new-tab-button"]');
      }

      if (plusBtn && plusBtn.getBoundingClientRect().width > 0) {
        plusBtn.click();
        await sleep(140);
        let item = findMenuItemByText(PANEL_LABELS);
        if (!item) {
          const subTrigger =
            document.querySelector('[data-testid="plugins-submenu-trigger"]') ||
            findMenuItemByText(['插件', 'Plugins', '扩展', 'Extensions']);
          if (subTrigger) {
            subTrigger.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
            subTrigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            subTrigger.click();
            await sleep(160);
            item = findMenuItemByText(PANEL_LABELS);
          }
        }
        if (item) {
          item.click();
          return;
        }
      }

      const moreBtn = document.querySelector('[data-testid="titlebar-more-actions"]');
      if (moreBtn) {
        moreBtn.click();
        await sleep(160);
        let item = findMenuItemByText(PANEL_LABELS);
        if (!item) {
          const sub =
            document.querySelector('[data-testid="plugins-submenu-trigger"]') ||
            findMenuItemByText(['插件', 'Plugins', '扩展', 'Extensions']);
          if (sub) {
            sub.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
            sub.click();
            await sleep(180);
            item = findMenuItemByText(PANEL_LABELS);
          }
        }
        if (item) {
          item.click();
          return;
        }
      }
    });

    navContainer.appendChild(btn);
  }

  btn.setAttribute('aria-label', buttonLabel);
  btn.title = buttonLabel;
  const labelEl = document.getElementById('ag-archive-nav-label');
  if (labelEl) labelEl.textContent = buttonLabel;

  const badge = document.getElementById('ag-archive-nav-badge');
  if (badge) {
    const cnt = Number(payload.archivedCount || 0);
    badge.textContent = String(cnt);
    badge.title = isEn
      ? `${cnt} archived ${cnt === 1 ? 'session' : 'sessions'}`
      : `当前有 ${cnt} 条已归档会话`;
    badge.style.display = cnt > 0 ? 'inline-block' : 'none';
  }
  return 'ok';
}

export function startSidebarInjector(getArchivedCountAsync, getLanguage = () => 'zh-CN') {
  let busy = false;
  let stopped = false;
  let refreshRequested = false;
  let archivedCount = 0;
  let nextCountReadAt = 0;
  let pendingMount;

  async function tick() {
    if (busy || stopped) return;
    busy = true;
    refreshRequested = false;
    try {
      const pages = await discoverMainPages();
      if (stopped || pages.length === 0) return;

      const language = (() => {
        try { return getLanguage() === 'en' ? 'en' : 'zh-CN'; } catch { return 'zh-CN'; }
      })();

      if (Date.now() >= nextCountReadAt) {
        refreshRequested = false;
        try {
          archivedCount = await getArchivedCountAsync();
        } catch {
          // Keep the last successful count on a transient failure.
        }
        if (!refreshRequested) nextCountReadAt = Date.now() + COUNT_TTL_MS;
      }

      for (const page of pages) {
        if (stopped || refreshRequested) break;
        const expr = `(${mountLeftSidebarButton.toString()})(${JSON.stringify({
          instanceTs: INSTANCE_TS,
          language,
          archivedCount,
        })})`;
        pendingMount = evalCdp(page.webSocketDebuggerUrl, expr).catch(() => {});
        await pendingMount;
        pendingMount = undefined;
      }
    } catch {
      // The optional sidebar can retry on the next poll.
    } finally {
      busy = false;
      if (refreshRequested) void tick();
    }
  }

  const timer = setInterval(tick, INTERVAL_MS);
  const startupTimer = setTimeout(tick, 500);

  function invalidateCount() {
    if (stopped) return;
    nextCountReadAt = 0;
    refreshRequested = true;
    void tick();
  }

  async function cleanup() {
    stopped = true;
    clearInterval(timer);
    clearTimeout(startupTimer);
    // Wait only for an evaluation that could still mount the button.
    if (pendingMount) await pendingMount;
    const pages = await discoverMainPages().catch(() => []);
    const expr = `
      if (!(window.__agArchiveNavOwnerTs > ${INSTANCE_TS})) {
        document.getElementById('ag-archive-nav-btn')?.remove();
      }
    `;
    for (const page of pages) {
      await evalCdp(page.webSocketDebuggerUrl, expr).catch(() => {});
    }
  }

  return { cleanup, invalidateCount };
}
