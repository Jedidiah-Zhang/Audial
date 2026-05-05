import OpenAI from "npm:openai";

const apiKey = Deno.env.get("OPENAI_API_KEY");
const _isConfigured = Boolean(apiKey && apiKey.trim());

export const openai = new OpenAI({
  apiKey: apiKey ?? "openai-api-key-not-configured",
});

export function isOpenaiConfigured(): boolean {
  return _isConfigured;
}

export function assertOpenaiConfigured(): void {
  if (!_isConfigured) {
    throw new Error(
      "OpenAI 未配置：请设置 OPENAI_API_KEY 环境变量后重启服务（OpenAI is not configured: set OPENAI_API_KEY and restart the server）",
    );
  }
}
