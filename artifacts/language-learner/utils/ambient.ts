let cachedWav: ArrayBuffer | null = null;
let cachedDataUri: string | null = null;

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

function bufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer));
}

function generatePinkNoiseWav(seconds = 6, sampleRate = 22050): ArrayBuffer {
  const totalSamples = Math.floor(seconds * sampleRate);
  const data = new Float32Array(totalSamples);

  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < totalSamples; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    let pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    pink *= 0.11;

    // Slow, gentle amplitude modulation simulating distant murmur of café/room
    const t = i / sampleRate;
    const slow =
      0.55 +
      0.25 * Math.sin(2 * Math.PI * 0.13 * t) +
      0.15 * Math.sin(2 * Math.PI * 0.31 * t + 1.7);

    data[i] = pink * slow;
  }

  // Smooth start/end fade so the loop crossfade feels seamless
  const fadeLen = Math.floor(sampleRate * 0.08);
  for (let i = 0; i < fadeLen; i++) {
    const a = i / fadeLen;
    data[i] *= a;
    data[totalSamples - 1 - i] *= a;
  }

  // Encode as 16-bit PCM mono WAV
  const dataBytes = totalSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < totalSamples; i++) {
    let s = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

export function getAmbientWav(): ArrayBuffer {
  if (!cachedWav) cachedWav = generatePinkNoiseWav();
  return cachedWav;
}

export function getAmbientDataUri(): string {
  if (!cachedDataUri) {
    const buf = getAmbientWav();
    cachedDataUri = `data:audio/wav;base64,${bufferToBase64(buf)}`;
  }
  return cachedDataUri;
}
