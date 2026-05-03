import { describe, expect, it } from "vitest";
import {
  buildRecitationHintPlan,
  isCjkText,
  pacingFor,
} from "../utils/recitationHint";

const MASK = "▁";
const containsMask = (s: string) => s.includes(MASK);

describe("pacingFor", () => {
  it("returns zero plan for empty candidate set", () => {
    expect(pacingFor(0)).toEqual({ steps: 0, perStep: 0 });
  });

  it("reveals one keyword per tap for tiny passages", () => {
    expect(pacingFor(1)).toEqual({ steps: 1, perStep: 1 });
    expect(pacingFor(3)).toEqual({ steps: 3, perStep: 1 });
  });

  it("scales steps and per-step reveal for medium passages", () => {
    // 8 candidates → 2 steps × 4 per step
    expect(pacingFor(8)).toEqual({ steps: 2, perStep: 4 });
    // 16 candidates → 4 × 4
    expect(pacingFor(16)).toEqual({ steps: 4, perStep: 4 });
  });

  it("caps total steps for very long passages", () => {
    // > 32 candidates always uses 8 steps
    const p = pacingFor(64);
    expect(p.steps).toBe(8);
    expect(p.perStep).toBe(8);
    const p2 = pacingFor(200);
    expect(p2.steps).toBe(8);
    expect(p2.perStep).toBe(25);
  });
});

describe("isCjkText", () => {
  it("detects CJK ideographs, kana, and hangul", () => {
    expect(isCjkText("今天天气很好")).toBe(true);
    expect(isCjkText("こんにちは")).toBe(true);
    expect(isCjkText("안녕하세요")).toBe(true);
  });

  it("rejects pure-latin / cyrillic text", () => {
    expect(isCjkText("Hello world")).toBe(false);
    expect(isCjkText("Привет мир")).toBe(false);
  });
});

describe("buildRecitationHintPlan (Latin)", () => {
  const passage =
    "The quick brown fox jumps over the lazy dog while the cat naps quietly.";

  it("returns empty plan for empty text", () => {
    const plan = buildRecitationHintPlan("", 0);
    expect(plan.totalKeywords).toBe(0);
    expect(plan.totalSteps).toBe(0);
    expect(plan.display).toBe("");
  });

  it("masks every keyword at step 0 but preserves whitespace and punctuation", () => {
    const plan = buildRecitationHintPlan(passage, 0);
    expect(plan.revealedKeywords).toBe(0);
    expect(plan.totalKeywords).toBeGreaterThan(0);
    expect(containsMask(plan.display)).toBe(true);
    // Spaces and the trailing period stay visible.
    expect(plan.display).toContain(" ");
    expect(plan.display.endsWith(".")).toBe(true);
    // None of the candidate words appear in the masked display.
    expect(plan.display).not.toContain("brown");
    expect(plan.display).not.toContain("jumps");
  });

  it("reveals keywords progressively in passage order across steps", () => {
    const plan1 = buildRecitationHintPlan(passage, 1);
    const plan2 = buildRecitationHintPlan(passage, 2);
    expect(plan1.revealedKeywords).toBeGreaterThan(0);
    expect(plan2.revealedKeywords).toBeGreaterThan(plan1.revealedKeywords);
    // Anything revealed at step 1 must still be revealed at step 2
    // (reveals are cumulative).
    const wordsAtStep1 = plan1.display
      .split(/\s+/)
      .filter((w) => w && !w.includes(MASK));
    for (const w of wordsAtStep1) {
      expect(plan2.display).toContain(w);
    }
  });

  it("fully reveals all keywords at the final step", () => {
    const totalSteps = buildRecitationHintPlan(passage, 0).totalSteps;
    const finalPlan = buildRecitationHintPlan(passage, totalSteps);
    expect(finalPlan.revealedKeywords).toBe(finalPlan.totalKeywords);
  });

  it("clamps revealedKeywords if step count exceeds totalSteps", () => {
    const totalSteps = buildRecitationHintPlan(passage, 0).totalSteps;
    const overshoot = buildRecitationHintPlan(passage, totalSteps + 5);
    expect(overshoot.revealedKeywords).toBe(overshoot.totalKeywords);
  });

  it("scales pacing: short passages get fewer per-tap reveals than long ones", () => {
    const shortPlan = buildRecitationHintPlan("Cats nap a lot.", 0);
    const longPassage = Array.from({ length: 30 })
      .map(
        () =>
          "The persistent traveler carefully documented every single observation today.",
      )
      .join(" ");
    const longPlan = buildRecitationHintPlan(longPassage, 0);
    expect(shortPlan.keywordsPerStep).toBeLessThanOrEqual(
      longPlan.keywordsPerStep,
    );
    expect(shortPlan.totalSteps).toBeLessThanOrEqual(longPlan.totalSteps);
    // Long passages cap at 8 steps so they never balloon.
    expect(longPlan.totalSteps).toBeLessThanOrEqual(8);
  });

  it("falls back to short words when nothing is >= 3 chars", () => {
    const plan = buildRecitationHintPlan("Hi to me", 1);
    expect(plan.totalKeywords).toBeGreaterThan(0);
  });
});

describe("buildRecitationHintPlan (CJK)", () => {
  const short = "今天天气很好。";
  const long = "今天天气很好，".repeat(20);

  it("masks ideographs but keeps punctuation visible", () => {
    const plan = buildRecitationHintPlan(short, 0);
    expect(plan.totalKeywords).toBeGreaterThan(0);
    // Punctuation is preserved.
    expect(plan.display).toContain("。");
    // Original ideographs are not present at step 0.
    expect(plan.display).not.toContain("今");
  });

  it("reveals more characters at later steps", () => {
    const plan1 = buildRecitationHintPlan(short, 1);
    const plan2 = buildRecitationHintPlan(short, plan1.totalSteps);
    expect(plan2.revealedKeywords).toBeGreaterThanOrEqual(
      plan1.revealedKeywords,
    );
    expect(plan2.revealedKeywords).toBe(plan2.totalKeywords);
  });

  it("samples evenly across long CJK passages instead of revealing only a prefix", () => {
    const plan = buildRecitationHintPlan(long, 0);
    // Hard cap is 32 candidates regardless of passage length.
    expect(plan.totalKeywords).toBeLessThanOrEqual(32);
    // Step cap also applies.
    expect(plan.totalSteps).toBeLessThanOrEqual(8);
  });
});
