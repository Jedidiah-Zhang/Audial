import type { Context, Next } from "npm:hono";

const ALLOWED_HEADERS =
  "Content-Type, Authorization, x-target-text, x-language, x-target-language, x-audio-format, x-test-user-id, x-reward-token, x-user-id, x-tier";

export async function corsMiddleware(c: Context, next: Next) {
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": ALLOWED_HEADERS,
      },
    });
  }

  try {
    const res = await next();
    res.headers.set("Access-Control-Allow-Origin", "*");
    return res;
  } catch (e) {
    // On error, Hono returns a 500 without CORS headers, which causes
    // the browser to block the response entirely. Catch and wrap so the
    // error body is readable by the client.
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[cors] caught error:", detail, e);
    return new Response(
      JSON.stringify({ success: false, error: "internal server error", detail }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}
