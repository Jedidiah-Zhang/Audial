import type { ContentType } from "@/types";

const SPEAKER_LINE = /^\s*([A-Z][\w\u4e00-\u9fff'’.\- ]{0,24}|[\u4e00-\u9fff]{1,8})\s*[:：]\s*\S/;
const DASH_TURN = /^\s*[-–—]\s+\S/;

export function detectContentType(text: string): ContentType {
  if (!text) return "general";
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "general";

  // Dialogue detection: at least 2 lines that look like turns
  const speakerLines = lines.filter((l) => SPEAKER_LINE.test(l));
  if (speakerLines.length >= 2 && speakerLines.length / lines.length >= 0.5) {
    return "dialogue";
  }
  const dashLines = lines.filter((l) => DASH_TURN.test(l));
  if (dashLines.length >= 2 && dashLines.length / lines.length >= 0.6) {
    return "dialogue";
  }

  // News detection: 2+ paragraphs separated by blank lines, fairly long
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
    // Continuation line — append to previous turn if exists
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
