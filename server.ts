// bb-plugin-plugin-updates — surfaces plugin updates bb has (compatible
// candidates) and the ones it can't see (newer releases outside a plugin's
// range or pin), and applies both.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { listRemoteTags } from "./src/git";
import { releaseCheckTarget, resolveNewerRelease } from "./src/releases";
import {
  buildReport,
  type CheckEntry,
  type ReleaseResult,
  type Report,
} from "./src/report";

const versionRef = z.object({ id: z.string().min(1), version: z.string().min(1) });
const reportOutput = z.object({ report: z.custom<Report>(), checkedAt: z.number() }).nullable();

export type UpdateJob = Awaited<
  ReturnType<BbPluginApi["sdk"]["plugins"]["experimental_startUpdate"]>
>;
const jobsOutput = z.object({ jobs: z.array(z.custom<UpdateJob>()) });
const pluginRef = z.object({ id: z.string().min(1) });
const updateOutput = z.object({ kind: z.literal("job"), job: z.custom<UpdateJob>() });

export type OutOfRangeResult =
  | { kind: "updated"; from: string; to: string }
  | { kind: "rolled-back"; error: string }
  | { kind: "failed"; error: string; command: string }
  | { kind: "manual"; reason: "secret-settings" | "self"; command: string };

function installCommand(source: string, subdirectory: string | undefined): string {
  const sub = subdirectory === undefined ? "" : ` --subdirectory '${subdirectory}'`;
  return `bb plugin install '${source}'${sub}`;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const rpcContract = defineRpcContract({
  check: { input: z.null(), output: reportOutput },
  report: { input: z.null(), output: reportOutput },
  ignore: { input: versionRef, output: reportOutput },
  unignore: { input: versionRef, output: reportOutput },
  update: { input: pluginRef, output: updateOutput },
  update_all: { input: z.null(), output: jobsOutput },
  jobs: { input: z.null(), output: jobsOutput },
  update_out_of_range: { input: pluginRef, output: z.custom<OutOfRangeResult>() },
});

/** The last check's raw results; the report is rebuilt from it on demand. */
interface LastCheck {
  checks: CheckEntry[];
  releases: Record<string, ReleaseResult>;
  checkedAt: number;
}

type VersionsById = Record<string, string[]>;

/** Realtime channel the app toasts from; payload `{ updates: [{ id, version }] }`. */
const NEW_UPDATES = "new-updates";
/** Realtime channel every page and the badge refetch on; payload `{ badgeCount }`. */
const REPORT_CHANGED = "report-changed";

export default async function plugin(bb: BbPluginApi) {
  const { plugins } = bb.sdk;
  const { kv } = bb.storage;

  const settings = bb.settings.define({
    toastOnNewUpdate: {
      type: "boolean",
      label: "Toast when a new update is found",
      description: "Off: only the badge shows new updates.",
      default: true,
    },
  });
  const { toastOnNewUpdate } = await settings.get();

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

  async function currentReport() {
    const last = await kv.get<LastCheck>("lastCheck");
    if (last === null || last === undefined) return null;
    const report = buildReport({
      checks: last.checks,
      releases: last.releases,
      ignored: (await kv.get<VersionsById>("ignored")) ?? {},
      seen: (await kv.get<VersionsById>("seen")) ?? {},
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
    const seen = (await kv.get<VersionsById>("seen")) ?? {};
    for (const { id, version } of report.newlySeen) seen[id] = [...(seen[id] ?? []), version];
    await kv.set("seen", seen);
    if (toastOnNewUpdate) bb.realtime.publish(NEW_UPDATES, { updates: report.newlySeen });
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
    await kv.set("lastCheck", { checks, releases, checkedAt: Date.now() } satisfies LastCheck);
    const current = await publishReport();
    if (current !== null) await announce(current.report);
    return current;
  }

  async function setIgnored(id: string, version: string, ignore: boolean) {
    const ignored = (await kv.get<VersionsById>("ignored")) ?? {};
    const versions = (ignored[id] ?? []).filter((v) => v !== version);
    ignored[id] = ignore ? [...versions, version] : versions;
    await kv.set("ignored", ignored);
    return publishReport();
  }

  /** Out-of-range updates are never included: each needs its own confirmation. */
  async function updateAllCompatible() {
    const current = await currentReport();
    const ids = current?.report.compatible.map(({ id }) => id) ?? [];
    const jobs = [];
    for (const pluginId of ids) jobs.push(await plugins.experimental_startUpdate({ pluginId }));
    return { jobs };
  }

  /**
   * bb refuses to install an installed plugin again, so moving outside the
   * range means remove + install — and remove deletes the plugin's settings.
   * Snapshot them first and restore them after.
   */
  async function updateOutOfRange(id: string): Promise<OutOfRangeResult> {
    const item = (await currentReport())?.report.outOfRange.find((i) => i.id === id);
    if (item === undefined) throw new Error(`No newer release outside the range for ${id}`);
    const [source, settings] = await Promise.all([
      plugins.getSource({ pluginId: id }),
      plugins.getSettings({ pluginId: id }),
    ]);
    const manual = (reason: "secret-settings" | "self") => ({
      kind: "manual" as const,
      reason,
      command: `bb plugin remove ${id} && ${installCommand(item.newSource, source.subdirectory)}`,
    });
    // Removing ourselves would kill this very flow, rollback included.
    if (id === bb.pluginId) return manual("self");
    // Secret values can't be read back, so they'd be lost on remove.
    if (Object.values(settings.schema).some((field) => "secret" in field && field.secret)) {
      return manual("secret-settings");
    }
    const install = (requested: string) =>
      plugins.install({
        source: requested,
        ...(source.subdirectory === undefined ? {} : { subdirectory: source.subdirectory }),
      });

    const restoreSettings = async () => {
      if (Object.keys(settings.values).length === 0) return;
      await plugins.updateSettings({ pluginId: id, values: settings.values });
    };

    await plugins.remove({ pluginId: id });
    try {
      await install(item.newSource);
    } catch (error) {
      try {
        await install(source.requested);
      } catch (rollbackError) {
        await check();
        return {
          kind: "failed",
          error: message(rollbackError),
          command: installCommand(source.requested, source.subdirectory),
        };
      }
      await restoreSettings();
      await check();
      return { kind: "rolled-back", error: message(error) };
    }
    await restoreSettings();
    await check();
    return { kind: "updated", from: item.from, to: item.to };
  }

  bb.rpc.register(rpcContract, {
    check: () => check(),
    report: () => currentReport(),
    ignore: ({ id, version }) => setIgnored(id, version, true),
    unignore: ({ id, version }) => setIgnored(id, version, false),
    update: async ({ id }) => ({
      kind: "job" as const,
      job: await plugins.experimental_startUpdate({ pluginId: id }),
    }),
    update_all: () => updateAllCompatible(),
    update_out_of_range: ({ id }) => updateOutOfRange(id),
    jobs: async () => ({ jobs: await plugins.experimental_updateJobs.list() }),
  });
}
