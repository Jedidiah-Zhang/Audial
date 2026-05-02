export type Difficulty = "beginner" | "elementary" | "intermediate" | "advanced";

export type LearningMode = "shadowing" | "dictation" | "recitation";

export interface VocabularyItem {
  word: string;
  pronunciation?: string;
  meaning: string;
  partOfSpeech?: string;
  example?: string;
  exampleTranslation?: string;
}

export type ContentType =
  | "dialogue"
  | "news"
  | "email"
  | "letter"
  | "speech"
  | "story"
  | "essay"
  | "general";

export interface LearningText {
  id: string;
  title: string;
  text: string;
  translation: string;
  vocabulary: VocabularyItem[];
  topic: string;
  difficulty: Difficulty;
  targetLanguage: string;
  nativeLanguage: string;
  createdAt: number;
  contentType?: ContentType;
}

export interface SessionResult {
  id: string;
  textId: string;
  mode: LearningMode | "listening";
  stage: number;
  score: number;
  feedback: string;
  createdAt: number;
  details?: Record<string, unknown>;
}

export interface UserProgress {
  textId: string;
  stageBests: number[];
  stagePassed: boolean[];
  lastStudied: number;
  totalSessions: number;
  shadowingBest: number;
  dictationBest: number;
  recitationBest: number;
}

export type SubscriptionTier = "free" | "pro";

/**
 * Per-user subscription state. Persisted under `ll:{userId}:subscription` in
 * AsyncStorage and migrated from guest → signed-in account along with other
 * scoped data. This is the UI-only demo version: there is no real billing.
 */
export interface SubscriptionState {
  tier: SubscriptionTier;
  /** Epoch ms when the user first upgraded; only set when tier === "pro". */
  upgradedAt?: number;
}

export const DEFAULT_SUBSCRIPTION: SubscriptionState = {
  tier: "free",
};

export interface AppSettings {
  nativeLanguage: string;
  targetLanguage: string;
  defaultDifficulty: Difficulty;
  preferredVoice: string;
  /**
   * True once the user has manually picked a voice (in settings or in the
   * practice voice chips). When false, the per-article TTS uses the
   * language-default voice (see `getDefaultVoiceForLanguage`) so en-GB
   * articles read with a British voice and en-US articles with an American
   * one without forcing the user to pick.
   */
  preferredVoiceUserSet?: boolean;
  onboarded: boolean;
  /**
   * Manual color-scheme override. `"system"` (default) follows the OS, while
   * `"light"` / `"dark"` lock the app to that palette regardless of OS state.
   * Optional so older persisted settings without this key keep working — the
   * app treats `undefined` the same as `"system"`.
   */
  themePreference?: "system" | "light" | "dark";
}

export const STAGE_PASS_SCORE = 60;

export const STAGES = [
  {
    index: 0,
    name: "跟读",
    englishName: "Shadowing",
    icon: "mic",
    color: "#2962FF",
    description: "模仿母语者发音，AI评估准确度与流利度",
    needsScore: true,
    mode: "shadowing" as LearningMode,
  },
  {
    index: 1,
    name: "听写",
    englishName: "Dictation",
    icon: "edit-2",
    color: "#FF1F8F",
    description: "只听声音不看文字，将听到的内容写下来",
    needsScore: true,
    mode: "dictation" as LearningMode,
  },
  {
    index: 2,
    name: "背诵",
    englishName: "Recitation",
    icon: "award",
    color: "#00C853",
    description: "记忆全文后从记忆中完整背诵",
    needsScore: true,
    mode: "recitation" as LearningMode,
  },
] as const;

export const LANGUAGES = [
  { code: "zh", name: "中文", english: "Chinese" },
  { code: "en-US", name: "English (US)", english: "American English" },
  { code: "en-GB", name: "English (UK)", english: "British English" },
  { code: "ja", name: "日本語", english: "Japanese" },
  { code: "ko", name: "한국어", english: "Korean" },
  { code: "es", name: "Español", english: "Spanish" },
  { code: "fr", name: "Français", english: "French" },
  { code: "de", name: "Deutsch", english: "German" },
  { code: "it", name: "Italiano", english: "Italian" },
  { code: "pt", name: "Português", english: "Portuguese" },
  { code: "ru", name: "Русский", english: "Russian" },
  { code: "ar", name: "العربية", english: "Arabic" },
  { code: "hu", name: "Magyar", english: "Hungarian" },
  { code: "pl", name: "Polski", english: "Polish" },
  { code: "nl", name: "Nederlands", english: "Dutch" },
  { code: "sv", name: "Svenska", english: "Swedish" },
  { code: "no", name: "Norsk", english: "Norwegian" },
  { code: "da", name: "Dansk", english: "Danish" },
  { code: "fi", name: "Suomi", english: "Finnish" },
  { code: "cs", name: "Čeština", english: "Czech" },
  { code: "ro", name: "Română", english: "Romanian" },
  { code: "el", name: "Ελληνικά", english: "Greek" },
  { code: "tr", name: "Türkçe", english: "Turkish" },
  { code: "uk", name: "Українська", english: "Ukrainian" },
  { code: "vi", name: "Tiếng Việt", english: "Vietnamese" },
  { code: "th", name: "ไทย", english: "Thai" },
  { code: "id", name: "Bahasa Indonesia", english: "Indonesian" },
  { code: "hi", name: "हिन्दी", english: "Hindi" },
];

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  beginner: "入门",
  elementary: "初级",
  intermediate: "中级",
  advanced: "高级",
};

export const MODE_LABELS: Record<LearningMode, string> = {
  shadowing: "跟读",
  dictation: "听写",
  recitation: "背诵",
};

export type VoiceAccent = "american" | "british" | "neutral";

export interface VoiceOption {
  id: string;
  label: string;
  gender: "male" | "female" | "neutral";
  /**
   * Accent hint used to pick a sensible default voice per article language
   * (see `getDefaultVoiceForLanguage`). Not surfaced in the UI.
   */
  accent: VoiceAccent;
  description: string;
}

export const VOICE_OPTIONS: VoiceOption[] = [
  { id: "nova", label: "Nova", gender: "female", accent: "american", description: "女声 · 明亮自然" },
  { id: "shimmer", label: "Shimmer", gender: "female", accent: "american", description: "女声 · 温柔轻盈" },
  { id: "alloy", label: "Alloy", gender: "neutral", accent: "neutral", description: "中性 · 平稳清晰" },
  { id: "echo", label: "Echo", gender: "male", accent: "neutral", description: "男声 · 沉稳标准" },
  { id: "fable", label: "Fable", gender: "male", accent: "british", description: "男声 · 略带英伦腔" },
  { id: "onyx", label: "Onyx", gender: "male", accent: "neutral", description: "男声 · 低沉浑厚" },
];
