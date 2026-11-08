import { describe, expect, it } from "vitest";
import { engineProblems } from "../src/engines";

describe("engineProblems", () => {
  const host = { bb: "0.46.1" };

  it("passes a release without engines, or one this bb satisfies", () => {
    expect(engineProblems({}, host)).toEqual([]);
    expect(engineProblems({ bb: ">=0.46" }, host)).toEqual([]);
  });

  it("names the bb range this bb misses, as bb does", () => {
    expect(engineProblems({ bb: ">=0.47" }, host)).toEqual([
      "requires bb >=0.47, running bb is 0.46.1",
    ]);
    expect(engineProblems({ bb: "not a range" }, host)).toEqual([
      'declares invalid engines.bb range "not a range"',
    ]);
  });

  it("skips what it can't know, and engines.bb on bb's dev builds", () => {
    expect(engineProblems({ bb: ">=9" }, {})).toEqual([]);
    expect(engineProblems({ bb: ">=9" }, { bb: "0.0.0" })).toEqual([]);
  });
});
