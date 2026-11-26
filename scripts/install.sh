#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${1:-${HOME}/.gemini/config/plugins/archive-manager}"

mkdir -p "${TARGET_DIR}"

for f in plugin.json logo.svg README.md README.en.md LICENSE; do
  if [ -f "${REPO_ROOT}/${f}" ]; then
    cp -f "${REPO_ROOT}/${f}" "${TARGET_DIR}/${f}"
  fi
done

if [ -d "${REPO_ROOT}/docs/screenshots" ]; then
  mkdir -p "${TARGET_DIR}/docs"
  rm -rf "${TARGET_DIR:?}/docs/screenshots"
  cp -R "${REPO_ROOT}/docs/screenshots" "${TARGET_DIR}/docs"
fi

for d in skills sidecars; do
  if [ -d "${REPO_ROOT}/${d}" ]; then
    rm -rf "${TARGET_DIR:?}/${d}"
    cp -R "${REPO_ROOT}/${d}" "${TARGET_DIR}/${d}"
  fi
done

echo "[OK] Installed/updated archive-manager at: ${TARGET_DIR}"
echo "Enable 'Session Manager (archive-manager)' in Antigravity Customizations -> Plugins on first install."
