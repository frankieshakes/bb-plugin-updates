import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { OutOfRangeItem } from "../src/report";
import { OutOfRangeDialog } from "@/components/OutOfRangeDialog";
import { CollapsedLists } from "@/components/sections/CollapsedLists";
import { CompatibleSection } from "@/components/sections/CompatibleSection";
import { NoticeSections } from "@/components/sections/NoticeSections";
import { OutOfRangeSection } from "@/components/sections/OutOfRangeSection";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useUpdateJobs } from "@/hooks/useUpdateJobs";
import { useUpdates } from "@/hooks/useUpdates";
import { errorText, relativeTime, type Snapshot } from "@/lib/updates";
import { cn } from "@/lib/utils";

export function UpdatesPage() {
  const { rpc, snapshot, setSnapshot } = useUpdates();
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState<OutOfRangeItem | null>(null);

  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      setSnapshot(await rpc.call("check"));
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setChecking(false);
    }
  }, [rpc, setSnapshot]);
  const jobs = useUpdateJobs(checkNow);

  const fail = (cause: unknown) => toast.error(errorText(cause));
  const call = (promise: Promise<Snapshot>) => promise.then(setSnapshot, fail);
  const ignore = (id: string, version: string) => call(rpc.call("ignore", { id, version }));
  const unignore = (id: string, version: string) => call(rpc.call("unignore", { id, version }));
  const update = (id: string) => rpc.call("update", { id }).then(({ job }) => jobs.track([job]), fail);
  const updateAll = () =>
    rpc.call("update_all").then(({ jobs: started }) => jobs.track(started), fail);

  const report = snapshot?.report;
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-6 px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>
            {snapshot === undefined
              ? "Loading…"
              : snapshot === null
                ? "Not checked yet."
                : `Last checked ${relativeTime(snapshot.checkedAt)}.`}
          </span>
          <Button variant="outline" size="sm" onClick={checkNow} disabled={checking}>
            <Icon name="RotateCcw" className={cn("size-4", checking && "animate-spin")} />
            {checking ? "Checking…" : "Check now"}
          </Button>
        </div>

        {report === undefined ? null : (
          <>
            {report.compatible.length + report.outOfRange.length === 0 ? (
              <div
                role="status"
                className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
              >
                Every plugin is up to date.
              </div>
            ) : null}
            <CompatibleSection
              items={report.compatible}
              isUpdating={jobs.activeFor}
              onUpdate={update}
              onUpdateAll={updateAll}
              onIgnore={ignore}
            />
            <OutOfRangeSection items={report.outOfRange} onUpdate={setConfirming} onIgnore={ignore} />
            <NoticeSections report={report} />
            <CollapsedLists report={report} onUnignore={unignore} />
          </>
        )}
      </div>
      <OutOfRangeDialog item={confirming} onClose={() => setConfirming(null)} onDone={checkNow} />
    </div>
  );
}
