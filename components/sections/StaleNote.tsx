import type { Stale } from "../../src/report";
import { relativeTime } from "@/lib/updates";

/** An update found by an earlier check: this plugin's latest check failed. */
export function StaleNote({ item }: { item: { stale?: Stale } }) {
  if (item.stale === undefined) return null;
  return (
    <>
      {" · "}
      <span title={new Date(item.stale.confirmedAt).toLocaleString()}>
        Stale: last confirmed {relativeTime(item.stale.confirmedAt)}
      </span>
    </>
  );
}
