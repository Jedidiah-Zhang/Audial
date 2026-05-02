import React from "react";
import { View, type ViewStyle } from "react-native";
import { SvgXml } from "react-native-svg";
import { Globe } from "lucide-react-native";
import * as FlagSvgs from "country-flag-icons/string/3x2";

export const LANG_TO_COUNTRY: Record<string, string> = {
  zh: "CN",
  // Legacy plain "en" still resolves to the US flag so any not-yet-migrated
  // entry doesn't render a globe icon. New code uses the BCP-47 variants.
  en: "US",
  "en-US": "US",
  "en-GB": "GB",
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
  // Direct hit first so BCP-47 region tags like "en-US" / "en-GB" find their
  // entries (the LANG_TO_COUNTRY map keeps the canonical mixed casing).
  if (LANG_TO_COUNTRY[langCode]) return LANG_TO_COUNTRY[langCode];
  // Normalise mixed-casing variants such as "en-us" → "en-US" before falling
  // back to the lower-cased base lookup.
  const [base, region] = langCode.split("-");
  if (region) {
    const normalised = `${base.toLowerCase()}-${region.toUpperCase()}`;
    if (LANG_TO_COUNTRY[normalised]) return LANG_TO_COUNTRY[normalised];
  }
  return LANG_TO_COUNTRY[langCode.toLowerCase()] ?? null;
}

interface FlagProps {
  code: string | undefined | null;
  size?: number;
  style?: ViewStyle;
  accessibilityLabel?: string;
}

export function Flag({ code, size = 18, style, accessibilityLabel }: FlagProps) {
  const cc = getCountryCode(code);
  const xml = cc ? FLAG_SVG[cc] : null;
  const width = Math.round(size);
  const height = Math.max(1, Math.round((size * 2) / 3));

  if (!xml) {
    return (
      <View
        accessibilityLabel={accessibilityLabel ?? code ?? "language"}
        style={[
          { width, height, alignItems: "center", justifyContent: "center" },
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
