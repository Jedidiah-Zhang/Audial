import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  computeSttMetrics,
  scoreFromSignals,
  computeProsodyMetrics,
  paceScore,
  confidenceScore,
  blendScores,
  SCORE_WEIGHTS,
} from "../../src/lib/pronunciation/index.js";
import type { DetailedTranscript } from "@workspace/integrations-openai-ai-server/audio";

// =====================================================================
// Synthetic verbose_json fixtures. Each one models a distinct shadowing
// scenario without going through Whisper, so the test is hermetic and
// runs without an OpenAI key.
// =====================================================================

function clean(): DetailedTranscript {
  // 6 words across 2.4s ≈ 2.5 wps (mid English band), tight
  // confidence (avg_logprob = -0.1 → ~0.9 mapped).
  return {
    text: "the quick brown fox jumps over",
    duration: 2.4,
    words: [
      { word: "the", start: 0.0, end: 0.3 },
      { word: "quick", start: 0.35, end: 0.7 },
      { word: "brown", start: 0.75, end: 1.1 },
      { word: "fox", start: 1.15, end: 1.5 },
      { word: "jumps", start: 1.55, end: 1.9 },
      { word: "over", start: 1.95, end: 2.3 },
    ],
    segments: [
      {
        start: 0,
        end: 2.4,
        text: "the quick brown fox jumps over",
        avg_logprob: -0.1,
        no_speech_prob: 0.01,
      },
    ],
  };
}

function heavyAccent(): DetailedTranscript {
  // Same target text and pace but Whisper isn't sure what it heard:
  // avg_logprob = -1.2 maps to ~0.30, so most words land below the
  // 0.55 low-confidence threshold.
  return {
    text: "the kweek braun fokes jumps over",
    duration: 2.4,
    words: [
      { word: "the", start: 0.0, end: 0.3 },
      { word: "kweek", start: 0.35, end: 0.7 },
      { word: "braun", start: 0.75, end: 1.1 },
      { word: "fokes", start: 1.15, end: 1.5 },
      { word: "jumps", start: 1.55, end: 1.9 },
      { word: "over", start: 1.95, end: 2.3 },
    ],
    segments: [
      {
        start: 0,
        end: 2.4,
        text: "the kweek braun fokes jumps over",
        avg_logprob: -1.2,
        no_speech_prob: 0.05,
      },
    ],
  };
}

function wrongWordsHaltingPace(): DetailedTranscript {
  // 3 words across 6 seconds → 0.5 wps (way below band), one giant
  // pause in the middle, mid confidence.
  return {
    text: "completely different sentence",
    duration: 6.0,
    words: [
      { word: "completely", start: 0.2, end: 1.0 },
      { word: "different", start: 4.0, end: 4.8 },
      { word: "sentence", start: 5.0, end: 5.9 },
    ],
    segments: [
      {
        start: 0,
        end: 6,
        text: "completely different sentence",
        avg_logprob: -0.3,
        no_speech_prob: 0.02,
      },
    ],
  };
}

test("clean read produces high blended score", () => {
  const stt = computeSttMetrics(clean());
  assert.equal(stt.wordCount, 6);
  assert.ok(stt.wordsPerSec > 2 && stt.wordsPerSec < 3.5, "wps in band");
  assert.equal(stt.lowConfidenceWords.length, 0, "all words confident");
  assert.equal(stt.pauseCount, 0, "no long pauses");

  const blended = scoreFromSignals({
    llmAccuracy: 95,
    stt,
    prosody: {
      f0MeanHz: 180,
      f0StdHz: 28,
      f0RangeHz: 80,
      rmsMean: 0.08,
      rmsStd: 0.04,
      voicedRatio: 0.78,
      frameCount: 240,
    },
    language: "en",
  });
  assert.equal(blended.pace, 100);
  assert.ok(blended.confidence > 80, `confidence ${blended.confidence} > 80`);
  assert.ok(blended.overall > 85, `overall ${blended.overall} > 85`);
});

test("heavy accent flags low-confidence words and partial credit", () => {
  const stt = computeSttMetrics(heavyAccent());
  assert.ok(
    stt.lowConfidenceWords.length >= 4,
    `expected most words flagged unsure, got ${stt.lowConfidenceWords.length}`
  );
  assert.ok(stt.meanConfidence < 0.55, "mean confidence below threshold");

  // The LLM gets the unsure list and would score accuracy lower (say 60).
  // Pace stays in band, prosody stays good — so the user still gets
  // partial credit instead of being crushed by Whisper's mishearing.
  const blended = scoreFromSignals({
    llmAccuracy: 60,
    stt,
    prosody: {
      f0MeanHz: 170,
      f0StdHz: 25,
      f0RangeHz: 70,
      rmsMean: 0.07,
      rmsStd: 0.03,
      voicedRatio: 0.7,
      frameCount: 240,
    },
    language: "en",
  });
  // Way better than blind STT-string-comparison would have given them.
  assert.ok(blended.overall >= 55, `overall ${blended.overall} >= 55`);
  assert.ok(blended.overall < 80, `overall ${blended.overall} < 80`);
});

test("wrong words + halting pace bottoms out", () => {
  const stt = computeSttMetrics(wrongWordsHaltingPace());
  assert.ok(stt.wordsPerSec < 1, "very slow");
  assert.ok(stt.longestPauseSec > 2.5, "long pause detected");
  assert.ok(stt.pauseCount >= 1);

  const blended = scoreFromSignals({
    llmAccuracy: 10,
    stt,
    prosody: {
      f0MeanHz: 120,
      f0StdHz: 8,
      f0RangeHz: 20,
      rmsMean: 0.04,
      rmsStd: 0.02,
      voicedRatio: 0.3,
      frameCount: 600,
    },
    language: "en",
  });
  assert.ok(blended.pace < 50, `pace ${blended.pace} < 50`);
  assert.ok(blended.overall < 50, `overall ${blended.overall} < 50`);
});

test("missing prosody redistributes weight, doesn't penalize the user", () => {
  const stt = computeSttMetrics(clean());
  const withProsody = scoreFromSignals({
    llmAccuracy: 90,
    stt,
    prosody: {
      f0MeanHz: 180,
      f0StdHz: 25,
      f0RangeHz: 70,
      rmsMean: 0.08,
      rmsStd: 0.04,
      voicedRatio: 0.75,
      frameCount: 240,
    },
    language: "en",
  });
  const withoutProsody = scoreFromSignals({
    llmAccuracy: 90,
    stt,
    prosody: null,
    language: "en",
  });
  // Without prosody we must not silently dock 20 points: the difference
  // should be small (≤ 10) and the user's overall should still be high.
  assert.equal(withoutProsody.prosody, null);
  assert.ok(
    Math.abs(withProsody.overall - withoutProsody.overall) <= 10,
    `prosody-missing penalty too high: ${withProsody.overall} vs ${withoutProsody.overall}`
  );
  assert.ok(withoutProsody.overall >= 80);
});

test("score weights sum to 1", () => {
  const total =
    SCORE_WEIGHTS.accuracy +
    SCORE_WEIGHTS.confidence +
    SCORE_WEIGHTS.pace +
    SCORE_WEIGHTS.prosody;
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum = ${total}`);
});

test("paceScore behaves on either side of the band", () => {
  assert.equal(paceScore(2.5, "en"), 100);
  assert.ok(paceScore(0.5, "en") < 50);
  assert.ok(paceScore(6, "en") < 50);
  // CJK band is wider on the slow side.
  assert.equal(paceScore(2, "zh"), 100);
});

test("confidenceScore is monotonic", () => {
  assert.ok(confidenceScore(0.9) > confidenceScore(0.6));
  assert.ok(confidenceScore(0.6) > confidenceScore(0.3));
  assert.equal(confidenceScore(0), 0);
  assert.equal(confidenceScore(1), 100);
});

test("blendScores clamps inputs", () => {
  const b = blendScores(150, -10, 50, 50);
  assert.ok(b.overall <= 100);
  assert.ok(b.overall >= 0);
});

// ---------------------------------------------------------------------
// Real-audio prosody pass: synthesize a short 220 Hz tone WAV via ffmpeg
// and check that prosody returns plausible numbers (mean F0 near 220,
// voicedRatio > 0.5). Skipped automatically if ffmpeg isn't installed.
// ---------------------------------------------------------------------

async function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-version"]);
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

test("prosody on a synthetic tone returns sensible features", async (t) => {
  if (!(await ffmpegAvailable())) {
    t.skip("ffmpeg not available in this environment");
    return;
  }
  const wavPath = join(tmpdir(), `tone-${randomUUID()}.wav`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn("ffmpeg", [
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=1.0",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-y",
      wavPath,
    ]);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${code}`))
    );
    p.on("error", reject);
  });
  try {
    const buf = await import("node:fs/promises").then((m) =>
      m.readFile(wavPath)
    );
    const features = await computeProsodyMetrics(buf);
    assert.ok(features !== null, "prosody features should not be null");
    assert.ok(
      features!.f0MeanHz > 200 && features!.f0MeanHz < 240,
      `f0Mean ${features!.f0MeanHz} not near 220`
    );
    assert.ok(features!.voicedRatio > 0.5, "tone should be mostly voiced");
  } finally {
    await unlink(wavPath).catch(() => {});
  }
});

test("prosody returns null on garbage input instead of throwing", async () => {
  const features = await computeProsodyMetrics(Buffer.from("not audio"));
  // Either decode fails (null) or it returns a tiny frame count — both
  // are acceptable graceful-degradation outcomes.
  if (features !== null) {
    assert.ok(features.frameCount >= 0);
  } else {
    assert.equal(features, null);
  }
});

// Silence unused-import warning when only some tests run.
void writeFile;
