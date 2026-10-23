// The plugin's settings and the check schedule they select.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const CHECK_CRON: Record<string, string> = {
  "1h": "0 * * * *",
  "6h": "0 */6 * * *",
  "24h": "0 9 * * *",
};

/** Settings are read once per load; changing one needs a plugin reload. */
export async function loadSettings(bb: BbPluginApi) {
  const settings = bb.settings.define({
    toastOnNewUpdate: {
      type: "boolean",
      label: "Toast when a new update is found",
      description: "Off: only the badge shows new updates.",
      default: true,
    },
    checkInterval: {
      type: "select",
      label: "Check for updates every",
      description: "Reload the plugin after changing this.",
      options: ["1h", "6h", "24h", "off"],
      default: "6h",
    },
  });
  const { toastOnNewUpdate, checkInterval } = await settings.get();
  /** Undefined when checks are off. */
  const checkCron: string | undefined = CHECK_CRON[checkInterval];
  return { toastOnNewUpdate, checkCron };
}
