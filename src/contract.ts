// The RPC contract between server.ts and the frontend, plus the result types
// both sides share. Imported as types by the frontend.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Report } from "./report";

export type UpdateJob = Awaited<
  ReturnType<BbPluginApi["sdk"]["plugins"]["experimental_startUpdate"]>
>;

export type OutOfRangeResult =
  | { kind: "updated"; from: string; to: string }
  | { kind: "rolled-back"; error: string }
  | { kind: "failed"; error: string; command: string }
  | ManualSteps;

/** Returned up front, instead of queueing, when a reinstall isn't safe. */
export type ManualSteps = { kind: "manual"; reason: "secret-settings" | "self"; command: string };

/**
 * One queued out-of-range update; `run` tells apart repeat updates of one
 * plugin. `waiting` means it's next, but waits for the plugin's bb update job.
 */
export type OutOfRangeEntry = {
  run: number;
  id: string;
  /** Re-read once it runs, in case a bb update job moved the plugin meanwhile. */
  from: string;
  to: string;
  state: "queued" | "waiting" | "running" | "done";
  /**
   * Set once done; `error` means it threw partway, so check the plugin by hand.
   * `timed-out`: the bb job it waited on never ended, so it gave up untouched.
   */
  result?: OutOfRangeResult | { kind: "error"; error: string } | { kind: "timed-out" };
};

export type OutOfRangeRequest = ManualSteps | { kind: "entry"; entry: OutOfRangeEntry };

/**
 * A compatible update starts now, or, while the plugin has an out-of-range
 * update queued or running, once that's done (see DeferredUpdate).
 */
export type UpdateRequest = { kind: "job"; job: UpdateJob } | { kind: "deferred"; id: string };

/**
 * How a deferred compatible update went; `skipped`: no compatible update left.
 * `ended`: the job it started finished (completed or failed), and was re-checked.
 */
export type DeferredUpdate = { id: string } & (
  | { outcome: "started"; jobId: string }
  | { outcome: "skipped" }
  | { outcome: "failed"; error: string }
  | { outcome: "ended"; job: UpdateJob }
);

/** The last check's report; null before the first check. */
export type ReportSnapshot = { report: Report; checkedAt: number } | null;

const versionRef = z.object({ id: z.string().min(1), version: z.string().min(1) });
const pluginRef = z.object({ id: z.string().min(1) });
const reportOutput = z.custom<ReportSnapshot>();
const jobsOutput = z.object({ jobs: z.array(z.custom<UpdateJob>()) });
const queueOutput = z.object({ entries: z.array(z.custom<OutOfRangeEntry>()) });
const updateAllOutput = jobsOutput.extend({ deferred: z.array(z.string()) });

export const rpcContract = defineRpcContract({
  check: { input: z.null(), output: reportOutput },
  report: { input: z.null(), output: reportOutput },
  ignore: { input: versionRef, output: reportOutput },
  unignore: { input: versionRef, output: reportOutput },
  update: { input: pluginRef, output: z.custom<UpdateRequest>() },
  update_all: { input: z.null(), output: updateAllOutput },
  jobs: { input: z.null(), output: jobsOutput },
  update_out_of_range: { input: pluginRef, output: z.custom<OutOfRangeRequest>() },
  out_of_range_queue: { input: z.null(), output: queueOutput },
});
