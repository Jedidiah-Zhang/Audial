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
import {
  listSavedAccounts,
  notifySavedAccountsChanged,
  removeSavedAccount,
  upsertSavedAccount,
} from "@/utils/savedAccounts";
import {
  buildPushFromQueue,
  enqueuePending,
  isCloudSyncableUser,
  mergeSnapshot,
  pullSnapshot,
  pushDelta,
  pushSubscriptionTier,
  pushUserNativeLanguage,
  readPending,
  writePending,
} from "@/utils/cloudSync";

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
  date: string; // YYYY-MM-DD bucket key — see todayDateKey() below.
  count: number;
}

/**
 * Bucket date for the daily quota. Rolls over at 04:00 Asia/Shanghai
 * (UTC+8) so every user worldwide hits a daily reset at the exact same
 * wall-clock instant — and the client mirror never disagrees with the
 * server's authoritative count. Must stay in sync with `todayKey()` in
 * artifacts/api-server/src/routes/language.ts; 4am Shanghai was chosen
 * because it minimizes mid-session rollovers anywhere on the globe.
 *
 * Exported so app/generate.tsx can use the same key when relabeling
 * server quota responses, instead of re-deriving the rollover logic.
 */
export function todayDateKey(): string {
  // China 04:00 = UTC (previous day) 20:00. Adding 4h to UTC time
  // shifts that rollover to UTC midnight so we can just take the
  // ISO date.
  const shifted = new Date(Date.now() + 4 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The next moment the daily quota will reset, as a real `Date`. Same
 * rule as `todayDateKey()`: 04:00 Asia/Shanghai daily. Returned in the
 * device's local clock so callers can format it however they want
 * (toLocaleTimeString, etc.) without re-deriving the timezone math.
 *
 * Implementation: in the "shifted UTC" space (UTC + 4h), the reset
 * happens at midnight, so we find the next shifted-midnight and map
 * back to real UTC by subtracting the 4h shift. This stays correct
 * regardless of the device's own timezone.
 */
export function nextQuotaResetAt(): Date {
  const shiftMs = 4 * 60 * 60 * 1000;
  const shifted = new Date(Date.now() + shiftMs);
  const nextShiftedMidnightUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + 1, // tomorrow in shifted space = next reset
    0,
    0,
    0,
    0,
  );
  return new Date(nextShiftedMidnightUtc - shiftMs);
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
  recordTextClick: (id: string) => Promise<void>;
  addResult: (result: SessionResult) => Promise<void>;
  updateSettings: (s: Partial<AppSettings>) => Promise<void>;
  getProgressForText: (textId: string) => UserProgress | undefined;
  isLoading: boolean;
  userId: string;
  isGuest: boolean;
  isLocalAccount: boolean;
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
  /**
   * Single source of truth for "is this user allowed to create another
   * article right now?". All article-creation entry points should call
   * this *before* hitting the network so free users at the daily cap
   * see the paywall flow without a wasted round-trip.
   *
   * - Pro users: always `{ allowed: true, remaining: Infinity }`.
   * - Free users: gated by today's persisted count vs
   *   `FREE_DAILY_GENERATION_LIMIT`.
   *
   * Note: this only protects the *create* step (the one that triggers
   * paid TTS generation downstream). It does not gate retries / edits /
   * re-translates of an already-saved article — those are intentionally
   * free.
   */
  canCreateArticle: () => { allowed: boolean; remaining: number };
  incrementGenerationCount: () => Promise<void>;
  syncGenerationQuota: (entry: { date: string; count: number }) => Promise<void>;
  // Per-result detailed analysis unlocks (sessionResultId -> unlocked
  // timestamp). Free users must watch a rewarded ad to unlock; the
  // unlock persists for ANALYSIS_UNLOCK_TTL_MS.
  isAnalysisUnlocked: (resultId: string) => boolean;
  unlockAnalysis: (resultId: string) => Promise<void>;
  // Cloud sync status (Clerk-signed-in users only). For guests and
  // local accounts these stay at their initial values and the UI
  // indicator is hidden.
  syncStatus: SyncStatus;
  syncPendingCount: number;
  lastSyncedAt: number | null;
  /**
   * Trigger a best-effort full sync now. Safe to call repeatedly:
   * concurrent invocations collapse to a single in-flight run. No-op
   * for non-cloud-syncable users.
   */
  forceSync: () => Promise<void>;
  // Local (no-password, on-device) accounts
  localAccounts: LocalAccount[];
  activeLocalAccountId: string | null;
  activeLocalAccount: LocalAccount | null;
  createLocalAccount: (name: string) => Promise<LocalAccount>;
  switchLocalAccount: (id: string | null) => Promise<void>;
  deleteLocalAccount: (id: string) => Promise<void>;
  renameLocalAccount: (id: string, name: string) => Promise<void>;
}

/**
 * Cloud sync state shown by the SyncIndicator UI.
 *
 * - `idle`: no sync attempted yet (initial mount, just-switched user, or
 *   a non-cloud-syncable account where the indicator stays hidden).
 * - `syncing`: a push or full sync is in flight.
 * - `synced`: most recent attempt succeeded; `lastSyncedAt` is set.
 * - `offline`: most recent attempt failed (network/5xx). Local writes
 *   are queued and will retry on the next mutation or manual tap.
 * - `error`: an unexpected exception was thrown — kept distinct from
 *   `offline` so we can surface a different message ("Sync failed") and
 *   not confuse it with a normal network outage.
 */
export type SyncStatus = "idle" | "syncing" | "synced" | "offline" | "error";

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
  const isLocalAccount = !clerkUserId && !!activeLocalAccountId;

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

  // Cloud sync UI state. `syncStatus` reflects the most recent
  // push/pull attempt for the *current* signed-in user. We also mirror
  // the pending-queue size into state so the indicator can show
  // "X changes pending" without polling AsyncStorage on every render.
  // `runningSyncRef` collapses concurrent forceSync() calls into a
  // single in-flight run so a double-tap doesn't fire two parallel
  // pull/merge cycles (which would race writes to local storage).
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncPendingCount, setSyncPendingCount] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const runningSyncRef = useRef<Promise<void> | null>(null);

  function pendingTotal(q: {
    textIds: string[];
    deletedTextIds: string[];
    resultIds: string[];
    progressTextIds: string[];
  }): number {
    return (
      q.textIds.length +
      q.deletedTextIds.length +
      q.resultIds.length +
      q.progressTextIds.length
    );
  }

  // Re-read the persisted pending queue and reflect its size in state.
  // Called after every enqueue / flush so the indicator stays accurate.
  async function refreshPendingCount(uid: string) {
    if (!isCloudSyncableUser(uid)) {
      if (uid === currentUserRef.current) setSyncPendingCount(0);
      return;
    }
    try {
      const q = await readPending(uid);
      if (uid === currentUserRef.current) setSyncPendingCount(pendingTotal(q));
    } catch {
      // best effort
    }
  }

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
    // Capture the previous user's language *before* we wipe state. New
    // accounts (sign-up, first OAuth, brand-new local profile) start with
    // no persisted settings under their own scope; in that case loadAll
    // would otherwise reset the UI to en-US, undoing whatever language
    // the user just selected on the auth screen. We re-apply this on the
    // new scope only when no settings exist there yet — returning users
    // with persisted settings (or a cloud-stored language) still win.
    const inheritedLanguage = settingsRef.current.nativeLanguage;
    currentUserRef.current = userId;
    setIsLoading(true);
    setTexts([]);
    setResults([]);
    setProgress({});
    setSettings(DEFAULT_SETTINGS);
    setSubscription(DEFAULT_SUBSCRIPTION);
    setDailyGenerationCount(defaultGenerationCount());
    setUnlockedAnalysis({});
    // Reset sync UI state — anything we knew belonged to the previous
    // user. A fresh full-sync below will repopulate for cloud users.
    setSyncStatus("idle");
    setSyncPendingCount(0);
    setLastSyncedAt(null);
    clearSyncRetryTimer();

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
      await loadAll(userId, inheritedLanguage).catch(() => {});
      if (currentUserRef.current !== userId) return;
      // Cloud sync runs only for Clerk-signed-in users. Local-only and
      // guest profiles intentionally stay device-only (the task scopes
      // sync to "登录用户的核心数据").
      if (isCloudSyncableUser(userId)) {
        await refreshPendingCount(userId);
        // Serialise with any user-initiated forceSync so a tap during
        // the initial sync doesn't start a parallel run.
        if (runningSyncRef.current) {
          await runningSyncRef.current;
        }
        const p = runFullSync(userId).finally(() => {
          runningSyncRef.current = null;
        });
        runningSyncRef.current = p;
      }
    })();
  }, [authLoaded, localLoaded, userId]);

  /**
   * One-shot cloud reconciliation for `uid`. Order is critical to avoid
   * losing offline edits:
   *
   *   1. Push the pending queue using the *current* local state — these
   *      are edits made while we were offline (or while the previous
   *      sync attempt failed). They include records that may also exist
   *      in cloud with a stale value; we want our newer value to land
   *      on the server before we merge the cloud back.
   *   2. Pull the cloud snapshot. Because step 1 already updated those
   *      records server-side, the snapshot will reflect our offline
   *      edits and the cloud-wins merge below preserves them.
   *   3. Merge cloud → local (cloud-wins on id), persist locally.
   *   4. Push any items present locally but absent from cloud (e.g.
   *      legacy items from before sync existed and never queued).
   *
   * If step 1 fails (offline, 5xx) we abort: applying step 3 first
   * would overwrite our offline edits with the older cloud values and
   * silently destroy them.
   */
  async function runFullSync(uid: string): Promise<void> {
    if (uid === currentUserRef.current) setSyncStatus("syncing");
    try {
      await runFullSyncInner(uid);
      // If runFullSyncInner returned without throwing and without an
      // early "offline" return, it reached "synced" — cancel any
      // pending retry.
      if (uid === currentUserRef.current) clearSyncRetryTimer();
    } catch {
      // Anything other than "pushDelta returned false" lands here. Use
      // the distinct `error` state so the indicator can say "Sync
      // failed" instead of "Offline". Schedule a retry for transient
      // failures (cold start, token refresh, etc.).
      if (uid === currentUserRef.current) {
        setSyncStatus("error");
        scheduleSyncRetry(uid);
      }
    } finally {
      // Always refresh the pending count — both success (queue cleared)
      // and failure (queue retained / re-enqueued) need to show the
      // accurate number.
      await refreshPendingCount(uid);
    }
  }

  async function runFullSyncInner(uid: string): Promise<void> {
    const localBefore = {
      texts: textsRef.current,
      results: resultsRef.current,
      progress: progressRef.current,
    };

    // Step 1: push pending offline writes (with current local values).
    const queued = await readPending(uid);
    const queuedPayload = buildPushFromQueue(localBefore, queued);
    const queueOk = await pushDelta(queuedPayload);
    if (!queueOk) {
      // Still offline. Leave the queue intact for the next attempt and
      // do NOT pull/merge — that would overwrite the offline edits.
      if (uid === currentUserRef.current) {
        setSyncStatus("offline");
        scheduleSyncRetry(uid);
      }
      return;
    }
    await writePending(uid, {
      textIds: [],
      deletedTextIds: [],
      resultIds: [],
      progressTextIds: [],
    });
    if (uid !== currentUserRef.current) return;

    // Step 2: pull the snapshot (now reflects our pushed offline edits).
    const snap = await pullSnapshot();
    if (uid !== currentUserRef.current) return;
    if (!snap) {
      // Push worked but pull failed — partial success. Mark offline so
      // the user knows their device may be out of date even though
      // their writes did go up.
      if (uid === currentUserRef.current) {
        setSyncStatus("offline");
        scheduleSyncRetry(uid);
      }
      return;
    }

    // Step 3: merge cloud → local, persist. Tombstones from step 1's
    // deletedTextIds are honored because the cloud no longer has those
    // ids; we also strip them from local in case they lingered.
    const deletedSet = new Set(queued.deletedTextIds);
    const localAfterDelete = {
      texts: localBefore.texts.filter((t) => !deletedSet.has(t.id)),
      results: localBefore.results.filter(
        (r) => !deletedSet.has(r.textId),
      ),
      progress: Object.fromEntries(
        Object.entries(localBefore.progress).filter(
          ([textId]) => !deletedSet.has(textId),
        ),
      ),
    };
    const { merged, toPush } = mergeSnapshot(localAfterDelete, snap);
    if (uid !== currentUserRef.current) return;
    const K = keysFor(uid);
    setTexts(merged.texts);
    setResults(merged.results);
    setProgress(merged.progress);
    setSubscription(merged.subscription);
    safeWrite(uid, K.TEXTS, JSON.stringify(merged.texts));
    safeWrite(uid, K.RESULTS, JSON.stringify(merged.results));
    safeWrite(uid, K.PROGRESS, JSON.stringify(merged.progress));
    safeWrite(uid, K.SUBSCRIPTION, JSON.stringify(merged.subscription));

    // Cloud-wins for the user's interface language: if the server has a
    // saved language for this account, adopt it and persist locally so
    // returning users on a new device land in their preferred language
    // without re-prompting. If the server has nothing yet (first sync
    // after sign-up), push the local value up so the next device can
    // adopt it.
    const cloudLang = snap.settings?.nativeLanguage;
    if (typeof cloudLang === "string" && cloudLang.length > 0) {
      const mergedSettings: AppSettings = {
        ...settingsRef.current,
        nativeLanguage: cloudLang,
        onboarded: true,
      };
      setSettings(mergedSettings);
      safeWrite(uid, K.SETTINGS, JSON.stringify(mergedSettings));
    } else if (
      settingsRef.current.nativeLanguage &&
      settingsRef.current.nativeLanguage.length > 0
    ) {
      void pushUserNativeLanguage(settingsRef.current.nativeLanguage);
    }

    // Step 4: push local-only items (ids not in cloud). Treat a failure
    // here as "offline" too — the queued payload made it (Step 1) but
    // the local-only catch-up didn't.
    const localPushOk = await pushDelta(toPush);
    if (uid !== currentUserRef.current) return;
    if (!localPushOk) {
      setSyncStatus("offline");
      scheduleSyncRetry(uid);
      return;
    }
    setSyncStatus("synced");
    clearSyncRetryTimer();
    setLastSyncedAt(Date.now());
  }

  /**
   * Push only the pending queue (used when we've already failed to
   * pull, but still want to surface any offline writes to the server).
   */
  async function flushPending(uid: string): Promise<void> {
    if (uid === currentUserRef.current) setSyncStatus("syncing");
    try {
      const queued = await readPending(uid);
      const payload = buildPushFromQueue(
        {
          texts: textsRef.current,
          results: resultsRef.current,
          progress: progressRef.current,
        },
        queued,
      );
      const ok = await pushDelta(payload);
      if (ok) {
        await writePending(uid, {
          textIds: [],
          deletedTextIds: [],
          resultIds: [],
          progressTextIds: [],
        });
        if (uid === currentUserRef.current) {
          setSyncStatus("synced");
          clearSyncRetryTimer();
          setLastSyncedAt(Date.now());
        }
      } else if (uid === currentUserRef.current) {
        setSyncStatus("offline");
        scheduleSyncRetry(uid);
      }
    } catch {
      if (uid === currentUserRef.current) {
        setSyncStatus("error");
        scheduleSyncRetry(uid);
      }
    } finally {
      await refreshPendingCount(uid);
    }
  }

  /**
   * Schedule a cloud push for the given record id(s). Always enqueues
   * (so an offline failure is durable across restarts) and then fires
   * a best-effort flush. The flush reads the *current* local snapshot
   * for those ids, so multiple rapid edits to the same record collapse
   * into a single network push of the latest value.
   */
  function scheduleCloudPush(
    uid: string,
    patch: {
      textIds?: string[];
      deletedTextIds?: string[];
      resultIds?: string[];
      progressTextIds?: string[];
    },
  ) {
    if (!isCloudSyncableUser(uid)) return;
    void (async () => {
      await enqueuePending(uid, patch);
      // Reflect the just-enqueued items immediately so the indicator
      // shows the new "X pending" before the network call resolves.
      await refreshPendingCount(uid);
      await flushPending(uid);
    })();
  }

  /**
   * User-initiated sync (tap on the SyncIndicator). If a sync is
   * already in-flight we wait for it to settle and then start a fresh
   * one — the user explicitly asked to retry, so just waiting isn't
   * enough. After the in-flight run finishes we always launch a new
   * attempt.
   */
  const forceSync = useCallback(async () => {
    const uid = currentUserRef.current;
    if (!isCloudSyncableUser(uid)) return;
    if (runningSyncRef.current) {
      await runningSyncRef.current;
    }
    const p = runFullSync(uid).finally(() => {
      runningSyncRef.current = null;
    });
    runningSyncRef.current = p;
    await p;
  }, []);

  // One-shot auto-retry timer for the first sync after a user change.
  // Guards against transient failures (token not yet cached, cold start
  // of the Edge Function, etc.) without looping indefinitely. Cleared on
  // user change and on successful sync.
  const syncRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearSyncRetryTimer() {
    if (syncRetryTimerRef.current !== null) {
      clearTimeout(syncRetryTimerRef.current);
      syncRetryTimerRef.current = null;
    }
  }

  function scheduleSyncRetry(uid: string) {
    clearSyncRetryTimer();
    syncRetryTimerRef.current = setTimeout(() => {
      syncRetryTimerRef.current = null;
      if (uid !== currentUserRef.current) return;
      if (!isCloudSyncableUser(uid)) return;
      // Don't clash with a user-initiated forceSync already in flight.
      if (runningSyncRef.current) return;
      const p = runFullSync(uid).finally(() => {
        runningSyncRef.current = null;
      });
      runningSyncRef.current = p;
    }, 3000);
  }

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

  async function loadAll(uid: string, inheritedLanguage?: string) {
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
        const sorted = migrated.sort(
          (a, b) => (b.lastClickedAt ?? 0) - (a.lastClickedAt ?? 0) || b.createdAt - a.createdAt,
        );
        setTexts(sorted);
        if (mutated) {
          AsyncStorage.setItem(K.TEXTS, JSON.stringify(sorted));
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
      if (settingsRaw) {
        // Tolerate legacy fields from older app versions (e.g. `autoPlayAudio`,
        // which has been removed). We strip unknown keys here so the merged
        // state stays clean and the next `updateSettings` write naturally
        // drops them from persistent storage.
        const parsedSettings = JSON.parse(settingsRaw) as Record<string, unknown>;
        const { autoPlayAudio: _legacyAutoPlayAudio, ...rest } = parsedSettings;
        void _legacyAutoPlayAudio;
        setSettings({ ...DEFAULT_SETTINGS, ...(rest as Partial<AppSettings>) });
      } else if (uid !== GUEST_USER_ID) {
        // Brand-new account scope (no settings file yet). Reaching this
        // branch means the user came through the auth flow — Clerk
        // sign-in/sign-up or local-profile creation — so first-launch
        // onboarding is complete regardless of which language they
        // picked. We also carry over the language they were viewing the
        // app in (the auth screens have a globe switcher) so we don't
        // snap the UI back to en-US on the first frame after auth.
        // Critically, we mark onboarded:true even when the language is
        // unchanged, otherwise the (tabs) gate would redirect back to
        // /(auth)/sign-in while sign-in's isSignedIn effect redirects
        // forward to /(tabs), causing a loop.
        const seeded: AppSettings = {
          ...DEFAULT_SETTINGS,
          nativeLanguage: inheritedLanguage ?? DEFAULT_SETTINGS.nativeLanguage,
          onboarded: true,
        };
        setSettings(seeded);
        safeWrite(uid, K.SETTINGS, JSON.stringify(seeded));
      }
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
    const withClick = { ...text, lastClickedAt: Date.now() };
    const next = [withClick, ...textsRef.current.filter((t) => t.id !== text.id)];
    setTexts(next);
    safeWrite(uidAtCall, K.TEXTS, JSON.stringify(next));
    scheduleCloudPush(uidAtCall, { textIds: [text.id] });
  }, []);

  const updateText = useCallback(async (id: string, partial: Partial<LearningText>) => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    const next = textsRef.current.map((t) => (t.id === id ? { ...t, ...partial } : t));
    setTexts(next);
    safeWrite(uidAtCall, K.TEXTS, JSON.stringify(next));
    scheduleCloudPush(uidAtCall, { textIds: [id] });
  }, []);

  const removeText = useCallback(async (id: string) => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    clearArticleAudio(uidAtCall, id).catch(() => {});
    const next = textsRef.current.filter((t) => t.id !== id);
    setTexts(next);
    safeWrite(uidAtCall, K.TEXTS, JSON.stringify(next));
    scheduleCloudPush(uidAtCall, { deletedTextIds: [id] });
  }, []);

  const recordTextClick = useCallback(async (id: string) => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    const now = Date.now();
    const next = textsRef.current
      .map((t) => (t.id === id ? { ...t, lastClickedAt: now } : t))
      .sort((a, b) => (b.lastClickedAt ?? 0) - (a.lastClickedAt ?? 0) || b.createdAt - a.createdAt);
    setTexts(next);
    safeWrite(uidAtCall, K.TEXTS, JSON.stringify(next));
    scheduleCloudPush(uidAtCall, { textIds: [id] });
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
    scheduleCloudPush(uidAtCall, {
      resultIds: [result.id],
      progressTextIds: [result.textId],
    });
  }, []);

  const updateSettings = useCallback(async (partial: Partial<AppSettings>) => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    const prev = settingsRef.current;
    const next = { ...prev, ...partial };
    setSettings(next);
    safeWrite(uidAtCall, K.SETTINGS, JSON.stringify(next));
    // Mirror the user's interface language to the server so other
    // devices the same Clerk user signs in on can pre-fill the UI in
    // their preferred language without re-prompting. Fire-and-forget;
    // if the network call fails the local write still stands and the
    // next /sync/snapshot pass will resurface it.
    if (
      isCloudSyncableUser(uidAtCall) &&
      typeof partial.nativeLanguage === "string" &&
      partial.nativeLanguage.length > 0 &&
      partial.nativeLanguage !== prev.nativeLanguage
    ) {
      void pushUserNativeLanguage(partial.nativeLanguage);
    }
  }, []);

  const upgradeToPro = useCallback(async () => {
    const uidAtCall = currentUserRef.current;
    // Only cloud-syncable (Clerk-authenticated) users can subscribe.
    // Guests and local accounts are device-only and must sign in first.
    if (!isCloudSyncableUser(uidAtCall)) return;
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
    void pushSubscriptionTier("pro");
  }, []);

  const downgradeToFree = useCallback(async () => {
    const uidAtCall = currentUserRef.current;
    const K = keysFor(uidAtCall);
    const next: SubscriptionState = { tier: "free" };
    setSubscription(next);
    safeWrite(uidAtCall, K.SUBSCRIPTION, JSON.stringify(next));
    if (isCloudSyncableUser(uidAtCall)) {
      void pushSubscriptionTier("free");
    }
  }, []);

  // Pure read of the current quota state; safe to call from render and
  // from event handlers. Centralized here so every "create article"
  // entry point gates on the exact same logic.
  const canCreateArticle = useCallback((): { allowed: boolean; remaining: number } => {
    if (subscriptionRef.current.tier === "pro" && isCloudSyncableUser(currentUserRef.current)) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY };
    }
    const today = todayDateKey();
    const cur = dailyGenerationCountRef.current;
    const usedToday = cur.date === today ? cur.count : 0;
    const remaining = Math.max(0, FREE_DAILY_GENERATION_LIMIT - usedToday);
    return { allowed: remaining > 0, remaining };
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
      // Pre-seed the new profile's settings scope with the language the
      // user is currently viewing the app in (and mark onboarded so the
      // language picker doesn't reappear). We have to write directly via
      // AsyncStorage because the active user is still about to flip —
      // updateSettings() would persist under the previous scope. Once
      // we flip activeLocalAccountId, the loadAll effect picks this file
      // up under the new userId. See the matching inheritedLanguage path
      // in the auth-change effect for cloud accounts.
      try {
        const newKeys = keysFor(`local:${account.id}`);
        const seededSettings: AppSettings = {
          ...DEFAULT_SETTINGS,
          nativeLanguage: settingsRef.current.nativeLanguage,
          onboarded: true,
        };
        await AsyncStorage.setItem(
          newKeys.SETTINGS,
          JSON.stringify(seededSettings),
        );
      } catch {
        // best-effort; loadAll's inheritedLanguage fallback covers us
      }
      // Auto-switch to the new local account (only effective when not signed
      // into Clerk; if signed in, Clerk userId still wins, but the active id
      // will be remembered for after sign-out).
      await AsyncStorage.setItem(ACTIVE_LOCAL_KEY, account.id);
      setActiveLocalAccountId(account.id);
      // Surface the new local profile in the cross-screen "saved
      // accounts" picker so it shows up on the sign-in screen too.
      try {
        await upsertSavedAccount({
          id: account.id,
          kind: "local",
          displayName: account.name,
          lastMethod: "local",
        });
        notifySavedAccountsChanged();
      } catch {
        // best-effort
      }
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
      const matched = localAccounts.find((a) => a.id === id);
      if (!matched) return;
      await AsyncStorage.setItem(ACTIVE_LOCAL_KEY, id);
      setActiveLocalAccountId(id);
      try {
        await upsertSavedAccount({
          id: matched.id,
          kind: "local",
          displayName: matched.name,
          lastMethod: "local",
        });
        notifySavedAccountsChanged();
      } catch {
        // best-effort
      }
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
      // Drop the deleted profile from the saved-accounts picker too;
      // otherwise it would offer a one-tap entry into a profile that
      // no longer exists.
      try {
        await removeSavedAccount("local", id);
        notifySavedAccountsChanged();
      } catch {
        // best-effort
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
      try {
        // Renames shouldn't change the entry's position in the picker.
        // Look up the existing timestamp (if any) and reuse it so the
        // ordering stays stable; falling back to `now` only when there
        // is no prior entry to preserve.
        const existing = (await listSavedAccounts()).find(
          (a) => a.kind === "local" && a.id === id,
        );
        await upsertSavedAccount({
          id,
          kind: "local",
          displayName: name,
          lastMethod: "local",
          lastUsedAt: existing?.lastUsedAt ?? Date.now(),
        });
        notifySavedAccountsChanged();
      } catch {
        // best-effort
      }
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
        recordTextClick,
        addResult,
        updateSettings,
        getProgressForText,
        isLoading: isLoading || !authLoaded || !localLoaded,
        userId,
        isGuest,
        isLocalAccount,
        subscription,
        subscriptionTier: subscription.tier,
        isPro: subscription.tier === "pro" && isCloudSyncableUser(userId),
        upgradeToPro,
        downgradeToFree,
        dailyGenerationCount,
        generationLimit: FREE_DAILY_GENERATION_LIMIT,
        // Mirrors `canCreateArticle().remaining` so the UI never shows a
        // stale chip after the local-date rolls over (e.g. user kept the
        // app open through midnight). Treat any persisted count whose
        // date isn't today's local date as 0 used.
        generationsRemaining:
          subscription.tier === "pro" && isCloudSyncableUser(userId)
            ? Number.POSITIVE_INFINITY
            : Math.max(
                0,
                FREE_DAILY_GENERATION_LIMIT -
                  (dailyGenerationCount.date === todayDateKey()
                    ? dailyGenerationCount.count
                    : 0),
              ),
        canCreateArticle,
        incrementGenerationCount,
        syncGenerationQuota,
        isAnalysisUnlocked,
        unlockAnalysis,
        syncStatus,
        syncPendingCount,
        lastSyncedAt,
        forceSync,
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
