import { Hono } from "npm:hono";
import { corsMiddleware } from "../_shared/cors.ts";

const app = new Hono();

app.use("*", corsMiddleware);

app.get("/", (c) => {
  return c.json({ status: "ok" });
});

app.get("/db-check", async (c) => {
  try {
    const { sql } = await import("../_shared/db.ts");
    const result = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    return c.json({ ok: true, tables: result.map((r: any) => r.table_name) });
  } catch (e) {
    return c.json({ ok: false, error: String(e), stack: (e as Error).stack }, 500);
  }
});

export default app;
