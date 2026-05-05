import type { Context, Next } from "npm:hono";

export async function corsMiddleware(c: Context, next: Next) {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-target-text, x-language, x-target-language, x-audio-format, x-test-user-id, x-reward-token, x-user-id, x-tier");
  if (c.req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  await next();
}
