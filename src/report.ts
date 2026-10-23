// Folds bb's update check and our release check into the page sections, the
// badge count, and the updates worth a toast. Pure — the caller supplies the
// ignored and already-announced versions from storage.
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type { NewerRelease } from "./releases";

export type CheckEntry = Awaited<
  ReturnType<PluginBbSdk["plugins"]["checkUpdates"]>
>[number];

export type ReleaseResult = NewerRelease | { kind: "failed"; error: string };

export interface CompatibleItem {
  id: string;
  from: string;
  to: string;
  version: string;
}

export interface OutOfRangeItem {
  id: string;
  from: string;
  to: string;
  version: string;
  newSource: string;
  compareUrl: string;
}

export type IgnoredItem =
  | (CompatibleItem & { kind: "compatible" })
  | (OutOfRangeItem & { kind: "out-of-range" });

export interface BlockedItem {
  id: string;
  version: string;
  reasons: string[];
}

export interface IdleItem {
  id: string;
  installed: string;
}

export type OtherItem = IdleItem & {
  outcome: Exclude<CheckEntry["outcome"], "current">;
  detail?: string;
};

export interface Report {
  compatible: CompatibleItem[];
  outOfRange: OutOfRangeItem[];
  blocked: BlockedItem[];
  ignored: IgnoredItem[];
  upToDate: IdleItem[];
  other: OtherItem[];
  releaseCheckFailures: Array<{ id: string; error: string }>;
  badgeCount: number;
  newlySeen: Array<{ id: string; version: string }>;
}

export function buildReport(input: {
  checks: CheckEntry[];
  releases: Record<string, ReleaseResult>;
  ignored: Record<string, string[]>;
  seen: Record<string, string[]>;
}): Report {
  const isIgnored = (id: string, version: string) =>
    (input.ignored[id] ?? []).includes(version);

  const compatible: CompatibleItem[] = [];
  const outOfRange: OutOfRangeItem[] = [];
  const blocked: BlockedItem[] = [];
  const ignored: IgnoredItem[] = [];
  const upToDate: IdleItem[] = [];
  const other: OtherItem[] = [];
  const releaseCheckFailures: Array<{ id: string; error: string }> = [];
  for (const entry of input.checks) {
    const updatesBefore = compatible.length + outOfRange.length + ignored.length;
    if (entry.blocked !== undefined) blocked.push({ id: entry.id, ...entry.blocked });
    if (entry.outcome === "update-available" && entry.candidate !== undefined) {
      const item = {
        id: entry.id,
        from: entry.installed.display,
        to: entry.candidate.display,
        version: entry.candidate.version,
      };
      if (isIgnored(item.id, item.version)) ignored.push({ ...item, kind: "compatible" });
      else compatible.push(item);
    }
    const release = input.releases[entry.id];
    if (release?.kind === "failed") {
      releaseCheckFailures.push({ id: entry.id, error: release.error });
    }
    if (release?.kind === "out-of-range") {
      const { kind: _, ...rest } = release;
      const item = { id: entry.id, ...rest, version: release.to };
      if (isIgnored(item.id, item.version)) ignored.push({ ...item, kind: "out-of-range" });
      else outOfRange.push(item);
    }
    if (compatible.length + outOfRange.length + ignored.length > updatesBefore) continue;
    const idle = { id: entry.id, installed: entry.installed.display };
    if (entry.outcome === "current") upToDate.push(idle);
    else {
      other.push({
        ...idle,
        outcome: entry.outcome,
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      });
    }
  }
  const actionable = [...compatible, ...outOfRange];
  return {
    compatible,
    outOfRange,
    blocked,
    ignored,
    upToDate,
    other,
    releaseCheckFailures,
    badgeCount: new Set(actionable.map(({ id }) => id)).size,
    newlySeen: actionable
      .filter(({ id, version }) => !(input.seen[id] ?? []).includes(version))
      .map(({ id, version }) => ({ id, version })),
  };
}
