import type { ContentType } from "@/types";

const SPEAKER_LINE = /^\s*([A-Z][\w\u4e00-\u9fff'’.\- ]{0,24}|[\u4e00-\u9fff]{1,8})\s*[:：]\s*\S/;
const DASH_TURN = /^\s*[-–—]\s+\S/;

const ALL_TYPES: ContentType[] = [
  "dialogue",
  "news",
  "email",
  "letter",
  "speech",
  "story",
  "essay",
  "general",
];

export function isContentType(value: unknown): value is ContentType {
  return typeof value === "string" && (ALL_TYPES as string[]).includes(value);
}

/**
 * Heuristic fallback used only when the model didn't return a contentType
 * (e.g. older saved texts or manually-entered text). Uses content-based
 * cues in addition to format cues.
 */
export function detectContentType(text: string): ContentType {
  if (!text) return "general";
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "general";

  const lowered = text.toLowerCase();

  // Email — explicit headers or sign-offs typical of emails
  if (
    /\b(from|to|subject|cc|bcc)\s*:/i.test(text) ||
    /\b(hi|hey|hello)\s+[A-Z][\w-]+\s*,/.test(text) ||
    /\b(best( regards)?|cheers|thanks(,| in advance)|kind regards|sent from my)\b/i.test(lowered)
  ) {
    return "email";
  }

  // Letter — formal salutation + closing
  if (
    /\bdear\s+[\w. ]+,/i.test(text) &&
    /\b(sincerely|yours truly|yours faithfully|with regards|warm regards|respectfully)\b/i.test(lowered)
  ) {
    return "letter";
  }

  // Speech — address to an audience, rhetorical openers
  if (
    /\b(ladies and gentlemen|my fellow|good (morning|afternoon|evening) (everyone|all|colleagues))\b/i.test(lowered) ||
    /\b(thank you (all|so much)|today (i (want|would like) to|we gather|we are here))\b/i.test(lowered)
  ) {
    return "speech";
  }

  // News — third-person reporting cues
  if (
    /\b(reuters|associated press|according to (officials|sources|the report)|reported (today|on|that)|spokesperson)\b/i.test(lowered)
  ) {
    return "news";
  }

  // Dialogue — format-based fallback
  const speakerLines = lines.filter((l) => SPEAKER_LINE.test(l));
  if (speakerLines.length >= 2 && speakerLines.length / lines.length >= 0.5) {
    return "dialogue";
  }
  const dashLines = lines.filter((l) => DASH_TURN.test(l));
  if (dashLines.length >= 2 && dashLines.length / lines.length >= 0.6) {
    return "dialogue";
  }

  // Story — narrative cues
  if (
    /\b(once upon a time|one day,|long ago)\b/i.test(lowered) ||
    /["“][^"”]+["”]\s*,?\s*(he|she|they|i)\s+(said|asked|whispered|replied)/i.test(text)
  ) {
    return "story";
  }

  // News (format-based): multiple paragraphs and lengthy
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length >= 2 && text.length >= 200) {
    return "news";
  }

  return "general";
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
  news: { label: "新闻", icon: "file-text", showBadge: true },
  email: { label: "邮件", icon: "mail", showBadge: true },
  letter: { label: "信件", icon: "edit-3", showBadge: true },
  speech: { label: "演讲稿", icon: "mic", showBadge: true },
  story: { label: "故事", icon: "book-open", showBadge: true },
  essay: { label: "随笔", icon: "feather", showBadge: true },
  general: { label: "文本", icon: "type", showBadge: false },
};
