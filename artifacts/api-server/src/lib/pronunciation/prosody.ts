import { spawn } from "child_process";
import { writeFile, unlink, readFile } from "fs/promises";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { Buffer } from "node:buffer";
import Pitchfinder from "pitchfinder";

/**
 * Per-utterance prosody features. All are derived from the user's audio
 * alone — no transcript needed. The whole pipeline is wrapped in a
 * try/catch by the caller (`computeProsodyMetrics`) so any failure
 * here returns null instead of crashing the scoring request.
 */
export interface ProsodyMetrics {
  /** Mean F0 across voiced frames, in Hz. */
  f0MeanHz: number;
  /** Standard deviation of F0 across voiced frames, in Hz. */
  f0StdHz: number;
  /** F0 range (max - min) across voiced frames, in Hz. */
  f0RangeHz: number;
  /** RMS energy mean across all frames (0–1ish, depending on input gain). */
  rmsMean: number;
  /** Standard deviation of RMS energy across frames. */
  rmsStd: number;
  /** Fraction of frames with detectable F0 (0–1). */
  voicedRatio: number;
  /** Number of analysis frames used. */
  frameCount: number;
}

const SAMPLE_RATE = 16000;
// 64 ms / 16 ms hop. Larger than the typical 25/10 because YIN needs at
// least ~2× the longest detectable period of audio in a single frame
// to lock on; 25 ms gives it almost no headroom for low male voices
// (~80 Hz fundamental → 12.5 ms period → 25 ms barely enough). 64 ms
// covers everything down to ~30 Hz with margin and still gives ~60
// frames per second of analysis, which is plenty for prosody stats.
const FRAME_MS = 64;
const HOP_MS = 16;
const FRAME_SIZE = Math.round((SAMPLE_RATE * FRAME_MS) / 1000);
const HOP_SIZE = Math.round((SAMPLE_RATE * HOP_MS) / 1000);

/**
 * Decode any audio buffer to 16 kHz mono PCM s16le using ffmpeg, then
 * return a Float32Array in [-1, 1].
 */
async function decodeToPcm(audioBuffer: Buffer): Promise<Float32Array> {
  const inputPath = join(tmpdir(), `prosody-in-${randomUUID()}`);
  const outputPath = join(tmpdir(), `prosody-out-${randomUUID()}.raw`);
  try {
    await writeFile(inputPath, audioBuffer);
    await new Promise<void>((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-i",
        inputPath,
        "-vn",
        "-f",
        "s16le",
        "-ar",
        String(SAMPLE_RATE),
        "-ac",
        "1",
        "-acodec",
        "pcm_s16le",
        "-y",
        outputPath,
      ]);
      ff.stderr.on("data", () => {});
      ff.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}`));
      });
      ff.on("error", reject);
    });
    const raw = await readFile(outputPath);
    // s16le → float32 normalized to [-1, 1].
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const sampleCount = Math.floor(raw.byteLength / 2);
    const out = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      out[i] = view.getInt16(i * 2, true) / 0x8000;
    }
    return out;
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

function frameRms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

function meanStdRange(values: number[]): {
  mean: number;
  std: number;
  range: number;
} {
  if (values.length === 0) return { mean: 0, std: 0, range: 0 };
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) * (v - mean);
  const std = Math.sqrt(sq / values.length);
  return { mean, std, range: max - min };
}

/**
 * Decode the audio and compute prosody features. Returns null on any
 * error (decode failure, ffmpeg missing, empty audio, etc.) so callers
 * can degrade gracefully and surface a "prosody unavailable" flag
 * instead of a 500.
 */
export async function computeProsodyMetrics(
  audioBuffer: Buffer
): Promise<ProsodyMetrics | null> {
  try {
    if (!audioBuffer || audioBuffer.length === 0) return null;
    const pcm = await decodeToPcm(audioBuffer);
    if (pcm.length < FRAME_SIZE) return null;

    const detectPitch = Pitchfinder.YIN({ sampleRate: SAMPLE_RATE });

    const f0Values: number[] = [];
    const rmsValues: number[] = [];
    let voicedFrames = 0;
    let totalFrames = 0;

    for (let start = 0; start + FRAME_SIZE <= pcm.length; start += HOP_SIZE) {
      const frame = pcm.subarray(start, start + FRAME_SIZE);
      totalFrames += 1;
      const rms = frameRms(frame);
      rmsValues.push(rms);
      // Skip silent frames to avoid feeding noise into the pitch
      // detector — they pollute the F0 stats.
      if (rms < 0.005) continue;
      const f0 = detectPitch(frame);
      if (f0 && f0 > 50 && f0 < 500) {
        f0Values.push(f0);
        voicedFrames += 1;
      }
    }

    if (totalFrames === 0) return null;
    const f0Stats = meanStdRange(f0Values);
    const rmsStats = meanStdRange(rmsValues);
    return {
      f0MeanHz: f0Stats.mean,
      f0StdHz: f0Stats.std,
      f0RangeHz: f0Stats.range,
      rmsMean: rmsStats.mean,
      rmsStd: rmsStats.std,
      voicedRatio: voicedFrames / totalFrames,
      frameCount: totalFrames,
    };
  } catch {
    return null;
  }
}
