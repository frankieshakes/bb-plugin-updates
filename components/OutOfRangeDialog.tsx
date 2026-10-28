import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { ManualSteps, OutOfRangeEntry, OutOfRangeRequest } from "../src/contract";
import type { OutOfRangeItem } from "../src/report";
import { CopyableCommand } from "@/components/CopyableCommand";
import { ExternalLink } from "@/components/ExternalLink";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorText } from "@/lib/updates";

/**
 * Out-of-range updates reinstall the plugin, so they're confirmed one by one.
 * Confirming queues the update on the server and closes; the overlay's toasts
 * follow it from there. Manual steps show here, since nothing gets queued.
 */
export function OutOfRangeDialog({
  item,
  state,
  onEnqueue,
  onClose,
}: {
  item: OutOfRangeItem | null;
  /** The plugin's queued or running update, if any. */
  state: Exclude<OutOfRangeEntry["state"], "done"> | undefined;
  onEnqueue: (id: string) => Promise<OutOfRangeRequest>;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ManualSteps | null>(null);
  useEffect(() => {
    setResult(null);
  }, [item]);
  if (item === null) return null;
  const pending = submitting || state !== undefined;

  const confirm = async () => {
    setSubmitting(true);
    try {
      const request = await onEnqueue(item.id);
      if (request.kind === "manual") setResult(request);
      else onClose();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Update {item.id} {item.from} → {item.to}?
          </DialogTitle>
          <DialogDescription>
            {item.to} is outside the range {item.id} was installed with, so bb can't update it in
            place. This removes the plugin and installs the new release. Settings are restored;
            its storage and schedules may reset. If the install fails, the old version is
            reinstalled.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          <ExternalLink href={item.compareUrl}>See what changed</ExternalLink>
        </p>
        {result !== null ? (
          <div className="space-y-2 text-sm">
            <p>
              {result.reason === "self"
                ? "This plugin can't remove itself. Run this in a terminal instead:"
                : `${item.id} has secret settings a reinstall would lose. Run this in a terminal, then re-enter them:`}
            </p>
            <CopyableCommand command={result.command} />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {result === null && state === undefined ? "Cancel" : "Close"}
          </Button>
          {result === null ? (
            <Button onClick={confirm} disabled={pending}>
              {state === "queued"
                ? "Queued"
                : state === "running"
                  ? "Updating…"
                  : `Update to ${item.to}`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
