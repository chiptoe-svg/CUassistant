#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/export-machine-bundle.sh /path/to/output-dir [bundle-name]

Creates a portable bundle containing the private CUassistant files that are not
stored in git:
  - .env
  - config/*.yaml live config files
  - state/ (including progress and audit history)

Example:
  scripts/export-machine-bundle.sh /Volumes/PortableDrive
EOF
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_PARENT="$(cd "$1" && pwd)"
BUNDLE_NAME="${2:-cuassistant-machine-bundle}"
BUNDLE_DIR="${DEST_PARENT}/${BUNDLE_NAME}"

mkdir -p "${BUNDLE_DIR}/config"

copy_if_exists() {
  local src="$1"
  local dest="$2"
  if [[ -e "$src" ]]; then
    cp -R "$src" "$dest"
  fi
}

copy_live_config() {
  local name="$1"
  if [[ -f "${REPO_ROOT}/config/${name}" ]]; then
    cp "${REPO_ROOT}/config/${name}" "${BUNDLE_DIR}/config/${name}"
  fi
}

rm -rf "${BUNDLE_DIR}/state"
rm -f "${BUNDLE_DIR}/.env"

copy_if_exists "${REPO_ROOT}/.env" "${BUNDLE_DIR}/.env"
copy_live_config "accounts.yaml"
copy_live_config "classification.yaml"
copy_live_config "taxonomy.yaml"
copy_live_config "institutions.yaml"
copy_live_config "known_contacts.yaml"

if [[ -d "${REPO_ROOT}/state" ]]; then
  mkdir -p "${BUNDLE_DIR}/state"
  cp -R "${REPO_ROOT}/state/." "${BUNDLE_DIR}/state/"
  rm -f "${BUNDLE_DIR}/state/scan_in_progress.lock"
fi

cat > "${BUNDLE_DIR}/MANIFEST.txt" <<EOF
CUassistant machine bundle
Created: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Source repo: ${REPO_ROOT}

Included:
- .env
- config/accounts.yaml
- config/classification.yaml
- config/taxonomy.yaml
- config/institutions.yaml
- config/known_contacts.yaml
- state/

Not included:
- node_modules/
- dist/
- external tool auth outside the repo, such as Codex CLI sign-in state or gws auth
EOF

chmod 600 "${BUNDLE_DIR}/.env" 2>/dev/null || true
chmod -R go-rwx "${BUNDLE_DIR}/config" 2>/dev/null || true
chmod -R go-rwx "${BUNDLE_DIR}/state" 2>/dev/null || true

echo "Created bundle at: ${BUNDLE_DIR}"
