// Runs real git against a throwaway local repository; nothing leaves the machine.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listRemoteTags, readPackageJsonAt } from "../src/git";

let root: string;
let url: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith("bb-plugin-updates-"));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "git-test-"));
  url = pathToFileURL(root).href;
  git("init", "--quiet", "-b", "main");
  // Lets the fetch leave blobs behind, as GitHub does.
  git("config", "uploadpack.allowFilter", "true");
  git("config", "uploadpack.allowAnySHA1InWant", "true");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
  mkdirSync(join(root, "plugins/notes"), { recursive: true });
  writeFileSync(join(root, "plugins/notes/package.json"), JSON.stringify({ engines: { bb: ">=0.47" } }));
  git("add", ".");
  git("commit", "--quiet", "-m", "one");
  git("tag", "v1.0.0");
  git("tag", "-a", "-m", "notes", "notes/v0.2.0");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.0.0" }));
  git("commit", "--quiet", "-am", "two");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("readPackageJsonAt", () => {
  it("reads package.json at a tag, not the branch tip, and cleans up", async () => {
    const before = leftovers();

    const text = await readPackageJsonAt({ url, tag: "v1.0.0" });

    expect(JSON.parse(text)).toEqual({ version: "1.0.0" });
    expect(leftovers()).toEqual(before);
  });

  it("reads a subdirectory's package.json at an annotated, prefixed tag", async () => {
    const text = await readPackageJsonAt({ url, tag: "notes/v0.2.0", subdirectory: "./plugins/notes/" });

    expect(JSON.parse(text)).toEqual({ engines: { bb: ">=0.47" } });
  });

  it("fails on a missing tag or file, and still cleans up", async () => {
    const before = leftovers();

    await expect(readPackageJsonAt({ url, tag: "v9.9.9" })).rejects.toThrow();
    await expect(readPackageJsonAt({ url, tag: "v1.0.0", subdirectory: "nope" })).rejects.toThrow();
    expect(leftovers()).toEqual(before);
  });
});

describe("git's own timeout", () => {
  it("says the command timed out, and after how long", async () => {
    // A stand-in git that hangs, as one stuck on an unreachable host does.
    const bin = mkdtempSync(join(tmpdir(), "fake-git-"));
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 });
    const PATH = process.env.PATH;
    process.env.PATH = `${bin}:${PATH}`;
    try {
      await expect(listRemoteTags("https://example.invalid/a.git", { timeoutMs: 200 })).rejects.toThrow(
        /^git ls-remote --tags https:\/\/example\.invalid\/a\.git timed out after 0\.2s$/,
      );
    } finally {
      process.env.PATH = PATH;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
