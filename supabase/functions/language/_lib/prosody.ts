// Pure-JS prosody analysis — no ffmpeg required.
// Parses WAV files directly to extract PCM samples for YIN pitch detection.

export interface ProsodyMetrics {
  f0MeanHz: number;
  f0StdHz: number;
  f0RangeHz: number;
  rmsMean: number;
  rmsStd: number;
  voicedRatio: number;
  frameCount: number;
}

// Parse RIFF WAV file and extract 16-bit mono PCM samples as Float32Array.
// Returns null if the file is not WAV or an unsupported format.
function parseWavToPcm(buffer: Uint8Array): Float32Array | null {
  if (buffer.length < 44) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Check "RIFF" header
  if (view.getUint32(0, false) !== 0x52494646) return null;
  // Check "WAVE" format
  if (view.getUint32(8, false) !== 0x57415645) return null;

  // Parse chunks: find "data" chunk
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    // Check for "fmt " — read format info
    if (chunkId === 0x666D7420) { // "fmt "
      const audioFormat = view.getUint16(offset + 8, true);
      const numChannels = view.getUint16(offset + 10, true);
      const bitsPerSample = view.getUint16(offset + 22, true);
      if (audioFormat !== 1 || numChannels !== 1 || bitsPerSample !== 16) {
        return null; // Only support 16-bit mono PCM
      }
    }
    // Check for "data"
    if (chunkId === 0x64617461) { // "data"
      const dataStart = offset + 8;
      const dataEnd = Math.min(dataStart + chunkSize, buffer.length);
      const dataLen = Math.floor((dataEnd - dataStart) / 2);
      const pcm = new Float32Array(dataLen);
      for (let i = 0; i < dataLen; i++) {
        const int16 = view.getInt16(dataStart + i * 2, true);
        pcm[i] = int16 / 0x8000;
      }
      return pcm;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return null;
}

// Simple YIN pitch detection algorithm (implemented inline to avoid dependency).
// Returns estimated F0 in Hz, or 0 if unvoiced.
function yinEstimate(
  signal: Float32Array,
  sampleRate: number,
  threshold: number = 0.15,
): number {
  const n = signal.length;
  const halfN = Math.floor(n / 2);
  const d = new Float32Array(halfN);

  // Difference function
  for (let tau = 0; tau < halfN; tau++) {
    let sum = 0;
    for (let j = 0; j < halfN; j++) {
      const diff = signal[j] - signal[j + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  // Cumulative mean normalized difference
  let runningSum = 0;
  d[0] = 1;
  for (let tau = 1; tau < halfN; tau++) {
    runningSum += d[tau];
    d[tau] *= tau / runningSum;
  }

  // Find first minimum below threshold
  let tauMin = -1;
  for (let tau = 2; tau < halfN; tau++) {
    if (d[tau] < threshold) {
      // Check if it's a local minimum
      while (tau + 1 < halfN && d[tau + 1] < d[tau]) {
        tau++;
      }
      tauMin = tau;
      break;
    }
  }

  if (tauMin < 0) return 0;

  // Parabolic interpolation for better accuracy
  const prev = d[tauMin - 1];
  const cur = d[tauMin];
  const next = d[tauMin + 1] ?? cur;
  const better = tauMin + (prev - next) / (2 * (prev - 2 * cur + next));

  return sampleRate / better;
}

// Frame-based RMS calculation
function frameRms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i] * frame[i];
  }
  return Math.sqrt(sum / frame.length);
}

const SAMPLE_RATE = 16000;
const FRAME_SIZE = Math.round(SAMPLE_RATE * 0.064); // 64ms
const HOP_SIZE = Math.round(SAMPLE_RATE * 0.016); // 16ms
const SILENCE_THRESHOLD = 0.005;

export function computeProsodyMetrics(audioBuffer: Uint8Array): ProsodyMetrics | null {
  const pcm = parseWavToPcm(audioBuffer);
  if (!pcm) return null;

  const frameCount = Math.floor((pcm.length - FRAME_SIZE) / HOP_SIZE) + 1;
  if (frameCount < 2) return null;

  const f0Values: number[] = [];
  const rmsValues: number[] = [];

  for (let i = 0; i < frameCount; i++) {
    const start = i * HOP_SIZE;
    const frame = pcm.slice(start, start + FRAME_SIZE);
    const rms = frameRms(frame);
    rmsValues.push(rms);

    if (rms >= SILENCE_THRESHOLD) {
      const f0 = yinEstimate(frame, SAMPLE_RATE);
      if (f0 > 0) f0Values.push(f0);
    }
  }

  if (f0Values.length === 0 || rmsValues.length === 0) return null;

  // F0 statistics
  const f0Mean = f0Values.reduce((a, b) => a + b, 0) / f0Values.length;
  const f0Std = Math.sqrt(f0Values.reduce((s, v) => s + (v - f0Mean) ** 2, 0) / f0Values.length);
  const f0Min = Math.min(...f0Values);
  const f0Max = Math.max(...f0Values);

  // RMS statistics
  const rmsMean = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
  const rmsStd = Math.sqrt(rmsValues.reduce((s, v) => s + (v - rmsMean) ** 2, 0) / rmsValues.length);

  const voicedRatio = f0Values.length / frameCount;

  return {
    f0MeanHz: f0Mean,
    f0StdHz: f0Std,
    f0RangeHz: f0Max - f0Min,
    rmsMean,
    rmsStd,
    voicedRatio,
    frameCount,
  };
}
