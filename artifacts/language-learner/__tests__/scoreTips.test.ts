import { describe, it, expect } from "vitest";
import { buildScoreTips } from "@/utils/scoreTips";

describe("buildScoreTips", () => {
  it("returns encouragement when every dimension is high", () => {
    const out = buildScoreTips({
      mode: "shadowing",
      metrics: { accuracy: 92, confidence: 90, pace: 88, prosody: 95, prosodyAvailable: true },
    });
    expect(out.tips).toEqual([]);
    expect(out.encouragement).toBe(true);
  });

  it("emits a severe tip for the lowest-weighted dimension when it tanks", () => {
    const out = buildScoreTips({
      mode: "shadowing",
      metrics: { accuracy: 90, confidence: 90, pace: 90, prosody: 30, prosodyAvailable: true },
    });
    expect(out.tips).toHaveLength(1);
    expect(out.tips[0].icon).toBe("prosody");
    expect(out.tips[0].reasonKey).toContain("severe");
  });

  it("caps dimension tips at 3 ordered by impact (weight × deficit)", () => {
    const out = buildScoreTips({
      mode: "shadowing",
      metrics: {
        accuracy: 50,    // (85-50)*0.40 = 14 → highest
        confidence: 50,  // (85-50)*0.25 = 8.75
        pace: 50,        // (85-50)*0.15 = 5.25 → lowest, drops off
        prosody: 50,     // (85-50)*0.20 = 7
        prosodyAvailable: true,
      },
    });
    expect(out.tips).toHaveLength(3);
    expect(out.tips.map((t) => t.icon)).toEqual(["accuracy", "confidence", "prosody"]);
  });

  it("skips prosody entirely when prosodyAvailable is false", () => {
    const out = buildScoreTips({
      mode: "shadowing",
      metrics: { accuracy: 90, confidence: 90, pace: 90, prosody: 10, prosodyAvailable: false },
    });
    expect(out.tips).toEqual([]);
    expect(out.encouragement).toBe(true);
  });

  it("appends a hint tip for dictation on top of the 3-cap", () => {
    const out = buildScoreTips({
      mode: "dictation",
      metrics: { hintsUsed: 2, hintScoreDeduction: 20 },
    });
    expect(out.tips).toHaveLength(1);
    expect(out.tips[0].icon).toBe("hint");
    expect(out.tips[0].params).toEqual({ count: 2, delta: 20 });
  });

  it("appends a coverage tip for recitation when coverage is low", () => {
    const out = buildScoreTips({
      mode: "recitation",
      metrics: { coverage: 40 },
    });
    expect(out.tips).toHaveLength(1);
    expect(out.tips[0].icon).toBe("coverage");
    expect(out.tips[0].params).toEqual({ coverage: 40 });
  });

  it("does not emit a coverage tip when recitation coverage is high", () => {
    const out = buildScoreTips({
      mode: "recitation",
      metrics: { coverage: 90 },
    });
    expect(out.tips).toEqual([]);
    expect(out.encouragement).toBe(true);
  });
});
