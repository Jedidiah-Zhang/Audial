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
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { useAudioPlayer, useAudioRecorder, transcribeAudio } from "@/hooks/useAudio";
import { AudioWaveform } from "@/components/AudioWaveform";
import { ScoreCard } from "@/components/ScoreCard";
import { STAGES, STAGE_PASS_SCORE } from "@/types";
import type { LearningMode } from "@/types";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

type SessionPhase =
  | "intro"
  | "listening"
  | "study"
  | "memorize"
  | "recording"
  | "transcribing"
  | "scoring"
  | "result";

export default function SessionScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { id, stage: stageParam } = useLocalSearchParams<{ id: string; stage: string }>();
  const { texts, addResult, completeListeningStage, settings } = useApp();
  const { playTTS, stop, isPlaying, isLoading: ttsLoading } = useAudioPlayer();
  const { startRecording, stopRecording, isRecording } = useAudioRecorder();

  const stageIdx = parseInt(stageParam ?? "0", 10);
  const stage = STAGES[stageIdx] ?? STAGES[0];
  const text = texts.find((t) => t.id === id);

  const [phase, setPhase] = useState<SessionPhase>("intro");
  const [dictationInput, setDictationInput] = useState("");
  const [result, setResult] = useState<{ score: number; feedback: string; details: Record<string, string | number>; passed: boolean } | null>(null);
  const [memorizeCountdown, setMemorizeCountdown] = useState(30);
  const [hasListened, setHasListened] = useState(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 50 : insets.bottom + 20;

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      stop();
    };
  }, []);

  const handlePlayAudio = useCallback(async () => {
    if (!text) return;
    setHasListened(true);
    await playTTS(text.text, settings.preferredVoice);
  }, [text, playTTS, settings.preferredVoice]);

  const handleBeginPractice = () => {
    if (stageIdx === 0) {
      setPhase("listening");
      setTimeout(() => handlePlayAudio(), 300);
    } else if (stageIdx === 3) {
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
      if (settings.autoPlayAudio) setTimeout(() => handlePlayAudio(), 400);
    }
  };

  const handleCompleteListening = async () => {
    if (!text) return;
    await completeListeningStage(text.id);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setResult({ score: 100, feedback: "很好！完成精听练习，进入下一关继续学习。", details: {}, passed: true });
    setPhase("result");
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
        Alert.alert("错误", "录音转文字失败，请重试");
        setPhase("study");
      }
    } else {
      const started = await startRecording();
      if (!started) {
        Alert.alert("需要麦克风权限", "请在设置中允许麦克风访问");
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
      const mode = stage.mode as LearningMode | "listening";
      const endpoint =
        stageIdx === 1
          ? "/api/language/score-pronunciation"
          : stageIdx === 2
          ? "/api/language/score-dictation"
          : "/api/language/score-recitation";

      const body =
        stageIdx === 2
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

      if (stageIdx === 1 && d.mistakes?.length) {
        details["发音错误词"] = d.mistakes.join(", ");
      }
      if (stageIdx === 2 && d.wordAccuracy) {
        details["词汇准确率"] = `${d.wordAccuracy}%`;
      }
      if (stageIdx === 3) {
        details["覆盖率"] = `${d.completeness ?? 0}%`;
        details["流利度"] = { excellent: "优秀", good: "良好", fair: "一般", needs_work: "需加强" }[d.fluency as string] ?? d.fluency;
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
      Alert.alert("评分失败", "无法连接服务器，请检查网络");
      setPhase("study");
    }
  };

  const handleDictationSubmit = async () => {
    if (!dictationInput.trim()) {
      Alert.alert("提示", "请先输入您听到的内容");
      return;
    }
    await scoreAnswer(dictationInput.trim());
  };

  const handleRetry = () => {
    setResult(null);
    setDictationInput("");
    setHasListened(false);
    setPhase("intro");
  };

  const handleNextStage = () => {
    router.back();
  };

  if (!text) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.foreground, padding: 20 }}>文章未找到</Text>
      </View>
    );
  }

  const stageColor = stage.color;
  const isLastStage = stageIdx === STAGES.length - 1;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} activeOpacity={0.7}>
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerStage, { color: stageColor }]}>
            第 {stageIdx + 1} 关 · {stage.name}
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
                <Feather name={stage.icon as any} size={36} color={stageColor} />
              </View>
              <Text style={[styles.introLabel, { color: stageColor }]}>
                第 {stageIdx + 1} 关
              </Text>
              <Text style={[styles.introTitle, { color: colors.foreground }]}>{stage.name}</Text>
              <Text style={[styles.introDesc, { color: colors.mutedForeground }]}>
                {stage.description}
              </Text>
              {stage.needsScore && (
                <View style={[styles.thresholdTag, { backgroundColor: colors.muted }]}>
                  <Feather name="target" size={12} color={colors.mutedForeground} />
                  <Text style={[styles.thresholdText, { color: colors.mutedForeground }]}>
                    {STAGE_PASS_SCORE} 分以上即可通关
                  </Text>
                </View>
              )}
              <TouchableOpacity
                onPress={handleBeginPractice}
                style={[styles.startBtn, { backgroundColor: stageColor }]}
                activeOpacity={0.85}
              >
                <Text style={styles.startBtnText}>开始练习</Text>
                <Feather name="arrow-right" size={18} color="#fff" />
              </TouchableOpacity>
            </View>

            <View style={[styles.textPreview, { backgroundColor: colors.muted }]}>
              <Text style={[styles.textPreviewLabel, { color: colors.mutedForeground }]}>练习文章</Text>
              <Text style={[styles.textPreviewContent, { color: colors.foreground }]} numberOfLines={5}>
                {text.text}
              </Text>
            </View>
          </View>
        )}

        {phase === "listening" && stageIdx === 0 && (
          <View style={styles.section}>
            <View style={[styles.textCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.textContent, { color: colors.foreground }]}>{text.text}</Text>
            </View>

            <View style={styles.audioSection}>
              <TouchableOpacity
                onPress={handlePlayAudio}
                disabled={isPlaying || ttsLoading}
                style={[styles.bigAudioBtn, {
                  backgroundColor: stageColor,
                  opacity: isPlaying || ttsLoading ? 0.65 : 1,
                }]}
                activeOpacity={0.85}
              >
                {ttsLoading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Feather name={isPlaying ? "volume-2" : "play-circle"} size={26} color="#fff" />
                )}
                <Text style={styles.bigAudioBtnText}>
                  {ttsLoading ? "加载中..." : isPlaying ? "播放中..." : hasListened ? "再次播放" : "播放音频"}
                </Text>
              </TouchableOpacity>
              {isPlaying && <AudioWaveform isActive color={stageColor} barCount={9} />}
            </View>

            <TouchableOpacity
              onPress={handleCompleteListening}
              disabled={!hasListened}
              style={[styles.completeBtn, {
                backgroundColor: hasListened ? stageColor : colors.muted,
                opacity: hasListened ? 1 : 0.5,
              }]}
              activeOpacity={0.85}
            >
              <Feather name="check-circle" size={20} color={hasListened ? "#fff" : colors.mutedForeground} />
              <Text style={[styles.completeBtnText, { color: hasListened ? "#fff" : colors.mutedForeground }]}>
                {hasListened ? "完成本关，进入下一关" : "请先播放音频"}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {phase === "memorize" && stageIdx === 3 && (
          <View style={styles.section}>
            <View style={[styles.countdownCard, { backgroundColor: stageColor + "15", borderColor: stageColor + "40", borderWidth: 2 }]}>
              <Text style={[styles.countdownNum, { color: stageColor }]}>{memorizeCountdown}</Text>
              <Text style={[styles.countdownLabel, { color: colors.mutedForeground }]}>秒后文章将被隐藏</Text>
            </View>
            <View style={[styles.textCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.textContent, { color: colors.foreground }]}>{text.text}</Text>
            </View>
            <Text style={[styles.memorizeHint, { color: colors.mutedForeground }]}>
              请认真记忆文章内容，倒计时结束后需要从记忆中背诵
            </Text>
          </View>
        )}

        {phase === "study" && stageIdx !== 0 && (
          <View style={styles.section}>
            {stageIdx === 2 ? (
              <View style={[styles.hiddenCard, { backgroundColor: colors.muted }]}>
                <Feather name="eye-off" size={28} color={colors.mutedForeground} />
                <Text style={[styles.hiddenTitle, { color: colors.foreground }]}>文章已隐藏</Text>
                <Text style={[styles.hiddenSubtitle, { color: colors.mutedForeground }]}>
                  反复收听音频，将您听到的内容写在下方
                </Text>
              </View>
            ) : stageIdx === 3 ? (
              <View style={[styles.hiddenCard, { backgroundColor: colors.muted }]}>
                <Feather name="book-open" size={28} color={colors.mutedForeground} />
                <Text style={[styles.hiddenTitle, { color: colors.foreground }]}>从记忆中背诵</Text>
                <Text style={[styles.hiddenSubtitle, { color: colors.mutedForeground }]}>
                  不看文章，录制您的背诵音频
                </Text>
              </View>
            ) : (
              <View style={[styles.textCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.textContent, { color: colors.foreground }]}>{text.text}</Text>
              </View>
            )}

            {stageIdx !== 3 && (
              <TouchableOpacity
                onPress={handlePlayAudio}
                disabled={isPlaying || ttsLoading}
                style={[styles.bigAudioBtn, {
                  backgroundColor: isPlaying || ttsLoading ? colors.muted : stageColor + "20",
                  opacity: isPlaying || ttsLoading ? 0.65 : 1,
                }]}
                activeOpacity={0.85}
              >
                {ttsLoading ? (
                  <ActivityIndicator color={stageColor} size="small" />
                ) : (
                  <Feather name="volume-2" size={22} color={stageColor} />
                )}
                <Text style={[styles.bigAudioBtnText, { color: stageColor }]}>
                  {ttsLoading ? "加载中..." : isPlaying ? "播放中..." : "播放音频"}
                </Text>
              </TouchableOpacity>
            )}

            {isPlaying && <AudioWaveform isActive color={stageColor} barCount={9} />}

            {stageIdx === 2 ? (
              <>
                <View style={[styles.dictationBox, { backgroundColor: colors.card, borderColor: stageColor }]}>
                  <Text style={[styles.dictationLabel, { color: colors.mutedForeground }]}>听写内容</Text>
                  <TextInput
                    style={[styles.dictationInput, { color: colors.foreground }]}
                    value={dictationInput}
                    onChangeText={setDictationInput}
                    placeholder="将您听到的内容写在这里..."
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
                  <Feather name="check" size={20} color="#fff" />
                  <Text style={styles.submitBtnText}>提交答案</Text>
                </TouchableOpacity>
              </>
            ) : (
              <View style={styles.recordSection}>
                <TouchableOpacity
                  onPress={handleRecord}
                  style={[styles.recordBtn, {
                    backgroundColor: isRecording ? "#EF4444" : stageColor,
                    shadowColor: isRecording ? "#EF4444" : stageColor,
                  }]}
                  activeOpacity={0.85}
                >
                  <Feather name={isRecording ? "square" : "mic"} size={32} color="#fff" />
                </TouchableOpacity>
                <Text style={[styles.recordHint, { color: colors.mutedForeground }]}>
                  {isRecording ? "点击停止录音" : "点击开始录音"}
                </Text>
                {isRecording && <AudioWaveform isActive color="#EF4444" />}
              </View>
            )}
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
              <Feather name="square" size={32} color="#fff" />
            </TouchableOpacity>
            <Text style={[styles.recordHint, { color: colors.mutedForeground }]}>点击停止录音</Text>
          </View>
        )}

        {(phase === "transcribing" || phase === "scoring") && (
          <View style={[styles.section, styles.centerSection]}>
            <ActivityIndicator size="large" color={stageColor} />
            <Text style={[styles.statusText, { color: colors.mutedForeground }]}>
              {phase === "transcribing" ? "正在识别语音..." : "AI 评分中..."}
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
                  <Feather
                    name={result.passed ? "check-circle" : "x-circle"}
                    size={22}
                    color={result.passed ? "#10B981" : "#EF4444"}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.passedTitle, { color: result.passed ? "#10B981" : "#EF4444" }]}>
                      {result.passed ? "通关成功！" : "未达通关分数"}
                    </Text>
                    <Text style={[styles.passedSub, { color: colors.mutedForeground }]}>
                      {result.passed
                        ? isLastStage ? "恭喜完成全部关卡！" : "继续挑战下一关"
                        : `需要 ${STAGE_PASS_SCORE} 分，再试一次吧`}
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
                <Feather name="headphones" size={22} color="#10B981" />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.passedTitle, { color: "#10B981" }]}>精听完成！</Text>
                  <Text style={[styles.passedSub, { color: colors.mutedForeground }]}>
                    第1关已解锁，继续进入跟读练习
                  </Text>
                </View>
              </View>
            )}

            {stageIdx < STAGES.length - 1 && (
              <View style={[styles.nextStageHint, { backgroundColor: colors.muted }]}>
                <Feather name={STAGES[stageIdx + 1].icon as any} size={16} color={STAGES[stageIdx + 1].color} />
                <Text style={[styles.nextStageText, { color: colors.foreground }]}>
                  下一关：{STAGES[stageIdx + 1].name}
                </Text>
              </View>
            )}

            <View style={[styles.originalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.originalLabel, { color: colors.mutedForeground }]}>原文</Text>
              <Text style={[styles.originalText, { color: colors.foreground }]}>{text.text}</Text>
            </View>

            <View style={styles.resultActions}>
              <TouchableOpacity
                onPress={handleRetry}
                style={[styles.retryBtn, { borderColor: colors.border }]}
                activeOpacity={0.85}
              >
                <Feather name="refresh-cw" size={16} color={colors.mutedForeground} />
                <Text style={[styles.retryBtnText, { color: colors.mutedForeground }]}>再练一次</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleNextStage}
                style={[styles.doneBtn, { backgroundColor: stageColor }]}
                activeOpacity={0.85}
              >
                <Text style={styles.doneBtnText}>
                  {result.passed && !isLastStage ? "进入下一关" : "返回"}
                </Text>
                <Feather name={result.passed && !isLastStage ? "arrow-right" : "check"} size={16} color="#fff" />
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
  textCard: {
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
  },
  textContent: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    lineHeight: 28,
  },
  audioSection: {
    gap: 10,
    alignItems: "center",
  },
  bigAudioBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 16,
    width: "100%",
  },
  bigAudioBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
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
