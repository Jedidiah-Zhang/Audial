import { Hono } from "npm:hono";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsMiddleware } from "../_shared/cors.ts";
import healthApp from "../health/index.ts";
import languageApp from "../language/index.ts";
import syncApp from "../sync/index.ts";

const app = new Hono();

app.use("*", corsMiddleware);

app.route("/api/healthz", healthApp);
app.route("/api/language", languageApp);
app.route("/api/sync", syncApp);

serve((req: Request) => app.fetch(req));
