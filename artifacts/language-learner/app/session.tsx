import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Platform,
  Alert,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft, ArrowRight, BookOpen, Check, EyeOff, Headphones, RefreshCw, Square, Target } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { useAudioRecorder, transcribeAudio } from "@/hooks/useAudio";
import { AudioWaveform } from "@/components/AudioWaveform";
import { ScoreCard } from "@/components/ScoreCard";
import { SentenceArticle } from "@/components/SentenceArticle";
import { STAGES, STAGE_PASS_SCORE } from "@/types";
import type { LearningMode } from "@/types";
import { useT, getStageName, getStageDesc } from "@/utils/i18n";
import { Icon, type IconName } from "@/components/Icon";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

type SessionPhase =
  | "intro"
  | "study"
  | "memorize"
  | "recording"
  | "transcribing"
  | "scoring"
  | "result";

export default function SessionScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const { id, stage: stageParam } = useLocalSearchParams<{ id: string; stage: string }>();
  const { texts, addResult, settings } = useApp();
  const { startRecording, stopRecording, isRecording } = useAudioRecorder();
  const lang = settings.nativeLanguage;

  const stageIdx = parseInt(stageParam ?? "0", 10);
  const stage = STAGES[stageIdx] ?? STAGES[0];
  const text = texts.find((x) => x.id === id);

  const [phase, setPhase] = useState<SessionPhase>("intro");
  const [dictationInput, setDictationInput] = useState("");
  const [result, setResult] = useState<{ score: number; feedback: string; details: Record<string, string | number>; passed: boolean } | null>(null);
  const [memorizeCountdown, setMemorizeCountdown] = useState(30);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 50 : insets.bottom + 20;

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

  const handleBeginPractice = () => {
    if (stageIdx === 2) {
      setPhase("memorize");
      setMemorizeCountdown(30);
      countdownRef.current = setInterval(() => {
        setMemorizeCountdown((n) => {
          if (n <= 1) {
            clearInterval(countdownRef.current!);
            setPhase("study");
            return 0;
          }
          return n - 1;
        });
      }, 1000);
    } else {
      setPhase("study");
    }
  };

  const handleRecord = async () => {
    if (isRecording) {
      setPhase("transcribing");
      const blob = await stopRecording();
      if (!blob) {
        setPhase("study");
        return;
      }
      try {
        const transcript = await transcribeAudio(blob);
        await scoreAnswer(transcript);
      } catch {
        Alert.alert(t("common.error"), t("session.alert.transcribeFailed"));
        setPhase("study");
      }
    } else {
      const started = await startRecording();
      if (!started) {
        Alert.alert(t("common.tip"), t("session.alert.micPermission"));
        return;
      }
      setPhase("recording");
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  };

  const scoreAnswer = async (transcribedOrTyped: string) => {
    if (!text) return;
    setPhase("scoring");

    try {
      const mode = stage.mode as LearningMode;
      const endpoint =
        stageIdx === 0
          ? "/api/language/score-pronunciation"
          : stageIdx === 1
          ? "/api/language/score-dictation"
          : "/api/language/score-recitation";

      const body =
        stageIdx === 1
          ? { targetText: text.text, userText: transcribedOrTyped, language: text.targetLanguage }
          : { targetText: text.text, transcribedText: transcribedOrTyped, language: text.targetLanguage };

      const response = await fetch(`${BASE_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const json = await response.json() as { success: boolean; data: any };
      if (!json.success) throw new Error("Scoring failed");

      const d = json.data;
      const details: Record<string, string | number> = {};

      if (stageIdx === 0 && d.mistakes?.length) {
        details[t("session.detail.mistakes")] = d.mistakes.join(", ");
      }
      if (stageIdx === 1 && d.wordAccuracy) {
        details[t("session.detail.wordAccuracy")] = `${d.wordAccuracy}%`;
      }
      if (stageIdx === 2) {
        details[t("session.detail.coverage")] = `${d.completeness ?? 0}%`;
        const fluencyKey = `fluency.${d.fluency}`;
        details[t("session.detail.fluency")] = d.fluency ? t(fluencyKey) : "";
      }

      const score = d.score ?? 0;
      const passed = score >= STAGE_PASS_SCORE;

      await addResult({
        id: Date.now().toString() + Math.random().toString(36).substr(2, 6),
        textId: text.id,
        mode: mode as LearningMode,
        stage: stageIdx,
        score,
        feedback: d.feedback ?? "",
        createdAt: Date.now(),
        details,
      });

      setResult({ score, feedback: d.feedback ?? "", details, passed });
      Haptics.notificationAsync(
        passed ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning
      );
      setPhase("result");
    } catch {
      Alert.alert(t("common.error"), t("session.alert.scoreFailed"));
      setPhase("study");
    }
  };

  const handleDictationSubmit = async () => {
    if (!dictationInput.trim()) {
      Alert.alert(t("common.tip"), t("session.alert.dictationEmpty"));
      return;
    }
    await scoreAnswer(dictationInput.trim());
  };

  const handleRetry = () => {
    setResult(null);
    setDictationInput("");
    setPhase("intro");
  };

  const handleNextStage = () => {
    router.back();
  };

  if (!text) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.foreground, padding: 20 }}>{t("home.notFound")}</Text>
      </View>
    );
  }

  const stageColor = stage.color;
  const isLastStage = stageIdx === STAGES.length - 1;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} activeOpacity={0.7}>
          <ArrowLeft size={22} color={colors.foreground} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerStage, { color: stageColor }]}>
            {t("card.stage", { n: stageIdx + 1, name: getStageName(stageIdx, lang) })}
          </Text>
          <Text style={[styles.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
            {text.title}
          </Text>
        </View>
        <View style={{ width: 36 }} />
      </View>

      <View style={[styles.progressBar, { backgroundColor: colors.border }]}>
        <View
          style={[
            styles.progressFill,
            {
              backgroundColor: stageColor,
              width: `${((stageIdx + 1) / STAGES.length) * 100}%`,
            },
          ]}
        />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {phase === "intro" && (
          <View style={styles.section}>
            <View style={[styles.introCard, { backgroundColor: colors.card, borderColor: stageColor + "40", borderWidth: 2 }]}>
              <View style={[styles.introBadge, { backgroundColor: stageColor + "20" }]}>
                <Icon name={stage.icon as any} size={36} color={stageColor} />
              </View>
              <Text style={[styles.introLabel, { color: stageColor }]}>
                {t("practice.stageNum", { n: stageIdx + 1 })}
              </Text>
              <Text style={[styles.introTitle, { color: colors.foreground }]}>{getStageName(stageIdx, lang)}</Text>
              <Text style={[styles.introDesc, { color: colors.mutedForeground }]}>
                {getStageDesc(stageIdx, lang)}
              </Text>
              {stage.needsScore && (
                <View style={[styles.thresholdTag, { backgroundColor: colors.muted }]}>
                  <Target size={12} color={colors.mutedForeground} />
                  <Text style={[styles.thresholdText, { color: colors.mutedForeground }]}>
                    {t("session.intro.passRule", { n: STAGE_PASS_SCORE })}
                  </Text>
                </View>
              )}
              <TouchableOpacity
                onPress={handleBeginPractice}
                style={[styles.startBtn, { backgroundColor: stageColor }]}
                activeOpacity={0.85}
              >
                <Text style={styles.startBtnText}>{t("session.intro.start")}</Text>
                <ArrowRight size={18} color="#fff" />
              </TouchableOpacity>
            </View>

            <View style={[styles.textPreview, { backgroundColor: colors.muted }]}>
              <Text style={[styles.textPreviewLabel, { color: colors.mutedForeground }]}>{t("session.intro.previewLabel")}</Text>
              <Text style={[styles.textPreviewContent, { color: colors.foreground }]} numberOfLines={5}>
                {text.text}
              </Text>
            </View>
          </View>
        )}

        {phase === "memorize" && stageIdx === 2 && (
          <View style={styles.section}>
            <View style={[styles.countdownCard, { backgroundColor: stageColor + "15", borderColor: stageColor + "40", borderWidth: 2 }]}>
              <Text style={[styles.countdownNum, { color: stageColor }]}>{memorizeCountdown}</Text>
              <Text style={[styles.countdownLabel, { color: colors.mutedForeground }]}>{t("session.memorize.subtitle")}</Text>
            </View>
            <SentenceArticle
              text={text.text}
              voice={settings.preferredVoice}
              accentColor={stageColor}
              contentType={text.contentType}
              articleId={text.id}
            />
            <Text style={[styles.memorizeHint, { color: colors.mutedForeground }]}>
              {t("session.memorize.hint")}
            </Text>
          </View>
        )}

        {phase === "study" && stageIdx === 0 && (
          <View style={styles.section}>
            <SentenceArticle
              text={text.text}
              voice={settings.preferredVoice}
              accentColor={stageColor}
              contentType={text.contentType}
              articleId={text.id}
            />

            <View style={styles.recordSection}>
              <TouchableOpacity
                onPress={handleRecord}
                style={[styles.recordBtn, {
                  backgroundColor: isRecording ? "#EF4444" : stageColor,
                  shadowColor: isRecording ? "#EF4444" : stageColor,
                }]}
                activeOpacity={0.85}
              >
                <Icon name={isRecording ? "square" : "mic"} size={32} color="#fff" />
              </TouchableOpacity>
              <Text style={[styles.recordHint, { color: colors.mutedForeground }]}>
                {isRecording ? t("session.shadow.stopHint") : t("session.shadow.recordHint")}
              </Text>
              {isRecording && <AudioWaveform isActive color="#EF4444" />}
            </View>
          </View>
        )}

        {phase === "study" && stageIdx === 1 && (
          <View style={styles.section}>
            <View style={[styles.hiddenCard, { backgroundColor: colors.muted }]}>
              <EyeOff size={28} color={colors.mutedForeground} />
              <Text style={[styles.hiddenTitle, { color: colors.foreground }]}>{t("session.dictation.hiddenTitle")}</Text>
              <Text style={[styles.hiddenSubtitle, { color: colors.mutedForeground }]}>
                {t("session.dictation.hiddenSub")}
              </Text>
            </View>

            <SentenceArticle
              text={text.text}
              voice={settings.preferredVoice}
              accentColor={stageColor}
              visible={false}
              contentType={text.contentType}
              articleId={text.id}
            />

            <View style={[styles.dictationBox, { backgroundColor: colors.card, borderColor: stageColor }]}>
              <Text style={[styles.dictationLabel, { color: colors.mutedForeground }]}>{t("session.dictation.label")}</Text>
              <TextInput
                style={[styles.dictationInput, { color: colors.foreground }]}
                value={dictationInput}
                onChangeText={setDictationInput}
                placeholder={t("session.dictation.placeholder")}
                placeholderTextColor={colors.mutedForeground}
                multiline
                textAlignVertical="top"
                autoCorrect={false}
              />
            </View>
            <TouchableOpacity
              onPress={handleDictationSubmit}
              disabled={!dictationInput.trim()}
              style={[styles.submitBtn, {
                backgroundColor: stageColor,
                opacity: dictationInput.trim() ? 1 : 0.4,
              }]}
              activeOpacity={0.85}
            >
              <Check size={20} color="#fff" />
              <Text style={styles.submitBtnText}>{t("session.dictation.submit")}</Text>
            </TouchableOpacity>
          </View>
        )}

        {phase === "study" && stageIdx === 2 && (
          <View style={styles.section}>
            <View style={[styles.hiddenCard, { backgroundColor: colors.muted }]}>
              <BookOpen size={28} color={colors.mutedForeground} />
              <Text style={[styles.hiddenTitle, { color: colors.foreground }]}>{t("session.recite.title")}</Text>
              <Text style={[styles.hiddenSubtitle, { color: colors.mutedForeground }]}>
                {t("session.recite.sub")}
              </Text>
            </View>

            <View style={styles.recordSection}>
              <TouchableOpacity
                onPress={handleRecord}
                style={[styles.recordBtn, {
                  backgroundColor: isRecording ? "#EF4444" : stageColor,
                  shadowColor: isRecording ? "#EF4444" : stageColor,
                }]}
                activeOpacity={0.85}
              >
                <Icon name={isRecording ? "square" : "mic"} size={32} color="#fff" />
              </TouchableOpacity>
              <Text style={[styles.recordHint, { color: colors.mutedForeground }]}>
                {isRecording ? t("session.shadow.stopHint") : t("session.recite.startHint")}
              </Text>
              {isRecording && <AudioWaveform isActive color="#EF4444" />}
            </View>
          </View>
        )}

        {phase === "recording" && (
          <View style={[styles.section, styles.centerSection]}>
            <AudioWaveform isActive color="#EF4444" barCount={9} />
            <TouchableOpacity
              onPress={handleRecord}
              style={[styles.recordBtn, { backgroundColor: "#EF4444", shadowColor: "#EF4444" }]}
              activeOpacity={0.85}
            >
              <Square size={32} color="#fff" />
            </TouchableOpacity>
            <Text style={[styles.recordHint, { color: colors.mutedForeground }]}>{t("session.shadow.stopHint")}</Text>
          </View>
        )}

        {(phase === "transcribing" || phase === "scoring") && (
          <View style={[styles.section, styles.centerSection]}>
            <ActivityIndicator size="large" color={stageColor} />
            <Text style={[styles.statusText, { color: colors.mutedForeground }]}>
              {phase === "transcribing" ? t("session.processing.transcribing") : t("session.processing.scoring")}
            </Text>
          </View>
        )}

        {phase === "result" && result && (
          <View style={styles.section}>
            {stage.needsScore ? (
              <>
                <View style={[
                  styles.passedBanner,
                  {
                    backgroundColor: result.passed ? "#10B981" + "15" : "#EF4444" + "15",
                    borderColor: result.passed ? "#10B981" : "#EF4444",
                  },
                ]}>
                  <Icon
                    name={result.passed ? "check-circle" : "x-circle"}
                    size={22}
                    color={result.passed ? "#10B981" : "#EF4444"}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.passedTitle, { color: result.passed ? "#10B981" : "#EF4444" }]}>
                      {result.passed ? t("session.result.passed") : t("session.result.failed")}
                    </Text>
                    <Text style={[styles.passedSub, { color: colors.mutedForeground }]}>
                      {result.passed
                        ? isLastStage ? t("session.result.allDone") : t("session.result.continueNext")
                        : t("session.result.needScore", { n: STAGE_PASS_SCORE })}
                    </Text>
                  </View>
                  <Text style={[styles.passedScore, { color: result.passed ? "#10B981" : "#EF4444" }]}>
                    {result.score}
                  </Text>
                </View>
                <ScoreCard
                  score={result.score}
                  feedback={result.feedback}
                  details={result.details}
                  mode={stage.mode as LearningMode}
                />
              </>
            ) : (
              <View style={[styles.passedBanner, { backgroundColor: "#10B981" + "15", borderColor: "#10B981" }]}>
                <Headphones size={22} color="#10B981" />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.passedTitle, { color: "#10B981" }]}>{t("session.result.listeningDone")}</Text>
                  <Text style={[styles.passedSub, { color: colors.mutedForeground }]}>
                    {t("session.result.unlockNext")}
                  </Text>
                </View>
              </View>
            )}

            {stageIdx < STAGES.length - 1 && (
              <View style={[styles.nextStageHint, { backgroundColor: colors.muted }]}>
                <Icon name={STAGES[stageIdx + 1].icon as any} size={16} color={STAGES[stageIdx + 1].color} />
                <Text style={[styles.nextStageText, { color: colors.foreground }]}>
                  {t("session.result.nextStageHint", { name: getStageName(stageIdx + 1, lang) })}
                </Text>
              </View>
            )}

            <View style={[styles.originalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.originalLabel, { color: colors.mutedForeground }]}>{t("session.result.original")}</Text>
              <Text style={[styles.originalText, { color: colors.foreground }]}>{text.text}</Text>
            </View>

            <View style={styles.resultActions}>
              <TouchableOpacity
                onPress={handleRetry}
                style={[styles.retryBtn, { borderColor: colors.border }]}
                activeOpacity={0.85}
              >
                <RefreshCw size={16} color={colors.mutedForeground} />
                <Text style={[styles.retryBtnText, { color: colors.mutedForeground }]}>{t("session.result.retry")}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleNextStage}
                style={[styles.doneBtn, { backgroundColor: stageColor }]}
                activeOpacity={0.85}
              >
                <Text style={styles.doneBtnText}>
                  {result.passed && !isLastStage ? t("session.result.next") : t("session.result.return")}
                </Text>
                <Icon name={result.passed && !isLastStage ? "arrow-right" : "check"} size={16} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>
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
    paddingBottom: 8,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  headerCenter: { flex: 1, alignItems: "center" },
  headerStage: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  headerTitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    marginTop: 1,
  },
  progressBar: {
    height: 3,
    marginHorizontal: 0,
  },
  progressFill: {
    height: 3,
    borderRadius: 2,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    gap: 14,
  },
  section: { gap: 14 },
  centerSection: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 300,
    gap: 16,
  },
  statusText: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
  },
  introCard: {
    borderRadius: 20,
    padding: 28,
    alignItems: "center",
    gap: 10,
  },
  introBadge: {
    width: 80,
    height: 80,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  introLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  introTitle: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
  },
  introDesc: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
    textAlign: "center",
  },
  thresholdTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  thresholdText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  startBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 6,
  },
  startBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  textPreview: {
    borderRadius: 14,
    padding: 14,
    gap: 6,
  },
  textPreviewLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  textPreviewContent: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
  },
  completeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 16,
    borderRadius: 16,
  },
  completeBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  countdownCard: {
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    gap: 4,
  },
  countdownNum: {
    fontSize: 56,
    fontFamily: "Inter_700Bold",
  },
  countdownLabel: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  memorizeHint: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
  hiddenCard: {
    borderRadius: 16,
    padding: 28,
    alignItems: "center",
    gap: 8,
  },
  hiddenTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
  },
  hiddenSubtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
  recordSection: {
    alignItems: "center",
    gap: 16,
    paddingVertical: 20,
  },
  recordBtn: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  recordHint: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  dictationBox: {
    borderRadius: 14,
    borderWidth: 2,
    padding: 14,
    gap: 8,
  },
  dictationLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  dictationInput: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    lineHeight: 26,
    minHeight: 120,
  },
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    borderRadius: 14,
  },
  submitBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  passedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  passedTitle: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
  },
  passedSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  passedScore: {
    fontSize: 32,
    fontFamily: "Inter_700Bold",
  },
  nextStageHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    borderRadius: 10,
  },
  nextStageText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  originalCard: {
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    gap: 6,
  },
  originalLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  originalText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    lineHeight: 24,
  },
  resultActions: {
    flexDirection: "row",
    gap: 10,
  },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 14,
    borderWidth: 1,
    flex: 1,
  },
  retryBtnText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  doneBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 14,
    flex: 2,
  },
  doneBtnText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
});
