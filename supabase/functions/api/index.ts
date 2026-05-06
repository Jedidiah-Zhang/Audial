import { Hono } from "npm:hono";
import healthApp from "../health/index.ts";
import languageApp from "../language/index.ts";
import syncApp from "../sync/index.ts";

const ALLOWED_HEADERS =
  "Content-Type, Authorization, x-target-text, x-language, x-target-language, x-audio-format, x-test-user-id, x-reward-token, x-user-id, x-tier";

const app = new Hono();

app.onError((err, c) => {
  console.error("[api] unhandled error:", err);
  return c.json({ success: false, error: "internal server error", detail: String(err) }, 500);
});

app.route("/api/healthz", healthApp);
app.route("/api/language", languageApp);
app.route("/api/sync", syncApp);

// Wrap at the server level so CORS headers are guaranteed on every
// response — including early returns from sub-app middleware (quota
// enforcement, auth failures, etc.) where Hono may short-circuit
// before parent-level middleware gets to post-process.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": ALLOWED_HEADERS,
      },
    });
  }

  const res = await app.fetch(req);
  res.headers.set("Access-Control-Allow-Origin", "*");
  return res;
});
