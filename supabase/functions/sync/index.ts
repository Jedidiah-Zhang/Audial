import { Hono } from "npm:hono";
import { db, usersTable, textsTable, resultsTable, progressTable } from "../_shared/db.ts";
import { requireClerkAuth, getUserId, invalidateUserCache } from "../_shared/clerk.ts";
import { eq, and, sql } from "npm:drizzle-orm";

const app = new Hono();
app.use("*", requireClerkAuth);

// ===================================================================
// GET /api/sync/snapshot — full user data snapshot
// ===================================================================

app.get("/snapshot", async (c) => {
  const userId = getUserId(c);

  const [texts, results, progress, userRows, quotaRows] = await Promise.all([
    db.select().from(textsTable).where(eq(textsTable.userId, userId)),
    db.select().from(resultsTable).where(eq(resultsTable.userId, userId)),
    db.select().from(progressTable).where(eq(progressTable.userId, userId)),
    db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1),
    db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1), // quota read separately below
  ]);

  const userRow = userRows[0];

  const mappedTexts = texts.map((t) => ({
    ...t,
    createdAt: t.clientCreatedAt,
  }));

  const mappedResults = results.map((r) => ({
    ...r,
    createdAt: r.clientCreatedAt,
  }));

  return c.json({
    texts: mappedTexts,
    results: mappedResults,
    progress,
    subscription: {
      tier: userRow?.tier ?? "free",
      upgradedAt: userRow?.upgradedAt?.getTime(),
    },
    quota: { date: "", count: 0, limit: 3, remaining: 3, tier: userRow?.tier ?? "free" },
    settings: { nativeLanguage: userRow?.nativeLanguage ?? null },
  });
});

// ===================================================================
// POST /api/sync/settings — update user settings
// ===================================================================

app.post("/settings", async (c) => {
  const userId = getUserId(c);
  const { nativeLanguage } = await c.req.json();

  await db
    .insert(usersTable)
    .values({ id: userId, nativeLanguage })
    .onConflictDoUpdate({ target: usersTable.id, set: { nativeLanguage } });

  return c.json({ nativeLanguage });
});

// ===================================================================
// POST /api/sync/push — batch push texts/results/progress
// ===================================================================

app.post("/push", async (c) => {
  const userId = getUserId(c);
  const body = await c.req.json();
  const texts = body.texts || [];
  const results = body.results || [];
  const progressList = body.progress || [];
  const deletedTextIds = body.deletedTextIds || [];

  // Cascade delete: delete results + progress for each text, then the text itself
  if (deletedTextIds.length > 0) {
    await db.transaction(async (tx) => {
      for (const textId of deletedTextIds) {
        await tx
          .delete(resultsTable)
          .where(and(eq(resultsTable.userId, userId), eq(resultsTable.textId, textId)));
        await tx
          .delete(progressTable)
          .where(and(eq(progressTable.userId, userId), eq(progressTable.textId, textId)));
        await tx
          .delete(textsTable)
          .where(and(eq(textsTable.userId, userId), eq(textsTable.id, textId)));
      }
    });
  }

  // Upsert texts
  let acceptedTexts = 0;
  for (const text of texts) {
    await db
      .insert(textsTable)
      .values({ ...text, userId })
      .onConflictDoUpdate({
        target: [textsTable.userId, textsTable.id],
        set: {
          title: text.title,
          text: text.text,
          translation: text.translation,
          vocabulary: text.vocabulary,
          topic: text.topic,
          difficulty: text.difficulty,
          targetLanguage: text.targetLanguage,
          nativeLanguage: text.nativeLanguage,
          contentType: text.contentType,
          clientCreatedAt: text.clientCreatedAt,
        },
      });
    acceptedTexts++;
  }

  // Upsert results
  let acceptedResults = 0;
  for (const result of results) {
    await db
      .insert(resultsTable)
      .values({ ...result, userId })
      .onConflictDoUpdate({
        target: [resultsTable.userId, resultsTable.id],
        set: {
          textId: result.textId,
          mode: result.mode,
          stage: result.stage,
          score: result.score,
          feedback: result.feedback,
          details: result.details,
          clientCreatedAt: result.clientCreatedAt,
        },
      });
    acceptedResults++;
  }

  // Upsert progress
  let acceptedProgress = 0;
  for (const progress of progressList) {
    await db
      .insert(progressTable)
      .values({ ...progress, userId })
      .onConflictDoUpdate({
        target: [progressTable.userId, progressTable.textId],
        set: {
          stageBests: progress.stageBests,
          stagePassed: progress.stagePassed,
          lastStudied: progress.lastStudied,
          totalSessions: progress.totalSessions,
          shadowingBest: progress.shadowingBest,
          dictationBest: progress.dictationBest,
          recitationBest: progress.recitationBest,
        },
      });
    acceptedProgress++;
  }

  return c.json({
    success: true,
    accepted: {
      texts: acceptedTexts,
      results: acceptedResults,
      progress: acceptedProgress,
      deletedTexts: deletedTextIds.length,
    },
  });
});

// ===================================================================
// POST /api/sync/subscription — update user tier
// ===================================================================

app.post("/subscription", async (c) => {
  const userId = getUserId(c);
  const { tier } = await c.req.json();

  if (tier === "pro") {
    await db
      .insert(usersTable)
      .values({ id: userId, tier: "pro", upgradedAt: new Date() })
      .onConflictDoUpdate({
        target: usersTable.id,
        set: {
          tier: "pro",
          upgradedAt: sql`COALESCE(${usersTable}.upgraded_at, ${new Date().toISOString()})`,
        },
      });
  } else {
    await db
      .insert(usersTable)
      .values({ id: userId, tier: "free", upgradedAt: null })
      .onConflictDoUpdate({
        target: usersTable.id,
        set: { tier: "free", upgradedAt: null },
      });
  }

  invalidateUserCache(userId);

  // Read back to confirm
  const rows = await db
    .select({ tier: usersTable.tier, upgradedAt: usersTable.upgradedAt })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  const row = rows[0];
  return c.json({
    tier: row?.tier ?? "free",
    upgradedAt: row?.upgradedAt?.getTime() ?? null,
  });
});

export default app;
