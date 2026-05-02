import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { AnnotatedText, type Annotation } from "@/components/AnnotatedText";

afterEach(() => {
  cleanup();
});

function renderAnnotated(annotations: Annotation[]) {
  return render(
    <AnnotatedText title="Test" annotations={annotations} />
  );
}

describe("AnnotatedText", () => {
  describe("Latin script (with spacing)", () => {
    it("renders all four statuses with leading spaces between words", () => {
      const annotations: Annotation[] = [
        { word: "Hello", status: "ok" },
        { word: "wrold", status: "wrong", correct: "world" },
        { word: "the", status: "missed" },
        { word: "umm", status: "extra" },
      ];
      const { container } = renderAnnotated(annotations);
      expect(container.firstChild).toMatchSnapshot();
    });

    it("renders the ok-only Latin baseline", () => {
      const { container } = renderAnnotated([
        { word: "Good", status: "ok" },
        { word: "morning", status: "ok" },
      ]);
      expect(container.firstChild).toMatchSnapshot();
    });

    it("renders a single wrong token with its correction inline", () => {
      const { container } = renderAnnotated([
        { word: "teh", status: "wrong", correct: "the" },
      ]);
      expect(container.firstChild).toMatchSnapshot();
    });

    it("renders a single missed token", () => {
      const { container } = renderAnnotated([
        { word: "skipped", status: "missed" },
      ]);
      expect(container.firstChild).toMatchSnapshot();
    });

    it("renders a single extra token", () => {
      const { container } = renderAnnotated([
        { word: "uhh", status: "extra" },
      ]);
      expect(container.firstChild).toMatchSnapshot();
    });
  });

  describe("CJK script (without spacing)", () => {
    it("renders all four statuses without inserting spaces between CJK tokens", () => {
      const annotations: Annotation[] = [
        { word: "你好", status: "ok" },
        { word: "世届", status: "wrong", correct: "世界" },
        { word: "的", status: "missed" },
        { word: "啊", status: "extra" },
      ];
      const { container } = renderAnnotated(annotations);
      expect(container.firstChild).toMatchSnapshot();
    });

    it("renders the ok-only CJK baseline", () => {
      const { container } = renderAnnotated([
        { word: "今天", status: "ok" },
        { word: "天气", status: "ok" },
        { word: "很好", status: "ok" },
      ]);
      expect(container.firstChild).toMatchSnapshot();
    });
  });

  describe("fallback rendering", () => {
    it("falls back to plain text when annotations are null", () => {
      const { container } = render(
        <AnnotatedText
          title="Fallback"
          annotations={null}
          fallbackText="Plain text fallback"
        />
      );
      expect(container.firstChild).toMatchSnapshot();
    });

    it("renders the empty placeholder when neither annotations nor fallback are provided", () => {
      const { container } = render(
        <AnnotatedText
          title="Empty"
          annotations={null}
          emptyText="No data"
        />
      );
      expect(container.firstChild).toMatchSnapshot();
    });

    it("renders nothing when there is no annotations, fallback, or empty text", () => {
      const { container } = render(
        <AnnotatedText title="Nothing" annotations={null} />
      );
      expect(container.firstChild).toBeNull();
    });
  });
});
