import type { Annotation } from "@/components/AnnotatedText";

const VALID_STATUSES = new Set(["ok", "wrong", "missed", "extra"]);

/**
 * Defensively normalize the AI's annotation array. Returns null if the input
 * is not a usable array of {word, status} entries, OR if its concatenated
 * content is too far off from the expected source text to render reliably,
 * so callers can fall back to plain-text rendering instead of showing
 * misaligned highlights from malformed model output.
 */
export function sanitizeAnnotations(
  input: unknown,
  expectedText?: string | null
): Annotation[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: Annotation[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const word = rec.word;
    const status = rec.status;
    if (typeof word !== "string" || typeof status !== "string") continue;
    if (!VALID_STATUSES.has(status)) continue;
    const ann: Annotation = { word, status: status as Annotation["status"] };
    if (typeof rec.correct === "string" && rec.correct.length > 0) {
      ann.correct = rec.correct;
    }
    out.push(ann);
  }
  if (out.length === 0) return null;

  if (expectedText) {
    const normalize = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    // Skip "extra" tokens for the length check — those represent words the user
    // inserted that don't appear in the source, so they legitimately add length.
    const normalizedExpected = normalize(expectedText);
    const normalizedAnnotated = normalize(
      out
        .filter((a) => a.status !== "extra")
        .map((a) => a.word)
        .join("")
    );
    if (normalizedExpected.length === 0) return out;
    const ratio = normalizedAnnotated.length / normalizedExpected.length;
    // If the annotated content is wildly shorter or longer than the source
    // (>40% off in either direction), the alignment is unreliable — bail out
    // and let the caller render the plain text instead.
    if (ratio < 0.6 || ratio > 1.6) return null;
  }
  return out;
}
