import { useContext } from "react";
import { useColorScheme } from "react-native";

import { palettes, radius } from "@/constants/colors";
import { AppContext } from "@/context/AppContext";

/**
 * Resolves the effective color scheme by combining the user's manual theme
 * preference (settings.themePreference) with the OS-reported scheme.
 *
 * - `"light"` / `"dark"` → always wins, regardless of OS.
 * - `"system"` (or unset) → falls back to `useColorScheme()` so flipping the
 *   OS dark-mode toggle live-updates the app.
 *
 * Falls through to the OS scheme when no `AppProvider` is mounted, so
 * components used above the provider (e.g. error boundaries) still get a
 * reasonable value instead of crashing.
 */
export function useResolvedColorScheme(): "light" | "dark" {
  const sysScheme = useColorScheme();
  const ctx = useContext(AppContext);
  const pref = ctx?.settings?.themePreference ?? "system";
  if (pref === "light") return "light";
  if (pref === "dark") return "dark";
  return sysScheme === "dark" ? "dark" : "light";
}

/**
 * Returns the design tokens for the current color scheme.
 *
 * The returned object contains all color tokens for the active palette
 * plus scheme-independent values like `radius`.
 */
export function useColors() {
  const scheme = useResolvedColorScheme();
  const palette = scheme === "dark" ? palettes.dark : palettes.light;
  return { ...palette, radius };
}
