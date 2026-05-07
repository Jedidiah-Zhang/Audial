import type { ContentType } from "@/types";
import { detectContentType, normalizeContentType, parseDialogue, parseParagraphs } from "@/utils/contentType";

/**
 * Split a single block of text into sentences. Handles common Western and CJK
 * terminators plus the Arabic question mark, and preserves trailing closing
 * quotes / brackets.
 */
export function splitSentences(text: string): string[] {
  if (!text) return [];
  const matches = text.match(
    /[^.!?。！？؟\n]+[.!?。！？؟]+["'”’」』）)]*|[^.!?。！？؟\n]+/g
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

/**
 * Build a structured sentence layout for the given text. Mirrors the logic
 * SentenceArticle uses internally so any consumer (e.g. ShadowSentenceFlow)
 * gets the exact same flat sentence ordering.
 */
export function buildSentenceLayout(
  text: string,
  contentType?: ContentType
): SentenceLayout {
  const effectiveType: ContentType = contentType ? normalizeContentType(contentType) : detectContentType(text);
  if (effectiveType === "dialogue") {
    const turns = parseDialogue(text);
    const groups: DialogueGroup[] = turns.map((t) => ({
      speaker: t.speaker,
      sentences: splitSentences(t.utterance),
    }));
    return { kind: "dialogue", groups };
  }
  if (effectiveType === "speech") {
    // One sentence per group — rendered like TED subtitles
    const allSentences = splitSentences(text);
    return {
      kind: "sentences",
      groups: allSentences.map((s) => ({ sentences: [s] })),
    };
  }
  const paragraphs = parseParagraphs(text);
  if (paragraphs.length === 0) {
    return {
      kind: "paragraphs",
      groups: [{ sentences: splitSentences(text) }],
    };
  }
  return {
    kind: "paragraphs",
    groups: paragraphs.map((p) => ({ sentences: splitSentences(p) })),
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
