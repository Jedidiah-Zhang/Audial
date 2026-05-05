import { Hono, type Context, type Next } from "npm:hono";
import { corsMiddleware } from "../_shared/cors.ts";
import { db, generationQuotaTable } from "../_shared/db.ts";
import { deepseek, DEEPSEEK_MODEL, isDeepseekConfigured } from "../_shared/deepseek-client.ts";
import { isOpenaiConfigured } from "../_shared/openai-client.ts";
import { optionalClerkAuth, type AuthState } from "../_shared/clerk.ts";
import { eq, and } from "npm:drizzle-orm";
import { textToSpeech, speechToText, speechToTextDetailed } from "./_lib/tts-stt.ts";
import { computeSttMetrics } from "./_lib/scoring.ts";
import { computeProsodyMetrics } from "./_lib/prosody.ts";
import { scoreFromSignals } from "./_lib/scoring.ts";

const app = new Hono();
app.use("*", corsMiddleware);

// ===================================================================
// Quota system (ported from Express version)
// ===================================================================

const FREE_DAILY_GENERATION_LIMIT = 3;
const REWARD_TOKEN_TTL_MS = 30 * 60 * 1000;

const rewardTokens = new Map<string, { userId: string; expiresAt: number }>();

function todayKey(): string {
  const shifted = new Date(Date.now() + 4 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function readUserIdFromCtx(c: Context): string {
  const auth = c.get("auth") as AuthState | undefined;
  if (auth?.userId) return auth.userId;
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0] || "anonymous";
  return `guest:${forwarded}`;
}

function readTierFromCtx(c: Context): "free" | "pro" {
  const auth = c.get("auth") as AuthState | undefined;
  return auth?.tier === "pro" ? "pro" : "free";
}

async function enforceGenerationQuota(c: Context, next: Next) {
  const tier = readTierFromCtx(c);
  const body = c.get("parsedBody") || {};

  // Pro users and regenerations are exempt
  if (tier === "pro" || body.regenerate) {
    return await next();
  }

  const rewardToken = c.req.header("x-reward-token");
  const userId = readUserIdFromCtx(c);

  if (rewardToken) {
    const tokenData = rewardTokens.get(rewardToken);
    if (tokenData && tokenData.userId === userId && Date.now() < tokenData.expiresAt) {
      rewardTokens.delete(rewardToken);
      return await next();
    }
    // Invalid token — fall through to quota check
  }

  const date = todayKey();
  const existing = await db
    .select({ count: generationQuotaTable.count })
    .from(generationQuotaTable)
    .where(
      and(eq(generationQuotaTable.userId, userId), eq(generationQuotaTable.date, date)),
    )
    .limit(1);

  const current = existing[0]?.count ?? 0;

  // Atomic increment
  if (current === 0) {
    await db.insert(generationQuotaTable).values({ userId, date, count: 1 }).onConflictDoNothing();
  } else {
    await db
      .update(generationQuotaTable)
      .set({ count: current + 1 })
      .where(
        and(eq(generationQuotaTable.userId, userId), eq(generationQuotaTable.date, date)),
      );
  }

  if (current >= FREE_DAILY_GENERATION_LIMIT) {
    // Rollback the increment
    await db
      .update(generationQuotaTable)
      .set({ count: current })
      .where(
        and(eq(generationQuotaTable.userId, userId), eq(generationQuotaTable.date, date)),
      );
    return c.json(
      { success: false, error: "Daily generation limit reached", code: "QUOTA_EXCEEDED" },
      429,
    );
  }

  await next();
}

// Middleware to check DeepSeek is configured
async function requireDeepseek(_c: Context, next: Next) {
  if (!isDeepseekConfigured()) {
    return _c.json({ success: false, error: "DeepSeek is not configured" }, 503);
  }
  await next();
}

async function requireOpenai(_c: Context, next: Next) {
  if (!isOpenaiConfigured()) {
    return _c.json({ success: false, error: "OpenAI is not configured" }, 503);
  }
  await next();
}

// ===================================================================
// Helpers for response formatting
// ===================================================================

function ok(data: unknown) {
  return { success: true, data };
}

function err(message: string, code?: number) {
  return { success: false, error: message, code };
}

// ===================================================================
// GET /api/language/quota
// ===================================================================

app.get("/quota", optionalClerkAuth, async (c) => {
  try {
    const userId = readUserIdFromCtx(c);
    const tier = readTierFromCtx(c);
    const date = todayKey();

    const rows = await db
      .select({ count: generationQuotaTable.count })
      .from(generationQuotaTable)
      .where(
        and(eq(generationQuotaTable.userId, userId), eq(generationQuotaTable.date, date)),
      )
      .limit(1);
    const used = rows[0]?.count ?? 0;

    return c.json(
      ok({
        tier,
        limit: FREE_DAILY_GENERATION_LIMIT,
        used,
        remaining: Math.max(0, FREE_DAILY_GENERATION_LIMIT - used),
        resetDate: date,
      }),
    );
  } catch (e) {
    return c.json({ success: false, error: String(e), stack: (e as Error).stack }, 500);
  }
});

// ===================================================================
// POST /api/language/ad/grant-reward
// ===================================================================

app.post("/ad/grant-reward", optionalClerkAuth, async (c) => {
  const body = await c.req.json();
  const userId = readUserIdFromCtx(c);
  const token = crypto.randomUUID();
  rewardTokens.set(token, { userId, expiresAt: Date.now() + REWARD_TOKEN_TTL_MS });
  return c.json(ok({ placement: body.placement, token, expiresInMs: REWARD_TOKEN_TTL_MS }));
});

// ===================================================================
// POST /api/language/generate-text
// ===================================================================

app.post("/generate-text", optionalClerkAuth, requireDeepseek, enforceGenerationQuota, async (c) => {
  const body = await c.req.json();
  const { topic, difficulty, language, targetLanguage, contentType, regenerate, previousText, previousTitle } = body;

  const systemPrompt = `You are a language-learning content creator. Generate engaging reading passages suitable for ${difficulty} level learners of ${targetLanguage || "English"}.
The response must be valid JSON with these fields:
- text: the full passage (200-500 characters)
- translation: translation in ${language || "Chinese"} (natural, not word-for-word)
- title: a short title in ${targetLanguage || "English"}
- contentType: "dialogue" | "article" | "story" | "news" | "essay"
- vocabulary: array of { word, pronunciation?, partOfSpeech, meaning, example?, exampleTranslation? } for 5-8 key words

Topic: ${topic}. Make it interesting and culturally appropriate.
${regenerate ? `Previous title was "${previousTitle}". Create something different.` : ""}`;

  const response = await deepseek.chat.completions.create({
    model: DEEPSEEK_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      ...(regenerate && previousText
        ? [{ role: "user", content: `Previously generated: ${previousText.slice(0, 100)}...` }]
        : []),
      { role: "user", content: `Generate a ${difficulty} level ${contentType || "article"} about ${topic} in ${targetLanguage || "English"}.` },
    ],
    max_tokens: 2048,
    temperature: regenerate ? 1.1 : 0.7,
    top_p: regenerate ? 0.95 : 0.9,
    response_format: { type: "json_object" },
    ...(regenerate ? { seed: Math.floor(Math.random() * 100000) } : {}),
  });

  const content = JSON.parse(response.choices[0].message.content || "{}");
  return c.json(ok(content));
});

// ===================================================================
// POST /api/language/translate
// ===================================================================

app.post("/translate", optionalClerkAuth, requireDeepseek, async (c) => {
  const { text, fromLanguage, toLanguage } = await c.req.json();

  const response = await deepseek.chat.completions.create({
    model: DEEPSEEK_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a professional translator. Translate the text from ${fromLanguage} to ${toLanguage}. Return a JSON object: { "translation": "..." }`,
      },
      { role: "user", content: text },
    ],
    max_tokens: 1500,
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(response.choices[0].message.content || "{}");
  return c.json(ok(result));
});

// ===================================================================
// POST /api/language/process-manual
// ===================================================================

app.post("/process-manual", optionalClerkAuth, requireDeepseek, enforceGenerationQuota, async (c) => {
  const { text, nativeLanguage } = await c.req.json();

  const response = await deepseek.chat.completions.create({
    model: DEEPSEEK_MODEL,
    messages: [
      {
        role: "system",
        content: `Analyze the following text. Return JSON:
{
  "targetText": "the original text",
  "nativeText": "translation to ${nativeLanguage || "Chinese"}",
  "difficulty": "beginner" | "elementary" | "intermediate" | "advanced"
}`,
      },
      { role: "user", content: text },
    ],
    max_tokens: 2000,
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(response.choices[0].message.content || "{}");
  return c.json(ok(result));
});

// ===================================================================
// POST /api/language/word-detail
// ===================================================================

app.post("/word-detail", optionalClerkAuth, requireDeepseek, async (c) => {
  const { word, targetLanguage, language } = await c.req.json();

  const response = await deepseek.chat.completions.create({
    model: DEEPSEEK_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a bilingual dictionary (${targetLanguage || "English"} ↔ ${language || "Chinese"}). For the given word, return JSON:
{ "pronunciation": "...", "partOfSpeech": "...", "meaning": "...", "example": "...", "exampleTranslation": "..." }`,
      },
      { role: "user", content: word },
    ],
    max_tokens: 400,
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(response.choices[0].message.content || "{}");
  return c.json(ok(result));
});

// ===================================================================
// POST /api/language/tts
// ===================================================================

app.post("/tts", optionalClerkAuth, requireOpenai, async (c) => {
  const { text, voice } = await c.req.json();
  const validVoice = (["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const)
    .find((v) => v === voice) ?? "nova";

  const audioBuffer = await textToSpeech(text, validVoice, "mp3");
  return new Response(audioBuffer, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(audioBuffer.byteLength),
    },
  });
});

// ===================================================================
// POST /api/language/stt
// ===================================================================

app.post("/stt", optionalClerkAuth, requireOpenai, async (c) => {
  const audioBuffer = new Uint8Array(await c.req.arrayBuffer());
  const format = c.req.header("x-audio-format") || "wav";
  const targetLanguage = c.req.header("x-target-language");

  try {
    const transcript = await speechToText(audioBuffer, format, targetLanguage || undefined);
    return c.json(ok({ transcript }));
  } catch (err) {
    return c.json(err("Speech recognition failed: " + (err as Error).message, 500), 500);
  }
});

// ===================================================================
// POST /api/language/score-pronunciation (text-only, no audio)
// ===================================================================

app.post("/score-pronunciation", optionalClerkAuth, requireDeepseek, async (c) => {
  const { targetText, transcribedText, language } = await c.req.json();

  const response = await deepseek.chat.completions.create({
    model: DEEPSEEK_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a pronunciation coach for ${language || "English"}. Compare the target text with the user's transcribed text.
Return JSON:
{
  "score": 0-100,
  "fluency": 0-100,
  "accuracy": 0-100,
  "feedback": "brief feedback in Chinese",
  "mistakes": ["word-level mistake 1", ...],
  "praise": ["what they did well", ...],
  "targetAnnotations": [{ "start": 0, "end": 5, "text": "..." }],
  "userAnnotations": [{ "start": 0, "end": 5, "text": "..." }]
}`,
      },
      { role: "user", content: `Target: "${targetText}"\nUser said: "${transcribedText}"` },
    ],
    max_tokens: 2048,
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(response.choices[0].message.content || "{}");
  return c.json(ok(result));
});

// ===================================================================
// POST /api/language/score-dictation
// ===================================================================

app.post("/score-dictation", optionalClerkAuth, requireDeepseek, async (c) => {
  const { targetText, userText, language } = await c.req.json();

  const response = await deepseek.chat.completions.create({
    model: DEEPSEEK_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a dictation evaluator for ${language || "English"}. Compare target and user-written text.
Return JSON:
{
  "score": 0-100,
  "feedback": "brief feedback in Chinese",
  "corrections": [{ "original": "...", "corrected": "...", "type": "spelling" | "grammar" | "missing" }],
  "wordAccuracy": 0-100,
  "userAnnotations": [{ "start": 0, "end": 5, "text": "..." }],
  "targetAnnotations": [{ "start": 0, "end": 5, "text": "..." }]
}`,
      },
      { role: "user", content: `Target: "${targetText}"\nUser wrote: "${userText}"` },
    ],
    max_tokens: 2048,
    response_format: { type: "json_object" },
  });

  let result = JSON.parse(response.choices[0].message.content || "{}");

  // Post-processing: handle punctuation-only differences gracefully
  if (typeof result.score === "number" && result.score < 100) {
    const normalizedUser = userText.replace(/[.,!?;:]/g, "").toLowerCase().trim();
    const normalizedTarget = targetText.replace(/[.,!?;:]/g, "").toLowerCase().trim();
    if (normalizedUser === normalizedTarget) {
      result.score = Math.max(result.score, 95);
    }
  }

  return c.json(ok(result));
});

function decodeBase64Header(header: string): string {
  try {
    // Equivalent to decodeURIComponent(escape(atob(b64))) — UTF-8 base64 decode
    const binaryStr = atob(header);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

// ===================================================================
// POST /api/language/score-shadowing (audio + DeepSeek)
// ===================================================================

app.post("/score-shadowing", optionalClerkAuth, requireDeepseek, requireOpenai, async (c) => {
  const audioBuffer = new Uint8Array(await c.req.arrayBuffer());
  const targetText = decodeBase64Header(c.req.header("x-target-text") || "");
  const language = c.req.header("x-language") || "en-US";
  const targetLanguage = c.req.header("x-target-language") || "en-US";
  const audioFormat = c.req.header("x-audio-format") || "wav";

  if (!targetText) {
    return c.json(err("Missing x-target-text header"), 400);
  }

  try {
    // Run STT and prosody in parallel
    const [detailedTranscript, prosodyMetrics] = await Promise.all([
      speechToTextDetailed(audioBuffer, audioFormat, targetLanguage).catch(() => null),
      computeProsodyMetrics(audioBuffer),
    ]);

    const userTranscript = detailedTranscript?.text || "";
    const sttMetrics = detailedTranscript ? computeSttMetrics(detailedTranscript) : null;

    // LLM accuracy scoring
    const llmResponse = await deepseek.chat.completions.create({
      model: DEEPSEEK_MODEL,
      messages: [
        {
          role: "system",
          content: `You are a pronunciation evaluator for ${language}. Compare the target text with what the user actually said.
If there's a transcription, use it. Score ONLY content accuracy (did they say the right words?), not audio quality.
Return JSON:
{
  "score": 0-100,
  "feedback": "brief constructive feedback in Chinese",
  "mistakes": ["mispronounced or missed word patterns"],
  "praise": ["what they did well"],
  "targetAnnotations": [{ "start": 0, "end": 5, "text": "syllable-level annotation" }],
  "userAnnotations": [{ "start": 0, "end": 5, "text": "syllable-level annotation" }]
}`,
        },
        {
          role: "user",
          content: `Target text: "${targetText}"\nUser transcript: "${userTranscript || "[no transcript available]"}"\n\nPace evidence: ${sttMetrics ? `${sttMetrics.wordsPerSec.toFixed(1)} wps, ${sttMetrics.pauseCount} pauses` : "not available"}\nConfidence evidence: ${sttMetrics ? sttMetrics.meanConfidence.toFixed(2) : "not available"}`,
        },
      ],
      max_tokens: 2048,
      response_format: { type: "json_object" },
    });

    const llmResult = JSON.parse(llmResponse.choices[0].message.content || "{}");
    const llmAccuracy = llmResult.score ?? 70;

    // Blend signals
    const blended = scoreFromSignals({
      llmAccuracy,
      stt: sttMetrics,
      prosody: prosodyMetrics,
      language,
    });

    return c.json(
      ok({
        score: blended.score,
        accuracy: blended.accuracy,
        pace: blended.pace,
        confidence: blended.confidence,
        prosody: blended.prosody,
        fluency: blended.fluency,
        feedback: llmResult.feedback || "",
        mistakes: llmResult.mistakes || [],
        praise: llmResult.praise || [],
        targetAnnotations: llmResult.targetAnnotations || [],
        userAnnotations: llmResult.userAnnotations || [],
        userTranscript,
        lowConfidenceWords: sttMetrics?.lowConfidenceWords || [],
        prosodyAvailable: blended.prosodyAvailable,
        weights: blended.weights,
      }),
    );
  } catch (err) {
    return c.json(err("Scoring failed: " + (err as Error).message, 500), 500);
  }
});

// ===================================================================
// POST /api/language/score-recitation (JSON or audio + DeepSeek)
// ===================================================================

app.post("/score-recitation", optionalClerkAuth, requireDeepseek, async (c) => {
  const contentType = c.req.header("content-type") || "";
  let targetText = decodeBase64Header(c.req.header("x-target-text") || "");
  const language = c.req.header("x-language") || "en-US";
  const targetLanguage = c.req.header("x-target-language") || "en-US";

  let userTranscript = "";
  let sttMetrics = null;
  let prosodyMetrics = null;
  let audioAnalyzed = false;

  if (contentType.includes("application/json")) {
    // Text-only path
    const body = await c.req.json();
    userTranscript = body.transcribedText || "";
    targetText = targetText || body.targetText || "";
  } else {
    // Audio path
    if (!isOpenaiConfigured()) {
      return c.json(err("OpenAI not configured for audio analysis"), 503);
    }
    const audioBuffer = new Uint8Array(await c.req.arrayBuffer());
    const audioFormat = c.req.header("x-audio-format") || "wav";

    try {
      const [detailedTranscript, prosody] = await Promise.all([
        speechToTextDetailed(audioBuffer, audioFormat, targetLanguage).catch(() => null),
        computeProsodyMetrics(audioBuffer),
      ]);
      userTranscript = detailedTranscript?.text || "";
      sttMetrics = detailedTranscript ? computeSttMetrics(detailedTranscript) : null;
      prosodyMetrics = prosody;
      audioAnalyzed = true;
    } catch {
      // Audio analysis failed, continue with text-only scoring
    }
  }

  // LLM accuracy scoring
  const llmResponse = await deepseek.chat.completions.create({
    model: DEEPSEEK_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a recitation evaluator for ${language}. The user is trying to recite from memory.
Compare the target text with what they recalled. Focus on completeness and accuracy.
Return JSON:
{
  "score": 0-100,
  "completeness": 0-100,
  "accuracy": 0-100,
  "feedback": "brief feedback in Chinese about recall quality",
  "mistakes": ["missed or wrong parts"],
  "praise": ["what they recalled correctly"],
  "targetAnnotations": [{ "start": 0, "end": 5, "text": "..." }],
  "userAnnotations": [{ "start": 0, "end": 5, "text": "..." }]
}`,
      },
      {
        role: "user",
        content: `Target text: "${targetText}"\nUser recalled: "${userTranscript || "[not provided]"}"`,
      },
    ],
    max_tokens: 2048,
    response_format: { type: "json_object" },
  });

  const llmResult = JSON.parse(llmResponse.choices[0].message.content || "{}");

  const blended = scoreFromSignals({
    llmAccuracy: llmResult.accuracy ?? llmResult.score ?? 70,
    stt: sttMetrics,
    prosody: prosodyMetrics,
    language,
  });

  return c.json(
    ok({
      score: blended.score,
      accuracy: llmResult.accuracy ?? blended.accuracy,
      completeness: llmResult.completeness ?? 0,
      pace: blended.pace,
      confidence: blended.confidence,
      prosody: blended.prosody,
      prosodyAvailable: blended.prosodyAvailable,
      audioAnalyzed,
      fluency: blended.fluency,
      feedback: llmResult.feedback || "",
      mistakes: llmResult.mistakes || [],
      praise: llmResult.praise || [],
      targetAnnotations: llmResult.targetAnnotations || [],
      userAnnotations: llmResult.userAnnotations || [],
      userTranscript,
      lowConfidenceWords: sttMetrics?.lowConfidenceWords || [],
      weights: blended.weights,
    }),
  );
});

export default app;
