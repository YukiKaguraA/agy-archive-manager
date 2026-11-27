import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

export const OFFICIAL_GITHUB_REPO = 'YukiKaguraA/agy-archive-manager';
export const GITHUB_RELEASE_API_URL =
  `https://api.github.com/repos/${OFFICIAL_GITHUB_REPO}/releases/latest`;
export const RAW_MANIFEST_URL =
  `https://raw.githubusercontent.com/${OFFICIAL_GITHUB_REPO}/main/plugin.json`;
export const RELEASES_PAGE_URL =
  `https://github.com/${OFFICIAL_GITHUB_REPO}/releases`;
export const CHECK_TTL_MS = 30 * 60 * 1000;
export const RETRY_COOLDOWN_MS = 60 * 1000;
const MIN_ARCHIVE_BYTES = 1024;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

export const TRUSTED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'release-assets.githubusercontent.com',
]);

const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function isValidSemver(value) {
  return typeof value === 'string' && SEMVER_RE.test(value.trim());
}

function parseSemverParts(value) {
  const match = typeof value === 'string' ? value.trim().match(SEMVER_RE) : null;
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  };
}

/**
 * Compares two SemVer strings (`> 0` if `a > b`, `< 0` if `a < b`, `0` if equal).
 */
export function compareSemver(a, b) {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  if (!pa || !pb) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key];
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const maxLen = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < maxLen; i++) {
    const la = pa.pre[i];
    const lb = pb.pre[i];
    if (la === undefined) return -1;
    if (lb === undefined) return 1;
    const na = /^\d+$/.test(la) ? Number(la) : null;
    const nb = /^\d+$/.test(lb) ? Number(lb) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na - nb;
    } else if (na !== null) {
      return -1;
    } else if (nb !== null) {
      return 1;
    } else if (la !== lb) {
      return la < lb ? -1 : 1;
    }
  }
  return 0;
}

export function isTrustedHttpsUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    return url.protocol === 'https:' && TRUSTED_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function defaultRunExecFile(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message || '').trim();
        reject(new Error(detail || err.message));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function isProtectedCopyEntry(srcPath) {
  const name = basename(String(srcPath || '')).toLowerCase();
  return name !== '.git' &&
    name !== '.data' &&
    name !== 'node_modules' &&
    name !== '.agy-market-receipt.json' &&
    !name.startsWith('.update-staging-');
}

function pruneExtraneousFiles(targetDir, referenceDir) {
  if (!existsSync(targetDir) || !existsSync(referenceDir)) return;
  let names = [];
  try {
    names = readdirSync(targetDir);
  } catch {
    return;
  }
  for (const name of names) {
    const targetChild = join(targetDir, name);
    if (!isProtectedCopyEntry(targetChild)) continue;
    const refChild = join(referenceDir, name);
    if (!existsSync(refChild)) {
      try {
        rmSync(targetChild, { recursive: true, force: true });
      } catch {}
    } else if (existsSync(refChild) && lstatSync(targetChild).isDirectory() && lstatSync(refChild).isDirectory()) {
      pruneExtraneousFiles(targetChild, refChild);
    }
  }
}

function hasAnySymlink(dir) {
  for (const name of readdirSync(dir)) {
    const child = join(dir, name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) return true;
    if (stat.isDirectory() && hasAnySymlink(child)) return true;
  }
  return false;
}

function locateExtractedPluginRoot(extractDir) {
  if (existsSync(join(extractDir, 'plugin.json'))) return extractDir;
  try {
    for (const name of readdirSync(extractDir)) {
      const sub = join(extractDir, name);
      if (lstatSync(sub).isDirectory() && existsSync(join(sub, 'plugin.json'))) return sub;
    }
  } catch {}
  return null;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function detectArchiveKind(buf, url) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return 'targz';
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
  if (/\.tar\.gz(?:$|\?)|\.tgz(?:$|\?)/i.test(url)) return 'invalid';
  return 'invalid';
}

function selectReleaseDownloadUrls(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const preferred = [];
  const fallback = [];
  for (const asset of assets) {
    const name = String(asset?.name || '');
    const url = asset?.browser_download_url;
    if (!isTrustedHttpsUrl(url)) continue;
    if (name === 'archive-manager.tar.gz') preferred.unshift(url);
    else if (/\.(?:tar\.gz|tgz|zip)$/i.test(name)) preferred.push(url);
  }
  if (isTrustedHttpsUrl(release?.tarball_url)) fallback.push(release.tarball_url);
  if (isTrustedHttpsUrl(release?.zipball_url)) fallback.push(release.zipball_url);
  return [...new Set([...preferred, ...fallback])];
}

/**
 * Creates a self-contained plugin update checker and applier with Git and archive channels.
 */
export function createPluginUpdater({
  pluginRoot,
  dataDir,
  getUpdateMode = () => 'manual',
  fetchImpl = (...args) => globalThis.fetch(...args),
  runExecFile = defaultRunExecFile,
  onRestart = () => {},
  t = (key, ...args) => (args.length ? `${key}:${args.join(',')}` : key),
  now = () => Date.now(),
  platform = process.platform,
  nodeExec = process.execPath || 'node',
} = {}) {
  const state = {
    latestVersion: '',
    releaseUrl: '',
    downloadUrls: [],
    checkedAtMs: 0,
    lastAttemptMs: 0,
    isChecking: false,
    isUpdating: false,
    lastError: null,
    lastUpdateResult: null,
    inFlightCheck: null,
    inFlightUpdate: null,
    inFlightUpdateIsAuto: false,
    lastAutoAttemptVersion: '',
  };

  function readInstalledVersion() {
    const manifest = readJsonSafe(join(pluginRoot, 'plugin.json'));
    const raw = typeof manifest?.version === 'string' ? manifest.version.trim().replace(/^v/i, '') : '';
    return isValidSemver(raw) ? raw : '0.0.0';
  }

  function getInstallMode() {
    return existsSync(join(pluginRoot, '.git')) ? 'git' : 'archive';
  }

  function isInstalledPluginDir() {
    return String(pluginRoot || '').replace(/\\/g, '/').toLowerCase().includes('/.gemini/config/plugins/');
  }

  function getStatus() {
    const currentVersion = readInstalledVersion();
    const latestVersion = state.latestVersion || '';
    const updateAvailable = Boolean(
      latestVersion && isValidSemver(latestVersion) && compareSemver(latestVersion, currentVersion) > 0
    );
    return {
      currentVersion,
      latestVersion,
      updateAvailable,
      installMode: getInstallMode(),
      updateMode: getUpdateMode(),
      releaseUrl: state.releaseUrl || RELEASES_PAGE_URL,
      checkedAtMs: state.checkedAtMs,
      isChecking: state.isChecking,
      isUpdating: state.isUpdating,
      lastError: state.lastError,
      lastUpdateResult: state.lastUpdateResult,
    };
  }

  async function fetchRemoteReleaseInfo(currentVersion) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': `agy-archive-manager/${currentVersion}`,
      'Cache-Control': 'no-cache',
    };
    let lastErr;
    try {
      const res = await fetchImpl(GITHUB_RELEASE_API_URL, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const release = await res.json();
      const rawTag = String(release?.tag_name || '').trim();
      if (!isValidSemver(rawTag)) throw new Error('Invalid GitHub release version');
      const latestVersion = rawTag.replace(/^v/i, '');
      const downloadUrls = selectReleaseDownloadUrls(release);
      if (!downloadUrls.length) {
        downloadUrls.push(
          `https://github.com/${OFFICIAL_GITHUB_REPO}/archive/refs/tags/v${latestVersion}.tar.gz`
        );
      }
      const releaseUrl = isTrustedHttpsUrl(release?.html_url)
        ? release.html_url
        : `${RELEASES_PAGE_URL}/tag/v${latestVersion}`;
      return { latestVersion, releaseUrl, downloadUrls };
    } catch (err) {
      lastErr = err;
    }

    try {
      const res = await fetchImpl(RAW_MANIFEST_URL, {
        method: 'GET',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = await res.json();
      const rawVer = String(manifest?.version || '').trim();
      if (!isValidSemver(rawVer)) throw new Error('Invalid remote manifest version');
      const latestVersion = rawVer.replace(/^v/i, '');
      return {
        latestVersion,
        releaseUrl: `${RELEASES_PAGE_URL}/tag/v${latestVersion}`,
        downloadUrls: [
          `https://github.com/${OFFICIAL_GITHUB_REPO}/archive/refs/tags/v${latestVersion}.tar.gz`,
          `https://github.com/${OFFICIAL_GITHUB_REPO}/archive/refs/heads/main.tar.gz`,
        ],
      };
    } catch (err) {
      throw lastErr || err;
    }
  }

  async function verifyCoreJsSyntax(rootDir) {
    if (!nodeExec) return;
    const files = [
      join(rootDir, 'sidecars', 'archive_manager', 'server.mjs'),
      join(rootDir, 'sidecars', 'archive_manager', 'server-locale.mjs'),
      join(rootDir, 'sidecars', 'archive_manager', 'sidebar_injector.mjs'),
      join(rootDir, 'sidecars', 'archive_manager', 'conversation-stats.mjs'),
      join(rootDir, 'sidecars', 'archive_manager', 'search.mjs'),
      join(rootDir, 'sidecars', 'archive_manager', 'search-worker.mjs'),
      join(rootDir, 'sidecars', 'archive_manager', 'plugin-updater.mjs'),
    ];
    for (const file of files) {
      if (existsSync(file)) await runExecFile(nodeExec, ['--check', file]);
    }
  }

  async function extractArchive(archivePath, extractDir, kind) {
    if (kind === 'targz') {
      await runExecFile('tar', ['-xzf', archivePath, '-C', extractDir]);
    } else if (kind === 'zip') {
      if (platform === 'win32') {
        const quotedZip = archivePath.replace(/'/g, "''");
        const quotedDest = extractDir.replace(/'/g, "''");
        await runExecFile('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${quotedZip}', '${quotedDest}')`,
        ]);
      } else {
        await runExecFile('unzip', ['-oq', archivePath, '-d', extractDir]);
      }
    } else {
      throw new Error(t('updatePackageInvalid'));
    }
  }

  async function checkForUpdate({ force = false } = {}) {
    if (state.inFlightCheck) return state.inFlightCheck;
    const currentMs = now();
    if (!force) {
      if (state.checkedAtMs > 0 && currentMs - state.checkedAtMs < CHECK_TTL_MS) {
        return getStatus();
      }
      if (state.lastAttemptMs > 0 && currentMs - state.lastAttemptMs < RETRY_COOLDOWN_MS) {
        return getStatus();
      }
    }

    state.inFlightCheck = (async () => {
      state.isChecking = true;
      state.lastAttemptMs = now();
      const currentVersion = readInstalledVersion();
      try {
        const remote = await fetchRemoteReleaseInfo(currentVersion);
        state.latestVersion = remote.latestVersion;
        state.releaseUrl = remote.releaseUrl;
        state.downloadUrls = remote.downloadUrls;
        state.checkedAtMs = now();
        state.lastError = null;

        const statusAfter = getStatus();
        if (
          statusAfter.updateAvailable &&
          getUpdateMode() === 'auto' &&
          !state.isUpdating &&
          state.lastAutoAttemptVersion !== statusAfter.latestVersion
        ) {
          state.lastAutoAttemptVersion = statusAfter.latestVersion;
          void applyUpdate({ isAuto: true }).catch(() => {});
        }
        return statusAfter;
      } catch (err) {
        state.lastError = t('updateCheckFailed', err?.message || 'network');
        return getStatus();
      } finally {
        state.isChecking = false;
        state.inFlightCheck = null;
      }
    })();

    return state.inFlightCheck;
  }

  async function applyGitUpdate(previousVersion, isAuto) {
    if (isAuto && !isInstalledPluginDir()) {
      return {
        ok: false,
        skipped: true,
        mode: 'git',
        reason: 'dev_repo_auto_disabled',
        previousVersion,
        currentVersion: previousVersion,
        message: t('updateDevRepoSkipped'),
        updatedAtMs: now(),
      };
    }

    const statusRes = await runExecFile('git', ['-C', pluginRoot, 'status', '--porcelain']);
    if (statusRes.stdout.trim().length > 0) {
      const msg = t('updateDirtyWorktree');
      if (!isAuto) state.lastError = msg;
      return {
        ok: false,
        skipped: true,
        mode: 'git',
        reason: 'dirty_worktree',
        previousVersion,
        currentVersion: previousVersion,
        message: msg,
        updatedAtMs: now(),
      };
    }

    const branchRes = await runExecFile('git', ['-C', pluginRoot, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchRes.stdout.trim();
    const isAllowedBranch = branch === 'main' || /^release\/[0-9A-Za-z._-]+$/.test(branch);
    if (!isAllowedBranch) {
      const msg = t('updateWrongBranch', branch || 'HEAD');
      if (!isAuto) state.lastError = msg;
      return {
        ok: false,
        skipped: true,
        mode: 'git',
        reason: 'not_on_main_branch',
        branch,
        previousVersion,
        currentVersion: previousVersion,
        message: msg,
        updatedAtMs: now(),
      };
    }

    const remoteRef = `origin/${branch}`;
    await runExecFile('git', ['-C', pluginRoot, 'fetch', 'origin', branch, '--tags']);

    let remoteVersion = '';
    try {
      const showRes = await runExecFile('git', ['-C', pluginRoot, 'show', `${remoteRef}:plugin.json`]);
      const parsed = JSON.parse(showRes.stdout || '{}');
      const raw = typeof parsed?.version === 'string' ? parsed.version.trim() : '';
      if (isValidSemver(raw)) remoteVersion = raw.replace(/^v/i, '');
    } catch {
      remoteVersion = '';
    }

    if (!remoteVersion || compareSemver(remoteVersion, previousVersion) <= 0) {
      return {
        ok: false,
        skipped: true,
        upToDate: true,
        mode: 'git',
        reason: 'already_up_to_date',
        previousVersion,
        currentVersion: previousVersion,
        remoteVersion: remoteVersion || previousVersion,
        message: t('updateUpToDate', previousVersion),
        updatedAtMs: now(),
      };
    }

    try {
      await runExecFile('git', ['-C', pluginRoot, 'merge-base', '--is-ancestor', 'HEAD', remoteRef]);
    } catch {
      const msg = t('updateDiverged');
      if (!isAuto) state.lastError = msg;
      return {
        ok: false,
        skipped: true,
        mode: 'git',
        reason: 'diverged_worktree',
        previousVersion,
        currentVersion: previousVersion,
        message: msg,
        updatedAtMs: now(),
      };
    }

    await runExecFile('git', ['-C', pluginRoot, 'pull', '--ff-only', 'origin', branch]);
    await verifyCoreJsSyntax(pluginRoot);
    const currentVersion = readInstalledVersion();
    const result = {
      ok: true,
      mode: 'git',
      previousVersion,
      currentVersion,
      restarting: true,
      message: t('updateAppliedRestart', currentVersion),
      updatedAtMs: now(),
    };
    onRestart();
    return result;
  }

  async function applyArchiveUpdate(previousVersion, isAuto) {
    if (isAuto && !isInstalledPluginDir()) {
      return {
        ok: false,
        skipped: true,
        mode: 'archive',
        reason: 'dev_repo_auto_disabled',
        previousVersion,
        currentVersion: previousVersion,
        message: t('updateDevRepoSkipped'),
        updatedAtMs: now(),
      };
    }

    if (!state.latestVersion || compareSemver(state.latestVersion, previousVersion) <= 0) {
      await checkForUpdate({ force: true });
    }
    const targetVersion = state.latestVersion || '';
    if (!isValidSemver(targetVersion) || compareSemver(targetVersion, previousVersion) <= 0) {
      return {
        ok: false,
        skipped: true,
        upToDate: true,
        mode: 'archive',
        reason: 'already_up_to_date',
        previousVersion,
        currentVersion: previousVersion,
        remoteVersion: targetVersion || previousVersion,
        message: t('updateUpToDate', previousVersion),
        updatedAtMs: now(),
      };
    }

    const candidates = state.downloadUrls.filter(isTrustedHttpsUrl);
    if (!candidates.length) throw new Error(t('updateDownloadFailed', 'no trusted download URL'));

    let lastErr;
    for (const url of candidates) {
      const stagingDir = join(dataDir, `.update-staging-${now()}`);
      const extractDir = join(stagingDir, 'extracted');
      const backupDir = join(stagingDir, 'backup');
      try {
        mkdirSync(extractDir, { recursive: true });
        const res = await fetchImpl(url, {
          method: 'GET',
          headers: { 'User-Agent': `agy-archive-manager/${previousVersion}` },
          signal: AbortSignal.timeout(25000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < MIN_ARCHIVE_BYTES || buf.length > MAX_ARCHIVE_BYTES) {
          throw new Error(t('updatePackageInvalid'));
        }
        const kind = detectArchiveKind(buf, url);
        if (kind === 'invalid') throw new Error(t('updatePackageInvalid'));
        const archivePath = join(stagingDir, kind === 'zip' ? 'bundle.zip' : 'bundle.tar.gz');
        writeFileSync(archivePath, buf);

        await extractArchive(archivePath, extractDir, kind);
        const extractedRoot = locateExtractedPluginRoot(extractDir);
        if (
          !extractedRoot ||
          hasAnySymlink(extractedRoot) ||
          !existsSync(join(extractedRoot, 'sidecars', 'archive_manager', 'server.mjs')) ||
          !existsSync(join(extractedRoot, 'sidecars', 'archive_manager', 'server-locale.mjs')) ||
          !existsSync(join(extractedRoot, 'sidecars', 'archive_manager', 'index.html')) ||
          !existsSync(join(extractedRoot, 'sidecars', 'archive_manager', 'sidecar.json'))
        ) {
          throw new Error(t('updatePackageInvalid'));
        }

        const extractedManifest = readJsonSafe(join(extractedRoot, 'plugin.json'));
        if (extractedManifest?.name !== 'archive-manager') {
          throw new Error(t('updatePackageInvalid'));
        }
        const rawVer = typeof extractedManifest?.version === 'string' ? extractedManifest.version.trim() : '';
        const extractedVer = isValidSemver(rawVer) ? rawVer.replace(/^v/i, '') : '';
        if (!extractedVer || compareSemver(extractedVer, previousVersion) <= 0) {
          throw new Error(t('updateDowngradeBlocked', extractedVer || '?', previousVersion));
        }

        await verifyCoreJsSyntax(extractedRoot);

        mkdirSync(backupDir, { recursive: true });
        cpSync(pluginRoot, backupDir, { recursive: true, force: true, filter: isProtectedCopyEntry });
        try {
          cpSync(extractedRoot, pluginRoot, { recursive: true, force: true, filter: isProtectedCopyEntry });
          pruneExtraneousFiles(pluginRoot, extractedRoot);
        } catch (copyErr) {
          try {
            cpSync(backupDir, pluginRoot, { recursive: true, force: true, filter: isProtectedCopyEntry });
            pruneExtraneousFiles(pluginRoot, backupDir);
          } catch {}
          throw copyErr;
        }

        const currentVersion = readInstalledVersion();
        const result = {
          ok: true,
          mode: 'archive',
          previousVersion,
          currentVersion,
          restarting: true,
          message: t('updateAppliedRestart', currentVersion),
          updatedAtMs: now(),
        };
        onRestart();
        return result;
      } catch (err) {
        lastErr = err;
      } finally {
        try { rmSync(stagingDir, { recursive: true, force: true }); } catch {}
      }
    }
    throw lastErr || new Error(t('updateDownloadFailed', 'unknown'));
  }

  async function applyUpdate({ isAuto = false } = {}) {
    if (state.inFlightUpdate) {
      if (isAuto || !state.inFlightUpdateIsAuto) return state.inFlightUpdate;
      await state.inFlightUpdate.catch(() => {});
      if (state.inFlightUpdate) return state.inFlightUpdate;
    }

    state.inFlightUpdateIsAuto = Boolean(isAuto);
    state.inFlightUpdate = (async () => {
      state.isUpdating = true;
      state.lastError = null;
      const previousVersion = readInstalledVersion();
      const hasGit = existsSync(join(pluginRoot, '.git'));
      try {
        const result = hasGit
          ? await applyGitUpdate(previousVersion, isAuto)
          : await applyArchiveUpdate(previousVersion, isAuto);
        state.lastUpdateResult = result;
        return result;
      } catch (err) {
        const message = t('updateDownloadFailed', err?.message || 'unknown');
        state.lastError = message;
        const result = {
          ok: false,
          mode: hasGit ? 'git' : 'archive',
          previousVersion,
          currentVersion: readInstalledVersion(),
          message,
          updatedAtMs: now(),
        };
        state.lastUpdateResult = result;
        return result;
      } finally {
        state.isUpdating = false;
        state.inFlightUpdateIsAuto = false;
        state.inFlightUpdate = null;
      }
    })();

    return state.inFlightUpdate;
  }

  return {
    readInstalledVersion,
    getInstallMode,
    getStatus,
    checkForUpdate,
    applyUpdate,
  };
}
