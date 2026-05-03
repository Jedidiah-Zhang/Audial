import type { RequestHandler, Request } from "express";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const secretKey = process.env.CLERK_SECRET_KEY;
const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;

const clerkClient = secretKey
  ? createClerkClient({ secretKey, publishableKey })
  : null;

export interface AuthState {
  userId: string;
  tier: "free" | "pro";
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthState;
    }
  }
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

async function extractUserId(req: Request): Promise<string | null> {
  // Test-only auth shortcut. Strictly opt-in via env var AND requires
  // NODE_ENV !== "production" so a misconfigured prod deploy can never
  // honor an unsigned `x-test-user-id` header even if the bypass var
  // were ever set there. Used by the sync-route integration tests
  // (test/sync/sync.test.ts) so they don't have to mint real Clerk JWTs.
  if (
    process.env.CLERK_TEST_BYPASS === "1" &&
    process.env.NODE_ENV !== "production" &&
    typeof req.headers["x-test-user-id"] === "string" &&
    req.headers["x-test-user-id"].length > 0
  ) {
    return req.headers["x-test-user-id"] as string;
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  if (!secretKey) {
    req.log?.warn("CLERK_SECRET_KEY not set; rejecting bearer token");
    return null;
  }
  try {
    const payload = await verifyToken(token, { secretKey });
    if (typeof payload.sub === "string" && payload.sub) return payload.sub;
    return null;
  } catch (err) {
    req.log?.warn({ err }, "Clerk JWT verification failed");
    return null;
  }
}

/**
 * Optional auth: if a valid Clerk bearer token is present, attach
 * `req.auth = { userId, tier }`. Otherwise leave `req.auth` undefined.
 * Use this for endpoints that should also serve unauthenticated guests
 * (e.g. anonymous quota tracking by IP/cookie isn't needed — guests just
 * use their local mirror).
 */
export const optionalClerkAuth: RequestHandler = (req, _res, next) => {
  void (async () => {
    const userId = await extractUserId(req);
    if (userId) {
      const tier = await ensureUserRow(userId);
      req.auth = { userId, tier };
    }
    next();
  })().catch(next);
};

/**
 * Required auth: 401 if no/invalid Clerk bearer token. Use on /sync/* routes
 * which are meaningless without a logged-in user.
 */
export const requireClerkAuth: RequestHandler = (req, res, next) => {
  void (async () => {
    const userId = await extractUserId(req);
    if (!userId) {
      res.status(401).json({ success: false, error: "unauthenticated" });
      return;
    }
    const tier = await ensureUserRow(userId);
    req.auth = { userId, tier };
    next();
  })().catch(next);
};

export { clerkClient };
