export type Palette = {
  text: string;
  tint: string;
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  success: string;
  successForeground: string;
  warning: string;
  warningForeground: string;
  surface: string;
  surfaceElevated: string;
};

export const palettes: { light: Palette; dark: Palette } = {
  light: {
    text: "#0f0e17",
    tint: "#ff2e63",
    background: "#fff8f2",
    foreground: "#0f0e17",
    card: "#ffffff",
    cardForeground: "#0f0e17",
    primary: "#ff2e63",
    primaryForeground: "#ffffff",
    secondary: "#ffe3ec",
    secondaryForeground: "#a3093d",
    muted: "#fff1e6",
    mutedForeground: "#6b6577",
    accent: "#08d9d6",
    accentForeground: "#0f0e17",
    destructive: "#ef4444",
    destructiveForeground: "#ffffff",
    border: "#f1e3d6",
    input: "#f1e3d6",
    success: "#00c897",
    successForeground: "#ffffff",
    warning: "#ffb400",
    warningForeground: "#0f0e17",
    surface: "#ffffff",
    surfaceElevated: "#fff8f2",
  },
  dark: {
    text: "#fffffe",
    tint: "#ff5a87",
    background: "#0f0e17",
    foreground: "#fffffe",
    card: "#1c1a2b",
    cardForeground: "#fffffe",
    primary: "#ff5a87",
    primaryForeground: "#0f0e17",
    secondary: "#2a1f33",
    secondaryForeground: "#ff9bb6",
    muted: "#1c1a2b",
    mutedForeground: "#a7a4b8",
    accent: "#08d9d6",
    accentForeground: "#0f0e17",
    destructive: "#ef4444",
    destructiveForeground: "#ffffff",
    border: "#2a2740",
    input: "#2a2740",
    success: "#00e0a4",
    successForeground: "#0f0e17",
    warning: "#ffb400",
    warningForeground: "#0f0e17",
    surface: "#1c1a2b",
    surfaceElevated: "#0f0e17",
  },
};

export const radius = 12;

const colors = { ...palettes, radius };

export default colors;
