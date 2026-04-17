import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  LearningText,
  SessionResult,
  UserProgress,
  AppSettings,
} from "@/types";
import { STAGE_PASS_SCORE, STAGES } from "@/types";
import { detectContentType } from "@/utils/contentType";

const STORAGE_KEYS = {
  TEXTS: "ll_texts",
  RESULTS: "ll_results",
  PROGRESS: "ll_progress",
  SETTINGS: "ll_settings",
};

const DEFAULT_SETTINGS: AppSettings = {
  nativeLanguage: "en",
  targetLanguage: "en",
  defaultDifficulty: "intermediate",
  preferredVoice: "nova",
  autoPlayAudio: true,
  ambientSound: true,
  onboarded: false,
};

function defaultProgress(textId: string): UserProgress {
  return {
    textId,
    stageBests: STAGES.map(() => 0),
    stagePassed: STAGES.map(() => false),
    lastStudied: Date.now(),
    totalSessions: 0,
    shadowingBest: 0,
    dictationBest: 0,
    recitationBest: 0,
  };
}

interface AppContextValue {
  texts: LearningText[];
  results: SessionResult[];
  progress: Record<string, UserProgress>;
  settings: AppSettings;
  addText: (text: LearningText) => Promise<void>;
  updateText: (id: string, partial: Partial<LearningText>) => Promise<void>;
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
      if (textsRaw) {
        const parsed = JSON.parse(textsRaw) as LearningText[];
        let mutated = false;
        const migrated = parsed.map((t) => {
          if (!t.contentType) {
            mutated = true;
            return { ...t, contentType: detectContentType(t.text) };
          }
          return t;
        });
        setTexts(migrated);
        if (mutated) {
          AsyncStorage.setItem(STORAGE_KEYS.TEXTS, JSON.stringify(migrated));
        }
      }
      if (resultsRaw) setResults(JSON.parse(resultsRaw));
      if (progressRaw) {
        const raw = JSON.parse(progressRaw) as Record<string, any>;
        const migrated: Record<string, UserProgress> = {};
        for (const [k, v] of Object.entries(raw)) {
          let bests: number[] = v.stageBests ?? STAGES.map(() => 0);
          let passed: boolean[] = v.stagePassed ?? STAGES.map(() => false);
          if (bests.length > STAGES.length) {
            bests = bests.slice(bests.length - STAGES.length);
          }
          if (passed.length > STAGES.length) {
            passed = passed.slice(passed.length - STAGES.length);
          }
          while (bests.length < STAGES.length) bests.push(0);
          while (passed.length < STAGES.length) passed.push(false);
          migrated[k] = {
            ...defaultProgress(k),
            ...v,
            stageBests: bests,
            stagePassed: passed,
          };
        }
        setProgress(migrated);
      }
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

  const updateText = useCallback(async (id: string, partial: Partial<LearningText>) => {
    setTexts((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, ...partial } : t));
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
      const existing = prev[result.textId] ?? defaultProgress(result.textId);
      const stageBests = [...existing.stageBests];
      const stagePassed = [...existing.stagePassed];

      const stageIdx = result.stage;
      if (stageIdx >= 0 && stageIdx < STAGES.length) {
        stageBests[stageIdx] = Math.max(result.score, stageBests[stageIdx]);
        const stage = STAGES[stageIdx];
        if (!stage.needsScore || result.score >= STAGE_PASS_SCORE) {
          stagePassed[stageIdx] = true;
        }
      }

      const updated: UserProgress = {
        ...existing,
        stageBests,
        stagePassed,
        shadowingBest: result.mode === "shadowing"
          ? Math.max(result.score, existing.shadowingBest)
          : existing.shadowingBest,
        dictationBest: result.mode === "dictation"
          ? Math.max(result.score, existing.dictationBest)
          : existing.dictationBest,
        recitationBest: result.mode === "recitation"
          ? Math.max(result.score, existing.recitationBest)
          : existing.recitationBest,
        lastStudied: Date.now(),
        totalSessions: existing.totalSessions + 1,
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
        updateText,
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
