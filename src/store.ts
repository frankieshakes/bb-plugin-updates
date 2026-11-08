// What the plugin keeps in bb.storage.kv.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CarriedCheck, CheckEntry, ReleaseResult } from "./report";

/** The last check's raw results; the report is rebuilt from it on demand. */
export interface LastCheck {
  checks: CheckEntry[];
  releases: Record<string, ReleaseResult>;
  checkedAt: number;
  /** Plugins bb couldn't check (see `check()`); absent when none. */
  updateCheckFailures?: StoredCheckFailure[];
}

export type PluginCheckFailure = { id: string; error: string };

/** `carried`: the compatible update an earlier check found, kept while this fails. */
export type StoredCheckFailure = PluginCheckFailure & { carried?: CarriedCheck };

/**
 * The latest check that failed outright; cleared by the next one that works.
 * `failures`: it failed because every plugin's own check did; absent otherwise.
 */
export interface CheckFailure {
  at: number;
  error: string;
  failures?: PluginCheckFailure[];
}

/**
 * bb refused to install `version` for its engines (`reason`, bb's words)
 * while `from` was installed on bb `bbVersion` (absent if it couldn't be read).
 */
export interface Refusal {
  version: string;
  reason: string;
  from: string;
  bbVersion?: string;
}

export type VersionsById = Record<string, string[]>;

export function createStore(kv: BbPluginApi["storage"]["kv"]) {
  const versions = async (key: string) => (await kv.get<VersionsById>(key)) ?? {};
  return {
    lastCheck: async () => (await kv.get<LastCheck>("lastCheck")) ?? null,
    saveLastCheck: (last: LastCheck) => kv.set("lastCheck", last),
    lastFailure: async () => (await kv.get<CheckFailure>("lastFailure")) ?? null,
    saveLastFailure: (failure: CheckFailure) => kv.set("lastFailure", failure),
    clearLastFailure: () => kv.delete("lastFailure"),
    /** Versions the user chose to hide. */
    ignored: () => versions("ignored"),
    saveIgnored: (ignored: VersionsById) => kv.set("ignored", ignored),
    /** Versions already announced with a toast. */
    seen: () => versions("seen"),
    saveSeen: (seen: VersionsById) => kv.set("seen", seen),
    forgetSeen: () => kv.delete("seen"),
    /** Releases bb refused on apply, by plugin id. */
    refusals: async () => (await kv.get<Record<string, Refusal>>("refusals")) ?? {},
    saveRefusals: (refusals: Record<string, Refusal>) => kv.set("refusals", refusals),
  };
}

export type Store = ReturnType<typeof createStore>;
