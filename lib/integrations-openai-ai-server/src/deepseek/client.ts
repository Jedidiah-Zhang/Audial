import OpenAI from "openai";

if (!process.env.DEEPSEEK_API_KEY) {
  throw new Error(
    "DEEPSEEK_API_KEY must be set. Add your DeepSeek API key (https://platform.deepseek.com) as a Replit secret to enable text-based AI features.",
  );
}

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";

export const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: DEEPSEEK_BASE_URL,
});

export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
