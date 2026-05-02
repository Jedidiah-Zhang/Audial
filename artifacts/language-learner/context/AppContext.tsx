import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "@clerk/expo";
import type {
  LearningText,
  SessionResult,
  UserProgress,
  AppSettings,
  SubscriptionState,
  SubscriptionTier,
} from "@/types";
import { DEFAULT_SUBSCRIPTION, STAGE_PASS_SCORE, STAGES } from "@/types";
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
    SUBSCRIPTION: `${prefix}subscription`,
    GENERATION_QUOTA: `${prefix}quota:generation`,
    UNLOCKED_ANALYSIS: `${prefix}rewards:analysis`,
  };
}

// Free-tier per-day generation quota mirror. The server is the
// authoritative store, but we keep a client-side count so the UI can
// display "X of 3 free left today" without an extra round-trip and
// optimistically render quota-exceeded states.
export const FREE_DAILY_GENERATION_LIMIT = 3;

// How long an unlocked per-sentence analysis stays unlocked. After this
// the user has to watch another rewarded ad or upgrade to Pro to view
// it again. 24h matches typical AdMob reward cadence and prevents
// indefinite stockpiling of unlocks.
const ANALYSIS_UNLOCK_TTL_MS = 24 * 60 * 60 * 1000;

interface DailyGenerationCount {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
}

function todayDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultGenerationCount(): DailyGenerationCount {
  return { date: todayDateKey(), count: 0 };
}

const DEFAULT_SETTINGS: AppSettings = {
  nativeLanguage: "en-US",
  targetLanguage: "en-US",
  defaultDifficulty: "intermediate",
  preferredVoice: "nova",
  // Default false: until the user explicitly picks a voice we use the
  // language-default voice per article (en-GB → fable, en-US → nova).
  preferredVoiceUserSet: false,
  autoPlayAudio: true,
  onboarded: false,
  themePreference: "system",
};

// One-shot migration: any persisted "en" code (settings + texts) is rewritten
// to "en-US" so the new variant-aware UI doesn't render a "globe" icon for
// legacy data and the AI/TTS layers can pick a default voice. Idempotent —
// guarded by a global flag in AsyncStorage.
const LANG_MIGRATION_FLAG = "ll:migrated_lang_v1";

async function migrateLegacyEnglishCodeIfNeeded() {
  try {
    const flag = await AsyncStorage.getItem(LANG_MIGRATION_FLAG);
    if (flag === "1") return;
    const allKeys = await AsyncStorage.getAllKeys();
    // Touch settings + texts under every per-user prefix the app may have
    // written (guest, local:*, Clerk userIds) plus the legacy unscoped keys.
    const targetKeys = allKeys.filter(
      (k) =>
        k === LEGACY_KEYS.SETTINGS ||
        k === LEGACY_KEYS.TEXTS ||
        (k.startsWith("ll:") && (k.endsWith(":settings") || k.endsWith(":texts")))
    );
    for (const key of targetKeys) {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        let mutated = false;
        if (key.endsWith(":settings") || key === LEGACY_KEYS.SETTINGS) {
          if (parsed && typeof parsed === "object") {
            if (parsed.nativeLanguage === "en") {
              parsed.nativeLanguage = "en-US";
              mutated = true;
            }
            if (parsed.targetLanguage === "en") {
              parsed.targetLanguage = "en-US";
              mutated = true;
            }
            // Backfill preferredVoiceUserSet for legacy installs. We can't
            // distinguish a user who explicitly picked the previous default
            // ("nova") from one who simply accepted it, so we treat only
            // persisted voices that differ from "nova" as evidence of an
            // explicit pick. Everyone else gets the new language-aware
            // defaults (en-GB → fable, en-US → nova) until they actively
            // choose something via the voice picker.
            if (parsed.preferredVoiceUserSet === undefined) {
              parsed.preferredVoiceUserSet =
                typeof parsed.preferredVoice === "string" &&
                parsed.preferredVoice !== "nova";
              mutated = true;
            }
          }
        } else if (Array.isArray(parsed)) {
          for (const t of parsed) {
            if (t && typeof t === "object") {
              if (t.targetLanguage === "en") {
                t.targetLanguage = "en-US";
                mutated = true;
              }
              if (t.nativeLanguage === "en") {
                t.nativeLanguage = "en-US";
                mutated = true;
              }
            }
          }
        }
        if (mutated) {
          await AsyncStorage.setItem(key, JSON.stringify(parsed));
        }
      } catch {
        // ignore individual parse failures
      }
    }
    await AsyncStorage.setItem(LANG_MIGRATION_FLAG, "1");
  } catch {
    // best effort
  }
}

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
  // Subscription (UI-only demo, no real billing)
  subscription: SubscriptionState;
  subscriptionTier: SubscriptionTier;
  isPro: boolean;
  upgradeToPro: () => Promise<void>;
  downgradeToFree: () => Promise<void>;
  // Free-tier daily generation quota mirror (server is authoritative).
  // For Pro users `dailyGenerationCount` still tracks usage but the UI
  // should ignore it (Pro is unlimited).
  dailyGenerationCount: DailyGenerationCount;
  generationLimit: number;
  generationsRemaining: number;
  incrementGenerationCount: () => Promise<void>;
  syncGenerationQuota: (entry: { date: string; count: number }) => Promise<void>;
  // Per-result detailed analysis unlocks (sessionResultId -> unlocked
  // timestamp). Free users must watch a rewarded ad to unlock; the
  // unlock persists for ANALYSIS_UNLOCK_TTL_MS.
  isAnalysisUnlocked: (resultId: string) => boolean;
  unlockAnalysis: (resultId: string) => Promise<void>;
  // Local (no-password, on-device) accounts
  localAccounts: LocalAccount[];
  activeLocalAccountId: string | null;
  activeLocalAccount: LocalAccount | null;
  createLocalAccount: (name: string) => Promise<LocalAccount>;
  switchLocalAccount: (id: string | null) => Promise<void>;
  deleteLocalAccount: (id: string) => Promise<void>;
  renameLocalAccount: (id: string, name: string) => Promise<void>;
}

export const AppContext = createContext<AppContextValue | null>(null);

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

  // Per-target session-level guard: skips re-running migration if React fires
  // the userId effect multiple times for the same destination in one session
  // (Clerk hydration jitter, OAuth redirect re-mount, StrictMode, etc).
  // Cleared whenever the user transitions back to the guest scope, so a
  // sign-out → add-guest-data → re-sign-in cycle still picks up the new data.
  // Cross-session safety relies on migrateGuestData() being idempotent (id-
  // based dedupe + target-wins on collision), so a cold restart that re-
  // attempts migration cannot duplicate previously-migrated data.
  const migratedTargetsRef = useRef<Set<string>>(new Set());
  // Global lock on the guest scope: at most one migration is in flight at a
  // time, regardless of target. This is the privacy-critical guard — without
  // it, two rapid auth transitions (guest → A → B) could race and copy the
  // same guest snapshot into multiple signed-in accounts. Serializing means
  // the first migration consumes & clears guest, the second sees empty and
  // is a no-op.
  const guestMigrationChainRef = useRef<Promise<void>>(Promise.resolve());

  const [texts, setTexts] = useState<LearningText[]>([]);
  const [results, setResults] = useState<SessionResult[]>([]);
  const [progress, setProgress] = useState<Record<string, UserProgress>>({});
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [subscription, setSubscription] = useState<SubscriptionState>(DEFAULT_SUBSCRIPTION);
  const [dailyGenerationCount, setDailyGenerationCount] = useState<DailyGenerationCount>(
    defaultGenerationCount(),
  );
  // Map of sessionResultId -> unlocked timestamp (ms). Pruned to entries
  // newer than ANALYSIS_UNLOCK_TTL_MS on load and on each unlock.
  const [unlockedAnalysis, setUnlockedAnalysis] = useState<Record<string, number>>({});
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
    currentUserRef.current = userId;
    setIsLoading(true);
    setTexts([]);
    setResults([]);
    setProgress({});
    setSettings(DEFAULT_SETTINGS);
    setSubscription(DEFAULT_SUBSCRIPTION);
    setDailyGenerationCount(defaultGenerationCount());
    setUnlockedAnalysis({});

    if (userId === GUEST_USER_ID) {
      // Returning to the guest scope means a future sign-in should be
      // allowed to absorb any data the user creates while signed out.
      migratedTargetsRef.current.clear();
    }

    (async () => {
      // Whenever we land on a non-guest user, attempt to absorb any data
      // currently sitting in the guest scope. migrateGuestData() is
      // idempotent and a no-op when the guest scope is empty, so this is
      // safe for every entry path into a signed-in session: hot sign-
      // in/sign-up, OAuth redirect, local-account switch, and cold start
      // straight into a Clerk session (the case the previous prev-user
      // condition was missing).
      if (userId !== GUEST_USER_ID) {
        await ensureGuestMigrated(userId);
      }
      // If the active user changed while migration was in flight, abort the
      // load — the next effect run will handle the new user.
      if (currentUserRef.current !== userId) return;
      loadAll(userId).catch(() => {});
    })();
  }, [authLoaded, localLoaded, userId]);

  async function ensureGuestMigrated(targetUserId: string): Promise<void> {
    if (migratedTargetsRef.current.has(targetUserId)) return;
    // Chain onto the global guest-source lock so concurrent migrations
    // serialize. Without this, a quick guest → A → B transition could let
    // both A's and B's effects read the same guest snapshot and clone it
    // into two accounts.
    const next = guestMigrationChainRef.current.then(async () => {
      // Re-check after acquiring the lock: an earlier link in the chain may
      // have already migrated to this target, or cleared the guest scope.
      if (migratedTargetsRef.current.has(targetUserId)) return;
      try {
        const moved = await migrateGuestData(targetUserId);
        if (moved) migratedTargetsRef.current.add(targetUserId);
      } catch {
        // best-effort; loadAll still runs and shows existing target data
      }
    });
    // Swallow rejections in the stored chain so one failure doesn't poison
    // every subsequent caller. Each individual await still sees its own
    // outcome via the try/catch above.
    guestMigrationChainRef.current = next.catch(() => {});
    await next;
  }

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
      await migrateLegacyEnglishCodeIfNeeded();
      await migrateLegacyIfNeeded(K, uid === GUEST_USER_ID);
      const [
        textsRaw,
        resultsRaw,
        progressRaw,
        settingsRaw,
        subscriptionRaw,
        quotaRaw,
        unlocksRaw,
      ] = await Promise.all([
        AsyncStorage.getItem(K.TEXTS),
        AsyncStorage.getItem(K.RESULTS),
        AsyncStorage.getItem(K.PROGRESS),
        AsyncStorage.getItem(K.SETTINGS),
        AsyncStorage.getItem(K.SUBSCRIPTION),
        AsyncStorage.getItem(K.GENERATION_QUOTA),
        AsyncStorage.getItem(K.UNLOCKED_ANALYSIS),
      ]);
      // Discard if user changed mid-load
      if (uid !== currentUserRef.current) return;
      if (textsRaw) {
        const parsed = JSON.parse(textsRaw) as LearningText[];
        let mutated = false;
        const migrated = parsed.map((t) => {
          let next = t;
          if (!next.contentType) {
            mutated = true;
            next = { ...next, contentType: detectContentType(next.text) };
          }
          // Older persisted entries pre-date the vocabulary feature and may
          // have no field at all. The type says it's required, so backfill
          // here so consumers can rely on .length without optional chaining.
          if (!Array.isArray(next.vocabulary)) {
            mutated = true;
            next = { ...next, vocabulary: [] };
          }
          return next;
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
      if (subscriptionRaw) {
        try {
          const parsed = JSON.parse(subscriptionRaw) as Partial<SubscriptionState>;
          // Defensive: only accept the two known tier values; everything else
          // collapses to "free" so corrupted state can't lock a user into Pro
          // or some unknown tier the UI can't handle.
          const tier: SubscriptionTier = parsed?.tier === "pro" ? "pro" : "free";
          setSubscription({
            tier,
            upgradedAt: tier === "pro" && typeof parsed.upgradedAt === "number"
              ? parsed.upgradedAt
              : undefined,
          });
        } catch {
          // ignore corrupted entry; default (free) stays in place
        }
      }
      if (quotaRaw) {
        try {
          const parsed = JSON.parse(quotaRaw) as Partial<DailyGenerationCount>;
          if (
            parsed &&
            typeof parsed.date === "string" &&
            typeof parsed.count === "number" &&
            parsed.date === todayDateKey()
          ) {
            // Only restore the count if the persisted entry is for today —
            // otherwise the next call resets to a fresh per-day window.
            setDailyGenerationCount({
              date: parsed.date,
              count: Math.max(0, Math.floor(parsed.count)),
            });
          } else {
            setDailyGenerationCount(defaultGenerationCount());
          }
        } catch {
          // corrupt — start fresh today
        }
      }
      if (unlocksRaw) {
        try {
          const parsed = JSON.parse(unlocksRaw) as Record<string, number>;
          const cutoff = Date.now() - ANALYSIS_UNLOCK_TTL_MS;
          const pruned: Record<string, number> = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "number" && v >= cutoff) pruned[k] = v;
          }
          setUnlockedAnalysis(pruned);
        } catch {
          // corrupt — drop all unlocks; user can re-watch ad
        }
      }
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

  // We keep a ref-mirror of each piece of state so the action functions can
  // compute the next value without doing side-effects inside a setState
  // updater (which would fire twice under StrictMode in dev).
  const textsRef = useRef<LearningText[]>([]);
  const resultsRef = useRef<SessionResult[]>([]);
  const progressRef = useRef<Record<string, UserProgress>>({});
  const settingsRef = useRef<AppSettings>(DEFAULT_SETTINGS);
  const subscriptionRef = useRef<SubscriptionState>(DEFAULT_SUBSCRIPTION);
  const dailyGenerationCountRef = useRef<DailyGenerationCount>(defaultGenerationCount());
  const unlockedAnalysisRef = useRef<Record<string, number>>({});
  textsRef.current = texts;
  resultsRef.current = results;
  progressRef.current = progress;
  settingsRef.current = settings;
  subscriptionRef.current = subscription;
  dailyGenerationCountRef.current = dailyGenerationCount;
  unlockedAnalysisRef.current = unlockedAnalysis;

  const addText = useCallback(async (text: LearningText) => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    const next = [text, ...textsRef.current.filter((t) => t.id !== text.id)];
    setTexts(next);
    safeWrite(uidAtCall, K.TEXTS, JSON.stringify(next));
  }, []);

  const updateText = useCallback(async (id: string, partial: Partial<LearningText>) => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    const next = textsRef.current.map((t) => (t.id === id ? { ...t, ...partial } : t));
    setTexts(next);
    safeWrite(uidAtCall, K.TEXTS, JSON.stringify(next));
  }, []);

  const removeText = useCallback(async (id: string) => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    clearArticleAudio(uidAtCall, id).catch(() => {});
    const next = textsRef.current.filter((t) => t.id !== id);
    setTexts(next);
    safeWrite(uidAtCall, K.TEXTS, JSON.stringify(next));
  }, []);

  const addResult = useCallback(async (result: SessionResult) => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);

    const nextResults = [result, ...resultsRef.current].slice(0, 200);
    setResults(nextResults);
    safeWrite(uidAtCall, K.RESULTS, JSON.stringify(nextResults));

    const existing = progressRef.current[result.textId] ?? defaultProgress(result.textId);
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
    const nextProgress = { ...progressRef.current, [result.textId]: updated };
    setProgress(nextProgress);
    safeWrite(uidAtCall, K.PROGRESS, JSON.stringify(nextProgress));
  }, []);

  const updateSettings = useCallback(async (partial: Partial<AppSettings>) => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    const next = { ...settingsRef.current, ...partial };
    setSettings(next);
    safeWrite(uidAtCall, K.SETTINGS, JSON.stringify(next));
  }, []);

  const upgradeToPro = useCallback(async () => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    // Preserve the original upgrade timestamp on repeat calls so a
    // downgrade → re-upgrade still records the new event without rewriting
    // history when called twice in a row.
    const existingUpgradedAt = subscriptionRef.current.tier === "pro"
      ? subscriptionRef.current.upgradedAt
      : undefined;
    const next: SubscriptionState = {
      tier: "pro",
      upgradedAt: existingUpgradedAt ?? Date.now(),
    };
    setSubscription(next);
    safeWrite(uidAtCall, K.SUBSCRIPTION, JSON.stringify(next));
  }, []);

  const downgradeToFree = useCallback(async () => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    const next: SubscriptionState = { tier: "free" };
    setSubscription(next);
    safeWrite(uidAtCall, K.SUBSCRIPTION, JSON.stringify(next));
  }, []);

  const incrementGenerationCount = useCallback(async () => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    const today = todayDateKey();
    const cur = dailyGenerationCountRef.current;
    const base = cur.date === today ? cur : { date: today, count: 0 };
    const next: DailyGenerationCount = { date: today, count: base.count + 1 };
    setDailyGenerationCount(next);
    safeWrite(uidAtCall, K.GENERATION_QUOTA, JSON.stringify(next));
  }, []);

  const syncGenerationQuota = useCallback(
    async (entry: { date: string; count: number }) => {
      const uidAtCall = currentUserRef.current;
      const K = keysFor(uidAtCall);
      const today = todayDateKey();
      // Server is authoritative; trust its date+count over the local
      // mirror, but ignore stale (non-today) responses to avoid wiping a
      // fresh count we just incremented locally.
      if (entry.date !== today) return;
      const next: DailyGenerationCount = {
        date: entry.date,
        count: Math.max(0, Math.floor(entry.count)),
      };
      setDailyGenerationCount(next);
      safeWrite(uidAtCall, K.GENERATION_QUOTA, JSON.stringify(next));
    },
    [],
  );

  const isAnalysisUnlocked = useCallback((resultId: string) => {
    const ts = unlockedAnalysisRef.current[resultId];
    if (typeof ts !== "number") return false;
    return ts >= Date.now() - ANALYSIS_UNLOCK_TTL_MS;
  }, []);

  const unlockAnalysis = useCallback(async (resultId: string) => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    const cutoff = Date.now() - ANALYSIS_UNLOCK_TTL_MS;
    const cur = unlockedAnalysisRef.current;
    // Drop any expired entries while we're touching the map; keeps
    // persisted state from growing unbounded over weeks of practice.
    const pruned: Record<string, number> = {};
    for (const [k, v] of Object.entries(cur)) {
      if (v >= cutoff) pruned[k] = v;
    }
    pruned[resultId] = Date.now();
    setUnlockedAnalysis(pruned);
    safeWrite(uidAtCall, K.UNLOCKED_ANALYSIS, JSON.stringify(pruned));
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
        await AsyncStorage.multiRemove([K.TEXTS, K.RESULTS, K.PROGRESS, K.SETTINGS, K.SUBSCRIPTION]);
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
        subscription,
        subscriptionTier: subscription.tier,
        isPro: subscription.tier === "pro",
        upgradeToPro,
        downgradeToFree,
        dailyGenerationCount,
        generationLimit: FREE_DAILY_GENERATION_LIMIT,
        generationsRemaining:
          subscription.tier === "pro"
            ? Number.POSITIVE_INFINITY
            : Math.max(0, FREE_DAILY_GENERATION_LIMIT - dailyGenerationCount.count),
        incrementGenerationCount,
        syncGenerationQuota,
        isAnalysisUnlocked,
        unlockAnalysis,
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
