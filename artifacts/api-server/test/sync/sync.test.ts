import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

// =====================================================================
// Integration tests for /api/sync/* routes.
//
// We exercise the real Express app (real Drizzle/PG, real router stack)
// but bypass Clerk JWT verification with a strictly opt-in test header.
// The header is only honored when CLERK_TEST_BYPASS=1, which we set
// here before importing the app so the middleware module sees it.
// =====================================================================

process.env.CLERK_TEST_BYPASS = "1";
// extractUserId() bails out early when CLERK_SECRET_KEY is missing AND
// a bearer token is provided. Our test bypass short-circuits ahead of
// that branch, so this isn't strictly required — set a placeholder
// anyway so the module does not log noisy warnings.
process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "test-only";

const { default: app } = await import("../../src/app.js");
const { db, usersTable, textsTable, resultsTable, progressTable } =
  await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { invalidateUserCache } = await import(
  "../../src/middlewares/clerkAuth.js"
);

let server: Server;
let baseUrl: string;

before(async () => {
  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Each test gets its own synthetic Clerk userId so they don't collide
// when run in parallel and so cleanup is trivial.
let userId: string;
beforeEach(async () => {
  userId = `test_${randomUUID()}`;
});

async function cleanupUser(id: string) {
  invalidateUserCache(id);
  await db.delete(progressTable).where(eq(progressTable.userId, id));
  await db.delete(resultsTable).where(eq(resultsTable.userId, id));
  await db.delete(textsTable).where(eq(textsTable.userId, id));
  await db.delete(usersTable).where(eq(usersTable.id, id));
}

interface FetchOpts {
  method?: string;
  body?: unknown;
  authUserId?: string | null;
}

async function call(path: string, opts: FetchOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.authUserId !== null) {
    headers["x-test-user-id"] = opts.authUserId ?? userId;
  }
  return fetch(`${baseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

// =====================================================================
// Auth
// =====================================================================

test("sync routes return 401 when no auth is provided", async () => {
  for (const path of [
    "/api/sync/snapshot",
    "/api/sync/push",
    "/api/sync/subscription",
  ]) {
    const method = path === "/api/sync/snapshot" ? "GET" : "POST";
    const res = await call(path, {
      method,
      body: method === "POST" ? {} : undefined,
      authUserId: null,
    });
    assert.equal(
      res.status,
      401,
      `${method} ${path} should require auth (got ${res.status})`,
    );
  }
});

// =====================================================================
// GET /api/sync/snapshot
// =====================================================================

test("GET /api/sync/snapshot returns an empty snapshot for a brand-new user", async () => {
  try {
    const res = await call("/api/sync/snapshot");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      texts: unknown[];
      results: unknown[];
      progress: unknown[];
      subscription: { tier: string; upgradedAt: number | null };
      quota: { tier: string; remaining: number | null };
    };
    assert.deepEqual(body.texts, []);
    assert.deepEqual(body.results, []);
    assert.deepEqual(body.progress, []);
    assert.equal(body.subscription.tier, "free");
    assert.equal(body.quota.tier, "free");
    assert.equal(typeof body.quota.remaining, "number");
  } finally {
    await cleanupUser(userId);
  }
});

// =====================================================================
// POST /api/sync/push — upsert + delete semantics
// =====================================================================

test("POST /api/sync/push upserts texts/results/progress and snapshot reflects them", async () => {
  try {
    const pushRes = await call("/api/sync/push", {
      method: "POST",
      body: {
        texts: [
          {
            id: "txt_1",
            title: "Hello",
            text: "Hello world",
            translation: "",
            vocabulary: [],
            topic: "general",
            difficulty: "intermediate",
            targetLanguage: "en-US",
            nativeLanguage: "en-US",
            contentType: "general",
            createdAt: 1_700_000_000,
          },
        ],
        results: [
          {
            id: "res_1",
            textId: "txt_1",
            mode: "shadowing",
            stage: 0,
            score: 80,
            feedback: "",
            details: null,
            createdAt: 1_700_000_001,
          },
        ],
        progress: [
          {
            textId: "txt_1",
            stageBests: [80, 0, 0],
            stagePassed: [true, false, false],
            lastStudied: 1_700_000_002,
            totalSessions: 1,
            shadowingBest: 80,
            dictationBest: 0,
            recitationBest: 0,
          },
        ],
        deletedTextIds: [],
      },
    });
    assert.equal(pushRes.status, 200);
    const pushBody = (await pushRes.json()) as {
      success: boolean;
      accepted: { texts: number; results: number; progress: number };
    };
    assert.equal(pushBody.success, true);
    assert.equal(pushBody.accepted.texts, 1);
    assert.equal(pushBody.accepted.results, 1);
    assert.equal(pushBody.accepted.progress, 1);

    // Re-pushing the same id MUST update, not duplicate.
    const updateRes = await call("/api/sync/push", {
      method: "POST",
      body: {
        texts: [
          {
            id: "txt_1",
            title: "Hello (edited)",
            text: "Hello world v2",
            translation: "",
            vocabulary: [],
            topic: "general",
            difficulty: "intermediate",
            targetLanguage: "en-US",
            nativeLanguage: "en-US",
            contentType: "general",
            createdAt: 1_700_000_000,
          },
        ],
      },
    });
    assert.equal(updateRes.status, 200);

    const snap = await call("/api/sync/snapshot");
    const snapBody = (await snap.json()) as {
      texts: { id: string; title: string }[];
      results: { id: string }[];
      progress: { textId: string; shadowingBest: number }[];
    };
    assert.equal(snapBody.texts.length, 1);
    assert.equal(snapBody.texts[0].title, "Hello (edited)");
    assert.equal(snapBody.results.length, 1);
    assert.equal(snapBody.results[0].id, "res_1");
    assert.equal(snapBody.progress.length, 1);
    assert.equal(snapBody.progress[0].shadowingBest, 80);
  } finally {
    await cleanupUser(userId);
  }
});

test("POST /api/sync/push with deletedTextIds removes text + cascades results & progress", async () => {
  try {
    // Seed: one text with one result and one progress row.
    const seedRes = await call("/api/sync/push", {
      method: "POST",
      body: {
        texts: [
          {
            id: "txt_del",
            title: "Doomed",
            text: "x",
            translation: "",
            vocabulary: [],
            topic: "",
            difficulty: "intermediate",
            targetLanguage: "en-US",
            nativeLanguage: "en-US",
            createdAt: 1,
          },
        ],
        results: [
          {
            id: "res_del",
            textId: "txt_del",
            mode: "shadowing",
            stage: 0,
            score: 50,
            feedback: "",
            details: null,
            createdAt: 1,
          },
        ],
        progress: [
          {
            textId: "txt_del",
            stageBests: [50],
            stagePassed: [false],
            lastStudied: 1,
            totalSessions: 1,
            shadowingBest: 50,
            dictationBest: 0,
            recitationBest: 0,
          },
        ],
      },
    });
    // Without this, a silently-failing seed would let the delete test
    // "pass" against an already-empty snapshot — a textbook false positive.
    assert.equal(seedRes.status, 200, "seed push must succeed");
    const seedBody = (await seedRes.json()) as {
      accepted: { texts: number; results: number; progress: number };
    };
    assert.equal(seedBody.accepted.texts, 1);
    assert.equal(seedBody.accepted.results, 1);
    assert.equal(seedBody.accepted.progress, 1);

    const delRes = await call("/api/sync/push", {
      method: "POST",
      body: { deletedTextIds: ["txt_del"] },
    });
    assert.equal(delRes.status, 200);
    const delBody = (await delRes.json()) as {
      accepted: { deletedTexts: number };
    };
    assert.equal(delBody.accepted.deletedTexts, 1);

    const snap = await call("/api/sync/snapshot");
    const snapBody = (await snap.json()) as {
      texts: unknown[];
      results: unknown[];
      progress: unknown[];
    };
    // Without the cascade, results / progress would resurrect the
    // deleted text on the next snapshot pull. Verify all three are gone.
    assert.equal(snapBody.texts.length, 0);
    assert.equal(snapBody.results.length, 0);
    assert.equal(snapBody.progress.length, 0);
  } finally {
    await cleanupUser(userId);
  }
});

test("POST /api/sync/push returns 400 on a malformed body", async () => {
  try {
    const res = await call("/api/sync/push", {
      method: "POST",
      body: {
        texts: [{ id: "bad" /* missing required fields */ }],
      },
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_request");
  } finally {
    await cleanupUser(userId);
  }
});

// =====================================================================
// POST /api/sync/subscription — tier persistence
// =====================================================================

test("POST /api/sync/subscription persists pro tier and snapshot reflects it", async () => {
  try {
    const upgradeRes = await call("/api/sync/subscription", {
      method: "POST",
      body: { tier: "pro" },
    });
    assert.equal(upgradeRes.status, 200);
    const upgradeBody = (await upgradeRes.json()) as {
      tier: string;
      upgradedAt: number | null;
    };
    assert.equal(upgradeBody.tier, "pro");
    assert.equal(typeof upgradeBody.upgradedAt, "number");

    // The snapshot must reflect the new tier (and pro users have an
    // unlimited generation quota).
    const snap = await call("/api/sync/snapshot");
    const snapBody = (await snap.json()) as {
      subscription: { tier: string; upgradedAt: number | null };
      quota: { tier: string; limit: number | null };
    };
    assert.equal(snapBody.subscription.tier, "pro");
    assert.equal(typeof snapBody.subscription.upgradedAt, "number");
    assert.equal(snapBody.quota.tier, "pro");
    assert.equal(snapBody.quota.limit, null);
  } finally {
    await cleanupUser(userId);
  }
});

test("POST /api/sync/subscription preserves the original upgradedAt across repeat upgrades", async () => {
  try {
    const first = await call("/api/sync/subscription", {
      method: "POST",
      body: { tier: "pro" },
    });
    const firstBody = (await first.json()) as { upgradedAt: number };
    assert.equal(typeof firstBody.upgradedAt, "number");

    // Wait a beat so a naive overwrite would be detectable in ms.
    await new Promise((r) => setTimeout(r, 25));

    const second = await call("/api/sync/subscription", {
      method: "POST",
      body: { tier: "pro" },
    });
    const secondBody = (await second.json()) as { upgradedAt: number };
    assert.equal(
      secondBody.upgradedAt,
      firstBody.upgradedAt,
      "repeat pro upgrades must keep the earliest upgradedAt timestamp",
    );
  } finally {
    await cleanupUser(userId);
  }
});

test("POST /api/sync/subscription with tier=free clears upgradedAt", async () => {
  try {
    await call("/api/sync/subscription", {
      method: "POST",
      body: { tier: "pro" },
    });
    const downgrade = await call("/api/sync/subscription", {
      method: "POST",
      body: { tier: "free" },
    });
    assert.equal(downgrade.status, 200);
    const body = (await downgrade.json()) as {
      tier: string;
      upgradedAt: number | null;
    };
    assert.equal(body.tier, "free");
    assert.equal(body.upgradedAt, null);
  } finally {
    await cleanupUser(userId);
  }
});

test("POST /api/sync/subscription returns 400 for an unknown tier", async () => {
  try {
    const res = await call("/api/sync/subscription", {
      method: "POST",
      body: { tier: "platinum" },
    });
    assert.equal(res.status, 400);
  } finally {
    await cleanupUser(userId);
  }
});

// =====================================================================
// Cross-user isolation
// =====================================================================

test("data pushed by user A is invisible to user B", async () => {
  const userA = `test_${randomUUID()}`;
  const userB = `test_${randomUUID()}`;
  try {
    const pushA = await call("/api/sync/push", {
      method: "POST",
      authUserId: userA,
      body: {
        texts: [
          {
            id: "iso_1",
            title: "A's text",
            text: "x",
            translation: "",
            vocabulary: [],
            topic: "",
            difficulty: "intermediate",
            targetLanguage: "en-US",
            nativeLanguage: "en-US",
            createdAt: 1,
          },
        ],
      },
    });
    assert.equal(pushA.status, 200, "user A seed push must succeed");

    // Sanity check: A can read its own row (otherwise B-empty proves
    // nothing about isolation).
    const snapA = await call("/api/sync/snapshot", { authUserId: userA });
    const snapABody = (await snapA.json()) as { texts: { id: string }[] };
    assert.equal(snapABody.texts.length, 1);
    assert.equal(snapABody.texts[0].id, "iso_1");

    const snapB = await call("/api/sync/snapshot", { authUserId: userB });
    const snapBBody = (await snapB.json()) as { texts: unknown[] };
    assert.equal(snapBBody.texts.length, 0);
  } finally {
    await cleanupUser(userA);
    await cleanupUser(userB);
  }
});

// =====================================================================
// Upsert semantics for results & progress
// =====================================================================

test("POST /api/sync/push updates an existing result row (no duplicate) when re-pushed with the same id", async () => {
  try {
    const seed = await call("/api/sync/push", {
      method: "POST",
      body: {
        texts: [
          {
            id: "upsert_t",
            title: "T",
            text: "x",
            translation: "",
            vocabulary: [],
            topic: "",
            difficulty: "intermediate",
            targetLanguage: "en-US",
            nativeLanguage: "en-US",
            createdAt: 1,
          },
        ],
        results: [
          {
            id: "upsert_r",
            textId: "upsert_t",
            mode: "shadowing",
            stage: 0,
            score: 50,
            feedback: "first",
            details: null,
            createdAt: 1,
          },
        ],
      },
    });
    assert.equal(seed.status, 200);

    const update = await call("/api/sync/push", {
      method: "POST",
      body: {
        results: [
          {
            id: "upsert_r",
            textId: "upsert_t",
            mode: "dictation",
            stage: 1,
            score: 95,
            feedback: "improved",
            details: null,
            createdAt: 2,
          },
        ],
      },
    });
    assert.equal(update.status, 200);

    const snap = await call("/api/sync/snapshot");
    const body = (await snap.json()) as {
      results: {
        id: string;
        score: number;
        feedback: string;
        mode: string;
        stage: number;
      }[];
    };
    assert.equal(body.results.length, 1, "result must be updated, not duplicated");
    assert.equal(body.results[0].score, 95);
    assert.equal(body.results[0].feedback, "improved");
    assert.equal(body.results[0].mode, "dictation");
    assert.equal(body.results[0].stage, 1);
  } finally {
    await cleanupUser(userId);
  }
});

test("POST /api/sync/push updates an existing progress row when re-pushed for the same textId", async () => {
  try {
    const seed = await call("/api/sync/push", {
      method: "POST",
      body: {
        progress: [
          {
            textId: "prog_t",
            stageBests: [10, 0, 0],
            stagePassed: [false, false, false],
            lastStudied: 100,
            totalSessions: 1,
            shadowingBest: 10,
            dictationBest: 0,
            recitationBest: 0,
          },
        ],
      },
    });
    assert.equal(seed.status, 200);

    const update = await call("/api/sync/push", {
      method: "POST",
      body: {
        progress: [
          {
            textId: "prog_t",
            stageBests: [80, 70, 60],
            stagePassed: [true, true, false],
            lastStudied: 200,
            totalSessions: 5,
            shadowingBest: 80,
            dictationBest: 70,
            recitationBest: 60,
          },
        ],
      },
    });
    assert.equal(update.status, 200);

    const snap = await call("/api/sync/snapshot");
    const body = (await snap.json()) as {
      progress: {
        textId: string;
        totalSessions: number;
        shadowingBest: number;
        dictationBest: number;
        recitationBest: number;
        lastStudied: number;
      }[];
    };
    assert.equal(
      body.progress.length,
      1,
      "progress row must be updated in place (PK is userId+textId)",
    );
    const p = body.progress[0];
    assert.equal(p.totalSessions, 5);
    assert.equal(p.shadowingBest, 80);
    assert.equal(p.dictationBest, 70);
    assert.equal(p.recitationBest, 60);
    assert.equal(p.lastStudied, 200);
  } finally {
    await cleanupUser(userId);
  }
});
