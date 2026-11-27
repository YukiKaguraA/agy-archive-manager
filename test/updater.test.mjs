import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  compareSemver,
  createPluginUpdater,
  isTrustedHttpsUrl,
  isValidSemver,
} from '../sidecars/archive_manager/plugin-updater.mjs';

const tempRoots = [];
after(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function makeSandbox(version = '2.4.1', { withGit = false, underInstalledDir = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'am-updater-'));
  tempRoots.push(base);
  const pluginRoot = underInstalledDir
    ? join(base, '.gemini', 'config', 'plugins', 'archive-manager')
    : join(base, 'repo');
  const dataDir = join(base, 'data');
  mkdirSync(join(pluginRoot, 'sidecars', 'archive_manager'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(pluginRoot, 'plugin.json'), JSON.stringify({ name: 'archive-manager', version }));
  writeFileSync(join(pluginRoot, 'sidecars', 'archive_manager', 'sidecar.json'), '{}');
  writeFileSync(join(pluginRoot, 'sidecars', 'archive_manager', 'server.mjs'), 'export const v = 1;\n');
  writeFileSync(join(pluginRoot, 'sidecars', 'archive_manager', 'server-locale.mjs'), 'export const l = 1;\n');
  writeFileSync(join(pluginRoot, 'sidecars', 'archive_manager', 'index.html'), '<html></html>');
  if (withGit) mkdirSync(join(pluginRoot, '.git'));
  return { base, pluginRoot, dataDir };
}

test('compareSemver, isValidSemver, and URL trust filter handle edge cases strictly', () => {
  assert.equal(isValidSemver('v2.4.1'), true);
  assert.equal(isValidSemver('2.5.0-beta.1'), true);
  assert.equal(isValidSemver('2.4'), false);
  assert.ok(compareSemver('2.5.0', '2.4.1') > 0);
  assert.ok(compareSemver('2.3.1', '2.4.1') < 0);
  assert.ok(compareSemver('2.5.0', '2.5.0-rc.1') > 0);
  assert.equal(isTrustedHttpsUrl('https://github.com/YukiKaguraA/agy-archive-manager/releases'), true);
  assert.equal(isTrustedHttpsUrl('https://objects.githubusercontent.com/file.tar.gz'), true);
  assert.equal(isTrustedHttpsUrl('http://github.com/insecure'), false);
  assert.equal(isTrustedHttpsUrl('https://evil.example.com/plugin.tar.gz'), false);
});

test('checkForUpdate uses GitHub release and prevents downgrade when local is newer than remote', async () => {
  const { pluginRoot, dataDir } = makeSandbox('2.4.1');
  const updater = createPluginUpdater({
    pluginRoot,
    dataDir,
    fetchImpl: async () => new Response(JSON.stringify({
      tag_name: 'v2.3.1',
      html_url: 'https://github.com/YukiKaguraA/agy-archive-manager/releases/tag/v2.3.1',
      assets: [{ name: 'archive-manager.tar.gz', browser_download_url: 'https://github.com/YukiKaguraA/agy-archive-manager/releases/download/v2.3.1/archive-manager.tar.gz' }],
    }), { status: 200 }),
  });

  const status = await updater.checkForUpdate({ force: true });
  assert.equal(status.currentVersion, '2.4.1');
  assert.equal(status.latestVersion, '2.3.1');
  assert.equal(status.updateAvailable, false);
  assert.equal(status.installMode, 'archive');
});

test('checkForUpdate falls back to raw manifest when releases API fails', async () => {
  const { pluginRoot, dataDir } = makeSandbox('2.4.1');
  let calls = 0;
  const updater = createPluginUpdater({
    pluginRoot,
    dataDir,
    fetchImpl: async (url) => {
      calls++;
      if (url.includes('api.github.com')) return new Response('rate limit', { status: 403 });
      return new Response(JSON.stringify({ name: 'archive-manager', version: '2.5.0' }), { status: 200 });
    },
  });

  const status = await updater.checkForUpdate({ force: true });
  assert.equal(calls, 2);
  assert.equal(status.latestVersion, '2.5.0');
  assert.equal(status.updateAvailable, true);
});

test('git update channel enforces dev-repo isolation, clean tree, main branch, and ff-only pull', async () => {
  const devBox = makeSandbox('2.4.1', { withGit: true, underInstalledDir: false });
  const devUpdater = createPluginUpdater({
    pluginRoot: devBox.pluginRoot,
    dataDir: devBox.dataDir,
    runExecFile: async () => { throw new Error('should not run git on auto in dev repo'); },
  });
  const autoSkipped = await devUpdater.applyUpdate({ isAuto: true });
  assert.equal(autoSkipped.reason, 'dev_repo_auto_disabled');

  const instBox = makeSandbox('2.4.1', { withGit: true, underInstalledDir: true });
  let dirty = ' M plugin.json\n';
  let branch = 'feat/test';
  let restarted = 0;
  const gitUpdater = createPluginUpdater({
    pluginRoot: instBox.pluginRoot,
    dataDir: instBox.dataDir,
    onRestart: () => { restarted++; },
    runExecFile: async (cmd, args) => {
      if (cmd !== 'git') return { stdout: '', stderr: '' };
      if (args.includes('status')) return { stdout: dirty, stderr: '' };
      if (args.includes('--abbrev-ref')) return { stdout: `${branch}\n`, stderr: '' };
      if (args.includes('fetch')) return { stdout: '', stderr: '' };
      if (args.includes('show')) return { stdout: JSON.stringify({ version: '2.5.0' }), stderr: '' };
      if (args.includes('merge-base')) return { stdout: '', stderr: '' };
      if (args.includes('pull')) {
        writeFileSync(join(instBox.pluginRoot, 'plugin.json'), JSON.stringify({ name: 'archive-manager', version: '2.5.0' }));
        return { stdout: 'Fast-forward', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal((await gitUpdater.applyUpdate()).reason, 'dirty_worktree');
  dirty = '';
  assert.equal((await gitUpdater.applyUpdate()).reason, 'not_on_main_branch');
  branch = 'main';
  const updated = await gitUpdater.applyUpdate();
  assert.equal(updated.ok, true);
  assert.equal(updated.currentVersion, '2.5.0');
  assert.equal(restarted, 1);
});

test('archive update channel unpacks tar.gz, prunes obsolete files, and triggers restart', async () => {
  const { base, pluginRoot, dataDir } = makeSandbox('2.4.1');
  writeFileSync(join(pluginRoot, 'legacy-obsolete.txt'), 'remove me');

  const pkgDir = join(base, 'pkg');
  mkdirSync(join(pkgDir, 'sidecars', 'archive_manager'), { recursive: true });
  writeFileSync(join(pkgDir, 'plugin.json'), JSON.stringify({ name: 'archive-manager', version: '2.5.0' }));
  writeFileSync(join(pkgDir, 'sidecars', 'archive_manager', 'sidecar.json'), '{}');
  writeFileSync(join(pkgDir, 'sidecars', 'archive_manager', 'server.mjs'), 'export const v = 2;\n');
  writeFileSync(join(pkgDir, 'sidecars', 'archive_manager', 'server-locale.mjs'), 'export const l = 2;\n');
  writeFileSync(join(pkgDir, 'sidecars', 'archive_manager', 'index.html'), '<html>new</html>');
  writeFileSync(join(pkgDir, 'README.md'), Array.from({ length: 80 }, (_, i) => `Release note line ${i}: ${Math.sin(i).toFixed(8)}`).join('\n'));
  const tarFile = join(base, 'archive-manager.tar.gz');
  execFileSync('tar', ['-czf', tarFile, '-C', pkgDir, '.']);
  const tarBuf = readFileSync(tarFile);

  let restarted = 0;
  const updater = createPluginUpdater({
    pluginRoot,
    dataDir,
    onRestart: () => { restarted++; },
    fetchImpl: async (url) => {
      if (url.includes('api.github.com')) {
        return new Response(JSON.stringify({
          tag_name: 'v2.5.0',
          assets: [{ name: 'archive-manager.tar.gz', browser_download_url: 'https://github.com/YukiKaguraA/agy-archive-manager/releases/download/v2.5.0/archive-manager.tar.gz' }],
        }), { status: 200 });
      }
      return new Response(tarBuf, { status: 200 });
    },
  });

  const result = await updater.applyUpdate();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.mode, 'archive');
  assert.equal(result.currentVersion, '2.5.0');
  assert.equal(restarted, 1);
  assert.equal(existsSync(join(pluginRoot, 'legacy-obsolete.txt')), false);
  assert.equal(readFileSync(join(pluginRoot, 'sidecars', 'archive_manager', 'index.html'), 'utf8'), '<html>new</html>');
});
