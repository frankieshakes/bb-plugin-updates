// Toasts more than one component raises.
import { toast } from "sonner";
import type { UpdateJob } from "../src/contract";

/** Options for a toast that stays until dismissed, with a Copy action for `command`. */
export const sticky = (id: string, command: string) => ({
  id,
  duration: Infinity,
  action: {
    label: "Copy",
    onClick: () => navigator.clipboard.writeText(command).catch(() => undefined),
  },
});

/** One per plugin: its out-of-range update's progress, then outcome. */
export const outOfRangeToastId = (id: string) => `out-of-range-${id}`;

export const toastManual = (id: string, command: string) =>
  toast.warning(
    `${id} needs a manual update. Run: ${command}`,
    sticky(outOfRangeToastId(id), command),
  );

/** Keyed by job, so the page and the overlay seeing the same job end toast once. */
export function toastJobEnd(job: UpdateJob) {
  const options = { id: `update-job-${job.id}` };
  if (job.state === "completed") {
    if (job.result.outcome === "rolled-back") {
      toast.error(`${job.pluginId} update rolled back. ${job.result.detail ?? ""}`, options);
    } else toast.success(`Updated ${job.pluginId}`, options);
  } else if (job.state === "failed") toast.error(`${job.pluginId}: ${job.error}`, options);
}
