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
  // Split keeping whitespace as separate tokens so we can re-join
  // verbatim. Tokens that contain at least one letter / digit are
  // candidate "words"; everything else (punct, whitespace) renders as-is.
  const tokens = text.split(/(\s+)/);
  const wordTokenIndices: { idx: number; len: number }[] = [];
  tokens.forEach((tok, idx) => {
    if (/[\p{L}\p{N}]/u.test(tok) && tok.length > ALWAYS_REVEAL_MAX_LEN) {
      wordTokenIndices.push({ idx, len: tok.length });
    }
  });

  // Sort by length desc, then by original position asc so longest
  // words are revealed first and ties resolve left-to-right.
  const ordered = [...wordTokenIndices].sort((a, b) =>
    b.len !== a.len ? b.len - a.len : a.idx - b.idx,
  );
  const revealSet = new Set(
    ordered.slice(0, Math.max(0, revealCount)).map((x) => x.idx),
  );

  const display = tokens
    .map((tok, idx) => {
      if (!/[\p{L}\p{N}]/u.test(tok)) return tok; // whitespace / punct
      if (tok.length <= ALWAYS_REVEAL_MAX_LEN) return tok; // trivial words
      if (revealSet.has(idx)) return tok;
      return maskFor(tok);
    })
    .join("");

  return { display, totalHintable: wordTokenIndices.length };
}

function buildCjkMask(text: string, revealCount: number): HintMaskResult {
  const chars = Array.from(text);
  const hintableIndices: number[] = [];
  chars.forEach((c, i) => {
    if (CJK_RE.test(c)) hintableIndices.push(i);
  });

  // For CJK we reveal left-to-right (sequential reading order) so the
  // user gets a coherent prefix of the sentence rather than scattered
  // characters across the line.
  const revealSet = new Set(
    hintableIndices.slice(0, Math.max(0, revealCount)),
  );

  const display = chars
    .map((c, i) => {
      if (!CJK_RE.test(c)) return c;
      if (revealSet.has(i)) return c;
      return MASK_CHAR;
    })
    .join("");

  return { display, totalHintable: hintableIndices.length };
}

export function buildDictationHintMask(
  text: string,
  revealCount: number,
): HintMaskResult {
  if (!text) return { display: "", totalHintable: 0 };
  if (isCjkText(text)) return buildCjkMask(text, revealCount);
  return buildLatinMask(text, revealCount);
}
