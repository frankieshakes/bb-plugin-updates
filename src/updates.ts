// The update service: runs checks, builds the report, tracks ignored and
// announced versions, and starts updates. RPC and CLI both call into it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DEFERRED_UPDATE, NEW_UPDATES, OUT_OF_RANGE_CHANGED, REPORT_CHANGED } from "./channels";
import type { DeferredUpdate, ReportSnapshot, UpdateRequest } from "./contract";
import { listRemoteTags } from "./git";
import { preflightOutOfRange, updateOutOfRange } from "./out-of-range";
import { createOutOfRangeQueue } from "./out-of-range-queue";
import { releaseCheckTarget, resolveNewerRelease } from "./releases";
import { buildReport, type ReleaseResult, type Report } from "./report";
import type { Store } from "./store";
import { message } from "./errors";

export function createUpdateService(
  bb: BbPluginApi,
  store: Store,
  options: { toastOnNewUpdate: boolean; jobPollMs: number },
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

  // bb serializes installs, but an out-of-range update is three of them
  // (remove, install, restore settings), so a bb update job for the same
  // plugin could land in between. Neither kind starts while the other is
  // pending for that plugin; whichever came second waits.

  /** Plugins whose bb update job is being started (not listed yet). */
  const starting = new Set<string>();

  async function startUpdate(pluginId: string) {
    starting.add(pluginId);
    try {
      return await plugins.experimental_startUpdate({ pluginId });
    } finally {
      starting.delete(pluginId);
    }
  }

  /** Whether `id` has a bb update job starting, queued, or running. */
  async function hasActiveJob(id: string) {
    if (starting.has(id)) return true;
    try {
      const jobs = await plugins.experimental_updateJobs.list();
      return jobs.some((j) => j.pluginId === id && (j.state === "queued" || j.state === "running"));
    } catch (error) {
      // Go ahead rather than stall the queue; bb's lock still keeps installs apart.
      bb.log.warn(`listing update jobs failed, so not waiting on ${id}'s: ${message(error)}`);
      return false;
    }
  }

  /** Plugins with a compatible update waiting on their out-of-range update. */
  const deferred = new Set<string>();

  /** Starts a compatible update, or defers it while `id` has an out-of-range update pending. */
  async function startOrDefer(id: string): Promise<UpdateRequest> {
    const pending = outOfRange.pending(id);
    if (pending === undefined) return { kind: "job", job: await startUpdate(id) };
    if (!deferred.has(id)) {
      deferred.add(id);
      void outOfRange.settled(pending.run).then(() => startDeferred(id));
    }
    return { kind: "deferred", id };
  }

  /** Runs once the out-of-range update has settled, and so re-checked. */
  async function startDeferred(id: string) {
    deferred.delete(id);
    let outcome: DeferredUpdate;
    try {
      const current = await currentReport();
      if (!current?.report.compatible.some((i) => i.id === id)) {
        outcome = { id, outcome: "skipped" };
      } else {
        const request = await startOrDefer(id);
        // Another out-of-range update was queued meanwhile; wait for that one too.
        if (request.kind === "deferred") return;
        outcome = { id, outcome: "started", jobId: request.job.id };
      }
    } catch (error) {
      bb.log.warn(`deferred update of ${id} failed to start: ${message(error)}`);
      outcome = { id, outcome: "failed", error: message(error) };
    }
    bb.realtime.publish(DEFERRED_UPDATE, outcome);
  }

  /**
   * Out-of-range updates are never included (each needs its own confirmation),
   * nor are disabled plugins.
   */
  async function updateAllCompatible() {
    const current = await currentReport();
    const ids = current?.report.compatible.filter((i) => !i.disabled).map(({ id }) => id) ?? [];
    const jobs = [];
    const deferredIds = [];
    for (const pluginId of ids) {
      const request = await startOrDefer(pluginId);
      if (request.kind === "job") jobs.push(request.job);
      else deferredIds.push(pluginId);
    }
    return { jobs, deferred: deferredIds };
  }

  const outOfRange = createOutOfRangeQueue({
    preflight: (id) => preflightOutOfRange({ bb, id, currentReport }),
    busy: hasActiveJob,
    pollMs: options.jobPollMs,
    apply: (item) => updateOutOfRange({ bb, item }),
    // Re-check whatever happened, so every list (and the badge) catches up.
    afterEach: () =>
      check().catch((error) => bb.log.warn(`check after out-of-range update failed: ${message(error)}`)),
    onChange: ({ id, state }) => bb.realtime.publish(OUT_OF_RANGE_CHANGED, { id, state }),
  });

  return {
    check,
    currentReport,
    setIgnored,
    startOrDefer,
    updateAllCompatible,
    listJobs: () => plugins.experimental_updateJobs.list(),
    /** Queues an out-of-range update; manual steps come back without queueing. */
    enqueueOutOfRange: outOfRange.enqueue,
    outOfRangeQueue: outOfRange.list,
    outOfRangeSettled: outOfRange.settled,
    /** Forget which versions were announced, so the next check toasts them again. */
    forgetAnnounced: () => store.forgetSeen(),
  };
}

export type UpdateService = ReturnType<typeof createUpdateService>;
