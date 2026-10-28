import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { OutOfRangeResult, rpcContract } from "../src/contract";
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

/** Out-of-range updates reinstall the plugin, so they're confirmed one by one. */
export function OutOfRangeDialog({
  item,
  onClose,
  onDone,
}: {
  item: OutOfRangeItem | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  // Runs outlive the dialog: closing it mid-install leaves the update going.
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<OutOfRangeResult | null>(null);
  const shownId = useRef<string | null>(null);
  shownId.current = item?.id ?? null;
  useEffect(() => {
    setResult(null);
  }, [item]);
  if (item === null) return null;
  const running = runningIds.has(item.id);

  const run = async () => {
    const { id, from, to } = item;
    const toastId = `out-of-range-${id}`;
    setRunningIds((previous) => new Set(previous).add(id));
    toast.loading(`Updating ${id} to ${to}…`, { id: toastId });
    try {
      const outcome = await rpc.call("update_out_of_range", { id });
      // The dialog may have closed or moved to another plugin meanwhile.
      const shown = shownId.current === id;
      onDone();
      if (outcome.kind === "updated") {
        toast.success(`Updated ${id} to ${outcome.to}`, { id: toastId });
        if (shown) onClose();
      } else if (outcome.kind === "rolled-back") {
        toast.error(`Couldn't update ${id}; it's back on ${from}. ${outcome.error}`, { id: toastId });
        if (shown) onClose();
      } else if (shown) {
        toast.dismiss(toastId);
        setResult(outcome);
      } else {
        const message =
          outcome.kind === "manual"
            ? `${id} needs a manual update. Run: ${outcome.command}`
            : `Updating ${id} and the rollback both failed, so it isn't installed. ${outcome.error} Reinstall with: ${outcome.command}`;
        (outcome.kind === "manual" ? toast.warning : toast.error)(message, {
          id: toastId,
          duration: Infinity,
          action: {
            label: "Copy",
            onClick: () => navigator.clipboard.writeText(outcome.command).catch(() => undefined),
          },
        });
      }
    } catch (cause) {
      toast.error(errorText(cause), { id: toastId });
    } finally {
      setRunningIds((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
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
        {result?.kind === "manual" ? (
          <div className="space-y-2 text-sm">
            <p>
              {result.reason === "self"
                ? "This plugin can't remove itself. Run this in a terminal instead:"
                : `${item.id} has secret settings a reinstall would lose. Run this in a terminal, then re-enter them:`}
            </p>
            <CopyableCommand command={result.command} />
          </div>
        ) : null}
        {result?.kind === "failed" ? (
          <div className="space-y-2 text-sm">
            <p className="text-destructive">
              The update and the rollback both failed, so {item.id} isn't installed. {result.error}
            </p>
            <p>Reinstall it with:</p>
            <CopyableCommand command={result.command} />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {result === null && !running ? "Cancel" : "Close"}
          </Button>
          {result === null ? (
            <Button onClick={run} disabled={running}>
              {running ? "Updating…" : `Update to ${item.to}`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
