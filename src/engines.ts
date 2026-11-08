// Whether this bb can run a release, judged the way bb's own install and
// update check do: by the `engines.bb` and `engines.bbPluginSdk` ranges in the
// release's package.json, read from git without installing or building.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import semver from "semver";
import { message } from "./errors";
import { readPackageJsonAt } from "./git";

/** Unknown versions skip their check: bb refuses the install anyway. */
export interface HostVersions {
  bb?: string;
  sdk?: string;
}

interface Engines {
  bb?: string;
  bbPluginSdk?: string;
}

/**
 * bb's version comes from `system.version()`. No API reports its plugin SDK
 * version, but bb builds its builtins' app bundles with that SDK (and rebuilds
 * them when it changes), so the newest of those stands in for it.
 */
export async function readHostVersions(bb: BbPluginApi): Promise<HostVersions> {
  // Async wrappers, so a call that throws rather than rejects is settled too.
  const [system, list] = await Promise.allSettled([
    (async () => bb.sdk.system.version())(),
    (async () => bb.sdk.plugins.list())(),
  ]);
  const versions: HostVersions = {};
  if (system.status === "fulfilled") versions.bb = system.value.currentVersion;
  else bb.log.warn(`can't read bb's version, so not checking engines.bb: ${message(system.reason)}`);
  if (list.status === "fulfilled") {
    const sdk = list.value.plugins
      .filter((p) => p.source.startsWith("builtin:"))
      .map((p) => p.app?.bundle?.sdkVersion)
      .filter((v): v is string => typeof v === "string" && semver.valid(v) !== null)
      .sort(semver.rcompare)[0];
    if (sdk !== undefined) versions.sdk = sdk;
  }
  return versions;
}

/** Host versions, re-read at most once a minute (a check reads them per plugin). */
export function cachedHostVersions(bb: BbPluginApi, ttlMs = 60_000) {
  let cached: { at: number; versions: Promise<HostVersions> } | undefined;
  return () => {
    if (cached === undefined || Date.now() - cached.at > ttlMs) {
      cached = { at: Date.now(), versions: readHostVersions(bb) };
    }
    return cached.versions;
  };
}

/** Same rule as bb: satisfied, or no older than the range's floor within the same major. */
function sdkSatisfies(sdk: string, range: string): boolean {
  if (semver.satisfies(sdk, range)) return true;
  const floor = semver.minVersion(range);
  return floor !== null && semver.major(floor) === semver.major(sdk) && semver.gte(sdk, floor);
}

/** Why this bb can't run a release with these engines, in bb's own words; empty if it can. */
export function engineProblems(engines: Engines, host: HostVersions): string[] {
  const problems: string[] = [];
  const bb = host.bb === undefined ? null : semver.coerce(host.bb);
  // bb's dev builds (0.0.0) don't enforce engines.bb.
  if (engines.bb !== undefined && bb !== null && bb.version !== "0.0.0") {
    if (semver.validRange(engines.bb) === null) {
      problems.push(`declares invalid engines.bb range ${JSON.stringify(engines.bb)}`);
    } else if (!semver.satisfies(bb, engines.bb)) {
      problems.push(`requires bb ${engines.bb}, running bb is ${bb.version}`);
    }
  }
  const sdkRange = engines.bbPluginSdk;
  if (sdkRange !== undefined && host.sdk !== undefined) {
    if (semver.validRange(sdkRange) === null) {
      problems.push(`declares invalid engines.bbPluginSdk range ${JSON.stringify(sdkRange)}`);
    } else if (!sdkSatisfies(host.sdk, sdkRange)) {
      problems.push(`requires bb plugin SDK ${sdkRange}, running SDK is ${host.sdk}`);
    }
  }
  return problems;
}

/** Reads the release's package.json at `tag`; throws if it can't be read. */
export async function releaseProblems(
  release: { url: string; tag: string; subdirectory?: string },
  host: HostVersions,
): Promise<string[]> {
  let engines: Engines;
  try {
    const manifest: unknown = JSON.parse(await readPackageJsonAt(release));
    const raw = (manifest as { engines?: Record<string, unknown> } | null)?.engines ?? {};
    engines = {
      ...(typeof raw.bb === "string" ? { bb: raw.bb } : {}),
      ...(typeof raw.bbPluginSdk === "string" ? { bbPluginSdk: raw.bbPluginSdk } : {}),
    };
  } catch (error) {
    throw new Error(`couldn't read ${release.tag}'s package.json: ${message(error)}`);
  }
  return engineProblems(engines, host);
}
