import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import { errorText, type Snapshot } from "@/lib/updates";

/** The last check's report, refetched whenever the server says it changed. */
export function useUpdates() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(undefined);
  const refetch = useCallback(() => {
    rpc.call("report").then(setSnapshot, (cause) => toast.error(errorText(cause)));
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("report-changed", refetch);
  // Signals aren't replayed after a reconnect; reconcile instead.
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (wasConnected.current) refetch();
    wasConnected.current = true;
  }, [connection, refetch]);
  return { rpc, snapshot, setSnapshot, refetch };
}
