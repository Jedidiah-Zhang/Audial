import { toFile } from "openai";
import { Buffer } from "node:buffer";
import { spawn } from "child_process";
import { writeFile, unlink, readFile } from "fs/promises";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { openai, assertOpenaiConfigured } from "../client";

export { openai };

export type AudioFormat = "wav" | "mp3" | "webm" | "mp4" | "ogg" | "unknown";

/**
 * Detect audio format from buffer magic bytes.
 * Supports: WAV, MP3, WebM (Chrome/Firefox), MP4/M4A/MOV (Safari/iOS), OGG
 */
export function detectAudioFormat(buffer: Buffer): AudioFormat {
  if (buffer.length < 12) return "unknown";

  // WAV: RIFF....WAVE
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    return "wav";
  }
  // WebM: EBML header
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return "webm";
  }
  // MP3: ID3 tag or frame sync
  if (
    (buffer[0] === 0xff && (buffer[1] === 0xfb || buffer[1] === 0xfa || buffer[1] === 0xf3)) ||
    (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33)
  ) {
    return "mp3";
  }
  // MP4/M4A/MOV: ....ftyp (Safari/iOS records in these containers)
  if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    return "mp4";
  }
  // OGG: OggS
  if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
    return "ogg";
  }
  return "unknown";
}

/**
 * Convert any audio/video format to WAV using ffmpeg.
 */
export async function convertToWav(audioBuffer: Buffer): Promise<Buffer> {
  const inputPath = join(tmpdir(), `input-${randomUUID()}`);
  const outputPath = join(tmpdir(), `output-${randomUUID()}.wav`);

  try {
    await writeFile(inputPath, audioBuffer);

    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", [
        "-i", inputPath,
        "-vn",
        "-f", "wav",
        "-ar", "16000",
        "-ac", "1",
        "-acodec", "pcm_s16le",
        "-y",
        outputPath,
      ]);

      ffmpeg.stderr.on("data", () => {});
      ffmpeg.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}`));
      });
      ffmpeg.on("error", reject);
    });

    return await readFile(outputPath);
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

/**
 * Auto-detect and convert audio to OpenAI-compatible format.
 */
export async function ensureCompatibleFormat(
  audioBuffer: Buffer
): Promise<{ buffer: Buffer; format: "wav" | "mp3" }> {
  const detected = detectAudioFormat(audioBuffer);
  if (detected === "wav") return { buffer: audioBuffer, format: "wav" };
  if (detected === "mp3") return { buffer: audioBuffer, format: "mp3" };
  const wavBuffer = await convertToWav(audioBuffer);
  return { buffer: wavBuffer, format: "wav" };
}

/** Voice Chat: audio-in, audio-out using gpt-audio.
 * @deprecated gpt-audio model was deprecated. Use the Realtime API instead. */
export async function voiceChat(
  audioBuffer: Buffer,
  voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "alloy",
  inputFormat: "wav" | "mp3" = "wav",
  outputFormat: "wav" | "mp3" = "mp3"
): Promise<{ transcript: string; audioResponse: Buffer }> {
  throw new Error("voiceChat is deprecated: gpt-audio model was removed. Use gpt-4o-mini-tts for TTS and gpt-4o-mini-transcribe for STT separately.");
}

/** Streaming Voice Chat for real-time audio responses.
 * @deprecated gpt-audio model was deprecated. Use the Realtime API instead. */
export async function voiceChatStream(
  audioBuffer: Buffer,
  voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "alloy",
  inputFormat: "wav" | "mp3" = "wav"
): Promise<AsyncIterable<{ type: "transcript" | "audio"; data: string }>> {
  throw new Error("voiceChatStream is deprecated: gpt-audio model was removed. Use gpt-4o-mini-tts for TTS and gpt-4o-mini-transcribe for STT separately.");
}

/** Text-to-Speech using gpt-4o-mini-tts (Speech API). */
export async function textToSpeech(
  text: string,
  voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "alloy",
  format: "wav" | "mp3" | "flac" | "opus" | "pcm" = "wav"
): Promise<Buffer> {
  assertOpenaiConfigured();
  const response = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice,
    input: text,
    response_format: format,
  });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** Streaming Text-to-Speech.
 * @deprecated gpt-audio model was deprecated. Use textToSpeech() (non-streaming) with gpt-4o-mini-tts instead. */
export async function textToSpeechStream(
  text: string,
  voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "alloy"
): Promise<AsyncIterable<string>> {
  throw new Error("textToSpeechStream is deprecated: gpt-audio model was removed. Use textToSpeech() with gpt-4o-mini-tts instead.");
}

/** Speech-to-Text using gpt-4o-mini-transcribe. */
export async function speechToText(
  audioBuffer: Buffer,
  format: "wav" | "mp3" | "webm" = "wav",
  /**
   * Optional ISO 639-1 language hint. Whisper-family models default to
   * English on short clips when no hint is given, so pass it whenever
   * the caller knows what language the audio is in.
   */
  language?: string
): Promise<string> {
  assertOpenaiConfigured();
  const file = await toFile(audioBuffer, `audio.${format}`);
  const response = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
    ...(language ? { language } : {}),
  });
  return response.text;
}

/**
 * Detailed Speech-to-Text using whisper-1 with verbose_json + word
 * timestamps. Returns word-level timings + per-segment log-probs so
 * downstream code can compute confidence / pace / pause metrics.
 *
 * Kept separate from `speechToText` (which uses gpt-4o-mini-transcribe
 * for plain text and is much cheaper) so other call sites — recitation,
 * dictation, generic STT — are unaffected. Only the shadowing scoring
 * path needs the extra signal.
 */
export interface DetailedTranscriptWord {
  word: string;
  start: number;
  end: number;
}
export interface DetailedTranscriptSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob: number;
  no_speech_prob: number;
}
export interface DetailedTranscript {
  text: string;
  words: DetailedTranscriptWord[];
  segments: DetailedTranscriptSegment[];
  duration: number;
}

export async function speechToTextDetailed(
  audioBuffer: Buffer,
  format: "wav" | "mp3" = "wav",
  /**
   * Optional ISO 639-1 language hint (e.g. "en", "zh", "ja", "ko", "es").
   * Whisper auto-detects when omitted, but for short clips it tends to
   * default to English, which makes a Mandarin shadowing pass come back
   * as romanised English garbage. Always pass the target language when
   * the caller knows it.
   */
  language?: string
): Promise<DetailedTranscript> {
  assertOpenaiConfigured();
  const file = await toFile(audioBuffer, `audio.${format}`);
  const response = (await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["word", "segment"],
    ...(language ? { language } : {}),
  } as never)) as unknown as {
    text: string;
    duration?: number;
    words?: { word: string; start: number; end: number }[];
    segments?: {
      start: number;
      end: number;
      text: string;
      avg_logprob: number;
      no_speech_prob: number;
    }[];
  };
  return {
    text: response.text ?? "",
    duration: typeof response.duration === "number" ? response.duration : 0,
    words: Array.isArray(response.words)
      ? response.words.map((w) => ({
          word: String(w.word ?? ""),
          start: Number(w.start ?? 0),
          end: Number(w.end ?? 0),
        }))
      : [],
    segments: Array.isArray(response.segments)
      ? response.segments.map((s) => ({
          start: Number(s.start ?? 0),
          end: Number(s.end ?? 0),
          text: String(s.text ?? ""),
          avg_logprob: Number(s.avg_logprob ?? 0),
          no_speech_prob: Number(s.no_speech_prob ?? 0),
        }))
      : [],
  };
}

/** Streaming Speech-to-Text. */
export async function speechToTextStream(
  audioBuffer: Buffer,
  format: "wav" | "mp3" | "webm" = "wav"
): Promise<AsyncIterable<string>> {
  assertOpenaiConfigured();
  const file = await toFile(audioBuffer, `audio.${format}`);
  const stream = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
    stream: true,
  });

  return (async function* () {
    for await (const event of stream) {
      if (event.type === "transcript.text.delta") {
        yield event.delta;
      }
    }
  })();
}
