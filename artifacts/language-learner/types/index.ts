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

export interface AppSettings {
  nativeLanguage: string;
  targetLanguage: string;
  defaultDifficulty: Difficulty;
  preferredVoice: string;
  autoPlayAudio: boolean;
}

export const STAGE_PASS_SCORE = 60;

export const STAGES = [
  {
    index: 0,
    name: "跟读",
    englishName: "Shadowing",
    icon: "mic",
    color: "#8B5CF6",
    description: "模仿母语者发音，AI评估准确度与流利度",
    needsScore: true,
    mode: "shadowing" as LearningMode,
  },
  {
    index: 1,
    name: "听写",
    englishName: "Dictation",
    icon: "edit-2",
    color: "#EC4899",
    description: "只听声音不看文字，将听到的内容写下来",
    needsScore: true,
    mode: "dictation" as LearningMode,
  },
  {
    index: 2,
    name: "背诵",
    englishName: "Recitation",
    icon: "award",
    color: "#F59E0B",
    description: "记忆全文后从记忆中完整背诵",
    needsScore: true,
    mode: "recitation" as LearningMode,
  },
] as const;

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
  { code: "hu", name: "Magyar" },
  { code: "pl", name: "Polski" },
  { code: "nl", name: "Nederlands" },
  { code: "sv", name: "Svenska" },
  { code: "no", name: "Norsk" },
  { code: "da", name: "Dansk" },
  { code: "fi", name: "Suomi" },
  { code: "cs", name: "Čeština" },
  { code: "el", name: "Ελληνικά" },
  { code: "tr", name: "Türkçe" },
  { code: "he", name: "עברית" },
  { code: "hi", name: "हिन्दी" },
  { code: "th", name: "ไทย" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "id", name: "Bahasa Indonesia" },
  { code: "ms", name: "Bahasa Melayu" },
  { code: "uk", name: "Українська" },
  { code: "ro", name: "Română" },
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

export interface VoiceOption {
  id: string;
  label: string;
  gender: "male" | "female" | "neutral";
  description: string;
}

export const VOICE_OPTIONS: VoiceOption[] = [
  { id: "nova", label: "Nova", gender: "female", description: "女声 · 明亮自然" },
  { id: "shimmer", label: "Shimmer", gender: "female", description: "女声 · 温柔轻盈" },
  { id: "alloy", label: "Alloy", gender: "neutral", description: "中性 · 平稳清晰" },
  { id: "echo", label: "Echo", gender: "male", description: "男声 · 沉稳标准" },
  { id: "fable", label: "Fable", gender: "male", description: "男声 · 略带英伦腔" },
  { id: "onyx", label: "Onyx", gender: "male", description: "男声 · 低沉浑厚" },
];
