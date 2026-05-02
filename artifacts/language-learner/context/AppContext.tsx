import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "@clerk/expo";
import type {
  LearningText,
  SessionResult,
  UserProgress,
  AppSettings,
} from "@/types";
import { STAGE_PASS_SCORE, STAGES } from "@/types";
import { detectContentType } from "@/utils/contentType";
import { clearArticleAudio } from "@/utils/ttsCache";
import { migrateGuestData } from "@/utils/migrateGuestData";

const GUEST_USER_ID = "guest";

const LOCAL_ACCOUNTS_KEY = "ll:localAccounts";
const ACTIVE_LOCAL_KEY = "ll:activeLocalAccountId";

export interface LocalAccount {
  id: string;
  name: string;
  createdAt: number;
}

// Legacy unscoped keys (used before per-account isolation was introduced).
// We keep reading from them once for the guest scope so existing users don't
// lose their data when they update.
const LEGACY_KEYS = {
  TEXTS: "ll_texts",
  RESULTS: "ll_results",
  PROGRESS: "ll_progress",
  SETTINGS: "ll_settings",
} as const;

function keysFor(userId: string) {
  const prefix = `ll:${userId}:`;
  return {
    TEXTS: `${prefix}texts`,
    RESULTS: `${prefix}results`,
    PROGRESS: `${prefix}progress`,
    SETTINGS: `${prefix}settings`,
  };
}

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

function genId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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
  userId: string;
  isGuest: boolean;
  // Local (no-password, on-device) accounts
  localAccounts: LocalAccount[];
  activeLocalAccountId: string | null;
  activeLocalAccount: LocalAccount | null;
  createLocalAccount: (name: string) => Promise<LocalAccount>;
  switchLocalAccount: (id: string | null) => Promise<void>;
  deleteLocalAccount: (id: string) => Promise<void>;
  renameLocalAccount: (id: string, name: string) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const { isLoaded: authLoaded, userId: clerkUserId } = useAuth();

  const [localAccounts, setLocalAccounts] = useState<LocalAccount[]>([]);
  const [activeLocalAccountId, setActiveLocalAccountId] = useState<string | null>(null);
  const [localLoaded, setLocalLoaded] = useState(false);

  // Effective active user id: Clerk session wins, then local account, then guest.
  const userId = clerkUserId
    ?? (activeLocalAccountId ? `local:${activeLocalAccountId}` : GUEST_USER_ID);
  const isGuest = !clerkUserId && !activeLocalAccountId;

  // Source of truth for the active user that all async ops compare against
  // before committing state or writes. Updated synchronously on user change.
  const currentUserRef = useRef(userId);

  // Tracks the previously-active userId so we can detect a guest → account
  // transition and run the one-time migration. Starts undefined so the very
  // first effect run (mount) is treated as "no previous user" and skips
  // migration even if we mount straight into a signed-in session.
  const prevUserIdRef = useRef<string | undefined>(undefined);
  // Per-target one-shot guard: prevents re-running migration if React fires
  // the userId effect multiple times for the same destination account (e.g.
  // Clerk hydration jitter).
  const migratedTargetsRef = useRef<Set<string>>(new Set());

  const [texts, setTexts] = useState<LearningText[]>([]);
  const [results, setResults] = useState<SessionResult[]>([]);
  const [progress, setProgress] = useState<Record<string, UserProgress>>({});
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  // Load local accounts list + active id once on mount.
  useEffect(() => {
    (async () => {
      try {
        const [listRaw, activeRaw] = await Promise.all([
          AsyncStorage.getItem(LOCAL_ACCOUNTS_KEY),
          AsyncStorage.getItem(ACTIVE_LOCAL_KEY),
        ]);
        const list: LocalAccount[] = listRaw ? JSON.parse(listRaw) : [];
        setLocalAccounts(Array.isArray(list) ? list : []);
        if (activeRaw && (Array.isArray(list) ? list : []).some((a) => a.id === activeRaw)) {
          setActiveLocalAccountId(activeRaw);
        } else if (activeRaw) {
          await AsyncStorage.removeItem(ACTIVE_LOCAL_KEY);
        }
      } catch {
        // ignore
      } finally {
        setLocalLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!authLoaded || !localLoaded) return;
    const prev = prevUserIdRef.current;
    prevUserIdRef.current = userId;
    currentUserRef.current = userId;
    setIsLoading(true);
    setTexts([]);
    setResults([]);
    setProgress({});
    setSettings(DEFAULT_SETTINGS);

    // Migrate guest-scoped data into the target account on the first
    // transition out of the guest scope (covers both Clerk sign-in/sign-up
    // and switching to a local account). We deliberately skip when:
    //  - there is no previous user (initial mount)
    //  - we're going TO guest (sign-out)
    //  - we're going from one account directly to another (Clerk↔Clerk,
    //    Clerk↔local, local↔local) — that data belongs to the previous
    //    account, not to whoever is signing in next
    //  - we already migrated to this target in this session
    const shouldMigrate =
      prev === GUEST_USER_ID &&
      userId !== GUEST_USER_ID &&
      !migratedTargetsRef.current.has(userId);

    (async () => {
      if (shouldMigrate) {
        try {
          await migrateGuestData(userId);
          // Only mark this target as done after the migration actually
          // completed without throwing. Transient AsyncStorage failures
          // should be retried on the next sign-in.
          migratedTargetsRef.current.add(userId);
        } catch {
          // best-effort; fall through to loadAll so the user still sees
          // whatever target-side data is already there
        }
      }
      // If the active user changed while migration was in flight, abort the
      // load — the next effect run will handle the new user.
      if (currentUserRef.current !== userId) return;
      loadAll(userId).catch(() => {});
    })();
  }, [authLoaded, localLoaded, userId]);

  async function migrateLegacyIfNeeded(K: ReturnType<typeof keysFor>, isGuestScope: boolean) {
    if (!isGuestScope) return;
    // For the guest scope, copy any legacy unscoped data on first run.
    const migratedFlagKey = "ll:migrated_legacy_v1";
    const flag = await AsyncStorage.getItem(migratedFlagKey);
    if (flag === "1") return;
    try {
      const [t, r, p, s] = await Promise.all([
        AsyncStorage.getItem(LEGACY_KEYS.TEXTS),
        AsyncStorage.getItem(LEGACY_KEYS.RESULTS),
        AsyncStorage.getItem(LEGACY_KEYS.PROGRESS),
        AsyncStorage.getItem(LEGACY_KEYS.SETTINGS),
      ]);
      const writes: Promise<void>[] = [];
      if (t && !(await AsyncStorage.getItem(K.TEXTS))) writes.push(AsyncStorage.setItem(K.TEXTS, t));
      if (r && !(await AsyncStorage.getItem(K.RESULTS))) writes.push(AsyncStorage.setItem(K.RESULTS, r));
      if (p && !(await AsyncStorage.getItem(K.PROGRESS))) writes.push(AsyncStorage.setItem(K.PROGRESS, p));
      if (s && !(await AsyncStorage.getItem(K.SETTINGS))) writes.push(AsyncStorage.setItem(K.SETTINGS, s));
      await Promise.all(writes);
      await AsyncStorage.setItem(migratedFlagKey, "1");
    } catch {
      // best-effort migration
    }
  }

  async function loadAll(uid: string) {
    const K = keysFor(uid);
    try {
      await migrateLegacyIfNeeded(K, uid === GUEST_USER_ID);
      const [textsRaw, resultsRaw, progressRaw, settingsRaw] = await Promise.all([
        AsyncStorage.getItem(K.TEXTS),
        AsyncStorage.getItem(K.RESULTS),
        AsyncStorage.getItem(K.PROGRESS),
        AsyncStorage.getItem(K.SETTINGS),
      ]);
      // Discard if user changed mid-load
      if (uid !== currentUserRef.current) return;
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
          AsyncStorage.setItem(K.TEXTS, JSON.stringify(migrated));
        }
      }
      if (resultsRaw) setResults(JSON.parse(resultsRaw));
      if (progressRaw) {
        const raw = JSON.parse(progressRaw) as Record<string, any>;
        const migrated: Record<string, UserProgress> = {};
        for (const [k, v] of Object.entries(raw)) {
          let bests: number[] = v.stageBests ?? STAGES.map(() => 0);
          let passed: boolean[] = v.stagePassed ?? STAGES.map(() => false);
          if (bests.length > STAGES.length) bests = bests.slice(bests.length - STAGES.length);
          if (passed.length > STAGES.length) passed = passed.slice(passed.length - STAGES.length);
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
      if (uid === currentUserRef.current) setIsLoading(false);
    }
  }

  // Captures the active user at call-time. Writes are silently ignored if the
  // user changes before they execute, preventing cross-account data leakage.
  function safeWrite(uidAtCall: string, key: string, value: string) {
    if (uidAtCall !== currentUserRef.current) return;
    AsyncStorage.setItem(key, value).catch(() => {});
  }

  const addText = useCallback(async (text: LearningText) => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    setTexts((prev) => {
      const next = [text, ...prev.filter((t) => t.id !== text.id)];
      safeWrite(uidAtCall, K.TEXTS, JSON.stringify(next));
      return next;
    });
  }, []);

  const updateText = useCallback(async (id: string, partial: Partial<LearningText>) => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    setTexts((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, ...partial } : t));
      safeWrite(uidAtCall, K.TEXTS, JSON.stringify(next));
      return next;
    });
  }, []);

  const removeText = useCallback(async (id: string) => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    clearArticleAudio(uidAtCall, id).catch(() => {});
    setTexts((prev) => {
      const next = prev.filter((t) => t.id !== id);
      safeWrite(uidAtCall, K.TEXTS, JSON.stringify(next));
      return next;
    });
  }, []);

  const addResult = useCallback(async (result: SessionResult) => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    setResults((prev) => {
      const next = [result, ...prev].slice(0, 200);
      safeWrite(uidAtCall, K.RESULTS, JSON.stringify(next));
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
      safeWrite(uidAtCall, K.PROGRESS, JSON.stringify(next));
      return next;
    });
  }, []);

  const updateSettings = useCallback(async (partial: Partial<AppSettings>) => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      safeWrite(uidAtCall, K.SETTINGS, JSON.stringify(next));
      return next;
    });
  }, []);

  const persistLocalAccounts = useCallback(async (next: LocalAccount[]) => {
    setLocalAccounts(next);
    try {
      await AsyncStorage.setItem(LOCAL_ACCOUNTS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }, []);

  const createLocalAccount = useCallback(
    async (rawName: string) => {
      const name = rawName.trim() || "Local";
      const account: LocalAccount = { id: genId(), name, createdAt: Date.now() };
      const next = [...localAccounts, account];
      await persistLocalAccounts(next);
      // Auto-switch to the new local account (only effective when not signed
      // into Clerk; if signed in, Clerk userId still wins, but the active id
      // will be remembered for after sign-out).
      await AsyncStorage.setItem(ACTIVE_LOCAL_KEY, account.id);
      setActiveLocalAccountId(account.id);
      return account;
    },
    [localAccounts, persistLocalAccounts]
  );

  const switchLocalAccount = useCallback(
    async (id: string | null) => {
      if (id === null) {
        await AsyncStorage.removeItem(ACTIVE_LOCAL_KEY);
        setActiveLocalAccountId(null);
        return;
      }
      // Reject ids that don't correspond to a known local profile to avoid
      // entering a hidden scope with no addressable profile.
      if (!localAccounts.some((a) => a.id === id)) return;
      await AsyncStorage.setItem(ACTIVE_LOCAL_KEY, id);
      setActiveLocalAccountId(id);
    },
    [localAccounts]
  );

  const deleteLocalAccount = useCallback(
    async (id: string) => {
      // Wipe the account's scoped data
      const K = keysFor(`local:${id}`);
      try {
        await AsyncStorage.multiRemove([K.TEXTS, K.RESULTS, K.PROGRESS, K.SETTINGS]);
      } catch {
        // ignore
      }
      const next = localAccounts.filter((a) => a.id !== id);
      await persistLocalAccounts(next);
      if (activeLocalAccountId === id) {
        await AsyncStorage.removeItem(ACTIVE_LOCAL_KEY);
        setActiveLocalAccountId(null);
      }
    },
    [activeLocalAccountId, localAccounts, persistLocalAccounts]
  );

  const renameLocalAccount = useCallback(
    async (id: string, rawName: string) => {
      const name = rawName.trim();
      if (!name) return;
      const next = localAccounts.map((a) => (a.id === id ? { ...a, name } : a));
      await persistLocalAccounts(next);
    },
    [localAccounts, persistLocalAccounts]
  );

  const getProgressForText = useCallback(
    (textId: string) => progress[textId],
    [progress]
  );

  const activeLocalAccount = activeLocalAccountId
    ? localAccounts.find((a) => a.id === activeLocalAccountId) ?? null
    : null;

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
        isLoading: isLoading || !authLoaded || !localLoaded,
        userId,
        isGuest,
        localAccounts,
        activeLocalAccountId,
        activeLocalAccount,
        createLocalAccount,
        switchLocalAccount,
        deleteLocalAccount,
        renameLocalAccount,
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
