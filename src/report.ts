// Folds bb's update check and our release check into the page sections, the
// badge count, and the updates worth a toast. Pure — the caller supplies the
// ignored and already-announced versions from storage.
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type { BlockedRelease, NewerRelease, OutOfRangeRelease } from "./releases";

export type CheckEntry = Awaited<
  ReturnType<PluginBbSdk["plugins"]["checkUpdates"]>
>[number];

/** An update found by an earlier check, kept while this plugin's check fails. */
export interface Stale {
  /** When a check last found it. */
  confirmedAt: number;
}

/** A release result an earlier check found; see `ReleaseResult`. */
export type CarriedRelease = { release: OutOfRangeRelease & { blocked?: BlockedRelease } } & Stale;

/** A compatible update an earlier check found, for a plugin bb couldn't check this time. */
export type CarriedCheck = { entry: CheckEntry } & Stale;

/** `carried`: the release check failed, so the last one found is kept, stale. */
export type ReleaseResult = NewerRelease | { kind: "failed"; error: string; carried?: CarriedRelease };

export interface CompatibleItem {
  id: string;
  /** The plugin is turned off: shown, but not counted, announced, or in Update all. */
  disabled?: true;
  /** Found by an earlier check: this plugin's latest check failed. Still counted. */
  stale?: Stale;
  from: string;
  to: string;
  version: string;
}

export interface OutOfRangeItem {
  id: string;
  disabled?: true;
  stale?: Stale;
  from: string;
  to: string;
  version: string;
  /** The release's tag; missing from checks saved by older versions of this plugin. */
  tag?: string;
  newSource: string;
  compareUrl: string;
}

export type IgnoredItem =
  | (CompatibleItem & { kind: "compatible" })
  | (OutOfRangeItem & { kind: "out-of-range" });

/** A newer release this bb can't run: bb's own candidate, or one outside the range. */
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
  /** Ids of installed plugins that are turned off. */
  disabled?: string[];
  /** Ids bb couldn't check, so not in `checks`; their release results still count. */
  unchecked?: string[];
  /** Compatible updates of `unchecked` plugins, found by an earlier check. */
  carried?: CarriedCheck[];
}): Report {
  const isIgnored = (id: string, version: string) =>
    (input.ignored[id] ?? []).includes(version);
  const off = new Set(input.disabled ?? []);
  const flag = (id: string) => (off.has(id) ? { disabled: true as const } : {});

  const compatible: CompatibleItem[] = [];
  const outOfRange: OutOfRangeItem[] = [];
  const blocked: BlockedItem[] = [];
  const ignored: IgnoredItem[] = [];
  const upToDate: IdleItem[] = [];
  const other: OtherItem[] = [];
  const releaseCheckFailures: Array<{ id: string; error: string }> = [];
  // A release result carries its own `from` (the installed version), so it
  // needs no update check entry.
  const addRelease = (id: string) => {
    const release = input.releases[id];
    if (release?.kind === "failed") {
      releaseCheckFailures.push({ id, error: release.error });
      if (release.carried !== undefined) {
        const { release: carried, confirmedAt } = release.carried;
        addOutOfRange(id, carried, { stale: { confirmedAt } });
      }
    }
    if (release?.kind === "blocked") {
      blocked.push({ id, version: release.version, reasons: release.reasons });
    }
    if (release?.kind === "out-of-range") addOutOfRange(id, release, {});
  };
  function addOutOfRange(
    id: string,
    release: OutOfRangeRelease & { blocked?: BlockedRelease },
    extra: { stale?: Stale },
  ) {
    const { kind: _, blocked: newerBlocked, ...rest } = release;
    if (newerBlocked !== undefined) blocked.push({ id, ...newerBlocked });
    const item = { id, ...rest, version: release.to, ...flag(id), ...extra };
    if (isIgnored(item.id, item.version)) ignored.push({ ...item, kind: "out-of-range" });
    else outOfRange.push(item);
  }
  const addCompatible = (entry: CheckEntry, extra: { stale?: Stale }) => {
    if (entry.outcome !== "update-available" || entry.candidate === undefined) return;
    const item = {
      id: entry.id,
      from: entry.installed.display,
      to: entry.candidate.display,
      version: entry.candidate.version,
      ...flag(entry.id),
      ...extra,
    };
    if (isIgnored(item.id, item.version)) ignored.push({ ...item, kind: "compatible" });
    else compatible.push(item);
  };
  for (const entry of input.checks) {
    const updatesBefore = compatible.length + outOfRange.length + ignored.length;
    if (entry.blocked !== undefined) blocked.push({ id: entry.id, ...entry.blocked });
    addCompatible(entry, {});
    addRelease(entry.id);
    if (compatible.length + outOfRange.length + ignored.length > updatesBefore) continue;
    // Listed once, as a failure: a failed release check can't say it's up to date.
    if (input.releases[entry.id]?.kind === "failed") continue;
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
  // Not idle either way: bb couldn't say whether they're up to date.
  const carried = new Map((input.carried ?? []).map((c) => [c.entry.id, c]));
  for (const id of input.unchecked ?? []) {
    const last = carried.get(id);
    if (last !== undefined) addCompatible(last.entry, { stale: { confirmedAt: last.confirmedAt } });
    addRelease(id);
  }
  const actionable = [...compatible, ...outOfRange].filter(({ id }) => !off.has(id));
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
