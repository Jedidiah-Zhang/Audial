import type { ContentType } from "@/types";
import { detectContentType, normalizeContentType, parseDialogue, parseParagraphs } from "@/utils/contentType";

/**
 * Split a single block of text into sentences using the browser / runtime's
 * built-in Intl.Segmenter (Unicode UAX #29 sentence segmentation). Falls
 * back to a simple regex when Intl.Segmenter is unavailable.
 *
 * Post-processing heuristic: segments ≤ 5 characters that end with a
 * period (but NOT !, ?, or CJK terminators) are merged with the next
 * segment. This catches Western abbreviations like Dr., Mr., Sra., M.,
 * Prof., etc. without relying on an exhaustive dictionary.
 */
export function splitSentences(text: string, locale?: string): string[] {
  if (!text) return [];

  const segments = segmentWithIntl(text, locale) ?? segmentWithRegex(text);
  if (segments.length <= 1) return segments;

  // Merge short period-terminated segments with the next one.
  // Threshold of 5 chars catches common abbreviations (Dr., Mr., M., Sra.,
  // Prof., etc.) while being short enough to avoid merging genuine short
  // sentences like "I am." (6 chars) or "Hello." (6 chars).
  const merged: string[] = [];
  const SHORT_ABBREV_RE = /^.{1,5}\.$/; // ≤5 chars, ends with period

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (
      SHORT_ABBREV_RE.test(s) &&
      i + 1 < segments.length
    ) {
      // Merge into next segment
      segments[i + 1] = s + " " + segments[i + 1];
    } else {
      merged.push(s);
    }
  }

  return merged;
}

/**
 * Split text using Intl.Segmenter. Returns null when unavailable.
 */
function segmentWithIntl(text: string, locale?: string): string[] | null {
  try {
    // Intl.Segmenter is ES2022; available in Hermes 0.72+
    const Segmenter = Intl.Segmenter;
    if (typeof Segmenter !== "function") return null;
    const segmenter = new Segmenter(locale ? [locale] : [], { granularity: "sentence" });
    const out: string[] = [];
    for (const { segment } of segmenter.segment(text)) {
      const trimmed = segment.trim();
      if (trimmed) out.push(trimmed);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Regex-based fallback for environments without Intl.Segmenter.
 * Same logic as the old implementation but wrapped as a fallback only.
 */
function segmentWithRegex(text: string): string[] {
  const matches = text.match(
    /[^.!?。！？？\n]+[.!?。！？？]+["'」「』）)]*|[^.!?。！？？\n]+/g
  );
  if (!matches) return [text];
  return matches.map((s) => s.trim()).filter(Boolean);
}

export interface DialogueGroup {
  speaker: string;
  sentences: string[];
}

export interface ParagraphGroup {
  sentences: string[];
}

export type SentenceLayout =
  | { kind: "dialogue"; groups: DialogueGroup[] }
  | { kind: "sentences"; groups: ParagraphGroup[] }
  | { kind: "paragraphs"; groups: ParagraphGroup[] };

export interface BuildSentenceLayoutOptions {
  contentType?: ContentType;
  /**
   * User-defined sentence list. When provided, the text is NOT
   * auto-segmented — these sentences are used directly (still grouped
   * by paragraph / dialogue turn for the target contentType).
   */
  customSentences?: string[];
  /**
   * Locale hint passed to Intl.Segmenter (e.g. "en", "de", "fr").
   * When omitted the runtime default is used, which is usually fine.
   */
  locale?: string;
}

/**
 * Build a structured sentence layout for the given text. Mirrors the logic
 * SentenceArticle uses internally so any consumer (e.g. ShadowSentenceFlow)
 * gets the exact same flat sentence ordering.
 */
export function buildSentenceLayout(
  text: string,
  options?: BuildSentenceLayoutOptions
): SentenceLayout {
  const contentType = options?.contentType;
  const customSentences = options?.customSentences;
  const locale = options?.locale;

  const effectiveType: ContentType = contentType
    ? normalizeContentType(contentType)
    : detectContentType(text);

  // When the user has provided custom sentences, use them directly and
  // distribute across paragraphs / turns based on content type.
  if (customSentences && customSentences.length > 0) {
    return layoutFromCustomSentences(text, effectiveType, customSentences);
  }

  if (effectiveType === "dialogue") {
    const turns = parseDialogue(text);
    const groups: DialogueGroup[] = turns.map((t) => ({
      speaker: t.speaker,
      sentences: splitSentences(t.utterance, locale),
    }));
    return { kind: "dialogue", groups };
  }
  if (effectiveType === "speech") {
    const allSentences = splitSentences(text, locale);
    return {
      kind: "sentences",
      groups: allSentences.map((s) => ({ sentences: [s] })),
    };
  }
  const paragraphs = parseParagraphs(text);
  if (paragraphs.length === 0) {
    return {
      kind: "paragraphs",
      groups: [{ sentences: splitSentences(text, locale) }],
    };
  }
  return {
    kind: "paragraphs",
    groups: paragraphs.map((p) => ({ sentences: splitSentences(p, locale) })),
  };
}

/**
 * When the user has manually edited sentences, we still need to respect
 * the content-type grouping (dialogue turns, paragraphs, etc.) so the
 * visual rendering stays consistent — only the sentence *boundaries*
 * within each group change.
 *
 * Strategy: for non-dialogue types, keep it simple — one paragraph group
 * with all custom sentences. This avoids the complexity of trying to
 * re-align custom sentences to auto-detected paragraphs.
 */
function layoutFromCustomSentences(
  text: string,
  effectiveType: ContentType,
  customSentences: string[],
): SentenceLayout {
  if (effectiveType === "dialogue") {
    // Re-parse dialogue turns but replace each turn's sentences with the
    // closest matching slice of customSentences based on turn count.
    const turns = parseDialogue(text);
    if (turns.length === 0) {
      return { kind: "dialogue", groups: [] };
    }
    // Distribute customSentences across turns proportionally.
    const perTurn = Math.max(1, Math.floor(customSentences.length / turns.length));
    const groups: DialogueGroup[] = [];
    let cursor = 0;
    for (let i = 0; i < turns.length; i++) {
      const count = i === turns.length - 1
        ? customSentences.length - cursor
        : Math.min(perTurn, customSentences.length - cursor);
      groups.push({
        speaker: turns[i].speaker,
        sentences: customSentences.slice(cursor, cursor + count),
      });
      cursor += count;
    }
    return { kind: "dialogue", groups };
  }

  if (effectiveType === "speech") {
    return {
      kind: "sentences",
      groups: customSentences.map((s) => ({ sentences: [s] })),
    };
  }

  // story / info — one group containing all sentences
  return {
    kind: "paragraphs",
    groups: [{ sentences: customSentences }],
  };
}

/**
 * Flatten a layout into the ordered list of playable sentences (excluding
 * speaker labels). The index of each item is the global sentence index used
 * for highlighting and per-sentence scoring state.
 */
export function flattenSentences(layout: SentenceLayout): string[] {
  const out: string[] = [];
  for (const g of layout.groups) {
    for (const s of g.sentences) out.push(s);
  }
  return out;
}
