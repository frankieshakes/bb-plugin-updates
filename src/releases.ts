// Finds releases bb's own update check can't offer: semver tags beyond the
// installed range, or newer than a pinned ref. Pure — the caller runs
// `git ls-remote --tags` and passes its output in.
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

export type NewerRelease =
  | { kind: "none" }
  | {
      kind: "out-of-range";
      from: string;
      to: string;
      newSource: string;
      compareUrl: string;
    };

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
 * already follows.
 */
function parseGitSource(
  requested: string,
): { url: string; ref: string | undefined; pin: Pin | null } | null {
  const match = GIT_SOURCE.exec(requested);
  if (match === null) return null;
  const [, url, semverMarker, ref] = match;
  const pin: Pin | null =
    semverMarker !== undefined
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

export function releaseCheckTarget(source: Pick<SourceInfo, "requested">): CheckTarget {
  const { requested } = source;
  if (requested.startsWith("builtin:")) return { kind: "skip", reason: "builtin" };
  if (requested.startsWith("npm:")) return { kind: "skip", reason: "npm" };
  const git = parseGitSource(requested);
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

export function resolveNewerRelease(args: {
  source: SourceInfo;
  installedVersion: string;
  lsRemote: string;
}): NewerRelease {
  const { source, installedVersion } = args;
  const git = parseGitSource(source.requested);
  if (git === null || git.pin === null) return { kind: "none" };
  const { url, ref, pin } = git;
  const range = pin === "range" ? source.range : undefined;
  const prefix = source.tagPrefix ?? "";

  const newest = parseTags(args.lsRemote, prefix)
    .filter((tag) => semver.gt(tag.version, installedVersion))
    .filter((tag) => range === undefined || !semver.satisfies(tag.version, range))
    .sort((a, b) => semver.rcompare(a.version, b.version))[0];
  if (newest === undefined) return { kind: "none" };

  const newSource =
    pin === "range"
      ? `git:${url}@semver:${prefix === "" ? "" : `${prefix}:`}^${newest.version}`
      : `git:${url}@${pin === "commit" ? newest.commit : newest.name}`;
  const fromRef =
    pin === "range" ? (source.resolvedTag ?? `${prefix}v${installedVersion}`) : ref;
  return {
    kind: "out-of-range",
    from: installedVersion,
    to: newest.version,
    newSource,
    compareUrl: `${url.replace(/\.git$/, "")}/compare/${fromRef}...${newest.name}`,
  };
}
