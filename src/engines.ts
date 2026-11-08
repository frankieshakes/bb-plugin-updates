// Whether this bb can run a release, judged by the `engines.bb` range in the
// release's package.json, read from git without installing or building.
// `engines.bbPluginSdk` is left to bb's own install refusal: no API reports
// the host's plugin SDK version.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import semver from "semver";
import { message } from "./errors";
import { readPackageJsonAt } from "./git";

/** Unknown versions skip their check: bb refuses the install anyway. */
export interface HostVersions {
  bb?: string;
}

interface Engines {
  bb?: string;
}

/** bb's version, from `system.version()`. */
export async function readHostVersions(bb: BbPluginApi): Promise<HostVersions> {
  try {
    return { bb: (await bb.sdk.system.version()).currentVersion };
  } catch (error) {
    bb.log.warn(`can't read bb's version, so not checking engines.bb: ${message(error)}`);
    return {};
  }
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

/** Why this bb can't run a release with these engines, in bb's own words; empty if it can. */
export function engineProblems(engines: Engines, host: HostVersions): string[] {
  const bb = host.bb === undefined ? null : semver.coerce(host.bb);
  // bb's dev builds (0.0.0) don't enforce engines.bb.
  if (engines.bb === undefined || bb === null || bb.version === "0.0.0") return [];
  if (semver.validRange(engines.bb) === null) {
    return [`declares invalid engines.bb range ${JSON.stringify(engines.bb)}`];
  }
  if (!semver.satisfies(bb, engines.bb)) {
    return [`requires bb ${engines.bb}, running bb is ${bb.version}`];
  }
  return [];
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
    engines = typeof raw.bb === "string" ? { bb: raw.bb } : {};
  } catch (error) {
    throw new Error(`couldn't read ${release.tag}'s package.json: ${message(error)}`);
  }
  return engineProblems(engines, host);
}
