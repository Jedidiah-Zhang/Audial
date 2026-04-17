export type Difficulty = "beginner" | "elementary" | "intermediate" | "advanced";

export type LearningMode = "shadowing" | "dictation" | "recitation";

export interface VocabularyItem {
  word: string;
  pronunciation?: string;
  meaning: string;
}

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
}

export interface SessionResult {
  id: string;
  textId: string;
  mode: LearningMode;
  score: number;
  feedback: string;
  createdAt: number;
  details?: Record<string, unknown>;
}

export interface UserProgress {
  textId: string;
  shadowingBest: number;
  dictationBest: number;
  recitationBest: number;
  lastStudied: number;
  totalSessions: number;
}

export interface AppSettings {
  nativeLanguage: string;
  targetLanguage: string;
  defaultDifficulty: Difficulty;
  preferredVoice: string;
  autoPlayAudio: boolean;
}

export const LANGUAGES = [
  { code: "zh", name: "中文" },
  { code: "en", name: "English" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português" },
  { code: "ru", name: "Русский" },
  { code: "ar", name: "العربية" },
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
