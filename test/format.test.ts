import { describe, expect, it } from "vitest";
import { formatReport } from "../src/format";
import { buildReport, type CheckEntry } from "../src/report";

const update = (id: string): CheckEntry => ({
  id,
  outcome: "update-available",
  installed: { version: "aaa", label: "1", display: `${id}@v1 (aaa)` },
  candidate: { version: "bbb", label: "2", display: `${id}@v2 (bbb)` },
});

const current = (id: string): CheckEntry => ({
  id,
  outcome: "current",
  installed: { version: "aaa", label: "1", display: `${id}@v1 (aaa)` },
});

const footer = (checks: CheckEntry[], disabled: string[] = []) =>
  formatReport(buildReport({ checks, releases: {}, ignored: {}, seen: {}, disabled }), 0)
    .split("\n")
    .at(-1)
    ?.replace(/ Checked .*$/, "");

describe("formatReport footer", () => {
  it("says no plugins have updates when none do", () => {
    expect(footer([current("a")])).toBe("No plugins with updates.");
  });

  it("counts enabled plugins", () => {
    expect(footer([update("a")])).toBe("1 plugin with updates.");
    expect(footer([update("a"), update("b")])).toBe("2 plugins with updates.");
  });

  it("mentions disabled plugins when only they have updates", () => {
    expect(footer([update("a")], ["a"])).toBe(
      "No enabled plugins with updates (1 disabled plugin has an update).",
    );
    expect(footer([update("a"), update("b")], ["a", "b"])).toBe(
      "No enabled plugins with updates (2 disabled plugins have updates).",
    );
  });

  it("adds disabled plugins to the enabled count when mixed", () => {
    expect(footer([update("a"), update("b"), update("c")], ["c"])).toBe(
      "2 plugins with updates, plus 1 disabled.",
    );
  });
});

describe("formatReport", () => {
  it("marks a stale update with when it was last confirmed", () => {
    const report = buildReport({
      checks: [],
      releases: {},
      ignored: {},
      seen: {},
      unchecked: ["a"],
      carried: [{ entry: update("a"), confirmedAt: 0 }],
    });

    expect(formatReport(report, 0)).toContain(
      `Compatible updates:\n  a  a@v1 (aaa) → a@v2 (bbb)  (stale: last confirmed ${new Date(0).toLocaleString()})\n`,
    );
  });

  it("lists each plugin's failure under a check that failed as a whole", () => {
    const text = formatReport(buildReport({ checks: [], releases: {}, ignored: {}, seen: {} }), 0, {
      lastFailure: {
        at: 0,
        error: "every plugin's update check failed",
        failures: [
          { id: "a", error: "git ls-remote failed (exit 128): x" },
          { id: "b", error: "git ls-remote failed (exit 128): y" },
        ],
      },
    });

    expect(text).toMatch(
      /Last check failed .+: every plugin's update check failed\. Showing results from .+\.\n  a  git ls-remote failed \(exit 128\): x\n  b  git ls-remote failed \(exit 128\): y$/,
    );
  });
});
