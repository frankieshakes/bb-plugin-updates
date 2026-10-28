import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { OUT_OF_RANGE_CHANGED } from "../src/channels";
import type { OutOfRangeEntry, rpcContract } from "../src/contract";

/**
 * The server's out-of-range update queue, refetched whenever an entry moves.
 * `onChange` gets each entry this window saw arrive or change state; entries
 * already done on first load aren't reported.
 */
export function useOutOfRangeQueue(onChange?: (entry: OutOfRangeEntry) => void) {
  const rpc = useRpc<typeof rpcContract>();
  const [entries, setEntries] = useState<OutOfRangeEntry[]>([]);
  const seen = useRef(new Map<number, OutOfRangeEntry["state"]>());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Fetches can overlap; a slower, older answer must not roll state back.
  const requested = useRef(0);
  const applied = useRef(0);
  const refetch = useCallback(() => {
    const ticket = ++requested.current;
    rpc.call("out_of_range_queue").then(
      ({ entries: next }) => {
        if (ticket < applied.current) return;
        applied.current = ticket;
        for (const entry of next) {
          const before = seen.current.get(entry.run);
          seen.current.set(entry.run, entry.state);
          if (before === entry.state || (before === undefined && entry.state === "done")) continue;
          onChangeRef.current?.(entry);
        }
        setEntries(next);
      },
      () => undefined,
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(OUT_OF_RANGE_CHANGED, refetch);
  // Signals aren't replayed after a reconnect; reconcile instead.
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (wasConnected.current) refetch();
    wasConnected.current = true;
  }, [connection, refetch]);

  const enqueue = async (id: string) => {
    const request = await rpc.call("update_out_of_range", { id });
    refetch();
    return request;
  };
  /** The plugin's queued or running update, if any. */
  const stateFor = (id: string) => {
    const state = entries.find((entry) => entry.id === id && entry.state !== "done")?.state;
    return state === "done" ? undefined : state;
  };
  return { entries, enqueue, stateFor };
}
