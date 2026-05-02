import { I18nManager, NativeModules, Platform } from "react-native";

const RTL_LANGS = new Set<string>(["ar", "he", "fa", "ur"]);

// Lazy-loaded so the web bundle doesn't try to evaluate native-only modules
// at import time. expo-updates is the production-safe reload mechanism on
// native; if it's unavailable (e.g. some custom builds), we fall back to
// the dev-time `DevSettings.reload()` which works in Expo Go.
let cachedUpdatesReload: (() => Promise<unknown>) | null | undefined;
function getUpdatesReloader(): (() => Promise<unknown>) | null {
  if (cachedUpdatesReload !== undefined) return cachedUpdatesReload;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("expo-updates") as { reloadAsync?: () => Promise<unknown> };
    cachedUpdatesReload = typeof mod?.reloadAsync === "function" ? mod.reloadAsync : null;
  } catch {
    cachedUpdatesReload = null;
  }
  return cachedUpdatesReload;
}

export function isRTL(lang: string | undefined | null): boolean {
  if (!lang) return false;
  return RTL_LANGS.has(lang);
}

export function applyRTL(lang: string | undefined): {
  changed: boolean;
  targetRTL: boolean;
} {
  const targetRTL = isRTL(lang);
  const currentRTL = I18nManager.isRTL;

  if (currentRTL !== targetRTL) {
    try {
      I18nManager.allowRTL(targetRTL);
      I18nManager.forceRTL(targetRTL);
    } catch {
      // ignore — best effort
    }
  }

  if (Platform.OS === "web" && typeof document !== "undefined") {
    document.documentElement.dir = targetRTL ? "rtl" : "ltr";
    if (lang) document.documentElement.lang = lang;
  }

  return { changed: currentRTL !== targetRTL, targetRTL };
}

export function reloadForRTL(delayMs = 250): void {
  if (Platform.OS === "web") return;
  // Small delay so AsyncStorage writes triggered by the same user action
  // (e.g. updating `nativeLanguage`) have time to flush before the JS
  // bundle is torn down. AsyncStorage on RN is typically <100ms.
  setTimeout(() => {
    const reloadAsync = getUpdatesReloader();
    if (reloadAsync) {
      // Production-safe path via expo-updates. Works in Expo Go, dev
      // clients, and standalone production builds.
      reloadAsync().catch(() => {
        // Fall through to DevSettings as a last resort (dev only).
        try {
          NativeModules.DevSettings?.reload?.();
        } catch {
          // give up; user will need to relaunch the app manually
        }
      });
      return;
    }
    try {
      NativeModules.DevSettings?.reload?.();
    } catch {
      // best effort; user may need to relaunch manually
    }
  }, delayMs);
}

export const rtlFlipStyle = { transform: [{ scaleX: -1 as const }] } as const;

export function flipIfRTL() {
  return I18nManager.isRTL ? rtlFlipStyle : undefined;
}

// ── Per-content direction detection ──────────────────────────────────────
//
// Independent of the app's global I18nManager direction (which follows the
// user's *native* language), individual chunks of user-visible content can
// be in a different script — most notably, an Arabic article shown in an
// otherwise English UI. These helpers let any <Text> opt into character-
// based direction without us flipping the whole layout.
//
// Ranges covered:
//   Arabic            U+0600–U+06FF
//   Arabic Supplement U+0750–U+077F
//   Arabic Extended-A U+08A0–U+08FF
//   Arabic Pres. A    U+FB50–U+FDFF
//   Arabic Pres. B    U+FE70–U+FEFF
//   Hebrew            U+0590–U+05FF
// Match RTL *letters* only (excludes Arabic punctuation like ،؛؟ and
// combining marks), so a string of only Arabic punctuation/digits is
// not classified as RTL. The character classes mirror the Unicode
// blocks called out in the docblock above; we restrict to the letter
// sub-ranges within each block by hand-listing them rather than
// relying on \p{Script=...} which historically had spotty support on
// older Hermes builds.
const RTL_LETTER_RE =
  /[\u0590-\u05F4\u0620-\u064A\u066E-\u066F\u0671-\u06D3\u06D5\u06E5-\u06E6\u06EE-\u06EF\u06FA-\u06FC\u06FF\u0750-\u077F\u08A0-\u08B4\u08B6-\u08BD\uFB1D-\uFB4F\uFB50-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC]/g;
// Letters from common LTR scripts (Latin/Greek/Cyrillic) — used to compare
// against the RTL letter count so a single stray Arabic word in an English
// sentence doesn't flip the whole paragraph.
const LTR_LETTER_RE = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/g;

/**
 * Detect whether a string should be rendered right-to-left based on its
 * contents. Returns "rtl" when there is at least one RTL letter AND
 * the RTL letter count is greater than or equal to the LTR letter count
 * (so a paragraph that's mostly English with one Arabic loanword stays
 * LTR). Strings with no letters at all (only digits/punctuation/whitespace
 * — including Arabic punctuation like ،؟ — or empty) are reported as
 * "ltr".
 */
export function getContentDirection(text: string | null | undefined): "rtl" | "ltr" {
  if (!text) return "ltr";
  const rtlCount = (text.match(RTL_LETTER_RE) ?? []).length;
  if (rtlCount === 0) return "ltr";
  const ltrCount = (text.match(LTR_LETTER_RE) ?? []).length;
  return rtlCount >= ltrCount ? "rtl" : "ltr";
}

export type RtlTextStyle = {
  writingDirection: "rtl";
  textAlign: "right";
};

/**
 * Returns a style fragment that forces RTL writing direction and right
 * alignment when the given text is detected as RTL. Returns `undefined`
 * for LTR text so the caller's existing alignment is preserved. Spread
 * (or place) at the END of the style array so it overrides any default
 * `textAlign` on the same Text.
 */
export function rtlTextStyle(text: string | null | undefined): RtlTextStyle | undefined {
  return getContentDirection(text) === "rtl"
    ? { writingDirection: "rtl", textAlign: "right" }
    : undefined;
}
