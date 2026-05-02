import { useCallback, useRef, useState } from "react";
import { useApp } from "@/context/AppContext";

/**
 * Per-sentence "listen again" quota for the dictation phase. Free users
 * get an initial allotment of plays per sentence; once exhausted, they
 * must watch a rewarded ad to add more plays. Pro users bypass entirely.
 *
 * The quota is **session-scoped** — it resets every time the dictation
 * phase mounts. This matches the demo's "watch one ad per dictation
 * sitting" cadence; persisting it across sessions would punish users
 * who briefly leave & return.
 */
export interface UseDictationListenQuotaResult {
  /** Plays remaining for the given sentence (Infinity for Pro). */
  getRemaining: (sentenceIdx: number) => number;
  /**
   * Try to consume one play for the given sentence. Returns true if a
   * play was available and was consumed, false if the user is out of
   * plays for that sentence.
   */
  tryConsume: (sentenceIdx: number) => boolean;
  /** Add `bonus` plays to the given sentence (after a rewarded ad). */
  grantBonus: (sentenceIdx: number, bonus?: number) => void;
}

const DEFAULT_FREE_PLAYS_PER_SENTENCE = 3;
const DEFAULT_BONUS_PLAYS = 3;

export function useDictationListenQuota(opts?: {
  freePlaysPerSentence?: number;
  bonusPlays?: number;
}): UseDictationListenQuotaResult {
  const { isPro } = useApp();
  const freePlays = opts?.freePlaysPerSentence ?? DEFAULT_FREE_PLAYS_PER_SENTENCE;
  const bonusPlays = opts?.bonusPlays ?? DEFAULT_BONUS_PLAYS;

  // Map sentence index -> remaining plays. Backed by a ref so reads
  // inside callbacks always see the latest value (a setState bag would
  // surface stale data inside the same tick when several taps land
  // before React re-renders).
  const remainingRef = useRef<Map<number, number>>(new Map());
  // Bumping this state forces consumers (e.g. the dictation UI badge)
  // to re-read `getRemaining` after a consume / grant.
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  const getRemaining = useCallback(
    (sentenceIdx: number): number => {
      if (isPro) return Number.POSITIVE_INFINITY;
      const cur = remainingRef.current.get(sentenceIdx);
      return cur ?? freePlays;
    },
    [freePlays, isPro],
  );

  const tryConsume = useCallback(
    (sentenceIdx: number): boolean => {
      if (isPro) return true;
      const cur = remainingRef.current.get(sentenceIdx) ?? freePlays;
      if (cur <= 0) return false;
      remainingRef.current.set(sentenceIdx, cur - 1);
      bump();
      return true;
    },
    [freePlays, isPro],
  );

  const grantBonus = useCallback(
    (sentenceIdx: number, bonus: number = bonusPlays) => {
      if (isPro) return;
      const cur = remainingRef.current.get(sentenceIdx) ?? freePlays;
      remainingRef.current.set(sentenceIdx, cur + Math.max(0, bonus));
      bump();
    },
    [bonusPlays, freePlays, isPro],
  );

  return { getRemaining, tryConsume, grantBonus };
}
