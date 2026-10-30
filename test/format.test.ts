import { describe, expect, it } from "vitest";
import { formatReport } from "../src/format";
import { buildReport, type CheckEntry } from "../src/report";

const update = (id: string): CheckEntry => ({
  id,
  outcome: "update-available",
  installed: { version: "aaa", display: `${id}@v1 (aaa)` },
  candidate: { version: "bbb", display: `${id}@v2 (bbb)` },
});

const current = (id: string): CheckEntry => ({
  id,
  outcome: "current",
  installed: { version: "aaa", display: `${id}@v1 (aaa)` },
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
