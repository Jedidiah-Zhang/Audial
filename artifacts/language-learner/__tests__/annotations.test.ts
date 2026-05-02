import { describe, it, expect } from "vitest";
import { sanitizeAnnotations } from "@/utils/annotations";

describe("sanitizeAnnotations", () => {
  it("returns null for non-array input", () => {
    expect(sanitizeAnnotations(null)).toBeNull();
    expect(sanitizeAnnotations(undefined)).toBeNull();
    expect(sanitizeAnnotations("nope")).toBeNull();
    expect(sanitizeAnnotations({ word: "x", status: "ok" })).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(sanitizeAnnotations([])).toBeNull();
  });

  it("accepts a well-formed input and preserves the optional `correct` field", () => {
    const out = sanitizeAnnotations([
      { word: "Hello", status: "ok" },
      { word: "wrold", status: "wrong", correct: "world" },
    ]);
    expect(out).toEqual([
      { word: "Hello", status: "ok" },
      { word: "wrold", status: "wrong", correct: "world" },
    ]);
  });

  it("drops malformed entries but keeps the well-formed ones", () => {
    const out = sanitizeAnnotations([
      null,
      "not an object",
      { word: 42, status: "ok" },
      { word: "good", status: "ok" },
      { word: "bad-status", status: "exploded" },
      { status: "ok" },
      { word: "world", status: "wrong", correct: "" },
    ]);
    expect(out).toEqual([
      { word: "good", status: "ok" },
      { word: "world", status: "wrong" },
    ]);
  });

  it("returns null when every entry is malformed", () => {
    const out = sanitizeAnnotations([
      { word: 1, status: "ok" },
      { word: "x", status: "weird" },
      "string",
    ]);
    expect(out).toBeNull();
  });

  it("accepts annotations whose length ratio is inside the [0.6, 1.6] bounds", () => {
    const expected = "the quick brown fox jumps over the lazy dog";
    const annotations = [
      { word: "the", status: "ok" },
      { word: "quick", status: "ok" },
      { word: "brown", status: "ok" },
      { word: "fox", status: "ok" },
      { word: "jumps", status: "ok" },
      { word: "over", status: "ok" },
      { word: "the", status: "ok" },
      { word: "lazy", status: "ok" },
      { word: "dog", status: "ok" },
    ];
    const out = sanitizeAnnotations(annotations, expected);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(annotations.length);
  });

  it("returns null when annotated content is far shorter than expected (ratio < 0.6)", () => {
    const expected = "the quick brown fox jumps over the lazy dog";
    // Concatenated annotation length ~ 6 chars vs expected ~35 → ratio ≈ 0.17
    const out = sanitizeAnnotations(
      [{ word: "the", status: "ok" }, { word: "fox", status: "ok" }],
      expected
    );
    expect(out).toBeNull();
  });

  it("returns null when annotated content is far longer than expected (ratio > 1.6)", () => {
    const expected = "hi";
    const out = sanitizeAnnotations(
      [
        { word: "hello", status: "ok" },
        { word: "world", status: "ok" },
        { word: "again", status: "ok" },
      ],
      expected
    );
    expect(out).toBeNull();
  });

  it("excludes 'extra' tokens from the length-ratio computation", () => {
    const expected = "hello world";
    // Without the exclusion these would push the ratio well above 1.6
    // (~22 / 10 ≈ 2.2). Excluding `extra` brings it back to ~1.0.
    const out = sanitizeAnnotations(
      [
        { word: "hello", status: "ok" },
        { word: "world", status: "ok" },
        { word: "extraneous", status: "extra" },
        { word: "padding", status: "extra" },
      ],
      expected
    );
    expect(out).not.toBeNull();
    expect(out!.map((a) => a.word)).toEqual([
      "hello",
      "world",
      "extraneous",
      "padding",
    ]);
  });

  it("returns the annotations unchanged when expectedText is empty", () => {
    const out = sanitizeAnnotations(
      [{ word: "anything", status: "ok" }],
      ""
    );
    expect(out).toEqual([{ word: "anything", status: "ok" }]);
  });

  it("ignores whitespace and case when comparing lengths", () => {
    const expected = "  Hello  World  ";
    const out = sanitizeAnnotations(
      [
        { word: "hello", status: "ok" },
        { word: "world", status: "ok" },
      ],
      expected
    );
    expect(out).not.toBeNull();
  });
});
