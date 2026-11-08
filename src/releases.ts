// Finds releases bb's own update check can't offer: semver tags beyond the
// installed range, or newer than a pinned ref. Pure — the caller runs
// `git ls-remote --tags` and passes its output in, and judges each release's
// engines for selectRunnableRelease.
import semver from "semver";

export interface SourceInfo {
  requested: string;
  range?: string;
  resolvedTag?: string;
  tagPrefix?: string;
  subdirectory?: string;
}

export type CheckTarget =
  | { kind: "git"; url: string }
  | { kind: "skip"; reason: "builtin" | "npm" | "local" | "branch" };

export interface OutOfRangeRelease {
  kind: "out-of-range";
  from: string;
  to: string;
  /** The release's tag, prefix included. */
  tag: string;
  newSource: string;
  compareUrl: string;
}

/** A newer release this bb can't run, and why (bb's engine-range reasons). */
export interface BlockedRelease {
  version: string;
  reasons: string[];
}

export type NewerRelease =
  | { kind: "none" }
  | (OutOfRangeRelease & { blocked?: BlockedRelease })
  | ({ kind: "blocked" } & BlockedRelease);

interface Tag {
  name: string;
  version: string;
  commit: string;
}

type Pin = "range" | "commit" | "tag";

const GIT_SOURCE = /^git:(.+?)(?:@(semver:)?(.+))?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const TAG_REF = /(?:^|\/)v?\d+\.\d+\.\d+$/;

/**
 * The install's intent: a range stays a range, a commit pin stays a commit
 * pin, a tag pin stays a tag pin. Anything else tracks a branch, which bb
 * already follows. bb records a bare range (`@^1.2.0`) as typed, with `range`
 * set, so `range` marks one as surely as `semver:` does.
 */
function parseGitSource(
  requested: string,
  range: string | undefined,
): { url: string; ref: string | undefined; pin: Pin | null } | null {
  const match = GIT_SOURCE.exec(requested);
  if (match === null) return null;
  const [, url, semverMarker, ref] = match;
  const pin: Pin | null =
    semverMarker !== undefined || (ref !== undefined && range !== undefined)
      ? "range"
      : ref === undefined
        ? null
        : COMMIT.test(ref)
          ? "commit"
          : TAG_REF.test(ref)
            ? "tag"
            : null;
  return { url: url!, ref, pin };
}

export function releaseCheckTarget(source: Pick<SourceInfo, "requested" | "range">): CheckTarget {
  const { requested } = source;
  if (requested.startsWith("builtin:")) return { kind: "skip", reason: "builtin" };
  if (requested.startsWith("npm:")) return { kind: "skip", reason: "npm" };
  const git = parseGitSource(requested, source.range);
  if (git === null) return { kind: "skip", reason: "local" };
  if (git.pin === null) return { kind: "skip", reason: "branch" };
  return { kind: "git", url: git.url };
}

/** Stable semver tags under `prefix`; annotated tags resolve to their commit. */
function parseTags(lsRemote: string, prefix: string): Tag[] {
  const byName = new Map<string, Tag>();
  for (const line of lsRemote.split("\n")) {
    const [commit, ref] = line.split("\t");
    if (commit === undefined || ref === undefined) continue;
    const peeled = ref.endsWith("^{}");
    const name = ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
    if (!name.startsWith(prefix)) continue;
    const version = semver.valid(name.slice(prefix.length));
    if (version === null || semver.prerelease(version) !== null) continue;
    if (peeled || !byName.has(name)) byName.set(name, { name, version, commit });
  }
  return [...byName.values()];
}

/** Every release beyond the range or pin, newest first. */
export function newerReleases(args: {
  source: SourceInfo;
  installedVersion: string;
  lsRemote: string;
}): OutOfRangeRelease[] {
  const { source, installedVersion } = args;
  const git = parseGitSource(source.requested, source.range);
  if (git === null || git.pin === null) return [];
  const { url, ref, pin } = git;
  const range = pin === "range" ? source.range : undefined;
  const prefix = source.tagPrefix ?? "";
  const fromRef =
    pin === "range" ? (source.resolvedTag ?? `${prefix}v${installedVersion}`) : ref;

  return parseTags(args.lsRemote, prefix)
    .filter((tag) => semver.gt(tag.version, installedVersion))
    .filter((tag) => range === undefined || !semver.satisfies(tag.version, range))
    .sort((a, b) => semver.rcompare(a.version, b.version))
    .map((tag) => ({
      kind: "out-of-range",
      from: installedVersion,
      to: tag.version,
      tag: tag.name,
      newSource:
        pin === "range"
          ? `git:${url}@semver:${prefix === "" ? "" : `${prefix}:`}^${tag.version}`
          : `git:${url}@${pin === "commit" ? tag.commit : tag.name}`,
      compareUrl: `${url.replace(/\.git$/, "")}/compare/${fromRef}...${tag.name}`,
    }));
}

/** The newest release beyond the range or pin, engines aside. */
export function resolveNewerRelease(args: {
  source: SourceInfo;
  installedVersion: string;
  lsRemote: string;
}): NewerRelease {
  return newerReleases(args)[0] ?? { kind: "none" };
}

/** Manifests read per plugin and check, at most; each is a shallow fetch. */
export const MAX_ENGINE_PROBES = 5;

/**
 * The newest of `releases` (newest first) that this bb runs, judged by
 * `problems`, and the newest it can't, if newer. Reads only as many as it
 * needs, and at most MAX_ENGINE_PROBES; a read that throws fails the lot.
 */
export async function selectRunnableRelease(
  releases: OutOfRangeRelease[],
  problems: (release: OutOfRangeRelease) => Promise<string[]>,
): Promise<NewerRelease> {
  let blocked: BlockedRelease | undefined;
  for (const release of releases.slice(0, MAX_ENGINE_PROBES)) {
    const reasons = await problems(release);
    if (reasons.length === 0) return blocked === undefined ? release : { ...release, blocked };
    blocked ??= { version: release.to, reasons };
  }
  return blocked === undefined ? { kind: "none" } : { kind: "blocked", ...blocked };
}
