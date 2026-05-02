import { Router, type RequestHandler } from "express";
import {
  deepseek,
  DEEPSEEK_MODEL,
  isDeepseekConfigured,
} from "@workspace/integrations-openai-ai-server/deepseek";
import {
  textToSpeech,
  speechToText,
  ensureCompatibleFormat,
} from "@workspace/integrations-openai-ai-server/audio";

const router = Router();

router.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
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

router.post("/language/generate-text", requireDeepseek, async (req, res) => {
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

    const systemPrompt = `You are a language learning content creator. Generate authentic, natural-sounding ${targetLanguage} text that a native speaker would actually say or write. The text should be at ${levelDesc}. The topic is: ${topic}.

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

router.post("/language/tts", async (req, res) => {
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
    req.log.error({ err }, "TTS failed");
    res.status(500).json({ success: false, error: "TTS generation failed" });
  }
});

router.post("/language/stt", async (req, res) => {
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
      max_completion_tokens: 512,
      messages: [
        {
          role: "system",
          content: `You are a language pronunciation and reading accuracy judge. Compare the target text with what was transcribed from the user's speech recording. Return JSON with:
- "score": 0-100 accuracy score
- "feedback": 1-2 sentences of constructive feedback in the user's native language (${language})
- "mistakes": array of specific words/phrases that were wrong or missing (max 3)
- "praise": one specific thing they did well`,
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
      max_completion_tokens: 512,
      messages: [
        {
          role: "system",
          content: `You are a language dictation judge. Compare the target text with the user's written response. Return JSON with:
- "score": 0-100 accuracy score (penalize spelling errors, missing words, wrong words)
- "feedback": 1-2 sentences of constructive feedback in ${language}
- "corrections": array of objects {wrong: string, correct: string} showing what was wrong (max 5)
- "wordAccuracy": percentage of words spelled correctly`,
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
      max_completion_tokens: 512,
      messages: [
        {
          role: "system",
          content: `You are a language recitation judge. The user was supposed to recite a text from memory. Compare what they said vs the target. Return JSON with:
- "score": 0-100 memory accuracy score
- "feedback": 1-2 sentences of constructive feedback in ${language}
- "completeness": percentage of the text they covered
- "fluency": "excellent" | "good" | "fair" | "needs_work"
- "encouragement": a motivating closing sentence`,
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
