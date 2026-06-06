import OpenAI from "npm:openai";

const apiKey = Deno.env.get("DEEPSEEK_API_KEY");
const _isConfigured = Boolean(apiKey && apiKey.trim());

export const deepseek = new OpenAI({
  apiKey: apiKey ?? "deepseek-api-key-not-configured",
  baseURL: Deno.env.get("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com",
});

export const DEEPSEEK_MODEL = Deno.env.get("DEEPSEEK_MODEL") ?? "deepseek-v4-flash";

export function isDeepseekConfigured(): boolean {
  return _isConfigured;
}
