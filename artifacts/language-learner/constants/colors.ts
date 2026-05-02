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
    text: "#0f172a",
    tint: "#6366f1",
    background: "#f8fafc",
    foreground: "#0f172a",
    card: "#ffffff",
    cardForeground: "#0f172a",
    primary: "#6366f1",
    primaryForeground: "#ffffff",
    secondary: "#e0e7ff",
    secondaryForeground: "#3730a3",
    muted: "#f1f5f9",
    mutedForeground: "#64748b",
    accent: "#818cf8",
    accentForeground: "#ffffff",
    destructive: "#ef4444",
    destructiveForeground: "#ffffff",
    border: "#e2e8f0",
    input: "#e2e8f0",
    success: "#22c55e",
    successForeground: "#ffffff",
    warning: "#f59e0b",
    warningForeground: "#ffffff",
    surface: "#ffffff",
    surfaceElevated: "#f8fafc",
  },
  dark: {
    text: "#f1f5f9",
    tint: "#818cf8",
    background: "#0f172a",
    foreground: "#f1f5f9",
    card: "#1e293b",
    cardForeground: "#f1f5f9",
    primary: "#818cf8",
    primaryForeground: "#0f172a",
    secondary: "#1e293b",
    secondaryForeground: "#a5b4fc",
    muted: "#1e293b",
    mutedForeground: "#94a3b8",
    accent: "#6366f1",
    accentForeground: "#ffffff",
    destructive: "#ef4444",
    destructiveForeground: "#ffffff",
    border: "#334155",
    input: "#334155",
    success: "#22c55e",
    successForeground: "#ffffff",
    warning: "#f59e0b",
    warningForeground: "#ffffff",
    surface: "#1e293b",
    surfaceElevated: "#0f172a",
  },
};

export const radius = 12;

const colors = { ...palettes, radius };

export default colors;
