import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Platform,
  Alert,
  Modal,
  FlatList,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft, Check, ChevronDown, Edit3, RefreshCw, Save, Sparkles, Zap } from "lucide-react-native";
import { flipIfRTL, rtlTextStyle } from "@/utils/rtl";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { nextQuotaResetAt, todayDateKey, useApp } from "@/context/AppContext";
import { LANGUAGES } from "@/types";
import type { ContentType, Difficulty, LearningText, VocabularyItem } from "@/types";
import { detectContentType, isContentType } from "@/utils/contentType";
import { useT, getDifficultyLabel, TOPIC_KEYS } from "@/utils/i18n";
import { Icon } from "@/components/Icon";
import { useRewardedAd } from "@/hooks/useRewardedAd";
import { useGenerationQuota } from "@/hooks/useGenerationQuota";
import { PaywallModal } from "@/components/PaywallModal";
import { useAuth } from "@clerk/expo";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

interface DraftPayload {
  title: string;
  text: string;
  translation: string;
  vocabulary: VocabularyItem[];
  contentType: ContentType;
}

export default function GenerateScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const {
    addText,
    settings,
    isPro,
    generationLimit,
    generationsRemaining,
    canCreateArticle,
    incrementGenerationCount,
    syncGenerationQuota,
  } = useApp();
  const { getToken, isSignedIn } = useAuth();
  // The api-server now reads identity (and tier) from the verified
  // Clerk JWT instead of trusting client headers. This helper attaches
  // the bearer when the user is signed in; guests skip it and the
  // server treats them as a per-IP guest bucket.
  const buildAuthHeaders = async (): Promise<Record<string, string>> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (isSignedIn) {
      const token = await getToken().catch(() => null);
      if (token) headers["authorization"] = `Bearer ${token}`;
    }
    return headers;
  };
  const { show: showRewardedAd } = useRewardedAd("generation");
  const { requestRewardToken } = useGenerationQuota();
  const [quotaSheetOpen, setQuotaSheetOpen] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  // Pending ad-grant flow: while true, the "Watch ad" CTA is disabled and
  // shows a spinner so the user doesn't tap it twice.
  const [adInFlight, setAdInFlight] = useState(false);
  // Tracks which entry point opened the quota sheet so the shared
  // "watch ad" CTA can route the post-token retry back to the right
  // flow. AI generation and manual input share the same per-day cap
  // and the same sheet UI, so we need this state to know what to
  // re-attempt after a reward grant.
  const [quotaTrigger, setQuotaTrigger] = useState<"ai" | "manual">("ai");

  const nativeLanguage = settings.nativeLanguage;
  const [mode, setMode] = useState<"ai" | "manual">("ai");
  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>(settings.defaultDifficulty);
  const [targetLanguage, setTargetLanguage] = useState(settings.targetLanguage);
  const [manualText, setManualText] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);

  const targetLangObj = LANGUAGES.find((l) => l.code === targetLanguage) ?? LANGUAGES[1];
  const nativeLangObj = LANGUAGES.find((l) => l.code === nativeLanguage) ?? LANGUAGES[0];

  // Preview/edit phase
  const [draft, setDraft] = useState<DraftPayload | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftText, setDraftText] = useState("");
  const [draftTranslation, setDraftTranslation] = useState("");

  // Bidirectional sync state for the draft preview screen
  const [textSyncing, setTextSyncing] = useState(false);
  const [translationSyncing, setTranslationSyncing] = useState(false);
  const [textSyncError, setTextSyncError] = useState(false);
  const [translationSyncError, setTranslationSyncError] = useState(false);

  const draftTextRef = useRef("");
  const draftTranslationRef = useRef("");
  const lastSyncedTextRef = useRef("");
  const lastSyncedTranslationRef = useRef("");
  const focusedSideRef = useRef<"text" | "translation" | null>(null);
  const pendingResyncRef = useRef<"text" | "translation" | null>(null);
  const syncDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncReqIdRef = useRef(0);
  const targetLangRef = useRef(targetLangObj.english);
  const nativeLangRef = useRef(nativeLangObj.english);

  draftTextRef.current = draftText;
  draftTranslationRef.current = draftTranslation;
  targetLangRef.current = targetLangObj.english;
  nativeLangRef.current = nativeLangObj.english;

  useEffect(() => {
    return () => {
      if (syncDebounceRef.current) clearTimeout(syncDebounceRef.current);
      syncReqIdRef.current++;
    };
  }, []);

  const cancelPendingSync = () => {
    if (syncDebounceRef.current) {
      clearTimeout(syncDebounceRef.current);
      syncDebounceRef.current = null;
    }
    syncReqIdRef.current++;
    pendingResyncRef.current = null;
    setTextSyncing(false);
    setTranslationSyncing(false);
  };

  const handleSideBlur = (side: "text" | "translation") => {
    if (focusedSideRef.current === side) focusedSideRef.current = null;
    // If a sync was deferred because the user was editing this side,
    // re-run it now that they've moved away.
    const pending = pendingResyncRef.current;
    if (pending && pending !== side) {
      pendingResyncRef.current = null;
      scheduleSync(pending);
    }
  };

  const runSync = async (source: "text" | "translation") => {
    const sourceText = source === "text" ? draftTextRef.current : draftTranslationRef.current;
    const trimmed = sourceText.trim();
    if (!trimmed) return;
    if (source === "text" && trimmed === lastSyncedTextRef.current) return;
    if (source === "translation" && trimmed === lastSyncedTranslationRef.current) return;

    const reqId = ++syncReqIdRef.current;
    if (source === "text") {
      setTranslationSyncing(true);
      setTranslationSyncError(false);
    } else {
      setTextSyncing(true);
      setTextSyncError(false);
    }

    try {
      const fromLanguage = source === "text" ? targetLangRef.current : nativeLangRef.current;
      const toLanguage = source === "text" ? nativeLangRef.current : targetLangRef.current;
      const resp = await fetch(`${BASE_URL}/api/language/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed, fromLanguage, toLanguage }),
      });
      const result = (await resp.json()) as { success: boolean; data?: { translation?: string } };
      if (reqId !== syncReqIdRef.current) return; // superseded
      if (!result.success) throw new Error("translate failed");
      const out = (result.data?.translation ?? "").trim();
      if (!out) throw new Error("empty translation");

      if (source === "text") {
        if (focusedSideRef.current === "translation") {
          pendingResyncRef.current = "text";
          return;
        }
        lastSyncedTextRef.current = trimmed;
        lastSyncedTranslationRef.current = out;
        setDraftTranslation(out);
      } else {
        if (focusedSideRef.current === "text") {
          pendingResyncRef.current = "translation";
          return;
        }
        lastSyncedTranslationRef.current = trimmed;
        lastSyncedTextRef.current = out;
        setDraftText(out);
      }
    } catch {
      if (reqId !== syncReqIdRef.current) return;
      if (source === "text") {
        setTranslationSyncError(true);
        setTimeout(() => {
          if (reqId === syncReqIdRef.current) setTranslationSyncError(false);
        }, 2500);
      } else {
        setTextSyncError(true);
        setTimeout(() => {
          if (reqId === syncReqIdRef.current) setTextSyncError(false);
        }, 2500);
      }
    } finally {
      if (reqId === syncReqIdRef.current) {
        if (source === "text") setTranslationSyncing(false);
        else setTextSyncing(false);
      }
    }
  };

  const scheduleSync = (source: "text" | "translation") => {
    if (syncDebounceRef.current) clearTimeout(syncDebounceRef.current);
    // Bump the in-flight reqId so any not-yet-returned response is discarded
    syncReqIdRef.current++;
    if (source === "text") {
      setTranslationSyncing(false);
      setTranslationSyncError(false);
    } else {
      setTextSyncing(false);
      setTextSyncError(false);
    }
    syncDebounceRef.current = setTimeout(() => {
      syncDebounceRef.current = null;
      void runSync(source);
    }, 750);
  };

  const handleDraftTextChange = (v: string) => {
    setDraftText(v);
    scheduleSync("text");
  };

  const handleDraftTranslationChange = (v: string) => {
    setDraftTranslation(v);
    scheduleSync("translation");
  };

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  /**
   * Issue a single `/generate-text` request, optionally with a server-
   * issued bypass token. Returns:
   *   - `{ ok: true, payload }` on a successful generation
   *   - `{ ok: false, kind: "quota_exceeded", quota }` when the server
   *     reports the daily free limit is reached
   *   - `{ ok: false, kind: "error" }` on any other failure
   */
  type QuotaInfo = { limit: number; used: number; remaining: number };
  type GenerateAttempt =
    | { ok: true; payload: DraftPayload }
    | { ok: false; kind: "quota_exceeded"; quota?: QuotaInfo }
    | { ok: false; kind: "error" };

  const attemptGenerate = async (
    rewardToken?: string,
  ): Promise<GenerateAttempt> => {
    try {
      const headers = await buildAuthHeaders();
      if (rewardToken) headers["x-reward-token"] = rewardToken;
      // When the user taps "Regenerate" on the draft preview, we already
      // have a previous draft. Tell the server this is a retry and pass
      // the previous text so it can instruct the model to produce a
      // *different* article on the same topic instead of recomputing the
      // same one.
      const previous = draft;
      const isRetry = previous !== null;
      const response = await fetch(`${BASE_URL}/api/language/generate-text`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          topic,
          difficulty,
          language: LANGUAGES.find((l) => l.code === nativeLanguage)?.english ?? "English",
          // Send the dialect-explicit English label ("American English" /
          // "British English") so the server prompt forces the right
          // spelling/vocabulary. For non-English target languages the
          // localized name (e.g. "Español") is fine.
          targetLanguage: (() => {
            const lang = LANGUAGES.find((l) => l.code === targetLanguage);
            if (!lang) return "English";
            if (lang.code === "en-US" || lang.code === "en-GB") return lang.english;
            return lang.name;
          })(),
          ...(isRetry
            ? {
                regenerate: true,
                previousText: previous.text,
                previousTitle: previous.title,
              }
            : {}),
        }),
      });

      if (response.status === 429) {
        // Server enforced the daily quota. Surface the structured
        // payload to the caller so it can show the right CTA.
        const json = (await response.json().catch(() => null)) as
          | { error?: string; data?: QuotaInfo }
          | null;
        return { ok: false, kind: "quota_exceeded", quota: json?.data };
      }

      const result = (await response.json()) as { success: boolean; data: any };
      if (!result.success) return { ok: false, kind: "error" };

      const rawText = result.data.text ?? "";
      const declaredType = result.data.contentType as ContentType | undefined;
      const payload: DraftPayload = {
        title: result.data.title ?? topic,
        text: rawText,
        translation: result.data.translation ?? "",
        vocabulary: result.data.vocabulary ?? [],
        contentType: isContentType(declaredType) ? declaredType : detectContentType(rawText),
      };
      return { ok: true, payload };
    } catch {
      return { ok: false, kind: "error" };
    }
  };

  /**
   * Mirror of `attemptGenerate` for the manual-input path. The server's
   * `enforceGenerationQuota` middleware now sits in front of
   * `/language/process-manual` too, so this needs the same headers
   * (`x-user-id`, `x-tier`, optional `x-reward-token`) and the same
   * 429 / `quota_exceeded` shape so the caller can react identically
   * to the AI path.
   */
  type ManualAttempt =
    | {
        ok: true;
        data: { targetText: string; nativeText: string; difficulty: Difficulty };
      }
    | { ok: false; kind: "quota_exceeded"; quota?: QuotaInfo }
    | { ok: false; kind: "error" };

  const attemptManualProcess = async (
    inputText: string,
    rewardToken?: string,
  ): Promise<ManualAttempt> => {
    try {
      const headers = await buildAuthHeaders();
      if (rewardToken) headers["x-reward-token"] = rewardToken;
      const response = await fetch(`${BASE_URL}/api/language/process-manual`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          text: inputText,
          targetLanguage: targetLangObj.english,
          nativeLanguage: nativeLangObj.english,
        }),
      });
      if (response.status === 429) {
        const json = (await response.json().catch(() => null)) as
          | { error?: string; data?: QuotaInfo }
          | null;
        return { ok: false, kind: "quota_exceeded", quota: json?.data };
      }
      const result = (await response.json()) as {
        success: boolean;
        data?: { targetText?: string; nativeText?: string; difficulty?: Difficulty };
      };
      if (!result.success || !result.data) return { ok: false, kind: "error" };
      const allowedLevels: Difficulty[] = [
        "beginner",
        "elementary",
        "intermediate",
        "advanced",
      ];
      const detected = result.data.difficulty;
      const difficulty: Difficulty =
        detected && allowedLevels.includes(detected) ? detected : "intermediate";
      const targetText = result.data.targetText?.trim() || inputText;
      const nativeText = result.data.nativeText?.trim() ?? "";
      return { ok: true, data: { targetText, nativeText, difficulty } };
    } catch {
      return { ok: false, kind: "error" };
    }
  };

  const applyDraftPayload = (payload: DraftPayload) => {
    cancelPendingSync();
    lastSyncedTextRef.current = payload.text.trim();
    lastSyncedTranslationRef.current = payload.translation.trim();
    setTextSyncError(false);
    setTranslationSyncError(false);
    setDraft(payload);
    setDraftTitle(payload.title);
    setDraftText(payload.text);
    setDraftTranslation(payload.translation);
  };

  const handleGenerate = async () => {
    if (!topic.trim()) {
      Alert.alert(t("common.tip"), t("generate.alert.topicEmpty"));
      return;
    }

    // The "Regenerate" button in the draft preview reuses this handler.
    // Per task spec, refining an in-progress draft is a *retry* of the
    // same in-flight creation, not a brand-new one — it must NOT count
    // against today's quota and must NOT be blocked even when the user
    // is at the cap. The first creation already paid the slot; further
    // regenerations are free.
    const isRegenerate = draft !== null;

    if (!isRegenerate) {
      // Local pre-flight against the per-day quota. Skips a wasted round-
      // trip + lets the user immediately see the upgrade / watch-ad
      // sheet when they've already hit today's free cap. Pro users
      // always pass.
      const gate = canCreateArticle();
      if (!gate.allowed) {
        setQuotaTrigger("ai");
        setQuotaSheetOpen(true);
        return;
      }
    }

    setIsGenerating(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const attempt = await attemptGenerate();
      if (attempt.ok) {
        applyDraftPayload(attempt.payload);
        // Mirror the successful generation in our local quota counter so
        // the chip ticks down without waiting for a separate /quota
        // call. Skip on regenerate — see comment above.
        if (!isPro && !isRegenerate) await incrementGenerationCount();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        return;
      }
      if (attempt.kind === "quota_exceeded") {
        // Re-sync the local mirror with whatever the server says so the
        // chip & sheet are accurate even if our local count drifted.
        // Client and server share the same rollover (Asia/Shanghai 04:00
        // — see todayDateKey), so the date label here matches the
        // server's bucket without further relabeling.
        if (!isPro && attempt.quota) {
          await syncGenerationQuota({
            date: todayDateKey(),
            count: attempt.quota.used,
          });
        }
        setQuotaTrigger("ai");
        setQuotaSheetOpen(true);
        return;
      }
      Alert.alert(t("common.error"), t("generate.alert.failed"));
    } finally {
      setIsGenerating(false);
    }
  };

  /**
   * Shared post-rewarded-ad retry. The QuotaSheet's primary CTA invokes
   * this regardless of whether the sheet was opened from the AI flow or
   * the manual-input flow — `quotaTrigger` tells us which retry to run.
   * Both paths consume the same one-shot reward token via the server's
   * `enforceGenerationQuota` middleware.
   */
  const handleWatchAdForCreation = async () => {
    if (adInFlight) return;
    setAdInFlight(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const outcome = await showRewardedAd();
      if (outcome !== "rewarded") {
        // User dismissed the simulator early or the SDK couldn't fill —
        // leave the sheet open so they can retry or upgrade. We don't
        // surface a separate alert because the simulator is the UI.
        return;
      }
      const token = await requestRewardToken();
      if (!token) {
        Alert.alert(t("common.error"), t("ads.unavailable.message"));
        return;
      }
      // Close the sheet & retry the original creation transparently.
      setQuotaSheetOpen(false);
      if (quotaTrigger === "manual") {
        const ok = await runManualSave(token);
        if (ok) router.back();
        return;
      }
      // AI generation retry path.
      setIsGenerating(true);
      try {
        const retry = await attemptGenerate(token);
        if (retry.ok) {
          applyDraftPayload(retry.payload);
          // The server granted via the reward path — count as a billable
          // generation locally too so the user's "today" count stays in
          // sync with the server's audit log.
          if (!isPro) await incrementGenerationCount();
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } else {
          Alert.alert(t("common.error"), t("generate.alert.failed"));
        }
      } finally {
        setIsGenerating(false);
      }
    } finally {
      setAdInFlight(false);
    }
  };

  const handleConfirmDraft = async () => {
    if (!draft) return;
    if (!draftTitle.trim() || !draftText.trim()) {
      Alert.alert(t("common.tip"), t("generate.alert.titleTextEmpty"));
      return;
    }
    const finalText = draftText.trim();
    const text: LearningText = {
      id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
      title: draftTitle.trim(),
      text: finalText,
      translation: draftTranslation.trim(),
      vocabulary: draft.vocabulary,
      topic: topic || t("topic.custom"),
      difficulty,
      targetLanguage,
      nativeLanguage,
      createdAt: Date.now(),
      contentType: draft.contentType,
    };
    await addText(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  const handleDiscardDraft = () => {
    cancelPendingSync();
    lastSyncedTextRef.current = "";
    lastSyncedTranslationRef.current = "";
    setTextSyncError(false);
    setTranslationSyncError(false);
    focusedSideRef.current = null;
    setDraft(null);
    setDraftTitle("");
    setDraftText("");
    setDraftTranslation("");
  };

  /**
   * Server round-trip + local save for the manual-input path. Pulled
   * out of `handleManualSave` so the post-ad retry
   * (`handleWatchAdForCreation`) can re-run it with a reward token.
   * Returns true on success, false on any failure mode (quota / network /
   * server error). On `quota_exceeded` the quota sheet is opened
   * transparently here so the caller doesn't have to.
   */
  const runManualSave = async (rewardToken?: string): Promise<boolean> => {
    const inputText = manualText.trim();
    setIsTranslating(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const attempt = await attemptManualProcess(inputText, rewardToken);
      if (attempt.ok === false && attempt.kind === "quota_exceeded") {
        // Re-sync the local mirror with whatever the server says so the
        // chip & sheet are accurate even if our local count drifted.
        // Client and server share the same rollover (Asia/Shanghai 04:00
        // — see todayDateKey), so the date label here matches the
        // server's bucket without further relabeling.
        if (!isPro && attempt.quota) {
          await syncGenerationQuota({
            date: todayDateKey(),
            count: attempt.quota.used,
          });
        }
        setQuotaTrigger("manual");
        setQuotaSheetOpen(true);
        return false;
      }
      if (!attempt.ok) {
        Alert.alert(t("common.error"), t("generate.alert.failed"));
        return false;
      }
      const text: LearningText = {
        id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
        title: manualTitle.trim(),
        text: attempt.data.targetText,
        translation: attempt.data.nativeText,
        vocabulary: [],
        topic: t("topic.custom"),
        difficulty: attempt.data.difficulty,
        targetLanguage,
        nativeLanguage,
        createdAt: Date.now(),
        contentType: detectContentType(attempt.data.targetText),
      };
      await addText(text);
      // Count this manual save against today's quota — same TTS cost as
      // an AI-generated article. Pro users skip the counter entirely.
      // Even when the server consumed a reward token (so it didn't bump
      // its own count), we still tick the local mirror so the chip's
      // "X left today" stays in sync with the user's lived experience
      // of "I just created another article". Mirrors the AI path.
      if (!isPro) await incrementGenerationCount();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return true;
    } finally {
      setIsTranslating(false);
    }
  };

  const handleManualSave = async () => {
    if (!manualTitle.trim() || !manualText.trim()) {
      Alert.alert(t("common.tip"), t("generate.alert.manualEmpty"));
      return;
    }
    // Manual entries still trigger TTS for the saved article, so they
    // count against the same daily quota as AI-generated ones. Local
    // pre-flight to short-circuit a doomed network call; server is
    // still source of truth (see runManualSave's quota_exceeded branch).
    const gate = canCreateArticle();
    if (!gate.allowed) {
      setQuotaTrigger("manual");
      setQuotaSheetOpen(true);
      return;
    }
    const ok = await runManualSave();
    if (ok) router.back();
  };

  const inputStyle = { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground };
  const labelStyle = { color: colors.mutedForeground };

  // ============ DRAFT PREVIEW MODE ============
  if (draft) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { paddingTop: topPad + 12 }]}>
          <TouchableOpacity onPress={handleDiscardDraft} style={styles.backBtn} activeOpacity={0.7}>
            <ArrowLeft size={22} color={colors.foreground} style={flipIfRTL()} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>{t("generate.preview.headerTitle")}</Text>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[styles.content, { paddingBottom: Platform.OS === "web" ? 50 : insets.bottom + 40 }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.previewBanner, { backgroundColor: colors.primary + "15", borderColor: colors.primary + "40" }]}>
            <Edit3 size={14} color={colors.primary} />
            <Text style={[styles.previewBannerText, { color: colors.primary }]}>
              {t("generate.preview.banner")}
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, labelStyle]}>{t("generate.label.title")}</Text>
            <TextInput
              style={[styles.input, inputStyle]}
              value={draftTitle}
              onChangeText={setDraftTitle}
              placeholder={t("generate.placeholder.title")}
              placeholderTextColor={colors.mutedForeground}
            />
          </View>

          <View style={styles.field}>
            <View style={styles.labelRow}>
              <Text style={[styles.label, labelStyle]}>{t("generate.label.body")}</Text>
              {textSyncing ? (
                <View style={styles.syncBadge}>
                  <ActivityIndicator size="small" color={colors.mutedForeground} />
                  <Text style={[styles.syncBadgeText, { color: colors.mutedForeground }]}>
                    {t("generate.preview.syncing")}
                  </Text>
                </View>
              ) : textSyncError ? (
                <Text style={[styles.syncBadgeText, { color: colors.mutedForeground }]}>
                  {t("generate.preview.syncFailed")}
                </Text>
              ) : null}
            </View>
            <TextInput
              style={[styles.bigTextarea, inputStyle, rtlTextStyle(draftText)]}
              value={draftText}
              onChangeText={handleDraftTextChange}
              onFocus={() => { focusedSideRef.current = "text"; }}
              onBlur={() => handleSideBlur("text")}
              placeholder={t("generate.placeholder.text")}
              placeholderTextColor={colors.mutedForeground}
              multiline
              textAlignVertical="top"
            />
          </View>

          <View style={styles.field}>
            <View style={styles.labelRow}>
              <Text style={[styles.label, labelStyle]}>{t("generate.label.translation")}</Text>
              {translationSyncing ? (
                <View style={styles.syncBadge}>
                  <ActivityIndicator size="small" color={colors.mutedForeground} />
                  <Text style={[styles.syncBadgeText, { color: colors.mutedForeground }]}>
                    {t("generate.preview.syncing")}
                  </Text>
                </View>
              ) : translationSyncError ? (
                <Text style={[styles.syncBadgeText, { color: colors.mutedForeground }]}>
                  {t("generate.preview.syncFailed")}
                </Text>
              ) : null}
            </View>
            <TextInput
              style={[styles.textarea, inputStyle, rtlTextStyle(draftTranslation)]}
              value={draftTranslation}
              onChangeText={handleDraftTranslationChange}
              onFocus={() => { focusedSideRef.current = "translation"; }}
              onBlur={() => handleSideBlur("translation")}
              placeholder={t("generate.placeholder.translationOpt")}
              placeholderTextColor={colors.mutedForeground}
              multiline
              textAlignVertical="top"
            />
          </View>

          {draft.vocabulary.length > 0 && (
            <View style={styles.field}>
              <Text style={[styles.label, labelStyle]}>{t("generate.preview.vocab", { count: draft.vocabulary.length })}</Text>
              <View style={[styles.vocabPreview, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {draft.vocabulary.map((v, i) => (
                  <View
                    key={i}
                    style={[
                      styles.vocabRow,
                      i > 0 && { borderTopWidth: 1, borderTopColor: colors.border },
                    ]}
                  >
                    <Text style={[styles.vocabWord, { color: colors.foreground }]}>{v.word}</Text>
                    <Text style={[styles.vocabMeaning, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {v.meaning}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          <View style={styles.actionRow}>
            <TouchableOpacity
              onPress={handleGenerate}
              disabled={isGenerating}
              style={[styles.regenerateBtn, { borderColor: colors.border, opacity: isGenerating ? 0.6 : 1 }]}
              activeOpacity={0.85}
            >
              {isGenerating ? (
                <ActivityIndicator size="small" color={colors.foreground} />
              ) : (
                <RefreshCw size={16} color={colors.foreground} />
              )}
              <Text style={[styles.regenerateBtnText, { color: colors.foreground }]}>
                {isGenerating ? t("generate.btn.generating") : t("generate.preview.regenerate")}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={handleConfirmDraft}
              style={[styles.confirmBtn, { backgroundColor: colors.primary }]}
              activeOpacity={0.85}
            >
              <Check size={18} color="#fff" />
              <Text style={styles.confirmBtnText}>{t("generate.preview.confirm")}</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  // ============ FORM MODE (AI / MANUAL) ============
  // Tapping the chip surfaces a friendly hint of when the daily quota
  // will refill. Computed on demand — no live ticking countdown — since
  // a single dialog read is enough for users wondering "when can I
  // create more?". Reset moment comes from nextQuotaResetAt() so the
  // app and server can never disagree about it.
  const handleQuotaChipPress = () => {
    const reset = nextQuotaResetAt();
    const ms = Math.max(0, reset.getTime() - Date.now());
    const totalMin = Math.floor(ms / 60000);
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    // Local clock string in the user's own wall-clock — undefined locale
    // lets the platform pick the user's preferred 12h/24h format.
    const time = reset.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    const isTomorrowLocal =
      reset.toDateString() !== new Date().toDateString();
    const key = isTomorrowLocal
      ? "quota.gen.resetHint.tomorrow"
      : "quota.gen.resetHint.today";
    Alert.alert(
      t("quota.gen.resetHintTitle"),
      t(key, { hours, mins, time }),
    );
  };

  // Single source of truth for the "今日剩余 N/总数" chip — rendered in
  // both the AI and manual tabs so users can see the shared daily quota
  // before they start either flow. Hidden for Pro users.
  const quotaChip = !isPro ? (
    <TouchableOpacity
      onPress={handleQuotaChipPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={t("quota.gen.remaining", {
        n: generationsRemaining,
        total: generationLimit,
      })}
      accessibilityHint={t("quota.gen.resetHintTitle")}
      style={[
        styles.quotaChip,
        {
          backgroundColor:
            generationsRemaining === 0
              ? colors.destructive + "15"
              : colors.primary + "12",
          borderColor:
            generationsRemaining === 0
              ? colors.destructive + "55"
              : colors.primary + "33",
        },
      ]}
    >
      <Sparkles
        size={12}
        color={
          generationsRemaining === 0 ? colors.destructive : colors.primary
        }
      />
      <Text
        style={[
          styles.quotaChipText,
          {
            color:
              generationsRemaining === 0
                ? colors.destructive
                : colors.primary,
          },
        ]}
      >
        {t("quota.gen.remaining", {
          n: generationsRemaining,
          total: generationLimit,
        })}
      </Text>
    </TouchableOpacity>
  ) : null;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} activeOpacity={0.7}>
          <ArrowLeft size={22} color={colors.foreground} style={flipIfRTL()} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>{t("generate.title")}</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={styles.tabs}>
        {(["ai", "manual"] as const).map((m) => (
          <TouchableOpacity
            key={m}
            onPress={() => setMode(m)}
            style={[
              styles.tab,
              { backgroundColor: mode === m ? colors.primary : colors.muted },
            ]}
            activeOpacity={0.8}
          >
            <Icon
              name={m === "ai" ? "cpu" : "edit-3"}
              size={14}
              color={mode === m ? "#fff" : colors.mutedForeground}
            />
            <Text
              style={[
                styles.tabText,
                { color: mode === m ? "#fff" : colors.mutedForeground },
              ]}
            >
              {m === "ai" ? t("generate.tab.ai") : t("generate.tab.manual")}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.content, { paddingBottom: Platform.OS === "web" ? 50 : insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.field}>
          <Text style={[styles.label, labelStyle]}>{t("generate.label.targetLanguage")}</Text>
          <TouchableOpacity
            onPress={() => setTargetPickerOpen(true)}
            activeOpacity={0.85}
            style={[
              styles.dropdown,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.foreground, fontSize: 15, fontFamily: "Inter_600SemiBold" }}>
                {targetLangObj.name}
              </Text>
              <Text style={{ color: colors.mutedForeground, fontSize: 11, marginTop: 1 }}>
                {targetLangObj.english}
              </Text>
            </View>
            <ChevronDown size={18} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>

        {mode === "ai" ? (
          <>
            <View style={styles.field}>
              <Text style={[styles.label, labelStyle]}>{t("generate.label.difficulty")}</Text>
              <View style={styles.diffRow}>
                {(["beginner", "elementary", "intermediate", "advanced"] as Difficulty[]).map((d) => (
                  <TouchableOpacity
                    key={d}
                    onPress={() => setDifficulty(d)}
                    style={[
                      styles.diffChip,
                      {
                        backgroundColor: difficulty === d ? colors.primary : colors.muted,
                        flex: 1,
                      },
                    ]}
                  >
                    <Text style={{ color: difficulty === d ? "#fff" : colors.foreground, fontSize: 12, fontFamily: "Inter_500Medium", textAlign: "center" }}>
                      {getDifficultyLabel(d, nativeLanguage)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.field}>
              <Text style={[styles.label, labelStyle]}>{t("generate.label.topic")}</Text>
              <TextInput
                style={[styles.input, inputStyle]}
                value={topic}
                onChangeText={setTopic}
                placeholder={t("generate.placeholder.topic")}
                placeholderTextColor={colors.mutedForeground}
                returnKeyType="done"
              />
            </View>

            <View style={styles.field}>
              <Text style={[styles.label, labelStyle]}>{t("generate.label.quickPick")}</Text>
              <View style={styles.topicGrid}>
                {TOPIC_KEYS.map((tk) => {
                  const label = t(tk);
                  const isActive = topic === label;
                  return (
                    <TouchableOpacity
                      key={tk}
                      onPress={() => setTopic(label)}
                      style={[
                        styles.topicChip,
                        {
                          backgroundColor: isActive ? colors.secondary : colors.muted,
                          borderColor: isActive ? colors.primary : "transparent",
                        },
                      ]}
                    >
                      <Text style={{ color: isActive ? colors.primary : colors.foreground, fontSize: 13, fontFamily: "Inter_400Regular" }}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {quotaChip}

            <TouchableOpacity
              onPress={handleGenerate}
              disabled={isGenerating}
              style={[styles.generateBtn, { backgroundColor: colors.primary, opacity: isGenerating ? 0.7 : 1 }]}
              activeOpacity={0.85}
            >
              {isGenerating ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Zap size={18} color="#fff" />
                  <Text style={styles.generateBtnText}>{t("generate.btn.generate")}</Text>
                </>
              )}
            </TouchableOpacity>
          </>
        ) : (
          <>
            <View style={styles.field}>
              <Text style={[styles.label, labelStyle]}>{t("generate.label.title")}</Text>
              <TextInput
                style={[styles.input, inputStyle]}
                value={manualTitle}
                onChangeText={setManualTitle}
                placeholder={t("generate.placeholder.title")}
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            <View style={styles.field}>
              <Text style={[styles.label, labelStyle]}>{t("generate.label.manualText")}</Text>
              <TextInput
                style={[styles.textarea, inputStyle, rtlTextStyle(manualText)]}
                value={manualText}
                onChangeText={setManualText}
                placeholder={t("generate.placeholder.manualText")}
                placeholderTextColor={colors.mutedForeground}
                multiline
                textAlignVertical="top"
              />
              <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: -2 }}>
                {t("generate.manualNote", { target: targetLangObj.name })}
              </Text>
            </View>

            {quotaChip}

            <TouchableOpacity
              onPress={handleManualSave}
              disabled={isTranslating}
              style={[styles.generateBtn, { backgroundColor: colors.primary, opacity: isTranslating ? 0.7 : 1 }]}
              activeOpacity={0.85}
            >
              {isTranslating ? (
                <>
                  <ActivityIndicator color="#fff" />
                  <Text style={styles.generateBtnText}>{t("generate.btn.translatingSaving")}</Text>
                </>
              ) : (
                <>
                  <Save size={18} color="#fff" />
                  <Text style={styles.generateBtnText}>{t("generate.btn.save")}</Text>
                </>
              )}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>

      <Modal
        visible={quotaSheetOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setQuotaSheetOpen(false)}
      >
        <View style={styles.pickerOverlay}>
          <TouchableOpacity
            style={styles.pickerBackdrop}
            activeOpacity={1}
            onPress={() => !adInFlight && setQuotaSheetOpen(false)}
          />
          <View
            style={[
              styles.quotaSheet,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <View
              style={[
                styles.quotaSheetIcon,
                { backgroundColor: colors.primary + "1F" },
              ]}
            >
              <Sparkles size={26} color={colors.primary} />
            </View>
            <Text style={[styles.quotaSheetTitle, { color: colors.foreground }]}>
              {t("quota.gen.exceeded.title")}
            </Text>
            <Text
              style={[styles.quotaSheetBody, { color: colors.mutedForeground }]}
            >
              {t("quota.gen.exceeded.body", { total: generationLimit })}
            </Text>
            <TouchableOpacity
              onPress={handleWatchAdForCreation}
              disabled={adInFlight}
              activeOpacity={0.85}
              style={[
                styles.quotaSheetPrimary,
                { backgroundColor: colors.primary, opacity: adInFlight ? 0.6 : 1 },
              ]}
            >
              {adInFlight ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Sparkles size={16} color="#fff" />
              )}
              <Text style={styles.quotaSheetPrimaryText}>
                {t("quota.gen.watchAd")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setQuotaSheetOpen(false);
                setPaywallOpen(true);
              }}
              disabled={adInFlight}
              activeOpacity={0.85}
              style={styles.quotaSheetSecondary}
            >
              <Text
                style={[
                  styles.quotaSheetSecondaryText,
                  { color: colors.primary },
                ]}
              >
                {t("ads.upgradeCta")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setQuotaSheetOpen(false)}
              disabled={adInFlight}
              activeOpacity={0.85}
              style={styles.quotaSheetSecondary}
            >
              <Text
                style={[
                  styles.quotaSheetSecondaryText,
                  { color: colors.mutedForeground },
                ]}
              >
                {t("ads.dismiss")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <PaywallModal visible={paywallOpen} onClose={() => setPaywallOpen(false)} />

      <Modal
        visible={targetPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setTargetPickerOpen(false)}
      >
        <View style={styles.pickerOverlay}>
          <TouchableOpacity
            style={styles.pickerBackdrop}
            activeOpacity={1}
            onPress={() => setTargetPickerOpen(false)}
          />
          <View style={[styles.pickerCard, { backgroundColor: colors.card }]}>
            <Text style={[styles.pickerTitle, { color: colors.foreground }]}>
              {t("generate.picker.title")}
            </Text>
            <FlatList
              data={LANGUAGES
                .filter((l) => l.code !== nativeLanguage)
                .slice()
                .sort((a, b) => a.english.localeCompare(b.english))}
              keyExtractor={(l) => l.code}
              style={{ maxHeight: 380 }}
              renderItem={({ item: lang }) => {
                const selected = lang.code === targetLanguage;
                return (
                  <TouchableOpacity
                    onPress={() => {
                      setTargetLanguage(lang.code);
                      setTargetPickerOpen(false);
                    }}
                    style={[
                      styles.pickerRow,
                      { borderBottomColor: colors.border },
                      selected && { backgroundColor: colors.primary + "15" },
                    ]}
                    activeOpacity={0.7}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{
                        color: selected ? colors.primary : colors.foreground,
                        fontSize: 15,
                        fontFamily: selected ? "Inter_600SemiBold" : "Inter_500Medium",
                      }}>
                        {lang.name}
                      </Text>
                      <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 1 }}>
                        {lang.english}
                      </Text>
                    </View>
                    {selected && (
                      <Check size={18} color={colors.primary} />
                    )}
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
  },
  tabs: {
    flexDirection: "row",
    marginHorizontal: 20,
    marginBottom: 16,
    gap: 8,
  },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
  },
  tabText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  content: {
    paddingHorizontal: 20,
    gap: 16,
  },
  row: {
    flexDirection: "row",
    gap: 12,
  },
  field: {
    gap: 8,
  },
  label: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.3,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  syncBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  syncBadgeText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  langScroll: {
    flexGrow: 0,
  },
  dropdown: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  pickerOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  pickerBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  pickerCard: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 4,
    gap: 8,
  },
  pickerTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  langChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    marginRight: 8,
  },
  diffRow: {
    flexDirection: "row",
    gap: 6,
  },
  diffChip: {
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  textarea: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    minHeight: 120,
  },
  bigTextarea: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    minHeight: 200,
    lineHeight: 22,
  },
  topicGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  topicChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  generateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    borderRadius: 14,
    marginTop: 8,
  },
  generateBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  previewBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  previewBannerText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    flex: 1,
    lineHeight: 17,
  },
  vocabPreview: {
    borderWidth: 1,
    borderRadius: 10,
    overflow: "hidden",
  },
  vocabRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 10,
    gap: 10,
  },
  vocabWord: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  vocabMeaning: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    flex: 1,
    textAlign: "right",
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  regenerateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  regenerateBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  confirmBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
  },
  confirmBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  quotaChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  quotaChipText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  quotaSheet: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 18,
    borderWidth: 1,
    paddingVertical: 22,
    paddingHorizontal: 22,
    alignItems: "center",
    gap: 10,
  },
  quotaSheetIcon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  quotaSheetTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  quotaSheetBody: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 19,
    marginBottom: 6,
  },
  quotaSheetPrimary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    width: "100%",
    paddingVertical: 13,
    borderRadius: 12,
  },
  quotaSheetPrimaryText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  quotaSheetSecondary: {
    paddingVertical: 8,
  },
  quotaSheetSecondaryText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
});
