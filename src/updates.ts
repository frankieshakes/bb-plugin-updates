// The update service: runs checks, builds the report, tracks ignored and
// announced versions, and starts updates. RPC and CLI both call into it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { NEW_UPDATES, REPORT_CHANGED } from "./channels";
import type { ReportSnapshot } from "./contract";
import { listRemoteTags } from "./git";
import { updateOutOfRange } from "./out-of-range";
import { releaseCheckTarget, resolveNewerRelease } from "./releases";
import { buildReport, type ReleaseResult, type Report } from "./report";
import type { Store } from "./store";
import { message } from "./errors";

export function createUpdateService(
  bb: BbPluginApi,
  store: Store,
  options: { toastOnNewUpdate: boolean },
) {
  const { plugins } = bb.sdk;

  async function checkRelease(id: string, version: string): Promise<ReleaseResult> {
    const source = await plugins.getSource({ pluginId: id });
    const target = releaseCheckTarget(source);
    if (target.kind === "skip") return { kind: "none" };
    try {
      const lsRemote = await listRemoteTags(target.url);
      return resolveNewerRelease({ source, installedVersion: version, lsRemote });
    } catch (error) {
      return { kind: "failed", error: message(error) };
    }
  }

  async function currentReport(): Promise<ReportSnapshot> {
    const last = await store.lastCheck();
    if (last === null) return null;
    // Read live, so turning a plugin on or off shows without a re-check.
    const { plugins: installed } = await plugins.list();
    const report = buildReport({
      checks: last.checks,
      releases: last.releases,
      ignored: await store.ignored(),
      seen: await store.seen(),
      disabled: installed.filter((p) => p.enabled === false).map((p) => p.id),
    });
    return { report, checkedAt: last.checkedAt };
  }

  async function publishReport() {
    const current = await currentReport();
    bb.realtime.publish(REPORT_CHANGED, { badgeCount: current?.report.badgeCount ?? 0 });
    return current;
  }

  /** Marks the report's new versions seen; toasts them unless turned off. */
  async function announce(report: Report) {
    if (report.newlySeen.length === 0) return;
    const seen = await store.seen();
    for (const { id, version } of report.newlySeen) seen[id] = [...(seen[id] ?? []), version];
    await store.saveSeen(seen);
    if (options.toastOnNewUpdate) bb.realtime.publish(NEW_UPDATES, { updates: report.newlySeen });
  }

  async function check() {
    const [checks, { plugins: installed }] = await Promise.all([
      plugins.checkUpdates(),
      plugins.list(),
    ]);
    const releases: Record<string, ReleaseResult> = {};
    await Promise.all(
      installed
        .filter((p) => !p.source.startsWith("builtin:"))
        .map(async (p) => {
          releases[p.id] = await checkRelease(p.id, p.version);
        }),
    );
    await store.saveLastCheck({ checks, releases, checkedAt: Date.now() });
    const current = await publishReport();
    if (current !== null) await announce(current.report);
    return current;
  }

  async function setIgnored(id: string, version: string, ignore: boolean) {
    const ignored = await store.ignored();
    const versions = (ignored[id] ?? []).filter((v) => v !== version);
    ignored[id] = ignore ? [...versions, version] : versions;
    await store.saveIgnored(ignored);
    return publishReport();
  }

  const startUpdate = (pluginId: string) => plugins.experimental_startUpdate({ pluginId });

  /**
   * Out-of-range updates are never included (each needs its own confirmation),
   * nor are disabled plugins.
   */
  async function updateAllCompatible() {
    const current = await currentReport();
    const ids = current?.report.compatible.filter((i) => !i.disabled).map(({ id }) => id) ?? [];
    const jobs = [];
    for (const pluginId of ids) jobs.push(await startUpdate(pluginId));
    return { jobs };
  }

  return {
    check,
    currentReport,
    setIgnored,
    startUpdate,
    updateAllCompatible,
    listJobs: () => plugins.experimental_updateJobs.list(),
    updateOutOfRange: (id: string) =>
      updateOutOfRange({ bb, id, currentReport, afterwards: check }),
    /** Forget which versions were announced, so the next check toasts them again. */
    forgetAnnounced: () => store.forgetSeen(),
  };
}

export type UpdateService = ReturnType<typeof createUpdateService>;
