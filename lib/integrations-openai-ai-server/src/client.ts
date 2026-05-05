import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;
const _isConfigured = Boolean(apiKey && apiKey.trim());

if (!_isConfigured) {
  console.warn(
    "\n" +
      "============================================================\n" +
      "⚠️  WARN: OPENAI_API_KEY is not set.\n" +
      "    Audio (TTS / STT / voice chat) and image generation\n" +
      "    endpoints will return HTTP 503 until configured.\n" +
      "    Text-based AI (DeepSeek) endpoints are unaffected.\n" +
      "    Get a key at https://platform.openai.com and add it as\n" +
      "    the OPENAI_API_KEY environment variable to enable these features.\n" +
      "============================================================\n",
  );
}

export const openai = new OpenAI({
  apiKey: apiKey ?? "openai-api-key-not-configured",
});

export function isOpenaiConfigured(): boolean {
  return _isConfigured;
}

export class OpenAINotConfiguredError extends Error {
  constructor() {
    super(
      "OpenAI 未配置：请到 https://platform.openai.com 申请 API key，然后设置 OPENAI_API_KEY 环境变量后重启服务（OpenAI is not configured: set OPENAI_API_KEY and restart the server）",
    );
    this.name = "OpenAINotConfiguredError";
  }
}

export function assertOpenaiConfigured(): void {
  if (!_isConfigured) throw new OpenAINotConfiguredError();
}
