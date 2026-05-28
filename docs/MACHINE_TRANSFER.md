# Moving CUassistant To Another Mac

If the other machine is the same user and same accounts, the fastest path is:

1. On the current machine, create a portable bundle:

```bash
cd /path/to/CUassistant
scripts/export-machine-bundle.sh /Volumes/PortableDrive
```

That writes:

- `/Volumes/PortableDrive/cuassistant-machine-bundle/.env`
- `/Volumes/PortableDrive/cuassistant-machine-bundle/config/*.yaml`
- `/Volumes/PortableDrive/cuassistant-machine-bundle/state/`

2. On the new machine:

```bash
git clone <your repo url>
cd CUassistant
scripts/install-machine-bundle.sh /Volumes/PortableDrive/cuassistant-machine-bundle
```

That copies the private files into the new checkout, runs `npm install`, and
writes a ready-to-load `launchd` plist to:

- `~/Library/LaunchAgents/com.cuassistant.scan.plist`

3. To activate the schedule immediately:

```bash
scripts/install-machine-bundle.sh /Volumes/PortableDrive/cuassistant-machine-bundle --activate-launchd
```

Or later:

```bash
launchctl load ~/Library/LaunchAgents/com.cuassistant.scan.plist
```

## Notes

- The bundle includes `state/`, so the new machine can continue from the same
  progress cursor and audit history.
- If you want a fresh start on the new machine, add `--skip-state` to the
  install script.
- External tool auth that lives outside this repo is not bundled. If you use
  Codex Outlook or `gws`, you may still need to sign those tools in on the new
  machine.
