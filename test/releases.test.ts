import { describe, expect, it } from "vitest";
import { releaseCheckTarget, resolveNewerRelease } from "../src/releases";

const sha = (n: number) => String(n).repeat(40).slice(0, 40);

function lsRemote(tags: Array<[string, string]>): string {
  return tags.map(([commit, tag]) => `${commit}\trefs/tags/${tag}`).join("\n");
}

describe("resolveNewerRelease", () => {
  it("offers the newest tag beyond a semver range, keeping range form", () => {
    const result = resolveNewerRelease({
      source: {
        requested: "git:https://github.com/a/b.git@semver:^0.7.0",
        range: "^0.7.0",
        resolvedTag: "v0.7.0",
      },
      installedVersion: "0.7.0",
      lsRemote: lsRemote([
        [sha(1), "v0.7.0"],
        [sha(2), "v0.8.0"],
        [sha(3), "v0.9.2"],
      ]),
    });

    expect(result).toEqual({
      kind: "out-of-range",
      from: "0.7.0",
      to: "0.9.2",
      newSource: "git:https://github.com/a/b.git@semver:^0.9.2",
      compareUrl: "https://github.com/a/b/compare/v0.7.0...v0.9.2",
    });
  });

  it("keeps a commit pin pinned, moving it to the newest tag's commit", () => {
    const pinned = sha(1);
    const result = resolveNewerRelease({
      source: { requested: `git:https://github.com/a/b.git@${pinned}` },
      installedVersion: "0.1.0",
      lsRemote: [
        `${sha(7)}\trefs/tags/v0.2.0`,
        `${sha(2)}\trefs/tags/v0.2.0^{}`,
      ].join("\n"),
    });

    expect(result).toEqual({
      kind: "out-of-range",
      from: "0.1.0",
      to: "0.2.0",
      newSource: `git:https://github.com/a/b.git@${sha(2)}`,
      compareUrl: `https://github.com/a/b/compare/${pinned}...v0.2.0`,
    });
  });

  it("keeps an exact tag pin pinned to the newest tag", () => {
    const result = resolveNewerRelease({
      source: {
        requested: "git:https://github.com/a/b.git@v0.7.0",
        resolvedTag: "v0.7.0",
      },
      installedVersion: "0.7.0",
      lsRemote: lsRemote([
        [sha(1), "v0.7.0"],
        [sha(2), "v0.7.1"],
      ]),
    });

    expect(result).toEqual({
      kind: "out-of-range",
      from: "0.7.0",
      to: "0.7.1",
      newSource: "git:https://github.com/a/b.git@v0.7.1",
      compareUrl: "https://github.com/a/b/compare/v0.7.0...v0.7.1",
    });
  });

  it("never offers a prerelease", () => {
    const result = resolveNewerRelease({
      source: {
        requested: "git:https://github.com/a/b.git@semver:^0.7.0",
        range: "^0.7.0",
        resolvedTag: "v0.7.0",
      },
      installedVersion: "0.7.0",
      lsRemote: lsRemote([
        [sha(1), "v0.7.0"],
        [sha(2), "v0.8.0"],
        [sha(3), "v1.0.0-beta.1"],
      ]),
    });

    expect(result).toMatchObject({ kind: "out-of-range", to: "0.8.0" });
  });

  it("respects a monorepo tag prefix and ignores other plugins' tags", () => {
    const result = resolveNewerRelease({
      source: {
        requested:
          "git:https://github.com/m/bb-plugins.git@semver:taskboard/:^0.3.3",
        range: "^0.3.3",
        tagPrefix: "taskboard/",
        resolvedTag: "taskboard/v0.3.4",
        subdirectory: "plugins/taskboard",
      },
      installedVersion: "0.3.4",
      lsRemote: lsRemote([
        [sha(1), "taskboard/v0.3.4"],
        [sha(2), "taskboard/v0.4.1"],
        [sha(3), "other/v9.0.0"],
        [sha(4), "v5.0.0"],
      ]),
    });

    expect(result).toEqual({
      kind: "out-of-range",
      from: "0.3.4",
      to: "0.4.1",
      newSource:
        "git:https://github.com/m/bb-plugins.git@semver:taskboard/:^0.4.1",
      compareUrl:
        "https://github.com/m/bb-plugins/compare/taskboard/v0.3.4...taskboard/v0.4.1",
    });
  });
});

describe("releaseCheckTarget", () => {
  it("checks the repository of a range, commit, or tag source", () => {
    for (const requested of [
      "git:https://github.com/a/b.git@semver:^0.7.0",
      "git:https://github.com/m/bb-plugins.git@semver:taskboard/:^0.3.3",
      `git:https://github.com/a/b.git@${sha(1)}`,
      "git:https://github.com/a/b.git@v0.7.0",
    ]) {
      expect(releaseCheckTarget({ requested }).kind).toBe("git");
    }
    expect(
      releaseCheckTarget({ requested: "git:https://github.com/a/b.git@semver:^0.7.0" }),
    ).toEqual({ kind: "git", url: "https://github.com/a/b.git" });
  });

  it.each([
    ["builtin:tasks", "builtin"],
    ["npm:bb-plugin-x@1.2.3", "npm"],
    ["/Users/me/code/bb-plugin-x", "local"],
    ["git:https://github.com/a/b.git@main", "branch"],
    ["git:https://github.com/a/b.git", "branch"],
  ])("skips %s (%s)", (requested, reason) => {
    expect(releaseCheckTarget({ requested })).toEqual({ kind: "skip", reason });
  });
});
