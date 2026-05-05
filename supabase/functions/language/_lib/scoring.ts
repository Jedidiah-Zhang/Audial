import type { DetailedTranscript } from "./tts-stt.ts";
import type { ProsodyMetrics } from "./prosody.ts";

// ===================================================================
// STT Metrics — derive pace, confidence, and pause stats from
// detailed Whisper transcription output.
// ===================================================================

export interface SttMetrics {
  durationSec: number;
  wordCount: number;
  wordsPerSec: number;
  pauseCount: number;
  totalPauseSec: number;
  longestPauseSec: number;
  meanConfidence: number;
  perWordConfidence: number[];
  lowConfidenceWords: { word: string; confidence: number }[];
  words: { word: string; start: number; end: number }[];
}

export function computeSttMetrics(detailed: DetailedTranscript): SttMetrics {
  const words = detailed.words ?? [];
  const segments = detailed.segments ?? [];
  const durationSec = detailed.duration ?? 0;

  // Per-word confidence from segments
  let meanConfidence = 0;
  let confidenceWordCount = 0;
  const perWordConfidence: number[] = [];
  const lowConfidenceWords: { word: string; confidence: number }[] = [];

  for (const seg of segments) {
    const logprob = seg.avg_logprob ?? -999;
    const prob = Math.exp(Math.max(-10, Math.min(0, logprob)));
    const wordsInSeg = seg.text?.split(/\s+/).length || 1;
    for (let i = 0; i < wordsInSeg; i++) {
      perWordConfidence.push(prob);
      meanConfidence += prob;
      confidenceWordCount++;
      if (prob < 0.55) {
        // Find matching word
        const word = words[perWordConfidence.length - 1]?.word ?? "?";
        lowConfidenceWords.push({ word, confidence: prob });
      }
    }
  }
  if (confidenceWordCount > 0) {
    meanConfidence /= confidenceWordCount;
  }

  // Words per second: use word timestamps to exclude leading/trailing silence
  let wordsPerSec = 0;
  if (words.length >= 2) {
    const firstWord = words[0];
    const lastWord = words[words.length - 1];
    const span = (lastWord.end ?? lastWord.start) - (firstWord.start ?? firstWord.end);
    if (span > 0) wordsPerSec = words.length / span;
  } else if (words.length === 1 && durationSec > 0) {
    const wordDuration = words[0].end - words[0].start;
    wordsPerSec = wordDuration > 0 ? 1 / wordDuration : 1 / durationSec;
  } else if (durationSec > 0) {
    wordsPerSec = words.length / durationSec;
  }

  // Pause analysis
  let pauseCount = 0;
  let totalPauseSec = 0;
  let longestPauseSec = 0;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > 0.25) {
      pauseCount++;
      totalPauseSec += gap;
      if (gap > longestPauseSec) longestPauseSec = gap;
    }
  }

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
    words: words.map((w) => ({ word: w.word, start: w.start, end: w.end })),
  };
}

// ===================================================================
// Scoring blends — combine LLM accuracy, STT confidence, pace, and
// prosody into a single 0-100 score.
// ===================================================================

export const SCORE_WEIGHTS = {
  accuracy: 0.4,
  confidence: 0.25,
  pace: 0.15,
  prosody: 0.2,
};

// Detect language family from BCP-47 tag
function isCJK(language: string): boolean {
  const lang = language.toLowerCase().split("-")[0];
  return ["zh", "ja", "ko", "th"].includes(lang);
}

// Pace score: triangular scoring centered on ideal words-per-second range
function paceScore(wordsPerSec: number, language: string): number {
  let low: number, high: number;
  if (isCJK(language)) {
    low = 1.0; high = 3.0;
  } else {
    low = 2.0; high = 3.5;
  }
  const minHalf = low * 0.5;
  const maxDouble = high * 2;

  if (wordsPerSec <= minHalf || wordsPerSec >= maxDouble) return 0;
  if (wordsPerSec >= low && wordsPerSec <= high) return 100;

  // Linear interpolation from edges
  if (wordsPerSec < low) {
    return ((wordsPerSec - minHalf) / (low - minHalf)) * 100;
  } else {
    return 100 - ((wordsPerSec - high) / (maxDouble - high)) * 100;
  }
}

function confidenceScore(meanConfidence: number): number {
  return Math.pow(Math.max(0, Math.min(1, meanConfidence)), 0.6) * 100;
}

function prosodyScore(prosody: ProsodyMetrics | null, longestPauseSec: number): number {
  if (!prosody) return 0;

  // F0 variability: 20-60 Hz std is good (natural intonation)
  const f0StdScore = Math.max(0, Math.min(100, (prosody.f0StdHz - 10) / 50 * 100));

  // Voiced ratio: above 60% is good
  const voicedScore = Math.max(0, Math.min(100, prosody.voicedRatio / 0.7 * 100));

  let score = f0StdScore * 0.5 + voicedScore * 0.5;

  // Penalty for very long pauses
  if (longestPauseSec > 1) {
    const penalty = Math.min(30, (longestPauseSec - 1) * 10);
    score = Math.max(0, score - penalty);
  }

  return score;
}

function blendScores(
  accuracy: number,
  pace: number,
  confidence: number,
  prosody: number,
  prosodyAvailable: boolean,
): number {
  const w = { ...SCORE_WEIGHTS };
  if (!prosodyAvailable) {
    const redistributed = w.prosody / 3;
    w.accuracy += redistributed;
    w.confidence += redistributed;
    w.pace += redistributed;
    w.prosody = 0;
  }
  return w.accuracy * accuracy + w.confidence * confidence + w.pace * pace + w.prosody * prosody;
}

export function scoreFromSignals(params: {
  llmAccuracy: number;
  stt: SttMetrics | null;
  prosody: ProsodyMetrics | null;
  language: string;
}): {
  score: number;
  accuracy: number;
  pace: number;
  confidence: number;
  prosody: number;
  fluency: number;
  prosodyAvailable: boolean;
  weights: typeof SCORE_WEIGHTS;
} {
  const { llmAccuracy, stt, prosody, language } = params;

  const accuracy = Math.max(0, Math.min(100, llmAccuracy));
  const pace = stt ? paceScore(stt.wordsPerSec, language) : 50;
  const confidence = stt ? confidenceScore(stt.meanConfidence) : 50;
  const prosodyS = prosodyScore(prosody, stt?.longestPauseSec ?? 0);
  const prosodyAvailable = prosody !== null;

  const score = blendScores(accuracy, pace, confidence, prosodyS, prosodyAvailable);
  const fluency = (pace + confidence + (prosodyAvailable ? prosodyS : pace)) / (prosodyAvailable ? 3 : 2);

  return {
    score: Math.round(score),
    accuracy: Math.round(accuracy),
    pace: Math.round(pace),
    confidence: Math.round(confidence),
    prosody: Math.round(prosodyS),
    fluency: Math.round(fluency),
    prosodyAvailable,
    weights: SCORE_WEIGHTS,
  };
}
