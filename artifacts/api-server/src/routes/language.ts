import { Router, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { db, generationQuotaTable } from "@workspace/db";
import {
  deepseek,
  DEEPSEEK_MODEL,
  isDeepseekConfigured,
} from "@workspace/integrations-openai-ai-server/deepseek";
import {
  textToSpeech,
  speechToText,
  speechToTextDetailed,
  ensureCompatibleFormat,
  isOpenaiConfigured,
  OpenAINotConfiguredError,
} from "@workspace/integrations-openai-ai-server/audio";
import {
  computeSttMetrics,
  computeProsodyMetrics,
  scoreFromSignals,
  SCORE_WEIGHTS,
} from "../lib/pronunciation";
import { optionalClerkAuth } from "../middlewares/clerkAuth";

const router = Router();

router.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

// Optional Clerk auth on every language route. Authed users get their
// identity (and tier) from the verified JWT; guests fall through with
// no `req.auth` and use a synthetic per-IP id for in-memory quota.
router.use(optionalClerkAuth);

// =====================================================================
// Free-tier generation quota + rewarded-ad token store (in-memory).
//
// Audial's free tier gets 3 article generations per UTC day. After that
// they can either watch a rewarded video (granting one bypass token) or
// upgrade to Pro. Pro users bypass the quota entirely. Tokens are
// one-shot, expire after 30 minutes, and are never persisted — a server
// restart clears both counters and outstanding tokens, which is fine
// for a soft monetization gate (and the only "punishment" is regaining
// the free quota).
// =====================================================================

const FREE_DAILY_GENERATION_LIMIT = 3;
const REWARD_TOKEN_TTL_MS = 30 * 60 * 1000;

interface QuotaEntry {
  date: string; // YYYY-MM-DD — see todayKey() for which timezone.
  count: number;
}

const rewardTokens = new Map<string, { userId: string; expiresAt: number }>();

/**
 * Bucket date for the daily quota. Rolls over at 04:00 Asia/Shanghai
 * (UTC+8) so every user worldwide hits a daily reset at the exact same
 * wall-clock instant (China 4am = UTC 20:00 previous day = US-East 4pm
 * = US-West 1pm = London 8pm). This trades "midnight feels right
 * locally" for a single source of truth: the client mirror and the
 * server can never disagree about which day "today" is.
 *
 * 4am Shanghai is chosen because it's after most users have ended the
 * previous day's session and before the next day's morning users wake
 * up, minimizing mid-session rollovers anywhere on the globe.
 *
 * The client's `todayDateKey()` in AppContext.tsx must match this
 * exactly. Adding 4h to UTC shifts the China-4am rollover to UTC
 * midnight so we can just take the ISO date.
 */
function todayKey(): string {
  const shifted = new Date(Date.now() + 4 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

// Identity now comes from the verified Clerk JWT (see optionalClerkAuth
// middleware). For unauthenticated callers we fall back to a synthetic
// per-IP id; that bucket is shared across all guests on the same IP but
// we no longer trust the client to claim an arbitrary identity.
function readUserId(req: {
  auth?: { userId: string };
  ip?: string;
  headers: Record<string, unknown>;
}): string {
  if (req.auth?.userId) return req.auth.userId;
  const ip =
    typeof req.ip === "string" && req.ip
      ? req.ip
      : (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0] ||
        "anonymous";
  return `guest:${ip}`;
}

function readTier(req: { auth?: { tier: "free" | "pro" } }): "free" | "pro" {
  return req.auth?.tier === "pro" ? "pro" : "free";
}

async function getQuotaCount(userId: string, dateKey: string): Promise<number> {
  const rows = await db
    .select({ count: generationQuotaTable.count })
    .from(generationQuotaTable)
    .where(
      and(
        eq(generationQuotaTable.userId, userId),
        eq(generationQuotaTable.date, dateKey),
      ),
    )
    .limit(1);
  return rows[0]?.count ?? 0;
}

async function incrementQuota(
  userId: string,
  dateKey: string,
): Promise<number> {
  const rows = await db
    .insert(generationQuotaTable)
    .values({ userId, date: dateKey, count: 1 })
    .onConflictDoUpdate({
      target: [generationQuotaTable.userId, generationQuotaTable.date],
      set: {
        count: sql`${generationQuotaTable.count} + 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ count: generationQuotaTable.count });
  return rows[0]?.count ?? 1;
}

/**
 * Compensating decrement used to roll back an optimistic
 * `incrementQuota` when the gate ends up rejecting the request (e.g.
 * the increment pushed the user over the daily limit on a concurrent
 * burst). Clamped at 0 so we never underflow into negative quotas.
 */
async function decrementQuota(userId: string, dateKey: string): Promise<void> {
  await db
    .update(generationQuotaTable)
    .set({
      count: sql`GREATEST(${generationQuotaTable.count} - 1, 0)`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(generationQuotaTable.userId, userId),
        eq(generationQuotaTable.date, dateKey),
      ),
    );
}

function consumeRewardTokenIfValid(token: string, userId: string): boolean {
  const entry = rewardTokens.get(token);
  if (!entry) return false;
  rewardTokens.delete(token);
  if (entry.userId !== userId) return false;
  if (entry.expiresAt < Date.now()) return false;
  return true;
}

function pruneExpiredRewardTokens() {
  const now = Date.now();
  for (const [token, entry] of rewardTokens.entries()) {
    if (entry.expiresAt < now) rewardTokens.delete(token);
  }
}

const enforceGenerationQuota: RequestHandler = (req, res, next) => {
  void (async () => {
    const tier = readTier(req as never);
    if (tier === "pro") {
      next();
      return;
    }
    const body = (req.body ?? {}) as {
      regenerate?: unknown;
      previousText?: unknown;
    };
    // Regenerate is a free retry of an already-paid creation; same
    // semantics as before, just with the identity layer hardened (we
    // now trust req.auth from the verified Clerk JWT).
    if (
      body.regenerate === true &&
      typeof body.previousText === "string" &&
      body.previousText.length > 0
    ) {
      next();
      return;
    }
    const userId = readUserId(req as never);
    const rewardToken = req.headers["x-reward-token"];
    if (typeof rewardToken === "string" && rewardToken.trim()) {
      if (consumeRewardTokenIfValid(rewardToken.trim(), userId)) {
        next();
        return;
      }
    }
    const today = todayKey();
    // Atomic reserve-then-check: increment first and use the returned
    // count to decide. Two concurrent requests that both observe
    // `used == limit-1` would otherwise both pass the gate and let the
    // user exceed their quota. With this ordering the increment itself
    // is the contention point, and the loser gets rolled back below.
    const newCount = await incrementQuota(userId, today);
    if (newCount > FREE_DAILY_GENERATION_LIMIT) {
      await decrementQuota(userId, today);
      res.status(429).json({
        success: false,
        error: "quota_exceeded",
        message: `Free tier limited to ${FREE_DAILY_GENERATION_LIMIT} generations per day. Watch a rewarded ad for one more, or upgrade to Pro.`,
        data: {
          limit: FREE_DAILY_GENERATION_LIMIT,
          used: FREE_DAILY_GENERATION_LIMIT,
          remaining: 0,
          resetDate: today,
        },
      });
      return;
    }
    next();
  })().catch(next);
};

/**
 * Reject empty/whitespace-only manual input BEFORE the quota middleware
 * runs, so a malformed POST doesn't silently consume one of the user's
 * 3 daily slots before the route handler ever sees it. The React client
 * already gates on this, but a curl or replay can slip through.
 */
const validateManualPayload: RequestHandler = (req, res, next) => {
  const body = (req.body ?? {}) as { text?: unknown };
  if (typeof body.text !== "string" || !body.text.trim()) {
    res.status(400).json({ success: false, error: "Empty text" });
    return;
  }
  next();
};

router.get("/language/quota", (req, res) => {
  void (async () => {
    const tier = readTier(req as never);
    const userId = readUserId(req as never);
    const today = todayKey();
    if (tier === "pro") {
      res.json({
        success: true,
        data: {
          tier: "pro",
          limit: null,
          used: 0,
          remaining: null,
          resetDate: today,
        },
      });
      return;
    }
    const used = await getQuotaCount(userId, today);
    res.json({
      success: true,
      data: {
        tier: "free",
        limit: FREE_DAILY_GENERATION_LIMIT,
        used,
        remaining: Math.max(0, FREE_DAILY_GENERATION_LIMIT - used),
        resetDate: today,
      },
    });
  })().catch(() => {
    res.status(500).json({ success: false, error: "quota_lookup_failed" });
  });
});

router.post("/language/ad/grant-reward", (req, res) => {
  const tier = readTier(req as never);
  if (tier === "pro") {
    // Pro users don't need bypass tokens; signal that explicitly so the
    // client doesn't accidentally spend an unnecessary ad impression.
    res.status(400).json({
      success: false,
      error: "pro_user",
      message: "Pro users do not need rewarded-ad tokens.",
    });
    return;
  }
  const userId = readUserId(req as never);
  const placement =
    typeof req.body?.placement === "string" ? req.body.placement : "generation";
  if (placement !== "generation") {
    // Currently only the generation placement requires a server-side
    // bypass token (the other two — sentence detail unlock and dictation
    // listen-again — are purely client-enforced). Other placements just
    // get an OK response with no token.
    res.json({ success: true, data: { placement, token: null } });
    return;
  }
  pruneExpiredRewardTokens();
  const token = randomUUID();
  rewardTokens.set(token, {
    userId,
    expiresAt: Date.now() + REWARD_TOKEN_TTL_MS,
  });
  res.json({
    success: true,
    data: {
      placement,
      token,
      expiresInMs: REWARD_TOKEN_TTL_MS,
    },
  });
});

const requireDeepseek: RequestHandler = (_req, res, next) => {
  if (!isDeepseekConfigured()) {
    res.status(503).json({
      success: false,
      error:
        "DeepSeek 未配置：请设置 DEEPSEEK_API_KEY 环境变量后重启服务（DeepSeek is not configured: set DEEPSEEK_API_KEY and restart the server）",
    });
    return;
  }
  next();
};

const requireOpenai: RequestHandler = (_req, res, next) => {
  if (!isOpenaiConfigured()) {
    res.status(503).json({
      success: false,
      error:
        "OpenAI 未配置：请到 https://platform.openai.com 申请 API key，然后设置 OPENAI_API_KEY 环境变量后重启服务（OpenAI is not configured: set OPENAI_API_KEY and restart the server）",
    });
    return;
  }
  next();
};

router.post("/language/generate-text", requireDeepseek, enforceGenerationQuota, async (req, res) => {
  try {
    const { topic, difficulty, language, targetLanguage, contentType, regenerate, previousText, previousTitle } = req.body as {
      topic: string;
      difficulty: string;
      language: string;
      targetLanguage: string;
      contentType?: string;
      regenerate?: boolean;
      previousText?: string;
      previousTitle?: string;
    };

    const difficultyMap: Record<string, string> = {
      beginner: "A1-A2 level (very simple sentences, common everyday words, short paragraphs of 3-4 sentences)",
      elementary: "A2-B1 level (simple sentences, everyday topics, 4-6 sentences)",
      intermediate: "B1-B2 level (moderate complexity, varied vocabulary, 5-8 sentences)",
      advanced: "C1-C2 level (complex grammar, idiomatic expressions, 8-12 sentences)",
    };

    const levelDesc = difficultyMap[difficulty] || difficultyMap.intermediate;

    // When the target is one of the explicit English dialects, force the
    // model to use that dialect's spelling and vocabulary. Without this, the
    // model tends to default to American English regardless of the request.
    const dialectInstruction =
      targetLanguage === "British English"
        ? `\n\nIMPORTANT: Use British English spelling (colour, organise, centre, favourite, travelling, programme, practise as a verb) and British vocabulary (lift, lorry, biscuit, flat, holiday, autumn, mum) consistently throughout the text, title, vocabulary words, and example sentences. Do not mix in American English.`
        : targetLanguage === "American English"
        ? `\n\nIMPORTANT: Use American English spelling (color, organize, center, favorite, traveling, program, practice as both noun and verb) and American vocabulary (elevator, truck, cookie, apartment, vacation, fall, mom) consistently throughout the text, title, vocabulary words, and example sentences. Do not mix in British English.`
        : "";

    // On a regenerate request the client passes the previous draft and a
    // `regenerate: true` flag. We append an explicit "produce a different
    // version" instruction and quote the previous text so the model can
    // actually steer away from it. Without this the same prompt collapses
    // back to nearly identical output.
    const regenerateInstruction =
      regenerate && previousText
        ? `\n\nIMPORTANT — RETRY: The user already saw a previous draft on this exact topic and asked for a different one. Produce a NOTICEABLY DIFFERENT article: pick a different angle or sub-topic, open with a different first sentence, use different examples, and prefer different vocabulary picks. Keep the same topic, difficulty, target language and dialect. Do NOT paraphrase or lightly edit the previous draft — write a fresh version. Previous draft to AVOID REPEATING (do not reuse its opening sentence, structure, or vocabulary list verbatim):\n"""${previousTitle ? previousTitle + "\n\n" : ""}${previousText}"""`
        : "";

    const systemPrompt = `You are a language learning content creator. Generate authentic, natural-sounding ${targetLanguage} text that a native speaker would actually say or write. The text should be at ${levelDesc}. The topic is: ${topic}.${dialectInstruction}${regenerateInstruction}

Format your response as JSON with these fields:
- "text": the main text in ${targetLanguage}.${contentType === "dialogue" ? ` Format as dialogue with "SpeakerName: utterance" per line.` : contentType === "speech" ? ` Write in a spoken-address style (like a TED talk or speech).` : contentType === "story" ? ` Write in a narrative style with descriptive prose.` : ` Write in a natural, informative style.`}
- "translation": translation in ${language}
- "title": a short title for the text (in ${targetLanguage})
- "contentType": ${contentType ? `MUST be "${contentType}".` : `decide yourself. Think step by step:
    1. What is the topic "${topic}" — social interaction, narrative, opinion, or factual info?
    2. Pick: "dialogue" (conversation, chat, interview, role-play), "story" (narrative, anecdote, travelogue), "speech" (opinion, appeal, persuasive), or "info" (news, explainer, guide).
    3. Generate the text in that format.`}
- "vocabulary": array of 5-8 key vocabulary items, each with:
  - "word": the word in ${targetLanguage}
  - "pronunciation": IPA or romanization if applicable
  - "partOfSpeech": short tag like "n.", "v.", "adj.", "adv.", "phrase" (in English)
  - "meaning": the meaning in ${language}
  - "example": a NEW natural example sentence in ${targetLanguage} that uses this word (different from the main text)
  - "exampleTranslation": translation of the example sentence in ${language}

Make the text feel like something a real native speaker would say - not textbook language. Use natural expressions and colloquialisms appropriate for the level.`;

    // For regeneration, raise sampling variability and pick a fresh
    // random seed so identical prompts don't collapse to the same
    // output. Keep first-time generations on the default settings.
    const response = await deepseek.chat.completions.create({
      model: DEEPSEEK_MODEL,
      max_completion_tokens: 2048,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
            regenerate && previousText
              ? `Generate a ${difficulty} level text. Topic: ${topic}. This must be DIFFERENT from the previous draft — different angle, different opening, different examples.`
              : `Generate a ${difficulty} level text. Topic: ${topic}. Let the topic guide the contentType choice per the system instructions.`,
        },
      ],
      response_format: { type: "json_object" },
      ...(regenerate
        ? {
            temperature: 1.1,
            top_p: 0.95,
            seed: Math.floor(Math.random() * 2_147_483_647),
          }
        : {}),
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    // Strip markdown code fences that some models wrap JSON in
    const clean = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
    const data = JSON.parse(clean);
    if (!data.text || typeof data.text !== "string" || !data.text.trim()) {
      req.log.warn({ data }, "generate-text returned empty text");
    }
    res.json({ success: true, data });
  } catch (err) {
    req.log.error({ err }, "Failed to generate text");
    res.status(500).json({ success: false, error: "Failed to generate text" });
  }
});

router.post("/language/translate", requireDeepseek, async (req, res) => {
  try {
    const { text, fromLanguage, toLanguage } = req.body as {
      text: string;
      fromLanguage: string;
      toLanguage: string;
    };

    if (!text || !text.trim()) {
      res.json({ success: true, data: { translation: "" } });
      return;
    }

    const response = await deepseek.chat.completions.create({
      model: DEEPSEEK_MODEL,
      max_completion_tokens: 1500,
      messages: [
        {
          role: "system",
          content: `You are a professional translator. Translate the user's ${fromLanguage} text into natural, fluent ${toLanguage}. Preserve the structure: keep line breaks, paragraph breaks, and any "Speaker:" prefixes for dialogue. Do not add commentary. Return JSON: { "translation": "..." }.`,
        },
        { role: "user", content: text },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const clean = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
    const data = JSON.parse(clean);
    res.json({ success: true, data });
  } catch (err) {
    req.log.error({ err }, "Translate failed");
    res.status(500).json({ success: false, error: "Translate failed" });
  }
});

router.post("/language/process-manual", requireDeepseek, validateManualPayload, enforceGenerationQuota, async (req, res) => {
  try {
    const { text, targetLanguage, nativeLanguage } = req.body as {
      text: string;
      targetLanguage: string;
      nativeLanguage: string;
    };

    const response = await deepseek.chat.completions.create({
      model: DEEPSEEK_MODEL,
      max_completion_tokens: 2000,
      messages: [
        {
          role: "system",
          content: `You are a language learning assistant. The user provided a piece of text. Your job is to:
1. Detect what language the input is written in.
2. Produce a natural, fluent version in ${targetLanguage} (the learning target).
   - If the input is already in ${targetLanguage}, lightly normalize it but keep the wording intact.
   - Otherwise, translate it into idiomatic ${targetLanguage}.
3. Produce a natural translation in ${nativeLanguage} (the user's native language).
   - If the input is already in ${nativeLanguage}, you may use it (lightly cleaned) as the translation.
4. Assess the difficulty level of the resulting ${targetLanguage} text on the CEFR scale, choosing exactly one of:
   - "beginner" (A1-A2): very simple sentences, common everyday words.
   - "elementary" (A2-B1): simple sentences, everyday topics.
   - "intermediate" (B1-B2): moderate complexity, varied vocabulary.
   - "advanced" (C1-C2): complex grammar, idiomatic expressions, sophisticated vocabulary.

Preserve line breaks, paragraph breaks, and any "Speaker:" prefixes for dialogue in both versions.

5. Classify the content type of the text, choosing exactly one of:
   - "dialogue": a back-and-forth conversation between speakers.
   - "story": a narrative with characters, plot, or personal experience.
   - "speech": a spoken address, opinion piece, or persuasive text.
   - "info": a factual, explanatory, or news-like passage.

Return JSON only:
{
  "targetText": "...",      // text in ${targetLanguage}
  "nativeText": "...",      // text in ${nativeLanguage}
  "difficulty": "beginner" | "elementary" | "intermediate" | "advanced",
  "contentType": "dialogue" | "story" | "speech" | "info"
}`,
        },
        { role: "user", content: text },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const clean = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
    const data = JSON.parse(clean);
    const allowed = ["beginner", "elementary", "intermediate", "advanced"];
    const difficulty = allowed.includes(data.difficulty) ? data.difficulty : "intermediate";
    res.json({
      success: true,
      data: {
        targetText: typeof data.targetText === "string" ? data.targetText : text,
        nativeText: typeof data.nativeText === "string" ? data.nativeText : "",
        difficulty,
        contentType: data.contentType,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Process manual failed");
    res.status(500).json({ success: false, error: "Processing failed" });
  }
});

router.post("/language/word-detail", requireDeepseek, async (req, res) => {
  try {
    const { word, targetLanguage, language } = req.body as {
      word: string;
      targetLanguage: string;
      language: string;
    };

    const response = await deepseek.chat.completions.create({
      model: DEEPSEEK_MODEL,
      max_completion_tokens: 400,
      messages: [
        {
          role: "system",
          content: `You are a bilingual dictionary. For the given ${targetLanguage} word, return JSON with:
- "pronunciation": IPA or romanization
- "partOfSpeech": short tag like "n.", "v.", "adj.", "adv.", "phrase"
- "meaning": concise definition in ${language}
- "example": one natural example sentence using the word in ${targetLanguage}
- "exampleTranslation": translation of the example in ${language}`,
        },
        { role: "user", content: `Word: "${word}"` },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const clean = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
    const data = JSON.parse(clean);
    res.json({ success: true, data });
  } catch (err) {
    req.log.error({ err }, "Word detail failed");
    res.status(500).json({ success: false, error: "Lookup failed" });
  }
});

router.post("/language/tts", requireOpenai, async (req, res) => {
  try {
    const { text, voice = "nova" } = req.body as { text: string; voice?: string };

    const validVoice = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"].includes(voice)
      ? (voice as "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer")
      : "nova";

    const audioBuffer = await textToSpeech(text, validVoice, "mp3");

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audioBuffer.length);
    res.send(audioBuffer);
  } catch (err) {
    if (err instanceof OpenAINotConfiguredError) {
      res.status(503).json({ success: false, error: err.message });
      return;
    }
    req.log.error({ err }, "TTS failed");
    res.status(500).json({ success: false, error: "TTS generation failed" });
  }
});

/**
 * Normalize an app-side language code (e.g. "en-US", "zh-CN", "pt-BR")
 * to the ISO 639-1 form Whisper expects ("en", "zh", "pt"). We just take
 * the part before the first "-" and lowercase it; that's good enough for
 * every locale code the app currently emits.
 */
function toIso639_1(code: string | undefined | null): string | undefined {
  if (!code) return undefined;
  const head = String(code).split(/[-_]/)[0]?.trim().toLowerCase();
  return head && head.length >= 2 ? head : undefined;
}

router.post("/language/stt", requireOpenai, async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const audioBuffer = Buffer.concat(chunks);
        const { buffer, format } = await ensureCompatibleFormat(audioBuffer);
        // Optional language hint from the client. Whisper auto-detects
        // when omitted but tends to default to English on short clips,
        // so callers that know the target language should send it.
        const langHint = toIso639_1(
          (req.headers["x-target-language"] ??
            req.headers["x-language"]) as string | undefined,
        );
        const transcript = await speechToText(buffer, format, langHint);
        res.json({ success: true, transcript });
      } catch (err) {
        if (err instanceof OpenAINotConfiguredError) {
          res.status(503).json({ success: false, error: err.message });
          return;
        }
        req.log.error({ err }, "STT failed");
        res.status(500).json({ success: false, error: "Transcription failed" });
      }
    });
  } catch (err) {
    req.log.error({ err }, "STT request failed");
    res.status(500).json({ success: false, error: "Request failed" });
  }
});

router.post("/language/score-pronunciation", requireDeepseek, async (req, res) => {
  try {
    // `language` here is the user's UI / native language — it's used to
    // localize the LLM's written feedback. The language being practiced
    // is implicit in `targetText`. Naming it `nativeLanguage` internally
    // to keep that distinction obvious and avoid the historical bug
    // where the client passed targetLanguage and got feedback in the
    // wrong language.
    const { targetText, transcribedText, language: nativeLanguage } = req.body as {
      targetText: string;
      transcribedText: string;
      language: string;
    };

    const response = await deepseek.chat.completions.create({
      model: DEEPSEEK_MODEL,
      max_completion_tokens: 2048,
      messages: [
        {
          role: "system",
          content: `You are a language pronunciation and reading accuracy judge. Compare the target text with what was transcribed from the user's speech recording. Return JSON with:
- "score": 0-100 overall accuracy score
- "fluency": 0-100 numeric sub-score for how smoothly the user read (rhythm, hesitations, completeness). Lower if many words were skipped or the reading sounds halting.
- "accuracy": 0-100 numeric sub-score for word-level pronunciation correctness. Lower if specific words were mispronounced or substituted.
- "feedback": 1-2 sentences of warm, encouraging feedback in the user's native language (${nativeLanguage}). Open with a brief, sincere acknowledgement of what they did well, then give ONE specific, actionable suggestion. Avoid blunt criticism — frame any issue as a clear next step, not a verdict.
- "mistakes": array of specific words/phrases that were wrong or missing (max 3)
- "praise": one specific thing they did well
- "targetAnnotations": array of {"word": string, "status": "ok" | "wrong" | "missed"} that tokenizes the target text in original order. Use "wrong" for words the user mispronounced, "missed" for words they skipped entirely, "ok" otherwise. The concatenation of all words MUST exactly reproduce the target text (include punctuation as its own token or attached to the previous word).
- "userAnnotations": array of {"word": string, "status": "ok" | "wrong" | "extra"} that tokenizes the transcript in original order. Use "wrong" for words that don't match the target, "extra" for filler/inserted words not in the target, "ok" otherwise.
For non-spaced languages (Chinese / Japanese / Korean), tokenize at word/character boundaries that preserve readability when concatenated without spaces.`,
        },
        {
          role: "user",
          content: `Target: "${targetText}"\nTranscribed: "${transcribedText}"`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const clean = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
    const data = JSON.parse(clean);
    res.json({ success: true, data });
  } catch (err) {
    req.log.error({ err }, "Score pronunciation failed");
    res.status(500).json({ success: false, error: "Scoring failed" });
  }
});

/**
 * Multi-signal shadowing scorer.
 *
 * Accepts the user's raw audio recording in the request body (same wire
 * format as `/language/stt`) plus the target text and BCP-47 language
 * code via headers. Pipeline:
 *   1. Decode → Whisper verbose_json → word + segment timings.
 *   2. Compute deterministic STT metrics (pace, confidence, pauses).
 *   3. Compute prosody features (F0, energy) — gracefully null on
 *      decode failure.
 *   4. Ask DeepSeek to grade *accuracy* only, and to mark words as
 *      "unsure" when our low-confidence list flags them.
 *   5. Blend everything with the configured weights and return both
 *      sub-scores and the LLM's annotated breakdown.
 *
 * Headers:
 *   x-target-text — base64-encoded UTF-8 target text. Base64 because
 *                   passages may contain newlines / non-ASCII that would
 *                   otherwise be a footgun in a single header line.
 *   x-language    — BCP-47 native language code for feedback localization.
 *   x-target-language — BCP-47 code of the *target* (read-aloud) language.
 *                        Used to pick the pace target band.
 */
router.post(
  "/language/score-shadowing",
  requireOpenai,
  requireDeepseek,
  async (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      try {
        const audioBuffer = Buffer.concat(chunks);
        if (audioBuffer.length === 0) {
          res.status(400).json({ success: false, error: "Empty audio" });
          return;
        }
        const headers = req.headers as Record<string, string | undefined>;
        const targetTextRaw = headers["x-target-text"] ?? "";
        const targetText = (() => {
          try {
            return Buffer.from(targetTextRaw, "base64").toString("utf8");
          } catch {
            return "";
          }
        })().trim();
        if (!targetText) {
          res
            .status(400)
            .json({ success: false, error: "Missing x-target-text header" });
          return;
        }
        const language = (headers["x-language"] ?? "en").toString();
        const targetLanguage = (
          headers["x-target-language"] ?? language
        ).toString();

        // Always coerce to a Whisper-friendly container before STT and
        // *also* run prosody analysis on the same compatible buffer —
        // pitch detection on a raw .webm header would silently fail.
        const { buffer: compatBuffer, format } =
          await ensureCompatibleFormat(audioBuffer);

        // Tell Whisper the target language so e.g. a Mandarin shadowing
        // pass isn't auto-detected as English and returned as romanised
        // garbage. `targetLanguage` already comes in as a locale-ish
        // code ("en-US", "zh", "pt-BR"); normalize to ISO 639-1.
        const sttLangHint = toIso639_1(targetLanguage);
        const [detailed, prosody] = await Promise.all([
          speechToTextDetailed(compatBuffer, format, sttLangHint),
          computeProsodyMetrics(compatBuffer),
        ]);
        const stt = computeSttMetrics(detailed);

        // Build a compact evidence packet for the LLM. We give it the
        // full transcript, the words our STT was unsure about, and the
        // raw pace/pause numbers — the model uses the unsure list to
        // tag annotations as "unsure" instead of guessing "wrong".
        const evidence = {
          transcript: detailed.text,
          wordsPerSec: Number(stt.wordsPerSec.toFixed(2)),
          pauseCount: stt.pauseCount,
          longestPauseSec: Number(stt.longestPauseSec.toFixed(2)),
          meanConfidence: Number(stt.meanConfidence.toFixed(2)),
          lowConfidenceWords: stt.lowConfidenceWords.slice(0, 12),
          prosody: prosody
            ? {
                f0StdHz: Number(prosody.f0StdHz.toFixed(1)),
                voicedRatio: Number(prosody.voicedRatio.toFixed(2)),
              }
            : null,
        };

        const response = await deepseek.chat.completions.create({
          model: DEEPSEEK_MODEL,
          max_completion_tokens: 2048,
          messages: [
            {
              role: "system",
              content: `You are a language pronunciation judge for a shadowing exercise.

You will receive (a) the target text the learner was supposed to read aloud, (b) the speech-to-text transcript of what they actually said, and (c) deterministic acoustic / STT-confidence evidence. Your job is to produce a *content accuracy* judgment ONLY — pacing, prosody, and per-word confidence are scored separately by the server, so do NOT factor them into "accuracy".

Return JSON with:
- "accuracy": 0-100 numeric sub-score for word-level reading accuracy. A perfect read of the target text scores 100.
- "feedback": 1-2 sentences of warm, encouraging feedback in the user's native language (${language}). Open with a brief, sincere acknowledgement of what they did well, then give ONE specific, actionable suggestion. Avoid blunt criticism — frame any issue as a clear next step, not a verdict.
- "mistakes": array of specific words/phrases that were truly wrong or missing (max 3). Do NOT include words that only appear in "lowConfidenceWords" — those are STT-uncertain, not necessarily mispronounced.
- "praise": one specific thing they did well.
- "targetAnnotations": array of {"word": string, "status": "ok" | "wrong" | "missed" | "unsure"} that tokenizes the target text in original order. Use "wrong" for words clearly mispronounced or substituted, "missed" for words skipped entirely, "unsure" for words whose target form appears in the provided lowConfidenceWords list AND the transcript is genuinely ambiguous (the STT couldn't tell), "ok" otherwise. The concatenation of all words MUST exactly reproduce the target text (include punctuation as its own token or attached to the previous word).
- "userAnnotations": array of {"word": string, "status": "ok" | "wrong" | "extra" | "unsure"} that tokenizes the transcript in original order. Use "wrong" for words that don't match the target, "extra" for filler/inserted words not in the target, "unsure" for words flagged in lowConfidenceWords, "ok" otherwise.
For non-spaced languages (Chinese / Japanese / Korean), tokenize at word/character boundaries that preserve readability when concatenated without spaces.`,
            },
            {
              role: "user",
              content: `Target: "${targetText}"
Transcript: "${detailed.text}"
Evidence: ${JSON.stringify(evidence)}`,
            },
          ],
          response_format: { type: "json_object" },
        });

        const llm = JSON.parse(
          response.choices[0]?.message?.content ?? "{}"
        ) as {
          accuracy?: number;
          feedback?: string;
          mistakes?: unknown;
          praise?: unknown;
          targetAnnotations?: unknown;
          userAnnotations?: unknown;
        };
        const llmAccuracy =
          typeof llm.accuracy === "number" ? llm.accuracy : 0;

        const blended = scoreFromSignals({
          llmAccuracy,
          stt,
          prosody,
          language: targetLanguage,
        });

        res.json({
          success: true,
          data: {
            score: blended.overall,
            accuracy: Math.round(llmAccuracy),
            pace: blended.pace,
            confidence: blended.confidence,
            prosody: blended.prosody,
            // Legacy "fluency" alias kept so older clients that still
            // read it don't go blank — same value as confidence, which
            // best matches the previous semantics.
            fluency: blended.confidence,
            feedback: typeof llm.feedback === "string" ? llm.feedback : "",
            mistakes: Array.isArray(llm.mistakes) ? llm.mistakes : [],
            praise: typeof llm.praise === "string" ? llm.praise : "",
            targetAnnotations: Array.isArray(llm.targetAnnotations)
              ? llm.targetAnnotations
              : [],
            userAnnotations: Array.isArray(llm.userAnnotations)
              ? llm.userAnnotations
              : [],
            userTranscript: detailed.text,
            lowConfidenceWords: stt.lowConfidenceWords,
            prosodyAvailable: prosody !== null,
            weights: SCORE_WEIGHTS,
          },
        });
      } catch (err) {
        if (err instanceof OpenAINotConfiguredError) {
          res.status(503).json({ success: false, error: err.message });
          return;
        }
        req.log.error({ err }, "Score shadowing failed");
        res.status(500).json({ success: false, error: "Scoring failed" });
      }
    });
  }
);

// ── dictation: punctuation-insensitive helpers ────────────────────────
// Dictation grading should focus on whether the learner heard the words,
// not whether they typed every comma and full-stop. We strip punctuation
// (Unicode \p{P} + \p{S}, covers ASCII, CJK, smart quotes, etc.),
// collapse whitespace, and lower-case for comparison. The lower-case
// step is harmless for scripts without case (Chinese/Japanese/Arabic…).
const PUNCT_RE = /[\p{P}\p{S}]+/gu;
function stripPunctuation(s: string): string {
  return s.replace(PUNCT_RE, "");
}
function normalizeForCompare(s: string): string {
  // Collapse runs of whitespace to a single space (don't strip them) so
  // that real word-boundary differences like "goodmorning" vs "good
  // morning" are still treated as different — only punctuation, case,
  // and incidental whitespace formatting are ignored.
  return stripPunctuation(s).replace(/\s+/g, " ").trim().toLowerCase();
}
function isPurePunctuation(token: string): boolean {
  if (!token) return false;
  return stripPunctuation(token).trim() === "";
}

router.post("/language/score-dictation", requireDeepseek, async (req, res) => {
  try {
    // See score-pronunciation for naming rationale: `language` is the
    // user's native / UI language for written feedback, not the
    // language being practiced.
    const { targetText, userText, language: nativeLanguage } = req.body as {
      targetText: string;
      userText: string;
      language: string;
    };

    const response = await deepseek.chat.completions.create({
      model: DEEPSEEK_MODEL,
      max_completion_tokens: 2048,
      messages: [
        {
          role: "system",
          content: `You are a language dictation judge. Compare the target text with the user's written response. Return JSON with:
- "score": 0-100 accuracy score (penalize spelling errors, missing words, wrong words)
- "feedback": 1-2 sentences of warm, encouraging feedback in ${nativeLanguage}. Open with a brief, sincere acknowledgement of what they got right, then give ONE specific, actionable suggestion (e.g. which type of error to focus on). Avoid blunt criticism — frame any issue as a clear next step, not a verdict.
- "corrections": array of objects {wrong: string, correct: string} showing what was wrong (max 5)
- "wordAccuracy": percentage of words spelled correctly
- "userAnnotations": array of {"word": string, "status": "ok" | "wrong" | "extra", "correct"?: string} that tokenizes the user's writing in original order. Use "wrong" for misspelled or wrong words (include the suggested correction in "correct"), "extra" for words the user wrote that aren't in the target, "ok" otherwise.
- "targetAnnotations": array of {"word": string, "status": "ok" | "wrong" | "missed"} that tokenizes the target text in original order. Use "missed" for words the user omitted, "wrong" for words the user spelled or replaced incorrectly, "ok" otherwise.
The concatenation of all words in each array MUST exactly reproduce the original sentence (include punctuation as its own token or attached to the previous word). For non-spaced languages, tokenize at word/character boundaries that preserve readability when concatenated without spaces.

CRITICAL: Punctuation differences DO NOT count as errors. Ignore any difference in punctuation marks, including missing or extra commas / periods / question marks / exclamation marks, mismatched or smart vs straight quotes, and Chinese vs ASCII punctuation (，。？！「」“” vs ,.?!""). Tokens that consist only of punctuation MUST always have status "ok". Never list a punctuation-only difference in "corrections", and never reduce "score" or "wordAccuracy" because of punctuation.`,
        },
        {
          role: "user",
          content: `Target: "${targetText}"\nUser wrote: "${userText}"`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const clean = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
    const data = JSON.parse(clean);

    // ── defensive post-processing ────────────────────────────────────
    // Models occasionally ignore the "no punctuation penalty" rule, so
    // we backstop it here:
    //   1) Force any pure-punctuation token's status to "ok".
    //   2) Drop "corrections" entries whose wrong/correct only differ
    //      in punctuation/whitespace/case.
    //   3) If the user's text matches the target after stripping
    //      punctuation, treat it as a perfect answer (score 100,
    //      wordAccuracy 100, no corrections, all annotations ok).
    if (Array.isArray(data.userAnnotations)) {
      data.userAnnotations = data.userAnnotations.map((a: any) => {
        if (a && typeof a === "object" && typeof a.word === "string" && isPurePunctuation(a.word)) {
          return { ...a, status: "ok", correct: undefined };
        }
        return a;
      });
    }
    if (Array.isArray(data.targetAnnotations)) {
      data.targetAnnotations = data.targetAnnotations.map((a: any) => {
        if (a && typeof a === "object" && typeof a.word === "string" && isPurePunctuation(a.word)) {
          return { ...a, status: "ok" };
        }
        return a;
      });
    }
    if (Array.isArray(data.corrections)) {
      data.corrections = data.corrections.filter((c: any) => {
        if (!c || typeof c !== "object") return false;
        const w = typeof c.wrong === "string" ? c.wrong : "";
        const r = typeof c.correct === "string" ? c.correct : "";
        return normalizeForCompare(w) !== normalizeForCompare(r);
      });
    }

    // Guard: the model occasionally "fixes up" the user's writing in
    // userAnnotations (changes case, inserts missing punctuation,
    // straightens quotes…). The result page renders those tokens
    // verbatim under "what you wrote", so the user sees text that isn't
    // theirs. If the concatenated user-side annotations don't match the
    // original userText (modulo whitespace), drop them so the client
    // falls back to displaying the raw userText. Whitespace is the
    // only formatting we tolerate because tokenization may attach or
    // detach spaces between words.
    if (Array.isArray(data.userAnnotations) && typeof userText === "string") {
      const stripWs = (s: string) => s.replace(/\s+/g, "");
      const reconstructed = data.userAnnotations
        .map((a: any) => (a && typeof a.word === "string" ? a.word : ""))
        .join("");
      if (stripWs(reconstructed) !== stripWs(userText)) {
        data.userAnnotations = undefined;
      }
    }

    if (
      typeof targetText === "string" &&
      typeof userText === "string" &&
      normalizeForCompare(targetText) === normalizeForCompare(userText)
    ) {
      data.score = 100;
      data.wordAccuracy = 100;
      data.corrections = [];
      if (Array.isArray(data.userAnnotations)) {
        data.userAnnotations = data.userAnnotations.map((a: any) =>
          a && typeof a === "object" ? { ...a, status: "ok", correct: undefined } : a
        );
      }
      if (Array.isArray(data.targetAnnotations)) {
        data.targetAnnotations = data.targetAnnotations.map((a: any) =>
          a && typeof a === "object" ? { ...a, status: "ok" } : a
        );
      }
    }

    res.json({ success: true, data });
  } catch (err) {
    req.log.error({ err }, "Score dictation failed");
    res.status(500).json({ success: false, error: "Scoring failed" });
  }
});

// =====================================================================
// Recitation scoring.
//
// Two wire shapes are accepted on the SAME endpoint:
//   1. Preferred: raw audio bytes in the body + x-target-text /
//      x-language / x-target-language headers, mirroring
//      /language/score-shadowing. The server runs Whisper detailed STT,
//      prosody, and per-word confidence and blends them with a
//      LLM-derived "memory accuracy" sub-score using SCORE_WEIGHTS.
//      This makes recitation grading sensitive to mumbled / monotone /
//      too-fast reads, not just to whether the words were remembered.
//   2. Fallback: legacy JSON body { targetText, transcribedText,
//      language }. Used only when the client cannot upload audio (e.g.
//      web browsers without recording, or audio buffer dropped). The
//      LLM-derived score is significantly downweighted because we have
//      no way to measure pronunciation, prosody, or pace.
//
// LLM output shape is shared between both paths so client rendering is
// the same: { accuracy, completeness, feedback, mistakes,
// targetAnnotations, userAnnotations }. The blended `score` is
// computed server-side; `fluency` is preserved as a coarse legacy
// label for older clients (mapped from confidence sub-score).
// =====================================================================

interface RecitationLlmResult {
  accuracy: number;
  completeness: number;
  feedback: string;
  mistakes: unknown[];
  praise: string;
  targetAnnotations: unknown[];
  userAnnotations: unknown[];
}

function fluencyLabel(score: number): "excellent" | "good" | "fair" | "needs_work" {
  if (score >= 85) return "excellent";
  if (score >= 70) return "good";
  if (score >= 50) return "fair";
  return "needs_work";
}

async function gradeRecitationContent(args: {
  targetText: string;
  transcript: string;
  nativeLanguage: string;
  evidence?: object | null;
}): Promise<RecitationLlmResult> {
  const evidenceLine = args.evidence
    ? `\nEvidence: ${JSON.stringify(args.evidence)}`
    : "";
  const response = await deepseek.chat.completions.create({
    model: DEEPSEEK_MODEL,
    max_completion_tokens: 2048,
    messages: [
      {
        role: "system",
        content: `You are a language recitation judge. The user was supposed to recite a target text from memory. You grade *memory accuracy* only — pronunciation clarity, intonation, and pace are scored separately by the server from acoustic signals, so do NOT factor them into "accuracy" or "completeness".

Return JSON with:
- "accuracy": 0-100 numeric sub-score for how faithfully the user recited the target text from memory (correct words, correct order). A perfect, complete recitation scores 100.
- "completeness": 0-100 percentage of the target text the user actually covered (independent of whether they got it right). A user who recited only the first half of the passage scores ≤ 50 here.
- "feedback": 1-2 sentences of warm, encouraging feedback in ${args.nativeLanguage}. Open with a brief, sincere acknowledgement of what they remembered well, then give ONE specific, actionable suggestion. Avoid blunt criticism — frame any issue as a clear next step, not a verdict.
- "mistakes": array of words/phrases the user got wrong or skipped (max 3). Do NOT list words that only appear in the evidence's "lowConfidenceWords" list — those are STT-uncertain, not necessarily forgotten.
- "praise": one specific thing they did well.
- "targetAnnotations": array of {"word": string, "status": "ok" | "wrong" | "missed" | "unsure"} that tokenizes the target text in original order. Use "missed" for parts the user did NOT recite (forgot), "wrong" for parts they recited incorrectly, "unsure" when the target word also appears in the evidence's lowConfidenceWords AND the transcript is ambiguous, "ok" otherwise. The concatenation of all words MUST exactly reproduce the target text (include punctuation as its own token or attached to the previous word).
- "userAnnotations": array of {"word": string, "status": "ok" | "wrong" | "extra" | "unsure"} that tokenizes the transcript in original order. Use "wrong" for words that don't match the target, "extra" for filler/inserted words not in the target, "unsure" for words flagged in lowConfidenceWords, "ok" otherwise.
For non-spaced languages (Chinese / Japanese / Korean), tokenize at word/character boundaries that preserve readability when concatenated without spaces.`,
      },
      {
        role: "user",
        content: `Target: "${args.targetText}"
Transcript: "${args.transcript}"${evidenceLine}`,
      },
    ],
    response_format: { type: "json_object" },
  });

  const raw = JSON.parse(
    response.choices[0]?.message?.content ?? "{}"
  ) as Partial<RecitationLlmResult> & { score?: number };
  // Older prompt returned `score`; keep accepting it as a synonym for
  // `accuracy` so a stray model regression doesn't blank the field.
  const accuracy =
    typeof raw.accuracy === "number"
      ? raw.accuracy
      : typeof raw.score === "number"
      ? raw.score
      : 0;
  return {
    accuracy,
    completeness:
      typeof raw.completeness === "number" ? raw.completeness : 0,
    feedback: typeof raw.feedback === "string" ? raw.feedback : "",
    mistakes: Array.isArray(raw.mistakes) ? raw.mistakes : [],
    praise: typeof raw.praise === "string" ? raw.praise : "",
    targetAnnotations: Array.isArray(raw.targetAnnotations)
      ? raw.targetAnnotations
      : [],
    userAnnotations: Array.isArray(raw.userAnnotations)
      ? raw.userAnnotations
      : [],
  };
}

router.post("/language/score-recitation", requireDeepseek, async (req, res) => {
  const headers = req.headers as Record<string, string | undefined>;
  const targetTextHeader = headers["x-target-text"];
  const contentType = (headers["content-type"] ?? "").toLowerCase();
  const isAudioRequest =
    !!targetTextHeader && !contentType.startsWith("application/json");

  if (isAudioRequest) {
    if (!isOpenaiConfigured()) {
      res.status(503).json({
        success: false,
        error:
          "OpenAI 未配置：请到 https://platform.openai.com 申请 API key，然后设置 OPENAI_API_KEY 环境变量后重启服务（OpenAI is not configured: set OPENAI_API_KEY and restart the server）",
      });
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      try {
        const audioBuffer = Buffer.concat(chunks);
        const targetText = (() => {
          try {
            return Buffer.from(targetTextHeader ?? "", "base64").toString(
              "utf8"
            );
          } catch {
            return "";
          }
        })().trim();
        if (!targetText) {
          res.status(400).json({
            success: false,
            error: "Missing x-target-text header",
          });
          return;
        }
        const nativeLanguage = (headers["x-language"] ?? "en").toString();
        const targetLanguage = (
          headers["x-target-language"] ?? nativeLanguage
        ).toString();

        // Empty audio is treated like an STT failure rather than a
        // hard 400 — the client may have sent a zero-byte body because
        // the recording was lost mid-flight, and we'd rather give the
        // user a downweighted content-only grade than a dead-end
        // error. The LLM will see an empty transcript and respond
        // accordingly.
        if (audioBuffer.length === 0) {
          req.log.warn(
            "Recitation got empty audio body, returning content-only grade"
          );
          const llm = await gradeRecitationContent({
            targetText,
            transcript: "",
            nativeLanguage,
          });
          res.json({
            success: true,
            data: {
              score: Math.round(llm.accuracy * 0.5),
              accuracy: Math.round(llm.accuracy),
              completeness: Math.round(llm.completeness),
              pace: null,
              confidence: null,
              prosody: null,
              prosodyAvailable: false,
              audioAnalyzed: false,
              fluency: fluencyLabel(llm.accuracy),
              feedback: llm.feedback,
              mistakes: llm.mistakes,
              praise: llm.praise,
              targetAnnotations: llm.targetAnnotations,
              userAnnotations: llm.userAnnotations,
              userTranscript: "",
              lowConfidenceWords: [],
              weights: SCORE_WEIGHTS,
            },
          });
          return;
        }

        // Decode once into a Whisper-friendly container so prosody and
        // STT see the same canonical buffer (raw .webm headers can
        // silently break pitch detection).
        const { buffer: compatBuffer, format } = await ensureCompatibleFormat(
          audioBuffer
        );
        const sttLangHint = toIso639_1(targetLanguage);

        // Fail soft: if STT or prosody throws, we still want to return
        // *something*. Track each leg independently so a Whisper outage
        // collapses gracefully to a content-only score instead of a 500.
        const sttPromise = speechToTextDetailed(
          compatBuffer,
          format,
          sttLangHint
        )
          .then((d) => ({ ok: true as const, value: d }))
          .catch((err: unknown) => ({ ok: false as const, err }));
        const prosodyPromise = computeProsodyMetrics(compatBuffer).catch(
          () => null
        );
        const [sttResult, prosody] = await Promise.all([
          sttPromise,
          prosodyPromise,
        ]);

        if (!sttResult.ok) {
          // STT itself failed — fall back to a content-only grade with
          // an empty transcript so the user still sees feedback. The
          // LLM will mostly say "we couldn't hear you", but the
          // request doesn't 5xx and the client can still render the
          // result page.
          req.log.warn(
            { err: sttResult.err },
            "Recitation STT failed, falling back to content-only grade"
          );
          const llm = await gradeRecitationContent({
            targetText,
            transcript: "",
            nativeLanguage,
          });
          res.json({
            success: true,
            data: {
              score: Math.round(llm.accuracy * 0.5),
              accuracy: Math.round(llm.accuracy),
              completeness: Math.round(llm.completeness),
              pace: null,
              confidence: null,
              prosody: null,
              prosodyAvailable: false,
              audioAnalyzed: false,
              fluency: fluencyLabel(llm.accuracy),
              feedback: llm.feedback,
              mistakes: llm.mistakes,
              praise: llm.praise,
              targetAnnotations: llm.targetAnnotations,
              userAnnotations: llm.userAnnotations,
              userTranscript: "",
              lowConfidenceWords: [],
              weights: SCORE_WEIGHTS,
            },
          });
          return;
        }

        const detailed = sttResult.value;
        const stt = computeSttMetrics(detailed);
        const evidence = {
          transcript: detailed.text,
          wordsPerSec: Number(stt.wordsPerSec.toFixed(2)),
          pauseCount: stt.pauseCount,
          longestPauseSec: Number(stt.longestPauseSec.toFixed(2)),
          meanConfidence: Number(stt.meanConfidence.toFixed(2)),
          lowConfidenceWords: stt.lowConfidenceWords.slice(0, 12),
          prosody: prosody
            ? {
                f0StdHz: Number(prosody.f0StdHz.toFixed(1)),
                voicedRatio: Number(prosody.voicedRatio.toFixed(2)),
              }
            : null,
        };

        const llm = await gradeRecitationContent({
          targetText,
          transcript: detailed.text,
          nativeLanguage,
          evidence,
        });

        const blended = scoreFromSignals({
          llmAccuracy: llm.accuracy,
          stt,
          prosody,
          language: targetLanguage,
        });

        res.json({
          success: true,
          data: {
            score: blended.overall,
            accuracy: Math.round(llm.accuracy),
            completeness: Math.round(llm.completeness),
            pace: blended.pace,
            confidence: blended.confidence,
            prosody: blended.prosody,
            prosodyAvailable: prosody !== null,
            audioAnalyzed: true,
            // Legacy coarse "fluency" label for older clients that
            // still render it as a string. We map it from confidence
            // because that's the closest semantic match (smoothness of
            // delivery), not from the overall blended score.
            fluency: fluencyLabel(blended.confidence),
            feedback: llm.feedback,
            mistakes: llm.mistakes,
            praise: llm.praise,
            targetAnnotations: llm.targetAnnotations,
            userAnnotations: llm.userAnnotations,
            userTranscript: detailed.text,
            lowConfidenceWords: stt.lowConfidenceWords,
            weights: SCORE_WEIGHTS,
          },
        });
      } catch (err) {
        if (err instanceof OpenAINotConfiguredError) {
          res.status(503).json({ success: false, error: err.message });
          return;
        }
        req.log.error({ err }, "Score recitation (audio) failed");
        res.status(500).json({ success: false, error: "Scoring failed" });
      }
    });
    return;
  }

  // Text-only fallback. We have no way to evaluate pronunciation, pace,
  // or prosody, so the blended score is significantly downweighted
  // (multiply by 0.7) to discourage relying on this path. Sub-scores
  // come back as null so the client can render a "—" instead of
  // pretending to have measured them.
  try {
    const {
      targetText,
      transcribedText,
      language: nativeLanguage,
    } = req.body as {
      targetText: string;
      transcribedText: string;
      language: string;
    };
    const llm = await gradeRecitationContent({
      targetText: targetText ?? "",
      transcript: transcribedText ?? "",
      nativeLanguage: nativeLanguage ?? "en",
    });
    const downweighted = Math.round(llm.accuracy * 0.7);
    res.json({
      success: true,
      data: {
        score: downweighted,
        accuracy: Math.round(llm.accuracy),
        completeness: Math.round(llm.completeness),
        pace: null,
        confidence: null,
        prosody: null,
        prosodyAvailable: false,
        audioAnalyzed: false,
        fluency: fluencyLabel(llm.accuracy),
        feedback: llm.feedback,
        mistakes: llm.mistakes,
        praise: llm.praise,
        targetAnnotations: llm.targetAnnotations,
        userAnnotations: llm.userAnnotations,
        userTranscript: transcribedText ?? "",
        lowConfidenceWords: [],
        weights: SCORE_WEIGHTS,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Score recitation (text fallback) failed");
    res.status(500).json({ success: false, error: "Scoring failed" });
  }
});

export default router;
