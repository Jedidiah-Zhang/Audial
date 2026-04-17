import type { AmbientScene } from "./sceneDetect";

const SAMPLE_RATE = 22050;
const DEFAULT_LENGTH_SEC = 8;

const wavCache = new Map<AmbientScene, ArrayBuffer>();
const dataUriCache = new Map<AmbientScene, string>();

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

const B64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < len ? bytes[i + 1] : 0;
    const b3 = i + 2 < len ? bytes[i + 2] : 0;
    const triplet = (b1 << 16) | (b2 << 8) | b3;
    out += B64_CHARS[(triplet >> 18) & 0x3f];
    out += B64_CHARS[(triplet >> 12) & 0x3f];
    out += i + 1 < len ? B64_CHARS[(triplet >> 6) & 0x3f] : "=";
    out += i + 2 < len ? B64_CHARS[triplet & 0x3f] : "=";
  }
  return out;
}

// ---------- Noise generators ----------

function pinkNoise(samples: number, gain = 0.1): Float32Array {
  const out = new Float32Array(samples);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < samples; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
    out[i] = pink * gain;
  }
  return out;
}

function brownNoise(samples: number, gain = 0.2): Float32Array {
  const out = new Float32Array(samples);
  let last = 0;
  for (let i = 0; i < samples; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    out[i] = last * 3.5 * gain;
  }
  return out;
}

// 1-pole low-pass filter
function lowpass(buf: Float32Array, cutoffHz: number, sampleRate = SAMPLE_RATE): Float32Array {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const a = dt / (rc + dt);
  let prev = 0;
  for (let i = 0; i < buf.length; i++) {
    prev = prev + a * (buf[i] - prev);
    buf[i] = prev;
  }
  return buf;
}

// 1-pole high-pass filter
function highpass(buf: Float32Array, cutoffHz: number, sampleRate = SAMPLE_RATE): Float32Array {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const a = rc / (rc + dt);
  let prevIn = 0;
  let prevOut = 0;
  for (let i = 0; i < buf.length; i++) {
    const cur = buf[i];
    const out = a * (prevOut + cur - prevIn);
    prevIn = cur;
    prevOut = out;
    buf[i] = out;
  }
  return buf;
}

// ---------- Event generators ----------

function addInto(target: Float32Array, src: Float32Array, offset: number, gain = 1) {
  const end = Math.min(target.length, offset + src.length);
  for (let i = offset; i < end; i++) target[i] += src[i - offset] * gain;
}

function clink(durSec = 0.18, baseFreq = 3500): Float32Array {
  const n = Math.floor(durSec * SAMPLE_RATE);
  const out = new Float32Array(n);
  const f1 = baseFreq * (0.85 + Math.random() * 0.3);
  const f2 = f1 * 1.51;
  const decay = 6 + Math.random() * 4;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * decay);
    out[i] =
      env *
      (Math.sin(2 * Math.PI * f1 * t) * 0.6 +
        Math.sin(2 * Math.PI * f2 * t) * 0.3) *
      0.35;
  }
  return out;
}

function tap(durSec = 0.05): Float32Array {
  const n = Math.floor(durSec * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 80);
    out[i] = env * (Math.random() * 2 - 1) * 0.4;
  }
  return highpass(out, 1500);
}

function chirp(): Float32Array {
  const dur = 0.18 + Math.random() * 0.18;
  const n = Math.floor(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  const f0 = 2200 + Math.random() * 1200;
  const f1 = f0 + (Math.random() * 1500 - 200);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const p = t / dur;
    const f = f0 + (f1 - f0) * p;
    const env = Math.sin(Math.PI * p) * 0.35;
    out[i] = env * Math.sin(2 * Math.PI * f * t);
  }
  return out;
}

function swoosh(durSec = 1.6): Float32Array {
  const n = Math.floor(durSec * SAMPLE_RATE);
  const out = pinkNoise(n, 0.5);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const p = t / durSec;
    const env = Math.sin(Math.PI * p);
    out[i] *= env * env * 0.6;
  }
  lowpass(out, 700);
  return out;
}

function honk(): Float32Array {
  const dur = 0.35;
  const n = Math.floor(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  const freq = 320 + Math.random() * 100;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const p = t / dur;
    const env = p < 0.05 ? p / 0.05 : Math.exp(-(t - 0.05) * 5);
    // square-ish: triangle + odd harmonics
    const s =
      Math.sin(2 * Math.PI * freq * t) * 0.5 +
      Math.sin(2 * Math.PI * freq * 2 * t) * 0.25 +
      Math.sin(2 * Math.PI * freq * 3 * t) * 0.15;
    out[i] = env * s * 0.18;
  }
  return out;
}

function wave(durSec = 3.5): Float32Array {
  const n = Math.floor(durSec * SAMPLE_RATE);
  const noise = pinkNoise(n, 0.7);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const p = t / durSec;
    const env = Math.pow(Math.sin(Math.PI * p), 1.5);
    noise[i] *= env * 0.7;
  }
  lowpass(noise, 1200);
  return noise;
}

function rumble(durSec: number, freq = 65): Float32Array {
  const n = Math.floor(durSec * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    out[i] = Math.sin(2 * Math.PI * freq * t) * 0.04;
  }
  return out;
}

function chatterMurmur(samples: number, gain = 0.16): Float32Array {
  // Two layers of low-passed pink noise modulated by slow LFOs to evoke
  // distant background voice murmur without using actual speech.
  const a = pinkNoise(samples, gain);
  const b = pinkNoise(samples, gain * 0.7);
  lowpass(a, 900);
  highpass(a, 200);
  lowpass(b, 600);
  highpass(b, 150);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const lfo1 = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.7 * t + 0.4);
    const lfo2 = 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.1 * t + 1.3);
    const lfo3 = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.23 * t);
    out[i] = (a[i] * lfo1 + b[i] * lfo2) * (0.5 + 0.5 * lfo3);
  }
  return out;
}

// ---------- Scene synthesis ----------

function scatter(
  target: Float32Array,
  totalSec: number,
  ratePerSec: number,
  generator: () => Float32Array,
  gain = 1
) {
  const n = target.length;
  const expected = Math.max(1, Math.floor(ratePerSec * totalSec));
  for (let k = 0; k < expected * 1.5; k++) {
    if (Math.random() > 0.66) continue;
    const offset = Math.floor(Math.random() * n);
    addInto(target, generator(), offset, gain);
  }
}

function buildScene(scene: AmbientScene, sec = DEFAULT_LENGTH_SEC): Float32Array {
  const n = sec * SAMPLE_RATE;
  const out = new Float32Array(n);

  switch (scene) {
    case "cafe": {
      const base = chatterMurmur(n, 0.18);
      for (let i = 0; i < n; i++) out[i] += base[i];
      scatter(out, sec, 1.4, () => clink(0.15, 3200 + Math.random() * 1500), 0.7);
      scatter(out, sec, 0.25, () => tap(0.04), 0.4);
      addInto(out, rumble(sec, 80), 0, 1);
      break;
    }
    case "restaurant": {
      const base = chatterMurmur(n, 0.22);
      for (let i = 0; i < n; i++) out[i] += base[i];
      scatter(out, sec, 0.9, () => clink(0.18, 2600 + Math.random() * 1400), 0.85);
      scatter(out, sec, 0.4, () => tap(0.05), 0.5);
      // gentle low rumble
      addInto(out, rumble(sec, 70), 0, 1);
      break;
    }
    case "office": {
      const drone = pinkNoise(n, 0.08);
      lowpass(drone, 220);
      for (let i = 0; i < n; i++) out[i] += drone[i] * 0.9;
      scatter(out, sec, 6, () => tap(0.04), 0.45);
      scatter(out, sec, 0.4, () => clink(0.1, 1800), 0.25);
      break;
    }
    case "street": {
      const traffic = brownNoise(n, 0.18);
      lowpass(traffic, 500);
      for (let i = 0; i < n; i++) out[i] += traffic[i];
      scatter(out, sec, 0.4, () => swoosh(1.4 + Math.random() * 0.8), 0.6);
      scatter(out, sec, 0.18, () => honk(), 0.5);
      break;
    }
    case "train": {
      const ru = brownNoise(n, 0.22);
      lowpass(ru, 350);
      for (let i = 0; i < n; i++) out[i] += ru[i];
      // rhythmic clack
      const clack = (): Float32Array => {
        const d = 0.07;
        const m = Math.floor(d * SAMPLE_RATE);
        const arr = new Float32Array(m);
        for (let i = 0; i < m; i++) {
          const t = i / SAMPLE_RATE;
          const env = Math.exp(-t * 60);
          arr[i] = env * (Math.random() * 2 - 1) * 0.55;
        }
        lowpass(arr, 1200);
        return arr;
      };
      const beat = 0.55; // seconds between clacks
      for (let t = 0.1; t < sec; t += beat) {
        addInto(out, clack(), Math.floor(t * SAMPLE_RATE), 0.7);
        addInto(out, clack(), Math.floor((t + 0.18) * SAMPLE_RATE), 0.45);
      }
      break;
    }
    case "airport": {
      const drone = pinkNoise(n, 0.16);
      lowpass(drone, 700);
      highpass(drone, 80);
      for (let i = 0; i < n; i++) out[i] += drone[i];
      const murmur = chatterMurmur(n, 0.1);
      for (let i = 0; i < n; i++) out[i] += murmur[i] * 0.8;
      // rolling suitcase ticks
      scatter(out, sec, 1.5, () => tap(0.03), 0.3);
      addInto(out, rumble(sec, 55), 0, 1.2);
      break;
    }
    case "beach": {
      // Repeating gentle wave swells
      let t = 0;
      while (t < sec) {
        const w = wave(3 + Math.random() * 1.5);
        addInto(out, w, Math.floor(t * SAMPLE_RATE), 0.9);
        t += 2.6;
      }
      const wind = pinkNoise(n, 0.06);
      lowpass(wind, 600);
      for (let i = 0; i < n; i++) out[i] += wind[i];
      break;
    }
    case "nature": {
      const wind = pinkNoise(n, 0.08);
      lowpass(wind, 800);
      for (let i = 0; i < n; i++) out[i] += wind[i];
      scatter(out, sec, 0.7, () => chirp(), 0.5);
      // distant rustle
      scatter(out, sec, 0.3, () => swoosh(0.6 + Math.random() * 0.4), 0.25);
      break;
    }
    case "classroom": {
      const drone = pinkNoise(n, 0.05);
      lowpass(drone, 300);
      for (let i = 0; i < n; i++) out[i] += drone[i];
      const murmur = chatterMurmur(n, 0.1);
      for (let i = 0; i < n; i++) out[i] += murmur[i];
      scatter(out, sec, 0.6, () => tap(0.04), 0.3);
      break;
    }
    case "shop": {
      const murmur = chatterMurmur(n, 0.14);
      for (let i = 0; i < n; i++) out[i] += murmur[i];
      // beeps (cashier scanner)
      const beep = (): Float32Array => {
        const d = 0.08;
        const m = Math.floor(d * SAMPLE_RATE);
        const arr = new Float32Array(m);
        const f = 1800;
        for (let i = 0; i < m; i++) {
          const t = i / SAMPLE_RATE;
          const env = t < 0.005 ? t / 0.005 : Math.exp(-(t - 0.005) * 20);
          arr[i] = env * Math.sin(2 * Math.PI * f * t) * 0.18;
        }
        return arr;
      };
      scatter(out, sec, 0.5, beep, 0.7);
      break;
    }
    case "home": {
      const hum = pinkNoise(n, 0.05);
      lowpass(hum, 250);
      for (let i = 0; i < n; i++) out[i] += hum[i];
      // occasional clicks (keys, light switches)
      scatter(out, sec, 0.25, () => tap(0.05), 0.3);
      break;
    }
    case "generic":
    default: {
      const base = chatterMurmur(n, 0.12);
      for (let i = 0; i < n; i++) out[i] += base[i];
      addInto(out, rumble(sec, 70), 0, 1);
      break;
    }
  }

  // Seamless loop fade
  const fadeLen = Math.floor(SAMPLE_RATE * 0.12);
  for (let i = 0; i < fadeLen; i++) {
    const a = i / fadeLen;
    out[i] *= a;
    out[n - 1 - i] *= a;
  }

  // Soft clip / safety
  for (let i = 0; i < n; i++) {
    const x = out[i];
    out[i] = Math.max(-0.95, Math.min(0.95, x));
  }
  return out;
}

function encodeWav(samples: Float32Array): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

export function getAmbientWav(scene: AmbientScene = "generic"): ArrayBuffer {
  const cached = wavCache.get(scene);
  if (cached) return cached;
  const samples = buildScene(scene);
  const buf = encodeWav(samples);
  wavCache.set(scene, buf);
  return buf;
}

export function getAmbientDataUri(scene: AmbientScene = "generic"): string {
  const cached = dataUriCache.get(scene);
  if (cached) return cached;
  const buf = getAmbientWav(scene);
  const uri = `data:audio/wav;base64,${bytesToBase64(new Uint8Array(buf))}`;
  dataUriCache.set(scene, uri);
  return uri;
}
