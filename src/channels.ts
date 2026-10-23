// Realtime channel names, shared by server and frontend (no runtime deps).

/** The app toasts from this; payload `{ updates: [{ id, version }] }`. */
export const NEW_UPDATES = "new-updates";
/** Every page and the rail badge refetch on this; payload `{ badgeCount }`. */
export const REPORT_CHANGED = "report-changed";
