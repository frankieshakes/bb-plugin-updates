---
name: plugin-updates
description: Check BB plugins for updates, including newer releases outside a plugin's installed semver range or pin, with the `bb plugin-updates` CLI. Use when the user asks whether plugins have updates, or to update, or to ignore one.
---

# Plugin updates

`bb plugin outdated` only reports updates inside each plugin's installed
range. `bb plugin-updates` also finds newer git releases beyond the range
(e.g. `^0.7.0` → `0.9.2`) or newer than a pinned commit or tag.

## Commands

| Command | Effect |
| --- | --- |
| `bb plugin-updates list [--json]` | Show the last check's results. |
| `bb plugin-updates check [--json] [--reannounce]` | Check now (contacts each plugin's git remote). `--reannounce` toasts already-announced updates again. |
| `bb plugin-updates update <id>` | Start bb's in-place update for a compatible update (deferred until the plugin's pending out-of-range update, if any, is done). |
| `bb plugin-updates update --all` | Start every compatible update. Never includes out-of-range ones. |
| `bb plugin-updates update <id> --out-of-range` | Remove and reinstall at the newer release, restoring settings. |
| `bb plugin-updates ignore <id>` | Hide the plugin's pending versions until a newer one appears. |

## Rules

- Updates for disabled plugins are listed as `<id> (disabled)` and skipped by
  `update --all`. Mention that the plugin is off; the user may prefer to
  remove it (`bb plugin remove`) rather than update it.
- Updates run third-party code. Only run `update` when the user asked for
  that plugin to be updated.
- `--out-of-range` reinstalls the plugin: settings are restored, but its
  storage and schedules may reset. Confirm with the user first and show the
  compare link from `list`.
- Plugins with secret settings, and this plugin itself, can't be moved out of
  range automatically. The command prints the manual steps instead; show them
  to the user rather than running them.
