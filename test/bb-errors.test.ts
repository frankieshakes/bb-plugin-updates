// Messages copied from bb 0.49.0's server (start-server.js) and an isolated run of it.
import { describe, expect, it } from "vitest";
import { engineRefusal, isCheckError } from "../src/bb-errors";
import type { CheckEntry } from "../src/report";

const unavailable = (detail?: string): CheckEntry => ({
  id: "p",
  outcome: "unavailable",
  installed: { version: "abc", label: "1.0.0", display: "p@v1.0.0 (abc)" },
  ...(detail === undefined ? {} : { detail }),
});

describe("isCheckError", () => {
  it.each([
    // runInstallCommand, which runs every git and npm command bb's check does
    "git ls-remote failed (exit 128): fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443 after 75002 ms: Operation timed out",
    "git ls-remote failed (exit 128): fatal: '/tmp/bbiso.Ec6SZc/fixtures/does-not-exist-fa' does not appear to be a git repository\nfatal: Could not read from remote repository.",
    "git clone failed (exit 128): fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com",
    "git -C failed (exit signal)",
    "git ls-remote timed out after 300000ms",
    "git ls-remote produced more than 8388608 bytes of output",
    '"git" was not found on PATH — git plugin updates require git',
    // the npm registry
    "@a/b registry request failed: fetch failed",
    "@a/b registry request failed: 503 Service Unavailable",
    "registry returned malformed metadata for @a/b: invalid packument",
    // parsing git's answer
    'malformed git ls-remote output: "x"',
    'git ls-remote returned invalid object id "x"',
    "install cancelled",
  ])("counts %j as an error", (detail) => {
    expect(isCheckError(unavailable(detail))).toBe(true);
  });

  it.each([
    'no tag of https://github.com/a/b.git matches ^0.7.0 (looking for tags named "vX.Y.Z")',
    "no release of https://github.com/a/b.git matching ^0.7.0 runs on this bb within the newest 10 releases",
    'security check failed: recorded git tag "v1.0.0" no longer exists in https://github.com/a/b.git; bb will not re-resolve a missing release tag. Restore the tag, or remove and install the plugin again',
    'git ref "main" was not found in https://github.com/a/b.git',
    "git default branch was not found in https://github.com/a/b.git",
    "no published version of @a/b matches ^1.0.0",
    "registry metadata contains no usable versions for @a/b",
    "installed from the retired remote marketplace — remove it and reinstall from Plugins → Browse plugins to switch to the bundled copy",
    'candidate manifest id changed from "a" to "b"',
    "updates have not been checked yet",
  ])("leaves %j alone: bb can't check it by design", (detail) => {
    expect(isCheckError(unavailable(detail))).toBe(false);
  });

  it("only counts unavailable entries", () => {
    expect(isCheckError(unavailable())).toBe(false);
    expect(isCheckError({ ...unavailable("git ls-remote failed (exit 128): x"), outcome: "pinned" })).toBe(false);
  });
});

describe("engineRefusal", () => {
  it.each([
    ["install failed: requires bb plugin SDK >=99.0.0, running SDK is 0.6.132", "requires bb plugin SDK >=99.0.0, running SDK is 0.6.132"],
    ['install refused: plugin "fd" requires bb plugin SDK >=99.0.0, running SDK is 0.6.132', "requires bb plugin SDK >=99.0.0, running SDK is 0.6.132"],
    ['HTTP 422: install refused: plugin "fd" requires bb >=99, this is 0.49.0', "requires bb >=99, this is 0.49.0"],
    ["install failed: requires bb >=0.50 <1, running bb is 0.49.0", "requires bb >=0.50 <1, running bb is 0.49.0"],
    ['install failed: declares invalid engines.bbPluginSdk range "nope"', 'declares invalid engines.bbPluginSdk range "nope"'],
  ])("finds bb's engine reason in %j", (error, reason) => {
    expect(engineRefusal(error)).toBe(reason);
  });

  it.each([
    'install failed: server bundle build for "fe" failed: Build failed with 1 error',
    'install failed: no tag of https://fixture.invalid/fe matches ^0.1.0 (looking for tags named "vX.Y.Z")',
    "git clone failed (exit 128): fatal: repository not found",
  ])("finds none in %j", (error) => {
    expect(engineRefusal(error)).toBeUndefined();
  });
});
