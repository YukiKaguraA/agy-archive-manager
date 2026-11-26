#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${1:-${HOME}/.gemini/config/plugins/archive-manager}"

mkdir -p "${TARGET_DIR}"

for f in plugin.json logo.svg README.md LICENSE; do
  if [ -f "${REPO_ROOT}/${f}" ]; then
    cp -f "${REPO_ROOT}/${f}" "${TARGET_DIR}/${f}"
  fi
done

for d in skills sidecars; do
  if [ -d "${REPO_ROOT}/${d}" ]; then
    rm -rf "${TARGET_DIR:?}/${d}"
    cp -R "${REPO_ROOT}/${d}" "${TARGET_DIR}/${d}"
  fi
done

echo "[OK] Installed/updated archive-manager at: ${TARGET_DIR}"
echo "Enable 'Session Manager (archive-manager)' in Antigravity Customizations -> Plugins on first install."
