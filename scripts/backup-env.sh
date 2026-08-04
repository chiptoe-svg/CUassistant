#!/usr/bin/env bash
# Back up .env to a timestamped copy OUTSIDE the repo. MUST be run (and confirmed
# successful) before any command that writes/edits/truncates .env — see the
# ".env is irreplaceable" rule in CLAUDE.md. .env holds unrecoverable secrets and
# is gitignored, so there is no `git checkout` fallback.
#
# Guards:
#   - refuses if .env looks truncated (< MIN_KEYS), so a broken file can never
#     overwrite the good backups (the exact failure this exists to prevent);
#   - verifies the copy byte-for-byte;
#   - keeps the last KEEP backups, 0600, in a 0700 dir.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO/.env"
BAK_DIR="${CUASSISTANT_ENV_BACKUPS:-$HOME/.cuassistant/env-backups}"
MIN_KEYS=5
KEEP=30

[ -f "$ENV_FILE" ] || { echo "backup-env: no .env at $ENV_FILE" >&2; exit 1; }

keys=$(grep -cE '^[A-Za-z0-9_]+=' "$ENV_FILE" || true)
if [ "${keys:-0}" -lt "$MIN_KEYS" ]; then
  echo "backup-env: REFUSING — .env has only ${keys:-0} key(s), looks truncated." >&2
  echo "backup-env: not overwriting good backups with a broken file." >&2
  exit 2
fi

mkdir -p "$BAK_DIR"; chmod 700 "$BAK_DIR"
stamp="$(date +%Y%m%d-%H%M%S)"
dest="$BAK_DIR/.env.$stamp"
cp "$ENV_FILE" "$dest"; chmod 600 "$dest"
cmp -s "$ENV_FILE" "$dest" || { echo "backup-env: verify FAILED for $dest" >&2; rm -f "$dest"; exit 3; }

# prune to the newest $KEEP
ls -1t "$BAK_DIR"/.env.* 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

echo "backup-env: backed up .env ($keys keys) -> $dest"
