export {
  openai,
  detectAudioFormat,
  convertToWav,
  ensureCompatibleFormat,
  type AudioFormat,
  voiceChat,
  voiceChatStream,
  textToSpeech,
  textToSpeechStream,
  speechToText,
  speechToTextDetailed,
  speechToTextStream,
  type DetailedTranscript,
  type DetailedTranscriptWord,
  type DetailedTranscriptSegment,
} from "./client";
export { isOpenaiConfigured, OpenAINotConfiguredError } from "../client";
