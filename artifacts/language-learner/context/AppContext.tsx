import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  LearningText,
  SessionResult,
  UserProgress,
  AppSettings,
  Difficulty,
} from "@/types";

const STORAGE_KEYS = {
  TEXTS: "ll_texts",
  RESULTS: "ll_results",
  PROGRESS: "ll_progress",
  SETTINGS: "ll_settings",
};

const DEFAULT_SETTINGS: AppSettings = {
  nativeLanguage: "zh",
  targetLanguage: "en",
  defaultDifficulty: "intermediate",
  preferredVoice: "nova",
  autoPlayAudio: true,
};

interface AppContextValue {
  texts: LearningText[];
  results: SessionResult[];
  progress: Record<string, UserProgress>;
  settings: AppSettings;
  addText: (text: LearningText) => Promise<void>;
  removeText: (id: string) => Promise<void>;
  addResult: (result: SessionResult) => Promise<void>;
  updateSettings: (s: Partial<AppSettings>) => Promise<void>;
  getProgressForText: (textId: string) => UserProgress | undefined;
  isLoading: boolean;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [texts, setTexts] = useState<LearningText[]>([]);
  const [results, setResults] = useState<SessionResult[]>([]);
  const [progress, setProgress] = useState<Record<string, UserProgress>>({});
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadAll();
  }, []);

  async function loadAll() {
    try {
      const [textsRaw, resultsRaw, progressRaw, settingsRaw] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.TEXTS),
        AsyncStorage.getItem(STORAGE_KEYS.RESULTS),
        AsyncStorage.getItem(STORAGE_KEYS.PROGRESS),
        AsyncStorage.getItem(STORAGE_KEYS.SETTINGS),
      ]);
      if (textsRaw) setTexts(JSON.parse(textsRaw));
      if (resultsRaw) setResults(JSON.parse(resultsRaw));
      if (progressRaw) setProgress(JSON.parse(progressRaw));
      if (settingsRaw) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(settingsRaw) });
    } finally {
      setIsLoading(false);
    }
  }

  const addText = useCallback(async (text: LearningText) => {
    setTexts((prev) => {
      const next = [text, ...prev.filter((t) => t.id !== text.id)];
      AsyncStorage.setItem(STORAGE_KEYS.TEXTS, JSON.stringify(next));
      return next;
    });
  }, []);

  const removeText = useCallback(async (id: string) => {
    setTexts((prev) => {
      const next = prev.filter((t) => t.id !== id);
      AsyncStorage.setItem(STORAGE_KEYS.TEXTS, JSON.stringify(next));
      return next;
    });
  }, []);

  const addResult = useCallback(async (result: SessionResult) => {
    setResults((prev) => {
      const next = [result, ...prev].slice(0, 200);
      AsyncStorage.setItem(STORAGE_KEYS.RESULTS, JSON.stringify(next));
      return next;
    });

    setProgress((prev) => {
      const existing = prev[result.textId];
      const updated: UserProgress = {
        textId: result.textId,
        shadowingBest: result.mode === "shadowing"
          ? Math.max(result.score, existing?.shadowingBest ?? 0)
          : (existing?.shadowingBest ?? 0),
        dictationBest: result.mode === "dictation"
          ? Math.max(result.score, existing?.dictationBest ?? 0)
          : (existing?.dictationBest ?? 0),
        recitationBest: result.mode === "recitation"
          ? Math.max(result.score, existing?.recitationBest ?? 0)
          : (existing?.recitationBest ?? 0),
        lastStudied: Date.now(),
        totalSessions: (existing?.totalSessions ?? 0) + 1,
      };
      const next = { ...prev, [result.textId]: updated };
      AsyncStorage.setItem(STORAGE_KEYS.PROGRESS, JSON.stringify(next));
      return next;
    });
  }, []);

  const updateSettings = useCallback(async (partial: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      AsyncStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(next));
      return next;
    });
  }, []);

  const getProgressForText = useCallback(
    (textId: string) => progress[textId],
    [progress]
  );

  return (
    <AppContext.Provider
      value={{
        texts,
        results,
        progress,
        settings,
        addText,
        removeText,
        addResult,
        updateSettings,
        getProgressForText,
        isLoading,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
