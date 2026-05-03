/**
 * Builds a progressively-revealed keyword "hint" for the recitation
 * stage. Tapping the hint reveals one more `step` worth of keywords;
 * keywords appear in their original order within the passage and
 * unrevealed text renders as a placeholder so the learner can see the
 * structure of the passage but not the full text.
 *
 * Selection strategy:
 *   - For Latin / Cyrillic / etc. text: split on whitespace + punctuation,
 *     then pick the longest "content" words (length >= 3) as keyword
 *     candidates. Falls back to ALL words if a passage is mostly
 *     short/function words. Render order is left-to-right (passage
 *     order), independent of the length-based selection.
 *   - For CJK text (no whitespace): treat each ideograph as a candidate.
 *     For long passages, sample evenly across the passage so the
 *     learner gets keyword anchors spread through the whole text rather
 *     than just a coherent prefix.
 *
 * Pacing strategy:
 *   - Total candidate count → bucketed number of reveal `steps`.
 *   - keywordsPerStep = ceil(totalKeywords / totalSteps).
 *   - Short passages get 1-2 steps with a couple of keywords each;
 *     long passages stretch hints over up to 8 steps, each revealing
 *     more keywords, so the pacing feels right at any length.
 */

const MASK_CHAR = "▁";
const MAX_MASK_LEN = 6;
const MIN_MASK_LEN = 2;

// Same CJK detection range as utils/dictationHint.ts — covers CJK
// unified ideographs, hiragana/katakana, and hangul syllables.
const CJK_RE = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;

// Hard cap on candidate keywords so very long passages still fit a
// reasonable number of taps. With max 8 steps, this keeps the
// per-step reveal bounded too.
const LATIN_CANDIDATE_CAP = 48;
const CJK_CANDIDATE_CAP = 32;
const MIN_LATIN_KEYWORD_LEN = 3;

export interface RecitationHintPlan {
  /** Display string with revealed keywords in place and the rest masked. */
  display: string;
  /** Total keywords that will ever be revealed across all steps. */
  totalKeywords: number;
  /** Total number of reveal steps available before the cap is hit. */
  totalSteps: number;
  /** How many keywords each tap reveals. */
  keywordsPerStep: number;
  /** How many keywords are currently revealed (clamped to totalKeywords). */
  revealedKeywords: number;
}

export function isCjkText(text: string): boolean {
  return CJK_RE.test(text);
}

/**
 * Maps a candidate count to a (steps, perStep) pair. Buckets are
 * tuned so:
 *   - 1-3 candidates → reveal one at a time (1-3 steps)
 *   - small / medium passages → 2-4 steps, ~2-4 keywords per tap
 *   - large passages → up to 8 steps, scaling per-step reveal upward
 * The function is exported for unit testing.
 */
export function pacingFor(candidates: number): {
  steps: number;
  perStep: number;
} {
  if (candidates <= 0) return { steps: 0, perStep: 0 };
  let steps: number;
  if (candidates <= 3) steps = candidates;
  else if (candidates <= 8) steps = 2;
  else if (candidates <= 16) steps = 4;
  else if (candidates <= 32) steps = 6;
  else steps = 8;
  const perStep = Math.max(1, Math.ceil(candidates / steps));
  return { steps, perStep };
}

function maskFor(token: string): string {
  const len = Math.min(token.length, MAX_MASK_LEN);
  return MASK_CHAR.repeat(Math.max(MIN_MASK_LEN, len));
}

function buildLatinPlan(
  text: string,
  stepsRevealed: number,
): RecitationHintPlan {
  // Tokenise into word runs / whitespace runs / punctuation runs so
  // we can mask only the word content while keeping spaces and
  // punctuation visible (preserves passage structure).
  const tokens = text.match(/[\p{L}\p{N}'’\-]+|\s+|[^\p{L}\p{N}\s]+/gu) ?? [];
  const isWord = (tok: string) => /[\p{L}\p{N}]/u.test(tok);

  const longWords: { idx: number; len: number }[] = [];
  const allWords: { idx: number; len: number }[] = [];
  tokens.forEach((tok, idx) => {
    if (!isWord(tok)) return;
    allWords.push({ idx, len: tok.length });
    if (tok.length >= MIN_LATIN_KEYWORD_LEN) {
      longWords.push({ idx, len: tok.length });
    }
  });

  // Prefer longer words as keyword candidates (more meaningful as a
  // memory anchor); fall back to all words if the passage is too
  // short / too function-word-heavy to have any "long" candidates.
  const pool = longWords.length > 0 ? longWords : allWords;
  const ordered = [...pool].sort((a, b) =>
    b.len !== a.len ? b.len - a.len : a.idx - b.idx,
  );
  const eligible = ordered.slice(0, Math.min(LATIN_CANDIDATE_CAP, ordered.length));
  // Render-order: candidates appear in passage order (left-to-right),
  // independent of the length-ranked selection above.
  const candidateIdxs = eligible.map((x) => x.idx).sort((a, b) => a - b);

  const totalKeywords = candidateIdxs.length;
  const { steps, perStep } = pacingFor(totalKeywords);
  const revealedKeywords = Math.min(
    totalKeywords,
    Math.max(0, stepsRevealed) * perStep,
  );
  const revealedSet = new Set(candidateIdxs.slice(0, revealedKeywords));

  const display = tokens
    .map((tok, idx) => {
      if (!isWord(tok)) return tok;
      if (revealedSet.has(idx)) return tok;
      return maskFor(tok);
    })
    .join("");

  return {
    display,
    totalKeywords,
    totalSteps: steps,
    keywordsPerStep: perStep,
    revealedKeywords,
  };
}

function buildCjkPlan(
  text: string,
  stepsRevealed: number,
): RecitationHintPlan {
  const chars = Array.from(text);
  const hintableIndices: number[] = [];
  chars.forEach((c, i) => {
    if (CJK_RE.test(c)) hintableIndices.push(i);
  });

  // For long CJK passages, sample evenly across the passage so the
  // learner gets keyword anchors spread throughout rather than just a
  // coherent prefix.
  let candidateIdxs: number[];
  if (hintableIndices.length <= CJK_CANDIDATE_CAP) {
    candidateIdxs = [...hintableIndices];
  } else {
    const stride = hintableIndices.length / CJK_CANDIDATE_CAP;
    candidateIdxs = [];
    for (let i = 0; i < CJK_CANDIDATE_CAP; i++) {
      candidateIdxs.push(hintableIndices[Math.floor(i * stride)]);
    }
  }

  const totalKeywords = candidateIdxs.length;
  const { steps, perStep } = pacingFor(totalKeywords);
  const revealedKeywords = Math.min(
    totalKeywords,
    Math.max(0, stepsRevealed) * perStep,
  );
  const revealedSet = new Set(candidateIdxs.slice(0, revealedKeywords));

  const display = chars
    .map((c, i) => {
      if (!CJK_RE.test(c)) return c;
      if (revealedSet.has(i)) return c;
      return MASK_CHAR;
    })
    .join("");

  return {
    display,
    totalKeywords,
    totalSteps: steps,
    keywordsPerStep: perStep,
    revealedKeywords,
  };
}

export function buildRecitationHintPlan(
  text: string,
  stepsRevealed: number,
): RecitationHintPlan {
  if (!text) {
    return {
      display: "",
      totalKeywords: 0,
      totalSteps: 0,
      keywordsPerStep: 0,
      revealedKeywords: 0,
    };
  }
  if (isCjkText(text)) return buildCjkPlan(text, stepsRevealed);
  return buildLatinPlan(text, stepsRevealed);
}
