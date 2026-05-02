import { describe, it, expect } from "vitest";
import { getContentDirection, rtlTextStyle } from "@/utils/rtl";

describe("getContentDirection", () => {
  it("returns ltr for empty/nullish input", () => {
    expect(getContentDirection("")).toBe("ltr");
    expect(getContentDirection(null)).toBe("ltr");
    expect(getContentDirection(undefined)).toBe("ltr");
  });

  it("returns ltr for plain English", () => {
    expect(getContentDirection("Hello, world!")).toBe("ltr");
    expect(getContentDirection("The quick brown fox jumps over the lazy dog.")).toBe("ltr");
  });

  it("returns ltr for digits / punctuation / whitespace only", () => {
    expect(getContentDirection("12345")).toBe("ltr");
    expect(getContentDirection("   ... !!! ")).toBe("ltr");
  });

  it("returns ltr for Arabic punctuation only (no letters)", () => {
    // ،؛؟ are Arabic punctuation; they live in the Arabic block but
    // shouldn't, by themselves, force the surrounding text to RTL.
    expect(getContentDirection("،؛؟")).toBe("ltr");
    expect(getContentDirection("؟ 123 !")).toBe("ltr");
  });

  it("returns rtl for pure Arabic text", () => {
    expect(getContentDirection("مرحبا بالعالم")).toBe("rtl");
  });

  it("returns rtl for Arabic mixed with punctuation/numbers", () => {
    expect(getContentDirection("مرحبا، 2026!")).toBe("rtl");
  });

  it("returns rtl for pure Hebrew text", () => {
    expect(getContentDirection("שלום עולם")).toBe("rtl");
  });

  it("keeps an English paragraph with a single Arabic word as ltr", () => {
    expect(
      getContentDirection("The Arabic word for hello is مرحبا and it is common.")
    ).toBe("ltr");
  });

  it("flips to rtl when Arabic dominates over a stray English word", () => {
    expect(getContentDirection("مرحبا بكم في تطبيق Audial اليوم")).toBe("rtl");
  });
});

describe("rtlTextStyle", () => {
  it("returns undefined for ltr text", () => {
    expect(rtlTextStyle("Hello")).toBeUndefined();
    expect(rtlTextStyle("")).toBeUndefined();
    expect(rtlTextStyle(null)).toBeUndefined();
  });

  it("returns rtl style for arabic text", () => {
    expect(rtlTextStyle("مرحبا")).toEqual({
      writingDirection: "rtl",
      textAlign: "right",
    });
  });
});
