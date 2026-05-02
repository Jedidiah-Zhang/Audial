import AsyncStorage from "@react-native-async-storage/async-storage";
import type { LearningText, SessionResult, SubscriptionState, UserProgress } from "@/types";
import { transferAudioOwnership } from "@/utils/ttsCache";

const GUEST_USER_ID = "guest";

function keysFor(userId: string) {
  const prefix = `ll:${userId}:`;
  return {
    TEXTS: `${prefix}texts`,
    RESULTS: `${prefix}results`,
    PROGRESS: `${prefix}progress`,
    SUBSCRIPTION: `${prefix}subscription`,
  };
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function mergeTexts(guest: LearningText[], target: LearningText[]): LearningText[] {
  const seen = new Set<string>();
  const out: LearningText[] = [];
  for (const t of target) {
    if (t && t.id && !seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  }
  for (const t of guest) {
    if (t && t.id && !seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

function mergeResults(guest: SessionResult[], target: SessionResult[]): SessionResult[] {
  const seen = new Set<string>();
  const out: SessionResult[] = [];
  const all = [...target, ...guest];
  for (const r of all) {
    if (!r || !r.id) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return out.slice(0, 200);
}

function mergeProgress(
  guest: Record<string, UserProgress>,
  target: Record<string, UserProgress>
): Record<string, UserProgress> {
  const out: Record<string, UserProgress> = { ...target };
  for (const [textId, gp] of Object.entries(guest)) {
    if (!gp) continue;
    if (out[textId]) continue;
    out[textId] = gp;
  }
  return out;
}

/**
 * Subscription merge policy: "pro wins". If either side is paid, the merged
 * tier is paid. The earliest known upgrade timestamp is preserved so a long-
 * standing guest Pro user keeps their original upgrade date when migrating
 * onto a fresh signed-in account. If neither side has a stored entry the
 * caller is expected to skip the write entirely.
 */
function mergeSubscription(
  guest: SubscriptionState | null,
  target: SubscriptionState | null
): SubscriptionState | null {
  if (!guest && !target) return null;
  const guestPro = guest?.tier === "pro";
  const targetPro = target?.tier === "pro";
  if (!guestPro && !targetPro) {
    // Both free — no need to migrate; the target will keep its existing
    // (free) state which is also the default for fresh accounts.
    return target ?? guest ?? null;
  }
  const candidates = [guest?.upgradedAt, target?.upgradedAt].filter(
    (n): n is number => typeof n === "number"
  );
  return {
    tier: "pro",
    upgradedAt: candidates.length > 0 ? Math.min(...candidates) : Date.now(),
  };
}

/**
 * Move guest-scoped texts/results/progress and TTS audio cache index entries
 * into the target account. Settings are intentionally NOT migrated so a fresh
 * sign-in keeps the user's chosen language/voice/etc on the new account.
 *
 * Merge policy on id collisions: the target's existing data wins. Guest items
 * with ids already present on the target are dropped; guest-only items are
 * added. After a successful write the guest scope is cleared so subsequent
 * sign-outs land on a clean guest profile.
 *
 * No-ops when:
 *  - targetUserId === "guest" (would migrate to itself)
 *  - the guest scope is empty (nothing to do)
 *
 * Returns true if any data was migrated, false otherwise.
 */
export async function migrateGuestData(targetUserId: string): Promise<boolean> {
  if (!targetUserId || targetUserId === GUEST_USER_ID) return false;

  const G = keysFor(GUEST_USER_ID);
  const T = keysFor(targetUserId);

  let guestTextsRaw: string | null;
  let guestResultsRaw: string | null;
  let guestProgressRaw: string | null;
  let guestSubscriptionRaw: string | null;
  let targetTextsRaw: string | null;
  let targetResultsRaw: string | null;
  let targetProgressRaw: string | null;
  let targetSubscriptionRaw: string | null;
  try {
    [
      guestTextsRaw,
      guestResultsRaw,
      guestProgressRaw,
      guestSubscriptionRaw,
      targetTextsRaw,
      targetResultsRaw,
      targetProgressRaw,
      targetSubscriptionRaw,
    ] = await Promise.all([
      AsyncStorage.getItem(G.TEXTS),
      AsyncStorage.getItem(G.RESULTS),
      AsyncStorage.getItem(G.PROGRESS),
      AsyncStorage.getItem(G.SUBSCRIPTION),
      AsyncStorage.getItem(T.TEXTS),
      AsyncStorage.getItem(T.RESULTS),
      AsyncStorage.getItem(T.PROGRESS),
      AsyncStorage.getItem(T.SUBSCRIPTION),
    ]);
  } catch {
    return false;
  }

  const guestTexts = safeParse<LearningText[]>(guestTextsRaw, []);
  const guestResults = safeParse<SessionResult[]>(guestResultsRaw, []);
  const guestProgress = safeParse<Record<string, UserProgress>>(guestProgressRaw, {});
  const guestSubscription = safeParse<SubscriptionState | null>(guestSubscriptionRaw, null);
  const targetSubscription = safeParse<SubscriptionState | null>(targetSubscriptionRaw, null);

  // The subscription tier is the only piece of state that can flow on its own
  // (a guest who only upgraded but produced no other data should still
  // promote a fresh signed-in account to Pro on first sign-in).
  const guestPro = guestSubscription?.tier === "pro";

  const hasGuestData =
    (Array.isArray(guestTexts) && guestTexts.length > 0) ||
    (Array.isArray(guestResults) && guestResults.length > 0) ||
    (guestProgress && Object.keys(guestProgress).length > 0) ||
    guestPro;

  if (!hasGuestData) return false;

  const targetTexts = safeParse<LearningText[]>(targetTextsRaw, []);
  const targetResults = safeParse<SessionResult[]>(targetResultsRaw, []);
  const targetProgress = safeParse<Record<string, UserProgress>>(targetProgressRaw, {});

  const mergedTexts = mergeTexts(
    Array.isArray(guestTexts) ? guestTexts : [],
    Array.isArray(targetTexts) ? targetTexts : []
  );
  const mergedResults = mergeResults(
    Array.isArray(guestResults) ? guestResults : [],
    Array.isArray(targetResults) ? targetResults : []
  );
  const mergedProgress = mergeProgress(
    guestProgress && typeof guestProgress === "object" ? guestProgress : {},
    targetProgress && typeof targetProgress === "object" ? targetProgress : {}
  );
  const mergedSubscription = mergeSubscription(guestSubscription, targetSubscription);

  // Write to target FIRST. If any write fails we leave guest data intact so
  // the next sign-in can retry.
  try {
    const writes: Promise<void>[] = [
      AsyncStorage.setItem(T.TEXTS, JSON.stringify(mergedTexts)),
      AsyncStorage.setItem(T.RESULTS, JSON.stringify(mergedResults)),
      AsyncStorage.setItem(T.PROGRESS, JSON.stringify(mergedProgress)),
    ];
    // Only touch the subscription key when there's something meaningful to
    // record (guest or target was Pro). A "free → free" merge skips the
    // write so we don't pollute storage with default-state entries.
    if (mergedSubscription && mergedSubscription.tier === "pro") {
      writes.push(AsyncStorage.setItem(T.SUBSCRIPTION, JSON.stringify(mergedSubscription)));
    }
    await Promise.all(writes);
  } catch {
    return false;
  }

  // Hand off TTS audio index entries. Audio files themselves are content-
  // addressed on disk (`<voice>-<sha1>.mp3`) so re-keying the index is enough.
  try {
    await transferAudioOwnership(GUEST_USER_ID, targetUserId);
  } catch {
    // best-effort
  }

  // Clear guest scope (data only — settings stay so a future guest session
  // keeps the previously selected language/voice). Subscription is also
  // cleared so a guest who upgraded once and then signed in doesn't keep a
  // dangling Pro flag on the guest scope after sign-out.
  try {
    await AsyncStorage.multiRemove([G.TEXTS, G.RESULTS, G.PROGRESS, G.SUBSCRIPTION]);
  } catch {
    // ignore
  }

  return true;
}
