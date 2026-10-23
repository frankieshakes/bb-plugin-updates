// bb-plugin-plugin-updates — backend entry. Surfaces plugin updates bb has
// (compatible candidates) and the ones it can't see (newer releases outside a
// plugin's range or pin), and applies both. This file only wires the pieces
// in src/ together; see README "Code organization".
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerCli } from "./src/cli";
import { rpcContract } from "./src/contract";
import { message } from "./src/errors";
import { loadSettings } from "./src/settings";
import { createStore } from "./src/store";
import { createUpdateService } from "./src/updates";

export { rpcContract };

export default async function plugin(bb: BbPluginApi) {
  const { toastOnNewUpdate, checkCron } = await loadSettings(bb);
  const updates = createUpdateService(bb, createStore(bb.storage.kv), { toastOnNewUpdate });

  if (checkCron !== undefined) {
    bb.background.schedule("check", checkCron, async () => {
      await updates.check();
    });
    bb.background.service("check-on-load", {
      async start(signal) {
        try {
          await updates.check();
        } catch (error) {
          bb.log.warn(`check on load failed: ${message(error)}`);
        }
        if (signal.aborted) return;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      },
    });
  }

  bb.rpc.register(rpcContract, {
    check: () => updates.check(),
    report: () => updates.currentReport(),
    ignore: ({ id, version }) => updates.setIgnored(id, version, true),
    unignore: ({ id, version }) => updates.setIgnored(id, version, false),
    update: async ({ id }) => ({ kind: "job" as const, job: await updates.startUpdate(id) }),
    update_all: () => updates.updateAllCompatible(),
    update_out_of_range: ({ id }) => updates.updateOutOfRange(id),
    jobs: async () => ({ jobs: await updates.listJobs() }),
  });

  registerCli(bb, updates);
}
