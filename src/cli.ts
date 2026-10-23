// The `bb plugin-updates` command.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { OutOfRangeResult, ReportSnapshot } from "./contract";
import { formatReport } from "./format";
import type { UpdateService } from "./updates";

const usage = [
  "Usage:",
  "  bb plugin-updates list [--json]",
  "  bb plugin-updates check [--json] [--reannounce]",
  "  bb plugin-updates update <id> [--out-of-range]",
  "  bb plugin-updates update --all",
  "  bb plugin-updates ignore <id>",
].join("\n");

function describeOutOfRange(id: string, result: OutOfRangeResult) {
  switch (result.kind) {
    case "updated":
      return { exitCode: 0, stdout: `Updated ${id} ${result.from} → ${result.to}.` };
    case "rolled-back":
      return { exitCode: 1, stderr: `Update failed; ${id} is back on its old version. ${result.error}` };
    case "failed":
      return {
        exitCode: 1,
        stderr: `Update and rollback failed; ${id} is not installed. ${result.error}\nReinstall it with:\n  ${result.command}`,
      };
    case "manual":
      return {
        exitCode: 1,
        stderr: `${id} ${result.reason === "self" ? "can't remove itself" : "has secret settings that a reinstall would lose"}. Update it by hand:\n  ${result.command}`,
      };
  }
}

export function registerCli(bb: BbPluginApi, updates: UpdateService) {
  async function update(id: string, outOfRange: boolean) {
    const report = (await updates.currentReport())?.report;
    if (outOfRange) return describeOutOfRange(id, await updates.updateOutOfRange(id));
    if (report?.compatible.some((i) => i.id === id)) {
      const job = await updates.startUpdate(id);
      return {
        exitCode: 0,
        stdout: `Started updating ${id} (job ${job.id}). Follow it with "bb plugin update-jobs".`,
      };
    }
    const newer = report?.outOfRange.find((i) => i.id === id);
    return {
      exitCode: 1,
      stderr:
        newer === undefined
          ? `No update for ${id}. Run "bb plugin-updates check" first.`
          : `${id} ${newer.to} is outside its installed range, so updating reinstalls it ` +
            `(settings are restored; storage and schedules may reset). ` +
            `Compare: ${newer.compareUrl}\nRe-run with --out-of-range to go ahead.`,
    };
  }

  async function updateAll() {
    const { jobs } = await updates.updateAllCompatible();
    return {
      exitCode: 0,
      stdout:
        jobs.length === 0
          ? "No compatible updates."
          : jobs.map((job) => `Started updating ${job.pluginId} (job ${job.id}).`).join("\n"),
    };
  }

  async function ignore(id: string) {
    const report = (await updates.currentReport())?.report;
    const pending = [...(report?.compatible ?? []), ...(report?.outOfRange ?? [])].filter(
      (i) => i.id === id,
    );
    if (pending.length === 0) return { exitCode: 1, stderr: `No pending update for ${id}.` };
    for (const { version } of pending) await updates.setIgnored(id, version, true);
    const shown = pending.map((i) => ("newSource" in i ? i.to : i.version)).join(", ");
    return { exitCode: 0, stdout: `Ignoring ${id} ${shown}.` };
  }

  bb.cli.register({
    name: "plugin-updates",
    summary: "List and apply plugin updates, including releases outside a plugin's range",
    commands: [
      { name: "list", summary: "Show the last check's updates", usage: "bb plugin-updates list [--json]" },
      {
        name: "check",
        summary: "Check for updates now; --reannounce toasts already-announced ones again",
        usage: "bb plugin-updates check [--json] [--reannounce]",
      },
      {
        name: "update",
        summary: "Update a plugin; --out-of-range moves it past its range",
        usage: "bb plugin-updates update <id> [--out-of-range] | update --all",
      },
      {
        name: "ignore",
        summary: "Hide a plugin's pending versions until a newer one appears",
        usage: "bb plugin-updates ignore <id>",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => !arg.startsWith("--"));
      const show = (current: ReportSnapshot) => ({
        exitCode: 0,
        stdout: json
          ? JSON.stringify(current)
          : current === null
            ? 'Not checked yet. Run "bb plugin-updates check".'
            : formatReport(current.report, current.checkedAt),
      });
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "list":
          return show(await updates.currentReport());
        case "check":
          if (argv.includes("--reannounce")) await updates.forgetAnnounced();
          return show(await updates.check());
        case "update":
          if (argv.includes("--all") && args.length === 0) return updateAll();
          if (args.length !== 1) break;
          return update(args[0]!, argv.includes("--out-of-range"));
        case "ignore":
          if (args.length !== 1) break;
          return ignore(args[0]!);
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
