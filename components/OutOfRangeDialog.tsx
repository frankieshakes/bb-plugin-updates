import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { OutOfRangeResult, rpcContract } from "../server";
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
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OutOfRangeResult | null>(null);
  useEffect(() => {
    setResult(null);
    setRunning(false);
  }, [item]);
  if (item === null) return null;

  const run = async () => {
    setRunning(true);
    try {
      const outcome = await rpc.call("update_out_of_range", { id: item.id });
      if (outcome.kind === "updated") {
        toast.success(`Updated ${item.id} to ${outcome.to}`);
        onDone();
        onClose();
        return;
      }
      if (outcome.kind === "rolled-back") {
        toast.error(`Couldn't update ${item.id}; it's back on ${item.from}. ${outcome.error}`);
        onDone();
        onClose();
        return;
      }
      setResult(outcome);
      onDone();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open || running ? undefined : onClose())}>
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
          <Button variant="outline" onClick={onClose} disabled={running}>
            {result === null ? "Cancel" : "Close"}
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
