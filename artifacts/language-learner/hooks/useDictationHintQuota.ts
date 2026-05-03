import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useApp } from "@/context/AppContext";

/**
 * Daily quota for the dictation "hint" feature. Free users get a fixed
 * allotment of hints per natural calendar day; once exhausted, they
 * must watch a rewarded ad to add more hints. Pro users bypass entirely.
 *
 * Persisted via AsyncStorage so the quota survives app restarts and
 * resets at local midnight (rolled forward when `tryConsume` /
 * `getRemaining` notices the stored day no longer matches today).
 */

const STORAGE_KEY = "audial:dictationHintQuota:v1";
const DEFAULT_FREE_HINTS_PER_DAY = 3;
const DEFAULT_BONUS_HINTS = 3;

interface StoredState {
  day: string; // YYYY-MM-DD in local time
  remaining: number;
}

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface UseDictationHintQuotaResult {
  /** Hints remaining today (Number.POSITIVE_INFINITY for Pro). */
  getRemaining: () => number;
  /**
   * Try to consume one hint. Returns true if a hint was available and
   * was consumed, false if the user is out for today.
   */
  tryConsume: () => boolean;
  /** Add `bonus` hints (after a rewarded ad). */
  grantBonus: (bonus?: number) => void;
  /** True once the persisted state has been loaded from AsyncStorage. */
  isReady: boolean;
}

export function useDictationHintQuota(opts?: {
  freeHintsPerDay?: number;
  bonusHints?: number;
}): UseDictationHintQuotaResult {
  const { isPro } = useApp();
  const freeHints = opts?.freeHintsPerDay ?? DEFAULT_FREE_HINTS_PER_DAY;
  const bonusHints = opts?.bonusHints ?? DEFAULT_BONUS_HINTS;

  // Backed by a ref so callbacks always see the latest value even if
  // several taps land in the same render tick.
  const stateRef = useRef<StoredState>({ day: todayKey(), remaining: freeHints });
  const [, setVersion] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const bump = () => setVersion((v) => v + 1);

  // Load persisted state on mount; if the stored day doesn't match
  // today's date, reset the counter (lazy daily rollover).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (cancelled) return;
        const today = todayKey();
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<StoredState>;
          if (
            parsed &&
            typeof parsed.day === "string" &&
            typeof parsed.remaining === "number" &&
            parsed.day === today
          ) {
            stateRef.current = {
              day: parsed.day,
              remaining: Math.max(0, Math.floor(parsed.remaining)),
            };
          } else {
            stateRef.current = { day: today, remaining: freeHints };
          }
        } else {
          stateRef.current = { day: today, remaining: freeHints };
        }
      } catch {
        // Storage unavailable / corrupt — fall back to a fresh quota
        // for this session rather than locking the user out.
        stateRef.current = { day: todayKey(), remaining: freeHints };
      } finally {
        if (!cancelled) {
          setIsReady(true);
          bump();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // freeHints is a configuration constant; ignore deps lint to avoid
    // re-running this effect mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = useCallback(async () => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(stateRef.current));
    } catch {
      // best-effort; in-memory state still reflects the change.
    }
  }, []);

  // Roll the day forward in-place if midnight passed since the last
  // mutation. Cheap to call before every read/write.
  const rollIfNewDay = useCallback(() => {
    const today = todayKey();
    if (stateRef.current.day !== today) {
      stateRef.current = { day: today, remaining: freeHints };
      void persist();
    }
  }, [freeHints, persist]);

  const getRemaining = useCallback((): number => {
    if (isPro) return Number.POSITIVE_INFINITY;
    rollIfNewDay();
    return stateRef.current.remaining;
  }, [isPro, rollIfNewDay]);

  const tryConsume = useCallback((): boolean => {
    if (isPro) return true;
    // Refuse to consume before the persisted state has loaded —
    // otherwise a user who already exhausted today's quota could spend
    // hints during the brief load window using the in-memory default.
    if (!isReady) return false;
    rollIfNewDay();
    if (stateRef.current.remaining <= 0) return false;
    stateRef.current = {
      ...stateRef.current,
      remaining: stateRef.current.remaining - 1,
    };
    void persist();
    bump();
    return true;
  }, [isPro, isReady, persist, rollIfNewDay]);

  const grantBonus = useCallback(
    (bonus: number = bonusHints) => {
      if (isPro) return;
      rollIfNewDay();
      stateRef.current = {
        ...stateRef.current,
        remaining: stateRef.current.remaining + Math.max(0, bonus),
      };
      void persist();
      bump();
    },
    [bonusHints, isPro, persist, rollIfNewDay],
  );

  return { getRemaining, tryConsume, grantBonus, isReady };
}
