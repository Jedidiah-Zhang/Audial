import { useColorScheme } from "react-native";

import { palettes, radius } from "@/constants/colors";

/**
 * Returns the design tokens for the current color scheme.
 *
 * The returned object contains all color tokens for the active palette
 * plus scheme-independent values like `radius`.
 */
export function useColors() {
  const scheme = useColorScheme();
  const palette = scheme === "dark" ? palettes.dark : palettes.light;
  return { ...palette, radius };
}
