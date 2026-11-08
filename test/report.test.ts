import { describe, expect, it } from "vitest";
import { buildReport, type CheckEntry } from "../src/report";

const homepageUpdate: CheckEntry = {
  id: "homepage",
  outcome: "update-available",
  installed: { version: "7caaae1", label: "0.2.5", display: "bb-homepage.git@v0.2.5 (7caaae1)" },
  candidate: { version: "dbcb6f5", label: "0.2.7", display: "bb-homepage.git@v0.2.7 (dbcb6f5)" },
};

const agentBoardCurrent: CheckEntry = {
  id: "agent-board",
  outcome: "current",
  installed: { version: "c4a6633", label: "0.7.0", display: "bb-plugin-agent-board.git@v0.7.0 (c4a6633)" },
};

const agentBoardRelease = {
  kind: "out-of-range" as const,
  from: "0.7.0",
  to: "0.9.2",
  tag: "v0.9.2",
  newSource: "git:https://github.com/a/bb-plugin-agent-board.git@semver:^0.9.2",
  compareUrl: "https://github.com/a/bb-plugin-agent-board/compare/v0.7.0...v0.9.2",
};

describe("buildReport", () => {
  it("lists a compatible update, counts it, and announces it once", () => {
    const report = buildReport({
      checks: [homepageUpdate],
      releases: {},
      ignored: {},
      seen: {},
    });

    expect(report.compatible).toEqual([
      {
        id: "homepage",
        from: "bb-homepage.git@v0.2.5 (7caaae1)",
        to: "bb-homepage.git@v0.2.7 (dbcb6f5)",
        version: "dbcb6f5",
      },
    ]);
    expect(report.badgeCount).toBe(1);
    expect(report.newlySeen).toEqual([{ id: "homepage", version: "dbcb6f5" }]);
  });

  it("does not announce a version it already announced", () => {
    const report = buildReport({
      checks: [homepageUpdate],
      releases: {},
      ignored: {},
      seen: { homepage: ["dbcb6f5"] },
    });

    expect(report.badgeCount).toBe(1);
    expect(report.newlySeen).toEqual([]);
  });

  it("moves an ignored version to the ignored section, uncounted and unannounced", () => {
    const report = buildReport({
      checks: [homepageUpdate],
      releases: {},
      ignored: { homepage: ["dbcb6f5"] },
      seen: {},
    });

    expect(report.compatible).toEqual([]);
    expect(report.upToDate).toEqual([]);
    expect(report.other).toEqual([]);
    expect(report.ignored).toEqual([
      {
        id: "homepage",
        kind: "compatible",
        from: "bb-homepage.git@v0.2.5 (7caaae1)",
        to: "bb-homepage.git@v0.2.7 (dbcb6f5)",
        version: "dbcb6f5",
      },
    ]);
    expect(report.badgeCount).toBe(0);
    expect(report.newlySeen).toEqual([]);
  });

  it("lists a newer release outside the range, counts it, and announces it", () => {
    const report = buildReport({
      checks: [agentBoardCurrent],
      releases: { "agent-board": agentBoardRelease },
      ignored: {},
      seen: {},
    });

    expect(report.outOfRange).toEqual([
      {
        id: "agent-board",
        from: "0.7.0",
        to: "0.9.2",
        version: "0.9.2",
        tag: "v0.9.2",
        newSource: "git:https://github.com/a/bb-plugin-agent-board.git@semver:^0.9.2",
        compareUrl:
          "https://github.com/a/bb-plugin-agent-board/compare/v0.7.0...v0.9.2",
      },
    ]);
    expect(report.badgeCount).toBe(1);
    expect(report.newlySeen).toEqual([{ id: "agent-board", version: "0.9.2" }]);
  });

  it("counts a plugin once when it has both kinds of update", () => {
    const report = buildReport({
      checks: [
        {
          ...agentBoardCurrent,
          outcome: "update-available",
          candidate: { version: "aaaa111", label: "0.7.3", display: "bb-plugin-agent-board.git@v0.7.3 (aaaa111)" },
        },
      ],
      releases: { "agent-board": agentBoardRelease },
      ignored: {},
      seen: {},
    });

    expect(report.compatible).toHaveLength(1);
    expect(report.outOfRange).toHaveLength(1);
    expect(report.badgeCount).toBe(1);
  });

  it("lists a release blocked by engine ranges without counting it", () => {
    const report = buildReport({
      checks: [
        {
          ...agentBoardCurrent,
          blocked: { version: "v0.7.5", label: "0.7.5", reasons: ["requires bb >=0.60"] },
        },
      ],
      releases: {},
      ignored: {},
      seen: {},
    });

    expect(report.blocked).toEqual([
      { id: "agent-board", version: "v0.7.5", label: "0.7.5", reasons: ["requires bb >=0.60"] },
    ]);
    expect(report.badgeCount).toBe(0);
    expect(report.newlySeen).toEqual([]);
  });

  it("lists releases outside the range that this bb can't run as blocked, beside bb's own", () => {
    const reasons = ["requires bb >=0.47, running bb is 0.46.1"];
    const report = buildReport({
      checks: [
        { ...agentBoardCurrent, blocked: { version: "v0.7.5", label: "0.7.5", reasons: ["requires bb >=0.60"] } },
        { ...homepageUpdate, id: "notes" },
      ],
      releases: {
        // Only a release it can't run: blocked, nothing offered.
        "agent-board": { kind: "blocked", version: "0.9.2", reasons },
        // An older one it can run is offered; the newer one is blocked.
        notes: { ...agentBoardRelease, to: "0.8.0", blocked: { version: "0.9.2", reasons } },
      },
      ignored: {},
      seen: {},
    });

    expect(report.blocked).toEqual([
      { id: "agent-board", version: "v0.7.5", label: "0.7.5", reasons: ["requires bb >=0.60"] },
      { id: "agent-board", version: "0.9.2", reasons },
      { id: "notes", version: "0.9.2", reasons },
    ]);
    expect(report.outOfRange).toMatchObject([{ id: "notes", to: "0.8.0" }]);
    expect(report.outOfRange[0]).not.toHaveProperty("blocked");
    expect(report.upToDate.map(({ id }) => id)).toEqual(["agent-board"]);
    expect(report.badgeCount).toBe(1);
  });

  it("files plugins with nothing to do under up to date or other", () => {
    const report = buildReport({
      checks: [
        homepageUpdate,
        agentBoardCurrent,
        {
          id: "tasks",
          outcome: "pinned",
          installed: { version: "0.1.0", label: "0.1.0", display: "builtin:tasks" },
        },
        {
          id: "gone",
          outcome: "unavailable",
          installed: { version: "abc1234", label: "1.0.0", display: "bb-plugin-gone.git@v1.0.0 (abc1234)" },
          detail: "repository not found",
        },
      ],
      releases: {},
      ignored: {},
      seen: {},
    });

    expect(report.upToDate).toEqual([
      { id: "agent-board", installed: "bb-plugin-agent-board.git@v0.7.0 (c4a6633)" },
    ]);
    expect(report.other).toEqual([
      { id: "tasks", installed: "builtin:tasks", outcome: "pinned" },
      {
        id: "gone",
        installed: "bb-plugin-gone.git@v1.0.0 (abc1234)",
        outcome: "unavailable",
        detail: "repository not found",
      },
    ]);
  });

  it("reports a failed release check without counting it", () => {
    const report = buildReport({
      checks: [agentBoardCurrent],
      releases: {
        "agent-board": { kind: "failed", error: "Authentication failed" },
      },
      ignored: {},
      seen: {},
    });

    expect(report.releaseCheckFailures).toEqual([
      { id: "agent-board", error: "Authentication failed" },
    ]);
    expect(report.upToDate.map(({ id }) => id)).toEqual(["agent-board"]);
    expect(report.badgeCount).toBe(0);
  });

  it("flags a disabled plugin's updates without counting or announcing them", () => {
    const report = buildReport({
      checks: [homepageUpdate, agentBoardCurrent],
      releases: { "agent-board": agentBoardRelease },
      ignored: {},
      seen: {},
      disabled: ["homepage", "agent-board"],
    });

    expect(report.compatible).toMatchObject([{ id: "homepage", disabled: true }]);
    expect(report.outOfRange).toMatchObject([{ id: "agent-board", disabled: true }]);
    expect(report.badgeCount).toBe(0);
    expect(report.newlySeen).toEqual([]);
  });

  it("keeps release results for plugins bb couldn't check, in the order given, never as idle", () => {
    const report = buildReport({
      checks: [homepageUpdate],
      releases: {
        c: { kind: "failed", error: "Authentication failed" },
        b: { kind: "blocked", version: "2.0.0", reasons: ["requires bb >=9"] },
        "agent-board": { ...agentBoardRelease, blocked: { version: "1.0.0", reasons: ["requires bb >=9"] } },
        off: { ...agentBoardRelease, from: "0.1.0" },
      },
      ignored: {},
      seen: {},
      disabled: ["off"],
      unchecked: ["agent-board", "b", "c", "off"],
    });

    const { kind: _, ...offered } = agentBoardRelease;
    expect(report.outOfRange).toEqual([
      { id: "agent-board", ...offered, version: "0.9.2" },
      { id: "off", ...offered, from: "0.1.0", version: "0.9.2", disabled: true },
    ]);
    expect(report.blocked).toEqual([
      { id: "agent-board", version: "1.0.0", reasons: ["requires bb >=9"] },
      { id: "b", version: "2.0.0", reasons: ["requires bb >=9"] },
    ]);
    expect(report.releaseCheckFailures).toEqual([{ id: "c", error: "Authentication failed" }]);
    expect(report.upToDate).toEqual([]);
    expect(report.other).toEqual([]);
    expect(report.badgeCount).toBe(2);
    expect(report.newlySeen).toEqual([
      { id: "homepage", version: "dbcb6f5" },
      { id: "agent-board", version: "0.9.2" },
    ]);
  });

  it("ignores an unchecked plugin's ignored release like any other", () => {
    const report = buildReport({
      checks: [],
      releases: { "agent-board": agentBoardRelease },
      ignored: { "agent-board": ["0.9.2"] },
      seen: {},
      unchecked: ["agent-board"],
    });

    expect(report.outOfRange).toEqual([]);
    expect(report.ignored).toMatchObject([{ id: "agent-board", kind: "out-of-range", to: "0.9.2" }]);
    expect(report.badgeCount).toBe(0);
  });
});
