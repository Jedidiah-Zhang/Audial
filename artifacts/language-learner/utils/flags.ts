export const LANG_FLAGS: Record<string, string> = {
  zh: "🇨🇳",
  en: "🇺🇸",
  ja: "🇯🇵",
  ko: "🇰🇷",
  es: "🇪🇸",
  fr: "🇫🇷",
  de: "🇩🇪",
  it: "🇮🇹",
  pt: "🇵🇹",
  ru: "🇷🇺",
  ar: "🇸🇦",
  hu: "🇭🇺",
  pl: "🇵🇱",
  nl: "🇳🇱",
  sv: "🇸🇪",
  no: "🇳🇴",
  da: "🇩🇰",
  fi: "🇫🇮",
  cs: "🇨🇿",
  ro: "🇷🇴",
  el: "🇬🇷",
  tr: "🇹🇷",
  uk: "🇺🇦",
  vi: "🇻🇳",
  th: "🇹🇭",
  id: "🇮🇩",
  hi: "🇮🇳",
};

export function getFlag(code: string): string {
  return LANG_FLAGS[code?.toLowerCase()] ?? "🌐";
}
