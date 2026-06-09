#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/export-machine-bundle.sh /path/to/output-dir [bundle-name] [--plaintext]

Creates a portable bundle of the private CUassistant files not stored in git:
  - .env  (contains the MS365 refresh token and any API keys)
  - config/*.yaml live config files
  - state/ (progress + audit history)

By DEFAULT the bundle is ENCRYPTED with a passphrase (openssl AES-256, PBKDF2)
and written as <bundle-name>.tar.gz.enc — because it contains a long-lived
credential and is meant to travel on removable media. Decrypt it on the target
with scripts/install-machine-bundle.sh.

  --plaintext   Write an unencrypted bundle directory instead (NOT recommended;
                the .env refresh token sits in cleartext on the destination).

Example:
  scripts/export-machine-bundle.sh /Volumes/PortableDrive
EOF
}

POSITIONAL=()
PLAINTEXT=0
for arg in "$@"; do
  case "$arg" in
    --plaintext) PLAINTEXT=1 ;;
    --help|-h) usage; exit 0 ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done

if [[ ${#POSITIONAL[@]} -lt 1 || ${#POSITIONAL[@]} -gt 2 ]]; then
  usage
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_PARENT="$(cd "${POSITIONAL[0]}" && pwd)"
BUNDLE_NAME="${POSITIONAL[1]:-cuassistant-machine-bundle}"
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
- .env  (MS365 refresh token + API keys — SECRET)
- config/accounts.yaml
- config/classification.yaml
- config/taxonomy.yaml
- config/institutions.yaml
- config/known_contacts.yaml
- state/

Not included:
- node_modules/
- dist/
- external tool auth outside the repo (Codex CLI sign-in state, gws auth)
EOF

chmod 600 "${BUNDLE_DIR}/.env" 2>/dev/null || true
chmod -R go-rwx "${BUNDLE_DIR}/config" 2>/dev/null || true
chmod -R go-rwx "${BUNDLE_DIR}/state" 2>/dev/null || true

if [[ ${PLAINTEXT} -eq 1 ]]; then
  echo "WARNING: --plaintext — the bundle contains the MS365 refresh token in"
  echo "         cleartext at: ${BUNDLE_DIR}/.env"
  echo "         Treat this directory as a secret; prefer the encrypted default."
  echo "Created plaintext bundle at: ${BUNDLE_DIR}"
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl not found — cannot encrypt. Re-run with --plaintext only if you" >&2
  echo "accept a cleartext credential on the destination, or install openssl." >&2
  rm -rf "${BUNDLE_DIR}"
  exit 1
fi

ENC_PATH="${BUNDLE_DIR}.tar.gz.enc"
echo "Encrypting bundle (you will be prompted for a passphrase)…"
tar -C "${DEST_PARENT}" -czf - "${BUNDLE_NAME}" \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -out "${ENC_PATH}"
rm -rf "${BUNDLE_DIR}"
chmod 600 "${ENC_PATH}" 2>/dev/null || true

echo "Created encrypted bundle at: ${ENC_PATH}"
echo "Restore it with: scripts/install-machine-bundle.sh \"${ENC_PATH}\""
