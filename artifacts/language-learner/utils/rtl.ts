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
