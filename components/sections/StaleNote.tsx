import type { Stale } from "../../src/report";
import { relativeTime } from "@/lib/updates";

/** An update found by an earlier check: this plugin's latest check failed. A row's `note`, so it isn't truncated. */
export function StaleNote({ stale }: { stale: Stale }) {
  return (
    <span title={new Date(stale.confirmedAt).toLocaleString()}>
      Stale: last confirmed {relativeTime(stale.confirmedAt)}
    </span>
  );
}
