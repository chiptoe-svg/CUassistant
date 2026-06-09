#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/install-machine-bundle.sh /path/to/bundle[.tar.gz.enc] [--activate-launchd] [--skip-npm] [--skip-state]

Run this from the target CUassistant repo checkout on the new Mac. The bundle
argument may be either an encrypted archive (<name>.tar.gz.enc, the export
default — you will be prompted for the passphrase) or a plaintext bundle
directory.

What it does:
  - copies .env from the bundle
  - copies live config/*.yaml from the bundle
  - copies state/ from the bundle unless --skip-state is set
  - runs npm install unless --skip-npm is set
  - writes ~/Library/LaunchAgents/com.cuassistant.scan.plist
  - optionally loads the launchd job with --activate-launchd
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

BUNDLE_DIR=""
ACTIVATE_LAUNCHD=0
SKIP_NPM=0
SKIP_STATE=0

for arg in "$@"; do
  case "$arg" in
    --activate-launchd)
      ACTIVATE_LAUNCHD=1
      ;;
    --skip-npm)
      SKIP_NPM=1
      ;;
    --skip-state)
      SKIP_STATE=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      if [[ -z "${BUNDLE_DIR}" ]]; then
        BUNDLE_DIR="$arg"
      else
        echo "Unexpected argument: $arg" >&2
        usage
        exit 1
      fi
      ;;
  esac
done

if [[ -z "${BUNDLE_DIR}" ]]; then
  usage
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# An encrypted bundle (.tar.gz.enc) is decrypted into a temp dir first; a
# plaintext bundle directory is used in place (back-compat).
DECRYPT_TMP=""
cleanup() { [[ -n "${DECRYPT_TMP}" ]] && rm -rf "${DECRYPT_TMP}"; }
trap cleanup EXIT

if [[ -f "${BUNDLE_DIR}" && "${BUNDLE_DIR}" == *.enc ]]; then
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl not found — cannot decrypt ${BUNDLE_DIR}" >&2
    exit 1
  fi
  ENC_FILE="$(cd "$(dirname "${BUNDLE_DIR}")" && pwd)/$(basename "${BUNDLE_DIR}")"
  DECRYPT_TMP="$(mktemp -d)"
  echo "Decrypting bundle (you will be prompted for the passphrase)…"
  openssl enc -d -aes-256-cbc -pbkdf2 -in "${ENC_FILE}" | tar -xzf - -C "${DECRYPT_TMP}"
  # The archive contains a single top-level bundle directory.
  INNER="$(find "${DECRYPT_TMP}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  BUNDLE_DIR="${INNER:-${DECRYPT_TMP}}"
elif [[ -d "${BUNDLE_DIR}" ]]; then
  BUNDLE_DIR="$(cd "${BUNDLE_DIR}" && pwd)"
else
  echo "Bundle not found (need a .tar.gz.enc file or a bundle directory): ${BUNDLE_DIR}" >&2
  exit 1
fi

mkdir -p "${REPO_ROOT}/config"

copy_if_exists() {
  local src="$1"
  local dest="$2"
  if [[ -e "$src" ]]; then
    cp -R "$src" "$dest"
  fi
}

copy_if_exists "${BUNDLE_DIR}/.env" "${REPO_ROOT}/.env"

for name in accounts.yaml classification.yaml taxonomy.yaml institutions.yaml known_contacts.yaml; do
  if [[ -f "${BUNDLE_DIR}/config/${name}" ]]; then
    cp "${BUNDLE_DIR}/config/${name}" "${REPO_ROOT}/config/${name}"
  fi
done

if [[ ${SKIP_STATE} -eq 0 && -d "${BUNDLE_DIR}/state" ]]; then
  rm -rf "${REPO_ROOT}/state"
  mkdir -p "${REPO_ROOT}/state"
  cp -R "${BUNDLE_DIR}/state/." "${REPO_ROOT}/state/"
  rm -f "${REPO_ROOT}/state/scan_in_progress.lock"
fi

chmod 600 "${REPO_ROOT}/.env" 2>/dev/null || true
chmod -R go-rwx "${REPO_ROOT}/config" 2>/dev/null || true
chmod -R go-rwx "${REPO_ROOT}/state" 2>/dev/null || true

if [[ ${SKIP_NPM} -eq 0 ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is not installed or not on PATH." >&2
    exit 1
  fi
  (
    cd "${REPO_ROOT}"
    npm install
  )
fi

NPM_PATH="$(command -v npm || true)"
if [[ -z "${NPM_PATH}" ]]; then
  NPM_PATH="/usr/local/bin/npm"
fi

LAUNCHD_TEMPLATE="${REPO_ROOT}/launchd/com.cuassistant.scan.plist"
LAUNCHD_TARGET="${HOME}/Library/LaunchAgents/com.cuassistant.scan.plist"

mkdir -p "${HOME}/Library/LaunchAgents"

LAUNCHD_TEMPLATE="${LAUNCHD_TEMPLATE}" \
LAUNCHD_TARGET="${LAUNCHD_TARGET}" \
REPO_ROOT_RENDER="${REPO_ROOT}" \
NPM_PATH_RENDER="${NPM_PATH}" \
HOME_RENDER="${HOME}" \
python3 - <<'PY'
import os
from pathlib import Path

template = Path(os.environ["LAUNCHD_TEMPLATE"]).read_text(encoding="utf-8")
rendered = (
    template.replace("REPO_PATH", os.environ["REPO_ROOT_RENDER"])
    .replace("NPM_PATH", os.environ["NPM_PATH_RENDER"])
    .replace("HOME_PATH", os.environ["HOME_RENDER"])
)
Path(os.environ["LAUNCHD_TARGET"]).write_text(rendered, encoding="utf-8")
PY

if [[ ${ACTIVATE_LAUNCHD} -eq 1 ]]; then
  launchctl unload "${LAUNCHD_TARGET}" >/dev/null 2>&1 || true
  launchctl load "${LAUNCHD_TARGET}"
fi

cat <<EOF
Bundle restored into: ${REPO_ROOT}
Launchd plist written to: ${LAUNCHD_TARGET}

Next checks:
  npm run scan:dry
  MODE=agent npm run provider-smoke

If you use Codex Outlook or gws on this machine, you may still need to sign in
to those external tools separately because their auth state is not stored in
this repo bundle.
EOF
