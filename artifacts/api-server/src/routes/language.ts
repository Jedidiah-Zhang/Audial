import { Router, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import {
  deepseek,
  DEEPSEEK_MODEL,
  isDeepseekConfigured,
} from "@workspace/integrations-openai-ai-server/deepseek";
import {
  textToSpeech,
  speechToText,
  ensureCompatibleFormat,
  isOpenaiConfigured,
  OpenAINotConfiguredError,
} from "@workspace/integrations-openai-ai-server/audio";

const router = Router();

router.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

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
  date: string; // YYYY-MM-DD (UTC)
  count: number;
}

const generationQuota = new Map<string, QuotaEntry>();
const rewardTokens = new Map<string, { userId: string; expiresAt: number }>();

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function readUserId(req: { headers: Record<string, unknown> }): string {
  const raw = req.headers["x-user-id"];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return "anonymous";
}

function readTier(req: { headers: Record<string, unknown> }): "free" | "pro" {
  const raw = req.headers["x-tier"];
  return typeof raw === "string" && raw.toLowerCase() === "pro" ? "pro" : "free";
}

function getQuota(userId: string): QuotaEntry {
  const today = todayKey();
  const existing = generationQuota.get(userId);
  if (!existing || existing.date !== today) {
    const fresh = { date: today, count: 0 };
    generationQuota.set(userId, fresh);
    return fresh;
  }
  return existing;
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
  const tier = readTier(req as never);
  if (tier === "pro") {
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
  const entry = getQuota(userId);
  if (entry.count >= FREE_DAILY_GENERATION_LIMIT) {
    res.status(429).json({
      success: false,
      error: "quota_exceeded",
      message: `Free tier limited to ${FREE_DAILY_GENERATION_LIMIT} generations per day. Watch a rewarded ad for one more, or upgrade to Pro.`,
      data: {
        limit: FREE_DAILY_GENERATION_LIMIT,
        used: entry.count,
        remaining: 0,
        resetDate: entry.date,
      },
    });
    return;
  }
  // Increment now: a successful enqueue counts against quota even if the
  // upstream LLM call later errors. This avoids a "free retry" path where
  // an aborted call lets the user retry endlessly past the limit.
  entry.count += 1;
  next();
};

router.get("/language/quota", (req, res) => {
  const tier = readTier(req as never);
  const userId = readUserId(req as never);
  if (tier === "pro") {
    res.json({
      success: true,
      data: {
        tier: "pro",
        limit: null,
        used: 0,
        remaining: null,
        resetDate: todayKey(),
      },
    });
    return;
  }
  const entry = getQuota(userId);
  res.json({
    success: true,
    data: {
      tier: "free",
      limit: FREE_DAILY_GENERATION_LIMIT,
      used: entry.count,
      remaining: Math.max(0, FREE_DAILY_GENERATION_LIMIT - entry.count),
      resetDate: entry.date,
    },
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
        "OpenAI 未配置：请到 https://platform.openai.com 申请 API key，然后将其添加为 Replit Secret OPENAI_API_KEY 后重启服务（OpenAI is not configured: set OPENAI_API_KEY and restart the server）",
    });
    return;
  }
  next();
};

router.post("/language/generate-text", requireDeepseek, enforceGenerationQuota, async (req, res) => {
  try {
    const { topic, difficulty, language, targetLanguage } = req.body as {
      topic: string;
      difficulty: string;
      language: string;
      targetLanguage: string;
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

    const systemPrompt = `You are a language learning content creator. Generate authentic, natural-sounding ${targetLanguage} text that a native speaker would actually say or write. The text should be at ${levelDesc}. The topic is: ${topic}.${dialectInstruction}

Format your response as JSON with these fields:
- "text": the main text in ${targetLanguage}
- "translation": translation in ${language}
- "title": a short title for the text (in ${targetLanguage})
- "contentType": classify the writing **by its actual content and intent, not just its formatting**. Choose ONE of:
    - "dialogue": a back-and-forth conversation between two or more speakers. Format text with one turn per line as "SpeakerName: utterance".
    - "news": a news report or journalistic piece (lede, reporting style, third-person factual tone). Separate paragraphs with a blank line.
    - "email": an email message (has greeting like "Hi X,", a body, and a sign-off; conversational but written; may include subject as the first line "Subject: ...").
    - "letter": a formal or personal written letter (date, salutation like "Dear X,", body, formal closing like "Sincerely, ..."). Separate paragraphs with a blank line.
    - "speech": a spoken address or speech meant to be delivered to an audience (rhetorical, addressing "you" / the audience, often inspirational, persuasive, or ceremonial).
    - "story": a short narrative or story (characters, plot, scenes).
    - "essay": an opinion piece, argumentative or reflective essay.
    - "general": none of the above clearly fits.
  Always prefer the content-based classification over surface formatting.
- "vocabulary": array of 5-8 key vocabulary items, each with:
  - "word": the word in ${targetLanguage}
  - "pronunciation": IPA or romanization if applicable
  - "partOfSpeech": short tag like "n.", "v.", "adj.", "adv.", "phrase" (in English)
  - "meaning": the meaning in ${language}
  - "example": a NEW natural example sentence in ${targetLanguage} that uses this word (different from the main text)
  - "exampleTranslation": translation of the example sentence in ${language}

Make the text feel like something a real native speaker would say - not textbook language. Use natural expressions and colloquialisms appropriate for the level.`;

    const response = await deepseek.chat.completions.create({
      model: DEEPSEEK_MODEL,
      max_completion_tokens: 2048,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Generate a ${difficulty} level text about: ${topic}` },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    const data = JSON.parse(content);
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

    const content = response.choices[0]?.message?.content ?? "{}";
    const data = JSON.parse(content);
    res.json({ success: true, data });
  } catch (err) {
    req.log.error({ err }, "Translate failed");
    res.status(500).json({ success: false, error: "Translate failed" });
  }
});

router.post("/language/process-manual", requireDeepseek, async (req, res) => {
  try {
    const { text, targetLanguage, nativeLanguage } = req.body as {
      text: string;
      targetLanguage: string;
      nativeLanguage: string;
    };

    if (!text || !text.trim()) {
      res.status(400).json({ success: false, error: "Empty text" });
      return;
    }

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

Return JSON only:
{
  "targetText": "...",      // text in ${targetLanguage}
  "nativeText": "...",      // text in ${nativeLanguage}
  "difficulty": "beginner" | "elementary" | "intermediate" | "advanced"
}`,
        },
        { role: "user", content: text },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    const data = JSON.parse(content);
    const allowed = ["beginner", "elementary", "intermediate", "advanced"];
    const difficulty = allowed.includes(data.difficulty) ? data.difficulty : "intermediate";
    res.json({
      success: true,
      data: {
        targetText: typeof data.targetText === "string" ? data.targetText : text,
        nativeText: typeof data.nativeText === "string" ? data.nativeText : "",
        difficulty,
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

    const content = response.choices[0]?.message?.content ?? "{}";
    const data = JSON.parse(content);
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

router.post("/language/stt", requireOpenai, async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const audioBuffer = Buffer.concat(chunks);
        const { buffer, format } = await ensureCompatibleFormat(audioBuffer);
        const transcript = await speechToText(buffer, format);
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
    const { targetText, transcribedText, language } = req.body as {
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
- "feedback": 1-2 sentences of constructive feedback in the user's native language (${language})
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

    const content = response.choices[0]?.message?.content ?? "{}";
    const data = JSON.parse(content);
    res.json({ success: true, data });
  } catch (err) {
    req.log.error({ err }, "Score pronunciation failed");
    res.status(500).json({ success: false, error: "Scoring failed" });
  }
});

router.post("/language/score-dictation", requireDeepseek, async (req, res) => {
  try {
    const { targetText, userText, language } = req.body as {
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
- "feedback": 1-2 sentences of constructive feedback in ${language}
- "corrections": array of objects {wrong: string, correct: string} showing what was wrong (max 5)
- "wordAccuracy": percentage of words spelled correctly
- "userAnnotations": array of {"word": string, "status": "ok" | "wrong" | "extra", "correct"?: string} that tokenizes the user's writing in original order. Use "wrong" for misspelled or wrong words (include the suggested correction in "correct"), "extra" for words the user wrote that aren't in the target, "ok" otherwise.
- "targetAnnotations": array of {"word": string, "status": "ok" | "wrong" | "missed"} that tokenizes the target text in original order. Use "missed" for words the user omitted, "wrong" for words the user spelled or replaced incorrectly, "ok" otherwise.
The concatenation of all words in each array MUST exactly reproduce the original sentence (include punctuation as its own token or attached to the previous word). For non-spaced languages, tokenize at word/character boundaries that preserve readability when concatenated without spaces.`,
        },
        {
          role: "user",
          content: `Target: "${targetText}"\nUser wrote: "${userText}"`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    const data = JSON.parse(content);
    res.json({ success: true, data });
  } catch (err) {
    req.log.error({ err }, "Score dictation failed");
    res.status(500).json({ success: false, error: "Scoring failed" });
  }
});

router.post("/language/score-recitation", requireDeepseek, async (req, res) => {
  try {
    const { targetText, transcribedText, language } = req.body as {
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
          content: `You are a language recitation judge. The user was supposed to recite a text from memory. Compare what they said vs the target. Return JSON with:
- "score": 0-100 memory accuracy score
- "feedback": 1-2 sentences of constructive feedback in ${language}
- "completeness": percentage of the text they covered
- "fluency": "excellent" | "good" | "fair" | "needs_work"
- "encouragement": a motivating closing sentence
- "targetAnnotations": array of {"word": string, "status": "ok" | "wrong" | "missed"} that tokenizes the target text in original order. Use "missed" for parts the user did NOT recite (forgot), "wrong" for parts they recited incorrectly, "ok" otherwise.
- "userAnnotations": array of {"word": string, "status": "ok" | "wrong"} that tokenizes the transcript in original order. Use "wrong" for clearly off-topic or invented words that don't belong in the target, "ok" otherwise.
The concatenation of all words MUST exactly reproduce the original sentence (include punctuation as its own token or attached to the previous word). For non-spaced languages, tokenize at word/character boundaries that preserve readability when concatenated without spaces.`,
        },
        {
          role: "user",
          content: `Target: "${targetText}"\nUser said: "${transcribedText}"`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    const data = JSON.parse(content);
    res.json({ success: true, data });
  } catch (err) {
    req.log.error({ err }, "Score recitation failed");
    res.status(500).json({ success: false, error: "Scoring failed" });
  }
});

export default router;
