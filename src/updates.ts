// The update service: runs checks, builds the report, tracks ignored and
// announced versions, and starts updates. RPC and CLI both call into it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import semver from "semver";
import { engineRefusal, isCheckError } from "./bb-errors";
import { DEFERRED_UPDATE, NEW_UPDATES, OUT_OF_RANGE_CHANGED, REPORT_CHANGED } from "./channels";
import type { DeferredUpdate, OutOfRangeResult, ReportSnapshot, UpdateJob, UpdateRequest } from "./contract";
import { cachedHostVersions, releaseProblems } from "./engines";
import { listRemoteTags } from "./git";
import { preflightOutOfRange, updateOutOfRange } from "./out-of-range";
import { createOutOfRangeQueue } from "./out-of-range-queue";
import { newerReleases, releaseCheckTarget, selectRunnableRelease } from "./releases";
import {
  buildReport,
  type CarriedCheck,
  type CarriedRelease,
  type CheckEntry,
  type OutOfRangeItem,
  type ReleaseResult,
  type Report,
} from "./report";
import type { LastCheck, PluginCheckFailure, Refusal, Store, StoredCheckFailure } from "./store";
import { boundedMessage, message } from "./errors";

/** How many per-plugin checks the fallback runs at once. */
const FALLBACK_CONCURRENCY = 4;

/** Every plugin that can be checked failed its check, so the check failed as a whole. */
class EveryCheckFailed extends Error {
  constructor(readonly failures: PluginCheckFailure[]) {
    super("every plugin's update check failed");
  }
}

/** Plugins bb fetches to check; builtin and local ones it doesn't, so they can't fail. */
const isCheckable = (p: { source: string }) => p.source.startsWith("git:") || p.source.startsWith("npm:");

export function createUpdateService(
  bb: BbPluginApi,
  store: Store,
  options: { toastOnNewUpdate: boolean; jobPollMs: number; jobWaitTimeoutMs: number },
) {
  const { plugins } = bb.sdk;
  const hostVersions = cachedHostVersions(bb);

  /** `refused`: a release bb refused on apply, judged refused again without reading it. */
  async function checkRelease(id: string, version: string, refused?: Refusal): Promise<ReleaseResult> {
    try {
      // Inside the try: a plugin removed meanwhile 404s here (see check()).
      const source = await plugins.getSource({ pluginId: id });
      const target = releaseCheckTarget(source);
      if (target.kind === "skip") return { kind: "none" };
      const lsRemote = await listRemoteTags(target.url);
      const releases = newerReleases({ source, installedVersion: version, lsRemote });
      if (releases.length === 0) return { kind: "none" };
      const host = await hostVersions();
      const { subdirectory } = source;
      // Skips releases this bb would refuse to install, as bb's own check does.
      return await selectRunnableRelease(releases, async ({ tag, to }) =>
        to === refused?.version
          ? [refused.reason]
          : releaseProblems({ url: target.url, tag, ...(subdirectory === undefined ? {} : { subdirectory }) }, host),
      );
    } catch (error) {
      return { kind: "failed", error: message(error) };
    }
  }

  async function currentReport(): Promise<ReportSnapshot> {
    const [last, lastFailure] = await Promise.all([store.lastCheck(), store.lastFailure()]);
    if (last === null) return null;
    // Read live, so turning a plugin on or off shows without a re-check.
    const { plugins: installed } = await plugins.list();
    const failures = last.updateCheckFailures ?? [];
    const report = buildReport({
      checks: last.checks,
      releases: last.releases,
      ignored: await store.ignored(),
      seen: await store.seen(),
      disabled: installed.filter((p) => p.enabled === false).map((p) => p.id),
      unchecked: failures.map(({ id }) => id),
      carried: failures.flatMap(({ carried }) => (carried === undefined ? [] : [carried])),
    });
    return {
      report,
      checkedAt: last.checkedAt,
      ...(lastFailure === null ? {} : { lastFailure }),
      ...(failures.length === 0 ? {} : { updateCheckFailures: failures.map(({ id, error }) => ({ id, error })) }),
    };
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

  /**
   * bb's update check can fail as a whole (e.g. a plugin removed mid-check),
   * so on failure check each plugin on its own, a few at a time. Throws the
   * bulk error if none of those work either.
   */
  async function checkUpdates(ids: string[]) {
    let bulkError: unknown;
    try {
      return { checks: await plugins.checkUpdates(), failures: [] as PluginCheckFailure[] };
    } catch (error) {
      bulkError = error;
    }
    // In install order, like the bulk check.
    const results: Array<{ checks: CheckEntry[] } | PluginCheckFailure> = [];
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const i = next++;
        const id = ids[i]!;
        try {
          results[i] = { checks: await plugins.checkUpdates({ pluginId: id }) };
        } catch (error) {
          results[i] = { id, error: boundedMessage(error) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FALLBACK_CONCURRENCY, ids.length) }, worker));
    const failures = results.filter((r) => "error" in r);
    if (failures.length === ids.length) throw bulkError;
    bb.log.warn(
      `update check failed, so checked each plugin; ${failures.length} of ${ids.length} failed: ${message(bulkError)}`,
    );
    return { checks: results.flatMap((r) => ("checks" in r ? r.checks : [])), failures };
  }

  /** Records the failure, so the page and CLI can say so; the last good check stays. */
  async function recordFailure(error: unknown) {
    try {
      await store.saveLastFailure({
        at: Date.now(),
        error: boundedMessage(error),
        ...(error instanceof EveryCheckFailed ? { failures: error.failures } : {}),
      });
      await publishReport();
    } catch (recordError) {
      bb.log.warn(`recording a failed check failed: ${message(recordError)}`);
    }
  }

  /** The compatible update `last` found for `id`, if still for the version installed. */
  function carriedCheck(last: LastCheck | null, id: string, installed?: string): CarriedCheck | undefined {
    if (last === null) return undefined;
    const found = last.checks.find((e) => e.id === id && e.outcome === "update-available");
    const carried =
      found === undefined
        ? last.updateCheckFailures?.find((f) => f.id === id)?.carried
        : { entry: found, confirmedAt: last.checkedAt };
    // Without bb's entry for it this time, there's nothing to compare with.
    return installed === undefined || carried?.entry.installed.version === installed ? carried : undefined;
  }

  /** The release outside the range `last` found for `id`, if still from `version`. */
  function carriedRelease(last: LastCheck | null, id: string, version: string): CarriedRelease | undefined {
    const found = last?.releases[id];
    const carried =
      found?.kind === "out-of-range"
        ? { release: found, confirmedAt: last!.checkedAt }
        : found?.kind === "failed"
          ? found.carried
          : undefined;
    return carried?.release.from === version ? carried : undefined;
  }

  async function check() {
    try {
      const [{ plugins: listed }, last, refusals, host] = await Promise.all([
        plugins.list(),
        store.lastCheck(),
        store.refusals(),
        hostVersions(),
      ]);
      const result = await checkUpdates(listed.map((p) => p.id));
      // bb returns a plugin whose check errored as `unavailable` (see isCheckError).
      const checks = result.checks.filter((e) => !isCheckError(e));
      const failures: StoredCheckFailure[] = [
        ...result.failures,
        ...result.checks.filter(isCheckError).map((e) => ({ id: e.id, error: boundedMessage(e.detail) })),
      ].map((f) => {
        const installed = result.checks.find((e) => e.id === f.id)?.installed.version;
        const carried = carriedCheck(last, f.id, installed);
        return carried === undefined ? f : { ...f, carried };
      });
      // A refusal holds while bb and the plugin stay on the versions it was refused on.
      const refused = (p: { id: string; version: string }) => {
        const r = refusals[p.id];
        return r !== undefined && r.from === p.version && r.bbVersion === host.bb ? r : undefined;
      };
      const releases: Record<string, ReleaseResult> = {};
      await Promise.all(
        listed
          .filter((p) => !p.source.startsWith("builtin:"))
          .map(async (p) => {
            const release = await checkRelease(p.id, p.version, refused(p));
            const carried = release.kind === "failed" ? carriedRelease(last, p.id, p.version) : undefined;
            releases[p.id] = release.kind === "failed" && carried !== undefined ? { ...release, carried } : release;
          }),
      );
      // A plugin removed meanwhile (an out-of-range update reinstalls one) has
      // nothing to update, so it's left out rather than listed as failing.
      let installed = listed;
      try {
        installed = (await plugins.list()).plugins;
      } catch (error) {
        bb.log.warn(`re-listing plugins after the check failed: ${message(error)}`);
      }
      const present = new Set(installed.map((p) => p.id));
      const kept = failures.filter((f) => present.has(f.id));
      const checkable = installed.filter(isCheckable);
      if (checkable.length > 0 && checkable.every((p) => kept.some((f) => f.id === p.id))) {
        throw new EveryCheckFailed(kept.map(({ id, error }) => ({ id, error })));
      }
      await forgetRefusals(refusals, (id, r) => {
        const p = installed.find((i) => i.id === id);
        const release = releases[id];
        // Gone, moved, on another bb, refused release no longer newer, or a newer one runs.
        return (
          p === undefined ||
          refused(p) !== r ||
          release?.kind === "none" ||
          (release?.kind === "out-of-range" && semver.valid(r.version) !== null && semver.gt(release.to, r.version))
        );
      });
      await store.saveLastCheck({
        checks: checks.filter((e) => present.has(e.id)),
        releases: Object.fromEntries(Object.entries(releases).filter(([id]) => present.has(id))),
        checkedAt: Date.now(),
        ...(kept.length === 0 ? {} : { updateCheckFailures: kept }),
      });
    } catch (error) {
      await recordFailure(error);
      throw error;
    }
    await store.clearLastFailure();
    const current = await publishReport();
    if (current !== null) await announce(current.report);
    return current;
  }

  /** Drops refusals `stale` picks, re-reading them so one saved meanwhile stays. */
  async function forgetRefusals(seen: Record<string, Refusal>, stale: (id: string, r: Refusal) => boolean) {
    const forget = Object.entries(seen).filter(([id, r]) => stale(id, r));
    if (forget.length === 0) return;
    const refusals = await store.refusals();
    for (const [id, r] of forget) if (refusals[id]?.version === r.version) delete refusals[id];
    await store.saveRefusals(refusals);
  }

  /**
   * Remembers a release bb refused for its engines, so it's shown as blocked
   * rather than offered again; check() forgets it once it may no longer hold.
   */
  async function rememberRefusal(item: OutOfRangeItem, result: OutOfRangeResult) {
    if (result.kind !== "rolled-back") return;
    const reason = engineRefusal(result.error);
    if (reason === undefined) return;
    try {
      const [{ plugins: installed }, host, refusals] = await Promise.all([
        plugins.list(),
        hostVersions(),
        store.refusals(),
      ]);
      const from = installed.find((p) => p.id === item.id)?.version;
      if (from === undefined) return;
      refusals[item.id] = { version: item.to, reason, from, ...(host.bb === undefined ? {} : { bbVersion: host.bb }) };
      await store.saveRefusals(refusals);
    } catch (error) {
      bb.log.warn(`remembering bb's refusal of ${item.id} ${item.to} failed: ${message(error)}`);
    }
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
  // plugin could land in between. Of the updates started here, neither kind
  // starts while the other is pending for that plugin; whichever came second
  // waits. A reinstall also waits for bb jobs started elsewhere (bb's own UI
  // or CLI), but bb can't hold those back while a reinstall runs.

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

  const isActive = (job: UpdateJob) => job.state === "queued" || job.state === "running";

  /** Whether `id` has a bb update job starting, queued, or running. */
  async function hasActiveJob(id: string) {
    if (starting.has(id)) return true;
    try {
      const jobs = await plugins.experimental_updateJobs.list();
      return jobs.some((j) => j.pluginId === id && isActive(j));
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
        void watchDeferred(id, request.job.id);
      }
    } catch (error) {
      bb.log.warn(`deferred update of ${id} failed to start: ${message(error)}`);
      outcome = { id, outcome: "failed", error: message(error) };
    }
    bb.realtime.publish(DEFERRED_UPDATE, outcome);
  }

  /**
   * Re-checks once a deferred update's job ends: no page may be open to do it,
   * and one opened later sees the job already done. Gives up like the queue does.
   */
  async function watchDeferred(id: string, jobId: string) {
    const giveUpAt = Date.now() + options.jobWaitTimeoutMs;
    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, options.jobPollMs));
        const job = (await plugins.experimental_updateJobs.list()).find((j) => j.id === jobId);
        if (job === undefined || !isActive(job)) {
          await check();
          if (job === undefined) return;
          const ended: DeferredUpdate = { id, outcome: "ended", job };
          bb.realtime.publish(DEFERRED_UPDATE, ended);
          return;
        }
        if (Date.now() >= giveUpAt) {
          bb.log.warn(`gave up waiting for ${id}'s deferred update job ${jobId} to end`);
          return;
        }
      }
    } catch (error) {
      bb.log.warn(`watching ${id}'s deferred update job failed: ${message(error)}`);
    }
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
    waitTimeoutMs: options.jobWaitTimeoutMs,
    apply: async (item, onStart) => {
      const result = await updateOutOfRange({ bb, item, onStart });
      await rememberRefusal(item, result);
      return result;
    },
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
