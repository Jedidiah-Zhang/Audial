import { createClerkClient, verifyToken } from "npm:@clerk/backend";
import { db, usersTable } from "./db.ts";
import { eq } from "npm:drizzle-orm";
import type { Context, Next } from "npm:hono";

const secretKey = Deno.env.get("CLERK_SECRET_KEY");
const publishableKey = Deno.env.get("CLERK_PUBLISHABLE_KEY");

const clerkClient = secretKey
  ? createClerkClient({ secretKey, publishableKey })
  : null;

export interface AuthState {
  userId: string;
  tier: "free" | "pro";
}

const userCache = new Map<string, { tier: "free" | "pro"; ts: number }>();
const USER_CACHE_TTL_MS = 30_000;

async function ensureUserRow(userId: string): Promise<"free" | "pro"> {
  const cached = userCache.get(userId);
  if (cached && Date.now() - cached.ts < USER_CACHE_TTL_MS) {
    return cached.tier;
  }
  const rows = await db
    .select({ tier: usersTable.tier })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  let tier: "free" | "pro" = "free";
  if (rows.length === 0) {
    await db
      .insert(usersTable)
      .values({ id: userId, tier: "free" })
      .onConflictDoNothing();
  } else {
    tier = rows[0].tier === "pro" ? "pro" : "free";
  }
  userCache.set(userId, { tier, ts: Date.now() });
  return tier;
}

export function invalidateUserCache(userId: string) {
  userCache.delete(userId);
}

async function extractUserId(req: Request | undefined): Promise<string | null> {
  if (!req) {
    console.error("[clerk] extractUserId called with undefined req");
    return null;
  }
  // Test-only auth bypass
  if (
    Deno.env.get("CLERK_TEST_BYPASS") === "1" &&
    Deno.env.get("NODE_ENV") !== "production"
  ) {
    const testId = req.headers.get("x-test-user-id");
    if (testId && testId.length > 0) return testId;
  }

  const auth = req.headers.get("authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  if (!secretKey) return null;
  try {
    const payload = await verifyToken(token, { secretKey });
    if (typeof payload.sub === "string" && payload.sub) return payload.sub;
    return null;
  } catch {
    return null;
  }
}

export async function optionalClerkAuth(c: Context, next: Next) {
  console.log("[clerk] optionalClerkAuth start");
  const userId = await extractUserId(c.req.raw);
  console.log("[clerk] optionalClerkAuth: userId =", userId || "(none)");
  if (userId) {
    const tier = await ensureUserRow(userId);
    c.set("auth", { userId, tier } as AuthState);
  }
  await next();
}

export async function requireClerkAuth(c: Context, next: Next) {
  const userId = await extractUserId(c.req.raw);
  if (!userId) {
    return c.json({ success: false, error: "unauthenticated" }, 401);
  }
  const tier = await ensureUserRow(userId);
  c.set("auth", { userId, tier } as AuthState);
  await next();
}

export function getAuth(c: Context): AuthState | undefined {
  return c.get("auth") as AuthState | undefined;
}

export function getUserId(c: Context): string {
  const auth = getAuth(c);
  return auth?.userId ?? "guest";
}

export function getTier(c: Context): "free" | "pro" {
  const auth = getAuth(c);
  return auth?.tier ?? "free";
}
