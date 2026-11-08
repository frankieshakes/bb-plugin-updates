import type { CheckFailure } from "../src/store";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/updates";

/** The latest check failed: says when and why, and that the lists are from `checkedAt`. */
export function CheckFailedNotice({
  failure,
  checkedAt,
  retrying,
  onRetry,
}: {
  failure: CheckFailure;
  checkedAt: number;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2.5 text-sm"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="font-medium">Last check failed {relativeTime(failure.at)}.</div>
        <div className="line-clamp-3 break-words text-xs text-muted-foreground" title={failure.error}>
          {failure.error}
        </div>
        <div className="text-xs text-muted-foreground">
          Showing results from the check {relativeTime(checkedAt)}.
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={onRetry} disabled={retrying}>
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
