import type {
  DetailedTranscript,
  DetailedTranscriptSegment,
  DetailedTranscriptWord,
} from "@workspace/integrations-openai-ai-server/audio";

/**
 * STT-derived per-utterance metrics. All numbers are descriptive (raw
 * timings, confidence on a 0–1 scale, etc.) — sub-score mapping happens
 * in `scoring.ts`.
 */
export interface SttMetrics {
  /** Wall-clock duration of the recording in seconds (best estimate). */
  durationSec: number;
  /** Total number of words Whisper transcribed. */
  wordCount: number;
  /**
   * Words per second across the *speech-active* window (last word.end −
   * first word.start), NOT the wallclock recording duration. This makes
   * paceScore robust to the leading + trailing silence that surrounds
   * every tap-to-record take. Falls back to wallclock when word timings
   * are degenerate. 0 when there are no words. See `durationSec` for
   * the full wallclock value.
   */
  wordsPerSec: number;
  /** Pauses > PAUSE_THRESHOLD_SEC between consecutive transcribed words. */
  pauseCount: number;
  /** Sum of all such pause durations, in seconds. */
  totalPauseSec: number;
  /** Longest single inter-word pause, in seconds. */
  longestPauseSec: number;
  /** Mean per-word confidence on a 0–1 scale (1 = fully confident). */
  meanConfidence: number;
  /** Per-word confidence list, aligned to `words`. */
  perWordConfidence: number[];
  /** Words flagged as low-confidence (logprob below threshold). */
  lowConfidenceWords: string[];
  /** Echo of the words list for downstream callers. */
  words: DetailedTranscriptWord[];
}

/** Gaps below this between consecutive words don't count as a pause. */
const PAUSE_THRESHOLD_SEC = 0.25;

/**
 * Confidence threshold (on the 0–1 mapped scale) below which a word is
 * "unsure". Picked so that segments with avg_logprob ≈ -1.0 (Whisper's
 * rough boundary between "clear" and "muddled") map to ~0.37, well
 * below 0.55.
 */
const LOW_CONFIDENCE_THRESHOLD = 0.55;

/**
 * Map a Whisper segment-level avg_logprob (typically in [-3, 0]) to a
 * 0–1 confidence score using a simple exponential. avg_logprob = 0 → 1,
 * -1 → ~0.37, -2 → ~0.13.
 */
export function logprobToConfidence(avgLogprob: number): number {
  if (!Number.isFinite(avgLogprob)) return 0;
  return Math.max(0, Math.min(1, Math.exp(avgLogprob)));
}

/** Locate the segment whose [start, end] envelopes the given timestamp. */
function segmentForTime(
  segments: DetailedTranscriptSegment[],
  t: number
): DetailedTranscriptSegment | null {
  for (const seg of segments) {
    if (t >= seg.start && t <= seg.end) return seg;
  }
  // Fall back to nearest by midpoint when the word's timestamp drifts
  // outside any segment's bounds (Whisper is occasionally imprecise).
  let best: DetailedTranscriptSegment | null = null;
  let bestDist = Infinity;
  for (const seg of segments) {
    const mid = (seg.start + seg.end) / 2;
    const d = Math.abs(mid - t);
    if (d < bestDist) {
      bestDist = d;
      best = seg;
    }
  }
  return best;
}

export function computeSttMetrics(
  detailed: DetailedTranscript
): SttMetrics {
  const words = detailed.words ?? [];
  const segments = detailed.segments ?? [];

  // Duration: prefer the explicit field, else the last word's end, else
  // the last segment's end.
  let durationSec = detailed.duration || 0;
  if (!durationSec && words.length > 0) {
    durationSec = words[words.length - 1].end;
  }
  if (!durationSec && segments.length > 0) {
    durationSec = segments[segments.length - 1].end;
  }

  let pauseCount = 0;
  let totalPauseSec = 0;
  let longestPauseSec = 0;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > PAUSE_THRESHOLD_SEC) {
      pauseCount += 1;
      totalPauseSec += gap;
      if (gap > longestPauseSec) longestPauseSec = gap;
    }
  }

  const perWordConfidence: number[] = [];
  const lowConfidenceWords: string[] = [];
  let confidenceSum = 0;
  for (const w of words) {
    const seg = segmentForTime(segments, (w.start + w.end) / 2);
    const c = seg ? logprobToConfidence(seg.avg_logprob) : 0.5;
    perWordConfidence.push(c);
    confidenceSum += c;
    if (c < LOW_CONFIDENCE_THRESHOLD) {
      const cleaned = w.word.trim();
      if (cleaned) lowConfidenceWords.push(cleaned);
    }
  }
  const meanConfidence =
    words.length > 0 ? confidenceSum / words.length : 0;

  // Pace must be measured against speech-active time, not wallclock.
  // Users almost always tap record → pause → speak → pause → tap stop,
  // so the wallclock duration includes leading + trailing silence that
  // would dilute words/sec down to 0 and collapse paceScore to 0 even
  // for normally-paced reads. Derive a separate "speech duration" from
  // the word timings (last word.end − first word.start). For a single
  // word, fall back to its own duration. If word timings are degenerate
  // (e.g. start ≥ end), fall back to wallclock so we never divide by
  // zero or a negative number. With zero words, keep wps = 0 so
  // paceScore returns 0 as before.
  let speechDurationSec = 0;
  if (words.length === 1) {
    speechDurationSec = words[0].end - words[0].start;
  } else if (words.length > 1) {
    speechDurationSec = words[words.length - 1].end - words[0].start;
  }
  if (!(speechDurationSec > 0)) speechDurationSec = durationSec;
  const wordsPerSec =
    words.length > 0 && speechDurationSec > 0
      ? words.length / speechDurationSec
      : 0;

  return {
    durationSec,
    wordCount: words.length,
    wordsPerSec,
    pauseCount,
    totalPauseSec,
    longestPauseSec,
    meanConfidence,
    perWordConfidence,
    lowConfidenceWords,
    words,
  };
}

export const STT_METRIC_CONSTANTS = {
  PAUSE_THRESHOLD_SEC,
  LOW_CONFIDENCE_THRESHOLD,
};
