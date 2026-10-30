# bb-plugin-updates

A BB plugin (id `plugin-updates`) that surfaces plugin updates in the UI and
applies them, including newer git releases that fall **outside** a plugin's
installed semver range or pin, which `bb plugin outdated` never reports.

- **Count bubble** on the Plugin Updates nav rail icon. bb doesn't render
  `experimental_sidebarAccessory` on the rail yet, so the frontend decorates
  bb's `[data-nav-rail-item]` entry directly (and registers the accessory for
  when bb does).
- **Toast** once per newly found version (setting `toastOnNewUpdate`).
- **Disabled plugins** keep their updates listed with a "Disabled" tag, but
  aren't counted, toasted (until re-enabled), or included in Update all.
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

  These run one at a time on the server, in the order they're confirmed
  (page or CLI); confirming one that's already queued or running is a no-op.
  Every window shows the queue and toasts each update's progress and
  outcome. The queue is in memory, so reloading the plugin drops it.

- **Same plugin, both kinds**: bb serializes installs, but a reinstall is
  three of them, so the two kinds never overlap for one plugin when started
  from here (page or `bb plugin-updates`); the later one waits. An
  out-of-range update whose plugin has a bb update job (from anywhere) shows
  as waiting until the job ends (if bb's jobs can't be listed, it goes ahead).
  After 10 minutes it gives up untouched (`timed-out`) and the queue moves on.
  A compatible update requested here while the plugin has an out-of-range
  update pending is deferred: the request returns at once, and the job starts
  after the reinstall's re-check, or is skipped if no compatible update is
  left. Update all defers only those plugins. The server re-checks when a
  deferred job ends, and every window toasts it. A bb update started outside
  this plugin (bb's own UI or CLI) once a reinstall has begun isn't held back.

## Settings

| Key | Default | |
| --- | --- | --- |
| `checkInterval` | `6h` | `1h`, `6h`, `24h`, or `off` (no load or scheduled checks). Reload after changing. |
| `toastOnNewUpdate` | `true` | Off: badge only. |

## Code organization

```
server.ts              backend entry: wires settings, schedule, RPC, and CLI
app.tsx                frontend entry: registers the page, overlay, and rail accessory

src/                   backend + shared logic
  contract.ts          RPC contract and result types (frontend imports types only)
  channels.ts          realtime channel names (shared)
  settings.ts          settings descriptors → check schedule
  store.ts             bb.storage.kv: last check, ignored, announced versions
  updates.ts           update service: check, report, ignore, announce, start updates
  out-of-range.ts      preflight, then remove → install → restore settings, with rollback
  out-of-range-queue.ts runs those one at a time, in order (in memory)
  cli.ts               `bb plugin-updates` command
  releases.ts          newer tags beyond a range or pin (pure)
  report.ts            page sections, badge count, ignore/disabled/toast rules (pure)
  format.ts            report → CLI text (pure)
  git.ts               `git ls-remote --tags` (no prompts, 15s timeout)
  errors.ts            error → message

components/            frontend components
  UpdatesPage.tsx      the page; composes sections/ and the dialog
  sections/            compatible, out-of-range, notices, collapsed lists
  OutOfRangeDialog.tsx confirmation (queues the update) + manual steps
  UpdatesOverlay.tsx   headless: rail count bubble + toasts, incl. out-of-range progress
  RailAccessory.tsx    native rail accessory (unused by bb today)
  list.tsx             Section, Collapsed, Row
  ui/                  vendored bb components
hooks/                 useUpdates (report + realtime), useUpdateJobs (bb jobs),
                       useOutOfRangeQueue (out-of-range queue + realtime),
                       useRailBubble (nav rail decoration)
lib/updates.ts         frontend constants and helpers
lib/toasts.ts          toasts shared by the overlay, page, and dialog

test/                  vitest: releases, report (pure), server (fake bb host via RPC + CLI)
skills/plugin-updates/ agent skill for the CLI
icons/update.svg       nav + branding icon
```

The pure modules (`releases`, `report`, `format`) hold the decisions and have
their own tests. Everything that touches bb goes through `updates.ts` and is
tested through RPC and the CLI against a fake plugin host. `git.ts` is the
only module mocked.

## Develop

```
npm install
npm test           # vitest
npm run typecheck
bb plugin build
bb plugin install .
bb plugin dev      # rebuild + reload on change
```

## License

MIT. See [LICENSE](LICENSE).
