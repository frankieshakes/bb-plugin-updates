# bb-plugin-updates

A BB plugin (id `plugin-updates`) that surfaces plugin updates in the UI and
applies them, including newer git releases that fall **outside** a plugin's
installed semver range or pin, which `bb plugin outdated` never reports.

- **Count bubble** on the Plugin Updates nav rail icon. bb doesn't render
  `experimental_sidebarAccessory` on the rail yet, so the frontend decorates
  bb's `[data-nav-rail-item]` entry directly (and registers the accessory for
  when bb does).
- **Toast** once per newly found version (setting `toastOnNewUpdate`).
- **Plugin Updates page** with these sections:
  - Compatible updates, with Update all
  - Newer releases outside the range, each behind a confirmation dialog
  - Blocked by engine ranges
  - Couldn't check
  - Collapsed: Ignored, Up to date, and Pinned
- **CLI**: `bb plugin-updates list | check | update <id> [--out-of-range] | update --all | ignore <id>`.

## How updates are applied

- **Compatible**: bb's own in-place update job (`experimental_startUpdate`).
- **Out of range**: bb refuses to reinstall an installed plugin, so this
  takes four steps:
  1. Snapshot the plugin's non-secret settings.
  2. Remove the plugin.
  3. Install it at the new source.
  4. Restore the settings.

  If the install fails, the old source is reinstalled. If that fails too,
  the reinstall command is returned. The new source keeps the install's
  style: a range becomes `^<newest>`, a commit pin moves to the newest tag's
  commit, and a tag pin moves to the newest tag. Plugins with secret
  settings, and this plugin itself, get manual steps instead.

## Settings

| Key | Default | |
| --- | --- | --- |
| `checkInterval` | `6h` | `1h`, `6h`, `24h`, or `off` (no load or scheduled checks). Reload after changing. |
| `toastOnNewUpdate` | `true` | Off: badge only. |

## Layout

- `src/releases.ts`: finds newer tags beyond a range or pin (pure).
- `src/report.ts`: builds page sections, badge count, ignore rules, and toast de-duplication (pure).
- `src/git.ts`: `git ls-remote --tags` with no prompts and a 15s timeout.
- `server.ts`: RPC, CLI, schedule, and the out-of-range apply flow.
- `app.tsx`: the pill, toasts, page, and confirmation dialog.

## Develop

```
npm install
npm test           # vitest
npm run typecheck
bb plugin build
bb plugin install .
bb plugin dev      # rebuild + reload on change
```
