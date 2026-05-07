import type { ContentType } from "@/types";

const SPEAKER_LINE = /^\s*([A-Z][\w\u4e00-\u9fff'’.\- ]{0,24}|[\u4e00-\u9fff]{1,8})\s*[:：]\s*\S/;
const DASH_TURN = /^\s*[-–—]\s+\S/;

const ALL_TYPES: ContentType[] = [
  "dialogue",
  "story",
  "speech",
  "info",
];

export function isContentType(value: unknown): value is ContentType {
  return typeof value === "string" && (ALL_TYPES as string[]).includes(value);
}

const OLD_TO_NEW: Record<string, ContentType> = {
  news: "info",
  email: "info",
  letter: "info",
  essay: "speech",
  general: "info",
};

/** Normalize a contentType value from storage (which may be an old type) into a current one. */
export function normalizeContentType(raw: string | null | undefined): ContentType {
  if (isContentType(raw)) return raw;
  if (typeof raw === "string" && raw in OLD_TO_NEW) return OLD_TO_NEW[raw];
  return "info";
}

/**
 * Heuristic fallback used only when the model didn't return a contentType
 * (e.g. older saved texts or manually-entered text). Uses content-based
 * cues in addition to format cues.
 */
export function detectContentType(text: string): ContentType {
  if (!text) return "info";
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "info";

  const lowered = text.toLowerCase();

  // Dialogue — speaker-line format cues
  const speakerLines = lines.filter((l) => SPEAKER_LINE.test(l));
  if (speakerLines.length >= 2 && speakerLines.length / lines.length >= 0.5) {
    return "dialogue";
  }
  const dashLines = lines.filter((l) => DASH_TURN.test(l));
  if (dashLines.length >= 2 && dashLines.length / lines.length >= 0.6) {
    return "dialogue";
  }

  // Speech — audience address or rhetorical openers
  if (
    /\b(ladies and gentlemen|my fellow|good (morning|afternoon|evening) (everyone|all|colleagues|friends))\b/i.test(lowered) ||
    /\b(thank you (all|so much|for being here)|today (i (want|would like) to|we gather|we are here))\b/i.test(lowered)
  ) {
    return "speech";
  }

  // Story — narrative opening cues
  if (
    /\b(once upon a time|one day,|long ago|there (once )?lived|many years ago)\b/i.test(lowered) ||
    /[“”][^””]+[“”]\s*,?\s*(he|she|they|i)\s+(said|asked|whispered|replied)/i.test(text)
  ) {
    return "story";
  }

  return "info";
}

export interface DialogueTurn {
  speaker: string;
  utterance: string;
}

export function parseDialogue(text: string): DialogueTurn[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const turns: DialogueTurn[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*([^:：\-–—]{1,30})\s*[:：]\s*(.+)$/);
    if (m) {
      turns.push({ speaker: m[1].trim(), utterance: m[2].trim() });
      continue;
    }
    const dashMatch = line.match(/^\s*[-–—]\s+(.+)$/);
    if (dashMatch) {
      const speaker = turns.length % 2 === 0 ? "A" : "B";
      turns.push({ speaker, utterance: dashMatch[1].trim() });
      continue;
    }
    if (turns.length > 0) {
      turns[turns.length - 1].utterance += " " + line;
    } else {
      turns.push({ speaker: "·", utterance: line });
    }
  }
  return turns;
}

export function parseParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim().replace(/\s*\n\s*/g, " "))
    .filter(Boolean);
}

export const CONTENT_TYPE_META: Record<
  ContentType,
  { label: string; icon: string; showBadge: boolean }
> = {
  dialogue: { label: "对话", icon: "message-circle", showBadge: true },
  story: { label: "故事", icon: "book-open", showBadge: true },
  speech: { label: "演讲", icon: "mic", showBadge: true },
  info: { label: "信息", icon: "file-text", showBadge: true },
};
