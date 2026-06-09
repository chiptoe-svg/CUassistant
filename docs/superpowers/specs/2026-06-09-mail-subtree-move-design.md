# Subtree Mail-Move (MS365 + Gmail) — Design

**Date:** 2026-06-09
**Status:** Approved — building

## Goal

Let the agent move messages into any folder/label under an allowed **subtree**
(e.g. `sorted`), across **both** mail providers as first-class peers, and
discover valid destinations itself — without re-listing destinations whenever a
new subfolder is added, and without ever reaching Trash/Junk/Recoverable.

## Unifying model: destinations are paths; the allow-list is path prefixes

- A destination is a **path** — `sorted/Newsletters`. MS365 folder hierarchy and
  Gmail nested labels both use `/`-separated paths, so one model fits both.
- `MCP_ALLOWED_MAIL_DESTINATIONS` is a list of allowed **path prefixes**
  (segment-aware, case-insensitive), e.g. `sorted`. A destination is valid iff
  its path is at/under an allowed prefix **and** is not a blocked system folder
  (trash/deleted/junk/spam/recoverable). Future subfolders are covered with no
  re-enumeration. Empty list ⇒ fail closed (no moves).

## Providers (`account`)

- `ms365` — Microsoft Graph. Folders via `/me/mailFolders` + `childFolders`;
  move via `POST /me/messages/{id}/move { destinationId }`.
- `g.clemson` — Gmail via the `gws` CLI. Labels via `users labels list` (user
  labels; the label name _is_ the path); "move" via `users messages modify`
  `{ addLabelIds:[labelId], removeLabelIds:["INBOX"] }` (apply label + archive
  from inbox = move to folder). Other labels untouched.

## Tools

1. **`list-mail-folders`** (new, read-only). Input `{ account }`. Returns
   `[{ path, id, allowed }]` so the agent can discover the `sorted/*` subtree.
   Policy action `mail.list_folders` (read_only, own-mailbox).
2. **`move-mail-message`** (extended). Input `{ account, id, destination }` where
   `destination` is a path (e.g. `sorted/Newsletters`). Enforcement, two layers:
   - sync policy constraint `destination_subtree_allow_list` prefix-checks the
     requested path + blocks system folders;
   - the handler resolves the path against the provider's _real_ folder/label
     list (a bogus or non-subtree path won't resolve ⇒ refused), then moves.

## Files

- `src/mail-paths.ts` (new, pure): `normalizeMailPath`, `isUnderAllowedPrefix`
  (segment-aware), `isBlockedMailFolder`, `buildFolderPaths` (flatten a Graph
  folder list to `{id, path}` via parent chain). Unit-tested.
- `src/mcp-tools/graph-helpers.ts`: `listMs365MailFolders`,
  `resolveMs365FolderByPath` (Graph).
- `src/mcp-tools/gmail-folders.ts` (new): `listGmailLabels`,
  `resolveGmailLabelByPath`, `moveGmailMessage` (gws); `parseGmailLabels` pure.
- `src/mcp-tools/mail-folders.ts` (new): the `list-mail-folders` tool +
  account dispatch.
- `src/mcp-tools/mail-write.ts`: extend `move-mail-message` (account + path).
- `policy/action-policy.yaml`: add `mail.list_folders`; swap move's
  `destination_folder_allow_list` → `destination_subtree_allow_list`.
- `src/mcp-tools/permissions.ts`: map `mail.list_folders`; add the
  `destination_subtree_allow_list` validator (sync prefix + block check).
- `.env.example` / config docs: `MCP_ALLOWED_MAIL_DESTINATIONS` = prefixes.

## Testing

Pure logic (`mail-paths`, `parseGmailLabels`, `buildFolderPaths`) unit-tested;
provider list/resolve fed mock records; existing suite stays green. Live: list
folders for both accounts, confirm the `sorted/*` subtree, and a reversible
round-trip move (move a test message in, then back) per provider.

## Notes

- One MCP operation per tool spanning two backends; the `backend` field is
  informational (the real gate is policy approval + constraints + live path
  resolution). A `gws` backend value is added for clarity.
- Account labels are exactly `ms365` and `g.clemson`.
