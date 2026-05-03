import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  textsTable,
  resultsTable,
  progressTable,
  generationQuotaTable,
} from "@workspace/db";
import { requireClerkAuth, invalidateUserCache } from "../middlewares/clerkAuth";
import { PushSyncBody, SetSubscriptionBody } from "@workspace/api-zod";

const router: IRouter = Router();

const FREE_DAILY_GENERATION_LIMIT = 3;

function todayKey(): string {
  const shifted = new Date(Date.now() + 4 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

router.use(requireClerkAuth);

router.get("/sync/snapshot", async (req, res) => {
  const userId = req.auth!.userId;
  const tier = req.auth!.tier;
  const today = todayKey();

  const [userRow, texts, results, progress, quotaRows] = await Promise.all([
    db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1),
    db.select().from(textsTable).where(eq(textsTable.userId, userId)),
    db.select().from(resultsTable).where(eq(resultsTable.userId, userId)),
    db.select().from(progressTable).where(eq(progressTable.userId, userId)),
    db
      .select()
      .from(generationQuotaTable)
      .where(eq(generationQuotaTable.userId, userId)),
  ]);

  const u = userRow[0];
  const subscription = {
    tier: (u?.tier === "pro" ? "pro" : "free") as "free" | "pro",
    upgradedAt: u?.upgradedAt ? u.upgradedAt.getTime() : null,
  };

  const todayQuota = quotaRows.find((q) => q.date === today);
  const used = todayQuota?.count ?? 0;
  const quota = {
    date: today,
    count: used,
    limit: tier === "pro" ? null : FREE_DAILY_GENERATION_LIMIT,
    remaining:
      tier === "pro" ? null : Math.max(0, FREE_DAILY_GENERATION_LIMIT - used),
    tier,
  };

  res.json({
    texts: texts.map((t) => ({
      id: t.id,
      title: t.title,
      text: t.text,
      translation: t.translation,
      vocabulary: (t.vocabulary as unknown[]) ?? [],
      topic: t.topic,
      difficulty: t.difficulty,
      targetLanguage: t.targetLanguage,
      nativeLanguage: t.nativeLanguage,
      contentType: t.contentType ?? null,
      createdAt: t.clientCreatedAt,
    })),
    results: results.map((r) => ({
      id: r.id,
      textId: r.textId,
      mode: r.mode,
      stage: r.stage,
      score: r.score,
      feedback: r.feedback,
      details: (r.details as Record<string, unknown> | null) ?? null,
      createdAt: r.clientCreatedAt,
    })),
    progress: progress.map((p) => ({
      textId: p.textId,
      stageBests: (p.stageBests as number[]) ?? [],
      stagePassed: (p.stagePassed as boolean[]) ?? [],
      lastStudied: p.lastStudied,
      totalSessions: p.totalSessions,
      shadowingBest: p.shadowingBest,
      dictationBest: p.dictationBest,
      recitationBest: p.recitationBest,
    })),
    subscription,
    quota,
  });
});

router.post("/sync/push", async (req, res) => {
  const userId = req.auth!.userId;
  const parsed = PushSyncBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_request",
      issues: parsed.error.issues,
    });
    return;
  }
  const body = parsed.data;
  const texts = body.texts ?? [];
  const deletedTextIds = (body.deletedTextIds ?? []).filter(
    (s) => s.length > 0,
  );
  const results = body.results ?? [];
  const progress = body.progress ?? [];

  let acceptedTexts = 0;
  let acceptedResults = 0;
  let acceptedProgress = 0;
  let deletedTexts = 0;

  if (texts.length > 0) {
    const rows = texts.map((t) => ({
      id: t.id,
      userId,
      title: t.title,
      text: t.text,
      translation: t.translation,
      vocabulary: t.vocabulary,
      topic: t.topic,
      difficulty: t.difficulty,
      targetLanguage: t.targetLanguage,
      nativeLanguage: t.nativeLanguage,
      contentType: t.contentType ?? null,
      clientCreatedAt: Math.floor(t.createdAt),
    }));
    if (rows.length > 0) {
      await db
        .insert(textsTable)
        .values(rows)
        .onConflictDoUpdate({
          target: [textsTable.userId, textsTable.id],
          set: {
            title: sql`excluded.title`,
            text: sql`excluded.text`,
            translation: sql`excluded.translation`,
            vocabulary: sql`excluded.vocabulary`,
            topic: sql`excluded.topic`,
            difficulty: sql`excluded.difficulty`,
            targetLanguage: sql`excluded.target_language`,
            nativeLanguage: sql`excluded.native_language`,
            contentType: sql`excluded.content_type`,
            clientCreatedAt: sql`excluded.client_created_at`,
            updatedAt: sql`now()`,
          },
        });
      acceptedTexts = rows.length;
    }
  }

  if (deletedTextIds.length > 0) {
    // Delete the text plus everything that references it (results +
    // progress). Without this, results rows would orphan and reappear
    // on the next snapshot pull, "resurrecting" data the user deleted.
    for (const id of deletedTextIds) {
      await db
        .delete(resultsTable)
        .where(
          sql`${resultsTable.userId} = ${userId} AND ${resultsTable.textId} = ${id}`,
        );
      await db
        .delete(progressTable)
        .where(
          sql`${progressTable.userId} = ${userId} AND ${progressTable.textId} = ${id}`,
        );
      await db
        .delete(textsTable)
        .where(
          sql`${textsTable.userId} = ${userId} AND ${textsTable.id} = ${id}`,
        );
    }
    deletedTexts = deletedTextIds.length;
  }

  if (results.length > 0) {
    const rows = results.map((r) => ({
      id: r.id,
      userId,
      textId: r.textId,
      mode: r.mode,
      stage: Math.floor(r.stage),
      score: Math.floor(r.score),
      feedback: r.feedback,
      details: r.details ?? null,
      clientCreatedAt: Math.floor(r.createdAt),
    }));
    if (rows.length > 0) {
      await db
        .insert(resultsTable)
        .values(rows)
        .onConflictDoUpdate({
          target: [resultsTable.userId, resultsTable.id],
          set: {
            textId: sql`excluded.text_id`,
            mode: sql`excluded.mode`,
            stage: sql`excluded.stage`,
            score: sql`excluded.score`,
            feedback: sql`excluded.feedback`,
            details: sql`excluded.details`,
            clientCreatedAt: sql`excluded.client_created_at`,
            updatedAt: sql`now()`,
          },
        });
      acceptedResults = rows.length;
    }
  }

  if (progress.length > 0) {
    const rows = progress.map((p) => ({
      userId,
      textId: p.textId,
      stageBests: p.stageBests,
      stagePassed: p.stagePassed,
      lastStudied: Math.floor(p.lastStudied),
      totalSessions: Math.floor(p.totalSessions),
      shadowingBest: Math.floor(p.shadowingBest),
      dictationBest: Math.floor(p.dictationBest),
      recitationBest: Math.floor(p.recitationBest),
    }));
    if (rows.length > 0) {
      await db
        .insert(progressTable)
        .values(rows)
        .onConflictDoUpdate({
          target: [progressTable.userId, progressTable.textId],
          set: {
            stageBests: sql`excluded.stage_bests`,
            stagePassed: sql`excluded.stage_passed`,
            lastStudied: sql`excluded.last_studied`,
            totalSessions: sql`excluded.total_sessions`,
            shadowingBest: sql`excluded.shadowing_best`,
            dictationBest: sql`excluded.dictation_best`,
            recitationBest: sql`excluded.recitation_best`,
            updatedAt: sql`now()`,
          },
        });
      acceptedProgress = rows.length;
    }
  }

  res.json({
    success: true,
    accepted: {
      texts: acceptedTexts,
      results: acceptedResults,
      progress: acceptedProgress,
      deletedTexts,
    },
  });
});

router.post("/sync/subscription", async (req, res) => {
  const userId = req.auth!.userId;
  const parsed = SetSubscriptionBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_request",
      issues: parsed.error.issues,
    });
    return;
  }
  const tier: "free" | "pro" = parsed.data.tier;
  const upgradedAt = tier === "pro" ? new Date() : null;
  await db
    .insert(usersTable)
    .values({ id: userId, tier, upgradedAt })
    .onConflictDoUpdate({
      target: usersTable.id,
      set: {
        tier,
        // Preserve the original upgrade timestamp on repeat upgrades
        upgradedAt:
          tier === "pro"
            ? sql`COALESCE(${usersTable.upgradedAt}, ${upgradedAt})`
            : sql`NULL`,
        updatedAt: sql`now()`,
      },
    });
  invalidateUserCache(userId);
  const rows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const u = rows[0];
  res.json({
    tier: (u?.tier === "pro" ? "pro" : "free") as "free" | "pro",
    upgradedAt: u?.upgradedAt ? u.upgradedAt.getTime() : null,
  });
});

export default router;
