// Moving a plugin to a release outside its installed range or pin.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { OutOfRangeResult, ReportSnapshot } from "./contract";
import { message } from "./errors";

export function installCommand(source: string, subdirectory: string | undefined): string {
  const sub = subdirectory === undefined ? "" : ` --subdirectory '${subdirectory}'`;
  return `bb plugin install '${source}'${sub}`;
}

/**
 * bb refuses to install an installed plugin again, so moving outside the
 * range means remove + install — and remove deletes the plugin's settings.
 * Snapshot them first and restore them after; reinstall the old source if the
 * new one fails.
 */
export async function updateOutOfRange({
  bb,
  id,
  currentReport,
  afterwards,
}: {
  bb: BbPluginApi;
  id: string;
  currentReport: () => Promise<ReportSnapshot>;
  /** Runs after any change to installed plugins (re-check). */
  afterwards: () => Promise<unknown>;
}): Promise<OutOfRangeResult> {
  const { plugins } = bb.sdk;
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
      await afterwards();
      return {
        kind: "failed",
        error: message(rollbackError),
        command: installCommand(source.requested, source.subdirectory),
      };
    }
    await restoreSettings();
    await afterwards();
    return { kind: "rolled-back", error: message(error) };
  }
  await restoreSettings();
  await afterwards();
  return { kind: "updated", from: item.from, to: item.to };
}
