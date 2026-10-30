import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { DEFERRED_UPDATE } from "../src/channels";
import type { UpdateJob, rpcContract } from "../src/contract";
import { toastJobEnd } from "@/lib/toasts";

const isActive = (job: UpdateJob) => job.state === "queued" || job.state === "running";

/** bb's background update jobs: polled while any is active, re-check when one ends. */
export function useUpdateJobs(onSettled: () => void) {
  const rpc = useRpc<typeof rpcContract>();
  const [jobs, setJobs] = useState<UpdateJob[]>([]);
  const poll = useCallback(async () => {
    const { jobs: next } = await rpc.call("jobs");
    setJobs((previous) => {
      for (const job of next) {
        const before = previous.find((p) => p.id === job.id);
        if (before === undefined || !isActive(before) || isActive(job)) continue;
        toastJobEnd(job);
        onSettled();
      }
      return next;
    });
  }, [rpc, onSettled]);
  // Reconcile on load: jobs outlive the page (not a server restart).
  useEffect(() => {
    poll().catch(() => undefined);
  }, [poll]);
  // A deferred update's job is started by the server; fetching it starts the polling.
  useRealtime(DEFERRED_UPDATE, () => {
    poll().catch(() => undefined);
  });
  const anyActive = jobs.some(isActive);
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => poll().catch(() => undefined), 1500);
    return () => clearInterval(timer);
  }, [anyActive, poll]);
  const track = (started: UpdateJob[]) =>
    setJobs((previous) => [...previous.filter((p) => !started.some((s) => s.id === p.id)), ...started]);
  const activeFor = (id: string) => jobs.some((job) => job.pluginId === id && isActive(job));
  return { track, activeFor };
}
