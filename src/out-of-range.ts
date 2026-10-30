// Moving a plugin to a release outside its installed range or pin.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ManualSteps, OutOfRangeResult, ReportSnapshot } from "./contract";
import { message } from "./errors";
import type { OutOfRangeItem } from "./report";

export function installCommand(source: string, subdirectory: string | undefined): string {
  const sub = subdirectory === undefined ? "" : ` --subdirectory '${subdirectory}'`;
  return `bb plugin install '${source}'${sub}`;
}

/** The plugin's install, and manual steps if a reinstall isn't safe. */
async function readInstall(bb: BbPluginApi, item: OutOfRangeItem) {
  const { plugins } = bb.sdk;
  const { id } = item;
  const [source, settings, { plugins: installed }] = await Promise.all([
    plugins.getSource({ pluginId: id }),
    plugins.getSettings({ pluginId: id }),
    plugins.list(),
  ]);
  // A bb update job may have moved it since the check (e.g. 0.7.0 → 0.7.5).
  const version = installed.find((p) => p.id === id)?.version ?? item.from;
  const manual = (reason: ManualSteps["reason"]): ManualSteps => ({
    kind: "manual",
    reason,
    command: `bb plugin remove ${id} && ${installCommand(item.newSource, source.subdirectory)}`,
  });
  // Removing ourselves would kill this very flow, rollback included.
  if (id === bb.pluginId) return { source, settings, version, manual: manual("self") };
  // Secret values can't be read back, so they'd be lost on remove.
  if (Object.values(settings.schema).some((field) => "secret" in field && field.secret)) {
    return { source, settings, version, manual: manual("secret-settings") };
  }
  return { source, settings, version, manual: undefined };
}

/** Checks up front, before anything is queued or removed. */
export async function preflightOutOfRange({
  bb,
  id,
  currentReport,
}: {
  bb: BbPluginApi;
  id: string;
  currentReport: () => Promise<ReportSnapshot>;
}): Promise<ManualSteps | { kind: "ready"; item: OutOfRangeItem }> {
  const item = (await currentReport())?.report.outOfRange.find((i) => i.id === id);
  if (item === undefined) throw new Error(`No newer release outside the range for ${id}`);
  const { manual } = await readInstall(bb, item);
  return manual ?? { kind: "ready", item };
}

/**
 * bb refuses to install an installed plugin again, so moving outside the
 * range means remove + install — and remove deletes the plugin's settings.
 * Snapshot them first and restore them after; reinstall the old source if the
 * new one fails. `onStart` gets the version actually being moved from.
 */
export async function updateOutOfRange({
  bb,
  item,
  onStart,
}: {
  bb: BbPluginApi;
  item: OutOfRangeItem;
  onStart: (from: string) => void;
}): Promise<OutOfRangeResult> {
  const { plugins } = bb.sdk;
  const { id } = item;
  // Read again: the settings or version may have changed while this waited in the queue.
  const { source, settings, version, manual } = await readInstall(bb, item);
  if (manual !== undefined) return manual;
  onStart(version);
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
      return {
        kind: "failed",
        error: message(rollbackError),
        command: installCommand(source.requested, source.subdirectory),
      };
    }
    await restoreSettings();
    return { kind: "rolled-back", error: message(error) };
  }
  await restoreSettings();
  return { kind: "updated", from: version, to: item.to };
}
