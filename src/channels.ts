// Realtime channel names, shared by server and frontend (no runtime deps).

/** The app toasts from this; payload `{ updates: [{ id, version }] }`. */
export const NEW_UPDATES = "new-updates";
/** Every page and the rail badge refetch on this; payload `{ badgeCount }`. */
export const REPORT_CHANGED = "report-changed";
/** Out-of-range queue views refetch on this; payload `{ id, state }`. */
export const OUT_OF_RANGE_CHANGED = "out-of-range-changed";
/** A deferred compatible update started or was skipped; payload DeferredUpdate. */
export const DEFERRED_UPDATE = "deferred-update";
