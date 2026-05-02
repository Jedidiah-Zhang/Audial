import type { SttMetrics } from "./sttMetrics";
import type { ProsodyMetrics } from "./prosody";

/**
 * Final per-utterance sub-scores plus the blended overall.
 * All numbers are 0–100.
 */
export interface PronunciationScores {
  pace: number;
  confidence: number;
  prosody: number | null;
  /** Blended overall, see WEIGHTS below. */
  overall: number;
}

/**
 * Final score weights. The LLM accuracy is the biggest single signal
 * but no longer the only one — heavy-accent users who Whisper
 * mis-spelled a word for now get partial credit from confidence (high)
 * and prosody (preserved), and fluently-read-but-wrong-text users get
 * the LLM accuracy floor they deserve.
 */
export const SCORE_WEIGHTS = {
  accuracy: 0.4,
  confidence: 0.25,
  pace: 0.15,
  prosody: 0.2,
} as const;

/**
 * Words/sec target band per language family. We keep this coarse on
 * purpose — finer per-language tuning is a separate task. CJK
 * (zh / ja / ko / yue) plus Thai are character-based and read more
 * slowly per "word" than spaced languages.
 *
 * For non-spaced languages we still reason in words/sec because that's
 * what Whisper returns; the bands are wider to match how Whisper
 * tokenizes them.
 */
function paceTargetBand(language: string): { lo: number; hi: number } {
  const code = language.toLowerCase();
  if (
    code.startsWith("zh") ||
    code.startsWith("ja") ||
    code.startsWith("ko") ||
    code.startsWith("yue") ||
    code.includes("chinese") ||
    code.includes("japanese") ||
    code.includes("korean") ||
    code.includes("thai") ||
    code.startsWith("th")
  ) {
    return { lo: 1.0, hi: 3.0 };
  }
  // Default: spaced languages (en, es, fr, de, ...).
  return { lo: 2.0, hi: 3.5 };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Triangular score: 100 in band, drops linearly outside. */
export function paceScore(wordsPerSec: number, language: string): number {
  const { lo, hi } = paceTargetBand(language);
  if (wordsPerSec <= 0) return 0;
  if (wordsPerSec >= lo && wordsPerSec <= hi) return 100;
  if (wordsPerSec < lo) {
    // Too slow: reach 0 at half the lower bound.
    const floor = lo / 2;
    if (wordsPerSec <= floor) return 0;
    return Math.round(((wordsPerSec - floor) / (lo - floor)) * 100);
  }
  // Too fast: reach 0 at 2x the upper bound.
  const ceil = hi * 2;
  if (wordsPerSec >= ceil) return 0;
  return Math.round(((ceil - wordsPerSec) / (ceil - hi)) * 100);
}

/**
 * Confidence sub-score: shape the mean per-word confidence so that the
 * "comfortable" range of 0.5–1.0 covers most of 50–100, and very low
 * confidences fall off sharply.
 */
export function confidenceScore(meanConfidence: number): number {
  const c = clamp(meanConfidence, 0, 1);
  // Lift the curve: mean 0.7 → ~88, mean 0.5 → ~71, mean 0.3 → ~55.
  const shaped = Math.pow(c, 0.6);
  return Math.round(shaped * 100);
}

/**
 * Prosody sub-score: penalize near-monotone (low F0 std) and very long
 * single pauses. Returns null when prosody features are unavailable.
 */
export function prosodyScore(
  prosody: ProsodyMetrics | null,
  longestPauseSec: number
): number | null {
  if (!prosody) return null;
  // F0 std component: ~10 Hz (very monotone) → ~30, ~25 Hz (natural)
  // → ~85, plateaus past ~40 Hz.
  const stdComponent = clamp((prosody.f0StdHz / 30) * 90, 20, 100);
  // Voiced ratio component: rewards continuous phonation (no long
  // unvoiced gaps). 0.4 → 60, 0.7 → ~93, 0.8+ → 100.
  const voicedComponent = clamp(prosody.voicedRatio * 130, 30, 100);
  let combined = stdComponent * 0.6 + voicedComponent * 0.4;
  // Long-pause penalty: 1s OK, 2s -10, 3s -20, etc.
  if (longestPauseSec > 1) {
    combined -= Math.min(30, (longestPauseSec - 1) * 10);
  }
  return Math.round(clamp(combined, 0, 100));
}

/**
 * Combine all sub-scores into the final blended score. When prosody is
 * unavailable, its weight is redistributed proportionally onto the
 * other three signals so the user isn't penalized by the missing
 * feature.
 */
export function blendScores(
  llmAccuracy: number,
  pace: number,
  confidence: number,
  prosody: number | null
): PronunciationScores {
  const acc = clamp(llmAccuracy, 0, 100);
  const p = clamp(pace, 0, 100);
  const c = clamp(confidence, 0, 100);
  let overall: number;
  if (prosody == null) {
    const wAcc = SCORE_WEIGHTS.accuracy;
    const wConf = SCORE_WEIGHTS.confidence;
    const wPace = SCORE_WEIGHTS.pace;
    const total = wAcc + wConf + wPace;
    overall = (acc * wAcc + c * wConf + p * wPace) / total;
  } else {
    overall =
      acc * SCORE_WEIGHTS.accuracy +
      c * SCORE_WEIGHTS.confidence +
      p * SCORE_WEIGHTS.pace +
      prosody * SCORE_WEIGHTS.prosody;
  }
  return {
    pace: p,
    confidence: c,
    prosody: prosody == null ? null : Math.round(prosody),
    overall: Math.round(overall),
  };
}

/**
 * Convenience helper that wraps the metric → score mapping in one
 * call. Used by the route handler and the unit test.
 */
export function scoreFromSignals(args: {
  llmAccuracy: number;
  stt: SttMetrics;
  prosody: ProsodyMetrics | null;
  language: string;
}): PronunciationScores {
  const pace = paceScore(args.stt.wordsPerSec, args.language);
  const confidence = confidenceScore(args.stt.meanConfidence);
  const prosody = prosodyScore(args.prosody, args.stt.longestPauseSec);
  return blendScores(args.llmAccuracy, pace, confidence, prosody);
}
