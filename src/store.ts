// What the plugin keeps in bb.storage.kv.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CheckEntry, ReleaseResult } from "./report";

/** The last check's raw results; the report is rebuilt from it on demand. */
export interface LastCheck {
  checks: CheckEntry[];
  releases: Record<string, ReleaseResult>;
  checkedAt: number;
}

export type VersionsById = Record<string, string[]>;

export function createStore(kv: BbPluginApi["storage"]["kv"]) {
  const versions = async (key: string) => (await kv.get<VersionsById>(key)) ?? {};
  return {
    lastCheck: async () => (await kv.get<LastCheck>("lastCheck")) ?? null,
    saveLastCheck: (last: LastCheck) => kv.set("lastCheck", last),
    /** Versions the user chose to hide. */
    ignored: () => versions("ignored"),
    saveIgnored: (ignored: VersionsById) => kv.set("ignored", ignored),
    /** Versions already announced with a toast. */
    seen: () => versions("seen"),
    saveSeen: (seen: VersionsById) => kv.set("seen", seen),
    forgetSeen: () => kv.delete("seen"),
  };
}

export type Store = ReturnType<typeof createStore>;
