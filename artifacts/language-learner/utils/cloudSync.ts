import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  getSyncSnapshot,
  pushSync,
  setSubscription as apiSetSubscription,
  setUserSettings as apiSetUserSettings,
  type SyncSnapshot,
  type SyncPushPayload,
  type SubscriptionState as ApiSubscriptionState,
} from "../api-client";
import type {
  LearningText,
  SessionResult,
  UserProgress,
  SubscriptionState,
} from "@/types";
import { STAGES } from "@/types";

/**
 * Cloud sync helpers used by AppContext to keep a Clerk-signed-in
 * user's data consistent across devices. Guests (no Clerk userId) and
 * local-only profiles never call into here — their data stays on-device.
 *
 * Conflict policy: cloud-wins for items already present in cloud (the
 * cloud row carries the most recent server-side updatedAt). Items that
 * only exist locally are pushed up. This is the "last write + server
 * timestamp" model called out by the task: no per-field merging.
 *
 * Offline behaviour: failed pushes are stored in a per-user pending
 * queue (`ll:cloudPending:{userId}`) and retried on the next successful
 * sync attempt. The queue stores ids, not full payloads, so we always
 * push the latest local snapshot for those records when we retry.
 */

export interface PendingQueue {
  textIds: string[];
  deletedTextIds: string[];
  resultIds: string[];
  progressTextIds: string[];
}

const EMPTY_PENDING: PendingQueue = {
  textIds: [],
  deletedTextIds: [],
  resultIds: [],
  progressTextIds: [],
};

function pendingKey(userId: string): string {
  return `ll:cloudPending:${userId}`;
}

export function isCloudSyncableUser(userId: string): boolean {
  return Boolean(userId) && userId !== "guest" && !userId.startsWith("local:");
}

export async function readPending(userId: string): Promise<PendingQueue> {
  try {
    const raw = await AsyncStorage.getItem(pendingKey(userId));
    if (!raw) return { ...EMPTY_PENDING };
    const parsed = JSON.parse(raw) as Partial<PendingQueue>;
    return {
      textIds: Array.isArray(parsed.textIds) ? parsed.textIds : [],
      deletedTextIds: Array.isArray(parsed.deletedTextIds)
        ? parsed.deletedTextIds
        : [],
      resultIds: Array.isArray(parsed.resultIds) ? parsed.resultIds : [],
      progressTextIds: Array.isArray(parsed.progressTextIds)
        ? parsed.progressTextIds
        : [],
    };
  } catch {
    return { ...EMPTY_PENDING };
  }
}

export async function writePending(
  userId: string,
  q: PendingQueue,
): Promise<void> {
  try {
    if (
      q.textIds.length === 0 &&
      q.deletedTextIds.length === 0 &&
      q.resultIds.length === 0 &&
      q.progressTextIds.length === 0
    ) {
      await AsyncStorage.removeItem(pendingKey(userId));
    } else {
      await AsyncStorage.setItem(pendingKey(userId), JSON.stringify(q));
    }
  } catch {
    // best effort
  }
}

export async function enqueuePending(
  userId: string,
  patch: Partial<PendingQueue>,
): Promise<void> {
  const cur = await readPending(userId);
  const merge = (a: string[], b: string[] | undefined) =>
    Array.from(new Set([...a, ...(b ?? [])]));
  const next: PendingQueue = {
    textIds: merge(cur.textIds, patch.textIds),
    deletedTextIds: merge(cur.deletedTextIds, patch.deletedTextIds),
    resultIds: merge(cur.resultIds, patch.resultIds),
    progressTextIds: merge(cur.progressTextIds, patch.progressTextIds),
  };
  await writePending(userId, next);
}

export interface LocalSnapshot {
  texts: LearningText[];
  results: SessionResult[];
  progress: Record<string, UserProgress>;
}

export interface MergedSnapshot extends LocalSnapshot {
  subscription: SubscriptionState;
}

/**
 * Merge the cloud snapshot into the local one (cloud-wins on id
 * collision) and return the merged result plus the local-only items
 * that should be pushed back up.
 */
export function mergeSnapshot(
  local: LocalSnapshot,
  cloud: SyncSnapshot,
): {
  merged: MergedSnapshot;
  toPush: SyncPushPayload;
} {
  const cloudTextIds = new Set(cloud.texts.map((t) => t.id));
  const cloudResultIds = new Set(cloud.results.map((r) => r.id));
  const cloudProgressTextIds = new Set(cloud.progress.map((p) => p.textId));

  // Build a lookup of local texts so we can preserve client-only cache
  // fields (translations, vocabularyCache) that don't exist on the server.
  const localTextById = new Map(local.texts.map((t) => [t.id, t]));

  const cloudTexts: LearningText[] = cloud.texts.map((t) => {
    const local = localTextById.get(t.id);
    return {
      id: t.id,
      title: t.title,
      text: t.text,
      translation: t.translation,
      vocabulary: (t.vocabulary as LearningText["vocabulary"]) ?? [],
      topic: t.topic,
      difficulty: t.difficulty as LearningText["difficulty"],
      targetLanguage: t.targetLanguage,
      nativeLanguage: t.nativeLanguage,
      contentType:
        (t.contentType as LearningText["contentType"]) ?? undefined,
      createdAt:
        typeof t.createdAt === "number" ? t.createdAt : Date.now(),
      lastClickedAt:
        typeof t.lastClickedAt === "number" ? t.lastClickedAt : undefined,
      // Preserve local translation cache — the server schema doesn't
      // store these, so the cloud version always has undefined.
      translations: local?.translations,
      vocabularyCache: local?.vocabularyCache,
    };
  });

  const localOnlyTexts = local.texts.filter((t) => !cloudTextIds.has(t.id));
  const mergedTexts = [...cloudTexts, ...localOnlyTexts].sort(
    (a, b) => (b.lastClickedAt ?? 0) - (a.lastClickedAt ?? 0) || b.createdAt - a.createdAt,
  );

  const cloudResults: SessionResult[] = cloud.results.map((r) => ({
    id: r.id,
    textId: r.textId,
    mode: r.mode as SessionResult["mode"],
    stage: r.stage,
    score: r.score,
    feedback: r.feedback,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
    details:
      r.details && typeof r.details === "object"
        ? (r.details as Record<string, unknown>)
        : undefined,
  }));
  const localOnlyResults = local.results.filter(
    (r) => !cloudResultIds.has(r.id),
  );
  const mergedResults = [...cloudResults, ...localOnlyResults]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 200);

  const mergedProgress: Record<string, UserProgress> = {};
  for (const p of cloud.progress) {
    mergedProgress[p.textId] = {
      textId: p.textId,
      stageBests: Array.isArray(p.stageBests)
        ? (p.stageBests as number[])
        : STAGES.map(() => 0),
      stagePassed: Array.isArray(p.stagePassed)
        ? (p.stagePassed as boolean[])
        : STAGES.map(() => false),
      lastStudied: p.lastStudied,
      totalSessions: p.totalSessions,
      shadowingBest: p.shadowingBest,
      dictationBest: p.dictationBest,
      recitationBest: p.recitationBest,
    };
  }
  const localOnlyProgress: UserProgress[] = [];
  for (const [textId, lp] of Object.entries(local.progress)) {
    if (!cloudProgressTextIds.has(textId)) {
      mergedProgress[textId] = lp;
      localOnlyProgress.push(lp);
    }
  }

  const subscription: SubscriptionState = {
    tier: cloud.subscription.tier === "pro" ? "pro" : "free",
    upgradedAt:
      cloud.subscription.upgradedAt != null
        ? Number(cloud.subscription.upgradedAt)
        : undefined,
  };

  const toPush: SyncPushPayload = {
    texts: localOnlyTexts.map(toApiText),
    results: localOnlyResults.map(toApiResult),
    progress: localOnlyProgress.map(toApiProgress),
  };

  return {
    merged: {
      texts: mergedTexts,
      results: mergedResults,
      progress: mergedProgress,
      subscription,
    },
    toPush,
  };
}

function toApiText(t: LearningText) {
  return {
    id: t.id,
    title: t.title,
    text: t.text,
    translation: t.translation,
    vocabulary: t.vocabulary as never,
    topic: t.topic,
    difficulty: t.difficulty,
    targetLanguage: t.targetLanguage,
    nativeLanguage: t.nativeLanguage,
    contentType: t.contentType ?? null,
    createdAt: t.createdAt,
    lastClickedAt: t.lastClickedAt,
    // translations & vocabularyCache intentionally excluded —
    // they are local-only caches and the server schema doesn't
    // have corresponding columns.
  };
}

function toApiResult(r: SessionResult) {
  return {
    id: r.id,
    textId: r.textId,
    mode: r.mode,
    stage: r.stage,
    score: r.score,
    feedback: r.feedback,
    createdAt: r.createdAt,
    details: (r.details as Record<string, unknown> | undefined) ?? null,
  };
}

function toApiProgress(p: UserProgress) {
  return {
    textId: p.textId,
    stageBests: p.stageBests as never,
    stagePassed: p.stagePassed as never,
    lastStudied: p.lastStudied,
    totalSessions: p.totalSessions,
    shadowingBest: p.shadowingBest,
    dictationBest: p.dictationBest,
    recitationBest: p.recitationBest,
  };
}

/**
 * Pull the cloud snapshot for the authed user. Returns null on any
 * failure (network, 401, parse) so callers can keep showing local data
 * and try again later.
 */
export async function pullSnapshot(): Promise<SyncSnapshot | null> {
  try {
    return await getSyncSnapshot();
  } catch (e: any) {
    if (__DEV__) {
      const ctx =
        e?.status != null
          ? `HTTP ${e.status} ${e.statusText ?? ""}`.trim()
          : "network";
      console.error(`[sync] pullSnapshot failed (${ctx}):`, e?.message ?? e);
    }
    return null;
  }
}

/**
 * Push a delta payload. Drops any falsy fields so the wire payload only
 * carries actually-changed records.
 */
export async function pushDelta(payload: SyncPushPayload): Promise<boolean> {
  const isEmpty =
    (!payload.texts || payload.texts.length === 0) &&
    (!payload.results || payload.results.length === 0) &&
    (!payload.progress || payload.progress.length === 0) &&
    (!payload.deletedTextIds || payload.deletedTextIds.length === 0);
  if (isEmpty) return true;
  try {
    await pushSync(payload);
    return true;
  } catch (e: any) {
    if (__DEV__) {
      const ctx =
        e?.status != null
          ? `HTTP ${e.status} ${e.statusText ?? ""}`.trim()
          : "network";
      console.error(`[sync] pushDelta failed (${ctx}):`, e?.message ?? e);
    }
    return false;
  }
}

export async function pushSubscriptionTier(
  tier: "free" | "pro",
): Promise<ApiSubscriptionState | null> {
  try {
    return await apiSetSubscription({ tier });
  } catch {
    return null;
  }
}

/**
 * Push the user's interface language ("nativeLanguage" in client-speak,
 * stored as `users.native_language` server-side) so a different device
 * the same Clerk user signs in on later can pre-fill the UI in their
 * preferred language without re-prompting. Best-effort: returns false
 * when offline so callers can keep their local state and silently retry
 * on the next sync.
 */
export async function pushUserNativeLanguage(
  nativeLanguage: string,
): Promise<boolean> {
  try {
    await apiSetUserSettings({ nativeLanguage });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a /sync/push payload from the local in-memory state and a
 * pending queue (ids of records that need to be pushed). Used both
 * during full-sync (to ship local-only items) and during incremental
 * flush (to ship recent writes).
 */
export function buildPushFromQueue(
  local: LocalSnapshot,
  queue: PendingQueue,
): SyncPushPayload {
  const textsById = new Map(local.texts.map((t) => [t.id, t]));
  const resultsById = new Map(local.results.map((r) => [r.id, r]));
  const texts = queue.textIds
    .map((id) => textsById.get(id))
    .filter((t): t is LearningText => Boolean(t))
    .map(toApiText);
  const results = queue.resultIds
    .map((id) => resultsById.get(id))
    .filter((r): r is SessionResult => Boolean(r))
    .map(toApiResult);
  const progress = queue.progressTextIds
    .map((textId) => local.progress[textId])
    .filter((p): p is UserProgress => Boolean(p))
    .map(toApiProgress);
  return {
    texts,
    results,
    progress,
    deletedTextIds: queue.deletedTextIds,
  };
}

export type { SyncSnapshot, SyncPushPayload };
