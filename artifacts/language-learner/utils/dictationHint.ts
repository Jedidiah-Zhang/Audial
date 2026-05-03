/**
 * Builds a partially-revealed mask of the dictation target text. Each
 * "use a hint" reveals one more difficult word (or character, for CJK
 * scripts), so `revealCount` grows monotonically with hint usage.
 *
 * Reveal strategy:
 *   - For Latin / Cyrillic / etc. text: split on whitespace, then
 *     reveal the longest words first. Punctuation and whitespace are
 *     always shown as-is. Already-shown short words (length ≤ 2) are
 *     never masked since revealing them carries no information.
 *   - For CJK text (no whitespace): treat each ideograph as a "word"
 *     and reveal them in left-to-right order so users get a coherent
 *     first chunk of the sentence. Non-ideograph chars (punctuation,
 *     spaces, ASCII) always render as-is.
 *
 * The mask uses the unicode "low one eighth block" `▁` repeated to
 * roughly match the masked word's length. We cap mask length at 6 so
 * a single very long word doesn't dominate the layout.
 */

const MASK_CHAR = "▁";
const MAX_MASK_LEN = 6;
const ALWAYS_REVEAL_MAX_LEN = 2;

// Per-sentence cap on hintable tokens. Spec: "按比例、至少 1 个、至多 3 个"
// — roughly 20% of the candidate tokens, floored to 1 and ceilinged to 3.
// This keeps short sentences from leaking the entire answer once a Pro
// user starts requesting hints.
const HINT_PROPORTION = 0.2;
const HINT_MIN_PER_SENTENCE = 1;
const HINT_MAX_PER_SENTENCE = 3;

function capHintable(candidateCount: number): number {
  if (candidateCount <= 0) return 0;
  const proportional = Math.ceil(candidateCount * HINT_PROPORTION);
  return Math.max(
    HINT_MIN_PER_SENTENCE,
    Math.min(HINT_MAX_PER_SENTENCE, proportional),
  );
}

const CJK_RE = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;

export interface HintMaskResult {
  /** Display string with revealed tokens shown and others masked. */
  display: string;
  /** Total hintable tokens — the cap at which further hints reveal nothing new. */
  totalHintable: number;
}

export function isCjkText(text: string): boolean {
  return CJK_RE.test(text);
}

function maskFor(token: string): string {
  const len = Math.min(token.length, MAX_MASK_LEN);
  return MASK_CHAR.repeat(Math.max(2, len));
}

function buildLatinMask(text: string, revealCount: number): HintMaskResult {
  // Tokenise into three flavours:
  //   - word runs (letters / digits / common intra-word punctuation)
  //   - whitespace runs
  //   - everything else (punctuation, symbols)
  // Splitting words OUT of attached punctuation matters for the hint
  // mask: "word," should mask only the letters and keep the comma
  // visible so the structure of the sentence is preserved.
  const tokens = text.match(/[\p{L}\p{N}'’\-]+|\s+|[^\p{L}\p{N}\s]+/gu) ?? [];
  const isWord = (tok: string) => /[\p{L}\p{N}]/u.test(tok);

  // Long-word candidates first; if a sentence is composed entirely of
  // short words (≤ 2 chars), fall back to ALL word tokens so the spec's
  // "at least 1" reveal guarantee still holds.
  const longWords: { idx: number; len: number }[] = [];
  const allWords: { idx: number; len: number }[] = [];
  tokens.forEach((tok, idx) => {
    if (!isWord(tok)) return;
    allWords.push({ idx, len: tok.length });
    if (tok.length > ALWAYS_REVEAL_MAX_LEN) {
      longWords.push({ idx, len: tok.length });
    }
  });
  const candidates = longWords.length > 0 ? longWords : allWords;
  const shortFallback = longWords.length === 0;

  // Sort by length desc, then by original position asc so longest
  // words are revealed first and ties resolve left-to-right.
  const ordered = [...candidates].sort((a, b) =>
    b.len !== a.len ? b.len - a.len : a.idx - b.idx,
  );
  const cap = capHintable(candidates.length);
  // Only the top-`cap` longest words are eligible to be revealed via
  // hints; further hints reveal nothing new (and the UI will disable
  // the button before letting the user spend quota on them).
  const eligible = ordered.slice(0, cap);
  const eligibleSet = new Set(eligible.map((x) => x.idx));
  const revealSet = new Set(
    eligible.slice(0, Math.max(0, revealCount)).map((x) => x.idx),
  );

  const display = tokens
    .map((tok, idx) => {
      if (!isWord(tok)) return tok; // whitespace / punct stays visible
      if (revealSet.has(idx)) return tok;
      // Trivial short words are normally always shown — but in the
      // short-only fallback branch they ARE the candidates, so respect
      // the eligible set: anything not eligible still renders as-is.
      if (!shortFallback && tok.length <= ALWAYS_REVEAL_MAX_LEN) return tok;
      if (shortFallback && !eligibleSet.has(idx)) return tok;
      return maskFor(tok);
    })
    .join("");

  return { display, totalHintable: cap };
}

function buildCjkMask(text: string, revealCount: number): HintMaskResult {
  const chars = Array.from(text);
  const hintableIndices: number[] = [];
  chars.forEach((c, i) => {
    if (CJK_RE.test(c)) hintableIndices.push(i);
  });

  const cap = capHintable(hintableIndices.length);
  // For CJK we reveal left-to-right (sequential reading order) so the
  // user gets a coherent prefix of the sentence rather than scattered
  // characters across the line, capped at the per-sentence proportion.
  const eligible = hintableIndices.slice(0, cap);
  const revealSet = new Set(eligible.slice(0, Math.max(0, revealCount)));

  const display = chars
    .map((c, i) => {
      if (!CJK_RE.test(c)) return c;
      if (revealSet.has(i)) return c;
      return MASK_CHAR;
    })
    .join("");

  return { display, totalHintable: cap };
}

export function buildDictationHintMask(
  text: string,
  revealCount: number,
): HintMaskResult {
  if (!text) return { display: "", totalHintable: 0 };
  if (isCjkText(text)) return buildCjkMask(text, revealCount);
  return buildLatinMask(text, revealCount);
}
