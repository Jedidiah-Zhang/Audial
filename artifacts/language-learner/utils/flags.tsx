import React from "react";
import { View, type ViewStyle } from "react-native";
import { SvgXml } from "react-native-svg";
import { Globe } from "lucide-react-native";
// Wildcard import: Metro's per-file ESM re-export interop with the
// country-flag-icons barrel produces undefined for most named imports
// (only the bundle-first flag resolves), so we grab the whole namespace
// and look up by code at render time. Bundle cost is the full set of
// SVG flags (~500 KB), which is acceptable for the language picker.
import * as FlagSvgs from "country-flag-icons/string/3x2";

// Map UI/content language codes → ISO 3166-1 alpha-2 country codes. Mirrors
// the previous emoji choices exactly so a switch over to image flags is a
// pure rendering change with no shift in which flag represents which
// language (e.g. English stays as US, Arabic stays as Saudi Arabia).
export const LANG_TO_COUNTRY: Record<string, string> = {
  zh: "CN",
  en: "US",
  ja: "JP",
  ko: "KR",
  es: "ES",
  fr: "FR",
  de: "DE",
  it: "IT",
  pt: "PT",
  ru: "RU",
  ar: "SA",
  hu: "HU",
  pl: "PL",
  nl: "NL",
  sv: "SE",
  no: "NO",
  da: "DK",
  fi: "FI",
  cs: "CZ",
  ro: "RO",
  el: "GR",
  tr: "TR",
  uk: "UA",
  vi: "VN",
  th: "TH",
  id: "ID",
  hi: "IN",
};

const FLAG_SVG = FlagSvgs as unknown as Record<string, string>;

export function getCountryCode(langCode: string | undefined | null): string | null {
  if (!langCode) return null;
  return LANG_TO_COUNTRY[langCode.toLowerCase()] ?? null;
}

interface FlagProps {
  /** Language code (e.g. "en", "zh"). Falls back to a globe icon when unknown. */
  code: string | undefined | null;
  /** Width in pixels. Height is derived from the 3:2 aspect ratio. Default 18. */
  size?: number;
  /** Extra style overrides for the wrapper (margins, etc). */
  style?: ViewStyle;
  /** Accessibility label override (defaults to the language code). */
  accessibilityLabel?: string;
}

/**
 * Renders a country flag image for a given language code. Uses inline SVG
 * via react-native-svg so it looks identical on iOS, Android, and the web
 * preview (avoiding the broken emoji-flag rendering on Chrome/Edge for
 * Windows). Unknown codes fall back to a neutral globe icon.
 */
export function Flag({ code, size = 18, style, accessibilityLabel }: FlagProps) {
  const cc = getCountryCode(code);
  const xml = cc ? FLAG_SVG[cc] : null;
  // 3:2 SVG flags. Round to whole pixels to keep edges crisp.
  const width = Math.round(size);
  const height = Math.max(1, Math.round((size * 2) / 3));

  if (!xml) {
    // Fallback: globe icon sized to match. Uses a square box so layout
    // doesn't collapse if the call site assumed a fixed slot.
    return (
      <View
        accessibilityLabel={accessibilityLabel ?? code ?? "language"}
        style={[
          {
            width,
            height,
            alignItems: "center",
            justifyContent: "center",
          },
          style,
        ]}
      >
        <Globe size={Math.max(10, height - 1)} color="#9ca3af" />
      </View>
    );
  }

  return (
    <View
      accessibilityLabel={accessibilityLabel ?? code ?? cc ?? undefined}
      style={[
        {
          width,
          height,
          borderRadius: 2,
          overflow: "hidden",
          // Soft border to lift very pale flags (white-on-white, JP red dot
          // on white field) off light surfaces.
          borderWidth: 0.5,
          borderColor: "rgba(0,0,0,0.08)",
        },
        style,
      ]}
    >
      <SvgXml xml={xml} width="100%" height="100%" />
    </View>
  );
}

// Backwards-compat: a few call sites may still expect a string-based API.
// Returns the ISO country code when known so callers can decide what to do
// (e.g. for accessibility labels). New code should use <Flag /> instead.
export function getFlagCountryCode(langCode: string): string {
  return getCountryCode(langCode) ?? "";
}
