import { openai, assertOpenaiConfigured } from "../../_shared/openai-client.ts";

// Text-to-speech using OpenAI TTS
export async function textToSpeech(
  text: string,
  voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "nova",
  format: "mp3" | "wav" = "mp3",
): Promise<Uint8Array> {
  assertOpenaiConfigured();
  const response = await openai.audio.speech.create({
    model: "tts-1",
    voice,
    input: text,
    response_format: format,
  });
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

// Speech-to-text using OpenAI Whisper
// Accepts WAV or MP3 audio buffer directly (no ffmpeg conversion)
export async function speechToText(
  audioBuffer: Uint8Array,
  format: string = "wav",
  language?: string,
): Promise<string> {
  assertOpenaiConfigured();
  const ext = format === "mp3" ? "mp3" : "wav";
  const blob = new Blob([audioBuffer], { type: `audio/${ext}` });
  const file = new File([blob], `audio.${ext}`, { type: `audio/${ext}` });
  const response = await openai.audio.transcriptions.create({
    model: "gpt-4o-mini-transcribe",
    file,
    language: language || undefined,
  });
  return response.text;
}

// Detailed STT with word timestamps
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
  duration: number;
  words: DetailedTranscriptWord[];
  segments: DetailedTranscriptSegment[];
}

export async function speechToTextDetailed(
  audioBuffer: Uint8Array,
  format: string = "wav",
  language?: string,
): Promise<DetailedTranscript> {
  assertOpenaiConfigured();
  const ext = format === "mp3" ? "mp3" : "wav";
  const blob = new Blob([audioBuffer], { type: `audio/${ext}` });
  const file = new File([blob], `audio.${ext}`, { type: `audio/${ext}` });

  const response = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file,
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
    language: language || undefined,
  }) as DetailedTranscript;
  return response;
}
