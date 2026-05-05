import OpenAI from "openai";

const apiKey = process.env.DEEPSEEK_API_KEY;
const _isConfigured = Boolean(apiKey && apiKey.trim());

if (!_isConfigured) {
  console.warn(
    "\n" +
      "============================================================\n" +
      "⚠️  WARN: DEEPSEEK_API_KEY is not set.\n" +
      "    The 6 text-based AI endpoints (/language/generate-text,\n" +
      "    translate, word-detail, score-pronunciation,\n" +
      "    score-dictation, score-recitation) will return HTTP 503.\n" +
      "    Audio (TTS/STT) and image generation are unaffected.\n" +
      "    Add DEEPSEEK_API_KEY (https://platform.deepseek.com) as\n" +
      "    an environment variable to enable these features.\n" +
      "============================================================\n",
  );
}

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";

export const deepseek = new OpenAI({
  apiKey: apiKey ?? "deepseek-api-key-not-configured",
  baseURL: DEEPSEEK_BASE_URL,
});

export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

export function isDeepseekConfigured(): boolean {
  return _isConfigured;
}
