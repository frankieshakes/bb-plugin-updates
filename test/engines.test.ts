import { describe, expect, it } from "vitest";
import { engineProblems } from "../src/engines";

describe("engineProblems", () => {
  const host = { bb: "0.46.1", sdk: "0.6.49" };

  it("passes a release without engines, or one this bb satisfies", () => {
    expect(engineProblems({}, host)).toEqual([]);
    expect(engineProblems({ bb: ">=0.46", bbPluginSdk: "^0.6.40" }, host)).toEqual([]);
  });

  it("names each range this bb misses, as bb does", () => {
    expect(engineProblems({ bb: ">=0.47", bbPluginSdk: ">=0.6.54" }, host)).toEqual([
      "requires bb >=0.47, running bb is 0.46.1",
      "requires bb plugin SDK >=0.6.54, running SDK is 0.6.49",
    ]);
    expect(engineProblems({ bb: "not a range" }, host)).toEqual([
      'declares invalid engines.bb range "not a range"',
    ]);
  });

  it("follows bb's SDK rule: a newer SDK of the same major satisfies the range's floor", () => {
    expect(engineProblems({ bbPluginSdk: ">=0.5.0 <0.6.0" }, host)).toEqual([]);
    expect(engineProblems({ bbPluginSdk: "^1.0.0" }, host)).toEqual([
      "requires bb plugin SDK ^1.0.0, running SDK is 0.6.49",
    ]);
  });

  it("skips what it can't know, and engines.bb on bb's dev builds", () => {
    expect(engineProblems({ bb: ">=9", bbPluginSdk: ">=9.0.0" }, {})).toEqual([]);
    expect(engineProblems({ bb: ">=9" }, { bb: "0.0.0" })).toEqual([]);
  });
});
