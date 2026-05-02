import { VOICE_OPTIONS, type VoiceAccent } from "@/types";

/**
 * Map an article's `targetLanguage` (typically a BCP-47-ish code such as
 * `en-US`, `en-GB`, `zh`, etc.) to the accent we'd ideally use for TTS.
 *
 * Returns `null` for languages where we don't have a strong opinion — the
 * caller should fall back to the user's `preferredVoice` in that case.
 */
export function accentForLanguage(langCode: string | undefined | null): VoiceAccent | null {
  if (!langCode) return null;
  const normalized = langCode.toLowerCase();
  if (normalized === "en-gb" || normalized === "en_gb") return "british";
  if (normalized === "en-us" || normalized === "en_us") return "american";
  // Safety net: any not-yet-migrated plain "en" article is treated as
  // American so its voice default doesn't fall through to a globally
  // wrong voice while migration is in flight.
  if (normalized === "en") return "american";
  return null;
}

/**
 * Pick a sensible default voice id for an article's target language.
 *
 * Currently:
 *   - `en-GB` → `fable` (the only voice with a British lilt)
 *   - `en-US` → `nova`  (clear American)
 *   - legacy plain `en` → `nova` (treated as American as a safety net for
 *     not-yet-migrated articles; see `accentForLanguage`)
 *   - everything else → `null`, meaning the caller should fall back to
 *     whatever the user has set globally.
 *
 * The function looks up actual voice ids inside `VOICE_OPTIONS` so a future
 * voice catalogue change automatically rescans for a matching accent.
 */
export function getDefaultVoiceForLanguage(
  langCode: string | undefined | null
): string | null {
  const accent = accentForLanguage(langCode);
  if (!accent) return null;
  const match = VOICE_OPTIONS.find((v) => v.accent === accent);
  return match?.id ?? null;
}
